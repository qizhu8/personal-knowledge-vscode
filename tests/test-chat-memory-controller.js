const assert = require("node:assert/strict");
const path = require("node:path");
const { setTimeout: delay } = require("node:timers/promises");

// Reuses the controller host fixture, but runs the production Python worker and SQLite store.
module.exports = async function testMemoryController(ApiChatView, context, nativeClient, models) {
  const originalStream = nativeClient.streamVscodeChat;
  const originalDiscovery = nativeClient.discoverVscodeModels;
  const provider = new ApiChatView({ ...context, extensionPath: path.resolve(__dirname, "..") });
  const calls = [], payloads = [];
  let failIntent = false, failExtraction = false;
  const failedOutput = JSON.stringify({ statements: [{ topic: "T1", text: "Rejected partial model statement must not be committed.", status: "proposal" }] });
  const answer = "Keep immutable revisions and preserve user constraints. ".repeat(80);
  const waitForCommit = async turn => {
    for (let attempt = 0; attempt < 200; attempt++) {
      const result = provider.memoryCommitResults.get(turn);
      if (result) {
        assert.notEqual(result.status, "failed", JSON.stringify(result));
        assert.equal(result.phase, "done");
        return result;
      }
      await delay(10);
    }
    assert.fail(`Memory commit did not settle: ${turn}`);
  };
  let discoveries = 0;
  let memoryDiscoveries;
  let verifyDiscoveryReuse = true;
  nativeClient.discoverVscodeModels = async () => { discoveries++; return models; };
  nativeClient.streamVscodeChat = async (_model, request, onText) => {
    if (request.purpose !== "memory") {
      if (verifyDiscoveryReuse) assert.equal(discoveries, memoryDiscoveries, "the main request reuses the model catalog checked during Memory preparation");
      payloads.push(request.messages);
      onText(payloads.length === 1 ? answer : "Fixture response.");
      return;
    }
    assert.deepEqual(request.tools, []);
    assert.strictEqual(request.timeoutMs, 1_800_000, "Memory uses Chat inactivity timeout without a hidden two-minute cap");
    assert.strictEqual(request.thinkingBudget, 2048, "Memory steps use the default thinking budget");
    const system = request.messages[0].content;
    const purpose = system.includes("CURRENT user input") ? "intent" : system.includes("Extract at most") ? "extract" : "summary";
    if (purpose === "intent") memoryDiscoveries = discoveries;
    calls.push(purpose);
    if (purpose === "summary") {
      onText("Use immutable revisions, retain the exact user constraints and never deploy automatically. [s1]");
      return;
    }
    const data = JSON.parse(request.messages.at(-1).content);
    if (purpose === "intent") {
      if (failIntent) throw new Error("Fixture memory model unavailable");
      const label = /design|设计/.test(data.current_input) ? "Memory fixture design" : data.current_input;
      const topic = data.topics.find(item => item.label === label);
      onText(JSON.stringify(topic ? { focus: [topic.alias] } : { focus: ["new:1"], new: [{ key: "new:1", label }] }));
    } else {
      if (failExtraction) {
        onText(failedOutput);
        request.onUsage({ inputTokens: 1230, outputTokens: 901, reasoningTokens: 820 });
        request.onUsage({ inputTokens: 1230, outputTokens: 901, reasoningTokens: 820 });
        throw new Error("Fixture extraction failure: per-inference token budget exceeded.");
      }
      const statements = data.user === "Review memory design" ? Array.from({ length: 5 }, (_, index) => ({
        topic: "T1", text: `Constraint ${index}: ${"Preserve immutable revision evidence and exact user requirements; ".repeat(16)}`,
        status: "user-confirmed",
      })) : [];
      onText(JSON.stringify({ statements }));
    }
  };
  try {
    await provider.handle({ type: "new" });
    Object.assign(provider.chat, {
      modelProvider: "vscode", vscodeModelId: nativeClient.vscodeModelProfile(models[1]).id,
      includeHistory: true, permissionMode: "read-only", builtinTools: ["memory_read"], vscodeTools: [],
    });
    provider.persist(provider.chat);
    const send = async text => {
      await provider.handle({ type: "send", text });
      const reply = provider.chat.messages.at(-1);
      assert.equal(reply.status, "complete", reply.error);
      assert.equal(reply.memory.error, undefined, reply.memory.error);
      assert.equal(reply.memory.prepare.intent.status, "model");
      await waitForCommit(reply.memory.turn);
      return reply;
    };
    provider.vscodeModels = [];
    discoveries = 0;
    const first = await send("Review memory design");
    verifyDiscoveryReuse = false;
    assert(memoryDiscoveries > 0, "the fixture must perform real catalog discovery before the main request");
    assert.equal(first.memory.prepare.summaries.length, 0, "no eager summaries");
    for (let index = 0; index < 5; index++) await send(`Unrelated hiking topic ${index}`);
    assert.equal(calls.filter(purpose => purpose === "summary").length, 0, "unused topics must not be summarized");
    const recalled = await send("上面说的 memory design 再展开");
    assert(recalled.memory.blocks.some(block => block.kind === "earlier-message"));
    assert(recalled.memory.prepare.summaries.some(summary => summary.status === "committed"));
    assert(payloads.at(-1).some(message => message.role === "system"
      && message.content.startsWith("Chat memory (") && message.content.includes("Keep immutable revisions")));
    const summaries = calls.filter(purpose => purpose === "summary").length;
    await send("继续 memory design");
    assert.equal(calls.filter(purpose => purpose === "summary").length, summaries, "reuse the saved summary");

    const service = provider.chatMemory();
    const scope = provider.memoryScope(provider.chat);
    const durable = await service.receipt(recalled.memory.turn);
    assert.equal(durable.phase, "done");
    assert.equal(durable.extract.status, "model");
    const piece = recalled.memory.blocks.find(block => block.kind === "earlier-message").piece;
    assert((await service.read(scope, piece)).statements.length > 0);
    await assert.rejects(service.read(`${scope}-other`, piece), /scope/);

    failIntent = true;
    await provider.handle({ type: "send", text: "memory design with a provider failure" });
    const fallback = provider.chat.messages.at(-1);
    assert.equal(fallback.status, "complete");
    assert.equal(fallback.memory.prepare.intent.status, "fallback");
    assert.match(fallback.memory.prepare.intent.error, /Fixture memory model unavailable/);
    await waitForCommit(fallback.memory.turn);
    failIntent = false;

    failExtraction = true;
    const extractionFailure = await send("memory design with an extraction failure");
    const failedExtraction = provider.memoryCommitResults.get(extractionFailure.memory.turn);
    assert.equal(failedExtraction.extract.status, "failed");
    assert.match(failedExtraction.extract.error, /Fixture extraction failure/);
    const failedCall = failedExtraction.calls.at(-1);
    assert.equal(failedCall.status, "failed");
    assert.equal(failedCall.max_tokens, 900);
    assert.equal(failedCall.output_chars, failedOutput.length);
    assert.deepEqual(failedCall.usage, { inputTokens: 1230, outputTokens: 901, reasoningTokens: 820 });
    assert.deepEqual(failedExtraction.extract.added, [], "Valid-looking partial JSON from a failed model call must not be applied");
    const restartedReceipt = await service.receipt(extractionFailure.memory.turn);
    assert.deepEqual(restartedReceipt.calls.at(-1), failedCall, "Failure evidence must be durable");
    assert(!JSON.stringify(restartedReceipt).includes("Rejected partial model statement"), "Receipts store counts and usage, not failed model text");
    assert.equal(provider.store.load(provider.chat.id, false).messages.at(-1).status, "complete");
    const persistedBeforeInspect = provider.store.load(provider.chat.id, false);
    const callsBeforeInspect = calls.length;
    const inspected = await provider.readVisualization(provider.chat.id, "memoryReceipt", { messageId: extractionFailure.id });
    assert.deepEqual(inspected, restartedReceipt);
    assert.equal(inspected.accounting.failedCalls, 1);
    assert.deepEqual(inspected.accounting.reportedUsage, failedCall.usage);
    assert.equal(inspected.calls.at(-1).accounting.provider, "vscode");
    assert.equal(calls.length, callsBeforeInspect, "durable receipt inspection makes no model call");
    assert.deepEqual(provider.store.load(provider.chat.id, false), persistedBeforeInspect,
      "post-reply accounting is read from SQLite, never written over a possibly newer Chat");
    await assert.rejects(provider.readVisualization(provider.chat.id, "memoryReceipt", { messageId: "foreign-reply" }), /no recorded Memory turn/);
    failExtraction = false;

    const prepare = service.prepare, commit = service.commit;
    let invalidCommits = 0;
    try {
      service.prepare = async (scope, turn, input) => {
        const engine = await service.engine();
        const pending = await engine.request({ method: "turn_begin", params: { scope, turn, input, recent: [], budget_chars: 2000 } });
        assert.equal(pending.status, "model", "reproduce a persisted but unfinished intent phase");
        throw new Error("Fixture transport failed after turn_begin, before context was ready");
      };
      service.commit = async (...args) => { invalidCommits++; return commit.apply(service, args); };
      await provider.handle({ type: "send", text: "Keep answering if context preparation fails" });
      const unprepared = provider.chat.messages.at(-1);
      assert.equal(unprepared.status, "complete", "the main answer remains saved");
      assert.match(unprepared.memory.error, /transport failed after turn_begin/);
      assert.equal(invalidCommits, 0, "must not submit turn_commit for an unprepared turn");
      const result = provider.memoryCommitResults.get(unprepared.memory.turn);
      assert.equal(result.status, "skipped");
      assert.equal(result.reason, "context-not-prepared");
      assert.match(result.error, /transport failed after turn_begin/, "preserve original failure rather than replacing it with a commit error");
      assert.equal(provider.store.load(provider.chat.id, false).messages.at(-1).status, "complete");
    } finally { service.prepare = prepare; service.commit = commit; }

    provider.chat.includeHistory = false;
    provider.persist(provider.chat);
    const before = calls.length;
    await provider.handle({ type: "send", text: "History disabled" });
    assert.equal(provider.chat.messages.at(-1).memory, undefined);
    assert.equal(calls.length, before, "History off must skip both memory preparation and commit");
    const { configurePortalRuntime } = require("../dist/chatroom/portal-runtime");
    const { randomUUID } = require("node:crypto");
    const pairId = randomUUID(), requestId = randomUUID();
    let connected = true;
    configurePortalRuntime({ state: id => id === provider.chat.id ? { connected, binding: { role:"controller", pairId } } : undefined,
      permission: () => false, invalidate() {} });
    try {
      const chat = provider.chat;
      provider.running.set(chat.id, new AbortController());
      const queued = { id:randomUUID(), pairId, requestId, state:"waiting-input" };
      const payloadCount = payloads.length;
      await provider.receivePortalReview(chat.id, queued);
      assert.equal(payloads.length, payloadCount, "busy controller is not interrupted");
      assert.equal(provider.store.load(chat.id, false).queuedInputs.length, 1, "review is durably queued");
      const completed = { ...queued, id:randomUUID(), state:"completed" };
      await provider.receivePortalReview(chat.id, completed);
      assert.equal(chat.queuedInputs.length, 1, "newer status coalesces a pending event for the same request");
      assert.equal(chat.queuedInputs[0].portalReview.state, "completed");
      provider.running.delete(chat.id);
      await provider.drainQueue(chat);
      assert.equal(payloads.length, payloadCount + 1, "idle PKM controller is automatically resumed through the normal runner");
      const event = provider.store.load(chat.id, false).messages.find(message => message.portalReview?.id === completed.id);
      assert(event);
      assert.match(event.content, /Please check controlled chat status/);
      assert.match(event.content, new RegExp(requestId));
      await provider.receivePortalReview(chat.id, completed);
      assert.equal(payloads.length, payloadCount + 1, "consumed event must not run twice");
      chat.paused = true; provider.persist(chat);
      const paused = { id:randomUUID(), pairId, requestId:randomUUID(), state:"failed" };
      await provider.receivePortalReview(chat.id, paused);
      assert.equal(payloads.length, payloadCount + 1, "paused controller keeps the event without starting a model");
      assert.equal(provider.store.load(chat.id, false).queuedInputs[0].portalReview.id, paused.id);
      connected = false;
      await assert.rejects(provider.receivePortalReview(chat.id, { ...completed, id:randomUUID() }), /inactive controller/);
      chat.paused = false; provider.persist(chat);
      await assert.rejects(provider.drainQueue(chat), /disconnected or changed/);
      chat.queuedInputs = []; provider.persist(chat);
    } finally {
      provider.running.delete(provider.chat.id);
      configurePortalRuntime({ state:() => undefined, permission:() => false, invalidate() {} });
    }
    const apiClient = require("../dist/chat/api-chat-client");
    const originalApiStream = apiClient.streamApiChat, originalSettings = provider.settings, originalKey = provider.readApiKey;
    try {
      const settings = provider.settings(provider.chat);
      provider.settings = () => ({ ...settings, provider: "openai-compatible", model: "http-memory-fixture" });
      provider.vscodeModels = [];
      nativeClient.discoverVscodeModels = async () => [];
      provider.readApiKey = async () => "fixture-key";
      apiClient.streamApiChat = async (request, onText) => {
        request.onUsage({ inputTokens: 12, outputTokens: 4 });
        request.onUsage({ inputTokens: 12, outputTokens: 4 });
        onText('{"focus":[]}');
      };
      const modelRequest = { purpose: "intent", max_tokens: 400, messages: [{ role: "user", content: "Metadata fallback fixture" }] };
      const fallbackResult = await provider.runMemoryModel(provider.chat, modelRequest, new AbortController().signal, {});
      assert.equal(fallbackResult.accounting.provider, "http", "a missing configured native model must not label actual HTTP fallback as VS Code");
      assert.equal(fallbackResult.accounting.modelId, "http-memory-fixture");
      assert.deepEqual(fallbackResult.usage, { inputTokens: 12, outputTokens: 4 }, "repeated per-call usage snapshots are not summed");
      provider.readApiKey = async () => { throw new Error("Fixture credential unavailable"); };
      await assert.rejects(provider.runMemoryModel(provider.chat, modelRequest, new AbortController().signal, {}), error => {
        assert.match(error.message, /credential unavailable/);
        assert.equal(error.result.accounting, undefined, "credential failure is not fabricated as an actual provider inference");
        return true;
      });
    } finally {
      apiClient.streamApiChat = originalApiStream; provider.settings = originalSettings; provider.readApiKey = originalKey;
    }
    await service.forget(scope);
    assert.equal((await service.overview(scope)).topics.length, 0);
    console.log("Chat Memory controller tests passed: real Python/SQLite, lazy summary/reuse, topic switching, restored payload, failure receipt and History off.");
  } finally {
    provider.dispose();
    await provider.memory?.service.close();
    nativeClient.streamVscodeChat = originalStream;
    nativeClient.discoverVscodeModels = originalDiscovery;
  }
};
