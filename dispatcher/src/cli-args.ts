import type { ModelTier } from "./limits.js";

/**
 * Minimal `--flag value` / `--flag=value` / `--switch` parser shared by the CLIs.
 * Names in `knownSwitches` take no operand; every other flag requires one.
 */
export function parseArgs(
  argv: readonly string[],
  knownSwitches: ReadonlySet<string> = new Set(),
): { flags: Map<string, string>; switches: Set<string> } {
  const flags = new Map<string, string>();
  const switches = new Set<string>();
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]!;
    if (!arg.startsWith("--")) {
      throw new Error(`unexpected argument ${JSON.stringify(arg)}`);
    }
    const eq = arg.indexOf("=");
    if (eq !== -1) {
      const name = arg.slice(2, eq);
      if (knownSwitches.has(name)) throw new Error(`--${name} takes no value`);
      flags.set(name, arg.slice(eq + 1));
      continue;
    }
    const name = arg.slice(2);
    if (knownSwitches.has(name)) {
      switches.add(name);
      continue;
    }
    const next = argv[index + 1];
    if (next === undefined || next.startsWith("--")) {
      throw new Error(`--${name} requires a value`);
    }
    flags.set(name, next);
    index += 1;
  }
  return { flags, switches };
}

/** A command given as a JSON array (`["opencode","serve"]`) or a whitespace-separated string. */
export function parseCommand(value: string): string[] {
  const trimmed = value.trim();
  if (trimmed.startsWith("[")) {
    const parsed = JSON.parse(trimmed) as unknown;
    if (!Array.isArray(parsed) || parsed.length === 0 || !parsed.every((part) => typeof part === "string" && part.length > 0)) {
      throw new Error("command JSON must be a non-empty array of strings");
    }
    return parsed as string[];
  }
  const parts = trimmed.split(/\s+/).filter((part) => part.length > 0);
  if (parts.length === 0) throw new Error("command must not be empty");
  return parts;
}

const TIERS: readonly ModelTier[] = ["tier-1-opencode", "tier-2-commercial", "tier-3-local"];

/** Parse `--tier-models` JSON: an object from tier name to `provider/model`. */
export function parseTierModels(value: string | undefined): Partial<Record<ModelTier, string>> | undefined {
  if (value === undefined) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch (err) {
    throw new Error(`--tier-models must be JSON: ${(err as Error).message}`);
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error("--tier-models must be a JSON object of tier -> provider/model");
  }
  const models: Partial<Record<ModelTier, string>> = {};
  for (const [tier, model] of Object.entries(parsed)) {
    if (!TIERS.includes(tier as ModelTier)) throw new Error(`--tier-models: unknown tier ${JSON.stringify(tier)}`);
    if (typeof model !== "string" || !/^[^/#]+\/[^#]+(#.+)?$/.test(model)) {
      throw new Error(`--tier-models: ${tier} must map to "provider/model", got ${JSON.stringify(model)}`);
    }
    models[tier as ModelTier] = model;
  }
  return models;
}
