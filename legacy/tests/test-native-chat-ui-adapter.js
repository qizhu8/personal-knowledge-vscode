"use strict";
const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs"), path = require("node:path"), crypto = require("node:crypto");
const ts = require("typescript");

function fixture(t) {
  const directory = path.resolve(".migration-test-work", `native-chat-adapter-${crypto.randomUUID()}`);
  const root = path.join(directory, "knowledge"), profile = path.join(directory, "profile");
  fs.mkdirSync(root, { recursive: true, mode: 0o700 }); fs.mkdirSync(profile, { mode: 0o700 });
  const nonce = crypto.randomUUID(), stat = fs.statSync(root, { bigint: true });
  const grantFile = path.join(profile, "next-chat-ui-experiment.json");
  fs.writeFileSync(path.join(directory, "native-ui-fixture-token"), nonce, { mode: 0o600 });
  fs.writeFileSync(grantFile, JSON.stringify({
    schema: "pkm.private-native-chat-ui/v1", kind: "synthetic-only", nonce, fixture: directory, root,
    rootDevice: String(stat.dev), rootInode: String(stat.ino), workspaceId: crypto.randomUUID(),
    actorId: crypto.randomUUID(), sourceFingerprint: "a".repeat(64),
    endpoint: "http://127.0.0.1:12345", bearer: crypto.randomBytes(32).toString("base64url"),
  }), { mode: 0o600 });
  const original = process.env.PKM_PRIVATE_NATIVE_CHAT_UI_GRANT;
  t.after(() => {
    if (original === undefined) delete process.env.PKM_PRIVATE_NATIVE_CHAT_UI_GRANT;
    else process.env.PKM_PRIVATE_NATIVE_CHAT_UI_GRANT = original;
    fs.rmSync(directory, { recursive: true, force: true });
  });
  return { root, profile, grantFile };
}

function adapter(fetch, window = {}, options = {}) {
  let provider, poll;
  const vscode = {
    window: { registerWebviewViewProvider(_id, value) { provider = value; return { dispose() {} }; }, ...window },
    commands: { registerCommand() { return { dispose() {} }; }, executeCommand: options.executeCommand ?? (async () => {}) },
    workspace: { isTrusted: true, ...options.workspace },
  };
  const imports = name => {
    if (name === "vscode") return vscode;
    if (name === "./api-chat-shell") return { renderApiChat() {}, renderApiChatFailure(_view, error) { throw error; } };
    if (name === "./api-chat-client") return { decodeChatImage: options.decodeChatImage ?? (() => { throw new Error("Not an image test."); }) };
    if (name === "../knowledge/filestore") return { getStorePath: () => options.originalRoot };
    if (name === "./api-chat-store") return { chatHistoryPage: chat => ({ messages: chat.messages, start: 0, total: chat.messages.length }) };
    if (name === "./native-todo-ui-experiment") return { registerNativeTodoUiExperiment() { throw new Error("Todo is not admitted in this Chat-only fixture."); } };
    if (name === "../runtime/native-harness-server" && options.createNativeHarnessServer)
      return { createNativeHarnessServer: options.createNativeHarnessServer };
    if (name === "./native-chat-harness-ui" && options.nativeChatHarnessSnapshot)
      return { nativeChatHarnessSnapshot: options.nativeChatHarnessSnapshot };
    if (name === "../runtime/native-harness-server" || name === "./native-chat-harness-ui")
      return new Proxy({}, { get() { throw new Error("Harness is not requested by this adapter fixture."); } });
    if (name === "../ui/recipe-browser")
      return { recipeBrowserEditorDocument() { throw new Error("Library editor is not requested by this adapter fixture."); } };
    if (name === "../ui/next-python-recipe")
      return new Proxy({}, { get() { throw new Error("Python Recipe is not requested by this adapter fixture."); } });
    return require(name);
  };
  const source = fs.readFileSync(path.join(__dirname, "../src/chat/native-chat-ui-experiment.ts"), "utf8");
  const js = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
  const module = { exports: {} };
  new Function("require", "module", "exports", "setInterval", "clearInterval", "fetch", js)(
    imports, module, module.exports, callback => { poll = callback; return { unref() {} }; }, () => {}, fetch);
  return { activate: module.exports.activateNativeChatUiExperimental, Provider: module.exports.NativeChatUiProvider,
    provider: () => provider, poll: () => poll() };
}

test("owner Chat deep link survives a cold ordinary view attachment", async t => {
  const namespace = "c".repeat(16), ids = [crypto.randomUUID(), crypto.randomUUID()];
  const chats = ids.map((id, i) => ({ id, namespace, title: `Chat ${i}`, createdAt: 1, updatedAt: 1 }));
  const binding = { root: "/isolated-archive", nonce: crypto.randomUUID(), workspaceId: crypto.randomUUID(),
    actorId: "local:owner", sourceFingerprint: "a".repeat(64), endpoint: "http://127.0.0.1:12345",
    bearer: crypto.randomBytes(32).toString("base64url") };
  const ui = adapter(async (_url, request) => {
    const input = JSON.parse(request.body);
    if (input.method === "list") return { ok: true, json: async () => ({ value: chats }) };
    assert.equal(input.method, "history");
    return { ok: true, json: async () => ({ value: { metadata: {}, revision: 1, messages: [], pending: [] } }) };
  });
  const provider = new ui.Provider({ subscriptions: [] }, binding, () => binding, true), events = [];
  t.after(() => provider.dispose());
  provider.libraryEnabled = false;
  await provider.openPkmChat(`pkm://chats/${namespace}/${ids[1]}`);
  provider.attachWebviewView({ visible: true, onDidDispose() {}, webview: {
    onDidReceiveMessage() { return { dispose() {} }; },
    async postMessage(value) { events.push(value); return true; },
  } }, true);
  await provider.handle({ type: "ready" });
  assert.equal(provider.selected, ids[1]);
  assert(events.some(event => event.type === "state" && event.chat.id === ids[1]));
  await assert.rejects(provider.openPkmChat(crypto.randomUUID()), /existing Chat/);
});

test("native owner navigation keeps the previous Chat on failure and fences delayed selections", async t => {
  const namespace = "c".repeat(16), ids = [crypto.randomUUID(), crypto.randomUUID(), crypto.randomUUID()];
  const chats = ids.map((id, i) => ({ id, namespace, title: `Chat ${i}`, createdAt: 1, updatedAt: 1 }));
  const binding = { root: "/isolated-archive", nonce: crypto.randomUUID(), workspaceId: crypto.randomUUID(),
    actorId: "local:owner", sourceFingerprint: "a".repeat(64), endpoint: "http://127.0.0.1:12345",
    bearer: crypto.randomBytes(32).toString("base64url") };
  let release, started;
  const entered = new Promise(resolve => { started = resolve; });
  let fail = true;
  const ui = adapter(async (_url, request) => {
    const input = JSON.parse(request.body);
    if (input.method === "list") return { ok: true, json: async () => ({ value: chats }) };
    assert.equal(input.method, "history");
    if (input.chatId === ids[1] && fail) return { ok: false, json: async () => ({ error: "history unavailable" }) };
    if (input.chatId === ids[1]) { started(); await new Promise(resolve => { release = resolve; }); }
    return { ok: true, json: async () => ({ value: { metadata: {}, revision: 1, messages: [], pending: [] } }) };
  });
  const provider = new ui.Provider({ subscriptions: [] }, binding, () => binding, true), events = [];
  t.after(() => provider.dispose());
  provider.libraryEnabled = false;
  provider.selected = ids[0]; provider.selectedNamespace = namespace;
  provider.resolveWebviewView({ visible: true, onDidDispose() {}, webview: {
    onDidReceiveMessage() { return { dispose() {} }; },
    async postMessage(value) { events.push(value); return true; },
  } });
  const failed = { type: "select", id: ids[1], requestId: "failed" };
  await provider.handle(failed).catch(error => provider.failure(error, failed));
  assert.equal(provider.selected, ids[0]);
  assert.equal(provider.selectedNamespace, namespace);
  assert(events.some(event => event.type === "error" && event.requestId === "failed"));
  const missing = { type: "select", id: crypto.randomUUID(), requestId: "missing" };
  await provider.handle(missing).catch(error => provider.failure(error, missing));
  assert.equal(provider.selected, ids[0]);
  assert(events.some(event => event.type === "error" && event.requestId === "missing"));
  fail = false;
  const slow = provider.handle({ type: "select", id: ids[1], requestId: "slow" });
  await entered;
  await assert.rejects(provider.handle({ type: "send", text: "must not run" }), /selection|navigation/i);
  await provider.handle({ type: "select", id: ids[2], requestId: "latest" });
  release();
  await slow;
  assert.equal(provider.selected, ids[2]);
  assert.deepEqual(events.filter(event => event.type === "state").map(event => event.navigationRequestId), ["latest"]);
});

test("opening a Todo-associated Chat publishes an unsolicited state and rolls back a failed load", async t => {
  const namespace = "c".repeat(16), ids = [crypto.randomUUID(), crypto.randomUUID()];
  const chats = ids.map((id, i) => ({ id, namespace, title: `Chat ${i}`, createdAt: 1, updatedAt: 1 }));
  const binding = { root: "/isolated-archive", nonce: crypto.randomUUID(), workspaceId: crypto.randomUUID(),
    actorId: "local:owner", sourceFingerprint: "a".repeat(64), endpoint: "http://127.0.0.1:12345",
    bearer: crypto.randomBytes(32).toString("base64url") };
  let fail = false, focus = 0;
  const ui = adapter(async (_url, request) => {
    const input = JSON.parse(request.body);
    if (input.method === "list") return { ok: true, json: async () => ({ value: chats }) };
    assert.equal(input.method, "history");
    if (fail) return { ok: false, json: async () => ({ error: "history unavailable" }) };
    return { ok: true, json: async () => ({ value: { metadata: {}, revision: 1, messages: [], pending: [] } }) };
  }, {}, { executeCommand: async command => { assert.equal(command, "personalKnowledge.apiChat.focus"); focus++; } });
  const provider = new ui.Provider({ subscriptions: [] }, binding, () => binding, false), events = [];
  t.after(() => provider.dispose());
  provider.libraryEnabled = false;
  provider.selected = ids[0]; provider.selectedNamespace = namespace;
  provider.resolveWebviewView({ visible: true, onDidDispose() {}, webview: {
    onDidReceiveMessage() { return { dispose() {} }; },
    async postMessage(value) { events.push(value); return true; },
  } });
  await provider.openTodoChat(`pkm://chats/${namespace}/${ids[1]}`);
  assert.equal(focus, 1);
  assert.equal(provider.selected, ids[1]);
  assert.equal(events.at(-1).chat.id, ids[1]);
  assert.equal(events.at(-1).navigationRequestId, undefined);
  fail = true;
  await assert.rejects(provider.openTodoChat(`pkm://chats/${namespace}/${ids[0]}`), /history unavailable/);
  assert.equal(provider.selected, ids[1]);
  assert.equal(provider.navigation, undefined);
});

test("selected owner routes reset only for the currently selected Chat and live authority", async t => {
  const data = fixture(t), chatId = crypto.randomUUID();
  const binding = { root: data.root, nonce: crypto.randomUUID(), workspaceId: crypto.randomUUID(), actorId: "local:owner",
    sourceFingerprint: "a".repeat(64), endpoint: "http://127.0.0.1:12345", bearer: crypto.randomBytes(32).toString("base64url") };
  const ui = adapter(async () => { throw new Error("No RPC is expected."); });
  let live = true, resets = 0;
  const provider = new ui.Provider({ subscriptions: [] }, binding, () => {
    if (!live) throw new Error("owner revoked");
    return binding;
  }, true, async () => { resets++; });
  t.after(() => provider.dispose());
  provider.selected = chatId; provider.selectedNamespace = "c".repeat(16);
  await assert.rejects(provider.handle({ type: "resetPermissions", chatId: crypto.randomUUID() }), /selected Chat changed/);
  await provider.handle({ type: "resetPermissions", chatId });
  assert.equal(resets, 1);
  live = false;
  await assert.rejects(provider.handle({ type: "resetPermissions", chatId }), /revoked/);
  assert.equal(resets, 1);
});

test("selected process permissions do not claim the Chat is read-only", () => {
  const vm = require("node:vm");
  const source = fs.readFileSync(path.join(__dirname, "../src/webview/api-chat.js"), "utf8");
  const start = source.indexOf("const permissionModes ="), end = source.indexOf("const builtinCount =", start);
  assert(start >= 0 && end > start);
  const element = { dataset: {}, setAttribute(_name, value) { this.aria = value; } };
  const state = { settings: { nativePermissionReset: true }, chat: { permissionMode: "read-only" } };
  const context = vm.createContext({ state, element: () => element, t: value => value });
  vm.runInContext(source.slice(start, end), context);
  assert.match(element.aria, /Selected process approvals/);
  state.settings.nativePermissionReset = false;
  vm.runInNewContext(source.slice(start, end), { state, element: () => element, t: value => value });
  assert.match(element.aria, /Read only/);
});

test("selected owner saves an original historical image only after a live, unchanged Chat selection", async t => {
  const data = fixture(t), chatId = crypto.randomUUID(), namespace = "c".repeat(16);
  const snapshot = path.join(path.dirname(data.root), "snapshot");
  fs.mkdirSync(snapshot);
  const binding = { root: snapshot, nonce: crypto.randomUUID(), workspaceId: crypto.randomUUID(),
    actorId: "local:owner", sourceFingerprint: "a".repeat(64), endpoint: "http://127.0.0.1:12345",
    bearer: crypto.randomBytes(32).toString("base64url") };
  const source = fs.readFileSync(path.join(__dirname, "../src/chat/api-chat-client.ts"), "utf8");
  const start = source.indexOf("export function decodeChatImage("), end = source.indexOf("export interface ApiChatMessage", start);
  const decoder = ts.transpileModule(`import { imageSize } from "image-size"; type ChatImage = any;\n${source.slice(start, end)}`,
    { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
  const module = { exports: {} };
  new Function("require", "module", "exports", decoder)(require, module, module.exports);
  const image = { label: "original.png", mimeType: "image/png",
    dataBase64: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/aN8AAAAASUVORK5CYII=" };
  const destination = name => ({ scheme: "file", fsPath: path.join(path.dirname(data.root), name) });
  const remoteWrites = [];
  let overwrite = false;
  let onConfirm = () => {};
  let live = true, latest = image, choose = async () => destination("saved.png");
  const ui = adapter(async (_url, request) => {
    const input = JSON.parse(request.body);
    assert.equal(input.method, "history");
    assert.equal(input.chatId, chatId); assert.equal(input.namespace, namespace);
    return { ok: true, json: async () => ({ value: { messages: [{ id: "original-message", images: [latest] }] } }) };
  }, { showSaveDialog: async options => {
    assert.deepEqual(options.filters, { Image: ["png"] });
    return choose();
  }, showWarningMessage: async (message, options, choice) => {
    assert.match(message, /Replace/); assert.equal(options.modal, true);
    if (overwrite) onConfirm();
    return overwrite ? choice : undefined;
  } }, { decodeChatImage: module.exports.decodeChatImage, originalRoot: data.root, workspace: { fs: {
    async stat() { return { type: 1 }; },
    async writeFile(uri, bytes) { remoteWrites.push({ uri, bytes: Buffer.from(bytes) }); },
  } } });
  const provider = new ui.Provider({ subscriptions: [] }, binding, () => {
    if (!live) throw new Error("owner revoked");
    return binding;
  }, true);
  t.after(() => provider.dispose());
  provider.selected = chatId; provider.selectedNamespace = namespace;
  const request = { type: "saveImage", id: "original-message", value: 0 };
  await provider.handle(request);
  assert.deepEqual(fs.readFileSync(path.join(path.dirname(data.root), "saved.png")), Buffer.from(image.dataBase64, "base64"));
  assert.deepEqual(fs.readdirSync(data.root), []);
  choose = async () => undefined;
  await provider.handle(request);
  choose = async () => { live = false; return destination("revoked.png"); };
  await assert.rejects(provider.handle(request), /owner revoked/);
  assert.equal(fs.existsSync(destination("revoked.png").fsPath), false);
  live = true;
  choose = async () => { latest = { ...image, label: "changed.png" }; return destination("changed.png"); };
  await assert.rejects(provider.handle(request), /image changed/);
  assert.equal(fs.existsSync(destination("changed.png").fsPath), false);
  latest = image;
  choose = async () => { provider.selected = crypto.randomUUID(); return destination("other.png"); };
  await assert.rejects(provider.handle(request), /Chat changed/);
  assert.equal(fs.existsSync(destination("other.png").fsPath), false);
  provider.selected = chatId;
  choose = async () => ({ scheme: "file", fsPath: path.join(data.root, "history.png") });
  await assert.rejects(provider.handle(request), /outside the original/);
  const alias = path.join(path.dirname(data.root), "original-alias");
  fs.symlinkSync(data.root, alias);
  choose = async () => ({ scheme: "file", fsPath: path.join(alias, "history.png") });
  await assert.rejects(provider.handle(request), /outside the original/);
  choose = async () => ({ scheme: "file", fsPath: path.join(snapshot, "snapshot.png") });
  await assert.rejects(provider.handle(request), /outside the original/);
  choose = async () => ({ scheme: "remote", fsPath: "/remote/image.png" });
  await provider.handle(request);
  assert.equal(remoteWrites.length, 0);
  overwrite = true;
  await provider.handle(request);
  assert.equal(remoteWrites.length, 1);
  assert.equal(remoteWrites[0].uri.scheme, "remote");
  assert.deepEqual(remoteWrites[0].bytes, Buffer.from(image.dataBase64, "base64"));
  choose = async () => ({ scheme: "remote", fsPath: path.join(data.root, "history.png") });
  await assert.rejects(provider.handle(request), /outside the original/);
  assert.equal(remoteWrites.length, 1);
  fs.writeFileSync(destination("saved.png").fsPath, "old content that will be replaced");
  choose = async () => destination("saved.png");
  overwrite = false;
  await provider.handle(request);
  assert.equal(fs.readFileSync(destination("saved.png").fsPath, "utf8"), "old content that will be replaced");
  overwrite = true;
  onConfirm = () => fs.writeFileSync(destination("saved.png").fsPath, "changed while confirmation was open");
  await assert.rejects(provider.handle(request), /destination changed/);
  assert.equal(fs.readFileSync(destination("saved.png").fsPath, "utf8"), "changed while confirmation was open");
  onConfirm = () => {};
  await provider.handle(request);
  assert.deepEqual(fs.readFileSync(destination("saved.png").fsPath), Buffer.from(image.dataBase64, "base64"));
  const linked = destination("linked.png").fsPath;
  fs.linkSync(destination("saved.png").fsPath, linked);
  choose = async () => destination("linked.png");
  await assert.rejects(provider.handle(request), /single-link/);
  assert.deepEqual(fs.readFileSync(linked), Buffer.from(image.dataBase64, "base64"));
  fs.unlinkSync(linked);
  fs.symlinkSync(destination("saved.png").fsPath, destination("symlink.png").fsPath);
  choose = async () => destination("symlink.png");
  fs.writeFileSync(destination("saved.png").fsPath, "old symlink target");
  await provider.handle(request);
  assert.deepEqual(fs.readFileSync(destination("saved.png").fsPath), Buffer.from(image.dataBase64, "base64"));
  const protectedFile = path.join(data.root, "history.json");
  fs.writeFileSync(protectedFile, "protected");
  fs.symlinkSync(protectedFile, destination("protected-symlink.png").fsPath);
  choose = async () => destination("protected-symlink.png");
  await assert.rejects(provider.handle(request), /outside the original/);
  assert.equal(fs.readFileSync(protectedFile, "utf8"), "protected");
  fs.unlinkSync(protectedFile);
  assert.deepEqual(fs.readdirSync(data.root), []);
  assert.deepEqual(fs.readdirSync(snapshot), []);
});

test("selected owner renderer rechecks its live fence after each awaited response", async () => {
  let release, entered, live = true;
  const waiting = new Promise(resolve => { entered = resolve; });
  const ui = adapter(async () => { entered(); await new Promise(resolve => { release = resolve; });
    return { ok: true, json: async () => ({ value: { result: "not admissible after revocation" } }) }; });
  const binding = { root: "/isolated-archive", nonce: crypto.randomUUID(), workspaceId: crypto.randomUUID(),
    actorId: "local:owner", sourceFingerprint: "a".repeat(64), endpoint: "http://127.0.0.1:12345",
    bearer: crypto.randomBytes(32).toString("base64url") };
  const provider = new ui.Provider({ subscriptions: [] }, binding, () => {
    if (!live) throw new Error("owner revoked");
    return binding;
  }, true);
  const pending = provider.rpc({ method: "status" });
  await waiting; live = false; release();
  await assert.rejects(pending, /owner revoked/);
  provider.dispose();
});

test("historical Task inspection stays bound to its selected Chat and exact Session", async () => {
  const chatId = crypto.randomUUID(), namespace = "c".repeat(16);
  const sessionId = `agent_session_${"a".repeat(32)}`;
  let release, entered, panels = 0;
  const waiting = new Promise(resolve => { entered = resolve; });
  const binding = { root: "/isolated-archive", nonce: crypto.randomUUID(), workspaceId: crypto.randomUUID(),
    actorId: "local:owner", sourceFingerprint: "a".repeat(64), endpoint: "http://127.0.0.1:12345",
    bearer: crypto.randomBytes(32).toString("base64url") };
  const ui = adapter(async (_url, request) => {
    const input = JSON.parse(request.body);
    assert.deepEqual(input, { method: "harness", namespace, chatId, sessionId });
    entered(); await new Promise(resolve => { release = resolve; });
    return { ok: true, json: async () => ({ value: {} }) };
  }, { createWebviewPanel() { panels++; throw new Error("A stale selection must not open a panel."); } }, {
    nativeChatHarnessSnapshot() { return {}; },
    createNativeHarnessServer() { throw new Error("A stale selection must not start a server."); },
  });
  const provider = new ui.Provider({ subscriptions: [] }, binding, () => binding, true);
  provider.selected = chatId; provider.selectedNamespace = namespace;
  await assert.rejects(provider.handle({ type: "openTaskSession", chatId: crypto.randomUUID(), sessionId }), /selected Chat/);
  await assert.rejects(provider.handle({ type: "openTaskSession", chatId, sessionId: "invalid" }), /Task Session/);
  const opening = provider.handle({ type: "openTaskSession", chatId, sessionId });
  await waiting; provider.selected = crypto.randomUUID(); release();
  await assert.rejects(opening, /selected Chat changed/);
  assert.equal(panels, 0);
  provider.dispose();
});

test("native process controls require the selected Chat and human confirmation for Stop", async t => {
  const data = fixture(t); process.env.PKM_PRIVATE_NATIVE_CHAT_UI_GRANT = data.grantFile;
  const grant = JSON.parse(fs.readFileSync(data.grantFile)), chatId = crypto.randomUUID(), namespace = "c".repeat(16);
  const handle = `process_${"d".repeat(64)}`, calls = [], waiters = [];
  let listener, confirmed = false;
  const next = predicate => new Promise(resolve => waiters.push({ predicate, resolve }));
  const ui = adapter(async (_url, request) => {
    const input = JSON.parse(request.body), success = value => ({ ok: true, json: async () => ({ value }) });
    if (input.method === "status") return success({ ...grant, processes: true });
    if (input.method === "list") return success([{ id: chatId, chatId, namespace, title: "Synthetic Chat" }]);
    if (input.method === "history") return success({ revision: 0, metadata: {}, messages: [], pending: [] });
    assert.equal(input.method, "process-control"); calls.push(input);
    return success({ handle, spec: { program: "/synthetic" }, state: input.operation === "stop" ? "cancelled" : "running" });
  }, {
    async showWarningMessage(_message, options, choice) {
      assert.equal(options.modal, true);
      return confirmed ? choice : undefined;
    },
  });
  await ui.activate({ globalStorageUri: { fsPath: data.profile }, subscriptions: [] }, () => data.root);
  t.after(() => ui.provider().dispose());
  ui.provider().resolveWebviewView({ visible: true, onDidDispose() {}, webview: {
    onDidReceiveMessage(callback) { listener = callback; return { dispose() {} }; },
    async postMessage(value) { for (const waiter of waiters) if (waiter.predicate(value)) waiter.resolve(value); return true; },
  } });
  let posted = next(value => value.type === "state");
  listener({ type: "select", id: chatId }); await posted;
  posted = next(value => value.type === "error");
  listener({ type: "processControl", chatId: crypto.randomUUID(), handle, operation: "pause" }); await posted;
  assert.equal(calls.length, 0);
  posted = next(value => value.type === "processControlResult");
  listener({ type: "processControl", chatId, handle, operation: "stop" }); await posted;
  assert.deepEqual(calls.map(call => call.operation), ["status"]);
  confirmed = true;
  posted = next(value => value.type === "processControlResult" && value.operation === "stop");
  listener({ type: "processControl", chatId, handle, operation: "stop" }); await posted;
  assert.deepEqual(calls.map(call => call.operation), ["status", "status", "stop"]);
  assert(calls.every(call => call.chatId === chatId && call.namespace === namespace && call.handle === handle));
});

test("typing or budget refresh cannot reopen the composer before fresh Memory admission", () => {
  const vm = require("node:vm");
  const source = fs.readFileSync(path.join(__dirname, "../src/webview/api-chat.js"), "utf8");
  const body = source.slice(source.indexOf("  function tokenEstimate()"), source.indexOf("  const elapsed ="));
  const elements = new Map(), element = id => {
    if (!elements.has(id)) elements.set(id, { value: "", checkValidity: () => true, setAttribute() {} });
    return elements.get(id);
  };
  element("prompt").value = "A draft is not permission to recall or mutate Memory.";
  const state = { settings: { nativeExperiment: true, provider: "vscode" }, chat: { messages: [] },
    nativeMemory: { adopted: false } };
  const context = vm.createContext({ state, element, TextEncoder, navigation: false, pending: false,
    t: value => value, refreshComposerHelp() {} });
  vm.runInContext(`${body}; tokenEstimate();`, context);
  assert.equal(element("send").disabled, true);
  state.nativeMemory.adopted = true;
  vm.runInContext("tokenEstimate()", context);
  assert.equal(element("send").disabled, false);
  state.nativeMemory.adopted = false;
  vm.runInContext("tokenEstimate()", context);
  assert.equal(element("send").disabled, true);
  delete state.nativeMemory;
  vm.runInContext("tokenEstimate()", context);
  assert.equal(element("send").disabled, false);
});

test("native Recipe UI requires current source and exact human approval, never retries an unresolved create or stale cancel", async t => {
  const data = fixture(t); process.env.PKM_PRIVATE_NATIVE_CHAT_UI_GRANT = data.grantFile;
  const grant = JSON.parse(fs.readFileSync(data.grantFile)), chatId = crypto.randomUUID(), namespace = "c".repeat(16);
  const recipe = { recipeId: "recipe_original", name: "Original Recipe", revision: 3, executableDigest: "b".repeat(64),
    available: true, definition: { schema: "pkm.workflow.definition/v1", spec: { nodes: [] } } };
  const run = { runId: `recipe_native_${"d".repeat(32)}`, version: 2, state: "running" };
  const mutations = [], waiting = [];
  let listener, accepted = false, changeDuringCancel = false;
  const next = predicate => new Promise(resolve => waiting.push({ predicate, resolve }));
  const ui = adapter(async (_url, request) => {
    const input = JSON.parse(request.body), success = value => ({ ok: true, json: async () => ({ value: structuredClone(value) }) });
    if (input.method === "status") return success({ ...grant, recipes: true });
    if (input.method === "list") return success([{ id: chatId, namespace, revision: 0 }]);
    if (input.method === "history") return success({ revision: 0, metadata: {}, messages: [], pending: [] });
    if (input.method === "recipe-state") return success({ digest: "a".repeat(64), recipes: [recipe], originalRuns: [], runs: [run] });
    assert(["recipe-create", "recipe-cancel"].includes(input.method), "Recipe controls must never submit a model request.");
    mutations.push(input);
    if (input.method === "recipe-create") return { ok: false, json: async () => ({ error: "Unresolved create: inspect state, never retry." }) };
    assert.equal(input.input.expectedVersion, 2);
    return { ok: false, json: async () => ({ error: "Recipe version changed; no retry." }) };
  }, {
    async showInputBox(options) { assert.match(options.prompt, /never resumed/); return '{"mode":"complete"}'; },
    async showWarningMessage(message, options, choice) {
      assert.equal(options.modal, true); assert(options.detail.includes(grant.root));
      if (message.startsWith("Run")) {
        assert(options.detail.includes(recipe.executableDigest)); assert(options.detail.includes('"mode": "complete"'));
      } else {
        assert(options.detail.includes(run.runId)); assert.match(options.detail, /does not prove rollback/);
        if (changeDuringCancel) run.version++;
      }
      return accepted ? choice : undefined;
    },
  });
  await ui.activate({ globalStorageUri: { fsPath: data.profile }, subscriptions: [] }, () => data.root);
  t.after(() => ui.provider().dispose());
  ui.provider().resolveWebviewView({ visible: true, onDidDispose() {}, webview: {
    onDidReceiveMessage(callback) { listener = callback; return { dispose() {} }; },
    async postMessage(value) { for (const waiter of waiting) if (waiter.predicate(value)) waiter.resolve(value); return true; },
  } });
  let posted = next(value => value.type === "state"); listener({ type: "ready" }); await posted;
  posted = next(value => value.type === "error" && /source changed/.test(value.message));
  listener({ type: "nativeRecipeCreate", recipeId: recipe.recipeId, expectedDigest: "f".repeat(64) }); await posted;
  listener({ type: "nativeRecipeCreate", recipeId: recipe.recipeId, expectedDigest: "a".repeat(64) });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(mutations.length, 0, "Cancel in the fresh human modal cannot create a native intention.");
  accepted = true;
  posted = next(value => value.type === "error" && /Unresolved create/.test(value.message));
  listener({ type: "nativeRecipeCreate", recipeId: recipe.recipeId, expectedDigest: "a".repeat(64) }); await posted;
  assert.equal(mutations.length, 1);
  changeDuringCancel = true;
  posted = next(value => value.type === "error" && /version changed/.test(value.message));
  listener({ type: "nativeRecipeCancel", runId: run.runId, expectedVersion: 2, expectedDigest: "a".repeat(64) }); await posted;
  assert.equal(mutations.length, 2); assert.equal(mutations[1].input.expectedVersion, 2);
  assert.equal(run.version, 3); assert.notEqual(mutations[0].input.operationId, mutations[1].input.operationId);
  assert.deepEqual(fs.readdirSync(data.root), []);
});

test("Recipe renderer permits history inspection without replay and binds cancel to displayed version", () => {
  const vm = require("node:vm"), source = fs.readFileSync(path.join(__dirname, "../src/webview/api-chat.js"), "utf8");
  const start = source.indexOf("        if (state.nativeRecipes) {"), end = source.indexOf("        if (state.nativeMemory) {", start);
  const createElement = tag => ({ tag, dataset: {}, children: [], append(...children) { this.children.push(...children); } });
  const workflow = createElement("section"), posts = [], state = { nativeRecipes: {
    digest: "source-pin", recipes: [{ recipeId: "recipe_unsupported", name: "<untrusted>", available: false }],
    originalRuns: [{ runId: "recipe_run_old", name: "Old", state: "unknown", execution: "historical-only", sha256: "history-pin" }],
    runs: [{ runId: `recipe_native_${"a".repeat(32)}`, version: 7, state: "running",
      nodes: [{ nodeId: "record", state: "running", effect: "unknown", outputs: {} }] }],
  } };
  vm.runInNewContext(source.slice(start, end), { state, workflow, recipeDetailsOpen: true, document: { createElement },
    post: (type, input) => posts.push({ type, input }) });
  const detail = workflow.children[0], unsupported = detail.children.find(node => node.dataset.nativeRecipeId);
  assert.equal(detail.open, true);
  assert.equal(unsupported.disabled, true); assert.match(unsupported.textContent, /No qualified executor/);
  const original = detail.children.find(node => node.dataset.nativeRecipeRunId === "recipe_run_old");
  assert.match(original.textContent, /effect UNKNOWN.*never replayed.*historical evidence/);
  assert.equal(original.children.length, 1);
  assert.match(original.children[0].textContent, /history \(no resume\)/);
  original.children[0].onclick();
  assert.equal(posts[0].type, "nativeRecipeHistoryGet");
  assert.equal(posts[0].input.runId, "recipe_run_old");
  assert.equal(posts[0].input.expectedSha256, "history-pin");
  const current = detail.children.find(node => node.dataset.nativeRecipeRunId?.startsWith("recipe_native_"));
  current.children.find(node => node.tag === "button").onclick();
  assert.equal(posts[1].type, "nativeRecipeCancel"); assert.equal(posts[1].input.expectedVersion, 7);
  assert.equal(posts[1].input.expectedDigest, "source-pin");
});

test("native queue binds current Task/attempt and unknown review cancellation or stale digest never decides or retries", { timeout: 15000 }, async t => {
  const data = fixture(t); process.env.PKM_PRIVATE_NATIVE_CHAT_UI_GRANT = data.grantFile;
  const grant = JSON.parse(fs.readFileSync(data.grantFile)), chatId = crypto.randomUUID(), namespace = "f".repeat(16);
  const attempt = crypto.randomUUID(), sessionId = `agent_session_${"f".repeat(32)}`;
  let listener, revision = 7, active = true, warningAccepted = false, digest = "a".repeat(64);
  const items = [], mutations = [], waiting = [];
  const next = predicate => new Promise(resolve => waiting.push({ predicate, resolve }));
  const ui = adapter(async (_url, request) => {
    const input = JSON.parse(request.body), success = value => ({ ok: true, json: async () => ({ value }) });
    if (input.method === "status") return success({ ...grant, managed: true });
    if (input.method === "list") return success([{ id: chatId, namespace, revision, active }]);
    if (input.method === "history") return success({ revision: 1, metadata: { sessionId }, messages: [],
      taskControl: { revision: 0, activeSessionId: sessionId },
      nativeTurns: [{ id: attempt, status: active ? "model" : "unknown" }],
      nativeWorkers: [], queueControl: { revision, items }, userReviewAvailable: true,
      pending: [{ operationId: attempt, status: active ? "running" : "prepared" }] });
    if (input.method === "queue") {
      mutations.push(input);
      assert.equal(input.input.expectedRevision, 7);
      assert.equal(input.input.taskSessionId, sessionId);
      assert.equal(input.input.attemptId, attempt);
      assert.equal(input.input.mode, "steer");
      items.push({ id: input.input.submissionId, text: input.input.text, mode: "steer", status: "queued" }); revision++;
      return success({ revision, items });
    }
    if (input.method === "outcome-review") return success({ available: true, active: false, digest,
      turns: [{ id: attempt, status: "unknown", pendingTool: { call: { name: "read_file", arguments: { path: "synthetic-only" } } } }] });
    assert.equal(input.method, "outcome-decide", "Queue/review must never route through continue or legacy execution.");
    mutations.push(input);
    assert.equal(input.input.decision, "abandon-without-replay");
    assert.notEqual(input.input.expectedDigest, digest);
    return { ok: false, json: async () => ({ error: "Unknown outcomes changed; reopen review." }) };
  }, {
    async showWarningMessage(message, options) {
      assert.match(message, /Abandon/); assert.equal(options.modal, true);
      assert.match(options.detail, /stays UNKNOWN/);
      return warningAccepted ? "Keep unknown; never replay" : undefined;
    },
    async showInputBox(options) { assert.equal(options.title, "Unknown outcome review"); digest = "b".repeat(64); return "Explicitly abandon, not claim success."; },
  });
  await ui.activate({ globalStorageUri: { fsPath: data.profile }, subscriptions: [] }, () => data.root);
  t.after(() => ui.provider().dispose());
  ui.provider().resolveWebviewView({ visible: true, onDidDispose() {}, webview: {
    onDidReceiveMessage(callback) { listener = callback; return { dispose() {} }; },
    async postMessage(value) { for (const waiter of waiting) if (waiter.predicate(value)) waiter.resolve(value); return true; },
  } });
  let posted = next(value => value.type === "state"); listener({ type: "ready" }); await posted;
  posted = next(value => value.type === "error" && /nothing was retargeted/.test(value.message));
  listener({ type: "send", text: "Stale displayed steering", submissionId: crypto.randomUUID(), mode: "steer",
    nativeTaskSessionId: sessionId, nativeQueueRevision: revision, nativeAttemptId: crypto.randomUUID() }); await posted;
  assert.equal(mutations.length, 0);
  posted = next(value => value.type === "state" && value.chat.queuedInputs.length === 1);
  listener({ type: "send", text: "Fresh same-attempt steering", submissionId: crypto.randomUUID(), mode: "steer",
    nativeTaskSessionId: sessionId, nativeQueueRevision: revision, nativeAttemptId: attempt }); await posted;
  assert.equal(mutations.length, 1);
  active = false; revision++;
  posted = next(value => value.type === "state" && value.nativeWorkflow.unknown); ui.poll(); await posted;
  posted = next(value => value.type === "state"); listener({ type: "reviewUnknown" }); await posted;
  assert.equal(mutations.length, 1, "Dismissing the real warning must never submit a decision.");
  warningAccepted = true;
  posted = next(value => value.type === "error" && /outcomes changed/.test(value.message));
  listener({ type: "reviewUnknown" }); await posted;
  assert.equal(mutations.length, 2, "A stale review is never automatically retried.");
  assert.deepEqual(fs.readdirSync(data.root), []);
});

test("native Task UI preserves the original Session, publishes actual child evidence and never resends an unknown effect", async t => {
  const data = fixture(t);
  process.env.PKM_PRIVATE_NATIVE_CHAT_UI_GRANT = data.grantFile;
  const grant = JSON.parse(fs.readFileSync(data.grantFile)), chatId = crypto.randomUUID(), workerId = crypto.randomUUID();
  const sessionId = `agent_session_${"c".repeat(32)}`, namespace = "b".repeat(16);
  const requests = [], states = [];
  let listener, received;
  const posted = new Promise(resolve => { received = resolve; });
  const ui = adapter(async (_url, request) => {
    const input = JSON.parse(request.body); requests.push(input);
    let value;
    if (input.method === "status") value = { ...grant, managed: true };
    else if (input.method === "list") value = [{ id: chatId, namespace, title: "Original managed Task", revision: 1 }];
    else if (input.method === "history") value = { revision: 1, metadata: { sessionId, permissionMode: "allow-all",
      workerState: { treeId: "inert-source-tree", sleeping: true, stopped: false, events: [] },
      queuedInputs: [{ id: "inert-original-command", text: "Never execute this old queue." }] },
    messages: [{ id: "actual-native-response", role: "assistant", content: "", status: "interrupted" }],
    nativeTurns: [{ id: workerId, status: "unknown" }],
    taskControl: { revision: 0, activeSessionId: sessionId },
    nativeWorkers: [{ id: workerId, title: "Actual native child", status: "completed", uncertain: false }],
    pending: [{ operationId: workerId, status: "prepared" }] };
    else throw new Error(`Unknown effects must never cause this request: ${input.method}`);
    return { ok: true, json: async () => ({ value }) };
  });
  const context = { globalStorageUri: { fsPath: data.profile }, subscriptions: [] };
  await ui.activate(context, () => data.root);
  t.after(() => ui.provider().dispose());
  ui.provider().resolveWebviewView({ visible: true, webview: {
    onDidReceiveMessage(callback) { listener = callback; return { dispose() {} }; },
    async postMessage(message) { if (message.type === "state") { states.push(message); received(message); } return true; },
  }, onDidDispose() {} });
  listener({ type: "ready" });
  const state = await posted;
  assert.equal(state.chat.sessionId, sessionId);
  assert.equal(state.chat.permissionMode, "read-only");
  assert.deepEqual(state.chat.queuedInputs, []);
  assert.equal(state.chat.workerState, undefined, "An archived tree must not disable live native Task controls.");
  assert.equal(state.settings.needsModelConnection, true);
  assert.equal(state.settings.nativeImageTransport, false);
  assert.equal(state.workerOverview.nodes.find(node => node.chatId === workerId).canResume, false);
  assert.equal(requests.filter(input => input.method === "continue").length, 0);
});

test("normal activation stays inert, but an existing private experiment cannot fall back to legacy activation", async t => {
  const data = fixture(t), ui = adapter(() => { throw new Error("No RPC is permitted."); });
  delete process.env.PKM_PRIVATE_NATIVE_CHAT_UI_GRANT;
  const context = { globalStorageUri: { fsPath: data.profile }, subscriptions: [] };
  const root = () => { throw new Error("No root lookup is permitted."); };
  await assert.rejects(ui.activate(context, root), /legacy initialization is blocked/);
  fs.unlinkSync(data.grantFile);
  assert.equal(await ui.activate(context, root), false);
  assert.equal(ui.provider(), undefined);
  fs.symlinkSync(path.join(data.profile, "missing-grant"), data.grantFile);
  await assert.rejects(ui.activate(context, root), /legacy initialization is blocked/);
});

test("native ordinary Chat permits cancelling a pending send without leaving the UI busy", async t => {
  const data = fixture(t), grant = JSON.parse(fs.readFileSync(data.grantFile));
  const chatId = crypto.randomUUID(), namespace = "f".repeat(16);
  let release, entered;
  const pending = new Promise(resolve => { release = resolve; });
  const started = new Promise(resolve => { entered = resolve; });
  const calls = [];
  const ui = adapter(async (_url, request) => {
    const input = JSON.parse(request.body); calls.push(input);
    if (input.method === "continue") {
      entered(); await pending;
      return { ok: false, json: async () => ({ error: "Task selection or control changed before dispatch." }) };
    }
    if (input.method === "history") return { ok: true, json: async () => ({ value: {
      taskControl: { revision: 3, activeSessionId: null }, messages: [], pending: [] } }) };
    assert.equal(input.method, "task-control");
    assert.equal(input.input.kind, "cancel"); assert.equal(input.input.expectedRevision, 3);
    return { ok: true, json: async () => ({ value: { revision: 4, activeSessionId: null } }) };
  });
  const provider = new ui.Provider({ subscriptions: [] }, grant, () => grant);
  t.after(() => provider.dispose());
  provider.selected = chatId; provider.selectedNamespace = namespace;
  const send = provider.handle({ type: "send", text: "Ordinary message", submissionId: crypto.randomUUID() });
  await started;
  await provider.handle({ type: "cancel" });
  release();
  await assert.rejects(send, /control changed/);
  assert.equal(provider.busy, false);
  assert.equal(calls.filter(input => input.method === "continue").length, 1);
  assert.equal(calls.filter(input => input.method === "task-control").length, 1);
});

test("native Task dialogs retain CAS and pause/cancel/resume never submit a model request", async t => {
  const data = fixture(t);
  process.env.PKM_PRIVATE_NATIVE_CHAT_UI_GRANT = data.grantFile;
  const grant = JSON.parse(fs.readFileSync(data.grantFile)), chatId = crypto.randomUUID(), namespace = "a".repeat(16);
  let revision = 0, sessionId, paused = false, listener, dialogs = 0;
  const mutations = [], waiting = [], events = [];
  const next = predicate => new Promise(resolve => waiting.push({ predicate, resolve }));
  const ui = adapter(async (_url, request) => {
    const input = JSON.parse(request.body);
    const success = value => ({ ok: true, json: async () => ({ value }) });
    if (input.method === "status") return success({ ...grant, managed: true });
    if (input.method === "list") return success([{ id: chatId, namespace, title: "Original Chat", taskRevision: revision }]);
    if (input.method === "history") return success({ revision: 0, metadata: { sessionId, paused }, messages: [], pending: [],
      taskControl: { revision, activeSessionId: sessionId }, ...(sessionId ? { nativeTurns: [] } : {}) });
    assert.equal(input.method, "task-control", "Task controls must not be sent through continue or legacy writers.");
    mutations.push(input.input);
    if (input.input.expectedRevision !== revision)
      return { ok: false, json: async () => ({ error: "Task control changed; reopen before controlling this Task." }) };
    if (input.input.kind === "create") sessionId = `agent_session_${"e".repeat(32)}`;
    if (input.input.kind === "complete") sessionId = undefined;
    paused = ["pause", "cancel"].includes(input.input.kind); revision++;
    return success({ revision, activeSessionId: sessionId, paused });
  }, {
    async showInputBox(options) { assert.equal(options.title, "Start Task"); if (++dialogs === 1) revision++; return "Actual bounded Task title"; },
    async showWarningMessage(_message, options, choice) { assert.equal(options.modal, true); return choice; },
  });
  await ui.activate({ globalStorageUri: { fsPath: data.profile }, subscriptions: [] }, () => data.root);
  t.after(() => ui.provider().dispose());
  ui.provider().resolveWebviewView({ visible: true, onDidDispose() {}, webview: {
    onDidReceiveMessage(callback) { listener = callback; return { dispose() {} }; },
    async postMessage(value) {
      events.push(value);
      for (const waiter of waiting) if (waiter.predicate(value)) waiter.resolve(value);
      return true;
    },
  } });
  let posted = next(value => value.type === "state"); listener({ type: "ready" }); await posted;
  posted = next(value => value.type === "error" && /control changed/.test(value.message));
  listener({ type: "startTask" }); await posted;
  assert.equal(mutations.length, 1); assert.equal(mutations[0].expectedRevision, 0);
  posted = next(value => value.type === "state" && !!value.chat.sessionId);
  listener({ type: "startTask" }); await posted;
  assert.equal(mutations.length, 2); assert.equal(mutations[1].expectedRevision, 1);
  assert.notEqual(mutations[0].operationId, mutations[1].operationId);
  for (const type of ["pause", "resume", "cancel", "resume"]) {
    const previous = events.length;
    posted = next(value => value.type === "state" && events.indexOf(value) >= previous);
    listener({ type }); await posted;
    assert.equal(mutations.at(-1).kind, type);
  }
  posted = next(value => value.type === "state" && !value.chat.sessionId);
  listener({ type: "completeTask" }); await posted;
  assert.equal(mutations.at(-1).kind, "complete");
  assert.deepEqual(fs.readdirSync(data.root), []);
});

test("native Library UI projects original groups and never retries a dialog-time CAS conflict", async t => {
  const data = fixture(t);
  process.env.PKM_PRIVATE_NATIVE_CHAT_UI_GRANT = data.grantFile;
  const { root, workspaceId, actorId, sourceFingerprint } = JSON.parse(fs.readFileSync(data.grantFile));
  const chatId = crypto.randomUUID(), namespace = "b".repeat(16);
  const originalGroup = `chat_group_${"a".repeat(32)}`;
  let revision = 7, dialogCalls = 0, listener;
  const groups = [{ id: originalGroup, name: "Original preserved group" }], mutations = [], events = [], waiting = [];
  const next = predicate => {
    const found = events.find(predicate);
    return found ? Promise.resolve(found) : new Promise(resolve => waiting.push({ predicate, resolve }));
  };
  const ui = adapter(async (_url, request) => {
    const input = JSON.parse(request.body);
    const success = value => ({ ok: true, json: async () => ({ value }) });
    if (input.method === "status") return success({ root, workspaceId, actorId, sourceFingerprint, library: true });
    if (input.method === "library") return success({ revision, state: { groups: structuredClone(groups), placements: {} } });
    if (input.method === "list") return success([{ id: chatId, chatId, namespace,
      groupId: originalGroup, title: "Original task Chat" }]);
    if (input.method === "history") return success({ revision: 0, metadata: {}, pending: [], messages: [] });
    assert.equal(input.method, "library-mutate");
    mutations.push(input.input);
    assert.equal(request.headers["x-pkm-native-actor"], actorId);
    if (input.input.expectedRevision !== revision)
      return { ok: false, json: async () => ({ error: "Chat Library changed; reopen before editing." }) };
    groups.push({ id: `chat_group_${"b".repeat(32)}`, name: input.input.name }); revision++;
    return success({ revision, state: { groups: structuredClone(groups), placements: {} } });
  }, {
    async showInputBox(options) {
      assert.equal(options.title, "New Chat group");
      if (++dialogCalls === 1) revision++;
      return "Explicit native group";
    },
  });
  const context = { globalStorageUri: { fsPath: data.profile }, subscriptions: [] };
  await ui.activate(context, () => data.root);
  t.after(() => ui.provider().dispose());
  ui.provider().resolveWebviewView({
    visible: true, onDidDispose() {},
    webview: {
      onDidReceiveMessage(callback) { listener = callback; return { dispose() {} }; },
      async postMessage(value) {
        events.push(value);
        for (const waiter of waiting) if (waiter.predicate(value)) waiter.resolve(value);
        return true;
      },
    },
  });
  listener({ type: "ready" });
  const first = await next(event => event.type === "state");
  assert.deepEqual(first.library.groups, [{ id: originalGroup, name: "Original preserved group" }]);
  listener({ type: "groupCreate" });
  await next(event => event.type === "error" && /changed; reopen/.test(event.message));
  assert.equal(mutations.length, 1, "A rejected mutation must not be automatically retried.");
  assert.equal(mutations[0].expectedRevision, 7);
  listener({ type: "groupCreate" });
  await next(event => event.type === "state" && event.library.groups.length === 2);
  assert.equal(mutations.length, 2);
  assert.equal(mutations[1].expectedRevision, 8);
  assert.notEqual(mutations[1].operationId, mutations[0].operationId);
  assert.deepEqual(fs.readdirSync(root), [], "The UI adapter must never initialize a legacy writer.");
});

test("a newer background poll retains the real selection receipt instead of leaving navigation stuck", async t => {
  const data = fixture(t);
  process.env.PKM_PRIVATE_NATIVE_CHAT_UI_GRANT = data.grantFile;
  const chatId = crypto.randomUUID(), namespace = "a".repeat(16);
  let oldHistory, entered, posted, listener, historyCalls = 0;
  const waiting = new Promise(resolve => { entered = resolve; });
  const published = new Promise(resolve => { posted = resolve; });
  const history = { revision: 0, metadata: {}, pending: [],
    messages: [{ id: crypto.randomUUID(), role: "user", content: "Original unit-test history." }] };
  const ui = adapter(async (_url, request) => {
    const input = JSON.parse(request.body);
    if (input.method === "status") {
      const { root, workspaceId, actorId, sourceFingerprint } = JSON.parse(fs.readFileSync(data.grantFile));
      return { ok: true, json: async () => ({ value: { root, workspaceId, actorId, sourceFingerprint } }) };
    }
    if (input.method === "list") return { ok: true, json: async () => ({ value: [
      { id: chatId, chatId, namespace, groupId: "ungroup", title: "Original Chat" },
    ] }) };
    assert.equal(input.method, "history");
    if (++historyCalls === 1) return { ok: true, json: () => new Promise(resolve => { oldHistory = resolve; entered(); }) };
    return { ok: true, json: async () => ({ value: history }) };
  });
  const context = { globalStorageUri: { fsPath: data.profile }, subscriptions: [] };
  assert.equal(await ui.activate(context, () => data.root), true);
  const provider = ui.provider(), states = [];
  t.after(() => provider.dispose());
  provider.resolveWebviewView({
    visible: true, onDidDispose() {},
    webview: {
      onDidReceiveMessage(callback) { listener = callback; return { dispose() {} }; },
      async postMessage(value) { states.push(value); posted(); return true; },
    },
  });
  listener({ type: "select", id: chatId, requestId: "real-selection-receipt" });
  await waiting;
  ui.poll();
  await published;
  oldHistory({ value: history });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(states.length, 1);
  assert.equal(states[0].chat.id, chatId);
  assert.equal(states[0].navigationRequestId, "real-selection-receipt");
});
