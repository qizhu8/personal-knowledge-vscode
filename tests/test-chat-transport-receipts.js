const { test } = require("node:test");
const assert = require("node:assert/strict");
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
  const events = [], receipts = [];
  const model = { id:"fixture", name:"Fixture", vendor:"copilot", family:"fixture", version:"1", maxInputTokens:32768,
    countTokens:async () => 1,
    sendRequest:async () => { events.push("dispatch"); return { text:(async function* () { yield "accepted"; })() }; } };
  await streamVscodeChat(model, { messages:[{ role:"user", content:"Evidence" }], signal:new AbortController().signal,
    contextWindow:32768, maxOutputTokens:1024,
    onTransportPrepared:receipt => { events.push("prepared"); receipts.push(receipt); },
    onTransportSent:receipt => { events.push("sent"); receipts.push(receipt); },
  }, () => events.push("text"), host);
  assert.deepEqual(events, ["prepared", "dispatch", "sent", "text"]);
  assert.deepEqual(receipts[0], receipts[1]);
  assert.equal(receipts[1].provider, "vscode");
});

test("failed native preparation or rejected dispatch cannot emit a confirmed-sent receipt", async () => {
  for (const failure of ["prepare", "dispatch"]) {
    let dispatched = 0, sent = 0;
    const model = { id:"fixture", name:"Fixture", vendor:"copilot", family:"fixture", version:"1", maxInputTokens:32768,
      countTokens:async () => 1,
      sendRequest:async () => { dispatched++; throw new Error("dispatch rejected"); } };
    await assert.rejects(streamVscodeChat(model, {
      messages:[{ role:"user", content:"Evidence" }], signal:new AbortController().signal, contextWindow:32768, maxOutputTokens:1024,
      onTransportPrepared:() => { if (failure === "prepare") throw new Error("preparation failed"); },
      onTransportSent:() => { sent++; },
    }, () => {}, host));
    assert.equal(dispatched, failure === "prepare" ? 0 : 1);
    assert.equal(sent, 0);
  }
});
