import assert from "node:assert/strict";
import { test } from "node:test";
import { nativeRestoreAuthority } from "./host-composition-legacy-batch16-restore-fixture.mjs";
import { randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { readdir } from "node:fs/promises";
import { join } from "node:path";
import { Core } from "../dist/core.js";
import { importLegacyWorkspace, planLegacyImport } from "../dist/legacy-import.js";
import { checkLegacyProjectCommand, recordLegacyProjectCommand } from "../dist/legacy-project-command.js";
import {
  initializeLegacyControlSchema, insertLegacyControlSnapshot, legacyProjectDomainDigest,
  inspectLegacyControlRecovery, parseLegacyProjectControl, parseLegacyRecipeControl, readCurrentLegacyProjectSnapshot,
  readLegacyProjectControl, readLegacyRecipeControl,
} from "../dist/legacy-control-import.js";
import { Storage } from "../dist/storage.js";
import { createWorkspaceBackup, restoreWorkspaceBackup } from "../dist/workspace-backup.js";
import { fixture, hash, hashes, host, identity, pythonExecutable } from "./batch09-original-control-fixtures.mjs";

const call = (core, operation, args, write = false) => core.dispatch(
  write ? "capability_call" : "capability_read",
  { operation, version: 1, arguments: args },
  { id: "batch09:owner", canWrite: write },
);
const result = async (...args) => {
  const response = await call(...args);
  assert.equal(response.error, undefined, JSON.stringify(response.error));
  return response.result;
};

test("legacy control DDL and command receipts are versioned, ordered and transactionally fenced", async t => {
  const f = await fixture(t);
  const model = { projects: [f.project], threads: [f.thread], ganttTasks: [], collaborationTasks: [], recipes: [f.recipe] };
  const projectControl = parseLegacyProjectControl(f.projectControlBytes, model);
  const recipeControl = parseLegacyRecipeControl(f.recipeControlBytes, model);
  const database = new DatabaseSync(":memory:");
  try {
    database.exec("PRAGMA foreign_keys=ON; BEGIN IMMEDIATE");
    initializeLegacyControlSchema(database);
    database.exec("COMMIT");
    database.exec("BEGIN IMMEDIATE");
    insertLegacyControlSnapshot(database, "00000000-0000-4000-8000-000000000001", projectControl, recipeControl);
    database.exec("COMMIT");

    const workspaceId = "00000000-0000-4000-8000-000000000001";
    const command = {
      commandId: "new-transactional-command",
      fingerprint: "opaque-fingerprint-not-a-digest",
      operation: "project.update",
      expectedStoreVersion: 8,
    };
    const before = readLegacyProjectControl(database, workspaceId);
    assert.throws(() => checkLegacyProjectCommand(database, workspaceId, {
      ...command, expectedStoreVersion: 1,
    }, { marker: "current" }), { code: "STORE_VERSION_CONFLICT" });
    assert.equal(checkLegacyProjectCommand(database, workspaceId, command, { marker: "current" }).status, "new");
    database.exec("BEGIN IMMEDIATE");
    assert.equal(recordLegacyProjectCommand(database, workspaceId, command, {
      entityId: f.projectId, canonicalDigest: before.canonicalDigest,
    }), 9);
    database.exec("ROLLBACK");
    assert.equal(readLegacyProjectControl(database, workspaceId).storeVersion, 8);
    assert.equal(readLegacyProjectControl(database, workspaceId).receipts.length, 1);
    database.exec("BEGIN IMMEDIATE");
    assert.equal(recordLegacyProjectCommand(database, workspaceId, command, {
      entityId: f.projectId, canonicalDigest: before.canonicalDigest,
    }), 9);
    database.exec("COMMIT");
    const committed = readLegacyProjectControl(database, workspaceId);
    assert.equal(committed.storeVersion, 9);
    assert.deepEqual(committed.receipts.map(({ ordinal: _ordinal, ...item }) => item), [
      f.originalReceipt,
      {
        commandId: command.commandId, fingerprint: command.fingerprint, operation: command.operation,
        storeVersion: 9, entityId: f.projectId,
      },
    ]);
    database.exec("BEGIN IMMEDIATE");
    database.prepare("INSERT INTO legacy_recipe_control(workspace_id,control_bytes,control_sha256) VALUES(?,?,?)")
      .run("00000000-0000-4000-8000-000000000002", recipeControl.controlBytes, recipeControl.controlSha256);
    database.exec("COMMIT");
    assert.throws(() => inspectLegacyControlRecovery(database, workspaceId), { code: "CONTROL_STORAGE_CORRUPT" });
  } finally { database.close(); }

  const orphanDatabase = new DatabaseSync(":memory:");
  try {
    orphanDatabase.exec("BEGIN IMMEDIATE");
    initializeLegacyControlSchema(orphanDatabase);
    orphanDatabase.exec("COMMIT");
    orphanDatabase.exec("PRAGMA foreign_keys=OFF");
    orphanDatabase.prepare(`INSERT INTO legacy_project_receipt
      (workspace_id,ordinal,command_id,fingerprint,operation,store_version,entity_id) VALUES(?,?,?,?,?,?,?)`)
      .run("00000000-0000-4000-8000-000000000003", 0, "orphan", "fingerprint", "project.update", 1, "project_orphan");
    assert.throws(() => inspectLegacyControlRecovery(orphanDatabase, "00000000-0000-4000-8000-000000000003"),
      { code: "CONTROL_STORAGE_CORRUPT" });
  } finally { orphanDatabase.close(); }
});

test("original controls import byte-exactly into SQLite and preserve current legacy receipt replay through backup/restart", { timeout: 45_000 }, async t => {
  const f = await fixture(t);
  const originalSource = await hashes(f.source);
  const plan = await planLegacyImport(f.source);
  assert.equal(plan.ready, true, JSON.stringify(plan.blockers));
  assert.deepEqual(plan.entries.filter(entry => entry.source.startsWith(".pkm/")).map(entry => [entry.source, entry.sha256]), [
    [".pkm/state/project-store.json", hash(f.projectControlBytes)],
    [".pkm/state/recipe-store.json", hash(f.recipeControlBytes)],
  ]);
  const receipt = await importLegacyWorkspace(plan, f.target, { pythonExecutable });
  assert.deepEqual(receipt.controls, [
    { path: ".pkm/state/project-store.json", table: "legacy_project_control", sha256: hash(f.projectControlBytes), size: f.projectControlBytes.length },
    { path: ".pkm/state/recipe-store.json", table: "legacy_recipe_control", sha256: hash(f.recipeControlBytes), size: f.recipeControlBytes.length },
  ]);
  assert.deepEqual(await hashes(f.source), originalSource);
  await assert.rejects(readdir(join(f.target, ".pkm")), { code: "ENOENT" });

  const storage = await Storage.open(f.target);
  let storageClosed = false;
  t.after(async () => { if (!storageClosed) await storage.close(); });
  const workspaceId = await storage.workspaceId();
  const core = new Core(storage);
  const initialSnapshot = await result(core, "project.get", { id: f.projectId });
  const initialRecipe = await result(core, "project.recipe.get", { id: f.recipe.recipeId });
  assert.equal(initialSnapshot.item.projectId, identity(f.rootId, "default-project"));
  assert.equal(initialSnapshot.threads[0].threadId, identity(f.projectId, "general-thread"));
  assert.equal(initialRecipe.item.knowledgeId, f.recipe.knowledgeId);

  const database = storage.connectNative();
  let databaseOpen = true;
  t.after(() => { if (databaseOpen) database.close(); });
  const originalState = readLegacyProjectControl(database, workspaceId);
  const originalRecipeState = readLegacyRecipeControl(database, workspaceId);
  assert.equal(originalState.rootId, f.rootId);
  assert.notEqual(workspaceId, f.rootId);
  assert.equal(originalState.controlBytes.compare(f.projectControlBytes), 0);
  assert.equal(originalState.controlSha256, hash(f.projectControlBytes));
  assert.deepEqual(originalState.receipts, [{ ...f.originalReceipt, ordinal: 0 }]);
  assert.equal(originalRecipeState.controlBytes.compare(f.recipeControlBytes), 0);
  assert.equal(originalRecipeState.controlSha256, hash(f.recipeControlBytes));

  const replayCommand = {
    commandId: f.originalReceipt.commandId,
    fingerprint: f.originalReceipt.fingerprint,
    operation: "not-replayed-operation",
    expectedStoreVersion: 1,
  };
  const replay = checkLegacyProjectCommand(database, workspaceId, replayCommand, initialSnapshot);
  assert.deepEqual(replay, {
    status: "replay", snapshot: initialSnapshot, entityId: f.projectId, replayed: true,
  });
  assert.throws(() => checkLegacyProjectCommand(database, workspaceId, {
    ...replayCommand, fingerprint: "different opaque fingerprint",
  }, initialSnapshot), { code: "COMMAND_CONFLICT" });

  const command = {
    commandId: "new-command-from-compatible-adapter",
    fingerprint: "opaque caller-owned update fingerprint",
    operation: "project.update",
    expectedStoreVersion: 8,
  };
  assert.deepEqual(checkLegacyProjectCommand(database, workspaceId, command, initialSnapshot), {
    status: "new", expectedStoreVersion: 8, nextStoreVersion: 9, replayed: false,
  });
  const pin = await result(core, "project.mutation.pin", { entityKind: "project", id: f.projectId });
  const updated = await result(core, "project.legacy.command", {
    operationId: randomUUID(),
    command,
    update: {
      expectedSnapshotRevision: pin.snapshotRevision, projectId: f.projectId,
      expectedVersion: f.project.version, expectedSha256: hash(f.files[f.projectPath]),
      overview: { goal: "Batch09 verified" }, reason: "Synthetic original-control compatibility check",
      at: "2026-02-01T00:00:00.000Z",
    },
  }, true);
  assert.equal(updated.replayed, false);
  assert.equal(updated.storeVersion, 9);
  assert.equal(updated.entityId, f.projectId);
  const afterMutation = await result(core, "project.get", { id: f.projectId });
  const currentDomain = readCurrentLegacyProjectSnapshot(database, workspaceId);
  assert.equal(legacyProjectDomainDigest(currentDomain), readLegacyProjectControl(database, workspaceId).canonicalDigest);
  assert.equal(currentDomain.projects[0].version, f.project.version + 1);
  assert.throws(() => checkLegacyProjectCommand(database, workspaceId, {
    ...command, commandId: "stale-second-command",
  }, afterMutation), { code: "STORE_VERSION_CONFLICT" });
  assert.throws(() => checkLegacyProjectCommand(database, workspaceId, {
    ...command, commandId: "unsupported-command", operation: "project.delete", expectedStoreVersion: 9,
  }, afterMutation), { code: "LEGACY_COMMAND_UNSUPPORTED" });

  const postMutationReplay = checkLegacyProjectCommand(database, workspaceId, {
    ...command, expectedStoreVersion: 8,
  }, currentDomain);
  assert.equal(postMutationReplay.status, "replay");
  assert.equal(postMutationReplay.snapshot.projects[0].version, f.project.version + 1);
  assert.equal(postMutationReplay.entityId, f.projectId);

  await createWorkspaceBackup(storage, f.backup, host, { pythonExecutable });
  database.close();
  databaseOpen = false;
  await storage.close();
  storageClosed = true;
  await restoreWorkspaceBackup(f.backup, f.restored, { pythonExecutable, nativeRestoreAuthority });
  const reopened = await Storage.open(f.restored);
  try {
    const reopenedId = await reopened.workspaceId();
    const reopenedDatabase = reopened.connectNative();
    try {
      const preserved = readLegacyProjectControl(reopenedDatabase, reopenedId);
      const recipeControl = readLegacyRecipeControl(reopenedDatabase, reopenedId);
      assert.equal(preserved.controlBytes.compare(f.projectControlBytes), 0);
      assert.equal(preserved.controlSha256, hash(f.projectControlBytes));
      assert.equal(preserved.storeVersion, 9);
      assert.deepEqual(preserved.receipts.map(({ ordinal: _ordinal, ...item }) => item), [
        f.originalReceipt,
        { commandId: command.commandId, fingerprint: command.fingerprint, operation: command.operation, storeVersion: 9, entityId: f.projectId },
      ]);
      assert.equal(recipeControl.controlBytes.compare(f.recipeControlBytes), 0);
      const reopenedCore = new Core(reopened);
      const current = readCurrentLegacyProjectSnapshot(reopenedDatabase, reopenedId);
      const receiptCount = preserved.receipts.length;
      const replayAfterRestart = await result(reopenedCore, "project.legacy.command", {
        operationId: randomUUID(),
        command: { ...command, expectedStoreVersion: 1 },
      }, true);
      assert.equal(replayAfterRestart.replayed, true);
      assert.equal(replayAfterRestart.snapshot.projects[0].version, f.project.version + 1);
      assert.equal(replayAfterRestart.entityId, f.projectId);
      assert.equal(readLegacyProjectControl(reopenedDatabase, reopenedId).receipts.length, receiptCount);
      assert.equal(current.projects[0].version, f.project.version + 1);
    } finally { reopenedDatabase.close(); }
  } finally { await reopened.close(); }
});

test("only source-qualified quiescent original controls are admitted; pending, unknown, trash and altered controls fail closed", async t => {
  const cases = [
    [".pkm/state/project-store-intent.json", "{}"],
    [".pkm/state/project-store-migration/migration.json", "{}"],
    [".pkm/state/recipe-store-migration/migration.json", "{}"],
    [".pkm/state/unknown-control.json", "{}"],
    ["recipes/.trash/old.json", "{}"],
  ];
  for (const [path, content] of cases) {
    const f = await fixture(t);
    await f.file(path, content);
    const original = await hashes(f.source);
    const plan = await planLegacyImport(f.source);
    assert.equal(plan.ready, false, `${path}: ${JSON.stringify(plan.blockers)}`);
    await assert.rejects(importLegacyWorkspace(plan, f.target, { pythonExecutable }), { code: "IMPORT_BLOCKED" });
    assert.deepEqual(await hashes(f.source), original);
    await assert.rejects(readdir(f.target), { code: "ENOENT" });
  }
  const badDigest = await fixture(t);
  await badDigest.file(".pkm/state/project-store.json", JSON.stringify({
    ...badDigest.projectControl, canonicalDigest: "0".repeat(64),
  }));
  const badDigestPlan = await planLegacyImport(badDigest.source);
  assert.equal(badDigestPlan.ready, false);
  assert(badDigestPlan.blockers.some(item => item.code === "INVALID_CONTROL_DIGEST"), JSON.stringify(badDigestPlan.blockers));
  await assert.rejects(readdir(badDigest.target), { code: "ENOENT" });
});
