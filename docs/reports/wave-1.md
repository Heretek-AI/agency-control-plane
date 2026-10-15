# Wave 1 Report — Pure Scheduler, Path-Overlap Arbiter, 3-Tier Failover Limits & Audit Chain

- Stage ID: wave-1
- Branch: `wave-1-scheduler-limits`
- Worktree: `/tmp/opencode/agency-control-plane-wave-1`

## Summary of deliverables

Implemented the Wave 1 dispatcher foundation per `docs/prompts/SPEC.md` §§2.1, 3.1–3.4:

- `dispatcher/src/model.ts` — zod schemas for `Task` (id, missionId, kind
  `expert-run|verify|land|human`, status
  `backlog|pending|ready|running|waitingHuman|done|failed|cancelled`, deps,
  gating `strategy` `all_success|one_success` with legacy `trigger` alias,
  `input.paths`, `owner` paths, retry `policy`), `Mission`, and
  `ApprovalTicket`, plus `TaskStatuses` / `MissionStatuses` constants and the
  `gateStrategy` helper. `waitingHuman` is a first-class parked state.
- `dispatcher/src/wildcard.ts` — `match` (OpenCode dialect: `*` spans `/`,
  `?` matches one char, backslash normalization, trailing ` *` matches the
  bare prefix), `literalPrefix`, and conservative `mayOverlap`.
- `dispatcher/src/scheduler.ts` — pure `schedule(tasks, runningIds, caps)`
  with `all_success` / `one_success` readiness, id-ordered fixpoint cascade
  cancellation, exported `pathsOverlap` overlap lock enforced against both
  running tasks (`blockedByOverlap`) and already-selected candidates
  (`collidesSelected`), fleet + per-expert caps with overflow to `ready`,
  `waitingHuman` tasks never starting and never forcing downstream
  cancellation, and `nextStatus` (`success`→`done`, `fail`→`failed`,
  `replan`→`waitingHuman`, `retry`→`pending` while
  `attempts <= maxAttempts` else `failed`).
- `dispatcher/src/limits.ts` — `extractRetryAfterMs` (`retry-after-ms`
  precedence, `retry-after` delta-seconds or HTTP-Date, case-insensitive,
  clamped `[1000, 300000]`) and `classifyProviderFailure` with the 3-tier
  Bifrost failover: quota-shaped failures (`402`, `gousagelimiterror` /
  `freeusagelimiterror` / `insufficient_quota` codes, quota regex on the
  message) route `tier-1-opencode`→`tier-2-commercial`→`tier-3-local` with
  ZERO mission pause on tiers 1–2; tier-3 pauses with a bounded
  `resumeAfterMs`; plain 429s become `retry-delay`; unknown errors get a
  bounded exponential-backoff `retry-delay` (fail-closed, never a freeze).
- `dispatcher/src/audit.ts` — self-contained hash-chained JSONL ledger
  (`seq,timestamp,event,data,prevHash,hash`, SHA-256 over canonical JSON):
  secrets redacted before hashing (`sk-*`, `Bearer *`, `OPENCODE_API_KEY`,
  sensitive keys), `O_APPEND` + `fsync` per record, torn-tail fails closed
  with byte offset, appends refuse a corrupt chain, and `checkAnchor`
  replays the chain (plus optional tip-anchor comparison defeating
  wholesale valid-chain rewrites).
- `dispatcher/src/index.ts` — barrel exports.
- `dispatcher/package.json` (`@heretek-ai/agency-dispatcher`, zod,
  `check` = `tsc --noEmit`, `test` = `bun test`) plus
  `dispatcher/tsconfig.json`; minimal `web/package.json`
  (`@heretek-ai/agency-web`) + `web/tsconfig.json` so the Bun workspace
  root installs (Wave 3 fills in the WebUI).
- `dispatcher/test/scheduler.test.ts` (22 tests), `dispatcher/test/limits.test.ts`
  (12 tests), `scripts/accept/wave-1.sh`, this report.

## Decisions

- Status enum is the union of the wave brief (`backlog`, camelCase
  `waitingHuman`) and the salvaged lifecycle (`pending` required by the
  `retry` path); `backlog` is treated as startable like `pending`.
- Gating field is `strategy` per the wave brief, with `trigger` accepted as
  a winning alias so salvaged graphs keep exact semantics (`gateStrategy`).
- `pathsOverlap` is exported (SPEC names the `pathsOverlap` lock; QA
  red-proof sabotage targets it by name).
- `audit.ts` is dependency-free (hash/canonical/redact inlined) so Wave 1
  needs no `util/` surface; functional API (`appendAudit`/`checkAnchor`)
  matches the SPEC contract exactly.

## Test evidence

- `bun run check` (`tsc --noEmit`): zero errors, zero warnings.
- `bun test`: 34 pass, 0 fail, 63 assertions across
  `scheduler.test.ts` + `limits.test.ts`.
- `bash scripts/accept/wave-1.sh`: PASS — install, typecheck, tests,
  zero-stub grep clean, all deliverables present, behavior probe passed
  (all_success ready, cascade cancel, overlap serialization, tier-1 429
  quota → `route-fallback`, audit append + anchor).

## Self-audit notes

- Zero stubs: no `TODO|FIXME|XXX|HACK`, no dummy passes, no swallowed
  errors, no `set +e`; every exported function has exact logic.
- Scope: new files only under `dispatcher/`, `web/package.json` +
  `web/tsconfig.json` (workspace-required configs), `docs/reports/`,
  `scripts/accept/`; no SwarmOS, no AST parsers, no domain MCP tools.
- Fail-closed: unknown provider errors retry with bounded backoff (never a
  global freeze); corrupt audit logs refuse appends; ticket/auth surface is
  Wave 2 and untouched.
