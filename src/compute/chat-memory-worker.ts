import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { randomUUID } from "node:crypto";
import { lstat, mkdir, realpath } from "node:fs/promises";
import { dirname, isAbsolute, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { legacyMemorySnapshotPythonCommand } from "../legacy-memory-engine-backup-python.js";
import { memoryTurnAccounting } from "./memory-accounting.js";
import {
  ComputeError, type ComputeOptions, type ComputeReady, type ComputeResult,
  type AbortTurn, type AppendStatement, type BeginTurn, type CommitTurn, type ContinueTurn,
  type CreatePiece, type LinkPieces, type PieceKind, type PutEmbedding,
} from "./contracts.js";

export { ComputeError } from "./contracts.js";
export type * from "./contracts.js";

const workerScript = fileURLToPath(new URL("../../compute/worker.py", import.meta.url));
const MAX_BYTES = 8 * 1024 * 1024;
type State = "opening" | "ready" | "closing" | "closed" | "failed";
type Settings = Required<ComputeOptions>;
interface Pending {
  id: string; encoded: Buffer; mutation: boolean;
  resolve: (value: ComputeResult) => void; reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}
function object(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
function bounded(value: number | undefined, fallback: number, minimum: number, maximum: number, name: string): number {
  const result = value ?? fallback;
  if (!Number.isSafeInteger(result) || result < minimum || result > maximum) {
    throw new ComputeError("INVALID_ARGUMENT", `Invalid compute ${name}.`);
  }
  return result;
}
function settings(options: ComputeOptions): Settings {
  for (const key of ["python", "runtimeDirectory", "database"] as const) {
    if (typeof options[key] !== "string" || !isAbsolute(options[key]) || options[key].includes("\0")) {
      throw new ComputeError("INVALID_ARGUMENT", `Compute ${key} must be an absolute path.`);
    }
  }
  if (typeof options.identity !== "string" || !options.identity || Buffer.byteLength(options.identity) > 512 ||
      /[\u0000-\u001f]/u.test(options.identity)) throw new ComputeError("INVALID_ARGUMENT", "Invalid compute identity.");
  const runtimeDirectory = resolve(options.runtimeDirectory), database = resolve(options.database);
  if (dirname(database) !== runtimeDirectory) throw new ComputeError("INVALID_ARGUMENT", "Database must be a direct runtimeDirectory child.");
  return {
    python: options.python, runtimeDirectory, database, identity: options.identity,
    startupTimeoutMs: bounded(options.startupTimeoutMs, 10_000, 1, 300_000, "startup timeout"),
    requestTimeoutMs: bounded(options.requestTimeoutMs, 10_000, 1, 300_000, "request timeout"),
    closeTimeoutMs: bounded(options.closeTimeoutMs, 2_000, 1, 30_000, "close timeout"),
    maxPendingRequests: bounded(options.maxPendingRequests, 64, 1, 1024, "queue size"),
    maxQueuedBytes: bounded(options.maxQueuedBytes, 16 * 1024 * 1024, 256, 64 * 1024 * 1024, "queued bytes"),
    maxRequestBytes: bounded(options.maxRequestBytes, MAX_BYTES, 256, MAX_BYTES, "request bytes"),
    maxResponseBytes: bounded(options.maxResponseBytes, MAX_BYTES, 1024, MAX_BYTES, "response bytes"),
    maxStderrBytes: bounded(options.maxStderrBytes, 16_384, 256, 65_536, "stderr bytes"),
  };
}

/** Internal trusted-host adapter, deliberately absent from public Core/HTTP/MCP dispatch. */
export class ChatMemoryWorker {
  readonly #options: Settings;
  #child?: ChildProcessWithoutNullStreams;
  #state: State = "closed";
  #queue: Pending[] = [];
  #active?: Pending;
  #queuedBytes = 0;
  #buffer = Buffer.alloc(0);
  #stderr = Buffer.alloc(0);
  #failure?: ComputeError;
  #ready?: ComputeReady;
  #readyResolve?: () => void;
  #readyReject?: (error: Error) => void;
  #startupTimer?: ReturnType<typeof setTimeout>;
  #killTimer?: ReturnType<typeof setTimeout>;
  #exit: Promise<void> = Promise.resolve();
  #closing?: Promise<void>;
  #opening?: Promise<void>;
  #epoch = 0;

  private constructor(options: ComputeOptions, private readonly nativeSnapshot = false) { this.#options = settings(options); }

  static async open(options: ComputeOptions): Promise<ChatMemoryWorker> {
    const client = new ChatMemoryWorker(options);
    await client.reopen();
    return client;
  }

  static async openOwnedSnapshot(options: ComputeOptions): Promise<ChatMemoryWorker> {
    const client = new ChatMemoryWorker(options, true);
    await client.reopen();
    return client;
  }

  get healthy(): boolean { return this.#state === "ready"; }
  get state(): State { return this.#state; }
  get processId(): number | undefined { return this.#child?.pid; }
  get diagnostics(): string { return this.#stderr.toString("utf8"); }
  get ready(): ComputeReady | undefined { return this.#ready && structuredClone(this.#ready); }

  /** Explicit restart only; no prior request, including an uncertain mutation, is replayed. */
  reopen(): Promise<void> {
    if (this.#opening) return this.#opening;
    if (this.#state === "ready") return Promise.resolve();
    this.#opening = this.#reopen().finally(() => { this.#opening = undefined; });
    return this.#opening;
  }

  async #reopen(): Promise<void> {
    const closed = this.close(), epoch = this.#epoch;
    await closed;
    const o = this.#options;
    await mkdir(o.runtimeDirectory, { recursive: true, mode: 0o700 });
    if (await realpath(o.runtimeDirectory) !== o.runtimeDirectory) {
      throw new ComputeError("INVALID_ARGUMENT", "Runtime directory must not traverse symbolic links.");
    }
    for (const path of [o.database, `${o.database}-wal`, `${o.database}-shm`]) {
      try {
        const info = await lstat(path);
        if (!info.isFile() || info.isSymbolicLink()) throw new ComputeError("INVALID_ARGUMENT", "Runtime SQLite files must be regular, non-symbolic files.");
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
    }
    if (epoch !== this.#epoch) throw new ComputeError("CLOSED", "Compute reopen cancelled by close.");
    this.#state = "opening";
    this.#failure = undefined;
    this.#ready = undefined;
    this.#stderr = Buffer.alloc(0);
    this.#buffer = Buffer.alloc(0);
    const handshake = new Promise<void>((accept, reject) => {
      this.#readyResolve = accept;
      this.#readyReject = reject;
    });
    const env: NodeJS.ProcessEnv = {
      PATH: dirname(o.python), TMPDIR: o.runtimeDirectory, TEMP: o.runtimeDirectory, TMP: o.runtimeDirectory,
      ...(process.platform === "win32" ? { SystemRoot: process.env.SystemRoot, WINDIR: process.env.WINDIR } : {}),
    };
    try {
      this.#child = spawn(o.python, ["-I", "-S", "-B", "-u",
        ...(this.nativeSnapshot ? ["-c", legacyMemorySnapshotPythonCommand, workerScript] : [workerScript]),
        "--database", o.database, "--identity", o.identity,
        "--max-request-bytes", String(o.maxRequestBytes), "--max-response-bytes", String(o.maxResponseBytes)], {
        cwd: o.runtimeDirectory, env, shell: false, windowsHide: true, stdio: ["pipe", "pipe", "pipe"],
      });
      const child = this.#child;
      this.#exit = new Promise<void>(done => {
        child.once("close", (code, signal) => {
          if (this.#killTimer) clearTimeout(this.#killTimer);
          if (this.#state !== "closed" && (this.#state !== "closing" || this.#active)) {
            this.#fatal("PROCESS_EXIT", `Compute exited (${code ?? signal}); no requests were replayed.`);
          }
          done();
        });
      });
      child.on("error", error => this.#fatal("LAUNCH_FAILED", `Compute launch failed: ${error.message}`));
      for (const stream of [child.stdin, child.stdout, child.stderr]) {
        stream.on("error", error => this.#fatal("IO_FAILED", `Compute stream failed: ${error.message}`));
      }
      child.stderr.on("data", (chunk: Buffer) => {
        this.#stderr = Buffer.from(Buffer.concat([this.#stderr, chunk]).subarray(-o.maxStderrBytes));
      });
      child.stdout.on("data", (chunk: Buffer) => this.#receive(chunk));
      this.#startupTimer = setTimeout(() => this.#fatal("STARTUP_TIMEOUT", "Compute ready handshake timed out."), o.startupTimeoutMs);
    } catch (error) {
      this.#fatal("LAUNCH_FAILED", `Compute launch failed: ${String(error)}`);
    }
    try {
      await handshake;
      if (!this.healthy) throw this.#failure ?? new ComputeError("NOT_READY", "Compute exited during ready handshake.");
    }
    catch (error) { await this.close(); throw error; }
  }

  #fatal(code: string, message: string): void {
    if (this.#failure) return;
    this.#failure = new ComputeError(code, message, "not-submitted", this.diagnostics);
    this.#state = "failed";
    if (this.#startupTimer) clearTimeout(this.#startupTimer);
    this.#readyReject?.(this.#failure);
    this.#readyResolve = this.#readyReject = undefined;
    if (this.#active) {
      const active = this.#active;
      clearTimeout(active.timer);
      active.reject(new ComputeError(code, message, active.mutation ? "unknown" : "read-only", this.diagnostics));
      this.#active = undefined;
    }
    for (const pending of this.#queue) {
      clearTimeout(pending.timer);
      pending.reject(new ComputeError(code, message, "not-submitted", this.diagnostics));
    }
    this.#queue = [];
    this.#queuedBytes = 0;
    this.#buffer = Buffer.alloc(0);
    if (this.#child && this.#child.exitCode === null && this.#child.signalCode === null) {
      this.#child.kill("SIGTERM");
      this.#killTimer = setTimeout(() => this.#child?.kill("SIGKILL"), 250);
    }
  }

  #receive(chunk: Buffer): void {
    if (this.#failure || this.#state === "closed") return;
    let offset = 0;
    while (offset < chunk.length) {
      const newline = chunk.indexOf(10, offset);
      const end = newline < 0 ? chunk.length : newline + 1;
      if (this.#buffer.length + end - offset > this.#options.maxResponseBytes) {
        this.#fatal("RESPONSE_LIMIT", "Compute response exceeded configured byte limit.");
        return;
      }
      this.#buffer = Buffer.concat([this.#buffer, chunk.subarray(offset, end)]);
      offset = end;
      if (newline < 0) return;
      let reply: unknown;
      try { reply = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(this.#buffer)); }
      catch { this.#fatal("PROTOCOL_ERROR", "Compute returned invalid UTF-8/JSON."); return; }
      this.#buffer = Buffer.alloc(0);
      if (!object(reply)) { this.#fatal("PROTOCOL_ERROR", "Compute returned invalid envelope."); return; }
      if (this.#state === "opening") {
        const caps = reply.capabilities;
        if (reply.type !== "ready" || reply.protocol !== 1 || reply.adapter !== "pkm-next-chat-compute/1" ||
            reply.module !== "pkm-memory-engine" || reply.policy !== "pkm-memory-policy/1" || reply.schema !== 2 ||
            reply.identity !== this.#options.identity || reply.storage !== "worker-owned-runtime-sqlite" ||
            reply.explicit_memory !== "node-markdown" || !object(caps) || caps.protocol !== 1 || caps.schema !== 2 ||
            caps.module !== reply.module || caps.policy !== reply.policy || caps.identity !== reply.identity) {
          this.#fatal("PROTOCOL_ERROR", "Compute ready capabilities/identity mismatch."); return;
        }
        this.#ready = reply as unknown as ComputeReady;
        this.#state = "ready";
        if (this.#startupTimer) clearTimeout(this.#startupTimer);
        this.#readyResolve?.();
        this.#readyResolve = this.#readyReject = undefined;
        continue;
      }
      const active = this.#active;
      if (!active || reply.id !== active.id || typeof reply.ok !== "boolean") {
        this.#fatal("PROTOCOL_ERROR", "Compute returned unexpected request identity/envelope."); return;
      }
      if (reply.ok && !(object(reply.result) || Array.isArray(reply.result)) ||
          !reply.ok && (!object(reply.error) || typeof reply.error.message !== "string" ||
            typeof reply.error.type !== "string" || typeof reply.error.code !== "string" ||
            !["INVALID_ARGUMENT", "CONFLICT", "NOT_AVAILABLE", "ACCESS_DENIED"].includes(reply.error.code))) {
        this.#fatal("PROTOCOL_ERROR", "Compute returned invalid result/error."); return;
      }
      clearTimeout(active.timer);
      this.#active = undefined;
      this.#queuedBytes -= active.encoded.length;
      if (reply.ok) active.resolve(reply.result as ComputeResult);
      else {
        const error = reply.error as Record<string, string>;
        // The worker's negative response is a definite rejection, not an uncertain transport outcome.
        active.reject(new ComputeError(error.code, `${error.type}: ${error.message}`, "rejected", this.diagnostics));
      }
      this.#pump();
    }
  }

  #request(method: string, params: object, mutation = false, operationId?: string): Promise<ComputeResult> {
    if (this.#state !== "ready") return Promise.reject(new ComputeError("NOT_READY", "Compute is not ready; explicitly reopen it.", "not-submitted", this.diagnostics));
    let encoded: Buffer;
    try {
      if (!object(params)) throw new Error("Expected object params.");
      encoded = Buffer.from(JSON.stringify({ protocol: 1, id: randomUUID(), method, params,
        ...(operationId !== undefined ? { operation_id: operationId } : {}) }, (_key, value: unknown) => {
        if (typeof value === "number" && !Number.isFinite(value)) throw new Error("Non-finite JSON number.");
        return value;
      }) + "\n");
    } catch (error) { return Promise.reject(new ComputeError("INVALID_ARGUMENT", `Compute request is not JSON: ${String(error)}`)); }
    if (encoded.length > this.#options.maxRequestBytes) return Promise.reject(new ComputeError("REQUEST_LIMIT", "Compute request exceeded configured byte limit."));
    if (this.#queue.length + (this.#active ? 1 : 0) >= this.#options.maxPendingRequests ||
        this.#queuedBytes + encoded.length > this.#options.maxQueuedBytes) {
      return Promise.reject(new ComputeError("QUEUE_LIMIT", "Compute pending count/byte limit reached."));
    }
    return new Promise((accept, reject) => {
      const id = (JSON.parse(encoded.toString("utf8")) as { id: string }).id;
      const pending: Pending = { id, encoded, mutation, resolve: accept, reject, timer: setTimeout(() => {
        if (this.#active === pending) this.#fatal("REQUEST_TIMEOUT", "Compute request timed out; no replay was submitted.");
        else {
          const index = this.#queue.indexOf(pending);
          if (index >= 0) { this.#queue.splice(index, 1); this.#queuedBytes -= encoded.length; }
          reject(new ComputeError("QUEUE_TIMEOUT", "Compute queued request expired before submission."));
        }
      }, this.#options.requestTimeoutMs) };
      this.#queue.push(pending);
      this.#queuedBytes += encoded.length;
      this.#pump();
    });
  }

  #pump(): void {
    if (this.#active || this.#failure) return;
    if (this.#state === "closing") { this.#child?.stdin.end(); return; }
    if (this.#state !== "ready") return;
    const next = this.#queue.shift();
    if (!next) return;
    this.#active = next;
    // Only one bounded frame can be in stdin at a time; write callbacks never initiate retries.
    this.#child?.stdin.write(next.encoded, error => {
      if (error) this.#fatal("IO_FAILED", `Compute write failed: ${error.message}`);
    });
  }

  close(): Promise<void> {
    this.#epoch++;
    if (this.#closing) return this.#closing;
    this.#closing = this.#close().finally(() => { this.#closing = undefined; });
    return this.#closing;
  }

  async #close(): Promise<void> {
    if (this.#state === "closed") return;
    if (this.#state === "opening") this.#fatal("CLOSED", "Compute closed during startup.");
    if (!this.#failure) {
      this.#state = "closing";
      for (const pending of this.#queue) {
        clearTimeout(pending.timer);
        this.#queuedBytes -= pending.encoded.length;
        pending.reject(new ComputeError("CLOSED", "Compute closed before queued request submission."));
      }
      this.#queue = [];
      if (!this.#active) this.#child?.stdin.end();
    }
    const timer = setTimeout(() => this.#fatal("CLOSE_TIMEOUT", "Compute graceful close deadline exceeded; in-flight outcome may be uncertain."),
      this.#options.closeTimeoutMs);
    try { await this.#exit; }
    finally {
      clearTimeout(timer);
      if (this.#killTimer) clearTimeout(this.#killTimer);
      this.#state = "closed";
      this.#child = undefined;
    }
  }

  readPiece(params: { piece_id: string; after?: number; limit?: number }) { return this.#request("read", params); }
  listPieces(params: { scope: string; kind: PieceKind; limit?: number; query?: string }) { return this.#request("pieces", params); }
  neighbors(params: { piece_id: string; after?: string; limit?: number }) { return this.#request("neighbors", params); }
  sources(params: { statement_id: string; after?: string; limit?: number }) { return this.#request("sources", params); }
  changes(params: { after?: number; limit?: number } = {}) { return this.#request("changes", params); }
  embedding(params: { piece_id: string; space: string }) { return this.#request("embedding", params); }
  children(params: { piece_id: string; before?: number; limit?: number; kind?: PieceKind | "" }) { return this.#request("children", params); }
  parents(params: { piece_id: string; limit?: number }) { return this.#request("parents", params); }
  usage(params: { scope?: string } = {}) { return this.#request("usage", params); }
  overview(params: { scope: string; limit?: number }) { return this.#request("overview", params); }
  async turnReceipt(params: { turn: string }) {
    const receipt = await this.#request("turn_receipt", params) as Record<string, unknown>;
    return { ...receipt, accounting: memoryTurnAccounting(receipt) };
  }
  beginTurn(params: BeginTurn) { return this.#request("turn_begin", params, true); }
  continueTurn(params: ContinueTurn) { return this.#request("turn_continue", params, true); }
  abortTurn(params: AbortTurn) { return this.#request("turn_abort", params, true); }
  commitTurn(params: CommitTurn) { return this.#request("turn_commit", params, true); }
  readMemory(params: { scope: string; piece: string; after?: number }) { return this.#request("memory_read", params, true); }
  enforceCapacity(params: { max_bytes: number; protected?: string[] }) { return this.#request("enforce_capacity", params, true); }
  snapshotDatabase(destination: string) {
    if (!this.nativeSnapshot) return Promise.reject(new ComputeError("ACCESS_DENIED", "Snapshot commands require the explicit native-owned adapter."));
    if (!isAbsolute(destination) || dirname(resolve(destination)) !== this.#options.runtimeDirectory
      || !resolve(destination).split(/[\\/]/u).at(-1)?.startsWith(".pkm-memory-snapshot-")) {
      return Promise.reject(new ComputeError("INVALID_ARGUMENT", "Snapshot destination must be a native-owned runtime sibling."));
    }
    return this.#request("backup_database", { destination });
  }
  forgetScope(params: { scope: string }) { return this.#request("forget_scope", params, true); }
  createPiece(operationId: string, params: CreatePiece) { return this.#request("create", params, true, operationId); }
  appendStatement(operationId: string, params: AppendStatement) { return this.#request("append", params, true, operationId); }
  linkPieces(operationId: string, params: LinkPieces) { return this.#request("link", params, true, operationId); }
  commitSummary(operationId: string, params: { piece: string; expected_revision: number; body: string; through?: number }) { return this.#request("summary_commit", params, true, operationId); }
  putEmbedding(operationId: string, params: PutEmbedding) { return this.#request("embedding_put", params, true, operationId); }
  touchPiece(operationId: string, params: { piece: string; reason: "read" | "expand" | "sent" }) { return this.#request("touch", params, true, operationId); }
  acquireLease(operationId: string, params: { piece: string; expected_revision: number; lease_id: string; ttl_seconds: number }) { return this.#request("lease_acquire", params, true, operationId); }
  releaseLease(operationId: string, params: { lease_id: string }) { return this.#request("lease_release", params, true, operationId); }
  evict(operationId: string, params: { count: number; protected?: string[]; scope?: string; free_bytes?: number }) { return this.#request("evict", params, true, operationId); }
  purgeChat(operationId: string, params: { chat: string }) { return this.#request("purge_chat", params, true, operationId); }
}
