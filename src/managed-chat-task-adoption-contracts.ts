import { z } from "zod";
import { originalNativeChatSelection } from "./original-mcp-api-chat-contracts.js";
import { validWorkGoal } from "./managed-chat-task-original.js";

const uuid = z.string().uuid(), digest = z.string().regex(/^[a-f0-9]{64}$/);
const goalKeys = new Set(["id", "inputId", "attemptInputId", "objective", "executionDigest", "status",
  "acceptance", "reason", "nextAction", "transitions", "contract", "phase"]);
export const originalManagedTaskAdoptionGoal = z.json().refine(value =>
  validWorkGoal(value) && Object.keys(value).every(key => goalKeys.has(key)), "A bounded original ordinary work Goal is required.");
export const originalManagedTaskAdoptionPin = z.strictObject({
  path: z.string().min(1).max(1024), sha256: digest, bytes: z.number().int().min(0).max(1048576),
});
export const originalManagedTaskAdoptionSource = z.strictObject({
  schema: z.literal("pkm.chat.original-task-adoption-source/v1"),
  chatId: uuid, namespace: z.string().regex(/^[a-f0-9]{16}$/),
  taskId: z.string().regex(/^agent_session_[a-f0-9]{32}$/), chatTitle: z.string().min(1).max(120),
  taskTitle: z.string().min(1).max(120), sessionStatus: z.enum(["paused", "completed", "failed", "cancelled", "interrupted", "stopped"]),
  metadataSha256: digest, sessionSha256: digest, historySha256: digest,
  goal: originalManagedTaskAdoptionGoal, sourceInputIds: z.array(uuid).min(1).max(63),
  messageHashes: z.array(z.strictObject({ id: uuid, sha256: digest })).min(1).max(32),
  messages: z.array(z.json()).min(1).max(32), pins: z.array(originalManagedTaskAdoptionPin).min(2).max(128),
});
export const originalManagedTaskAdoptionRequest = z.strictObject({
  schema: z.literal("pkm.chat.original-task-adoption-review/v1"),
  requestId: digest, commandId: z.string().min(1).max(128),
  chatUrl: z.string().regex(/^pkm:\/\/chats\/[a-f0-9]{16}\/[a-f0-9-]{36}$/),
  sourcePlanSha256: digest, sourceSha256: digest,
  original: originalManagedTaskAdoptionSource.omit({ messages: true, pins: true, messageHashes: true }),
  selection: originalNativeChatSelection.refine(value => value.protocol === "pkm.original-api-chat-execution/v1"),
  prompt: z.string().min(1).max(16000), argumentsSha256: digest,
  previousExecutionDigest: digest, nextExecutionDigest: digest,
  resetCurrentAcceptance: z.literal(true), importOldPermissions: z.literal(false),
  historicalEvidenceOnly: z.literal(true), taskCompletion: z.literal("not-claimed"),
});
export const originalManagedTaskAdoptionDecision = z.strictObject({
  decision: z.enum(["adopt-and-revalidate", "deny"]), actorId: z.literal("mcp:external"),
  decisionId: z.string().min(1).max(512), expiresAtMs: z.number().int().positive(),
  requestId: digest, epoch: z.string().min(1).max(512), bindingSha256: digest,
});
export interface OriginalManagedTaskAdoptionPort {
  adopt(input: z.infer<typeof originalManagedTaskAdoptionRequest>, signal: AbortSignal):
    Promise<z.infer<typeof originalManagedTaskAdoptionDecision>>;
}
export const originalManagedTaskAdoptionProof = z.strictObject({
  source: originalManagedTaskAdoptionSource, review: originalManagedTaskAdoptionRequest,
  decision: originalManagedTaskAdoptionDecision,
});
export const originalManagedTaskAdoptionBegin = z.strictObject({
  operationId: uuid, taskId: z.string().regex(/^agent_session_[a-f0-9]{32}$/), attemptId: uuid,
  inputId: uuid, replyId: uuid, requestId: digest, chatId: uuid, expectedChatRevision: z.literal(0),
  prompt: z.string().min(1).max(16000), adoptionSha256: digest,
});
export const originalManagedTaskAdoptionStoredProof = z.strictObject({
  proof: originalManagedTaskAdoptionProof, begin: originalManagedTaskAdoptionBegin,
  nativeHostReceiptSha256: digest, nativeEpoch: uuid, ownerId: uuid, ownerFence: z.number().int().positive(),
});
export const originalManagedTaskAdoptionSummary = z.strictObject({
  authority: z.literal("historical-origin-only"), chatId: uuid,
  taskId: z.string().regex(/^agent_session_[a-f0-9]{32}$/), goalId: uuid, originalInputId: uuid,
  metadataSha256: digest, sessionSha256: digest, historySha256: digest, sourceSha256: digest,
  previousExecutionDigest: digest, oldAcceptanceImported: z.literal(false), oldPermissionsImported: z.literal(false),
});
export type OriginalManagedTaskAdoptionSource = z.infer<typeof originalManagedTaskAdoptionSource>;
export type OriginalManagedTaskAdoptionProof = z.infer<typeof originalManagedTaskAdoptionProof>;
