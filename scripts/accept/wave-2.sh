#!/usr/bin/env bash
# Wave 2 acceptance: crash-safe worktrees, transactional landing, HTTP/SSE control server.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT"

echo "[wave-2] bun install"
bun install

echo "[wave-2] typecheck dispatcher"
bun run --filter './dispatcher' check

echo "[wave-2] unit tests"
bun test

echo "[wave-2] zero-stub grep (must print nothing)"
W1='TO'"DO"
W2='FI'"XME"
W3='X'"XX"
W4='HA'"CK"
W5='not implemen'"ted"
W6=$(printf '%s "%s"' 'ec'"ho" 'pas'"sed")
W7=$(printf '%s%s %s' '\|' '\|' 'tr'"ue")
W8='ret'"urn true;"
P_STUB="${W1}|${W2}|${W3}|${W4}|${W5}|${W6}|${W7}|${W8}|catch *\(.*\) *\{\}"
STUBS="$(grep -rn --include='*.ts' --include='*.sh' -E "${P_STUB}" dispatcher scripts/accept/wave-2.sh || [ $? -eq 1 ])"
if [ -n "$STUBS" ]; then
  echo "$STUBS"
  echo "[wave-2] FAIL: stub patterns found" >&2
  exit 1
fi
if grep -rn 'set +'"'e'" scripts/accept/wave-2.sh; then
  echo "[wave-2] FAIL: relaxed error handling found" >&2
  exit 1
fi

echo "[wave-2] required deliverables present"
for f in \
  dispatcher/src/worktrees.ts \
  dispatcher/src/landing.ts \
  dispatcher/src/event-bus.ts \
  dispatcher/src/approval-tickets.ts \
  dispatcher/src/server.ts \
  dispatcher/src/index.ts \
  dispatcher/test/worktrees-landing.test.ts \
  dispatcher/test/server-api.test.ts \
  scripts/accept/wave-2.sh \
  docs/reports/wave-2.md \
; do
  test -f "$f" || { echo "[wave-2] FAIL: missing $f" >&2; exit 1; }
done

echo "[wave-2] worktrees + landing + tickets behavior probe"
bun -e '
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { allocateWorktree, releaseWorktree, salvageWorktree, WorktreeStore } from "./dispatcher/src/worktrees.ts";
import { landTask } from "./dispatcher/src/landing.ts";
import { TicketStore, generateApprovalKeyPair, signSubjectHash } from "./dispatcher/src/approval-tickets.ts";
import { EventBus } from "./dispatcher/src/event-bus.ts";
import { createServer } from "./dispatcher/src/server.ts";

const git = (dir, args) => execFileSync("git", args, { cwd: dir, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
const repo = mkdtempSync(join(tmpdir(), "wave2-accept-"));
git(repo, ["init", "-b", "main"]);
writeFileSync(join(repo, "README.md"), "# fleet\n");
git(repo, ["add", "."]);
git(repo, ["-c", "user.email=t@t", "-c", "user.name=t", "commit", "-m", "init"]);

// 2-phase allocation: allocating -> allocated with isolated .opencode state
const base = mkdtempSync(join(tmpdir(), "wave2-store-"));
const store = new WorktreeStore(join(base, "w.db"));
const rec = allocateWorktree({ repoDir: repo, treesDir: join(base, "trees"), taskId: "probe-1", store });
if (rec.state !== "allocated") throw new Error("allocation did not confirm");
if (store.get("probe-1").state !== "allocated") throw new Error("store did not flip to allocated");
if (!existsSync(join(rec.path, ".opencode", "fleet-isolation.json"))) throw new Error(".opencode isolation missing");

// salvage anchors the ref before branch deletion
writeFileSync(join(rec.path, "agent.txt"), "work\n");
git(rec.path, ["add", "agent.txt"]);
git(rec.path, ["-c", "user.email=t@t", "-c", "user.name=t", "commit", "-m", "agent work"]);
const tip = git(repo, ["rev-parse", "fleet/probe-1"]);
releaseWorktree({ repoDir: repo, taskId: "probe-1", store });
const salvaged = salvageWorktree({ repoDir: repo, taskId: "probe-1", store });
if (salvaged.tip !== tip) throw new Error("salvage tip mismatch");
if (git(repo, ["rev-parse", "refs/fleet-salvage/probe-1"]) !== tip) throw new Error("salvage ref missing");

// transactional landing: --no-ff merge success path
git(repo, ["branch", "fleet/probe-2"]);
const lw = mkdtempSync(join(tmpdir(), "wave2-landwork-"));
git(repo, ["worktree", "add", lw, "fleet/probe-2"]);
writeFileSync(join(lw, "feat.txt"), "feat\n");
git(lw, ["add", "feat.txt"]);
git(lw, ["-c", "user.email=t@t", "-c", "user.name=t", "commit", "-m", "feat"]);
git(repo, ["worktree", "remove", "--force", lw]);
const landed = await landTask({ repoDir: repo, landingRoot: join(base, "landing"), taskId: "probe-2", missionId: "m-1" });
if (!landed.ok || landed.rolledBack) throw new Error("landing should succeed without rollback");
const parents = git(repo, ["rev-list", "--parents", "-n", "1", landed.mergedSha]).split(" ");
if (parents.length !== 3) throw new Error("landing merge is not --no-ff");

// tickets are single-use
const tickets = new TicketStore();
const minted = tickets.mintTicket("probe-1", "subject-hash");
tickets.verifyTicket(minted.token);
let reused = false;
try { tickets.verifyTicket(minted.token); } catch { reused = true; }
if (!reused) throw new Error("ticket reuse was not rejected");

// event bus drops oldest with a gap marker
const bus = new EventBus(2);
bus.publish("a", 1); bus.publish("b", 2); bus.publish("c", 3);
const replay = bus.replaySince(1);
if (replay.gap === null) throw new Error("overflow gap marker missing");
if (replay.events.length !== 2) throw new Error("ring buffer size wrong");

// board endpoint serves columns + tier + DAG edges; director message decomposes cards
const app = createServer({});
app.upsertTask({ id: "probe-h", status: "waitingHuman", title: "Human gate" });
const boardRes = await app.fetch(new Request("http://127.0.0.1/api/board"));
if (boardRes.status !== 200) throw new Error("board endpoint failed");
const board = await boardRes.json();
if (board.activeTier !== "tier-1-opencode") throw new Error("board tier wrong");
if (board.columns.length !== 5) throw new Error("board columns wrong");
const msgRes = await app.fetch(new Request("http://127.0.0.1/api/director/message", {
  method: "POST",
  headers: { "content-type": "application/json", "x-csrf-token": app.csrfToken },
  body: JSON.stringify({ message: "Ship it\n- card one\n- card two" }),
}));
if (msgRes.status !== 200) throw new Error("director message failed");
const msg = await msgRes.json();
if (msg.tasksCreated.length !== 2) throw new Error("director decomposition failed");

// ticket mint + Ed25519 sign transitions waitingHuman -> ready
const subject = "probe-subject";
const ticketRes = await app.fetch(new Request("http://127.0.0.1/api/approvals/probe-h/ticket", {
  method: "POST",
  headers: { "content-type": "application/json", "x-csrf-token": app.csrfToken },
  body: JSON.stringify({ subjectHash: subject }),
}));
if (ticketRes.status !== 200) throw new Error("ticket mint failed");
const { ticket } = await ticketRes.json();
const keys = generateApprovalKeyPair();
const signRes = await app.fetch(new Request("http://127.0.0.1/api/approvals/probe-h/sign", {
  method: "POST",
  headers: { "content-type": "application/json", "x-csrf-token": app.csrfToken },
  body: JSON.stringify({ ticket, subjectHash: subject, signature: signSubjectHash(keys.privateKeyPem, subject), publicKey: keys.publicKeyPem }),
}));
if (signRes.status !== 200) throw new Error("approval sign failed");
if ((await signRes.json()).status !== "ready") throw new Error("sign did not transition to ready");
store.close();
console.log("[wave-2] behavior probe passed");
'

echo "[wave-2] PASS"
