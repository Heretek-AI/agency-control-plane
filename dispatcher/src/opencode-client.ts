/**
 * Worker process + OpenCode v2 HTTP client.
 *
 * A worker is one `opencode serve --port 0 --hostname 127.0.0.1` process
 * (command configurable) started in a task worktree. The dispatcher:
 *
 * 1. spawns it with a random per-process server password
 *    (`OPENCODE_SERVER_PASSWORD`) and an isolated SQLite store
 *    (`OPENCODE_DB=<worktree>/.opencode/opencode.db`), so concurrent
 *    workers never share OpenCode's single-writer database;
 * 2. parses the listening URL from stdout (`server listening on <url>`,
 *    or the `--stdio` form `{"url": ...}`);
 * 3. talks to the v2 API with HTTP Basic auth (`opencode:<password>`):
 *    - `POST /api/session` `{ location: { directory }, agent?, title? }` -> `{ data: { id } }`
 *    - `POST /api/session/:id/prompt` `{ text }` (durably admits the input and schedules the agent loop)
 *    - `GET  /api/event` SSE, one `data: <json>` frame per event
 *      (`session.tool.*`, `session.text.ended`, `session.status`,
 *      `session.execution.succeeded|failed|interrupted`, ...).
 *
 * The HTTP surface is kept behind `WorkerApi` so the launcher and tests
 * never depend on transport details.
 */
import type { Subprocess } from "bun";
import { randomBytes } from "node:crypto";

/** One event from the worker's `/api/event` stream. */
export interface WorkerEvent {
  id?: string | undefined;
  type: string;
  data: Record<string, unknown>;
}

/** The slice of the OpenCode v2 API the dispatcher uses. */
export interface WorkerApi {
  createSession(input: { directory: string; agent?: string | undefined; title?: string | undefined }): Promise<{ id: string }>;
  prompt(sessionId: string, text: string): Promise<void>;
  /** Open the event stream. Resolves once the stream is connected; events flow to `onEvent` until `signal` aborts or the stream ends. */
  subscribe(onEvent: (event: WorkerEvent) => void, signal: AbortSignal): Promise<{ closed: Promise<void> }>;
}

export class OpencodeHttpClient implements WorkerApi {
  private readonly authHeader: string;

  constructor(
    private readonly baseUrl: string,
    password: string,
    username = "opencode",
  ) {
    this.authHeader = `Basic ${Buffer.from(`${username}:${password}`).toString("base64")}`;
  }

  private async request(method: string, path: string, body?: unknown): Promise<unknown> {
    const response = await fetch(new URL(path, this.baseUrl), {
      method,
      headers: {
        authorization: this.authHeader,
        ...(body === undefined ? {} : { "content-type": "application/json" }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const text = await response.text();
    if (!response.ok) {
      throw new Error(`worker ${method} ${path} failed with ${response.status}: ${text.slice(0, 500)}`);
    }
    if (text.length === 0) return null;
    try {
      return JSON.parse(text) as unknown;
    } catch {
      throw new Error(`worker ${method} ${path} returned non-JSON: ${text.slice(0, 200)}`);
    }
  }

  async createSession(input: { directory: string; agent?: string | undefined; title?: string | undefined }): Promise<{ id: string }> {
    const payload: Record<string, unknown> = { location: { directory: input.directory } };
    if (input.agent !== undefined) payload["agent"] = input.agent;
    if (input.title !== undefined) payload["title"] = input.title;
    const result = (await this.request("POST", "/api/session", payload)) as { data?: { id?: unknown } } | null;
    const id = result?.data?.id;
    if (typeof id !== "string" || id.length === 0) {
      throw new Error("worker session.create response has no data.id");
    }
    return { id };
  }

  async prompt(sessionId: string, text: string): Promise<void> {
    await this.request("POST", `/api/session/${encodeURIComponent(sessionId)}/prompt`, { text });
  }

  async subscribe(onEvent: (event: WorkerEvent) => void, signal: AbortSignal): Promise<{ closed: Promise<void> }> {
    const response = await fetch(new URL("/api/event", this.baseUrl), {
      headers: { authorization: this.authHeader, accept: "text/event-stream" },
      signal,
    });
    if (!response.ok || response.body === null) {
      throw new Error(`worker GET /api/event failed with ${response.status}`);
    }
    const reader = response.body.getReader();
    const closed = (async () => {
      const decoder = new TextDecoder();
      let buffer = "";
      try {
        for (;;) {
          const chunk = await reader.read();
          if (chunk.done) break;
          buffer += decoder.decode(chunk.value, { stream: true });
          let boundary = buffer.indexOf("\n\n");
          while (boundary !== -1) {
            const frame = buffer.slice(0, boundary);
            buffer = buffer.slice(boundary + 2);
            const event = parseSseFrame(frame);
            if (event !== null) onEvent(event);
            boundary = buffer.indexOf("\n\n");
          }
        }
      } catch (err) {
        if (!signal.aborted) throw err;
      }
    })();
    return { closed };
  }
}

/** Parse one SSE frame (`data:` lines joined); comments and malformed frames yield null. */
export function parseSseFrame(frame: string): WorkerEvent | null {
  const data = frame
    .split("\n")
    .filter((line) => line.startsWith("data:"))
    .map((line) => line.slice(5).replace(/^ /, ""))
    .join("\n");
  if (data.length === 0) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(data);
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null) return null;
  const record = parsed as { id?: unknown; type?: unknown; data?: unknown };
  if (typeof record.type !== "string") return null;
  return {
    id: typeof record.id === "string" ? record.id : undefined,
    type: record.type,
    data: typeof record.data === "object" && record.data !== null ? (record.data as Record<string, unknown>) : {},
  };
}

/** Default worker command: OpenCode v2 server on an ephemeral loopback port. */
export const DEFAULT_WORKER_COMMAND: readonly string[] = ["opencode", "serve", "--port", "0", "--hostname", "127.0.0.1"];

export interface SpawnWorkerOptions {
  command: readonly string[];
  cwd: string;
  /** Directory holding the worker's isolated OpenCode state (SQLite store). */
  stateDir: string;
  env?: Record<string, string | undefined> | undefined;
  startTimeoutMs?: number | undefined;
}

export interface WorkerProcess {
  url: string;
  password: string;
  pid: number;
  /** Resolves with the exit code when the process exits. */
  exited: Promise<number>;
  /** Last lines of combined output, for failure reasons. */
  tail(): string;
  kill(): Promise<void>;
}

const LISTEN_PATTERNS: readonly RegExp[] = [/listening on (https?:\/\/\S+)/i, /"url"\s*:\s*"(https?:\/\/[^"]+)"/];

/** Extract the listening URL from one stdout line, or null. */
export function parseListeningUrl(line: string): string | null {
  for (const pattern of LISTEN_PATTERNS) {
    const match = pattern.exec(line);
    if (match !== null && match[1] !== undefined) return match[1].replace(/\/+$/, "");
  }
  return null;
}

/**
 * Spawn a worker server and wait for its listening URL. Fails (and kills
 * the process) when it exits early or does not announce a URL in time.
 */
export async function spawnWorker(options: SpawnWorkerOptions): Promise<WorkerProcess> {
  if (options.command.length === 0) {
    throw new Error("worker command must not be empty");
  }
  const password = randomBytes(24).toString("base64url");
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries({ ...process.env, ...(options.env ?? {}) })) {
    if (value !== undefined) env[key] = value;
  }
  env["OPENCODE_SERVER_PASSWORD"] = password;
  env["OPENCODE_DB"] = `${options.stateDir}/opencode.db`;
  let proc: Subprocess<"ignore", "pipe", "pipe">;
  try {
    proc = Bun.spawn([...options.command], { cwd: options.cwd, env, stdin: "ignore", stdout: "pipe", stderr: "pipe" });
  } catch (err) {
    throw new Error(`failed to spawn worker ${JSON.stringify(options.command[0])}: ${(err as Error).message}`);
  }
  const lines: string[] = [];
  const remember = (line: string): void => {
    lines.push(line);
    if (lines.length > 50) lines.shift();
  };
  let resolveUrl: (url: string) => void = () => undefined;
  const urlPromise = new Promise<string>((resolve) => {
    resolveUrl = resolve;
  });
  const pump = async (stream: ReadableStream<Uint8Array>, watchUrl: boolean): Promise<void> => {
    const decoder = new TextDecoder();
    let buffer = "";
    const reader = stream.getReader();
    for (;;) {
      const next = await reader.read();
      if (next.done) break;
      buffer += decoder.decode(next.value, { stream: true });
      let newline = buffer.indexOf("\n");
      while (newline !== -1) {
        const line = buffer.slice(0, newline);
        buffer = buffer.slice(newline + 1);
        remember(line);
        if (watchUrl) {
          const url = parseListeningUrl(line);
          if (url !== null) resolveUrl(url);
        }
        newline = buffer.indexOf("\n");
      }
    }
    if (buffer.length > 0) remember(buffer);
  };
  void pump(proc.stdout, true).catch(() => undefined);
  void pump(proc.stderr, false).catch(() => undefined);
  const exited = proc.exited;
  const kill = async (): Promise<void> => {
    if (proc.exitCode !== null || proc.signalCode !== null) return;
    proc.kill("SIGTERM");
    const timer = setTimeout(() => {
      if (proc.exitCode === null && proc.signalCode === null) proc.kill("SIGKILL");
    }, 3000);
    await exited;
    clearTimeout(timer);
  };
  const timeoutMs = options.startTimeoutMs ?? 60_000;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const outcome = await Promise.race([
    urlPromise.then((url) => ({ kind: "url" as const, url })),
    exited.then((code) => ({ kind: "exit" as const, code })),
    new Promise<{ kind: "timeout" }>((resolve) => {
      timer = setTimeout(() => resolve({ kind: "timeout" }), timeoutMs);
    }),
  ]);
  clearTimeout(timer);
  if (outcome.kind !== "url") {
    await kill();
    const why = outcome.kind === "exit" ? `exited with code ${outcome.code}` : `did not announce a URL within ${timeoutMs}ms`;
    throw new Error(`worker ${why}: ${lines.slice(-10).join(" | ")}`);
  }
  const url = new URL(outcome.url);
  if (url.hostname !== "127.0.0.1" && url.hostname !== "localhost" && url.hostname !== "[::1]") {
    await kill();
    throw new Error(`worker announced non-loopback URL ${outcome.url}; refusing to use it`);
  }
  return {
    url: outcome.url,
    password,
    pid: proc.pid,
    exited,
    tail: () => lines.slice(-10).join("\n"),
    kill,
  };
}
