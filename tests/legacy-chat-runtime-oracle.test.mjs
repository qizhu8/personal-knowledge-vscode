import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, rmSync } from "node:fs";
import Module, { createRequire } from "node:module";
import { isAbsolute, join, resolve } from "node:path";
import { runInNewContext } from "node:vm";
import test from "node:test";
import * as chat from "../dist/domain/chat-turn-original.js";
import * as runtime from "../dist/domain/runtime-process-original.js";
import { validateLegacyApiChatImages } from "../dist/legacy-api-chat-archive.js";
import { ModelConfigService } from "../dist/model-config.js";
import { ModelProviderService } from "../dist/model-provider.js";
import { createChatTurnModelPort } from "../dist/chat-turn-adapters.js";
import { estimateChatPromptTokens } from "../dist/domain/chat-prompt-budget.js";
import { chatTurnFixture, chatTurnInput } from "./chat-turn-fixtures.mjs";

const original = process.env.PKM_LEGACY_422_PATH;
const require = createRequire(import.meta.url);
const digest = value => createHash("sha256").update(value).digest("hex");
const outcome = fn => {
  try { return ["ok", fn()]; } catch (error) { return ["error", error.name, error.message]; }
};

test("authenticated 4.0.22 reducers, service errors and tool-result boundaries", { skip: !original }, async t => {
  assert(isAbsolute(original));
  assert.equal(JSON.parse(readFileSync(join(original, "package.json"))).version, "4.0.22");
  for (const [file, hash] of [
    ["chat/api-chat-client.js", "b267eab787daa14cb2af1f93efec3ab460cfd0edd289a94ab439997e7c9ba874"],
    ["chat/api-chat-view.js", "e6d28981611a137a826d429128947d1b88e827641a034c22037a125cef4485f2"],
    ["chat/chat-tool-execution.js", "e6be9aa606bf82fe9e2552e821c7628a34ea9933b0a68e66d977948a6fa4eab6"],
    ["chat/chat-process-runtime.js", "467ebe7f0ff4bb64121c167c898a209ac4cb74a7a3d378f957c2ab8c2bc7c268"],
    ["runtime/pkm-service.js", "4d2ab4ffe63d50965f83911b2b8d67e9bf96e6281e40e3bf4fc4ceb5cd8d94ea"],
  ]) assert.equal(digest(readFileSync(join(original, "dist", file))), hash, file);
  const oldChat = require(join(original, "dist/chat/api-chat-client.js"));
  const oldRuntime = require(join(original, "dist/runtime/pkm-service.js"));
  const { executeChatToolBatch } = require(join(original, "dist/chat/chat-tool-execution.js"));
  const { getChatProcess } = require(join(original, "dist/chat/chat-process-runtime.js"));
  const load = Module._load;
  let ApiChatView;
  try {
    Module._load = function (id, parent, isMain) {
      if (id === "vscode") return { EventEmitter: class { constructor() { this.event = () => {}; } } };
      return load.call(this, id, parent, isMain);
    };
    ({ ApiChatView } = require(join(original, "dist/chat/api-chat-view.js")));
  } finally {
    Module._load = load;
  }
  const host = { running: new Map(), queueDrains: new Set(), captureExecution() { throw new Error("admitted"); } };
  for (const [text, message] of [
    ["汉".repeat(12000), "admitted"],
    ["x".repeat(16000), "admitted"],
    ["😀".repeat(8000), "admitted"],
    ["x".repeat(16001), "Enter a message up to 16,000 characters."],
    ["😀".repeat(8000) + "x", "Enter a message up to 16,000 characters."],
  ]) await assert.rejects(ApiChatView.prototype.send.call(host, text, { id: "synthetic" }), { message });
  const badHandle = outcome(() => getChatProcess("/synthetic-unused", "invalid"));
  assert.deepEqual(badHandle, ["error", "Error", "Choose an exact process handle returned by run_process."]);
  const invalidMessages = [], invalidEvents = [];
  await executeChatToolBatch([{ id: "call-1", function: { name: "process_get", arguments: '{"handle":"invalid"}' } }],
    { tools: [{ name: "process_get", execute: async args => getChatProcess("/synthetic-unused", args.handle) }],
      onTool: event => invalidEvents.push(event) }, invalidMessages,
    { summarizing: false, beforeRound: async () => {}, reuse: () => null, remember() {}, record() {} },
    new AbortController().signal, 0);
  assert.equal(invalidEvents.at(-1).status, "failed");
  assert.deepEqual(JSON.parse(invalidMessages[0].content), { error: badHandle[2] });
  for (const value of [undefined, 0, -1, 1, 2, 30, 1000, 1001, 1.5, NaN, "2", null])
    assert.deepEqual(outcome(() => oldChat.chatToolRoundLimit(value)), outcome(() => chat.chatToolRoundLimit(value)));
  for (const [completed, limit] of [[0, undefined], [0, 2], [1, 2], [2, 2], [3, 2], [-1, 2], [27, 30], [30, 30]])
    assert.deepEqual(outcome(() => oldChat.chatToolRoundBudgetNotice(completed, limit)),
      outcome(() => chat.chatToolRoundBudgetNotice(completed, limit)));
  for (const name of ["PKM_SERVICE_PROTOCOL", "PKM_SERVICE_MAX_MESSAGE_BYTES"])
    assert.equal(oldRuntime[name], runtime[name]);
  for (const [name, args] of [
    ["PkmServiceVersionError", ["4.0.22", "4.0.21"]],
    ["PkmServiceOfflineError", []],
    ["PkmServiceExecutionUncertainError", []],
    ["PkmServiceRecoveryPersistenceError", ["op", "target", "success", undefined, new Error("synthetic"), "receipt", "synthetic.json"]],
  ]) {
    const old = new oldRuntime[name](...args), next = new runtime[name](...args);
    for (const field of ["name", "message", "serviceShouldRetry", "recoveryAvailable"])
      assert.equal(old[field], next[field], `${name}.${field}`);
  }
  for (const value of ["x".repeat(16000), "x".repeat(16001), "汉".repeat(12000), 42]) {
    const messages = [], events = [];
    const loop = { summarizing: false, beforeRound: async () => {}, reuse: () => null, remember() {}, record() {} };
    await executeChatToolBatch([{ id: "call-1", function: { name: "tool", arguments: "{}" } }],
      { tools: [{ name: "tool", execute: async () => value }], onTool: event => events.push(event) },
      messages, loop, new AbortController().signal, 0);
    const fixture = chatTurnFixture({
      model: { available: true, async *stream(request) {
        if (request.step === 1) {
          yield { type: "tool", id: "call-1", name: "tool", arguments: {} };
          yield { type: "finish", reason: "tool_calls" };
        } else {
          assert.equal(request.messages.at(-1).content, messages[0].content);
          yield { type: "text", text: "done" };
          yield { type: "finish", reason: "stop" };
        }
      } },
      tools: { available: true, async execute() { return { executionId: "execution-1", content: value }; } },
    });

    t.after(() => fixture.db.close());
    const input = chatTurnInput(), actor = "oracle-actor";
    fixture.service.start(actor, input);
    const done = await fixture.service.settled(actor, input.id);
    assert.equal(done.status, "completed", JSON.stringify(done));
    const event = fixture.service.events(actor, input.id).events.find(item => item.type === "tool-complete");
    assert.equal(event.data.resultStatus, events.at(-1).status);
  }
});

test("4.0.22 and Next admit the same exact prompt budget without truncation", { skip: !original }, async t => {
  const file = join(original, "dist/chat/api-chat-models.js");
  assert.equal(digest(readFileSync(file)), "2a6cdd1f6cebe0731de04264c7758a3864b98d44d51cafecd778e88e35423edb");
  const old = require(file);
  const { chatToolRoundBudgetNotice, streamApiChat } = require(join(original, "dist/chat/api-chat-client.js"));
  const notice = chatToolRoundBudgetNotice(0, 4);
  const tool = { name: "lookup", description: "例", parameters: { type: "object", properties: {} } };
  const withCalls = [{ role: "assistant", content: "quoted \"😀\"", tool_calls: [
    { id: "c", type: "function", function: { name: "lookup", arguments: "{\"x\":\"汉\"}" } },
  ] }];
  assert.equal(estimateChatPromptTokens(withCalls, [tool]), old.estimateInputTokens(
    [...withCalls, { role: "system", content: JSON.stringify([tool]) }]));
  let calls = 0;
  let observed;
  const modelConfig = new ModelConfigService({
    configuration: { aiEndpoint: "https://synthetic.invalid/v1", aiModel: "synthetic",
      apiChatModelProfiles: [{ id: "synthetic", status: "active", contextWindow: 2048, maxOutputTokens: 128 }] },
    secretResolver: { resolveSecret: async () => ({}) }, registryAvailability: { "openai-compatible": true },
  });
  const provider = new ModelProviderService({ modelConfig, transport: {
    supports: name => name === "openai-compatible",
    async open(request) {
      calls++; observed = request.payload.messages;
      return new ReadableStream({ start(controller) {
        controller.enqueue(new TextEncoder().encode('data: {"choices":[{"index":0,"delta":{"content":"ok"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n'));
        controller.close();
      } });
    },
  } });
  const fixture = chatTurnFixture({ model: createChatTurnModelPort(provider, { profileId: "synthetic", contextWindow: 2048 }) });
  t.after(() => fixture.db.close());
  for (const [length, expected] of [[1487, "completed"], [1488, "failed"]]) {
    const messages = [{ role: "user", content: "x".repeat(length) }];
    const oldMessages = [...messages, { role: "system", content: notice }];
    if (expected === "completed") assert.equal(old.validateBudget(
      { status: "active", contextWindow: 2048, maxOutputTokens: 128 }, 2048, 128, oldMessages), 1920);
    else assert.throws(() => old.validateBudget(
      { status: "active", contextWindow: 2048, maxOutputTokens: 128 }, 2048, 128, oldMessages), /Context budget exceeded/);
    let oldSends = 0;
    const oldRequest = streamApiChat({ endpoint: "http://127.0.0.1:1/v1", apiKey: "fixture", model: "synthetic",
      messages, signal: new AbortController().signal, maxOutputTokens: 128, hardToolRoundLimit: 4,
      beforeRound: async (round, output) => old.validateBudget(
        { status: "active", contextWindow: 2048, maxOutputTokens: 128 }, 2048, output, round),
      fetch: async (_url, init) => {
        oldSends++;
        const payload = JSON.parse(init.body);
        assert.deepEqual(payload.messages, oldMessages);
        return new Response('data: {"choices":[{"index":0,"delta":{"content":"ok"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n',
          { status: 200, headers: { "content-type": "text/event-stream" } });
      } }, () => {});
    if (expected === "completed") await oldRequest;
    else await assert.rejects(oldRequest, /Context budget exceeded/);
    assert.equal(oldSends, expected === "completed" ? 1 : 0);
    const input = chatTurnInput({ messages, maxInputTokens: 2048, maxOutputTokens: 128 });
    fixture.service.start("oracle-actor", input);
    const result = await fixture.service.settled("oracle-actor", input.id);
    assert.equal(result.status, expected, JSON.stringify(result));
    if (expected === "completed") assert.equal(observed.find(message => message.role === "user").content, messages[0].content);
    else assert.equal(result.failure, "MODEL_CONTEXT_BUDGET");
  }
  assert.equal(calls, 1);
});

test("4.0.22 and Next validate bounded image inputs consistently", { skip: !original }, () => {
  const file = join(original, "dist/chat/api-chat-client.js");
  assert.equal(digest(readFileSync(file)), "b267eab787daa14cb2af1f93efec3ab460cfd0edd289a94ab439997e7c9ba874");
  const { decodeChatImage } = require(file);
  const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/aN8AAAAASUVORK5CYII=", "base64");
  const image = { label: "synthetic.png", mimeType: "image/png", dataBase64: png.toString("base64") };
  assert.deepEqual(decodeChatImage(image), png);
  assert.doesNotThrow(() => validateLegacyApiChatImages([image]));
  const big = Buffer.from(png);
  big.writeUInt32BE(4001, 16); big.writeUInt32BE(4000, 20);
  const bigImage = { ...image, dataBase64: big.toString("base64") };
  const badJpeg = { label: "synthetic.jpg", mimeType: "image/jpeg", dataBase64: Buffer.from([255, 216, 255, 0]).toString("base64") };
  const exact = Buffer.from(png);
  exact.writeUInt32BE(4000, 16); exact.writeUInt32BE(4000, 20);
  const exactImage = { ...image, dataBase64: exact.toString("base64") };
  assert.doesNotThrow(() => decodeChatImage(exactImage));
  assert.doesNotThrow(() => validateLegacyApiChatImages([exactImage]));
  const jpeg = { label: "synthetic.jpg", mimeType: "image/jpeg",
    dataBase64: Buffer.from("ffd8ffe000104a46494600010100000100010000ffc0000b080001000101011100ffd9", "hex").toString("base64") };
  assert.doesNotThrow(() => decodeChatImage(jpeg));
  assert.doesNotThrow(() => validateLegacyApiChatImages([jpeg]));
  const maxBytes = Buffer.alloc(512 * 1024);
  png.copy(maxBytes);
  const maxImage = { ...image, dataBase64: maxBytes.toString("base64") };
  assert.equal(decodeChatImage(maxImage).length, maxBytes.length);
  assert.doesNotThrow(() => validateLegacyApiChatImages([maxImage]));
  const oversized = { ...image, dataBase64: Buffer.concat([maxBytes, Buffer.alloc(1)]).toString("base64") };
  for (const candidate of [bigImage, badJpeg, oversized, { ...image, dataBase64: "invalid" }, { ...image, mimeType: "image/jpeg" }]) {
    assert.throws(() => decodeChatImage(candidate));
    assert.throws(() => validateLegacyApiChatImages([candidate]));
  }
});

test("4.0.22 queue retries preserve one submission and reject altered content", { skip: !original }, t => {
  for (const [file, hash] of [
    ["api-chat-store.js", "fbbd08e270fd70c8dbe27238cbae1841113a175ee8e23c530ba6e0c44d2bb3e1"],
    ["execution-context.js", "f53c39225b1601b8c36b72cd6b11e7c1884cbd34bd032f30399db107b89b5641"],
  ]) assert.equal(digest(readFileSync(join(original, "dist/chat", file))), hash);
  const root = resolve("tests", `.old-queue-${randomUUID()}`);
  t.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(join(root, ".pkm/state"), { recursive: true, mode: 0o700 });
  const { ApiChatStore } = require(join(original, "dist/chat/api-chat-store.js"));
  const { captureExecutionContext } = require(join(original, "dist/chat/execution-context.js"));
  const store = new ApiChatStore(join(root, ".pkm/state"), "0123456789abcdef");
  const mask = process.umask(0o077);
  try {
    const chat = store.create();
    const executionContext = captureExecutionContext(randomUUID(), [], root, true, "ask");
    const input = { id: randomUUID(), text: "retained queue input", mode: "task", executionContext };
    const first = store.enqueueInput(chat, input);
    const retry = store.enqueueInput(chat, input);
    assert.equal(first.revision, retry.revision);
    assert.equal(retry.queuedInputs.length, 1);
    assert.throws(() => store.enqueueInput(chat, { ...input, text: "different" }), /identity was already used/);
    const otherContext = captureExecutionContext(randomUUID(), [], root, true, "ask");
    assert.throws(() => store.enqueueInput(chat, { ...input, executionContext: otherContext }), /identity was already used/);
  } finally { process.umask(mask); }
});

test("4.0.22 prepareRound retains steering on a budget failure and applies it on a later fitting attempt", { skip: !original }, async () => {
  for (const [file, hash] of [
    ["api-chat-view.js", "e6d28981611a137a826d429128947d1b88e827641a034c22037a125cef4485f2"],
    ["chat-context.js", "5a0cc2e5b555ae9ffab27655b86a5156281f1c305159ab0cfacb640ca12a940a"],
    ["api-chat-models.js", "2a6cdd1f6cebe0731de04264c7758a3864b98d44d51cafecd778e88e35423edb"],
  ]) assert.equal(digest(readFileSync(join(original, "dist/chat", file))), hash);
  const source = readFileSync(join(original, "dist/chat/api-chat-view.js"), "utf8");
  const start = source.indexOf("const prepareRound = () => {"), end = source.indexOf("const gate = enforceActivityBudget();", start);
  assert(start > 0 && end > start);
  const context = require(join(original, "dist/chat/chat-context.js"));
  const models = require(join(original, "dist/chat/api-chat-models.js"));
  const reply = { retrievalActivity: { droppedRounds: 0, rounds: [] } };
  const input = { id: randomUUID(), text: "STAY_QUEUED " + "x".repeat(9000), mode: "steer",
    attemptId: randomUUID(), executionContext: { digest: "same" } };
  const chatState = { id: randomUUID(), queuedInputs: [input], messages: [reply], sessionId: "session",
    progress: { attemptId: input.attemptId, status: "failed" } };
  const roundMessages = [{ role: "user", content: "original task" }], automatic = new Map(), toolSchema = [];
  let persists = 0;
  const sandbox = { controller: new AbortController(), chat: chatState, executionContext: input.executionContext,
    workflowSourceDigest: undefined, chat_work_goal_1: { newWorkGoal: /^never$/, workStop: /^never$/ },
    steeringMessages: new Map(), roundMessages, roundContext: undefined, toolSchema, settings: {
      contextWindow: 2048, maxOutputTokens: 1024, timeoutMs: 1000, loopReviewAfterMs: 1000, maxToolRounds: 4 },
    output: 1024, chat_context_1: context, automatic, contextPlanner: new context.ChatContextPlanner(roundMessages, automatic, toolSchema),
    requirementCandidates: [], requirementsActive: false, reply, workActive: false,
    chat_harness_records_1: { currentHarnessTaskState: () => undefined, currentHarnessTask: () => undefined },
    workingStateMessage: undefined, retrieval: undefined, contextMeasurement: undefined, baseline: undefined,
    text: "original task", profile: { id: "fixture" }, profileContext: undefined, api_chat_models_1: models,
    updateReceipt() {}, chat_budget_ledger_1: require(join(original, "dist/chat/chat-budget-ledger.js")),
    sampleWorkerBudget() {}, reviewClock: { snapshot: () => ({ activeMs: 0, elapsedMs: 0 }), now: () => 0 },
    startedAt: 0, crypto_1: { randomUUID }, publicOutputRound: 0, structuredClone,
    host: { assertExecution() {}, assertRunnable() {}, persist() { persists++; }, publish() {} },
  };
  const prepare = runInNewContext(`(function () { ${source.slice(start, end)} return prepareRound; }).call(host)`, sandbox);
  const { streamApiChat } = require(join(original, "dist/chat/api-chat-client.js"));
  let sends = 0;
  const run = () => streamApiChat({ endpoint: "http://127.0.0.1:1/v1", apiKey: "fixture", model: "synthetic",
    messages: [{ role: "user", content: "original task" }], signal: new AbortController().signal,
    maxOutputTokens: 1024, hardToolRoundLimit: 4, beforeRound: round => { sandbox.roundMessages = round; prepare(); },
    fetch: async (_url, init) => {
      sends++;
      assert.equal(persists, 1);
      assert.equal(chatState.queuedInputs.length, 0);
      assert(JSON.parse(init.body).messages.some(message => message.content === input.text));
      return new Response('data: {"choices":[{"index":0,"delta":{"content":"ok"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n',
        { status: 200, headers: { "content-type": "text/event-stream" } });
    } }, () => {});
  await assert.rejects(run(), /budget|context|token/i);
  assert.equal(persists, 0);
  assert.equal(sends, 0);
  assert.equal(chatState.queuedInputs.length, 1);
  assert.equal(chatState.messages.length, 1);
  const load = Module._load;
  let ApiChatView;
  try {
    Module._load = function (id, parent, isMain) {
      if (id === "vscode") return { EventEmitter: class { constructor() { this.event = () => {}; } } };
      return load.call(this, id, parent, isMain);
    };
    ({ ApiChatView } = require(join(original, "dist/chat/api-chat-view.js")));
  } finally { Module._load = load; }
  let explicitRecovery;
  await ApiChatView.prototype.drainQueue.call({ disposed: false, running: new Map(), queueDrains: new Set(),
    queueCancelled: new Set(), assertExecution(_chat, context) { assert.equal(context.digest, "same"); },
    async send(text, _chat, _parent, _retry, id, _events, _continuation, batch) {
      explicitRecovery = { text, id, batch };
    } }, chatState);
  assert.equal(explicitRecovery.id, input.id);
  assert.equal(explicitRecovery.text, input.text);
  assert.equal(explicitRecovery.batch[0].executionContext.digest, "same");
  sandbox.settings.contextWindow = 16384;
  await run();
  assert.equal(persists, 1);
  assert.equal(sends, 1);
  assert.equal(chatState.queuedInputs.length, 0);
  assert.equal(chatState.messages.find(message => message.submissionId === input.id)?.content, input.text);
});
