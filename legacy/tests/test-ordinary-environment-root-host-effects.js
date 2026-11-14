"use strict";
const { test } = require("node:test"), assert = require("node:assert/strict");
const fs = require("node:fs"), path = require("node:path"), { randomUUID, createHash } = require("node:crypto");
const build = process.env.PKM_ENV_AUTHORITY_BUILD;
assert(build && path.isAbsolute(build), "An explicit isolated source build is required.");
const supervisor = require(path.join(build, "runtime/linux-environment-supervisor.js"));
const { attachOrdinaryEnvironmentRootProfileWriter } = require(path.join(build, "runtime/ordinary-environment-root-host-effects.js"));
const { HostWriterAdmission } = require(path.join(build, "runtime/host-writer-admission.js"));
const managed = require(path.join(build, "runtime/managed-writer-session.js"));
const { pathToFileURL } = require("node:url");
const { execFileSync } = require("node:child_process");
const { mount } = require("./helpers/ordinary-environment-native-effects.cjs");
const { attachOrdinaryEnvironmentsToOwner } = require(path.join(build, "runtime/ordinary-environment-owner.js"));
const hash = value => createHash("sha256").update(value).digest("hex");

for (const fault of ["none", "nonce", "identity"]) test(`real old-profile/Root host Refresh transaction (${fault}); scoped lock cannot be forged or retained`, async t => {
  const base = path.resolve(".migration-test-work", `environment-root-host-control-${randomUUID()}`);
  const seed = path.resolve(".migration-test-work", `environment-root-host-old-${randomUUID()}`);
  const controlRoot = path.join(base, "control-root"), controlProfile = path.join(base, "control-profile");
  fs.mkdirSync(controlRoot, { recursive: true }); fs.mkdirSync(controlProfile);
  let mounted = "";
  let closeResources = async () => {};
  t.after(async () => {
    await closeResources();
    if (mounted) execFileSync("umount", ["--", mounted]);
    fs.rmSync(base, { recursive: true, force: true }); fs.rmSync(seed, { recursive: true, force: true });
  });

  const program = `require(${JSON.stringify(path.resolve("tests/helpers/ordinary-environment-profile-fixture.js"))})
    .prepare(${JSON.stringify(seed)}).then(({old,...receipt})=>console.log(JSON.stringify(receipt)))
    .catch(error=>{console.error(error);process.exitCode=1});`;
  const trace = {
    intent: { requestId: randomUUID(), workspaceId: randomUUID(), actorId: "local:owner",
      knowledgeRoot: controlRoot, globalStorageDirectory: controlProfile, operation: "packages", refresh: true, environments: [] },
    environmentId: "isolated-old-oracle", kind: "packages", program: process.execPath, args: ["-e", program],
    environment: { PATH: "/usr/bin:/bin", HOME: base, TMPDIR: base, PYTHONDONTWRITEBYTECODE: "1", PIP_NO_INDEX: "1" },
  };
  const prepared = supervisor.prepareLinuxEnvironmentQuery(trace, { python: "/usr/bin/python3", timeoutMs: 60_000, maxBuffer: 1_048_576 });
  const execution = supervisor.startPreparedLinuxEnvironmentQuery(prepared, supervisor.reservePreparedLinuxEnvironmentQuery(prepared));
  const original = JSON.parse(await execution.result);
  supervisor.assertPreparedLinuxEnvironmentDrainProof(supervisor.environmentDrainProof(execution.child, execution.trace), prepared);
  const storage = path.join(base, "copy-profile"), knowledgeRoot = path.join(base, "copy-knowledge");
  const originalRegistry = fs.readFileSync(original.registry), originalCache = fs.readFileSync(original.cache);
  fs.cpSync(original.storage, storage, { recursive: true });
  fs.cpSync(original.knowledgeRoot, knowledgeRoot, { recursive: true });
  const copiedRegistry = path.join(storage, "environments", "registry.json");
  assert.equal(hash(fs.readFileSync(copiedRegistry)), original.registrySha256);
  assert.deepEqual(fs.readFileSync(path.join(storage, "environments", `${original.id}.packages.json`)), originalCache);
  const rows = JSON.parse(originalRegistry);
  assert(rows.some(row => row.id === original.venvId && row.customReference.owner === "original-profile"));
  const venvCache = JSON.parse(fs.readFileSync(path.join(storage, "environments", `${original.venvId}.packages.json`), "utf8"));
  assert(venvCache.packages.some(pkg => pkg.name === "pip"), "The old oracle must execute real retained-prefix pip, not canned JSON.");
  fs.mkdirSync(path.join(knowledgeRoot, ".pkm", "state"), { recursive: true });
  const oldSession = process.env.PKM_MANAGED_WRITER_SESSION;
  const profileUri = pathToFileURL(storage).href;
  const registration = managed.bootstrapCompatibleManagedProfile(knowledgeRoot, hash(profileUri)).registration;
  process.env.PKM_MANAGED_WRITER_SESSION = registration.sessionId;
  t.after(() => {
    if (oldSession === undefined) delete process.env.PKM_MANAGED_WRITER_SESSION; else process.env.PKM_MANAGED_WRITER_SESSION = oldSession;
  });
  const hostAdmission = new HostWriterAdmission(knowledgeRoot, () => knowledgeRoot);
  let executionAuthorized = false;
  assert.throws(() => attachOrdinaryEnvironmentRootProfileWriter({
    binding: { workspaceId: randomUUID(), knowledgeRoot, globalStorageDirectory: storage },
    profileUri, scopeSignal: new AbortController().signal, registration, hostAdmission,
    supervisorPython: "/usr/bin/python3", environment: trace.environment,
    assertExecutionAuthority() { executionAuthorized = true; },
    registerRootChildClose() { throw Error("No unavailable grant may register resources."); },
    registerEnvironmentChildClose() { throw Error("No unavailable grant may register resources."); }, onCloseError() {},
  }), /Independent Environment profile writer authority/);
  assert.equal(executionAuthorized, false);
  assert.deepEqual(fs.readFileSync(original.registry), originalRegistry);
  assert.deepEqual(fs.readFileSync(original.cache), originalCache);
  assert.equal(hash(fs.readFileSync(copiedRegistry)), original.registrySha256);
  execFileSync("mount", ["-t", "tmpfs", "-o", "size=32m,mode=0700", "pkm-env-private-profile", storage]);
  mounted = storage;
  fs.cpSync(original.storage, storage, { recursive: true });
  const scope = new AbortController(), profileMount = mount(storage);
  const namespace = fs.readlinkSync("/proc/self/ns/mnt"), pidNamespace = fs.readlinkSync("/proc/self/ns/pid");
  const binding = { workspaceId: randomUUID(), knowledgeRoot, globalStorageDirectory: storage };
  const handle = managed.createManagedEnvironmentHostFence({ root: knowledgeRoot, profileStorage: storage, profileUri,
    registration, hostAdmission, scopeSignal: scope.signal });
  const current = () => managed.assertManagedEnvironmentHostFence(handle);
  const lock = path.join(knowledgeRoot, ".pkm", "state", "managed-writer-session.lock");
  let corrupted = false;
  const afterScope = [];
  const children = new Set(), register = close => {
    const wrapper = () => close(); children.add(wrapper); return () => children.delete(wrapper);
  };
  const writer = attachOrdinaryEnvironmentRootProfileWriter({
    binding, registration, hostAdmission, profileUri, scopeSignal: scope.signal,
    supervisorPython: "/usr/bin/python3",
    environment: { PATH: `${path.dirname(original.tool)}:${original.hostBin}:/usr/bin:/bin`, HOME: base, TMPDIR: base,
      PIP_CONFIG_FILE: "/dev/null", PIP_CACHE_DIR: path.join(base, "pip-cache") },
    profileWriter: {
      scope: "ordinary-environments:refresh-profile-writer",
      assertCurrent(expected) {
        assert.deepEqual(expected, binding);
        assert.equal(profileMount.type, "tmpfs"); assert(profileMount.options.includes("rw"));
        assert.deepEqual(mount(storage), profileMount);
        assert.equal(fs.readlinkSync("/proc/self/ns/mnt"), namespace);
        assert.equal(fs.readlinkSync("/proc/self/ns/pid"), pidNamespace);
        assert.equal(fs.realpathSync(storage), storage);
        if (fs.existsSync(lock)) {
          if (fault === "none") afterScope.push(Promise.resolve().then(() => {
            assert.throws(current, /current|ENOENT|lock/i, "A deferred callback cannot reuse the released Root completion-lock scope.");
          }));
          else if (!corrupted) {
            corrupted = true;
            const bytes = fs.readFileSync(lock);
            if (fault === "nonce") fs.writeFileSync(lock, JSON.stringify({ ...JSON.parse(bytes), nonce: randomUUID() }));
            else { fs.renameSync(lock, `${lock}.test-retained`); fs.writeFileSync(lock, bytes, { mode: 0o600 }); }
          }
        }
      },
    },
    assertExecutionAuthority(actual) {
      assert.equal(actual.environmentId, original.venvId);
      assert.equal(actual.program, rows.find(row => row.id === original.venvId).python);
      assert.deepEqual(actual.args, ["-m", "pip", "list", "--format=json"]);
      assert.equal(actual.launch.program, fs.realpathSync("/usr/bin/python3"));
    },
    registerRootChildClose: register, registerEnvironmentChildClose: register, onCloseError() {},
  });
  const owner = { workspaceId: binding.workspaceId, storage: { workspaceRoot: () => knowledgeRoot },
    assertCurrent: current, registerChildClose: register };
  const session = { workspaceId: binding.workspaceId, signal: handle.denySignal, assertCurrent: current,
    registerChildClose: (_scope, close) => register(close) };
  const read = { ...binding, actorId: "local:owner", scope: "ordinary-environments:read-cache",
    signal: handle.denySignal, assertCurrent: current };
  const adapter = attachOrdinaryEnvironmentsToOwner({ owner, hostSession: session, authority: read, onCloseError() {} });
  closeResources = async () => {
    try { await adapter.close(); } catch {}
    try { await writer.close(); } catch {}
  };
  const row = rows.find(row => row.id === original.venvId);
  const intent = { ...binding, actorId: "local:owner", requestId: randomUUID(), operation: "packages", refresh: true,
    environments: [{ id: row.id, path: row.path, python: row.python, manager: row.manager }] };
  const lifetime = { signal: new AbortController().signal, expiresAtMs: Date.now() + 30_000 };
  const effects = writer.acquireLegacyEffects(intent, lifetime);
  const request = adapter.handleMessage({ command: "envPackages", id: row.id, refresh: true },
    { ...effects, intent, expiresAtMs: lifetime.expiresAtMs });
  const operations = path.join(knowledgeRoot, ".pkm", "state", "managed-writer-session-compatible", "operations");
  if (fault !== "none") {
    await assert.rejects(request, /lock|current|unknown/i);
    assert.equal(corrupted, true);
    assert.equal(fs.readdirSync(operations).filter(file => file.endsWith(".complete")).length, 0);
    assert(fs.readdirSync(operations).filter(file => file.endsWith(".pending"))
      .some(file => JSON.parse(fs.readFileSync(path.join(operations, file), "utf8")).kind === "environment-refresh"));
    assert.equal(hash(fs.readFileSync(original.registry)), original.registrySha256);
    assert.deepEqual(fs.readFileSync(original.cache), originalCache);
    await adapter.close(); await assert.rejects(writer.close(), /UNKNOWN/);
    return;
  }
  const result = await request;
  await Promise.all(afterScope); assert(afterScope.length > 0);
  assert.equal(result.error, undefined); assert(result.packages.some(pkg => pkg.name === "pip"));
  const refreshed = JSON.parse(fs.readFileSync(path.join(storage, "environments", `${row.id}.packages.json`), "utf8"));
  assert.equal(refreshed.capturedAt, result.capturedAt);
  assert.notEqual(refreshed.capturedAt, venvCache.capturedAt);
  assert.equal(hash(fs.readFileSync(original.registry)), original.registrySha256);
  assert.deepEqual(fs.readFileSync(original.cache), originalCache);
  assert(fs.readdirSync(operations).filter(file => file.endsWith(".complete"))
    .map(file => JSON.parse(fs.readFileSync(path.join(operations, file), "utf8"))).some(record => record.kind === "environment-refresh"));
  await adapter.close(); await writer.close(); assert.equal(children.size, 0);
  await hostAdmission.drain();
  assert.equal(handle.denySignal.aborted, true, "Real Root host drain must synchronously revoke the projected scope.");
  assert.throws(current, /scope|current|closed|admission/i);
});

test("real remote session fence rejects new effects without pretending its notification is synchronous", async t => {
  const base = path.resolve(".migration-test-work", `environment-root-host-session-${randomUUID()}`);
  const root = path.join(base, "knowledge"), profile = path.join(base, "profile");
  fs.mkdirSync(path.join(root, ".pkm", "state"), { recursive: true }); fs.mkdirSync(profile);
  const oldSession = process.env.PKM_MANAGED_WRITER_SESSION;
  t.after(() => {
    if (oldSession === undefined) delete process.env.PKM_MANAGED_WRITER_SESSION; else process.env.PKM_MANAGED_WRITER_SESSION = oldSession;
    fs.rmSync(base, { recursive: true, force: true });
  });
  const profileUri = pathToFileURL(profile).href;
  const registration = managed.bootstrapCompatibleManagedProfile(root, hash(profileUri)).registration;
  process.env.PKM_MANAGED_WRITER_SESSION = registration.sessionId;
  const host = new HostWriterAdmission(root, () => root), scope = new AbortController();
  const handle = managed.createManagedEnvironmentHostFence({ root, profileStorage: profile, profileUri,
    registration, hostAdmission: host, scopeSignal: scope.signal });
  const options = {
    binding: { workspaceId: randomUUID(), knowledgeRoot: root, globalStorageDirectory: profile },
    profileUri, scopeSignal: scope.signal, registration, hostAdmission: host, supervisorPython: "/usr/bin/python3",
    environment: { PATH: "/usr/bin:/bin", HOME: base, TMPDIR: base },
    registerRootChildClose: () => () => {}, registerEnvironmentChildClose: () => () => {}, onCloseError() {},
    assertExecutionAuthority() { throw Error("A fenced host must not reach execution authorization."); },
  };
  assert.throws(() => attachOrdinaryEnvironmentRootProfileWriter({ ...options, registration: { ...registration } }), /actual local managed profile/);
  assert.throws(() => attachOrdinaryEnvironmentRootProfileWriter({ ...options, profileUri: pathToFileURL(base).href }), /actual local managed profile/);
  execFileSync(process.execPath, ["-e",
    `require(${JSON.stringify(path.join(build, "runtime/managed-writer-session.js"))}).closeManagedWriterAdmission(${JSON.stringify(root)},${JSON.stringify(registration.sessionId)});`],
  { env: { ...process.env, TMPDIR: base }, stdio: ["ignore", "pipe", "pipe"] });
  assert.equal(handle.denySignal.aborted, false, "Another process's session fence is discovered by assertion, not a fabricated synchronous signal.");
  assert.throws(() => managed.assertManagedEnvironmentHostFence(handle), /no longer accepting/);
  assert.throws(() => attachOrdinaryEnvironmentRootProfileWriter(options), /no longer accepting/);
  scope.abort();
  assert.equal(handle.denySignal.aborted, true);
});
