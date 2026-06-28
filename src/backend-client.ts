import type {
  Task,
  RuntimeCapability,
  DetectedRuntime,
  TaskResult,
} from "./shared/index.js";

export interface BackendClientOptions {
  baseUrl: string;
  apiKey: string;
}

export class BackendClient {
  private baseUrl: string;
  private headers: Record<string, string>;

  constructor(opts: BackendClientOptions) {
    this.baseUrl = opts.baseUrl.replace(/\/$/, "");
    this.headers = {
      "Content-Type": "application/json",
      Authorization: `Bearer ${opts.apiKey}`,
    };
  }

  async daemonHeartbeat(daemonId: string, machineId?: string, capabilities?: RuntimeCapability, detectedRuntimes?: DetectedRuntime[]): Promise<{ ok: boolean; status: number; machineId?: string; machineName?: string }> {
    const res = await this.post("/api/daemon/heartbeat", {
      daemonId,
      ...(machineId ? { machineId } : {}),
      capabilities,
      detectedRuntimes,
    });
    if (!res.ok) return { ok: false, status: res.status };
    return { status: res.status, ...(await res.json() as { ok: boolean; machineId?: string; machineName?: string }) };
  }

  async pollTasks(
    machineId: string,
    daemonId: string,
    capabilities: RuntimeCapability,
    limit = 1,
    waitMs = 0,
  ): Promise<Task[]> {
    const start = Date.now();
    // Long-poll legitimately blocks for up to waitMs when idle — don't flag that as slow.
    const res = await this.post("/api/daemon/poll", { machineId, daemonId, capabilities, limit, ...(waitMs > 0 ? { wait: waitMs } : {}) }, { label: "poll", slowMs: Number.POSITIVE_INFINITY });
    if (!res.ok) {
      // Don't let an auth/identity rejection masquerade as "no work" — that loops
      // forever while queued tasks (e.g. onboarding wallet checks) silently stall.
      if (res.status === 401 || res.status === 403 || res.status === 409) {
        console.error(`[http] poll rejected (HTTP ${res.status}) — backend no longer accepts this daemon's API key; tasks will NOT be picked up until it re-registers`);
      }
      return [];
    }
    const body = await res.json() as { tasks: Task[] };
    if (body.tasks.length > 0) {
      console.log(`[http] poll returned ${body.tasks.length} task(s) in ${Date.now() - start}ms`);
    }
    return body.tasks;
  }

  async claimTask(taskId: string, daemonId: string, machineId: string): Promise<string | null> {
    const res = await this.post("/api/daemon/claim", { taskId, daemonId, machineId }, { label: "claim" });
    if (!res.ok) return null;
    const body = await res.json() as { claimId: string };
    return body.claimId;
  }

  async taskHeartbeat(taskId: string, daemonId: string, claimId: string): Promise<boolean> {
    const res = await this.post("/api/daemon/task-heartbeat", { taskId, daemonId, claimId });
    return res.ok;
  }

  async submitResult(taskId: string, daemonId: string, claimId: string, result: TaskResult): Promise<"submitted" | "retryable" | "rejected"> {
    const res = await this.post("/api/daemon/submit-result", { taskId, daemonId, claimId, result }, { label: "submit-result" });
    if (res.ok) return "submitted";
    if (res.status >= 500 || res.status === 408 || res.status === 429) return "retryable";
    return "rejected";
  }

  async reportResultSubmitFailed(taskId: string, daemonId: string, claimId: string, reason?: string): Promise<boolean> {
    const res = await this.post("/api/daemon/result-submit-failed", { taskId, daemonId, claimId, reason });
    return res.ok;
  }

  async health(): Promise<boolean> {
    try {
      const res = await fetch(`${this.baseUrl}/health`, { headers: this.headers });
      return res.ok;
    } catch {
      return false;
    }
  }

  private async post(path: string, body: unknown, opts: { label?: string; slowMs?: number } = {}): Promise<Response> {
    const tag = opts.label ?? path;
    const slowMs = opts.slowMs ?? 1500;
    const start = Date.now();
    try {
      const res = await fetch(`${this.baseUrl}${path}`, {
        method: "POST",
        headers: this.headers,
        body: JSON.stringify(body),
      });
      const ms = Date.now() - start;
      if (!res.ok) {
        console.warn(`[http] ${tag} -> HTTP ${res.status} in ${ms}ms`);
      } else if (ms > slowMs) {
        console.warn(`[http] ${tag} slow response: ${ms}ms`);
      }
      return res;
    } catch (err) {
      // Surfaces the "fetch failed" network errors (DNS/connect/TLS/timeout) with
      // the endpoint and elapsed time so backend-vs-network can be told apart.
      console.error(`[http] ${tag} fetch failed after ${Date.now() - start}ms: ${(err as Error)?.message ?? err}`);
      throw err;
    }
  }
}
