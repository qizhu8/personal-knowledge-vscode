const { test } = require("node:test");
const assert = require("node:assert/strict");
const { ChatInferenceClock } = require("../dist/chat/chat-inference-timing");
const { streamApiChat } = require("../dist/chat/api-chat-client");
const Module = require("node:module");
const original = Module._load;
const host = {
  CancellationTokenSource:class { constructor() { this.token = {}; } cancel() {} dispose() {} },
  LanguageModelChatMessage:{ User:content => ({ role:"user", content }), Assistant:content => ({ role:"assistant", content }) },
};
let streamVscodeChat;
try {
  Module._load = function(name, ...args) { return name === "vscode" ? host : original.call(this, name, ...args); };
  ({ streamVscodeChat } = require("../dist/chat/api-chat-vscode"));
} finally { Module._load = original; }

test("native transport is prepared before dispatch and confirmed only after provider acceptance", async () => {
  const events = [], receipts = [], timings = [];
  const model = { id:"fixture", name:"Fixture", vendor:"copilot", family:"fixture", version:"1", maxInputTokens:32768,
    countTokens:async () => 1,
    sendRequest:async () => { events.push("dispatch"); return { text:(async function* () { yield "accepted"; })() }; } };
  await streamVscodeChat(model, { messages:[{ role:"user", content:"Evidence" }], signal:new AbortController().signal,
    contextWindow:32768, maxOutputTokens:1024,
    onTransportPrepared:receipt => { events.push("prepared"); receipts.push(receipt); },
    onTransportSent:receipt => { events.push("sent"); receipts.push(receipt); },
    onInferenceTiming:timing => timings.push(timing),
  }, () => events.push("text"), host);
  assert.deepEqual(events, ["prepared", "dispatch", "sent", "text"]);
  assert.deepEqual(receipts[0], receipts[1]);
  assert.equal(receipts[1].provider, "vscode");
  assert.equal(timings.length, 1); assert.equal(timings[0].provider, "vscode");
  assert.equal(timings[0].outcome, "stream-ended");
  assert(timings[0].firstPublicOutputMs <= timings[0].elapsedMs);
});

test("native automatic-reference cap uses actual token counts and rejects 8001 before dispatch", async () => {
  for (const referenceTokens of [7936, 7937]) {
    // 12 KB of UTF-8 exceeds the byte upper bound, so the model tokenizer decides the cap.
    const reference = { role:"system", content:`Automatic reference ${"\u4e2d".repeat(4000)}` };
    let dispatches = 0, receipt;
    const model = { id:"fixture", name:"Fixture", vendor:"copilot", family:"fixture", version:"1", maxInputTokens:32768,
      countTokens:async value => typeof value === "object" && value.content.includes("Automatic reference") ? referenceTokens : 1,
      sendRequest:async () => { dispatches++; return { text:(async function* () { yield "done"; })() }; } };
    const run = streamVscodeChat(model, { messages:[reference, { role:"user", content:"User input outside this budget" }],
      signal:new AbortController().signal, contextWindow:32768, maxOutputTokens:1024,
      automaticKnowledge:{ inputBudget:8000, includes:message => message === reference },
      onTransportPrepared:value => { receipt = value; },
    }, () => {}, host);
    if (referenceTokens === 7936) {
      await run;
      assert.equal(dispatches, 1);
      assert.deepEqual(receipt.automaticKnowledge, { inputBudget:8000, inputTokens:8000, countingMethod:"vscode-countTokens-plus-overhead" });
    } else {
      await assert.rejects(run, /Automatic PKM reference input budget exceeded/);
      assert.equal(dispatches, 0);
      assert.equal(receipt, undefined);
    }
  }
});

test("native requests skip tokenizer calls when the UTF-8 byte bound already fits", async () => {
  const reference = { role:"system", content:"Automatic reference" };
  let counts = 0, receipt;
  const model = { id:"fixture", name:"Fixture", vendor:"copilot", family:"fixture", version:"1", maxInputTokens:32768,
    countTokens:async () => { counts++; return 1; },
    sendRequest:async () => ({ text:(async function* () { yield "done"; })() }) };
  await streamVscodeChat(model, { messages:[reference, { role:"user", content:"question" }], signal:new AbortController().signal,
    contextWindow:32768, maxOutputTokens:1024, automaticKnowledge:{ inputBudget:8000, includes:message => message === reference },
    onTransportPrepared:value => { receipt = value; } }, () => {}, host);
  assert.equal(counts, 0);
  assert.equal(receipt.countingMethod, "utf8-byte-upper-bound");
  assert.equal(receipt.automaticKnowledge.countingMethod, "utf8-byte-upper-bound");
  assert(receipt.automaticKnowledge.inputTokens <= 8000);
});

test("HTTP automatic-reference cap is independent of required input and enforced before fetch", async () => {
  for (const size of [7936, 7937]) {
    const reference = { role:"system", content:"x".repeat(size) };
    let dispatches = 0, receipt;
    const run = streamApiChat({ provider:"openai-compatible", endpoint:"http://127.0.0.1:1/v1", apiKey:"",
      model:"fixture", messages:[reference, { role:"user", content:"Pinned manual content ".repeat(1000) }],
      signal:new AbortController().signal, maxOutputTokens:1024,
      automaticKnowledge:{ inputBudget:8000, includes:message => message === reference },
      onTransportPrepared:value => { receipt = value; },
      fetch:async () => { dispatches++; return new Response('data: {"choices":[{"delta":{"content":"done"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n',
        { headers:{ "Content-Type":"text/event-stream" } }); },
    }, () => {});
    if (size === 7936) {
      await run;
      assert.equal(dispatches, 1);
      assert.deepEqual(receipt.automaticKnowledge, { inputBudget:8000, inputTokens:8000, countingMethod:"utf8-byte-upper-bound" });
    } else {
      await assert.rejects(run, /Automatic PKM reference input budget exceeded/);
      assert.equal(dispatches, 0);
    }
  }
});

test("failed native preparation or rejected dispatch cannot emit a confirmed-sent receipt", async () => {
  for (const failure of ["prepare", "dispatch"]) {
    let dispatched = 0, sent = 0;
    const timings = [];
    const model = { id:"fixture", name:"Fixture", vendor:"copilot", family:"fixture", version:"1", maxInputTokens:32768,
      countTokens:async () => 1,
      sendRequest:async () => { dispatched++; throw new Error("dispatch rejected"); } };
    await assert.rejects(streamVscodeChat(model, {
      messages:[{ role:"user", content:"Evidence" }], signal:new AbortController().signal, contextWindow:32768, maxOutputTokens:1024,
      onTransportPrepared:() => { if (failure === "prepare") throw new Error("preparation failed"); },
      onTransportSent:() => { sent++; },
      onInferenceTiming:timing => timings.push(timing),
    }, () => {}, host));
    assert.equal(dispatched, failure === "prepare" ? 0 : 1);
    assert.equal(sent, 0);
    assert.equal(timings.length, failure === "prepare" ? 0 : 1);
    if (failure === "dispatch") assert.equal(timings[0].outcome, "interrupted");
  }
});

test("inference clock measures only active transport intervals and separates heartbeat from public output", () => {
  const timings = [];
  let now = 100;
  const clock = new ChatInferenceClock("http", timing => timings.push(timing), () => now);
  clock.start();
  now = 140; clock.activity();
  now = 160; clock.activity();
  now = 190; clock.publicOutput(); clock.activity();
  now = 200; clock.finish("stream-ended");
  now = 10200; clock.activity(); clock.publicOutput(); clock.finish("interrupted");
  clock.start(); now = 10270; clock.finish("interrupted");
  assert.equal(timings.length, 2);
  assert.equal(timings[0].elapsedMs, 100);
  assert.equal(timings[0].maxInactivityMs, 40);
  assert.equal(timings[0].firstActivityMs, 40);
  assert.equal(timings[0].firstPublicOutputMs, 90);
  assert.equal(timings[1].elapsedMs, 70, "User/tool time between inference clocks is excluded");
  assert.equal(timings[1].maxInactivityMs, 70);
  assert.equal(timings[1].firstPublicOutputMs, undefined);
});

test("HTTP timing excludes tool waiting, records both actual inference rounds and observes public output", async () => {
  const timings = [];
  let calls = 0, waited = 0;
  const startedAt = Date.now();
  await streamApiChat({
    provider: "openai-compatible", endpoint: "http://127.0.0.1:1/v1", apiKey: "", model: "fixture",
    messages: [{ role: "user", content: "Wait for the original evidence, then answer." }],
    signal: new AbortController().signal, onInferenceTiming: timing => timings.push(timing),
    tools: [{ name: "wait_for_evidence", description: "Fixture wait", parameters: { type: "object" }, execute: async () => {
      const start = Date.now(); await new Promise(resolve => setTimeout(resolve, 100)); waited = Date.now() - start; return "evidence";
    } }],
    fetch: async () => {
      const first = calls++ === 0;
      const delta = first ? { tool_calls: [{ index: 0, id: "clock-call", type: "function", function: { name: "wait_for_evidence", arguments: "{}" } }] } : { content: "done" };
      const chunks = [
        { choices: [{ delta, finish_reason: null }] },
        { choices: [{ delta: {}, finish_reason: first ? "tool_calls" : "stop" }] },
      ].map(chunk => `data: ${JSON.stringify(chunk)}\n\n`).join("") + "data: [DONE]\n\n";
      return new Response(chunks, { headers: { "Content-Type": "text/event-stream" } });
    },
  }, () => {});
  assert.equal(timings.length, 2);
  assert(timings.every(timing => timing.provider === "http" && timing.outcome === "stream-ended" && timing.firstPublicOutputMs !== undefined));
  assert(Date.now() - startedAt >= timings.reduce((sum, timing) => sum + timing.elapsedMs, 0) + waited);
});
