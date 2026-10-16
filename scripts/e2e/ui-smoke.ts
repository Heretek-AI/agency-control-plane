#!/usr/bin/env bun
/**
 * Browser end-to-end smoke test of the served WebUI (Chromium via
 * playwright-core). Run after `bun run build:web`.
 *
 * Starts a real dispatcher on an ephemeral loopback port that serves
 * `web/dist` and the API on one origin, with the fake OpenCode server
 * (`dispatcher/test/fixtures/fake-opencode.ts`) as worker + Director and a
 * freshly sealed human key. Then, in Chromium:
 *
 * 1. the Kanban renders all five columns with no console errors;
 * 2. a chat message to the Director produces cards from its ```tasks block;
 * 3. the worker runs task-1 to `Waiting Approval / QA` with a diff;
 * 4. the human mints a ticket, picks `human.key.enc`, types the
 *    passphrase, and approves: WebCrypto Ed25519 signature verified
 *    by the pinned key; task-1 lands in Done and task-2 starts;
 * 5. the passphrase is nowhere in DOM / localStorage / sessionStorage.
 *
 * Saves `docs/evidence/ui.png`. Browsers come from
 * PLAYWRIGHT_BROWSERS_PATH (default /opt/pw-browsers when present).
 */
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { sealHumanKey } from "../../dispatcher/src/human-key.js";
import { startServer } from "../../dispatcher/src/server.js";

if (process.env["PLAYWRIGHT_BROWSERS_PATH"] === undefined && existsSync("/opt/pw-browsers")) {
  process.env["PLAYWRIGHT_BROWSERS_PATH"] = "/opt/pw-browsers";
}
const { chromium } = await import("playwright-core");

const root = join(import.meta.dir, "..", "..");
const webDist = join(root, "web", "dist");
if (!existsSync(join(webDist, "index.html"))) {
  throw new Error("web/dist is missing: run `bun run build:web` first");
}
const fake = [process.execPath, join(root, "dispatcher", "test", "fixtures", "fake-opencode.ts"), "serve", "--port", "0"];
const PASSPHRASE = "e2e approval passphrase";

const git = (cwd: string, args: string[]): string =>
  execFileSync("git", ["-c", "user.email=e2e@local", "-c", "user.name=e2e", ...args], { cwd, encoding: "utf8" }).trim();
const repo = mkdtempSync(join(tmpdir(), "ui-smoke-repo-"));
git(repo, ["init", "-q", "-b", "main"]);
writeFileSync(join(repo, "README.md"), "# smoke\n");
git(repo, ["add", "."]);
git(repo, ["commit", "-qm", "init"]);
const stateDir = mkdtempSync(join(tmpdir(), "ui-smoke-state-"));
sealHumanKey(stateDir, PASSPHRASE);

const server = startServer({
  port: 0,
  repoDir: repo,
  stateDir,
  webDistDir: webDist,
  workers: { command: fake, startTimeoutMs: 20_000 },
  director: { command: fake, startTimeoutMs: 20_000 },
});
const problems: string[] = [];
let failed = false;
let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
try {
  browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  page.on("console", (message) => {
    if (message.type() === "error") problems.push(`console.error: ${message.text()}`);
  });
  page.on("pageerror", (error) => problems.push(`pageerror: ${error.message}`));
  page.on("requestfailed", (request) => {
    // EventSource teardown on navigation/close is expected.
    if (!request.url().endsWith("/api/events")) problems.push(`requestfailed: ${request.url()}`);
  });

  await page.goto(server.url, { waitUntil: "load" });
  for (const column of ["Backlog", "Ready", "In Progress", "Waiting Approval / QA", "Done"]) {
    await page.getByTestId(`column-${column}`).waitFor({ state: "visible", timeout: 10_000 });
  }
  await page.getByTestId("app-approvals").getByText("approvals: key").waitFor();

  // Director chat -> structured tasks block -> cards.
  await page.getByTestId("director-compose").fill("please plan the query API");
  await page.getByTestId("director-send").click();
  await page.getByText("Here is the plan.").waitFor({ timeout: 20_000 });
  await page.getByTestId("card-task-1").waitFor({ timeout: 10_000 });
  await page.getByTestId("card-task-2").waitFor();

  // Worker runs task-1 to the approval column.
  await page.getByTestId("column-Waiting Approval / QA").getByTestId("card-task-1").waitFor({ timeout: 30_000 });
  await page.getByTestId("card-task-1").click();
  await page.getByTestId("tool-timeline").getByText("write").waitFor({ timeout: 10_000 });
  await page.getByTestId("diff-file-tree").waitFor();

  // Human approval with the sealed key file + passphrase (WebCrypto in Chromium).
  await page.getByTestId("app-mint-ticket").click();
  await page.getByTestId("approval-subject-match").getByText("matches the diff shown").waitFor();
  await page.getByTestId("approval-key-file").setInputFiles(join(stateDir, "human.key.enc"));
  await page.getByTestId("approval-secret").fill(PASSPHRASE);
  await page.getByTestId("approval-approve").click();
  await page.getByTestId("column-Done").getByTestId("card-task-1").waitFor({ timeout: 20_000 });
  await page.getByTestId("column-Waiting Approval / QA").getByTestId("card-task-2").waitFor({ timeout: 30_000 });

  // Invariant I1 in a real browser.
  const sinks = await page.evaluate(() => ({
    dom: document.documentElement.outerHTML,
    local: JSON.stringify({ ...localStorage }),
    session: JSON.stringify({ ...sessionStorage }),
    secretInput: (document.getElementById("approval-secret") as HTMLInputElement | null)?.value ?? "",
  }));
  for (const [sink, text] of Object.entries(sinks)) {
    if (text.includes(PASSPHRASE)) problems.push(`passphrase leaked into ${sink}`);
  }
  const status = server.app.getTask("task-1")?.status;
  if (status !== "done") problems.push(`task-1 ended ${String(status)}, expected done`);

  await page.getByTestId("card-task-2").click();
  await page.getByTestId("diff-file-tree").waitFor();
  mkdirSync(join(root, "docs", "evidence"), { recursive: true });
  await page.screenshot({ path: join(root, "docs", "evidence", "ui.png"), fullPage: true });
} catch (err) {
  failed = true;
  problems.push(`step failed: ${(err as Error).message}`);
} finally {
  await browser?.close();
  await server.stop();
}
if (failed || problems.length > 0) {
  console.error(`[ui-smoke] FAIL\n${problems.join("\n")}`);
  process.exit(1);
}
console.log("[ui-smoke] PASS: Kanban rendered, Director cards created, worker ran, browser-signed approval landed, no console errors");
