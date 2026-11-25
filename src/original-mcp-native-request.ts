import { randomUUID } from "node:crypto";
import { z } from "zod";
import { originalMcpRequestDigest, type OriginalMcpNativeHostPolicy } from "./original-mcp-native-host.js";
import { approvalBridgeDigest, approvalBridgeRecordDigest } from "./domain/approval-bridge-digest.js";
import {
  assertAuthenticatedOriginalMcpNativeSession, type AuthenticatedOriginalMcpNativeSession,
} from "./original-mcp-native-attachment.js";
import type { ToolGatewayBinding } from "./tool-gateway-contracts.js";
import {
  originalNativeActionMethods, originalNativeActionPayloadSchemas, originalNativeActionResultSchemas,
  isOriginalNativeActionMethod, parseOriginalNativeActionPayload,
} from "./original-mcp-native-action-contracts.js";
import {
  originalNativeSourceMethods, originalNativeSourcePayloadSchemas, originalNativeSourceResultSchemas,
  isOriginalNativeSourceMethod, parseOriginalNativeSourcePayload,
} from "./original-mcp-native-source-contracts.js";
import {
  originalNativeRecipeMethods, originalNativeRecipePayloadSchemas, originalNativeRecipeResultSchemas,
  isOriginalNativeRecipeMethod, parseOriginalNativeRecipePayload,
} from "./original-mcp-native-recipe-contracts.js";
import {
  originalNativeRoomMethods, originalNativeRoomPayloadSchemas, originalNativeRoomResultSchemas,
  isOriginalNativeRoomMethod, parseOriginalNativeRoomPayload,
} from "./original-mcp-native-room-contracts.js";
import {
  originalNativeTodoWorkerMethods, originalNativeTodoWorkerPayloadSchemas, originalNativeTodoWorkerResultSchemas,
  isOriginalNativeTodoWorkerMethod, parseOriginalNativeTodoWorkerPayload,
} from "./original-mcp-native-todo-worker-contracts.js";
import {
  originalActionProgramMethod, originalActionProgramPayload, originalActionProgramDecision, parseOriginalActionProgramPayload,
} from "./original-mcp-action-program-contracts.js";
import {
  originalRoomSessionNativeMethods, originalRoomUserLinkNativeMethods, originalRoomSessionNativePayloads,
  originalRoomSessionNativeResults, isOriginalRoomSessionNativeMethod, parseOriginalRoomSessionNativePayload,
} from "./original-mcp-room-session-contracts.js";
import {
  privateResourcePublicationMethod, privateResourcePublicationPayloadSchema,
  privateResourcePublicationResultSchema, parsePrivateResourcePublicationPayload,
} from "./private-resource-publication-contracts.js";
import {
  originalNativeTrashMethod, originalNativeTrashPayloadSchema, originalNativeTrashResultSchema,
  parseOriginalNativeTrashPayload,
} from "./original-native-trash-contracts.js";
import {
  originalMcpTodoGenesisMethod, originalMcpTodoGenesisPayloadSchema, originalMcpTodoGenesisResultSchema,
  parseOriginalMcpTodoGenesisPayload,
} from "./original-mcp-todo-genesis-contracts.js";
import { originalTodoRoleMethods, originalTodoRolePayloads, originalTodoRoleResults,
  isOriginalTodoRoleMethod, parseOriginalTodoRolePayload } from "./original-mcp-todo-role-contracts.js";
import {
  originalRecoveryPhase1Methods, originalRecoverySourcePayloadSchema, originalRecoveryRepairPayloadSchema,
  originalRecoverySourceResultSchema, originalRecoveryRepairResultSchema, parseOriginalRecoveryPhase1Payload,
} from "./original-knowledge-recovery-contracts.js";
import { originalSubscriptionReadMethod, originalSubscriptionReadPayload, originalSubscriptionReadDecision,
  parseOriginalSubscriptionReadPayload } from "./original-mcp-subscription-contracts.js";
import { originalPortalNativeMethod, originalPortalNativePayload, originalPortalNativeDecision,
  parseOriginalPortalNativePayload } from "./original-mcp-portal-contracts.js";
import { originalRecipeEffectMethod, originalRecipeEffectPayload, originalRecipeEffectDecision,
  parseOriginalRecipeEffectPayload } from "./original-mcp-recipe-effect-contracts.js";
import { originalSubscriptionProfileMethod, originalSubscriptionProfilePayload, originalSubscriptionProfileResult,
  parseOriginalSubscriptionProfilePayload } from "./original-mcp-subscription-profile-contracts.js";
import { nativeActionPackageMethods, nativeActionPackageRequestSchemas, nativeActionPackageResultSchemas,
  isNativeActionPackageMethod, parseNativeActionPackagePayload } from "./original-mcp-action-package-native-contracts.js";
import { originalNativeSyncMethod, originalNativeSyncPayloadSchema, originalNativeSyncResultSchema,
  parseOriginalNativeSyncPayload } from "./original-mcp-native-sync-contracts.js";

export const originalMcpNativeRequestProtocol = "pkm.original-mcp-native-request/v1" as const;
export const originalMcpNativeRequestMethods = Object.freeze([
  "admission.approve", "public.approve", "model.approve", "tool.approve", "tool.review", "credential.present",
  ...originalNativeActionMethods,
  ...nativeActionPackageMethods,
  originalActionProgramMethod,
  ...originalNativeSourceMethods,
  ...originalNativeRecipeMethods,
  ...originalNativeRoomMethods,
  ...originalRoomSessionNativeMethods, ...originalRoomUserLinkNativeMethods,
  ...originalNativeTodoWorkerMethods,
  privateResourcePublicationMethod,
  originalNativeTrashMethod,
  originalMcpTodoGenesisMethod,
  ...originalTodoRoleMethods,
  originalRecoveryPhase1Methods.source, originalRecoveryPhase1Methods.repair,
  originalSubscriptionReadMethod,
  originalSubscriptionProfileMethod, originalNativeSyncMethod,
  originalPortalNativeMethod, originalRecipeEffectMethod,
] as const);
export type OriginalMcpNativeRequestMethod = typeof originalMcpNativeRequestMethods[number];
const digest = z.string().regex(/^[a-f0-9]{64}$/), uuid = z.string().uuid();
const text = z.string().min(1).max(256);
const args = z.record(z.string(), z.json());
const bindingSchema = z.strictObject({
  root: z.string().min(1).max(4096), workspaceId: uuid, planSha256: digest, catalogSha256: digest,
  profileSha256: digest, payloadBuildId: digest, hostEntrySha256: digest,
});
export const originalMcpNativeRequestSessionSchema = z.strictObject({
  brokerId: uuid, activationId: uuid, identitySha256: digest, epoch: uuid, binding: bindingSchema,
});
const hostBinding = z.strictObject({
  schema: z.literal("pkm.original-mcp-native-host-admission/v1"), root: z.string().min(1).max(4096),
  workspaceId: uuid, planSha256: digest, profileSha256: digest, sourceCatalogSha256: digest,
  authorityId: z.string().regex(/^[A-Za-z0-9._:-]{1,128}$/), epoch: uuid, actorId: z.literal("mcp:external"),
  domains: z.array(z.enum(["model-provider", "tool-approval", "mcp-public", "api-chat-native"])).min(1).max(4),
  configurationSha256: digest,
});
const publicApproval = z.strictObject({
  operation: z.string().regex(/^mcp\.tool\.[a-z0-9_]+$/), version: z.literal(1), tool: text,
  readOnly: z.boolean(), arguments: args, argumentsDigest: digest,
});
const toolApproval = z.strictObject({
  operation: text, version: z.literal(1), arguments: args, argumentsDigest: digest,
  operationId: uuid.optional(), actorId: z.literal("mcp:external"), workspaceId: uuid,
  turnId: text, contextDigest: digest, readOnly: z.boolean(),
});
const reviewSchema = z.strictObject({
  workspaceId: uuid, actorId: z.literal("mcp:external"), operationId: uuid, executionOperationId: uuid,
  recordDigest: digest, argumentsDigest: digest,
  context: z.strictObject({ turnId: text, contextDigest: digest, readOnly: z.boolean() }),
  record: z.strictObject({
    id: text, actor: z.literal("mcp:external"), revision: z.number().int().positive(),
    status: z.enum(["pending", "awaiting_approval", "running", "succeeded", "failed", "cancelled", "unknown"]),
    tool: text, arguments: args, approvalRequired: z.boolean(), approvalDecisionId: text.nullable(),
    createdAt: z.number().int().nonnegative(), updatedAt: z.number().int().nonnegative(),
  }),
});
const payloadSchemas = {
  "admission.approve": z.strictObject({ binding: hostBinding }),
  "public.approve": z.strictObject({ binding: hostBinding, request: publicApproval }),
  "model.approve": z.strictObject({ binding: hostBinding,
    provider: z.enum(["vscode", "openai-compatible", "azure-openai"]), model: text, requestSha256: digest }),
  "tool.approve": z.strictObject({ binding: hostBinding, request: toolApproval }),
  "tool.review": z.strictObject({ binding: hostBinding, review: reviewSchema }),
  "credential.present": z.strictObject({ binding: hostBinding, secretId: z.literal("personalKnowledge.aiApiKey") }),
  ...originalNativeActionPayloadSchemas,
  [originalActionProgramMethod]: originalActionProgramPayload,
  ...originalNativeSourcePayloadSchemas,
  ...originalNativeRecipePayloadSchemas,
  ...originalNativeRoomPayloadSchemas,
  ...originalRoomSessionNativePayloads,
  ...originalNativeTodoWorkerPayloadSchemas,
  [privateResourcePublicationMethod]: privateResourcePublicationPayloadSchema,
  [originalNativeTrashMethod]: originalNativeTrashPayloadSchema,
  [originalMcpTodoGenesisMethod]: originalMcpTodoGenesisPayloadSchema,
  ...originalTodoRolePayloads,
  [originalRecoveryPhase1Methods.source]: originalRecoverySourcePayloadSchema,
  [originalRecoveryPhase1Methods.repair]: originalRecoveryRepairPayloadSchema,
  [originalSubscriptionReadMethod]: originalSubscriptionReadPayload,
  [originalSubscriptionProfileMethod]: originalSubscriptionProfilePayload,
  ...nativeActionPackageRequestSchemas,
  [originalNativeSyncMethod]: originalNativeSyncPayloadSchema,
  [originalPortalNativeMethod]: originalPortalNativePayload,
  [originalRecipeEffectMethod]: originalRecipeEffectPayload,
};
export const originalMcpNativePayloadSchemas = Object.freeze(payloadSchemas);
export const originalMcpNativeSupportsSchema = z.strictObject({
  type: z.literal("native-supports"), protocol: z.literal(originalMcpNativeRequestProtocol),
  session: originalMcpNativeRequestSessionSchema,
  methods: z.array(z.enum(originalMcpNativeRequestMethods)).max(originalMcpNativeRequestMethods.length),
  maxPacketBytes: z.number().int().min(1024).max(65536),
});
const requestBase = z.strictObject({
  type: z.literal("native-request"), protocol: z.literal(originalMcpNativeRequestProtocol), requestId: uuid,
  session: originalMcpNativeRequestSessionSchema, method: z.enum(originalMcpNativeRequestMethods),
  payload: z.unknown(), requestDigest: digest,
});
export type OriginalMcpNativeRequestFrame = {
  [M in OriginalMcpNativeRequestMethod]: Omit<z.infer<typeof requestBase>, "method" | "payload">
    & { method: M; payload: z.infer<typeof payloadSchemas[M]> }
}[OriginalMcpNativeRequestMethod];
const decision = z.strictObject({ decision: z.enum(["approve", "deny"]) });
const reviewDecision = z.strictObject({ decision: z.enum(["approve", "reject"]), decisionId: text, actorId: z.literal("mcp:external") }).nullable();
export const originalMcpNativeResultSchema = z.strictObject({
  type: z.literal("native-result"), protocol: z.literal(originalMcpNativeRequestProtocol), requestId: uuid,
  session: originalMcpNativeRequestSessionSchema, requestDigest: digest,
  result: z.unknown().optional(),
  error: z.strictObject({ code: z.enum(["MISSING_NATIVE_METHOD", "NATIVE_DENIED", "NATIVE_REQUEST_CANCELLED", "NATIVE_HANDLER_FAILED"]) }).optional(),
}).refine(value => ("result" in value) !== ("error" in value));
export const originalMcpNativeCancelSchema = z.strictObject({
  type: z.literal("native-cancel"), protocol: z.literal(originalMcpNativeRequestProtocol), requestId: uuid,
  session: originalMcpNativeRequestSessionSchema, requestDigest: digest,
});
function fail(code: string): never { throw Object.assign(new Error(code), { code }); }
function boundedJson(value: unknown, maximum = 65536) {
  const ancestors = new Set<object>();
  let bytes = 0, nodes = 0;
  const add = (count: number) => { bytes += count; if (bytes > maximum) fail("NATIVE_REQUEST_TOO_LARGE"); };
  const string = (text: string) => {
    if (Buffer.byteLength(text) > maximum) fail("NATIVE_REQUEST_TOO_LARGE");
    add(Buffer.byteLength(JSON.stringify(text)));
  };
  const visit = (item: unknown, depth: number) => {
    if (++nodes > 65536 || depth > 64) fail("NATIVE_REQUEST_TOO_LARGE");
    if (typeof item === "string") { string(item); return; }
    if (item === null || typeof item === "boolean" || typeof item === "number" && Number.isFinite(item)) {
      add(Buffer.byteLength(JSON.stringify(item))); return;
    }
    if (!item || typeof item !== "object" || ancestors.has(item)
      || !Array.isArray(item) && ![Object.prototype, null].includes(Object.getPrototypeOf(item))) fail("NATIVE_REQUEST_INVALID");
    ancestors.add(item); add(2);
    if (Array.isArray(item)) {
      if (Object.keys(item).length !== item.length) fail("NATIVE_REQUEST_INVALID");
      for (const child of item) { add(1); visit(child, depth + 1); }
    } else for (const key of Object.keys(item)) {
      const property = Object.getOwnPropertyDescriptor(item, key);
      if (!property || !("value" in property)) fail("NATIVE_REQUEST_INVALID");
      string(key); add(2); visit(property.value, depth + 1);
    }
    ancestors.delete(item);
  };
  visit(value, 0);
}
const same = (left: unknown, right: unknown) => originalMcpRequestDigest(left) === originalMcpRequestDigest(right);
const frozen = <T>(value: T): T => {
  if (value && typeof value === "object") { for (const child of Object.values(value)) frozen(child); Object.freeze(value); }
  return value;
};
function noCredentials(value: unknown): void {
  if (!value || typeof value !== "object") return;
  for (const [key, child] of Object.entries(value)) {
    if (/^(?:api[_-]?key|password|authorization|access[_-]?token|refresh[_-]?token|private[_-]?key|credentials?|secret|worker[_-]?token)$/i.test(key))
      fail("NATIVE_REQUEST_CREDENTIAL_FIELDS");
    noCredentials(child);
  }
}
export function originalMcpNativeRequestSession(session: AuthenticatedOriginalMcpNativeSession) {
  assertAuthenticatedOriginalMcpNativeSession(session);
  return frozen({ brokerId: session.brokerId, activationId: session.activationId, identitySha256: session.identitySha256,
    epoch: session.activationId, binding: { ...session.binding } });
}
function checkHostBinding(value: z.infer<typeof hostBinding>, context: z.infer<typeof originalMcpNativeRequestSessionSchema>) {
  const expected = context.binding;
  if (context.epoch !== context.activationId || value.root !== expected.root || value.workspaceId !== expected.workspaceId
    || value.planSha256 !== expected.planSha256 || value.profileSha256 !== expected.profileSha256
    || value.sourceCatalogSha256 !== expected.catalogSha256 || value.epoch !== context.activationId
    || value.authorityId !== `native-rpc:${context.brokerId}`) fail("NATIVE_REQUEST_BINDING_MISMATCH");
}
function parsePayload(method: OriginalMcpNativeRequestMethod, value: unknown,
  context: z.infer<typeof originalMcpNativeRequestSessionSchema>) {
  if (method === originalSubscriptionProfileMethod) return parseOriginalSubscriptionProfilePayload(value, context);
  if (isNativeActionPackageMethod(method)) return parseNativeActionPackagePayload(method, value, context);
  if (method === originalNativeSyncMethod) return parseOriginalNativeSyncPayload(value, context);
  if (method === originalPortalNativeMethod) return parseOriginalPortalNativePayload(value, context);
  if (method === originalRecipeEffectMethod) {
    const payload = parseOriginalRecipeEffectPayload(value, context);
    noCredentials(payload.request.inputs);
    return payload;
  }
  if (method === originalSubscriptionReadMethod) return parseOriginalSubscriptionReadPayload(value, context);
  if (method === originalRecoveryPhase1Methods.source || method === originalRecoveryPhase1Methods.repair)
    return parseOriginalRecoveryPhase1Payload(method, value, context);
  if (isOriginalTodoRoleMethod(method)) return parseOriginalTodoRolePayload(method, value, context);
  if (method === privateResourcePublicationMethod) return parsePrivateResourcePublicationPayload(value, context);
  if (method === originalNativeTrashMethod) return parseOriginalNativeTrashPayload(value, context);
  if (method === originalMcpTodoGenesisMethod) return parseOriginalMcpTodoGenesisPayload(value, context);
  if (isOriginalRoomSessionNativeMethod(method)) return parseOriginalRoomSessionNativePayload(method, value, context);
  if (method === originalActionProgramMethod) return parseOriginalActionProgramPayload(value, context);
  if (isOriginalNativeTodoWorkerMethod(method)) return parseOriginalNativeTodoWorkerPayload(method, value, context);
  if (isOriginalNativeRoomMethod(method)) return parseOriginalNativeRoomPayload(method, value, context);
  if (isOriginalNativeRecipeMethod(method)) return parseOriginalNativeRecipePayload(method, value, context);
  if (isOriginalNativeSourceMethod(method)) return parseOriginalNativeSourcePayload(method, value, context);
  if (isOriginalNativeActionMethod(method)) return parseOriginalNativeActionPayload(method, value, context);
  const payload = payloadSchemas[method].parse(value);
  checkHostBinding(payload.binding, context);
  if (method === "public.approve" || method === "tool.approve") {
    const request = method === "public.approve"
      ? payloadSchemas["public.approve"].parse(value).request : payloadSchemas["tool.approve"].parse(value).request;
    noCredentials(request.arguments);
    if (originalMcpRequestDigest(request.arguments) !== request.argumentsDigest) fail("NATIVE_REQUEST_ARGUMENTS_CHANGED");
    if (method === "public.approve" && "tool" in request && request.operation !== `mcp.tool.${request.tool}`)
      fail("NATIVE_REQUEST_ARGUMENTS_CHANGED");
    if (method === "tool.approve" && "workspaceId" in request && request.workspaceId !== context.binding.workspaceId)
      fail("NATIVE_REQUEST_BINDING_MISMATCH");
  }
  if (method === "tool.review") {
    const review = payloadSchemas["tool.review"].parse(value).review;
    noCredentials(review.record.arguments);
    if (review.workspaceId !== context.binding.workspaceId || approvalBridgeDigest(review.record.arguments) !== review.argumentsDigest
      || approvalBridgeRecordDigest(review.workspaceId, review.record, review.context, review.executionOperationId) !== review.recordDigest)
      fail("NATIVE_REQUEST_ARGUMENTS_CHANGED");
  }
  return payload;
}

/** Shared strict parser for the genuine native client; never invokes a method. */
export function parseOriginalMcpNativeRequest(value: unknown, expectedSession?: unknown): OriginalMcpNativeRequestFrame {
  try {
    boundedJson(value);
    const parsed = requestBase.parse(value);
    if (expectedSession && !same(parsed.session, originalMcpNativeRequestSessionSchema.parse(expectedSession)))
      fail("NATIVE_REQUEST_BINDING_MISMATCH");
    const payload = parsePayload(parsed.method, parsed.payload, parsed.session);
    const { requestDigest, type: _type, ...body } = { ...parsed, payload };
    if (originalMcpRequestDigest(body) !== requestDigest) fail("NATIVE_REQUEST_DIGEST_MISMATCH");
    return frozen({ ...parsed, payload }) as OriginalMcpNativeRequestFrame;
  } catch (error) {
    if (error instanceof Error && "code" in error && typeof error.code === "string" && error.code.startsWith("NATIVE_")) throw error;
    fail("NATIVE_REQUEST_INVALID");
  }
}
function parseResult(method: OriginalMcpNativeRequestMethod, value: unknown) {
  if (method === originalSubscriptionProfileMethod) return originalSubscriptionProfileResult.parse(value);
  if (isNativeActionPackageMethod(method)) return nativeActionPackageResultSchemas[method].parse(value);
  if (method === originalNativeSyncMethod) return originalNativeSyncResultSchema.parse(value);
  if (method === originalPortalNativeMethod) return originalPortalNativeDecision.parse(value);
  if (method === originalRecipeEffectMethod) return originalRecipeEffectDecision.parse(value);
  if (method === originalSubscriptionReadMethod) return originalSubscriptionReadDecision.parse(value);
  if (method === originalRecoveryPhase1Methods.source) return originalRecoverySourceResultSchema.parse(value);
  if (method === originalRecoveryPhase1Methods.repair) return originalRecoveryRepairResultSchema.parse(value);
  if (isOriginalTodoRoleMethod(method)) return originalTodoRoleResults[method].parse(value);
  if (method === privateResourcePublicationMethod) return privateResourcePublicationResultSchema.parse(value);
  if (method === originalNativeTrashMethod) return originalNativeTrashResultSchema.parse(value);
  if (method === originalMcpTodoGenesisMethod) return originalMcpTodoGenesisResultSchema.parse(value);
  if (isOriginalRoomSessionNativeMethod(method)) return originalRoomSessionNativeResults[method].parse(value);
  if (method === originalActionProgramMethod) return originalActionProgramDecision.nullable().parse(value);
  if (isOriginalNativeTodoWorkerMethod(method)) return originalNativeTodoWorkerResultSchemas[method].parse(value);
  if (isOriginalNativeRoomMethod(method)) return originalNativeRoomResultSchemas[method].parse(value);
  if (isOriginalNativeRecipeMethod(method)) return originalNativeRecipeResultSchemas[method].parse(value);
  if (isOriginalNativeSourceMethod(method)) return originalNativeSourceResultSchemas[method].parse(value);
  if (isOriginalNativeActionMethod(method)) return originalNativeActionResultSchemas[method].parse(value);
  return method === "credential.present" ? z.strictObject({ present: z.boolean() }).parse(value)
    : method === "tool.review" ? reviewDecision.parse(value) : decision.parse(value);
}
/** Native replies echo the entire exact session/request binding; keys are never a result type. */
export function originalMcpNativeResult(request: OriginalMcpNativeRequestFrame, result: unknown) {
  const parsed = parseOriginalMcpNativeRequest(request), value = parseResult(parsed.method, result);
  return frozen({ type: "native-result" as const, protocol: originalMcpNativeRequestProtocol,
    requestId: parsed.requestId, session: parsed.session, requestDigest: parsed.requestDigest, result: value });
}
export function originalMcpNativeErrorResult(request: OriginalMcpNativeRequestFrame,
  code: "MISSING_NATIVE_METHOD" | "NATIVE_DENIED" | "NATIVE_REQUEST_CANCELLED" | "NATIVE_HANDLER_FAILED") {
  const parsed = parseOriginalMcpNativeRequest(request);
  return frozen(originalMcpNativeResultSchema.parse({ type: "native-result", protocol: originalMcpNativeRequestProtocol,
    requestId: parsed.requestId, session: parsed.session, requestDigest: parsed.requestDigest, error: { code } }));
}
interface Channel {
  maximumBytes: number;
  send(value: unknown): void;
  revoke(): void;
}
interface Pending {
  request: OriginalMcpNativeRequestFrame;
  resolve(value: unknown): void;
  reject(error: unknown): void;
  dispose(): void;
}
interface State {
  channel: Channel;
  session: AuthenticatedOriginalMcpNativeSession;
  supported: Set<OriginalMcpNativeRequestMethod>;
  maximumBytes: number;
  pending: Map<string, Pending>;
  retired: Map<string, { digest: string; method: OriginalMcpNativeRequestMethod }>;
  supportsSeen: boolean;
  supportWaiters: Set<{ resolve(): void; reject(error: unknown): void; dispose(): void }>;
}
const channels = new WeakMap<object, State>();

/**
 * Attachment server only: called once, synchronously before publishing a real
 * branded session. A later caller cannot replace the actual socket transport.
 */
export function bindOriginalMcpNativeRequestTransport(session: AuthenticatedOriginalMcpNativeSession, channel: Channel) {
  assertAuthenticatedOriginalMcpNativeSession(session);
  if (channels.has(session)) fail("NATIVE_REQUEST_CHANNEL_ALREADY_BOUND");
  const state: State = { channel, session, supported: new Set(), maximumBytes: channel.maximumBytes,
    pending: new Map(), retired: new Map(), supportsSeen: false, supportWaiters: new Set() };
  channels.set(session, state);
  session.signal.addEventListener("abort", () => {
    for (const item of state.pending.values()) { item.dispose(); item.reject(Object.assign(new Error("Native session revoked."), { code: "NATIVE_REQUEST_SESSION_REVOKED" })); }
    state.pending.clear(); state.retired.clear(); state.supported.clear();
    for (const waiter of state.supportWaiters) { waiter.dispose(); waiter.reject(Object.assign(new Error("Native session revoked."), { code: "NATIVE_REQUEST_SESSION_REVOKED" })); }
    state.supportWaiters.clear();
  }, { once: true });
  return (value: unknown) => {
    try {
      session.assertCurrent();
      const expected = originalMcpNativeRequestSession(session);
      if (value && typeof value === "object" && "type" in value && value.type === "native-supports") {
        const supports = originalMcpNativeSupportsSchema.parse(value);
        if (state.supportsSeen || !same(supports.session, expected) || new Set(supports.methods).size !== supports.methods.length)
          fail("NATIVE_REQUEST_SUPPORT_INVALID");
        state.supportsSeen = true; state.supported = new Set(supports.methods);
        state.maximumBytes = Math.min(channel.maximumBytes, supports.maxPacketBytes);
        for (const waiter of state.supportWaiters) { waiter.dispose(); waiter.resolve(); }
        state.supportWaiters.clear();
        return;
      }
      const frame = originalMcpNativeResultSchema.parse(value);
      if (!same(frame.session, expected)) fail("NATIVE_REQUEST_BINDING_MISMATCH");
      const pending = state.pending.get(frame.requestId);
      if (!pending) {
        const retired = state.retired.get(frame.requestId);
        if (retired?.digest === frame.requestDigest) {
          if (!frame.error) parseResult(retired.method, frame.result);
          return;
        }
        fail("NATIVE_REQUEST_RESPONSE_UNEXPECTED");
      }
      if (frame.requestDigest !== pending.request.requestDigest) fail("NATIVE_REQUEST_DIGEST_MISMATCH");
      const result = frame.error ? undefined : parseResult(pending.request.method, frame.result);
      state.pending.delete(frame.requestId); pending.dispose();
      state.retired.set(frame.requestId, { digest: frame.requestDigest, method: pending.request.method });
      if (state.retired.size > 256) state.retired.delete(state.retired.keys().next().value!);
      if (frame.error) pending.reject(Object.assign(new Error(frame.error.code), { code: frame.error.code }));
      else pending.resolve(result);
    } catch {
      channel.revoke();
      throw Object.assign(new Error("Invalid native response."), { code: "NATIVE_REQUEST_RESPONSE_INVALID" });
    }
  };
}

export interface OriginalMcpNativeRequestOptions { signal?: AbortSignal; timeoutMs?: number }
export function originalMcpNativeSupportedMethods(session: AuthenticatedOriginalMcpNativeSession): readonly OriginalMcpNativeRequestMethod[] {
  assertAuthenticatedOriginalMcpNativeSession(session);
  return Object.freeze([...(channels.get(session)?.supported ?? [])].sort());
}
/** Support advertisement is availability only, never a request approval. */
export async function waitForOriginalMcpNativeSupport(session: AuthenticatedOriginalMcpNativeSession,
  options: OriginalMcpNativeRequestOptions = {}): Promise<readonly OriginalMcpNativeRequestMethod[]> {
  assertAuthenticatedOriginalMcpNativeSession(session);
  const state = channels.get(session);
  if (!state) fail("MISSING_NATIVE_METHOD");
  if (state.supportsSeen) return originalMcpNativeSupportedMethods(session);
  if (state.supportWaiters.size >= 16) fail("NATIVE_REQUEST_BUSY");
  const timeoutMs = options.timeoutMs ?? 30000;
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 120000) fail("NATIVE_REQUEST_LIMIT_INVALID");
  await new Promise<void>((resolve, reject) => {
    const refused = (code: string) => { waiter.dispose(); state.supportWaiters.delete(waiter); reject(Object.assign(new Error(code), { code })); };
    const timer = setTimeout(() => refused("MISSING_NATIVE_METHOD"), timeoutMs);
    const aborted = () => refused("NATIVE_REQUEST_CANCELLED");
    const waiter = { resolve, reject, dispose() { clearTimeout(timer); options.signal?.removeEventListener("abort", aborted); } };
    state.supportWaiters.add(waiter); options.signal?.addEventListener("abort", aborted, { once: true });
    if (options.signal?.aborted) aborted();
  });
  return originalMcpNativeSupportedMethods(session);
}
export async function requestOriginalMcpNative(session: AuthenticatedOriginalMcpNativeSession,
  method: OriginalMcpNativeRequestMethod, payload: unknown, options: OriginalMcpNativeRequestOptions = {}): Promise<unknown> {
  assertAuthenticatedOriginalMcpNativeSession(session);
  const state = channels.get(session);
  if (!state || !originalMcpNativeRequestMethods.includes(method) || !state.supported.has(method)) fail("MISSING_NATIVE_METHOD");
  if (options.signal?.aborted) fail("NATIVE_REQUEST_CANCELLED");
  const timeoutMs = options.timeoutMs ?? 30000;
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 120000) fail("NATIVE_REQUEST_LIMIT_INVALID");
  if (state.pending.size >= 16) fail("NATIVE_REQUEST_BUSY");
  boundedJson(payload, state.maximumBytes);
  const body = { protocol: originalMcpNativeRequestProtocol, requestId: randomUUID(),
    session: originalMcpNativeRequestSession(session), method, payload: parsePayload(method, payload, originalMcpNativeRequestSession(session)) };
  const request = parseOriginalMcpNativeRequest({ type: "native-request", ...body, requestDigest: originalMcpRequestDigest(body) });
  if (Buffer.byteLength(JSON.stringify(request) + "\n") > state.maximumBytes) fail("NATIVE_REQUEST_TOO_LARGE");
  return new Promise((resolve, reject) => {
    const cancel = (code: string) => {
      if (!state.pending.delete(request.requestId)) return;
      dispose(); state.retired.set(request.requestId, { digest: request.requestDigest, method });
      if (state.retired.size > 256) state.retired.delete(state.retired.keys().next().value!);
      try { state.channel.send({ type: "native-cancel", protocol: originalMcpNativeRequestProtocol, requestId: request.requestId,
        session: request.session, requestDigest: request.requestDigest }); } catch { state.channel.revoke(); }
      reject(Object.assign(new Error(code), { code }));
    };
    const timer = setTimeout(() => cancel("NATIVE_REQUEST_TIMEOUT"), timeoutMs);
    const aborted = () => cancel("NATIVE_REQUEST_CANCELLED");
    const dispose = () => { clearTimeout(timer); options.signal?.removeEventListener("abort", aborted); };
    state.pending.set(request.requestId, { request, resolve: value => {
      try { session.assertCurrent(); if (options.signal?.aborted) fail("NATIVE_REQUEST_CANCELLED"); resolve(value); }
      catch (error) { reject(error); }
    }, reject, dispose });
    options.signal?.addEventListener("abort", aborted, { once: true });
    try {
      session.assertCurrent();
      if (options.signal?.aborted) { aborted(); return; }
      state.channel.send(request);
    } catch (error) { state.pending.delete(request.requestId); dispose(); reject(error); }
  });
}

/** Real session only; no supplied transport, approval callback or fake model provider. */
export function createOriginalMcpNativeRequestPolicy(session: AuthenticatedOriginalMcpNativeSession,
  options: { toolCatalog?: readonly ToolGatewayBinding[];
    subscriptionSource?: OriginalMcpNativeHostPolicy["subscriptionSource"] } = {}): OriginalMcpNativeHostPolicy {
  assertAuthenticatedOriginalMcpNativeSession(session);
  const assertCurrent: OriginalMcpNativeHostPolicy["assertCurrent"] = binding => {
    session.assertCurrent();
    checkHostBinding(hostBinding.parse(binding), originalMcpNativeRequestSession(session));
  };
  const approve = async (method: OriginalMcpNativeRequestMethod, payload: unknown, signal?: AbortSignal) => {
    try {
      return (await requestOriginalMcpNative(session, method, payload, { ...(signal ? { signal } : {}) }) as z.infer<typeof decision>).decision === "approve";
    } catch (error) {
      if (error && typeof error === "object" && "code" in error && error.code === "NATIVE_DENIED") return false;
      throw error;
    }
  };
  const toolCatalog = options.toolCatalog?.length
    ? Object.freeze(options.toolCatalog.map(item => Object.freeze({ ...item }))) : undefined;
  return Object.freeze({
    profileSha256: session.binding.profileSha256, sourceCatalogSha256: session.binding.catalogSha256,
    authorityId: `native-rpc:${session.brokerId}`, epoch: session.activationId, signal: session.signal, assertCurrent,
    actionPackages: Object.freeze({
      source: (input: Parameters<NonNullable<OriginalMcpNativeHostPolicy["actionPackages"]>["source"]>[0], signal: AbortSignal) =>
        requestOriginalMcpNative(session, "action.package.source.approve", input, { signal, timeoutMs: 120000 }),
      destination: (input: Parameters<NonNullable<OriginalMcpNativeHostPolicy["actionPackages"]>["destination"]>[0], signal: AbortSignal) =>
        requestOriginalMcpNative(session, "action.package.destination.approve", input, { signal, timeoutMs: 120000 }),
      current: (input: Parameters<NonNullable<OriginalMcpNativeHostPolicy["actionPackages"]>["current"]>[0], signal: AbortSignal) =>
        requestOriginalMcpNative(session, "action.package.decision.current", input, { signal, timeoutMs: 3000 }),
    }),
    authorizeAdmission: (binding: Parameters<OriginalMcpNativeHostPolicy["authorizeAdmission"]>[0]) => approve("admission.approve", { binding }),
    authorizePublic: (input: Parameters<NonNullable<OriginalMcpNativeHostPolicy["authorizePublic"]>>[0], signal: AbortSignal) => {
      const { request, ...binding } = input;
      return approve("public.approve", { binding, request }, signal);
    },
    ...(options.subscriptionSource ? { subscriptionSource: options.subscriptionSource,
      authorizeSubscriptionRead: (input: Parameters<NonNullable<OriginalMcpNativeHostPolicy["authorizeSubscriptionRead"]>>[0], signal: AbortSignal) => {
        const { request, ...binding } = input;
        return requestOriginalMcpNative(session, originalSubscriptionReadMethod, { binding, ...request }, { signal });
      } } : {}),
    approveTool: (input: Parameters<NonNullable<OriginalMcpNativeHostPolicy["approveTool"]>>[0], signal: AbortSignal) => {
      const { request, ...binding } = input;
      return approve("tool.approve", { binding, request }, signal);
    },
    ...(toolCatalog ? { toolCatalog } : {}),
    reviewTool: async (input: Parameters<NonNullable<OriginalMcpNativeHostPolicy["reviewTool"]>>[0]) => {
      const { review, ...binding } = input;
      if (!toolCatalog
        && !["chat.task.get", "chat.task.report_work", "chat.task.record_harness"].includes(review.record.tool))
        fail("NATIVE_REQUEST_TOOL_NOT_AVAILABLE");
      return await requestOriginalMcpNative(session, "tool.review", { binding, review }) as z.infer<typeof reviewDecision>;
    },
    models: Object.freeze({
      configuration: Object.freeze({}), registryAvailability: Object.freeze({}),
      async credentialAvailable(input: Parameters<OriginalMcpNativeHostPolicy["models"]["credentialAvailable"]>[0]) {
        const { secretId, ...binding } = input;
        return (await requestOriginalMcpNative(session, "credential.present", { binding, secretId }) as { present: boolean }).present;
      },
      authorizeRequest(input: Parameters<OriginalMcpNativeHostPolicy["models"]["authorizeRequest"]>[0], signal?: AbortSignal) {
        const { provider, model, requestSha256, ...binding } = input;
        return approve("model.approve", { binding, provider, model, requestSha256 }, signal);
      },
      transport: Object.freeze({ supports: () => false, async open(): Promise<ReadableStream<Uint8Array>> { return fail("MISSING_NATIVE_METHOD"); } }),
    }),
  });
}
