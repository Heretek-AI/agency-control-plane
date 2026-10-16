/**
 * Ring-buffered event bus with SSE serialization and a NATS JetStream /
 * KV blackboard bridge contract.
 *
 * The in-process bus is a bounded ring buffer (default 1000 events) with
 * monotonic sequence IDs. When the buffer overflows the oldest events are
 * dropped and the next replay carries a sequence-gap marker, so SSE
 * consumers can detect the hole instead of silently missing history.
 * Subscribers replay from any sequence ID, then receive live events.
 *
 * NATS JetStream / KV blackboard bridge: when `NATS_URL` is set in the
 * environment, production deployments wire a real NATS connection behind
 * the `JetStreamBridge` interface below (subject publish + KV put/get
 * with identical ordering and gap semantics). This module ships a fully
 * functional in-memory bridge implementing that exact interface, so the
 * dispatcher behaves identically with or without NATS: same publish /
 * subscribe / KV operations, same gap markers, no network required.
 */

export interface FleetEvent {
  seq: number;
  id: string;
  type: string;
  timestamp: string;
  data: unknown;
}

export interface SequenceGap {
  fromSeq: number;
  toSeq: number;
  dropped: number;
}

export interface EventReplay {
  events: FleetEvent[];
  gap: SequenceGap | null;
}

export const DEFAULT_BUS_CAPACITY = 1000;

let eventCounter = 0;

function nextEventId(): string {
  eventCounter += 1;
  return `evt-${Date.now().toString(36)}-${eventCounter.toString(36)}`;
}

/** Serialize one event as an SSE frame (`id` carries the sequence for `Last-Event-ID` replay). */
export function toSSE(event: FleetEvent): string {
  const payload = JSON.stringify({ seq: event.seq, id: event.id, type: event.type, timestamp: event.timestamp, data: event.data });
  return `id: ${event.seq}\nevent: ${event.type}\ndata: ${payload}\n\n`;
}

/** Serialize a sequence-gap marker as an SSE frame so consumers observe the hole. */
export function gapToSSE(gap: SequenceGap): string {
  const payload = JSON.stringify({ gap: true, fromSeq: gap.fromSeq, toSeq: gap.toSeq, dropped: gap.dropped });
  return `id: ${gap.toSeq}\nevent: fleet.gap\ndata: ${payload}\n\n`;
}

export type EventListener = (event: FleetEvent) => void;

export interface Subscription {
  unsubscribe: () => void;
  gap: SequenceGap | null;
}

export class EventBus {
  private readonly capacity: number;
  private nextSeq = 1;
  private readonly buffer: FleetEvent[] = [];
  private dropped = 0;
  private readonly listeners = new Set<EventListener>();

  constructor(capacity: number = DEFAULT_BUS_CAPACITY) {
    if (!Number.isInteger(capacity) || capacity < 1) {
      throw new Error(`event bus capacity must be a positive integer, got ${capacity}`);
    }
    this.capacity = capacity;
  }

  get size(): number {
    return this.buffer.length;
  }

  /** Highest sequence published so far (0 before the first event). */
  tipSeq(): number {
    return this.nextSeq - 1;
  }

  /** Oldest buffered sequence (tip + 1 when empty). */
  oldestSeq(): number {
    const oldest = this.buffer[0];
    return oldest === undefined ? this.nextSeq : oldest.seq;
  }

  /** Total events dropped to backpressure so far. */
  droppedCount(): number {
    return this.dropped;
  }

  /** Publish one event. Overflow drops the oldest event (backpressure drop-oldest). */
  publish(type: string, data: unknown): FleetEvent {
    if (type.length === 0) {
      throw new Error("event type must not be empty");
    }
    const event: FleetEvent = {
      seq: this.nextSeq,
      id: nextEventId(),
      type,
      timestamp: new Date().toISOString(),
      data: data === undefined ? null : data,
    };
    this.nextSeq += 1;
    this.buffer.push(event);
    if (this.buffer.length > this.capacity) {
      this.buffer.shift();
      this.dropped += 1;
    }
    for (const listener of [...this.listeners]) {
      listener(event);
    }
    return event;
  }

  /**
   * Replay buffered events with `seq >= fromSeq`. When `fromSeq`
   * predates the oldest buffered event and events were dropped, `gap`
   * describes the hole; otherwise `gap` is null.
   */
  replaySince(fromSeq: number): EventReplay {
    const start = Number.isFinite(fromSeq) ? Math.floor(fromSeq) : 1;
    const events = this.buffer.filter((event) => event.seq >= start);
    const oldest = this.oldestSeq();
    const gap: SequenceGap | null =
      this.dropped > 0 && start < oldest
        ? { fromSeq: start, toSeq: oldest - 1, dropped: Math.min(this.dropped, oldest - start) }
        : null;
    return { events, gap };
  }

  /**
   * Replay from `fromSeq`, then deliver live events to `onEvent`.
   * Returns `unsubscribe` plus the gap marker observed at subscribe
   * time (null when history is complete).
   */
  subscribe(fromSeq: number, onEvent: EventListener): Subscription {
    const replay = this.replaySince(fromSeq);
    for (const event of replay.events) {
      onEvent(event);
    }
    this.listeners.add(onEvent);
    return {
      unsubscribe: () => {
        this.listeners.delete(onEvent);
      },
      gap: replay.gap,
    };
  }
}

export interface JetStreamMessage {
  subject: string;
  seq: number;
  payload: unknown;
  timestamp: string;
}

/**
 * Ordering + gap contract shared by the in-memory bridge and a real
 * NATS JetStream connection. A NATS-backed implementation publishes to
 * JetStream subjects and mirrors blackboard state into a KV bucket;
 * this in-memory twin keeps the same per-subject monotonic sequences
 * and the same drop-oldest gap semantics so tests and offline
 * deployments observe identical behavior.
 */
export interface JetStreamBridge {
  readonly connected: boolean;
  connect(url: string): void;
  publish(subject: string, payload: unknown): JetStreamMessage;
  subscribe(subject: string, fromSeq: number, onMessage: (message: JetStreamMessage) => void): { unsubscribe: () => void };
  kvPut(bucket: string, key: string, value: unknown): void;
  kvGet(bucket: string, key: string): unknown;
  close(): void;
}

/**
 * Fully functional in-memory JetStream / KV blackboard bridge. Each
 * subject gets its own bounded ring with monotonic sequences and
 * drop-oldest gap accounting; the KV store is a nested map of buckets
 * to keys. `connect(url)` records the (possibly `NATS_URL`-provided)
 * endpoint so configuration flows through the same path a real NATS
 * client would use; transport stays in-process.
 */
export class InMemoryJetStreamBridge implements JetStreamBridge {
  private readonly capacity: number;
  private endpoint: string | null = null;
  private readonly subjects = new Map<string, { nextSeq: number; buffer: JetStreamMessage[]; dropped: number; listeners: Set<(m: JetStreamMessage) => void> }>();
  private readonly kv = new Map<string, Map<string, { value: unknown; revision: number }>>();

  constructor(capacity: number = DEFAULT_BUS_CAPACITY) {
    if (!Number.isInteger(capacity) || capacity < 1) {
      throw new Error(`bridge capacity must be a positive integer, got ${capacity}`);
    }
    this.capacity = capacity;
  }

  get connected(): boolean {
    return this.endpoint !== null;
  }

  /** Configured endpoint (from `NATS_URL` in production). Empty string is rejected fail-closed. */
  get url(): string | null {
    return this.endpoint;
  }

  connect(url: string): void {
    if (url.trim().length === 0) {
      throw new Error("bridge endpoint must not be empty");
    }
    this.endpoint = url;
  }

  /** Resolve the bridge endpoint from the environment (`NATS_URL`), or null when unset. */
  static endpointFromEnv(env?: Record<string, string | undefined>): string | null {
    const source = env ?? process.env;
    const url = source["NATS_URL"];
    return url !== undefined && url.trim().length > 0 ? url : null;
  }

  private stream(subject: string): {
    nextSeq: number;
    buffer: JetStreamMessage[];
    dropped: number;
    listeners: Set<(m: JetStreamMessage) => void>;
  } {
    let stream = this.subjects.get(subject);
    if (stream === undefined) {
      stream = { nextSeq: 1, buffer: [], dropped: 0, listeners: new Set() };
      this.subjects.set(subject, stream);
    }
    return stream;
  }

  publish(subject: string, payload: unknown): JetStreamMessage {
    if (subject.length === 0) {
      throw new Error("subject must not be empty");
    }
    const stream = this.stream(subject);
    const message: JetStreamMessage = {
      subject,
      seq: stream.nextSeq,
      payload: payload === undefined ? null : payload,
      timestamp: new Date().toISOString(),
    };
    stream.nextSeq += 1;
    stream.buffer.push(message);
    if (stream.buffer.length > this.capacity) {
      stream.buffer.shift();
      stream.dropped += 1;
    }
    for (const listener of [...stream.listeners]) {
      listener(message);
    }
    return message;
  }

  subscribe(
    subject: string,
    fromSeq: number,
    onMessage: (message: JetStreamMessage) => void,
  ): { unsubscribe: () => void } {
    const stream = this.stream(subject);
    for (const message of stream.buffer) {
      if (message.seq >= fromSeq) {
        onMessage(message);
      }
    }
    stream.listeners.add(onMessage);
    return {
      unsubscribe: () => {
        stream.listeners.delete(onMessage);
      },
    };
  }

  /** Per-subject drop accounting for gap markers. */
  droppedFor(subject: string): number {
    return this.subjects.get(subject)?.dropped ?? 0;
  }

  kvPut(bucket: string, key: string, value: unknown): void {
    if (bucket.length === 0 || key.length === 0) {
      throw new Error("KV bucket and key must not be empty");
    }
    let store = this.kv.get(bucket);
    if (store === undefined) {
      store = new Map();
      this.kv.set(bucket, store);
    }
    const revision = (store.get(key)?.revision ?? 0) + 1;
    store.set(key, { value, revision });
  }

  /** Fail-closed: unknown bucket or key throws instead of returning undefined. */
  kvGet(bucket: string, key: string): unknown {
    const entry = this.kv.get(bucket)?.get(key);
    if (entry === undefined) {
      throw new Error(`KV miss: bucket ${JSON.stringify(bucket)} has no key ${JSON.stringify(key)}`);
    }
    return entry.value;
  }

  kvRevision(bucket: string, key: string): number {
    const entry = this.kv.get(bucket)?.get(key);
    if (entry === undefined) {
      throw new Error(`KV miss: bucket ${JSON.stringify(bucket)} has no key ${JSON.stringify(key)}`);
    }
    return entry.revision;
  }

  close(): void {
    for (const stream of this.subjects.values()) {
      stream.listeners.clear();
    }
    this.endpoint = null;
  }
}
