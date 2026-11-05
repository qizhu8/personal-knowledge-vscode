import type { ApiChatMessage, ChatInputBaseline, ChatInputTokenCounter } from "./api-chat-client";
import { estimateInputTokens } from "./api-chat-models";
import { createHash } from "crypto";
import { memoryMatchScore, memoryTerms, toolEvidenceReminder } from "./chat-memory";

export interface AutomaticChatContext {
  ids: string[];
  priority: number;
  budget?: "knowledge";
  preferRefinement?: boolean;
  groupId?: string;
  refine?: (query?:string) => Array<{ message:ApiChatMessage; reference:AutomaticChatContext }>;
  isCurrent?: () => boolean;
}

export class ContextBudgetExceededError extends Error {}

export interface ContextPlanReceipt {
  schema: "pkm.chat.context-plan/v1";
  estimatedBefore: number;
  estimatedAfter: number;
  inputBudget: number;
  refinements: number;
  stopReason: "fits" | "selected-subset" | "refinement-limit" | "candidate-limit" | "no-progress" | "deadline" | "stale-source";
  omittedIds: string[];
  unresolved: string[];
  manifest: Array<{ role:ApiChatMessage["role"]; hash:string; referenceIds:string[]; callIds:string[] }>;
  toolSchemaHash: string;
  measuredInput?: { inputTokens: number; countingMethod: "vscode-countTokens-plus-overhead" | "mixed-token-counts-and-byte-bounds" | "provider-usage-plus-byte-bound" };
  automaticKnowledge?: { inputBudget: number; estimatedBefore: number; estimatedAfter: number; countingMethod: "utf8-byte-upper-bound" };
}

export const AUTOMATIC_KNOWLEDGE_INPUT_BUDGET = 8_000;

const digest = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");

export function sdkInputGrowth(messages: ApiChatMessage[], baseline: ChatInputBaseline): ApiChatMessage[] {
  const counts = new Map<string, number>();
  for (const hash of baseline.messageHashes) counts.set(hash, (counts.get(hash) || 0) + 1);
  return messages.filter(message => {
    const hash = digest(message), count = counts.get(hash) || 0;
    if (!count) return true;
    counts.set(hash, count - 1);
    return false;
  });
}

export function sdkInputBound(messages: ApiChatMessage[], baseline: ChatInputBaseline): number {
  if (!Number.isSafeInteger(baseline.inputTokens) || baseline.inputTokens < 0
    || !Number.isSafeInteger(baseline.outputTokens) || baseline.outputTokens < 0) throw new Error("Invalid SDK context usage baseline.");
  const added = sdkInputGrowth(messages, baseline);
  if (added.some(message => message.images?.length)) throw new Error("New images require a fresh SDK context admission.");
  const bound = baseline.inputTokens + baseline.outputTokens + estimateInputTokens(added);
  if (!Number.isSafeInteger(bound)) throw new Error("SDK context usage exceeds the supported input budget.");
  return bound;
}

export class ContextCandidateLimitError extends Error {}

export interface ContextTokenMeasurement {
  messages: ReadonlyMap<ApiChatMessage, { hash: string; tokens: number }>;
  tools: number;
}

function contextTokens(messages: ApiChatMessage[], measurement?: ContextTokenMeasurement): number {
  if (!measurement) return estimateInputTokens(messages);
  return messages.reduce((total, message) => {
    const measured = measurement.messages.get(message);
    return total + (measured?.hash === digest(message) ? measured.tokens : estimateInputTokens([message]) - 32);
  }, 32);
}

export function fitChatContext(
  messages: ApiChatMessage[],
  automatic: Map<ApiChatMessage, AutomaticChatContext>,
  inputBudget: number,
  toolSchema: ApiChatMessage[] = [],
  options: { maxRefinements?: number; maxCandidates?: number; deadlineMs?: number; now?: () => number; query?:string; measurement?:ContextTokenMeasurement; baseline?:ChatInputBaseline; report?: (receipt:ContextPlanReceipt) => void } = {},
): Set<string> {
  const now = options.now || Date.now, started = now();
  const maxRefinements = options.maxRefinements ?? 8, maxCandidates = options.maxCandidates ?? 100, deadline = options.deadlineMs ?? 1000;
  if (!Number.isSafeInteger(maxRefinements) || maxRefinements < 0 || !Number.isSafeInteger(maxCandidates) || maxCandidates < 0
    || !Number.isFinite(deadline) || deadline < 0) throw new Error("Invalid context refinement limits.");
  const mandatory = messages.filter(message => !automatic.has(message));
  const cost = (values: ApiChatMessage[]) => contextTokens(values, options.measurement);
  const schemaTokens = options.measurement?.tools ?? estimateInputTokens(toolSchema) - 32;
  const totalCost = (values: ApiChatMessage[]) => options.baseline ? sdkInputBound(values, options.baseline) : cost(values) + schemaTokens;
  const mandatoryTokens = totalCost(mandatory);
  if (mandatoryTokens > inputBudget) {
    throw new ContextBudgetExceededError("Context budget exceeded by required input, pinned context or active tool results. Reduce required context or increase the model budget.");
  }
  const estimatedBefore = estimateInputTokens([...messages, ...toolSchema]);
  const knowledgeMessages = (values: ApiChatMessage[]) => values.filter(message => automatic.get(message)?.budget === "knowledge");
  const knowledgeBefore = knowledgeMessages(messages);
  const selected = new Set(mandatory);
  let refinements = 0, candidates = 0;
  let knowledgeTokens = 32;
  let stopReason: ContextPlanReceipt["stopReason"] = totalCost(messages) <= inputBudget ? "fits" : "selected-subset";
  const unresolved: string[] = [];
  const groups = new Map<string | ApiChatMessage, ApiChatMessage[]>();
  for (const message of messages) if (automatic.has(message)) {
    const key = automatic.get(message)!.groupId || message;
    const group = groups.get(key) || []; group.push(message); groups.set(key, group);
  }
  const ordered = [...groups.values()].sort((a, b) => automatic.get(b[0])!.priority - automatic.get(a[0])!.priority);
  const seen = new Set(messages.map(message => digest([message, automatic.get(message)?.ids])));
  const operations = new Set<string>();
  for (const group of ordered) {
    if (group.some(message => automatic.get(message)!.isCurrent?.() === false)) {
      stopReason = "stale-source"; unresolved.push(...group.flatMap(message => automatic.get(message)!.ids)); continue;
    }
    const reference = automatic.get(group[0])!;
    const knowledgeCost = estimateInputTokens(knowledgeMessages(group)) - 32;
    if (totalCost([...selected, ...group]) <= inputBudget && knowledgeTokens + knowledgeCost <= AUTOMATIC_KNOWLEDGE_INPUT_BUDGET
      && !(reference.preferRefinement && reference.refine)) {
      for (const message of group) selected.add(message);
      knowledgeTokens += knowledgeCost; continue;
    }
    if (!reference.refine) continue;
    const operation = digest(group.map(message => [message, automatic.get(message)!.ids]));
    if (operations.has(operation)) { stopReason = "no-progress"; unresolved.push(...reference.ids); continue; }
    if (refinements >= maxRefinements) { stopReason = "refinement-limit"; unresolved.push(...reference.ids); continue; }
    if (candidates >= maxCandidates) { stopReason = "candidate-limit"; unresolved.push(...reference.ids); continue; }
    if (now() - started >= deadline) { stopReason = "deadline"; unresolved.push(...reference.ids); continue; }
    operations.add(operation);
    refinements++;
    let refined: ReturnType<NonNullable<AutomaticChatContext["refine"]>>;
    try { refined = reference.refine(options.query); }
    catch (error) {
      if (!(error instanceof ContextCandidateLimitError)) throw error;
      candidates = maxCandidates; stopReason = "candidate-limit"; unresolved.push(...reference.ids); continue;
    }
    if (refined.length > maxCandidates - candidates) {
      candidates = maxCandidates; stopReason = "candidate-limit"; unresolved.push(...reference.ids); continue;
    }
    candidates += refined.length;
    if (now() - started >= deadline) { stopReason = "deadline"; unresolved.push(...reference.ids); continue; }
    const fresh = refined.filter(item => {
      const identity = digest([item.message, item.reference.ids]);
      if (seen.has(identity)) return false;
      seen.add(identity);
      return true;
    });
    if (!fresh.length) { if (stopReason === "selected-subset") stopReason = "no-progress"; unresolved.push(...reference.ids); continue; }
    for (const item of fresh) {
      if (item.message.role !== "system" || item.message.tool_calls || item.message.tool_call_id || item.message.images?.length) throw new Error("Refinement can only return reference text, not instructions or tool calls.");
      automatic.set(item.message, { ...item.reference, ...(reference.budget ? { budget:reference.budget } : {}), refine:undefined });
    }
    const replacement = fresh.map(item => item.message);
    const position = messages.indexOf(group[0]);
    messages.splice(position, 0, ...replacement);
    for (const item of fresh.sort((a, b) => b.reference.priority - a.reference.priority)) {
      if (item.reference.isCurrent?.() === false) { stopReason = "stale-source"; unresolved.push(...item.reference.ids); continue; }
      const refinedKnowledgeCost = automatic.get(item.message)?.budget === "knowledge" ? estimateInputTokens([item.message]) - 32 : 0;
      if (totalCost([...selected, item.message]) <= inputBudget && knowledgeTokens + refinedKnowledgeCost <= AUTOMATIC_KNOWLEDGE_INPUT_BUDGET) {
        selected.add(item.message); knowledgeTokens += refinedKnowledgeCost;
      }
      else unresolved.push(...item.reference.ids);
    }
  }
  const omittedIds = [...new Set(messages.filter(message => !selected.has(message)).flatMap(message => automatic.get(message)?.ids || []))];
  messages.splice(0, messages.length, ...messages.filter(message => selected.has(message)));
  const ids = new Set(messages.flatMap(message => automatic.get(message)?.ids || []));
  if (stopReason === "fits" && omittedIds.some(id => !ids.has(id))) stopReason = "selected-subset";
  options.report?.({
    schema:"pkm.chat.context-plan/v1", estimatedBefore, estimatedAfter:estimateInputTokens([...messages, ...toolSchema]),
    inputBudget, refinements, stopReason, omittedIds:omittedIds.filter(id => !ids.has(id)), unresolved:[...new Set(unresolved)],
    manifest:messages.map(message => ({ role:message.role, hash:digest(message), referenceIds:automatic.get(message)?.ids || [],
      callIds:message.tool_calls?.map(call => call.id) || (message.tool_call_id ? [message.tool_call_id] : []) })),
    toolSchemaHash:digest(toolSchema),
    ...(options.baseline ? { measuredInput:{ inputTokens:totalCost(messages),
      countingMethod:"provider-usage-plus-byte-bound" as const } } : options.measurement ? { measuredInput:{ inputTokens:cost(messages) + schemaTokens,
      countingMethod:messages.every(message => options.measurement!.messages.get(message)?.hash === digest(message))
        ? "vscode-countTokens-plus-overhead" as const : "mixed-token-counts-and-byte-bounds" as const } } : {}),
    ...(knowledgeBefore.length ? { automaticKnowledge:{ inputBudget:AUTOMATIC_KNOWLEDGE_INPUT_BUDGET,
      estimatedBefore:estimateInputTokens(knowledgeBefore), estimatedAfter:estimateInputTokens(knowledgeMessages(messages)),
      countingMethod:"utf8-byte-upper-bound" as const } } : {}),
  });
  return ids;
}

export class ChatContextPlanner {
  private readonly pool: ApiChatMessage[];
  private ledger?: ApiChatMessage;
  private derived = new Set<ApiChatMessage>();
  constructor(messages: ApiChatMessage[], private readonly automatic: Map<ApiChatMessage, AutomaticChatContext>,
    private readonly toolSchema: ApiChatMessage[]) { this.pool = [...messages]; }

  checkpoint(): () => void {
    const pool = [...this.pool], automatic = new Map(this.automatic), ledger = this.ledger, derived = new Set(this.derived);
    return () => {
      this.pool.splice(0, this.pool.length, ...pool);
      this.automatic.clear();
      for (const [message, reference] of automatic) this.automatic.set(message, reference);
      this.ledger = ledger;
      this.derived = derived;
    };
  }

  async measure(messages: ApiChatMessage[], inputBudget: number, counter: ChatInputTokenCounter): Promise<ContextTokenMeasurement | undefined> {
    const candidates = [...new Set([...this.pool, ...messages])].filter(message => message !== this.ledger && !this.derived.has(message));
    if (estimateInputTokens([...candidates, ...this.toolSchema]) <= inputBudget) return undefined;
    const counts = await Promise.all(candidates.map(async message => {
      const hash = digest(message), tokens = await counter.countMessage(message);
      if (!Number.isSafeInteger(tokens) || tokens < 0) throw new Error("Input token count is unavailable.");
      return [message, { hash, tokens }] as const;
    }));
    const tools = await counter.countTools();
    if (!Number.isSafeInteger(tools) || tools < 0) throw new Error("Tool schema token count is unavailable.");
    return { messages:new Map(counts), tools };
  }

  plan(messages: ApiChatMessage[], inputBudget: number, query: string, measurement?:ContextTokenMeasurement, baseline?:ChatInputBaseline): { selected:Set<string>; receipt:ContextPlanReceipt } {
    const pool = [...this.pool];
    for (const message of messages) if (message !== this.ledger && !this.derived.has(message) && !pool.includes(message)) pool.push(message);
    const groups: ApiChatMessage[][] = [];
    for (let index = 0; index < pool.length; index++) {
      const message = pool[index];
      if (!message.tool_calls?.length) continue;
      const group = [message];
      let cursor = index + 1;
      while (pool[cursor]?.role === "tool") group.push(pool[cursor++]);
      const ids = message.tool_calls.map(call => call.id);
      if (group.length !== ids.length + 1 || new Set(ids).size !== ids.length
        || group.slice(1).some(result => !result.tool_call_id || !ids.includes(result.tool_call_id))
        || new Set(group.slice(1).map(result => result.tool_call_id)).size !== ids.length) throw new Error("Context contains an incomplete or duplicate tool call/result group.");
      groups.push(group);
      index = cursor - 1;
    }
    const terms = memoryTerms(query);
    for (const [index, group] of groups.entries()) {
      if (index === groups.length - 1) continue;
      const ids = group[0].tool_calls!.map(call => `tool:${call.id}:${digest(group)}`);
      const priority = 200 + memoryMatchScore(group.map(message => message.content).join("\n"), terms) + index / Math.max(1, groups.length);
      for (const message of group) this.automatic.set(message, { ids, priority, groupId:ids.join("|") });
    }
    const planned = [...pool];
    if (groups.length > 1 && (baseline ? sdkInputBound(pool, baseline)
      : contextTokens(pool, measurement) + (measurement?.tools ?? estimateInputTokens(this.toolSchema) - 32)) > inputBudget) {
      const calls = groups.slice(0, -1).flatMap(group => group[0].tool_calls!);
      this.ledger = { role:"system", content:toolEvidenceReminder(calls.map(call => ({ id:call.id, name:call.function.name }))) };
      planned.push(this.ledger);
    }
    let receipt:ContextPlanReceipt | undefined;
    const existing = new Set(this.automatic.keys());
    const selected = fitChatContext(planned, this.automatic, inputBudget, this.toolSchema, { query, measurement, baseline, report:value => { receipt = value; } });
    for (const message of this.derived) this.automatic.delete(message);
    this.derived = new Set([...this.automatic.keys()].filter(message => !existing.has(message)));
    this.pool.splice(0, this.pool.length, ...pool);
    messages.splice(0, messages.length, ...planned);
    return { selected, receipt:receipt! };
  }
}
