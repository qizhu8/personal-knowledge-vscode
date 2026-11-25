import assert from "node:assert/strict";
import Module, { createRequire } from "node:module";
import { randomUUID } from "node:crypto";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { originalVscodeModelRequestDigest } from "../../dist/original-mcp-api-chat-contracts.js";

const require = createRequire(import.meta.url), { build } = require("esbuild");
const root = fileURLToPath(new URL("../../", import.meta.url));

// Native UI/producer doubles test consent ordering only, not installed-native or model qualification.
async function fixture(t) {
  const directory = join(root, ".pkm-test-evidence", `native-model-consent-${randomUUID()}`);
  await mkdir(join(directory, "next-runtime/server/dist"), { recursive: true, mode: 0o700 });
  t.after(() => rm(directory, { recursive: true, force: true }));
  const choices = [], calls = [], prompts = [];
  let factories = 0, current = true, registryRevision = 0;
  const epoch = randomUUID(), documents = [], editors = [], pickChoices = [], inputs = [], inputOptions = [], providers = new Map();
  const model = { id: "vscode:fixture:model", nativeModelId: "fixture-model", label: "Fixture model",
    vendor: "fixture", family: "fixture", version: "1", maxInputTokens: 200000, maxOutputTokens: null };
  const producer = {
    models: {
      async catalogue() { calls.push("catalogue"); return { source: "vscode.lm", epoch,
        registryRevision: String(registryRevision), models: [structuredClone(model)] }; },
      async select(value) { calls.push("select"); return value; },
      async count(value) { calls.push("count"); return value; },
      async *stream() { calls.push("stream"); yield { type: "text", text: "fixture" }; },
    },
    execution: { async run(plan, ports) {
      calls.push("execution");
      await ports.beforeInference({ inferenceId: "fixture", plan });
      return { status: "complete", toolRoundLimit: null };
    } },
  };
  await writeFile(join(directory, "next-runtime/server/dist/original-mcp-native-chat-rpc.js"),
    "exports.createOriginalMcpNativeChatProducerChannel = options => options;\n");
  await writeFile(join(directory, "package.json"), '{"type":"commonjs"}\n');
  const built = await build({
    entryPoints: [join(root, "clients/vscode-host/original-mcp-native-chat-session.ts")],
    bundle: true, platform: "node", format: "cjs", external: ["vscode"], write: false, logLevel: "silent",
    plugins: [{ name: "test-native-producer", setup(plugin) {
      plugin.onResolve({ filter: /\/?original-mcp-native-chat\.js$/ }, () => ({ path: "native-model-test-producer", external: true }));
    } }],
  });
  const load = Module._load;
  let api;
  try {
    Module._load = function (id, ...args) {
      if (id === "vscode") return {
        Uri: { from(value) { return { ...value, toString() { return `${value.scheme}:${value.path}`; } }; } },
        workspace: {
          registerTextDocumentContentProvider(scheme, provider) {
            providers.set(scheme, provider); return { dispose() { providers.delete(scheme); } };
          },
          async openTextDocument(uri) {
            const document = { uri, text: providers.get(uri.scheme).provideTextDocumentContent(uri) };
            documents.push(document); return document;
          },
        },
        window: {
          async showWarningMessage(title, options, ...buttons) { prompts.push({ title, options, buttons }); return choices.shift(); },
          async showQuickPick(items) { return pickChoices.shift()?.(items); },
          async showInputBox(options) { inputOptions.push(options); return inputs.shift(); },
          async showTextDocument(document) { editors.push(document); return {}; },
        },
      };
      if (id === "native-model-test-producer") return { createOriginalMcpNativeChatProducer: async () => { factories++; return producer; } };
      return load.call(this, id, ...args);
    };
    const compiled = new Module(join(directory, "session.cjs"));
    compiled.filename = join(directory, "session.cjs");
    compiled.paths = Module._nodeModulePaths(directory);
    compiled._compile(built.outputFiles[0].text, compiled.filename);
    api = compiled.exports;
  } finally { Module._load = load; }
  const controller = new AbortController();
  const options = {
    session: { epoch, activationId: epoch,
      binding: { root: "/isolated-fixture/library", workspaceId: randomUUID(), profileSha256: "a".repeat(64) } },
    signal: controller.signal, assertCurrent() { if (!current) throw new Error("NATIVE_REVOKED"); },
    async send() {}, async close() {},
  };
  return { choices, calls, prompts, options, controller, documents, editors, pickChoices, inputs, inputOptions, model, providers,
    invalidate() { registryRevision++; },
    factories: () => factories, revoke: () => { current = false; },
    enable: () => api.enableOriginalMcpNativeChatSession({ extensionPath: directory, subscriptions: [] }, options) };
}

test("native model channel is never created after decline or a late consent click on a revoked attachment", async t => {
  const f = await fixture(t);
  f.choices.push("Deny");
  await assert.rejects(f.enable(), error => error.code === "NATIVE_DENIED" && error.dispatch === "not-sent");
  assert.equal(f.factories(), 0);
  let answer;
  f.choices.push(new Promise(resolve => { answer = resolve; }));
  const enabling = f.enable();
  f.controller.abort(); answer("Allow this native model request");
  await assert.rejects(enabling, /CANCELLED/);
  assert.equal(f.factories(), 0);
});

test("native model selection and exact inference need separate approvals; cancellation never reaches the producer", async t => {
  const f = await fixture(t);
  f.choices.push("Allow this native model request");
  const channel = await f.enable(), signal = f.controller.signal;
  await channel.models.catalogue(signal);
  f.choices.push("Deny");
  await assert.rejects(channel.models.select({ modelId: "exact-model", catalogueSha256: "b".repeat(64) }, signal), /denied/);
  assert.deepEqual(f.calls, ["catalogue"]);
  const input = {
    selectionId: randomUUID(), requestId: randomUUID(), messages: [{ role: "user", content: "fixture request" }],
    tools: [], outputTokenCap: 20,
  };
  const request = { ...input, requestSha256: originalVscodeModelRequestDigest(input) };
  f.choices.push("Allow this native model request");
  const events = [];
  for await (const event of channel.models.stream(request, signal)) events.push(event);
  assert.deepEqual(events, [{ type: "text", text: "fixture" }]);
  assert.deepEqual(f.calls, ["catalogue", "stream"]);
  await assert.rejects(async () => {
    for await (const event of channel.models.stream({ ...request, requestSha256: "f".repeat(64) }, signal)) events.push(event);
  }, /DIGEST/);
  f.revoke();
  assert.throws(() => channel.models.count(request, signal), /REVOKED/);
});

test("native full execution consent shows explicit bounds and delegates durable admission without an alternate writer", async t => {
  const f = await fixture(t);
  f.choices.push("Allow this native model request");
  const channel = await f.enable();
  const plan = {
    schema: "pkm.original-api-chat-execution/v1", requestId: randomUUID(), chatUrl: "api-chat://fixture",
    selectionId: randomUUID(), sourcePlanSha256: "b".repeat(64),
    messages: [{ role: "user", content: "fixture" }], tools: [], hardToolRoundLimit: 31, outputTokenCap: 100,
    budget: { maxInputTokens: 2000, maxTotalOutputTokens: 4000, deadlineMs: 1000 },
  };
  let admitted = false;
  f.choices.push("Allow this native model request");
  await assert.rejects(channel.execution.run(plan, {
    async beforeInference() { admitted = true; throw new Error("CORE_DURABLE_ADMISSION_DENIED"); },
  }, f.controller.signal), /CORE_DURABLE_ADMISSION_DENIED/);
  assert.equal(admitted, true);
  const detail = JSON.parse(f.prompts.at(-1).options.detail);
  assert.equal(detail.hardToolRoundLimit, 31);
  assert.deepEqual(detail.budget, plan.budget);
  assert.equal(detail.sourcePlanSha256, plan.sourcePlanSha256);
});

const allow = "Allow this native model request", source = "b".repeat(64);
const locator = `pkm://chats/${"c".repeat(16)}/${randomUUID()}`;
function resolveRequest(requestId, changes = {}) {
  return { requestId, requestedModelId: "vscode:fixture:model", chatUrl: null,
    sourcePlanSha256: source, expectedSelection: null, ...changes };
}
function consent(input, selection, operation = "create", changes = {}) {
  return { operation, requestId: input.requestId, commandId: `command-${input.requestId}`,
    chatUrl: input.chatUrl, sourcePlanSha256: input.sourcePlanSha256, sourceUncertain: false,
    argumentsSha256: "d".repeat(64), selection, ...changes };
}

test("high-level create, exact native binding, send consent and cancellation have no model or legacy writer side effect", async t => {
  const f = await fixture(t);
  f.choices.push(allow);
  const channel = await f.enable(), signal = f.controller.signal, input = resolveRequest("1".repeat(64));
  f.choices.push(allow);
  const selection = await channel.apiChat.resolve(input, signal);
  assert.equal(selection.protocol, "pkm.original-api-chat-execution/v1");
  assert.equal(selection.wireModelId, f.model.nativeModelId);
  f.choices.push(allow);
  assert.equal(await channel.apiChat.authorize(consent(input, selection), signal), true);
  await channel.apiChat.present({ requestId: input.requestId, chatUrl: locator, sourcePlanSha256: source, selection }, signal);
  assert.equal(f.editors.length, 1);
  assert.match(f.documents[0].text, /Read-only binding snapshot/);
  assert.match(f.documents[0].text, new RegExp(locator));
  assert.match(f.documents[0].text, /fixture-model/);
  const next = resolveRequest("2".repeat(64), { chatUrl: locator, expectedSelection: selection });
  f.choices.push(allow, allow);
  const selected = await channel.apiChat.resolve(next, signal);
  assert.equal(await channel.apiChat.authorize(consent(next, selected, "send"), signal), true);
  assert(f.calls.every(value => value === "catalogue"));
  f.invalidate();
  const catalogueCalls = f.calls.length;
  f.choices.push(allow);
  assert.equal(await channel.apiChat.authorize(consent(resolveRequest("3".repeat(64), { chatUrl: locator }),
    null, "cancel"), signal), true);
  assert.equal(f.calls.length, catalogueCalls, "Stop must not depend on the selected model still existing");
  f.controller.abort();
  assert.equal(f.providers.size, 0);
});

test("high-level denied, replayed, mismatched source/model and stale click cannot authorize or present a Chat", async t => {
  const f = await fixture(t); f.choices.push(allow);
  const channel = await f.enable(), signal = f.controller.signal, input = resolveRequest("4".repeat(64));
  f.choices.push(allow);
  const selected = await channel.apiChat.resolve(input, signal);
  await assert.rejects(channel.apiChat.authorize(consent(input, { ...selected, wireModelId: "other" }), signal), /REQUEST_BINDING/);
  await assert.rejects(channel.apiChat.resolve(resolveRequest("5".repeat(64), { sourcePlanSha256: "f".repeat(64) }), signal), /SOURCE_CHANGED/);
  f.choices.push("Deny");
  await assert.rejects(channel.apiChat.authorize(consent(input, selected), signal), /denied/);
  await assert.rejects(channel.apiChat.authorize(consent(input, selected), signal), /REQUEST_BINDING/);
  await assert.rejects(channel.apiChat.present({ requestId: input.requestId, chatUrl: locator,
    sourcePlanSha256: source, selection: selected }, signal), /PRESENTATION_BINDING/);
  await assert.rejects(channel.apiChat.resolve(input, signal), /REQUEST_REPLAY/);
  const next = resolveRequest("6".repeat(64)); f.choices.push(allow);
  const selection = await channel.apiChat.resolve(next, signal);
  let answer;
  f.choices.push(new Promise(resolve => { answer = resolve; }));
  const authorizing = channel.apiChat.authorize(consent(next, selection), signal);
  while (!answer || !f.prompts.at(-1).title.startsWith("Create")) await new Promise(resolve => setImmediate(resolve));
  f.invalidate(); answer(allow);
  await assert.rejects(authorizing, /STALE_MODEL/);
  assert.equal(f.editors.length, 0);
  assert(f.calls.every(value => value === "catalogue"));
});

test("high-level missing models never use a default, and cancellation settles without a late UI response", async t => {
  const f = await fixture(t); f.choices.push(allow);
  const channel = await f.enable(), signal = f.controller.signal;
  await assert.rejects(channel.apiChat.resolve(resolveRequest("7".repeat(64), { requestedModelId: "missing" }), signal), /EXACT_MODEL_REQUIRED/);
  const input = resolveRequest("8".repeat(64), { requestedModelId: "" });
  f.pickChoices.push(items => items[0]); f.choices.push(allow);
  const selection = await channel.apiChat.resolve(input, signal);
  let answer;
  f.choices.push(new Promise(resolve => { answer = resolve; }));
  const pending = channel.apiChat.authorize(consent(input, selection), signal);
  while (!answer || !f.prompts.at(-1).title.startsWith("Create")) await new Promise(resolve => setImmediate(resolve));
  f.controller.abort();
  await assert.rejects(pending, /CANCELLED/);
  answer(allow);
  await assert.rejects(channel.apiChat.present({ requestId: input.requestId, chatUrl: locator,
    sourcePlanSha256: source, selection }, new AbortController().signal), /CANCELLED/);
  assert.equal(f.editors.length, 0);
});

async function memoryRequest(f, channel, id, scope = '{"account":"fixture","project":"fixture"}') {
  const request = resolveRequest(id, { chatUrl: locator });
  f.choices.push(allow);
  const selection = await channel.apiChat.resolve(request, f.controller.signal);
  return { requestId: id, chatUrl: locator, sourcePlanSha256: source, argumentsSha256: "d".repeat(64),
    selection, draftSha256: "e".repeat(64), scope, proposedQuery: "SQLite" };
}

test("native live Memory is explicit opt-in; default off and missing/denied source never masquerade as empty recall", async t => {
  const f = await fixture(t); f.choices.push(allow);
  const channel = await f.enable(), signal = f.controller.signal;
  const offRequest = await memoryRequest(f, channel, "9".repeat(64), null);
  f.pickChoices.push(items => items[0]);
  assert.equal((await channel.apiChat.memory.select(offRequest, signal)).mode, "off");
  assert.equal(f.inputOptions.length, 0);
  const missing = await memoryRequest(f, channel, "a".repeat(64), null);
  f.pickChoices.push(items => items[1]);
  assert.equal((await channel.apiChat.memory.select(missing, signal)).reason, "source-not-admitted");
  await assert.rejects(channel.apiChat.authorize(consent(resolveRequest(missing.requestId, { chatUrl: locator }),
    missing.selection, "send"), signal), /REQUEST_BINDING/);
  const denied = await memoryRequest(f, channel, "b".repeat(64));
  f.pickChoices.push(items => items[1]); f.inputs.push("SQLite"); f.choices.push("Deny");
  assert.deepEqual((await channel.apiChat.memory.select(denied, signal)).mode, "refused");
  assert(f.calls.every(call => call === "catalogue"));
});

test("native Memory binds exact query/scope/model/draft/request and refuses truncation, replay or a late cancelled choice", async t => {
  const f = await fixture(t); f.choices.push(allow);
  const channel = await f.enable(), signal = f.controller.signal;
  const request = await memoryRequest(f, channel, "c".repeat(64));
  f.pickChoices.push(items => items[1]); f.inputs.push("精确 SQLite"); f.choices.push(allow);
  const selected = await channel.apiChat.memory.select(request, signal);
  assert.equal(selected.mode, "live");
  assert.equal(selected.scope, request.scope); assert.equal(selected.query, "精确 SQLite");
  assert.equal(selected.limit, 3);
  assert.match(f.prompts.at(-1).options.detail, /Quoted Memory context only/);
  await assert.rejects(channel.apiChat.memory.select(request, signal), /MEMORY_BINDING/);
  const invalid = await memoryRequest(f, channel, "d".repeat(64));
  f.pickChoices.push(items => items[1]); f.inputs.push("字".repeat(172));
  assert.equal((await channel.apiChat.memory.select(invalid, signal)).reason, "invalid-query");
  const cancelled = await memoryRequest(f, channel, "e".repeat(64));
  let answer;
  f.pickChoices.push(items => items[1]); f.inputs.push(new Promise(resolve => { answer = resolve; }));
  const pending = channel.apiChat.memory.select(cancelled, signal);
  while (f.inputOptions.length < 3) await new Promise(resolve => setImmediate(resolve));
  f.controller.abort();
  await assert.rejects(pending, /CANCELLED/);
  answer("Late query");
  assert(f.calls.every(call => call === "catalogue"));
});
