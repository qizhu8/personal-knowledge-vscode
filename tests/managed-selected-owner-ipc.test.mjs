import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { fork } from "node:child_process";
import { once } from "node:events";
import { mkdirSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { test } from "node:test";
import { managedSelectedOwnerIpc } from "../dist/managed-selected-owner-ipc.js";
import { acquireLinuxRootWriterFence } from "../dist/linux-root-writer-fence.js";

const uuid = () => randomUUID();
const waitFor = (child, predicate) => new Promise((resolveMessage, reject) => {
  const timer = setTimeout(() => { cleanup(); reject(new Error("Child response timed out.")); }, 15000);
  const message = value => { if (predicate(value)) { cleanup(); resolveMessage(value); } };
  const exit = () => { cleanup(); reject(new Error("Child exited before response.")); };
  const cleanup = () => { clearTimeout(timer); child.off("message", message); child.off("exit", exit); };
  child.on("message", message); child.on("exit", exit);
});

test("selected revoke waits for child drain and failed drain remains retryable", async () => {
  const sent = [], registered = new Set(), workspaceId = uuid(), session = uuid();
  const host = { workspaceId, selectedOwnerContext(selection) {
    const assertCurrent = () => selection.assertCurrent();
    assertCurrent();
    return { workspaceId, actorId: "local:owner", storage: {}, assertCurrent,
      registerChildClose(close) { assertCurrent(); registered.add(close); return () => registered.delete(close); } };
  } };
  const ipc = managedSelectedOwnerIpc({ host: () => host, unavailable: () => false,
    connected: () => true, send: message => sent.push(message) });
  ipc.handle({ type: "selected-owner-open", id: uuid(), session, workspaceId, actorId: "local:owner" });
  const selected = ipc.capability(session);
  let release, fail = true;
  selected.registerChildClose(async () => {
    await new Promise(resolve => { release = resolve; });
    if (fail) throw new Error("Unconfirmed child drain.");
  });
  const revokeId = uuid();
  ipc.handle({ type: "selected-owner-revoke", id: revokeId, session });
  assert.throws(() => selected.assertCurrent(), /revoked/);
  assert.equal(sent.some(message => message.id === revokeId), false);
  await Promise.resolve();
  release();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(sent.find(message => message.id === revokeId).error, "SELECTED_OWNER_DRAIN_UNKNOWN");
  assert.equal(registered.size, 1);
  fail = false;
  const retryId = uuid();
  ipc.handle({ type: "selected-owner-revoke", id: retryId, session });
  await Promise.resolve();
  release();
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(sent.find(message => message.id === retryId).result, { revoked: true });
  assert.equal(registered.size, 0);
});

test("real managed child selects and revokes an owner without releasing live Storage", { timeout: 30000 }, async t => {
  if (process.platform !== "linux") return t.skip("Requires the Linux writer fence.");
  const directory = resolve("..", ".migration-test-work", `managed-selection-${uuid()}`);
  mkdirSync(directory, { mode: 0o700 });
  const child = fork(resolve("dist/managed-client-child.js"), [], {
    execArgv: ["--require", resolve("../tests/fixtures/managed-selected-owner-drain.cjs")],
    stdio: ["ignore", "ignore", "inherit", "ipc"],
  });
  t.after(() => {
    if (child.exitCode === null && child.signalCode === null) child.kill();
    rmSync(directory, { recursive: true, force: true });
  });
  const ready = waitFor(child, value => value?.type === "ready");
  child.send({ type: "start", directory });
  const { workspaceId } = await ready;
  const request = async value => {
    const id = uuid(), result = waitFor(child, message => message?.type === "result" && message.id === id);
    child.send({ ...value, id });
    return result;
  };
  const session = uuid();
  assert.equal((await request({ type: "selected-owner-open", session, workspaceId: uuid(), actorId: "local:owner" })).error, "BUSY_OR_INVALID");
  assert.equal((await request({ type: "selected-owner-open", session, workspaceId, actorId: "local:owner" })).result.session, session);
  assert.equal((await request({ type: "selected-owner-open", session: uuid(), workspaceId, actorId: "local:owner" })).error, "BUSY_OR_INVALID");
  assert.equal((await request({ type: "selected-owner-revoke", session: uuid() })).error, "BUSY_OR_INVALID");
  assert.equal((await request({ type: "selected-owner-revoke", session })).error, "SELECTED_OWNER_DRAIN_UNKNOWN");
  assert.equal(child.connected, true);
  await assert.rejects(acquireLinuxRootWriterFence(join(directory, "workspace"), 150), /timed out|acquire.*fence/i);
  assert.deepEqual((await request({ type: "selected-owner-revoke", session })).result, { revoked: true });
  assert.deepEqual((await request({ type: "selected-owner-revoke", session })).result, { revoked: true });
  await assert.rejects(acquireLinuxRootWriterFence(join(directory, "workspace"), 150), /timed out|acquire.*fence/i);
  const exited = once(child, "exit"), closed = waitFor(child, value => value?.type === "closed");
  child.send({ type: "close" });
  await closed;
  assert.deepEqual(await exited, [0, null]);
  const fence = await acquireLinuxRootWriterFence(join(directory, "workspace"), 2000);
  await fence.release();
});
