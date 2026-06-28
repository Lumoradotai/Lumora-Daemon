import { readdirSync, readFileSync, existsSync, statSync } from "node:fs";
import { join, basename } from "node:path";
import { homedir } from "node:os";

export interface SkillMeta {
  name: string;
  description: string;
  source: string;
  sourceType: string;
  skillPath: string;
  computedHash: string;
  installed: boolean;
  installDir: string | null;
}

export interface AgentInfo {
  platform: string;
  skillDirs: { path: string; exists: boolean }[];
  lockPath: string | null;
  installedCount: number;
  lockedCount: number;
  skills: SkillMeta[];
}

interface LockEntry {
  source: string;
  sourceType: string;
  skillPath: string;
  computedHash: string;
}

interface LockFile {
  version: number;
  skills: Record<string, LockEntry>;
}

const SKILL_DIRS = [
  // Shared agents skill store — the canonical install target that Claude Code /
  // Codex skill dirs symlink into. Scanned first so it's found even when an
  // agent-specific symlink (e.g. ~/.claude/skills) is absent.
  join(homedir(), ".agents", "skills"),
  join(homedir(), ".openclaw", "onchainos-skills"),
  join(homedir(), ".openclaw", "plugin-skills"),
  join(homedir(), ".claude", "skills"),
  join(homedir(), ".codex", "skills"),
  join(homedir(), ".codex", "onchainos-skills"),
  join(homedir(), ".opencode", "onchainos-skills"),
];

const LOCK_PATHS = [
  join(process.cwd(), "skills-lock.json"),
  join(homedir(), ".onchainos", "skills-lock.json"),
  join(homedir(), ".openclaw", "skills-lock.json"),
  join(homedir(), ".openclaw", "onchainos-skills", "skills-lock.json"),
  join(homedir(), ".openclaw", "plugin-skills", "skills-lock.json"),
  join(homedir(), ".claude", "skills-lock.json"),
  join(homedir(), ".codex", "skills-lock.json"),
];

function parseSkillMd(filePath: string): { name?: string; description?: string } {
  try {
    const raw = readFileSync(filePath, "utf8");
    const fmMatch = raw.match(/^---\s*\n([\s\S]*?)\n---/);
    if (!fmMatch) {
      const titleMatch = raw.match(/^#\s+(.+)/m);
      return { name: titleMatch?.[1]?.trim(), description: undefined };
    }
    const fm = fmMatch[1];
    const name = fm.match(/^name:\s*(.+)$/m)?.[1]?.trim();
    const desc = fm.match(/^description:\s*(.+)$/m)?.[1]?.trim();
    return { name, description: desc };
  } catch {
    return {};
  }
}

function scanDir(dir: string): Map<string, string> {
  const found = new Map<string, string>();
  if (!existsSync(dir)) return found;
  try {
    for (const entry of readdirSync(dir)) {
      const full = join(dir, entry);
      if (!statSync(full).isDirectory()) continue;
      const skillMd = join(full, "SKILL.md");
      if (existsSync(skillMd)) {
        found.set(entry, full);
      }
    }
  } catch {
    // permission error or similar
  }
  return found;
}

export class SkillsScanner {
  private lockPath: string | null;
  private skillDirs: string[];

  constructor(lockPath?: string, skillDirs?: string[]) {
    this.lockPath = lockPath ?? resolveDefaultLockPath();
    this.skillDirs = skillDirs ?? SKILL_DIRS;
  }

  private loadLock(): LockFile | null {
    if (!this.lockPath || !existsSync(this.lockPath)) return null;
    try {
      return JSON.parse(readFileSync(this.lockPath, "utf8"));
    } catch {
      return null;
    }
  }

  scan(): AgentInfo {
    const lock = this.loadLock();
    const dirStatus = this.skillDirs.map((p) => ({ path: p, exists: existsSync(p) }));

    const installedSkills = new Map<string, { dir: string; skillMd: string }>();
    for (const dir of this.skillDirs) {
      for (const [name, fullPath] of scanDir(dir)) {
        if (!installedSkills.has(name)) {
          installedSkills.set(name, { dir, skillMd: join(fullPath, "SKILL.md") });
        }
      }
    }

    const allNames = new Set<string>([
      ...Object.keys(lock?.skills ?? {}),
      ...installedSkills.keys(),
    ]);

    const skills: SkillMeta[] = [];
    for (const name of allNames) {
      const lockEntry = lock?.skills?.[name];
      const installed = installedSkills.get(name);
      const md = installed ? parseSkillMd(installed.skillMd) : undefined;

      skills.push({
        name: md?.name ?? name,
        description: md?.description ?? "",
        source: lockEntry?.source ?? "local",
        sourceType: lockEntry?.sourceType ?? "filesystem",
        skillPath: lockEntry?.skillPath ?? "",
        computedHash: lockEntry?.computedHash ?? "",
        installed: !!installed,
        installDir: installed?.dir ?? null,
      });
    }

    skills.sort((a, b) => a.name.localeCompare(b.name));

    return {
      platform: detectPlatform(),
      skillDirs: dirStatus,
      lockPath: this.lockPath,
      installedCount: installedSkills.size,
      lockedCount: Object.keys(lock?.skills ?? {}).length,
      skills,
    };
  }

  getSkill(name: string): SkillMeta | null {
    const info = this.scan();
    return info.skills.find((s) => s.name === name) ?? null;
  }
}

function resolveDefaultLockPath(): string | null {
  const envPath = process.env.ONCHAINOS_SKILLS_LOCK ?? process.env.SKILLS_LOCK_PATH;
  if (envPath && existsSync(envPath)) return envPath;
  return LOCK_PATHS.find((p) => existsSync(p)) ?? null;
}

function detectPlatform(): string {
  // Config-dir existence only — used as a fallback. A bare ~/.openclaw is common
  // and doesn't mean openclaw is the active agent, so check claude/codex first.
  if (existsSync(join(homedir(), ".claude"))) return "claude-code";
  if (existsSync(join(homedir(), ".codex"))) return "codex";
  if (existsSync(join(homedir(), ".openclaw"))) return "openclaw";
  return "unknown";
}
