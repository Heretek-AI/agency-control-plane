/**
 * Path matching in OpenCode's dialect: `*` matches any characters
 * including `/`, `?` matches exactly one character. Backslashes normalize
 * to forward slashes. A trailing ` *` also matches the bare prefix.
 */

/** True when `input` matches `pattern`. */
export function match(input: string, pattern: string): boolean {
  const normalized = input.replaceAll("\\", "/");
  let escaped = pattern
    .replaceAll("\\", "/")
    .replace(/[.+^${}()|[\]\\]/g, "\\$&")
    .replace(/\*/g, ".*")
    .replace(/\?/g, ".");

  if (escaped.endsWith(" .*")) escaped = escaped.slice(0, -3) + "( .*)?";

  return new RegExp(`^${escaped}$`, "s").test(normalized);
}

/**
 * Literal prefix of a pattern: the text before its first wildcard (`*`
 * or `?`). Used by the scheduler's overlap rule: if either pattern's
 * literal prefix is a prefix of the other's, the patterns may collide.
 */
export function literalPrefix(pattern: string): string {
  const normalized = pattern.replaceAll("\\", "/");
  const star = normalized.indexOf("*");
  const quest = normalized.indexOf("?");
  const cut = star === -1 ? quest : quest === -1 ? star : Math.min(star, quest);
  return cut === -1 ? normalized : normalized.slice(0, cut);
}

/**
 * Conservative overlap: true when either pattern's literal prefix is a
 * prefix of the other's. Over-serializing is acceptable; colliding runs
 * are not.
 */
export function mayOverlap(patternA: string, patternB: string): boolean {
  const pa = literalPrefix(patternA);
  const pb = literalPrefix(patternB);
  return pa.startsWith(pb) || pb.startsWith(pa);
}
