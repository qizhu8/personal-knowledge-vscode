import type { ApiConversation, ChatMessage } from "./api-chat-store";

/** Stored on a reply, never inferred from Chat ordering or matching prompt text. */
export interface PortalTaskLink {
  requestId: string;
  originalReplyId: string;
  retryOfReplyId?: string;
  shareConfirmed?: true;
}

export function validPortalTaskLink(value: unknown): value is PortalTaskLink {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const link = value as Record<string, unknown>;
  const id = (value: unknown) => typeof value === "string" && /^[a-f0-9-]{36}$/.test(value);
  return id(link.requestId) && id(link.originalReplyId)
    && (link.retryOfReplyId === undefined || id(link.retryOfReplyId))
    && (link.shareConfirmed === undefined || link.shareConfirmed === true)
    && (link.retryOfReplyId === undefined || link.shareConfirmed === true);
}

export function portalTaskReplyLink(replyId: string, requestId?: string, retryPredecessor?: ChatMessage): PortalTaskLink | undefined {
  if (requestId) return { requestId, originalReplyId: replyId };
  if (retryPredecessor?.role !== "assistant" || !validPortalTaskLink(retryPredecessor.portalTask)
    || !["failed", "cancelled", "interrupted"].includes(retryPredecessor.status)) return undefined;
  return { ...retryPredecessor.portalTask, retryOfReplyId: retryPredecessor.id, shareConfirmed: true };
}

function publicText(text: string, maximumBytes: number): string {
  let bytes = 0, output = "";
  for (const character of text) {
    bytes += Buffer.byteLength(character, "utf8");
    if (bytes > maximumBytes) break;
    output += character;
  }
  return output;
}

function attempt(message: ChatMessage) {
  return {
    replyId: message.id, attemptId: message.progress?.attemptId, inputId: message.inputId,
    status: message.status, retryOfReplyId: message.portalTask?.retryOfReplyId,
    retryOfAttemptId: message.progress?.retryOf,
    startedAt: message.progress?.startedAt, finishedAt: message.progress?.finishedAt,
    ...(message.error ? { error: publicText(message.error, 240) } : {}),
    uncertainToolEffects: message.status === "cancelled" || message.status === "interrupted"
      || !!message.toolCalls?.some(tool => tool.status === "running" || tool.result?.includes("Execution may already have occurred")),
  };
}

function result(message: ChatMessage) {
  if (message.status === "streaming") return undefined;
  const content = publicText(message.content, 8000);
  return { ...attempt(message), content, truncated: content.length < message.content.length };
}

/** Authorization and the original Portal binding must be checked by the caller before sharing. */
export function portalTaskAttempts(chat: ApiConversation, requestId: string, replyId?: string) {
  if (!/^[a-f0-9-]{36}$/.test(requestId)) throw new Error("Invalid Portal request identity.");
  const originals = chat.messages.filter(message => message.role === "assistant"
    && validPortalTaskLink(message.portalTask) && message.portalTask.requestId === requestId
    && message.portalTask.originalReplyId === message.id && !message.portalTask.retryOfReplyId);
  if (originals.length !== 1) return undefined;
  const original = originals[0];
  if (!original.inputId || !chat.messages.some(message => message.id === original.inputId && message.role === "user" && message.taskId === original.taskId)) return undefined;
  const replies = new Map<string, ChatMessage>([[original.id, original]]);
  for (const message of chat.messages.slice(chat.messages.indexOf(original) + 1)) {
    const link = message.portalTask;
    if (message.role !== "assistant" || !validPortalTaskLink(link) || link.requestId !== requestId
      || link.originalReplyId !== original.id || !link.retryOfReplyId || link.shareConfirmed !== true
      || message.inputId !== original.inputId || message.taskId !== original.taskId || replies.has(message.id)) continue;
    const predecessor = replies.get(link.retryOfReplyId);
    if (!predecessor || !["failed", "cancelled", "interrupted"].includes(predecessor.status)
      || message.progress?.retryOf !== (predecessor.progress?.attemptId || predecessor.id)) continue;
    replies.set(message.id, message);
  }
  const selected = replies.get(replyId || original.id);
  if (!selected) return undefined;
  const all = [...replies.values()], latest = all[all.length - 1];
  return {
    schema: "pkm.portal.task-attempts/v1" as const, chatId: chat.id, requestId,
    visibility: "task-only" as const, original: attempt(original),
    queriedAttempt: attempt(selected), result: result(selected),
    attempts: all.slice(-16).map(attempt), totalAttempts: all.length, omittedAttempts: Math.max(0, all.length - 16),
    latestAttempt: attempt(latest), latestResult: result(latest),
    message: "The original request receipt is unchanged. Related attempts are explicitly confirmed manual response retries, not automatic task replay. No unrelated Chat messages are included.",
  };
}

export type PortalTaskAttempts = NonNullable<ReturnType<typeof portalTaskAttempts>>;
export type PortalTaskAttemptsReader = (chatId: string, requestId: string, replyId?: string) => PortalTaskAttempts | undefined;
