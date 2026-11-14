"use strict";
const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs"), path = require("node:path"), crypto = require("node:crypto");
const ts = require("typescript");

function load(fetch, vscode, name = "registerSelectedOwnerChatUi") {
  const source = fs.readFileSync(path.join(__dirname, "../src/chat/selected-owner-chat-ui.ts"), "utf8");
  const js = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
  const module = { exports: {} };
  class Provider {
    constructor(_context, binding, current, selected) { this.binding = binding; this.current = current; this.selected = selected; }
    isBusy = false;
    attachWebviewView(view, retainHtml) { this.attached = { view, retainHtml }; }
    async openPkmChat(locator) { this.locator = locator; }
    dispose() { this.disposed = true; }
  }
  const imports = name => name === "vscode" ? vscode
    : name === "./native-chat-ui-experiment" ? { NativeChatUiProvider: Provider } : require(name);
  new Function("require", "module", "exports", "fetch", js)(imports, module, module.exports, fetch);
  return module.exports[name];
}

function fixture() {
  const binding = { root: "/independent-chat-archive", nonce: crypto.randomUUID(), workspaceId: crypto.randomUUID(),
    actorId: "local:owner", sourceFingerprint: "a".repeat(64), bearer: crypto.randomBytes(32).toString("base64url"),
    endpoint: "http://127.0.0.1:12345" };
  let provider, viewDisposed = false, commandDisposed = false, selected = true;
  const views = [], commands = new Map(), executed = [];
  const vscode = { workspace: { isTrusted: true }, window: {
    registerWebviewViewProvider(id, value) { views.push(id); provider = value; return { dispose() { viewDisposed = true; } }; },
  }, commands: { registerCommand(id, callback) { commands.set(id, callback); return { dispose() { commandDisposed = true; commands.delete(id); } }; },
    executeCommand(...args) { executed.push(args); } } };
  const connection = new AbortController();
  const options = { binding, connection: connection.signal, assertCurrent() { if (!selected) throw new Error("owner revoked"); } };
  return { binding, vscode, connection, options, views, commands, executed, provider: () => provider,
    revoke: () => { selected = false; }, disposed: () => viewDisposed && commandDisposed };
}

test("selected owner UI binds the actual host, rejects changed authority and disposes on disconnect", async () => {
  const f = fixture();
  const register = load(async (_url, request) => {
    assert.equal(request.headers["x-pkm-native-actor"], f.binding.actorId);
    assert.equal(JSON.parse(request.body).method, "status");
    return { ok: true, json: async () => ({ value: { ...f.binding, managed: true, processes: true, processApprovalUi: true } }) };
  }, f.vscode);
  const context = { subscriptions: [] };
  await register(context, f.options);
  assert.deepEqual(f.views, ["personalKnowledge.nextSelectedChat"]);
  assert.deepEqual([...f.commands.keys()], ["personalKnowledge.focusNextSelectedChat"]);
  await f.commands.get("personalKnowledge.focusNextSelectedChat")();
  assert.ok(f.executed.some(args => args[0] === "workbench.view.extension.personalKnowledgeNextChat"));
  assert.ok(f.executed.some(args => args[0] === "personalKnowledge.nextSelectedChat.focus"));
  assert.ok(!f.executed.some(args => args[0] === "personalKnowledge.apiChat.focus"));
  assert.ok(f.executed.some(args => args[0] === "setContext" && args[1] === "personalKnowledge.nextSelectedChatAvailable" && args[2] === true));
  await assert.rejects(register(context, f.options), /already registered/);
  assert.equal(f.provider().selected, true);
  assert.deepEqual(f.provider().current(), f.binding);
  f.revoke();
  assert.throws(() => f.provider().current(), /owner revoked/);
  f.connection.abort();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(f.provider().disposed, true);
  assert.equal(f.disposed(), true);
  assert.ok(f.executed.some(args => args[0] === "setContext" && args[1] === "personalKnowledge.nextSelectedChatAvailable" && args[2] === false));
});

test("selected owner UI refuses stale or asynchronous profile fences and mismatched hosts", async () => {
  const f = fixture();
  let release, entered;
  const waiting = new Promise(resolve => { entered = resolve; });
  const register = load(async () => { entered(); await new Promise(resolve => { release = resolve; });
    return { ok: true, json: async () => ({ value: { ...f.binding, managed: true, processes: true, processApprovalUi: true } }) };
  }, f.vscode);
  const pending = register({ subscriptions: [] }, f.options);
  await waiting; f.revoke(); release();
  await assert.rejects(pending, /owner revoked/);
  assert.equal(f.provider(), undefined);
  const g = fixture();
  const deny = load(async () => ({ ok: true, json: async () => ({ value: {
    ...g.binding, actorId: "another-actor", managed: true, processes: true, processApprovalUi: true,
  } }) }), g.vscode);
  await assert.rejects(deny({ subscriptions: [] }, g.options), /does not match/);
  await assert.rejects(deny({ subscriptions: [] }, { ...g.options, assertCurrent: async () => {} }), /synchronously/);
  await assert.rejects(deny({ subscriptions: [] }, { ...g.options, assertCurrent: async () => { throw new Error("async revoked"); } }), /synchronously/);
  assert.equal(g.provider(), undefined);
});

test("ordinary shell owner adapter preserves live authority and propagates unconfirmed drain", async () => {
  const f = fixture();
  const create = load(async () => ({ ok: true, json: async () => ({ value: {
    ...f.binding, managed: true, processes: true, processApprovalUi: true,
  } }) }), f.vscode, "createSelectedOwnerChatViewBackend");
  let drains = 0;
  const backend = await create({ subscriptions: [] }, { ...f.options, async drain() {
    drains++;
    throw new Error("owner drain unconfirmed");
  } });
  backend.attachWebviewView({}, true);
  await backend.openPkmChat("pkm://chats/source/fixture");
  await assert.rejects(backend.drainManagedWriter(), /drain unconfirmed/);
  assert.equal(drains, 1);
  f.revoke();
  assert.throws(() => backend.attachWebviewView({}, true), /owner revoked/);
  assert.throws(() => backend.openPkmChat("fixture"), /view is closed/);
  f.connection.abort();
});

test("a disposed ordinary Chat owner adapter cannot be attached again", async () => {
  const f = fixture();
  const create = load(async () => ({ ok: true, json: async () => ({ value: {
    ...f.binding, managed: true, processes: true, processApprovalUi: true,
  } }) }), f.vscode, "createSelectedOwnerChatViewBackend");
  const backend = await create({ subscriptions: [] }, { ...f.options, async drain() {} });
  backend.dispose();
  assert.throws(() => backend.attachWebviewView({}, true), /view is closed/);
  assert.throws(() => backend.openPkmChat("fixture"), /view is closed/);
});

test("revocation during view publication hides the view and disposes the registration", async () => {
  const f = fixture();
  let release, entered;
  const started = new Promise(resolve => { entered = resolve; });
  f.vscode.commands.executeCommand = (...args) => {
    f.executed.push(args);
    if (args[0] === "setContext" && args[2] === true) {
      entered();
      return new Promise(resolve => { release = resolve; });
    }
  };
  const register = load(async () => ({ ok: true, json: async () => ({ value: {
    ...f.binding, managed: true, processes: true, processApprovalUi: true,
  } }) }), f.vscode);
  const pending = register({ subscriptions: [] }, f.options);
  await started;
  f.connection.abort();
  release();
  await assert.rejects(pending, /connection or trusted workspace/);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(f.disposed(), true);
  assert.deepEqual(f.executed.filter(args => args[0] === "setContext").map(args => args[2]), [true, false]);
});

test("selected view and command are declared separately and hidden without a live owner", () => {
  const manifest = require("../package.json");
  const views = manifest.contributes.views.personalKnowledgeChat;
  assert.ok(views.some(view => view.id === "personalKnowledge.apiChat" && !view.when));
  assert.ok(!views.some(view => view.id === "personalKnowledge.nextSelectedChat"));
  assert.ok(manifest.contributes.views.personalKnowledgeNextChat.some(view => view.id === "personalKnowledge.nextSelectedChat"
    && view.when === "personalKnowledge.nextSelectedChatAvailable"));
  assert.ok(manifest.contributes.commands.some(command => command.command === "personalKnowledge.openNextSelectedChat"));
  assert.ok(manifest.contributes.commands.some(command => command.command === "personalKnowledge.closeNextSelectedChat"));
  assert.ok(!manifest.contributes.menus.commandPalette.some(item => item.command === "personalKnowledge.openNextSelectedChat"));
  assert.ok(!manifest.contributes.menus.commandPalette.some(item => item.command === "personalKnowledge.closeNextSelectedChat"));
});
