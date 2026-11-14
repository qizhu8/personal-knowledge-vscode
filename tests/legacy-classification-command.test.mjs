import test from "node:test";
import assert from "node:assert/strict";
import * as crypto from "node:crypto";
import * as fs from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { chmodSync, cpSync, mkdirSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { LEGACY_CLASSIFICATION_COMMAND_DDL, executeLegacyClassificationCommand as execute, inspectLegacyClassificationCommand as inspect,
  verifyLegacyClassificationCommandHistory as verify } from "../dist/legacy-classification-command.js";
import { LEGACY_CLASSIFICATION_COMMAND_CONTRACT as contract, LEGACY_CLASSIFICATION_COMMAND_ID as operation } from "../dist/legacy-classification-command-contracts.js";
import { scanNativeClassification } from "../dist/legacy-classification-native.js";
import { originalLoader, transports, fixturePublisher } from "./host-composition-legacy-batch15-captures.mjs";
import { initialize, Storage } from "../dist/storage.js";
import { createNativeRuntime } from "../dist/native-runtime.js";
import { createWorkspaceBackup, restoreWorkspaceBackup } from "../dist/workspace-backup.js";
import { nativeRestoreAuthority } from "./host-composition-legacy-batch16-restore-fixture.mjs";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const actor = { id: "batch19-human", canWrite: true, collaborationKind: "human" };
const hash = value => crypto.createHash("sha256").update(typeof value === "string" || Buffer.isBuffer(value) ? value : JSON.stringify(value)).digest("hex");
const put = (root, path, value) => { const p = join(root, path); mkdirSync(join(p, ".."), { recursive: true }); writeFileSync(p, value); };
const read = (root, p) => readFileSync(join(root, p));
function fixture(t) {
  const folder = resolve(fileURLToPath(new URL(`./.batch19-${crypto.randomUUID()}/`, import.meta.url))), root = join(folder, "root"), oracle = join(folder, "oracle");
  mkdirSync(root, { recursive: true });
  const original = originalLoader(), storage = original("src/knowledge/storage.ts");
  storage.setStorePath(root);
  const markdown = original("src/knowledge/filestore.ts");
  markdown.setStorePath(root);
  mkdirSync(join(root, "notes"), { recursive: true });
  markdown.writeKnowledgeMarkdown("notes", "a.md", undefined, "\uFEFF---\r\nkind: script\r\ntitle: A\r\n---\r\n# Original A\r\n![asset](a.assets/image.png)\r\n");
  markdown.writeKnowledgeMarkdown("notes", "b.md", undefined, "# Original B\n");
  original("src/knowledge/markdown-assets.ts").saveMarkdownAsset(root, "notes", "a.md", "image.png", Buffer.from([0, 255, 42]));
  assert.equal(storage.scriptImport([{ category: "Engineering", file: "a.py", content: "print('fixture never executed')\n" }]), 1);
  storage.scriptGet("Engineering/a.py");
  const { ProjectStore } = original("src/workflows/project-store.ts");
  const projects = new ProjectStore(join(root, ".pkm/state"), () => "batch19-fixture", { autoMigrate: false });
  projects.createProject({ commandId: "fixture-project", fingerprint: "fixture-project", expectedStoreVersion: projects.list().storeVersion }, "Batch19");
  mkdirSync(join(root, ".pkm/state/asset-classification"), { recursive: true, mode: 0o700 });
  chmodSync(join(root, "notes/a.md"), 0o640);
  cpSync(root, oracle, { recursive: true });
  const source = original("src/knowledge/asset-classification.ts");
  const state = { owned: true, allowed: true, epoch: true, recovery: false, transition: true, anchor: null, previews: new Map(), private: new Set() };
  let pendingAnchor = { operationId: null, payloadSha256: null }, pendingGrant;
  let db = open();
  function open() { const db = new DatabaseSync(join(folder, "state.sqlite")); db.exec(LEGACY_CLASSIFICATION_COMMAND_DDL);
    db.exec("CREATE TABLE IF NOT EXISTS global_receipt(id TEXT PRIMARY KEY,fingerprint TEXT NOT NULL,result TEXT NOT NULL)"); return db; }
  const scope = { workspaceId: "fixture", sourceRootId: "b".repeat(64), root };
  const host = {
    assertOwnedDisposableFixture() { assert(!db.isTransaction); assert(state.owned); },
    authorize(who, s) { assert(!db.isTransaction); return state.allowed && state.epoch && who.id === actor.id && s.root === root; },
    previewOriginal: source.previewAssetClassification,
    reviewedPreview: id => state.previews.get(id),
    isPrivate: asset => state.private.has(asset),
    assertHistoryAnchor(value) { assert(!db.isTransaction); assert(state.epoch);
      if (!state.anchor) state.anchor = value;
      if (value.historySha256 === state.nextHash) state.anchor = { ...state.anchor, historySha256: state.nextHash };
      assert.deepEqual(value, state.anchor); },
    approveHistoryTransition(value) { assert(!db.isTransaction);
      if (!state.transition || !state.epoch) return false;
      assert.equal(state.anchor.historySha256, value.previousSha256);
      state.nextHash = value.nextSha256; return true; },
    assertPendingAnchor(value) { assert(!db.isTransaction);
      if (pendingGrant && value.payloadSha256 === pendingGrant.payloadSha256) pendingAnchor = pendingGrant;
      assert.deepEqual(value, pendingAnchor); },
    approvePendingTransition(value) { assert(!db.isTransaction); assert.equal(value.previousSha256, pendingAnchor.payloadSha256);
      pendingGrant = { operationId: value.nextSha256 === null ? null : value.operationId, payloadSha256: value.nextSha256 }; return true; },
    approveRecovery: () => state.recovery,
    assertNoOtherPending(database) { assert(database.isTransaction); assert(!state.otherPending); },
    globalReceipt(database, id) { const row = database.prepare("SELECT fingerprint,result FROM global_receipt WHERE id=?").get(id);
      return row ? { fingerprint: row.fingerprint, result: JSON.parse(row.result) } : null; },
    writeGlobalReceipt(database, id, fingerprint, result) { database.prepare("INSERT INTO global_receipt VALUES(?,?,?)").run(id, fingerprint, JSON.stringify(result)); },
  };
  const preview = source.previewAssetClassification(root); state.previews.set(preview.id, preview);
  const ids = assets => assets.map(asset => preview.proposals.find(p => p.type === "classification" && p.asset === asset).id);
  const request = (proposalIds = ids(["notes/a.md", "notes/b.md", "scripts/Engineering/a.py"])) => ({ contract, action: "apply",
    operationId: crypto.randomUUID(), previewId: preview.id, layoutSha256: scanNativeClassification(db, host, root).layoutSha256, proposalIds });
  const run = args => execute(db, host, scope, actor, args);
  function oracleApply(req, nativeResult, faultIndex) {
    let calls = 0;
    let failed = false;
    const writer = originalLoader({
      crypto: { ...crypto, randomUUID() { if (++calls === 2) return nativeResult.sourceResult.journalId; return crypto.randomUUID(); } },
      fs: { ...fs, renameSync(stage, destination) {
        if (!failed && (faultIndex === 0 && destination.endsWith(`${nativeResult.sourceResult.journalId}.json`)
          || faultIndex === 1 && destination === join(oracle, "notes/a.md"))) {
          failed = true; throw Object.assign(Error("source-qualified synthetic EIO"), { code: "EIO" });
        }
        return fs.renameSync(stage, destination);
      } },
    })("src/knowledge/asset-classification.ts");
    return writer.applyAssetClassification(oracle, { ...preview, root: oracle }, req.proposalIds);
  }
  function restart() { db.close(); db = open(); }
  t.after(() => { db.close(); rmSync(folder, { recursive: true, force: true }); });
  return { folder, root, oracle, source, original, state, scope, host, preview, ids, request, run, oracleApply, restart, get db() { return db; } };
}
function tree(root, prefix = "") {
  return readdirSync(join(root, prefix), { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name)).flatMap(e => {
    const p = prefix ? `${prefix}/${e.name}` : e.name;
    return e.isDirectory() ? tree(root, p) : [[p, read(root, p).toString("base64")]];
  });
}

  async function nativeBackupFixture(t) {
    const f = fixture(t), workspace = await initialize(join(f.folder, "native-workspace"));
    const transactionOwners = new Set(), originalExec = DatabaseSync.prototype.exec;
    DatabaseSync.prototype.exec = function(sql) {
      try { return originalExec.call(this, sql); }
      finally { if (this.isTransaction) transactionOwners.add(this); else transactionOwners.delete(this); }
    };
    t.after(() => { DatabaseSync.prototype.exec = originalExec; });
    let currentWorkspace = workspace, currentRoot = join(workspace, "packages/classification");
    cpSync(f.root, currentRoot, { recursive: true });
    const state = { allowed: true, epoch: 7, expectedEpoch: 7, owned: true, expired: false, denyPhase: "",
      backupCalls: 0, revokeAt: 0, modeAt: 0, wrongActor: false, mutatePublish: undefined };
    const retained = new Map(), grants = new Map();
    let anchor, pending = { operationId: null, payloadSha256: null }, pendingGrant, nextHash;
    let storage, runtime, io;
    const policy = {
      scope: "exclusive-native-disposable-fixture", sourceRelative: "packages/classification", sourceRootId: "d".repeat(64),
      assertOwnedDisposableFixture() { assert(state.owned); assert.equal(state.epoch, state.expectedEpoch); },
      authorize: (who, scope) => state.allowed && state.owned && state.epoch === state.expectedEpoch && who.id === actor.id && scope.root === currentRoot,
      previewOriginal: f.source.previewAssetClassification, reviewedPreview: id => retained.get(id), isPrivate: () => false,
      assertHistoryAnchor(value) {
        assert(state.allowed); assert.equal(state.epoch, state.expectedEpoch);
        if (!anchor) anchor = value;
        if (value.historySha256 === nextHash) anchor = { ...anchor, historySha256: nextHash };
        assert.deepEqual(value, anchor);
      },
      approveHistoryTransition(value) { assert.equal(value.previousSha256, anchor.historySha256); nextHash = value.nextSha256; return state.allowed; },
      assertPendingAnchor(value) { if (pendingGrant && value.payloadSha256 === pendingGrant.payloadSha256) pending = pendingGrant; assert.deepEqual(value, pending); },
      approvePendingTransition(value) { assert.equal(value.previousSha256, pending.payloadSha256); pendingGrant = {
        operationId: value.nextSha256 === null ? null : value.operationId, payloadSha256: value.nextSha256 }; return state.allowed; },
      approveRecovery: () => false,
      beforeEffect(index) { if (index === state.failStep) throw Error("known original-compatible target EIO"); },
      assertAdoptionAnchor(value) {
        for (const database of transactionOwners) assert.equal(database.isTransaction, false, "Native adoption authority must run outside every SQLite owner transaction.");
        assert(state.allowed); assert.equal(state.epoch, state.expectedEpoch);
        const grant = grants.get(value.operationId);
        assert(grant); assert(grant.expiresAt > Date.now());
        assert.equal(value.authorityId, grant.authorityId); assert.equal(value.policyIdentity, grant.policyIdentity);
        assert.equal(value.trustedEpoch, grant.trustedEpoch); assert(value.expiresAt <= grant.expiresAt);
        for (const k of ["workspaceId", "sourceRootId", "sourceRelative", "sourceManifestSha256", "sourceBackupRoot", "sourceBackupRootPin",
          "sourceRoot", "sourceRootPin", "destination", "destinationParent", "genesisSha256", "historySha256", "receiptCount", "layoutSha256"])
          assert.deepEqual(value[k], grant.request[k]);
        assert.deepEqual(value.destinationRootPin, grant.request.stageRootPin);
        assert.deepEqual(value.destinationWorkspacePin, grant.request.stageWorkspacePin);
        assert.deepEqual(value.stageParent, grant.request.stageParent);
        assert.equal(value.actorId, actor.id); assert.equal(value.sourceEpoch, grant.request.sourceEpoch);
      },
    };
    const classificationBackup = {
      originalCompatible: true, scope: policy.scope, sourceRelative: policy.sourceRelative, sourceRootId: policy.sourceRootId,
      actorId: actor.id, assertFixtureOwnership: policy.assertOwnedDisposableFixture,
      assertHistoryAnchor: policy.assertHistoryAnchor, assertAdoptionAnchor: policy.assertAdoptionAnchor,
      authorize(request) {
        state.backupCalls++;
        if (!state.allowed || state.backupCalls === state.revokeAt) return null;
        if (state.backupCalls === state.modeAt) {
          const stage = readdirSync(f.folder).find(v => v.startsWith(".pkm-backup.") && v.endsWith(".stage"));
          assert(stage); chmodSync(join(f.folder, stage, "packages/classification/notes"), 0o700);
        }
        return { actorId: state.wrongActor ? "unowned-actor" : actor.id, requestSha256: hash(request), epoch: state.epoch,
          expiresAt: state.expired ? Date.now() - 1 : Date.now() + 600000 };
      },
    };
    const authority = {
      ...nativeRestoreAuthority, actorId: actor.id,
      authorizeClassificationAdoption(request) {
        assert.equal(request.originalCompatible, true);
        assert.equal(request.actorId, actor.id);
        if (!state.allowed || state.denyPhase === request.phase) return null;
        if (request.phase === "publish") state.mutatePublish?.(request);
        const decision = { authorityId: "batch19-native-adoption", actorId: state.wrongActor ? "unowned-actor" : request.actorId,
          requestSha256: hash(request), policyIdentity: "batch19-native-policy/v1", trustedEpoch: state.epoch,
          expiresAt: state.expired ? Date.now() - 1 : Date.now() + 600000 };
        if (request.phase === "publish") grants.set(request.operationId, { ...decision, request });
        return decision;
      },
    };
    const options = { classificationBackup, nativePublishNoReplace: fixturePublisher(f.folder), nativeRestoreAuthority: authority };
    const hostAdapter = { async acquireQuiescence() { return { assertHeld() {}, release() {} }; } };
    const close = async () => { await io?.close(); io = undefined; await runtime?.close(); runtime = undefined; await storage?.close(); storage = undefined; };
    const open = async (target = currentWorkspace) => {
      currentWorkspace = target; currentRoot = join(target, "packages/classification");
      storage = await Storage.open(target, { deferRecovery: true });
      try { runtime = await createNativeRuntime({ storage, originalClassification: policy }); io = await transports(t, runtime.core, actor); }
      catch (error) { await storage.close(); storage = undefined; throw error; }
    };
    await open();
    t.after(close);
    const apply = async (fault = false) => {
      const response = await io.http(operation, { contract, action: "preview" }); assert(!response.error, JSON.stringify(response));
      const preview = response.result.sourceResult; retained.set(preview.id, preview);
      const db = storage.connectNative();
      const request = { contract, action: "apply", operationId: crypto.randomUUID(), previewId: preview.id,
        layoutSha256: scanNativeClassification(db, policy, currentRoot).layoutSha256,
        proposalIds: [preview.proposals.find(p => p.type === "correction")?.id,
          ...["notes/a.md", "notes/b.md", "scripts/Engineering/a.py"].map(asset => preview.proposals.find(p => p.type === "classification" && p.asset === asset).id)].filter(Boolean) };
      db.close();
      state.failStep = fault ? 1 : undefined;
      const responseResult = await io.http(operation, request); assert(!responseResult.error, JSON.stringify(responseResult));
      state.failStep = undefined;
      const result = responseResult.result;
      let calls = 0;
      let failed = false;
      const original = originalLoader({
        crypto: { ...crypto, randomUUID() { return ++calls === 2 ? result.sourceResult.journalId : crypto.randomUUID(); } },
        fs: { ...fs, renameSync(stage, destination) {
          if (fault && !failed && destination === join(f.oracle, "notes/a.md")) {
            failed = true; throw Object.assign(Error("actual source target EIO"), { code: "EIO" });
          }
          return fs.renameSync(stage, destination);
        } },
      })("src/knowledge/asset-classification.ts");
      assert.deepEqual(result.sourceResult, original.applyAssetClassification(f.oracle, { ...preview, root: f.oracle }, request.proposalIds));
      assert.deepEqual(tree(currentRoot), tree(f.oracle));
      return { request, result };
    };
    const backup = target => createWorkspaceBackup(storage, target, hostAdapter, options);
    const restore = (source, destination) => restoreWorkspaceBackup(source, destination, options);
    return { ...f, state, policy, grants, options, authority, open, close, apply, backup, restore,
      get storage() { return storage; }, get io() { return io; }, get currentRoot() { return currentRoot; }, get currentWorkspace() { return currentWorkspace; } };
  }

  test("source-qualified original backup -> approved native adoption -> immutable HTTP/MCP replay -> reverse rollback -> new apply -> rebackup -> second adoption", { timeout: 60000 }, async t => {
    const f = await nativeBackupFixture(t), applied = await f.apply();
    const sourceDb = f.storage.connectNative();
    const sourceRows = sourceDb.prepare("SELECT * FROM legacy_classification_command_receipt ORDER BY rowid").all();
    const globalRows = sourceDb.prepare("SELECT * FROM receipts WHERE operation=? ORDER BY rowid").all(operation);
    sourceDb.close();
    const backup = join(f.folder, "original-backup");
    await f.backup(backup);
    const manifest = JSON.parse(read(backup, ".pkm-workspace-backup.json"));
    assert.equal(manifest.classification.request.originalCompatible, true);
    assert.equal(manifest.databaseUserVersion, 23);
    const restored = join(f.folder, "original-restored");
    await assert.rejects(restoreWorkspaceBackup(backup, restored, { ...f.options, nativeRestoreAuthority }), { code: "RECOVERY_AUTHORITY_REQUIRED" });
    await f.restore(backup, restored);
    const copied = new DatabaseSync(join(restored, "core.sqlite"), { readOnly: true });
    assert.deepEqual(copied.prepare("SELECT * FROM legacy_classification_command_receipt ORDER BY rowid").all(), sourceRows);
    assert.deepEqual(copied.prepare("SELECT * FROM receipts WHERE operation=? ORDER BY rowid").all(operation), globalRows);
    assert.equal(copied.prepare("SELECT COUNT(*) AS n FROM legacy_classification_command_adoption").get().n, 1);
    assert.equal(copied.prepare("SELECT COUNT(*) AS n FROM legacy_classification_native_adoption").get().n, 0);
    copied.close();
    await f.close();
    await assert.rejects(Storage.open(restored), /explicit native fixture and root-adoption authority/);
    await f.open(restored);
    assert.deepEqual((await f.io.http(operation, applied.request)).result, applied.result);
    assert.deepEqual((await f.io.mcp(operation, applied.request)).result, applied.result);
    const db = f.storage.connectNative();
    const request = { contract, action: "rollback", operationId: crypto.randomUUID(), journalId: applied.result.sourceResult.journalId,
      layoutSha256: scanNativeClassification(db, f.policy, f.currentRoot).layoutSha256 }; db.close();
    const rollback = await f.io.mcp(operation, request); assert(!rollback.error, JSON.stringify(rollback));
    assert.deepEqual(rollback.result.sourceResult, f.source.rollbackAssetClassification(f.oracle, request.journalId));
    assert.deepEqual(rollback.result.sourceResult.applied, [...applied.result.sourceResult.applied].reverse());
    assert.deepEqual(tree(f.currentRoot), tree(f.oracle));
    const second = await f.apply();
    const rebackup = join(f.folder, "original-rebackup");
    await f.backup(rebackup);
    const staleTarget = join(f.folder, "stale-history-restore");
    await assert.rejects(f.restore(backup, staleTarget));
    assert.equal(fs.existsSync(staleTarget), false);
    const rererestored = join(f.folder, "original-rerestored");
    await f.restore(rebackup, rererestored);
    await f.close(); await f.open(rererestored);
    assert.deepEqual((await f.io.http(operation, applied.request)).result, applied.result);
    assert.deepEqual((await f.io.mcp(operation, second.request)).result, second.result);
    assert.deepEqual(tree(f.currentRoot), tree(f.oracle));
    const finalDb = f.storage.connectNative();
    assert.equal(finalDb.prepare("SELECT COUNT(*) AS n FROM legacy_classification_command_adoption").get().n, 2);
    finalDb.close();
    f.state.expectedEpoch = 8;
    assert((await f.io.http(operation, applied.request)).error);
    f.state.expectedEpoch = 7; f.state.allowed = false;
    assert((await f.io.mcp(operation, applied.request)).error);
  });

  test("original-compatible native backup/root adoption denies expired/revoked/wrong-actor approval, stale stages and stage modes before publication", { timeout: 60000 }, async t => {
    const f = await nativeBackupFixture(t);
    await f.apply();
    const absent = target => assert.equal(fs.existsSync(target), false);
    for (const behavior of ["expired", "wrongActor", "revoked", "mode"]) {
      f.state.backupCalls = 0;
      f.state.expired = behavior === "expired"; f.state.wrongActor = behavior === "wrongActor";
      f.state.revokeAt = behavior === "revoked" ? 2 : 0; f.state.modeAt = behavior === "mode" ? 2 : 0;
      const target = join(f.folder, `backup-denied-${behavior}`);
      await assert.rejects(f.backup(target)); absent(target);
    }
    Object.assign(f.state, { expired: false, wrongActor: false, revokeAt: 0, modeAt: 0, backupCalls: 0 });
    const backup = join(f.folder, "authorized-backup");
    await f.backup(backup);
    for (const phase of ["prepare", "publish"]) {
      f.state.denyPhase = phase;
      const target = join(f.folder, `restore-denied-${phase}`);
      await assert.rejects(f.restore(backup, target), { code: "RECOVERY_AUTHORITY_REQUIRED" }); absent(target);
    }
    f.state.denyPhase = "";
    const stale = join(f.folder, ".pkm-restore.synthetic-stale.stage");
    mkdirSync(stale);
    await assert.rejects(f.restore(backup, join(f.folder, "stale-target")), { code: "RECOVERY_AUTHORITY_REQUIRED" });
    assert(fs.existsSync(stale)); rmSync(stale, { recursive: true });
    for (const behavior of ["mode", "bytes", "late-mode", "late-revoke", "collision"]) {
      let calls = 0;
      f.state.mutatePublish = request => {
        calls++;
        if (behavior === "late-mode" && calls === 2 || behavior === "mode" && calls === 1)
          chmodSync(join(request.stageRoot, "notes"), 0o700);
        if (behavior === "bytes" && calls === 1) writeFileSync(join(request.stageRoot, "notes/a.md"), "forged source bytes");
        if (behavior === "late-revoke" && calls === 2) f.state.allowed = false;
        if (behavior === "collision" && calls === 1) mkdirSync(request.destination);
      };
      const target = join(f.folder, `restore-denied-${behavior}`);
      await assert.rejects(f.restore(backup, target));
      if (behavior === "collision") rmSync(target, { recursive: true }); else absent(target);
      f.state.allowed = true;
    }
    f.state.mutatePublish = undefined;
    const target = join(f.folder, "after-denied-restored");
    await f.restore(backup, target);
    await f.close(); await f.open(target);
    assert.deepEqual(tree(f.currentRoot), tree(f.oracle));
  });

  test("recomputed backup hashes cannot authorize forged original history/root/journal bytes and immutable adoption bindings", { timeout: 60000 }, async t => {
    const f = await nativeBackupFixture(t), applied = await f.apply();
    const pristine = join(f.folder, "pristine-original-backup"); await f.backup(pristine);
    const repin = backup => {
      const manifest = JSON.parse(read(backup, ".pkm-workspace-backup.json"));
      manifest.totalBytes = 0;
      for (const file of manifest.files) {
        const bytes = read(backup, file.path); file.size = bytes.length; file.sha256 = hash(bytes); manifest.totalBytes += file.size;
      }
      writeFileSync(join(backup, ".pkm-workspace-backup.json"), JSON.stringify(manifest));
    };
    for (const behavior of ["journal-bytes", "source-root", "history-rehash", "mode"]) {
      const backup = join(f.folder, `forged-backup-${behavior}`), target = join(f.folder, `forged-target-${behavior}`);
      cpSync(pristine, backup, { recursive: true });
      if (behavior === "journal-bytes") {
        const journal = join(backup, "packages/classification/.pkm/state/asset-classification", `${applied.result.sourceResult.journalId}.json`);
        writeFileSync(journal, readFileSync(journal).toString().replace('"schema":1', '"schema":2'));
      } else if (behavior === "mode") chmodSync(join(backup, "packages/classification/notes"), 0o700);
      else {
        const db = new DatabaseSync(join(backup, "core.sqlite"));
        const row = db.prepare("SELECT payload FROM legacy_classification_command_receipt").get();
        const value = JSON.parse(row.payload);
        if (behavior === "source-root") value.rootPin.ino = String(BigInt(value.rootPin.ino) + 1n);
        else value.outcomes[0].reason = "changed-since-preview";
        db.exec("DROP TRIGGER legacy_classification_command_receipt_no_update");
        db.prepare("UPDATE legacy_classification_command_receipt SET payload=?,payload_sha256=?").run(JSON.stringify(value), hash(value));
        db.exec(LEGACY_CLASSIFICATION_COMMAND_DDL);
        if (behavior === "history-rehash") {
          db.prepare("UPDATE receipts SET result=? WHERE operation_id=?").run(JSON.stringify({ ...applied.result,
            sourceResult: { ...applied.result.sourceResult, skipped: [{ id: value.outcomes[0].id, reason: value.outcomes[0].reason }] } }), applied.request.operationId);
        }
        db.close();
      }
      repin(backup);
      await assert.rejects(f.restore(backup, target)); assert.equal(fs.existsSync(target), false);
    }
    const restored = join(f.folder, "tamper-adoption-restored"); await f.restore(pristine, restored);
    await f.close();
    const db = new DatabaseSync(join(restored, "core.sqlite"));
    const row = db.prepare("SELECT payload FROM legacy_classification_command_adoption").get(), forged = JSON.parse(row.payload);
    forged.authorityId = "rehashed-not-native-approved";
    db.exec("DROP TRIGGER legacy_classification_command_adoption_no_update");
    db.prepare("UPDATE legacy_classification_command_adoption SET payload=?,payload_sha256=?").run(JSON.stringify(forged), hash(forged));
    db.exec(LEGACY_CLASSIFICATION_COMMAND_DDL); db.close();
    await assert.rejects(f.open(restored), /adoption authority denied/);
    const repaired = new DatabaseSync(join(restored, "core.sqlite"));
    repaired.exec("DROP TRIGGER legacy_classification_command_adoption_no_update");
    repaired.prepare("UPDATE legacy_classification_command_adoption SET payload=?,payload_sha256=?").run(row.payload, hash(row.payload));
    repaired.exec(LEGACY_CLASSIFICATION_COMMAND_DDL); repaired.close();
    for (const grant of f.grants.values()) grant.expiresAt = 0;
    await assert.rejects(f.open(restored), /adoption authority denied/);
  });

  test("actual original continued-error journal and ordered skips survive backup/adoption/replay and reverse rollback", { timeout: 60000 }, async t => {
    const f = await nativeBackupFixture(t), applied = await f.apply(true);
    assert.deepEqual(applied.result.sourceResult.skipped.map(e => e.reason), ["review-only", "unsafe-or-unavailable"]);
    const backup = join(f.folder, "partial-success-backup");
    await f.backup(backup);
    const target = join(f.folder, "partial-success-restored");
    await f.restore(backup, target); await f.close(); await f.open(target);
    assert.deepEqual((await f.io.mcp(operation, applied.request)).result, applied.result);
    const db = f.storage.connectNative();
    const rollback = { contract, action: "rollback", operationId: crypto.randomUUID(), journalId: applied.result.sourceResult.journalId,
      layoutSha256: scanNativeClassification(db, f.policy, f.currentRoot).layoutSha256 }; db.close();
    const response = await f.io.http(operation, rollback); assert(!response.error, JSON.stringify(response));
    assert.deepEqual(response.result.sourceResult, f.source.rollbackAssetClassification(f.oracle, rollback.journalId));
    assert.deepEqual(response.result.sourceResult.skipped.map(e => e.reason), ["already-restored-or-not-written"]);
    assert.deepEqual(tree(f.currentRoot), tree(f.oracle));
    const newApply = await f.apply();
    assert.deepEqual((await f.io.mcp(operation, newApply.request)).result, newApply.result);
    const rebackup = join(f.folder, "partial-rebackup"); await f.backup(rebackup);
    const newTarget = join(f.folder, "partial-second-restore"); await f.restore(rebackup, newTarget);
    await f.close(); await f.open(newTarget);
    assert.deepEqual((await f.io.http(operation, applied.request)).result, applied.result);
    assert.deepEqual(tree(f.currentRoot), tree(f.oracle));
  });

test("actual original preview/apply full result, UUID journal, Markdown/Script/ProjectStore/assets and reverse rollback bytes", t => {
  const f = fixture(t), originalTree = tree(f.root), request = f.request();
  const preview = f.run({ contract, action: "preview" });
  assert.deepEqual(preview.sourceResult, f.preview);
  const result = f.run(request), original = f.oracleApply(request, result);
  assert.deepEqual(result.sourceResult, original);
  assert.deepEqual(Object.keys(result.sourceResult), ["journalId", "applied", "skipped"]);
  assert.match(result.sourceResult.journalId, /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/);
  assert.deepEqual(tree(f.root), tree(f.oracle));
  const journal = JSON.parse(read(f.root, `.pkm/state/asset-classification/${original.journalId}.json`));
  assert.deepEqual(Object.keys(journal), ["schema", "entries"]);
  assert.deepEqual(Object.keys(journal.entries[0]), ["id", "asset", "target", "before", "beforeHash", "afterHash", "mode"]);
  const rollback = { contract, action: "rollback", operationId: crypto.randomUUID(), journalId: original.journalId,
    layoutSha256: scanNativeClassification(f.db, f.host, f.root).layoutSha256 };
  assert.deepEqual(f.run(rollback).sourceResult, f.source.rollbackAssetClassification(f.oracle, original.journalId));
  assert.deepEqual(tree(f.root), tree(f.oracle));
  assert.deepEqual(tree(f.root).filter(([p]) => !p.startsWith(".pkm/state/asset-classification/")), originalTree);
  assert.deepEqual(f.run({ ...rollback, operationId: crypto.randomUUID(), layoutSha256: scanNativeClassification(f.db, f.host, f.root).layoutSha256 }).sourceResult,
    f.source.rollbackAssetClassification(f.oracle, original.journalId));
});

test("original ordered deduplication and review-only, changed, privacy skips are not strict whole-selection rejection", t => {
  const f = fixture(t), a = f.ids(["notes/a.md"])[0], b = f.ids(["notes/b.md"])[0], script = f.ids(["scripts/Engineering/a.py"])[0];
  const correction = f.preview.proposals.find(p => p.type === "correction").id;
  put(f.root, "notes/b.md", "# Changed\n"); put(f.oracle, "notes/b.md", "# Changed\n");
  const request = f.request([correction, a, b, a, script]);
  const result = f.run(request);
  assert.deepEqual(result.sourceResult, f.oracleApply(request, result));
  assert.deepEqual(result.sourceResult.skipped, [{ id: correction, reason: "review-only" }, { id: b, reason: "changed-since-preview" }]);
  assert.deepEqual(tree(f.root), tree(f.oracle));
});

test("original review-only selection has UUID result but no invented journal file or target effects", t => {
  const f = fixture(t), request = f.request([f.preview.proposals.find(p => p.type === "correction").id]), before = tree(f.root);
  const result = f.run(request);
  assert.deepEqual(result.sourceResult, f.oracleApply(request, result));
  assert.deepEqual(tree(f.root), before);
  assert.throws(() => f.run({ contract, action: "rollback", operationId: crypto.randomUUID(), journalId: result.sourceResult.journalId,
    layoutSha256: scanNativeClassification(f.db, f.host, f.root).layoutSha256 }), /did not publish a journal/);
});

test("native privacy callback produces the original per-item privacy skip before publication", t => {
  const f = fixture(t), ids = f.ids(["notes/a.md", "notes/b.md"]); f.state.private.add("notes/a.md");
  const privacy = f.original("src/knowledge/content-privacy.ts");
  for (const root of [f.root, f.oracle]) {
    privacy.setPrivacyStoreRoot(root); privacy.setTopLevelPrivacy("notes", "a.md", true);
  }
  const request = f.request(ids), result = f.run(request);
  assert.deepEqual(result.sourceResult, f.oracleApply(request, result));
  assert.deepEqual(tree(f.root), tree(f.oracle));
  assert.deepEqual(result.sourceResult.skipped, [{ id: ids[0], reason: "privacy-changed-since-preview" }]);
  assert.deepEqual(result.sourceResult.applied, [ids[1]]);
});

for (const faultIndex of [0, 1]) test(`known source writer failure at ${faultIndex} continues ordered items with write-ahead journal timing`, t => {
  const f = fixture(t), request = f.request(f.ids(["notes/a.md", "notes/b.md"]));
  f.host.beforeEffect = index => { if (index === faultIndex) throw new Error("synthetic known source IO failure"); };
  const result = f.run(request);
  assert.deepEqual(result.sourceResult, f.oracleApply(request, result, faultIndex));
  assert.deepEqual(tree(f.root), tree(f.oracle));
  assert.deepEqual(result.sourceResult.applied, [request.proposalIds[1]]);
  assert.deepEqual(result.sourceResult.skipped, [{ id: request.proposalIds[0], reason: "unsafe-or-unavailable" }]);
  const journal = JSON.parse(read(f.root, `.pkm/state/asset-classification/${result.sourceResult.journalId}.json`));
  assert.deepEqual(journal.entries.map(e => e.id), request.proposalIds);
  delete f.host.beforeEffect;
  const rolled = f.run({ contract, action: "rollback", operationId: crypto.randomUUID(), journalId: result.sourceResult.journalId,
    layoutSha256: scanNativeClassification(f.db, f.host, f.root).layoutSha256 });
  assert.deepEqual(rolled.sourceResult.applied, [request.proposalIds[1]]);
  assert.deepEqual(rolled.sourceResult.skipped, [{ id: request.proposalIds[0], reason: "already-restored-or-not-written" }]);
});

for (const index of [0, 1, 2, 3]) test(`crash after original journal/target step ${index} survives restart and exact native-confirmed recovery`, t => {
  const f = fixture(t), request = f.request(f.ids(["notes/a.md", "notes/b.md"]));
  f.host.afterEffect = n => { if (n === index) throw new Error("synthetic crash"); };
  assert.throws(() => f.run(request), /synthetic crash/);
  assert(inspect(f.db).pending);
  f.restart(); delete f.host.afterEffect;
  assert.throws(() => f.run(request), /native-approved/);
  f.state.recovery = true;
  const result = f.run(request);
  assert.deepEqual(result.sourceResult, f.oracleApply(request, result));
  assert.deepEqual(tree(f.root), tree(f.oracle));
  f.restart();
  assert.deepEqual(f.run(request), result);
});

test("staged residue is never blindly deleted or replayed as a source skip", t => {
  const f = fixture(t), request = f.request();
  f.host.afterStage = () => { throw Error("stage crash"); };
  assert.throws(() => f.run(request), /stage crash/);
  f.restart(); f.state.recovery = true; delete f.host.afterStage;
  assert.throws(() => f.run(request), /Unknown original/);
  assert(inspect(f.db).pending);
  assert(readdirSync(join(f.root, ".pkm/state/asset-classification")).some(p => p.endsWith(".pending")));
});

test("native rollback recovery keeps actual original reverse publication and UUID result", t => {
  const f = fixture(t), apply = f.request(), applied = f.run(apply);
  f.oracleApply(apply, applied);
  const request = { contract, action: "rollback", operationId: crypto.randomUUID(), journalId: applied.sourceResult.journalId,
    layoutSha256: scanNativeClassification(f.db, f.host, f.root).layoutSha256 };
  f.host.afterEffect = index => { if (!index) throw Error("reverse rollback crash"); };
  assert.throws(() => f.run(request), /reverse rollback crash/);
  assert.equal(inspect(f.db).pending.steps[0].item, apply.proposalIds.at(-1));
  f.restart(); delete f.host.afterEffect; f.state.recovery = true;
  const rolled = f.run(request);
  assert.deepEqual(rolled.sourceResult, f.source.rollbackAssetClassification(f.oracle, request.journalId));
  assert.deepEqual(rolled.sourceResult.applied, [...apply.proposalIds].reverse());
  assert.deepEqual(tree(f.root), tree(f.oracle));
});

test("revoked native actor/epoch after write-ahead journal prevents effects, receipt and stale authority replay", t => {
  const f = fixture(t), request = f.request();
  f.host.afterEffect = () => { f.state.allowed = false; };
  assert.throws(() => f.run(request), /authority denied/);
  assert.equal(inspect(f.db).receipts.length, 0);
  assert(inspect(f.db).pending);
  const before = tree(f.root);
  f.state.recovery = true; assert.throws(() => f.run(request), /authority denied/);
  assert.deepEqual(tree(f.root), before);
  f.state.allowed = true; f.state.epoch = false; assert.throws(() => f.run(request), /authority denied/);
  f.state.epoch = true; delete f.host.afterEffect;
  const result = f.run(request);
  assert.deepEqual(result.sourceResult, f.oracleApply(request, result));
});

test("immutable retries precede request CAS, but actor, history and live epoch revocation still deny", t => {
  const f = fixture(t), request = f.request(), result = f.run(request);
  const before = tree(f.root);
  f.restart();
  assert.deepEqual(f.run(request), result);
  assert.throws(() => f.run({ ...request, proposalIds: [request.proposalIds[0]] }), /reused/);
  f.state.epoch = false; assert.throws(() => f.run(request));
  f.state.epoch = true; f.state.allowed = false; assert.throws(() => f.run(request), /authority denied/);
  f.state.allowed = true;
  assert.throws(() => execute(f.db, f.host, f.scope, { ...actor, id: "other" }, request), /authority denied/);
  assert.deepEqual(tree(f.root), before);
});

test("SQL global receipt failure leaves the completed native intent recoverable, never success fallback", t => {
  const f = fixture(t), request = f.request();
  const write = f.host.writeGlobalReceipt;
  f.host.writeGlobalReceipt = () => { throw Error("SQL receipt crash"); };
  assert.throws(() => f.run(request), /SQL receipt crash/);
  assert.equal(inspect(f.db).receipts.length, 0);
  assert(inspect(f.db).pending);
  f.restart(); f.host.writeGlobalReceipt = write; f.state.recovery = true;
  const result = f.run(request);
  assert.deepEqual(result.sourceResult, f.oracleApply(request, result));
});

test("native CAS, foreign global ID, traversal, outside ownership, unknown root and rehashed byte forgery fail before effects", t => {
  const f = fixture(t), request = f.request(), before = tree(f.root);
  assert.throws(() => f.run({ ...request, layoutSha256: "0".repeat(64) }), /CAS differs/);
  f.state.owned = false; assert.throws(() => f.run(request)); f.state.owned = true;
  f.db.prepare("INSERT INTO global_receipt VALUES(?,?,?)").run(request.operationId, "0".repeat(64), "{}");
  assert.throws(() => f.run(request), /collision/);
  assert.deepEqual(tree(f.root), before);
  const next = f.request(), result = f.run(next);
  const row = f.db.prepare("SELECT payload FROM legacy_classification_command_receipt").get();
  const forged = JSON.parse(row.payload);
  forged.steps.find(s => s.kind === "target").effect.after = Buffer.from("forged").toString("base64");
  f.db.exec("DROP TRIGGER legacy_classification_command_receipt_no_update");
  f.db.prepare("UPDATE legacy_classification_command_receipt SET payload=?,payload_sha256=?").run(JSON.stringify(forged), hash(forged));
  assert.throws(() => f.run(next), /DDL differs/);
  f.db.exec(LEGACY_CLASSIFICATION_COMMAND_DDL);
  assert.throws(() => f.run(next), /proposal\/image differs/);
  assert(result.sourceResult.applied.length);
});

test("original rollback journals preserve ordered changed-since-apply skips after an earlier journal restores bytes", t => {
  const f = fixture(t), first = f.request(), result = f.run(first);
  f.oracleApply(first, result);
  const preview = f.source.previewAssetClassification(f.root);
  f.state.previews.set(preview.id, preview);
  const second = { ...f.request(), previewId: preview.id, proposalIds: preview.proposals.filter(p => p.type === "classification").map(p => p.id) };
  const secondResult = f.run(second);
  let calls = 0;
  const source = originalLoader({ crypto: { ...crypto, randomUUID() { return ++calls === 2 ? secondResult.sourceResult.journalId : crypto.randomUUID(); } } })("src/knowledge/asset-classification.ts");
  assert.deepEqual(secondResult.sourceResult, source.applyAssetClassification(f.oracle, { ...preview, root: f.oracle }, second.proposalIds));
  const request = { contract, action: "rollback", operationId: crypto.randomUUID(), journalId: result.sourceResult.journalId,
    layoutSha256: scanNativeClassification(f.db, f.host, f.root).layoutSha256 };
  assert.deepEqual(f.run(request).sourceResult, f.source.rollbackAssetClassification(f.oracle, request.journalId));
  assert.deepEqual(tree(f.root), tree(f.oracle));
  const rollbackSecond = { ...request, operationId: crypto.randomUUID(), journalId: secondResult.sourceResult.journalId,
    layoutSha256: scanNativeClassification(f.db, f.host, f.root).layoutSha256 };
  const rolledSecond = f.run(rollbackSecond).sourceResult;
  assert.deepEqual(rolledSecond, f.source.rollbackAssetClassification(f.oracle, rollbackSecond.journalId));
  assert.deepEqual(rolledSecond.skipped.map(e => e.reason), Array(first.proposalIds.length).fill("changed-since-apply"));
  assert.deepEqual(tree(f.root), tree(f.oracle));
});

test("symlinks and unprovisioned original journal genesis have explicit native unsupported gates", t => {
  const f = fixture(t), request = f.request(), before = read(f.root, "notes/a.md");
  symlinkSync("a.md", join(f.root, "notes/link.md"));
  assert.throws(() => f.run(request), /Symbolic links/);
  assert.deepEqual(read(f.root, "notes/a.md"), before);
  rmSync(join(f.root, "notes/link.md"));
  rmSync(join(f.root, ".pkm/state/asset-classification"), { recursive: true });
  // New fixture genesis has to be independently authorized.
  f.state.anchor = null;
  assert.throws(() => f.run(f.request()), /genesis must provision/);
});

test("schema-only leaf-first canonical registry is JSON exportable with one CoreError identity and exact command version", () => {
  for (const leaf of ["legacy-classification-command-contracts", "legacy-classification-command", "legacy-classification-command-host", "legacy-classification-command-backup"]) {
    const code = `
      import assert from 'node:assert/strict';
      import { z } from './next-server/node_modules/zod/index.js';
      await import('./next-server/dist/${leaf}.js');
      const {definitions,CoreError}=await import('./next-server/dist/contracts.js');
      const {CoreError:leafError}=await import('./next-server/dist/host-composition-legacy-batch15-errors.js');
      assert.equal(CoreError,leafError);
      assert.equal(definitions.length,228);
      assert.equal(new Set(definitions.map(d=>d.id)).size,228);
      const command=definitions.find(d=>d.id==='${operation}');
      assert.equal(command.readOnly,false);
      const exported=definitions.map(d=>({id:d.id,version:1,input:z.toJSONSchema(d.input,{unrepresentable:'any'}),output:z.toJSONSchema(d.output,{unrepresentable:'any'})}));
      assert.equal(JSON.parse(JSON.stringify(exported)).filter(d=>d.id==='${operation}')[0].version,1);
      assert.equal(command.input.safeParse({contract:'${contract}',action:'preview',bearer:'not-authority'}).success,false);
    `;
    execFileSync(process.execPath, ["--input-type=module", "-e", code], { cwd: fileURLToPath(new URL("../legacy/", import.meta.url)), stdio: ["ignore", "pipe", "pipe"] });
  }
});

test("schema23 reopen refuses missing original immutable DDL and preserves existing genesis data", async t => {
  const f = fixture(t), workspace = await initialize(join(f.folder, "schema-workspace"));
  const storage = await Storage.open(workspace); await storage.close();
  const db = new DatabaseSync(join(workspace, "core.sqlite"));
  assert.equal(db.prepare("PRAGMA user_version").get().user_version, 23);
  db.exec("DROP TRIGGER legacy_classification_command_receipt_no_update"); db.close();
  await assert.rejects(Storage.open(workspace), /Original classification DDL differs/);
  const readOnly = new DatabaseSync(join(workspace, "core.sqlite"), { readOnly: true });
  try {
    assert.equal(readOnly.prepare("PRAGMA user_version").get().user_version, 23);
    assert.equal(readOnly.prepare("SELECT 1 FROM sqlite_master WHERE name='legacy_classification_command_receipt_no_update'").get(), undefined);
  } finally { readOnly.close(); }
});

test("native-only fixture UUID allocation cannot overwrite a colliding original journal or grant a path", t => {
  const f = fixture(t), id = crypto.randomUUID();
  put(f.root, `.pkm/state/asset-classification/${id}.json`, '{"schema":1,"entries":[]}');
  f.host.fixtureJournalId = () => id;
  const request = f.request(), before = tree(f.root);
  assert.throws(() => f.run(request), /UUID journal collision/);
  assert.deepEqual(tree(f.root), before);
  f.host.fixtureJournalId = () => "../unowned";
  assert.throws(() => f.run(request), /must be UUIDv4/);
  assert.equal(inspect(f.db).pending, null);
  assert.throws(() => execute(f.db, undefined, f.scope, actor, request), /authority required/);
});

test("rehashed pending source bytes/outcomes and historical root changes are not native recovery authority", t => {
  const f = fixture(t), request = f.request();
  f.host.afterEffect = () => { throw Error("crash"); };
  assert.throws(() => f.run(request), /crash/);
  const row = f.db.prepare("SELECT payload FROM legacy_classification_command_intent").get();
  const forged = JSON.parse(row.payload);
  forged.outcomes.push({ id: request.proposalIds[0], reason: "unsafe-or-unavailable" });
  f.db.prepare("UPDATE legacy_classification_command_intent SET payload=?,payload_sha256=?").run(JSON.stringify(forged), hash(forged));
  f.state.recovery = true; delete f.host.afterEffect;
  const before = tree(f.root);
  assert.throws(() => f.run(request));
  assert.deepEqual(tree(f.root), before);
  f.db.prepare("UPDATE legacy_classification_command_intent SET payload=?,payload_sha256=?").run(row.payload, hash(row.payload));
  f.run(request);
  verify(f.db, f.host, f.scope);
  const receipt = f.db.prepare("SELECT operation_id,payload FROM legacy_classification_command_receipt").get();
  const altered = JSON.parse(receipt.payload);
  altered.rootPin.ino = String(BigInt(altered.rootPin.ino) + 1n);
  f.db.exec("DROP TRIGGER legacy_classification_command_receipt_no_update");
  f.db.prepare("UPDATE legacy_classification_command_receipt SET payload=?,payload_sha256=?").run(JSON.stringify(altered), hash(altered));
  f.db.exec(LEGACY_CLASSIFICATION_COMMAND_DDL);
  assert.throws(() => f.run(request), /historical root differs/);
});

test("Core HTTP/MCP identical source result and retries with actor filters, pending read fence, restart and explicit backup gate", async t => {
  const f = fixture(t);
  const workspace = await initialize(join(f.folder, "workspace")), root = join(workspace, "packages/classification");
  cpSync(f.root, root, { recursive: true });
  const previews = new Map(), state = { allowed: true, epoch: true, retry: false, anchor: null, crash: true };
  let pendingAnchor = { operationId: null, payloadSha256: null }, pendingGrant;
  let storage = await Storage.open(workspace, { deferRecovery: true }), runtime;
  const policy = {
    scope: "exclusive-native-disposable-fixture", sourceRelative: "packages/classification", sourceRootId: "c".repeat(64),
    assertOwnedDisposableFixture() {},
    authorize: who => state.allowed && state.epoch && who.id === actor.id,
    previewOriginal: f.source.previewAssetClassification, reviewedPreview: id => previews.get(id), isPrivate: () => false,
    assertHistoryAnchor(value) { assert(state.epoch); if (!state.anchor) state.anchor = value;
      if (value.historySha256 === state.nextHash) state.anchor = { ...state.anchor, historySha256: state.nextHash };
      assert.deepEqual(value, state.anchor); },
    approveHistoryTransition(value) { assert.equal(state.anchor.historySha256, value.previousSha256); state.nextHash = value.nextSha256; return true; },
    assertPendingAnchor(value) { if (pendingGrant && value.payloadSha256 === pendingGrant.payloadSha256) pendingAnchor = pendingGrant; assert.deepEqual(value, pendingAnchor); },
    approvePendingTransition(value) { assert.equal(value.previousSha256, pendingAnchor.payloadSha256);
      pendingGrant = { operationId: value.nextSha256 === null ? null : value.operationId, payloadSha256: value.nextSha256 }; return true; },
    approveRecovery: () => state.retry,
    afterEffect() { if (state.crash) { state.crash = false; throw Error("transport crash"); } },
  };
  runtime = await createNativeRuntime({ storage, originalClassification: policy });
  t.after(async () => { await runtime?.close(); await storage?.close(); });
  let io = await transports(t, runtime.core, actor);
  const preview = (await io.http(operation, { contract, action: "preview" })).result.sourceResult;
  previews.set(preview.id, preview);
  const database = storage.connectNative();
  const request = { contract, action: "apply", operationId: crypto.randomUUID(), previewId: preview.id,
    layoutSha256: scanNativeClassification(database, policy, root).layoutSha256,
    proposalIds: ["notes/a.md", "scripts/Engineering/a.py"].map(asset => preview.proposals.find(p => p.type === "classification" && p.asset === asset).id) };
  database.close();
  assert((await io.http(operation, request)).error);
  assert.equal((await io.mcp("knowledge.document.create", { operationId: crypto.randomUUID(), id: "blocked", title: "Blocked", content: "Blocked" })).error.code, "RECOVERY_REQUIRED");
  await io.close(); await runtime.close(); await storage.close();
  storage = await Storage.open(workspace, { deferRecovery: true });
  runtime = await createNativeRuntime({ storage, originalClassification: policy });
  io = await transports(t, runtime.core, actor);
  assert((await io.mcp(operation, request)).error);
  state.retry = true;
  const result = (await io.http(operation, request)).result;
  assert(result);
  assert.deepEqual((await io.mcp(operation, request)).result, result);
  const source = originalLoader({ crypto: { ...crypto, randomUUID: () => result.sourceResult.journalId } })("src/knowledge/asset-classification.ts");
  assert.deepEqual(result.sourceResult, source.applyAssetClassification(f.oracle, { ...preview, root: f.oracle }, request.proposalIds));
  const reopened = storage.connectNative();
  const rollback = { contract, action: "rollback", operationId: crypto.randomUUID(), journalId: result.sourceResult.journalId,
    layoutSha256: scanNativeClassification(reopened, policy, root).layoutSha256 };
  reopened.close();
  const rolled = (await io.mcp(operation, rollback)).result;
  assert.deepEqual(rolled.sourceResult, source.rollbackAssetClassification(f.oracle, rollback.journalId));
  assert.deepEqual((await io.http(operation, rollback)).result, rolled);
  state.allowed = false;
  assert.equal((await io.mcp(operation, request)).error.code, "NOT_AVAILABLE");
  state.allowed = true; state.epoch = false;
  assert((await io.http(operation, request)).error);
  state.epoch = true;
  await assert.rejects(createWorkspaceBackup(storage, join(f.folder, "unqualified-backup"), {
    async acquireQuiescence() { return { assertHeld() {}, release() {} }; },
  }, { nativePublishNoReplace: fixturePublisher(f.folder) }), /explicit native disposable fixture authority/);
  await io.close();
});
