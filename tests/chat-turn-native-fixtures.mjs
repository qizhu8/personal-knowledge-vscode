import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { Core } from "../dist/core.js";
import { CoreError } from "../dist/contracts.js";
import { ModelConfigService } from "../dist/model-config.js";
import { ModelProviderService } from "../dist/model-provider.js";
import { ToolGateway } from "../dist/tool-gateway.js";
import { createChatTurnModelPort, createChatTurnToolPort } from "../dist/chat-turn-adapters.js";
import { chatTurnFixture } from "./chat-turn-fixtures.mjs";

const delta = (value, finish_reason = null) =>
  `data: ${JSON.stringify({ choices: [{ index: 0, delta: value, finish_reason }] })}\n\n`;
const done = 'data: {"choices":[],"usage":{"prompt_tokens":100,"completion_tokens":30}}\n\ndata: [DONE]\n\n';
function response(parts) {
  return new ReadableStream({ start(controller) {
    const text = new TextEncoder().encode(parts.join(""));
    for (let offset = 0; offset < text.length; offset += 19) controller.enqueue(text.slice(offset, offset + 19));
    controller.close();
  } });
}

export function createSyntheticProvider({ database, documentId = "chain-document", onOpen, expectFailure = false, toolContent, expectToolLimit = false } = {}) {
  let modelCalls = 0;
  const calls = [];
  const modelConfig = new ModelConfigService({
    configuration: { aiEndpoint: "https://synthetic.invalid/v1", aiModel: "synthetic",
      apiChatModelProfiles: [{ id: "synthetic", status: "active", contextWindow: toolContent === undefined ? 16384 : 262144, maxOutputTokens: 4096, includeUsage: true }] },
    secretResolver: { resolveSecret: async () => ({ opaqueSyntheticHandle: true }) },
    registryAvailability: { "openai-compatible": true },
  });
  const providerTransport = {
    supports: provider => provider === "openai-compatible",
    async open(request) {
      modelCalls++;
      if (database) assert.equal(database().isTransaction, false);
      await onOpen?.(request, modelCalls);
      calls.push(request.payload);
      assert.equal(request.payload.tools[0].function.name, "create_document");
      assert(!("operationId" in request.payload.tools[0].function.parameters.properties));
      if (modelCalls === 1) return response([
        delta({ content: "Preparing synthetic document." }),
        delta({ tool_calls: [{ index: 0, id: "call-chain-1", type: "function",
          function: { name: "create_document", arguments: JSON.stringify({
            id: documentId, title: " Synthetic chain ", content: "Synthetic content.",
          }) } }] }),
        delta({}, "tool_calls"), done,
      ]);
      assert.equal(request.payload.messages.at(-1).role, "tool");
      assert.equal(request.payload.messages.at(-1).tool_call_id, "call-chain-1");
      if (expectFailure) {
        const content = JSON.parse(request.payload.messages.at(-1).content);
        assert.equal(content.error.code, "CONFLICT");
        assert.equal(content.error.message, "Tool request is stale or conflicts with an earlier invocation.");
        assert.equal(content.effect, "not-committed");
        assert(!request.payload.messages.at(-1).content.includes("private error detail"));
      } else if (expectToolLimit) assert.deepEqual(JSON.parse(request.payload.messages.at(-1).content),
        { error: "Tool result exceeded the local limit." });
      else if (toolContent !== undefined) assert.equal(JSON.parse(request.payload.messages.at(-1).content).content, toolContent);
      else assert.match(request.payload.messages.at(-1).content, /Synthetic content/);
      return response([delta({ content: "Synthetic document verified." }), delta({}, "stop"), done]);
    },
  };
  return { modelConfig, providerTransport, calls, counts: () => ({ modelCalls }) };
}

/** Reusable HTTP/MCP integrator fixture: all configured dependencies are native, synthetic and local. */
export function createChatTurnChainFixture(options = {}) {
  let native, fixture, toolEffects = 0;
  const reviews = [];
  const provider = createSyntheticProvider({
    database: () => fixture.db,
    documentId: options.documentId ?? "chain-document",
    onOpen: options.onOpen,
    expectFailure: options.safeFailure,
    toolContent: options.toolContent,
    expectToolLimit: options.expectToolLimit,
  });
  const modelProvider = new ModelProviderService({
    modelConfig: provider.modelConfig, transport: provider.providerTransport,
  });
  const core = new Core({
    async request(request) {
      assert.equal(fixture.db.isTransaction, false);
      assert.equal(request.operation, "knowledge.document.create");
      assert.equal(request.actorId, "chain-actor");
      toolEffects++;
      if (options.unknown) throw new Error("Synthetic connection loss after possible effect.");
      if (options.safeFailure) throw new CoreError("CONFLICT", "private error detail", "not-committed");
      const { id, title, content } = request.args;
      fixture.transaction(() => fixture.db.prepare("INSERT INTO synthetic_chain_documents VALUES(?,?,?,?)")
        .run(id, title, content, request.args.operationId));
      return { id, title, content: options.toolContent ?? content, revision: 1, deleted: false, sha256: "a".repeat(64) };
    },
  });
  fixture = chatTurnFixture({
    ...options,
    model: createChatTurnModelPort(modelProvider, { tools: (...args) => native.modelTools(...args) }),
    tools: { available: true, execute: request => native.tools.execute(request) },
  });
  fixture.transaction(() => fixture.db.exec(`CREATE TABLE IF NOT EXISTS synthetic_chain_documents(
    id TEXT PRIMARY KEY,title TEXT,content TEXT,operation_id TEXT UNIQUE)`));
  native = createChatTurnToolPort({
    workspaceId: "chain-workspace",
    storage: { read: fn => fn(fixture.db), transaction: fn => fixture.transaction(() => fn(fixture.db)) },
    async reviewer(request) {
      assert.equal(fixture.db.isTransaction, false);
      reviews.push(request);
      assert.equal(request.record.tool, "knowledge.document.create");
      assert.equal(request.record.arguments.title, "Synthetic chain");
      assert.equal(request.record.arguments.operationId, request.executionOperationId);
      assert.equal(fixture.service.get(request.actorId, request.context.turnId).status, "approval");
      if (options.review) return options.review(request);
      return { actorId: request.actorId, decisionId: randomUUID(), decision: options.deny ? "reject" : "approve" };
    },
    gateway(actor, turnId, verifyApproval) {
      return new ToolGateway({
        dispatcher: core, actor: { id: actor, canWrite: true },
        context: { workspaceId: "chain-workspace", turnId, contextDigest: fixture.service.get(actor, turnId).contextDigest },
        catalog: [{ name: "create_document", operation: "knowledge.document.create" }], verifyApproval,
        legacyChatOutput: true,
        limits: { outputBytes: 96_002 },
      });
    },
  });
  return { ...fixture, native, calls: provider.calls, reviews,
    counts: () => ({ ...provider.counts(), toolEffects }) };
}
