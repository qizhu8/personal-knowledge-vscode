"use strict";
const { test } = require("node:test"), assert = require("node:assert/strict");
const fs = require("node:fs"), path = require("node:path"), Module = require("node:module");
const { execFileSync } = require("node:child_process");
const { randomUUID, createHash } = require("node:crypto"), { pathToFileURL } = require("node:url");
const build = process.env.PKM_ENV_AUTHORITY_BUILD;
assert(build && path.isAbsolute(build), "An explicit isolated emitted source build is required.");
const { LegacyEnvironmentDispatch } = require(path.join(build, "runtime/ordinary-environment-legacy-dispatch.js"));
const { createNativeLegacyEnvironmentScope } = require(path.join(build, "runtime/ordinary-environment-native-scope.js"));
const { createManagedHostChildRegistry } = require(path.join(build, "runtime/managed-host-child-registry.js"));
const { HostWriterAdmission } = require(path.join(build, "runtime/host-writer-admission.js"));
const managed = require(path.join(build, "runtime/managed-writer-session.js"));
const supervisor = require(path.join(build, "runtime/linux-environment-supervisor.js"));
const hash = bytes => createHash("sha256").update(bytes).digest("hex");
let currentRoot = "";
const authorityPath = path.join(build, "runtime/ordinary-environment-vscode-authority.js");
const load = Module._load;
Module._load = function (name, parent, main) {
  if (parent?.filename === authorityPath && name === "vscode")
    return { workspace: { isTrusted: true,
      onDidChangeWorkspaceFolders: () => ({ dispose() {} }), onDidChangeConfiguration: () => ({ dispose() {} }) },
    window: { showWarningMessage: async (_message, _options, answer) => answer } };
  if (parent?.filename === authorityPath && name === "../knowledge/filestore") return { getStorePath: () => currentRoot };
  return load.call(this, name, parent, main);
};
const native = require(authorityPath);
const { startOrdinaryEnvironmentVscodeHost } = require(path.join(build, "runtime/ordinary-environment-vscode-host.js"));
Module._load = load;

async function fixture(t, original) {
  const base = path.resolve(".migration-test-work", `environment-native-scope-${randomUUID()}`);
  const seed = path.resolve(".migration-test-work", `environment-native-old-${randomUUID()}`);
  fs.mkdirSync(base);
  let scope, ui;
  const session = process.env.PKM_MANAGED_WRITER_SESSION;
  t.after(async () => {
    for (const subscription of context.subscriptions) subscription.dispose();
    try { await ui?.close(); } catch {}
    try { await scope?.close(); } catch {}
    if (session === undefined) delete process.env.PKM_MANAGED_WRITER_SESSION; else process.env.PKM_MANAGED_WRITER_SESSION = session;
    fs.rmSync(base, { recursive: true, force: true });
    fs.rmSync(seed, { recursive: true, force: true });
  });
  let root = path.join(base, "knowledge"), profile = path.join(base, "profile");
  let context = { globalStorageUri: { fsPath: profile }, subscriptions: [] };
  fs.mkdirSync(root); fs.mkdirSync(profile);
  let receipt;
  if (original) {
    const program = `require(${JSON.stringify(path.resolve("tests/helpers/ordinary-environment-profile-fixture.js"))})
      .prepare(${JSON.stringify(seed)}).then(({old,...receipt})=>console.log(JSON.stringify(receipt)))
      .catch(error=>{console.error(error);process.exitCode=1});`;
    const trace = { intent: { requestId: randomUUID(), workspaceId: randomUUID(), actorId: "local:owner",
      knowledgeRoot: root, globalStorageDirectory: profile, operation: "packages", refresh: true, environments: [] },
    environmentId: "old-oracle", kind: "packages", program: process.execPath, args: ["-e", program],
    environment: { PATH: "/usr/bin:/bin", HOME: base, TMPDIR: base, PYTHONDONTWRITEBYTECODE: "1", PIP_NO_INDEX: "1" } };
    const prepared = supervisor.prepareLinuxEnvironmentQuery(trace, { python: "/usr/bin/python3", timeoutMs: 60000, maxBuffer: 1048576 });
    const execution = supervisor.startPreparedLinuxEnvironmentQuery(prepared, supervisor.reservePreparedLinuxEnvironmentQuery(prepared));
    receipt = JSON.parse(await execution.result);
    supervisor.assertPreparedLinuxEnvironmentDrainProof(supervisor.environmentDrainProof(execution.child, execution.trace), prepared);
    root = receipt.knowledgeRoot; profile = receipt.storage;
    context = { globalStorageUri: { fsPath: profile }, subscriptions: [] };
  } else fs.mkdirSync(path.join(profile, "environments"));
  fs.mkdirSync(path.join(root, ".pkm", "state"), { recursive: true });
  currentRoot = root;
  const uri = pathToFileURL(profile).href;
  const registration = managed.bootstrapCompatibleManagedProfile(root, hash(uri)).registration;
  process.env.PKM_MANAGED_WRITER_SESSION = registration.sessionId;
  const host = new HostWriterAdmission(root, () => currentRoot);
  const parent = createManagedHostChildRegistry(root, host, 1000);
  const gate = new LegacyEnvironmentDispatch({ knowledgeRoot: root, globalStorageDirectory: profile });
  const pause = await gate.pauseLegacy(), errors = [];
  const inputs = { knowledgeRoot: root, globalStorageDirectory: profile, profileUri: uri,
    registration, hostAdmission: host, rootChildren: parent, dispatchPause: pause,
    supervisorPython: fs.realpathSync("/usr/bin/python3"), home: base, temporaryDirectory: base,
    onCloseError: error => errors.push(error) };
  scope = createNativeLegacyEnvironmentScope(inputs);
  return { root, profile, receipt, context, host, parent, gate, scope, errors, registration, inputs,
    async start() {
      ui = await startOrdinaryEnvironmentVscodeHost({ context, owner: scope.owner, hostSession: scope.hostSession,
        sessionId: registration.sessionId, assertHostCurrent() { scope.assertCurrent(); },
        acquireEffects: scope.acquireEffects, onCloseError: error => errors.push(error) });
      return ui;
    } };
}

test("source dispatch pause waits enrolled nested reads and cannot certify old unmanaged effects", async () => {
  const binding = { knowledgeRoot: "/controlled/root", globalStorageDirectory: "/controlled/profile" };
  const gate = new LegacyEnvironmentDispatch(binding);
  let release;
  const work = gate.observe("read", () => gate.observe("read", () => new Promise(resolve => { release = resolve; })));
  let paused = false;
  const pause = gate.pauseLegacy().then(value => { paused = true; return value; });
  await new Promise(resolve => setImmediate(resolve)); assert.equal(paused, false);
  await assert.rejects(gate.observe("read", () => {}), /closed/);
  release(); await work; const cap = await pause;
  gate.assertPaused(cap); assert.throws(() => gate.assertPaused({ ...cap }), /not current/);
  gate.resume(cap);
  await gate.observe("effect", () => {});
  await assert.rejects(gate.pauseLegacy(), /physical family-drain/);
  await assert.rejects(gate.observe("read", () => {}), /closed/);
});

test("actual source legacy scope uses separate Root and Environment child barriers; unapproved intent cannot mint kernel writer", async t => {
  const f = await fixture(t);
  assert.throws(() => createNativeLegacyEnvironmentScope({ ...f.inputs, rootChildren: { ...f.parent } }), /registry|actual|issued/i);
  let rootClosed = 0, environmentClosed = 0;
  f.scope.owner.registerChildClose(async () => { rootClosed++; });
  f.scope.hostSession.registerChildClose("environment", async () => { environmentClosed++; });
  await assert.rejects(f.scope.acquireEffects({ workspaceId: f.scope.owner.workspaceId,
    knowledgeRoot: f.root, globalStorageDirectory: f.profile }, { signal: new AbortController().signal, expiresAtMs: Date.now() + 1000 }),
  /exact independently approved/);
  assert.equal(fs.existsSync(path.join(f.profile, "environments/.native-environment-writer.lock")), false);
  await f.parent.close();
  assert.equal(rootClosed, 1); assert.equal(environmentClosed, 1);
  assert.equal(f.scope.signal.aborted, true); assert.throws(f.scope.assertCurrent, /not current/);
});

test("source child UNKNOWN is retained by actual Root registry; neither scope nor legacy dispatch reopens", async t => {
  const f = await fixture(t);
  f.scope.hostSession.registerChildClose("environment", async () => { throw Error("controlled child UNKNOWN"); });
  await assert.rejects(f.parent.close(), /UNKNOWN/);
  await assert.rejects(f.parent.close(), /UNKNOWN/);
  await assert.rejects(f.scope.close(), /UNKNOWN/);
  assert.throws(f.scope.assertCurrent, /not current/);
  await assert.rejects(f.gate.observe("read", () => {}), /closed/);
});

test("offline source runtime with native-dialog API mocks: actual shipped old profile Refresh consumes source owner, kernel flock and real Root completion", async t => {
  const f = await fixture(t, true), registry = fs.readFileSync(f.receipt.registry);
  const cache = path.join(f.profile, "environments", `${f.receipt.venvId}.packages.json`);
  const original = JSON.parse(fs.readFileSync(cache, "utf8"));
  const ui = await f.start();
  const result = await ui.handleMessage({ command: "envPackages", id: f.receipt.venvId, refresh: true });
  assert.equal(result.error, undefined); assert(result.packages.some(row => row.name === "pip"));
  assert.notEqual(result.capturedAt, original.capturedAt);
  assert.deepEqual(fs.readFileSync(f.receipt.registry), registry);
  const operations = path.join(f.root, ".pkm/state/managed-writer-session-compatible/operations");
  assert(fs.readdirSync(operations).filter(name => name.endsWith(".complete"))
    .some(name => JSON.parse(fs.readFileSync(path.join(operations, name), "utf8")).kind === "environment-refresh"));
  const filename = path.join(f.profile, "environments/.native-environment-writer.lock");
  const rows = JSON.parse(fs.readFileSync(f.receipt.registry, "utf8")), entry = rows.find(row => row.id === f.receipt.venvId);
  const host = { knowledgeRoot: f.root, workspaceId: f.scope.owner.workspaceId, sessionId: f.registration.sessionId,
    signal: f.scope.signal, assertCurrent() { f.scope.assertCurrent(); } };
  const approval = await native.requestOrdinaryEnvironmentRefreshIntent(f.context, { host,
    intent: { workspaceId: host.workspaceId, actorId: "local:owner", knowledgeRoot: f.root, globalStorageDirectory: f.profile,
      operation: "packages", refresh: true, environments: [entry] } });
  const { acquireNativeEnvironmentProfileWriter } = require(path.join(build, "runtime/ordinary-environment-native-profile-writer.js"));
  const fence = managed.createManagedEnvironmentHostFence({ root: f.root, profileStorage: f.profile,
    profileUri: pathToFileURL(f.profile).href, registration: f.registration, hostAdmission: f.host, scopeSignal: f.scope.signal });
  const pause = await f.gate.pauseLegacy();
  assert.throws(() => acquireNativeEnvironmentProfileWriter({
    binding: { workspaceId: host.workspaceId, knowledgeRoot: f.root, globalStorageDirectory: f.profile },
    hostFence: fence, dispatchPause: pause, intent: approval.intent,
    lifetime: { signal: approval.signal, expiresAtMs: approval.expiresAtMs }, supervisorPython: fs.realpathSync("/usr/bin/python3") }),
  /EAGAIN|unavailable|returned non-zero|failed/i);
  approval.dispose();
  await ui.close(); await f.parent.close();
  execFileSync("/usr/bin/python3", ["-I", "-B", "-c",
    "import fcntl,os,sys\nfd=os.open(sys.argv[1],os.O_RDONLY|os.O_DIRECTORY)\nfcntl.flock(fd,fcntl.LOCK_EX|fcntl.LOCK_NB)\nos.close(fd)", f.profile]);
  assert.equal(f.errors.length, 0);
  assert.equal(fs.existsSync(filename), false, "Native directory flock does not create or delete a lock-file path.");
});
