const test = require("node:test"), assert = require("node:assert/strict");
const fs = require("node:fs"), path = require("node:path"), Module = require("node:module");
const { execFileSync, spawnSync } = require("node:child_process"), { randomUUID } = require("node:crypto");
const build = process.env.PKM_ENV_AUTHORITY_BUILD;
if (!build || !process.env.PKM_TEST_PYTHON || !process.env.PKM_TEST_LEGACY_VSIX)
  throw Error("Explicit build, installed Python and original VSIX required.");
const { LocalEnvironmentCatalog } = require(path.join(build, "runtime/local-environment-catalog.js"));
const api = require(path.join(build, "runtime/local-python-lifecycle.js"));
function fixture(t) {
  const root = path.resolve("tests", ".python-deletion-" + randomUUID() + "-' $quoted"), storage = path.join(root, "profile");
  fs.mkdirSync(path.join(storage, "next-synthetic-python"), { recursive: true, mode: 0o700 });
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const store = new LocalEnvironmentCatalog(path.join(storage, "next-local-environments"));
  function add(systemPip = false, external = false) {
    const id = "local-python-" + randomUUID(), prefix = path.join(external ? root : path.join(storage, "next-synthetic-python"), id);
    execFileSync(process.env.PKM_TEST_PYTHON, ["-I", "-B", "-m", "venv", "--without-pip",
      ...(systemPip ? ["--system-site-packages"] : []), prefix], { env: { PATH: "/usr/bin:/bin", HOME: root, TMPDIR: root } });
    const entry = { id, name: id, root: prefix, manager: "venv", language: "python", kind: "environment",
      executors: [{ id: "python", executable: path.join(prefix, "bin/python") }] };
    store.register(entry, store.read().digest); return entry;
  }
  const options = entry => ({ storage, entry, plan: api.planPythonRemoval(storage, entry), store,
    expected: store.read().digest, check() {} });
  return { root, storage, store, add, options };
}
test("original checked delete really deletes; synthetic Next remains disabled even with explicit approval", async t => {
  const f = fixture(t), oldEntry = f.add(), entry = f.add();
  const bytes = execFileSync("/usr/bin/python3", ["-I", "-B", "-c",
    "import sys,zipfile;sys.stdout.buffer.write(zipfile.ZipFile(sys.argv[1]).read('extension/dist/servers/pyenvs.js'))",
    process.env.PKM_TEST_LEGACY_VSIX]);
  const oracle = new Module(path.join(f.root, "original-pyenvs.cjs"));
  oracle._compile(bytes.toString("utf8"), path.join(f.root, "original-pyenvs.cjs"));
  const old = oracle.exports, legacy = path.join(f.root, "legacy"); old.initPyenvs(legacy);
  old.pyenvAdd({ ...oldEntry, path: oldEntry.root, python: oldEntry.executors[0].executable });
  const result = await old.pyenvDelete(old.pyenvList()[0].id, true);
  assert(result.ok && result.unregistered && result.filesRemoved); assert(!fs.existsSync(oldEntry.root));
  assert.equal(old.pyenvList().length, 0);
  const outside = path.join(f.root, "outside.txt"); fs.writeFileSync(outside, "keep");
  fs.symlinkSync(outside, path.join(entry.root, "outside-link"));
  let approve = false, selected = entry.id, document;
  const stub = { window: {
    showQuickPick: async items => items.find(i => typeof i === "string" ? i === selected : i.description === selected),
    showWarningMessage: async (message, options, button) => { assert(options.modal); assert.match(message, /disabled/); return approve ? button : undefined; },
    showInformationMessage: async () => {},
    showTextDocument: async doc => { document = doc; },
  }, workspace: { openTextDocument: async doc => doc } };
  const load = Module._load; Module._load = function (id, ...args) { return id === "vscode" ? stub : load.call(this, id, ...args); };
  let ui; try { ui = require(path.join(build, "ui/next-python-lifecycle.js")); } finally { Module._load = load; }
  const run = action => ui.managePythonLifecycle(action, f.store, f.store.read(), f.storage, () => {});
  const action = "Permanently delete synthetic Python files and unregister";
  await run(action); assert(fs.existsSync(entry.root)); assert.equal(api.listPythonDeletions(f.storage).length, 0);
  approve = true; const digest = f.store.read().digest;
  await run(action); assert(fs.existsSync(entry.root)); assert.equal(fs.readFileSync(outside, "utf8"), "keep");
  assert(f.store.read().catalog.entries.some(e => e.id === entry.id));
  assert.equal(api.listPythonDeletions(f.storage).length, 0);
  assert.deepEqual(api.listPythonRemovals(f.storage), []);
  assert.equal(f.store.read().digest, digest); assert.equal(document, undefined);
});
test("disabled synthetic API preserves files, registration and permissions even with revoked or stale requests", t => {
  const f = fixture(t), external = f.add(false, true), entry = f.add();
  assert.throws(() => f.options(external), /restricted.*synthetic/);
  let options = f.options(entry);
  assert.throws(() => api.deleteSyntheticPythonFiles({ ...options, check() { throw Error("revoked"); } }), /revoked/);
  f.store.editPython(entry.id, "Changed", "", f.store.read().digest);
  assert.throws(() => api.deleteSyntheticPythonFiles(options), /Synthetic permanent deletion is disabled/);
  const current = f.store.read().catalog.entries.find(e => e.id === entry.id); options = f.options(current);
  const cfg = path.join(entry.root, "pyvenv.cfg"); fs.appendFileSync(cfg, "# drift\n");
  assert.throws(() => api.deleteSyntheticPythonFiles(options), /Synthetic permanent deletion is disabled/);
  options = f.options(current);
  const locked = path.join(entry.root, "permission-denied");
  fs.mkdirSync(locked, { mode: 0o700 }); fs.writeFileSync(path.join(locked, "owned.txt"), "keep until explicit permission repair");
  fs.chmodSync(locked, 0);
  try {
    assert.throws(() => api.deleteSyntheticPythonFiles(options), /Synthetic permanent deletion is disabled/);
    assert.equal(fs.statSync(locked).mode & 0o777, 0);
  } finally { fs.chmodSync(locked, 0o700); }
  assert(f.store.read().catalog.entries.some(e => e.id === entry.id));
  assert(fs.existsSync(path.join(locked, "owned.txt")));
  assert.equal(api.listPythonDeletions(f.storage).length, 0);
  const victim = path.join(f.root, "victim"); fs.mkdirSync(victim); fs.writeFileSync(path.join(victim, "sentinel"), "keep");
  fs.symlinkSync(victim, path.join(entry.root, "redirect"));
  const rm = fs.rmSync, saved = `${entry.root}-preserved`; let calls = 0;
  fs.rmSync = () => { calls++; throw Error("Unsafe recursive removal reached"); };
  try {
    assert.throws(() => api.deleteSyntheticPythonFiles({ ...options, check() {
      fs.renameSync(entry.root, saved); fs.symlinkSync(victim, entry.root);
    } }), /Synthetic permanent deletion is disabled/);
    assert.equal(calls, 0);
  } finally { fs.rmSync = rm; fs.unlinkSync(entry.root); fs.renameSync(saved, entry.root); }
  assert.equal(fs.readFileSync(path.join(victim, "sentinel"), "utf8"), "keep");
});
test("restarted worker refuses synthetic deletion before any irreversible phase or receipt", t => {
  const f = fixture(t), entry = f.add(), options = f.options(entry);
  const worker = spawnSync(process.execPath, ["-e", `
    const p=require("node:path"),[build,storage,raw]=process.argv.slice(1);
    const C=require(p.join(build,"runtime/local-environment-catalog.js")).LocalEnvironmentCatalog;
    const api=require(p.join(build,"runtime/local-python-lifecycle.js")),store=new C(p.join(storage,"next-local-environments")),entry=JSON.parse(raw);
    let checks=0;try{api.deleteSyntheticPythonFiles({storage,entry,store,expected:store.read().digest,plan:api.planPythonRemoval(storage,entry),
      check(){if(++checks===3)process.kill(process.pid,"SIGKILL");}});}catch(e){
        console.log(JSON.stringify({disabled:/Synthetic permanent deletion is disabled/.test(e.message),checks}));}
  `, build, f.storage, JSON.stringify(entry)], { env: { PATH: "/usr/bin:/bin", HOME: f.root, TMPDIR: f.root }, encoding: "utf8", timeout: 10000 });
  assert.equal(worker.status, 0, worker.stderr);
  assert.deepEqual(JSON.parse(worker.stdout), { disabled: true, checks: 1 });
  const reopened = new LocalEnvironmentCatalog(path.join(f.storage, "next-local-environments"));
  assert(fs.existsSync(entry.root)); assert(reopened.read().catalog.entries.some(e => e.id === entry.id));
  assert.equal(api.listPythonDeletions(f.storage).length, 0);
  assert.deepEqual(api.listPythonRemovals(f.storage), []);
  reopened.unregister(entry.id, reopened.read().digest); assert(fs.existsSync(entry.root));
});
test("manual generated deletion/merge scripts really work only when deliberately run; no-missing merge installs nothing and leaves metadata untouched", async t => {
  const f = fixture(t), a = f.add(true), b = f.add(true);
  const { PythonEnvironmentAuthority } = require(path.join(build, "runtime/python-environment-authority.js"));
  const authority = new PythonEnvironmentAuthority(() => true, () => [a, b].map(e => ({
    id: e.id, name: e.name, manager: e.manager, path: e.root, python: e.executors[0].executable,
  }))); t.after(() => authority.revoke());
  const packages = require(path.join(build, "runtime/local-python-packages.js"));
  for (const entry of [a, b]) await packages.refreshPipPackageSnapshot({ storage: f.storage, store: f.store, entry,
    expected: f.store.read().digest, authority, handle: authority.select("manual-test", "local:owner", entry.id), check() {} });
  const merged = require(path.join(build, "runtime/local-python-merge.js")).generatePythonMergeScript(f.storage, a, b);
  assert(!merged.script.includes("-m pip install")); const digest = f.store.read().digest;
  const script = path.join(f.root, "manual-merge.sh"); fs.writeFileSync(script, merged.script);
  const run = input => spawnSync("/bin/bash", [script], { input, env: { PATH: "/usr/bin:/bin", HOME: f.root, TMPDIR: f.root }, encoding: "utf8" });
  assert.equal(run("NO\n").status, 1); assert(fs.existsSync(a.root) && fs.existsSync(b.root));
  const drop = [a, b].find(e => e.id === merged.dropId), keep = [a, b].find(e => e.id === merged.keepId);
  const cfg = path.join(drop.root, "pyvenv.cfg"), original = fs.readFileSync(cfg); fs.appendFileSync(cfg, "# stale\n");
  assert.notEqual(run("DELETE\n").status, 0); assert(fs.existsSync(drop.root)); fs.writeFileSync(cfg, original);
  const result = run("DELETE\n"); assert.equal(result.status, 0, result.stderr);
  assert(!fs.existsSync(drop.root)); assert(fs.existsSync(keep.root)); assert.equal(f.store.read().digest, digest);
  const standalone = path.join(f.root, "manual-delete.sh"); fs.writeFileSync(standalone, api.planPythonLifecycle(keep).deletionScript);
  execFileSync("/bin/bash", [standalone], { env: { PATH: "/usr/bin:/bin", HOME: f.root, TMPDIR: f.root } });
  assert(!fs.existsSync(keep.root)); assert.equal(f.store.read().digest, digest);
});
test("manual conda deletion script executes against only a copied /envs/ prefix with private offline manager state, not catalog unregister", t => {
  if (!process.env.PKM_TEST_CONDA_EXECUTABLE || !process.env.PKM_TEST_EXISTING_CONDA_PREFIX)
    throw Error("Explicit installed conda and isolated source prefix required for this manual-script test.");
  const f = fixture(t), source = process.env.PKM_TEST_EXISTING_CONDA_PREFIX, prefix = path.join(f.root, "envs", "manual-conda");
  fs.mkdirSync(path.dirname(prefix), { mode: 0o700 });
  fs.cpSync(source, prefix, { recursive: true, dereference: false });
  const entry = { id: "manual-conda-" + randomUUID(), name: "Manual conda", root: prefix, manager: "conda",
    language: "python", kind: "environment", executors: [{ id: "python", executable: path.join(prefix, "bin/python") }] };
  f.store.register(entry, f.store.read().digest); const before = f.store.read().digest;
  const script = require(path.join(build, "runtime/local-python-merge.js")).condaManualDeleteScript(entry, process.env.PKM_TEST_CONDA_EXECUTABLE);
  const file = path.join(f.root, "manual-conda-delete.sh"), config = path.join(f.root, "condarc");
  fs.writeFileSync(file, script);
  for (const dir of ["home", "pkgs", "scratch"]) fs.mkdirSync(path.join(f.root, dir), { mode: 0o700 });
  fs.writeFileSync(config, "offline: true\nchannels: []\nnotify_outdated_conda: false\nauto_update_conda: false\n");
  execFileSync("/bin/bash", [file], { cwd: f.root, timeout: 30000,
    env: { PATH: "/usr/bin:/bin", HOME: path.join(f.root, "home"), TMPDIR: path.join(f.root, "scratch"),
      CONDARC: config, CONDA_OFFLINE: "true", CONDA_NO_PLUGINS: "true", CONDA_AUTO_UPDATE_CONDA: "false",
      CONDA_PKGS_DIRS: path.join(f.root, "pkgs"), CONDA_ENVS_DIRS: path.join(f.root, "envs"), PYTHONDONTWRITEBYTECODE: "1" } });
  assert(!fs.existsSync(prefix)); assert(fs.existsSync(path.join(source, "bin/python")));
  assert.equal(f.store.read().digest, before);
});
