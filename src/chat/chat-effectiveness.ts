import { createHash } from "crypto";
import type { ChatMessage } from "./api-chat-store";

type Interval = { startedAt: number; finishedAt?: number };
function coveredMs(intervals: Interval[]): number {
  const sorted = intervals.filter((item): item is Interval & { finishedAt: number } =>
    Number.isFinite(item.startedAt) && Number.isFinite(item.finishedAt) && item.finishedAt! >= item.startedAt)
    .sort((a, b) => a.startedAt - b.startedAt);
  let end = 0, total = 0;
  for (const item of sorted) { total += Math.max(0, item.finishedAt - Math.max(end, item.startedAt)); end = Math.max(end, item.finishedAt); }
  return total;
}

export function chatEffectiveness(message: ChatMessage) {
  const budgets = message.budgetReceipts || [];
  const calls = message.toolCalls || [];
  const seen = new Set<string>();
  const rounds = budgets.map(budget => {
    const tools = calls.filter(call => call.round === budget.round);
    const timing = budget.ledger?.inferenceTiming;
    return {
      round: budget.round, status: budget.status,
      inference: timing, usage: budget.ledger?.providerUsage, credits: budget.ledger?.credits,
      transport: budget.transport && { inputTokens: budget.transport.inputTokens, countingMethod: budget.transport.countingMethod },
      tools: tools.map(call => ({ id: call.id, name: call.name, status: call.status,
        startedAt: call.startedAt, finishedAt: call.finishedAt, reused: call.reused === true })),
      toolWallMs: coveredMs(tools.flatMap(call => call.startedAt === undefined ? [] : [{ startedAt: call.startedAt, finishedAt: call.finishedAt }])),
      queuedMs: tools.some(call => call.queuedMs !== undefined) ? tools.reduce((total, call) => total + (call.queuedMs || 0), 0) : undefined,
      novelResults: new Set(tools.filter(call => call.status === "complete" && !call.reused
        && !["session_info", "report_work", "record_harness"].includes(call.name))
        .flatMap(call => {
          const hash = createHash("sha256").update(JSON.stringify([call.name, call.result])).digest("hex");
          if (seen.has(hash)) return [];
          seen.add(hash); return [hash];
        })).size,
    };
  });
  const invocation = message.invocationBudgets || [];
  const modelIntervals = budgets.flatMap(budget => budget.ledger?.inferenceTiming ? [budget.ledger.inferenceTiming] : []);
  const toolIntervals = calls.flatMap(call => call.startedAt === undefined ? [] : [{ startedAt: call.startedAt, finishedAt: call.finishedAt }]);
  return {
    schema: "pkm.chat.effectiveness/v1" as const, rounds: rounds.slice(-20), omittedRounds: Math.max(0, rounds.length - 20),
    modelWallMs: modelIntervals.length ? coveredMs(modelIntervals) : undefined,
    toolWallMs: toolIntervals.length ? coveredMs(toolIntervals) : undefined,
    observedWallMs: modelIntervals.length || toolIntervals.length ? coveredMs([...modelIntervals, ...toolIntervals]) : undefined,
    trackedInvocationWaitMs: invocation.reduce((total, item) => total + item.userWaitMs, 0),
    reusedReads: calls.filter(call => call.reused).length,
    unassignedTools: calls.filter(call => call.round === undefined).length,
    note: "Local clocks and provider-reported usage are separate. Overlapping tool/wait durations are not additive wall time. Novel results are observations, not acceptance or semantic progress; missing timing is unknown, not zero latency.",
  };
}

export function chatEffectivenessSummary(message: ChatMessage) {
  const { rounds, note, ...summary } = chatEffectiveness(message);
  return { ...summary, omittedRounds: summary.omittedRounds + Math.max(0, rounds.length - 5),
    rounds: rounds.slice(-5).map(round => ({
      round: round.round, inferenceMs: round.inference?.elapsedMs,
      firstPublicOutputMs: round.inference?.firstPublicOutputMs,
      toolWallMs: round.toolWallMs, queuedMs: round.queuedMs, novelResults: round.novelResults,
    })) };
}
