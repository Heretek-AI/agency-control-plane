# Wave 3 Report — Unified High-Fidelity WebUI (5 UX Pillars + Invariant I1)

- Stage ID: wave-3
- Branch: `wave-3-webui`
- Worktree: `/home/john/Projects/Heretek-AI-Rebuild/agency-control-plane-wave-3`

## Summary of deliverables

Implemented the Wave 3 WebUI per `docs/prompts/SPEC.md` §§2.3, 3.10–3.12,
wiring the Wave 2 loopback control API into a dark-mode, WCAG 2.2 AA
fleet console (contrast ≥ 4.5:1 body text, ≥ 24×24px targets, visible
focus rings, keyboard-navigable board/chat/drawer):

- `web/src/state/fleet-store.ts` — framework-agnostic vanilla TS store
  (zero React imports): five `BoardColumn`s, `TaskCard`s with branch
  badge (`fleet/task-101`) + owned-path chips + tier badge, DAG
  nodes/edges, active `DrilldownWorker` (`sessionId`, stage gates, SSE
  tool stream, tokens/cost, Docker profile), per-task `DiffHunk` cache,
  and `activeTier`. Actions `upsertTask`, `moveCard`, `setDag`,
  `setDrilldown`, `appendToolEvent` (monotonic `seq`), `setDiff`,
  `setTier`, `reset`; `subscribe`/`getState` with defensive snapshot
  copies. Every mutation is validated fail-closed (empty ids, unknown
  columns/tiers/profiles, dangling DAG edges, event-without-drilldown).
  No secret field exists anywhere in the state shape (Invariant I1 by
  construction).
- `web/src/security/approval-client.ts` — binding Invariant I1: the
  human secret lives only in the `secret` closure local of
  `approveWithSecret` (aliased as `approveWithPassphrase(taskId,
  ticket, passphrase, subjectHash)`) while it derives the Ed25519
  keypair (`SHA-256("agency-approval-v1:" + secret)` PKCS8 import,
  matching the dispatcher derivation) and signs the subject hash; only
  the derived `signature` + `publicKey` travel in the
  `fetch("/api/approvals/:id/sign")` body. `finally` overwrites (`""`)
  and nulls the closure plus derived key material; `liveSecrets`
  counter proves zero live secrets at rest via
  `activeApprovalSecrets()`. `approveOneClick(taskId, ticket,
  subjectHash, authority)` carries no secret at all. Pure
  `assertNoPassphraseLeak` (`assertNoSecretLeak` core) scans the store
  snapshot, DOM HTML, and both storage dumps for the secret value and
  fails closed on any hit or on a non-zero live-secret count. The module
  imports no store, touches no browser storage, and renders no DOM; its
  fetch surface is the minimal `FetchLike` type so tests inject
  dependency-free fakes.
- `web/src/components/KanbanBoard.tsx` (Pillar 1) — 5 columns with card
  counts, per-card branch/tier badges, owned-path chips, active-tier
  header badge, real `<button>` cards with `aria-pressed` selection and
  click-to-drilldown (`onSelectTask`).
- `web/src/components/DirectorChat.tsx` (Pillar 2) — persistent dockable
  (`left`/`right`) Director sidebar: append-only message list, compose
  box, `/ship <spec>` parsing (`parseShipCommand`), charter preview
  with decomposed task list (`decomposeCharter`, same bullet grammar as
  the dispatcher), and 1-click DAG injection (`onInjectDag`).
- `web/src/components/WorkerDrillDown.tsx` (Pillar 3) — worker session
  header with tier + `profile:<core|appsec|android|game|research>`
  badges, token/cost telemetry, stage-gate chips, live SSE tool-call
  timeline, and the task's DAG dependency subgraph; empty state prompts
  card selection.
- `web/src/components/SplitDiffViewer.tsx` (Pillar 4) —
  side-by-side/unified toggle (`DiffViewMode`), file-tree navigator with
  per-file `+`/`-` counters and status labels, aggregate counters,
  classified hunk lines (`parsePatchLines`: added/removed green/red,
  hunk headers blue), and `diffTotals` aggregation.
- `web/src/components/ApprovalDrawer.tsx` (Pillar 5) — exact
  `subjectHash`, diff summary, `qa-functional` + `qa-adversarial`
  verdict list, and the Ed25519 gate: passphrase path reads an
  UNCONTROLLED password input into a handler-local const (never React
  state), calls `approveWithPassphrase`, then clears the input;
  1-click path uses the explicit `oneClickAuthority`. Approve maps to
  `approve: true`, Reject to `approve: false`; busy/notice states carry
  no secret.
- `web/src/app.tsx` — root layout composing all five pillars: seeds the
  store from `GET /api/board` (`seedStoreFromBoard`), streams
  `/api/events` through `EventSource` into the store
  (`applySsePayload`: `worker.tool` appends, `tier.fallback` switches
  tiers, unknown topics ignored), loads
  `GET /api/tasks/:id/drilldown` on card select, mints preview tickets,
  posts director messages (`/ship` shortcut included), and derives QA
  verdicts from stage gates (`gatesToVerdicts`). Pure helpers exported
  for tests: `statusToColumn` (mirrors server `columnFor`),
  `boardTaskToCard`, `gatesToVerdicts`, `seedStoreFromBoard`,
  `applySsePayload`.
- `web/src/components/theme.ts` — shared dark-mode palette and control
  styles (≥ 24px targets, focus-ring contract).
- `web/index.html` — entry (`#root` + module bootstrap of `app.tsx`).
- `web/test/approval-invariant.test.ts` (9 tests) — I1 proven
  statically (comment-stripped source probe: no secret identifiers in
  the store, no storage *access* or `data-*` secret attributes in any
  component/app, closure zeroing present in the client) and at runtime
  (mocked fetch: wire body carries signature + public key only, URL is
  the exact sign route, closure count returns to 0; empty secret
  rejected with zero network calls; clean-snapshot probe passes;
  planted leaks in each sink fail the probe, proving sensitivity).
- `web/test/ui-components.test.ts` (18 tests) — `react-dom/server`
  static-markup assertions for all five pillars (columns, badges, chips,
  dock, charter preview, timeline, gates, telemetry, profile, DAG,
  file tree, counters, both diff modes, subject hash, verdicts,
  password gate) plus store transitions (move/set/append/diff/tier,
  fail-closed rejections, subscriber notify/unsubscribe) and app-helper
  unit tests.
- `web/package.json` (`@heretek-ai/agency-web`, react + react-dom,
  `check` = `tsc --noEmit`, `test` = `bun test`) and
  `web/tsconfig.json` (extends root: strict, `jsx: react-jsx`).
- `scripts/accept/wave-3.sh`, `README.md` (fleet + WebUI overview,
  quickstart, API table, I1), this report.

## Decisions

- The store is framework-agnostic (no React import) so `bun test`
  exercises it and every helper with zero DOM; components stay thin
  renderers over store snapshots, with SSE subscription owned by
  `app.tsx`.
- Rendering tests use `react-dom/server` static markup with
  `createElement` (never direct component calls, which break hooks) —
  pure-logic + string-render assertions, no network, no happy-dom.
- The static I1 probe strips comments before matching: the invariant
  vocabulary necessarily appears in doc prose, so the probe matches
  real *access* patterns (`localStorage.` / `[`, `data-passphrase`)
  rather than bare words, avoiding documentation false-positives while
  staying sensitive to genuine leaks (proven by the planted-leak tests).
- `approveOneClick` takes the explicit `(taskId, ticket, subjectHash,
  authority)` quad: a bare `(taskId, ticket)` pair cannot sign without
  the subject binding and the authority, so the richer signature is the
  fail-closed form; the passphrase path keeps the exact
  `approveWithPassphrase(taskId, ticket, passphrase, subjectHash)` shape.
- The drawer never stores the secret in React state: an uncontrolled
  password input is read once into a handler-local const and cleared in
  `finally`, satisfying I1's "local closure only" wording for the only
  component that must handle the secret.

## Test evidence

- `bun run check` (`tsc --noEmit` dispatcher + web): zero errors, zero warnings.
- `bun test`: 93 pass, 0 fail, 327 assertions across 6 files
  (66 prior Wave 1 + 2 + 27 new Wave 3).
- `bash scripts/accept/wave-3.sh`: PASS — install, typecheck, tests,
  zero-stub grep clean, all 16 deliverables present, I1 static probe
  passed (no secret in store, no storage access, no `data-*` secrets,
  no store reach from the client, `finally` + null zeroing present),
  behavior probe passed (board seed → move → drill-down → SSE tool
  event → diff → tier fallback, all 5 pillar markers rendered,
  passphrase absent from the wire, closure zeroed, leak probe clean).

## Self-audit notes

- Zero stubs: no `TODO|FIXME|XXX|HACK`, no dummy passes, no swallowed
  errors (every `catch` returns a typed fallback or a descriptive
  rejection; no `set +e` / `|| true`); the one `catch { return; }`
  family sits in display-only SSE/event paths where ignoring a malformed
  payload is the specified behavior, and every such site is covered by
  the unknown-topic test.
- Scope: new files only under `web/`, `scripts/accept/`,
  `docs/reports/`, plus root `README.md`; `dispatcher/` untouched; no
  SwarmOS, no AST parsers, no domain MCP tools.
- Fail-closed: invalid store transitions throw with descriptive errors;
  empty secrets, missing tickets, and malformed sign responses reject
  before any state change; ticket reuse/expiry/binding remain
  server-enforced (Wave 2) with the client adding the wire-shape check.
- I1 holds end-to-end: `grep -rn -E
  '(localStorage|sessionStorage)[[:space:]]*[.\[]' web/src` prints
  nothing, `grep -rni 'passphrase' web/src/state` prints nothing, and
  the runtime probe confirms the secret never reaches the store, the
  DOM, either storage, or the request body.
