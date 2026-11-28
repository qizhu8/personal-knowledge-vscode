const assert = require("node:assert/strict");
const { once } = require("node:events");
const { createServer } = require("node:http");
const { registerHooks } = require("node:module");
const { join } = require("node:path");
const { test } = require("node:test");

const hook = registerHooks({ resolve(specifier, context, next) {
  if (specifier === "vscode") throw Error("Dispatch must not load a VS Code API");
  return next(specifier, context);
} });
const { dispatchNativeChatModel } = require(join(process.env.PKM_CHAT_TEST_BUILD || join(__dirname, "../dist"),
  "chat/native-chat-model-dispatch"));
hook.deregister();

test("native model dispatch streams the exact configured HTTP provider in plain Node and Stop closes its stream",
  { timeout: 8000 }, async t => {
    const calls = [];
    let providerClosed;
    const closed = new Promise(resolve => { providerClosed = resolve; });
    const server = createServer(async (req, res) => {
      let raw = "";
      for await (const chunk of req) raw += chunk;
      const body = JSON.parse(raw);
      calls.push({ url: req.url, body, key: req.headers["api-key"], auth: req.headers.authorization });
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.write('data: {"choices":[{"index":0,"delta":{"content":"fixture output"}}]}\n\n');
      if (body.messages[0].content === "hold") res.once("close", providerClosed);
      else res.end('data: {"choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n');
    }).listen(0, "127.0.0.1");
    t.after(() => { server.closeAllConnections(); server.close(); });
    await once(server, "listening");
    const endpoint = `http://127.0.0.1:${server.address().port}/v1`;
    const prepare = (text, signal) => ({ endpoint, model: "fixture-model", apiKey: "fixture-key",
      messages: [{ role: "user", content: text }], signal, timeoutMs: 2000, maxOutputTokens: 32, tools: [] });
    let answer = "";
    await dispatchNativeChatModel({ provider: "openai-compatible" }, prepare("complete", new AbortController().signal), chunk => { answer += chunk; });
    assert.equal(answer, "fixture output");
    assert.equal(calls[0].url, "/v1/chat/completions");
    assert.equal(calls[0].auth, "Bearer fixture-key");
    assert.equal(calls[0].body.model, "fixture-model");
    assert.equal(calls[0].body.tools, undefined);
    await dispatchNativeChatModel({ provider: "azure-openai" }, {
      ...prepare("complete", new AbortController().signal), apiVersion: "2024-06-01",
    }, () => {});
    assert.match(calls[1].url, /^\/v1\/openai\/deployments\/fixture-model\/chat\/completions\?api-version=2024-06-01$/);
    assert.equal(calls[1].key, "fixture-key");

    await assert.rejects(dispatchNativeChatModel({ provider: "vscode" }, prepare("do not fall back", new AbortController().signal), () => {}),
      /requires its owning host/);
    await assert.rejects(dispatchNativeChatModel({ provider: "openai-compatible" }, prepare("do not dispatch", AbortSignal.abort()), () => {}),
      /cancelled/);
    assert.equal(calls.length, 2);

    const stop = new AbortController();
    const deltas = [];
    await assert.rejects(dispatchNativeChatModel({ provider: "openai-compatible" }, prepare("hold", stop.signal), chunk => {
      deltas.push(chunk);
      stop.abort();
    }), /cancelled/);
    await closed;
    assert.deepEqual(deltas, ["fixture output"]);
    assert.equal(calls.length, 3);
  });
