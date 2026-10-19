import type { ApiConversation } from "./api-chat-store";
import { chatMemorySegments, chatMemoryQuery, memoryMatchScore, memoryTerms, retrieveChatMemory, recentChatDialogue } from "./chat-memory";
import type { RetrievalCandidateV1 } from "../retrieval/retrieval-contracts";
import { validRetrievalServingIdentity } from "../retrieval/retrieval-contracts";
import { memoryExclusionReason } from "./chat-memory-policy";
import type { RetrievalSnapshot } from "../retrieval/retrieval-snapshot";

export interface ChatRetrievalCandidate extends RetrievalCandidateV1 {
  evidenceState?: "recalled" | "materialized" | "selected" | "sent" | "excluded" | "stale" | "missing";
}

export interface ChatRetrievalReceipt {
  schema: "pkm.chat.retrieval/v1";
  chatId: string;
  sessionId?: string;
  model: string;
  query: string;
  candidates: Omit<ChatRetrievalCandidate, "content">[];
  selectedCount: number;
  phase?: "recalled" | "prepared" | "sent";
  warning?: string;
}

export type ChatKnowledgeRetriever = ((query: string, signal: AbortSignal) => Promise<ChatRetrievalCandidate[]>) & {
  sourceIsCurrent?: (candidate:ChatRetrievalCandidate) => boolean;
  refreshSourceValidation?: () => void;
  readSnapshot?: () => RetrievalSnapshot;
};

export interface ChatRetrievalActivity {
  schema: "pkm.chat.retrieval-activity/v1";
  id: string;
  attempts: Array<{ id: string; kind: "memory" | "knowledge"; at: number; durationMs: number; receipt: ChatRetrievalReceipt }>;
  rounds: Array<{ index: number; at: number; inputTokens: number; inputBudget: number; countingMethod: "utf8-byte-estimate"; receipt: ChatRetrievalReceipt }>;
  droppedRounds: number;
}

export function validChatRetrievalActivity(value: unknown, chatId: string): value is ChatRetrievalActivity {
  if (!value || typeof value !== "object") return false;
  const activity = value as ChatRetrievalActivity;
  const count = (value: unknown) => Number.isSafeInteger(value) && Number(value) >= 0;
  return activity.schema === "pkm.chat.retrieval-activity/v1" && typeof activity.id === "string" && /^[a-f0-9-]{36}$/.test(activity.id)
    && count(activity.droppedRounds) && Array.isArray(activity.attempts) && activity.attempts.length <= 32
    && activity.attempts.every(attempt => attempt && typeof attempt.id === "string" && attempt.id.length <= 80 && ["memory", "knowledge"].includes(attempt.kind)
      && Number.isFinite(attempt.at) && Number.isFinite(attempt.durationMs) && attempt.durationMs >= 0 && validChatRetrievalReceipt(attempt.receipt, chatId))
    && Array.isArray(activity.rounds) && activity.rounds.length <= 32 && activity.rounds.every(round => round && count(round.index)
      && Number.isFinite(round.at) && count(round.inputTokens) && count(round.inputBudget) && round.countingMethod === "utf8-byte-estimate"
      && validChatRetrievalReceipt(round.receipt, chatId));
}

export function chatRetrievalReceipt(chat: ApiConversation, query: string, model: string, knowledge: ChatRetrievalCandidate[] = [], selectedIds?: Set<string>,
  phase: NonNullable<ChatRetrievalReceipt["phase"]> = "recalled"): ChatRetrievalReceipt {
  const recalled = selectedIds || new Set(retrieveChatMemory(chat, query).map(segment => segment.id));
  const recent = new Set(recentChatDialogue(chat).map(message => message.id));
  const terms = memoryTerms(chatMemoryQuery(chat, query));
  const memory = chatMemorySegments(chat).map<ChatRetrievalCandidate>(segment => {
    const score = memoryMatchScore(segment.content, terms);
    const history = segment.sourceKind === "dialogue" && recent.has(segment.messageId);
    const excluded = !chat.includeHistory ? "History disabled" : memoryExclusionReason(chat, segment.recordedAt);
    const selected = !excluded && (selectedIds ? selectedIds.has(segment.id) : history || recalled.has(segment.id));
    return { id: segment.id, kind: "memory", label: `${segment.taskId} · ${segment.role} · ${segment.id}`,
      sourceUri: `pkm://chats/${chat.id}/memory/${encodeURIComponent(segment.id)}`,
      sourceRevision: segment.sourceRevision, range: { start: segment.start, end: segment.end, unit: "characters" as const },
      score: history ? 1 : score, method: history ? "rule:recent-history" : "rule:task-aware-recall-v1",
      selected, evidenceState:selected ? "selected" : "excluded",
      reason: excluded || (selected ? history ? "Included in bounded recent dialogue" : "Included matching Chat evidence" : "Outside selected memory budget") };
  }).filter(candidate => candidate.score > 0).sort((first, second) => Number(second.selected) - Number(first.selected) || second.score - first.score);
  const considered = [...memory, ...knowledge], selected = considered.filter(candidate => candidate.selected);
  if (selected.length > 128) throw new Error("Selected retrieval evidence exceeds the 128-candidate receipt boundary.");
  const combined = [...selected, ...considered.filter(candidate => !candidate.selected)].slice(0, 128);
  return { schema: "pkm.chat.retrieval/v1", chatId: chat.id, phase, ...(chat.sessionId ? { sessionId: chat.sessionId } : {}), model: model.slice(0, 512), query: query.slice(0, 8192),
    selectedCount: [...memory, ...knowledge].filter(candidate => candidate.selected).length,
    candidates: combined.map(candidate => ({ id: candidate.id.slice(0, 1024), kind: candidate.kind.slice(0, 64), label: candidate.label.slice(0, 512),
      sourceUri: candidate.sourceUri.slice(0, 2048), method: candidate.method.slice(0, 128), score: Number.isFinite(candidate.score) ? candidate.score : 0,
      ...(typeof candidate.sourceRevision === "string" ? { sourceRevision: candidate.sourceRevision.slice(0, 512) } : {}),
      ...(candidate.level ? { level:candidate.level } : {}),
      ...(candidate.sourceId ? { sourceId:candidate.sourceId } : {}),
      ...(candidate.contentHash ? { contentHash:candidate.contentHash } : {}),
      ...(candidate.parentId ? { parentId:candidate.parentId, parentRevision:candidate.parentRevision, parentContentHash:candidate.parentContentHash } : {}),
      ...(candidate.range ? { range: { ...candidate.range } } : {}),
      ...(candidate.offsetEncoding ? { offsetEncoding:candidate.offsetEncoding } : {}),
      ...(candidate.contextIds ? { contextIds:[...candidate.contextIds] } : {}),
      ...(candidate.serving ? { serving:{ ...candidate.serving } } : {}),
      ...(candidate.scoreComponents ? { scoreComponents: Object.fromEntries(Object.entries(candidate.scoreComponents).filter(([, score]) => Number.isFinite(score)).slice(0, 8)) } : {}),
      evidenceState:candidate.selected ? phase === "sent" ? "sent" : "selected" : candidate.evidenceState || "excluded",
      selected: candidate.selected, reason: candidate.reason.slice(0, 1024) })) };
}

export function validChatRetrievalReceipt(value: unknown, chatId: string): value is ChatRetrievalReceipt {
  const receipt = value as ChatRetrievalReceipt;
  const bounded = (text: unknown, max: number): text is string => typeof text === "string" && text.length <= max;
  return !!receipt && receipt.schema === "pkm.chat.retrieval/v1" && receipt.chatId === chatId && bounded(receipt.model, 512) && bounded(receipt.query, 8192)
    && (receipt.phase === undefined || ["recalled", "prepared", "sent"].includes(receipt.phase))
    && (receipt.sessionId === undefined || bounded(receipt.sessionId, 128)) && (receipt.warning === undefined || bounded(receipt.warning, 1024))
    && Number.isSafeInteger(receipt.selectedCount) && receipt.selectedCount >= 0
    && Array.isArray(receipt.candidates) && receipt.candidates.length <= 128
    && new Set(receipt.candidates.map(candidate => candidate?.id)).size === receipt.candidates.length
    && receipt.candidates.every(candidate => candidate && typeof candidate === "object" && !Array.isArray(candidate) && !("content" in candidate)
      && bounded(candidate.id, 1024) && bounded(candidate.kind, 64) && bounded(candidate.label, 512) && bounded(candidate.sourceUri, 2048)
      && bounded(candidate.method, 128) && bounded(candidate.reason, 1024) && Number.isFinite(candidate.score) && typeof candidate.selected === "boolean"
      && (candidate.evidenceState === undefined || ["recalled", "materialized", "selected", "sent", "excluded", "stale", "missing"].includes(candidate.evidenceState))
      && (candidate.sourceRevision === undefined || bounded(candidate.sourceRevision, 512))
      && (candidate.level === undefined || ["l1-source", "l2-passage"].includes(candidate.level))
      && (candidate.sourceId === undefined || bounded(candidate.sourceId, 1024))
      && (candidate.contentHash === undefined || bounded(candidate.contentHash, 128))
      && (candidate.parentId === undefined || bounded(candidate.parentId, 1024) && bounded(candidate.parentRevision, 512) && bounded(candidate.parentContentHash, 128))
      && (candidate.level !== "l2-passage" || candidate.parentId !== undefined && candidate.range !== undefined)
      && (candidate.serving === undefined || validRetrievalServingIdentity(candidate.serving))
      && (candidate.offsetEncoding === undefined || candidate.offsetEncoding === "utf16" && candidate.range?.unit === "characters")
      && (candidate.contextIds === undefined || Array.isArray(candidate.contextIds) && candidate.contextIds.length <= 16 && candidate.contextIds.every(id => bounded(id, 1024)))
      && (candidate.range === undefined || !!candidate.range && Number.isSafeInteger(candidate.range.start) && Number.isSafeInteger(candidate.range.end)
        && candidate.range.start >= 0 && candidate.range.end > candidate.range.start && ["characters", "bytes", "lines"].includes(candidate.range.unit))
      && (candidate.scoreComponents === undefined || !!candidate.scoreComponents && typeof candidate.scoreComponents === "object" && !Array.isArray(candidate.scoreComponents)
        && Object.keys(candidate.scoreComponents).length <= 8 && Object.values(candidate.scoreComponents).every(score => Number.isFinite(score))));
}