/**
 * Pillar render + state-transition tests for the Wave 3 WebUI.
 *
 * Rendering is asserted through `react-dom/server` static markup
 * (no browser, no network): every pillar must expose its contract
 * markers, and the vanilla `fleet-store` plus `app.tsx` helpers must
 * drive the board lifecycle exactly.
 */
import { describe, expect, test } from "bun:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import {
  applySsePayload,
  boardTaskToCard,
  gatesToVerdicts,
  seedStoreFromBoard,
  statusToColumn,
} from "../src/app.js";
import { ApprovalDrawer } from "../src/components/ApprovalDrawer.js";
import { decomposeCharter, DirectorChat, parseShipCommand } from "../src/components/DirectorChat.js";
import { KanbanBoard } from "../src/components/KanbanBoard.js";
import { diffTotals, parsePatchLines, SplitDiffViewer } from "../src/components/SplitDiffViewer.js";
import { WorkerDrillDown } from "../src/components/WorkerDrillDown.js";
import {
  createFleetStore,
  type DrilldownWorker,
  type TaskCard,
} from "../src/state/fleet-store.js";

const SAMPLE_PATCH = [
  "diff --git a/dispatcher/src/limits.ts b/dispatcher/src/limits.ts",
  "--- a/dispatcher/src/limits.ts",
  "+++ b/dispatcher/src/limits.ts",
  "@@ -1,2 +1,3 @@",
  " context line",
  "-removed line",
  "+added line one",
  "+added line two",
].join("\n");

function sampleCards(): TaskCard[] {
  return [
    { id: "task-101", title: "Scheduler core", branch: "fleet/task-101", ownedPaths: ["dispatcher/src"], tier: "tier-1-opencode", column: "Backlog" },
    { id: "task-102", title: "Limits failover", branch: "fleet/task-102", ownedPaths: ["dispatcher/src/limits.ts"], tier: "tier-2-commercial", column: "Ready" },
    { id: "task-103", title: "Worktree run", branch: "fleet/task-103", ownedPaths: ["dispatcher/src/worktrees.ts"], tier: "tier-1-opencode", column: "In Progress" },
    { id: "task-104", title: "Human gate", branch: "fleet/task-104", ownedPaths: ["web/src"], tier: "tier-3-local", column: "Waiting Approval / QA" },
    { id: "task-105", title: "Landed", branch: "fleet/task-105", ownedPaths: ["docs"], tier: "tier-1-opencode", column: "Done" },
  ];
}

function sampleWorker(): DrilldownWorker {
  return {
    sessionId: "sess-task-103",
    taskId: "task-103",
    status: "running",
    tier: "tier-1-opencode",
    profile: "appsec",
    stageGates: [
      { name: "precheck", status: "pass" },
      { name: "verify", status: "running" },
    ],
    toolStream: [{ seq: 1, tool: "read", input: "limits.ts", output: "ok", timestamp: "2026-10-15T00:00:00.000Z" }],
    tokens: 1234,
    cost: 0.042,
  };
}

describe("pillar 1: KanbanBoard", () => {
  test("renders all five columns with branch badges, path chips, and tier indicators", () => {
    const html = renderToStaticMarkup(createElement(KanbanBoard, { tasks: sampleCards(), activeTier: "tier-1-opencode" }));
    for (const column of ["Backlog", "Ready", "In Progress", "Waiting Approval / QA", "Done"]) {
      expect(html.includes(column)).toBe(true);
    }
    expect(html.includes("fleet/task-101")).toBe(true);
    expect(html.includes("dispatcher/src/limits.ts")).toBe(true);
    expect(html.includes("tier-1")).toBe(true);
    expect(html.includes("tier-2")).toBe(true);
    expect(html.includes("tier-3")).toBe(true);
    for (const id of ["task-101", "task-102", "task-103", "task-104", "task-105"]) {
      expect(html.includes(`card-${id}`)).toBe(true);
    }
  });

  test("selected card is marked pressed for drill-down", () => {
    const html = renderToStaticMarkup(
      createElement(KanbanBoard, { tasks: sampleCards(), activeTier: "tier-1-opencode", selectedTaskId: "task-103" }),
    );
    expect(html.includes("card-task-103")).toBe(true);
    expect(html.includes('aria-pressed="true"')).toBe(true);
  });
});

describe("pillar 2: DirectorChat", () => {
  test("renders docked sidebar with messages, compose box, and charter preview injection", () => {
    const html = renderToStaticMarkup(
      createElement(DirectorChat, {
        messages: [{ seq: 1, author: "director", text: "Plan the fleet", timestamp: "2026-10-15" }],
        dock: "right",
        charterPreview: "- card one\n- card two",
      }),
    );
    expect(html.includes("director-chat")).toBe(true);
    expect(html.includes("Plan the fleet")).toBe(true);
    expect(html.includes("director-compose")).toBe(true);
    expect(html.includes("charter-preview")).toBe(true);
    expect(html.includes("card one")).toBe(true);
    expect(html.includes("inject-dag")).toBe(true);
    expect(html.includes('data-dock="right"')).toBe(true);
  });

  test("parses /ship commands and decomposes charters like the dispatcher", () => {
    expect(parseShipCommand("/ship launch the fleet")).toBe("launch the fleet");
    expect(parseShipCommand("hello")).toBe(null);
    expect(parseShipCommand("/ship")).toBe(null);
    expect(decomposeCharter("- card one\n- card two")).toEqual(["card one", "card two"]);
    expect(decomposeCharter("single line mission")).toEqual(["single line mission"]);
  });
});

describe("pillar 3: WorkerDrillDown", () => {
  test("renders SSE timeline, stage gates, token/tier, DAG graph, and Docker profile", () => {
    const html = renderToStaticMarkup(
      createElement(WorkerDrillDown, {
        worker: sampleWorker(),
        dagEdges: [{ from: "task-101", to: "task-103" }],
      }),
    );
    expect(html.includes("sess-task-103")).toBe(true);
    expect(html.includes("tool-event-1")).toBe(true);
    expect(html.includes("stage-gates")).toBe(true);
    expect(html.includes("precheck")).toBe(true);
    expect(html.includes("1234")).toBe(true);
    expect(html.includes("tier-1-opencode")).toBe(true);
    expect(html.includes("profile:appsec")).toBe(true);
    expect(html.includes("dag-graph")).toBe(true);
    expect(html.includes("task-101")).toBe(true);
  });

  test("empty state prompts card selection", () => {
    const html = renderToStaticMarkup(createElement(WorkerDrillDown, { worker: null, dagEdges: [] }));
    expect(html.includes("worker-drilldown-empty")).toBe(true);
  });
});

describe("pillar 4: SplitDiffViewer", () => {
  const hunks = [
    { file: "dispatcher/src/limits.ts", status: "modified" as const, additions: 2, deletions: 1, patch: SAMPLE_PATCH },
  ];

  test("renders file tree, counters, and side-by-side panes by default", () => {
    const html = renderToStaticMarkup(createElement(SplitDiffViewer, { hunks }));
    expect(html.includes("diff-file-tree")).toBe(true);
    expect(html.includes("dispatcher/src/limits.ts")).toBe(true);
    expect(html.includes("+2")).toBe(true);
    expect(html.includes("-1")).toBe(true);
    expect(html.includes("diff-view-side-by-side")).toBe(true);
    expect(html.includes("diff-pane-added")).toBe(true);
    expect(html.includes("diff-pane-removed")).toBe(true);
    expect(html.includes("added line one")).toBe(true);
  });

  test("unified mode renders a single interleaved view", () => {
    const html = renderToStaticMarkup(createElement(SplitDiffViewer, { hunks, initialMode: "unified" }));
    expect(html.includes("diff-view-unified")).toBe(true);
    expect(html.includes("removed line")).toBe(true);
  });

  test("patch parsing classifies hunks and totals counters", () => {
    const lines = parsePatchLines(SAMPLE_PATCH);
    expect(lines.some((line) => line.kind === "added")).toBe(true);
    expect(lines.some((line) => line.kind === "removed")).toBe(true);
    expect(lines.some((line) => line.kind === "header")).toBe(true);
    expect(diffTotals(hunks)).toEqual({ additions: 2, deletions: 1, files: 1 });
  });
});

describe("pillar 5: ApprovalDrawer", () => {
  test("renders subject hash, diff summary, QA verdicts, and the Ed25519 gate", () => {
    const html = renderToStaticMarkup(
      createElement(ApprovalDrawer, {
        taskId: "task-104",
        displayedSubjectHash: "abc123subject",
        additions: 10,
        deletions: 3,
        files: 2,
        verdicts: [
          { suite: "qa-functional", status: "pass", detail: "12 tests green" },
          { suite: "qa-adversarial", status: "pending", detail: "awaiting red-team" },
        ],
        ticket: {
          ticket: "ticket-9",
          taskId: "task-104",
          subjectHash: "abc123subject",
          timestamp: "2026-10-16T00:00:00.000Z",
          expiresAtMs: 0,
          keyFingerprint: "f".repeat(64),
          publicKeyHex: "00",
          payloads: {
            approve: { runId: "task-104", stage: "APPROVE", subjectHash: "abc123subject", timestamp: "2026-10-16T00:00:00.000Z" },
            reject: { runId: "task-104", stage: "REJECT", subjectHash: "abc123subject", timestamp: "2026-10-16T00:00:00.000Z" },
          },
          diff: { files: 2, additions: 10, deletions: 3 },
        },
      }),
    );
    expect(html.includes("approval-drawer")).toBe(true);
    expect(html.includes("abc123subject")).toBe(true);
    expect(html.includes("qa-functional")).toBe(true);
    expect(html.includes("qa-adversarial")).toBe(true);
    expect(html.includes("approval-secret")).toBe(true);
    expect(html.includes('type="password"')).toBe(true);
    expect(html.includes("approval-approve")).toBe(true);
    expect(html.includes("approval-reject")).toBe(true);
    expect(html.includes("approval-key-file")).toBe(true);
    expect(html.includes("matches the diff shown")).toBe(true);
  });

  test("without a ticket it offers minting; a mismatched subject warns and disables approve", () => {
    const base = {
      taskId: "task-104",
      additions: 1,
      deletions: 0,
      files: 1,
      verdicts: [],
    };
    const noTicket = renderToStaticMarkup(createElement(ApprovalDrawer, { ...base, displayedSubjectHash: "aa", ticket: null }));
    expect(noTicket.includes("app-mint-ticket")).toBe(true);
    expect(noTicket.includes("approval-secret")).toBe(false);
    const payload = { runId: "task-104", stage: "APPROVE", subjectHash: "bb", timestamp: "t" };
    const mismatch = renderToStaticMarkup(
      createElement(ApprovalDrawer, {
        ...base,
        displayedSubjectHash: "aa",
        ticket: {
          ticket: "t",
          taskId: "task-104",
          subjectHash: "bb",
          timestamp: "t",
          expiresAtMs: 0,
          keyFingerprint: "f".repeat(64),
          publicKeyHex: "00",
          payloads: { approve: payload, reject: { ...payload, stage: "REJECT" } },
          diff: { files: 1, additions: 1, deletions: 0 },
        },
      }),
    );
    expect(mismatch.includes("does NOT match")).toBe(true);
    expect(/data-testid="approval-approve"[^>]*disabled/.test(mismatch) || /disabled[^>]*data-testid="approval-approve"/.test(mismatch)).toBe(true);
  });
});

describe("fleet-store transitions", () => {
  test("moveCard, setDrilldown, appendToolEvent, setDiff, and tier flow", () => {
    const store = createFleetStore();
    for (const card of sampleCards()) store.upsertTask(card);
    store.moveCard("task-101", "Ready");
    expect(store.getState().tasks.find((task) => task.id === "task-101")?.column).toBe("Ready");

    store.setDag(
      [{ id: "task-101", label: "Scheduler core" }, { id: "task-102", label: "Limits" }],
      [{ from: "task-101", to: "task-102" }],
    );
    expect(store.getState().dagEdges).toEqual([{ from: "task-101", to: "task-102" }]);

    store.setDrilldown(sampleWorker());
    const first = store.appendToolEvent("task-103", { tool: "edit", input: "x", output: "y" });
    expect(first.seq).toBe(2);
    expect(store.getState().drilldown?.toolStream.length).toBe(2);

    store.setDiff("task-103", [
      { file: "a.ts", status: "added", additions: 5, deletions: 0, patch: "+x" },
    ]);
    expect(store.getState().diffs["task-103"]?.length).toBe(1);

    store.setTier("tier-2-commercial");
    expect(store.getState().activeTier).toBe("tier-2-commercial");
  });

  test("invalid transitions are rejected fail-closed", () => {
    const store = createFleetStore();
    let moves = 0;
    try {
      store.moveCard("missing", "Done");
    } catch {
      moves += 1;
    }
    expect(moves).toBe(1);
    let edges = 0;
    try {
      store.setDag([{ id: "a", label: "a" }], [{ from: "a", to: "ghost" }]);
    } catch {
      edges += 1;
    }
    expect(edges).toBe(1);
    let events = 0;
    try {
      store.appendToolEvent("task-1", { tool: "read", input: "", output: "" });
    } catch {
      events += 1;
    }
    expect(events).toBe(1);
  });

  test("subscribers are notified on every mutation", () => {
    const store = createFleetStore();
    let notifications = 0;
    const unsubscribe = store.subscribe(() => {
      notifications += 1;
    });
    store.upsertTask(sampleCards()[0] as TaskCard);
    expect(notifications).toBe(1);
    unsubscribe();
    store.moveCard("task-101", "Done");
    expect(notifications).toBe(1);
  });
});

describe("app shell helpers", () => {
  test("statusToColumn mirrors the dispatcher column mapping", () => {
    expect(statusToColumn("backlog")).toBe("Backlog");
    expect(statusToColumn("pending")).toBe("Backlog");
    expect(statusToColumn("ready")).toBe("Ready");
    expect(statusToColumn("running")).toBe("In Progress");
    expect(statusToColumn("waitingHuman")).toBe("Waiting Approval / QA");
    expect(statusToColumn("done")).toBe("Done");
    expect(statusToColumn("failed")).toBe("Done");
    expect(statusToColumn("cancelled")).toBe("Done");
  });

  test("boardTaskToCard applies branch and tier defaults, rejects empty ids", () => {
    const card = boardTaskToCard({ id: "task-101", status: "running" }, "tier-1-opencode");
    expect(card).toEqual({
      id: "task-101",
      title: "task-101",
      branch: "fleet/task-101",
      ownedPaths: [],
      tier: "tier-1-opencode",
      column: "In Progress",
    });
    let failures = 0;
    try {
      boardTaskToCard({ id: "  ", status: "ready" }, "tier-1-opencode");
    } catch {
      failures += 1;
    }
    expect(failures).toBe(1);
  });

  test("gatesToVerdicts maps stage gates onto both QA suites", () => {
    const verdicts = gatesToVerdicts([
      { name: "verify", status: "pass" },
      { name: "adversarial", status: "fail" },
    ]);
    expect(verdicts.find((verdict) => verdict.suite === "qa-functional")?.status).toBe("pass");
    expect(verdicts.find((verdict) => verdict.suite === "qa-adversarial")?.status).toBe("fail");
  });

  test("seedStoreFromBoard fills tasks, tier, and DAG edges", () => {
    const store = createFleetStore();
    seedStoreFromBoard(store, {
      tasks: [
        { id: "task-101", title: "Scheduler core", branch: "fleet/task-101", owner: ["dispatcher/src"], status: "running" },
      ],
      activeTier: "tier-2-commercial",
      dagEdges: [],
      messages: [],
    });
    const state = store.getState();
    expect(state.tasks.length).toBe(1);
    expect(state.tasks[0]?.column).toBe("In Progress");
    expect(state.activeTier).toBe("tier-2-commercial");
    expect(state.dagNodes.length).toBe(1);
  });

  test("applySsePayload appends tool events and follows tier fallback", () => {
    const store = createFleetStore();
    store.setDrilldown(sampleWorker());
    applySsePayload(store, { seq: 1, type: "worker.tool", data: { taskId: "task-103", tool: "grep", input: "q", output: "r" } });
    expect(store.getState().drilldown?.toolStream.length).toBe(2);
    // Events for other tasks do not touch the open inspector.
    applySsePayload(store, { seq: 2, type: "worker.tool", data: { taskId: "task-999", tool: "grep" } });
    expect(store.getState().drilldown?.toolStream.length).toBe(2);
    applySsePayload(store, { seq: 3, type: "tier.fallback", data: { targetTier: "tier-3-local" } });
    expect(store.getState().activeTier).toBe("tier-3-local");
    applySsePayload(store, { seq: 4, type: "unknown.noise", data: null });
    expect(store.getState().activeTier).toBe("tier-3-local");
  });
});
