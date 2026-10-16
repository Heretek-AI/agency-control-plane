/**
 * Bun HTTP + SSE control API for the Fleet Dispatcher Daemon.
 *
 * Serves loopback-only (`127.0.0.1`) JSON routes plus a ring-buffered
 * SSE stream, wiring the scheduler, 3-tier limits, audit ledger,
 * worktree register, event bus, and single-use approval tickets into
 * one in-memory mission board:
 *
 * - `GET /api/board` — Kanban columns, tasks, worktree statuses, the
 *   active model tier, DAG edges, and the scheduler's start plan.
 * - `POST /api/director/message` — append a steering message and
 *   decompose new task cards onto the board.
 * - `GET /api/tasks/:id/drilldown` — worker session metadata, stage
 *   gates, live tool-log buffer, and git diff hunks.
 * - `POST /api/approvals/:taskId/ticket` — mint a single-use 60s-TTL
 *   preview ticket bound to `{ taskId, subjectHash }`.
 * - `POST /api/approvals/:taskId/sign` — verify the single-use ticket
 *   plus the Ed25519 signature / passphrase in memory, transition the
 *   task from `waitingHuman` to `ready` (approve) or `pending`
 *   (reject), and append to the audit ledger.
 * - `GET /api/events` — SSE stream with `Last-Event-ID` replay over
 *   the ring buffer (`?snapshot=1` returns the replay as one finite
 *   payload for inspector initial loads).
 * - `GET /api/csrf` — issue the CSRF token POST routes require.
 *
 * Guards (fail-closed): non-loopback `Host` → 403; POST without a
 * matching `x-csrf-token` → 403; unknown/expired/reused tickets → 403;
 * bad signatures → 403; signing a task that is not `waitingHuman` →
 * 409. Every state-changing route appends to the audit ledger and
 * publishes a bus event.
 */
import { randomBytes } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TicketError, TicketStore, passphraseToKeypair, verifyApprovalSignature } from "./approval-tickets.js";
import { appendAudit } from "./audit.js";
import { EventBus, gapToSSE, toSSE } from "./event-bus.js";
import { classifyProviderFailure, type ModelTier, type ProviderFailure } from "./limits.js";
import { TaskSchema, TaskStatuses, type Task, type TaskStatus } from "./model.js";
import { schedule } from "./scheduler.js";
import { runGit, type WorktreeState, type WorktreeStore } from "./worktrees.js";

export const LOOPBACK_HOSTS: readonly string[] = ["127.0.0.1", "localhost", "::1"] as const;
export const CSRF_HEADER = "x-csrf-token";
export const SCHEDULER_FLEET_CAP = 4;
export const MAX_TASKS_PER_MESSAGE = 50;

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
  state: WorktreeState;
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

export interface DirectorMessage {
  seq: number;
  author: string;
  text: string;
  timestamp: string;
}

export interface BoardView {
  columns: BoardColumnView[];
  tasks: Task[];
  worktrees: WorktreeStatusView[];
  missions: MissionView[];
  messages: DirectorMessage[];
  activeTier: ModelTier;
  dagEdges: DagEdge[];
  plan: { start: string[]; ready: string[]; cancel: string[] };
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
}

export interface CreateServerOptions {
  auditLogPath?: string | undefined;
  csrfToken?: string | undefined;
  eventCapacity?: number | undefined;
  repoDir?: string | undefined;
  clock?: (() => number) | undefined;
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
  reportProviderFailure(failure: ProviderFailure): { action: string };
  reportProviderSuccess(): void;
  consecutiveFailures(): number;
  appendToolLog(taskId: string, entry: { tool: string; input: string; output: string }): ToolLogEntry;
  setStageGates(taskId: string, gates: StageGate[]): void;
  recordDiff(taskId: string, hunks: DiffHunk[]): void;
  attachWorktreeStore(store: WorktreeStore): void;
}

interface SessionState {
  stageGates: StageGate[];
  toolLog: ToolLogEntry[];
  diffs: DiffHunk[];
}

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function fail(status: number, error: string, extra?: Record<string, unknown>): Response {
  return json({ error, ...(extra ?? {}) }, status);
}

function defaultAuditLogPath(): string {
  return join(mkdtempSync(join(tmpdir(), "agency-audit-")), "audit.jsonl");
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

/** Titles decomposed from a director message: bullets first, else the message's first line. */
export function decomposeMessage(message: string): string[] {
  const titles: string[] = [];
  for (const line of message.split("\n")) {
    const bullet = /^\s*(?:[-*]|\d+\.)\s+(.+?)\s*$/.exec(line);
    if (bullet !== null && bullet[1] !== undefined && bullet[1].length > 0) {
      titles.push(bullet[1]);
    }
  }
  if (titles.length > 0) {
    return titles;
  }
  const first = message.split("\n")[0]?.trim() ?? "";
  return [first.length > 80 ? `${first.slice(0, 77)}...` : first];
}

export function createServer(options: CreateServerOptions = {}): FleetServer {
  const auditLogPath = options.auditLogPath ?? defaultAuditLogPath();
  const csrfToken = options.csrfToken ?? randomBytes(16).toString("hex");
  const clock = options.clock ?? Date.now;
  const bus = new EventBus(options.eventCapacity ?? 1000);
  const tickets = new TicketStore(clock);
  const repoDir = options.repoDir;

  const tasks = new Map<string, Task>();
  const sessions = new Map<string, SessionState>();
  const messages: DirectorMessage[] = [];
  const missions = new Map<string, MissionView>();
  let messageSeq = 0;
  let taskSeq = 0;
  let activeTier: ModelTier = "tier-1-opencode";
  let failures = 0;
  let worktreeStore: WorktreeStore | null = null;

  missions.set("mission-1", {
    id: "mission-1",
    objective: "Fleet mission",
    status: "running",
    integrationBranch: "fleet/integration/mission-1",
  });

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

  function upsertTask(input: UpsertTaskInput): Task {
    const existing = tasks.get(input.id);
    const raw = {
      id: input.id,
      missionId: input.missionId ?? existing?.missionId ?? "mission-1",
      title: input.title ?? existing?.title ?? input.id,
      kind: input.kind ?? existing?.kind ?? "expert-run",
      expert: input.expert ?? existing?.expert,
      deps: input.deps ?? existing?.deps ?? [],
      strategy: input.strategy ?? existing?.strategy ?? "all_success",
      input: existing?.input ?? { objective: input.title ?? input.id, acceptance: [], paths: input.paths ?? [] },
      owner: input.owner ?? existing?.owner ?? [],
      policy: existing?.policy ?? { strategy: "fail" },
      status: input.status,
      attempts: input.attempts ?? existing?.attempts ?? 0,
      branch: input.branch ?? existing?.branch ?? `fleet/${input.id}`,
      worktree: input.worktree ?? existing?.worktree,
      sessionId: input.sessionId ?? existing?.sessionId ?? `sess-${input.id}`,
    };
    const task = TaskSchema.parse(raw);
    tasks.set(task.id, task);
    sessionFor(task.id);
    if (!missions.has(task.missionId)) {
      missions.set(task.missionId, {
        id: task.missionId,
        objective: task.missionId,
        status: "running",
        integrationBranch: `fleet/integration/${task.missionId}`,
      });
    }
    return task;
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
        state: stored?.state ?? "allocated",
      });
    }
    const dagEdges: DagEdge[] = [];
    for (const task of all) {
      for (const dep of task.deps) {
        dagEdges.push({ from: dep, to: task.id });
      }
    }
    const runningIds = all.filter((task) => task.status === TaskStatuses.running).map((task) => task.id);
    const plan = schedule(all, runningIds, { fleet: SCHEDULER_FLEET_CAP });
    return {
      columns,
      tasks: all,
      worktrees,
      missions: [...missions.values()],
      messages: [...messages],
      activeTier,
      dagEdges,
      plan,
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

  async function handleDirectorMessage(req: Request): Promise<Response> {
    let body: unknown;
    try {
      body = await req.json();
    } catch {
      return fail(400, "request body must be valid JSON");
    }
    const record = body as { message?: unknown; author?: unknown; missionId?: unknown };
    if (typeof record.message !== "string" || record.message.trim().length === 0) {
      return fail(400, "message must be a non-empty string");
    }
    const missionId = typeof record.missionId === "string" && record.missionId.length > 0 ? record.missionId : "mission-1";
    const author = typeof record.author === "string" && record.author.length > 0 ? record.author : "director";
    const titles = decomposeMessage(record.message);
    if (titles.length > MAX_TASKS_PER_MESSAGE) {
      return fail(400, `message decomposes into ${titles.length} tasks, limit is ${MAX_TASKS_PER_MESSAGE}`);
    }
    messageSeq += 1;
    const message: DirectorMessage = {
      seq: messageSeq,
      author,
      text: record.message,
      timestamp: new Date().toISOString(),
    };
    messages.push(message);
    const created: string[] = [];
    for (const title of titles) {
      taskSeq += 1;
      const id = `task-${taskSeq}`;
      upsertTask({ id, missionId, title, kind: "expert-run", status: "pending" });
      created.push(id);
    }
    appendAudit(auditLogPath, "director.message", { seq: message.seq, missionId, tasksCreated: created });
    bus.publish("director.message", { seq: message.seq, missionId, tasksCreated: created });
    return json({ message, tasksCreated: created }, 200);
  }

  function handleDrilldown(taskId: string): Response {
    const task = tasks.get(taskId);
    if (task === undefined) {
      return fail(404, `task ${JSON.stringify(taskId)} not found`);
    }
    const session = sessionFor(taskId);
    const view: DrilldownView = {
      task,
      session: { sessionId: task.sessionId ?? `sess-${task.id}`, status: task.status, tier: activeTier },
      stageGates: session.stageGates,
      toolLog: session.toolLog,
      diffs: diffsFor(task),
    };
    return json(view, 200);
  }

  async function handleMintTicket(req: Request, taskId: string): Promise<Response> {
    const task = tasks.get(taskId);
    if (task === undefined) {
      return fail(404, `task ${JSON.stringify(taskId)} not found`);
    }
    let body: unknown;
    try {
      body = await req.json();
    } catch {
      return fail(400, "request body must be valid JSON");
    }
    const record = body as { subjectHash?: unknown };
    if (typeof record.subjectHash !== "string" || record.subjectHash.trim().length === 0) {
      return fail(400, "subjectHash must be a non-empty string");
    }
    try {
      const minted = tickets.mintTicket(taskId, record.subjectHash);
      appendAudit(auditLogPath, "approval.ticket-minted", { taskId, subjectHash: record.subjectHash });
      return json({ ticket: minted.token, taskId, subjectHash: record.subjectHash, expiresAtMs: minted.expiresAtMs }, 200);
    } catch (err) {
      return fail(400, (err as Error).message);
    }
  }

  async function handleSign(req: Request, taskId: string): Promise<Response> {
    const task = tasks.get(taskId);
    if (task === undefined) {
      return fail(404, `task ${JSON.stringify(taskId)} not found`);
    }
    let body: unknown;
    try {
      body = await req.json();
    } catch {
      return fail(400, "request body must be valid JSON");
    }
    const record = body as {
      ticket?: unknown;
      subjectHash?: unknown;
      signature?: unknown;
      publicKey?: unknown;
      passphrase?: unknown;
      approve?: unknown;
    };
    if (typeof record.ticket !== "string" || record.ticket.length === 0) {
      return fail(400, "ticket must be a non-empty string");
    }
    if (typeof record.subjectHash !== "string" || record.subjectHash.length === 0) {
      return fail(400, "subjectHash must be a non-empty string");
    }
    try {
      tickets.redeemTicket(record.ticket, taskId, record.subjectHash);
    } catch (err) {
      if (err instanceof TicketError) {
        return fail(403, err.message, { code: err.code });
      }
      throw err;
    }
    // The passphrase lives only in this closure and is cleared below.
    let passphrase: string | null =
      typeof record.passphrase === "string" && record.passphrase.length > 0 ? record.passphrase : null;
    try {
      if (typeof record.signature !== "string" || record.signature.length === 0) {
        return fail(403, "approval requires an Ed25519 signature over the subject hash");
      }
      let verifyingKey: string | null = null;
      if (typeof record.publicKey === "string" && record.publicKey.length > 0) {
        verifyingKey = record.publicKey;
      } else if (passphrase !== null) {
        try {
          verifyingKey = passphraseToKeypair(passphrase).publicKeyPem;
        } catch {
          return fail(403, "approval passphrase cannot derive an Ed25519 key");
        }
      } else {
        return fail(403, "approval requires a publicKey or passphrase to verify the signature against");
      }
      if (!verifyApprovalSignature(verifyingKey, record.subjectHash, record.signature)) {
        return fail(403, "approval signature verification failed");
      }
      if (task.status !== TaskStatuses.waitingHuman) {
        return fail(409, `task ${JSON.stringify(taskId)} is ${task.status}, only waitingHuman tasks can be signed`);
      }
      const approve = record.approve !== false;
      const next: TaskStatus = approve ? TaskStatuses.ready : TaskStatuses.pending;
      const updated: Task = {
        ...task,
        status: next,
        reason: approve ? "approved by human" : "rejected by human approver",
      };
      tasks.set(task.id, updated);
      appendAudit(auditLogPath, "approval.signed", {
        taskId,
        subjectHash: record.subjectHash,
        approve,
        status: next,
      });
      bus.publish("approval.signed", { taskId, status: next, approve });
      return json({ taskId, status: next, subjectHash: record.subjectHash }, 200);
    } finally {
      passphrase = null;
    }
  }

  async function route(req: Request): Promise<Response> {
    const url = new URL(req.url);
    if (!LOOPBACK_HOSTS.includes(url.hostname)) {
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
      return approval[2] === "ticket" ? handleMintTicket(req, id) : handleSign(req, id);
    }
    if (req.method === "POST" && pathname === "/api/director/message") {
      if (req.headers.get(CSRF_HEADER) !== csrfToken) {
        return fail(403, "missing or invalid CSRF token");
      }
      return handleDirectorMessage(req);
    }
    return fail(404, `no route for ${req.method} ${pathname}`);
  }

  const app: FleetServer = {
    fetch: (req: Request) => route(req),
    csrfToken,
    tickets,
    bus,
    getBoard,
    getTask: (id: string) => tasks.get(id),
    upsertTask,
    setTier: (tier: ModelTier) => {
      activeTier = tier;
    },
    reportProviderFailure: (failure: ProviderFailure) => {
      failures += 1;
      const disposition = classifyProviderFailure(failure, failures, activeTier);
      if (disposition.action === "route-fallback") {
        activeTier = disposition.targetTier;
        failures = 0;
        bus.publish("tier.fallback", { targetTier: activeTier });
      } else {
        bus.publish("provider.retry", { action: disposition.action });
      }
      return { action: disposition.action };
    },
    reportProviderSuccess: () => {
      failures = 0;
    },
    consecutiveFailures: () => failures,
    appendToolLog: (taskId: string, entry: { tool: string; input: string; output: string }) => {
      if (!tasks.has(taskId)) {
        throw new Error(`cannot append tool log: task ${JSON.stringify(taskId)} not found`);
      }
      const session = sessionFor(taskId);
      const logged: ToolLogEntry = {
        seq: session.toolLog.length + 1,
        tool: entry.tool,
        input: entry.input,
        output: entry.output,
      };
      session.toolLog.push(logged);
      bus.publish("worker.tool", { taskId, seq: logged.seq, tool: logged.tool });
      return logged;
    },
    setStageGates: (taskId: string, gates: StageGate[]) => {
      if (!tasks.has(taskId)) {
        throw new Error(`cannot set stage gates: task ${JSON.stringify(taskId)} not found`);
      }
      sessionFor(taskId).stageGates = gates;
      bus.publish("worker.gates", { taskId, gates });
    },
    recordDiff: (taskId: string, hunks: DiffHunk[]) => {
      if (!tasks.has(taskId)) {
        throw new Error(`cannot record diff: task ${JSON.stringify(taskId)} not found`);
      }
      sessionFor(taskId).diffs = hunks;
    },
    attachWorktreeStore: (store: WorktreeStore) => {
      worktreeStore = store;
    },
  };
  return app;
}

export interface StartServerOptions extends CreateServerOptions {
  port: number;
  hostname?: string | undefined;
}

export interface RunningServer {
  app: FleetServer;
  url: string;
  stop: () => void;
}

/** Serve the control API on loopback. `hostname` defaults to `127.0.0.1` and is never 0.0.0.0. */
export function startServer(options: StartServerOptions): RunningServer {
  const hostname = options.hostname ?? "127.0.0.1";
  if (!LOOPBACK_HOSTS.includes(hostname)) {
    throw new Error(`refusing to serve on non-loopback host ${JSON.stringify(hostname)}`);
  }
  const { port: _port, hostname: _hostname, ...appOptions } = options;
  const app = createServer(appOptions);
  const server = Bun.serve({ hostname, port: options.port, fetch: (req: Request) => app.fetch(req) });
  return {
    app,
    url: `http://${hostname}:${server.port}`,
    stop: () => {
      server.stop();
    },
  };
}
