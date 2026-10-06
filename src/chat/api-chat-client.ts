import OpenAI from "openai";
import { imageSize } from "image-size";

export interface ChatImage { label: string; mimeType: "image/png" | "image/jpeg"; dataBase64: string; }

export function decodeChatImage(image: ChatImage): Buffer {
  if (!image || typeof image.label !== "string" || !image.label || image.label.length > 120 || /[\u0000-\u001f\u007f]/.test(image.label) || !["image/png", "image/jpeg"].includes(image.mimeType) || typeof image.dataBase64 !== "string" || image.dataBase64.length > 700_000) throw new Error("Choose a bounded PNG/JPEG image.");
  const bytes = Buffer.from(image.dataBase64, "base64");
  if (!bytes.length || bytes.length > 512 * 1024 || bytes.toString("base64") !== image.dataBase64) throw new Error("Image must be valid Base64 and at most 512 KB.");
  let dimensions: ReturnType<typeof imageSize>;
  try { dimensions = imageSize(bytes); } catch { throw new Error("Invalid image data."); }
  if ((dimensions.type === "png" ? "image/png" : dimensions.type === "jpg" ? "image/jpeg" : "") !== image.mimeType || !dimensions.width || !dimensions.height || dimensions.width > 4096 || dimensions.height > 4096 || dimensions.width * dimensions.height > 16_000_000) throw new Error("Choose a PNG/JPEG image no larger than 4096 pixels per side and 16 megapixels.");
  return bytes;
}

export interface ApiChatMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string;
  images?: ChatImage[];
  tool_call_id?: string;
  tool_calls?: Array<{ id: string; type: "function"; function: { name: string; arguments: string } }>;
}

export interface ApiChatTool {
  name: string;
  label?: string;
  description: string;
  parameters: Record<string, unknown>;
  execute: (arguments_: Record<string, unknown>, signal: AbortSignal) => Promise<string>;
}
export interface ApiChatToolEvent { id: string; name: string; arguments: string; status: "running" | "complete" | "failed"; result?: string; }

export interface ApiChatRequest {
  provider: "openai-compatible" | "azure-openai";
  endpoint: string;
  apiKey: string;
  model: string;
  apiVersion?: string;
  messages: ApiChatMessage[];
  signal: AbortSignal;
  timeoutMs?: number;
  maxOutputTokens?: number;
  contextWindow?: number;
  onImage?: (image: ChatImage) => void;
  outputTokenParameter?: "max_tokens" | "max_completion_tokens";
  includeUsage?: boolean;
  onUsage?: (usage: { inputTokens: number; outputTokens: number; cachedInputTokens?: number }) => void;
  onUsageMetadata?: (valid: boolean) => void;
  onStage?: (stage: "connecting" | "waiting") => void;
  fetch?: typeof fetch;
  tools?: ApiChatTool[];
  onTool?: (event: ApiChatToolEvent) => void;
  beforeRound?: (messages: ApiChatMessage[], outputTokens: number) => void;
}

export async function streamApiChat(request: ApiChatRequest, onText: (text: string) => void): Promise<void> {
  if (request.messages.some(message => message.images?.length)) throw new Error("Image messages require a vision-capable VS Code model. Direct HTTP image transport is not supported yet.");
  const endpoint = new URL(request.endpoint);
  if (endpoint.username || endpoint.password || endpoint.search || endpoint.hash) {
    throw new Error("Use a base endpoint without credentials, query parameters or fragments.");
  }
  const local = ["localhost", "127.0.0.1", "[::1]"].includes(endpoint.hostname);
  if (endpoint.protocol !== "https:" && !(endpoint.protocol === "http:" && local)) {
    throw new Error("The endpoint must use HTTPS, except for a local HTTP model server.");
  }
  if (!request.model.trim()) throw new Error("Choose a model or Azure deployment.");
  if (!request.apiKey && !local) throw new Error("Set an API key before sending.");
  const controller = new AbortController();
  const cancel = () => controller.abort();
  request.signal.addEventListener("abort", cancel, { once: true });
  if (request.signal.aborted) cancel();
  let timedOut = false;
  const timer = setTimeout(() => { timedOut = true; controller.abort(); }, request.timeoutMs ?? 120_000);
  const baseURL = request.endpoint.replace(/\/+$/, "");
  const azure = request.provider === "azure-openai";
  const client = new OpenAI({
    apiKey: request.apiKey || "local",
    baseURL: azure ? `${baseURL}/openai/deployments/${encodeURIComponent(request.model)}` : baseURL,
    defaultHeaders: azure ? { "api-key": request.apiKey } : undefined,
    defaultQuery: azure ? { "api-version": request.apiVersion || "2024-06-01" } : undefined,
    maxRetries: 0,
    fetch: request.fetch,
  });
  try {
    if (controller.signal.aborted) throw new Error("Cancelled");
    const messages = [...request.messages];
    let characters = 0;
    let outputUsed = 0;
    for (let round = 0; round < 8; round++) {
    if (controller.signal.aborted) throw new Error("Request cancelled.");
    const outputTokens = request.maxOutputTokens === undefined ? undefined : request.maxOutputTokens - outputUsed;
    if (outputTokens !== undefined && outputTokens < 1) throw new Error("Request output budget exhausted.");
    request.beforeRound?.(messages, outputTokens || 0);
    request.onStage?.("connecting");
    const stream = await client.chat.completions.create({
      model: request.model,
      messages: messages.map(message => {
        if (message.role === "tool") return { role: "tool" as const, content: message.content, tool_call_id: message.tool_call_id! };
        if (message.role === "assistant") return { role: "assistant" as const, content: message.content, tool_calls: message.tool_calls };
        return { role: message.role, content: message.content };
      }),
      stream: true,
      ...(outputTokens ? { [request.outputTokenParameter || "max_completion_tokens"]: outputTokens } : {}),
      ...(request.includeUsage ? { stream_options: { include_usage: true } } : {}),
      ...(request.tools?.length ? { tools: request.tools.map(tool => ({ type: "function" as const, function: { name: tool.name, description: tool.description, parameters: tool.parameters } })) } : {}),
    }, { signal: controller.signal });
    request.onStage?.("waiting");
    let finishReason = "";
    let responseText = "";
    let measuredOutput: number | undefined;
    const calls = new Map<number, { id: string; type: "function"; function: { name: string; arguments: string } }>();
    for await (const chunk of stream) {
      if (chunk.usage) {
        measuredOutput = chunk.usage.completion_tokens;
        request.onUsage?.({ inputTokens: chunk.usage.prompt_tokens, outputTokens: chunk.usage.completion_tokens, cachedInputTokens: chunk.usage.prompt_tokens_details?.cached_tokens });
      }
      const choice = chunk.choices[0];
      const text = choice?.delta.content || choice?.delta.refusal || "";
      responseText += text;
      characters += text.length;
      if (characters > 100_000) {
        controller.abort();
        throw new Error("Response exceeded the local size limit.");
      }
      if (text) onText(text);
      for (const fragment of choice?.delta.tool_calls || []) {
        if (!calls.has(fragment.index)) calls.set(fragment.index, { id: "", type: "function", function: { name: "", arguments: "" } });
        const call = calls.get(fragment.index)!;
        call.id += fragment.id || ""; call.function.name += fragment.function?.name || ""; call.function.arguments += fragment.function?.arguments || "";
        if (calls.size > 16 || call.function.arguments.length > 32_000) throw new Error("Tool call exceeded the local limit.");
      }
      if (choice?.finish_reason) finishReason = choice.finish_reason;
    }
    if (!finishReason) throw new Error("The response ended before completion.");
    const toolCalls = [...calls.values()];
    outputUsed += measuredOutput ?? Buffer.byteLength(responseText + JSON.stringify(toolCalls), "utf8");
    if (finishReason === "stop") {
      if (calls.size) throw new Error("Invalid tool completion. No pending tool was executed.");
      if (!characters) throw new Error("The model returned an empty response.");
      return;
    }
    if (finishReason !== "tool_calls" || !toolCalls.length) throw new Error(`Response stopped with ${finishReason}. Partial output was preserved.`);
    if (!request.tools?.length) throw new Error("Tool execution is not enabled.");
    messages.push({ role: "assistant", content: responseText, tool_calls: toolCalls });
    for (const call of toolCalls) {
      if (!call.id || !call.function.name) throw new Error("Invalid tool call.");
      if (controller.signal.aborted) throw new Error("Request cancelled.");
      const event: ApiChatToolEvent = { id: call.id, name: request.tools.find(tool => tool.name === call.function.name)?.label || call.function.name, arguments: call.function.arguments, status: "running" };
      request.onTool?.(event);
      let result: string;
      try {
        const tool = request.tools.find(item => item.name === call.function.name);
        if (!tool) throw new Error("This tool is not enabled for the request.");
        const arguments_ = JSON.parse(call.function.arguments);
        if (!arguments_ || typeof arguments_ !== "object" || Array.isArray(arguments_)) throw new Error("Tool arguments must be an object.");
        result = await new Promise<string>((resolve, reject) => {
          const cancelTool = () => reject(new Error("Request cancelled."));
          controller.signal.addEventListener("abort", cancelTool, { once: true });
          Promise.resolve().then(() => {
            if (controller.signal.aborted) throw new Error("Request cancelled.");
            return tool.execute(arguments_, controller.signal);
          }).then(resolve, reject).finally(() => controller.signal.removeEventListener("abort", cancelTool));
          if (controller.signal.aborted) cancelTool();
        });
        if (typeof result !== "string" || result.length > 16_000) throw new Error("Tool result exceeded the local limit.");
        request.onTool?.({ ...event, status: "complete", result });
      } catch (error) {
        if (controller.signal.aborted) throw new Error("Request cancelled.");
        result = JSON.stringify({ error: error instanceof Error ? error.message : "Tool failed." });
        request.onTool?.({ ...event, status: "failed", result });
      }
      messages.push({ role: "tool", content: result, tool_call_id: call.id });
    }
    }
    throw new Error("Tool round limit reached. Send another request to continue.");
  } catch (error) {
    if (timedOut) throw new Error("The API request timed out. You can retry or choose another model.");
    if (request.signal.aborted) throw new Error("Request cancelled.");
    if (error instanceof OpenAI.APIConnectionError) throw new Error("Cannot connect to the model API.");
    if (error instanceof OpenAI.APIError) {
      throw new Error(`Model API returned HTTP ${error.status ?? "error"}. Check the endpoint, model and credentials.`);
    }
    throw error;
  } finally {
    controller.abort();
    clearTimeout(timer);
    request.signal.removeEventListener("abort", cancel);
  }
}