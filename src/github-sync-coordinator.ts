import * as fs from "fs";
import * as path from "path";
import { createHash, randomUUID } from "crypto";
import { withCrossProcessLockSync } from "./cross-process-lock";
import {
  AutomaticGitHubSyncTarget,
  GitHubSyncBlockedError,
  GitHubSyncReason,
  GitHubSyncRuntimeState,
  GitHubSyncScheduler,
} from "./github-sync-scheduler";
import { compareVersionOrder } from "./version-order";

interface CoordinatorLeader {
  pid: number;
  nonce: string;
  heartbeatAt: number;
  leaseUntil: number;
  fencingToken: number;
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
  shouldExecute?: (targetId: string, reason: GitHubSyncReason) => Promise<boolean>;
  execute: (targetId: string, reason: GitHubSyncReason, fencingToken: number) => Promise<void>;
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
  let canonical = realpath(path.resolve(knowledgeRoot)).normalize("NFC").replace(/\\/g, "/");
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
    this.configurationRevision = this.mutateSync(state => {
      state.configurationRevision += 1;
      state.targets = Object.fromEntries(targets.map(target => [target.id, { ...target }]));
      for (const targetId of Object.keys(state.intents)) if (!activeIds.has(targetId)) delete state.intents[targetId];
      for (const targetId of Object.keys(state.claims)) if (!activeIds.has(targetId)) delete state.claims[targetId];
      for (const targetId of Object.keys(state.blocked)) if (!activeIds.has(targetId)) delete state.blocked[targetId];
      for (const targetId of Object.keys(state.runtime)) if (!activeIds.has(targetId)) delete state.runtime[targetId];
      return state.configurationRevision;
    });
    void this.tick();
  }

  request(targetId: string, reason: GitHubSyncReason): boolean {
    const target = this.targets.get(targetId);
    if (this.disposed || !target || (!target.enabled && reason !== "manual" && reason !== "force-local-authority")) return false;
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
      if (target.id === excludedTargetId || !target.enabled || !target.syncOnChange) continue;
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

  dispose(): void {
    this.disposed = true;
    if (this.timer) clearInterval(this.timer);
    for (const timer of this.changeTimers.values()) clearTimeout(timer);
    this.changeTimers.clear();
    this.scheduler?.dispose();
    this.scheduler = undefined;
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
        if (ownsLease || stale) {
          if (!ownsLease) {
            for (const [targetId, claim] of Object.entries(state.claims)) {
              if (leader && (claim.leaderNonce !== leader.nonce || claim.fencingToken !== leader.fencingToken)) continue;
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
        if (!this.scheduler!.request(targetId, intent.reason)) continue;
      }
    } finally {
      this.ticking = false;
    }
  }

  private ensureScheduler(): void {
    if (!this.scheduler) {
      this.scheduler = new GitHubSyncScheduler({
        shouldExecute: this.options.shouldExecute,
        beforeExecute: async (targetId, reason) => {
          this.mutateSync(state => {
            const intent = state.intents[targetId];
            const leader = state.leader;
            const existing = state.claims[targetId];
            if (existing?.reason === reason && existing.leaderNonce === this.instanceNonce && existing.fencingToken === this.leaderToken) return;
            if (!intent && (reason === "startup" || reason === "interval")) return;
            if (!intent || intent.reason !== reason || leader?.nonce !== this.instanceNonce || leader.fencingToken !== this.leaderToken) {
              throw new Error("GitHub Sync durable intent was not available to claim before execution.");
            }
            state.claims[targetId] = {
              ...intent,
              leaderNonce: this.instanceNonce,
              fencingToken: this.leaderToken,
              claimedAt: new Date(this.now()).toISOString(),
            };
            delete state.intents[targetId];
          });
        },
        onSettled: (targetId, reason, outcome) => {
          if (outcome !== "skipped") return;
          this.resolvePendingIntent(targetId, reason);
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
      if (claim?.reason === reason && claim.leaderNonce === this.instanceNonce && claim.fencingToken === this.leaderToken) {
        delete state.claims[targetId];
      }
    });
  }

  private resolvePendingIntent(targetId: string, reason: GitHubSyncReason): void {
    this.mutateSync(state => {
      if (state.intents[targetId]?.reason === reason) delete state.intents[targetId];
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
          detail: `Running in the shared leader window${runtime.detail ? ` · ${runtime.detail}` : ""}`,
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
