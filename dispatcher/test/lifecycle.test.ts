/**
 * Task lifecycle wiring: approval lands the task branch (G-1), finished
 * tasks release their worktrees (G-2), `expert` tasks run with their role
 * pack (G-3), and quota failures move workers to the next model tier (G-4).
 * Workers are the fake OpenCode v2 server spawned as a real child process.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parseTierModels } from "../src/cli-args.js";
import { sealHumanKey, signApprovalPayload, unsealHumanKey, type ApprovalPayload } from "../src/human-key.js";
import { loadRole, stripFrontmatter } from "../src/roles.js";
import { FAKE_WORKERS, git, tempDir, post, scratchRepo, until } from "./helpers.js";
import { createServer, type CreateServerOptions, type FleetServer } from "../src/server.js";
import { parseModelRef, taskPrompt } from "../src/worker-launcher.js";
import { TaskSchema } from "../src/model.js";

const PASSPHRASE = "lifecycle passphrase";



const opened: FleetServer[] = [];

function server(options: CreateServerOptions): FleetServer {
  const app = createServer({
    workers: FAKE_WORKERS,
    director: false,
    ...options,
  });
  opened.push(app);
  return app;
}

afterEach(async () => {
  await Promise.all(opened.splice(0).map((app) => app.shutdown()));
});



async function approve(app: FleetServer, humanKey: Buffer, taskId: string): Promise<Response> {
  const minted = await post(app, `/api/approvals/${taskId}/ticket`, {});
  expect(minted.status).toBe(200);
  const ticket = (await minted.json()) as { ticket: string; payloads: { approve: ApprovalPayload } };
  return post(app, `/api/approvals/${taskId}/sign`, {
    ticket: ticket.ticket,
    signatureHex: signApprovalPayload(humanKey, ticket.payloads.approve),
  });
}

function keyedState(): { stateDir: string; humanKey: Buffer } {
  const stateDir = tempDir("lifecycle-state-");
  sealHumanKey(stateDir, PASSPHRASE);
  return { stateDir, humanKey: unsealHumanKey(stateDir, PASSPHRASE) };
}

function readPrompts(file: string): Array<{ model: { providerID: string; id: string } | null; xdg: string | null; text: string }> {
  return readFileSync(file, "utf8")
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line) as { model: { providerID: string; id: string } | null; xdg: string | null; text: string });
}

describe("approval lands the task (G-1) and releases its worktree (G-2)", () => {
  test("APPROVE merges fleet/<task> into the mission integration branch and records landedSha", async () => {
    const repo = scratchRepo("lifecycle-repo-");
    const { stateDir, humanKey } = keyedState();
    const app = server({ repoDir: repo, stateDir });
    app.upsertTask({ id: "task-1", status: "pending", title: "Write output" });
    await until(() => app.getTask("task-1")?.status === "waitingHuman" && app.runningWorkers().length === 0);
    const worktree = app.getTask("task-1")!.worktree!;
    expect(existsSync(worktree)).toBe(true);

    const res = await approve(app, humanKey, "task-1");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { status: string; landedSha: string };
    expect(body.status).toBe("done");
    const task = app.getTask("task-1")!;
    expect(task.landedSha).toBe(body.landedSha);
    expect(git(repo, ["rev-parse", "fleet/integration/mission-1"])).toBe(body.landedSha);
    // A --no-ff merge commit whose second parent is the task branch tip.
    expect(git(repo, ["rev-parse", `${body.landedSha}^2`])).toBe(git(repo, ["rev-parse", "fleet/task-1"]));
    // Worktree released, branch kept, no landing worktree left behind.
    expect(existsSync(worktree)).toBe(false);
    expect(git(repo, ["worktree", "list", "--porcelain"])).not.toContain(worktree);
    expect(git(repo, ["worktree", "list", "--porcelain"])).not.toContain("landing-");
    expect(app.getBoard().worktrees.find((entry) => entry.taskId === "task-1")?.state).toBe("released");
  });

  test("a landing conflict keeps the task waitingHuman with the conflicting files listed", async () => {
    const repo = scratchRepo("lifecycle-repo-");
    const { stateDir, humanKey } = keyedState();
    const app = server({ repoDir: repo, stateDir });
    app.upsertTask({ id: "task-1", status: "pending", title: "Write output" });
    await until(() => app.getTask("task-1")?.status === "waitingHuman" && app.runningWorkers().length === 0);
    const sessionId = app.getTask("task-1")!.sessionId!;
    // Someone else lands a different version of the same file first.
    git(repo, ["branch", "fleet/integration/mission-1", "main"]);
    git(repo, ["checkout", "-q", "fleet/integration/mission-1"]);
    mkdirSync(join(repo, "fleet-output"), { recursive: true });
    writeFileSync(join(repo, "fleet-output", `${sessionId}.txt`), "conflicting\n");
    git(repo, ["add", "."]);
    git(repo, ["commit", "-qm", "conflict"]);
    git(repo, ["checkout", "-q", "main"]);
    const tip = git(repo, ["rev-parse", "fleet/integration/mission-1"]);

    const res = await approve(app, humanKey, "task-1");
    expect(res.status).toBe(409);
    const body = (await res.json()) as { code: string; files: string[] };
    expect(body.code).toBe("landing-failed");
    expect(body.files).toEqual([`fleet-output/${sessionId}.txt`]);
    const task = app.getTask("task-1")!;
    expect(task.status).toBe("waitingHuman");
    expect(task.reason).toContain(`fleet-output/${sessionId}.txt`);
    expect(task.landedSha).toBeUndefined();
    expect(git(repo, ["rev-parse", "fleet/integration/mission-1"])).toBe(tip);
    // Still waiting on a human: the worktree stays.
    expect(existsSync(task.worktree!)).toBe(true);
  });

  test("REJECT releases the worktree and salvages the branch", async () => {
    const repo = scratchRepo("lifecycle-repo-");
    const { stateDir, humanKey } = keyedState();
    const app = server({ repoDir: repo, stateDir });
    app.upsertTask({ id: "task-1", status: "pending", title: "Write output" });
    await until(() => app.getTask("task-1")?.status === "waitingHuman" && app.runningWorkers().length === 0);
    const worktree = app.getTask("task-1")!.worktree!;
    const tip = git(repo, ["rev-parse", "fleet/task-1"]);
    const minted = (await (await post(app, "/api/approvals/task-1/ticket", {})).json()) as {
      ticket: string;
      payloads: { reject: ApprovalPayload };
    };
    const res = await post(app, "/api/approvals/task-1/sign", {
      ticket: minted.ticket,
      approve: false,
      signatureHex: signApprovalPayload(humanKey, minted.payloads.reject),
    });
    expect(res.status).toBe(200);
    expect(app.getTask("task-1")?.status).toBe("failed");
    expect(existsSync(worktree)).toBe(false);
    expect(git(repo, ["rev-parse", "refs/fleet-salvage/task-1"])).toBe(tip);
    expect(git(repo, ["branch", "--list", "fleet/task-1"])).toBe("");
  });
});

describe("terminal states release worktrees (G-2)", () => {
  test("no-change done and worker failure both release; failure salvages", async () => {
    const repo = scratchRepo("lifecycle-repo-");
    const stateDir = tempDir("lifecycle-state-");
    const app = server({ repoDir: repo, stateDir });
    app.upsertTask({ id: "task-n", status: "pending", title: "nothing [noop]" });
    app.upsertTask({ id: "task-f", status: "pending", title: "explode [fail]" });
    await until(
      () => app.getTask("task-n")?.status === "done" && app.getTask("task-f")?.status === "failed" && app.runningWorkers().length === 0,
    );
    await until(() => !existsSync(join(stateDir, "worktrees", "task-n")) && !existsSync(join(stateDir, "worktrees", "task-f")));
    expect(git(repo, ["worktree", "list", "--porcelain"]).split("\n").filter((line) => line.startsWith("worktree "))).toHaveLength(1);
    expect(git(repo, ["rev-parse", "--verify", "--quiet", "refs/fleet-salvage/task-f"]).length).toBeGreaterThan(0);
  });

  test("restart releases worktrees of tasks that finished before the crash", async () => {
    const repo = scratchRepo("lifecycle-repo-");
    const stateDir = tempDir("lifecycle-state-");
    const first = server({ repoDir: repo, stateDir });
    first.upsertTask({ id: "task-1", status: "pending", title: "Write output" });
    await until(() => first.getTask("task-1")?.status === "waitingHuman" && first.runningWorkers().length === 0);
    const worktree = first.getTask("task-1")!.worktree!;
    await first.shutdown();
    // Simulate a finish recorded while the old process could not release.
    const offline = createServer({ stateDir, workers: false, director: false });
    offline.updateTask("task-1", { status: "cancelled", reason: "cancelled offline" });
    await offline.shutdown();
    expect(existsSync(worktree)).toBe(true);
    server({ repoDir: repo, stateDir, workers: false });
    expect(existsSync(worktree)).toBe(false);
    expect(git(repo, ["rev-parse", "--verify", "--quiet", "refs/fleet-salvage/task-1"]).length).toBeGreaterThan(0);
  });
});

function rolePack(): string {
  const roles = tempDir("lifecycle-roles-");
  const base = join(roles, "dba-specialist", "opencode");
  mkdirSync(join(base, "agent"), { recursive: true });
  mkdirSync(join(base, "skill", "postgres-migrations"), { recursive: true });
  writeFileSync(
    join(base, "agent", "dba-specialist.md"),
    "---\ndescription: database specialist\nmode: primary\n---\n\nYou are the DBA specialist. Never drop tables.\n",
  );
  writeFileSync(join(base, "skill", "postgres-migrations", "SKILL.md"), "---\nname: postgres-migrations\n---\nMigrate safely.\n");
  writeFileSync(join(base, "opencode.json"), `${JSON.stringify({ $schema: "https://opencode.ai/config.json", share: "disabled" })}\n`);
  writeFileSync(join(roles, "dba-specialist", "role.json"), `${JSON.stringify({ maxConcurrent: 1 })}\n`);
  return roles;
}

describe("role packs shape expert workers (G-3)", () => {
  test("loadRole reads prompt, skills, config, and cap; rejects non-slug ids", () => {
    const roles = rolePack();
    const role = loadRole(roles, "dba-specialist")!;
    expect(role.prompt).toBe("You are the DBA specialist. Never drop tables.");
    expect(role.skills).toEqual([join(roles, "dba-specialist", "opencode", "skill", "postgres-migrations", "SKILL.md")]);
    expect(role.configFile).toBe(join(roles, "dba-specialist", "opencode", "opencode.json"));
    expect(role.maxConcurrent).toBe(1);
    expect(loadRole(roles, "unknown-role")).toBeUndefined();
    expect(loadRole(roles, "../dba-specialist")).toBeUndefined();
    expect(stripFrontmatter("no frontmatter\n")).toBe("no frontmatter");
  });

  test("taskPrompt injects the role prompt and skill paths", () => {
    const role = loadRole(rolePack(), "dba-specialist")!;
    const task = TaskSchema.parse({
      id: "task-9",
      missionId: "mission-1",
      kind: "expert-run",
      expert: "dba-specialist",
      input: { objective: "Add an index" },
      status: "running",
    });
    const prompt = taskPrompt(task, role);
    expect(prompt).toContain("Role: dba-specialist");
    expect(prompt).toContain("Never drop tables.");
    expect(prompt).toContain(role.skills[0]!);
    expect(prompt.indexOf("Never drop tables.")).toBeLessThan(prompt.indexOf("Objective: Add an index"));
    expect(taskPrompt(task)).not.toContain("Role:");
  });

  test("expert task: XDG_CONFIG_HOME, copied opencode.json, role prompt, per-role cap", async () => {
    const repo = scratchRepo("lifecycle-repo-");
    const roles = rolePack();
    const stateDir = tempDir("lifecycle-state-");
    const app = server({
      repoDir: repo,
      stateDir,
      workers: { ...FAKE_WORKERS, rolesDir: roles },
    });
    app.upsertTask({ id: "task-1", status: "pending", title: "slow [hang]", expert: "dba-specialist" });
    app.upsertTask({ id: "task-2", status: "pending", title: "second", expert: "dba-specialist" });
    await until(() => app.getTask("task-1")?.status === "running" && app.getTask("task-1")?.sessionId?.startsWith("ses_") === true);
    // role.json maxConcurrent = 1: the second dba task waits.
    expect(app.getTask("task-2")?.status).toBe("ready");
    const dir = app.getTask("task-1")!.worktree!;
    const copied = join(dir, ".opencode", "opencode.json");
    expect(readFileSync(copied, "utf8")).toContain('"share":"disabled"');
    const [prompt] = readPrompts(join(dir, ".opencode", "fake-prompts.jsonl"));
    expect(prompt?.xdg).toBe(join(roles, "dba-specialist"));
    expect(prompt?.text).toContain("You are the DBA specialist.");
  });
});

describe("tier failover reaches the workers (G-4)", () => {
  test("a quota failure re-queues the task on the next tier's model without spending an attempt", async () => {
    const repo = scratchRepo("lifecycle-repo-");
    const stateDir = tempDir("lifecycle-state-");
    const app = server({
      repoDir: repo,
      stateDir,
      workers: {
        ...FAKE_WORKERS,
        tierModels: { "tier-1-opencode": "opencode/quota-exhausted", "tier-2-commercial": "bifrost/backup-model" },
      },
    });
    const seen: string[] = [];
    app.bus.subscribe(1, (event) => seen.push(event.type));
    app.upsertTask({ id: "task-1", status: "pending", title: "Write output" });
    await until(() => app.getTask("task-1")?.status === "waitingHuman" && app.runningWorkers().length === 0);
    expect(app.getBoard().activeTier).toBe("tier-2-commercial");
    expect(app.getTask("task-1")?.attempts).toBe(1);
    expect(seen).toContain("tier.fallback");
    expect(seen).toContain("worker.requeued");
    const prompts = readPrompts(join(app.getTask("task-1")!.worktree!, ".opencode", "fake-prompts.jsonl"));
    expect(prompts.map((entry) => entry.model?.id)).toEqual(["quota-exhausted", "backup-model"]);
    expect(prompts[1]?.model?.providerID).toBe("bifrost");
  });

  test("quota on the last tier pauses launches instead of failing tasks", async () => {
    const repo = scratchRepo("lifecycle-repo-");
    const stateDir = tempDir("lifecycle-state-");
    const app = server({ repoDir: repo, stateDir, workers: FAKE_WORKERS });
    app.setTier("tier-3-local");
    const disposition = app.reportProviderFailure({ status: 402, code: "insufficient_quota", headers: { "retry-after": "60" } });
    expect(disposition.action).toBe("pause-missions");
    app.upsertTask({ id: "task-1", status: "pending", title: "Write output" });
    await until(() => app.getTask("task-1")?.status === "ready");
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(app.getTask("task-1")?.status).toBe("ready");
    expect(app.runningWorkers()).toEqual([]);
    expect(app.getTask("task-1")?.reason).toContain("missions paused");
  });

  test("model references and --tier-models parse strictly", () => {
    expect(parseModelRef("bifrost/gpt-5#high")).toEqual({ providerID: "bifrost", id: "gpt-5", variant: "high" });
    expect(parseModelRef("opencode/glm-4.6")).toEqual({ providerID: "opencode", id: "glm-4.6" });
    expect(() => parseModelRef("no-provider")).toThrow("invalid model reference");
    expect(parseTierModels('{"tier-3-local":"ollama/qwen3"}')).toEqual({ "tier-3-local": "ollama/qwen3" });
    expect(() => parseTierModels('{"tier-9":"a/b"}')).toThrow("unknown tier");
    expect(() => parseTierModels('{"tier-1-opencode":"nomodel"}')).toThrow("provider/model");
    expect(parseTierModels(undefined)).toBeUndefined();
  });
});
