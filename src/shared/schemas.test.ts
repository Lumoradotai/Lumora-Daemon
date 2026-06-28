import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  Command,
  Task,
  TaskResult,
  TaskEvent,
  DaemonHeartbeat,
  TaskHeartbeat,
  RuntimeCapability,
  CreateCommandRequest,
  PollTasksRequest,
  ClaimTaskRequest,
  SubmitResultRequest,
  ResultSubmitFailedRequest,
} from "./schemas.js";

describe("Command schema", () => {
  it("accepts a valid agent.message command", () => {
    const result = Command.safeParse({
      id: "550e8400-e29b-41d4-a716-446655440000",
      ownerId: "user-1",
      machineId: "machine-1",
      kind: "agent.message",
      agentType: "claw",
      params: { message: "hello" },
      status: "accepted",
      createdAt: "2026-05-24T00:00:00Z",
    });
    assert.ok(result.success);
  });

  it("rejects invalid kind", () => {
    const result = Command.safeParse({
      id: "550e8400-e29b-41d4-a716-446655440002",
      ownerId: "user-1",
      machineId: "machine-1",
      kind: "wallet.send",
      params: {},
      status: "accepted",
      createdAt: "2026-05-24T00:00:00Z",
    });
    assert.ok(!result.success);
  });

  it("rejects missing ownerId", () => {
    const result = Command.safeParse({
      id: "550e8400-e29b-41d4-a716-446655440003",
      kind: "agent.message",
      params: {},
      status: "accepted",
      createdAt: "2026-05-24T00:00:00Z",
    });
    assert.ok(!result.success);
  });
});

describe("Task schema", () => {
  it("accepts a valid queued task", () => {
    const result = Task.safeParse({
      id: "550e8400-e29b-41d4-a716-446655440010",
      commandId: "550e8400-e29b-41d4-a716-446655440000",
      ownerId: "user-1",
      machineId: "machine-1",
      executor: "agent_runtime",
      agentType: "claw",
      status: "queued",
      createdAt: "2026-05-24T00:00:00Z",
    });
    assert.ok(result.success);
  });

  it("accepts a claimed task with claimId and daemonId", () => {
    const result = Task.safeParse({
      id: "550e8400-e29b-41d4-a716-446655440010",
      commandId: "550e8400-e29b-41d4-a716-446655440000",
      ownerId: "user-1",
      machineId: "machine-1",
      executor: "agent_runtime",
      agentType: "claw",
      status: "claimed",
      claimId: "550e8400-e29b-41d4-a716-446655440099",
      daemonId: "daemon-1",
      createdAt: "2026-05-24T00:00:00Z",
      claimedAt: "2026-05-24T00:01:00Z",
    });
    assert.ok(result.success);
  });

  it("rejects invalid executor", () => {
    const result = Task.safeParse({
      id: "550e8400-e29b-41d4-a716-446655440010",
      commandId: "550e8400-e29b-41d4-a716-446655440000",
      ownerId: "user-1",
      machineId: "machine-1",
      executor: "tool_runtime",
      status: "queued",
      createdAt: "2026-05-24T00:00:00Z",
    });
    assert.ok(!result.success);
  });

  it("rejects invalid status", () => {
    const result = Task.safeParse({
      id: "550e8400-e29b-41d4-a716-446655440010",
      commandId: "550e8400-e29b-41d4-a716-446655440000",
      ownerId: "user-1",
      machineId: "machine-1",
      executor: "agent_runtime",
      status: "bogus",
      createdAt: "2026-05-24T00:00:00Z",
    });
    assert.ok(!result.success);
  });
});

describe("TaskResult schema", () => {
  it("accepts a valid succeeded result", () => {
    const result = TaskResult.safeParse({
      taskId: "550e8400-e29b-41d4-a716-446655440010",
      finalStatus: "succeeded",
      texts: ["Hello, world!"],
      artifacts: [],
      durationMs: 1200,
    });
    assert.ok(result.success);
  });

  it("accepts a result with artifacts", () => {
    const result = TaskResult.safeParse({
      taskId: "550e8400-e29b-41d4-a716-446655440010",
      finalStatus: "succeeded",
      texts: [],
      artifacts: [{ name: "output.txt", path: "/tmp/output.txt", mimeType: "text/plain", sizeBytes: 42 }],
    });
    assert.ok(result.success);
  });

  it("rejects invalid finalStatus", () => {
    const result = TaskResult.safeParse({
      taskId: "550e8400-e29b-41d4-a716-446655440010",
      finalStatus: "running",
      texts: [],
    });
    assert.ok(!result.success);
  });
});

describe("TaskEvent schema", () => {
  it("accepts a valid event", () => {
    const result = TaskEvent.safeParse({
      id: "550e8400-e29b-41d4-a716-446655440020",
      taskId: "550e8400-e29b-41d4-a716-446655440010",
      eventType: "task.claimed",
      createdAt: "2026-05-24T00:01:00Z",
    });
    assert.ok(result.success);
  });
});

describe("DaemonHeartbeat schema", () => {
  it("accepts a valid heartbeat", () => {
    const result = DaemonHeartbeat.safeParse({
      daemonId: "daemon-1",
      machineId: "machine-1",
      ownerId: "user-1",
      reportedAt: "2026-05-24T00:00:00Z",
    });
    assert.ok(result.success);
  });
});

describe("TaskHeartbeat schema", () => {
  it("accepts a valid task heartbeat", () => {
    const result = TaskHeartbeat.safeParse({
      taskId: "550e8400-e29b-41d4-a716-446655440010",
      daemonId: "daemon-1",
      claimId: "550e8400-e29b-41d4-a716-446655440099",
      reportedAt: "2026-05-24T00:01:30Z",
    });
    assert.ok(result.success);
  });
});

describe("RuntimeCapability schema", () => {
  it("accepts a full capability", () => {
    const result = RuntimeCapability.safeParse({
      agentTypes: ["claw", "claude_code"],
      version: "0.1.0",
      commands: ["agent.message", "wallet.send"],
      workspaceRoots: ["/home/user/workspace"],
      available: true,
    });
    assert.ok(result.success);
  });

  it("applies defaults for arrays", () => {
    const result = RuntimeCapability.safeParse({ available: true });
    assert.ok(result.success);
    assert.deepStrictEqual(result.data.agentTypes, []);
  });
});

describe("CreateCommandRequest", () => {
  it("accepts a valid request", () => {
    const result = CreateCommandRequest.safeParse({
      kind: "agent.message",
      machineId: "machine-1",
      agentType: "claw",
      params: { message: "hello" },
    });
    assert.ok(result.success);
  });

  it("rejects request without agentType", () => {
    const result = CreateCommandRequest.safeParse({
      kind: "agent.message",
      machineId: "machine-1",
      params: { message: "hello" },
    });
    assert.ok(!result.success);
  });

  it("rejects missing machineId", () => {
    const result = CreateCommandRequest.safeParse({
      kind: "agent.message",
      agentType: "claw",
      params: { message: "hello" },
    });
    assert.ok(!result.success);
  });
});

describe("PollTasksRequest", () => {
  it("accepts a valid request with defaults", () => {
    const result = PollTasksRequest.safeParse({
      machineId: "machine-1",
      daemonId: "daemon-1",
      capabilities: { agentTypes: ["claw"], available: true },
    });
    assert.ok(result.success);
    assert.strictEqual(result.data.limit, 1);
  });
});

describe("ClaimTaskRequest", () => {
  it("accepts a valid claim", () => {
    const result = ClaimTaskRequest.safeParse({
      taskId: "550e8400-e29b-41d4-a716-446655440010",
      daemonId: "daemon-1",
    });
    assert.ok(result.success);
  });
});

describe("SubmitResultRequest", () => {
  it("accepts a valid result submission", () => {
    const result = SubmitResultRequest.safeParse({
      taskId: "550e8400-e29b-41d4-a716-446655440010",
      daemonId: "daemon-1",
      claimId: "550e8400-e29b-41d4-a716-446655440099",
      result: {
        taskId: "550e8400-e29b-41d4-a716-446655440010",
        finalStatus: "succeeded",
        texts: ["done"],
        artifacts: [],
      },
    });
    assert.ok(result.success);
  });
});

describe("ResultSubmitFailedRequest", () => {
  it("accepts a valid result-submit-failed report", () => {
    const result = ResultSubmitFailedRequest.safeParse({
      taskId: "550e8400-e29b-41d4-a716-446655440010",
      daemonId: "daemon-1",
      claimId: "550e8400-e29b-41d4-a716-446655440099",
      reason: "backend rejected final result submission",
    });
    assert.ok(result.success);
  });
});
