# Wave 1 Verification — Drift Guard Adversarial Audit

- Stage: wave-1
- Branch: `wave-1-scheduler-limits`
- Worktree: `/home/john/Projects/Heretek-AI-Rebuild/agency-control-plane-wave-1`
- Auditor: Drift Guard (adversarial, read-only except this file)
- Date (UTC): 2026-10-16
- Programmer report: `docs/reports/wave-1.md`
- QA evidence: `docs/evidence/wave-1/red-proofs.log`

## 1. Files audited (read from disk)

- `AGENTS.md`
- `docs/prompts/SPEC.md` (§§0, 1, 2.1, 3.1–3.4)
- `docs/prompts/verify-stage.md`
- `docs/reports/wave-1.md`
- `docs/evidence/wave-1/red-proofs.log`
- `dispatcher/src/model.ts` (154 lines)
- `dispatcher/src/wildcard.ts` (43 lines)
- `dispatcher/src/scheduler.ts` (189 lines)
- `dispatcher/src/limits.ts` (138 lines)
- `dispatcher/src/audit.ts` (283 lines)
- `dispatcher/src/index.ts` (5 lines)
- `dispatcher/test/scheduler.test.ts` (229 lines, 19 tests)
- `dispatcher/test/limits.test.ts` (134 lines, 15 tests)
- `scripts/accept/wave-1.sh` (95 lines)

## 2. Scope refusal check — PASS

- No `src/omni` directory, no `swarmos-plugin.ts`, no top-level `src/` at all (verified `ls` + `find`).
- `git ls-files` tracked set lives ONLY under `dispatcher/`, `docs/`, `scripts/`, `web/package.json` + `web/tsconfig.json` (workspace-required configs), plus repo-root scaffolding (`AGENTS.md`, `Makefile`, `package.json`, `tsconfig.json`, `MASTER_BUILD_PROMPT.md`, `.gitignore`, `bun.lock`) — all allowed.
- `grep -rniE 'ast-parser|createMCP|mcp.*tool|swarmos' dispatcher/src dispatcher/test scripts/accept/wave-1.sh` → CLEAN (no output).
- `src/omni` string hits are fixture path STRINGS only (`dispatcher/test/scheduler.test.ts:106-107` `"src/omni/*"`, `"src/omni/graph.ts"` inside `pathsOverlap` overlap tests) plus SPEC/verify-stage/red-proofs mentions — explicitly NOT violations per audit brief.
- `web/` contains only `package.json` + `tsconfig.json`; `web/src` absent (correct for Wave 1).
- Branch is `wave-1-scheduler-limits` — PASS.

## 3. Spec fidelity (§§3.1–3.4) — PASS all

### 3.1 wildcard.ts `mayOverlap` — PASS
- `match`: OpenCode dialect (`*`→`.*` spans `/`, `?`→`.`, backslash→`/`, trailing ` *` matches bare prefix via `( .*)?`) — matches SPEC.
- `literalPrefix`: text before first `*`/`?` — matches SPEC.
- `mayOverlap`: true when either literal prefix is a prefix of the other — conservative, over-serializes, never collides. Independent probe: `mayOverlap("src/a/*","src/a/f.ts")===true`, `mayOverlap("src/alpha/*","src/beta/*")===false` — OK.

### 3.2 scheduler.ts `schedule` / `nextStatus` / `pathsOverlap` — PASS
- `all_success`: ready iff every dep `done`; cancel iff any dep `failed`/`cancelled`; fixpoint closure id-ordered deterministic (cancel-view map) — verified in source lines 91–116 + tests.
- `one_success`: ready iff ≥1 dep `done`; cancel iff deps non-empty and every dep terminal with zero `done` — lines 56–70. Independent probe confirmed ready + cancel + no-cancel-while-pending — OK.
- Overlap lock: exported `pathsOverlap` (kind-gated `expert-run` + any `mayOverlap` over `input.paths`), enforced against running (`blockedByOverlap`, lines 150–155) AND already-selected (`collidesSelected`, line 156) — both present, tested, probed — OK.
- `waitingHuman` never starts (excluded from candidates, lines 118–129 only admit backlog/pending/ready) and never forces downstream cancellation (`waitingHuman` is neither `done` for `depsMet` nor `failed`/`cancelled` for `neverRunnable`) — independent probe: `{start:[],ready:[],cancel:[]}` for waiter+downstream — OK.
- Caps: id-ordered starts, fleet cap + per-expert cap, overflow → `ready` — lines 139–172 — OK.
- `nextStatus`: `success`→`done`; `fail`→`failed`; `replan`→`waitingHuman`; `retry`→`pending` while `attempts <= maxAttempts` else `failed` — line 188 exact — OK.

### 3.3 limits.ts `extractRetryAfterMs` + `classifyProviderFailure` — PASS
- `extractRetryAfterMs`: `retry-after-ms` precedence (raw ms), else `retry-after` delta-seconds or HTTP-Date, case-insensitive lookup, invalid/negative → default, fallback `defaultMs ?? 5000`, clamp `[1000,300000]` — lines 56–89. Tests cover precedence, seconds, HTTP-Date, case-insensitivity, defaults, invalid, clamp both ends. Independent probe: lo `5ms`→`1000`, `3600s`→`300000` — OK.
- `classifyProviderFailure` quota shapes: `status===402`, code `/gousagelimiterror|freeusagelimiterror|insufficient_quota/i`, 429 body `/usage limit|quota exceeded|insufficient quota|credit balance/i` — lines 32–33, 91–95 — exact per SPEC.
- Tier chain: tier-1→`route-fallback tier-2-commercial` (ZERO pause), tier-2→`route-fallback tier-3-local`, tier-3→`pause-missions` with `resumeAfterMs = extractRetryAfterMs(headers)` — lines 114–127 — ZERO global-freeze loop present — OK.
- Transient 429 (no quota shape) → `retry-delay` with `extractRetryAfterMs(headers)` — line 129–131 — OK.
- Unknown errors → bounded exponential-backoff `retry-delay` (fail-closed, never freeze) — lines 133–137. Noted: exceeds SPEC minimum (SPEC only mandates quota + plain-429) but is strictly fail-closed and covered by invariant "never a freeze" — accepted, no delta.
- Independent probes IND-1 (tier-1 quota → route-fallback), IND-2 (transient 429 → retry-delay, all tiers), IND-3 (clamp) — all FAIL-CLOSED-OK.

### 3.4 audit.ts hash-chained JSONL — PASS
- Record shape `{seq,timestamp,event,data,prevHash,hash}`, `hash = SHA-256(prevHash + ":" + canonicalJson({seq,timestamp,event,data}))` — lines 105–115. Canonical JSON sorted-keys — lines 61–69.
- Redaction BEFORE hashing: `sk-*`, `xox*`, `gh*_*`, `Bearer *`, `OPENCODE_API_KEY`, `api-key|secret|password|token` key/value patterns + sensitive-key subtree — lines 71–103, applied in `createRecord` line 128 — OK.
- Append-only `O_APPEND` (`openSync(logPath,"a")`) + `fsync` per record — lines 222–226 — OK.
- Torn tail fails closed with byte offset (`TornLogError`, missing trailing newline, unparseable line) — lines 154–188 — OK.
- `checkAnchor` replays chain (bad seq / prevHash mismatch / hash mismatch) + optional tip-anchor defeating wholesale valid-chain rewrites + genesis anchor — lines 190–266 — exceeds SPEC minimum (torn-tail + equal-length-rewrite coverage explicitly required — present) — OK.
- `appendAudit` refuses corrupt chain — lines 216–219 — fail-closed — OK.
- Independent probes IND-4 (equal-length `1`→`9` rewrite → `ok:false "hash mismatch at seq 1"`) and IND-5 (secrets redacted, no `sk-`/`Bearer` leak in log) — both FAIL-CLOSED-OK.

### Model (supporting) — PASS
- Statuses include `backlog|pending|ready|running|waitingHuman|done|failed|cancelled`; `gateStrategy` trigger-alias-wins; `waitingHuman` literal centralized in `TaskStatuses` — matches report decisions, no SPEC conflict.

## 4. Zero-stub grep — PASS

- verify-stage pattern `grep -rn --include='*.ts' --include='*.tsx' --include='*.sh' -E 'TODO|FIXME|XXX|HACK|return true;|echo "passed"|\|\| true|catch *\(.*\) *\{\}' dispatcher web scripts` → CLEAN (empty output).
- Extended `grep -rniE 'TODO|FIXME|not implemented|placeholder' dispatcher/src dispatcher/test scripts/accept/wave-1.sh` → CLEAN (empty).
- Broader repo grep hits exactly one line: `docs/reports/wave-1.md:80` documenting the grep itself ("no `TODO|FIXME|XXX|HACK`") — this is a self-audit sentence, not a stub marker; no production/test/script file contains a stub. Judged PASS (not a finding).
- Accept-script self-check fragmented literals (`W1='TO'"DO"` etc.) are intentional anti-evasion construction, explicitly excluded per audit brief — not a violation.
- No `set +e`, no `|| true`, no `cmd:"true"`/`echo pass` shortcuts, no empty catch blocks — PASS.
- Every exported function contains exact logic; no `TODO`/`placeholder` bodies — PASS.

## 5. Security — PASS

- Secrets redacted before hashing (see §3.4); no `Bearer`/`sk-*` literals in source except redaction regexes themselves.
- `grep -rniE 'sk-[A-Za-z0-9]|Bearer [A-Za-z0-9]|OPENCODE_API_KEY' dispatcher/src` hits only `audit.ts` redaction logic (lines 77, 85) — no hardcoded credentials — PASS.
- Independent IND-5 probe confirms logged record contains only `[REDACTED]` — PASS.

## 6. Evidence: QA red-proofs + green build + accept — PASS

- `docs/evidence/wave-1/red-proofs.log` exists, records 3 sabotages (A: limits global-freeze regression → 3 limits tests FAIL → `git checkout --` restore → 15 pass; B: `pathsOverlap→false` → 3 scheduler tests FAIL → restore → 19 pass; C: audit `prevHash=GENESIS` break → probe `ok:false prevHash mismatch` → restore → `ok:true`) with FAIL→PASS transcripts and `git status --short` clean proof — all fail-closed assertions genuine (sabotage diffs target the exact guarded invariants).
- Independent auditor re-ran: `bun install` + `bun test` → `34 pass, 0 fail, 63 expect() calls` (matches QA baseline; initial run without install showed missing `zod` — resolved by `bun install`, expected workspace behavior, not a finding).
- `bash scripts/accept/wave-1.sh` → exit 0, `[wave-1] PASS` (install, typecheck, 34 pass, stub-grep clean, 10 deliverables, behavior probe) — PASS.
- `bun run --filter './dispatcher' check` (`tsc --noEmit`) → exit 0 — PASS.
- Independent fail-closed probes by auditor (IND-1…IND-5, plus waitingHuman/one_success/mayOverlap/nextStatus probes, all via `bun -e` without modifying sources): tier-1 quota routes (never pauses), transient 429 retry-delays, clamp bounds, tamper detected, secrets redacted, waiter parks cleanly — all OK. At least 2 key assertions (tier-1 no-freeze, tamper detection) independently verified fail-closed — PASS.
- Sabotaged paths currently clean (`git status --short dispatcher/src/` empty) — PASS.

## 7. Git hygiene — PASS

- Branch `wave-1-scheduler-limits` confirmed.
- `.gitignore` contains `!docs/evidence/**/*.log` exception; `git check-ignore docs/evidence/wave-1/red-proofs.log` → not ignored (trackable); `git ls-files` shows it tracked — PASS.
- `git log` shows Wave 0 bootstrap + Wave 1 implementation + gitignore fix; worktree left with no modified tracked files before this verdict.

## 8. Spec deltas — none blocking

- `audit.ts` adds `anchorTip`/`readAuditRecords`/`TornLogError.offset`/`genesis-anchor` helpers beyond the minimal SPEC contract — strictly additive, fail-closed, tested via red-proof C — accepted.
- `limits.ts` unknown-error exponential-backoff `retry-delay` exceeds SPEC minimum — strictly fail-closed (bounded, never freezes) — accepted.
- `model.ts` admits `backlog` as startable alongside `pending` and `trigger` alias winning over `strategy` — documented in wave-1.md decisions, preserves salvaged-graph semantics, no SPEC contradiction — accepted.
- No omitted requirements, no simplified semantics found.

## 9. Findings — none

No FAIL items. No file:line defects to enumerate. Programmer rework required: none.

---

VERDICT: PASS
