const fs = require("node:fs"), path = require("node:path"), assert = require("node:assert/strict");
const { execFileSync } = require("node:child_process"), { createHash } = require("node:crypto");
const quote = value => `'${value.replace(/'/g, "'\\''")}'`;
const digest = value => createHash("sha256").update(value).digest("hex");

async function prepare(root) {
  root = path.resolve(root);
  const cwd = fs.realpathSync(".");
  const parent = path.join(cwd, ".migration-test-work");
  assert.equal(path.dirname(root), parent, "Only a new direct child of the project migration workspace is allowed.");
  assert.equal(fs.realpathSync(parent), parent, "Fixture parent must not redirect the target.");
  assert(!fs.existsSync(root), "Never overwrite an existing profile.");
  fs.mkdirSync(root, { recursive: true, mode: 0o700 });
  assert(fs.realpathSync(root) === root, "Fixture ancestors must not redirect the target.");
  const storage = path.join(root, "user-data/User/globalStorage/uone.personal-knowledge");
  const prefix = path.join(root, "conda fixture", "envs", "original env");
  const knowledgeRoot = path.join(root, "original Knowledge Root");
  fs.mkdirSync(knowledgeRoot); fs.writeFileSync(path.join(knowledgeRoot, "untouched-root.txt"), "Same original Root; Environment registry is not here.\n");
  execFileSync("/usr/bin/python3", ["-I", "-B", "-m", "venv", "--without-pip", prefix],
    { env: { HOME: root, TMPDIR: root, PATH: "/usr/bin:/bin" } });
  const meta = path.join(prefix, "conda-meta");
  fs.mkdirSync(meta);
  fs.writeFileSync(path.join(meta, "fixture.json"), JSON.stringify({ name: "retained_fixture", version: "1.0" }));
  const calls = path.join(root, "manager-calls"), tool = path.join(root, "conda fixture/bin/conda");
  fs.mkdirSync(path.dirname(tool), { recursive: true });
  fs.writeFileSync(tool, `#!/bin/bash
set -eu
[ "$#" = 4 ] && [ "$1" = list ] && [ "$2" = --json ] && [ "$3" = -p ] && [ "$4" = ${quote(prefix)} ]
printf '%s\\n' "$4" >> ${quote(calls)}
exec /usr/bin/python3 -I -B -c 'import json,os,sys;print(json.dumps([json.load(open(os.path.join(sys.argv[1],"conda-meta",n))) for n in os.listdir(os.path.join(sys.argv[1],"conda-meta")) if n.endswith(".json")]))' "$4"
`, { mode: 0o700 });
  const hostBin = path.join(root, "host-bin"); fs.mkdirSync(hostBin);
  fs.symlinkSync("/usr/bin/du", path.join(hostBin, "du"));
  const oracle = path.join(root, "old-pyenvs.cjs");
  fs.writeFileSync(oracle, execFileSync("unzip", ["-p", path.resolve("personal-knowledge-4.0.22.vsix"), "extension/dist/servers/pyenvs.js"]));
  const old = require(oracle);
  old.initPyenvs(path.join(storage, "environments"));
  const entry = old.pyenvAdd({ name: "Retained conda", manager: "conda", path: prefix,
    python: path.join(prefix, "bin/python"), description: "original profile, keep this registration" });
  old.pyenvUpdate(entry.id, { customReference: { owner: "original-profile" } });
  const venv = path.join(root, "original Python venv");
  execFileSync("/usr/bin/python3", ["-I", "-B", "-m", "venv", "--without-pip", "--system-site-packages", venv],
    { env: { HOME: root, TMPDIR: root, PATH: "/usr/bin:/bin" } });
  const lib = path.join(venv, "lib", fs.readdirSync(path.join(venv, "lib"))[0], "site-packages", "retained_fixture-1.0.dist-info");
  fs.mkdirSync(lib); fs.writeFileSync(path.join(lib, "METADATA"), "Metadata-Version: 2.1\nName: retained_fixture\nVersion: 1.0\n");
  const venvEntry = old.pyenvAdd({ name: "Retained Python", manager: "venv", path: venv, python: path.join(venv, "bin/python") });
  old.pyenvUpdate(venvEntry.id, { customReference: { owner: "original-profile" } });
  const safeEnv = { PATH: `${path.dirname(tool)}:${hostBin}`, HOME: root, TMPDIR: root, PYTHONDONTWRITEBYTECODE: "1",
    PIP_CONFIG_FILE: "/dev/null", PIP_NO_INDEX: "1", PIP_DISABLE_PIP_VERSION_CHECK: "1", PIP_LIST_OUTDATED: "0",
    PIP_LIST_UPTODATE: "0", PIP_CACHE_DIR: path.join(root, "pip-cache") };
  const originalEnv = Object.fromEntries(Object.keys(safeEnv).map(key => [key, process.env[key]]));
  Object.assign(process.env, safeEnv);
  try {
    assert.equal((await old.pyenvPackages(entry.id, true)).error, undefined);
    assert.equal((await old.pyenvSize(entry.id, true)).error, undefined);
    const packages = await old.pyenvPackages(venvEntry.id, true);
    assert.equal(packages.error, undefined); assert(packages.packages.some(item => item.name === "pip"));
    assert.equal((await old.pyenvSize(venvEntry.id, true)).error, undefined);
  } finally {
    for (const [key, value] of Object.entries(originalEnv)) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
  }
  const registry = path.join(storage, "environments/registry.json");
  const cache = path.join(storage, "environments", `${entry.id}.packages.json`);
  const receipt = { root, storage, userData: path.join(root, "user-data"), knowledgeRoot, prefix, tool, calls, hostBin,
    registry, cache, id: entry.id, venv, venvId: venvEntry.id, registrySha256: digest(fs.readFileSync(registry)),
    legacyVsixSha256: digest(fs.readFileSync("personal-knowledge-4.0.22.vsix")),
    cacheSha256: digest(fs.readFileSync(cache)), rootSha256: digest(fs.readFileSync(path.join(knowledgeRoot, "untouched-root.txt"))),
    boundary: "Disposable real 4.0.22 registry/cache and Python venv; controlled local-only conda manager, not a real conda installation or installed host acceptance." };
  fs.writeFileSync(path.join(root, "fixture-receipt.json"), JSON.stringify(receipt, null, 2));
  return { ...receipt, old };
}

module.exports = { prepare, digest };
if (require.main === module) {
  prepare(process.argv[2] || "").then(({ old, ...receipt }) => console.log(JSON.stringify(receipt, null, 2)))
    .catch(error => { console.error(error); process.exitCode = 1; });
}
