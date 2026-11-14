"use strict";
const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs"), path = require("node:path"), crypto = require("node:crypto");
const ts = require("typescript");

function fixture(t) {
  const directory = path.resolve(".migration-test-work", `chat-view-${crypto.randomUUID()}`);
  const root = path.join(directory, "root");
  fs.mkdirSync(root, { recursive: true, mode: 0o700 });
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  let currentRoot = root, sessionValid = true, profileValid = true, provider, drainCount = 0, failDrain = false;
  const sessionController = new AbortController(), profileController = new AbortController();
  const authority = {
    root, workspaceId: crypto.randomUUID(), sessionId: crypto.randomUUID(), profileId: "private-profile",
    sourceFingerprint: "a".repeat(64), endpoint: "http://127.0.0.1:12345",
    bearer: crypto.randomBytes(32).toString("base64url"),
    session: { signal: sessionController.signal, assertCurrent(binding) {
      assert.deepEqual(binding, { root, workspaceId: authority.workspaceId, actorId: "local:owner",
        profileId: authority.profileId, sessionId: authority.sessionId, endpoint: authority.endpoint,
        bearer: authority.bearer, sourceFingerprint: authority.sourceFingerprint });
      if (!sessionValid) throw new Error("session revoked");
    }, async revokeChat() { drainCount++; if (failDrain) throw new Error("drain unknown"); } },
    profile: { signal: profileController.signal, assertCurrent(binding) {
      assert.equal(binding.profileId, "private-profile");
      if (!profileValid) throw new Error("profile revoked");
    } },
  };
  class Provider {
    constructor(_context, binding, current) { this.binding = binding; this.current = current; provider = this; }
    isBusy = false;
    attachWebviewView() {}
    async openPkmChat() {}
    dispose() { this.disposed = true; }
  }
  const vscode = { workspace: { isTrusted: true } };
  const transpile = file => ts.transpileModule(fs.readFileSync(file, "utf8"), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  const selected = { exports: {} };
  let fetchImpl = async () => ({ ok: true, json: async () => ({ value: {
    root, workspaceId: authority.workspaceId, actorId: "local:owner", sourceFingerprint: authority.sourceFingerprint,
    managed: true, processes: true, processApprovalUi: true,
  } }) });
  new Function("require", "module", "exports", "fetch", transpile("src/chat/selected-owner-chat-ui.ts"))(
    name => name === "vscode" ? vscode : name === "./native-chat-ui-experiment" ? { NativeChatUiProvider: Provider } : require(name),
    selected, selected.exports, (...args) => fetchImpl(...args));
  const module = { exports: {} };
  new Function("require", "module", "exports", transpile("src/chat/adopted-root-chat-view.ts"))(
    name => name === "../knowledge/filestore" ? { getStorePath: () => currentRoot }
      : name === "./selected-owner-chat-ui" ? selected.exports : require(name), module, module.exports);
  return { authority, create: module.exports.createAdoptedRootChatViewBackend, provider: () => provider,
    profileController, sessionController, setRoot: value => { currentRoot = value; },
    revokeProfile: () => { profileValid = false; }, revokeSession: () => { sessionValid = false; },
    failDrain: value => { failDrain = value; }, drains: () => drainCount, setFetch: value => { fetchImpl = value; } };
}

test("ordinary adopted Chat view requires separately fenced session and profile, and fails closed on uncertain drain", async t => {
  const f = fixture(t);
  const backend = await f.create({ subscriptions: [] }, f.authority, new AbortController().signal);
  assert.equal(f.provider().binding.root, f.authority.root);
  backend.attachWebviewView({}, true);
  f.failDrain(true);
  await assert.rejects(backend.drainManagedWriter(), /drain unknown/);
  assert.throws(() => backend.attachWebviewView({}, true), /authority/);
  f.failDrain(false);
  await backend.drainManagedWriter();
  assert.equal(f.drains(), 2);
  backend.dispose();
});

test("adopted Chat view denies changed root, profile or session during publication", async t => {
  const f = fixture(t);
  let release, entered;
  const waiting = new Promise(resolve => { entered = resolve; });
  f.setFetch(async () => { entered(); await new Promise(resolve => { release = resolve; });
    return { ok: true, json: async () => ({ value: {
      root: f.authority.root, workspaceId: f.authority.workspaceId, actorId: "local:owner",
      sourceFingerprint: f.authority.sourceFingerprint, managed: true, processes: true, processApprovalUi: true,
    } }) }; });
  const pending = f.create({ subscriptions: [] }, f.authority, new AbortController().signal);
  await waiting;
  f.revokeProfile(); release();
  await assert.rejects(pending, /profile revoked/);
  assert.equal(f.provider(), undefined);
  f.setRoot(path.dirname(f.authority.root));
  await assert.rejects(f.create({ subscriptions: [] }, f.authority, new AbortController().signal), /authority/);
});

test("adopted Chat view refuses replacement of the original root identity", async t => {
  const f = fixture(t);
  const backend = await f.create({ subscriptions: [] }, f.authority, new AbortController().signal);
  fs.renameSync(f.authority.root, `${f.authority.root}-old`);
  fs.mkdirSync(f.authority.root, { mode: 0o700 });
  assert.throws(() => backend.attachWebviewView({}, true), /root identity changed/);
  backend.dispose();
});

test("adopted Chat view rejects async authority and revocation without fallback", async t => {
  const f = fixture(t);
  await assert.rejects(f.create({ subscriptions: [] }, { ...f.authority,
    session: { ...f.authority.session, assertCurrent: async () => {} } }, new AbortController().signal), /synchronously/);
  const backend = await f.create({ subscriptions: [] }, f.authority, new AbortController().signal);
  f.sessionController.abort();
  assert.equal(f.provider().disposed, true);
  assert.throws(() => backend.attachWebviewView({}, true), /closed/);
});

test("replacing root inside a fence and a non-void drain cannot report success", async t => {
  const f = fixture(t);
  const originalCheck = f.authority.profile.assertCurrent;
  f.authority.profile.assertCurrent = binding => {
    originalCheck(binding);
    fs.renameSync(f.authority.root, `${f.authority.root}-old`);
    fs.mkdirSync(f.authority.root, { mode: 0o700 });
  };
  await assert.rejects(f.create({ subscriptions: [] }, f.authority, new AbortController().signal), /root identity changed/);
  f.authority.profile.assertCurrent = originalCheck;
  f.authority.session.revokeChat = async () => false;
  const backend = await f.create({ subscriptions: [] }, f.authority, new AbortController().signal);
  await assert.rejects(backend.drainManagedWriter(), /outcome is unknown/);
  assert.throws(() => backend.attachWebviewView({}, true), /authority/);
  backend.dispose();
});

test("the session fence and HTTP validation use one immutable transport binding", async t => {
  const f = fixture(t), endpoint = f.authority.endpoint, bearer = f.authority.bearer;
  f.authority.session.assertCurrent = binding => {
    assert.equal(binding.endpoint, endpoint);
    assert.equal(binding.bearer, bearer);
    assert.equal(Object.isFrozen(binding), true);
    f.authority.endpoint = "http://127.0.0.1:23456";
    f.authority.bearer = "b".repeat(43);
  };
  f.setFetch(async (url, request) => {
    assert.equal(url, `${endpoint}/rpc`);
    assert.equal(request.headers.authorization, `Bearer ${bearer}`);
    return { ok: true, json: async () => ({ value: {
      root: f.authority.root, workspaceId: f.authority.workspaceId, actorId: "local:owner",
      sourceFingerprint: f.authority.sourceFingerprint, managed: true, processes: true, processApprovalUi: true,
    } }) };
  });
  const backend = await f.create({ subscriptions: [] }, f.authority, new AbortController().signal);
  backend.dispose();
});
