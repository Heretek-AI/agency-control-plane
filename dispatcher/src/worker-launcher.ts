/**
 * Worker launcher: turns scheduler decisions into running OpenCode workers.
 *
 * On every board change the launcher runs the pure scheduler over the
 * task graph with the fleet/per-expert caps and the set of tasks it is
 * actually running, then:
 *
 * - cancels tasks that can never run;
 * - marks dependency-met tasks without a free slot `ready`;
 * - parks `human` tasks as `waitingHuman`;
 * - launches every other startable task:
 *   1. allocate (or reuse) its worktree via `worktrees.ts`, pinning the
 *      base commit so the approval diff is stable;
 *   2. spawn the worker command in the worktree with isolated
 *      `.opencode` state; an `expert` task with a role pack (`roles.ts`)
 *      gets `XDG_CONFIG_HOME=<rolesDir>/<role>`, the role `opencode.json`
 *      copied into its `.opencode/`, and the role prompt + skills in its
 *      task prompt;
 *   3. create a session on the active model tier's model (when
 *      `tierModels` maps it), send the task prompt, and republish tool /
 *      status / text events on the dispatcher bus (drill-down live log);
 *   4. on success commit the worktree changes onto `fleet/<taskId>` and
 *      move the task to `waitingHuman` (non-empty diff: a human must sign
 *      it) or `done` (no changes); on a quota-shaped provider failure
 *      report it to the tier failover and re-queue the task without
 *      spending an attempt; on any other failure / exit / timeout apply
 *      the task's retry policy (`nextStatus`).
 *
 * While missions are paused (last tier exhausted) nothing new launches
 * until the provider's retry time.
 *
 * `stop()` aborts every run, kills every worker, and re-queues
 * interrupted tasks as `pending` so a restart resumes them.
 */
import { existsSync } from "node:fs";
import path from "node:path";
import { isQuotaFailure, type ModelTier, type ProviderDisposition, type ProviderFailure } from "./limits.js";
import type { Task, TaskStatus } from "./model.js";
import type { ModelRef, WorkerEvent } from "./opencode-client.js";
import { installRoleConfig, loadRole, type RoleProfile } from "./roles.js";
import { nextStatus, schedule, type ScheduleCaps } from "./scheduler.js";
import { describeError, openWorker, runTurn, type WorkerClientFactory, type WorkerConnection } from "./worker-session.js";
import { allocateWorktree, runGit, type WorktreeStore } from "./worktrees.js";

export interface LauncherHost {
  listTasks(): Task[];
  getTask(id: string): Task | undefined;
  updateTask(id: string, patch: Partial<Task>): Task;
  appendToolLog(taskId: string, entry: { tool: string; input: string; output: string }): void;
  setStageGates(taskId: string, gates: Array<{ name: string; status: "pending" | "running" | "pass" | "fail" }>): void;
  publish(type: string, data: unknown): void;
  audit(event: string, data: unknown): void;
  /** Called after a run finishes and the task branch holds the worker's commit. */
  afterRun?: ((taskId: string) => void) | undefined;
  /** Called once a run is fully over: worker killed, task no longer running here. */
  onRunSettled?: ((taskId: string) => void) | undefined;
  /** The model tier new sessions run on. */
  activeTier?: (() => ModelTier) | undefined;
  /** Tier failover: classify a provider failure and apply its disposition. */
  reportProviderFailure?: ((failure: ProviderFailure) => ProviderDisposition) | undefined;
}

export interface WorkerLauncherOptions {
  repoDir: string;
  treesDir: string;
  worktreeStore: WorktreeStore;
  command: readonly string[];
  caps: ScheduleCaps;
  /** OpenCode agent for task sessions (omit for the server default). */
  agent?: string | undefined;
  /** Role packs for `expert` tasks (see `roles.ts`). */
  rolesDir?: string | undefined;
  /** `provider/model` per tier; a mapped tier pins the session model. */
  tierModels?: Partial<Record<ModelTier, string>> | undefined;
  startTimeoutMs?: number | undefined;
  taskTimeoutMs?: number | undefined;
  env?: Record<string, string | undefined> | undefined;
  clientFactory?: WorkerClientFactory | undefined;
}

interface ActiveRun {
  abort: AbortController;
  done: Promise<void>;
  conn: WorkerConnection | null;
}

const MAX_LOG_FIELD = 4000;

function clip(text: string): string {
  return text.length > MAX_LOG_FIELD ? `${text.slice(0, MAX_LOG_FIELD)}… [${text.length - MAX_LOG_FIELD} more chars]` : text;
}

/** Text of an OpenCode tool result `content` array. */
function contentText(content: unknown): string {
  if (!Array.isArray(content)) return "";
  return content
    .map((part) => {
      if (typeof part === "object" && part !== null) {
        const record = part as { text?: unknown; type?: unknown };
        if (typeof record.text === "string") return record.text;
        return typeof record.type === "string" ? `[${record.type}]` : "";
      }
      return typeof part === "string" ? part : "";
    })
    .filter((part) => part.length > 0)
    .join("\n");
}

/** Parse a `provider/model[#variant]` reference into the OpenCode v2 `Model.Ref` shape. */
export function parseModelRef(value: string): ModelRef {
  const slash = value.indexOf("/");
  const hash = value.indexOf("#", slash + 1);
  const providerID = value.slice(0, Math.max(slash, 0));
  const id = value.slice(slash + 1, hash === -1 ? undefined : hash);
  const variant = hash === -1 ? undefined : value.slice(hash + 1);
  if (slash <= 0 || id.length === 0 || providerID.includes("#") || variant === "") {
    throw new Error(`invalid model reference ${JSON.stringify(value)} (want provider/model)`);
  }
  return variant === undefined ? { providerID, id } : { providerID, id, variant };
}

/** The prompt a task worker receives, shaped by its role pack when it has one. */
export function taskPrompt(task: Task, role?: RoleProfile): string {
  const lines = [
    `You are a fleet worker for task ${task.id}${task.title !== undefined ? `: ${task.title}` : ""}.`,
  ];
  if (role !== undefined) {
    lines.push("", `Role: ${role.id}`);
    if (role.prompt !== undefined) lines.push("", role.prompt);
    if (role.skills.length > 0) {
      lines.push("", "Role skills (read the SKILL.md that fits before starting):", ...role.skills.map((file) => `- ${file}`));
    }
  }
  lines.push("", `Objective: ${task.input.objective}`);
  if (task.input.context !== undefined) lines.push("", `Context: ${task.input.context}`);
  if (task.input.constraints !== undefined) lines.push("", `Constraints: ${task.input.constraints}`);
  if (task.input.acceptance.length > 0) {
    lines.push("", "Acceptance criteria:", ...task.input.acceptance.map((item) => `- ${item}`));
  }
  if (task.input.paths.length > 0) {
    lines.push("", "Only modify these paths:", ...task.input.paths.map((item) => `- ${item}`));
  }
  lines.push(
    "",
    "Work only inside the current directory (an isolated git worktree on branch " +
      `${task.branch ?? `fleet/${task.id}`}). Do not commit, push, or switch branches: ` +
      "the dispatcher commits your changes and a human approves the diff.",
  );
  return lines.join("\n");
}

export class WorkerLauncher {
  private readonly active = new Map<string, ActiveRun>();
  private stopping = false;
  private scheduled = false;
  private pausedUntilMs = 0;
  private resumeTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(
    private readonly host: LauncherHost,
    private readonly options: WorkerLauncherOptions,
  ) {}

  runningIds(): string[] {
    return [...this.active.keys()].sort();
  }

  /** Hold every new launch until `untilMs` (epoch ms); running workers continue. */
  pauseUntil(untilMs: number): void {
    if (untilMs <= this.pausedUntilMs) return;
    this.pausedUntilMs = untilMs;
    if (this.resumeTimer !== null) clearTimeout(this.resumeTimer);
    this.resumeTimer = setTimeout(() => {
      this.resumeTimer = null;
      this.kick();
    }, Math.max(0, untilMs - Date.now()));
  }

  /** Epoch ms until which launches are held, or 0. */
  pausedUntil(): number {
    return this.pausedUntilMs > Date.now() ? this.pausedUntilMs : 0;
  }

  private roleFor(expert: string | undefined): RoleProfile | undefined {
    if (expert === undefined || this.options.rolesDir === undefined) return undefined;
    return loadRole(this.options.rolesDir, expert);
  }

  /** Scheduler caps with per-role `maxConcurrent` taking precedence over the configured per-expert cap. */
  private capsForTick(): ScheduleCaps {
    const base = this.options.caps;
    if (this.options.rolesDir === undefined) return base;
    const cache = new Map<string, number | undefined>();
    return {
      ...base,
      perExpert: (expert: string) => {
        if (!cache.has(expert)) {
          let cap: number | undefined;
          try {
            cap = this.roleFor(expert)?.maxConcurrent;
          } catch (err) {
            this.host.publish("role.invalid", { role: expert, error: (err as Error).message });
            cap = undefined;
          }
          cache.set(expert, cap);
        }
        return cache.get(expert) ?? base.perExpert?.(expert) ?? base.fleet;
      },
    };
  }

  /** Re-run scheduling soon (coalesced). Safe to call from any board mutation. */
  kick(): void {
    if (this.stopping || this.scheduled) return;
    this.scheduled = true;
    queueMicrotask(() => {
      this.scheduled = false;
      this.tick();
    });
  }

  private tick(): void {
    if (this.stopping) return;
    const tasks = this.host.listTasks();
    const plan = schedule(tasks, this.active.keys(), this.capsForTick());
    for (const id of plan.cancel) {
      this.host.updateTask(id, { status: "cancelled", reason: "a dependency can never succeed" });
    }
    for (const id of plan.ready) {
      const task = this.host.getTask(id);
      if (task !== undefined && (task.status === "pending" || task.status === "backlog")) {
        this.host.updateTask(id, { status: "ready" });
      }
    }
    const paused = this.pausedUntil() > 0;
    for (const id of plan.start) {
      const task = this.host.getTask(id);
      if (task === undefined) continue;
      if (task.kind === "human") {
        this.host.updateTask(id, { status: "waitingHuman", reason: "human gate" });
        continue;
      }
      if (paused) {
        if (task.status === "pending" || task.status === "backlog") {
          this.host.updateTask(id, { status: "ready", reason: "missions paused: model quota exhausted on every tier" });
        }
        continue;
      }
      this.launch(task);
    }
  }

  private launch(task: Task): void {
    const abort = new AbortController();
    const run: ActiveRun = { abort, conn: null, done: Promise.resolve() };
    this.active.set(task.id, run);
    this.host.updateTask(task.id, { status: "running", attempts: task.attempts + 1, reason: "worker starting" });
    run.done = this.execute(task.id, run)
      .catch((err: unknown) => {
        this.finish(task.id, "failure", `launcher error: ${(err as Error).message}`);
      })
      .finally(() => {
        this.active.delete(task.id);
        this.host.onRunSettled?.(task.id);
        this.kick();
      });
  }

  private ensureWorktree(task: Task): { dir: string; base: string } {
    const store = this.options.worktreeStore;
    const existing = store.get(task.id);
    const base = task.input.base ?? runGit(this.options.repoDir, ["rev-parse", "HEAD"]);
    if (existing !== undefined && existing.state === "allocated" && existsSync(existing.path)) {
      return { dir: existing.path, base };
    }
    if (existing !== undefined) {
      store.remove(task.id);
    }
    const record = allocateWorktree({
      repoDir: this.options.repoDir,
      treesDir: this.options.treesDir,
      taskId: task.id,
      base,
      store,
    });
    return { dir: record.path, base };
  }

  private async execute(taskId: string, run: ActiveRun): Promise<void> {
    const task = this.host.getTask(taskId);
    if (task === undefined) return;
    const { dir, base } = this.ensureWorktree(task);
    let role: RoleProfile | undefined;
    try {
      role = this.roleFor(task.expert);
    } catch (err) {
      this.finish(taskId, "failure", (err as Error).message);
      return;
    }
    if (role !== undefined) {
      installRoleConfig(role, dir);
      this.host.audit("worker.role", { taskId, role: role.id, skills: role.skills.length, config: role.configFile !== undefined });
    } else if (task.expert !== undefined && this.options.rolesDir !== undefined) {
      this.host.publish("role.missing", { taskId, role: task.expert });
    }
    const tier = this.host.activeTier?.();
    const modelName = tier === undefined ? undefined : this.options.tierModels?.[tier];
    const model = modelName === undefined ? undefined : parseModelRef(modelName);
    this.host.updateTask(taskId, {
      worktree: dir,
      branch: `fleet/${taskId}`,
      input: { ...task.input, base },
    });
    this.host.setStageGates(taskId, [
      { name: "precheck", status: "pass" },
      { name: "worker", status: "running" },
      { name: "verify", status: "pending" },
    ]);
    if (run.abort.signal.aborted) return;
    const conn = await openWorker({
      command: this.options.command,
      cwd: dir,
      stateDir: path.join(dir, ".opencode"),
      env: role === undefined ? this.options.env : { ...this.options.env, XDG_CONFIG_HOME: role.dir },
      startTimeoutMs: this.options.startTimeoutMs,
      clientFactory: this.options.clientFactory,
    });
    run.conn = conn;
    try {
      if (run.abort.signal.aborted) return;
      const current = this.host.getTask(taskId) ?? task;
      const session = await conn.client.createSession({
        directory: dir,
        agent: this.options.agent,
        title: current.title ?? taskId,
        model,
      });
      this.host.updateTask(taskId, { sessionId: session.id, reason: "worker running" });
      this.host.publish("worker.started", { taskId, sessionId: session.id, pid: conn.proc.pid, tier: tier ?? null, model: modelName ?? null });
      this.host.audit("worker.started", { taskId, sessionId: session.id, command: this.options.command[0], tier: tier ?? null, model: modelName ?? null });
      const toolNames = new Map<string, string>();
      const toolInputs = new Map<string, string>();
      const result = await runTurn(conn, session.id, taskPrompt(current, role), {
        timeoutMs: this.options.taskTimeoutMs ?? 30 * 60_000,
        signal: run.abort.signal,
        onEvent: (event) => this.relay(taskId, event, toolNames, toolInputs),
      });
      if (result.outcome === "aborted") return;
      if (result.outcome === "failed" && result.error !== undefined && this.requeueOnQuota(taskId, result.error) !== null) {
        return;
      }
      if (result.outcome !== "succeeded") {
        this.finish(taskId, "failure", result.error ?? result.outcome);
        return;
      }
      this.finish(taskId, "success", result.texts.at(-1) ?? "worker finished");
    } finally {
      await conn.close();
    }
  }

  private relay(taskId: string, event: WorkerEvent, names: Map<string, string>, inputs: Map<string, string>): void {
    const callId = typeof event.data["id"] === "string" ? (event.data["id"] as string) : "";
    switch (event.type) {
      case "session.tool.input.started": {
        const name = event.data["name"];
        if (typeof name === "string") names.set(callId, name);
        break;
      }
      case "session.tool.called": {
        inputs.set(callId, clip(JSON.stringify(event.data["input"] ?? {})));
        this.host.publish("worker.tool.called", { taskId, callId, tool: names.get(callId) ?? "tool" });
        break;
      }
      case "session.tool.success":
      case "session.tool.failed": {
        const tool = names.get(callId) ?? "tool";
        const output =
          event.type === "session.tool.success"
            ? contentText(event.data["content"])
            : `error: ${describeError(event.data["error"])}`;
        this.host.appendToolLog(taskId, { tool, input: inputs.get(callId) ?? "", output: clip(output) });
        break;
      }
      case "session.status": {
        const status = event.data["status"];
        const type = typeof status === "object" && status !== null ? (status as { type?: unknown }).type : undefined;
        this.host.publish("worker.status", { taskId, status: typeof type === "string" ? type : "unknown" });
        break;
      }
      case "session.text.ended": {
        const text = event.data["text"];
        if (typeof text === "string") this.host.publish("worker.text", { taskId, text: clip(text) });
        break;
      }
      default:
        break;
    }
  }

  /**
   * A quota-shaped provider failure is the model tier's fault, not the
   * task's: report it to the tier failover and put the task back in the
   * queue without spending an attempt. Returns the applied disposition,
   * or null for any other error (the caller fails the task).
   */
  private requeueOnQuota(taskId: string, error: string): ProviderDisposition | null {
    const failure: ProviderFailure = { message: error, code: error };
    if (this.host.reportProviderFailure === undefined || !isQuotaFailure(failure)) return null;
    const task = this.host.getTask(taskId);
    if (task === undefined || task.status !== "running") return null;
    const disposition = this.host.reportProviderFailure(failure);
    const reason =
      disposition.action === "route-fallback"
        ? `provider quota exhausted; re-queued on ${disposition.targetTier}`
        : disposition.action === "pause-missions"
          ? `provider quota exhausted on every tier; re-queued until missions resume`
          : `provider quota error; re-queued`;
    this.host.setStageGates(taskId, [
      { name: "precheck", status: "pass" },
      { name: "worker", status: "pending" },
      { name: "verify", status: "pending" },
    ]);
    this.host.updateTask(taskId, { status: "pending", attempts: Math.max(0, task.attempts - 1), reason });
    this.host.publish("worker.requeued", { taskId, reason, action: disposition.action });
    this.host.audit("worker.requeued", { taskId, error: clip(error), action: disposition.action });
    return disposition;
  }

  /** Commit worktree changes (never the isolated `.opencode` state) onto the task branch. */
  private commitWork(task: Task): boolean {
    const dir = task.worktree;
    if (dir === undefined || !existsSync(dir)) return false;
    runGit(dir, ["add", "-A", "--", ".", ":(exclude).opencode"]);
    const staged = runGit(dir, ["diff", "--cached", "--name-only"]);
    if (staged.length > 0) {
      runGit(dir, [
        "-c",
        "user.name=Fleet Worker",
        "-c",
        "user.email=fleet-worker@localhost",
        "commit",
        "--no-verify",
        "-m",
        `fleet(${task.id}): ${task.title ?? task.input.objective}`.slice(0, 200),
      ]);
    }
    const base = task.input.base ?? "HEAD";
    return runGit(this.options.repoDir, ["diff", "--name-only", `${base}...${task.branch ?? `fleet/${task.id}`}`]).length > 0;
  }

  private finish(taskId: string, outcome: "success" | "failure", detail: string): void {
    const task = this.host.getTask(taskId);
    if (task === undefined || task.status !== "running") return;
    let status: TaskStatus;
    let reason: string;
    if (outcome === "success") {
      let changed = false;
      try {
        changed = this.commitWork(task);
      } catch (err) {
        this.finish(taskId, "failure", `commit failed: ${(err as Error).message}`);
        return;
      }
      status = changed ? "waitingHuman" : "done";
      reason = changed ? "worker finished; diff awaits human approval" : "worker finished with no changes";
      this.host.setStageGates(taskId, [
        { name: "precheck", status: "pass" },
        { name: "worker", status: "pass" },
        { name: "verify", status: changed ? "pending" : "pass" },
      ]);
    } else {
      status = nextStatus(task, "failure");
      reason = `worker failed: ${detail}`.slice(0, 2000);
      this.host.setStageGates(taskId, [
        { name: "precheck", status: "pass" },
        { name: "worker", status: "fail" },
        { name: "verify", status: "pending" },
      ]);
    }
    this.host.updateTask(taskId, { status, reason });
    this.host.publish("worker.finished", { taskId, outcome, status, detail: clip(detail) });
    this.host.audit("worker.finished", { taskId, outcome, status });
    this.host.afterRun?.(taskId);
  }

  /** Abort every run, kill every worker, re-queue interrupted tasks. */
  async stop(): Promise<void> {
    this.stopping = true;
    if (this.resumeTimer !== null) clearTimeout(this.resumeTimer);
    this.resumeTimer = null;
    const runs = [...this.active.entries()];
    for (const [, run] of runs) run.abort.abort();
    await Promise.all(runs.map(async ([, run]) => run.conn?.close()));
    await Promise.all(runs.map(([, run]) => run.done));
    for (const [taskId] of runs) {
      const task = this.host.getTask(taskId);
      if (task?.status === "running") {
        this.host.updateTask(taskId, { status: "pending", reason: "dispatcher shut down; will resume" });
      }
    }
  }
}
