import { randomUUID } from "node:crypto";
import { readFileSync, realpathSync, statSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";
import { readStartupReceipt, stagedValidationMode } from "./deployment-integrity-worker.js";
import type { DeploymentIntegrity } from "./deployment-integrity.js";

const schema = "pkm.mcp.lifecycle/v1";
const exists = (path: string) => statSync(path, { throwIfNoEntry: false }) !== undefined;
type JsonObject = Record<string, any>;
const object = (value: unknown): value is JsonObject => !!value && typeof value === "object" && !Array.isArray(value);
const read = (path: string): JsonObject => {
  const value: unknown = JSON.parse(readFileSync(path, "utf8"));
  if (!object(value)) throw new Error("Invalid managed lifecycle control.");
  return value;
};

function attribution(encoded = process.env.PKM_MCP_LAUNCH_ATTRIBUTION ?? ""): JsonObject {
  const fallback = { schema: "pkm.mcp.attribution/v1", source: "standalone", scope: "unknown" };
  if (!encoded || encoded.length > 32768) return fallback;
  try {
    const raw = JSON.parse(encoded), result: JsonObject = {};
    if (!object(raw) || raw.schema !== fallback.schema || !["vscode-provider", "pkm-chat", "standalone"].includes(raw.source)
      || !["shared-host", "chat", "unknown"].includes(raw.scope)) return fallback;
    for (const key of ["schema", "source", "scope"]) result[key] = raw[key];
    for (const key of ["hostId", "editorSessionId", "hostSlotId", "workspace", "machine",
      "remoteName", "extensionHostLogUri", "chatId"]) {
      if (!(key in raw)) continue;
      if (typeof raw[key] !== "string" || !raw[key].length || raw[key].length > 2048 || /[\x00-\x1f\x7f]/.test(raw[key])) return fallback;
      result[key] = raw[key];
    }
    if (result.extensionHostLogUri && (!/^[a-z][a-z0-9+.-]*:\//i.test(result.extensionHostLogUri)
      || /\s/.test(result.extensionHostLogUri))) return fallback;
    if ("extensionHostPid" in raw) {
      if (!Number.isSafeInteger(raw.extensionHostPid) || raw.extensionHostPid <= 0) return fallback;
      result.extensionHostPid = raw.extensionHostPid;
    }
    if (result.scope === "chat" && (result.source !== "pkm-chat" || !result.chatId)
      || result.scope !== "chat" && "chatId" in result
      || result.scope === "shared-host" && !["hostId", "editorSessionId", "extensionHostPid"].every(key => result[key])
      || result.source === "standalone" && (result.scope !== "unknown"
        || ["hostId", "editorSessionId", "extensionHostPid"].some(key => key in result))) return fallback;
    return result;
  } catch { return fallback; }
}

export function loadNativePublicManifest(directory: string, data: string, writable: boolean, scheduler?: string) {
  if (!isAbsolute(directory)) throw new Error("--managed-generation must be absolute.");
  const startup = readStartupReceipt(directory);
  const manifest = startup ? { ...startup.manifest, deploymentStartup: startup } : read(join(directory, "manifest.json"));
  if (Object.hasOwn(manifest, "startupValidation") && (!startup || manifest.startupValidation !== stagedValidationMode))
    throw new Error("Unsupported startup validation mode.");
  if (manifest.schema !== schema || typeof manifest.managedRoot !== "string" || !isAbsolute(manifest.managedRoot)
    || typeof manifest.generation !== "string" || !/^[A-Za-z0-9_-]{1,128}$/.test(manifest.generation)
    || realpathSync(directory) !== realpathSync(join(manifest.managedRoot, "generations", manifest.generation))
    || manifest.version !== "0.1.0" || JSON.stringify(manifest.enabledFeatureDomains) !== "[]"
    || !object(manifest.components) || Object.keys(manifest.components).length !== 4
    || !["knowledge", "chat", "recipes", "agent_sessions"].every(key => manifest.components[key] === "0.1.0"))
    throw new Error("Invalid experimental managed MCP runtime ownership.");
  if (startup) {
    const launch = read(join(directory, "launch.json"));
    if (launch.data !== resolve(data) || launch.allowWrites !== writable || scheduler !== undefined
      || realpathSync(process.execPath) !== startup.manifest.interpreters.node.path)
      throw new Error("Staged launch authority or interpreter does not match publication.");
  }
  if (scheduler !== undefined) {
    const launch = read(join(directory, "launch.json")), marker = read(join(data, ".pkm-next-workspace"));
    const enrollment = launch.snapshotScheduler;
    if (!writable || !object(enrollment) || Object.keys(enrollment).length !== 4
      || enrollment.schema !== "pkm.native-snapshot-scheduler/v1" || enrollment.actorId !== "mcp:external"
      || enrollment.workspaceId !== marker.id || enrollment.admissionSha256 !== scheduler
      || launch.data !== resolve(data) || launch.allowWrites !== true)
      throw new Error("Managed generation snapshot scheduler enrollment does not match.");
  }
  return manifest;
}

export class NativePublicMcpLifecycle {
  readonly instanceId = randomUUID().replaceAll("-", "");
  readonly attribution = attribution();
  private readonly inFlight = new Map<string, { uncertain: boolean; done: Promise<unknown> }>();
  private fenced = false;
  private drainStarted = 0;
  private controlError = "";
  private superseded = false;
  private updateAvailable = false;
  private retired = false;
  private activeMessages = 0;
  private lastActivity = performance.now();
  private timer?: NodeJS.Timeout;
  private closing?: Promise<void>;

  constructor(readonly manifest: JsonObject, private readonly closeBackend: () => Promise<void>,
    private readonly options: { drainSeconds?: number; now?: () => number; deployment?: DeploymentIntegrity } = {}) {
    this.lastActivity = this.now();
    options.deployment?.onCritical(() => {
      this.fence();
      void this.drainedStatus().catch(() => { process.exitCode = 1; });
    });
  }

  private now() { return this.options.now?.() ?? performance.now(); }

  private refresh() {
    try {
      const root = this.manifest.managedRoot;
      const baseline = read(join(root, "active-generation.json")), latest = join(root, "latest-generation.json");
      const active = exists(latest) ? read(latest) : baseline;
      if (baseline.schema !== schema || typeof baseline.generation !== "string"
        || !/^[A-Za-z0-9_-]{1,128}$/.test(baseline.generation)
        || baseline.generation !== active.generation && baseline.compatibilityBaseline !== true
        || active.schema !== schema || typeof active.generation !== "string"
        || !/^[A-Za-z0-9_-]{1,128}$/.test(active.generation)) throw new Error("Invalid compatibility baseline");
      this.superseded = active.generation !== this.manifest.generation;
      let compatible = false;
      if (this.superseded) {
        let successor: JsonObject = {};
        try {
          const next = join(root, "generations", active.generation);
          successor = this.options.deployment ? readStartupReceipt(next, true, false)?.manifest ?? read(join(next, "manifest.json"))
            : read(join(next, "manifest.json"));
        }
        catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
        const contract = this.manifest.compatibility, ownDomains = this.manifest.enabledFeatureDomains ?? [];
        const nextDomains = successor.enabledFeatureDomains ?? [];
        compatible = object(contract) && contract.protocol === "pkm.mcp.api/1"
          && object(contract.components) && Object.keys(contract.components).length > 0
          && Object.values(contract.components).every(value => typeof value === "string" && /^\d+$/.test(value))
          && object(successor.compatibility) && successor.compatibility.protocol === contract.protocol
          && object(successor.compatibility.components)
          && Object.entries(contract.components).every(([key, value]) => successor.compatibility.components[key] === value)
          && successor.schema === schema && successor.generation === active.generation
          && Array.isArray(ownDomains) && Array.isArray(nextDomains)
          && [...ownDomains, ...nextDomains].every(value => typeof value === "string")
          && ownDomains.every(value => nextDomains.includes(value));
      }
      this.updateAvailable = this.superseded && compatible;
      this.controlError = "";
      if (this.superseded && !compatible || exists(join(root, "runtime-maintenance.json"))
        || this.manifest.runtimeMaintenance && exists(this.manifest.runtimeMaintenance)) this.fence();
    } catch {
      this.superseded = false; this.updateAvailable = false;
      this.controlError = "generation-control-unavailable"; this.fence();
    }
  }

  private fence() {
    if (!this.fenced) { this.fenced = true; this.drainStarted = this.now(); }
    this.options.deployment?.cancel();
  }

  status() {
    this.refresh();
    const deadline = this.fenced && this.now() - this.drainStarted >= (this.options.drainSeconds ?? 30) * 1000;
    const count = this.inFlight.size;
    return {
      schema, generation: this.manifest.generation, instanceId: this.instanceId, pid: process.pid,
      attribution: { ...this.attribution }, version: this.manifest.version, components: this.manifest.components,
      runtimeBuild: this.manifest.runtimeBuild ?? "", extensionVersion: this.manifest.extensionVersion ?? "",
      phase: this.retired ? "retired" : !this.fenced ? "accepting" : !count ? "drained" : deadline ? "action-required" : "draining",
      acceptingNewCalls: !this.fenced, inFlight: count,
      uncertainCalls: [...this.inFlight.values()].filter(call => call.uncertain).length,
      drainDeadlineExceeded: !!count && deadline, drainTimeoutSeconds: this.options.drainSeconds ?? 30,
      action: !this.fenced ? "none" : !count ? "reconnect" : "wait-or-review-uncertain-writes",
      automaticReplay: false, automaticTermination: false, gracefulRetirement: true,
      updateAvailable: this.updateAvailable,
      compatibility: this.updateAvailable ? "compatible-update" : !this.superseded ? "current" : "reconnect-required",
      controlError: this.controlError,
      ...(this.options.deployment ? { deploymentIntegrity: this.options.deployment.status() } : {}),
    };
  }

  quiesce() { this.fence(); return this.status(); }

  async drainedStatus() {
    const status = this.status();
    if (status.controlError) throw new Error("Managed lifecycle control is unavailable; drain is unverified.");
    if (!status.acceptingNewCalls && !status.inFlight && !status.uncertainCalls)
      await (this.closing ??= this.closeBackend());
    return this.status();
  }

  async run<T>(name: string, work: () => Promise<T>, signal?: AbortSignal): Promise<T> {
    this.refresh();
    if (["check_version", "mcp_lifecycle_status", "mcp_lifecycle_quiesce"].includes(name)) return work();
    if (this.fenced) throw new Error(JSON.stringify({
      schema, ok: false, code: "managed-runtime-superseded", retryable: false, action: "reconnect-and-verify",
      automaticReplay: false,
      message: "This managed runtime no longer accepts new tools. Reconnect and verify the successor. Never replay an uncertain write automatically.",
      runtime: this.status(),
    }));
    const id = randomUUID(), call = { uncertain: !!signal?.aborted, done: Promise.resolve() as Promise<unknown> };
    this.inFlight.set(id, call);
    const cancelled = () => { call.uncertain = true; };
    signal?.addEventListener("abort", cancelled, { once: true });
    call.done = Promise.resolve().then(work);
    try { return await call.done as T; }
    finally {
      signal?.removeEventListener("abort", cancelled);
      this.inFlight.delete(id); this.lastActivity = this.now();
      if (this.fenced && this.options.deployment?.status().phase === "critical-failure")
        void this.drainedStatus().catch(() => { process.exitCode = 1; });
    }
  }

  async message<T>(work: () => Promise<T>): Promise<T> {
    this.activeMessages++;
    try { return await work(); }
    finally { this.activeMessages--; this.lastActivity = this.now(); }
  }

  startRetirement(retire: () => Promise<void>) {
    if (this.timer) throw new Error("Managed lifecycle monitor already started.");
    this.timer = setInterval(() => {
      this.refresh();
      if (this.fenced && this.superseded && !this.controlError && !this.inFlight.size
        && !this.activeMessages && this.now() - this.lastActivity >= 1000) {
        this.stopMonitor();
        void this.drainedStatus().then(() => { this.retired = true; return retire(); }).catch(error => {
          console.error(error); process.exitCode = 1;
        });
      }
    }, 250);
    this.timer.unref();
  }

  stopMonitor() { if (this.timer) clearInterval(this.timer); this.timer = undefined; }

  async close() {
    this.stopMonitor(); this.fence();
    await this.options.deployment?.close();
    while (this.inFlight.size) await Promise.allSettled([...this.inFlight.values()].map(call => call.done));
    await (this.closing ??= this.closeBackend());
  }
}
