"use strict";
const assert = require("node:assert/strict");
const { randomUUID } = require("node:crypto");
const Module = require("node:module");
const path = require("node:path");
const { test } = require("node:test");

const extension = process.env.PKM_TRIAL_EXTENSION_DIST;
if (!extension) throw Error("Run with isolated compiled extension fixtures.");
const load = Module._load;
let createBridge;
try {
  Module._load = function (name, ...args) {
    if (name === "vscode") return {};
    return load.call(this, name, ...args);
  };
  createBridge = require(path.join(extension, "runtime/next-copilot-sdk-bridge.js")).createNextCopilotSdkBridge;
} finally { Module._load = load; }

const image = { label: "fixture.png", mimeType: "image/png",
  dataBase64: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/l9sAAAAASUVORK5CYII=" };
const model = { vendor: "copilot-sdk", id: "fixture", name: "Fixture", family: "fixture", version: "fixture",
  maxInputTokens: 32768, maxOutputTokens: 1024, capabilities: { toolCalling: true, imageInput: true },
  copilotSdk: { routed: false } };
const tools = [{ name: "run_process", description: "Exact approved command", parameters: { type: "object" } }];

function fixture(mode) {
  const state = { aborts: 0, disconnects: 0, deletes: 0, calls: 0, callbacks: 0, callbackResult: undefined };
  let handler;
  const client = {
    async createSession(config) {
      state.config = config;
      if (mode === "late-session") await new Promise(resolve => { state.releaseSession = resolve; });
      return {
        sessionId: randomUUID(),
        on(callback) { handler = callback; return () => { handler = undefined; }; },
        async send(input) {
          state.input = input;
          if (mode === "cancel") return "sent";
          setImmediate(() => {
            state.calls++;
            if (mode === "error") { handler({ type: "session.error", data: { errorType: "secret diagnostic" } }); return; }
            if (mode === "text") {
              handler({ type: "assistant.message_delta", data: { messageId: "m", deltaContent: "hello" } });
              handler({ type: "assistant.message", data: { messageId: "m", content: "hello", toolRequests: [] } });
              handler({ type: "session.idle" });
              return;
            }
            const name = mode === "invalid" ? "forbidden" : "run_process";
            handler({ type: "assistant.message", data: { messageId: "m", content: "",
              toolRequests: [{ toolCallId: "tool-1", name, arguments: { program: "node", arguments: [] } }] } });
            if (mode !== "invalid") {
              state.callbacks++;
              void config.tools[0].handler({ program: "node", arguments: [] }, { toolCallId: "tool-1" })
                .then(value => { state.callbackResult = value; });
            }
          });
          return "sent";
        },
        async abort() { state.aborts++; if (mode === "abort-fails" && state.aborts <= 2) throw Error("private diagnostic"); },
        async disconnect() { state.disconnects++; },
      };
    },
    async deleteSession() { state.deletes++; },
  };
  const deps = { async token() { if (mode === "auth") return undefined; return "private-token"; },
    async client() { return { client, sdk: { defineTool(name, config) { return { name, ...config }; } } }; } };
  const responses = new Map(), controller = new AbortController(), session = randomUUID();
  const bridge = createBridge({ model, deps, session, signal: controller.signal, assertCurrent() {},
    contextWindow: 16384, maxOutputTokens: 1024,
    send(message) { responses.get(message.id)?.(message); } });
  const request = (type, streamId, extra = {}) => new Promise(resolve => {
    const requestId = randomUUID();
    responses.set(requestId, value => { responses.delete(requestId); resolve(value); });
    bridge.handle({ type, id: requestId, session, streamId, ...extra });
  });
  return { state, bridge, controller, request, open: (streamId, extra = {}) => request("selected-lm-open", streamId, {
    messages: [{ role: "user", content: "do the work" }], tools, maxInputTokens: 12000, maxOutputTokens: 1024, ...extra,
  }) };
}

test("SDK prepared request checks budget before dispatch and cancellation never opens a session", async () => {
  const f = fixture("text"), stream = randomUUID();
  assert.equal((await f.open(randomUUID(), { prepareOnly: true, maxInputTokens: 1 })).error, "MODEL_PROVIDER_ERROR");
  assert.equal(f.state.config, undefined);
  assert.equal((await f.open(stream, { prepareOnly: true })).result.prepared, true);
  assert.equal(f.state.config, undefined);
  await f.request("selected-lm-cancel", stream);
  assert.equal(f.state.config, undefined);
  const second = randomUUID();
  assert.equal((await f.open(second, { prepareOnly: true })).result.prepared, true);
  assert.equal((await f.request("selected-lm-dispatch", second)).result.opened, true);
  assert.equal((await f.request("selected-lm-next", second)).result.event.text, "hello");
  f.bridge.dispose(); await f.bridge.drain();
});

test("SDK callback cannot execute; confirmed abort precedes tool event and private image format is preserved", async () => {
  const f = fixture("tool"), stream = randomUUID();
  const opened = await f.open(stream, { images: { messageIndex: 0, items: [image] } });
  assert.equal(opened.result.opened, true);
  assert.equal(f.state.aborts, 1);
  assert.equal(f.state.disconnects, 1);
  assert.equal(f.state.deletes, 1);
  assert.deepEqual(f.state.input.attachments, [{ type: "blob", data: image.dataBase64, mimeType: image.mimeType, displayName: image.label }]);
  assert.equal(f.state.config.enableSessionStore, false);
  assert.equal(f.state.config.enableConfigDiscovery, false);
  assert.equal(f.state.config.onPermissionRequest({ kind: "shell" }).kind, "reject");
  assert.equal(f.state.config.onPermissionRequest({ kind: "custom-tool", toolName: "run_process" }).kind, "approve-once");
  assert.equal(JSON.parse(f.state.callbackResult).error, "Not executed in the SDK session.");
  assert.deepEqual((await f.request("selected-lm-next", stream)).result.event,
    { type: "tool", id: "tool-1", name: "run_process", arguments: { program: "node", arguments: [] } });
  assert.equal((await f.request("selected-lm-next", stream)).result.event.reason, "tool_calls");
  f.bridge.dispose(); await f.bridge.drain();
});

test("SDK text does not duplicate deltas and errors and undeclared tools are sanitized", async () => {
  const text = fixture("text"), stream = randomUUID();
  assert.equal((await text.open(stream)).result.opened, true);
  assert.deepEqual((await text.request("selected-lm-next", stream)).result.event, { type: "text", text: "hello" });
  assert.equal((await text.request("selected-lm-next", stream)).result.event.reason, "stop");
  for (const mode of ["invalid", "error", "auth"]) {
    const f = fixture(mode), response = await f.open(randomUUID());
    assert.equal(response.error, mode === "auth" ? "MODEL_AUTHENTICATION" : "MODEL_PROVIDER_ERROR");
    assert.equal(JSON.stringify(response).includes("secret"), false);
    f.bridge.dispose(); await f.bridge.drain();
  }
});

test("SDK ignores images smuggled inside ordinary message records", async () => {
  const f = fixture("text"), stream = randomUUID();
  assert.equal((await f.open(stream, { messages: [{ role: "user", content: "text", images: [image] }] })).result.opened, true);
  assert.equal(f.state.input.attachments, undefined);
  f.bridge.dispose(); await f.bridge.drain();
});

test("SDK cancellation aborts the private session; no tool event is admitted", async () => {
  const f = fixture("cancel"), stream = randomUUID(), pending = f.open(stream);
  await new Promise(resolve => setImmediate(resolve));
  await f.request("selected-lm-cancel", stream);
  assert.equal((await pending).error, "MODEL_PROVIDER_ERROR");
  f.bridge.dispose(); await f.bridge.drain();
  assert.equal(f.state.aborts, 1);
  assert.equal(f.state.disconnects, 1);
});

test("unconfirmed SDK abort never emits a tool and its cleanup remains retryable", async () => {
  const f = fixture("abort-fails"), response = await f.open(randomUUID());
  assert.equal(response.error, "MODEL_PROVIDER_ERROR");
  assert.equal(f.state.disconnects, 0);
  f.bridge.dispose(); await f.bridge.drain();
  assert.equal(f.state.aborts, 3);
  assert.equal(f.state.disconnects, 1);
});

test("owner drain waits for a late SDK session and aborts it before sending", async () => {
  const f = fixture("late-session"), stream = randomUUID(), pending = f.open(stream);
  while (!f.state.releaseSession) await new Promise(resolve => setImmediate(resolve));
  f.bridge.dispose();
  let drained = false;
  const closing = f.bridge.drain().then(() => { drained = true; });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(drained, false);
  f.state.releaseSession();
  assert.equal((await pending).error, "MODEL_PROVIDER_ERROR");
  await closing;
  assert.equal(f.state.calls, 0);
  assert.equal(f.state.aborts, 1);
  assert.equal(f.state.disconnects, 1);
});
