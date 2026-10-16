# Agency Control Plane — Fleet Dispatcher Daemon + High-Fidelity WebUI

The Fleet Control Plane schedules expert missions across isolated
`jj` / Git worktrees, gates human approvals behind single-use Ed25519
tickets, and renders the whole fleet in one dark-mode WebUI with five
locked-in UX pillars.

## Layout

- `dispatcher/` — Fleet Dispatcher Daemon: pure DAG scheduler with
  path-overlap arbitration (`model.ts`, `wildcard.ts`, `scheduler.ts`),
  3-tier Bifrost failover (`limits.ts`), hash-chained audit ledger
  (`audit.ts`), crash-safe worktree coordinator (`worktrees.ts`),
  transactional landing (`landing.ts`), ring-buffered SSE / NATS event
  bus (`event-bus.ts`), single-use approval tickets + Ed25519 helpers
  (`approval-tickets.ts`), and the loopback Bun HTTP + SSE control API
  (`server.ts`, `index.ts`).
- `web/` — Unified High-Fidelity WebUI (`@heretek-ai/agency-web`):
  1. `KanbanBoard.tsx` — 5-column worktree Kanban (`Backlog`, `Ready`,
     `In Progress`, `Waiting Approval / QA`, `Done`) with branch badges
     (`fleet/task-101`), owned-path chips, and model-tier indicators.
  2. `DirectorChat.tsx` — persistent dockable Director sidebar with
     `/ship <spec>`, mission charter preview, and 1-click DAG injection.
  3. `WorkerDrillDown.tsx` — live SSE tool-call timeline, stage gates,
     token/cost telemetry, DAG dependency graph, and Docker Compose
     profile badge (`core` / `appsec` / `android` / `game` / `research`).
  4. `SplitDiffViewer.tsx` — side-by-side / unified diff viewer with
     file tree, `+`/`-` counters, and highlighted hunks.
  5. `ApprovalDrawer.tsx` — exact `subjectHash`, diff summary, QA
     verdicts (`qa-functional` + `qa-adversarial`), and the 1-click /
     passphrase Ed25519 approval gate.
- `scripts/accept/` — per-wave acceptance scripts (`wave-1.sh`,
  `wave-2.sh`, `wave-3.sh`); `docs/reports/` — wave reports and
  drift-guard verdicts; `docs/evidence/` — QA red-proof sabotage logs.

## Quickstart

```sh
bun install
bun run check     # typecheck + lint, zero warnings
bun test          # full suite: dispatcher + web
bash scripts/accept/wave-3.sh   # wave 3 gate (install, check, tests, I1 probe)
make accept       # all three waves
```

Serve the dispatcher API (loopback only) via `startServer` in
`dispatcher/src/server.ts`, then point the WebUI at it (`web/index.html`
loads `web/src/app.tsx`, which talks to the same `/api/*` routes).

## Control API (`dispatcher/src/server.ts`, Bun HTTP + SSE, `127.0.0.1` only)

| Method & Path | Purpose |
|---------------|---------|
| `GET /api/board` | Kanban columns, tasks, worktree statuses, active model tier (`tier-1-opencode` / `tier-2-commercial` / `tier-3-local`), DAG edges. |
| `POST /api/director/message` | Append steering message; decompose new task cards onto the board. |
| `GET /api/tasks/:id/drilldown` | Worker session metadata, stage gates, live tool-log buffer, git diff hunks. |
| `POST /api/approvals/:taskId/ticket` | Mint single-use 60s-TTL preview ticket bound to `{ taskId, subjectHash }`. |
| `POST /api/approvals/:taskId/sign` | Verify ticket + Ed25519 signature/passphrase; `waitingHuman` → `ready`/`done`; audit-chained. |
| `GET /api/events` | SSE stream (ring-buffered, replayable sequence IDs; `?snapshot=1` for finite replay). |

The WebUI (`web/src/app.tsx`) seeds its store from `GET /api/board`,
subscribes to `/api/events` via `EventSource`, loads per-card drill-downs
from `/api/tasks/:id/drilldown`, and mints/signs approvals through the
ticket endpoints.

## Security Invariant I1 (binding)

The human approval secret entered in the approval dialog is held **only**
in a lexical function-closure variable for the duration of the
`fetch("/api/approvals/:id/sign")` call, is overwritten and nulled in a
`finally` block immediately after, and is **never** written to
`fleet-store`, `localStorage`, `sessionStorage`, or DOM data attributes.

- Enforcement: `web/src/security/approval-client.ts`
  (`approveWithPassphrase` / `approveOneClick` /
  `assertNoPassphraseLeak`); the drawer (`ApprovalDrawer.tsx`) reads the
  secret from an uncontrolled password input at submit time and clears
  the input afterwards — no React state ever holds it.
- Proof: `web/test/approval-invariant.test.ts` (static source probe +
  runtime wire/sink assertions) and the I1 section of
  `scripts/accept/wave-3.sh`, which fails the wave on any violation.
