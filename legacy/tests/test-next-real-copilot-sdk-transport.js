"use strict";
const assert = require("node:assert/strict");
const { randomUUID } = require("node:crypto");
const Module = require("node:module");
const path = require("node:path");
const { test } = require("node:test");
const { localSdkTransport } = require("./next-trial-electron/sdk-local-transport.cjs");

const extension = process.env.PKM_TRIAL_EXTENSION_DIST;
const modules = process.env.PKM_REAL_SDK_MODULES;
if (!extension || !modules) throw Error("Run with isolated compiled extension and extracted VS Code SDK.");
const sdk = require(path.join(modules, "@github/copilot-sdk"));
const rpc = require(path.join(modules, "vscode-jsonrpc/node"));
const load = Module._load;
let createBridge;
try {
  Module._load = function (name, ...args) { return name === "vscode" ? {} : load.call(this, name, ...args); };
  createBridge = require(path.join(extension, "runtime/next-copilot-sdk-bridge.js")).createNextCopilotSdkBridge;
} finally { Module._load = load; }

const model = { vendor: "copilot-sdk", id: "fixture-model", maxInputTokens: 32768, maxOutputTokens: 1024,
  capabilities: { toolCalling: true, imageInput: true }, copilotSdk: { routed: false } };
async function setup(t, mode) {
  const transport = await localSdkTransport({ rpc, program: "/synthetic/node", args: ["fixture"], cwd: "/synthetic", mode });
  const client = new sdk.CopilotClient({ connection: sdk.RuntimeConnection.forUri(transport.url), mode: "empty" });
  await client.start();
  const controller = new AbortController(), session = randomUUID(), pending = new Map();
  const bridge = createBridge({ model, session, contextWindow: 16384, maxOutputTokens: 1024,
    deps: { async token() { return "fixture-only-token"; }, async client() { return { sdk, client }; } },
    signal: controller.signal, assertCurrent() {}, send(message) { pending.get(message.id)?.(message); } });
  const request = (type, streamId, extra = {}) => new Promise(resolve => {
    const requestId = randomUUID(); pending.set(requestId, value => { pending.delete(requestId); resolve(value); });
    bridge.handle({ type, id: requestId, session, streamId, ...extra });
  });
  t.after(async () => { bridge.dispose(); await bridge.drain().catch(() => {}); await client.stop().catch(() => {}); await transport.close(); });
  return { transport, bridge, client, request,
    open: (streamId, messages) => request("selected-lm-open", streamId, { messages, maxInputTokens: 10000, maxOutputTokens: 1024,
      tools: [{ name: "run_process", description: "approved command", parameters: { type: "object", properties: {} } }] }) };
}
test("real VS Code SDK over isolated JSON-RPC aborts its callback before exposing a tool; fresh session retains result", async t => {
  const f = await setup(t, "normal"), first = randomUUID();
  const messages = [{ role: "user", content: "Remember context: blue umbrella." }];
  const opened = await f.open(first, messages);
  assert.equal(opened.result?.opened, true, JSON.stringify(opened));
  const call = (await f.request("selected-lm-next", first)).result.event;
  assert.equal(call.type, "tool");
  assert.equal(f.transport.state.aborts.length, 1);
  for (let i = 0; i < 200 && !f.transport.state.callbacks.length; i++)
    await new Promise(resolve => setTimeout(resolve, 10));
  assert.equal(f.transport.state.callbacks.length, 1);
  assert(f.transport.state.callbacks.every(callback => callback.afterAbort));
  assert.equal((await f.request("selected-lm-next", first)).result.event.reason, "tool_calls");
  const second = randomUUID();
  messages.push({ role: "assistant", content: "", tool_calls: [{ id: call.id, type: "function",
    function: { name: call.name, arguments: JSON.stringify(call.arguments) } }] },
  { role: "tool", tool_call_id: call.id, content: "fixture-result-123" });
  assert.equal((await f.open(second, messages)).result?.opened, true);
  assert.equal((await f.request("selected-lm-next", second)).result.event.text, "SDK_FIXTURE_SUCCESS");
  assert.equal((await f.request("selected-lm-next", second)).result.event.reason, "stop");
  assert.notEqual(f.transport.state.sends[0].sessionId, f.transport.state.sends[1].sessionId);
  assert.match(f.transport.state.sends[1].prompt, /blue umbrella/);
  assert.match(f.transport.state.sends[1].prompt, /fixture-result-123/);
  assert.equal(f.transport.state.sends.length, 2);
});

test("real SDK session cancellation requests abort without another send", async t => {
  const f = await setup(t, "cancel"), stream = randomUUID();
  const opening = f.open(stream, [{ role: "user", content: "cancel" }]);
  while (!f.transport.state.sends.length) await new Promise(resolve => setTimeout(resolve, 10));
  await f.request("selected-lm-cancel", stream);
  assert.equal((await opening).error, "MODEL_PROVIDER_ERROR");
  await f.bridge.drain();
  assert.equal(f.transport.state.aborts.length, 1);
  assert.equal(f.transport.state.sends.length, 1);
});

test("real SDK transport loss cannot expose or replay a tool and does not acknowledge drain", async t => {
  const f = await setup(t, "disconnect"), stream = randomUUID();
  const opening = f.open(stream, [{ role: "user", content: "disconnect" }]);
  while (f.transport.state.connections && !f.transport.state.sends.length)
    await new Promise(resolve => setTimeout(resolve, 10));
  await new Promise(resolve => setTimeout(resolve, 150));
  await f.request("selected-lm-cancel", stream);
  assert.equal((await opening).error, "MODEL_PROVIDER_ERROR");
  await assert.rejects(f.bridge.drain());
  assert.equal(f.transport.state.sends.length, 1);
  assert.deepEqual(f.transport.state.callbacks, []);
  assert.equal((await f.request("selected-lm-next", stream)).error, "MODEL_PROVIDER_ERROR");
});
