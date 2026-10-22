import type { ChatModelProfile, ChatTokenUsage } from "./api-chat-models";
import { estimateCost } from "./api-chat-models";
import type { HarnessBudgetReceipt } from "./chat-harness-records";
import type { ChatInferenceTiming } from "./chat-inference-timing";
import type { ChatProcessRecord } from "./chat-process-runtime";

export interface BudgetObservation {
  value: number;
  source: string;
  method: "configured" | "estimated" | "local-measured" | "provider-reported";
}

export interface ChatInvocationBudget {
  schema: "pkm.chat.invocation-budget/v1";
  id: string;
  owner: "tool" | "retrieval";
  label: string;
  status: "running" | "complete" | "failed" | "cancelled" | "interrupted" | "degraded" | "unavailable";
  startedAt: number;
  finishedAt?: number;
  elapsedMs: number;
  activeMs: number;
  userWaitMs: number;
  timingSource: "pkm.invocation-clock-excluding-tracked-user-wait";
  deadlineMs?: BudgetObservation;
  detail?: string;
}

export function validChatInvocationBudget(value: unknown): value is ChatInvocationBudget {
  if (!value || typeof value !== "object") return false;
  const item = value as ChatInvocationBudget;
  return item.schema === "pkm.chat.invocation-budget/v1"
    && typeof item.id === "string" && item.id.length > 0 && item.id.length <= 256
    && ["tool", "retrieval"].includes(item.owner)
    && typeof item.label === "string" && item.label.length > 0 && item.label.length <= 512
    && ["running", "complete", "failed", "cancelled", "interrupted", "degraded", "unavailable"].includes(item.status)
    && [item.startedAt, item.elapsedMs, item.activeMs, item.userWaitMs].every(value => Number.isFinite(value) && value >= 0)
    && item.activeMs <= item.elapsedMs && item.userWaitMs === item.elapsedMs - item.activeMs
    && (item.finishedAt === undefined || Number.isFinite(item.finishedAt) && item.finishedAt >= item.startedAt && item.status !== "running")
    && (!["complete", "failed", "cancelled", "degraded", "unavailable"].includes(item.status) || item.finishedAt !== undefined)
    && item.timingSource === "pkm.invocation-clock-excluding-tracked-user-wait"
    && (item.deadlineMs === undefined || !!item.deadlineMs && Number.isFinite(item.deadlineMs.value) && item.deadlineMs.value > 0
      && item.deadlineMs.method === "configured" && typeof item.deadlineMs.source === "string" && item.deadlineMs.source.length > 0 && item.deadlineMs.source.length <= 256)
    && (item.detail === undefined || typeof item.detail === "string" && item.detail.length <= 1024);
}

export function recordChatInvocationBudget(items: ChatInvocationBudget[], item: ChatInvocationBudget): void {
  if (!validChatInvocationBudget(item)) throw new Error("Invalid invocation budget observation.");
  const index = items.findIndex(previous => previous.id === item.id);
  if (index < 0) items.push(structuredClone(item));
  else {
    const previous = items[index];
    if (previous.owner !== item.owner || previous.label !== item.label || previous.startedAt !== item.startedAt
      || JSON.stringify(previous.deadlineMs) !== JSON.stringify(item.deadlineMs)
      || previous.status !== "running" && JSON.stringify(previous) !== JSON.stringify(item)
      || item.elapsedMs < previous.elapsedMs || item.activeMs < previous.activeMs || item.userWaitMs < previous.userWaitMs) {
      throw new Error("Invocation budget identity or terminal observation cannot be replaced.");
    }
    items[index] = structuredClone(item);
  }
}

export interface ChatBudgetEntry {
  id: string;
  label: string;
  owner: "model-call" | "attempt" | "context-planner" | "worker-tree" | "process";
  scope: "round" | "attempt-cumulative" | "task" | "invocation";
  unit: "tokens" | "milliseconds" | "rounds" | "calls" | "workers" | "currency" | "bytes";
  enforcement: "hard-limit" | "review-trigger" | "accounting-only" | "provider-default";
  limit?: BudgetObservation;
  consumed?: BudgetObservation;
  unavailable?: string;
  note?: string;
}

export interface ChatBudgetLedger {
  schema: "pkm.chat.budget-ledger/v1";
  thinkingPolicy: "provider-default";
  providerUsage?: ChatTokenUsage;
  inferenceTiming?: ChatInferenceTiming;
  usageFrames: number;
  currency: string;
  pricing: Pick<ChatModelProfile, "inputPricePerMillion" | "outputPricePerMillion">;
  entries: ChatBudgetEntry[];
  outcome?: { status: "complete" | "cancelled" | "failed" | "interrupted"; detail?: string };
}

const observation = (value: number, source: string, method: BudgetObservation["method"]): BudgetObservation => {
  if (!Number.isFinite(value) || value < 0) throw new Error(`Invalid budget observation for ${source}.`);
  return { value, source, method };
};

export function createChatBudgetLedger(receipt: HarnessBudgetReceipt, profile: ChatModelProfile): ChatBudgetLedger {
  const configured = (value: number, source: string) => observation(value, source, "configured");
  return {
    schema: "pkm.chat.budget-ledger/v1", thinkingPolicy: "provider-default", usageFrames: 0,
    currency: profile.currency,
    pricing: { inputPricePerMillion: profile.inputPricePerMillion, outputPricePerMillion: profile.outputPricePerMillion },
    entries: [
      { id: "input", label: "Planned input", owner: "model-call", scope: "round", unit: "tokens", enforcement: "hard-limit",
        limit: configured(receipt.effective.inputBudget, "effective.contextWindow-minus-output"),
        consumed: observation(receipt.consumed.estimatedInputTokens, "context-planner.utf8-byte-estimate", "estimated") },
      { id: "transport-input", label: "Transport input accounting", owner: "model-call", scope: "round", unit: "tokens", enforcement: "accounting-only",
        unavailable: "The transport has not prepared its payload; local counting is not provider usage." },
      { id: "provider-input", label: "Provider input", owner: "model-call", scope: "round", unit: "tokens", enforcement: "accounting-only",
        unavailable: "Provider input usage has not been reported." },
      { id: "output", label: "Output including reasoning", owner: "model-call", scope: "round", unit: "tokens", enforcement: "hard-limit",
        limit: configured(receipt.effective.outputTokens, "model-profile-and-chat.outputTokens"),
        unavailable: "Provider output usage has not been reported; this is not a zero-token response." },
      { id: "reasoning", label: "Thinking (Provider default)", owner: "model-call", scope: "round", unit: "tokens", enforcement: "provider-default",
        unavailable: "No thinking override. Separate reasoning usage has not been reported." },
      { id: "visible-output", label: "Visible output", owner: "model-call", scope: "round", unit: "tokens", enforcement: "accounting-only",
        unavailable: "Visible tokens cannot be separated without provider reasoning usage." },
      { id: "cached-input", label: "Cached input", owner: "model-call", scope: "round", unit: "tokens", enforcement: "accounting-only",
        unavailable: "Provider cached input usage has not been reported." },
      { id: "model-idle", label: "Model inactivity timeout", owner: "model-call", scope: "round", unit: "milliseconds", enforcement: "hard-limit",
        limit: configured(receipt.requested.modelTimeoutMs, "personalKnowledge.apiChatTimeoutSeconds"),
        unavailable: "An inference timing observation is not available; wall time and tool/user waits are not model idle." },
      { id: "model-elapsed", label: "Model transport elapsed time", owner: "model-call", scope: "round", unit: "milliseconds", enforcement: "accounting-only",
        unavailable: "An inference timing observation is not available." },
      { id: "first-activity", label: "First transport activity", owner: "model-call", scope: "round", unit: "milliseconds", enforcement: "accounting-only",
        unavailable: "The model transport has not reported activity. Activity/heartbeat is not generated output." },
      { id: "first-public-output", label: "First observed text/tool/image", owner: "model-call", scope: "round", unit: "milliseconds", enforcement: "accounting-only",
        unavailable: "No public output observed. Hidden thinking is not a provider token timestamp." },
      { id: "active-review", label: "Active-time continuation review", owner: "attempt", scope: "attempt-cumulative", unit: "milliseconds", enforcement: "review-trigger",
        ...(receipt.requested.activeReviewMs === undefined ? {} : { limit: configured(receipt.requested.activeReviewMs, "personalKnowledge.apiChatLoopReviewMinutes") }),
        consumed: observation(receipt.consumed.activeMs, "pkm.active-clock-excluding-user-wait", "local-measured"),
        note: receipt.requested.activeReviewMs === undefined ? "No active-time gate is configured; the existing loop guard uses round/repeated-call policy."
          : "Cumulative attempt time, not a hard task deadline. Approved continuation resets the review window, not this counter; native provider confirmations are not tracked user waits." },
      { id: "tool-round-review", label: "Completed model/tool rounds", owner: "attempt", scope: "attempt-cumulative", unit: "rounds", enforcement: "review-trigger",
        limit: configured(receipt.requested.toolRoundReview, "personalKnowledge.apiChatMaxToolRounds"),
        consumed: observation(receipt.round, "budget-receipt.round", "local-measured") },
      { id: "tool-calls", label: "Recorded tool calls", owner: "attempt", scope: "attempt-cumulative", unit: "calls", enforcement: "accounting-only",
        unavailable: "Tool call accounting has not been sampled." },
      { id: "user-wait", label: "User/approval/continuation wait", owner: "attempt", scope: "attempt-cumulative", unit: "milliseconds", enforcement: "accounting-only",
        unavailable: "Wait accounting has not been sampled." },
      { id: "refinement", label: "Context refinements", owner: "context-planner", scope: "round", unit: "rounds", enforcement: "accounting-only",
        ...(receipt.contextPlan ? { consumed: observation(receipt.contextPlan.refinements, "context-plan.refinements", "local-measured") }
          : { unavailable: "No context plan receipt was recorded." }) },
      { id: "cost", label: "Configured-price cost estimate", owner: "model-call", scope: "round", unit: "currency", enforcement: "accounting-only",
        unavailable: "Cost requires reported provider usage and both configured prices; it is not a provider invoice." },
      { id: "worker-quota", label: "Task-wide worker quota", owner: "worker-tree", scope: "task", unit: "workers", enforcement: "accounting-only",
        unavailable: "Task-wide worker/resource allocation is not yet instrumented by this ledger. This is not unlimited capacity." },
    ],
  };
}

function entry(ledger: ChatBudgetLedger, id: string): ChatBudgetEntry {
  const value = ledger.entries.find(item => item.id === id);
  if (!value) throw new Error(`Budget ledger entry is missing: ${id}`);
  return value;
}

function consume(ledger: ChatBudgetLedger, id: string, value: number, source: string, method: BudgetObservation["method"]): void {
  const target = entry(ledger, id);
  target.consumed = observation(value, source, method);
  delete target.unavailable;
}

export function recordChatBudgetTransport(receipt: HarnessBudgetReceipt): void {
  if (!receipt.ledger || !receipt.transport) return;
  consume(receipt.ledger, "transport-input", receipt.transport.inputTokens, `transport.${receipt.transport.countingMethod}`,
    receipt.transport.countingMethod === "utf8-byte-estimate" ? "estimated" : "local-measured");
}

export function recordChatInferenceTiming(ledger: ChatBudgetLedger, timing: ChatInferenceTiming): void {
  if (![timing.elapsedMs, timing.maxInactivityMs, timing.firstActivityMs ?? 0, timing.firstPublicOutputMs ?? 0]
    .every(value => Number.isFinite(value) && value >= 0 && value <= timing.elapsedMs)) {
    throw new Error("Invalid model transport timing observation.");
  }
  ledger.inferenceTiming = timing;
  consume(ledger, "model-idle", timing.maxInactivityMs, `transport.${timing.provider}.max-observed-activity-gap`, "local-measured");
  consume(ledger, "model-elapsed", timing.elapsedMs, `transport.${timing.provider}.inference-clock`, "local-measured");
  if (timing.firstActivityMs !== undefined) consume(ledger, "first-activity", timing.firstActivityMs, `transport.${timing.provider}.first-activity`, "local-measured");
  if (timing.firstPublicOutputMs !== undefined) consume(ledger, "first-public-output", timing.firstPublicOutputMs, `transport.${timing.provider}.first-public-part`, "local-measured");
}

export function recordChatWorkerBudget(ledger: ChatBudgetLedger, snapshot: { treeId?: string; active: number; quota: number; maximum: number }): void {
  if (![snapshot.active, snapshot.quota, snapshot.maximum].every(value => Number.isSafeInteger(value) && value >= 0)
    || snapshot.quota > snapshot.maximum) throw new Error("Invalid worker tree budget observation.");
  const target = entry(ledger, "worker-quota");
  target.enforcement = "hard-limit";
  target.limit = observation(snapshot.maximum, "personalKnowledge.apiChatMaximumWorkers", "configured");
  consume(ledger, "worker-quota", snapshot.active, snapshot.treeId ? `worker-tree.${snapshot.treeId}.unreleased-slots` : "current-task.no-worker-tree", "local-measured");
  target.note = `Current reusable tree quota: ${snapshot.quota} workers; maximum: ${snapshot.maximum}. All nested workers share the same tree. This snapshot is not a lifetime creation count or a token/CPU quota.`;
}

export function recordChatProcessBudget(ledger: ChatBudgetLedger, record: ChatProcessRecord): void {
  const prefix = `process.${record.handle}`;
  const values: ChatBudgetEntry[] = [
    { id: `${prefix}.deadline`, label: `${record.handle} deadline`, owner: "process", scope: "invocation", unit: "milliseconds", enforcement: "hard-limit",
      limit: observation(record.spec.timeoutSeconds * 1000, `${prefix}.approved-timeoutSeconds`, "configured"),
      consumed: observation(Math.max(0, record.updatedAt - record.createdAt), `${prefix}.supervisor-elapsed-including-startup`, "local-measured"),
      note: `Observed ${record.state}. ${record.detail || ""} This durable lifetime is independent of Chat model/user-wait clocks; elapsed includes supervisor startup.` },
    { id: `${prefix}.storage`, label: `${record.handle} combined log storage`, owner: "process", scope: "invocation", unit: "bytes", enforcement: "hard-limit",
      limit: observation(64 * 1024 * 1024, "process-runtime.combined-log-storage-limit", "configured"),
      consumed: observation(record.stdoutBytes + record.stderrBytes, `${prefix}.stdoutBytes-plus-stderrBytes`, "local-measured"),
      note: "Cumulative stored bytes for this original invocation. Do not sum repeated status snapshots. A bounded model-visible page is not an execution limit." },
  ];
  for (const value of values) {
    const index = ledger.entries.findIndex(item => item.id === value.id);
    if (index < 0) ledger.entries.push(value); else ledger.entries[index] = value;
  }
}

export function recordChatBudgetUsage(ledger: ChatBudgetLedger, usage: ChatTokenUsage): void {
  if (![usage.inputTokens, usage.outputTokens].every(value => Number.isSafeInteger(value) && value >= 0)
    || usage.cachedInputTokens !== undefined && (!Number.isSafeInteger(usage.cachedInputTokens) || usage.cachedInputTokens < 0 || usage.cachedInputTokens > usage.inputTokens)
    || usage.reasoningTokens !== undefined && (!Number.isSafeInteger(usage.reasoningTokens) || usage.reasoningTokens < 0 || usage.reasoningTokens > usage.outputTokens)) {
    throw new Error("Provider token usage is invalid; the budget ledger cannot record it.");
  }
  ledger.providerUsage = { ...usage };
  ledger.usageFrames++;
  consume(ledger, "provider-input", usage.inputTokens, "provider.usage.inputTokens", "provider-reported");
  consume(ledger, "output", usage.outputTokens, "provider.usage.outputTokens", "provider-reported");
  for (const [id, value, source] of [
    ["reasoning", usage.reasoningTokens, "provider.usage.reasoningTokens"],
    ["visible-output", usage.reasoningTokens === undefined ? undefined : usage.outputTokens - usage.reasoningTokens, "provider.usage.output-minus-reasoning"],
    ["cached-input", usage.cachedInputTokens, "provider.usage.cachedInputTokens"],
  ] as const) {
    if (value !== undefined) consume(ledger, id, value, source, "provider-reported");
    else {
      const target = entry(ledger, id);
      delete target.consumed;
      target.unavailable = "The latest provider usage frame does not report this quantity separately.";
    }
  }
  const cost = estimateCost(ledger.pricing, usage.inputTokens, usage.outputTokens);
  if (cost !== undefined) consume(ledger, "cost", cost, `configured-prices.${ledger.currency}-per-million-times-provider-usage`, "estimated");
}

export function chatBudgetUsage(receipts: HarnessBudgetReceipt[]): ChatTokenUsage | undefined {
  const reported = receipts.flatMap(receipt => receipt.ledger?.providerUsage ? [receipt.ledger.providerUsage] : []);
  if (!reported.length) return undefined;
  const sum = (field: keyof ChatTokenUsage) => {
    const total = reported.reduce((value, usage) => value + (usage[field] || 0), 0);
    if (!Number.isSafeInteger(total)) throw new Error(`Reported ${field} exceeds safe budget accounting precision.`);
    return total;
  };
  return { inputTokens: sum("inputTokens"), outputTokens: sum("outputTokens"),
    ...(reported.every(usage => usage.cachedInputTokens !== undefined) ? { cachedInputTokens: sum("cachedInputTokens") } : {}),
    ...(reported.every(usage => usage.reasoningTokens !== undefined) ? { reasoningTokens: sum("reasoningTokens") } : {}) };
}

export function recordChatBudgetRuntime(ledger: ChatBudgetLedger, activeMs: number, elapsedMs: number, toolCalls: number): void {
  if (![activeMs, elapsedMs, toolCalls].every(value => Number.isFinite(value) && value >= 0) || !Number.isSafeInteger(toolCalls)) {
    throw new Error("Invalid budget runtime observation.");
  }
  if (activeMs > elapsedMs) throw new Error("Active runtime cannot exceed elapsed runtime.");
  consume(ledger, "active-review", activeMs, "pkm.active-clock-excluding-user-wait", "local-measured");
  consume(ledger, "user-wait", elapsedMs - activeMs, "pkm.elapsed-minus-active", "local-measured");
  consume(ledger, "tool-calls", toolCalls, "attempt.recorded-tool-call-identities", "local-measured");
}
