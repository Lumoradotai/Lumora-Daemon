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
const DEFAULT_TIMEOUT_SEC = 60;

export interface CodexAdapterOptions {
  binPath: string;
  defaults?: {
    model?: string;
    approvalMode?: "suggest" | "auto-edit" | "full-auto";
    provider?: string;
  };
  workspaceAllowlist?: string[];
}

export interface CodexParams {
  message: string;
  model?: string;
  approvalMode?: "suggest" | "auto-edit" | "full-auto";
  provider?: string;
  timeoutSeconds?: number;
}

export class CodexAdapter implements RuntimeAdapter<CodexParams> {
  readonly agentType = "codex" as const;
  readonly supportedCommands = ["agent.message"];

  constructor(private opts: CodexAdapterOptions) {}

  async detect(): Promise<RuntimeCapability> {
    try {
      const { exitCode } = await execa(this.opts.binPath, ["--version"], {
        timeout: 5_000,
        reject: false,
      });
      return {
        agentTypes: exitCode === 0 ? ["codex"] : [],
        commands: exitCode === 0 ? ["agent.message"] : [],
        available: exitCode === 0,
      };
    } catch {
      return { agentTypes: [], commands: [], available: false };
    }
  }

  async run(task: Task, params: CodexParams, hooks: RuntimeHooks): Promise<TaskResult> {
    this.validate(task, params);

    const args = this.buildArgs(params);
    const timeoutSec = params.timeoutSeconds ?? task.timeoutSec ?? DEFAULT_TIMEOUT_SEC;
    const timeoutMs = (timeoutSec + 30) * 1000;

    const heartbeatInterval = setInterval(() => {
      hooks.onHeartbeat().catch(() => {});
    }, 30_000);

    try {
      hooks.onProgress?.("starting codex agent");

      const { stdout, stderr, exitCode } = await execa(this.opts.binPath, args, {
        timeout: timeoutMs,
        reject: false,
        cwd: task.workspace ?? undefined,
        env: { ...process.env, NO_COLOR: "1" },
        // codex `exec` reads "additional input from stdin" even when a prompt
        // arg is given. If stdin is a non-TTY fd that never EOFs (as can happen
        // when the daemon runs in the background or under a process manager),
        // codex blocks forever and the task stays "running". `input: ""` forces
        // an explicit empty, immediately-closed stdin pipe so codex always gets
        // EOF — strictly more robust than `stdin: "ignore"` (/dev/null).
        input: "",
      });

      const boundedStdout = stdout.slice(0, MAX_OUTPUT_LENGTH);
      const boundedStderr = stderr.slice(0, MAX_OUTPUT_LENGTH);

      if (!boundedStdout.trim()) {
        return {
          taskId: task.id,
          finalStatus: exitCode === 0 ? "succeeded" : "failed",
          texts: [boundedStderr.trim() || (exitCode === 0 ? "" : `Codex exited with code ${exitCode} and no output`)].filter(Boolean),
          artifacts: [],
        };
      }

      return this.parseResult(task.id, boundedStdout.trim(), exitCode ?? 1);
    } catch (err) {
      const message = (err as Error).message;
      if (message.includes("timed out")) {
        return {
          taskId: task.id,
          finalStatus: "timed_out",
          texts: [`Codex timed out after ${timeoutSec}s`],
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

  private validate(task: Task, params: CodexParams) {
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

  private buildArgs(params: CodexParams): string[] {
    const merged = { ...this.opts.defaults, ...stripUndefined(params) };
    const args = ["exec", "--json", "--color", "never", "--skip-git-repo-check"];
    if (merged.model) args.push("--model", merged.model);
    if (merged.approvalMode === "full-auto") {
      args.push("--dangerously-bypass-approvals-and-sandbox");
    } else if (merged.approvalMode === "auto-edit") {
      args.push("--sandbox", "workspace-write");
    } else {
      args.push("--sandbox", "read-only");
    }
    args.push(merged.message);
    return args;
  }

  private parseResult(taskId: string, raw: string, exitCode: number): TaskResult {
    const lines = raw.split("\n").filter(Boolean);
    const events: any[] = [];
    for (const line of lines) {
      try { events.push(JSON.parse(line)); } catch { /* skip non-JSON lines */ }
    }

    if (events.length === 0) {
      return {
        taskId,
        finalStatus: exitCode === 0 ? "succeeded" : "failed",
        texts: [raw],
        artifacts: [],
      };
    }

    const texts: string[] = [];
    const errors: string[] = [];
    let model: string | null = null;
    let usage: Record<string, number> | null = null;

    for (const ev of events) {
      if (ev.type === "item.completed" && ev.item?.type === "agent_message" && typeof ev.item.text === "string") {
        texts.push(ev.item.text);
      }
      if (ev.type === "item.completed" && ev.item?.type === "command_execution" && ev.item.status === "completed" && ev.item.aggregated_output) {
        texts.push(ev.item.aggregated_output);
      }
      if (ev.type === "message" && ev.role === "assistant" && typeof ev.content === "string") {
        texts.push(ev.content);
      }
      // codex surfaces failures as standalone `error` events and `turn.failed`
      // events (e.g. usage limits, auth failures). Capture their messages so we
      // report a clean reason instead of dumping raw JSONL.
      if (ev.type === "error" && typeof ev.message === "string") {
        errors.push(ev.message);
      }
      if (ev.type === "turn.failed" && typeof ev.error?.message === "string") {
        errors.push(ev.error.message);
      }
      if (ev.model) model = ev.model;
      if (ev.usage && typeof ev.usage === "object") {
        usage = usage ?? {};
        for (const [k, v] of Object.entries(ev.usage)) {
          if (typeof v === "number") usage[k] = (usage[k] ?? 0) + v;
        }
      }
    }

    // A reported error means the turn failed even if the process exited 0.
    const failed = exitCode !== 0 || errors.length > 0;

    if (texts.length === 0) {
      if (errors.length > 0) {
        texts.push(...dedupe(errors));
      } else {
        const lastEvent = events[events.length - 1];
        if (lastEvent?.item?.text) texts.push(String(lastEvent.item.text));
        else if (lastEvent?.content) texts.push(String(lastEvent.content));
        else texts.push(raw);
      }
    }

    return {
      taskId,
      finalStatus: failed ? "failed" : "succeeded",
      texts,
      artifacts: [],
      raw: events,
      model,
      usage,
    };
  }
}

function stripUndefined<T extends Record<string, any>>(value: T): T {
  return Object.fromEntries(Object.entries(value).filter(([, v]) => v !== undefined)) as T;
}

function dedupe(values: string[]): string[] {
  return [...new Set(values)];
}
