import { validWorkGoal, prepareWorkGoal, recordWorkGoalTransition,
  type ApiConversation, type ChatMessage, type ChatWorkGoal } from "./managed-chat-task-original.js";
import type { OriginalManagedTaskAdoptionSource } from "./managed-chat-task-adoption-contracts.js";

/** Pure transition only: the owning worker must first validate the genuine scoped adoption review. */
export function resumeReviewedOriginalManagedGoal(source: OriginalManagedTaskAdoptionSource,
  input: { inputId: string; prompt: string; contextDigest: string }): ChatWorkGoal {
  const archived = source.goal;
  if (!validWorkGoal(archived)) throw new Error("An actual valid original work Goal is required.");
  const original: ChatWorkGoal = archived;
  const reset = recordWorkGoalTransition({ ...structuredClone(original), executionDigest: input.contextDigest,
    reason: undefined, nextAction: undefined,
    acceptance: original.acceptance.map(item => ({ ...item, verified: false, evidenceCallIds: [] })) },
  "paused", "host_interrupted");
  const chat: ApiConversation = { id: source.chatId, sessionId: source.taskId, includeHistory: true, workGoal: reset,
    messages: [...source.messages as unknown as ChatMessage[],
      { id: input.inputId, taskId: source.taskId, role: "user", content: input.prompt, status: "complete" }] };
  prepareWorkGoal(chat, input.inputId, input.prompt, input.contextDigest);
  if (!chat.workGoal || chat.workGoal.id !== original.id || chat.workGoal.inputId !== original.inputId
    || chat.workGoal.attemptInputId !== input.inputId || chat.workGoal.status !== "active")
    throw new Error("Adoption requires explicit continuation of the preserved original Goal, not another objective.");
  return chat.workGoal;
}
