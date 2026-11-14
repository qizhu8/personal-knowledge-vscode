import { z } from "zod";

export const nativeApiChatTaskControl = z.strictObject({
  namespace: z.string().regex(/^[a-f0-9]{16}$/), chatId: z.string().uuid(),
  operationId: z.string().uuid(), expectedRevision: z.number().int().nonnegative(),
  kind: z.enum(["create", "complete", "pause", "cancel", "resume"]),
  title: z.string().trim().min(1).max(120).regex(/^[^\u0000-\u001f\u007f]+$/).optional(),
}).superRefine((input, context) => {
  if ((input.kind === "create") !== (input.title !== undefined))
    context.addIssue({ code: "custom", message: "Only Task creation requires a bounded Task title." });
});
export type NativeApiChatTaskControl = z.infer<typeof nativeApiChatTaskControl>;
export interface NativeApiChatTaskState {
  revision: number; sourceFingerprint: string;
  activeSessionId: string | null; paused: boolean; stopped: boolean;
  tasks: Array<{ sessionId: string; title: string; createdAt: string; completedAt?: string;
    authority: "archive_only" | "native_core" }>;
}
