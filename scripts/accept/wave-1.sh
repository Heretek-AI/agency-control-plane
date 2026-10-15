#!/usr/bin/env bash
# Wave 1 acceptance: pure scheduler, wildcard arbiter, 3-tier limits, audit chain.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT"

echo "[wave-1] bun install"
bun install

echo "[wave-1] typecheck dispatcher"
bun run --filter './dispatcher' check

echo "[wave-1] unit tests"
bun test

echo "[wave-1] zero-stub grep (must print nothing)"
W1='TO'"DO"
W2='FI'"XME"
W3='X'"XX"
W4='HA'"CK"
W5='not implemen'"ted"
W6=$(printf '%s "%s"' 'ec'"ho" 'pas'"sed")
W7=$(printf '%s%s %s' '\|' '\|' 'tr'"ue")
W8='ret'"urn true;"
P_STUB="${W1}|${W2}|${W3}|${W4}|${W5}|${W6}|${W7}|${W8}|catch *\(.*\) *\{\}"
STUBS="$(grep -rn --include='*.ts' --include='*.sh' -E "${P_STUB}" dispatcher scripts/accept/wave-1.sh || [ $? -eq 1 ])"
if [ -n "$STUBS" ]; then
  echo "$STUBS"
  echo "[wave-1] FAIL: stub patterns found" >&2
  exit 1
fi
if grep -rn 'set +'"'e'" scripts/accept/wave-1.sh; then
  echo "[wave-1] FAIL: relaxed error handling found" >&2
  exit 1
fi

echo "[wave-1] required deliverables present"
for f in \
  dispatcher/src/model.ts \
  dispatcher/src/wildcard.ts \
  dispatcher/src/scheduler.ts \
  dispatcher/src/limits.ts \
  dispatcher/src/audit.ts \
  dispatcher/src/index.ts \
  dispatcher/test/scheduler.test.ts \
  dispatcher/test/limits.test.ts \
  scripts/accept/wave-1.sh \
  docs/reports/wave-1.md \
; do
  test -f "$f" || { echo "[wave-1] FAIL: missing $f" >&2; exit 1; }
done

echo "[wave-1] scheduler + limits behavior probe"
bun -e '
import { schedule } from "./dispatcher/src/scheduler.ts";
import { classifyProviderFailure } from "./dispatcher/src/limits.ts";
import { checkAnchor, appendAudit } from "./dispatcher/src/audit.ts";
import { mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

const base = (id, extra = {}) => ({
  missionId: "m-1", kind: "expert-run", expert: "coder", deps: [],
  strategy: "all_success", input: { objective: "x", acceptance: [], paths: [] },
  owner: [], policy: { strategy: "fail" }, status: "pending", attempts: 0, id, ...extra,
});

// all_success ready + cascade cancel
let r = schedule([base("a", { status: "done" }), base("b", { deps: ["a"] })], [], { fleet: 2 });
if (JSON.stringify(r.start) !== JSON.stringify(["b"])) throw new Error("all_success ready failed");
r = schedule([base("a", { status: "failed" }), base("b", { deps: ["a"] })], [], { fleet: 2 });
if (JSON.stringify(r.cancel) !== JSON.stringify(["b"])) throw new Error("cascade cancel failed");

// overlap serialization
r = schedule([
  base("a", { input: { objective: "x", acceptance: [], paths: ["src/a/*"] } }),
  base("b", { input: { objective: "y", acceptance: [], paths: ["src/a/f.ts"] } }),
], [], { fleet: 4 });
if (JSON.stringify(r.start) !== JSON.stringify(["a"])) throw new Error("overlap serialization failed");

// 429 quota on tier-1 must route, never pause
const d = classifyProviderFailure({ status: 429, code: "gousagelimiterror" }, 9, "tier-1-opencode");
if (d.action !== "route-fallback") throw new Error("tier-1 quota must route-fallback, got " + d.action);

// audit append + anchor
const dir = mkdtempSync(join(tmpdir(), "wave1-accept-"));
const log = join(dir, "audit.jsonl");
appendAudit(log, "probe", { key: "sk-secret-should-redact" });
const check = checkAnchor(log);
if (!check.ok || check.records !== 1) throw new Error("audit anchor failed: " + check.reason);
console.log("[wave-1] behavior probe passed");
'

echo "[wave-1] PASS"
