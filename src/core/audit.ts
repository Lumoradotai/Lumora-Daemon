import { readFileSync, existsSync, statSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

// One parsed entry from the onchainos audit log (`~/.onchainos/audit.jsonl`).
// The log is JSON Lines; the first line is a device header, the rest are
// command records. Sensitive args are already redacted by the CLI.
export interface AuditEntry {
  ts: string;
  source: string;
  command: string;
  ok: boolean;
  durationMs?: number;
  args?: unknown;
  error?: string;
}

export interface AuditLogResult {
  path: string | null;
  exists: boolean;
  device: { os?: string; arch?: string; version?: string } | null;
  entries: AuditEntry[];
  total: number;
  /** Offset of the first returned entry within the newest-first list. */
  offset: number;
  /** Whether older entries remain beyond this page. */
  hasMore: boolean;
}

function resolveAuditPath(): string {
  const home = process.env.ONCHAINOS_HOME;
  if (home) return join(home, "audit.jsonl");
  return join(homedir(), ".onchainos", "audit.jsonl");
}

// Read a page of command entries from the audit log, newest first. `offset`
// pages back into older entries (for "load more"). Best-effort: missing file or
// malformed lines never throw — they yield empty/partial data.
export function readAuditLog(limit = 200, offset = 0): AuditLogResult {
  const path = resolveAuditPath();
  if (!existsSync(path)) {
    return { path, exists: false, device: null, entries: [], total: 0, offset: 0, hasMore: false };
  }

  let raw = "";
  try {
    raw = readFileSync(path, "utf8");
  } catch {
    return { path, exists: true, device: null, entries: [], total: 0, offset: 0, hasMore: false };
  }

  const lines = raw.split("\n").filter((l) => l.trim().length > 0);
  let device: AuditLogResult["device"] = null;
  const entries: AuditEntry[] = [];

  for (const line of lines) {
    let obj: any;
    try {
      obj = JSON.parse(line);
    } catch {
      continue;
    }
    if (obj?.type === "device") {
      device = { os: obj.os, arch: obj.arch, version: obj.version };
      continue;
    }
    if (!obj?.command) continue;
    entries.push({
      ts: String(obj.ts ?? ""),
      source: String(obj.source ?? ""),
      command: String(obj.command ?? ""),
      ok: obj.ok !== false,
      durationMs: typeof obj.duration_ms === "number" ? obj.duration_ms : undefined,
      args: obj.args,
      error: obj.error ? String(obj.error) : undefined,
    });
  }

  const total = entries.length;
  const reversed = entries.reverse(); // newest first
  const start = Math.max(0, offset);
  const page = limit > 0 ? reversed.slice(start, start + limit) : reversed.slice(start);
  return { path, exists: true, device, entries: page, total, offset: start, hasMore: start + page.length < total };
}

// Last-modified time of the audit file, for cache/age display (epoch ms or null).
export function auditLogMtime(): number | null {
  const path = resolveAuditPath();
  try {
    return existsSync(path) ? statSync(path).mtimeMs : null;
  } catch {
    return null;
  }
}
