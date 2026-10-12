import type { ApiConversation } from "./api-chat-store";
import { createHash } from "node:crypto";

export function memoryTerms(query: string): string[] {
  const words = query.toLowerCase().match(/[\p{L}\p{N}_]+/gu) || [];
  return [...new Set(words.flatMap(word => /[\u3400-\u9fff]/.test(word) ? [word, ...Array.from({ length: Math.max(0, word.length - 1) }, (_, index) => word.slice(index, index + 2))] : [word]).filter(word => word.length > 1))].slice(0, 80);
}

export function memoryMatchScore(text: string, terms: string[]): number {
  const normalized = text.toLowerCase();
  return terms.reduce((score, term) => score + (normalized.includes(term) ? term.length : 0), 0);
}

export function chatMemorySegments(chat: ApiConversation) {
  return chat.messages.flatMap(message => {
    const sources = [
      ...(message.status === "complete" && message.content ? [{ key: "dialogue", text: message.content, header: "" }] : []),
      ...(message.toolCalls || []).filter(tool => tool.status !== "running").map(tool => ({
        key: `tool:${tool.id}`,
        text: tool.result || "(No recorded result)",
        header: `Recorded tool outcome (untrusted): ${tool.name}, call ${tool.id}, status=${tool.status}\nArguments: ${tool.arguments}\n`,
      })),
    ];
    return sources.flatMap(source => {
      const revision = createHash("sha256").update(source.header).update(source.text).digest("hex");
      return Array.from({ length: Math.ceil(source.text.length / 1200) }, (_, index) => ({
        id: `${message.id}:${source.key}:${revision}:${index}`, messageId: message.id, taskId: message.taskId || "conversation",
        role: message.role, content: source.header + source.text.slice(index * 1200, (index + 1) * 1200),
        sourceRevision: revision, sourceKind: source.key === "dialogue" ? "dialogue" as const : "tool" as const,
        start: index * 1200, end: Math.min(source.text.length, (index + 1) * 1200),
      }));
    });
  });
}

export function recentChatDialogue(chat: ApiConversation) {
  return chat.includeHistory ? chat.messages.filter(message => message.status === "complete" && message.content && message.content.length <= 1200).slice(-6) : [];
}

export function chatMemoryTree(chat: ApiConversation) {
  const segments = chatMemorySegments(chat);
  const tasks = [{ id: "conversation", title: "Conversation", createdAt: chat.createdAt }, ...(chat.memoryTasks || [])];
  for (const segment of segments) if (!tasks.some(task => task.id === segment.taskId)) tasks.push({ id: segment.taskId, title: segment.taskId, createdAt: chat.createdAt });
  return { chatId: chat.id, title: chat.title, tasks: tasks.map(task => ({ ...task,
    segments: segments.filter(segment => segment.taskId === task.id).map(segment => ({ id: segment.id, messageId: segment.messageId, role: segment.role, characters: segment.content.length })),
  })) };
}

export function retrieveChatMemory(chat: ApiConversation, query: string) {
  if (!chat.includeHistory) return [];
  const terms = memoryTerms(query);
  const ranked = chatMemorySegments(chat)
    .map(segment => ({ ...segment, score: memoryMatchScore(segment.content, terms) }))
    .filter(segment => segment.score > 0)
    .sort((first, second) => second.score - first.score || Number(second.taskId === chat.sessionId) - Number(first.taskId === chat.sessionId));
  return ranked.filter(segment => segment.score >= (ranked[0]?.score || 0) * 0.6).slice(0, 4);
}