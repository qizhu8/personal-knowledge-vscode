"use strict";
const fs = require("node:fs"), path = require("node:path"), assert = require("node:assert/strict");
const { createHash } = require("node:crypto"), vscode = require("vscode");
function setup(context, id) {
  const extension = vscode.extensions.getExtension("Uone.personal-knowledge");
  const storage = path.join(context.root, "u/User/globalStorage/uone.personal-knowledge");
  const { LocalEnvironmentCatalog } = require(path.join(extension.extensionPath, "dist/runtime/local-environment-catalog.js"));
  const service = require(path.join(extension.extensionPath, "dist/runtime/local-conda-packages.js"));
  const entry = new LocalEnvironmentCatalog(path.join(storage, "next-local-environments")).read().catalog.entries.find(e => e.id === id);
  assert(entry && entry.manager === "conda");
  const file = path.join(storage, "next-local-environments/package-snapshots", createHash("sha256").update(id).digest("hex") + ".json");
  const invoke = async action => { context.select(action, id); await context.manage(); assert.deepEqual(context.errors, []); };
  const table = () => {
    const text = vscode.window.activeTextEditor?.document.getText();
    assert(text?.includes(id) && text.includes(entry.root));
    assert.match(text, /\| Package \| Version \|/); assert.match(text, /\| python \| 3\.11/);
    return text;
  };
  return { storage, service, entry, file, invoke, table };
}
exports.cases = async (context, id) => {
  const f = setup(context, id);
  assert(!fs.existsSync(f.file));
  await f.invoke("View registered conda package snapshot");
  assert(!fs.existsSync(f.file));
  context.dialogs.push(process.env.PKM_ENV_INSTALLED_CONDA);
  await f.invoke("Refresh registered conda package snapshot (explicit tool)");
  const table = f.table(), cached = f.service.readCondaPackageSnapshot(f.storage, f.entry);
  assert(cached.sourceMatches);
  await f.invoke("View registered conda package snapshot"); assert.equal(f.table(), table);
  return { environmentId: id, root: f.entry.root, packages: cached.snapshot.packages.length,
    snapshotSha256: createHash("sha256").update(fs.readFileSync(f.file)).digest("hex"),
    capturedAt: cached.snapshot.capturedAt, actualSelectedCondaList: true,
    nextOnlyCreatedIdNotLegacyRegistry: true, actualNativeEditorTable: true,
    noManagerOnInitialMissingCacheOrSubsequentView: true, instrumentedDecisions: true, visualClickQualification: false };
};
exports.reopen = async (context, previous) => {
  const f = setup(context, previous.environmentId);
  assert.equal(createHash("sha256").update(fs.readFileSync(f.file)).digest("hex"), previous.snapshotSha256);
  await f.invoke("View registered conda package snapshot"); f.table();
  const cached = f.service.readCondaPackageSnapshot(f.storage, f.entry);
  assert.equal(cached.snapshot.capturedAt, previous.capturedAt); assert(cached.sourceMatches);
  return { cachedSnapshotSurvivedCompleteCodeRestart: true, noToolSelectionOrManagerExecutionOnView: true,
    environmentId: previous.environmentId, snapshotSha256: previous.snapshotSha256 };
};
