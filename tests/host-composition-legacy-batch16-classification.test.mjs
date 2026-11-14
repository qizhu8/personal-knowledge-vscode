import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { chmodSync, mkdirSync, readdirSync, writeFileSync } from "node:fs";
import { chmod, lstat, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { Storage } from "../dist/storage.js";
import { createNativeRuntime } from "../dist/native-runtime.js";
import { inspectNativeClassificationHistory, scanNativeClassification, validateNativeClassificationHistoryLayout } from "../dist/legacy-classification-native.js";
import { fixture, transports, actor, hash, fixturePublisher } from "./host-composition-legacy-batch15-captures.mjs";
import { createWorkspaceBackup, restoreWorkspaceBackup } from "../dist/workspace-backup.js";
import { nativeRestoreAuthority } from "./host-composition-legacy-batch16-restore-fixture.mjs";

test("original writer bytes flow through authenticated strict classification HTTP/MCP with pinned recovery", async t => {
  const transactionOwners = new Set(), originalExec = DatabaseSync.prototype.exec;
  DatabaseSync.prototype.exec = function(sql) {
    try { return originalExec.call(this, sql); }
    finally { if (this.isTransaction) transactionOwners.add(this); else transactionOwners.delete(this); }
  };
  t.after(() => { DatabaseSync.prototype.exec = originalExec; });
  const f = await fixture(t);
  const root = join(f.root, "packages/classification");
  const oracle = join(f.parent, "classification-oracle");
  const assets = f.original("src/knowledge/markdown-assets.ts");
  for (const base of [root, oracle]) {
    await mkdir(join(base, "notes"), { recursive: true });
    await writeFile(join(base, "notes/a.md"), "# Synthetic original note\n![image](a.assets/image.png)\n");
    assets.saveMarkdownAsset(base, "notes", "a.md", "image.png", Buffer.from([0, 1, 2, 255]));
    await chmod(join(base, "notes"), 0o750);
    await chmod(join(base, "notes/a.md"), 0o640);
  }
  const source = f.original("src/knowledge/asset-classification.ts");
  const policyState = { allowed: true, retry: false, owned: true, epochAllowed: true,
    acceptHistoryTransition: false, failEffect: true, anchor: undefined, sourceRootId: "a".repeat(64) };
  const adoptionState = { allowed: true, approvals: new Map() };
  const policy = {
    scope: "exclusive-native-disposable-fixture", sourceRelative: "packages/classification",
    sourceRootId: policyState.sourceRootId,
    assertFixtureOwnership() { assert.equal(policyState.owned, true); },
    authorize: who => policyState.allowed && who.id === actor.id,
    approveRecovery: () => policyState.retry,
    afterEffect() { if (policyState.failEffect) { policyState.failEffect = false; throw new Error("synthetic effect fault"); } },
    previewOriginal: source.previewAssetClassification,
    assertHistoryAnchor(value) {
      assert.equal(policyState.epochAllowed, true);
      if (!policyState.anchor) policyState.anchor = { rootPin: value.rootPin, genesisSha256: value.genesisSha256,
        historySha256: value.historySha256 };
      assert.deepEqual(value.rootPin, policyState.anchor.rootPin);
      assert.equal(value.genesisSha256, policyState.anchor.genesisSha256);
      if (value.historySha256 !== policyState.anchor.historySha256 && policyState.acceptHistoryTransition) {
        policyState.anchor.historySha256 = value.historySha256;
        policyState.acceptHistoryTransition = false;
      }
      assert.equal(value.historySha256, policyState.anchor.historySha256);
    },
    assertAdoptionAnchor(value) {
      for (const database of transactionOwners) assert.equal(database.isTransaction, false, "Strict native adoption authority must run outside every SQLite owner transaction.");
      assert.equal(adoptionState.allowed, true);
      const approval = adoptionState.approvals.get(value.operationId);
      assert(approval);
      assert.equal(value.authorityId, approval.authorityId);
      assert.equal(value.policyIdentity, approval.policyIdentity);
      assert.equal(value.trustedEpoch, approval.trustedEpoch);
      assert.equal(value.trustedEpoch, 9);
      assert.equal(value.expiresAt <= approval.expiresAt, true);
    },
  };
  await f.close();
  let storage = await Storage.open(f.root, { deferRecovery: true });
  let runtime = await createNativeRuntime({ storage, batch16Classification: policy });
  t.after(async () => { await runtime?.close(); await storage?.close(); });
  let io = await transports(t, runtime.core, actor);
  const originalPreview = source.previewAssetClassification(root);
  const proposal = originalPreview.proposals.find(item => item.type === "classification" && item.asset === "notes/a.md");
  assert(proposal);
  const db = storage.connectNative();
  const scanHost = { assertOwnedDisposableFixture: policy.assertFixtureOwnership };
  const pin = scanNativeClassification(db, scanHost, root);
  db.close();
  const request = { contract: "pkm.legacy-classification.native-strict/v1", action: "apply",
    operationId: randomUUID(), previewId: originalPreview.id, layoutSha256: pin.layoutSha256, proposalIds: [proposal.id] };
  const originalResult = source.applyAssetClassification(oracle, source.previewAssetClassification(oracle), request.proposalIds);
  assert.match(originalResult.journalId, /^[0-9a-f-]{36}$/);
  assert.deepEqual(originalResult.applied, request.proposalIds);
  assert.deepEqual(originalResult.skipped, []);
  const unknown = await io.http("knowledge.classification.native-strict.command", request);
  assert(unknown.error);
  assert.equal((await io.mcp("knowledge.document.create", { operationId: randomUUID(), id: "blocked", title: "Blocked", content: "unchanged" })).error.code, "RECOVERY_REQUIRED");
  await io.close(); await runtime.close(); await storage.close();
  storage = await Storage.open(f.root, { deferRecovery: true });
  runtime = await createNativeRuntime({ storage, batch16Classification: policy });
  io = await transports(t, runtime.core, actor);
  assert.equal((await io.http("knowledge.classification.native-strict.command", request)).error.code, "ACCESS_DENIED");
  policyState.retry = true;
  policyState.acceptHistoryTransition = true;
  const applied = await io.http("knowledge.classification.native-strict.command", request);
  assert.equal(applied.error, undefined);
  assert.deepEqual(applied.result, { operationId: request.operationId, action: "apply", applied: [proposal.id] });
  assert.equal("journalId" in applied.result, false);
  assert.equal("skipped" in applied.result, false);
  assert.deepEqual(await readFile(join(root, proposal.target)), await readFile(join(oracle, proposal.target)));
  assert.deepEqual(await readFile(join(root, "notes/a.assets/image.png")), await readFile(join(oracle, "notes/a.assets/image.png")));
  assert.deepEqual((await io.mcp("knowledge.classification.native-strict.command", request)).result, applied.result);
  assert((await io.http("knowledge.classification.native-strict.command", {
    ...request, proposalIds: [randomUUID()],
  })).error);
  policyState.allowed = false;
  assert.equal((await io.http("knowledge.classification.native-strict.command", request)).error.code, "NOT_AVAILABLE");
  policyState.allowed = true;
  policyState.epochAllowed = false;
  assert((await io.mcp("knowledge.classification.native-strict.command", request)).error);
  policyState.epochAllowed = true;
  await io.close(); await runtime.close(); await storage.close();
  storage = await Storage.open(f.root, { deferRecovery: true });
  runtime = await createNativeRuntime({ storage, batch16Classification: policy });
  io = await transports(t, runtime.core, actor);
  assert.deepEqual((await io.mcp("knowledge.classification.native-strict.command", request)).result, applied.result);
  const hostAdapter = { async acquireQuiescence() { return { assertHeld() {}, release() {} }; } };
  await assert.rejects(createWorkspaceBackup(storage, join(f.parent, "classified-backup"), hostAdapter,
    { nativePublishNoReplace: fixturePublisher(f.parent) }), { code: "RECOVERY_AUTHORITY_REQUIRED" });
  const backupState = { calls: 0, revoked: false, expire: false, revokeAt: 0, tamperAt: 0, modeAt: 0, wrongActor: false, epochAt: 0 };
  const classificationBackup = {
    scope: policy.scope, sourceRelative: policy.sourceRelative, sourceRootId: policy.sourceRootId,
    actorId: actor.id, assertFixtureOwnership: policy.assertFixtureOwnership, assertHistoryAnchor: policy.assertHistoryAnchor,
    assertAdoptionAnchor: policy.assertAdoptionAnchor,
    authorize(request) {
      backupState.calls++;
      if (backupState.revoked || backupState.calls === backupState.revokeAt) return null;
      if (backupState.calls === backupState.tamperAt) {
        const stage = readdirSync(f.parent).find(name => name.startsWith(".pkm-backup.") && name.endsWith(".stage"));
        assert(stage);
        writeFileSync(join(f.parent, stage, "packages/classification", proposal.target), "tampered staged backup");
      }
      if (backupState.calls === backupState.modeAt) {
        const stage = readdirSync(f.parent).find(name => name.startsWith(".pkm-backup.") && name.endsWith(".stage"));
        assert(stage);
        chmodSync(join(f.parent, stage, "packages/classification/notes"), 0o700);
      }
      return { actorId: backupState.wrongActor ? "different-actor" : actor.id, requestSha256: hash(JSON.stringify(request)),
        epoch: backupState.calls === backupState.epochAt ? 8 : 7,
        expiresAt: backupState.expire ? Date.now() - 1 : Date.now() + 60_000 };
    },
  };
  const options = { nativePublishNoReplace: fixturePublisher(f.parent), classificationBackup };
  backupState.expire = true;
  await assert.rejects(createWorkspaceBackup(storage, join(f.parent, "expired"), hostAdapter, options), { code: "AUTHORITY_REQUIRED" });
  await assert.rejects(lstat(join(f.parent, "expired")), { code: "ENOENT" });
  backupState.expire = false; backupState.wrongActor = true;
  await assert.rejects(createWorkspaceBackup(storage, join(f.parent, "wrong-actor"), hostAdapter, options), { code: "AUTHORITY_REQUIRED" });
  backupState.wrongActor = false; backupState.calls = 0; backupState.epochAt = 2;
  await assert.rejects(createWorkspaceBackup(storage, join(f.parent, "changed-epoch"), hostAdapter, options), { code: "AUTHORITY_REQUIRED" });
  await assert.rejects(lstat(join(f.parent, "changed-epoch")), { code: "ENOENT" });
  backupState.epochAt = 0; backupState.calls = 0; backupState.revokeAt = 2;
  await assert.rejects(createWorkspaceBackup(storage, join(f.parent, "revoked"), hostAdapter, options), { code: "AUTHORITY_REQUIRED" });
  await assert.rejects(lstat(join(f.parent, "revoked")), { code: "ENOENT" });
  backupState.calls = 0; backupState.revokeAt = 0; backupState.tamperAt = 2;
  await assert.rejects(createWorkspaceBackup(storage, join(f.parent, "tampered"), hostAdapter, options), { code: "HASH_MISMATCH" });
  await assert.rejects(lstat(join(f.parent, "tampered")), { code: "ENOENT" });
  backupState.calls = 0; backupState.tamperAt = 0; backupState.modeAt = 2;
  await assert.rejects(createWorkspaceBackup(storage, join(f.parent, "wrong-mode"), hostAdapter, options), { code: "SOURCE_CHANGED" });
  await assert.rejects(lstat(join(f.parent, "wrong-mode")), { code: "ENOENT" });
  backupState.calls = 0; backupState.modeAt = 0;
  const backupPath = join(f.parent, "classified-backup");
  await createWorkspaceBackup(storage, backupPath, hostAdapter, options);
  const manifest = JSON.parse(await readFile(join(backupPath, ".pkm-workspace-backup.json")));
  assert.equal(manifest.databaseUserVersion, 23);
  assert.equal(manifest.classification.epoch, 7);
  assert.equal(manifest.classification.request.historySha256, policyState.anchor.historySha256);
  assert.equal(manifest.classification.request.genesisSha256, policyState.anchor.genesisSha256);
  assert.deepEqual(await readFile(join(backupPath, "packages/classification", proposal.target)),
    await readFile(join(root, proposal.target)));
  assert.equal((await lstat(join(backupPath, "packages/classification/notes"))).mode & 0o777, 0o750);
  assert.equal((await lstat(join(backupPath, "packages/classification/notes/a.md"))).mode & 0o777, 0o640);
  const snapshot = new DatabaseSync(join(backupPath, "core.sqlite"), { readOnly: true });
  const sourceDb = storage.connectNative();
  let immutableReceiptPayload;
  let immutableGlobalReceipt;
  try {
    assert.deepEqual(snapshot.prepare("SELECT * FROM legacy_classification_native_receipt").all(),
      sourceDb.prepare("SELECT * FROM legacy_classification_native_receipt").all());
    immutableReceiptPayload = snapshot.prepare("SELECT payload FROM legacy_classification_native_receipt WHERE operation_id=?")
      .get(request.operationId).payload;
    immutableGlobalReceipt = snapshot.prepare("SELECT * FROM receipts WHERE operation_id=?").get(request.operationId);
    assert.deepEqual(immutableGlobalReceipt, sourceDb.prepare("SELECT * FROM receipts WHERE operation_id=?").get(request.operationId));
    const snapshotHost = {
      assertOwnedDisposableFixture: policy.assertFixtureOwnership,
      globalReceipt(db, id) {
        const row = db.prepare("SELECT fingerprint,result FROM receipts WHERE operation_id=?").get(id);
        return row ? { fingerprint: row.fingerprint, result: JSON.parse(row.result) } : null;
      },
    };
    const originalHistory = inspectNativeClassificationHistory(snapshot, snapshotHost);
    const copiedLayout = scanNativeClassification(snapshot, snapshotHost, join(backupPath, "packages/classification"));
    assert.equal(copiedLayout.layoutSha256, manifest.classification.request.layoutSha256);
    assert.notDeepEqual(copiedLayout.pin, originalHistory.receipts[0].rootPin);
    assert.throws(() => validateNativeClassificationHistoryLayout(originalHistory,
      { workspaceId: manifest.workspaceId, sourceRootId: policy.sourceRootId }, copiedLayout),
    /history scope, root or operation ID differs/);
  } finally { snapshot.close(); sourceDb.close(); }
  const restored = join(f.parent, "classified-restored");
  await assert.rejects(restoreWorkspaceBackup(backupPath, restored, { nativeRestoreAuthority }),
    { code: "RECOVERY_AUTHORITY_REQUIRED" });
  await assert.rejects(lstat(restored), { code: "ENOENT" });
  const restoreAuthorityFor = (behavior = {}) => ({
    ...nativeRestoreAuthority,
    authorizeClassificationAdoption(adoptionRequest) {
      if (adoptionRequest.phase === "publish") behavior.publishCalls = (behavior.publishCalls ?? 0) + 1;
      if (!adoptionState.allowed || behavior.denyPhase === adoptionRequest.phase
        || behavior.expirePhase === adoptionRequest.phase
        || behavior.denySecondPublish && adoptionRequest.phase === "publish" && behavior.publishCalls === 2) return null;
      if (behavior.occupyTarget && adoptionRequest.phase === "publish" && !behavior.didOccupy) {
        behavior.didOccupy = true;
        mkdirSync(adoptionRequest.destination);
      }
      if (behavior.tamperMode && adoptionRequest.phase === "publish" && !behavior.didTamper) {
        behavior.didTamper = true;
        chmodSync(join(adoptionRequest.stageRoot, "notes"), 0o700);
      }
      if (behavior.tamperContent && adoptionRequest.phase === "publish" && !behavior.didTamper) {
        behavior.didTamper = true;
        writeFileSync(join(adoptionRequest.stageRoot, proposal.target), "tampered staged restore");
      }
      if (behavior.tamperSource && adoptionRequest.phase === "publish" && !behavior.didTamper) {
        behavior.didTamper = true;
        writeFileSync(join(adoptionRequest.sourceBackupRoot, adoptionRequest.sourceRelative, proposal.target), "tampered source backup");
      }
      const approval = {
        authorityId: "fixture-classification-adoption",
        actorId: behavior.wrongActor ? "unexpected-actor" : adoptionRequest.actorId,
        requestSha256: behavior.wrongBinding ? "0".repeat(64) : hash(JSON.stringify(adoptionRequest)),
        policyIdentity: "fixture-classification-policy/v1",
        trustedEpoch: behavior.wrongEpoch
          || (behavior.changeEpochAt !== undefined && behavior.changeEpochAt === behavior.publishCalls) ? 10 : 9,
        expiresAt: behavior.expireDecision ? Date.now() - 1 : Date.now() + 60_000,
      };
      if (adoptionRequest.phase === "publish") adoptionState.approvals.set(adoptionRequest.operationId, approval);
      return approval;
    },
  });
  const restoreAuthority = restoreAuthorityFor();
  const restoreStageNames = () => readdirSync(f.parent).filter(name => name.startsWith(".pkm-restore.") && name.endsWith(".stage"));
  const assertRestoreStageClean = () => assert.deepEqual(restoreStageNames(), []);
  const staleStage = join(f.parent, ".pkm-restore.stale.stage");
  await mkdir(staleStage);
  await assert.rejects(restoreWorkspaceBackup(backupPath, join(f.parent, "blocked-stale-stage"), {
    nativeRestoreAuthority: restoreAuthority, classificationBackup,
    nativePublishNoReplace: fixturePublisher(f.parent),
  }), { code: "RECOVERY_AUTHORITY_REQUIRED" });
  await rm(staleStage, { recursive: true, force: true });
  assertRestoreStageClean();
  for (const [name, behavior] of [
    ["denied-prepare", { denyPhase: "prepare" }],
    ["wrong-actor", { wrongActor: true }],
    ["wrong-source-binding", { wrongBinding: true }],
    ["wrong-epoch", { wrongEpoch: true }],
    ["expired-approval", { expireDecision: true }],
  ]) {
    const deniedTarget = join(f.parent, name);
    await assert.rejects(restoreWorkspaceBackup(backupPath, deniedTarget, {
      nativeRestoreAuthority: restoreAuthorityFor(behavior), classificationBackup,
      nativePublishNoReplace: fixturePublisher(f.parent),
    }), { code: "RECOVERY_AUTHORITY_REQUIRED" });
    await assert.rejects(lstat(deniedTarget), { code: "ENOENT" });
    assertRestoreStageClean();
  }
  for (const [name, behavior, expected] of [
    ["denied-before-publish", { denyPhase: "publish" }, "RECOVERY_AUTHORITY_REQUIRED"],
    ["expired-before-publish", { expirePhase: "publish" }, "RECOVERY_AUTHORITY_REQUIRED"],
    ["revoked-before-atomic-publish", { denySecondPublish: true }, "RECOVERY_AUTHORITY_REQUIRED"],
    ["changed-trusted-epoch-before-publish", { changeEpochAt: 2 }, "RECOVERY_AUTHORITY_REQUIRED"],
    ["tampered-stage-mode", { tamperMode: true }, "CONFLICT"],
    ["tampered-stage-bytes", { tamperContent: true }, "CONFLICT"],
    ["occupied-destination", { occupyTarget: true }, "SOURCE_CHANGED"],
    ["changed-source-manifest", { tamperSource: true }, "HASH_MISMATCH"],
  ]) {
    const deniedTarget = join(f.parent, name);
    await assert.rejects(restoreWorkspaceBackup(backupPath, deniedTarget, {
      nativeRestoreAuthority: restoreAuthorityFor(behavior), classificationBackup,
      nativePublishNoReplace: fixturePublisher(f.parent),
    }), { code: expected });
    if (behavior.occupyTarget) await rm(deniedTarget, { recursive: true, force: true });
    else await assert.rejects(lstat(deniedTarget), { code: "ENOENT" });
    assertRestoreStageClean();
    if (behavior.tamperSource) {
      await writeFile(join(backupPath, "packages/classification", proposal.target), await readFile(join(root, proposal.target)));
    }
  }
  backupState.calls = 0;
  backupState.revokeAt = 2;
  await assert.rejects(restoreWorkspaceBackup(backupPath, join(f.parent, "revoked-source-epoch"), {
    nativeRestoreAuthority: restoreAuthority, classificationBackup,
    nativePublishNoReplace: fixturePublisher(f.parent),
  }), { code: "RECOVERY_AUTHORITY_REQUIRED" });
  backupState.calls = 0;
  backupState.revokeAt = 0;
  assertRestoreStageClean();
  await restoreWorkspaceBackup(backupPath, restored, {
    nativeRestoreAuthority: restoreAuthority, classificationBackup,
    nativePublishNoReplace: fixturePublisher(f.parent),
  });
  const adoptedSnapshot = new DatabaseSync(join(restored, "core.sqlite"));
  try {
    assert.equal(adoptedSnapshot.prepare("PRAGMA user_version").get().user_version, 23);
    assert.equal(adoptedSnapshot.prepare("SELECT payload FROM legacy_classification_native_receipt WHERE operation_id=?")
      .get(request.operationId).payload, immutableReceiptPayload);
    assert.deepEqual(adoptedSnapshot.prepare("SELECT * FROM receipts WHERE operation_id=?").get(request.operationId), immutableGlobalReceipt);
    assert.equal(adoptedSnapshot.prepare("SELECT COUNT(*) AS count FROM legacy_classification_native_adoption").get().count, 1);
    assert.throws(() => adoptedSnapshot.prepare("UPDATE legacy_classification_native_adoption SET payload='{}'").run());
    assert.throws(() => adoptedSnapshot.prepare("DELETE FROM legacy_classification_native_adoption").run());
  } finally { adoptedSnapshot.close(); }
  const restoredRoot = join(restored, "packages/classification");
  assert.deepEqual(await readFile(join(restoredRoot, proposal.target)), await readFile(join(root, proposal.target)));
  assert.equal((await lstat(join(restoredRoot, "notes"))).mode & 0o777, 0o750);
  assert.equal((await lstat(join(restoredRoot, "notes/a.md"))).mode & 0o777, 0o640);
  let restoredStorage = await Storage.open(restored, { deferRecovery: true });
  let restoredRuntime = await createNativeRuntime({ storage: restoredStorage, batch16Classification: policy });
  let restoredIo = await transports(t, restoredRuntime.core, actor);
  t.after(async () => { await restoredIo?.close(); await restoredRuntime?.close(); await restoredStorage?.close(); });
  assert.deepEqual((await restoredIo.http("knowledge.classification.native-strict.command", request)).result, applied.result);
  const restoredDb = restoredStorage.connectNative();
  const restoredPin = scanNativeClassification(restoredDb, { assertOwnedDisposableFixture: policy.assertFixtureOwnership }, restoredRoot);
  restoredDb.close();
  const rollbackRequest = {
    contract: "pkm.legacy-classification.native-strict/v1", action: "rollback", operationId: randomUUID(),
    applyOperationId: request.operationId, layoutSha256: restoredPin.layoutSha256,
  };
  policyState.acceptHistoryTransition = true;
  const rolledBack = await restoredIo.http("knowledge.classification.native-strict.command", rollbackRequest);
  assert.equal(rolledBack.error, undefined);
  assert.equal((await readFile(join(restoredRoot, "notes/a.md"))).toString(),
    "# Synthetic original note\n![image](a.assets/image.png)\n");
  const replayPreview = source.previewAssetClassification(restoredRoot);
  const replayProposal = replayPreview.proposals.find(item => item.type === "classification" && item.asset === "notes/a.md");
  assert(replayProposal);
  const replayDb = restoredStorage.connectNative();
  const replayPin = scanNativeClassification(replayDb, { assertOwnedDisposableFixture: policy.assertFixtureOwnership }, restoredRoot);
  replayDb.close();
  const replayApplyRequest = {
    contract: "pkm.legacy-classification.native-strict/v1", action: "apply", operationId: randomUUID(),
    previewId: replayPreview.id, layoutSha256: replayPin.layoutSha256, proposalIds: [replayProposal.id],
  };
  policyState.acceptHistoryTransition = true;
  const replayApplied = await restoredIo.mcp("knowledge.classification.native-strict.command", replayApplyRequest);
  assert.equal(replayApplied.error, undefined);
  const rebackupPath = join(f.parent, "classified-rebackup");
  backupState.calls = 0;
  await createWorkspaceBackup(restoredStorage, rebackupPath, hostAdapter, {
    nativePublishNoReplace: fixturePublisher(f.parent), classificationBackup,
  });
  const rerestored = join(f.parent, "classified-rerestored");
  await restoreWorkspaceBackup(rebackupPath, rerestored, {
    nativeRestoreAuthority: restoreAuthority, classificationBackup,
    nativePublishNoReplace: fixturePublisher(f.parent),
  });
  const rerestoredStorage = await Storage.open(rerestored, { deferRecovery: true });
  const rerestoredRuntime = await createNativeRuntime({ storage: rerestoredStorage, batch16Classification: policy });
  const rerestoredIo = await transports(t, rerestoredRuntime.core, actor);
  t.after(async () => { await rerestoredIo.close(); await rerestoredRuntime.close(); await rerestoredStorage.close(); });
  const rerestoreReplay = await rerestoredIo.http("knowledge.classification.native-strict.command", request);
  assert.equal(rerestoreReplay.result?.operationId, request.operationId, JSON.stringify(rerestoreReplay));
  assert.deepEqual(rerestoreReplay.result, applied.result);
  await writeFile(join(root, "notes/a.md"), "# Tampered\n");
  assert.equal((await io.http("knowledge.classification.native-strict.command", request)).error.code, "CONFLICT");
  assert.equal(hash(await readFile(join(root, "notes/a.md"))), hash("# Tampered\n"));
  await io.close(); await runtime.close(); await storage.close();
  storage = await Storage.open(f.root, { deferRecovery: true });
  await assert.rejects(createNativeRuntime({ storage, batch16Classification: policy }), /layout|changed|conflict/i);
});
