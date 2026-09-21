#!/usr/bin/env node
const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const {
  DURABLE_STORE_SCHEMA, DurableStoreError, DurableWorkflowStore, payloadDigest
} = require("../dist/workflows/durable-store.js");
const { initializeProjectModel } = require("../dist/workflows/project-model.js");
const { createRuntimeModel } = require("../dist/workflows/runtime-model.js");

const roots = [];
const temporary = () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "workflow-store-"));
  roots.push(directory);
  return directory;
};
const project = seed => initializeProjectModel(undefined, () => seed);
const command = (commandId, expectedStorageEpoch, fingerprint = `fp-${commandId}`) => ({ commandId, fingerprint, expectedStorageEpoch });
const error = (action, code) => assert.throws(action, value => value instanceof DurableStoreError && value.code === code);
const snapshotPath = directory => path.join(directory, "workflow-store.json");
const journalPath = directory => path.join(directory, "workflow-store.journal");
const readJson = file => JSON.parse(fs.readFileSync(file, "utf8"));
const writeJson = (file, value) => fs.writeFileSync(file, JSON.stringify(value));
const envelope = (payload, storageEpoch = 1, schema = 1) => ({ schema, storageEpoch, payload, digest: payloadDigest(payload) });
const basePayload = () => ({ project: project("base"), runtimes: {}, receipts: [] });

try {
  assert.strictEqual(DURABLE_STORE_SCHEMA, 1);
  error(() => new DurableWorkflowStore(temporary(), { schema: 0 }), "schema-invalid");
  error(() => new DurableWorkflowStore(temporary(), { schema: 1.5 }), "schema-invalid");

  const directory = temporary();
  const store = new DurableWorkflowStore(directory);
  error(() => store.read(), "store-missing");
  error(() => store.transact(command("missing", 0), "write", () => ({ result: null })), "store-missing");
  error(() => new DurableWorkflowStore(temporary()).initialize(project("bad-epoch"), command("init", 1)), "storage-epoch-conflict");

  const initialized = store.initialize(project("one"), command("init", 0));
  assert.strictEqual(initialized.replayed, false);
  assert.strictEqual(initialized.envelope.storageEpoch, 1);
  assert.strictEqual(initialized.receipt.operation, "initialize");
  assert.strictEqual(initialized.receipt.result, null);
  assert.deepStrictEqual(store.read(), initialized.envelope);
  initialized.envelope.payload.project.rootId = "caller-mutated";
  assert.notStrictEqual(store.read().payload.project.rootId, "caller-mutated");
  const initReplay = store.initialize(project("ignored"), command("init", 999));
  assert.strictEqual(initReplay.replayed, true);
  assert.strictEqual(initReplay.receipt.storageEpoch, 1);
  error(() => store.initialize(project("two"), command("other-init", 1)), "store-exists");
  error(() => store.initialize(project("two"), command("init", 1, "different")), "command-conflict");
  error(() => store.transact(command("stale", 0), "write", () => ({ result: null })), "storage-epoch-conflict");
  error(() => store.transact(command("empty-op", 1), "", () => ({ result: null })), "operation-required");

  const runtimeOne = createRuntimeModel("run-1", "node-1", 100, 90);
  const runtimeTwo = createRuntimeModel("run-2", "node-2", 200, 190);
  let callbackPayload;
  const written = store.transact(command("put-runs", 1), "put-runtimes", payload => {
    callbackPayload = payload;
    payload.receipts[0].operation = "mutated-copy";
    return { runtimes: { "run-1": runtimeOne, "run-2": runtimeTwo }, result: { count: 2 } };
  });
  assert.strictEqual(written.replayed, false);
  assert.deepStrictEqual(written.receipt.result, { count: 2 });
  assert.deepStrictEqual(Object.keys(written.envelope.payload.runtimes), ["run-1", "run-2"]);
  assert.strictEqual(written.envelope.payload.receipts[0].operation, "initialize");
  callbackPayload.project.rootId = "late-mutation";
  written.receipt.result.count = 99;
  assert.strictEqual(store.read().payload.project.rootId, "root_one");
  assert.deepStrictEqual(store.read().payload.receipts.at(-1).result, { count: 2 });

  const replay = store.transact(command("put-runs", 0), "ignored", () => { throw new Error("must not run"); });
  assert.strictEqual(replay.replayed, true);
  assert.deepStrictEqual(replay.receipt.result, { count: 2 });
  error(() => store.transact(command("put-runs", 2, "different"), "ignored", () => ({ result: null })), "command-conflict");

  const projectUpdate = project("updated");
  const updated = store.transact(command("project", 2), "put-project", () => ({ project: projectUpdate, result: "ok" }));
  assert.strictEqual(updated.envelope.payload.project.rootId, "root_updated");
  assert.strictEqual(updated.envelope.payload.runtimes["run-1"].run.runId, "run-1");
  assert.strictEqual(payloadDigest(updated.envelope.payload), updated.envelope.digest);

  for (const point of ["before-journal", "after-journal-fsync", "after-snapshot-rename", "after-journal-cleanup"]) {
    const crashDirectory = temporary();
    new DurableWorkflowStore(crashDirectory).initialize(project(point), command("init", 0));
    const crashing = new DurableWorkflowStore(crashDirectory, { crash: candidate => {
      if (candidate === point) throw new Error(`crash:${point}`);
    } });
    assert.throws(() => crashing.transact(command("crash-command", 1), "crash-test", payload => ({
      runtimes: { ...payload.runtimes, crash: runtimeOne }, result: point
    })), new RegExp(`crash:${point}`));
    const recovered = new DurableWorkflowStore(crashDirectory).read();
    const committed = point !== "before-journal";
    assert.strictEqual(recovered.storageEpoch, committed ? 2 : 1);
    assert.strictEqual(recovered.payload.receipts.filter(item => item.commandId === "crash-command").length, committed ? 1 : 0);
    assert.strictEqual(fs.existsSync(journalPath(crashDirectory)), false);
  }

  const initializeCrashDirectory = temporary();
  const initializeCrash = new DurableWorkflowStore(initializeCrashDirectory, { crash: point => {
    if (point === "after-journal-fsync") throw new Error("initial-crash");
  } });
  assert.throws(() => initializeCrash.initialize(project("initial-crash"), command("init", 0)), /initial-crash/);
  assert.strictEqual(new DurableWorkflowStore(initializeCrashDirectory).read().storageEpoch, 1);

  const corruptionCases = [
    value => { value.digest = "0".repeat(64); },
    value => { value.schema = "1"; },
    value => { value.storageEpoch = 0; },
    value => { value.payload = null; },
    value => { value.digest = null; },
    value => { value.payload.project = null; },
    value => { value.payload.runtimes = null; },
    value => { value.payload.receipts = null; }
  ];
  for (const corrupt of corruptionCases) {
    const corruptDirectory = temporary();
    const corruptStore = new DurableWorkflowStore(corruptDirectory);
    corruptStore.initialize(project("corrupt"), command("init", 0));
    const value = readJson(snapshotPath(corruptDirectory));
    corrupt(value);
    writeJson(snapshotPath(corruptDirectory), value);
    error(() => corruptStore.read(), "store-corrupt");
  }
  const malformedDirectory = temporary();
  fs.writeFileSync(snapshotPath(malformedDirectory), "{");
  error(() => new DurableWorkflowStore(malformedDirectory).read(), "store-corrupt");
  const wrongSchemaDirectory = temporary();
  writeJson(snapshotPath(wrongSchemaDirectory), envelope(basePayload(), 1, 2));
  error(() => new DurableWorkflowStore(wrongSchemaDirectory).read(), "store-corrupt");

  const journalCorruptDirectory = temporary();
  new DurableWorkflowStore(journalCorruptDirectory).initialize(project("journal"), command("init", 0));
  fs.writeFileSync(journalPath(journalCorruptDirectory), "{");
  error(() => new DurableWorkflowStore(journalCorruptDirectory).read(), "journal-corrupt");
  fs.writeFileSync(journalPath(journalCorruptDirectory), "null");
  error(() => new DurableWorkflowStore(journalCorruptDirectory).read(), "journal-corrupt");
  writeJson(journalPath(journalCorruptDirectory), { baseEpoch: "1", envelope: readJson(snapshotPath(journalCorruptDirectory)) });
  error(() => new DurableWorkflowStore(journalCorruptDirectory).read(), "journal-corrupt");

  const journalConflictDirectory = temporary();
  const conflictStore = new DurableWorkflowStore(journalConflictDirectory);
  conflictStore.initialize(project("conflict"), command("init", 0));
  const current = conflictStore.read();
  writeJson(journalPath(journalConflictDirectory), { baseEpoch: 99, envelope: { ...current, storageEpoch: 2 } });
  error(() => conflictStore.read(), "journal-conflict");
  writeJson(journalPath(journalConflictDirectory), { baseEpoch: 99, envelope: current });
  error(() => conflictStore.read(), "journal-conflict");
  writeJson(journalPath(journalConflictDirectory), { baseEpoch: 1, envelope: envelope(current.payload, 2, 2) });
  error(() => conflictStore.read(), "journal-conflict");
  const orphanJournalDirectory = temporary();
  writeJson(journalPath(orphanJournalDirectory), { baseEpoch: 1, envelope: envelope(basePayload(), 2) });
  error(() => new DurableWorkflowStore(orphanJournalDirectory).read(), "journal-conflict");

  const migrationDirectory = temporary();
  const migrationStore = new DurableWorkflowStore(migrationDirectory);
  migrationStore.initialize(project("migration"), command("init", 0), { "run-1": runtimeOne });
  for (const [owner, fence, target] of [["", 1, 2], ["owner", 0, 2], ["owner", 1.5, 2], ["owner", 1, 1], ["owner", 1, 1.5]]) {
    error(() => migrationStore.beginMigration(command(`invalid-${owner}-${fence}-${target}`, 1), owner, fence, target), "migration-invalid");
  }
  const begun = migrationStore.beginMigration(command("begin", 1), "owner", 7, 2);
  assert.strictEqual(begun.envelope.storageEpoch, 2);
  assert.deepStrictEqual(begun.receipt.result, {
    owner: "owner", fence: 7, fromSchema: 1, targetSchema: 2, startedAtEpoch: 2
  });
  assert.strictEqual(migrationStore.beginMigration(command("begin", 0), "ignored", 1, 3).replayed, true);
  error(() => migrationStore.beginMigration(command("second-begin", 2), "owner", 8, 3), "migration-active");
  error(() => migrationStore.transact(command("blocked", 2), "write", () => ({ result: null })), "migration-active");
  error(() => migrationStore.completeMigration(command("complete-bad-owner", 2), "other", 7, () => ({ result: null })), "migration-fenced");
  error(() => migrationStore.completeMigration(command("complete-bad-fence", 2), "owner", 8, () => ({ result: null })), "migration-fenced");
  const completed = migrationStore.completeMigration(command("complete", 2), "owner", 7, payload => ({
    project: project("migrated"), runtimes: payload.runtimes, result: "migrated"
  }));
  assert.strictEqual(completed.envelope.schema, 2);
  assert.strictEqual(completed.envelope.storageEpoch, 3);
  assert.strictEqual(completed.envelope.payload.migration, undefined);
  assert.strictEqual(completed.envelope.payload.project.rootId, "root_migrated");
  assert.strictEqual(new DurableWorkflowStore(migrationDirectory, { schema: 2 }).read().schema, 2);
  error(() => migrationStore.read(), "store-corrupt");

  const migrationCrashDirectory = temporary();
  const oldStore = new DurableWorkflowStore(migrationCrashDirectory);
  oldStore.initialize(project("migration-crash"), command("init", 0));
  oldStore.beginMigration(command("begin", 1), "owner", 9, 2);
  const crashingMigration = new DurableWorkflowStore(migrationCrashDirectory, { crash: point => {
    if (point === "after-journal-fsync") throw new Error("migration-crash");
  } });
  assert.throws(() => crashingMigration.completeMigration(command("complete", 2), "owner", 9, () => ({ result: "done" })), /migration-crash/);
  const recoveredMigration = crashingMigration.completeMigration(command("complete", 2), "owner", 9, () => { throw new Error("must replay"); });
  assert.strictEqual(recoveredMigration.replayed, true);
  assert.strictEqual(recoveredMigration.envelope.schema, 2);
  assert.strictEqual(new DurableWorkflowStore(migrationCrashDirectory, { schema: 2 }).read().storageEpoch, 3);

  const originalOpen = fs.openSync;
  const unsupportedDirectory = temporary();
  fs.openSync = function (target, flags, ...rest) {
    if (target === unsupportedDirectory && flags === "r") {
      const unsupported = new Error("unsupported");
      unsupported.code = "EINVAL";
      throw unsupported;
    }
    return originalOpen.call(this, target, flags, ...rest);
  };
  try {
    assert.strictEqual(new DurableWorkflowStore(unsupportedDirectory).initialize(project("unsupported"), command("init", 0)).envelope.storageEpoch, 1);
  } finally {
    fs.openSync = originalOpen;
  }

  const fsyncErrorDirectory = temporary();
  fs.openSync = function (target, flags, ...rest) {
    if (target === fsyncErrorDirectory && flags === "r") {
      const denied = new Error("denied");
      denied.code = "EACCES";
      throw denied;
    }
    return originalOpen.call(this, target, flags, ...rest);
  };
  try {
    assert.throws(() => new DurableWorkflowStore(fsyncErrorDirectory).initialize(project("denied"), command("init", 0)), /denied/);
  } finally {
    fs.openSync = originalOpen;
  }

  const nullErrorDirectory = temporary();
  fs.openSync = function (target, flags, ...rest) {
    if (target === nullErrorDirectory && flags === "r") throw null;
    return originalOpen.call(this, target, flags, ...rest);
  };
  try {
    assert.throws(() => new DurableWorkflowStore(nullErrorDirectory).initialize(project("null-error"), command("init", 0)), value => value === null);
  } finally {
    fs.openSync = originalOpen;
  }

  console.log("workflow durable store test: CAS, idempotency, recovery, corruption, and migration contracts OK");
} finally {
  fs.openSync = fs.openSync;
  for (const directory of roots) fs.rmSync(directory, { recursive: true, force: true });
}