import { z } from "zod";
import { originalNativeRoomDigest, originalNativeRoomSessionSchema,
  type OriginalNativeRoomSession } from "./original-mcp-native-room-contracts.js";
import { originalNativeActionPayloadSchemas } from "./original-mcp-native-action-contracts.js";

const digest = z.string().regex(/^[a-f0-9]{64}$/), id = z.string().min(1).max(128);
const stamp = z.number().int().nonnegative();
/** Unchanged original public chat_join input. Raw values are transient native-ingress data, never Core call arguments. */
export const originalRoomPublicJoinArguments = z.strictObject({ magic_link: z.string(), name: z.string() });
export const originalRoomUserLinkIntentSchema = z.strictObject({
  schema: z.literal("pkm.original-room-user-link/v1"),
  argumentsSha256: digest, magicLinkSha256: digest, suppliedNameSha256: digest,
  endpoint: z.string().max(128), requestedEndpoint: z.string().max(128).nullable(),
  requestedRoomId: z.string().regex(/^[A-Za-z0-9_-]{6,80}$/).nullable(),
  parseStatus: z.enum(["recognized", "unresolved"]),
});
export const originalRoomLoopbackSelection = z.strictObject({
  port: z.number().int().min(1024).max(65535),
  alias: z.string().trim().min(1).max(60).refine(value => !/[\u0000-\u001f\u007f]/.test(value)),
  postText: z.string().trim().min(1).max(8000).refine(value => !value.startsWith("/")),
});
export const originalRoomSessionEffectSchema = z.strictObject({
  schema: z.literal("pkm.original-native-room-loopback-effect/v1"), sessionId: z.string().uuid(),
  root: z.string().min(1).max(4096), workspaceId: z.string().uuid(), profileSha256: digest,
  custodyPlanSha256: digest, nativeEpoch: z.string().uuid(), nativeHostReceiptSha256: digest,
  roomId: z.string().regex(/^[A-Za-z0-9_-]{6,80}$/), sourceSha256: digest, sourceFingerprint: digest,
  hostParticipantId: id.nullable(), hostCredentialHash: digest, joinSecretHash: digest,
  currentHostProofExpiresAtMs: stamp, endpoint: z.string().max(128), selection: originalRoomLoopbackSelection,
  maxClients: z.literal(1), maxPosts: z.literal(1), temporaryParticipant: z.literal(true),
  participantPolicy: z.literal("new-agent-only-no-rebind"),
  clientPolicy: z.literal("original-producer-progress-post-no-commands"),
  noRemote: z.literal(true), noHostReassignment: z.literal(true), noCredentialExport: z.literal(true),
  expiresAtMs: stamp,
}).superRefine((value, context) => {
  if (value.endpoint !== `ws://127.0.0.1:${value.selection.port}` || value.expiresAtMs > value.currentHostProofExpiresAtMs)
    context.addIssue({ code: "custom", message: "Exact loopback/current Host binding required." });
});
export type OriginalRoomSessionEffect = z.infer<typeof originalRoomSessionEffectSchema>;
export const roomSessionProofSchema = z.strictObject({
  schema: z.literal("pkm.original-native-room-persistence/v1"), sessionId: z.string().uuid(),
  socketPath: z.string().min(1).max(103), transportToken: z.string().regex(/^[a-f0-9]{64}$/), effectSha256: digest,
});
const join = z.strictObject({
  requestId: id, alias: z.string().min(1).max(60), aliasKey: z.string().max(200).optional(),
  clientKey: id, kind: z.literal("agent"), temporary: z.boolean().optional(), requestedAt: stamp, expiresAt: stamp,
});
const resolution = z.strictObject({
  requestId: id, outcome: z.enum(["new", "reuse", "reject", "timeout", "cancel"]),
  participantId: id.optional(), resolvedAt: stamp, reason: z.string().max(4096).optional(),
});
const message = z.strictObject({
  id, participantId: id.optional(), aliasAtSend: z.string().max(200), senderKind: z.string().max(80),
  messageType: z.string().max(80), content: z.string().max(100000),
  metadata: z.record(z.string(), z.json()).nullable().optional(), createdAt: stamp,
});
export const originalRoomSessionClientCallSchema = z.discriminatedUnion("tool", [
  z.strictObject({ tool: z.literal("chat_join"), arguments: z.strictObject({ name: z.string() }),
    userLink: originalRoomUserLinkIntentSchema.optional() }),
  z.strictObject({ tool: z.literal("chat_read"), arguments: z.strictObject({
    name: z.string().optional(), limit: z.number().int().optional(), only_new: z.boolean().optional() }) }),
  z.strictObject({ tool: z.literal("chat_post"), arguments: z.strictObject({
    name: z.string().optional(), text: z.string().min(1).max(8000), continue_working: z.literal(true),
    require_reply: z.literal(false), final_topic_summary: z.literal(false).optional() }) }),
  z.strictObject({ tool: z.literal("chat_leave"), arguments: z.strictObject({ name: z.string().optional() }) }),
  z.strictObject({ tool: z.literal("chat_status"), arguments: z.strictObject({ name: z.string().optional() }) }),
]);
export const roomSessionOperationSchema = z.discriminatedUnion("operation", [
  z.strictObject({ operation: z.literal("room.activate") }),
  z.strictObject({ operation: z.literal("room.snapshot") }),
  z.strictObject({ operation: z.literal("session.watch") }),
  z.strictObject({ operation: z.literal("identity.read") }),
  z.strictObject({ operation: z.literal("join.request"), request: join }),
  z.strictObject({ operation: z.literal("join.resolve"), resolution }),
  z.strictObject({ operation: z.literal("alias.release"), participantId: id, at: stamp, alias: z.string().optional() }),
  z.strictObject({ operation: z.literal("participant.forget"), participantId: id, at: stamp }),
  z.strictObject({ operation: z.literal("message.append"), message }),
  z.strictObject({ operation: z.literal("room.close") }),
  z.strictObject({ operation: z.literal("client.begin"), callId: z.string().uuid(), call: originalRoomSessionClientCallSchema }),
  z.strictObject({ operation: z.literal("client.complete"), callId: z.string().uuid(), result: z.string().max(60000),
    cursorBefore: z.number().int().nonnegative(), cursorAfter: z.number().int().nonnegative() }),
]);
export type RoomSessionOperation = z.infer<typeof roomSessionOperationSchema>;
export const roomSessionRequestSchema = z.strictObject({
  sessionId: z.string().uuid(), transportToken: z.string().regex(/^[a-f0-9]{64}$/),
  operationId: z.string().uuid(), body: roomSessionOperationSchema, requestSha256: digest,
});
export const originalRoomSessionDigest = originalNativeRoomDigest;

const binding = originalNativeActionPayloadSchemas["action.status"].shape.binding;
export const originalRoomSessionNativeMethods = Object.freeze(["room.session.open", "room.session.invoke", "room.session.close"] as const);
export const originalRoomUserLinkNativeMethods = Object.freeze(["room.session.join"] as const);
export const originalRoomSessionNativePayloads = Object.freeze({
  "room.session.open": z.strictObject({ binding, effect: originalRoomSessionEffectSchema, persistence: roomSessionProofSchema }),
  "room.session.invoke": z.strictObject({ binding, sessionId: z.string().uuid(), effectSha256: digest,
    callId: z.string().uuid(), call: originalRoomSessionClientCallSchema }),
  "room.session.join": z.strictObject({ binding, sessionId: z.string().uuid(), effectSha256: digest,
    callId: z.string().uuid(), arguments: originalRoomPublicJoinArguments, intent: originalRoomUserLinkIntentSchema }),
  "room.session.close": z.strictObject({ binding, sessionId: z.string().uuid(), effectSha256: digest }),
});
export const originalRoomSessionNativeResults = Object.freeze({
  "room.session.open": z.strictObject({ sessionId: z.string().uuid(), effectSha256: digest,
    endpoint: z.string().max(128), alias: z.string().min(1).max(60), expiresAtMs: stamp }),
  "room.session.invoke": z.strictObject({ result: z.string().max(60000) }),
  "room.session.join": z.strictObject({ result: z.string().max(60000) }),
  "room.session.close": z.strictObject({ closed: z.literal(true) }),
});
export type OriginalRoomSessionNativeMethod = typeof originalRoomSessionNativeMethods[number] | typeof originalRoomUserLinkNativeMethods[number];
export type OriginalRoomSessionNativePayload<M extends OriginalRoomSessionNativeMethod> =
  z.infer<typeof originalRoomSessionNativePayloads[M]>;
export function isOriginalRoomSessionNativeMethod(value: unknown): value is OriginalRoomSessionNativeMethod {
  return typeof value === "string" && [...originalRoomSessionNativeMethods, ...originalRoomUserLinkNativeMethods].some(method => method === value);
}
export function parseOriginalRoomSessionNativePayload<M extends OriginalRoomSessionNativeMethod>(
  method: M, input: unknown, context: OriginalNativeRoomSession): OriginalRoomSessionNativePayload<M> {
  const session = originalNativeRoomSessionSchema.parse(context), payload = originalRoomSessionNativePayloads[method].parse(input);
  const host = payload.binding, expected = session.binding;
  if (session.epoch !== session.activationId || host.epoch !== session.activationId || host.root !== expected.root
    || host.workspaceId !== expected.workspaceId || host.planSha256 !== expected.planSha256
    || host.profileSha256 !== expected.profileSha256 || host.sourceCatalogSha256 !== expected.catalogSha256
    || host.authorityId !== `native-rpc:${session.brokerId}` || !host.domains.includes("mcp-public"))
    throw Object.assign(new Error("ROOM_SESSION_NATIVE_BINDING_REQUIRED"), { code: "ROOM_SESSION_NATIVE_BINDING_REQUIRED" });
  if ("effect" in payload) {
    const effect = payload.effect, descriptor = payload.persistence;
    if (effect.root !== host.root || effect.workspaceId !== host.workspaceId || effect.profileSha256 !== host.profileSha256
      || effect.custodyPlanSha256 !== host.planSha256 || effect.nativeEpoch !== host.epoch
      || effect.nativeHostReceiptSha256 !== originalRoomSessionDigest(host) || descriptor.sessionId !== effect.sessionId
      || descriptor.effectSha256 !== originalRoomSessionDigest(effect))
      throw Object.assign(new Error("ROOM_SESSION_NATIVE_EFFECT_BINDING_REQUIRED"), { code: "ROOM_SESSION_NATIVE_EFFECT_BINDING_REQUIRED" });
  }
  return payload as OriginalRoomSessionNativePayload<M>;
}
