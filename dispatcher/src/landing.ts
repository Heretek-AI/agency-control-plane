/**
 * Transactional task landing for the Fleet Dispatcher Daemon.
 *
 * Landing a task is one transaction:
 *
 * 1. Run pre-checks against the task worktree. A failing check fails the
 *    landing with reason `precheck` and merges nothing.
 * 2. Merge `fleet/<taskId>` into the mission's integration branch with
 *    `--no-ff` inside a THROWAWAY landing worktree, after recording the
 *    pre-merge tip. On conflict the merge is aborted and the conflicting
 *    files are reported; the integration branch is untouched.
 * 3. Run the post-merge verification callback against the merged tree. On
 *    failure the integration branch is atomically rolled back to the
 *    recorded pre-merge SHA with `reset --hard`.
 * 4. On success the returned `mergedSha` is the merge commit.
 *
 * The throwaway landing worktree is ALWAYS removed, on every path, so
 * landing never leaks worktrees. No data loss on conflict: the task
 * branch is never moved or deleted here (see `salvageWorktree`).
 */
import { existsSync, mkdirSync, rmSync } from "node:fs";
import path from "node:path";
import { checkSlug, gitRefExists, integrationBranch, runGit, taskBranch } from "./worktrees.js";

export type LandStage = "precheck" | "merge" | "verify";

export type LandResult =
  | { ok: true; mergedSha: string; rolledBack: false }
  | { ok: false; reason: string; stage: LandStage; rolledBack: boolean; files?: string[] | undefined };

/** Verification callback: receives a worktree directory, returns true when the tree is good. */
export type VerifyCallback = (dir: string) => boolean | Promise<boolean>;

export interface LandTaskInput {
  repoDir: string;
  landingRoot: string;
  taskId: string;
  missionId: string;
  /** Task branch override. Defaults to `fleet/<taskId>`. */
  taskBranch?: string | undefined;
  /** Integration branch override. Defaults to `fleet/integration/<missionId>`. */
  integration?: string | undefined;
  /** Base ref used to create a missing integration branch. Defaults to `HEAD`. */
  base?: string | undefined;
  /** Task worktree directory the pre-check runs against. */
  taskWorktreeDir?: string | undefined;
  /** Pre-check predicate (task tree). Defaults to pass when omitted. */
  precheck?: VerifyCallback | undefined;
  /** Post-merge verification predicate (merged tree). Defaults to pass when omitted. */
  verify?: VerifyCallback | undefined;
  /** Audit hook receiving `landing.merged` / `landing.reset` events. */
  audit?: ((event: string, data: unknown) => void) | undefined;
}

/** Files with unresolved merge conflicts in `dir` (sorted, empty when clean). */
export function conflictedFiles(dir: string): string[] {
  const out = runGit(dir, ["diff", "--name-only", "--diff-filter=U"]);
  return out
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line !== "")
    .sort();
}

function removeLandingWorktree(repoDir: string, dir: string): void {
  try {
    runGit(repoDir, ["worktree", "remove", "--force", dir]);
  } catch {
    rmSync(dir, { recursive: true, force: true });
    runGit(repoDir, ["worktree", "prune"]);
  }
}

/**
 * Land `taskId` onto its mission's integration branch. Returns a
 * discriminated union: success carries the merge SHA, failure carries
 * the stage, a descriptive reason, whether the integration branch was
 * rolled back to its pre-merge SHA, and (for conflicts) the files.
 */
export async function landTask(input: LandTaskInput): Promise<LandResult> {
  checkSlug("task id", input.taskId);
  checkSlug("mission id", input.missionId);
  const branch = input.taskBranch ?? taskBranch(input.taskId);
  const integration = input.integration ?? integrationBranch(input.missionId);

  if (!gitRefExists(input.repoDir, `refs/heads/${branch}`)) {
    return {
      ok: false,
      reason: `task branch ${branch} does not exist`,
      stage: "precheck",
      rolledBack: false,
    };
  }

  // 1. Pre-checks run against the task worktree; nothing merges before they pass.
  if (input.taskWorktreeDir !== undefined && input.precheck !== undefined) {
    let passed = false;
    try {
      passed = await input.precheck(input.taskWorktreeDir);
    } catch (err) {
      input.audit?.("landing.reset", {
        mission: input.missionId,
        task: input.taskId,
        stage: "precheck",
        reason: `precheck threw: ${(err as Error).message}`,
      });
      return { ok: false, reason: `precheck threw: ${(err as Error).message}`, stage: "precheck", rolledBack: false };
    }
    if (!passed) {
      input.audit?.("landing.reset", {
        mission: input.missionId,
        task: input.taskId,
        stage: "precheck",
        reason: "precheck",
      });
      return { ok: false, reason: "precheck", stage: "precheck", rolledBack: false };
    }
  }

  // The integration branch is created from base on first landing.
  if (!gitRefExists(input.repoDir, `refs/heads/${integration}`)) {
    runGit(input.repoDir, ["branch", integration, input.base ?? "HEAD"]);
  }
  const preMergeSha = runGit(input.repoDir, ["rev-parse", integration]);

  // 2. Throwaway landing worktree checked out on the integration branch.
  const landingId = `landing-${input.taskId}-${Date.now()}`;
  const dir = path.join(input.landingRoot, landingId);
  mkdirSync(input.landingRoot, { recursive: true });
  if (existsSync(dir)) {
    rmSync(dir, { recursive: true, force: true });
  }
  try {
    runGit(input.repoDir, ["worktree", "add", dir, integration]);
  } catch (err) {
    return { ok: false, reason: `landing worktree failed: ${(err as Error).message}`, stage: "merge", rolledBack: false };
  }

  try {
    const message = [
      `land ${branch} into ${integration}`,
      "",
      `Agency-Mission: ${input.missionId}`,
      `Agency-Task: ${input.taskId}`,
    ].join("\n");
    try {
      runGit(dir, [
        "-c",
        "user.name=agency-dispatcher",
        "-c",
        "user.email=dispatcher@agency.invalid",
        "merge",
        "--no-ff",
        branch,
        "-m",
        message,
      ]);
    } catch (err) {
      const files = conflictedFiles(dir);
      try {
        runGit(dir, ["merge", "--abort"]);
      } catch (abortErr) {
        // Abort failed: force the integration branch back to its tip.
        runGit(dir, ["reset", "--hard", preMergeSha]);
        input.audit?.("landing.reset", {
          mission: input.missionId,
          task: input.taskId,
          stage: "merge",
          reason: `conflict with failed abort: ${(abortErr as Error).message}`,
          files,
          resetTo: preMergeSha,
        });
        return {
          ok: false,
          reason: files.length > 0 ? "conflict" : (err as Error).message,
          stage: "merge",
          rolledBack: true,
          files,
        };
      }
      const tip = runGit(input.repoDir, ["rev-parse", integration]);
      const intact = tip === preMergeSha;
      if (!intact) {
        runGit(dir, ["reset", "--hard", preMergeSha]);
      }
      input.audit?.("landing.reset", {
        mission: input.missionId,
        task: input.taskId,
        stage: "merge",
        reason: "conflict",
        files,
      });
      return {
        ok: false,
        reason: files.length > 0 ? "conflict" : (err as Error).message,
        stage: "merge",
        rolledBack: true,
        files,
      };
    }

    // 3. Post-merge verification; on red, roll back to the recorded tip.
    if (input.verify !== undefined) {
      let passed = true;
      let reason = "verify";
      try {
        passed = await input.verify(dir);
      } catch (err) {
        passed = false;
        reason = `verify threw: ${(err as Error).message}`;
      }
      if (!passed) {
        runGit(dir, ["reset", "--hard", preMergeSha]);
        input.audit?.("landing.reset", {
          mission: input.missionId,
          task: input.taskId,
          stage: "verify",
          reason,
          resetTo: preMergeSha,
        });
        return { ok: false, reason, stage: "verify", rolledBack: true };
      }
    }

    // 4. Success: the merge commit is the landed SHA.
    const mergedSha = runGit(dir, ["rev-parse", "HEAD"]);
    input.audit?.("landing.merged", {
      mission: input.missionId,
      task: input.taskId,
      landedSha: mergedSha,
    });
    return { ok: true, mergedSha, rolledBack: false };
  } finally {
    removeLandingWorktree(input.repoDir, dir);
  }
}
