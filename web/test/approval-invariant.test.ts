/**
 * Invariant I1 tests: the human approval secret lives ONLY in a lexical
 * closure inside `approval-client.ts` during the sign fetch, is zeroed
 * afterwards, and NEVER leaks into `fleet-store`, `localStorage`,
 * `sessionStorage`, or DOM attributes.
 *
 * Proven two ways: statically (source grep over `web/src`) and at
 * runtime (mocked `fetch` + `assertNoPassphraseLeak` over every
 * observable sink). No network, no DOM required.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "bun:test";
import {
  activeApprovalSecrets,
  approveOneClick,
  approveWithPassphrase,
  assertNoPassphraseLeak,
  type FetchLike,
} from "../src/security/approval-client.js";
import { createFleetStore } from "../src/state/fleet-store.js";

const WEB_SRC = join(import.meta.dir, "..", "src");

function readSource(relative: string): string {
  return readFileSync(join(WEB_SRC, relative), "utf8");
}

/**
 * Strip block and line comments so the static probe asserts on code,
 * not on the Invariant I1 documentation prose that names the forbidden
 * sinks. String literals are kept: real browser-storage use requires
 * property access (`localStorage.` / `localStorage[`), which never
 * appears in a doc comment.
 */
function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^\S\n])\/\/.*$/gm, "$1");
}

/** True when code touches browser storage (property access, not prose). */
function touchesStorage(code: string): boolean {
  return /(localStorage|sessionStorage)\s*[.[]/.test(code);
}

describe("invariant I1 (static source discipline)", () => {
  test("fleet-store never names a human secret", () => {
    const code = stripComments(readSource(join("state", "fleet-store.ts")));
    for (const needle of ["passphrase", "secret", "privateKey"]) {
      expect(code.toLowerCase().includes(needle.toLowerCase()), `fleet-store mentions ${needle}`).toBe(false);
    }
    expect(touchesStorage(code)).toBe(false);
  });

  test("no component touches browser storage or renders the secret into DOM attributes", () => {
    const files = ["KanbanBoard.tsx", "DirectorChat.tsx", "WorkerDrillDown.tsx", "SplitDiffViewer.tsx", "ApprovalDrawer.tsx", "theme.ts"];
    for (const file of files) {
      const code = stripComments(readSource(join("components", file)));
      expect(touchesStorage(code), `${file} touches browser storage`).toBe(false);
      expect(code.includes("data-passphrase"), `${file} renders data-passphrase`).toBe(false);
      expect(code.includes("data-secret"), `${file} renders data-secret`).toBe(false);
    }
  });

  test("app shell never names a human secret or browser storage", () => {
    const code = stripComments(readSource("app.tsx"));
    expect(code.toLowerCase().includes("passphrase"), "app.tsx mentions passphrase").toBe(false);
    expect(touchesStorage(code)).toBe(false);
    expect(code.includes("data-passphrase")).toBe(false);
    expect(code.includes("data-secret")).toBe(false);
  });

  test("approval-client zeroes the closure secret and touches no storage", () => {
    const code = stripComments(readSource(join("security", "approval-client.ts")));
    expect(touchesStorage(code)).toBe(false);
    expect(code.includes("finally")).toBe(true);
    expect(code.includes("secret = null")).toBe(true);
    expect(code.includes('secret = ""')).toBe(true);
    expect(code.includes("liveSecrets")).toBe(true);
  });
});

function mockSignFetch(taskId: string, subjectHash: string, capture: { body: string; url: string }): FetchLike {
  return async (input: string, init?: { body?: string | undefined }): Promise<Response> => {
    capture.url = String(input);
    capture.body = typeof init?.body === "string" ? init.body : "";
    return new Response(JSON.stringify({ taskId, status: "ready", subjectHash }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  };
}

describe("invariant I1 (runtime behavior)", () => {
  test("passphrase approval sends only signature + public key, then zeroes the closure", async () => {
    const secret = "correct horse battery staple 101";
    const capture = { body: "", url: "" };
    const result = await approveWithPassphrase("task-101", "ticket-1", secret, "subject-hash-1", {
      fetchImpl: mockSignFetch("task-101", "subject-hash-1", capture),
    });
    expect(result.status).toBe("ready");
    expect(capture.url).toBe("/api/approvals/task-101/sign");
    expect(capture.body.includes(secret)).toBe(false);
    expect(capture.body.includes("passphrase")).toBe(false);
    const body = JSON.parse(capture.body) as Record<string, unknown>;
    expect(typeof body["signature"]).toBe("string");
    expect(typeof body["publicKey"]).toBe("string");
    expect("passphrase" in body || "secret" in body).toBe(false);
    expect(activeApprovalSecrets()).toBe(0);
  });

  test("one-click approval involves no human secret at all", async () => {
    const capture = { body: "", url: "" };
    const result = await approveOneClick(
      "task-102",
      "ticket-2",
      "subject-hash-2",
      { signature: "ab".repeat(64), publicKey: "fake-public-key" },
      { fetchImpl: mockSignFetch("task-102", "subject-hash-2", capture) },
    );
    expect(result.taskId).toBe("task-102");
    expect(activeApprovalSecrets()).toBe(0);
  });

  test("empty passphrase is rejected fail-closed without any network call", async () => {
    let calls = 0;
    const counting: FetchLike = async (): Promise<Response> => {
      calls += 1;
      return new Response("{}", { status: 200 });
    };
    let message = "";
    try {
      await approveWithPassphrase("task-103", "ticket-3", "", "subject-hash-3", { fetchImpl: counting });
    } catch (err) {
      message = (err as Error).message;
    }
    expect(message.length > 0).toBe(true);
    expect(calls).toBe(0);
    expect(activeApprovalSecrets()).toBe(0);
  });

  test("assertNoPassphraseLeak passes on a clean post-approval snapshot", async () => {
    const secret = "s3cr3t-closure-only-404";
    const capture = { body: "", url: "" };
    await approveWithPassphrase("task-104", "ticket-4", secret, "subject-hash-4", {
      fetchImpl: mockSignFetch("task-104", "subject-hash-4", capture),
    });
    const store = createFleetStore();
    store.upsertTask({
      id: "task-104",
      title: "Human gate",
      branch: "fleet/task-104",
      ownedPaths: ["dispatcher/src"],
      tier: "tier-1-opencode",
      column: "Waiting Approval / QA",
    });
    const probe = assertNoPassphraseLeak(secret, {
      storeSnapshot: store.getState(),
      domHtml: `<section data-testid="approval-drawer"><input type="password" id="approval-secret" /></section>`,
      localStorageDump: {},
      sessionStorageDump: {},
    });
    expect(probe.ok).toBe(true);
    expect(probe.findings).toEqual([]);
  });

  test("assertNoPassphraseLeak is sensitive: a planted leak in any sink fails the probe", () => {
    const secret = "planted-leak-505";
    expect(assertNoPassphraseLeak(secret, { storeSnapshot: { tasks: [{ id: secret }] } }).ok).toBe(false);
    expect(assertNoPassphraseLeak(secret, { domHtml: `<div data-x="${secret}"></div>` }).ok).toBe(false);
    expect(assertNoPassphraseLeak(secret, { localStorageDump: { approval: secret } }).ok).toBe(false);
    expect(assertNoPassphraseLeak(secret, { sessionStorageDump: { approval: secret } }).ok).toBe(false);
    const findings = assertNoPassphraseLeak(secret, { localStorageDump: { approval: secret } }).findings;
    expect(findings.some((finding) => finding.includes("localStorage"))).toBe(true);
  });
});
