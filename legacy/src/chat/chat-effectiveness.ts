import { createHash } from "crypto";
import type { ChatMessage } from "./api-chat-store";
import type { ApiChatToolEvent } from "./api-chat-client";

/** A complete, successful builtin edit receipt whose content hash did not change. */
export function isReplaceTextNoop(name: string, result: unknown, succeeded = true): boolean {
  if (name !== "replace_text" || !succeeded) return false;
  let receipt = result;
  if (typeof receipt === "string") {
    try { receipt = JSON.parse(receipt); } catch { return false; }
  }
  if (!receipt || typeof receipt !== "object" || Array.isArray(receipt)) return false;
  const value = receipt as Record<string, unknown>;
  const sha256 = (item: unknown): item is string => typeof item === "string" && /^[a-f0-9]{64}$/i.test(item);
  return value.applied === true && typeof value.path === "string" && value.path.length > 0
    && Number.isInteger(value.workspace) && Number.isFinite(value.workspace)
    && typeof value.appliedAt === "string" && Number.isFinite(Date.parse(value.appliedAt))
    && value.saved === false && (value.attribution === "exact" || value.attribution === "unknown")
    && (value.added === undefined || Number.isFinite(value.added) && (value.added as number) >= 0)
    && (value.removed === undefined || Number.isFinite(value.removed) && (value.removed as number) >= 0)
    && sha256(value.beforeHash) && sha256(value.afterHash)
    && value.beforeHash.toLowerCase() === value.afterHash.toLowerCase();
}

type Interval = { startedAt: number; finishedAt?: number };
const finiteAt = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value);
function elapsedBetween(startedAt: unknown, finishedAt: unknown): number | undefined {
  return finiteAt(startedAt) && finiteAt(finishedAt) && finishedAt >= startedAt ? finishedAt - startedAt : undefined;
}
function completedInterval(item: Interval): item is Interval & { finishedAt: number } {
  return finiteAt(item.startedAt) && finiteAt(item.finishedAt) && item.finishedAt >= item.startedAt;
}
function coveredMs(intervals: Interval[]): number | undefined {
  const sorted = intervals.filter(completedInterval).sort((a, b) => a.startedAt - b.startedAt);
  if (!sorted.length) return undefined;
  let end = sorted[0].startedAt, total = 0;
  for (const item of sorted) { total += Math.max(0, item.finishedAt - Math.max(end, item.startedAt)); end = Math.max(end, item.finishedAt); }
  return total;
}
function clippedUnionMs(intervals: Interval[], start: number, end: number): number {
  const clipped = intervals.filter(completedInterval).map(item => ({
    startedAt: Math.max(start, item.startedAt), finishedAt: Math.min(end, item.finishedAt),
  })).filter(completedInterval);
  return clipped.length ? coveredMs(clipped)! : 0;
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
      toolWallMs: tools.length ? coveredMs(tools.flatMap(call => call.startedAt === undefined ? [] : [{ startedAt: call.startedAt, finishedAt: call.finishedAt }])) : 0,
      queuedMs: tools.some(call => call.queuedMs !== undefined) ? tools.reduce((total, call) => total + (call.queuedMs || 0), 0) : undefined,
      novelResults: new Set(tools.filter(call => call.status === "complete" && !call.reused
        && !isReplaceTextNoop(call.name, call.result, true)
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
  const observedModels = budgets.flatMap(budget => {
    const timing = budget.ledger?.inferenceTiming;
    return timing && finiteAt(timing.startedAt) && (timing.finishedAt === undefined || completedInterval(timing))
      ? [{ round:budget.round, startedAt:timing.startedAt, finishedAt:timing.finishedAt }] : [];
  }).sort((a, b) => a.round - b.round);
  const firstBudgetAt = budgets.map(budget => budget.at).filter(finiteAt).sort((a, b) => a - b)[0];
  const firstModelAt = observedModels.map(item => item.startedAt).sort((a, b) => a - b)[0];
  const setup = budgets.find(budget => budget.transport?.sdkSetupTiming)?.transport?.sdkSetupTiming;
  const clientAcquisitionMs = setup ? elapsedBetween(setup.clientAcquisition?.startedAt, setup.clientAcquisition?.finishedAt) : undefined;
  const sessionCreationMs = setup ? elapsedBetween(setup.sessionCreation?.startedAt, setup.sessionCreation?.finishedAt) : undefined;
  const gapBoundaries = observedModels.slice(1).flatMap((next, index) => {
    const previous = observedModels[index];
    if (!completedInterval(previous) || !finiteAt(next.startedAt) || next.startedAt < previous.finishedAt) return [];
    return [{ previous, next }];
  });
  const interRoundGaps = gapBoundaries.slice(-19).map(({ previous, next }) => {
    const elapsedMs = next.startedAt - previous.finishedAt;
    const roundTools = calls.filter(call => call.round === previous.round || call.round === undefined);
    const roundIntervals = roundTools.map(call => ({ startedAt:call.startedAt ?? NaN, finishedAt:call.finishedAt }));
    const completeTools = roundIntervals.filter(completedInterval);
    const toolUnionMs = !roundTools.length ? 0 : completeTools.length
      ? clippedUnionMs(toolIntervals, previous.finishedAt, next.startedAt) : undefined;
    const allToolClocksComplete = roundIntervals.every(completedInterval);
    return { fromRound:previous.round, toRound:next.round, elapsedMs, completedToolUnionMs:toolUnionMs,
      unobservedMs:allToolClocksComplete && next.round === previous.round + 1
        ? elapsedMs - clippedUnionMs([...modelIntervals, ...toolIntervals], previous.finishedAt, next.startedAt) : undefined };
  });
  const attemptStartedAt = message.progress?.startedAt;
  return {
    schema: "pkm.chat.effectiveness/v1" as const, rounds: rounds.slice(-20), omittedRounds: Math.max(0, rounds.length - 20),
    modelWallMs: modelIntervals.length ? coveredMs(modelIntervals) : undefined,
    toolWallMs: toolIntervals.length ? coveredMs(toolIntervals) : undefined,
    observedWallMs: modelIntervals.length || toolIntervals.length ? coveredMs([...modelIntervals, ...toolIntervals]) : undefined,
    startupTiming: {
      attemptToFirstBudgetMs: firstBudgetAt === undefined ? undefined : elapsedBetween(attemptStartedAt, firstBudgetAt),
      attemptToFirstModelStartMs: firstModelAt === undefined ? undefined : elapsedBetween(attemptStartedAt, firstModelAt),
      firstBudgetToFirstModelStartMs: elapsedBetween(firstBudgetAt, firstModelAt),
      sdkSetup: { availability:clientAcquisitionMs !== undefined && sessionCreationMs !== undefined ? "available" as const
        : clientAcquisitionMs !== undefined || sessionCreationMs !== undefined ? "partial" as const : "unavailable" as const,
        clientAcquisitionMs, sessionCreationMs },
    },
    interRoundGaps, omittedInterRoundGaps:Math.max(0, gapBoundaries.length - 19),
    trackedInvocationWaitMs: invocation.reduce((total, item) => total + item.userWaitMs, 0),
    reusedReads: calls.filter(call => call.reused).length,
    unassignedTools: calls.filter(call => call.round === undefined).length,
    note: "Local clocks and provider-reported usage are separate. Model and tool coverage are overlap unions; setup and inter-round elapsed spans are separate and must not be added. Inter-round unobserved time is only elapsed time not covered by complete recorded model/tool intervals. No span attributes time to provider queue, CPU, network, or model reasoning; absent timing is unknown, not zero latency.",
  };
}

export function chatEffectivenessSummary(message: ChatMessage) {
  const { rounds, interRoundGaps, note, ...summary } = chatEffectiveness(message);
  return { ...summary, omittedRounds: summary.omittedRounds + Math.max(0, rounds.length - 5),
    interRoundGaps:interRoundGaps.slice(-4),
    omittedInterRoundGaps:summary.omittedInterRoundGaps + Math.max(0, interRoundGaps.length - 4),
    rounds: rounds.slice(-5).map(round => ({
      round: round.round, inferenceMs: round.inference?.elapsedMs,
      firstPublicOutputMs: round.inference?.firstPublicOutputMs,
      toolWallMs: round.toolWallMs, queuedMs: round.queuedMs, novelResults: round.novelResults,
    })) };
}

/** A bounded, request-local nudge when exploration has not yet produced action. */
export class ChatExplorationAdvisory {
  private reads = 0;
  private readonly rounds = new Set<number>();
  private readonly readIds = new Set<string>();
  private stopped = false;

  observe(event: ApiChatToolEvent): string | undefined {
    if (this.stopped || event.status !== "complete") return undefined;

    if (["replace_text", "save_file", "run_process", "spawn_workers", "assign_workers"].includes(event.name)) {
      if (event.name === "replace_text" && isReplaceTextNoop(event.name, event.result, true)) return undefined;
      this.stopped = true;
      return undefined;
    }

    if (!["read_file", "search_text", "find_files", "list_directory"].includes(event.name)
      || event.reused === true || typeof event.id !== "string" || !event.id
      || typeof event.round !== "number" || !Number.isSafeInteger(event.round) || event.round < 0) return undefined;
    if (this.readIds.has(event.id)) return undefined;

    // Only the first eight read identities and three round numbers are needed.
    if (this.reads < 8) {
      this.readIds.add(event.id);
      this.reads++;
    }
    if (this.rounds.size < 3) this.rounds.add(event.round);
    if (this.reads < 8 || this.rounds.size < 3) return undefined;

    this.stopped = true;
    return "Exploration advisory (not a loop cap): use visible findings to choose one narrow next check rather than reopening broad searches. Delegate only advertised, genuinely independent bounded investigation; preserve permissions and reserve saving, validation, and reporting. If investigating only, deliver findings; do not claim semantic success or force edits or delegation.";
  }
}
