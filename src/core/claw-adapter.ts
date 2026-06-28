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

export interface ClawAdapterOptions {
  binPath: string;
  defaults?: {
    agent?: string;
    sessionId?: string;
    to?: string;
    local?: boolean;
  };
  workspaceAllowlist?: string[];
}

export interface ClawParams {
  message: string;
  agent?: string;
  sessionId?: string;
  to?: string;
  model?: string;
  thinking?: string;
  verbose?: string;
  channel?: string;
  replyTo?: string;
  replyChannel?: string;
  replyAccount?: string;
  deliver?: boolean;
  timeoutSeconds?: number;
  local?: boolean;
}

export class ClawAdapter implements RuntimeAdapter<ClawParams> {
  readonly agentType = "claw" as const;
  readonly supportedCommands = ["agent.message"];

  constructor(private opts: ClawAdapterOptions) {}

  async detect(): Promise<RuntimeCapability> {
    try {
      const { exitCode } = await execa(this.opts.binPath, ["--version"], {
        timeout: 5_000,
        reject: false,
      });
      return {
        agentTypes: exitCode === 0 ? ["claw"] : [],
        commands: exitCode === 0 ? ["agent.message"] : [],
        available: exitCode === 0,
      };
    } catch {
      return { agentTypes: [], commands: [], available: false };
    }
  }

  async run(task: Task, params: ClawParams, hooks: RuntimeHooks): Promise<TaskResult> {
    this.validate(task, params);

    const merged = { ...this.opts.defaults, ...stripUndefined(params) };
    const args = this.buildArgs(merged);
    const timeoutSec = params.timeoutSeconds ?? task.timeoutSec ?? DEFAULT_TIMEOUT_SEC;
    const timeoutMs = (timeoutSec + 30) * 1000;

    const heartbeatInterval = setInterval(() => {
      hooks.onHeartbeat().catch(() => {});
    }, 30_000);

    try {
      hooks.onProgress?.("starting openclaw agent");

      const { stdout, stderr, exitCode, signal, timedOut } = await execa(this.opts.binPath, args, {
        timeout: timeoutMs,
        reject: false,
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
          texts: [`OpenClaw timed out after ${timeoutSec}s`],
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
          texts: [boundedStderr.trim() || `OpenClaw ${how} and produced no output`],
          artifacts: [],
        };
      }

      const parsed = parseJsonOutput(boundedStdout.trim());
      if (!parsed) {
        return {
          taskId: task.id,
          finalStatus: "failed",
          texts: [`Non-JSON output: ${boundedStdout.trim().slice(0, 1000)}`],
          artifacts: [],
          parseError: "Failed to parse OpenClaw JSON output",
        };
      }

      return this.normalizeResult(task.id, parsed);
    } catch (err) {
      const message = (err as Error).message;
      if (message.includes("timed out")) {
        return {
          taskId: task.id,
          finalStatus: "timed_out",
          texts: [`OpenClaw timed out after ${timeoutSec}s`],
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

  async cancel?(_taskId: string): Promise<void> {
    // TODO: signal kill to running child process
  }

  private validate(task: Task, params: ClawParams) {
    if (!params.message) {
      throw new Error("message is required");
    }
    if (params.message.length > MAX_PROMPT_LENGTH) {
      throw new Error(`message exceeds max length (${MAX_PROMPT_LENGTH} chars)`);
    }

    const merged = { ...this.opts.defaults, ...stripUndefined(params) };
    if (!merged.local && !merged.agent && !merged.sessionId && !merged.to) {
      throw new Error("local, agent, sessionId, or to is required");
    }

    if (task.workspace && this.opts.workspaceAllowlist?.length) {
      const resolved = task.workspace;
      const allowed = this.opts.workspaceAllowlist.some((root) => resolved.startsWith(root));
      if (!allowed) {
        throw new Error(`workspace ${resolved} is not in the allowlist`);
      }
    }
  }

  private buildArgs(params: ClawParams): string[] {
    const args = ["agent", "--message", params.message, "--json"];
    if (params.agent) args.push("--agent", params.agent);
    if (params.sessionId) args.push("--session-id", params.sessionId);
    if (params.to) args.push("--to", params.to);
    if (params.model) args.push("--model", params.model);
    if (params.thinking) args.push("--thinking", params.thinking);
    if (params.verbose) args.push("--verbose", params.verbose);
    if (params.channel) args.push("--channel", params.channel);
    if (params.replyTo) args.push("--reply-to", params.replyTo);
    if (params.replyChannel) args.push("--reply-channel", params.replyChannel);
    if (params.replyAccount) args.push("--reply-account", params.replyAccount);
    if (params.timeoutSeconds != null) args.push("--timeout", String(params.timeoutSeconds));
    if (params.deliver) args.push("--deliver");
    if (params.local) args.push("--local");
    return args;
  }

  private normalizeResult(taskId: string, raw: any): TaskResult {
    if (raw?.ok === false) {
      return {
        taskId,
        finalStatus: "failed",
        texts: [raw.error?.message ?? raw.error ?? "OpenClaw agent message failed"],
        artifacts: [],
        raw,
      };
    }

    const result = raw?.result ?? raw;
    const payloadContainer = raw?.payload ?? result?.payload ?? result;
    const payloads: any[] = Array.isArray(payloadContainer?.payloads)
      ? payloadContainer.payloads
      : Array.isArray(result?.payloads)
        ? result.payloads
        : [];

    const texts = payloads
      .map((p: any) => (typeof p?.text === "string" ? p.text : ""))
      .filter(Boolean);

    const meta = result?.meta ?? raw?.meta;
    if (texts.length === 0 && typeof meta?.finalAssistantVisibleText === "string" && meta.finalAssistantVisibleText) {
      texts.push(meta.finalAssistantVisibleText);
    }

    const artifacts = extractArtifacts(payloads);

    const flatUsage = flattenUsage(meta?.agentMeta?.usage ?? meta?.usage);

    return {
      taskId,
      finalStatus: "succeeded",
      texts,
      artifacts,
      raw,
      durationMs: meta?.durationMs ?? undefined,
      model: meta?.agentMeta?.model ?? meta?.model ?? undefined,
      provider: meta?.agentMeta?.provider ?? meta?.provider ?? undefined,
      usage: flatUsage,
    };
  }
}

function flattenUsage(u: unknown): Record<string, number> | undefined {
  if (!u || typeof u !== "object") return undefined;
  const flat: Record<string, number> = {};
  for (const [k, v] of Object.entries(u as Record<string, unknown>)) {
    if (typeof v === "number") flat[k] = v;
  }
  return Object.keys(flat).length > 0 ? flat : undefined;
}

function extractArtifacts(payloads: any[]): Array<{ name: string; path?: string; mimeType?: string }> {
  const artifacts: Array<{ name: string; path?: string; mimeType?: string }> = [];
  for (const p of payloads) {
    if (p?.artifacts && Array.isArray(p.artifacts)) {
      for (const a of p.artifacts) {
        if (a?.name) {
          artifacts.push({
            name: a.name,
            path: a.path,
            mimeType: a.mimeType ?? a.mime_type,
          });
        }
      }
    }
  }
  return artifacts;
}

function stripUndefined<T extends Record<string, any>>(value: T): T {
  return Object.fromEntries(Object.entries(value).filter(([, v]) => v !== undefined)) as T;
}

function parseJsonOutput(s: string): any | null {
  try {
    return JSON.parse(s);
  } catch {
    return extractLastJson(s);
  }
}

function extractLastJson(s: string): any | null {
  let depth = 0;
  let start = -1;
  let inString = false;
  let escaped = false;
  let lastValid: string | null = null;

  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (inString) {
      if (escaped) { escaped = false; }
      else if (c === "\\") { escaped = true; }
      else if (c === "\"") { inString = false; }
      continue;
    }
    if (c === "\"") { inString = true; }
    else if (c === "{") { if (depth === 0) start = i; depth++; }
    else if (c === "}") {
      depth--;
      if (depth === 0 && start >= 0) {
        const candidate = s.slice(start, i + 1);
        try { JSON.parse(candidate); lastValid = candidate; } catch {}
        start = -1;
      }
    }
  }
  return lastValid ? JSON.parse(lastValid) : null;
}
