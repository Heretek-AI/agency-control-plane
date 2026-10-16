/**
 * NATS JetStream / KV blackboard bridge (enabled by `NATS_URL`).
 *
 * - Every dispatcher bus event is published to JetStream subject
 *   `fleet.events.<type>` on stream `FLEET_EVENTS` (bounded: drop-oldest
 *   at `capacity` messages, mirroring the in-process ring).
 * - Every task document is mirrored into KV bucket `fleet-board`
 *   (key = task id), so external agents can read the blackboard.
 *
 * The in-process `EventBus` stays the source of truth for SSE replay; a
 * NATS outage never blocks the dispatcher. Publish failures are counted
 * and reported once per outage on the bus as `nats.error`.
 */
import {
  connect,
  DeliverPolicy,
  DiscardPolicy,
  JSONCodec,
  RetentionPolicy,
  StorageType,
  type JetStreamClient,
  type KV,
  type NatsConnection,
} from "nats";
import type { EventBus, FleetEvent } from "./event-bus.js";

export const FLEET_STREAM = "FLEET_EVENTS";
export const FLEET_SUBJECT_PREFIX = "fleet.events";
export const FLEET_KV_BUCKET = "fleet-board";

/** `NATS_URL` from the environment, or null when unset/blank. */
export function natsUrlFromEnv(env: Record<string, string | undefined> = process.env): string | null {
  const url = env["NATS_URL"];
  return url !== undefined && url.trim().length > 0 ? url.trim() : null;
}

/** `NATS_URL` with any userinfo (user, password, token) replaced by `***`, for logs. */
export function redactNatsUrl(url: string): string {
  return url
    .split(",")
    .map((server) => {
      const at = server.lastIndexOf("@");
      if (at === -1) return server;
      const scheme = server.indexOf("://");
      const prefix = scheme !== -1 && scheme < at ? server.slice(0, scheme + 3) : "";
      return `${prefix}***@${server.slice(at + 1)}`;
    })
    .join(",");
}

/** JetStream subject for a bus event type (tokens restricted to `[A-Za-z0-9_-]`). */
export function subjectFor(type: string): string {
  const tokens = type.split(".").map((token) => token.replace(/[^A-Za-z0-9_-]/g, "_")).filter((token) => token.length > 0);
  return `${FLEET_SUBJECT_PREFIX}.${tokens.length > 0 ? tokens.join(".") : "_"}`;
}

export interface NatsBridgeOptions {
  stream?: string | undefined;
  bucket?: string | undefined;
  /** Max messages retained on the stream (drop-oldest). */
  capacity?: number | undefined;
  /** Connection name shown in NATS monitoring. */
  name?: string | undefined;
}

const codec = JSONCodec<unknown>();

export class NatsJetStreamBridge {
  private constructor(
    private readonly nc: NatsConnection,
    private readonly js: JetStreamClient,
    private readonly kv: KV,
    readonly stream: string,
  ) {}

  /** Connect, then create or update the event stream and KV bucket. Throws when NATS is unreachable. */
  static async connect(url: string, options: NatsBridgeOptions = {}): Promise<NatsJetStreamBridge> {
    const stream = options.stream ?? FLEET_STREAM;
    const nc = await connect({ servers: url, name: options.name ?? "agency-dispatcher", timeout: 5000 });
    try {
      const jsm = await nc.jetstreamManager();
      const config = {
        name: stream,
        subjects: [`${FLEET_SUBJECT_PREFIX}.>`],
        retention: RetentionPolicy.Limits,
        storage: StorageType.File,
        discard: DiscardPolicy.Old,
        max_msgs: options.capacity ?? 10_000,
      };
      let exists = true;
      try {
        await jsm.streams.info(stream);
      } catch {
        exists = false;
      }
      // Only a missing stream is created; an update error surfaces as-is.
      if (exists) await jsm.streams.update(stream, config);
      else await jsm.streams.add(config);
      const js = nc.jetstream();
      const kv = await js.views.kv(options.bucket ?? FLEET_KV_BUCKET, { history: 1 });
      return new NatsJetStreamBridge(nc, js, kv, stream);
    } catch (err) {
      await nc.close();
      throw err;
    }
  }

  /** Publish one bus event; resolves with the JetStream stream sequence. */
  async publishEvent(event: FleetEvent): Promise<number> {
    const ack = await this.js.publish(subjectFor(event.type), codec.encode(event), { msgID: event.id });
    return ack.seq;
  }

  /** Mirror one blackboard document; resolves with the KV revision. */
  async put(key: string, value: unknown): Promise<number> {
    return this.kv.put(key, codec.encode(value));
  }

  /** Read one blackboard document, or null when absent. */
  async get(key: string): Promise<unknown> {
    const entry = await this.kv.get(key);
    if (entry === null || entry.operation !== "PUT") return null;
    return codec.decode(entry.value);
  }

  /** Last sequence currently stored on the event stream (0 when empty). */
  async lastSeq(): Promise<number> {
    const jsm = await this.nc.jetstreamManager();
    return (await jsm.streams.info(this.stream)).state.last_seq;
  }

  /** Replay up to `max` events from stream sequence `fromSeq` (ordered consumer). */
  async replay(fromSeq: number, max: number): Promise<Array<{ seq: number; subject: string; event: FleetEvent }>> {
    const consumer = await this.js.consumers.get(this.stream, {
      deliver_policy: DeliverPolicy.StartSequence,
      opt_start_seq: Math.max(1, Math.floor(fromSeq)),
    });
    const out: Array<{ seq: number; subject: string; event: FleetEvent }> = [];
    const batch = await consumer.fetch({ max_messages: max, expires: 2000 });
    for await (const message of batch) {
      out.push({ seq: message.seq, subject: message.subject, event: codec.decode(message.data) as FleetEvent });
      if (out.length >= max) break;
    }
    return out;
  }

  async close(): Promise<void> {
    await this.nc.drain();
  }
}

/**
 * Mirror every bus event into JetStream. Returns the detach function.
 * Failures never throw into the bus; the first failure of an outage is
 * published on the bus as `nats.error` (and recovery as `nats.recovered`).
 */
export function attachBusToNats(bus: EventBus, bridge: NatsJetStreamBridge): () => void {
  let failing = false;
  const subscription = bus.subscribe(bus.tipSeq() + 1, (event) => {
    if (event.type === "nats.error" || event.type === "nats.recovered") return;
    bridge.publishEvent(event).then(
      () => {
        if (failing) {
          failing = false;
          bus.publish("nats.recovered", { seq: event.seq });
        }
      },
      (err: unknown) => {
        if (!failing) {
          failing = true;
          bus.publish("nats.error", { seq: event.seq, error: (err as Error).message });
        }
      },
    );
  });
  return subscription.unsubscribe;
}
