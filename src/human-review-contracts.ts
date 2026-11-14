import type { ApprovalBridgeReview, ApprovalBridgeReviewer, ApprovalBridgeStorage } from "./approval-bridge-contracts.js";
import type { MemoryAuthorizer, MemoryDecisionRequest } from "./memory-contracts.js";
import { z } from "zod";

const text = z.string().min(1).max(256).refine(value => value === value.trim() && !/[\u0000-\u001f\u007f]/u.test(value));
export const humanReviewReadSchema = z.strictObject({});
export const humanReviewDecisionSchema = z.strictObject({
  id: z.uuid(), expectedRevision: z.number().int().positive(),
  intentDigest: z.string().regex(/^[a-f0-9]{64}$/),
  decision: z.enum(["approve", "reject", "cancel"]),
});
export const humanReviewPrincipalSchema = z.strictObject({
  actorId: text, workspaceId: text, readOnly: z.boolean(),
  authorities: z.array(z.enum(["approval", "memory"])).min(1).max(2),
});
export type HumanReviewPrincipal = z.infer<typeof humanReviewPrincipalSchema>;
export type HumanReviewIntent =
  | { authority: "approval"; workspaceId: string; actorId: string; operationId: string; request: ApprovalBridgeReview }
  | { authority: "memory"; workspaceId: string; actorId: string; operationId: string; request: MemoryDecisionRequest };
export type HumanReviewStatus = "pending" | "approved" | "rejected" | "cancelled" | "expired" | "stale" | "unknown";
export interface HumanReviewEntry {
  id: string; revision: number; intentDigest: string; status: HumanReviewStatus;
  authority: "approval" | "memory"; workspaceId: string; actorId: string; operationId: string;
  createdAt: number; expiresAt: number; intent: HumanReviewIntent;
}
export interface HumanReviewOptions {
  workspaceId: string; storage: ApprovalBridgeStorage; leaseMs?: number;
  /** Only a native host may supply evidence and authentication. Never wire this to a public route. */
  authenticateHuman?: (hostEvidence: unknown) => HumanReviewPrincipal | null | Promise<HumanReviewPrincipal | null>;
  /** Synchronous exact-record/source-pin recheck against authoritative state, not an owner permission check. */
  validateCurrent?: (intent: Readonly<HumanReviewIntent>) => boolean;
  memoryActorId?: string;
}
export interface HumanReviewNative {
  openSession(hostEvidence: unknown): Promise<object>;
  closeSession(capability: object): void;
  reviewer: ApprovalBridgeReviewer;
  reviewerWithSignal(request: Readonly<ApprovalBridgeReview>, signal?: AbortSignal): ReturnType<ApprovalBridgeReviewer>;
  memoryAuthorizer: MemoryAuthorizer;
  memoryAuthorizerFor(actorId: string): MemoryAuthorizer;
  cancel(id: string): void;
  shutdown(): void;
}
