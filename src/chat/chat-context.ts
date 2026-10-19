import type { ApiChatMessage } from "./api-chat-client";
import { estimateInputTokens } from "./api-chat-models";
import { createHash } from "crypto";
import { memoryMatchScore, memoryTerms, toolEvidenceReminder } from "./chat-memory";

export interface AutomaticChatContext {
  ids: string[];
  priority: number;
  groupId?: string;
  refine?: (query?:string) => Array<{ message:ApiChatMessage; reference:AutomaticChatContext }>;
  isCurrent?: () => boolean;
}

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
}

const digest = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");

export class ContextCandidateLimitError extends Error {}

export function fitChatContext(
  messages: ApiChatMessage[],
  automatic: Map<ApiChatMessage, AutomaticChatContext>,
  inputBudget: number,
  toolSchema: ApiChatMessage[] = [],
  options: { maxRefinements?: number; maxCandidates?: number; deadlineMs?: number; now?: () => number; query?:string; report?: (receipt:ContextPlanReceipt) => void } = {},
): Set<string> {
  const now = options.now || Date.now, started = now();
  const maxRefinements = options.maxRefinements ?? 8, maxCandidates = options.maxCandidates ?? 100, deadline = options.deadlineMs ?? 1000;
  if (!Number.isSafeInteger(maxRefinements) || maxRefinements < 0 || !Number.isSafeInteger(maxCandidates) || maxCandidates < 0
    || !Number.isFinite(deadline) || deadline < 0) throw new Error("Invalid context refinement limits.");
  const mandatory = messages.filter(message => !automatic.has(message));
  const mandatoryTokens = estimateInputTokens([...mandatory, ...toolSchema]);
  if (mandatoryTokens > inputBudget) {
    throw new Error("Context budget exceeded by required input, pinned context or active tool results. Reduce required context or increase the model budget.");
  }
  const estimatedBefore = estimateInputTokens([...messages, ...toolSchema]);
  const selected = new Set(mandatory);
  let tokens = mandatoryTokens, refinements = 0, candidates = 0;
  let stopReason: ContextPlanReceipt["stopReason"] = estimatedBefore <= inputBudget ? "fits" : "selected-subset";
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
    const cost = estimateInputTokens(group) - 32;
    if (tokens + cost <= inputBudget) { for (const message of group) selected.add(message); tokens += cost; continue; }
    const reference = automatic.get(group[0])!;
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
      automatic.set(item.message, { ...item.reference, refine:undefined });
    }
    const replacement = fresh.map(item => item.message);
    const position = messages.indexOf(group[0]);
    messages.splice(position, 0, ...replacement);
    for (const item of fresh.sort((a, b) => b.reference.priority - a.reference.priority)) {
      if (item.reference.isCurrent?.() === false) { stopReason = "stale-source"; unresolved.push(...item.reference.ids); continue; }
      const refinedCost = estimateInputTokens([item.message]) - 32;
      if (tokens + refinedCost <= inputBudget) { selected.add(item.message); tokens += refinedCost; }
      else unresolved.push(...item.reference.ids);
    }
  }
  const omittedIds = [...new Set(messages.filter(message => !selected.has(message)).flatMap(message => automatic.get(message)?.ids || []))];
  messages.splice(0, messages.length, ...messages.filter(message => selected.has(message)));
  const ids = new Set(messages.flatMap(message => automatic.get(message)?.ids || []));
  options.report?.({
    schema:"pkm.chat.context-plan/v1", estimatedBefore, estimatedAfter:estimateInputTokens([...messages, ...toolSchema]),
    inputBudget, refinements, stopReason, omittedIds:omittedIds.filter(id => !ids.has(id)), unresolved:[...new Set(unresolved)],
    manifest:messages.map(message => ({ role:message.role, hash:digest(message), referenceIds:automatic.get(message)?.ids || [],
      callIds:message.tool_calls?.map(call => call.id) || (message.tool_call_id ? [message.tool_call_id] : []) })),
    toolSchemaHash:digest(toolSchema),
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

  plan(messages: ApiChatMessage[], inputBudget: number, query: string): { selected:Set<string>; receipt:ContextPlanReceipt } {
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
    if (groups.length > 1 && estimateInputTokens([...pool, ...this.toolSchema]) > inputBudget) {
      const calls = groups.slice(0, -1).flatMap(group => group[0].tool_calls!);
      this.ledger = { role:"system", content:toolEvidenceReminder(calls.map(call => ({ id:call.id, name:call.function.name }))) };
      planned.push(this.ledger);
    }
    let receipt:ContextPlanReceipt | undefined;
    const existing = new Set(this.automatic.keys());
    const selected = fitChatContext(planned, this.automatic, inputBudget, this.toolSchema, { query, report:value => { receipt = value; } });
    for (const message of this.derived) this.automatic.delete(message);
    this.derived = new Set([...this.automatic.keys()].filter(message => !existing.has(message)));
    this.pool.splice(0, this.pool.length, ...pool);
    messages.splice(0, messages.length, ...planned);
    return { selected, receipt:receipt! };
  }
}
