import { createHash } from "node:crypto";
import { isAbsolute, resolve, sep } from "node:path";
import { z } from "zod";
import { documentPath } from "./document-path.js";
import { documentId } from "./document-read-contracts.js";
import { canonicalJson } from "./domain/project-recipes-workflow-contracts.js";

const digest = z.string().regex(/^[a-f0-9]{64}$/), uuid = z.string().uuid();
const absolute = z.string().min(1).max(4096).refine(path =>
  isAbsolute(path) && resolve(path) === path && path !== sep && !/[\u0000-\u001f\u007f]/.test(path));
export const originalRecoveryDigest = (value: unknown) =>
  createHash("sha256").update(canonicalJson(value)).digest("hex");
export const originalRecoveryPhase1Methods = Object.freeze({
  source: "knowledge.recovery.evidence.approve",
  repair: "knowledge.recovery.owner.approve",
} as const);
export const originalRecoverySignedSessionSchema = z.strictObject({
  brokerId: uuid, activationId: uuid, identitySha256: digest, epoch: uuid,
  binding: z.strictObject({
    root: absolute, workspaceId: uuid, planSha256: digest, catalogSha256: digest,
    profileSha256: digest, payloadBuildId: digest, hostEntrySha256: digest,
  }),
});
export const originalRecoveryHostBindingSchema = z.strictObject({
  schema: z.literal("pkm.original-mcp-native-host-admission/v1"),
  root: absolute, workspaceId: uuid, planSha256: digest, profileSha256: digest,
  sourceCatalogSha256: digest, authorityId: z.string().min(1).max(128), epoch: uuid,
  actorId: z.literal("mcp:external"),
  domains: z.array(z.enum(["model-provider", "tool-approval", "mcp-public", "api-chat-native"])).min(1).max(4),
  configurationSha256: digest,
});
const previewPublic = z.strictObject({
  tool: z.literal("knowledge_recovery_preview"), version: z.literal(1),
  arguments: z.strictObject({ evidence_directory: absolute }), argumentsDigest: digest,
});
const applyPublic = z.strictObject({
  tool: z.literal("knowledge_recovery_apply"), version: z.literal(1),
  arguments: z.strictObject({ evidence_directory: absolute, approved_plan_sha256: digest }), argumentsDigest: digest,
});
export const originalRecoveryPublicRequestSchema = z.discriminatedUnion("tool", [previewPublic, applyPublic]);
export const originalRecoveryIdentitySchema = z.strictObject({
  device: z.string().regex(/^\d+$/), inode: z.string().regex(/^\d+$/),
  uid: z.string().regex(/^\d+$/), mode: z.number().int().min(0).max(0o777),
  links: z.number().int().positive().max(1_000_000),
  size: z.number().int().nonnegative().max(16_777_216),
  mtime: z.string().regex(/^\d+$/), ctime: z.string().regex(/^\d+$/),
});
export const originalRecoveryFileSchema = z.strictObject({
  path: z.string(), sha256: digest, mode: z.enum(["100644", "100755"]),
  identity: originalRecoveryIdentitySchema,
});
export const originalRecoveryEvidenceSchema = z.strictObject({
  schema: z.literal("pkm.original-recovery-evidence/v1"),
  directory: absolute, directoryIdentity: originalRecoveryIdentitySchema,
  knowledgeRoot: absolute, planSha256: digest, planIdentity: originalRecoveryIdentitySchema,
  files: z.array(originalRecoveryFileSchema).length(1),
  manifestSha256: digest,
});
export const originalRecoveryRegisteredOwnerSchema = z.strictObject({
  area: z.enum(["notes", "skills"]), id: documentId, knowledgeId: z.string().min(1).max(1024),
  path: documentPath, revision: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  sha256: digest, bytes: z.number().int().positive().max(16_777_216), mode: z.enum(["100644", "100755"]),
  registrationReceiptSha256: digest, custodyPredecessorSha256: digest, indexRowSha256: digest,
  privacy: z.literal("public"), deleted: z.literal(false),
  documentKind: z.enum(["note", "skill"]),
  assets: z.array(z.string()).max(0), referrers: z.array(z.string()).max(0),
});
const sourceRequest = z.strictObject({
  schema: z.literal("pkm.original-recovery-source-request/v1"), operationId: uuid,
  nativeHostReceiptSha256: digest, publicRequest: originalRecoveryPublicRequestSchema,
});
const repairRequest = z.strictObject({
  schema: z.literal("pkm.original-recovery-repair-request/v1"), operationId: uuid,
  nativeHostReceiptSha256: digest, publicRequest: applyPublic,
  evidence: originalRecoveryEvidenceSchema, owner: originalRecoveryRegisteredOwnerSchema,
  rootIdentity: originalRecoveryIdentitySchema, parentIdentity: originalRecoveryIdentitySchema,
  ownerId: uuid, fence: z.number().int().positive(),
  repairPlanSha256: digest, auditName: z.string().regex(/^result-\d{8}T\d{12}\.json$/),
});
export const originalRecoverySourcePayloadSchema = z.strictObject({
  binding: originalRecoveryHostBindingSchema, defaultDecision: z.literal("deny"),
  request: sourceRequest, requestSha256: digest,
});
export const originalRecoveryRepairPayloadSchema = z.strictObject({
  binding: originalRecoveryHostBindingSchema, defaultDecision: z.literal("deny"),
  request: repairRequest, requestSha256: digest,
});
const decision = z.strictObject({
  decision: z.literal("approve"), actorId: z.literal("mcp:external"), decisionId: uuid,
  operationId: uuid, requestSha256: digest, epoch: uuid, expiresAtMs: z.number().int().positive(),
});
export const originalRecoverySourceResultSchema = z.strictObject({
  decision, evidence: originalRecoveryEvidenceSchema, evidenceSha256: digest,
}).nullable();
export const originalRecoveryRepairResultSchema = decision.nullable();
export type OriginalRecoveryEvidence = z.infer<typeof originalRecoveryEvidenceSchema>;
export type OriginalRecoveryRegisteredOwner = z.infer<typeof originalRecoveryRegisteredOwnerSchema>;
export type OriginalRecoverySourcePayload = z.infer<typeof originalRecoverySourcePayloadSchema>;
export type OriginalRecoveryRepairPayload = z.infer<typeof originalRecoveryRepairPayloadSchema>;
export type OriginalRecoverySignedSession = z.infer<typeof originalRecoverySignedSessionSchema>;
export type OriginalRecoveryPhase1Method = typeof originalRecoveryPhase1Methods[keyof typeof originalRecoveryPhase1Methods];
function fail(code: string): never { throw Object.assign(new Error(code), { code }); }
export function validateOriginalRecoveryEvidence(value: unknown): OriginalRecoveryEvidence {
  const evidence = originalRecoveryEvidenceSchema.parse(value), { manifestSha256, ...body } = evidence;
  const row = evidence.files[0]!, [area, ...parts] = row.path.split("/");
  if (!["notes", "skills"].includes(area!) || !documentPath.safeParse(parts.join("/")).success
    || ["system", "_assets"].includes(parts[0]?.toLowerCase() ?? "")) fail("RECOVERY_PHASE1_SCOPE_REQUIRED");
  if (evidence.planIdentity.size > 2_097_152 || evidence.planIdentity.links !== 1 || row.identity.links !== 1
    || originalRecoveryDigest(body) !== manifestSha256)
    fail("RECOVERY_EVIDENCE_BINDING_MISMATCH");
  if (evidence.directory === evidence.knowledgeRoot || evidence.directory.startsWith(evidence.knowledgeRoot + sep)
    || evidence.knowledgeRoot.startsWith(evidence.directory + sep)) fail("RECOVERY_EXTERNAL_EVIDENCE_REQUIRED");
  return evidence;
}
export function validateOriginalRecoveryRegisteredOwner(value: unknown): OriginalRecoveryRegisteredOwner {
  const owner = originalRecoveryRegisteredOwnerSchema.parse(value);
  if (["system", "_assets"].includes(owner.path.split("/")[0]?.toLowerCase() ?? "")
    || owner.documentKind !== (owner.area === "notes" ? "note" : "skill"))
    fail("RECOVERY_PHASE1_SCOPE_REQUIRED");
  return owner;
}
export function parseOriginalRecoveryPhase1Payload(method: OriginalRecoveryPhase1Method, value: unknown, signed: unknown) {
  const session = originalRecoverySignedSessionSchema.parse(signed);
  const payload = (method === originalRecoveryPhase1Methods.source ? originalRecoverySourcePayloadSchema
    : method === originalRecoveryPhase1Methods.repair ? originalRecoveryRepairPayloadSchema : z.never()).parse(value);
  const host = payload.binding, expected = session.binding, request = payload.request;
  if (session.epoch !== session.activationId || host.epoch !== session.epoch
    || host.root !== expected.root || host.workspaceId !== expected.workspaceId || host.planSha256 !== expected.planSha256
    || host.profileSha256 !== expected.profileSha256 || host.sourceCatalogSha256 !== expected.catalogSha256
    || host.authorityId !== `native-rpc:${session.brokerId}` || !host.domains.includes("mcp-public")
    || request.nativeHostReceiptSha256 !== originalRecoveryDigest(host)
    || payload.requestSha256 !== originalRecoveryDigest(request)
    || request.publicRequest.argumentsDigest !== originalRecoveryDigest(request.publicRequest.arguments))
    fail("RECOVERY_SIGNED_BINDING_MISMATCH");
  if ("evidence" in request) {
    const evidence = validateOriginalRecoveryEvidence(request.evidence), owner = validateOriginalRecoveryRegisteredOwner(request.owner);
    const row = evidence.files[0]!;
    if (evidence.knowledgeRoot !== host.root || evidence.directory !== request.publicRequest.arguments.evidence_directory
      || evidence.planSha256 !== request.publicRequest.arguments.approved_plan_sha256
      || row.path !== `${owner.area}/${owner.path}` || row.sha256 !== owner.sha256 || row.mode !== owner.mode
      || row.identity.size !== owner.bytes) fail("RECOVERY_REPAIR_BINDING_MISMATCH");
    const body = {
      schema: "pkm.original-recovery-owner-plan/v1", operationId: request.operationId, evidence, owner,
      observation: {
        root: host.root, workspaceId: host.workspaceId, nativeHostReceiptSha256: request.nativeHostReceiptSha256,
        epoch: host.epoch, ownerId: request.ownerId, fence: request.fence,
        rootIdentity: request.rootIdentity, parentIdentity: request.parentIdentity,
        owner, destination: "missing", pendingOperationIds: [],
      },
      auditName: request.auditName,
    };
    if (request.repairPlanSha256 !== originalRecoveryDigest(body)) fail("RECOVERY_REPAIR_BINDING_MISMATCH");
  }
  if (Buffer.byteLength(JSON.stringify({ session, payload })) > 49_152) fail("RECOVERY_PACKET_TOO_LARGE");
  return payload;
}
