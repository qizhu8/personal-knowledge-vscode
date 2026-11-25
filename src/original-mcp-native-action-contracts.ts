import { z } from "zod";
import { originalDigest, originalDefinitionValue } from "./domain/action-compiler-validation.js";
import { originalActionCall } from "./original-mcp-action-call-contracts.js";
import { checkpointResponse } from "./action-runtime-contracts.js";
import { originalMcpNativeSignedHostBinding as hostBinding } from "./original-mcp-native-signed-host-contracts.js";
import { registeredActionReview, registeredActionDecision } from "./original-mcp-registered-action-contracts.js";

const digest = z.string().regex(/^[a-f0-9]{64}$/), uuid = z.string().uuid();
const actionId = z.string().regex(/^[a-z][a-z0-9_.-]{2,100}$/);
const identity = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/);
export const originalNativeActionSession = z.strictObject({
  brokerId: uuid, activationId: uuid, identitySha256: digest, epoch: uuid,
  binding: z.strictObject({
    root: z.string().min(1).max(4096), workspaceId: uuid, planSha256: digest, catalogSha256: digest,
    profileSha256: digest, payloadBuildId: digest, hostEntrySha256: digest,
  }),
});
export const originalNativeActionSourceRequest = z.strictObject({
  schema: z.literal("pkm.native-action-source-request/v1"), root: z.string().min(1).max(4096),
  workspaceId: uuid, actorId: z.literal("mcp:external"), profileSha256: digest, epoch: uuid,
  capsuleSha256: digest, requestSha256: digest, operation: z.string().min(1).max(512),
  sources: z.array(z.strictObject({
    actionId, contentHash: digest, implementationSha256: digest,
    effects: z.array(z.string().min(1).max(100)).max(64),
  })).min(1).max(128), noExecution: z.literal(true),
});
export const originalNativeActionSourceDecision = z.strictObject({
  schema: z.literal("pkm.native-action-source-decision/v1"), scope: z.literal("original-action-source-state/v1"),
  root: z.string().min(1).max(4096), workspaceId: uuid, actorId: z.literal("mcp:external"),
  profileSha256: digest, epoch: uuid, capsuleSha256: digest, requestSha256: digest,
  decisionId: identity, expiresAtMs: z.number().safe().int().positive(), noExecution: z.literal(true),
});
const consentBase = {
  schema: z.literal("pkm.original-action-invocation-consent/v1"),
  run_id: z.string().regex(/^action_run_[a-f0-9]{32}$/), request: originalActionCall,
  sourceReceiptSha256: digest, capsuleSha256: digest, implementationSha256: digest, automaticReplay: z.literal(false),
};
export const originalNativeActionInvocationConsent = z.discriminatedUnion("operation", [
  z.strictObject({ ...consentBase, operation: z.literal("action_call"), deadline: z.number().safe().int().positive() }),
  z.strictObject({ ...consentBase, operation: z.literal("action_checkpoint_respond"),
    expected_version: z.number().safe().int().positive(), response: checkpointResponse }),
  z.strictObject({ ...consentBase, operation: z.literal("action_run_wake"),
    expected_version: z.number().safe().int().positive(),
    response: z.strictObject({ run_id: z.string(), event_key: z.string().min(1).max(200), event_name: z.string().min(1).max(200) }),
  }),
]);
export const originalNativeActionEffectContext = z.strictObject({
  kind: z.literal("pipeline"), components: z.array(z.enum([
    "core.constant", "core.math-expression", "core.cast", "core.lookup", "core.checkpoint", "core.wait",
  ])).min(1).max(1024), stepCount: z.number().int().min(1).max(1024),
  effects: z.array(z.enum(["pure", "human-input"])).min(1).max(2),
  inputDigest: digest, inputPreview: z.string().min(1).max(4096),
}).refine(value => value.stepCount === value.components.length);
export const originalNativeActionMethods = Object.freeze([
  "action.status", "action.authorize", "action.source.approve", "action.invocation.approve",
  "action.registered.status", "action.registered.review",
] as const);
export type OriginalNativeActionMethod = typeof originalNativeActionMethods[number];
export function isOriginalNativeActionMethod(value: unknown): value is OriginalNativeActionMethod {
  return typeof value === "string" && originalNativeActionMethods.some(method => method === value);
}
const status = z.strictObject({ trusted: z.boolean(), trustEpoch: uuid });
const decision = z.strictObject({ decision: z.enum(["approve", "deny"]), trustEpoch: uuid });
export const originalNativeActionPayloadSchemas = Object.freeze({
  "action.registered.status": z.strictObject({ binding: hostBinding }),
  "action.registered.review": registeredActionReview,
  "action.status": z.strictObject({ binding: hostBinding, capsuleSha256: digest }),
  "action.authorize": z.strictObject({ binding: hostBinding, capsuleSha256: digest, actionId, contentHash: digest, trustEpoch: uuid }),
  "action.source.approve": z.strictObject({ binding: hostBinding, request: originalNativeActionSourceRequest }),
  "action.invocation.approve": z.strictObject({
    binding: hostBinding, capsuleSha256: digest, actionId, contentHash: digest, trustEpoch: uuid,
    effectContext: originalNativeActionEffectContext,
  }),
});
export const originalNativeActionResultSchemas = Object.freeze({
  "action.registered.status": status,
  "action.registered.review": registeredActionDecision.nullable(),
  "action.status": status, "action.authorize": decision,
  "action.source.approve": originalNativeActionSourceDecision.nullable(),
  "action.invocation.approve": decision,
});
export type OriginalNativeActionPayload<M extends OriginalNativeActionMethod> = z.infer<typeof originalNativeActionPayloadSchemas[M]>;
export type OriginalNativeActionResult<M extends OriginalNativeActionMethod> = z.infer<typeof originalNativeActionResultSchemas[M]>;
export type OriginalNativeActionSession = z.infer<typeof originalNativeActionSession>;
function fail(code: string): never { throw Object.assign(new Error(code), { code }); }

export function parseOriginalNativeActionPayload<M extends OriginalNativeActionMethod>(method: M, value: unknown,
  context: OriginalNativeActionSession): OriginalNativeActionPayload<M> {
  const session = originalNativeActionSession.parse(context), payload = originalNativeActionPayloadSchemas[method].parse(value);
  const binding = payload.binding, expected = session.binding;
  if (session.epoch !== session.activationId || binding.epoch !== session.epoch
    || binding.root !== expected.root || binding.workspaceId !== expected.workspaceId || binding.planSha256 !== expected.planSha256
    || binding.profileSha256 !== expected.profileSha256 || binding.sourceCatalogSha256 !== expected.catalogSha256
    || binding.authorityId !== `native-rpc:${session.brokerId}` || !binding.domains.includes("mcp-public"))
    fail("NATIVE_ACTION_BINDING_MISMATCH");
  if ("trustEpoch" in payload && payload.trustEpoch !== session.epoch) fail("NATIVE_ACTION_EPOCH_MISMATCH");
  if (method === "action.registered.review") {
    const request = registeredActionReview.parse(payload);
    if (originalDefinitionValue(request.definition).content_hash !== request.contentHash
      || new Set(request.sourceFiles.map(file => file.path)).size !== request.sourceFiles.length
      || request.executable && !request.sourceFiles.some(file =>
        file.path === request.executable!.path && file.sha256 === request.executable!.sha256)
      || request.purpose === "source" && (request.runId !== null || request.executable !== null
        || request.arguments.length || request.sourceFiles.length || request.localPath !== null
        || request.configurationSha256 !== null || Object.keys(request.inputs).length)
      || (request.purpose === "reconcile") !== (request.reconciliation !== undefined)
      || request.purpose !== "source" && request.runId === null
      || request.purpose === "reconcile" && (request.runId === null || request.localPath !== null || request.executable === null
        || originalDigest(request.reconciliation!.output) !== request.reconciliation!.outputSha256))
      fail("NATIVE_ACTION_REGISTERED_REVISION_MISMATCH");
  }
  if (method === "action.source.approve") {
    const request = originalNativeActionPayloadSchemas["action.source.approve"].parse(payload).request;
    if (request.root !== expected.root || request.workspaceId !== expected.workspaceId
      || request.profileSha256 !== expected.profileSha256 || request.epoch !== session.epoch
      || new Set(request.sources.map(source => source.actionId)).size !== request.sources.length)
      fail("NATIVE_ACTION_SOURCE_BINDING_MISMATCH");
  }
  if ("effectContext" in payload) {
    const invocation = originalNativeActionPayloadSchemas["action.invocation.approve"].parse(value);
    const consent = parseOriginalNativeActionConsent(invocation.effectContext);
    if (consent.capsuleSha256 !== invocation.capsuleSha256 || consent.request.action_id !== invocation.actionId
      || consent.request.content_hash !== invocation.contentHash)
      fail("NATIVE_ACTION_INVOCATION_BINDING_MISMATCH");
  }
  return payload as OriginalNativeActionPayload<M>;
}
export function parseOriginalNativeActionConsent(value: unknown) {
  const context = originalNativeActionEffectContext.parse(value);
  let consent: z.infer<typeof originalNativeActionInvocationConsent>;
  try { consent = originalNativeActionInvocationConsent.parse(JSON.parse(context.inputPreview)); }
  catch { return fail("NATIVE_ACTION_EXACT_PREVIEW_REQUIRED"); }
  if (originalDigest(consent) !== context.inputDigest || consent.request.trigger !== null || consent.request.project_id !== null
    || "response" in consent && consent.response.run_id !== consent.run_id)
    fail("NATIVE_ACTION_INVOCATION_BINDING_MISMATCH");
  return consent;
}
