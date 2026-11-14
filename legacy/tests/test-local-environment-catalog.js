const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const Module = require("node:module");
const { randomUUID, createHash } = require("node:crypto");
const { execFileSync, spawn } = require("node:child_process");

const build = process.env.PKM_ENV_AUTHORITY_BUILD;
if (!build || !path.isAbsolute(build)) throw new Error("Set PKM_ENV_AUTHORITY_BUILD to an isolated root build.");
const modulePath = path.join(build, "runtime/local-environment-catalog.js");
const { LocalEnvironmentCatalog, inspectLocalEnvironment } = require(modulePath);
const digest = file => createHash("sha256").update(fs.readFileSync(file)).digest("hex");
function fixture(t) {
  const root = path.join(fs.realpathSync(process.cwd()), "tests", `.environment-catalog-${randomUUID()}`);
  fs.mkdirSync(root, { mode: 0o700 });
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const profile = path.join(root, "legacy-profile", "environments");
  fs.mkdirSync(profile, { recursive: true, mode: 0o700 });
  const registry = path.join(profile, "registry.json");
  const venv = path.join(root, "old-venv");
  execFileSync("/usr/bin/python3", ["-m", "venv", "--without-pip", venv], { env: {}, cwd: root });
  fs.writeFileSync(registry, JSON.stringify([{ id: "old-python", name: "Old Python", manager: "venv",
    path: venv, python: path.join(venv, "bin/python"), description: "legacy metadata" }]));
  fs.writeFileSync(path.join(profile, "old-python.packages.json"), '{"capturedAt":"old","packages":[]}');
  const store = new LocalEnvironmentCatalog(path.join(root, "catalog"));
  const node = { id: "node", name: "Local Node", language: "javascript", kind: "runtime", manager: "local",
    executors: [{ id: "node", executable: fs.realpathSync(process.execPath) }] };
  return { root, profile, registry, venv, store, node };
}

test("legacy profile upgrades explicitly and idempotently; metadata removal/restore never moves or deletes runtimes", t => {
  const f = fixture(t), original = digest(f.registry);
  const packages = digest(path.join(f.profile, "old-python.packages.json"));
  const preview = f.store.previewLegacy(f.registry);
  assert.equal(f.store.read().catalog.revision, 0);
  assert(!fs.existsSync(path.join(f.root, "catalog")));
  const imported = f.store.importLegacy(f.registry, preview.sourceDigest, f.store.read().digest);
  assert.equal(imported.catalog.entries[0].kind, "environment");
  assert.equal(imported.catalog.entries[0].language, "python");
  assert.equal(f.store.importLegacy(f.registry, preview.sourceDigest, imported.digest).catalog.revision, 1);
  const registered = f.store.register(f.node, imported.digest);
  const csharp = { id: "dotnet", name: "C# executor set", language: "csharp", kind: "executor-set", manager: "local",
    executors: [{ id: "build", executable: "/missing/dotnet" }, { id: "script", executable: "/missing/csi" }] };
  const next = f.store.register(csharp, registered.digest);
  assert.equal(next.catalog.entries[2].root, undefined);
  assert.equal(inspectLocalEnvironment(csharp).issues.length, 2);
  assert(inspectLocalEnvironment(f.node).available);
  assert.equal(execFileSync(f.node.executors[0].executable, ["-e", "process.stdout.write('local-node')"], { cwd: f.root, env: {} }).toString(), "local-node");
  const removed = f.store.unregister("old-python", next.digest);
  assert(fs.existsSync(path.join(f.venv, "bin/python")));
  assert.equal(execFileSync(path.join(f.venv, "bin/python"), ["-I", "-B", "-c", "import sys; print(sys.prefix)"],
    { cwd: f.root, env: {} }).toString().trim(), f.venv);
  const restored = new LocalEnvironmentCatalog(path.join(f.root, "catalog")).restore(1, removed.digest);
  assert.deepEqual(restored.catalog.entries, imported.catalog.entries);
  assert.equal(restored.catalog.revision, 5);
  assert.equal(digest(f.registry), original);
  assert.equal(digest(path.join(f.profile, "old-python.packages.json")), packages);
  fs.renameSync(f.venv, `${f.venv}-moved`);
  assert.equal(inspectLocalEnvironment(restored.catalog.entries[0]).available, false);
  assert.equal(f.store.read().catalog.revision, 5, "Inspecting stale paths must not mutate metadata or remap automatically.");
});

test("changed source, corrupt input, ambiguous IDs and stale expected revisions fail without writes", t => {
  const f = fixture(t), preview = f.store.previewLegacy(f.registry), initial = f.store.read();
  fs.appendFileSync(f.registry, "\n");
  assert.throws(() => f.store.importLegacy(f.registry, preview.sourceDigest, initial.digest), /changed after preview/);
  assert.equal(f.store.read().catalog.revision, 0);
  const good = JSON.parse(fs.readFileSync(f.registry));
  fs.writeFileSync(f.registry, JSON.stringify([...good, good[0]]));
  assert.throws(() => f.store.previewLegacy(f.registry), /ambiguous/);
  fs.writeFileSync(f.registry, "{broken");
  assert.throws(() => f.store.previewLegacy(f.registry));
  assert.throws(() => f.store.register({ ...f.node, id: undefined }, initial.digest), /Invalid/);
  assert.throws(() => f.store.register({ ...f.node, executors: [{ id: "node", executable: "node" }] }, initial.digest), /canonical absolute/);
  const committed = f.store.register(f.node, initial.digest);
  assert.throws(() => f.store.unregister("node", initial.digest), /Catalog changed/);
  assert.equal(f.store.read().digest, committed.digest);
  assert.throws(() => f.store.restore(20, committed.digest), /Unknown/);
  fs.writeFileSync(path.join(f.root, "catalog/00000001.json"), "{}");
  assert.throws(() => f.store.read(), /Invalid/);
  assert.throws(() => f.store.register({ ...f.node, id: "other" }, committed.digest), /Invalid/);
});

test("interrupted pending files are inert; committed revisions survive reopening; links and gaps fail closed", t => {
  const f = fixture(t), committed = f.store.register(f.node, f.store.read().digest);
  fs.writeFileSync(path.join(f.root, "catalog/.pending-interrupted"), '{"partial":');
  assert.equal(new LocalEnvironmentCatalog(path.join(f.root, "catalog")).read().digest, committed.digest);
  fs.symlinkSync(f.registry, path.join(f.profile, "registry-link.json"));
  assert.throws(() => f.store.previewLegacy(path.join(f.profile, "registry-link.json")));
  const link = path.join(f.root, "linked-catalog");
  fs.symlinkSync(path.join(f.root, "catalog"), link);
  assert.throws(() => new LocalEnvironmentCatalog(link).read(), /symlink/);
  fs.renameSync(path.join(f.root, "catalog/00000001.json"), path.join(f.root, "catalog/00000002.json"));
  assert.throws(() => f.store.read(), /history is incomplete/);
});

test("two actual hosts using one expected revision cannot overwrite each other's catalog change", { timeout: 10000 }, async t => {
  const f = fixture(t), expected = f.store.read().digest;
  const code = `const {LocalEnvironmentCatalog}=require(process.argv[1]);
    process.on('message', () => { try {
      new LocalEnvironmentCatalog(process.argv[2]).register(JSON.parse(process.argv[3]), process.argv[4]);
      process.send('committed');
    } catch { process.send('conflict'); } finally { process.disconnect(); } }); process.send('ready');`;
  const children = ["a", "b"].map(id => spawn(process.execPath, ["-e", code, modulePath, path.join(f.root, "catalog"),
    JSON.stringify({ ...f.node, id }), expected], { cwd: f.root, stdio: ["ignore", "ignore", "pipe", "ipc"] }));
  t.after(() => { for (const child of children) if (child.exitCode === null) child.kill(); });
  await Promise.all(children.map(child => new Promise((resolve, reject) => {
    child.once("error", reject); child.once("message", message => { assert.equal(message, "ready"); resolve(); });
  })));
  const results = children.map(child => new Promise((resolve, reject) => {
    child.once("error", reject); child.once("message", resolve);
  }));
  for (const child of children) child.send("commit");
  assert.deepEqual((await Promise.all(results)).sort(), ["committed", "conflict"]);
  assert.equal(f.store.read().catalog.entries.length, 1);
});

for (const boundary of ["prepared", "published"]) test(`SIGKILL at ${boundary} leaves a readable catalog without replay`, { timeout: 10000 }, async t => {
  const f = fixture(t);
  const code = `const fs=require('node:fs'); const {LocalEnvironmentCatalog}=require(process.argv[1]);
    const stop=()=>{ process.send('boundary'); Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0); };
    if(process.argv[5]==='prepared') { const original=fs.fsyncSync; fs.fsyncSync=(...args)=>{original(...args);stop();}; }
    else { const original=fs.linkSync; fs.linkSync=(...args)=>{original(...args);stop();}; }
    const store=new LocalEnvironmentCatalog(process.argv[2]); store.register(JSON.parse(process.argv[3]),process.argv[4]);`;
  const child = spawn(process.execPath, ["-e", code, modulePath, path.join(f.root, "catalog"),
    JSON.stringify(f.node), f.store.read().digest, boundary], { cwd: f.root, stdio: ["ignore", "ignore", "pipe", "ipc"] });
  t.after(() => { if (child.exitCode === null && child.signalCode === null) child.kill(); });
  await new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", () => reject(new Error("Host exited before crash boundary")));
    child.once("message", resolve);
  });
  const exited = new Promise(resolve => child.once("exit", resolve));
  child.kill("SIGKILL"); await exited;
  const reopened = new LocalEnvironmentCatalog(path.join(f.root, "catalog")).read();
  assert.equal(reopened.catalog.revision, boundary === "prepared" ? 0 : 1);
  assert.equal(reopened.catalog.entries.length, boundary === "prepared" ? 0 : 1);
  assert.equal(f.store.read().digest, reopened.digest);
  assert(fs.existsSync(f.registry));
});

test("native manager requires current trusted fresh trial, explicit modal, and revalidates source and owner", async t => {
  const f = fixture(t), commands = new Map(), errors = [], infos = [];
  let trusted = true, owner = { pythonWorkspaceId() { return "fixture-workspace"; } }, action, afterModal;
  let modals = 0, selected = true, confirmed = true;
  const vscode = {
    workspace: { get isTrusted() { return trusted; }, workspaceFolders: [] },
    commands: { registerCommand(name, callback) { commands.set(name, callback); return { dispose() {} }; } },
    window: {
      async showQuickPick(items) { return typeof items[0] === "string" ? action : items[0]; },
      async showOpenDialog() { return selected ? [{ fsPath: f.registry }] : undefined; },
      async showWarningMessage(text, options, button) { modals++; assert(options.modal); afterModal?.(); return confirmed ? button : undefined; },
      async showInformationMessage(message) { infos.push(message); },
      async showErrorMessage(message) { errors.push(message); },
    },
  };
  const original = Module._load;
  let register;
  try {
    Module._load = function(name, parent, main) { return name === "vscode" ? vscode : original.call(this, name, parent, main); };
    ({ registerNextLocalEnvironments: register } = require(path.join(build, "ui/next-local-environments.js")));
  } finally { Module._load = original; }
  const profile = path.join(f.root, "private-vscode-profile");
  register({ subscriptions: [], globalStorageUri: { fsPath: profile } }, () => owner);
  const run = commands.get("personalKnowledge.nextTrialEnvironments");
  action = "Import legacy profile registry";
  trusted = false; await run(); assert.equal(modals, 0);
  trusted = true; confirmed = false; await run();
  assert(!fs.existsSync(profile));
  confirmed = true; afterModal = () => fs.appendFileSync(f.registry, "\n");
  await run(); assert.match(errors.at(-1), /changed after preview/);
  afterModal = () => { owner = undefined; };
  await run(); assert.match(errors.at(-1), /trusted workspace/);
  owner = { pythonWorkspaceId() { throw new Error("Requires fresh trial"); } };
  afterModal = undefined; await run(); assert.match(errors.at(-1), /Requires fresh trial/);
  owner = { pythonWorkspaceId() { return "fixture-workspace"; } };
  await run(); assert.match(infos.at(-1), /revision 1/);
  const store = new LocalEnvironmentCatalog(path.join(profile, "next-local-environments"));
  assert.equal(store.read().catalog.entries[0].id, "old-python");
  action = "Run registered Python Workflow diagnostic";
  owner.runPythonTrial = async (authority, handle) => {
    authority.validate(handle, "fixture-workspace", "local:owner");
    store.register(f.node, store.read().digest);
    authority.validate(handle, "fixture-workspace", "local:owner");
    assert.fail("Changed catalog must revoke diagnostic authority before launch.");
  };
  await run();
  assert.match(errors.at(-1), /authority is unavailable/);
  assert(!infos.some(message => /Workflow succeeded/.test(message)));
});
