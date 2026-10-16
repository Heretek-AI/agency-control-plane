/**
 * Director: a long-lived OpenCode worker session (agent `director` by
 * default) that the human steers from the WebUI chat.
 *
 * Each chat message becomes one prompt turn on the same session; the
 * Director's final text is shown in chat. Task cards are created ONLY
 * from a structured block the Director emits:
 *
 * ```tasks
 * [{ "key": "api", "title": "Query API", "objective": "...", "paths": ["src/api/*"], "deps": [] }]
 * ```
 *
 * The block is a JSON array validated with zod (`DirectorTaskSchema`,
 * strict: unknown fields are rejected). `deps` name other `key`s in the
 * same block or existing task ids. Anything that fails validation
 * creates no tasks and is reported back in chat.
 */
import { z } from "zod";
import { openWorker, runTurn, type WorkerClientFactory, type WorkerConnection } from "./worker-session.js";

export const MAX_DIRECTOR_TASKS = 50;

export const DirectorTaskSchema = z
  .object({
    key: z
      .string()
      .regex(/^[a-z0-9][a-z0-9-]{0,40}$/, "key must be a short lowercase slug")
      .optional(),
    title: z.string().trim().min(1).max(200),
    objective: z.string().trim().min(1).max(8000).optional(),
    context: z.string().max(8000).optional(),
    acceptance: z.array(z.string().min(1).max(500)).max(30).default([]),
    paths: z.array(z.string().min(1).max(300)).max(50).default([]),
    deps: z.array(z.string().min(1)).max(50).default([]),
    expert: z.string().min(1).max(80).optional(),
    kind: z.enum(["expert-run", "verify", "human"]).default("expert-run"),
  })
  .strict();

export const DirectorTasksSchema = z.array(DirectorTaskSchema).min(1).max(MAX_DIRECTOR_TASKS);

export type DirectorTask = z.infer<typeof DirectorTaskSchema>;

export type ParsedDirectorReply =
  | { ok: true; tasks: DirectorTask[]; text: string }
  | { ok: false; error: string; text: string };

const FENCE_OPEN = "```tasks";
const FENCE_CLOSE = "\n```";

/** Split a reply into its ```tasks block bodies and the remaining text (linear scan, no regex). */
export function extractTaskBlocks(reply: string): { blocks: string[]; text: string } {
  const blocks: string[] = [];
  let text = "";
  let cursor = 0;
  for (;;) {
    const open = reply.indexOf(FENCE_OPEN, cursor);
    if (open === -1) break;
    const lineEnd = reply.indexOf("\n", open + FENCE_OPEN.length);
    if (lineEnd === -1 || reply.slice(open + FENCE_OPEN.length, lineEnd).trim().length > 0) {
      text += reply.slice(cursor, open + FENCE_OPEN.length);
      cursor = open + FENCE_OPEN.length;
      continue;
    }
    const close = reply.indexOf(FENCE_CLOSE, lineEnd);
    if (close === -1) break;
    text += reply.slice(cursor, open);
    blocks.push(reply.slice(lineEnd + 1, close));
    cursor = close + FENCE_CLOSE.length;
  }
  text += reply.slice(cursor);
  return { blocks, text: text.trim() };
}

/**
 * Extract and validate the ```tasks blocks of a Director reply. `text` is
 * the reply with the blocks removed (for chat display). No block means no
 * tasks (`ok: true`, empty list).
 */
export function parseDirectorReply(reply: string, knownTaskIds: ReadonlySet<string> = new Set()): ParsedDirectorReply {
  const { blocks, text } = extractTaskBlocks(reply);
  if (blocks.length === 0) return { ok: true, tasks: [], text };
  const all: DirectorTask[] = [];
  for (const block of blocks) {
    let json: unknown;
    try {
      json = JSON.parse(block);
    } catch (err) {
      return { ok: false, error: `tasks block is not valid JSON: ${(err as Error).message}`, text };
    }
    const parsed = DirectorTasksSchema.safeParse(json);
    if (!parsed.success) {
      const issue = parsed.error.issues[0];
      return {
        ok: false,
        error: `tasks block failed validation at ${issue?.path.join(".") || "(root)"}: ${issue?.message ?? "invalid"}`,
        text,
      };
    }
    all.push(...parsed.data);
  }
  if (all.length > MAX_DIRECTOR_TASKS) {
    return { ok: false, error: `tasks blocks declare ${all.length} tasks, limit is ${MAX_DIRECTOR_TASKS}`, text };
  }
  const keys = new Set<string>();
  for (const task of all) {
    if (task.key !== undefined) {
      if (keys.has(task.key)) return { ok: false, error: `duplicate task key ${JSON.stringify(task.key)}`, text };
      keys.add(task.key);
    }
  }
  for (const task of all) {
    for (const dep of task.deps) {
      if (!keys.has(dep) && !knownTaskIds.has(dep)) {
        return { ok: false, error: `task ${JSON.stringify(task.title)} depends on unknown ${JSON.stringify(dep)}`, text };
      }
    }
  }
  return { ok: true, tasks: all, text };
}

/** Contract sent with the first message of a Director session. */
export const DIRECTOR_PREAMBLE = [
  "You are the Director of a fleet of coding workers operating on this repository.",
  "Discuss plans with the human. When (and only when) you want work to start, end your reply with ONE fenced block:",
  "```tasks",
  '[{"key":"short-slug","title":"Card title","objective":"What the worker must do","acceptance":["..."],"paths":["src/dir/*"],"deps":["other-key"]}]',
  "```",
  "Fields: key (optional slug, referenced by deps), title (required), objective, context, acceptance[], paths[] (files the worker may touch; overlapping paths are serialized), deps[] (keys in this block or existing task ids), expert, kind (expert-run | verify | human).",
  "Do not edit files yourself. Workers run in isolated worktrees and a human signs every diff.",
].join("\n");

export interface DirectorOptions {
  command: readonly string[];
  cwd: string;
  stateDir: string;
  agent?: string | undefined;
  startTimeoutMs?: number | undefined;
  replyTimeoutMs?: number | undefined;
  env?: Record<string, string | undefined> | undefined;
  clientFactory?: WorkerClientFactory | undefined;
}

export interface DirectorTurn {
  ok: boolean;
  reply: string;
  error?: string | undefined;
  sessionId?: string | undefined;
}

export class Director {
  private conn: WorkerConnection | null = null;
  private sessionId: string | null = null;
  private queue: Promise<unknown> = Promise.resolve();
  private stopped = false;
  private readonly abort = new AbortController();

  constructor(private readonly options: DirectorOptions) {}

  /** Session id of the live Director session, if any. */
  currentSession(): string | null {
    return this.sessionId;
  }

  /** Send one message; turns are serialized so the session sees them in order. */
  send(message: string): Promise<DirectorTurn> {
    const turn = this.queue.then(() => this.turn(message));
    this.queue = turn.catch(() => undefined);
    return turn;
  }

  /** Resolves when every queued turn has finished. */
  async idle(): Promise<void> {
    await this.queue;
  }

  private async ensureSession(): Promise<{ conn: WorkerConnection; sessionId: string; fresh: boolean }> {
    if (this.conn !== null && this.sessionId !== null && this.conn.alive()) {
      return { conn: this.conn, sessionId: this.sessionId, fresh: false };
    }
    if (this.conn !== null) {
      await this.conn.close();
      this.conn = null;
      this.sessionId = null;
    }
    const conn = await openWorker({
      command: this.options.command,
      cwd: this.options.cwd,
      stateDir: this.options.stateDir,
      env: this.options.env,
      startTimeoutMs: this.options.startTimeoutMs,
      clientFactory: this.options.clientFactory,
    });
    try {
      const session = await conn.client.createSession({
        directory: this.options.cwd,
        agent: this.options.agent ?? "director",
        title: "Fleet Director",
      });
      this.conn = conn;
      this.sessionId = session.id;
      return { conn, sessionId: session.id, fresh: true };
    } catch (err) {
      await conn.close();
      throw err;
    }
  }

  private async turn(message: string): Promise<DirectorTurn> {
    if (this.stopped) return { ok: false, reply: "", error: "director is shut down" };
    let session: { conn: WorkerConnection; sessionId: string; fresh: boolean };
    try {
      session = await this.ensureSession();
    } catch (err) {
      return { ok: false, reply: "", error: `director worker unavailable: ${(err as Error).message}` };
    }
    const text = session.fresh ? `${DIRECTOR_PREAMBLE}\n\n---\n\n${message}` : message;
    const result = await runTurn(session.conn, session.sessionId, text, {
      timeoutMs: this.options.replyTimeoutMs ?? 10 * 60_000,
      signal: this.abort.signal,
    });
    const reply = result.texts.join("\n\n");
    if (result.outcome !== "succeeded") {
      return { ok: false, reply, error: result.error ?? result.outcome, sessionId: session.sessionId };
    }
    return { ok: true, reply, sessionId: session.sessionId };
  }

  async stop(): Promise<void> {
    this.stopped = true;
    this.abort.abort();
    await this.queue;
    if (this.conn !== null) {
      await this.conn.close();
      this.conn = null;
    }
  }
}
