"use strict";
const { test } = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const { createLegacyMcpProviderOwner } = require(path.join(process.env.PKM_TEST_DIST || path.resolve("dist"), "runtime/legacy-mcp-provider-owner"));

function broker() {
  let state = "accepting";
  return {
    status: () => ({ state, connection: null, cutoverAuthorized: false }),
    definitionEnvironment: () => ({ token: "fixture" }),
    async drainLegacyAndClose(approve) {
      if (!await approve(new AbortController().signal)) return { state: "declined", cutoverAuthorized: false };
      state = "stopped";
      return { state: "drained-and-stopped", cutoverAuthorized: false };
    },
    dispose() { state = "unknown"; },
  };
}

test("expired provider handles cannot retire a restarted connection", async () => {
  const first = broker(), second = broker(), queue = [first, second];
  const owner = await createLegacyMcpProviderOwner(async () => queue.shift());
  const initial = owner.status().id;
  assert.equal((await owner.retire(initial, async () => false)).state, "declined");
  await assert.rejects(owner.restart(initial), /verified stopped/);
  assert.equal((await owner.retire(initial, async () => true)).state, "drained-and-stopped");
  const successor = await owner.restart(initial);
  let approved = false;
  await assert.rejects(owner.retire(initial, async () => { approved = true; return true; }), /stale/);
  assert.equal(approved, false);
  assert.equal(owner.status().id, successor);
  assert.equal(second.status().state, "accepting");
  owner.dispose();
});

test("a replacement created after disposal is never published", async () => {
  const next = broker();
  let release;
  const delayedOwner = await createLegacyMcpProviderOwner((() => {
    let count = 0;
    return () => ++count === 1 ? Promise.resolve(broker()) : new Promise(resolve => { release = resolve; });
  })());
  const id = delayedOwner.status().id;
  await delayedOwner.retire(id, async () => true);
  const restart = delayedOwner.restart(id);
  delayedOwner.dispose();
  release(next);
  await assert.rejects(restart, /changed during restart/);
  assert.equal(next.status().state, "unknown");
});

test("pending approval cannot be raced by another retirement or restart", async () => {
  const owner = await createLegacyMcpProviderOwner(async () => broker());
  const id = owner.status().id;
  let release;
  const retirement = owner.retire(id, () => new Promise(resolve => { release = resolve; }));
  await assert.rejects(owner.retire(id, async () => true), /already in progress/);
  await assert.rejects(owner.restart(id), /verified stopped/);
  release(false);
  assert.equal((await retirement).state, "declined");
  assert.equal(owner.status().state, "accepting");
  owner.dispose();
});

test("sealing a stopped incarnation prevents a successor during host shutdown", async () => {
  const owner = await createLegacyMcpProviderOwner(async () => broker());
  const id = owner.status().id;
  assert.throws(() => owner.seal(id), /verified stopped/);
  assert.equal((await owner.retire(id, async () => true)).state, "drained-and-stopped");
  owner.seal(id);
  await assert.rejects(owner.restart(id), /sealed/);
  owner.dispose();
});

test("a stale incarnation cannot seal a live successor", async () => {
  const owner = await createLegacyMcpProviderOwner(async () => broker());
  const old = owner.status().id;
  await owner.retire(old, async () => true);
  const current = await owner.restart(old);
  assert.throws(() => owner.seal(old), /stale/);
  assert.equal(owner.status().id, current);
  assert.equal(owner.status().state, "accepting");
  owner.dispose();
});
