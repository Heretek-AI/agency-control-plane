/**
 * Fleet WebUI root layout (Wave 3): composes all five UX pillars in a
 * high-craft dark-mode shell satisfying WCAG 2.2 AA contrast with
 * >= 24px interactive targets and visible focus rings.
 *
 * - Pillar 1 `KanbanBoard`: 5 columns, branch badges, owned-path chips,
 *   tier indicators, click-to-drilldown.
 * - Pillar 2 `DirectorChat`: dockable sidebar, `/ship` command, charter
 *   preview, 1-click DAG injection.
 * - Pillar 3 `WorkerDrillDown`: live SSE tool timeline, stage gates,
 *   token/tier badge, DAG graph, Docker profile badge.
 * - Pillar 4 `SplitDiffViewer`: side-by-side / unified toggle, file tree,
 *   +/- counters, highlighted hunks.
 * - Pillar 5 `ApprovalDrawer`: subjectHash, diff summary, QA verdicts,
 *   1-click / passphrase Ed25519 gate.
 *
 * Data flow: `GET /api/board` seeds the vanilla `fleet-store`; a shared
 * `EventSource` on `/api/events` streams live worker/tier events into
 * the store; selecting a card loads `GET /api/tasks/:id/drilldown`.
 * The approval secret never touches this module (Invariant I1).
 */
import { useEffect, useState } from "react";
import { ApprovalDrawer, type QaVerdict } from "./components/ApprovalDrawer.js";
import { DirectorChat, decomposeCharter, type DirectorMessageView } from "./components/DirectorChat.js";
import { KanbanBoard } from "./components/KanbanBoard.js";
import { SplitDiffViewer } from "./components/SplitDiffViewer.js";
import { WorkerDrillDown } from "./components/WorkerDrillDown.js";
import { ghostButtonStyle, mutedStyle, palette } from "./components/theme.js";
import {
  createFleetStore,
  type BoardColumn,
  type DiffHunk,
  type FleetStore,
  type ModelTier,
  type TaskCard,
} from "./state/fleet-store.js";

export const BOARD_ENDPOINT = "/api/board";
export const EVENTS_ENDPOINT = "/api/events";

interface BoardTaskJson {
  id: string;
  title?: string | undefined;
  branch?: string | undefined;
  owner?: string[] | undefined;
  status: string;
  sessionId?: string | undefined;
}

interface BoardJson {
  tasks?: BoardTaskJson[] | undefined;
  activeTier?: ModelTier | undefined;
  dagEdges?: Array<{ from: string; to: string }> | undefined;
  messages?: DirectorMessageView[] | undefined;
}

/** Map a dispatcher task status onto a Kanban column (mirrors server `columnFor`). */
export function statusToColumn(status: string): BoardColumn {
  if (status === "ready") return "Ready";
  if (status === "running") return "In Progress";
  if (status === "waitingHuman") return "Waiting Approval / QA";
  if (status === "done" || status === "failed" || status === "cancelled") return "Done";
  return "Backlog";
}

/** Map one dispatcher board task onto a Kanban card. Fail-closed on missing ids. */
export function boardTaskToCard(task: BoardTaskJson, fallbackTier: ModelTier): TaskCard {
  if (task.id.trim().length === 0) {
    throw new Error("fleet app: board task id must be a non-empty string");
  }
  return {
    id: task.id,
    title: task.title ?? task.id,
    branch: task.branch ?? `fleet/${task.id}`,
    ownedPaths: task.owner ?? [],
    tier: fallbackTier,
    column: statusToColumn(task.status),
  };
}

/** Derive the Pillar 5 QA verdicts from drill-down stage gates. */
export function gatesToVerdicts(gates: Array<{ name: string; status: string }>): QaVerdict[] {
  const lookup = new Map(gates.map((gate) => [gate.name, gate.status]));
  const functional = lookup.get("verify") ?? lookup.get("precheck") ?? "pending";
  const adversarial = lookup.get("adversarial") ?? "pending";
  const toVerdict = (suite: QaVerdict["suite"], status: string): QaVerdict => ({
    suite,
    status: status === "pass" ? "pass" : status === "fail" ? "fail" : "pending",
    detail: `stage gate ${status}`,
  });
  return [toVerdict("qa-functional", functional), toVerdict("qa-adversarial", adversarial)];
}

/** Seed one store from a `/api/board` payload. */
export function seedStoreFromBoard(store: FleetStore, board: BoardJson): void {
  const tier: ModelTier = board.activeTier ?? "tier-1-opencode";
  store.setTier(tier);
  for (const task of board.tasks ?? []) {
    store.upsertTask(boardTaskToCard(task, tier));
  }
  const nodes = (board.tasks ?? []).map((task) => ({ id: task.id, label: task.title ?? task.id }));
  store.setDag(nodes, board.dagEdges ?? []);
}

interface SsePayload {
  type?: string | undefined;
  topic?: string | undefined;
  taskId?: string | undefined;
  tool?: string | undefined;
  input?: string | undefined;
  output?: string | undefined;
  targetTier?: ModelTier | undefined;
}

/** Apply one SSE payload to the store; unknown shapes are ignored fail-open (display only). */
export function applySsePayload(store: FleetStore, payload: SsePayload): void {
  const topic = payload.topic ?? payload.type ?? "";
  if ((topic === "worker.tool" || topic === "tool") && typeof payload.taskId === "string" && typeof payload.tool === "string") {
    try {
      store.appendToolEvent(payload.taskId, {
        tool: payload.tool,
        input: payload.input ?? "",
        output: payload.output ?? "",
      });
    } catch {
      return;
    }
    return;
  }
  if (topic === "tier.fallback" && payload.targetTier !== undefined) {
    try {
      store.setTier(payload.targetTier);
    } catch {
      return;
    }
  }
}

export function App(): JSX.Element {
  const [store] = useState(() => createFleetStore());
  const [snapshot, setSnapshot] = useState(() => store.getState());
  const [messages, setMessages] = useState<DirectorMessageView[]>([]);
  const [selectedTaskId, setSelectedTaskId] = useState<string | null>(null);
  const [selectedFile, setSelectedFile] = useState<string | null>(null);
  const [ticket, setTicket] = useState<string | null>(null);
  const [csrfToken, setCsrfToken] = useState<string | undefined>(undefined);
  const [boardError, setBoardError] = useState<string | null>(null);

  useEffect(() => store.subscribe(() => setSnapshot(store.getState())), [store]);

  useEffect(() => {
    let cancelled = false;
    async function loadBoard(): Promise<void> {
      try {
        const response = await fetch(BOARD_ENDPOINT);
        if (!response.ok) {
          throw new Error(`board request failed with status ${response.status}`);
        }
        const board = (await response.json()) as BoardJson;
        if (cancelled) return;
        seedStoreFromBoard(store, board);
        setMessages(board.messages ?? []);
        setBoardError(null);
      } catch (err) {
        if (!cancelled) {
          setBoardError(`fleet app: ${(err as Error).message}`);
        }
      }
    }
    async function loadCsrf(): Promise<void> {
      try {
        const response = await fetch("/api/csrf");
        if (!response.ok) return;
        const payload = (await response.json()) as { csrfToken?: string };
        if (!cancelled && typeof payload.csrfToken === "string") {
          setCsrfToken(payload.csrfToken);
        }
      } catch {
        return;
      }
    }
    void loadBoard();
    void loadCsrf();
    return () => {
      cancelled = true;
    };
  }, [store]);

  useEffect(() => {
    if (typeof EventSource === "undefined") return;
    const source = new EventSource(EVENTS_ENDPOINT);
    source.onmessage = (event: MessageEvent) => {
      try {
        applySsePayload(store, JSON.parse(event.data as string) as SsePayload);
        setSnapshot(store.getState());
      } catch {
        return;
      }
    };
    return () => {
      source.close();
    };
  }, [store]);

  async function selectTask(taskId: string): Promise<void> {
    setSelectedTaskId(taskId);
    setSelectedFile(null);
    setTicket(null);
    try {
      const response = await fetch(`/api/tasks/${encodeURIComponent(taskId)}/drilldown`);
      if (!response.ok) return;
      const view = (await response.json()) as {
        session?: { sessionId?: string; status?: string; tier?: ModelTier };
        stageGates?: Array<{ name: string; status: "pending" | "running" | "pass" | "fail" }>;
        toolLog?: Array<{ seq: number; tool: string; input: string; output: string }>;
        diffs?: DiffHunk[];
      };
      const card = store.getState().tasks.find((entry) => entry.id === taskId);
      store.setDrilldown({
        sessionId: view.session?.sessionId ?? `sess-${taskId}`,
        taskId,
        status: view.session?.status ?? card?.column ?? "running",
        tier: view.session?.tier ?? store.getState().activeTier,
        profile: "core",
        stageGates: view.stageGates ?? [],
        toolStream: (view.toolLog ?? []).map((entry) => ({
          seq: entry.seq,
          tool: entry.tool,
          input: entry.input,
          output: entry.output,
          timestamp: new Date().toISOString(),
        })),
        tokens: 0,
        cost: 0,
      });
      store.setDiff(taskId, view.diffs ?? []);
      setSnapshot(store.getState());
    } catch {
      return;
    }
  }

  async function injectDag(spec: string): Promise<void> {
    const titles = decomposeCharter(spec);
    titles.forEach((title, index) => {
      const id = `task-${Date.now()}-${index}`;
      try {
        store.upsertTask({
          id,
          title,
          branch: `fleet/${id}`,
          ownedPaths: [],
          tier: store.getState().activeTier,
          column: "Backlog",
        });
      } catch {
        return;
      }
    });
    setSnapshot(store.getState());
    try {
      const headers: Record<string, string> = { "content-type": "application/json" };
      if (csrfToken !== undefined) headers["x-csrf-token"] = csrfToken;
      const response = await fetch("/api/director/message", {
        method: "POST",
        headers,
        body: JSON.stringify({ message: `/ship ${spec}` }),
      });
      if (!response.ok) return;
      const payload = (await response.json()) as { message?: DirectorMessageView };
      if (payload.message !== undefined) {
        setMessages((current) => [...current, payload.message as DirectorMessageView]);
      }
    } catch {
      return;
    }
  }

  async function sendMessage(text: string): Promise<void> {
    if (text.startsWith("/ship ")) {
      await injectDag(text.slice("/ship ".length));
      return;
    }
    try {
      const headers: Record<string, string> = { "content-type": "application/json" };
      if (csrfToken !== undefined) headers["x-csrf-token"] = csrfToken;
      const response = await fetch("/api/director/message", {
        method: "POST",
        headers,
        body: JSON.stringify({ message: text }),
      });
      if (!response.ok) return;
      const payload = (await response.json()) as { message?: DirectorMessageView };
      if (payload.message !== undefined) {
        setMessages((current) => [...current, payload.message as DirectorMessageView]);
      }
    } catch {
      return;
    }
  }

  async function mintTicket(taskId: string, subjectHash: string): Promise<void> {
    try {
      const headers: Record<string, string> = { "content-type": "application/json" };
      if (csrfToken !== undefined) headers["x-csrf-token"] = csrfToken;
      const response = await fetch(`/api/approvals/${encodeURIComponent(taskId)}/ticket`, {
        method: "POST",
        headers,
        body: JSON.stringify({ subjectHash }),
      });
      if (!response.ok) return;
      const payload = (await response.json()) as { ticket?: string };
      if (typeof payload.ticket === "string") {
        setTicket(payload.ticket);
      }
    } catch {
      return;
    }
  }

  const drilldown = snapshot.drilldown;
  const diffs = selectedTaskId === null ? [] : (snapshot.diffs[selectedTaskId] ?? []);
  const additions = diffs.reduce((sum, hunk) => sum + hunk.additions, 0);
  const deletions = diffs.reduce((sum, hunk) => sum + hunk.deletions, 0);
  const subjectHash = selectedTaskId === null ? "" : `webui:${selectedTaskId}:${diffs.length}:${additions}:${deletions}`;

  return (
    <div style={{ backgroundColor: palette.appBg, color: palette.text, minHeight: "100vh" }}>
      <style>{"*:focus-visible { outline: 2px solid #8ab8ff; outline-offset: 2px; }"}</style>
      <header style={{ display: "flex", alignItems: "center", gap: 12, padding: "12px 16px", borderBottom: `1px solid ${palette.panelBorder}` }}>
        <h1 style={{ fontSize: 18, margin: 0 }}>Fleet Control Plane</h1>
        <span style={{ ...mutedStyle() }} data-testid="app-tier">
          {snapshot.activeTier}
        </span>
        <span style={{ marginLeft: "auto", display: "flex", gap: 8 }}>
          <button type="button" data-testid="app-refresh-board" style={ghostButtonStyle()} onClick={() => void (async () => {
            try {
              const response = await fetch(BOARD_ENDPOINT);
              if (!response.ok) return;
              seedStoreFromBoard(store, (await response.json()) as BoardJson);
              setSnapshot(store.getState());
            } catch {
              return;
            }
          })()}>
            Refresh board
          </button>
        </span>
      </header>
      {boardError !== null ? (
        <p role="alert" style={{ color: palette.failText, padding: "8px 16px", margin: 0 }}>
          {boardError}
        </p>
      ) : null}
      <div style={{ display: "grid", gridTemplateColumns: "1fr minmax(300px, 360px)", gap: 12, padding: 12 }}>
        <main style={{ display: "flex", flexDirection: "column", gap: 12, minWidth: 0 }}>
          <KanbanBoard
            tasks={snapshot.tasks}
            activeTier={snapshot.activeTier}
            selectedTaskId={selectedTaskId}
            onSelectTask={(taskId) => void selectTask(taskId)}
          />
          <WorkerDrillDown
            worker={drilldown}
            dagEdges={snapshot.dagEdges}
            onClose={() => {
              store.setDrilldown(null);
              setSnapshot(store.getState());
              setSelectedTaskId(null);
            }}
          />
          <SplitDiffViewer hunks={diffs} selectedFile={selectedFile} onSelectFile={setSelectedFile} />
          {selectedTaskId !== null ? (
            <ApprovalDrawer
              taskId={selectedTaskId}
              subjectHash={subjectHash}
              additions={additions}
              deletions={deletions}
              files={diffs.length}
              verdicts={gatesToVerdicts(drilldown?.stageGates ?? [])}
              ticket={ticket}
              csrfToken={csrfToken}
              onApproved={(result) => {
                store.moveCard(result.taskId, "Ready");
                setSnapshot(store.getState());
              }}
            />
          ) : null}
          {selectedTaskId !== null && ticket === null ? (
            <div>
              <button
                type="button"
                data-testid="app-mint-ticket"
                style={ghostButtonStyle()}
                onClick={() => void mintTicket(selectedTaskId, subjectHash)}
              >
                Mint approval ticket
              </button>
            </div>
          ) : null}
        </main>
        <DirectorChat messages={messages} dock="right" onSend={(text) => void sendMessage(text)} onInjectDag={(spec) => void injectDag(spec)} />
      </div>
    </div>
  );
}

export default App;
