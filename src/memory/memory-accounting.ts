import type { ChatTokenUsage, ThinkingBudget } from "../chat/api-chat-models";
import type { ChatInferenceTiming } from "../chat/chat-inference-timing";

export interface MemoryModelAccounting {
  schema: "pkm.memory.model-accounting/v1";
  modelId: string;
  provider: "http" | "vscode";
  durationMs: number;
  timeoutMs: number;
  maxOutputTokens: number;
  thinkingBudget: ThinkingBudget;
  inferenceTiming?: ChatInferenceTiming;
}

export interface MemoryTurnAccounting {
  schema: "pkm.memory.turn-accounting/v1";
  calls: number;
  reportedCalls: number;
  unreportedCalls: number;
  timedCalls: number;
  untimedCalls: number;
  pendingCalls: number;
  failedCalls: number;
  cancelledCalls: number;
  reportedUsage?: ChatTokenUsage;
  observedDurationMs?: number;
  note: string;
}

export function memoryTurnAccounting(receipt: Record<string, unknown>): MemoryTurnAccounting {
  if (receipt.schema !== "pkm.memory.turn-receipt/v1" || !Array.isArray(receipt.calls)) throw new Error("Invalid Memory turn receipt for accounting.");
  const summary: MemoryTurnAccounting = {
    schema: "pkm.memory.turn-accounting/v1", calls: receipt.calls.length,
    reportedCalls: 0, unreportedCalls: 0, timedCalls: 0, untimedCalls: 0, pendingCalls: 0, failedCalls: 0, cancelledCalls: 0,
    note: "Independent Memory inference accounting, never added to main Chat usage. Reported usage excludes unreported calls; observed duration is local model-call time, not CPU or a provider invoice.",
  };
  const usages: ChatTokenUsage[] = [];
  for (const item of receipt.calls) {
    if (!item || typeof item !== "object" || !["requested", "complete", "failed", "cancelled"].includes(item.status)) throw new Error("Invalid Memory model call receipt.");
    if (item.status === "requested") summary.pendingCalls++;
    if (item.status === "failed") summary.failedCalls++;
    if (item.status === "cancelled") summary.cancelledCalls++;
    if (item.usage !== undefined) {
      const usage: ChatTokenUsage = item.usage;
      if (!usage || ![usage.inputTokens, usage.outputTokens].every(value => Number.isSafeInteger(value) && value >= 0)
        || usage.reasoningTokens !== undefined && (!Number.isSafeInteger(usage.reasoningTokens) || usage.reasoningTokens < 0 || usage.reasoningTokens > usage.outputTokens)
        || usage.cachedInputTokens !== undefined && (!Number.isSafeInteger(usage.cachedInputTokens) || usage.cachedInputTokens < 0 || usage.cachedInputTokens > usage.inputTokens)) {
        throw new Error("Invalid Memory provider usage receipt.");
      }
      usages.push(usage);
      summary.reportedCalls++;
    } else summary.unreportedCalls++;
    if (item.accounting !== undefined) {
      const accounting: MemoryModelAccounting = item.accounting;
      if (!accounting || accounting.schema !== "pkm.memory.model-accounting/v1"
        || typeof accounting.modelId !== "string" || !accounting.modelId || accounting.modelId.length > 512
        || !["http", "vscode"].includes(accounting.provider)
        || !Number.isFinite(accounting.durationMs) || accounting.durationMs < 0
        || !Number.isSafeInteger(accounting.timeoutMs) || accounting.timeoutMs <= 0
        || !Number.isSafeInteger(accounting.maxOutputTokens) || accounting.maxOutputTokens <= 0
        || accounting.thinkingBudget !== "unlimited" && (!Number.isSafeInteger(accounting.thinkingBudget) || accounting.thinkingBudget < 0)) {
        throw new Error("Invalid Memory model accounting receipt.");
      }
      summary.timedCalls++;
      summary.observedDurationMs = (summary.observedDurationMs || 0) + accounting.durationMs;
      if (!Number.isFinite(summary.observedDurationMs)) throw new Error("Memory duration exceeds accounting precision.");
    } else summary.untimedCalls++;
  }
  if (usages.length) {
    const sum = (key: keyof ChatTokenUsage) => {
      const value = usages.reduce((total, usage) => total + (usage[key] || 0), 0);
      if (!Number.isSafeInteger(value)) throw new Error("Memory provider usage exceeds accounting precision.");
      return value;
    };
    summary.reportedUsage = { inputTokens: sum("inputTokens"), outputTokens: sum("outputTokens"),
      ...(usages.every(usage => usage.reasoningTokens !== undefined) ? { reasoningTokens: sum("reasoningTokens") } : {}),
      ...(usages.every(usage => usage.cachedInputTokens !== undefined) ? { cachedInputTokens: sum("cachedInputTokens") } : {}) };
  }
  return summary;
}
