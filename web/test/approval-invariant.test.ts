/**
 * Invariant I1 tests: the human approval secret lives ONLY in a lexical
 * closure inside `approval-client.ts` during the sign fetch, is zeroed
 * afterwards, and NEVER leaks into `fleet-store`, `localStorage`,
 * `sessionStorage`, or DOM attributes.
 *
 * Proven two ways: statically (source grep over `web/src`) and at
 * runtime (mocked `fetch` + `assertNoPassphraseLeak` over every
 * observable sink). No network, no DOM required.
 */
import { generateKeyPairSync } from "node:crypto";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "bun:test";
import { sealHumanKey, unsealHumanKey } from "../../dispatcher/src/human-key.js";
import { createServer, type FleetServer } from "../../dispatcher/src/server.js";
import {
  activeApprovalSecrets,
  approveWithKeyFile,
  assertNoPassphraseLeak,
  canonicalApprovalPayload,
  keyFileNeedsPassphrase,
  subjectHashForHunks,
  type ApprovalTicketView,
  type FetchLike,
} from "../src/security/approval-client.js";
import { createFleetStore } from "../src/state/fleet-store.js";

const WEB_SRC = join(import.meta.dir, "..", "src");

function readSource(relative: string): string {
  return readFileSync(join(WEB_SRC, relative), "utf8");
}

/**
 * Strip block and line comments so the static probe asserts on code,
 * not on the Invariant I1 documentation prose that names the forbidden
 * sinks. String literals are kept: real browser-storage use requires
 * property access (`localStorage.` / `localStorage[`), which never
 * appears in a doc comment.
 */
function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^\S\n])\/\/.*$/gm, "$1");
}

/** True when code touches browser storage (property access, not prose). */
function touchesStorage(code: string): boolean {
  return /(localStorage|sessionStorage)\s*[.[]/.test(code);
}

describe("invariant I1 (static source discipline)", () => {
  test("fleet-store never names a human secret", () => {
    const code = stripComments(readSource(join("state", "fleet-store.ts")));
    for (const needle of ["passphrase", "secret", "privateKey"]) {
      expect(code.toLowerCase().includes(needle.toLowerCase()), `fleet-store mentions ${needle}`).toBe(false);
    }
    expect(touchesStorage(code)).toBe(false);
  });

  test("no component touches browser storage or renders the secret into DOM attributes", () => {
    const files = ["KanbanBoard.tsx", "DirectorChat.tsx", "WorkerDrillDown.tsx", "SplitDiffViewer.tsx", "ApprovalDrawer.tsx", "theme.ts"];
    for (const file of files) {
      const code = stripComments(readSource(join("components", file)));
      expect(touchesStorage(code), `${file} touches browser storage`).toBe(false);
      expect(code.includes("data-passphrase"), `${file} renders data-passphrase`).toBe(false);
      expect(code.includes("data-secret"), `${file} renders data-secret`).toBe(false);
    }
  });

  test("app shell never names a human secret or browser storage", () => {
    const code = stripComments(readSource("app.tsx"));
    expect(code.toLowerCase().includes("passphrase"), "app.tsx mentions passphrase").toBe(false);
    expect(touchesStorage(code)).toBe(false);
    expect(code.includes("data-passphrase")).toBe(false);
    expect(code.includes("data-secret")).toBe(false);
  });

  test("approval-client zeroes the closure secret and touches no storage", () => {
    const code = stripComments(readSource(join("security", "approval-client.ts")));
    expect(touchesStorage(code)).toBe(false);
    expect(code.includes("fill(0)")).toBe(true);
    expect(code.includes("finally")).toBe(true);
    expect(code.includes("secret = null")).toBe(true);
    expect(code.includes('secret = ""')).toBe(true);
    expect(code.includes("liveSecrets")).toBe(true);
  });

  test("browser code never imports Node built-ins or uses Buffer", () => {
    const files = ["app.tsx", "main.tsx", join("security", "approval-client.ts"), join("state", "fleet-store.ts")];
    for (const file of files) {
      const code = stripComments(readSource(file));
      expect(/from\s+["']node:/.test(code), `${file} imports node:*`).toBe(false);
      expect(/\bBuffer\b/.test(code), `${file} uses Buffer`).toBe(false);
    }
  });
});

const PASSPHRASE = "correct horse battery staple 101";

const HUNKS = [
  { file: "a.ts", status: "modified" as const, additions: 1, deletions: 1, patch: "diff --git a/a.ts b/a.ts\n-x\n+y\n" },
];

/** A dispatcher with a pinned human key and one task waiting for approval. */
function dispatcher(): { app: FleetServer; sealed: Uint8Array; stateDir: string } {
  const stateDir = mkdtempSync(join(tmpdir(), "web-approval-"));
  sealHumanKey(stateDir, PASSPHRASE);
  const app = createServer({ stateDir });
  app.upsertTask({ id: "task-101", status: "waitingHuman", title: "Human gate" });
  app.recordDiff("task-101", HUNKS);
  return { app, sealed: new Uint8Array(readFileSync(join(stateDir, "human.key.enc"))), stateDir };
}

/** Route the client's relative fetches into the in-process dispatcher, recording bodies. */
function routed(app: FleetServer, bodies: string[]): FetchLike {
  return async (url, init) => {
    bodies.push(init?.body ?? "");
    return app.fetch(
      new Request(`http://127.0.0.1${url}`, {
        method: init?.method ?? "GET",
        headers: { ...(init?.headers ?? {}), "x-csrf-token": app.csrfToken },
        ...(init?.body !== undefined ? { body: init.body } : {}),
      }),
    );
  };
}

async function mint(app: FleetServer): Promise<ApprovalTicketView> {
  const res = await app.fetch(
    new Request("http://127.0.0.1/api/approvals/task-101/ticket", { method: "POST", headers: { "x-csrf-token": app.csrfToken }, body: "{}" }),
  );
  expect(res.status).toBe(200);
  return (await res.json()) as ApprovalTicketView;
}

describe("invariant I1 + browser signing (runtime, against a real dispatcher)", () => {
  test("sealed human.key.enc + passphrase: WebCrypto signature verifies on the pinned key; only the signature is sent", async () => {
    const { app, sealed } = dispatcher();
    const ticket = await mint(app);
    expect(await subjectHashForHunks(HUNKS)).toBe(ticket.subjectHash);
    expect(keyFileNeedsPassphrase(sealed)).toBe(true);
    const keyBytes = new Uint8Array(sealed);
    const bodies: string[] = [];
    const result = await approveWithKeyFile("task-101", ticket, keyBytes, PASSPHRASE, {
      fetchImpl: routed(app, bodies),
      expectedSubjectHash: await subjectHashForHunks(HUNKS),
    });
    expect(result.status).toBe("done");
    expect(app.getTask("task-101")?.status).toBe("done");
    const wire = bodies.join("\n");
    expect(wire.includes(PASSPHRASE)).toBe(false);
    const body = JSON.parse(bodies[0] ?? "{}") as Record<string, unknown>;
    expect(Object.keys(body).sort()).toEqual(["approve", "signatureHex", "subjectHash", "ticket"]);
    // The key-file buffer handed to the client is zeroed afterwards.
    expect(keyBytes.every((byte) => byte === 0)).toBe(true);
    expect(activeApprovalSecrets()).toBe(0);
    await app.shutdown();
  });

  test("unencrypted PKCS#8 PEM of the human key also signs", async () => {
    const { app, stateDir } = dispatcher();
    const der = unsealHumanKey(stateDir, PASSPHRASE);
    const pem = `-----BEGIN PRIVATE KEY-----\n${der.toString("base64")}\n-----END PRIVATE KEY-----\n`;
    const ticket = await mint(app);
    const result = await approveWithKeyFile("task-101", ticket, new TextEncoder().encode(pem), "", {
      fetchImpl: routed(app, []),
      approve: false,
    });
    expect(result.status).toBe("failed");
    await app.shutdown();
  });

  test("wrong passphrase, foreign key, and mismatched displayed diff fail locally without a request", async () => {
    const { app, sealed } = dispatcher();
    const ticket = await mint(app);
    const bodies: string[] = [];
    const fetchImpl = routed(app, bodies);
    await expect(approveWithKeyFile("task-101", ticket, new Uint8Array(sealed), "wrong passphrase", { fetchImpl })).rejects.toThrow(/wrong passphrase/);
    const foreign = generateKeyPairSync("ed25519").privateKey.export({ type: "pkcs8", format: "pem" }) as string;
    await expect(approveWithKeyFile("task-101", ticket, new TextEncoder().encode(foreign), "", { fetchImpl })).rejects.toThrow(/not the dispatcher's pinned human key/);
    await expect(
      approveWithKeyFile("task-101", ticket, new Uint8Array(sealed), PASSPHRASE, { fetchImpl, expectedSubjectHash: "0".repeat(64) }),
    ).rejects.toThrow(/does not hash/);
    await expect(approveWithKeyFile("task-101", ticket, new Uint8Array(sealed), "", { fetchImpl })).rejects.toThrow(/needs its passphrase/);
    expect(bodies).toEqual([]);
    expect(activeApprovalSecrets()).toBe(0);
    expect(app.getTask("task-101")?.status).toBe("waitingHuman");
    await app.shutdown();
  });

  test("canonical payload matches the dispatcher byte for byte", async () => {
    const { canonicalApprovalPayload: serverCanonical } = await import("../../dispatcher/src/human-key.js");
    const payload = { runId: "task-1", stage: "APPROVE", subjectHash: "a\"b", timestamp: "2026-10-16T00:00:00.000Z" };
    expect(canonicalApprovalPayload(payload)).toBe(serverCanonical(payload));
  });

  test("assertNoPassphraseLeak passes on a clean post-approval snapshot", async () => {
    const { app, sealed } = dispatcher();
    const ticket = await mint(app);
    await approveWithKeyFile("task-101", ticket, new Uint8Array(sealed), PASSPHRASE, { fetchImpl: routed(app, []) });
    const store = createFleetStore();
    store.upsertTask({
      id: "task-101",
      title: "Human gate",
      branch: "fleet/task-101",
      ownedPaths: ["dispatcher/src"],
      tier: "tier-1-opencode",
      column: "Done",
    });
    const probe = assertNoPassphraseLeak(PASSPHRASE, {
      storeSnapshot: store.getState(),
      domHtml: `<section data-testid="approval-drawer"><input type="password" id="approval-secret" /></section>`,
      localStorageDump: {},
      sessionStorageDump: {},
    });
    expect(probe.ok).toBe(true);
    expect(probe.findings).toEqual([]);
    await app.shutdown();
  });

  test("assertNoPassphraseLeak is sensitive: a planted leak in any sink fails the probe", () => {
    const secret = "planted-leak-505";
    expect(assertNoPassphraseLeak(secret, { storeSnapshot: { tasks: [{ id: secret }] } }).ok).toBe(false);
    expect(assertNoPassphraseLeak(secret, { domHtml: `<div data-x="${secret}"></div>` }).ok).toBe(false);
    expect(assertNoPassphraseLeak(secret, { localStorageDump: { approval: secret } }).ok).toBe(false);
    expect(assertNoPassphraseLeak(secret, { sessionStorageDump: { approval: secret } }).ok).toBe(false);
    const findings = assertNoPassphraseLeak(secret, { localStorageDump: { approval: secret } }).findings;
    expect(findings.some((finding) => finding.includes("localStorage"))).toBe(true);
  });
});
