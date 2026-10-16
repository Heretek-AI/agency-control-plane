/**
 * Human approval gate: pinned Ed25519 key, server-computed subject hash,
 * single-use tickets. Every attack below must leave the task in
 * `waitingHuman`.
 */
import { describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { generateKeyPairSync } from "node:crypto";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readAuditRecords } from "../src/audit.js";
import {
  sealHumanKey,
  signApprovalPayload,
  unsealHumanKey,
  verifyPinnedApproval,
  type ApprovalPayload,
  type SignedApprovalRecord,
} from "../src/human-key.js";
import { createServer, subjectHashForHunks, type DiffHunk, type FleetServer } from "../src/server.js";

const PASSPHRASE = "correct horse battery staple";

const HUNKS: DiffHunk[] = [
  {
    file: "src/a.ts",
    status: "modified",
    additions: 1,
    deletions: 1,
    patch: "diff --git a/src/a.ts b/src/a.ts\n--- a/src/a.ts\n+++ b/src/a.ts\n@@ -1 +1 @@\n-old\n+new\n",
  },
];

interface Ticket {
  ticket: string;
  subjectHash: string;
  timestamp: string;
  keyFingerprint: string;
  payloads: { approve: ApprovalPayload; reject: ApprovalPayload };
  diff: { files: number; additions: number; deletions: number };
}

function post(app: FleetServer, path: string, body: unknown): Promise<Response> {
  return app.fetch(
    new Request(`http://127.0.0.1${path}`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-csrf-token": app.csrfToken },
      body: JSON.stringify(body),
    }),
  );
}

function setup(): { app: FleetServer; stateDir: string; humanKey: Buffer } {
  const stateDir = mkdtempSync(join(tmpdir(), "approvals-"));
  sealHumanKey(stateDir, PASSPHRASE);
  const humanKey = unsealHumanKey(stateDir, PASSPHRASE);
  const app = createServer({ stateDir });
  app.upsertTask({ id: "task-h", status: "waitingHuman", title: "Needs human" });
  app.recordDiff("task-h", HUNKS);
  return { app, stateDir, humanKey };
}

async function mint(app: FleetServer, taskId = "task-h", body: unknown = {}): Promise<Ticket> {
  const res = await post(app, `/api/approvals/${taskId}/ticket`, body);
  expect(res.status).toBe(200);
  return (await res.json()) as Ticket;
}

function attackerKey(): Buffer {
  const { privateKey } = generateKeyPairSync("ed25519", { privateKeyEncoding: { type: "pkcs8", format: "der" }, publicKeyEncoding: { type: "spki", format: "der" } });
  return Buffer.from(privateKey);
}

function attackerPublicHex(): string {
  const { publicKey } = generateKeyPairSync("ed25519", { publicKeyEncoding: { type: "spki", format: "der" }, privateKeyEncoding: { type: "pkcs8", format: "der" } });
  return Buffer.from(publicKey).toString("hex");
}

describe("fail closed without a pinned human key", () => {
  test("no stateDir / key path: ticket and sign routes answer 503", async () => {
    const app = createServer({});
    app.upsertTask({ id: "task-h", status: "waitingHuman" });
    expect(app.humanKey).toBeNull();
    expect((await post(app, "/api/approvals/task-h/ticket", {})).status).toBe(503);
    expect((await post(app, "/api/approvals/task-h/sign", { ticket: "x", signatureHex: "00" })).status).toBe(503);
    expect(app.getTask("task-h")?.status).toBe("waitingHuman");
  });

  test("stateDir without human.pub: 503", async () => {
    const app = createServer({ stateDir: mkdtempSync(join(tmpdir(), "approvals-nokey-")) });
    app.upsertTask({ id: "task-h", status: "waitingHuman" });
    const res = await post(app, "/api/approvals/task-h/ticket", {});
    expect(res.status).toBe(503);
    expect(((await res.json()) as { error: string }).error).toContain("human public key not found");
    await app.shutdown();
  });

  test("a human.pub whose fingerprint does not match its key is refused", async () => {
    const stateDir = mkdtempSync(join(tmpdir(), "approvals-badpub-"));
    sealHumanKey(stateDir, PASSPHRASE);
    const pub = JSON.parse(readFileSync(join(stateDir, "human.pub"), "utf8")) as { publicKeyHex: string; fingerprint: string };
    writeFileSync(join(stateDir, "human.pub"), JSON.stringify({ ...pub, fingerprint: "0".repeat(64) }));
    const app = createServer({ stateDir });
    expect(app.humanKey).toBeNull();
    expect(app.approvalsUnavailableReason).toContain("fingerprint");
    await app.shutdown();
  });
});

describe("legitimate approvals", () => {
  test("server computes subjectHash from the diff and the pinned human key approves -> done", async () => {
    const { app, stateDir, humanKey } = setup();
    const ticket = await mint(app);
    expect(ticket.subjectHash).toBe(subjectHashForHunks(HUNKS));
    expect(ticket.diff).toEqual({ files: 1, additions: 1, deletions: 1 });
    expect(ticket.payloads.approve).toEqual({ runId: "task-h", stage: "APPROVE", subjectHash: ticket.subjectHash, timestamp: ticket.timestamp });
    const signatureHex = signApprovalPayload(humanKey, ticket.payloads.approve);
    const res = await post(app, "/api/approvals/task-h/sign", { ticket: ticket.ticket, signatureHex });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { status: string; record: SignedApprovalRecord };
    expect(body.status).toBe("done");
    expect(app.getTask("task-h")?.status).toBe("done");
    expect(body.record.fingerprint).toBe(ticket.keyFingerprint);
    const audit = readAuditRecords(join(stateDir, "audit.jsonl"));
    const signed = audit.find((record) => record.event === "approval.signed");
    expect((signed?.data as { record: SignedApprovalRecord }).record.signatureHex).toBe(signatureHex);
    expect(verifyPinnedApproval(app.humanKey!, body.record, body.record.signatureHex)).toBe(true);
    await app.shutdown();
  });

  test("rejection is signed too (REJECT stage) and fails the task", async () => {
    const { app, humanKey } = setup();
    const ticket = await mint(app);
    const res = await post(app, "/api/approvals/task-h/sign", {
      ticket: ticket.ticket,
      approve: false,
      signatureHex: signApprovalPayload(humanKey, ticket.payloads.reject),
    });
    expect(res.status).toBe(200);
    expect(app.getTask("task-h")?.status).toBe("failed");
    await app.shutdown();
  });

  test("tickets are only minted for waitingHuman tasks", async () => {
    const { app } = setup();
    app.upsertTask({ id: "task-r", status: "running" });
    expect((await post(app, "/api/approvals/task-r/ticket", {})).status).toBe(409);
    await app.shutdown();
  });
});

describe("approval attacks (each must be refused and leave the task waitingHuman)", () => {
  test("self-generated keypair signing the exact server payload", async () => {
    const { app } = setup();
    const ticket = await mint(app);
    const res = await post(app, "/api/approvals/task-h/sign", {
      ticket: ticket.ticket,
      signatureHex: signApprovalPayload(attackerKey(), ticket.payloads.approve),
    });
    expect(res.status).toBe(403);
    expect(app.getTask("task-h")?.status).toBe("waitingHuman");
    await app.shutdown();
  });

  test("client-supplied publicKey / publicKeyHex / fingerprint are ignored", async () => {
    const { app } = setup();
    const ticket = await mint(app);
    const forger = generateKeyPairSync("ed25519", {
      publicKeyEncoding: { type: "spki", format: "der" },
      privateKeyEncoding: { type: "pkcs8", format: "der" },
    });
    const forgerPem = generateKeyPairSync("ed25519").publicKey.export({ type: "spki", format: "pem" });
    const res = await post(app, "/api/approvals/task-h/sign", {
      ticket: ticket.ticket,
      signatureHex: signApprovalPayload(Buffer.from(forger.privateKey), ticket.payloads.approve),
      publicKey: forgerPem,
      publicKeyHex: Buffer.from(forger.publicKey).toString("hex"),
      fingerprint: attackerPublicHex().slice(0, 64),
    });
    expect(res.status).toBe(403);
    expect(((await res.json()) as { code: string }).code).toBe("bad-signature");
    expect(app.getTask("task-h")?.status).toBe("waitingHuman");
    await app.shutdown();
  });

  test("a passphrase in the request body grants nothing", async () => {
    const { app } = setup();
    const ticket = await mint(app);
    const res = await post(app, "/api/approvals/task-h/sign", { ticket: ticket.ticket, passphrase: PASSPHRASE, signature: "ab".repeat(64) });
    expect(res.status).toBe(403);
    expect(app.getTask("task-h")?.status).toBe("waitingHuman");
    await app.shutdown();
  });

  test("client-chosen subjectHash: ignored at mint, refused at sign", async () => {
    const { app, humanKey } = setup();
    const evil = "e".repeat(64);
    const ticket = await mint(app, "task-h", { subjectHash: evil });
    expect(ticket.subjectHash).toBe(subjectHashForHunks(HUNKS));
    // The human really signed the evil subject: still refused.
    const evilPayload: ApprovalPayload = { ...ticket.payloads.approve, subjectHash: evil };
    const res = await post(app, "/api/approvals/task-h/sign", {
      ticket: ticket.ticket,
      subjectHash: evil,
      signatureHex: signApprovalPayload(humanKey, evilPayload),
    });
    expect(res.status).toBe(403);
    expect(((await res.json()) as { code: string }).code).toBe("subject-mismatch");
    // Signature over a different subject without claiming it: bad signature.
    const second = await mint(app);
    const res2 = await post(app, "/api/approvals/task-h/sign", {
      ticket: second.ticket,
      signatureHex: signApprovalPayload(humanKey, evilPayload),
    });
    expect(res2.status).toBe(403);
    expect(app.getTask("task-h")?.status).toBe("waitingHuman");
    await app.shutdown();
  });

  test("replayed ticket and replayed signature", async () => {
    const { app, humanKey } = setup();
    app.upsertTask({ id: "task-k", status: "waitingHuman" });
    app.recordDiff("task-k", HUNKS);
    // A signature for ticket 1 does not verify on ticket 2 (different timestamp).
    const first = await mint(app, "task-k");
    const firstSig = signApprovalPayload(humanKey, first.payloads.approve);
    const second = await mint(app, "task-k");
    expect(second.timestamp).not.toBe(first.timestamp);
    const replayedSig = await post(app, "/api/approvals/task-k/sign", { ticket: second.ticket, signatureHex: firstSig });
    expect(replayedSig.status).toBe(403);
    expect(app.getTask("task-k")?.status).toBe("waitingHuman");
    // The genuine pair works once ...
    const ok = await post(app, "/api/approvals/task-k/sign", { ticket: first.ticket, signatureHex: firstSig });
    expect(ok.status).toBe(200);
    // ... and the same ticket is burned afterwards.
    const replay = await post(app, "/api/approvals/task-k/sign", { ticket: first.ticket, signatureHex: firstSig });
    expect(replay.status).toBe(403);
    expect(((await replay.json()) as { code: string }).code).toBe("reused-ticket");
    // Same subject on another task: the ticket/signature of task-k never approves task-h.
    const cross = await post(app, "/api/approvals/task-h/sign", { ticket: second.ticket, signatureHex: firstSig });
    expect(cross.status).toBe(403);
    expect(app.getTask("task-h")?.status).toBe("waitingHuman");
    await app.shutdown();
  });

  test("an APPROVE signature cannot be submitted as a rejection (decision is signed)", async () => {
    const { app, humanKey } = setup();
    const ticket = await mint(app);
    const res = await post(app, "/api/approvals/task-h/sign", {
      ticket: ticket.ticket,
      approve: false,
      signatureHex: signApprovalPayload(humanKey, ticket.payloads.approve),
    });
    expect(res.status).toBe(403);
    expect(app.getTask("task-h")?.status).toBe("waitingHuman");
    await app.shutdown();
  });

  test("the diff changing after the ticket was minted voids the ticket", async () => {
    const git = (cwd: string, args: string[]): string =>
      execFileSync("git", ["-c", "user.email=t@t", "-c", "user.name=t", ...args], { cwd, encoding: "utf8" }).trim();
    const repo = mkdtempSync(join(tmpdir(), "approvals-repo-"));
    git(repo, ["init", "-q", "-b", "main"]);
    writeFileSync(join(repo, "a.txt"), "one\n");
    git(repo, ["add", "."]);
    git(repo, ["commit", "-qm", "init"]);
    const base = git(repo, ["rev-parse", "HEAD"]);
    git(repo, ["checkout", "-qb", "fleet/task-g"]);
    writeFileSync(join(repo, "a.txt"), "two\n");
    git(repo, ["commit", "-qam", "work"]);
    git(repo, ["checkout", "-q", "main"]);
    const stateDir = mkdtempSync(join(tmpdir(), "approvals-git-"));
    sealHumanKey(stateDir, PASSPHRASE);
    const humanKey = unsealHumanKey(stateDir, PASSPHRASE);
    const app = createServer({ stateDir, repoDir: repo, workers: false, director: false });
    app.upsertTask({ id: "task-g", status: "waitingHuman", base });
    const ticket = await mint(app, "task-g");
    expect(ticket.subjectHash).toBe(app.subjectFor("task-g").subjectHash);
    expect(ticket.diff.files).toBe(1);
    // The worker branch moves after the human looked at it.
    git(repo, ["checkout", "-q", "fleet/task-g"]);
    writeFileSync(join(repo, "a.txt"), "three (sneaky)\n");
    git(repo, ["commit", "-qam", "sneaky"]);
    git(repo, ["checkout", "-q", "main"]);
    const res = await post(app, "/api/approvals/task-g/sign", {
      ticket: ticket.ticket,
      signatureHex: signApprovalPayload(humanKey, ticket.payloads.approve),
    });
    expect(res.status).toBe(403);
    expect(((await res.json()) as { code: string }).code).toBe("binding-mismatch");
    expect(app.getTask("task-g")?.status).toBe("waitingHuman");
    await app.shutdown();
  });
});
