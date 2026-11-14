const test = require("node:test"), assert = require("node:assert/strict");
const fs = require("node:fs"), path = require("node:path"), Module = require("node:module");
const { execFileSync } = require("node:child_process"), { randomUUID } = require("node:crypto");
const build = process.env.PKM_ENV_AUTHORITY_BUILD;
if (!build || !process.env.PKM_TEST_PYTHON) throw Error("Explicit Root build and installed Python required.");
const { LocalEnvironmentCatalog } = require(path.join(build, "runtime/local-environment-catalog.js"));
const { PythonEnvironmentAuthority } = require(path.join(build, "runtime/python-environment-authority.js"));
const api = require(path.join(build, "runtime/local-python-packages.js"));
const analytics = require(path.join(build, "runtime/local-python-analytics.js"));
const inspection = require(path.join(build, "runtime/local-python-inspection.js"));
const merge = require(path.join(build, "runtime/local-python-merge.js"));
function fixture(t) {
  const root = path.resolve("tests", ".pip-packages-" + randomUUID()), storage = path.join(root, "profile");
  fs.mkdirSync(storage, { recursive: true, mode: 0o700 });
  const store = new LocalEnvironmentCatalog(path.join(storage, "next-local-environments"));
  function add(id, installedPip = true) {
    const prefix = path.join(root, id);
    execFileSync(process.env.PKM_TEST_PYTHON, ["-I", "-B", "-m", "venv", "--without-pip",
      ...(installedPip ? ["--system-site-packages"] : []), prefix], { env: { PATH: "/usr/bin:/bin", HOME: root, TMPDIR: root } });
    const entry = { id, name: id, root: prefix, manager: "venv", language: "python", kind: "environment",
      executors: [{ id: "python", executable: path.join(prefix, "bin/python") }] };
    store.register(entry, store.read().digest);
    return entry;
  }
  const authority = new PythonEnvironmentAuthority(() => true, () => store.read().catalog.entries.map(e => ({
    id: e.id, name: e.name, manager: e.manager, path: e.root, python: e.executors[0].executable, pyVersion: analytics.pythonAnalysisEntry(e).pyVersion,
  })));
  const options = entry => ({ storage, store, entry, expected: store.read().digest, check() {}, authority,
    handle: authority.select("inspection", "local:owner", entry.id) });
  function record(entry, name, version) {
    const lib = path.join(entry.root, "lib", fs.readdirSync(path.join(entry.root, "lib"))[0], "site-packages");
    const target = path.join(lib, name.replace(/-/g, "_") + "-" + version + ".dist-info");
    fs.mkdirSync(target); fs.writeFileSync(path.join(target, "METADATA"), `Metadata-Version: 2.1\nName: ${name}\nVersion: ${version}\n`);
  }
  t.after(() => { authority.revoke(); fs.rmSync(root, { recursive: true, force: true }); });
  return { root, storage, store, add, options, record, authority };
}
test("real existing pip, native refresh/cache UI, old five-status comparison and Jaccard semantics without installation", async t => {
  const f = fixture(t), a = f.add("pip-a"), b = f.add("pip-b");
  for (const [name, va, vb] of [["pkm-same", "1.0", "1.0"], ["pkm-up", "1", "2"], ["pkm-down", "2", "1"]]) {
    f.record(a, name, va); f.record(b, name, vb);
  }
  f.record(a, "pkm-only-a", "1"); f.record(b, "pkm-only-b", "1");
  fs.writeFileSync(path.join(a.root, "pip.conf"), "[list]\noutdated = true\nindex-url = https://127.0.0.1:1\n");
  let choice = a.id, modals = 0, processes = 0; const documents = [], notices = [];
  const stub = { ProgressLocation: { Notification: 1 }, window: {
    showQuickPick: async (items, options) => options?.canPickMany ? items : items.find(i => i.description === choice),
    showWarningMessage: async (_, options, button) => { assert(options.modal); modals++; return button; },
    showInformationMessage: async text => notices.push(text),
    withProgress: async (_, task) => task({ report() { processes++; } },
      { isCancellationRequested: false, onCancellationRequested() { return { dispose() {} }; } }),
    showTextDocument: async doc => documents.push(doc),
  }, workspace: { openTextDocument: async doc => doc } };
  const load = Module._load; Module._load = function (id, ...args) { return id === "vscode" ? stub : load.call(this, id, ...args); };
  let ui; try { ui = require(path.join(build, "ui/next-python-packages.js")); } finally { Module._load = load; }
  const invoke = i => ui.managePythonPackages(ui.pythonPackageActions[i], f.store, f.store.read(), f.storage, () => {});
  await invoke(0); assert.match(notices[0], /No Next pip snapshot/); assert.equal(processes, 0);
  await invoke(1); assert.equal(modals, 1); assert.match(documents.at(-1).content, /\| pkm-up \| 1 \|/);
  const before = processes; await invoke(0); assert.equal(processes, before);
  choice = b.id; await invoke(1);
  const comparison = analytics.comparePythonSnapshots(f.storage, a, b);
  for (const name of ["upgrade", "downgrade", "added", "deleted"]) assert.equal(comparison.counts[name], 1);
  assert(comparison.counts.same >= 1);
  const similarity = analytics.similarPythonSnapshots(f.storage, [a, b]);
  assert.equal(similarity.pairs.length, 1);
  assert.equal(similarity.pairs[0].score, similarity.pairs[0].shared / (similarity.pairs[0].shared + 2));
  const legacy = require(process.env.PKM_TEST_LEGACY_PYENVS);
  const old = path.join(f.root, "old-cache"); legacy.initPyenvs(old);
  const ca = api.readPythonPackageSnapshot(f.storage, a).snapshot, cb = api.readPythonPackageSnapshot(f.storage, b).snapshot;
  fs.writeFileSync(path.join(old, "registry.json"), JSON.stringify([a, b].map(e => ({
    id: e.id, name: e.name, manager: e.manager, path: e.root, python: e.executors[0].executable,
    pyVersion: analytics.pythonAnalysisEntry(e).pyVersion,
  }))));
  for (const [entry, snapshot] of [[a, ca], [b, cb]]) fs.writeFileSync(path.join(old, entry.id + ".packages.json"), JSON.stringify(snapshot));
  const oldComparison = await legacy.pyenvCompare(a.id, b.id);
  assert.deepEqual(comparison.counts, oldComparison.counts); assert.deepEqual(comparison.rows, oldComparison.rows);
  const oldSimilarity = await legacy.pyenvSimilarity();
  assert.deepEqual(similarity.pairs, oldSimilarity.pairs);
  const generated = merge.generatePythonMergeScript(f.storage, a, b), oldScript = await legacy.pyenvMergeScript(a.id, b.id);
  assert.equal(generated.keep, oldScript.keep); assert.equal(generated.drop, oldScript.drop);
  assert.match(generated.script, /pkm-only-b==1/); assert.match(generated.script, /pkm-up: keep 1 vs drop 2/);
  assert.match(generated.script, /MANUAL REVIEW ONLY/);
  const file = path.join(f.root, "manual-merge.sh"); fs.writeFileSync(file, generated.script);
  execFileSync("/bin/bash", ["-n", file]); assert(fs.existsSync(a.root) && fs.existsSync(b.root));
  const prior = processes; await invoke(3); assert.equal(processes, prior); assert.match(documents.at(-1).content, /Jaccard/);
});
test("real allocated-size/version refresh matches Linux du, caches without execution and never changes the legacy registry", async t => {
  const f = fixture(t), a = f.add("metadata-python");
  fs.writeFileSync(path.join(a.root, "sized-file"), Buffer.alloc(8192));
  fs.linkSync(path.join(a.root, "sized-file"), path.join(a.root, "hardlink"));
  fs.symlinkSync(f.root, path.join(a.root, "do-not-follow"));
  const before = f.store.read().digest;
  assert.equal(inspection.readPythonMetadataSnapshot(f.storage, a), undefined);
  const actual = await inspection.refreshPythonMetadata(f.options(a));
  const expectedSize = Number(execFileSync("/usr/bin/du", ["-sk", a.root], { encoding: "utf8" }).split(/\s+/)[0]) * 1024;
  assert.equal(actual.sizeBytes, expectedSize);
  assert.equal(actual.pyVersion, execFileSync(process.env.PKM_TEST_PYTHON, ["-I", "-B", "-c",
    "import sys; print('.'.join(map(str,sys.version_info[:3])))"], { encoding: "utf8" }).trim());
  f.authority.revoke();
  assert.deepEqual(inspection.readPythonMetadataSnapshot(f.storage, a).snapshot, actual);
  assert.equal(f.store.read().digest, before);
  const abort = new AbortController();
  await assert.rejects(inspection.refreshPythonMetadata({ ...f.options(a), signal: abort.signal, report() { abort.abort(); } }), /cancelled/);
  assert.deepEqual(inspection.readPythonMetadataSnapshot(f.storage, a).snapshot, actual);
});
test("real installed conda inventory reads only the selected private copy, explicit metadata registration stays separate and script is not run", async t => {
  const f = fixture(t), { LocalPythonManagerAuthority } = require(path.join(build, "runtime/local-python-managers.js"));
  const authority = new LocalPythonManagerAuthority(() => true), tool = authority.selectCondaQuery(process.env.PKM_TEST_CONDA_EXECUTABLE);
  t.after(() => authority.revoke());
  const source = process.env.PKM_TEST_EXISTING_CONDA_PREFIX, inventory = path.join(f.root, "selected-environments.txt");
  fs.writeFileSync(inventory, source + "\n");
  const bytes = fs.readFileSync(inventory), before = f.store.read().digest;
  const options = { storage: f.storage, store: f.store, expected: before, check() {}, authority, tool, inventoryFile: inventory };
  const result = await inspection.listInstalledCondaEnvironments(options);
  assert(result.roots.includes(source)); assert.equal(f.store.read().digest, before);
  assert.deepEqual(fs.readFileSync(inventory), bytes);
  const { inspectPythonFolder } = require(path.join(build, "runtime/local-python-management.js"));
  const entry = inspectPythonFolder(source, "Chosen inventory prefix");
  f.store.register(entry, before); assert.equal(f.store.read().catalog.entries[0].root, source);
  const script = merge.condaManualDeleteScript(entry, tool.executable);
  const file = path.join(f.root, "manual-conda-delete.sh"); fs.writeFileSync(file, script);
  execFileSync("/bin/bash", ["-n", file]); assert(fs.existsSync(path.join(source, "bin/python")));
  const abort = new AbortController(); abort.abort();
  await assert.rejects(inspection.listInstalledCondaEnvironments({ ...options, expected: f.store.read().digest, signal: abort.signal }), /cancelled/);
  const uid = process.getuid;
  process.getuid = () => 0;
  try { await assert.rejects(inspection.listInstalledCondaEnvironments(options), /administrator.*other accounts/); }
  finally { process.getuid = uid; }
  const euid = process.geteuid;
  process.geteuid = () => 0;
  try { await assert.rejects(inspection.listInstalledCondaEnvironments(options), /administrator.*other accounts/); }
  finally { process.geteuid = euid; }
});
test("missing pip is explicit, never ensurepip; cancelled, stale and forged interpreter requests retain previous cache", async t => {
  const f = fixture(t), a = f.add("pip-good");
  await api.refreshPipPackageSnapshot(f.options(a));
  const cached = JSON.stringify(api.readPythonPackageSnapshot(f.storage, a).snapshot);
  const abort = new AbortController();
  await assert.rejects(api.refreshPipPackageSnapshot({ ...f.options(a), signal: abort.signal, report() { abort.abort(); } }), /cancelled/);
  assert.equal(JSON.stringify(api.readPythonPackageSnapshot(f.storage, a).snapshot), cached);
  const options = f.options(a);
  await assert.rejects(api.refreshPipPackageSnapshot({ ...options, handle: { ...options.handle } }), /unavailable/);
  await assert.rejects(api.refreshPipPackageSnapshot({ ...f.options(a), report() {
    f.store.editPython(a.id, "Concurrent", "", f.store.read().digest);
  } }), /changed|unavailable/);
  assert.equal(JSON.stringify(api.readPythonPackageSnapshot(f.storage, a).snapshot), cached);
  const missing = f.add("pip-absent", false);
  await assert.rejects(api.refreshPipPackageSnapshot(f.options(missing)), /No module named pip/);
  assert.equal(api.readPythonPackageSnapshot(f.storage, missing), undefined);
  assert(!fs.existsSync(path.join(missing.root, "bin/pip")));
});
test("saved pip metadata change is historical, rebound IDs cannot reuse it and minor-version mismatch is excluded", async t => {
  const f = fixture(t), a = f.add("pip-first"), b = f.add("pip-second");
  await api.refreshPipPackageSnapshot(f.options(a)); await api.refreshPipPackageSnapshot(f.options(b));
  f.record(a, "pkm-later", "1");
  assert.equal(api.readPythonPackageSnapshot(f.storage, a).sourceMatches, false);
  assert.throws(() => api.readPythonPackageSnapshot(f.storage, { ...a, root: b.root, executors: b.executors }), /binding/);
  const mismatched = { ...b, legacyPython: { pyVersion: "999.1" } };
  assert.equal(analytics.similarPythonSnapshots(f.storage, [a, mismatched]).skipped, 1);
  assert.throws(() => analytics.planPythonPackageMerge(
    analytics.pythonAnalysisEntry(a), analytics.pythonAnalysisEntry(mismatched), [], []), /minor versions/);
});
