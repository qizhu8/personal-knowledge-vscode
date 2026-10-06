import type { ApiConversation } from "./api-chat-store";

export function memoryTerms(query: string): string[] {
  const words = query.toLowerCase().match(/[\p{L}\p{N}_]+/gu) || [];
  return [...new Set(words.flatMap(word => /[\u3400-\u9fff]/.test(word) ? [word, ...Array.from({ length: Math.max(0, word.length - 1) }, (_, index) => word.slice(index, index + 2))] : [word]).filter(word => word.length > 1))].slice(0, 80);
}

export function memoryMatchScore(text: string, terms: string[]): number {
  const normalized = text.toLowerCase();
  return terms.reduce((score, term) => score + (normalized.includes(term) ? term.length : 0), 0);
}

export function chatMemorySegments(chat: ApiConversation) {
  return chat.messages.filter(message => message.status === "complete").flatMap(message => {
    const text = message.content + (message.toolCalls?.length ? `\nRecorded tool results (untrusted):\n${JSON.stringify(message.toolCalls.filter(tool => tool.status === "complete"))}` : "");
    return Array.from({ length: Math.ceil(text.length / 1200) }, (_, index) => ({
      id: `${message.id}:${index}`, messageId: message.id, taskId: message.taskId || "conversation",
      role: message.role, content: text.slice(index * 1200, (index + 1) * 1200),
    }));
  });
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
  const recent = new Set(chat.messages.slice(-20).map(message => message.id));
  const terms = memoryTerms(query);
  return chatMemorySegments(chat).filter(segment => !recent.has(segment.messageId))
    .map(segment => ({ ...segment, score: memoryMatchScore(segment.content, terms) }))
    .filter(segment => segment.score > 0)
    .sort((first, second) => second.score - first.score || Number(second.taskId === chat.sessionId) - Number(first.taskId === chat.sessionId))
    .slice(0, 4);
}