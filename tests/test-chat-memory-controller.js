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
  nativeClient.discoverVscodeModels = async () => models;
  nativeClient.streamVscodeChat = async (_model, request, onText) => {
    if (request.purpose !== "memory") {
      payloads.push(request.messages);
      onText(payloads.length === 1 ? answer : "Fixture response.");
      return;
    }
    assert.deepEqual(request.tools, []);
    assert.strictEqual(request.timeoutMs, 1_800_000, "Memory uses Chat inactivity timeout without a hidden two-minute cap");
    assert.strictEqual(request.thinkingBudget, 2048, "Memory steps use the default thinking budget");
    const system = request.messages[0].content;
    const purpose = system.includes("CURRENT user input") ? "intent" : system.includes("Extract at most") ? "extract" : "summary";
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
    const first = await send("Review memory design");
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
    failExtraction = false;

    provider.chat.includeHistory = false;
    provider.persist(provider.chat);
    const before = calls.length;
    await provider.handle({ type: "send", text: "History disabled" });
    assert.equal(provider.chat.messages.at(-1).memory, undefined);
    assert.equal(calls.length, before, "History off must skip both memory preparation and commit");
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
