"use strict";
const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs"), path = require("node:path"), crypto = require("node:crypto");
const ts = require("typescript");

function fixture(t) {
  const directory = path.resolve(".migration-test-work", `chat-intent-${crypto.randomUUID()}`);
  const root = path.join(directory, "root"), profile = path.join(directory, "profile");
  fs.mkdirSync(root, { recursive: true, mode: 0o700 });
  fs.mkdirSync(profile, { mode: 0o700 });
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const listeners = new Map(), controller = new AbortController();
  const subscribe = name => callback => { listeners.set(name, callback); return { dispose() { listeners.delete(name); } }; };
  let picker = async items => items[0], prompt = async () => "Allow Selected Chat", currentRoot = root, valid = true;
  const vscode = { workspace: { isTrusted: true, onDidChangeWorkspaceFolders: subscribe("folders"),
    onDidChangeConfiguration: subscribe("configuration") }, window: {
    showQuickPick: (...args) => picker(...args), showWarningMessage: (...args) => prompt(...args),
  } };
  const context = { subscriptions: [], globalStorageUri: { fsPath: profile }, secrets: { onDidChange: subscribe("secrets") } };
  const chat = { namespace: "a".repeat(16), chatId: crypto.randomUUID(), title: "Original Chat" };
  const options = { root, workspaceId: crypto.randomUUID(), sessionId: crypto.randomUUID(),
    configurationFingerprint: "b".repeat(64), candidates: [chat], hostSignal: controller.signal,
    assertHostCurrent(binding) {
      assert.deepEqual(binding, { root, workspaceId: options.workspaceId, sessionId: options.sessionId,
        configurationFingerprint: options.configurationFingerprint });
      if (!valid) throw new Error("host revoked");
    } };
  const js = ts.transpileModule(fs.readFileSync("src/chat/adopted-root-chat-authority.ts", "utf8"), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  const module = { exports: {} };
  new Function("require", "module", "exports", js)(
    name => name === "vscode" ? vscode : name === "../knowledge/filestore" ? { getStorePath: () => currentRoot } : require(name),
    module, module.exports);
  return { context, options, chat, vscode, controller, listeners, request: module.exports.requestAdoptedRootChatAuthority,
    setPicker: value => { picker = value; }, setPrompt: value => { prompt = value; },
    setRoot: value => { currentRoot = value; }, revokeHost: () => { valid = false; } };
}

test("user intent binds one Chat, host configuration, workspace and profile, and revokes on window change", async t => {
  const f = fixture(t);
  f.setPicker(async (items, options) => {
    assert.equal(items[0].description, `${f.chat.namespace}/${f.chat.chatId}`);
    assert.match(options.title, /one original Chat/);
    return items[0];
  });
  f.setPrompt(async (message, options, accept) => {
    assert.match(message, /selected original Chat/);
    assert.equal(options.modal, true);
    assert.match(options.detail, /does not authorize root migration/);
    assert.match(options.detail, new RegExp(f.options.configurationFingerprint));
    return accept;
  });
  const grant = await f.request(f.context, f.options);
  const binding = { root: f.options.root, workspaceId: f.options.workspaceId, actorId: "local:owner",
    profileId: grant.profileId, sessionId: f.options.sessionId, chats: [f.chat] };
  grant.assertCurrent(binding);
  assert.throws(() => grant.assertCurrent({ ...binding, sessionId: crypto.randomUUID() }), /does not match/);
  assert.throws(() => grant.assertCurrent({ ...binding, chats: [{ ...f.chat, chatId: crypto.randomUUID() }] }), /does not match/);
  assert.throws(() => grant.assertCurrent({ ...binding, chats: null }), /does not match/);
  f.listeners.get("folders")();
  assert.equal(grant.signal.aborted, true);
  assert.throws(() => grant.assertCurrent(binding), /unavailable/);
  grant.dispose();
  assert.equal(f.listeners.size, 0);
});

test("cancelled picker or confirmation creates no capability and removes listeners", async t => {
  const f = fixture(t);
  f.setPicker(async () => undefined);
  assert.equal(await f.request(f.context, f.options), undefined);
  assert.equal(f.listeners.size, 0);
  f.setPicker(async items => items[0]);
  f.setPrompt(async () => undefined);
  assert.equal(await f.request(f.context, f.options), undefined);
  assert.equal(f.listeners.size, 0);
});

test("host disconnect or trust loss during user confirmation cannot issue approval", async t => {
  const f = fixture(t);
  let release, entered;
  const started = new Promise(resolve => { entered = resolve; });
  f.setPrompt(async () => { entered(); await new Promise(resolve => { release = resolve; }); return "Allow Selected Chat"; });
  const pending = f.request(f.context, f.options);
  await started;
  f.controller.abort();
  release();
  await assert.rejects(pending, /unavailable/);
  assert.equal(f.listeners.size, 0);
});

test("approval refuses root/profile replacement, untrusted workspace, async host and ambiguous selections", async t => {
  const f = fixture(t);
  f.vscode.workspace.isTrusted = false;
  await assert.rejects(f.request(f.context, f.options), /unavailable/);
  f.vscode.workspace.isTrusted = true;
  await assert.rejects(f.request(f.context, { ...f.options, assertHostCurrent: async () => {} }), /synchronously/);
  await assert.rejects(f.request(f.context, { ...f.options, candidates: [f.chat, f.chat] }), /ambiguous/);
  f.setPrompt(async () => {
    fs.renameSync(f.context.globalStorageUri.fsPath, `${f.context.globalStorageUri.fsPath}-old`);
    fs.mkdirSync(f.context.globalStorageUri.fsPath);
    return "Allow Selected Chat";
  });
  await assert.rejects(f.request(f.context, f.options), /identity changed/);
  assert.equal(f.listeners.size, 0);
});

test("host identity loss actively revokes a previously issued intent", async t => {
  const f = fixture(t), grant = await f.request(f.context, f.options);
  f.revokeHost();
  await new Promise(resolve => setTimeout(resolve, 600));
  assert.equal(grant.signal.aborted, true);
  for (const subscription of f.context.subscriptions) subscription.dispose();
  assert.equal(f.listeners.size, 0);
});
