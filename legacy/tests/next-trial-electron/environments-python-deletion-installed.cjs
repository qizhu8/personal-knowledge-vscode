"use strict";
const fs = require("node:fs"), path = require("node:path"), assert = require("node:assert/strict");
const { createHash } = require("node:crypto"), vscode = require("vscode");
const hash = file => createHash("sha256").update(fs.readFileSync(file)).digest("hex");
function setup(context) {
  const extension = vscode.extensions.getExtension("Uone.personal-knowledge");
  const storage = path.join(context.root, "u/User/globalStorage/uone.personal-knowledge");
  const api = require(path.join(extension.extensionPath, "dist/runtime/local-python-lifecycle.js"));
  const Catalog = require(path.join(extension.extensionPath, "dist/runtime/local-environment-catalog.js")).LocalEnvironmentCatalog;
  const store = new Catalog(path.join(storage, "next-local-environments"));
  const invoke = async (action, id) => { context.select(action, id); await context.manage(); assert.deepEqual(context.errors, []); };
  const inspect = async operation => {
    context.recovery(operation); await invoke("Inspect recorded permanent Python deletion");
    const value = JSON.parse(vscode.window.activeTextEditor.document.getText()); assert.equal(value.receipt.operationId, operation);
    return value;
  };
  return { storage, api, store, invoke, inspect };
}
exports.cases = async (context, baseId) => {
  const f = setup(context), registry = path.join(f.storage, "environments/registry.json"), legacyHash = hash(registry);
  const infoCount = context.infos.length;
  context.select("Run registered Python Workflow diagnostic", "missing-python"); await context.manage();
  assert.match(context.errors.pop(), /ENOENT|missing|repair/);
  assert.equal(context.infos.length, infoCount);
  const create = async name => {
    context.inputs.push(name, "Explicit no-pip deletion fixture");
    await f.invoke("Create offline Python venv", baseId);
    const entry = f.store.read().catalog.entries.find(e => e.name === name); assert(entry);
    await context.python(entry.id); return entry;
  };
  const entry = await create("permanent-delete-native"), before = f.store.read().digest;
  context.declineDeletion(); await f.invoke("Permanently delete synthetic Python files and unregister", entry.id);
  assert(fs.existsSync(entry.root)); assert.equal(f.store.read().digest, before);
  assert.equal(f.api.listPythonDeletions(f.storage).length, 0);
  const outside = path.join(context.root, "permanent-delete-outside-canary.txt"); fs.writeFileSync(outside, "keep outside prefix");
  fs.symlinkSync(outside, path.join(entry.root, "outside-link"));
  await f.invoke("Permanently delete synthetic Python files and unregister", entry.id);
  assert(!fs.existsSync(entry.root)); assert(!f.store.read().catalog.entries.some(e => e.id === entry.id));
  assert.equal(fs.readFileSync(outside, "utf8"), "keep outside prefix");
  const successOperation = f.api.listPythonDeletions(f.storage)[0];
  const success = await f.inspect(successOperation); assert(!success.sourcePresent && !success.registrationPresent);
  const failed = await create("permanent-delete-permission-failure");
  const locked = path.join(failed.root, "permission-denied"), marker = path.join(locked, "owned.txt");
  fs.mkdirSync(locked, { mode: 0o700 }); fs.writeFileSync(marker, "No automatic chmod/retry"); fs.chmodSync(locked, 0);
  context.select("Permanently delete synthetic Python files and unregister", failed.id); await context.manage();
  assert.equal(context.errors.length, 1);
  const filesystemError = context.errors.pop();
  assert.match(filesystemError, /EACCES|permission denied|ENOTEMPTY/i);
  assert.throws(() => fs.readdirSync(locked), error => error.code === "EACCES");
  assert(f.store.read().catalog.entries.some(e => e.id === failed.id)); assert(fs.existsSync(locked));
  const failureOperation = f.api.listPythonDeletions(f.storage).find(id => id !== successOperation); assert(failureOperation);
  const failure = await f.inspect(failureOperation); assert(failure.sourcePresent && failure.registrationMatches);
  assert.equal(hash(registry), legacyHash);
  const operationHashes = Object.fromEntries([successOperation, failureOperation].map(id =>
    [id, hash(path.join(f.storage, "next-environment-maintenance", id + ".json"))]));
  console.log("PASS installed permanent Python deletion: declined first, actual files+metadata removed, child symlink target preserved; genuine permission failure retains requested outcome/registration, no quarantine or rollback.");
  return { uid: process.getuid(), entry, failed, locked, marker, successOperation, failureOperation, operationHashes, legacyHash,
    actualNativeIrreversibleDeletion: true, declineKeptFilesAndMetadata: true, childSymlinkNotFollowed: true,
    realUnixPermissionFailure: true, permissionDeniedReadProbe: true, filesystemError,
    requestedNotCompletedRecords: true, missingPythonRefused: true, noScriptExecution: true };
};
exports.reopen = async (context, previous) => {
  const f = setup(context), before = f.store.read().digest;
  assert(!fs.existsSync(previous.entry.root)); assert(!f.store.read().catalog.entries.some(e => e.id === previous.entry.id));
  assert.deepEqual(f.store.read().catalog.entries.find(e => e.id === previous.failed.id), previous.failed);
  assert(fs.existsSync(previous.locked)); assert.equal(fs.statSync(previous.locked).mode & 0o777, 0);
  const failed = await f.inspect(previous.failureOperation); assert(failed.sourcePresent && failed.registrationMatches);
  const succeeded = await f.inspect(previous.successOperation); assert(!succeeded.sourcePresent && !succeeded.registrationPresent);
  assert.equal(f.store.read().digest, before);
  for (const [id, digest] of Object.entries(previous.operationHashes))
    assert.equal(hash(path.join(f.storage, "next-environment-maintenance", id + ".json")), digest);
  assert.equal(hash(path.join(f.storage, "environments/registry.json")), previous.legacyHash);
  fs.chmodSync(previous.locked, 0o700); assert.equal(fs.readFileSync(previous.marker, "utf8"), "No automatic chmod/retry");
  console.log("PASS installed permanent deletion restart: no replay/automatic permission repair; successful deletion stays absent, failed registration/request remain explicit.");
  return { fullCodeRestartObserved: true, noDeletionReplayOrPermissionRepair: true, requestedReceiptHashesUnchanged: true,
    failedRegistrationPreserved: true, successfulDeletionStillAbsent: true };
};
