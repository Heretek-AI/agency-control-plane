/**
 * Pure task scheduler. A pure function of the task graph, the caps, and
 * the set of running tasks: no clock, no randomness, no I/O. Imports only
 * the model and the wildcard module.
 *
 * Rules:
 * - A task is startable when its dependencies are met: all `done` under
 *   `all_success`, any `done` under `one_success`.
 * - A task that can never run is cancelled: under `all_success` when any
 *   dependency is `failed` or `cancelled`; under `one_success` when every
 *   dependency is terminal without a `done`. Cascades to fixpoint.
 * - Starts are ordered by id, bounded by the fleet-wide cap and each
 *   expert's cap. Dependency-met tasks without a free slot are reported
 *   as `ready` (waiting for a slot).
 * - Two `expert-run` tasks whose declared `paths` overlap never run at
 *   the same time (conservative `mayOverlap`; serializing is acceptable).
 * - `waitingHuman` tasks never start and never force cancellation: a
 *   human may still release them.
 */
import { TaskStatuses, gateStrategy, type Task, type TaskStatus } from "./model.js";
import { mayOverlap } from "./wildcard.js";

export interface ScheduleCaps {
  /** Fleet-wide cap on running tasks. */
  fleet: number;
  /** Per-expert cap on running `expert-run` tasks. Defaults to the fleet cap. */
  perExpert?: (expert: string) => number;
}

export interface ScheduleResult {
  /** Ids to start now, in start order. */
  start: string[];
  /** Dependency-met ids with no free slot (or blocked by overlap). */
  ready: string[];
  /** Ids that can never run. */
  cancel: string[];
}

export type TaskOutcome = "success" | "failure";

type Status = TaskStatus;

const TERMINAL: ReadonlySet<Status> = new Set([
  TaskStatuses.done,
  TaskStatuses.failed,
  TaskStatuses.cancelled,
]);

function depsMet(task: Task, byId: Map<string, Task>): boolean {
  if (gateStrategy(task) === "one_success") {
    return task.deps.some((d) => byId.get(d)?.status === TaskStatuses.done);
  }
  return task.deps.every((d) => byId.get(d)?.status === TaskStatuses.done);
}

function neverRunnable(task: Task, byId: Map<string, Task>): boolean {
  if (gateStrategy(task) === "one_success") {
    return (
      task.deps.length > 0 &&
      task.deps.every((d) => {
        const s = byId.get(d)?.status;
        return s !== undefined && TERMINAL.has(s) && s !== TaskStatuses.done;
      })
    );
  }
  return task.deps.some((d) => {
    const s = byId.get(d)?.status;
    return s === TaskStatuses.failed || s === TaskStatuses.cancelled;
  });
}

/**
 * True when two `expert-run` tasks touch potentially the same files: any
 * pair of `input.paths` entries with `mayOverlap(pa, pb)`. Exported so
 * tests and the drill-down inspector can explain serialization decisions.
 */
export function pathsOverlap(a: Task, b: Task): boolean {
  if (a.kind !== "expert-run" || b.kind !== "expert-run") return false;
  return a.input.paths.some((pa) => b.input.paths.some((pb) => mayOverlap(pa, pb)));
}

export function schedule(
  tasks: Task[],
  runningIds: Iterable<string>,
  caps: ScheduleCaps,
): ScheduleResult {
  const byId = new Map(tasks.map((t) => [t.id, t]));
  const running = new Set(runningIds);
  const perExpert = caps.perExpert ?? (() => caps.fleet);

  // Cancellation closure, id-ordered for determinism.
  const cancel = new Set<string>();
  const cancelledView = new Map<string, Status>();
  for (const [id, t] of byId) cancelledView.set(id, t.status);
  let changed = true;
  while (changed) {
    changed = false;
    for (const id of [...byId.keys()].sort()) {
      const status = cancelledView.get(id)!;
      if (status !== TaskStatuses.pending && status !== TaskStatuses.ready && status !== TaskStatuses.backlog) {
        continue;
      }
      if (running.has(id)) continue;
      // Evaluate against the view where already-cancelled tasks read cancelled.
      const view = new Map<string, Task>();
      for (const [k, v] of byId) {
        const s = cancelledView.get(k)!;
        view.set(k, s === v.status ? v : { ...v, status: s });
      }
      if (neverRunnable(view.get(id)!, view)) {
        cancelledView.set(id, TaskStatuses.cancelled);
        cancel.add(id);
        changed = true;
      }
    }
  }

  // Startable candidates in id order (backlog, pending, or already ready).
  const candidates = tasks
    .filter(
      (t) =>
        !cancel.has(t.id) &&
        !running.has(t.id) &&
        (t.status === TaskStatuses.backlog ||
          t.status === TaskStatuses.pending ||
          t.status === TaskStatuses.ready) &&
        depsMet(t, byId),
    )
    .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));

  const expertRunning = new Map<string, number>();
  for (const id of running) {
    const t = byId.get(id);
    if (t?.kind === "expert-run" && t.expert !== undefined) {
      expertRunning.set(t.expert, (expertRunning.get(t.expert) ?? 0) + 1);
    }
  }

  const start: string[] = [];
  const ready: string[] = [];
  const selected: Task[] = [];
  let runningCount = running.size;
  for (const task of candidates) {
    const expertCap =
      task.kind === "expert-run" && task.expert !== undefined ? perExpert(task.expert) : caps.fleet;
    const expertCount =
      task.kind === "expert-run" && task.expert !== undefined
        ? (expertRunning.get(task.expert) ?? 0)
        : 0;
    const blockedByOverlap =
      task.kind === "expert-run" &&
      [...running].some((id) => {
        const r = byId.get(id);
        return r !== undefined && pathsOverlap(task, r);
      });
    const collidesSelected = selected.some((s) => pathsOverlap(task, s));
    if (
      runningCount < caps.fleet &&
      expertCount < expertCap &&
      !blockedByOverlap &&
      !collidesSelected
    ) {
      start.push(task.id);
      selected.push(task);
      runningCount += 1;
      if (task.kind === "expert-run" && task.expert !== undefined) {
        expertRunning.set(task.expert, expertCount + 1);
      }
    } else {
      ready.push(task.id);
    }
  }

  return { start, ready, cancel: [...cancel].sort() };
}

/**
 * Next status for a finished running task. `attempts` counts finished
 * runs: under `retry` the same task re-queues while
 * `attempts <= maxAttempts`, then fails; under `replan` it parks for a
 * human; under `fail` it is terminal.
 */
export function nextStatus(task: Task, outcome: TaskOutcome): TaskStatus {
  if (outcome === "success") return TaskStatuses.done;
  const policy = task.policy;
  if (policy.strategy === "fail") return TaskStatuses.failed;
  if (policy.strategy === "replan") return TaskStatuses.waitingHuman;
  return task.attempts <= policy.maxAttempts ? TaskStatuses.pending : TaskStatuses.failed;
}
