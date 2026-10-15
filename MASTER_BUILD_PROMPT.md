# MASTER COORDINATOR BUILD PROMPT: REPO 4 — `agency-control-plane`
**Target Repository:** `/home/john/Projects/Heretek-AI-Rebuild/agency-control-plane`  
**GitHub Remote:** `https://github.com/Heretek-AI/agency-control-plane`  
**Package Name:** `@heretek-ai/agency-control-plane`  
**Primary Session Agent:** `agency-coordinator` (`opencode-go/muse-spark-1.3-contributor`)  
**Required Triad Subagents:** `agency-programmer`, `agency-qa`, `agency-drift-guard`

---

## 0. CRITICAL MUSE 1.3 HARNESS SUPPLEMENT (READ FIRST — NON-NEGOTIABLE)

You are running on `opencode-go/muse-spark-1.3-contributor`. Obey these six rules on every turn:

1. **ZERO PROMPT SUMMARIZATION WHEN CALLING SUBAGENTS:**
   - In Wave 0, write this entire specification into `docs/prompts/SPEC.md` and `AGENTS.md`. Every subagent call MUST instruct the subagent to `read` `AGENTS.md` and `docs/prompts/SPEC.md` directly from disk.
2. **EXPLICIT SUBAGENT ROLES:**
   - Always pass `"agent": "agency-programmer"`, `"agent": "agency-qa"`, or `"agent": "agency-drift-guard"` when calling `subagent`.
3. **VANILLA `read` / `edit` / `write` HYGIENE:**
   - Use native `read`, `write`, `edit`, `glob`, and `grep`—never `cat` or `sed`. Never include `read` line numbers (`12: `) in `edit` `oldString`/`newString`. Fix `<diagnostics>` immediately.
4. **STRICT SCOPE & REFUSAL BOUNDARY FOR `agency-control-plane`:**
   - This repository is **ONLY** the Fleet Dispatcher Daemon (`dispatcher/`) and the unified High-Fidelity WebUI (`web/`) featuring your 5 locked-in UX pillars:
     1. **Visual Kanban Board** mapped to isolated Jujutsu (`jj`) / Git worktrees,
     2. **Persistent Top-Level Director Chat Sidebar** to plan and steer missions,
     3. **Interactive DAG & Worker Drill-Down Inspector** (live SSE tool stream, stage gates, token/cost telemetry),
     4. **Side-by-Side / Unified Git Diff Viewer** with file tree navigation, and
     5. **1-Click / Passphrase Cryptographic Ed25519 Human Approval Drawer** (enforcing Invariant I1: passphrase kept strictly in local closure, never in reactive state stores).
   - **FORBIDDEN IN THIS REPO:** Do NOT copy `SwarmOS` (`src/omni`, `swarmos-plugin.ts`) into this repo! Do NOT implement AST parsers or domain MCP tools here.
5. **CRITICAL BUG FIXES ENFORCED IN THIS REPO (FROM REPORTS `01b`, `04a`, `04b`):**
   - **Fix 1 (`limits.ts` 429 Global Freeze Bug):** Never pause all missions for 60s in an infinite loop on HTTP 429 (`gousagelimiterror`). Parse `retry-after-ms` / `Retry-After` (clamped `1000ms..300000ms`) and immediately return `{ action: "route-fallback", targetTier: "tier-2-commercial" | "tier-3-local" }` via Maxim Bifrost!
   - **Fix 2 (OpenCode v2 SQLite Single-Writer & SSE Overflow):** Set `PRAGMA busy_timeout = 15000; PRAGMA journal_mode = WAL;` on the dispatcher SQLite store, isolate each worker's `.opencode` state per worktree, and multiplex worker events over a ring-buffered SSE / NATS JetStream bus.
6. **BINDING TRIAD GATE:**
   - Every wave requires `agency-qa` Red-Proof Sabotage (`docs/evidence/wave-<N>/red-proofs.log`) and `agency-drift-guard` `VERDICT: PASS` (`docs/reports/wave-<N>-verification.md`) before merging to `main`.

---

## 1. TARGET REPOSITORY ARCHITECTURE & FILE TREE

```text
/home/john/Projects/Heretek-AI-Rebuild/agency-control-plane/
├── AGENTS.md
├── Makefile
├── package.json                    # Bun workspace root: ["dispatcher", "web"]
├── tsconfig.json
├── docs/
│   ├── prompts/
│   │   ├── SPEC.md
│   │   └── verify-stage.md
│   ├── reports/
│   └── evidence/
├── scripts/
│   └── accept/
│       ├── wave-1.sh
│       ├── wave-2.sh
│       └── wave-3.sh
├── dispatcher/                     # Wave 1 & 2: Fleet Dispatcher Daemon & HTTP/SSE Control API
│   ├── package.json                # @heretek-ai/agency-dispatcher
│   ├── src/
│   │   ├── model.ts                # TaskStatuses, Task, Mission, ApprovalTicket schemas
│   │   ├── wildcard.ts             # Glob path intersection (`mayOverlap(pathA, pathB)`)
│   │   ├── scheduler.ts            # Pure 186-line DAG scheduler (`all_success`, `one_success`, `pathsOverlap` lock, cascade cancel)
│   │   ├── limits.ts               # Upgraded 3-tier failover & Retry-After classifier (Report 01b §9.1)
│   │   ├── audit.ts                # O_APPEND + fsync SHA-256 hash-chained audit ledger with torn-tail check
│   │   ├── worktrees.ts            # 2-phase crash-safe worktree coordinator supporting Jujutsu (`jj workspace add`) + git worktree fallback + `refs/fleet-salvage/<id>`
│   │   ├── landing.ts              # Transactional landing in throwaway worktree (pre-verify -> merge -> post-verify -> rollback on conflict/failure)
│   │   ├── event-bus.ts            # Ring-buffered SSE + NATS JetStream / KV Blackboard bridge
│   │   ├── approval-tickets.ts     # Single-use preview tickets bound to subjectHash + loopback Ed25519 verification
│   │   ├── server.ts               # Bun HTTP + SSE API serving Kanban state, Director chat, Worker drill-down, Diffs, and Approvals
│   │   └── index.ts
│   └── test/
│       ├── scheduler.test.ts       # Tests all_success, one_success, cascade cancel, and pathsOverlap serialization
│       ├── limits.test.ts          # Proves 429 gousagelimiterror triggers route-fallback instead of global freeze!
│       ├── worktrees-landing.test.ts # Tests 2-phase allocation, salvage ref anchoring, and transactional landing rollback
│       └── server-api.test.ts      # Tests REST + SSE endpoints, approval tickets, and CSRF/loopback guards
└── web/                            # Wave 3: Unified High-Fidelity WebUI (5 UX Pillars)
    ├── package.json                # @heretek-ai/agency-web
    ├── index.html
    ├── src/
    │   ├── state/
    │   │   └── fleet-store.ts      # Typed state store for Kanban columns, DAG nodes, active drill-down worker, and diffs
    │   ├── security/
    │   │   └── approval-client.ts  # Ported from iumbtems approvals.ts (Invariant I1: passphrase held only in closure, never stored in state)
    │   ├── components/
    │   │   ├── KanbanBoard.tsx     # Pillar 1: 5-column Worktree Kanban (Backlog, Ready, In Progress, Waiting Approval/QA, Done)
    │   │   ├── DirectorChat.tsx    # Pillar 2: Persistent Top-Level Director Chat sidebar with mission decomposition cards
    │   │   ├── WorkerDrillDown.tsx # Pillar 3: Live worker subagent inspector (SSE tool stream, stage gates, token/tier badge, DAG view)
    │   │   ├── SplitDiffViewer.tsx # Pillar 4: Side-by-side & unified Git diff viewer with file tree & line stats
    │   │   └── ApprovalDrawer.tsx  # Pillar 5: 1-click / passphrase Ed25519 approval & rejection gate
    │   └── app.tsx                 # High-craft dark-mode layout satisfying WCAG 2.2 AA contrast & 24x24px target sizes
    └── test/
        ├── approval-invariant.test.ts # Asserts passphrase never enters fleet-store or DOM attributes (Invariant I1)
        └── ui-components.test.ts   # Tests rendering and state transitions across all 5 UX pillars
```

---

## 2. EXACT MODULE SPECIFICATIONS (WRITE TO `docs/prompts/SPEC.md` IN WAVE 0)

### 2.1 Wave 1 Specification: Pure Scheduler, Path-Overlap Arbiter, 3-Tier Failover Limits & Audit Chain
1. **`dispatcher/src/wildcard.ts` & `dispatcher/src/scheduler.ts`:**
   - Implement the exact salvaged `mayOverlap(patternA: string, patternB: string): boolean` and `schedule(tasks: Task[], runningIds: Iterable<string>, caps: ScheduleCaps): ScheduleResult` from `/home/john/Projects/The-Agency/dispatcher/src/scheduler.ts`:
     - Under `all_success`, a task is ready when all `deps` are `done`; if any dep is `failed` or `cancelled`, it cascades to `cancelled` via fixpoint closure.
     - Under `one_success`, a task is ready when at least one dep is `done`; it cancels only when all deps are terminal with zero `done`.
     - Two `expert-run` tasks whose `input.paths` overlap (`mayOverlap(pa, pb) === true`) NEVER start simultaneously (`blockedByOverlap` / `collidesSelected`).
     - `waitingHuman` tasks never start and never force downstream cancellation.
2. **`dispatcher/src/limits.ts` (Exact Patch from Report `01b` §9.1):**
   - `extractRetryAfterMs(headers?: Record<string, string>, defaultMs?: number): number` — Parses `retry-after-ms` (ms) and `retry-after` (seconds or HTTP-Date), clamped strictly to `[1000, 300000]`.
   - `classifyProviderFailure(failure: ProviderFailure, consecutiveFailures: number, currentTier: "tier-1-opencode" | "tier-2-commercial" | "tier-3-local"): ProviderDisposition`:
     - When `failure.status === 402` or code matches `gousagelimiterror` / `freeusagelimiterror` / `insufficient_quota` or 429 body matches `/usage limit|quota exceeded|insufficient quota|credit balance/i`:
       - From `tier-1-opencode` $\rightarrow$ returns `{ action: "route-fallback", targetTier: "tier-2-commercial" }` (ZERO mission pause!).
       - From `tier-2-commercial` $\rightarrow$ returns `{ action: "route-fallback", targetTier: "tier-3-local" }`.
       - From `tier-3-local` $\rightarrow$ returns `{ action: "pause-missions", reason: "...", resumeAfterMs }`.
     - When `failure.status === 429` (transient rate spike without quota exhaustion) $\rightarrow$ returns `{ action: "retry-delay", delayMs: extractRetryAfterMs(failure.headers) }`.
3. **`dispatcher/src/audit.ts`:**
   - Hash-chained JSONL audit log (`seq`, `timestamp`, `event`, `data`, `prevHash`, `hash`). Redacts secrets (`sk-*`, `Bearer *`, `OPENCODE_API_KEY`) before hashing. Detects any byte modification or equal-length rewrite via `checkAnchor`.

---

### 2.2 Wave 2 Specification: Crash-Safe Worktrees (`jj` / `git`), Transactional Landing & HTTP/SSE Control Server
1. **`dispatcher/src/worktrees.ts` & `dispatcher/src/landing.ts`:**
   - Two-phase crash-safe worktree allocation (`allocating` recorded in SQLite before worktree creation, flipped to `allocated` after; `cleanupUnconfirmed` cleans orphans).
   - Supports Jujutsu colocated workspaces (`jj workspace add`) when `.jj` is present, with seamless fallback to `git worktree add -b fleet/<taskId>`.
   - `salvageWorktree` anchors `refs/fleet-salvage/<taskId>` before deleting abandoned task branches so agent work is never lost.
   - `landTask` runs pre-checks in the task worktree, performs `--no-ff` merge onto `fleet/integration/<missionId>` inside a throwaway landing worktree, runs post-merge verification, and atomically rolls back to pre-merge SHA if verification or merge fails.
2. **`dispatcher/src/server.ts` & `dispatcher/src/approval-tickets.ts`:**
   - Serves HTTP API + `/api/events` SSE stream on loopback (`127.0.0.1`):
     - `GET /api/board` — Returns Kanban columns, tasks, worktree statuses, active model tier (`tier-1-opencode` / `tier-2-commercial` / `tier-3-local`), and DAG edges.
     - `POST /api/director/message` — Appends steering message to Top-Level Director session and decomposes new task cards onto the board.
     - `GET /api/tasks/:id/drilldown` — Returns worker session metadata, stage gates, live tool log buffer, and git diff hunks (`[{ file, status, additions, deletions, patch }]`).
     - `POST /api/approvals/:taskId/ticket` — Mints a single-use, 60-second TTL preview ticket bound to `{ taskId, subjectHash }`.
     - `POST /api/approvals/:taskId/sign` — Verifies the single-use ticket, verifies the Ed25519 signature / passphrase in memory, transitions task from `waitingHuman` to `ready`/`done`, and appends to `audit.ts`.

---

### 2.3 Wave 3 Specification: Unified High-Fidelity WebUI (`web/src/*`)
1. **`web/src/security/approval-client.ts` (Salvaged from `iumbtems/packages/web/src/approvals.ts`):**
   - **Strict Security Invariant I1:** The human passphrase entered in the approval dialog is held ONLY in a lexical function closure variable during the `fetch("/api/approvals/:id/sign")` call, is zeroed out immediately after, and is **never** written to `fleet-store`, `localStorage`, `sessionStorage`, or DOM data attributes.
2. **Five High-Fidelity UX Components (`web/src/components/*`):**
   - `KanbanBoard.tsx`: Renders the 5 Kanban columns (`Backlog`, `Ready`, `In Progress`, `Waiting Approval / QA`, `Done`) with worktree branch badges (`fleet/task-101`), owned-path chips, and model-tier indicators.
   - `DirectorChat.tsx`: Persistent right/left dockable chat with the Top-Level Director Agent (`director`), supporting `/ship <spec>`, mission charter preview, and 1-click task DAG injection onto the Kanban board.
   - `WorkerDrillDown.tsx`: Clicking any Kanban card opens the drill-down inspector showing the worker's live SSE tool-call timeline, active Docker Compose profile badge (`core` / `appsec` / `android` / `game` / `research`), and DAG dependency graph.
   - `SplitDiffViewer.tsx`: Renders side-by-side and unified Git diffs for the selected worktree with file-tree navigation, addition/deletion counters, and syntax-highlighted hunk lines.
   - `ApprovalDrawer.tsx`: Displays the exact `subjectHash`, diff summary, QA verdicts (`qa-functional` + `qa-adversarial`), and the 1-click / passphrase Ed25519 approval gate.

---

## 3. WAVE-BY-WAVE TRIAD EXECUTION PLAN FOR `agency-coordinator`

### Step 0 (Coordinator Bootstrap on `main`)
1. Write `AGENTS.md`, `docs/prompts/SPEC.md`, `docs/prompts/verify-stage.md`, `Makefile`, root `package.json`, and `tsconfig.json`.
2. Commit baseline scaffolding to `main`.

### Wave 1: Pure Scheduler, Path-Overlap Arbiter, 3-Tier Failover Limits & Audit Chain (`dispatcher/src/{model,wildcard,scheduler,limits,audit}.ts`)
1. Create worktree: `git worktree add -b wave-1-scheduler-limits worktrees/wave-1 main`
2. Dispatch **Programmer (`agency-programmer`)**:
```json
{
  "agent": "agency-programmer",
  "description": "Wave 1 Programmer: Implement scheduler, wildcard overlap, 3-tier limits, and audit log",
  "prompt": "You are the Programmer Agent for Wave 1 in `/home/john/Projects/Heretek-AI-Rebuild/agency-control-plane/worktrees/wave-1` on branch `wave-1-scheduler-limits`.\n\nFIRST: Read `AGENTS.md` and `docs/prompts/SPEC.md` in full.\nSECOND: Implement in `dispatcher/src/`:\n1. `model.ts` and `wildcard.ts` (`mayOverlap`).\n2. `scheduler.ts` (`schedule`, `nextStatus` with `all_success`, `one_success`, fixpoint cancellation closure, and `pathsOverlap` serialization).\n3. `limits.ts` (`extractRetryAfterMs` clamped 1s..300s and `classifyProviderFailure` with 3-tier failover: `tier-1-opencode` -> `tier-2-commercial` -> `tier-3-local` on 429 quota errors).\n4. `audit.ts` (hash-chained JSONL ledger with secret redaction and equal-length rewrite detection).\n5. Write unit tests in `dispatcher/test/scheduler.test.ts` and `dispatcher/test/limits.test.ts`, acceptance script `scripts/accept/wave-1.sh`, and report `docs/reports/wave-1.md`.\n6. Run `bun test` and `bun run check` until green, then commit."
}
```
3. Dispatch **QA (`agency-qa`)** to run `make check`, `bash scripts/accept/wave-1.sh`, and perform Red-Proof Sabotage (revert `limits.ts` so 429 returns `pause-missions` on `tier-1-opencode` and confirm `limits.test.ts` fails; break `pathsOverlap` in `scheduler.ts` and confirm `scheduler.test.ts` fails; restore cleanly with `git checkout --`). Record in `docs/evidence/wave-1/red-proofs.log`.
4. Dispatch **Drift Guard (`agency-drift-guard`)** to audit Wave 1 and issue `VERDICT: PASS` in `docs/reports/wave-1-verification.md`.
5. Merge `wave-1-scheduler-limits` into `main` and remove worktree.

### Wave 2: Crash-Safe Worktrees, Transactional Landing & HTTP/SSE Control Server (`dispatcher/src/{worktrees,landing,event-bus,approval-tickets,server}.ts`)
1. Create worktree: `git worktree add -b wave-2-worktrees-server worktrees/wave-2 main`
2. Dispatch **Programmer (`agency-programmer`)** to implement `worktrees.ts`, `landing.ts`, `event-bus.ts`, `approval-tickets.ts`, `server.ts`, `dispatcher/test/worktrees-landing.test.ts`, `dispatcher/test/server-api.test.ts`, `scripts/accept/wave-2.sh`, and `docs/reports/wave-2.md`.
3. Dispatch **QA (`agency-qa`)** and **Drift Guard (`agency-drift-guard`)** to verify and red-proof Wave 2 (`VERDICT: PASS`).
4. Merge `wave-2-worktrees-server` into `main` and remove worktree.

### Wave 3: Unified High-Fidelity WebUI (`web/src/*` — Kanban, Director Chat, Worker Drill-Down, Split Diff & Ed25519 Approval Drawer)
1. Create worktree: `git worktree add -b wave-3-webui worktrees/wave-3 main`
2. Dispatch **Programmer (`agency-programmer`)** to implement `web/src/state/fleet-store.ts`, `web/src/security/approval-client.ts`, `KanbanBoard.tsx`, `DirectorChat.tsx`, `WorkerDrillDown.tsx`, `SplitDiffViewer.tsx`, `ApprovalDrawer.tsx`, `app.tsx`, `web/test/approval-invariant.test.ts`, `web/test/ui-components.test.ts`, `scripts/accept/wave-3.sh`, `README.md`, and `docs/reports/wave-3.md`.
3. Dispatch **QA (`agency-qa`)** and **Drift Guard (`agency-drift-guard`)** to verify and red-proof Wave 3 (`VERDICT: PASS`).
4. Merge `wave-3-webui` into `main`, remove worktree, and verify `make check && make accept` exits 0 on `main`.
