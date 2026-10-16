#!/usr/bin/env bash
# Wave 3 acceptance: unified high-fidelity WebUI (5 UX pillars + Invariant I1).
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT"

echo "[wave-3] bun install"
bun install

echo "[wave-3] typecheck (dispatcher + web)"
bun run check

echo "[wave-3] unit tests (all 66 prior + new web tests)"
bun test

echo "[wave-3] zero-stub grep (must print nothing)"
W1='TO'"DO"
W2='FI'"XME"
W3='X'"XX"
W4='HA'"CK"
W5='not implemen'"ted"
W6=$(printf '%s "%s"' 'ec'"ho" 'pas'"sed")
W7=$(printf '%s%s %s' '\|' '\|' 'tr'"ue")
W8='ret'"urn true;"
P_STUB="${W1}|${W2}|${W3}|${W4}|${W5}|${W6}|${W7}|${W8}|catch *\(.*\) *\{\}"
STUBS="$(grep -rn --include='*.ts' --include='*.tsx' --include='*.sh' -E "${P_STUB}" web scripts/accept/wave-3.sh || [ $? -eq 1 ])"
if [ -n "$STUBS" ]; then
  echo "$STUBS"
  echo "[wave-3] FAIL: stub patterns found" >&2
  exit 1
fi
if grep -rn 'set +'"'e'" scripts/accept/wave-3.sh; then
  echo "[wave-3] FAIL: relaxed error handling found" >&2
  exit 1
fi

echo "[wave-3] required deliverables present"
for f in \
  web/package.json \
  web/tsconfig.json \
  web/index.html \
  web/src/app.tsx \
  web/src/state/fleet-store.ts \
  web/src/security/approval-client.ts \
  web/src/components/KanbanBoard.tsx \
  web/src/components/DirectorChat.tsx \
  web/src/components/WorkerDrillDown.tsx \
  web/src/components/SplitDiffViewer.tsx \
  web/src/components/ApprovalDrawer.tsx \
  web/test/approval-invariant.test.ts \
  web/test/ui-components.test.ts \
  scripts/accept/wave-3.sh \
  docs/reports/wave-3.md \
  README.md \
; do
  test -f "$f" || { echo "[wave-3] FAIL: missing $f" >&2; exit 1; }
done

echo "[wave-3] invariant I1 static probe (any hit below FAILS the wave)"
if grep -rni 'passphrase' web/src/state; then
  echo "[wave-3] FAIL: human secret named in fleet-store" >&2
  exit 1
fi
if grep -rn -E '(localStorage|sessionStorage)[[:space:]]*[.\[]' web/src; then
  echo "[wave-3] FAIL: browser storage access in web/src" >&2
  exit 1
fi
if grep -rn -E 'data-(passphrase|secret)' web/src; then
  echo "[wave-3] FAIL: secret rendered into DOM attributes" >&2
  exit 1
fi
if grep -rn -E 'from .*(state/fleet-store|fleet-store)' web/src/security/approval-client.ts; then
  echo "[wave-3] FAIL: approval-client imports reactive state" >&2
  exit 1
fi
if grep -rn -E '^import .*store' web/src/security/approval-client.ts; then
  echo "[wave-3] FAIL: approval-client imports a store module" >&2
  exit 1
fi
grep -q 'finally' web/src/security/approval-client.ts || { echo "[wave-3] FAIL: no finally zeroing in approval-client" >&2; exit 1; }
grep -q 'secret = null' web/src/security/approval-client.ts || { echo "[wave-3] FAIL: closure secret is never nulled" >&2; exit 1; }
echo "[wave-3] I1 static probe passed"

echo "[wave-3] web behavior probe"
(cd web && bun -e '
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { seedStoreFromBoard, applySsePayload } from "./src/app.tsx";
import { ApprovalDrawer } from "./src/components/ApprovalDrawer.tsx";
import { DirectorChat } from "./src/components/DirectorChat.tsx";
import { KanbanBoard } from "./src/components/KanbanBoard.tsx";
import { SplitDiffViewer } from "./src/components/SplitDiffViewer.tsx";
import { WorkerDrillDown } from "./src/components/WorkerDrillDown.tsx";
import { activeApprovalSecrets, approveWithPassphrase, assertNoPassphraseLeak } from "./src/security/approval-client.ts";
import { createFleetStore } from "./src/state/fleet-store.ts";

// store: board seed, move, drill-down, SSE tool event, diff, tier
const store = createFleetStore();
seedStoreFromBoard(store, {
  tasks: [
    { id: "task-101", title: "Scheduler core", branch: "fleet/task-101", owner: ["dispatcher/src"], status: "running" },
    { id: "task-104", title: "Human gate", branch: "fleet/task-104", owner: ["web/src"], status: "waitingHuman" },
  ],
  activeTier: "tier-1-opencode",
  dagEdges: [{ from: "task-101", to: "task-104" }],
  messages: [],
});
if (store.getState().tasks.length !== 2) throw new Error("board seed failed");
store.moveCard("task-101", "Done");
if (store.getState().tasks.find((t) => t.id === "task-101")?.column !== "Done") throw new Error("moveCard failed");
store.setDrilldown({
  sessionId: "sess-task-101", taskId: "task-101", status: "running", tier: "tier-1-opencode",
  profile: "core", stageGates: [{ name: "verify", status: "pass" }], toolStream: [], tokens: 10, cost: 0.001,
});
applySsePayload(store, { topic: "worker.tool", taskId: "task-101", tool: "read", input: "a", output: "b" });
if (store.getState().drilldown?.toolStream.length !== 1) throw new Error("SSE tool event failed");
store.setDiff("task-101", [{ file: "a.ts", status: "modified", additions: 1, deletions: 1, patch: "-x\n+y" }]);
applySsePayload(store, { topic: "tier.fallback", targetTier: "tier-2-commercial" });
if (store.getState().activeTier !== "tier-2-commercial") throw new Error("tier fallback failed");

// all five pillars render to static markup
const state = store.getState();
const pillars = [
  renderToStaticMarkup(createElement(KanbanBoard, { tasks: state.tasks, activeTier: state.activeTier })),
  renderToStaticMarkup(createElement(DirectorChat, { messages: [], charterPreview: "- card one" })),
  renderToStaticMarkup(createElement(WorkerDrillDown, { worker: state.drilldown, dagEdges: state.dagEdges })),
  renderToStaticMarkup(createElement(SplitDiffViewer, { hunks: state.diffs["task-101"] ?? [] })),
  renderToStaticMarkup(createElement(ApprovalDrawer, {
    taskId: "task-104", subjectHash: "probe-hash", additions: 1, deletions: 1, files: 1,
    verdicts: [
      { suite: "qa-functional", status: "pass", detail: "green" },
      { suite: "qa-adversarial", status: "pending", detail: "queued" },
    ],
    ticket: "ticket-probe",
  })),
];
for (const marker of ["Fleet Kanban", "Director", "sess-task-101", "diff-file-tree", "approval-drawer"]) {
  if (!pillars.some((html) => html.includes(marker))) throw new Error(`pillar marker missing: ${marker}`);
}

// I1 runtime probe: secret never leaves the closure
const secret = "probe-secret-303";
let seen = "";
const fakeFetch = async (url, init) => {
  seen = typeof init?.body === "string" ? init.body : "";
  return new Response(JSON.stringify({ taskId: "task-104", status: "ready", subjectHash: "probe-hash" }), { status: 200 });
};
await approveWithPassphrase("task-104", "ticket-probe", secret, "probe-hash", { fetchImpl: fakeFetch });
if (seen.includes(secret)) throw new Error("passphrase leaked onto the wire");
if (activeApprovalSecrets() !== 0) throw new Error("closure secret not zeroed");
const probe = assertNoPassphraseLeak(secret, {
  storeSnapshot: store.getState(),
  domHtml: pillars.join("\n"),
  localStorageDump: {},
  sessionStorageDump: {},
});
if (!probe.ok) throw new Error(`leak probe failed: ${probe.findings.join("; ")}`);
console.log("[wave-3] behavior probe passed");
')

echo "[wave-3] PASS"
