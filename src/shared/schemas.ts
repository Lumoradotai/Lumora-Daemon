import { z } from "zod";

// --- Agent type enum ---

// "cli" is not an AI agent — it's the onchainos CLI executor used to run
// deterministic data commands directly (fast, no tokens) instead of through an
// AI agent. It is never a selectable *default* agent for agentic messages.
export const AgentType = z.enum(["claw", "codex", "claude_code", "cli"]);

// --- Command ---

export const CommandKind = z.enum(["agent.message"]);

export const CommandStatus = z.enum(["accepted", "rejected", "scheduled"]);

export const Command = z.object({
  id: z.string().uuid(),
  ownerId: z.string(),
  machineId: z.string(),
  kind: CommandKind,
  agentType: AgentType.optional(),
  params: z.unknown(),
  idempotencyKey: z.string().optional(),
  status: CommandStatus,
  createdAt: z.string().datetime(),
});

// --- Task ---

export const TaskStatus = z.enum([
  "queued",
  "claimed",
  "running",
  "succeeded",
  "failed",
  "timed_out",
  "cancelled",
  "lost",
  "result_submit_failed",
]);

export const Task = z.object({
  id: z.string().uuid(),
  commandId: z.string().uuid(),
  ownerId: z.string(),
  machineId: z.string(),
  agentType: AgentType.optional(),
  executor: z.literal("agent_runtime"),
  sessionId: z.string().optional(),
  workspace: z.string().optional(),
  status: TaskStatus,
  claimId: z.string().uuid().optional(),
  daemonId: z.string().optional(),
  timeoutSec: z.number().int().positive().optional(),
  createdAt: z.string().datetime(),
  claimedAt: z.string().datetime().optional(),
  startedAt: z.string().datetime().optional(),
  finishedAt: z.string().datetime().optional(),
  metadata: z.record(z.unknown()).optional(),
});

// --- Task Result ---

export const TaskFinalStatus = z.enum([
  "succeeded",
  "failed",
  "timed_out",
  "cancelled",
]);

export const Artifact = z.object({
  name: z.string(),
  path: z.string().optional(),
  mimeType: z.string().optional(),
  sizeBytes: z.number().int().nonnegative().optional(),
  metadata: z.record(z.unknown()).optional(),
});

export const TaskResult = z.object({
  taskId: z.string().uuid(),
  finalStatus: TaskFinalStatus,
  texts: z.array(z.string()),
  artifacts: z.array(Artifact).default([]),
  raw: z.unknown().optional(),
  durationMs: z.number().nonnegative().nullable().optional(),
  provider: z.string().nullable().optional(),
  model: z.string().nullable().optional(),
  usage: z.record(z.number()).nullable().optional(),
  aborted: z.boolean().optional(),
  stopReason: z.string().nullable().optional(),
  parseError: z.string().nullable().optional(),
  timeoutReason: z.string().nullable().optional(),
});

// --- Task Event ---

export const TaskEventType = z.enum([
  "command.accepted",
  "task.queued",
  "task.claimed",
  "task.running",
  "task.heartbeat",
  "task.result_ready",
  "task.lost",
  "daemon.online",
  "daemon.offline",
  "machine.capabilities_updated",
]);

export const TaskEvent = z.object({
  id: z.string().uuid(),
  taskId: z.string().uuid().optional(),
  machineId: z.string().optional(),
  daemonId: z.string().optional(),
  eventType: TaskEventType,
  payload: z.unknown().optional(),
  createdAt: z.string().datetime(),
});

// --- Heartbeats ---

export const DaemonHeartbeat = z.object({
  daemonId: z.string(),
  machineId: z.string(),
  ownerId: z.string(),
  capabilities: z.unknown().optional(),
  reportedAt: z.string().datetime(),
});

export const TaskHeartbeat = z.object({
  taskId: z.string().uuid(),
  daemonId: z.string(),
  claimId: z.string().uuid(),
  reportedAt: z.string().datetime(),
});

// --- Runtime Capability ---

export const RuntimeCapability = z.object({
  agentTypes: z.array(AgentType).default([]),
  version: z.string().optional(),
  commands: z.array(z.string()).default([]),
  workspaceRoots: z.array(z.string()).optional(),
  available: z.boolean(),
});

export type RuntimeCapabilityValue = z.infer<typeof RuntimeCapability>;

// --- Detected Runtime ---

export const DetectedRuntime = z.object({
  id: z.string(),
  name: z.string(),
  installed: z.boolean(),
  ready: z.boolean(),
  version: z.string().optional(),
  extras: z.record(z.unknown()).optional(),
});

// --- Runtime Adapter (type-only, not a schema) ---

export interface RuntimeHooks {
  onHeartbeat: () => Promise<void>;
  onProgress?: (message: string) => void;
}

export interface RuntimeAdapter<P = unknown, R = z.infer<typeof TaskResult>> {
  agentType: z.infer<typeof AgentType>;
  supportedCommands: string[];
  detect(): Promise<z.infer<typeof RuntimeCapability>>;
  run(task: z.infer<typeof Task>, params: P, hooks: RuntimeHooks): Promise<R>;
  cancel?(taskId: string): Promise<void>;
}

// --- API request/response schemas for backend endpoints ---

export const CreateCommandRequest = z.object({
  kind: CommandKind,
  machineId: z.string().min(1),
  agentType: AgentType.optional(),
  params: z.unknown(),
  idempotencyKey: z.string().optional(),
}).superRefine((value, ctx) => {
  if (!value.agentType) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["agentType"], message: "agentType is required" });
  }
});

export const PollTasksRequest = z.object({
  machineId: z.string().optional(),
  daemonId: z.string(),
  capabilities: RuntimeCapability,
  limit: z.number().int().positive().max(10).default(1),
  // Long-poll: hold the request open up to `wait` ms until a task is available
  // (capped server-side). Omitted/0 = return immediately. Backward compatible —
  // older daemons that don't send it keep the immediate-return behavior.
  wait: z.number().int().nonnegative().max(60_000).optional(),
});

export const ClaimTaskRequest = z.object({
  taskId: z.string().uuid(),
  daemonId: z.string(),
  machineId: z.string().optional(),
});

export const SubmitResultRequest = z.object({
  taskId: z.string().uuid(),
  daemonId: z.string(),
  claimId: z.string().uuid(),
  result: TaskResult,
});

export const ResultSubmitFailedRequest = z.object({
  taskId: z.string().uuid(),
  daemonId: z.string(),
  claimId: z.string().uuid(),
  reason: z.string().max(1000).optional(),
});

export const TaskHeartbeatRequest = z.object({
  taskId: z.string().uuid(),
  daemonId: z.string(),
  claimId: z.string().uuid(),
});

export const DaemonHeartbeatRequest = z.object({
  daemonId: z.string(),
  machineId: z.string().optional(),
  capabilities: RuntimeCapability.optional(),
  detectedRuntimes: z.array(DetectedRuntime).optional(),
});
