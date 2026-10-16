/**
 * Single-use human-approval preview tickets plus loopback Ed25519 helpers.
 *
 * A ticket is a random 256-bit token bound to `{ taskId, subjectHash }`
 * with a 60-second TTL. Verification is consume-on-verify: the first
 * successful `verifyTicket` / `redeemTicket` burns the ticket, and any
 * unknown, expired, reused, or binding-mismatched token is rejected
 * fail-closed with a descriptive error.
 *
 * Ed25519 approval signatures are created and verified with
 * `node:crypto` (in-memory only; no key material is ever persisted by
 * this module). Two authority modes are supported:
 *
 * - Random keypair (`generateApprovalKeyPair`): the human approves with
 *   a 1-click ephemeral key; the server verifies the signature over the
 *   exact `subjectHash` bytes against the presented public key.
 * - Passphrase-derived keypair (`passphraseToKeypair`): the 32-byte seed
 *   is `SHA-256("agency-approval-v1:" + passphrase)` imported as a PKCS8
 *   Ed25519 private key. A wrong passphrase derives a different public
 *   key, so verification fails closed. The passphrase itself lives only
 *   in the caller's closure and is never stored here.
 */
import {
  createHash,
  createPrivateKey,
  createPublicKey,
  generateKeyPairSync,
  randomBytes,
  sign,
  verify,
} from "node:crypto";

export const TICKET_TTL_MS = 60_000;
export const TICKET_BYTES = 32;

export interface TicketRecord {
  token: string;
  taskId: string;
  subjectHash: string;
  issuedAtMs: number;
  expiresAtMs: number;
  used: boolean;
}

export interface TicketBinding {
  taskId: string;
  subjectHash: string;
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

  constructor(clock: () => number = Date.now, ttlMs: number = TICKET_TTL_MS) {
    if (ttlMs <= 0) {
      throw new Error(`ticket TTL must be positive, got ${ttlMs}`);
    }
    this.clock = clock;
    this.ttlMs = ttlMs;
  }

  /** Mint a random 256-bit ticket bound to `{ taskId, subjectHash }`. */
  mintTicket(taskId: string, subjectHash: string): { token: string; expiresAtMs: number } {
    requireBinding(taskId, "task id");
    requireBinding(subjectHash, "subject hash");
    this.pruneExpired();
    const issuedAtMs = this.clock();
    const record: TicketRecord = {
      token: randomBytes(TICKET_BYTES).toString("hex"),
      taskId,
      subjectHash,
      issuedAtMs,
      expiresAtMs: issuedAtMs + this.ttlMs,
      used: false,
    };
    this.tickets.set(record.token, record);
    return { token: record.token, expiresAtMs: record.expiresAtMs };
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
    return { taskId: record.taskId, subjectHash: record.subjectHash };
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
    return { taskId: record.taskId, subjectHash: record.subjectHash };
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
export function mintTicket(taskId: string, subjectHash: string): { token: string; expiresAtMs: number } {
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

export interface ApprovalKeypair {
  publicKeyPem: string;
  privateKeyPem: string;
}

/** Random Ed25519 authority keypair (PEM-encoded PKCS8 / SPKI). */
export function generateApprovalKeyPair(): ApprovalKeypair {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  return {
    publicKeyPem: publicKey.export({ format: "pem", type: "spki" }) as string,
    privateKeyPem: privateKey.export({ format: "pem", type: "pkcs8" }) as string,
  };
}

/** PKCS8 DER prefix for an Ed25519 private key; concat with a 32-byte seed. */
const ED25519_PKCS8_PREFIX = Buffer.from("302e020100300506032b657004220420", "hex");

/**
 * Derive an Ed25519 keypair deterministically from a passphrase:
 * `seed = SHA-256("agency-approval-v1:" + passphrase)` imported as a
 * raw PKCS8 seed. Empty passphrases are rejected fail-closed. The
 * passphrase is used only inside this call and never retained.
 */
export function passphraseToKeypair(passphrase: string): ApprovalKeypair {
  if (passphrase.length === 0) {
    throw new Error("passphrase must not be empty");
  }
  const seed = createHash("sha256").update(`agency-approval-v1:${passphrase}`, "utf8").digest();
  const privateKey = createPrivateKey({
    key: Buffer.concat([ED25519_PKCS8_PREFIX, seed]),
    format: "der",
    type: "pkcs8",
  });
  const publicKey = createPublicKey(privateKey);
  return {
    publicKeyPem: publicKey.export({ format: "pem", type: "spki" }) as string,
    privateKeyPem: privateKey.export({ format: "pem", type: "pkcs8" }) as string,
  };
}

/** Sign the exact `subjectHash` bytes with an Ed25519 private key (PEM). Returns hex. */
export function signSubjectHash(privateKeyPem: string, subjectHash: string): string {
  const privateKey = createPrivateKey({ key: privateKeyPem, format: "pem" });
  return sign(null, Buffer.from(subjectHash, "utf8"), privateKey).toString("hex");
}

/**
 * Verify an Ed25519 signature over the exact `subjectHash` bytes.
 * Returns false (fail-closed) for malformed keys, malformed
 * signatures, and genuine mismatches alike.
 */
export function verifyApprovalSignature(publicKeyPem: string, subjectHash: string, signatureHex: string): boolean {
  try {
    if (!/^[0-9a-fA-F]+$/.test(signatureHex) || signatureHex.length % 2 !== 0) {
      return false;
    }
    const publicKey = createPublicKey({ key: publicKeyPem, format: "pem" });
    return verify(null, Buffer.from(subjectHash, "utf8"), publicKey, Buffer.from(signatureHex, "hex"));
  } catch {
    return false;
  }
}
