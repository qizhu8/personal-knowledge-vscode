import { createHash } from "node:crypto";
import { z } from "zod";
import { canonicalJson } from "./domain/project-recipes-workflow-contracts.js";
import { originalNativeActionSession, originalNativeActionPayloadSchemas } from "./original-mcp-native-action-contracts.js";
import { originalRecipeSourceApprovalRequest, originalRecipeSourceApproval } from "./original-mcp-recipe-source-contracts.js";

export const originalNativeRecipeSessionSchema = originalNativeActionSession;
export type OriginalNativeRecipeSession = z.infer<typeof originalNativeRecipeSessionSchema>;
export const originalNativeRecipeMethods = Object.freeze(["recipe.source.approve"] as const);
export type OriginalNativeRecipeMethod = typeof originalNativeRecipeMethods[number];
export function isOriginalNativeRecipeMethod(value: unknown): value is OriginalNativeRecipeMethod {
  return value === "recipe.source.approve";
}
export const originalNativeRecipePayloadSchemas = Object.freeze({
  "recipe.source.approve": z.strictObject({
    binding: originalNativeActionPayloadSchemas["action.status"].shape.binding,
    noExecution: z.literal(true), request: originalRecipeSourceApprovalRequest,
  }),
});
export const originalNativeRecipeResultSchemas = Object.freeze({
  "recipe.source.approve": originalRecipeSourceApproval.nullable(),
});
export const originalNativeRecipeDigest = (value: unknown) => createHash("sha256").update(canonicalJson(value)).digest("hex");
function fail(code: string): never { throw Object.assign(new Error(code), { code }); }

/** Pure signed DTO validation: no RootOwner, Storage, Core, model or source admission. */
export function parseOriginalNativeRecipePayload(method: OriginalNativeRecipeMethod, value: unknown,
  context: OriginalNativeRecipeSession) {
  if (!isOriginalNativeRecipeMethod(method)) fail("NATIVE_RECIPE_METHOD_INVALID");
  const session = originalNativeRecipeSessionSchema.parse(context), payload = originalNativeRecipePayloadSchemas[method].parse(value);
  const host = payload.binding, expected = session.binding, request = payload.request;
  if (session.epoch !== session.activationId || host.epoch !== session.epoch || host.root !== expected.root
    || host.workspaceId !== expected.workspaceId || host.planSha256 !== expected.planSha256
    || host.profileSha256 !== expected.profileSha256 || host.sourceCatalogSha256 !== expected.catalogSha256
    || host.authorityId !== `native-rpc:${session.brokerId}` || !host.domains.includes("mcp-public")
    || request.root !== expected.root || request.workspaceId !== expected.workspaceId
    || request.custodyPlanSha256 !== expected.planSha256 || request.profileSha256 !== expected.profileSha256
    || request.epoch !== session.epoch || request.nativeHostReceiptSha256 !== originalNativeRecipeDigest(host))
    fail("NATIVE_RECIPE_SOURCE_BINDING_MISMATCH");
  if (request.schema === "pkm.original-recipe-terminal-source/v1") {
    const { phase: _phase, actorId: _actor, epoch: _epoch, nativeHostReceiptSha256: _receipt,
      planSha256, ...plan } = request;
    if (originalNativeRecipeDigest(plan) !== planSha256) fail("NATIVE_RECIPE_SOURCE_PLAN_CHANGED");
    if (request.sourcePath !== `.pkm/state/recipe-runs/${request.runId}.json` || request.bytes > request.maxFileBytes)
      fail("NATIVE_RECIPE_SOURCE_SELECTION_INVALID");
    return payload;
  }
  if (request.schema === "pkm.original-native-recipe-library-source/v1") {
    const { phase: _phase, actorId: _actor, epoch: _epoch, nativeHostReceiptSha256: _receipt,
      planSha256, ...plan } = request;
    if (originalNativeRecipeDigest(plan) !== planSha256 || originalNativeRecipeDigest(request.files) !== request.sourceSha256
      || new Set(request.files.map(file => file.path)).size !== request.files.length
      || new Set(request.nodeIds).size !== request.nodeIds.length
      || request.files.some(file => file.bytes > request.maxFileBytes
        || file.authority !== (file.path.startsWith(".pkm/") ? "sealed-custody" : "independent-canonical")
        || ![".pkm/state/recipe-store.json", ".pkm/state/projects.json", ".pkm/state/project-store.json"].includes(file.path)
          && (!["recipes/", "project/"].some(prefix => file.path.startsWith(prefix)) || !file.path.endsWith(".json")
            || file.path.split("/").some(part => !part || [".", "..", ".trash"].includes(part) || part.includes("\\")))))
      fail("NATIVE_RECIPE_SOURCE_PLAN_CHANGED");
    return payload;
  }
  if (request.schema === "pkm.original-recipe-library-source/v1") {
    const { phase: _phase, actorId: _actor, epoch: _epoch, nativeHostReceiptSha256: _receipt,
      planSha256, ...plan } = request;
    if (originalNativeRecipeDigest(plan) !== planSha256 || originalNativeRecipeDigest(request.files) !== request.sourceSha256)
      fail("NATIVE_RECIPE_SOURCE_PLAN_CHANGED");
    if (new Set(request.files.map(file => file.path)).size !== request.files.length
      || new Set(request.nodeIds).size !== request.nodeIds.length
      || request.files.filter(file => file.path === ".pkm/state/recipe-store.json").length !== 1
      || request.files.some(file => file.bytes > request.maxFileBytes
        || file.authority !== (file.path === ".pkm/state/recipe-store.json" ? "sealed-custody" : "independent-canonical")
        || file.path !== ".pkm/state/recipe-store.json"
          && (!file.path.startsWith("recipes/") || !file.path.endsWith(".json")
            || file.path.split("/").some(part => !part || part === "." || part === ".." || part === ".trash" || part.includes("\\")))))
      fail("NATIVE_RECIPE_SOURCE_SELECTION_INVALID");
    return payload;
  }
  const { phase: _phase, actorId: _actor, epoch: _epoch, nativeHostReceiptSha256: _receipt,
    noExecution: _execution, planSha256, ...plan } = request;
  if (originalNativeRecipeDigest(plan) !== planSha256 || originalNativeRecipeDigest(request.files) !== request.sourceSha256)
    fail("NATIVE_RECIPE_SOURCE_PLAN_CHANGED");
  if (new Set(request.files.map(file => file.path)).size !== request.files.length
    || request.runsScanned !== Math.min(request.files.length, 5000) || request.files.length > request.limits.maxFiles
    || request.files.some(file => (file.kind === "file") !== (file.sha256 !== null)
      || BigInt(file.size) > BigInt(request.limits.maxFileBytes))
    || request.files.reduce((total, file) => total + BigInt(file.size), 0n) > BigInt(request.limits.maxTotalBytes))
    fail("NATIVE_RECIPE_SOURCE_SELECTION_INVALID");
  return payload;
}

/** Measure the entire existing signed native frame, never a shortened source preview. */
export function assertOriginalNativeRecipePacketBudget(method: OriginalNativeRecipeMethod, payload: unknown,
  session: OriginalNativeRecipeSession, requestId = "00000000-0000-4000-8000-000000000000") {
  const frame = { type: "native-request", protocol: "pkm.original-mcp-native-request/v1", requestId,
    session, method, payload, requestDigest: "0".repeat(64) };
  const bytes = Buffer.byteLength(JSON.stringify(frame) + "\n");
  if (bytes > 65536) throw Object.assign(new Error(
    `NATIVE_REQUEST_TOO_LARGE: exact Recipe source approval requires ${bytes} bytes; the signed request budget is 65536 bytes. Reviewed chunked source-consent transport is not implemented; do not truncate source identities.`),
  { code: "NATIVE_REQUEST_TOO_LARGE", requiredBytes: bytes, maximumBytes: 65536 });
}
