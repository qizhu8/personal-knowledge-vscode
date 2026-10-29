import type { ApiConversation, ChatMessage } from "./api-chat-store";

export interface ChatMemoryGrant {
  kind: "chat" | "workspace" | "group" | "project";
  id: string;
  chatIds: string[];
}
export interface ChatMemoryPolicy {
  version: 1;
  recallDays: number | null;
  includeWorkers: boolean;
  grants: ChatMemoryGrant[];
  excludedChatIds: string[];
  clearedAt?: number;
}

export function memoryPolicy(chat: Pick<ApiConversation, "memoryPolicy">): ChatMemoryPolicy {
  return chat.memoryPolicy || { version:1, recallDays:30, includeWorkers:true, grants:[], excludedChatIds:[] };
}

export function validMemoryPolicy(value: unknown): value is ChatMemoryPolicy {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const policy = value as ChatMemoryPolicy;
  const ids = (value: unknown): value is string[] => Array.isArray(value) && value.length <= 1000
    && value.every(id => typeof id === "string" && /^[a-f0-9-]{36}$/.test(id)) && new Set(value).size === value.length;
  return policy.version === 1 && (policy.recallDays === null || Number.isSafeInteger(policy.recallDays) && policy.recallDays! > 0 && policy.recallDays! <= 36500)
    && typeof policy.includeWorkers === "boolean" && ids(policy.excludedChatIds)
    && (policy.clearedAt === undefined || Number.isSafeInteger(policy.clearedAt) && policy.clearedAt >= 0)
    && Array.isArray(policy.grants) && policy.grants.length <= 100
    && policy.grants.every(grant => grant && ["chat", "workspace", "group", "project"].includes(grant.kind)
      && typeof grant.id === "string" && grant.id.length > 0 && grant.id.length <= 200 && !/[\u0000-\u001f\u007f]/.test(grant.id)
      && ids(grant.chatIds) && grant.chatIds.length > 0)
    && new Set(policy.grants.map(grant => `${grant.kind}:${grant.id}`)).size === policy.grants.length;
}

export function memorySourceTime(chat: ApiConversation, message: ChatMessage, toolTime?: number): number {
  return toolTime ?? (message.recordedAt ? Date.parse(message.recordedAt) :
    message.progress?.finishedAt ?? message.progress?.startedAt ?? Date.parse(chat.createdAt));
}

export function memoryExclusionReason(chat: ApiConversation, at: number, now = Date.now()): string | undefined {
  const policy = memoryPolicy(chat);
  if (policy.excludedChatIds.includes(chat.id)) return "Source Chat is explicitly excluded.";
  if (policy.clearedAt !== undefined && (!Number.isFinite(at) || at <= policy.clearedAt)) return "Excluded by the derived-recall clear boundary; original evidence is retained.";
  if (policy.recallDays === null) return undefined;
  if (!Number.isFinite(at)) return "Original evidence time is unknown; widen the recall window explicitly to inspect it.";
  if (at > now) return "Original evidence has a future timestamp and was not automatically recalled.";
  if (at < now - policy.recallDays * 86400000) return `Outside the ${policy.recallDays}-day recall window; original evidence is retained.`;
  return undefined;
}

export function memoryAgeAllows(chat: ApiConversation, at: number, now = Date.now()): boolean {
  return memoryExclusionReason(chat, at, now) === undefined;
}
