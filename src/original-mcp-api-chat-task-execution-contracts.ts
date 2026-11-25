import { z } from "zod";
import type { OriginalNativeChatExecutionPlan, OriginalNativeChatExecutionPort } from "./original-mcp-api-chat-contracts.js";

export const originalNativeTaskExecutionMethod = "execution.task.run" as const;
const uuid = z.string().uuid(), digest = z.string().regex(/^[a-f0-9]{64}$/);
export const originalManagedTaskActionStartedInput = z.strictObject({
  operationId: uuid, callId: z.string().min(1).max(200),
});
export const originalNativeTaskBinding = z.strictObject({
  schema: z.literal("pkm.original-native-task-execution/v1"),
  taskId: z.string().regex(/^agent_session_[a-f0-9]{32}$/), attemptId: uuid, inputId: uuid, replyId: uuid,
  requestId: digest, chatId: uuid, sourcePlanSha256: digest, nativeEpoch: z.string().min(1).max(512),
  initialTaskRevision: z.number().int().positive(), contextSha256: digest, bindingSha256: digest,
});
export interface OriginalNativeManagedTaskExecutionPlan extends OriginalNativeChatExecutionPlan {
  managedTask: z.infer<typeof originalNativeTaskBinding>;
}
export const originalNativeTaskContextRequest = z.strictObject({
  phase: z.enum(["after-round", "after-tools", "settled"]),
  inferenceId: digest, round: z.number().int().min(0).max(1000), planSha256: digest,
  bindingSha256: digest, sourcePlanSha256: digest, hasToolCalls: z.boolean(), finalSummary: z.boolean(),
});
export const originalNativeTaskContextResult = z.strictObject({
  schema: z.literal("pkm.original-native-task-context/v1"),
  requestId: digest, bindingSha256: digest, planSha256: digest,
  decision: z.enum(["continue", "finish", "reject"]),
  continuation: z.string().max(262144).refine(value => Buffer.byteLength(value, "utf8") <= 262144).nullable(),
  errorCode: z.enum(["GOAL_STALE_ENDINGS", "GOAL_UNFINISHED", "TASK_STATE_INVALID"]).nullable(),
  goalStatus: z.enum(["active", "resolved", "blocked", "needs_input", "interrupted", "paused"]),
  taskRevision: z.number().int().positive(), evidenceSha256: digest, stopAfterTools: z.literal(false),
});
export type OriginalNativeTaskContextRequest = z.infer<typeof originalNativeTaskContextRequest>;
export type OriginalNativeTaskContextResult = z.infer<typeof originalNativeTaskContextResult>;
export type OriginalNativeTaskContextCallback = (request: OriginalNativeTaskContextRequest) => Promise<OriginalNativeTaskContextResult>;
export interface OriginalNativeManagedTaskExecutionPort {
  run(plan: Readonly<OriginalNativeManagedTaskExecutionPlan>,
    ports: Parameters<OriginalNativeChatExecutionPort["run"]>[1] & { taskContext: OriginalNativeTaskContextCallback },
    signal: AbortSignal): ReturnType<OriginalNativeChatExecutionPort["run"]>;
}
export type OriginalNativeTaskCapableExecutionPort = OriginalNativeChatExecutionPort & {
  readonly managedTask?: OriginalNativeManagedTaskExecutionPort;
};

/** A known Goal-policy stop after observed, settled native I/O; not a network replay/uncertainty signal. */
export class OriginalNativeTaskSemanticError extends Error {
  readonly code = "NATIVE_TASK_GOAL_UNFINISHED";
  readonly semanticOnly = true;
  constructor(readonly reason: "GOAL_STALE_ENDINGS" | "GOAL_UNFINISHED" | "TASK_STATE_INVALID") {
    super(`NATIVE_TASK_GOAL_UNFINISHED: ${reason}. Recorded effects remain evidence; no goal or Task completion was granted.`);
    this.name = "OriginalNativeTaskSemanticError";
  }
}
