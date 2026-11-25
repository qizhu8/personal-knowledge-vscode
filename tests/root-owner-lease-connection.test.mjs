import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { chmodSync, copyFileSync, linkSync, lstatSync, renameSync, symlinkSync, unlinkSync } from "node:fs";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { RootOwner } from "../dist/root-owner.js";
import { initialize, Storage } from "../dist/storage.js";

async function fixture(t) {
  const directory = resolve(".migration-test-work", `pinned-lease-${randomUUID()}`);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const root = await initialize(join(directory, "root"));
  const bootstrap = await Storage.open(root);
  await bootstrap.close();
  t.after(() => rm(directory, { recursive: true, force: true }));
  return { directory, root };
}
function database(root, work) {
  const db = new DatabaseSync(join(root, "core.sqlite"));
  try { return work(db); } finally { db.close(); }
}

test("one bound lease connection queries every assertion and observes real foreign WAL ownership changes", async t => {
  const { root } = await fixture(t);
  const owner = await RootOwner.open(root), connection = owner.leaseDatabase;
  const prepare = connection.prepare.bind(connection);
  let liveQueries = 0;
  connection.prepare = sql => {
    if (sql === "SELECT owner_id,fence,lease_until FROM native_runtime_owner WHERE singleton=1") liveQueries++;
    return prepare(sql);
  };
  owner.assertWorkspaceLease();
  owner.assertWorkspaceLease();
  assert.equal(liveQueries, 2);
  assert.equal(owner.leaseDatabase, connection);
  database(root, db => db.exec("UPDATE native_runtime_owner SET owner_id='foreign',fence=fence+1 WHERE singleton=1"));
  assert.throws(() => owner.assertWorkspaceLease(), { code: "STORAGE_UNAVAILABLE", effect: "unknown" });
  assert.equal(liveQueries, 3);
  const foreign = database(root, db => db.prepare("SELECT * FROM native_runtime_owner").get());
  await owner.close();
  assert.equal(connection.isOpen, false);
  assert.deepEqual(database(root, db => db.prepare("SELECT * FROM native_runtime_owner").get()), foreign);
});

test("database replacement with copied SQL owner fields is always CONFLICT and never rebinds the connection", async t => {
  const { directory, root } = await fixture(t);
  const owner = await RootOwner.open(root), connection = owner.leaseDatabase;
  const file = join(root, "core.sqlite"), saved = join(directory, "original.sqlite");
  database(root, db => db.exec("PRAGMA wal_checkpoint(TRUNCATE)"));
  renameSync(file, saved);
  copyFileSync(saved, file);
  assert.throws(() => owner.assertWorkspaceLease(), { code: "CONFLICT", effect: "unknown" });
  assert.equal(owner.leaseDatabase, connection);
  assert.throws(() => owner.assertWorkspaceLease(), { code: "CONFLICT" });
  await assert.rejects(owner.withReadScope(() => assert.fail("Replaced database cannot authorize a read.")), { code: "CONFLICT" });
  unlinkSync(file);
  renameSync(saved, file);
  assert.throws(() => owner.assertWorkspaceLease(), { code: "CONFLICT" });
  await owner.close();
  assert.equal(connection.isOpen, false);
});

test("file symlink/link-count/permission and parent permission drift revoke the persistent connection", { skip: process.platform !== "linux" }, async t => {
  for (const kind of ["symlink", "link", "file-mode", "wal-mode", "root-mode", "parent-mode"]) {
    const { directory, root } = await fixture(t);
    const owner = await RootOwner.open(root);
    const file = join(root, "core.sqlite"), saved = join(directory, "saved.sqlite");
    const permissionPath = kind === "parent-mode" ? directory : kind === "root-mode" ? root
      : kind === "wal-mode" ? `${file}-wal` : file;
    const mode = lstatSync(permissionPath).mode & 0o777;
    if (kind === "symlink") { renameSync(file, saved); symlinkSync(saved, file); }
    if (kind === "link") linkSync(file, saved);
    if (kind.endsWith("-mode")) chmodSync(permissionPath, 0);
    try { assert.throws(() => owner.assertWorkspaceLease(), { code: "CONFLICT", effect: "unknown" }); }
    finally {
      if (kind === "symlink") { unlinkSync(file); renameSync(saved, file); }
      if (kind === "link") unlinkSync(saved);
      if (kind.endsWith("-mode")) chmodSync(permissionPath, mode);
    }
    assert.throws(() => owner.assertWorkspaceLease(), { code: "CONFLICT" });
    await owner.close();
  }
});

test("fresh post-query file pins deny permission drift during a real live SQL assertion", { skip: process.platform !== "linux" }, async t => {
  const { root } = await fixture(t), owner = await RootOwner.open(root);
  const file = join(root, "core.sqlite"), mode = lstatSync(file).mode & 0o777;
  const connection = owner.leaseDatabase, prepare = connection.prepare.bind(connection);
  let armed = true;
  connection.prepare = sql => {
    const statement = prepare(sql);
    if (armed && sql === "SELECT owner_id,fence,lease_until FROM native_runtime_owner WHERE singleton=1") {
      const get = statement.get;
      statement.get = function (...args) { const result = get.apply(this, args); armed = false; chmodSync(file, 0); return result; };
    }
    return statement;
  };
  try { assert.throws(() => owner.assertWorkspaceLease(), { code: "CONFLICT" }); }
  finally { chmodSync(file, mode); await owner.close(); }
});

test("opening connection pre/post file pins reject an actual path swap before ownership publication", async t => {
  for (const restoreBeforeReturn of [false, true]) {
    const { directory, root } = await fixture(t);
    const file = join(root, "core.sqlite"), saved = join(directory, "opening-original.sqlite");
    const connect = RootOwner.prototype.connectNative;
    let armed = true;
    RootOwner.prototype.connectNative = function () {
      if (!armed || this.workspaceRoot() !== root) return connect.call(this);
      armed = false;
      if (restoreBeforeReturn) {
        renameSync(file, saved); copyFileSync(saved, file);
        const connection = connect.call(this);
        unlinkSync(file); renameSync(saved, file);
        return connection;
      }
      const connection = connect.call(this);
      renameSync(file, saved); copyFileSync(saved, file);
      return connection;
    };
    try { await assert.rejects(Storage.open(root), { code: "CONFLICT" }); }
    finally { RootOwner.prototype.connectNative = connect; }
    const fence = await import("../dist/linux-root-writer-fence.js");
    const reopened = await fence.acquireLinuxRootWriterFence(root, 1000);
    await reopened.release();
  }
});

test("owned lease connection survives failed drain and closes only after verified cleanup", async t => {
  const { root } = await fixture(t), owner = await RootOwner.open(root), connection = owner.leaseDatabase;
  let drained = false;
  owner.retainResource({ release() { if (!drained) throw new Error("not drained"); } });
  await assert.rejects(owner.close(), /not drained/);
  assert.equal(connection.isOpen, true);
  drained = true;
  await owner.close();
  assert.equal(connection.isOpen, false);
  await assert.rejects(owner.withReadScope(() => assert.fail("Closed connection cannot republish reads.")));
});

test("unexpected lease read transactions cannot hide a real foreign takeover behind an old WAL snapshot", async t => {
  const { root } = await fixture(t), owner = await RootOwner.open(root), connection = owner.leaseDatabase;
  connection.exec("BEGIN DEFERRED");
  connection.prepare("SELECT owner_id FROM native_runtime_owner").get();
  database(root, db => db.exec("UPDATE native_runtime_owner SET owner_id='foreign',fence=fence+1 WHERE singleton=1"));
  assert.throws(() => owner.assertWorkspaceLease(), { code: "TRANSACTION_BOUNDARY", effect: "unknown" });
  connection.exec("ROLLBACK");
  assert.throws(() => owner.assertWorkspaceLease(), { code: "TRANSACTION_BOUNDARY" });
  await owner.close();
});

test("canonical post-full qualifier uses actual DB proof and rejects changed durable state and scopes", async t => {
  const { root } = await fixture(t), owner = await RootOwner.open(root);
  const full = await owner.ensureFull();
  try {
    await owner.withReadScope(async scope => {
      assert.deepEqual(await owner.qualifyFreshLegacyReadScope(scope), { kind: "plain", database: "plain-v23" });
      database(root, db => db.prepare("INSERT INTO receipts VALUES(?,?,?,?,?,?)")
        .run(randomUUID(), "a".repeat(64), "{}", "writer", "knowledge.document.create", new Date().toISOString()));
      assert.deepEqual(await owner.qualifyFreshLegacyReadScope(scope), { kind: "full-required", reason: "durable-state" });
    });
    await assert.rejects(owner.qualifyFreshLegacyReadScope({
      root, workspaceId: await owner.workspaceId(), full, assertHeld() {},
    }), { code: "STORAGE_UNAVAILABLE" });
  } finally { await owner.close(); }
});

test("root validation is reused only inside one live scope with identical freshly read plain controls", async t => {
  const { directory, root } = await fixture(t), owner = await RootOwner.open(root);
  const marker = join(root, ".pkm-next-writer-fenced.json"), original = await readFile(marker);
  await owner.ensureFull();
  const validate = owner.validateReadScope.bind(owner);
  let validations = 0;
  t.mock.method(owner, "validateReadScope", async scope => { validations++; return validate(scope); });
  try {
    await owner.withReadScope(async scope => {
      assert.equal((await owner.qualifyFreshLegacyReadScope(scope)).kind, "plain");
      assert.equal((await owner.qualifyFreshLegacyReadScope(scope)).kind, "plain");
      assert.equal(validations, 1, "identical root controls need one canonical validation per scope");
      database(root, db => db.prepare("INSERT INTO receipts VALUES(?,?,?,?,?,?)")
        .run(randomUUID(), "a".repeat(64), "{}", "writer", "knowledge.document.create", new Date().toISOString()));
      assert.deepEqual(await owner.qualifyFreshLegacyReadScope(scope), { kind: "full-required", reason: "durable-state" });
      assert.equal(validations, 1, "reused filesystem proof must not cache the database classification");
      database(root, db => db.exec("DELETE FROM receipts"));
      await mkdir(join(root, "skills"), { mode: 0o700 });
      assert.equal((await owner.qualifyFreshLegacyReadScope(scope)).kind, "plain");
      assert.equal(validations, 2, "root membership changes must force canonical validation");
      await writeFile(marker, "{}");
      await assert.rejects(owner.qualifyFreshLegacyReadScope(scope), { code: "RECOVERY_REQUIRED" });
    });
    await writeFile(marker, original);
    const before = validations;
    await owner.withReadScope(async scope => {
      assert.equal((await owner.qualifyFreshLegacyReadScope(scope)).kind, "plain");
      assert.equal(validations, before + 1, "a different scope must never inherit validation authority");
      const saved = join(directory, "saved-writer-marker.json");
      renameSync(marker, saved);
      symlinkSync(saved, marker);
      try { await assert.rejects(owner.qualifyFreshLegacyReadScope(scope), { code: "RECOVERY_REQUIRED" }); }
      finally { unlinkSync(marker); renameSync(saved, marker); }
    });
  } finally { await writeFile(marker, original); await owner.close(); }
});
