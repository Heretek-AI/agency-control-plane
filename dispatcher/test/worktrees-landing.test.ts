import { describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { landTask } from "../src/landing.js";
import {
  allocateWorktree,
  cleanupUnconfirmed,
  detectBackend,
  gitRefExists,
  releaseWorktree,
  runGit,
  salvageWorktree,
  taskBranch,
  WorktreeStore,
} from "../src/worktrees.js";

function git(dir: string, args: string[]): string {
  return (execFileSync("git", args, { cwd: dir, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }) as string).trim();
}

function initRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), "wt-test-"));
  git(dir, ["init", "-b", "main"]);
  git(dir, ["config", "user.email", "test@agency.invalid"]);
  git(dir, ["config", "user.name", "agency-test"]);
  writeFileSync(join(dir, "README.md"), "# fleet\n");
  git(dir, ["add", "."]);
  git(dir, ["commit", "-m", "init"]);
  return dir;
}

function scratchDirs(): { repo: string; trees: string; landing: string; db: string } {
  const repo = initRepo();
  const trees = join(mkdtempSync(join(tmpdir(), "wt-trees-")), "trees");
  const landing = join(mkdtempSync(join(tmpdir(), "wt-landing-")), "landing");
  const db = join(mkdtempSync(join(tmpdir(), "wt-db-")), "worktrees.db");
  return { repo, trees, landing, db };
}

function commitFile(dir: string, name: string, content: string, message: string): string {
  writeFileSync(join(dir, name), content);
  git(dir, ["add", name]);
  git(dir, ["commit", "-m", message]);
  return git(dir, ["rev-parse", "HEAD"]);
}

describe("two-phase worktree allocation", () => {
  test("allocating flips to allocated with isolated .opencode state", () => {
    const { repo, trees, db } = scratchDirs();
    const store = new WorktreeStore(db);
    try {
      const record = allocateWorktree({ repoDir: repo, treesDir: trees, taskId: "task-1", store });
      expect(record.state).toBe("allocated");
      expect(record.branch).toBe("fleet/task-1");
      expect(record.backend).toBe("git");
      expect(existsSync(record.path)).toBe(true);
      const isolation = join(record.path, ".opencode", "fleet-isolation.json");
      expect(existsSync(isolation)).toBe(true);
      const marker = JSON.parse(readFileSync(isolation, "utf8")) as { taskId: string; isolated: boolean };
      expect(marker.taskId).toBe("task-1");
      expect(marker.isolated).toBe(true);
      const stored = store.get("task-1");
      expect(stored?.state).toBe("allocated");
      expect(gitRefExists(repo, "refs/heads/fleet/task-1")).toBe(true);
    } finally {
      store.close();
    }
  });

  test("phase-1 row is visible before confirmation and survives reopen", () => {
    const { db } = scratchDirs();
    const store = new WorktreeStore(db);
    try {
      store.recordAllocating({
        taskId: "task-9",
        branch: "fleet/task-9",
        path: "/nonexistent/task-9",
        backend: "git",
        state: "allocating",
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      });
      expect(store.get("task-9")?.state).toBe("allocating");
      expect(store.listUnconfirmed(0).map((row) => row.taskId)).toContain("task-9");
    } finally {
      store.close();
    }
    const reopened = new WorktreeStore(db);
    try {
      expect(reopened.get("task-9")?.state).toBe("allocating");
    } finally {
      reopened.close();
    }
  });

  test("backend is git without .jj and double allocation is rejected", () => {
    const { repo, trees, db } = scratchDirs();
    expect(detectBackend(repo)).toBe("git");
    const store = new WorktreeStore(db);
    try {
      allocateWorktree({ repoDir: repo, treesDir: trees, taskId: "task-2", store });
      expect(() => allocateWorktree({ repoDir: repo, treesDir: trees, taskId: "task-2", store })).toThrow();
    } finally {
      store.close();
    }
  });

  test("retry attaches the existing branch at its tip and keeps commits", () => {
    const { repo, trees, db } = scratchDirs();
    const store = new WorktreeStore(db);
    try {
      const first = allocateWorktree({ repoDir: repo, treesDir: trees, taskId: "task-3", store });
      const sha = commitFile(first.path, "work.txt", "agent work\n", "agent commit");
      releaseWorktree({ repoDir: repo, taskId: "task-3", store });
      store.remove("task-3");
      const second = allocateWorktree({ repoDir: repo, treesDir: trees, taskId: "task-3", store });
      expect(git(second.path, ["rev-parse", "HEAD"])).toBe(sha);
      expect(readFileSync(join(second.path, "work.txt"), "utf8")).toBe("agent work\n");
    } finally {
      store.close();
    }
  });
});

describe("cleanupUnconfirmed", () => {
  test("reaps orphaned allocating rows and their directories", () => {
    const { repo, trees, db } = scratchDirs();
    const store = new WorktreeStore(db);
    try {
      const now = new Date().toISOString();
      store.recordAllocating({
        taskId: "task-orphan",
        branch: "fleet/task-orphan",
        path: join(trees, "task-orphan"),
        backend: "git",
        state: "allocating",
        createdAt: now,
        updatedAt: now,
      });
      allocateWorktree({ repoDir: repo, treesDir: trees, taskId: "task-live", store });
      const { reaped } = cleanupUnconfirmed({ repoDir: repo, store, maxAgeMs: 0 });
      expect(reaped).toEqual(["task-orphan"]);
      expect(store.get("task-orphan")).toBeUndefined();
      expect(existsSync(join(trees, "task-orphan"))).toBe(false);
      // The confirmed allocation is untouched.
      expect(store.get("task-live")?.state).toBe("allocated");
    } finally {
      store.close();
    }
  });

  test("maxAgeMs keeps fresh allocating rows", () => {
    const { repo, db } = scratchDirs();
    const store = new WorktreeStore(db);
    try {
      store.recordAllocating({
        taskId: "task-fresh",
        branch: "fleet/task-fresh",
        path: join(tmpdir(), "wt-fresh-task-fresh"),
        backend: "git",
        state: "allocating",
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      });
      const { reaped } = cleanupUnconfirmed({ repoDir: repo, store, maxAgeMs: 60_000 });
      expect(reaped).toEqual([]);
      expect(store.get("task-fresh")?.state).toBe("allocating");
    } finally {
      store.close();
    }
  });
});

describe("salvageWorktree", () => {
  test("anchors refs/fleet-salvage/<taskId> before deleting the branch", () => {
    const { repo, trees, db } = scratchDirs();
    const store = new WorktreeStore(db);
    try {
      const allocated = allocateWorktree({ repoDir: repo, treesDir: trees, taskId: "task-4", store });
      const tip = commitFile(allocated.path, "agent.txt", "precious\n", "agent work");
      releaseWorktree({ repoDir: repo, taskId: "task-4", store });
      const result = salvageWorktree({ repoDir: repo, taskId: "task-4", store });
      expect(result?.tip).toBe(tip);
      expect(result?.ref).toBe("refs/fleet-salvage/task-4");
      expect(git(repo, ["rev-parse", "refs/fleet-salvage/task-4"])).toBe(tip);
      expect(gitRefExists(repo, `refs/heads/${taskBranch("task-4")}`)).toBe(false);
      expect(store.get("task-4")?.state).toBe("salvage");
    } finally {
      store.close();
    }
  });

  test("returns undefined when there is no branch and fails closed while attached", () => {
    const { repo, trees, db } = scratchDirs();
    const store = new WorktreeStore(db);
    try {
      expect(salvageWorktree({ repoDir: repo, taskId: "task-ghost", store })).toBeUndefined();
      allocateWorktree({ repoDir: repo, treesDir: trees, taskId: "task-5", store });
      expect(() => salvageWorktree({ repoDir: repo, taskId: "task-5", store })).toThrow(/release first/);
    } finally {
      store.close();
    }
  });
});

describe("landTask transactional landing", () => {
  test("--no-ff merge succeeds even when fast-forward is possible", async () => {
    const { repo, landing } = scratchDirs();
    git(repo, ["branch", taskBranch("task-10")]);
    git(repo, ["branch", "fleet/integration/m-1", "HEAD"]);
    runGit(repo, ["update-ref", "refs/heads/fleet/task-10", "HEAD"]);
    const work = mkdtempSync(join(tmpdir(), "wt-landwork-"));
    git(repo, ["worktree", "add", work, taskBranch("task-10")]);
    const taskTip = commitFile(work, "feature.txt", "feature\n", "task work");
    git(repo, ["worktree", "remove", "--force", work]);

    const result = await landTask({ repoDir: repo, landingRoot: landing, taskId: "task-10", missionId: "m-1" });
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("landing should succeed");
    expect(result.rolledBack).toBe(false);
    const parents = git(repo, ["rev-list", "--parents", "-n", "1", result.mergedSha]).split(" ");
    expect(parents.length).toBe(3);
    expect(parents).toContain(taskTip);
    expect(git(repo, ["rev-parse", "fleet/integration/m-1"])).toBe(result.mergedSha);
    // The throwaway worktree is always removed.
    expect(git(repo, ["worktree", "list", "--porcelain"])).not.toContain(landing);
  });

  test("failed post-merge verification rolls back to the pre-merge SHA", async () => {
    const { repo, landing } = scratchDirs();
    git(repo, ["branch", "fleet/integration/m-2", "HEAD"]);
    const preMerge = git(repo, ["rev-parse", "fleet/integration/m-2"]);
    git(repo, ["branch", taskBranch("task-20")]);
    const work = mkdtempSync(join(tmpdir(), "wt-landwork-"));
    git(repo, ["worktree", "add", work, taskBranch("task-20")]);
    commitFile(work, "feature.txt", "feature\n", "task work");
    git(repo, ["worktree", "remove", "--force", work]);

    const seen: string[] = [];
    const result = await landTask({
      repoDir: repo,
      landingRoot: landing,
      taskId: "task-20",
      missionId: "m-2",
      verify: () => false,
      audit: (event, data) => {
        seen.push(event);
        expect(data).toBeDefined();
      },
    });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("landing should fail verification");
    expect(result.stage).toBe("verify");
    expect(result.reason).toBe("verify");
    expect(result.rolledBack).toBe(true);
    expect(git(repo, ["rev-parse", "fleet/integration/m-2"])).toBe(preMerge);
    expect(seen).toContain("landing.reset");
  });

  test("failing pre-check merges nothing", async () => {
    const { repo, trees, landing, db } = scratchDirs();
    const store = new WorktreeStore(db);
    try {
      const allocated = allocateWorktree({ repoDir: repo, treesDir: trees, taskId: "task-30", store });
      const preMerge = git(repo, ["rev-parse", "HEAD"]);
      const result = await landTask({
        repoDir: repo,
        landingRoot: landing,
        taskId: "task-30",
        missionId: "m-3",
        taskWorktreeDir: allocated.path,
        precheck: () => false,
      });
      expect(result).toEqual({ ok: false, reason: "precheck", stage: "precheck", rolledBack: false });
      // The integration branch is never created and HEAD never moves.
      expect(gitRefExists(repo, "refs/heads/fleet/integration/m-3")).toBe(false);
      expect(git(repo, ["rev-parse", "HEAD"])).toBe(preMerge);
      expect(git(repo, ["worktree", "list", "--porcelain"])).not.toContain(landing);
    } finally {
      store.close();
    }
  });

  test("conflict aborts the merge, reports files, and loses no data", async () => {
    const { repo, landing } = scratchDirs();
    writeFileSync(join(repo, "shared.txt"), "base\n");
    git(repo, ["add", "shared.txt"]);
    git(repo, ["commit", "-m", "base file"]);
    git(repo, ["branch", taskBranch("task-40")]);
    const work = mkdtempSync(join(tmpdir(), "wt-landwork-"));
    git(repo, ["worktree", "add", work, taskBranch("task-40")]);
    commitFile(work, "shared.txt", "task side\n", "task edit");
    git(repo, ["worktree", "remove", "--force", work]);
    writeFileSync(join(repo, "shared.txt"), "main side\n");
    git(repo, ["add", "shared.txt"]);
    git(repo, ["commit", "-m", "main edit"]);
    git(repo, ["branch", "fleet/integration/m-4", "HEAD"]);
    const preMerge = git(repo, ["rev-parse", "fleet/integration/m-4"]);
    const taskTip = git(repo, ["rev-parse", taskBranch("task-40")]);

    const result = await landTask({ repoDir: repo, landingRoot: landing, taskId: "task-40", missionId: "m-4" });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("landing should conflict");
    expect(result.stage).toBe("merge");
    expect(result.reason).toBe("conflict");
    expect(result.rolledBack).toBe(true);
    expect(result.files).toContain("shared.txt");
    // Integration branch untouched; task branch (agent work) intact.
    expect(git(repo, ["rev-parse", "fleet/integration/m-4"])).toBe(preMerge);
    expect(git(repo, ["rev-parse", taskBranch("task-40")])).toBe(taskTip);
  });
});
