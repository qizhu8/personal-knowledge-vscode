const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { createHash, randomUUID } = require("node:crypto");

const project = path.resolve(__dirname, "..");
const dist = process.env.PKM_TEST_DIST || path.join(project, "dist");
const nextDist = process.env.PKM_NEXT_DIST || path.join(project, "next-server/dist");
const { LegacyRootUpgradeCheck } = require(path.join(dist, "runtime/legacy-root-upgrade"));
const sha = bytes => createHash("sha256").update(bytes).digest("hex");

test("default-root assessment uses the verified real inspector without modifying the root", { skip: process.platform !== "linux" }, async () => {
  const fixture = path.join(project, ".migration-test-work", `root-upgrade-check-${randomUUID()}`);
  const extension = path.join(fixture, "extension"), payload = path.join(extension, "next-runtime");
  const root = path.join(fixture, "knowledge");
  const write = (file, bytes) => {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, bytes);
  };
  const copy = (source, target) => fs.cpSync(source, target, {
    recursive: true, filter: sourcePath => !fs.lstatSync(sourcePath).isSymbolicLink(),
  });
  try {
    write(path.join(root, "notes", "example.md"), "# Original\n\nPreserve me.\n");
    const original = fs.readFileSync(path.join(root, "notes", "example.md"));
    write(path.join(extension, "package.json"), JSON.stringify({ version: "fixture" }));
    copy(nextDist, path.join(payload, "server/dist"));
    copy(path.join(project, "next-server/node_modules"), path.join(payload, "server/node_modules"));
    for (const name of ["package.json", "package-lock.json"])
      copy(path.join(project, "next-server", name), path.join(payload, "server", name));
    write(path.join(payload, "server/compat/legacy-compact-mcp.py"), "");
    write(path.join(payload, "resources/note_inventory.py"), "");
    write(path.join(payload, "check.cjs"), "");
    const files = {};
    function inventory(directory, prefix = "") {
      for (const name of fs.readdirSync(directory).sort()) {
        const relative = prefix ? `${prefix}/${name}` : name;
        const full = path.join(directory, name);
        if (fs.statSync(full).isDirectory()) inventory(full, relative);
        else files[relative] = sha(fs.readFileSync(full));
      }
    }
    inventory(payload);
    const serverVersion = JSON.parse(fs.readFileSync(path.join(payload, "server/package.json"))).version;
    write(path.join(payload, "manifest.json"), JSON.stringify({
      schema: "pkm.next-payload/v1", extensionVersion: "fixture", serverVersion,
      node: ">=22.18.0", entry: "server/dist/managed-client-child.js",
      buildId: sha(JSON.stringify(files)), files,
    }));

    let current = true;
    const check = new LegacyRootUpgradeCheck(extension, root, () => current, process.execPath);
    assert.equal(check.status().state, "pending");
    check.schedule(1);
    await new Promise(resolve => setTimeout(resolve, 10));
    assert.equal(check.status().state, "checking");
    const first = check.check();
    assert.equal(check.check(), first);
    const result = await first;
    assert.equal(result.state, "blocked", result.detail);
    assert.equal(result.cutoverAuthorized, false);
    assert(result.blockers.some(item => item.code === "direct-adoption-unqualified"));
    assert(result.blockers.some(item => item.code === "writer-isolation-unverified"));
    assert.match(result.detail, /Reloading this window does not complete the migration/);
    assert.match(result.detail, /Do not terminate unrelated processes/);
    assert.deepEqual(result.managedHandoff, {
      binding: "none", preexistingAndExternalWriters: "unknown", cutoverAuthorized: false,
    });
    assert.deepEqual(fs.readdirSync(root), ["notes"]);
    assert.deepEqual(fs.readFileSync(path.join(root, "notes", "example.md")), original);

    let profileState = "draining";
    check.bindManagedProfile(() => ({ state: profileState, preexistingAndExternalWriters: "unknown", cutoverAuthorized: false }));
    assert.equal(check.status().managedHandoff.binding, "bound");
    profileState = "drained";
    assert.equal(check.status().managedHandoff.state, "drained");
    assert.equal(check.status().managedHandoff.cutoverAuthorized, false);
    const oldRoot = path.join(fixture, "knowledge-original");
    const pendingReplacement = check.check();
    fs.renameSync(root, oldRoot);
    fs.mkdirSync(root);
    assert.equal(check.status().state, "unavailable");
    assert.equal(check.status().managedHandoff.binding, "unknown");
    const replaced = await pendingReplacement;
    assert.equal(replaced.state, "unavailable");
    assert.equal(replaced.cutoverAuthorized, false);
    assert.equal((await check.check()).state, "blocked");
    assert.equal(check.status().managedHandoff.binding, "unknown");
    fs.rmdirSync(root);
    fs.renameSync(oldRoot, root);
    assert.equal((await check.check()).state, "blocked");
    assert.equal(check.status().managedHandoff.binding, "bound");
    const stale = check.check();
    current = false;
    const staleResult = await stale;
    assert.equal(staleResult.state, "unavailable");
    assert.equal(staleResult.managedHandoff.binding, "unknown");
    current = true;
    fs.appendFileSync(path.join(payload, "server/dist/legacy-import.js"), "\n// changed");
    const invalid = await check.check();
    assert.equal(invalid.state, "unavailable");
    assert.equal(invalid.cutoverAuthorized, false);
    assert.deepEqual(fs.readFileSync(path.join(root, "notes", "example.md")), original);
    current = false;
    assert.equal((await check.check()).state, "unavailable");
    check.dispose();
  } finally {
    fs.rmSync(fixture, { recursive: true, force: true });
  }
});
