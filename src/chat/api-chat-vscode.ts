import * as vscode from "vscode";
import { ApiChatMessage, ApiChatRequest, ApiChatToolEvent, ChatImage, decodeChatImage } from "./api-chat-client";
import { ChatModelProfile } from "./api-chat-models";
import { abortable } from "./api-chat-tools";

export interface VscodeChatModel extends vscode.LanguageModelChat {
  maxOutputTokens?: number;
  capabilities?: { toolCalling?: boolean | number; imageInput?: boolean };
}

class VscodeChatError extends Error {}

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

type VscodeChatRequest = Pick<ApiChatRequest, "messages" | "signal" | "maxOutputTokens" | "contextWindow" | "onImage" | "tools" | "onTool" | "beforeRound" | "onStage" | "onUsage" | "onUsageMetadata">;
type NativePart = { value?: string; callId?: string; name?: string; input?: unknown; data?: Uint8Array; mimeType?: string };

export async function streamVscodeChat(model: VscodeChatModel, request: VscodeChatRequest,
  onText: (text: string) => void, host = vscode): Promise<void> {
  const { signal } = request;
  const cancellation = new host.CancellationTokenSource();
  const native = host as typeof host & {
    LanguageModelTextPart?: new (value: string) => NativePart;
    LanguageModelToolCallPart?: new (id: string, name: string, input: unknown) => NativePart;
    LanguageModelToolResultPart?: new (id: string, content: NativePart[]) => NativePart;
    LanguageModelDataPart?: new (data: Uint8Array, mimeType: string) => NativePart;
  };
  const cancel = () => cancellation.cancel();
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
    let characters = 0;
    let outputUsed = 0;
    let imagesReturned = 0;
    let metadataParts = 0;
    for (let round = 0; round < 8; round++) {
      const hasImages = messages.some(message => message.images?.length);
      if (hasImages && (model.capabilities?.imageInput !== true || !native.LanguageModelDataPart || !native.LanguageModelTextPart || typeof model.countTokens !== "function")) throw new VscodeChatError("This model/host does not expose image input and image token counting. Select a vision-capable VS Code model.");
      const remaining = (request.maxOutputTokens ?? 1024) - outputUsed;
      if (remaining < 1) throw new VscodeChatError("Local output budget exhausted. Partial output was preserved.");
      try { request.beforeRound?.(messages, remaining); }
      catch (error) { throw new VscodeChatError(error instanceof Error ? error.message : "Context budget exceeded."); }
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
      if (hasImages) {
        let tokens = 32;
        for (const entry of prompt) {
          const count = await abortable(model.countTokens(entry, cancellation.token), signal);
          if (!Number.isSafeInteger(count) || count < 0) throw new VscodeChatError("Image token count is unavailable.");
          tokens += count + 32;
        }
        if (request.tools?.length) {
          const count = await abortable(model.countTokens(JSON.stringify(request.tools.map(({ execute, ...tool }) => tool)), cancellation.token), signal);
          if (!Number.isSafeInteger(count) || count < 0) throw new VscodeChatError("Tool schema token count is unavailable.");
          tokens += count + 32;
        }
        if (!Number.isSafeInteger(request.contextWindow) || tokens + remaining > Math.min(request.contextWindow!, model.maxInputTokens)) throw new VscodeChatError("Image context budget exceeded. Remove images/history or increase Context.");
      }
      request.onStage?.("connecting");
      const options: vscode.LanguageModelChatRequestOptions & { tools?: Array<{ name: string; description: string; inputSchema: Record<string, unknown> }> } = {
        justification: "Allow PKM native Chat to use the selected model with your selected context.",
        ...(request.tools?.length ? { tools: request.tools.map(tool => ({ name: tool.name, description: tool.description, inputSchema: tool.parameters })) } : {}),
      };
      const response = await abortable(model.sendRequest(prompt, options, cancellation.token), signal);
      request.onStage?.("waiting");
      const structured = (response as typeof response & { stream?: AsyncIterable<NativePart> }).stream;
      const iterator: AsyncIterator<NativePart | string> = (structured || response.text)[Symbol.asyncIterator]();
      const calls: NonNullable<ApiChatMessage["tool_calls"]> = [];
      let responseText = "";
      const responseImages: ChatImage[] = [];
      let usage: { inputTokens: number; outputTokens: number; cachedInputTokens?: number } | undefined;
      while (true) {
        const next = await abortable(iterator.next(), signal);
        if (next.done) break;
        const part = next.value;
        if (typeof part === "string" || (native.LanguageModelTextPart && part instanceof native.LanguageModelTextPart)) {
          const text = typeof part === "string" ? part : part.value || "";
          outputUsed += Buffer.byteLength(text, "utf8"); characters += text.length;
          if (outputUsed > (request.maxOutputTokens ?? 1024)) throw new VscodeChatError("Local output budget exhausted. Partial output was preserved; provider usage may be higher.");
          if (characters > 100_000) throw new VscodeChatError("Response exceeded the local size limit.");
          responseText += text; if (text) onText(text);
        } else if (native.LanguageModelToolCallPart && part instanceof native.LanguageModelToolCallPart) {
          if (!part.callId || !part.name || part.callId.length > 200 || part.name.length > 200 || callIds.has(part.callId) || calls.length >= 16) throw new VscodeChatError("Invalid or duplicate tool call. No pending tool was executed.");
          const arguments_ = JSON.stringify(part.input);
          if (!arguments_ || arguments_.length > 32_000 || !part.input || typeof part.input !== "object" || Array.isArray(part.input)) throw new VscodeChatError("Invalid tool arguments. No pending tool was executed.");
          outputUsed += Buffer.byteLength(JSON.stringify({ id: part.callId, name: part.name, arguments: arguments_ }), "utf8");
          if (outputUsed >= (request.maxOutputTokens ?? 1024)) throw new VscodeChatError("Local output budget exhausted. No pending tool was executed.");
          callIds.add(part.callId); calls.push({ id: part.callId, type: "function", function: { name: part.name, arguments: arguments_ } });
        } else if (native.LanguageModelDataPart && part instanceof native.LanguageModelDataPart) {
          if (["usage", "stateful_marker", "thinking", "context_management", "phase_data", "cache_control"].includes(part.mimeType || "")) {
            if (!(part.data instanceof Uint8Array) || part.data.byteLength > 64 * 1024 || ++metadataParts > 128) throw new VscodeChatError("Provider metadata exceeded the local limit; partial output was preserved.");
            if (part.mimeType === "usage") {
              let valid = false;
              try {
                const reported = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(part.data));
                if (reported && !Array.isArray(reported) && [reported.prompt_tokens, reported.completion_tokens].every(value => Number.isSafeInteger(value) && value >= 0)) {
                  const cached = reported.prompt_tokens_details?.cached_tokens;
                  usage = { inputTokens: reported.prompt_tokens, outputTokens: reported.completion_tokens,
                    ...(Number.isSafeInteger(cached) && cached >= 0 && cached <= reported.prompt_tokens ? { cachedInputTokens: cached } : {}) };
                  valid = true;
                }
              } catch {}
              request.onUsageMetadata?.(valid);
            }
            continue;
          }
          if (!part.mimeType?.startsWith("image/")) throw new VscodeChatError("Unsupported model data response; partial output was preserved.");
          if (!(part.data instanceof Uint8Array) || part.data.byteLength > 512 * 1024 || !["image/png", "image/jpeg"].includes(part.mimeType || "") || ++imagesReturned > 2 || !request.onImage) throw new VscodeChatError("Unsupported or oversized image response; partial output was preserved.");
          const image: ChatImage = { label: `Model image ${imagesReturned}`, mimeType: part.mimeType as ChatImage["mimeType"], dataBase64: Buffer.from(part.data).toString("base64") };
          try { decodeChatImage(image); } catch { throw new VscodeChatError("Invalid PNG/JPEG image response; partial output was preserved."); }
          responseImages.push(image); request.onImage(image);
        } else throw new VscodeChatError("The model returned an unsupported response part.");
      }
      if (usage) request.onUsage?.(usage);
      if (!calls.length) {
        if (!characters && !imagesReturned) throw new VscodeChatError("The model returned an empty response.");
        return;
      }
      if (!request.tools?.length) throw new VscodeChatError("Tool execution is not enabled. No pending tool was executed.");
      if (round === 7) throw new VscodeChatError("Tool round limit reached. No pending tool was executed.");
      messages.push({ role: "assistant", content: responseText, tool_calls: calls, ...(responseImages.length ? { images: responseImages } : {}) });
      for (const call of calls) {
        if (signal.aborted) throw new VscodeChatError("Request cancelled.");
        const tool = request.tools.find(item => item.name === call.function.name);
        const event: ApiChatToolEvent = { id: call.id, name: tool?.label || call.function.name, arguments: call.function.arguments, status: "running" };
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
        messages.push({ role: "tool", content: result, tool_call_id: call.id });
      }
    }
  } catch (error) {
    if (signal.aborted) throw new Error("Request cancelled.");
    if (error instanceof VscodeChatError) throw error;
    throw new Error("VS Code model request failed. Check extension permission, model availability and account quota. Partial output was preserved.");
  } finally {
    signal.removeEventListener("abort", cancel);
    cancellation.cancel(); cancellation.dispose();
  }
}