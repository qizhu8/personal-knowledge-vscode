import { randomUUID } from "node:crypto";
import { approvalBridgeDigest, approvalBridgeFreeze, approvalBridgeRecordDigest } from "../dist/domain/approval-bridge-digest.js";

// Synthetic records use real native contracts; none is captured production provenance.
export function executionReview(overrides = {}) {
  const context = { turnId: "synthetic-turn", contextDigest: "a".repeat(64), readOnly: false };
  const record = { id: randomUUID(), actor: "alice", revision: 1, status: "awaiting_approval",
    tool: "fixture.document.edit", arguments: { documentId: "synthetic-document", content: "<img src=x onerror=evil()>" },
    approvalRequired: true, approvalDecisionId: null, createdAt: 1, updatedAt: 1, ...overrides };
  const executionOperationId = randomUUID();
  return approvalBridgeFreeze({
    workspaceId: "synthetic-workspace", actorId: record.actor, operationId: randomUUID(),
    executionOperationId, context, record, argumentsDigest: approvalBridgeDigest(record.arguments),
    recordDigest: approvalBridgeRecordDigest("synthetic-workspace", record, context, executionOperationId),
  });
}
export function memoryReview(operation = "memory.record.confirm") {
  const request = {
    operation, operationId: randomUUID(),
    record: { id: "synthetic-memory", scope: "synthetic-repository", revision: 1, current_revision: 1,
      status: "pending", current_status: "pending", created_at: 1, updated_at: 1, revision_created_at: 1,
      content: "Synthetic sourced fact", documentSha256: "b".repeat(64),
      sources: [{ id: "synthetic-source", chat: "synthetic-chat", revision: "7", locator: "message:3" }] },
    ...(operation === "memory.record.revise" ? { replacement: { content: "Replacement sourced fact",
      sources: [{ id: "synthetic-source", chat: "synthetic-chat", revision: "8", locator: "message:4" }] } } : {}),
  };
  return approvalBridgeFreeze(request);
}
