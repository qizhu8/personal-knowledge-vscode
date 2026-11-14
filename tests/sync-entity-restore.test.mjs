import assert from "node:assert/strict";
import { test } from "node:test";
import { randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { applySyncPlan, initializeSyncApplyJournal, inspectSyncApplyRecovery, recoverSyncApply, serializeSyncApplyPlan } from "../dist/sync-apply.js";
import { initializeSyncPlanStore, SyncPlanStore } from "../dist/sync-plan-store.js";
import { syncPlanHash } from "../dist/sync-plan.js";
import { DATA_RUNTIME_DDL } from "../dist/data-runtime.js";
import { initializeRemoteRuntimeSchema, remoteRuntimePending } from "../dist/remote-runtime.js";
import { decideRemote, restoreActor, restoreFixture, sha256, writeLocal } from "./sync-entity-restore-fixtures.mjs";

function workspace(t, fixture) {
  const directory = resolve(import.meta.dirname, `.sync-entity-${randomUUID()}`);
  const root = join(directory, "knowledge"), database = join(directory, "journal.sqlite");
  mkdirSync(root, { recursive: true });
  writeLocal(root, fixture);
  let db, store;
  const open = () => {
    db = new DatabaseSync(database);
    initializeSyncPlanStore(db); initializeSyncApplyJournal(db);
    store = new SyncPlanStore(db);
  };
  open();
  const request = decideRemote(store, db, fixture);
  t.after(() => { db.close(); rmSync(directory, { recursive: true, force: true }); });
  return {
    root, request, get db() { return db; }, get store() { return store; },
    reopen() { db.close(); open(); },
  };
}
function assertRemote(root, fixture) {
  for (const file of fixture.remote) assert.deepEqual(readFileSync(join(root, file.path)), Buffer.from(file.contentBase64, "base64"));
}

test("missing remote dependency refuses the entire restore before any filesystem writes", t => {
  const fixture = restoreFixture({ missingMember: true });
  const f = workspace(t, fixture);
  assert.throws(() => serializeSyncApplyPlan(f.store, f.request), /Remote entity member is unavailable.*dependency/);
  assert.throws(() => applySyncPlan(f.store, f.request, f.root), /Remote entity member is unavailable/);
  assert.deepEqual(readdirSync(f.root), []);
  assert.equal(f.db.prepare("SELECT count(*) AS n FROM sync_apply_journal").get().n, 0);
});

test("partial local restore still validates unchanged remote sidecar bytes before any writes", t => {
  const fixture = restoreFixture({ partial: true, previousLocal: true, missingBytes: true });
  const f = workspace(t, fixture);
  const previous = fixture.local.map(file => readFileSync(join(f.root, file.path)));
  assert.throws(() => applySyncPlan(f.store, f.request, f.root), /Remote entity member has no staged bytes.*preview/);
  fixture.local.forEach((file, index) => assert.deepEqual(readFileSync(join(f.root, file.path)), previous[index]));
  assert.equal(existsSync(join(f.root, fixture.remote[2].path)), false);
  assert.equal(f.db.prepare("SELECT count(*) AS n FROM sync_apply_journal").get().n, 0);
});

test("invalid dependency is rejected before the body or attachment is restored", t => {
  const fixture = restoreFixture({ invalidDependency: true });
  const f = workspace(t, fixture);
  assert.throws(() => applySyncPlan(f.store, f.request, f.root), /not valid UTF-8/);
  assert.deepEqual(readdirSync(f.root), []);
});

for (const choice of ["local", "delete"]) {
  test(`incomplete remote restore does not block an explicit ${choice} entity decision`, t => {
    const fixture = restoreFixture({ missingMember: true, partial: true, previousLocal: true });
    const f = workspace(t, fixture);
    const session = f.store.get(fixture.sessionId);
    f.store.decide({
      sessionId: fixture.sessionId, operationId: randomUUID(), actorId: restoreActor.id,
      expectedRevision: session.revision, conflictId: session.plan.conflicts[0].id,
      choice, reason: "Retain the existing explicit local or deletion semantics.",
    });
    const receipt = applySyncPlan(f.store, f.request, f.root);
    if (choice === "local") {
      assert.equal(receipt.operations.length, 0);
      for (const file of fixture.local) assert.deepEqual(readFileSync(join(f.root, file.path)), Buffer.from(file.contentBase64, "base64"));
    } else {
      assert.equal(receipt.operations.length, fixture.local.length);
      assert.equal(receipt.tombstones.length, 1);
      for (const file of fixture.local) assert.equal(existsSync(join(f.root, file.path)), false);
    }
  });
}

test("remote selection restores the full pinned entity as one durable operation with byte-exact replay", t => {
  const fixture = restoreFixture();
  const f = workspace(t, fixture);
  const plan = serializeSyncApplyPlan(f.store, f.request);
  assert.equal(plan.actions.length, 3);
  assert.equal(plan.decisions.length, 1);
  const receipt = applySyncPlan(f.store, f.request, f.root);
  assertRemote(f.root, fixture);
  assert.equal(receipt.operations.length, 3);
  assert.equal(f.db.prepare("SELECT count(*) AS n FROM sync_apply_journal").get().n, 1);
  f.reopen();
  assert.deepEqual(applySyncPlan(f.store, f.request, f.root), receipt);
  assertRemote(f.root, fixture);
});

test("partial staging survives restart and rolls the entity forward under the same receipt identity", t => {
  const fixture = restoreFixture({ partial: true, previousLocal: true });
  const f = workspace(t, fixture);
  const sidecarBefore = readFileSync(join(f.root, fixture.local[0].path));
  assert.throws(() => applySyncPlan(f.store, f.request, f.root, {
    faultInjector: (_action, index) => { if (index === 0) throw new Error("synthetic interruption"); },
  }), /synthetic interruption/);
  const pending = f.db.prepare("SELECT apply_id,state FROM sync_apply_journal").get();
  assert.equal(pending.state, "prepared");
  assert.deepEqual(readFileSync(join(f.root, fixture.remote[0].path)), fixture.bytes[0]);
  assert.equal(existsSync(join(f.root, fixture.remote[2].path)), false);
  assert.deepEqual(readFileSync(join(f.root, fixture.local[0].path)), sidecarBefore);
  f.reopen();
  inspectSyncApplyRecovery(f.store, f.root);
  const receipts = recoverSyncApply(f.store, f.root);
  assert.equal(receipts.length, 1);
  assert.equal(receipts[0].applyId, pending.apply_id);
  assertRemote(f.root, fixture);
  assert.deepEqual(applySyncPlan(f.store, f.request, f.root), receipts[0]);
  assert.deepEqual(recoverSyncApply(f.store, f.root), []);
});

test("unchanged dependency tamper after interruption needs review without writing remaining members", t => {
  const fixture = restoreFixture({ partial: true, previousLocal: true });
  const f = workspace(t, fixture);
  assert.throws(() => applySyncPlan(f.store, f.request, f.root, {
    faultInjector: () => { throw new Error("synthetic interruption"); },
  }), /synthetic interruption/);
  const external = Buffer.from("external dependency bytes");
  writeFileSync(join(f.root, fixture.local[0].path), external);
  f.reopen();
  assert.throws(() => recoverSyncApply(f.store, f.root), /External write detected/);
  assert.equal(f.db.prepare("SELECT state FROM sync_apply_journal").get().state, "needs-review");
  assert.deepEqual(readFileSync(join(f.root, fixture.local[0].path)), external);
  assert.equal(existsSync(join(f.root, fixture.remote[2].path)), false);
  assert.throws(() => applySyncPlan(f.store, f.request, f.root), /requires manual review/);
});

test("mutation of an earlier member during apply cannot produce a completed group receipt", t => {
  const fixture = restoreFixture();
  const f = workspace(t, fixture);
  const external = Buffer.from("external mutation after the last write\n");
  assert.throws(() => applySyncPlan(f.store, f.request, f.root, {
    faultInjector: (_action, index) => {
      if (index === 2) writeFileSync(join(f.root, fixture.remote[0].path), external);
    },
  }), /External write detected before sync apply receipt/);
  assert.equal(f.db.prepare("SELECT state,receipt_json FROM sync_apply_journal").get().state, "needs-review");
  assert.equal(f.db.prepare("SELECT receipt_json FROM sync_apply_journal").get().receipt_json, null);
  assert.deepEqual(readFileSync(join(f.root, fixture.remote[0].path)), external);
});

test("journal identity tamper requires review before remaining entity members are written", t => {
  const fixture = restoreFixture({ partial: true, previousLocal: true });
  const f = workspace(t, fixture);
  assert.throws(() => applySyncPlan(f.store, f.request, f.root, {
    faultInjector: () => { throw new Error("synthetic interruption"); },
  }), /synthetic interruption/);
  f.db.prepare("UPDATE sync_apply_journal SET plan_hash=?").run("a".repeat(64));
  f.reopen();
  assert.throws(() => recoverSyncApply(f.store, f.root), /journal identity or source pins changed/);
  assert.equal(f.db.prepare("SELECT state FROM sync_apply_journal").get().state, "needs-review");
  assert.deepEqual(readFileSync(join(f.root, fixture.remote[0].path)), fixture.bytes[0]);
  assert.equal(existsSync(join(f.root, fixture.remote[2].path)), false);
});

test("remote recovery fence exempts only the matching local Core sync intent, never an orphan or foreign owner", t => {
  const fixture = restoreFixture();
  const f = workspace(t, fixture);
  assert.throws(() => applySyncPlan(f.store, f.request, f.root, {
    faultInjector: () => { throw new Error("synthetic interruption"); },
  }), /synthetic interruption/);
  f.db.exec("BEGIN IMMEDIATE");
  initializeRemoteRuntimeSchema(f.db);
  f.db.exec("COMMIT");
  assert.equal(remoteRuntimePending(f.db), true, "a journal without the local data schema remains fenced");
  f.db.exec(DATA_RUNTIME_DDL);
  assert.equal(remoteRuntimePending(f.db), true, "an orphan journal remains fenced");
  const plan = serializeSyncApplyPlan(f.store, f.request);
  const operationId = randomUUID();
  f.db.prepare("INSERT INTO data_runtime_intents VALUES(?,?,?,?,?,?,?,?,?)").run(
    operationId, "synthetic-workspace", f.root, restoreActor.id, "sync.apply",
    "a".repeat(64), JSON.stringify(f.request), JSON.stringify(plan), "b".repeat(64),
  );
  assert.equal(remoteRuntimePending(f.db), false, "matching local data recovery needs no remote transport");
  f.db.prepare("UPDATE data_runtime_intents SET actor_id=?").run("foreign-actor");
  assert.equal(remoteRuntimePending(f.db), true);
  f.db.prepare("UPDATE data_runtime_intents SET actor_id=?,root_path=?").run(restoreActor.id, `${f.root}/foreign`);
  assert.equal(remoteRuntimePending(f.db), true);
  f.db.prepare("UPDATE data_runtime_intents SET root_path=?,plan_json=?").run(f.root, JSON.stringify({ ...plan, sessionId: randomUUID() }));
  assert.equal(remoteRuntimePending(f.db), true);
});

test("a decision revision changed after interruption preserves staged bytes and fails closed", t => {
  const fixture = restoreFixture();
  const f = workspace(t, fixture);
  const staged = serializeSyncApplyPlan(f.store, f.request).actions[0];
  assert.throws(() => applySyncPlan(f.store, f.request, f.root, {
    faultInjector: () => { throw new Error("synthetic interruption"); },
  }), /synthetic interruption/);
  const session = f.store.get(fixture.sessionId);
  f.store.decide({
    sessionId: fixture.sessionId, operationId: randomUUID(), actorId: restoreActor.id,
    expectedRevision: session.revision, conflictId: session.plan.conflicts[0].id,
    choice: "delete", reason: "Changed review requires a new operation.",
  });
  assert.throws(() => recoverSyncApply(f.store, f.root), /decision or source pins changed/);
  assert.equal(f.db.prepare("SELECT state FROM sync_apply_journal").get().state, "needs-review");
  assert.deepEqual(readFileSync(join(f.root, staged.path)), Buffer.from(staged.contentBase64, "base64"));
  assert.equal(existsSync(join(f.root, fixture.remote[2].path)), false);
});

test("empty staged Markdown is valid and remains byte exact", t => {
  const fixture = restoreFixture();
  const empty = Buffer.alloc(0);
  fixture.remote[0].digest = sha256(empty);
  fixture.remote[0].contentBase64 = "";
  fixture.input.remote.manifest.files[0] = fixture.remote[0];
  const { manifest } = fixture.input.remote;
  fixture.input.remote.sha256 = syncPlanHash(manifest);
  const f = workspace(t, fixture);
  applySyncPlan(f.store, f.request, f.root);
  assertRemote(f.root, fixture);
});
