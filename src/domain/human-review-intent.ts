import { approvalBridgeDigest, approvalBridgeFreeze, approvalBridgeJSON, approvalBridgeRecordDigest } from "./approval-bridge-digest.js";
import { memoryContent, memoryRecord } from "../memory-contracts.js";
import type { ApprovalBridgeReview } from "../approval-bridge-contracts.js";
import type { MemoryDecisionRequest } from "../memory-contracts.js";
import type { HumanReviewIntent } from "../human-review-contracts.js";
import { z } from "zod";

const text = z.string().min(1).max(256).refine(value => value === value.trim() && !/[\u0000-\u001f\u007f]/u.test(value));
const hash = z.string().regex(/^[a-f0-9]{64}$/);
const sensitive = /^(?:password|passwd|secret|token|access_token|refresh_token|authorization|cookie|credentials?|api[_-]?key|private[_-]?key)$/i;
function rejectCredentials(value: unknown): void {
  if (value && typeof value === "object") {
    for (const [key, child] of Object.entries(value)) {
      if (sensitive.test(key)) throw new Error("Credential-bearing review input is unavailable; secrets must stay out of the queue.");
      rejectCredentials(child);
    }
  }
}
export function normalizeHumanReviewIntent(intent: HumanReviewIntent): Readonly<HumanReviewIntent> {
  text.parse(intent.actorId); text.parse(intent.workspaceId); text.parse(intent.operationId);
  const encoded = approvalBridgeJSON(intent);
  if (Buffer.byteLength(encoded) > 64_000) throw new Error("Review intent exceeds its local budget.");
  const copy: HumanReviewIntent = JSON.parse(encoded);
  if (copy.authority === "approval") {
    const request = copy.request;
    hash.parse(request.recordDigest); hash.parse(request.argumentsDigest); hash.parse(request.context.contextDigest);
    text.parse(request.context.turnId); text.parse(request.executionOperationId);
    if (request.actorId !== copy.actorId || request.workspaceId !== copy.workspaceId || request.operationId !== copy.operationId
      || request.record.actor !== copy.actorId || request.record.status !== "awaiting_approval"
      || !request.record.approvalRequired || request.context.readOnly
      || /^memory[._]record[._](confirm|revise|revoke)$/.test(request.record.tool)
      || approvalBridgeDigest(request.record.arguments) !== request.argumentsDigest
      || approvalBridgeRecordDigest(copy.workspaceId, request.record, request.context, request.executionOperationId) !== request.recordDigest)
      throw new Error("Invalid exact execution review pins.");
    rejectCredentials(request.record.arguments);
  } else if (copy.authority === "memory") {
    const request = copy.request;
    memoryRecord.parse(request.record);
    if (!["memory.record.confirm", "memory.record.revise", "memory.record.revoke"].includes(request.operation)
      || request.operationId !== copy.operationId || request.record.revision !== request.record.current_revision
      || request.record.current_status === "revoked"
      || request.operation === "memory.record.confirm" && request.record.status !== "pending"
      || request.operation === "memory.record.revise" && !request.replacement
      || request.operation !== "memory.record.revise" && request.replacement)
      throw new Error("Invalid exact memory review pins.");
    if (request.replacement) memoryContent.parse(request.replacement);
  } else throw new Error("Unsupported human review authority.");
  return approvalBridgeFreeze(copy);
}
export function approvalHumanIntent(request: Readonly<ApprovalBridgeReview>): HumanReviewIntent {
  return { authority: "approval", actorId: request.actorId, workspaceId: request.workspaceId,
    operationId: request.operationId, request };
}
export function memoryHumanIntent(workspaceId: string, actorId: string, request: Readonly<MemoryDecisionRequest>): HumanReviewIntent {
  return { authority: "memory", workspaceId, actorId, operationId: request.operationId, request };
}

/**
 * Source-grounded presentation: src/chat/portal-native-interaction.ts's modal/current checks
 * and src/chat/explicit-memory-tools.ts's formatExplicitMemoryDecision before/after/source detail.
 * This is a new durable queue, not a claim of captured native recovery parity.
 */
export function humanReviewDetail(intent: HumanReviewIntent): string {
  if (intent.authority === "approval") {
    const { record, context, recordDigest, argumentsDigest, executionOperationId } = intent.request;
    return [
      `Command: ${record.tool}`, `Exact arguments:\n${approvalBridgeJSON(record.arguments)}`,
      `Execution: ${record.id} · revision ${record.revision}`, `Execution operation: ${executionOperationId}`,
      `Turn: ${context.turnId}`, `Context/source pin: ${context.contextDigest}`,
      `Record pin: ${recordDigest}`, `Arguments pin: ${argumentsDigest}`,
      "Document impact: only the exact command and supplied arguments above are authorized. No inferred document changes or general grant.",
    ].join("\n");
  }
  const { record, replacement, operation } = intent.request;
  const sources = (items: typeof record.sources) => items.map(source =>
    `Source ID: ${source.id}\nChat: ${source.chat}\nRevision: ${source.revision}\nLocator: ${source.locator}`).join("\n");
  const effect = operation === "memory.record.confirm" ? "Eligible for future active Memory search."
    : operation === "memory.record.revise" ? "New pending revision; prior confirmation does not carry forward."
    : "Excluded from future active Memory search; history retained, not erased.";
  return [
    `Command: ${operation}`, `Record: ${record.id} · revision ${record.revision}`,
    `Scope: ${record.scope}`, `Document pin: ${record.documentSha256}`,
    `Current status: ${record.current_status}`, `Current content:\n${record.content}`,
    `Current source pins:\n${sources(record.sources)}`,
    ...(replacement ? [`Replacement content:\n${replacement.content}`, `Replacement source pins:\n${sources(replacement.sources)}`] : []),
    `Document impact: ${effect}`,
  ].join("\n");
}
