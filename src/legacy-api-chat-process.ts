import { createHash, randomUUID } from "node:crypto";
import { lstatSync, realpathSync, statSync } from "node:fs";
import { isAbsolute, join, sep } from "node:path";
import { StringDecoder } from "node:string_decoder";
import type { DatabaseSync } from "node:sqlite";
import { z } from "zod";
import { RuntimeProcessService, RuntimeProcessStore } from "./runtime-process.js";
import type { LegacyManagedChatBinding } from "./legacy-api-chat-managed-runtime.js";
import { originalProcessOutput, originalProcessRecord } from "./legacy-api-chat-process-evidence.js";
import { LegacyChatProcessCapture } from "./legacy-api-chat-process-capture.js";

export type LegacyChatProcessScope = Pick<LegacyManagedChatBinding, "root" | "workspaceId" | "actorId" | "sourceFingerprint" | "namespace" | "chatId">;
type Scope = LegacyChatProcessScope;
type Spec = { program: string; arguments: string[]; cwd: string; timeoutSeconds: number };
export type LegacyChatProcessAction = "run_process" | "process_get" | "process_output" | "process_cancel" | "pause" | "resume" | "stop-ui" | "chat-stop";
type Action = LegacyChatProcessAction;
type Command = { id: string; program: string; cwd: string; arguments(args: readonly string[]): boolean;
  openLaunch?(args: readonly string[]): { executable: number; cwd: number } };
export type LegacyChatOriginalEvidenceSource = { root: string; assertCurrent(): void };
const handlePattern = /^(?:process_[a-f0-9]{64}|foreground_\d{13}-[a-f0-9-]{36})$/;
const hash = (value: string) => createHash("sha256").update(value).digest("hex");
const scopeId = (scope: Scope) => `chat:${hash(JSON.stringify([scope.actorId, scope.namespace, scope.chatId]))}`;
const groupScopeDetail = "Control covers the managed process group only; descendants that leave it may continue running.";
const pinnedLaunchDetail = "Linux descriptor-based execution requires an active selected owner and source, readable executable and working directory, usable /proc/self/fd, unchanged configured objects, and an available interpreter.";

/**
 * Host-only, opt-in Chat adapter. Commands and their argument policies are configured
 * by the native host; model arguments cannot register programs or choose a signal.
 * The database must be dedicated to this process authority, not the Workflow store.
 */
export class LegacyApiChatProcesses {
  private readonly runtime: RuntimeProcessService;
  private readonly capture: LegacyChatProcessCapture;
  private readonly commands: Map<string, Command>;
  private originalEvidenceIdentity?: { root: string; dev: number; ino: number };
  private readonly paused = new Map<string, number>();
  private readonly launching = new Map<string, Set<Promise<void>>>();
  private closed = false;
  private closing?: Promise<void>;
  constructor(private readonly options: {
    database: DatabaseSync; captureDirectory: string; root: string; workspaceId: string; actorId: string; sourceFingerprint: string;
    commands: readonly Command[]; assertOwner(): void;
    authorize(scope: Scope, action: Action, detail: unknown, signal?: AbortSignal): Promise<boolean>;
    previousOwnerId?: string;
    readOriginalEvidence?: boolean;
    originalEvidence?: LegacyChatOriginalEvidenceSource;
  }) {
    if (process.platform !== "linux" || !isAbsolute(options.root) || typeof options.authorize !== "function")
      throw new Error("A trusted Linux Chat process host is required.");
    if (options.captureDirectory === options.root || options.captureDirectory.startsWith(options.root + sep))
      throw new Error("Native process capture must be separate from original Chat evidence.");
    options.assertOwner();
    if (options.originalEvidence) {
      const root = this.originalEvidenceRoot(), identity = statSync(root);
      this.originalEvidenceIdentity = { root, dev: identity.dev, ino: identity.ino };
    }
    this.commands = new Map();
    for (const command of options.commands) {
      if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(command.id) || !isAbsolute(command.program)
        || !isAbsolute(command.cwd) || typeof command.arguments !== "function" || this.commands.has(command.program))
        throw new Error("Invalid configured Chat command.");
      this.commands.set(command.program, Object.freeze({ ...command }));
    }
    if (new Set([...this.commands.values()].map(item => item.id)).size !== this.commands.size)
      throw new Error("Duplicate configured Chat command.");
    options.database.exec(`CREATE TABLE IF NOT EXISTS legacy_chat_process_bindings (
      scope TEXT NOT NULL,handle TEXT NOT NULL,spec TEXT NOT NULL,operation_id TEXT NOT NULL,
      job_id TEXT,created_at INTEGER NOT NULL,PRIMARY KEY(scope,handle));`);
    this.capture = new LegacyChatProcessCapture(options.captureDirectory);
    try { this.runtime = new RuntimeProcessService({
      repositoryFactory: (owner, capacity) => new RuntimeProcessStore(options.database, owner, capacity, options.previousOwnerId),
      adapters: [...this.commands.values()].map(command => ({
        id: command.id, executable: command.program, cwd: command.cwd, processScope: "linux-process-group" as const,
        assertCurrent: (args: readonly string[]) => {
          this.check();
          if (command.arguments(args) !== true) throw new Error("Configured Chat arguments rejected.");
        },
        openLaunch: command.openLaunch ? (args: readonly string[]) => {
          this.check();
          return command.openLaunch!(args);
        } : undefined,
        arguments: input => {
          const value = z.strictObject({ args: z.array(z.string()) }).parse(input);
          if (command.arguments(value.args) !== true) throw new Error("Configured Chat arguments rejected.");
          return value.args;
        },
      })),
      authorizeLaunch: async () => { this.check(); return true; },
      limits: { deadlineMs: 86_400_000 },
      legacyChatCapture: this.capture,
    }); } catch (error) { this.capture.close(); throw error; }
  }
  private check() {
    if (this.closed) throw new Error("Chat process authority is closed.");
    this.options.assertOwner();
  }
  private originalEvidenceRoot(): string {
    const source = this.options.originalEvidence;
    if (!source) {
      if (this.options.readOriginalEvidence === false) throw new Error("Original process evidence is not admitted by this Chat host.");
      return this.options.root;
    }
    const result = source.assertCurrent() as unknown;
    if (result !== undefined) {
      if (result && (typeof result === "object" || typeof result === "function")
        && typeof (result as { then?: unknown }).then === "function") void Promise.resolve(result).catch(() => {});
      throw new Error("Original process evidence fence must be synchronous.");
    }
    if (!isAbsolute(source.root) || realpathSync(source.root) !== source.root)
      throw new Error("Original process evidence root is unavailable or not canonical.");
    const identity = statSync(source.root);
    if (!identity.isDirectory() || (this.originalEvidenceIdentity && (source.root !== this.originalEvidenceIdentity.root
      || identity.dev !== this.originalEvidenceIdentity.dev || identity.ino !== this.originalEvidenceIdentity.ino)))
      throw new Error("Original process evidence root changed.");
    return source.root;
  }
  private readOriginal<T>(read: (root: string) => T): T {
    this.check();
    const root = this.originalEvidenceRoot();
    const value = read(root);
    if (this.originalEvidenceRoot() !== root) throw new Error("Original process evidence source changed while reading.");
    this.check();
    return value;
  }
  private async permitted(scope: Scope, action: Action, detail: unknown, signal?: AbortSignal) {
    this.check();
    if (signal?.aborted) throw new Error("Chat process request was cancelled.");
    if (scope.root !== this.options.root || scope.workspaceId !== this.options.workspaceId
      || scope.actorId !== this.options.actorId || scope.sourceFingerprint !== this.options.sourceFingerprint
      || !/^[a-f0-9]{16}$/.test(scope.namespace) || !/^[a-f0-9-]{36}$/.test(scope.chatId)
      || !await this.options.authorize(scope, action, structuredClone(detail), signal))
      throw new Error("Chat process authority denied.");
    if (signal?.aborted) throw new Error("Chat process request was cancelled.");
    this.check();
  }
  private row(scope: Scope, handle: string): any {
    if (!handlePattern.test(handle)) throw new Error("Choose an exact Chat process handle.");
    const row = this.options.database.prepare("SELECT * FROM legacy_chat_process_bindings WHERE scope=? AND handle=?")
      .get(scopeId(scope), handle);
    if (!row) throw new Error("Process handle is outside this Chat authority.");
    return row;
  }
  private hasRow(scope: Scope, handle: string) {
    return !!this.options.database.prepare("SELECT 1 FROM legacy_chat_process_bindings WHERE scope=? AND handle=?")
      .get(scopeId(scope), handle);
  }
  private record(scope: Scope, handle: string) {
    const row = this.row(scope, handle), spec = JSON.parse(String(row.spec)) as Spec;
    const job = row.job_id ? this.runtime.status(scopeId(scope), String(row.job_id)) : undefined;
    const states: Record<string, string> = { QUEUED: "launching", RUNNING: "running", PAUSED: "paused",
      SUCCEEDED: "complete", FAILED: "failed", CANCELLED: "cancelled", TIMED_OUT: "timed-out",
      OUTPUT_LIMIT: "output-limit", INTERRUPTED: "unknown" };
    return { schema: "pkm.chat.process/v1", handle, spec, state: job ? states[job.state] : "unknown",
      createdAt: Number(row.created_at), updatedAt: job?.finishedAt ?? job?.startedAt ?? Number(row.created_at),
      stdoutBytes: job?.stdoutBytes ?? 0, stderrBytes: job?.stderrBytes ?? 0,
      ...(job?.state === "PAUSED" ? { pausedAt: this.paused.get(job.jobId) ?? job.startedAt ?? job.createdAt } : {}),
      ...(job ? { exitCode: job.exitCode, exitSignal: job.signal } : {}),
      detail: (job?.state === "INTERRUPTED" || !job
        ? "Outcome unknown; processes may still run. No historical PID is signalled or execution replayed. "
        : job?.state === "OUTPUT_LIMIT" ? "Combined stdout/stderr reached the 64 MiB storage limit. "
        : job?.reason === "spawn-error" ? `Program did not start. ${this.commands.get(spec.program)?.openLaunch
          ? pinnedLaunchDetail + " " : "Check the executable, working directory and interpreter. "}` : "") + groupScopeDetail };
  }
  async run(scope: Scope, args: Record<string, unknown>, signal: AbortSignal, executionId: string = randomUUID()) {
    const parsed = z.strictObject({ program: z.string().min(1).max(1024), arguments: z.array(z.string()).max(32),
      cwd: z.string().optional(), timeoutSeconds: z.number().int().min(1).max(86400).optional(),
      background: z.boolean().optional(), idempotency_key: z.string().min(1).max(200).refine(value => !!value.trim()).optional() }).parse(args);
    const background = parsed.background === true, timeoutSeconds = parsed.timeoutSeconds ?? 30;
    if (background && (parsed.timeoutSeconds === undefined || !parsed.idempotency_key))
      throw new Error("Background execution requires a deadline and idempotency key.");
    if (!background && (parsed.idempotency_key !== undefined || timeoutSeconds > 120))
      throw new Error("Foreground execution requires a 1-120 second deadline and no idempotency key.");
    if (JSON.stringify(parsed.arguments).length > 8000 || parsed.arguments.some(item => item.includes("\0")))
      throw new Error("Invalid Chat process arguments.");
    const command = this.commands.get(parsed.program);
    const cwd = parsed.cwd ?? scope.root;
    if (!command || cwd !== command.cwd || command.arguments(parsed.arguments) !== true)
      throw new Error("Program, working directory or arguments are outside this host's explicit allowlist.");
    if (realpathSync(cwd) !== cwd) throw new Error("Configured Chat working directory is no longer canonical.");
    const cwdBefore = statSync(cwd);
    if (!cwdBefore.isDirectory()) throw new Error("Configured Chat working directory is unavailable.");
    const spec = { program: parsed.program, arguments: parsed.arguments, cwd, timeoutSeconds };
    await this.permitted(scope, "run_process", { ...spec, background }, signal);
    if (signal.aborted) throw new Error("Chat process launch was cancelled before admission.");
    const cwdAfter = statSync(cwd);
    if (realpathSync(cwd) !== cwd || cwdBefore.dev !== cwdAfter.dev || cwdBefore.ino !== cwdAfter.ino)
      throw new Error("Chat working directory changed after approval.");
    const handle = background ? `process_${hash(parsed.idempotency_key!)}`
      : `foreground_${Date.now()}-${randomUUID()}`, owner = scopeId(scope);
    if (!background && this.options.database.prepare("SELECT 1 FROM legacy_chat_process_bindings WHERE scope=? AND operation_id=?")
      .get(owner, executionId)) throw new Error("Foreground execution already has a receipt; its effects will not be replayed.");
    const old = this.options.database.prepare("SELECT spec FROM legacy_chat_process_bindings WHERE scope=? AND handle=?").get(owner, handle);
    if (old) {
      if (String(old.spec) !== JSON.stringify(spec)) throw new Error("Idempotency key belongs to different process inputs.");
      return this.record(scope, handle);
    }
    if (background) {
      const evidenceRoot = this.options.originalEvidence ? this.originalEvidenceRoot() : scope.root;
      let evidence = evidenceRoot;
      for (const component of [".pkm", "state", "api-chat-tool-results", scope.chatId, "processes", handle]) {
        evidence = join(evidence, component);
        try {
          const stat = lstatSync(evidence);
          if (stat.isSymbolicLink() || !stat.isDirectory()) throw new Error("Original process evidence path is not a trusted directory.");
          if (component === handle) throw new Error("An original Chat process already owns this handle; it will not be overwritten or relaunched.");
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code === "ENOENT") break;
          throw error;
        }
      }
      if (this.options.originalEvidence && this.originalEvidenceRoot() !== evidenceRoot)
        throw new Error("Original process evidence source changed before launch.");
    }
    const operationId = background ? randomUUID() : executionId;
    this.options.database.prepare("INSERT INTO legacy_chat_process_bindings VALUES(?,?,?,?,NULL,?)")
      .run(owner, handle, JSON.stringify(spec), operationId, Date.now());
    let finish!: () => void;
    const pending = new Promise<void>(resolve => { finish = resolve; });
    const launches = this.launching.get(owner) ?? new Set<Promise<void>>();
    launches.add(pending);
    this.launching.set(owner, launches);
    let released = false;
    const release = () => {
      if (released) return;
      released = true;
      launches.delete(pending);
      if (!launches.size) this.launching.delete(owner);
      finish();
    };
    try {
      const job = await this.runtime.launch({ actorId: owner, operationId, adapterId: command.id,
        input: { args: parsed.arguments }, deadlineMs: timeoutSeconds * 1000 });
      try {
        const update = this.options.database.prepare("UPDATE legacy_chat_process_bindings SET job_id=? WHERE scope=? AND handle=? AND job_id IS NULL")
          .run(job.jobId, owner, handle);
        if (update.changes !== 1) throw new Error("Chat process binding was lost.");
      } catch (error) {
        try { await this.runtime.cancel(owner, job.jobId); } catch { /* Report the unresolved receipt below. */ }
        throw new Error(`Chat process receipt failed; cancellation was requested and effects may be unknown: ${String(error)}`);
      }
      if (signal.aborted) await this.runtime.cancel(owner, job.jobId);
      release();
      if (background) return this.record(scope, handle);
      const cancel = () => { void this.runtime.cancel(owner, job.jobId).catch(() => {}); };
      signal.addEventListener("abort", cancel, { once: true });
      try {
        const done = await this.runtime.wait(owner, job.jobId);
        if (done.reason === "spawn-error")
          throw new Error(`Foreground process did not start; outputHandle: ${handle}. ${command.openLaunch
            ? pinnedLaunchDetail : "Check the executable, working directory and interpreter."}`);
        if (signal.aborted || done.state === "CANCELLED" || done.state === "TIMED_OUT"
          || done.state === "OUTPUT_LIMIT" || done.state === "INTERRUPTED")
          throw new Error(`Foreground process ${done.state.toLowerCase()}; outputHandle: ${handle}; effects may be unknown.`);
        const preview = (stream: "stdout" | "stderr") => {
          const decoder = new StringDecoder("utf8");
          let offset = 0, head = "", tail = "", count = 0;
          while (true) {
            const part = this.capture.read(job.jobId, stream, offset, 65536);
            if (!part.bytes.length) break;
            offset += part.bytes.length;
            const text = decoder.write(part.bytes);
            count += text.length;
            const room = Math.max(0, 1500 - head.length);
            head += text.slice(0, room);
            tail = (tail + text.slice(room)).slice(-1500);
          }
          const text = decoder.end(); count += text.length;
          const room = Math.max(0, 1500 - head.length);
          head += text.slice(0, room); tail = (tail + text.slice(room)).slice(-1500);
          return { count, text: count <= 3000 ? head + tail
            : `${head}\n...[${count - head.length - tail.length} characters omitted; full output saved locally]...\n${tail}` };
        };
        const stdout = preview("stdout"), stderr = preview("stderr");
        return { exitCode: done.exitCode, signal: done.signal, stdout: stdout.text, stderr: stderr.text,
          truncated: stdout.count + stderr.count > 6000, outputBytes: done.stdoutBytes + done.stderrBytes,
          outputHandle: handle, platform: process.platform, detail: groupScopeDetail };
      } finally { signal.removeEventListener("abort", cancel); }
    } finally {
      release();
    }
  }
  async control(scope: Scope, handle: string, operation: "status" | "pause" | "resume" | "stop", signal?: AbortSignal) {
    const action = operation === "status" ? "process_get" : operation === "stop" ? "stop-ui" : operation;
    if (!/^process_[a-f0-9]{64}$/.test(handle)) throw new Error("Choose an exact background process handle.");
    this.check();
    const native = this.hasRow(scope, handle);
    if (!native && operation !== "status")
      throw new Error("An original process has no live native ownership; historical PIDs cannot be controlled.");
    const detail = operation === "stop"
      ? { handle, record: this.record(scope, handle) } : { handle };
    await this.permitted(scope, action, detail, signal);
    if (!native) {
      return this.readOriginal(root => originalProcessRecord(root, scope.chatId, handle));
    }
    const row = this.row(scope, handle);
    if (operation !== "status") {
      if (!row.job_id) throw new Error("Unknown process outcome cannot be controlled.");
      const owner = scopeId(scope);
      if (operation === "pause") {
        await this.runtime.pause(owner, String(row.job_id));
        if (!this.paused.has(String(row.job_id))) this.paused.set(String(row.job_id), Date.now());
      } else if (operation === "resume") {
        await this.runtime.resume(owner, String(row.job_id));
        this.paused.delete(String(row.job_id));
      }
      else {
        const job = await this.runtime.cancel(owner, String(row.job_id));
        if (job.state === "INTERRUPTED") throw new Error("Unknown process outcome cannot be controlled.");
      }
    }
    const record = this.record(scope, handle);
    return operation === "stop" && ["launching", "running", "paused"].includes(record.state)
      ? { ...record, detail: `Cancellation requested; completion is not yet confirmed. Query the same handle. ${groupScopeDetail}` } : record;
  }
  async execute(scope: Scope, request: { call: { name: string; arguments: Record<string, unknown> }; operationId: string; signal: AbortSignal }) {
    const { name, arguments: args } = request.call;
    let value: unknown;
    if (name === "run_process") value = await this.run(scope, args, request.signal, request.operationId);
    else if (name === "process_get") value = await this.control(scope, z.strictObject({ handle: z.string() }).parse(args).handle, "status", request.signal);
    else if (name === "process_cancel") {
      const { handle } = z.strictObject({ handle: z.string() }).parse(args);
      if (!/^process_[a-f0-9]{64}$/.test(handle)) throw new Error("Choose an exact background process handle.");
      const row = this.row(scope, handle);
      await this.permitted(scope, "process_cancel", { handle, record: this.record(scope, handle) }, request.signal);
      if (!row.job_id) throw new Error("Unknown process outcome cannot be controlled.");
      const job = await this.runtime.cancel(scopeId(scope), String(row.job_id));
      if (job.state === "INTERRUPTED") throw new Error("Unknown process outcome cannot be controlled.");
      const record = this.record(scope, handle);
      value = ["launching", "running", "paused"].includes(record.state)
        ? { ...record, detail: `Cancellation requested; completion is not yet confirmed. Query the same handle. ${groupScopeDetail}` } : record;
    } else if (name === "process_output") {
      const input = z.strictObject({ handle: z.string(), stream: z.enum(["stdout", "stderr"]),
        start: z.number().int().nonnegative(), length: z.number().int().min(1).max(12000) }).parse(args);
      await this.permitted(scope, "process_output", input, request.signal);
      if (!this.hasRow(scope, input.handle)) {
        value = this.readOriginal(root => originalProcessOutput(root, scope.chatId, input));
        return { executionId: request.operationId, content: JSON.stringify(value) };
      }
      const row = this.row(scope, input.handle);
      if (!row.job_id) throw new Error("Unknown process output is unavailable.");
      const job = this.runtime.status(scopeId(scope), String(row.job_id));
      const part = this.capture.read(String(row.job_id), input.stream, input.start, input.length);
      if (part.size < job[input.stream === "stdout" ? "stdoutBytes" : "stderrBytes"])
        throw new Error("Native process output evidence is missing or shorter than its receipt.");
      let length = part.bytes.length;
      const result = () => ({ handle: input.handle, stream: input.stream, start: input.start, end: input.start + length,
        availableBytes: part.size, text: part.bytes.subarray(0, length).toString("utf8"),
        state: this.record(scope, input.handle).state, more: input.start + length < part.size, encoding: "utf8" });
      while (JSON.stringify(result()).length > 15000 && length > 0) length = Math.floor(length / 2);
      value = result();
    } else throw new Error("Unknown Chat process tool.");
    return { executionId: request.operationId, content: JSON.stringify(value) };
  }
  async cancelAll(scope: Scope) {
    const startedBefore = Date.now();
    await this.permitted(scope, "chat-stop", {});
    const owner = scopeId(scope);
    await Promise.all([...this.launching.get(owner) ?? []]);
    const errors: string[] = [];
    for (const row of this.options.database.prepare("SELECT handle,job_id FROM legacy_chat_process_bindings WHERE scope=? AND created_at<=? AND substr(handle,1,8)='process_'").all(owner, startedBefore)) {
      try {
        if (!row.job_id) throw new Error("Unknown outcome; no historical PID was signalled.");
        const job = await this.runtime.cancel(owner, String(row.job_id));
        if (job.state === "INTERRUPTED") throw new Error("Unknown outcome; no historical PID was signalled.");
      } catch (error) {
        errors.push(`${String(row.handle)}: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    if (errors.length) throw new Error(`Some Chat processes could not be cancelled: ${errors.join("; ")}`);
  }
  handles(name: string) { return ["run_process", "process_get", "process_output", "process_cancel"].includes(name); }
  close(): Promise<void> {
    if (this.closing) return this.closing;
    this.closed = true;
    this.closing = this.runtime.close({ drainMs: 0 }).then(() => { this.capture.close(); }).catch(error => {
      this.closing = undefined;
      throw error;
    });
    return this.closing;
  }
}
