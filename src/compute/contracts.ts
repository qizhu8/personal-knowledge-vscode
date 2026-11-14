export type ComputeResult = Record<string, unknown> | unknown[];
export type PieceKind = "piece" | "message" | "topic" | "project";
export interface Message { id: string; text: string; revision?: string }
export interface SourceReference { id: string; chat: string; revision: string; locator: string }
export interface ModelObservation {
  usage?: Record<string, number>;
  accounting?: Record<string, unknown>;
}
export interface BeginTurn {
  scope: string; turn: string; input: Message;
  recent?: (Message & { role: "user" | "assistant" })[];
  budget_chars?: number; model?: string;
}
export interface ContinueTurn extends ModelObservation { turn: string; output?: string; error?: string }
export interface AbortTurn extends ModelObservation { turn: string; error: string }
export interface CommitTurn { turn: string; user: Message; assistant: Message; scope?: string; model?: string }
export interface CreatePiece { piece: string; label: string; kind?: PieceKind; scope?: string }
export interface AppendStatement {
  piece: string; statement_id: string; expected_revision: number; body: string;
  status?: "proposal" | "observation" | "user-confirmed" | "verified" | "disputed";
  sources: SourceReference[];
}
export interface LinkPieces {
  parent: string; child: string;
  relation: "abstracts" | "part_of" | "clarifies" | "revises" | "supersedes" | "addresses" | "implements" | "verifies";
}
export interface PutEmbedding {
  piece: string; representation: "summary"; revision: number; input_content_hash: string;
  embedding_space_id: string; dimensions: number; distance_metric: "cosine" | "dot" | "l2"; embedding: number[];
}
export interface ComputeOptions {
  /** Trusted host configuration: executable path, never a command line or shell. */
  python: string;
  /** Dedicated disposable/rebuildable runtime partition, not the Knowledge Root. */
  runtimeDirectory: string;
  /** Absolute direct child of runtimeDirectory; no SQLite URI or symlink. */
  database: string;
  identity: string;
  startupTimeoutMs?: number;
  requestTimeoutMs?: number;
  closeTimeoutMs?: number;
  maxPendingRequests?: number;
  maxQueuedBytes?: number;
  maxRequestBytes?: number;
  maxResponseBytes?: number;
  maxStderrBytes?: number;
}
export type ComputeOutcome = "not-submitted" | "read-only" | "rejected" | "unknown";
export class ComputeError extends Error {
  constructor(readonly code: string, message: string, readonly outcome: ComputeOutcome = "not-submitted",
    readonly diagnostics = "") {
    super(message);
    this.name = "ComputeError";
  }
}
export interface ComputeReady {
  type: "ready"; protocol: 1; adapter: "pkm-next-chat-compute/1";
  module: "pkm-memory-engine"; policy: "pkm-memory-policy/1";
  schema: 2; identity: string; storage: "worker-owned-runtime-sqlite";
  explicit_memory: "node-markdown"; capabilities: Record<string, unknown>;
}
