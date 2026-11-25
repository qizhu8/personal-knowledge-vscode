import { z } from "zod";

export const CHAT_TURN_LIMITS = Object.freeze({
  steps: 8, toolsPerStep: 16, tools: 32, messages: 128, requestBytes: 262144,
  promptBytes: 262144, outputBytes: 100000, toolBytes: 32768, eventBytes: 32768,
  events: 2048, pageItems: 100, pageBytes: 262144, recordBytes: 524288,
  inputTokens: 262144, outputTokens: 8192, totalOutputTokens: 32768,
  deadlineMs: 300000, turnsPerActor: 512,
});
const id = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/);
const positive = z.number().int().safe().positive();
export const chatTurnMessageInput = z.strictObject({
  role: z.enum(["user", "assistant", "system"]), content: z.string().max(CHAT_TURN_LIMITS.requestBytes),
});
export const chatTurnStartInput = z.strictObject({
  id, sessionId: id, operationId: z.string().uuid(), expectedRevision: z.literal(0),
  expectedSessionRevision: positive.optional(),
  messages: z.array(chatTurnMessageInput).min(1).max(CHAT_TURN_LIMITS.messages),
  maxSteps: positive.max(CHAT_TURN_LIMITS.steps).default(4),
  maxOutputTokens: positive.max(CHAT_TURN_LIMITS.outputTokens).default(4096),
  maxInputTokens: positive.max(CHAT_TURN_LIMITS.inputTokens).default(65536),
  maxTotalOutputTokens: positive.max(CHAT_TURN_LIMITS.totalOutputTokens).default(16384),
  deadlineMs: positive.max(CHAT_TURN_LIMITS.deadlineMs).default(120000),
});
export const chatTurnCancelInput = z.strictObject({
  id, operationId: z.string().uuid(), expectedRevision: positive,
});
export type ChatTurnStart = z.infer<typeof chatTurnStartInput>;
export type ChatTurnCancel = z.infer<typeof chatTurnCancelInput>;
export interface ChatTurnCall { id: string; name: string; arguments: Record<string, unknown> }
export interface ChatTurnMessage {
  role: "user" | "assistant" | "system" | "tool"; content: string; tool_call_id?: string;
  tool_calls?: { id: string; type: "function"; function: { name: string; arguments: string } }[];
}
export type ChatTurnStatus = "queued" | "model" | "tool" | "approval" | "completed" | "cancelled" | "failed" | "unknown";
export interface ChatTurnRecord {
  schema: "pkm.chat.turn/v1"; id: string; sessionId: string; actor: string; revision: number;
  sessionBacked?: true;
  contextDigest: string;
  status: ChatTurnStatus; replay: "never"; createdAt: number; updatedAt: number; deadline: number;
  messages: ChatTurnMessage[]; output: string; step: number; toolCount: number;
  outputBytes: number; inputTokens: number; outputTokens: number;
  bounds: Pick<ChatTurnStart, "maxSteps" | "maxOutputTokens" | "maxInputTokens" | "maxTotalOutputTokens">;
  pendingTool: { call: ChatTurnCall; operationId: string } | null;
  failure: string | null; uncertain: boolean; lastSequence: number;
}
export interface ChatTurnEvent {
  sequence: number; turnId: string; revision: number; type: string;
  operationId: string; at: number; data: Record<string, unknown>;
}
export const chatTurnTerminal = (status: ChatTurnStatus) =>
  ["completed", "cancelled", "failed", "unknown"].includes(status);

const count = z.number().int().safe().nonnegative();
const toolCall = z.strictObject({
  id, name: id, arguments: z.record(z.string(), z.json()),
});
export const chatTurnRecordSchema = z.strictObject({
  schema: z.literal("pkm.chat.turn/v1"), id, sessionId: id, actor: z.string().min(1).max(256),
  sessionBacked: z.literal(true).optional(),
  revision: positive, contextDigest: z.string().regex(/^[a-f0-9]{64}$/),
  status: z.enum(["queued", "model", "tool", "approval", "completed", "cancelled", "failed", "unknown"]),
  replay: z.literal("never"), createdAt: count, updatedAt: count, deadline: count,
  messages: z.array(z.strictObject({
    role: z.enum(["user", "assistant", "system", "tool"]), content: z.string().max(CHAT_TURN_LIMITS.requestBytes),
    tool_call_id: id.optional(),
    tool_calls: z.array(z.strictObject({
      id, type: z.literal("function"), function: z.strictObject({
        name: id, arguments: z.string().max(CHAT_TURN_LIMITS.toolBytes),
      }),
    })).max(CHAT_TURN_LIMITS.toolsPerStep).optional(),
  })).max(CHAT_TURN_LIMITS.messages),
  output: z.string().max(CHAT_TURN_LIMITS.outputBytes), step: count.max(CHAT_TURN_LIMITS.steps),
  toolCount: count.max(CHAT_TURN_LIMITS.tools), outputBytes: count.max(CHAT_TURN_LIMITS.outputBytes),
  inputTokens: count, outputTokens: count.max(CHAT_TURN_LIMITS.totalOutputTokens),
  bounds: z.strictObject({
    maxSteps: positive.max(CHAT_TURN_LIMITS.steps), maxOutputTokens: positive.max(CHAT_TURN_LIMITS.outputTokens),
    maxInputTokens: positive.max(CHAT_TURN_LIMITS.inputTokens), maxTotalOutputTokens: positive.max(CHAT_TURN_LIMITS.totalOutputTokens),
  }),
  pendingTool: z.strictObject({ call: toolCall, operationId: z.string().uuid() }).nullable(),
  failure: z.string().max(128).nullable(), uncertain: z.boolean(), lastSequence: positive,
});
export const chatTurnEventSchema = z.strictObject({
  sequence: positive, turnId: id, revision: positive, type: z.string().min(1).max(64),
  operationId: z.string().uuid(), at: count, data: z.record(z.string(), z.json()),
});

/** Availability is native host configuration, never a caller-controlled argument. */
export function createChatTurnDefinitions(nativeProviderAvailable = false) {
  const get = z.strictObject({ id });
  return [
    ...(nativeProviderAvailable ? [{
      id: "chat.turn.start", readOnly: false, input: chatTurnStartInput, output: chatTurnRecordSchema,
      description: "Start one bounded native-provider turn. Durable intents precede effects; no automatic replay.",
    }] : []),
    { id: "chat.turn.get", readOnly: true, input: get, output: chatTurnRecordSchema, description: "Read actor-private turn state; never starts or resumes work." },
    { id: "chat.turn.events", readOnly: true,
      input: z.strictObject({ id, after: z.number().int().safe().nonnegative().default(0), limit: positive.max(CHAT_TURN_LIMITS.pageItems).default(20) }),
      output: z.strictObject({ events: z.array(chatTurnEventSchema).max(CHAT_TURN_LIMITS.pageItems), next: positive.nullable() }),
      description: "Read bounded actor-private durable events using a turn-scoped numeric cursor." },
    { id: "chat.turn.cancel", readOnly: false, input: chatTurnCancelInput, output: chatTurnRecordSchema,
      description: "CAS-cancel a turn. In-flight tool effects may be unknown; cancellation does not roll them back." },
    { id: "chat.turn.list", readOnly: true,
      input: z.strictObject({ sessionId: id, after: id.optional(), limit: positive.max(CHAT_TURN_LIMITS.pageItems).default(20) }),
      output: z.strictObject({ items: z.array(chatTurnRecordSchema).max(CHAT_TURN_LIMITS.pageItems), next: id.nullable() }),
      description: "Discover actor-private session turns without resuming or replaying generation." },
  ] as const;
}
