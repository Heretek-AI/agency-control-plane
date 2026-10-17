/**
 * Shared test helpers: scratch git repositories, the fake `opencode serve`
 * command, CSRF-authenticated POSTs, and polling.
 */
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { FleetServer } from "../src/server.js";

export const FAKE = join(import.meta.dir, "fixtures", "fake-opencode.ts");
export const FAKE_COMMAND = [process.execPath, FAKE, "serve", "--port", "0", "--hostname", "127.0.0.1"];

/** Worker config running the fake server with test-sized timeouts. */
export const FAKE_WORKERS = { command: FAKE_COMMAND, startTimeoutMs: 15_000, taskTimeoutMs: 15_000 } as const;

export function git(cwd: string, args: string[]): string {
  return execFileSync("git", ["-c", "user.email=t@t", "-c", "user.name=t", ...args], { cwd, encoding: "utf8" }).trim();
}

export function tempDir(prefix: string): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

/** A fresh repository on `main` with one commit. */
export function scratchRepo(prefix = "launcher-repo-"): string {
  const repo = tempDir(prefix);
  git(repo, ["init", "-q", "-b", "main"]);
  writeFileSync(join(repo, "README.md"), "# repo\n");
  git(repo, ["add", "."]);
  git(repo, ["commit", "-qm", "init"]);
  return repo;
}

export async function until(predicate: () => boolean, timeoutMs = 15_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error("condition not reached in time");
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

export function post(app: FleetServer, path: string, body: unknown): Promise<Response> {
  return app.fetch(
    new Request(`http://127.0.0.1${path}`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-csrf-token": app.csrfToken },
      body: JSON.stringify(body),
    }),
  );
}
