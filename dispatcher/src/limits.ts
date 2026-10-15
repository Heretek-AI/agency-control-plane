/**
 * Provider-error classification with 3-tier failover.
 *
 * A usage-limit refusal NEVER pauses all missions in an infinite loop.
 * Instead the dispatcher routes around the exhausted tier via Maxim
 * Bifrost: `tier-1-opencode` -> `tier-2-commercial` -> `tier-3-local`.
 * Only when the last local tier reports quota exhaustion do missions
 * pause, and then only until the provider-advertised retry time.
 *
 * A transient 429 with no quota shape is a plain `retry-delay` honoring
 * the provider's `Retry-After` hint.
 */

export type ModelTier = "tier-1-opencode" | "tier-2-commercial" | "tier-3-local";

export interface ProviderFailure {
  status?: number;
  code?: string;
  message?: string;
  headers?: Record<string, string>;
}

export type ProviderDisposition =
  | { action: "retry-delay"; delayMs: number }
  | { action: "route-fallback"; targetTier: ModelTier }
  | { action: "pause-missions"; reason: string; resumeAfterMs: number };

export const RETRY_AFTER_MIN_MS = 1000;
export const RETRY_AFTER_MAX_MS = 300000;
export const RETRY_AFTER_DEFAULT_MS = 5000;

const QUOTA_CODE_PATTERN = /gousagelimiterror|freeusagelimiterror|insufficient_quota/i;
const QUOTA_MESSAGE_PATTERN = /usage limit|quota exceeded|insufficient quota|credit balance/i;

function lookupHeader(headers: Record<string, string> | undefined, name: string): string | undefined {
  if (headers === undefined) return undefined;
  const wanted = name.toLowerCase();
  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() === wanted) return value;
  }
  return undefined;
}

function clampRetryAfterMs(value: number, defaultMs: number): number {
  if (!Number.isFinite(value) || value < 0) return defaultMs;
  return Math.min(RETRY_AFTER_MAX_MS, Math.max(RETRY_AFTER_MIN_MS, Math.floor(value)));
}

/**
 * Parse the provider's retry hint: `retry-after-ms` (raw milliseconds)
 * takes precedence, else `retry-after` as delta-seconds or an HTTP-Date.
 * Falls back to `defaultMs ?? 5000` and clamps to `[1000, 300000]`.
 * Header lookup is case-insensitive; invalid or negative values yield
 * the default.
 */
export function extractRetryAfterMs(
  headers?: Record<string, string>,
  defaultMs: number = RETRY_AFTER_DEFAULT_MS,
): number {
  const fallback = clampRetryAfterMs(defaultMs, RETRY_AFTER_DEFAULT_MS);

  const msRaw = lookupHeader(headers, "retry-after-ms");
  if (msRaw !== undefined) {
    const parsed = Number(msRaw.trim());
    if (msRaw.trim() !== "" && Number.isFinite(parsed) && parsed >= 0) {
      return clampRetryAfterMs(parsed, fallback);
    }
    return fallback;
  }

  const retryAfter = lookupHeader(headers, "retry-after");
  if (retryAfter !== undefined) {
    const text = retryAfter.trim();
    if (text !== "") {
      const asSeconds = Number(text);
      if (Number.isFinite(asSeconds)) {
        if (asSeconds < 0) return fallback;
        return clampRetryAfterMs(asSeconds * 1000, fallback);
      }
      const asDate = Date.parse(text);
      if (!Number.isNaN(asDate)) {
        return clampRetryAfterMs(asDate - Date.now(), fallback);
      }
      return fallback;
    }
  }

  return fallback;
}

function isQuotaFailure(failure: ProviderFailure): boolean {
  const codeQuota = failure.code !== undefined && QUOTA_CODE_PATTERN.test(failure.code);
  const messageQuota = QUOTA_MESSAGE_PATTERN.test(failure.message ?? "");
  return failure.status === 402 || codeQuota || messageQuota;
}

/**
 * Classify a provider failure into a dispatcher disposition. Quota-shaped
 * failures route to the next tier with ZERO mission pause; only the last
 * tier pauses, resuming after the provider's retry hint. Plain 429s
 * become bounded retry-delays. Anything else is a bounded retry-delay
 * with an exponential backoff default so unknown errors fail closed
 * without freezing the fleet.
 */
export function classifyProviderFailure(
  failure: ProviderFailure,
  consecutiveFailures: number,
  currentTier: ModelTier,
): ProviderDisposition {
  const safeConsecutive = Number.isFinite(consecutiveFailures)
    ? Math.max(0, Math.floor(consecutiveFailures))
    : 0;

  if (isQuotaFailure(failure)) {
    if (currentTier === "tier-1-opencode") {
      return { action: "route-fallback", targetTier: "tier-2-commercial" };
    }
    if (currentTier === "tier-2-commercial") {
      return { action: "route-fallback", targetTier: "tier-3-local" };
    }
    const resumeAfterMs = extractRetryAfterMs(failure.headers);
    const reason =
      failure.status === 402
        ? `provider reported payment/quota failure (status 402, code ${failure.code ?? "unknown"})`
        : `provider quota exhausted on ${currentTier} (code ${failure.code ?? "unknown"})`;
    return { action: "pause-missions", reason, resumeAfterMs };
  }

  if (failure.status === 429) {
    return { action: "retry-delay", delayMs: extractRetryAfterMs(failure.headers) };
  }

  const backoffDefault = Math.min(
    RETRY_AFTER_MAX_MS,
    RETRY_AFTER_DEFAULT_MS * 2 ** Math.min(safeConsecutive, 6),
  );
  return { action: "retry-delay", delayMs: extractRetryAfterMs(failure.headers, backoffDefault) };
}
