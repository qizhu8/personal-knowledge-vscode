import type { DatabaseSync } from "node:sqlite";
import type { ExecutionRecord } from "./execution-state.js";

export interface ApprovalBridgeStorage {
  read<T>(callback: (db: DatabaseSync) => T): T;
  transaction<T>(callback: (db: DatabaseSync) => T): T;
}
export type ApprovalRequestStatus = "pending" | "approved" | "rejected" | "cancelled" | "stale";
export interface ApprovalRequest {
  id: string; workspaceId: string; actorId: string; executionId: string;
  executionRevision: number; revision: number; status: ApprovalRequestStatus;
  operationId: string; recordDigest: string; argumentsDigest: string;
  decisionId: string | null; resolvedExecutionRevision: number | null;
  createdAt: number; updatedAt: number;
}
export interface ApprovalBridgeContext {
  turnId: string; contextDigest: string; readOnly: boolean;
}
export interface ApprovalBridgeReview {
  workspaceId: string; actorId: string; operationId: string; executionOperationId: string;
  recordDigest: string; argumentsDigest: string;
  context: Readonly<ApprovalBridgeContext>;
  record: Readonly<ExecutionRecord>;
}
export type ApprovalBridgeReviewer = (request: Readonly<ApprovalBridgeReview>) => Promise<{
  decision: "approve" | "reject"; decisionId: string; actorId: string;
} | null>;
export interface ApprovalBridgeBinding {
  operation: string; version: 1; arguments: Record<string, unknown>; argumentsDigest: string;
  operationId?: string; actorId: string; workspaceId: string;
  turnId: string; contextDigest: string; readOnly: boolean;
}
export interface ApprovalBridgeDispatch {
  workspaceId: string; actorId: string; operationId: string;
  execution: Readonly<ExecutionRecord>; approval: object; signal: AbortSignal;
}
export interface ApprovalBridgeOptions {
  workspaceId: string; storage: ApprovalBridgeStorage;
  reviewer?: ApprovalBridgeReviewer;
  dispatch?: (request: Readonly<ApprovalBridgeDispatch>) => Promise<{
    status: "succeeded" | "failed"; result?: unknown;
  }>;
  timeoutMs?: number;
  /** Native-only result persistence ceiling; the default remains 65,536 bytes. */
  resultBytes?: number;
}
export interface ApprovalBridgeResult { execution: ExecutionRecord; result?: unknown }
export interface ApprovalBridgeEvent {
  sequence: number; requestId: string; revision: number;
  status: ApprovalRequestStatus; action: string; at: number;
}
