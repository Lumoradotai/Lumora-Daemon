#!/usr/bin/env node
import crypto from "node:crypto";
import { Command } from "commander";
import { homedir } from "node:os";
import {
  SkillsScanner, detectAiEnvironment, readAuditLog,
  ClawAdapter, type ClawAdapterOptions,
  ClaudeCodeAdapter, type ClaudeCodeAdapterOptions,
  CodexAdapter, type CodexAdapterOptions,
  CliAdapter, type CliAdapterOptions,
} from "../src/core/index.js";
import type { RuntimeCapability, DetectedRuntime } from "../src/shared/index.js";
import { BackendClient } from "../src/backend-client.js";
import { TaskWorker } from "../src/task-worker.js";

// Resilience net: a long-running poller must never die from a transient network
// blip. Log and keep running — the next poll/heartbeat recovers on its own.
process.on("unhandledRejection", (reason) => {
  console.error("[daemon] unhandled rejection (ignored):", (reason as Error)?.message ?? reason);
});
process.on("uncaughtException", (err) => {
  console.error("[daemon] uncaught exception (ignored):", err?.message ?? err);
});

const VERSION = "0.1.0";

const program = new Command()
  .name("lumora-daemon")
  .description("Lumora Daemon — local agent runtime for remote AI task execution")
  .version(VERSION)
  .option("--backend-url <url>", "HTTP URL of the backend task control plane", process.env.AGENT_DASHBOARD_BACKEND_URL)
  .option("--api-key <key>", "Machine API key for authentication", process.env.AGENT_DASHBOARD_DAEMON_API_KEY)
  .option("--name <name>", "Human-readable machine name", `${homedir().split("/").pop()}_machine`)
  .option("--openclaw-path <path>", "Path to openclaw binary", process.env.OPENCLAW_PATH ?? "openclaw")
  .option("--openclaw-agent <agent>", "Default OpenClaw agent id for agent.message tasks", process.env.OPENCLAW_AGENT ?? "main")
  .option("--openclaw-session-id <sessionId>", "Default OpenClaw session id for agent.message tasks")
  .option("--openclaw-to <target>", "Default OpenClaw target for agent.message tasks")
  .option("--openclaw-local", "Run OpenClaw agent messages with --local by default", false)
  .option("--claude-code-path <path>", "Path to claude binary", process.env.CLAUDE_CODE_PATH ?? "claude")
  .option("--claude-code-model <model>", "Default model for Claude Code tasks")
  .option("--claude-code-max-turns <turns>", "Default max turns for Claude Code tasks")
  .option(
    "--claude-code-approval-mode <mode>",
    "Default Claude Code approval mode (default|full-auto). full-auto bypasses interactive permission prompts for headless daemon use",
    process.env.CLAUDE_CODE_APPROVAL_MODE ?? "full-auto",
  )
  .option("--codex-path <path>", "Path to codex binary", process.env.CODEX_PATH ?? "codex")
  .option("--codex-model <model>", "Default model for Codex tasks")
  .option("--codex-approval-mode <mode>", "Default Codex approval mode (suggest|auto-edit|full-auto)")
  .option("--onchainos-path <path>", "Path to onchainos binary (CLI executor for data commands)", process.env.ONCHAINOS_PATH ?? "onchainos")
  .option("--skills-lock <path>", "Path to skills-lock.json");

program.parse();

const opts = program.opts<{
  backendUrl: string;
  apiKey: string;
  name: string;
  openclawPath: string;
  openclawAgent?: string;
  openclawSessionId?: string;
  openclawTo?: string;
  openclawLocal?: boolean;
  claudeCodePath: string;
  claudeCodeModel?: string;
  claudeCodeMaxTurns?: string;
  claudeCodeApprovalMode?: string;
  codexPath: string;
  codexModel?: string;
  codexApprovalMode?: string;
  onchainosPath: string;
  skillsLock?: string;
}>();

async function main() {
  if (!opts.backendUrl) {
    console.error("--backend-url is required (or set AGENT_DASHBOARD_BACKEND_URL)");
    process.exit(1);
  }
  if (!opts.apiKey) {
    console.error("--api-key is required (or set AGENT_DASHBOARD_DAEMON_API_KEY)");
    process.exit(1);
  }

  const skills = new SkillsScanner(opts.skillsLock);

  // Scan skills
  const skillsInfo = skills.scan();
  console.log(`Skills: ${skillsInfo.installedCount} installed, ${skillsInfo.lockedCount} locked`);

  // Detect installed runtimes (informational — uses PATH-based detection)
  const aiEnv = detectAiEnvironment();
  const detectedRuntimes: DetectedRuntime[] = aiEnv.tools.map((t) => ({
    id: t.id,
    name: t.name,
    installed: t.installed,
    ready: t.ready,
    version: t.version,
    ...(t.extras ? { extras: t.extras } : {}),
  }));
  console.log(`Detected runtimes: ${detectedRuntimes.map((r) => `${r.id}(${r.ready ? "ready" : "not ready"})`).join(", ") || "none"}`);

  // Build adapters from CLI-configured paths, then probe each one
  const clawOpts: ClawAdapterOptions = {
    binPath: opts.openclawPath,
    defaults: {
      agent: opts.openclawAgent,
      sessionId: opts.openclawSessionId,
      to: opts.openclawTo,
      local: opts.openclawLocal,
    },
  };
  const claudeCodeApprovalMode = opts.claudeCodeApprovalMode as "default" | "full-auto" | undefined;
  if (claudeCodeApprovalMode && claudeCodeApprovalMode !== "default" && claudeCodeApprovalMode !== "full-auto") {
    console.error("--claude-code-approval-mode must be default or full-auto");
    process.exit(1);
  }
  const claudeCodeOpts: ClaudeCodeAdapterOptions = {
    binPath: opts.claudeCodePath,
    defaults: {
      model: opts.claudeCodeModel,
      maxTurns: opts.claudeCodeMaxTurns ? Number(opts.claudeCodeMaxTurns) : undefined,
      approvalMode: claudeCodeApprovalMode ?? "full-auto",
    },
  };
  const codexOpts: CodexAdapterOptions = {
    binPath: opts.codexPath,
    defaults: {
      model: opts.codexModel,
      approvalMode: opts.codexApprovalMode as "suggest" | "auto-edit" | "full-auto" | undefined,
    },
  };
  const cliOpts: CliAdapterOptions = {
    binPath: opts.onchainosPath,
  };

  const [clawCap, claudeCodeCap, codexCap, cliCap] = await Promise.all([
    new ClawAdapter(clawOpts).detect(),
    new ClaudeCodeAdapter(claudeCodeOpts).detect(),
    new CodexAdapter(codexOpts).detect(),
    new CliAdapter(cliOpts).detect(),
  ]);

  // Advertise only agent types whose configured binary is actually executable
  const capabilities: RuntimeCapability = {
    agentTypes: [
      ...(clawCap.available ? ["claw" as const] : []),
      ...(claudeCodeCap.available ? ["claude_code" as const] : []),
      ...(codexCap.available ? ["codex" as const] : []),
      ...(cliCap.available ? ["cli" as const] : []),
    ],
    commands: [...new Set([...clawCap.commands, ...claudeCodeCap.commands, ...codexCap.commands, ...cliCap.commands])],
    version: VERSION,
    available: true,
  };
  console.log(`onchainos CLI: ${cliCap.available ? "available" : "not found"} (${opts.onchainosPath})`);
  console.log(`Capabilities: agents=[${capabilities.agentTypes.join(",")}]`);

  // Start backend task worker
  const daemonId = `daemon-${crypto.randomUUID().slice(0, 8)}`;
  console.log(`\nConnecting to backend: ${opts.backendUrl}`);
  console.log(`Machine: ${opts.name}`);
  console.log(`Daemon ID: ${daemonId}`);

  const client = new BackendClient({ baseUrl: opts.backendUrl, apiKey: opts.apiKey });

  const healthy = await client.health();
  if (!healthy) {
    console.error("Backend health check failed — will retry on poll");
  } else {
    console.log("Backend health check passed");
  }

  const worker = new TaskWorker({
    client,
    machineName: opts.name,
    daemonId,
    capabilities,
    detectedRuntimes,
    clawOpts: clawCap.available ? clawOpts : undefined,
    claudeCodeOpts: claudeCodeCap.available ? claudeCodeOpts : undefined,
    codexOpts: codexCap.available ? codexOpts : undefined,
    // Always hand the worker the onchainos cli options (even if not installed yet)
    // so a daemon-local install can re-detect and advertise the `cli` capability
    // afterwards without a restart.
    cliOpts,
    // Answer the Skills page from our own scan (fresh each request).
    getSkillsInfo: () => skills.scan(),
    getAiEnvironment: () => detectAiEnvironment(),
    // Answer the Activity page from the local onchainos audit log.
    getActivityInfo: (limit: number, offset: number) => readAuditLog(limit, offset),
  });
  await worker.start();
  console.log("[worker] task polling started");

  // Graceful shutdown
  const shutdown = async () => {
    console.log("\nShutting down...");
    await worker.stop();
    setTimeout(() => process.exit(0), 500);
  };
  process.on("SIGINT", () => void shutdown());
  process.on("SIGTERM", () => void shutdown());
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
