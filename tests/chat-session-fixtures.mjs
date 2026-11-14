import { createHash } from "node:crypto";

// Transport-neutral examples. Supply actorId only from authenticated transport context.
export const chatSessionFixture = {
  actorId: "chat-fixture-actor",
  create: {
    operation: "chat.session.create",
    args: {
      operationId: "00000000-0000-4000-8000-000000000101", id: "fixture-chat", expectedRevision: 0,
      title: "Transcript fixture",
      metadata: { schema: "pkm.chat.session-metadata/v1", includeHistory: true, modelProvider: "openai-compatible" },
    },
  },
  get: { operation: "chat.session.get", args: { id: "fixture-chat" } },
  list: { operation: "chat.session.list", args: { limit: 20, includeArchived: false } },
  append: {
    operation: "chat.session.append",
    args: {
      operationId: "00000000-0000-4000-8000-000000000102", id: "fixture-chat", expectedRevision: 1,
      message: {
        id: "fixture-user-1", role: "user", content: "Store this transcript, without invoking a provider.",
        status: "complete", recordedAt: "2026-01-02T03:04:05.000Z",
        metadata: { schema: "pkm.chat.transcript-metadata/v1", usage: { inputTokens: 7, outputTokens: 0 } },
      },
    },
  },
  messages: { operation: "chat.session.messages", args: { id: "fixture-chat", afterSequence: 0, limit: 20 } },
  archive: {
    operation: "chat.session.archive",
    args: { operationId: "00000000-0000-4000-8000-000000000103", id: "fixture-chat", expectedRevision: 2 },
  },
};
export const chatSessionExpected = {
  now: "2026-01-02T03:04:05.000Z",
  created: {
    schema: "pkm.chat.session/v1", id: "fixture-chat", title: "Transcript fixture", revision: 1,
    createdAt: "2026-01-02T03:04:05.000Z", updatedAt: "2026-01-02T03:04:05.000Z",
    archivedAt: null, messageCount: 0, lastSequence: 0,
    metadata: { schema: "pkm.chat.session-metadata/v1", includeHistory: true, modelProvider: "openai-compatible" },
    generation: "unavailable", replay: "never",
  },
};
export const chatSessionTransportFixture = {
  create: { method: "capability_call", params: { operation: chatSessionFixture.create.operation, arguments: chatSessionFixture.create.args } },
  read: { method: "capability_read", params: { operation: chatSessionFixture.messages.operation, arguments: chatSessionFixture.messages.args } },
  http: { path: "/v1/capability_call", method: "POST", body: { operation: chatSessionFixture.create.operation, arguments: chatSessionFixture.create.args } },
  mcp: { name: "capability_call", arguments: { operation: chatSessionFixture.create.operation, arguments: chatSessionFixture.create.args } },
  notes: "Use the transport's existing invocation envelope; actorId is never in params. Store execute accepts {operation,args}, not the public envelope.",
};
const appendedSession = { ...chatSessionExpected.created, revision: 2, messageCount: 1, lastSequence: 1 };
const appendedMessage = {
  ...chatSessionFixture.append.args.message, schema: "pkm.chat.message/v1", sequence: 1,
  receivedAt: chatSessionExpected.now, replay: "never",
};
const archivedSession = { ...appendedSession, revision: 3, archivedAt: chatSessionExpected.now };
const transcriptCursor = Buffer.from(JSON.stringify({
  v: 1,
  scope: createHash("sha256").update(JSON.stringify(["messages", chatSessionFixture.actorId, "fixture-chat"])).digest("hex"),
  after: 1,
})).toString("base64url");
export const chatSessionApiFixture = {
  actorId: chatSessionFixture.actorId, now: chatSessionExpected.now,
  responseEnvelope: "Core supplies dynamic requestId/catalogRevision in pkm.next-result/v1; expectedResult below is its result field.",
  steps: [
    { key: "create", expectedResult: chatSessionExpected.created },
    { key: "get", expectedResult: chatSessionExpected.created },
    { key: "list", expectedResult: { items: [chatSessionExpected.created], nextCursor: null } },
    { key: "append", expectedResult: { session: appendedSession, message: appendedMessage } },
    { key: "messages", expectedResult: {
      id: "fixture-chat", revision: 2, items: [appendedMessage], nextCursor: transcriptCursor,
      hasMore: false, lastSequence: 1, replay: "never",
    } },
    { key: "archive", expectedResult: archivedSession },
  ].map(({ key, expectedResult }) => {
    const storeRequest = chatSessionFixture[key];
    const method = ["create", "append", "archive"].includes(key) ? "capability_call" : "capability_read";
    const args = { operation: storeRequest.operation, arguments: storeRequest.args };
    return {
      key, storeRequest, expectedResult,
      http: { method: "POST", path: `/v1/${method}`, body: args },
      mcp: { name: method, arguments: args },
    };
  }),
};
