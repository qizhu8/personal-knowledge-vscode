"use strict";
const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { randomUUID, createHash } = require("node:crypto");

const dist = process.env.PKM_TEST_DIST || path.resolve("dist");
const session = require(path.join(dist, "runtime/managed-writer-session"));
const { activateManagedProfileWriter } = require(path.join(dist, "runtime/managed-profile-activation"));
const { HostWriterAdmission } = require(path.join(dist, "runtime/host-writer-admission"));

test("an unbound host cannot confirm a drain or turn a completed record into confirmation", async t => {
  const root = path.resolve(".migration-test-work", `managed-unbound-confirmation-${randomUUID()}`);
  const storage = path.join(root, "profile"), id = randomUUID();
  fs.mkdirSync(storage, { recursive: true, mode: 0o700 });
  const original = process.env.PKM_MANAGED_WRITER_SESSION;
  t.after(() => {
    if (original === undefined) delete process.env.PKM_MANAGED_WRITER_SESSION;
    else process.env.PKM_MANAGED_WRITER_SESSION = original;
    fs.rmSync(root, { recursive: true, force: true });
  });
  session.provisionManagedWriterSession(root, id);
  process.env.PKM_MANAGED_WRITER_SESSION = id;
  const registration = session.registerManagedProfile(root, id, createHash("sha256").update("unbound").digest("hex"));
  const profile = activateManagedProfileWriter(root, id, async () => {}, 30_000, () => true,
    registration.profileId, undefined, registration);
  t.after(() => profile.dispose());
  await assert.rejects(profile.confirmLocalDrain(storage, async () => true), /not available/);
  session.completeManagedProfile(root, registration);
  assert.throws(() => session.recordConfirmedManagedProfile(root, storage, registration), /bound managed host admission/);
});

test("registered hosts separately confirm and publish only their own completed drain", async t => {
  const base = path.resolve(".migration-test-work", `managed-confirmed-drain-${randomUUID()}`);
  const root = path.join(base, "root"), id = randomUUID();
  fs.mkdirSync(root, { recursive: true, mode: 0o700 });
  const firstStorage = path.join(base, "profile-a"), secondStorage = path.join(base, "profile-b");
  fs.mkdirSync(firstStorage, { mode: 0o700 }); fs.mkdirSync(secondStorage, { mode: 0o700 });
  const original = process.env.PKM_MANAGED_WRITER_SESSION;
  const profiles = [];
  t.after(() => {
    for (const profile of profiles) profile.dispose();
    if (original === undefined) delete process.env.PKM_MANAGED_WRITER_SESSION;
    else process.env.PKM_MANAGED_WRITER_SESSION = original;
  });
  session.provisionManagedWriterSession(root, id);
  process.env.PKM_MANAGED_WRITER_SESSION = id;
  let release;
  const waiting = new Promise(resolve => { release = resolve; });
  const firstId = createHash("sha256").update("profile-a").digest("hex");
  const secondId = createHash("sha256").update("profile-b").digest("hex");
  const firstOwner = new HostWriterAdmission(root, () => root), secondOwner = new HostWriterAdmission(root, () => root);
  const first = activateManagedProfileWriter(root, id, async () => { await waiting; await firstOwner.drain(); },
    30_000, () => true, firstId, undefined, undefined, firstOwner);
  const second = activateManagedProfileWriter(root, id, () => secondOwner.drain(),
    30_000, () => true, secondId, undefined, undefined, secondOwner);
  profiles.push(first, second);
  assert.equal(await second.confirmLocalDrain(secondStorage, async () => false), "cancelled");
  assert.equal(second.status().state, "accepting");
  const drain = first.confirmLocalDrain(firstStorage, async () => true);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(first.status().state, "draining");
  assert.deepEqual(first.discover().map(value => value.state), ["registered-unverified", "registered-unverified"]);
  release();
  assert.equal(await drain, "drained");
  assert.deepEqual(first.discover().map(value => value.state).sort(), ["drained", "registered-unverified"]);
  assert.equal(session.managedWriterAdmissionState(root, id), "accepting");
  assert.equal(first.status().cutoverAuthorized, false);
  const registrations = first.discover().map(value => value.hostId);
  assert.throws(() => session.sealConfirmedManagedProfiles(root, id, registrations));
  assert.equal(session.managedWriterAdmissionState(root, id), "accepting");
  assert.equal(await second.confirmLocalDrain(secondStorage, async () => true), "drained");
  assert.deepEqual(first.discover().map(value => value.state), ["drained", "drained"]);
  const result = session.sealConfirmedManagedProfiles(root, id, registrations);
  assert.equal(result.cutoverAuthorized, false);
  assert.equal(result.preexistingAndExternalWriters, "unknown");
  assert.throws(() => session.sealConfirmedManagedProfiles(root, id, registrations), /already fenced/);
});

test("binding changes during confirmation never start a registered drain", async t => {
  const root = path.resolve(".migration-test-work", `managed-confirmed-change-${randomUUID()}`);
  fs.mkdirSync(root, { recursive: true, mode: 0o700 });
  const profileStorage = path.join(root, "profile");
  fs.mkdirSync(profileStorage, { mode: 0o700 });
  const original = process.env.PKM_MANAGED_WRITER_SESSION, id = randomUUID();
  session.provisionManagedWriterSession(root, id);
  process.env.PKM_MANAGED_WRITER_SESSION = id;
  let current = true, drained = false;
  const owner = new HostWriterAdmission(root, () => root);
  const profile = activateManagedProfileWriter(root, id, async () => { drained = true; }, 30_000,
    () => current, createHash("sha256").update("profile").digest("hex"), undefined, undefined, owner);
  t.after(() => {
    profile.dispose();
    if (original === undefined) delete process.env.PKM_MANAGED_WRITER_SESSION;
    else process.env.PKM_MANAGED_WRITER_SESSION = original;
  });
  await assert.rejects(profile.confirmLocalDrain(profileStorage, async () => { current = false; return true; }), /changed during confirmation/);
  assert.equal(drained, false);
  assert.equal(session.discoverManagedProfiles(root, id)[0].state, "registered-unverified");
});

test("revoked confirmation and a newly enrolled host cannot seal a session", async t => {
  const base = path.resolve(".migration-test-work", `managed-confirmed-race-${randomUUID()}`);
  const root = path.join(base, "root"), storage = path.join(base, "profile"), id = randomUUID();
  fs.mkdirSync(root, { recursive: true, mode: 0o700 });
  fs.mkdirSync(storage, { mode: 0o700 });
  const original = process.env.PKM_MANAGED_WRITER_SESSION;
  session.provisionManagedWriterSession(root, id);
  process.env.PKM_MANAGED_WRITER_SESSION = id;
  let release, current = true;
  const waiting = new Promise(resolve => { release = resolve; });
  const owner = new HostWriterAdmission(root, () => root);
  const first = activateManagedProfileWriter(root, id, async () => { await waiting; await owner.drain(); }, 30_000, () => true,
    createHash("sha256").update("profile-a").digest("hex"), undefined, undefined, owner);
  t.after(() => {
    release();
    first.dispose();
    if (original === undefined) delete process.env.PKM_MANAGED_WRITER_SESSION;
    else process.env.PKM_MANAGED_WRITER_SESSION = original;
  });
  const operationIds = first.discover().map(value => value.hostId);
  const drain = first.confirmLocalDrain(storage, async () => true, () => current);
  await new Promise(resolve => setImmediate(resolve));
  current = false;
  release();
  await assert.rejects(drain, /confirmation remains unknown/);
  assert.throws(() => session.sealConfirmedManagedProfiles(root, id, operationIds));
  assert.equal(session.managedWriterAdmissionState(root, id), "accepting");
  session.registerManagedProfile(root, id, createHash("sha256").update("profile-b").digest("hex"));
  assert.throws(() => session.sealConfirmedManagedProfiles(root, id, operationIds), /registration set changed/);
  assert.equal(session.managedWriterAdmissionState(root, id), "accepting");
});

test("failed host drain remains unknown and is not replayed", async t => {
  const base = path.resolve(".migration-test-work", `managed-confirmed-failure-${randomUUID()}`);
  const root = path.join(base, "root"), storage = path.join(base, "profile"), id = randomUUID();
  fs.mkdirSync(root, { recursive: true, mode: 0o700 });
  fs.mkdirSync(storage, { mode: 0o700 });
  const original = process.env.PKM_MANAGED_WRITER_SESSION;
  session.provisionManagedWriterSession(root, id);
  process.env.PKM_MANAGED_WRITER_SESSION = id;
  let calls = 0;
  const owner = new HostWriterAdmission(root, () => root);
  const profile = activateManagedProfileWriter(root, id, async () => { calls++; throw new Error("drain failed"); },
    30_000, () => true, createHash("sha256").update("profile").digest("hex"), undefined, undefined, owner);
  t.after(() => {
    profile.dispose();
    if (original === undefined) delete process.env.PKM_MANAGED_WRITER_SESSION;
    else process.env.PKM_MANAGED_WRITER_SESSION = original;
  });
  await assert.rejects(profile.confirmLocalDrain(storage, async () => true), /drain failed/);
  assert.equal(profile.status().state, "unknown");
  await assert.rejects(profile.confirmLocalDrain(storage, async () => true), /not available/);
  assert.equal(calls, 1);
  assert.throws(() => session.sealConfirmedManagedProfiles(root, id, profile.discover().map(value => value.hostId)));
});
