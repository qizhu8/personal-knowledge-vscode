import { createHash } from "node:crypto";
import { z } from "zod";
import { canonicalJson } from "./domain/project-recipes-workflow-contracts.js";
import { originalNativeActionPayloadSchemas, originalNativeActionSession } from "./original-mcp-native-action-contracts.js";

const digest = z.string().regex(/^[a-f0-9]{64}$/), uuid = z.string().uuid();
const segment = z.string().min(1).max(128).refine(value => value === value.trim()
  && !/[\\/:*?"<>|\u0000-\u001f\u007f]/u.test(value) && !value.startsWith(".") && !/[. ]$/.test(value)
  && !["system", "_assets", ".trash"].includes(value.toLowerCase())
  && !/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(value));
export const originalMcpTodoGenesisArgumentsSchema = z.strictObject({
  title: segment, category: z.union([z.literal(""), segment]).default(""),
});
export const originalMcpTodoGenesisMethod = "todo.board.create.approve" as const;
export const originalMcpTodoGenesisSessionSchema = originalNativeActionSession;
export const originalMcpTodoGenesisDirectorySchema = z.strictObject({
  path: z.string().min(1).max(2048), device: z.string().regex(/^\d+$/), inode: z.string().regex(/^\d+$/),
  uid: z.string().regex(/^\d+$/), mode: z.number().int().min(0).max(0o777),
});
export const originalMcpTodoGenesisManagedAncestorSchema = z.discriminatedUnion("state", [
  z.strictObject({ path: z.string(), state: z.literal("absent") }),
  z.strictObject({ path: z.string(), state: z.literal("present"), identity: originalMcpTodoGenesisDirectorySchema }),
]);
export const originalMcpTodoGenesisFilesystemIdentitySchema = z.strictObject({
  path: z.string(), kind: z.enum(["file", "directory"]), device: z.string().regex(/^\d+$/),
  inode: z.string().regex(/^\d+$/), uid: z.string().regex(/^\d+$/), mode: z.number().int().min(0).max(0o777),
  sha256: digest.nullable(),
});
export type OriginalMcpTodoGenesisFilesystemIdentity = z.infer<typeof originalMcpTodoGenesisFilesystemIdentitySchema>;
const target = z.discriminatedUnion("state", [
  z.strictObject({ state: z.literal("absent") }),
  z.strictObject({ state: z.literal("present"), sha256: digest }),
]);
export const originalMcpTodoGenesisSelectionSchema = z.strictObject({
  boardSlug: z.string().min(1).max(257), sourceId: uuid,
  documentId: z.string().regex(/^board-[a-f0-9-]{36}$/), knowledgeId: z.string().regex(/^knowledge_[a-f0-9]{24}$/),
  notePath: z.string().min(1).max(2048), pairPath: z.string().min(1).max(2048),
  backingPath: z.string().min(1).max(2048), canonicalBoardPath: z.string().min(1).max(2048),
  descriptorSha256: digest, backingSha256: digest,
  layout: z.literal("pkm.original-todo-genesis/v1"),
  expectedBefore: z.strictObject({ note: target, pair: target, backing: target, canonicalBoard: target, canonicalDirectory: target,
    sourceIndex: z.enum(["absent", "present"]) }),
  ancestors: z.array(originalMcpTodoGenesisDirectorySchema).min(2).max(8),
  managedAncestors: z.array(originalMcpTodoGenesisManagedAncestorSchema).min(1).max(2).optional(),
});
export const originalMcpTodoGenesisRequestSchema = z.strictObject({
  schema: z.literal("pkm.original-mcp-todo-genesis-request/v1"), phase: z.enum(["create", "recover", "activate-source"]),
  operation: z.literal("mcp.tool.todo_board_create"), operationId: uuid, actorId: z.literal("mcp:external"),
  root: z.string().min(1).max(4096), workspaceId: uuid, profileSha256: digest, custodyPlanSha256: digest,
  catalogSha256: digest, nativeHostReceiptSha256: digest, nativeEpoch: uuid,
  arguments: originalMcpTodoGenesisArgumentsSchema, argumentsSha256: digest, privacySha256: digest,
  selection: originalMcpTodoGenesisSelectionSchema,
  noExecution: z.literal(true), noWorkerEnrollment: z.literal(true), noReviewerDelegation: z.literal(true),
});
export type OriginalMcpTodoGenesisRequest = z.infer<typeof originalMcpTodoGenesisRequestSchema>;
export const originalMcpTodoGenesisPayloadSchema = z.strictObject({
  binding: originalNativeActionPayloadSchemas["action.status"].shape.binding,
  defaultDecision: z.literal("deny"), request: originalMcpTodoGenesisRequestSchema, requestSha256: digest,
});
export const originalMcpTodoGenesisDecisionSchema = z.strictObject({
  decision: z.literal("approve"), actorId: z.literal("mcp:external"), decisionId: uuid,
  requestSha256: digest, operationId: uuid, epoch: uuid, expiresAtMs: z.number().int().positive(),
});
export const originalMcpTodoGenesisResultSchema = originalMcpTodoGenesisDecisionSchema.nullable();
export const originalMcpTodoGenesisProvenanceSchema = z.strictObject({
  request: originalMcpTodoGenesisRequestSchema, decision: originalMcpTodoGenesisDecisionSchema,
});
export type OriginalMcpTodoGenesisProvenance = z.infer<typeof originalMcpTodoGenesisProvenanceSchema>;
export const originalMcpTodoGenesisPlanSchema = z.strictObject({
  request: originalMcpTodoGenesisRequestSchema, descriptor: z.string().max(131072), backing: z.string().max(2097152),
  planSha256: digest,
});
export type OriginalMcpTodoGenesisPlan = z.infer<typeof originalMcpTodoGenesisPlanSchema>;
export const originalMcpTodoGenesisRequestDigest = (value: unknown) =>
  createHash("sha256").update(canonicalJson(value)).digest("hex");
export const originalMcpTodoGenesisBytesDigest = (value: string | Uint8Array) =>
  createHash("sha256").update(value).digest("hex");
function fail(code: string): never { throw Object.assign(new Error(code), { code }); }
export function validateOriginalMcpTodoGenesisRequest(value: unknown): OriginalMcpTodoGenesisRequest {
  const request = originalMcpTodoGenesisRequestSchema.parse(value), selection = request.selection;
  const slug = request.arguments.category ? `${request.arguments.category}/${request.arguments.title}` : request.arguments.title;
  const expectedPaths = {
    notePath: `notes/${slug}.md`, pairPath: `notes/${slug}.assets`,
    backingPath: `notes/${slug}.assets/pkm-todo-board.json`,
    canonicalBoardPath: `.pkm-next-todo/${slug}/pkm-todo-board.json`,
  };
  if (selection.boardSlug !== slug || selection.documentId !== `board-${request.operationId}`
    || Object.entries(expectedPaths).some(([key, path]) => selection[key as keyof typeof expectedPaths] !== path)
    || request.argumentsSha256 !== originalMcpTodoGenesisRequestDigest(request.arguments)
    || new Set(selection.ancestors.map(item => item.path)).size !== selection.ancestors.length
    || selection.ancestors.some(item => ![".", "notes", ".pkm-next-todo",
      ...(request.arguments.category ? [`notes/${request.arguments.category}`, `.pkm-next-todo/${request.arguments.category}`] : [])].includes(item.path))
    || !selection.ancestors.some(item => item.path === ".") || !selection.ancestors.some(item => item.path === "notes"))
    fail("TODO_GENESIS_SELECTION_MISMATCH");
  const managed = [".pkm-next-todo", ...(request.arguments.category ? [`.pkm-next-todo/${request.arguments.category}`] : [])];
  if (selection.managedAncestors && (selection.managedAncestors.length !== managed.length
    || selection.managedAncestors.some((item, index) => item.path !== managed[index]
      || item.state === "present" && item.identity.path !== item.path)))
    fail("TODO_GENESIS_SELECTION_MISMATCH");
  if (!selection.managedAncestors && managed.some(path => !selection.ancestors.some(item => item.path === path)))
    fail("TODO_GENESIS_NAMESPACE_PIN_REQUIRED");
  if (request.arguments.category && !selection.ancestors.some(item => item.path === `notes/${request.arguments.category}`))
    fail("TODO_GENESIS_EXISTING_CATEGORY_REQUIRED");
  const before = selection.expectedBefore;
  if (request.phase === "create" && (before.sourceIndex !== "absent"
    || [before.note, before.pair, before.backing, before.canonicalBoard, before.canonicalDirectory].some(item => item.state !== "absent")))
    fail("TODO_GENESIS_ABSENCE_REQUIRED");
  if (request.phase === "activate-source" && (before.sourceIndex !== "present"
    || [before.note, before.pair, before.backing, before.canonicalBoard, before.canonicalDirectory].some(item => item.state !== "present")))
    fail("TODO_GENESIS_SOURCE_REQUIRED");
  for (const [item, expected] of [[before.note, selection.descriptorSha256],
    [before.backing, selection.backingSha256]] as const)
    if (item.state === "present" && item.sha256 !== expected) fail("TODO_GENESIS_SELECTION_MISMATCH");
  return request;
}
export function parseOriginalMcpTodoGenesisPayload(value: unknown, signed: unknown) {
  const session = originalMcpTodoGenesisSessionSchema.parse(signed), payload = originalMcpTodoGenesisPayloadSchema.parse(value);
  const request = validateOriginalMcpTodoGenesisRequest(payload.request), host = payload.binding, expected = session.binding;
  if (session.epoch !== session.activationId || request.nativeEpoch !== session.epoch || host.epoch !== session.epoch
    || host.root !== expected.root || request.root !== expected.root
    || host.workspaceId !== expected.workspaceId || request.workspaceId !== expected.workspaceId
    || host.planSha256 !== expected.planSha256 || request.custodyPlanSha256 !== expected.planSha256
    || host.profileSha256 !== expected.profileSha256 || request.profileSha256 !== expected.profileSha256
    || host.sourceCatalogSha256 !== expected.catalogSha256 || request.catalogSha256 !== expected.catalogSha256
    || host.authorityId !== `native-rpc:${session.brokerId}` || !host.domains.includes("mcp-public")
    || request.nativeHostReceiptSha256 !== originalMcpTodoGenesisRequestDigest(host)
    || payload.requestSha256 !== originalMcpTodoGenesisRequestDigest(request))
    fail("TODO_GENESIS_SIGNED_BINDING_MISMATCH");
  return payload;
}
export function validateOriginalMcpTodoGenesisProvenance(value: unknown): OriginalMcpTodoGenesisProvenance {
  const provenance = originalMcpTodoGenesisProvenanceSchema.parse(value), { request, decision } = provenance;
  validateOriginalMcpTodoGenesisRequest(request);
  if (decision.actorId !== request.actorId || decision.operationId !== request.operationId
    || decision.epoch !== request.nativeEpoch || decision.requestSha256 !== originalMcpTodoGenesisRequestDigest(request))
    fail("TODO_GENESIS_DECISION_MISMATCH");
  return provenance;
}
export function validateOriginalMcpTodoGenesisPlan(value: unknown): OriginalMcpTodoGenesisPlan {
  const plan = originalMcpTodoGenesisPlanSchema.parse(value);
  validateOriginalMcpTodoGenesisRequest(plan.request);
  const { planSha256, ...body } = plan;
  if (planSha256 !== originalMcpTodoGenesisRequestDigest(body)
    || originalMcpTodoGenesisBytesDigest(plan.descriptor) !== plan.request.selection.descriptorSha256
    || originalMcpTodoGenesisBytesDigest(plan.backing) !== plan.request.selection.backingSha256)
    fail("TODO_GENESIS_PLAN_CHANGED");
  return plan;
}
