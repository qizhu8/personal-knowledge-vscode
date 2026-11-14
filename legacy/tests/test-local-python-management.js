const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs"), path = require("node:path"), Module = require("node:module");
const { execFileSync } = require("node:child_process");
const { randomUUID, createHash } = require("node:crypto");
const build = process.env.PKM_ENV_AUTHORITY_BUILD;
if (!build || !path.isAbsolute(build)) throw new Error("Set absolute PKM_ENV_AUTHORITY_BUILD.");
const { LocalEnvironmentCatalog } = require(path.join(build, "runtime/local-environment-catalog.js"));
const { upgradeLocalEnvironmentProfile } = require(path.join(build, "runtime/local-environment-upgrade.js"));
const { PythonEnvironmentAuthority } = require(path.join(build, "runtime/python-environment-authority.js"));
const { planPythonCreation, createOfflinePythonEnvironment, inspectPythonFolder, runOfflinePythonProcess } = require(path.join(build, "runtime/local-python-management.js"));
const { planPythonLifecycle, validatePythonLifecycle, pythonActivationCommand, planPythonMigration,
  migratePythonCopy, planPythonRemoval, removePythonToQuarantine, listPythonRemovals,
  restorePythonQuarantine, planExternalPythonDeletion, deleteExternalPythonFiles,
  listPythonDeletions, inspectPythonDeletion, pythonDeletionMountPoints } = require(path.join(build, "runtime/local-python-lifecycle.js"));
const hash = file => createHash("sha256").update(fs.readFileSync(file)).digest("hex");
function fixture(t, profileName = "profile") {
  const root = path.join(fs.realpathSync(process.cwd()), "tests", `.python-management-${randomUUID()}`);
  const storage = path.join(root, profileName), venv = path.join(root, "original-user-venv");
  fs.mkdirSync(path.join(storage, "environments"), { recursive: true, mode: 0o700 });
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  execFileSync("/usr/bin/python3", ["-c",
    "import os, sys, venv; os.umask(0o077); venv.EnvBuilder(with_pip=False).create(sys.argv[1])", venv], { cwd: root, env: {} });
  const original = { id: "original-python", name: "Original user Python", manager: "venv", path: venv,
    python: path.join(venv, "bin/python"), description: "original description", custom: { keep: true } };
  const registry = path.join(storage, "environments/registry.json");
  fs.writeFileSync(registry, JSON.stringify([original]));
  upgradeLocalEnvironmentProfile(storage, true, true);
  const store = new LocalEnvironmentCatalog(path.join(storage, "next-local-environments"));
  const authority = new PythonEnvironmentAuthority(() => true, () => [original]);
  const base = authority.select("workspace", "local:owner", original.id);
  t.after(() => authority.revoke());
  return { root, storage, venv, original, registry, store, authority, base };
}
const create = (f, entry, check = () => f.authority.validate(f.base, "workspace", "local:owner")) =>
  createOfflinePythonEnvironment({ storage: f.storage, entry, base: f.base, store: f.store, expected: f.store.read().digest, check });

test("a failing creation progress observer waits for its genuinely spawned owned child to stop", async t => {
  const f = fixture(t), processes = require("node:child_process"), original = processes.execFile;
  let child;
  processes.execFile = (...args) => { child = original(...args); return child; };
  t.after(async () => {
    if (child && child.exitCode === null && child.signalCode === null) {
      const stopped = new Promise(resolve => child.once("close", resolve));
      child.kill("SIGKILL"); await stopped;
    }
  });
  try {
    await assert.rejects(runOfflinePythonProcess(process.execPath, ["-e", "setTimeout(()=>{},30000)"],
      f.root, {}, undefined, () => { throw new Error("observer disconnected"); }), /progress callback failed.*observer disconnected/s);
    assert(child.pid, "A real process, not merely a failed spawn attempt, must be owned.");
    assert(child.exitCode !== null || child.signalCode !== null, "Failure cannot settle before child exit.");
  } finally { processes.execFile = original; }
});

test("Python rename/description edits retain ID, original snapshot and reference binding; stale edits refuse", t => {
  const f = fixture(t), original = hash(f.registry), before = f.store.read();
  const edited = f.store.editPython(f.original.id, "Renamed", "", before.digest);
  assert.equal(edited.catalog.entries[0].id, f.original.id);
  assert.equal(edited.catalog.entries[0].name, "Renamed");
  assert.equal(edited.catalog.entries[0].description, "");
  assert.deepEqual(edited.catalog.entries[0].legacyPython, f.original);
  assert.equal(edited.catalog.entries[0].root, f.venv);
  assert.equal(hash(f.registry), original);
  assert.equal(upgradeLocalEnvironmentProfile(f.storage, true, true).revision, edited.catalog.revision);
  assert.throws(() => f.store.editPython(f.original.id, "Lost update", "no", before.digest), /Catalog changed/);
  assert.throws(() => f.store.editPython(f.original.id, "", "no", edited.digest), /Invalid/);
  const unregistered = f.store.unregister(f.original.id, edited.digest);
  assert(fs.existsSync(f.original.python));
  assert.equal(upgradeLocalEnvironmentProfile(f.storage, true, true).revision, unregistered.catalog.revision);
  f.store.restore(edited.catalog.revision, unregistered.digest);
  assert.equal(f.store.read().catalog.entries[0].name, "Renamed");
});

test("explicit offline venv creation uses an existing local Python, has no pip, and leaves original environment untouched", async t => {
  const f = fixture(t), original = hash(f.registry), cfg = hash(path.join(f.venv, "pyvenv.cfg"));
  const entry = planPythonCreation(f.storage, "new-local-venv", "new description");
  assert(!fs.existsSync(entry.root));
  await create(f, entry);
  assert.equal(f.store.read().catalog.entries[1].id, entry.id);
  assert.equal(execFileSync(entry.executors[0].executable,
    ["-I", "-B", "-c", "import sys, importlib.util; print(sys.prefix); print(importlib.util.find_spec('pip'))"],
    { env: {}, cwd: f.root, encoding: "utf8" }).trim(), `${entry.root}\nNone`);
  assert.equal(hash(f.registry), original); assert.equal(hash(path.join(f.venv, "pyvenv.cfg")), cfg);
  await assert.rejects(create(f, entry), /EEXIST/);
  assert(fs.existsSync(entry.executors[0].executable));
  const removed = f.store.unregister(entry.id, f.store.read().digest);
  assert(fs.existsSync(entry.executors[0].executable));
  const registered = inspectPythonFolder(entry.root, "Recovered folder");
  f.store.register(registered, removed.digest);
  assert.equal(f.store.read().catalog.entries.at(-1).root, entry.root);
});

test("creation refuses non-synthetic destinations and revoked approval without creating files", async t => {
  const f = fixture(t), entry = planPythonCreation(f.storage, "local", "");
  await assert.rejects(create(f, { ...entry, root: f.venv }), /restricted/);
  await assert.rejects(create(f, entry, () => { throw new Error("Trust revoked"); }), /Trust revoked/);
  assert(!fs.existsSync(entry.root));
  assert.equal(f.store.read().catalog.revision, 1);
  assert(fs.existsSync(f.original.python));
});

test("catalog conflict after filesystem creation retains complete files for explicit folder recovery, never replays", async t => {
  const f = fixture(t), entry = planPythonCreation(f.storage, "conflict", "");
  let checks = 0;
  await assert.rejects(create(f, entry, () => {
    f.authority.validate(f.base, "workspace", "local:owner");
    if (++checks === 3) f.store.editPython(f.original.id, "Concurrent name", "", f.store.read().digest);
  }), /Catalog changed.*Files were kept/s);
  assert(fs.existsSync(entry.executors[0].executable));
  assert(!f.store.read().catalog.entries.some(item => item.id === entry.id));
  const recovered = inspectPythonFolder(entry.root, "Explicit recovery");
  f.store.register(recovered, f.store.read().digest);
  assert.equal(f.store.read().catalog.entries.at(-1).root, entry.root);
});

test("missing/invalid Python paths fail clearly and can recover without remapping or deleting an old environment", t => {
  const f = fixture(t);
  fs.renameSync(f.venv, `${f.venv}-offline`);
  assert.throws(() => inspectPythonFolder(f.venv, "Missing"), /ENOENT/);
  assert.throws(() => f.authority.select("workspace", "local:owner", f.original.id), /ENOENT/);
  fs.renameSync(`${f.venv}-offline`, f.venv);
  assert.equal(inspectPythonFolder(f.venv, "Available again").root, f.venv);
  const link = path.join(f.root, "link");
  fs.symlinkSync(f.venv, link);
  assert.throws(() => inspectPythonFolder(link, "No symlink"), /symlink/);
  const bad = path.join(f.root, "invalid-folder"); fs.mkdirSync(bad);
  assert.throws(() => inspectPythonFolder(bad, "Not a Python environment"), /ENOENT/);
  assert(fs.existsSync(f.original.python));
});

test("real venv activation uses the reviewed snapshot; manual deletion is distinct from unregister and never changes registry", t => {
  const f = fixture(t), before = hash(f.registry), entry = f.store.read().catalog.entries[0];
  const plan = planPythonLifecycle(entry), activation = pythonActivationCommand(plan);
  const result = execFileSync("/bin/bash", ["--noprofile", "--norc"], { cwd: f.root, env: { PATH: "/usr/bin:/bin" },
    input: `${activation}\npython -I -B -c 'import sys; print(sys.prefix)'\ndeactivate\nprintf '%s\\n' "\${VIRTUAL_ENV-unset}"\n`, encoding: "utf8" });
  assert.equal(result.trim(), `${f.venv}\nunset`);
  fs.appendFileSync(path.join(f.venv, "bin/activate"), "\n# drift");
  assert.throws(() => validatePythonLifecycle(plan, entry), /changed/);
  assert.equal(execFileSync("/bin/bash", ["--noprofile", "--norc"], { env: { PATH: "/usr/bin:/bin" }, cwd: f.root,
    input: `${activation}\nprintf '%s\\n' "$VIRTUAL_ENV"\n`, encoding: "utf8" }).trim(), f.venv);
  const deletion = planPythonLifecycle(entry).deletionScript;
  assert(fs.existsSync(f.original.python));
  execFileSync("/bin/bash", ["--noprofile", "--norc"], { input: deletion, env: {}, cwd: f.root });
  assert(!fs.existsSync(f.venv));
  assert.equal(f.store.read().catalog.entries[0].id, f.original.id);
  assert.equal(hash(f.registry), before);
  assert.throws(() => execFileSync("/bin/bash", ["--noprofile", "--norc"], { input: deletion, env: {}, cwd: f.root }));
  assert.throws(() => planPythonLifecycle({ ...entry, language: "csharp", kind: "executor-set" }), /C# executor sets/);
  assert.throws(() => planPythonLifecycle({ ...entry, manager: "conda" }), /Conda base/);
});
test("immutable original 1804 manager moves venv; script deletion, default unregister and opted-in file deletion are separate; activation targets interactive shell", async t => {
  const f = fixture(t), file = path.join(f.root, "original-1804-pyenvs.cjs");
  fs.writeFileSync(file, execFileSync("unzip", ["-p", path.resolve("personal-knowledge-4.0.22.vsix"),
    "extension/dist/servers/pyenvs.js"]));
  const old = require(file);
  old.initPyenvs(path.join(f.root, "legacy-profile/environments"));
  const record = old.pyenvAdd({ name: "Legacy move", manager: "venv", path: f.venv, python: f.original.python });
  let modal;
  const requests = [], vm = require("node:vm"), ui = vm.createContext({
    pkModal(options) { modal = options; }, ask(command, data) { requests.push({ command, data }); },
  });
  vm.runInContext(execFileSync("unzip", ["-p", path.resolve("personal-knowledge-4.0.22.vsix"),
    "extension/src/webview/panel/30-environments.js"], { encoding: "utf8" }), ui);
  ui.deleteEnv(record.id, record.name);
  assert.equal(modal.checkbox.checked, false); assert.equal(requests.length, 0);
  modal.onOk("", "", false);
  assert.equal(requests.at(-1).command, "envDelete"); assert.equal(requests.at(-1).data.removeFiles, false);
  ui.deleteEnvScript(record.id);
  assert.equal(requests.at(-1).command, "envDeleteScript");
  const activation = old.pyenvActivateCommands(record.id);
  assert.equal(activation.shell, "posix"); assert.deepEqual(activation.lines, [`source "${f.venv}/bin/activate"`]);
  const deletion = old.pyenvDeleteScript(record.id);
  assert(deletion.script.includes(`rm -rf "${f.venv}"`)); assert(fs.existsSync(f.venv));
  const moved = await old.pyenvMigrate(record.id, path.join(f.root, "old-managed"));
  assert.equal(moved.ok, true, moved.error); assert.equal(moved.env.id, record.id);
  assert(!fs.existsSync(f.venv)); assert(fs.existsSync(moved.env.python));
  assert.equal(old.pyenvGet(record.id).path, moved.env.path);
  assert(fs.readFileSync(path.join(moved.env.path, "bin/activate"), "utf8").includes(moved.env.path));
  const unregistered = await old.pyenvDelete(record.id, false);
  assert.equal(unregistered.unregistered, true); assert.equal(unregistered.filesRemoved, false);
  assert(fs.existsSync(moved.env.path));
  const again = old.pyenvAdd({ name: "Legacy destructive delete", manager: "venv", path: moved.env.path, python: moved.env.python });
  ui.deleteEnv(again.id, again.name); modal.onOk("", "", true);
  assert.equal(requests.at(-1).command, "envDelete"); assert.equal(requests.at(-1).data.removeFiles, true);
  const deleted = await old.pyenvDelete(requests.at(-1).data.id, requests.at(-1).data.removeFiles);
  assert.equal(deleted.filesRemoved, true); assert.equal(deleted.unregistered, true); assert(!fs.existsSync(moved.env.path));
  const conda = old.pyenvAdd({ name: "Base", manager: "conda", path: path.join(f.root, "conda-base"),
    python: path.join(f.root, "conda-base/bin/python") });
  assert.match(old.pyenvDeleteScript(conda.id).error, /base environment/);
  assert.match((await old.pyenvMigrate(conda.id, path.join(f.root, "other"))).error, /base environment/);
});

test("safe venv migration executes copied Python, keeps original/raw ID, invalidates approval and metadata restore selects preserved source", async t => {
  const f = fixture(t), original = hash(f.registry), view = f.store.read(), entry = view.catalog.entries[0];
  const authority = new PythonEnvironmentAuthority(() => f.store.read().digest === view.digest,
    () => f.store.read().catalog.entries.map(item => ({ id: item.id, name: item.name, manager: item.manager,
      path: item.root, python: item.executors[0].executable })));
  t.after(() => authority.revoke());
  const handle = authority.select("workspace", "local:owner", entry.id), plan = planPythonMigration(f.storage, entry);
  const activation = hash(path.join(f.venv, "bin/activate"));
  await migratePythonCopy({ storage: f.storage, entry, plan, store: f.store, expected: view.digest, check() {} });
  const migrated = f.store.read(), current = migrated.catalog.entries[0];
  assert.equal(current.id, entry.id); assert.equal(current.root, plan.target);
  assert.deepEqual(current.legacyPython, f.original);
  assert.equal(hash(f.registry), original); assert.equal(hash(path.join(f.venv, "bin/activate")), activation);
  assert(fs.existsSync(f.original.python));
  assert.equal(execFileSync(current.executors[0].executable, ["-I", "-B", "-c", "import sys; print(sys.prefix)"],
    { env: {}, encoding: "utf8" }).trim(), plan.target);
  assert.equal(execFileSync("/bin/bash", ["--noprofile", "--norc"], { env: { PATH: "/usr/bin:/bin" }, encoding: "utf8",
    input: `${pythonActivationCommand(planPythonLifecycle(current))}\npython -I -B -c 'import sys; print(sys.prefix)'\n` }).trim(), plan.target);
  assert.throws(() => authority.validate(handle, "workspace", "local:owner"), /trusted|current|unavailable|changed/);
  f.store.restore(view.catalog.revision, migrated.digest);
  assert.equal(f.store.read().catalog.entries[0].root, f.venv);
  assert(fs.existsSync(path.join(plan.target, "bin/python")));
});

test("migration source drift/trust refusal start no copy; post-copy CAS conflict retains evidence for explicit repair", async t => {
  const f = fixture(t), entry = f.store.read().catalog.entries[0], view = f.store.read();
  const rejected = planPythonMigration(f.storage, entry);
  fs.writeFileSync(path.join(f.venv, "changed.txt"), "source drift");
  await assert.rejects(migratePythonCopy({ storage: f.storage, entry, plan: rejected, store: f.store,
    expected: view.digest, check() {} }), /source tree changed/);
  assert(!fs.existsSync(rejected.target));
  const plan = planPythonMigration(f.storage, entry);
  await assert.rejects(migratePythonCopy({ storage: f.storage, entry, plan, store: f.store,
    expected: view.digest, check() { throw Error("Trust revoked"); } }), /Trust revoked/);
  assert(!fs.existsSync(plan.target));
  let count = 0;
  await assert.rejects(migratePythonCopy({ storage: f.storage, entry, plan, store: f.store,
    expected: view.digest, check() {
      if (++count === 2) f.store.editPython(entry.id, "Concurrent edit", "", view.digest);
    } }), /Catalog changed.*Source is untouched/s);
  assert(fs.existsSync(path.join(plan.target, "bin/python")));
  assert.equal(f.store.read().catalog.entries[0].root, f.venv);
  const receipt = JSON.parse(fs.readFileSync(path.join(f.storage, "next-environment-maintenance", `${plan.operationId}.json`)));
  assert.equal(receipt.automaticReplay, false); assert.equal(receipt.sourcePreserved, true);
  assert(fs.existsSync(f.original.python));
});
for (const profileName of ["profile ' $literal spaces", "profile-" + "x".repeat(140), "profile-\\Unicode ''' spaces"]) {
  test(`migrated Python entry points execute from ${profileName.includes("\\") ? "backslash/quote" : profileName.includes("spaces") ? "quoted" : "long"} profile paths without invoking the original`, async t => {
    const f = fixture(t, profileName), entry = f.store.read().catalog.entries[0], view = f.store.read(), registry = hash(f.registry);
    const script = path.join(f.venv, "bin", "console-tool");
    const source = `#!${entry.executors[0].executable}\n# coding: utf-8\nfrom __future__ import annotations\nimport sys, json\nprint(json.dumps([sys.prefix, sys.argv[1:], "café"]))\n`;
    fs.writeFileSync(script, source, { mode: 0o700 });
    const isolated = path.join(f.venv, "bin", "isolated-tool");
    fs.writeFileSync(isolated, `#!${path.join(f.venv, "bin/python3")} -I\nimport sys\nprint(sys.prefix, sys.flags.isolated)\n`, { mode: 0o700 });
    const shell = path.join(f.venv, "bin", "shell-tool");
    fs.writeFileSync(shell, `#!/bin/sh\nprintf '%s\\n' '${f.venv}'\n`, { mode: 0o700 });
    assert.deepEqual(JSON.parse(execFileSync(script, ["before"], { env: {}, encoding: "utf8" })),
      [f.venv, ["before"], "café"]);
    const plan = planPythonMigration(f.storage, entry);
    await migratePythonCopy({ storage: f.storage, entry, plan, store: f.store, expected: view.digest, check() {} });
    assert.equal(fs.readFileSync(script, "utf8"), source);
    assert.equal(f.store.read().catalog.entries[0].root, plan.target);
    const args = ["one argument", "' $HOME ;", ""];
    assert.deepEqual(JSON.parse(execFileSync(path.join(plan.target, "bin", "console-tool"), args, { env: {}, encoding: "utf8" })),
      [plan.target, args, "café"]);
    assert.deepEqual(JSON.parse(execFileSync(path.join(plan.target, "bin/python"),
      [path.join(plan.target, "bin", "console-tool"), "via-python"], { env: {}, encoding: "utf8" })),
      [plan.target, ["via-python"], "café"]);
    assert.equal(execFileSync(path.join(plan.target, "bin", "isolated-tool"), { env: {}, encoding: "utf8" }).trim(),
      `${plan.target} 1`);
    assert.equal(fs.readFileSync(path.join(plan.target, "bin", "shell-tool"), "utf8"),
      `#!/bin/sh\nprintf '%s\\n' '${plan.target}'\n`);
    assert.equal(hash(f.registry), registry);
  });
}
test("synthetic removal really quarantines/unregisters and explicitly restores same ID/files; external prefixes and stale decisions refuse", async t => {
  const f = fixture(t), original = hash(f.registry), entry = planPythonCreation(f.storage, "quarantine", "");
  await create(f, entry);
  assert.throws(() => planPythonRemoval(f.storage, f.store.read().catalog.entries[0]), /restricted/);
  const view = f.store.read(), plan = planPythonRemoval(f.storage, entry);
  assert.throws(() => removePythonToQuarantine({ storage: f.storage, entry, plan, store: f.store,
    expected: view.digest, check() { throw Error("Trust revoked"); } }), /Trust revoked/);
  assert(fs.existsSync(entry.root)); assert(!fs.existsSync(plan.target));
  removePythonToQuarantine({ storage: f.storage, entry, plan, store: f.store, expected: view.digest, check() {} });
  assert(!fs.existsSync(entry.root)); assert(fs.existsSync(plan.target));
  assert(!f.store.read().catalog.entries.some(item => item.id === entry.id));
  assert.deepEqual(listPythonRemovals(f.storage), [plan.operationId]);
  assert.throws(() => restorePythonQuarantine(f.storage, plan.operationId, f.store, view.digest, () => {}), /Catalog changed/);
  restorePythonQuarantine(f.storage, plan.operationId, f.store, f.store.read().digest, () => {});
  assert(fs.existsSync(entry.root)); assert(!fs.existsSync(plan.target));
  assert.deepEqual(f.store.read().catalog.entries.at(-1), entry);
  assert.equal(execFileSync(entry.executors[0].executable, ["-I", "-B", "-c", "import sys; print(sys.prefix)"],
    { env: {}, encoding: "utf8" }).trim(), entry.root);
  assert.equal(hash(f.registry), original); assert(fs.existsSync(f.original.python));
});
test("real SIGKILL after quarantine rename retains receipt/stale metadata; explicit restore never overwrites another binding", async t => {
  const f = fixture(t), entry = planPythonCreation(f.storage, "interrupted-removal", "");
  await create(f, entry);
  const view = f.store.read(), plan = planPythonRemoval(f.storage, entry);
  const child = `const {LocalEnvironmentCatalog}=require(${JSON.stringify(path.join(build, "runtime/local-environment-catalog.js"))});
const {removePythonToQuarantine}=require(${JSON.stringify(path.join(build, "runtime/local-python-lifecycle.js"))});
let count=0;removePythonToQuarantine({storage:${JSON.stringify(f.storage)},entry:${JSON.stringify(entry)},plan:${JSON.stringify(plan)},
store:new LocalEnvironmentCatalog(${JSON.stringify(path.join(f.storage, "next-local-environments"))}),expected:${JSON.stringify(view.digest)},
check(){if(++count===3)process.kill(process.pid,"SIGKILL");}});`;
  assert.throws(() => execFileSync(process.execPath, ["-e", child], { env: {}, cwd: f.root }), error => error.signal === "SIGKILL");
  assert(!fs.existsSync(entry.root)); assert(fs.existsSync(plan.target)); assert.equal(f.store.read().digest, view.digest);
  const changed = f.store.rebindPython(entry.id, f.venv, view.digest);
  assert.throws(() => restorePythonQuarantine(f.storage, plan.operationId, f.store, changed.digest, () => {}), /rebound elsewhere/);
  f.store.restore(view.catalog.revision, changed.digest);
  restorePythonQuarantine(f.storage, plan.operationId, f.store, f.store.read().digest, () => {});
  assert(fs.existsSync(entry.root)); assert(!fs.existsSync(plan.target));
  assert.equal(f.store.read().catalog.entries.at(-1).id, entry.id);
  assert(fs.existsSync(f.original.python));
});
test("read-only external deletion planning refuses protected targets and unstable input permissions", t => {
  const f = fixture(t), entry = f.store.read().catalog.entries[0], plan = planExternalPythonDeletion(f.storage, entry);
  const options = { storage: f.storage, entry, plan, store: f.store, expected: f.store.read().digest, check() {} };
  for (const protectedEntry of [{ ...entry, root: f.storage }, { ...entry, root: f.root },
    { ...entry, root: process.env.HOME }, { ...entry, root: "/" }, { ...entry, name: "PKM MCP Runtime" },
    { ...entry, description: "Managed runtime for pkm" }, { ...entry, manager: "conda" }]) {
    assert.throws(() => planExternalPythonDeletion(f.storage, protectedEntry), /External deletion requires/);
  }
  const alias = path.join(f.root, "linked-venv"); fs.symlinkSync(f.venv, alias);
  assert.throws(() => planExternalPythonDeletion(f.storage, { ...entry, root: alias }), /symlink/);
  fs.chmodSync(f.venv, 0o777);
  try { assert.throws(() => planExternalPythonDeletion(f.storage, entry), /world-writable/); }
  finally { fs.chmodSync(f.venv, 0o700); }
  assert.throws(() => deleteExternalPythonFiles({ ...options, check() { throw Error("trust revoked"); } }), /trust revoked/);
  assert.throws(() => deleteExternalPythonFiles(options), /External permanent deletion is disabled/);
  assert.equal(listPythonDeletions(f.storage).length, 0);
  assert(fs.existsSync(f.venv)); assert.equal(f.store.read().digest, options.expected);
});
test("mountinfo refuses root and nested mounts, including same-device binds and escaped paths, but not sibling prefixes", () => {
  const line = point => `11 10 0:9 /some/other/root ${point} rw - overlay overlay rw\n`;
  const base = "10 1 0:9 / / rw - overlay overlay rw\n";
  assert.deepEqual(pythonDeletionMountPoints("/isolated/env", base + line("/isolated/env-copy")), []);
  assert.deepEqual(pythonDeletionMountPoints("/isolated/env", base + line("/isolated/env/nested")), ["/isolated/env/nested"]);
  assert.deepEqual(pythonDeletionMountPoints("/isolated/env", base + line("/isolated/env")), ["/isolated/env"]);
  assert.deepEqual(pythonDeletionMountPoints("/isolated/env space\\name", base + line("/isolated/env\\040space\\134name/nested")),
    ["/isolated/env space\\name/nested"]);
  for (const malformed of ["", "not mountinfo", base + line("/isolated/env\\999bad"), base + line("relative")])
    assert.throws(() => pythonDeletionMountPoints("/isolated/env", malformed), /required|refused/);
});
test("disabled external backend never calls recursive removal, even after reviewed source is redirected", t => {
  const f = fixture(t), entry = f.store.read().catalog.entries[0], plan = planExternalPythonDeletion(f.storage, entry);
  const victim = path.join(f.root, "victim"), saved = `${f.venv}-preserved`;
  fs.mkdirSync(victim); fs.writeFileSync(path.join(victim, "sentinel"), "keep");
  const originalRm = fs.rmSync; let removals = 0;
  fs.rmSync = () => { removals++; throw Error("Recursive removal must not be reached"); };
  try {
    assert.throws(() => deleteExternalPythonFiles({ storage: f.storage, entry, plan, store: f.store,
      expected: f.store.read().digest, check() { fs.renameSync(f.venv, saved); fs.symlinkSync(victim, f.venv); } }),
      /disabled.*same-device bind mounts/s);
    assert.equal(removals, 0); assert.equal(fs.readFileSync(path.join(victim, "sentinel"), "utf8"), "keep");
    assert.equal(listPythonDeletions(f.storage).length, 0);
    assert.equal(f.store.read().catalog.entries[0].root, entry.root);
  } finally { fs.rmSync = originalRm; fs.unlinkSync(f.venv); fs.renameSync(saved, f.venv); }
});
test("historical external requested receipts stay read-only after restart, even when original path is absent", t => {
  const f = fixture(t), entry = f.store.read().catalog.entries[0], registry = hash(f.registry);
  const operation = randomUUID(), ledger = path.join(f.storage, "next-environment-maintenance");
  fs.mkdirSync(ledger, { mode: 0o700 });
  fs.writeFileSync(path.join(ledger, `${operation}.json`), JSON.stringify({
    schema: "pkm.local-python-external-deletion/v1", operationId: operation, entry,
    sourceRevision: f.store.read().catalog.revision, identity: "historical-fixture", state: "requested", automaticReplay: false,
  }), { mode: 0o600 });
  fs.renameSync(entry.root, `${entry.root}-preserved`);
  const reopened = new LocalEnvironmentCatalog(path.join(f.storage, "next-local-environments"));
  assert(!fs.existsSync(entry.root)); assert(reopened.read().catalog.entries.some(e => e.id === entry.id));
  const outcome = inspectPythonDeletion(f.storage, operation, reopened);
  assert(!outcome.sourcePresent && outcome.registrationMatches); assert.equal(outcome.receipt.state, "requested");
  assert.deepEqual(listPythonRemovals(f.storage), []);
  reopened.unregister(entry.id, reopened.read().digest);
  assert(!fs.existsSync(entry.root)); assert.equal(inspectPythonDeletion(f.storage, operation, reopened).registrationPresent, false);
  assert.equal(hash(f.registry), registry);
});
test("real unprivileged bind mounts and deterministic Node removal races validate the deletion boundary", { timeout: 30000 }, t => {
  const root = path.resolve("tests", `.mount-removal-${randomUUID()}`);
  fs.mkdirSync(root, { mode: 0o700 });
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const worker = `
    const fs=require("node:fs"),p=require("node:path"),cp=require("node:child_process");
    const [base,scenario,build]=process.argv.slice(1),target=p.join(base,"target"),nested=p.join(target,"nested"),victim=p.join(base,"victim");
    cp.execFileSync("/usr/bin/mount",["--make-rprivate","/"]);
    fs.mkdirSync(nested,{recursive:true});fs.mkdirSync(victim);fs.writeFileSync(p.join(nested,"placeholder"),"owned");fs.writeFileSync(p.join(victim,"sentinel"),"keep");
    let fired=false,mounts=[],sameDevice=false,guardRejected=false;
    function bind(){
      cp.execFileSync("/usr/bin/mount",["--bind",victim,nested]);
      sameDevice=fs.statSync(nested).dev===fs.statSync(target).dev;
      const api=require(p.join(build,"runtime/local-python-lifecycle.js"));
      mounts=api.pythonDeletionMountPoints(target,fs.readFileSync("/proc/self/mountinfo","utf8"));
      try{api.rejectPythonDeletionMounts(target);}catch(e){guardRejected=/nested mount points/.test(e.message);}
    }
    if(scenario==="static-bind")bind();
    const rmdir=fs.rmdirSync;
    fs.rmdirSync=function(file,...args){
      try{return rmdir(file,...args);}catch(error){
        if(!fired&&String(file)===nested&&error.code==="ENOTEMPTY"){
          if(scenario==="racing-bind"){fired=true;bind();}
          if(scenario==="racing-symlink"){fired=true;fs.renameSync(nested,p.join(base,"preserved"));fs.symlinkSync(victim,nested);}
        }
        throw error;
      }
    };
    let error;try{fs.rmSync(target,{recursive:true,force:false});}catch(e){error=e.code;}
    console.log(JSON.stringify({scenario,fired,mounts,sameDevice,guardRejected,error,victimPresent:fs.existsSync(p.join(victim,"sentinel"))}));
  `;
  for (const scenario of ["static-bind", "racing-bind", "racing-symlink"]) {
    const base = path.join(root, scenario); fs.mkdirSync(base);
    const output = execFileSync("unshare", ["--user", "--map-root-user", "--mount", "--fork",
      process.execPath, "-e", worker, base, scenario, build], { env: { PATH: "/usr/bin:/bin", HOME: base, TMPDIR: base },
      encoding: "utf8", timeout: 8000 });
    const observed = JSON.parse(output.trim());
    if (scenario !== "racing-symlink") {
      assert(observed.sameDevice && observed.guardRejected); assert.deepEqual(observed.mounts, [path.join(base, "target", "nested")]);
    }
    if (scenario === "static-bind") { assert(observed.victimPresent); assert.equal(observed.error, "EBUSY"); }
    else { assert(observed.fired); assert.equal(observed.victimPresent, false); }
    console.log(JSON.stringify(observed));
  }
});
test("existing local Python ctypes reaches openat2/no-follow but cannot identity-bind a final named directory removal", { timeout: 30000 }, t => {
  const root = path.resolve("tests", `.fd-delete-probe-${randomUUID()}`);
  fs.mkdirSync(root, { mode: 0o700 });
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  for (const scenario of ["bind", "symlink", "bound-root", "root-unlink-race"]) {
    const base = path.join(root, scenario); fs.mkdirSync(base);
    const observed = JSON.parse(execFileSync("unshare", ["--user", "--map-root-user", "--mount", "--fork",
      "/usr/bin/python3", "-I", "-B", path.resolve("tests/linux-delete-fd-probe.py"), base, scenario],
      { env: { PATH: "/usr/bin:/bin", HOME: base, TMPDIR: base }, encoding: "utf8", timeout: 8000 }));
    if (scenario === "root-unlink-race") assert(observed.wrong_root_removed && observed.approved_root_preserved);
    else assert(observed.victim_preserved);
    console.log(JSON.stringify(observed));
  }
});

test("gated native management keeps both permanent-delete entries unavailable and preserves quarantine", async t => {
  const f = fixture(t), commands = new Map(), errors = [], infos = [];
  let trusted = true, confirmed = false, action, selectedId = f.original.id, afterModal;
  const inputs = [], terminals = [], clipboard = [], warnings = [], menus = [];
  const owner = { pythonWorkspaceId() { return "workspace"; } };
  const vscode = {
    ProgressLocation: { Notification: 15 },
    workspace: { get isTrusted() { return trusted; }, workspaceFolders: [],
      getConfiguration() { return { get() { return true; } }; } },
    commands: { registerCommand(name, callback) { commands.set(name, callback); return { dispose() {} }; } },
    env: { clipboard: { async writeText(text) { clipboard.push(text); } } },
    window: {
      async withProgress(_options, callback) { return callback({ report() {} }, { isCancellationRequested: false,
        onCancellationRequested() { return { dispose() {} }; } }); },
      async showQuickPick(items) {
        if (typeof items[0] !== "string") return items.find(item => item.description === selectedId);
        if (items.includes("Inspect registered environments")) { menus.push(items); return items.includes(action) ? action : undefined; }
        return items.includes(action) ? action : items[0];
      },
      async showInputBox() { return inputs.shift(); },
      async showWarningMessage(text, options, button) { assert(options?.modal); warnings.push({ text, detail: options.detail }); afterModal?.(); return confirmed ? button : undefined; },
      async showErrorMessage(message) { errors.push(message); }, async showInformationMessage(message) { infos.push(message); },
      createTerminal(options) { const terminal = { options, sent: [], show() {}, sendText(text) { this.sent.push(text); } };
        terminals.push(terminal); return terminal; },
    },
  };
  const original = Module._load;
  let register;
  try {
    Module._load = function(name, parent, main) { return name === "vscode" ? vscode : original.call(this, name, parent, main); };
    ({ registerNextLocalEnvironments: register } = require(path.join(build, "ui/next-local-environments.js")));
  } finally { Module._load = original; }
  register({ subscriptions: [], globalStorageUri: { fsPath: f.storage } }, () => owner);
  const run = commands.get("personalKnowledge.nextTrialEnvironments");
  action = "Create offline Python venv"; inputs.push("denied", ""); await run();
  assert(!fs.existsSync(path.join(f.storage, "next-synthetic-python")));
  confirmed = true; inputs.push("created", "User created"); await run();
  const created = f.store.read().catalog.entries.at(-1);
  assert.equal(created.name, "created"); assert.match(infos.at(-1), /Created offline Python/);
  selectedId = created.id; action = "Activate registered Python in clean Bash terminal"; await run();
  assert.equal(terminals.length, 1); assert.deepEqual(terminals[0].options.shellArgs, ["--noprofile", "--norc"]);
  const prefix = execFileSync("/bin/bash", terminals[0].options.shellArgs, { env: { PATH: "/usr/bin:/bin" },
    input: `${terminals[0].sent[0]}\npython -I -B -c 'import sys; print(sys.prefix)'\n`, encoding: "utf8" }).trim();
  assert.equal(prefix, created.root);
  action = "Review Python folder deletion script (manual only)"; await run();
  assert.equal(clipboard.length, 1); assert(fs.existsSync(created.root)); assert.match(clipboard[0], /MANUAL ONLY/);
  confirmed = false; action = "Activate registered Python in clean Bash terminal"; await run();
  assert.equal(terminals.length, 1); confirmed = true;
  action = "Remove synthetic Python to quarantine"; await run();
  assert(!fs.existsSync(created.root), errors.at(-1)); assert(!f.store.read().catalog.entries.some(entry => entry.id === created.id));
  action = "Restore quarantined Python folder"; await run();
  assert(fs.existsSync(created.root)); assert.equal(f.store.read().catalog.entries.at(-1).id, created.id);
  selectedId = created.id; action = "Edit Python name and description"; inputs.push("Renamed", "Changed");
  await run(); assert.equal(f.store.read().catalog.entries.at(-1).name, "Renamed");
  const current = f.store.read(); inputs.push("Must not save", "");
  afterModal = () => { trusted = false; }; await run();
  assert.match(errors.at(-1), /trusted workspace/); assert.equal(f.store.read().digest, current.digest);
  trusted = true; afterModal = undefined;
  action = "Unregister (keep all runtime files)"; await run();
  assert(fs.existsSync(created.executors[0].executable));
  assert(!f.store.read().catalog.entries.some(entry => entry.id === created.id));
  action = "Permanently delete external registered Python files and unregister"; selectedId = f.original.id;
  const quarantines = listPythonRemovals(f.storage);
  fs.chmodSync(f.venv, 0o775);
  await run(); assert(!menus.at(-1).includes(action));
  const before = f.store.read().digest, registry = hash(f.registry);
  inputs.push(f.venv);
  await require(path.join(build, "ui/next-python-lifecycle.js")).managePythonLifecycle(action, f.store, f.store.read(), f.storage, () => {});
  assert.match(warnings.at(-1).text, /disabled/); assert.match(warnings.at(-1).detail, /same device|same-device/);
  assert.equal(inputs.at(-1), f.venv); assert.equal(f.store.read().digest, before);
  assert(fs.existsSync(f.venv)); assert.equal(hash(f.registry), registry);
  assert.equal(listPythonDeletions(f.storage).length, 0); assert.deepEqual(listPythonRemovals(f.storage), quarantines);
  const g = fixture(t), syntheticEntry = planPythonCreation(g.storage, "synthetic-deletion-regression", "");
  await create(g, syntheticEntry);
  assert.throws(() => require(path.join(build, "runtime/local-python-lifecycle.js")).deleteSyntheticPythonFiles({
    storage: g.storage, entry: syntheticEntry, plan: planPythonRemoval(g.storage, syntheticEntry),
    store: g.store, expected: g.store.read().digest, check() {},
  }), /Synthetic permanent deletion is disabled/);
  assert(fs.existsSync(syntheticEntry.root)); assert(g.store.read().catalog.entries.some(entry => entry.id === syntheticEntry.id));
  action = "Permanently delete synthetic Python files and unregister";
  await run(); assert(!menus.at(-1).includes(action));
  await require(path.join(build, "ui/next-python-lifecycle.js")).managePythonLifecycle(action, f.store, f.store.read(), f.storage, () => {});
  assert.match(warnings.at(-1).text, /both external and synthetic/); assert.equal(f.store.read().digest, before);
  assert.equal(listPythonDeletions(g.storage).length, 0);
  assert.deepEqual(listPythonRemovals(f.storage), quarantines);
});
