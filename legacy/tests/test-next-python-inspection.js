const test = require("node:test"), assert = require("node:assert/strict");
const fs = require("node:fs"), path = require("node:path"), Module = require("node:module");
const { execFileSync } = require("node:child_process"), { randomUUID } = require("node:crypto");
const build = process.env.PKM_ENV_AUTHORITY_BUILD;
if (!build || !process.env.PKM_TEST_PYTHON || !process.env.PKM_TEST_CONDA_EXECUTABLE || !process.env.PKM_TEST_EXISTING_CONDA_PREFIX)
  throw Error("Explicit isolated build and installed Python/conda/synthetic prefix required.");
test("native inspection adapter: actual metadata/inventory, separate registration, declined/approved clipboard-only merge and cached views", async t => {
  const root = path.resolve("tests", ".python-inspection-ui-" + randomUUID()), storage = path.join(root, "profile");
  fs.mkdirSync(storage, { recursive: true, mode: 0o700 });
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const { LocalEnvironmentCatalog } = require(path.join(build, "runtime/local-environment-catalog.js"));
  const { PythonEnvironmentAuthority } = require(path.join(build, "runtime/python-environment-authority.js"));
  const store = new LocalEnvironmentCatalog(path.join(storage, "next-local-environments"));
  const entries = [];
  for (const id of ["ui-pip-a", "ui-pip-b"]) {
    const prefix = path.join(root, id);
    execFileSync(process.env.PKM_TEST_PYTHON, ["-I", "-B", "-m", "venv", "--without-pip", "--system-site-packages", prefix],
      { env: { PATH: "/usr/bin:/bin", HOME: root, TMPDIR: root } });
    const entry = { id, name: id, root: prefix, manager: "venv", language: "python", kind: "environment",
      executors: [{ id: "python", executable: path.join(prefix, "bin/python") }] };
    entries.push(entry); store.register(entry, store.read().digest);
  }
  const authority = new PythonEnvironmentAuthority(() => true, () => entries.map(e => ({
    id: e.id, name: e.name, manager: e.manager, path: e.root, python: e.executors[0].executable,
  })));
  t.after(() => authority.revoke());
  const api = require(path.join(build, "runtime/local-python-packages.js"));
  for (const entry of entries) await api.refreshPipPackageSnapshot({ storage, store, entry, expected: store.read().digest,
    authority, handle: authority.select("ui-test", "local:owner", entry.id), check() {} });
  let picks = [], files = [], decline = false, clipboard = "keep-this", document, phases = [];
  const stub = { ProgressLocation: { Notification: 1 }, env: { clipboard: { writeText: async text => { clipboard = text; } } },
    workspace: { openTextDocument: async doc => doc }, window: {
      showQuickPick: async items => { const selected = picks.shift(); return items.find(i => typeof i === "string" ? i === selected : i.description === selected); },
      showOpenDialog: async () => { const file = files.shift(); assert(file, "Unexpected tool/source selection"); return [{ fsPath: file }]; },
      showWarningMessage: async (message, options, button) => {
        assert(options.modal);
        if (decline && message.startsWith("Copy this reviewed")) { decline = false; return undefined; }
        return button;
      },
      showInformationMessage: async () => {},
      showTextDocument: async doc => { document = doc; },
      withProgress: async (_, task) => task({ report: value => phases.push(value.message) },
        { isCancellationRequested: false, onCancellationRequested() { return { dispose() {} }; } }),
    } };
  const original = Module._load; Module._load = function (id, ...args) { return id === "vscode" ? stub : original.call(this, id, ...args); };
  let ui; try { ui = require(path.join(build, "ui/next-python-inspection.js")); } finally { Module._load = original; }
  const invoke = async (index, selected) => { picks = [...selected]; await ui.managePythonInspection(
    ui.pythonInspectionActions[index], store, store.read(), storage, () => {}); assert.deepEqual(picks, []); };
  await invoke(1, [entries[0].id]); assert.match(document.content, /Allocated:/);
  const before = phases.length;
  await invoke(0, [entries[0].id]); assert.equal(phases.length, before);
  decline = true; await invoke(3, entries.map(e => e.id)); assert.equal(clipboard, "keep-this");
  await invoke(3, entries.map(e => e.id)); assert.match(clipboard, /MANUAL REVIEW ONLY/);
  assert.equal(phases.length, before); assert(entries.every(e => fs.existsSync(e.root)));
  const source = process.env.PKM_TEST_EXISTING_CONDA_PREFIX, inventory = path.join(root, "inventory.txt");
  fs.writeFileSync(inventory, source + "\n"); const raw = fs.readFileSync(inventory);
  files = [process.env.PKM_TEST_CONDA_EXECUTABLE, inventory];
  await invoke(2, ["Selected inventory file copy", source]);
  assert.deepEqual(files, []); assert.deepEqual(fs.readFileSync(inventory), raw);
  const registered = store.read().catalog.entries.find(e => e.root === source); assert(registered);
  files = [process.env.PKM_TEST_CONDA_EXECUTABLE]; const beforeScript = phases.length;
  await invoke(4, [registered.id]); assert.match(clipboard, /env remove -y -p/);
  assert.equal(phases.length, beforeScript); assert(fs.existsSync(path.join(source, "bin/python")));
});
