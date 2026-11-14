import { z } from "zod";

const identity = { namespace: z.string().regex(/^[a-f0-9]{16}$/), chatId: z.string().uuid(),
  operationId: z.string().uuid(), expectedRevision: z.number().int().nonnegative() };
const text = z.string().trim().min(1).max(16000);
const session = z.string().regex(/^agent_session_[a-f0-9]{32}$/);
export const nativeApiChatQueueInput = z.discriminatedUnion("kind", [
  z.strictObject({ ...identity, kind: z.literal("enqueue"), submissionId: z.string().uuid(), text,
    mode: z.enum(["task", "steer"]), taskSessionId: session.nullable(), attemptId: z.string().uuid().optional() }),
  z.strictObject({ ...identity, kind: z.literal("adopt"), sourceId: z.string().uuid(), submissionId: z.string().uuid(), taskSessionId: session.nullable() }),
  z.strictObject({ ...identity, kind: z.literal("remove"), id: z.string().uuid() }),
  z.strictObject({ ...identity, kind: z.literal("edit"), id: z.string().uuid(),
    action: z.enum(["begin", "save", "cancel"]), token: z.string().uuid(), text: text.optional() }),
  z.strictObject({ ...identity, kind: z.literal("run") }),
]);
export type NativeApiChatQueueInput = z.infer<typeof nativeApiChatQueueInput>;
export interface NativeApiChatQueueItem {
  id: string; text: string; mode: "task" | "steer"; taskSessionId: string | null; attemptId?: string;
  sourceId?: string; editToken?: string; status: "queued" | "dispatched" | "applied" | "removed";
}
export interface NativeApiChatQueueState {
  revision: number; sourceFingerprint: string; needsReview: boolean; items: NativeApiChatQueueItem[];
  explicitFailureContinuationId?: string;
}
export const nativeApiChatReviewInput = z.strictObject({
  namespace: identity.namespace, chatId: identity.chatId, operationId: identity.operationId,
  expectedDigest: z.string().regex(/^[a-f0-9]{64}$/),
  decision: z.literal("abandon-without-replay"), reason: z.string().trim().min(1).max(1000),
});
export type NativeApiChatReviewInput = z.infer<typeof nativeApiChatReviewInput>;
export const nativeQueueNewTask = /^\s*(?:开始新任务|start a new task)\s*[:：]/i;
export const nativeQueueStop = /^\s*(?:(?:please\s+)?(?:stop|pause)(?:\s+(?:(?:(?:the\s+)?current|the|this)\s+)?(?:debugging|investigating|diagnosing|work|investigation|task))?(?:\s+(?:now|for now))?|(?:请|先)?(?:停止|暂停)(?:当前|这次|本次)?(?:调试|排查|调查|debug|任务)?)(?:[.!。！,，;；\n]|$)/i;
