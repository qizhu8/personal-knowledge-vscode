"use strict";
const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { randomUUID } = require("node:crypto");

const dist = process.env.PKM_TEST_DIST || path.resolve("dist");
const { HostWriterAdmission } = require(path.join(dist, "runtime/host-writer-admission"));
const { createManagedHostChildRegistry, assertManagedHostChildRegistry } =
  require(path.join(dist, "runtime/managed-host-child-registry"));

function fixture(t) {
  const root = path.resolve(".migration-test-work", `managed-host-children-${randomUUID()}`);
  fs.mkdirSync(root, { recursive: true, mode: 0o700 });
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const host = new HostWriterAdmission(root, () => root);
  return { host, root };
}

test("host child barrier denies new work synchronously and awaits every enrolled child", async t => {
  const { host, root } = fixture(t);
  const registry = createManagedHostChildRegistry(root, host);
  assertManagedHostChildRegistry(registry, root, host);
  assert.throws(() => assertManagedHostChildRegistry({ ...registry }, root, host), /actual matching/);
  assert.throws(() => assertManagedHostChildRegistry(registry, root, new HostWriterAdmission(root, () => root)), /actual matching/);
  let release, closed = false;
  const waiting = new Promise(resolve => { release = resolve; });
  registry.register(async () => { await waiting; closed = true; });
  const closing = registry.close();
  assert.equal(registry.signal.aborted, true);
  assert.throws(() => assertManagedHostChildRegistry(registry, root, host), /closed/);
  assert.throws(() => registry.register(async () => {}), /closed/);
  await Promise.resolve();
  assert.equal(closed, false);
  release();
  await closing;
  assert.equal(closed, true);
  await registry.close();
});

test("failed or timed-out child closure is unknown and is never replayed", async t => {
  const { host, root } = fixture(t);
  for (const fail of [true, false]) {
    const registry = createManagedHostChildRegistry(root, host, 20);
    let attempts = 0, unregister;
    unregister = registry.register(async () => {
      attempts++;
      unregister();
      if (fail) throw new Error("unknown close");
      await new Promise(() => {});
    });
    const closing = registry.close();
    await assert.rejects(closing, /unknown close|timed out/);
    unregister();
    assert.equal(registry.close(), closing);
    await assert.rejects(registry.close(), /unknown close|timed out/);
    assert.equal(attempts, 1);
    assert.throws(() => registry.register(async () => {}), /closed/);
  }
});
