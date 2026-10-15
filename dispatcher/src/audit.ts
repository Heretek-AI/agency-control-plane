/**
 * Tamper-evident hash-chained JSONL audit ledger.
 *
 * One JSON object per line:
 * `{ seq, timestamp, event, data, prevHash, hash }` where
 * `hash = SHA-256(prevHash + ":" + canonicalJson({ seq, timestamp, event, data }))`.
 *
 * - Secrets are redacted BEFORE hashing, so plaintext secrets never reach
 *   the log and redaction is covered by the chain.
 * - Appends use `O_APPEND` plus `fsync` per record; earlier bytes are never
 *   rewritten through this module.
 * - A torn final line (crash mid-write, missing trailing newline, or an
 *   unparseable line) fails closed with its byte offset.
 * - `checkAnchor` replays the whole chain: any byte modification or
 *   equal-length rewrite that does not recompute every downstream hash
 *   fails. Pass a previously observed `{ seq, hash }` tip to also defeat a
 *   wholesale rewrite that merely re-chains valid hashes.
 */
import { createHash } from "node:crypto";
import { closeSync, fsyncSync, openSync, readFileSync, writeSync } from "node:fs";

export interface AuditRecord {
  seq: number;
  timestamp: string;
  event: string;
  data: unknown;
  prevHash: string;
  hash: string;
}

export interface AuditAnchor {
  seq: number;
  hash: string;
}

export interface AnchorCheck {
  ok: boolean;
  records: number;
  reason?: string;
}

export const GENESIS_HASH = "0".repeat(64);

const REDACTED = "[REDACTED]";

export class TornLogError extends Error {
  readonly offset: number;
  constructor(offset: number) {
    super(`audit log has a torn final line at byte offset ${offset}; repair by moving the fragment aside`);
    this.name = "TornLogError";
    this.offset = offset;
  }
}

/** SHA-256 of a UTF-8 string, hex-encoded. */
export function sha256Hex(input: string): string {
  return createHash("sha256").update(input, "utf8").digest("hex");
}

/** Stable JSON encoding: sorted keys, no whitespace, undefined dropped. */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`);
  return `{${entries.join(",")}}`;
}

function redactSecretsText(text: string): string {
  let out = text;
  out = out.replace(/sk-[A-Za-z0-9-_]{8,}/g, REDACTED);
  out = out.replace(/xox[bap]-[-A-Za-z0-9]+/g, REDACTED);
  out = out.replace(/gh[pousr]_[A-Za-z0-9_]{8,}/g, REDACTED);
  out = out.replace(/(Bearer\s+)[A-Za-z0-9\-._~+/=]+/gi, `$1${REDACTED}`);
  out = out.replace(/OPENCODE_API_KEY/g, REDACTED);
  out = out.replace(
    /((?:api[_-]?key|secret|password|passwd|token)\s*[:=]\s*)(['"]?)[^\s'";,]{1,}(['"]?)/gi,
    `$1$2${REDACTED}$3`,
  );
  return out;
}

const SENSITIVE_KEY = /secret|password|token|api[_-]?key|OPENCODE_API_KEY/i;

/** Redact every likely secret in a JSON-shaped structure. Idempotent. */
export function redactJson<T>(value: T): T {
  if (typeof value === "string") return redactSecretsText(value) as T;
  if (Array.isArray(value)) return value.map(redactJson) as T;
  if (value !== null && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      if (SENSITIVE_KEY.test(k)) {
        out[k] = typeof v === "string" ? REDACTED : redactJson(v);
      } else {
        out[k] = redactJson(v);
      }
    }
    return out as T;
  }
  return value;
}

/** Next link in the chain. `data` must already be redacted. */
export function entryHash(entry: Omit<AuditRecord, "hash">): string {
  return sha256Hex(
    `${entry.prevHash}:${canonicalJson({
      seq: entry.seq,
      timestamp: entry.timestamp,
      event: entry.event,
      data: entry.data,
    })}`,
  );
}

/** Build one record. `data` is redacted before hashing. Exported for tests. */
export function createRecord(
  prevHash: string,
  seq: number,
  event: string,
  data: unknown,
): AuditRecord {
  const record: AuditRecord = {
    seq,
    timestamp: new Date().toISOString(),
    event,
    data: data === undefined ? null : redactJson(data),
    prevHash,
    hash: "",
  };
  return { ...record, hash: entryHash(record) };
}

export function parseRecord(line: string): AuditRecord {
  const raw = JSON.parse(line) as AuditRecord;
  if (
    typeof raw.seq !== "number" ||
    typeof raw.timestamp !== "string" ||
    typeof raw.event !== "string" ||
    typeof raw.prevHash !== "string" ||
    typeof raw.hash !== "string"
  ) {
    throw new Error("malformed audit record");
  }
  return raw;
}

interface ParsedLog {
  records: AuditRecord[];
  bytes: Buffer;
}

function readLog(logPath: string): ParsedLog {
  let bytes: Buffer;
  try {
    bytes = readFileSync(logPath);
  } catch (err) {
    if ((err as NodeJS.ErrnoException)?.code === "ENOENT") {
      return { records: [], bytes: Buffer.alloc(0) };
    }
    throw err;
  }
  if (bytes.length === 0) return { records: [], bytes };
  if (bytes[bytes.length - 1] !== 0x0a) {
    throw new TornLogError(bytes.lastIndexOf(0x0a) + 1);
  }
  const text = bytes.toString("utf8");
  const lines = text.split("\n");
  lines.pop();
  const records: AuditRecord[] = [];
  let offset = 0;
  for (const line of lines) {
    if (line.length === 0) {
      offset += 1;
      continue;
    }
    let record: AuditRecord;
    try {
      record = parseRecord(line);
    } catch {
      throw new TornLogError(offset);
    }
    records.push(record);
    offset += Buffer.byteLength(line, "utf8") + 1;
  }
  return { records, bytes };
}

function verifyChain(records: AuditRecord[]): AnchorCheck {
  let prev = GENESIS_HASH;
  for (let i = 0; i < records.length; i++) {
    const record = records[i]!;
    if (record.seq !== i + 1) {
      return { ok: false, records: records.length, reason: `bad seq ${record.seq}, want ${i + 1}` };
    }
    if (record.prevHash !== prev) {
      return { ok: false, records: records.length, reason: `prevHash mismatch at seq ${record.seq}` };
    }
    if (record.hash !== entryHash(record)) {
      return { ok: false, records: records.length, reason: `hash mismatch at seq ${record.seq}` };
    }
    prev = record.hash;
  }
  return { ok: true, records: records.length };
}

/**
 * Append one event to the ledger with `O_APPEND` + `fsync`. Creates parent
 * state on first use (missing file reads as an empty chain from
 * `GENESIS_HASH`). Fails closed on a torn tail instead of appending after
 * a partial write.
 */
export function appendAudit(logPath: string, event: string, data: unknown): AuditRecord {
  const { records } = readLog(logPath);
  const chain = verifyChain(records);
  if (!chain.ok) {
    throw new Error(`refusing to append to a corrupt audit log: ${chain.reason}`);
  }
  const prevHash = records.length === 0 ? GENESIS_HASH : records[records.length - 1]!.hash;
  const record = createRecord(prevHash, records.length + 1, event, data);
  const fd = openSync(logPath, "a", 0o600);
  try {
    writeSync(fd, `${JSON.stringify(record)}\n`, null, "utf8");
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  return record;
}

/**
 * Verify the ledger at `logPath`. Any byte modification or equal-length
 * rewrite breaks linkage or hashes and yields `ok: false` with a reason.
 * When `anchor` (a previously observed tip) is supplied, a wholesale
 * rewrite that merely re-chains valid hashes still fails unless the
 * anchored entry matches exactly.
 */
export function checkAnchor(logPath: string, anchor?: AuditAnchor): AnchorCheck {
  let records: AuditRecord[];
  try {
    records = readLog(logPath).records;
  } catch (err) {
    if (err instanceof TornLogError) {
      return { ok: false, records: 0, reason: `torn tail at byte offset ${err.offset}` };
    }
    throw err;
  }
  const chain = verifyChain(records);
  if (!chain.ok) return chain;
  if (anchor !== undefined) {
    if (anchor.seq === 0) {
      if (anchor.hash !== GENESIS_HASH || records.length !== 0) {
        return { ok: false, records: records.length, reason: "genesis anchor mismatch" };
      }
      return { ok: true, records: records.length };
    }
    if (anchor.seq < 0 || anchor.seq > records.length) {
      return { ok: false, records: records.length, reason: `anchor seq ${anchor.seq} out of range` };
    }
    if (records[anchor.seq - 1]!.hash !== anchor.hash) {
      return { ok: false, records: records.length, reason: `anchor mismatch at seq ${anchor.seq}` };
    }
  }
  return { ok: true, records: records.length };
}

/** Read every record after verifying the chain; fails closed on corruption. */
export function readAuditRecords(logPath: string): AuditRecord[] {
  const { records } = readLog(logPath);
  const chain = verifyChain(records);
  if (!chain.ok) {
    throw new Error(`audit log corrupt: ${chain.reason}`);
  }
  return records;
}

/** Capture the current tip so a later `checkAnchor` can detect rewrites. */
export function anchorTip(logPath: string): AuditAnchor {
  const records = readAuditRecords(logPath);
  if (records.length === 0) return { seq: 0, hash: GENESIS_HASH };
  return { seq: records.length, hash: records[records.length - 1]!.hash };
}
