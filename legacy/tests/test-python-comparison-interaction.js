const test = require("node:test"), assert = require("node:assert/strict");
const fs = require("node:fs"), path = require("node:path"), vm = require("node:vm"), Module = require("node:module");
const { execFileSync } = require("node:child_process"), { randomUUID } = require("node:crypto");
const build = process.env.PKM_ENV_AUTHORITY_BUILD;
if (!build || !path.isAbsolute(build)) throw Error("Set absolute PKM_ENV_AUTHORITY_BUILD; isolated fixtures only.");
const { LocalEnvironmentCatalog } = require(path.join(build, "runtime/local-environment-catalog.js"));
const api = require(path.join(build, "runtime/local-python-packages.js"));
const analytics = require(path.join(build, "runtime/local-python-analytics.js"));
const action = "Browse and filter Python package comparison";

function fixture(t, identical = false) {
  const root = path.resolve("tests", `.comparison-${randomUUID()}`), storage = path.join(root, "profile");
  fs.mkdirSync(storage, { recursive: true, mode: 0o700 });
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const store = new LocalEnvironmentCatalog(path.join(storage, "next-local-environments"));
  function prefix(id, packages) {
    const dir = path.join(root, id);
    execFileSync("/usr/bin/python3", ["-I", "-B", "-m", "venv", "--without-pip", dir],
      { env: { HOME: root, TMPDIR: root } });
    const site = path.join(dir, "lib", fs.readdirSync(path.join(dir, "lib"))[0], "site-packages");
    for (const [name, version] of packages) {
      const record = path.join(site, `${name}-${version}.dist-info`);
      fs.mkdirSync(record);
      fs.writeFileSync(path.join(record, "METADATA"), `Metadata-Version: 2.1\nName: ${name}\nVersion: ${version}\n`);
    }
    const entry = { id, name: id, root: dir, manager: "venv", language: "python", kind: "environment",
      executors: [{ id: "python", executable: path.join(dir, "bin/python") }] };
    store.register(entry, store.read().digest);
    const measured = JSON.parse(execFileSync(entry.executors[0].executable, ["-I", "-B", "-c",
      "import sys,json,importlib.metadata as m;print(json.dumps({'root':sys.prefix,'packages':[{'name':d.metadata['Name'],'version':d.version} for d in m.distributions()]}))"],
    { env: { HOME: root, TMPDIR: root }, encoding: "utf8" }));
    assert.equal(measured.root, dir);
    const snapshot = { schema: "pkm.local-pip-packages/v1", capturedAt: new Date().toISOString(),
      source: api.inspectPythonPackageSource(entry), packages: measured.packages };
    fs.writeFileSync(api.environmentSnapshotFile(storage, entry, true), JSON.stringify(snapshot), { mode: 0o600 });
    return entry;
  }
  const sourcePackages = [["alpha-same", "2"], ["beta-up", "2"], ["gamma-down", "10"], ["delta-only-a", "1"], ["zeta-same", "1"]];
  const a = prefix("source-a", sourcePackages);
  const b = prefix("target-b", identical ? sourcePackages
    : [["alpha-same", "2"], ["beta-up", "10"], ["gamma-down", "2"], ["epsilon-only-b", "1"], ["zeta-same", "1"]]);
  return { root, storage, store, a, b };
}

function native(f, choose) {
  const notices = [], reports = [];
  let selection = 0;
  const stub = { QuickPickItemKind: { Separator: -1 }, window: {
    showQuickPick: async (items, options) => options?.title ? choose(items, options) : items.find(i => i.entry.id === [f.a.id, f.b.id][selection++]),
    showInformationMessage: async text => notices.push(text),
    showTextDocument: async doc => reports.push(doc),
    showWarningMessage() { throw Error("Comparison must not ask to execute a manager."); },
    withProgress() { throw Error("Comparison must not run a query."); },
    createTerminal() { throw Error("Comparison must not deliver terminal code."); },
  }, workspace: { openTextDocument: async doc => doc } };
  const file = path.join(build, "ui/next-python-packages.js"), load = Module._load, compiled = new Module(file, module);
  compiled.filename = file; compiled.paths = Module._nodeModulePaths(path.dirname(file));
  try {
    Module._load = function (id, ...args) { return id === "vscode" ? stub : load.call(this, id, ...args); };
    compiled._compile(fs.readFileSync(file, "utf8"), file);
  } finally { Module._load = load; }
  return { notices, reports, run(check = () => {}, selectedAction = action) {
    selection = 0;
    return compiled.exports.managePythonPackages(selectedAction, f.store, f.store.read(), f.storage, check);
  } };
}

function saved(f) {
  return [f.a, f.b].map(entry => fs.readFileSync(api.environmentSnapshotFile(f.storage, entry), "utf8"));
}

test("real isolated Python metadata and genuine 4.0.22 Compare support hide-unchanged and every tri-state sort without changing snapshots", async t => {
  const f = fixture(t), before = saved(f), digest = f.store.read().digest;
  const vsix = path.resolve("personal-knowledge-4.0.22.vsix"), oracleFile = path.join(f.root, "old-pyenvs.cjs");
  fs.writeFileSync(oracleFile, execFileSync("unzip", ["-p", vsix, "extension/dist/servers/pyenvs.js"]));
  const old = require(oracleFile), oldStorage = path.join(f.root, "old-registry"); old.initPyenvs(oldStorage);
  fs.writeFileSync(path.join(oldStorage, "registry.json"), JSON.stringify([f.a, f.b].map(e => ({
    id: e.id, name: e.name, manager: e.manager, path: e.root, python: e.executors[0].executable,
  }))));
  for (const entry of [f.a, f.b]) fs.writeFileSync(path.join(oldStorage, `${entry.id}.packages.json`), JSON.stringify(api.readPythonPackageSnapshot(f.storage, entry).snapshot));
  const comparison = await old.pyenvCompare(f.a.id, f.b.id);
  assert.deepEqual(analytics.comparePythonSnapshots(f.storage, f.a, f.b).rows, comparison.rows);
  const hide = { checked: false }, body = { innerHTML: "" }, head = { innerHTML: "" };
  const context = vm.createContext({ payload: comparison, esc: value => String(value),
    document: { getElementById: id => ({ "cmp-hide-same": hide, "cmp-tbody": body, "cmp-thead": head })[id] } });
  vm.runInContext(execFileSync("unzip", ["-p", vsix, "extension/src/webview/panel/30-environments.js"], { encoding: "utf8" }), context);
  vm.runInContext("_cmpData = payload", context);
  const steps = ["Hide unchanged packages", ...["Change type", "Package", "A version", "B version"].flatMap(col => Array(3).fill(`Sort by ${col}`)),
    "Show unchanged packages", "beta-up"];
  let rounds = 0;
  const ui = native(f, (items, options) => {
    rounds++;
    const expected = JSON.parse(JSON.stringify(vm.runInContext("cmpSortRows()", context))).filter(row => !hide.checked || row.status !== "same");
    assert.deepEqual(items.filter(item => item.row).map(item => item.row), expected);
    const step = steps.shift();
    if (!step) return;
    const selected = items.find(item => item.label === step); assert(selected, step);
    if (selected.toggle) {
      hide.checked = !hide.checked; vm.runInContext("renderCmpBody()", context);
      assert.equal((body.innerHTML.match(/display:none/g) || []).length, hide.checked ? comparison.counts.same : 0);
    } else if (selected.column) vm.runInContext(`sortCmp(${JSON.stringify(selected.column)})`, context);
    else {
      assert(selected.row);
      // This is the searchable native item surface, not a claim to test Code's widget.
      assert.match(`${selected.label} ${selected.description}`, /beta-up.*10.*upgrade/);
    }
    return selected;
  });
  await ui.run();
  assert.equal(rounds, 16); assert.equal(ui.notices.length, 1);
  assert.match(ui.notices[0], /beta-up\nsource-a: 2\ntarget-b: 10\nupgrade/);
  assert.deepEqual(saved(f), before); assert.equal(f.store.read().digest, digest);
  assert.deepEqual(api.inspectPythonPackageSource(f.a), JSON.parse(before[0]).source);
  assert.deepEqual(api.inspectPythonPackageSource(f.b), JSON.parse(before[1]).source);
  await ui.run(() => {}, "Compare registered Python package snapshots");
  assert.match(ui.reports[0].content, /Python package comparison/);
});

test("comparison stays usable for historical missing prefixes and empty changed-only views; cancel never refreshes", async t => {
  const f = fixture(t), before = saved(f), digest = f.store.read().digest;
  fs.renameSync(f.a.root, `${f.a.root}-offline`);
  let round = 0;
  const ui = native(f, (items, options) => {
    assert.match(options.placeHolder, /Historical/);
    round++;
    if (round === 1) return items.find(item => item.row?.name === "alpha-same");
  });
  await ui.run();
  assert.match(ui.notices[0], /historical/); assert.equal(round, 2);
  const same = fixture(t, true), sameBefore = saved(same);
  let emptyRound = 0;
  const empty = native(same, items => {
    if (++emptyRound === 1) return items.find(item => item.toggle);
    assert.equal(items.filter(item => item.row).length, 0);
    assert(items.some(item => item.label === "Show unchanged packages"));
  });
  await empty.run(); assert.equal(emptyRound, 2);
  assert.deepEqual(saved(same), sameBefore);
  assert.deepEqual(saved(f), before); assert.equal(f.store.read().digest, digest);
  assert(!fs.existsSync(path.join(f.storage, "next-environment-maintenance")));
});

test("cancel, catalog drift and trust revocation stop row delivery with no cache writes or execution", async t => {
  const f = fixture(t), before = saved(f), digest = f.store.read().digest;
  const cancelled = native(f, () => undefined); await cancelled.run();
  assert.equal(cancelled.notices.length, 0);
  let trusted = true;
  const revoked = native(f, items => { trusted = false; return items.find(item => item.row); });
  await assert.rejects(revoked.run(() => { if (!trusted) throw Error("trust revoked"); }), /trust revoked/);
  assert.equal(revoked.notices.length, 0); assert.equal(f.store.read().digest, digest);
  const stale = native(f, items => {
    f.store.editPython(f.a.id, "Concurrent edit", "", f.store.read().digest);
    return items.find(item => item.row);
  });
  await assert.rejects(stale.run(), /Catalog changed/); assert.equal(stale.notices.length, 0);
  assert.deepEqual(saved(f), before);
  assert(!fs.existsSync(path.join(f.storage, "next-environment-maintenance")));
});
