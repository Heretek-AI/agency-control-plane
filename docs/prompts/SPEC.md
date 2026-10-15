# SPEC.md — Complete Build Specification for `agency-control-plane`

> This file contains VERBATIM copies of `MASTER_BUILD_PROMPT.md` sections 0, 1, 2.1,
> 2.2, 2.3, followed by exact module contracts the Programmer must implement.
> Subagents: read this file in full from disk before doing any work.

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

## 2. EXACT MODULE SPECIFICATIONS

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
       - From `tier-1-opencode` → returns `{ action: "route-fallback", targetTier: "tier-2-commercial" }` (ZERO mission pause!).
       - From `tier-2-commercial` → returns `{ action: "route-fallback", targetTier: "tier-3-local" }`.
       - From `tier-3-local` → returns `{ action: "pause-missions", reason: "...", resumeAfterMs }`.
     - When `failure.status === 429` (transient rate spike without quota exhaustion) → returns `{ action: "retry-delay", delayMs: extractRetryAfterMs(failure.headers) }`.
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

## 3. EXACT MODULE CONTRACTS (BINDING — PROGRAMMER MUST SATISFY)

### 3.1 `dispatcher/src/wildcard.ts` — `mayOverlap`

```ts
export function match(input: string, pattern: string): boolean;
export function literalPrefix(pattern: string): string;
export function mayOverlap(patternA: string, patternB: string): boolean;
```

- `match`: OpenCode dialect — `*` matches any chars including `/`, `?` matches one
  char. Backslashes normalize to `/`. Trailing ` *` also matches the bare prefix.
- `literalPrefix`: text before the first wildcard (`*` or `?`).
- `mayOverlap`: conservative — true when either literal prefix is a prefix of the
  other. Over-serializing is acceptable; colliding runs are not.

### 3.2 `dispatcher/src/scheduler.ts` — `schedule` / `nextStatus`

```ts
export interface ScheduleCaps { fleet: number; perExpert?: (expert: string) => number; }
export interface ScheduleResult { start: string[]; ready: string[]; cancel: string[]; }
export type TaskOutcome = "success" | "failure";
export function schedule(tasks: Task[], runningIds: Iterable<string>, caps: ScheduleCaps): ScheduleResult;
export function nextStatus(task: Task, outcome: TaskOutcome): TaskStatus;
```

- `all_success`: ready iff every dep is `done`. Cancel iff any dep is `failed`/`cancelled`.
  Cascade to fixpoint (id-ordered, deterministic).
- `one_success`: ready iff ≥1 dep is `done`. Cancel iff deps non-empty and every dep is
  terminal with zero `done`.
- Overlap lock: two `expert-run` tasks with `pathsOverlap` (any `mayOverlap(pa,pb)`
  over `input.paths`) NEVER start together — checked against both `running`
  (`blockedByOverlap`) and already-selected (`collidesSelected`).
- `waitingHuman` tasks never start and never force downstream cancellation (they are
  neither `done` for readiness nor `failed`/`cancelled` for cascade).
- Starts ordered by id, bounded by fleet cap and per-expert cap; overflow → `ready`.
- `nextStatus`: `success` → `done`; `fail` strategy → `failed`; `replan` → `waitingHuman`
  (`waiting-human`); `retry` → `pending` while `attempts <= maxAttempts`, else `failed`.

### 3.3 `dispatcher/src/limits.ts` — Retry-After + 3-Tier Failover

```ts
export type ModelTier = "tier-1-opencode" | "tier-2-commercial" | "tier-3-local";
export type ProviderDisposition =
  | { action: "retry-delay"; delayMs: number }
  | { action: "route-fallback"; targetTier: ModelTier }
  | { action: "pause-missions"; reason: string; resumeAfterMs: number };
export function extractRetryAfterMs(headers?: Record<string, string>, defaultMs?: number): number;
export function classifyProviderFailure(
  failure: ProviderFailure,
  consecutiveFailures: number,
  currentTier: ModelTier,
): ProviderDisposition;
```

- `extractRetryAfterMs`: `retry-after-ms` (raw ms) takes precedence; else `retry-after`
  as delta-seconds or HTTP-Date; fallback `defaultMs ?? 5000`; clamp `[1000, 300000]`.
  Header lookup is case-insensitive. Invalid/negative → default.
- `classifyProviderFailure`:
  - Quota shape (`status === 402`, or code in `gousagelimiterror` / `freeusagelimiterror` /
    `insufficient_quota`, or 429 body matching
    `/usage limit|quota exceeded|insufficient quota|credit balance/i`):
    tier-1 → `route-fallback` tier-2; tier-2 → `route-fallback` tier-3;
    tier-3 → `pause-missions` with `resumeAfterMs = extractRetryAfterMs(headers)`.
  - Plain 429 (no quota shape) → `retry-delay` with `delayMs = extractRetryAfterMs(headers)`.
- `ProviderFailure` shape: `{ status?: number; code?: string; message?: string; headers?: Record<string,string> }`.

### 3.4 `dispatcher/src/audit.ts` — Hash-Chained JSONL Ledger

```ts
export interface AuditRecord { seq: number; timestamp: string; event: string; data: unknown; prevHash: string; hash: string; }
export function appendAudit(logPath: string, event: string, data: unknown): AuditRecord;
export function checkAnchor(logPath: string): { ok: boolean; records: number; reason?: string };
```

- Append-only (`O_APPEND`) + `fsync` per record. `hash = SHA-256(prevHash + canonical(record sans hash))`.
- Redact before hashing: `sk-*`, `Bearer *`, `OPENCODE_API_KEY` values → `[REDACTED]`.
- `checkAnchor` replays the chain; any byte modification or equal-length rewrite fails
  (`ok: false` with `reason`).

### 3.5 `dispatcher/src/worktrees.ts` — 2-Phase Allocation

- States `allocating` → `allocated`, recorded in SQLite (WAL + `busy_timeout=15000`)
  BEFORE/AFTER the filesystem worktree creation.
- `cleanupUnconfirmed()`: removes `allocating` rows older than the confirmation window
  and their orphaned directories.
- `jj workspace add` when `.jj` present; fallback `git worktree add -b fleet/<taskId>`.
- `.opencode` state isolated per worktree (never shared).
- `salvageWorktree(taskId)`: anchor `refs/fleet-salvage/<taskId>` at the abandoned
  branch HEAD before deletion.

### 3.6 `dispatcher/src/landing.ts` — Transactional Landing

- `landTask(taskId, missionId)`: pre-checks in task worktree → `--no-ff` merge onto
  `fleet/integration/<missionId>` inside a throwaway landing worktree → post-merge
  verification → on conflict/failure, atomic rollback to pre-merge SHA; throwaway
  worktree always removed.

### 3.7 `dispatcher/src/event-bus.ts` — Ring-Buffered SSE / NATS

- Bounded ring buffer (default 1000 events) with monotonic sequence IDs; overflow
  drops oldest and emits a gap marker.
- `GET /api/events` SSE: `Last-Event-ID` replay, keepalive comments, loopback-only.
- NATS JetStream / KV blackboard bridge when `NATS_URL` set; otherwise in-process bus.
  Same ordering + gap semantics either way.

### 3.8 `dispatcher/src/approval-tickets.ts` — Single-Use Tickets

- `mintTicket(taskId, subjectHash)`: random 256-bit ticket id, single-use, 60s TTL,
  bound to `{ taskId, subjectHash }`.
- `redeemTicket(ticketId, taskId, subjectHash)`: fail-closed — unknown, expired,
  reused, or mismatched binding → reject with descriptive error. Loopback Ed25519
  verification of the signature over `subjectHash`.

### 3.9 `dispatcher/src/server.ts` — Bun HTTP + SSE

- Serves on `127.0.0.1` only (loopback guard; non-loopback `Host` → 403).
- Routes: `GET /api/board`, `POST /api/director/message`,
  `GET /api/tasks/:id/drilldown`, `POST /api/approvals/:taskId/ticket`,
  `POST /api/approvals/:taskId/sign`, `GET /api/events` (SSE).
- Every state-changing route appends to the audit ledger; every error is fail-closed
  with a descriptive JSON error body.

### 3.10 `web/src/state/fleet-store.ts` — Typed Store

- Columns `Backlog | Ready | In Progress | Waiting Approval / QA | Done`, DAG nodes,
  active drill-down worker id, diff cache, tier badge. No secrets, no passphrases —
  Invariant I1 enforced by type + test.

### 3.11 `web/src/security/approval-client.ts` — Invariant I1

- Passphrase lives ONLY in a lexical closure variable during
  `fetch("/api/approvals/:id/sign")`; zeroed (`fill(0)` / reassigned to `""`)
  immediately after the call settles.
- NEVER written to `fleet-store`, `localStorage`, `sessionStorage`, or DOM attributes.
- `approval-invariant.test.ts` asserts this statically (source grep) and at runtime.

### 3.12 `web/src/app.tsx` — Dark-Mode WCAG 2.2 AA

- Dark-mode layout, contrast ≥ 4.5:1 body text, all interactive targets ≥ 24×24px,
  visible focus rings, keyboard-navigable board/chat/drawer.
