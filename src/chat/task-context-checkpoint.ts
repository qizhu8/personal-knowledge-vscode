import { createHash, randomUUID } from "crypto";
import type { ApiConversation, ChatMessage } from "./api-chat-store";
import type { HarnessReport } from "./chat-harness-records";

export interface TaskContextCheckpoint {
  schema: "pkm.chat.task-context-checkpoint/v1";
  id: string;
  chatId: string;
  taskId: string;
  approvedAt: string;
  summary: string;
  sourceInputIds: string[];
  sourceDigest: string;
  previousTaskReportId: string | null;
  revokedAt?: string;
}

export function currentTaskReport(chat: ApiConversation): HarnessReport | undefined {
  if (!chat.sessionId) return undefined;
  return [...chat.messages].reverse().flatMap(message =>
    message.taskId === chat.sessionId ? [...message.harnessReports || []].reverse() : [])
    .find(report => report.kind === "task" && report.taskId === chat.sessionId && report.schema === "pkm.chat.harness-report/v1" && report.source === "agent-report");
}

export function taskContextInputs(chat: ApiConversation): ChatMessage[] {
  return chat.messages.filter(message => !!chat.sessionId && message.taskId === chat.sessionId
    && message.role === "user" && !message.workerEventIds?.length && !message.portalReview);
}

function digest(inputs: ChatMessage[]): string {
  return createHash("sha256").update(JSON.stringify(inputs.map(message =>
    [message.id, message.taskId, message.content, message.portalSource || null]))).digest("hex");
}

export function validTaskContextCheckpoint(value: unknown, chatId: string): value is TaskContextCheckpoint {
  if (!value || typeof value !== "object") return false;
  const item = value as TaskContextCheckpoint;
  return item.schema === "pkm.chat.task-context-checkpoint/v1" && item.chatId === chatId
    && typeof item.id === "string" && /^[a-f0-9-]{36}$/.test(item.id)
    && typeof item.taskId === "string" && /^agent_session_[a-f0-9]{32}$/.test(item.taskId)
    && typeof item.summary === "string" && !!item.summary.trim() && item.summary.length <= 4000
    && typeof item.approvedAt === "string" && Number.isFinite(Date.parse(item.approvedAt))
    && typeof item.sourceDigest === "string" && /^[a-f0-9]{64}$/.test(item.sourceDigest)
    && (item.previousTaskReportId === null || typeof item.previousTaskReportId === "string" && item.previousTaskReportId.length > 0 && item.previousTaskReportId.length <= 200)
    && Array.isArray(item.sourceInputIds) && item.sourceInputIds.length > 0 && item.sourceInputIds.length <= 10000
    && item.sourceInputIds.every(id => typeof id === "string" && id.length > 0 && id.length <= 200)
    && new Set(item.sourceInputIds).size === item.sourceInputIds.length
    && (item.revokedAt === undefined || typeof item.revokedAt === "string" && Number.isFinite(Date.parse(item.revokedAt)));
}

export function activeTaskContextCheckpoint(chat: ApiConversation): TaskContextCheckpoint | undefined {
  if (!chat.includeHistory || !chat.sessionId) return undefined;
  const item = [...chat.taskContextCheckpoints || []].reverse().find(checkpoint => checkpoint.taskId === chat.sessionId);
  if (!item || item.revokedAt) return undefined;
  if (!validTaskContextCheckpoint(item, chat.id)) throw new Error("The Task context checkpoint is invalid.");
  const inputs = taskContextInputs(chat).slice(0, item.sourceInputIds.length);
  if (JSON.stringify(inputs.map(input => input.id)) !== JSON.stringify(item.sourceInputIds) || digest(inputs) !== item.sourceDigest) {
    throw new Error("Checkpoint source inputs changed or are missing. Revoke or review the checkpoint before continuing.");
  }
  return item;
}

export function createTaskContextCheckpoint(chat: ApiConversation, summary: string): TaskContextCheckpoint {
  if (!chat.includeHistory || !chat.sessionId) throw new Error("An active Task with History enabled is required.");
  if ((chat.taskContextCheckpoints?.length || 0) >= 128) throw new Error("The Chat reached its 128 checkpoint review limit.");
  const inputs = taskContextInputs(chat);
  const item: TaskContextCheckpoint = {
    schema: "pkm.chat.task-context-checkpoint/v1", id: randomUUID(), chatId: chat.id, taskId: chat.sessionId,
    approvedAt: new Date().toISOString(), summary, sourceInputIds: inputs.map(input => input.id), sourceDigest: digest(inputs),
    previousTaskReportId: currentTaskReport(chat)?.id || null,
  };
  if (!validTaskContextCheckpoint(item, chat.id)) throw new Error("Review 1-10,000 Task inputs and provide a nonempty constraint summary of at most 4,000 characters.");
  return item;
}

export function readTaskContextInput(chat: ApiConversation, id: unknown, start: unknown = 0, end?: unknown, hash?: unknown): string {
  if (!chat.includeHistory) throw new Error("History is off; earlier Task inputs are unavailable.");
  const input = taskContextInputs(chat).find(message => message.id === id);
  if (!input) throw new Error("The requested user input is not in the current Task.");
  const contentHash = createHash("sha256").update(input.content).digest("hex");
  const exact = end !== undefined || hash !== undefined;
  if (!Number.isSafeInteger(start) || Number(start) < 0
    || exact && (hash !== contentHash || !Number.isSafeInteger(end) || Number(end) <= Number(start) || Number(end) > input.content.length || Number(end) - Number(start) > 4000)
    || !exact && start !== 0) throw new Error("Exact Task input reads require the current inputHash and a valid half-open UTF-16 range up to 4,000 characters.");
  const finish = exact ? Number(end) : Math.min(4000, input.content.length);
  return JSON.stringify({ inputId: input.id, taskId: input.taskId, contentHash, totalCharacters: input.content.length,
    range: { start, end: finish, unit: "characters", offsetEncoding: "utf16" }, exact,
    truncated: !exact && finish < input.content.length, content: input.content.slice(Number(start), finish) });
}
