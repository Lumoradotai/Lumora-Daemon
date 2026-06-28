import { execa } from "execa";
import type {
  RuntimeAdapter,
  RuntimeHooks,
  RuntimeCapability,
  Task,
  TaskResult,
} from "../shared/index.js";

const MAX_OUTPUT_LENGTH = 500_000;
const DEFAULT_TIMEOUT_SEC = 120;

export interface CliAdapterOptions {
  /** Path to the onchainos binary. */
  binPath: string;
  workspaceAllowlist?: string[];
}

export interface CliParams {
  /** Arguments passed verbatim to onchainos, e.g. ["wallet", "status"]. */
  argv: string[];
  timeoutSeconds?: number;
}

/**
 * Runs onchainos CLI commands directly — no AI agent in the loop.
 *
 * Data reads (wallet status, portfolio balances, …) are deterministic CLI
 * calls. Executing them through an AI agent is slow (the agent re-emits the
 * whole stdout token-by-token, ~90s and prone to timeouts) and costs tokens.
 * This adapter shells out to `onchainos` directly: a few seconds, no tokens,
 * clean JSON (no markdown fences).
 */
export class CliAdapter implements RuntimeAdapter<CliParams> {
  readonly agentType = "cli" as const;
  readonly supportedCommands = ["agent.message"];

  constructor(private opts: CliAdapterOptions) {}

  async detect(): Promise<RuntimeCapability> {
    try {
      const { exitCode } = await execa(this.opts.binPath, ["--version"], {
        timeout: 5_000,
        reject: false,
      });
      return {
        agentTypes: exitCode === 0 ? ["cli"] : [],
        commands: exitCode === 0 ? ["agent.message"] : [],
        available: exitCode === 0,
      };
    } catch {
      return { agentTypes: [], commands: [], available: false };
    }
  }

  async run(task: Task, params: CliParams, hooks: RuntimeHooks): Promise<TaskResult> {
    this.validate(task, params);

    const timeoutSec = params.timeoutSeconds ?? task.timeoutSec ?? DEFAULT_TIMEOUT_SEC;
    const timeoutMs = (timeoutSec + 15) * 1000;

    const heartbeatInterval = setInterval(() => {
      hooks.onHeartbeat().catch(() => {});
    }, 30_000);

    try {
      hooks.onProgress?.(`running onchainos ${params.argv.join(" ")}`);

      const { stdout, stderr, exitCode } = await execa(this.opts.binPath, params.argv, {
        timeout: timeoutMs,
        reject: false,
        cwd: task.workspace ?? undefined,
        env: { ...process.env, NO_COLOR: "1" },
        // onchainos is non-interactive here; ensure it never blocks on stdin.
        input: "",
      });

      const out = stdout.slice(0, MAX_OUTPUT_LENGTH).trim();
      const err = stderr.slice(0, MAX_OUTPUT_LENGTH).trim();

      if (exitCode === 0) {
        return { taskId: task.id, finalStatus: "succeeded", texts: out ? [out] : [], artifacts: [] };
      }
      return {
        taskId: task.id,
        finalStatus: "failed",
        // Prefer the CLI's own error text (often JSON on stdout), fall back to stderr.
        texts: [out || err || `onchainos exited with code ${exitCode}`],
        artifacts: [],
      };
    } catch (err) {
      const message = (err as Error).message;
      if (message.includes("timed out")) {
        return {
          taskId: task.id,
          finalStatus: "timed_out",
          texts: [`onchainos timed out after ${timeoutSec}s`],
          artifacts: [],
          timeoutReason: `exceeded ${timeoutSec}s`,
        };
      }
      return { taskId: task.id, finalStatus: "failed", texts: [message], artifacts: [] };
    } finally {
      clearInterval(heartbeatInterval);
    }
  }

  async cancel?(_taskId: string): Promise<void> {}

  private validate(task: Task, params: CliParams) {
    if (!Array.isArray(params.argv) || params.argv.length === 0) {
      throw new Error("argv is required");
    }
    if (params.argv.some((a) => typeof a !== "string")) {
      throw new Error("argv must be an array of strings");
    }
    if (task.workspace && this.opts.workspaceAllowlist?.length) {
      const allowed = this.opts.workspaceAllowlist.some((root) => task.workspace!.startsWith(root));
      if (!allowed) {
        throw new Error(`workspace ${task.workspace} is not in the allowlist`);
      }
    }
  }
}
