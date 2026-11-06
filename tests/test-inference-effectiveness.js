const { test } = require("node:test");
const assert = require("node:assert/strict");
const { randomUUID } = require("node:crypto");
const { ChatToolScheduler, executeChatToolBatch } = require("../dist/chat/chat-tool-execution");
const { ChatToolLoopGuard, streamApiChat } = require("../dist/chat/api-chat-client");
const { chatEffectiveness, ChatExplorationAdvisory } = require("../dist/chat/chat-effectiveness");
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

test("complete replace_text no-ops cannot reset stagnation; changed or unknown receipts remain observations", async () => {
  const { isReplaceTextNoop } = require("../dist/chat/chat-effectiveness");
  const hashA = "a".repeat(64), hashB = "b".repeat(64);
  const receipt = (beforeHash, afterHash, round, counts = true) => JSON.stringify({
    applied: true, path: "fixture.txt", workspace: 0, appliedAt: new Date(Date.UTC(2026, 0, round + 1)).toISOString(),
    saved: false, attribution: "exact", ...(counts === false ? {} : typeof counts === "object"
      ? { added: counts.added, removed: counts.removed } : { added: round + 1, removed: round }), beforeHash, afterHash,
  });
  const notices = [], guard = new ChatToolLoopGuard({ maxToolRounds: 100,
    onToolLoopNotice: async notice => { notices.push(notice); return "summarize"; } });
  const messages = [], request = { tools: [{ name: "replace_text", execute: async args => receipt(hashA, hashA, args.round) }] };
  for (let round = 0; round < 3; round++) {
    assert.equal(notices.length, 0);
    await guard.beforeRound(round, signal());
    assert.equal(notices.length, 0);
    await executeChatToolBatch([call(`noop-${round}`, "replace_text", { round })], request, messages, guard, signal(), round);
    assert.equal(notices.length, 0);
  }
  await guard.beforeRound(3, signal());
  assert.equal(notices.length, 1);
  assert.equal(notices[0].reason, "no-progress");

  const recoveryNotices = [], recovering = new ChatToolLoopGuard({ maxToolRounds: 100,
    onToolLoopNotice: async notice => { recoveryNotices.push(notice); return "summarize"; } });
  const changing = { tools: [{ name: "replace_text", execute: async args => args.round === 2
    ? receipt(hashA, hashB, args.round, false) : receipt(hashA, hashA, args.round) }] };
  for (let round = 0; round < 6; round++) {
    assert.equal(recoveryNotices.length, 0);
    await recovering.beforeRound(round, signal());
    assert.equal(recoveryNotices.length, 0);
    await executeChatToolBatch([call(`mixed-${round}`, "replace_text", { round })], changing, [], recovering, signal(), round);
    assert.equal(recoveryNotices.length, 0);
  }
  await recovering.beforeRound(6, signal());
  assert.equal(recoveryNotices.length, 1);
  assert.equal(recoveryNotices[0].reason, "no-progress");

  assert.equal(isReplaceTextNoop("replace_text", receipt(hashA, hashA, 0), true), true);
  assert.equal(isReplaceTextNoop("replace_text", receipt(hashA, hashB, 0, false), true), false);
  assert.equal(isReplaceTextNoop("replace_text", receipt("bad", "bad", 0), true), false);
  assert.equal(isReplaceTextNoop("replace_text", receipt(undefined, undefined, 0), true), false);
  assert.equal(isReplaceTextNoop("replace_text", receipt(hashA, hashA, 0), false), false);

  const result = result => ({ name: "replace_text", result, status: "complete", round: 0 });
  const failure = { name: "replace_text", result: receipt(hashA, hashA, 0), status: "failed", round: 0 };
  const effectiveness = chatEffectiveness({ budgetReceipts: [{ round: 0, status: "sent" }], toolCalls: [
    result(receipt(hashA, hashA, 0)), result(receipt(hashA, hashB, 1, false)),
    result(receipt(hashA, hashB, 3, { added: 0, removed: 0 })), result(receipt("malformed", "malformed", 2)),
    result(JSON.stringify({ applied: true })), failure,
  ] });
  assert.equal(effectiveness.rounds[0].novelResults, 4);
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

test("effectiveness distinguishes unknown clocks from measured zero, including summary projections", () => {
  const { chatEffectivenessSummary } = require("../dist/chat/chat-effectiveness");
  const budget = timing => ({ round: 0, status: "sent", ledger: { inferenceTiming: timing } });
  const tool = timing => ({ id: "running", name: "read_file", status: "running", round: 0, ...timing });
  const check = (message, model, tools, observed, roundTools) => {
    for (const result of [chatEffectiveness(message), chatEffectivenessSummary(message)]) {
      assert.equal(result.modelWallMs, model);
      assert.equal(result.toolWallMs, tools);
      assert.equal(result.observedWallMs, observed);
      if (result.rounds.length) assert.equal(result.rounds[0].toolWallMs, roundTools);
    }
  };
  check({}, undefined, undefined, undefined);
  check({ budgetReceipts: [budget(undefined)] }, undefined, undefined, undefined, 0);
  check({ budgetReceipts: [budget(undefined)], toolCalls: [tool({})] },
    undefined, undefined, undefined, undefined);

  // Exact production reproduction: neither running clock has a finished observation.
  const unfinished = { budgetReceipts: [budget({ startedAt: 10 })], toolCalls: [tool({ startedAt: 20 })] };
  check(unfinished, undefined, undefined, undefined, undefined);
  assert.strictEqual(chatEffectiveness(unfinished).rounds[0].inference,
    unfinished.budgetReceipts[0].ledger.inferenceTiming);
  assert.equal(unfinished.toolCalls[0].finishedAt, undefined);

  for (const timing of [
    { startedAt: NaN, finishedAt: 30 }, { startedAt: 10, finishedAt: NaN },
    { startedAt: Infinity, finishedAt: 30 }, { startedAt: 10, finishedAt: Infinity },
    { startedAt: 30, finishedAt: 10 },
  ]) {
    check({ budgetReceipts: [budget(timing)], toolCalls: [tool(timing)] },
      undefined, undefined, undefined, undefined);
  }
  check({ budgetReceipts: [budget({ startedAt: 10, finishedAt: 10 })],
    toolCalls: [tool({ startedAt: 20, finishedAt: 20 })] }, 0, 0, 0, 0);
});

test("effectiveness unions only completed valid observations, not gaps or unfinished clocks", () => {
  const { chatEffectivenessSummary } = require("../dist/chat/chat-effectiveness");
  const message = { budgetReceipts: [
    { round: 0, status: "sent", ledger: { inferenceTiming: { startedAt: 100, finishedAt: 150 } } },
    { round: 1, status: "sent", ledger: { inferenceTiming: { startedAt: 120, finishedAt: 180 } } },
    { round: 2, status: "sent", ledger: { inferenceTiming: { startedAt: 1 } } },
  ], toolCalls: [
    { id: "a", name: "read_file", status: "complete", round: 0, startedAt: 160, finishedAt: 200 },
    { id: "b", name: "read_file", status: "complete", round: 0, startedAt: 190, finishedAt: 220 },
    { id: "c", name: "read_file", status: "complete", round: 0, startedAt: 300, finishedAt: 310 },
    { id: "running", name: "read_file", status: "running", round: 0, startedAt: 0 },
    { id: "invalid", name: "read_file", status: "failed", round: 0, startedAt: 0, finishedAt: Infinity },
  ] };
  for (const result of [chatEffectiveness(message), chatEffectivenessSummary(message)]) {
    assert.equal(result.modelWallMs, 80);
    assert.equal(result.toolWallMs, 70);
    assert.equal(result.observedWallMs, 130);
    assert.equal(result.rounds[0].toolWallMs, 70);
    assert.equal(result.rounds[1].toolWallMs, 0);
    assert.equal(result.rounds[2].toolWallMs, 0);
  }
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

test("startup and inter-round spans use exact boundaries and union coverage, not causal guesses", () => {
  const { chatEffectivenessSummary } = require("../dist/chat/chat-effectiveness");
  const message = { progress:{ startedAt:10 }, budgetReceipts:[
    { round:0, at:30, transport:{ sdkSetupTiming:{
      clientAcquisition:{ startedAt:40, finishedAt:47 }, sessionCreation:{ startedAt:50, finishedAt:61 },
    } }, ledger:{ inferenceTiming:{ startedAt:100, finishedAt:120 } } },
    { round:1, at:180, ledger:{ inferenceTiming:{ startedAt:200, finishedAt:220 } } },
  ], toolCalls:[
    { round:0, startedAt:110, finishedAt:150 },
    { round:0, startedAt:140, finishedAt:170 },
    { round:0, startedAt:300, finishedAt:310 },
  ] };
  for (const result of [chatEffectiveness(message), chatEffectivenessSummary(message)]) {
    assert.deepEqual(result.startupTiming, {
      attemptToFirstBudgetMs:20, attemptToFirstModelStartMs:90, firstBudgetToFirstModelStartMs:70,
      sdkSetup:{ availability:"available", clientAcquisitionMs:7, sessionCreationMs:11 },
    });
    assert.deepEqual(result.interRoundGaps, [
      { fromRound:0, toRound:1, elapsedMs:80, completedToolUnionMs:50, unobservedMs:30 },
    ]);
  }
  message.toolCalls = [{ round:0, startedAt:300, finishedAt:310 }];
  assert.equal(chatEffectiveness(message).interRoundGaps[0].completedToolUnionMs, 0);
  assert.equal(chatEffectiveness(message).interRoundGaps[0].unobservedMs, 80);
  message.toolCalls.push({ round:0, startedAt:130 });
  assert.equal(chatEffectiveness(message).interRoundGaps[0].unobservedMs, undefined);
  message.toolCalls = [];
  assert.equal(chatEffectiveness(message).interRoundGaps[0].unobservedMs, 80);
  message.budgetReceipts[1].round = 2;
  assert.equal(chatEffectiveness(message).interRoundGaps[0].unobservedMs, undefined);
});

test("timing projections preserve measured zero, partial SDK clocks and genuinely missing startup", () => {
  const { chatEffectivenessSummary } = require("../dist/chat/chat-effectiveness");
  const message = { progress:{ startedAt:0 }, budgetReceipts:[
    { round:0, at:0, transport:{ sdkSetupTiming:{
      clientAcquisition:{ startedAt:0, finishedAt:0 }, sessionCreation:{ startedAt:2, finishedAt:1 },
    } }, ledger:{ inferenceTiming:{ startedAt:0, finishedAt:0 } } },
  ] };
  for (const result of [chatEffectiveness(message), chatEffectivenessSummary(message)]) {
    assert.equal(result.startupTiming.attemptToFirstBudgetMs, 0);
    assert.equal(result.startupTiming.attemptToFirstModelStartMs, 0);
    assert.deepEqual(result.startupTiming.sdkSetup, {
      availability:"partial", clientAcquisitionMs:0, sessionCreationMs:undefined,
    });
  }
  for (const timing of [{ startedAt:NaN, finishedAt:1 }, { startedAt:2, finishedAt:1 }, { startedAt:1, finishedAt:Infinity }]) {
    const result = chatEffectiveness({ progress:{ startedAt:0 }, budgetReceipts:[{ round:0, ledger:{ inferenceTiming:timing } }] });
    assert.equal(result.startupTiming.attemptToFirstModelStartMs, undefined);
  }
  assert.equal(chatEffectiveness({}).startupTiming.sdkSetup.availability, "unavailable");
});

test("long histories keep the original startup while bounding full and compact gap exports", () => {
  const { chatEffectivenessSummary } = require("../dist/chat/chat-effectiveness");
  const message = { progress:{ startedAt:0 }, budgetReceipts:Array.from({ length:30 }, (_, round) => ({
    round, at:round * 100 + 5, ledger:{ inferenceTiming:{ startedAt:round * 100 + 10, finishedAt:round * 100 + 20 } },
  })) };
  const full = chatEffectiveness(message), compact = chatEffectivenessSummary(message);
  assert.equal(full.startupTiming.attemptToFirstModelStartMs, 10);
  assert.equal(compact.startupTiming.attemptToFirstModelStartMs, 10);
  assert.equal(full.interRoundGaps.length, 19);
  assert.equal(full.omittedInterRoundGaps, 10);
  assert.equal(compact.interRoundGaps.length, 4);
  assert.equal(compact.omittedInterRoundGaps, 25);
});

test("batch context runs once after ordered raw results despite reverse completion", async () => {
  const gate = deferred(), messages = [], finished = [];
  let batches = 0, legacy = 0;
  const raw = { one:'{"value":"one 中文"}', two:'{"value":"two"}' };
  const request = {
    tools:[{ name:"read_file", execution:"parallel-read", execute:async args => {
      if (args.id === "one") await gate.promise;
      else setImmediate(gate.resolve);
      finished.push(args.id);
      return raw[args.id];
    } }],
    onToolResultContext:() => { legacy++; return "legacy"; },
    onToolResultsContext:events => {
      batches++;
      assert.deepEqual(events.map(event => event.id), ["one", "two"]);
      assert.deepEqual(messages, [
        { role:"tool", content:raw.one, tool_call_id:"one" },
        { role:"tool", content:raw.two, tool_call_id:"two" },
      ]);
      return JSON.stringify({ ids:events.map(event => event.id) });
    },
  };
  await executeChatToolBatch([call("one", "read_file", { id:"one" }), call("two", "read_file", { id:"two" })],
    request, messages, new ChatToolLoopGuard({}), signal(), 0);
  assert.deepEqual(finished, ["two", "one"]);
  assert.equal(batches, 1);
  assert.equal(legacy, 0);
  assert.deepEqual(messages[2], { role:"system", content:'{"ids":["one","two"]}' });
});

test("batch context never falls back to legacy and ignores failed terminal tools", async () => {
  const messages = [], batches = [];
  let legacy = 0;
  const request = {
    tools:[
      { name:"read_file", execute:async () => "unchanged" },
      { name:"run_process", execute:async () => { throw new Error("expected failure"); } },
    ],
    onToolResultContext:() => { legacy++; return "legacy"; },
    onToolResultsContext:events => { batches.push(events.map(event => event.id)); return undefined; },
  };
  await executeChatToolBatch([call("good", "read_file"), call("bad", "run_process")],
    request, messages, new ChatToolLoopGuard({}), signal(), 0);
  assert.deepEqual(batches, [["good"]]);
  assert.equal(legacy, 0);
  assert.deepEqual(messages, [
    { role:"tool", content:"unchanged", tool_call_id:"good" },
    { role:"tool", content:'{"error":"expected failure"}', tool_call_id:"bad" },
  ]);
  await executeChatToolBatch([call("only-bad", "run_process")],
    request, [], new ChatToolLoopGuard({}), signal(), 0);
  assert.deepEqual(batches, [["good"]]);
});

test("batch metadata errors preserve successful original receipts without legacy fallback", async () => {
  for (const callback of [() => "x".repeat(2001), () => "", () => { throw new Error("metadata fixture failure"); }, null]) {
    const messages = [], events = [];
    let legacy = 0;
    await assert.rejects(executeChatToolBatch([call("kept", "run_process")], {
      tools:[{ name:"run_process", execute:async () => '{"exitCode":0}' }],
      onTool:event => events.push(event),
      onToolResultContext:() => { legacy++; return "legacy"; },
      onToolResultsContext:callback,
    }, messages, new ChatToolLoopGuard({}), signal(), 0), /Host tool-result context|metadata fixture failure|not a function/);
    assert.deepEqual(messages, [{ role:"tool", content:'{"exitCode":0}', tool_call_id:"kept" }]);
    assert.equal(events.at(-1).status, "complete");
    assert.equal(events.at(-1).result, '{"exitCode":0}');
    assert.equal(legacy, 0);
  }
});

test("Host result context is separate from unchanged evidence and rejects invalid metadata explicitly", async () => {
  const messages = [], events = [], raw = '{"exitCode":0}';
  const request = {
    tools:[{ name:"run_process", execute:async () => raw }],
    onTool:event => events.push(event),
    onToolResultContext:event => event.status === "complete" ? JSON.stringify({ evidence:{ id:event.id } }) : undefined,
  };
  await executeChatToolBatch([call("validation", "run_process")], request, messages, new ChatToolLoopGuard({}), signal(), 0);
  assert.deepEqual(messages, [
    { role:"tool", content:raw, tool_call_id:"validation" },
    { role:"system", content:'{"evidence":{"id":"validation"}}' },
  ]);
  assert.equal(events.at(-1).result, raw);
  await assert.rejects(executeChatToolBatch([call("kept", "run_process")],
    { ...request, onToolResultContext:() => "x".repeat(2001) }, [], new ChatToolLoopGuard({}), signal(), 0), /Host tool-result context/);
  assert.equal(events.at(-1).status, "complete", "Metadata failure must not rewrite a successful original tool effect");
  assert.equal(events.at(-1).result, raw);
});

test("HTTP can validate and report with exact Host identity without a session_info round", async () => {
  const { workEvidenceHint } = require("../dist/chat/chat-work-goal");
  const input = { id:randomUUID(), role:"user", content:"Please implement the fixture.", status:"complete" };
  const chat = { includeHistory:true, messages:[input] };
  prepareWorkGoal(chat, input.id, input.content, "a".repeat(64));
  const reply = { id:randomUUID(), role:"assistant", inputId:input.id, toolCalls:[] };
  chat.messages.push(reply);
  let requests = 0;
  const tools = [
    { name:"run_process", description:"Validate", parameters:{ type:"object" }, execute:async () => '{"exitCode":0}' },
    { name:"report_work", description:"Record", parameters:{ type:"object" }, execute:async args => reportWork(chat, reply, args) },
  ];
  await streamApiChat({
    provider:"openai-compatible", endpoint:"https://fixture.invalid", apiKey:"fixture", model:"fixture",
    messages:[{ role:"user", content:input.content }], signal:signal(), tools,
    onTool:event => {
      const current = reply.toolCalls.find(call => call.id === event.id);
      if (current) Object.assign(current, event); else reply.toolCalls.push({ ...event });
    },
    onToolResultContext:event => workEvidenceHint(chat, reply, event.id),
    fetch:async (_, options) => {
      const payload = JSON.parse(options.body), round = requests++;
      let delta;
      if (round === 0) delta = { tool_calls:[{ index:0, id:"validated", type:"function", function:{ name:"run_process", arguments:"{}" } }] };
      else if (round === 1) {
        const hint = payload.messages.filter(message => message.role === "system")
          .map(message => { try { return JSON.parse(message.content); } catch { return undefined; } })
          .find(value => value?.schema === "pkm.chat.work-evidence-hint/v1");
        assert.equal(hint.evidence.id, "validated");
        delta = { tool_calls:[{ index:0, id:"reported", type:"function", function:{ name:"report_work", arguments:JSON.stringify({
          status:"resolved", reason:"The fixture passed.", sourceInputIds:workGoalInputs(chat),
          acceptance:[{ criterion:rootWorkCriterion, verified:true, evidenceCallIds:[hint.evidence.id] }],
        }) } }] };
      } else delta = { content:"Done." };
      const chunk = { choices:[{ delta, finish_reason:round < 2 ? "tool_calls" : "stop" }] };
      return new Response(`data: ${JSON.stringify(chunk)}\n\ndata: [DONE]\n\n`, { status:200, headers:{ "Content-Type":"text/event-stream" } });
    },
  }, () => {});
  assert.equal(requests, 3);
  assert.equal(chat.workGoal.status, "resolved");
  assert.deepEqual(reply.toolCalls.map(call => call.name), ["run_process", "report_work"]);
  assert.equal(reply.toolCalls[0].result, '{"exitCode":0}');
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

test("exploration advisory triggers at eight completed reads across three rounds and exposes no tool contents", () => {
  const advisory = new ChatExplorationAdvisory();
  const read = (id, round) => ({ id, name: "read_file", status: "complete", reused: false, round,
    arguments: "ARGUMENT_SECRET", result: "RESULT_SECRET" });
  for (let index = 0; index < 7; index++) assert.equal(advisory.observe(read(`r${index}`, index % 3)), undefined);
  const hint = advisory.observe(read("r7", 2));
  assert.equal(typeof hint, "string");
  assert(hint.length <= 700);
  assert.match(hint, /narrow next check/);
  assert.doesNotMatch(hint, /ARGUMENT_SECRET|RESULT_SECRET/);
});

test("many reads in one or two rounds do not trigger; reused, failed, and invalid-round reads do not count", () => {
  const sameRound = new ChatExplorationAdvisory();
  for (let index = 0; index < 20; index++) assert.equal(sameRound.observe({ id: `same-${index}`, name: "search_text", status: "complete", round: 4 }), undefined);
  const twoRounds = new ChatExplorationAdvisory();
  for (let index = 0; index < 20; index++) assert.equal(twoRounds.observe({ id: `two-${index}`, name: "find_files", status: "complete", round: index % 2 }), undefined);

  const advisory = new ChatExplorationAdvisory();
  for (const [id, round] of [["missing", undefined], ["negative", -1], ["fraction", 1.5], ["unsafe", Number.MAX_SAFE_INTEGER + 1]]) {
    assert.equal(advisory.observe({ id, name: "read_file", status: "complete", round }), undefined);
  }
  assert.equal(advisory.observe({ id: "reused", name: "read_file", status: "complete", reused: true, round: 0 }), undefined);
  assert.equal(advisory.observe({ id: "failed", name: "read_file", status: "failed", round: 1 }), undefined);
  assert.equal(advisory.observe({ id: "running", name: "read_file", status: "running", round: 2 }), undefined);
  for (let index = 0; index < 7; index++) assert.equal(advisory.observe({ id: `valid-${index}`, name: "list_directory", status: "complete", round: index % 3 }), undefined);
  assert.equal(typeof advisory.observe({ id: "valid-7", name: "list_directory", status: "complete", round: 2 }), "string");
});

test("duplicate completion events are counted once and the advisory is emitted at most once", () => {
  const advisory = new ChatExplorationAdvisory();
  const first = { id: "duplicate", name: "read_file", status: "complete", round: 0 };
  assert.equal(advisory.observe(first), undefined);
  assert.equal(advisory.observe(first), undefined);
  for (let index = 1; index < 7; index++) assert.equal(advisory.observe({ id: `unique-${index}`, name: "read_file", status: "complete", round: index % 2 }), undefined);
  assert.equal(advisory.observe({ ...first, round: 2 }), undefined);
  const hint = advisory.observe({ id: "eighth", name: "read_file", status: "complete", round: 2 });
  assert.equal(typeof hint, "string");
  assert.equal(advisory.observe({ id: "later", name: "read_file", status: "complete", round: 3 }), undefined);
});

test("completed meaningful actions suppress the advisory, while no-op edits and failed actions do not", () => {
  const actions = ["replace_text", "save_file", "run_process", "spawn_workers", "assign_workers"];
  for (const name of actions) {
    const advisory = new ChatExplorationAdvisory();
    for (let index = 0; index < 7; index++) advisory.observe({ id: `${name}-read-${index}`, name: "read_file", status: "complete", round: index % 3 });
    const event = { id: `${name}-action`, name, status: "complete", round: 2 };
    if (name === "replace_text") event.result = JSON.stringify({ applied: true, path: "x", workspace: 0,
      appliedAt: new Date().toISOString(), saved: false, attribution: "exact", beforeHash: "a".repeat(64), afterHash: "b".repeat(64) });
    assert.equal(advisory.observe(event), undefined);
    assert.equal(advisory.observe({ id: `${name}-eighth`, name: "read_file", status: "complete", round: 2 }), undefined);
  }

  const noopReceipt = JSON.stringify({ applied: true, path: "x", workspace: 0, appliedAt: new Date().toISOString(),
    saved: false, attribution: "exact", beforeHash: "a".repeat(64), afterHash: "a".repeat(64) });
  for (const ignoredAction of [
    { id: "noop", name: "replace_text", status: "complete", result: noopReceipt },
    { id: "failed", name: "save_file", status: "failed" },
    { id: "failed-edit", name: "replace_text", status: "failed", result: "changed" },
  ]) {
    const advisory = new ChatExplorationAdvisory();
    assert.equal(advisory.observe(ignoredAction), undefined);
    for (let index = 0; index < 7; index++) assert.equal(advisory.observe({ id: `ok-${ignoredAction.id}-${index}`, name: "read_file", status: "complete", round: index % 3 }), undefined);
    assert.equal(typeof advisory.observe({ id: `ok-${ignoredAction.id}-7`, name: "read_file", status: "complete", round: 2 }), "string");
  }
});
