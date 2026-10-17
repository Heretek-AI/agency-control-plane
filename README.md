# Agency Control Plane — Fleet Dispatcher Daemon + High-Fidelity WebUI

The Fleet Control Plane runs coding workers (OpenCode v2 servers) in
isolated Git / `jj` worktrees, lets a human steer a long-lived Director
session from a chat sidebar, and gates every worker diff behind an
Ed25519 signature from a pinned human key. One dark-mode WebUI shows the
whole fleet through five UX pillars.

## Run it

Requirements: Bun 1.4.2, Git, and the `opencode` CLI (v2, `opencode serve`)
on `PATH` with a provider configured. Optional: a NATS server with
JetStream.

```sh
bun install --frozen-lockfile --ignore-scripts

# 1. The human approval key (once). Same format as epistemic-factory es-core:
#    human.key.enc (scrypt + AES-256-GCM sealed Ed25519 key, 0600) + human.pub.
bun run keygen -- --out ~/.local/state/agency-control-plane
#    Already have an es-core key? Point the dispatcher at it instead:
#    --human-pub /path/to/human.pub (or put human.pub in the state dir).

# 2. Build the WebUI and start the dispatcher on the repository to work on.
bun run build:web
bun run dispatcher -- --repo /path/to/repo --port 7600
#    (or `bun run serve -- --repo ...` to build and start in one go)

# 3. Open http://127.0.0.1:7600 — the UI and /api share one loopback origin.
```

Dispatcher flags (also documented in the header of `dispatcher/src/main.ts`):

| Flag / env | Default | Meaning |
|------------|---------|---------|
| `--repo` / `FLEET_REPO` | cwd | Repository the fleet works on |
| `--state-dir` / `FLEET_STATE_DIR` | `~/.local/state/agency-control-plane` | SQLite board + worktree register (`dispatcher.db`, WAL, `busy_timeout=15000`), `worktrees/`, `audit.jsonl`, `human.pub` |
| `--port` / `FLEET_PORT` | `7600` | Loopback port (never binds anything but 127.0.0.1) |
| `--human-pub` | `<state-dir>/human.pub` | Pinned human public key. Missing or invalid → approvals are disabled and the approval routes answer 503 (fail closed) |
| `--worker-cmd` / `FLEET_WORKER_CMD` | `opencode serve --port 0 --hostname 127.0.0.1` | Worker server command (JSON array or words) |
| `--director-cmd` / `FLEET_DIRECTOR_CMD` | worker command | Director server command |
| `--director-agent` | `director` | OpenCode agent of the Director session (define it in your OpenCode config) |
| `--task-agent` | server default | OpenCode agent for task sessions |
| `--fleet-cap` | `4` | Max concurrent workers (scheduler cap) |
| `--per-expert-cap` | fleet cap | Max concurrent workers per `expert` when its role pack sets no `maxConcurrent` |
| `--roles-dir` / `FLEET_ROLES_DIR` | unset | Role packs for `expert` tasks (see **Role packs** below) |
| `--tier-models` / `FLEET_TIER_MODELS` | unset | JSON `{"tier-1-opencode": "provider/model", "tier-2-commercial": …, "tier-3-local": …}`. New worker sessions run on the active tier's model; unset tiers use the worker's default model |
| `--task-timeout-ms` | 30 min | Per-task worker timeout |
| `--no-workers`, `--no-director` | | Disable the launcher / Director |
| `NATS_URL` | unset | Mirror events + board into NATS JetStream / KV (start fails if set but unreachable) |

## How work flows

1. **Director chat.** Messages go to one long-lived OpenCode session
   (agent `director`) started in the repository with its own isolated
   OpenCode database. The reply is shown in chat. Cards are created only
   from a fenced block the Director emits, validated with zod (strict;
   unknown fields, bad deps, or invalid JSON create nothing and are
   reported in chat):

   ````
   ```tasks
   [{"key":"api","title":"Query API","objective":"…","paths":["src/api/*"],"acceptance":["…"]},
    {"key":"docs","title":"Docs","deps":["api"],"paths":["docs/*"]}]
   ```
   ````

   `/ship <spec>` is the explicit manual fallback: each bullet of the
   spec becomes one card, no Director involved.
2. **Scheduler + launcher.** On every board change the pure scheduler
   (deps, `all_success` / `one_success`, path-overlap serialization,
   fleet / per-expert caps) picks tasks to start. For each one the
   launcher allocates the worktree (`fleet/<task>` branch, two-phase
   crash-safe register), pins the base commit, spawns the worker command
   in it with `OPENCODE_DB=<worktree>/.opencode/opencode.db` and a random
   `OPENCODE_SERVER_PASSWORD`, parses `server listening on <url>`, creates
   a session (`POST /api/session`), sends the task prompt
   (`POST /api/session/:id/prompt`), and follows `GET /api/event`:
   `session.tool.*` become the drill-down live tool log, `session.status`
   / `session.text.ended` are republished on the dispatcher bus,
   `session.execution.succeeded|failed|interrupted` (or the process
   exiting / timing out) ends the run. Successful runs are committed onto
   the task branch (never the `.opencode` state); a non-empty diff moves
   the card to **Waiting Approval / QA**, an empty one to **Done**.
   Failures follow the task's retry policy, except quota-shaped provider
   errors (`limits.ts`): those move the fleet to the next model tier and
   re-queue the task without spending an attempt; quota on
   `tier-3-local` holds new launches until the provider's retry time.
   Shutdown (SIGINT/SIGTERM) kills every worker and re-queues
   interrupted tasks.
3. **Approval.** The human opens the card, checks the diff, and mints a
   ticket. The **server** computes `subjectHash = sha256(concatenated
   per-file patches of base...fleet/<task>)` and returns the exact
   payload to sign: canonical JSON of `{ runId: <taskId>, stage:
   "APPROVE" | "REJECT", subjectHash, timestamp }` — the same payload
   shape and key format as es-core `signStageApproval` /
   `verifyStageApproval`, so one human key serves both systems (the
   disjoint stage names stop a record for one system being replayed on
   the other). The browser recomputes the hash from the diff it displays
   and refuses to sign on mismatch, unlocks the chosen `human.key.enc`
   (scrypt via `@noble/hashes`, AES-GCM + Ed25519 via WebCrypto) or a
   PKCS#8 key file, checks the signature against the pinned key, and
   sends only `{ ticket, approve, subjectHash, signatureHex }`. The
   dispatcher burns the single-use 60 s ticket, recomputes the diff hash,
   and verifies against the pinned `human.pub` only (any client key or
   passphrase is ignored). APPROVE lands the task: `fleet/<task>` is
   merged `--no-ff` into `fleet/integration/<mission>` in a throwaway
   worktree (`landing.ts`), the task moves to `done` with its
   `landedSha`. A merge conflict leaves the integration branch untouched
   and the task in **Waiting Approval / QA** (409, conflicting files in
   the response and the task reason); resolve on the task branch and
   approve again. REJECT → `failed`. The full es-core-shaped signed
   record goes into the hash-chained audit ledger.
4. **Worktree release.** When a task reaches `done`, `failed`, or
   `cancelled` and no worker runs in it, its worktree is removed (the
   branch stays). Branches of `failed` / `cancelled` tasks are then
   anchored at `refs/fleet-salvage/<task>` and deleted, so no work is
   lost. A restart releases worktrees of tasks that finished while the
   dispatcher was down.
5. **Persistence.** Tasks, missions, chat, counters and per-task tool
   logs live in `<state-dir>/dispatcher.db`; a restart resumes the board
   (tasks that were running are re-queued).
6. **NATS (optional).** With `NATS_URL`, every bus event is published to
   JetStream subject `fleet.events.<type>` on stream `FLEET_EVENTS`
   (drop-oldest at 10 000 messages) and every task document is mirrored to
   KV bucket `fleet-board` (`nats@2.29.3`). The in-process ring buffer
   remains the SSE source of truth.

## Role packs (`--roles-dir`)

A task's `expert` names a role pack at `<roles-dir>/<role-id>/`, laid out
as an OpenCode config home:

```text
<roles-dir>/<role-id>/
  role.json                       optional: {"maxConcurrent": 2}
  opencode/opencode.json          copied (not symlinked) into the worktree .opencode/
  opencode/agent/<role-id>.md     role prompt, frontmatter stripped, put in the task prompt
  opencode/skill/<name>/SKILL.md  listed in the task prompt
```

The worker runs with `XDG_CONFIG_HOME=<roles-dir>/<role-id>`, so OpenCode
also picks the role's agents and skills up as its global config.
`agents/` and `skills/` work as plural aliases. Only slug role ids
resolve; an `expert` without a pack runs with the generic prompt and a
`role.missing` event.

## Control API (`dispatcher/src/server.ts`, Bun HTTP + SSE, `127.0.0.1` only)

| Method & Path | Purpose |
|---------------|---------|
| `GET /api/board` | Columns, tasks, worktrees, tier, DAG edges, chat, scheduler plan, approval/Director availability. |
| `POST /api/director/message` | `/ship <spec>` → cards now (200); otherwise → Director turn (202; reply + cards arrive as `director.message`). 503 without a Director. |
| `GET /api/tasks/:id/drilldown` | Session, stage gates, tool log, diff hunks, `subjectHash`. |
| `POST /api/approvals/:taskId/ticket` | Single-use 60 s ticket; server-computed `subjectHash`, payloads to sign, pinned key fingerprint. 503 without a pinned key, 409 unless `waitingHuman`. |
| `POST /api/approvals/:taskId/sign` | Burn ticket, re-hash diff, verify Ed25519 against the pinned key; APPROVE lands the task (`done` + `landedSha`, or 409 `landing-failed` with conflicting files and the task kept `waitingHuman`), REJECT → `failed`. |
| `GET /api/events` | SSE (ring-buffered, `Last-Event-ID` replay, gap markers). |
| `GET /api/csrf` | CSRF token for POSTs. |
| `GET /*` | The built WebUI (`web/dist`) with a strict same-origin CSP. |

## Layout

- `dispatcher/src/` — `model.ts`, `wildcard.ts`, `scheduler.ts`, `limits.ts`,
  `audit.ts`, `worktrees.ts`, `landing.ts`, `event-bus.ts`,
  `approval-tickets.ts`, `human-key.ts` (es-core-compatible pinned key),
  `board-store.ts` (SQLite board), `opencode-client.ts` (worker process +
  OpenCode v2 HTTP client behind `WorkerApi`), `worker-session.ts`,
  `worker-launcher.ts`, `roles.ts` (role packs), `director.ts`, `nats-bridge.ts`, `server.ts`,
  `main.ts` (daemon), `keygen.ts`.
- `dispatcher/test/fixtures/fake-opencode.ts` — fake `opencode serve`
  implementing the routes above, used by the launcher/Director tests and
  the browser smoke test. `fixtures/es-core-vector/` — a key + record
  produced by es-core itself.
- `web/` — React UI; `web/src/main.tsx` is the browser entry,
  `scripts/build-web.ts` bundles `web/index.html` into `web/dist`.
- `scripts/accept/wave-{1..4}.sh`, `scripts/e2e/ui-smoke.ts` (Chromium via
  `playwright-core`; screenshot in `docs/evidence/ui.png`).

## Checks

```sh
make check     # install, typecheck, bun test
make accept    # waves 1-4; wave 4 builds the UI and runs the Chromium smoke test
```

The NATS integration test uses `NATS_URL` or spawns `nats-server` from
`PATH` / `~/go/bin` (`go install github.com/nats-io/nats-server/v2@v2.10.24`);
without either it is skipped. The UI smoke test needs Chromium for
`playwright-core@1.56.1` (`PLAYWRIGHT_BROWSERS_PATH`, or
`./node_modules/.bin/playwright-core install chromium`). CI
(`.github/workflows/ci.yml`) installs both and runs `make check` and
`make accept`.

## Security Invariant I1 (binding)

The passphrase and key-file bytes are read from uncontrolled inputs at
submit time and live only in local variables of `approveWithKeyFile`
(`web/src/security/approval-client.ts`) for the duration of the sign
request; byte buffers (file, scrypt output, decrypted PKCS#8) are
zero-filled and every reference nulled in `finally`, the signing key is a
non-extractable `CryptoKey`, and nothing reaches `fleet-store`,
`localStorage`, `sessionStorage`, or DOM attributes. Proof:
`web/test/approval-invariant.test.ts`, the I1 section of
`scripts/accept/wave-3.sh`, and the in-browser sink check of
`scripts/e2e/ui-smoke.ts`.
