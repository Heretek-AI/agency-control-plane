/**
 * Human-approval signing client (Pillar 5), browser-native.
 *
 * The human signs the dispatcher's es-core-compatible approval payload
 * `{ runId, stage, subjectHash, timestamp }` (canonical sorted-key JSON)
 * with the Ed25519 private key whose public half the dispatcher pins
 * (`human.pub`). The key comes from a file the human chooses in the
 * drawer:
 *
 * - the sealed `human.key.enc` envelope written by `bun run keygen` or
 *   es-core `sealHumanKey` (scrypt N=16384 r=8 p=1 -> AES-256-GCM over
 *   PKCS#8 DER), unlocked with the passphrase; or
 * - an unencrypted PKCS#8 private key (PEM `BEGIN PRIVATE KEY` or DER).
 *
 * All crypto is WebCrypto (`crypto.subtle`: Ed25519 sign/verify, AES-GCM,
 * SHA-256) plus `@noble/hashes` scrypt; no Node APIs.
 *
 * BINDING SECURITY INVARIANT I1: the passphrase, the key-file bytes, the
 * scrypt-derived key, and the decrypted PKCS#8 bytes live ONLY in local
 * variables of `approveWithKeyFile` for the duration of the
 * `fetch("/api/approvals/:id/sign")` call. Byte buffers are zero-filled
 * and every reference is nulled in `finally`; the imported signing key is
 * a non-extractable `CryptoKey`. Nothing is written to `fleet-store`,
 * `localStorage`, `sessionStorage`, or DOM data attributes, and only the
 * signature leaves the closure over the wire. This module imports no
 * store and renders no DOM.
 */
import { scrypt } from "@noble/hashes/scrypt";

/** Number of approval closures currently holding live secret material (0 at rest). */
let liveSecrets = 0;

/** Observable proof that closure secrets are released after every call. */
export function activeApprovalSecrets(): number {
  return liveSecrets;
}

export interface ApprovalPayload {
  runId: string;
  stage: string;
  subjectHash: string;
  timestamp: string;
}

/** The ticket the dispatcher mints (`POST /api/approvals/:taskId/ticket`). */
export interface ApprovalTicketView {
  ticket: string;
  taskId: string;
  subjectHash: string;
  timestamp: string;
  expiresAtMs: number;
  keyFingerprint: string;
  publicKeyHex: string;
  payloads: { approve: ApprovalPayload; reject: ApprovalPayload };
  diff: { files: number; additions: number; deletions: number };
}

export interface ApprovalResult {
  taskId: string;
  status: string;
  subjectHash: string;
}

/**
 * Minimal fetch surface the signing client needs. Deliberately narrower
 * than `typeof fetch` so tests can inject dependency-free fakes.
 */
export type FetchLike = (
  url: string,
  init?: { method?: string | undefined; headers?: Record<string, string> | undefined; body?: string | undefined },
) => Promise<Response>;

export interface SignRequestOptions {
  csrfToken?: string | undefined;
  approve?: boolean | undefined;
  fetchImpl?: FetchLike | undefined;
  /** Subject hash the UI computed from the diff it displays; signing refuses on mismatch. */
  expectedSubjectHash?: string | undefined;
}

/** Canonical JSON of the four payload fields (sorted keys, no whitespace) — identical to es-core. */
export function canonicalApprovalPayload(payload: ApprovalPayload): string {
  const ordered: Array<[string, string]> = [
    ["runId", payload.runId],
    ["stage", payload.stage],
    ["subjectHash", payload.subjectHash],
    ["timestamp", payload.timestamp],
  ];
  return `{${ordered.map(([key, value]) => `${JSON.stringify(key)}:${JSON.stringify(value)}`).join(",")}}`;
}

export function bytesToHex(bytes: Uint8Array): string {
  let out = "";
  for (const byte of bytes) out += byte.toString(16).padStart(2, "0");
  return out;
}

export function hexToBytes(hex: string): Uint8Array<ArrayBuffer> {
  if (!/^(?:[0-9a-f]{2})*$/i.test(hex)) {
    throw new Error("approval-client: malformed hex");
  }
  const out = new Uint8Array(hex.length / 2);
  for (let index = 0; index < out.length; index += 1) {
    out[index] = Number.parseInt(hex.slice(index * 2, index * 2 + 2), 16);
  }
  return out;
}

/** SHA-256 hex (WebCrypto). */
export async function sha256Hex(text: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return bytesToHex(new Uint8Array(digest));
}

/** The approval subject of a diff: SHA-256 of the concatenated per-file patches (mirrors the dispatcher). */
export async function subjectHashForHunks(hunks: ReadonlyArray<{ patch: string }>): Promise<string> {
  return sha256Hex(hunks.map((hunk) => hunk.patch).join(""));
}

interface SealedEnvelope {
  version: number;
  kdf: string;
  n: number;
  r: number;
  p: number;
  salt: string;
  iv: string;
  tag: string;
  data: string;
}

function parseEnvelope(text: string): SealedEnvelope | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null) return null;
  const env = parsed as Partial<SealedEnvelope>;
  if (
    env.version !== 1 ||
    env.kdf !== "scrypt" ||
    !Number.isInteger(env.n) ||
    !Number.isInteger(env.r) ||
    !Number.isInteger(env.p) ||
    typeof env.salt !== "string" ||
    typeof env.iv !== "string" ||
    typeof env.tag !== "string" ||
    typeof env.data !== "string"
  ) {
    throw new Error("approval-client: sealed key envelope is malformed");
  }
  return env as SealedEnvelope;
}

function pemToDer(text: string): Uint8Array<ArrayBuffer> | null {
  const begin = "-----BEGIN PRIVATE KEY-----";
  const start = text.indexOf(begin);
  if (start === -1) return null;
  const end = text.indexOf("-----END PRIVATE KEY-----", start + begin.length);
  if (end === -1) return null;
  const binary = atob(text.slice(start + begin.length, end).split("").filter((ch) => ch.trim().length > 0).join(""));
  const out = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) out[index] = binary.charCodeAt(index);
  return out;
}

/** True when the chosen key file is a (JSON) sealed envelope that needs the passphrase. */
export function keyFileNeedsPassphrase(fileBytes: Uint8Array): boolean {
  return new TextDecoder().decode(fileBytes).trimStart().startsWith("{");
}

/**
 * Decode the key file into PKCS#8 DER. The returned buffer is owned by
 * the caller and must be zero-filled after use.
 */
async function unlockPkcs8(fileBytes: Uint8Array, passphrase: string | null): Promise<Uint8Array<ArrayBuffer>> {
  const text = new TextDecoder().decode(fileBytes);
  const envelope = text.trimStart().startsWith("{") ? parseEnvelope(text) : null;
  if (envelope !== null) {
    if (passphrase === null || passphrase.length === 0) {
      throw new Error("approval-client: the sealed key needs its passphrase");
    }
    const passBytes = new TextEncoder().encode(passphrase);
    let derived: Uint8Array<ArrayBuffer> | null = null;
    try {
      derived = scrypt(passBytes, hexToBytes(envelope.salt), {
        N: envelope.n,
        r: envelope.r,
        p: envelope.p,
        dkLen: 32,
      }) as Uint8Array<ArrayBuffer>;
      const aes = await crypto.subtle.importKey("raw", derived, { name: "AES-GCM" }, false, ["decrypt"]);
      const data = hexToBytes(envelope.data);
      const tag = hexToBytes(envelope.tag);
      const sealed = new Uint8Array(data.length + tag.length);
      sealed.set(data, 0);
      sealed.set(tag, data.length);
      try {
        return new Uint8Array(await crypto.subtle.decrypt({ name: "AES-GCM", iv: hexToBytes(envelope.iv) }, aes, sealed));
      } catch {
        throw new Error("approval-client: wrong passphrase or tampered sealed key");
      }
    } finally {
      passBytes.fill(0);
      derived?.fill(0);
      derived = null;
    }
  }
  const pem = pemToDer(text);
  if (pem !== null) return pem;
  if (fileBytes[0] === 0x30) return new Uint8Array(fileBytes);
  throw new Error("approval-client: key file is neither a sealed human.key.enc nor a PKCS#8 private key");
}

async function postSign(taskId: string, body: Record<string, unknown>, options: SignRequestOptions): Promise<ApprovalResult> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (options.csrfToken !== undefined && options.csrfToken.length > 0) {
    headers["x-csrf-token"] = options.csrfToken;
  }
  let response: Response;
  try {
    response = await fetchImpl(`/api/approvals/${encodeURIComponent(taskId)}/sign`, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
    });
  } catch (err) {
    throw new Error(`approval-client: sign request failed: ${(err as Error).message}`);
  }
  let payload: unknown = null;
  try {
    payload = await response.json();
  } catch {
    throw new Error(`approval-client: sign response was not JSON (status ${response.status})`);
  }
  if (!response.ok) {
    const reason =
      typeof payload === "object" && payload !== null && "error" in payload
        ? String((payload as { error: unknown }).error)
        : `status ${response.status}`;
    throw new Error(`approval-client: approval rejected: ${reason}`);
  }
  const record = payload as { taskId?: unknown; status?: unknown; subjectHash?: unknown };
  if (typeof record.taskId !== "string" || typeof record.status !== "string" || typeof record.subjectHash !== "string") {
    throw new Error("approval-client: sign response has an unexpected shape");
  }
  return { taskId: record.taskId, status: record.status, subjectHash: record.subjectHash };
}

function checkTicket(taskId: string, ticket: ApprovalTicketView, approve: boolean, expected: string | undefined): ApprovalPayload {
  if (taskId.trim().length === 0) throw new Error("approval-client: task id must be a non-empty string");
  if (ticket.ticket.trim().length === 0) throw new Error("approval-client: ticket must be a non-empty string");
  if (ticket.taskId !== taskId) throw new Error("approval-client: ticket was minted for another task");
  const payload = approve ? ticket.payloads.approve : ticket.payloads.reject;
  if (
    payload.runId !== taskId ||
    payload.stage !== (approve ? "APPROVE" : "REJECT") ||
    payload.subjectHash !== ticket.subjectHash ||
    payload.timestamp !== ticket.timestamp
  ) {
    throw new Error("approval-client: ticket payload is inconsistent; refusing to sign");
  }
  if (expected !== undefined && expected !== ticket.subjectHash) {
    throw new Error("approval-client: the diff shown does not hash to the ticket's subjectHash; refusing to sign");
  }
  return payload;
}

/**
 * Sign an approval (or rejection) with the human key file. `keyFileBytes`
 * is consumed: it is zero-filled before this function returns, as is
 * every derived secret. The signature is checked against the pinned
 * public key from the ticket before anything is sent, so a wrong key
 * fails locally.
 */
export async function approveWithKeyFile(
  taskId: string,
  ticket: ApprovalTicketView,
  keyFileBytes: Uint8Array,
  passphraseValue: string,
  options: SignRequestOptions = {},
): Promise<ApprovalResult> {
  const approve = options.approve !== false;
  liveSecrets += 1;
  let secret: string | null = passphraseValue;
  let fileBytes: Uint8Array | null = keyFileBytes;
  let pkcs8: Uint8Array<ArrayBuffer> | null = null;
  let signingKey: CryptoKey | null = null;
  try {
    const payload = checkTicket(taskId, ticket, approve, options.expectedSubjectHash);
    pkcs8 = await unlockPkcs8(fileBytes, secret);
    secret = "";
    secret = null;
    try {
      signingKey = await crypto.subtle.importKey("pkcs8", pkcs8, { name: "Ed25519" }, false, ["sign"]);
    } catch {
      throw new Error("approval-client: key file is not an Ed25519 PKCS#8 private key");
    }
    const message = new TextEncoder().encode(canonicalApprovalPayload(payload));
    const signature = new Uint8Array(await crypto.subtle.sign({ name: "Ed25519" }, signingKey, message));
    const pinned = await crypto.subtle.importKey("spki", hexToBytes(ticket.publicKeyHex), { name: "Ed25519" }, false, ["verify"]);
    if (!(await crypto.subtle.verify({ name: "Ed25519" }, pinned, signature, message))) {
      throw new Error("approval-client: this key is not the dispatcher's pinned human key");
    }
    return await postSign(
      taskId,
      { ticket: ticket.ticket, approve, subjectHash: ticket.subjectHash, signatureHex: bytesToHex(signature) },
      options,
    );
  } finally {
    if (secret !== null) {
      secret = "";
    }
    secret = null;
    pkcs8?.fill(0);
    pkcs8 = null;
    fileBytes?.fill(0);
    fileBytes = null;
    signingKey = null;
    liveSecrets -= 1;
  }
}

export interface LeakProbeEvidence {
  /** JSON-serializable snapshot of the fleet store state. */
  storeSnapshot?: unknown;
  /** Serialized DOM under test (e.g. document body HTML). */
  domHtml?: string | undefined;
  /** Dump of browser local storage contents, when available. */
  localStorageDump?: Record<string, string> | undefined;
  /** Dump of browser session storage contents, when available. */
  sessionStorageDump?: Record<string, string> | undefined;
}

export interface LeakProbeResult {
  ok: boolean;
  findings: string[];
}

/**
 * Pure helper for tests: assert that a secret value appears in NONE of
 * the observable sinks (store snapshot, DOM HTML, local/session storage
 * dumps) and that no closure still holds secret material.
 */
export function assertNoSecretLeak(secretValue: string, evidence: LeakProbeEvidence): LeakProbeResult {
  const findings: string[] = [];
  if (secretValue.length === 0) {
    return { ok: false, findings: ["probe requires a non-empty secret value"] };
  }
  const haystacks: Array<{ sink: string; text: string }> = [];
  if (evidence.storeSnapshot !== undefined) {
    let serialized = "";
    try {
      serialized = JSON.stringify(evidence.storeSnapshot) ?? "";
    } catch {
      findings.push("store snapshot is not JSON-serializable");
    }
    haystacks.push({ sink: "fleet-store", text: serialized });
  }
  if (evidence.domHtml !== undefined) {
    haystacks.push({ sink: "DOM", text: evidence.domHtml });
  }
  if (evidence.localStorageDump !== undefined) {
    haystacks.push({ sink: "localStorage", text: JSON.stringify(evidence.localStorageDump) });
  }
  if (evidence.sessionStorageDump !== undefined) {
    haystacks.push({ sink: "sessionStorage", text: JSON.stringify(evidence.sessionStorageDump) });
  }
  for (const { sink, text } of haystacks) {
    if (text.includes(secretValue)) {
      findings.push(`secret leaked into ${sink}`);
    }
  }
  if (activeApprovalSecrets() !== 0) {
    findings.push(`closure still holds ${activeApprovalSecrets()} live secret(s)`);
  }
  return { ok: findings.length === 0, findings };
}

/** Alias kept for the approval-invariant test vocabulary. */
export function assertNoPassphraseLeak(passphrase: string, evidence: LeakProbeEvidence): LeakProbeResult {
  return assertNoSecretLeak(passphrase, evidence);
}
