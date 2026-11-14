"use strict";
const { test } = require("node:test"), assert = require("node:assert/strict");
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

function wait(child, predicate) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { child.removeListener("message", handler); reject(new Error("Fixture message timed out.")); }, 3000);
    function handler(value) {
      if (!predicate(value)) return;
      clearTimeout(timer); child.removeListener("message", handler); resolve(value);
    }
    child.on("message", handler);
  });
}

async function fixture(t, authorize = () => true, timeoutMs = 1000, early = false) {
  const directory = path.resolve(".migration-test-work", `chat-effect-${crypto.randomUUID()}`);
  const root = path.join(directory, "root"), profile = path.join(directory, "profile");
  fs.mkdirSync(root, { recursive: true, mode: 0o700 });
  fs.mkdirSync(profile, { mode: 0o700 });
  const child = fork(path.resolve("tests/next-trial-electron/adopted-chat-effect-child.cjs"), [],
    { stdio: ["ignore", "ignore", "pipe", "ipc"] });
  let descendantPid;
  child.on("message", value => { if (value?.type === "effect-started") descendantPid = value.pid; });
  t.after(async () => {
    if (descendantPid && child.exitCode === null && child.signalCode === null) {
      try {
        const stat = fs.readFileSync(`/proc/${descendantPid}/stat`, "utf8");
        const fields = stat.slice(stat.lastIndexOf(")") + 2).trim().split(/\s+/);
        if (Number(fields[1]) === child.pid && !["Z", "X"].includes(fields[0])) process.kill(descendantPid, "SIGTERM");
      } catch (error) { if (error.code !== "ENOENT" && error.code !== "ESRCH") throw error; }
    }
    if (child.exitCode === null && child.signalCode === null) {
      const exited = once(child, "exit"); child.kill("SIGTERM"); await exited;
    }
    fs.rmSync(directory, { recursive: true, force: true });
  });
  await wait(child, m => m.type === "ready");
  const event = () => ({ dispose() {} }), vscode = {
    workspace: { isTrusted: true, onDidChangeWorkspaceFolders: event, onDidChangeConfiguration: event },
    window: { showQuickPick: async values => values[0], showWarningMessage: async () => "Allow Selected Chat" },
  };
  const authorityModule = moduleFrom("src/chat/adopted-root-chat-authority.ts", {
    vscode, "../knowledge/filestore": { getStorePath: () => root },
  });
  const control = moduleFrom("src/runtime/owner-parent-control.ts", {});
  const parentModule = moduleFrom("src/chat/adopted-root-chat-parent-session.ts", {
    "../runtime/owner-parent-control": control, "./adopted-root-chat-authority": authorityModule,
  });
  const gateModule = moduleFrom("src/chat/adopted-root-chat-effect-gate.ts", {
    "./adopted-root-chat-parent-session": parentModule,
  });
  const context = { subscriptions: [], globalStorageUri: { fsPath: profile }, secrets: { onDidChange: event } };
  const hostSignal = new AbortController(), workspaceId = crypto.randomUUID(), sessionId = crypto.randomUUID();
  const configurationFingerprint = "b".repeat(64), chat = { namespace: "a".repeat(16), chatId: crypto.randomUUID() };
  function assertHostCurrent() {}
  const authority = await authorityModule.requestAdoptedRootChatAuthority(context, {
    root, workspaceId, sessionId, configurationFingerprint, candidates: [{ ...chat, title: "Chat" }],
    hostSignal: hostSignal.signal, assertHostCurrent,
  });
  t.after(() => authority.dispose());
  const options = { authority, child, root, workspaceId, sessionId, configurationFingerprint,
    hostSignal: hostSignal.signal, assertHostCurrent, endpoint: "http://127.0.0.1:12345",
    bearer: crypto.randomBytes(32).toString("base64url"), sourceFingerprint: "c".repeat(64), timeoutMs,
    assertTransportCurrent() {}, onCloseError() {}, authorizeEffect: authorize };
  const initialized = wait(child, m => m.type === "initialized");
  child.send({ type: "init", sessionId, chat, early }); await initialized;
  return { child, control, gateModule, options, authority, chat, sessionId };
}

test("exact intent and branded issuer fence each real fork effect", async t => {
  const f = await fixture(t, value => value.operation === "history");
  assert.throws(() => f.gateModule.createAdoptedChatEffectParent({ ...f.options, authority: { ...f.authority } }), /not issued/);
  const gate = f.gateModule.createAdoptedChatEffectParent(f.options);
  let result = wait(f.child, m => m.type === "result" && m.tag === "read");
  f.child.send({ type: "run", tag: "read", effect: { ...f.chat, operation: "history" } });
  assert.equal((await result).value, "history");
  result = wait(f.child, m => m.type === "result" && m.tag === "write");
  f.child.send({ type: "run", tag: "write", effect: { ...f.chat, operation: "continue", text: "not approved" } });
  assert.match((await result).error, /denied/);
  result = wait(f.child, m => m.type === "result" && m.tag === "other");
  f.child.send({ type: "run", tag: "other", effect: { ...f.chat, chatId: crypto.randomUUID(), operation: "history" } });
  assert.match((await result).error, /scope denied/);
  await gate.close();
});

test("real descendant drains before ACK and Chat revocation leaves Env active", async t => {
  const f = await fixture(t), gate = f.gateModule.createAdoptedChatEffectParent(f.options);
  const started = wait(f.child, m => m.type === "effect-started");
  f.child.send({ type: "run", tag: "held", effect: { ...f.chat, operation: "continue", text: "approved" } });
  const { pid } = await started;
  const drain = gate.revoke();
  assert.equal(gate.viewAuthority.session.signal.aborted, true);
  assert.equal(await Promise.race([drain.then(() => false), new Promise(r => setTimeout(() => r(true), 100))]), true);
  process.kill(pid, 0);
  const env = wait(f.child, m => m.type === "env-result");
  f.child.send({ type: "env" }); assert.equal((await env).active, true);
  const result = wait(f.child, m => m.type === "result" && m.tag === "held");
  f.child.send({ type: "release" });
  assert.equal((await result).value, "continued");
  await drain;
  assert.throws(() => process.kill(pid, 0), /ESRCH/);
  await gate.close();
});

test("shared direct-child Chat effect drain preserves the Environment capability", async t => {
  const f = await fixture(t);
  const owner = f.control.createOwnerParentControl({ child: f.child, sessionId: f.sessionId,
    assertCurrent() {}, timeoutMs: 1000 });
  t.after(() => owner.dispose());
  const binding = scope => ({ child: f.child, sessionId: f.sessionId, scope });
  const chat = f.control.createOwnerParentScopeControl(owner, binding("chat"));
  const env = f.control.createOwnerParentScopeControl(owner, binding("environment"));
  const gate = f.gateModule.createAdoptedChatEffectParent({ ...f.options, scopeControl: chat });
  const started = wait(f.child, m => m.type === "effect-started");
  f.child.send({ type: "run", tag: "held", effect: { ...f.chat, operation: "continue", text: "approved" } });
  const { pid } = await started;
  const draining = gate.close();
  f.control.assertOwnerParentScopeControl(env, binding("environment"));
  const envResult = wait(f.child, m => m.type === "env-result");
  f.child.send({ type: "env" }); assert.equal((await envResult).active, true);
  assert.equal(await Promise.race([draining.then(() => false), new Promise(r => setTimeout(() => r(true), 100))]), true);
  const result = wait(f.child, m => m.type === "result" && m.tag === "held");
  f.child.send({ type: "release" }); await result; await draining;
  assert.throws(() => process.kill(pid, 0), /ESRCH/);
  f.control.assertOwnerParentScopeControl(env, binding("environment"));
  await env.revoke();
  const changed = wait(f.child, m => m.type === "env-result");
  f.child.send({ type: "env" }); assert.equal((await changed).active, false);
});

test("external shared revoke fences immediately without borrowing its eventual ACK", async t => {
  const f = await fixture(t);
  const owner = f.control.createOwnerParentControl({ child: f.child, sessionId: f.sessionId,
    assertCurrent() {}, timeoutMs: 1000 });
  t.after(() => owner.dispose());
  const binding = scope => ({ child: f.child, sessionId: f.sessionId, scope });
  const chat = f.control.createOwnerParentScopeControl(owner, binding("chat"));
  const env = f.control.createOwnerParentScopeControl(owner, binding("environment"));
  const gate = f.gateModule.createAdoptedChatEffectParent({ ...f.options, scopeControl: chat });
  const started = wait(f.child, m => m.type === "effect-started");
  f.child.send({ type: "run", tag: "held", effect: { ...f.chat, operation: "continue", text: "approved" } });
  const { pid } = await started;
  const outside = owner.revokeScope("chat");
  assert.equal(gate.viewAuthority.session.signal.aborted, true);
  const result = wait(f.child, m => m.type === "result" && m.tag === "held");
  f.child.send({ type: "release" }); await result; await outside;
  assert.throws(() => process.kill(pid, 0), /ESRCH/);
  await assert.rejects(gate.close(), /unknown/);
  f.control.assertOwnerParentScopeControl(env, binding("environment"));
  await env.revoke();
});

test("missing settlement times out unknown; a later settlement permits retry", async t => {
  const f = await fixture(t, () => true, 150), gate = f.gateModule.createAdoptedChatEffectParent(f.options);
  const started = wait(f.child, m => m.type === "effect-started");
  f.child.send({ type: "run", tag: "held", effect: { ...f.chat, operation: "continue", text: "approved" } });
  await started;
  await assert.rejects(gate.revoke(), /unknown/);
  const result = wait(f.child, m => m.type === "result" && m.tag === "held");
  f.child.send({ type: "release" }); await result;
  await gate.close();
});

test("early physical ACK permanently makes the outcome unknown even after late settlement", async t => {
  const f = await fixture(t, () => true, 1000, true), gate = f.gateModule.createAdoptedChatEffectParent(f.options);
  const started = wait(f.child, m => m.type === "effect-started");
  f.child.send({ type: "run", tag: "held", effect: { ...f.chat, operation: "continue", text: "approved" } });
  const { pid } = await started;
  await assert.rejects(gate.revoke(), /unknown/);
  process.kill(pid, 0);
  const result = wait(f.child, m => m.type === "result" && m.tag === "held");
  f.child.send({ type: "release" }); await result;
  await assert.rejects(gate.close(), /unknown/);
});

test("automatic authority revocation records an early ACK before any drain caller", async t => {
  const f = await fixture(t, () => true, 1000, true), gate = f.gateModule.createAdoptedChatEffectParent(f.options);
  const started = wait(f.child, m => m.type === "effect-started");
  f.child.send({ type: "run", tag: "held", effect: { ...f.chat, operation: "continue", text: "approved" } });
  await started;
  f.authority.dispose();
  await new Promise(resolve => setTimeout(resolve, 100));
  const result = wait(f.child, m => m.type === "result" && m.tag === "held");
  f.child.send({ type: "release" }); await result;
  await assert.rejects(gate.viewAuthority.session.revokeChat(), /unknown/);
});

test("revocation inside per-effect intent validation blocks execution", async t => {
  let revoke;
  const f = await fixture(t, () => { revoke(); return true; });
  revoke = () => f.authority.dispose();
  const gate = f.gateModule.createAdoptedChatEffectParent(f.options);
  const result = wait(f.child, m => m.type === "result" && m.tag === "racing");
  f.child.send({ type: "run", tag: "racing", effect: { ...f.chat, operation: "continue", text: "approved" } });
  assert.match((await result).error, /denied|unavailable/);
  await gate.close();
});

test("local scope revoked after admission but before execution blocks the executor", async t => {
  let invalidate;
  const f = await fixture(t, () => { invalidate(); return true; });
  invalidate = () => f.child.send({ type: "invalidate-local" });
  const gate = f.gateModule.createAdoptedChatEffectParent(f.options);
  let executed = false;
  f.child.on("message", m => { if (m.type === "effect-started") executed = true; });
  const result = wait(f.child, m => m.type === "result" && m.tag === "racing");
  f.child.send({ type: "run", tag: "racing", effect: { ...f.chat, operation: "continue", text: "approved" } });
  assert.match((await result).error, /unavailable/);
  assert.equal(executed, false);
  await gate.close();
});

test("IPC disconnect while an effect runs leaves drain unknown", async t => {
  const f = await fixture(t), gate = f.gateModule.createAdoptedChatEffectParent(f.options);
  const started = wait(f.child, m => m.type === "effect-started");
  f.child.send({ type: "run", tag: "held", effect: { ...f.chat, operation: "continue", text: "approved" } });
  await started;
  const drain = gate.revoke();
  f.child.disconnect();
  await assert.rejects(drain, /unknown/);
  await assert.rejects(gate.close(), /unknown/);
});

test("replayed request poisons the gate instead of authorizing twice", async t => {
  const f = await fixture(t), gate = f.gateModule.createAdoptedChatEffectParent(f.options);
  f.child.send({ type: "replay", sessionId: f.sessionId, id: crypto.randomUUID(), effect: { ...f.chat, operation: "history" } });
  await new Promise(resolve => setTimeout(resolve, 100));
  await assert.rejects(gate.revoke(), /unknown/);
});
