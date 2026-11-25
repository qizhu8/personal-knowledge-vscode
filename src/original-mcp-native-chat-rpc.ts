import { createHash, randomUUID } from "node:crypto";
import { z } from "zod";
import {
  assertAuthenticatedOriginalMcpNativeSession, type AuthenticatedOriginalMcpNativeSession,
} from "./original-mcp-native-attachment.js";
import {
  originalNativeChatCatalogue, originalNativeChatDigest, originalNativeChatInferenceDigest,
  originalVscodeModelRequestDigest, type OriginalNativeChatExecutionPort,
  type OriginalVscodeChatModelPort, type OriginalNativeChatExecutionPlan,
  originalNativeChatResolve, originalNativeChatRequest, originalNativeChatPresentation,
  originalNativeChatSelection, originalNativeChatMemoryRequest, originalNativeChatMemoryChoice,
  type OriginalNativeChatSessionPort, type OriginalNativeChatMemoryPort,
} from "./original-mcp-api-chat-contracts.js";
import type { ModelProviderEvent } from "./model-provider-contracts.js";
import {
  originalNativeTaskExecutionMethod, originalNativeTaskBinding, originalNativeTaskContextRequest, originalNativeTaskContextResult,
  type OriginalNativeTaskCapableExecutionPort,
} from "./original-mcp-api-chat-task-execution-contracts.js";
import { dispatchOriginalMcpApiChatTaskContext } from "./original-mcp-api-chat-task-adapter.js";
import {
  originalManagedTaskAdoptionRequest, originalManagedTaskAdoptionDecision,
  type OriginalManagedTaskAdoptionPort,
} from "./managed-chat-task-adoption-contracts.js";
import {
  originalSdkCatalogue, originalSdkSelection, originalSdkSendingBoundary, originalSdkSessionRequest,
  originalSdkToolRequest, originalSdkTextRequest, originalSdkUsageRequest, originalSdkDigest,
  originalSdkChatSelection, type OriginalSdkChatPort, type OriginalSdkChatPlan,
  originalSdkUnavailableStatus, type OriginalSdkUnavailableStatus, type OriginalSdkExecutionCallbacks,
} from "./original-mcp-sdk-model-contracts.js";

export const originalMcpNativeChatProtocol = "pkm.original-mcp-native-chat-rpc/v1" as const;
const sessionMethods = ["chat.resolve", "chat.authorize", "chat.present"] as const;
const memoryMethod = "chat.memory.select" as const;
const adoptionMethod = "chat.task.adopt" as const;
const sdkMethods = ["sdk.catalogue", "sdk.select", "sdk.measure", "sdk.authorizeBoundary", "sdk.execution"] as const;
export const originalMcpNativeChatMethods = Object.freeze([
  "models.catalogue", "models.select", "models.count", "models.stream", "execution.run",
  ...sessionMethods,
  memoryMethod,
  originalNativeTaskExecutionMethod,
  adoptionMethod,
  ...sdkMethods,
  "sdk.status",
] as const);
export const originalMcpNativeChatLimits = Object.freeze({
  payloadBytes: 16 * 1024 * 1024, queuedBytes: 32 * 1024 * 1024,
  chunkBytes: 4096, pendingRequests: 2, queuedTransfers: 4, callbackCount: 262144,
});
export type OriginalMcpNativeChatMethod = typeof originalMcpNativeChatMethods[number];
type Method = OriginalMcpNativeChatMethod;
const digest = z.string().regex(/^[a-f0-9]{64}$/), id = z.string().uuid();
const text = z.string().min(1).max(512), integer = z.number().int().nonnegative().safe();
const args = z.record(z.string(), z.json());
export const originalMcpNativeChatSessionSchema = z.strictObject({
  brokerId: id, activationId: id, identitySha256: digest, epoch: id,
  binding: z.strictObject({
    root: z.string().min(1).max(4096), workspaceId: id, planSha256: digest, catalogSha256: digest,
    profileSha256: digest, payloadBuildId: digest, hostEntrySha256: digest,
  }),
}).refine(value => value.epoch === value.activationId);
export type OriginalMcpNativeChatSession = z.infer<typeof originalMcpNativeChatSessionSchema>;
const tool = z.strictObject({ name: z.string().min(1).max(200), description: z.string(), parameters: args });
const message = z.strictObject({
  role: z.enum(["system", "user", "assistant", "tool"]), content: z.string(),
  tool_call_id: text.optional(),
  tool_calls: z.array(z.strictObject({ id: text, type: z.literal("function"),
    function: z.strictObject({ name: text, arguments: z.string() }) })).max(16).optional(),
  images: z.array(z.strictObject({ label: text, mimeType: z.enum(["image/png", "image/jpeg"]),
    dataBase64: z.string() })).max(128).optional(),
});
const inference = z.strictObject({
  selectionId: text, requestId: text, requestSha256: digest,
  messages: z.array(message).max(65536), tools: z.array(tool).max(4096),
  outputTokenCap: z.number().int().min(1).max(8192),
});
export const originalMcpNativeChatExecutionPlanSchema = z.strictObject({
  schema: z.literal("pkm.original-api-chat-execution/v1"), requestId: text, chatUrl: text,
  selectionId: text, sourcePlanSha256: digest, messages: z.array(message).max(65536),
  tools: z.array(tool).max(4096), hardToolRoundLimit: z.number().int().min(1).max(1000).nullable(),
  outputTokenCap: z.number().int().min(1).max(8192),
  budget: z.strictObject({ maxInputTokens: z.number().int().positive().safe(),
    maxTotalOutputTokens: z.number().int().min(1).max(32768), deadlineMs: z.number().int().min(1).max(300000) }),
});
const managedExecutionPlan = originalMcpNativeChatExecutionPlanSchema.extend({ managedTask: originalNativeTaskBinding });
export const originalMcpSdkChatPlanSchema = originalMcpNativeChatExecutionPlanSchema.omit({ budget: true }).extend({
  schema: z.literal("pkm.original-sdk-api-chat-execution/v1"),
  epoch: text, hostReceiptSha256: digest, deadlineAtMs: z.number().int().positive().safe(),
  budget: originalSdkChatSelection.shape.budget,
});
const sdkMeasurement = z.strictObject({
  provider: z.literal("copilot-sdk"), countingMethod: z.literal("sdk-prompt-utf8-bytes"),
  serializedBytes: integer, payloadSha256: digest, providerTokenCount: z.null(),
});
export const originalMcpNativeChatPayloadSchemas = Object.freeze({
  "models.catalogue": z.strictObject({}),
  "models.select": z.strictObject({ modelId: text, catalogueSha256: digest }),
  "models.count": inference, "models.stream": inference, "execution.run": originalMcpNativeChatExecutionPlanSchema,
  "chat.resolve": originalNativeChatResolve,
  "chat.authorize": originalNativeChatRequest,
  "chat.present": originalNativeChatPresentation,
  "chat.memory.select": originalNativeChatMemoryRequest,
  [adoptionMethod]: originalManagedTaskAdoptionRequest,
  [originalNativeTaskExecutionMethod]: managedExecutionPlan,
  "sdk.catalogue": z.strictObject({}),
  "sdk.select": z.strictObject({ modelId: text, catalogueSha256: digest }),
  "sdk.measure": z.strictObject({ selectionId: text, messages: z.array(message).max(65536), tools: z.array(tool).max(4096) }),
  "sdk.authorizeBoundary": originalSdkSendingBoundary,
  "sdk.execution": originalMcpSdkChatPlanSchema,
  "sdk.status": z.strictObject({}),
});
const usage = z.strictObject({
  inputTokens: integer, outputTokens: integer, cachedInputTokens: integer.optional(),
  reasoningTokens: integer.optional(), copilotNanoAiu: z.number().finite().nonnegative().optional(),
});
export const originalMcpNativeChatEventSchema = z.discriminatedUnion("type", [
  z.strictObject({ type: z.literal("text"), text: z.string() }),
  z.strictObject({ type: z.literal("reasoning-summary"), text: z.string() }),
  usage.extend({ type: z.literal("usage") }),
  z.strictObject({ type: z.literal("tool"), id: z.string().min(1).max(200), name: text, arguments: args }),
  z.strictObject({ type: z.literal("finish"), reason: z.enum(["stop", "tool_calls", "length"]) }),
]);
export const originalMcpNativeChatCallbackSchemas = Object.freeze({
  beforeInference: z.strictObject({
    inferenceId: digest, round: z.number().int().min(0).max(1000), requestSha256: digest,
    planSha256: digest, sourcePlanSha256: digest, selectionId: text,
    nativeRequest: z.strictObject({ messages: z.array(z.json()).max(65536), options: args }),
    inputTokens: integer, countingMethod: z.literal("vscode-countTokens-plus-overhead"),
  }),
  tool: z.strictObject({
    inferenceId: digest, round: z.number().int().min(0).max(1000), callId: z.string().min(1).max(200),
    name: z.string().min(1).max(200), arguments: args, argumentsSha256: digest,
  }),
  text: z.strictObject({ inferenceId: digest, text: z.string() }),
  usage: z.strictObject({ inferenceId: digest, usage, source: z.enum(["native-counted", "provider-reported"]) }),
  taskContext: originalNativeTaskContextRequest,
  sdkSession: originalSdkSessionRequest,
  sdkSending: originalSdkSendingBoundary,
  sdkTool: originalSdkToolRequest,
  sdkText: originalSdkTextRequest,
  sdkUsage: originalSdkUsageRequest,
});
type CallbackMethod = keyof typeof originalMcpNativeChatCallbackSchemas;
const toolResult = z.strictObject({
  receiptSha256: digest, content: z.string().max(16000), effect: z.enum(["not-committed", "committed", "unknown"]),
});
const executionResult = z.strictObject({
  status: z.enum(["complete", "cancelled", "failed", "unknown"]),
  toolRoundLimit: z.strictObject({ limit: z.number().int().min(1).max(1000),
    rounds: z.number().int().min(0).max(1000), reached: z.boolean() }).nullable(),
});
const selectionResult = z.strictObject({ selectionId: text, modelId: text, epoch: text,
  maxInputTokens: z.number().int().positive().safe() });
const countResult = z.strictObject({ selectionId: text, requestSha256: digest, inputTokens: integer,
  countingMethod: z.literal("vscode-countTokens-plus-tool-overhead") });
const errorSchema = z.strictObject({
  code: z.enum(["MISSING_NATIVE_METHOD", "NATIVE_CHAT_CANCELLED", "NATIVE_CHAT_TIMEOUT",
    "NATIVE_CHAT_FAILED", "NATIVE_CHAT_CORE_CALLBACK_FAILED", "NATIVE_CHAT_DISPATCH_UNCERTAIN",
    "NATIVE_SDK_RUNTIME_INCOMPATIBLE", "NATIVE_SDK_UNSUPPORTED_AUTHORITY", "NATIVE_SDK_CANCELLED",
    "NATIVE_SDK_EXPIRED", "NATIVE_SDK_BUDGET_EXCEEDED", "NATIVE_SDK_CONTEXT_DENIED",
    "NATIVE_SDK_DESTINATION_DENIED", "NATIVE_SDK_REPLAY_DENIED", "NATIVE_SDK_FORWARDING_FAILED",
    "NATIVE_SDK_ACCOUNT_UNAVAILABLE", "NATIVE_SDK_CLIENT_CONFIG_DENIED", "NATIVE_SDK_CLIENT_UNAVAILABLE",
    "NATIVE_SDK_SESSION_BINDING_DENIED", "NATIVE_SDK_SESSION_CONFIG_DENIED", "NATIVE_SDK_CLEANUP_UNCONFIRMED",
    "NATIVE_SDK_STALE_CATALOGUE", "NATIVE_SDK_STALE_SELECTION", "NATIVE_SDK_MODEL_UNAVAILABLE",
    "NATIVE_SDK_TOOL_BINDING_DENIED", "NATIVE_SDK_TOOL_OUTCOME_UNKNOWN", "NATIVE_SDK_EXECUTION_FAILED",
    "NATIVE_SDK_LOGICAL_SEND_IDENTITY_UNVERIFIED", "NATIVE_SDK_CATALOGUE_CONTROL_EGRESS_UNSUPPORTED"]),
  dispatch: z.enum(["not-sent", "uncertain"]),
});
const common = { protocol: z.literal(originalMcpNativeChatProtocol), session: originalMcpNativeChatSessionSchema };
const transfer = { ...common, transferId: id, requestId: id, requestDigest: digest };
export const originalMcpNativeChatFrameSchema = z.discriminatedUnion("type", [
  z.strictObject({ type: z.literal("native-chat-supports"), ...common,
    methods: z.array(z.enum(originalMcpNativeChatMethods)).max(originalMcpNativeChatMethods.length), maxPacketBytes: z.number().int().min(2048).max(65536) }),
  z.strictObject({ type: z.literal("native-chat-ready"), ...common,
    methods: z.array(z.enum(originalMcpNativeChatMethods)).max(originalMcpNativeChatMethods.length), chunkBytes: z.number().int().min(128).max(4096),
    maxPayloadBytes: z.literal(originalMcpNativeChatLimits.payloadBytes) }),
  z.strictObject({ type: z.literal("native-chat-open"), ...transfer,
    byteLength: z.number().int().min(1).max(originalMcpNativeChatLimits.payloadBytes), sha256: digest }),
  z.strictObject({ type: z.literal("native-chat-chunk"), ...transfer,
    sequence: integer, data: z.string().min(1).max(5464) }),
  z.strictObject({ type: z.literal("native-chat-ack"), ...transfer, nextSequence: integer }),
  z.strictObject({ type: z.literal("native-chat-cancel"), ...common, requestId: id, requestDigest: digest }),
]);
export type OriginalMcpNativeChatFrame = z.infer<typeof originalMcpNativeChatFrameSchema>;
const base = { requestId: id, requestDigest: digest };
const requestSchema = z.strictObject({ kind: z.literal("request"), ...base,
  method: z.enum(originalMcpNativeChatMethods), payload: z.unknown() });
type Request = Omit<z.infer<typeof requestSchema>, "payload"> & { payload: any };
const resultSchema = z.strictObject({ kind: z.literal("result"), ...base,
  result: z.unknown().optional(), error: errorSchema.optional(),
}).refine(value => ("result" in value) !== ("error" in value));
const eventSchema = z.strictObject({ kind: z.literal("event"), ...base, sequence: integer,
  event: originalMcpNativeChatEventSchema });
const callbackSchema = z.strictObject({
  kind: z.literal("callback"), ...base, callbackId: id, sequence: integer,
  method: z.enum(["beforeInference", "tool", "text", "usage", "taskContext",
    "sdkSession", "sdkSending", "sdkTool", "sdkText", "sdkUsage"]), payload: z.unknown(), callbackDigest: digest,
});
const callbackResultSchema = z.strictObject({
  kind: z.literal("callback-result"), ...base, callbackId: id, callbackDigest: digest,
  result: z.unknown().optional(), error: errorSchema.optional(),
}).refine(value => ("result" in value) !== ("error" in value));
type Logical = { kind: string; requestId: string; requestDigest: string; [key: string]: any };
type Wire = { send(frame: OriginalMcpNativeChatFrame): void | Promise<void>; close(): void | Promise<void> };
export class OriginalMcpNativeChatRpcError extends Error {
  constructor(readonly code: string, readonly dispatch: "not-sent" | "uncertain" = "not-sent", options?: ErrorOptions) {
    super(code, options); this.name = "OriginalMcpNativeChatRpcError";
  }
}
function fail(code: string): never { throw new OriginalMcpNativeChatRpcError(code); }
const same = (left: unknown, right: unknown) => originalNativeChatDigest(left) === originalNativeChatDigest(right);
function freeze<T>(value: T): T {
  if (value && typeof value === "object") { for (const child of Object.values(value)) freeze(child); Object.freeze(value); }
  return value;
}
function portable(value: unknown): Buffer {
  const ancestors = new Set<object>();
  let bytes = 0, nodes = 0;
  const add = (n: number) => { if ((bytes += n) > originalMcpNativeChatLimits.payloadBytes) fail("NATIVE_CHAT_PAYLOAD_LIMIT"); };
  const string = (s: string) => {
    if (Buffer.byteLength(s) > originalMcpNativeChatLimits.payloadBytes) fail("NATIVE_CHAT_PAYLOAD_LIMIT");
    add(Buffer.byteLength(JSON.stringify(s)));
  };
  function visit(item: unknown, depth: number) {
    if (++nodes > 1000000 || depth > 64) fail("NATIVE_CHAT_PAYLOAD_LIMIT");
    if (typeof item === "string") { string(item); return; }
    if (item === null || typeof item === "boolean" || typeof item === "number" && Number.isFinite(item)) {
      add(Buffer.byteLength(JSON.stringify(item))); return;
    }
    if (!item || typeof item !== "object" || ancestors.has(item)
      || !Array.isArray(item) && ![Object.prototype, null].includes(Object.getPrototypeOf(item))) fail("NATIVE_CHAT_JSON_INVALID");
    ancestors.add(item); add(2);
    if (Array.isArray(item)) {
      if (Object.keys(item).length !== item.length) fail("NATIVE_CHAT_JSON_INVALID");
      for (const child of item) { add(1); visit(child, depth + 1); }
    } else for (const key of Object.keys(item)) {
      if (/^(?:api[_-]?key|password|authorization|access[_-]?token|refresh[_-]?token|private[_-]?key|credentials?|secret)$/i.test(key))
        fail("NATIVE_CHAT_CREDENTIAL_FIELD");
      const property = Object.getOwnPropertyDescriptor(item, key);
      if (!property || !("value" in property)) fail("NATIVE_CHAT_JSON_INVALID");
      string(key); add(2); visit(property.value, depth + 1);
    }
    ancestors.delete(item);
  }
  visit(value, 0);
  return Buffer.from(JSON.stringify(value), "utf8");
}
export function originalMcpNativeChatSession(session: AuthenticatedOriginalMcpNativeSession): OriginalMcpNativeChatSession {
  assertAuthenticatedOriginalMcpNativeSession(session);
  return freeze(originalMcpNativeChatSessionSchema.parse({
    brokerId: session.brokerId, activationId: session.activationId, identitySha256: session.identitySha256,
    epoch: session.activationId, binding: session.binding,
  }));
}
function parseRequest(value: unknown, session: OriginalMcpNativeChatSession): Request {
  portable(value);
  const parsed = requestSchema.parse(value);
  const payload = originalMcpNativeChatPayloadSchemas[parsed.method].parse(parsed.payload);
  if ("tools" in payload && new Set(payload.tools.map(item => item.name)).size !== payload.tools.length)
    fail("NATIVE_CHAT_TOOLS_INVALID");
  if (parsed.method === "models.count" || parsed.method === "models.stream") {
    const input = inference.parse(payload), { requestSha256, ...body } = input;
    if (originalVscodeModelRequestDigest(body) !== requestSha256) fail("NATIVE_CHAT_REQUEST_DIGEST");
  }
  if (parsed.method === memoryMethod) {
    const input = originalNativeChatMemoryRequest.parse(payload);
    if (input.selection.epoch !== session.activationId || input.selection.provider !== "vscode")
      fail("NATIVE_CHAT_MEMORY_BINDING");
  }
  if (parsed.method === adoptionMethod) {
    const input = originalManagedTaskAdoptionRequest.parse(payload);
    if (input.selection.epoch !== session.activationId || input.selection.provider !== "vscode")
      fail("NATIVE_CHAT_ADOPTION_BINDING");
  }
  if (parsed.method === originalNativeTaskExecutionMethod) {
    const plan = managedExecutionPlan.parse(payload), { bindingSha256, ...binding } = plan.managedTask;
    if (binding.requestId !== plan.requestId || binding.sourcePlanSha256 !== plan.sourcePlanSha256
      || binding.nativeEpoch !== session.epoch || !plan.chatUrl.endsWith(`/${binding.chatId}`)
      || originalNativeChatDigest(binding) !== bindingSha256) fail("NATIVE_CHAT_TASK_BINDING");
  }
  if (parsed.method === "sdk.execution" && originalMcpSdkChatPlanSchema.parse(payload).epoch !== session.epoch)
    fail("NATIVE_CHAT_SDK_SESSION_BINDING");
  const expected = originalNativeChatDigest({
    protocol: originalMcpNativeChatProtocol, session, requestId: parsed.requestId, method: parsed.method, payload,
  });
  if (expected !== parsed.requestDigest) fail("NATIVE_CHAT_REQUEST_DIGEST");
  return freeze({ ...parsed, payload });
}
export function parseOriginalMcpNativeChatRequest(value: unknown, session: OriginalMcpNativeChatSession) {
  return parseRequest(value, originalMcpNativeChatSessionSchema.parse(session));
}
function parsedResult(method: Method, value: unknown) {
  if (method === "sdk.status") return originalSdkUnavailableStatus.parse(value);
  if (method === "sdk.catalogue") return originalSdkCatalogue.parse(value);
  if (method === "sdk.select") return originalSdkSelection.parse(value);
  if (method === "sdk.measure") return sdkMeasurement.parse(value);
  if (method === "sdk.authorizeBoundary") return z.null().parse(value);
  if (method === "sdk.execution") return executionResult.parse(value);
  if (method === "chat.resolve") return originalNativeChatSelection.parse(value);
  if (method === "chat.authorize") return z.boolean().parse(value);
  if (method === "chat.present") return z.null().parse(value);
  if (method === memoryMethod) return originalNativeChatMemoryChoice.parse(value);
  if (method === adoptionMethod) return originalManagedTaskAdoptionDecision.parse(value);
  if (method === "models.catalogue") return originalNativeChatCatalogue.parse(value);
  if (method === "models.select") return selectionResult.parse(value);
  if (method === "models.count") return countResult.parse(value);
  if (method === "execution.run" || method === originalNativeTaskExecutionMethod) return executionResult.parse(value);
  return z.strictObject({ complete: z.literal(true) }).parse(value);
}
function callbackHash(value: z.infer<typeof callbackSchema>) {
  const { callbackDigest: _digest, kind: _kind, ...body } = value;
  return originalNativeChatDigest(body);
}

/** One queued, acknowledged transfer per direction; no request-sized socket writes. */
class Peer {
  methods = new Set<Method>();
  ready = false;
  chunkBytes = 128;
  private incoming?: {
    frame: Extract<OriginalMcpNativeChatFrame, { type: "native-chat-open" }>;
    data: Buffer; offset: number; sequence: number; timer: ReturnType<typeof setTimeout>;
  };
  private ack?: { transferId: string; requestId: string; requestDigest: string; next: number;
    resolve(): void; reject(error: unknown): void };
  private chain: Promise<void> = Promise.resolve();
  private queuedBytes = 0;
  private queued = 0;
  private stopped = false;
  private fatalTask?: Promise<void>;
  private resolveClosed!: () => void;
  private rejectClosed!: (error: unknown) => void;
  readonly closed: Promise<void>;
  private outgoingRetired = new Map<string, { requestId: string; requestDigest: string }>();
  private cancelled = new Map<string, string>();
  private supportWaiters = new Set<{ resolve(): void; reject(error: unknown): void }>();
  constructor(readonly session: OriginalMcpNativeChatSession, private readonly wire: Wire,
    private readonly check: () => void, private readonly maximumPacket: number,
    private readonly role: "node" | "producer", private readonly logical: (value: Logical) => void | Promise<void>,
    private readonly cancellation: (requestId: string, requestDigest: string) => void,
    private readonly failure: (error: unknown) => void) {
    this.closed = new Promise<void>((resolve, reject) => { this.resolveClosed = resolve; this.rejectClosed = reject; });
    void this.closed.catch(() => {});
  }
  assertCurrent() { if (this.stopped) fail("NATIVE_CHAT_CLOSED"); this.check(); }
  async frame(value: OriginalMcpNativeChatFrame) {
    this.assertCurrent();
    if (Buffer.byteLength(JSON.stringify(value) + "\n") > this.maximumPacket) fail("NATIVE_CHAT_FRAME_LIMIT");
    await this.wire.send(value);
    this.assertCurrent();
  }
  async advertise(methods: readonly Method[] = originalMcpNativeChatMethods) {
    if (this.role !== "producer") fail("NATIVE_CHAT_DIRECTION");
    await this.frame({ type: "native-chat-supports", protocol: originalMcpNativeChatProtocol, session: this.session,
      methods: [...methods], maxPacketBytes: this.maximumPacket });
  }
  async wait(signal?: AbortSignal, timeoutMs = 30000) {
    this.assertCurrent();
    if (signal?.aborted) fail("NATIVE_CHAT_CANCELLED");
    if (this.ready) return;
    if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 300000 || this.supportWaiters.size >= 16)
      fail("NATIVE_CHAT_LIMIT_INVALID");
    await new Promise<void>((resolve, reject) => {
      const dispose = () => { clearTimeout(timer); signal?.removeEventListener("abort", abort); this.supportWaiters.delete(waiter); };
      const abort = () => { dispose(); reject(new OriginalMcpNativeChatRpcError("NATIVE_CHAT_CANCELLED")); };
      const waiter = { resolve: () => { dispose(); resolve(); }, reject: (error: unknown) => { dispose(); reject(error); } };
      const timer = setTimeout(() => { dispose(); reject(new OriginalMcpNativeChatRpcError("MISSING_NATIVE_METHOD")); }, timeoutMs);
      this.supportWaiters.add(waiter); signal?.addEventListener("abort", abort, { once: true });
      if (signal?.aborted) abort();
    });
  }
  private retire(transferId: string, requestId: string, requestDigest: string) {
    this.outgoingRetired.set(transferId, { requestId, requestDigest });
    if (this.outgoingRetired.size > 512) this.outgoingRetired.delete(this.outgoingRetired.keys().next().value!);
  }
  cancel(requestId: string, requestDigest: string, notify = true) {
    this.cancelled.set(requestId, requestDigest);
    if (this.cancelled.size > 4096) this.cancelled.delete(this.cancelled.keys().next().value!);
    if (this.incoming?.frame.requestId === requestId) { clearTimeout(this.incoming.timer); this.incoming = undefined; }
    if (this.ack?.requestId === requestId) {
      this.retire(this.ack.transferId, this.ack.requestId, this.ack.requestDigest);
      this.ack.reject(new OriginalMcpNativeChatRpcError("NATIVE_CHAT_CANCELLED", "uncertain"));
    }
    if (notify && !this.stopped) void this.frame({
      type: "native-chat-cancel", protocol: originalMcpNativeChatProtocol, session: this.session, requestId, requestDigest,
    }).catch(error => this.fatal(error));
  }
  send(value: Logical): Promise<void> {
    this.assertCurrent();
    if (!this.ready) fail("MISSING_NATIVE_METHOD");
    const bytes = portable(value);
    if (this.queued >= originalMcpNativeChatLimits.queuedTransfers
      || this.queuedBytes + bytes.length > originalMcpNativeChatLimits.queuedBytes) fail("NATIVE_CHAT_BACKPRESSURE");
    this.queued++; this.queuedBytes += bytes.length;
    const task = this.chain.then(async () => {
      this.assertCurrent();
      if (this.cancelled.has(value.requestId)) fail("NATIVE_CHAT_CANCELLED");
      const transferId = randomUUID();
      const envelope = { protocol: originalMcpNativeChatProtocol, session: this.session,
        transferId, requestId: value.requestId, requestDigest: value.requestDigest };
      const send = async (frame: OriginalMcpNativeChatFrame, next: number) => {
        await new Promise<void>((resolve, reject) => {
          const timer = setTimeout(() => { reject(new OriginalMcpNativeChatRpcError("NATIVE_CHAT_TIMEOUT", "uncertain")); }, 30000);
          const dispose = () => { clearTimeout(timer); if (this.ack === waiter) this.ack = undefined; };
          const waiter = { transferId, requestId: value.requestId, requestDigest: value.requestDigest, next,
            resolve: () => { dispose(); resolve(); }, reject: (error: unknown) => { dispose(); reject(error); } };
          this.ack = waiter;
          void this.frame(frame).catch(error => waiter.reject(error));
        });
      };
      try {
        await send({ type: "native-chat-open", ...envelope, byteLength: bytes.length,
          sha256: createHash("sha256").update(bytes).digest("hex") }, 0);
        for (let offset = 0, sequence = 0; offset < bytes.length; offset += this.chunkBytes, sequence++) {
          if (this.cancelled.has(value.requestId)) fail("NATIVE_CHAT_CANCELLED");
          await send({ type: "native-chat-chunk", ...envelope, sequence,
            data: bytes.subarray(offset, offset + this.chunkBytes).toString("base64") }, sequence + 1);
        }
      } finally { this.retire(transferId, value.requestId, value.requestDigest); }
    });
    this.chain = task.catch(error => {
      if (!this.stopped && !(error instanceof OriginalMcpNativeChatRpcError && error.code === "NATIVE_CHAT_CANCELLED")) this.fatal(error);
    });
    return task.finally(() => { this.queued--; this.queuedBytes -= bytes.length; });
  }
  receive(value: unknown) {
    if (this.stopped) return;
    try {
      this.assertCurrent();
      const frame = originalMcpNativeChatFrameSchema.parse(value);
      if (Buffer.byteLength(JSON.stringify(frame) + "\n") > this.maximumPacket || !same(frame.session, this.session))
        fail("NATIVE_CHAT_SESSION_MISMATCH");
      if (frame.type === "native-chat-supports" || frame.type === "native-chat-ready") {
        if (this.ready || new Set(frame.methods).size !== frame.methods.length) fail("NATIVE_CHAT_SUPPORT_INVALID");
        if (frame.type === "native-chat-supports") {
          if (this.role !== "node") fail("NATIVE_CHAT_DIRECTION");
          const allowance = Math.min(this.maximumPacket, frame.maxPacketBytes) - Buffer.byteLength(JSON.stringify({
            type: "native-chat-chunk", ...this.envelope(randomUUID(), randomUUID(), "0".repeat(64)), sequence: 100000, data: "",
          })) - 8;
          this.chunkBytes = Math.min(originalMcpNativeChatLimits.chunkBytes, Math.floor(allowance / 4) * 3);
          if (this.chunkBytes < 128) fail("NATIVE_CHAT_FRAME_LIMIT");
          this.methods = new Set(frame.methods); this.ready = true;
          void this.frame({ type: "native-chat-ready", protocol: originalMcpNativeChatProtocol, session: this.session,
            methods: frame.methods, chunkBytes: this.chunkBytes, maxPayloadBytes: originalMcpNativeChatLimits.payloadBytes,
          }).catch(error => this.fatal(error));
        } else {
          if (this.role !== "producer") fail("NATIVE_CHAT_DIRECTION");
          this.methods = new Set(frame.methods); this.chunkBytes = frame.chunkBytes; this.ready = true;
        }
        for (const waiter of this.supportWaiters) waiter.resolve();
        return;
      }
      if (!this.ready) fail("MISSING_NATIVE_METHOD");
      if (frame.type === "native-chat-cancel") {
        this.cancel(frame.requestId, frame.requestDigest, false); this.cancellation(frame.requestId, frame.requestDigest); return;
      }
      if (frame.type === "native-chat-ack") {
        const ack = this.ack;
        if (ack && ack.transferId === frame.transferId && ack.requestId === frame.requestId
          && ack.requestDigest === frame.requestDigest && ack.next === frame.nextSequence) { ack.resolve(); return; }
        const retired = this.outgoingRetired.get(frame.transferId);
        if (retired && retired.requestId === frame.requestId && retired.requestDigest === frame.requestDigest) return;
        fail("NATIVE_CHAT_ACK_INVALID");
      }
      if (this.cancelled.has(frame.requestId)) {
        if (this.cancelled.get(frame.requestId) !== frame.requestDigest) fail("NATIVE_CHAT_REQUEST_DIGEST");
        return;
      }
      if (frame.type === "native-chat-open") {
        if (this.incoming) fail("NATIVE_CHAT_TRANSFER_OVERLAP");
        this.incoming = { frame, data: Buffer.allocUnsafe(frame.byteLength), offset: 0, sequence: 0,
          timer: setTimeout(() => this.fatal(new OriginalMcpNativeChatRpcError("NATIVE_CHAT_TIMEOUT", "uncertain")), 30000) };
        void this.frame({ type: "native-chat-ack", ...this.envelope(frame.transferId, frame.requestId, frame.requestDigest),
          nextSequence: 0 }).catch(error => this.fatal(error)); return;
      }
      const incoming = this.incoming;
      if (!incoming || incoming.frame.transferId !== frame.transferId || incoming.frame.requestId !== frame.requestId
        || incoming.frame.requestDigest !== frame.requestDigest || incoming.sequence !== frame.sequence)
        fail("NATIVE_CHAT_CHUNK_SEQUENCE");
      const part = Buffer.from(frame.data, "base64");
      if (!part.length || part.length > this.chunkBytes || part.toString("base64") !== frame.data
        || incoming.offset + part.length > incoming.frame.byteLength) fail("NATIVE_CHAT_CHUNK_INVALID");
      incoming.timer.refresh();
      part.copy(incoming.data, incoming.offset); incoming.offset += part.length; incoming.sequence++;
      const acknowledge = () => this.frame({ type: "native-chat-ack",
        ...this.envelope(frame.transferId, frame.requestId, frame.requestDigest), nextSequence: incoming.sequence });
      if (incoming.offset < incoming.frame.byteLength) {
        void acknowledge().catch(error => this.fatal(error)); return;
      }
      clearTimeout(incoming.timer); this.incoming = undefined;
      if (createHash("sha256").update(incoming.data).digest("hex") !== incoming.frame.sha256)
        fail("NATIVE_CHAT_TRANSFER_HASH");
      const logical: Logical = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(incoming.data));
      portable(logical);
      if (logical.requestId !== frame.requestId || logical.requestDigest !== frame.requestDigest) fail("NATIVE_CHAT_REQUEST_DIGEST");
      void Promise.resolve(this.logical(logical)).then(acknowledge).catch(error => {
        if (!(error instanceof OriginalMcpNativeChatRpcError && error.code === "NATIVE_CHAT_CANCELLED")) this.fatal(error);
      });
    } catch (error) { this.fatal(error); throw error; }
  }
  private envelope(transferId: string, requestId: string, requestDigest: string) {
    return { protocol: originalMcpNativeChatProtocol, session: this.session, transferId, requestId, requestDigest };
  }
  stop(error: unknown = new OriginalMcpNativeChatRpcError("NATIVE_CHAT_CLOSED", "uncertain"), settle = true) {
    if (this.stopped) return;
    this.stopped = true;
    if (this.incoming) clearTimeout(this.incoming.timer);
    this.incoming = undefined; this.ack?.reject(error);
    for (const waiter of this.supportWaiters) waiter.reject(error);
    this.supportWaiters.clear(); this.failure(error);
    if (settle) this.resolveClosed();
  }
  fatal(error: unknown) {
    if (this.fatalTask || this.stopped) return;
    this.stop(error, false);
    this.fatalTask = (async () => {
      try { await this.wire.close(); }
      catch (cleanup) {
        const failure = new AggregateError([error, cleanup], "Native chat protocol and transport cleanup failed.");
        this.failure(failure); this.rejectClosed(failure); return;
      }
      this.rejectClosed(error);
    })();
  }
  async drain() { await this.chain; await this.closed; }
}

type Ports = Parameters<OriginalNativeChatExecutionPort["run"]>[1];
export type OriginalMcpNativeChatCanonicalCallbacks = Ports;
interface Call {
  request: Request; controller: AbortController; sent: boolean;
  resolve(value: any): void; reject(error: unknown): void; dispose(): void;
  eventSequence: number; event?: { value: ModelProviderEvent; consumed(): void };
  wake?: () => void; done: boolean; error?: unknown; ports?: Ports;
  callbackSequence: number; callbackPending: number; callbackChain: Promise<void>; blocked: boolean;
  gates: Map<string, { round: number; approved: boolean; calls: Set<string>; tools: Set<string> }>; receipts: string[];
  eventTools: Set<string>;
  streamFinished: boolean;
  taskClosed?: boolean; taskFinished?: boolean;
  sdkPorts?: OriginalSdkExecutionCallbacks;
  sdkSessions?: Map<string, { binding: z.infer<typeof originalSdkSessionRequest>["binding"]; approved: boolean; sent: boolean }>;
  sdkBoundaries?: Set<string>; sdkCalls?: Set<string>;
  sdkModelId?: string;
  sdkApprovedSends?: Map<string, string>;
}
interface NodeState {
  peer: Peer; session: AuthenticatedOriginalMcpNativeSession; pending: Map<string, Call>;
  retired: Map<string, string>; catalogue?: z.infer<typeof originalNativeChatCatalogue>;
  selections: Map<string, z.infer<typeof selectionResult>>; disposed: boolean;
  sdkCatalogue?: z.infer<typeof originalSdkCatalogue>;
  sdkSelections?: Map<string, z.infer<typeof originalSdkSelection>>;
  lifetime: AbortController;
  resource?: OriginalMcpNativeChatRpcPort;
  disposal?: Promise<void>;
}
const channels = new WeakMap<object, NodeState>(), resources = new WeakMap<object, NodeState>();
function remember(state: NodeState, requestId: string, requestDigest: string) {
  state.retired.set(requestId, requestDigest);
  if (state.retired.size > 4096) state.retired.delete(state.retired.keys().next().value!);
}
function finish(state: NodeState, call: Call, value?: unknown, error?: unknown) {
  if (!state.pending.delete(call.request.requestId)) return;
  remember(state, call.request.requestId, call.request.requestDigest);
  call.done = true; call.error = error; call.dispose(); call.controller.abort();
  call.event?.consumed(); call.wake?.();
  if (error) call.reject(error); else call.resolve(value);
}
function gateCallback(call: Call, frame: z.infer<typeof callbackSchema>) {
  if (call.request.method === "sdk.execution") return gateSdkCallback(call, frame);
  if (frame.method === "sdkSession" || frame.method === "sdkSending" || frame.method === "sdkTool"
    || frame.method === "sdkText" || frame.method === "sdkUsage") fail("NATIVE_CHAT_CALLBACK_SCOPE");
  if (!call.ports || !["execution.run", originalNativeTaskExecutionMethod].includes(call.request.method)
    || call.blocked || call.taskClosed || call.controller.signal.aborted
    || frame.sequence !== call.callbackSequence++ || frame.sequence >= originalMcpNativeChatLimits.callbackCount)
    fail("NATIVE_CHAT_CALLBACK_SCOPE");
  const payload = originalMcpNativeChatCallbackSchemas[frame.method].parse(frame.payload);
  const plan: OriginalNativeChatExecutionPlan = call.request.payload;
  if (frame.method === "beforeInference") {
    const before = originalMcpNativeChatCallbackSchemas.beforeInference.parse(payload), { requestSha256, ...body } = before;
    if (call.callbackPending || call.gates.has(before.inferenceId) || before.round !== call.gates.size
      || before.planSha256 !== originalNativeChatDigest(plan) || before.sourcePlanSha256 !== plan.sourcePlanSha256
      || before.selectionId !== plan.selectionId || before.inputTokens > plan.budget.maxInputTokens
      || before.round > (plan.hardToolRoundLimit ?? 1000)
      || before.requestSha256 !== originalNativeChatInferenceDigest(body)
      || before.inferenceId !== originalNativeChatDigest({ requestId: plan.requestId,
        sourcePlanSha256: plan.sourcePlanSha256, round: before.round, receipts: call.receipts }))
      fail("NATIVE_CHAT_INFERENCE_BINDING");
    const tools = before.nativeRequest.options.tools;
    let names: string[] = [];
    if (tools !== undefined) {
      const nativeTools = z.array(z.strictObject({ name: text, description: z.string(), inputSchema: args })).max(4096).parse(tools);
      if (new Set(nativeTools.map(item => item.name)).size !== nativeTools.length
        || nativeTools.some(item => !plan.tools.some(tool => item.name === tool.name && item.description === tool.description
          && same(item.inputSchema, tool.parameters)))) fail("NATIVE_CHAT_TOOL_NOT_DECLARED");
      names = nativeTools.map(item => item.name);
    }
    call.gates.set(before.inferenceId, { round: before.round, approved: false, calls: new Set(), tools: new Set(names) });
  } else {
    const gate = call.gates.get(payload.inferenceId), current = [...call.gates.keys()].at(-1);
    if (!gate?.approved || current !== payload.inferenceId) fail("NATIVE_CHAT_INFERENCE_NOT_DURABLE");
    if (frame.method === "taskContext") {
      if (call.request.method !== originalNativeTaskExecutionMethod || call.callbackPending)
        fail("NATIVE_CHAT_CALLBACK_SCOPE");
      const request = originalNativeTaskContextRequest.parse(payload), managed = managedExecutionPlan.parse(plan);
      if (gate.round !== request.round || request.planSha256 !== originalNativeChatDigest(plan)
        || request.sourcePlanSha256 !== plan.sourcePlanSha256
        || request.bindingSha256 !== managed.managedTask.bindingSha256
        || request.finalSummary && (plan.hardToolRoundLimit === null || request.round < plan.hardToolRoundLimit)
        || request.phase === "after-tools" && (!request.hasToolCalls || !gate.calls.size))
        fail("NATIVE_CHAT_TASK_BINDING");
    } else if (frame.method === "tool") {
      const proposed = originalMcpNativeChatCallbackSchemas.tool.parse(payload);
      if (call.callbackPending || gate.round !== proposed.round || gate.calls.has(proposed.callId)
        || gate.calls.size >= 16 || !gate.tools.has(proposed.name)
        || originalNativeChatDigest(proposed.arguments) !== proposed.argumentsSha256)
        fail("NATIVE_CHAT_TOOL_NOT_DECLARED");
      gate.calls.add(proposed.callId);
    }
  }
  if (call.callbackPending >= 2) fail("NATIVE_CHAT_CALLBACK_BACKPRESSURE");
  return payload;
}
function gateSdkCallback(call: Call, frame: z.infer<typeof callbackSchema>) {
  if (!call.sdkPorts || call.blocked || call.controller.signal.aborted || call.callbackPending
    || frame.sequence !== call.callbackSequence++ || !frame.method.startsWith("sdk")
    || frame.sequence >= originalMcpNativeChatLimits.callbackCount) fail("NATIVE_CHAT_CALLBACK_SCOPE");
  const plan = originalMcpSdkChatPlanSchema.parse(call.request.payload);
  const sessions = call.sdkSessions ??= new Map(), boundaries = call.sdkBoundaries ??= new Set();
  const payload = originalMcpNativeChatCallbackSchemas[frame.method].parse(frame.payload);
  if (frame.method === "sdkSession") {
    const input = originalSdkSessionRequest.parse(payload), binding = input.binding;
    if (sessions.has(binding.sdkSessionId) || input.ordinal !== sessions.size
      || binding.modelId !== call.sdkModelId
      || input.ordinal === 0 && input.previousSessionId !== null
      || input.ordinal === 1 && (plan.hardToolRoundLimit === null || input.previousSessionId !== [...sessions.keys()][0])
      || binding.requestId !== plan.requestId || binding.selectionId !== plan.selectionId
      || binding.planSha256 !== originalSdkDigest(plan) || binding.sourcePlanSha256 !== plan.sourcePlanSha256
      || binding.epoch !== plan.epoch || binding.hostReceiptSha256 !== plan.hostReceiptSha256
      || binding.deadlineAtMs !== plan.deadlineAtMs
      || binding.budget.maxSendingBoundaries !== plan.budget.maxSendingBoundaries
      || binding.budget.maxRequestBytes !== plan.budget.maxRequestBytes
      || binding.deadlineAtMs <= Date.now() || binding.deadlineAtMs > Date.now() + plan.budget.deadlineMs)
      fail("NATIVE_CHAT_SDK_SESSION_BINDING");
    sessions.set(binding.sdkSessionId, { binding, approved: false, sent: false });
  } else if (frame.method === "sdkSending") {
    const input = originalSdkSendingBoundary.parse(payload), { boundaryId, ...body } = input;
    const session = sessions.get(input.binding.sdkSessionId);
    if (!session?.approved || !same(input.binding, session.binding) || originalSdkDigest(body) !== boundaryId
      || boundaries.has(boundaryId) || boundaries.size >= plan.budget.maxSendingBoundaries
      || input.measurement.serializedBytes > plan.budget.maxRequestBytes
      || input.binding.deadlineAtMs <= Date.now()) fail("NATIVE_CHAT_SDK_BOUNDARY_BINDING");
    boundaries.add(boundaryId);
  } else {
    const input = frame.method === "sdkTool" ? originalSdkToolRequest.parse(payload)
      : frame.method === "sdkText" ? originalSdkTextRequest.parse(payload) : originalSdkUsageRequest.parse(payload);
    if (!sessions.get(input.sdkSessionId)?.sent) fail("NATIVE_CHAT_SDK_SENDING_NOT_DURABLE");
    if (frame.method === "sdkTool") {
      const proposed = originalSdkToolRequest.parse(payload), calls = call.sdkCalls ??= new Set();
      if (input.sdkSessionId !== [...sessions.keys()][0] || calls.has(proposed.callId)
        || call.sdkApprovedSends?.get(proposed.sendingBoundaryId) !== proposed.sdkSessionId
        || !plan.tools.some(tool => tool.name === proposed.name)
        || originalSdkDigest(proposed.arguments) !== proposed.argumentsSha256) fail("NATIVE_CHAT_TOOL_NOT_DECLARED");
      calls.add(proposed.callId);
    }
  }
  return payload;
}
async function nodeCallback(state: NodeState, call: Call, frame: z.infer<typeof callbackSchema>, payload: any) {
  if (call.controller.signal.aborted || call.blocked) { call.callbackPending--; return; }
  let result: unknown = null, error: z.infer<typeof errorSchema> | undefined;
  try {
    if (call.request.method === "sdk.execution") {
      if (frame.method === "sdkSession") {
        const input = originalSdkSessionRequest.parse(payload);
        await call.sdkPorts!.beforeSession(input);
        if (!call.controller.signal.aborted) call.sdkSessions!.get(input.binding.sdkSessionId)!.approved = true;
      } else if (frame.method === "sdkSending") {
        const input = originalSdkSendingBoundary.parse(payload);
        await call.sdkPorts!.beforeSendingBoundary(input);
        if (!call.controller.signal.aborted && input.kind !== "websocket-connect") {
          call.sdkSessions!.get(input.binding.sdkSessionId)!.sent = true;
          (call.sdkApprovedSends ??= new Map()).set(input.boundaryId, input.binding.sdkSessionId);
        }
      } else if (frame.method === "sdkTool") result = toolResult.parse(await call.sdkPorts!.tool(originalSdkToolRequest.parse(payload)));
      else if (frame.method === "sdkText") await call.sdkPorts!.text(originalSdkTextRequest.parse(payload));
      else if (frame.method === "sdkUsage") await call.sdkPorts!.usage(originalSdkUsageRequest.parse(payload));
      else fail("NATIVE_CHAT_CALLBACK_SCOPE");
      if (frame.method === "sdkTool" && toolResult.parse(result).effect === "unknown") call.blocked = true;
    } else if (frame.method === "beforeInference") {
      await call.ports!.beforeInference(payload);
      if (!call.controller.signal.aborted) call.gates.get(payload.inferenceId)!.approved = true;
    } else if (frame.method === "tool") {
      result = toolResult.parse(await call.ports!.tool(payload));
      if ((result as z.infer<typeof toolResult>).effect === "unknown") call.blocked = true;
      else call.receipts.push((result as z.infer<typeof toolResult>).receiptSha256);
    } else if (frame.method === "taskContext") {
      const context = originalNativeTaskContextRequest.parse(payload);
      const value = originalNativeTaskContextResult.parse(await dispatchOriginalMcpApiChatTaskContext(
        state.session, managedExecutionPlan.parse(call.request.payload), context));
      result = value;
      if (context.phase === "settled" || value.decision === "reject") call.taskClosed = true;
      call.taskFinished = context.phase === "settled" && value.decision === "finish";
    } else if (frame.method === "text") await call.ports!.text(payload);
    else await call.ports!.usage(payload);
  } catch {
    call.blocked = true;
    error = { code: "NATIVE_CHAT_CORE_CALLBACK_FAILED", dispatch: frame.method === "beforeInference"
      || frame.method === "sdkSession" || frame.method === "sdkSending" && ![...call.sdkSessions?.values() ?? []].some(value => value.sent)
      ? "not-sent" : "uncertain" };
  }
  call.callbackPending--;
  if (call.controller.signal.aborted) return;
  await state.peer.send({ kind: "callback-result", requestId: frame.requestId, requestDigest: frame.requestDigest,
    callbackId: frame.callbackId, callbackDigest: frame.callbackDigest, ...(error ? { error } : { result }) });
}
function receiveNode(state: NodeState, value: Logical): void | Promise<void> {
  const call = state.pending.get(value.requestId);
  if (!call) {
    if (state.retired.get(value.requestId) === value.requestDigest) {
      if (value.kind === "result") resultSchema.parse(value);
      else if (value.kind === "event") eventSchema.parse(value);
      else if (value.kind === "callback") callbackSchema.parse(value);
      else fail("NATIVE_CHAT_RESPONSE_UNEXPECTED");
      return;
    }
    fail("NATIVE_CHAT_RESPONSE_UNEXPECTED");
  }
  if (call.request.requestDigest !== value.requestDigest) fail("NATIVE_CHAT_REQUEST_DIGEST");
  if (value.kind === "callback") {
    const frame = callbackSchema.parse(value);
    if (callbackHash(frame) !== frame.callbackDigest) fail("NATIVE_CHAT_CALLBACK_DIGEST");
    const payload = gateCallback(call, frame); call.callbackPending++;
    call.callbackChain = call.callbackChain.then(() => nodeCallback(state, call, frame, payload))
      .catch(error => state.peer.fatal(error));
    return;
  }
  if (value.kind === "event") {
    const frame = eventSchema.parse(value);
    if (call.request.method !== "models.stream" || call.event || call.streamFinished
      || frame.sequence !== call.eventSequence++ || call.done)
      fail("NATIVE_CHAT_EVENT_SEQUENCE");
    if (frame.event.type === "tool") {
      const event = frame.event;
      if (!call.request.payload.tools.some((tool: any) => tool.name === event.name)
        || call.eventTools.has(event.id) || call.eventTools.size >= 16) fail("NATIVE_CHAT_TOOL_NOT_DECLARED");
      call.eventTools.add(event.id);
    }
    if (frame.event.type === "finish") call.streamFinished = true;
    return new Promise<void>(resolve => { call.event = { value: frame.event, consumed: resolve }; call.wake?.(); });
  }
  const frame = resultSchema.parse(value);
  if (call.callbackPending || call.event) fail("NATIVE_CHAT_RESULT_BEFORE_DRAIN");
  if (frame.error) { finish(state, call, undefined, new OriginalMcpNativeChatRpcError(frame.error.code, frame.error.dispatch)); return; }
  const result = parsedResult(call.request.method, frame.result);
  if (call.request.method === "sdk.catalogue") {
    const catalogue = originalSdkCatalogue.parse(result);
    if (catalogue.epoch !== state.session.activationId) fail("NATIVE_CHAT_SELECTION_BINDING");
    if (state.sdkCatalogue && !same(state.sdkCatalogue, catalogue)) state.sdkSelections?.clear();
    state.sdkCatalogue = freeze(catalogue);
  } else if (call.request.method === "sdk.select") {
    const selected = originalSdkSelection.parse(result), catalogue = state.sdkCatalogue;
    if (!catalogue || selected.epoch !== state.session.activationId
      || selected.model.id !== call.request.payload.modelId || selected.catalogueSha256 !== originalSdkDigest(catalogue)
      || !catalogue.models.some(model => same(model, selected.model))) fail("NATIVE_CHAT_SELECTION_BINDING");
    const selections = state.sdkSelections ??= new Map();
    if (selections.has(selected.selectionId) || selections.size >= 256) fail("NATIVE_CHAT_SELECTION_BINDING");
    selections.set(selected.selectionId, freeze(selected));
  } else if (call.request.method === "sdk.execution") {
    const outcome = executionResult.parse(result), plan = originalMcpSdkChatPlanSchema.parse(call.request.payload);
    if (call.blocked && !["failed", "unknown"].includes(outcome.status)
      || outcome.status === "complete" && ![...call.sdkSessions?.values() ?? []].some(session => session.sent))
      fail("NATIVE_CHAT_SDK_SENDING_NOT_DURABLE");
    if (outcome.toolRoundLimit && (outcome.toolRoundLimit.limit !== plan.hardToolRoundLimit
      || outcome.toolRoundLimit.rounds > outcome.toolRoundLimit.limit)) fail("NATIVE_CHAT_ROUND_LIMIT_BINDING");
  } else if (call.request.method === "models.catalogue") {
    const catalogue = originalNativeChatCatalogue.parse(result);
    if (catalogue.epoch !== state.session.activationId || new Set(catalogue.models.map(model => model.id)).size !== catalogue.models.length)
      fail("NATIVE_CHAT_MODEL_EPOCH");
    if (state.catalogue && !same(state.catalogue, catalogue)) state.selections.clear();
    state.catalogue = freeze(catalogue);
  } else if (call.request.method === "models.select") {
    const selection = selectionResult.parse(result), selected = state.catalogue?.models.find(model => model.id === selection.modelId);
    if (!selected || selection.epoch !== state.session.activationId || selection.modelId !== call.request.payload.modelId
      || selected.maxInputTokens !== selection.maxInputTokens || state.selections.has(selection.selectionId)
      || state.selections.size >= 256) fail("NATIVE_CHAT_SELECTION_BINDING");
    state.selections.set(selection.selectionId, freeze(selection));
  } else if (call.request.method === "models.count") {
    const count = countResult.parse(result);
    const selection = state.selections.get(count.selectionId);
    if (count.selectionId !== call.request.payload.selectionId || count.requestSha256 !== call.request.payload.requestSha256
      || !selection || count.inputTokens > selection.maxInputTokens) fail("NATIVE_CHAT_COUNT_BINDING");
  } else if (call.request.method === "execution.run" || call.request.method === originalNativeTaskExecutionMethod) {
    const execution = executionResult.parse(result), plan: OriginalNativeChatExecutionPlan = call.request.payload;
    if (execution.toolRoundLimit && (execution.toolRoundLimit.limit !== plan.hardToolRoundLimit
      || execution.toolRoundLimit.rounds > execution.toolRoundLimit.limit)) fail("NATIVE_CHAT_ROUND_LIMIT_BINDING");
    if (call.blocked && execution.status !== "unknown" && execution.status !== "failed")
      fail("NATIVE_CHAT_UNKNOWN_EFFECT_CONTINUED");
    if (execution.status === "complete" && !call.gates.size) fail("NATIVE_CHAT_INFERENCE_NOT_DURABLE");
    if (call.request.method === originalNativeTaskExecutionMethod && execution.status === "complete" && !call.taskFinished)
      fail("NATIVE_CHAT_TASK_NOT_SETTLED");
  } else if (call.request.method === "chat.resolve") {
    const selected = originalNativeChatSelection.parse(result);
    const request = originalNativeChatResolve.parse(call.request.payload);
    if (selected.epoch !== state.session.activationId || !["vscode", "copilot-sdk"].includes(selected.provider)
      || request.requestedModelId && selected.modelId !== request.requestedModelId
      || request.expectedSelection && !same(selected, request.expectedSelection))
      fail("NATIVE_CHAT_SELECTION_BINDING");
  } else if (call.request.method === memoryMethod) {
    const selected = originalNativeChatMemoryChoice.parse(result);
    const request = originalNativeChatMemoryRequest.parse(call.request.payload);
    if (selected.requestId !== request.requestId || selected.epoch !== state.session.activationId
      || selected.bindingSha256 !== originalNativeChatDigest(request)
      || selected.mode === "live" && selected.scope !== request.scope)
      fail("NATIVE_CHAT_MEMORY_BINDING");
  } else if (call.request.method === adoptionMethod) {
    const decision = originalManagedTaskAdoptionDecision.parse(result);
    const request = originalManagedTaskAdoptionRequest.parse(call.request.payload);
    if (decision.requestId !== request.requestId || decision.epoch !== state.session.activationId
      || decision.bindingSha256 !== originalNativeChatDigest(request)
      || decision.decision === "adopt-and-revalidate" && decision.expiresAtMs <= Date.now())
      fail("NATIVE_CHAT_ADOPTION_BINDING");
  } else if (call.request.method === "models.stream" && !call.streamFinished) fail("NATIVE_CHAT_STREAM_UNFINISHED");
  finish(state, call, freeze(result));
}
interface ChatChannel {
  maximumBytes: number; send(frame: OriginalMcpNativeChatFrame): void | Promise<void>; revoke(): void;
}
/** Attachment server only; registered once before the actual session is published. */
export function bindOriginalMcpNativeChatTransport(session: AuthenticatedOriginalMcpNativeSession, channel: ChatChannel) {
  assertAuthenticatedOriginalMcpNativeSession(session);
  if (channels.has(session)) fail("NATIVE_CHAT_CHANNEL_ALREADY_BOUND");
  const state: NodeState = { session, pending: new Map(), retired: new Map(), selections: new Map(), disposed: false,
    peer: undefined as unknown as Peer, lifetime: new AbortController() };
  state.peer = new Peer(originalMcpNativeChatSession(session), {
    send: frame => channel.send(frame), close: () => channel.revoke(),
  }, () => session.assertCurrent(), channel.maximumBytes, "node", value => receiveNode(state, value),
  (requestId, requestDigest) => {
    const call = state.pending.get(requestId);
    if (call && call.request.requestDigest !== requestDigest) fail("NATIVE_CHAT_REQUEST_DIGEST");
    if (call) finish(state, call, undefined, new OriginalMcpNativeChatRpcError("NATIVE_CHAT_CANCELLED", call.sent ? "uncertain" : "not-sent"));
  }, error => {
    state.lifetime.abort(error);
    for (const call of [...state.pending.values()]) finish(state, call, undefined,
      new OriginalMcpNativeChatRpcError(error instanceof OriginalMcpNativeChatRpcError
        ? error.code : "NATIVE_CHAT_PROTOCOL_INVALID", call.sent ? "uncertain" : "not-sent",
      { cause: error instanceof OriginalMcpNativeChatRpcError ? error.cause : error }));
  });
  channels.set(session, state);
  session.signal.addEventListener("abort", () => state.peer.stop(
    new OriginalMcpNativeChatRpcError("NATIVE_CHAT_SESSION_REVOKED", "uncertain", { cause: session.signal.reason })), { once: true });
  return (value: unknown) => state.peer.receive(value);
}
export function originalMcpNativeChatSupportedMethods(session: AuthenticatedOriginalMcpNativeSession): readonly Method[] {
  assertAuthenticatedOriginalMcpNativeSession(session);
  const state = channels.get(session);
  return Object.freeze(state?.peer.ready && !state.disposed ? [...state.peer.methods] : []);
}
export async function waitForOriginalMcpNativeChatSupport(session: AuthenticatedOriginalMcpNativeSession,
  options: { signal?: AbortSignal; timeoutMs?: number } = {}) {
  assertAuthenticatedOriginalMcpNativeSession(session);
  const state = channels.get(session);
  if (!state || state.disposed) fail("MISSING_NATIVE_METHOD");
  await state.peer.wait(options.signal, options.timeoutMs);
  return originalMcpNativeChatSupportedMethods(session);
}
function begin(state: NodeState, method: Method, payload: unknown, signal: AbortSignal, ports?: Ports,
  sdkPorts?: OriginalSdkExecutionCallbacks) {
  state.peer.assertCurrent();
  if (state.disposed || !state.peer.methods.has(method)) fail("MISSING_NATIVE_METHOD");
  if (signal.aborted) fail("NATIVE_CHAT_CANCELLED");
  if (state.pending.size >= originalMcpNativeChatLimits.pendingRequests) fail("NATIVE_CHAT_BUSY");
  portable(payload);
  const parsed = originalMcpNativeChatPayloadSchemas[method].parse(payload);
  if (method === "models.select" && (!state.catalogue || (parsed as any).catalogueSha256 !== originalNativeChatDigest(state.catalogue)))
    fail("NATIVE_CHAT_STALE_CATALOGUE");
  if (["models.count", "models.stream", "execution.run", originalNativeTaskExecutionMethod].includes(method)
    && !state.selections.has((parsed as any).selectionId)) fail("NATIVE_CHAT_STALE_SELECTION");
  if (method === "sdk.select" && (!state.sdkCatalogue
    || (parsed as any).catalogueSha256 !== originalSdkDigest(state.sdkCatalogue))) fail("NATIVE_CHAT_STALE_CATALOGUE");
  if (["sdk.measure", "sdk.execution"].includes(method) && !state.sdkSelections?.has((parsed as any).selectionId))
    fail("NATIVE_CHAT_STALE_SELECTION");
  const requestId = randomUUID(), session = originalMcpNativeChatSession(state.session);
  const request = parseRequest({ kind: "request", requestId, method, payload: parsed, requestDigest: originalNativeChatDigest({
    protocol: originalMcpNativeChatProtocol, session, requestId, method, payload: parsed,
  }) }, session);
  const controller = new AbortController();
  let call!: Call;
  const timeoutMs = method === "sdk.execution" ? originalMcpSdkChatPlanSchema.parse(parsed).budget.deadlineMs
    : method === originalNativeTaskExecutionMethod ? managedExecutionPlan.parse(parsed).budget.deadlineMs
      : method === "execution.run" ? originalMcpNativeChatExecutionPlanSchema.parse(parsed).budget.deadlineMs : 300000;
  const completed = new Promise<any>((resolve, reject) => {
    const abort = (code: string) => {
      state.peer.cancel(requestId, request.requestDigest);
      finish(state, call, undefined, new OriginalMcpNativeChatRpcError(code, call.sent ? "uncertain" : "not-sent"));
    };
    const aborted = () => abort("NATIVE_CHAT_CANCELLED");
    const timer = setTimeout(() => abort("NATIVE_CHAT_TIMEOUT"), timeoutMs);
    call = { request, controller, resolve, reject, sent: false, done: false,
      dispose() { clearTimeout(timer); signal.removeEventListener("abort", aborted); },
      eventSequence: 0, callbackSequence: 0, callbackPending: 0, callbackChain: Promise.resolve(), blocked: false,
      gates: new Map(), receipts: [], eventTools: new Set(), streamFinished: false,
      ...(sdkPorts ? { sdkPorts: Object.freeze({
        beforeSession: sdkPorts.beforeSession.bind(sdkPorts),
        beforeSendingBoundary: sdkPorts.beforeSendingBoundary.bind(sdkPorts),
        tool: sdkPorts.tool.bind(sdkPorts), text: sdkPorts.text.bind(sdkPorts), usage: sdkPorts.usage.bind(sdkPorts),
      }) } : {}),
      ...(method === "sdk.execution" ? { sdkModelId: state.sdkSelections!.get(originalMcpSdkChatPlanSchema.parse(parsed).selectionId)!.model.id } : {}),
      ...(ports ? { ports: Object.freeze({
        beforeInference: ports.beforeInference.bind(ports), tool: ports.tool.bind(ports),
        text: ports.text.bind(ports), usage: ports.usage.bind(ports),
      }) } : {}) };
    state.pending.set(requestId, call); signal.addEventListener("abort", aborted, { once: true });
    if (signal.aborted) aborted();
  });
  void completed.catch(() => {});
  if (!call.done) {
    call.sent = true;
    void Promise.resolve().then(() => state.peer.send(request)).catch(error => {
      state.peer.cancel(requestId, request.requestDigest);
      finish(state, call, undefined, error);
    });
  }
  return { call, completed };
}
export interface OriginalMcpNativeChatRpcPort {
  readonly session: AuthenticatedOriginalMcpNativeSession;
  readonly signal: AbortSignal;
  readonly closed: Promise<void>;
  readonly models: OriginalVscodeChatModelPort;
  readonly execution: OriginalNativeChatExecutionPort;
  readonly sdk?: OriginalSdkChatPort;
  readonly sdkStatus?: (signal: AbortSignal) => Promise<OriginalSdkUnavailableStatus>;
  readonly apiChat?: OriginalNativeChatSessionPort;
  assertCurrent(): void;
  dispose(): Promise<void>;
}
export function assertOriginalMcpNativeChatRpcPort(value: unknown, expectedSession?: AuthenticatedOriginalMcpNativeSession):
  asserts value is OriginalMcpNativeChatRpcPort {
  const state = value && typeof value === "object" ? resources.get(value) : undefined;
  if (!state || state.disposed || expectedSession && state.session !== expectedSession) fail("NATIVE_CHAT_RESOURCE_UNAUTHENTICATED");
  assertAuthenticatedOriginalMcpNativeSession(state.session); state.peer.assertCurrent();
}
/** No caller Socket/transport or success policy is accepted by the Node resource factory. */
export function createOriginalMcpNativeChatRpcPort(session: AuthenticatedOriginalMcpNativeSession): OriginalMcpNativeChatRpcPort {
  assertAuthenticatedOriginalMcpNativeSession(session);
  const state = channels.get(session);
  if (!state || state.disposed || !state.peer.ready || !state.peer.methods.size) fail("MISSING_NATIVE_METHOD");
  if (state.resource) return state.resource;
  const models: OriginalVscodeChatModelPort = Object.freeze({
    async catalogue(signal: AbortSignal) { return await begin(state, "models.catalogue", {}, signal).completed; },
    async select(input: Parameters<OriginalVscodeChatModelPort["select"]>[0], signal: AbortSignal) {
      return await begin(state, "models.select", input, signal).completed;
    },
    async count(input: Parameters<OriginalVscodeChatModelPort["count"]>[0], signal: AbortSignal) {
      return await begin(state, "models.count", input, signal).completed;
    },
    async *stream(input: Parameters<OriginalVscodeChatModelPort["stream"]>[0], signal: AbortSignal): AsyncIterable<ModelProviderEvent> {
      const { call, completed } = begin(state, "models.stream", input, signal);
      try {
        while (!call.done || call.event) {
          if (!call.event) await new Promise<void>(resolve => { call.wake = resolve; if (call.done || call.event) resolve(); });
          const event = call.event;
          if (event) {
            try { yield event.value; } finally { call.event = undefined; event.consumed(); }
          }
        }
        await completed;
      } finally {
        if (!call.done) {
          state.peer.cancel(call.request.requestId, call.request.requestDigest);
          finish(state, call, undefined, new OriginalMcpNativeChatRpcError("NATIVE_CHAT_CANCELLED", "uncertain"));
        }
      }
    },
  });
  const execution: OriginalNativeChatExecutionPort = Object.freeze({
    async run(plan: Parameters<OriginalNativeChatExecutionPort["run"]>[0], ports: Ports, signal: AbortSignal) {
      if (!ports || !["beforeInference", "tool", "text", "usage"].every(key => typeof ports[key as keyof Ports] === "function"))
        fail("NATIVE_CHAT_CORE_CALLBACKS_REQUIRED");
      return await begin(state, "managedTask" in plan ? originalNativeTaskExecutionMethod : "execution.run", plan, signal, ports).completed;
    },
  });
  const sdk: OriginalSdkChatPort | undefined = sdkMethods.every(method => state.peer.methods.has(method))
    ? Object.freeze({
      async catalogue(signal: AbortSignal) { return await begin(state, "sdk.catalogue", {}, signal).completed; },
      async select(input: Parameters<OriginalSdkChatPort["select"]>[0], signal: AbortSignal) {
        return await begin(state, "sdk.select", input, signal).completed;
      },
      async measure(input: Parameters<OriginalSdkChatPort["measure"]>[0], signal: AbortSignal) {
        return await begin(state, "sdk.measure", input, signal).completed;
      },
      async authorizeBoundary(input: Parameters<OriginalSdkChatPort["authorizeBoundary"]>[0], signal: AbortSignal) {
        await begin(state, "sdk.authorizeBoundary", input, signal).completed;
      },
      async run(plan: OriginalSdkChatPlan, callbacks: OriginalSdkExecutionCallbacks, signal: AbortSignal) {
        if (!["beforeSession", "beforeSendingBoundary", "tool", "text", "usage"].every(key =>
          typeof Reflect.get(callbacks, key) === "function")) fail("NATIVE_CHAT_CORE_CALLBACKS_REQUIRED");
        return await begin(state, "sdk.execution", plan, signal, undefined, callbacks).completed;
      },
    }) : undefined;
  const apiChat: OriginalNativeChatSessionPort | undefined =
    sessionMethods.every(method => state.peer.methods.has(method))
      ? Object.freeze({
        ...(state.peer.methods.has(adoptionMethod) ? {
          async adopt(input: Parameters<OriginalManagedTaskAdoptionPort["adopt"]>[0], signal: AbortSignal) {
            return originalManagedTaskAdoptionDecision.parse(await begin(state, adoptionMethod, input, signal).completed);
          },
        } : {}),
        ...(state.peer.methods.has(memoryMethod) ? { memory: Object.freeze({
          async select(input: Parameters<OriginalNativeChatMemoryPort["select"]>[0], signal: AbortSignal) {
            return originalNativeChatMemoryChoice.parse(await begin(state, memoryMethod, input, signal).completed);
          },
        }) } : {}),
        async resolve(input: Parameters<OriginalNativeChatSessionPort["resolve"]>[0], signal: AbortSignal) {
          return originalNativeChatSelection.parse(await begin(state, "chat.resolve", input, signal).completed);
        },
        async authorize(input: Parameters<OriginalNativeChatSessionPort["authorize"]>[0], signal: AbortSignal) {
          return z.boolean().parse(await begin(state, "chat.authorize", input, signal).completed);
        },
        async present(input: Parameters<OriginalNativeChatSessionPort["present"]>[0], signal: AbortSignal) {
          z.null().parse(await begin(state, "chat.present", input, signal).completed);
        },
      }) : undefined;
  const resource: OriginalMcpNativeChatRpcPort = Object.freeze({
    session, signal: state.lifetime.signal, closed: state.peer.closed, models, execution,
    ...(sdk ? { sdk } : {}),
    ...(state.peer.methods.has("sdk.status") ? { async sdkStatus(signal: AbortSignal) {
      return originalSdkUnavailableStatus.parse(await begin(state, "sdk.status", {}, signal).completed);
    } } : {}),
    ...(apiChat ? { apiChat } : {}),
    assertCurrent() { assertOriginalMcpNativeChatRpcPort(resource); },
    dispose() {
      return state.disposal ??= (async () => {
        state.disposed = true;
        const callbacks = [...state.pending.values()].map(call => call.callbackChain);
        for (const call of [...state.pending.values()]) {
          state.peer.cancel(call.request.requestId, call.request.requestDigest);
          finish(state, call, undefined, new OriginalMcpNativeChatRpcError("NATIVE_CHAT_CANCELLED", "uncertain"));
        }
        state.peer.stop(); state.catalogue = undefined; state.selections.clear();
        state.sdkCatalogue = undefined; state.sdkSelections?.clear();
        let timer: ReturnType<typeof setTimeout> | undefined;
        try {
          await Promise.race([
            Promise.all(callbacks),
            new Promise<never>((_resolve, reject) => {
              timer = setTimeout(() => reject(new OriginalMcpNativeChatRpcError("NATIVE_CHAT_CLEANUP_UNCONFIRMED", "uncertain")), 30000);
            }),
          ]);
          await state.peer.drain();
        } finally { if (timer) clearTimeout(timer); }
      })();
    },
  });
  resources.set(resource, state);
  state.resource = resource;
  return resource;
}
export const createOriginalMcpNativeChatPorts = createOriginalMcpNativeChatRpcPort;
export const assertOriginalMcpNativeChatPorts: typeof assertOriginalMcpNativeChatRpcPort = assertOriginalMcpNativeChatRpcPort;

/** Fixed native producer adapter. Parent binds these ports only to the installed real VS Code producer. */
export function createOriginalMcpNativeChatProducerChannel(options: {
  session: OriginalMcpNativeChatSession; models: OriginalVscodeChatModelPort; execution: OriginalNativeTaskCapableExecutionPort;
  apiChat?: OriginalNativeChatSessionPort;
  sdk?: OriginalSdkChatPort;
  sdkStatus?: (signal: AbortSignal) => Promise<OriginalSdkUnavailableStatus>;
  signal: AbortSignal; assertCurrent(): void; send: Wire["send"]; close: Wire["close"]; maxPacketBytes?: number;
}) {
  const session = freeze(originalMcpNativeChatSessionSchema.parse(options.session));
  if (!options.models || !["catalogue", "select", "count", "stream"].every(key =>
    typeof options.models[key as keyof OriginalVscodeChatModelPort] === "function")
    || typeof options.execution?.run !== "function") fail("MISSING_NATIVE_METHOD");
  if (options.apiChat && (!["resolve", "authorize", "present"].every(method =>
    typeof options.apiChat![method as keyof OriginalNativeChatSessionPort] === "function")))
    fail("MISSING_NATIVE_METHOD");
  if (options.apiChat?.memory && typeof options.apiChat.memory.select !== "function")
    fail("MISSING_NATIVE_METHOD");
  if (options.apiChat?.adopt !== undefined && typeof options.apiChat.adopt !== "function")
    fail("MISSING_NATIVE_METHOD");
  if (options.execution.managedTask && typeof options.execution.managedTask.run !== "function") fail("MISSING_NATIVE_METHOD");
  const advertised = originalMcpNativeChatMethods.filter(method => method === "sdk.status" ? !!options.sdkStatus
    : method.startsWith("sdk.") ? !!options.sdk
    : method === originalNativeTaskExecutionMethod
    ? !!options.execution.managedTask : method === memoryMethod
      ? !!options.apiChat?.memory : method === adoptionMethod
        ? typeof options.apiChat?.adopt === "function" : !!options.apiChat || !method.startsWith("chat."));
  const calls = new Map<string, { request: Request; controller: AbortController; callbackSequence: number;
    callbacks: Map<string, { digest: string; method: CallbackMethod; resolve(value: any): void; reject(error: unknown): void }> }>();
  const retired = new Map<string, string>();
  const remember = (requestId: string, requestDigest: string) => {
    retired.set(requestId, requestDigest); if (retired.size > 4096) retired.delete(retired.keys().next().value!);
  };
  let peer!: Peer;
  const check = () => { if (options.signal.aborted) fail("NATIVE_CHAT_CANCELLED"); options.assertCurrent(); };
  const cancel = (requestId: string, requestDigest: string) => {
    const call = calls.get(requestId);
    if (call && call.request.requestDigest !== requestDigest) fail("NATIVE_CHAT_REQUEST_DIGEST");
    if (call) {
      call.controller.abort();
      for (const waiter of call.callbacks.values()) waiter.reject(new OriginalMcpNativeChatRpcError("NATIVE_CHAT_CANCELLED", "uncertain"));
      call.callbacks.clear();
    }
    remember(requestId, requestDigest);
  };
  const callback = async (call: NonNullable<ReturnType<typeof calls.get>>, method: CallbackMethod, payload: unknown) => {
    if (call.controller.signal.aborted) fail("NATIVE_CHAT_CANCELLED");
    if (call.callbacks.size >= 2 || call.callbackSequence >= originalMcpNativeChatLimits.callbackCount)
      fail("NATIVE_CHAT_CALLBACK_BACKPRESSURE");
    const body = { kind: "callback" as const, requestId: call.request.requestId, requestDigest: call.request.requestDigest,
      callbackId: randomUUID(), sequence: call.callbackSequence++, method,
      payload: originalMcpNativeChatCallbackSchemas[method].parse(payload), callbackDigest: "" };
    body.callbackDigest = callbackHash(body);
    return await new Promise<any>((resolve, reject) => {
      call.callbacks.set(body.callbackId, { digest: body.callbackDigest, method, resolve, reject });
      void Promise.resolve().then(() => peer.send(body)).catch(error => { call.callbacks.delete(body.callbackId); reject(error); });
    });
  };
  const run = async (call: NonNullable<ReturnType<typeof calls.get>>) => {
    const { request } = call, signal = AbortSignal.any([options.signal, call.controller.signal]);
    try {
      let result: unknown;
      if (request.method === "sdk.status") {
        if (!options.sdkStatus) fail("MISSING_NATIVE_METHOD");
        result = await options.sdkStatus(signal);
      } else if (request.method.startsWith("sdk.")) {
        if (!options.sdk) fail("MISSING_NATIVE_METHOD");
        if (request.method === "sdk.catalogue") result = await options.sdk.catalogue(signal);
        else if (request.method === "sdk.select") result = await options.sdk.select(request.payload, signal);
        else if (request.method === "sdk.measure") result = await options.sdk.measure(request.payload, signal);
        else if (request.method === "sdk.authorizeBoundary") {
          await options.sdk.authorizeBoundary(originalSdkSendingBoundary.parse(request.payload), signal); result = null;
        } else if (request.method === "sdk.execution") result = await options.sdk.run(originalMcpSdkChatPlanSchema.parse(request.payload), {
          beforeSession: async value => { await callback(call, "sdkSession", value); },
          beforeSendingBoundary: async value => { await callback(call, "sdkSending", value); },
          tool: async value => toolResult.parse(await callback(call, "sdkTool", value)),
          text: async value => { await callback(call, "sdkText", value); },
          usage: async value => { await callback(call, "sdkUsage", value); },
        }, signal);
      } else if (request.method === "models.catalogue") result = await options.models.catalogue(signal);
      else if (request.method === "models.select") result = await options.models.select(request.payload, signal);
      else if (request.method === "models.count") result = await options.models.count(request.payload, signal);
      else if (request.method === "chat.resolve") {
        if (!options.apiChat) fail("MISSING_NATIVE_METHOD");
        result = await options.apiChat.resolve(originalNativeChatResolve.parse(request.payload), signal);
      } else if (request.method === "chat.authorize") {
        if (!options.apiChat) fail("MISSING_NATIVE_METHOD");
        result = await options.apiChat.authorize(originalNativeChatRequest.parse(request.payload), signal);
      } else if (request.method === "chat.present") {
        if (!options.apiChat) fail("MISSING_NATIVE_METHOD");
        await options.apiChat.present(originalNativeChatPresentation.parse(request.payload), signal);
        result = null;
      } else if (request.method === memoryMethod) {
        if (!options.apiChat?.memory) fail("MISSING_NATIVE_METHOD");
        result = await options.apiChat.memory.select(originalNativeChatMemoryRequest.parse(request.payload), signal);
      } else if (request.method === adoptionMethod) {
        if (!options.apiChat?.adopt) fail("MISSING_NATIVE_METHOD");
        result = await options.apiChat.adopt(originalManagedTaskAdoptionRequest.parse(request.payload), signal);
      }
      else if (request.method === "models.stream") {
        let sequence = 0;
        for await (const event of options.models.stream(request.payload, signal)) {
          check(); if (signal.aborted) fail("NATIVE_CHAT_CANCELLED");
          await peer.send({ kind: "event", requestId: request.requestId, requestDigest: request.requestDigest,
            sequence: sequence++, event: originalMcpNativeChatEventSchema.parse(event) });
        }
        result = { complete: true };
      } else if (request.method === originalNativeTaskExecutionMethod) {
        if (!options.execution.managedTask) fail("MISSING_NATIVE_METHOD");
        result = await options.execution.managedTask.run(managedExecutionPlan.parse(request.payload), {
          beforeInference: async value => { await callback(call, "beforeInference", value); },
          tool: async value => toolResult.parse(await callback(call, "tool", value)),
          text: async value => { await callback(call, "text", value); },
          usage: async value => { await callback(call, "usage", value); },
          taskContext: async value => originalNativeTaskContextResult.parse(await callback(call, "taskContext", value)),
        }, signal);
      } else {
        result = await options.execution.run(request.payload, {
          beforeInference: async value => { await callback(call, "beforeInference", value); },
          tool: async value => toolResult.parse(await callback(call, "tool", value)),
          text: async value => { await callback(call, "text", value); },
          usage: async value => { await callback(call, "usage", value); },
        }, signal);
      }
      check(); if (signal.aborted) return;
      await peer.send({ kind: "result", requestId: request.requestId, requestDigest: request.requestDigest,
        result: parsedResult(request.method, result) });
    } catch (error) {
      if (signal.aborted) return;
      const uncertain = request.method === "execution.run" || request.method === originalNativeTaskExecutionMethod || request.method === "models.stream"
        || !!error && typeof error === "object" && "dispatch" in error && error.dispatch === "uncertain";
      const code = error && typeof error === "object" && "code" in error ? error.code : undefined;
      const sdkCode = request.method.startsWith("sdk.") ? errorSchema.shape.code.safeParse(code) : undefined;
      await peer.send({ kind: "result", requestId: request.requestId, requestDigest: request.requestDigest,
        error: { code: sdkCode?.success ? sdkCode.data
          : code === "MISSING_NATIVE_METHOD" ? "MISSING_NATIVE_METHOD"
          : code === "NATIVE_CHAT_CANCELLED" ? "NATIVE_CHAT_CANCELLED"
          : uncertain ? "NATIVE_CHAT_DISPATCH_UNCERTAIN" : "NATIVE_CHAT_FAILED",
        dispatch: uncertain ? "uncertain" : "not-sent" } });
    } finally { cancel(request.requestId, request.requestDigest); calls.delete(request.requestId); }
  };
  peer = new Peer(session, { send: options.send, close: options.close }, check, options.maxPacketBytes ?? 65536,
    "producer", value => {
      if (value.kind === "callback-result") {
        const frame = callbackResultSchema.parse(value), call = calls.get(frame.requestId);
        if (!call || call.request.requestDigest !== frame.requestDigest) {
          if (retired.get(frame.requestId) === frame.requestDigest) return;
          fail("NATIVE_CHAT_CALLBACK_SCOPE");
        }
        const pending = call.callbacks.get(frame.callbackId);
        if (!pending || pending.digest !== frame.callbackDigest) fail("NATIVE_CHAT_CALLBACK_DIGEST");
        call.callbacks.delete(frame.callbackId);
        if (frame.error) pending.reject(new OriginalMcpNativeChatRpcError(frame.error.code, frame.error.dispatch));
        else pending.resolve(pending.method === "tool" || pending.method === "sdkTool" ? toolResult.parse(frame.result)
          : pending.method === "taskContext" ? originalNativeTaskContextResult.parse(frame.result) : z.null().parse(frame.result));
        return;
      }
      const request = parseRequest(value, session);
      if (!peer.methods.has(request.method) || calls.size >= originalMcpNativeChatLimits.pendingRequests
        || calls.has(request.requestId) || retired.has(request.requestId)) fail("NATIVE_CHAT_INVOCATION_REPLAY");
      const call = { request, controller: new AbortController(), callbackSequence: 0, callbacks: new Map() };
      calls.set(request.requestId, call);
      void run(call).catch(error => peer.fatal(error));
    }, cancel, error => {
      for (const call of calls.values()) {
        call.controller.abort(); for (const waiter of call.callbacks.values()) waiter.reject(error);
      }
      calls.clear();
    });
  const aborted = () => peer.stop(new OriginalMcpNativeChatRpcError("NATIVE_CHAT_SESSION_REVOKED", "uncertain", { cause: options.signal.reason }));
  options.signal.addEventListener("abort", aborted, { once: true });
  if (options.signal.aborted) aborted();
  let disposal: Promise<void> | undefined;
  return Object.freeze({
    closed: peer.closed,
    receive(value: unknown) { peer.receive(value); },
    async support() { await peer.advertise(advertised); await peer.wait(options.signal); },
    dispose() {
      return disposal ??= (async () => {
        options.signal.removeEventListener("abort", aborted);
        for (const call of calls.values()) peer.cancel(call.request.requestId, call.request.requestDigest);
        peer.stop(); await peer.drain();
      })();
    },
  });
}
