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
import { useCallback, useEffect, useRef, useState } from "react";
import { ApprovalDrawer, type QaVerdict } from "./components/ApprovalDrawer.js";
import { DirectorChat, type DirectorMessageView } from "./components/DirectorChat.js";
import { KanbanBoard } from "./components/KanbanBoard.js";
import { SplitDiffViewer } from "./components/SplitDiffViewer.js";
import { WorkerDrillDown } from "./components/WorkerDrillDown.js";
import { ghostButtonStyle, mutedStyle, palette } from "./components/theme.js";
import { subjectHashForHunks, type ApprovalTicketView } from "./security/approval-client.js";
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
  approvals?: { available: boolean; reason: string | null; fingerprint: string | null } | undefined;
  director?: { available: boolean } | undefined;
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

/** One dispatcher bus frame as delivered over SSE (`data:` of `/api/events`). */
export interface BusFrame {
  seq?: number | undefined;
  type?: string | undefined;
  data?: Record<string, unknown> | null | undefined;
}

/** Bus event types after which the board is re-fetched. */
export const BOARD_REFRESH_EVENTS: readonly string[] = [
  "task.updated",
  "director.message",
  "approval.signed",
  "worker.started",
  "worker.finished",
] as const;

/** Every event type the UI listens to on the SSE stream. */
export const SSE_EVENT_TYPES: readonly string[] = [...BOARD_REFRESH_EVENTS, "worker.tool", "worker.gates", "worker.status", "tier.fallback"];

/** Apply one bus frame to the store (tool timeline, tier). Unknown shapes are ignored (display only). */
export function applySsePayload(store: FleetStore, frame: BusFrame): void {
  const data = frame.data ?? {};
  const taskId = data["taskId"];
  if (frame.type === "worker.tool" && typeof taskId === "string" && typeof data["tool"] === "string") {
    if (store.getState().drilldown?.taskId !== taskId) return;
    store.appendToolEvent(taskId, {
      tool: data["tool"],
      input: typeof data["input"] === "string" ? data["input"] : "",
      output: typeof data["output"] === "string" ? data["output"] : "",
    });
    return;
  }
  if (frame.type === "tier.fallback") {
    const tier = data["targetTier"];
    if (tier === "tier-1-opencode" || tier === "tier-2-commercial" || tier === "tier-3-local") {
      store.setTier(tier);
    }
  }
}

function jsonHeaders(csrfToken: string | undefined): Record<string, string> {
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (csrfToken !== undefined) headers["x-csrf-token"] = csrfToken;
  return headers;
}

export function App(): JSX.Element {
  const [store] = useState(() => createFleetStore());
  const [snapshot, setSnapshot] = useState(() => store.getState());
  const [messages, setMessages] = useState<DirectorMessageView[]>([]);
  const [selectedTaskId, setSelectedTaskId] = useState<string | null>(null);
  const [selectedFile, setSelectedFile] = useState<string | null>(null);
  const [ticket, setTicket] = useState<ApprovalTicketView | null>(null);
  const [csrfToken, setCsrfToken] = useState<string | undefined>(undefined);
  const [boardError, setBoardError] = useState<string | null>(null);
  const [approvals, setApprovals] = useState<BoardJson["approvals"]>(undefined);
  const [displayedSubjectHash, setDisplayedSubjectHash] = useState<string | null>(null);
  const [chatNotice, setChatNotice] = useState<string | null>(null);
  const selectedRef = useRef<string | null>(null);

  useEffect(() => store.subscribe(() => setSnapshot(store.getState())), [store]);

  const refreshBoard = useCallback(async (): Promise<void> => {
    try {
      const response = await fetch(BOARD_ENDPOINT);
      if (!response.ok) {
        throw new Error(`board request failed with status ${response.status}`);
      }
      const board = (await response.json()) as BoardJson;
      seedStoreFromBoard(store, board);
      setMessages(board.messages ?? []);
      setApprovals(board.approvals);
      setBoardError(null);
    } catch (err) {
      setBoardError(`fleet app: ${(err as Error).message}`);
    }
  }, [store]);

  const loadDrilldown = useCallback(
    async (taskId: string): Promise<void> => {
      try {
        const response = await fetch(`/api/tasks/${encodeURIComponent(taskId)}/drilldown`);
        if (!response.ok || selectedRef.current !== taskId) return;
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
      } catch (err) {
        setBoardError(`fleet app: drill-down failed: ${(err as Error).message}`);
      }
    },
    [store],
  );

  useEffect(() => {
    let cancelled = false;
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
    void refreshBoard();
    void loadCsrf();
    return () => {
      cancelled = true;
    };
  }, [refreshBoard]);

  useEffect(() => {
    if (typeof EventSource === "undefined") return;
    const source = new EventSource(EVENTS_ENDPOINT);
    let pending: ReturnType<typeof setTimeout> | null = null;
    const scheduleRefresh = (): void => {
      if (pending !== null) return;
      pending = setTimeout(() => {
        pending = null;
        void refreshBoard();
        const selected = selectedRef.current;
        if (selected !== null) void loadDrilldown(selected);
      }, 150);
    };
    const onFrame = (event: MessageEvent): void => {
      let frame: BusFrame;
      try {
        frame = JSON.parse(event.data as string) as BusFrame;
      } catch {
        return;
      }
      try {
        applySsePayload(store, frame);
      } catch {
        return;
      }
      if (frame.type !== undefined && (BOARD_REFRESH_EVENTS.includes(frame.type) || frame.type === "worker.gates")) {
        scheduleRefresh();
      }
    };
    for (const type of SSE_EVENT_TYPES) {
      source.addEventListener(type, onFrame as EventListener);
    }
    return () => {
      if (pending !== null) clearTimeout(pending);
      source.close();
    };
  }, [store, refreshBoard, loadDrilldown]);

  const diffs = selectedTaskId === null ? [] : (snapshot.diffs[selectedTaskId] ?? []);

  useEffect(() => {
    let cancelled = false;
    if (selectedTaskId === null) {
      setDisplayedSubjectHash(null);
      return;
    }
    void subjectHashForHunks(diffs).then((hash) => {
      if (!cancelled) setDisplayedSubjectHash(hash);
    });
    return () => {
      cancelled = true;
    };
  }, [selectedTaskId, diffs]);

  async function selectTask(taskId: string): Promise<void> {
    selectedRef.current = taskId;
    setSelectedTaskId(taskId);
    setSelectedFile(null);
    setTicket(null);
    await loadDrilldown(taskId);
  }

  async function postDirector(message: string): Promise<void> {
    setChatNotice(null);
    try {
      const response = await fetch("/api/director/message", {
        method: "POST",
        headers: jsonHeaders(csrfToken),
        body: JSON.stringify({ message }),
      });
      const payload = (await response.json()) as { message?: DirectorMessageView; error?: string };
      if (!response.ok) {
        setChatNotice(payload.error ?? `director request failed with status ${response.status}`);
        return;
      }
      if (payload.message !== undefined) {
        const sent = payload.message;
        setMessages((current) => (current.some((entry) => entry.seq === sent.seq) ? current : [...current, sent]));
      }
      if (response.status === 202) setChatNotice("Director is thinking…");
      await refreshBoard();
    } catch (err) {
      setChatNotice(`director request failed: ${(err as Error).message}`);
    }
  }

  async function mintTicket(taskId: string): Promise<void> {
    try {
      const response = await fetch(`/api/approvals/${encodeURIComponent(taskId)}/ticket`, {
        method: "POST",
        headers: jsonHeaders(csrfToken),
        body: "{}",
      });
      const payload = (await response.json()) as ApprovalTicketView & { error?: string };
      if (!response.ok) {
        setBoardError(`fleet app: ticket refused: ${payload.error ?? response.status}`);
        return;
      }
      setTicket(payload);
    } catch (err) {
      setBoardError(`fleet app: ticket request failed: ${(err as Error).message}`);
    }
  }

  const drilldown = snapshot.drilldown;
  const additions = diffs.reduce((sum, hunk) => sum + hunk.additions, 0);
  const deletions = diffs.reduce((sum, hunk) => sum + hunk.deletions, 0);
  const selectedCard = snapshot.tasks.find((task) => task.id === selectedTaskId);
  const lastMessage = messages.at(-1);
  const thinking = chatNotice === "Director is thinking…" && lastMessage?.author === "human";

  return (
    <div style={{ backgroundColor: palette.appBg, color: palette.text, minHeight: "100vh" }}>
      <style>{"*:focus-visible { outline: 2px solid #8ab8ff; outline-offset: 2px; }"}</style>
      <header style={{ display: "flex", alignItems: "center", gap: 12, padding: "12px 16px", borderBottom: `1px solid ${palette.panelBorder}` }}>
        <h1 style={{ fontSize: 18, margin: 0 }}>Fleet Control Plane</h1>
        <span style={{ ...mutedStyle() }} data-testid="app-tier">
          {snapshot.activeTier}
        </span>
        <span style={{ ...mutedStyle() }} data-testid="app-approvals">
          {approvals === undefined ? "" : approvals.available ? `approvals: key ${approvals.fingerprint?.slice(0, 12) ?? ""}…` : "approvals disabled"}
        </span>
        <span style={{ marginLeft: "auto", display: "flex", gap: 8 }}>
          <button type="button" data-testid="app-refresh-board" style={ghostButtonStyle()} onClick={() => void refreshBoard()}>
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
              selectedRef.current = null;
              setSelectedTaskId(null);
            }}
          />
          <SplitDiffViewer hunks={diffs} selectedFile={selectedFile} onSelectFile={setSelectedFile} />
          {selectedTaskId !== null && selectedCard?.column === "Waiting Approval / QA" ? (
            <ApprovalDrawer
              taskId={selectedTaskId}
              displayedSubjectHash={displayedSubjectHash}
              additions={additions}
              deletions={deletions}
              files={diffs.length}
              verdicts={gatesToVerdicts(drilldown?.stageGates ?? [])}
              ticket={ticket}
              unavailableReason={approvals !== undefined && !approvals.available ? approvals.reason : null}
              csrfToken={csrfToken}
              onMintTicket={() => void mintTicket(selectedTaskId)}
              onApproved={() => {
                setTicket(null);
                void refreshBoard();
              }}
              onRejected={() => {
                setTicket(null);
                void refreshBoard();
              }}
              onError={() => {
                setTicket(null);
              }}
            />
          ) : null}
        </main>
        <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
          <DirectorChat
            messages={messages}
            dock="right"
            onSend={(text) => void postDirector(text)}
            onInjectDag={(spec) => void postDirector(`/ship ${spec}`)}
          />
          {chatNotice !== null && (chatNotice !== "Director is thinking…" || thinking) ? (
            <p data-testid="director-notice" style={{ ...mutedStyle(), margin: 0 }}>
              {chatNotice}
            </p>
          ) : null}
        </div>
      </div>
    </div>
  );
}

export default App;
