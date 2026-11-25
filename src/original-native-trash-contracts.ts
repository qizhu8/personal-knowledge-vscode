import { createHash } from "node:crypto";
import { z } from "zod";
import { canonicalJson } from "./domain/project-recipes-workflow-contracts.js";
import { documentPath, resourcePath } from "./document-path.js";
import { opaqueTrashArea, opaqueTrashPath, opaqueTrashFile, opaqueTrashPair, trashCustodyArea } from "./opaque-trash-contracts.js";
import { originalNativeActionPayloadSchemas, originalNativeActionSession } from "./original-mcp-native-action-contracts.js";

const digest = z.string().regex(/^[a-f0-9]{64}$/), uuid = z.string().uuid();
const natural = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const binding = originalNativeActionPayloadSchemas["action.status"].shape.binding;
export const originalNativeTrashMethod = "knowledge.trash.approve" as const;
export const originalNativeTrashLimits = Object.freeze({ entries: 4096, bytes: 16 * 1024 * 1024, list: 64 });
export const originalNativeTrashEntryId = z.string().regex(/^[0-9]+-[a-f0-9]{10}$/);
export const originalNativeTrashIdentitySchema = z.strictObject({
  path: z.string().min(1).max(2048), kind: z.enum(["file", "directory"]),
  device: z.string().regex(/^\d+$/), inode: z.string().regex(/^\d+$/),
  mode: natural.max(0o777), uid: z.string().regex(/^\d+$/), gid: z.string().regex(/^\d+$/),
  size: z.string().regex(/^\d+$/), mtime: z.string().regex(/^\d+$/), ctime: z.string().regex(/^\d+$/),
  sha256: digest.nullable(),
});
export type OriginalNativeTrashIdentity = z.infer<typeof originalNativeTrashIdentitySchema>;
export const originalNativeTrashMetadataSchema = z.strictObject({
  id: originalNativeTrashEntryId, kind: z.literal("item"), name: z.string().min(1).max(256),
  originalPath: documentPath, deletedAt: z.string().datetime(), assetsPath: resourcePath.optional(),
});
const selection = {
  path: documentPath,
  document: z.strictObject({
    id: z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,79}$/),
    knowledgeId: z.string().min(1).max(128), revision: z.number().int().positive(),
    sha256: digest,
  }),
  entryId: originalNativeTrashEntryId,
  metadataSha256: digest,
  inventory: z.array(originalNativeTrashIdentitySchema).min(1).max(originalNativeTrashLimits.entries),
  treeSha256: digest, scanRevision: digest, readOnlyOriginalBucket: z.boolean(),
};
export const originalNativeTrashSelectionV1Schema = z.strictObject({
  ...selection, area: z.literal("notes"), metadata: originalNativeTrashMetadataSchema,
});
// v2 is a new closed area contract, never a reinterpretation of a Note v1 receipt.
export const originalNativeTrashSelectionV2Schema = z.discriminatedUnion("area", [
  z.strictObject({ ...selection, area: z.literal("skills"),
    metadata: originalNativeTrashMetadataSchema.extend({ kind: z.literal("skill") }) }),
  z.strictObject({ ...selection, area: z.literal("papers"), metadata: originalNativeTrashMetadataSchema }),
]);
export const originalNativeTrashSelectionV3Schema = z.strictObject({
  ...selection, area: opaqueTrashArea, path: opaqueTrashPath,
  file: opaqueTrashFile,
  metadata: originalNativeTrashMetadataSchema.extend({ originalPath: opaqueTrashPath }),
}).omit({ document: true });
export const originalNativeTrashSelectionSchema = z.union([
  originalNativeTrashSelectionV1Schema, originalNativeTrashSelectionV2Schema, originalNativeTrashSelectionV3Schema,
]);
export type OriginalNativeTrashSelection = z.infer<typeof originalNativeTrashSelectionSchema>;
const common = {
  root: z.string().min(1).max(4096), workspaceId: uuid, custodyPlanSha256: digest,
  catalogSha256: digest, profileSha256: digest, actorId: z.literal("mcp:external"),
  operationId: uuid, canonicalArgumentsDigest: digest, privacySha256: digest,
  sourceOriginalSha256: z.literal("1804071cb3b9fc86edc5933d5001db6ea1a8d7a9adf30d6d2b3166fcd6048f27"),
  custodyPredecessorSha256: digest, transitionSha256: digest,
  historyBeforeSha256: digest.nullable(), historyAfterSha256: digest.nullable(),
};
export const originalNativeTrashSubjectV1Schema = z.discriminatedUnion("action", [
  z.strictObject({ ...common, action: z.literal("list"), operation: z.literal("knowledge.trash.list"),
    selection: z.array(originalNativeTrashSelectionV1Schema).max(originalNativeTrashLimits.list) }),
  z.strictObject({ ...common, action: z.literal("move"), operation: z.literal("knowledge.trash.move"),
    selection: z.tuple([originalNativeTrashSelectionV1Schema]),
    publicRequest: z.strictObject({ tool: z.enum(["delete_note", "knowledge_file_trash"]), version: z.literal(1),
      argumentsDigest: digest }).optional() }),
  z.strictObject({ ...common, action: z.literal("restore"), operation: z.literal("knowledge.trash.restore"),
    selection: z.tuple([originalNativeTrashSelectionV1Schema]) }),
]);
const v2 = { ...common, area: z.enum(["skills", "papers"]) };
export const originalNativeTrashSubjectV2Schema = z.discriminatedUnion("action", [
  z.strictObject({ ...v2, action: z.literal("list"), operation: z.literal("knowledge.trash.list"),
    selection: z.array(originalNativeTrashSelectionV2Schema).max(originalNativeTrashLimits.list) }),
  z.strictObject({ ...v2, action: z.literal("move"), operation: z.literal("knowledge.trash.move"),
    selection: z.tuple([originalNativeTrashSelectionV2Schema]),
    publicRequest: z.strictObject({ tool: z.enum(["delete_skill", "delete_paper", "knowledge_file_trash"]),
      version: z.literal(1), argumentsDigest: digest }).optional() }),
  z.strictObject({ ...v2, action: z.literal("restore"), operation: z.literal("knowledge.trash.restore"),
    selection: z.tuple([originalNativeTrashSelectionV2Schema]) }),
]).refine(value => value.selection.every(item => item.area === value.area && !item.readOnlyOriginalBucket)
  && (value.action !== "move" || !value.publicRequest || value.publicRequest.tool === "knowledge_file_trash"
    || value.publicRequest.tool === (value.area === "skills" ? "delete_skill" : "delete_paper")));
export const originalNativeTrashSubjectV3Schema = z.discriminatedUnion("action", [
    z.strictObject({ ...common, area: opaqueTrashArea, action: z.literal("list"), operation: z.literal("knowledge.trash.list"),
      selection: z.array(originalNativeTrashSelectionV3Schema).max(originalNativeTrashLimits.list) }),
    z.strictObject({ ...common, area: opaqueTrashArea, action: z.literal("move"), operation: z.literal("knowledge.trash.move"),
      selection: z.tuple([originalNativeTrashSelectionV3Schema]),
      publicRequest: z.strictObject({ tool: z.literal("knowledge_file_trash"), version: z.literal(1), argumentsDigest: digest }).optional() }),
    z.strictObject({ ...common, area: opaqueTrashArea, action: z.literal("restore"), operation: z.literal("knowledge.trash.restore"),
      selection: z.tuple([originalNativeTrashSelectionV3Schema]) }),
  ]).refine(value => value.selection.every(item => item.area === value.area && !item.readOnlyOriginalBucket));
export const originalNativeTrashSubjectSchema = z.union([
  originalNativeTrashSubjectV1Schema, originalNativeTrashSubjectV2Schema, originalNativeTrashSubjectV3Schema,
]);
export type OriginalNativeTrashSubject = z.infer<typeof originalNativeTrashSubjectSchema>;
export const originalNativeTrashRequestV1Schema = z.strictObject({
  schema: z.literal("pkm.original-native-trash-request/v1"), phase: z.enum(["execute", "recover"]),
  subject: originalNativeTrashSubjectV1Schema, nativeHostReceiptSha256: digest, nativeEpoch: uuid,
});
export const originalNativeTrashRequestV2Schema = z.strictObject({
  schema: z.literal("pkm.original-native-trash-request/v2"), phase: z.enum(["execute", "recover"]),
  subject: originalNativeTrashSubjectV2Schema, nativeHostReceiptSha256: digest, nativeEpoch: uuid,
});
export const originalNativeTrashRequestV3Schema = z.strictObject({
  schema: z.literal("pkm.original-native-trash-request/v3"), phase: z.enum(["execute", "recover"]),
  subject: originalNativeTrashSubjectV3Schema, nativeHostReceiptSha256: digest, nativeEpoch: uuid,
});
export const originalNativeTrashRequestSchema = z.discriminatedUnion("schema", [
  originalNativeTrashRequestV1Schema, originalNativeTrashRequestV2Schema, originalNativeTrashRequestV3Schema,
]);
export type OriginalNativeTrashRequest = z.infer<typeof originalNativeTrashRequestSchema>;
export const originalNativeTrashPayloadSchema = z.strictObject({
  binding, defaultDecision: z.literal("deny"), request: originalNativeTrashRequestSchema, requestSha256: digest,
});
export type OriginalNativeTrashPayload = z.infer<typeof originalNativeTrashPayloadSchema>;
export const originalNativeTrashDecisionSchema = z.strictObject({
  decision: z.literal("approve"), actorId: z.literal("mcp:external"), decisionId: uuid,
  requestSha256: digest, operationId: uuid, epoch: uuid, expiresAtMs: z.number().int().positive(),
});
export const originalNativeTrashResultSchema = originalNativeTrashDecisionSchema.nullable();
export const originalNativeTrashProvenanceSchema = z.strictObject({
  request: originalNativeTrashRequestSchema, decision: originalNativeTrashDecisionSchema,
});
export type OriginalNativeTrashProvenance = z.infer<typeof originalNativeTrashProvenanceSchema>;
export const originalNativeTrashListInputSchema = z.strictObject({
  area: trashCustodyArea, entryIds: z.array(originalNativeTrashEntryId).max(originalNativeTrashLimits.list),
  operationId: uuid,
}).refine(value => new Set(value.entryIds).size === value.entryIds.length);
export const originalNativeTrashDigest = (value: unknown) =>
  createHash("sha256").update(canonicalJson(value)).digest("hex");
function fail(code: string): never { throw Object.assign(new Error(code), { code }); }
export function validateOriginalNativeTrashSubject(value: unknown): OriginalNativeTrashSubject {
  const subject = originalNativeTrashSubjectSchema.parse(value);
  if (subject.selection.length > 0 && new Set(subject.selection.map(item => item.entryId)).size !== subject.selection.length)
    fail("ORIGINAL_TRASH_SELECTION_MISMATCH");
  for (const item of subject.selection) {
    if (item.path !== item.metadata.originalPath || item.entryId !== item.metadata.id
      || item.metadata.name !== (item.area === "skills" ? item.path.split("/").at(-1)!.replace(/\.md$/i, "") : item.path.split("/").at(-1))
      || !item.readOnlyOriginalBucket && item.entryId.split("-")[0] !== String(Date.parse(item.metadata.deletedAt))
      || item.metadata.assetsPath !== undefined && item.metadata.assetsPath !== ("file" in item ? opaqueTrashPair(item.path) : item.path.replace(/\.md$/i, ".assets"))
      || item.path.split("/").some(part => ["system", "_assets", ".trash"].includes(part.toLowerCase()))
      || item.treeSha256 !== originalNativeTrashDigest(item.inventory)
      || new Set(item.inventory.map(row => row.path)).size !== item.inventory.length
      || subject.action !== "list" && item.readOnlyOriginalBucket)
      fail("ORIGINAL_TRASH_SELECTION_MISMATCH");
    if ("file" in item) {
      const source = item.inventory.find(row => row.kind === "file" && (row.path === `${item.area}/${item.path}` || row.path === `${item.area}/.trash/${item.entryId}/payload`));
      if (item.readOnlyOriginalBucket || source?.sha256 !== item.file.sha256 || Number(source?.size) !== item.file.size)
        fail("ORIGINAL_TRASH_SELECTION_MISMATCH");
    }
    if ("area" in subject && (item.area !== subject.area || item.readOnlyOriginalBucket
      || item.inventory.some(row => !row.path.startsWith(`${item.area}/`))))
      fail("ORIGINAL_TRASH_SELECTION_MISMATCH");
  }
  if ("area" in subject && subject.action === "move" && subject.publicRequest
    && subject.publicRequest.tool !== "knowledge_file_trash"
    && subject.publicRequest.tool !== (subject.area === "skills" ? "delete_skill" : "delete_paper"))
    fail("ORIGINAL_TRASH_SELECTION_MISMATCH");
  if (subject.action === "list" && subject.historyBeforeSha256 !== subject.historyAfterSha256)
    fail("ORIGINAL_TRASH_SELECTION_MISMATCH");
  return subject;
}
export function parseOriginalNativeTrashPayload(value: unknown, signed: unknown): OriginalNativeTrashPayload {
  const session = originalNativeActionSession.parse(signed), payload = originalNativeTrashPayloadSchema.parse(value);
  const { binding: host, request } = payload, subject = validateOriginalNativeTrashSubject(request.subject);
  const expected = session.binding;
  if (session.epoch !== session.activationId || host.epoch !== session.epoch || request.nativeEpoch !== session.epoch
    || host.root !== expected.root || host.workspaceId !== expected.workspaceId || host.planSha256 !== expected.planSha256
    || host.profileSha256 !== expected.profileSha256 || host.sourceCatalogSha256 !== expected.catalogSha256
    || host.authorityId !== `native-rpc:${session.brokerId}` || !host.domains.includes("mcp-public")
    || subject.root !== expected.root || subject.workspaceId !== expected.workspaceId
    || subject.custodyPlanSha256 !== expected.planSha256 || subject.catalogSha256 !== expected.catalogSha256
    || subject.profileSha256 !== expected.profileSha256
    || request.nativeHostReceiptSha256 !== originalNativeTrashDigest(host)
    || payload.requestSha256 !== originalNativeTrashDigest(request))
    fail("ORIGINAL_TRASH_BINDING_MISMATCH");
  return payload;
}
export function validateOriginalNativeTrashProvenance(value: unknown): OriginalNativeTrashProvenance {
  const provenance = originalNativeTrashProvenanceSchema.parse(value), { request, decision } = provenance;
  validateOriginalNativeTrashSubject(request.subject);
  if (decision.operationId !== request.subject.operationId || decision.actorId !== request.subject.actorId
    || decision.epoch !== request.nativeEpoch || decision.requestSha256 !== originalNativeTrashDigest(request))
    fail("ORIGINAL_TRASH_PROVENANCE_MISMATCH");
  return provenance;
}
