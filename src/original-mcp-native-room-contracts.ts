import { createHash } from "node:crypto";
import { z } from "zod";
import { canonicalJson } from "./domain/project-recipes-workflow-contracts.js";
import { originalNativeActionSession, originalNativeActionPayloadSchemas } from "./original-mcp-native-action-contracts.js";

const digest = z.string().regex(/^[a-f0-9]{64}$/);
const identity = z.string().min(1).max(256);
const binding = originalNativeActionPayloadSchemas["action.status"].shape.binding;
export const originalNativeRoomSessionSchema = originalNativeActionSession;
export type OriginalNativeRoomSession = z.infer<typeof originalNativeRoomSessionSchema>;
export const originalNativeRoomMethods = Object.freeze(["room.source.approve", "room.host.prove", "room.status.read"] as const);
export type OriginalNativeRoomMethod = typeof originalNativeRoomMethods[number];
export const originalNativeRoomSourceSchema = z.strictObject({
  schema: z.literal("pkm.original-native-room-source/v1"),
  root: z.string().min(1).max(4096), workspaceId: z.string().uuid(),
  custodyPlanSha256: digest, profileSha256: digest, nativeHostReceiptSha256: digest,
  roomId: z.string().regex(/^[A-Za-z0-9_-]{6,80}$/), roomName: z.string().min(1).max(120),
  sourceFingerprint: digest, meetingSha256: digest, participantSha256: digest,
  ownerInstallationId: identity, hostParticipantId: identity.nullable(),
  projectId: identity.nullable(), threadId: identity.nullable(),
  hostCredentialHash: digest, joinSecretHash: digest,
  messages: z.number().int().min(0).max(9998), participants: z.number().int().min(0).max(64),
  meetings: z.number().int().min(0).max(5000), privateNotes: z.number().int().min(0).max(5000),
  files: z.array(z.strictObject({ path: z.string().min(1).max(4096), sha256: digest })).min(1).max(10004),
  sourceSha256: digest,
});
export type OriginalNativeRoomSource = z.infer<typeof originalNativeRoomSourceSchema>;
export const originalNativeRoomStatusArguments = z.strictObject({ name: z.string().optional() });
const hostProof = z.strictObject({ timestamp: z.number().int().nonnegative(),
  nonce: z.string().regex(/^[A-Za-z0-9_-]{16,128}$/), signature: z.string().regex(/^[A-Za-z0-9_-]{43}$/) });
export const originalNativeRoomPayloadSchemas = Object.freeze({
  "room.source.approve": z.strictObject({ binding, source: originalNativeRoomSourceSchema, noExecution: z.literal(true) }),
  "room.host.prove": z.strictObject({ binding, source: originalNativeRoomSourceSchema,
    sourceDecisionId: z.string().uuid(), challenge: z.string().uuid(), noExecution: z.literal(true) }),
  "room.status.read": z.strictObject({ binding, source: originalNativeRoomSourceSchema,
    sourceDecisionId: z.string().uuid(), hostChallenge: z.string().uuid(), challenge: z.string().uuid(),
    operation: z.literal("mcp.tool.chat_status"), arguments: originalNativeRoomStatusArguments, argumentsSha256: digest,
    noNetwork: z.literal(true), noRehost: z.literal(true), noParticipantChange: z.literal(true) }),
});
export const originalNativeRoomResultSchemas = Object.freeze({
  "room.source.approve": z.strictObject({ decisionId: z.string().uuid(), expiresAtMs: z.number().int().positive() }).nullable(),
  "room.host.prove": z.strictObject({
    challenge: z.string().uuid(), sourceDecisionId: z.string().uuid(), sourceSha256: digest,
    hostParticipantId: identity.nullable(), hostCredentialHash: digest, joinSecretHash: digest,
    proof: hostProof,
  }).nullable(),
  "room.status.read": z.strictObject({ challenge: z.string().uuid(), hostChallenge: z.string().uuid(),
    sourceDecisionId: z.string().uuid(), sourceSha256: digest, argumentsSha256: digest, resultSha256: digest,
    result: z.strictObject({ result: z.string().max(65536) }), proof: hostProof }).nullable(),
});
export type OriginalNativeRoomPayload<M extends OriginalNativeRoomMethod> = z.infer<typeof originalNativeRoomPayloadSchemas[M]>;
export const originalNativeRoomDigest = (value: unknown) => createHash("sha256").update(canonicalJson(value)).digest("hex");
export function originalNativeRoomHostPurpose(payload: OriginalNativeRoomPayload<"room.host.prove">): string {
  return `native-room-host:${originalNativeRoomDigest(payload)}`;
}
export function originalNativeRoomStatusPurpose(payload: OriginalNativeRoomPayload<"room.status.read">,
  result: { result: string }): string {
  return `native-room-status:${originalNativeRoomDigest(payload)}:${originalNativeRoomDigest(result)}`;
}
function fail(code: string): never { throw Object.assign(new Error(code), { code }); }
export function isOriginalNativeRoomMethod(value: unknown): value is OriginalNativeRoomMethod {
  return typeof value === "string" && originalNativeRoomMethods.some(method => method === value);
}
export function parseOriginalNativeRoomPayload<M extends OriginalNativeRoomMethod>(method: M, value: unknown,
  context: OriginalNativeRoomSession): OriginalNativeRoomPayload<M> {
  const session = originalNativeRoomSessionSchema.parse(context), payload = originalNativeRoomPayloadSchemas[method].parse(value);
  const host = payload.binding, expected = session.binding, source = payload.source;
  if (session.epoch !== session.activationId || host.epoch !== session.epoch || host.root !== expected.root
    || host.workspaceId !== expected.workspaceId || host.planSha256 !== expected.planSha256
    || host.profileSha256 !== expected.profileSha256 || host.sourceCatalogSha256 !== expected.catalogSha256
    || host.authorityId !== `native-rpc:${session.brokerId}` || !host.domains.includes("mcp-public")
    || source.root !== expected.root || source.workspaceId !== expected.workspaceId
    || source.custodyPlanSha256 !== expected.planSha256 || source.profileSha256 !== expected.profileSha256
    || source.nativeHostReceiptSha256 !== originalNativeRoomDigest(host))
    fail("NATIVE_ROOM_BINDING_MISMATCH");
  const { sourceSha256, ...body } = source;
  if (originalNativeRoomDigest(body) !== sourceSha256) fail("NATIVE_ROOM_SOURCE_CHANGED");
  if (new Set(source.files.map(file => file.path)).size !== source.files.length
    || source.files.some(file => !file.path.startsWith(`chatrooms/${source.roomId}/`) && !file.path.startsWith("notes/Chatroom Meetings/")
      || file.path.includes("\\") || file.path.split("/").some(part => !part || part === "." || part === "..")))
    fail("NATIVE_ROOM_SOURCE_PATH_INVALID");
  if ("operation" in payload && originalNativeRoomDigest(payload.arguments) !== payload.argumentsSha256)
    fail("NATIVE_ROOM_ARGUMENTS_CHANGED");
  return payload as OriginalNativeRoomPayload<M>;
}
export function assertOriginalNativeRoomPacketBudget(method: OriginalNativeRoomMethod, payload: unknown,
  session: OriginalNativeRoomSession, requestId = "00000000-0000-4000-8000-000000000000"): void {
  const bytes = Buffer.byteLength(JSON.stringify({ type: "native-request", protocol: "pkm.original-mcp-native-request/v1",
    requestId, session, method, payload, requestDigest: "0".repeat(64) }) + "\n");
  if (bytes > 65536) throw Object.assign(new Error(
    "NATIVE_REQUEST_TOO_LARGE: exact Room source exceeds the signed packet budget; chunked Room consent is not implemented."),
  { code: "NATIVE_REQUEST_TOO_LARGE", requiredBytes: bytes, maximumBytes: 65536 });
}
