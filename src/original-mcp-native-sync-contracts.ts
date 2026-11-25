import { z } from "zod";
import { originalNativeActionPayloadSchemas, originalNativeActionSession } from "./original-mcp-native-action-contracts.js";
import { syncPlanHash } from "./sync-plan.js";

const digest = z.string().regex(/^[a-f0-9]{64}$/);
export const originalNativeSyncMethod = "sync.source.approve" as const;
export const originalNativeSyncDigest = syncPlanHash;
export const originalNativeSyncReviewSchema = z.strictObject({
  actorId: z.literal("mcp:external"), sessionId: z.string().uuid(),
  sourcePins: z.strictObject({ base: digest, local: digest, remote: digest }),
  sourceSha256: digest,
  entities: z.array(z.strictObject({
    type: z.enum(["packages", "servers", "recipes", "actions", "action-module-sets", "profiles"]),
    itemId: z.string().min(1).max(512),
  })).min(1).max(128),
});
export const originalNativeSyncRequestSchema = z.strictObject({
  operation: z.enum(["sync.apply.preview", "sync.apply"]),
  operationId: z.string().uuid().optional(), expectedPlanHash: digest.optional(),
  review: originalNativeSyncReviewSchema,
  publication: z.literal("local-only"),
  inventory: z.strictObject({ base: digest, local: digest, remote: digest }),
  privateMetadata: z.boolean(),
}).superRefine((request, context) => {
  if (request.operation === "sync.apply" && (!request.operationId || !request.expectedPlanHash))
    context.addIssue({ code: "custom", message: "Apply requires its exact operation and reviewed plan." });
  if (request.operation === "sync.apply.preview" && (request.operationId || request.expectedPlanHash))
    context.addIssue({ code: "custom", message: "Preview is not a mutation grant." });
  const keys = request.review.entities.map(value => JSON.stringify([value.type, value.itemId]));
  if (new Set(keys).size !== keys.length)
    context.addIssue({ code: "custom", message: "Duplicate selected source identity." });
});
export const originalNativeSyncPayloadSchema = z.strictObject({
  binding: originalNativeActionPayloadSchemas["action.status"].shape.binding,
  noExecution: z.literal(true), defaultDecision: z.literal("deny"),
  request: originalNativeSyncRequestSchema, requestSha256: digest,
});
export const originalNativeSyncResultSchema = z.strictObject({
  decision: z.literal("approve"), actorId: z.literal("mcp:external"), decisionId: z.string().uuid(),
  requestSha256: digest, epoch: z.string().uuid(), expiresAtMs: z.number().int().positive(),
}).nullable();
export function parseOriginalNativeSyncPayload(value: unknown, signed: unknown) {
  const session = originalNativeActionSession.parse(signed), payload = originalNativeSyncPayloadSchema.parse(value);
  const host = payload.binding, expected = session.binding;
  if (session.epoch !== session.activationId || host.epoch !== session.epoch
    || host.root !== expected.root || host.workspaceId !== expected.workspaceId || host.planSha256 !== expected.planSha256
    || host.profileSha256 !== expected.profileSha256 || host.sourceCatalogSha256 !== expected.catalogSha256
    || host.authorityId !== `native-rpc:${session.brokerId}` || !host.domains.includes("mcp-public")
    || payload.requestSha256 !== originalNativeSyncDigest(payload.request))
    throw new Error("NATIVE_SYNC_CURRENT_BINDING_REQUIRED");
  if (Buffer.byteLength(JSON.stringify({ method: originalNativeSyncMethod, session, payload })) > 60_000)
    throw new Error("NATIVE_SYNC_EXACT_REVIEW_EXCEEDS_PACKET_BUDGET");
  return payload;
}
