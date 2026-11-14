"use strict";
const fs = require("node:fs"), path = require("node:path"), assert = require("node:assert/strict");
function durable(file, value) {
  const fd = fs.openSync(file, "wx", 0o600);
  try { fs.writeFileSync(fd, JSON.stringify(value, null, 2)); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
  const directory = fs.openSync(path.dirname(file), "r");
  try { fs.fsyncSync(directory); } finally { fs.closeSync(directory); }
}
exports.interrupt = async (context, store, entry, proof, invoke) => {
  const extension = require("vscode").extensions.getExtension("Uone.personal-knowledge");
  const module = require(path.join(extension.extensionPath, "dist/runtime/local-conda-lifecycle.js"));
  const execute = module.executeCondaLifecycle;
  module.executeCondaLifecycle = async options => {
    assert.equal(options.entry.id, entry.id); assert.equal(options.plan.operation, "remove");
    const checkpoint = { ...proof, pending: { entry, operationId: options.plan.operationId },
      interruptedRemoval: true, beforeCrashCatalogDigest: store.read().digest };
    const file = path.join(context.root, "managers-initial-result.json");
    const initial = JSON.parse(fs.readFileSync(file));
    fs.writeFileSync(file, JSON.stringify({ ...initial, lifecycle: checkpoint }, null, 2));
    durable(path.join(context.root, "conda-crash-armed.json"), {
      hostPid: process.pid, entry, operationId: options.plan.operationId,
      beforeCrashCatalogDigest: checkpoint.beforeCrashCatalogDigest,
      boundary: "actual installed manager deletion completed; before catalog unregister CAS",
      instrumentation: "native UI calls unchanged installed service; only check callback injects SIGKILL",
    });
    let removalStarted = false;
    return execute({ ...options, report(phase) {
      if (phase === "conda-remove") removalStarted = true;
      options.report?.(phase);
    }, check() {
      options.check();
      if (fs.existsSync(entry.root)) return;
      assert(removalStarted, "Do not inject a crash before the real manager removal starts.");
      assert.equal(store.read().digest, checkpoint.beforeCrashCatalogDigest);
      const backupReceipt = path.join(options.storage, "next-environment-maintenance",
        `conda-backup-${options.plan.operationId}.json`);
      assert(fs.existsSync(backupReceipt)); assert(fs.existsSync(options.plan.target));
      durable(path.join(context.root, "conda-crash-observed.json"), {
        hostPid: process.pid, operationId: options.plan.operationId,
        sourceAbsent: true, backupReceipt, backupRoot: options.plan.target,
        catalogUncommitted: true, actualManagerRemovalStarted: true,
        beforeCrashCatalogDigest: checkpoint.beforeCrashCatalogDigest,
        signalRequested: "SIGKILL",
      });
      process.kill(process.pid, "SIGKILL");
      assert.fail("SIGKILL did not terminate the actual extension host.");
    } });
  };
  try {
    await invoke("Remove managed conda (keep recovery clone)", entry.id);
    assert.fail("The installed removal unexpectedly returned instead of crashing.");
  } finally { module.executeCondaLifecycle = execute; }
};
exports.inspectBeforeRestore = async (context, store, previous) => {
  const observed = JSON.parse(fs.readFileSync(path.join(context.root, "conda-crash-observed.json")));
  assert.equal(observed.operationId, previous.pending.operationId);
  assert.equal(store.read().digest, previous.beforeCrashCatalogDigest);
  assert.deepEqual(store.read().catalog.entries.find(entry => entry.id === previous.pending.entry.id), previous.pending.entry);
  assert(!fs.existsSync(previous.pending.entry.root)); assert(fs.existsSync(observed.backupRoot));
  context.select("Run registered Python Workflow diagnostic", previous.pending.entry.id);
  await context.manage();
  assert.match(context.errors.pop(), /unavailable|missing|ENOENT|not found|interpreter/i);
  assert.equal(store.read().digest, previous.beforeCrashCatalogDigest);
  return { staleMetadataPersisted: true, staleExecutionRefused: true, noAutomaticReplayBeforeRestore: true };
};
