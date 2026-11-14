import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { mkdirSync, writeFileSync, readFileSync, rmSync, existsSync, symlinkSync, linkSync, renameSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";
import {
  LEGACY_SKILL_NATIVE_JOURNAL_DDL, scanNativeLegacySkillTree, executeNativeLegacySkillLifecycle,
  recoverNativeLegacySkillLifecycle, initializeNativeLegacySkillJournal, validateNativeLegacySkillJournalSchema,
} from "../dist/legacy-skill-lifecycle-native.js";
import { legacySkillManifestHash } from "../dist/legacy-skill-lifecycle.js";
import { renderProjection } from "../dist/domain/skill-routing-projection.js";

const hash = value => createHash("sha256").update(value).digest("hex");
const source = Buffer.from('---\nname: Source\ndescription: "User\'s task"\n---\nBody: never execute.\n');
const actor = { id: "native:actor", canWrite: true };
const binding = { workspaceId: "workspace", actorId: actor.id, sourceRootId: "source-id", destinationRootId: "target-id", targetId: "test", targetKind: "custom", extensionVersion: "test" };

function fixture(t) {
  const root = fileURLToPath(new URL(`legacy-skill-lifecycle-native-${randomUUID()}/`, import.meta.url));
  const roots = { source: join(root, "source"), destination: join(root, "target") };
  mkdirSync(join(roots.source, "System", "PKM"), { recursive: true });
  mkdirSync(roots.destination, { recursive: true });
  writeFileSync(join(roots.source, "System", "PKM", "PKM Skills.md"), source);
  const db = new DatabaseSync(join(root, "test.sqlite"));
  db.exec("BEGIN IMMEDIATE");
  initializeNativeLegacySkillJournal(db);
  db.exec("COMMIT");
  db.exec(`
    CREATE TABLE global_receipt (id TEXT PRIMARY KEY, fingerprint TEXT NOT NULL, result TEXT NOT NULL);
    CREATE TABLE other_pending (id TEXT PRIMARY KEY);`);
  t.after(() => { db.close(); rmSync(root, { recursive: true, force: true }); });
  let owned = true, retry = false, faultCommit = false, failAfterStage = false, ownerCalls = 0;
  const host = {
    assertOwner() { ownerCalls++; if (!owned || (failAfterStage && ownerCalls >= 5)) throw new Error("owner lost"); },
    authorize: (a, b) => a.id === b.actorId,
    authorizeRoots: (b, r) => b.sourceRootId === "source-id" && b.destinationRootId === "target-id" && r.source === roots.source && r.destination === roots.destination,
    approveRetry: () => retry,
    assertNoOtherPending(db) { assert.equal(db.isTransaction, true); if (db.prepare("SELECT id FROM other_pending").get()) throw new Error("other pending"); },
    globalReceipt(db, id) { assert.equal(db.isTransaction, true); const row = db.prepare("SELECT fingerprint,result FROM global_receipt WHERE id=?").get(id); return row ? { fingerprint: row.fingerprint, result: JSON.parse(row.result) } : null; },
    writeGlobalReceipt(db, id, fingerprint, result) {
      assert.equal(db.isTransaction, true);
      db.prepare("INSERT INTO global_receipt VALUES(?,?,?)").run(id, fingerprint, JSON.stringify(result));
      if (faultCommit) throw new Error("commit fault");
    },
  };
  const pin = hash("trusted-global-fingerprint");
  function input(action = "inject") {
    const scan = scanNativeLegacySkillTree(db, () => host.assertOwner(), roots);
    return { operationId: randomUUID(), action, sourceSha256: hash(scan.source),
      destinationSha256: scan.destination && hash(scan.destination), manifestSha256: legacySkillManifestHash(scan.manifest) };
  }
  return { root, roots, db, host, pin, input,
    allowRetry(value) { retry = value; }, commitFault(value) { faultCommit = value; },
    stageFault(value) { failAfterStage = value; ownerCalls = 0; }, owner(value) { owned = value; } };
}

test("native filesystem inject/remove exactly matches captured original projection and preserves unrelated assets", t => {
  const f = fixture(t);
  mkdirSync(join(f.roots.destination, "other"));
  writeFileSync(join(f.roots.destination, "other", "asset.bin"), "asset");
  const args = f.input(), result = executeNativeLegacySkillLifecycle(f.db, f.host, f.roots, actor, binding, args, f.pin);
  const file = join(f.roots.destination, "pkm-skills", "SKILL.md");
  assert.deepEqual(readFileSync(file), Buffer.from(renderProjection(source.toString(), { kind: "custom" }, "test").content));
  assert.equal(result.destinationSha256, hash(readFileSync(file)));
  const secondInstall = f.input();
  assert.equal(executeNativeLegacySkillLifecycle(f.db, f.host, f.roots, actor, binding, secondInstall, f.pin).destinationSha256, result.destinationSha256);
  assert.deepEqual(executeNativeLegacySkillLifecycle(f.db, f.host, f.roots, actor, binding, args, f.pin), result);
  assert.throws(() => executeNativeLegacySkillLifecycle(f.db, f.host, f.roots, actor, binding, args, "0".repeat(64)), { code: "CONFLICT" });
  writeFileSync(join(f.roots.destination, "pkm-skills", "preserve.dat"), "asset-in-router");
  const removal = f.input("remove");
  assert.equal(executeNativeLegacySkillLifecycle(f.db, f.host, f.roots, actor, binding, removal, f.pin).destinationSha256, null);
  assert.equal(existsSync(file), false);
  assert.equal(readFileSync(join(f.roots.destination, "pkm-skills", "preserve.dat"), "utf8"), "asset-in-router");
  assert.equal(readFileSync(join(f.roots.destination, "other", "asset.bin"), "utf8"), "asset");
  assert.equal(f.db.prepare("SELECT count(*) AS n FROM global_receipt").get().n, 3);
  assert.throws(() => f.db.exec("DELETE FROM legacy_skill_native_receipt"), /immutable/);
});

test("root, actor, stale pin, symlink, hardlink and other-pending admission are denied before writes", t => {
  const f = fixture(t), input = f.input();
  assert.throws(() => executeNativeLegacySkillLifecycle(f.db, f.host, f.roots, { ...actor, id: "wrong" }, binding, input, f.pin), { code: "ACCESS_DENIED" });
  assert.throws(() => executeNativeLegacySkillLifecycle(f.db, f.host, { ...f.roots, destination: f.root }, actor, binding, input, f.pin), { code: "ACCESS_DENIED" });
  f.db.exec("INSERT INTO other_pending VALUES('other')");
  assert.throws(() => executeNativeLegacySkillLifecycle(f.db, f.host, f.roots, actor, binding, input, f.pin), /other pending/);
  f.db.exec("DELETE FROM other_pending");
  writeFileSync(join(f.roots.destination, "changed"), "x");
  assert.throws(() => executeNativeLegacySkillLifecycle(f.db, f.host, f.roots, actor, binding, input, f.pin), { code: "CONFLICT" });
  symlinkSync("changed", join(f.roots.destination, "symlink"));
  assert.throws(() => scanNativeLegacySkillTree(f.db, () => f.host.assertOwner(), f.roots), /symbolic link/);
  rmSync(join(f.roots.destination, "symlink"));
  linkSync(join(f.roots.destination, "changed"), join(f.roots.destination, "hardlink"));
  assert.throws(() => scanNativeLegacySkillTree(f.db, () => f.host.assertOwner(), f.roots), /single-link/);
  assert.equal(f.db.prepare("SELECT count(*) AS n FROM legacy_skill_native_intent").get().n, 0);
});

test("before-state pending requires same ID and explicit retry; unknown and tamper remain fenced", t => {
  const f = fixture(t), input = f.input();
  f.stageFault(true);
  assert.throws(() => executeNativeLegacySkillLifecycle(f.db, f.host, f.roots, actor, binding, input, f.pin), /owner lost/);
  f.stageFault(false);
  assert.equal(f.db.prepare("SELECT count(*) AS n FROM legacy_skill_native_intent").get().n, 1);
  assert.throws(() => executeNativeLegacySkillLifecycle(f.db, f.host, f.roots, actor, binding, f.input(), f.pin), { code: "CONFLICT" });
  assert.throws(() => recoverNativeLegacySkillLifecycle(f.db, f.host, f.roots, actor, randomUUID(), f.pin), { code: "CONFLICT" });
  assert.throws(() => recoverNativeLegacySkillLifecycle(f.db, f.host, f.roots, actor, input.operationId, f.pin), { code: "ACCESS_DENIED" });
  f.allowRetry(true);
  mkdirSync(join(f.roots.destination, "pkm-skills"));
  writeFileSync(join(f.roots.destination, "pkm-skills", "SKILL.md"), "partial");
  assert.throws(() => recoverNativeLegacySkillLifecycle(f.db, f.host, f.roots, actor, input.operationId, f.pin), { code: "CONFLICT" });
  assert.equal(readFileSync(join(f.roots.destination, "pkm-skills", "SKILL.md"), "utf8"), "partial");
  rmSync(join(f.roots.destination, "pkm-skills"), { recursive: true });
  const row = f.db.prepare("SELECT plan_sha256 FROM legacy_skill_native_intent").get();
  f.db.prepare("UPDATE legacy_skill_native_intent SET plan_sha256=?").run("0".repeat(64));
  assert.throws(() => recoverNativeLegacySkillLifecycle(f.db, f.host, f.roots, actor, input.operationId, f.pin), { code: "CONFLICT" });
  f.db.prepare("UPDATE legacy_skill_native_intent SET plan_sha256=?").run(row.plan_sha256);
  const result = recoverNativeLegacySkillLifecycle(f.db, f.host, f.roots, actor, input.operationId, f.pin);
  assert.equal(result.operationId, input.operationId);
  assert.equal(f.db.prepare("SELECT count(*) AS n FROM legacy_skill_native_intent").get().n, 0);
});

test("SQL schema is exact, filesystem scan refuses transaction, and changed root identity remains fenced", t => {
  const f = fixture(t);
  validateNativeLegacySkillJournalSchema(f.db);
  f.db.exec("BEGIN IMMEDIATE");
  assert.throws(() => scanNativeLegacySkillTree(f.db, () => f.host.assertOwner(), f.roots), { code: "CONFLICT" });
  f.db.exec("ROLLBACK");
  assert.throws(() => initializeNativeLegacySkillJournal(f.db), { code: "CONFLICT" });
  const other = new DatabaseSync(":memory:");
  try {
    other.exec(LEGACY_SKILL_NATIVE_JOURNAL_DDL);
    other.exec("DROP TRIGGER legacy_skill_native_receipt_no_delete");
    assert.throws(() => validateNativeLegacySkillJournalSchema(other), { code: "CONFLICT" });
  } finally { other.close(); }
  const input = f.input();
  f.stageFault(true);
  assert.throws(() => executeNativeLegacySkillLifecycle(f.db, f.host, f.roots, actor, binding, input, f.pin), /owner lost/);
  f.stageFault(false); f.allowRetry(true);
  renameSync(f.roots.destination, `${f.roots.destination}-old`);
  mkdirSync(f.roots.destination);
  assert.throws(() => recoverNativeLegacySkillLifecycle(f.db, f.host, f.roots, actor, input.operationId, f.pin), { code: "CONFLICT" });
  assert.equal(f.db.prepare("SELECT count(*) AS n FROM legacy_skill_native_intent").get().n, 1);
});

test("after-effect commit rollback retains intent; approved recovery atomically finalizes receipt without reapplying", t => {
  const f = fixture(t), input = f.input();
  f.commitFault(true);
  assert.throws(() => executeNativeLegacySkillLifecycle(f.db, f.host, f.roots, actor, binding, input, f.pin), /commit fault/);
  assert.equal(f.db.prepare("SELECT count(*) AS n FROM global_receipt").get().n, 0);
  assert.equal(f.db.prepare("SELECT count(*) AS n FROM legacy_skill_native_intent").get().n, 1);
  const file = join(f.roots.destination, "pkm-skills", "SKILL.md"), bytes = readFileSync(file);
  f.commitFault(false); f.allowRetry(true);
  const result = recoverNativeLegacySkillLifecycle(f.db, f.host, f.roots, actor, input.operationId, f.pin);
  assert.deepEqual(readFileSync(file), bytes);
  assert.equal(result.destinationSha256, hash(bytes));
  assert.equal(f.db.prepare("SELECT count(*) AS n FROM global_receipt").get().n, 1);
  assert.equal(f.db.prepare("SELECT count(*) AS n FROM legacy_skill_native_intent").get().n, 0);
});
