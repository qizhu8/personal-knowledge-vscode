import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { resolve } from "node:path";
import { test } from "node:test";
import { managedVscodeModelIpc } from "../dist/managed-vscode-model-ipc.js";

const require = createRequire(import.meta.url), ts = require("typescript");
function load(file, imports) {
  const source = readFileSync(resolve(import.meta.dirname, "../legacy", file), "utf8");
  const js = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
  const module = { exports: {} };
  new Function("require", "module", "exports", js)(imports, module, module.exports);
  return module.exports;
}
function fixture(kind) {
  const session = randomUUID(), connection = new AbortController();
  let requests = 0, bridge, ipc;
  const send = message => ipc.handle(message);
  if (kind === "vscode") {
    class CancellationTokenSource { constructor() { this.token = {}; } cancel() {} dispose() {} }
    const vscode = { CancellationTokenSource, LanguageModelChatMessage: {
      User: content => ({ role: "user", content }), Assistant: content => ({ role: "assistant", content }),
    } };
    const { createNextVscodeModelBridge } = load("src/runtime/next-vscode-model-bridge.ts", name =>
      name === "vscode" ? vscode : name === "../chat/api-chat-client" ? {} : require(name));
    const model = { maxInputTokens: 32768, capabilities: {},
      async sendRequest() { requests++; return { text: (async function* () { yield "ok"; })() }; } };
    bridge = createNextVscodeModelBridge({ model, session, signal: connection.signal, assertCurrent() {}, send });
  } else {
    const { createNextCopilotSdkBridge } = load("src/runtime/next-copilot-sdk-bridge.ts", name => {
      if (name === "../chat/api-chat-copilot-sdk") return { copilotSdkPrompt: () => ({ system: "", prompt: "", images: [] }) };
      if (name === "../chat/api-chat-client") return {};
      return require(name);
    });
    const model = { id: "fixture", maxInputTokens: 32768, capabilities: { toolCalling: true } };
    const deps = { token: async () => "fixture", client: async () => ({ sdk: { defineTool() {} }, client: {
      async createSession() {
        let handler;
        return { sessionId: randomUUID(), on(callback) { handler = callback; return () => {}; },
          async send() { requests++; setImmediate(() => { handler({ type: "assistant.message_delta", data: { deltaContent: "ok" } }); handler({ type: "session.idle" }); }); },
          async abort() {}, async disconnect() {} };
      }, async deleteSession() {} } }) };
    bridge = createNextCopilotSdkBridge({ model, deps, session, signal: connection.signal, contextWindow: 16384,
      maxOutputTokens: 1024, assertCurrent() {}, send });
  }
  ipc = managedVscodeModelIpc({ connected: () => true, send: message => bridge.handle(message) });
  const model = ipc.model(session, [], () => {}, 5000);
  return { model, get requests() { return requests; }, async close() { connection.abort(); bridge.dispose(); await bridge.drain?.(); } };
}
for (const kind of ["vscode", "sdk"]) test(`${kind} IPC validates prompt before host commits steering`, async t => {
  const f = fixture(kind);
  t.after(() => f.close());
  let commits = 0;
  const request = { actor: "actor", turnId: randomUUID(), step: 1, messages: [{ role: "user", content: "bounded" }],
    maxInputTokens: 1, maxOutputTokens: 100, signal: new AbortController().signal, beforeDispatch: () => { commits++; } };
  await assert.rejects(async () => { for await (const _event of f.model.stream(request)) {} });
  assert.equal(commits, 0);
  assert.equal(f.requests, 0);
  request.maxInputTokens = 10000;
  request.beforeDispatch = () => { commits++; throw new Error("steering changed"); };
  await assert.rejects(async () => { for await (const _event of f.model.stream(request)) {} });
  assert.equal(commits, 1);
  assert.equal(f.requests, 0);
  request.beforeDispatch = () => { assert.equal(f.requests, 0); commits++; };
  const events = [];
  for await (const event of f.model.stream(request)) events.push(event);
  assert.equal(commits, 2);
  assert.equal(f.requests, 1);
  assert(events.some(event => event.type === "text" && event.text === "ok"));
});
