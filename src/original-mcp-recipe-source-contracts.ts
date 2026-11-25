import { z } from "zod";
import { workflowRuntimeBindings } from "./domain/workflow-executor-bindings.js";

const digest = z.string().regex(/^[a-f0-9]{64}$/);
export const originalRecipeUsageLimits = z.strictObject({
  maxFiles: z.number().int().min(1).max(20_000),
  maxFileBytes: z.number().int().min(1).max(16_777_216),
  maxTotalBytes: z.number().int().min(1).max(134_217_728),
});
export const originalRecipeUsageSource = z.strictObject({
  schema: z.literal("pkm.original-recipe-usage-source/v1"),
  root: z.string().min(1), workspaceId: z.string().uuid(), custodyPlanSha256: digest,
  profileSha256: digest, sourceSha256: digest, rowsSha256: digest,
  files: z.array(z.strictObject({
    path: z.string().regex(/^\.pkm\/state\/recipe-runs\/recipe_run_[^/\\]+\.json$/),
    kind: z.enum(["file", "directory"]), sha256: digest.nullable(),
    mtime: z.string().regex(/^\d+$/), size: z.string().regex(/^\d+$/),
  })).max(20_000),
  runsScanned: z.number().int().min(0).max(5000),
  limits: originalRecipeUsageLimits, planSha256: digest,
});
export type OriginalRecipeUsageSource = z.infer<typeof originalRecipeUsageSource>;
const approvalBinding = {
  phase: z.enum(["admit", "activate"]), actorId: z.literal("mcp:external"),
  epoch: z.string().min(1).max(128), nativeHostReceiptSha256: digest, noExecution: z.literal(true),
};
export const originalRecipeUsageApprovalRequest = originalRecipeUsageSource.extend(approvalBinding);
export const originalRecipeTerminalSource = z.strictObject({
  schema: z.literal("pkm.original-recipe-terminal-source/v1"),
  root: z.string().min(1), workspaceId: z.string().uuid(), custodyPlanSha256: digest,
  profileSha256: digest, runId: z.string().regex(/^recipe_run_[\p{L}\p{N}_-]*$/u),
  sourcePath: z.string().min(1), sourceSha256: digest,
  bytes: z.number().safe().int().positive().max(16_777_216),
  maxFileBytes: z.number().safe().int().positive().max(16_777_216),
  status: z.enum(["completed", "failed"]), recordSha256: digest,
  planSha256: digest, noExecution: z.literal(true),
});
export type OriginalRecipeTerminalSource = z.infer<typeof originalRecipeTerminalSource>;
export const originalRecipeTerminalApprovalRequest = originalRecipeTerminalSource.extend(approvalBinding);
export const originalRecipeLibrarySource = z.strictObject({
  schema: z.literal("pkm.original-recipe-library-source/v1"),
  root: z.string().min(1), workspaceId: z.string().uuid(), custodyPlanSha256: digest, profileSha256: digest,
  files: z.array(z.strictObject({ path: z.string().min(1), sha256: digest, bytes: z.number().safe().int().nonnegative(),
    pin: z.string().min(1).max(512), authority: z.enum(["sealed-custody", "independent-canonical"]) })).min(2).max(128),
  sourceSha256: digest, recipeId: z.string().regex(/^[A-Za-z][A-Za-z0-9._-]{0,127}$/),
  revision: z.number().safe().int().positive(), executableDigest: digest, recordSha256: digest,
  nodeIds: z.array(z.string().min(1).max(128)).min(1).max(128),
  maxFileBytes: z.number().safe().int().positive().max(2_097_152),
  protocol: z.literal("controlled-external-report/v1"),
  effects: z.tuple([z.literal("caller-reported-result-only")]),
  noExecution: z.literal(true), planSha256: digest,
});
export type OriginalRecipeLibrarySource = z.infer<typeof originalRecipeLibrarySource>;
export const originalRecipeLibraryApprovalRequest = originalRecipeLibrarySource.extend(approvalBinding);
export const originalNativeRecipeLibrarySource = originalRecipeLibrarySource.omit({ schema: true }).extend({
  schema: z.literal("pkm.original-native-recipe-library-source/v1"),
  files: z.array(originalRecipeLibrarySource.shape.files.element).max(128),
  kind: z.enum(["canonical", "overlay", "adhoc"]), purpose: z.enum(["author", "read", "execute"]),
  executionSemantics: z.enum(["definition-only/v1", "original-recipe-metadata/v1", "native-runtime-bindings/v1"]).optional(),
  runtimeBindings: workflowRuntimeBindings.optional(),
  nativeRecipeId: z.string().uuid().nullable(),
  nativeRecordSha256: digest, nativeReceiptSha256: digest.nullable(),
  nativeSnapshotSha256: digest, previousNativeSnapshotSha256: digest,
  publicExecutableDigest: digest, payloadSha256: digest,
  rootProjectId: z.string().min(1).max(256).optional(),
  reachableRecipes: z.array(z.strictObject({
    recipeId: z.string().min(1).max(256), revision: z.number().safe().int().positive(),
    executableDigest: digest, recordSha256: digest,
    nativeRecipeId: z.uuid().nullable(), nativeRecordSha256: digest, nativeReceiptSha256: digest.nullable(),
  })).min(1).max(31).optional(),
  knowledgePins: z.array(z.strictObject({
    kind: z.enum(["skill", "note"]), bindingKey: z.string().min(1).max(256),
    path: z.string().min(1).max(512), documentId: z.string().min(1).max(256),
    knowledgeId: z.string().min(1).max(256), revision: z.number().int().safe().positive(),
    sha256: digest, contentHash: digest, pin: z.string().min(1).max(1024), parentsSha256: digest,
  })).max(128),
});
export type OriginalNativeRecipeLibrarySource = z.infer<typeof originalNativeRecipeLibrarySource>;
export const originalNativeRecipeLibraryApprovalRequest = originalNativeRecipeLibrarySource.extend(approvalBinding);
export const originalRecipeSourceApprovalRequest = z.discriminatedUnion("schema", [
  originalRecipeUsageApprovalRequest, originalRecipeTerminalApprovalRequest, originalRecipeLibraryApprovalRequest,
  originalNativeRecipeLibraryApprovalRequest,
]);
export type OriginalRecipeSourceApprovalRequest = z.infer<typeof originalRecipeSourceApprovalRequest>;
export const originalRecipeSourceApproval = z.strictObject({
  actorId: z.literal("mcp:external"), decisionId: z.string().uuid(),
  requestSha256: digest, expiresAtMs: z.number().int().safe().positive(),
});
export type OriginalRecipeSourceApproval = z.infer<typeof originalRecipeSourceApproval>;

/** Trusted embedding port only. Callback fixtures do not qualify an installed native source producer. */
export interface OriginalRecipeSourcePolicy {
  readonly signal: AbortSignal;
  assertCurrent(request: Readonly<OriginalRecipeSourceApprovalRequest>): void;
  authorize(request: Readonly<OriginalRecipeSourceApprovalRequest>, signal: AbortSignal):
    Promise<OriginalRecipeSourceApproval | null>;
}
