const test = require("node:test"), assert = require("node:assert/strict");
const fs = require("node:fs"), path = require("node:path"), Module = require("node:module");
const { execFileSync } = require("node:child_process"), { randomUUID } = require("node:crypto");
const build = process.env.PKM_ENV_AUTHORITY_BUILD;
if (!build || !path.isAbsolute(build)) throw Error("Set absolute PKM_ENV_AUTHORITY_BUILD; isolated fixtures only.");
const { LocalEnvironmentCatalog } = require(path.join(build, "runtime/local-environment-catalog.js"));
const { PythonEnvironmentAuthority } = require(path.join(build, "runtime/python-environment-authority.js"));
const api = require(path.join(build, "runtime/local-python-management.js"));
const packages = require(path.join(build, "runtime/local-python-packages.js"));
const action = "Create offline Python venv with bundled pip";
function fixture(t) {
  const root = path.resolve("tests", `.bundled-pip-${randomUUID()}`), storage = path.join(root, "profile");
  fs.mkdirSync(storage, { recursive: true, mode: 0o700 });
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const prefix = path.join(root, "original");
  execFileSync("/usr/bin/python3", ["-I", "-B", "-m", "venv", "--without-pip", prefix],
    { env: { HOME: root, TMPDIR: root } });
  const entry = { id: "original-python", name: "Original", language: "python", kind: "environment", manager: "venv",
    root: prefix, executors: [{ id: "python", executable: path.join(prefix, "bin/python") }] };
  const store = new LocalEnvironmentCatalog(path.join(storage, "next-local-environments"));
  store.register(entry, store.read().digest);
  const authority = new PythonEnvironmentAuthority(() => true, () => [{
    id: entry.id, name: entry.name, manager: entry.manager, path: entry.root, python: entry.executors[0].executable,
  }]);
  const base = authority.select("workspace", "local:owner", entry.id);
  t.after(() => authority.revoke());
  const check = () => authority.validate(base, "workspace", "local:owner");
  return { root, storage, entry, store, base, check,
    create: (target, extra = {}) => api.createOfflinePythonEnvironment({
      storage, entry: target, store, base, expected: store.read().digest, check, ...extra,
    }) };
}
function probe(prefix, root) {
  return JSON.parse(execFileSync(path.join(prefix, "bin/python"), ["-I", "-B", "-c",
    "import sys,json,os,pip;print(json.dumps({'prefix':sys.prefix,'file':os.path.realpath(pip.__file__),'version':pip.__version__}))"],
  { env: { HOME: root, TMPDIR: root }, encoding: "utf8" }));
}
function native(f, enabled = true) {
  const commands = new Map(), errors = [], warnings = [], menus = [], infos = [];
  const state = { approved: false, trusted: true, afterModal: undefined, selectedAction: action };
  const stub = { ProgressLocation: { Notification: 1 },
    workspace: { get isTrusted() { return state.trusted; }, workspaceFolders: [],
      getConfiguration() { return { get() { return enabled; } }; } },
    commands: { registerCommand(name, callback) { commands.set(name, callback); return { dispose() {} }; } },
    window: {
      showQuickPick: async items => {
        if (typeof items[0] === "string") {
          if (items.includes("Inspect registered environments")) menus.push(items);
          return items.includes(state.selectedAction) ? state.selectedAction : undefined;
        }
        return items.find(item => item.description === f.entry.id);
      },
      showInputBox: async options => options.prompt.startsWith("New synthetic") ? "bundled-pip" : "",
      showWarningMessage: async (_, options, button) => {
        assert(options.modal); warnings.push(options.detail); state.afterModal?.();
        return state.approved ? button : undefined;
      },
      showInformationMessage: async message => infos.push(message),
      showErrorMessage: async message => errors.push(message),
      withProgress: async (_, callback) => callback({ report() {} }, {
        isCancellationRequested: false, onCancellationRequested() { return { dispose() {} }; },
      }),
      createTerminal() { throw Error("Creation must not grant terminal execution."); },
    },
  };
  const file = path.join(build, "ui/next-local-environments.js"), load = Module._load, compiled = new Module(file, module);
  compiled.filename = file; compiled.paths = Module._nodeModulePaths(path.dirname(file));
  try {
    Module._load = function (id, ...args) { return id === "vscode" ? stub : load.call(this, id, ...args); };
    compiled._compile(fs.readFileSync(file, "utf8"), file);
  } finally { Module._load = load; }
  const owner = { pythonWorkspaceId() { return "workspace"; } };
  compiled.exports.registerNextLocalEnvironments({ subscriptions: [], globalStorageUri: { fsPath: f.storage } }, () => owner);
  return { state, warnings, menus, errors, infos, run: () => commands.get("personalKnowledge.nextTrialEnvironments")() };
}

test("real 4.0.22 venv creation and explicitly approved Next creation both install prefix-local pip from existing wheels", async t => {
  const f = fixture(t), before = packages.inspectPythonPackageSource(f.entry);
  const oracle = path.join(f.root, "old-pyenvs.cjs");
  fs.writeFileSync(oracle, execFileSync("unzip", ["-p", path.resolve("personal-knowledge-4.0.22.vsix"), "extension/dist/servers/pyenvs.js"]));
  const old = require(oracle); old.initPyenvs(path.join(f.root, "old-registry"));
  const env = { HOME: f.root, TMPDIR: f.root, TMP: f.root, TEMP: f.root,
    PYTHONDONTWRITEBYTECODE: "1", PIP_CONFIG_FILE: "/dev/null", PIP_NO_INDEX: "1", PIP_DISABLE_PIP_VERSION_CHECK: "1" };
  const saved = Object.fromEntries(Object.keys(env).map(key => [key, process.env[key]]));
  let legacy;
  try {
    Object.assign(process.env, env);
    legacy = await old.pyenvCreate({ manager: "venv", name: "old-with-pip", parentDir: f.root,
      baseInterpreter: f.entry.executors[0].executable });
  } finally {
    for (const [key, value] of Object.entries(saved)) if (value === undefined) delete process.env[key]; else process.env[key] = value;
  }
  assert.equal(legacy.ok, true, legacy.log);
  const oldPip = probe(legacy.env.path, f.root), ui = native(f);
  ui.state.approved = true; await ui.run();
  assert.deepEqual(ui.errors, []);
  const created = f.store.read().catalog.entries.find(entry => entry.id !== f.entry.id); assert(created);
  const nextPip = probe(created.root, f.root);
  assert.equal(nextPip.prefix, created.root); assert(nextPip.file.startsWith(`${created.root}/`));
  assert.equal(nextPip.version, oldPip.version);
  console.log(`Existing-wheel fixture pip: old=${oldPip.version}; Next=${nextPip.version}`);
  assert.match(ui.warnings[0], /ensurepip\.bootstrap/);
  assert.match(ui.warnings[0], /Installation is not rolled back/);
  assert.equal(JSON.parse(fs.readFileSync(path.join(created.root, ".pkm-creation.json"))).bundledPip, true);
  assert.deepEqual(packages.inspectPythonPackageSource(f.entry), before);
  assert.equal(execFileSync(f.entry.executors[0].executable, ["-I", "-B", "-c",
    "import importlib.util;print(importlib.util.find_spec('pip'))"], { encoding: "utf8" }).trim(), "None");
  const authority = new PythonEnvironmentAuthority(() => true, () => [{
    id: created.id, name: created.name, manager: created.manager, path: created.root, python: created.executors[0].executable,
  }]);
  try {
    const handle = authority.select("workspace", "local:owner", created.id);
    const snapshot = await packages.refreshPipPackageSnapshot({ storage: f.storage, store: f.store, entry: created,
      expected: f.store.read().digest, authority, handle, check() { authority.validate(handle, "workspace", "local:owner"); } });
    assert(snapshot.packages.some(pkg => pkg.name === "pip" && pkg.version === nextPip.version));
  } finally { authority.revoke(); }
});

test("native decline/trust loss/default gate leave files and registration alone; original no-pip creation remains available", async t => {
  const f = fixture(t), ui = native(f), digest = f.store.read().digest;
  await ui.run();
  assert.equal(ui.warnings.length, 1); assert(!fs.existsSync(path.join(f.storage, "next-synthetic-python")));
  ui.state.approved = true; ui.state.afterModal = () => { ui.state.trusted = false; };
  await ui.run(); assert.match(ui.errors.at(-1), /trusted workspace/);
  assert.equal(f.store.read().digest, digest); assert(!fs.existsSync(path.join(f.storage, "next-synthetic-python")));
  const ordinary = native(f, false); ordinary.state.approved = true; await ordinary.run();
  assert(!ordinary.menus[0].includes(action)); assert.equal(f.store.read().digest, digest);
  const target = api.planPythonCreation(f.storage, "without-pip", "");
  await f.create(target);
  assert.equal(execFileSync(target.executors[0].executable, ["-I", "-B", "-c",
    "import importlib.util;print(importlib.util.find_spec('pip'))"], { encoding: "utf8" }).trim(), "None");
});

test("cancel before bootstrap retains an unregistered empty venv/receipt without replay; bundled mode refuses manager-provider creation", async t => {
  const f = fixture(t), target = api.planPythonCreation(f.storage, "cancelled-bootstrap", ""), digest = f.store.read().digest;
  const cancellation = new AbortController();
  await assert.rejects(f.create(target, { bundledPip: true, signal: cancellation.signal,
    report() { cancellation.abort(); } }), /cancelled.*Files were kept/s);
  assert.equal(f.store.read().digest, digest); assert(fs.existsSync(path.join(target.root, ".pkm-creation.json")));
  assert.equal(execFileSync(target.executors[0].executable, ["-I", "-B", "-c",
    "import importlib.util;print(importlib.util.find_spec('pip'))"], { encoding: "utf8" }).trim(), "None");
  await assert.rejects(f.create(target, { bundledPip: true }), /EEXIST/);
  const conda = api.planPythonCreation(f.storage, "not-conda", "", "conda");
  await assert.rejects(f.create(conda, { bundledPip: true, provider: { manager: "conda", async provision() {
    throw Error("Provider must not run.");
  } } }), /restricted/);
  assert(!fs.existsSync(conda.root));
});
