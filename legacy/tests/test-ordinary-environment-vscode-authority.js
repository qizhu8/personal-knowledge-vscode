"use strict";
const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs"), path = require("node:path"), crypto = require("node:crypto");
const ts = require("typescript");

function fixture(t) {
  const directory = path.resolve(".migration-test-work", `environment-native-intent-${crypto.randomUUID()}`);
  const root = path.join(directory, "root"), profile = path.join(directory, "profile");
  fs.mkdirSync(root, { recursive: true }); fs.mkdirSync(profile);
  const listeners = new Map(), controller = new AbortController();
  const subscribe = name => callback => {
    const entries = listeners.get(name) ?? new Set(); listeners.set(name, entries); entries.add(callback);
    return { dispose() { entries.delete(callback); if (!entries.size) listeners.delete(name); } };
  };
  let prompt = async (_message, _options, accept) => accept, currentRoot = root;
  const vscode = { workspace: { isTrusted: true, onDidChangeWorkspaceFolders: subscribe("folders"),
    onDidChangeConfiguration: subscribe("configuration") },
    window: { showWarningMessage: (...args) => prompt(...args) } };
  const context = { globalStorageUri: { fsPath: profile }, subscriptions: [] };
  const host = { knowledgeRoot: root, workspaceId: crypto.randomUUID(), sessionId: crypto.randomUUID(),
    signal: controller.signal, assertCurrent(binding) {
      assert.deepEqual(binding, { knowledgeRoot: root, globalStorageDirectory: profile,
        workspaceId: host.workspaceId, sessionId: host.sessionId });
    } };
  const intent = { workspaceId: host.workspaceId, actorId: "local:owner", knowledgeRoot: root,
    globalStorageDirectory: profile, operation: "packages", refresh: true,
    environments: [{ id: "registered", path: path.join(directory, "venv"), python: path.join(directory, "venv/bin/python"), manager: "venv" }] };
  const exports = {};
  const js = ts.transpileModule(fs.readFileSync("src/runtime/ordinary-environment-vscode-authority.ts", "utf8"), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  new Function("require", "exports", js)(name => name === "vscode" ? vscode
    : name === "../knowledge/filestore" ? { getStorePath: () => currentRoot } : require(name), exports);
  t.after(() => {
    controller.abort();
    context.subscriptions.forEach(subscription => subscription.dispose());
    fs.rmSync(directory, { recursive: true, force: true });
  });
  return { root, profile, context, host, intent, controller, vscode, listeners, ...exports,
    setPrompt(value) { prompt = value; }, setRoot(value) { currentRoot = value; } };
}

test("native consent binds original Root/profile; read approval cannot authorize Refresh effects", async t => {
  const f = fixture(t);
  f.setPrompt(async (_message, options, accept) => {
    assert.equal(options.modal, true); assert(options.detail.includes(f.root)); assert(options.detail.includes(f.profile));
    return accept;
  });
  const authority = await f.requestOrdinaryEnvironmentReadAuthority(f.context, f.host);
  const binding = { workspaceId: f.host.workspaceId, actorId: "local:owner", knowledgeRoot: f.root,
    globalStorageDirectory: f.profile, scope: "ordinary-environments:read-cache" };
  authority.assertCurrent(binding);
  assert.throws(() => authority.assertCurrent({ ...binding, workspaceId: crypto.randomUUID() }), /does not match/);
  let acquisitions = 0;
  await assert.rejects(f.requestOrdinaryEnvironmentRefreshPermit(f.context, {
    host: f.host, intent: f.intent, acquireEffects: async () => { acquisitions++; return {}; },
  }), /independent managed profile-writer/);
  assert.equal(acquisitions, 1);
  f.setRoot(`${f.root}-different`);
  assert.throws(() => authority.assertCurrent(binding), /revoked/);
});

test("cancel, trust loss and async host fence never acquire execution/write capabilities", async t => {
  const f = fixture(t);
  let acquisitions = 0;
  const options = { host: f.host, intent: f.intent, acquireEffects: async () => { acquisitions++; throw Error("unexpected"); } };
  f.setPrompt(async () => undefined);
  assert.equal(await f.requestOrdinaryEnvironmentRefreshPermit(f.context, options), undefined);
  assert.equal(f.listeners.size, 0);
  f.vscode.workspace.isTrusted = false;
  await assert.rejects(f.requestOrdinaryEnvironmentRefreshPermit(f.context, options), /revoked/);
  f.vscode.workspace.isTrusted = true;
  await assert.rejects(f.requestOrdinaryEnvironmentRefreshPermit(f.context, {
    ...options, host: { ...f.host, assertCurrent: async () => {} },
  }), /synchronously/);
  assert.equal(acquisitions, 0);
});

test("host revocation settles pending native consent without waiting for a stale modal answer", async t => {
  const f = fixture(t);
  let release, entered;
  const started = new Promise(resolve => { entered = resolve; });
  f.setPrompt(async () => { entered(); return new Promise(resolve => { release = resolve; }); });
  let acquisitions = 0;
  const pending = f.requestOrdinaryEnvironmentRefreshPermit(f.context, {
    host: f.host, intent: f.intent, acquireEffects: async () => { acquisitions++; return {}; },
  });
  await started;
  f.controller.abort();
  await assert.rejects(pending, /revoked/);
  release("Refresh Selected Environments");
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(acquisitions, 0); assert.equal(f.listeners.size, 0);
});

test("exact native intent is frozen, single-use and scoped; drain verification survives UI revocation", async t => {
  const f = fixture(t), effectsSignal = new AbortController();
  let captured, claims = 0, verification = 0, writerChecks = 0;
  const effects = {
    signal: effectsSignal.signal, environment: { PATH: "/usr/bin", HOME: f.profile, TMPDIR: f.profile },
    claim(actual) { assert.deepEqual(actual, captured); claims++; },
    assertCurrent() {}, assertProfileWriter() { writerChecks++; }, assertExecution() {}, recordExecution() {},
    async verifyDrained() { verification++; },
    async withProfileWrite(_id, _kind, write) { write(); },
  };
  const before = Date.now();
  const permit = await f.requestOrdinaryEnvironmentRefreshPermit(f.context, {
    host: f.host, intent: f.intent, acquireEffects: async (intent, lifetime) => {
      captured = intent; assert(lifetime.expiresAtMs <= before + 120_100); return effects;
    },
  });
  assert(Object.isFrozen(captured)); assert(Object.isFrozen(captured.environments[0]));
  assert.throws(() => permit.claim({ ...permit.intent, refresh: false }), /changed/);
  permit.claim(permit.intent);
  assert.throws(() => permit.claim(permit.intent), /consumed/); assert.equal(claims, 1);
  permit.assertCurrent("execute", "registered", "packages");
  assert.throws(() => permit.assertCurrent("execute", "other", "packages"), /approved UI request/);
  assert.throws(() => permit.assertCurrent("execute", "registered", "version"), /approved UI request/);
  assert.equal(writerChecks, 1);
  for (const callback of f.listeners.get("configuration")) callback({ affectsConfiguration: () => true });
  assert.equal(permit.signal.aborted, true);
  assert.throws(() => permit.assertProfileWriter(), /revoked/);
  await permit.verifyDrained({}, {});
  assert.equal(verification, 1);
});

test("profile replacement while confirming cannot grant effects", async t => {
  const f = fixture(t);
  f.setPrompt(async (_message, _options, accept) => {
    fs.renameSync(f.profile, `${f.profile}-old`); fs.mkdirSync(f.profile);
    return accept;
  });
  let acquisitions = 0;
  await assert.rejects(f.requestOrdinaryEnvironmentRefreshPermit(f.context, {
    host: f.host, intent: f.intent, acquireEffects: async () => { acquisitions++; return {}; },
  }), /changed/);
  assert.equal(acquisitions, 0); assert.equal(f.listeners.size, 0);
});

test("native intent-only approval carries no writer/process capability and cannot be replayed", async t => {
  const f = fixture(t);
  const approval = await f.requestOrdinaryEnvironmentRefreshIntent(f.context, { host: f.host, intent: f.intent });
  assert.equal(approval.withProfileWrite, undefined);
  assert.equal(approval.verifyDrained, undefined);
  approval.claim(approval.intent);
  assert.throws(() => approval.claim(approval.intent), /consumed/);
  f.controller.abort();
  assert.throws(() => approval.assertCurrent(), /revoked/);
});

function embedding(f) {
  const ownerChildren = new Set(), sessionChildren = new Set(), outputs = [];
  const owner = { workspaceId: f.host.workspaceId, storage: { workspaceRoot: () => f.root },
    assertCurrent() { if (f.controller.signal.aborted) throw Error("owner revoked"); },
    registerChildClose(close) { ownerChildren.add(close); return () => ownerChildren.delete(close); } };
  const hostSession = { workspaceId: owner.workspaceId, signal: f.controller.signal,
    signalFor(scope) { assert.equal(scope, "environment"); return f.controller.signal; },
    assertCurrent() { owner.assertCurrent(); },
    registerChildClose(scope, close) { assert.equal(scope, "environment"); sessionChildren.add(close); return () => sessionChildren.delete(close); } };
  let cached = true;
  const adapter = { async handleMessage(message, permit) {
    outputs.push({ message, permit });
    if (message.command === "envList") return { command: "envList", data: f.intent.environments.map(row => ({ ...row, name: "retained" })) };
    return { command: "envPackages", id: "registered", packages: cached ? [{ name: "retained", version: "1" }] : [],
      cached, capturedAt: "", ...(cached ? {} : { error: "Refresh requires independent permission." }) };
  }, async close() {} };
  const exports = {};
  const js = ts.transpileModule(fs.readFileSync("src/runtime/ordinary-environment-vscode-host.ts", "utf8"), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  new Function("require", "exports", js)(name => name === "./ordinary-environment-vscode-authority" ? f
    : name === "./ordinary-environment-owner" ? { attachOrdinaryEnvironmentsToOwner: () => adapter } : require(name), exports);
  return { ...exports, ownerChildren, sessionChildren, outputs, setCached(value) { cached = value; },
    options: { context: f.context, owner, hostSession, sessionId: f.host.sessionId,
      assertHostCurrent: f.host.assertCurrent, onCloseError(error) { throw error; } } };
}

test("embedding contract mock: cached viewing bypasses effects; confirmed Refresh still refuses missing handoff", async t => {
  const f = fixture(t), e = embedding(f);
  let prompts = 0;
  f.setPrompt(async (_message, _options, accept) => { prompts++; return accept; });
  const host = await e.startOrdinaryEnvironmentVscodeHost(e.options);
  const cached = await host.handleMessage({ command: "envPackages", id: "registered" });
  assert.equal(cached.cached, true); assert.equal(prompts, 1);
  const missing = await host.handleMessage({ command: "envPackages", id: "registered", refresh: true });
  assert.match(missing.error, /profile-writer handoff and physical process-drain/);
  assert(e.outputs.every(output => output.permit === undefined));
  await host.close();
  assert.equal(e.ownerChildren.size, 0); assert.equal(e.sessionChildren.size, 0);
});

test("embedding refuses asynchronous owner fencing before showing native consent", async t => {
  const f = fixture(t), e = embedding(f);
  let prompts = 0;
  f.setPrompt(async (_message, _options, accept) => { prompts++; return accept; });
  e.options.owner.assertCurrent = async () => {};
  await assert.rejects(e.startOrdinaryEnvironmentVscodeHost(e.options), /synchronously/);
  assert.equal(prompts, 0); assert.equal(f.listeners.size, 0);
});

test("embedding contract mock: shared owner close drains a request waiting on native confirmation", async t => {
  const f = fixture(t), e = embedding(f);
  const host = await e.startOrdinaryEnvironmentVscodeHost(e.options);
  let entered;
  const started = new Promise(resolve => { entered = resolve; });
  f.setPrompt(async () => { entered(); return new Promise(() => {}); });
  const pending = host.handleMessage({ command: "envPackages", id: "registered", refresh: true });
  await started;
  await Promise.all([...e.ownerChildren].map(close => close()));
  assert.match((await pending).error, /revoked/);
  assert.equal(e.ownerChildren.size, 0); assert.equal(e.sessionChildren.size, 0);
  assert(e.outputs.every(output => output.permit === undefined));
});
