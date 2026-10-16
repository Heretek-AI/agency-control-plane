#!/usr/bin/env bun
/**
 * Fake OpenCode v2 server for launcher / Director tests.
 *
 * Implements exactly the routes the dispatcher uses, with the real wire
 * shapes: `POST /api/session`, `POST /api/session/:id/prompt`, and the
 * `GET /api/event` SSE feed (`data: {"id","type","data"}` frames), behind
 * HTTP Basic auth `opencode:$OPENCODE_SERVER_PASSWORD`. Prints
 * `server listening on <url>` like `opencode serve`.
 *
 * Behavior is chosen by the prompt text so one binary covers every case:
 * - worker prompts containing `[fail]` emit `session.execution.failed`,
 *   `[crash]` exits the process, `[hang]` never finishes, `[noop]`
 *   succeeds without touching files; otherwise the worker writes
 *   `fleet-output/<session>.txt` in its cwd via a `write` tool call.
 * - Director sessions (agent `director`) reply with a valid ```tasks
 *   block when asked to "plan", an invalid one for "bad plan", and plain
 *   text otherwise; every reply states the turn number.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";

const password = process.env["OPENCODE_SERVER_PASSWORD"] ?? "";
const dbPath = process.env["OPENCODE_DB"];
if (dbPath !== undefined) {
  mkdirSync(path.dirname(dbPath), { recursive: true });
  writeFileSync(dbPath, `fake-opencode pid ${process.pid}\n`);
}

interface FakeSession {
  id: string;
  agent: string | undefined;
  directory: string;
  turns: number;
}

const sessions = new Map<string, FakeSession>();
const subscribers = new Set<ReadableStreamDefaultController<Uint8Array>>();
const encoder = new TextEncoder();
let counter = 0;

function emit(type: string, data: Record<string, unknown>): void {
  counter += 1;
  const frame = encoder.encode(`data: ${JSON.stringify({ id: `evt_${counter}`, type, data })}\n\n`);
  for (const controller of subscribers) {
    try {
      controller.enqueue(frame);
    } catch {
      subscribers.delete(controller);
    }
  }
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

const PLAN = [
  { key: "api", title: "Build query API", objective: "Add the query API", paths: ["src/api.ts"], acceptance: ["returns 200"] },
  { key: "docs", title: "Document query API", deps: ["api"], paths: ["docs/*"] },
];

async function runDirector(session: FakeSession, text: string): Promise<void> {
  const sessionID = session.id;
  let reply = `Director turn ${session.turns} (preamble ${text.includes("```tasks") ? "seen" : "absent"}).`;
  // Only the human's message (after the preamble separator) steers the fake.
  const human = text.split("\n---\n").at(-1) ?? text;
  if (/bad plan/i.test(human)) {
    reply += '\n\n```tasks\n[{"title": "", "bogus": true}]\n```';
  } else if (/plan/i.test(human)) {
    reply += `\nHere is the plan.\n\n\`\`\`tasks\n${JSON.stringify(PLAN, null, 2)}\n\`\`\``;
  }
  await sleep(5);
  emit("session.text.ended", { sessionID, assistantMessageID: `msg_${counter}`, ordinal: 0, text: reply });
  emit("session.status", { sessionID, status: { type: "idle" } });
  emit("session.execution.succeeded", { sessionID });
}

async function runWorker(session: FakeSession, text: string): Promise<void> {
  const sessionID = session.id;
  const assistantMessageID = `msg_${counter}`;
  if (text.includes("[crash]")) {
    await sleep(5);
    process.exit(7);
  }
  if (text.includes("[hang]")) return;
  if (text.includes("[fail]")) {
    await sleep(5);
    emit("session.execution.failed", { sessionID, error: { type: "provider", message: "model exploded" } });
    return;
  }
  if (!text.includes("[noop]")) {
    const target = path.join("fleet-output", `${sessionID}.txt`);
    emit("session.tool.input.started", { sessionID, assistantMessageID, id: "call_1", name: "write" });
    emit("session.tool.called", { sessionID, assistantMessageID, id: "call_1", input: { filePath: target }, executed: true });
    mkdirSync(path.join(session.directory, "fleet-output"), { recursive: true });
    writeFileSync(path.join(session.directory, target), `${text.split("\n")[0]}\n`);
    await sleep(5);
    emit("session.tool.success", {
      sessionID,
      assistantMessageID,
      id: "call_1",
      content: [{ type: "text", text: `wrote ${target}` }],
      executed: true,
    });
  }
  emit("session.text.ended", { sessionID, assistantMessageID, ordinal: 0, text: "worker done" });
  emit("session.execution.succeeded", { sessionID });
}

const server = Bun.serve({
  hostname: "127.0.0.1",
  port: 0,
  idleTimeout: 0,
  async fetch(req) {
    const expected = `Basic ${Buffer.from(`opencode:${password}`).toString("base64")}`;
    if (password.length === 0 || req.headers.get("authorization") !== expected) {
      return new Response("unauthorized", { status: 401 });
    }
    const url = new URL(req.url);
    if (req.method === "GET" && url.pathname === "/api/event") {
      const stream = new ReadableStream<Uint8Array>({
        start(controller) {
          subscribers.add(controller);
          controller.enqueue(encoder.encode(`data: ${JSON.stringify({ id: "evt_0", type: "server.connected", data: {} })}\n\n`));
          req.signal.addEventListener("abort", () => subscribers.delete(controller));
        },
      });
      return new Response(stream, { headers: { "content-type": "text/event-stream" } });
    }
    if (req.method === "POST" && url.pathname === "/api/session") {
      const body = (await req.json()) as { location?: { directory?: string }; agent?: string };
      const directory = body.location?.directory;
      if (typeof directory !== "string" || !path.isAbsolute(directory)) {
        return Response.json({ error: "location.directory must be absolute" }, { status: 400 });
      }
      const id = `ses_${sessions.size + 1}_${process.pid}`;
      sessions.set(id, { id, agent: body.agent, directory, turns: 0 });
      return Response.json({ data: { id, agent: body.agent ?? null, location: { directory } } });
    }
    const prompt = /^\/api\/session\/([^/]+)\/prompt$/.exec(url.pathname);
    if (req.method === "POST" && prompt !== null) {
      const session = sessions.get(decodeURIComponent(prompt[1] ?? ""));
      if (session === undefined) return Response.json({ error: "session not found" }, { status: 404 });
      const body = (await req.json()) as { text?: unknown };
      if (typeof body.text !== "string" || body.text.length === 0) {
        return Response.json({ error: "text required" }, { status: 400 });
      }
      session.turns += 1;
      const text = body.text;
      setTimeout(() => {
        emit("session.execution.started", { sessionID: session.id });
        emit("session.status", { sessionID: session.id, status: { type: "busy" } });
        void (session.agent === "director" ? runDirector(session, text) : runWorker(session, text));
      }, 5);
      return Response.json({ data: { id: `inbox_${session.turns}`, sessionID: session.id } });
    }
    return Response.json({ error: "not found" }, { status: 404 });
  },
});

console.log(`server listening on http://127.0.0.1:${server.port}`);
for (const signal of ["SIGTERM", "SIGINT"] as const) {
  process.on(signal, () => {
    void server.stop(true);
    process.exit(0);
  });
}
