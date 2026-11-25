import { z } from "zod";
import { originalNativeSourceSessionSchema, originalNativeSourceRequestDigest } from "./original-mcp-native-source-contracts.js";
import { originalNativeActionPayloadSchemas } from "./original-mcp-native-action-contracts.js";

const digest = z.string().regex(/^[a-f0-9]{64}$/), text = z.string().min(1).max(256);
const boardSlug = z.string().min(1).max(1024).refine(value =>
  value.split("/").every(part => !!part && !part.startsWith(".") && !/[\\:\u0000-\u001f]/u.test(part)));
export const originalNativeTodoWorkerSessionSchema = originalNativeSourceSessionSchema;
export type OriginalNativeTodoWorkerSession = z.infer<typeof originalNativeTodoWorkerSessionSchema>;
export const originalNativeTodoWorkerMethods = Object.freeze(["todo.worker.enroll"] as const);
export type OriginalNativeTodoWorkerMethod = typeof originalNativeTodoWorkerMethods[number];
export function isOriginalNativeTodoWorkerMethod(value: unknown): value is OriginalNativeTodoWorkerMethod {
  return value === "todo.worker.enroll";
}
export const originalTodoWorkerRequestSchema = z.strictObject({
  schema: z.literal("pkm.original-mcp-todo-worker-request/v1"), root: z.string().min(1).max(4096),
  workspaceId: z.string().uuid(), nativeHostReceiptSha256: digest, intentSha256: digest, boardSlug,
  actorId: z.string().regex(/^external:(?:copilot|claude|other):[a-zA-Z0-9_-]{1,80}$/),
  tokenSha256: digest, boardDigest: digest,
});
export const originalNativeTodoWorkerInputSchema = originalTodoWorkerRequestSchema.pick({ boardSlug: true, actorId: true });
export const originalNativeTodoWorkerPayloadSchemas = Object.freeze({
  "todo.worker.enroll": z.strictObject({
    binding: originalNativeActionPayloadSchemas["action.status"].shape.binding,
    request: originalTodoWorkerRequestSchema,
    custodyPlanSha256: digest, profileSha256: digest, epoch: z.string().uuid(),
    sourceSha256: digest, sessionDecisionId: text, sessionExpiresAtMs: z.number().safe().int().positive(),
    noExecution: z.literal(true), noLegacyTokenInheritance: z.literal(true),
  }),
});
export const originalTodoWorkerApprovalSchema = z.strictObject({
  actorId: originalTodoWorkerRequestSchema.shape.actorId,
  decisionId: text, expiresAtMs: z.number().safe().int().positive(),
});
export const originalNativeTodoWorkerDecisionSchema = originalTodoWorkerApprovalSchema.extend({
  schema: z.literal("pkm.original-mcp-native-todo-worker-decision/v1"),
  requestSha256: digest, epoch: z.string().uuid(), sessionDecisionId: text,
});
export const originalNativeTodoWorkerResultSchemas = Object.freeze({
  "todo.worker.enroll": originalNativeTodoWorkerDecisionSchema.nullable(),
});
export type OriginalNativeTodoWorkerPayload = z.infer<typeof originalNativeTodoWorkerPayloadSchemas["todo.worker.enroll"]>;
export const originalNativeTodoWorkerDigest = originalNativeSourceRequestDigest;
function fail(code: string): never { throw Object.assign(new Error(code), { code }); }

export function parseOriginalNativeTodoWorkerPayload(method: OriginalNativeTodoWorkerMethod, value: unknown,
  context: OriginalNativeTodoWorkerSession): OriginalNativeTodoWorkerPayload {
  const session = originalNativeTodoWorkerSessionSchema.parse(context);
  const payload = originalNativeTodoWorkerPayloadSchemas[method].parse(value), host = payload.binding, request = payload.request;
  const signed = session.binding;
  if (session.epoch !== session.activationId || payload.epoch !== session.epoch || host.epoch !== session.epoch
    || host.authorityId !== `native-rpc:${session.brokerId}` || !host.domains.includes("mcp-public")
    || host.root !== signed.root || host.workspaceId !== signed.workspaceId || host.planSha256 !== signed.planSha256
    || host.profileSha256 !== signed.profileSha256 || host.sourceCatalogSha256 !== signed.catalogSha256
    || request.root !== signed.root || request.workspaceId !== signed.workspaceId
    || request.nativeHostReceiptSha256 !== originalNativeTodoWorkerDigest(host)
    || payload.custodyPlanSha256 !== signed.planSha256 || payload.profileSha256 !== signed.profileSha256)
    fail("NATIVE_TODO_WORKER_BINDING_MISMATCH");
  if (payload.sessionExpiresAtMs <= Date.now() || payload.sessionExpiresAtMs > Date.now() + 30 * 60_000)
    fail("NATIVE_TODO_WORKER_SOURCE_EXPIRED");
  return payload;
}

export function parseOriginalNativeTodoWorkerDecision(value: unknown, payload: OriginalNativeTodoWorkerPayload) {
  const decision = originalNativeTodoWorkerResultSchemas["todo.worker.enroll"].parse(value);
  if (decision && (decision.actorId !== payload.request.actorId || decision.requestSha256 !== originalNativeTodoWorkerDigest(payload)
    || decision.epoch !== payload.epoch || decision.sessionDecisionId !== payload.sessionDecisionId
    || decision.expiresAtMs <= Date.now() || decision.expiresAtMs > payload.sessionExpiresAtMs
    || decision.expiresAtMs > Date.now() + 300_000))
    fail("NATIVE_TODO_WORKER_DECISION_MISMATCH");
  return decision;
}
