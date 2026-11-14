const test = require("node:test"), assert = require("node:assert/strict");
const fs = require("node:fs"), path = require("node:path"), Module = require("node:module");
const { execFileSync } = require("node:child_process"), { randomUUID } = require("node:crypto");
const build = process.env.PKM_ENV_AUTHORITY_BUILD;
if (!build || !path.isAbsolute(build)) throw Error("Set absolute PKM_ENV_AUTHORITY_BUILD; isolated offline fixture only.");
const { LocalEnvironmentCatalog } = require(path.join(build, "runtime/local-environment-catalog.js"));
const { PythonEnvironmentAuthority } = require(path.join(build, "runtime/python-environment-authority.js"));
const management = require(path.join(build, "runtime/local-python-management.js"));
const packages = require(path.join(build, "runtime/local-python-packages.js"));
const install = require(path.join(build, "runtime/local-python-wheel-install.js"));
const action = "Install missing merge packages from local wheels (synthetic only)";

async function fixture(t) {
  const root = path.resolve("tests", `.local-wheel-${randomUUID()}`), storage = path.join(root, "profile");
  fs.mkdirSync(storage, { recursive: true, mode: 0o700 });
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const dropRoot = path.join(root, "drop");
  execFileSync("/usr/bin/python3", ["-I", "-B", "-m", "venv", "--without-pip", dropRoot], { env: { HOME: root, TMPDIR: root } });
  const drop = { id: "external-drop", name: "Other snapshot", language: "python", kind: "environment", manager: "venv",
    root: dropRoot, executors: [{ id: "python", executable: path.join(dropRoot, "bin/python") }] };
  const store = new LocalEnvironmentCatalog(path.join(storage, "next-local-environments")); store.register(drop, store.read().digest);
  const authority = new PythonEnvironmentAuthority(() => true, () => store.read().catalog.entries.map(e => ({
    id: e.id, name: e.name, manager: e.manager, path: e.root, python: e.executors[0].executable,
  })));
  t.after(() => authority.revoke());
  const base = authority.select("workspace", "local:owner", drop.id), keep = management.planPythonCreation(storage, "Kept", "");
  await management.createOfflinePythonEnvironment({ storage, entry: keep, base, store, expected: store.read().digest,
    bundledPip: true, check() { authority.validate(base, "workspace", "local:owner"); } });
  const site = path.join(dropRoot, "lib", fs.readdirSync(path.join(dropRoot, "lib"))[0], "site-packages", "pkm_demo-1.0.dist-info");
  fs.mkdirSync(site); fs.writeFileSync(path.join(site, "METADATA"), "Metadata-Version: 2.1\nName: pkm_demo\nVersion: 1.0\n");
  for (const entry of [keep, drop]) {
    const list = JSON.parse(execFileSync(entry.executors[0].executable, ["-I", "-B", "-c",
      "import importlib.metadata as m,json;print(json.dumps([{'name':d.metadata['Name'],'version':d.version} for d in m.distributions()]))"],
    { env: { HOME: root, TMPDIR: root }, encoding: "utf8" }));
    fs.writeFileSync(packages.environmentSnapshotFile(storage, entry, true), JSON.stringify({
      schema: "pkm.local-pip-packages/v1", source: packages.inspectPythonPackageSource(entry),
      capturedAt: new Date().toISOString(), packages: list,
    }), { mode: 0o600 });
  }
  const wheel = path.join(root, "pkm_demo-1.0-py3-none-any.whl");
  function archive(extra = {}, recordExtra = "") {
    execFileSync("/usr/bin/python3", ["-I", "-B", "-c", `
import sys,zipfile,json,csv,io
files={"pkm_demo/__init__.py":"value = 42\\n",
 "pkm_demo-1.0.dist-info/METADATA":"Metadata-Version: 2.1\\nName: pkm_demo\\nVersion: 1.0\\n",
 "pkm_demo-1.0.dist-info/WHEEL":"Wheel-Version: 1.0\\nRoot-Is-Purelib: true\\nTag: py3-none-any\\n"}
files.update(json.loads(sys.argv[2]))
record="pkm_demo-1.0.dist-info/RECORD"
out=io.StringIO(); writer=csv.writer(out)
for name in list(files)+[record]: writer.writerow([name,"",""])
if sys.argv[3]: writer.writerow([sys.argv[3],"",""])
files[record]=out.getvalue()
with zipfile.ZipFile(sys.argv[1],"w",compression=zipfile.ZIP_DEFLATED) as archive:
 for name,data in files.items(): archive.writestr(name,data)
`, wheel, JSON.stringify(extra), recordExtra], { env: { HOME: root, TMPDIR: root } });
    fs.chmodSync(wheel, 0o600);
  }
  archive();
  const options = () => {
    const plan = install.planMissingWheelInstall(storage, keep, drop);
    return { storage, store, expected: store.read().digest, plan, wheels: install.selectMissingWheels(plan, [wheel]),
      authority, handle: authority.select("workspace", "local:owner", keep.id), check() {} };
  };
  return { root, storage, store, keep, drop, wheel, archive, options };
}

function native(f) {
  const state = { approved: false, mutate: undefined, notices: [], warnings: [] };
  let selection = 0;
  const stub = { ProgressLocation: { Notification: 1 }, window: {
    showQuickPick: async items => {
      const id = [f.keep.id, f.drop.id][selection++];
      return items.find(i => i.entry.id === id);
    },
    showOpenDialog: async () => [{ fsPath: f.wheel }],
    showWarningMessage: async (_, options, button) => {
      assert(options.modal); state.warnings.push(options.detail); state.mutate?.(); return state.approved ? button : undefined;
    },
    showInformationMessage: async message => state.notices.push(message),
    withProgress: async (_, task) => task({ report() {} }, { isCancellationRequested: false,
      onCancellationRequested() { return { dispose() {} }; } }),
    createTerminal() { throw Error("No terminal grant."); },
  } };
  const file = path.join(build, "ui/next-python-packages.js"), load = Module._load, compiled = new Module(file, module);
  compiled.filename = file; compiled.paths = Module._nodeModulePaths(path.dirname(file));
  try {
    Module._load = function (id, ...args) { return id === "vscode" ? stub : load.call(this, id, ...args); };
    compiled._compile(fs.readFileSync(file, "utf8"), file);
  } finally { Module._load = load; }
  state.run = () => { selection = 0; return compiled.exports.managePythonPackages(action, f.store, f.store.read(), f.storage, () => {}); };
  return state;
}

test("genuine 4.0.22 manual missing-pins plan becomes an explicit offline local-wheel install; originals/cached tables stay intact", async t => {
  const f = await fixture(t), before = f.store.read().digest;
  const snapshots = [f.keep, f.drop].map(e => fs.readFileSync(packages.environmentSnapshotFile(f.storage, e), "utf8"));
  const otherSource = packages.inspectPythonPackageSource(f.drop);
  const file = path.join(f.root, "old-pyenvs.cjs");
  fs.writeFileSync(file, execFileSync("unzip", ["-p", path.resolve("personal-knowledge-4.0.22.vsix"), "extension/dist/servers/pyenvs.js"]));
  const old = require(file), legacy = path.join(f.root, "old-registry"); old.initPyenvs(legacy);
  fs.writeFileSync(path.join(legacy, "registry.json"), JSON.stringify([f.keep, f.drop].map(e => ({
    id: e.id, name: e.name, manager: e.manager, path: e.root, python: e.executors[0].executable,
  }))));
  for (const e of [f.keep, f.drop]) fs.writeFileSync(path.join(legacy, `${e.id}.packages.json`), JSON.stringify(packages.readPythonPackageSnapshot(f.storage, e).snapshot));
  const script = await old.pyenvMergeScript(f.keep.id, f.drop.id);
  assert.match(script.script, /python -m pip install.*pkm_demo==1\.0/);
  assert.equal(script.keep, install.planMissingWheelInstall(f.storage, f.keep, f.drop).keep.name);
  const ui = native(f); await ui.run();
  assert(!fs.existsSync(path.join(f.storage, "next-environment-maintenance"))); assert.equal(f.store.read().digest, before);
  ui.approved = true; await ui.run();
  assert.match(ui.warnings[0], /--no-index --no-deps/); assert.match(ui.warnings[0], /NOT an atomic/);
  assert.equal(execFileSync(f.keep.executors[0].executable, ["-I", "-B", "-c", "import pkm_demo;print(pkm_demo.value)"],
    { env: { HOME: f.root, TMPDIR: f.root }, encoding: "utf8" }).trim(), "42");
  assert.equal(f.store.read().digest, before); assert.deepEqual(packages.inspectPythonPackageSource(f.drop), otherSource);
  assert.deepEqual([f.keep, f.drop].map(e => fs.readFileSync(packages.environmentSnapshotFile(f.storage, e), "utf8")), snapshots);
  assert.equal(packages.readPythonPackageSnapshot(f.storage, f.keep).sourceMatches, false);
  assert(fs.existsSync(f.drop.root));
  console.log("Actual isolated wheel installed: pkm_demo 1.0; import value=42; no source/deletion or automatic refresh.");
});

test("traversal, entrypoints, foreign namespace and escaping RECORD wheels refuse before pip changes the synthetic prefix", async t => {
  const f = await fixture(t), source = packages.inspectPythonPackageSource(f.keep), victim = path.join(f.root, "victim");
  fs.writeFileSync(victim, "keep");
  for (const [extra, record] of [[{ "../victim": "erase" }, ""], [{ "pkm_demo-1.0.dist-info/entry_points.txt": "[console_scripts]\npython=pkm_demo:main" }, ""],
    [{ "pip/__init__.py": "overwrite" }, ""], [{}, "../../../victim"], [{ "pkm_demo/native.py": "\u0000" }, ""]]) {
    f.archive(extra, record);
    await assert.rejects(install.installMissingWheels(f.options()), /unsafe wheel|Only a new Python|RECORD must|Invalid Python wheel/);
    assert.deepEqual(packages.inspectPythonPackageSource(f.keep), source);
    assert.equal(fs.readFileSync(victim, "utf8"), "keep");
  }
  f.archive();
  const site = path.join(f.keep.root, "lib", fs.readdirSync(path.join(f.keep.root, "lib"))[0], "site-packages", "pkm_demo");
  fs.mkdirSync(site);
  fs.writeFileSync(path.join(site, "__init__.py"), "value = 99\n");
  await assert.rejects(install.installMissingWheels(f.options()), /existing namespace/);
  assert.equal(fs.readFileSync(path.join(site, "__init__.py"), "utf8"), "value = 99\n");
});

test("decline/digest drift/cancel never install; forged merge targets and external prefixes are not mutation capabilities", async t => {
  const f = await fixture(t), source = packages.inspectPythonPackageSource(f.keep), ui = native(f);
  ui.approved = true; ui.mutate = () => fs.appendFileSync(f.wheel, "changed");
  await assert.rejects(ui.run(), /Selected wheel changed/);
  assert(!fs.existsSync(path.join(f.storage, "next-environment-maintenance")));
  f.archive();
  const options = f.options(), cancel = new AbortController(); cancel.abort();
  await assert.rejects(install.installMissingWheels({ ...options, signal: cancel.signal }), /cancelled/);
  await assert.rejects(install.installMissingWheels({ ...options,
    plan: { ...options.plan, keep: { ...options.plan.keep, root: f.drop.root } } }), /Interpreter does not match/);
  assert.deepEqual(packages.inspectPythonPackageSource(f.keep), source);
  const root = path.join(f.root, "external-copy");
  fs.cpSync(f.keep.root, root, { recursive: true, dereference: false });
  fs.chmodSync(root, 0o700);
  const external = { ...f.keep, id: "external-copy", root, executors: [{ id: "python", executable: path.join(root, "bin/python") }] };
  f.store.register(external, f.store.read().digest);
  const snapshot = packages.readPythonPackageSnapshot(f.storage, f.keep).snapshot;
  fs.writeFileSync(packages.environmentSnapshotFile(f.storage, external, true), JSON.stringify({
    ...snapshot, source: packages.inspectPythonPackageSource(external),
  }), { mode: 0o600 });
  assert.throws(() => install.planMissingWheelInstall(f.storage, external, f.drop), /only this trial's created synthetic/);
});
