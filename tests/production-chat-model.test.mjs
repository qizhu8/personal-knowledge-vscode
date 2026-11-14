import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { createServer } from "node:http";
import { test } from "node:test";
import { createProductionChatModel } from "../dist/production-chat-model.js";

async function serverFixture(t, handler) {
  const server = createServer(handler);
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise(resolve => { server.closeAllConnections(); server.close(resolve); }));
  return `http://127.0.0.1:${server.address().port}/v1`;
}
const settings = endpoint => ({ provider: "openai-compatible", endpoint, model: "chosen-model", apiKey: "fixture-key",
  contextWindow: 8192, maxOutputTokens: 256, outputTokenParameter: "max_tokens", includeUsage: true,
  status: "active", assertCurrent() {}, tools: async () => [] });
const request = signal => ({ actor: "local:owner", turnId: randomUUID(), messages: [{ role: "user", content: "hello" }],
  maxInputTokens: 4096, maxOutputTokens: 4096, signal });
const consume = async (model, signal = new AbortController().signal) => {
  const events = [];
  for await (const event of model.stream(request(signal))) events.push(event);
  return events;
};
async function bodyOf(request) {
  const chunks = [];
  for await (const chunk of request) chunks.push(chunk);
  return JSON.parse(Buffer.concat(chunks).toString());
}
function complete(response) {
  response.writeHead(200, { "content-type": "text/event-stream" });
  response.end(`data: ${JSON.stringify({ choices: [{ index: 0, delta: { content: "answer" }, finish_reason: null }] })}\n\n`
    + `data: ${JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: "stop" }] })}\n\ndata: [DONE]\n\n`);
}

test("selected HTTP model uses the configured credential, budget and endpoint without retry", async t => {
  const calls = [];
  const endpoint = await serverFixture(t, async (req, res) => {
    calls.push({ url: req.url, authorization: req.headers.authorization, body: await bodyOf(req) });
    complete(res);
  });
  const selected = settings(endpoint);
  const model = createProductionChatModel(selected);
  selected.maxOutputTokens = 4096;
  selected.assertCurrent = () => { throw new Error("changed caller object"); };
  const events = await consume(model);
  assert.equal(events.find(event => event.type === "text").text, "answer");
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, "/v1/chat/completions");
  assert.equal(calls[0].authorization, "Bearer fixture-key");
  assert.equal(calls[0].body.model, "chosen-model");
  assert.equal(calls[0].body.max_tokens, 256);
  assert.deepEqual(calls[0].body.stream_options, { include_usage: true });
  assert.equal(JSON.stringify(events).includes("fixture-key"), false);
});

test("Azure uses the selected deployment, API version and api-key", async t => {
  let observed;
  const endpoint = await serverFixture(t, async (req, res) => {
    observed = { url: req.url, key: req.headers["api-key"], authorization: req.headers.authorization, body: await bodyOf(req) };
    complete(res);
  });
  const model = createProductionChatModel({ ...settings(endpoint), provider: "azure-openai", model: "my deployment",
    apiVersion: "2024-06-01", outputTokenParameter: "max_completion_tokens", includeUsage: false });
  assert.equal((await consume(model)).at(-1).reason, "stop");
  assert.equal(observed.url, "/v1/openai/deployments/my%20deployment/chat/completions?api-version=2024-06-01");
  assert.equal(observed.key, "fixture-key");
  assert.equal(observed.authorization, undefined);
  assert.equal(observed.body.model, "my deployment");
  assert.equal(observed.body.max_completion_tokens, 256);
  assert.equal(observed.body.stream_options, undefined);
});

test("unsupported, insecure, missing-key and deprecated profiles fail without fallback", () => {
  const base = settings("https://model.example/v1");
  assert.throws(() => createProductionChatModel({ ...base, provider: "vscode" }), /VS Code.*no HTTP fallback/);
  assert.throws(() => createProductionChatModel({ ...base, endpoint: "http://model.example/v1" }), /HTTPS/);
  assert.throws(() => createProductionChatModel({ ...base, endpoint: "https://user:password@model.example/v1" }), /endpoint/);
  assert.throws(() => createProductionChatModel({ ...base, apiKey: "" }), /API key/);
  assert.throws(() => createProductionChatModel({ ...base, status: "deprecated" }), /deprecated/);
  assert.throws(() => createProductionChatModel({ ...base, assertCurrent: async () => {} }), /synchronous/);
});

test("local empty key retains old local behavior and authentication errors never retry or expose credentials", async t => {
  let count = 0, authorization;
  const endpoint = await serverFixture(t, async (req, res) => {
    count++; authorization = req.headers.authorization;
    await bodyOf(req);
    if (count === 1) complete(res);
    else { res.writeHead(401); res.end(); }
  });
  await consume(createProductionChatModel({ ...settings(endpoint), apiKey: "" }));
  assert.equal(authorization, "Bearer local");
  const secret = "fixture-secret-never-log";
  await assert.rejects(consume(createProductionChatModel({ ...settings(endpoint), apiKey: secret })), error => {
    assert.match(String(error), /MODEL_AUTHENTICATION/);
    assert.equal(String(error).includes(secret), false);
    return true;
  });
  assert.equal(count, 2);
});

test("selection revocation during asynchronous tool discovery prevents model dispatch", async t => {
  let requests = 0, entered, release, current = true;
  const endpoint = await serverFixture(t, (_req, res) => { requests++; complete(res); });
  const waiting = new Promise(resolve => { entered = resolve; });
  const model = createProductionChatModel({ ...settings(endpoint),
    assertCurrent() { if (!current) throw new Error("model selection revoked"); },
    tools: async () => { entered(); await new Promise(resolve => { release = resolve; }); return []; } });
  const pending = consume(model);
  await waiting; current = false; release();
  await assert.rejects(pending, /selection revoked/);
  assert.equal(requests, 0);
});

test("cancellation during streaming aborts the selected request without retry", async t => {
  let requests = 0;
  const endpoint = await serverFixture(t, async (req, res) => {
    requests++; await bodyOf(req);
    res.writeHead(200, { "content-type": "text/event-stream" });
    res.write(`data: ${JSON.stringify({ choices: [{ index: 0, delta: { content: "partial" }, finish_reason: null }] })}\n\n`);
  });
  const abort = new AbortController();
  const iterator = createProductionChatModel(settings(endpoint)).stream(request(abort.signal));
  assert.equal((await iterator.next()).value.text, "partial");
  abort.abort();
  await assert.rejects(iterator.next(), /MODEL_CANCELLED/);
  assert.equal(requests, 1);
});
