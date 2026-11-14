import { z } from "zod";

export const CHAT_SESSION_LIMITS = Object.freeze({
  sessionsPerActor: 512, messagesPerSession: 10_000, sessionBytes: 16_777_216,
  actorBytes: 67_108_864, messageBytes: 131_072, requestBytes: 262_144,
  pageBytes: 524_288, pageItems: 100, jsonDepth: 16, jsonValues: 8192,
});
const id = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/);
const revision = z.number().int().safe().nonnegative();
const timestamp = z.string().datetime({ offset: true });

export function boundedChatJson(value: unknown): boolean {
  const pending = [{ value, depth: 0 }];
  const seen = new Set<object>();
  let count = 0;
  let characters = 0;
  while (pending.length) {
    const item = pending.pop()!;
    if (++count > CHAT_SESSION_LIMITS.jsonValues || item.depth > CHAT_SESSION_LIMITS.jsonDepth) return false;
    const current = item.value;
    if (typeof current === "string") characters += current.length;
    else if (current === null || typeof current === "boolean") { /* JSON primitive. */ }
    else if (typeof current === "number") { if (!Number.isFinite(current)) return false; }
    else if (typeof current === "object") {
      if (seen.has(current) || (!Array.isArray(current) && ![Object.prototype, null].includes(Object.getPrototypeOf(current)))) return false;
      seen.add(current);
      for (const [key, descriptor] of Object.entries(Object.getOwnPropertyDescriptors(current))) {
        if (Array.isArray(current) && key === "length") continue;
        if (!descriptor.enumerable || !("value" in descriptor)) return false;
        characters += key.length;
        pending.push({ value: descriptor.value, depth: item.depth + 1 });
      }
    } else return false;
    if (characters > CHAT_SESSION_LIMITS.requestBytes) return false;
  }
  return true;
}
export const chatSessionJson = z.json().refine(boundedChatJson, "Expected bounded portable JSON.");
const transcriptMetadata = z.strictObject({
  schema: z.literal("pkm.chat.transcript-metadata/v1"),
  usage: chatSessionJson.optional(), auxiliaryModelUsage: chatSessionJson.optional(),
  retrieval: chatSessionJson.optional(), retrievalActivity: chatSessionJson.optional(),
  memory: chatSessionJson.optional(), planning: chatSessionJson.optional(),
  budgetReceipts: chatSessionJson.optional(), harnessReports: chatSessionJson.optional(),
  profileContext: chatSessionJson.optional(), reasoningSummaries: chatSessionJson.optional(),
  publicOutputSegments: chatSessionJson.optional(), progress: chatSessionJson.optional(),
});
export const chatSessionMessageInput = z.strictObject({
  id, role: z.enum(["user", "assistant"]), content: z.string().max(100_000),
  status: z.enum(["complete", "streaming", "cancelled", "failed", "interrupted"]),
  recordedAt: timestamp.optional(), model: z.string().max(200).optional(),
  inputId: id.optional(), taskId: id.optional(), fromSessionId: id.optional(), fromChatId: id.optional(),
  inputKind: z.enum(["steer", "task"]).optional(), inputOrigin: z.enum(["local-user", "agent"]).optional(),
  error: z.string().max(4000).optional(), contextLabels: z.array(z.string().max(200)).max(100).optional(),
  elapsedMs: revision.optional(), metadata: transcriptMetadata.optional(),
  toolCalls: z.array(z.strictObject({
    id, name: z.string().min(1).max(200), arguments: z.string().max(32_768),
    status: z.enum(["running", "complete", "failed"]), result: z.string().max(65_536).optional(),
    round: revision.optional(), queuedMs: revision.optional(), reused: z.boolean().optional(),
    startedAt: revision.optional(), finishedAt: revision.optional(),
  })).max(64).optional(),
});
export const chatSessionMessage = chatSessionMessageInput.extend({
  schema: z.literal("pkm.chat.message/v1"), sequence: revision.positive(), receivedAt: timestamp,
  replay: z.literal("never"),
});
const sessionMetadata = z.strictObject({
  schema: z.literal("pkm.chat.session-metadata/v1"),
  sessionId: id.optional(), workflowMode: z.enum(["chat", "plan", "execute"]).optional(),
  modelProvider: z.enum(["vscode", "openai-compatible", "azure-openai"]).optional(),
  modelProfileId: z.string().max(200).optional(), vscodeModelId: z.string().max(200).optional(),
  vscodeModelLabel: z.string().max(200).optional(), contextWindow: revision.positive().optional(),
  maxOutputTokens: revision.positive().optional(), includeHistory: z.boolean().optional(),
});
export const chatSessionRecord = z.strictObject({
  schema: z.literal("pkm.chat.session/v1"), id, title: z.string().min(1).max(120),
  revision: revision.positive(), createdAt: timestamp, updatedAt: timestamp,
  archivedAt: timestamp.nullable(), messageCount: revision, lastSequence: revision,
  metadata: sessionMetadata.optional(), generation: z.literal("unavailable"), replay: z.literal("never"),
});
const mutation = { operationId: z.string().uuid(), id, expectedRevision: revision };
const cursor = z.string().min(1).max(1024);
export const chatSessionDefinitions = [
  {
    id: "chat.session.capabilities", readOnly: true,
    description: "Durable actor-private transcript state only; no provider, model generation, tool execution, automatic replay or Markdown writes.",
    input: z.strictObject({}),
    output: z.strictObject({
      schema: z.literal("pkm.chat.session.capabilities/v1"), generation: z.literal("unavailable"),
      replay: z.literal("never"), storage: z.literal("shared-sqlite-runtime-state"),
      limits: z.record(z.string(), revision), unavailable: z.array(z.string()),
    }),
  },
  {
    id: "chat.session.create", readOnly: false,
    description: "Create a caller-ID-stable actor-private Chat. expectedRevision must be zero; operation receipts belong to the enclosing transaction.",
    input: z.strictObject({
      ...mutation, expectedRevision: z.literal(0), title: z.string().trim().min(1).max(120).default("New Chat"),
      metadata: sessionMetadata.optional(),
    }), output: chatSessionRecord,
  },
  {
    id: "chat.session.list", readOnly: true,
    description: "Page actor-private Chat summaries. List cursors become stale on any actor Chat mutation.",
    input: z.strictObject({ limit: revision.min(1).max(100).default(20), cursor: cursor.optional(), includeArchived: z.boolean().default(false) }),
    output: z.strictObject({ items: z.array(chatSessionRecord), nextCursor: cursor.nullable() }),
  },
  {
    id: "chat.session.get", readOnly: true,
    description: "Get a Chat summary, including archived state. Read transcripts with chat.session.messages.",
    input: z.strictObject({ id }), output: chatSessionRecord,
  },
  {
    id: "chat.session.messages", readOnly: true,
    description: "Read immutable messages in sequence order. Reuse nextCursor to reconnect, including after an empty page. No history is silently pruned.",
    input: z.strictObject({
      id, limit: revision.min(1).max(100).default(20), cursor: cursor.optional(), afterSequence: revision.optional(),
    }).refine(value => value.cursor === undefined || value.afterSequence === undefined, "Choose cursor or afterSequence."),
    output: z.strictObject({
      id, revision: revision.positive(), items: z.array(chatSessionMessage), nextCursor: cursor,
      hasMore: z.boolean(), lastSequence: revision, replay: z.literal("never"),
    }),
  },
  {
    id: "chat.session.append", readOnly: false,
    description: "Append one immutable recorded message using revision CAS. Streaming/running observations are disarmed to interrupted/failed, never executed. No model is invoked.",
    input: z.strictObject({ ...mutation, expectedRevision: revision.positive(), message: chatSessionMessageInput }),
    output: z.strictObject({ session: chatSessionRecord, message: chatSessionMessage }),
  },
  {
    id: "chat.session.archive", readOnly: false,
    description: "Archive an exact Chat revision. History remains readable; archived Chats cannot accept appends. No permanent deletion or external Task lifecycle side effects.",
    input: z.strictObject({ ...mutation, expectedRevision: revision.positive() }), output: chatSessionRecord,
  },
] as const;
export type ChatSessionOperation = typeof chatSessionDefinitions[number]["id"];
export type ChatSessionRequest = { operation: ChatSessionOperation; args: unknown };
export type ChatSessionRecord = z.infer<typeof chatSessionRecord>;
export type ChatSessionMessage = z.infer<typeof chatSessionMessage>;
