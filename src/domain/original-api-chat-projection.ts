type Json = Record<string, any>;

/** Original public projection only: source identities/manifests and reasoning never enter this summary. */
export function originalApiChatContextSummary(message: Json) {
  const budgets = message.budgetReceipts ?? [], candidates = message.retrieval?.candidates ?? [];
  const kinds = new Map<string, number>();
  for (const candidate of candidates.filter((item: Json) => item.selected)) {
    const kind = candidate.kind.replace(/\b[a-f0-9]{64}\b/gi, "[hash]").slice(0, 64);
    kinds.set(kind, (kinds.get(kind) ?? 0) + 1);
  }
  return {
    roundCount: budgets.length,
    rounds: budgets.slice(-5).map((budget: Json) => ({
      round: budget.round, status: budget.status, estimatedInputTokens: budget.consumed.estimatedInputTokens,
      planningInput: budget.contextPlan?.measuredInput, transportInputTokens: budget.transport?.inputTokens,
      countingMethod: budget.transport?.countingMethod || budget.countingMethod,
      transportAutomaticKnowledge: budget.transport?.automaticKnowledge ? {
        inputBudget: budget.transport.automaticKnowledge.inputBudget, inputTokens: budget.transport.automaticKnowledge.inputTokens,
        countingMethod: budget.transport.automaticKnowledge.countingMethod,
      } : undefined,
      selectedReferenceCount: budget.selectedReferenceIds.length, omittedReferenceCount: budget.contextPlan?.omittedIds.length || 0,
      unresolvedReferenceCount: budget.contextPlan?.unresolved.length || 0, stopReason: budget.contextPlan?.stopReason,
      automaticKnowledge: budget.contextPlan?.automaticKnowledge ? {
        inputBudget: budget.contextPlan.automaticKnowledge.inputBudget,
        estimatedBefore: budget.contextPlan.automaticKnowledge.estimatedBefore,
        estimatedAfter: budget.contextPlan.automaticKnowledge.estimatedAfter,
        countingMethod: budget.contextPlan.automaticKnowledge.countingMethod,
      } : undefined,
    })),
    omittedRounds: Math.max(0, budgets.length - 5),
    retrieval: { candidateCount: candidates.length, selectedCount: message.retrieval?.selectedCount || 0,
      selectedKinds: Object.fromEntries([...kinds].slice(0, 8)), omittedKinds: Math.max(0, kinds.size - 8),
      warningPresent: !!message.retrieval?.warning, onlineLearning: message.retrieval?.invocation?.onlineLearning },
    learning: message.retrievalLearning ? {
      status: message.retrievalLearning.status, provenance: message.retrievalLearning.provenance,
      judgedSources: message.retrievalLearning.judgedSources, relevantSources: message.retrievalLearning.relevantSources,
      unknownSources: message.retrievalLearning.unknownSources, selectionApplied: message.retrievalLearning.selectionApplied,
      error: message.retrievalLearning.error, acknowledgment: message.retrievalLearning.acknowledgment,
    } : undefined,
    evidence: "Full source identities, hashes and manifests are retained locally in the Chat retrieval inspector; not included in this summary.",
  };
}
export function originalApiChatCreditUsage(message: Json | Json[]) {
  const calls = (Array.isArray(message) ? message : [message]).flatMap(item => [...(item.budgetReceipts?.length
    ? item.budgetReceipts.filter((receipt: Json) => receipt.status === "sent" || receipt.ledger?.inferenceTiming || receipt.ledger?.providerUsage)
      .map((receipt: Json) => receipt.ledger?.providerUsage) : [item.usage]),
    ...(item.auxiliaryModelUsage?.map((call: Json) => call.usage) ?? [])]);
  let total = 0n, reported = 0;
  for (const call of calls) {
    if (call?.copilotNanoAiu === undefined) continue;
    if (!Number.isSafeInteger(call.copilotNanoAiu) || call.copilotNanoAiu < 0) throw new Error("Invalid Copilot credit usage.");
    total += BigInt(call.copilotNanoAiu); reported++;
  }
  const amount = total.toString().padStart(10, "0"), fraction = amount.slice(-9).replace(/0+$/, "");
  return { source: "provider.copilot_usage.total_nano_aiu",
    status: !reported ? "not-reported" : reported === calls.length ? "reported" : "partial",
    reportedCalls: reported, totalCalls: calls.length,
    ...(reported ? { totalNanoAiu: total.toString(), credits: `${amount.slice(0, -9)}${fraction ? `.${fraction}` : ""}` } : {}) };
}
export function originalApiChatStatus(metadata: Json, latest: Json | undefined, awaitingResult: boolean) {
  if (metadata.paused) return "paused";
  if (metadata.progress?.status === "running") return metadata.progress?.steps?.at(-1)?.status === "waiting" ? "awaiting-input" : "running";
  if (metadata.progress?.status === "failed" || latest?.role === "assistant" && ["failed", "interrupted"].includes(latest.status)) return "failed";
  if (metadata.progress?.status === "cancelled" || latest?.role === "assistant" && latest.status === "cancelled") return "stopped";
  if (metadata.workerState?.stopped) return "stopped";
  if (awaitingResult) return "awaiting-result";
  if (metadata.lastResultId && metadata.lastResultId !== metadata.readResultId) return "new-result";
  if (metadata.progress?.status === "complete" || latest?.role === "assistant" && latest.status === "complete") return "completed";
  return "idle";
}
