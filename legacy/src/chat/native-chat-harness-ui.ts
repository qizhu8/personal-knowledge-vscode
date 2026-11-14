import { apiChatSessionHarnessSnapshot } from "./api-chat-store";

type Json = Record<string, any>;

/** Pure projection of an authorized native-host response; never opens a legacy store or execution context. */
export function nativeChatHarnessSnapshot(value: Json, sessionId: string, fullResults = false, workerId?: string): Json {
  const record = value.record, history = value.history;
  if (record?.sessionId !== sessionId || record.schema !== "pkm.agent.session/v1"
    || !Array.isArray(history?.messages)) throw new Error("The exact authorized Task snapshot is unavailable.");
  let metadata = history.metadata, messages = history.messages, title = record.task;
  if (workerId) {
    const native = history.nativeWorkers?.find((worker: Json) => worker.id === workerId);
    const source = value.sourceWorkers?.find((worker: Json) => worker.receiptId === workerId);
    if (!native && !source) throw new Error("Worker evidence is outside this exact Task.");
    if (source) {
      metadata = source.chat; messages = source.chat.messages;
      title = `Archived worker: ${source.chat.title}`;
    } else {
      metadata = { id: native.id, title: native.title, createdAt: native.createdAt, updatedAt: native.updatedAt };
      title = `Native worker: ${native.title}`;
      messages = native.messages.flatMap((message: Json, index: number) => {
        if (!["user", "assistant"].includes(message.role)) return [];
        return [{ id: `${native.id}:${index}`, role: message.role, content: message.content ?? "",
          status: message.role === "user" || native.status === "completed" ? "complete"
            : native.status === "unknown" ? "interrupted" : ["cancelled", "failed"].includes(native.status) ? native.status : "streaming",
          toolCalls: (message.tool_calls ?? []).map((call: Json) => {
            const result = native.messages.find((item: Json) => item.role === "tool" && item.tool_call_id === call.id);
            return { id: call.id, name: call.function.name, arguments: call.function.arguments,
              status: result ? "complete" : "failed", ...(result ? { result: result.content } : {}) };
          }),
          ...(message.role === "assistant" ? { progress: { attemptId: `${native.id}:${index}`, attempt: index + 1,
            startedAt: native.createdAt,
            ...(["completed", "unknown", "failed", "cancelled"].includes(native.status) ? { finishedAt: native.updatedAt } : {}),
            status: native.status === "completed" ? "complete" : native.status === "cancelled" ? "cancelled"
              : ["unknown", "failed"].includes(native.status) ? "failed" : "running",
            tools: (message.tool_calls ?? []).map((call: Json) => call.function.name), steps: [] } } : {}),
        }];
      });
    }
  }
  const chat = { ...(workerId ? {} : record.nativeChat), ...metadata, version: 1, sessionId, messages,
    permissionMode: "read-only", queuedInputs: [], portalCommands: [], portalTransfers: [],
    ...(messages.at(-1)?.progress ? { progress: messages.at(-1).progress } : {}) };
  delete chat.messageHistory;
  const projected = { ...record, task: title, nativeChat: chat };
  return { ...projected, metadataAuthority: value.metadataAuthority === "native_core" ? "native_core" : "archive_only",
    nativeExecutionAuthority: "fresh-host-only",
    memoryStoreReader: false, profileReader: false, actions: [], actionWarnings: [],
    harness: apiChatSessionHarnessSnapshot(projected, sessionId, undefined, fullResults) };
}
