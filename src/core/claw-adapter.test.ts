import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ClawAdapter } from "./claw-adapter.js";
import type { RuntimeHooks, Task } from "../shared/index.js";

const baseTask: Task = {
  id: "task-1",
  commandId: "command-1",
  ownerId: "owner-1",
  machineId: "machine-1",
  executor: "agent_runtime",
  agentType: "claw",
  status: "running",
  createdAt: "2026-05-27T00:00:00Z",
};

const hooks: RuntimeHooks = {
  onHeartbeat: async () => {},
};

describe("ClawAdapter routing validation", () => {
  it("requires local or one of agent/sessionId/to", async () => {
    const adapter = new ClawAdapter({ binPath: "openclaw" });

    await assert.rejects(
      adapter.run(baseTask, { message: "hello" }, hooks),
      /local, agent, sessionId, or to is required/,
    );
  });

  it("uses daemon default agent for message-only tasks", async () => {
    const fake = await createFakeOpenClaw();
    try {
      const adapter = new ClawAdapter({
        binPath: fake.binPath,
        defaults: { agent: "main" },
      });

      const result = await adapter.run(baseTask, { message: "hello" }, hooks);

      assert.equal(result.finalStatus, "succeeded");
      const args = JSON.parse(result.texts[0]) as string[];
      assert.deepEqual(args, ["agent", "--message", "hello", "--json", "--agent", "main"]);
    } finally {
      await fake.cleanup();
    }
  });
});

async function createFakeOpenClaw(): Promise<{ binPath: string; cleanup: () => Promise<void> }> {
  const dir = await mkdtemp(join(tmpdir(), "agent-dashboard-openclaw-"));
  const binPath = join(dir, "openclaw-fake.mjs");
  await writeFile(
    binPath,
    `#!/usr/bin/env node
const args = process.argv.slice(2);
console.log(JSON.stringify({
  payload: { payloads: [{ text: JSON.stringify(args) }] },
  meta: { durationMs: 1 }
}));
`,
  );
  await chmod(binPath, 0o755);
  return {
    binPath,
    cleanup: () => rm(dir, { recursive: true, force: true }),
  };
}
