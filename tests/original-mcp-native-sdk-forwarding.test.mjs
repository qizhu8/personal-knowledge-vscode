import assert from "node:assert/strict";
import Module, { createRequire } from "node:module";
import { resolve } from "node:path";
import test from "node:test";

// Public-API-shaped transport doubles qualify these leaf guards, never SDK/runtime/model admission.
const require = createRequire(import.meta.url);
const compiled = await require("esbuild").build({
  stdin: { contents: 'export * from "./clients/vscode-host/original-mcp-native-sdk-forwarding.ts"; export * from "./src/original-mcp-sdk-model-contracts.ts"; export * from "./clients/vscode-host/original-mcp-native-sdk-client-deps.ts"; export * from "./clients/vscode-host/original-mcp-native-sdk-chat.ts"; export * from "./src/original-mcp-sdk-todo-role-provenance.ts";',
    resolveDir: resolve(".") },
  bundle: true, platform: "node", format: "cjs", write: false, logLevel: "silent",
});
const module = new Module(resolve("tests/.sdk-forwarding-memory.cjs"));
module.filename = module.id; module.paths = Module._nodeModulePaths(resolve("."));
module._compile(compiled.outputFiles[0].text, module.filename);
const { createOriginalSdkForwardingHandler: create, measureOriginalSdkSerializedPayload: measure,
  invokeOriginalSdkCanonicalTool: tool, originalSdkDigest: digest,
  createOriginalSdkClientDeps: createDeps, createOriginalSdkChatPort: createPort } = module.exports;
const tick = () => new Promise(resolve => setImmediate(resolve));

function fixture(t, changes = {}) {
  const sent = [], approved = [], owner = new AbortController();
  let current = true;
  class Handler {
    async sendRequest(request) {
      assert.equal(request.redirect, "error", "Redirects must not send to an unapproved destination.");
      sent.push(["http", await request.text()]);
      if (changes.transportFailure) throw new Error("private provider error must not escape");
      return new Response("transport double");
    }
    async openWebSocket() {}
  }
  class Forwarder {
    sendRequestMessage(data) { sent.push(["websocket", data]); }
  }
  const sdk = { CopilotRequestHandler: Handler, CopilotWebSocketForwarder: Forwarder };
  const binding = {
    provider: "copilot-sdk", admissionMode: "awaited-sdk-sending-boundary",
    requestId: "exact-run", selectionId: "selection", modelId: "vscode:copilot-sdk:auto",
    sdkSessionId: "sdk-session", epoch: "current-epoch", hostReceiptSha256: "a".repeat(64),
    sourcePlanSha256: "b".repeat(64), planSha256: "c".repeat(64),
    deadlineAtMs: Date.now() + 60000, budget: { maxSendingBoundaries: 8, maxRequestBytes: 1024 },
    ...changes.binding,
  };
  const options = {
    binding, signal: owner.signal,
    runtimeClientOptions: {},
    runtimeAdmission: { assertCurrent() { if (changes.incompatible) throw new Error("not admitted"); } },
    assertCurrent() { if (!current) throw new Error("epoch changed"); },
    assertDestination(url) { assert.equal(new URL(url).hostname, "official-provider.test"); },
    async approve(value, signal) { approved.push(value); await changes.approve?.(value, signal); },
  };
  const bridge = create(sdk, options);
  t.after(() => bridge.dispose());
  const context = (transport = "http", id = "invocation-1") => ({
    requestId: `request-${id}`, agentInvocationId: id, sessionId: "sdk-session",
    transport, url: `${transport === "http" ? "https" : "wss"}://official-provider.test/model`,
    headers: { authorization: "never-serialized-test-value" }, signal: owner.signal,
  });
  const send = (ctx = context()) => bridge.handler.sendRequest(new Request(ctx.url,
    { method: "POST", body: '{"prompt":"synthetic only"}' }), ctx);
  return { sdk, options, bridge, sent, approved, owner, context, send, invalidate() { current = false; } };
}

test("missing required handler API or runtime admission refuses before any send", t => {
  const f = fixture(t);
  for (const sdk of [{}, { ...f.sdk, CopilotWebSocketForwarder: class {} }])
    assert.throws(() => create(sdk, f.options), /RUNTIME_INCOMPATIBLE/);
  assert.throws(() => create(f.sdk, { ...f.options, runtimeAdmission: { assertCurrent() { throw new Error("incompatible"); } } }), /RUNTIME_INCOMPATIBLE/);
  assert.deepEqual(f.sent, []);
});

test("HTTP and WebSocket sending wait for their exact approval, not just connection admission", async t => {
  for (const transport of ["http", "websocket"]) {
    let allow;
    const f = fixture(t, { approve: value => value.kind === "websocket-connect" ? undefined
      : new Promise(resolve => { allow = resolve; }) });
    const ctx = f.context(transport);
    const forwarder = transport === "websocket" ? await f.bridge.handler.openWebSocket(ctx) : null;
    const payload = new TextEncoder().encode("synthetic wire message");
    const pending = forwarder ? forwarder.sendRequestMessage(payload, ctx) : f.send(ctx);
    while (!allow) await tick();
    assert.deepEqual(f.sent, []);
    assert.equal(f.approved.at(-1).binding.modelId, "vscode:copilot-sdk:auto");
    assert(!JSON.stringify(f.approved).includes("never-serialized-test-value"));
    payload.fill(0);
    allow(); await pending;
    assert.equal(f.sent.length, 1);
    if (forwarder) assert.equal(new TextDecoder().decode(f.sent[0][1]), "synthetic wire message");
  }
});

test("observed runtime WSS continuation uses a distinct invocation on the same connection; duplicate identity is refused", async t => {
  // Actual SDK 1.0.34/runtime 1.0.112 conformance emitted one connect and
  // response.create message with the same request/session/agentInvocationId.
  const f = fixture(t), ctx = f.context("websocket");
  const forwarder = await f.bridge.handler.forwardWebSocket(ctx);
  await forwarder.sendRequestMessage("synthetic first logical send", ctx);
  assert.deepEqual(f.approved.map(boundary => boundary.kind), ["websocket-connect", "websocket-message"]);
  const continuation = { ...ctx, agentInvocationId: "runtime-supplied-distinct-continuation-reference" };
  await forwarder.sendRequestMessage("synthetic settled-prompt continuation", continuation);
  assert.equal(f.sent.length, 2);
  await assert.rejects(forwarder.sendRequestMessage("synthetic first logical send", ctx),
    error => error.code === "NATIVE_SDK_REPLAY_DENIED");
  assert.equal(f.sent.length, 2);
  const ambiguous = fixture(t), same = ambiguous.context("websocket");
  const second = await ambiguous.bridge.handler.forwardWebSocket(same);
  await second.sendRequestMessage("first serialized send", same);
  await assert.rejects(second.sendRequestMessage("a different message under the same logical invocation", same),
    error => error.code === "NATIVE_SDK_LOGICAL_SEND_IDENTITY_UNVERIFIED");
  assert.equal(ambiguous.sent.length, 1);
});

test("cancelled, expired and changed-epoch pending approval never forwards late data", async t => {
  for (const kind of ["cancel", "expire", "epoch"]) {
    let allow;
    const f = fixture(t, { binding: { deadlineAtMs: Date.now() + (kind === "expire" ? 50 : 60000) },
      approve: () => new Promise(resolve => { allow = resolve; }) });
    const pending = f.send();
    const rejected = assert.rejects(pending);
    while (!allow) await tick();
    if (kind === "cancel") f.owner.abort();
    else if (kind === "epoch") { f.invalidate(); allow(); }
    else await new Promise(resolve => setTimeout(resolve, 70));
    await rejected; allow();
    await tick();
    assert.deepEqual(f.sent, []);
    assert.equal(f.bridge.dispatchState(), "not-sent");
  }
});

test("SDK measurements are serialized bytes, never native token counts", () => {
  const value = measure("synthetic \u{1f680}");
  assert.equal(value.serializedBytes, Buffer.byteLength("synthetic \u{1f680}"));
  assert.equal(value.countingMethod, "sdk-serialized-utf8-bytes");
  assert.equal(value.providerTokenCount, null);
  assert.equal(Object.hasOwn(value, "inputTokens"), false);
  assert.throws(() => measure("\ud800"), /INVALID_UTF8/);
  assert.throws(() => measure(new Uint8Array([0xff])), /INVALID_UTF8/);
});

test("HTTP streamed bytes cannot change after their sending-boundary approval snapshot", async t => {
  let allow;
  const f = fixture(t, { approve: () => new Promise(resolve => { allow = resolve; }) });
  const payload = new TextEncoder().encode("exact synthetic HTTP bytes"), ctx = f.context();
  const request = new Request(ctx.url, { method: "POST", duplex: "half",
    body: new ReadableStream({ start(controller) { controller.enqueue(payload); controller.close(); } }) });
  const pending = f.bridge.handler.forwardHttp(request, ctx);
  while (!allow) await tick();
  payload.fill(0); allow(); await pending;
  assert.equal(f.sent[0][1], "exact synthetic HTTP bytes");
});

test("canonical tool authorization is independent and required before every effect", async () => {
  let effects = 0, authorizations = 0;
  const owner = new AbortController(), call = { callId: "actual-call", name: "claim_workitem",
    arguments: { board_slug: "Synthetic/Role", id: "synthetic-task" } };
  call.argumentsSha256 = digest(call.arguments);
  const ports = { assertCurrent() {}, async authorize() { authorizations++; throw new Error("role denied"); },
    async execute() { effects++; } };
  await assert.rejects(tool(call, ports, owner.signal), /role denied/);
  assert.equal(authorizations, 1); assert.equal(effects, 0);
  ports.authorize = async () => { authorizations++; owner.abort(); };
  await assert.rejects(tool(call, ports, owner.signal));
  assert.equal(effects, 0);
  ports.authorize = async input => { input.name = "unapproved replacement"; };
  await assert.rejects(tool(call, ports, new AbortController().signal), /TOOL_ARGUMENTS_DENIED/);
  assert.equal(effects, 0);
});

test("lost forwarding is uncertain, redacted and never replayed", async t => {
  const f = fixture(t, { transportFailure: true });
  await assert.rejects(f.send(), error => error.code === "NATIVE_SDK_FORWARDING_FAILED"
    && error.dispatch === "uncertain" && !error.message.includes("private provider"));
  assert.equal(f.bridge.dispatchState(), "uncertain");
  await assert.rejects(f.send());
  assert.equal(f.sent.length, 1);
});

test("the genuine public SDK handler accepts typed constructor injection and cancels before HTTP forwarding", async t => {
  const sdk = require("@github/copilot-sdk"), f = fixture(t);
  let allow;
  const bridge = create(sdk, { ...f.options, approve: () => new Promise(resolve => { allow = resolve; }) });
  t.after(() => bridge.dispose());
  assert(bridge.handler instanceof sdk.CopilotRequestHandler);
  // No start(), runtime connection, model, credential acquisition or upstream fetch.
  const client = new sdk.CopilotClient({
    connection: sdk.RuntimeConnection.forUri("http://127.0.0.1:1"),
    requestHandler: bridge.handler,
  });
  t.after(() => client.stop());
  const ctx = f.context(), pending = bridge.handler.forwardHttp(new Request(ctx.url,
    { method: "POST", body: "synthetic public-handler admission test" }), ctx);
  const rejected = assert.rejects(pending, error => error.code === "NATIVE_SDK_CANCELLED");
  while (!allow) await tick();
  f.owner.abort(); await rejected; allow(); await tick();
  assert.equal(bridge.dispatchState(), "not-sent");
});

function depsFixture(t, { enrollment = true } = {}) {
  const sdk = require("@github/copilot-sdk"), f = fixture(t), actions = [], sessions = [];
  const fakeSdk = { ...sdk, CopilotClient: class {
    constructor(options) { assert(options.requestHandler instanceof sdk.CopilotRequestHandler); actions.push("constructor"); }
    rpc = { llmInference: { setProvider: async () => ({ success: enrollment }) },
      models: { list: async () => { actions.push("catalogue"); return { models: [] }; } } };
    async start() { actions.push("start"); }
    async stop() { actions.push("stop"); }
    async createSession(config) {
      actions.push(`create:${config.sessionId}`);
      const session = { sessionId: config.sessionId, config, on() { return () => {}; },
        async send() { throw new Error("No fake model completion is permitted."); },
        async abort() { actions.push(`abort:${config.sessionId}`); },
        async disconnect() { actions.push(`disconnect:${config.sessionId}`); } };
      sessions.push(session); return session;
    }
    async deleteSession() {}
  } };
  const clientOptions = { mode: "empty", useLoggedInUser: false, baseDirectory: resolve("tests/synthetic-sdk-unused"),
    workingDirectory: resolve("tests/synthetic-sdk-unused"), connection: sdk.RuntimeConnection.forStdio({ path: resolve("tests/never-started-double") }) };
  const bridge = create(sdk, { ...f.options, runtimeClientOptions: clientOptions }); t.after(() => bridge.dispose());
  const admissions = [];
  const deps = createDeps({ sdk: fakeSdk, guard: bridge, binding: f.options.binding, sdkModelId: "auto",
    clientOptions,
    signal: f.owner.signal, allowSummarySession: true,
    accountToken: async interactive => { actions.push(`account:${interactive}`); return "synthetic-test-token"; },
    nextSessionGuard: binding => { const next = create(sdk, { ...f.options, binding, runtimeClientOptions: clientOptions }); t.after(() => next.dispose()); return next; },
    async beforeSession(binding, ordinal, previous) { admissions.push({ binding, ordinal, previous }); },
    observeEvent() {}, withToolInvocation: async (_invocation, work) => work(),
  });
  t.after(() => deps.dispose());
  return { ...f, deps, actions, admissions, sessions };
}

test("false actual-public enrollment result refuses before catalogue or session work", async t => {
  // Lifecycle double exercises result handling, not actual runtime qualification.
  const f = depsFixture(t, { enrollment: false });
  await f.deps.token(false);
  await assert.rejects(f.deps.client(), error => error.code === "NATIVE_SDK_RUNTIME_INCOMPATIBLE");
  assert(!f.actions.includes("catalogue"));
  assert(!f.actions.some(action => action.startsWith("create:")));
  assert(f.actions.includes("stop"));
});

test("retained summary configuration uses a fresh session after awaited retirement without constructing another client", async t => {
  const f = depsFixture(t);
  const token = await f.deps.token(false), { client } = await f.deps.client();
  const config = { model: "auto", gitHubToken: token, streaming: true, reasoningSummary: "concise",
    systemMessage: { mode: "replace", content: "synthetic only" }, tools: [], availableTools: [],
    enableConfigDiscovery: false, skipCustomInstructions: true, enableSkills: false,
    infiniteSessions: { enabled: false }, enableSessionStore: false,
    enableFileChangeTracking: false, enableHostGitOperations: false,
    onPermissionRequest: () => ({ kind: "approve-once" }) };
  const first = await client.createSession(config), second = await client.createSession(config);
  assert.notEqual(first.sessionId, second.sessionId);
  assert.equal(f.actions.filter(action => action === "constructor").length, 1);
  assert(f.actions.indexOf(`abort:${first.sessionId}`) < f.actions.indexOf(`create:${second.sessionId}`));
  assert(f.actions.indexOf(`disconnect:${first.sessionId}`) < f.actions.indexOf(`create:${second.sessionId}`));
  assert.equal(f.admissions[1].previous, first.sessionId);
  assert.equal(f.admissions[1].ordinal, 1);
  assert.equal((await f.sessions[1].config.onPermissionRequest(
    { kind: "read" }, { sessionId: second.sessionId })).kind, "reject");
  await assert.rejects(client.createSession(config), /SESSION_BINDING_DENIED/);
});

test("an unqualified Host runtime refuses before account access or client/model work", async () => {
  let accounts = 0;
  const sdk = require("@github/copilot-sdk");
  assert.throws(() => createPort({ sdk, epoch: "epoch", hostReceiptSha256: "a".repeat(64),
    sourcePlanSha256: "b".repeat(64), assertCurrent() {},
    runtimeAdmission: { assertCurrent() { throw new Error("no independent live runtime proof"); } },
    clientOptions: {}, async accountToken() { accounts++; return undefined; },
    retained: {}, host: {}, assertDestination() {}, async approveBoundary() {} }), /RUNTIME_INCOMPATIBLE/);
  assert.equal(accounts, 0);
});

test("SDK role provenance cannot masquerade as native inference/round evidence", () => {
  const { originalSdkTodoRoleCallback: schema, originalSdkTodoRoleEvidenceId: evidence } = module.exports;
  const callback = { provider: "copilot-sdk", requestId: "a".repeat(64), planSha256: "b".repeat(64),
    sdkSessionId: "actual-session-reference", sendingBoundaryId: "c".repeat(64), sendingInvocationId: "actual-sending-reference",
    callId: "actual-tool-call-reference", argumentsSha256: "d".repeat(64),
    toolReceiptId: "canonical-tool-execution-reference", operationId: "10000000-0000-4000-8000-000000000001" };
  const parsed = schema.parse(callback);
  assert.throws(() => schema.parse({ ...callback, inferenceId: "e".repeat(64), round: 0 }));
  assert.throws(() => schema.parse({ ...callback, provider: "vscode" }));
  assert.notEqual(evidence(parsed), evidence(schema.parse({ ...callback, toolReceiptId: "a-different-canonical-receipt" })));
});
