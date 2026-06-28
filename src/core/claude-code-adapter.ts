import { execa } from "execa";
import type {
  RuntimeAdapter,
  RuntimeHooks,
  RuntimeCapability,
  Task,
  TaskResult,
} from "../shared/index.js";

const MAX_PROMPT_LENGTH = 100_000;
const MAX_OUTPUT_LENGTH = 500_000;
const DEFAULT_TIMEOUT_SEC = 600;

export type ClaudeCodeApprovalMode = "default" | "full-auto";

export interface ClaudeCodeAdapterOptions {
  binPath: string;
  defaults?: {
    model?: string;
    maxTurns?: number;
    systemPrompt?: string;
    approvalMode?: ClaudeCodeApprovalMode;
  };
  workspaceAllowlist?: string[];
}

export interface ClaudeCodeParams {
  message: string;
  model?: string;
  maxTurns?: number;
  systemPrompt?: string;
  approvalMode?: ClaudeCodeApprovalMode;
  allowedTools?: string[];
  disallowedTools?: string[];
  timeoutSeconds?: number;
}

export class ClaudeCodeAdapter implements RuntimeAdapter<ClaudeCodeParams> {
  readonly agentType = "claude_code" as const;
  readonly supportedCommands = ["agent.message"];

  constructor(private opts: ClaudeCodeAdapterOptions) {}

  async detect(): Promise<RuntimeCapability> {
    try {
      const { exitCode } = await execa(this.opts.binPath, ["--version"], {
        timeout: 5_000,
        reject: false,
      });
      return {
        agentTypes: exitCode === 0 ? ["claude_code"] : [],
        commands: exitCode === 0 ? ["agent.message"] : [],
        available: exitCode === 0,
      };
    } catch {
      return { agentTypes: [], commands: [], available: false };
    }
  }

  async run(task: Task, params: ClaudeCodeParams, hooks: RuntimeHooks): Promise<TaskResult> {
    this.validate(task, params);

    const args = this.buildArgs(params);
    const timeoutSec = params.timeoutSeconds ?? task.timeoutSec ?? DEFAULT_TIMEOUT_SEC;
    const timeoutMs = (timeoutSec + 30) * 1000;

    const heartbeatInterval = setInterval(() => {
      hooks.onHeartbeat().catch(() => {});
    }, 30_000);

    try {
      hooks.onProgress?.("starting claude code agent");

      const { stdout, stderr, exitCode, signal, timedOut } = await execa(this.opts.binPath, args, {
        timeout: timeoutMs,
        reject: false,
        cwd: task.workspace ?? undefined,
        env: { ...process.env, NO_COLOR: "1" },
        stdin: "ignore",
      });

      const boundedStdout = stdout.slice(0, MAX_OUTPUT_LENGTH);
      const boundedStderr = stderr.slice(0, MAX_OUTPUT_LENGTH);

      // With `reject: false`, an execa timeout resolves (instead of throwing) with
      // `timedOut: true` after SIGTERM-ing the process — so the catch block below
      // never sees it. Surface it as a real timeout here, otherwise it gets
      // misreported as a confusing "exited with code 143 and no output".
      if (timedOut) {
        return {
          taskId: task.id,
          finalStatus: "timed_out",
          texts: [`Claude Code timed out after ${timeoutSec}s`],
          artifacts: [],
          timeoutReason: `exceeded ${timeoutSec}s`,
        };
      }

      if (!boundedStdout.trim()) {
        // Killed by a signal (daemon/OS terminated it) reports no exit code, so
        // name the signal instead of printing a misleading clean-exit code.
        const how = signal ? `was terminated by ${signal}` : `exited with code ${exitCode}`;
        return {
          taskId: task.id,
          finalStatus: "failed",
          texts: [boundedStderr.trim() || `Claude Code ${how} and produced no output`],
          artifacts: [],
        };
      }

      return this.parseResult(task.id, boundedStdout.trim());
    } catch (err) {
      const message = (err as Error).message;
      if (message.includes("timed out")) {
        return {
          taskId: task.id,
          finalStatus: "timed_out",
          texts: [`Claude Code timed out after ${timeoutSec}s`],
          artifacts: [],
          timeoutReason: `exceeded ${timeoutSec}s`,
        };
      }
      return {
        taskId: task.id,
        finalStatus: "failed",
        texts: [message],
        artifacts: [],
      };
    } finally {
      clearInterval(heartbeatInterval);
    }
  }

  async cancel?(_taskId: string): Promise<void> {}

  private validate(task: Task, params: ClaudeCodeParams) {
    if (!params.message) {
      throw new Error("message is required");
    }
    if (params.message.length > MAX_PROMPT_LENGTH) {
      throw new Error(`message exceeds max length (${MAX_PROMPT_LENGTH} chars)`);
    }
    if (task.workspace && this.opts.workspaceAllowlist?.length) {
      const allowed = this.opts.workspaceAllowlist.some((root) => task.workspace!.startsWith(root));
      if (!allowed) {
        throw new Error(`workspace ${task.workspace} is not in the allowlist`);
      }
    }
  }

  private buildArgs(params: ClaudeCodeParams): string[] {
    const merged = { ...this.opts.defaults, ...stripUndefined(params) };
    const args = ["-p", merged.message, "--output-format", "json"];
    if (merged.approvalMode === "full-auto") {
      args.push("--dangerously-skip-permissions");
      // Claude Code's bash/network sandbox blocks outbound traffic to any domain
      // not on its allow-list and, in headless `-p` mode, cannot prompt to add
      // one — so even the agent's own api.anthropic.com call gets blocked
      // ("403 Blocked by sandbox network policy"). Force the sandbox off for
      // trusted autonomous daemon runs. `--settings` merges over discovered
      // settings, overriding only `sandbox.enabled` and leaving model/auth intact.
      args.push("--settings", JSON.stringify({ sandbox: { enabled: false } }));
    }
    if (merged.model) args.push("--model", merged.model);
    if (merged.maxTurns != null) args.push("--max-turns", String(merged.maxTurns));
    if (merged.systemPrompt) args.push("--system-prompt", merged.systemPrompt);
    if (params.allowedTools?.length) {
      for (const t of params.allowedTools) args.push("--allowedTools", t);
    }
    if (params.disallowedTools?.length) {
      for (const t of params.disallowedTools) args.push("--disallowedTools", t);
    }
    return args;
  }

  private extractUsage(parsed: any): Record<string, number> | null {
    const u = parsed.usage;
    if (!u || typeof u !== "object") return null;
    const flat: Record<string, number> = {};
    if (typeof u.input_tokens === "number") flat.input_tokens = u.input_tokens;
    if (typeof u.output_tokens === "number") flat.output_tokens = u.output_tokens;
    if (typeof u.cache_read_input_tokens === "number") flat.cache_read_input_tokens = u.cache_read_input_tokens;
    if (typeof u.cache_creation_input_tokens === "number") flat.cache_creation_input_tokens = u.cache_creation_input_tokens;
    return Object.keys(flat).length > 0 ? flat : null;
  }

  private parseResult(taskId: string, raw: string): TaskResult {
    let parsed: any;
    try {
      parsed = JSON.parse(raw);
    } catch {
      return {
        taskId,
        finalStatus: "succeeded",
        texts: [raw],
        artifacts: [],
        parseError: "Non-JSON output from Claude Code",
      };
    }

    if (parsed.is_error) {
      return {
        taskId,
        finalStatus: "failed",
        texts: [parsed.result ?? "Claude Code returned an error"],
        artifacts: [],
        raw: parsed,
      };
    }

    const texts: string[] = [];
    if (typeof parsed.result === "string" && parsed.result) {
      texts.push(parsed.result);
    }

    const usage = this.extractUsage(parsed);

    return {
      taskId,
      finalStatus: "succeeded",
      texts,
      artifacts: [],
      raw: parsed,
      durationMs: parsed.duration_ms ?? null,
      model: Object.keys(parsed.modelUsage ?? {})[0] ?? null,
      usage,
    };
  }
}

function stripUndefined<T extends Record<string, any>>(value: T): T {
  return Object.fromEntries(Object.entries(value).filter(([, v]) => v !== undefined)) as T;
}
