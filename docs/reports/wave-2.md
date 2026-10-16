# Wave 2 Report — Crash-Safe Worktrees, Transactional Landing & HTTP/SSE Control Server

- Stage ID: wave-2
- Branch: `wave-2-worktrees-server`
- Worktree: `/home/john/Projects/Heretek-AI-Rebuild/agency-control-plane-wave-2`

## Summary of deliverables

Implemented the Wave 2 dispatcher surface per `docs/prompts/SPEC.md` §§2.2, 3.5–3.9,
wiring the Wave 1 foundation (scheduler, 3-tier limits, audit chain) into a
loopback control plane:

- `dispatcher/src/worktrees.ts` — two-phase crash-safe allocation: the
  `allocating` row is recorded in a SQLite register (every handle applies
  `PRAGMA busy_timeout = 15000; PRAGMA journal_mode = WAL;`) BEFORE any
  filesystem work and flips to `allocated` only after the worktree plus
  isolated `.opencode/fleet-isolation.json` state exist. `cleanupUnconfirmed`
  reaps stale `allocating` rows and orphaned directories on startup (all
  failures reported, never stopping at the first). Backend detection:
  `.jj` present → `jj workspace add`, else `git worktree add -b
  fleet/<taskId>` (existing branches attach at their tip, never moved).
  `salvageWorktree` anchors `refs/fleet-salvage/<taskId>` at the abandoned
  tip BEFORE `branch -D`, fails closed while a worktree still uses the
  branch, and upserts a `salvage` row so the fact survives the release
  that must precede it. Exports `WorktreeRecord { taskId, branch, path,
  backend: jj|git, state: allocating|allocated|salvage }`.
- `dispatcher/src/landing.ts` — transactional `landTask`: pre-checks run
  in the task worktree (nothing merges before they pass), then a
  `--no-ff` merge onto `fleet/integration/<missionId>` inside a
  THROWAWAY landing worktree (always removed, every path), then the
  post-merge verification callback. Conflict → `merge --abort`, tip
  integrity re-checked, conflicting files reported. Verification red →
  `reset --hard` to the recorded pre-merge SHA. Returns the
  `{ ok, mergedSha, rolledBack }` discriminated union (`{ ok: false,
  reason, stage: precheck|merge|verify, rolledBack, files? }`).
- `dispatcher/src/event-bus.ts` — bounded ring buffer (default 1000,
  configurable, positive-integer enforced) with monotonic sequence IDs,
  backpressure drop-oldest plus a `SequenceGap { fromSeq, toSeq,
  dropped }` marker on replay, per-subscriber replay from any sequence
  ID then live delivery (`publish`, `subscribe` → `{ unsubscribe,
  gap }`, `replaySince`, `toSSE`/`gapToSSE` serializers). The NATS
  JetStream / KV blackboard bridge is a fully functional in-memory
  implementation of the documented `JetStreamBridge` contract
  (per-subject rings with identical gap semantics, revisioned KV with
  fail-closed miss errors, `connect(url)` + `endpointFromEnv()` reading
  `NATS_URL`): same behavior with or without NATS, zero stubs.
- `dispatcher/src/approval-tickets.ts` — `TicketStore` with
  `mintTicket(taskId, subjectHash)` (random 256-bit token, 60s TTL),
  consume-on-verify `verifyTicket`, and binding-checked `redeemTicket`
  (mismatch burns the ticket so it cannot be retried elsewhere);
  unknown/expired/reused/mismatched tokens throw fail-closed
  `TicketError`s. Loopback Ed25519 helpers over `node:crypto`:
  `generateApprovalKeyPair`, `passphraseToKeypair` (SHA-256 seed →
  PKCS8 import; empty passphrase rejected), `signSubjectHash`,
  `verifyApprovalSignature` (false on malformed or mismatched input),
  plus `hashSubject` for binding diff summaries to tickets.
- `dispatcher/src/server.ts` — `createServer()` (in-process `fetch`
  handler, fully testable without sockets) plus `startServer()` (Bun
  HTTP on loopback only; non-loopback hostname refused). Routes per the
  API contract: `GET /api/board` (5 Kanban columns, tasks, worktree
  statuses from the attached store, missions, director messages, active
  tier, DAG edges, scheduler start plan), `POST /api/director/message`
  (bullet decomposition into task cards, capped at 50), `GET
  /api/tasks/:id/drilldown` (session metadata, stage gates, tool-log
  buffer, live `git diff base...branch` hunks with recorded-diff
  fallback), `POST /api/approvals/:taskId/ticket` (single-use 60s TTL,
  token never written to the audit log), `POST
  /api/approvals/:taskId/sign` (ticket redeem + Ed25519 verify via
  presented key or passphrase-derived key, passphrase held only in the
  handler closure and cleared in `finally`; `waitingHuman` → `ready` on
  approve, → `pending` on reject; 409 otherwise), `GET /api/events`
  (replay + live SSE with keepalive, `Last-Event-ID` header or query,
  `?snapshot=1` finite replay for inspector loads), `GET /api/csrf`.
  Guards: non-loopback `Host` → 403, missing/bad `x-csrf-token` on POST
  → 403. Every state-changing route appends to `audit.ts` and publishes
  a bus event; provider failures route through
  `classifyProviderFailure` and move `activeTier` on fallback.
- `dispatcher/src/index.ts` — barrel exports all five new modules.
- `dispatcher/test/worktrees-landing.test.ts` (13 tests: 2-phase
  allocating→allocated with `.opencode` isolation, phase-1 visibility +
  SQLite persistence across reopen, double-allocation rejection,
  retry-keeps-commits, orphan reap + `maxAgeMs` freshness, salvage ref
  anchoring + attached-branch refusal, `--no-ff` merge with 2 parents,
  verify-red rollback, precheck merges nothing, conflict files + no
  data loss — all on temp git repos, no network).
- `dispatcher/test/server-api.test.ts` (19 tests: board shape with tier
  + DAG edges, tier-failover wiring, loopback/CSRF/method guards,
  director decomposition + audit chain, drilldown view + 404,
  ticket single-use/TTL/binding via injectable clock, Ed25519 +
  passphrase round-trips, keypair + passphrase sign → ready, ticket
  replay → 403, wrong passphrase / cross-task binding → 403,
  non-waitingHuman → 409, reject → pending with chained ledger, SSE
  snapshot gap replay, live SSE delivery).
- `scripts/accept/wave-2.sh`, this report.

## Decisions

- Worktree/landing git operations are synchronous (`execFileSync`)
  for determinism; only the verification callbacks and the server
  `fetch` handler are async.
- `releaseWorktree` deletes the allocation row (no worktree is owned),
  so `markSalvage` upserts: the release-then-salvage flow still leaves
  a `salvage` row for the board.
- Approval-passphrase verification derives the verifying public key
  from the presented passphrase and checks the presented signature
  against it: a wrong passphrase derives a different key and fails
  closed, with no secret stored anywhere.
- `?snapshot=1` on `/api/events` returns the replay as one finite SSE
  payload so tests and inspector initial loads never hang on an open
  stream; live mode keeps replay + subscribe + keepalive + abort
  cleanup.
- `jj` backend is implemented (`jj workspace add` when `.jj` is
  present) but exercised via the git path in tests (`jj` is not
  installed in this environment).

## Test evidence

- `bun run --filter './dispatcher' check` (`tsc --noEmit`): zero errors, zero warnings.
- `bun test`: 66 pass, 0 fail, 185 assertions across all 4 files
  (34 Wave 1 + 32 Wave 2).
- `bash scripts/accept/wave-2.sh`: PASS — install, typecheck, tests,
  zero-stub grep clean, all deliverables present, behavior probe passed
  (2-phase + `.opencode` isolation + salvage ref + `--no-ff` landing +
  ticket single-use + bus gap + board tier/columns + director
  decomposition + ticket mint + Ed25519 sign → ready).

## Self-audit notes

- Zero stubs: no `TODO|FIXME|XXX|HACK`, no dummy passes, no swallowed
  errors (every `catch` either recovers with a fallback path or
  rethrows with context), no `set +e` / `|| true`; every exported
  function has exact logic.
- Scope: new files only under `dispatcher/`, `docs/reports/`,
  `scripts/accept/`; `web/` untouched; no SwarmOS, no AST parsers, no
  domain MCP tools.
- Fail-closed: unknown tickets/CSRF/hosts rejected with descriptive
  JSON errors; signing requires a live ticket, a valid signature, and
  `waitingHuman` status; landing rolls back to the recorded SHA and
  never deletes task branches; ticket tokens are excluded from audit
  data (bearer-secret hygiene).
