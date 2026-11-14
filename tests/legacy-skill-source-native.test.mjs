import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";
import { legacySkillManifestHash } from "../dist/legacy-skill-lifecycle.js";
import { scanNativeLegacySkillSourceAndTarget } from "../dist/legacy-skill-lifecycle-native.js";
import { prepareLegacySkillSourceInstall } from "../dist/legacy-skill-source.js";
import { executeNativeLegacySkillSource, recoverNativeLegacySkillSource, inspectNativeLegacySkillSource,
  executeNativeLegacySkillSourceRemove, recoverNativeLegacySkillSourceRemove,
  initializeNativeLegacySkillSourceJournal, readNativeLegacySkillSourceHistory, validateNativeLegacySkillSourceHistory } from "../dist/legacy-skill-source-native.js";
import { adoptNativeLegacySkillSourceRoots, captureNativeLegacySkillSourceSnapshotDigest } from "../dist/legacy-skill-source-native.js";

const tests = fileURLToPath(new URL(".", import.meta.url));
const root = fileURLToPath(new URL("../legacy/", import.meta.url));
const bundle = readFileSync(join(root, "resources/pkm-skills-router.md"));
const legacy = readFileSync(join(root, "tests/fixtures/pkm-skills-router-1.7.2.md"));
const hash = value => createHash("sha256").update(value).digest("hex");
const actor = { id: "fixture-human", canWrite: true };
const binding = { workspaceId: "fixture-workspace", actorId: actor.id, sourceRootId: "fixture-source",
  destinationRootId: "fixture-target", targetId: "fixture", targetKind: "custom", extensionVersion: "test" };

function fixture() {
  const dir = mkdtempSync(join(tests, ".source-journal-"));
  const roots = { source: join(dir, "source"), destination: join(dir, "target") };
  mkdirSync(roots.source, { recursive: true }); mkdirSync(roots.destination);
  const db = new DatabaseSync(":memory:");
  db.exec("BEGIN"); initializeNativeLegacySkillSourceJournal(db);
  db.exec("CREATE TABLE fixture_global (operation_id TEXT PRIMARY KEY, fingerprint TEXT NOT NULL, result_json TEXT NOT NULL); COMMIT");
  let anchor = hash(JSON.stringify({ intents: [], receipts: [], history: [], adoptions: [] }));
  const flags = { revoked: false, failAdvance: false, failAdvanceAt: 0, advances: 0, approve: true, reconcile: true };
  const noSql = () => assert.equal(db.isTransaction, false);
  const sql = d => { assert.equal(d, db); assert.equal(db.isTransaction, true); };
  const host = {
    binding, roots, bundle, bundleSha256: hash(bundle), epoch: "fixture-epoch",
    assertOwner: noSql,
    authorize: () => { noSql(); return !flags.revoked; },
    approvePlan: () => { noSql(); return flags.approve; },
    approveRemovePlan: () => { noSql(); return flags.approve; },
    assertNoOtherPendingNative: noSql,
    checkAnchor: current => { noSql(); if (anchor !== current) throw new Error("anchor mismatch"); },
    advanceAnchor: (before, after) => {
      noSql(); assert.equal(anchor, before);
      flags.advances++;
      if (flags.failAdvance || flags.failAdvanceAt === flags.advances) { flags.failAdvance = false; throw new Error("anchor unavailable"); }
      anchor = after;
    },
    reconcileAnchor: current => { noSql(); if (!flags.reconcile) throw new Error("reconcile denied"); anchor = current; },
    reconcileRemoveAnchor: current => { noSql(); if (!flags.reconcile) throw new Error("reconcile denied"); anchor = current; },
    approveAdoption: () => { noSql(); return flags.approve; },
    reconcileAdoptionAnchor: current => { noSql(); if (!flags.reconcile) throw new Error("reconcile denied"); anchor = current; },
    bundleForDigest: digest => { noSql(); return digest === hash(bundle) ? bundle : undefined; },
    assertSqlOwner: sql, assertNoOtherPendingSql: sql,
    globalReceipt: (d, id) => {
      sql(d); const row = d.prepare("SELECT fingerprint,result_json FROM fixture_global WHERE operation_id=?").get(id);
      return row ? { fingerprint: row.fingerprint, result: JSON.parse(row.result_json) } : null;
    },
    writeGlobalReceipt: (d, id, fp, output) => {
      sql(d); d.prepare("INSERT INTO fixture_global VALUES(?,?,?)").run(id, fp, JSON.stringify(output));
    },
  };
  function request() {
    const scan = scanNativeLegacySkillSourceAndTarget(db, host.assertOwner, host.roots);
    return { operationId: randomUUID(), sourceSha256: scan.source && hash(scan.source), bundleSha256: hash(bundle),
      sourceManifestSha256: legacySkillManifestHash(scan.sourceManifest), destinationSha256: scan.destination && hash(scan.destination),
      destinationManifestSha256: legacySkillManifestHash(scan.destinationManifest) };
  }
  function removeRequest() {
    const { bundleSha256, ...input } = request();
    assert.ok(bundleSha256);
    return input;
  }
  return { dir, roots, db, host, flags, request, removeRequest, close: () => { db.close(); rmSync(dir, { recursive: true, force: true }); } };
}

test("absent source install persists exact planner output, replay, CAS and live authorization", () => {
  const f = fixture();
  try {
    const input = f.request(), scan = scanNativeLegacySkillSourceAndTarget(f.db, f.host.assertOwner, f.roots);
    const plan = prepareLegacySkillSourceInstall(binding, input, scan.source, bundle, scan.sourceManifest, scan.destination, scan.destinationManifest);
    assert.throws(() => executeNativeLegacySkillSource(f.db, undefined, actor, input), { code: "NOT_AVAILABLE" });
    const output = executeNativeLegacySkillSource(f.db, f.host, actor, input);
    assert.deepEqual(readFileSync(join(f.roots.source, "System/PKM/PKM Skills.md")), Buffer.from(plan.source.afterBase64, "base64"));
    assert.deepEqual(readFileSync(join(f.roots.destination, "pkm-skills/SKILL.md")), Buffer.from(plan.destinationAfterBase64, "base64"));
    assert.deepEqual(executeNativeLegacySkillSource(f.db, f.host, actor, input), output);
    assert.throws(() => executeNativeLegacySkillSource(f.db, f.host, actor, { ...input, destinationSha256: "0".repeat(64) }), { code: "CONFLICT" });
    assert.throws(() => executeNativeLegacySkillSource(f.db, f.host, actor, { ...input, operationId: randomUUID() }), { code: "CONFLICT" });
    f.flags.revoked = true;
    assert.throws(() => executeNativeLegacySkillSource(f.db, f.host, actor, input), { code: "ACCESS_DENIED" });
    f.flags.revoked = false;
    assert.equal(readNativeLegacySkillSourceHistory(f.db, f.host, actor).last.input.operationId, input.operationId);
    assert.throws(() => f.db.exec("DELETE FROM legacy_skill_source_native_history"), /immutable/);
    assert.throws(() => f.db.exec("UPDATE legacy_skill_source_native_receipt SET fingerprint='x'"), /immutable/);
  } finally { f.close(); }
});

test("remove intent fences partial unlink, unknown residue and authority revocation", () => {
  const f = fixture();
  try {
    const install = f.request();
    executeNativeLegacySkillSource(f.db, f.host, actor, install);
    const input = f.removeRequest(), projection = join(f.roots.destination, "pkm-skills/SKILL.md");
    const approve = f.host.approveRemovePlan;
    delete f.host.approveRemovePlan;
    assert.throws(() => executeNativeLegacySkillSourceRemove(f.db, f.host, actor, input), { code: "ACCESS_DENIED" });
    assert.ok(readFileSync(projection).length);
    f.host.approveRemovePlan = approve;
    f.flags.failAdvance = true;
    assert.throws(() => executeNativeLegacySkillSourceRemove(f.db, f.host, actor, input), { code: "RECOVERY_REQUIRED" });
    rmSync(projection);
    writeFileSync(join(f.roots.destination, "unknown"), "unknown");
    f.flags.approve = false;
    assert.throws(() => recoverNativeLegacySkillSourceRemove(f.db, f.host, actor, input));
    rmSync(join(f.roots.destination, "unknown"));
    f.flags.approve = true; f.flags.revoked = true;
    assert.throws(() => recoverNativeLegacySkillSourceRemove(f.db, f.host, actor, input), { code: "ACCESS_DENIED" });
    f.flags.revoked = false;
    const removed = recoverNativeLegacySkillSourceRemove(f.db, f.host, actor, input);
    assert.equal(removed.destinationSha256, null);
    assert.throws(() => readFileSync(projection), { code: "ENOENT" });
    assert.throws(() => readFileSync(join(f.roots.destination, "pkm-skills")), { code: "ENOENT" });
    assert.deepEqual(readFileSync(join(f.roots.source, "System/PKM/PKM Skills.md")), bundle);
    const next = f.request();
    executeNativeLegacySkillSource(f.db, f.host, actor, next);
    assert.deepEqual(executeNativeLegacySkillSourceRemove(f.db, f.host, actor, input), removed);
    writeFileSync(projection, "tampered");
    assert.throws(() => executeNativeLegacySkillSourceRemove(f.db, f.host, actor, input), { code: "CONFLICT" });
  } finally { f.close(); }
});

test("legacy upgrade and managed modified projection use exact original planner", () => {
  const f = fixture();
  try {
    mkdirSync(join(f.roots.source, "System/PKM"), { recursive: true });
    mkdirSync(join(f.roots.destination, "pkm-skills"));
    writeFileSync(join(f.roots.source, "System/PKM/PKM Skills.md"), legacy);
    writeFileSync(join(f.roots.destination, "pkm-skills/SKILL.md"), '---\nname: pkm-skills\n---\n<!-- pkm-managed {"schema":1,"routerVersion":"1.0.0"} -->\nmodified\n');
    const input = f.request(), scan = scanNativeLegacySkillSourceAndTarget(f.db, f.host.assertOwner, f.roots);
    const plan = prepareLegacySkillSourceInstall(binding, input, scan.source, bundle, scan.sourceManifest, scan.destination, scan.destinationManifest);
    assert.equal(plan.source.transition, "upgrade");
    executeNativeLegacySkillSource(f.db, f.host, actor, input);
    assert.deepEqual(readFileSync(join(f.roots.source, "System/PKM/PKM Skills.md")), bundle);
    assert.deepEqual(readFileSync(join(f.roots.destination, "pkm-skills/SKILL.md")), Buffer.from(plan.destinationAfterBase64, "base64"));
  } finally { f.close(); }
});

test("anchor failure and partial directory effects require explicit approved recovery", () => {
  const f = fixture();
  try {
    const input = f.request();
    f.flags.failAdvance = true;
    assert.throws(() => executeNativeLegacySkillSource(f.db, f.host, actor, input), { code: "RECOVERY_REQUIRED" });
    assert.throws(() => executeNativeLegacySkillSource(f.db, f.host, actor, input), /anchor mismatch/);
    mkdirSync(join(f.roots.source, "System"));
    f.flags.approve = false;
    assert.throws(() => recoverNativeLegacySkillSource(f.db, f.host, actor, input), { code: "ACCESS_DENIED" });
    f.flags.approve = true;
    const output = recoverNativeLegacySkillSource(f.db, f.host, actor, input);
    assert.deepEqual(executeNativeLegacySkillSource(f.db, f.host, actor, input), output);
    assert.equal(inspectNativeLegacySkillSource(f.db, f.host, actor), null);
  } finally { f.close(); }
});

test("unknown staging, symlinks, altered history and root replacement fail closed", () => {
  const f = fixture();
  try {
    const input = f.request(); f.flags.failAdvance = true;
    assert.throws(() => executeNativeLegacySkillSource(f.db, f.host, actor, input), { code: "RECOVERY_REQUIRED" });
    mkdirSync(join(f.roots.source, "System"));
    writeFileSync(join(f.roots.source, "System", `.pkm-skill-source-${input.operationId}`), "partial");
    assert.throws(() => recoverNativeLegacySkillSource(f.db, f.host, actor, input), { code: "INVALID_ARGUMENT" });
    rmSync(join(f.roots.source, "System"), { recursive: true });
    symlinkSync(f.roots.destination, join(f.roots.source, "System"));
    assert.throws(() => recoverNativeLegacySkillSource(f.db, f.host, actor, input), { code: "CONFLICT" });
    rmSync(join(f.roots.source, "System"));
    renameSync(f.roots.source, join(f.dir, "old-source")); mkdirSync(f.roots.source);
    assert.throws(() => recoverNativeLegacySkillSource(f.db, f.host, actor, input), { code: "CONFLICT" });
    assert.throws(() => validateNativeLegacySkillSourceHistory([{ sequence: 1, operation_id: input.operationId,
      plan_json: "{}", previous_sha256: "0".repeat(64), entry_sha256: "0".repeat(64) }], () => bundle), { code: "CONFLICT" });
  } finally { f.close(); }
});

test("post-commit anchor failure demands approved exact replay and history rejects a rehashed forgery", () => {
  const f = fixture();
  try {
    const input = f.request(); f.flags.failAdvanceAt = 2;
    assert.throws(() => executeNativeLegacySkillSource(f.db, f.host, actor, input), { code: "RECOVERY_REQUIRED" });
    f.flags.approve = false;
    assert.throws(() => recoverNativeLegacySkillSource(f.db, f.host, actor, input), { code: "ACCESS_DENIED" });
    f.flags.approve = true;
    const output = recoverNativeLegacySkillSource(f.db, f.host, actor, input);
    assert.deepEqual(executeNativeLegacySkillSource(f.db, f.host, actor, input), output);
    const rows = f.db.prepare("SELECT * FROM legacy_skill_source_native_history ORDER BY sequence").all();
    const row = { ...rows[0] }, plan = JSON.parse(row.plan_json);
    plan.source.afterBase64 = Buffer.from("forged").toString("base64");
    row.plan_json = JSON.stringify(plan);
    row.entry_sha256 = hash(JSON.stringify({ sequence: row.sequence, operationId: row.operation_id, epoch: row.epoch,
      pinsJson: row.pins_json, planJson: row.plan_json, previous: row.previous_sha256 }));
    assert.throws(() => validateNativeLegacySkillSourceHistory([row], () => bundle), { code: "CONFLICT" });
    writeFileSync(join(f.roots.source, "System/PKM/PKM Skills.md"), "changed");
    assert.throws(() => readNativeLegacySkillSourceHistory(f.db, f.host, actor), { code: "CONFLICT" });
  } finally { f.close(); }
});

test("recovery continues an exact source-after and destination-before state and chains history", () => {
  const f = fixture();
  try {
    const input = f.request(); f.flags.failAdvance = true;
    assert.throws(() => executeNativeLegacySkillSource(f.db, f.host, actor, input), { code: "RECOVERY_REQUIRED" });
    const row = f.db.prepare("SELECT plan_json FROM legacy_skill_source_native_intent").get();
    const plan = JSON.parse(row.plan_json);
    mkdirSync(join(f.roots.source, "System/PKM"), { recursive: true });
    writeFileSync(join(f.roots.source, "System/PKM/PKM Skills.md"), Buffer.from(plan.source.afterBase64, "base64"));
    const output = recoverNativeLegacySkillSource(f.db, f.host, actor, input);
    assert.equal(output.sourceSha256, hash(bundle));
    const second = f.request();
    executeNativeLegacySkillSource(f.db, f.host, actor, second);
    assert.equal(f.db.prepare("SELECT COUNT(*) AS n FROM legacy_skill_source_native_history").get().n, 2);
    assert.equal(readNativeLegacySkillSourceHistory(f.db, f.host, actor).last.input.operationId, second.operationId);
  } finally { f.close(); }
});

function copiedAdoption(f, name) {
  const oldRoots = f.host.roots;
  const old = scanNativeLegacySkillSourceAndTarget(f.db, f.host.assertOwner, oldRoots);
  const historyHead = readNativeLegacySkillSourceHistory(f.db, f.host, actor).head;
  const snapshotDigest = captureNativeLegacySkillSourceSnapshotDigest(f.db);
  const newRoots = { source: join(f.dir, `${name}-source`), destination: join(f.dir, `${name}-target`) };
  cpSync(oldRoots.source, newRoots.source, { recursive: true });
  cpSync(oldRoots.destination, newRoots.destination, { recursive: true });
  const copied = scanNativeLegacySkillSourceAndTarget(f.db, f.host.assertOwner, newRoots);
  f.host.roots = newRoots;
  return { oldRoots, newRoots, oldPins: old.pins, newPins: copied.pins, binding, historyHead, snapshotDigest,
    sourceManifest: old.sourceManifest, destinationManifest: old.destinationManifest };
}

test("authorized copied root adoption preserves receipts, permits a new install and a second adoption", () => {
  const f = fixture();
  try {
    const first = f.request(), initial = executeNativeLegacySkillSource(f.db, f.host, actor, first);
    const oldHistory = f.db.prepare("SELECT * FROM legacy_skill_source_native_history").all();
    const oldReceipt = f.db.prepare("SELECT * FROM legacy_skill_source_native_receipt").all();
    const request = copiedAdoption(f, "copy1");
    f.flags.approve = false;
    assert.throws(() => adoptNativeLegacySkillSourceRoots(f.db, f.host, actor, request), { code: "ACCESS_DENIED" });
    f.flags.approve = true;
    assert.throws(() => adoptNativeLegacySkillSourceRoots(f.db, f.host, actor, { ...request, snapshotDigest: "0".repeat(64) }), { code: "CONFLICT" });
    adoptNativeLegacySkillSourceRoots(f.db, f.host, actor, request);
    assert.deepEqual(f.db.prepare("SELECT * FROM legacy_skill_source_native_history").all(), oldHistory);
    assert.deepEqual(f.db.prepare("SELECT * FROM legacy_skill_source_native_receipt").all(), oldReceipt);
    assert.deepEqual(executeNativeLegacySkillSource(f.db, f.host, actor, first), initial);
    const second = f.request();
    executeNativeLegacySkillSource(f.db, f.host, actor, second);
    const next = copiedAdoption(f, "copy2");
    adoptNativeLegacySkillSourceRoots(f.db, f.host, actor, next);
    assert.equal(readNativeLegacySkillSourceHistory(f.db, f.host, actor, { verifyDestination: true }).last.input.operationId, second.operationId);
    assert.deepEqual(executeNativeLegacySkillSource(f.db, f.host, actor, first), initial);
    assert.throws(() => f.db.exec("UPDATE legacy_skill_source_native_adoption SET request_json='{}'"), /immutable/);
  } finally { f.close(); }
});

test("adoption rejects partial copies, pending intents and unanchored retry without explicit reconciliation", () => {
  const f = fixture();
  try {
    const first = f.request();
    executeNativeLegacySkillSource(f.db, f.host, actor, first);
    const request = copiedAdoption(f, "copy");
    const projection = join(f.host.roots.destination, "pkm-skills/SKILL.md");
    const projectionBytes = readFileSync(projection);
    writeFileSync(projection, "partial copy");
    assert.throws(() => adoptNativeLegacySkillSourceRoots(f.db, f.host, actor, request), { code: "CONFLICT" });
    writeFileSync(projection, projectionBytes);
    f.flags.failAdvance = true;
    assert.throws(() => adoptNativeLegacySkillSourceRoots(f.db, f.host, actor, request), { code: "RECOVERY_REQUIRED" });
    assert.throws(() => executeNativeLegacySkillSource(f.db, f.host, actor, first), /anchor mismatch/);
    f.flags.reconcile = false;
    assert.throws(() => adoptNativeLegacySkillSourceRoots(f.db, f.host, actor, request), /reconcile denied/);
    f.flags.reconcile = true;
    adoptNativeLegacySkillSourceRoots(f.db, f.host, actor, request);
    const second = f.request(); f.flags.failAdvance = true;
    assert.throws(() => executeNativeLegacySkillSource(f.db, f.host, actor, second), { code: "RECOVERY_REQUIRED" });
    assert.throws(() => adoptNativeLegacySkillSourceRoots(f.db, f.host, actor, request), { code: "RECOVERY_REQUIRED" });
  } finally { f.close(); }
});

test("destination verification is opt-in for independently approved changed projection", () => {
  const f = fixture();
  try {
    executeNativeLegacySkillSource(f.db, f.host, actor, f.request());
    const path = join(f.host.roots.destination, "pkm-skills/SKILL.md");
    writeFileSync(path, '---\nname: pkm-skills\n---\n<!-- pkm-managed {"schema":1,"routerVersion":"1.0.0"} -->\nmodified\n');
    assert.throws(() => readNativeLegacySkillSourceHistory(f.db, f.host, actor, { verifyDestination: true }), { code: "CONFLICT" });
    readNativeLegacySkillSourceHistory(f.db, f.host, actor);
    executeNativeLegacySkillSource(f.db, f.host, actor, f.request());
    readNativeLegacySkillSourceHistory(f.db, f.host, actor, { verifyDestination: true });
  } finally { f.close(); }
});

test("tampered root-adoption record is rejected by the independent anchor", () => {
  const f = fixture();
  try {
    const input = f.request();
    executeNativeLegacySkillSource(f.db, f.host, actor, input);
    const request = copiedAdoption(f, "copy");
    adoptNativeLegacySkillSourceRoots(f.db, f.host, actor, request);
    f.db.exec("DROP TRIGGER legacy_skill_source_adoption_no_update");
    const row = f.db.prepare("SELECT * FROM legacy_skill_source_native_adoption").get();
    const forged = JSON.parse(row.request_json);
    forged.oldRoots.source += "-forged";
    const requestJson = JSON.stringify(forged);
    const entry = hash(JSON.stringify({ sequence: row.sequence, historySequence: row.history_sequence,
      requestJson, previous: row.previous_sha256 }));
    f.db.prepare("UPDATE legacy_skill_source_native_adoption SET request_json=?,entry_sha256=?").run(requestJson, entry);
    assert.throws(() => executeNativeLegacySkillSource(f.db, f.host, actor, input), /anchor mismatch/);
  } finally { f.close(); }
});

test("physical staging adoption records logical roots and survives atomic directory publication", () => {
  const f = fixture();
  try {
    const input = f.request(), output = executeNativeLegacySkillSource(f.db, f.host, actor, input);
    const copied = copiedAdoption(f, "stage");
    const physicalRoots = copied.newRoots;
    const newRoots = { source: join(f.dir, "published-source"), destination: join(f.dir, "published-target") };
    const request = { ...copied, newRoots, physicalRoots };
    f.host.approveAdoption = (_actor, value) => {
      assert.equal(f.db.isTransaction, false);
      try { assert.deepEqual(value, request); return true; } catch { return false; }
    };
    assert.throws(() => adoptNativeLegacySkillSourceRoots(f.db, f.host, actor,
      { ...request, physicalRoots: { ...physicalRoots, source: join(f.dir, "other-stage") } }), { code: "CONFLICT" });
    assert.throws(() => adoptNativeLegacySkillSourceRoots(f.db, f.host, actor,
      { ...request, newRoots: { ...newRoots, source: join(f.dir, "other-final") } }), { code: "ACCESS_DENIED" });
    assert.throws(() => adoptNativeLegacySkillSourceRoots(f.db, f.host, actor,
      { ...request, newRoots: { source: f.dir, destination: join(f.dir, "nested") } }), { code: "INVALID_ARGUMENT" });
    assert.throws(() => adoptNativeLegacySkillSourceRoots(f.db, f.host, actor,
      { ...request, newPins: { ...request.newPins, source: { dev: "0", ino: "0" } } }), { code: "ACCESS_DENIED" });
    f.flags.failAdvance = true;
    assert.throws(() => adoptNativeLegacySkillSourceRoots(f.db, f.host, actor, request), { code: "RECOVERY_REQUIRED" });
    assert.throws(() => executeNativeLegacySkillSource(f.db, f.host, actor, input), /anchor mismatch/);
    adoptNativeLegacySkillSourceRoots(f.db, f.host, actor, request);
    const rows = f.db.prepare("SELECT * FROM legacy_skill_source_native_history ORDER BY sequence").all();
    const adoptions = f.db.prepare("SELECT * FROM legacy_skill_source_native_adoption ORDER BY sequence").all();
    const verified = validateNativeLegacySkillSourceHistory(rows, () => bundle, adoptions);
    assert.deepEqual(verified.lastRoots, newRoots);
    assert.deepEqual(verified.lastPins, request.newPins);
    assert.throws(() => readNativeLegacySkillSourceHistory(f.db, f.host, actor), { code: "CONFLICT" });
    // Publication belongs to the native coordinator, not the adoption engine.
    renameSync(physicalRoots.source, newRoots.source);
    renameSync(physicalRoots.destination, newRoots.destination);
    f.host.roots = newRoots;
    assert.deepEqual(executeNativeLegacySkillSource(f.db, f.host, actor, input), output);
    executeNativeLegacySkillSource(f.db, f.host, actor, f.request());
    readNativeLegacySkillSourceHistory(f.db, f.host, actor, { verifyDestination: true });
  } finally { f.close(); }
});
