export {
  // Enums
  AgentType,
  CommandKind,
  CommandStatus,
  TaskStatus,
  TaskFinalStatus,
  TaskEventType,

  // Core schemas
  Command,
  Task,
  TaskResult,
  Artifact,
  TaskEvent,
  DaemonHeartbeat,
  TaskHeartbeat,
  RuntimeCapability,
  DetectedRuntime,

  // API request schemas
  CreateCommandRequest,
  PollTasksRequest,
  ClaimTaskRequest,
  SubmitResultRequest,
  ResultSubmitFailedRequest,
  TaskHeartbeatRequest,
  DaemonHeartbeatRequest,
} from "./schemas.js";

export type {
  RuntimeHooks,
  RuntimeAdapter,
} from "./schemas.js";

// Re-export inferred types for convenience
import type { z } from "zod";
import type {
  Command as CommandSchema,
  Task as TaskSchema,
  TaskResult as TaskResultSchema,
  TaskEvent as TaskEventSchema,
  DaemonHeartbeat as DaemonHeartbeatSchema,
  TaskHeartbeat as TaskHeartbeatSchema,
  RuntimeCapability as RuntimeCapabilitySchema,
  DetectedRuntime as DetectedRuntimeSchema,
  Artifact as ArtifactSchema,
  CreateCommandRequest as CreateCommandRequestSchema,
  PollTasksRequest as PollTasksRequestSchema,
  ClaimTaskRequest as ClaimTaskRequestSchema,
  SubmitResultRequest as SubmitResultRequestSchema,
  ResultSubmitFailedRequest as ResultSubmitFailedRequestSchema,
  TaskHeartbeatRequest as TaskHeartbeatRequestSchema,
  DaemonHeartbeatRequest as DaemonHeartbeatRequestSchema,
} from "./schemas.js";

export type Command = z.infer<typeof CommandSchema>;
export type Task = z.infer<typeof TaskSchema>;
export type TaskResult = z.infer<typeof TaskResultSchema>;
export type TaskEvent = z.infer<typeof TaskEventSchema>;
export type DaemonHeartbeat = z.infer<typeof DaemonHeartbeatSchema>;
export type TaskHeartbeat = z.infer<typeof TaskHeartbeatSchema>;
export type RuntimeCapability = z.infer<typeof RuntimeCapabilitySchema>;
export type DetectedRuntime = z.infer<typeof DetectedRuntimeSchema>;
export type Artifact = z.infer<typeof ArtifactSchema>;
export type CreateCommandRequest = z.infer<typeof CreateCommandRequestSchema>;
export type PollTasksRequest = z.infer<typeof PollTasksRequestSchema>;
export type ClaimTaskRequest = z.infer<typeof ClaimTaskRequestSchema>;
export type SubmitResultRequest = z.infer<typeof SubmitResultRequestSchema>;
export type ResultSubmitFailedRequest = z.infer<typeof ResultSubmitFailedRequestSchema>;
export type TaskHeartbeatRequest = z.infer<typeof TaskHeartbeatRequestSchema>;
export type DaemonHeartbeatRequest = z.infer<typeof DaemonHeartbeatRequestSchema>;
