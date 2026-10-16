/**
 * One live OpenCode worker connection plus prompt-turn tracking.
 *
 * `openWorker` spawns the worker server (see `opencode-client.ts`),
 * connects the event stream BEFORE any prompt is sent (so no event can be
 * missed), and routes events to per-session listeners by
 * `data.sessionID`. `runTurn` sends one prompt and resolves when the
 * session's execution ends (`session.execution.succeeded|failed|
 * interrupted`), the worker exits, the timeout elapses, or the caller
 * aborts.
 */
import {
  OpencodeHttpClient,
  spawnWorker,
  type WorkerApi,
  type WorkerEvent,
  type WorkerProcess,
} from "./opencode-client.js";

export type WorkerClientFactory = (url: string, password: string) => WorkerApi;

export const defaultClientFactory: WorkerClientFactory = (url, password) => new OpencodeHttpClient(url, password);

export interface WorkerConnection {
  readonly proc: WorkerProcess;
  readonly client: WorkerApi;
  /** Route events of one session to `listener`; returns the detach function. */
  listen(sessionId: string, listener: (event: WorkerEvent) => void): () => void;
  /** True until the process exits or the stream closes. */
  alive(): boolean;
  close(): Promise<void>;
}

export interface OpenWorkerOptions {
  command: readonly string[];
  cwd: string;
  stateDir: string;
  env?: Record<string, string | undefined> | undefined;
  startTimeoutMs?: number | undefined;
  clientFactory?: WorkerClientFactory | undefined;
}

export async function openWorker(options: OpenWorkerOptions): Promise<WorkerConnection> {
  const proc = await spawnWorker({
    command: options.command,
    cwd: options.cwd,
    stateDir: options.stateDir,
    env: options.env,
    startTimeoutMs: options.startTimeoutMs,
  });
  const client = (options.clientFactory ?? defaultClientFactory)(proc.url, proc.password);
  const listeners = new Map<string, Set<(event: WorkerEvent) => void>>();
  const abort = new AbortController();
  let alive = true;
  void proc.exited.then(() => {
    alive = false;
  });
  try {
    const { closed } = await client.subscribe((event) => {
      const sessionId = event.data["sessionID"];
      if (typeof sessionId !== "string") return;
      for (const listener of [...(listeners.get(sessionId) ?? [])]) listener(event);
    }, abort.signal);
    void closed.then(
      () => {
        alive = false;
      },
      () => {
        alive = false;
      },
    );
  } catch (err) {
    await proc.kill();
    throw err;
  }
  return {
    proc,
    client,
    listen(sessionId, listener) {
      let set = listeners.get(sessionId);
      if (set === undefined) {
        set = new Set();
        listeners.set(sessionId, set);
      }
      set.add(listener);
      return () => {
        set.delete(listener);
      };
    },
    alive: () => alive,
    async close() {
      alive = false;
      abort.abort();
      await proc.kill();
    },
  };
}

export type TurnOutcome = "succeeded" | "failed" | "interrupted" | "exited" | "timeout" | "aborted";

export interface TurnResult {
  outcome: TurnOutcome;
  /** Final assistant text segments (`session.text.ended`), in order. */
  texts: string[];
  error?: string | undefined;
}

/** Human-readable error text from an OpenCode `SessionError` payload. */
export function describeError(value: unknown): string {
  if (typeof value === "string") return value;
  if (typeof value === "object" && value !== null) {
    const record = value as { message?: unknown; type?: unknown; name?: unknown };
    if (typeof record.message === "string") return record.message;
    if (typeof record.type === "string") return record.type;
    if (typeof record.name === "string") return record.name;
    return JSON.stringify(value).slice(0, 500);
  }
  return String(value);
}

/**
 * Send one prompt and wait for the turn to finish. `onEvent` sees every
 * event of the session during the turn (tool calls, status, text).
 */
export async function runTurn(
  conn: WorkerConnection,
  sessionId: string,
  text: string,
  options: { timeoutMs: number; signal?: AbortSignal | undefined; onEvent?: ((event: WorkerEvent) => void) | undefined },
): Promise<TurnResult> {
  const texts: string[] = [];
  let settle: (result: TurnResult) => void = () => undefined;
  const done = new Promise<TurnResult>((resolve) => {
    settle = resolve;
  });
  const detach = conn.listen(sessionId, (event) => {
    options.onEvent?.(event);
    switch (event.type) {
      case "session.text.ended": {
        const value = event.data["text"];
        if (typeof value === "string" && value.length > 0) texts.push(value);
        break;
      }
      case "session.execution.succeeded":
        settle({ outcome: "succeeded", texts });
        break;
      case "session.execution.failed":
        settle({ outcome: "failed", texts, error: describeError(event.data["error"]) });
        break;
      case "session.execution.interrupted":
        settle({ outcome: "interrupted", texts, error: `interrupted: ${describeError(event.data["reason"])}` });
        break;
      default:
        break;
    }
  });
  const timer = setTimeout(() => settle({ outcome: "timeout", texts, error: `turn exceeded ${options.timeoutMs}ms` }), options.timeoutMs);
  const onAbort = (): void => settle({ outcome: "aborted", texts, error: "aborted by dispatcher" });
  options.signal?.addEventListener("abort", onAbort, { once: true });
  void conn.proc.exited.then((code) =>
    settle({ outcome: "exited", texts, error: `worker exited with code ${code}: ${conn.proc.tail()}` }),
  );
  try {
    if (options.signal?.aborted === true) {
      onAbort();
    } else {
      // Not awaited: a stalled admission request must not hold the turn
      // past its timeout, abort, or worker exit.
      conn.client.prompt(sessionId, text).catch((err: unknown) => {
        settle({ outcome: "failed", texts, error: (err as Error).message });
      });
    }
    return await done;
  } finally {
    clearTimeout(timer);
    options.signal?.removeEventListener("abort", onAbort);
    detach();
  }
}
