import OpenAI from "openai";
import { imageSize } from "image-size";
import { createHash } from "crypto";

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
export interface ChatToolLoopNotice { reason: "round-limit" | "stalled"; rounds: number; limit: number; tool?: string; repeats?: number; }
export type ChatToolLoopDecision = "continue" | "summarize" | "cancel";

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
  maxToolRounds?: number;
  loopReviewAfterMs?: number;
  loopReviewClock?: () => number;
  loopExemptTools?: string[];
  onToolLoopNotice?: (notice: ChatToolLoopNotice, signal: AbortSignal) => Promise<ChatToolLoopDecision>;
  onTool?: (event: ApiChatToolEvent) => void;
  beforeRound?: (messages: ApiChatMessage[], outputTokens: number) => void;
  afterTools?: () => boolean;
}

export function chatToolRoundLimit(value = 30): number {
  if (!Number.isSafeInteger(value) || value < 1 || value > 1000) throw new Error("Choose a tool round limit of 1-1000.");
  return value;
}

export const toolBudgetSummary = "The tool-call round budget or repeated-call review stopped further tool execution. Give the best answer from completed tool results without calling more tools. Clearly state any unresolved work; do not claim it succeeded.";
export const defaultLoopExemptTools = ["wait", "sleep", "poll", "core.sleep", "mcp_pkm_chat_standby", "mcp_pkm_api_chat_request_get", "mcp_pkm_recipe_run_progress"];

function stableToolValue(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableToolValue).join(",")}]`;
  if (value && typeof value === "object") return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${stableToolValue((value as Record<string, unknown>)[key])}`).join(",")}}`;
  return JSON.stringify(value) ?? "undefined";
}

export class ChatToolLoopGuard {
  private boundary: number;
  private readonly observed = new Map<string, { signature: string; repeats: number }>();
  private stalled?: { tool: string; repeats: number };
  summarizing = false;
  readonly limit: number;
  private reviewStartedAt: number;

  constructor(private readonly request: Pick<ApiChatRequest, "maxToolRounds" | "loopExemptTools" | "onToolLoopNotice" | "loopReviewAfterMs" | "loopReviewClock">, private readonly now: () => number = request.loopReviewClock || Date.now) {
    this.limit = chatToolRoundLimit(request.maxToolRounds);
    this.boundary = this.limit;
    if (request.loopReviewAfterMs !== undefined && (!Number.isFinite(request.loopReviewAfterMs) || request.loopReviewAfterMs < 0)) throw new Error("Choose a non-negative loop review interval.");
    this.reviewStartedAt = now();
  }

  record(tool: ApiChatTool | undefined, name: string, arguments_: string, result: string): void {
    const exempt = this.request.loopExemptTools ?? defaultLoopExemptTools;
    if (exempt.includes(name) || tool?.label && exempt.includes(tool.label)) return;
    let parsedArguments: unknown = arguments_;
    let parsedResult: unknown = result;
    try { parsedArguments = JSON.parse(arguments_); } catch {}
    try { parsedResult = JSON.parse(result); } catch {}
    const signature = createHash("sha256").update(stableToolValue([parsedArguments, parsedResult])).digest("hex");
    const previous = this.observed.get(name);
    const repeats = previous?.signature === signature ? previous.repeats + 1 : 1;
    this.observed.set(name, { signature, repeats });
    if (this.stalled?.tool === name && repeats < 3) this.stalled = undefined;
    if (repeats >= 3) this.stalled = { tool: name, repeats };
  }

  async beforeRound(rounds: number, signal: AbortSignal): Promise<void> {
    if (signal.aborted) throw new Error("Request cancelled.");
    if (this.summarizing) return;
    const notice: ChatToolLoopNotice | undefined = this.request.loopReviewAfterMs !== undefined
      ? this.stalled && this.now() - this.reviewStartedAt >= this.request.loopReviewAfterMs ? { reason: "stalled", rounds, limit: this.limit, ...this.stalled } : undefined
      : rounds >= this.boundary ? { reason: "round-limit", rounds, limit: this.limit }
      : this.stalled ? { reason: "stalled", rounds, limit: this.limit, ...this.stalled } : undefined;
    if (!notice) return;
    let cancel: () => void = () => {};
    const aborted = new Promise<never>((_, reject) => { cancel = () => reject(new Error("Request cancelled.")); signal.addEventListener("abort", cancel, { once: true }); });
    let decision: ChatToolLoopDecision;
    try {
      decision = await Promise.race([this.request.onToolLoopNotice ? this.request.onToolLoopNotice(notice, signal) : Promise.resolve("summarize" as const), aborted]);
      if (signal.aborted) throw new Error("Request cancelled.");
    } finally { signal.removeEventListener("abort", cancel); }
    if (decision === "cancel") throw new Error("Request cancelled by the user at a tool-loop pause. Completed results were preserved.");
    if (decision === "summarize") this.summarizing = true;
    else if (decision === "continue") {
      if (rounds >= this.boundary) this.boundary = rounds + this.limit;
      this.observed.clear(); this.stalled = undefined;
      this.reviewStartedAt = this.now();
    } else throw new Error("Invalid tool-loop decision; no further tool was executed.");
  }
}

export async function streamApiChat(request: ApiChatRequest, onText: (text: string) => void): Promise<void> {
  const loop = new ChatToolLoopGuard(request);
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
  let remainingMs = request.timeoutMs ?? 120_000;
  let deadlineAt = Date.now() + remainingMs;
  let timer = setTimeout(() => { timedOut = true; controller.abort(); }, remainingMs);
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
    const checkLoop = async (round: number) => {
      if (request.loopReviewAfterMs !== undefined) {
        clearTimeout(timer);
        await loop.beforeRound(round, controller.signal);
        return;
      }
      remainingMs = Math.max(1, deadlineAt - Date.now());
      clearTimeout(timer);
      try { await loop.beforeRound(round, controller.signal); }
      finally { deadlineAt = Date.now() + remainingMs; timer = setTimeout(() => { timedOut = true; controller.abort(); }, remainingMs); }
    };
    for (let round = 0; ; round++) {
    await checkLoop(round);
    if (loop.summarizing) messages.push({ role: "system", content: toolBudgetSummary });
    if (controller.signal.aborted) throw new Error("Request cancelled.");
    const outputTokens = request.maxOutputTokens === undefined ? undefined : request.maxOutputTokens - outputUsed;
    if (outputTokens !== undefined && outputTokens < 1) throw new Error("Request output budget exhausted.");
    request.beforeRound?.(messages, outputTokens || 0);
    request.onStage?.("connecting");
    if (request.loopReviewAfterMs !== undefined) timer = setTimeout(() => { timedOut = true; controller.abort(); }, request.timeoutMs ?? 120_000);
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
      ...(request.tools?.length && !loop.summarizing ? { tools: request.tools.map(tool => ({ type: "function" as const, function: { name: tool.name, description: tool.description, parameters: tool.parameters } })) } : {}),
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
    if (request.loopReviewAfterMs !== undefined) clearTimeout(timer);
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
    if (loop.summarizing) throw new Error("The model requested more tools during the final summary. Completed results were preserved; no additional tool was executed.");
    messages.push({ role: "assistant", content: responseText, tool_calls: toolCalls });
    for (const call of toolCalls) {
      await checkLoop(round);
      if (!call.id || !call.function.name) throw new Error("Invalid tool call.");
      if (controller.signal.aborted) throw new Error("Request cancelled.");
      const event: ApiChatToolEvent = { id: call.id, name: request.tools.find(tool => tool.name === call.function.name)?.label || call.function.name, arguments: call.function.arguments, status: "running" };
      if (loop.summarizing) {
        const result = JSON.stringify({ error: "Not executed: tool-loop continuation was not approved; use completed results." });
        request.onTool?.({ ...event, status: "failed", result });
        messages.push({ role: "tool", content: result, tool_call_id: call.id });
        continue;
      }
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
      loop.record(request.tools.find(item => item.name === call.function.name), call.function.name, call.function.arguments, result);
      messages.push({ role: "tool", content: result, tool_call_id: call.id });
    }
    if (request.afterTools?.()) return;
    }
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