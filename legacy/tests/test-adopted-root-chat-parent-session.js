"use strict";
const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs"), path = require("node:path"), crypto = require("node:crypto");
const { fork } = require("node:child_process"), { once } = require("node:events");
const ts = require("typescript");

function moduleFrom(file, imports) {
  const js = ts.transpileModule(fs.readFileSync(file, "utf8"), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  const module = { exports: {} };
  new Function("require", "module", "exports", js)(name => imports[name] ?? require(name), module, module.exports);
  return module.exports;
}

async function fixture(t, mode = "held") {
  const directory = path.resolve(".migration-test-work", `chat-parent-${crypto.randomUUID()}`);
  const root = path.join(directory, "root"), profilePath = path.join(directory, "profile");
  fs.mkdirSync(root, { recursive: true, mode: 0o700 });
  fs.mkdirSync(profilePath, { mode: 0o700 });
  const child = fork(path.resolve("tests/next-trial-electron/adopted-chat-parent-child.cjs"), [mode],
    { stdio: ["ignore", "ignore", "pipe", "ipc"] });
  t.after(async () => {
    if (child.exitCode === null && child.signalCode === null) {
      const exited = once(child, "exit"); child.kill("SIGTERM"); await exited;
    }
    fs.rmSync(directory, { recursive: true, force: true });
  });
  assert.equal((await once(child, "message"))[0].type, "ready");
  const event = () => ({ dispose() {} }), vscode = {
    workspace: { isTrusted: true, onDidChangeWorkspaceFolders: event, onDidChangeConfiguration: event },
    window: { showQuickPick: async values => values[0], showWarningMessage: async () => "Allow Selected Chat" },
  };
  const authorityModule = moduleFrom("src/chat/adopted-root-chat-authority.ts", {
    vscode, "../knowledge/filestore": { getStorePath: () => root },
  });
  const control = moduleFrom("src/runtime/owner-parent-control.ts", {});
  const parent = moduleFrom("src/chat/adopted-root-chat-parent-session.ts", {
    "../runtime/owner-parent-control": control, "./adopted-root-chat-authority": authorityModule,
  });
  const context = { subscriptions: [], globalStorageUri: { fsPath: profilePath }, secrets: { onDidChange: event } };
  const hostSignal = new AbortController(), workspaceId = crypto.randomUUID(), sessionId = crypto.randomUUID();
  const configurationFingerprint = "b".repeat(64), selected = { namespace: "a".repeat(16), chatId: crypto.randomUUID(), title: "Chat" };
  let hostValid = true, transportValid = true, errors = [];
  function assertHostCurrent(binding) {
    assert.deepEqual(binding, { root, workspaceId, sessionId, configurationFingerprint });
    if (!hostValid) throw new Error("host revoked");
  }
  const authority = await authorityModule.requestAdoptedRootChatAuthority(context, {
    root, workspaceId, sessionId, configurationFingerprint, candidates: [selected], hostSignal: hostSignal.signal, assertHostCurrent,
  });
  const options = { authority, child, root, workspaceId, sessionId, configurationFingerprint,
    hostSignal: hostSignal.signal, assertHostCurrent, endpoint: "http://127.0.0.1:12345",
    bearer: crypto.randomBytes(32).toString("base64url"), sourceFingerprint: "c".repeat(64), timeoutMs: 2000,
    assertTransportCurrent(binding, instance) {
      assert.equal(instance, child); assert.equal(binding.endpoint, options.endpoint);
      if (!transportValid) throw new Error("transport revoked");
    },
    onCloseError(error) { errors.push(error); },
  };
  t.after(() => authority.dispose());
  return { child, parent, control, options, authority, errors, hostSignal, revokeHost: () => { hostValid = false; },
    revokeTransport: () => { transportValid = false; } };
}

function viewBinding(value) {
  const { root, workspaceId, profileId, sessionId, endpoint, bearer, sourceFingerprint } = value;
  return { root, workspaceId, profileId, sessionId, endpoint, bearer, sourceFingerprint, actorId: "local:owner" };
}

test("the parent rejects copied grants and foreign session objects", async t => {
  const f = await fixture(t);
  assert.throws(() => f.parent.createAdoptedRootChatParentSession({ ...f.options, authority: { ...f.authority } }), /not issued/);
  assert.throws(() => f.parent.createAdoptedRootChatParentSession({ ...f.options, hostSignal: new AbortController().signal }), /not issued/);
  assert.throws(() => f.parent.createAdoptedRootChatParentSession({ ...f.options, assertHostCurrent() {} }), /not issued/);
  assert.throws(() => f.parent.createAdoptedRootChatParentSession({ ...f.options, sessionId: crypto.randomUUID() }), /not issued/);
  f.revokeTransport();
  assert.throws(() => f.parent.createAdoptedRootChatParentSession(f.options), /transport revoked/);
});

test("actual direct IPC blocks new Chat requests immediately and waits for child drain", async t => {
  const f = await fixture(t);
  const parent = f.parent.createAdoptedRootChatParentSession(f.options), view = parent.viewAuthority;
  view.session.assertCurrent(viewBinding(view));
  assert.throws(() => view.session.assertCurrent({ ...viewBinding(view), bearer: "x".repeat(43) }), /binding changed/);
  const entered = once(f.child, "message");
  f.authority.dispose();
  assert.equal(view.session.signal.aborted, true);
  assert.throws(() => view.session.assertCurrent(viewBinding(view)), /revoked/);
  assert.equal((await entered)[0].type, "entered");
  const draining = parent.close();
  assert.equal(await Promise.race([draining.then(() => false), new Promise(resolve => setTimeout(() => resolve(true), 120))]), true);
  f.child.send({ type: "release" });
  await draining;
  assert.deepEqual(f.errors, []);
});

test("failed child ACK is unknown, fences new work, and can be retried", async t => {
  const f = await fixture(t, "fail-first");
  const parent = f.parent.createAdoptedRootChatParentSession(f.options);
  await assert.rejects(parent.revokeChat(), /unknown/);
  assert.equal(parent.viewAuthority.session.signal.aborted, true);
  assert.throws(() => parent.viewAuthority.session.assertCurrent(viewBinding(parent.viewAuthority)), /revoked/);
  await parent.close();
});

test("unanswered IPC drain is unknown and never un-fences the parent", async t => {
  const f = await fixture(t, "timeout");
  f.options.timeoutMs = 80;
  const parent = f.parent.createAdoptedRootChatParentSession(f.options);
  await assert.rejects(parent.revokeChat(), /timed out.*unknown/);
  assert.equal(parent.viewAuthority.session.signal.aborted, true);
  await assert.rejects(parent.close(), /timed out.*unknown/);
});

test("a late acknowledgement cannot satisfy the retry for a different request", async t => {
  const f = await fixture(t, "late-first");
  f.options.timeoutMs = 300;
  const parent = f.parent.createAdoptedRootChatParentSession(f.options);
  await assert.rejects(parent.revokeChat(), /timed out.*unknown/);
  const entered = once(f.child, "message"), retry = parent.revokeChat();
  await entered;
  f.child.send({ type: "release-old" });
  assert.equal(await Promise.race([retry.then(() => false), new Promise(resolve => setTimeout(() => resolve(true), 80))]), true);
  f.child.send({ type: "release" });
  await retry;
  await parent.close();
});

test("owner disconnect during drain is unknown and permanently fences the view", async t => {
  const f = await fixture(t);
  const parent = f.parent.createAdoptedRootChatParentSession(f.options);
  const entered = once(f.child, "message"), pending = parent.revokeChat();
  await entered;
  f.child.disconnect();
  await assert.rejects(pending, /unknown/);
  assert.equal(parent.viewAuthority.session.signal.aborted, true);
  await assert.rejects(parent.close(), /unknown/);
});

test("startup revocation after child control creation exposes retryable cleanup", async t => {
  const f = await fixture(t, "fail-first");
  let checks = 0;
  const original = f.options.assertTransportCurrent;
  f.options.assertTransportCurrent = (...args) => { original(...args); if (++checks === 3) throw new Error("revoked during startup"); };
  let failure;
  try { f.parent.createAdoptedRootChatParentSession(f.options); } catch (error) { failure = error; }
  assert(failure instanceof f.parent.AdoptedChatParentStartupError);
  await assert.rejects(failure.retryCleanup(), /unknown/);
  await failure.retryCleanup();
});

test("shared Chat handle is branded, exact-scope and does not dispose Environment", async t => {
  const f = await fixture(t);
  const owner = f.control.createOwnerParentControl({ child: f.child, sessionId: f.options.sessionId,
    assertCurrent() {}, timeoutMs: 2000 });
  t.after(() => owner.dispose());
  const binding = scope => ({ child: f.child, sessionId: f.options.sessionId, scope });
  const chat = f.control.createOwnerParentScopeControl(owner, binding("chat"));
  const env = f.control.createOwnerParentScopeControl(owner, binding("environment"));
  assert.throws(() => f.parent.createAdoptedRootChatParentSession({ ...f.options, scopeControl: { ...chat } }), /capability/);
  assert.throws(() => f.parent.createAdoptedRootChatParentSession({ ...f.options, scopeControl: env }), /capability/);
  const parent = f.parent.createAdoptedRootChatParentSession({ ...f.options, scopeControl: chat });
  const entered = once(f.child, "message"), draining = parent.close();
  await entered;
  f.control.assertOwnerParentScopeControl(env, binding("environment"));
  f.child.send({ type: "release" }); await draining;
  f.control.assertOwnerParentScopeControl(env, binding("environment"));
  assert.throws(() => f.control.assertOwnerParentScopeControl(chat, binding("chat")), /capability/);
  const envEntered = once(f.child, "message"), envDraining = env.revoke();
  await envEntered; f.child.send({ type: "release" }); await envDraining;
});

test("shared scope timeout remains fenced while independent Environment can drain", async t => {
  const f = await fixture(t, "timeout-chat");
  const owner = f.control.createOwnerParentControl({ child: f.child, sessionId: f.options.sessionId,
    assertCurrent() {}, timeoutMs: 100 });
  t.after(() => owner.dispose());
  const binding = scope => ({ child: f.child, sessionId: f.options.sessionId, scope });
  const chat = f.control.createOwnerParentScopeControl(owner, binding("chat"));
  const env = f.control.createOwnerParentScopeControl(owner, binding("environment"));
  const parent = f.parent.createAdoptedRootChatParentSession({ ...f.options, scopeControl: chat });
  await assert.rejects(parent.revokeChat(), /unknown/);
  assert.equal(parent.viewAuthority.session.signal.aborted, true);
  f.control.assertOwnerParentScopeControl(env, binding("environment"));
  await env.revoke();
  await parent.close();
});

test("shared control keeps its global fence live when the Chat profile is revoked", async t => {
  const f = await fixture(t);
  const owner = f.control.createOwnerParentControl({ child: f.child, sessionId: f.options.sessionId,
    assertCurrent() {}, timeoutMs: 1000 });
  t.after(() => owner.dispose());
  const binding = scope => ({ child: f.child, sessionId: f.options.sessionId, scope });
  const chat = f.control.createOwnerParentScopeControl(owner, binding("chat"));
  const env = f.control.createOwnerParentScopeControl(owner, binding("environment"));
  const parent = f.parent.createAdoptedRootChatParentSession({ ...f.options, scopeControl: chat });
  const entered = once(f.child, "message");
  f.authority.dispose();
  assert.equal(parent.viewAuthority.session.signal.aborted, true);
  await entered;
  f.control.assertOwnerParentScopeControl(env, binding("environment"));
  f.child.send({ type: "release" }); await parent.close();
  f.control.assertOwnerParentScopeControl(env, binding("environment"));
  const envEntered = once(f.child, "message"), envDraining = env.revoke();
  await envEntered; f.child.send({ type: "release" }); await envDraining;
});

test("an externally revoked shared handle synchronously fences and cannot borrow its ACK", async t => {
  const f = await fixture(t);
  const owner = f.control.createOwnerParentControl({ child: f.child, sessionId: f.options.sessionId,
    assertCurrent() {}, timeoutMs: 1000 });
  t.after(() => owner.dispose());
  const binding = { child: f.child, sessionId: f.options.sessionId, scope: "chat" };
  const chat = f.control.createOwnerParentScopeControl(owner, binding);
  const parent = f.parent.createAdoptedRootChatParentSession({ ...f.options, scopeControl: chat });
  const entered = once(f.child, "message"), outside = chat.revoke();
  assert.equal(parent.viewAuthority.session.signal.aborted, true);
  assert.throws(() => parent.viewAuthority.session.assertCurrent(viewBinding(parent.viewAuthority)), /revoked/);
  await entered;
  f.child.send({ type: "release" }); await outside;
  await assert.rejects(parent.close(), /unknown/);
});

test("shared control disposal synchronously fences Chat and reports unknown drain", async t => {
  const f = await fixture(t);
  const owner = f.control.createOwnerParentControl({ child: f.child, sessionId: f.options.sessionId,
    assertCurrent() {}, timeoutMs: 1000 });
  const binding = scope => ({ child: f.child, sessionId: f.options.sessionId, scope });
  const chat = f.control.createOwnerParentScopeControl(owner, binding("chat"));
  const env = f.control.createOwnerParentScopeControl(owner, binding("environment"));
  const parent = f.parent.createAdoptedRootChatParentSession({ ...f.options, scopeControl: chat });
  owner.dispose();
  assert.equal(parent.viewAuthority.session.signal.aborted, true);
  assert.equal(env.signal.aborted, true);
  assert.throws(() => parent.viewAuthority.session.assertCurrent(viewBinding(parent.viewAuthority)), /revoked/);
  await assert.rejects(parent.close(), /unknown/);
});
