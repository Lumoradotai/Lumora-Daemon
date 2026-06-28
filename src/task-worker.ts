import { spawn } from "node:child_process";
import type { Task, TaskResult, RuntimeCapability, DetectedRuntime } from "./shared/index.js";
import type { BackendClient } from "./backend-client.js";

// onchainos + skills install steps, run by the daemon-local `installOnchainos`
// action so the dashboard onboarding can provision a fresh machine without the
// user opening a terminal. Hardcoded (the action takes no caller-supplied args).
const ONCHAINOS_INSTALL_SH =
  "curl -sSL https://raw.githubusercontent.com/okx/onchainos-skills/main/install.sh | sh";
const ONCHAINOS_INSTALL_SKILLS = "npx -y skills add okx/onchainos-skills";

interface DaemonHooks {
  onHeartbeat: () => Promise<void>;
  onProgress?: (msg: string) => void;
}
import {
  ClawAdapter, type ClawAdapterOptions, type ClawParams,
  ClaudeCodeAdapter, type ClaudeCodeAdapterOptions, type ClaudeCodeParams,
  CodexAdapter, type CodexAdapterOptions, type CodexParams,
  CliAdapter, type CliAdapterOptions, type CliParams,
} from "./core/index.js";

export interface TaskWorkerOptions {
  client: BackendClient;
  machineName?: string;
  daemonId: string;
  capabilities: RuntimeCapability;
  detectedRuntimes?: DetectedRuntime[];
  clawOpts?: ClawAdapterOptions;
  claudeCodeOpts?: ClaudeCodeAdapterOptions;
  codexOpts?: CodexAdapterOptions;
  cliOpts?: CliAdapterOptions;
  // Daemon-local info providers (skills scan + AI environment) answered directly,
  // without shelling out — there is no `onchainos skills` / `onchainos agent` command.
  getSkillsInfo?: () => unknown;
  getAiEnvironment?: () => unknown;
  getActivityInfo?: (limit: number, offset: number) => unknown;
  pollIntervalMs?: number;
  pollWaitMs?: number;
  heartbeatIntervalMs?: number;
  maxConcurrent?: number;
}

export class TaskWorker {
  private running = false;
  private pollTimer: ReturnType<typeof setTimeout> | null = null;
  private daemonHeartbeatTimer: ReturnType<typeof setInterval> | null = null;
  private activeTasks = new Map<string, { claimId: string }>();
  // Tasks picked from a poll but not yet claimed-and-running. Prevents the faster
  // poll loop from re-dispatching the same queued task while a claim is in flight.
  private claiming = new Set<string>();
  private pendingResults = new Map<string, { claimId: string; result: TaskResult; nextAttemptAt: number }>();

  private client: BackendClient;
  private machineId: string | null = null;
  private machineName?: string;
  private daemonId: string;
  private capabilities: RuntimeCapability;
  private detectedRuntimes?: DetectedRuntime[];
  private clawAdapter: ClawAdapter | null;
  private claudeCodeAdapter: ClaudeCodeAdapter | null;
  private codexAdapter: CodexAdapter | null;
  private cliAdapter: CliAdapter | null;
  private getSkillsInfo?: () => unknown;
  private getAiEnvironment?: () => unknown;
  private getActivityInfo?: (limit: number, offset: number) => unknown;
  private pollIntervalMs: number;
  private pollWaitMs: number;
  private heartbeatIntervalMs: number;
  private maxConcurrent: number;

  constructor(opts: TaskWorkerOptions) {
    this.client = opts.client;
    this.machineName = opts.machineName;
    this.daemonId = opts.daemonId;
    this.capabilities = opts.capabilities;
    this.detectedRuntimes = opts.detectedRuntimes;
    this.clawAdapter = opts.clawOpts ? new ClawAdapter(opts.clawOpts) : null;
    this.claudeCodeAdapter = opts.claudeCodeOpts ? new ClaudeCodeAdapter(opts.claudeCodeOpts) : null;
    this.codexAdapter = opts.codexOpts ? new CodexAdapter(opts.codexOpts) : null;
    this.cliAdapter = opts.cliOpts ? new CliAdapter(opts.cliOpts) : null;
    this.getSkillsInfo = opts.getSkillsInfo;
    this.getAiEnvironment = opts.getAiEnvironment;
    this.getActivityInfo = opts.getActivityInfo;
    // Short gap between polls; pickup latency is driven by long-poll (pollWaitMs)
    // when the backend supports it, with this interval as the fallback cadence.
    this.pollIntervalMs = opts.pollIntervalMs ?? 500;
    this.pollWaitMs = opts.pollWaitMs ?? 20_000;
    this.heartbeatIntervalMs = opts.heartbeatIntervalMs ?? 30_000;
    this.maxConcurrent = opts.maxConcurrent ?? 4;

    const adapterMap: Record<string, unknown> = {
      claw: this.clawAdapter,
      claude_code: this.claudeCodeAdapter,
      codex: this.codexAdapter,
      cli: this.cliAdapter,
    };
    for (const agentType of this.capabilities.agentTypes) {
      if (!adapterMap[agentType]) {
        throw new Error(`Advertised agentType "${agentType}" has no configured adapter — do not advertise capabilities without a matching executor`);
      }
    }
  }

  async start() {
    if (this.running) return;
    this.running = true;

    // Try to register, but never crash if the backend is briefly unreachable at
    // startup — the heartbeat timer keeps retrying until it comes back.
    await this.tryRegister();

    this.daemonHeartbeatTimer = setInterval(() => {
      void this.tryRegister();
    }, this.heartbeatIntervalMs);

    this.schedulePoll();
  }

  // Detect onchainos; if missing, install the cli + skills, then advertise the
  // `cli` capability and re-register. Triggered by the dashboard install action
  // (after the user confirms), not silently on startup. Safe to call when already
  // installed.
  private async ensureOnchainos(): Promise<{ ok: boolean; cliAvailable: boolean; log: string }> {
    if (!this.cliAdapter) return { ok: false, cliAvailable: false, log: "no cli adapter configured" };
    const logs: string[] = [];
    let cap = await this.cliAdapter.detect();
    if (!cap.available) {
      console.log("[worker] onchainos not found — installing…");
      for (const cmd of [ONCHAINOS_INSTALL_SH, ONCHAINOS_INSTALL_SKILLS]) {
        const { code, out } = await runShell(cmd, 240_000);
        logs.push(`$ ${cmd}\n${out}`.trim());
        if (code !== 0) {
          console.error(`[worker] install step failed (exit ${code}): ${cmd}`);
          return { ok: false, cliAvailable: false, log: logs.join("\n\n").slice(-4000) };
        }
      }
      cap = await this.cliAdapter.detect();
    }
    if (cap.available && !this.capabilities.agentTypes.includes("cli")) {
      this.capabilities.agentTypes.push("cli");
      for (const c of cap.commands) {
        if (!this.capabilities.commands.includes(c)) this.capabilities.commands.push(c);
      }
      console.log("[worker] onchainos ready — advertising cli capability");
      await this.tryRegister();
    }
    return { ok: true, cliAvailable: cap.available, log: logs.join("\n\n").slice(-4000) };
  }

  // Heartbeat + (re)bind machine id. Tolerant of transient network failures so a
  // backend blip — at startup or mid-run — never kills the daemon.
  private async tryRegister(): Promise<void> {
    try {
      const heartbeat = await this.client.daemonHeartbeat(this.daemonId, this.machineId ?? undefined, this.capabilities, this.detectedRuntimes);
      if (heartbeat.ok && heartbeat.machineId) {
        const wasUnregistered = !this.machineId;
        this.machineId = heartbeat.machineId;
        if (wasUnregistered) {
          console.log(`[worker] daemon registered: ${this.daemonId} on machine ${heartbeat.machineName ?? this.machineId}`);
        }
      } else if (this.machineId) {
        // Already registered but now being rejected — the backend no longer
        // recognizes this key (machine deleted / key rotated / DB reset) or this
        // daemon was superseded. Polling uses the same auth, so it's silently
        // failing too. Make this loud: it's the difference between "idle" and
        // "broken", and the symptom users see is a stuck/slow onboarding.
        console.error(`[worker] heartbeat rejected (HTTP ${heartbeat.status}) for a registered daemon — backend no longer accepts this API key; tasks will stall until the machine is reconnected`);
      } else if (heartbeat.status === 401 || heartbeat.status === 403) {
        console.warn(`[worker] registration rejected (HTTP ${heartbeat.status}) — API key not recognized by backend; will retry`);
      } else {
        console.warn("[worker] registration not confirmed yet — will retry");
      }
    } catch (err) {
      console.error("[worker] heartbeat failed (will retry):", (err as Error)?.message ?? err);
    }
  }

  async stop() {
    this.running = false;

    if (this.pollTimer) {
      clearTimeout(this.pollTimer);
      this.pollTimer = null;
    }
    if (this.daemonHeartbeatTimer) {
      clearInterval(this.daemonHeartbeatTimer);
      this.daemonHeartbeatTimer = null;
    }

    this.activeTasks.clear();
  }

  private schedulePoll() {
    if (!this.running) return;
    this.pollTimer = setTimeout(() => this.poll(), this.pollIntervalMs);
  }

  private async poll() {
    if (!this.running) return;
    // Not registered yet (backend was unreachable at startup) — wait for the
    // heartbeat timer to bind a machine id before polling.
    if (!this.machineId) {
      this.schedulePoll();
      return;
    }

    try {
      await this.flushPendingResults();

      const freeSlots = this.maxConcurrent - this.activeTasks.size - this.claiming.size;
      if (freeSlots <= 0) {
        this.schedulePoll();
        return;
      }

      // Claim up to the number of free slots in one poll so independent reads
      // (e.g. the Overview portfolio fan-out) run in parallel instead of one
      // per poll interval.
      const tasks = await this.client.pollTasks(
        this.requireMachineId(),
        this.daemonId,
        this.capabilities,
        freeSlots,
        this.pollWaitMs,
      );

      for (const task of tasks) {
        // Skip tasks already in flight — a long-poll can return the same queued
        // task again before our claim lands.
        if (this.activeTasks.has(task.id) || this.claiming.has(task.id)) continue;
        this.claiming.add(task.id);
        // Fire-and-forget, but never let a rejection escape (an uncaught network
        // error here would otherwise crash the whole daemon).
        this.processTask(task).catch((err) => {
          console.error(`[worker] task ${task.id} failed:`, (err as Error)?.message ?? err);
        }).finally(() => {
          this.claiming.delete(task.id);
        });
      }
    } catch (err) {
      console.error("[worker] poll error:", (err as Error)?.message ?? err);
    }

    this.schedulePoll();
  }

  private async processTask(task: Task) {
    const t0 = Date.now();
    console.log(`[worker] claiming task ${task.id} (${task.agentType ?? task.executor})`);

    const claimId = await this.client.claimTask(task.id, this.daemonId, this.requireMachineId());
    if (!claimId) {
      console.log(`[worker] failed to claim task ${task.id}`);
      return;
    }
    const tClaimed = Date.now();

    console.log(`[worker] claimed task ${task.id}, claimId=${claimId} (claim ${tClaimed - t0}ms)`);

    this.activeTasks.set(task.id, { claimId });

    let result: TaskResult;
    const startTime = Date.now();

    try {
      await this.client.taskHeartbeat(task.id, this.daemonId, claimId);
      result = await this.executeTask(task, claimId);
    } catch (err) {
      result = {
        taskId: task.id,
        finalStatus: "failed",
        texts: [(err as Error).message],
        artifacts: [],
      };
    } finally {
      this.activeTasks.delete(task.id);
    }

    const tExecEnd = Date.now();
    result.durationMs = tExecEnd - startTime;

    await this.submitWithRetry(task.id, claimId, result);
    const tDone = Date.now();

    // Breakdown so a slow "get data" can be pinned to a stage: claim (backend
    // round-trip) vs exec (running the onchainos command) vs submit (result upload).
    console.log(
      `[worker] task ${task.id} timing: claim=${tClaimed - t0}ms exec=${tExecEnd - startTime}ms submit=${tDone - tExecEnd}ms total=${tDone - t0}ms (${result.finalStatus})`,
    );
  }

  private async executeTask(task: Task, claimId: string): Promise<TaskResult> {
    const params = (task.metadata as Record<string, any>)?.params ?? {};
    const hooks = {
      onHeartbeat: () => this.client.taskHeartbeat(task.id, this.daemonId, claimId).then(() => {}),
      onProgress: (msg: string) => console.log(`[worker] task ${task.id}: ${msg}`),
    };

    // Daemon-local info (skills scan / AI environment) — answered from our own
    // detection, not by running a command.
    if (params.daemonInfo) {
      return this.runDaemonInfo(task, params.daemonInfo as string, (params.daemonInfoArgs ?? {}) as Record<string, unknown>, hooks);
    }

    switch (task.agentType) {
      case "claw":
        if (!this.clawAdapter) {
          return { taskId: task.id, finalStatus: "failed", texts: ["OpenClaw adapter not configured"], artifacts: [] };
        }
        return this.clawAdapter.run(task, params as ClawParams, hooks);

      case "claude_code":
        if (!this.claudeCodeAdapter) {
          return { taskId: task.id, finalStatus: "failed", texts: ["Claude Code adapter not configured"], artifacts: [] };
        }
        return this.claudeCodeAdapter.run(task, params as ClaudeCodeParams, hooks);

      case "codex":
        if (!this.codexAdapter) {
          return { taskId: task.id, finalStatus: "failed", texts: ["Codex adapter not configured"], artifacts: [] };
        }
        return this.codexAdapter.run(task, params as CodexParams, hooks);

      case "cli":
        if (!this.cliAdapter) {
          return { taskId: task.id, finalStatus: "failed", texts: ["onchainos CLI adapter not configured"], artifacts: [] };
        }
        return this.cliAdapter.run(task, params as CliParams, hooks);

      default:
        return {
          taskId: task.id,
          finalStatus: "failed",
          texts: [`Unsupported agent type: ${task.agentType}`],
          artifacts: [],
        };
    }
  }

  private async runDaemonInfo(task: Task, query: string, args: Record<string, unknown> = {}, hooks?: DaemonHooks): Promise<TaskResult> {
    const ok = (data: unknown): TaskResult => ({
      taskId: task.id,
      finalStatus: "succeeded",
      // Wrap in the { ok, data } envelope the frontend already unwraps.
      texts: [JSON.stringify({ ok: true, data })],
      artifacts: [],
    });
    const fail = (message: string): TaskResult => ({
      taskId: task.id, finalStatus: "failed", texts: [message], artifacts: [],
    });
    try {
      if (query === "installOnchainos") {
        return await this.installOnchainos(task, hooks);
      }
      if (query === "skills") {
        if (!this.getSkillsInfo) return fail("Skills info not available on this daemon");
        return ok(this.getSkillsInfo());
      }
      if (query === "agentInfo") {
        const skills = this.getSkillsInfo?.() as { platform?: unknown; skillDirs?: unknown } | undefined;
        return ok({
          platform: skills?.platform,
          skillDirs: skills?.skillDirs,
          aiEnvironment: this.getAiEnvironment?.() ?? null,
        });
      }
      if (query === "activity") {
        if (!this.getActivityInfo) return fail("Activity log not available on this daemon");
        const limit = typeof args.limit === "number" ? args.limit : Number(args.limit) || 200;
        const offset = typeof args.offset === "number" ? args.offset : Number(args.offset) || 0;
        return ok(this.getActivityInfo(limit, offset));
      }
      return fail(`Unknown daemon info query: ${query}`);
    } catch (err) {
      return fail((err as Error).message);
    }
  }

  // Dashboard-triggered fallback for the same provisioning start() does on its own:
  // installs onchainos via ensureOnchainos(), heartbeating while it runs.
  private async installOnchainos(task: Task, hooks?: DaemonHooks): Promise<TaskResult> {
    const beat = setInterval(() => { void hooks?.onHeartbeat().catch(() => {}); }, 15_000);
    try {
      hooks?.onProgress?.("installing onchainos…");
      const r = await this.ensureOnchainos();
      if (!r.ok) {
        return {
          taskId: task.id,
          finalStatus: "failed",
          texts: [JSON.stringify({ ok: false, error: { message: "onchainos install failed" }, data: { log: r.log } })],
          artifacts: [],
        };
      }
      hooks?.onProgress?.(r.cliAvailable ? "onchainos ready" : "installed, but cli not detected");
      return {
        taskId: task.id,
        finalStatus: "succeeded",
        texts: [JSON.stringify({ ok: true, data: { cliAvailable: r.cliAvailable, log: r.log } })],
        artifacts: [],
      };
    } finally {
      clearInterval(beat);
    }
  }

  private async submitWithRetry(taskId: string, claimId: string, result: TaskResult, retries = 3) {
    for (let attempt = 0; attempt < retries; attempt++) {
      try {
        const outcome = await this.client.submitResult(taskId, this.daemonId, claimId, result);
        if (outcome === "submitted") {
          console.log(`[worker] submitted result for task ${taskId}: ${result.finalStatus}`);
          return;
        }
        if (outcome === "rejected") {
          console.warn(`[worker] submit rejected permanently for task ${taskId}`);
          await this.client.reportResultSubmitFailed(taskId, this.daemonId, claimId, "backend rejected final result submission");
          return;
        }
        console.warn(`[worker] submit rejected for task ${taskId} (attempt ${attempt + 1})`);
      } catch (err) {
        console.error(`[worker] submit failed for task ${taskId} (attempt ${attempt + 1}):`, err);
      }

      if (attempt < retries - 1) {
        await sleep(1000 * Math.pow(2, attempt));
      }
    }

    console.error(`[worker] retaining pending result for task ${taskId} after ${retries} attempts`);
    this.pendingResults.set(taskId, { claimId, result, nextAttemptAt: Date.now() + 5_000 });
  }

  private async flushPendingResults() {
    const now = Date.now();
    for (const [taskId, pending] of this.pendingResults) {
      if (pending.nextAttemptAt > now) continue;
      try {
        const outcome = await this.client.submitResult(taskId, this.daemonId, pending.claimId, pending.result);
        if (outcome === "submitted") {
          this.pendingResults.delete(taskId);
          console.log(`[worker] replayed pending result for task ${taskId}: ${pending.result.finalStatus}`);
          continue;
        }
        if (outcome === "rejected") {
          this.pendingResults.delete(taskId);
          console.warn(`[worker] pending result replay rejected permanently for task ${taskId}`);
          await this.client.reportResultSubmitFailed(taskId, this.daemonId, pending.claimId, "backend rejected pending result replay");
          continue;
        }
        console.warn(`[worker] pending result replay rejected for task ${taskId}`);
      } catch (err) {
        console.error(`[worker] pending result replay failed for task ${taskId}:`, err);
      }
      pending.nextAttemptAt = Date.now() + 30_000;
    }
  }

  private requireMachineId(): string {
    if (!this.machineId) {
      throw new Error(`Daemon is not registered${this.machineName ? ` for ${this.machineName}` : ""}`);
    }
    return this.machineId;
  }
}

function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

// Run a shell command, capturing combined stdout/stderr (tail-capped) with a hard
// timeout. Never rejects — returns a non-zero code so the caller reports failure.
function runShell(cmd: string, timeoutMs: number): Promise<{ code: number; out: string }> {
  return new Promise((resolve) => {
    const child = spawn(cmd, { shell: true, env: { ...process.env, NO_COLOR: "1" } });
    let out = "";
    const cap = (d: Buffer) => {
      out += d.toString();
      if (out.length > 200_000) out = out.slice(-200_000);
    };
    child.stdout?.on("data", cap);
    child.stderr?.on("data", cap);
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      resolve({ code: -1, out: `${out}\n[timed out after ${Math.round(timeoutMs / 1000)}s]` });
    }, timeoutMs);
    child.on("close", (code) => { clearTimeout(timer); resolve({ code: code ?? -1, out }); });
    child.on("error", (err) => { clearTimeout(timer); resolve({ code: -1, out: `${out}\n${String(err)}` }); });
  });
}
