import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import Module, { createRequire } from "node:module";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import test from "node:test";
import { fileURLToPath } from "node:url";

// These isolated API/model doubles exercise the adapter, not installed-native proof.
const require = createRequire(import.meta.url), { build } = require("esbuild");
const root = fileURLToPath(new URL("../../", import.meta.url));
const diagnosticChannels = new WeakMap();
const digest = value => createHash("sha256").update(value instanceof Uint8Array ? Buffer.from(value)
  : typeof value === "string" ? value : canonical(value)).digest("hex");
function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object")
    return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonical(value[key])}`).join(",")}}`;
  return JSON.stringify(value);
}
const retained = await build({
  stdin: { contents: 'export {streamVscodeChat} from "./src/chat/api-chat-vscode"; export {decodeChatImage} from "./src/chat/api-chat-client";', resolveDir: join(root, "legacy") },
  absWorkingDir: root, bundle: true, platform: "node", format: "cjs", external: ["vscode"],
  write: false, metafile: true, logLevel: "silent",
});
const producer = await build({
  entryPoints: [join(root, "clients/vscode-host/original-mcp-native-chat.ts")],
  bundle: true, platform: "node", format: "cjs", external: ["vscode"], write: false, logLevel: "silent",
  plugins: [{ name: "explicit-test-signer", setup(plugin) {
    plugin.onResolve({ filter: /original-mcp-native-identity\.js$/ }, () => ({ path: "native-chat-test-signer", external: true }));
  } }],
});

async function fixture(t, changes = {}) {
  const directory = join(root, ".pkm-test-evidence", `native-chat-${randomUUID()}`);
  const bundlePath = join(directory, "next-runtime/server/dist/native-vscode-chat-retained.cjs");
  let native, nativeLoad;
  t.after(async () => {
    native?.dispose();
    if (nativeLoad) Module._load = nativeLoad;
    delete require.cache[bundlePath];
    await rm(directory, { recursive: true, force: true });
  });
  await mkdir(join(directory, "next-runtime/server/dist"), { recursive: true, mode: 0o700 });
  await writeFile(bundlePath, retained.outputFiles[0].contents);
  await writeFile(join(directory, "package.json"), '{"type":"commonjs"}\n');
  await writeFile(join(directory, "next-runtime/manifest.json"), JSON.stringify({
    schema: "pkm.next-payload/v1",
    files: { "server/dist/native-vscode-chat-retained.cjs": digest(retained.outputFiles[0].contents) },
  }));
  const lifetime = new AbortController(), registry = new Set(), calls = [], counts = [], tokens = [];
  let scripted = [], available, current = true, send = changes.send;
  class CancellationTokenSource {
    constructor() {
      const listeners = new Set();
      this.token = {
        isCancellationRequested: false,
        onCancellationRequested(fn) { listeners.add(fn); return { dispose() { listeners.delete(fn); } }; },
      };
      this.cancel = () => {
        if (this.token.isCancellationRequested) return;
        this.token.isCancellationRequested = true;
        for (const listener of listeners) listener();
      };
      this.dispose = () => {};
      tokens.push(this.token);
    }
  }
  class Text { constructor(value) { this.value = value; } }
  class ToolCall { constructor(callId, name, input) { Object.assign(this, { callId, name, input }); } }
  class ToolResult { constructor(callId, content) { Object.assign(this, { callId, content }); } }
  class Data { constructor(data, mimeType) { Object.assign(this, { data, mimeType }); } }
  class Thinking { constructor(value) { this.value = value; } }
  const model = {
    id: "fixture-model", vendor: "fixture-vendor", name: "Fixture model", family: "fixture", version: "1",
    maxInputTokens: 200000, capabilities: { toolCalling: true },
    async countTokens(value, token) {
      counts.push({ value, token });
      if (changes.count) return changes.count(value, token);
      return typeof value === "string" ? value.length : 3;
    },
    async sendRequest(messages, options, token) {
      calls.push({ messages, options, token });
      if (send) return send(messages, options, token);
      const parts = scripted.shift() || [new Text("done")];
      return { text: { async *[Symbol.asyncIterator]() {} }, stream: { async *[Symbol.asyncIterator]() {
        for (const part of parts) {
          if (part instanceof Error) throw part;
          yield part;
        }
      } } };
    },
  };
  available = [model];
  const queries = [];
  const api = {
    CancellationTokenSource, LanguageModelTextPart: Text, LanguageModelToolCallPart: ToolCall,
    LanguageModelToolResultPart: ToolResult, LanguageModelDataPart: Data, LanguageModelThinkingPart: Thinking,
    LanguageModelChatMessage: {
      User: content => ({ role: 1, content }), Assistant: content => ({ role: 2, content }),
    },
    lm: {
      onDidChangeChatModels(fn) { registry.add(fn); return { dispose() { registry.delete(fn); } }; },
      async selectChatModels(selector) {
        queries.push(selector);
        changes.discover?.(selector, () => { for (const listener of registry) listener(); });
        return available.filter(item => !selector || item.id === selector.id && item.vendor === selector.vendor);
      },
    },
  };
  const signer = { activationId: "fixture-activation", signal: lifetime.signal,
    assertCurrent() { if (!current) throw new Error("Fixture signer revoked"); } };
  nativeLoad = Module._load;
  Module._load = function(id, ...args) {
    if (id === "vscode") return api;
    if (id === "native-chat-test-signer") return { originalMcpNativeSigner: async () => signer };
    return nativeLoad.call(this, id, ...args);
  };
  const compiled = new Module(join(directory, "producer.cjs"));
  compiled.filename = join(directory, "producer.cjs"); compiled.paths = Module._nodeModulePaths(directory);
  compiled._compile(producer.outputFiles[0].text, compiled.filename);
  const context = { extensionPath: directory, subscriptions: [] };
  const diagnostics = diagnosticChannels.get(t) ?? { appendLine() {} };
  native = await compiled.exports.createOriginalMcpNativeChatProducer(context, diagnostics);
  assert.equal(await compiled.exports.createOriginalMcpNativeChatProducer(context, diagnostics), native);
  const signal = new AbortController().signal;
  async function select() {
    const catalogue = await native.models.catalogue(signal);
    const selection = await native.models.select({
      modelId: catalogue.models[0].id, catalogueSha256: digest(catalogue),
    }, signal);
    return { catalogue, selection };
  }
  return { ...native, select, signal, model, api, calls, counts, tokens, queries, directory,
    Text, ToolCall, Data, Thinking, script(parts) { scripted = parts; }, setSend(value) { send = value; },
    setAvailable(value) { available = value; }, invalidate() { for (const fn of registry) fn(); },
    revoke() { current = false; lifetime.abort(); } };
}
const messages = [{ role: "system", content: "exact system" }, { role: "user", content: "request" }];
const tools = [{ name: "canonical_tool", description: "Core-owned fixture operation", parameters: { type: "object" } }];
function plan(selection, changes = {}) {
  return { schema: "pkm.original-api-chat-execution/v1", requestId: randomUUID(),
    chatUrl: "api-chat/fixture", selectionId: selection.selectionId, sourcePlanSha256: "a".repeat(64),
    messages, tools, hardToolRoundLimit: 1, outputTokenCap: 1024,
    budget: { maxInputTokens: 200000, maxTotalOutputTokens: 32768, deadlineMs: 300000 }, ...changes };
}
function raw(selection, requestId, changes = {}) {
  const request = { selectionId: selection.selectionId, requestId, messages, tools, outputTokenCap: 1024, ...changes };
  return { ...request, requestSha256: digest({ protocol: "pkm.original-vscode-model-request/v1", ...request }) };
}
function ports(changes = {}) {
  const admissions = [], executed = [], texts = [], usage = [];
  return { admissions, executed, texts, usages: usage, async beforeInference(value) { admissions.push(value); },
    async tool(value) { executed.push(value); return { receiptSha256: "b".repeat(64), content: "Core receipt", effect: "committed" }; },
    async text(value) { texts.push(value); }, async usage(value) { usage.push(value); }, ...changes };
}
async function collect(iterable) { const result = []; for await (const event of iterable) result.push(event); return result; }
async function until(predicate) {
  for (let i = 0; i < 200; i++) { if (predicate()) return; await new Promise(resolve => setTimeout(resolve, 2)); }
  assert.fail("Fixture condition not reached");
}
function firstCancellationRecords(t, throwLogger = false) {
  const prefix = "[pkm.native-chat.first-cancel] ", records = [];
  diagnosticChannels.set(t, { appendLine(line) {
    if (typeof line === "string" && line.startsWith(prefix)) {
      records.push(JSON.parse(line.slice(prefix.length)));
      if (throwLogger) throw new Error("fixture diagnostic sink failed");
    }
  } });
  if (throwLogger) t.mock.method(console, "error", () => { throw new Error("fixture fallback sink failed"); });
  return records;
}

test("native catalogue reports only actual metadata, exact selections never fall back, registry changes revoke handles", async t => {
  const f = await fixture(t);
  f.setAvailable([f.model, { ...f.model, id: "cli", vendor: "copilotcli" }]);
  const { catalogue, selection } = await f.select();
  assert.equal(catalogue.models.length, 1);
  assert.equal(catalogue.models[0].maxOutputTokens, null);
  assert.equal(catalogue.models[0].maxInputTokens, f.model.maxInputTokens);
  assert.deepEqual(f.queries[1], { id: f.model.id, vendor: f.model.vendor });
  await assert.rejects(f.models.select({ modelId: "missing", catalogueSha256: digest(catalogue) }, f.signal), /REQUESTED_MODEL/);
  await assert.rejects(f.models.select({ modelId: catalogue.models[0].id, catalogueSha256: "0".repeat(64) }, f.signal), /STALE_CATALOGUE/);
  f.model.version = "replaced";
  await assert.rejects(f.models.count({ selectionId: selection.selectionId, requestSha256: "c".repeat(64), messages, tools: [] }, f.signal), /STALE_MODEL/);
  assert.equal(f.calls.length, 0);
  const fresh = await f.select();
  f.invalidate();
  await assert.rejects(f.models.count({ selectionId: fresh.selection.selectionId, requestSha256: "c".repeat(64), messages, tools: [] }, f.signal), /STALE_SELECTION/);
});

test("native initial registry discovery can settle without cancelling catalogue availability or replaying inference", async t => {
  let queries = 0;
  const f = await fixture(t, { discover(selector, invalidate) {
    if (!selector && queries++ === 0) invalidate();
  } });
  const { catalogue } = await f.select();
  assert.equal(catalogue.models.length, 1);
  assert.equal(queries, 2, "Only read-only catalogue discovery may retry its initial registry change.");
  assert.equal(f.calls.length, 0);
});

test("native discovery retries are bounded and never ignore the caller's cancellation", async t => {
  const f = await fixture(t, { discover(_selector, invalidate) { invalidate(); } });
  await assert.rejects(f.models.catalogue(f.signal), /CATALOGUE_CHANGED/);
  assert.equal(f.queries.length, 3);
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(f.models.catalogue(controller.signal), /CANCELLED/);
  assert.equal(f.calls.length, 0);
});

test("raw native count and send share exact conversion, genuine token calls, public proposals and no invented usage", async t => {
  const f = await fixture(t), { selection } = await f.select();
  const request = raw(selection, "single-inference");
  const counted = await f.models.count(request, f.signal);
  assert.equal(counted.countingMethod, "vscode-countTokens-plus-tool-overhead");
  assert.equal(counted.inputTokens, 32 + 2 * (3 + 32) + JSON.stringify([{ name: tools[0].name,
    description: tools[0].description, inputSchema: tools[0].parameters }]).length + 32);
  f.script([[new f.Text("hello"), new f.ToolCall("call-1", tools[0].name, { note: 1 })]]);
  const events = await collect(f.models.stream({ ...request, requestId: "single-inference", outputTokenCap: 1024 }, f.signal));
  assert.deepEqual(events.map(event => event.type), ["text", "tool", "finish"]);
  assert.equal(f.calls.length, 1);
  assert.deepEqual(f.calls[0].messages, f.counts.slice(0, 2).map(item => item.value));
  assert.equal(f.calls[0].messages[0].content[0].value, "[PKM instructions and reference context]\nexact system");
  await assert.rejects(collect(f.models.stream({ ...request, requestId: "single-inference", outputTokenCap: 1024 }, f.signal)), /INVOCATION_REPLAY/);
  assert.equal(f.calls.length, 1);
});

test("raw native output is capped before delivery, and only genuine metadata produces usage", async t => {
  const f = await fixture(t), { selection } = await f.select();
  const request = raw(selection, "capped", { tools: [], outputTokenCap: 4 });
  await f.models.count(request, f.signal);
  f.script([[new f.Text("12345")]]);
  const seen = [];
  await assert.rejects((async () => {
    for await (const event of f.models.stream({ ...request, requestId: "capped", outputTokenCap: 4 }, f.signal)) seen.push(event);
  })(), { code: "NATIVE_CHAT_DISPATCH_UNCERTAIN" });
  assert.deepEqual(seen, []);
  f.script([[new f.Thinking("not public"), new f.Text("ok"),
    new f.Data(Buffer.from('{"prompt_tokens":12,"completion_tokens":2}'), "usage")]]);
  const reported = raw(selection, "reported", { tools: [], outputTokenCap: 4 });
  await f.models.count(reported, f.signal);
  const events = await collect(f.models.stream(reported, f.signal));
  assert.deepEqual(events, [{ type: "text", text: "ok" }, { type: "usage", inputTokens: 12, outputTokens: 2 },
    { type: "finish", reason: "stop" }]);
});

test("registry and signer revocation cancel real native tokenizer and pending native stream tokens", async t => {
  for (const revoke of ["invalidate", "revoke"]) {
    await t.test(revoke, async t => {
      const records = firstCancellationRecords(t);
      let blocked = false, token;
      const f = await fixture(t, { count: (_value, current) => {
        blocked = true; token = current; return new Promise(() => {});
      } });
      const { selection } = await f.select();
      const pending = f.models.count(raw(selection, "blocked-count", { tools: [] }), f.signal);
      await until(() => blocked);
      f[revoke]();
      await assert.rejects(pending, /CANCELLED|revoked/);
      assert.equal(token.isCancellationRequested, true);
      const cancellations = records.filter(record => record.stage === "token-count");
      assert.equal(cancellations.length, 1);
      assert.equal(cancellations[0].origin, revoke === "invalidate" ? "registry-change" : "producer-lifetime");
      assert.equal(cancellations[0].expectedShutdown, false);
    });
  }
  await t.test("stream", async t => {
    const f = await fixture(t);
    f.setSend(async () => ({ text: { [Symbol.asyncIterator]() { return { next: () => new Promise(() => {}) }; } } }));
    const { selection } = await f.select(), controller = new AbortController();
    const request = raw(selection, "cancelled-stream", { tools: [] });
    await f.models.count(request, f.signal);
    const pending = collect(f.models.stream({ ...request, requestId: "cancelled-stream", outputTokenCap: 1024 }, controller.signal));
    await until(() => f.calls.length === 1);
    controller.abort();
    await assert.rejects(pending, /CANCELLED/);
    assert.equal(f.calls[0].token.isCancellationRequested, true);
  });
});

test("first cancellation telemetry is sanitized and does not replace invocation reasons or replay native work", async t => {
  const records = firstCancellationRecords(t);
  t.mock.method(console, "info", () => { assert.fail("Native cancellation must use its durable output, not DevTools-only info."); });
  let token;
  const f = await fixture(t, { count: (_value, current) => { token = current; return new Promise(() => {}); } });
  const { selection } = await f.select(), controller = new AbortController();
  const pending = f.models.count(raw(selection, "telemetry-count", { tools: [] }), controller.signal);
  await until(() => token);
  const privateValue = "fixture-private-prompt-key-endpoint";
  const reason = Object.assign(new Error(privateValue), { code: "EPIPE",
    cause: Object.assign(new Error(privateValue), { code: privateValue }) });
  controller.abort(reason);
  await assert.rejects(pending, /CANCELLED/);
  assert.equal(controller.signal.reason, reason);
  assert.equal(token.isCancellationRequested, true);
  assert.equal(f.calls.length, 0);
  const cancellations = records.filter(record => record.stage === "token-count");
  assert.equal(cancellations.length, 1);
  assert.equal(cancellations[0].origin, "invocation");
  assert.deepEqual(cancellations[0].causeCodes, ["EPIPE", "UNCLASSIFIED"]);
  assert(!JSON.stringify(cancellations).includes(privateValue));
  assert(cancellations[0].elapsedMs >= 0 && cancellations[0].stageElapsedMs >= 0);
  assert(cancellations[0].rssBytes > 0 && cancellations[0].heapUsedBytes > 0);
});

test("diagnostic logger failure cannot prevent the existing native cancellation", async t => {
  firstCancellationRecords(t, true);
  let token;
  const f = await fixture(t, { count: (_value, current) => { token = current; return new Promise(() => {}); } });
  const { selection } = await f.select(), controller = new AbortController();
  const pending = f.models.count(raw(selection, "failed-diagnostic-count", { tools: [] }), controller.signal);
  await until(() => token);
  controller.abort();
  await assert.rejects(pending, /CANCELLED/);
  assert.equal(token.isCancellationRequested, true);
  assert.equal(f.calls.length, 0);
});

test("retained full native loop awaits durable admission, routes tools only to Core, then performs a tool-free final summary", async t => {
  const f = await fixture(t), { selection } = await f.select(), p = ports();
  f.script([[new f.Text("working"), new f.ToolCall("canonical-1", tools[0].name, { value: 42 })], [new f.Text("final summary")]]);
  let release, blocked = true;
  const barrier = new Promise(resolve => { release = resolve; });
  p.beforeInference = async value => {
    p.admissions.push(value);
    if (p.admissions.length === 1) { await barrier; blocked = false; }
  };
  const running = f.execution.run(plan(selection), p, f.signal);
  await until(() => p.admissions.length === 1);
  assert.equal(f.calls.length, 0);
  release();
  const result = await running;
  assert.equal(blocked, false);
  assert.deepEqual(result, { status: "complete", toolRoundLimit: { limit: 1, rounds: 1, reached: true } });
  assert.equal(f.calls.length, 2);
  assert.equal(p.admissions.length, 2);
  assert.deepEqual(p.admissions.map(item => item.round), [0, 1]);
  assert.notEqual(p.admissions[0].requestSha256, p.admissions[1].requestSha256);
  assert.equal(p.executed.length, 1);
  assert.equal(p.executed[0].callId, "canonical-1");
  assert.deepEqual(p.executed[0].arguments, { value: 42 });
  assert.equal(p.executed[0].argumentsSha256, digest({ value: 42 }));
  assert.equal(p.executed[0].inferenceId, p.admissions[0].inferenceId);
  for (const admission of p.admissions) {
    const { requestSha256, ...bound } = admission;
    assert.equal(requestSha256, digest({ protocol: "pkm.original-api-chat-inference/v1", ...bound }));
    assert.equal(admission.planSha256.length, 64);
    assert.deepEqual(admission.nativeRequest.messages, JSON.parse(JSON.stringify(f.calls[admission.round].messages)));
    assert.deepEqual(admission.nativeRequest.options, f.calls[admission.round].options);
  }
  assert.deepEqual(p.usages.map(item => item.source), ["native-counted", "native-counted"]);
  assert.equal(f.calls[0].options.tools.length, 1);
  assert.equal(f.calls[1].options.tools, undefined);
  assert(f.calls[1].messages.some(message => JSON.stringify(message).includes("Core receipt")));
  assert.equal(p.texts.map(item => item.text).join(""), "workingfinal summary");
});

function fairnessMessages() {
  return Array.from({ length: 94 }, (_, index) => ({ role: "user", content: `fairness request ${index}` }));
}
function fastTokenizerWork() {
  const end = performance.now() + 1;
  while (performance.now() < end) {}
}

test("retained native recount services timer heartbeats without changing genuine count order or admission", async t => {
  let tokenValue = 0;
  const f = await fixture(t, { count() { fastTokenizerWork(); return ++tokenValue; } });
  const { selection } = await f.select(), p = ports(), requestMessages = fairnessMessages();
  let beats = 0, admissionBeats = 0, admissionCounts = 0, maxServiceGapMs = 0;
  const started = performance.now();
  let lastBeat = started;
  const heartbeat = setInterval(() => {
    const now = performance.now();
    maxServiceGapMs = Math.max(maxServiceGapMs, now - lastBeat); lastBeat = now; beats++;
  }, 1);
  t.after(() => clearInterval(heartbeat));
  p.beforeInference = async value => {
    admissionBeats = beats; admissionCounts = f.counts.length;
    p.admissions.push(value);
    assert.equal(f.calls.length, 0, "A yield cannot bypass the awaited inference admission.");
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(f.calls.length, 0, "Native dispatch must still await the admission callback.");
  };
  const result = await f.execution.run(plan(selection, { messages: requestMessages }), p, f.signal);
  clearInterval(heartbeat);
  maxServiceGapMs = Math.max(maxServiceGapMs, performance.now() - lastBeat);
  t.diagnostic(JSON.stringify({ kind: "retained-native-heartbeat-fairness", admissionBeats, admissionCounts,
    nativeCountCallbacks: f.counts.length, maxServiceGapMs, elapsedMs: performance.now() - started }));
  assert.equal(result.status, "complete");
  assert(admissionBeats > 0, "Fast awaited native counts must service the timer heartbeat before admitting inference.");
  assert.equal(admissionCounts, 96, "All 95 messages and the tool schema still require genuine counts.");
  assert.equal(f.counts.length, 98, "Both original output counts must also remain.");
  assert.deepEqual(f.counts.slice(0, 94).map(entry => entry.value.content[0].value),
    requestMessages.map(message => message.content));
  assert.equal(f.counts[95].value, JSON.stringify(f.calls[0].options.tools));
  assert.deepEqual(f.counts.slice(0, 95).map(entry => entry.value), f.calls[0].messages);
  assert.equal(p.admissions[0].inputTokens, 32 + Array.from({ length: 96 }, (_, index) => index + 1 + 32)
    .reduce((sum, value) => sum + value, 0));
  assert.equal(p.usages[0].usage.outputTokens, 98);
  assert.equal(p.texts.map(value => value.text).join(""), "done");
  assert.equal(p.executed.length, 0);
});

test("retained native recount services timer cancellation and rechecks current authority before dispatch", async t => {
  for (const origin of ["invocation", "registry-change", "producer-lifetime", "deadline"]) {
    await t.test(origin, async t => {
      const records = firstCancellationRecords(t), controller = new AbortController();
      let timer, callbacksAtCancellation, started, cancellationElapsedMs;
      const f = await fixture(t, { count() {
        fastTokenizerWork();
        if (f.counts.length === 1 && origin !== "deadline") {
          timer = setTimeout(() => {
            callbacksAtCancellation = f.counts.length;
            cancellationElapsedMs = performance.now() - started;
            if (origin === "invocation") controller.abort();
            else if (origin === "registry-change") f.invalidate();
            else f.revoke();
          }, 0);
        }
        return 3;
      } });
      t.after(() => clearTimeout(timer));
      const { selection } = await f.select(), p = ports(), request = plan(selection, { messages: fairnessMessages() });
      if (origin === "deadline") request.budget.deadlineMs = 20;
      started = performance.now();
      const result = await f.execution.run(request, p, controller.signal);
      clearTimeout(timer);
      const cancellation = records.find(record => record.origin === origin);
      t.diagnostic(JSON.stringify({ kind: "retained-native-cancellation-fairness", origin, status: result.status,
        nativeCountCallbacks: f.counts.length, callbacksAtCancellation: callbacksAtCancellation ?? null,
        cancellationElapsedMs: cancellationElapsedMs ?? cancellation?.elapsedMs ?? null,
        elapsedMs: performance.now() - started, nativeSends: f.calls.length, admissions: p.admissions.length }));
      assert.equal(result.status, "cancelled");
      assert(f.counts.length > 0 && f.counts.length < 96, "Cancellation must stop the still-running native recount.");
      if (origin !== "deadline") assert.equal(f.counts.length, callbacksAtCancellation, "No count may start after cancellation.");
      assert(f.counts.every(entry => entry.token.isCancellationRequested));
      assert.equal(p.admissions.length, 0);
      assert.equal(f.calls.length, 0);
      assert.equal(p.executed.length, 0);
      assert.equal(cancellation?.stage, "execution-token-count");
      assert.equal(cancellation?.expectedShutdown, false);
    });
  }
});

test("managed Task hooks await actual tool settlement before the next retained round and never substitute a model loop", async t => {
  const f = await fixture(t), { selection } = await f.select(), p = ports();
  const request = plan(selection, { requestId: "a".repeat(64), chatUrl: `pkm://chats/0123456789abcdef/${randomUUID()}` });
  const binding = { schema: "pkm.original-native-task-execution/v1",
    taskId: `agent_session_${randomUUID().replaceAll("-", "")}`, attemptId: randomUUID(), inputId: randomUUID(), replyId: randomUUID(),
    requestId: request.requestId, chatId: request.chatUrl.split("/").at(-1), sourcePlanSha256: request.sourcePlanSha256,
    nativeEpoch: "fixture-activation", initialTaskRevision: 1, contextSha256: "c".repeat(64) };
  request.managedTask = { ...binding, bindingSha256: digest(binding) };
  f.script([[new f.ToolCall("task-read", tools[0].name, {})], [new f.Text("Actual evidence remains a recorded claim.")]]);
  const observations = [];
  let release, resolved = false;
  const barrier = new Promise(resolve => { release = resolve; });
  p.taskContext = async input => {
    observations.push(input);
    if (input.phase === "after-tools") {
      assert.equal(p.executed.length, 1);
      await barrier; resolved = true;
    }
    return { schema: "pkm.original-native-task-context/v1", requestId: request.requestId,
      bindingSha256: request.managedTask.bindingSha256, planSha256: digest(request),
      decision: resolved ? "finish" : "continue", continuation: null, errorCode: null,
      goalStatus: resolved ? "resolved" : "active", taskRevision: resolved ? 2 : 1,
      evidenceSha256: "d".repeat(64), stopAfterTools: false };
  };
  const running = f.execution.managedTask.run(request, p, f.signal);
  await until(() => observations.some(input => input.phase === "after-tools"));
  assert.equal(f.calls.length, 1);
  release();
  assert.equal((await running).status, "complete", JSON.stringify({ observations,
    calls: f.calls.length, executed: p.executed.length }));
  assert.equal(f.calls.length, 2);
  assert.deepEqual(observations.map(input => [input.phase, input.round]),
    [["after-round", 0], ["after-tools", 0], ["after-round", 1], ["settled", 1]]);
  assert.equal(observations[2].finalSummary, true);
});

test("managed Task stale endings are settled semantic failure, not success, network uncertainty or automatic retry", async t => {
  const f = await fixture(t), { selection } = await f.select(), p = ports();
  const request = plan(selection, { requestId: "a".repeat(64), tools: [], hardToolRoundLimit: null,
    chatUrl: `pkm://chats/0123456789abcdef/${randomUUID()}` });
  const binding = { schema: "pkm.original-native-task-execution/v1",
    taskId: `agent_session_${randomUUID().replaceAll("-", "")}`, attemptId: randomUUID(), inputId: randomUUID(), replyId: randomUUID(),
    requestId: request.requestId, chatId: request.chatUrl.split("/").at(-1), sourcePlanSha256: request.sourcePlanSha256,
    nativeEpoch: "fixture-activation", initialTaskRevision: 1, contextSha256: "c".repeat(64) };
  request.managedTask = { ...binding, bindingSha256: digest(binding) };
  f.script([[new f.Text("Premature response.")], [new f.Text("Still no evidence.")], [new f.Text("Must never run.")]]);
  const observations = [];
  p.taskContext = async input => {
    observations.push(input);
    return { schema: "pkm.original-native-task-context/v1", requestId: request.requestId,
      bindingSha256: request.managedTask.bindingSha256, planSha256: digest(request),
      decision: input.round === 0 ? "continue" : "reject",
      continuation: input.round === 0 ? "The objective is still open; report precise evidence or a blocker." : null,
      errorCode: input.round === 0 ? null : "GOAL_STALE_ENDINGS", goalStatus: "active",
      taskRevision: 1, evidenceSha256: "d".repeat(64), stopAfterTools: false };
  };
  assert.equal((await f.execution.managedTask.run(request, p, f.signal)).status, "failed");
  assert.equal(f.calls.length, 2);
  assert.equal(p.executed.length, 0);
  assert.deepEqual(observations.map(input => input.phase), ["after-round", "after-round"]);
});

test("retained loop preserves limits above eight/thirty and does not reuse cached old tool results", async t => {
  const f = await fixture(t), { selection } = await f.select(), p = ports();
  p.tool = async value => {
    p.executed.push(value);
    return { receiptSha256: digest({ callId: value.callId }), content: `Core receipt ${p.executed.length}`, effect: "committed" };
  };
  const repeatedRead = { ...tools[0], name: "get_note" };
  f.script([...Array.from({ length: 31 }, (_, index) => [
    new f.ToolCall(`read-${index}`, repeatedRead.name, { slug: "same" }),
  ]), [new f.Text("summary")]]);
  const result = await f.execution.run(plan(selection, { tools: [repeatedRead], hardToolRoundLimit: 31 }), p, f.signal);
  assert.equal(result.status, "complete");
  assert.deepEqual(result.toolRoundLimit, { limit: 31, rounds: 31, reached: true });
  assert.equal(f.calls.length, 32);
  assert.equal(p.executed.length, 31);
  assert.equal(p.admissions.length, 32);
});

test("original image messages are natively counted/sent without loss and unsupported vision fails before dispatch", async t => {
  const f = await fixture(t);
  const image = { label: "inline", mimeType: "image/png",
    dataBase64: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl6zZUAAAAASUVORK5CYII=" };
  let selected = await f.select();
  const imageMessages = [{ role: "user", content: "attached", images: [image] }];
  await assert.rejects(f.models.count(raw(selected.selection, "unsupported-image", {
    messages: imageMessages, tools: [],
  }), f.signal), /MODEL_IMAGES_UNAVAILABLE/);
  assert.equal(f.calls.length, 0);
  f.model.capabilities.imageInput = true; f.invalidate();
  selected = await f.select();
  const request = raw(selected.selection, "native-image", { messages: imageMessages, tools: [] });
  await f.models.count(request, f.signal);
  await collect(f.models.stream(request, f.signal));
  const nativeImage = f.calls[0].messages[0].content[1];
  assert(nativeImage instanceof f.Data);
  assert.equal(nativeImage.mimeType, "image/png");
  assert.equal(Buffer.from(nativeImage.data).toString("base64"), image.dataBase64);
  assert.equal((await f.execution.run(plan(selected.selection, { messages: imageMessages, tools: [] }), ports(), f.signal)).status, "complete");
  assert.equal(Buffer.from(f.calls[1].messages[0].content[1].data).toString("base64"), image.dataBase64);
});

test("explicit execution budgets, final-summary tool prohibition, and upper round-limit validation fail closed", async t => {
  const f = await fixture(t), { selection } = await f.select();
  for (const hardToolRoundLimit of [0, 1001]) {
    assert.equal((await f.execution.run(plan(selection, { hardToolRoundLimit }), ports(), f.signal)).status, "failed");
  }
  const budget = plan(selection).budget;
  assert.equal((await f.execution.run(plan(selection, { budget: { ...budget, maxInputTokens: 10 } }), ports(), f.signal)).status, "failed");
  assert.equal(f.calls.length, 0);
  assert.equal((await f.execution.run(plan(selection, { hardToolRoundLimit: 1000 }), ports(), f.signal)).status, "complete");
  const p = ports();
  f.script([[new f.ToolCall("allowed", tools[0].name, {})], [new f.ToolCall("summary-forbidden", tools[0].name, {})]]);
  const result = await f.execution.run(plan(selection), p, f.signal);
  assert.equal(result.status, "unknown");
  assert.equal(p.executed.length, 1);
  assert.equal(p.executed[0].callId, "allowed");
});

test("genuine provider output counts retain attribution and enforce the total output budget before more tools", async t => {
  const f = await fixture(t), { selection } = await f.select(), p = ports();
  const reported = () => new f.Data(Buffer.from('{"prompt_tokens":12,"completion_tokens":900}'), "usage");
  f.script([
    [new f.ToolCall("first", tools[0].name, { round: 1 }), reported()],
    [new f.ToolCall("over-total", tools[0].name, { round: 2 }), reported()],
    [new f.Text("must not dispatch")],
  ]);
  const request = plan(selection, { hardToolRoundLimit: 3 });
  request.budget.maxTotalOutputTokens = 1000;
  assert.equal((await f.execution.run(request, p, f.signal)).status, "unknown");
  assert.equal(f.calls.length, 2);
  assert.equal(p.executed.length, 1);
  assert.deepEqual(p.usages.filter(item => item.source === "provider-reported").map(item => item.usage.outputTokens), [900, 900]);
  assert(p.usages.some(item => item.source === "native-counted" && item.usage.outputTokens !== 900));
});

test("full execution revocation cancels the real native tokenizer, and deadlines cancel pending native sends", async t => {
  await t.test("tokenizer", async t => {
    let token;
    const f = await fixture(t, { count: (_value, current) => { token = current; return new Promise(() => {}); } });
    const { selection } = await f.select();
    const running = f.execution.run(plan(selection), ports(), f.signal);
    await until(() => token);
    f.invalidate();
    assert.equal((await running).status, "cancelled");
    assert.equal(token.isCancellationRequested, true);
    assert.equal(f.calls.length, 0);
  });
  await t.test("deadline", async t => {
    const records = firstCancellationRecords(t);
    const f = await fixture(t, { send: () => new Promise(() => {}) }), { selection } = await f.select();
    const request = plan(selection);
    request.budget.deadlineMs = 20;
    assert.equal((await f.execution.run(request, ports(), f.signal)).status, "unknown");
    assert.equal(f.calls.length, 1);
    assert.equal(f.calls[0].token.isCancellationRequested, true);
    const cancellations = records.filter(record => record.origin === "deadline");
    assert.equal(cancellations.length, 1);
    assert.equal(cancellations[0].expectedShutdown, false);
    assert.equal(cancellations[0].stage, "execution-model-send");
  });
});

test("retained network failures dispatch only once even before output; unknown Core effects stop without follow-up", async t => {
  await t.test("dispatch rejection", async t => {
    const f = await fixture(t, { send: async () => { throw new Error("fetch failed ECONNRESET"); } });
    const { selection } = await f.select(), p = ports();
    const request = plan(selection);
    assert.equal((await f.execution.run(request, p, f.signal)).status, "unknown");
    assert.equal(f.calls.length, 1);
    assert.equal((await f.execution.run(request, p, f.signal)).status, "failed");
    assert.equal(f.calls.length, 1);
  });
  await t.test("first output failure", async t => {
    const f = await fixture(t), { selection } = await f.select(), p = ports();
    f.script([[new Error("socket hang up ECONNRESET")]]);
    assert.equal((await f.execution.run(plan(selection), p, f.signal)).status, "unknown");
    assert.equal(f.calls.length, 1);
  });
  await t.test("unknown tool receipt", async t => {
    const f = await fixture(t), { selection } = await f.select(), p = ports({
      async tool() { return { receiptSha256: "b".repeat(64), content: "uncertain", effect: "unknown" }; },
    });
    f.script([[new f.ToolCall("unknown-effect", tools[0].name, {})], [new f.Text("must not run")]]);
    assert.equal((await f.execution.run(plan(selection), p, f.signal)).status, "unknown");
    assert.equal(f.calls.length, 1);
  });
});

test("text sink backpressure bounds native pulling and is awaited before tool dispatch", async t => {
  const f = await fixture(t), { selection } = await f.select();
  let release, pending = 0, maximum = 0, toolCalled = false;
  const barrier = new Promise(resolve => { release = resolve; });
  const p = ports({
    async text() { maximum = Math.max(maximum, ++pending); await barrier; pending--; },
    async tool() { toolCalled = true; return { receiptSha256: "b".repeat(64), content: "ok", effect: "committed" }; },
  });
  f.script([[new f.Text("one"), new f.Text("two"), new f.ToolCall("after-text", tools[0].name, {})], [new f.Text("summary")]]);
  const running = f.execution.run(plan(selection), p, f.signal);
  await until(() => pending === 1);
  await new Promise(resolve => setTimeout(resolve, 10));
  assert.equal(maximum, 1); assert.equal(toolCalled, false);
  release();
  assert.equal((await running).status, "complete");
  assert.equal(maximum, 1); assert.equal(toolCalled, true);
});

test("native execution telemetry distinguishes rejecting text and usage sinks without changing uncertain dispatch", async t => {
  for (const sink of ["text", "usage"]) await t.test(sink, async t => {
    const records = firstCancellationRecords(t);
    const f = await fixture(t), { selection } = await f.select();
    f.script([[new f.Text("fixture-output")]]);
    const p = ports({ async [sink]() {
      throw Object.assign(new Error("fixture-private-sink-message"), { code: "NATIVE_CHAT_CORE_CALLBACK_FAILED" });
    } });
    assert.equal((await f.execution.run(plan(selection), p, f.signal)).status, "unknown");
    assert.equal(f.calls.length, 1);
    assert.equal(f.calls[0].token.isCancellationRequested, true);
    const cancellations = records.filter(record => record.origin === `${sink}-sink`);
    assert.equal(cancellations.length, 1);
    assert.equal(cancellations[0].expectedShutdown, false);
    assert.deepEqual(cancellations[0].causeCodes, ["NATIVE_CHAT_CORE_CALLBACK_FAILED"]);
    assert(!JSON.stringify(cancellations).includes("fixture-private-sink-message"));
  });
});

test("retained package is standalone and rejects altered installed bytes before loading", async t => {
  const externals = Object.values(retained.metafile.outputs).flatMap(output => output.imports)
    .filter(item => item.external).map(item => item.path);
  assert(externals.every(name => name === "vscode" || Module.isBuiltin(name)));
  assert(!Object.keys(retained.metafile.inputs).some(path => path.startsWith("src/")));
  const f = await fixture(t), manifestPath = join(f.directory, "next-runtime/manifest.json");
  const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  manifest.files["server/dist/native-vscode-chat-retained.cjs"] = "0".repeat(64);
  await writeFile(manifestPath, JSON.stringify(manifest));
  const exports = new Module(join(f.directory, "second-producer.cjs"));
  exports.filename = join(f.directory, "second-producer.cjs"); exports.paths = Module._nodeModulePaths(f.directory);
  exports._compile(producer.outputFiles[0].text, exports.filename);
  await assert.rejects(exports.exports.createOriginalMcpNativeChatProducer({
    extensionPath: f.directory, subscriptions: [],
  }, { appendLine() {} }), /RETAINED_PAYLOAD_UNVERIFIED/);
});
