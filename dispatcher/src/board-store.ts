/**
 * Durable board state for the Fleet Dispatcher Daemon.
 *
 * Tasks, missions, Director chat messages, per-task worker session state
 * (stage gates + bounded tool log), and id counters live in one
 * `bun:sqlite` database with the same pragmas as the worktree register
 * (`busy_timeout = 15000`, WAL), so a dispatcher restart resumes the
 * board exactly where it stopped. Every row stores the zod-validated JSON
 * document; reads re-validate and fail closed on a corrupt row.
 */
import { Database } from "bun:sqlite";
import { TaskSchema, type Task } from "./model.js";
import { WORKTREE_PRAGMAS } from "./worktrees.js";

export interface StoredMission {
  id: string;
  objective: string;
  status: string;
  integrationBranch: string;
}

export interface StoredMessage {
  seq: number;
  author: string;
  text: string;
  timestamp: string;
  tasksCreated?: string[] | undefined;
}

export interface StoredSession {
  stageGates: Array<{ name: string; status: "pending" | "running" | "pass" | "fail" }>;
  toolLog: Array<{ seq: number; tool: string; input: string; output: string }>;
}

export interface BoardSnapshot {
  tasks: Task[];
  missions: StoredMission[];
  messages: StoredMessage[];
  sessions: Map<string, StoredSession>;
  counters: Map<string, number>;
}

/** Tool-log entries kept per task, oldest dropped first. */
export const TOOL_LOG_LIMIT = 500;

export class BoardStore {
  private readonly db: Database;

  constructor(dbPath: string) {
    this.db = new Database(dbPath);
    for (const pragma of WORKTREE_PRAGMAS) {
      this.db.exec(pragma);
    }
    this.db.exec(`CREATE TABLE IF NOT EXISTS board_tasks (id TEXT PRIMARY KEY, doc TEXT NOT NULL, updated_at TEXT NOT NULL);`);
    this.db.exec(`CREATE TABLE IF NOT EXISTS board_missions (id TEXT PRIMARY KEY, doc TEXT NOT NULL);`);
    this.db.exec(`CREATE TABLE IF NOT EXISTS board_messages (seq INTEGER PRIMARY KEY, doc TEXT NOT NULL);`);
    this.db.exec(`CREATE TABLE IF NOT EXISTS board_sessions (task_id TEXT PRIMARY KEY, doc TEXT NOT NULL);`);
    this.db.exec(`CREATE TABLE IF NOT EXISTS board_counters (name TEXT PRIMARY KEY, value INTEGER NOT NULL);`);
  }

  saveTask(task: Task): void {
    this.db
      .query(`INSERT OR REPLACE INTO board_tasks (id, doc, updated_at) VALUES (?, ?, ?)`)
      .run(task.id, JSON.stringify(task), new Date().toISOString());
  }

  saveMission(mission: StoredMission): void {
    this.db.query(`INSERT OR REPLACE INTO board_missions (id, doc) VALUES (?, ?)`).run(mission.id, JSON.stringify(mission));
  }

  saveMessage(message: StoredMessage): void {
    this.db.query(`INSERT OR REPLACE INTO board_messages (seq, doc) VALUES (?, ?)`).run(message.seq, JSON.stringify(message));
  }

  saveSession(taskId: string, session: StoredSession): void {
    const bounded: StoredSession = {
      stageGates: session.stageGates,
      toolLog: session.toolLog.slice(-TOOL_LOG_LIMIT),
    };
    this.db.query(`INSERT OR REPLACE INTO board_sessions (task_id, doc) VALUES (?, ?)`).run(taskId, JSON.stringify(bounded));
  }

  setCounter(name: string, value: number): void {
    this.db.query(`INSERT OR REPLACE INTO board_counters (name, value) VALUES (?, ?)`).run(name, value);
  }

  /** Load everything. A row that fails validation throws: never silently drop board state. */
  load(): BoardSnapshot {
    const tasks = (this.db.query(`SELECT id, doc FROM board_tasks ORDER BY id`).all() as Array<{ id: string; doc: string }>).map(
      (row) => {
        const parsed = TaskSchema.safeParse(JSON.parse(row.doc));
        if (!parsed.success) {
          throw new Error(`board store: task row ${JSON.stringify(row.id)} is corrupt: ${parsed.error.message}`);
        }
        return parsed.data;
      },
    );
    const missions = (this.db.query(`SELECT doc FROM board_missions ORDER BY id`).all() as Array<{ doc: string }>).map(
      (row) => JSON.parse(row.doc) as StoredMission,
    );
    const messages = (this.db.query(`SELECT doc FROM board_messages ORDER BY seq`).all() as Array<{ doc: string }>).map(
      (row) => JSON.parse(row.doc) as StoredMessage,
    );
    const sessions = new Map<string, StoredSession>();
    for (const row of this.db.query(`SELECT task_id, doc FROM board_sessions`).all() as Array<{ task_id: string; doc: string }>) {
      sessions.set(row.task_id, JSON.parse(row.doc) as StoredSession);
    }
    const counters = new Map<string, number>();
    for (const row of this.db.query(`SELECT name, value FROM board_counters`).all() as Array<{ name: string; value: number }>) {
      counters.set(row.name, row.value);
    }
    return { tasks, missions, messages, sessions, counters };
  }

  close(): void {
    this.db.close();
  }
}
