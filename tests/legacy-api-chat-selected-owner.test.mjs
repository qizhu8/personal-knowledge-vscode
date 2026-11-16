import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { createServer } from "node:http";
import { createRequire } from "node:module";
import { DatabaseSync } from "node:sqlite";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { test } from "node:test";
import { initialize } from "../dist/storage.js";
import { startStandaloneHost } from "../dist/standalone-host.js";
import { bindManagedClientHost } from "../dist/managed-client-host.js";
import { createLegacyManagedChatLocalModel } from "../dist/legacy-api-chat-managed-provider.js";
import { startManagedClientSelectedOwnerChat } from "../dist/legacy-api-chat-selected-owner.js";
import { startManagedClientSnapshotChat } from "../dist/managed-client-snapshot-chat.js";
import { managedClientSelectedChatIpc } from "../dist/managed-client-selected-chat-ipc.js";

const require = createRequire(import.meta.url);
const legacyExtension = process.env.PKM_TEST_LEGACY_CHAT_EXTENSION ?? resolve(import.meta.dirname, "../legacy");
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
function selectedUiAdapter(options = {}) {
  const ts = require("typescript");
  let provider, listener;
  const messages = [];
  const vscode = { workspace: { isTrusted: true }, window: {
    registerWebviewViewProvider(_id, value) { provider = value; return { dispose() {} }; },
    async showSaveDialog() { return options.destination; },
  }, commands: { registerCommand() { return { dispose() {} }; }, executeCommand() {} } };
  const load = (file, imports) => {
    const source = readFileSync(resolve(legacyExtension, file), "utf8");
    const js = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
    const module = { exports: {} };
    new Function("require", "module", "exports", js)(imports, module, module.exports);
    return module.exports;
  };
  const native = load("src/chat/native-chat-ui-experiment.ts", name => {
    if (name === "vscode") return vscode;
    if (name === "./api-chat-shell") return { renderApiChat() {}, renderApiChatFailure(_view, error) { throw error; } };
    if (name === "../knowledge/filestore") return { getStorePath() { return options.originalRoot; } };
    if (name === "./api-chat-client") {
      const source = readFileSync(resolve(legacyExtension, "src/chat/api-chat-client.ts"), "utf8");
      const start = source.indexOf("export function decodeChatImage("), end = source.indexOf("export interface ApiChatMessage", start);
      const js = ts.transpileModule(`import { imageSize } from "image-size"; type ChatImage = any;\n${source.slice(start, end)}`,
        { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
      const module = { exports: {} };
      new Function("require", "module", "exports", js)(require, module, module.exports);
      return module.exports;
    }
    if (name === "./api-chat-store") return { chatHistoryPage: chat => ({ messages: chat.messages, start: 0, total: chat.messages.length }) };
    if (["./api-chat-client", "./native-todo-ui-experiment", "../runtime/native-harness-server",
      "./native-chat-harness-ui", "../ui/recipe-browser", "../ui/next-python-recipe"].includes(name)) return {};
    return require(name);
  });
  const ui = load("src/chat/selected-owner-chat-ui.ts", name => name === "vscode" ? vscode
    : name === "./native-chat-ui-experiment" ? native : require(name));
  return { register: ui.registerSelectedOwnerChatUi, messages, listener: () => listener,
    open() { provider.resolveWebviewView({ visible: true, onDidDispose() {}, webview: {
      onDidReceiveMessage(callback) { listener = callback; return { dispose() {} }; },
      async postMessage(value) { messages.push(value); return true; },
    } }); } };
}
async function until(read) {
  const end = Date.now() + 10000;
  for (;;) {
    const value = await read();
    if (value) return value;
    if (Date.now() >= end) throw new Error("Selected owner test timed out.");
    await delay(20);
  }
}

test("read-only or unselected managed clients cannot open a selected Chat owner", async () => {
  await assert.rejects(startManagedClientSelectedOwnerChat({ managed: {}, selection: {},
    connection: new AbortController().signal }), /unavailable/);
  let selected = false;
  await assert.rejects(startManagedClientSnapshotChat({ managed: { selectedOwnerContext() { selected = true; } },
    selection: { workspaceId: "workspace", actorId: "local:owner" }, connection: new AbortController().signal,
    profile: { id: "profile", workspaceId: "other", actorId: "local:owner", assertCurrent() {},
      async policy() {}, async remember() {} } }), /unavailable/);
  assert.equal(selected, false);
});

test("startup with unconfirmed cleanup keeps the selected child registered", async () => {
  const ts = require("typescript");
  const source = readFileSync(resolve("src/legacy-api-chat-selected-owner.ts"), "utf8");
  const js = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
  class OwnedChatStartupCleanupError extends Error {}
  const module = { exports: {} };
  new Function("require", "module", "exports", js)(name => name === "./legacy-api-chat-process-owned-host.js"
    ? { OwnedChatStartupCleanupError, startOwnedLegacyChatProcessUiHost: async () => { throw new OwnedChatStartupCleanupError("cleanup failed"); } }
    : require(name), module, module.exports);
  let close, unregistered = false;
  const selected = { storage: {}, actorId: "local:owner", assertCurrent() {},
    registerChildClose(callback) { close = callback; return () => { unregistered = true; }; } };
  await assert.rejects(module.exports.startSelectedOwnerChatProcessHost({ selected,
    connection: new AbortController().signal, assertProfile() {}, owner: {}, chat: {}, onCloseError() {} }),
  /startup and cleanup are unconfirmed/);
  assert.equal(unregistered, false);
  await assert.rejects(close(), /cleanup failed/);
  assert.equal(unregistered, false);
});

for (const shutdown of ["queue-ui-retry", "image-export", "invalid-process-handle", "long-message", "context-overflow", "pending-disconnect", "source-conflict", "disconnect", "owner-close", "renderer-disconnect", "live-heartbeat"]) test(`standalone selected owner ${shutdown === "queue-ui-retry" ? "accepts a user queue retry without duplicating dispatch" : shutdown === "image-export" ? "exports real original Chat image" : shutdown === "invalid-process-handle" ? "reports invalid process handle and continues" : shutdown === "long-message" ? "preserves bounded multibyte Task input" : shutdown === "context-overflow" ? "rejects oversized history without dropping it" : `drains Chat on ${shutdown}`}`, {
  timeout: 30000, skip: process.platform !== "linux",
}, async t => {
  const directory = resolve("tests", `.selected-chat-${randomUUID()}`);
  const workspace = join(directory, "workspace"), source = join(directory, "archive");
  const capture = join(directory, "capture"), script = join(directory, "program.mjs"), config = join(directory, "host.json");
  let host, managed, child, database, server, oldControl, oldHostFile, initialHeartbeat, originalChat, releaseModel;
  t.after(async () => {
    releaseModel?.();
    try {
      await child?.close();
      if (managed) await managed.close(); else await host?.close();
      database?.close();
      if (server) { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
    } finally { oldControl?.dispose(); rmSync(directory, { recursive: true, force: true }); }
  });
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  mkdirSync(source, { mode: 0o700 }); mkdirSync(capture, { mode: 0o700 });
  await initialize(workspace);
  const { ApiChatStore } = require(join(legacyExtension, "dist/chat/api-chat-store.js"));
  const archive = new ApiChatStore(join(source, ".pkm/state"), "0123456789abcdef");
  const mask = process.umask(0o077);
  let chat, other;
  try { chat = archive.create(); other = archive.create(); } finally { process.umask(mask); }
  const identity = { namespace: chat.workspaceNamespace, chatId: chat.id };
  const image = { label: "original.png", mimeType: "image/png",
    dataBase64: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/aN8AAAAASUVORK5CYII=" };
  if (shutdown === "image-export") {
    chat.messages.push({ id: "original-image", role: "user", status: "complete", content: "Original image", images: [image] });
    archive.save(chat);
  }
  if (["long-message", "context-overflow"].includes(shutdown)) {
    for (let index = 0; index < (shutdown === "long-message" ? 14 : 127); index++)
      chat.messages.push({ id: `retained-${index}`, role: index % 2 ? "assistant" : "user",
        status: "complete", content: index === 1 ? "A".repeat(70000) : `retained message ${index}` });
    archive.save(chat);
  }
  const otherIdentity = { namespace: other.workspaceNamespace, chatId: other.id };
  if (shutdown === "live-heartbeat") {
    const ipc = join(directory, "old-control-ipc");
    mkdirSync(ipc, { mode: 0o700 });
    const oldTmp = process.env.TMPDIR, previousMask = process.umask(0o077);
    try {
      process.env.TMPDIR = ipc;
      const { ApiChatAgentControl } = require(join(legacyExtension, "dist/chat/agent-control.js"));
      oldControl = new ApiChatAgentControl(join(source, ".pkm/state"), { workspacePaths: [source] }, async () => ({}));
    } finally {
      if (oldTmp === undefined) delete process.env.TMPDIR; else process.env.TMPDIR = oldTmp;
      process.umask(previousMask);
    }
    oldHostFile = join(source, ".pkm/state/api-chat-control/hosts", `${oldControl.hostId}.json`);
    initialHeartbeat = readFileSync(oldHostFile, "utf8");
    originalChat = readFileSync(join(source, ".pkm/state/api-chats", identity.namespace, `${identity.chatId}.json`));
  }
  writeFileSync(script, `import {appendFileSync} from "node:fs"; process.stdout.write("selected-owner-log");
setInterval(() => appendFileSync(${JSON.stringify(join(directory, "ticks"))}, "x"), 20);`);
  const key = randomUUID(), handle = `process_${createHash("sha256").update(key).digest("hex")}`;
  let modelCalls = 0, modelHeld = false;
  server = createServer(async (request, response) => {
    modelCalls++;
    const chunks = []; for await (const chunk of request) chunks.push(chunk);
    const body = JSON.parse(Buffer.concat(chunks).toString());
    if (shutdown === "queue-ui-retry" && modelCalls === 1) {
      modelHeld = true;
      await new Promise(resolve => { releaseModel = resolve; });
      releaseModel = undefined;
    }
    const completed = body.messages.some(message => message.role === "tool");
    if (shutdown === "invalid-process-handle" && completed)
      assert.deepEqual(JSON.parse(body.messages.find(message => message.role === "tool").content),
        { error: "Choose an exact process handle returned by run_process." });
    if (shutdown === "long-message") {
      assert(body.messages.some(message => message.content === "汉".repeat(12000)));
      assert(body.messages.some(message => message.content === "retained message 0"));
      assert(body.messages.some(message => message.content === "A".repeat(70000)));
    }
    const finished = completed || shutdown === "long-message" || shutdown === "queue-ui-retry";
    const delta = finished ? { content: "done" } : { tool_calls: [{ index: 0, id: "run", type: "function",
      function: shutdown === "invalid-process-handle" ? { name: "process_get", arguments: JSON.stringify({ handle: "invalid" }) }
        : { name: "run_process", arguments: JSON.stringify({ program: process.execPath, arguments: [script],
          cwd: workspace, timeoutSeconds: 60, background: true, idempotency_key: key }) } }] };
    response.writeHead(200, { "content-type": "text/event-stream" });
    response.end(`data: ${JSON.stringify({ choices: [{ index: 0, delta, finish_reason: null }] })}\n\n`
      + `data: ${JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: finished ? "stop" : "tool_calls" }] })}\n\ndata: [DONE]\n\n`);
  });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  const endpoint = `http://127.0.0.1:${server.address().port}/v1`;
  writeFileSync(config, JSON.stringify({ schema: "pkm.native-host-config/v1", provider: "openai-compatible", endpoint,
    secretRef: "secret:fixture/model", model: "fixture", contextWindow: 16384, maxOutputTokens: 4096,
    outputTokenParameter: "max_tokens", includeUsage: true, tools: ["knowledge.document.create"] }), { mode: 0o600 });
  host = await startStandaloneHost({ dataPath: workspace, configPath: config, policy: { authorizedConfigPath: config,
    allowedProviders: ["openai-compatible"], allowedEndpoints: [endpoint], allowedModels: ["fixture"],
    allowedTools: ["knowledge.document.create"], allowInsecureLoopback: true },
    resolveSecret: async () => "fixture", authenticateHuman: () => null });
  let selected = true, profile = true, holdPolicy;
  managed = bindManagedClientHost(host, host.workspaceId);
  const selection = { workspaceId: host.workspaceId, actorId: "local:owner",
    assertCurrent() { if (!selected) throw new Error("selection revoked"); } };
  const capability = managed.selectedOwnerContext(selection);
  const connection = new AbortController();
  const snapshotParent = join(directory, "snapshots");
  mkdirSync(snapshotParent, { mode: 0o700 });
  database = new DatabaseSync(join(directory, "process.sqlite"));
  const model = createLegacyManagedChatLocalModel({ endpoint, model: "fixture", apiKey: "fixture",
    tools: async () => [{ name: "run_process", description: "run", parameters: { type: "object", properties: {}, additionalProperties: true } }] });
  const errors = [];
  if (["queue-ui-retry", "invalid-process-handle", "long-message", "context-overflow"].includes(shutdown)) {
    const control = join(directory, "control");
    mkdirSync(control, { mode: 0o700 });
    const sent = [], session = randomUUID(), id = randomUUID();
    const ipc = managedClientSelectedChatIpc({
      owner: { capability: () => capability, signal: () => connection.signal },
      host: () => managed, workspace: () => workspace, source: () => source, unavailable: () => false,
      send: message => sent.push(message),
    });
    ipc.handle({ type: "selected-chat-start", id, session, chats: [identity], commands: [],
      model: { provider: "openai-compatible", endpoint, model: "fixture", apiKey: "fixture",
        contextWindow: shutdown === "long-message" ? 262144 : 65536,
        maxOutputTokens: 4096, outputTokenParameter: "max_tokens", includeUsage: true, status: "active" } });
    const answer = await until(() => sent.find(message => message.id === id));
    assert(answer.result, JSON.stringify(answer));
    child = { ...answer.result, snapshotRoot: answer.result.root, async close() { connection.abort(); await managed.close(); } };
  } else child = await startManagedClientSnapshotChat({ managed, selection, connection: connection.signal,
    sourceRoot: source, privateParent: snapshotParent,
    profile: { id: "fixture-profile", workspaceId: host.workspaceId, actorId: "local:owner",
      assertCurrent() { if (!profile) throw new Error("profile revoked"); },
      policy: async binding => {
        if (holdPolicy) await holdPolicy();
        return { available: binding.chatId === identity.chatId, trusted: true, permissionMode: "ask", localControls: true };
      },
      remember: async () => { throw new Error("This run requires one-shot approval."); } },
    commands: [{ id: "fixture", program: process.execPath, cwd: workspace, arguments: [[script]] }],
    onCloseError: error => errors.push(error),
    owner: { database, captureDirectory: capture },
    chat: { chats: ["renderer-disconnect", "image-export"].includes(shutdown) ? [identity] : [identity, otherIdentity],
      authorize: async binding => binding.actorId === "local:owner" && binding.chatId === identity.chatId,
      provider: async () => "unused", managed: { model,
        authorize: async binding => binding.actorId === "local:owner" && binding.chatId === identity.chatId,
        tools: { available: true, execute: async () => { throw new Error("Wrong tool port."); } } } } });
  const rpc = async input => {
    const response = await fetch(`${child.endpoint}/rpc`, { method: "POST",
      headers: { authorization: `Bearer ${child.bearer}`, "x-pkm-native-actor": "local:owner", "content-type": "application/json" },
      body: JSON.stringify(input) });
    return { status: response.status, ...await response.json() };
  };
  const ok = async input => { const result = await rpc(input); assert.equal(result.status, 200, result.error); return result.value; };
  const history = await ok({ method: "history", ...identity });
  if (shutdown === "image-export") {
    assert.deepEqual(history.messages[0].images, [image]);
    const originalFile = join(source, ".pkm/state/api-chats", identity.namespace, `${identity.chatId}.json`);
    const original = readFileSync(originalFile);
    const destination = join(directory, "export.png"), status = await ok({ method: "status" });
    const ui = selectedUiAdapter({ originalRoot: source, destination: { scheme: "file", fsPath: destination } });
    const registration = await ui.register({ subscriptions: [] }, { binding: { nonce: randomUUID(), root: child.snapshotRoot,
      workspaceId: host.workspaceId, actorId: "local:owner", sourceFingerprint: status.sourceFingerprint,
      endpoint: child.endpoint, bearer: child.bearer }, connection: connection.signal,
      assertCurrent() { capability.assertCurrent(); if (!profile) throw new Error("profile revoked"); } });
    ui.open();
    ui.listener()({ type: "select", id: identity.chatId });
    await until(() => {
      const error = ui.messages.find(message => message.type === "error" || message.type === "initializationError");
      if (error) throw new Error(`Selected UI failed: ${error.message}`);
      return ui.messages.find(message => message.type === "state");
    });
    ui.listener()({ type: "saveImage", id: "original-image", value: 0 });
    await until(() => {
      const error = ui.messages.find(message => message.type === "error");
      if (error) throw new Error(`Image export failed: ${error.message}`);
      return existsSync(destination) && readFileSync(destination).equals(Buffer.from(image.dataBase64, "base64"));
    });
    assert.deepEqual(readFileSync(destination), Buffer.from(image.dataBase64, "base64"));
    assert.deepEqual(readFileSync(originalFile), original);
    registration.dispose();
    return;
  }
  await ok({ method: "task-control", input: { ...identity, kind: "create", title: "Test", operationId: randomUUID(),
    expectedRevision: history.taskControl.revision } });
  const operationId = randomUUID();
  if (shutdown === "queue-ui-retry") {
    const status = await ok({ method: "status" });
    const ui = selectedUiAdapter();
    const registration = await ui.register({ subscriptions: [] }, { binding: { nonce: randomUUID(), root: child.snapshotRoot,
      workspaceId: host.workspaceId, actorId: "local:owner", sourceFingerprint: status.sourceFingerprint,
      endpoint: child.endpoint, bearer: child.bearer }, connection: connection.signal,
      assertCurrent() { capability.assertCurrent(); if (!profile) throw new Error("profile revoked"); } });
    ui.open();
    ui.listener()({ type: "select", id: identity.chatId });
    await until(() => ui.messages.find(message => message.type === "state"));
    await ok({ method: "continue", ...identity, operationId, expectedRevision: 0, text: "Hold this model request." });
    await until(() => modelHeld);
    ui.listener()({ type: "select", id: identity.chatId });
    const running = await until(() => ui.messages.findLast(message => message.type === "state"
      && message.nativeWorkflow?.activeAttemptId === operationId));
    const submissionId = randomUUID();
    const send = state => ui.listener()({ type: "send", chatId: identity.chatId, submissionId,
      text: "Only one queued task.", mode: "task", nativeTaskSessionId: state.nativeWorkflow.taskSessionId,
      nativeQueueRevision: state.nativeWorkflow.queueRevision });
    send(running);
    await until(() => ui.messages.filter(message => message.type === "sendAccepted" && message.submissionId === submissionId).length === 1);
    const queued = await until(() => ui.messages.findLast(message => message.type === "state"
      && message.nativeWorkflow?.queueRevision === 1));
    send(queued);
    await until(() => {
      const error = ui.messages.find(message => message.type === "error");
      if (error) throw new Error(`Selected UI queue failed: ${error.message}`);
      return ui.messages.filter(message => message.type === "sendAccepted" && message.submissionId === submissionId).length === 2;
    });
    const current = await ok({ method: "history", ...identity });
    assert.equal(current.queueControl.items.filter(item => item.id === submissionId).length, 1);
    assert.equal(modelCalls, 1);
    releaseModel();
    await until(async () => (await ok({ method: "history", ...identity })).nativeTurns
      ?.find(turn => turn.id === submissionId && turn.status === "completed"));
    assert.equal(modelCalls, 2);
    registration.dispose();
    return;
  }
  if (shutdown === "context-overflow") {
    const result = await rpc({ method: "continue", ...identity, operationId, expectedRevision: 0, text: "continue" });
    assert.notEqual(result.status, 200);
    assert.match(result.error, /bounded prompt; no retained messages were removed/);
    assert.equal(modelCalls, 0);
    const retained = await ok({ method: "history", ...identity });
    assert.equal(retained.messages.length, 127);
    assert.equal(retained.messages[0].content, "retained message 0");
    return;
  }
  if (shutdown === "long-message") {
    const tooLong = await rpc({ method: "continue", ...identity, operationId: randomUUID(), expectedRevision: 0, text: "x".repeat(16001) });
    assert.notEqual(tooLong.status, 200);
    const invalidImage = await rpc({ method: "continue", ...identity, operationId: randomUUID(), expectedRevision: 0,
      text: "image", images: [{ label: "bad.jpg", mimeType: "image/jpeg",
        dataBase64: Buffer.from([255, 216, 255, 0]).toString("base64") }] });
    assert.notEqual(invalidImage.status, 200);
    assert.match(invalidImage.error, /Invalid image data/);
    assert.equal(modelCalls, 0);
    await ok({ method: "continue", ...identity, operationId, expectedRevision: 0, text: "汉".repeat(12000) });
    const done = await until(async () => {
      const current = await ok({ method: "history", ...identity });
      const turn = current.nativeTurns?.find(turn => turn.id === operationId);
      if (turn && ["failed", "unknown", "cancelled"].includes(turn.status)) throw new Error(JSON.stringify(turn));
      return turn?.status === "completed" ? turn : undefined;
    });
    assert.equal(done.text, "汉".repeat(12000));
    assert.equal(modelCalls, 1);
    return;
  }
  if (shutdown === "invalid-process-handle") {
    await ok({ method: "continue", ...identity, operationId, expectedRevision: 0, text: "Read a process handle." });
    const done = await until(async () => {
      const current = await ok({ method: "history", ...identity });
      const turn = current.nativeTurns?.find(turn => turn.id === operationId);
      if (turn && ["failed", "unknown", "cancelled"].includes(turn.status)) throw new Error(JSON.stringify(current));
      return turn?.status === "completed" ? turn : undefined;
    });
    assert.equal(done.status, "completed");
    assert.equal(existsSync(join(directory, "ticks")), false);
    return;
  }
  let ui;
  if (shutdown === "renderer-disconnect") {
    const status = await ok({ method: "status" });
    ui = selectedUiAdapter();
    await ui.register({ subscriptions: [] }, { binding: { nonce: randomUUID(), root: child.snapshotRoot,
      workspaceId: host.workspaceId, actorId: "local:owner", sourceFingerprint: status.sourceFingerprint,
      endpoint: child.endpoint, bearer: child.bearer }, connection: connection.signal,
      assertCurrent() { capability.assertCurrent(); if (!profile) throw new Error("profile revoked"); } });
    ui.open();
    ui.listener()({ type: "select", id: identity.chatId });
    await until(() => {
      const error = ui.messages.find(message => message.type === "error" || message.type === "initializationError");
      if (error) throw new Error(`Selected UI failed: ${error.message}`);
      return ui.messages.find(message => message.type === "state");
    });
    ui.listener()({ type: "send", chatId: identity.chatId, submissionId: operationId, text: "Run the fixture." });
    await until(() => ui.messages.find(message => message.type === "sendAccepted" && message.submissionId === operationId));
  } else {
    await ok({ method: "continue", ...identity, operationId, expectedRevision: 0, text: "Run the fixture." });
  }
  const prompt = await until(async () => (await ok({ method: "process-approvals", ...identity }))[0]);
  if (oldControl) await until(() => readFileSync(oldHostFile, "utf8") !== initialHeartbeat);
  assert.equal(prompt.once, true);
  assert.equal(existsSync(join(directory, "ticks")), false);
  assert.equal((await rpc({ method: "process-approval-decide", ...otherIdentity, id: prompt.id, choice: "approve" })).status, 409);
  if (!ui) {
    let entered, release;
    const waiting = new Promise(resolve => { entered = resolve; });
    holdPolicy = () => { entered(); return new Promise(resolve => { release = resolve; }); };
    const staleDecision = rpc({ method: "process-approval-decide", ...identity, id: prompt.id, choice: "approve" });
    await waiting;
    profile = false; release();
    assert.equal((await staleDecision).status, 409);
    assert.equal(existsSync(join(directory, "ticks")), false);
    profile = true; holdPolicy = undefined;
  }
  if (shutdown === "source-conflict") {
    const { ChatLibrary } = require(join(legacyExtension, "dist/chat/chat-library.js"));
    new ChatLibrary(join(source, ".pkm", "state", "api-chats")).createGroup("Changed while approval is pending");
    assert.equal((await rpc({ method: "process-approval-decide", ...identity, id: prompt.id, choice: "approve" })).status, 409);
    connection.abort();
    await child.disconnectTask;
    assert.equal(existsSync(join(directory, "ticks")), false);
    assert.deepEqual(errors, []);
    await managed.close();
    child = undefined; managed = undefined; host = undefined;
    return;
  }
  if (shutdown === "pending-disconnect") {
    selected = false; connection.abort();
    await child.disconnectTask;
    assert.equal(existsSync(join(directory, "ticks")), false);
    assert.deepEqual(errors, []);
    assert.throws(() => capability.assertCurrent(), /selection revoked/);
    await managed.close();
    child = undefined; managed = undefined; host = undefined;
    return;
  }
  if (ui) {
    await until(() => ui.messages.find(message => message.type === "state" && message.approvals.some(item => item.id === prompt.id)));
    ui.listener()({ type: "approval", id: prompt.id, value: "approve" });
  } else await ok({ method: "process-approval-decide", ...identity, id: prompt.id, choice: "approve" });
  await child.managed.settled(identity, operationId);
  await until(() => existsSync(join(directory, "ticks")));
  const running = await ok({ method: "process-control", ...identity, handle, operation: "status" });
  assert.equal(running.state, "running");
  if (shutdown === "disconnect" || shutdown === "renderer-disconnect") {
    selected = false;
    connection.abort();
    await child.disconnectTask;
  } else {
    await managed.close();
  }
  assert.deepEqual(errors, []);
  const stopped = readFileSync(join(directory, "ticks")).length;
  await delay(120);
  assert.equal(readFileSync(join(directory, "ticks")).length, stopped);
  if (originalChat) assert.deepEqual(readFileSync(join(source, ".pkm/state/api-chats", identity.namespace, `${identity.chatId}.json`)), originalChat);
  assert.throws(() => capability.assertCurrent(), /selection revoked|connection|closed|unavailable|admission/);
  await managed.close();
  child = undefined; managed = undefined; host = undefined;
});
