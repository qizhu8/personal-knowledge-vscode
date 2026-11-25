import assert from "node:assert/strict";
import test from "node:test";
import { ModelConfigService } from "../dist/model-config.js";
import { ModelProviderService, ModelProviderError, createModelProviderHttpTransport } from "../dist/model-provider.js";

const encoder = new TextEncoder();
const chunk = (delta = {}, finish_reason = null) => `data: ${JSON.stringify({ choices: [{ index: 0, delta, finish_reason }] })}\n\n`;
const done = "data: [DONE]\n\n";
const stop = chunk({}, "stop");
const usage = (input = 100, output = 20, extra = {}) => `data: ${JSON.stringify({ choices: [], usage: { prompt_tokens: input, completion_tokens: output, ...extra } })}\n\n`;
const tools = [{ name: "lookup", description: "Synthetic only", parameters: {
  type: "object", properties: { query: { type: "string", minLength: 1 } }, required: ["query"], additionalProperties: false,
} }];
const request = (extra = {}) => ({ messages: [{ role: "user", content: "Hello" }], signal: new AbortController().signal, ...extra });
const configuration = {
  aiEndpoint: "https://example.test/v1", aiModel: "test-model",
  apiChatModelProfiles: [{ id: "test-model", status: "active", contextWindow: 8192, maxOutputTokens: 256, includeUsage: true }],
};
const secretResolver = { resolveSecret: async () => ({ opaque: true }) };
function config(value = configuration) {
  return new ModelConfigService({ configuration: value, secretResolver, registryAvailability: { "openai-compatible": true, "azure-openai": true } });
}
function stream(parts, onCancel = () => {}) {
  return new ReadableStream({
    start(controller) { for (const part of parts) controller.enqueue(typeof part === "string" ? encoder.encode(part) : part); controller.close(); },
    cancel: onCancel,
  });
}
function harness(parts, options = {}) {
  const calls = [];
  const transport = {
    supports: provider => provider !== "vscode",
    async open(input) { calls.push(input); return typeof parts === "function" ? parts(input) : stream(parts); },
  };
  return { calls, service: new ModelProviderService({ modelConfig: config(), transport, ...options }) };
}
async function collect(service, input = request()) {
  const events = [];
  for await (const event of service.stream(input)) events.push(event);
  return events;
}
async function failure(service, code, input = request(), expectedDispatch = "uncertain") {
  await assert.rejects(collect(service, input), error => {
    assert.ok(error instanceof ModelProviderError);
    assert.equal(error.code, code);
    assert.equal(error.dispatch, expectedDispatch);
    assert.equal(error.cause, undefined);
    assert.doesNotMatch(error.message, /sk-test|example\.test|private internal|credential/);
    return true;
  });
}
const call = (index = 0, id = "call-1", name = "lookup", args = '{"query":"hi"}') =>
  ({ index, id, type: "function", function: { name, arguments: args } });

test("absent provider and native capability explicitly unavailable; never fake success", async () => {
  const service = new ModelProviderService({ modelConfig: config() });
  assert.equal(service.available, false);
  assert.equal(service.availability("vscode").available, false);
  await failure(service, "provider-unavailable", request(), "not-sent");
  const h = harness([]);
  await failure(h.service, "provider-unavailable", request({ provider: "vscode" }), "not-sent");
  assert.equal(h.calls.length, 0);
});

test("original hello-world fragmented fixture and exact payload/usage normalization", async () => {
  const wire = chunk({ content: "hello " }) + chunk({ content: "world" }) + stop
    + usage(100, 20, { copilot_usage: { total_nano_aiu: 2000000001 } }) + done;
  const h = harness([wire.slice(0, 17), wire.slice(17, 43), wire.slice(43)]);
  const result = await collect(h.service);
  assert.equal(result.filter(e => e.type === "text").map(e => e.text).join(""), "hello world");
  assert.deepEqual(result.find(e => e.type === "usage"), { type: "usage", inputTokens: 100, outputTokens: 20, copilotNanoAiu: 2000000001 });
  assert.deepEqual(result.at(-1), { type: "finish", reason: "stop" });
  assert.deepEqual(h.calls[0].payload, {
    model: "test-model", messages: request().messages, stream: true, max_completion_tokens: 256,
    stream_options: { include_usage: true },
  });

  assert.equal(h.calls.length, 1);
});

test("a bounded 100,000-byte historical assistant message is sent without truncation", async () => {
  const content = "x".repeat(100_000);
  const calls = [];
  const service = new ModelProviderService({
    modelConfig: config({ ...configuration, apiChatModelProfiles: [
      { id: "test-model", status: "active", contextWindow: 130_000, maxOutputTokens: 256 },
    ] }),
    transport: { supports: name => name === "openai-compatible",
      async open(input) { calls.push(input); return stream([chunk({ content: "ok" }), stop, done]); } },
  });
  await collect(service, request({ messages: [{ role: "assistant", content }, { role: "user", content: "continue" }] }));
  assert.equal(calls.length, 1);
  assert.equal(calls[0].payload.messages[0].content, content);
});

test("UTF8 byte fragmentation, CRLF/CR framing, SSE comments and multiline data", async () => {
  const wire = encoder.encode(': comment\r\nevent: message\r\ndata: {"choices":[\r\ndata: {"delta":{"content":"你好 🌍"},"finish_reason":null}]}\r\n\r\n'
    + stop.replace(/\n/g, "\r") + done.replace(/\n/g, "\r"));
  const h = harness([...wire].map(byte => Uint8Array.of(byte)));
  const events = await collect(h.service);
  assert.equal(events[0].text, "你好 🌍");
});

test("only explicit public reasoning summary, never hidden reasoning or opaque metadata", async () => {
  const h = harness([chunk({ reasoning_summary: "Check the inputs.", reasoning_content: "private internal text", thinking: "opaque" }), chunk({ content: "Done." }), stop, done]);
  const result = await collect(h.service);
  assert.deepEqual(result, [{ type: "reasoning-summary", text: "Check the inputs." }, { type: "text", text: "Done." }, { type: "finish", reason: "stop" }]);
});

test("tool fragments accumulated by index, validated, sorted and only released after completed usage", async () => {
  const h = harness([chunk({ tool_calls: [call(1, "b", "lookup", '{"query":'), call(0, "a", "lookup", '{"query":"a"}')] }),
    chunk({ tool_calls: [{ index: 1, function: { arguments: '"b"}' } }] }), chunk({}, "tool_calls"), usage(), done]);
  const events = await collect(h.service, request({ tools }));
  assert.deepEqual(events.map(e => e.type), ["usage", "tool", "tool", "finish"]);
  assert.deepEqual(events.slice(1, 3).map(e => [e.id, e.arguments.query]), [["a", "a"], ["b", "b"]]);
});

for (const [label, fragments] of [
  ["invalid JSON", [call(0, "a", "lookup", '{"query":')]],
  ["array arguments", [call(0, "a", "lookup", "[]")]],
  ["wrong schema type", [call(0, "a", "lookup", '{"query":1}')]],
  ["missing required", [call(0, "a", "lookup", "{}")]],
  ["extra property", [call(0, "a", "lookup", '{"query":"x","extra":true}')]],
  ["dangerous keys", [call(0, "a", "lookup", '{"query":"x","__proto__":{}}')]],
  ["unknown tool", [call(0, "a", "missing")]],
  ["duplicate identity", [call(0, "a"), call(1, "a")]],
  ["invalid identity", [call(0, "unsafe\nid")]],
  ["invalid index", [call(16)]],
  ["wrong function type", [{ ...call(), type: "custom" }]],
  ["wrong argument delta", [{ index: 0, function: { arguments: {} } }]],
]) test(`invalid tool ${label} fails closed with zero proposals`, async () => {
  const h = harness([chunk({ tool_calls: fragments }), chunk({}, "tool_calls"), done]);
  const observed = [];
  await assert.rejects(async () => { for await (const e of h.service.stream(request({ tools }))) observed.push(e); }, ModelProviderError);
  assert.equal(observed.some(e => e.type === "tool"), false);
  assert.equal(h.calls.length, 1);
});

test("no tools, duplicate prior ID, and unsupported schema cannot authorize proposals", async () => {
  const wire = [chunk({ tool_calls: [call()] }), chunk({}, "tool_calls"), done];
  await failure(harness(wire).service, "invalid-tool");
  await failure(harness(wire).service, "invalid-tool", request({ tools, messages: [
    { role: "assistant", content: "", tool_calls: [{ id: "call-1", type: "function", function: { name: "lookup", arguments: '{"query":"old"}' } }] },
    { role: "tool", content: "old result", tool_call_id: "call-1" }, { role: "user", content: "again" },
  ] }));
  const h = harness(wire);
  await failure(h.service, "invalid-tool", request({ tools: [{ ...tools[0], parameters: { type: "object", $ref: "remote" } }] }), "not-sent");
  assert.equal(h.calls.length, 0);
});

test("length preserves text but never releases incomplete tool proposals", async () => {
  const h = harness([chunk({ content: "partial", tool_calls: [call()] }), chunk({}, "length"), done]);
  assert.deepEqual(await collect(h.service, request({ tools })), [{ type: "text", text: "partial" }, { type: "finish", reason: "length" }]);
});

test("final output usage over budget prevents every pending tool", async () => {
  const h = harness([chunk({ tool_calls: [call()] }), chunk({}, "tool_calls"), usage(100, 257), done]);
  await failure(h.service, "output-budget", request({ tools }));
});

for (const [label, wire, code = "invalid-stream"] of [
  ["missing DONE", chunk({ content: "partial" }) + stop],
  ["missing finish", chunk({ content: "partial" }) + done],
  ["truncated event", 'data: {"choices":'],
  ["malformed JSON", "data: {bad}\n\n"],
  ["invalid UTF8", Uint8Array.of(100, 97, 116, 97, 58, 32, 255, 10, 10)],
  ["invalid choices", 'data: {"choices":{}}\n\n'],
  ["multi choice", 'data: {"choices":[{},{}]}\n\n'],
  ["content after finish", stop + chunk({ content: "late" }) + done],
  ["provider error", 'data: {"error":{"message":"sk-test secret"}}\n\n', "provider-error"],
  ["negative usage", usage(-1, 1)],
  ["invalid cached usage", usage(1, 1, { prompt_tokens_details: { cached_tokens: 2 } })],
  ["invalid credits", usage(1, 1, { copilot_usage: { total_nano_aiu: -1 } })],
  ["empty stop", stop + done, "invalid-tool"],
  ["unrequested tool completion", chunk({}, "tool_calls") + done, "invalid-tool"],
  ["unsupported finish", chunk({ content: "partial" }, "content_filter") + done],
]) test(`stream boundary ${label}`, async () => {
  const h = harness([wire]);
  await failure(h.service, code);
  assert.equal(h.calls.length, 1);
});

test("local byte, event and chunk bounds", async () => {
  await failure(harness(["data: " + "x".repeat(65_536) + "\n\n"]).service, "invalid-stream");
  await failure(harness([new Uint8Array(262_145)]).service, "invalid-stream");
  await failure(harness(["\n".repeat(4097)]).service, "invalid-stream");
  await failure(harness([chunk({ content: "x".repeat(40_000) }), chunk({ content: "x".repeat(40_000) }), chunk({ content: "x".repeat(20_001) }), stop, done]).service, "output-budget");
});

test("context/schema/request/image validation before dispatch", async () => {
  const h = harness([]);
  await failure(h.service, "context-budget", request({ contextWindow: 256 }), "not-sent");
  await failure(h.service, "invalid-request", request({ messages: [{ role: "user", content: "x", images: [] }] }), "not-sent");
  await failure(h.service, "invalid-request", request({ messages: [{ role: "tool", content: "x", tool_call_id: "orphan" }] }), "not-sent");
  await failure(h.service, "invalid-request", request({ tools: [{ ...tools[0], execute() {} }] }), "not-sent");
  assert.equal(h.calls.length, 0);
});

test("host admission runs after provider budget validation and immediately before transport", async () => {
  const h = harness([chunk({ content: "ok" }), stop, done]);
  let commits = 0;
  await assert.rejects(async () => {
    for await (const _event of h.service.stream(request({ contextWindow: 256 }), () => { commits++; })) {}
  }, error => error instanceof ModelProviderError && error.code === "context-budget");
  assert.equal(commits, 0);
  assert.equal(h.calls.length, 0);
  for await (const _event of h.service.stream(request(), () => { assert.equal(h.calls.length, 0); commits++; })) {}
  assert.equal(commits, 1);
  assert.equal(h.calls.length, 1);
});

test("malicious accessors and cyclic input never execute or escape sanitized errors", async () => {
  let invoked = false;
  const message = { role: "user", get content() { invoked = true; throw Error("secret"); } };
  const h = harness([]);
  await failure(h.service, "invalid-request", request({ messages: [message] }), "not-sent");
  const top = request();
  Object.defineProperty(top, "provider", { get() { invoked = true; throw Error("secret"); } });
  await failure(h.service, "invalid-request", top, "not-sent");
  const array = [];
  Object.defineProperty(array, "0", { get() { invoked = true; throw Error("secret"); } });
  await failure(h.service, "invalid-request", request({ messages: array }), "not-sent");
  assert.equal(invoked, false);
  const cyclic = {}; cyclic.loop = cyclic;
  await failure(h.service, "invalid-request", request({ tools: [{ ...tools[0], parameters: cyclic }] }), "not-sent");
});

test("cancel before dispatch and hung connect ignore-abort still interrupt promptly", async () => {
  const cancelled = new AbortController(); cancelled.abort();
  const h = harness([]);
  await failure(h.service, "cancelled", request({ signal: cancelled.signal }), "not-sent");
  assert.equal(h.calls.length, 0);
  let release;
  const hung = harness(() => new Promise(resolve => { release = resolve; }), { idleTimeoutMs: 15 });
  await failure(hung.service, "timeout");
  assert.equal(hung.calls[0].signal.aborted, true);
  assert.equal(hung.calls.length, 1);
  assert.equal(hung.service.activity(), 1);
  release(stream([chunk({ content: "late ignored result" }), stop, done]));
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(hung.service.activity(), 0);
});

test("cancel stalled reader and explicit consumer return release underlying stream", async () => {
  let cancelled = 0;
  const h = harness(() => new ReadableStream({ start(c) { c.enqueue(encoder.encode(chunk({ content: "partial" }))); }, cancel() { cancelled++; } }), { idleTimeoutMs: 15 });
  await failure(h.service, "timeout");
  assert.equal(cancelled, 1);
  const h2 = harness(() => new ReadableStream({ start(c) { c.enqueue(encoder.encode(chunk({ content: "partial" }))); }, cancel() { cancelled++; } }));
  const iterator = h2.service.stream(request());
  assert.equal((await iterator.next()).value.text, "partial");
  await iterator.return();
  assert.equal(cancelled, 2);
  assert.equal(h2.calls[0].signal.aborted, true);
});

test("total lifetime bounds continuously active bytes; no uncertain replay", async () => {
  let timer;
  const h = harness(() => new ReadableStream({
    start(c) { timer = setInterval(() => c.enqueue(encoder.encode(": ping\n\n")), 2); },
    cancel() { clearInterval(timer); },
  }), { idleTimeoutMs: 30, totalTimeoutMs: 18 });
  await failure(h.service, "timeout");
  assert.equal(h.calls.length, 1);
});

test("transport exception never exposes endpoint, headers or cause, nor retries", async () => {
  const h = harness(() => { throw Error("sk-test credential https://example.test/v1"); });
  await failure(h.service, "transport-error");
  assert.equal(h.calls.length, 1);
});

function httpOptions(fetch) {
  return { endpoint: "https://example.test/v1", allowedEndpoints: ["https://example.test/v1"], fetch, secretResolver,
    authorization: async (_, provider) => provider === "azure-openai" ? { "api-key": "synthetic-only" } : { authorization: "Bearer synthetic-only" } };
}
test("HTTP factory injected fetch only, allowlist exact, redirects disabled, opaque auth native", async () => {
  let sent = 0;
  const transport = createModelProviderHttpTransport(httpOptions(async (url, init) => {
    sent++;
    assert.equal(url, "https://example.test/v1/chat/completions");
    assert.equal(init.redirect, "error");
    assert.equal(init.credentials, "omit");
    assert.equal(new Headers(init.headers).get("authorization"), "Bearer synthetic-only");
    return new Response(stream([chunk({ content: "synthetic" }), stop, done]), { headers: { "content-type": "text/event-stream" } });
  }));
  const service = new ModelProviderService({ modelConfig: config(), transport });
  assert.equal((await collect(service))[0].text, "synthetic");
  assert.equal(sent, 1);
  for (const endpoint of ["https://example.test/v1/evil", "http://example.test/v1", "https://user:pass@example.test/v1", "https://example.test/v1?q=secret", "https://example.test/v1#hash"]) {
    assert.throws(() => createModelProviderHttpTransport({ ...httpOptions(async () => {}), endpoint }), ModelProviderError);
  }
});

test("Azure original deployment URL, version default, api-key auth, max_tokens option", async () => {
  let seen = false;
  const transport = createModelProviderHttpTransport(httpOptions(async (url, init) => {
    seen = true;
    assert.equal(url, "https://example.test/v1/openai/deployments/test-model/chat/completions?api-version=2024-06-01");
    assert.equal(new Headers(init.headers).get("api-key"), "synthetic-only");
    assert.equal(JSON.parse(init.body).max_tokens, 64);
    return new Response(stream([chunk({ content: "azure synthetic" }), stop, done]), { headers: { "content-type": "text/event-stream; charset=utf-8" } });
  }));
  const modelConfig = config({ ...configuration, apiChatModelProfiles: [{ ...configuration.apiChatModelProfiles[0], outputTokenParameter: "max_tokens" }] });
  await collect(new ModelProviderService({ modelConfig, transport }), request({ provider: "azure-openai", maxOutputTokens: 64 }));
  assert.equal(seen, true);
});

for (const [status, code, retryable] of [[401, "authentication", false], [429, "rate-limited", true], [503, "provider-error", true]]) {
  test(`HTTP ${status} sanitized metadata; one send, never retries`, async () => {
    let sent = 0;
    const transport = createModelProviderHttpTransport(httpOptions(async () => {
      sent++;
      return new Response("sk-test secret response", { status });
    }));
    const service = new ModelProviderService({ modelConfig: config(), transport });
    await assert.rejects(collect(service), error => error.code === code && error.retryable === retryable && !error.message.includes("secret"));
    assert.equal(sent, 1);
  });
}

test("HTTP rejects JSON fallback, absent credentials and unsafe authorization headers", async () => {
  const transport = createModelProviderHttpTransport(httpOptions(async () => new Response('{"fake":"success"}', { headers: { "content-type": "application/json" } })));
  await failure(new ModelProviderService({ modelConfig: config(), transport }), "invalid-stream");
  let sent = 0;
  const opts = httpOptions(async () => { sent++; throw Error(); });
  const bad = createModelProviderHttpTransport({ ...opts, authorization: async () => ({ authorization: "Bearer fake", host: "evil" }) });
  await failure(new ModelProviderService({ modelConfig: config(), transport: bad }), "authentication");
  assert.equal(sent, 0);
});

test("HTTP native authorization failures sanitized even at direct transport boundary", async () => {
  const opts = httpOptions(async () => { throw Error("fetch must not run"); });
  const transport = createModelProviderHttpTransport({ ...opts, authorization: async () => { throw Error("sk-test native credential"); } });
  await assert.rejects(transport.open({ provider: "openai-compatible", payload: { model: "synthetic", messages: [], stream: true },
    signal: new AbortController().signal }), error => error instanceof ModelProviderError
      && error.code === "authentication" && error.dispatch === "not-sent" && !error.message.includes("credential"));
});
