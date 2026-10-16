/**
 * Typed fleet UI store for the Wave 3 WebUI.
 *
 * Holds Kanban columns, task cards, DAG nodes/edges, the active
 * drill-down worker, cached diffs, and the active model tier. The store
 * is framework-agnostic vanilla TypeScript with subscribe/notify — it
 * has zero React dependencies so it stays testable under `bun test`
 * without a DOM.
 *
 * Security note (Invariant I1): this store NEVER holds secrets. There is
 * no human-secret, private-key, or ticket field anywhere in the state
 * shape, and the actions below reject unknown fields fail-closed. The
 * human approval secret lives only in the lexical closure inside
 * `web/src/security/approval-client.ts`.
 */

/** The five locked-in Kanban columns (Pillar 1). */
export type BoardColumn =
  | "Backlog"
  | "Ready"
  | "In Progress"
  | "Waiting Approval / QA"
  | "Done";

/** Ordered column layout for the board. */
export const BOARD_COLUMNS: readonly BoardColumn[] = [
  "Backlog",
  "Ready",
  "In Progress",
  "Waiting Approval / QA",
  "Done",
] as const;

/** Model-tier badge shown on every task card. */
export type ModelTier = "tier-1-opencode" | "tier-2-commercial" | "tier-3-local";

/** Docker Compose profile badge shown in the drill-down inspector. */
export type DockerProfile = "core" | "appsec" | "android" | "game" | "research";

export const DOCKER_PROFILES: readonly DockerProfile[] = [
  "core",
  "appsec",
  "android",
  "game",
  "research",
] as const;

export type StageGateStatus = "pending" | "running" | "pass" | "fail";

export type DiffStatus = "added" | "modified" | "deleted" | "renamed";

/** One Kanban task card: branch badge, owned-path chips, tier badge. */
export interface TaskCard {
  id: string;
  title: string;
  /** Worktree branch badge, e.g. `fleet/task-101`. */
  branch: string;
  /** Owned-path chips rendered on the card. */
  ownedPaths: string[];
  tier: ModelTier;
  column: BoardColumn;
}

export interface DagNode {
  id: string;
  label: string;
}

export interface DagEdge {
  from: string;
  to: string;
}

export interface StageGate {
  name: string;
  status: StageGateStatus;
}

/** One live SSE tool-call timeline entry (Pillar 3). */
export interface ToolEvent {
  seq: number;
  tool: string;
  input: string;
  output: string;
  timestamp: string;
}

/** Active drill-down worker inspected by Pillar 3. */
export interface DrilldownWorker {
  sessionId: string;
  taskId: string;
  status: string;
  tier: ModelTier;
  profile: DockerProfile;
  stageGates: StageGate[];
  toolStream: ToolEvent[];
  tokens: number;
  cost: number;
}

/** One per-file diff hunk rendered by Pillar 4. */
export interface DiffHunk {
  file: string;
  status: DiffStatus;
  additions: number;
  deletions: number;
  patch: string;
}

export interface FleetState {
  tasks: TaskCard[];
  dagNodes: DagNode[];
  dagEdges: DagEdge[];
  drilldown: DrilldownWorker | null;
  diffs: Record<string, DiffHunk[]>;
  activeTier: ModelTier;
}

export type FleetListener = (state: FleetState) => void;

export interface NewToolEvent {
  tool: string;
  input: string;
  output: string;
  timestamp?: string | undefined;
}

function isBoardColumn(value: string): value is BoardColumn {
  return (BOARD_COLUMNS as readonly string[]).includes(value);
}

function isModelTier(value: string): value is ModelTier {
  return value === "tier-1-opencode" || value === "tier-2-commercial" || value === "tier-3-local";
}

function isDockerProfile(value: string): value is DockerProfile {
  return (DOCKER_PROFILES as readonly string[]).includes(value);
}

function isStageGateStatus(value: string): value is StageGateStatus {
  return value === "pending" || value === "running" || value === "pass" || value === "fail";
}

function isDiffStatus(value: string): value is DiffStatus {
  return value === "added" || value === "modified" || value === "deleted" || value === "renamed";
}

function cloneState(state: FleetState): FleetState {
  return {
    tasks: state.tasks.map((task) => ({ ...task, ownedPaths: [...task.ownedPaths] })),
    dagNodes: state.dagNodes.map((node) => ({ ...node })),
    dagEdges: state.dagEdges.map((edge) => ({ ...edge })),
    drilldown:
      state.drilldown === null
        ? null
        : {
            ...state.drilldown,
            stageGates: state.drilldown.stageGates.map((gate) => ({ ...gate })),
            toolStream: state.drilldown.toolStream.map((event) => ({ ...event })),
          },
    diffs: Object.fromEntries(
      Object.entries(state.diffs).map(([taskId, hunks]) => [taskId, hunks.map((hunk) => ({ ...hunk }))]),
    ),
    activeTier: state.activeTier,
  };
}

export interface FleetStore {
  getState(): FleetState;
  subscribe(listener: FleetListener): () => void;
  upsertTask(card: TaskCard): void;
  moveCard(taskId: string, toColumn: BoardColumn): void;
  setDag(nodes: DagNode[], edges: DagEdge[]): void;
  setDrilldown(worker: DrilldownWorker | null): void;
  appendToolEvent(taskId: string, event: NewToolEvent): ToolEvent;
  setDiff(taskId: string, hunks: DiffHunk[]): void;
  setTier(tier: ModelTier): void;
  reset(): void;
}

function validateTaskCard(card: TaskCard): void {
  if (card.id.trim().length === 0) {
    throw new Error("fleet-store: task id must be a non-empty string");
  }
  if (card.title.trim().length === 0) {
    throw new Error(`fleet-store: task ${JSON.stringify(card.id)} title must be a non-empty string`);
  }
  if (card.branch.trim().length === 0) {
    throw new Error(`fleet-store: task ${JSON.stringify(card.id)} branch must be a non-empty string`);
  }
  if (!isBoardColumn(card.column)) {
    throw new Error(`fleet-store: task ${JSON.stringify(card.id)} has unknown column ${JSON.stringify(card.column)}`);
  }
  if (!isModelTier(card.tier)) {
    throw new Error(`fleet-store: task ${JSON.stringify(card.id)} has unknown tier ${JSON.stringify(card.tier)}`);
  }
  for (const path of card.ownedPaths) {
    if (path.trim().length === 0) {
      throw new Error(`fleet-store: task ${JSON.stringify(card.id)} has an empty owned path`);
    }
  }
}

function validateDrilldown(worker: DrilldownWorker): void {
  if (worker.sessionId.trim().length === 0) {
    throw new Error("fleet-store: drill-down sessionId must be a non-empty string");
  }
  if (worker.taskId.trim().length === 0) {
    throw new Error("fleet-store: drill-down taskId must be a non-empty string");
  }
  if (!isModelTier(worker.tier)) {
    throw new Error(`fleet-store: drill-down has unknown tier ${JSON.stringify(worker.tier)}`);
  }
  if (!isDockerProfile(worker.profile)) {
    throw new Error(`fleet-store: drill-down has unknown Docker profile ${JSON.stringify(worker.profile)}`);
  }
  if (!Number.isFinite(worker.tokens) || worker.tokens < 0) {
    throw new Error("fleet-store: drill-down tokens must be a non-negative number");
  }
  if (!Number.isFinite(worker.cost) || worker.cost < 0) {
    throw new Error("fleet-store: drill-down cost must be a non-negative number");
  }
  for (const gate of worker.stageGates) {
    if (gate.name.trim().length === 0) {
      throw new Error("fleet-store: stage gate name must be a non-empty string");
    }
    if (!isStageGateStatus(gate.status)) {
      throw new Error(`fleet-store: stage gate ${JSON.stringify(gate.name)} has unknown status`);
    }
  }
}

function validateDiffHunk(hunk: DiffHunk): void {
  if (hunk.file.trim().length === 0) {
    throw new Error("fleet-store: diff file must be a non-empty string");
  }
  if (!isDiffStatus(hunk.status)) {
    throw new Error(`fleet-store: diff ${JSON.stringify(hunk.file)} has unknown status`);
  }
  if (!Number.isInteger(hunk.additions) || hunk.additions < 0) {
    throw new Error(`fleet-store: diff ${JSON.stringify(hunk.file)} additions must be a non-negative integer`);
  }
  if (!Number.isInteger(hunk.deletions) || hunk.deletions < 0) {
    throw new Error(`fleet-store: diff ${JSON.stringify(hunk.file)} deletions must be a non-negative integer`);
  }
}

/**
 * Create an isolated fleet store. Each caller gets independent state;
 * listeners are notified synchronously after every mutation with a
 * defensive snapshot copy.
 */
export function createFleetStore(initial?: Partial<FleetState>): FleetStore {
  let state: FleetState = {
    tasks: initial?.tasks?.map((task) => ({ ...task, ownedPaths: [...task.ownedPaths] })) ?? [],
    dagNodes: initial?.dagNodes?.map((node) => ({ ...node })) ?? [],
    dagEdges: initial?.dagEdges?.map((edge) => ({ ...edge })) ?? [],
    drilldown: null,
    diffs: {},
    activeTier: initial?.activeTier ?? "tier-1-opencode",
  };
  if (initial?.drilldown !== undefined && initial.drilldown !== null) {
    validateDrilldown(initial.drilldown);
    state.drilldown = {
      ...initial.drilldown,
      stageGates: initial.drilldown.stageGates.map((gate) => ({ ...gate })),
      toolStream: initial.drilldown.toolStream.map((event) => ({ ...event })),
    };
  }
  if (initial?.diffs !== undefined) {
    for (const [taskId, hunks] of Object.entries(initial.diffs)) {
      for (const hunk of hunks) validateDiffHunk(hunk);
      state.diffs[taskId] = hunks.map((hunk) => ({ ...hunk }));
    }
  }
  for (const task of state.tasks) validateTaskCard(task);
  if (initial?.activeTier !== undefined && !isModelTier(initial.activeTier)) {
    throw new Error(`fleet-store: unknown initial tier ${JSON.stringify(initial.activeTier)}`);
  }
  const listeners = new Set<FleetListener>();

  function notify(): void {
    const snapshot = cloneState(state);
    for (const listener of listeners) {
      listener(snapshot);
    }
  }

  return {
    getState(): FleetState {
      return cloneState(state);
    },
    subscribe(listener: FleetListener): () => void {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    upsertTask(card: TaskCard): void {
      validateTaskCard(card);
      const index = state.tasks.findIndex((task) => task.id === card.id);
      const copy: TaskCard = { ...card, ownedPaths: [...card.ownedPaths] };
      if (index === -1) {
        state.tasks = [...state.tasks, copy];
      } else {
        state.tasks = state.tasks.map((task) => (task.id === card.id ? copy : task));
      }
      notify();
    },
    moveCard(taskId: string, toColumn: BoardColumn): void {
      if (!isBoardColumn(toColumn)) {
        throw new Error(`fleet-store: cannot move ${JSON.stringify(taskId)} to unknown column`);
      }
      const existing = state.tasks.find((task) => task.id === taskId);
      if (existing === undefined) {
        throw new Error(`fleet-store: cannot move unknown task ${JSON.stringify(taskId)}`);
      }
      state.tasks = state.tasks.map((task) => (task.id === taskId ? { ...task, column: toColumn } : task));
      notify();
    },
    setDag(nodes: DagNode[], edges: DagEdge[]): void {
      const ids = new Set(nodes.map((node) => node.id));
      for (const node of nodes) {
        if (node.id.trim().length === 0) {
          throw new Error("fleet-store: DAG node id must be a non-empty string");
        }
      }
      for (const edge of edges) {
        if (!ids.has(edge.from) || !ids.has(edge.to)) {
          throw new Error(
            `fleet-store: DAG edge ${JSON.stringify(edge.from)} -> ${JSON.stringify(edge.to)} references an unknown node`,
          );
        }
      }
      state.dagNodes = nodes.map((node) => ({ ...node }));
      state.dagEdges = edges.map((edge) => ({ ...edge }));
      notify();
    },
    setDrilldown(worker: DrilldownWorker | null): void {
      if (worker !== null) {
        validateDrilldown(worker);
        state.drilldown = {
          ...worker,
          stageGates: worker.stageGates.map((gate) => ({ ...gate })),
          toolStream: worker.toolStream.map((event) => ({ ...event })),
        };
      } else {
        state.drilldown = null;
      }
      notify();
    },
    appendToolEvent(taskId: string, event: NewToolEvent): ToolEvent {
      const worker = state.drilldown;
      if (worker === null) {
        throw new Error(`fleet-store: cannot append tool event, no drill-down worker is active`);
      }
      if (worker.taskId !== taskId) {
        throw new Error(
          `fleet-store: cannot append tool event for ${JSON.stringify(taskId)}, active drill-down is ${JSON.stringify(worker.taskId)}`,
        );
      }
      if (event.tool.trim().length === 0) {
        throw new Error("fleet-store: tool event tool name must be a non-empty string");
      }
      const logged: ToolEvent = {
        seq: worker.toolStream.length + 1,
        tool: event.tool,
        input: event.input,
        output: event.output,
        timestamp: event.timestamp ?? new Date().toISOString(),
      };
      state.drilldown = { ...worker, toolStream: [...worker.toolStream, logged] };
      notify();
      return { ...logged };
    },
    setDiff(taskId: string, hunks: DiffHunk[]): void {
      if (taskId.trim().length === 0) {
        throw new Error("fleet-store: diff task id must be a non-empty string");
      }
      for (const hunk of hunks) validateDiffHunk(hunk);
      state.diffs = { ...state.diffs, [taskId]: hunks.map((hunk) => ({ ...hunk })) };
      notify();
    },
    setTier(tier: ModelTier): void {
      if (!isModelTier(tier)) {
        throw new Error(`fleet-store: unknown model tier ${JSON.stringify(tier)}`);
      }
      state.activeTier = tier;
      notify();
    },
    reset(): void {
      state = { tasks: [], dagNodes: [], dagEdges: [], drilldown: null, diffs: {}, activeTier: "tier-1-opencode" };
      notify();
    },
  };
}

/** Tasks currently sitting in one board column, ordered by id. */
export function tasksInColumn(state: FleetState, column: BoardColumn): TaskCard[] {
  return state.tasks
    .filter((task) => task.column === column)
    .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}
