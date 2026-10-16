/**
 * NATS JetStream / KV bridge against a real `nats-server -js`.
 *
 * Uses `NATS_URL` when set; otherwise spawns `nats-server` from PATH (or
 * `NATS_SERVER_BIN`). CI installs nats-server; when no server is
 * available locally the integration test is skipped with a reason.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { createServer as createNetServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { connect } from "nats";
import { NatsJetStreamBridge, natsUrlFromEnv, redactNatsUrl, subjectFor } from "../src/nats-bridge.js";
import { createServer } from "../src/server.js";

function natsServerBinary(): string | null {
  const explicit = process.env["NATS_SERVER_BIN"];
  if (explicit !== undefined && explicit.length > 0) return explicit;
  return Bun.which("nats-server") ?? Bun.which("nats-server", { PATH: `${process.env["HOME"] ?? ""}/go/bin` });
}

async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const probe = createNetServer();
    probe.once("error", reject);
    probe.listen(0, "127.0.0.1", () => {
      const address = probe.address();
      const port = typeof address === "object" && address !== null ? address.port : 0;
      probe.close(() => resolve(port));
    });
  });
}

let url: string | null = natsUrlFromEnv();
let natsProc: ReturnType<typeof Bun.spawn> | null = null;
const binary = natsServerBinary();
const available = url !== null || binary !== null;

beforeAll(async () => {
  if (url !== null || binary === null) return;
  const port = await freePort();
  natsProc = Bun.spawn([binary, "-js", "-a", "127.0.0.1", "-p", String(port), "-sd", mkdtempSync(join(tmpdir(), "nats-js-"))], {
    stdout: "ignore",
    stderr: "ignore",
  });
  url = `nats://127.0.0.1:${port}`;
  const deadline = Date.now() + 10_000;
  for (;;) {
    try {
      const probe = await connect({ servers: url, timeout: 1000 });
      await probe.close();
      break;
    } catch (err) {
      if (Date.now() > deadline) throw err;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }
});

afterAll(() => {
  natsProc?.kill();
});

describe("nats bridge helpers", () => {
  test("NATS_URL parsing and subject mapping", () => {
    expect(natsUrlFromEnv({})).toBeNull();
    expect(natsUrlFromEnv({ NATS_URL: "  " })).toBeNull();
    expect(natsUrlFromEnv({ NATS_URL: "nats://127.0.0.1:4222" })).toBe("nats://127.0.0.1:4222");
    expect(subjectFor("worker.tool")).toBe("fleet.events.worker.tool");
    expect(redactNatsUrl("nats://127.0.0.1:4222")).toBe("nats://127.0.0.1:4222");
    expect(redactNatsUrl("nats://user:s3cret@host:4222")).toBe("nats://***@host:4222");
    expect(redactNatsUrl("tok@host:4222,nats://a:b@other:4222")).toBe("***@host:4222,nats://***@other:4222");
    // A comma inside the password leaves a fragment the split cannot attribute: log nothing of it.
    expect(redactNatsUrl("nats://user:sec,ret@host:4222")).toBe("<configured>");
    expect(subjectFor("a b.*.>")).toBe("fleet.events.a_b._._");
  });

  test("connecting to a dead endpoint fails instead of pretending", async () => {
    const port = await freePort();
    await expect(NatsJetStreamBridge.connect(`nats://127.0.0.1:${port}`)).rejects.toThrow();
  });
});

describe.skipIf(!available)("nats bridge against nats-server (JetStream)", () => {
  test("bus events land on the stream in order and tasks land in KV", async () => {
    const bridge = await NatsJetStreamBridge.connect(url!, { bucket: `fleet-board-${Date.now()}` });
    const start = (await bridge.lastSeq()) + 1;
    const app = createServer({});
    app.attachNats(bridge);
    app.bus.publish("probe.one", { index: 1 });
    app.upsertTask({ id: "task-n", status: "pending", title: "mirrored" });
    app.bus.publish("probe.two", { index: 2 });
    let events: Array<{ seq: number; subject: string; event: { type: string; data: unknown } }> = [];
    const deadline = Date.now() + 5000;
    while (events.length < 2 && Date.now() < deadline) {
      events = await bridge.replay(start, 10);
    }
    expect(events.map((entry) => entry.subject)).toEqual(["fleet.events.probe.one", "fleet.events.probe.two"]);
    expect(events.map((entry) => entry.seq)).toEqual([start, start + 1]);
    expect(events[1]?.event.data).toEqual({ index: 2 });
    let mirrored: unknown = null;
    while (mirrored === null && Date.now() < deadline) mirrored = await bridge.get("task-n");
    expect((mirrored as { title: string }).title).toBe("mirrored");
    await app.shutdown();
  });
});
