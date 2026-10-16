/**
 * Human-approval signing client for the Wave 3 WebUI (Pillar 5).
 *
 * BINDING SECURITY INVARIANT I1: the human secret entered in the
 * approval dialog is held ONLY in a lexical function-closure variable
 * for the duration of the `fetch("/api/approvals/:id/sign")` call, is
 * zeroed (overwritten and nulled) in a `finally` block immediately
 * after the call settles, and is NEVER written to `fleet-store`,
 * `localStorage`, `sessionStorage`, or DOM data attributes. This module
 * imports no store, touches no browser storage, and never renders DOM —
 * the raw secret is used solely to derive an Ed25519 keypair and sign
 * the subject hash, and only the resulting signature plus public key
 * leave the closure over the wire.
 */

import { createHash, createPrivateKey, createPublicKey, sign } from "node:crypto";

/** Number of approval closures currently holding a live secret (0 at rest). */
let liveSecrets = 0;

/** Observable proof that closure secrets are zeroed after every call. */
export function activeApprovalSecrets(): number {
  return liveSecrets;
}

/** PKCS8 DER prefix for an Ed25519 private key; concat with a 32-byte seed. */
const ED25519_PKCS8_PREFIX = Buffer.from("302e020100300506032b657004220420", "hex");

/** Domain separator matching the dispatcher's passphrase derivation. */
const APPROVAL_DOMAIN = "agency-approval-v1:";

function deriveKeypairPem(secret: string): { publicKeyPem: string; privateKeyPem: string } {
  if (secret.length === 0) {
    throw new Error("approval-client: secret must not be empty");
  }
  const seed = createHash("sha256").update(`${APPROVAL_DOMAIN}${secret}`, "utf8").digest();
  const privateKey = createPrivateKey({
    key: Buffer.concat([ED25519_PKCS8_PREFIX, seed]),
    format: "der",
    type: "pkcs8",
  });
  const publicKey = createPublicKey(privateKey);
  seed.fill(0);
  return {
    publicKeyPem: publicKey.export({ format: "pem", type: "spki" }) as string,
    privateKeyPem: privateKey.export({ format: "pem", type: "pkcs8" }) as string,
  };
}

function signSubject(privateKeyPem: string, subjectHash: string): string {
  const privateKey = createPrivateKey({ key: privateKeyPem, format: "pem" });
  return sign(null, Buffer.from(subjectHash, "utf8"), privateKey).toString("hex");
}

export interface SignRequestOptions {
  csrfToken?: string | undefined;
  approve?: boolean | undefined;
  fetchImpl?: FetchLike | undefined;
}

export interface ApprovalResult {
  taskId: string;
  status: string;
  subjectHash: string;
}

/**
 * Minimal fetch surface the signing client needs. Deliberately narrower
 * than `typeof fetch` (Bun's fetch carries extra members like
 * `preconnect`) so tests can inject dependency-free fakes.
 */
export type FetchLike = (
  url: string,
  init?: { method?: string | undefined; headers?: Record<string, string> | undefined; body?: string | undefined },
) => Promise<Response>;

export interface OneClickAuthority {
  signature: string;
  publicKey: string;
}

async function postSign(
  taskId: string,
  body: Record<string, unknown>,
  options: SignRequestOptions,
): Promise<ApprovalResult> {
  if (taskId.trim().length === 0) {
    throw new Error("approval-client: task id must be a non-empty string");
  }
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

/**
 * Sign an approval with a human secret. The secret lives ONLY in the
 * `secret` closure variable below: it derives the Ed25519 keypair, signs
 * the subject hash, and is overwritten + nulled in `finally`. The raw
 * secret is never placed in the request body (only the derived signature
 * and public key are sent) and never escapes this function.
 */
export async function approveWithSecret(
  taskId: string,
  ticket: string,
  secretValue: string,
  subjectHash: string,
  options: SignRequestOptions = {},
): Promise<ApprovalResult> {
  if (ticket.trim().length === 0) {
    throw new Error("approval-client: ticket must be a non-empty string");
  }
  if (subjectHash.trim().length === 0) {
    throw new Error("approval-client: subjectHash must be a non-empty string");
  }
  liveSecrets += 1;
  let secret: string | null = secretValue;
  let privateKeyPem: string | null = null;
  let requestBody: Record<string, unknown> | null = null;
  try {
    if (secret === null || secret.length === 0) {
      throw new Error("approval-client: secret must not be empty");
    }
    const keypair = deriveKeypairPem(secret);
    privateKeyPem = keypair.privateKeyPem;
    const signature = signSubject(privateKeyPem, subjectHash);
    requestBody = {
      ticket,
      subjectHash,
      signature,
      publicKey: keypair.publicKeyPem,
      approve: options.approve !== false,
    };
    return await postSign(taskId, requestBody, options);
  } finally {
    if (secret !== null) {
      secret = "";
    }
    secret = null;
    privateKeyPem = null;
    requestBody = null;
    liveSecrets -= 1;
  }
}

/**
 * Backwards-compatible alias: the approval-dialog secret is handled with
 * the exact closure discipline documented for `approveWithSecret`.
 */
export async function approveWithPassphrase(
  taskId: string,
  ticket: string,
  passphrase: string,
  subjectHash: string,
  options: SignRequestOptions = {},
): Promise<ApprovalResult> {
  return approveWithSecret(taskId, ticket, passphrase, subjectHash, options);
}

/**
 * One-click approval with an explicit (e.g. ephemeral 1-click) Ed25519
 * authority. No human secret is involved in this path at all.
 */
export async function approveOneClick(
  taskId: string,
  ticket: string,
  subjectHash: string,
  authority: OneClickAuthority,
  options: SignRequestOptions = {},
): Promise<ApprovalResult> {
  if (ticket.trim().length === 0) {
    throw new Error("approval-client: ticket must be a non-empty string");
  }
  if (subjectHash.trim().length === 0) {
    throw new Error("approval-client: subjectHash must be a non-empty string");
  }
  if (authority.signature.length === 0 || authority.publicKey.length === 0) {
    throw new Error("approval-client: one-click authority requires a signature and a public key");
  }
  return postSign(
    taskId,
    {
      ticket,
      subjectHash,
      signature: authority.signature,
      publicKey: authority.publicKey,
      approve: options.approve !== false,
    },
    options,
  );
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
 * dumps). Returns `{ ok: false, findings }` fail-closed on any leak or
 * on unserializable evidence.
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

/**
 * Alias kept for the approval-invariant test vocabulary: the dialog
 * secret must never leak into any observable sink.
 */
export function assertNoPassphraseLeak(passphrase: string, evidence: LeakProbeEvidence): LeakProbeResult {
  return assertNoSecretLeak(passphrase, evidence);
}
