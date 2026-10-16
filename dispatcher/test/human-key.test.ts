/**
 * Wire compatibility with epistemic-factory es-core approvals.
 *
 * `fixtures/es-core-vector/` was produced by es-core's own `sealHumanKey`
 * + `signStageApproval` (packages/core/src/approval/ed25519.ts) with the
 * throwaway passphrase below; the record signs stage `TRUST`.
 */
import { describe, expect, test } from "bun:test";
import { createPrivateKey, createPublicKey } from "node:crypto";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  canonicalApprovalPayload,
  loadHumanPublicKey,
  sealHumanKey,
  signApprovalPayload,
  unsealHumanKey,
  verifyPinnedApproval,
  type SignedApprovalRecord,
} from "../src/human-key.js";

const VECTOR = join(import.meta.dir, "fixtures", "es-core-vector");
const VECTOR_PASSPHRASE = "es-core vector passphrase";

describe("es-core human key compatibility", () => {
  test("loads es-core human.pub and verifies an es-core signed record", () => {
    const pinned = loadHumanPublicKey(join(VECTOR, "human.pub"));
    const record = JSON.parse(readFileSync(join(VECTOR, "es-core-record.json"), "utf8")) as SignedApprovalRecord;
    expect(record.publicKeyHex).toBe(pinned.publicKeyHex);
    expect(record.fingerprint).toBe(pinned.fingerprint);
    expect(verifyPinnedApproval(pinned, record, record.signatureHex)).toBe(true);
    expect(verifyPinnedApproval(pinned, { ...record, subjectHash: "b".repeat(64) }, record.signatureHex)).toBe(false);
    expect(verifyPinnedApproval(pinned, { ...record, stage: "APPROVE" }, record.signatureHex)).toBe(false);
    expect(verifyPinnedApproval(pinned, { ...record, timestamp: "2026-10-16T00:00:00.001Z" }, record.signatureHex)).toBe(false);
  });

  test("unseals es-core human.key.enc and re-derives the pinned public key", () => {
    const der = unsealHumanKey(VECTOR, VECTOR_PASSPHRASE);
    const pub = createPublicKey(createPrivateKey({ key: der, format: "der", type: "pkcs8" })).export({ type: "spki", format: "der" });
    expect(Buffer.from(pub).toString("hex")).toBe(loadHumanPublicKey(join(VECTOR, "human.pub")).publicKeyHex);
    expect(() => unsealHumanKey(VECTOR, "wrong passphrase")).toThrow();
  });

  test("canonical payload is sorted-key JSON of exactly the four fields", () => {
    expect(canonicalApprovalPayload({ timestamp: "t", subjectHash: "s", stage: "APPROVE", runId: "r" })).toBe(
      '{"runId":"r","stage":"APPROVE","subjectHash":"s","timestamp":"t"}',
    );
  });

  test("keys sealed by the dispatcher keygen use the same files and verify", () => {
    const dir = mkdtempSync(join(tmpdir(), "human-key-"));
    const sealed = sealHumanKey(dir, "pw");
    const pinned = loadHumanPublicKey(join(dir, "human.pub"));
    expect(pinned.fingerprint).toBe(sealed.fingerprint);
    const payload = { runId: "task-1", stage: "APPROVE", subjectHash: "c".repeat(64), timestamp: new Date().toISOString() };
    const sig = signApprovalPayload(unsealHumanKey(dir, "pw"), payload);
    expect(verifyPinnedApproval(pinned, payload, sig)).toBe(true);
    expect(verifyPinnedApproval(pinned, payload, sig.toUpperCase())).toBe(false);
    expect(verifyPinnedApproval(pinned, payload, "zz")).toBe(false);
    expect(verifyPinnedApproval(pinned, payload, undefined)).toBe(false);
  });
});
