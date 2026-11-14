import * as fs from "fs";
import * as path from "path";
import { BackgroundTask, BackgroundTaskRegistry } from "./background-task-registry";

export class ActionBackgroundTasks {
  private readonly ids = new Set<string>();
  private fingerprint = "";
  private readonly timer: ReturnType<typeof setInterval>;
  private readonly safetyTimer?: ReturnType<typeof setInterval>;
  private scanning = false;
  private disposed = false;
  private initialScanStarted = false;

  constructor(private readonly registry: BackgroundTaskRegistry, private readonly store: () => string,
    private readonly safety?: { enabled: () => boolean; scan: () => Promise<unknown>; report: (error: unknown) => void }) {
    this.refresh();
    this.timer = setInterval(() => this.refresh(), 2000);
    this.timer.unref();
    if (safety) {
      void this.scan();
      this.safetyTimer = setInterval(() => { void this.scan(); }, 30_000);
      this.safetyTimer.unref();
    }
  }

  async scan(): Promise<void> {
    if (this.disposed || this.scanning || !this.safety) return;
    this.scanning = true;
    try {
      if (!this.store() || !this.safety.enabled()) return;
      this.initialScanStarted = true;
      await this.safety.scan();
    }
    catch (error) { this.safety.report(error); }
    finally { this.scanning = false; }
  }

  refresh(): void {
    if (!this.initialScanStarted) void this.scan();
    try {
      const store = this.store();
      if (!store) {
        this.clear();
        return;
      }
      const file = path.join(store, ".pkm", "state", "actions", "validation-queue.json");
      const stat = fs.statSync(file);
      if (!stat.isFile() || stat.size > 4 * 1024 * 1024) throw new Error("Invalid Action validation state.");
      const fingerprint = `${file}:${stat.mtimeMs}:${stat.size}`;
      if (fingerprint === this.fingerprint) return;
      const value = JSON.parse(fs.readFileSync(file, "utf8"));
      if (value.schema !== "pkm.action.validation-queue/v1" || !value.jobs || Array.isArray(value.jobs) || typeof value.jobs !== "object") {
        throw new Error("Invalid Action validation queue.");
      }
      const next = new Set<string>();
      for (const job of Object.values(value.jobs) as Record<string, unknown>[]) {
        if (!job || (job.state !== "queued" && job.state !== "running")) continue;
        if (typeof job.job_id !== "string" || !/^validation_[0-9a-f]{32}$/.test(job.job_id) || typeof job.action_id !== "string") continue;
        const id = `action-validation:${job.job_id}`;
        const priority = ["Demand", "Graph", "ModuleSet", "Idle"][Number(job.priority)] || "Unspecified";
        const timestamp = (value: unknown): string | undefined => {
          const date = typeof value === "number" ? new Date(value * 1000) : typeof value === "string" ? new Date(value) : undefined;
          return date && Number.isFinite(date.getTime()) ? date.toISOString() : undefined;
        };
        const task: BackgroundTask = { id, kind: "action-validation", label: `Validate Action: ${job.action_id}`,
          status: job.state, detail: `${job.stage || job.state} / ${priority}${job.cancel_requested ? " / cancellation requested" : ""}`,
          queuedAt: timestamp(job.queued_at), startedAt: timestamp(job.started_at) };
        this.registry.set(task);
        next.add(id);
      }
      for (const id of this.ids) if (!next.has(id)) this.registry.remove(id);
      this.ids.clear();
      for (const id of next) this.ids.add(id);
      this.fingerprint = fingerprint;
    } catch {
      this.clear();
    }
  }

  private clear(): void {
    for (const id of this.ids) this.registry.remove(id);
    this.ids.clear();
    this.fingerprint = "";
  }

  dispose(): void {
    this.disposed = true;
    clearInterval(this.timer);
    if (this.safetyTimer) clearInterval(this.safetyTimer);
    this.clear();
  }
}