"use strict";
const { fork } = require("node:child_process");
const { randomUUID } = require("node:crypto");
const { test } = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const { createOwnerParentControl, createOwnerParentScopeControl, assertOwnerParentScopeControl } = require(path.join(
  process.env.PKM_TEST_PARENT_CONTROL_DIST || path.resolve("dist"), "owner-parent-control.js"));

async function start(t) {
  const child = fork(path.join(__dirname, "fixtures/owner-parent-control-child.cjs"), [],
    { stdio: ["ignore", "ignore", "ignore", "ipc"] });
  const exited = new Promise(resolve => child.once("exit", resolve));
  t.after(async () => {
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGTERM");
    await exited;
  });
  await new Promise(resolve => child.once("message", resolve));
  return child;
}

test("a late acknowledgement cannot complete a newer revoke", async t => {
  const child = await start(t);
  const control = createOwnerParentControl({ child, sessionId: randomUUID(), timeoutMs: 80, assertCurrent() {} });
  t.after(() => control.dispose());
  await assert.rejects(control.revokeScope("mcp"), /timed out.*unknown/);
  await control.revokeScope("mcp");
  await new Promise(resolve => setTimeout(resolve, 220));
  await assert.rejects(control.revokeScope("mcp"), /completed/);
});

test("changed authority makes an in-flight acknowledgement unknown", async t => {
  const child = await start(t);
  assert.throws(() => createOwnerParentControl({ child, sessionId: randomUUID(), assertCurrent: async () => {} }),
    /synchronously/);
  let allowed = true;
  const control = createOwnerParentControl({ child, sessionId: randomUUID(), timeoutMs: 1000,
    assertCurrent() { if (!allowed) throw new Error("profile changed"); } });
  t.after(() => control.dispose());
  const pending = control.revokeScope("chat");
  allowed = false;
  await assert.rejects(pending, /unknown/);
  await assert.rejects(control.revokeScope("environment"), /unknown/);
  assert.throws(() => createOwnerParentControl({ child, sessionId: randomUUID(), assertCurrent() {} }), /connected owner child/);
});

test("shared direct-child control issues distinct branded deny-only scope handles", async t => {
  const child = await start(t), sessionId = randomUUID();
  const control = createOwnerParentControl({ child, sessionId, timeoutMs: 80, assertCurrent() {} });
  t.after(() => control.dispose());
  const binding = scope => ({ child, sessionId, scope });
  const chat = createOwnerParentScopeControl(control, binding("chat"));
  const environment = createOwnerParentScopeControl(control, binding("environment"));
  assertOwnerParentScopeControl(chat, binding("chat"));
  assertOwnerParentScopeControl(environment, binding("environment"));
  assert.throws(() => assertOwnerParentScopeControl({ ...chat }, binding("chat")), /capability/);
  assert.throws(() => assertOwnerParentScopeControl(chat, binding("environment")), /capability/);
  assert.throws(() => assertOwnerParentScopeControl(chat, { ...binding("chat"), sessionId: randomUUID() }), /capability/);
  assert.throws(() => assertOwnerParentScopeControl(chat, { ...binding("chat"), child: {} }), /capability/);
  assert.throws(() => createOwnerParentScopeControl({ ...control }, binding("mcp")), /unclaimed/);
  assert.throws(() => createOwnerParentScopeControl(control, binding("chat")), /unclaimed/);
  assert.equal(environment.dispose, undefined);
  let reentrant;
  chat.signal.addEventListener("abort", () => { reentrant = chat.revoke(); }, { once: true });
  const first = control.revokeScope("chat");
  assert.equal(chat.signal.aborted, true);
  assert.equal(environment.signal.aborted, false);
  await assert.rejects(reentrant, /pending/);
  await assert.rejects(first, /timed out.*unknown/);
  assert.throws(() => assertOwnerParentScopeControl(chat, binding("chat")), /capability/);
  assertOwnerParentScopeControl(environment, binding("environment"));
  await environment.revoke();
  await chat.revoke();
  assert.throws(() => assertOwnerParentScopeControl(environment, binding("environment")), /capability/);
});

test("losing the shared parent control synchronously fences every scope", async t => {
  const child = await start(t), sessionId = randomUUID();
  const control = createOwnerParentControl({ child, sessionId, assertCurrent() {} });
  const chat = createOwnerParentScopeControl(control, { child, sessionId, scope: "chat" });
  const environment = createOwnerParentScopeControl(control, { child, sessionId, scope: "environment" });
  control.dispose();
  assert.equal(chat.signal.aborted, true);
  assert.equal(environment.signal.aborted, true);
  await assert.rejects(chat.revoke(), /unknown/);
});
