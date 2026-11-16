import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { z } from "zod";
import { assertWorkspaceBackupQuiescent, createWorkspaceBackup, restoreWorkspaceBackup } from "../dist/workspace-backup.js";
import {
  LEGACY_CLASSIFICATION_NATIVE_CONTRACT, LEGACY_CLASSIFICATION_NATIVE_DDL,
  executeNativeClassification, scanNativeClassification,
} from "../dist/legacy-classification-native.js";
import { CoreError, definitions } from "../dist/contracts.js";
import { CoreError as NoncyclicCoreError } from "../dist/host-composition-legacy-batch15-errors.js";
import { Storage } from "../dist/storage.js";
import { createNativeRuntime } from "../dist/native-runtime.js";
import { fixture, fixturePublisher, hash } from "./host-composition-legacy-batch15-captures.mjs";

test("strict Batch16 catalog schemas export as JSON and remain unavailable without native composition", async t => {
  const ids = ["knowledge.classification.native-strict.command", "memory.scope.forget.native"];
  for (const id of ids) {
    const definition = definitions.find(item => item.id === id);
    assert(definition);
    assert.doesNotThrow(() => JSON.stringify(z.toJSONSchema(definition.input, { io: "input" })));
    assert.doesNotThrow(() => JSON.stringify(z.toJSONSchema(definition.output)));
  }
  const f = await fixture(t);
  for (const operation of ids) {
    const result = await f.runtime.core.dispatch("capabilities_describe", { operation }, {
      id: "human", canWrite: true, collaborationKind: "human",
    });
    assert.equal(result.error?.code, "NOT_FOUND");
  }
});

test("backup quiescence fences classification and pending memory erasure independently", () => {
  const db = new DatabaseSync(":memory:");
  try {
    db.exec("CREATE TABLE receipts (operation_id TEXT, fingerprint TEXT, result TEXT)");
    db.exec(LEGACY_CLASSIFICATION_NATIVE_DDL);
    assert.doesNotThrow(() => assertWorkspaceBackupQuiescent(db));
    db.exec("INSERT INTO legacy_classification_native_intent VALUES (1, 'classification', '{}', 'invalid')");
    assert.throws(() => assertWorkspaceBackupQuiescent(db), { code: "CONFLICT" });
    db.exec("DELETE FROM legacy_classification_native_intent");
    db.exec("INSERT INTO legacy_classification_native_receipt VALUES ('classification', '{}', 'invalid')");
    assert.throws(() => assertWorkspaceBackupQuiescent(db), { code: "CONFLICT" });
    db.exec("DROP TRIGGER legacy_classification_native_receipt_no_delete");
    db.exec("DELETE FROM legacy_classification_native_receipt");
    db.exec("DROP TABLE legacy_classification_native_intent; DROP TABLE legacy_classification_native_receipt");
    db.exec("CREATE TABLE legacy_memory_erasure_operations (operation_id TEXT, status TEXT)");
    assert.throws(() => assertWorkspaceBackupQuiescent(db), { code: "AUTHORITY_REQUIRED" });
    db.exec("INSERT INTO legacy_memory_erasure_operations VALUES ('memory', 'pending')");
    assert.throws(() => assertWorkspaceBackupQuiescent(db), { code: "PENDING_JOURNAL" });
    db.exec("UPDATE legacy_memory_erasure_operations SET status='committed'");
    assert.throws(() => assertWorkspaceBackupQuiescent(db), { code: "AUTHORITY_REQUIRED" });
  } finally {
    db.close();
  }
});

test("classification corruption uses the same CoreError and fences native admission and reopen", async t => {
  const f = await fixture(t);
  assert.equal(CoreError, NoncyclicCoreError);
  f.database.exec(LEGACY_CLASSIFICATION_NATIVE_DDL);
  f.database.exec("INSERT INTO legacy_classification_native_receipt VALUES ('bad', '{}', 'invalid')");
  const result = await f.runtime.core.dispatch("capabilities_list", {}, {
    id: "human", canWrite: true, collaborationKind: "human",
  });
  assert.equal(result.error?.code, "CONFLICT");
  await f.close();
  await assert.rejects(Storage.open(f.root), /Corrupt classification journal/);
});

test("rehashed forged classification effects are rejected by read, backup, startup and restore", async t => {
  const f = await fixture(t);
  const backup = join(f.parent, "clean-backup"), destination = join(f.parent, "restore");
  const hostAdapter = { async acquireQuiescence() { return { assertHeld() {}, release() {} }; } };
  await createWorkspaceBackup(f.storage, backup, hostAdapter, { nativePublishNoReplace: fixturePublisher(f.parent) });
  const root = join(f.root, "packages/original");
  await mkdir(join(root, "notes"));
  await writeFile(join(root, "notes", "a.md"), "# A\n");
  const actor = { id: "human", canWrite: true, collaborationKind: "human" };
  const scope = { workspaceId: await f.storage.workspaceId(), sourceRootId: "b".repeat(64), root };
  const original = f.original("src/knowledge/asset-classification.ts");
  const host = {
    assertOwnedDisposableFixture() {},
    authorize: () => true,
    authorizeRoot: (_workspace, _source, candidate) => candidate === root,
    approveRecovery: () => true,
    previewOriginal: original.previewAssetClassification,
    assertNoOtherPending() {},
    globalReceipt(db, id) {
      const row = db.prepare("SELECT fingerprint,result FROM receipts WHERE operation_id=?").get(id);
      return row ? { fingerprint: row.fingerprint, result: JSON.parse(row.result) } : null;
    },
    writeGlobalReceipt(db, id, fingerprint, result) {
      db.prepare("INSERT INTO receipts VALUES(?,?,?,?,?,?)")
        .run(id, fingerprint, JSON.stringify(result), actor.id, "fixture.classification.strict", new Date().toISOString());
    },
  };
  f.database.exec(LEGACY_CLASSIFICATION_NATIVE_DDL);
  const preview = original.previewAssetClassification(root);
  const proposal = preview.proposals.find(item => item.type === "classification" && item.asset === "notes/a.md");
  assert.ok(proposal);
  const request = {
    contract: LEGACY_CLASSIFICATION_NATIVE_CONTRACT, action: "apply", operationId: randomUUID(),
    previewId: preview.id, layoutSha256: scanNativeClassification(f.database, host, root).layoutSha256,
    proposalIds: [proposal.id],
  };
  executeNativeClassification(f.database, host, scope, actor, request);
  const row = f.database.prepare("SELECT * FROM legacy_classification_native_receipt WHERE operation_id=?").get(request.operationId);
  const global = f.database.prepare("SELECT * FROM receipts WHERE operation_id=?").get(request.operationId);
  const forged = JSON.parse(row.payload);
  forged.effects[0].after = Buffer.from("forged classification bytes").toString("base64");
  const payload = JSON.stringify(forged), payloadHash = hash(payload);
  const triggerSql = f.database.prepare("SELECT sql FROM sqlite_master WHERE name='legacy_classification_native_receipt_no_update'").get().sql;
  f.database.exec("DROP TRIGGER legacy_classification_native_receipt_no_update");
  f.database.prepare("UPDATE legacy_classification_native_receipt SET payload=?,payload_sha256=? WHERE operation_id=?")
    .run(payload, payloadHash, request.operationId);
  f.database.exec(triggerSql);
  const result = await f.runtime.core.dispatch("capabilities_list", {}, actor);
  assert.equal(result.error?.code, "CONFLICT");
  await assert.rejects(createWorkspaceBackup(f.storage, join(f.parent, "forged-backup"), hostAdapter,
    { nativePublishNoReplace: fixturePublisher(f.parent) }), /differs from original source semantics/);
  await f.close();
  await assert.rejects(Storage.open(f.root), /differs from original source semantics/);

  const backupDb = new DatabaseSync(join(backup, "core.sqlite"));
  try {
    backupDb.exec(LEGACY_CLASSIFICATION_NATIVE_DDL);
    backupDb.prepare("INSERT INTO receipts VALUES(?,?,?,?,?,?)").run(
      global.operation_id, global.fingerprint, global.result, global.actor_id, global.operation, global.committed_at);
    backupDb.prepare("INSERT INTO legacy_classification_native_receipt VALUES(?,?,?)")
      .run(request.operationId, payload, payloadHash);
  } finally { backupDb.close(); }
  const manifestPath = join(backup, ".pkm-workspace-backup.json");
  const manifest = JSON.parse(await readFile(manifestPath));
  const sqlite = await readFile(join(backup, "core.sqlite"));
  const entry = manifest.files.find(file => file.path === "core.sqlite");
  manifest.totalBytes += sqlite.length - entry.size;
  entry.size = sqlite.length;
  entry.sha256 = hash(sqlite);
  await writeFile(manifestPath, JSON.stringify(manifest));
  await assert.rejects(restoreWorkspaceBackup(backup, destination,
    { nativePublishNoReplace: fixturePublisher(f.parent) }), /differs from original source semantics/);
  assert.equal((await readdir(f.parent)).some(name => name === "restore" || name.startsWith(".pkm-restore.")), false);
});

test("native backup refuses an erasure-enabled workspace before staging", async t => {
  const f = await fixture(t);
  const db = f.storage.connectNative();
  try {
    db.prepare("INSERT INTO legacy_memory_erasure_schema VALUES (1,1)").run();
    db.prepare("INSERT INTO legacy_memory_erasure_state VALUES (1,?,0)").run(await f.storage.workspaceId());
  } finally {
    db.close();
  }
  const adapter = {
    async acquireQuiescence() {
      return { assertHeld() {}, release() {} };
    },
  };
  await assert.rejects(
    createWorkspaceBackup(f.storage, join(f.parent, "backup"), adapter, {
      nativePublishNoReplace: fixturePublisher(f.parent),
    }),
    { code: "AUTHORITY_REQUIRED" },
  );
  assert.equal((await readdir(f.parent)).some(name => name === "backup" || name.startsWith(".pkm-backup.")), false);
  const result = await f.runtime.core.dispatch("capabilities_list", {}, {
    id: "human", canWrite: true, collaborationKind: "human",
  });
  assert.equal(result.error?.code, "RECOVERY_AUTHORITY_REQUIRED");
  await f.close();
  const inspectionOnly = await Storage.open(f.root);
  try {
    await assert.rejects(createNativeRuntime({ storage: inspectionOnly }), { code: "RECOVERY_AUTHORITY_REQUIRED" });
    await assert.rejects(inspectionOnly.request({ operation: "document.list", args: {}, actorId: "human" }),
      { code: "STORAGE_UNAVAILABLE" });
  } finally {
    await inspectionOnly.close();
  }
});

test("legacy restore requires exact external authority before staging and rechecks before publication", async t => {
    const f = await fixture(t);
    const backup = join(f.parent, "backup"), target = join(f.parent, "restore");
    const hostAdapter = { async acquireQuiescence() { return { assertHeld() {}, release() {} }; } };
    const options = { nativePublishNoReplace: fixturePublisher(f.parent) };
    await createWorkspaceBackup(f.storage, backup, hostAdapter, options);
    await assert.rejects(restoreWorkspaceBackup(backup, target, options), { code: "AUTHORITY_REQUIRED" });
    const assertNoStage = async () => assert.equal(
      (await readdir(f.parent)).some(name => name === "restore" || name.startsWith(".pkm-restore.")), false);
    await assertNoStage();
    let calls = 0, mode = "newer";
    const nativeRestoreAuthority = {
      actorId: "fixture-human",
      async authorize(request) {
        calls++;
        assert.equal(request.workspaceId, await f.storage.workspaceId());
        assert.equal(request.destination, target);
        assert.equal(request.sourceRoot, backup);
        assert.equal(request.backupErasureEpoch, null);
        return { authorityId: "independent-fixture-policy", actorId: mode === "wrong-actor" ? "other" : request.actorId,
          requestSha256: mode === "wrong-pin" ? "0".repeat(64) : hash(JSON.stringify(request)),
          expiresAt: mode === "expired" ? Date.now() - 1 : Date.now() + 60_000,
          lineage: mode === "newer" ? "erasure-protected" : "unrelated",
          trustedEpoch: mode === "newer" ? 1 : null };
      },
    };
    await assert.rejects(restoreWorkspaceBackup(backup, target, { ...options, nativeRestoreAuthority }),
      { code: "ERASURE_EPOCH_MISMATCH" });
    await assertNoStage();
    mode = "wrong-pin";
    await assert.rejects(restoreWorkspaceBackup(backup, target, { ...options, nativeRestoreAuthority }),
      { code: "AUTHORITY_REQUIRED" });
    await assertNoStage();
    for (mode of ["wrong-actor", "expired"]) {
      await assert.rejects(restoreWorkspaceBackup(backup, target, { ...options, nativeRestoreAuthority }),
        { code: "AUTHORITY_REQUIRED" });
      await assertNoStage();
    }
    mode = "revoked";
    calls = 0;
    const authorize = nativeRestoreAuthority.authorize;
    nativeRestoreAuthority.authorize = async request => ++calls === 1 ? authorize(request) : null;
    await assert.rejects(restoreWorkspaceBackup(backup, target, { ...options, nativeRestoreAuthority }),
      { code: "AUTHORITY_REQUIRED" });
    await assertNoStage();
    nativeRestoreAuthority.authorize = authorize;
    mode = "unrelated";
    calls = 0;
    await restoreWorkspaceBackup(backup, target, { ...options, nativeRestoreAuthority });
    assert.equal(calls, process.platform === "linux" ? 4 : 3,
      "Restore reauthorizes before staging, after validation, before publication and after Linux fence marker binding");
});
