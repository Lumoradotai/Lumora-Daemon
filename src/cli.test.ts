import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const cliPath = join(dirname(fileURLToPath(import.meta.url)), "..", "bin", "cli.js");

describe("daemon CLI OpenClaw defaults", () => {
  it("defaults the OpenClaw agent to main", async () => {
    const { stdout } = await execFileAsync(process.execPath, [cliPath, "--help"], {
      env: envWithoutOpenClawAgent(),
    });

    assert.match(openClawAgentHelpLine(stdout), /default: "?main"?/);
  });

  it("uses OPENCLAW_AGENT as the OpenClaw agent default when set", async () => {
    const { stdout } = await execFileAsync(process.execPath, [cliPath, "--help"], {
      env: { ...process.env, OPENCLAW_AGENT: "qa-agent" },
    });

    assert.match(openClawAgentHelpLine(stdout), /default: "?qa-agent"?/);
  });
});

function envWithoutOpenClawAgent(): NodeJS.ProcessEnv {
  const env = { ...process.env };
  delete env.OPENCLAW_AGENT;
  return env;
}

function openClawAgentHelpLine(stdout: string): string {
  const lines = stdout.split("\n");
  const optionIndex = lines.findIndex((entry) => entry.includes("--openclaw-agent"));
  assert.notEqual(optionIndex, -1, stdout);

  const block: string[] = [lines[optionIndex]];
  for (const line of lines.slice(optionIndex + 1)) {
    if (line.trim().startsWith("--")) break;
    block.push(line);
  }
  return block.join(" ");
}
