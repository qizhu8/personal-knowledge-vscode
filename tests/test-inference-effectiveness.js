const { test } = require("node:test");
const assert = require("node:assert/strict");
const { randomUUID } = require("node:crypto");
const { ChatToolScheduler, executeChatToolBatch } = require("../dist/chat/chat-tool-execution");
const { ChatToolLoopGuard, streamApiChat } = require("../dist/chat/api-chat-client");
const { chatEffectiveness } = require("../dist/chat/chat-effectiveness");
const { prepareWorkGoal, reportWork, workGoalInputs, rootWorkCriterion, validWorkGoal } = require("../dist/chat/chat-work-goal");
const { workerHandoff } = require("../dist/chat/worker-result-versions");
const { assertIndependentWorkerScopes, workerScope } = require("../dist/chat/worker-scope");
const signal = () => new AbortController().signal;
const call = (id, name, args = {}) => ({ id, type: "function", function: { name, arguments: JSON.stringify(args) } });
const tick = () => new Promise(resolve => setImmediate(resolve));
function deferred() { let resolve; const promise = new Promise(yes => { resolve = yes; }); return { promise, resolve }; }

test("independent reads overlap; a mutation is a FIFO barrier and results retain call order", async () => {
  const gate = deferred(), starts = [], finishes = [], events = [], messages = [];
  let reading = 0, maximum = 0;
  const read = { name: "read_file", execution: "parallel-read", execute: async args => {
    starts.push(args.id); maximum = Math.max(maximum, ++reading);
    await gate.promise; reading--; finishes.push(args.id); return JSON.stringify(args);
  } };
  const write = { name: "save_file", execute: async () => { assert.equal(reading, 0); starts.push("write"); return "saved"; } };
  const run = executeChatToolBatch([call("a", "read_file", { id: "a" }), call("b", "read_file", { id: "b" }),
    call("w", "save_file"), call("c", "read_file", { id: "c" })],
  { tools: [read, write], onTool: event => events.push(event) }, messages, new ChatToolLoopGuard({}), signal(), 0);
  await tick();
  assert.deepEqual(starts, ["a", "b"]); assert.equal(maximum, 2);
  gate.resolve(); await run;
  assert.deepEqual(starts, ["a", "b", "write", "c"]);
  assert.deepEqual(messages.map(item => item.tool_call_id), ["a", "b", "w", "c"]);
  assert(events.every(event => event.round === 0 && event.queuedMs >= 0));
  assert.deepEqual(finishes.sort(), ["a", "b", "c"]);
});

test("unannotated and external tools remain exclusive and concurrency is bounded", async () => {
  const scheduler = new ChatToolScheduler(2), gate = deferred(), starts = [];
  const read = { execution: "parallel-read" };
  const tasks = [1, 2, 3].map(id => scheduler.schedule(read, signal(), async () => { starts.push(id); await gate.promise; }));
  await tick(); assert.deepEqual(starts, [1, 2]);
  gate.resolve(); await Promise.all(tasks); await scheduler.drain();
  assert.deepEqual(starts, [1, 2, 3]);
  const serial = new ChatToolScheduler(), block = deferred(), ordered = [];
  const first = serial.schedule(undefined, signal(), async () => { ordered.push(1); await block.promise; });
  const second = serial.schedule(undefined, signal(), async () => { ordered.push(2); });
  await tick(); assert.deepEqual(ordered, [1]); block.resolve(); await Promise.all([first, second]);
  assert.deepEqual(ordered, [1, 2]);
});

test("cancelled batches do not launch pending mutations and preserve completed evidence", async () => {
  const controller = new AbortController(), gate = deferred(), events = [];
  let writes = 0;
  const run = executeChatToolBatch([call("r", "read_file"), call("w", "save_file")], {
    tools: [{ name: "read_file", execution: "parallel-read", execute: async () => gate.promise },
      { name: "save_file", execute: async () => { writes++; return "saved"; } }],
    onTool: event => events.push(event),
  }, [], new ChatToolLoopGuard({}), controller.signal, 0);
  await tick(); controller.abort();
  await assert.rejects(run, /cancelled/i);
  gate.resolve("late"); await tick(); assert.equal(writes, 0);
  assert(!events.some(event => event.id === "w" && event.status === "running"));
});

test("file read reuse checks version and visible evidence; mutable status is never cached", async () => {
  let version = "v1", reads = 0;
  const tool = { name: "read_file", readVersion: async () => version, execute: async () => JSON.stringify({ version, reads: ++reads }) };
  const messages = [], events = [], guard = new ChatToolLoopGuard({});
  const request = { tools: [tool], onTool: event => events.push(event) };
  await executeChatToolBatch([call("r1", "read_file")], request, messages, guard, signal(), 0);
  await executeChatToolBatch([call("r2", "read_file")], request, messages, guard, signal(), 1);
  assert.equal(reads, 1); assert.equal(events.at(-1).reused, true);
  version = "v2";
  await executeChatToolBatch([call("r3", "read_file")], request, messages, guard, signal(), 2);
  assert.equal(reads, 2); assert.equal(events.at(-1).reused, false);
  assert.equal(guard.reuse("session_info", "{}", messages), undefined);
  assert.equal(guard.reuse("search_text", "{}", messages), undefined);
  messages.length = 0;
  assert.equal(guard.reuse("read_file", "{}", messages, version), undefined);
});

test("three unchanged rounds detect stagnation even when arguments change; new evidence resets it", async () => {
  const notices = [], guard = new ChatToolLoopGuard({ maxToolRounds: 100,
    onToolLoopNotice: async notice => { notices.push(notice); return "summarize"; } });
  for (let round = 0; round < 4; round++) {
    await guard.beforeRound(round, signal());
    guard.record(undefined, "search_text", JSON.stringify({ page: round }), "same result");
  }
  await guard.beforeRound(4, signal());
  assert.equal(notices[0].reason, "no-progress"); assert.equal(guard.summarizing, true);
  const active = new ChatToolLoopGuard({ maxToolRounds: 100 });
  for (let round = 0; round < 20; round++) {
    await active.beforeRound(round, signal());
    active.record(undefined, "read_file", JSON.stringify({ page: round }), `new result ${round}`);
  }
  assert.equal(active.summarizing, false);
});

test("a second failed command triggers a strategy review, not acceptance; process heartbeats are not progress", async () => {
  const notices = [], guard = new ChatToolLoopGuard({ maxToolRounds: 100,
    onToolLoopNotice: async notice => { notices.push(notice); return "summarize"; } });
  await guard.beforeRound(0, signal());
  guard.record(undefined, "run_process", '{"program":"test"}', '{"exitCode":1,"stderr":"failed"}');
  await guard.beforeRound(1, signal());
  guard.record(undefined, "run_process", '{"program":"test"}', '{"exitCode":1,"stderr":"failed"}');
  await guard.beforeRound(2, signal());
  assert.equal(notices[0].reason, "repeated-failure");
  const heartbeats = new ChatToolLoopGuard({ maxToolRounds: 100 });
  for (let round = 0; round < 4; round++) {
    await heartbeats.beforeRound(round, signal());
    heartbeats.record(undefined, "process_get", "{}", JSON.stringify({ schema: "pkm.chat.process/v1", state: "running", updatedAt: round, stdoutBytes: 0 }));
  }
  await heartbeats.beforeRound(4, signal());
  assert.equal(heartbeats.summarizing, true);
});

test("effectiveness uses interval unions, keeps reported usage and leaves absent observations unknown", () => {
  const summary = chatEffectiveness({ budgetReceipts: [{ round: 0, status: "sent", ledger: {
    inferenceTiming: { startedAt: 100, finishedAt: 150 }, providerUsage: { inputTokens: 50, outputTokens: 4 },
  } }], toolCalls: [
    { id: "a", name: "read_file", arguments: "{}", result: "A", status: "complete", round: 0, startedAt: 150, finishedAt: 250 },
    { id: "b", name: "read_file", arguments: "{}", result: "B", status: "complete", round: 0, startedAt: 160, finishedAt: 200, reused: true },
    { id: "old", name: "old", status: "complete" },
  ] });
  assert.equal(summary.modelWallMs, 50); assert.equal(summary.toolWallMs, 100);
  assert.equal(summary.observedWallMs, 150); assert.equal(summary.reusedReads, 1);
  assert.equal(summary.unassignedTools, 1);
  assert.equal(summary.rounds[0].novelResults, 1);
  assert.deepEqual(summary.rounds[0].usage, { inputTokens: 50, outputTokens: 4 });
  assert.equal(chatEffectiveness({}).rounds.length, 0);
});

test("contracts persist phases without granting permissions; unresolved delivery and malformed contracts are rejected", () => {
  const input = { id: randomUUID(), role: "user", content: "Start a new task: implement the fixture.", status: "complete" };
  const chat = { includeHistory: true, messages: [input] };
  prepareWorkGoal(chat, input.id, input.content, "a".repeat(64));
  const reply = { inputId: input.id, toolCalls: [{ id: "test", name: "run_process", status: "complete", result: '{"exitCode":0}' }] };
  const report = { status: "continue", reason: "Implementing", nextAction: "Test", sourceInputIds: workGoalInputs(chat),
    acceptance: [{ criterion: rootWorkCriterion, verified: false, evidenceCallIds: [] }],
    contract: { scope: ["src/fixture.ts"], nonGoals: ["No installation"], stopWhen: "Fixture tests pass" }, phase: "implementing" };
  reportWork(chat, reply, report); assert(validWorkGoal(chat.workGoal));
  assert.throws(() => reportWork(chat, reply, { ...report, phase: "delivering" }), /Delivery requires/);
  assert.throws(() => reportWork(chat, reply, { ...report, contract: { scope: [] } }), /acceptance criteria/);
  reportWork(chat, reply, { ...report, status: "resolved", acceptance: [{ criterion: rootWorkCriterion, verified: true, evidenceCallIds: ["test"] }] });
  assert.equal(chat.workGoal.phase, "delivering");
});

test("declared sibling and active write scopes/resources cannot compete", () => {
  assertIndependentWorkerScopes([{ writeScope: ["src/a.ts"] }, { writeScope: ["tests/a.js"] }]);
  assert.throws(() => assertIndependentWorkerScopes([{ writeScope: ["src"] }, { writeScope: ["src/a.ts"] }]), /overlap/);
  assert.throws(() => assertIndependentWorkerScopes([{ resources: ["build-output"] }], [{ resources: ["build-output"] }]), /overlap/);
  assert.throws(() => assertIndependentWorkerScopes([{ writeScope: ["src\\a.ts"] }, { writeScope: ["src/a.ts"] }]), /overlap/);
  assert.throws(() => workerScope({ writeScope: ["../secret"] }), /relative|path/i);
  assert.throws(() => workerScope({ resources: ["build", "build"] }), /distinct/);
});

test("final worker validation requires a ready result and can pin its exact version", () => {
  const manager = { id: randomUUID(), workspaceNamespace: "a".repeat(16) };
  const attemptId = randomUUID(), record = { id: randomUUID(), chatId: randomUUID(), activityId: randomUUID(), attemptId, status: "complete" };
  const target = { id: record.chatId, workspaceNamespace: "a".repeat(16),
    workerActivity: { receiptId: record.id, id: record.activityId, attemptId, managerChatId: manager.id, state: "completed" },
    messages: [{ id: randomUUID(), role: "assistant", status: "complete", content: "Ready", progress: { attemptId } }] };
  const ready = workerHandoff(manager, record, target, true);
  assert(ready.ready); workerHandoff(manager, record, target, true, ready.workerVersion.sha256);
  target.messages[0].content = "Changed";
  assert.throws(() => workerHandoff(manager, record, target, true, ready.workerVersion.sha256), /version changed/);
  target.messages[0].status = "streaming";
  assert.throws(() => workerHandoff(manager, record, target, true), /not ready/);
});

test("HTTP production loop overlaps independent tool calls in a single inference round", { timeout: 5000 }, async () => {
  const gate = deferred(), started = [], payloads = [], events = [];
  const tools = ["first", "second"].map(name => ({ name, parameters: {}, description: name, execution: "parallel-read",
    execute: async () => { started.push(name); if (started.length === 2) gate.resolve(); await gate.promise; return name; } }));
  const encoder = new TextEncoder();
  const response = data => new Response(new ReadableStream({ start(controller) {
    controller.enqueue(encoder.encode(`data: ${JSON.stringify(data)}\n\ndata: [DONE]\n\n`)); controller.close();
  } }), { headers: { "Content-Type": "text/event-stream" } });
  await streamApiChat({ provider: "openai-compatible", endpoint: "http://127.0.0.1:1/v1", apiKey: "", model: "fixture",
    messages: [{ role: "user", content: "Read both" }], signal: signal(), tools, onTool: event => events.push(event),
    fetch: async (_url, init) => {
      payloads.push(JSON.parse(init.body));
      return payloads.length === 1 ? response({ choices: [{ delta: { tool_calls: tools.map((tool, index) => ({
        index, id: tool.name, type: "function", function: { name: tool.name, arguments: "{}" },
      })) }, finish_reason: "tool_calls" }] }) : response({ choices: [{ delta: { content: "Done" }, finish_reason: "stop" }] });
    } }, () => {});
  assert.equal(payloads.length, 2); assert.deepEqual(started, ["first", "second"]);
  assert.equal(events.filter(event => event.status === "complete").length, 2);
  assert.deepEqual(payloads[1].messages.filter(message => message.role === "tool").map(message => message.tool_call_id), ["first", "second"]);
});

test("native production loop also overlaps annotated reads and preserves the tool result identities", { timeout: 5000 }, async () => {
  const Module = require("node:module"), original = Module._load;
  class Text { constructor(value) { this.value = value; } }
  class Call { constructor(callId, name, input) { Object.assign(this, { callId, name, input }); } }
  class Result { constructor(callId, content) { Object.assign(this, { callId, content }); } }
  const host = { LanguageModelTextPart: Text, LanguageModelToolCallPart: Call, LanguageModelToolResultPart: Result,
    CancellationTokenSource: class { constructor() { this.token = {}; } cancel() {} dispose() {} },
    LanguageModelChatMessage: { User: content => ({ role: "user", content }), Assistant: content => ({ role: "assistant", content }) } };
  let streamVscodeChat;
  try {
    Module._load = function(name, ...args) { return name === "vscode" ? host : original.call(this, name, ...args); };
    ({ streamVscodeChat } = require("../dist/chat/api-chat-vscode"));
  } finally { Module._load = original; }
  const gate = deferred(), starts = [], requests = [];
  const tools = ["first", "second"].map(name => ({ name, parameters: {}, description: name, execution: "parallel-read",
    execute: async () => { starts.push(name); if (starts.length === 2) gate.resolve(); await gate.promise; return name; } }));
  const model = { id: "fixture", vendor: "copilot", maxInputTokens: 32768, capabilities: { toolCalling: true },
    sendRequest: async messages => {
      requests.push(messages);
      return { stream: (async function* () {
        if (requests.length === 1) { yield new Call("a", "first", {}); yield new Call("b", "second", {}); }
        else yield new Text("Done");
      })() };
    } };
  await streamVscodeChat(model, { messages: [{ role: "user", content: "Read both" }], signal: signal(), tools,
    contextWindow: 32768, maxOutputTokens: 1024 }, () => {}, host);
  assert.equal(requests.length, 2); assert.deepEqual(starts, ["first", "second"]);
  const resultIds = requests[1].flatMap(message => Array.isArray(message.content) ? message.content : [])
    .filter(part => part instanceof Result).map(part => part.callId);
  assert.deepEqual(resultIds, ["a", "b"]);
});
