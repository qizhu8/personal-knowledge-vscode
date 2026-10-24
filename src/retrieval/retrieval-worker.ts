import * as fs from "fs";
import * as path from "path";
import { execFile, spawn } from "child_process";
import { promisify } from "util";
import { createHash } from "crypto";
import { availableParallelism } from "os";
import { indexedRetrievalDocument, type RetrievalSnapshot } from "./retrieval-snapshot";
import { mcpStdioCommand } from "../mcp/mcp-stdio-command";
import {
  RETRIEVAL_QUERY_SCHEMA_V1,
  compileRetrievalQueryV1,
  assertRetrievalResultForQuery,
  type RetrievalQueryV1,
  type RetrievalResultV1,
  type RetrievalIndexEventV1,
  type RetrievalServingIdentityV1,
  validRetrievalServingIdentity,
} from "./retrieval-contracts";
import { RetrievalIndexEventStore } from "./retrieval-index-events";
import { withCrossProcessLock } from "../runtime/cross-process-lock";
import { stageRetrievalRuntime } from "./retrieval-runtime";
import { downloadRetrievalModel, type DefaultRetrievalModel } from "./retrieval-model-download";

export interface RetrievalModelSetup {
  operationId: string;
  source: "huggingface" | "directory" | "archive";
  phase: "runtime" | "acquire" | "verify" | "configure" | "index" | "ready" | "failed" | "cancelled";
  current?: number;
  total?: number;
  packageId?: string;
  error?: string;
  failedPhase?: string;
  ownerPid?: number;
}

interface RetrievalEndpoint {
  pid: number;
  port: number;
  token: string;
  engine_version: string;
  configuration_hash: string;
}

function workerHitServingIdentity(engineVersion:string, raw:unknown, contributingRoutes:unknown, scoreSemantics?:unknown): RetrievalServingIdentityV1 {
  const object = (value:unknown): Record<string, unknown> =>
    value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
  const result = object(raw), solution = object(result.solution), serving = object(result.skill_serving);
  if (typeof serving.used !== "boolean") throw new Error("Retrieval worker did not report whether imported model serving was used.");
  if (!Array.isArray(contributingRoutes) || contributingRoutes.some(route => typeof route !== "string" || !route)) throw new Error("Retrieval worker returned invalid contributing routes.");
  const identity:RetrievalServingIdentityV1 = {
    providerId:"pkm.unified-retrieval", providerVersion:engineVersion,
    route:[...new Set(contributingRoutes)].join("+") || "unreported", scoreSemantics:scoreSemantics === "rrf" ? "rrf" : "engine-defined",
  };
  if (serving.used) {
    if (typeof solution.package_id === "string" && solution.package_id) identity.packageId = solution.package_id;
    if (typeof serving.release_id === "string" && serving.release_id) identity.releaseId = serving.release_id;
  }
  const fallback = serving.fallback_reason || (!serving.used && solution.reason !== "default" ? solution.reason : undefined);
  if (fallback !== undefined && fallback !== null) {
    if (typeof fallback !== "string") throw new Error("Retrieval worker returned an invalid serving fallback reason.");
    identity.fallback = fallback;
  }
  if (!validRetrievalServingIdentity(identity)) throw new Error("Retrieval worker returned an invalid actual serving identity.");
  return identity;
}

export interface RetrievalWorkerStartupProfile {
  schema: 1;
  successfulStartupMs: number[];
  consecutiveTimeouts: number;
}

const RETRIEVAL_STARTUP_MIN_MS = 10_000;
const RETRIEVAL_STARTUP_MAX_MS = 90_000;

export function retrievalWorkerStartupTimeoutMs(
  profile: Partial<RetrievalWorkerStartupProfile> | undefined,
  expectedDocumentCount = 0,
  platform = process.platform,
): number {
  const samples = (profile?.successfulStartupMs || [])
    .map(Number)
    .filter(value => Number.isFinite(value) && value > 0 && value <= RETRIEVAL_STARTUP_MAX_MS)
    .sort((left, right) => left - right);
  const percentile = samples.length ? samples[Math.ceil(samples.length * 0.9) - 1] : 0;
  const historyBudget = percentile ? percentile * 2.5 + 2_000 : RETRIEVAL_STARTUP_MIN_MS;
  const workloadBudget = RETRIEVAL_STARTUP_MIN_MS + Math.ceil(Math.max(0, expectedDocumentCount) / 500) * 2_000;
  const timeoutBudget = RETRIEVAL_STARTUP_MIN_MS * 2 ** Math.min(3, Math.max(0, Number(profile?.consecutiveTimeouts || 0)));
  const platformFloor = platform === "win32" ? 20_000 : RETRIEVAL_STARTUP_MIN_MS;
  return Math.min(RETRIEVAL_STARTUP_MAX_MS,
    Math.ceil(Math.max(historyBudget, workloadBudget, timeoutBudget, platformFloor) / 1_000) * 1_000);
}

export interface RetrievalWorkerStatus {
  ok: boolean;
  engine_version: string;
  configuration_hash: string;
  pid: number;
  corpus_revision: string;
  building_revision: string;
  ready_generation: number;
  building_generation: number;
  ready: boolean;
  document_count: number;
  edge_count: number;
  schema: { query: string; result: string; index_event: string };
  engine: string;
  search_modes?: string[];
  semantic_status?: "off" | "ready" | "unavailable";
  supported_routes: string[];
  unsupported_routes: string[];
  tokenizers: string[];
  facets: string[];
  update_mode: string;
  limitations: string[];
  error: string;
  solution?: RetrievalSolutionStatus;
  runtime?: { python: string; engine_version: string; engine_file: string; cpu_threads?: number; worker_build?: string; worker_version?: string };
  skill_serving?: Record<string, unknown>;
  work_state?: string;
  work_detail?: string;
  work_current?: number;
  work_total?: number;
  work_updated_at?: string;
}

export interface RetrievalSolutionStatus {
  managed: boolean;
  requested_package_id: string | null;
  active_package_id: string | null;
  state: string;
  error: string;
  corpus_revision: string;
  build_ms: number | null;
  fallback: string;
  progress?: { phase: string; current: number; total: number | null };
  observed?: { elapsed_seconds?: number; rss_bytes?: number | null; sampled_peak_rss_bytes?: number | null; cpu_core_equivalents?: number; scope?: string };
  index?: { reused?: boolean; bytes?: number | null; persistent?: boolean; embedding_cache_hits?: number; embedding_cache_misses?: number; embedding_cache_bytes?: number };
  process?: { rss_bytes: number | null; host_available_memory_bytes: number | null; logical_cpus: number | null; scope: string };
}

export interface RetrievalSolutionCatalog extends RetrievalSolutionStatus {
  ok: boolean;
  packages: Array<{
    package_id: string; name: string; architecture?: string;
    license?: string; bytes?: number; validation?: Record<string, unknown>; error?: string;
    resources?: {
      kind: string; document_count: number; content_type_counts: Record<string, number>; unit_count: number; dimensions: number | null;
      model_bytes: number; index_bytes_estimate: number | null; additional_disk_peak_bytes_estimate: number | null;
      build_ram_bytes_estimate: number | null; disk_free_bytes: number; cpu_demand: string; caveat: string;
    };
  }>;
  metrics: {
    buckets: Array<{
      requested_package_id: string | null; served_package_id: string; corpus_revision: string;
      entry: string; reason: string; requests: number; errors: number;
      returned_hits: number; latency_sample_count: number; p50_ms: number | null; p95_ms: number | null;
    }>;
    latency_window: string;
    retention: string;
    query_text_collected: boolean;
  };
  learning?: {
    enabled: boolean;
    minimum_judged_calls: number;
    calls: Array<{ invocation: number; context: string; runtime_ms: number; returned_count: number; recall: number | null; success: boolean }>;
    models: Array<{ context: string; package_id: string; corpus_revision: string; route: string;
      judged_calls: number; safe_streak: number; threshold: number;
      baseline: { slope: number; bias: number }; current: { slope: number; bias: number } }>;
    retention: string;
    calibration: string;
    learning: string;
  };
}

export interface RetrievalWorkerLifecycle {
  state: "idle" | "starting" | "working" | "ready" | "failed";
  startedAt?: string;
  detail?: string;
  progress?: { current: number; total?: number; unit?: string };
  error?: string;
}

function compareEngineVersion(left: string, right: string): number | undefined {
  const parse = (value: string): number[] | undefined => {
    const parts = String(value || "").match(/\d+/g)?.map(Number);
    return parts?.length ? parts : undefined;
  };
  const a = parse(left), b = parse(right);
  if (!a || !b) return undefined;
  for (let index = 0; index < Math.max(a.length, b.length); index++) {
    const difference = (a[index] || 0) - (b[index] || 0);
    if (difference) return difference < 0 ? -1 : 1;
  }
  return 0;
}

export class RetrievalWorkerManager {
  private ensurePromise: Promise<RetrievalEndpoint> | undefined;
  private ensureExpectedDocumentCount = 0;
  private lifecycle: RetrievalWorkerLifecycle = { state: "idle" };
  private ownedRuntime: ReturnType<typeof stageRetrievalRuntime> | undefined;

  private runtimeFiles(): ReturnType<typeof stageRetrievalRuntime> {
    return this.ownedRuntime ||= stageRetrievalRuntime(this.stateDir, this.workerScript);
  }

  setupStatus(): RetrievalModelSetup | undefined {
    try {
      const value: RetrievalModelSetup = JSON.parse(fs.readFileSync(path.join(this.stateDir, "model-setup.json"), "utf8"));
      if (!value || typeof value.operationId !== "string") throw new Error("Invalid model setup receipt.");
      if (value.ownerPid && !this.processAlive(value.ownerPid) && !["index", "ready", "failed", "cancelled"].includes(value.phase)) {
        return { ...value, failedPhase:value.phase, phase:"failed", error:"The setup Host stopped. No model was automatically enabled; start setup again explicitly." };
      }
      return value;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      throw error;
    }
  }

  async prepareModel(source: "huggingface" | "directory" | "archive", sourcePath: string | undefined,
    operationId: string, signal: AbortSignal, report: (state: RetrievalModelSetup) => void): Promise<void> {
    await withCrossProcessLock(path.join(this.stateDir, "model-setup.lock"), "Retrieval model setup", 1000, async () => {
      let setup: RetrievalModelSetup = { operationId, source, phase:"runtime", ownerPid:process.pid };
      const publish = (update: Partial<RetrievalModelSetup>) => {
        setup = { ...setup, ...update };
        const target = path.join(this.stateDir, "model-setup.json"), temporary = `${target}.${process.pid}.pending`;
        fs.writeFileSync(temporary, JSON.stringify(setup), { mode:0o600 }); fs.renameSync(temporary, target);
        report(setup);
      };
      let temporary: string | undefined;
      try {
        publish({});
        const resources = path.dirname(this.runtimeFiles().script);
        const endpoint = await this.ensure();
        const selection = await this.request<RetrievalSolutionStatus & { selection_revision:number }>(endpoint, "/solutions");
        if (source !== "archive") await this.runPython(this.modelRuntime().python, [path.join(resources, "retrieval_runtime.py")], 60_000);
        signal.throwIfAborted();
        publish({ phase:"acquire" });
        if (source === "huggingface") {
          const model: DefaultRetrievalModel = JSON.parse(fs.readFileSync(path.join(resources, "retrieval-default-model.json"), "utf8"));
          const total = Object.values(model.manifest.files).reduce((sum, file) => sum + file.bytes, 0);
          const disk = await fs.promises.statfs(this.stateDir);
          if (disk.bavail * disk.bsize < total * 2 + 64 * 1024 * 1024) throw new Error("Model setup requires at least 1 GB of free disk space plus index storage.");
          temporary = await fs.promises.mkdtemp(path.join(this.stateDir, ".model-download-"));
          await downloadRetrievalModel(model, temporary, signal, (current, total) => publish({ current, total }));
          sourcePath = temporary;
        }
        signal.throwIfAborted();
        if (!sourcePath) throw new Error("Choose a local model directory or solution ZIP.");
        publish({ phase:"verify" });
        const result = source === "archive" ? await this.importSolution(sourcePath) : await this.runPython(this.modelRuntime().python, [
          path.join(resources, "retrieval_solution.py"), "--model-directory", sourcePath, "--state", this.stateDir,
        ], 120_000);
        if (typeof result.package_id !== "string" || !/^[a-f0-9]{64}$/.test(result.package_id)) throw new Error("Model importer returned an invalid package identity.");
        publish({ phase:"configure", packageId:result.package_id });
        signal.throwIfAborted();
        if (source !== "archive") {
          await this.request(endpoint, "/solutions", "POST", { action:"enable", package_id:result.package_id, expected_revision:selection.selection_revision });
        }
        publish({ phase:source === "archive" ? "ready" : "index" });
      } catch (error) {
        publish({ failedPhase:setup.phase, phase:signal.aborted ? "cancelled" : "failed", error:(error as Error).message });
        throw error;
      } finally {
        if (temporary) await fs.promises.rm(temporary, { recursive:true, force:true });
      }
    });
  }

  async solutions(): Promise<RetrievalSolutionCatalog> {
    return this.request(await this.ensure(), "/solutions");
  }

  async setAdaptiveResultCount(enabled: boolean): Promise<void> {
    await this.request(await this.ensure(), "/retrieval-learning", "POST", { enabled });
  }

  async observeLearning(): Promise<RetrievalSolutionCatalog["learning"]> {
    const endpoint = this.readEndpoint();
    if (!endpoint || !this.processAlive(endpoint.pid)) return undefined;
    const result = await this.request<{ learning: RetrievalSolutionCatalog["learning"] }>(
      endpoint, "/retrieval-learning", "GET", undefined, { timeoutMs: 2_000 });
    if (!result.learning) throw new Error("Retrieval worker did not provide learning history.");
    return result.learning;
  }

  async setSolution(action: "enable" | "rebuild" | "disable" | "delete", packageId?: string): Promise<RetrievalSolutionStatus> {
    return this.request(await this.ensure(), "/solutions", "POST", { action, package_id: packageId });
  }

  modelRuntime(): { python: string; configured: boolean; cpuThreads: number } {
    let value: unknown;
    try { value = JSON.parse(fs.readFileSync(path.join(this.stateDir, "model-runtime.json"), "utf8")); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return { python: this.python, configured: false, cpuThreads: 1 };
      throw new Error(`Cannot read retrieval model runtime: ${(error as Error).message}`);
    }
    if (!value || typeof value !== "object" || !("schema" in value) || value.schema !== 1
      || !("python" in value) || typeof value.python !== "string" || !path.isAbsolute(value.python)) {
      throw new Error("Invalid retrieval model runtime selection.");
    }
    const cpuThreads = "cpuThreads" in value ? value.cpuThreads : 1;
    if (typeof cpuThreads !== "number" || !Number.isSafeInteger(cpuThreads) || cpuThreads < 1) {
      throw new Error("Invalid retrieval inference thread budget.");
    }
    return { python: value.python, configured: true, cpuThreads };
  }

  async configureModelRuntime(python: string, cpuThreads = this.modelRuntime().cpuThreads): Promise<void> {
    if (!path.isAbsolute(python)) throw new Error("Choose an absolute model-runtime Python executable.");
    if (!Number.isSafeInteger(cpuThreads) || cpuThreads < 1 || cpuThreads > availableParallelism()) {
      throw new Error("Choose a positive inference thread budget within the available CPU count.");
    }
    const result = await this.runPython(python, [path.join(path.dirname(this.runtimeFiles().script), "retrieval_runtime.py")], 60_000);
    if (result.engine_version !== this.engineVersion || typeof result.python !== "string"
      || !path.isAbsolute(result.python) || typeof result.engine_file !== "string" || !path.isAbsolute(result.engine_file)) {
      throw new Error("Model runtime probe returned an invalid or incompatible engine identity.");
    }
    await this.withTransitionLock(async () => {
      const target = path.join(this.stateDir, "model-runtime.json");
      const temporary = `${target}.${process.pid}.tmp`;
      fs.writeFileSync(temporary, JSON.stringify({ schema: 1, python, cpuThreads }), { mode: 0o600 });
      fs.renameSync(temporary, target);
    });
    await this.ensure();
  }

  async importSolution(archive: string): Promise<{ ok: true; package_id: string; name: string }> {
    const result = await this.runPython(this.modelRuntime().python, [
      path.join(path.dirname(this.runtimeFiles().script), "retrieval_solution.py"),
      "--archive", archive, "--state", this.stateDir,
    ], 120_000);
    if (typeof result.package_id !== "string" || !/^[a-f0-9]{64}$/.test(result.package_id)
      || typeof result.name !== "string" || !result.name.trim()) {
      throw new Error("Model importer returned an invalid package identity.");
    }
    return { ok: true, package_id: result.package_id, name: result.name };
  }

  private async runPython(python: string, args: string[], timeout: number): Promise<Record<string, unknown>> {
    const launch = mcpStdioCommand(python, args);
    let stdout: string;
    try {
      ({ stdout } = await promisify(execFile)(launch.command, launch.args, {
        timeout, maxBuffer: 1024 * 1024, windowsHide: true,
        env: { ...process.env, ...launch.env, HF_HUB_OFFLINE: "1", TRANSFORMERS_OFFLINE: "1" },
      }));
    } catch (error) {
      if (!error || typeof error !== "object" || !("stderr" in error) || typeof error.stderr !== "string") throw error;
      let failure: unknown;
      try { failure = JSON.parse(error.stderr); } catch { throw error; }
      if (!failure || typeof failure !== "object" || !("error" in failure) || typeof failure.error !== "string") throw error;
      throw new Error(`${failure.error}${path.basename(args[0]) === "retrieval_runtime.py" ? ". Choose a model-capable Python under Runtime & storage settings; dependencies are not installed automatically." : ""}`);
    }
    const result: unknown = JSON.parse(stdout);
    if (!result || typeof result !== "object" || Array.isArray(result) || !("ok" in result) || result.ok !== true) {
      throw new Error("Retrieval helper did not confirm success.");
    }
    return result as Record<string, unknown>;
  }

  constructor(
    private readonly stateDir: string,
    private readonly workerScript: string,
    private readonly python: string,
    private readonly engineVersion: string,
    private readonly configurationHash = "exact-bm25-fuzzy-dual-rrf-v1",
  ) {}

  private endpointPath(): string { return path.join(this.stateDir, "worker.json"); }
  private startupProfilePath(): string { return path.join(this.stateDir, "worker-startup-profile.json"); }

  private readStartupProfile(): RetrievalWorkerStartupProfile {
    try {
      const value = JSON.parse(fs.readFileSync(this.startupProfilePath(), "utf8"));
      if (value?.schema === 1 && Array.isArray(value.successfulStartupMs)) {
        return {
          schema: 1,
          successfulStartupMs: value.successfulStartupMs.map(Number).filter((item: number) => Number.isFinite(item) && item > 0).slice(-20),
          consecutiveTimeouts: Math.max(0, Number(value.consecutiveTimeouts || 0)),
        };
      }
    } catch { /* first startup or invalid profile */ }
    return { schema: 1, successfulStartupMs: [], consecutiveTimeouts: 0 };
  }

  private writeStartupProfile(profile: RetrievalWorkerStartupProfile): void {
    const target = this.startupProfilePath();
    const temporary = `${target}.${process.pid}.tmp`;
    fs.writeFileSync(temporary, JSON.stringify(profile), { mode: 0o600 });
    fs.renameSync(temporary, target);
  }

  private readEndpoint(): RetrievalEndpoint | undefined {
    try {
      const value = JSON.parse(fs.readFileSync(this.endpointPath(), "utf8"));
      if (Number(value.port) > 0 && Number(value.pid) > 1 && value.token) return value;
    } catch { /* worker may still be starting */ }
    return undefined;
  }

  private processAlive(pid: number): boolean {
    try {
      if (pid <= 1) return false;
      process.kill(pid, 0);
      return true;
    } catch (error: any) {
      return error?.code === "EPERM";
    }
  }

  private readWorkerLockPid(): number {
    try { return Number(fs.readFileSync(path.join(this.stateDir, "worker.lock"), "utf8").trim()) || 0; }
    catch { return 0; }
  }

  private async retireUnresponsiveWorker(pid: number): Promise<void> {
    if (!this.processAlive(pid)) return;
    try { process.kill(pid, "SIGTERM"); } catch (error: any) {
      if (error?.code !== "ESRCH") throw error;
    }
    let deadline = Date.now() + 2_000;
    while (this.processAlive(pid) && Date.now() < deadline) {
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    if (this.processAlive(pid)) {
      try { process.kill(pid, "SIGKILL"); } catch (error: any) {
        if (error?.code !== "ESRCH") throw error;
      }
      deadline = Date.now() + 3_000;
      while (this.processAlive(pid) && Date.now() < deadline) {
        await new Promise(resolve => setTimeout(resolve, 100));
      }
    }
    if (this.processAlive(pid)) {
      throw new Error(`Unresponsive retrieval worker process ${pid} could not be stopped.`);
    }
  }

  private async recoverWorkerWithoutEndpoint(): Promise<boolean> {
    const pid = this.readWorkerLockPid();
    if (!this.processAlive(pid)) {
      try { fs.rmSync(path.join(this.stateDir, "worker.lock"), { force: true }); } catch { /* another client recovered it */ }
      return false;
    }
    const deadline = Date.now() + 2_000;
    while (Date.now() < deadline) {
      if (this.readEndpoint()) return true;
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    await this.retireUnresponsiveWorker(pid);
    try { fs.rmSync(path.join(this.stateDir, "worker.lock"), { force: true }); } catch { /* worker cleanup won */ }
    return false;
  }

  private async request<T>(
    endpoint: RetrievalEndpoint,
    route: string,
    method = "GET",
    body?: unknown,
    options: { signal?: AbortSignal; timeoutMs?: number } = {},
  ): Promise<T> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(new Error(`Retrieval ${route} timed out.`)), options.timeoutMs ?? (route === "/index" ? 30_000 : 5_000));
    const abort = () => controller.abort(options.signal?.reason);
    if (options.signal?.aborted) abort();
    else options.signal?.addEventListener("abort", abort, { once: true });
    try {
      const response = await fetch(`http://127.0.0.1:${endpoint.port}${route}`, {
        method,
        headers: { "X-PKM-Retrieval-Token": endpoint.token, ...(body === undefined ? {} : { "Content-Type": "application/json" }) },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: controller.signal,
      });
      const value = await response.json() as unknown;
      if (!response.ok) {
        const message = value && typeof value === "object" && "error" in value ? String((value as { error?: unknown }).error || "") : "";
        throw new Error(message || `Retrieval worker returned ${response.status}.`);
      }
      return value as T;
    } finally {
      clearTimeout(timeout);
      options.signal?.removeEventListener("abort", abort);
    }
  }

  async ensure(expectedDocumentCount = 0): Promise<RetrievalEndpoint> {
    this.ensureExpectedDocumentCount = Math.max(this.ensureExpectedDocumentCount, expectedDocumentCount);
    if (this.ensurePromise) return this.ensurePromise;
    this.lifecycle = {
      state: "starting",
      startedAt: new Date().toISOString(),
      detail: `Starting local retrieval worker for ${this.ensureExpectedDocumentCount} documents`,
    };
    this.ensurePromise = this.ensureInner();
    try { return await this.ensurePromise; }
    catch (error) {
      this.lifecycle = {
        ...this.lifecycle,
        state: "failed",
        error: error instanceof Error ? error.message : String(error),
      };
      throw error;
    }
    finally {
      this.ensurePromise = undefined;
      this.ensureExpectedDocumentCount = 0;
    }
  }

  private async ensureInner(): Promise<RetrievalEndpoint> {
    fs.mkdirSync(this.stateDir, { recursive: true });
    const lockBudget = Math.max(30_000,
      retrievalWorkerStartupTimeoutMs(this.readStartupProfile(), this.ensureExpectedDocumentCount) + 5_000);
    return this.withTransitionLock(() => this.ensureLocked(), lockBudget);
  }

  private async ensureLocked(): Promise<RetrievalEndpoint> {
    const runtime = this.modelRuntime();
    const owned = this.runtimeFiles();
    const current = this.readEndpoint();
    if (!current && await this.recoverWorkerWithoutEndpoint()) return this.ensureLocked();
    if (current) {
      try {
        const status = await this.request<RetrievalWorkerStatus>(current, "/status");
        if (status.runtime?.worker_version && compareEngineVersion(status.runtime.worker_version, owned.version) === 1) {
          throw new Error(`A newer PKM retrieval worker ${status.runtime.worker_version} is active. Reload this VS Code window.`);
        }
        if (status.engine_version === this.engineVersion && status.configuration_hash === this.configurationHash
          && status.runtime?.worker_build === owned.build
          && (!runtime.configured || (status.runtime?.python === runtime.python
            && (status.runtime.cpu_threads ?? 1) === runtime.cpuThreads))) {
          this.updateLifecycleFromStatus(status);
          return current;
        }
        const order = compareEngineVersion(status.engine_version, this.engineVersion);
        if (order === 1) {
          if (status.configuration_hash === this.configurationHash) return current;
          throw new Error(`A newer PKM retrieval worker ${status.engine_version} is active with a different configuration. Reload this VS Code window.`);
        }
        await this.request(current, "/shutdown", "POST", {});
      } catch (error) {
        if (error instanceof Error && error.message.includes("newer PKM retrieval worker")) throw error;
        await this.retireUnresponsiveWorker(current.pid);
      }
      const deadline = Date.now() + 15_000;
      const ownsState = () => this.readWorkerLockPid() === current.pid || this.readEndpoint()?.pid === current.pid;
      while (this.processAlive(current.pid) && ownsState() && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 100));
      if (this.processAlive(current.pid) && ownsState()) throw new Error("Retrieval worker has not completed its graceful shutdown; runtime replacement is blocked.");
    }
    try { fs.rmSync(this.endpointPath(), { force: true }); } catch { /* ignore */ }
    const launch = mcpStdioCommand(runtime.python, [owned.script, this.stateDir, this.configurationHash]);
    const child = spawn(launch.command, launch.args, {
      detached: true,
      env: { ...process.env, ...launch.env, HF_HUB_OFFLINE: "1", TRANSFORMERS_OFFLINE: "1",
        OMP_NUM_THREADS: String(runtime.cpuThreads), MKL_NUM_THREADS: String(runtime.cpuThreads) },
      stdio: "ignore",
      windowsHide: true,
    });
    child.unref();
    const startedAt = Date.now();
    let startupSlow = false;
    while (true) {
      const endpoint = this.readEndpoint();
      if (endpoint) {
        try {
          const status = await this.request<RetrievalWorkerStatus>(endpoint, "/status");
          if (status.engine_version === this.engineVersion && status.configuration_hash === this.configurationHash) {
            const profile = this.readStartupProfile();
            profile.successfulStartupMs = [...profile.successfulStartupMs, Date.now() - startedAt].slice(-20);
            profile.consecutiveTimeouts = 0;
            this.writeStartupProfile(profile);
            this.updateLifecycleFromStatus(status);
            return endpoint;
          }
        } catch { /* keep waiting */ }
      }
      const profile = this.readStartupProfile();
      const timeoutMs = retrievalWorkerStartupTimeoutMs(profile, this.ensureExpectedDocumentCount);
      const elapsedMs = Date.now() - startedAt;
      if (elapsedMs >= timeoutMs) {
        startupSlow = true;
        this.lifecycle = {
          ...this.lifecycle,
          state: "starting",
          detail: `Retrieval worker is still starting · ${Math.floor(elapsedMs / 1_000)}s elapsed`,
        };
        let alive = false;
        try {
          if (child.pid && child.pid > 1) {
            process.kill(child.pid, 0);
            alive = true;
          }
        } catch (error: any) {
          alive = error?.code === "EPERM";
        }
        if (!alive) {
          profile.consecutiveTimeouts += 1;
          this.writeStartupProfile(profile);
          throw new Error(`Retrieval worker process exited before becoming ready after ${Math.ceil(elapsedMs / 1_000)} seconds.`);
        }
      }
      await new Promise(resolve => setTimeout(resolve, startupSlow ? 250 : 50));
    }
  }

  lifecycleStatus(): RetrievalWorkerLifecycle {
    return {
      ...this.lifecycle,
      progress: this.lifecycle.progress ? { ...this.lifecycle.progress } : undefined,
    };
  }

  private updateLifecycleFromStatus(status: RetrievalWorkerStatus): void {
    if (status.error && !status.building_revision) {
      this.lifecycle = { ...this.lifecycle, state: "failed", detail: status.work_detail, error: status.error };
      return;
    }
    if (status.building_revision || status.work_state && status.work_state !== "idle") {
      this.lifecycle = {
        state: "working",
        startedAt: this.lifecycle.startedAt || new Date().toISOString(),
        detail: status.work_detail || "Building the local retrieval index",
        progress: typeof status.work_current === "number" && Number.isFinite(status.work_current) && status.work_current >= 0
          ? {
            current: status.work_current,
            total: typeof status.work_total === "number" && Number.isFinite(status.work_total) && status.work_total > 0
              ? status.work_total : undefined,
            unit: "documents",
          }
          : undefined,
      };
      return;
    }
    this.lifecycle = {
      state: status.ready ? "ready" : "working",
      startedAt: this.lifecycle.startedAt,
      detail: status.ready ? "Retrieval worker ready" : "Waiting for the first retrieval index",
    };
  }

  async waitUntilReady(
    revision: string,
    onProgress?: (lifecycle: RetrievalWorkerLifecycle) => void,
  ): Promise<RetrievalWorkerStatus> {
    const endpoint = await this.ensure();
    while (true) {
      const status = await this.request<RetrievalWorkerStatus>(endpoint, "/status");
      this.updateLifecycleFromStatus(status);
      onProgress?.(this.lifecycleStatus());
      if (status.error && !status.building_revision) throw new Error(`Retrieval index build failed: ${status.error}`);
      if (status.ready && status.corpus_revision === revision) return status;
      await new Promise(resolve => setTimeout(resolve, 250));
    }
  }

  private withTransitionLock<T>(action: () => Promise<T>, timeoutMs = 30_000): Promise<T> {
    return withCrossProcessLock(path.join(this.stateDir, "worker-transition.lock"),
      "Retrieval worker transition", timeoutMs, action);
  }

  async index(snapshot: RetrievalSnapshot): Promise<void> {
    const endpoint = await this.ensure(snapshot.documents.length);
    await this.request(endpoint, "/index", "POST", snapshot);
  }

  async sync(snapshot: RetrievalSnapshot): Promise<{ mode: "full" | "delta" | "reused"; upserts: number; deletes: number }> {
    const manifestPath = path.join(this.stateDir, "client-index.json");
    const normalizedDocuments = snapshot.documents.map(indexedRetrievalDocument);
    const normalizedSnapshot = { ...snapshot, documents: normalizedDocuments };
    const hashes = Object.fromEntries(normalizedDocuments.map(document => [document.skill_id,
      createHash("sha256").update(JSON.stringify(document)).digest("hex")]));
    let previous: {
      corpus_revision?: string;
      hashes?: Record<string, string>;
      generation?: number;
      revisions?: Record<string, string>;
      source_ids?: Record<string, string>;
    } = {};
    try { previous = JSON.parse(fs.readFileSync(manifestPath, "utf8")); } catch { /* first full submission */ }
    const endpoint = await this.ensure(snapshot.documents.length);
    let retryGeneration: number | undefined;
    if (previous.corpus_revision === snapshot.corpus_revision) {
      const status = await this.request<RetrievalWorkerStatus>(endpoint, "/status");
      if (status.ready && status.corpus_revision === snapshot.corpus_revision) {
        return { mode: "reused", upserts: 0, deletes: 0 };
      }
      if (status.building_revision === snapshot.corpus_revision) {
        return { mode: "reused", upserts: 0, deletes: 0 };
      }
      retryGeneration = Number(previous.generation || 1);
    }
    const previousHashes = previous.hashes || {};
    const upserts = normalizedDocuments.filter(document => previousHashes[document.skill_id] !== hashes[document.skill_id]);
    const deletes = Object.keys(previousHashes).filter(skillId => hashes[skillId] === undefined);
    const mode = retryGeneration !== undefined || !Object.keys(previousHashes).length ? "full" : "delta";
    const generation = retryGeneration ?? Number(previous.generation || 0) + 1;
    const events: RetrievalIndexEventV1[] = upserts.map(document => ({
      schema: "pkm.retrieval.index-event/v1",
      kind: "upsert",
      eventId: createHash("sha256").update(`upsert:${document.source_id}:${document.source_revision}:${hashes[document.skill_id]}`).digest("hex"),
      sourceId: document.source_id,
      sourceRevision: document.source_revision,
      source: {
        sourceId: document.source_id,
        sourceRevision: document.source_revision,
        contentHash: hashes[document.skill_id],
        contentType: document.content_type,
        sourceUri: document.source_uri,
        title: document.title,
        description: document.description,
        body: document.body,
        metadata: document.metadata,
        provenance: document.provenance,
        readOnly: document.read_only,
        visibility: document.visibility,
        links: document.links,
      },
    }));
    for (const skillId of deletes) {
      const sourceId = previous.source_ids?.[skillId] || skillId;
      events.push({
        schema: "pkm.retrieval.index-event/v1",
        kind: "delete",
        eventId: createHash("sha256").update(`delete:${sourceId}:${generation}`).digest("hex"),
        sourceId,
        sourceRevision: `delete-${generation}`,
      });
    }
    events.push({
      schema: "pkm.retrieval.index-event/v1",
      kind: "rebuild-barrier",
      eventId: createHash("sha256").update(`barrier:${generation}:${snapshot.corpus_revision}`).digest("hex"),
      sourceId: "__rebuild_barrier__",
      sourceRevision: String(generation),
      generation,
    });
    new RetrievalIndexEventStore(path.join(this.stateDir, "index-events.json")).apply(events);
    const submitted = { ...normalizedSnapshot, generation };
    if (mode === "full") await this.request(endpoint, "/index", "POST", submitted);
    else await this.request(endpoint, "/update", "POST", { corpus_revision: snapshot.corpus_revision, generation, upserts, deletes });
    const temporary = `${manifestPath}.${process.pid}.tmp`;
    const revisions = Object.fromEntries(normalizedDocuments.map(document => [document.skill_id, document.source_revision]));
    const source_ids = Object.fromEntries(normalizedDocuments.map(document => [document.skill_id, document.source_id]));
    fs.writeFileSync(temporary, JSON.stringify({ corpus_revision: snapshot.corpus_revision, hashes, generation, revisions, source_ids }), { mode: 0o600 });
    fs.renameSync(temporary, manifestPath);
    return { mode, upserts: upserts.length, deletes: deletes.length };
  }

  async status(): Promise<RetrievalWorkerStatus> {
    return this.request(await this.ensure(), "/status");
  }

  async observeStatus(signal?: AbortSignal): Promise<RetrievalWorkerStatus | undefined> {
    const endpoint = this.readEndpoint();
    if (!endpoint || !this.processAlive(endpoint.pid)) return undefined;
    const status = await this.request<RetrievalWorkerStatus>(endpoint, "/status", "GET", undefined, { signal, timeoutMs: 2_000 });
    this.updateLifecycleFromStatus(status);
    return status;
  }

  async search(query: string, limit = 5, contentTypeFilter?: string[], requestId = ""): Promise<any> {
    const result = await this.query({
      schema: RETRIEVAL_QUERY_SCHEMA_V1,
      requestId: requestId || `compat-${Date.now()}`,
      text: query,
      contentTypeFilter: contentTypeFilter as RetrievalQueryV1["contentTypeFilter"],
      scope: { capabilityId: "legacy-search" },
      topK: limit,
      route: "lexical",
      generation: { mode: "latest-ready" },
      diagnostics: "summary",
    });
    return requestId ? result : { ...result, request_id: "", requestId: "" };
  }

  async query(input: RetrievalQueryV1, signal?: AbortSignal): Promise<RetrievalResultV1 & Record<string, any>> {
    const compiled = compileRetrievalQueryV1(input);
    if (!compiled.ok) throw new Error(`Invalid retrieval query: ${compiled.diagnostics.map(item => `${item.pointer} ${item.message}`).join("; ")}`);
    if (input.level === "l2-passage") throw new Error("The unified worker returns L1 sources, not L2 passage ranges.");
    if (signal?.aborted) throw signal.reason instanceof Error ? signal.reason : new Error("Retrieval query cancelled.");
    const startedAt = Date.now();
    const deadlineAt = startedAt + (input.deadlineMs || 5_000);
    let status = await this.status();
    const matchesGeneration = (): boolean => input.generation.mode === "latest-ready"
      || (input.generation.mode === "exact" && status.ready_generation === input.generation.generation)
      || (input.generation.mode === "minimum" && status.ready_generation >= input.generation.generation);
    while (!matchesGeneration() && Date.now() < deadlineAt) {
      if (input.generation.mode === "exact" && status.ready_generation > input.generation.generation) {
        throw new Error(`Exact retrieval generation ${input.generation.generation} is unavailable; ready generation is ${status.ready_generation}.`);
      }
      await new Promise<void>((resolve, reject) => {
        const complete = () => {
          signal?.removeEventListener("abort", abort);
          resolve();
        };
        const timer = setTimeout(complete, 25);
        const abort = () => { clearTimeout(timer); reject(signal?.reason || new Error("Retrieval query cancelled.")); };
        if (signal?.aborted) abort();
        else signal?.addEventListener("abort", abort, { once: true });
      });
      status = await this.status();
    }
    if (!matchesGeneration()) throw new Error(`Retrieval generation policy was not satisfied before the deadline.`);
    const waitFinishedAt = Date.now();
    const result = await this.request<any>(await this.ensure(), "/search", "POST", {
      query: input.text,
      limit: input.topK,
      content_type_filter: input.contentTypeFilter,
      request_id: input.requestId,
      route: input.route,
      generation: input.generation,
      scope: {
        capability_id: input.scope.capabilityId,
        source_ids: input.scope.sourceIds,
        include_read_only: input.scope.includeReadOnly,
      },
      graph: input.graph ? {
        max_depth: input.graph.maxDepth,
        max_nodes: input.graph.maxNodes,
        max_edges: input.graph.maxEdges,
        relations: input.graph.relations,
        direction: input.graph.direction,
      } : undefined,
      diagnostics: input.diagnostics,
      deadline_at_ms: deadlineAt,
    }, { signal, timeoutMs: Math.max(1, deadlineAt - Date.now()) });
    const completedAt = Date.now();
    const normalized = {
      ...result,
      schema: "pkm.retrieval.result/v1",
      requestId: result.request_id,
      readyGeneration: result.ready_generation,
      corpusRevision: result.corpus_revision,
      intent: result.query_intent,
      timingsMs: {
        wait: waitFinishedAt - startedAt,
        search: completedAt - waitFinishedAt,
        total: completedAt - startedAt,
      },
      hits: (result.hits || []).map((hit: any) => ({
        ...hit,
        scoreComponents: hit.score_components || { lexical: hit.score || 0, semantic: 0, graph: 0, priority: 1 },
        sourceId: hit.source_id || hit.skill_id,
        sourceRevision: hit.source_revision || hit.content_hash,
        contentHash: hit.content_hash,
        contentType: hit.content_type,
        sourceUri: hit.source_uri,
        readOnly: !!hit.read_only,
        route: input.route,
        serving:workerHitServingIdentity(status.engine_version, result, hit.contributing_routes, hit.score_semantics),
      })),
      diagnostics: result.diagnostics || [],
      stale: !!result.stale,
      incomplete: !!result.incomplete,
    };
    assertRetrievalResultForQuery(input, normalized);
    return normalized;
  }
}
