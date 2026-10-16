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
