const test = require("node:test"), assert = require("node:assert/strict");
const fs = require("node:fs"), path = require("node:path"), cp = require("node:child_process");
const { randomUUID, createHash } = require("node:crypto");
const build = process.env.PKM_ENV_AUTHORITY_BUILD, executable = process.env.PKM_TEST_CONDA_EXECUTABLE;
const cache = process.env.PKM_TEST_CONDA_CACHE, template = process.env.PKM_TEST_EXISTING_CONDA_PREFIX;
if (![build, executable, cache, template].every(value => value && path.isAbsolute(value)))
  throw Error("Set explicit existing Root build, conda executable/cache and isolated old prefix; no skip or downloads.");
const { LocalEnvironmentCatalog } = require(path.join(build, "runtime/local-environment-catalog.js"));
const { LocalPythonManagerAuthority } = require(path.join(build, "runtime/local-python-managers.js"));
const lifecycle = require(path.join(build, "runtime/local-conda-lifecycle.js"));
const snapshotCache = require("./local-python-manager-cache-snapshot.cjs");
const sha = file => createHash("sha256").update(fs.readFileSync(file)).digest("hex");
function fixture(t) {
  const root = path.join(fs.realpathSync(process.cwd()), "tests", `.conda-lifecycle-${randomUUID()}`);
  const storage = path.join(root, "profile"), source = path.join(root, "old/envs/original");
  fs.mkdirSync(storage, { recursive: true, mode: 0o700 });
  fs.cpSync(template, source, { recursive: true, dereference: false, verbatimSymlinks: true });
  fs.writeFileSync(path.join(source, "user-sentinel.txt"), "preserve-untracked-user-data", { mode: 0o600 });
  const entry = { id: "original-conda", name: "Old conda", language: "python", kind: "environment", manager: "conda", root: source,
    executors: [{ id: "python", executable: path.join(source, "bin/python") }] };
  const registry = path.join(root, "registry.json");
  fs.writeFileSync(registry, JSON.stringify([{ id: entry.id, name: entry.name, manager: "conda", path: source, python: entry.executors[0].executable }]));
  const store = new LocalEnvironmentCatalog(path.join(storage, "next-local-environments"));
  const preview = store.previewLegacy(registry); store.importLegacy(registry, preview.sourceDigest, store.read().digest);
  const current = () => store.read().catalog.entries.find(item => item.id === entry.id);
  const authority = new LocalPythonManagerAuthority(() => true), tool = authority.select("conda", executable, cache);
  const cacheBefore = snapshotCache(cache), registryBefore = sha(registry);
  const options = (operation, extra = {}) => ({ storage, entry: current(), plan: lifecycle.planCondaLifecycle(storage, current(), operation),
    store, expected: store.read().digest, authority, tool, check() {}, ...extra });
  t.after(() => {
    authority.revoke(); assert.deepEqual(snapshotCache(cache), cacheBefore); assert.equal(sha(registry), registryBefore);
    fs.rmSync(root, { recursive: true, force: true });
  });
  return { root, storage, source, store, current, authority, tool, options };
}
test("original 1804 conda clone/remove migration and delete really use the installed manager against private copies", { timeout: 120000 }, async t => {
  const f = fixture(t), oracle = path.join(f.root, "old-pyenvs.cjs");
  fs.writeFileSync(oracle, cp.execFileSync("unzip", ["-p", path.resolve("personal-knowledge-4.0.22.vsix"), "extension/dist/servers/pyenvs.js"]));
  const old = require(oracle); old.initPyenvs(path.join(f.root, "old-registry"));
  const env = old.pyenvAdd({ name: "Actual old conda", manager: "conda", path: f.source, python: path.join(f.source, "bin/python") });
  for (const name of ["home", "private-cache", "bin", "scratch"]) fs.mkdirSync(path.join(f.root, name), { mode: 0o700 });
  fs.symlinkSync(executable, path.join(f.root, "bin/conda"));
  for (const archive of lifecycle.inspectCondaPrefix(f.current()).archives)
    fs.copyFileSync(path.join(cache, archive.name), path.join(f.root, "private-cache", archive.name));
  const config = path.join(f.root, "condarc"); fs.writeFileSync(config, "offline: true\nauto_update_conda: false\n");
  const selected = { HOME: path.join(f.root, "home"), PATH: `${path.join(f.root, "bin")}:/usr/bin:/bin`,
    CONDARC: config, CONDA_PKGS_DIRS: path.join(f.root, "private-cache"), CONDA_ENVS_PATH: path.join(f.root, "old/envs"),
    CONDA_OFFLINE: "true", CONDA_NO_PLUGINS: "true", CONDA_SOLVER: "classic", PYTHONDONTWRITEBYTECODE: "1",
    TMPDIR: path.join(f.root, "scratch"), TMP: path.join(f.root, "scratch"), TEMP: path.join(f.root, "scratch") };
  const saved = Object.fromEntries(Object.keys(selected).map(key => [key, process.env[key]])); Object.assign(process.env, selected);
  try {
    assert(old.pyenvActivateCommands(env.id).lines[0].endsWith('/etc/profile.d/conda.sh"'));
    const migrated = await old.pyenvMigrate(env.id, path.join(f.root, "oracle-managed/envs"));
    assert.equal(migrated.ok, true, JSON.stringify(migrated)); assert.equal(migrated.env.id, env.id);
    assert(!fs.existsSync(f.source)); assert(fs.existsSync(migrated.env.path));
    const removed = await old.pyenvDelete(env.id, true);
    assert.equal(removed.filesRemoved, true); assert.equal(removed.unregistered, true);
    assert(!fs.existsSync(migrated.env.path));
  } finally { for (const [key, value] of Object.entries(saved)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; } }
});
test("Next real offline clone retains original/ID/raw snapshot and untracked bytes; actual Bash activates/deactivates cloned conda", { timeout: 120000 }, async t => {
  const f = fixture(t), before = f.store.read(), sourceSnapshot = lifecycle.inspectCondaPrefix(f.current());
  const options = f.options("clone"); await lifecycle.executeCondaLifecycle(options);
  assert.equal(f.current().id, before.catalog.entries[0].id); assert.notEqual(f.current().root, f.source);
  assert.deepEqual(f.current().legacyPython, before.catalog.entries[0].legacyPython);
  lifecycle.validateCondaPrefix(sourceSnapshot, before.catalog.entries[0]);
  assert.equal(fs.readFileSync(path.join(f.current().root, "user-sentinel.txt"), "utf8"), "preserve-untracked-user-data");
  const prepared = await lifecycle.prepareCondaActivation(f.storage, f.current(), f.authority, f.tool, () => {});
  const q = value => `'${value.replace(/'/g, "'\\''")}'`;
  const output = cp.execFileSync("/bin/bash", ["--noprofile", "--norc"], {
    cwd: f.root, env: { ...prepared.env, CONDA_SHLVL: "0", CONDA_PREFIX: "" }, encoding: "utf8",
    input: `${prepared.hook}\nconda activate ${q(f.current().root)}\npython -I -B -c 'import sys; print(sys.prefix)'\nconda deactivate\nprintf '%s\\n' "$CONDA_SHLVL"\n`,
  });
  assert.equal(output.trim(), `${f.current().root}\n0`);
});
test("Next manager removal creates verified recovery clone, really deletes managed prefix, then explicit restart-style restore keeps ID", { timeout: 120000 }, async t => {
  const f = fixture(t); await lifecycle.executeCondaLifecycle(f.options("clone"));
  const managed = f.current(), options = f.options("remove");
  await lifecycle.executeCondaLifecycle(options);
  assert(!fs.existsSync(managed.root)); assert(fs.existsSync(options.plan.target)); assert.equal(f.current(), undefined);
  assert.deepEqual(lifecycle.listCondaRecoveries(f.storage), [options.plan.operationId]);
  const reopened = new LocalEnvironmentCatalog(path.join(f.storage, "next-local-environments"));
  const untouched = path.join(f.root, "must-not-be-created");
  fs.symlinkSync(untouched, managed.root);
  await assert.rejects(lifecycle.restoreCondaLifecycle({ ...options, operationId: options.plan.operationId,
    store: reopened, expected: reopened.read().digest }), /still exists/);
  assert.equal(fs.readlinkSync(managed.root), untouched); assert(!fs.existsSync(untouched));
  fs.unlinkSync(managed.root);
  reopened.register({ ...managed, executors: [{ id: "python", executable: path.join(f.source, "bin/python") }] }, reopened.read().digest);
  await assert.rejects(lifecycle.restoreCondaLifecycle({ ...options, operationId: options.plan.operationId,
    store: reopened, expected: reopened.read().digest }), /rebound elsewhere/);
  reopened.unregister(managed.id, reopened.read().digest);
  await lifecycle.restoreCondaLifecycle({ ...options, operationId: options.plan.operationId, store: reopened, expected: reopened.read().digest });
  assert.deepEqual(f.current(), managed); assert(fs.existsSync(managed.root)); assert(fs.existsSync(f.source));
  assert.equal(cp.execFileSync(managed.executors[0].executable, ["-I", "-B", "-c", "import sys; print(sys.prefix)"],
    { env: {}, encoding: "utf8" }).trim(), managed.root);
});
test("missing cache/source drift/trust/actual clone cancel refuse false commits and retain files; base and external manager deletion refuse", { timeout: 120000 }, async t => {
  const f = fixture(t), options = f.options("clone"), before = f.store.read();
  assert.throws(() => lifecycle.planCondaLifecycle(f.storage, f.current(), "remove"), /never external/);
  fs.appendFileSync(path.join(f.source, "user-sentinel.txt"), "drift");
  await assert.rejects(lifecycle.executeCondaLifecycle(options), /changed/); assert(!fs.existsSync(options.plan.target));
  await assert.rejects(lifecycle.executeCondaLifecycle(f.options("clone", { check() { throw Error("trust changed"); } })), /trust changed/);
  const empty = path.join(f.root, "empty"); fs.mkdirSync(empty);
  const emptyTool = f.authority.select("conda", executable, empty);
  await assert.rejects(lifecycle.executeCondaLifecycle(f.options("clone", { tool: emptyTool })), /ENOENT/);
  const abort = new AbortController(), cancelled = f.options("clone", { signal: abort.signal,
    report(phase) { if (phase === "conda-clone") abort.abort(); } });
  await assert.rejects(lifecycle.executeCondaLifecycle(cancelled), /cancelled/i);
  assert.equal(f.store.read().digest, before.digest); assert(fs.existsSync(f.source));
  const baseRecord = path.join(f.source, "conda-meta/base-refusal.json");
  fs.writeFileSync(baseRecord, '{"name":"conda"}');
  assert.throws(() => lifecycle.inspectCondaPrefix(f.current()), /base/);
});
test("real host SIGKILL after conda deletion leaves old metadata/verified backup, no replay; explicit restore repairs exact managed path", { timeout: 120000 }, async t => {
  const f = fixture(t); await lifecycle.executeCondaLifecycle(f.options("clone"));
  const options = f.options("remove"), managed = f.current(), before = f.store.read();
  const child = `const {LocalEnvironmentCatalog}=require(${JSON.stringify(path.join(build, "runtime/local-environment-catalog.js"))});
const {LocalPythonManagerAuthority}=require(${JSON.stringify(path.join(build, "runtime/local-python-managers.js"))});
const {executeCondaLifecycle}=require(${JSON.stringify(path.join(build, "runtime/local-conda-lifecycle.js"))});
const fs=require("node:fs"),a=new LocalPythonManagerAuthority(()=>true),tool=a.select("conda",${JSON.stringify(executable)},${JSON.stringify(cache)});
executeCondaLifecycle({storage:${JSON.stringify(f.storage)},entry:${JSON.stringify(managed)},plan:${JSON.stringify(options.plan)},
store:new LocalEnvironmentCatalog(${JSON.stringify(path.join(f.storage, "next-local-environments"))}),expected:${JSON.stringify(before.digest)},authority:a,tool,
check(){if(!fs.existsSync(${JSON.stringify(managed.root)}))process.kill(process.pid,"SIGKILL");}}).catch(e=>{console.error(e);process.exitCode=1;});`;
  await assert.rejects(require("node:util").promisify(cp.execFile)(process.execPath, ["-e", child], { env: {}, cwd: f.root, timeout: 110000 }),
    error => error.signal === "SIGKILL");
  assert(!fs.existsSync(managed.root)); assert(fs.existsSync(options.plan.target)); assert.equal(f.store.read().digest, before.digest);
  const rebound = f.store.rebindPython(managed.id, f.source, before.digest);
  await assert.rejects(lifecycle.restoreCondaLifecycle({ ...options, operationId: options.plan.operationId, expected: rebound.digest }), /rebound elsewhere/);
  f.store.restore(before.catalog.revision, rebound.digest);
  await lifecycle.restoreCondaLifecycle({ ...options, operationId: options.plan.operationId, expected: f.store.read().digest });
  assert.equal(f.current().root, managed.root); assert(fs.existsSync(managed.root)); assert(fs.existsSync(f.source));
});
