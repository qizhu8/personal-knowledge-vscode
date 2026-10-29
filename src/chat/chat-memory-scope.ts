import { createHash } from "crypto";
import type { ApiChatStore, ApiConversation } from "./api-chat-store";
import type { ChatRetrievalCandidate } from "./chat-retrieval";
import { chatMemoryQuery, chatMemorySegments, retrieveChatMemory } from "./chat-memory";
import { memoryAgeAllows, memoryPolicy } from "./chat-memory-policy";

export interface ScopedMemoryReference {
  candidate: ChatRetrievalCandidate;
  sourceChatId: string;
  segmentId: string;
  isCurrent: () => boolean;
}

function scopedSource(source: ApiConversation, owner: ApiConversation): ApiConversation {
  const policy = memoryPolicy(owner), sourcePolicy = memoryPolicy(source);
  const clearedAt = Math.max(policy.clearedAt || 0, sourcePolicy.clearedAt || 0);
  return { ...source, sessionId:owner.sessionId,
    memoryPolicy:{ ...sourcePolicy, recallDays:policy.recallDays, ...(clearedAt ? { clearedAt } : {}) } };
}

export function scopedMemorySegment(store: ApiChatStore, owner: ApiConversation, identity: string) {
  if (!owner.includeHistory) return undefined;
  const separator = identity.indexOf("@");
  const sourceId = separator < 0 ? owner.id : identity.slice(0, separator);
  const segmentId = separator < 0 ? identity : identity.slice(separator + 1);
  if (sourceId !== owner.id && !store.memorySourceIds(owner).includes(sourceId)) return undefined;
  const source = store.loadMemorySource(owner, sourceId);
  if (!source?.includeHistory) return undefined;
  const scoped = scopedSource(source, owner);
  const messages = scoped.messages.filter(message => segmentId.startsWith(`${message.id}:`));
  const segment = chatMemorySegments({ ...scoped, messages }).find(item => item.id === segmentId && memoryAgeAllows(scoped, item.recordedAt));
  return segment && { ...segment, id:identity, sourceChatId:sourceId };
}

export function recallScopedChatMemory(store: ApiChatStore, owner: ApiConversation, query: string):
  { references:ScopedMemoryReference[]; warnings:string[] } {
  if (!owner.includeHistory) return { references:[], warnings:[] };
  const ids = store.memorySourceIds(owner);
  if (ids.length > 100) throw new Error("Memory scope exceeds 100 source Chats. Narrow the explicit grants or worker scope; no sources were silently omitted.");
  const warnings:string[] = [];
  const pool = ids.flatMap(id => {
    const source = store.loadMemorySource(owner, id);
    if (!source?.includeHistory) {
      warnings.push(`Memory source ${id} is missing, in Trash, or has History disabled.`);
      return [];
    }
    return retrieveChatMemory(scopedSource(source, owner), chatMemoryQuery(owner, query)).map(segment => ({ source, segment }));
  }).sort((first, second) => second.segment.score - first.segment.score || second.segment.recordedAt - first.segment.recordedAt);
  const seen = new Set<string>(), references:ScopedMemoryReference[] = [];
  for (const { source, segment } of pool) {
    if (references.length >= 4) break;
    if (seen.has(segment.evidenceHash)) continue;
    seen.add(segment.evidenceHash);
    references.push({
      sourceChatId:source.id, segmentId:segment.id,
      candidate:{ id:`${source.id}@${segment.id}`, kind:"memory", label:`${source.title} · ${segment.taskId}`,
        sourceId:`pkm://chats/${source.id}`, sourceUri:`pkm://chats/${source.id}/memory/${encodeURIComponent(segment.id)}`,
        sourceRevision:segment.sourceRevision, contentHash:createHash("sha256").update(segment.content).digest("hex"),
        range:{ start:segment.start, end:segment.end, unit:"characters" }, offsetEncoding:"utf16",
        score:segment.score, method:"rule:authorized-chat-memory-v1", selected:false,
        reason:"Authorized source Chat evidence; untrusted and subject to the consumer's recall window.", content:segment.content },
      isCurrent:() => {
        const currentOwner = store.loadMemorySource(owner, owner.id);
        return !!currentOwner && !!scopedMemorySegment(store, currentOwner, `${source.id}@${segment.id}`);
      },
    });
  }
  return { references, warnings };
}
