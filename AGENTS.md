# AGENTS.md — Coordinator Harness for `agency-control-plane`

**Repo:** `/home/john/Projects/Heretek-AI-Rebuild/agency-control-plane`
**Remote:** `https://github.com/Heretek-AI/agency-control-plane`
**Package:** `@heretek-ai/agency-control-plane`
**Coordinator:** `agency-coordinator` (`opencode-go/muse-spark-1.3-contributor`)
**Model harness:** `opencode-go/muse-spark-1.3-contributor` — six non-negotiable rules apply on every turn.

---

## 1. Zero-Summarization Rule (Binding)

1. The complete specification lives in `docs/prompts/SPEC.md`. It contains verbatim
   copies of `MASTER_BUILD_PROMPT.md` sections 0, 1, 2.1, 2.2, 2.3 plus the exact
   module contracts.
2. Every subagent dispatch MUST instruct the subagent to read `AGENTS.md` and
   `docs/prompts/SPEC.md` directly from disk with native `read` before doing any work.
3. Never paraphrase, compress, or re-dictate the spec inside a subagent prompt.
   Point at the files; include only the wave assignment, worktree path, and branch name.
4. Violation = drift-guard `VERDICT: FAIL`.

## 2. Explicit Triad Roles

| Role | Agent ID | Responsibility |
|------|----------|----------------|
| Programmer | `agency-programmer` | Implements production code + unit tests + accept scripts. No stubs, no TODOs. Fixes all diagnostics immediately. |
| QA | `agency-qa` | Runs `make check`, accept scripts, and Red-Proof Sabotage. Records `docs/evidence/wave-<N>/red-proofs.log`. |
| Drift Guard | `agency-drift-guard` | Audits scope, spec fidelity, zero-stub grep, and issues binding `VERDICT: PASS/FAIL` in `docs/reports/wave-<N>-verification.md`. |

Always pass `"agent": "agency-programmer"`, `"agent": "agency-qa"`, or
`"agent": "agency-drift-guard"` when calling `subagent`. No other agent IDs are valid.

## 3. Vanilla Hygiene

- Use native `read`, `write`, `edit`, `glob`, `grep` — never `cat` or `sed`.
- Never include `read` line numbers (e.g. `12: `) in `edit` `oldString`/`newString`.
- Fix every `<diagnostics>` block immediately before proceeding.
- Bun-first toolchain: `bun install`, `bun run check`, `bun test`.

## 4. Strict Scope (ONLY `dispatcher/` + `web/`)

This repository is ONLY:

1. The **Fleet Dispatcher Daemon** (`dispatcher/`), and
2. The **unified High-Fidelity WebUI** (`web/`) with the 5 locked-in UX pillars:
   1. **Kanban → worktrees**: 5-column board (`Backlog`, `Ready`, `In Progress`,
      `Waiting Approval / QA`, `Done`) mapped to isolated `jj` / Git worktrees,
      branch badges (`fleet/task-101`), owned-path chips, model-tier indicators.
   2. **Director Chat sidebar**: persistent dockable chat with the Top-Level
      Director Agent, `/ship <spec>`, mission charter preview, 1-click DAG injection.
   3. **DAG & Worker Drill-Down SSE inspector**: click any card → live SSE tool-call
      timeline, stage gates, token/cost telemetry, DAG dependency graph, Docker
      Compose profile badge (`core` / `appsec` / `android` / `game` / `research`).
   4. **Side-by-Side / Unified Diff viewer**: file-tree navigation,
      addition/deletion counters, syntax-highlighted hunks.
   5. **1-Click / passphrase Ed25519 Approval Drawer**: exact `subjectHash`, diff
      summary, QA verdicts (`qa-functional` + `qa-adversarial`), Ed25519 approval gate.
      **Invariant I1:** the passphrase is kept strictly in a local function closure
      during the `fetch("/api/approvals/:id/sign")` call, zeroed immediately after,
      and NEVER written to reactive stores (`fleet-store`), `localStorage`,
      `sessionStorage`, or DOM data attributes.

### Forbidden in this repo (Drift Guard MUST fail on sight)

- Do NOT copy `SwarmOS` (`src/omni`, `swarmos-plugin.ts`).
- Do NOT implement AST parsers or domain MCP tools here.
- Scope refusal check: any file outside `dispatcher/`, `web/`, `docs/`, `scripts/`,
  `.github/` (CI workflows only), repo-root configs (`package.json`, `tsconfig.json`,
  `Makefile`, `AGENTS.md`) is rejected.

## 5. Critical Bug Fixes Enforced (Reports `01b`, `04a`, `04b`)

### Fix 1 — `dispatcher/src/limits.ts` 429 Global Freeze Bug

- Never pause all missions for 60s in an infinite loop on HTTP 429 (`gousagelimiterror`).
- `extractRetryAfterMs(headers?, defaultMs?)`: parse `retry-after-ms` (ms) and
  `retry-after` (seconds or HTTP-Date), clamp strictly to `[1000, 300000]`.
- `classifyProviderFailure(failure, consecutiveFailures, currentTier)`:
  - Quota shape: `failure.status === 402`, or code matches `gousagelimiterror` /
    `freeusagelimiterror` / `insufficient_quota`, or 429 body matches
    `/usage limit|quota exceeded|insufficient quota|credit balance/i`:
    - `tier-1-opencode` → `{ action: "route-fallback", targetTier: "tier-2-commercial" }` (ZERO mission pause).
    - `tier-2-commercial` → `{ action: "route-fallback", targetTier: "tier-3-local" }`.
    - `tier-3-local` → `{ action: "pause-missions", reason, resumeAfterMs }`.
  - Transient 429 (no quota shape) → `{ action: "retry-delay", delayMs: extractRetryAfterMs(headers) }`.
- Tier chain: `tier-1-opencode` → `tier-2-commercial` → `tier-3-local` via Maxim Bifrost.

### Fix 2 — OpenCode v2 SQLite Single-Writer & SSE Overflow

- Dispatcher SQLite store: `PRAGMA busy_timeout = 15000; PRAGMA journal_mode = WAL;`
- Isolate each worker's `.opencode` state per worktree.
- Multiplex worker events over a ring-buffered SSE / NATS JetStream bus
  (bounded buffer, backpressure drop-oldest with sequence-gap marker, KV blackboard bridge).

## 6. Full Repository Layout

```text
agency-control-plane/
├── .github/
│   └── workflows/
│       └── ci.yml                  # make check + make accept on PRs and main
├── AGENTS.md
├── Makefile
├── package.json                    # Bun workspace root: ["dispatcher", "web"]
├── tsconfig.json
├── docs/
│   ├── prompts/
│   │   ├── SPEC.md
│   │   └── verify-stage.md
│   ├── reports/                    # wave-<N>.md + wave-<N>-verification.md
│   └── evidence/                   # wave-<N>/red-proofs.log
├── scripts/
│   └── accept/
│       ├── wave-1.sh
│       ├── wave-2.sh
│       └── wave-3.sh
├── dispatcher/                     # Waves 1 & 2
│   ├── package.json                # @heretek-ai/agency-dispatcher
│   ├── src/
│   │   ├── model.ts
│   │   ├── wildcard.ts
│   │   ├── scheduler.ts
│   │   ├── limits.ts
│   │   ├── audit.ts
│   │   ├── worktrees.ts
│   │   ├── landing.ts
│   │   ├── event-bus.ts
│   │   ├── approval-tickets.ts
│   │   ├── server.ts
│   │   └── index.ts
│   └── test/
│       ├── scheduler.test.ts
│       ├── limits.test.ts
│       ├── worktrees-landing.test.ts
│       └── server-api.test.ts
└── web/                            # Wave 3
    ├── package.json                # @heretek-ai/agency-web
    ├── index.html
    ├── src/
    │   ├── state/fleet-store.ts
    │   ├── security/approval-client.ts
    │   ├── components/
    │   │   ├── KanbanBoard.tsx
    │   │   ├── DirectorChat.tsx
    │   │   ├── WorkerDrillDown.tsx
    │   │   ├── SplitDiffViewer.tsx
    │   │   └── ApprovalDrawer.tsx
    │   └── app.tsx
    └── test/
        ├── approval-invariant.test.ts
        └── ui-components.test.ts
```

## 7. API Contract (`dispatcher/src/server.ts`, Bun HTTP + SSE, loopback `127.0.0.1`)

| Method & Path | Purpose |
|---------------|---------|
| `GET /api/board` | Kanban columns, tasks, worktree statuses, active model tier (`tier-1-opencode` / `tier-2-commercial` / `tier-3-local`), DAG edges. |
| `POST /api/director/message` | Append steering message to Director session; decompose new task cards onto the board. |
| `GET /api/tasks/:id/drilldown` | Worker session metadata, stage gates, live tool-log buffer, git diff hunks (`[{ file, status, additions, deletions, patch }]`). |
| `POST /api/approvals/:taskId/ticket` | Mint single-use 60s-TTL preview ticket bound to `{ taskId, subjectHash }`. |
| `POST /api/approvals/:taskId/sign` | Verify single-use ticket + Ed25519 signature/passphrase in memory; transition `waitingHuman` → `ready`/`done`; append to audit ledger. |
| `GET /api/events` | SSE stream (ring-buffered, replayable sequence IDs). |

## 8. Commands

- `make check` — `bun install && bun run check && bun test` (typecheck + lint + full tests).
- `make accept` — `bash scripts/accept/wave-1.sh && bash scripts/accept/wave-2.sh && bash scripts/accept/wave-3.sh`.
- `make accept-1` / `make accept-2` / `make accept-3` — per-wave acceptance.

## 9. Triad Protocol (Binding Gate, Max 3 Rework Cycles)

1. **Programmer** implements in a wave worktree (`worktrees/wave-<N>`, branch
   `wave-<N>-*`), writes code + tests + accept script + `docs/reports/wave-<N>.md`,
   runs `bun test` + `bun run check` green, commits in the worktree.
2. **QA** runs `make check`, the wave accept script, and Red-Proof Sabotage
   (break it → test fails → restore cleanly via `git checkout --`), recording
   `docs/evidence/wave-<N>/red-proofs.log`.
3. **Drift Guard** audits scope/spec/stubs and issues `VERDICT: PASS` (or FAIL with
   findings) in `docs/reports/wave-<N>-verification.md`.
4. Coordinator merges to `main` ONLY on `VERDICT: PASS` + green QA.
5. Max **3 rework cycles** per wave: Programmer → QA → Drift Guard counts as one.
   After 3 failed cycles the coordinator halts the wave and escalates with evidence.
6. Zero stubs, zero TODOs, zero dummy passes, fail-closed security. No merge without
   both QA red-proofs and Drift Guard `VERDICT: PASS`.
