"use strict";
const fs = require("node:fs"), path = require("node:path"), assert = require("node:assert/strict");
const { execFileSync } = require("node:child_process"), { createHash } = require("node:crypto");
const vscode = require("vscode");
const digest = file => createHash("sha256").update(fs.readFileSync(file)).digest("hex");
function setup(context) {
  const extension = vscode.extensions.getExtension("Uone.personal-knowledge");
  const storage = path.join(context.root, "u/User/globalStorage/uone.personal-knowledge");
  const load = name => require(path.join(extension.extensionPath, "dist/runtime", name + ".js"));
  const store = new (load("local-environment-catalog").LocalEnvironmentCatalog)(path.join(storage, "next-local-environments"));
  const invoke = async (action, ids) => {
    if (Array.isArray(ids)) context.selectIds(action, ids); else context.select(action, ids);
    await context.manage(); assert.deepEqual(context.errors, []);
  };
  const text = () => vscode.window.activeTextEditor?.document.getText() || "";
  return { storage, load, store, invoke, text };
}
exports.cases = async context => {
  assert.notEqual(process.getuid(), 0, "Never allow conda admin account enumeration.");
  const f = setup(context), fixtures = path.join(context.root, "pip-fixtures");
  fs.mkdirSync(fixtures, { mode: 0o700 });
  const entries = [];
  for (const [name, up, down, only] of [["pip-a", "1", "2", "a"], ["pip-b", "2", "1", "b"]]) {
    const root = path.join(fixtures, name);
    execFileSync(process.env.PKM_ENV_INSTALLED_PIP_PYTHON,
      ["-I", "-B", "-m", "venv", "--without-pip", "--system-site-packages", root],
      { env: { PATH: "/usr/bin:/bin", HOME: path.join(context.root, "h"), TMPDIR: path.join(context.root, "t") } });
    const site = path.join(root, "lib", fs.readdirSync(path.join(root, "lib"))[0], "site-packages");
    for (const [name, version] of [["pkm-up", up], ["pkm-down", down], ["pkm-only-" + only, "1"]]) {
      const directory = path.join(site, name.replace(/-/g, "_") + "-" + version + ".dist-info");
      fs.mkdirSync(directory); fs.writeFileSync(path.join(directory, "METADATA"), `Metadata-Version: 2.1\nName: ${name}\nVersion: ${version}\n`);
    }
    context.dialogs.push(root); context.inputs.push(name);
    await f.invoke("Register existing Python folder");
    const entry = f.store.read().catalog.entries.find(e => e.root === root); assert(entry);
    entries.push(entry);
    const before = context.phases.length;
    await f.invoke("View registered pip package snapshot", entry.id); assert.equal(context.phases.length, before);
    await f.invoke("Refresh registered pip package snapshot", entry.id);
    assert.match(f.text(), /\| Package \| Version \|/); assert(f.text().includes(entry.id));
    assert.match(f.text(), /\| pkm-up \| [12] \|/);
  }
  const [a, b] = entries;
  const cacheA = f.load("local-python-packages").readPythonPackageSnapshot(f.storage, a);
  const cacheB = f.load("local-python-packages").readPythonPackageSnapshot(f.storage, b);
  assert(cacheA.sourceMatches && cacheB.sourceMatches);
  const phaseCount = context.phases.length, filePicks = context.filePicks.length;
  await f.invoke("Compare registered Python package snapshots", [a.id, b.id]);
  assert.match(f.text(), /upgrade/); assert.match(f.text(), /downgrade/); assert.match(f.text(), /added/); assert.match(f.text(), /deleted/);
  await f.invoke("Find similar registered Python package snapshots", [a.id, b.id]); assert.match(f.text(), /Jaccard/);
  assert.equal(context.phases.length, phaseCount); assert.equal(context.filePicks.length, filePicks);
  await f.invoke("Refresh registered Python version and allocated size", a.id);
  const metadata = f.load("local-python-inspection").readPythonMetadataSnapshot(f.storage, a);
  assert(metadata.sourceMatches && metadata.snapshot.sizeBytes > 0);
  const before = context.phases.length;
  await f.invoke("View registered Python version and size snapshot", a.id);
  assert.equal(context.phases.length, before); assert(f.text().includes(metadata.snapshot.pyVersion));
  await vscode.env.clipboard.writeText("private-pkm-no-copy-canary");
  context.declineCopy();
  await f.invoke("Preview and copy Python merge script", [a.id, b.id]);
  assert.equal(await vscode.env.clipboard.readText(), "private-pkm-no-copy-canary");
  await f.invoke("Preview and copy Python merge script", [a.id, b.id]);
  const merge = await vscode.env.clipboard.readText();
  assert.match(merge, /MANUAL REVIEW ONLY/); assert.match(merge, /pkm-only-b==1/);
  assert(fs.existsSync(a.root) && fs.existsSync(b.root)); assert.equal(context.phases.length, before);
  const copied = path.join(fixtures, "manual-merge.sh"); fs.writeFileSync(copied, merge);
  execFileSync("/bin/bash", ["-n", copied]);
  const inventoryRoot = path.join(context.root, "inventory/envs/selected-conda");
  fs.mkdirSync(path.dirname(inventoryRoot), { recursive: true, mode: 0o700 });
  const original = f.store.read().catalog.entries.find(e => e.id === context.originalId);
  fs.cpSync(original.root, inventoryRoot, { recursive: true, dereference: false });
  const inventoryFile = path.join(fixtures, "selected-environments.txt"); fs.writeFileSync(inventoryFile, inventoryRoot + "\n");
  const inventoryHash = digest(inventoryFile), originalRegistry = path.join(f.storage, "environments/registry.json");
  const legacyHash = digest(originalRegistry);
  context.selectIds("List installed conda environments and register a prefix", [inventoryRoot]);
  context.values.push("Selected inventory file copy");
  context.dialogs.push(process.env.PKM_ENV_INSTALLED_CONDA, inventoryFile);
  await context.manage(); assert.deepEqual(context.errors, []);
  assert.equal(digest(inventoryFile), inventoryHash); assert.equal(digest(originalRegistry), legacyHash);
  const registered = f.store.read().catalog.entries.find(e => e.root === inventoryRoot); assert(registered);
  await context.python(registered.id);
  context.dialogs.push(process.env.PKM_ENV_INSTALLED_CONDA);
  const beforeScript = context.phases.length;
  await f.invoke("Preview and copy conda manual deletion script", registered.id);
  const deletion = await vscode.env.clipboard.readText(); assert(deletion.includes(inventoryRoot));
  assert.match(deletion, /env remove -y -p/); assert.equal(context.phases.length, beforeScript);
  assert(fs.existsSync(path.join(inventoryRoot, "bin/python")));
  const metadataHash = digest(path.join(f.storage, "next-local-environments/metadata-snapshots",
    createHash("sha256").update(a.id).digest("hex") + ".json"));
  assert.deepEqual(context.dialogs, []); assert.deepEqual(context.inputs, []); assert.deepEqual(context.values, []);
  const snapshots = entries.map(e => ({ id: e.id, root: e.root, snapshot: f.load("local-python-packages").readPythonPackageSnapshot(f.storage, e).snapshot }));
  console.log("PASS installed pip/analytics/inspection: real pip tables, cached five-status/Jaccard, explicit version/size, clipboard-only scripts, scoped conda list/registration; no pip install.");
  return { uid: process.getuid(), entries, snapshots, metadataHash, metadata: metadata.snapshot,
    inventoryEntry: registered, inventoryFile, inventoryHash, legacyHash, mergeScriptSha256: digest(copied),
    actualNativePipTables: true, actualCachedCompareAndSimilarity: true, explicitVersionAllocatedSize: true,
    actualCondaInventoryAndRegistration: true,     clipboardScriptsOnlyNeverExecuted: true, declinedCopyKeptClipboardUnchanged: true,
    visualClickQualification: false, systemSitePipAlreadyInstalledNoSeed: true };
};
exports.reopen = async (context, previous) => {
  const f = setup(context), before = context.phases.length, picks = context.filePicks.length;
  for (const entry of previous.entries) {
    await f.invoke("View registered pip package snapshot", entry.id);
    const actual = f.load("local-python-packages").readPythonPackageSnapshot(f.storage, entry);
    assert.deepEqual(actual.snapshot, previous.snapshots.find(s => s.id === entry.id).snapshot);
    assert(actual.sourceMatches); assert(f.text().includes(entry.id));
  }
  await f.invoke("Compare registered Python package snapshots", previous.entries.map(e => e.id));
  await f.invoke("Find similar registered Python package snapshots", previous.entries.map(e => e.id));
  await f.invoke("View registered Python version and size snapshot", previous.entries[0].id);
  assert.deepEqual(f.load("local-python-inspection").readPythonMetadataSnapshot(f.storage, previous.entries[0]).snapshot, previous.metadata);
  assert.equal(context.phases.length, before); assert.equal(context.filePicks.length, picks);
  assert.equal(digest(previous.inventoryFile), previous.inventoryHash);
  assert.deepEqual(f.store.read().catalog.entries.find(e => e.id === previous.inventoryEntry.id), previous.inventoryEntry);
  return { fullCodeRestartCacheAndMetadataPreserved: true, noQueryOrToolSelectionOnCachedAnalysis: true,
    inventoryRegistrationStable: true, noScriptReplay: true };
};
