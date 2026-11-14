import type { MemoryRecord } from "./memory-contracts.js";

/** Epochs must change on edits, History/grant/Trash changes and memory lifecycle changes. */
export interface MemoryContextBinding {
  actorId: string;
  namespace: string;
  chatId: string;
  historyRevision: string;
  memoryRevision: string;
  /** Authoritative explicit-record scope; defaults to namespace, never inferred from paths. */
  memoryScope?: string;
}
export interface MemoryHarnessReport {
  schema: string; source: string; taskId: string; kind: string; status?: string;
  goal?: string; summary?: string; reason?: string; constraints?: string[]; acceptance?: string[]; openQuestions?: string[];
  binding?: { recipeRunId?: string; recipeStageId?: string; stepId?: string };
  planning?: { possibilities?: Array<{ status: string; label?: string; summary?: string; reason?: string }> };
}
export interface MemoryContextMessage {
  id: string; role: "user" | "assistant"; status: string; content: string; taskId?: string;
  recordedAt?: string; workerEventIds?: string[]; harnessReports?: MemoryHarnessReport[];
  progress?: { finishedAt?: number; startedAt?: number };
  toolCalls?: Array<{ id: string; name: string; status: string; arguments: string; result?: string; finishedAt?: number; startedAt?: number }>;
}
export interface MemoryContextPolicy {
  version: 1; recallDays: number | null; includeWorkers: boolean;
  grants: Array<{ kind: "chat" | "workspace" | "group" | "project"; id: string; chatIds: string[] }>;
  excludedChatIds: string[]; clearedAt?: number;
}
export interface MemoryContextChat {
  id: string; actorId: string; namespace: string; title: string; createdAt: string; includeHistory: boolean;
  sessionId?: string; messages: MemoryContextMessage[]; memoryPolicy?: MemoryContextPolicy;
  memoryTasks?: Array<{ id: string; title: string; createdAt: string }>;
}
export interface MemoryContextSource {
  id: string; kind: "explicit" | "chat"; namespace: string; chatId?: string;
  revision: string; contentHash: string;
  start: number; end: number; unit: "utf16";
  /** Exact original explicit-memory evidence handles, not executable paths. */
  references?: MemoryRecord["sources"];
}
export interface MemoryComputedBlock {
  kind: "focus-topic" | "earlier-message" | "related-topic" | "index";
  piece: string; text: string; sources: MemoryContextSource[];
}
export type MemoryAvailability<T> = ({ status: "available" } & T) | { status: "unavailable"; reason: string };
export interface MemoryContextSnapshot {
  records: MemoryRecord[];
  chats: MemoryContextChat[];
  /** Host-authorized membership snapshot, not inferred from arbitrary supplied chat rows. */
  authorizedChatIds?: string[];
}
export interface MemoryPromptMessage {
  role: "system" | "user" | "assistant" | "tool"; content: string;
  tool_calls?: unknown[]; tool_call_id?: string;
}
export interface MemoryContextRequest {
  binding: MemoryContextBinding; query: string; inputBudget: number;
  requiredMessages: MemoryPromptMessage[]; toolSchema?: unknown; signal?: AbortSignal;
}
export interface MemoryContextDependencies {
  /** Synchronous admission fence, also called AFTER every awaited callback. */
  readBinding(): MemoryContextBinding | undefined;
  readMemory(input: { binding: MemoryContextBinding; query: string; signal?: AbortSignal }): Promise<MemoryAvailability<MemoryContextSnapshot>>;
  retrieve?(input: {
    binding: MemoryContextBinding; query: string; chats: MemoryContextChat[];
    sources: MemoryContextSource[]; budgetChars: number; signal?: AbortSignal;
  }): Promise<MemoryAvailability<{ blocks: MemoryComputedBlock[] }>>;
  /** Full final prompt AND tool schema count. Never divide bytes by four and call it exact. */
  countTokens?(messages: MemoryPromptMessage[], toolSchema: unknown): number;
  now?(): number;
}
export type MemoryContextResult =
  | { status: "ready"; messages: MemoryPromptMessage[]; inputTokens: number;
      countingMethod: "injected-exact" | "utf8-byte-upper-bound"; sources: MemoryContextSource[];
      omittedIds: string[]; truncatedIds: string[]; promptHash: string;
      /** Call immediately before model admission; rejects mutated prompt or stale actor/source epochs. */
      assertCurrent(): void }
  | { status: "unavailable" | "stale" | "budget-exceeded"; reason: string };
