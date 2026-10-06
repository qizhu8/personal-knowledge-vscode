import { ApiChatMessage } from "./api-chat-client";

export interface ChatModelProfile {
  id: string;
  model: string;
  label: string;
  status: "active" | "deprecated" | "unknown";
  contextWindow: number;
  maxOutputTokens: number;
  imageInput?: boolean;
  deprecatedAt?: string;
  inputPricePerMillion?: number;
  outputPricePerMillion?: number;
  currency: string;
  includeUsage: boolean;
  outputTokenParameter: "max_tokens" | "max_completion_tokens";
}
export interface ChatTokenUsage { inputTokens: number; outputTokens: number; cachedInputTokens?: number; }

export function modelProfiles(values: unknown, legacyIds: string[]): ChatModelProfile[] {
  if (!Array.isArray(values)) throw new Error("API Chat model profiles must be an array.");
  const result: ChatModelProfile[] = values.map(value => {
    if (!value || typeof value.id !== "string" || !value.id.trim() || !["active", "deprecated"].includes(value.status)
      || !Number.isSafeInteger(value.contextWindow) || value.contextWindow < 256
      || (value.deprecatedAt !== undefined && !Number.isFinite(Date.parse(value.deprecatedAt)))) throw new Error("Invalid API Chat model profile.");
    for (const price of [value.inputPricePerMillion, value.outputPricePerMillion]) {
      if (price !== undefined && (typeof price !== "number" || !Number.isFinite(price) || price < 0)) throw new Error("Model prices must be non-negative numbers.");
    }
    const maxOutputTokens = value.maxOutputTokens ?? Math.min(4096, Math.floor(value.contextWindow / 4));
    if (!Number.isSafeInteger(maxOutputTokens) || maxOutputTokens < 1 || maxOutputTokens >= value.contextWindow) throw new Error("Invalid model output limit.");
    return {
      id: value.id, model: value.model || value.id, label: value.label || value.id, status: value.status,
      contextWindow: value.contextWindow, maxOutputTokens, deprecatedAt: value.deprecatedAt,
      inputPricePerMillion: value.inputPricePerMillion, outputPricePerMillion: value.outputPricePerMillion,
      currency: value.currency || "USD", includeUsage: value.includeUsage === true,
      outputTokenParameter: value.outputTokenParameter === "max_tokens" ? "max_tokens" : "max_completion_tokens",
    };
  });
  if (new Set(result.map(profile => profile.id)).size !== result.length) throw new Error("Model profile IDs must be unique.");
  for (const id of legacyIds) if (id && !result.some(profile => profile.id === id)) result.push({
    id, model: id, label: id, status: "unknown", contextWindow: 4096, maxOutputTokens: 1024,
    currency: "USD", includeUsage: false, outputTokenParameter: "max_tokens",
  });
  return result;
}

export function assertModelAvailable(profile: ChatModelProfile, now = Date.now()): void {
  if (profile.status === "deprecated" || (profile.deprecatedAt && Date.parse(profile.deprecatedAt) <= now)) {
    throw new Error("This model is deprecated. Select an available model.");
  }
}

export function estimateInputTokens(messages: ApiChatMessage[]): number {
  return messages.reduce((sum, message) => sum + Buffer.byteLength(message.content + (message.tool_calls ? JSON.stringify(message.tool_calls) : ""), "utf8") + 32, 32);
}

export function validateBudget(profile: ChatModelProfile, contextWindow: number, outputTokens: number, messages: ApiChatMessage[]): number {
  assertModelAvailable(profile);
  if (!Number.isSafeInteger(contextWindow) || contextWindow < 256 || contextWindow > profile.contextWindow) throw new Error("Context budget exceeds the model's configured window.");
  if (!Number.isSafeInteger(outputTokens) || outputTokens < 1 || outputTokens > profile.maxOutputTokens || outputTokens >= contextWindow) throw new Error("Output budget exceeds the configured model limit.");
  const input = estimateInputTokens(messages);
  if (input + outputTokens > contextWindow) throw new Error(`Context budget exceeded (~${input} input + ${outputTokens} output tokens). Reduce context/history or increase the budget.`);
  return input;
}

export function estimateCost(profile: ChatModelProfile, inputTokens: number, outputTokens: number): number | undefined {
  if (profile.inputPricePerMillion === undefined || profile.outputPricePerMillion === undefined) return undefined;
  return (inputTokens * profile.inputPricePerMillion + outputTokens * profile.outputPricePerMillion) / 1_000_000;
}