export type GitHubSyncReason = "startup" | "interval" | "change" | "configuration";

export interface AutomaticGitHubSyncTarget {
  id: string;
  enabled: boolean;
  intervalMinutes: number;
  syncOnChange: boolean;
  lastSuccessAt?: string;
  lastFailure?: { at: string; error: string; reason: string };
}

export interface GitHubSyncRuntimeState {
  status: "paused" | "scheduled" | "syncing" | "error";
  reason?: GitHubSyncReason;
  lastAttemptAt?: string;
  lastSuccessAt?: string;
  lastError?: string;
  nextSyncAt?: string;
}

export interface GitHubSyncSchedulerOptions {
  shouldExecute?: (targetId: string, reason: GitHubSyncReason) => Promise<boolean>;
  execute: (targetId: string, reason: GitHubSyncReason) => Promise<void>;
  onState?: (targetId: string, state: GitHubSyncRuntimeState) => void;
  now?: () => number;
  setTimeout?: (callback: () => void, delay: number) => NodeJS.Timeout;
  clearTimeout?: (timer: NodeJS.Timeout) => void;
  changeDebounceMs?: number;
}

export class GitHubSyncScheduler {
  private readonly targets = new Map<string, AutomaticGitHubSyncTarget>();
  private readonly states = new Map<string, GitHubSyncRuntimeState>();
  private readonly scheduledTimers = new Map<string, NodeJS.Timeout>();
  private readonly changeTimers = new Map<string, NodeJS.Timeout>();
  private readonly pending = new Map<string, GitHubSyncReason>();
  private draining = false;
  private disposed = false;

  constructor(private readonly options: GitHubSyncSchedulerOptions) {}

  configure(targets: AutomaticGitHubSyncTarget[]): void {
    if (this.disposed) return;
    for (const timer of this.scheduledTimers.values()) this.clearTimer(timer);
    for (const timer of this.changeTimers.values()) this.clearTimer(timer);
    this.scheduledTimers.clear();
    this.changeTimers.clear();
    this.targets.clear();
    const activeIds = new Set(targets.map(target => target.id));
    for (const id of this.states.keys()) if (!activeIds.has(id)) this.states.delete(id);
    for (const target of targets) {
      this.targets.set(target.id, target);
      if (!target.enabled) {
        this.updateState(target.id, {
          status: "paused",
          lastAttemptAt: target.lastFailure?.at || target.lastSuccessAt,
          lastSuccessAt: target.lastSuccessAt,
          lastError: target.lastFailure?.error,
        });
        continue;
      }
      const previous = this.states.get(target.id);
      this.states.set(target.id, {
        status: target.lastFailure && (!target.lastSuccessAt || target.lastFailure.at > target.lastSuccessAt) ? "error" : "scheduled",
        lastAttemptAt: previous?.lastAttemptAt || target.lastFailure?.at || target.lastSuccessAt,
        lastSuccessAt: target.lastSuccessAt,
        lastError: target.lastFailure?.error,
      });
      this.enqueue(target.id, "startup");
    }
  }

  request(targetId: string, reason: GitHubSyncReason): void {
    const target = this.targets.get(targetId);
    if (this.disposed || !target?.enabled) return;
    this.enqueue(targetId, reason);
  }

  private enqueue(targetId: string, reason: GitHubSyncReason): void {
    const target = this.targets.get(targetId);
    if (this.disposed || !target?.enabled) return;
    const current = this.pending.get(targetId);
    if (!current || this.reasonPriority(reason) > this.reasonPriority(current)) this.pending.set(targetId, reason);
    if (reason === "configuration") {
      const timer = this.scheduledTimers.get(targetId);
      if (timer) this.clearTimer(timer);
      this.scheduledTimers.delete(targetId);
      void this.drain();
      return;
    }
    this.scheduleWhenEligible(target);
  }

  notifyContentChanged(): void {
    if (this.disposed) return;
    for (const target of this.targets.values()) {
      if (!target.enabled || !target.syncOnChange) continue;
      const existing = this.changeTimers.get(target.id);
      if (existing) this.clearTimer(existing);
      const timer = this.setTimer(() => {
        this.changeTimers.delete(target.id);
        this.request(target.id, "change");
      }, this.options.changeDebounceMs ?? 2_000);
      this.changeTimers.set(target.id, timer);
    }
  }

  snapshot(): Record<string, GitHubSyncRuntimeState> {
    return Object.fromEntries([...this.states].map(([id, state]) => [id, { ...state }]));
  }

  dispose(): void {
    this.disposed = true;
    for (const timer of [...this.scheduledTimers.values(), ...this.changeTimers.values()]) this.clearTimer(timer);
    this.scheduledTimers.clear();
    this.changeTimers.clear();
    this.pending.clear();
    this.targets.clear();
  }

  private scheduleWhenEligible(target: AutomaticGitHubSyncTarget): void {
    const previousTimer = this.scheduledTimers.get(target.id);
    if (previousTimer) this.clearTimer(previousTimer);
    const intervalMs = target.intervalMinutes * 60_000;
    const lastSuccess = Date.parse(target.lastSuccessAt || "");
    const lastFailure = Date.parse(target.lastFailure?.at || "");
    const runtimeAttempt = Date.parse(this.states.get(target.id)?.lastAttemptAt || "");
    const lastAttempt = Math.max(
      Number.isFinite(lastSuccess) ? lastSuccess : 0,
      Number.isFinite(lastFailure) ? lastFailure : 0,
      Number.isFinite(runtimeAttempt) ? runtimeAttempt : 0,
    );
    const dueAt = lastAttempt ? lastAttempt + intervalMs : this.now();
    const delay = Math.max(0, dueAt - this.now());
    if (!delay) {
      this.scheduledTimers.delete(target.id);
      void this.drain();
      return;
    }
    const nextSyncAt = new Date(dueAt).toISOString();
    this.updateState(target.id, { ...this.states.get(target.id), status: this.states.get(target.id)?.status === "error" ? "error" : "scheduled", nextSyncAt });
    const timer = this.setTimer(() => {
      this.scheduledTimers.delete(target.id);
      void this.drain();
    }, delay);
    this.scheduledTimers.set(target.id, timer);
  }

  private async drain(): Promise<void> {
    if (this.draining || this.disposed) return;
    this.draining = true;
    try {
      while (!this.disposed && this.pending.size) {
        const ready = [...this.pending.entries()].find(([targetId]) => !this.scheduledTimers.has(targetId));
        if (!ready) break;
        const [targetId, reason] = ready;
        this.pending.delete(targetId);
        const target = this.targets.get(targetId);
        if (!target?.enabled) continue;
        if (reason !== "configuration" && this.options.shouldExecute && !(await this.options.shouldExecute(targetId, reason))) {
          this.updateState(targetId, {
            status: "scheduled",
            reason,
            lastAttemptAt: this.states.get(targetId)?.lastAttemptAt,
            lastSuccessAt: target.lastSuccessAt,
          });
          continue;
        }
        const attemptedAt = new Date(this.now()).toISOString();
        this.updateState(targetId, { ...this.states.get(targetId), status: "syncing", reason, lastAttemptAt: attemptedAt, lastError: undefined, nextSyncAt: undefined });
        try {
          await this.options.execute(targetId, reason);
          const succeededAt = new Date(this.now()).toISOString();
          target.lastSuccessAt = succeededAt;
          target.lastFailure = undefined;
          const current = this.targets.get(targetId);
          if (current) {
            current.lastSuccessAt = succeededAt;
            current.lastFailure = undefined;
          }
          this.updateState(targetId, { status: "scheduled", reason, lastAttemptAt: attemptedAt, lastSuccessAt: succeededAt });
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          target.lastFailure = { at: attemptedAt, error: message, reason };
          this.updateState(targetId, { ...this.states.get(targetId), status: "error", reason, lastAttemptAt: attemptedAt, lastError: message });
          this.pending.set(targetId, reason);
          this.scheduleWhenEligible(target);
        }
      }
    } finally {
      this.draining = false;
      if ([...this.pending.keys()].some(targetId => !this.scheduledTimers.has(targetId)) && !this.disposed) void this.drain();
    }
  }

  private updateState(targetId: string, state: GitHubSyncRuntimeState): void {
    this.states.set(targetId, state);
    this.options.onState?.(targetId, { ...state });
  }

  private reasonPriority(reason: GitHubSyncReason): number {
    return reason === "configuration" ? 4 : reason === "change" ? 3 : reason === "interval" ? 2 : 1;
  }

  private now(): number {
    return (this.options.now || Date.now)();
  }

  private setTimer(callback: () => void, delay: number): NodeJS.Timeout {
    const timer = (this.options.setTimeout || setTimeout)(callback, delay);
    timer.unref?.();
    return timer;
  }

  private clearTimer(timer: NodeJS.Timeout): void {
    (this.options.clearTimeout || clearTimeout)(timer);
  }
}
