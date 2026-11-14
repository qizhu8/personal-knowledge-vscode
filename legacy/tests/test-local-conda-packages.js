const test = require("node:test"), assert = require("node:assert/strict");
const fs = require("node:fs"), path = require("node:path"), Module = require("node:module");
const { randomUUID, createHash } = require("node:crypto");
const build = process.env.PKM_ENV_AUTHORITY_BUILD, executable = process.env.PKM_TEST_CONDA_EXECUTABLE;
const prefix = process.env.PKM_TEST_EXISTING_CONDA_PREFIX;
if (!build || !executable || !prefix) throw new Error("Explicit isolated Root build, installed conda and synthetic existing prefix are required.");
const { LocalEnvironmentCatalog } = require(path.join(build, "runtime/local-environment-catalog.js"));
const { LocalPythonManagerAuthority } = require(path.join(build, "runtime/local-python-managers.js"));
const api = require(path.join(build, "runtime/local-conda-packages.js"));
const legacy = require(path.join(build, "servers/pyenvs.js"));
function fixture(t) {
  const root = path.resolve("tests", `.conda-package-view-${randomUUID()}`);
  const storage = path.join(root, "profile"), source = path.join(root, "prefix");
  fs.mkdirSync(storage, { recursive: true, mode: 0o700 });
  fs.cpSync(prefix, source, { recursive: true, dereference: false });
  const store = new LocalEnvironmentCatalog(path.join(storage, "next-local-environments"));
  const entry = { id: "next-only-conda", name: "Current Next conda", language: "python", kind: "environment",
    manager: "conda", root: source, executors: [{ id: "python", executable: path.join(source, "bin/python") }] };
  store.register(entry, store.read().digest);
  const authority = new LocalPythonManagerAuthority(() => true), tool = authority.selectCondaQuery(executable);
  const options = () => ({ storage, store, entry: store.read().catalog.entries[0], expected: store.read().digest,
    authority, tool, check() {} });
  t.after(() => { authority.revoke(); fs.rmSync(root, { recursive: true, force: true }); });
  const cachedBytes = () => {
    const file = path.join(storage, "next-local-environments/package-snapshots",
      createHash("sha256").update(entry.id).digest("hex") + ".json");
    return fs.readFileSync(file, "utf8");
  };
  return { root, storage, source, store, entry, authority, tool, options, cachedBytes };
}
test("Next catalog package table: real installed conda refresh, explicit native UI decisions, restart cached view without tool execution", async t => {
  const f = fixture(t), legacyRoot = path.join(f.root, "legacy-registry");
  legacy.initPyenvs(legacyRoot);
  legacy.pyenvAdd({ name: "Unrelated legacy entry", manager: "other", path: "/not-the-next-prefix", python: "/unavailable" });
  const beforeLegacy = fs.readFileSync(path.join(legacyRoot, "registry.json"), "utf8");
  assert.throws(() => f.authority.provider(f.tool, { pythonVersion: "3.11" }), /cannot provision/);
  let pickerCount = 0, modalCount = 0, spawned = 0; const documents = [], notices = [];
  const stub = { ProgressLocation: { Notification: 1 }, window: {
    showQuickPick: async items => items.find(item => item.description === f.entry.id),
    showOpenDialog: async () => { pickerCount++; return [{ fsPath: executable }]; },
    showWarningMessage: async (_, options, button) => { assert(options.modal); modalCount++; return button; },
    showInformationMessage: async message => notices.push(message),
    withProgress: async (_, task) => task({ report(value) { assert.equal(value.message, "conda-package-list"); spawned++; } },
      { isCancellationRequested: false, onCancellationRequested() { return { dispose() {} }; } }),
    showTextDocument: async document => documents.push(document),
  }, workspace: { openTextDocument: async options => options } };
  const load = Module._load;
  Module._load = function (id, ...args) { return id === "vscode" ? stub : load.call(this, id, ...args); };
  let ui;
  try { ui = require(path.join(build, "ui/next-conda-packages.js")); } finally { Module._load = load; }
  const invoke = action => ui.manageCondaPackages(action, new LocalEnvironmentCatalog(path.join(f.storage, "next-local-environments")),
    f.store.read(), f.storage, () => {});
  await invoke(ui.condaPackageActions[0]);
  assert.equal(pickerCount, 0); assert.equal(spawned, 0); assert.match(notices[0], /No Next package snapshot/);
  await invoke(ui.condaPackageActions[1]);
  assert.equal(pickerCount, 1); assert.equal(modalCount, 1); assert.equal(spawned, 1);
  assert.match(documents[0].content, /\| Package \| Version \|/);
  assert(documents[0].content.includes(f.entry.id) && documents[0].content.includes(f.source));
  assert.match(documents[0].content, /\| python \| 3\.11/);
  const snapshot = api.readCondaPackageSnapshot(f.storage, f.entry);
  assert(snapshot.sourceMatches && snapshot.snapshot.packages.length > 0);
  f.authority.revoke();
  await invoke(ui.condaPackageActions[0]);
  assert.equal(pickerCount, 1); assert.equal(modalCount, 1); assert.equal(spawned, 1);
  assert.equal(documents[1].content, documents[0].content);
  assert.equal(fs.readFileSync(path.join(legacyRoot, "registry.json"), "utf8"), beforeLegacy);
});
test("real conda query cancellation, metadata drift and catalog drift retain the last successful snapshot", async t => {
  const f = fixture(t); await api.refreshCondaPackageSnapshot(f.options());
  const previous = f.cachedBytes();
  const signal = new AbortController();
  await assert.rejects(api.refreshCondaPackageSnapshot({ ...f.options(), signal: signal.signal,
    report() { signal.abort(); } }), /cancelled/i);
  assert.equal(f.cachedBytes(), previous);
  const record = path.join(f.source, "conda-meta", fs.readdirSync(path.join(f.source, "conda-meta")).find(n => n.endsWith(".json")));
  const bytes = fs.readFileSync(record);
  await assert.rejects(api.refreshCondaPackageSnapshot({ ...f.options(),
    report() { fs.appendFileSync(record, "\n"); } }), /changed/);
  assert.equal(f.cachedBytes(), previous); fs.writeFileSync(record, bytes);
  await assert.rejects(api.refreshCondaPackageSnapshot({ ...f.options(),
    report() { f.store.editPython(f.entry.id, "Concurrent name edit", "", f.store.read().digest); } }), /changed/);
  assert.equal(f.cachedBytes(), previous);
  await assert.rejects(api.refreshCondaPackageSnapshot({ ...f.options(), tool: { ...f.tool } }), /not native/);
  assert.equal(f.cachedBytes(), previous);
});
test("cached data is historical when source disappears and never follows an ID rebound to another prefix", async t => {
  const f = fixture(t); await api.refreshCondaPackageSnapshot(f.options());
  fs.renameSync(f.source, f.source + "-offline");
  const historical = api.readCondaPackageSnapshot(f.storage, f.entry);
  assert.equal(historical.sourceMatches, false); assert(historical.snapshot.packages.length > 0);
  fs.renameSync(f.source + "-offline", f.source);
  const rebound = path.join(f.root, "other-prefix"); fs.cpSync(f.source, rebound, { recursive: true });
  f.store.rebindPython(f.entry.id, rebound, f.store.read().digest);
  assert.throws(() => api.readCondaPackageSnapshot(f.storage, f.store.read().catalog.entries[0]), /another catalog binding/);
});
test("directory-sync failure after atomic snapshot rename reports possibly published state rather than a false rollback", async t => {
  const f = fixture(t); await api.refreshCondaPackageSnapshot(f.options());
  const previous = f.cachedBytes(), sync = fs.fsyncSync;
  fs.fsyncSync = fd => { if (fs.fstatSync(fd).isDirectory()) throw new Error("Injected directory-sync failure"); return sync(fd); };
  try { await assert.rejects(api.refreshCondaPackageSnapshot(f.options()), /publication may already be visible/); }
  finally { fs.fsyncSync = sync; }
  assert.notEqual(f.cachedBytes(), previous);
  assert(api.readCondaPackageSnapshot(f.storage, f.entry).sourceMatches);
});
