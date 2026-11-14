import * as fs from "fs";
import * as path from "path";
import { createHash } from "crypto";
import type { ApiConversation, ChatDelegation, ChatMessage } from "./api-chat-store";
import { ChatHistoryStorage, type StoredChat } from "./chat-history-storage";

export interface WorkerResultVersion {
  schema: "pkm.chat.worker-version/v1";
  managerChatId: string;
  managerNamespace: string;
  chatId: string;
  namespace: string;
  receiptId: string;
  activityId: string;
  attemptId: string;
  messageId: string;
  status: string;
  sha256: string;
}
export interface WorkerEvidenceState {
  status: "unchanged" | "stale" | "unavailable" | "unchecked";
  workers: Array<{ version?: WorkerResultVersion; status: WorkerEvidenceState["status"]; reason?: string }>;
}
export type WorkerVersionReader = (version: WorkerResultVersion) => WorkerResultVersion;

export function workerHandoff(manager: ApiConversation, record: ChatDelegation, target: ApiConversation,
  requireReady: unknown = false, expectedSha256?: unknown, archived = false) {
  if (typeof requireReady !== "boolean" || expectedSha256 !== undefined
    && (typeof expectedSha256 !== "string" || !/^[a-f0-9]{64}$/.test(expectedSha256))) {
    throw new Error("Handoff requires a boolean requireReady and an optional exact SHA-256 from the earlier handoff.");
  }
  const version = workerResultVersion(manager, record, target, archived);
  const reply = delegationReply(record, target, archived);
  const goal = target.workGoal?.attemptInputId === reply?.inputId ? target.workGoal : undefined;
  const ready = record.status === "complete" && version?.status === "complete"
    && reply?.status === "complete" && (!goal || goal.status === "resolved");
  if (requireReady && !ready) throw new Error("Worker handoff is not ready for final validation. Preserve the receipt and wait for its completion event; do not poll or rerun the worker.");
  if (expectedSha256 !== undefined && (!ready || version?.sha256 !== expectedSha256)) throw new Error("Worker handoff version changed. Read the new ready handoff and validate that exact version.");
  return { ready, workerVersion: version,
    scope: goal?.contract?.scope, nonGoals: goal?.contract?.nonGoals,
    note: "Readiness pins the saved worker result, not semantic acceptance or current workspace bytes. Final artifact validation is still required." };
}

export function citedWorkerEvidence(chat: ApiConversation, message: ChatMessage): NonNullable<ChatMessage["toolCalls"]> {
  const report = [...message.harnessReports || []].reverse().find(report => report.kind === "validation");
  const ids = new Set([...(report?.evidenceCallIds || []),
    ...(chat.workGoal && chat.workGoal.attemptInputId === message.inputId ? chat.workGoal.acceptance.filter(item => item.verified)
      .flatMap(item => item.evidenceCallIds) : [])]);
  return chat.messages.filter(source => source.role === "assistant" && source.taskId === message.taskId)
    .flatMap(source => source.toolCalls || []).filter(call => ids.has(call.id));
}

export function delegationReply(record: ChatDelegation, target: ApiConversation, archived = false): ChatMessage | undefined {
  if (target.id !== record.chatId) throw new Error("Worker result Chat identity conflicts with its receipt.");
  const activity = target.workerActivity;
  if (archived && activity?.receiptId !== record.id) throw new Error("Archived worker identity conflicts with its receipt.");
  if (activity?.receiptId === record.id) {
    if (record.activityId && record.activityId !== activity.id) throw new Error("Worker result belongs to a different activity.");
    record.attemptId = activity.attemptId || record.attemptId;
  }
  if (record.attemptId) {
    const matches = target.messages.filter(message => message.role === "assistant" && message.progress?.attemptId === record.attemptId);
    if (matches.length > 1) throw new Error("Worker result attempt is ambiguous.");
    if (!matches.length && (archived || target.progress?.attemptId !== record.attemptId || target.progress.status === "complete")) {
      throw new Error("Worker result attempt is unavailable.");
    }
    return matches[0];
  }
  if (archived) return [...target.messages].reverse().find(message => message.role === "assistant");
  let index = target.messages.length - 1;
  while (index >= 0 && target.messages[index].delegationId !== record.id) index--;
  const answer = index < 0 ? undefined : target.messages[index + 1];
  return answer?.role === "assistant" ? answer : undefined;
}

export function workerResultVersion(manager: ApiConversation, record: ChatDelegation, target: ApiConversation,
  archived = false): WorkerResultVersion | undefined {
  const reply = delegationReply(record, target, archived);
  if (!reply || !record.activityId || !record.attemptId || !manager.workspaceNamespace || !target.workspaceNamespace) return undefined;
  const activity = target.workerActivity;
  const current = activity?.receiptId === record.id;
  if (current && activity.managerChatId !== manager.id) throw new Error("Worker result belongs to a different manager.");
  let status: string = reply.status;
  if (current) {
    const state = activity.state;
    if (["failed", "interrupted", "cancelled"].includes(state)) status = state;
    else if (target.progress?.status === "failed" || target.progress?.status === "cancelled") status = target.progress.status;
    else if (target.workerState?.stopped) status = "cancelled";
    else if (target.progress?.status === "running" || target.workerState?.sleeping
      || ["pending", "running", "waiting-input"].includes(state)) status = "running";
  }
  return {
    schema:"pkm.chat.worker-version/v1", managerChatId:manager.id, managerNamespace:manager.workspaceNamespace,
    chatId:target.id, namespace:target.workspaceNamespace, receiptId:record.id, activityId:record.activityId,
    attemptId:record.attemptId, messageId:reply.id, status,
    sha256:createHash("sha256").update(JSON.stringify([reply.content, reply.error, reply.toolCalls, reply.harnessReports,
      ...(target.workGoal && target.workGoal.attemptInputId === reply.inputId
        ? [{ workGoalId:target.workGoal.id, acceptance:target.workGoal.acceptance }] : [])])).digest("hex"),
  };
}

function validVersion(value: unknown): value is WorkerResultVersion {
  if (!value || typeof value !== "object") return false;
  const v = value as WorkerResultVersion;
  return v.schema === "pkm.chat.worker-version/v1"
    && [v.managerChatId, v.chatId, v.receiptId, v.activityId, v.attemptId, v.messageId].every(id => typeof id === "string" && /^[a-f0-9-]{36}$/.test(id))
    && [v.managerNamespace, v.namespace].every(id => typeof id === "string" && /^[a-f0-9]{16}$/.test(id))
    && typeof v.status === "string" && /^[a-f0-9]{64}$/.test(v.sha256);
}

export function readWorkerResultVersion(directory: string, version: WorkerResultVersion): WorkerResultVersion {
  const history = new ChatHistoryStorage(directory);
  const ancestors = new Map<string, ApiConversation>();
  const active = new Set<string>();
  const checked = new Map<string, WorkerResultVersion>();
  let visited = 0;
  const inspect: WorkerVersionReader = version => {
    if (!validVersion(version)) throw new Error("Invalid worker evidence version.");
    const key = JSON.stringify(version);
    if (active.has(key)) throw new Error("Cyclic worker evidence chain.");
    const prior = checked.get(key);
    if (prior) return prior;
    if (active.size >= 32) throw new Error("Worker evidence chain exceeds the 32-level verification limit.");
    if (++visited > 256) throw new Error("Worker evidence chain exceeds the 256-result verification limit.");
    active.add(key);
    try {
      const current = inspectResult(version);
      checked.set(key, current);
      return current;
    } finally { active.delete(key); }
  };
  const load = (namespace: string, id: string) => {
    const stored = JSON.parse(fs.readFileSync(path.join(directory, "api-chats", namespace, `${id}.json`), "utf8")) as StoredChat;
    const chat = history.unpack(stored);
    if (chat.id !== id || chat.workspaceNamespace !== namespace) throw new Error("Worker evidence store identity mismatch.");
    return chat;
  };
  const inspectResult = (version: WorkerResultVersion): WorkerResultVersion => {
    const manager = ancestors.get(`${version.managerNamespace}/${version.managerChatId}`)
      || load(version.managerNamespace, version.managerChatId);
    const records = manager.messages.flatMap(message => message.delegations || []).filter(record => record.id === version.receiptId);
    if (records.length !== 1 || records[0].chatId !== version.chatId || records[0].activityId !== version.activityId) {
      throw new Error("Worker evidence is not owned by its recorded manager receipt.");
    }
    let archiveText: string | undefined;
    try {
      archiveText = fs.readFileSync(path.join(directory, "api-chat-worker-results", `${version.receiptId}.json`), "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    let target: ApiConversation;
    if (archiveText !== undefined) {
      const archive = JSON.parse(archiveText);
      if (archive.schema !== "pkm.chat.worker-result/v1" || archive.receiptId !== version.receiptId
        || archive.managerChatId !== manager.id) throw new Error("Invalid worker evidence archive.");
      target = history.unpack(archive.chat);
    } else {
      if (records[0].archived) throw new Error("Worker evidence archive is unavailable.");
      target = load(version.namespace, version.chatId);
    }
    const current = workerResultVersion(manager, { ...records[0] }, target, archiveText !== undefined);
    if (!current) throw new Error("The current worker result has no verifiable attempt version.");
    const response = target.messages.find(message => message.id === current.messageId);
    if (!response) throw new Error("Worker evidence response is unavailable.");
    const targetKey = `${target.workspaceNamespace}/${target.id}`, previous = ancestors.get(targetKey);
    ancestors.set(targetKey, target);
    try {
      assertCurrentWorkerEvidence(citedWorkerEvidence(target, response), target.id, inspect);
    } catch (error) {
      throw new Error(`Worker evidence descendant of ${current.receiptId}: ${error instanceof Error ? error.message : String(error)}`);
    } finally {
      if (previous) ancestors.set(targetKey, previous);
      else ancestors.delete(targetKey);
    }
    return current;
  };
  return inspect(version);
}

export function workerEvidenceState(calls: NonNullable<ChatMessage["toolCalls"]>, managerChatId: string,
  read?: WorkerVersionReader): WorkerEvidenceState | undefined {
  const workers: WorkerEvidenceState["workers"] = [];
  for (const call of calls.filter(call => call.name === "read_chat_result")) {
    try {
      if (call.status !== "complete" || typeof call.result !== "string") throw new Error("Worker evidence requires a successful versioned result read.");
      const result: unknown = JSON.parse(call.result);
      const version = result && typeof result === "object" && "workerVersion" in result ? result.workerVersion : undefined;
      if (!validVersion(version) || version.managerChatId !== managerChatId) throw new Error("Worker evidence lacks a Host version owned by this manager; read the current result again.");
      if (version.status !== "complete") throw new Error("The cited worker result is not complete.");
      const current = read?.(version);
      const unchanged = current && JSON.stringify(current) === JSON.stringify(version);
      workers.push({ version, status:!read ? "unchecked" : unchanged ? "unchanged" : "stale",
        ...(!read ? { reason:"Worker result has not been rechecked on this Host." }
          : !unchanged ? { reason:"Worker activity, attempt or saved result changed; read and validate the current result again." } : {}) });
    } catch (error) {
      workers.push({ status:"unavailable", reason:error instanceof Error ? error.message : String(error) });
    }
  }
  if (!workers.length) return undefined;
  return { status:workers.some(worker => worker.status === "unavailable") ? "unavailable"
    : workers.some(worker => worker.status === "stale") ? "stale"
      : workers.some(worker => worker.status === "unchecked") ? "unchecked" : "unchanged", workers };
}

export function verifyWorkerEvidenceState(state: WorkerEvidenceState | undefined, read: WorkerVersionReader): WorkerEvidenceState | undefined {
  if (!state) return undefined;
  const workers = state.workers.map(worker => {
    if (!worker.version) return worker;
    try {
      const current = read(worker.version);
      return JSON.stringify(current) === JSON.stringify(worker.version) ? { version:worker.version, status:"unchanged" as const }
        : { ...worker, status:"stale" as const, reason:"Worker activity, attempt or saved result changed; read and validate the current result again." };
    } catch (error) {
      return { ...worker, status:"unavailable" as const, reason:error instanceof Error ? error.message : String(error) };
    }
  });
  return { status:workers.some(worker => worker.status === "unavailable") ? "unavailable"
    : workers.some(worker => worker.status === "stale") ? "stale"
      : workers.some(worker => worker.status === "unchecked") ? "unchecked" : "unchanged", workers };
}

export function assertCurrentWorkerEvidence(calls: NonNullable<ChatMessage["toolCalls"]>, managerChatId: string,
  read?: WorkerVersionReader): void {
  const state = workerEvidenceState(calls, managerChatId, read);
  if (state && state.status !== "unchanged") {
    throw new Error(`Worker evidence is ${state.status}: ${state.workers.filter(worker => worker.status !== "unchanged")
      .map(worker => worker.reason).join("; ")}`);
  }
}
