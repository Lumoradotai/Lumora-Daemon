import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { execFileSync } from "node:child_process";

export interface AiTool {
  id: string;
  name: string;
  installed: boolean;
  ready: boolean;
  version?: string;
  configDir?: string;
  hasSkills: boolean;
  skillCount: number;
  extras?: Record<string, any>;
}

export interface AiEnvironment {
  tools: AiTool[];
  primary: string | null;
  summary: string;
}

interface ToolDef {
  id: string;
  name: string;
  configDir: string;
  bin: string;
  versionArgs: string[];
  skillDirs: string[];
  parseVersion?: (raw: string) => string;
  detect?: () => Record<string, any> | undefined;
}

const home = homedir();

const TOOLS: ToolDef[] = [
  {
    id: "claude-code",
    name: "Claude Code",
    configDir: join(home, ".claude"),
    bin: "claude",
    versionArgs: ["--version"],
    skillDirs: [join(home, ".claude", "skills")],
    detect() {
      const sessionsDir = join(home, ".claude", "sessions");
      const hasSessions = existsSync(sessionsDir) && readdirSync(sessionsDir).some((f) => f.endsWith(".json"));
      const cred = join(home, ".claude", ".credentials.json");
      let hasCredFile = false;
      if (existsSync(cred)) {
        try {
          const data = JSON.parse(readFileSync(cred, "utf8"));
          hasCredFile = !!data.oauthAccessToken || !!data.apiKey;
        } catch { /* ignore */ }
      }
      return { authenticated: hasSessions || hasCredFile };
    },
  },
  {
    id: "codex",
    name: "OpenAI Codex CLI",
    configDir: join(home, ".codex"),
    bin: "codex",
    versionArgs: ["--version"],
    skillDirs: [
      join(home, ".codex", "skills"),
      join(home, ".codex", "onchainos-skills"),
      join(home, ".agents", "skills"),
    ],
    detect() {
      const envKey = !!process.env.OPENAI_API_KEY;
      const configFile = join(home, ".codex", "config.toml");
      let configHasKey = false;
      if (existsSync(configFile)) {
        try {
          const content = readFileSync(configFile, "utf8");
          configHasKey = /api[_-]?key\s*=/.test(content);
        } catch { /* ignore */ }
      }
      return { hasApiKey: envKey || configHasKey };
    },
  },
  {
    id: "openclaw",
    name: "OpenClaw",
    configDir: join(home, ".openclaw"),
    bin: "openclaw",
    versionArgs: ["--version"],
    skillDirs: [
      join(home, ".openclaw", "onchainos-skills"),
      join(home, ".openclaw", "plugin-skills"),
    ],
    detect() {
      const agents = join(home, ".openclaw", "agents");
      const creds = join(home, ".openclaw", "credentials");
      return {
        hasAgents: existsSync(agents),
        hasCredentials: existsSync(creds),
      };
    },
  },
  {
    id: "aider",
    name: "Aider",
    configDir: join(home, ".aider"),
    bin: "aider",
    versionArgs: ["--version"],
    skillDirs: [],
    parseVersion: (raw) => raw.replace(/^aider\s+/i, "").trim(),
  },
  {
    id: "copilot",
    name: "GitHub Copilot CLI",
    configDir: join(home, ".config", "github-copilot"),
    bin: "github-copilot-cli",
    versionArgs: ["--version"],
    skillDirs: [],
  },
  {
    id: "opencode",
    name: "OpenCode",
    configDir: join(home, ".opencode"),
    bin: "opencode",
    versionArgs: ["--version"],
    skillDirs: [join(home, ".opencode", "onchainos-skills")],
  },
  {
    id: "windsurf",
    name: "Windsurf",
    configDir: join(home, ".windsurf"),
    bin: "windsurf",
    versionArgs: ["--version"],
    skillDirs: [],
  },
];

function tryVersion(bin: string, args: string[], parse?: (raw: string) => string): string | undefined {
  try {
    const raw = execFileSync(bin, args, { timeout: 5000, stdio: ["ignore", "pipe", "ignore"] }).toString().trim();
    return parse ? parse(raw) : raw;
  } catch {
    return undefined;
  }
}

function countSkills(dirs: string[]): number {
  let count = 0;
  for (const dir of dirs) {
    if (!existsSync(dir)) continue;
    try {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        if (entry.isDirectory() && existsSync(join(dir, entry.name, "SKILL.md"))) {
          count++;
        }
      }
    } catch { /* ignore */ }
  }
  return count;
}

function computeReady(_id: string, version: string | undefined, _extras: Record<string, any> | undefined): boolean {
  return !!version;
}

export function detectAiEnvironment(): AiEnvironment {
  const tools: AiTool[] = [];

  for (const def of TOOLS) {
    const configExists = existsSync(def.configDir);
    const version = tryVersion(def.bin, def.versionArgs, def.parseVersion);
    const installed = configExists || !!version;

    if (!installed) continue;

    const skillCount = countSkills(def.skillDirs);
    const extras = def.detect?.();

    const ready = computeReady(def.id, version, extras);

    tools.push({
      id: def.id,
      name: def.name,
      installed: true,
      ready,
      version,
      configDir: configExists ? def.configDir : undefined,
      hasSkills: skillCount > 0,
      skillCount,
      ...(extras ? { extras } : {}),
    });
  }

  const primary = tools[0]?.id ?? null;

  const names = tools.map((t) => t.name);
  const summary = tools.length === 0
    ? "No AI coding tools detected"
    : `${tools.length} AI tool(s): ${names.join(", ")}`;

  return { tools, primary, summary };
}
