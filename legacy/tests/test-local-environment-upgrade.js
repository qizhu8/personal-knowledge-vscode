const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const Module = require("node:module");
const { randomUUID, createHash } = require("node:crypto");
const { execFileSync, spawn } = require("node:child_process");

const build = process.env.PKM_ENV_AUTHORITY_BUILD;
if (!build || !path.isAbsolute(build)) throw new Error("Set absolute PKM_ENV_AUTHORITY_BUILD.");
const upgradePath = path.join(build, "runtime/local-environment-upgrade.js");
const { upgradeLocalEnvironmentProfile: upgrade } = require(upgradePath);
const { LocalEnvironmentCatalog } = require(path.join(build, "runtime/local-environment-catalog.js"));
const hash = file => createHash("sha256").update(fs.readFileSync(file)).digest("hex");
function fixture(t) {
  const root = path.join(fs.realpathSync(process.cwd()), "tests", `.environment-upgrade-${randomUUID()}`);
  const storage = path.join(root, "profile");
  fs.mkdirSync(path.join(storage, "environments"), { recursive: true, mode: 0o700 });
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const venv = path.join(root, "existing-python");
  execFileSync("/usr/bin/python3", ["-m", "venv", "--without-pip", venv], { cwd: root, env: {} });
  const record = { id: "original-python", name: "Original Python", manager: "venv", path: venv,
    python: path.join(venv, "bin/python"), condaName: "preserved-name", description: "用户原配置",
    sizeBytes: 123, sizeAt: "2020-01-01", pyVersion: "3.11", extraMetadata: { preserve: true } };
  const registry = path.join(storage, "environments/registry.json");
  fs.writeFileSync(registry, JSON.stringify([record]));
  const cache = path.join(storage, "environments/original-python.packages.json");
  fs.writeFileSync(cache, '{"packages":[{"name":"existing-only","version":"1"}]}');
  const store = new LocalEnvironmentCatalog(path.join(storage, "next-local-environments"));
  return { root, storage, record, registry, cache, store, venv };
}

test("gated discovery keeps original IDs, all configuration and package references without selecting paths", t => {
  const f = fixture(t), original = hash(f.registry), cache = hash(f.cache);
  assert.equal(upgrade(f.storage, false, false).state, "disabled");
  assert(!fs.existsSync(path.join(f.storage, "next-local-environments")));
  assert.throws(() => upgrade(f.storage, true, false), /trusted/);
  assert.equal(f.store.read().catalog.revision, 0);
  const result = upgrade(f.storage, true, true);
  assert.equal(result.state, "migrated");
  assert.deepEqual(result.environments, [{ id: f.record.id, available: true, issues: [] }]);
  const entry = f.store.read().catalog.entries[0];
  assert.deepEqual(entry.legacyPython, f.record);
  assert.equal(entry.root, f.record.path);
  assert.equal(entry.executors[0].executable, f.record.python);
  assert.equal(upgrade(f.storage, true, true).state, "already-migrated");
  assert.equal(f.store.read().catalog.revision, 1);
  assert.equal(hash(f.registry), original); assert.equal(hash(f.cache), cache);
  const removed = f.store.unregister(f.record.id, f.store.read().digest);
  upgrade(f.storage, true, true);
  assert.equal(f.store.read().digest, removed.digest, "Activation must not resurrect deliberately unregistered metadata.");
  assert.equal(upgrade(path.join(f.root, "absent-profile"), true, true).state, "no-legacy-profile");
  assert(!fs.existsSync(path.join(f.root, "absent-profile")));
});

test("missing runtimes stay repair-required across restart; source drift/corruption/conflicts never overwrite", t => {
  const f = fixture(t);
  fs.renameSync(f.venv, `${f.venv}-offline`);
  assert.equal(upgrade(f.storage, true, true).state, "repair-required");
  assert.equal(upgrade(f.storage, true, true).state, "repair-required");
  const committed = f.store.read();
  assert.deepEqual(committed.catalog.entries[0].legacyPython, f.record);
  fs.writeFileSync(f.registry, JSON.stringify([{ ...f.record, python: "/missing/replacement" }]));
  assert.throws(() => upgrade(f.storage, true, true), /changed after migration/);
  assert.equal(f.store.read().digest, committed.digest);
  fs.writeFileSync(f.registry, "{broken");
  assert.throws(() => upgrade(f.storage, true, true));
  assert.equal(f.store.read().digest, committed.digest);
  fs.unlinkSync(f.registry);
  assert.throws(() => upgrade(f.storage, true, true), /registry is missing/);
  fs.writeFileSync(f.registry, JSON.stringify([f.record]));
  fs.renameSync(`${f.venv}-offline`, f.venv);
  assert.equal(upgrade(f.storage, true, true).state, "already-migrated");
});

test("activation discovers only its own profile, with no picker/approval or implicit execution", t => {
  const f = fixture(t), errors = [], warnings = [], commands = new Map();
  let gate = false, trusted = true;
  const vscode = {
    workspace: { get isTrusted() { return trusted; },
      getConfiguration(section) { assert.equal(section, "personalKnowledge"); return {
        get(key, fallback) { assert.equal(key, "experimental.localEnvironmentUpgrade"); return gate || fallback; },
      }; },
    },
    commands: { registerCommand(name, callback) { commands.set(name, callback); return { dispose() {} }; } },
    window: { showErrorMessage(message) { errors.push(message); }, showWarningMessage(message) { warnings.push(message); } },
  };
  const original = Module._load;
  let register;
  try {
    Module._load = function(name, parent, main) { return name === "vscode" ? vscode : original.call(this, name, parent, main); };
    ({ registerNextLocalEnvironments: register } = require(path.join(build, "ui/next-local-environments.js")));
  } finally { Module._load = original; }
  const context = { subscriptions: [], globalStorageUri: { fsPath: f.storage } };
  const noHost = () => { assert.fail("Metadata activation must not acquire execution authority."); };
  register(context, noHost); assert.equal(f.store.read().catalog.revision, 0);
  gate = true; trusted = false; register(context, noHost);
  assert.match(errors.pop(), /trusted/); assert.equal(f.store.read().catalog.revision, 0);
  trusted = true; fs.renameSync(f.venv, `${f.venv}-offline`); register(context, noHost);
  assert.equal(f.store.read().catalog.revision, 1);
  assert.match(warnings.pop(), /runtimes need repair/);
  register(context, noHost); assert.equal(f.store.read().catalog.revision, 1);
  assert.match(warnings.pop(), /runtimes need repair/); assert.deepEqual(errors, []);
});

test("conflicting IDs, changed discovery input and symlinked registries fail closed", t => {
  const f = fixture(t);
  const conflicting = { id: f.record.id, name: "Unrelated Node", language: "javascript", kind: "runtime",
    manager: "local", executors: [{ id: "node", executable: process.execPath }] };
  const current = f.store.register(conflicting, f.store.read().digest);
  assert.throws(() => upgrade(f.storage, true, true), /ID conflicts/);
  assert.equal(f.store.read().digest, current.digest);
  f.store.unregister(conflicting.id, current.digest);
  const preview = LocalEnvironmentCatalog.prototype.previewLegacy;
  LocalEnvironmentCatalog.prototype.previewLegacy = function(file) {
    const result = preview.call(this, file); fs.appendFileSync(file, "\n"); return result;
  };
  try { assert.throws(() => upgrade(f.storage, true, true), /changed after preview/); }
  finally { LocalEnvironmentCatalog.prototype.previewLegacy = preview; }
  assert.equal(f.store.read().catalog.legacyImports.length, 0);
  const original = `${f.registry}.original`;
  fs.renameSync(f.registry, original); fs.symlinkSync(original, f.registry);
  assert.throws(() => upgrade(f.storage, true, true));
  assert.equal(f.store.read().catalog.legacyImports.length, 0);
});

test("lost durability acknowledgement reports uncertainty, and next activation observes one committed migration", t => {
  const f = fixture(t), sync = fs.fsyncSync;
  fs.fsyncSync = fd => {
    if (fs.fstatSync(fd).isDirectory()) throw new Error("Injected directory fsync failure");
    return sync(fd);
  };
  try { assert.throws(() => upgrade(f.storage, true, true), /may have succeeded/); }
  finally { fs.fsyncSync = sync; }
  assert.equal(upgrade(f.storage, true, true).state, "already-migrated");
  assert.equal(f.store.read().catalog.revision, 1);
});

for (const boundary of ["prepared", "published"]) test(`automatic upgrade resumes idempotently after real ${boundary} SIGKILL`, { timeout: 10000 }, async t => {
  const f = fixture(t), original = hash(f.registry);
  const code = `const fs=require('node:fs');const {upgradeLocalEnvironmentProfile}=require(process.argv[1]);
    const stop=()=>{process.send('boundary');Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0);};
    const name=process.argv[3]==='prepared'?'fsyncSync':'linkSync', original=fs[name];
    fs[name]=(...args)=>{const result=original(...args);stop();return result;};
    upgradeLocalEnvironmentProfile(process.argv[2],true,true);`;
  const child = spawn(process.execPath, ["-e", code, upgradePath, f.storage, boundary],
    { cwd: f.root, stdio: ["ignore", "ignore", "pipe", "ipc"] });
  t.after(() => { if (child.exitCode === null && child.signalCode === null) child.kill(); });
  await new Promise((resolve, reject) => {
    child.once("error", reject); child.once("exit", () => reject(new Error("Exited before boundary")));
    child.once("message", resolve);
  });
  const exited = new Promise(resolve => child.once("exit", resolve));
  child.kill("SIGKILL"); await exited;
  const result = upgrade(f.storage, true, true);
  assert.equal(result.state, boundary === "prepared" ? "migrated" : "already-migrated");
  assert.equal(f.store.read().catalog.revision, 1);
  assert.deepEqual(f.store.read().catalog.entries[0].legacyPython, f.record);
  assert.equal(upgrade(f.storage, true, true).state, "already-migrated");
  assert.equal(hash(f.registry), original);
});
