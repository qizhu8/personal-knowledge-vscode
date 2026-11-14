"use strict";
const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { randomUUID, createHash } = require("node:crypto");
const { pathToFileURL } = require("node:url");
const dist = process.env.PKM_TEST_DIST || path.resolve("dist");
const session = require(path.join(dist, "runtime/managed-writer-session"));
const { HostWriterAdmission } = require(path.join(dist, "runtime/host-writer-admission"));

test("managed Environment host fence binds actual registration and synchronously denies on host drain", async t => {
  const base = path.resolve(".migration-test-work", `managed-env-host-${randomUUID()}`);
  const root = path.join(base, "root"), profile = path.join(base, "profile");
  fs.mkdirSync(root, { recursive: true }); fs.mkdirSync(profile, { recursive: true });
  const id = randomUUID(), old = process.env.PKM_MANAGED_WRITER_SESSION;
  t.after(() => { if (old === undefined) delete process.env.PKM_MANAGED_WRITER_SESSION; else process.env.PKM_MANAGED_WRITER_SESSION = old; });
  session.provisionManagedWriterSession(root, id);
  process.env.PKM_MANAGED_WRITER_SESSION = id;
  const uri = pathToFileURL(profile).toString();
  const registration = session.registerManagedProfile(root, id, createHash("sha256").update(uri).digest("hex"));
  const owner = new HostWriterAdmission(root, () => root), scope = new AbortController();
  const options = { root, profileStorage: profile, profileUri: uri, registration, hostAdmission: owner, scopeSignal: scope.signal };
  const fence = session.createManagedEnvironmentHostFence(options);
  session.assertManagedEnvironmentHostFence(fence);
  assert.throws(() => session.assertManagedEnvironmentHostFence({ ...fence }), /real managed Environment/);
  assert.throws(() => session.createManagedEnvironmentHostFence({ ...options, registration: { ...registration } }), /actual local managed profile/);
  assert.throws(() => session.createManagedEnvironmentHostFence({ ...options, profileUri: pathToFileURL(root).toString() }), /actual local managed profile/);
  const otherRoot = path.join(base, "other-root"); fs.mkdirSync(otherRoot);
  assert.throws(() => session.createManagedEnvironmentHostFence({ ...options,
    hostAdmission: new HostWriterAdmission(otherRoot, () => otherRoot) }), /not current/);
  const drain = owner.drain();
  assert.equal(fence.denySignal.aborted, true);
  assert.throws(() => session.assertManagedEnvironmentHostFence(fence));
  await drain;
});

test("managed Environment host fence rejects a remotely fenced session and revoked scope", async t => {
  const base = path.resolve(".migration-test-work", `managed-env-deny-${randomUUID()}`);
  const root = path.join(base, "root"), profile = path.join(base, "profile");
  fs.mkdirSync(root, { recursive: true }); fs.mkdirSync(profile, { recursive: true });
  const id = randomUUID(), old = process.env.PKM_MANAGED_WRITER_SESSION;
  t.after(() => { if (old === undefined) delete process.env.PKM_MANAGED_WRITER_SESSION; else process.env.PKM_MANAGED_WRITER_SESSION = old; });
  session.provisionManagedWriterSession(root, id); process.env.PKM_MANAGED_WRITER_SESSION = id;
  const uri = pathToFileURL(profile).toString();
  const registration = session.registerManagedProfile(root, id, createHash("sha256").update(uri).digest("hex"));
  const owner = new HostWriterAdmission(root, () => root), scope = new AbortController();
  const options = { root, profileStorage: profile, profileUri: uri, registration, hostAdmission: owner, scopeSignal: scope.signal };
  const first = session.createManagedEnvironmentHostFence(options), second = session.createManagedEnvironmentHostFence(options);
  scope.abort();
  assert.equal(first.denySignal.aborted, true);
  assert.throws(() => session.assertManagedEnvironmentHostFence(first));
  const live = session.createManagedEnvironmentHostFence({ ...options, scopeSignal: new AbortController().signal });
  session.closeManagedWriterAdmission(root, id);
  assert.throws(() => session.assertManagedEnvironmentHostFence(live), /no longer accepting/);
  assert.throws(() => session.assertManagedEnvironmentHostFence(second));
});

test("managed Environment host fence rejects profile replacement", t => {
  const base = path.resolve(".migration-test-work", `managed-env-profile-${randomUUID()}`);
  const root = path.join(base, "root"), profile = path.join(base, "profile");
  fs.mkdirSync(root, { recursive: true }); fs.mkdirSync(profile, { recursive: true });
  const id = randomUUID(), old = process.env.PKM_MANAGED_WRITER_SESSION;
  t.after(() => { if (old === undefined) delete process.env.PKM_MANAGED_WRITER_SESSION; else process.env.PKM_MANAGED_WRITER_SESSION = old; });
  session.provisionManagedWriterSession(root, id); process.env.PKM_MANAGED_WRITER_SESSION = id;
  const uri = pathToFileURL(profile).toString();
  const registration = session.registerManagedProfile(root, id, createHash("sha256").update(uri).digest("hex"));
  const fence = session.createManagedEnvironmentHostFence({ root, profileStorage: profile, profileUri: uri, registration,
    hostAdmission: new HostWriterAdmission(root, () => root), scopeSignal: new AbortController().signal });
  fs.renameSync(profile, path.join(base, "old-profile")); fs.mkdirSync(profile);
  assert.throws(() => session.assertManagedEnvironmentHostFence(fence), /binding is no longer current/);
});

test("managed Environment host fence cannot reuse a registration after Root replacement", t => {
  const base = path.resolve(".migration-test-work", `managed-env-root-${randomUUID()}`);
  const root = path.join(base, "root"), profile = path.join(base, "profile");
  fs.mkdirSync(root, { recursive: true }); fs.mkdirSync(profile, { recursive: true });
  const id = randomUUID(), old = process.env.PKM_MANAGED_WRITER_SESSION;
  t.after(() => { if (old === undefined) delete process.env.PKM_MANAGED_WRITER_SESSION; else process.env.PKM_MANAGED_WRITER_SESSION = old; });
  session.provisionManagedWriterSession(root, id); process.env.PKM_MANAGED_WRITER_SESSION = id;
  const uri = pathToFileURL(profile).toString();
  const registration = session.registerManagedProfile(root, id, createHash("sha256").update(uri).digest("hex"));
  const previous = path.join(base, "previous-root");
  fs.renameSync(root, previous); fs.cpSync(previous, root, { recursive: true });
  assert.throws(() => session.createManagedEnvironmentHostFence({ root, profileStorage: profile, profileUri: uri, registration,
    hostAdmission: new HostWriterAdmission(root, () => root), scopeSignal: new AbortController().signal }), /actual local managed profile/);
});
