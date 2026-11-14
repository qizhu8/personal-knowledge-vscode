"use strict";
const fs = require("node:fs"), path = require("node:path"), assert = require("node:assert/strict");
const { randomUUID } = require("node:crypto");
const vscode = require("vscode");
function open(context) {
  const extension = vscode.extensions.getExtension("Uone.personal-knowledge");
  const { LocalEnvironmentCatalog } = require(path.join(extension.extensionPath, "dist/runtime/local-environment-catalog.js"));
  const { listCondaRecoveries } = require(path.join(extension.extensionPath, "dist/runtime/local-conda-lifecycle.js"));
  const storage = path.join(context.root, "u/User/globalStorage/uone.personal-knowledge");
  const store = new LocalEnvironmentCatalog(path.join(storage, "next-local-environments"));
  const invoke = async (action, id) => {
    context.select(action, id);
    context.dialogs.push(process.env.PKM_ENV_INSTALLED_CONDA, process.env.PKM_ENV_INSTALLED_CONDA_CACHE);
    await context.manage(); assert.deepEqual(context.errors, []);
  };
  return { storage, store, invoke, listCondaRecoveries };
}
exports.cases = async context => {
  const { storage, store, invoke, listCondaRecoveries } = open(context), original = store.read().catalog.entries.find(entry => entry.id === context.originalId);
  const before = store.read(), history = fs.readFileSync(path.join(original.root, "conda-meta/history"));
  let terminal, command;
  const create = vscode.window.createTerminal;
  vscode.window.createTerminal = options => {
    assert.equal(options.shellPath, "/bin/bash"); assert(options.env.CONDARC.includes("conda-work-"));
    terminal = create(options);
    return { show() { terminal.show(); }, sendText(text, newline) { command = text; terminal.sendText(text, newline); } };
  };
  try {
    await invoke("Activate registered conda in private Bash terminal", original.id);
    assert(terminal && command.includes("conda activate"));
    const file = path.join(context.root, "conda-native-terminal-prefix.json");
    const program = `import json,sys;open(${JSON.stringify(file)},'w').write(json.dumps({'prefix':sys.prefix}))`;
    terminal.sendText(`python -I -B -c '${program.replace(/'/g, "'\\''")}'`, true);
    const deadline = Date.now() + 20000;
    while (!fs.existsSync(file)) { if (Date.now() > deadline) assert.fail("Real conda terminal did not write evidence."); await new Promise(resolve => setTimeout(resolve, 50)); }
    assert.equal(JSON.parse(fs.readFileSync(file)).prefix, original.root);
    const terminalPid = await terminal.processId; terminal.dispose(); terminal = undefined;
    const ledger = path.join(storage, "next-environment-maintenance");
    const existing = new Set(fs.readdirSync(ledger));
    context.select("Clone conda to managed prefix (keep original)", original.id);
    context.dialogs.push(process.env.PKM_ENV_INSTALLED_CONDA, path.join(context.root, "manager-empty-cache"));
    const failedDigest = store.read().digest;
    await context.manage(); assert.match(context.errors.pop(), /cache|archive|unavailable|missing/i);
    assert.equal(store.read().digest, failedDigest);
    const retainedFailure = fs.readdirSync(ledger).filter(name => !existing.has(name));
    assert(retainedFailure.length > 0);
    await invoke("Clone conda to managed prefix (keep original)", original.id);
    const migrated = store.read().catalog.entries.find(entry => entry.id === original.id);
    assert.notEqual(migrated.root, original.root); assert.deepEqual(migrated.legacyPython, original.legacyPython);
    assert(fs.existsSync(original.root)); assert(fs.existsSync(migrated.root));
    assert.deepEqual(fs.readFileSync(path.join(original.root, "conda-meta/history")), history);
    await context.python(original.id);
    const removals = listCondaRecoveries(storage);
    await invoke("Remove managed conda (keep recovery clone)", original.id);
    const first = listCondaRecoveries(storage).find(id => !removals.includes(id));
    assert(first); assert(!fs.existsSync(migrated.root)); assert(!store.read().catalog.entries.some(entry => entry.id === original.id));
    context.recovery(first); await invoke("Restore conda recovery clone", original.id);
    assert(fs.existsSync(migrated.root)); await context.python(original.id);
    store.restore(before.catalog.revision, store.read().digest);
    assert.equal(store.read().catalog.entries.find(entry => entry.id === original.id).root, original.root);
    const extra = { ...migrated, id: `conda-restart-${randomUUID()}` };
    delete extra.legacyPython;
    store.register(extra, store.read().digest);
    const common = { originalId: original.id, originalRoot: original.root, originalIdAndSnapshotRetained: true,
      actualTerminalPid: terminalPid, actualTerminalPrefix: JSON.parse(fs.readFileSync(file)).prefix,
      actualManagerCloneRemoveRestore: true, failedOfflineCloneDidNotCommit: true, retainedFailure,
      noAutomaticRecovery: true, scriptedDecisions: true, visualUIQualification: false };
    if (process.env.PKM_ENV_INSTALLED_CONDA_CRASH === "1")
      return require("./environments-conda-crash-installed.cjs").interrupt(context, store, extra, common, invoke);
    const previous = listCondaRecoveries(storage);
    await invoke("Remove managed conda (keep recovery clone)", extra.id);
    const pending = listCondaRecoveries(storage).find(id => !previous.includes(id));
    assert(pending && !fs.existsSync(extra.root));
    assert(!store.read().catalog.entries.some(entry => entry.id === extra.id));
    return { ...common, pending: { entry: extra, operationId: pending } };
  } finally { terminal?.dispose(); vscode.window.createTerminal = create; }
};
exports.reopen = async (context, previous) => {
  const { storage, store, invoke } = open(context), pending = previous.pending;
  assert(previous.retainedFailure.every(name => fs.existsSync(path.join(storage, "next-environment-maintenance", name))));
  const crash = previous.interruptedRemoval
    ? await require("./environments-conda-crash-installed.cjs").inspectBeforeRestore(context, store, previous) : undefined;
  if (!crash) assert(!store.read().catalog.entries.some(entry => entry.id === pending.entry.id));
  assert(!fs.existsSync(pending.entry.root));
  context.recovery(pending.operationId); await invoke("Restore conda recovery clone", pending.entry.id);
  assert.deepEqual(store.read().catalog.entries.find(entry => entry.id === pending.entry.id), pending.entry);
  assert(fs.existsSync(pending.entry.root)); await context.python(pending.entry.id);
  await context.python(previous.originalId);
  return { explicitRecoveryAfterCompleteCodeRestart: true, sameIdAndPathRestored: true,
    originalAndRestoredNativePythonWorkflowsUsable: true, noReplayBeforeExplicitRecovery: true,
    ...(crash ? { actualInstalledHostSIGKILLRecovery: crash } : {}) };
};
