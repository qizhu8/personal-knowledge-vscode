import { z } from "zod";
import type { DatabaseSync } from "node:sqlite";
import { CoreError } from "./host-composition-legacy-batch15-errors.js";
import { originalNativeChatDigest } from "./original-mcp-api-chat-contracts.js";
import { readOriginalMcpJournal } from "./original-mcp-root-custody.js";
import { managedTaskId, type ManagedTaskOperation } from "./managed-chat-task-contracts.js";
import { chatSessionRecord } from "./chat-session-contracts.js";
import { originalManagedTaskAdoptionProof } from "./managed-chat-task-adoption-contracts.js";
import { assertOriginalManagedTaskAdoptionSource } from "./managed-chat-task-adoption-source.js";
import { assertOriginalManagedTaskAdoptionReview, readOriginalManagedTaskAdoptionReceipt } from "./managed-chat-task-adoption-state.js";

const uuid = z.string().uuid(), digest = z.string().regex(/^[a-f0-9]{64}$/);
const flag = z.custom<SharedArrayBuffer>(value => value instanceof SharedArrayBuffer && value.byteLength === 4);
const source = z.strictObject({
  actorId: z.literal("mcp:external"), decisionId: z.string().min(1), expiresAtMs: z.number().int().positive(),
  root: z.string(), workspaceId: uuid, custodyPlanSha256: digest, profileSha256: digest,
  planSha256: digest, nativeHostReceiptSha256: digest, epoch: z.string(), revocation: flag,
});
export const managedTaskAdmissionSchema = z.strictObject({
  schema: z.literal("pkm.chat.managed-task-storage-admission/v1"),
  guard: z.strictObject({
    root: z.string(), workspaceId: uuid, actorId: z.literal("mcp:external"),
    ownerLease: z.strictObject({ ownerId: uuid, fence: z.number().int().positive() }),
    nativeHostReceiptSha256: digest, nativeEpoch: uuid, nativeBrokerId: uuid, nativeIdentitySha256: digest,
    sourcePlanSha256: digest, sourceDecisionId: z.string().min(1), expiresAtMs: z.number().int().positive(),
    chatId: uuid, chatUrl: z.string().regex(/^pkm:\/\/chats\/[a-f0-9]{16}\/[a-f0-9-]{36}$/),
    chatCreateRequestId: digest, initialChatRevision: z.number().int().nonnegative(),
    taskId: managedTaskId, attemptId: uuid, inputId: uuid, replyId: uuid, requestId: digest,
    creationOperationId: uuid,
    commandId: z.string().min(1).max(128), prompt: z.string().min(1).max(16000),
    nativeModelId: z.string().min(1).max(512), modelSha256: digest, contextDigest: digest,
    hardToolRoundLimit: z.number().int().min(1).max(1000).nullable(),
    mode: z.enum(["start", "attempt", "execute", "read", "cancel", "adopt"]),
    expectedTaskRevision: z.number().int().positive().nullable(),
    replacement: z.strictObject({ taskId: managedTaskId, revision: z.number().int().positive(),
      attemptId: uuid, goalSha256: digest }).optional(),
    portalOrigin: z.strictObject({ requestId: uuid, contextId: uuid, pairId: uuid }).optional(),
    manualOrigin: z.strictObject({ requestId: uuid, contextId: uuid, pairId: uuid,
      originalReplyId: uuid, originalInputId: uuid, retryOfReplyId: uuid, retryOfAttemptId: uuid,
      nativeRequestId: digest, revision: z.number().int().positive(), goalSha256: digest,
      shareConfirmed: z.literal(true) }).optional(),
  }),
  sourceAuthority: source, hostRevocation: flag, attemptRevocation: flag,
  adoption: originalManagedTaskAdoptionProof.optional(),
  guardSha256: digest,
});
export type ManagedTaskAdmission = z.infer<typeof managedTaskAdmissionSchema>;
export interface ManagedTaskWorkerRequest {
  operation: ManagedTaskOperation; args: Record<string, unknown>; admission: ManagedTaskAdmission;
}
export function managedTaskAuthorityFailure(message: string): never {
  throw new CoreError("NATIVE_AUTHORITY_REQUIRED", `MANAGED_TASK_NATIVE_ADMISSION_REQUIRED: ${message}`);
}

/** Rechecked inside the owning worker transaction before receipt lookup and before COMMIT. */
export function assertManagedTaskAdmission(db: DatabaseSync, root: string, value: unknown,
  owner: { ownerId?: string; fence?: number }, operation: ManagedTaskOperation) {
  const data = managedTaskAdmissionSchema.parse(value), g = data.guard, a = data.sourceAuthority;
  const journal = readOriginalMcpJournal(root);
  if (!journal || g.root !== root || g.workspaceId !== journal.workspaceId || g.expiresAtMs <= Date.now()
    || g.ownerLease.ownerId !== owner.ownerId || g.ownerLease.fence !== owner.fence)
    managedTaskAuthorityFailure("The actual Root/owner/source session changed.");
  if (data.guardSha256 !== originalNativeChatDigest(g)) managedTaskAuthorityFailure("The typed native request changed.");
  if (Atomics.load(new Int32Array(data.hostRevocation), 0) !== 0
    || Atomics.load(new Int32Array(a.revocation), 0) !== 0
    || !["chat.task.cancel", "chat.task.get", "chat.task.attempt.finish"].includes(operation)
      && Atomics.load(new Int32Array(data.attemptRevocation), 0) !== 0)
    managedTaskAuthorityFailure("The source, native host or attempt was revoked.");
  if (a.actorId !== g.actorId || a.root !== root || a.workspaceId !== g.workspaceId
    || a.custodyPlanSha256 !== journal.plan.planSha256 || a.profileSha256 !== journal.plan.profileSha256
    || a.planSha256 !== g.sourcePlanSha256 || a.nativeHostReceiptSha256 !== g.nativeHostReceiptSha256
    || a.epoch !== g.nativeEpoch || a.decisionId !== g.sourceDecisionId || a.expiresAtMs < g.expiresAtMs)
    managedTaskAuthorityFailure("The exact source-only authority no longer matches.");
  const currentOwner = db.prepare("SELECT owner_id,fence,lease_until FROM native_runtime_owner WHERE singleton=1").get();
  if (!currentOwner || currentOwner.owner_id !== owner.ownerId || currentOwner.fence !== owner.fence
    || Number(currentOwner.lease_until) <= Date.now()) managedTaskAuthorityFailure("The canonical owner lease expired.");
  const hostRow = db.prepare("SELECT payload FROM original_mcp_native_host_admissions WHERE receipt_sha256=?").get(g.nativeHostReceiptSha256);
  const admitted = db.prepare("SELECT sha256 FROM original_api_chat_source_admission WHERE singleton=1").get();
  if (!hostRow || admitted?.sha256 !== g.sourcePlanSha256) managedTaskAuthorityFailure("Native/source admission is unavailable.");
  const native = JSON.parse(String(hostRow.payload)), { receiptSha256, ...body } = native;
  if (receiptSha256 !== g.nativeHostReceiptSha256 || originalNativeChatDigest(body) !== receiptSha256
    || native.epoch !== g.nativeEpoch || native.authorityId !== `native-rpc:${g.nativeBrokerId}`
    || native.actorId !== g.actorId || native.root !== root || native.workspaceId !== g.workspaceId
    || native.planSha256 !== a.custodyPlanSha256 || native.profileSha256 !== a.profileSha256)
    managedTaskAuthorityFailure("The independently authenticated native Host changed.");
  const archived = db.prepare("SELECT 1 FROM original_api_chat_source_chats WHERE id=?").get(g.chatId);
  const adopted = archived ? readOriginalManagedTaskAdoptionReceipt(db, root, g.chatId) : undefined;
  if (operation === "chat.task.adopt" && !adopted) {
    if (g.mode !== "adopt" || g.initialChatRevision !== 0 || !data.adoption)
      managedTaskAuthorityFailure("The actual independent original Task adoption grant is required.");
    assertOriginalManagedTaskAdoptionSource(db, root, data.adoption.source);
    assertOriginalManagedTaskAdoptionReview(data.adoption, g, true);
    const request = db.prepare(`SELECT q.*,s.status,s.epoch FROM original_api_chat_requests q
      JOIN original_api_chat_request_state s ON s.request_id=q.request_id WHERE q.request_id=?`).get(g.requestId);
    const input = request ? JSON.parse(String(request.arguments)) : undefined;
    if (!request || request.operation !== "send" || request.command_id !== g.commandId || request.host_id !== g.workspaceId
      || request.status !== "running" || request.epoch !== g.nativeEpoch
      || ![g.chatId, g.chatUrl].includes(input?.chatId) || input?.prompt !== g.prompt
      || (input.hardToolRoundLimit ?? null) !== g.hardToolRoundLimit)
      managedTaskAuthorityFailure("Adoption belongs to the actual exact running original API send command, not a copied intent.");
    if (db.prepare("SELECT 1 FROM chat_sessions WHERE actor_id=? AND id=?").get(g.actorId, g.chatId)
      || db.prepare("SELECT 1 FROM original_api_chat_current_chats WHERE id=?").get(g.chatId)
      || db.prepare("SELECT 1 FROM managed_chat_tasks WHERE task_id=? OR chat_id=?").get(g.taskId, g.chatId))
      managedTaskAuthorityFailure("Adoption never overwrites a canonical Chat/Task identity.");
    return { data, chat: undefined };
  }
  if (archived && !adopted)
    managedTaskAuthorityFailure("Archived original Chats require their actual independently reviewed adoption receipt.");
  const map = db.prepare(`SELECT c.namespace,c.create_request_id,c.model_selection,q.operation,s.status,s.epoch
    FROM original_api_chat_current_chats c JOIN original_api_chat_requests q ON q.request_id=c.create_request_id
    JOIN original_api_chat_request_state s ON s.request_id=q.request_id WHERE c.id=?`).get(g.chatId);
  const identityReceipt = adopted ? map?.operation === "send" && adopted.begin.requestId === map.create_request_id
    && adopted.nativeHostReceiptSha256 === g.nativeHostReceiptSha256
    && ["running", "succeeded", "outcome_unknown", "failed"].includes(String(map.status))
    : map?.operation === "create" && map.status === "succeeded";
  if (!map || map.create_request_id !== g.chatCreateRequestId || !identityReceipt
    || map.epoch !== g.nativeEpoch || g.chatUrl !== `pkm://chats/${map.namespace}/${g.chatId}`)
    managedTaskAuthorityFailure("An exact native create or independently reviewed canonical adoption receipt is required.");
  const model = JSON.parse(String(map.model_selection));
  if (originalNativeChatDigest(model) !== g.modelSha256 || model.provider !== "vscode"
    || model.protocol !== "pkm.original-api-chat-execution/v1" || model.epoch !== g.nativeEpoch
    || model.wireModelId !== g.nativeModelId)
    managedTaskAuthorityFailure("The actual native Chat model/permission/budget binding changed.");
  const row = db.prepare("SELECT record,revision FROM chat_sessions WHERE actor_id=? AND id=?").get(g.actorId, g.chatId);
  if (!row) managedTaskAuthorityFailure("The same actor's canonical Chat is unavailable.");
  const chat = chatSessionRecord.parse(JSON.parse(String(row.record)));
  if (chat.archivedAt || chat.revision !== row.revision || chat.metadata?.sessionId)
    managedTaskAuthorityFailure("The current Chat revision, archive state or Task identity changed.");
  return { data, chat };
}
