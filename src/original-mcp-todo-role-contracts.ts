import { z } from "zod";
import { originalNativeActionPayloadSchemas } from "./original-mcp-native-action-contracts.js";
import { originalNativeSourceSessionSchema, originalNativeSourceRequestDigest } from "./original-mcp-native-source-contracts.js";

const digest = z.string().regex(/^[a-f0-9]{64}$/), uuid = z.string().uuid();
const text = z.string().min(1).max(256);
export const originalTodoRoleMethods = Object.freeze(["todo.role.approve", "todo.human.accept"] as const);
export type OriginalTodoRoleMethod = typeof originalTodoRoleMethods[number];
export const originalTodoRoleDigest = originalNativeSourceRequestDigest;
export const originalTodoRoleOperations = Object.freeze({
  worker: Object.freeze(["todo.workitem.get", "todo.workitem.claim", "todo.workitem.submit"] as const),
  reviewer: Object.freeze(["todo.workitem.get", "todo.workitem.comment"] as const),
});
export const originalTodoRolePins = z.strictObject({
  root: z.string().min(1).max(4096), workspaceId: uuid, custodyPlanSha256: digest, profileSha256: digest,
  catalogSha256: digest, nativeHostReceiptSha256: digest,
  nativeEpoch: uuid, nativeBrokerId: uuid, nativeIdentitySha256: digest,
  ownerLease: z.strictObject({ ownerId: uuid, fence: z.number().safe().int().positive() }),
  boardSlug: z.string().min(1).max(1024).refine(value =>
    value.split("/").every(part => !!part && !part.startsWith(".") && !/[\\:\u0000-\u001f]/u.test(part))),
  workItemId: z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,79}$/),
  boardDigest: digest, intentSha256: digest, todoDecisionId: text,
  chatSourcePlanSha256: digest, chatSourceDecisionId: text,
  expiresAtMs: z.number().safe().int().positive(),
});
export const originalTodoRoleRequest = originalTodoRolePins.extend({
  schema: z.literal("pkm.original-native-todo-role-request/v1"),
  role: z.enum(["worker", "reviewer"]), actorId: z.string().regex(/^chat:[a-f0-9-]{36}$/),
  chatId: uuid, chatUrl: z.string().regex(/^pkm:\/\/chats\/[a-f0-9]{16}\/[a-f0-9-]{36}$/),
  chatRevision: z.number().safe().int().nonnegative(), bindingRequestId: digest, bindingSha256: digest,
  requestId: digest, planSha256: digest, modelId: text, selectionId: text,
});
export const originalSdkTodoRoleRequest = originalTodoRoleRequest.extend({
  schema: z.literal("pkm.original-sdk-todo-role-request/v1"), provider: z.literal("copilot-sdk"),
  modelId: text.refine(value => value.startsWith("vscode:copilot-sdk:")),
});
export const originalTodoRoleProof = z.strictObject({
  requestId: digest, planSha256: digest, operationId: uuid, actorId: originalTodoRoleRequest.shape.actorId,
  decisionId: text, requestSha256: digest,
});
export const originalTodoHumanRequest = originalTodoRolePins.extend({
  schema: z.literal("pkm.original-native-todo-human-request/v1"),
  actorId: z.literal("user:local"), operationId: uuid, itemSha256: digest,
  item: z.record(z.string(), z.json()), worker: originalTodoRoleProof, reviewer: originalTodoRoleProof,
});
const binding = originalNativeActionPayloadSchemas["action.status"].shape.binding;
export const originalTodoRolePayloads = Object.freeze({
  "todo.role.approve": z.strictObject({ binding, request: z.discriminatedUnion("schema", [
    originalTodoRoleRequest, originalSdkTodoRoleRequest,
  ]) }),
  "todo.human.accept": z.strictObject({ binding, request: originalTodoHumanRequest }),
});
export const originalTodoRoleDecision = z.strictObject({
  schema: z.literal("pkm.original-native-todo-role-decision/v1"),
  actorId: originalTodoRoleRequest.shape.actorId, decisionId: text, requestSha256: digest,
  epoch: uuid, expiresAtMs: z.number().safe().int().positive(),
});
export const originalTodoHumanDecision = z.strictObject({
  schema: z.literal("pkm.original-native-todo-human-decision/v1"),
  actorId: z.literal("user:local"), decisionId: text, requestSha256: digest,
  epoch: uuid, expiresAtMs: z.number().safe().int().positive(),
  reason: z.string().trim().min(1).max(8000),
});
export const originalTodoRoleResults = Object.freeze({
  "todo.role.approve": originalTodoRoleDecision.nullable(),
  "todo.human.accept": originalTodoHumanDecision.nullable(),
});
export type OriginalTodoRoleRequest = z.infer<typeof originalTodoRoleRequest>;
export type OriginalTodoRolePayload = z.infer<typeof originalTodoRolePayloads["todo.role.approve"]>;
export type OriginalTodoHumanPayload = z.infer<typeof originalTodoRolePayloads["todo.human.accept"]>;
export type OriginalTodoRoleDecision = z.infer<typeof originalTodoRoleDecision>;
export type OriginalTodoHumanDecision = z.infer<typeof originalTodoHumanDecision>;
export function isOriginalTodoRoleMethod(value: unknown): value is OriginalTodoRoleMethod {
  return value === "todo.role.approve" || value === "todo.human.accept";
}
function fail(): never { throw Object.assign(new Error("NATIVE_TODO_ROLE_BINDING_MISMATCH"), { code: "NATIVE_TODO_ROLE_BINDING_MISMATCH" }); }
export function parseOriginalTodoRolePayload(method: OriginalTodoRoleMethod, value: unknown, context: unknown) {
  const session = originalNativeSourceSessionSchema.parse(context);
  const payload = originalTodoRolePayloads[method].parse(value), p = payload.request, b = payload.binding, s = session.binding;
  if (session.epoch !== session.activationId || p.root !== s.root || p.workspaceId !== s.workspaceId
    || p.custodyPlanSha256 !== s.planSha256 || p.profileSha256 !== s.profileSha256 || p.catalogSha256 !== s.catalogSha256
    || p.nativeEpoch !== session.epoch || p.nativeBrokerId !== session.brokerId || p.nativeIdentitySha256 !== session.identitySha256
    || b.root !== s.root || b.workspaceId !== s.workspaceId || b.planSha256 !== s.planSha256
    || b.profileSha256 !== s.profileSha256 || b.sourceCatalogSha256 !== s.catalogSha256 || b.epoch !== session.epoch
    || b.authorityId !== `native-rpc:${session.brokerId}` || !b.domains.includes("api-chat-native")
    || p.nativeHostReceiptSha256 !== originalTodoRoleDigest(b)
    || p.expiresAtMs <= Date.now() || p.expiresAtMs > Date.now() + 300_000) fail();
  if ("chatId" in p && (p.actorId !== `chat:${p.chatId}` || !p.chatUrl.endsWith(`/${p.chatId}`))) fail();
  if ("item" in p && (p.itemSha256 !== originalTodoRoleDigest(p.item) || p.item.id !== p.workItemId
    || p.item.state !== "Done" || p.item.acceptanceDecision !== undefined
    || !Array.isArray(p.item.evidence) || !p.item.evidence.length || p.worker.actorId === p.reviewer.actorId)) fail();
  return payload;
}
export function parseOriginalTodoRoleDecision(method: OriginalTodoRoleMethod, value: unknown,
  payload: OriginalTodoRolePayload | OriginalTodoHumanPayload) {
  const decision = originalTodoRoleResults[method].parse(value);
  if (decision && (decision.actorId !== payload.request.actorId || decision.requestSha256 !== originalTodoRoleDigest(payload)
    || decision.epoch !== payload.request.nativeEpoch || decision.expiresAtMs <= Date.now()
    || decision.expiresAtMs > payload.request.expiresAtMs)) fail();
  return decision;
}
