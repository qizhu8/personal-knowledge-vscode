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
export interface ChatTokenUsage { inputTokens: number; outputTokens: number; cachedInputTokens?: number; reasoningTokens?: number; }

export function reportedReasoningTokens(usage: { completion_tokens: number; completion_tokens_details?: { reasoning_tokens?: unknown } }): { reasoningTokens?: number } {
  const value = usage.completion_tokens_details?.reasoning_tokens;
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 && value <= usage.completion_tokens ? { reasoningTokens: value } : {};
}

export type ThinkingBudget = number | "unlimited";
export const thinkingBudgetChoices = ["900", "1500", "2048", "unlimited"] as const;

export function parseThinkingBudget(value: unknown): ThinkingBudget {
  return value === "unlimited" ? "unlimited" : thinkingBudgetChoices.includes(value as typeof thinkingBudgetChoices[number]) ? Number(value) : 2048;
}

/** Without a thinking budget, provider-reported output (including hidden thinking) must fit the output budget. */
export function checkReportedOutput(usage: ChatTokenUsage, outputBudget: number, thinkingBudget?: ThinkingBudget): void {
  const suffix = " Partial output was preserved; no pending tool was executed.";
  if (thinkingBudget === undefined) {
    if (usage.outputTokens > outputBudget) throw new Error(`Model output exceeded the per-inference token budget.${suffix}`);
    return;
  }
  const thinkingLimit = thinkingBudget === "unlimited" ? Infinity : thinkingBudget;
  if (usage.reasoningTokens === undefined) {
    if (usage.outputTokens > outputBudget + thinkingLimit) throw new Error(`Model output (${usage.outputTokens} tokens, thinking not reported separately) exceeded the ${outputBudget}-token output plus ${thinkingBudget}-token thinking budget.${suffix}`);
    return;
  }
  if (usage.reasoningTokens > thinkingLimit) throw new Error(`Model thinking used ${usage.reasoningTokens} tokens, over the ${thinkingBudget}-token thinking budget.${suffix}`);
  const visible = usage.outputTokens - usage.reasoningTokens;
  if (visible > outputBudget) throw new Error(`Model visible output used ${visible} tokens, over the ${outputBudget}-token output budget.${suffix}`);
}

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

export function estimateCost(profile: Pick<ChatModelProfile, "inputPricePerMillion" | "outputPricePerMillion">, inputTokens: number, outputTokens: number): number | undefined {
  if (profile.inputPricePerMillion === undefined || profile.outputPricePerMillion === undefined) return undefined;
  return (inputTokens * profile.inputPricePerMillion + outputTokens * profile.outputPricePerMillion) / 1_000_000;
}