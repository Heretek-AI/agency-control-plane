/**
 * Bun HTTP + SSE control API for the Fleet Dispatcher Daemon.
 *
 * Serves loopback-only (`127.0.0.1`) JSON routes plus a ring-buffered
 * SSE stream, wiring the scheduler, worker launcher, Director session,
 * 3-tier limits, audit ledger, worktree register, SQLite board store,
 * event bus, and single-use approval tickets:
 *
 * - `GET /api/board` — Kanban columns, tasks, worktree statuses, the
 *   active model tier, DAG edges, Director chat, and the scheduler plan.
 * - `POST /api/director/message` — send a steering message to the
 *   long-lived Director worker session (202; the reply arrives as a
 *   `director.message` event). Task cards are created only from the
 *   Director's validated ```tasks block, or explicitly with `/ship`.
 * - `GET /api/tasks/:id/drilldown` — worker session metadata, stage
 *   gates, live tool-log buffer, git diff hunks, and the diff's subject hash.
 * - `POST /api/approvals/:taskId/ticket` — mint a single-use 60s-TTL
 *   ticket; the SERVER computes `subjectHash` from the task's diff and
 *   returns the exact es-core-compatible payloads to sign.
 * - `POST /api/approvals/:taskId/sign` — burn the ticket, recompute the
 *   diff hash, and verify the Ed25519 signature against the PINNED human
 *   key (`human.pub`) only. APPROVE lands `fleet/<taskId>` onto the
 *   mission's integration branch (`landing.ts`) and moves the task to
 *   `done` with its `landedSha`; a landing conflict keeps it
 *   `waitingHuman` (409, conflicting files listed). REJECT -> `failed`.
 *   Audit-chained with the full signed record.
 * - `GET /api/events` — SSE stream with `Last-Event-ID` replay.
 * - `GET /api/csrf` — issue the CSRF token POST routes require.
 * - `GET /*` — the built WebUI (`web/dist`) when `webDistDir` is set.
 *
 * Guards (fail-closed): non-loopback `Host` → 403; POST without a
 * matching `x-csrf-token` → 403; no pinned human key → 503 on approval
 * routes; unknown/expired/reused/mismatched tickets → 403; bad
 * signatures → 403; approving a task that is not `waitingHuman` → 409.
 *
 * Worktree lifecycle: a task reaching `done` / `failed` / `cancelled`
 * releases its worktree once no worker runs in it; `failed` and
 * `cancelled` branches are then salvaged to `refs/fleet-salvage/<id>`.
 */
import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, sep } from "node:path";
import { TicketError, TicketStore } from "./approval-tickets.js";
import { appendAudit, sha256Hex } from "./audit.js";
import { BoardStore, type StoredMessage } from "./board-store.js";
import { Director, parseDirectorReply, type DirectorTask } from "./director.js";
import { EventBus, gapToSSE, toSSE } from "./event-bus.js";
import {
  DISPATCHER_STAGES,
  loadHumanPublicKey,
  signedRecord,
  verifyPinnedApproval,
  type ApprovalPayload,
  type PinnedHumanKey,
} from "./human-key.js";
import { landTask, type LandResult } from "./landing.js";
import { classifyProviderFailure, type ModelTier, type ProviderDisposition, type ProviderFailure } from "./limits.js";
import { TaskSchema, TaskStatuses, type Task, type TaskStatus } from "./model.js";
import { attachBusToNats, type NatsJetStreamBridge } from "./nats-bridge.js";
import { DEFAULT_WORKER_COMMAND } from "./opencode-client.js";
import { schedule } from "./scheduler.js";
import { WorkerLauncher } from "./worker-launcher.js";
import type { WorkerClientFactory } from "./worker-session.js";
import {
  WorktreeStore,
  cleanupUnconfirmed,
  integrationBranch,
  releaseWorktree,
  runGit,
  salvageWorktree,
  type WorktreeState,
} from "./worktrees.js";

export const LOOPBACK_HOSTS: readonly string[] = ["127.0.0.1", "localhost", "::1"] as const;
export const CSRF_HEADER = "x-csrf-token";
export const SCHEDULER_FLEET_CAP = 4;
export const MAX_TASKS_PER_MESSAGE = 50;

/** Statuses after which a task never runs again: its worktree is released. */
const FINISHED: ReadonlySet<TaskStatus> = new Set<TaskStatus>(["done", "failed", "cancelled"]);

export type BoardColumn = "Backlog" | "Ready" | "In Progress" | "Waiting Approval / QA" | "Done";

export const BOARD_COLUMNS: readonly BoardColumn[] = [
  "Backlog",
  "Ready",
  "In Progress",
  "Waiting Approval / QA",
  "Done",
] as const;

export function columnFor(status: TaskStatus): BoardColumn {
  switch (status) {
    case "backlog":
    case "pending":
      return "Backlog";
    case "ready":
      return "Ready";
    case "running":
      return "In Progress";
    case "waitingHuman":
      return "Waiting Approval / QA";
    case "done":
    case "failed":
    case "cancelled":
      return "Done";
  }
}

export interface BoardColumnView {
  name: BoardColumn;
  taskIds: string[];
}

export interface WorktreeStatusView {
  taskId: string;
  branch: string;
  path: string;
  /** `released`: the task finished and its worktree was removed. */
  state: WorktreeState | "released";
}

export interface DagEdge {
  from: string;
  to: string;
}

export interface MissionView {
  id: string;
  objective: string;
  status: string;
  integrationBranch: string;
}

export type DirectorMessage = StoredMessage;

export interface BoardView {
  columns: BoardColumnView[];
  tasks: Task[];
  worktrees: WorktreeStatusView[];
  missions: MissionView[];
  messages: DirectorMessage[];
  activeTier: ModelTier;
  dagEdges: DagEdge[];
  plan: { start: string[]; ready: string[]; cancel: string[] };
  approvals: { available: boolean; reason: string | null; fingerprint: string | null };
  director: { available: boolean };
}

export interface StageGate {
  name: string;
  status: "pending" | "running" | "pass" | "fail";
}

export interface ToolLogEntry {
  seq: number;
  tool: string;
  input: string;
  output: string;
}

export interface DiffHunk {
  file: string;
  status: "added" | "modified" | "deleted" | "renamed";
  additions: number;
  deletions: number;
  patch: string;
}

export interface DrilldownView {
  task: Task;
  session: { sessionId: string; status: TaskStatus; tier: ModelTier };
  stageGates: StageGate[];
  toolLog: ToolLogEntry[];
  diffs: DiffHunk[];
  /** SHA-256 of the concatenated diff patches: what an approval signs. */
  subjectHash: string;
}

export interface UpsertTaskInput {
  id: string;
  status: TaskStatus;
  missionId?: string | undefined;
  title?: string | undefined;
  kind?: Task["kind"] | undefined;
  expert?: string | undefined;
  deps?: string[] | undefined;
  strategy?: Task["strategy"] | undefined;
  paths?: string[] | undefined;
  owner?: string[] | undefined;
  attempts?: number | undefined;
  branch?: string | undefined;
  worktree?: string | undefined;
  sessionId?: string | undefined;
  objective?: string | undefined;
  context?: string | undefined;
  acceptance?: string[] | undefined;
  base?: string | undefined;
}

export interface WorkerConfig {
  /** Worker server command; defaults to `opencode serve --port 0 --hostname 127.0.0.1`. */
  command?: readonly string[] | undefined;
  /** OpenCode agent for task sessions (server default when omitted). */
  agent?: string | undefined;
  startTimeoutMs?: number | undefined;
  taskTimeoutMs?: number | undefined;
  perExpertCap?: number | undefined;
  /** Role packs for `expert` tasks (`<rolesDir>/<role-id>/`, see `roles.ts`). */
  rolesDir?: string | undefined;
  /** `provider/model` per model tier; tier failover switches new sessions to the next tier's model. */
  tierModels?: Partial<Record<ModelTier, string>> | undefined;
  env?: Record<string, string | undefined> | undefined;
  clientFactory?: WorkerClientFactory | undefined;
}

export interface DirectorConfig {
  /** Director server command; defaults to the worker command. */
  command?: readonly string[] | undefined;
  /** OpenCode agent for the Director session (default `director`). */
  agent?: string | undefined;
  startTimeoutMs?: number | undefined;
  replyTimeoutMs?: number | undefined;
  env?: Record<string, string | undefined> | undefined;
  clientFactory?: WorkerClientFactory | undefined;
}

export interface CreateServerOptions {
  auditLogPath?: string | undefined;
  csrfToken?: string | undefined;
  eventCapacity?: number | undefined;
  /** Repository the fleet works on. Required for worktrees, workers, diffs and the Director. */
  repoDir?: string | undefined;
  clock?: (() => number) | undefined;
  /** Durable state directory: SQLite board + worktree register, audit log, default `human.pub`. */
  stateDir?: string | undefined;
  /** Pinned human public key (es-core `human.pub` format). Default `<stateDir>/human.pub`. */
  humanPublicKeyPath?: string | undefined;
  /** Where task worktrees live. Default `<stateDir>/worktrees`. */
  treesDir?: string | undefined;
  /** Serve the built WebUI from this directory on the same origin. */
  webDistDir?: string | undefined;
  /** Fleet-wide cap on concurrently running workers. */
  fleetCap?: number | undefined;
  /** Worker launcher config; enabled when `repoDir` and `stateDir` are set, unless `false`. */
  workers?: WorkerConfig | false | undefined;
  /** Director config; enabled when `repoDir` and `stateDir` are set, unless `false`. */
  director?: DirectorConfig | false | undefined;
}

export interface FleetServer {
  fetch: (req: Request) => Promise<Response>;
  readonly csrfToken: string;
  readonly tickets: TicketStore;
  readonly bus: EventBus;
  getBoard(): BoardView;
  getTask(id: string): Task | undefined;
  upsertTask(input: UpsertTaskInput): Task;
  setTier(tier: ModelTier): void;
  /** `sessionTier`: the tier the failing session ran on; a failure from a tier already left behind changes nothing. */
  reportProviderFailure(failure: ProviderFailure, sessionTier?: ModelTier): ProviderDisposition;
  reportProviderSuccess(): void;
  consecutiveFailures(): number;
  updateTask(id: string, patch: Partial<Task>): Task;
  appendToolLog(taskId: string, entry: { tool: string; input: string; output: string }): ToolLogEntry;
  setStageGates(taskId: string, gates: StageGate[]): void;
  recordDiff(taskId: string, hunks: DiffHunk[]): void;
  attachWorktreeStore(store: WorktreeStore): void;
  /** Diff hunks and the subject hash an approval of this task must sign. */
  subjectFor(taskId: string): { hunks: DiffHunk[]; subjectHash: string };
  /** The pinned human key, or null when approvals are unavailable (fail closed). */
  readonly humanKey: PinnedHumanKey | null;
  readonly approvalsUnavailableReason: string | null;
  /** Ids of tasks with a live worker. */
  runningWorkers(): string[];
  /** Resolves when every queued Director turn has been applied to the board. */
  directorIdle(): Promise<void>;
  /** Mirror bus events and board documents into NATS JetStream / KV. */
  attachNats(bridge: NatsJetStreamBridge): void;
  /** Kill workers + Director, re-queue interrupted tasks, close stores. */
  shutdown(): Promise<void>;
}

interface SessionState {
  stageGates: StageGate[];
  toolLog: ToolLogEntry[];
  diffs: DiffHunk[];
}

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json", "cache-control": "no-store" },
  });
}

function fail(status: number, error: string, extra?: Record<string, unknown>): Response {
  return json({ error, ...(extra ?? {}) }, status);
}

function defaultAuditLogPath(): string {
  return join(mkdtempSync(join(tmpdir(), "agency-audit-")), "audit.jsonl");
}

/** The subject hash of a diff: SHA-256 hex of the concatenated per-file patches, in order. */
export function subjectHashForHunks(hunks: readonly DiffHunk[]): string {
  return sha256Hex(hunks.map((hunk) => hunk.patch).join(""));
}

/** Content-Security-Policy for the served WebUI (same-origin only). */
export const WEB_CSP =
  "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; " +
  "connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'";

const STATIC_TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".map": "application/json",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".json": "application/json",
  ".txt": "text/plain; charset=utf-8",
};

/** Serve one file of the built WebUI, refusing anything outside `distDir`. Unknown extensionless paths get `index.html`. */
export function serveStatic(distDir: string, pathname: string): Response | null {
  const root = resolve(distDir);
  let decoded: string;
  try {
    decoded = decodeURIComponent(pathname);
  } catch {
    return null;
  }
  if (decoded.includes("\0")) return null;
  const relative = decoded === "/" ? "index.html" : decoded.replace(/^\/+/, "");
  let file = resolve(root, relative);
  if (file !== root && !file.startsWith(root + sep)) return null;
  const extOf = (value: string): string => {
    const base = value.slice(value.lastIndexOf("/") + 1);
    const dot = base.lastIndexOf(".");
    return dot <= 0 ? "" : base.slice(dot).toLowerCase();
  };
  let exists = existsSync(file) && statSync(file).isFile();
  if (!exists && extOf(relative) === "") {
    file = join(root, "index.html");
    exists = existsSync(file);
  }
  if (!exists) return null;
  const ext = extOf(file);
  return new Response(Bun.file(file), {
    headers: {
      "content-type": STATIC_TYPES[ext] ?? "application/octet-stream",
      "content-security-policy": WEB_CSP,
      "x-content-type-options": "nosniff",
      "referrer-policy": "no-referrer",
      "cache-control": ext === ".html" ? "no-cache" : "public, max-age=31536000, immutable",
    },
  });
}

/** Parse `git diff` output into per-file hunks with addition/deletion counters. */
export function parseDiffPatch(patch: string): DiffHunk[] {
  const hunks: DiffHunk[] = [];
  const blocks = patch.split(/^diff --git /m).filter((block) => block.trim().length > 0);
  for (const block of blocks) {
    const fullPatch = `diff --git ${block}`;
    const lines = block.split("\n");
    const header = lines[0] ?? "";
    const headerMatch = /^a\/(.+?) b\/(.+?)\s*$/.exec(header);
    if (headerMatch === null) {
      continue;
    }
    const fromPath = headerMatch[1] ?? "";
    const toPath = headerMatch[2] ?? "";
    let file = toPath;
    let status: DiffHunk["status"] = "modified";
    for (const line of lines) {
      if (line.startsWith("new file mode")) {
        status = "added";
      } else if (line.startsWith("deleted file mode")) {
        status = "deleted";
      } else if (line.startsWith("rename from ")) {
        status = "renamed";
      }
    }
    if (status === "deleted") {
      file = fromPath;
    }
    let additions = 0;
    let deletions = 0;
    for (const line of lines) {
      if (line.startsWith("+") && !line.startsWith("+++")) additions += 1;
      else if (line.startsWith("-") && !line.startsWith("---")) deletions += 1;
    }
    hunks.push({ file, status, additions, deletions, patch: fullPatch });
  }
  return hunks;
}

/**
 * Text of a markdown bullet line (`- x`, `* x`, `1. x`), or null. Linear
 * string scanning only: no backtracking regex over untrusted chat input.
 */
export function bulletText(line: string): string | null {
  const trimmed = line.trim();
  let rest: string | null = null;
  if (trimmed.startsWith("- ") || trimmed.startsWith("* ")) {
    rest = trimmed.slice(2);
  } else {
    let digits = 0;
    while (digits < trimmed.length && trimmed.charCodeAt(digits) >= 48 && trimmed.charCodeAt(digits) <= 57) digits += 1;
    if (digits > 0 && trimmed[digits] === "." && (trimmed[digits + 1] === " " || trimmed[digits + 1] === "\t")) {
      rest = trimmed.slice(digits + 2);
    }
  }
  if (rest === null) return null;
  const text = rest.trim();
  return text.length > 0 ? text : null;
}

/** Titles decomposed from a `/ship` spec: bullets first, else the spec's first line. */
export function decomposeMessage(message: string): string[] {
  const titles: string[] = [];
  for (const line of message.split("\n")) {
    const bullet = bulletText(line);
    if (bullet !== null) titles.push(bullet);
  }
  if (titles.length > 0) {
    return titles;
  }
  const first = message.split("\n")[0]?.trim() ?? "";
  return [first.length > 80 ? `${first.slice(0, 77)}...` : first];
}

export function createServer(options: CreateServerOptions = {}): FleetServer {
  const stateDir = options.stateDir === undefined ? undefined : resolve(options.stateDir);
  if (stateDir !== undefined) mkdirSync(stateDir, { recursive: true });
  const auditLogPath = options.auditLogPath ?? (stateDir !== undefined ? join(stateDir, "audit.jsonl") : defaultAuditLogPath());
  const csrfToken = options.csrfToken ?? randomBytes(16).toString("hex");
  const clock = options.clock ?? Date.now;
  const bus = new EventBus(options.eventCapacity ?? 1000);
  const tickets = new TicketStore(clock);
  const repoDir = options.repoDir === undefined ? undefined : resolve(options.repoDir);
  const fleetCap = options.fleetCap ?? SCHEDULER_FLEET_CAP;

  // Pinned human key: approvals fail closed (503) without one.
  const humanKeyPath = options.humanPublicKeyPath ?? (stateDir !== undefined ? join(stateDir, "human.pub") : undefined);
  let humanKey: PinnedHumanKey | null = null;
  let approvalsUnavailableReason: string | null = null;
  if (humanKeyPath === undefined) {
    approvalsUnavailableReason = "no human public key configured (set humanPublicKeyPath or stateDir)";
  } else {
    try {
      humanKey = loadHumanPublicKey(humanKeyPath);
    } catch (err) {
      approvalsUnavailableReason = (err as Error).message;
    }
  }

  const tasks = new Map<string, Task>();
  const sessions = new Map<string, SessionState>();
  const messages: DirectorMessage[] = [];
  const missions = new Map<string, MissionView>();
  let messageSeq = 0;
  let taskSeq = 0;
  let activeTier: ModelTier = "tier-1-opencode";
  let failures = 0;
  let worktreeStore: WorktreeStore | null = null;
  let natsBridge: NatsJetStreamBridge | null = null;
  let detachNats: (() => void) | null = null;
  // Landings onto shared integration branches run one at a time.
  let landingQueue: Promise<unknown> = Promise.resolve();

  const boardStore = stateDir !== undefined ? new BoardStore(join(stateDir, "dispatcher.db")) : null;

  function persistTask(task: Task): void {
    boardStore?.saveTask(task);
    if (natsBridge !== null) {
      natsBridge.put(task.id, task).catch((err: unknown) => {
        bus.publish("nats.error", { taskId: task.id, error: (err as Error).message });
      });
    }
  }

  function persistSession(taskId: string): void {
    const session = sessions.get(taskId);
    if (session !== undefined) boardStore?.saveSession(taskId, { stageGates: session.stageGates, toolLog: session.toolLog });
  }

  function saveMission(mission: MissionView): void {
    missions.set(mission.id, mission);
    boardStore?.saveMission(mission);
  }

  // Restore durable board state. Tasks that were running when the previous
  // process died have no worker any more: re-queue them.
  if (boardStore !== null) {
    const snapshot = boardStore.load();
    for (const mission of snapshot.missions) missions.set(mission.id, mission);
    for (const message of snapshot.messages) messages.push(message);
    for (const [taskId, session] of snapshot.sessions) {
      sessions.set(taskId, { stageGates: session.stageGates, toolLog: session.toolLog, diffs: [] });
    }
    for (const task of snapshot.tasks) {
      if (task.status === TaskStatuses.running) {
        const requeued: Task = { ...task, status: TaskStatuses.pending, reason: "dispatcher restarted while running; re-queued" };
        tasks.set(task.id, requeued);
        boardStore.saveTask(requeued);
      } else {
        tasks.set(task.id, task);
      }
    }
    messageSeq = snapshot.counters.get("messageSeq") ?? messages.at(-1)?.seq ?? 0;
    taskSeq = snapshot.counters.get("taskSeq") ?? 0;
  }

  if (!missions.has("mission-1")) {
    saveMission({
      id: "mission-1",
      objective: "Fleet mission",
      status: "running",
      integrationBranch: "fleet/integration/mission-1",
    });
  }

  function audit(event: string, data: unknown): void {
    appendAudit(auditLogPath, event, data);
  }

  function sessionFor(taskId: string): SessionState {
    let session = sessions.get(taskId);
    if (session === undefined) {
      session = {
        stageGates: [
          { name: "precheck", status: "pending" },
          { name: "verify", status: "pending" },
        ],
        toolLog: [],
        diffs: [],
      };
      sessions.set(taskId, session);
    }
    return session;
  }

  function nextTaskId(): string {
    let id: string;
    do {
      taskSeq += 1;
      id = `task-${taskSeq}`;
    } while (tasks.has(id));
    boardStore?.setCounter("taskSeq", taskSeq);
    return id;
  }

  function ensureMission(missionId: string): void {
    if (!missions.has(missionId)) {
      saveMission({
        id: missionId,
        objective: missionId,
        status: "running",
        integrationBranch: `fleet/integration/${missionId}`,
      });
    }
  }

  // Launcher + Director are wired after the task helpers below exist.
  let launcher: WorkerLauncher | null = null;
  let director: Director | null = null;

  function storeTask(task: Task): Task {
    tasks.set(task.id, task);
    sessionFor(task.id);
    ensureMission(task.missionId);
    persistTask(task);
    launcher?.kick();
    return task;
  }

  function upsertTask(input: UpsertTaskInput): Task {
    const existing = tasks.get(input.id);
    const objective = input.objective ?? existing?.input.objective ?? input.title ?? input.id;
    const raw = {
      ...(existing ?? {}),
      id: input.id,
      missionId: input.missionId ?? existing?.missionId ?? "mission-1",
      title: input.title ?? existing?.title ?? input.id,
      kind: input.kind ?? existing?.kind ?? "expert-run",
      expert: input.expert ?? existing?.expert,
      deps: input.deps ?? existing?.deps ?? [],
      strategy: input.strategy ?? existing?.strategy ?? "all_success",
      input: {
        ...(existing?.input ?? {}),
        objective,
        context: input.context ?? existing?.input.context,
        acceptance: input.acceptance ?? existing?.input.acceptance ?? [],
        paths: input.paths ?? existing?.input.paths ?? [],
        base: input.base ?? existing?.input.base,
      },
      owner: input.owner ?? existing?.owner ?? input.paths ?? [],
      policy: existing?.policy ?? { strategy: "fail" },
      status: input.status,
      attempts: input.attempts ?? existing?.attempts ?? 0,
      branch: input.branch ?? existing?.branch ?? `fleet/${input.id}`,
      worktree: input.worktree ?? existing?.worktree,
      sessionId: input.sessionId ?? existing?.sessionId ?? `sess-${input.id}`,
    };
    return storeTask(TaskSchema.parse(raw));
  }

  function updateTask(id: string, patch: Partial<Task>): Task {
    const existing = tasks.get(id);
    if (existing === undefined) {
      throw new Error(`cannot update task ${JSON.stringify(id)}: not found`);
    }
    const task = TaskSchema.parse({ ...existing, ...patch, id });
    storeTask(task);
    if (task.status !== existing.status) {
      bus.publish("task.updated", { taskId: id, status: task.status, reason: task.reason ?? null });
      releaseIfFinished(id);
    }
    return task;
  }

  /**
   * Release a finished task's worktree, then salvage the branch of a task
   * that did not succeed. Never throws: failures are audited and published
   * so a stuck worktree cannot wedge a status change.
   */
  function releaseIfFinished(taskId: string): void {
    const task = tasks.get(taskId);
    if (repoDir === undefined || worktreeStore === null || task === undefined || !FINISHED.has(task.status)) return;
    if (!/^[a-z0-9][a-z0-9-]*$/.test(taskId)) return;
    // A worker still running in the tree: released when its run settles.
    if (launcher?.runningIds().includes(taskId) === true) return;
    const store = worktreeStore;
    const record = store.get(taskId);
    try {
      if (record !== undefined && record.state !== "salvage") {
        try {
          releaseWorktree({ repoDir, taskId, store });
        } catch (err) {
          if (existsSync(record.path)) throw err;
          // The directory is already gone: drop the stale registration.
          runGit(repoDir, ["worktree", "prune"]);
          store.remove(taskId);
        }
        audit("worktree.released", { taskId, path: record.path, status: task.status });
        bus.publish("worktree.released", { taskId, status: task.status });
      }
      if (task.status !== TaskStatuses.done) {
        const salvaged = salvageWorktree({ repoDir, taskId, store });
        if (salvaged !== undefined) {
          audit("worktree.salvaged", { taskId, ref: salvaged.ref, tip: salvaged.tip });
          bus.publish("worktree.salvaged", { taskId, ref: salvaged.ref, tip: salvaged.tip });
        }
      }
    } catch (err) {
      audit("worktree.release-failed", { taskId, error: (err as Error).message });
      bus.publish("worktree.release-failed", { taskId, error: (err as Error).message });
    }
  }

  function reportProviderFailure(failure: ProviderFailure, sessionTier: ModelTier = activeTier): ProviderDisposition {
    // Concurrent workers on the old tier report the same exhaustion: count it once.
    if (sessionTier !== activeTier) {
      return { action: "route-fallback", targetTier: activeTier };
    }
    failures += 1;
    const disposition = classifyProviderFailure(failure, failures, activeTier);
    if (disposition.action === "route-fallback") {
      activeTier = disposition.targetTier;
      failures = 0;
      audit("tier.fallback", { targetTier: activeTier });
      bus.publish("tier.fallback", { targetTier: activeTier });
    } else if (disposition.action === "pause-missions") {
      const resumeAtMs = Date.now() + disposition.resumeAfterMs;
      launcher?.pauseUntil(resumeAtMs);
      audit("missions.paused", { reason: disposition.reason, resumeAtMs });
      bus.publish("missions.paused", { reason: disposition.reason, resumeAtMs });
    } else {
      bus.publish("provider.retry", { action: disposition.action, delayMs: disposition.delayMs });
    }
    return disposition;
  }

  function getBoard(): BoardView {
    const all = [...tasks.values()].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
    const columns: BoardColumnView[] = BOARD_COLUMNS.map((name) => ({ name, taskIds: [] }));
    for (const task of all) {
      const column = columns.find((entry) => entry.name === columnFor(task.status));
      column?.taskIds.push(task.id);
    }
    const worktrees: WorktreeStatusView[] = [];
    for (const task of all) {
      if (task.branch === undefined && task.worktree === undefined) {
        continue;
      }
      const stored = worktreeStore?.get(task.id);
      worktrees.push({
        taskId: task.id,
        branch: stored?.branch ?? task.branch ?? `fleet/${task.id}`,
        path: stored?.path ?? task.worktree ?? "",
        state: stored?.state ?? (FINISHED.has(task.status) && task.worktree !== undefined ? "released" : "allocated"),
      });
    }
    const dagEdges: DagEdge[] = [];
    for (const task of all) {
      for (const dep of task.deps) {
        dagEdges.push({ from: dep, to: task.id });
      }
    }
    const runningIds = all.filter((task) => task.status === TaskStatuses.running).map((task) => task.id);
    const plan = schedule(all, runningIds, { fleet: fleetCap });
    return {
      columns,
      tasks: all,
      worktrees,
      missions: [...missions.values()],
      messages: [...messages],
      activeTier,
      dagEdges,
      plan,
      approvals: {
        available: humanKey !== null,
        reason: approvalsUnavailableReason,
        fingerprint: humanKey?.fingerprint ?? null,
      },
      director: { available: director !== null },
    };
  }

  function diffsFor(task: Task): DiffHunk[] {
    const recorded = sessions.get(task.id)?.diffs ?? [];
    if (repoDir === undefined || task.branch === undefined) {
      return recorded;
    }
    try {
      const base = task.input.base ?? "HEAD";
      const patch = runGit(repoDir, ["diff", "--no-color", "--find-renames", `${base}...${task.branch}`]);
      if (patch.trim().length === 0) {
        return recorded;
      }
      return parseDiffPatch(patch);
    } catch {
      return recorded;
    }
  }

  function subjectFor(taskId: string): { hunks: DiffHunk[]; subjectHash: string } {
    const task = tasks.get(taskId);
    if (task === undefined) {
      throw new Error(`task ${JSON.stringify(taskId)} not found`);
    }
    const hunks = diffsFor(task);
    return { hunks, subjectHash: subjectHashForHunks(hunks) };
  }

  function appendToolLog(taskId: string, entry: { tool: string; input: string; output: string }): ToolLogEntry {
    if (!tasks.has(taskId)) {
      throw new Error(`cannot append tool log: task ${JSON.stringify(taskId)} not found`);
    }
    const session = sessionFor(taskId);
    const logged: ToolLogEntry = {
      seq: (session.toolLog.at(-1)?.seq ?? 0) + 1,
      tool: entry.tool,
      input: entry.input,
      output: entry.output,
    };
    session.toolLog.push(logged);
    if (session.toolLog.length > 500) session.toolLog.splice(0, session.toolLog.length - 500);
    persistSession(taskId);
    bus.publish("worker.tool", { taskId, seq: logged.seq, tool: logged.tool, input: logged.input, output: logged.output });
    return logged;
  }

  function setStageGates(taskId: string, gates: StageGate[]): void {
    if (!tasks.has(taskId)) {
      throw new Error(`cannot set stage gates: task ${JSON.stringify(taskId)} not found`);
    }
    sessionFor(taskId).stageGates = gates;
    persistSession(taskId);
    bus.publish("worker.gates", { taskId, gates });
  }

  function appendMessage(author: string, text: string, tasksCreated?: string[]): DirectorMessage {
    messageSeq += 1;
    const message: DirectorMessage = {
      seq: messageSeq,
      author,
      text,
      timestamp: new Date(clock()).toISOString(),
      ...(tasksCreated !== undefined && tasksCreated.length > 0 ? { tasksCreated } : {}),
    };
    messages.push(message);
    boardStore?.saveMessage(message);
    boardStore?.setCounter("messageSeq", messageSeq);
    bus.publish("director.message", { seq: message.seq, author, tasksCreated: tasksCreated ?? [] });
    return message;
  }

  function createDirectorTasks(specs: DirectorTask[], missionId: string): string[] {
    const keyToId = new Map<string, string>();
    const ids = specs.map((spec) => {
      const id = nextTaskId();
      if (spec.key !== undefined) keyToId.set(spec.key, id);
      return id;
    });
    specs.forEach((spec, index) => {
      const id = ids[index]!;
      upsertTask({
        id,
        missionId,
        title: spec.title,
        objective: spec.objective ?? spec.title,
        context: spec.context,
        acceptance: spec.acceptance,
        kind: spec.kind,
        expert: spec.expert,
        deps: spec.deps.map((dep) => keyToId.get(dep) ?? dep),
        paths: spec.paths,
        owner: spec.paths,
        status: "pending",
      });
    });
    return ids;
  }

  // Worker launcher + Director need a repository and durable state.
  if (repoDir !== undefined && stateDir !== undefined) {
    worktreeStore = new WorktreeStore(join(stateDir, "dispatcher.db"));
    cleanupUnconfirmed({ repoDir, store: worktreeStore });
    const workerCommand = options.workers === false ? DEFAULT_WORKER_COMMAND : (options.workers?.command ?? DEFAULT_WORKER_COMMAND);
    if (options.workers !== false) {
      const workerConfig = options.workers ?? {};
      const perExpertCap = workerConfig.perExpertCap;
      launcher = new WorkerLauncher(
        {
          listTasks: () => [...tasks.values()],
          getTask: (id) => tasks.get(id),
          updateTask,
          appendToolLog: (taskId, entry) => {
            appendToolLog(taskId, entry);
          },
          setStageGates,
          publish: (type, data) => {
            bus.publish(type, data);
          },
          audit,
          onRunSettled: releaseIfFinished,
          activeTier: () => activeTier,
          reportProviderFailure,
        },
        {
          repoDir,
          treesDir: resolve(options.treesDir ?? join(stateDir, "worktrees")),
          worktreeStore,
          command: workerCommand,
          caps: perExpertCap === undefined ? { fleet: fleetCap } : { fleet: fleetCap, perExpert: () => perExpertCap },
          agent: workerConfig.agent,
          rolesDir: workerConfig.rolesDir === undefined ? undefined : resolve(workerConfig.rolesDir),
          tierModels: workerConfig.tierModels,
          startTimeoutMs: workerConfig.startTimeoutMs,
          taskTimeoutMs: workerConfig.taskTimeoutMs,
          env: workerConfig.env,
          clientFactory: workerConfig.clientFactory,
        },
      );
    }
    if (options.director !== false) {
      const directorConfig = options.director ?? {};
      const directorState = join(stateDir, "director", ".opencode");
      mkdirSync(directorState, { recursive: true });
      director = new Director({
        command: directorConfig.command ?? workerCommand,
        cwd: repoDir,
        stateDir: directorState,
        agent: directorConfig.agent ?? "director",
        startTimeoutMs: directorConfig.startTimeoutMs,
        replyTimeoutMs: directorConfig.replyTimeoutMs,
        env: directorConfig.env,
        clientFactory: directorConfig.clientFactory,
      });
    }
  }

  // Finished tasks whose worktree outlived the previous process.
  if (worktreeStore !== null) {
    for (const record of worktreeStore.list()) releaseIfFinished(record.taskId);
  }

  function handleEvents(req: Request): Response {
    const url = new URL(req.url);
    const headerId = req.headers.get("last-event-id");
    const queryId = url.searchParams.get("lastEventId") ?? url.searchParams.get("last-event-id");
    const raw = headerId ?? queryId ?? undefined;
    let fromSeq = 1;
    if (raw !== undefined) {
      const last = Number(raw);
      fromSeq = Number.isInteger(last) && last >= 0 ? last + 1 : 1;
    }
    const replay = bus.replaySince(fromSeq);
    if (url.searchParams.get("snapshot") === "1") {
      let body = "";
      if (replay.gap !== null) {
        body += gapToSSE(replay.gap);
      }
      for (const event of replay.events) {
        body += toSSE(event);
      }
      return new Response(body, {
        headers: { "content-type": "text/event-stream", "cache-control": "no-cache" },
      });
    }
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        const encoder = new TextEncoder();
        const write = (text: string): void => {
          controller.enqueue(encoder.encode(text));
        };
        if (replay.gap !== null) {
          write(gapToSSE(replay.gap));
        }
        for (const event of replay.events) {
          write(toSSE(event));
        }
        write(": connected\n\n");
        const liveFrom = bus.tipSeq() + 1;
        const subscription = bus.subscribe(liveFrom, (event) => {
          try {
            write(toSSE(event));
          } catch {
            subscription.unsubscribe();
          }
        });
        const heartbeat: ReturnType<typeof setInterval> = setInterval(() => {
          try {
            write(": ping\n\n");
          } catch {
            clearInterval(heartbeat);
            subscription.unsubscribe();
          }
        }, 15000);
        const cleanup = (): void => {
          clearInterval(heartbeat);
          subscription.unsubscribe();
          try {
            controller.close();
          } catch {
            return;
          }
        };
        req.signal.addEventListener("abort", cleanup, { once: true });
      },
      cancel() {
        return;
      },
    });
    return new Response(stream, {
      headers: {
        "content-type": "text/event-stream",
        "cache-control": "no-cache",
        connection: "keep-alive",
      },
    });
  }

  async function readJson(req: Request): Promise<Record<string, unknown> | null> {
    try {
      const body = (await req.json()) as unknown;
      return typeof body === "object" && body !== null && !Array.isArray(body) ? (body as Record<string, unknown>) : null;
    } catch {
      return null;
    }
  }

  async function handleDirectorMessage(req: Request): Promise<Response> {
    const record = await readJson(req);
    if (record === null) {
      return fail(400, "request body must be a JSON object");
    }
    if (typeof record["message"] !== "string" || record["message"].trim().length === 0) {
      return fail(400, "message must be a non-empty string");
    }
    const text = record["message"];
    if (text.length > 20_000) {
      return fail(400, "message is longer than 20000 characters");
    }
    const missionId =
      typeof record["missionId"] === "string" && /^[a-z0-9][a-z0-9-]*$/.test(record["missionId"]) ? record["missionId"] : "mission-1";
    const trimmedText = text.trim();
    const isShip = trimmedText === "/ship" || trimmedText.startsWith("/ship ") || trimmedText.startsWith("/ship\n");
    if (isShip) {
      // Explicit fallback: the human decomposes the spec themselves.
      const spec = trimmedText.slice("/ship".length).trim();
      if (spec.length === 0) {
        return fail(400, "/ship needs a mission spec");
      }
      const titles = decomposeMessage(spec);
      if (titles.length > MAX_TASKS_PER_MESSAGE) {
        return fail(400, `message decomposes into ${titles.length} tasks, limit is ${MAX_TASKS_PER_MESSAGE}`);
      }
      const created = titles.map(() => nextTaskId());
      created.forEach((id, index) => {
        upsertTask({ id, missionId, title: titles[index]!, kind: "expert-run", status: "pending" });
      });
      const message = appendMessage("human", text, created);
      audit("director.ship", { seq: message.seq, missionId, tasksCreated: created });
      return json({ message, tasksCreated: created, mode: "ship" }, 200);
    }
    if (director === null) {
      return fail(503, "no Director worker is configured (needs repoDir + stateDir); use /ship <spec> to create cards directly");
    }
    const message = appendMessage("human", text);
    audit("director.message", { seq: message.seq, missionId });
    const activeDirector = director;
    void activeDirector.send(text).then((turn) => {
      if (!turn.ok) {
        if (turn.reply.length > 0) appendMessage("director", turn.reply);
        appendMessage("system", `Director turn failed: ${turn.error ?? "unknown error"}`);
        return;
      }
      const parsed = parseDirectorReply(turn.reply, new Set(tasks.keys()));
      if (!parsed.ok) {
        appendMessage("director", parsed.text.length > 0 ? parsed.text : turn.reply);
        appendMessage("system", `No cards created: ${parsed.error}`);
        audit("director.tasks-rejected", { replyTo: message.seq, error: parsed.error });
        return;
      }
      const created = parsed.tasks.length > 0 ? createDirectorTasks(parsed.tasks, missionId) : [];
      const reply = appendMessage("director", parsed.text.length > 0 ? parsed.text : "(tasks only)", created);
      audit("director.reply", { seq: reply.seq, replyTo: message.seq, missionId, tasksCreated: created });
    }).catch((err: unknown) => {
      try {
        appendMessage("system", `Director reply could not be applied: ${(err as Error).message}`);
        audit("director.reply-failed", { replyTo: message.seq, error: (err as Error).message });
      } catch {
        // store closed during shutdown
      }
    });
    return json({ message, pending: true }, 202);
  }

  function handleDrilldown(taskId: string): Response {
    const task = tasks.get(taskId);
    if (task === undefined) {
      return fail(404, `task ${JSON.stringify(taskId)} not found`);
    }
    const session = sessionFor(taskId);
    const { hunks, subjectHash } = subjectFor(taskId);
    const view: DrilldownView = {
      task,
      session: { sessionId: task.sessionId ?? `sess-${task.id}`, status: task.status, tier: activeTier },
      stageGates: session.stageGates,
      toolLog: session.toolLog,
      diffs: hunks,
      subjectHash,
    };
    return json(view, 200);
  }

  function approvalPayload(taskId: string, approve: boolean, subjectHash: string, timestamp: string): ApprovalPayload {
    return {
      runId: taskId,
      stage: approve ? DISPATCHER_STAGES.approve : DISPATCHER_STAGES.reject,
      subjectHash,
      timestamp,
    };
  }

  function handleMintTicket(taskId: string): Response {
    if (humanKey === null) {
      return fail(503, `approvals unavailable: ${approvalsUnavailableReason ?? "no pinned human key"}`);
    }
    const task = tasks.get(taskId);
    if (task === undefined) {
      return fail(404, `task ${JSON.stringify(taskId)} not found`);
    }
    if (task.status !== TaskStatuses.waitingHuman) {
      return fail(409, `task ${JSON.stringify(taskId)} is ${task.status}, only waitingHuman tasks can be approved`);
    }
    // The server, never the client, decides what is being approved.
    const { hunks, subjectHash } = subjectFor(taskId);
    const minted = tickets.mintTicket(taskId, subjectHash);
    audit("approval.ticket-minted", { taskId, subjectHash, timestamp: minted.timestamp });
    return json(
      {
        ticket: minted.token,
        taskId,
        subjectHash,
        timestamp: minted.timestamp,
        expiresAtMs: minted.expiresAtMs,
        keyFingerprint: humanKey.fingerprint,
        publicKeyHex: humanKey.publicKeyHex,
        payloads: {
          approve: approvalPayload(taskId, true, subjectHash, minted.timestamp),
          reject: approvalPayload(taskId, false, subjectHash, minted.timestamp),
        },
        diff: {
          files: hunks.length,
          additions: hunks.reduce((sum, hunk) => sum + hunk.additions, 0),
          deletions: hunks.reduce((sum, hunk) => sum + hunk.deletions, 0),
        },
      },
      200,
    );
  }

  async function handleSign(req: Request, taskId: string): Promise<Response> {
    if (humanKey === null) {
      return fail(503, `approvals unavailable: ${approvalsUnavailableReason ?? "no pinned human key"}`);
    }
    const task = tasks.get(taskId);
    if (task === undefined) {
      return fail(404, `task ${JSON.stringify(taskId)} not found`);
    }
    const record = await readJson(req);
    if (record === null) {
      return fail(400, "request body must be a JSON object");
    }
    const ticket = record["ticket"];
    if (typeof ticket !== "string" || ticket.length === 0) {
      return fail(400, "ticket must be a non-empty string");
    }
    const signatureHex = record["signatureHex"] ?? record["signature"];
    // Recompute the subject from the task's CURRENT diff: a ticket minted
    // for an older diff no longer binds and is burned.
    const current = subjectFor(taskId).subjectHash;
    let binding: { subjectHash: string; timestamp: string };
    try {
      binding = tickets.redeemTicket(ticket, taskId, current);
    } catch (err) {
      if (err instanceof TicketError) {
        const message =
          err.code === "binding-mismatch"
            ? "approval ticket does not bind this task and its current diff (diff changed or ticket is for another task)"
            : err.message;
        audit("approval.refused", { taskId, reason: err.code });
        return fail(403, message, { code: err.code });
      }
      throw err;
    }
    if (record["subjectHash"] !== undefined && record["subjectHash"] !== binding.subjectHash) {
      audit("approval.refused", { taskId, reason: "subject-mismatch" });
      return fail(403, "subjectHash does not match the server-computed subject of this ticket", { code: "subject-mismatch" });
    }
    const approve = record["approve"] !== false;
    const payload = approvalPayload(taskId, approve, binding.subjectHash, binding.timestamp);
    if (!verifyPinnedApproval(humanKey, payload, signatureHex)) {
      audit("approval.refused", { taskId, reason: "bad-signature", fingerprint: humanKey.fingerprint });
      return fail(403, "approval signature does not verify against the pinned human key", { code: "bad-signature" });
    }
    if (task.status !== TaskStatuses.waitingHuman) {
      return fail(409, `task ${JSON.stringify(taskId)} is ${task.status}, only waitingHuman tasks can be signed`);
    }
    const signed = signedRecord(humanKey, payload, signatureHex as string);
    let landedSha: string | undefined;
    if (approve && repoDir !== undefined && stateDir !== undefined) {
      const integration = missions.get(task.missionId)?.integrationBranch ?? integrationBranch(task.missionId);
      const landed = await landApproved(task.id, integration);
      if (landed === null) {
        return fail(409, `task ${JSON.stringify(taskId)} changed state while landing was queued`);
      }
      if (!landed.ok) {
        const files = landed.files ?? [];
        const reason =
          landed.reason === "conflict"
            ? `approved, but landing on ${integration} conflicts in: ${files.join(", ")}`
            : `approved, but landing on ${integration} failed at ${landed.stage}: ${landed.reason}`;
        updateTask(task.id, { status: TaskStatuses.waitingHuman, reason: reason.slice(0, 2000) });
        audit("approval.signed", { taskId, approve, status: TaskStatuses.waitingHuman, landed: false, stage: landed.stage, files, record: signed });
        bus.publish("approval.landing-failed", { taskId, integration, stage: landed.stage, reason: landed.reason, files });
        return fail(409, reason, { code: "landing-failed", stage: landed.stage, files, record: signed });
      }
      landedSha = landed.mergedSha;
    }
    const next: TaskStatus = approve ? TaskStatuses.done : TaskStatuses.failed;
    updateTask(task.id, {
      status: next,
      reason: approve
        ? landedSha !== undefined
          ? `approved by human (Ed25519); landed ${landedSha.slice(0, 12)}`
          : "approved by human (Ed25519)"
        : "rejected by human (Ed25519)",
      ...(landedSha !== undefined ? { landedSha } : {}),
    });
    audit("approval.signed", { taskId, approve, status: next, landedSha: landedSha ?? null, record: signed });
    bus.publish("approval.signed", { taskId, status: next, approve, subjectHash: binding.subjectHash, landedSha: landedSha ?? null });
    return json({ taskId, status: next, subjectHash: binding.subjectHash, landedSha: landedSha ?? null, record: signed }, 200);
  }

  /**
   * Land an approved task onto its mission's integration branch, one
   * landing at a time. Null when the task left `waitingHuman` while queued.
   */
  function landApproved(taskId: string, integration: string): Promise<LandResult | null> {
    const run = async (): Promise<LandResult | null> => {
      const task = tasks.get(taskId);
      if (repoDir === undefined || stateDir === undefined || task === undefined || task.status !== TaskStatuses.waitingHuman) {
        return null;
      }
      try {
        return await landTask({
          repoDir,
          landingRoot: join(stateDir, "landing"),
          taskId,
          missionId: task.missionId,
          taskBranch: task.branch,
          integration,
          base: task.input.base,
          audit,
        });
      } catch (err) {
        return { ok: false, reason: (err as Error).message, stage: "merge", rolledBack: false };
      }
    };
    const result = landingQueue.then(run, run);
    landingQueue = result.catch(() => null);
    return result;
  }

  async function route(req: Request): Promise<Response> {
    const url = new URL(req.url);
    if (!LOOPBACK_HOSTS.includes(url.hostname.replace(/^\[|\]$/g, ""))) {
      return fail(403, `host ${JSON.stringify(url.hostname)} is not loopback; this API serves 127.0.0.1 only`);
    }
    const { pathname } = url;
    if (req.method === "GET" && pathname === "/api/board") {
      return json(getBoard(), 200);
    }
    if (req.method === "GET" && pathname === "/api/csrf") {
      return json({ csrfToken }, 200);
    }
    if (req.method === "GET" && pathname === "/api/events") {
      return handleEvents(req);
    }
    const drilldown = /^\/api\/tasks\/([^/]+)\/drilldown$/.exec(pathname);
    if (drilldown !== null && drilldown[1] !== undefined) {
      if (req.method !== "GET") {
        return fail(405, `method ${req.method} not allowed for drilldown`);
      }
      return handleDrilldown(decodeURIComponent(drilldown[1]));
    }
    const approval = /^\/api\/approvals\/([^/]+)\/(ticket|sign)$/.exec(pathname);
    if (approval !== null && approval[1] !== undefined && approval[2] !== undefined) {
      if (req.method !== "POST") {
        return fail(405, `method ${req.method} not allowed for approvals`);
      }
      if (req.headers.get(CSRF_HEADER) !== csrfToken) {
        return fail(403, "missing or invalid CSRF token");
      }
      const id = decodeURIComponent(approval[1]);
      return approval[2] === "ticket" ? handleMintTicket(id) : handleSign(req, id);
    }
    if (req.method === "POST" && pathname === "/api/director/message") {
      if (req.headers.get(CSRF_HEADER) !== csrfToken) {
        return fail(403, "missing or invalid CSRF token");
      }
      return handleDirectorMessage(req);
    }
    if (req.method === "GET" && options.webDistDir !== undefined && !pathname.startsWith("/api/")) {
      const served = serveStatic(options.webDistDir, pathname);
      if (served !== null) return served;
    }
    return fail(404, `no route for ${req.method} ${pathname}`);
  }

  let shutDown = false;

  const app: FleetServer = {
    fetch: (req: Request) => route(req),
    csrfToken,
    tickets,
    bus,
    humanKey,
    approvalsUnavailableReason,
    getBoard,
    getTask: (id: string) => tasks.get(id),
    upsertTask,
    updateTask,
    setTier: (tier: ModelTier) => {
      activeTier = tier;
    },
    reportProviderFailure,
    reportProviderSuccess: () => {
      failures = 0;
    },
    consecutiveFailures: () => failures,
    appendToolLog,
    setStageGates,
    recordDiff: (taskId: string, hunks: DiffHunk[]) => {
      if (!tasks.has(taskId)) {
        throw new Error(`cannot record diff: task ${JSON.stringify(taskId)} not found`);
      }
      sessionFor(taskId).diffs = hunks;
    },
    attachWorktreeStore: (store: WorktreeStore) => {
      worktreeStore = store;
    },
    subjectFor,
    runningWorkers: () => launcher?.runningIds() ?? [],
    directorIdle: async () => {
      await director?.idle();
    },
    attachNats: (bridge: NatsJetStreamBridge) => {
      detachNats?.();
      natsBridge = bridge;
      detachNats = attachBusToNats(bus, bridge);
    },
    shutdown: async () => {
      if (shutDown) return;
      shutDown = true;
      await launcher?.stop();
      await director?.stop();
      detachNats?.();
      if (natsBridge !== null) await natsBridge.close();
      boardStore?.close();
      if (repoDir !== undefined && stateDir !== undefined) worktreeStore?.close();
    },
  };
  launcher?.kick();
  return app;
}

export interface StartServerOptions extends CreateServerOptions {
  port: number;
  hostname?: string | undefined;
}

export interface RunningServer {
  app: FleetServer;
  url: string;
  stop: () => Promise<void>;
}

/** Serve the control API on loopback. `hostname` defaults to `127.0.0.1` and is never 0.0.0.0. */
export function startServer(options: StartServerOptions): RunningServer {
  const hostname = options.hostname ?? "127.0.0.1";
  if (!LOOPBACK_HOSTS.includes(hostname)) {
    throw new Error(`refusing to serve on non-loopback host ${JSON.stringify(hostname)}`);
  }
  const { port: _port, hostname: _hostname, ...appOptions } = options;
  const app = createServer(appOptions);
  // SSE streams heartbeat every 15s; keep idle connections open well past that.
  const server = Bun.serve({ hostname, port: options.port, idleTimeout: 120, fetch: (req: Request) => app.fetch(req) });
  return {
    app,
    url: `http://${hostname}:${server.port}`,
    stop: async () => {
      await server.stop(true);
      await app.shutdown();
    },
  };
}
