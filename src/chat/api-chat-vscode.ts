import * as vscode from "vscode";
import { createHash } from "crypto";
import { ChatInferenceClock } from "./chat-inference-timing";
import { ApiChatMessage, ApiChatRequest, ApiChatToolEvent, ChatImage, decodeChatImage, ChatToolLoopGuard, toolBudgetSummary, chatInferenceOutputByteLimit, chatTransportReceipt } from "./api-chat-client";
import { ChatModelProfile, ChatTokenUsage, checkReportedOutput, reportedReasoningTokens, reportedCopilotUsage } from "./api-chat-models";
import { abortable } from "./api-chat-tools";

export interface VscodeChatModel extends vscode.LanguageModelChat {
  maxOutputTokens?: number;
  capabilities?: { toolCalling?: boolean | number; imageInput?: boolean };
}

class VscodeChatError extends Error {}

export function isVscodeModelAccessError(error: unknown): error is Error & { code: string } {
  return error instanceof Error && "code" in error && typeof error.code === "string" && ["NoPermissions", "NotFound"].includes(error.code);
}

export function assertVscodeModelCallable(vendor: string): void {
  if (vendor === "copilotcli") throw new VscodeChatError("Copilot CLI models are catalog-only in the current provider, not callable through the VS Code Language Model API. Choose a request-capable VS Code model or configure an API provider; PKM does not invoke Copilot Agent Host.");
}

export function vscodeModelProfile(model: VscodeChatModel): ChatModelProfile {
  if (!Number.isSafeInteger(model.maxInputTokens) || model.maxInputTokens < 256) throw new VscodeChatError("This model does not report a usable input limit.");
  return {
    id: `vscode:${encodeURIComponent(model.vendor)}:${encodeURIComponent(model.id)}`, model: model.id,
    label: `${model.name} · ${model.vendor}`, status: "active", contextWindow: model.maxInputTokens,
    maxOutputTokens: Math.min(Number.isSafeInteger(model.maxOutputTokens) && model.maxOutputTokens! > 0 ? model.maxOutputTokens! : 4096, Math.floor(model.maxInputTokens / 4)),
    currency: "", includeUsage: false, outputTokenParameter: "max_tokens",
    imageInput: model.capabilities?.imageInput === true,
  };
}

export async function discoverVscodeModels(host = vscode, signal?: AbortSignal): Promise<VscodeChatModel[]> {
  if (!host.lm?.selectChatModels) throw new Error("This VS Code version does not provide the Language Model API. Use an API provider instead.");
  try {
    if (signal?.aborted) throw new Error("Request cancelled.");
    const pending = host.lm.selectChatModels();
    const models = (signal ? await abortable(pending, signal) : await pending).filter(model => model.vendor !== "copilotcli");
    if (!models.length) throw new Error("No VS Code models callable through the Language Model API are available. Copilot CLI catalog-only entries are excluded. Sign in to a request-capable provider or configure an API connection.");
    return models;
  } catch (error) {
    if (signal?.aborted) throw new Error("Request cancelled.");
    if (error instanceof Error && error.message.startsWith("No VS Code models")) throw error;
    throw new Error("Cannot access VS Code models. Check sign-in, extension permission and your organization policy.");
  }
}

type VscodeChatRequest = Pick<ApiChatRequest, "messages" | "purpose" | "signal" | "timeoutMs" | "maxOutputTokens" | "thinkingBudget" | "maxToolRounds" | "loopReviewAfterMs" | "loopReviewClock" | "loopExemptTools" | "onToolLoopNotice" | "contextWindow" | "onImage" | "tools" | "onTool" | "beforeRound" | "beforeFinish" | "automaticKnowledge" | "onTransportPrepared" | "onTransportSent" | "afterTools" | "onStage" | "onModelActivity" | "onUsage" | "onUsageMetadata" | "onInferenceTiming" | "onOutputBudgetWarning">;
type NativePart = { value?: string; callId?: string; name?: string; input?: unknown; data?: Uint8Array; mimeType?: string };

export async function streamVscodeChat(model: VscodeChatModel, request: VscodeChatRequest,
  onText: (text: string) => void, host = vscode): Promise<void> {
  const controller = new AbortController();
  const { signal } = request;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let timedOut = false;
  const inferenceClock = new ChatInferenceClock("vscode", request.onInferenceTiming);
  let unreportedUsage: ChatTokenUsage | undefined;
  const loop = new ChatToolLoopGuard(request);
  const cancellation = new host.CancellationTokenSource();
  const native = host as typeof host & {
    LanguageModelTextPart?: new (value: string) => NativePart;
    LanguageModelToolCallPart?: new (id: string, name: string, input: unknown) => NativePart;
    LanguageModelToolResultPart?: new (id: string, content: NativePart[]) => NativePart;
    LanguageModelDataPart?: new (data: Uint8Array, mimeType: string) => NativePart;
  };
  const cancel = () => { controller.abort(); cancellation.cancel(); };
  const activity = () => {
    if (controller.signal.aborted) return;
    inferenceClock.activity();
    clearTimeout(timer);
    timer = setTimeout(() => { timedOut = true; cancel(); }, request.timeoutMs ?? 1_800_000);
  };
  signal.addEventListener("abort", cancel, { once: true });
  if (signal.aborted) cancel();
  try {
    if (signal.aborted) throw new VscodeChatError("Request cancelled.");
    assertVscodeModelCallable(model.vendor);
    const toolCalling = model.capabilities?.toolCalling;
    if (request.tools?.length && (toolCalling !== undefined && !(toolCalling === true || typeof toolCalling === "number" && Number.isSafeInteger(toolCalling) && toolCalling >= request.tools.length) || !native.LanguageModelTextPart || !native.LanguageModelToolCallPart || !native.LanguageModelToolResultPart)) {
      throw new VscodeChatError("This VS Code model or host does not expose tool calling. Disable tools or select a tool-capable model.");
    }
    const messages = [...request.messages];
    const callIds = new Set<string>();
    const hasOutputTokenizer = typeof model.countTokens === "function";
    const countTokens = async (value: vscode.LanguageModelChatMessage | string): Promise<number> => {
      request.onModelActivity?.({ operation:"token-count", label:"Counting output tokens with VS Code model", status:"running" });
      try {
        const count = await abortable(model.countTokens(value, cancellation.token), controller.signal);
        if (!Number.isSafeInteger(count) || count < 0) throw new VscodeChatError("Output token count is unavailable. Partial output was preserved; no pending tool was executed.");
        request.onModelActivity?.({ operation:"token-count", label:"Counting output tokens with VS Code model", status:"complete" });
        return count;
      } catch (error) {
        request.onModelActivity?.({ operation:"token-count", label:"Counting output tokens with VS Code model", status:"failed" });
        throw error;
      }
    };
    const inputTokenCounts = new Map<string, number>();
    const countInput = async (value: vscode.LanguageModelChatMessage | string): Promise<number> => {
      const key = createHash("sha256").update(JSON.stringify(value)).digest("hex");
      const cached = inputTokenCounts.get(key);
      if (cached !== undefined) return cached;
      const count = await abortable(model.countTokens(value, cancellation.token), controller.signal);
      if (!Number.isSafeInteger(count) || count < 0) throw new VscodeChatError("Input token count is unavailable.");
      if (inputTokenCounts.size >= 256) inputTokenCounts.delete(inputTokenCounts.keys().next().value!);
      inputTokenCounts.set(key, count);
      return count;
    };
    if (!hasOutputTokenizer) request.onOutputBudgetWarning?.("Output token counting is unavailable. The per-inference token limit can only be checked from valid provider usage; the separate 100,000-byte inference output limit remains active. Bytes are not tokens.");
    let imagesReturned = 0;
    let metadataParts = 0;
    for (let round = 0; ; round++) {
      await loop.beforeRound(round, signal);
      if (loop.summarizing) messages.push({ role: "system", content: toolBudgetSummary });
      const hasImages = messages.some(message => message.images?.length);
      if (hasImages && (model.capabilities?.imageInput !== true || !native.LanguageModelDataPart || !native.LanguageModelTextPart || typeof model.countTokens !== "function")) throw new VscodeChatError("This model/host does not expose image input and image token counting. Select a vision-capable VS Code model.");
      const remaining = request.maxOutputTokens ?? vscodeModelProfile(model).maxOutputTokens;
      if (!Number.isSafeInteger(remaining) || remaining < 1) throw new VscodeChatError("Choose a positive per-inference output token budget.");
      let outputText = "";
      let nextTokenCheck = remaining;
      const checkOutputBudget = async (text: string, force = false) => {
        const bytes = Buffer.byteLength(text, "utf8");
        if (bytes > chatInferenceOutputByteLimit) throw new VscodeChatError("Inference output exceeded the 100,000-byte local size limit. Partial output was preserved; no pending tool was executed.");
        if (!hasOutputTokenizer) return;
        if (!force && bytes < nextTokenCheck) return;
        const tokens = await countTokens(text);
        if (tokens > remaining) throw new VscodeChatError("Local output budget exhausted. Partial output was preserved; provider usage may be higher.");
        nextTokenCheck = bytes + Math.max(1, remaining - tokens);
      };
      try { request.beforeRound?.(messages, remaining); }
      catch (error) { throw new VscodeChatError(error instanceof Error ? error.message : "Context budget exceeded."); }
      activity();
      const prompt = messages.map(message => {
        const content = message.role === "system" ? `[PKM instructions and reference context]\n${message.content}` : message.content;
        const entry = message.role === "assistant" ? host.LanguageModelChatMessage.Assistant(content) : host.LanguageModelChatMessage.User(content);
        if (native.LanguageModelTextPart) {
          const parts: NativePart[] = [new native.LanguageModelTextPart(content)];
          for (const image of message.images || []) parts.push(new native.LanguageModelDataPart!(decodeChatImage(image), image.mimeType));
          if (message.role === "tool") parts.splice(0, 1, new native.LanguageModelToolResultPart!(message.tool_call_id!, [...parts]));
          else for (const call of message.tool_calls || []) parts.push(new native.LanguageModelToolCallPart!(call.id, call.function.name, JSON.parse(call.function.arguments)));
          Object.assign(entry, { content: parts });
        }
        return entry;
      });
      const options: vscode.LanguageModelChatRequestOptions & { tools?: Array<{ name: string; description: string; inputSchema: Record<string, unknown> }> } = {
        justification: "Allow PKM native Chat to use the selected model with your selected context.",
        ...(request.tools?.length && !loop.summarizing ? { tools: request.tools.map(tool => ({ name: tool.name, description: tool.description, inputSchema: tool.parameters })) } : {}),
      };
      let tokens: number | undefined;
      let knowledgeTokens = 32;
      if (hasOutputTokenizer) {
        request.onModelActivity?.({ operation:"token-count", label:"Counting input tokens with VS Code model", status:"running" });
        try {
          tokens = 32;
          for (const [index, entry] of prompt.entries()) {
            const count = await countInput(entry);
            tokens += count + 32;
            if (request.automaticKnowledge?.includes(messages[index])) knowledgeTokens += count + 32;
          }
          if (options.tools?.length) {
            const count = await countInput(JSON.stringify(options.tools));
            tokens += count + 32;
          }
          request.onModelActivity?.({ operation:"token-count", label:"Counting input tokens with VS Code model", status:"complete" });
        } catch (error) {
          request.onModelActivity?.({ operation:"token-count", label:"Counting input tokens with VS Code model", status:"failed" });
          throw error;
        }
      }
      const transport = chatTransportReceipt("vscode", prompt, options.tools || [], tokens);
      if (request.automaticKnowledge) {
        const knowledgeBudget = request.automaticKnowledge;
        if (!hasOutputTokenizer) knowledgeTokens = messages.reduce((sum, message, index) =>
          knowledgeBudget.includes(message) ? sum + Buffer.byteLength(JSON.stringify(prompt[index]), "utf8") + 32 : sum, 32);
        if (!Number.isSafeInteger(knowledgeBudget.inputBudget) || knowledgeBudget.inputBudget < 32
          || knowledgeTokens > knowledgeBudget.inputBudget) throw new VscodeChatError("Automatic PKM reference input budget exceeded; no model request was sent.");
        transport.automaticKnowledge = { inputBudget:knowledgeBudget.inputBudget, inputTokens:knowledgeTokens,
          countingMethod:hasOutputTokenizer ? "vscode-countTokens-plus-overhead" : "utf8-byte-upper-bound" };
      }
      const inputBudget = request.contextWindow === undefined ? model.maxInputTokens : Math.min(request.contextWindow, model.maxInputTokens) - remaining;
      if (!Number.isSafeInteger(inputBudget) || transport.inputTokens > inputBudget) throw new VscodeChatError(`${hasImages ? "Image context" : "Native context"} budget exceeded. Remove optional context or increase Context.`);
      try { request.onTransportPrepared?.(transport); }
      catch (error) { throw new VscodeChatError(error instanceof Error ? error.message : "Transport receipt persistence failed."); }
      request.onStage?.("connecting");
      inferenceClock.start();
      const response = await abortable(model.sendRequest(prompt, options, cancellation.token), controller.signal);
      activity();
      request.onTransportSent?.(transport);
      request.onStage?.("waiting");
      const structured = (response as typeof response & { stream?: AsyncIterable<NativePart> }).stream;
      const iterator: AsyncIterator<NativePart | string> = (structured || response.text)[Symbol.asyncIterator]();
      const calls: NonNullable<ApiChatMessage["tool_calls"]> = [];
      let responseText = "";
      const responseImages: ChatImage[] = [];
      let usage: ChatTokenUsage | undefined;
      while (true) {
        const next = await abortable(iterator.next(), controller.signal);
        if (next.done) break;
        activity();
        const part = next.value;
        if (typeof part === "string" || (native.LanguageModelTextPart && part instanceof native.LanguageModelTextPart)) {
          const text = typeof part === "string" ? part : part.value || "";
          if (text) inferenceClock.publicOutput();
          const nextOutput = outputText + text;
          await checkOutputBudget(nextOutput);
          outputText = nextOutput;
          responseText += text; if (text) onText(text);
        } else if (native.LanguageModelToolCallPart && part instanceof native.LanguageModelToolCallPart) {
          inferenceClock.publicOutput();
          if (!part.callId || !part.name || part.callId.length > 200 || part.name.length > 200 || callIds.has(part.callId) || calls.length >= 16) throw new VscodeChatError("Invalid or duplicate tool call. No pending tool was executed.");
          const arguments_ = JSON.stringify(part.input);
          if (!arguments_ || arguments_.length > 32_000 || !part.input || typeof part.input !== "object" || Array.isArray(part.input)) throw new VscodeChatError("Invalid tool arguments. No pending tool was executed.");
          outputText += JSON.stringify({ id: part.callId, name: part.name, arguments: arguments_ });
          await checkOutputBudget(outputText, true);
          callIds.add(part.callId); calls.push({ id: part.callId, type: "function", function: { name: part.name, arguments: arguments_ } });
        } else if (native.LanguageModelDataPart && part instanceof native.LanguageModelDataPart) {
          if (["usage", "stateful_marker", "thinking", "context_management", "phase_data", "cache_control"].includes(part.mimeType || "")) {
            if (!(part.data instanceof Uint8Array) || part.data.byteLength > 64 * 1024 || ++metadataParts > 128) throw new VscodeChatError("Provider metadata exceeded the local limit; partial output was preserved.");
            if (part.mimeType === "usage") {
              let valid = false;
              let reported;
              try {
                reported = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(part.data));
              } catch {}
              let billing: ReturnType<typeof reportedCopilotUsage>;
              try { billing = reportedCopilotUsage(reported); }
              catch (error) { request.onUsageMetadata?.(false); throw new VscodeChatError((error as Error).message); }
              if (reported && !Array.isArray(reported) && [reported.prompt_tokens, reported.completion_tokens].every(value => Number.isSafeInteger(value) && value >= 0)) {
                const cached = reported.prompt_tokens_details?.cached_tokens;
                usage = { inputTokens: reported.prompt_tokens, outputTokens: reported.completion_tokens,
                  ...(Number.isSafeInteger(cached) && cached >= 0 && cached <= reported.prompt_tokens ? { cachedInputTokens: cached } : {}),
                  ...reportedReasoningTokens(reported), ...billing };
                unreportedUsage = usage;
                valid = true;
              }
              request.onUsageMetadata?.(valid);
            }
            continue;
          }
          if (!part.mimeType?.startsWith("image/")) throw new VscodeChatError("Unsupported model data response; partial output was preserved.");
          if (!(part.data instanceof Uint8Array) || part.data.byteLength > 512 * 1024 || !["image/png", "image/jpeg"].includes(part.mimeType || "") || ++imagesReturned > 2 || !request.onImage) throw new VscodeChatError("Unsupported or oversized image response; partial output was preserved.");
          const image: ChatImage = { label: `Model image ${imagesReturned}`, mimeType: part.mimeType as ChatImage["mimeType"], dataBase64: Buffer.from(part.data).toString("base64") };
          try { decodeChatImage(image); } catch { throw new VscodeChatError("Invalid PNG/JPEG image response; partial output was preserved."); }
          responseImages.push(image); request.onImage(image);
          inferenceClock.publicOutput();
        } else throw new VscodeChatError("The model returned an unsupported response part.");
      }
      if (outputText) await checkOutputBudget(outputText, true);
      clearTimeout(timer);
      inferenceClock.finish("stream-ended");
      if (usage) { unreportedUsage = undefined; request.onUsage?.(usage); }
      if (usage) {
        try { checkReportedOutput(usage, remaining, request.thinkingBudget); }
        catch (error) { throw new VscodeChatError((error as Error).message); }
      }
      if (!calls.length) {
        if (!responseText && !responseImages.length) throw new VscodeChatError("The model returned an empty response.");
        const continuation = !loop.summarizing && request.beforeFinish?.();
        if (continuation) {
          messages.push({ role: "assistant", content: responseText }, { role: "system", content: continuation });
          continue;
        }
        return;
      }
      if (!request.tools?.length) throw new VscodeChatError("Tool execution is not enabled. No pending tool was executed.");
      if (loop.summarizing) throw new VscodeChatError("The model requested more tools during the final summary. Completed results were preserved; no additional tool was executed.");
      messages.push({ role: "assistant", content: responseText, tool_calls: calls, ...(responseImages.length ? { images: responseImages } : {}) });
      for (const call of calls) {
        await loop.beforeRound(round, signal);
        if (signal.aborted) throw new VscodeChatError("Request cancelled.");
        const tool = request.tools.find(item => item.name === call.function.name);
        const event: ApiChatToolEvent = { id: call.id, name: tool?.label || call.function.name, arguments: call.function.arguments, status: "running" };
        if (loop.summarizing) {
          const result = JSON.stringify({ error: "Not executed: tool-loop continuation was not approved; use completed results." });
          request.onTool?.({ ...event, status: "failed", result });
          messages.push({ role: "tool", content: result, tool_call_id: call.id });
          continue;
        }
        request.onTool?.(event);
        let result: string;
        try {
          if (!tool) throw new Error("This tool is not enabled for the request.");
          result = await abortable(Promise.resolve().then(() => {
            if (signal.aborted) throw new Error("Request cancelled.");
            return tool.execute(JSON.parse(call.function.arguments), signal);
          }), signal);
          if (typeof result !== "string" || result.length > 16_000) throw new Error("Tool result exceeded the local limit.");
          request.onTool?.({ ...event, status: "complete", result });
        } catch (error) {
          if (signal.aborted) throw new VscodeChatError("Request cancelled.");
          result = JSON.stringify({ error: error instanceof Error ? error.message : "Tool failed." });
          request.onTool?.({ ...event, status: "failed", result });
        }
        loop.record(tool, call.function.name, call.function.arguments, result);
        messages.push({ role: "tool", content: result, tool_call_id: call.id });
      }
      if (request.afterTools?.()) return;
    }
  } catch (error) {
    if (timedOut) throw new VscodeChatError("The VS Code model call timed out due to inactivity. Partial output was preserved; no automatic retry was performed.");
    if (signal.aborted) throw new Error("Request cancelled.");
    if (isVscodeModelAccessError(error)) {
      const failure = new Error("VS Code model access was denied or the selected model is unavailable. No automatic retry was performed.");
      Object.assign(failure, { code: error.code });
      throw failure;
    }
    if (error instanceof VscodeChatError) throw error;
    throw new Error("VS Code model request failed. Check extension permission, model availability and account quota. Partial output was preserved.");
  } finally {
    clearTimeout(timer);
    signal.removeEventListener("abort", cancel);
    cancellation.cancel(); cancellation.dispose();
    inferenceClock.finish("interrupted");
    if (unreportedUsage) request.onUsage?.(unreportedUsage);
  }
}