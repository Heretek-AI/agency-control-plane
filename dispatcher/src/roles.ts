/**
 * Per-role worker shaping for `expert` tasks.
 *
 * A role pack lives at `<rolesDir>/<role-id>/` and is laid out as an
 * OpenCode XDG config home, so the worker can run with
 * `XDG_CONFIG_HOME=<rolesDir>/<role-id>`:
 *
 * ```text
 * <rolesDir>/<role-id>/
 *   role.json                       optional: { "maxConcurrent": n }
 *   opencode/opencode.json          copied into the worktree `.opencode/`
 *   opencode/agent/<role-id>.md     role system prompt (frontmatter stripped)
 *   opencode/skill/<name>/SKILL.md  skills listed in the task prompt
 * ```
 *
 * `agents/` and `skills/` are accepted as plural aliases. Role ids come
 * from Director output, so only slugs resolve: anything else (or a
 * missing directory) is "no role" and the worker runs with the generic
 * prompt.
 */
import { copyFileSync, existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";

export interface RoleProfile {
  id: string;
  /** Role directory, used as the worker's `XDG_CONFIG_HOME`. */
  dir: string;
  /** Role agent prompt body, or undefined when the role has none. */
  prompt?: string | undefined;
  /** Absolute paths of the role's `SKILL.md` files, sorted. */
  skills: string[];
  /** Role `opencode.json`, copied into each worktree's `.opencode/`. */
  configFile?: string | undefined;
  /** Per-role cap on concurrently running workers. */
  maxConcurrent?: number | undefined;
}

const ROLE_ID = /^[a-z0-9][a-z0-9-]*$/;

function firstExisting(candidates: string[]): string | undefined {
  return candidates.find((candidate) => existsSync(candidate) && statSync(candidate).isFile());
}

/** Drop a leading `---` YAML frontmatter block from an agent markdown file. */
export function stripFrontmatter(text: string): string {
  const normalized = text.replace(/^﻿/, "");
  if (!normalized.startsWith("---\n") && !normalized.startsWith("---\r\n")) return normalized.trim();
  const end = normalized.indexOf("\n---", 3);
  if (end === -1) return normalized.trim();
  const after = normalized.indexOf("\n", end + 4);
  return (after === -1 ? "" : normalized.slice(after + 1)).trim();
}

function listSkills(opencodeDir: string): string[] {
  const skills: string[] = [];
  for (const name of ["skill", "skills"]) {
    const root = path.join(opencodeDir, name);
    if (!existsSync(root) || !statSync(root).isDirectory()) continue;
    for (const entry of readdirSync(root, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const file = path.join(root, entry.name, "SKILL.md");
      if (existsSync(file)) skills.push(file);
    }
  }
  return skills.sort((a, b) => a.localeCompare(b));
}

function readMaxConcurrent(roleDir: string): number | undefined {
  const file = path.join(roleDir, "role.json");
  if (!existsSync(file)) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(file, "utf8"));
  } catch (err) {
    throw new Error(`role ${path.basename(roleDir)}: role.json is not JSON: ${(err as Error).message}`);
  }
  const value = typeof parsed === "object" && parsed !== null ? (parsed as { maxConcurrent?: unknown }).maxConcurrent : undefined;
  if (value === undefined) return undefined;
  if (typeof value !== "number" || !Number.isInteger(value) || value < 1) {
    throw new Error(`role ${path.basename(roleDir)}: role.json maxConcurrent must be a positive integer`);
  }
  return value;
}

/** Load the role pack for `roleId`, or undefined when there is none. */
export function loadRole(rolesDir: string, roleId: string): RoleProfile | undefined {
  if (!ROLE_ID.test(roleId)) return undefined;
  const dir = path.join(path.resolve(rolesDir), roleId);
  if (!existsSync(dir) || !statSync(dir).isDirectory()) return undefined;
  const opencodeDir = path.join(dir, "opencode");
  const promptFile = firstExisting([
    path.join(opencodeDir, "agent", `${roleId}.md`),
    path.join(opencodeDir, "agents", `${roleId}.md`),
  ]);
  const prompt = promptFile === undefined ? undefined : stripFrontmatter(readFileSync(promptFile, "utf8"));
  return {
    id: roleId,
    dir,
    prompt: prompt !== undefined && prompt.length > 0 ? prompt : undefined,
    skills: listSkills(opencodeDir),
    configFile: firstExisting([path.join(opencodeDir, "opencode.json"), path.join(opencodeDir, "opencode.jsonc")]),
    maxConcurrent: readMaxConcurrent(dir),
  };
}

/**
 * Copy (never symlink) the role's OpenCode config into the worktree's
 * isolated `.opencode/`, so workers never share config state.
 */
export function installRoleConfig(role: RoleProfile, worktreeDir: string): string | undefined {
  if (role.configFile === undefined) return undefined;
  const target = path.join(worktreeDir, ".opencode", path.basename(role.configFile));
  copyFileSync(role.configFile, target);
  return target;
}
