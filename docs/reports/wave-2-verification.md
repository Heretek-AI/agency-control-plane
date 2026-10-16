# Wave 2 Verification Report — Drift Guard Adversarial Audit

- Stage: wave-2 (Crash-Safe Worktrees, Transactional Landing & HTTP/SSE Control Server)
- Branch: `wave-2-worktrees-server`
- Worktree: `/home/john/Projects/Heretek-AI-Rebuild/agency-control-plane-wave-2`
- Auditor: `agency-drift-guard` (Muse Spark 1.3 Contributor) — read-only; no code touched, no commits, no subagents
- Date (UTC): 2026-10-16
- Commit audited: `7e5a9b8` (+ untracked `docs/evidence/wave-2/red-proofs.log` only)
- Sources read from disk: `AGENTS.md`, `docs/prompts/SPEC.md` (§§2.2, 3.5–3.9),
  `docs/prompts/verify-stage.md`, `docs/reports/wave-2.md`,
  `docs/evidence/wave-2/red-proofs.log`, `dispatcher/src/{worktrees,landing,event-bus,approval-tickets,server,index}.ts`,
  `dispatcher/test/{worktrees-landing,server-api}.test.ts`, `scripts/accept/{wave-1,wave-2}.sh`

Independent execution: `bun run check` → exit 0; `bun test` → 66 pass / 0 fail / 185 assertions;
`bash scripts/accept/wave-2.sh` → exit 0 (`[wave-2] PASS`);
`bash scripts/accept/wave-1.sh` → exit 0 (no regression); plus a read-only
`bun -e` fail-closed probe (5/5 true, no repo mutation).

## 1. Scope — PASS

- Committed Wave 2 files live ONLY under `dispatcher/`, `docs/reports/`, `scripts/accept/`
  (`git show --name-only HEAD`: 6 src + 2 test + report + accept script). No file outside
  `dispatcher/`, `web/`, `docs/`, `scripts/`, root configs.
- `web/` untouched by Wave 2: contains only pre-existing `package.json` + `tsconfig.json`;
  `git status --short web/` clean, zero source files added.
- Forbidden-content grep over `dispatcher/`: the ONLY hits are the STRINGS
  `"src/omni/*"` / `"src/omni/graph.ts"` as fixture path data in
  `dispatcher/test/scheduler.test.ts:106-107` (Wave 1 overlap test, not SwarmOS code).
  No `src/omni` directory exists, no `swarmos-plugin.ts` exists, no AST parsers, no MCP tools.

## 2. Fix 2 binding (SQLite / .opencode isolation / ring-buffered SSE / NATS bridge) — PASS

- `PRAGMA busy_timeout = 15000; PRAGMA journal_mode = WAL;` present as
  `WORKTREE_PRAGMAS` (`dispatcher/src/worktrees.ts:49-52`) and applied to EVERY
  `WorktreeStore` handle in the constructor (`:119-123`).
- Per-worktree `.opencode` isolation: `isolateOpencodeState` (`:251-260`) creates a fresh
  `.opencode/fleet-isolation.json` per worktree (never shared/copied), called on every
  `allocateWorktree` success path (`:308`); asserted by test (`worktrees-landing.test.ts:59-63`).
- Ring-buffered SSE with gap markers + replay: `EventBus` bounded (default 1000,
  positive-integer enforced, `:74-79`), monotonic seq, drop-oldest + `dropped` count,
  `replaySince` emits `SequenceGap { fromSeq, toSeq, dropped }` (`:130-139`),
  serialized as `fleet.gap` (`gapToSSE`, `:55-58`); `GET /api/events` honors
  `Last-Event-ID` header/query, emits gap before replay in both snapshot and live modes
  (`server.ts:397-471`), with keepalive + abort cleanup.
- NATS bridge fully implemented, no stubs: `JetStreamBridge` interface +
  `InMemoryJetStreamBridge` with real per-subject rings (monotonic seq, drop-oldest),
  revisioned KV with fail-closed miss errors, `connect(url)` + `endpointFromEnv()` reading
  `NATS_URL` (`event-bus.ts:176-327`). Zero stub patterns in the file.
  Advisory (non-blocking): no live NATS client dependency and no dedicated bridge test —
  but SPEC §3.7 permits the in-process bus with identical gap semantics, the twin has exact
  logic throughout, and the programmer's report discloses this openly. Not a stub by any
  lexical or behavioral measure.

## 3. worktrees (2-phase, cleanup, jj+git, salvage) — PASS

- `recordAllocating` (phase 1, BEFORE filesystem work, `:138-150`) → `markAllocated`
  (phase 2, AFTER worktree + `.opencode` exist, `:153-161`, fail-closed with no allocating row).
  Double-allocation rejected (`:140-142`).
- `cleanupUnconfirmed` reaps stale `allocating` rows + orphaned dirs, reports ALL failures
  instead of stopping at first (`:346-380`); `maxAgeMs` freshness honored.
- `jj workspace add` when `.jj` present (`detectBackend`, `:106-108`; `:300-301`), fallback
  `git worktree add -b fleet/<taskId>` (`:302-307`); existing branches attach at tip, never moved.
  Note: `jj` path implemented but exercised via git in tests (`jj` not installed here) —
  disclosed in the report; backend selection itself is tested (`detectBackend` → `git`).
- `salvageWorktree` anchors `refs/fleet-salvage/<taskId>` via `update-ref` BEFORE `branch -D`
  (`:437-438`), fails closed while a worktree still uses the branch (`:430-433`), upserts a
  `salvage` row surviving release (`markSalvage`, `:163-180`).

## 4. landing (throwaway worktree, --no-ff, verify, rollback) — PASS

- Pre-checks run in the task worktree; failure merges nothing, integration branch never created
  (`landing.ts:96-118`); missing task branch fails closed at `precheck` (`:86-93`).
- `--no-ff` merge onto `fleet/integration/<missionId>` inside a THROWAWAY landing worktree
  (`:127-137`, `:146-157`); throwaway ALWAYS removed via `finally` (`:233-235`).
- Conflict → `merge --abort`, tip-integrity re-check, conflicting files reported, `rolledBack: true`
  (`:158-200`); task branch never moved/deleted.
- Verify-red → atomic `reset --hard` to recorded pre-merge SHA (`:212-222`); success returns
  the merge commit SHA (`:226-232`). Discriminated union carries
  `{ ok, mergedSha?, reason?, stage: precheck|merge|verify, rolledBack, files? }` per spec.

## 5. approval-tickets (single-use 60s TTL, binding, Ed25519, loopback) — PASS

- `TICKET_TTL_MS = 60_000`, random 256-bit token (`randomBytes(32)`), bound to
  `{ taskId, subjectHash }` (`approval-tickets.ts:33-34, 88-103`); injectable clock for TTL tests.
- Consume-on-verify (`verifyTicket`, `:106-120`) and binding-checked `redeemTicket` that BURNS
  on mismatch so it cannot be retried elsewhere (`:128-148`); unknown/expired/reused/mismatch
  throw fail-closed `TicketError`s with descriptive codes.
- Ed25519 over `node:crypto`, in-memory only: `generateApprovalKeyPair`, `passphraseToKeypair`
  (SHA-256 seed → PKCS8, empty rejected, `:210-225`), `signSubjectHash`,
  `verifyApprovalSignature` returning false on malformed/mismatched input (`:238-248`).
- Independently probed (read-only `bun -e`): ticket-reuse fail-closed TRUE, wrong-passphrase
  fail-closed TRUE, binding-burn fail-closed TRUE.

## 6. server (all 6 endpoints, 127.0.0.1, SSE replay, CSRF/loopback, audit, tier wiring) — PASS

- Routes present and correct: `GET /api/board` (5 columns, tasks, worktree statuses, missions,
  messages, `activeTier`, DAG edges, scheduler start plan), `POST /api/director/message`
  (bullet decomposition, capped at 50, empty → 400), `GET /api/tasks/:id/drilldown`
  (session metadata, stage gates, tool-log buffer, `[{ file, status, additions, deletions, patch }]`
  hunks with recorded-diff fallback), `POST /api/approvals/:taskId/ticket`,
  `POST /api/approvals/:taskId/sign`, `GET /api/events` (replay + live SSE, `?snapshot=1`
  finite replay), plus `GET /api/csrf`.
- Loopback guard: non-loopback `Host` → 403 (`server.ts:631-633`); `startServer` refuses
  non-loopback bind (`:745-749`); independently probed non-loopback → 403 TRUE.
- CSRF: POST routes require matching `x-csrf-token` → 403 otherwise (`:656-657, :663-664`).
- Sign: ticket redeem + Ed25519 verify, `waitingHuman` → `ready` (approve) / `pending` (reject),
  non-`waitingHuman` → 409 (`:550-627`); ticket replay → 403 (tested).
- Every state-changing route appends to `audit.ts` and publishes a bus event; provider failures
  route through `classifyProviderFailure` and move `activeTier` on fallback (`:682-693`).

## 7. Zero stubs & security hygiene — PASS

- Zero-stub grep (same pattern family as `verify-stage.md` §5, over `dispatcher/` +
  `scripts/accept/wave-2.sh`): EMPTY. No TODO/FIXME/XXX/HACK, no dummy passes, no `|| true`
  in source, no `return true;`, no empty `catch {}` (every `catch` recovers with a fallback
  path or rethrows with context; `verifyApprovalSignature`'s `catch { return false; }` is
  fail-closed logic, not a swallow). No `set +e` (the single grep hit for `set +` is the
  accept script's own self-check pattern, split so it never matches itself). No vacuous asserts.
- Ticket tokens NEVER written to the audit log: `approval.ticket-minted` logs only
  `{ taskId, subjectHash }` (`server.ts:543`); `approval.signed` logs only
  `{ taskId, subjectHash, approve, status }` (`:616-621`). Bearer-secret hygiene holds.
- Passphrase lives only in the `handleSign` closure (`let passphrase … :584-585`) and is
  cleared in `finally` (`passphrase = null`, `:624-626`); never persisted, never logged.

## 8. Evidence (red-proofs, 66 pass, both accepts) — PASS

- `docs/evidence/wave-2/red-proofs.log`: 3 sabotages, each FAIL-when-broken (exit 1, exactly
  the guarding test red) and PASS-when-restored (exit 0, full file green), each restored via
  `git checkout --` with `git status --short` verified clean — A (ticket single-use burn),
  B (landing `reset --hard` rollback), C (SSE `fleet.gap` marker). Log diffs are minimal and
  match the described sabotages. Final state green: `bun run check` exit 0, `bun test`
  66 pass / 0 fail / 185 assertions, `git stash list` empty, no QA commits.
- Independently re-ran: `make check` equivalent exit 0, `bun test` 66/66, `wave-2.sh` exit 0,
  `wave-1.sh` exit 0 (no regression).
- QA count nit assessed NON-MATERIAL: `docs/reports/wave-2.md` says
  `worktrees-landing.test.ts` has "13 tests" — the file contains 12
  (`grep -c 'test('` → 12 worktrees-landing + 20 server-api = 32 Wave-2; 34 + 32 = 66 total,
  consistent with every green run). Off-by-one in prose only; test evidence itself is complete
  (4 two-phase + 2 cleanup + 2 salvage + 4 landing = 12, all spec behaviors covered).
  Recommend a one-word report fix at next touch; NOT a gate failure.

## Findings

None blocking. Zero stubs, zero scope violations, all contracts satisfied, all guards
proven fail-closed both by QA sabotage and by this auditor's independent probe.

VERDICT: PASS
