"use strict";
const fs = require("node:fs"), path = require("node:path"), { spawnSync } = require("node:child_process");
const assert = require("node:assert/strict"), { randomUUID, createHash } = require("node:crypto");

function create({ extension, root, fixture }) {
  const mask = process.umask(0o077);
  try { return createPrivate({ extension, root, fixture }); }
  finally { process.umask(mask); }
}
function createPrivate({ extension, root, fixture }) {
  assert.equal(fs.realpathSync(root), path.join(fs.realpathSync(fixture), "knowledge"));
  assert(fs.readFileSync(path.join(fixture, "native-ui-fixture-token"), "utf8"));
  const home = path.join(fixture, "h"), temporary = path.join(fixture, "t");
  fs.mkdirSync(home, { recursive: true, mode: 0o700 });
  fs.mkdirSync(temporary, { recursive: true, mode: 0o700 });
  const result = spawnSync(process.env.PKM_TEST_PYTHON || "python3", ["-B",
    path.join(__dirname, "legacy-recipe-fixture.py"), extension, root, path.join(fixture, "workspace")],
  { encoding: "utf8", env: { ...process.env, HOME: home, USERPROFILE: home,
    TMPDIR: temporary, TMP: temporary, TEMP: temporary, XDG_CACHE_HOME: path.join(home, ".cache"),
    XDG_CONFIG_HOME: path.join(home, ".config"), PYTHONDONTWRITEBYTECODE: "1" } });
  assert.equal(result.status, 0, result.stderr + result.stdout);
  const evidence = JSON.parse(result.stdout);
  const { ProjectStore } = require(path.join(extension, "dist/workflows/project-store.js"));
  const store = new ProjectStore(path.join(root, ".pkm/state"));
  const command = () => {
    const id = randomUUID();
    return { commandId: id, fingerprint: id, expectedStoreVersion: store.list().storeVersion };
  };
  const created = store.createRecipe(command(), { kind: "global" }, "SATURN trusted original Recipe", "Synthetic");
  store.updateRecipe(command(), created.entityId, {
    name: "SATURN trusted original Recipe", category: "Synthetic",
    definition: evidence.definition, description: "Isolated fixed local fixture. No arbitrary executables are authorized.",
  });
  const recipe = store.list().recipes.find(item => item.recipeId === created.entityId);
  assert.deepEqual(recipe.definition.spec.nodes.map(node => node.nodeId), ["inspect", "record"]);
  evidence.recipeId = recipe.recipeId;
  evidence.recipeRevision = recipe.revision;
  evidence.recipeExecutableDigest = recipe.executableDigest;
  evidence.recipe = recipe;
  fs.writeFileSync(path.join(fixture, "original-recipe-evidence.json"), JSON.stringify(evidence), { flag: "wx", mode: 0o600 });
  return evidence;
}
function snapshot(root) {
  const fixture = path.dirname(fs.realpathSync(root));
  assert.equal(fs.realpathSync(root), path.join(fixture, "knowledge"));
  assert(fixture.startsWith(path.resolve(__dirname, "../../.migration-test-work") + path.sep));
  assert(fs.readFileSync(path.join(fixture, "native-ui-fixture-token"), "utf8"));
  const records = {};
  const walk = relative => {
    const file = path.join(root, relative), stat = fs.lstatSync(file, { bigint: true });
    assert(stat.isDirectory() || stat.isFile() && stat.nlink === 1n, "Original fixture links are forbidden.");
    records[relative] = { dev: String(stat.dev), inode: String(stat.ino), mode: String(stat.mode),
      uid: String(stat.uid), gid: String(stat.gid), mtimeNs: String(stat.mtimeNs), ctimeNs: String(stat.ctimeNs),
      sha256: stat.isFile() ? createHash("sha256").update(fs.readFileSync(file)).digest("hex") : null };
    if (stat.isDirectory()) for (const name of fs.readdirSync(file).sort()) walk(path.join(relative, name));
  };
  walk("");
  return records;
}
module.exports = { create, snapshot };
