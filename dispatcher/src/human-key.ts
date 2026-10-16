/**
 * Pinned human Ed25519 approval key, wire-compatible with
 * epistemic-factory's es-core `approval/ed25519.ts`.
 *
 * One human key serves both systems:
 *
 * - `human.pub` is the same JSON file es-core's `sealHumanKey` writes:
 *   `{ "publicKeyHex": <SPKI DER hex>, "fingerprint": <sha256(SPKI DER) hex> }`.
 * - `human.key.enc` is the same sealed envelope (`scrypt` N=16384 r=8 p=1
 *   -> `aes-256-gcm` over the PKCS#8 DER private key).
 * - An approval signature is Ed25519 over the canonical JSON (recursively
 *   sorted keys, no whitespace) of exactly `{ runId, stage, subjectHash,
 *   timestamp }`, and the signed record has es-core's
 *   `SignedApprovalRecord` shape.
 *
 * Domain separation: the dispatcher signs with stages `APPROVE` /
 * `REJECT` and `runId = <taskId>`. es-core only accepts its own stages
 * (`GRILL`, `SPEC`, `WAIVER`, `TRUST`) and this module only accepts
 * `APPROVE` / `REJECT`, so a record minted for one system can never be
 * replayed against the other even though the key is shared.
 *
 * The dispatcher only ever loads the PUBLIC half. The sealing/signing
 * helpers below exist for the `keygen` CLI and for tests; the server
 * never sees a passphrase or a private key.
 */
import {
  createCipheriv,
  createDecipheriv,
  createHash,
  createPrivateKey,
  createPublicKey,
  generateKeyPairSync,
  randomBytes,
  scryptSync,
  sign,
  verify,
  type KeyObject,
} from "node:crypto";
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

/** Stages the dispatcher accepts. Disjoint from es-core's stage names on purpose. */
export const DISPATCHER_STAGES = { approve: "APPROVE", reject: "REJECT" } as const;
export type DispatcherStage = (typeof DISPATCHER_STAGES)[keyof typeof DISPATCHER_STAGES];

/** Payload covered by an approval signature (same fields as es-core `ApprovalPayload`). */
export interface ApprovalPayload {
  readonly runId: string;
  readonly stage: string;
  readonly subjectHash: string;
  readonly timestamp: string;
}

/** Signed approval record (same shape as es-core `SignedApprovalRecord`). */
export interface SignedApprovalRecord extends ApprovalPayload {
  readonly publicKeyHex: string;
  readonly fingerprint: string;
  readonly signatureHex: string;
}

/** The pinned human verification key loaded from `human.pub`. */
export interface PinnedHumanKey {
  readonly publicKeyHex: string;
  readonly fingerprint: string;
  readonly key: KeyObject;
  readonly sourcePath: string;
}

const ENVELOPE_VERSION = 1;
const SCRYPT_N = 16384;
const SCRYPT_R = 8;
const SCRYPT_P = 1;
const KEY_LEN = 32;
const SALT_LEN = 16;
const IV_LEN = 12;

/** Canonical JSON exactly as es-core computes it: sorted keys, no whitespace. */
export function approvalCanonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value) ?? "null";
  }
  if (Array.isArray(value)) {
    return `[${value.map((entry) => approvalCanonicalJson(entry)).join(",")}]`;
  }
  const entries = Object.entries(value as Record<string, unknown>).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries.map(([key, entry]) => `${JSON.stringify(key)}:${approvalCanonicalJson(entry)}`).join(",")}}`;
}

/** The exact bytes an approval signature covers. */
export function canonicalApprovalPayload(payload: ApprovalPayload): string {
  return approvalCanonicalJson({
    runId: payload.runId,
    stage: payload.stage,
    subjectHash: payload.subjectHash,
    timestamp: payload.timestamp,
  });
}

/** SHA-256 hex fingerprint of an SPKI DER public key (es-core `fingerprintForPublicKey`). */
export function fingerprintForPublicKey(publicKeyDer: Buffer): string {
  return createHash("sha256").update(publicKeyDer).digest("hex");
}

function isHexOfLength(value: unknown, length?: number): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length % 2 === 0 &&
    (length === undefined || value.length === length) &&
    /^[0-9a-f]+$/.test(value)
  );
}

/**
 * Load and validate the pinned `human.pub`. Throws (fail closed) when the
 * file is missing, malformed, not an Ed25519 SPKI key, or its stored
 * fingerprint does not match the key bytes.
 */
export function loadHumanPublicKey(pubPath: string): PinnedHumanKey {
  let raw: string;
  try {
    raw = readFileSync(pubPath, "utf8");
  } catch {
    throw new Error(`human public key not found at ${pubPath}`);
  }
  let parsed: { publicKeyHex?: unknown; fingerprint?: unknown };
  try {
    parsed = JSON.parse(raw) as { publicKeyHex?: unknown; fingerprint?: unknown };
  } catch {
    throw new Error(`human public key at ${pubPath} is not valid JSON`);
  }
  if (!isHexOfLength(parsed.publicKeyHex) || !isHexOfLength(parsed.fingerprint, 64)) {
    throw new Error(`human public key at ${pubPath} must be { publicKeyHex, fingerprint } lowercase hex`);
  }
  const der = Buffer.from(parsed.publicKeyHex, "hex");
  if (fingerprintForPublicKey(der) !== parsed.fingerprint) {
    throw new Error(`human public key at ${pubPath} has a fingerprint that does not match its key bytes`);
  }
  let key: KeyObject;
  try {
    key = createPublicKey({ key: der, format: "der", type: "spki" });
  } catch {
    throw new Error(`human public key at ${pubPath} is not a valid SPKI public key`);
  }
  if (key.asymmetricKeyType !== "ed25519") {
    throw new Error(`human public key at ${pubPath} is ${String(key.asymmetricKeyType)}, expected ed25519`);
  }
  return { publicKeyHex: parsed.publicKeyHex, fingerprint: parsed.fingerprint, key, sourcePath: pubPath };
}

/**
 * Verify an Ed25519 signature over the canonical payload against the
 * PINNED key only. Any caller-supplied identity is ignored. Returns false
 * on any malformed input or mismatch; never throws.
 */
export function verifyPinnedApproval(pinned: PinnedHumanKey, payload: ApprovalPayload, signatureHex: unknown): boolean {
  try {
    if (!isHexOfLength(signatureHex, 128)) return false;
    return verify(
      null,
      Buffer.from(canonicalApprovalPayload(payload), "utf8"),
      pinned.key,
      Buffer.from(signatureHex, "hex"),
    );
  } catch {
    return false;
  }
}

/** Build the es-core-shaped signed record the audit ledger stores. */
export function signedRecord(pinned: PinnedHumanKey, payload: ApprovalPayload, signatureHex: string): SignedApprovalRecord {
  return {
    runId: payload.runId,
    stage: payload.stage,
    subjectHash: payload.subjectHash,
    timestamp: payload.timestamp,
    publicKeyHex: pinned.publicKeyHex,
    fingerprint: pinned.fingerprint,
    signatureHex,
  };
}

interface KeyEnvelope {
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

/**
 * Generate and seal a human keypair in es-core's exact on-disk format:
 * `human.key.enc` (mode 0600) + `human.pub`. Used by `bun run keygen`.
 */
export function sealHumanKey(keyDir: string, passphrase: string): { publicKeyHex: string; fingerprint: string } {
  if (passphrase.length === 0) {
    throw new Error("sealHumanKey: passphrase must be a non-empty string");
  }
  const { publicKey, privateKey } = generateKeyPairSync("ed25519", {
    publicKeyEncoding: { type: "spki", format: "der" },
    privateKeyEncoding: { type: "pkcs8", format: "der" },
  });
  const publicKeyDer = Buffer.from(publicKey);
  const privateKeyDer = Buffer.from(privateKey);
  const salt = randomBytes(SALT_LEN);
  const iv = randomBytes(IV_LEN);
  const key = scryptSync(passphrase, salt, KEY_LEN, { N: SCRYPT_N, r: SCRYPT_R, p: SCRYPT_P });
  try {
    const cipher = createCipheriv("aes-256-gcm", key, iv);
    const ciphertext = Buffer.concat([cipher.update(privateKeyDer), cipher.final()]);
    const envelope: KeyEnvelope = {
      version: ENVELOPE_VERSION,
      kdf: "scrypt",
      n: SCRYPT_N,
      r: SCRYPT_R,
      p: SCRYPT_P,
      salt: salt.toString("hex"),
      iv: iv.toString("hex"),
      tag: cipher.getAuthTag().toString("hex"),
      data: ciphertext.toString("hex"),
    };
    const publicKeyHex = publicKeyDer.toString("hex");
    const fingerprint = fingerprintForPublicKey(publicKeyDer);
    mkdirSync(keyDir, { recursive: true });
    const encPath = path.join(keyDir, "human.key.enc");
    writeFileSync(encPath, `${JSON.stringify(envelope, null, 2)}\n`, { mode: 0o600 });
    chmodSync(encPath, 0o600);
    writeFileSync(path.join(keyDir, "human.pub"), `${JSON.stringify({ publicKeyHex, fingerprint }, null, 2)}\n`);
    return { publicKeyHex, fingerprint };
  } finally {
    key.fill(0);
    privateKeyDer.fill(0);
  }
}

/** Unseal `human.key.enc` to PKCS#8 DER. Test/CLI helper; the server never calls it. */
export function unsealHumanKey(keyDir: string, passphrase: string): Buffer {
  const envelope = JSON.parse(readFileSync(path.join(keyDir, "human.key.enc"), "utf8")) as KeyEnvelope;
  if (envelope.version !== ENVELOPE_VERSION || envelope.kdf !== "scrypt") {
    throw new Error("unsealHumanKey: unsupported envelope");
  }
  const key = scryptSync(passphrase, Buffer.from(envelope.salt, "hex"), KEY_LEN, {
    N: envelope.n,
    r: envelope.r,
    p: envelope.p,
  });
  try {
    const decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(envelope.iv, "hex"));
    decipher.setAuthTag(Buffer.from(envelope.tag, "hex"));
    return Buffer.concat([decipher.update(Buffer.from(envelope.data, "hex")), decipher.final()]);
  } finally {
    key.fill(0);
  }
}

/** Sign a payload with a PKCS#8 DER private key. Test/CLI helper. */
export function signApprovalPayload(privateKeyDer: Buffer, payload: ApprovalPayload): string {
  const privateKey = createPrivateKey({ key: privateKeyDer, format: "der", type: "pkcs8" });
  return sign(null, Buffer.from(canonicalApprovalPayload(payload), "utf8"), privateKey).toString("hex");
}
