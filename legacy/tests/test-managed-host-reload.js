"use strict";
const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { randomUUID } = require("node:crypto");
const dist = process.env.PKM_TEST_DIST || path.resolve("dist");
const { HostWriterAdmission } = require(path.join(dist, "runtime/host-writer-admission"));
const { drainManagedHost } = require(path.join(dist, "runtime/managed-host-drain"));
const { createManagedHostReload } = require(path.join(dist, "runtime/managed-host-reload"));

function fixture(t) {
  const base = path.resolve(".migration-test-work", `managed-host-reload-${randomUUID()}`);
  const root = path.join(base, "root"), profile = path.join(base, "profile");
  fs.mkdirSync(root, { recursive: true, mode: 0o700 });
  fs.mkdirSync(profile, { mode: 0o700 });
  t.after(() => fs.rmSync(base, { recursive: true, force: true }));
  const owner = new HostWriterAdmission(root, () => root);
  return { base, root, profile, owner };
}

test("user confirmation drains enrolled work before requesting reload", async t => {
  const { root, profile, owner } = fixture(t);
  let release, reloaded = false, finishConfirmation;
  const work = owner.observe("ui", () => new Promise(resolve => { release = resolve; }));
  const request = createManagedHostReload({
    root, profileStorage: profile, owner, isCurrent: () => true,
    confirm: selected => {
      assert.equal(selected, root);
      return new Promise(resolve => { finishConfirmation = resolve; });
    },
    drain: () => drainManagedHost(owner, async () => {}, undefined),
    reload: async () => { reloaded = true; },
  });
  const pending = request();
  await assert.rejects(request(), /already pending/);
  assert.equal(owner.status().state, "accepting");
  finishConfirmation(true);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(owner.status().state, "draining");
  assert.equal(reloaded, false);
  await assert.rejects(owner.observe("ui", () => {}), /closed/);
  release(); await work;
  assert.equal(await pending, "reload-requested");
  assert.equal(reloaded, true);
  assert.equal(owner.status().cutoverAuthorized, false);
});

test("cancelled or stale confirmation cannot drain or reload", async t => {
  const { base, root, profile, owner } = fixture(t);
  let current = true, drain = 0, reload = 0;
  const opts = {
    root, profileStorage: profile, owner, isCurrent: () => current,
    confirm: async () => false,
    drain: async () => { drain++; }, reload: async () => { reload++; },
  };
  assert.equal(await createManagedHostReload(opts)(), "cancelled");
  await assert.rejects(createManagedHostReload({ ...opts, confirm: async () => {
    current = false; return true;
  } })(), /changed during confirmation/);
  current = true;
  await assert.rejects(createManagedHostReload({ ...opts, confirm: async () => {
    fs.renameSync(profile, path.join(base, "old-profile"));
    fs.mkdirSync(profile);
    return true;
  } })(), /changed during confirmation/);
  assert.equal(drain, 0);
  assert.equal(reload, 0);
  assert.equal(owner.status().state, "accepting");
});

test("failed drain requests recovery reload but never reports a successful drain", async t => {
  const { root, profile, owner } = fixture(t);
  let observed, reload = 0;
  const opts = {
    root, profileStorage: profile, owner, isCurrent: () => true, confirm: async () => true,
    drain: async () => { throw new Error("Chat outcome unknown"); },
    onDrainError: error => { observed = error.message; },
    reload: async () => { reload++; },
  };
  assert.equal(await createManagedHostReload(opts)(), "reload-requested-drain-unknown");
  assert.equal(observed, "Chat outcome unknown");
  assert.equal(reload, 1);
  assert.equal(await createManagedHostReload({ ...opts, drain: async () => {} })(), "reload-requested-drain-unknown");
  assert.match(observed, /drain could not be verified/);
  await assert.rejects(createManagedHostReload({ ...opts, reload: async () => {
    throw new Error("unavailable");
  } })(), /reload failed.*manually/i);
});
