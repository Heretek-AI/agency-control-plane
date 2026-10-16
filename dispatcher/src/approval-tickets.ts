/**
 * Single-use human-approval preview tickets.
 *
 * A ticket is a random 256-bit token bound to `{ taskId, subjectHash }`
 * with a 60-second TTL and a server-chosen, strictly increasing ISO
 * `timestamp`. The human signs the es-core-compatible payload
 * `{ runId: taskId, stage, subjectHash, timestamp }` taken verbatim from
 * the ticket (see `human-key.ts`), so a signature is only ever valid for
 * one ticket. Verification is consume-on-verify: the first
 * `verifyTicket` / `redeemTicket` burns the ticket, and any unknown,
 * expired, reused, or binding-mismatched token is rejected fail-closed.
 *
 * Signature verification lives in `human-key.ts` and only ever uses the
 * pinned human public key; this module holds no key material.
 */
import { createHash, randomBytes } from "node:crypto";

export const TICKET_TTL_MS = 60_000;
export const TICKET_BYTES = 32;

export interface TicketRecord {
  token: string;
  taskId: string;
  subjectHash: string;
  /** ISO timestamp the human signs; unique per store (strictly increasing). */
  timestamp: string;
  issuedAtMs: number;
  expiresAtMs: number;
  used: boolean;
}

export interface TicketBinding {
  taskId: string;
  subjectHash: string;
  timestamp: string;
}

export interface MintedTicket {
  token: string;
  expiresAtMs: number;
  timestamp: string;
}

export class TicketError extends Error {
  readonly code: "unknown-ticket" | "expired-ticket" | "reused-ticket" | "binding-mismatch";
  constructor(code: TicketError["code"], message: string) {
    super(message);
    this.name = "TicketError";
    this.code = code;
  }
}

/** SHA-256 hex of approval-subject content (diff summary, QA verdicts). */
export function hashSubject(content: string): string {
  return createHash("sha256").update(content, "utf8").digest("hex");
}

function requireBinding(value: string, kind: "task id" | "subject hash"): void {
  if (value.trim().length === 0) {
    throw new TicketError("binding-mismatch", `ticket ${kind} must not be empty`);
  }
}

/**
 * Single-use ticket store. Pass a custom clock for deterministic TTL
 * tests; production uses `Date.now`.
 */
export class TicketStore {
  private readonly tickets = new Map<string, TicketRecord>();
  private readonly clock: () => number;
  private readonly ttlMs: number;
  private lastStampMs = 0;

  constructor(clock: () => number = Date.now, ttlMs: number = TICKET_TTL_MS) {
    if (ttlMs <= 0) {
      throw new Error(`ticket TTL must be positive, got ${ttlMs}`);
    }
    this.clock = clock;
    this.ttlMs = ttlMs;
  }

  /** Mint a random 256-bit ticket bound to `{ taskId, subjectHash }`. */
  mintTicket(taskId: string, subjectHash: string): MintedTicket {
    requireBinding(taskId, "task id");
    requireBinding(subjectHash, "subject hash");
    this.pruneExpired();
    const issuedAtMs = this.clock();
    // Strictly increasing signed timestamps: two tickets never share a
    // payload, so a signature can never be replayed onto another ticket.
    const stampMs = Math.max(issuedAtMs, this.lastStampMs + 1);
    this.lastStampMs = stampMs;
    const record: TicketRecord = {
      token: randomBytes(TICKET_BYTES).toString("hex"),
      taskId,
      subjectHash,
      timestamp: new Date(stampMs).toISOString(),
      issuedAtMs,
      expiresAtMs: issuedAtMs + this.ttlMs,
      used: false,
    };
    this.tickets.set(record.token, record);
    return { token: record.token, expiresAtMs: record.expiresAtMs, timestamp: record.timestamp };
  }

  /** Consume-on-verify: returns the binding and burns the ticket. Fail-closed on unknown/expired/reused tokens. */
  verifyTicket(token: string): TicketBinding {
    const record = this.tickets.get(token);
    if (record === undefined) {
      throw new TicketError("unknown-ticket", "approval ticket is unknown or was never minted");
    }
    if (record.used) {
      throw new TicketError("reused-ticket", "approval ticket has already been used");
    }
    if (this.clock() > record.expiresAtMs) {
      this.tickets.delete(token);
      throw new TicketError("expired-ticket", "approval ticket has expired");
    }
    record.used = true;
    return { taskId: record.taskId, subjectHash: record.subjectHash, timestamp: record.timestamp };
  }

  /**
   * Verify, check the `{ taskId, subjectHash }` binding, then consume.
   * The binding is checked BEFORE consumption bookkeeping completes,
   * but a mismatched ticket is still burned so it cannot be retried
   * against another task (fail-closed single-use).
   */
  redeemTicket(token: string, taskId: string, subjectHash: string): TicketBinding {
    const record = this.tickets.get(token);
    if (record === undefined) {
      throw new TicketError("unknown-ticket", "approval ticket is unknown or was never minted");
    }
    if (record.used) {
      throw new TicketError("reused-ticket", "approval ticket has already been used");
    }
    if (this.clock() > record.expiresAtMs) {
      this.tickets.delete(token);
      throw new TicketError("expired-ticket", "approval ticket has expired");
    }
    record.used = true;
    if (record.taskId !== taskId || record.subjectHash !== subjectHash) {
      throw new TicketError(
        "binding-mismatch",
        `approval ticket is bound to task ${JSON.stringify(record.taskId)}, not ${JSON.stringify(taskId)}`,
      );
    }
    return { taskId: record.taskId, subjectHash: record.subjectHash, timestamp: record.timestamp };
  }

  /** Live (unexpired, unused) ticket count, after pruning. */
  liveCount(): number {
    this.pruneExpired();
    let live = 0;
    for (const record of this.tickets.values()) {
      if (!record.used) live += 1;
    }
    return live;
  }

  private pruneExpired(): void {
    const now = this.clock();
    for (const [token, record] of this.tickets) {
      if (!record.used && now > record.expiresAtMs) {
        this.tickets.delete(token);
      }
    }
  }
}

const defaultStore = new TicketStore();

/** Mint from the module-default store (60s TTL). */
export function mintTicket(taskId: string, subjectHash: string): MintedTicket {
  return defaultStore.mintTicket(taskId, subjectHash);
}

/** Consume-on-verify from the module-default store. */
export function verifyTicket(token: string): TicketBinding {
  return defaultStore.verifyTicket(token);
}

/** Binding-checked redeem from the module-default store. */
export function redeemTicket(token: string, taskId: string, subjectHash: string): TicketBinding {
  return defaultStore.redeemTicket(token, taskId, subjectHash);
}
