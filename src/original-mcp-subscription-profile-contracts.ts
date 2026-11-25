import { z } from "zod";
import { originalNativeSourceSessionSchema, originalNativeSourcePayloadSchemas,
  originalNativeSourceRequestDigest } from "./original-mcp-native-source-contracts.js";

const digest = z.string().regex(/^[a-f0-9]{64}$/), uuid = z.string().uuid();
const identity = z.string().min(1).max(256).regex(/^[A-Za-z0-9._:-]+$/);
const text = z.string().max(2048);
const member = z.strictObject({
  id: identity, alias: text, priority: z.enum(["normal", "high", "highest"]), brokerName: text.optional(),
  nodeId: identity, publisher: text, publisherUser: text, publisherHost: text,
  endpoint: z.string().max(8192), shareId: identity, publicKey: z.string().max(16384),
  magicLink: z.string().max(16384), revision: z.number().int().safe().nonnegative(),
  collectionHash: text, topics: z.array(text).max(100), tags: z.array(text).max(100),
  counts: z.record(text, z.number().int().safe().nonnegative()), itemCount: z.number().int().safe().nonnegative(),
  etag: text, status: z.enum(["new", "current", "updating", "offline", "error"]),
  secretProtected: z.boolean().optional(), secretSalt: text.optional(), lastChecked: text.optional(), lastUpdated: text.optional(),
  source: z.strictObject({ type: z.literal("github"), repository: text, branch: text, commit: text,
    targetId: identity.optional(), credentialTargetId: identity.optional(),
    selectedPaths: z.array(text).max(128).optional(), selectedFolders: z.array(text).max(128).optional() }).optional(),
});
export const currentSubscriptionState = z.strictObject({
  schema: z.literal(1), nodeId: identity, publicKey: z.string().max(16384),
  shares: z.array(z.never()).max(0), subscriptions: z.array(member).max(100),
});
export const currentSubscriptionPin = z.strictObject({
  path: z.string().min(1).max(2048).refine(value => value.startsWith("cache/") && !/[\0\\]/.test(value)
    && value.split("/").every(part => part && part !== "." && part !== "..")
    && !value.split("/").some(part => part === "_assets" || part.toLowerCase().endsWith(".assets"))),
  sha256: digest, size: z.number().int().safe().nonnegative().max(2 * 1024 * 1024),
});
export const currentSubscriptionProfileFile = z.strictObject({
  schema: z.literal("pkm.original-native-subscription-profile/v1"),
  root: z.string().min(1).max(4096), workspaceId: uuid, profileSha256: digest, identitySha256: digest,
  sourceEpoch: uuid, revision: z.number().int().safe().nonnegative(),
  state: currentSubscriptionState, files: z.array(currentSubscriptionPin).max(128),
});
export const currentSubscriptionManifestBody = currentSubscriptionProfileFile.extend({
  schema: z.literal("pkm.original-native-subscription-current/v1"),
  profile: z.string().min(1).max(4096), nativeEpoch: uuid, defaultEmpty: z.boolean(),
  stateFileSha256: digest.nullable(),
});
export const currentSubscriptionManifest = currentSubscriptionManifestBody.extend({ head: digest });
export const originalSubscriptionProfileMethod = "subscription.profile.current" as const;
export const originalSubscriptionProfilePayload = z.strictObject({
  binding: originalNativeSourcePayloadSchemas["todo.source.approve"].shape.binding,
  expectedHead: digest.nullable(),
});
export const originalSubscriptionProfileResult = z.strictObject({
  manifest: currentSubscriptionManifest,
  decision: z.strictObject({ decisionId: uuid, sourceSha256: digest, actorId: z.literal("mcp:external"),
    expiresAtMs: z.number().int().safe().positive() }),
});
export type CurrentSubscriptionManifest = z.infer<typeof currentSubscriptionManifest>;
export function parseOriginalSubscriptionProfilePayload(value: unknown,
  context: z.infer<typeof originalNativeSourceSessionSchema>) {
  const session = originalNativeSourceSessionSchema.parse(context), payload = originalSubscriptionProfilePayload.parse(value);
  const host = payload.binding, expected = session.binding;
  if (session.epoch !== session.activationId || host.epoch !== session.epoch || host.root !== expected.root
    || host.workspaceId !== expected.workspaceId || host.planSha256 !== expected.planSha256
    || host.profileSha256 !== expected.profileSha256 || host.sourceCatalogSha256 !== expected.catalogSha256
    || host.authorityId !== `native-rpc:${session.brokerId}` || !host.domains.includes("mcp-public"))
    throw Object.assign(new Error("NATIVE_SUBSCRIPTION_PROFILE_BINDING_MISMATCH"), { code: "NATIVE_SUBSCRIPTION_PROFILE_BINDING_MISMATCH" });
  return payload;
}
export function verifyCurrentSubscriptionManifest(value: unknown): CurrentSubscriptionManifest {
  const manifest = currentSubscriptionManifest.parse(value), { head, ...body } = manifest;
  if (head !== originalNativeSourceRequestDigest(body)
    || new Set(manifest.files.map(file => file.path)).size !== manifest.files.length
    || new Set(manifest.state.subscriptions.map(member => member.id)).size !== manifest.state.subscriptions.length
    || new Set(manifest.state.subscriptions.map(member => `${member.nodeId}/${member.shareId}`)).size !== manifest.state.subscriptions.length
    || manifest.files.reduce((sum, file) => sum + file.size, 0) > 8 * 1024 * 1024
    || manifest.defaultEmpty && (manifest.stateFileSha256 !== null || manifest.files.length || manifest.state.subscriptions.length))
    throw Object.assign(new Error("NATIVE_SUBSCRIPTION_PROFILE_INVALID"), { code: "NATIVE_SUBSCRIPTION_PROFILE_INVALID" });
  return manifest;
}
