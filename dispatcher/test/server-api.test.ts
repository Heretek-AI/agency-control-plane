import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  generateApprovalKeyPair,
  hashSubject,
  passphraseToKeypair,
  signSubjectHash,
  TicketStore,
  verifyApprovalSignature,
} from "../src/approval-tickets.js";
import { checkAnchor } from "../src/audit.js";
import { createServer, type BoardView, type FleetServer } from "../src/server.js";

function scratchAudit(): string {
  return join(mkdtempSync(join(tmpdir(), "srv-test-")), "audit.jsonl");
}

function authed(path: string, body: unknown, csrf: string): Request {
  return new Request(`http://127.0.0.1${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-csrf-token": csrf },
    body: JSON.stringify(body),
  });
}

function seedBoard(app: FleetServer): void {
  app.upsertTask({ id: "task-a", status: "pending", title: "Alpha", paths: ["src/a.ts"] });
  app.upsertTask({ id: "task-b", status: "ready", title: "Beta", deps: ["task-a"] });
  app.upsertTask({ id: "task-c", status: "running", title: "Gamma" });
  app.upsertTask({
    id: "task-d",
    status: "waitingHuman",
    title: "Delta",
    branch: "fleet/task-d",
    worktree: "/tmp/trees/task-d",
  });
  app.upsertTask({ id: "task-e", status: "done", title: "Epsilon", deps: ["task-b"] });
}

describe("GET /api/board", () => {
  test("returns columns, tasks, worktrees, tier, and DAG edges", async () => {
    const app = createServer({ auditLogPath: scratchAudit() });
    seedBoard(app);
    const res = await app.fetch(new Request("http://127.0.0.1/api/board"));
    expect(res.status).toBe(200);
    const board = (await res.json()) as BoardView;
    expect(board.columns.map((column) => column.name)).toEqual([
      "Backlog",
      "Ready",
      "In Progress",
      "Waiting Approval / QA",
      "Done",
    ]);
    expect(board.tasks.map((task) => task.id).sort()).toEqual(["task-a", "task-b", "task-c", "task-d", "task-e"]);
    const waiting = board.columns.find((column) => column.name === "Waiting Approval / QA");
    expect(waiting?.taskIds).toEqual(["task-d"]);
    expect(board.activeTier).toBe("tier-1-opencode");
    expect(board.dagEdges).toContainEqual({ from: "task-a", to: "task-b" });
    expect(board.dagEdges).toContainEqual({ from: "task-b", to: "task-e" });
    const status = board.worktrees.find((entry) => entry.taskId === "task-d");
    expect(status?.branch).toBe("fleet/task-d");
    expect(board.missions.length).toBeGreaterThan(0);
  });

  test("scheduler plan and tier failover are wired into the board", async () => {
    const app = createServer({ auditLogPath: scratchAudit() });
    seedBoard(app);
    app.reportProviderFailure({ status: 429, code: "gousagelimiterror", message: "usage limit" });
    const res = await app.fetch(new Request("http://127.0.0.1/api/board"));
    const board = (await res.json()) as BoardView;
    expect(board.activeTier).toBe("tier-2-commercial");
    expect(board.plan.start).toContain("task-a");
  });
});

describe("loopback and CSRF guards", () => {
  test("non-loopback host is rejected with 403", async () => {
    const app = createServer({ auditLogPath: scratchAudit() });
    const res = await app.fetch(new Request("http://example.com/api/board"));
    expect(res.status).toBe(403);
    const body = (await res.json()) as { error: string };
    expect(body.error).toContain("loopback");
  });

  test("POST without a valid CSRF token is rejected", async () => {
    const app = createServer({ auditLogPath: scratchAudit() });
    const missing = await app.fetch(
      new Request("http://127.0.0.1/api/director/message", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ message: "hello" }),
      }),
    );
    expect(missing.status).toBe(403);
    const wrong = await app.fetch(authed("/api/director/message", { message: "hello" }, "wrong-token"));
    expect(wrong.status).toBe(403);
  });

  test("unknown routes and methods fail closed", async () => {
    const app = createServer({ auditLogPath: scratchAudit() });
    expect((await app.fetch(new Request("http://127.0.0.1/api/nope"))).status).toBe(404);
    expect(
      (await app.fetch(new Request("http://127.0.0.1/api/board", { method: "POST" }))).status,
    ).toBe(404);
  });
});

describe("POST /api/director/message", () => {
  test("bullets decompose into task cards and audit records the message", async () => {
    const auditLogPath = scratchAudit();
    const app = createServer({ auditLogPath });
    const res = await app.fetch(
      authed("/api/director/message", { message: "Ship search\n- index builder\n- query api" }, app.csrfToken),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { tasksCreated: string[] };
    expect(body.tasksCreated).toHaveLength(2);
    for (const id of body.tasksCreated) {
      expect(app.getTask(id)?.status).toBe("pending");
    }
    const anchor = checkAnchor(auditLogPath);
    expect(anchor.ok).toBe(true);
    expect(anchor.records).toBe(1);
  });

  test("empty messages are rejected", async () => {
    const app = createServer({ auditLogPath: scratchAudit() });
    const res = await app.fetch(authed("/api/director/message", { message: "   " }, app.csrfToken));
    expect(res.status).toBe(400);
  });
});

describe("GET /api/tasks/:id/drilldown", () => {
  test("returns session metadata, gates, tool log, and diff hunks", async () => {
    const app = createServer({ auditLogPath: scratchAudit() });
    app.upsertTask({ id: "task-w", status: "running", title: "Worker" });
    app.setStageGates("task-w", [
      { name: "precheck", status: "pass" },
      { name: "verify", status: "running" },
    ]);
    app.appendToolLog("task-w", { tool: "read", input: "src/a.ts", output: "ok" });
    app.recordDiff("task-w", [
      { file: "src/a.ts", status: "modified", additions: 10, deletions: 2, patch: "diff --git a/src/a.ts b/src/a.ts\n" },
    ]);
    const res = await app.fetch(new Request("http://127.0.0.1/api/tasks/task-w/drilldown"));
    expect(res.status).toBe(200);
    const view = (await res.json()) as {
      session: { sessionId: string; tier: string };
      stageGates: Array<{ name: string; status: string }>;
      toolLog: Array<{ tool: string }>;
      diffs: Array<{ file: string; additions: number; deletions: number; patch: string }>;
    };
    expect(view.session.sessionId).toBe("sess-task-w");
    expect(view.session.tier).toBe("tier-1-opencode");
    expect(view.stageGates.map((gate) => gate.name)).toEqual(["precheck", "verify"]);
    expect(view.toolLog.map((entry) => entry.tool)).toEqual(["read"]);
    expect(view.diffs[0]?.file).toBe("src/a.ts");
    expect(view.diffs[0]?.additions).toBe(10);
  });

  test("unknown task yields 404", async () => {
    const app = createServer({ auditLogPath: scratchAudit() });
    const res = await app.fetch(new Request("http://127.0.0.1/api/tasks/ghost/drilldown"));
    expect(res.status).toBe(404);
  });
});

describe("approval tickets: single-use + TTL", () => {
  test("verifyTicket consumes on first use and rejects reuse", () => {
    const store = new TicketStore();
    const subject = hashSubject("diff summary + qa verdicts");
    const { token } = store.mintTicket("task-1", subject);
    expect(store.verifyTicket(token)).toEqual({ taskId: "task-1", subjectHash: subject });
    expect(() => store.verifyTicket(token)).toThrow(/already been used/);
  });

  test("expired tickets are rejected and unknown tokens fail closed", () => {
    let now = 1_000_000;
    const store = new TicketStore(() => now);
    const { token } = store.mintTicket("task-1", "abc");
    now += 61_000;
    expect(() => store.verifyTicket(token)).toThrow(/expired/);
    expect(() => store.verifyTicket("00".repeat(32))).toThrow(/unknown/);
  });

  test("redeemTicket enforces the {taskId, subjectHash} binding", () => {
    const store = new TicketStore();
    const { token } = store.mintTicket("task-1", "hash-1");
    expect(() => store.redeemTicket(token, "task-2", "hash-1")).toThrow(/bound to task/);
    // The mismatched ticket is burned: it cannot be retried.
    expect(() => store.redeemTicket(token, "task-1", "hash-1")).toThrow(/already been used/);
  });

  test("Ed25519 round-trip verifies, tampered signatures do not", () => {
    const keys = generateApprovalKeyPair();
    const subject = hashSubject("approve me");
    const signature = signSubjectHash(keys.privateKeyPem, subject);
    expect(verifyApprovalSignature(keys.publicKeyPem, subject, signature)).toBe(true);
    expect(verifyApprovalSignature(keys.publicKeyPem, `${subject}tampered`, signature)).toBe(false);
    expect(verifyApprovalSignature(keys.publicKeyPem, subject, "zz")).toBe(false);
    const passKeys = passphraseToKeypair("correct horse");
    const passSig = signSubjectHash(passKeys.privateKeyPem, subject);
    expect(verifyApprovalSignature(passKeys.publicKeyPem, subject, passSig)).toBe(true);
    const wrongKeys = passphraseToKeypair("wrong horse");
    expect(verifyApprovalSignature(wrongKeys.publicKeyPem, subject, passSig)).toBe(false);
  });
});

describe("POST /api/approvals/:taskId/ticket + /sign", () => {
  async function approvedSetup(): Promise<{ app: FleetServer; subject: string }> {
    const app = createServer({ auditLogPath: scratchAudit() });
    app.upsertTask({ id: "task-h", status: "waitingHuman", title: "Needs human" });
    const subject = hashSubject("diff for task-h");
    return { app, subject };
  }

  test("Ed25519 keypair approval transitions waitingHuman to ready", async () => {
    const { app, subject } = await approvedSetup();
    const minted = await app.fetch(authed("/api/approvals/task-h/ticket", { subjectHash: subject }, app.csrfToken));
    expect(minted.status).toBe(200);
    const { ticket } = (await minted.json()) as { ticket: string };
    const keys = generateApprovalKeyPair();
    const signature = signSubjectHash(keys.privateKeyPem, subject);
    const signed = await app.fetch(
      authed(
        "/api/approvals/task-h/sign",
        { ticket, subjectHash: subject, signature, publicKey: keys.publicKeyPem },
        app.csrfToken,
      ),
    );
    expect(signed.status).toBe(200);
    const body = (await signed.json()) as { status: string };
    expect(body.status).toBe("ready");
    expect(app.getTask("task-h")?.status).toBe("ready");
    // The ticket is single-use: replaying it fails.
    const replay = await app.fetch(
      authed(
        "/api/approvals/task-h/sign",
        { ticket, subjectHash: subject, signature, publicKey: keys.publicKeyPem },
        app.csrfToken,
      ),
    );
    expect(replay.status).toBe(403);
  });

  test("passphrase-derived approval verifies without a stored secret", async () => {
    const { app, subject } = await approvedSetup();
    const minted = await app.fetch(authed("/api/approvals/task-h/ticket", { subjectHash: subject }, app.csrfToken));
    const { ticket } = (await minted.json()) as { ticket: string };
    const keys = passphraseToKeypair("human passphrase");
    const signature = signSubjectHash(keys.privateKeyPem, subject);
    const signed = await app.fetch(
      authed("/api/approvals/task-h/sign", { ticket, subjectHash: subject, signature, passphrase: "human passphrase" }, app.csrfToken),
    );
    expect(signed.status).toBe(200);
    expect(app.getTask("task-h")?.status).toBe("ready");
  });

  test("wrong passphrase, bad signature, and binding mismatch are rejected", async () => {
    const { app, subject } = await approvedSetup();
    app.upsertTask({ id: "task-other", status: "waitingHuman", title: "Other" });
    const minted = await app.fetch(authed("/api/approvals/task-h/ticket", { subjectHash: subject }, app.csrfToken));
    const { ticket } = (await minted.json()) as { ticket: string };
    const keys = passphraseToKeypair("human passphrase");
    const signature = signSubjectHash(keys.privateKeyPem, subject);

    const wrongPass = await app.fetch(
      authed(
        "/api/approvals/task-h/ticket",
        { subjectHash: subject },
        app.csrfToken,
      ),
    );
    expect(wrongPass.status).toBe(200);
    const fresh = (await wrongPass.json()) as { ticket: string };
    const badPass = await app.fetch(
      authed(
        "/api/approvals/task-h/sign",
        { ticket: fresh.ticket, subjectHash: subject, signature, passphrase: "wrong passphrase" },
        app.csrfToken,
      ),
    );
    expect(badPass.status).toBe(403);

    const crossTask = await app.fetch(
      authed(
        "/api/approvals/task-other/sign",
        { ticket, subjectHash: subject, signature, publicKey: keys.publicKeyPem },
        app.csrfToken,
      ),
    );
    expect(crossTask.status).toBe(403);
  });

  test("signing a task that is not waitingHuman fails with 409", async () => {
    const app = createServer({ auditLogPath: scratchAudit() });
    app.upsertTask({ id: "task-r", status: "running", title: "Running" });
    const subject = hashSubject("x");
    const minted = await app.fetch(authed("/api/approvals/task-r/ticket", { subjectHash: subject }, app.csrfToken));
    const { ticket } = (await minted.json()) as { ticket: string };
    const keys = generateApprovalKeyPair();
    const res = await app.fetch(
      authed(
        "/api/approvals/task-r/sign",
        { ticket, subjectHash: subject, signature: signSubjectHash(keys.privateKeyPem, subject), publicKey: keys.publicKeyPem },
        app.csrfToken,
      ),
    );
    expect(res.status).toBe(409);
  });

  test("rejection returns the task to pending and the audit ledger chains", async () => {
    const auditLogPath = scratchAudit();
    const app = createServer({ auditLogPath });
    app.upsertTask({ id: "task-j", status: "waitingHuman", title: "Judge me" });
    const subject = hashSubject("judge");
    const minted = await app.fetch(authed("/api/approvals/task-j/ticket", { subjectHash: subject }, app.csrfToken));
    const { ticket } = (await minted.json()) as { ticket: string };
    const keys = generateApprovalKeyPair();
    const res = await app.fetch(
      authed(
        "/api/approvals/task-j/sign",
        {
          ticket,
          subjectHash: subject,
          signature: signSubjectHash(keys.privateKeyPem, subject),
          publicKey: keys.publicKeyPem,
          approve: false,
        },
        app.csrfToken,
      ),
    );
    expect(res.status).toBe(200);
    expect(app.getTask("task-j")?.status).toBe("pending");
    const anchor = checkAnchor(auditLogPath);
    expect(anchor.ok).toBe(true);
    expect(anchor.records).toBe(2);
    const events = readFileSync(auditLogPath, "utf8")
      .split("\n")
      .filter((line) => line.length > 0)
      .map((line) => (JSON.parse(line) as { event: string }).event);
    expect(events).toEqual(["approval.ticket-minted", "approval.signed"]);
  });
});

describe("GET /api/events SSE", () => {
  test("snapshot replays from Last-Event-ID with a gap marker after overflow", async () => {
    const app = createServer({ auditLogPath: scratchAudit(), eventCapacity: 3 });
    for (let index = 1; index <= 5; index += 1) {
      app.bus.publish("probe", { index });
    }
    const res = await app.fetch(
      new Request("http://127.0.0.1/api/events?snapshot=1", { headers: { "last-event-id": "1" } }),
    );
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/event-stream");
    const body = await res.text();
    expect(body).toContain("event: fleet.gap");
    expect(body).toContain("event: probe");
    expect(body).not.toContain('"index":1');
    expect(body).toContain('"index":5');
  });

  test("live stream delivers published events after the replay", async () => {
    const app = createServer({ auditLogPath: scratchAudit() });
    app.bus.publish("probe", { index: 1 });
    const res = await app.fetch(new Request("http://127.0.0.1/api/events"));
    expect(res.status).toBe(200);
    const reader = res.body?.getReader();
    expect(reader).toBeDefined();
    if (reader === undefined) throw new Error("SSE body has no reader");
    const decoder = new TextDecoder();
    let received = "";
    for (let reads = 0; reads < 10; reads += 1) {
      const chunk = await reader.read();
      if (chunk.value !== undefined) {
        received += decoder.decode(chunk.value, { stream: true });
      }
      if (received.includes('"index":1') && !received.includes('"index":2')) {
        app.bus.publish("probe", { index: 2 });
        continue;
      }
      if (received.includes('"index":2')) {
        break;
      }
      if (chunk.done) {
        break;
      }
    }
    await reader.cancel();
    expect(received).toContain('"index":1');
    expect(received).toContain('"index":2');
  });
});
