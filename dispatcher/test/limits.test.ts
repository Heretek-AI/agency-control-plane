import { describe, expect, test } from "bun:test";
import {
  classifyProviderFailure,
  extractRetryAfterMs,
  type ProviderFailure,
} from "../src/limits.js";

describe("extractRetryAfterMs", () => {
  test("retry-after-ms takes precedence as raw milliseconds", () => {
    expect(extractRetryAfterMs({ "retry-after-ms": "4500", "retry-after": "120" })).toBe(4500);
  });

  test("retry-after parses delta-seconds", () => {
    expect(extractRetryAfterMs({ "Retry-After": "30" })).toBe(30000);
  });

  test("retry-after parses HTTP-Date", () => {
    const future = new Date(Date.now() + 60000).toUTCString();
    const parsed = extractRetryAfterMs({ "retry-after": future });
    expect(parsed).toBeGreaterThanOrEqual(1000);
    expect(parsed).toBeLessThanOrEqual(300000);
  });

  test("header lookup is case-insensitive", () => {
    expect(extractRetryAfterMs({ "RETRY-AFTER-MS": "7000" })).toBe(7000);
  });

  test("falls back to defaultMs then 5000 when headers are absent", () => {
    expect(extractRetryAfterMs(undefined)).toBe(5000);
    expect(extractRetryAfterMs({}, 12000)).toBe(12000);
  });

  test("invalid and negative values yield the default", () => {
    expect(extractRetryAfterMs({ "retry-after": "not-a-date" })).toBe(5000);
    expect(extractRetryAfterMs({ "retry-after": "-5" })).toBe(5000);
    expect(extractRetryAfterMs({ "retry-after-ms": "bogus" }, 9000)).toBe(9000);
  });

  test("clamps to [1000, 300000]", () => {
    expect(extractRetryAfterMs({ "retry-after-ms": "10" })).toBe(1000);
    expect(extractRetryAfterMs({ "retry-after-ms": "99999999" })).toBe(300000);
    expect(extractRetryAfterMs({ "retry-after": "0" })).toBe(1000);
    expect(extractRetryAfterMs({ "retry-after": "3600" })).toBe(300000);
    expect(extractRetryAfterMs({}, 50)).toBe(1000);
    expect(extractRetryAfterMs({}, 9999999)).toBe(300000);
  });
});

describe("classifyProviderFailure quota failover", () => {
  test("429 gousagelimiterror on tier-1 routes to tier-2 with zero pause", () => {
    const failure: ProviderFailure = {
      status: 429,
      code: "gousagelimiterror",
      message: "usage limit exceeded",
    };
    const disposition = classifyProviderFailure(failure, 3, "tier-1-opencode");
    expect(disposition).toEqual({ action: "route-fallback", targetTier: "tier-2-commercial" });
  });

  test("402 routes tier-1 to tier-2 and tier-2 to tier-3", () => {
    const failure: ProviderFailure = { status: 402, code: "insufficient_quota" };
    expect(classifyProviderFailure(failure, 1, "tier-1-opencode")).toEqual({
      action: "route-fallback",
      targetTier: "tier-2-commercial",
    });
    expect(classifyProviderFailure(failure, 1, "tier-2-commercial")).toEqual({
      action: "route-fallback",
      targetTier: "tier-3-local",
    });
  });

  test("quota-shaped 429 body on tier-2 routes to tier-3", () => {
    const failure: ProviderFailure = { status: 429, message: "Quota exceeded for this project" };
    expect(classifyProviderFailure(failure, 2, "tier-2-commercial")).toEqual({
      action: "route-fallback",
      targetTier: "tier-3-local",
    });
  });

  test("freeusagelimiterror and credit-balance bodies count as quota", () => {
    expect(
      classifyProviderFailure(
        { status: 429, code: "FreeUsageLimitError", message: "slow down" },
        1,
        "tier-1-opencode",
      ),
    ).toEqual({ action: "route-fallback", targetTier: "tier-2-commercial" });
    expect(
      classifyProviderFailure(
        { status: 429, message: "You have insufficient credit balance" },
        1,
        "tier-1-opencode",
      ),
    ).toEqual({ action: "route-fallback", targetTier: "tier-2-commercial" });
  });

  test("tier-3 quota pauses missions with a bounded resume time", () => {
    const disposition = classifyProviderFailure(
      { status: 429, code: "gousagelimiterror", headers: { "retry-after": "45" } },
      5,
      "tier-3-local",
    );
    expect(disposition.action).toBe("pause-missions");
    if (disposition.action === "pause-missions") {
      expect(disposition.resumeAfterMs).toBe(45000);
      expect(disposition.reason.length).toBeGreaterThan(0);
    }
  });
});

describe("classifyProviderFailure transient 429", () => {
  test("plain 429 without quota shape becomes retry-delay honoring Retry-After", () => {
    const disposition = classifyProviderFailure(
      { status: 429, headers: { "retry-after": "12" } },
      1,
      "tier-1-opencode",
    );
    expect(disposition).toEqual({ action: "retry-delay", delayMs: 12000 });
  });

  test("plain 429 without headers uses the clamped default", () => {
    expect(classifyProviderFailure({ status: 429 }, 0, "tier-1-opencode")).toEqual({
      action: "retry-delay",
      delayMs: 5000,
    });
  });

  test("transient 429 never pauses missions on any tier", () => {
    for (const tier of ["tier-1-opencode", "tier-2-commercial", "tier-3-local"] as const) {
      const disposition = classifyProviderFailure({ status: 429, message: "slow down" }, 4, tier);
      expect(disposition.action).toBe("retry-delay");
    }
  });
});
