import { createHash } from "node:crypto";
import type { CopilotClientOptions, CopilotRequestContext } from "@github/copilot-sdk";
import {
  originalSdkDigest, originalSdkExecutionBinding, originalSdkSendingBoundary,
  measureOriginalSdkSerializedPayload, originalSdkCanonicalToolCall,
  type OriginalSdkExecutionBinding, type OriginalSdkSendingBoundary, type OriginalSdkCanonicalToolCall,
} from "../../src/original-mcp-sdk-model-contracts.js";

export type OriginalSdkRequestContext = CopilotRequestContext;
export type OriginalSdkForwardingApi = Pick<typeof import("@github/copilot-sdk"),
  "CopilotRequestHandler" | "CopilotWebSocketForwarder">;
export const originalSdkClientOptionsDigest = (value: Readonly<CopilotClientOptions>) =>
  originalSdkDigest(JSON.parse(JSON.stringify(value)));
const requiredFeatures = Object.freeze({
  api: "CopilotRequestHandler/v1" as const,
  httpRequestAwaited: true as const, webSocketMessageAwaited: true as const,
  attributedSessionAndInvocation: true as const, noUninterceptedModelSending: true as const,
});
export interface OriginalSdkRuntimeAdmission {
  // This must be a live, independently verified native-owner port, never an SDK-shaped JSON advertisement.
  assertCurrent(module: unknown, requirements: typeof requiredFeatures,
    clientOptions: Readonly<CopilotClientOptions>): void;
}
export class OriginalSdkForwardingError extends Error {
  constructor(readonly code: string, readonly dispatch: "not-sent" | "uncertain") {
    super(code);
  }
}
function apiFrom(value: OriginalSdkForwardingApi): OriginalSdkForwardingApi {
  const handler = value?.CopilotRequestHandler?.prototype;
  const forwarder = value?.CopilotWebSocketForwarder?.prototype;
  if (!value || typeof value.CopilotRequestHandler !== "function"
    || typeof value.CopilotWebSocketForwarder !== "function"
    || !handler || typeof Reflect.get(handler, "sendRequest") !== "function"
    || typeof Reflect.get(handler, "openWebSocket") !== "function"
    || typeof forwarder?.sendRequestMessage !== "function")
    throw new OriginalSdkForwardingError("NATIVE_SDK_RUNTIME_INCOMPATIBLE", "not-sent");
  return value;
}

export function createOriginalSdkForwardingHandler(module: OriginalSdkForwardingApi, options: {
  runtimeAdmission: OriginalSdkRuntimeAdmission;
  runtimeClientOptions: Readonly<CopilotClientOptions>;
  binding: OriginalSdkExecutionBinding;
  signal: AbortSignal;
  assertCurrent(binding: Readonly<OriginalSdkExecutionBinding>): void;
  assertDestination(url: string, transport: OriginalSdkRequestContext["transport"]): void;
  approve(boundary: Readonly<OriginalSdkSendingBoundary>, signal: AbortSignal): Promise<void>;
}) {
  const api = apiFrom(module), binding = originalSdkExecutionBinding.parse(structuredClone(options.binding));
  let runtimeConfig: CopilotClientOptions;
  try { runtimeConfig = structuredClone(options.runtimeClientOptions); }
  catch { throw new OriginalSdkForwardingError("NATIVE_SDK_RUNTIME_INCOMPATIBLE", "not-sent"); }
  const clientOptionsSha256 = originalSdkClientOptionsDigest(runtimeConfig);
  let potentiallyDispatched = false, closed = false, boundaries = 0;
  function assertRuntime() {
    try {
      if (originalSdkClientOptionsDigest(options.runtimeClientOptions) !== clientOptionsSha256)
        throw new Error("Runtime configuration changed");
      options.runtimeAdmission.assertCurrent(module, requiredFeatures, runtimeConfig);
      if (originalSdkClientOptionsDigest(runtimeConfig) !== clientOptionsSha256) throw new Error("Runtime configuration changed");
    }
    catch { throw new OriginalSdkForwardingError("NATIVE_SDK_RUNTIME_INCOMPATIBLE",
      potentiallyDispatched ? "uncertain" : "not-sent"); }
  }
  assertRuntime();
  options.assertCurrent(binding);
  const lifetime = new AbortController(), retired = new Map<string, string>();
  const ownerSignal = AbortSignal.any([options.signal, lifetime.signal]);
  const fail = (code: string): never => {
    throw new OriginalSdkForwardingError(code, potentiallyDispatched ? "uncertain" : "not-sent");
  };
  function current() {
    if (closed || ownerSignal.aborted) fail("NATIVE_SDK_CANCELLED");
    if (Date.now() >= binding.deadlineAtMs) fail("NATIVE_SDK_EXPIRED");
    assertRuntime();
    options.assertCurrent(binding);
  }
  current();
  if (binding.deadlineAtMs - Date.now() > 300000) fail("NATIVE_SDK_BUDGET_EXCEEDED");
  const deadline = setTimeout(() => lifetime.abort(), binding.deadlineAtMs - Date.now());
  deadline.unref();
  function contextFor(context: OriginalSdkRequestContext, transport: "http" | "websocket") {
    current();
    if (context.transport !== transport || context.sessionId !== binding.sdkSessionId
      || !context.requestId || context.requestId.length > 512
      || !context.agentInvocationId || context.agentInvocationId.length > 512 || context.parentAgentId
      || context.signal.aborted) fail("NATIVE_SDK_CONTEXT_DENIED");
    const url = new URL(context.url);
    if (url.protocol !== (transport === "http" ? "https:" : "wss:") || url.username || url.password)
      fail("NATIVE_SDK_DESTINATION_DENIED");
    options.assertDestination(context.url, transport);
    return { ...context, headers: { ...context.headers }, signal: AbortSignal.any([context.signal, ownerSignal]) };
  }
  async function wait<T>(work: Promise<T>, signal: AbortSignal): Promise<T> {
    if (signal.aborted) fail("NATIVE_SDK_CANCELLED");
    return new Promise<T>((resolve, reject) => {
      const abort = () => reject(new OriginalSdkForwardingError("NATIVE_SDK_CANCELLED",
        potentiallyDispatched ? "uncertain" : "not-sent"));
      signal.addEventListener("abort", abort, { once: true });
      work.then(resolve, reject).finally(() => signal.removeEventListener("abort", abort));
      if (signal.aborted) abort();
    });
  }
  async function approve(kind: OriginalSdkSendingBoundary["kind"], context: OriginalSdkRequestContext,
    measurement: OriginalSdkSendingBoundary["measurement"]) {
    current();
    const replayKey = kind === "websocket-connect" ? `connect:${context.requestId}` : `send:${context.agentInvocationId}`;
    if (retired.has(replayKey)) fail(retired.get(replayKey) === measurement.payloadSha256
      ? "NATIVE_SDK_REPLAY_DENIED" : "NATIVE_SDK_LOGICAL_SEND_IDENTITY_UNVERIFIED");
    if (++boundaries > binding.budget.maxSendingBoundaries
      || measurement.serializedBytes > binding.budget.maxRequestBytes) fail("NATIVE_SDK_BUDGET_EXCEEDED");
    retired.set(replayKey, measurement.payloadSha256);
    const body = { schema: "pkm.original-sdk-sending-boundary/v1" as const,
      binding: structuredClone(binding), sdkRequestId: context.requestId,
      sdkInvocationId: context.agentInvocationId!, kind, measurement, authority: "model-sending-boundary-only" as const };
    const boundary = originalSdkSendingBoundary.parse({ ...body, boundaryId: originalSdkDigest(body) });
    const fingerprint = originalSdkDigest(boundary);
    await wait(options.approve(boundary, context.signal), context.signal);
    current();
    if (originalSdkDigest(boundary) !== fingerprint) fail("NATIVE_SDK_BOUNDARY_CHANGED");
    if (context.signal.aborted) fail("NATIVE_SDK_CANCELLED");
  }
  async function measure(request: Request, signal: AbortSignal) {
    if (request.method !== "POST" || !request.body) fail("NATIVE_SDK_CONTEXT_DENIED");
    const reader = request.clone().body!.getReader(), hash = createHash("sha256");
    const utf8 = new TextDecoder("utf-8", { fatal: true });
    const body = Buffer.allocUnsafe(binding.budget.maxRequestBytes);
    let serializedBytes = 0, completed = false;
    try {
      while (true) {
        const part = await wait(reader.read(), signal);
        current();
        if (part.done) { utf8.decode(); completed = true; break; }
        if (serializedBytes + part.value.byteLength > binding.budget.maxRequestBytes) fail("NATIVE_SDK_BUDGET_EXCEEDED");
        body.set(part.value, serializedBytes);
        const snapshot = body.subarray(serializedBytes, serializedBytes + part.value.byteLength);
        serializedBytes += snapshot.byteLength;
        utf8.decode(snapshot, { stream: true });
        hash.update(snapshot);
      }
      return { body: new Uint8Array(body.subarray(0, serializedBytes)),
        measurement: { provider: "copilot-sdk" as const, countingMethod: "sdk-serialized-utf8-bytes" as const,
          serializedBytes, payloadSha256: hash.digest("hex"), providerTokenCount: null } };
    } finally {
      if (!completed) void reader.cancel().catch(() => {});
      reader.releaseLock();
    }
  }
  async function guarded<T>(work: () => Promise<T>) {
    try { return await work(); }
    catch (error) {
      closed = true; clearTimeout(deadline); lifetime.abort();
      if (error instanceof OriginalSdkForwardingError) throw error;
      return fail("NATIVE_SDK_FORWARDING_FAILED");
    }
  }
  class Forwarder extends api.CopilotWebSocketForwarder {
    constructor(private readonly connection: OriginalSdkRequestContext) { super(connection); }
    override async sendRequestMessage(data: string | Uint8Array, context?: OriginalSdkRequestContext): Promise<void> {
      await guarded(async () => {
        if (!context) return fail("NATIVE_SDK_CONTEXT_DENIED");
        if (context.requestId !== this.connection.requestId || context.url !== this.connection.url
          || context.sessionId !== this.connection.sessionId) fail("NATIVE_SDK_CONTEXT_DENIED");
        const bound = contextFor(context, "websocket");
        const payload = typeof data === "string" ? data : new Uint8Array(data);
        await approve("websocket-message", bound, measureOriginalSdkSerializedPayload(payload));
        potentiallyDispatched = true;
        super.sendRequestMessage(payload, bound);
      });
    }
  }
  class Handler extends api.CopilotRequestHandler {
    forwardHttp(request: Request, context: OriginalSdkRequestContext) { return this.sendRequest(request, context); }
    forwardWebSocket(context: OriginalSdkRequestContext) { return this.openWebSocket(context); }
    protected override async sendRequest(request: Request, context: OriginalSdkRequestContext): Promise<Response> {
      return guarded(async () => {
        const bound = contextFor(context, "http");
        if (request.url !== context.url) fail("NATIVE_SDK_DESTINATION_DENIED");
        const payload = await measure(request, bound.signal);
        const prepared = new Request(request, { body: payload.body, redirect: "error" });
        await approve("http-request", bound, payload.measurement);
        potentiallyDispatched = true;
        return await super.sendRequest(prepared, bound);
      });
    }
    protected override async openWebSocket(context: OriginalSdkRequestContext) {
      return guarded(async () => {
        const bound = contextFor(context, "websocket");
        await approve("websocket-connect", bound, measureOriginalSdkSerializedPayload(""));
        // The SDK subsequently opens this approved connection; completion remains the owning executor's responsibility.
        potentiallyDispatched = true;
        return new Forwarder(bound);
      });
    }
  }
  return Object.freeze({
    handler: new Handler(),
    signal: ownerSignal,
    bindingSha256: originalSdkDigest(binding),
    clientOptionsSha256,
    assertCurrent: current,
    dispatchState: () => potentiallyDispatched ? "uncertain" as const : "not-sent" as const,
    dispose() { closed = true; clearTimeout(deadline); lifetime.abort(); },
  });
}

/** Model-boundary permission never substitutes for the existing canonical tool/effect authorizer. */
export async function invokeOriginalSdkCanonicalTool(input: OriginalSdkCanonicalToolCall, ports: {
  assertCurrent(): void;
  authorize(call: Readonly<OriginalSdkCanonicalToolCall>, signal: AbortSignal): Promise<void>;
  execute(call: Readonly<OriginalSdkCanonicalToolCall>, signal: AbortSignal): Promise<unknown>;
}, signal: AbortSignal) {
  const call = originalSdkCanonicalToolCall.parse(structuredClone(input));
  const fingerprint = originalSdkDigest(call);
  const current = () => { signal.throwIfAborted(); ports.assertCurrent(); };
  current();
  if (originalSdkDigest(call.arguments) !== call.argumentsSha256)
    throw new OriginalSdkForwardingError("NATIVE_SDK_TOOL_ARGUMENTS_DENIED", "not-sent");
  await ports.authorize(call, signal);
  current();
  if (originalSdkDigest(call) !== fingerprint)
    throw new OriginalSdkForwardingError("NATIVE_SDK_TOOL_ARGUMENTS_DENIED", "not-sent");
  const result = await ports.execute(call, signal);
  current();
  return result;
}
