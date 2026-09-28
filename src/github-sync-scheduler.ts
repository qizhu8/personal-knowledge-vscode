export type GitHubSyncReason = "startup" | "interval" | "change" | "configuration" | "manual";
export type GitHubSyncPhase = "scheduled" | "waiting-for-lock" | "authenticating" | "fetch" | "resolve-conflicts" | "commit" | "push" | "refresh-index";

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
  phase?: GitHubSyncPhase;
  detail?: string;
  activityAt?: string;
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
  private readonly activeTargets = new Set<string>();
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
    for (const id of this.pending.keys()) if (!activeIds.has(id)) this.pending.delete(id);
    for (const target of targets) {
      this.targets.set(target.id, target);
      const activeFailure = target.lastFailure
        && (!target.lastSuccessAt || target.lastFailure.at > target.lastSuccessAt)
        ? target.lastFailure
        : undefined;
      if (!target.enabled) {
        this.updateState(target.id, {
          status: "paused",
          lastAttemptAt: activeFailure?.at || target.lastSuccessAt,
          lastSuccessAt: target.lastSuccessAt,
          lastError: activeFailure?.error,
        });
        continue;
      }
      const previous = this.states.get(target.id);
      this.states.set(target.id, {
        status: activeFailure ? "error" : "scheduled",
        lastAttemptAt: previous?.lastAttemptAt || activeFailure?.at || target.lastSuccessAt,
        lastSuccessAt: target.lastSuccessAt,
        lastError: activeFailure?.error,
      });
      this.enqueue(target.id, "startup");
    }
  }

  request(targetId: string, reason: GitHubSyncReason): boolean {
    const target = this.targets.get(targetId);
    if (this.disposed || !target || (!target.enabled && reason !== "manual")) return false;
    if (reason === "manual" && (this.activeTargets.has(targetId) || this.pending.get(targetId) === "manual")) return false;
    this.enqueue(targetId, reason);
    return true;
  }

  report(targetId: string, phase: GitHubSyncPhase, detail?: string): void {
    if (this.disposed || !this.targets.has(targetId)) return;
    this.updateState(targetId, {
      ...this.states.get(targetId),
      status: "syncing",
      phase,
      detail,
      activityAt: new Date(this.now()).toISOString(),
    });
  }

  private enqueue(targetId: string, reason: GitHubSyncReason): void {
    const target = this.targets.get(targetId);
    if (this.disposed || !target || (!target.enabled && reason !== "manual")) return;
    const current = this.pending.get(targetId);
    if (!current || this.reasonPriority(reason) > this.reasonPriority(current)) this.pending.set(targetId, reason);
    if (reason === "configuration" || reason === "manual") {
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
        if (!target || (!target.enabled && reason !== "manual")) continue;
        const attemptedAt = new Date(this.now()).toISOString();
        this.activeTargets.add(targetId);
        const currentState = this.states.get(targetId);
        if (currentState) this.states.set(targetId, { ...currentState, lastAttemptAt: attemptedAt, nextSyncAt: undefined });
        try {
          if (this.options.shouldExecute && !(await this.options.shouldExecute(targetId, reason))) {
            this.updateState(targetId, {
              status: "scheduled",
              reason,
              lastAttemptAt: attemptedAt,
              lastSuccessAt: target.lastSuccessAt,
            });
            this.scheduleNextInterval(target);
            continue;
          }
          this.updateState(targetId, { ...this.states.get(targetId), status: "syncing", phase: "waiting-for-lock", detail: "Waiting for Git lock", activityAt: attemptedAt, reason, lastAttemptAt: attemptedAt, lastError: undefined, nextSyncAt: undefined });
          await this.options.execute(targetId, reason);
          const succeededAt = new Date(this.now()).toISOString();
          target.lastSuccessAt = succeededAt;
          target.lastFailure = undefined;
          const current = this.targets.get(targetId);
          if (!current) {
            this.states.delete(targetId);
            this.pending.delete(targetId);
            continue;
          }
          current.lastSuccessAt = succeededAt;
          current.lastFailure = undefined;
          this.updateState(targetId, {
            status: target.enabled ? "scheduled" : "paused",
            phase: target.enabled ? "scheduled" : undefined,
            detail: target.enabled ? "Next fetch scheduled" : "Automatic pull/push is off",
            activityAt: succeededAt,
            reason,
            lastAttemptAt: attemptedAt,
            lastSuccessAt: succeededAt,
          });
          this.scheduleNextInterval(target);
        } catch (error) {
          if (!this.targets.has(targetId)) {
            this.states.delete(targetId);
            this.pending.delete(targetId);
            continue;
          }
          const message = error instanceof Error ? error.message : String(error);
          target.lastFailure = { at: attemptedAt, error: message, reason };
          this.updateState(targetId, { ...this.states.get(targetId), status: "error", reason, lastAttemptAt: attemptedAt, lastError: message });
          if (target.enabled) {
            this.pending.set(targetId, reason);
            this.scheduleWhenEligible(target);
          }
        } finally {
          this.activeTargets.delete(targetId);
        }
      }
    } finally {
      this.draining = false;
      if ([...this.pending.keys()].some(targetId => !this.scheduledTimers.has(targetId)) && !this.disposed) void this.drain();
    }
  }

  private scheduleNextInterval(target: AutomaticGitHubSyncTarget): void {
    if (this.disposed || !this.targets.has(target.id) || !target.enabled || this.pending.has(target.id)) return;
    this.pending.set(target.id, "interval");
    this.scheduleWhenEligible(target);
  }

  private updateState(targetId: string, state: GitHubSyncRuntimeState): void {
    this.states.set(targetId, state);
    this.options.onState?.(targetId, { ...state });
  }

  private reasonPriority(reason: GitHubSyncReason): number {
    return reason === "manual" ? 5 : reason === "configuration" ? 4 : reason === "change" ? 3 : reason === "interval" ? 2 : 1;
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
