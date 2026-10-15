import { describe, expect, test } from "bun:test";
import { TaskStatuses, type Task } from "../src/model.js";
import { nextStatus, pathsOverlap, schedule } from "../src/scheduler.js";

function makeTask(overrides: Partial<Task> & { id: string }): Task {
  return {
    missionId: "m-1",
    kind: "expert-run",
    expert: "coder",
    deps: [],
    strategy: "all_success",
    input: {
      objective: "do work",
      acceptance: [],
      paths: [],
    },
    owner: [],
    policy: { strategy: "fail" },
    status: TaskStatuses.pending,
    attempts: 0,
    ...overrides,
  } as Task;
}

describe("scheduler all_success", () => {
  test("ready when every dep is done", () => {
    const tasks = [
      makeTask({ id: "a", status: TaskStatuses.done }),
      makeTask({ id: "b", status: TaskStatuses.done }),
      makeTask({ id: "c", deps: ["a", "b"] }),
    ];
    const result = schedule(tasks, [], { fleet: 4 });
    expect(result.start).toEqual(["c"]);
    expect(result.cancel).toEqual([]);
  });

  test("not ready while a dep is still pending", () => {
    const tasks = [
      makeTask({ id: "a", status: TaskStatuses.done }),
      makeTask({ id: "b", status: TaskStatuses.pending }),
      makeTask({ id: "c", deps: ["a", "b"] }),
    ];
    const result = schedule(tasks, [], { fleet: 4 });
    expect(result.start).toContain("b");
    expect(result.start).not.toContain("c");
    expect(result.cancel).toEqual([]);
  });

  test("cascade cancel to fixpoint when a dep fails", () => {
    const tasks = [
      makeTask({ id: "a", status: TaskStatuses.failed }),
      makeTask({ id: "b", deps: ["a"] }),
      makeTask({ id: "c", deps: ["b"] }),
    ];
    const result = schedule(tasks, [], { fleet: 4 });
    expect(result.cancel).toEqual(["b", "c"]);
    expect(result.start).toEqual([]);
  });

  test("cascade cancel covers cancelled deps and id-ordered determinism", () => {
    const tasks = [
      makeTask({ id: "z", deps: ["y"] }),
      makeTask({ id: "y", deps: ["x"] }),
      makeTask({ id: "x", status: TaskStatuses.cancelled }),
    ];
    const result = schedule(tasks, [], { fleet: 4 });
    expect(result.cancel).toEqual(["y", "z"]);
  });
});

describe("scheduler one_success", () => {
  test("ready when at least one dep is done", () => {
    const tasks = [
      makeTask({ id: "a", status: TaskStatuses.done }),
      makeTask({ id: "b", status: TaskStatuses.pending }),
      makeTask({ id: "c", deps: ["a", "b"], strategy: "one_success" }),
    ];
    const result = schedule(tasks, [], { fleet: 4 });
    expect(result.start).toContain("c");
  });

  test("cancels only when every dep is terminal with zero done", () => {
    const tasks = [
      makeTask({ id: "a", status: TaskStatuses.failed }),
      makeTask({ id: "b", status: TaskStatuses.cancelled }),
      makeTask({ id: "c", deps: ["a", "b"], strategy: "one_success" }),
    ];
    const result = schedule(tasks, [], { fleet: 4 });
    expect(result.cancel).toEqual(["c"]);
  });

  test("does not cancel while a dep is still pending", () => {
    const tasks = [
      makeTask({ id: "a", status: TaskStatuses.failed }),
      makeTask({ id: "b", status: TaskStatuses.pending }),
      makeTask({ id: "c", deps: ["a", "b"], strategy: "one_success" }),
    ];
    const result = schedule(tasks, [], { fleet: 4 });
    expect(result.cancel).toEqual([]);
    expect(result.start).not.toContain("c");
  });
});

describe("scheduler overlap serialization", () => {
  test("pathsOverlap detects shared input paths", () => {
    const a = makeTask({ id: "a", input: { objective: "x", acceptance: [], paths: ["src/omni/*"] } });
    const b = makeTask({ id: "b", input: { objective: "y", acceptance: [], paths: ["src/omni/graph.ts"] } });
    expect(pathsOverlap(a, b)).toBe(true);
  });

  test("pathsOverlap ignores disjoint paths and non-expert tasks", () => {
    const a = makeTask({ id: "a", input: { objective: "x", acceptance: [], paths: ["src/alpha/*"] } });
    const b = makeTask({ id: "b", input: { objective: "y", acceptance: [], paths: ["src/beta/*"] } });
    expect(pathsOverlap(a, b)).toBe(false);
    const verifier = makeTask({
      id: "v",
      kind: "verify",
      input: { objective: "x", acceptance: [], paths: ["src/alpha/*"] },
    });
    expect(pathsOverlap(a, verifier)).toBe(false);
  });

  test("overlapping task blocked while the other runs (blockedByOverlap)", () => {
    const running = makeTask({
      id: "a",
      status: TaskStatuses.running,
      input: { objective: "x", acceptance: [], paths: ["src/alpha/*"] },
    });
    const candidate = makeTask({
      id: "b",
      input: { objective: "y", acceptance: [], paths: ["src/alpha/file.ts"] },
    });
    const result = schedule([running, candidate], ["a"], { fleet: 4 });
    expect(result.start).not.toContain("b");
    expect(result.ready).toContain("b");
  });

  test("two overlapping candidates never start together (collidesSelected)", () => {
    const a = makeTask({
      id: "a",
      input: { objective: "x", acceptance: [], paths: ["src/alpha/*"] },
    });
    const b = makeTask({
      id: "b",
      input: { objective: "y", acceptance: [], paths: ["src/alpha/other.ts"] },
    });
    const result = schedule([a, b], [], { fleet: 4 });
    expect(result.start).toEqual(["a"]);
    expect(result.ready).toEqual(["b"]);
  });
});

describe("scheduler waitingHuman", () => {
  test("waitingHuman tasks never start", () => {
    const tasks = [makeTask({ id: "h", status: TaskStatuses.waitingHuman })];
    const result = schedule(tasks, [], { fleet: 4 });
    expect(result.start).not.toContain("h");
    expect(result.ready).not.toContain("h");
  });

  test("waitingHuman deps never force downstream cancellation", () => {
    const tasks = [
      makeTask({ id: "h", status: TaskStatuses.waitingHuman }),
      makeTask({ id: "d", deps: ["h"] }),
      makeTask({ id: "o", deps: ["h"], strategy: "one_success" }),
    ];
    const result = schedule(tasks, [], { fleet: 4 });
    expect(result.cancel).toEqual([]);
    expect(result.start).not.toContain("d");
    expect(result.start).not.toContain("o");
  });
});

describe("scheduler caps", () => {
  test("fleet cap overflows dependency-met tasks into ready", () => {
    const tasks = [makeTask({ id: "a" }), makeTask({ id: "b" }), makeTask({ id: "c" })];
    const result = schedule(tasks, [], { fleet: 2 });
    expect(result.start).toEqual(["a", "b"]);
    expect(result.ready).toEqual(["c"]);
  });

  test("per-expert cap bounds expert starts", () => {
    const tasks = [
      makeTask({ id: "a", expert: "coder" }),
      makeTask({ id: "b", expert: "coder" }),
    ];
    const result = schedule(tasks, [], { fleet: 4, perExpert: () => 1 });
    expect(result.start).toEqual(["a"]);
    expect(result.ready).toEqual(["b"]);
  });
});

describe("nextStatus", () => {
  test("success always lands done", () => {
    const task = makeTask({ id: "a", status: TaskStatuses.running });
    expect(nextStatus(task, "success")).toBe(TaskStatuses.done);
  });

  test("fail strategy lands failed", () => {
    const task = makeTask({ id: "a", status: TaskStatuses.running });
    expect(nextStatus(task, "failure")).toBe(TaskStatuses.failed);
  });

  test("replan strategy parks waitingHuman", () => {
    const task = makeTask({
      id: "a",
      status: TaskStatuses.running,
      policy: { strategy: "replan" },
    });
    expect(nextStatus(task, "failure")).toBe(TaskStatuses.waitingHuman);
  });

  test("retry re-queues while attempts allow, then fails", () => {
    const fresh = makeTask({
      id: "a",
      status: TaskStatuses.running,
      attempts: 1,
      policy: { strategy: "retry", maxAttempts: 2 },
    });
    expect(nextStatus(fresh, "failure")).toBe(TaskStatuses.pending);
    const exhausted = makeTask({
      id: "b",
      status: TaskStatuses.running,
      attempts: 3,
      policy: { strategy: "retry", maxAttempts: 2 },
    });
    expect(nextStatus(exhausted, "failure")).toBe(TaskStatuses.failed);
  });
});
