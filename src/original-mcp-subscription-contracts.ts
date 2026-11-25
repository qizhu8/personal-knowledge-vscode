import { z } from "zod";
import { originalNativeSourceSessionSchema, originalNativeSourcePayloadSchemas,
  originalNativeSourceRequestDigest } from "./original-mcp-native-source-contracts.js";

const digest = z.string().regex(/^[a-f0-9]{64}$/);
const identity = z.string().min(1).max(256).refine(value => !/[/\\\0]/.test(value) && ![".", ".."].includes(value));
export const originalSubscriptionTools = ["list_subscriptions", "search_subscribed_content",
  "get_subscribed_content", "get_subscribed_content_by_path"] as const;
export const originalSubscriptionReadMethod = "subscription.read.approve" as const;
export const originalSubscriptionSourceSchema = z.strictObject({
  schema: z.literal("pkm.original-subscription-read-source/v1"),
  head: digest, corpusSha256: digest,
  members: z.array(z.strictObject({
    subscriptionId: identity, nodeId: identity, shareId: identity,
    publicKeySha256: digest, providerSha256: digest, membershipSha256: digest,
    revision: z.number().int().safe().nonnegative(), collectionHash: z.string().min(1).max(2048),
  })).max(100),
});
export const originalSubscriptionReadPayload = z.strictObject({
  binding: originalNativeSourcePayloadSchemas["todo.source.approve"].shape.binding,
  source: originalSubscriptionSourceSchema,
  tool: z.enum(originalSubscriptionTools),
  arguments: z.record(z.string(), z.json()),
  argumentsSha256: digest,
  noExecution: z.literal(true),
});
export const originalSubscriptionReadDecision = z.strictObject({
  actorId: z.literal("mcp:external"), sourceSha256: digest, argumentsSha256: digest,
  decisionId: z.string().uuid(), expiresAtMs: z.number().int().safe().positive(),
}).nullable();
export type OriginalSubscriptionSource = z.infer<typeof originalSubscriptionSourceSchema>;
export type OriginalSubscriptionReadApproval = Omit<z.infer<typeof originalSubscriptionReadPayload>, "binding">;
export function parseOriginalSubscriptionReadPayload(value: unknown,
  context: z.infer<typeof originalNativeSourceSessionSchema>) {
  const session = originalNativeSourceSessionSchema.parse(context), payload = originalSubscriptionReadPayload.parse(value);
  const host = payload.binding, expected = session.binding;
  if (session.epoch !== session.activationId || host.epoch !== session.epoch || host.root !== expected.root
    || host.workspaceId !== expected.workspaceId || host.planSha256 !== expected.planSha256
    || host.profileSha256 !== expected.profileSha256 || host.sourceCatalogSha256 !== expected.catalogSha256
    || host.authorityId !== `native-rpc:${session.brokerId}` || !host.domains.includes("mcp-public")
    || originalNativeSourceRequestDigest(payload.arguments) !== payload.argumentsSha256
    || new Set(payload.source.members.map(member => member.subscriptionId)).size !== payload.source.members.length
    || new Set(payload.source.members.map(member => `${member.nodeId}/${member.shareId}`)).size !== payload.source.members.length)
    throw Object.assign(new Error("NATIVE_SUBSCRIPTION_BINDING_MISMATCH"), { code: "NATIVE_SUBSCRIPTION_BINDING_MISMATCH" });
  return payload;
}
