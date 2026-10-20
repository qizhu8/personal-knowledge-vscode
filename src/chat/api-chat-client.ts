import OpenAI from "openai";
import { imageSize } from "image-size";
import { createHash } from "crypto";
import { ChatTokenUsage, ThinkingBudget, checkReportedOutput, reportedReasoningTokens } from "./api-chat-models";

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
export const chatInferenceOutputByteLimit = 100_000;

export interface ChatTransportReceipt {
  schema: "pkm.chat.transport/v1";
  provider: "http" | "vscode";
  messageHashes: string[];
  toolSchemaHash: string;
  countingMethod: "utf8-byte-estimate" | "vscode-countTokens-plus-overhead";
  inputTokens: number;
}

export function chatTransportReceipt(provider: ChatTransportReceipt["provider"], messages: unknown[], tools: unknown[],
  countedInput?: number): ChatTransportReceipt {
  const hash = (value:unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
  return { schema:"pkm.chat.transport/v1", provider, messageHashes:messages.map(hash), toolSchemaHash:hash(tools),
    countingMethod:countedInput === undefined ? "utf8-byte-estimate" : "vscode-countTokens-plus-overhead",
    inputTokens:countedInput ?? 32 + Buffer.byteLength(JSON.stringify([messages, tools]), "utf8") };
}

export interface ApiChatRequest {
  provider: "openai-compatible" | "azure-openai";
  endpoint: string;
  apiKey: string;
  model: string;
  apiVersion?: string;
  messages: ApiChatMessage[];
  signal: AbortSignal;
  /** Maximum model inactivity, not total task or stream duration. */
  timeoutMs?: number;
  maxOutputTokens?: number;
  /** Hidden-reasoning allowance on top of maxOutputTokens; omitted means reasoning counts against maxOutputTokens. */
  thinkingBudget?: ThinkingBudget;
  contextWindow?: number;
  onImage?: (image: ChatImage) => void;
  outputTokenParameter?: "max_tokens" | "max_completion_tokens";
  includeUsage?: boolean;
  onUsage?: (usage: ChatTokenUsage) => void;
  onUsageMetadata?: (valid: boolean) => void;
  onOutputBudgetWarning?: (warning: string) => void;
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
  onTransportPrepared?: (receipt: ChatTransportReceipt) => void;
  onTransportSent?: (receipt: ChatTransportReceipt) => void;
  afterTools?: () => boolean;
  /** Local caller label (never sent to the provider); "memory" marks Memory Engine model steps. */
  purpose?: "memory";
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
  private readonly recent: Array<{ key: string; name: string }> = [];
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
    const key = createHash("sha256").update(stableToolValue([name, parsedArguments])).digest("hex");
    const signature = createHash("sha256").update(stableToolValue(parsedResult)).digest("hex");
    const previous = this.observed.get(key);
    if (previous && previous.signature !== signature) {
      for (let index = this.recent.length - 1; index >= 0; index--) if (this.recent[index].key === key) this.recent.splice(index, 1);
    }
    this.recent.push({ key, name });
    if (this.recent.length > 24) {
      const removed = this.recent.shift()!;
      if (!this.recent.some(item => item.key === removed.key)) this.observed.delete(removed.key);
      else this.observed.get(removed.key)!.repeats = this.recent.filter(item => item.key === removed.key).length;
    }
    const repeats = this.recent.filter(item => item.key === key).length;
    this.observed.set(key, { signature, repeats });
    const stalled = this.recent.find(item => (this.observed.get(item.key)?.repeats || 0) >= 3);
    this.stalled = stalled ? { tool:stalled.name, repeats:this.observed.get(stalled.key)!.repeats } : undefined;
  }

  async beforeRound(rounds: number, signal: AbortSignal): Promise<void> {
    if (signal.aborted) throw new Error("Request cancelled.");
    if (this.summarizing) return;
    const notice: ChatToolLoopNotice | undefined = this.request.loopReviewAfterMs === undefined && rounds >= this.boundary
      ? { reason:"round-limit", rounds, limit:this.limit }
      : this.stalled ? { reason:"stalled", rounds, limit:this.limit, ...this.stalled } : undefined;
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
      this.observed.clear(); this.recent.length = 0; this.stalled = undefined;
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
  const idleMs = request.timeoutMs ?? 1_800_000;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const activity = () => {
    if (controller.signal.aborted) return;
    clearTimeout(timer);
    timer = setTimeout(() => { timedOut = true; controller.abort(); }, idleMs);
  };
  const baseURL = request.endpoint.replace(/\/+$/, "");
  const azure = request.provider === "azure-openai";
  const client = new OpenAI({
    apiKey: request.apiKey || "local",
    baseURL: azure ? `${baseURL}/openai/deployments/${encodeURIComponent(request.model)}` : baseURL,
    defaultHeaders: azure ? { "api-key": request.apiKey } : undefined,
    defaultQuery: azure ? { "api-version": request.apiVersion || "2024-06-01" } : undefined,
    maxRetries: 0,
    timeout: idleMs,
    fetch: async (input, init) => {
      const response = await (request.fetch || fetch)(input, init);
      activity();
      if (!response.body) return response;
      const body = response.body.pipeThrough(new TransformStream<Uint8Array, Uint8Array>({
        transform(chunk, stream) {
          if (chunk.byteLength) activity();
          stream.enqueue(chunk);
        },
      }));
      return new Response(body, { status: response.status, statusText: response.statusText, headers: response.headers });
    },
  });
  try {
    if (controller.signal.aborted) throw new Error("Cancelled");
    const messages = [...request.messages];
    const callIds = new Set(messages.flatMap(message => message.tool_calls?.map(call => call.id) || []));
    const checkLoop = async (round: number) => {
      clearTimeout(timer);
      await loop.beforeRound(round, controller.signal);
    };
    for (let round = 0; ; round++) {
    await checkLoop(round);
    if (loop.summarizing) messages.push({ role: "system", content: toolBudgetSummary });
    if (controller.signal.aborted) throw new Error("Request cancelled.");
    const outputTokens = request.maxOutputTokens;
    if (outputTokens !== undefined && (!Number.isSafeInteger(outputTokens) || outputTokens < 1)) throw new Error("Choose a positive per-inference output token budget.");
    request.beforeRound?.(messages, outputTokens || 0);
    request.onStage?.("connecting");
    activity();
    const payload = {
      model: request.model,
      messages: messages.map(message => {
        if (message.role === "tool") return { role: "tool" as const, content: message.content, tool_call_id: message.tool_call_id! };
        if (message.role === "assistant") return { role: "assistant" as const, content: message.content, tool_calls: message.tool_calls };
        return { role: message.role, content: message.content };
      }),
      stream: true as const,
      ...(outputTokens && request.thinkingBudget !== "unlimited" ? { [request.outputTokenParameter || "max_completion_tokens"]: outputTokens + (request.thinkingBudget || 0) } : {}),
      ...(request.includeUsage ? { stream_options: { include_usage: true } } : {}),
      ...(request.tools?.length && !loop.summarizing ? { tools: request.tools.map(tool => ({ type: "function" as const, function: { name: tool.name, description: tool.description, parameters: tool.parameters } })) } : {}),
    };
    const transport = chatTransportReceipt("http", payload.messages, payload.tools || []);
    request.onTransportPrepared?.(transport);
    const stream = await client.chat.completions.create(payload, { signal: controller.signal });
    activity();
    request.onTransportSent?.(transport);
    request.onStage?.("waiting");
    let finishReason = "";
    let responseText = "";
    let measuredUsage: ChatTokenUsage | undefined;
    const calls = new Map<number, { id: string; type: "function"; function: { name: string; arguments: string } }>();
    for await (const chunk of stream) {
      activity();
      if (chunk.usage) {
        if (![chunk.usage.prompt_tokens, chunk.usage.completion_tokens].every(value => Number.isSafeInteger(value) && value >= 0)) throw new Error("The provider returned invalid token usage; no pending tool was executed.");
        measuredUsage = { inputTokens: chunk.usage.prompt_tokens, outputTokens: chunk.usage.completion_tokens, cachedInputTokens: chunk.usage.prompt_tokens_details?.cached_tokens, ...reportedReasoningTokens(chunk.usage) };
        request.onUsage?.(measuredUsage);
      }
      const choice = chunk.choices[0];
      const text = choice?.delta.content || choice?.delta.refusal || "";
      responseText += text;
      for (const fragment of choice?.delta.tool_calls || []) {
        if (!calls.has(fragment.index)) calls.set(fragment.index, { id: "", type: "function", function: { name: "", arguments: "" } });
        const call = calls.get(fragment.index)!;
        call.id += fragment.id || ""; call.function.name += fragment.function?.name || ""; call.function.arguments += fragment.function?.arguments || "";
        if (calls.size > 16 || call.function.arguments.length > 32_000) throw new Error("Tool call exceeded the local limit.");
      }
      const outputBytes = Buffer.byteLength(responseText, "utf8") + [...calls.values()].reduce((bytes, call) =>
        bytes + Buffer.byteLength(JSON.stringify({ id: call.id, name: call.function.name, arguments: call.function.arguments }), "utf8"), 0);
      if (outputBytes > chatInferenceOutputByteLimit) {
        controller.abort();
        throw new Error("Inference output exceeded the 100,000-byte local size limit. Partial output was preserved; no pending tool was executed.");
      }
      if (text) onText(text);
      if (choice?.finish_reason) finishReason = choice.finish_reason;
    }
    clearTimeout(timer);
    if (!finishReason) throw new Error("The response ended before completion.");
    const toolCalls = [...calls.values()];
    if (outputTokens !== undefined && measuredUsage) checkReportedOutput(measuredUsage, outputTokens, request.thinkingBudget);
    if (finishReason === "stop") {
      if (calls.size) throw new Error("Invalid tool completion. No pending tool was executed.");
      if (!responseText) throw new Error("The model returned an empty response.");
      return;
    }
    if (finishReason !== "tool_calls" || !toolCalls.length) throw new Error(`Response stopped with ${finishReason}. Partial output was preserved.`);
    if (!request.tools?.length) throw new Error("Tool execution is not enabled.");
    if (loop.summarizing) throw new Error("The model requested more tools during the final summary. Completed results were preserved; no additional tool was executed.");
    for (const call of toolCalls) {
      if (!call.id || !call.function.name || call.id.length > 200 || call.function.name.length > 200 || callIds.has(call.id)) {
        throw new Error("Invalid or duplicate tool call identity. No pending tool was executed; completed evidence was preserved.");
      }
      callIds.add(call.id);
    }
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
    if (timedOut) throw new Error("The model API timed out due to inactivity. Partial output was preserved; no automatic retry was performed.");
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