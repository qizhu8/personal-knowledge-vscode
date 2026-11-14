import * as fs from "fs";
import * as path from "path";
import { createHash, randomUUID } from "crypto";
import { withCrossProcessLockSync } from "../runtime/cross-process-lock";
import {
  AutomaticGitHubSyncTarget,
  GitHubSyncBlockedError,
  GitHubSyncReason,
  GitHubSyncRuntimeState,
  GitHubSyncScheduler,
  MAX_GITHUB_SYNC_FAILURE_ATTEMPTS,
  isGitHubSyncAuthenticationFailure,
} from "./github-sync-scheduler";
import { compareVersionOrder } from "../runtime/version-order";

interface CoordinatorLeader {
  pid: number;
  nonce: string;
  heartbeatAt: number;
  leaseUntil: number;
  fencingToken: number;
  independentService?: boolean;
  extensionVersion?: string;
}

interface CoordinatorIntent {
  reason: GitHubSyncReason;
  requestedAt: string;
  sequence: number;
}

interface CoordinatorBlock {
  reason: GitHubSyncReason;
  requiredVersion: string;
  installedVersion: string;
  blockedAt: string;
}

interface CoordinatorClaim extends CoordinatorIntent {
  leaderNonce: string;
  fencingToken: number;
  claimedAt: string;
}

interface CoordinatorState {
  schema: 1;
  nextFencingToken: number;
  nextIntentSequence: number;
  configurationRevision: number;
  targets: Record<string, AutomaticGitHubSyncTarget>;
  leader?: CoordinatorLeader;
  intents: Record<string, CoordinatorIntent>;
  claims: Record<string, CoordinatorClaim>;
  blocked: Record<string, CoordinatorBlock>;
  runtime: Record<string, GitHubSyncRuntimeState>;
}

export interface GitHubSyncCompatibilityBlock {
  requiredVersion: string;
  installedVersion: string;
}

export interface GitHubSyncCoordinatorOptions {
  stateDirectory: string;
  knowledgeRoot: string;
  extensionVersion: string;
  independentService?: boolean;
  shouldExecute?: (targetId: string, reason: GitHubSyncReason) => Promise<boolean>;
  execute: (targetId: string, reason: GitHubSyncReason, fencingToken: number) => Promise<void>;
  shouldRetryFailure?: (error: unknown) => boolean;
  onAutoPaused?: (targetId: string) => void;
  compatibilityBlock?: (error: unknown) => GitHubSyncCompatibilityBlock | undefined;
  onState?: (targetId: string, state: GitHubSyncRuntimeState) => void;
  now?: () => number;
  heartbeatMs?: number;
  leaseMs?: number;
  pollMs?: number;
  changeDebounceMs?: number;
}

const PRIORITY: Record<GitHubSyncReason, number> = {
  startup: 1,
  interval: 2,
  change: 3,
  configuration: 4,
  manual: 5,
  "force-local-authority": 6,
};

function emptyState(): CoordinatorState {
  return {
    schema: 1,
    nextFencingToken: 0,
    nextIntentSequence: 0,
    configurationRevision: 0,
    targets: {},
    intents: {},
    claims: {},
    blocked: {},
    runtime: {},
  };
}

function processAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true; }
  catch (error: any) { return error?.code === "EPERM"; }
}

function readState(filePath: string): CoordinatorState {
  try {
    const parsed = JSON.parse(fs.readFileSync(filePath, "utf8")) as CoordinatorState;
    if (parsed.schema !== 1) return emptyState();
    return {
      ...emptyState(),
      ...parsed,
      targets: parsed.targets || {},
      intents: parsed.intents || {},
      claims: parsed.claims || {},
      blocked: parsed.blocked || {},
      runtime: parsed.runtime || {},
    };
  } catch (error: any) {
    if (error?.code === "ENOENT") return emptyState();
    throw error;
  }
}

function retryable(error: any): boolean {
  return error?.code === "EPERM" || error?.code === "EBUSY" || error?.code === "EACCES";
}

function writeState(filePath: string, state: CoordinatorState): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const temporary = `${filePath}.${process.pid}.${randomUUID()}.tmp`;
  fs.writeFileSync(temporary, JSON.stringify(state, null, 2) + "\n", { encoding: "utf8", mode: 0o600, flag: "wx" });
  try {
    for (let attempt = 0; ; attempt++) {
      try {
        fs.renameSync(temporary, filePath);
        break;
      } catch (error) {
        if (!retryable(error) || attempt >= 7) throw error;
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 15 * (attempt + 1));
      }
    }
  } finally {
    try { fs.rmSync(temporary, { force: true, maxRetries: 4, retryDelay: 20 }); } catch { /* best effort */ }
  }
}

function versionAtLeast(installed: string, required: string): boolean {
  const order = compareVersionOrder(installed, required);
  return order !== undefined && order >= 0;
}

export function canonicalKnowledgeRoot(
  knowledgeRoot: string,
  platform: NodeJS.Platform = process.platform,
  realpath: (value: string) => string = value => fs.realpathSync.native(value),
): string {
  let canonical = realpath((platform === "win32" ? path.win32 : path).resolve(knowledgeRoot)).normalize("NFC").replace(/\\/g, "/");
  canonical = canonical.replace(/\/+$/, "") || "/";
  if (platform === "win32") canonical = canonical.toLocaleLowerCase("en-US");
  return canonical;
}

export function githubSyncCoordinatorDirectory(
  globalStoragePath: string,
  knowledgeRoot: string,
  platform: NodeJS.Platform = process.platform,
  realpath?: (value: string) => string,
): string {
  const identity = canonicalKnowledgeRoot(knowledgeRoot, platform, realpath);
  const digest = createHash("sha256").update(identity).digest("hex");
  return path.join(globalStoragePath, "github-sync", "coordinators", digest);
}

export function sameKnowledgeRoot(
  left: string, right: string, platform: NodeJS.Platform = process.platform,
  realpath: (value: string) => string = value => fs.realpathSync.native(value),
): boolean {
  const normalize = (value: string): string => canonicalKnowledgeRoot(value, platform, resolved => {
    try { return realpath(resolved); }
    catch (error) {
      if (!(error instanceof Error) || !("code" in error) || !["ENOENT", "ENOTDIR"].includes(String(error.code))) throw error;
      return resolved;
    }
  });
  return normalize(left) === normalize(right);
}

export class GitHubSyncCoordinator {
  readonly instanceNonce = randomUUID();
  private readonly statePath: string;
  private readonly lockPath: string;
  private readonly targets = new Map<string, AutomaticGitHubSyncTarget>();
  private readonly changeTimers = new Map<string, NodeJS.Timeout>();
  private scheduler: GitHubSyncScheduler | undefined;
  private timer: NodeJS.Timeout | undefined;
  private ticking = false;
  private disposed = false;
  private leaderToken = 0;
  private configurationRevision = 0;
  private schedulerRevision = -1;
  private cachedRuntime: Record<string, GitHubSyncRuntimeState> = {};
  private readonly publishedRuntime = new Map<string, string>();
  private readonly executingIntentSequences = new Map<string, number>();
  private readonly dispatchedIntentSequences = new Map<string, number>();

  constructor(private readonly options: GitHubSyncCoordinatorOptions) {
    this.statePath = path.join(options.stateDirectory, "coordinator.json");
    this.lockPath = path.join(options.stateDirectory, "coordinator.lock");
    fs.mkdirSync(options.stateDirectory, { recursive: true });
    this.cachedRuntime = readState(this.statePath).runtime;
    this.timer = setInterval(() => void this.tick(), options.pollMs ?? options.heartbeatMs ?? 750);
    this.timer.unref?.();
    void this.tick();
  }

  configure(targets: AutomaticGitHubSyncTarget[]): void {
    this.targets.clear();
    for (const target of targets) this.targets.set(target.id, { ...target });
    const activeIds = new Set(targets.map(target => target.id));
    for (const id of this.dispatchedIntentSequences.keys()) if (!activeIds.has(id)) this.dispatchedIntentSequences.delete(id);
    this.configurationRevision = this.mutateSync(state => {
      state.configurationRevision += 1;
      state.targets = Object.fromEntries(targets.map(target => [target.id, { ...target }]));
      for (const targetId of Object.keys(state.intents)) if (!activeIds.has(targetId)) delete state.intents[targetId];
      for (const targetId of Object.keys(state.claims)) if (!activeIds.has(targetId)) delete state.claims[targetId];
      for (const target of targets) {
        if (target.enabled && !target.needsAttention && (!target.lastFailure || isGitHubSyncAuthenticationFailure(target.lastFailure)
          || (target.lastFailure.attempts || 1) < MAX_GITHUB_SYNC_FAILURE_ATTEMPTS)) continue;
        if (state.intents[target.id]?.reason !== "manual" && state.intents[target.id]?.reason !== "force-local-authority") delete state.intents[target.id];
      }
      for (const targetId of Object.keys(state.blocked)) if (!activeIds.has(targetId)) delete state.blocked[targetId];
      for (const targetId of Object.keys(state.runtime)) if (!activeIds.has(targetId)) delete state.runtime[targetId];
      return state.configurationRevision;
    });
    void this.tick();
  }

  request(targetId: string, reason: GitHubSyncReason): boolean {
    const target = this.targets.get(targetId);
    if (this.disposed || !target || (!target.enabled && reason !== "manual" && reason !== "force-local-authority")) return false;
    if (target.needsAttention && reason !== "manual" && reason !== "force-local-authority") return false;
    if (reason !== "manual" && reason !== "force-local-authority" && target.lastFailure
      && (reason === "change" || reason === "configuration"
        || !isGitHubSyncAuthenticationFailure(target.lastFailure) && (target.lastFailure.attempts || 1) >= MAX_GITHUB_SYNC_FAILURE_ATTEMPTS)) return false;
    return this.mutateSync(state => {
      const current = state.intents[targetId];
      if (current && PRIORITY[current.reason] >= PRIORITY[reason]) return false;
      state.nextIntentSequence += 1;
      state.intents[targetId] = { reason, requestedAt: new Date(this.now()).toISOString(), sequence: state.nextIntentSequence };
      return true;
    });
  }

  report(targetId: string, phase: Parameters<GitHubSyncScheduler["report"]>[1], detail?: string): void {
    this.scheduler?.report(targetId, phase, detail);
  }

  notifyContentChanged(excludedTargetId?: string): void {
    for (const target of this.targets.values()) {
      if (target.id === excludedTargetId || !target.enabled || !target.syncOnChange || target.lastFailure || target.needsAttention) continue;
      const existing = this.changeTimers.get(target.id);
      if (existing) clearTimeout(existing);
      const timer = setTimeout(() => {
        this.changeTimers.delete(target.id);
        this.request(target.id, "change");
      }, this.options.changeDebounceMs ?? 2_000);
      timer.unref?.();
      this.changeTimers.set(target.id, timer);
    }
  }

  snapshot(): Record<string, GitHubSyncRuntimeState> {
    return Object.fromEntries(Object.entries(this.cachedRuntime).map(([id, state]) => [id, { ...state }]));
  }

  isLeader(): boolean {
    if (this.disposed || !this.leaderToken) return false;
    const leader = readState(this.statePath).leader;
    return leader?.nonce === this.instanceNonce && leader.pid === process.pid
      && leader.fencingToken === this.leaderToken && leader.leaseUntil > this.now();
  }

  dispose(): void {
    this.disposed = true;
    if (this.timer) clearInterval(this.timer);
    for (const timer of this.changeTimers.values()) clearTimeout(timer);
    this.changeTimers.clear();
    this.scheduler?.dispose();
    this.scheduler = undefined;
    this.dispatchedIntentSequences.clear();
    try {
      this.mutateSync(state => {
        if (state.leader?.nonce === this.instanceNonce && state.leader.fencingToken === this.leaderToken) delete state.leader;
      });
    } catch { /* lease expiry recovers ownership */ }
  }

  private async tick(): Promise<void> {
    if (this.disposed || this.ticking) return;
    this.ticking = true;
    try {
      const now = this.now();
      const leaseMs = this.options.leaseMs ?? 5_000;
      const state = await this.mutate(state => {
        for (const [targetId, blocked] of Object.entries(state.blocked)) {
          if (!versionAtLeast(this.options.extensionVersion, blocked.requiredVersion)) continue;
          state.nextIntentSequence += 1;
          state.intents[targetId] = {
            reason: blocked.reason,
            requestedAt: new Date(now).toISOString(),
            sequence: state.nextIntentSequence,
          };
          delete state.blocked[targetId];
        }
        const leader = state.leader;
        const ownsLease = leader?.nonce === this.instanceNonce && leader.pid === process.pid;
        const stale = !leader || leader.leaseUntil <= now || !processAlive(leader.pid);
        const legacyDrained = !!this.options.independentService && !!leader && !leader.independentService
          && !Object.values(state.claims).some(claim => claim.leaderNonce === leader.nonce)
          && !Object.values(state.runtime).some(runtime => runtime.status === "syncing")
          && !fs.existsSync(path.join(this.options.stateDirectory, "apply.lock"));
        if (ownsLease || stale || legacyDrained) {
          if (!ownsLease) {
            for (const [targetId, claim] of Object.entries(state.claims)) {
              if (leader && (claim.leaderNonce !== leader.nonce || claim.fencingToken !== leader.fencingToken)) continue;
              if (state.targets[targetId]?.lastFailure) {
                delete state.claims[targetId];
                continue;
              }
              const pending = state.intents[targetId];
              if (!pending || PRIORITY[claim.reason] > PRIORITY[pending.reason]) {
                state.intents[targetId] = {
                  reason: claim.reason,
                  requestedAt: claim.requestedAt,
                  sequence: claim.sequence,
                };
              }
              delete state.claims[targetId];
            }
            state.nextFencingToken = Math.max(state.nextFencingToken, leader?.fencingToken || 0) + 1;
            state.leader = {
              pid: process.pid,
              nonce: this.instanceNonce,
              heartbeatAt: now,
              leaseUntil: now + leaseMs,
              fencingToken: state.nextFencingToken,
              ...(this.options.independentService ? { independentService: true, extensionVersion: this.options.extensionVersion } : {}),
            };
          } else {
            leader.heartbeatAt = now;
            leader.leaseUntil = now + leaseMs;
          }
        }
        return state;
      });
      if (state.configurationRevision > this.configurationRevision) {
        this.configurationRevision = state.configurationRevision;
        this.targets.clear();
        for (const target of Object.values(state.targets)) this.targets.set(target.id, { ...target });
      }
      this.publishObservedState(state);
      const owns = state.leader?.nonce === this.instanceNonce && state.leader.pid === process.pid && state.leader.leaseUntil > now;
      if (!owns) {
        this.leaderToken = 0;
        this.scheduler?.dispose();
        this.scheduler = undefined;
        return;
      }
      this.leaderToken = state.leader!.fencingToken;
      this.ensureScheduler();
      for (const [targetId, intent] of Object.entries(state.intents)) {
        if (!this.targets.has(targetId)) continue;
        if (this.dispatchedIntentSequences.get(targetId) === intent.sequence) continue;
        if (!this.scheduler!.request(targetId, intent.reason)) continue;
        this.dispatchedIntentSequences.set(targetId, intent.sequence);
      }
    } finally {
      this.ticking = false;
    }
  }

  private ensureScheduler(): void {
    if (!this.scheduler) {
      this.scheduler = new GitHubSyncScheduler({
        shouldExecute: async (targetId, reason) => {
          const intent = readState(this.statePath).intents[targetId];
          this.executingIntentSequences.delete(targetId);
          if (intent?.reason === reason) this.executingIntentSequences.set(targetId, intent.sequence);
          return this.options.shouldExecute ? this.options.shouldExecute(targetId, reason) : true;
        },
        shouldRetryFailure: this.options.shouldRetryFailure,
        onAutoPaused: targetId => {
          const target = this.targets.get(targetId);
          if (!target) return;
          target.enabled = false;
          this.configurationRevision = this.mutateSync(state => {
            if (state.targets[targetId]) {
              state.targets[targetId].enabled = false;
              state.targets[targetId].lastFailure = target.lastFailure;
            }
            state.configurationRevision += 1;
            return state.configurationRevision;
          });
          this.schedulerRevision = this.configurationRevision;
          this.options.onAutoPaused?.(targetId);
        },
        beforeExecute: async (targetId, reason) => {
          return this.mutateSync(state => {
            const intent = state.intents[targetId];
            const leader = state.leader;
            const existing = state.claims[targetId];
            if (leader?.nonce !== this.instanceNonce || leader.fencingToken !== this.leaderToken || leader.leaseUntil <= this.now()) throw new Error("GitHub Sync coordinator leadership changed before execution.");
            if (existing?.reason === reason && existing.sequence === this.executingIntentSequences.get(targetId)
              && existing.leaderNonce === this.instanceNonce && existing.fencingToken === this.leaderToken) return true;
            if (!intent && (reason === "startup" || reason === "interval")) return true;
            if (!intent || intent.reason !== reason || intent.sequence !== this.executingIntentSequences.get(targetId)) return false;
            state.claims[targetId] = {
              ...intent,
              leaderNonce: this.instanceNonce,
              fencingToken: this.leaderToken,
              claimedAt: new Date(this.now()).toISOString(),
            };
            delete state.intents[targetId];
            return true;
          });
        },
        onSettled: (targetId, reason, outcome) => {
          if (this.dispatchedIntentSequences.get(targetId) === this.executingIntentSequences.get(targetId)) this.dispatchedIntentSequences.delete(targetId);
          if (outcome === "succeeded") {
            const target = this.targets.get(targetId);
            const succeededAt = new Date(this.now()).toISOString();
            if (target) {
              target.needsAttention = false;
              target.lastFailure = undefined;
              target.lastSuccessAt = succeededAt;
            }
            this.mutateSync(state => {
              const current = state.targets[targetId];
              if (current) {
                current.needsAttention = false;
                current.lastFailure = undefined;
                current.lastSuccessAt = succeededAt;
              }
            });
            this.resolveOwnedClaim(targetId, reason);
            this.resolvePendingIntent(targetId, reason);
          }
          if (outcome === "attention") {
            const target = this.targets.get(targetId);
            if (target) target.needsAttention = true;
            this.mutateSync(state => { if (state.targets[targetId]) state.targets[targetId].needsAttention = true; });
            this.resolveOwnedClaim(targetId, reason);
            this.resolvePendingIntent(targetId, reason);
          }
          if (outcome === "skipped") this.resolvePendingIntent(targetId, reason);
          if (outcome === "deferred") {
            this.resolveOwnedClaim(targetId, reason);
            this.resolvePendingIntent(targetId, reason);
          }
          if (outcome === "failed") {
            const runtime = this.scheduler?.snapshot()[targetId];
            const target = this.targets.get(targetId);
            if (target && runtime?.lastAttemptAt && runtime.lastError) {
              target.lastFailure = {
                at: target.lastFailure?.at || runtime.lastAttemptAt, error: runtime.lastError, reason,
                attempts: target.lastFailure?.attempts || 1,
                errorCode: runtime.lastErrorCode, phase: runtime.lastErrorPhase,
                ...(target.lastFailure?.retryable === false ? { retryable: false } : {}),
              };
              this.mutateSync(state => { if (state.targets[targetId]) state.targets[targetId].lastFailure = target.lastFailure; });
            }
            this.resolveOwnedClaim(targetId, reason);
            this.resolvePendingIntent(targetId, reason);
          }
        },
        execute: async (targetId, reason) => {
          this.verifyOwnership();
          try {
            await this.options.execute(targetId, reason, this.leaderToken);
            this.resolveOwnedClaim(targetId, reason);
          } catch (error) {
            const block = this.options.compatibilityBlock?.(error);
            if (!block) throw error;
            await this.mutate(state => {
              const claim = state.claims[targetId];
              state.blocked[targetId] = {
                reason: claim?.reason || reason,
                requiredVersion: block.requiredVersion,
                installedVersion: block.installedVersion,
                blockedAt: new Date(this.now()).toISOString(),
              };
              if (claim?.leaderNonce === this.instanceNonce && claim.fencingToken === this.leaderToken) delete state.claims[targetId];
            });
            throw new GitHubSyncBlockedError(block.requiredVersion, block.installedVersion, reason);
          }
        },
        onState: (targetId, runtime) => {
          this.cachedRuntime[targetId] = runtime;
          this.emitState(targetId, runtime);
          void this.mutate(state => {
            if (state.leader?.nonce === this.instanceNonce && state.leader.fencingToken === this.leaderToken) {
              state.runtime[targetId] = runtime;
            }
          });
        },
      });
    }
    if (this.schedulerRevision !== this.configurationRevision) {
      this.schedulerRevision = this.configurationRevision;
      this.scheduler.configure([...this.targets.values()]);
    }
  }

  private verifyOwnership(): void {
    const leader = readState(this.statePath).leader;
    if (leader?.nonce !== this.instanceNonce || leader.pid !== process.pid || leader.fencingToken !== this.leaderToken || leader.leaseUntil <= this.now()) {
      throw new Error("GitHub Sync coordinator leadership changed before execution.");
    }
  }

  private resolveOwnedClaim(targetId: string, reason: GitHubSyncReason): void {
    this.mutateSync(state => {
      const claim = state.claims[targetId];
      if (claim?.reason === reason && claim.sequence === this.executingIntentSequences.get(targetId)
        && claim.leaderNonce === this.instanceNonce && claim.fencingToken === this.leaderToken) {
        delete state.claims[targetId];
      }
    });
  }

  private resolvePendingIntent(targetId: string, reason: GitHubSyncReason): void {
    this.mutateSync(state => {
      const intent = state.intents[targetId];
      if (intent?.reason === reason && intent.sequence === this.executingIntentSequences.get(targetId)) delete state.intents[targetId];
    });
  }

  private publishObservedState(state: CoordinatorState): void {
    const ownsLeadership = state.leader?.nonce === this.instanceNonce && state.leader.pid === process.pid;
    this.cachedRuntime = Object.fromEntries(Object.entries(state.runtime).map(([id, runtime]) => [
      id,
      !ownsLeadership && runtime.status === "syncing"
        ? {
          ...runtime,
          status: "queued",
          detail: `Running in the ${state.leader?.independentService ? `PKM singleton service ${state.leader.extensionVersion || ""}` : "shared leader window"}${runtime.detail ? ` · ${runtime.detail}` : ""}`,
        }
        : { ...runtime },
    ]));
    for (const [targetId, blocked] of Object.entries(state.blocked)) {
      this.cachedRuntime[targetId] = {
        ...this.cachedRuntime[targetId],
        status: "blocked",
        detail: `Waiting for Personal Knowledge Manager ${blocked.requiredVersion} or newer`,
        reason: blocked.reason,
        blocked: { requiredVersion: blocked.requiredVersion, installedVersion: blocked.installedVersion },
      };
    }
    for (const [targetId, intent] of Object.entries(state.intents)) {
      if (this.cachedRuntime[targetId]?.status === "syncing" || this.cachedRuntime[targetId]?.status === "blocked") continue;
      this.cachedRuntime[targetId] = {
        ...this.cachedRuntime[targetId],
        status: "queued",
        detail: ownsLeadership ? "Queued by this window" : "Queued for the shared GitHub Sync leader",
        reason: intent.reason,
      };
    }
    for (const [targetId, runtime] of Object.entries(this.cachedRuntime)) this.emitState(targetId, runtime);
  }

  private emitState(targetId: string, runtime: GitHubSyncRuntimeState): void {
    const serialized = JSON.stringify(runtime);
    if (this.publishedRuntime.get(targetId) === serialized) return;
    this.publishedRuntime.set(targetId, serialized);
    this.options.onState?.(targetId, { ...runtime });
  }

  private now(): number {
    return (this.options.now || Date.now)();
  }

  private mutateSync<T>(action: (state: CoordinatorState) => T): T {
    return withCrossProcessLockSync(this.lockPath, "GitHub Sync coordinator state", () => {
      const state = readState(this.statePath);
      const before = JSON.stringify(state);
      const result = action(state);
      if (JSON.stringify(state) !== before) writeState(this.statePath, state);
      return result;
    });
  }

  private async mutate<T>(action: (state: CoordinatorState) => T): Promise<T> {
    return this.mutateSync(action);
  }
}
