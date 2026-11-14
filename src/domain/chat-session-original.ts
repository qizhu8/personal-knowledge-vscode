// Exact original history paging reducer with minimal structural types; regenerate with capture-chat-sessions.mjs.
export interface ChatMessage { id: string; role?: string; content?: string; status?: string; }
export interface ApiConversation { version: 1; id: string; title: string; createdAt: string; updatedAt: string; messages: ChatMessage[]; includeHistory: boolean; context: unknown[]; }
export type ApiChatStatus = "running" | "idle" | "completed" | "new-result" | "awaiting-input" | "awaiting-result" | "paused" | "failed" | "stopped";

export function chatHistoryPage(chat: ApiConversation, beforeId?: string) {
  const end = beforeId === undefined ? chat.messages.length : chat.messages.findIndex(message => message.id === beforeId);
  if (end < 0) throw new Error("The Chat history cursor is stale. Refresh the conversation before loading older messages.");
  let start = end;
  let bytes = 0;
  while (start > 0 && end - start < 20) {
    const next = Buffer.byteLength(JSON.stringify(chat.messages[start - 1]), "utf8");
    if (start < end && bytes + next > 512 * 1024) break;
    bytes += next; start--;
  }
  return { messages: chat.messages.slice(start, end), start, total: chat.messages.length };
}
