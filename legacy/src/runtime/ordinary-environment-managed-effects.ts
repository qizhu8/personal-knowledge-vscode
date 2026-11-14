import * as fs from "node:fs";
import { isDeepStrictEqual } from "node:util";
import type { ChildProcess } from "node:child_process";
import { HostWriterAdmission } from "./host-writer-admission";
import type { OrdinaryEnvironmentManagedEffects } from "./ordinary-environment-vscode-authority";
import { assertOrdinaryEnvironmentRefreshCompletion,
  type OrdinaryEnvironmentRefreshIntent, type EnvironmentQueryTrace, type OrdinaryEnvironmentRefreshCompletion } from "./ordinary-environment-owner";
import { describePreparedLinuxEnvironmentQuery, environmentDrainProof,
  assertPreparedLinuxEnvironmentDrainProof, type PreparedLinuxEnvironmentQuery, type LinuxEnvironmentDrainProof } from "./linux-environment-supervisor";

type Lifetime = { signal: AbortSignal; expiresAtMs: number };
type Binding = Pick<OrdinaryEnvironmentRefreshIntent, "workspaceId" | "knowledgeRoot" | "globalStorageDirectory">;
type Record<R> = { prepared: PreparedLinuxEnvironmentQuery; registration: R; trace: Readonly<EnvironmentQueryTrace>;
  child?: ChildProcess; proof?: LinuxEnvironmentDrainProof };
type Phase = "legacy" | "handoff" | "owner" | "closed" | "unknown";
function fence(check: () => unknown): void {
  const result = check();
  if (result !== undefined) {
    if (result && typeof (result as PromiseLike<unknown>).then === "function") void Promise.resolve(result).catch(() => {});
    throw new Error("Managed Environment fences must synchronously return undefined.");
  }
}
function pin(directory: string): string {
  const stat = fs.lstatSync(directory, { bigint: true });
  if (!stat.isDirectory() || stat.isSymbolicLink() || fs.realpathSync(directory) !== directory)
    throw new Error("Managed Environment requires canonical Root/profile directories.");
  return `${stat.dev}:${stat.ino}`;
}

/**
 * Explicitly enrolled same-host writer subset, not a scanner or production grant.
 * Root supplies independent profile coverage and specialized durable registrations.
 */
export class ManagedOrdinaryEnvironmentProfileWriter<R extends object> {
  private phase: Phase = "legacy";
  private readonly rootPin: string;
  private readonly profilePin: string;
  private writeTail: Promise<void> = Promise.resolve();
  private readonly scopes = new Set<{
    finished: Promise<void>; records: Map<PreparedLinuxEnvironmentQuery, Record<R>>; failed: boolean;
  }>();
  private readonly requests = new Set<string>();
  private failure?: unknown;
  private unregisterRoot: () => void = () => {};
  private unregisterEnvironment: () => void = () => {};
  private readonly onAbort = () => {
    void this.close().catch(error => { try { fence(() => this.options.onCloseError(error)); } catch {} });
  };
  constructor(private readonly options: {
    binding: Binding;
    hostAdmission: HostWriterAdmission;
    supervisorPython: string;
    environment: NodeJS.ProcessEnv;
    assertHostCurrent(): void;
    assertExclusiveProfileWriter(): void;
    assertExecutionAuthority(trace: Readonly<EnvironmentQueryTrace>): void;
    signal: AbortSignal;
    onCloseError(error: unknown): void;
    registerRootChildClose(close: () => Promise<void>): () => void;
    registerEnvironmentChildClose(close: () => Promise<void>): () => void;
    begin(prepared: PreparedLinuxEnvironmentQuery): R;
    complete(registration: R, proof: LinuxEnvironmentDrainProof, transaction: OrdinaryEnvironmentRefreshCompletion): void;
  }) {
    this.options = Object.freeze({ ...options, binding: Object.freeze({ ...options.binding }),
      environment: Object.freeze({ ...options.environment }) });
    if (!(options.hostAdmission instanceof HostWriterAdmission)) throw new Error("Actual managed host writer admission is required.");
    for (const key of ["assertHostCurrent", "assertExclusiveProfileWriter", "assertExecutionAuthority",
      "registerRootChildClose", "registerEnvironmentChildClose", "onCloseError", "begin", "complete"] as const)
      if (typeof options[key] !== "function") throw new Error("Independent managed Environment authorities are required.");
    this.rootPin = pin(options.binding.knowledgeRoot);
    this.profilePin = pin(options.binding.globalStorageDirectory);
    this.current();
    this.unregisterRoot = options.registerRootChildClose(() => this.close());
    try { this.unregisterEnvironment = options.registerEnvironmentChildClose(() => this.close()); }
    catch (error) { this.unregisterRoot(); throw error; }
    options.signal.addEventListener("abort", this.onAbort, { once: true });
    if (options.signal.aborted) this.onAbort();
  }
  private current(): void {
    fence(this.options.assertHostCurrent);
    if (!this.options.signal || this.options.signal.aborted) throw new Error("Managed Environment host scope is revoked.");
    if (pin(this.options.binding.knowledgeRoot) !== this.rootPin || pin(this.options.binding.globalStorageDirectory) !== this.profilePin)
      throw new Error("Managed Environment Root/profile binding changed.");
  }
  private exclusive(): void { this.current(); fence(this.options.assertExclusiveProfileWriter); this.current(); }
  status() {
    return Object.freeze({ phase: this.phase, pendingIntents: this.scopes.size,
      completeHostCoverage: false as const, productionCutoverAuthorized: false as const });
  }
  /** Close only this profile's new legacy admissions, not unrelated Root scopes. */
  async handoff(): Promise<void> {
    if (this.phase === "unknown") throw new Error("UNKNOWN: managed Environment writer outcome is unresolved.");
    if (this.phase !== "legacy" && this.phase !== "handoff") throw new Error("Managed Environment handoff is unavailable.");
    this.phase = "handoff";
    await Promise.allSettled([...this.scopes].map(scope => scope.finished));
    await this.writeTail;
    if (this.failure || [...this.scopes].some(scope => scope.failed || scope.records.size)) {
      this.phase = "unknown";
      throw new Error("UNKNOWN: managed profile Refresh failed or has pending physical/transaction outcomes.");
    }
    try { this.exclusive(); }
    catch (error) { this.phase = "unknown"; this.failure = error; throw error; }
    this.phase = "owner";
  }
  /** The hosting Root/session must register this as a real child-close barrier. */
  async close(): Promise<void> {
    this.phase = "closed";
    await Promise.allSettled([...this.scopes].map(scope => scope.finished));
    await this.writeTail;
    for (const scope of this.scopes) for (const record of scope.records.values()) {
      if (!record.child) throw new Error("UNKNOWN: registered Environment launch has no physical completion.");
      record.proof = environmentDrainProof(record.child, record.trace);
      assertPreparedLinuxEnvironmentDrainProof(record.proof, record.prepared);
    }
    if (this.failure || this.scopes.size) throw new Error("UNKNOWN: retain managed profile and Root barrier; durable transactions remain pending.");
    this.unregisterEnvironment(); this.unregisterEnvironment = () => {};
    this.unregisterRoot(); this.unregisterRoot = () => {};
    this.options.signal.removeEventListener("abort", this.onAbort);
  }
  acquireLegacyEffects(intent: Readonly<OrdinaryEnvironmentRefreshIntent>, lifetime: Lifetime): OrdinaryEnvironmentManagedEffects {
    return this.acquire(intent, lifetime, "legacy");
  }
  acquireOwnerEffects(intent: Readonly<OrdinaryEnvironmentRefreshIntent>, lifetime: Lifetime): OrdinaryEnvironmentManagedEffects {
    return this.acquire(intent, lifetime, "owner");
  }
  private acquire(intent: Readonly<OrdinaryEnvironmentRefreshIntent>, lifetime: Lifetime, phase: "legacy" | "owner"): OrdinaryEnvironmentManagedEffects {
    this.exclusive();
    if (this.phase !== phase || this.options.hostAdmission.status().state !== "accepting"
      || !isDeepStrictEqual({ workspaceId: intent.workspaceId, knowledgeRoot: intent.knowledgeRoot,
      globalStorageDirectory: intent.globalStorageDirectory }, this.options.binding)
      || !lifetime.signal || lifetime.signal.aborted || !Number.isSafeInteger(lifetime.expiresAtMs)
      || lifetime.expiresAtMs <= Date.now() || lifetime.expiresAtMs > Date.now() + 300_000)
      throw new Error("Exact live profile writer intent is required; legacy handoff is not owner authorization.");
    let claimed = false, settled = false, resolve!: () => void, reject!: (error: unknown) => void;
    const finished = new Promise<void>((yes, no) => { resolve = yes; reject = no; });
    void finished.catch(() => {});
    const scope = { finished, records: new Map<PreparedLinuxEnvironmentQuery, Record<R>>(), failed: false };
    const check = (newEffect = false, requireClaim = true) => {
      this.exclusive();
      if (requireClaim && !claimed || settled || lifetime.signal.aborted || Date.now() >= lifetime.expiresAtMs
        || this.phase === "closed" || this.phase === "unknown"
        || phase === "owner" && this.phase !== "owner" || newEffect && (this.phase !== phase || this.options.hostAdmission.status().state !== "accepting"))
        throw new Error("Managed Environment intent is revoked, expired or its admissions are closed.");
    };
    const fail = (error: unknown) => {
      scope.failed = true; this.failure ||= error;
      this.phase = "unknown";
      if (!settled) { settled = true; reject(error); }
    };
    const finish = async (transaction: OrdinaryEnvironmentRefreshCompletion | undefined) => {
      if (settled) {
        if (scope.failed) throw new Error("UNKNOWN: managed Environment intent remains pending.");
        return;
      }
      try {
        if (!transaction) throw new Error("UNKNOWN: managed Environment handler/commit did not succeed.");
        await this.writeTail;
        check();
        for (const record of scope.records.values()) {
          assertOrdinaryEnvironmentRefreshCompletion(transaction, record.prepared);
          if (!record.child) throw new Error("UNKNOWN: registered Environment launch did not start.");
          record.proof = environmentDrainProof(record.child, record.trace);
          assertPreparedLinuxEnvironmentDrainProof(record.proof, record.prepared);
          if (record.proof.managerCode !== 0) throw new Error("Managed Environment manager did not succeed.");
        }
        for (const record of scope.records.values()) {
          check();
          this.options.complete(record.registration, record.proof!, transaction);
        }
        scope.records.clear(); this.scopes.delete(scope); settled = true; resolve();
      } catch (error) { fail(error); throw error; }
    };
    return {
      signal: lifetime.signal, environment: Object.freeze({ ...this.options.environment }),
      supervisorPython: this.options.supervisorPython,
      claim: actual => {
        if (claimed || this.requests.has(intent.requestId) || !isDeepStrictEqual(actual, intent) || this.phase !== phase)
          throw new Error("Managed Environment intent cannot be replayed or handed off.");
        claimed = true; check(true); this.requests.add(intent.requestId); this.scopes.add(scope);
        void this.options.hostAdmission.run("ui", () => finished).catch(error => {
          this.failure ||= error; scope.failed = true;
        });
      },
      assertCurrent: (effect, id, kind) => {
        check(effect === "probe");
        if (!intent.environments.some(row => row.id === id) || intent.operation === "packages" && kind !== "packages"
          || intent.operation === "metadata" && kind === "packages") throw new Error("Environment effect is outside this exact intent.");
      },
      assertProfileWriter: () => check(!claimed, false),
      assertExecution: trace => {
        check(true);
        if (!isDeepStrictEqual(trace.intent, intent) || !trace.launch) throw new Error("Actual supervised Environment descriptor is required.");
        fence(() => this.options.assertExecutionAuthority(trace)); check(true);
      },
      registerPreparedExecution: prepared => {
        check(true);
        const trace = describePreparedLinuxEnvironmentQuery(prepared);
        if (!isDeepStrictEqual(trace.intent, intent) || scope.records.has(prepared)) throw new Error("Wrong managed Environment prepared launch.");
        fence(() => this.options.assertExecutionAuthority(trace));
        const registration = this.options.begin(prepared);
        if (!registration || typeof registration !== "object") throw new Error("Explicit managed Environment registration is missing.");
        scope.records.set(prepared, { prepared, registration, trace });
        check(true);
      },
      recordExecution: (child, trace) => {
        const record = [...scope.records.values()].find(value => isDeepStrictEqual(value.trace, trace));
        if (!record || record.child) throw new Error("Actual Environment child is not the registered supervised launch.");
        record.child = child;
      },
      verifyDrained: async (child, trace) => {
        const record = [...scope.records.values()].find(value => value.child === child && isDeepStrictEqual(value.trace, trace));
        if (!record) throw new Error("Environment physical verification belongs to another intent.");
        record.proof = environmentDrainProof(child, trace);
        assertPreparedLinuxEnvironmentDrainProof(record.proof, record.prepared);
      },
      withProfileWrite: (_id, _kind, write) => {
        check();
        const operation = this.writeTail.then(() => { check(); write(); check(); });
        this.writeTail = operation.catch(() => {});
        return operation.catch(error => { scope.failed = true; this.failure ||= error; this.phase = "unknown"; throw error; });
      },
      finishRefresh: finish,
    };
  }
}
