/**
 * Ring-buffered event bus with SSE serialization.
 *
 * The in-process bus is a bounded ring buffer (default 1000 events) with
 * monotonic sequence IDs. When the buffer overflows the oldest events are
 * dropped and the next replay carries a sequence-gap marker, so SSE
 * consumers can detect the hole instead of silently missing history.
 * Subscribers replay from any sequence ID, then receive live events.
 *
 * When `NATS_URL` is set, `nats-bridge.ts` mirrors every bus event into
 * a NATS JetStream stream and the board into a JetStream KV bucket; the
 * in-process ring stays the source of truth for SSE replay either way.
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
