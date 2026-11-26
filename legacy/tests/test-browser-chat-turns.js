const assert = require("node:assert/strict");
const { test } = require("node:test");
const { createHash, randomUUID } = require("node:crypto");
const { mkdirSync, rmSync } = require("node:fs");
const { createServer } = require("node:http");
const { join, resolve } = require("node:path");
const Module = require("node:module");

test("native browser Send and exact Stop use the existing store, writer and streaming transport", { timeout: 15_000 }, async t => {
  const root = join(__dirname, "../../.migration-test-work", `browser-turn-${randomUUID()}`);
  mkdirSync(root, { recursive: true, mode: 0o700 });
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const requests = [];
  let streaming, releaseStreaming;
  streaming = new Promise(resolve => { releaseStreaming = resolve; });
  const server = createServer(async (req, res) => {
    let data = "";
    for await (const chunk of req) data += chunk;
    const body = JSON.parse(data);
    requests.push(body);
    const text = body.messages.at(-1).content;
    res.writeHead(200, { "content-type": "text/event-stream" });
    res.write(`data: ${JSON.stringify({ choices: [{ index: 0, delta: { content: "isolated model output" } }] })}\n\n`);
    if (text.includes("hold stream")) releaseStreaming();
    else if (text.includes("unknown result")) res.end();
    else res.end('data: {"choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n');
  });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(() => { server.closeAllConnections(); server.close(); });
  const folder = { uri: { fsPath: root, scheme: "file", toString: () => `file://${root}` }, name: "fixture", index: 0 };
  const disposable = () => ({ dispose() {} });
  const cfg = { aiEndpoint: `http://127.0.0.1:${server.address().port}/v1`, aiModel: "fixture",
    apiChatModelProfiles: [{ id: "fixture", status: "active", contextWindow: 8192, maxOutputTokens: 1024 }] };
  const notices = [];
  const vscode = {
    env: { language: "en" },
    workspace: { isTrusted: true, workspaceFolders: [folder], onDidChangeConfiguration: disposable,
      getConfiguration: () => ({ get: (name, fallback) => cfg[name] ?? fallback }) },
    window: { showErrorMessage: async message => { notices.push(message); }, showInformationMessage: async () => {},
      showWarningMessage: async message => { notices.push(message); } },
    lm: { tools: [] }, commands: { executeCommand: async () => undefined },
  };
  const load = Module._load;
  Module._load = function (name, ...args) { return name === "vscode" ? vscode : load.call(this, name, ...args); };
  let view, store, binding;
  try {
    const { ApiChatView } = require("../dist/chat/api-chat-view");
    const { ApiChatStore } = require("../dist/chat/api-chat-store");
    const { bindBrowserChatTurns } = require("../dist/chat/browser-chat-turns");
    const { setStorePath } = require("../dist/knowledge/filestore");
    const { HostWriterAdmission } = require("../dist/runtime/host-writer-admission");
    setStorePath(root);
    const host = new HostWriterAdmission(root, () => root);
    const context = { extensionPath: resolve(__dirname, ".."), globalStorageUri: { fsPath: root }, globalState: { get: (_, fallback) => fallback, update: async () => {} },
      workspaceState: { get: () => undefined, update: async () => {} }, secrets: { get: async () => "local-fixture" } };
    view = new ApiChatView(context);
    view.setHostWriterObserver((work, cancellation) => cancellation ? host.observeCancellation(work) : host.observe("chat", work));
    const namespace = createHash("sha256").update(folder.uri.toString()).digest("hex").slice(0, 16);
    store = new ApiChatStore(join(root, ".pkm", "state"), namespace);
    view.store = store;
    const chat = store.create();
    Object.assign(chat, { permissionMode: "read-only", builtinTools: [], includeHistory: false });
    store.save(chat);
    store.startTask(chat, "Existing session");
    view.chat = chat;
    view.chats.set(chat.id, chat);
    view.view = { visible: true, webview: { postMessage: async () => true } };
    binding = { bindBrowserChatTurns, chat };
  } finally { Module._load = load; }
  t.after(() => view.dispose());
  const { chat, bindBrowserChatTurns } = binding;
  const grant = { actorId: "fixture", workspaceRoot: root, generation: "fixture", chatHostId: randomUUID() };
  let approvals = 0, beforeApproval = () => {};
  const owner = bindBrowserChatTurns(grant, {
    assertCurrent: current => assert.deepEqual(current, grant),
    target: id => view.browserChatTurnTarget(root, id),
    confirm: async () => { approvals++; beforeApproval(); return true; },
    async send(id, text, admitted) {
      try { return await view.sendBrowserChatTurn(root, id, text, admitted); }
      catch (error) { notices.push(error.stack); throw error; }
    },
  });

  const target = () => owner.getSendTarget(grant, { chatId: chat.id });
  const stale = target();
  beforeApproval = () => {
    const other = store.load(chat.id, false);
    other.title = "Renamed during confirmation";
    store.save(other);
  };
  assert.equal((await owner.sendChatTurn(grant, { ...stale, text: "do not send stale" })).status, "not-sent");
  assert.equal(requests.length, 0);
  assert.equal(store.load(chat.id, false).messages.length, 0);
  view.chat = store.load(chat.id, false);
  beforeApproval = () => {};

  const first = target();
  const finished = await owner.sendChatTurn(grant, { ...first, text: "finish normally" });
  assert.equal(finished.status, "completed", JSON.stringify({ notices, requests: requests.length }));
  assert.equal(owner.getChatTurn(grant, first).status, "completed");
  assert.equal((await owner.sendChatTurn(grant, { ...first, text: "do not replay" })).status, "completed");
  assert.equal(requests.length, 1);
  const previous = target();
  const second = target();
  const pending = owner.sendChatTurn(grant, { ...second, text: "hold stream" });
  await Promise.race([streaming, pending.then(result => assert.fail(JSON.stringify({ result, notices })))]);
  assert.equal(owner.getChatTurn(grant, second).status, "running");
  assert.throws(() => owner.stopChatTurn(grant, previous), /unavailable/);
  assert.throws(() => owner.stopChatTurn(grant, { ...second, chatId: randomUUID() }), /unavailable/);
  assert.equal(owner.getChatTurn(grant, second).status, "running");
  assert.equal(owner.stopChatTurn(grant, second).status, "stop-requested");
  assert.equal((await pending).status, "cancelled");
  const saved = store.load(chat.id, false);
  assert.deepEqual(saved.messages.filter(m => m.role === "assistant").map(m => [m.progress.attemptId, m.status]),
    [[first.turnId, "complete"], [second.turnId, "cancelled"]]);
  assert.equal(approvals, 3);
  assert.equal(requests.length, 2);

  const uncertain = target();
  assert.equal((await owner.sendChatTurn(grant, { ...uncertain, text: "unknown result" })).status, "unknown");
  assert.equal(owner.getChatTurn(grant, uncertain).status, "unknown");
  assert.equal((await owner.sendChatTurn(grant, { ...uncertain, text: "unknown result" })).status, "unknown");
  assert.equal(requests.length, 3, "an ambiguous provider result must not replay");
  assert.equal(approvals, 4);

  const raced = target();
  const admit = store.admitBrowserTurn.bind(store);
  const secondWindowStore = new store.constructor(join(root, ".pkm", "state"), store.namespace);
  const snapshot = secondWindowStore.load(chat.id, false);
  // Schedule a real second-store revision precisely between the UI check and
  // the first durable admission, before the latter enters the writer lock.
  const race = t.mock.method(store, "admitBrowserTurn", (...args) => {
    snapshot.title = "Another window won at admission";
    secondWindowStore.save(snapshot);
    return admit(...args);
  });
  assert.equal((await owner.sendChatTurn(grant, { ...raced, text: "do not send after CAS loss" })).status, "unknown");
  race.mock.restore();
  assert.equal(requests.length, 3);
  const afterRace = store.load(chat.id, false);
  assert.equal(afterRace.title, snapshot.title);
  assert.equal(afterRace.messages.length, 6);
  assert.equal(view.chat.messages.length, 6, "a rejected draft must not become the visible Chat");
});
