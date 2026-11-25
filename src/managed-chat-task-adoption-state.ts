import type { DatabaseSync } from "node:sqlite";
import { originalNativeChatDigest } from "./original-mcp-api-chat-contracts.js";
import { syncPlanHash } from "./sync-plan.js";
import { managedTaskAuthorityFailure } from "./managed-chat-task-admission.js";
import { assertOriginalManagedTaskAdoptionSource } from "./managed-chat-task-adoption-source.js";
import { originalManagedTaskAdoptionStoredProof, originalManagedTaskAdoptionSummary } from "./managed-chat-task-adoption-contracts.js";
import { validWorkGoal } from "./managed-chat-task-original.js";

type Json = Record<string, any>;
/** Durable identity provenance only. A receipt is never a replacement for fresh source/model/send authority. */
export function readOriginalManagedTaskAdoptionReceipt(db: DatabaseSync, root: string, chatId: string) {
  const task = db.prepare("SELECT * FROM managed_chat_tasks WHERE actor_id='mcp:external' AND chat_id=?").get(chatId);
  if (!task) return;
  const receipt = db.prepare("SELECT * FROM receipts WHERE operation_id=? AND operation='chat.task.adopt' AND actor_id='mcp:external'")
    .get(task.create_operation_id);
  if (!receipt) return;
  const result = JSON.parse(String(receipt.result)), stored = originalManagedTaskAdoptionStoredProof.parse(result.adoptionProof);
  const { proof, begin } = stored, source = assertOriginalManagedTaskAdoptionSource(db, root, proof.source);
  if (!validWorkGoal(source.goal) || receipt.fingerprint !== syncPlanHash({ operation: "chat.task.adopt", args: begin,
    actorId: "mcp:external", taskId: begin.taskId, attemptId: begin.attemptId, requestId: begin.requestId })
    || begin.operationId !== task.create_operation_id || begin.taskId !== task.task_id || begin.chatId !== chatId
    || begin.adoptionSha256 !== originalNativeChatDigest(proof) || source.taskId !== begin.taskId
    || result.schema !== "pkm.chat.managed-task/v1" || result.taskId !== source.taskId || result.chatId !== chatId
    || result.goal?.id !== source.goal.id || result.goal?.inputId !== source.goal.inputId
    || result.goal?.executionDigest !== proof.review.nextExecutionDigest
    || result.attempt?.id !== begin.attemptId || result.attempt?.requestId !== begin.requestId
    || stored.ownerId !== task.owner_id || stored.ownerFence !== task.owner_fence || stored.nativeEpoch !== task.native_epoch
    || task.context_digest !== proof.review.nextExecutionDigest || task.source_plan_sha256 !== proof.review.sourcePlanSha256)
    managedTaskAuthorityFailure("The actual adoption receipt lost its exact original/Core identity binding.");
  return stored;
}
export function originalManagedTaskAdoptionProvenance(stored: ReturnType<typeof originalManagedTaskAdoptionStoredProof.parse>) {
  const { source, review } = stored.proof;
  if (!validWorkGoal(source.goal)) managedTaskAuthorityFailure("Invalid original Goal.");
  return originalManagedTaskAdoptionSummary.parse({
    authority: "historical-origin-only", chatId: source.chatId, taskId: source.taskId,
    goalId: source.goal.id, originalInputId: source.goal.inputId, metadataSha256: source.metadataSha256,
    sessionSha256: source.sessionSha256, historySha256: source.historySha256,
    sourceSha256: review.sourceSha256, previousExecutionDigest: review.previousExecutionDigest,
    oldAcceptanceImported: false, oldPermissionsImported: false,
  });
}
/** Initial admission only; it is rechecked within the existing worker transaction, before lookup and commit. */
export function assertOriginalManagedTaskAdoptionReview(proof: ReturnType<typeof originalManagedTaskAdoptionStoredProof.parse>["proof"],
  guard: Json, initial: boolean) {
  const { review, decision, source } = proof, { messages: _messages, pins: _pins, messageHashes: _hashes, ...publicSource } = source;
  if (!validWorkGoal(source.goal) || review.requestId !== guard.requestId || review.commandId !== guard.commandId
    || review.chatUrl !== guard.chatUrl || review.sourcePlanSha256 !== guard.sourcePlanSha256
    || review.sourceSha256 !== originalNativeChatDigest(source) || originalNativeChatDigest(review.original) !== originalNativeChatDigest(publicSource)
    || review.argumentsSha256 !== originalNativeChatDigest({ chatId: guard.chatId, prompt: guard.prompt,
      ...(guard.hardToolRoundLimit === null ? {} : { hardToolRoundLimit: guard.hardToolRoundLimit }) })
    || review.prompt !== guard.prompt || source.chatId !== guard.chatId || source.taskId !== guard.taskId
    || review.previousExecutionDigest !== source.goal.executionDigest || review.nextExecutionDigest !== guard.contextDigest
    || originalNativeChatDigest(review.selection) !== guard.modelSha256
    || decision.decision !== "adopt-and-revalidate" || decision.actorId !== guard.actorId || decision.requestId !== guard.requestId
    || decision.epoch !== guard.nativeEpoch || decision.bindingSha256 !== originalNativeChatDigest(review)
    || initial && (decision.expiresAtMs <= Date.now() || decision.expiresAtMs < guard.expiresAtMs))
    managedTaskAuthorityFailure("The exact independently reviewed adoption/source/Goal/model/send binding changed.");
}
