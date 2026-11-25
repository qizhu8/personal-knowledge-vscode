import { spawn, type ChildProcess } from "node:child_process";
import { closeSync } from "node:fs";
import { createHash, createHmac, randomBytes, randomUUID } from "node:crypto";
import { isAbsolute } from "node:path";
import { z } from "zod";
import {
  RUNTIME_PROCESS_LIMITS, runtimeProcessDefinitions, runtimeProcessIdentity,
  type RuntimeProcessJob, type RuntimeProcessEvent, type RuntimeProcessRequest,
} from "./runtime-process-contracts.js";
import { RuntimeProcessError, RuntimeProcessStore } from "./runtime-process-store.js";
import { LinuxProcessGroup } from "./linux-process-group.js";

export { runtimeProcessDefinitions, RUNTIME_PROCESS_LIMITS, RUNTIME_PROCESS_MODULE_SCHEMA } from "./runtime-process-contracts.js";
export { RuntimeProcessError, RuntimeProcessStore, RUNTIME_PROCESS_DDL } from "./runtime-process-store.js";
export type { RuntimeProcessJob, RuntimeProcessRequest } from "./runtime-process-contracts.js";

type Json = z.infer<ReturnType<typeof z.json>>;
type Limits = { [K in keyof typeof RUNTIME_PROCESS_LIMITS]: number };

/** Native-only configuration. Adapters must not create descendants, detach or invoke a shell.
 * The executable/cwd/environment are host allowlist entries, never request fields.
 * The environment defaults to empty: credentials and NODE_OPTIONS are not inherited.
 */
export interface RuntimeProcessAdapter {
  id: string;
  executable: string;
  cwd?: string;
  env?: Readonly<Record<string, string>>;
  arguments(input: Json): readonly string[];
  /** Synchronous native admission fence, rechecked immediately before spawning. */
  assertCurrent?(args: readonly string[]): void;
  /** Linux process-group-only, freshly opened descriptors owned by this launch. */
  openLaunch?(args: readonly string[]): { executable: number; cwd: number };
  stdin?: boolean;
  outputPersistence?: "stored" | "ephemeral";
  /** Trusted per-adapter capture bounds may only narrow the service limits. */
  outputLimits?: Readonly<{ stdoutBytes: number; stderrBytes: number }>;
  /** Trusted opt-in only. Processes that leave the group are not contained. */
  processScope?: "direct-child" | "linux-process-group";
}
export interface RuntimeProcessOptions {
  repositoryFactory(ownerId: string, eventCapacity: number): RuntimeProcessStore;
  adapters: readonly RuntimeProcessAdapter[];
  /** Native-only resolution from already admitted, in-memory host state. */
  resolveAdapter?(id: string, input: Json): RuntimeProcessAdapter | undefined;
  authorizeLaunch(request: { actorId: string; adapterId: string; input: Json }): Promise<boolean>;
  limits?: Partial<Limits>;
  /** Exact native Original Portal command authority; never populated by public runtime arguments. */
  originalPortalCommand?: { assertCurrent(): void };
  /** Private Chat-only durable combined output sink; never used by the public dispatcher. */
  legacyChatCapture?: {
    write(jobId: string, stream: "stdout" | "stderr", bytes: Buffer): void;
    finish(jobId: string): void;
  };
}
export interface RuntimeProcessLaunch {
  actorId: string;
  operationId: string;
  adapterId: string;
  input: Json;
  deadlineMs?: number;
  stdin?: Uint8Array;
}
export interface RuntimeProcessDiagnostics {
  activeAdmissions: number;
  queued: number;
  running: number;
  unconsumedCaptures: number;
  activeJobs: number;
  closed: boolean;
  persistenceUnavailable: boolean;
}
type Task = {
  job: RuntimeProcessJob; adapter: RuntimeProcessAdapter; args: string[];
  child?: ChildProcess; deadline?: NodeJS.Timeout; escalation?: NodeJS.Timeout;
  pipeDeadline?: NodeJS.Timeout; stopReason?: RuntimeProcessJob["reason"];
  stdout: Buffer; stderr: Buffer; done: Promise<RuntimeProcessJob>;
  stdin?: Buffer;
  group?: LinuxProcessGroup; pausedAt?: number; controlPending?: boolean;
  resolve(job: RuntimeProcessJob): void;
};
const terminal = (job: RuntimeProcessJob) => !["QUEUED", "RUNNING", "PAUSED"].includes(job.state);
const clone = (job: RuntimeProcessJob): RuntimeProcessJob => structuredClone(job);
function fail(code: string, message: string): never { throw new RuntimeProcessError(code, message); }
function canonical(value: Json): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonical(value[key])}`).join(",")}}`;
}

/** Host-neutral direct-child ownership. No inventory, IPC listener, PID adoption, process-group
 * signal, automatic replay or public launch operation exists. Await close BEFORE closing SQLite.
 */
export class RuntimeProcessService {
  readonly ownerId = randomUUID();
  readonly limits: Readonly<Limits>;
  private readonly store: RuntimeProcessStore;
  private readonly adapters = new Map<string, RuntimeProcessAdapter>();
  private readonly tasks = new Map<string, Task>();
  private readonly queue: Task[] = [];
  private readonly admissions = new Map<string, { fingerprint: string; promise: Promise<RuntimeProcessJob> }>();
  private readonly captures = new Map<string, Task>();
  private readonly stdinKey = randomBytes(32);
  private running = 0;
  private closed = false;
  private closing?: Promise<void>;
  private persistenceFailure?: unknown;

  constructor(private readonly options: RuntimeProcessOptions) {
    options.originalPortalCommand?.assertCurrent();
    const ceilings = options.legacyChatCapture || options.originalPortalCommand
      ? { ...RUNTIME_PROCESS_LIMITS, deadlineMs: 86_400_000 } : RUNTIME_PROCESS_LIMITS;
    const limits = { ...RUNTIME_PROCESS_LIMITS, ...options.limits };
    for (const key of Object.keys(RUNTIME_PROCESS_LIMITS) as (keyof Limits)[]) {
      const minimum = ["queue", "stdoutBytes", "stderrBytes", "closeDrainMs"].includes(key) ? 0 : 1;
      if (!Number.isSafeInteger(limits[key]) || limits[key] < minimum || limits[key] > ceilings[key]) {
        fail("INVALID_LIMIT", `Invalid runtime process limit: ${key}.`);
      }
    }
    this.limits = Object.freeze(limits);
    if (typeof options.authorizeLaunch !== "function") fail("INVALID_ADAPTER", "Trusted launch authorization is required.");
    for (const adapter of options.adapters) {
      runtimeProcessIdentity.parse(adapter.id);
      if (this.adapters.has(adapter.id) || !isAbsolute(adapter.executable) || adapter.executable.includes("\0")
        || (adapter.cwd !== undefined && (!isAbsolute(adapter.cwd) || adapter.cwd.includes("\0")))
        || typeof adapter.arguments !== "function" || (adapter.stdin !== undefined && typeof adapter.stdin !== "boolean")
        || (adapter.outputPersistence !== undefined && !["stored", "ephemeral"].includes(adapter.outputPersistence))
        || (adapter.processScope !== undefined && !["direct-child", "linux-process-group"].includes(adapter.processScope))
        || (adapter.processScope === "linux-process-group" && process.platform !== "linux")) fail("INVALID_ADAPTER", "Invalid or duplicate allowlisted adapter.");
      const env = Object.freeze({ ...adapter.env });
      if (Object.entries(env).some(([key, value]) => !key || /[=\0]/.test(key) || typeof value !== "string" || value.includes("\0"))) {
        fail("INVALID_ADAPTER", "Adapter environment must be explicit string entries.");
      }
      this.adapters.set(adapter.id, Object.freeze({ ...adapter, env }));
    }
    this.store = options.repositoryFactory(this.ownerId, this.limits.events);
    if (this.store.ownerId !== this.ownerId) fail("INVALID_REPOSITORY", "Repository factory returned a different runtime owner.");
    this.store.assertOwner();
  }

  /** Native library boundary only. An actor ID must come from the trusted host principal,
   * not from HTTP arguments. Returns a durable acceptance receipt, not process completion.
   */
  async launch(request: RuntimeProcessLaunch): Promise<RuntimeProcessJob> {
    this.available();
    const actorId = runtimeProcessIdentity.parse(request.actorId);
    const operationId = z.string().uuid().parse(request.operationId);
    const adapterId = runtimeProcessIdentity.parse(request.adapterId);
    const deadlineMs = request.deadlineMs ?? this.limits.deadlineMs;
    if (!Number.isSafeInteger(deadlineMs) || deadlineMs < 1 || deadlineMs > this.limits.deadlineMs) fail("INVALID_DEADLINE", "Deadline exceeds configured bounds.");
    let input: Json;
    let encoded: string;
    try {
      encoded = canonical(z.json().parse(request.input));
      if (Buffer.byteLength(encoded) > this.limits.inputBytes) fail("INPUT_LIMIT", "Adapter input exceeds its byte limit.");
      input = JSON.parse(encoded) as Json;
    } catch (error) {
      if (error instanceof RuntimeProcessError) throw error;
      fail("INVALID_INPUT", "Adapter input must be bounded JSON.");
    }
    const candidate = this.adapters.get(adapterId) ?? this.options.resolveAdapter?.(adapterId, input);
    if (!candidate || candidate.id !== adapterId || !isAbsolute(candidate.executable) || candidate.executable.includes("\0")
      || (candidate.cwd !== undefined && (!isAbsolute(candidate.cwd) || candidate.cwd.includes("\0")))
      || typeof candidate.arguments !== "function" || (candidate.stdin !== undefined && typeof candidate.stdin !== "boolean")
      || (candidate.outputPersistence !== undefined && !["stored", "ephemeral"].includes(candidate.outputPersistence))
      || candidate.outputLimits !== undefined && (!candidate.outputLimits || typeof candidate.outputLimits !== "object"
        || (["stdoutBytes", "stderrBytes"] as const).some(key =>
          !Number.isSafeInteger(candidate.outputLimits![key]) || candidate.outputLimits![key] < 0
          || candidate.outputLimits![key] > this.limits[key]))
      || (candidate.processScope !== undefined && !["direct-child", "linux-process-group"].includes(candidate.processScope))
      || (candidate.processScope === "linux-process-group" && process.platform !== "linux"))
      fail("ADAPTER_UNAVAILABLE", "Native process adapter is unavailable or invalid.");
    const env = Object.freeze({ ...candidate.env });
    if (Object.entries(env).some(([key, value]) => !key || /[=\0]/.test(key) || typeof value !== "string" || value.includes("\0")))
      fail("INVALID_ADAPTER", "Adapter environment must be explicit string entries.");
    const adapter = Object.freeze({ ...candidate, env,
      ...(candidate.outputLimits ? { outputLimits: Object.freeze({ ...candidate.outputLimits }) } : {}) });
    if (request.stdin !== undefined && (!(request.stdin instanceof Uint8Array) || adapter.stdin !== true
      || request.stdin.byteLength > this.limits.inputBytes)) fail("INPUT_LIMIT", "Stdin is not enabled or exceeds its byte limit.");
    const stdin = request.stdin === undefined ? undefined : Buffer.from(request.stdin);
    const stdinFingerprint = stdin === undefined ? undefined : createHmac("sha256", this.stdinKey).update(stdin).digest("hex");
    const fingerprint = createHash("sha256").update(JSON.stringify(stdinFingerprint === undefined
      ? [adapterId, encoded, deadlineMs] : [adapterId, encoded, deadlineMs, stdinFingerprint])).digest("hex");
    const key = `${actorId}/${operationId}`;
    const admission = this.admissions.get(key);
    if (admission) {
      if (admission.fingerprint !== fingerprint) fail("OPERATION_CONFLICT", "Operation receipt input changed.");
      return clone(await admission.promise);
    }
    if (this.admissions.size >= this.limits.concurrency + this.limits.queue) fail("BUSY", "Launch admission queue is full.");
    const promise = this.admit({ actorId, operationId, adapterId, input, deadlineMs, stdin }, adapter, fingerprint);
    this.admissions.set(key, { fingerprint, promise });
    try { return clone(await promise); }
    finally { this.admissions.delete(key); }
  }
  private async admit(request: { actorId: string; operationId: string; adapterId: string; input: Json; deadlineMs: number; stdin?: Buffer }, adapter: RuntimeProcessAdapter, fingerprint: string) {
    if (!await this.options.authorizeLaunch({
      actorId: request.actorId, adapterId: request.adapterId, input: structuredClone(request.input),
    })) fail("FORBIDDEN", "Native adapter launch is not authorized.");
    this.available();
    const previous = this.store.receipt(request.actorId, request.operationId);
    if (previous) {
      if (previous.fingerprint !== fingerprint) fail("OPERATION_CONFLICT", "Operation receipt input changed.");
      return previous.job;
    }
    if (this.tasks.size >= this.limits.concurrency + this.limits.queue) fail("BUSY", "Process job queue is full.");
    if (adapter.outputPersistence === "ephemeral" && this.captures.size >= this.limits.concurrency + this.limits.queue) {
      fail("BUSY", "Unconsumed native captures reached their bound.");
    }
    const args = [...adapter.arguments(request.input)];
    if (args.length > this.limits.arguments || args.some(arg => typeof arg !== "string" || arg.includes("\0"))
      || Buffer.byteLength(JSON.stringify(args)) > this.limits.argumentBytes) fail("ARGUMENT_LIMIT", "Configured adapter arguments exceed bounds.");
    const now = Date.now();
    const job: RuntimeProcessJob = {
      schema: "pkm.runtime-process.job/v1", jobId: randomUUID(), operationId: request.operationId,
      actorId: request.actorId, adapterId: request.adapterId, ownerId: this.ownerId, attemptId: randomUUID(),
      state: "QUEUED", effect: "not-started", createdAt: now, startedAt: null, finishedAt: null,
      deadlineAt: now + request.deadlineMs, pid: null, exitCode: null, signal: null, reason: null,
      stdout: "", stderr: "", stdoutBytes: 0, stderrBytes: 0,
      stdoutDroppedBytes: 0, stderrDroppedBytes: 0, eventSequence: 0,
    };
    this.store.insert(job, fingerprint, this.limits.jobs);
    let resolve!: Task["resolve"];
    const done = new Promise<RuntimeProcessJob>(accept => { resolve = accept; });
    const task: Task = { job, adapter, args, stdin: request.stdin, stdout: Buffer.alloc(0), stderr: Buffer.alloc(0), done, resolve };
    this.tasks.set(job.jobId, task);
    if (adapter.outputPersistence === "ephemeral") this.captures.set(job.jobId, task);
    this.queue.push(task);
    task.deadline = setTimeout(() => this.stop(task, "deadline"), request.deadlineMs);
    queueMicrotask(() => this.pump());
    return clone(job);
  }
  private available() {
    if (this.closed) fail("CLOSED", "Runtime process service is closing.");
    if (this.persistenceFailure) throw new RuntimeProcessError("PERSISTENCE_UNAVAILABLE", "Process persistence failed; new effects are blocked.", "unknown");
    this.store.assertOwner();
  }
  private save(task: Task, kind: RuntimeProcessEvent["kind"], bytes?: number) {
    try { this.store.save(task.job, kind, bytes); }
    catch (error) {
      this.persistenceFailure = error;
      // Stop only this instance's live handles. A failed/taken-over repository is never
      // a reason to adopt or signal any PID read from persistence.
      for (const current of this.tasks.values()) {
        if (current.child) this.stop(current, "persistence-error");
        else this.finish(current, "persistence-error");
      }
    }
  }
  private pump() {
    while (!this.persistenceFailure && this.running < this.limits.concurrency && this.queue.length) {
      const task = this.queue.shift()!;
      if (!this.tasks.has(task.job.jobId)) continue;
      if (Date.now() >= task.job.deadlineAt) { this.stop(task, "deadline"); continue; }
      try { this.store.assertOwner(); }
      catch (error) {
        this.persistenceFailure = error;
        for (const current of this.tasks.values()) this.stop(current, "persistence-error");
        return;
      }
      try {
        if (task.adapter.assertCurrent) {
          const result = task.adapter.assertCurrent(Object.freeze([...task.args])) as unknown;
          if (result !== undefined) {
            if (result && (typeof result === "object" || typeof result === "function")
              && typeof (result as { then?: unknown }).then === "function")
              void Promise.resolve(result).catch(() => {});
            throw new Error("Process admission fence must be synchronous.");
          }
        }
      } catch {
        this.finish(task, "spawn-error");
        continue;
      }
      let descriptors: { executable: number; cwd: number } | undefined;
      const releaseDescriptors = () => {
        const opened = descriptors;
        descriptors = undefined;
        if (opened) {
          for (const fd of new Set([opened.executable, opened.cwd])) {
            if (!Number.isInteger(fd) || fd < 3) continue;
            try { closeSync(fd); } catch { /* Already closed or invalid. */ }
          }
        }
      };
      try {
        if (task.adapter.openLaunch) {
          if (task.adapter.processScope !== "linux-process-group")
            throw new Error("Pinned launch requires a Linux process group.");
          descriptors = task.adapter.openLaunch(Object.freeze([...task.args]));
          if (descriptors && typeof (descriptors as unknown as { then?: unknown }).then === "function") {
            void Promise.resolve(descriptors).catch(() => {});
            descriptors = undefined;
            throw new Error("Pinned launch must be synchronous.");
          }
          if (!descriptors || !Number.isInteger(descriptors.executable) || !Number.isInteger(descriptors.cwd)
            || descriptors.executable < 3 || descriptors.cwd < 3 || descriptors.executable === descriptors.cwd)
            throw new Error("Invalid pinned process descriptors.");
        }
      } catch {
        releaseDescriptors();
        this.finish(task, "spawn-error");
        continue;
      }
      task.job.state = "RUNNING";
      task.job.effect = "unknown";
      task.job.startedAt = Date.now();
      this.save(task, "running");
      if (this.persistenceFailure) {
        releaseDescriptors();
        return;
      }
      this.running++;
      try {
        const group = task.adapter.processScope === "linux-process-group" ? new LinuxProcessGroup({
          executable: task.adapter.executable, args: task.args, cwd: task.adapter.cwd,
          env: { ...task.adapter.env }, stdin: task.stdin !== undefined, graceMs: this.limits.graceMs,
          descriptors,
        }) : undefined;
        releaseDescriptors();
        const child = group?.child ?? spawn(task.adapter.executable, task.args, {
          cwd: task.adapter.cwd, env: task.adapter.env, shell: false, detached: false,
          windowsHide: true, stdio: [task.stdin === undefined ? "ignore" : "pipe", "pipe", "pipe"],
        });
        task.group = group;
        task.child = child;
        if (task.stdin !== undefined) {
          child.stdin!.on("error", () => this.stop(task, "cancel"));
          child.stdin!.end(task.stdin);
          task.stdin = undefined;
        }
        child.once("spawn", () => {
          task.job.pid = child.pid ?? null;
          this.save(task, "spawned");
        });
        child.stdout!.on("data", (chunk: Buffer) => this.output(task, "stdout", chunk));
        child.stderr!.on("data", (chunk: Buffer) => this.output(task, "stderr", chunk));
        child.once("error", () => { task.stopReason ??= "spawn-error"; });
        child.once("exit", () => {
          if (task.deadline) clearTimeout(task.deadline);
          if (task.escalation) clearTimeout(task.escalation);
          // A misconfigured adapter's inherited pipes must not hold shutdown open.
          task.pipeDeadline = setTimeout(() => {
            child.stdout?.destroy(); child.stderr?.destroy();
          }, this.limits.graceMs);
        });
        child.once("close", (code, signal) => {
          const complete = (result: { code: number | null; signal: NodeJS.Signals | null; error?: string; notStarted?: boolean }) => {
            task.job.exitCode = result.code;
            task.job.signal = result.signal;
            this.running--;
            this.finish(task, result.error && !result.notStarted ? "supervisor-error"
              : task.stopReason ?? (result.notStarted ? "spawn-error" : "exit"));
            this.pump();
          };
          if (group) void group.done.then(complete);
          else complete({ code, signal });
        });
      } catch {
        releaseDescriptors();
        this.running--;
        this.finish(task, "spawn-error");
      }
    }
  }
  private output(task: Task, stream: "stdout" | "stderr", chunk: Buffer) {
    if (this.options.legacyChatCapture) {
      try {
        const total = task.job.stdoutBytes + task.job.stderrBytes;
        const kept = chunk.subarray(0, Math.max(0, 64 * 1024 * 1024 - total));
        if (kept.length) this.options.legacyChatCapture.write(task.job.jobId, stream, kept);
        task.job[stream === "stdout" ? "stdoutBytes" : "stderrBytes"] += kept.length;
        this.save(task, stream, kept.length);
        if (kept.length < chunk.length) this.stop(task, "output-limit");
      } catch {
        this.stop(task, "persistence-error");
      }
      return;
    }
    const cap = stream === "stderr" && task.adapter.outputPersistence === "ephemeral" ? 0
      : (task.adapter.outputLimits ?? this.limits)[stream === "stdout" ? "stdoutBytes" : "stderrBytes"];
    const kept = chunk.subarray(0, Math.max(0, cap - task[stream].length));
    if (kept.length) task[stream] = Buffer.concat([task[stream], kept]);
    task.job[stream] = task.adapter.outputPersistence === "ephemeral" ? "" : task[stream].toString("base64");
    if (stream === "stdout") {
      task.job.stdoutBytes += chunk.length;
      task.job.stdoutDroppedBytes = task.job.stdoutBytes - task.stdout.length;
    } else {
      task.job.stderrBytes += chunk.length;
      task.job.stderrDroppedBytes = task.job.stderrBytes - task.stderr.length;
    }
    this.save(task, stream, chunk.length);
  }
  private signal(task: Task, signal: NodeJS.Signals) {
    const child = task.child;
    if (this.tasks.get(task.job.jobId) !== task || !child || child.exitCode !== null || child.signalCode !== null) return;
    // ChildProcess retains the OS handle until exit. Never use process.kill(pid),
    // signal 0, negative PIDs, or persisted identity to reconstruct ownership.
    try { child.kill(signal); } catch { /* Close/deadline still observes the owned handle. */ }
  }
  private stop(task: Task, reason: RuntimeProcessJob["reason"]) {
    if (!this.tasks.has(task.job.jobId) || task.stopReason) return;
    task.stopReason = reason;
    task.job.reason = reason;
    if (!task.child) { this.finish(task, reason); this.pump(); return; }
    if (!this.persistenceFailure) this.save(task, "stopping");
    if (task.group) {
      void task.group.control("cancel").catch(() => {});
      return;
    }
    this.signal(task, "SIGTERM");
    task.escalation = setTimeout(() => this.signal(task, "SIGKILL"), this.limits.graceMs);
  }
  private finish(task: Task, reason: RuntimeProcessJob["reason"]) {
    if (!this.tasks.has(task.job.jobId)) return;
    for (const timer of [task.deadline, task.escalation, task.pipeDeadline]) if (timer) clearTimeout(timer);
    const index = this.queue.indexOf(task);
    if (index >= 0) this.queue.splice(index, 1);
    try { this.options.legacyChatCapture?.finish(task.job.jobId); }
    catch { reason = "persistence-error"; }
    const started = task.job.startedAt !== null;
    task.job.reason = reason;
    task.job.finishedAt = Date.now();
    task.job.state = reason === "deadline" ? "TIMED_OUT" : reason === "output-limit" ? "OUTPUT_LIMIT"
      : reason === "cancel" || reason === "shutdown" ? "CANCELLED"
      : reason === "persistence-error" || reason === "supervisor-error" ? "INTERRUPTED"
      : reason === "exit" && task.job.exitCode === 0 ? "SUCCEEDED" : "FAILED";
    task.job.effect = !started || reason === "spawn-error" ? "not-started"
      : reason === "exit" ? "completed" : "unknown";
    this.tasks.delete(task.job.jobId);
    if (!this.persistenceFailure) this.save(task, "finished");
    task.resolve(clone(task.job));
  }
  status(actorId: string, jobId: string) { return this.store.get(runtimeProcessIdentity.parse(actorId), z.string().uuid().parse(jobId)); }
  async wait(actorId: string, jobId: string): Promise<RuntimeProcessJob> {
    const job = this.status(actorId, jobId);
    return clone(await (this.tasks.get(jobId)?.done ?? Promise.resolve(job)));
  }
  /** Bounded host diagnostics only. No actor, operation, adapter, command, path, environment,
   * stdin, output or persistence error is exposed.
   */
  diagnostics(): Readonly<RuntimeProcessDiagnostics> {
    return Object.freeze({
      activeAdmissions: this.admissions.size,
      queued: this.queue.length,
      running: this.running,
      unconsumedCaptures: this.captures.size,
      activeJobs: this.tasks.size,
      closed: this.closed,
      persistenceUnavailable: this.persistenceFailure !== undefined,
    });
  }
  /** One-shot native-only capture; never reconstructed from a durable receipt after restart. */
  async waitCaptured(actorId: string, jobId: string): Promise<{ job: RuntimeProcessJob; stdout: Buffer } | undefined> {
    this.status(actorId, jobId);
    const task = this.captures.get(jobId);
    if (!task || task.job.actorId !== actorId) return undefined;
    this.captures.delete(jobId);
    const job = await task.done;
    return { job: clone(job), stdout: task.stdout };
  }
  async cancel(actorId: string, jobId: string): Promise<RuntimeProcessJob> {
    const job = this.status(actorId, jobId);
    if (terminal(job)) return job;
    this.store.assertOwner();
    const task = this.tasks.get(jobId);
    if (!task) fail("OWNERSHIP_CONFLICT", "This instance does not own the active child.");
    this.stop(task, "cancel");
    return this.status(actorId, jobId);
  }
  private async setPaused(actorId: string, jobId: string, pause: boolean): Promise<RuntimeProcessJob> {
    if (this.closed) fail("CLOSED", "Runtime process service is closing.");
    const job = this.status(actorId, jobId);
    if (terminal(job)) fail("INVALID_STATE", "A finished process cannot be paused or resumed.");
    this.store.assertOwner();
    const task = this.tasks.get(jobId);
    if (!task || !task.group || task.stopReason) fail("OWNERSHIP_CONFLICT", "No live owned Linux process group is available.");
    if (task.controlPending) fail("BUSY", "A process control is already in progress.");
    if (task.job.state === (pause ? "PAUSED" : "RUNNING")) return clone(task.job);
    if (task.job.state !== (pause ? "RUNNING" : "PAUSED")) fail("INVALID_STATE", "The process group is not ready for this control.");
    task.controlPending = true;
    try {
      await task.group.control(pause ? "pause" : "resume");
      try { this.store.assertOwner(); } catch (error) { this.stop(task, "persistence-error"); throw error; }
      if (this.tasks.get(jobId) !== task || task.stopReason) fail("OWNERSHIP_CONFLICT", "Process control raced with completion.");
      if (pause) {
        task.pausedAt = Date.now();
        if (task.deadline) clearTimeout(task.deadline);
        task.job.state = "PAUSED";
      } else {
        task.job.deadlineAt += Date.now() - task.pausedAt!;
        task.pausedAt = undefined;
        task.job.state = "RUNNING";
        task.deadline = setTimeout(() => this.stop(task, "deadline"), Math.max(1, task.job.deadlineAt - Date.now()));
      }
      this.save(task, pause ? "paused" : "resumed");
      if (this.persistenceFailure) fail("PERSISTENCE_UNAVAILABLE", "Process control persistence failed.");
      return clone(task.job);
    } finally { task.controlPending = false; }
  }
  pause(actorId: string, jobId: string) { return this.setPaused(actorId, jobId, true); }
  resume(actorId: string, jobId: string) { return this.setPaused(actorId, jobId, false); }
  /** Native-only deadline cancellation; never signals a persisted PID. */
  async expire(actorId: string, jobId: string): Promise<RuntimeProcessJob> {
    const job = this.status(actorId, jobId);
    if (terminal(job)) return job;
    this.store.assertOwner();
    const task = this.tasks.get(jobId);
    if (!task) fail("OWNERSHIP_CONFLICT", "This instance does not own the active child.");
    this.stop(task, "deadline");
    return this.status(actorId, jobId);
  }
  /** Public dispatcher: authenticate actor in the host, then await OUTSIDE SQLite transactions.
   * It intentionally has no launch, arbitrary executable, shell, environment or remote operation.
   */
  async request(actorId: string, request: RuntimeProcessRequest): Promise<unknown> {
    runtimeProcessIdentity.parse(actorId);
    const definition = runtimeProcessDefinitions.find(item => item.id === request.operation);
    if (!definition) fail("NOT_FOUND", "Unknown process operation.");
    const args = definition.input.parse(request.args);
    switch (request.operation) {
      case "runtime.process.status": return this.status(actorId, (args as { jobId: string }).jobId);
      case "runtime.process.cancel": return this.cancel(actorId, (args as { jobId: string }).jobId);
      case "runtime.process.pause": return this.pause(actorId, (args as { jobId: string }).jobId);
      case "runtime.process.resume": return this.resume(actorId, (args as { jobId: string }).jobId);
      case "runtime.process.list": {
        const { offset, limit } = runtimeProcessDefinitions[1].input.parse(args);
        return this.store.list(actorId, offset, limit);
      }
      case "runtime.process.events": {
        const { jobId, after, limit } = runtimeProcessDefinitions[2].input.parse(args);
        return this.store.events(actorId, jobId, after, limit);
      }
    }
  }
  /** Drain accepted jobs, then cancel remaining jobs and reap direct children.
   * An unresolved trusted authorization cannot launch after this boundary.
   */
  close(options: { drainMs?: number } = {}): Promise<void> {
    if (this.closing) return this.closing;
    const drainMs = options.drainMs ?? this.limits.closeDrainMs;
    if (!Number.isSafeInteger(drainMs) || drainMs < 0 || drainMs > this.limits.closeDrainMs) fail("INVALID_DEADLINE", "Invalid shutdown drain bound.");
    this.closed = true;
    this.closing = this.closeOwned(drainMs).catch(error => {
      this.closing = undefined;
      throw error;
    });
    return this.closing;
  }
  private async closeOwned(drainMs: number) {
    let drainTimer: NodeJS.Timeout | undefined;
    const all = Promise.all([...this.tasks.values()].map(task => task.done));
    try {
      await Promise.race([all, new Promise<void>(resolve => { drainTimer = setTimeout(resolve, drainMs); })]);
    } finally { if (drainTimer) clearTimeout(drainTimer); }
    for (const task of [...this.tasks.values()]) this.stop(task, "shutdown");
    let reapTimer: NodeJS.Timeout | undefined;
    try {
      await Promise.race([
        all,
        new Promise<never>((_, reject) => {
          reapTimer = setTimeout(() => reject(new RuntimeProcessError("REAP_TIMEOUT", "Owned child did not close; do not close its repository.", "unknown")), this.limits.graceMs * 2 + 1000);
        }),
      ]);
    } finally { if (reapTimer) clearTimeout(reapTimer); }
    if (this.persistenceFailure) throw new RuntimeProcessError("PERSISTENCE_UNAVAILABLE", "Children were reaped but lifecycle persistence requires reconciliation.", "unknown");
    this.captures.clear();
    this.store.release();
  }
}
