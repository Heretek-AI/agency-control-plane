/**
 * Worker launcher, Director, and durable board state against a fake
 * OpenCode v2 server (`fixtures/fake-opencode.ts`) spawned as a real
 * child process exactly like `opencode serve`.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseDirectorReply } from "../src/director.js";
import { parseListeningUrl, parseSseFrame, spawnWorker } from "../src/opencode-client.js";
import { FAKE, FAKE_COMMAND, FAKE_WORKERS, git, post, scratchRepo, until } from "./helpers.js";
import { createServer, type CreateServerOptions, type FleetServer } from "../src/server.js";
import { taskPrompt } from "../src/worker-launcher.js";
import { runTurn, type WorkerConnection } from "../src/worker-session.js";




const opened: FleetServer[] = [];

function server(options: CreateServerOptions): FleetServer {
  const app = createServer({
    workers: FAKE_WORKERS,
    director: { command: FAKE_COMMAND, startTimeoutMs: 15_000, replyTimeoutMs: 15_000 },
    ...options,
  });
  opened.push(app);
  return app;
}

afterEach(async () => {
  await Promise.all(opened.splice(0).map((app) => app.shutdown()));
});



describe("worker protocol helpers", () => {
  test("listening URL and SSE frame parsing", () => {
    expect(parseListeningUrl("server listening on http://127.0.0.1:4096")).toBe("http://127.0.0.1:4096");
    expect(parseListeningUrl('{"url":"http://127.0.0.1:5000/"}')).toBe("http://127.0.0.1:5000");
    expect(parseListeningUrl("server password abc")).toBeNull();
    expect(parseSseFrame('data: {"id":"evt_1","type":"session.status","data":{"sessionID":"ses_1"}}')?.type).toBe("session.status");
    expect(parseSseFrame(": heartbeat")).toBeNull();
    expect(parseSseFrame("data: not json")).toBeNull();
  });

  test("spawnWorker fails closed when the command exits before listening", async () => {
    const stateDir = mkdtempSync(join(tmpdir(), "spawn-"));
    await expect(
      spawnWorker({ command: [process.execPath, "-e", "console.log('nope'); process.exit(3)"], cwd: stateDir, stateDir, startTimeoutMs: 5000 }),
    ).rejects.toThrow(/exited with code 3/);
  });

  test("a prompt admission that never answers still ends the turn at its timeout", async () => {
    const never = new Promise<never>(() => undefined);
    const conn = {
      proc: { exited: never, tail: () => "" },
      client: { prompt: () => never },
      listen: () => () => undefined,
      alive: () => true,
      close: async () => undefined,
    } as unknown as WorkerConnection;
    const result = await runTurn(conn, "sess-1", "hi", { timeoutMs: 50 });
    expect(result.outcome).toBe("timeout");
  });

  test("task prompt carries objective, acceptance and owned paths", () => {
    const prompt = taskPrompt({
      id: "task-1",
      missionId: "m",
      title: "T",
      kind: "expert-run",
      deps: [],
      strategy: "all_success",
      input: { objective: "Do X", acceptance: ["tests pass"], paths: ["src/x.ts"] },
      owner: [],
      policy: { strategy: "fail" },
      status: "running",
      attempts: 1,
    });
    expect(prompt).toContain("Objective: Do X");
    expect(prompt).toContain("- tests pass");
    expect(prompt).toContain("- src/x.ts");
  });
});

describe("worker launcher (fake opencode serve)", () => {
  test("ready task: worktree, isolated .opencode, session, live tool log, commit, waitingHuman", async () => {
    const repo = scratchRepo();
    const stateDir = mkdtempSync(join(tmpdir(), "launcher-state-"));
    const app = server({ repoDir: repo, stateDir });
    const seen: string[] = [];
    app.bus.subscribe(1, (event) => seen.push(event.type));
    app.upsertTask({ id: "task-1", status: "pending", title: "Write output" });
    await until(() => app.getTask("task-1")?.status === "waitingHuman");
    const task = app.getTask("task-1")!;
    expect(task.sessionId).toMatch(/^ses_/);
    expect(task.attempts).toBe(1);
    expect(task.input.base).toBe(git(repo, ["rev-parse", "HEAD"]));
    expect(task.worktree).toBe(join(stateDir, "worktrees", "task-1"));
    // Isolated OpenCode SQLite store inside the worktree, never committed.
    expect(existsSync(join(task.worktree!, ".opencode", "opencode.db"))).toBe(true);
    const files = git(repo, ["show", "--name-only", "--format=", "fleet/task-1"]).split("\n");
    expect(files).toEqual([`fleet-output/${task.sessionId}.txt`]);
    // Live log republished on the bus and kept for the drill-down.
    expect(seen).toContain("worker.started");
    expect(seen).toContain("worker.tool");
    expect(seen).toContain("worker.finished");
    const drill = (await (await app.fetch(new Request("http://127.0.0.1/api/tasks/task-1/drilldown"))).json()) as {
      toolLog: Array<{ tool: string; input: string; output: string }>;
      diffs: Array<{ file: string }>;
      stageGates: Array<{ name: string; status: string }>;
      subjectHash: string;
    };
    expect(drill.toolLog[0]?.tool).toBe("write");
    expect(drill.toolLog[0]?.output).toContain("wrote fleet-output/");
    expect(drill.diffs.map((hunk) => hunk.file)).toEqual([`fleet-output/${task.sessionId}.txt`]);
    expect(drill.stageGates.find((gate) => gate.name === "worker")?.status).toBe("pass");
    expect(drill.subjectHash).toBe(app.subjectFor("task-1").subjectHash);
    await until(() => app.runningWorkers().length === 0);
  });

  test("no changes -> done; dependency chain runs in order", async () => {
    const repo = scratchRepo();
    const app = server({ repoDir: repo, stateDir: mkdtempSync(join(tmpdir(), "launcher-state-")) });
    app.upsertTask({ id: "task-a", status: "pending", title: "first [noop]" });
    app.upsertTask({ id: "task-b", status: "pending", title: "second [noop]", deps: ["task-a"] });
    await until(() => app.getTask("task-b")?.status === "done");
    expect(app.getTask("task-a")?.status).toBe("done");
  });

  test("worker failure, crash, and cascade cancellation", async () => {
    const repo = scratchRepo();
    const app = server({ repoDir: repo, stateDir: mkdtempSync(join(tmpdir(), "launcher-state-")) });
    app.upsertTask({ id: "task-f", status: "pending", title: "explode [fail]" });
    app.upsertTask({ id: "task-c", status: "pending", title: "crash [crash]" });
    app.upsertTask({ id: "task-d", status: "pending", title: "downstream", deps: ["task-f"] });
    await until(() => app.getTask("task-f")?.status === "failed" && app.getTask("task-c")?.status === "failed");
    expect(app.getTask("task-f")?.reason).toContain("model exploded");
    expect(app.getTask("task-c")?.reason).toContain("exited with code 7");
    await until(() => app.getTask("task-d")?.status === "cancelled");
  });

  test("fleet cap bounds concurrency; shutdown kills workers and re-queues them", async () => {
    const repo = scratchRepo();
    const stateDir = mkdtempSync(join(tmpdir(), "launcher-state-"));
    const app = server({ repoDir: repo, stateDir, fleetCap: 2 });
    for (const id of ["task-1", "task-2", "task-3"]) {
      app.upsertTask({ id, status: "pending", title: `slow ${id} [hang]` });
    }
    await until(() => app.getBoard().tasks.filter((task) => task.status === "running" && task.sessionId?.startsWith("ses_")).length === 2);
    expect(app.runningWorkers()).toHaveLength(2);
    expect(app.getTask("task-3")?.status).toBe("ready");
    const pids = app.getBoard().tasks.filter((task) => task.status === "running").map((task) => task.id);
    await app.shutdown();
    for (const id of pids) {
      expect(app.getTask(id)?.status).toBe("pending");
    }
    // Restart on the same state: the board survives.
    const again = server({ repoDir: repo, stateDir, workers: false, director: false });
    expect(again.getBoard().tasks.map((task) => task.id)).toEqual(["task-1", "task-2", "task-3"]);
    expect(again.getTask("task-1")?.title).toBe("slow task-1 [hang]");
  });
});

describe("durable board state", () => {
  test("tasks, messages, tool log, and counters survive a restart; running tasks are re-queued", async () => {
    const stateDir = mkdtempSync(join(tmpdir(), "board-state-"));
    const first = server({ stateDir });
    const res = await post(first, "/api/director/message", { message: "/ship spec\n- one\n- two" });
    expect(res.status).toBe(200);
    first.upsertTask({ id: "task-9", status: "running", title: "was running" });
    first.appendToolLog("task-9", { tool: "read", input: "a", output: "b" });
    await first.shutdown();
    const second = server({ stateDir });
    const board = second.getBoard();
    expect(board.tasks.map((task) => task.id)).toEqual(["task-1", "task-2", "task-9"]);
    expect(board.messages).toHaveLength(1);
    expect(second.getTask("task-9")?.status).toBe("pending");
    expect(second.getTask("task-9")?.reason).toContain("restarted");
    const drill = (await (await second.fetch(new Request("http://127.0.0.1/api/tasks/task-9/drilldown"))).json()) as {
      toolLog: Array<{ tool: string }>;
    };
    expect(drill.toolLog.map((entry) => entry.tool)).toEqual(["read"]);
    const created = (await (await post(second, "/api/director/message", { message: "/ship next" })).json()) as { tasksCreated: string[] };
    expect(created.tasksCreated).toEqual(["task-3"]);
  });
});

describe("Director session (fake opencode serve)", () => {
  test("replies come from the long-lived Director session; cards only from a valid tasks block", async () => {
    const repo = scratchRepo();
    const app = server({ repoDir: repo, stateDir: mkdtempSync(join(tmpdir(), "director-state-")), workers: false });
    // Bullet lines alone create nothing: the Director decides.
    const chat = await post(app, "/api/director/message", { message: "hello\n- not a task" });
    expect(chat.status).toBe(202);
    await app.directorIdle();
    let board = app.getBoard();
    expect(board.tasks).toHaveLength(0);
    expect(board.messages.map((message) => message.author)).toEqual(["human", "director"]);
    expect(board.messages[1]?.text).toContain("Director turn 1 (preamble seen)");

    await post(app, "/api/director/message", { message: "please plan the query API" });
    await app.directorIdle();
    board = app.getBoard();
    const reply = board.messages.at(-1)!;
    // Same session: second turn, no preamble re-sent.
    expect(reply.text).toContain("Director turn 2 (preamble absent)");
    expect(reply.text).not.toContain("```tasks");
    expect(reply.tasksCreated).toEqual(["task-1", "task-2"]);
    expect(app.getTask("task-1")?.title).toBe("Build query API");
    expect(app.getTask("task-1")?.input.paths).toEqual(["src/api.ts"]);
    expect(app.getTask("task-1")?.input.acceptance).toEqual(["returns 200"]);
    expect(app.getTask("task-2")?.deps).toEqual(["task-1"]);

    await post(app, "/api/director/message", { message: "bad plan please" });
    await app.directorIdle();
    board = app.getBoard();
    expect(board.tasks).toHaveLength(2);
    expect(board.messages.at(-1)?.author).toBe("system");
    expect(board.messages.at(-1)?.text).toContain("No cards created");
  });

  test("a Director that cannot start reports the failure in chat", async () => {
    const repo = scratchRepo();
    const app = server({
      repoDir: repo,
      stateDir: mkdtempSync(join(tmpdir(), "director-state-")),
      workers: false,
      director: { command: ["/nonexistent/opencode", "serve"], startTimeoutMs: 2000 },
    });
    expect((await post(app, "/api/director/message", { message: "hi" })).status).toBe(202);
    await app.directorIdle();
    expect(app.getBoard().messages.at(-1)?.text).toContain("Director turn failed");
  });

  test("parseDirectorReply validates strictly", () => {
    expect(parseDirectorReply("no block").ok).toBe(true);
    const unknownDep = parseDirectorReply('```tasks\n[{"title":"x","deps":["ghost"]}]\n```');
    expect(unknownDep.ok).toBe(false);
    const known = parseDirectorReply('```tasks\n[{"title":"x","deps":["task-7"]}]\n```', new Set(["task-7"]));
    expect(known.ok).toBe(true);
    expect(parseDirectorReply('```tasks\n[{"title":"x","extra":1}]\n```').ok).toBe(false);
    expect(parseDirectorReply("```tasks\n[]\n```").ok).toBe(false);
    expect(parseDirectorReply("```tasks\n{not json}\n```").ok).toBe(false);
    const dupe = parseDirectorReply('```tasks\n[{"key":"a","title":"x"},{"key":"a","title":"y"}]\n```');
    expect(dupe.ok).toBe(false);
    const self = parseDirectorReply('```tasks\n[{"key":"a","title":"x","deps":["a"]}]\n```');
    expect(self.ok).toBe(false);
    const loop = parseDirectorReply(
      '```tasks\n[{"key":"a","title":"x","deps":["c"]},{"key":"b","title":"y","deps":["a"]},{"key":"c","title":"z","deps":["b"]}]\n```',
    );
    expect(loop.ok).toBe(false);
    if (!loop.ok) expect(loop.error).toContain("cycle");
    const chain = parseDirectorReply(
      '```tasks\n[{"key":"a","title":"x"},{"key":"b","title":"y","deps":["a"]},{"key":"c","title":"z","deps":["a","b"]}]\n```',
    );
    expect(chain.ok).toBe(true);
  });
});

test("fake worker fixture is the documented test double", () => {
  expect(readFileSync(FAKE, "utf8")).toContain("server listening on");
});
