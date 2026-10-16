import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { hashSubject, TicketStore } from "../src/approval-tickets.js";
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
  test("/ship bullets decompose into task cards and audit records the message", async () => {
    const auditLogPath = scratchAudit();
    const app = createServer({ auditLogPath });
    const res = await app.fetch(
      authed("/api/director/message", { message: "/ship Ship search\n- index builder\n- query api" }, app.csrfToken),
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

  test("free-form messages need a Director worker: 503 without one, no cards created", async () => {
    const app = createServer({ auditLogPath: scratchAudit() });
    const res = await app.fetch(authed("/api/director/message", { message: "- looks like a bullet" }, app.csrfToken));
    expect(res.status).toBe(503);
    expect(app.getBoard().tasks).toHaveLength(0);
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
    const binding = store.verifyTicket(token);
    expect(binding.taskId).toBe("task-1");
    expect(binding.subjectHash).toBe(subject);
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

describe("input parsing hardening", () => {
  test("bulletText parses bullets linearly and rejects non-bullets", async () => {
    const { bulletText } = await import("../src/server.js");
    expect(bulletText("  - alpha  ")).toBe("alpha");
    expect(bulletText("* beta")).toBe("beta");
    expect(bulletText("12. gamma")).toBe("gamma");
    expect(bulletText("12.gamma")).toBeNull();
    expect(bulletText("-nope")).toBeNull();
    expect(bulletText("- ")).toBeNull();
    const started = Date.now();
    bulletText(`- ${" ".repeat(200_000)}x${" ".repeat(200_000)}`);
    expect(Date.now() - started).toBeLessThan(500);
  });

  test("tasks fences are extracted without regex backtracking", async () => {
    const { extractTaskBlocks } = await import("../src/director.js");
    expect(extractTaskBlocks('a\n```tasks\n[1]\n```\nb')).toEqual({ blocks: ["[1]"], text: "a\n\nb" });
    expect(extractTaskBlocks("```tasks extra\n[1]\n```").blocks).toEqual([]);
    const started = Date.now();
    extractTaskBlocks(`\`\`\`tasks\n${"\n".repeat(200_000)}`);
    expect(Date.now() - started).toBeLessThan(500);
  });

  test("static serving refuses paths outside web/dist", async () => {
    const { mkdtempSync: mk, writeFileSync } = await import("node:fs");
    const dist = mk(join(tmpdir(), "dist-"));
    writeFileSync(join(dist, "index.html"), "<!doctype html><title>x</title>");
    const app = createServer({ auditLogPath: scratchAudit(), webDistDir: dist });
    const index = await app.fetch(new Request("http://127.0.0.1/"));
    expect(index.status).toBe(200);
    expect(index.headers.get("content-security-policy")).toContain("default-src 'self'");
    const dotted = await app.fetch(new Request("http://127.0.0.1/%2e%2e/%2e%2e/etc/passwd"));
    expect(await dotted.text()).not.toContain("root:");
    const { serveStatic } = await import("../src/server.js");
    expect(serveStatic(dist, "/../../etc/passwd")).toBeNull();
    expect(serveStatic(dist, "/..%2f..%2fetc%2fpasswd")).toBeNull();
    expect((await app.fetch(new Request("http://127.0.0.1/missing.js"))).status).toBe(404);
    expect((await app.fetch(new Request("http://127.0.0.1/some/route"))).status).toBe(200);
  });
});
