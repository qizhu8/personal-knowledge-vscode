import * as vscode from "vscode";
import { createOriginalNativeChatTokenCounter } from "./original-mcp-native-chat-token-counter.js";
import { createHash, randomUUID } from "node:crypto";
import { readFileSync, realpathSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import { originalMcpNativeSigner } from "./original-mcp-native-identity.js";
import {
  originalNativeChatDigest as approvalBridgeDigest, originalVscodeModelRequestDigest, originalNativeChatInferenceDigest,
  type OriginalVscodeChatModelPort, type OriginalNativeChatExecutionPort, type OriginalNativeChatExecutionPlan,
  type OriginalNativeChatMessage,
} from "../../src/original-mcp-api-chat-contracts.js";
import type { ModelProviderTool, ModelProviderEvent, ModelProviderUsage } from "../../src/model-provider-contracts.js";
import type { streamVscodeChat } from "../../legacy/src/chat/api-chat-vscode.js";
import type { decodeChatImage, ApiChatMessage } from "../../legacy/src/chat/api-chat-client.js";
import type { copilotSdkModels, copilotSdkPrompt, streamCopilotSdkChat } from "../../legacy/src/chat/api-chat-copilot-sdk.js";
import {
  originalNativeTaskBinding, OriginalNativeTaskSemanticError,
  type OriginalNativeTaskContextCallback,
} from "../../src/original-mcp-api-chat-task-execution-contracts.js";
import { createOriginalNativeTaskRetainedHooks } from "./original-mcp-native-task-hooks.js";
import { createOriginalSdkChatPort, type OriginalSdkHostControl } from "./original-mcp-native-sdk-chat.js";
import type { OriginalSdkChatPort, OriginalSdkUnavailableStatus } from "../../src/original-mcp-sdk-model-contracts.js";

type Catalogue = Awaited<ReturnType<OriginalVscodeChatModelPort["catalogue"]>>;
type Metadata = Catalogue["models"][number];
type NativeTool = { name: string; description: string; inputSchema: Record<string, unknown> };
type NativeOptions = vscode.LanguageModelChatRequestOptions & { tools?: NativeTool[] };
type NativePart = { value?: string; callId?: string; name?: string; input?: unknown; data?: Uint8Array; mimeType?: string };
type NativeParts = {
  LanguageModelTextPart: new (value: string) => NativePart;
  LanguageModelToolCallPart: new (callId: string, name: string, input: unknown) => NativePart;
  LanguageModelToolResultPart: new (callId: string, content: NativePart[]) => NativePart;
};
type Selected = { model: vscode.LanguageModelChat; metadata: Metadata; epoch: string };
type Retained = { streamVscodeChat: typeof streamVscodeChat; decodeChatImage: typeof decodeChatImage;
  streamCopilotSdkChat?: typeof streamCopilotSdkChat; copilotSdkPrompt?: typeof copilotSdkPrompt;
  copilotSdkModels?: typeof copilotSdkModels };
type ModelCapabilities = { toolCalling?: boolean | number; imageInput?: boolean };
type InferenceAdmission = Parameters<Parameters<OriginalNativeChatExecutionPort["run"]>[1]["beforeInference"]>[0];
type LocalExecutionRun = (plan: Readonly<OriginalNativeChatExecutionPlan>,
  ports: Parameters<OriginalNativeChatExecutionPort["run"]>[1] & { taskContext?: OriginalNativeTaskContextCallback },
  signal: AbortSignal,
  admit?: (model: string, request: InferenceAdmission, dispatch: () => Promise<void>) => Promise<void>) =>
  ReturnType<OriginalNativeChatExecutionPort["run"]>;
type LocalExecution = { run: LocalExecutionRun; managedTask: { run: LocalExecutionRun } };
type Producer = { models: OriginalVscodeChatModelPort; execution: LocalExecution; sdk?: OriginalSdkChatPort;
  sdkUnavailable?: OriginalSdkUnavailableStatus; dispose(): void };
const producers = new WeakMap<vscode.ExtensionContext, Promise<Producer>>();
const sdkControls = new WeakMap<vscode.ExtensionContext, OriginalSdkHostControl>();
type CancellationOrigin = "invocation" | "producer-lifetime" | "registry-change" | "deadline" | "text-sink" | "usage-sink" | "explicit-cancel";
type CancellationStage = "catalogue" | "selection" | "token-count" | "model-stream" | "execution"
  | "execution-token-count" | "execution-before-inference" | "execution-model-send" | "execution-model-stream" | "execution-tool" | "execution-usage";
const cancellationCodes = new Set(["EPIPE", "ECONNRESET", "ERR_STREAM_DESTROYED", "ABORT_ERR", "NATIVE_DENIED",
  "NATIVE_ATTACHMENT_HEARTBEAT_TIMEOUT", "NATIVE_ATTACHMENT_SESSION_REVOKED", "NATIVE_CHAT_CANCELLED",
  "NATIVE_CHAT_CLOSED", "NATIVE_CHAT_TIMEOUT", "NATIVE_CHAT_PROTOCOL_INVALID", "NATIVE_CHAT_SESSION_REVOKED",
  "NATIVE_CHAT_DISPATCH_UNCERTAIN", "NATIVE_CHAT_CORE_CALLBACK_FAILED", "NATIVE_REQUEST_CANCELLED"]);
function cancellationCauseCodes(error: unknown): string[] {
  const codes: string[] = [];
  try {
    for (let depth = 0; error && typeof error === "object" && depth < 3; depth++) {
      const code = Object.getOwnPropertyDescriptor(error, "code")?.value;
      codes.push(typeof code === "string" && cancellationCodes.has(code) ? code : "UNCLASSIFIED");
      error = Object.getOwnPropertyDescriptor(error, "cause")?.value;
    }
  } catch { codes.push("UNAVAILABLE"); }
  return codes.slice(0, 3);
}

/** Local ceilings, not provider metadata, usage, or a claim that a request is free. */
export const originalNativeChatProducerPolicy = Object.freeze({
  deadlineMs: 300_000, maxOutputTokens: 8192, maxTotalOutputTokens: 32768,
  maxOutputBytes: 100_000, maxRequestBytes: 16 * 1024 * 1024,
  maxPendingSelections: 256, maxInvocationIds: 4096,
  inputOverhead: Object.freeze({ envelopeTokens: 32, perMessageTokens: 32, toolSchemaTokens: 32 }),
});

export class OriginalNativeChatInvocationError extends Error {
  readonly code: "NATIVE_CHAT_DISPATCH_UNCERTAIN" | "NATIVE_CHAT_CANCELLED";
  readonly dispatch = "uncertain";
  constructor(readonly cancelled = false) {
    super(`${cancelled ? "NATIVE_CHAT_CANCELLED: " : ""}Native invocation outcome is uncertain; reconcile before an explicit new request.`);
    this.code = cancelled ? "NATIVE_CHAT_CANCELLED" : "NATIVE_CHAT_DISPATCH_UNCERTAIN";
    this.name = "OriginalNativeChatInvocationError";
  }
}

function fail(code: string): never { throw new Error(`NATIVE_CHAT_${code}`); }
function hash(bytes: string | Buffer) { return createHash("sha256").update(bytes).digest("hex"); }
function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}
function hasParts(api: typeof vscode): api is typeof vscode & NativeParts {
  return "LanguageModelTextPart" in api && typeof api.LanguageModelTextPart === "function"
    && "LanguageModelToolCallPart" in api && typeof api.LanguageModelToolCallPart === "function"
    && "LanguageModelToolResultPart" in api && typeof api.LanguageModelToolResultPart === "function";
}
function hasData(api: typeof vscode): api is typeof vscode & {
  LanguageModelDataPart: new (data: Uint8Array, mimeType: string) => NativePart;
} {
  return "LanguageModelDataPart" in api && typeof api.LanguageModelDataPart === "function";
}
function capabilities(model: vscode.LanguageModelChat): ModelCapabilities | undefined {
  if (!("capabilities" in model) || model.capabilities === undefined) return;
  const found = model.capabilities;
  if (!isRecord(found) || found.toolCalling !== undefined && typeof found.toolCalling !== "boolean"
    && !(typeof found.toolCalling === "number" && Number.isSafeInteger(found.toolCalling) && found.toolCalling >= 0)
    || found.imageInput !== undefined && typeof found.imageInput !== "boolean") return fail("MODEL_CAPABILITIES");
  return {
    ...(typeof found.toolCalling === "boolean" || typeof found.toolCalling === "number" ? { toolCalling: found.toolCalling } : {}),
    ...(typeof found.imageInput === "boolean" ? { imageInput: found.imageInput } : {}),
  };
}
function dataPart(value: unknown): value is NativePart & { data: Uint8Array; mimeType: string } {
  return isRecord(value) && "LanguageModelDataPart" in vscode && typeof vscode.LanguageModelDataPart === "function"
    && value instanceof vscode.LanguageModelDataPart && value.data instanceof Uint8Array && typeof value.mimeType === "string";
}
function hiddenPart(value: unknown) {
  return "LanguageModelThinkingPart" in vscode && typeof vscode.LanguageModelThinkingPart === "function"
    && value instanceof vscode.LanguageModelThinkingPart;
}
function reportedUsage(part: NativePart & { data: Uint8Array }): ModelProviderEvent {
  if (part.data.byteLength > 65536) return fail("USAGE_METADATA");
  const value: unknown = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(part.data));
  if (!isRecord(value) || typeof value.prompt_tokens !== "number" || typeof value.completion_tokens !== "number"
    || ![value.prompt_tokens, value.completion_tokens].every(count => Number.isSafeInteger(count) && count >= 0))
    return fail("USAGE_METADATA");
  return { type: "usage", inputTokens: value.prompt_tokens, outputTokens: value.completion_tokens };
}
function metadata(model: vscode.LanguageModelChat): Metadata {
  if (model.vendor === "copilotcli" || model.vendor === "copilot-sdk") return fail("CATALOGUE_ONLY_MODEL");
  const maxOutputTokens = "maxOutputTokens" in model && typeof model.maxOutputTokens === "number"
    && Number.isSafeInteger(model.maxOutputTokens) && model.maxOutputTokens > 0 ? model.maxOutputTokens : null;
  const result = {
    id: `vscode:${encodeURIComponent(model.vendor)}:${encodeURIComponent(model.id)}`,
    nativeModelId: model.id, label: model.name, vendor: model.vendor, family: model.family, version: model.version,
    maxInputTokens: model.maxInputTokens, maxOutputTokens,
    imageInput: capabilities(model)?.imageInput ?? null, toolCalling: capabilities(model)?.toolCalling ?? null,
  };
  if ([result.id, model.id, model.name].some(value => typeof value !== "string" || !value || value.length > 512)
    || [model.vendor, model.family, model.version].some(value => typeof value !== "string" || value.length > 512)
    || !Number.isSafeInteger(model.maxInputTokens) || model.maxInputTokens < 1
    || typeof model.countTokens !== "function" || typeof model.sendRequest !== "function") return fail("MODEL_METADATA");
  return result;
}
function nativeTools(tools: readonly ModelProviderTool[]): NativeTool[] {
  if (tools.length > 4096 || new Set(tools.map(tool => tool.name)).size !== tools.length) return fail("TOOLS");
  if (tools.length && !hasParts(vscode)) return fail("TOOL_API_UNAVAILABLE");
  return tools.map(tool => {
    if (!tool.name || tool.name.length > 200 || typeof tool.description !== "string" || !isRecord(tool.parameters))
      return fail("TOOLS");
    return { name: tool.name, description: tool.description, inputSchema: structuredClone(tool.parameters) };
  });
}
function nativeMessages(messages: readonly OriginalNativeChatMessage[], decode: typeof decodeChatImage): vscode.LanguageModelChatMessage[] {
  return messages.map(message => {
    if (typeof message.content !== "string" || !["system", "user", "assistant", "tool"].includes(message.role))
      return fail("MESSAGES");
    const content = message.role === "system" ? `[PKM instructions and reference context]\n${message.content}` : message.content;
    const entry = message.role === "assistant" ? vscode.LanguageModelChatMessage.Assistant(content)
      : vscode.LanguageModelChatMessage.User(content);
    if (message.role === "tool" || message.tool_calls?.length || message.images?.length) {
      if (!hasParts(vscode)) return fail("TOOL_API_UNAVAILABLE");
      const parts = [new vscode.LanguageModelTextPart(content)];
      for (const image of message.images || []) {
        if (!hasData(vscode)) return fail("IMAGE_API_UNAVAILABLE");
        parts.push(new vscode.LanguageModelDataPart(decode(image), image.mimeType));
      }
      if (message.role === "tool") {
        if (!message.tool_call_id) return fail("TOOL_MESSAGES");
        parts.splice(0, 1, new vscode.LanguageModelToolResultPart(message.tool_call_id, parts.slice()));
      } else for (const call of message.tool_calls || []) {
        const args: unknown = JSON.parse(call.function.arguments);
        if (!isRecord(args)) return fail("TOOL_MESSAGES");
        parts.push(new vscode.LanguageModelToolCallPart(call.id, call.function.name, args));
      }
      Object.assign(entry, { content: parts });
    } else if (hasParts(vscode)) Object.assign(entry, { content: [new vscode.LanguageModelTextPart(content)] });
    return entry;
  });
}
function boundedJson(value: unknown): unknown {
  const json = JSON.stringify(value);
  if (!json || Buffer.byteLength(json) > originalNativeChatProducerPolicy.maxRequestBytes) return fail("REQUEST_SIZE");
  return JSON.parse(json);
}
function outputCap(value: number, model: Metadata) {
  if (!Number.isSafeInteger(value) || value < 1 || value > originalNativeChatProducerPolicy.maxOutputTokens
    || model.maxOutputTokens !== null && value > model.maxOutputTokens) return fail("OUTPUT_POLICY");
}
function retainedRuntime(context: vscode.ExtensionContext): Retained {
  const relative = "server/dist/native-vscode-chat-retained.cjs";
  const directory = join(context.extensionPath, "next-runtime"), file = join(directory, relative);
  const manifest: unknown = JSON.parse(readFileSync(join(directory, "manifest.json"), "utf8"));
  if (!isRecord(manifest) || manifest.schema !== "pkm.next-payload/v1" || !isRecord(manifest.files)
    || typeof manifest.files[relative] !== "string" || realpathSync(file) !== file
    || hash(readFileSync(file)) !== manifest.files[relative]) return fail("RETAINED_PAYLOAD_UNVERIFIED");
  const loaded: unknown = createRequire(join(context.extensionPath, "package.json"))(file);
  if (!isRecord(loaded) || typeof loaded.streamVscodeChat !== "function"
    || typeof loaded.decodeChatImage !== "function") return fail("RETAINED_ENGINE_UNAVAILABLE");
  // The concrete signature is checked against the frozen engine at compile time.
  return loaded as Retained;
}

/**
 * Installed native producer only. It registers no commands and conveys no tool,
 * business-state, Action, or historical chat authority.
 */
async function createProducer(context: vscode.ExtensionContext,
  diagnostics: Pick<vscode.OutputChannel, "appendLine">): Promise<Producer> {
  const signer = await originalMcpNativeSigner(context);
  signer.assertCurrent();
  if (!vscode.lm?.selectChatModels || !vscode.lm.onDidChangeChatModels) return fail("MODEL_API_UNAVAILABLE");
  const retained = retainedRuntime(context), lifetime = new AbortController();
  let registry = new AbortController(), revision = 0, catalogue: Catalogue | undefined;
  let expectedCancellationRecords = 0, unexpectedCancellationRecords = 0;
  const selections = new Map<string, Selected>(), invoked = new Set<string>();
  const counted = new Map<string, { requestSha256: string; payloadSha256: string; inputTokens: number }>();
  const epoch = () => signer.activationId;
  const invalidate = () => {
    registry.abort(); registry = new AbortController(); revision++; catalogue = undefined; selections.clear(); counted.clear();
  };
  const subscription = vscode.lm.onDidChangeChatModels(invalidate);
  const revoke = () => { lifetime.abort(); registry.abort(); selections.clear(); counted.clear(); };
  signer.signal.addEventListener("abort", revoke, { once: true });
  if (signer.signal.aborted) revoke();
  const dispose = () => { revoke(); subscription.dispose(); signer.signal.removeEventListener("abort", revoke); };
  context.subscriptions.push({ dispose });
  function assertCurrent() {
    if (lifetime.signal.aborted) return fail("REVOKED");
    signer.assertCurrent();
  }
  function scope(signal: AbortSignal, deadlineMs: number = originalNativeChatProducerPolicy.deadlineMs,
    initialStage: CancellationStage = "execution") {
    assertCurrent();
    const controller = new AbortController(), cancellation = new vscode.CancellationTokenSource();
    const startedAt = performance.now();
    let stage = initialStage, stageStartedAt = startedAt, firstCancellationRecorded = false;
    let localFailure: { origin: CancellationOrigin; reason: unknown } | undefined;
    const cancel = (origin: CancellationOrigin = "explicit-cancel", reason?: unknown, expectedShutdown = false) => {
      if (!firstCancellationRecorded) {
        firstCancellationRecorded = true;
        const permitted = expectedShutdown ? expectedCancellationRecords++ < 16 : unexpectedCancellationRecords++ < 32;
        if (permitted) try {
          const now = performance.now(), memory = process.memoryUsage();
          const line = `[pkm.native-chat.first-cancel] ${JSON.stringify({
            origin, stage, expectedShutdown, epochTimeMs: Date.now(), monotonicMs: now, pid: process.pid,
            elapsedMs: now - startedAt, stageElapsedMs: now - stageStartedAt, deadlineMs, registryRevision: revision,
            rssBytes: memory.rss, heapUsedBytes: memory.heapUsed, heapTotalBytes: memory.heapTotal,
            causeCodes: cancellationCauseCodes(reason),
          })}`;
          try { diagnostics.appendLine(line); }
          catch { try { console.error(line); } catch { /* Cancellation remains mandatory if both sinks fail. */ } }
        } catch { /* Cancellation is required even if diagnostics cannot be recorded. */ }
      }
      controller.abort(); cancellation.cancel();
    };
    const sources = [
      { signal, origin: "invocation" as const }, { signal: lifetime.signal, origin: "producer-lifetime" as const },
      { signal: registry.signal, origin: "registry-change" as const },
    ].map(source => ({ ...source, listener: () => cancel(source.origin, source.signal.reason) }));
    for (const source of sources) {
      source.signal.addEventListener("abort", source.listener, { once: true });
      if (source.signal.aborted) source.listener();
    }
    const timer = setTimeout(() => cancel("deadline"), deadlineMs);
    const countTokens = createOriginalNativeChatTokenCounter(() => {
      assertCurrent(); if (controller.signal.aborted) return fail("CANCELLED");
    });
    return {
      signal: controller.signal, token: cancellation.token, cancel,
      setStage(value: CancellationStage) {
        if (stage !== value) { stage = value; stageStartedAt = performance.now(); }
      },
      noteFailure(origin: CancellationOrigin, reason: unknown) { localFailure ??= { origin, reason }; },
      check() { assertCurrent(); if (controller.signal.aborted) return fail("CANCELLED"); },
      countTokens<T>(count: () => PromiseLike<T>): Promise<T> {
        return countTokens(() => this.wait(count()));
      },
      async wait<T>(operation: PromiseLike<T>): Promise<T> {
        this.check();
        return new Promise<T>((resolve, reject) => {
          const abort = () => reject(new Error("NATIVE_CHAT_CANCELLED"));
          controller.signal.addEventListener("abort", abort, { once: true });
          Promise.resolve(operation).then(value => {
            try { this.check(); resolve(value); } catch (error) { reject(error); }
          }, reject).finally(() => controller.signal.removeEventListener("abort", abort));
          if (controller.signal.aborted) abort();
        });
      },
      dispose() {
        clearTimeout(timer); cancel(localFailure?.origin ?? "explicit-cancel", localFailure?.reason, !localFailure); cancellation.dispose();
        for (const source of sources) source.signal.removeEventListener("abort", source.listener);
      },
    };
  }
  type Scope = ReturnType<typeof scope>;
  function messagesFor(selected: Selected, messages: readonly OriginalNativeChatMessage[]) {
    if (messages.some(message => message.images?.length) && capabilities(selected.model)?.imageInput !== true)
      return fail("MODEL_IMAGES_UNAVAILABLE");
    return nativeMessages(messages, retained.decodeChatImage);
  }
  async function current(id: string, operation: Scope): Promise<Selected> {
    operation.check();
    const selected = selections.get(id);
    if (!selected || selected.epoch !== epoch()) return fail("STALE_SELECTION");
    const matches = await operation.wait(vscode.lm.selectChatModels({
      id: selected.metadata.nativeModelId, vendor: selected.metadata.vendor,
    }));
    operation.check();
    if (matches.length !== 1 || approvalBridgeDigest(metadata(matches[0])) !== approvalBridgeDigest(selected.metadata)) {
      invalidate(); return fail("STALE_MODEL");
    }
    selected.model = matches[0];
    return selected;
  }
  async function count(model: vscode.LanguageModelChat, messages: readonly vscode.LanguageModelChatMessage[],
    tools: readonly NativeTool[], operation: Scope): Promise<number> {
    let tokens = originalNativeChatProducerPolicy.inputOverhead.envelopeTokens;
    for (const message of messages) {
      operation.check();
      const value = await operation.countTokens(() => model.countTokens(message, operation.token));
      if (!Number.isSafeInteger(value) || value < 0) return fail("TOKEN_COUNT_UNAVAILABLE");
      tokens += value + originalNativeChatProducerPolicy.inputOverhead.perMessageTokens;
    }
    if (tools.length) {
      const value = await operation.countTokens(() => model.countTokens(JSON.stringify(tools), operation.token));
      if (!Number.isSafeInteger(value) || value < 0) return fail("TOKEN_COUNT_UNAVAILABLE");
      tokens += value + originalNativeChatProducerPolicy.inputOverhead.toolSchemaTokens;
    }
    operation.check();
    if (!Number.isSafeInteger(tokens)) return fail("TOKEN_COUNT_UNAVAILABLE");
    return tokens;
  }
  function claim(id: string) {
    if (typeof id !== "string" || !id || id.length > 512 || invoked.has(id)) return fail("INVOCATION_REPLAY");
    if (invoked.size >= originalNativeChatProducerPolicy.maxInvocationIds) return fail("INVOCATION_LEDGER_FULL");
    invoked.add(id);
  }
  function source(response: vscode.LanguageModelChatResponse): AsyncIterable<unknown> {
    if ("stream" in response) {
      const stream = response.stream;
      if (stream && typeof stream === "object" && Symbol.asyncIterator in stream
        && typeof stream[Symbol.asyncIterator] === "function") return stream as AsyncIterable<unknown>;
      return fail("INVALID_STREAM");
    }
    return response.text;
  }
  async function* responseParts(response: vscode.LanguageModelChatResponse, operation: Scope): AsyncIterable<unknown> {
    const iterator = source(response)[Symbol.asyncIterator]();
    try {
      while (true) {
        const next = await operation.wait(iterator.next());
        if (next.done) return;
        yield next.value;
      }
    } finally {
      const ending = iterator.return?.();
      if (ending) void Promise.resolve(ending).catch(() => {});
    }
  }
  const models: OriginalVscodeChatModelPort = {
    async catalogue(signal) {
      for (let attempt = 0; attempt < 3; attempt++) {
        const observedRevision = revision, operation = scope(signal, originalNativeChatProducerPolicy.deadlineMs, "catalogue");
        try {
          const found = await operation.wait(vscode.lm.selectChatModels());
          operation.check();
          const models = found.filter(model => !["copilotcli", "copilot-sdk"].includes(model.vendor)).map(metadata)
            .sort((left, right) => left.id.localeCompare(right.id));
          if (models.length > 4096 || new Set(models.map(model => model.id)).size !== models.length) return fail("MODEL_CATALOGUE");
          if (catalogue && approvalBridgeDigest(catalogue.models) !== approvalBridgeDigest(models)) invalidate();
          catalogue = { source: "vscode.lm", epoch: epoch(), registryRevision: String(revision), models };
          return structuredClone(catalogue);
        } catch (error) {
          // Initial provider discovery can itself publish a registry change; only this read may retry.
          if (!(error instanceof Error) || error.message !== "NATIVE_CHAT_CANCELLED"
            || observedRevision === revision || signal.aborted || lifetime.signal.aborted) throw error;
          assertCurrent();
        } finally { operation.dispose(); }
      }
      return fail("CATALOGUE_CHANGED");
    },
    async select(input, signal) {
      const operation = scope(signal, originalNativeChatProducerPolicy.deadlineMs, "selection");
      try {
        if (!catalogue || input.catalogueSha256 !== approvalBridgeDigest(catalogue)) return fail("STALE_CATALOGUE");
        const selected = catalogue.models.find(model => model.id === input.modelId);
        if (!selected) return fail("REQUESTED_MODEL_UNAVAILABLE");
        if (selections.size >= originalNativeChatProducerPolicy.maxPendingSelections) return fail("SELECTION_LIMIT");
        const selectionId = randomUUID();
        const found = await operation.wait(vscode.lm.selectChatModels({ id: selected.nativeModelId, vendor: selected.vendor }));
        operation.check();
        if (found.length !== 1 || approvalBridgeDigest(metadata(found[0])) !== approvalBridgeDigest(selected)) {
          invalidate(); return fail("STALE_MODEL");
        }
        selections.set(selectionId, { model: found[0], metadata: selected, epoch: epoch() });
        return { selectionId, modelId: selected.id, epoch: epoch(), maxInputTokens: selected.maxInputTokens };
      } finally { operation.dispose(); }
    },
    async count(input, signal) {
      const operation = scope(signal, originalNativeChatProducerPolicy.deadlineMs, "token-count");
      try {
        const selected = await current(input.selectionId, operation);
        outputCap(input.outputTokenCap, selected.metadata);
        if (input.requestSha256 !== originalVscodeModelRequestDigest({
          selectionId: input.selectionId, requestId: input.requestId, messages: input.messages,
          tools: input.tools, outputTokenCap: input.outputTokenCap,
        })) return fail("REQUEST_DIGEST");
        const messages = messagesFor(selected, input.messages), tools = nativeTools(input.tools);
        const toolCalling = capabilities(selected.model)?.toolCalling;
        if (tools.length && toolCalling !== undefined && !(toolCalling === true
          || typeof toolCalling === "number" && toolCalling >= tools.length)) return fail("MODEL_TOOLS_UNAVAILABLE");
        const payloadSha256 = approvalBridgeDigest(boundedJson({ messages, tools }));
        const inputTokens = await count(selected.model, messages, tools, operation);
        if (inputTokens > selected.metadata.maxInputTokens) return fail("INPUT_BUDGET");
        counted.set(input.selectionId, { requestSha256: input.requestSha256, payloadSha256, inputTokens });
        return { selectionId: input.selectionId, requestSha256: input.requestSha256,
          inputTokens, countingMethod: "vscode-countTokens-plus-tool-overhead" };
      } finally { operation.dispose(); }
    },
    async *stream(input, signal) {
      const operation = scope(signal, originalNativeChatProducerPolicy.deadlineMs, "model-stream");
      let dispatched = false;
      try {
        const selected = await current(input.selectionId, operation);
        outputCap(input.outputTokenCap, selected.metadata);
        if (input.requestSha256 !== originalVscodeModelRequestDigest({
          selectionId: input.selectionId, requestId: input.requestId, messages: input.messages,
          tools: input.tools, outputTokenCap: input.outputTokenCap,
        })) return fail("REQUEST_DIGEST");
        const messages = messagesFor(selected, input.messages), tools = nativeTools(input.tools);
        const prior = counted.get(input.selectionId);
        if (!prior || prior.requestSha256 !== input.requestSha256
          || prior.payloadSha256 !== approvalBridgeDigest(boundedJson({ messages, tools }))) return fail("UNCOUNTED_REQUEST");
        claim(input.requestId);
        operation.check(); dispatched = true;
        const options: NativeOptions = { justification: "Use the exact approved PKM native model request.",
          ...(tools.length ? { tools } : {}) };
        const response = await operation.wait(selected.model.sendRequest(messages, options, operation.token));
        let output = "", bytes = 0, calls = 0;
        const ids = new Set<string>();
        let metadataParts = 0;
        for await (const part of responseParts(response, operation)) {
          operation.check();
          let event: ModelProviderEvent;
          if (typeof part === "string" || hasParts(vscode) && part instanceof vscode.LanguageModelTextPart) {
            const text = typeof part === "string" ? part : part.value || "";
            output += text; event = { type: "text", text };
          } else if (hasParts(vscode) && part instanceof vscode.LanguageModelToolCallPart) {
            if (!part.callId || part.callId.length > 200 || ids.has(part.callId) || !part.name
              || !tools.some(tool => tool.name === part.name) || !isRecord(part.input) || ++calls > 16) return fail("TOOL_PROPOSAL");
            ids.add(part.callId);
            const arguments_ = boundedJson(part.input);
            if (!isRecord(arguments_) || JSON.stringify(arguments_).length > 32000) return fail("TOOL_PROPOSAL");
            output += JSON.stringify({ id: part.callId, name: part.name, arguments: JSON.stringify(arguments_) });
            event = { type: "tool", id: part.callId, name: part.name, arguments: arguments_ };
          } else if (dataPart(part) && part.mimeType === "usage") {
            if (++metadataParts > 128) return fail("USAGE_METADATA");
            const usage = reportedUsage(part);
            yield usage;
            if (usage.type === "usage" && usage.outputTokens > input.outputTokenCap) return fail("OUTPUT_BUDGET");
            continue;
          } else if (hiddenPart(part)) continue;
          else return fail("UNSUPPORTED_RESPONSE_PART");
          bytes = Buffer.byteLength(output);
          if (bytes > originalNativeChatProducerPolicy.maxOutputBytes) return fail("OUTPUT_BUDGET");
          const tokens = await operation.countTokens(() => selected.model.countTokens(output, operation.token));
          if (!Number.isSafeInteger(tokens) || tokens < 0) return fail("TOKEN_COUNT_UNAVAILABLE");
          if (tokens > input.outputTokenCap) return fail("OUTPUT_BUDGET");
          yield event;
        }
        operation.check();
        if (!output) return fail("EMPTY_RESPONSE");
        yield { type: "finish", reason: calls ? "tool_calls" : "stop" };
      } catch (error) {
        if (dispatched) throw new OriginalNativeChatInvocationError(operation.signal.aborted);
        throw error;
      } finally { operation.dispose(); }
    },
  };
  const runExecution: LocalExecutionRun = async (value, ports, signal, admit) => {
      const plan: OriginalNativeChatExecutionPlan = structuredClone(value);
      if (!plan.budget || !Number.isSafeInteger(plan.budget.deadlineMs) || plan.budget.deadlineMs < 1
        || plan.budget.deadlineMs > originalNativeChatProducerPolicy.deadlineMs
        || !Number.isSafeInteger(plan.budget.maxTotalOutputTokens) || plan.budget.maxTotalOutputTokens < 1
        || plan.budget.maxTotalOutputTokens > originalNativeChatProducerPolicy.maxTotalOutputTokens
        || !Number.isSafeInteger(plan.budget.maxInputTokens) || plan.budget.maxInputTokens < 1)
        return { status: "failed", toolRoundLimit: null };
      const operation = scope(signal, plan.budget.deadlineMs);
      let uncertain = false, dispatched = false, inferenceId = "", round = 0, nextRound = 0, attempts = 0;
      let pendingText: Promise<void> | undefined, textFailure: unknown;
      let pendingUsage: Promise<void> | undefined, usageFailure: unknown;
      let activeTool: { id: string; name: string; arguments: string } | undefined;
      let boundary: { limit: number; rounds: number; reached: boolean } | null = null;
      let semanticFailure: OriginalNativeTaskSemanticError | undefined;
      let pendingAfterTools: Promise<void> | undefined, afterToolsFailure: unknown;
      let hadToolCalls = false;
      const proposedTaskTools = new Set<string>(), terminalTaskTools = new Set<string>();
      const receipts: string[] = [];
      let totalOutputTokens = 0, currentOutputTokens = 0;
      const flushText = async () => {
        const pending = pendingText; pendingText = undefined;
        if (pending) await operation.wait(pending);
        if (textFailure) throw textFailure;
        const usage = pendingUsage; pendingUsage = undefined;
        if (usage) await operation.wait(usage);
        if (usageFailure) throw usageFailure;
        operation.check();
      };
      const observe = async (work: () => Promise<void>) => {
        try { await work(); }
        catch (error) {
          if (error instanceof OriginalNativeTaskSemanticError) semanticFailure = error;
          throw error;
        }
      };
      const flushAfterTools = async () => {
        const pending = pendingAfterTools; pendingAfterTools = undefined;
        if (pending) await pending;
        if (afterToolsFailure) throw afterToolsFailure;
      };
      try {
        const taskPlan = "managedTask" in value
          ? { ...plan, managedTask: originalNativeTaskBinding.parse(value.managedTask) } : undefined;
        if (taskPlan && !ports.taskContext) return fail("TASK_CONTEXT_REQUIRED");
        const hooks = taskPlan && ports.taskContext ? createOriginalNativeTaskRetainedHooks(taskPlan, ports.taskContext) : undefined;
        if (plan.schema !== "pkm.original-api-chat-execution/v1" || !/^[a-f0-9]{64}$/.test(plan.sourcePlanSha256)
          || plan.hardToolRoundLimit !== null && (!Number.isSafeInteger(plan.hardToolRoundLimit)
            || plan.hardToolRoundLimit < 1 || plan.hardToolRoundLimit > 1000)) return fail("EXECUTION_PLAN");
        boundedJson(plan);
        const selected = await current(plan.selectionId, operation);
        outputCap(plan.outputTokenCap, selected.metadata);
        nativeTools(plan.tools);
        const planSha256 = approvalBridgeDigest(plan);
        claim(plan.requestId);
        const wrapped: vscode.LanguageModelChat = {
          id: selected.model.id, name: selected.model.name, vendor: selected.model.vendor,
          family: selected.model.family, version: selected.model.version, maxInputTokens: selected.model.maxInputTokens,
          countTokens: (input, _token) => {
            operation.check();
            operation.setStage("execution-token-count");
            return operation.countTokens(() => selected.model.countTokens(input, operation.token));
          },
          async sendRequest(messages, options, _token) {
            await flushText();
            await current(plan.selectionId, operation);
            const nativeOptions: NativeOptions = options || {};
            const tools = nativeOptions.tools || [];
            operation.setStage("execution-token-count");
            const inputTokens = await count(selected.model, messages, tools, operation);
            if (inputTokens > Math.min(selected.metadata.maxInputTokens, plan.budget.maxInputTokens)) return fail("INPUT_BUDGET");
            if (attempts++) throw new OriginalNativeChatInvocationError();
            inferenceId = approvalBridgeDigest({ requestId: plan.requestId, sourcePlanSha256: plan.sourcePlanSha256, round, receipts });
            const portable = boundedJson({ messages, options: options || {} });
            if (!isRecord(portable) || !Array.isArray(portable.messages) || !isRecord(portable.options))
              return fail("NATIVE_REQUEST");
            const admission = { inferenceId, round, planSha256, sourcePlanSha256: plan.sourcePlanSha256,
              selectionId: plan.selectionId, nativeRequest: { messages: portable.messages, options: portable.options },
              inputTokens, countingMethod: "vscode-countTokens-plus-overhead" as const };
            const requestSha256 = originalNativeChatInferenceDigest(admission);
            const request = { ...admission, requestSha256 };
            const dispatchAdmission = () => ports.beforeInference(request);
            operation.setStage("execution-before-inference");
            await operation.wait(admit ? admit(selected.model.id, request, dispatchAdmission) : dispatchAdmission());
            operation.check();
            dispatched = true;
            let response: vscode.LanguageModelChatResponse;
            operation.setStage("execution-model-send");
            try { response = await operation.wait(selected.model.sendRequest(messages, options, operation.token)); }
            catch { uncertain = true; throw new OriginalNativeChatInvocationError(); }
            async function* parts() {
              let output = "", awaitingUsage = false;
              try {
                operation.setStage("execution-model-stream");
                for await (const part of responseParts(response, operation)) {
                  await flushText();
                  if (typeof part === "string") output += part;
                  else if (hasParts(vscode) && part instanceof vscode.LanguageModelTextPart) output += part.value || "";
                  else if (hasParts(vscode) && part instanceof vscode.LanguageModelToolCallPart) {
                    if (!tools.some(tool => tool.name === part.name)) return fail("TOOL_PROPOSAL");
                    if (hooks && (!part.callId || proposedTaskTools.has(part.callId))) return fail("TOOL_PROPOSAL");
                    if (hooks && part.callId) proposedTaskTools.add(part.callId);
                    output += JSON.stringify({ id: part.callId, name: part.name, arguments: JSON.stringify(part.input) });
                    hadToolCalls = true;
                  }
                  else if (dataPart(part) || hiddenPart(part)) { yield part; continue; }
                  else return fail("UNSUPPORTED_RESPONSE_PART");
                  if (Buffer.byteLength(output) > originalNativeChatProducerPolicy.maxOutputBytes) return fail("OUTPUT_BUDGET");
                  const tokens = await operation.countTokens(() => selected.model.countTokens(output, operation.token));
                  if (!Number.isSafeInteger(tokens) || tokens < 0) return fail("TOKEN_COUNT_UNAVAILABLE");
                  if (tokens > plan.outputTokenCap || totalOutputTokens + tokens > plan.budget.maxTotalOutputTokens)
                    return fail("OUTPUT_BUDGET");
                  yield part;
                }
                await flushText();
                const tokens = await operation.countTokens(() => selected.model.countTokens(output, operation.token));
                if (!Number.isSafeInteger(tokens) || tokens < 0) return fail("TOKEN_COUNT_UNAVAILABLE");
                totalOutputTokens += tokens;
                currentOutputTokens = tokens;
                operation.setStage("execution-usage"); awaitingUsage = true;
                await operation.wait(ports.usage({ inferenceId, usage: { inputTokens, outputTokens: tokens }, source: "native-counted" }));
                awaitingUsage = false;
              } catch (error) {
                if (awaitingUsage) operation.noteFailure("usage-sink", error);
                uncertain = true; throw new OriginalNativeChatInvocationError();
              }
            }
            const stream = parts();
            // The retained engine uses stream when exposed; text is its text-only fallback.
            return Object.assign({ text: { async *[Symbol.asyncIterator]() {
              for await (const part of stream) {
                if (typeof part !== "string") return fail("STRUCTURED_STREAM_REQUIRED");
                yield part;
              }
            } } }, { stream });
          },
        };
        const model = Object.assign(wrapped, {
          ...(selected.metadata.maxOutputTokens === null ? {} : { maxOutputTokens: selected.metadata.maxOutputTokens }),
          ...(capabilities(selected.model) ? { capabilities: capabilities(selected.model) } : {}),
        });
        const legacyMessages: ApiChatMessage[] = plan.messages.map(({ images, ...message }) => ({
          ...structuredClone(message), ...(images ? { images: images.map(image => ({ ...image })) } : {}),
        }));
        await retained.streamVscodeChat(model, {
          messages: legacyMessages, signal: operation.signal, maxOutputTokens: plan.outputTokenCap,
          timeoutMs: plan.budget.deadlineMs,
          maxToolRounds: plan.hardToolRoundLimit ?? 1000,
          ...(plan.hardToolRoundLimit === null ? {} : { hardToolRoundLimit: plan.hardToolRoundLimit }),
          tools: plan.tools.map(tool => ({
            name: tool.name, description: tool.description, parameters: structuredClone(tool.parameters),
            // Unique native call IDs prevent the retained read cache bypassing Core receipts.
            readVersion: async () => activeTool?.id || fail("TOOL_BINDING"),
            async execute(arguments_) {
              await flushText();
              const call = activeTool;
              if (!call || call.name !== tool.name
                || approvalBridgeDigest(JSON.parse(call.arguments)) !== approvalBridgeDigest(arguments_)) return fail("TOOL_BINDING");
              operation.check();
              let result: Awaited<ReturnType<typeof ports.tool>>;
              try {
                operation.setStage("execution-tool");
                result = await operation.wait(ports.tool({ inferenceId, round, callId: call.id, name: call.name,
                  arguments: arguments_, argumentsSha256: approvalBridgeDigest(arguments_) }));
              } catch (error) { uncertain = true; operation.cancel("explicit-cancel", error); throw new OriginalNativeChatInvocationError(); }
              if (!/^[a-f0-9]{64}$/.test(result.receiptSha256) || typeof result.content !== "string"
                || result.content.length > 16000 || !["not-committed", "committed"].includes(result.effect)) {
                uncertain = true; operation.cancel(); throw new OriginalNativeChatInvocationError();
              }
              receipts.push(result.receiptSha256);
              return result.content;
            },
          })),
          beforeRound: async () => {
            await flushAfterTools(); await flushText();
            attempts = 0; round = nextRound++; currentOutputTokens = 0; hadToolCalls = false;
            proposedTaskTools.clear(); terminalTaskTools.clear();
          },
          afterRound: async () => {
            await flushText();
            if (hooks) {
              hooks.beginRound({ round, inferenceId, hasToolCalls: hadToolCalls,
                finalSummary: boundary !== null && round === boundary.limit });
              await observe(() => hooks.afterRound());
            }
          },
          ...(hooks ? {
            beforeFinish() {
              try { return hooks.beforeFinish(); }
              catch (error) {
                if (error instanceof OriginalNativeTaskSemanticError) semanticFailure = error;
                throw error;
              }
            },
            afterTools() {
              if (!proposedTaskTools.size || terminalTaskTools.size !== proposedTaskTools.size || pendingAfterTools) return false;
              pendingAfterTools = observe(async () => {
                await flushText(); await hooks.afterTools();
                if (hooks.stopAfterTools()) return fail("TASK_CONTEXT_ORDER");
              });
              void pendingAfterTools.catch(error => { afterToolsFailure = error; });
              return false;
            },
          } : {}),
          beforeWork: flushText,
          onTool(event) {
            if (event.reused) return fail("UNBOUND_TOOL_REUSE");
            if (event.status === "running") activeTool = { id: event.id, name: event.name, arguments: event.arguments };
            if (hooks && (event.status === "complete" || event.status === "failed")) terminalTaskTools.add(event.id);
          },
          onHardToolRoundLimit(receipt) { boundary = { ...receipt, reached: true }; },
          onUsage(usage: ModelProviderUsage) {
            if (pendingUsage) return fail("USAGE_BACKPRESSURE");
            totalOutputTokens += Math.max(0, usage.outputTokens - currentOutputTokens);
            currentOutputTokens = Math.max(currentOutputTokens, usage.outputTokens);
            if (totalOutputTokens > plan.budget.maxTotalOutputTokens) usageFailure = new Error("NATIVE_CHAT_TOTAL_OUTPUT_BUDGET");
            pendingUsage = Promise.resolve().then(() => ports.usage({ inferenceId, usage, source: "provider-reported" }));
            void pendingUsage.catch(error => { usageFailure = error; operation.cancel("usage-sink", error); });
          },
        }, text => {
          if (pendingText) return fail("TEXT_BACKPRESSURE");
          pendingText = Promise.resolve().then(() => ports.text({ inferenceId, text }));
          void pendingText.catch(error => { textFailure = error; operation.cancel("text-sink", error); });
        }, vscode);
        await flushAfterTools();
        await flushText();
        if (hooks) await observe(() => hooks.settled());
        return { status: "complete", toolRoundLimit: boundary };
      } catch (error) {
        const code = error instanceof Error && /^NATIVE_CHAT_[A-Z_]+$/.test(error.message)
          ? error.message : "NATIVE_CHAT_EXECUTION_FAILED";
        const location = error instanceof Error
          ? error.stack?.match(/(?:native-vscode-chat-retained|original-mcp-native-chat)\.c?js:\d+:\d+/)?.[0] : undefined;
        if (semanticFailure && !uncertain && !operation.signal.aborted && !textFailure && !usageFailure) {
          try {
            await flushText();
            console.error(`Native Task policy refused completion (${semanticFailure.reason}); observed I/O settled and recorded effects are preserved.`);
            return { status: "failed", toolRoundLimit: boundary };
          } catch (failure) {
            console.error("Native Task terminal sinks did not settle after policy refusal:", failure);
            uncertain = true;
          }
        }
        console.error(`Native Chat execution failed (${code}, ${location ?? "unknown native location"}); dispatch ${dispatched ? "uncertain" : "not-sent"}.`);
        return { status: uncertain || dispatched ? "unknown"
          : operation.signal.aborted ? "cancelled" : "failed", toolRoundLimit: boundary };
      } finally {
        operation.dispose();
        // A rejecting sink was already observed; never build a chain of unbounded writes.
        if (pendingText) void pendingText.catch(() => {});
        if (pendingUsage) void pendingUsage.catch(() => {});
        if (pendingAfterTools) void pendingAfterTools.catch(() => {});
      }
  };
  const execution: LocalExecution = {
    run: runExecution,
    managedTask: {
      run(plan, ports, signal, admit) {
        if (!("managedTask" in plan) || !ports.taskContext) return fail("TASK_CONTEXT_REQUIRED");
        return runExecution(plan, ports, signal, admit);
      },
    },
  };
  return { models, execution, dispose };
}

export function createOriginalMcpNativeChatProducer(context: vscode.ExtensionContext,
  diagnostics: Pick<vscode.OutputChannel, "appendLine">, sdkControl?: OriginalSdkHostControl): Promise<Producer> {
  if (sdkControl && producers.has(context) && sdkControls.get(context) !== sdkControl) return Promise.reject(new Error("NATIVE_SDK_PROVIDER_BINDING_CHANGED"));
  let producer = producers.get(context);
  if (!producer) {
    if (sdkControl) sdkControls.set(context, sdkControl);
    producer = createProducer(context, diagnostics).then(value => {
      if (!sdkControl) return value;
      try {
        const retained = retainedRuntime(context);
        if (typeof retained.streamCopilotSdkChat !== "function" || typeof retained.copilotSdkPrompt !== "function"
          || typeof retained.copilotSdkModels !== "function") {
          try { diagnostics.appendLine("NATIVE_SDK_RUNTIME_INCOMPATIBLE: the verified retained SDK exports are unavailable."); } catch {}
          return { ...value, sdkUnavailable: { provider: "copilot-sdk", status: "unsupported",
            reason: { code: "NATIVE_SDK_RUNTIME_INCOMPATIBLE", message: "Verified retained SDK exports are unavailable." } } } satisfies Producer;
        }
        return { ...value, sdk: createOriginalSdkChatPort({ ...sdkControl, retained: {
          streamCopilotSdkChat: retained.streamCopilotSdkChat,
          copilotSdkPrompt: retained.copilotSdkPrompt, copilotSdkModels: retained.copilotSdkModels,
        } }) };
      }
      catch (error) {
        if (error instanceof Error && "code" in error && (error.code === "NATIVE_SDK_RUNTIME_INCOMPATIBLE"
          || error.code === "NATIVE_SDK_CATALOGUE_CONTROL_EGRESS_UNSUPPORTED")) {
          try { diagnostics.appendLine("NATIVE_SDK_RUNTIME_INCOMPATIBLE: SDK not admitted; the genuine native LM provider is unchanged."); } catch {}
          return { ...value, sdkUnavailable: { provider: "copilot-sdk", status: "unsupported",
            reason: sdkControl.unavailableReason ?? {
              code: "NATIVE_SDK_RUNTIME_INCOMPATIBLE", message: "The selected Host SDK runtime is not admitted.",
            } } } satisfies Producer;
        }
        value.dispose(); throw error;
      }
    })
      .catch(error => { producers.delete(context); sdkControls.delete(context); throw error; });
    producers.set(context, producer);
  }
  return producer;
}
