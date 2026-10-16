# Wave 3 Verification — Drift Guard Adversarial Audit

- Stage: wave-3 (Unified High-Fidelity WebUI, 5 UX Pillars + Invariant I1)
- Branch: `wave-3-webui`
- Worktree: `/home/john/Projects/Heretek-AI-Rebuild/agency-control-plane-wave-3`
- Date (UTC): 2026-10-16
- Auditor: agency-drift-guard (Muse Spark 1.3 Contributor, read-only; no code edits, no subagents, no commits)
- Spec sources read: `AGENTS.md`, `docs/prompts/SPEC.md` (§§0,1,2.3,3.10–3.12), `docs/prompts/verify-stage.md`, `docs/reports/wave-3.md`, `docs/evidence/wave-3/red-proofs.log`, `web/src/state/fleet-store.ts`, `web/src/security/approval-client.ts`, `web/src/components/KanbanBoard.tsx`, `DirectorChat.tsx`, `WorkerDrillDown.tsx`, `SplitDiffViewer.tsx`, `ApprovalDrawer.tsx`, `theme.ts`, `web/src/app.tsx`, `web/index.html`, `web/test/approval-invariant.test.ts`, `web/test/ui-components.test.ts`, `scripts/accept/wave-3.sh`, `README.md`

## 1. Scope refusal check — PASS

- `git branch --show-current` → `wave-3-webui`.
- `git diff --name-only main...HEAD -- dispatcher/` → empty (dispatcher untouched by Wave 3). Confirmed.
- `git diff --name-only main...HEAD` → only `README.md`, `bun.lock`, `docs/reports/wave-3.md`, `scripts/accept/wave-3.sh`, `web/index.html`, `web/package.json`, `web/src/app.tsx`, `web/src/components/*.tsx|ts`, `web/src/security/approval-client.ts`, `web/src/state/fleet-store.ts`, `web/test/*.ts`. All under allowed `web/`, `docs/`, `scripts/`, root configs. No file outside `dispatcher/`, `web/`, `docs/`, `scripts/`, root configs. PASS.
- `ls src/omni` → nonexistent; no `swarmos-plugin.ts` anywhere (`find` clean). The single `src/omni` string hit in `dispatcher/test/scheduler.test.ts:106-107` is a pre-existing Wave 1 glob-overlap fixture (`paths: ["src/omni/*"]`), not copied SwarmOS code. No SwarmOS code present. PASS.
- `grep -rln -i 'ast.*pars|MCP.*tool' web/src` → no matches. No AST parsers or domain MCP tools. PASS.

## 2. Five pillars present with required features — PASS

- Pillar 1 Kanban (`web/src/components/KanbanBoard.tsx`, store `web/src/state/fleet-store.ts:18-32`): all 5 columns `Backlog | Ready | In Progress | Waiting Approval / QA | Done` via `BOARD_COLUMNS`; per-card branch badge (`card.branch`, e.g. `fleet/task-101`), owned-path chips (`card.ownedPaths.map`), tier badges (`tierBadge(card.tier)`, `tier-1/2/3` short names), active-tier header badge, card counts, real `<button>` cards with `aria-pressed` + `onSelectTask` click-to-drilldown. PASS.
- Pillar 2 Director (`web/src/components/DirectorChat.tsx`): persistent dockable sidebar (`dock: left|right`, `data-dock`, `data-testid="director-chat"`), `SHIP_COMMAND="/ship"` + `parseShipCommand` (`DirectorChat.tsx:32-39`), charter preview (`data-testid="charter-preview"` + `decomposeCharter` bullet grammar, `DirectorChat.tsx:42-53`), 1-click DAG injection (`data-testid="inject-dag"` → `onInjectDag`), compose box + message list. `app.tsx:243-300` wires `/ship` → `injectDag` → `POST /api/director/message`. PASS.
- Pillar 3 DrillDown (`web/src/components/WorkerDrillDown.tsx`, `web/src/app.tsx:116-203`): click-any-card path (`selectTask` → `GET /api/tasks/:id/drilldown` → `setDrilldown`); live SSE tool-call timeline (`data-testid="tool-timeline"`, `EventSource("/api/events")` → `applySsePayload` handles `worker.tool`/`tool`), stage gates (`data-testid="stage-gates"`), token/cost telemetry (`drilldown-tokens`, `drilldown-cost`), tier badge + Docker profile badge (`profile:core|appsec|android|game|research`, `WorkerDrillDown.tsx:54-56`), DAG subgraph (`data-testid="dag-graph"` filtered on `taskId`). PASS.
- Pillar 4 Diff (`web/src/components/SplitDiffViewer.tsx`): side-by-side/unified toggle (`DiffViewMode`, `diff-mode-side-by-side`/`diff-mode-unified`, `diff-view-*`, dual panes `diff-pane-removed`/`diff-pane-added`), file-tree navigator (`data-testid="diff-file-tree"`), per-file + aggregate `+`/`-` counters (`diffTotals`, `SplitDiffViewer.tsx:50-58`), classified hunk lines (`parsePatchLines`: added/removed green/red, header blue, `SplitDiffViewer.tsx:31-47`). PASS.
- Pillar 5 Approval (`web/src/components/ApprovalDrawer.tsx`): exact `subjectHash` (`data-testid="approval-subject-hash"`), diff summary (`approval-diff-summary`: files/additions/deletions), QA verdicts list (`approval-qa-verdicts`, `qa-functional` + `qa-adversarial` via `QaVerdict` type + `gatesToVerdicts` in `app.tsx:82-92`), 1-click/passphrase Ed25519 gate (`approveWithPassphrase` vs `approveOneClick` with explicit `OneClickAuthority`, approve→`approve:true`/reject→`false`, uncontrolled `type="password"` input, ticket-required fail-closed). PASS.

## 3. Invariant I1 BINDING — PASS (independently verified)

- Closure-only: `approveWithSecret` (`web/src/security/approval-client.ts:132-173`) holds secret only in `let secret: string | null = secretValue` (line 146), derives keypair + signs inside `try`, zeroes in `finally` (lines 164-172: `secret = ""`, `secret = null`, `privateKeyPem = null`, `requestBody = null`, `liveSecrets -= 1`). `approveWithPassphrase` (lines 179-187) is a thin alias; `approveOneClick` (lines 193-220) carries no secret. Module imports only `node:crypto` — no store import (accept-script probe + auditor grep both clean). PASS.
- Never in fleet-store: `grep -rni 'passphrase' web/src/state` → clean; store shape (`fleet-store.ts:110-117`) has no secret/privateKey/ticket field; static test `approval-invariant.test.ts:46-52` asserts absence of `passphrase|secret|privateKey` in stripped store source. PASS.
- Never in storage: `grep -rn -E '(localStorage|sessionStorage)[[:space:]]*[.\[]' web/src` → clean (client, all 6 components incl. `theme.ts`, `app.tsx`). PASS.
- Never in DOM: `grep -rn -E 'data-(passphrase|secret)' web/src` → clean. Drawer secret touchpoint is handler-local `const secret` (`ApprovalDrawer.tsx:78`) from uncontrolled ref, never React state, input cleared in `finally` (lines 104-109). The single `passphrase` hit outside the client (`ApprovalDrawer.tsx:2` doc comment) is prose, not storage — accept script's precise sinks (state names, storage access, `data-*`, store import, `finally`+null zeroing) all pass. PASS.
- Wire: runtime test (`approval-invariant.test.ts:94-109`) proves body carries only `signature` + `publicKey`, URL is exactly `/api/approvals/task-101/sign`, `activeApprovalSecrets()===0` after; accept behavior probe re-proves `seen.includes(secret)===false` + closure zeroed + `assertNoPassphraseLeak` clean. Auditor `bun test` run confirms 9/9 invariant tests green. PASS.

## 4. WCAG 2.2 AA contrast + 24×24px targets (static) — PASS

- Dark-mode palette (`theme.ts:11-39`): body text `#e8edf5` on `#0b0f17`, panels `#111827`, muted `#a8b4c8`, pass/fail/warn/info pairs on tinted backgrounds — high-contrast pairs documented ≥4.5:1; `index.html` sets `color-scheme: dark` + matching base colors. PASS.
- Targets: `MIN_TARGET = { minHeight: 24, minWidth: 24 }` (`theme.ts:41`) spread into `buttonStyle` and `ghostButtonStyle` (used by every Kanban card, director send/inject, drilldown close, diff mode/file buttons, approval approve/reject, ticket mint, refresh). Inputs use `minHeight: 24` (`DirectorChat.tsx:140`, `ApprovalDrawer.tsx:177`). PASS.
- Focus/keyboard: global `*:focus-visible { outline: 2px solid #8ab8ff; outline-offset: 2px }` (`app.tsx:329`) + `focusRingStyle` (`theme.ts:99-102`); Kanban cards are native `<button>`s, board/chat/drawer use semantic `section/aside/form/label` + `aria-pressed`/`aria-label`/`role` markers. PASS.

## 5. Zero stubs + security — PASS

- Mandated grep (`TODO|FIXME|XXX|HACK|echo "passed"|\|\| true|return true;|catch \(...\) {}`) over `dispatcher web scripts` → empty; `return true;` in `web/src` → none; `set +e` in `wave-3.sh` → none; `bun run check` (dispatcher+web) exit 0, zero warnings. PASS.
- Note: `app.tsx:119-137,192-199,238-240,257,274,316` uses bare `catch { return; }` (no parens, so outside the mandated pattern). Each site is display-only SSE/event/fetch handling where ignoring a malformed payload is specified behavior, covered by the `unknown.noise` test (`ui-components.test.ts:334-335`). No TODO/dummy-pass character; documented in `wave-3.md` self-audit. Not a stub — PASS with note.
- Ticket/secret hygiene: `grep -rn 'console.log.*ticket|secret|passphrase' web/src` → clean; ticket treated as opaque fail-closed input (`ticket.length===0` rejects before network in both client and drawer); `assertNoSecretLeak` scans store/DOM/storages + live-secret count. PASS.

## 6. Evidence: 3 sabotages FAIL→PASS, 93 pass, all 3 accepts exit 0 — PASS

- Baseline in `docs/evidence/wave-3/red-proofs.log`: `bun install` 0, `bun run check` 0, `bun test` 93 pass/0 fail/327 expects/6 files, `wave-3.sh` exit 0, wave-1 + wave-2 regression exit 0, zero-stub grep clean, `git diff dispatcher/` empty, I1 static gates clean, 9/9 + 18/18 web tests. Auditor independently re-ran: `bun run check` exit 0, `bun test` 93/0/327, `wave-3.sh`/`wave-1.sh`/`wave-2.sh` each `[wave-N] PASS` exit 0. PASS.
- Red-Proof A (I1 leak `localStorage.setItem("approval-passphrase", secret)` in `approval-client.ts`): `approval-invariant.test.ts` → exit 1, 6 pass/3 fail/37 expects (static `touchesStorage` + runtime `localStorage is not defined` at planted line) → `git checkout --` → clean → 9 pass/0 fail/51 expects. Non-vacuous, fail-closed, restored. PASS.
- Red-Proof B (Kanban `BOARD_COLUMNS.filter(... !== "Done")`): `ui-components.test.ts` → exit 1, 17 pass/1 fail/81 expects (`Done` marker missing) → restore → 18/0/91. PASS.
- Red-Proof C (SSE `worker.tool` topic dropped to `tool`-only in `applySsePayload`): `ui-components.test.ts` → exit 1, 17 pass/1 fail/89 expects (tool stream growth assertion) → restore → 18/0/91. PASS.
- Restore discipline: each entry records sabotage line, failing output, `git checkout -- <file>` revert, `git status --short -- web/` clean, post suite green; final `bun test` 93/0 + `wave-3.sh` PASS. Only new file is the log itself (auditor sees `?? docs/evidence/wave-3/` untracked, `web/` clean). PASS.

## 7. Spec & architecture audit — PASS

- All Wave 3 deliverables per `verify-stage.md` §7 present (16 files incl. `theme.ts` extra, `web/tsconfig.json`, `README.md`): `fleet-store.ts`, `approval-client.ts`, 5 components + `app.tsx`, both tests, `wave-3.sh`, `wave-3.md` — confirmed on disk and by accept-script loop. Contracts §§3.10–3.12 satisfied: store columns/DAG/drilldown/diff/tier with fail-closed validation, no secrets by type+test; client closure discipline + `FetchLike` seam; dark-mode AA shell. Seams match dispatcher API (`/api/board`, `/api/director/message`, `/api/tasks/:id/drilldown`, `/api/approvals/:taskId/ticket|sign`, `/api/events`), no CLI-flag/schema drift (no new flags; `subjectHash`/`ticket`/`signature`/`publicKey` shapes mirror server). PASS.

## Findings

- None. No FAIL items, no line-numbered defects to address.

VERDICT: PASS
