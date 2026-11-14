import type { ModelProviderUsage } from "../model-provider-contracts.js";

export interface CopilotCreditSummary {
  source: "provider.copilot_usage.total_nano_aiu";
  status: "reported" | "partial" | "not-reported";
  reportedCalls: number;
  totalCalls: number;
  totalNanoAiu?: string;
  credits?: string;
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
  reportedUsage?: ModelProviderUsage;
  credits: CopilotCreditSummary;
  observedDurationMs?: number;
  note: string;
}

function creditSummary(calls: readonly ({ copilotNanoAiu?: number } | undefined)[]): CopilotCreditSummary {
  let total = 0n;
  let reportedCalls = 0;
  for (const call of calls) {
    if (call?.copilotNanoAiu === undefined) continue;
    if (!Number.isSafeInteger(call.copilotNanoAiu) || call.copilotNanoAiu < 0)
      throw new Error("Invalid Copilot credit usage.");
    total += BigInt(call.copilotNanoAiu);
    reportedCalls++;
  }
  const amount = total.toString().padStart(10, "0");
  const fraction = amount.slice(-9).replace(/0+$/, "");
  return {
    source: "provider.copilot_usage.total_nano_aiu",
    status: reportedCalls === 0 ? "not-reported" : reportedCalls === calls.length ? "reported" : "partial",
    reportedCalls,
    totalCalls: calls.length,
    ...(reportedCalls > 0 ? {
      totalNanoAiu: total.toString(),
      credits: `${amount.slice(0, -9)}${fraction ? `.${fraction}` : ""}`,
    } : {}),
  };
}

export function memoryTurnAccounting(receipt: Record<string, unknown>): MemoryTurnAccounting {
  if (receipt.schema !== "pkm.memory.turn-receipt/v1" || !Array.isArray(receipt.calls))
    throw new Error("Invalid Memory turn receipt for accounting.");
  const summary: MemoryTurnAccounting = {
    schema: "pkm.memory.turn-accounting/v1",
    calls: receipt.calls.length,
    reportedCalls: 0,
    unreportedCalls: 0,
    timedCalls: 0,
    untimedCalls: 0,
    pendingCalls: 0,
    failedCalls: 0,
    cancelledCalls: 0,
    credits: creditSummary(receipt.calls.map(item => item?.usage)),
    note: "Independent Memory inference accounting, never added to main Chat usage. Reported usage excludes unreported calls; observed duration is local model-call time, not CPU or a provider invoice.",
  };
  const usages: ModelProviderUsage[] = [];
  for (const item of receipt.calls) {
    if (!item || typeof item !== "object"
      || (item.status !== "requested" && item.status !== "complete" && item.status !== "failed" && item.status !== "cancelled"))
      throw new Error("Invalid Memory model call receipt.");
    if (item.status === "requested") summary.pendingCalls++;
    if (item.status === "failed") summary.failedCalls++;
    if (item.status === "cancelled") summary.cancelledCalls++;
    if (item.usage !== undefined) {
      const usage = item.usage as ModelProviderUsage;
      if (!usage || ![usage.inputTokens, usage.outputTokens].every(value => Number.isSafeInteger(value) && value >= 0)
        || usage.reasoningTokens !== undefined
          && (!Number.isSafeInteger(usage.reasoningTokens) || usage.reasoningTokens < 0 || usage.reasoningTokens > usage.outputTokens)
        || usage.cachedInputTokens !== undefined
          && (!Number.isSafeInteger(usage.cachedInputTokens) || usage.cachedInputTokens < 0 || usage.cachedInputTokens > usage.inputTokens)
        || usage.copilotNanoAiu !== undefined
          && (!Number.isSafeInteger(usage.copilotNanoAiu) || usage.copilotNanoAiu < 0))
        throw new Error("Invalid Memory provider usage receipt.");
      usages.push(usage);
      summary.reportedCalls++;
    } else summary.unreportedCalls++;
    if (item.accounting !== undefined) {
      const accounting = item.accounting as Record<string, unknown>;
      if (!accounting || accounting.schema !== "pkm.memory.model-accounting/v1"
        || typeof accounting.modelId !== "string" || !accounting.modelId || accounting.modelId.length > 512
        || accounting.provider !== "http" && accounting.provider !== "vscode"
        || typeof accounting.durationMs !== "number" || !Number.isFinite(accounting.durationMs) || accounting.durationMs < 0
        || !Number.isSafeInteger(accounting.timeoutMs) || Number(accounting.timeoutMs) <= 0
        || !Number.isSafeInteger(accounting.maxOutputTokens) || Number(accounting.maxOutputTokens) <= 0
        || accounting.thinkingBudget !== "unlimited"
          && (!Number.isSafeInteger(accounting.thinkingBudget) || Number(accounting.thinkingBudget) < 0))
        throw new Error("Invalid Memory model accounting receipt.");
      summary.timedCalls++;
      summary.observedDurationMs = (summary.observedDurationMs ?? 0) + Number(accounting.durationMs);
      if (!Number.isFinite(summary.observedDurationMs))
        throw new Error("Memory duration exceeds accounting precision.");
    } else summary.untimedCalls++;
  }
  if (usages.length > 0) {
    const sum = (key: keyof ModelProviderUsage) => {
      const value = usages.reduce((total, usage) => total + (usage[key] ?? 0), 0);
      if (!Number.isSafeInteger(value)) throw new Error("Memory provider usage exceeds accounting precision.");
      return value;
    };
    summary.reportedUsage = {
      inputTokens: sum("inputTokens"),
      outputTokens: sum("outputTokens"),
      ...(usages.every(usage => usage.reasoningTokens !== undefined) ? { reasoningTokens: sum("reasoningTokens") } : {}),
      ...(usages.every(usage => usage.cachedInputTokens !== undefined) ? { cachedInputTokens: sum("cachedInputTokens") } : {}),
    };
  }
  return summary;
}
