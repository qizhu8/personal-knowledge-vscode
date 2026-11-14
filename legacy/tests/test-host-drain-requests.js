"use strict";
const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { randomUUID } = require("node:crypto");
const dist = process.env.PKM_TEST_DIST || path.resolve("dist");
const { HostDrainRequests, hostDrainRootFingerprint } = require(path.join(dist, "runtime/host-drain-requests"));
const { HostWriterAdmission } = require(path.join(dist, "runtime/host-writer-admission"));
const { createManagedHostReload } = require(path.join(dist, "runtime/managed-host-reload"));
const { drainManagedHost } = require(path.join(dist, "runtime/managed-host-drain"));

function fixture(t) {
  const base = path.resolve(".migration-test-work", `host-drain-requests-${randomUUID()}`);
  const root = path.join(base, "root"), profile = path.join(base, "profile"), directory = path.join(base, "registry");
  for (const dir of [root, profile, directory]) fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  t.after(() => fs.rmSync(base, { recursive: true, force: true }));
  return { base, root, profile, directory };
}

test("routed requests are not consent: each host confirms and drains independently", async t => {
  const { root, profile, directory } = fixture(t);
  const ids = [randomUUID(), randomUUID()], digest = hostDrainRootFingerprint(root);
  const routers = ids.map(id => new HostDrainRequests(directory, id));
  const owners = ids.map(() => new HostWriterAdmission(root, () => root));
  let release, reloaded = 0;
  const work = owners[0].observe("ui", () => new Promise(resolve => { release = resolve; }));
  const reload = (index, confirm) => createManagedHostReload({
    root, profileStorage: profile, owner: owners[index], isCurrent: () => true,
    confirm: async () => confirm, drain: () => drainManagedHost(owners[index], async () => {}, undefined),
    reload: async () => { reloaded++; },
  });
  routers[0].request(digest, ids);
  assert.equal(routers[0].poll(digest), true);
  assert.equal(routers[1].poll(digest), true);
  assert.equal(owners[0].status().state, "accepting");
  assert.equal(await reload(1, false)(), "cancelled");
  assert.equal(owners[1].status().state, "accepting");
  const pending = reload(0, true)();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(owners[0].status().state, "draining");
  assert.equal(reloaded, 0);
  release(); await work;
  assert.equal(await pending, "reload-requested");
  assert.equal(reloaded, 1);
  assert.equal(owners[0].status().cutoverAuthorized, false);
  assert.equal(routers[0].poll(digest), false);
});

test("requests are bounded to root identity, target, age and live host", t => {
  const { base, root, directory } = fixture(t);
  let now = 100_000;
  const id = randomUUID(), router = new HostDrainRequests(directory, id, () => now);
  const other = new HostDrainRequests(directory, randomUUID(), () => now);
  const digest = hostDrainRootFingerprint(root);
  router.request(digest, [id]);
  assert.equal(other.poll(digest), false);
  fs.renameSync(root, path.join(base, "old-root")); fs.mkdirSync(root);
  assert.notEqual(hostDrainRootFingerprint(root), digest);
  assert.equal(router.poll(hostDrainRootFingerprint(root)), false);
  now += 60_001;
  assert.equal(router.poll(digest), false);
  router.request(digest, [id]);
  const request = fs.readFileSync(path.join(directory, "managed-drain-request.json"));
  assert.equal(router.poll(digest), true);
  router.request(digest, [id]);
  assert.equal(router.poll(digest), true);
  fs.writeFileSync(path.join(directory, "managed-drain-request.json"), request);
  assert.equal(router.poll(digest), false);
  assert.equal(new HostDrainRequests(directory, randomUUID(), () => now).poll(digest), false);
});

test("symlinked request file and registry do not provide a routing channel", t => {
  const { base, root, directory } = fixture(t);
  const router = new HostDrainRequests(directory, randomUUID());
  const target = path.join(base, "target");
  fs.writeFileSync(target, "{}");
  fs.symlinkSync(target, path.join(directory, "managed-drain-request.json"));
  assert.throws(() => router.poll(hostDrainRootFingerprint(root)), /ELOOP/);
  const link = path.join(base, "link");
  fs.symlinkSync(directory, link);
  assert.throws(() => new HostDrainRequests(link, randomUUID()).request(hostDrainRootFingerprint(root), [randomUUID()]),
    /directory is unavailable/);
});

test("managed requests match the exact session and registered host operation", t => {
  const { root, directory } = fixture(t);
  const hostId = randomUUID(), sessionId = randomUUID(), operationId = randomUUID();
  const router = new HostDrainRequests(directory, hostId), digest = hostDrainRootFingerprint(root);
  router.request(digest, [hostId], { sessionId, operationIds: [operationId] });
  assert.equal(router.poll(digest), false);
  assert.equal(router.poll(digest, { sessionId: randomUUID(), operationId }), false);
  assert.equal(router.poll(digest, { sessionId, operationId: randomUUID() }), false);
  assert.equal(router.poll(digest, { sessionId, operationId }), true);
  assert.equal(router.poll(digest, { sessionId, operationId }), false);
});
