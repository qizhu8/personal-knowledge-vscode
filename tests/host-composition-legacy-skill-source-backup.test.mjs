import test from "node:test";
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { closeSync, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync, renameSync, writeFileSync, unlinkSync } from "node:fs";
import { cp, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";
import { initialize, Storage } from "../dist/storage.js";
import { CoreError } from "../dist/contracts.js";
import { createNativeRuntime } from "../dist/native-runtime.js";
import { createWorkspaceBackup, restoreWorkspaceBackup } from "../dist/workspace-backup.js";
import { captureNativeLegacySkillSourceSnapshotDigest } from "../dist/legacy-skill-source-native.js";
import { scanNativeLegacySkillSourceAndTarget } from "../dist/legacy-skill-lifecycle-native.js";
import { legacySkillManifestHash } from "../dist/legacy-skill-lifecycle.js";
import { transports } from "./host-composition-legacy-shared-captures.mjs";
import { originalLoader, fixturePublisher, sourceBytes } from "./host-composition-legacy-batch15-captures.mjs";
import { captureBatch15SkillHistory } from "../dist/host-composition-legacy-batch15-skill.js";

const tests = fileURLToPath(new URL("./", import.meta.url));
const repository = fileURLToPath(new URL("../legacy/", import.meta.url));
const digest = value => createHash("sha256").update(value).digest("hex");
const bundle = readFileSync(join(repository, "resources/pkm-skills-router.md"));
const legacy = readFileSync(join(repository, "tests/fixtures/pkm-skills-router-1.7.2.md"));
const actor = { id: "source-backup-human", canWrite: true, collaborationKind: "human" };
const operation = "legacy.skill.source.install";
const removeOperation = "legacy.skill.source.remove";
const bridgeOperation = "legacy.skill.source.bridge";
const sourcePath = "System/PKM/PKM Skills.md", targetPath = "pkm-skills/SKILL.md";
const host = { async acquireQuiescence() { let held = true; return {
  assertHeld() { assert.equal(held, true); }, release() { held = false; },
}; } };
const generic = { actorId: actor.id, async authorize(request) { return {
  authorityId: "independent-disposable-restore", actorId: actor.id, requestSha256: digest(JSON.stringify(request)),
  expiresAt: Date.now() + 60_000, lineage: "unrelated", trustedEpoch: null,
}; } };
function durable(path, value) {
  const fd = openSync(`${path}.new`, "wx", 0o600);
  try { writeFileSync(fd, value); fsyncSync(fd); } finally { closeSync(fd); }
  renameSync(`${path}.new`, path);
  const parent = openSync(dirname(path), "r");
  try { fsyncSync(parent); } finally { closeSync(parent); }
}

test("actual old writer receipt history -> independently anchored bridge -> ordered lifecycle -> restart/two restores/verbatim old replay", async t => {
  const f = await fixture(t, sourceBytes, null, true), expected = f.oracle();
  let io = await transports(t, f.runtime.core, actor);
  const oldInput = action => {
    const input = f.input();
    return { operationId: randomUUID(), action, sourceSha256: input.sourceSha256,
      destinationSha256: input.destinationSha256, manifestSha256: input.destinationManifestSha256 };
  };
  const inject = oldInput("inject"), installed = await io.http("legacy.skill.router.inject", inject);
  assert.equal(installed.error, undefined, JSON.stringify(installed));
  assert.deepEqual(readFileSync(join(f.roots.destination, targetPath)), expected.destination);
  const oldRemove = oldInput("remove"), removed = await io.mcp("legacy.skill.router.remove", oldRemove);
  assert.equal(removed.error, undefined, JSON.stringify(removed));
  const reinstall = oldInput("inject"), reinstalled = await io.http("legacy.skill.router.inject", reinstall);
  assert.equal(reinstalled.error, undefined, JSON.stringify(reinstalled));
  const original = captureBatch15SkillHistory(f.db, JSON.parse(readFileSync(join(f.root, ".pkm-next-workspace"), "utf8")).id);
  const retained = { rows: original.rows, locals: original.locals, globals: original.globals };
  assert.equal((await io.http(operation, f.input())).error.code, "NOT_AVAILABLE");
  const bridge = f.approveExisting();
  f.state.bundle = legacy;
  const versionedBridge = { ...bridge, bundleSha256: digest(legacy) };
  f.state.bridgeApproved = false;
  assert.equal((await io.mcp(bridgeOperation, versionedBridge)).error.code, "ACCESS_DENIED");
  assert.equal(f.db.prepare("SELECT COUNT(*) n FROM legacy_skill_source_native_intent").get().n, 0);
  f.state.bridgeApproved = true;
  const admitted = await io.http(bridgeOperation, versionedBridge);
  assert.equal(admitted.error, undefined, JSON.stringify(admitted));
  assert.deepEqual((await io.mcp(bridgeOperation, versionedBridge)).result, admitted.result);
  const current = f.input();
  assert.equal((await io.http("legacy.skill.router.remove", { operationId: randomUUID(), action: "remove",
    sourceSha256: current.sourceSha256, destinationSha256: current.destinationSha256,
    manifestSha256: current.destinationManifestSha256 })).error.code, "RECOVERY_CONFLICT");
  const marker = Buffer.from('---\nname: pkm-skills\n---\n<!-- pkm-managed {"schema":1,"routerVersion":"1.0.0"} -->\nModified managed projection.\n');
  writeFileSync(join(f.roots.destination, targetPath), marker);
  f.state.bundle = bundle;
  const upgrade = await io.mcp(operation, f.input());
  assert.equal(upgrade.error, undefined, JSON.stringify(upgrade));
  assert.deepEqual(readFileSync(join(f.roots.source, sourcePath)), sourceBytes);
  assert.deepEqual(readFileSync(join(f.roots.destination, targetPath)), expected.destination);
  assert.equal((await io.http(removeOperation, f.removeInput())).error, undefined);
  const replayProof = join(f.roots.destination, "unrecognized-replay-proof");
  writeFileSync(replayProof, "A replay must not scan or compare historical effects with current layout.");
  assert.deepEqual((await io.http("legacy.skill.router.inject", inject)).result, installed.result);
  assert.deepEqual((await io.mcp("legacy.skill.router.remove", oldRemove)).result, removed.result);
  unlinkSync(replayProof);
  assert.equal((await io.mcp(operation, f.input())).error, undefined);
  await io.close(); await f.restart(); io = await transports(t, f.runtime.core, actor);
  assert.deepEqual((await io.mcp("legacy.skill.router.inject", inject)).result, installed.result);
  const backup = await f.backup("bridge-backup"), destination = join(f.parent, "bridge-restored");
  await assert.rejects(createWorkspaceBackup(f.storage, join(f.parent, "unapproved-bridge-backup"), host), /authority|canonical|Skill/i);
  await assert.rejects(restoreWorkspaceBackup(backup.backupPath, destination, { nativeRestoreAuthority: generic }), /authority|canonical|Skill/i);
  await restoreWorkspaceBackup(backup.backupPath, destination, { skillSourceBackup: f.backupPolicy, nativeRestoreAuthority: generic });
  await io.close(); await f.reopen(destination); io = await transports(t, f.runtime.core, actor);
  assert.deepEqual((await io.http("legacy.skill.router.inject", inject)).result, installed.result);
  assert.deepEqual((await io.mcp("legacy.skill.router.remove", oldRemove)).result, removed.result);
  assert.equal((await io.mcp(removeOperation, f.removeInput())).error, undefined);
  const rebackup = await f.backup("bridge-rebackup"), second = join(f.parent, "bridge-rerestored");
  await restoreWorkspaceBackup(rebackup.backupPath, second, { skillSourceBackup: f.backupPolicy, nativeRestoreAuthority: generic });
  await io.close(); await f.reopen(second); io = await transports(t, f.runtime.core, actor);
  assert.deepEqual((await io.mcp("legacy.skill.router.inject", inject)).result, installed.result);
  assert.deepEqual((await io.http("legacy.skill.router.remove", oldRemove)).result, removed.result);
  const captured = captureBatch15SkillHistory(f.db, JSON.parse(readFileSync(join(f.root, ".pkm-next-workspace"), "utf8")).id);
  assert.deepEqual({ rows: captured.rows, locals: captured.locals, globals: captured.globals }, retained);
  assert.equal(f.db.prepare("SELECT COUNT(*) n FROM legacy_skill_source_native_adoption").get().n, 2);
  f.state.bridgeApproved = false;
  assert.ok((await io.http("legacy.skill.router.inject", inject)).error);
  f.state.bridgeApproved = true;
  f.state.approved = false;
  assert.ok((await io.mcp("legacy.skill.router.remove", oldRemove)).error);
  f.state.approved = true;
});

for (const fault of ["bridgeSqlBefore", "bridgeAnchorStage", "bridgeSqlCommit", "committedAnchorFault"]) {
  test(`actual native bridge ${fault}: SQL/anchor unknown quarantined; explicit identical request/epoch recovery`, async t => {
    const f = await fixture(t, sourceBytes, null, true);
    let io = await transports(t, f.runtime.core, actor);
    const input = f.input(), old = { operationId: randomUUID(), action: "inject", sourceSha256: input.sourceSha256,
      destinationSha256: input.destinationSha256, manifestSha256: input.destinationManifestSha256 };
    assert.equal((await io.http("legacy.skill.router.inject", old)).error, undefined);
    const bridge = f.approveExisting();
    f.state[fault] = true;
    const failed = await io.mcp(bridgeOperation, bridge);
    assert.ok(failed.error, JSON.stringify(failed));
    assert.deepEqual(readFileSync(join(f.roots.source, sourcePath)), sourceBytes);
    assert.equal(f.db.prepare("SELECT COUNT(*) n FROM legacy_skill_native_history").get().n, 1);
    f.state[fault] = false;
    if (fault !== "bridgeSqlBefore") {
      const unknown = f.db.prepare("SELECT * FROM legacy_skill_source_native_intent").all();
      await io.close(); await f.restart(); io = await transports(t, f.runtime.core, actor);
      assert.deepEqual(f.db.prepare("SELECT * FROM legacy_skill_source_native_intent").all(), unknown);
      await assert.rejects(f.backup(`blocked-${fault}`), /pending|anchor|Skill/i);
      assert.ok((await io.http(bridgeOperation, { ...bridge, operationId: randomUUID() })).error);
      f.state.epoch = "wrong-live-epoch";
      assert.ok((await io.http(bridgeOperation, bridge)).error);
      f.state.epoch = "native-fixture-epoch";
      const denied = await io.http(bridgeOperation, bridge);
      assert.ok(denied.error, JSON.stringify(denied));
      f.state.bridgeRetry = true;
    }
    const recovered = await io.http(bridgeOperation, bridge);
    assert.equal(recovered.error, undefined, JSON.stringify(recovered));
    assert.equal(f.db.prepare("SELECT COUNT(*) n FROM legacy_skill_source_native_intent").get().n, 0);
    assert.equal(f.db.prepare("SELECT COUNT(*) n FROM legacy_skill_source_native_history").get().n, 1);
    assert.equal((await io.mcp(operation, f.input())).error, undefined);
  });
}

test("actual old pending Skill effects cannot be laundered through native source bridge", async t => {
  const f = await fixture(t, sourceBytes, null, true), io = await transports(t, f.runtime.core, actor);
  const input = f.input(), old = { operationId: randomUUID(), action: "inject", sourceSha256: input.sourceSha256,
    destinationSha256: input.destinationSha256, manifestSha256: input.destinationManifestSha256 };
  f.state.oldPendingFault = true;
  assert.equal((await io.http("legacy.skill.router.inject", old)).error.effect, "unknown");
  f.state.oldPendingFault = false;
  await f.restart();
  const other = await transports(t, f.runtime.core, actor);
  assert.equal(f.db.prepare("SELECT COUNT(*) n FROM legacy_skill_native_intent").get().n, 1);
  assert.ok((await other.mcp(bridgeOperation, { ...f.input(), legacyHistorySha256: "0".repeat(64) })).error);
  assert.equal(f.db.prepare("SELECT COUNT(*) n FROM legacy_skill_source_native_intent").get().n, 0);
  assert.equal(f.db.prepare("SELECT COUNT(*) n FROM legacy_skill_native_intent").get().n, 1);
});

test("actual multi-target legacy receipt history remains denied even when a bridge callback approves its hash", async t => {
  const f = await fixture(t, sourceBytes, null, true), io = await transports(t, f.runtime.core, actor);
  const input = f.input();
  const old = { operationId: randomUUID(), action: "inject", sourceSha256: input.sourceSha256,
    destinationSha256: input.destinationSha256, manifestSha256: input.destinationManifestSha256 };
  assert.equal((await io.http("legacy.skill.router.inject", old)).error, undefined);
  const second = join(f.root, "packages/second-target");
  mkdirSync(second);
  const scan = scanNativeLegacySkillSourceAndTarget(f.db, () => {}, { source: f.roots.source, destination: second });
  f.state.secondTarget = true;
  assert.equal((await io.mcp("legacy.skill.router.inject", { ...old, operationId: randomUUID(),
    destinationSha256: null, manifestSha256: legacySkillManifestHash(scan.destinationManifest) })).error, undefined);
  f.state.secondTarget = false;
  const bridge = f.approveExisting();
  assert.equal((await io.http(bridgeOperation, bridge)).error.code, "CONFLICT");
  assert.equal(f.db.prepare("SELECT COUNT(*) n FROM legacy_skill_source_native_history").get().n, 0);
  assert.equal(f.db.prepare("SELECT COUNT(*) n FROM legacy_skill_native_history").get().n, 2);
});

for (const changed of ["source", "destination", "receipt-before", "receipt-after"]) {
  test(`actual bridge refuses ${changed} tampering without laundering old receipts or source genesis`, async t => {
    const f = await fixture(t, sourceBytes, null, true), io = await transports(t, f.runtime.core, actor);
    const input = f.input(), old = { operationId: randomUUID(), action: "inject", sourceSha256: input.sourceSha256,
      destinationSha256: input.destinationSha256, manifestSha256: input.destinationManifestSha256 };
    assert.equal((await io.http("legacy.skill.router.inject", old)).error, undefined);
    const bridge = f.approveExisting();
    if (changed === "receipt-after") {
      assert.equal((await io.mcp(bridgeOperation, bridge)).error, undefined);
      f.db.prepare("UPDATE receipts SET fingerprint=? WHERE operation_id=?").run("0".repeat(64), old.operationId);
      assert.ok((await io.http("legacy.skill.router.inject", old)).error);
      assert.ok((await io.mcp(operation, f.input())).error);
      await assert.rejects(f.backup("tampered-bridge"), /Skill|bridge|history/i);
    } else {
      if (changed === "receipt-before")
        f.db.prepare("UPDATE receipts SET fingerprint=? WHERE operation_id=?").run("0".repeat(64), old.operationId);
      else writeFileSync(join(changed === "source" ? f.roots.source : f.roots.destination,
        changed === "source" ? sourcePath : targetPath), "Unknown unapproved layout.");
      assert.ok((await io.mcp(bridgeOperation, bridge)).error);
      assert.equal(f.db.prepare("SELECT COUNT(*) n FROM legacy_skill_source_native_history").get().n, 0);
    }
    assert.equal(f.db.prepare("SELECT COUNT(*) n FROM legacy_skill_source_native_intent").get().n, 0);
    assert.equal(f.db.prepare("SELECT COUNT(*) n FROM legacy_skill_native_history").get().n, 1);
  });
}
async function fixture(t, before = null, modified = null, bridgeMode = false) {
  const parent = await mkdtemp(join(tests, ".source-backup-"));
  let storage, runtime, db;
  let root = await initialize(join(parent, "workspace"));
  const rootsAt = selectedRoot => ({ source: join(selectedRoot, "packages/source"), destination: join(selectedRoot, "packages/target") });
  const roots = rootsAt(root);
  for (const path of Object.values(roots)) mkdirSync(path, { recursive: true });
  const put = (path, value) => { mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, value); };
  if (before !== null) put(join(roots.source, sourcePath), before);
  if (modified !== null) put(join(roots.destination, targetPath), modified);
  put(join(roots.destination, "unrelated.bin"), Buffer.from([255, 0, 17]));
  const workspaceId = JSON.parse(await readFile(join(root, ".pkm-next-workspace"), "utf8")).id;
  const binding = { workspaceId, actorId: actor.id, sourceRootId: "source", destinationRootId: "target",
    targetId: "fixture", targetKind: "custom", extensionVersion: "test" };
  const originalRoot = root, originalAnchor = join(parent, "anchor"), planApproval = join(parent, "plan-approval");
  const restoreApproval = join(parent, "restore-approval"), publishApproval = join(parent, "publish-approval");
  const oldApproval = join(parent, "old-approval"), bridgeApproval = join(parent, "bridge-approval");
  const state = { approved: true, calls: 0, denyAt: Infinity, allowedDestination: undefined,
    pendingFault: false, committedAnchorFault: false, denyPrepare: false, denyPublish: false, denyFinal: false,
    tamperStage: false, adoptionAnchorFault: false, occupyFinal: false, bundle,
    bridgeApproved: true, bridgeRetry: false, bridgeSqlBefore: false, bridgeSqlCommit: false,
    bridgeAnchorStage: false, oldPendingFault: false, epoch: "native-fixture-epoch", secondTarget: false };
  const anchorFiles = new Map([[originalRoot, originalAnchor]]);
  const pin = path => { const stat = lstatSync(path, { bigint: true }); return { dev: String(stat.dev), ino: String(stat.ino) }; };
  const parentPin = pin(parent);
  function anchorFor(selectedRoot) {
    assert.deepEqual(pin(parent), parentPin);
    if (anchorFiles.has(selectedRoot)) return anchorFiles.get(selectedRoot);
    const prepare = JSON.parse(readFileSync(restoreApproval, "utf8"));
    assert.equal(dirname(selectedRoot), parent);
    let path;
    if (selectedRoot === prepare.destination) {
      const publish = JSON.parse(readFileSync(publishApproval, "utf8"));
      assert.equal(publish.destination, selectedRoot);
      assert.deepEqual(pin(selectedRoot), publish.stagePin);
      path = anchorFiles.get(publish.stage);
      assert.ok(path);
    } else {
      assert.match(selectedRoot.slice(parent.length + 1), /^\.pkm-restore\.[0-9a-f-]+\.stage$/);
      const bytes = readFileSync(join(selectedRoot, "packages/source", sourcePath));
      assert.equal(digest(bytes), prepare.backup.request.sourceManifest.find(item => item.path === sourcePath).sha256);
      path = join(parent, `stage-anchor-${digest(selectedRoot)}`);
      durable(path, prepare.backup.request.snapshotDigest);
    }
    anchorFiles.set(selectedRoot, path);
    return path;
  }
  function nativeFor(selectedRoot, database) {
    const selectedRoots = rootsAt(selectedRoot), anchor = anchorFor(selectedRoot);
    return {
    binding, roots: selectedRoots, bundle: state.bundle, bundleSha256: digest(state.bundle), epoch: state.epoch,
    assertOwner() {
      assert.equal(database.isTransaction, false);
      if (!state.approved) throw new CoreError("ACCESS_DENIED", "Fixture native ownership or authorization revoked.");
      assert.deepEqual(pin(parent), parentPin);
      for (const selected of Object.values(selectedRoots)) assert.equal(lstatSync(selected).isDirectory(), true);
      if (state.pendingFault && database.prepare("SELECT 1 FROM legacy_skill_source_native_intent").get())
        throw new CoreError("RECOVERY_REQUIRED", "Interrupted native source intent.", "unknown");
    },
    authorize: selected => selected.id === actor.id && state.approved,
    approvePlan(selected, plan, pins, recovery) {
      assert.equal(database.isTransaction, false);
      if (selected.id !== actor.id || recovery) return false;
      durable(planApproval, JSON.stringify({ plan, pins })); return state.approved;
    },
    approveRemovePlan(selected, plan, pins, recovery) {
      assert.equal(database.isTransaction, false);
      if (selected.id !== actor.id || recovery) return false;
      durable(planApproval, JSON.stringify({ plan, pins })); return state.approved;
    },
    ...(bridgeMode ? {
      approveBridge(selected, plan, pins, recovery) {
        assert.equal(database.isTransaction, false);
        if (!state.bridgeApproved || !state.approved || selected.id !== actor.id || recovery && !state.bridgeRetry) return false;
        const approved = JSON.parse(readFileSync(oldApproval, "utf8"));
        assert.deepEqual(plan.legacy, approved.legacy);
        assert.deepEqual(plan.actor, actor); assert.deepEqual(plan.genesis.binding, binding);
        assert.deepEqual(plan.roots, approved.roots); assert.deepEqual(pins, approved.pins);
        assert.equal(plan.epoch, approved.epoch);
        assert.deepEqual(plan.genesis.sourceBeforeManifest, approved.sourceManifest);
        assert.deepEqual(plan.genesis.destinationBeforeManifest, approved.destinationManifest);
        assert.equal(plan.genesis.source.beforeBase64, approved.sourceBase64);
        assert.equal(plan.genesis.destinationBeforeBase64, approved.destinationBase64);
        if (recovery) assert.deepEqual(JSON.parse(readFileSync(bridgeApproval, "utf8")), { plan, pins });
        else { durable(bridgeApproval, JSON.stringify({ plan, pins })); durable(planApproval, JSON.stringify({ plan: plan.genesis, pins })); }
        return true;
      },
      verifyBridge(plan, pins) {
        assert.equal(database.isTransaction, false);
        if (!state.bridgeApproved || !state.approved) return false;
        assert.deepEqual(JSON.parse(readFileSync(bridgeApproval, "utf8")), { plan, pins }); return true;
      },
      reconcileBridgeAnchor(value, selected, recovery) {
        assert.equal(database.isTransaction, false);
        if (!state.bridgeRetry || !state.bridgeApproved || selected.id !== actor.id)
          throw new CoreError("ACCESS_DENIED", "No independent bridge recovery approval.");
        assert.deepEqual(JSON.parse(readFileSync(bridgeApproval, "utf8")), { plan: recovery.plan, pins: recovery.pins });
        const current = JSON.parse(readFileSync(oldApproval, "utf8"));
        assert.deepEqual(current.legacy, recovery.plan.legacy);
        durable(anchor, value);
      },
    } : {}),
    assertNoOtherPendingNative() { assert.equal(database.isTransaction, false); },
    assertSqlOwner(database) { assert.equal(database.isTransaction, true); },
    assertNoOtherPendingSql(database) {
      assert.equal(database.isTransaction, true);
      if (state.bridgeSqlBefore && !database.prepare("SELECT 1 FROM legacy_skill_source_native_intent").get()
        || state.bridgeSqlCommit && database.prepare("SELECT 1 FROM legacy_skill_source_native_intent").get())
        throw new CoreError("RECOVERY_REQUIRED", "Native bridge SQL fault.", "unknown");
    },
    checkAnchor(value) {
      assert.equal(database.isTransaction, false);
      if (readFileSync(anchor, "utf8") !== value) throw new CoreError("RECOVERY_REQUIRED", "Stale independent native anchor.", "unknown");
    },
    advanceAnchor(beforeDigest, afterDigest) {
      assert.equal(database.isTransaction, false); assert.equal(readFileSync(anchor, "utf8"), beforeDigest);
      if (state.bridgeAnchorStage && database.prepare("SELECT 1 FROM legacy_skill_source_native_intent").get())
        throw new CoreError("RECOVERY_REQUIRED", "Interrupted bridge stage anchor.", "unknown");
      if (state.committedAnchorFault && database.prepare("SELECT 1 FROM legacy_skill_source_native_receipt").get())
        throw new CoreError("RECOVERY_REQUIRED", "Interrupted native postcommit anchor.", "unknown");
      if (state.adoptionAnchorFault && database.prepare("SELECT 1 FROM legacy_skill_source_native_adoption").get())
        throw new CoreError("RECOVERY_REQUIRED", "Interrupted adoption anchor.", "unknown");
      durable(anchor, afterDigest);
    },
    reconcileAnchor() { throw new CoreError("ACCESS_DENIED", "No fixture recovery approval."); },
    reconcileRemoveAnchor() { throw new CoreError("ACCESS_DENIED", "No fixture removal recovery approval."); },
    approveAdoption(selected, request) {
      assert.equal(database.isTransaction, false); assert.equal(selected.id, actor.id);
      const approved = JSON.parse(readFileSync(publishApproval, "utf8"));
      assert.deepEqual(request, approved.adoption);
      assert.deepEqual(request.physicalRoots, selectedRoots);
      assert.deepEqual(request.newRoots, rootsAt(approved.destination));
      assert.deepEqual(pin(selectedRoot), approved.stagePin);
      assert.deepEqual(pin(dirname(approved.destination)), approved.destinationParentPin);
      assert.equal(request.snapshotDigest, readFileSync(anchor, "utf8"));
      const scan = scanNativeLegacySkillSourceAndTarget(database, () => {}, selectedRoots);
      assert.deepEqual(request.newPins, scan.pins);
      assert.deepEqual(request.sourceManifest, scan.sourceManifest);
      assert.deepEqual(request.destinationManifest, scan.destinationManifest);
      assert.deepEqual(request.oldRoots, approved.backup.request.roots);
      assert.deepEqual(request.oldPins, approved.backup.request.pins);
      assert.equal(request.historyHead, approved.backup.request.historyHead);
      return !state.denyPublish;
    },
    reconcileAdoptionAnchor() { throw new CoreError("ACCESS_DENIED", "No interrupted adoption reconciliation approval."); },
    bundleForDigest: hash => hash === digest(bundle) ? bundle : hash === digest(legacy) ? legacy : undefined,
    globalReceipt() { throw new Error("Composition must replace hook."); },
    writeGlobalReceipt() { throw new Error("Composition must replace hook."); },
  }; }
  const policy = { scope: "exclusive-native-disposable-fixture",
    authorityForActor: selected => selected.id === actor.id ? nativeFor(root, db) : undefined };
  const backupPolicy = {
    scope: "exclusive-native-disposable-fixture", actor,
    authorityForWorkspace(selectedRoot, database) {
      return nativeFor(selectedRoot, database);
    },
    authorizeBackup(request) {
      assert.equal(db.isTransaction, false);
      state.calls++;
      if (state.calls >= state.denyAt) return null;
      assert.equal(request.destination, state.allowedDestination);
      assert.deepEqual(request.binding, binding); assert.deepEqual(request.roots, rootsAt(request.workspaceRoot));
      assert.equal(request.epoch, "native-fixture-epoch");
      assert.equal(request.snapshotDigest, readFileSync(anchorFor(request.workspaceRoot), "utf8"));
      const scan = scanNativeLegacySkillSourceAndTarget(db, () => {}, rootsAt(request.workspaceRoot));
      assert.deepEqual(request.pins, scan.pins);
      assert.deepEqual(request.sourceManifest, scan.sourceManifest);
      assert.deepEqual(request.destinationManifest, scan.destinationManifest);
      const approved = JSON.parse(readFileSync(planApproval, "utf8"));
      assert.deepEqual(scan.sourceManifest, approved.plan.sourceAfterManifest);
      assert.deepEqual(scan.destinationManifest, approved.plan.destinationAfterManifest);
      return { requestSha256: digest(JSON.stringify(request)), epoch: request.epoch, expiresAt: Date.now() + 60_000 };
    },
    authorizeRestore(request) {
      assert.equal(db.isTransaction, false);
      assert.equal(request.manifestSha256, digest(readFileSync(join(request.backupRoot, ".pkm-workspace-backup.json"))));
      assert.deepEqual(request.backupRootPin, pin(request.backupRoot));
      assert.deepEqual(request.destinationParentPin, parentPin);
      assert.equal(dirname(request.destination), parent);
      assert.equal(request.backup.request.snapshotDigest, readFileSync(anchorFor(request.backup.request.workspaceRoot), "utf8"));
      const oldScan = scanNativeLegacySkillSourceAndTarget(db, () => {}, request.backup.request.roots);
      assert.deepEqual(oldScan.pins, request.backup.request.pins);
      assert.deepEqual(oldScan.sourceManifest, request.backup.request.sourceManifest);
      assert.deepEqual(oldScan.destinationManifest, request.backup.request.destinationManifest);
      if (request.phase === "prepare") {
        if (state.denyPrepare) return null;
        durable(restoreApproval, JSON.stringify(request));
      } else {
        if (state.denyPublish || state.denyFinal && request.adoptedHead !== null) return null;
        assert.deepEqual(request.stagePin, pin(request.stage));
        assert.deepEqual(request.adoption.physicalRoots, rootsAt(request.stage));
        assert.deepEqual(request.adoption.newRoots, rootsAt(request.destination));
        const scan = scanNativeLegacySkillSourceAndTarget(db, () => {}, rootsAt(request.stage));
        assert.deepEqual(request.adoption.newPins, scan.pins);
        assert.deepEqual(request.adoption.sourceManifest, scan.sourceManifest);
        assert.deepEqual(request.adoption.destinationManifest, scan.destinationManifest);
        if (request.adoptedHead) assert.equal(request.adoptedSnapshotDigest, readFileSync(anchorFor(request.stage), "utf8"));
        durable(publishApproval, JSON.stringify(request));
        if (state.tamperStage) writeFileSync(join(request.stage, "packages/source", sourcePath), "changed inside native approval");
        if (state.occupyFinal && request.adoptedHead) {
          mkdirSync(request.destination); writeFileSync(join(request.destination, "sentinel"), "never replace");
        }
      }
      return { requestSha256: digest(JSON.stringify(request)), epoch: request.backup.request.epoch, expiresAt: Date.now() + 60_000 };
    },
  };
  async function close() {
    db?.close(); db = undefined; await runtime?.close(); runtime = undefined;
    await storage?.close(); storage = undefined;
  }
  async function open(selectedRoot = root) {
    root = selectedRoot;
    storage = await Storage.open(root, { deferRecovery: true }); db = storage.connectNative();
    runtime = await createNativeRuntime({ storage, skillSource: policy, ...(bridgeMode ? {
      batch15Skills: {
        scope: "exclusive-native-disposable-fixture",
        admissionForActor: who => who.id === actor.id ? {
          binding: state.secondTarget ? { ...binding, destinationRootId: "second-target", targetId: "second-fixture" } : binding,
          sourceRelative: "packages/source", destinationRelative: state.secondTarget ? "packages/second-target" : "packages/target",
        } : undefined,
        assertFixtureOwnership() {
          assert.equal(db.isTransaction, false);
          if (!state.approved) throw new CoreError("ACCESS_DENIED", "No native old fixture approval.");
          if (state.oldPendingFault && db.prepare("SELECT 1 FROM legacy_skill_native_intent").get())
            throw new CoreError("RECOVERY_REQUIRED", "Old intent remains quarantined.", "unknown");
        },
        authorize: who => state.approved && who.id === actor.id,
        approveRetry: () => false,
      },
    } : {}) });
  }
  t.after(async () => { await close(); await rm(parent, { recursive: true, force: true }); });
  storage = await Storage.open(root, { deferRecovery: true }); db = storage.connectNative();
  durable(originalAnchor, captureNativeLegacySkillSourceSnapshotDigest(db));
  db.close(); db = undefined; await storage.close(); storage = undefined; await open();
  function input() {
    const scan = scanNativeLegacySkillSourceAndTarget(db, () => nativeFor(root, db).assertOwner(), rootsAt(root));
    return { operationId: randomUUID(), bundleSha256: digest(state.bundle),
      sourceSha256: scan.source === null ? null : digest(scan.source),
      destinationSha256: scan.destination === null ? null : digest(scan.destination),
      sourceManifestSha256: legacySkillManifestHash(scan.sourceManifest),
      destinationManifestSha256: legacySkillManifestHash(scan.destinationManifest) };
  }
  function removeInput() {
    const { bundleSha256, ...rest } = input();
    assert.ok(bundleSha256);
    return rest;
  }
  function approveExisting() {
    const captured = captureBatch15SkillHistory(db, workspaceId);
    const scan = scanNativeLegacySkillSourceAndTarget(db, () => {}, rootsAt(root));
    const legacy = { rows: captured.rows, locals: captured.locals, globals: captured.globals };
    durable(oldApproval, JSON.stringify({ legacy, roots: rootsAt(root), pins: scan.pins, epoch: state.epoch,
      sourceManifest: scan.sourceManifest, destinationManifest: scan.destinationManifest,
      sourceBase64: scan.source.toString("base64"), destinationBase64: scan.destination.toString("base64") }));
    return { ...input(), legacyHistorySha256: digest(JSON.stringify(legacy)) };
  }
  function oracle() {
    const store = join(parent, "oracle-store"), target = join(parent, "oracle-target");
    mkdirSync(target);
    if (before !== null) put(join(store, "skills", sourcePath), before);
    if (modified !== null) put(join(target, targetPath), modified);
    const projection = originalLoader({ "../knowledge/filestore": { getStorePath: () => store }, vscode: {} })("src/skills/pkm-skill-projection.ts");
    const context = { extensionPath: repository, extension: { packageJSON: { version: "test" } },
      globalState: { get: (key, fallback) => key === "pkm.skillProjection.customTargets.v1"
        ? [{ id: "fixture", kind: "custom", label: "Fixture", root: target }] : fallback, update: async () => {} } };
    assert.equal(projection.injectPkmSkill(context, "fixture").state, "current");
    return { source: readFileSync(join(store, "skills", sourcePath)), destination: readFileSync(join(target, targetPath)) };
  }
  return { parent, get root() { return root; }, get roots() { return rootsAt(root); }, state, backupPolicy,
    get anchor() { return anchorFor(root); }, input, removeInput, oracle, approveExisting,
    get runtime() { return runtime; }, get db() { return db; }, get storage() { return storage; },
    async restart() { await close(); await open(); },
    async reopen(selectedRoot) { await close(); await open(selectedRoot); },
    async backup(name = "backup", options = {}) {
      state.allowedDestination = join(parent, name);
      return createWorkspaceBackup(storage, state.allowedDestination, host, {
        skillSourceBackup: backupPolicy, ...options,
      });
    } };
}

for (const [label, before] of [["create", null], ["upgrade", legacy],
  ["custom-preserve", Buffer.from("---\nname: Custom\n---\nPreserve independent custom source.\n")]]) {
  test(`actual original writer/Core HTTP/MCP ${label} -> backup/fresh restore/native reopen/old retry/new install/rebackup/rerestore`, async t => {
    const modified = label === "upgrade" ? Buffer.from('---\nname: pkm-skills\n---\n<!-- pkm-managed {"schema":1,"routerVersion":"1.0.0"} -->\nModified managed projection.\n') : null;
    const f = await fixture(t, before, modified), expected = f.oracle();
    let io = await transports(t, f.runtime.core, actor);
    const input = f.input(), installed = await io.http(operation, input);
    assert.equal(installed.error, undefined, JSON.stringify(installed));
    assert.deepEqual((await io.mcp(operation, input)).result, installed.result);
    const backup = await f.backup();
    assert.deepEqual(await readFile(join(backup.backupPath, "packages/source", sourcePath)), expected.source);
    assert.deepEqual(await readFile(join(backup.backupPath, "packages/target", targetPath)), expected.destination);
    const manifest = JSON.parse(await readFile(join(backup.backupPath, ".pkm-workspace-backup.json"), "utf8"));
    assert.equal(manifest.databaseUserVersion, 23);
    assert.equal(manifest.skillSource.request.snapshotDigest, readFileSync(f.anchor, "utf8"));
    const snapshot = new DatabaseSync(join(backup.backupPath, "core.sqlite"), { readOnly: true });
    try {
      assert.deepEqual(snapshot.prepare("SELECT * FROM legacy_skill_source_native_history").all(),
        f.db.prepare("SELECT * FROM legacy_skill_source_native_history").all());
      assert.deepEqual(snapshot.prepare("SELECT * FROM receipts WHERE operation=?").all(operation),
        f.db.prepare("SELECT * FROM receipts WHERE operation=?").all(operation));
    } finally { snapshot.close(); }
    await io.close(); await f.restart(); io = await transports(t, f.runtime.core, actor);
    assert.deepEqual((await io.mcp(operation, input)).result, installed.result);
    const destination = join(f.parent, "restored");
    await assert.rejects(restoreWorkspaceBackup(backup.backupPath, destination, {
      skillSourceBackup: f.backupPolicy,
    }), { code: "AUTHORITY_REQUIRED" });
    await assert.rejects(restoreWorkspaceBackup(backup.backupPath, destination, {
      skillSourceBackup: f.backupPolicy,
      nativeRestoreAuthority: { actorId: actor.id, authorize: async () => null },
    }), { code: "AUTHORITY_REQUIRED" });
    await restoreWorkspaceBackup(backup.backupPath, destination, {
      skillSourceBackup: f.backupPolicy, nativeRestoreAuthority: generic,
    });
    assert.equal((await readdir(f.parent)).some(name => name.startsWith(".pkm-restore.")), false);
    await io.close(); await f.reopen(destination); io = await transports(t, f.runtime.core, actor);
    assert.deepEqual((await io.http(operation, input)).result, installed.result);
    assert.deepEqual((await io.mcp(operation, input)).result, installed.result);
    assert.deepEqual(readFileSync(join(f.roots.source, sourcePath)), expected.source);
    assert.deepEqual(readFileSync(join(f.roots.destination, targetPath)), expected.destination);
    writeFileSync(join(f.roots.destination, targetPath), Buffer.concat([expected.destination, Buffer.from("\nModified managed native target.\n")]));
    const newInput = f.input(), nextInstall = await io.mcp(operation, newInput);
    assert.equal(nextInstall.error, undefined, JSON.stringify(nextInstall));
    assert.deepEqual(readFileSync(join(f.roots.source, sourcePath)), expected.source);
    assert.deepEqual(readFileSync(join(f.roots.destination, targetPath)), expected.destination);
    assert.equal(f.db.prepare("SELECT COUNT(*) n FROM legacy_skill_source_native_adoption").get().n, 1);
    const rebackup = await f.backup("rebackup"), rerestored = join(f.parent, "rerestored");
    await restoreWorkspaceBackup(rebackup.backupPath, rerestored, {
      skillSourceBackup: f.backupPolicy, nativeRestoreAuthority: generic,
    });
    await io.close(); await f.reopen(rerestored); io = await transports(t, f.runtime.core, actor);
    assert.deepEqual((await io.http(operation, input)).result, installed.result);
    assert.deepEqual((await io.mcp(operation, newInput)).result, nextInstall.result);
    assert.equal(f.db.prepare("SELECT COUNT(*) n FROM legacy_skill_source_native_adoption").get().n, 2);
    assert.equal(f.db.prepare("SELECT COUNT(*) n FROM legacy_skill_source_native_history").get().n, 2);
    assert.deepEqual(readFileSync(join(f.roots.destination, "unrelated.bin")), Buffer.from([255, 0, 17]));
    await io.close(); await f.restart(); io = await transports(t, f.runtime.core, actor);
    assert.deepEqual((await io.mcp(operation, input)).result, installed.result);
    assert.deepEqual((await io.http(operation, newInput)).result, nextInstall.result);
  });
}

test("source install/remove/reinstall survives restart, two native-authorized restores and old receipt retries", async t => {
  const f = await fixture(t), oracle = f.oracle();
  f.state.bundle = legacy;
  let io = await transports(t, f.runtime.core, actor);
  const first = f.input(), installed = await io.http(operation, first);
  assert.equal(installed.error, undefined, JSON.stringify(installed));
  const projection = join(f.roots.destination, targetPath);
  const firstProjection = readFileSync(projection);
  const asset = join(f.roots.destination, "pkm-skills", "asset.bin");
  writeFileSync(asset, "asset");
  writeFileSync(projection, Buffer.concat([oracle.destination, Buffer.from("\nmanaged edit\n")]));
  const remove = f.removeInput(), removed = await io.mcp(removeOperation, remove);
  assert.equal(removed.error, undefined, JSON.stringify(removed));
  assert.equal(removed.result.destinationSha256, null);
  assert.throws(() => readFileSync(projection), { code: "ENOENT" });
  assert.equal(readFileSync(asset, "utf8"), "asset");
  assert.deepEqual(readFileSync(join(f.roots.source, sourcePath)), legacy);
  const again = f.input(), reinstalled = await io.http(operation, again);
  assert.equal(reinstalled.error, undefined, JSON.stringify(reinstalled));
  assert.deepEqual(readFileSync(projection), firstProjection);
  f.state.bundle = bundle;
  const upgrade = f.input(), upgraded = await io.http(operation, upgrade);
  assert.equal(upgraded.error, undefined, JSON.stringify(upgraded));
  assert.deepEqual(readFileSync(projection), oracle.destination);
  assert.deepEqual(readFileSync(join(f.roots.source, sourcePath)), oracle.source);
  await io.close(); await f.restart(); io = await transports(t, f.runtime.core, actor);
  assert.deepEqual((await io.mcp(removeOperation, remove)).result, removed.result);
  const backup = await f.backup(), restored = join(f.parent, "restored-cycle");
  await restoreWorkspaceBackup(backup.backupPath, restored, { skillSourceBackup: f.backupPolicy, nativeRestoreAuthority: generic });
  await io.close(); await f.reopen(restored); io = await transports(t, f.runtime.core, actor);
  assert.deepEqual((await io.http(operation, first)).result, installed.result);
  assert.deepEqual((await io.mcp(removeOperation, remove)).result, removed.result);
  const secondRemove = f.removeInput(), second = await io.http(removeOperation, secondRemove);
  assert.equal(second.error, undefined, JSON.stringify(second));
  const rebackup = await f.backup("cycle-rebackup"), rerestored = join(f.parent, "rerestored-cycle");
  await restoreWorkspaceBackup(rebackup.backupPath, rerestored, { skillSourceBackup: f.backupPolicy, nativeRestoreAuthority: generic });
  await io.close(); await f.reopen(rerestored); io = await transports(t, f.runtime.core, actor);
  assert.deepEqual((await io.http(operation, first)).result, installed.result);
  assert.deepEqual((await io.mcp(removeOperation, secondRemove)).result, second.result);
  assert.throws(() => readFileSync(join(f.roots.destination, targetPath)), { code: "ENOENT" });
  assert.equal(readFileSync(join(f.roots.destination, "pkm-skills/asset.bin"), "utf8"), "asset");
  assert.deepEqual(readFileSync(join(f.roots.source, sourcePath)), oracle.source);
  assert.deepEqual((await io.mcp(operation, upgrade)).result, upgraded.result);
  assert.equal(f.db.prepare("SELECT COUNT(*) n FROM legacy_skill_source_native_history").get().n, 5);
});

test("default/native pre-stage and pre-publication denials, stale external seal, current destination and global receipt tamper fail closed", async t => {
  const f = await fixture(t), io = await transports(t, f.runtime.core, actor), input = f.input();
  assert.equal((await io.http(operation, input)).error, undefined);
  await assert.rejects(f.backup("default-deny", { skillSourceBackup: undefined }), { code: "RECOVERY_AUTHORITY_REQUIRED" });
  f.state.calls = 0; f.state.denyAt = 1;
  await assert.rejects(f.backup("before-stage"), { code: "RECOVERY_AUTHORITY_REQUIRED" });
  assert.equal((await readdir(f.parent)).some(name => name.startsWith(".pkm-backup.")), false);
  f.state.calls = 0; f.state.denyAt = 3;
  await assert.rejects(f.backup("before-publish"), { code: "RECOVERY_AUTHORITY_REQUIRED" });
  assert.throws(() => lstatSync(join(f.parent, "before-publish")), { code: "ENOENT" });
  f.state.denyAt = Infinity;
  const anchored = readFileSync(f.anchor, "utf8");
  durable(f.anchor, "0".repeat(64));
  await assert.rejects(f.backup("stale"), { code: "RECOVERY_REQUIRED" });
  durable(f.anchor, anchored);
  const bytes = readFileSync(join(f.roots.destination, targetPath));
  writeFileSync(join(f.roots.destination, targetPath), "tamper");
  await assert.rejects(f.backup("destination-tamper"));
  writeFileSync(join(f.roots.destination, targetPath), bytes);
  f.db.prepare("UPDATE receipts SET actor_id=? WHERE operation_id=?").run("forged-actor", input.operationId);
  await assert.rejects(f.backup("global-tamper"), { code: "RECOVERY_CONFLICT" });
});

test("repinned copied source bytes cannot mint native snapshot approval or create a restore stage", async t => {
  const f = await fixture(t), io = await transports(t, f.runtime.core, actor);
  assert.equal((await io.http(operation, f.input())).error, undefined);
  const backup = await f.backup(), bad = join(f.parent, "repinned");
  await cp(backup.backupPath, bad, { recursive: true });
  await writeFile(join(bad, "packages/source", sourcePath), "attacker-rehashed-source");
  const manifestPath = join(bad, ".pkm-workspace-backup.json"), manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  for (const file of manifest.files) {
    const bytes = await readFile(join(bad, file.path));
    manifest.totalBytes += bytes.length - file.size; file.size = bytes.length; file.sha256 = digest(bytes);
  }
  await writeFile(manifestPath, JSON.stringify(manifest));
  await assert.rejects(restoreWorkspaceBackup(bad, join(f.parent, "repinned-restored"), {
    skillSourceBackup: f.backupPolicy, nativeRestoreAuthority: generic,
  }), { code: "RECOVERY_AUTHORITY_REQUIRED" });
  assert.equal((await readdir(f.parent)).some(name => name.startsWith(".pkm-restore.")), false);
});

for (const stateFlag of ["pendingFault", "committedAnchorFault"]) {
  test(`native ${stateFlag} interruption forbids concrete workspace backup without auto-recovery`, async t => {
    const f = await fixture(t), io = await transports(t, f.runtime.core, actor);
    f.state[stateFlag] = true;
    const result = await io.http(operation, f.input());
    assert.equal(result.error.effect, "unknown");
    f.state[stateFlag] = false;
    await assert.rejects(f.backup("interrupted"), { code: "RECOVERY_REQUIRED" });
    assert.throws(() => lstatSync(join(f.parent, "interrupted")), { code: "ENOENT" });
    assert.equal((await readdir(f.parent)).some(name => name.startsWith(".pkm-backup.")), false);
  });
}

for (const stateFlag of ["denyPrepare", "denyPublish", "denyFinal", "tamperStage", "adoptionAnchorFault"]) {
  test(`restore ${stateFlag} rejects before publication; unknown adopted stages remain quarantined`, async t => {
    const f = await fixture(t), io = await transports(t, f.runtime.core, actor);
    assert.equal((await io.http(operation, f.input())).error, undefined);
    const backup = await f.backup(), destination = join(f.parent, "denied-restore");
    f.state[stateFlag] = true;
    await assert.rejects(restoreWorkspaceBackup(backup.backupPath, destination, {
      skillSourceBackup: f.backupPolicy, nativeRestoreAuthority: generic,
      nativePublishNoReplace: fixturePublisher(f.parent),
    }));
    assert.throws(() => lstatSync(destination), { code: "ENOENT" });
    const stages = (await readdir(f.parent)).filter(name => name.startsWith(".pkm-restore."));
    assert.equal(stages.length, ["denyFinal", "tamperStage", "adoptionAnchorFault"].includes(stateFlag) ? 1 : 0);
    if (stages.length) {
      f.state[stateFlag] = false;
      await assert.rejects(restoreWorkspaceBackup(backup.backupPath, destination, {
        skillSourceBackup: f.backupPolicy, nativeRestoreAuthority: generic,
      }), { code: "RECOVERY_AUTHORITY_REQUIRED" });
      assert.equal((await readdir(f.parent)).includes(stages[0]), true);
    }
  });
}

test("generic native restore authority is checked again immediately before NO-REPLACE publication", async t => {
  const f = await fixture(t), io = await transports(t, f.runtime.core, actor);
  assert.equal((await io.http(operation, f.input())).error, undefined);
  const backup = await f.backup(), destination = join(f.parent, "generic-revoked");
  let approvals = 0, publications = 0;
  await assert.rejects(restoreWorkspaceBackup(backup.backupPath, destination, {
    skillSourceBackup: f.backupPolicy,
    nativeRestoreAuthority: { actorId: actor.id, async authorize(request) {
      approvals++;
      return approvals >= 3 ? null : generic.authorize(request);
    } },
    async nativePublishNoReplace() { publications++; },
  }), { code: "AUTHORITY_REQUIRED" });
  assert.equal(approvals, 3); assert.equal(publications, 0);
  assert.throws(() => lstatSync(destination), { code: "ENOENT" });
  assert.equal((await readdir(f.parent)).filter(name => name.startsWith(".pkm-restore.")).length, 1);
});

test("source restore defaults unavailable and destination occupied during final native approval is never replaced", async t => {
  const f = await fixture(t), io = await transports(t, f.runtime.core, actor);
  assert.equal((await io.http(operation, f.input())).error, undefined);
  const backup = await f.backup(), destination = join(f.parent, "occupied-final");
  await assert.rejects(restoreWorkspaceBackup(backup.backupPath, destination, {
    nativeRestoreAuthority: generic,
  }), { code: "RECOVERY_AUTHORITY_REQUIRED" });
  assert.equal((await readdir(f.parent)).some(name => name.startsWith(".pkm-restore.")), false);
  f.state.occupyFinal = true;
  await assert.rejects(restoreWorkspaceBackup(backup.backupPath, destination, {
    skillSourceBackup: f.backupPolicy, nativeRestoreAuthority: generic,
  }), { code: "DESTINATION_EXISTS" });
  assert.deepEqual(await readdir(destination), ["sentinel"]);
  assert.equal(readFileSync(join(destination, "sentinel"), "utf8"), "never replace");
  assert.equal((await readdir(f.parent)).filter(name => name.startsWith(".pkm-restore.")).length, 1);
});
