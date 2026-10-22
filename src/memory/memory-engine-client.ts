import { spawn, ChildProcessWithoutNullStreams } from "child_process";
import * as path from "path";
import { randomUUID } from "crypto";
import { mcpStdioCommand } from "../mcp/mcp-stdio-command";
import type { MemoryModelAccounting } from "./memory-accounting";

export interface MemorySourceReference {
  id: string;
  chat: string;
  revision: string;
  locator: string;
}

export type MemoryPieceKind = "piece" | "message" | "topic" | "project";
export interface MemoryMessage { id: string; text: string; revision?: string }
export interface MemoryDialogueMessage { id: string; role: "user" | "assistant"; text: string }

export type MemoryCommand =
  | { method: "capabilities"; params?: Record<string, never> }
  | { method: "read"; params: { piece_id: string; after?: number; limit?: number } }
  | { method: "sources"; params: { statement_id: string; after?: string; limit?: number } }
  | { method: "neighbors"; params: { piece_id: string; after?: string; limit?: number } }
  | { method: "changes"; params: { after?: number; limit?: number } }
  | { method: "embedding"; params: { piece_id: string; space: string } }
  | { method: "pieces"; params: { scope: string; kind: MemoryPieceKind; limit?: number; query?: string } }
  | { method: "children"; params: { piece_id: string; before?: number; limit?: number; kind?: MemoryPieceKind | "" } }
  | { method: "parents"; params: { piece_id: string; limit?: number } }
  | { method: "usage"; params: { scope?: string } }
  | { method: "turn_begin"; params: { scope: string; turn: string; input: { id: string; text: string };
      recent?: MemoryDialogueMessage[]; budget_chars?: number } }
  | { method: "turn_continue"; params: { turn: string; output?: string; error?: string; usage?: Record<string, number>; accounting?: MemoryModelAccounting } }
  | { method: "turn_abort"; params: { turn: string; error: string; usage?: Record<string, number>; accounting?: MemoryModelAccounting } }
  | { method: "turn_commit"; params: { turn: string; user: MemoryMessage; assistant: MemoryMessage; scope?: string } }
  | { method: "turn_receipt"; params: { turn: string } }
  | { method: "memory_read"; params: { scope: string; piece: string; after?: number } }
  | { method: "overview"; params: { scope: string; limit?: number } }
  | { method: "enforce_capacity"; params: { max_bytes: number; protected?: string[] } }
  | { method: "forget_scope"; params: { scope: string } }
  | { method: "create"; operationId: string; params: { piece: string; label: string; kind?: MemoryPieceKind; scope?: string } }
  | { method: "append"; operationId: string; params: {
      piece: string; statement_id: string; expected_revision: number; body: string;
      status?: "proposal" | "observation" | "user-confirmed" | "verified" | "disputed";
      sources: MemorySourceReference[];
    } }
  | { method: "link"; operationId: string; params: {
      parent: string; child: string;
      relation: "abstracts" | "part_of" | "clarifies" | "revises" | "supersedes" | "addresses" | "implements" | "verifies";
    } }
  | { method: "summary_commit"; operationId: string; params: { piece: string; expected_revision: number; body: string; through?: number } }
  | { method: "embedding_put"; operationId: string; params: {
      piece: string; representation: "summary"; revision: number; input_content_hash: string;
      embedding_space_id: string; dimensions: number; distance_metric: "cosine" | "dot" | "l2"; embedding: number[];
    } }
  | { method: "touch"; operationId: string; params: { piece: string; reason: "read" | "expand" | "sent" } }
  | { method: "lease_acquire"; operationId: string; params: {
      piece: string; expected_revision: number; lease_id: string; ttl_seconds: number;
    } }
  | { method: "lease_release"; operationId: string; params: { lease_id: string } }
  | { method: "evict"; operationId: string; params: { count: number; protected?: string[]; scope?: string; free_bytes?: number } }
  | { method: "purge_chat"; operationId: string; params: { chat: string } };

export interface MemoryEngineClientOptions {
  python: string;
  extensionRoot: string;
  database: string;
  identity: string;
  timeoutMs?: number;
}

type Result = Record<string, unknown> | unknown[];
interface Pending {
  resolve: (value: Result) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

export const MEMORY_POLICY = "pkm-memory-policy/1";
const MAX_REQUEST_BYTES = 8 * 1024 * 1024;
const MAX_RESPONSE_BYTES = 8 * 1024 * 1024;

function object(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/** Lead with the final exception line; notifications truncate, and the traceback head is only runpy frames. */
export function memoryEngineDiagnostic(stderr: string): string {
  const lines = stderr.split(/\r?\n/).map(line => line.trimEnd()).filter(Boolean);
  const final = [...lines].reverse().find(line => /^[A-Za-z_][\w.]*(Error|Exception|Exit|Interrupt)\b/.test(line));
  return final ? `${final} | ${stderr.trim()}` : stderr.trim();
}

/** Private storage transport only. Host authorization is required before each command. */
export class MemoryEngineClient {
  private readonly child: ChildProcessWithoutNullStreams;
  private readonly pending = new Map<string, Pending>();
  private buffer = Buffer.alloc(0);
  private failure?: Error;
  private stderr = "";
  private exited = false;
  private readonly exit: Promise<void>;
  private readonly timeoutMs: number;

  private constructor(private readonly options: MemoryEngineClientOptions) {
    this.timeoutMs = options.timeoutMs ?? 10_000;
    if (!Number.isSafeInteger(this.timeoutMs) || this.timeoutMs < 1 || this.timeoutMs > 300_000) {
      throw new Error("Invalid Memory Engine request timeout.");
    }
    const moduleRoot = path.join(options.extensionRoot, "modules", "pkm-memory-engine", "src");
    const bootstrap = "import runpy,sys;sys.path.insert(0,sys.argv.pop(1));runpy.run_module('pkm_memory_engine',run_name='__main__')";
    const launch = mcpStdioCommand(options.python, [
      "-u", "-c", bootstrap, moduleRoot, "--database", options.database, "--identity", options.identity,
    ], process.platform, options.extensionRoot);
    this.child = spawn(launch.command, launch.args, {
      windowsHide: true, stdio: ["pipe", "pipe", "pipe"],
      env: { ...process.env, ...launch.env, PYTHONDONTWRITEBYTECODE: "1", PYTHONUTF8: "1", PYTHONIOENCODING: "utf-8" },
    });
    this.exit = new Promise(resolve => {
      this.child.once("close", (code, signal) => {
        this.exited = true;
        this.fail(new Error(`Memory Engine exited (${code ?? signal}); pending mutation outcomes may be uncertain.${this.stderr ? ` ${memoryEngineDiagnostic(this.stderr)}` : ""}`));
        resolve();
      });
    });
    this.child.on("error", error => this.fail(new Error(`Memory Engine launch failed: ${error.message}`)));
    this.child.stdin.on("error", error => this.fail(new Error(`Memory Engine input failed: ${error.message}`)));
    this.child.stdout.on("error", error => this.fail(new Error(`Memory Engine output failed: ${error.message}`)));
    this.child.stderr.on("error", error => this.fail(new Error(`Memory Engine diagnostic stream failed: ${error.message}`)));
    this.child.stderr.on("data", (bytes: Buffer) => {
      this.stderr = (this.stderr + bytes.toString("utf8")).slice(-2048);
    });
    this.child.stdout.on("data", (bytes: Buffer) => this.receive(bytes));
  }

  static async open(options: MemoryEngineClientOptions): Promise<MemoryEngineClient> {
    const client = new MemoryEngineClient(options);
    try {
      const capabilities = await client.request({ method: "capabilities" });
      if (!object(capabilities) || capabilities.module !== "pkm-memory-engine" ||
          capabilities.protocol !== 1 || capabilities.schema !== 1 || capabilities.identity !== options.identity
          || capabilities.policy !== MEMORY_POLICY) {
        throw new Error("Memory Engine capabilities or identity mismatch.");
      }
      return client;
    } catch (error) {
      await client.close();
      throw error;
    }
  }

  get healthy(): boolean { return !this.failure; }

  request(command: MemoryCommand): Promise<Result> {
    if (this.failure) return Promise.reject(this.failure);
    if (this.pending.size >= 64) return Promise.reject(new Error("Memory Engine request queue is full."));
    const id = randomUUID();
    let encoded: string;
    try {
      encoded = JSON.stringify({
        protocol: 1, id, method: command.method, params: command.params || {},
        ...("operationId" in command ? { operation_id: command.operationId } : {}),
      }) + "\n";
    } catch (error) {
      return Promise.reject(error);
    }
    if (Buffer.byteLength(encoded) > MAX_REQUEST_BYTES) {
      return Promise.reject(new Error("Memory Engine request exceeds 8 MiB."));
    }
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.fail(new Error("Memory Engine request timed out; mutation outcome may be uncertain. No retry was submitted."));
      }, this.timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      this.child.stdin.write(encoded, error => {
        if (error) this.fail(new Error(`Memory Engine request write failed; outcome may be uncertain: ${error.message}`));
      });
    });
  }

  private receive(bytes: Buffer): void {
    if (this.failure) return;
    this.buffer = Buffer.concat([this.buffer, bytes]);
    let newline: number;
    while ((newline = this.buffer.indexOf(10)) >= 0) {
      if (newline > MAX_RESPONSE_BYTES) {
        this.fail(new Error("Memory Engine response exceeded 8 MiB."));
        return;
      }
      const line = this.buffer.subarray(0, newline).toString("utf8");
      this.buffer = this.buffer.subarray(newline + 1);
      let reply: unknown;
      try { reply = JSON.parse(line); }
      catch { this.fail(new Error("Memory Engine returned invalid JSON.")); return; }
      if (!object(reply) || typeof reply.id !== "string" || typeof reply.ok !== "boolean") {
        this.fail(new Error("Memory Engine returned an invalid response envelope."));
        return;
      }
      const pending = this.pending.get(reply.id);
      if (!pending) {
        this.fail(new Error("Memory Engine returned an unknown request identity."));
        return;
      }
      this.pending.delete(reply.id);
      clearTimeout(pending.timer);
      if (reply.ok && (object(reply.result) || Array.isArray(reply.result))) pending.resolve(reply.result);
      else if (!reply.ok && object(reply.error) && typeof reply.error.message === "string") {
        pending.reject(new Error(`Memory Engine ${String(reply.error.type)}: ${reply.error.message}`));
      } else {
        pending.reject(new Error("Memory Engine returned an invalid result."));
        this.fail(new Error("Memory Engine protocol result mismatch."));
        return;
      }
    }
    if (this.buffer.length > MAX_RESPONSE_BYTES) this.fail(new Error("Memory Engine response exceeded 8 MiB."));
  }

  private fail(error: Error): void {
    if (this.failure) return;
    this.failure = error;
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.pending.clear();
    this.child.kill();
  }

  async close(): Promise<void> {
    this.fail(new Error("Memory Engine client closed; in-flight mutation outcomes may be uncertain."));
    if (this.exited) return;
    const timer = setTimeout(() => this.child.kill("SIGKILL"), 2000);
    try { await this.exit; }
    finally { clearTimeout(timer); }
  }
}
