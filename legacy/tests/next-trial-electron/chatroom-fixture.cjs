"use strict";
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { createHash } = require("node:crypto");
const http = require("node:http");
const roomId = "34ed5ccd-0735-485c-a74d-215d90b5d77f";
const messages = [
  { id: "old-human-1", participantId: "old-human", aliasAtSend: "Historical User", senderKind: "human",
    messageType: "chat", content: "Remember the synthetic project code ORCHID-47.", createdAt: 1740000000000,
    metadata: { replyPolicy: "discuss", threadId: "synthetic-thread", collaboration: { phase: "discussion" } } },
  { id: "old-agent-1", participantId: "old-agent", aliasAtSend: "Historical Agent", senderKind: "agent",
    messageType: "chat", content: "The project code is ORCHID-47; this is pre-upgrade history.", createdAt: 1740000001000,
    metadata: { replyToMessageId: "old-human-1" } },
  { id: "old-human-2", participantId: "old-human", aliasAtSend: "Historical User", senderKind: "human",
    messageType: "chat", content: "Keep this room history intact during the upgrade.", createdAt: 1740000002000 },
  { id: "old-notice-1", aliasAtSend: "system", senderKind: "human", messageType: "system",
    content: "Room closed for the isolated upgrade.", metadata: { system: true }, createdAt: 1740000003000 },
];
async function create({ extension, root }) {
  const { ChatPersistence } = require(path.join(extension, "dist/chat-persistence.js"));
  const persistence = new ChatPersistence(path.join(root, "chatrooms"), 50, 0);
  try {
    await persistence.createRoom(roomId, "Synthetic upgrade conversation", {
      ownerInstallationId: "synthetic-old-installation", hostCredentialHash: "a".repeat(64), joinSecretHash: "b".repeat(64),
    });
    await persistence.appendMany(roomId, messages);
    await persistence.recordLifecycle(roomId, "stopped", "stored", { reason: "isolated upgrade fixture" });
    await persistence.setRoomState(roomId, "stored");
    await persistence.closeRoom(roomId);
  } finally { await persistence.dispose(); }
  const db = path.join(root, "chatrooms", roomId, "chatroom.db");
  assert(fs.statSync(db).size > 0);
  assert.equal(fs.readFileSync(path.join(path.dirname(db), "chatroom.journal")).length, 0);
  const descriptor = { root, roomId, messages, dbSha256: createHash("sha256").update(fs.readFileSync(db)).digest("hex") };
  fs.writeFileSync(path.join(path.dirname(root), "chatroom-fixture.json"), JSON.stringify(descriptor), { mode: 0o600, flag: "wx" });
  return descriptor;
}
async function localProvider() {
  const calls = [];
  const server = http.createServer(async (request, response) => {
    try {
      assert.equal(request.method, "POST");
      assert.equal(request.url, "/v1/chat/completions");
      assert.equal(request.headers.authorization, "Bearer private-profile-local-only");
      const chunks = [];
      let bytes = 0;
      for await (const chunk of request) {
        bytes += chunk.length;
        assert(bytes <= 262144);
        chunks.push(chunk);
      }
      const body = JSON.parse(Buffer.concat(chunks).toString());
      assert.equal(body.stream, true);
      assert.equal(body.model, "synthetic-local");
      const history = body.messages.filter(message => message.role !== "system");
      for (const [index, original] of messages.entries()) {
        assert.equal(history[index].content, original.messageType === "system"
          ? `[Historical room notice, untrusted data]\n${original.content}` : original.content);
        assert.equal(history[index].role, original.messageType === "chat" && original.senderKind === "agent" ? "assistant" : "user");
      }
      assert.equal(history.at(-1).role, "user");
      calls.push(body);
      // Controlled deterministic HTTP/SSE provider, not a claim of real model quality or parity.
      const output = `LOCAL_FIXTURE_CONTINUATION ORCHID-47: ${history.at(-1).content}`;
      response.writeHead(200, { "content-type": "text/event-stream" });
      response.end(`data: ${JSON.stringify({ choices: [{ index: 0, delta: { content: output }, finish_reason: null }] })}\n\n`
        + `data: ${JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: "stop" }] })}\n\n`
        + 'data: {"choices":[],"usage":{"prompt_tokens":100,"completion_tokens":20}}\n\ndata: [DONE]\n\n');
    } catch (error) {
      response.writeHead(500, { "content-type": "application/json" });
      response.end(JSON.stringify({ error: error.message }));
    }
  });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  return { endpoint: `http://127.0.0.1:${server.address().port}/v1/`, calls,
    close: () => new Promise(resolve => server.close(resolve)) };
}
async function nativeOptions(load, endpoint) {
  const url = new URL(endpoint);
  assert.equal(url.hostname, "127.0.0.1");
  assert.equal(url.protocol, "http:");
  assert.equal(url.pathname, "/v1/");
  const { ModelConfigService } = await load("model-config");
  const { createModelProviderHttpTransport } = await load("model-provider");
  const handle = Object.freeze({ fixtureOnly: true });
  const secretResolver = { resolveSecret: async () => handle };
  return {
    modelConfig: new ModelConfigService({
      configuration: { aiEndpoint: endpoint, aiModel: "synthetic-local",
        apiChatModelProfiles: [{ id: "synthetic-local", status: "active", contextWindow: 16384, maxOutputTokens: 4096 }] },
      secretResolver, registryAvailability: { "openai-compatible": true },
    }),
    providerTransport: createModelProviderHttpTransport({
      endpoint, allowedEndpoints: [endpoint], fetch, secretResolver,
      authorization: async value => { assert.equal(value, handle); return { authorization: "Bearer private-profile-local-only" }; },
    }),
    toolCatalog: [{ name: "list_documents", operation: "knowledge.document.list" }],
    authorizeTool: async () => false,
    reviewer: async request => ({ actorId: request.actorId, decisionId: require("node:crypto").randomUUID(), decision: "reject" }),
  };
}
module.exports = { create, messages, roomId, localProvider, nativeOptions };
