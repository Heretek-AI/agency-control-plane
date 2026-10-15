import { z } from "zod";

/**
 * Task and Mission shapes for the Fleet Dispatcher Daemon.
 *
 * A Task carries its dependency gate (`strategy`: `all_success` requires
 * every dep to be `done`; `one_success` requires at least one `done`),
 * its file footprint (`input.paths` plus the optional `owner` path list
 * used by the Kanban owned-path chips), and its retry policy.
 *
 * Status lifecycle: `backlog` / `pending` -> `ready` -> `running` ->
 * `done` | `failed` | `cancelled`. `waitingHuman` parks a task for a human
 * decision: such tasks never start and never force downstream cancellation.
 */

export const TaskKindSchema = z.enum(["expert-run", "verify", "land", "human"]);

export const TaskStrategySchema = z.enum(["all_success", "one_success"]);

export const TaskStatusSchema = z.enum([
  "backlog",
  "pending",
  "ready",
  "running",
  "waitingHuman",
  "done",
  "failed",
  "cancelled",
]);

export const TaskPolicySchema = z.union([
  z.object({ strategy: z.literal("fail") }),
  z.object({ strategy: z.literal("retry"), maxAttempts: z.number().int().min(1) }),
  z.object({ strategy: z.literal("replan") }),
]);

export const TaskInputSchema = z.object({
  objective: z.string().min(1),
  context: z.string().optional(),
  constraints: z.string().optional(),
  acceptance: z.array(z.string()).default([]),
  paths: z.array(z.string()).default([]),
  base: z.string().optional(),
});

export const TaskSchema = z.object({
  id: z.string().min(1),
  missionId: z.string().min(1),
  repo: z.string().min(1).optional(),
  title: z.string().min(1).optional(),
  kind: TaskKindSchema,
  role: z.string().min(1).optional(),
  expert: z.string().min(1).optional(),
  deps: z.array(z.string()).default([]),
  strategy: TaskStrategySchema.default("all_success"),
  trigger: TaskStrategySchema.optional(),
  input: TaskInputSchema,
  owner: z.array(z.string()).default([]),
  policy: TaskPolicySchema.default({ strategy: "fail" }),
  status: TaskStatusSchema,
  attempts: z.number().int().min(0).default(0),
  reason: z.string().optional(),
  result: z.unknown().optional(),
  sessionId: z.string().optional(),
  branch: z.string().optional(),
  worktree: z.string().optional(),
  headSha: z.string().optional(),
  landedSha: z.string().optional(),
});

export const MissionStatusSchema = z.enum([
  "planning",
  "waitingHuman",
  "running",
  "paused",
  "halted",
  "done",
  "failed",
  "cancelled",
]);

export const MissionSchema = z.object({
  id: z.string().min(1),
  repo: z.string().min(1).optional(),
  source: z.enum(["chat", "api", "github", "schedule"]).optional(),
  sourceRef: z.string().optional(),
  playbook: z.string().min(1).optional(),
  objective: z.string().min(1),
  priority: z.number().int().default(0),
  status: MissionStatusSchema,
  tasks: z.array(TaskSchema).default([]),
  decisions: z.array(z.unknown()).default([]),
  directorSessionId: z.string().optional(),
  integrationBranch: z.string().min(1).optional(),
  baseSha: z.string().min(1).optional(),
  pausedUntil: z.string().optional(),
  createdAt: z.string().optional(),
  updatedAt: z.string().optional(),
});

export const ApprovalTicketSchema = z.object({
  ticketId: z.string().min(1),
  taskId: z.string().min(1),
  subjectHash: z.string().min(1),
  issuedAt: z.string(),
  expiresAt: z.string(),
  used: z.boolean().default(false),
});

export type TaskKind = z.infer<typeof TaskKindSchema>;
export type TaskStrategy = z.infer<typeof TaskStrategySchema>;
export type TaskStatus = z.infer<typeof TaskStatusSchema>;
export type TaskPolicy = z.infer<typeof TaskPolicySchema>;
export type TaskInput = z.infer<typeof TaskInputSchema>;
export type Task = z.infer<typeof TaskSchema>;
export type MissionStatus = z.infer<typeof MissionStatusSchema>;
export type Mission = z.infer<typeof MissionSchema>;
export type ApprovalTicket = z.infer<typeof ApprovalTicketSchema>;

/**
 * Status constants. Every other module compares through these so the
 * `waitingHuman` literal lives in exactly one place.
 */
export const TaskStatuses = {
  backlog: "backlog",
  pending: "pending",
  ready: "ready",
  running: "running",
  waitingHuman: "waitingHuman",
  done: "done",
  failed: "failed",
  cancelled: "cancelled",
} as const satisfies Record<string, TaskStatus>;

/** Mission status constants; see TaskStatuses above. */
export const MissionStatuses = {
  planning: "planning",
  waitingHuman: "waitingHuman",
  running: "running",
  paused: "paused",
  halted: "halted",
  done: "done",
  failed: "failed",
  cancelled: "cancelled",
} as const satisfies Record<string, MissionStatus>;

/**
 * Effective dependency gate for a task. `trigger` is accepted as a legacy
 * alias for `strategy` and wins when both are present so salvaged graphs
 * keep their exact semantics.
 */
export function gateStrategy(task: Pick<Task, "strategy"> & { trigger?: TaskStrategy | undefined }): TaskStrategy {
  return task.trigger ?? task.strategy;
}
