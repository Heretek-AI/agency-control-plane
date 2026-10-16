/**
 * Crash-safe worktree coordinator for the Fleet Dispatcher Daemon.
 *
 * Two-phase allocation: every allocation is recorded in a SQLite register
 * as `allocating` BEFORE any filesystem work happens, and flipped to
 * `allocated` only after the worktree exists on disk with isolated
 * `.opencode` state. A crash between the two phases leaves an unconfirmed
 * row; `cleanupUnconfirmed` reaps those rows and their orphaned
 * directories on startup, so a crash never leaves an untracked worktree.
 *
 * Backend selection: when the repository root carries a `.jj` directory
 * the allocation uses `jj workspace add`; otherwise it falls back to
 * `git worktree add -b fleet/<taskId>`. An existing task branch is
 * attached at its current tip (never moved); a missing branch is created
 * from `base` (default `HEAD`).
 *
 * `salvageWorktree` anchors `refs/fleet-salvage/<taskId>` at an abandoned
 * branch tip BEFORE deleting the branch, so agent work is never lost.
 * Nothing here touches the repository's own HEAD or moves base branches.
 */
import { Database } from "bun:sqlite";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";

export type WorktreeBackend = "jj" | "git";
export type WorktreeState = "allocating" | "allocated" | "salvage";

export interface WorktreeRecord {
  taskId: string;
  branch: string;
  path: string;
  backend: WorktreeBackend;
  state: WorktreeState;
  createdAt: string;
  updatedAt: string;
}

/** Branch carrying a task's work. */
export const taskBranch = (taskId: string): string => `fleet/${taskId}`;

/** Branch a mission's tasks land onto. */
export const integrationBranch = (missionId: string): string => `fleet/integration/${missionId}`;

/** Ref anchoring abandoned agent work before branch deletion. */
export const salvageRef = (taskId: string): string => `refs/fleet-salvage/${taskId}`;

/** Pragmas applied to every dispatcher SQLite store handle. */
export const WORKTREE_PRAGMAS: readonly string[] = [
  "PRAGMA busy_timeout = 15000;",
  "PRAGMA journal_mode = WAL;",
] as const;

/** Task ids double as directory and branch slugs: lowercase alphanumerics and dashes. */
export function checkSlug(kind: string, value: string): void {
  if (!/^[a-z0-9][a-z0-9-]*$/.test(value)) {
    throw new Error(`${kind} ${JSON.stringify(value)} is not a slug`);
  }
}

/** Run a VCS command in `cwd`, returning trimmed stdout; failures throw with stderr attached. */
export function runGit(repoDir: string, args: string[]): string {
  try {
    const out = execFileSync("git", args, {
      cwd: repoDir,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    }) as string;
    return out.trim();
  } catch (err) {
    const proc = err as { stderr?: unknown; message?: string };
    const detail = typeof proc.stderr === "string" && proc.stderr.length > 0 ? proc.stderr.trim() : proc.message;
    throw new Error(`git ${args.join(" ")} failed in ${repoDir}: ${detail}`);
  }
}

/** Run a Jujutsu command in `cwd`, returning trimmed stdout; failures throw with stderr attached. */
export function runJj(repoDir: string, args: string[]): string {
  try {
    const out = execFileSync("jj", args, {
      cwd: repoDir,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    }) as string;
    return out.trim();
  } catch (err) {
    const proc = err as { stderr?: unknown; message?: string };
    const detail = typeof proc.stderr === "string" && proc.stderr.length > 0 ? proc.stderr.trim() : proc.message;
    throw new Error(`jj ${args.join(" ")} failed in ${repoDir}: ${detail}`);
  }
}

/** True when `ref` resolves in the repository (branches, salvage refs, SHAs). */
export function gitRefExists(repoDir: string, ref: string): boolean {
  let exists = false;
  try {
    runGit(repoDir, ["rev-parse", "--verify", "--quiet", ref]);
    exists = true;
  } catch {
    exists = false;
  }
  return exists;
}

/** Colocated Jujutsu repositories get `jj` workspaces; everything else uses git worktrees. */
export function detectBackend(repoDir: string): WorktreeBackend {
  return existsSync(path.join(repoDir, ".jj")) ? "jj" : "git";
}

/**
 * SQLite-backed allocation register. The table is the source of truth
 * for which worktrees the dispatcher owns; every handle applies
 * `busy_timeout = 15000` and WAL journal mode so the single-writer
 * OpenCode store never wedges concurrent dispatchers.
 */
export class WorktreeStore {
  private readonly db: Database;

  constructor(dbPath: string) {
    this.db = new Database(dbPath);
    for (const pragma of WORKTREE_PRAGMAS) {
      this.db.exec(pragma);
    }
    this.db.exec(
      `CREATE TABLE IF NOT EXISTS worktrees (
        task_id TEXT PRIMARY KEY,
        branch TEXT NOT NULL,
        path TEXT NOT NULL,
        backend TEXT NOT NULL,
        state TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );`,
    );
  }

  /** Phase 1: record `allocating` before any filesystem work. Fails closed when the task already owns a live allocation. */
  recordAllocating(record: WorktreeRecord): void {
    const existing = this.get(record.taskId);
    if (existing !== undefined && existing.state === "allocated") {
      throw new Error(`task ${JSON.stringify(record.taskId)} already has an allocated worktree at ${existing.path}`);
    }
    this.db
      .query(
        `INSERT OR REPLACE INTO worktrees
         (task_id, branch, path, backend, state, created_at, updated_at)
         VALUES (?, ?, ?, ?, 'allocating', ?, ?)`,
      )
      .run(record.taskId, record.branch, record.path, record.backend, record.createdAt, record.updatedAt);
  }

  /** Phase 2: flip `allocating` to `allocated` after the worktree exists on disk. */
  markAllocated(taskId: string): void {
    const now = new Date().toISOString();
    const info = this.db
      .query(`UPDATE worktrees SET state = 'allocated', updated_at = ? WHERE task_id = ? AND state = 'allocating'`)
      .run(now, taskId);
    if (info.changes === 0) {
      throw new Error(`cannot confirm worktree for ${JSON.stringify(taskId)}: no allocating row`);
    }
  }

  /** Record that a task's branch was salvaged (ref anchored, branch deleted). Upserts when release already removed the row. */
  markSalvage(taskId: string, fallback?: { branch: string; path: string; backend: WorktreeBackend }): void {
    const now = new Date().toISOString();
    const info = this.db
      .query(`UPDATE worktrees SET state = 'salvage', updated_at = ? WHERE task_id = ?`)
      .run(now, taskId);
    if (info.changes === 0) {
      const branch = fallback?.branch ?? `fleet/${taskId}`;
      const rowPath = fallback?.path ?? "";
      const backend = fallback?.backend ?? "git";
      this.db
        .query(
          `INSERT INTO worktrees (task_id, branch, path, backend, state, created_at, updated_at)
           VALUES (?, ?, ?, ?, 'salvage', ?, ?)`,
        )
        .run(taskId, branch, rowPath, backend, now, now);
    }
  }

  get(taskId: string): WorktreeRecord | undefined {
    const row = this.db
      .query(`SELECT task_id, branch, path, backend, state, created_at, updated_at FROM worktrees WHERE task_id = ?`)
      .get(taskId) as
      | { task_id: string; branch: string; path: string; backend: string; state: string; created_at: string; updated_at: string }
      | null;
    if (row === null) return undefined;
    return {
      taskId: row.task_id,
      branch: row.branch,
      path: row.path,
      backend: row.backend === "jj" ? "jj" : "git",
      state: row.state === "allocated" ? "allocated" : row.state === "salvage" ? "salvage" : "allocating",
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }

  list(): WorktreeRecord[] {
    const rows = this.db
      .query(`SELECT task_id, branch, path, backend, state, created_at, updated_at FROM worktrees ORDER BY task_id`)
      .all() as Array<{
      task_id: string;
      branch: string;
      path: string;
      backend: string;
      state: string;
      created_at: string;
      updated_at: string;
    }>;
    return rows.map((row) => ({
      taskId: row.task_id,
      branch: row.branch,
      path: row.path,
      backend: row.backend === "jj" ? ("jj" as const) : ("git" as const),
      state:
        row.state === "allocated"
          ? ("allocated" as const)
          : row.state === "salvage"
            ? ("salvage" as const)
            : ("allocating" as const),
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    }));
  }

  /** Rows recorded as `allocating` at least `olderThanMs` ago (unconfirmed crash orphans). */
  listUnconfirmed(olderThanMs: number, nowMs?: number): WorktreeRecord[] {
    const now = nowMs ?? Date.now();
    return this.list().filter(
      (record) => record.state === "allocating" && now - Date.parse(record.updatedAt) >= olderThanMs,
    );
  }

  remove(taskId: string): void {
    this.db.query(`DELETE FROM worktrees WHERE task_id = ?`).run(taskId);
  }

  close(): void {
    this.db.close();
  }
}

/**
 * Isolate a worker's `.opencode` state inside its own worktree. The
 * directory is always created fresh per worktree and never symlinked or
 * copied from another worker, so concurrent workers cannot share session
 * state through the filesystem.
 */
export function isolateOpencodeState(worktreePath: string, taskId: string): string {
  const dir = path.join(worktreePath, ".opencode");
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    path.join(dir, "fleet-isolation.json"),
    `${JSON.stringify({ taskId, isolated: true, createdAt: new Date().toISOString() }, null, 2)}\n`,
    { mode: 0o600 },
  );
  return dir;
}

export interface AllocateWorktreeInput {
  repoDir: string;
  treesDir: string;
  taskId: string;
  /** Base ref for a brand-new task branch. Defaults to `HEAD`. */
  base?: string | undefined;
  /** Backend override; defaults to `detectBackend(repoDir)`. */
  backend?: WorktreeBackend | undefined;
  /** Allocation register; phase 1/2 rows are recorded only when provided. */
  store?: WorktreeStore | undefined;
}

/**
 * Allocate a worktree for `taskId` with crash-safe two-phase semantics:
 * the `allocating` row lands in the store BEFORE the VCS worktree is
 * created, and flips to `allocated` only after the worktree plus
 * isolated `.opencode` state exist. On VCS failure the half-created
 * directory is removed but the `allocating` row is left behind on
 * purpose so startup cleanup can observe and reap it.
 */
export function allocateWorktree(input: AllocateWorktreeInput): WorktreeRecord {
  checkSlug("task id", input.taskId);
  const backend = input.backend ?? detectBackend(input.repoDir);
  const branch = taskBranch(input.taskId);
  const worktreePath = path.join(input.treesDir, input.taskId);
  const now = new Date().toISOString();
  const record: WorktreeRecord = {
    taskId: input.taskId,
    branch,
    path: worktreePath,
    backend,
    state: "allocating",
    createdAt: now,
    updatedAt: now,
  };
  input.store?.recordAllocating(record);
  try {
    mkdirSync(input.treesDir, { recursive: true });
    if (backend === "jj") {
      runJj(input.repoDir, ["workspace", "add", worktreePath]);
    } else if (gitRefExists(input.repoDir, `refs/heads/${branch}`)) {
      // Existing branch: attach at its current tip. Never move it.
      runGit(input.repoDir, ["worktree", "add", worktreePath, branch]);
    } else {
      runGit(input.repoDir, ["worktree", "add", "-b", branch, worktreePath, input.base ?? "HEAD"]);
    }
    isolateOpencodeState(worktreePath, input.taskId);
  } catch (err) {
    try {
      rmSync(worktreePath, { recursive: true, force: true });
    } catch (rmErr) {
      throw new Error(
        `worktree allocation for ${JSON.stringify(input.taskId)} failed and directory cleanup failed: ${(err as Error).message}; cleanup: ${(rmErr as Error).message}`,
      );
    }
    if (backend === "git") {
      try {
        runGit(input.repoDir, ["worktree", "prune"]);
      } catch (pruneErr) {
        throw new Error(
          `worktree allocation for ${JSON.stringify(input.taskId)} failed and prune failed: ${(err as Error).message}; prune: ${(pruneErr as Error).message}`,
        );
      }
    }
    throw err;
  }
  input.store?.markAllocated(input.taskId);
  return { ...record, state: "allocated", updatedAt: new Date().toISOString() };
}

export interface CleanupUnconfirmedInput {
  repoDir: string;
  store: WorktreeStore;
  /** Only reap rows unconfirmed for at least this long. Defaults to 0 (reap everything unconfirmed). */
  maxAgeMs?: number | undefined;
  nowMs?: number | undefined;
}

/**
 * Startup reap: remove every stale `allocating` worktree (a crash
 * between register and confirm) and release its row. Reports every
 * failure instead of stopping at the first so one stuck worktree
 * cannot hide the rest.
 */
export function cleanupUnconfirmed(input: CleanupUnconfirmedInput): { reaped: string[] } {
  const stale = input.store.listUnconfirmed(input.maxAgeMs ?? 0, input.nowMs);
  const failures: string[] = [];
  const reaped: string[] = [];
  for (const record of stale) {
    try {
      if (record.backend === "git") {
        try {
          runGit(input.repoDir, ["worktree", "remove", "--force", record.path]);
        } catch {
          // The directory may predate the crash oddly; delete it so no
          // untracked tree survives, then prune the metadata.
          rmSync(record.path, { recursive: true, force: true });
          runGit(input.repoDir, ["worktree", "prune"]);
        }
      } else {
        rmSync(record.path, { recursive: true, force: true });
      }
    } catch (err) {
      failures.push(`${record.taskId}: ${(err as Error).message}`);
      continue;
    }
    try {
      input.store.remove(record.taskId);
    } catch (err) {
      failures.push(`${record.taskId}: ${(err as Error).message}`);
      continue;
    }
    reaped.push(record.taskId);
  }
  if (failures.length > 0) {
    throw new Error(`cleanupUnconfirmed failed for: ${failures.join("; ")}`);
  }
  return { reaped };
}

/** Find the worktree directory currently checked out on `branch`, if any. */
export function worktreeUsingBranch(repoDir: string, branch: string): string | undefined {
  const listing = runGit(repoDir, ["worktree", "list", "--porcelain"]);
  let current: string | undefined;
  for (const line of listing.split("\n")) {
    if (line.startsWith("worktree ")) {
      current = line.slice("worktree ".length).trim();
    } else if (line === `branch refs/heads/${branch}`) {
      return current;
    }
  }
  return undefined;
}

/** Remove a task's worktree. The task branch (and its commits) stays. */
export function releaseWorktree(input: { repoDir: string; taskId: string; store?: WorktreeStore | undefined }): void {
  checkSlug("task id", input.taskId);
  const record = input.store?.get(input.taskId);
  const worktreePath = record?.path;
  if (worktreePath === undefined) {
    throw new Error(`cannot release worktree for ${JSON.stringify(input.taskId)}: no allocation record`);
  }
  runGit(input.repoDir, ["worktree", "remove", "--force", worktreePath]);
  input.store?.remove(input.taskId);
}

export interface SalvageResult {
  taskId: string;
  ref: string;
  tip: string;
}

/**
 * Anchor the abandoned branch tip at `refs/fleet-salvage/<taskId>`
 * BEFORE deleting the branch, so agent work is never lost. Returns
 * undefined when there is no branch to salvage. Fails closed while any
 * worktree still uses the branch: release it first.
 */
export function salvageWorktree(input: {
  repoDir: string;
  taskId: string;
  store?: WorktreeStore | undefined;
}): SalvageResult | undefined {
  checkSlug("task id", input.taskId);
  const branch = taskBranch(input.taskId);
  if (!gitRefExists(input.repoDir, `refs/heads/${branch}`)) {
    return undefined;
  }
  const attached = worktreeUsingBranch(input.repoDir, branch);
  if (attached !== undefined) {
    throw new Error(`cannot salvage ${branch}: worktree at ${attached} still uses it; release first`);
  }
  const tip = runGit(input.repoDir, ["rev-parse", branch]);
  const ref = salvageRef(input.taskId);
  const known = input.store?.get(input.taskId);
  runGit(input.repoDir, ["update-ref", ref, tip]);
  runGit(input.repoDir, ["branch", "-D", branch]);
  input.store?.markSalvage(input.taskId, {
    branch,
    path: known?.path ?? "",
    backend: known?.backend ?? detectBackend(input.repoDir),
  });
  return { taskId: input.taskId, ref, tip };
}
