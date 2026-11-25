import { createHash } from "node:crypto";
import { extname } from "node:path";
import { z } from "zod";
import { canonicalJson } from "./domain/project-recipes-workflow-contracts.js";
import { documentPath, knowledgeArea, resourcePath } from "./document-path.js";
import { documentLifecycleLimits } from "./document-lifecycle-contracts.js";
import { originalNativeActionPayloadSchemas, originalNativeActionSession } from "./original-mcp-native-action-contracts.js";

const digest = z.string().regex(/^[a-f0-9]{64}$/);
const binding = originalNativeActionPayloadSchemas["action.status"].shape.binding;
export const privateResourcePublicationMethod = "knowledge.asset.publish" as const;
export const privateResourcePublicationProtocol = "pkm.document-private-resource-publication/v1" as const;
export const privateResourcePublicationSubjectSchema = z.strictObject({
  root: z.string().min(1).max(4096), workspaceId: z.string().uuid(), custodyPlanSha256: digest,
  catalogSha256: digest, profileSha256: digest, actorId: z.literal("mcp:external"), operationId: z.string().uuid(),
  operation: z.enum(["knowledge.note.update", "knowledge.skill.update", "knowledge.research.update"]),
  publicRequest: z.strictObject({ tool: z.enum(["update_note", "update_skill", "update_paper"]),
    version: z.literal(1), argumentsDigest: digest }),
  canonicalArgumentsDigest: digest,
  owner: z.strictObject({ area: knowledgeArea, id: z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,79}$/),
    beforePath: documentPath, afterPath: documentPath, revision: z.number().int().positive(), sha256: digest }),
  resource: z.strictObject({ sourcePath: resourcePath, sourceIdentity: z.string().min(1).max(512),
    sha256: digest, size: z.number().int().positive().max(documentLifecycleLimits.fileBytes), targetPath: resourcePath }),
  privacySha256: digest, preservePrivateSource: z.literal(true), oneResourceOneOperation: z.literal(true),
});
export type PrivateResourcePublicationSubject = z.infer<typeof privateResourcePublicationSubjectSchema>;
export const privateResourcePublicationRequestSchema = z.strictObject({
  schema: z.literal("pkm.private-resource-publication/v1"), phase: z.enum(["publish", "recover"]),
  subject: privateResourcePublicationSubjectSchema, nativeHostReceiptSha256: digest, nativeEpoch: z.string().min(1).max(128),
});
export const privateResourcePublicationPayloadSchema = z.strictObject({
  binding, defaultDecision: z.literal("deny"), request: privateResourcePublicationRequestSchema, requestSha256: digest,
});
export const privateResourcePublicationDecisionSchema = z.strictObject({
  decision: z.literal("approve"), actorId: z.literal("mcp:external"), decisionId: z.string().uuid(),
  requestSha256: digest, operationId: z.string().uuid(), epoch: z.string().min(1).max(128),
  expiresAtMs: z.number().int().positive(),
});
export const privateResourcePublicationResultSchema = privateResourcePublicationDecisionSchema.nullable();
export const privateResourcePublicationProvenanceSchema = z.strictObject({
  subject: privateResourcePublicationSubjectSchema, decision: privateResourcePublicationDecisionSchema,
  nativeHostReceiptSha256: digest, phase: z.enum(["publish", "recover"]),
});
export type PrivateResourcePublicationProvenance = z.infer<typeof privateResourcePublicationProvenanceSchema>;
export const privateResourcePublicationDigest = (value: unknown) =>
  createHash("sha256").update(canonicalJson(value)).digest("hex");
function fail(code: string): never { throw Object.assign(new Error(code), { code }); }
export function validatePrivateResourcePublicationSubject(value: unknown): PrivateResourcePublicationSubject {
  const subject = privateResourcePublicationSubjectSchema.parse(value), { owner, resource } = subject;
  const area = subject.operation === "knowledge.note.update" ? "notes" : subject.operation === "knowledge.skill.update" ? "skills" : "papers";
  const tool = area === "notes" ? "update_note" : area === "skills" ? "update_skill" : "update_paper";
  const target = `${owner.afterPath.replace(/\.md$/i, ".assets")}/${resource.sha256.slice(0, 16)}${extname(resource.sourcePath).toLowerCase()}`;
  if (owner.area !== area || subject.publicRequest.tool !== tool || owner.beforePath === owner.afterPath
    || owner.afterPath.split("/").some(part => ["system", "_assets"].includes(part.toLowerCase()))
    || !resource.sourcePath.split("/").includes("_assets") || resource.sourcePath.split("/").some(part => /\.assets$/i.test(part))
    || resource.targetPath !== target) fail("PRIVATE_RESOURCE_PUBLICATION_SUBJECT_MISMATCH");
  return subject;
}
export function parsePrivateResourcePublicationPayload(value: unknown, signed: unknown) {
  const session = originalNativeActionSession.parse(signed), payload = privateResourcePublicationPayloadSchema.parse(value);
  const { binding: host, request } = payload, subject = validatePrivateResourcePublicationSubject(request.subject), expected = session.binding;
  if (session.epoch !== session.activationId || host.epoch !== session.epoch || request.nativeEpoch !== session.epoch
    || host.root !== expected.root || host.workspaceId !== expected.workspaceId || host.planSha256 !== expected.planSha256
    || host.profileSha256 !== expected.profileSha256 || host.sourceCatalogSha256 !== expected.catalogSha256
    || host.authorityId !== `native-rpc:${session.brokerId}` || !host.domains.includes("mcp-public")
    || subject.root !== expected.root || subject.workspaceId !== expected.workspaceId || subject.custodyPlanSha256 !== expected.planSha256
    || subject.profileSha256 !== expected.profileSha256 || subject.catalogSha256 !== expected.catalogSha256
    || request.nativeHostReceiptSha256 !== privateResourcePublicationDigest(host)
    || payload.requestSha256 !== privateResourcePublicationDigest(request))
    fail("PRIVATE_RESOURCE_PUBLICATION_BINDING_MISMATCH");
  return payload;
}
export function validatePrivateResourcePublicationProvenance(value: unknown): PrivateResourcePublicationProvenance {
  const provenance = privateResourcePublicationProvenanceSchema.parse(value), subject = validatePrivateResourcePublicationSubject(provenance.subject);
  const decision = provenance.decision, request = { schema: "pkm.private-resource-publication/v1", phase: provenance.phase,
    subject, nativeHostReceiptSha256: provenance.nativeHostReceiptSha256, nativeEpoch: decision.epoch };
  if (decision.operationId !== subject.operationId || decision.actorId !== subject.actorId || decision.requestSha256 !== privateResourcePublicationDigest(request))
    fail("PRIVATE_RESOURCE_PUBLICATION_PROVENANCE_MISMATCH");
  return provenance;
}
