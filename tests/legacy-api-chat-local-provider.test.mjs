import assert from "node:assert/strict";
import { test } from "node:test";
import { createServer } from "node:http";
import { createRequire } from "node:module";
import { createLegacyApiChatLocalProvider } from "../dist/legacy-api-chat-local-provider.js";
const require = createRequire(import.meta.url);
const { image } = require("../legacy/tests/next-trial-electron/api-chat-fixture.cjs");
test("Memory uses the configured Chat API when the real VS Code catalog is empty, but preserves discovery errors and cancellation", async t => {
  const Module = require("node:module"), load = Module._load;
  const host = { workspace: { getConfiguration: () => ({ get: (_key, fallback) => fallback }) },
    lm: { selectChatModels: async () => [] } };
  let ApiChatView, models;
  try {
    Module._load = function (id, ...args) { return id === "vscode" ? host : load.call(this, id, ...args); };
    ({ ApiChatView } = require("../legacy/dist/chat/api-chat-view.js"));
    models = require("../legacy/dist/chat/api-chat-vscode.js");
  } finally { Module._load = load; }
  let calls = 0;
  const server = createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const input = JSON.parse(Buffer.concat(chunks).toString());
    calls++;
    assert.equal(input.model, "fixture-chat-model");
    assert.equal(input.tools, undefined);
    res.writeHead(200, { "content-type": "text/event-stream" });
    res.end('data: {"choices":[{"delta":{"content":"{\\"focus\\":[]}"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n');
  });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(() => { server.closeAllConnections(); return new Promise(resolve => server.close(resolve)); });
  let provider = "openai-compatible";
  const owner = { vscodeModels: [], settings: () => ({ provider, model: "fixture-chat-model",
    selectedProfile: { id: "vscode:fixture:missing" }, endpoint: `http://127.0.0.1:${server.address().port}/v1`,
    contextWindow: 4096, timeoutMs: 2000 }),
    availableVscodeModels: signal => models.discoverVscodeModels(host, signal),
    readApiKey: async () => "synthetic-key" };
  const request = { purpose: "intent", max_tokens: 100, messages: [{ role: "user", content: "Synthetic memory input" }] };
  const run = signal => ApiChatView.prototype.runMemoryModel.call(owner, {}, request, signal, {});
  const result = await run(new AbortController().signal);
  assert.equal(result.text, '{"focus":[]}');
  assert.equal(result.accounting.provider, "http");
  assert.equal(result.accounting.modelId, "fixture-chat-model");
  owner.availableVscodeModels = async () => { throw new Error("Synthetic catalog transport failure"); };
  await assert.rejects(run(new AbortController().signal), /catalog transport failure/);
  owner.availableVscodeModels = signal => models.discoverVscodeModels(host, signal);
  provider = "vscode";
  await assert.rejects(run(new AbortController().signal), /No VS Code models callable/);
  provider = "openai-compatible";
  await assert.rejects(run(AbortSignal.abort()), /cancelled/i);
  assert.equal(calls, 1, "Only the documented HTTP Memory fallback may dispatch");
});
test("native loopback provider sends real PNG bytes and decodes fragmented UTF-8/CRLF SSE; incomplete results fail closed", async t => {
  let mode = "ok", calls = 0;
  const server = createServer(async (request, response) => {
    try {
      assert.equal(request.url, "/v1/chat/completions");
      assert.equal(request.headers.authorization, "Bearer private-synthetic");
      const chunks = [];
      for await (const chunk of request) chunks.push(chunk);
      const body = JSON.parse(Buffer.concat(chunks).toString());
      assert.equal(body.messages[0].content[1].image_url.url, `data:image/png;base64,${image.dataBase64}`);
      calls++;
      response.writeHead(200, { "content-type": "text/event-stream" });
      if (mode === "incomplete") { response.end('data: {"choices":[{"delta":{"content":"partial"},"finish_reason":null}]}\n\n'); return; }
      const bytes = Buffer.from('data: {"choices":[{"delta":{"content":"真实 PNG response"},"finish_reason":null}]}\r\n\r\n'
        + 'data: {"choices":[{"delta":{},"finish_reason":"stop"}]}\r\n\r\ndata: [DONE]\r\n\r\n');
      for (let i = 0; i < bytes.length; i++) {
        response.write(bytes.subarray(i, i + 1));
        if (i % 5 === 0) await new Promise(resolve => setImmediate(resolve));
      }
      response.end();
    } catch (error) { response.writeHead(500); response.end(String(error)); }
  });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const provider = createLegacyApiChatLocalProvider({ endpoint: `http://127.0.0.1:${server.address().port}/v1`,
    apiKey: "private-synthetic", model: "private" });
  const messages = [{ role: "user", content: "Inspect this PNG.", images: [image] }];
  assert.equal(await provider(messages, new AbortController().signal), "真实 PNG response");
  mode = "incomplete";
  await assert.rejects(provider(messages, new AbortController().signal), /without a complete result/);
  assert.equal(calls, 2);
  assert.throws(() => createLegacyApiChatLocalProvider({ endpoint: "https://example.invalid/v1", apiKey: "unused", model: "private" }), /private loopback/);
});
