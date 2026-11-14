const test = require("node:test"), assert = require("node:assert/strict");
const fs = require("node:fs"), path = require("node:path");
const { randomUUID } = require("node:crypto"), { spawnSync } = require("node:child_process");
const build = process.env.PKM_ENV_AUTHORITY_BUILD;
if (!build || !path.isAbsolute(build)) throw new Error("Set absolute PKM_ENV_AUTHORITY_BUILD.");
const { LocalPythonManagerAuthority } = require(path.join(build, "runtime/local-python-managers.js"));
function fixture(t) {
  const root = path.join(fs.realpathSync(process.cwd()), "tests", `.python-managers-${randomUUID()}`);
  fs.mkdirSync(root, { mode: 0o700 });
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}
test("native manager grants reject missing tools, cloned handles, changed executables and revoked trust", t => {
  const root = fixture(t), executable = path.join(root, "selected-uv");
  fs.copyFileSync(process.execPath, executable); fs.chmodSync(executable, 0o700);
  let trusted = true;
  const authority = new LocalPythonManagerAuthority(() => trusted);
  assert.throws(() => authority.select("uv", path.join(root, "uv-not-installed")), /unavailable.*Nothing was installed/);
  const selected = authority.select("uv", executable);
  assert.throws(() => authority.validate({ ...selected }), /not native/);
  assert.throws(() => authority.provider(selected, {}), /explicitly registered local Python/);
  fs.appendFileSync(executable, "\n");
  assert.throws(() => authority.validate(selected), /changed/);
  const next = authority.select("uv", executable); trusted = false;
  assert.throws(() => authority.validate(next), /revoked/); trusted = true;
  assert.throws(() => authority.validate(next), /not native/);
});
test("unavailable uv is explicitly refused before any prefix, process or catalog is created", t => {
  const root = fixture(t), authority = new LocalPythonManagerAuthority(() => true);
  assert.throws(() => authority.select("uv", path.join(root, "absent-local-uv")), /unavailable.*Nothing was installed or downloaded/);
  assert.deepEqual(fs.readdirSync(root), []);
});
test("installed conda really creates offline from copied archives, cancels and recovers retained files without touching source cache",
  { timeout: 180000, skip: !process.env.PKM_TEST_CONDA_EXECUTABLE || !process.env.PKM_TEST_CONDA_CACHE }, t => {
    const root = fixture(t);
    for (const name of ["home", "scratch"]) fs.mkdirSync(path.join(root, name), { mode: 0o700 });
    const result = spawnSync("unshare", require("../scripts/run-next-trial-private-display").privateNamespaceArgs([
      process.execPath, path.resolve("tests/local-python-manager-fixture.cjs"), build, root,
      process.env.PKM_TEST_CONDA_EXECUTABLE, process.env.PKM_TEST_CONDA_CACHE,
    ]), { cwd: root, env: { PATH: process.env.PATH, HOME: path.join(root, "home"), TMPDIR: path.join(root, "scratch") },
      encoding: "utf8", timeout: 170000, maxBuffer: 1024 * 1024 });
    assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}\n${result.error ?? ""}`);
    const proof = JSON.parse(result.stdout); assert.equal(proof.success.manager, "conda");
    for (const name of ["cancel", "conflict", "empty-cache"]) assert.equal(proof[name].falseSuccess, false);
  });
