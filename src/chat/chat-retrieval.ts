import type { ApiConversation } from "./api-chat-store";
import { chatMemorySegments, memoryMatchScore, memoryTerms, retrieveChatMemory } from "./chat-memory";

export interface ChatRetrievalCandidate {
  id: string;
  kind: string;
  label: string;
  sourceUri: string;
  method: string;
  score: number;
  scoreComponents?: Record<string, number>;
  selected: boolean;
  reason: string;
  content?: string;
}

export interface ChatRetrievalReceipt {
  schema: "pkm.chat.retrieval/v1";
  chatId: string;
  sessionId?: string;
  model: string;
  query: string;
  candidates: Omit<ChatRetrievalCandidate, "content">[];
  selectedCount: number;
  warning?: string;
}

export type ChatKnowledgeRetriever = (query: string, signal: AbortSignal) => Promise<ChatRetrievalCandidate[]>;

export function chatRetrievalReceipt(chat: ApiConversation, query: string, model: string, knowledge: ChatRetrievalCandidate[] = []): ChatRetrievalReceipt {
  const recalled = new Set(retrieveChatMemory(chat, query).map(segment => segment.id));
  const recent = new Set(chat.includeHistory ? chat.messages.slice(-20).filter(message => message.status === "complete").map(message => message.id) : []);
  const terms = memoryTerms(query);
  const memory: ChatRetrievalCandidate[] = chatMemorySegments(chat).map(segment => {
    const score = memoryMatchScore(segment.content, terms);
    const history = recent.has(segment.messageId);
    return { id: segment.id, kind: "memory", label: `${segment.taskId} · ${segment.role} · ${segment.id}`,
      sourceUri: `pkm://chats/${chat.id}/memory/${encodeURIComponent(segment.id)}`,
      score: history ? 1 : score, method: history ? "rule:recent-history" : "rule:lexical-overlap",
      selected: history || recalled.has(segment.id), reason: history ? "Included in recent conversation history" : recalled.has(segment.id) ? "Top matching older Chat segment" : chat.includeHistory ? "Outside selected memory budget" : "History disabled" };
  }).filter(candidate => candidate.score > 0).sort((first, second) => Number(second.selected) - Number(first.selected) || second.score - first.score);
  const combined: ChatRetrievalCandidate[] = [];
  for (let index = 0; index < Math.max(memory.length, knowledge.length) && combined.length < 20; index++) {
    if (memory[index]) combined.push(memory[index]);
    if (knowledge[index] && combined.length < 20) combined.push(knowledge[index]);
  }
  return { schema: "pkm.chat.retrieval/v1", chatId: chat.id, sessionId: chat.sessionId, model: model.slice(0, 512), query: query.slice(0, 8192),
    selectedCount: [...memory, ...knowledge].filter(candidate => candidate.selected).length,
    candidates: combined.map(candidate => ({ id: candidate.id.slice(0, 1024), kind: candidate.kind.slice(0, 64), label: candidate.label.slice(0, 512),
      sourceUri: candidate.sourceUri.slice(0, 2048), method: candidate.method.slice(0, 128), score: Number.isFinite(candidate.score) ? candidate.score : 0,
      ...(candidate.scoreComponents ? { scoreComponents: Object.fromEntries(Object.entries(candidate.scoreComponents).filter(([, score]) => Number.isFinite(score)).slice(0, 8)) } : {}),
      selected: candidate.selected, reason: candidate.reason.slice(0, 1024) })) };
}

export function validChatRetrievalReceipt(value: unknown, chatId: string): value is ChatRetrievalReceipt {
  const receipt = value as ChatRetrievalReceipt;
  const bounded = (text: unknown, max: number): text is string => typeof text === "string" && text.length <= max;
  return !!receipt && receipt.schema === "pkm.chat.retrieval/v1" && receipt.chatId === chatId && bounded(receipt.model, 512) && bounded(receipt.query, 8192)
    && (receipt.sessionId === undefined || bounded(receipt.sessionId, 128)) && (receipt.warning === undefined || bounded(receipt.warning, 1024))
    && Number.isSafeInteger(receipt.selectedCount) && receipt.selectedCount >= 0
    && Array.isArray(receipt.candidates) && receipt.candidates.length <= 20 && receipt.candidates.every(candidate => candidate && typeof candidate === "object" && !Array.isArray(candidate) && !("content" in candidate)
      && bounded(candidate.id, 1024) && bounded(candidate.kind, 64) && bounded(candidate.label, 512) && bounded(candidate.sourceUri, 2048)
      && bounded(candidate.method, 128) && bounded(candidate.reason, 1024) && Number.isFinite(candidate.score) && typeof candidate.selected === "boolean"
      && (candidate.scoreComponents === undefined || !!candidate.scoreComponents && typeof candidate.scoreComponents === "object" && !Array.isArray(candidate.scoreComponents)
        && Object.keys(candidate.scoreComponents).length <= 8 && Object.values(candidate.scoreComponents).every(score => Number.isFinite(score))));
}