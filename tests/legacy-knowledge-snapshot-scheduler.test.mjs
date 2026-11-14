import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { test } from "node:test";
import { initialize, Storage } from "../dist/storage.js";
import { admitLegacyKnowledgeSnapshots, legacyKnowledgeSnapshot, legacyKnowledgeSnapshotTiming,
  reconcileLegacyKnowledgeSnapshots, verifyLegacyKnowledgeSnapshots } from "../dist/legacy-knowledge-snapshots.js";
import { inspectLegacyKnowledgeSnapshotSchedulerEnrollment } from "../dist/legacy-knowledge-snapshots.js";
import { createAdmittedLegacyKnowledgeSnapshotScheduler, createLegacyKnowledgeSnapshotScheduler } from "../dist/legacy-knowledge-snapshot-scheduler.js";
import { verifySnapshotSchedule } from "../dist/legacy-knowledge-snapshot-scheduler-state.js";
import { createNativeRuntime } from "../dist/native-runtime.js";
import { createWorkspaceBackup, restoreWorkspaceBackup } from "../dist/workspace-backup.js";
import { nativeRestoreAuthority } from "./host-composition-legacy-batch16-restore-fixture.mjs";

const actor = { id: "mcp:external", canWrite: true };
async function fixture(t, options = {}) {
  const root = resolve(`.snapshot-scheduler-${randomUUID()}`);
  await mkdir(root);
  const data = await initialize(join(root, "data")), stores = [], schedulers = [];
  t.after(async () => {
    for (const scheduler of schedulers) { try { await scheduler.close(); } catch {} }
    for (const storage of stores) await storage.close();
    await rm(root, { recursive: true, force: true });
  });
  const open = async (target = data, options) => { const storage = await Storage.open(target, options); stores.push(storage); return storage; };
  const storage = await open(), workspaceId = await storage.workspaceId();
  await writeFile(join(data, "notes/Active.md"), "---\r\ntitle: Active\r\n---\r\nExact scheduled snapshot.\r\n");
  const authority = { authorize: binding => binding.workspaceId === workspaceId && binding.workspaceRoot === data
    && binding.privateGitRoot === join(data, "packages/knowledge-snapshots/repository.git")
    && binding.actorId === actor.id && binding.authorityId === "fixture-actual-isolated-scheduler" };
  await admitLegacyKnowledgeSnapshots(storage, actor, { authorityId: "fixture-actual-isolated-scheduler",
    allowedTools: ["knowledge_snapshot_status", "knowledge_snapshot_create", "knowledge_snapshot_configure",
      "knowledge_snapshot_restore_preview", "knowledge_snapshot_restore_apply"], authorize: authority.authorize });
  let time = Date.now();
  const now = () => new Date(time);
  const make = (store = storage, extra = {}) => {
    const scheduler = createLegacyKnowledgeSnapshotScheduler(store, actor, authority, { now, ...options, ...extra });
    schedulers.push(scheduler); return scheduler;
  };
  const scheduler = make();
  await scheduler.start();
  const invoke = (tool, args = {}, id = randomUUID(), runtime = scheduler, store = storage) =>
    legacyKnowledgeSnapshot(store, actor, { tool: `knowledge_snapshot_${tool}`, args, operationId: id }, runtime.host);
  return { root, data, storage, open, make, scheduler, invoke, authority,
    setTime: value => { time = value instanceof Date ? value.getTime() : value; } };
}
test("isolated scheduler installs a durable actual daily job, creates original Git at due time, records next occurrence and disables", async t => {
  const f = await fixture(t);
  const configured = await f.invoke("configure", { enabled: true, local_time: "17:00", timezone: "America/Los_Angeles" });
  const version = f.storage.connectNative();
  try { assert.equal(version.prepare("PRAGMA user_version").get().user_version, 26); } finally { version.close(); }
  assert.equal((await f.scheduler.status()).dueUtc, configured.next_run_utc);
  f.setTime(Date.parse(configured.next_run_utc) - 1);
  await f.scheduler.tick(); assert.equal((await f.invoke("status")).tags.length, 0);
  f.setTime(Date.parse(configured.next_run_utc) + 1);
  await Promise.all([f.scheduler.tick(), f.scheduler.tick()]);
  const status = await f.invoke("status");
  assert.equal(status.tags.length, 1); assert.equal(status.latest.reason, "scheduled-daily");
  const state = await f.scheduler.status();
  assert.equal(state.pending, undefined); assert(Date.parse(state.dueUtc) > Date.parse(configured.next_run_utc));
  assert.equal(await readFile(join(f.data, "notes/Active.md"), "utf8"), "---\r\ntitle: Active\r\n---\r\nExact scheduled snapshot.\r\n");
  await f.invoke("configure", { enabled: false });
  f.setTime(Date.parse(state.dueUtc) + 86400000 * 7);
  await f.scheduler.tick();
  assert.equal((await f.invoke("status")).tags.length, 1);
  assert.equal((await f.scheduler.status()).configuration.enabled, false);
});

for (const phase of ["claimed", "created"]) {
  test(`scheduler ${phase} restart replays one fixed occurrence exactly once after missed persistent daily deadlines`, async t => {
    let crash = true;
    const f = await fixture(t, { checkpoint: point => { if (point === phase && crash) { crash = false; throw new Error(`fault-${phase}`); } } });
    const configured = await f.invoke("configure");
    f.setTime(Date.parse(configured.next_run_utc) + 86400000 * 4);
    await assert.rejects(f.scheduler.tick(), new RegExp(`fault-${phase}`));
    const pending = (await f.scheduler.status()).pending;
    assert(pending?.operationId);
    await f.scheduler.close(); await f.storage.close();
    const storage = await f.open(), scheduler = f.make(storage, { checkpoint: undefined });
    await scheduler.start(); await scheduler.tick(); await scheduler.drain();
    const status = await f.invoke("status", {}, randomUUID(), scheduler, storage);
    assert.equal(status.tags.length, 1); assert.equal(status.latest.reason, "scheduled-daily");
    const db = storage.connectNative();
    try {
      verifyLegacyKnowledgeSnapshots(db, f.data);
      assert.equal(db.prepare("SELECT count(*) n FROM legacy_knowledge_snapshot_events WHERE operation_id=?").get(pending.operationId).n, 1);
      const state = verifySnapshotSchedule(db);
      assert.equal(state.pending, undefined); assert(Date.parse(state.dueUtc) > Date.parse(configured.next_run_utc) + 86400000 * 4);
    } finally { db.close(); }
  });
}

test("disabled or reconfigured claimed jobs are cancelled without granting an obsolete occurrence execution", async t => {
  let pause = true;
  const f = await fixture(t, { checkpoint: phase => { if (phase === "claimed" && pause) { pause = false; throw new Error("pause-claimed"); } } });
  const configured = await f.invoke("configure");
  f.setTime(Date.parse(configured.next_run_utc) + 1);
  await assert.rejects(f.scheduler.tick(), /pause-claimed/);
  await f.invoke("configure", { enabled: false });
  await f.scheduler.tick();
  assert.equal((await f.invoke("status")).tags.length, 0);
  assert.equal((await f.scheduler.status()).pending, undefined);
});

test("native timer fires actual original Git work and drain prevents later callbacks without global service registration", async t => {
  const f = await fixture(t);
  const configured = await f.invoke("configure", { local_time: "17:00", timezone: "UTC" });
  const base = Date.parse(configured.next_run_utc) - 100, real = Date.now();
  await f.scheduler.close();
  const scheduler = f.make(f.storage, { now: () => new Date(base + Date.now() - real) });
  await scheduler.start();
  const deadline = Date.now() + 10000;
  while (!(await f.invoke("status", {}, randomUUID(), scheduler)).tags.length && Date.now() < deadline)
    await new Promise(resolve => setTimeout(resolve, 50));
  await scheduler.drain();
  assert.equal((await f.invoke("status", {}, randomUUID(), scheduler)).tags.length, 1);
  assert.equal((await scheduler.status()).running, false);
  await assert.rejects(scheduler.tick(), /not running/);
  await assert.rejects(f.invoke("configure", { enabled: false }, randomUUID(), scheduler), /started native snapshot scheduler/);
});

test("original timezone calculator keeps 23/25-hour DST daily intervals rather than fixed milliseconds", async t => {
  const f = await fixture(t);
  for (const [start, hours] of [["2026-03-07T17:00:00-08:00", 23], ["2026-10-31T17:00:00-07:00", 25]]) {
    const now = new Date(start);
    const result = await legacyKnowledgeSnapshotTiming(f.storage, "17:00", "America/Los_Angeles", now);
    assert.equal((Date.parse(result.next_run_utc) - now.getTime()) / 3600000, hours);
  }
});

test("scheduler denies forged actor/root grants, direct callback calls, missing explicit tool scope and changed queue bytes", async t => {
  const f = await fixture(t);
  const foreign = createLegacyKnowledgeSnapshotScheduler(f.storage, { ...actor, id: "foreign" }, f.authority);
  await assert.rejects(foreign.start(), /host-admitted/);
  await foreign.close();
  await assert.rejects(f.scheduler.host.configureSchedule({ operationId: randomUUID(), enabled: true }), /committed snapshot intent/);
  await f.invoke("configure");
  const db = f.storage.connectNative();
  try {
    const trigger = db.prepare("SELECT sql FROM sqlite_master WHERE name='native_knowledge_snapshot_schedule_no_update'").get().sql;
    db.exec("DROP TRIGGER native_knowledge_snapshot_schedule_no_update");
    db.exec("UPDATE native_knowledge_snapshot_schedule_events SET sha256=printf('%064d',0)");
    db.exec(trigger);
    assert.throws(() => verifyLegacyKnowledgeSnapshots(db, f.data), /schedule event digest/);
  } finally { db.close(); }
  await assert.rejects(f.scheduler.tick(), /schedule event digest/);
});

test("durable native schedule installation survives an unknown configure effect and exact-owner restart reconciliation", async t => {
  const f = await fixture(t), id = randomUUID();
  await assert.rejects(legacyKnowledgeSnapshot(f.storage, actor, {
    tool: "knowledge_snapshot_configure", args: { enabled: true }, operationId: id,
  }, { ...f.scheduler.host, checkpoint(phase) { if (phase === "scheduled") throw new Error("installed-before-publish"); } }),
  error => error.effect === "unknown" && /installed-before-publish/.test(error.message));
  assert.equal((await f.scheduler.status()).configuration.operationId, id);
  await f.scheduler.close(); await f.storage.close();
  await assert.rejects(f.open(), /reconciliation/);
  const storage = await f.open(f.data, { deferRecovery: true }), scheduler = f.make(storage);
  await scheduler.start();
  const configured = await reconcileLegacyKnowledgeSnapshots(storage, actor, scheduler.host);
  f.setTime(Date.parse(configured.next_run_utc) + 1);
  await scheduler.tick(); await scheduler.drain();
  assert.equal((await f.invoke("status", {}, randomUUID(), scheduler, storage)).tags.length, 1);
  assert.deepEqual(await f.invoke("configure", { enabled: true }, id, scheduler, storage), configured);
});

test("source-free backup preserves durable jobs without rebinding relocated host execution authority", async t => {
  const f = await fixture(t);
  const configured = await f.invoke("configure", { local_time: "09:15", timezone: "Asia/Tokyo" });
  f.setTime(Date.parse(configured.next_run_utc) + 1);
  await f.scheduler.tick();
  const before = await f.scheduler.status(), runtime = await createNativeRuntime({ storage: f.storage }), backup = join(f.root, "backup");
  try { await createWorkspaceBackup(f.storage, backup, { acquireQuiescence: runtime.acquireWorkspaceQuiescence }); }
  finally { await runtime.close(); }
  assert.equal(JSON.parse(await readFile(join(backup, ".pkm-workspace-backup.json"))).databaseUserVersion, 26);
  assert.equal((await f.scheduler.status()).started, true);
  const relocated = join(f.root, "relocated");
  await restoreWorkspaceBackup(backup, relocated, { nativeRestoreAuthority });
  const storage = await f.open(relocated), db = storage.connectNative();
  try {
    verifyLegacyKnowledgeSnapshots(db, relocated);
    const restored = verifySnapshotSchedule(db);
    assert.equal(restored.configuration.operationId, before.configuration.operationId);
    assert.equal(restored.dueUtc, before.dueUtc); assert.equal(restored.lastCompletedUtc, before.lastCompletedUtc);
  } finally { db.close(); }
  const denied = createLegacyKnowledgeSnapshotScheduler(storage, actor, { authorize: () => true });
  await assert.rejects(denied.start(), /host-admitted/);
  await denied.close();
});

test("native backup quiescence drains and pauses the actual timer before its due occurrence, then resumes only after release", async t => {
  const f = await fixture(t), configured = await f.invoke("configure");
  let held = false;
  const lease = await f.scheduler.acquireQuiescence(async () => {
    held = true;
    return { assertHeld() { assert(held); }, release() { held = false; } };
  });
  lease.assertHeld();
  f.setTime(Date.parse(configured.next_run_utc) + 1);
  await new Promise(resolve => setTimeout(resolve, 50));
  assert.equal((await f.invoke("status")).tags.length, 0);
  await assert.rejects(f.scheduler.start(), /held quiescent/);
  await assert.rejects(f.scheduler.tick(), /not running/);
  await lease.release(); await lease.release();
  assert.equal(held, false);
  await f.scheduler.tick(); await f.scheduler.drain();
  assert.equal((await f.invoke("status")).tags.length, 1);
  assert.throws(() => lease.assertHeld(), /released/);
});

test("expired workspace ownership fences scheduled effects rather than advancing or silently completing a job", async t => {
  const f = await fixture(t), configured = await f.invoke("configure"), db = f.storage.connectNative();
  let expires;
  try {
    expires = db.prepare("SELECT lease_until FROM native_runtime_owner WHERE singleton=1").get().lease_until;
    db.prepare("UPDATE native_runtime_owner SET lease_until=0 WHERE singleton=1").run();
    f.setTime(Date.parse(configured.next_run_utc) + 1);
    await assert.rejects(f.scheduler.tick(), /lease|ownership|owner/i);
    assert.equal(db.prepare("SELECT count(*) n FROM legacy_knowledge_snapshot_events WHERE json_extract(payload,'$.tool')='knowledge_snapshot_create'").get().n, 0);
  } finally { db.prepare("UPDATE native_runtime_owner SET lease_until=? WHERE singleton=1").run(expires); db.close(); }
});

test("immutable managed scheduler opt-in consumes the exact existing enrollment without creating or broadening native authority", async t => {
  const f = await fixture(t), db = f.storage.connectNative();
  let enrollment;
  try {
    enrollment = inspectLegacyKnowledgeSnapshotSchedulerEnrollment(db, f.data);
    assert.deepEqual(inspectLegacyKnowledgeSnapshotSchedulerEnrollment(f.data, enrollment.admissionSha256), enrollment);
    assert.equal(enrollment.schema, "pkm.native-snapshot-scheduler/v1");
    assert.equal(enrollment.actorId, "mcp:external");
    assert.throws(() => inspectLegacyKnowledgeSnapshotSchedulerEnrollment(db, f.data, "0".repeat(64)), /digest differs/);
  } finally { db.close(); }
  await f.scheduler.close();
  const scheduler = createAdmittedLegacyKnowledgeSnapshotScheduler(f.storage, actor, enrollment.admissionSha256);
  try {
    await scheduler.start();
    const configured = await f.invoke("configure", { enabled: false }, randomUUID(), scheduler);
    assert.equal(configured.enabled, false);
    await assert.rejects(legacyKnowledgeSnapshot(f.storage, { ...actor, id: "foreign" }, {
      tool: "knowledge_snapshot_status", args: {}, operationId: randomUUID(),
    }, scheduler.host), /host-admitted/);
  } finally { await scheduler.close(); }
  const unenrolled = await initialize(join(f.root, "no-enrollment"));
  const unapproved = await Storage.open(unenrolled);
  try {
    assert.throws(() => inspectLegacyKnowledgeSnapshotSchedulerEnrollment(unenrolled), /existing exact-root enrollment/);
    const unrelated = unapproved.connectNative();
    try { assert.throws(() => inspectLegacyKnowledgeSnapshotSchedulerEnrollment(unrelated, f.data), /exact workspace database/); }
    finally { unrelated.close(); }
  }
  finally { await unapproved.close(); }
});

test("Storage owns draining an in-flight scheduled Git mutation before worker shutdown and lease release", async t => {
  const f = await fixture(t), configured = await f.invoke("configure");
  f.setTime(Date.parse(configured.next_run_utc) + 1);
  const running = f.scheduler.tick();
  const closing = f.storage.close();
  await assert.rejects(f.storage.request({ operation: "knowledge.document.list", args: {}, actorId: actor.id }),
    error => error.code === "STORAGE_UNAVAILABLE");
  await Promise.all([running, closing]);
  const storage = await f.open(), db = storage.connectNative();
  try {
    verifyLegacyKnowledgeSnapshots(db, f.data);
    assert.equal(verifySnapshotSchedule(db).pending, undefined);
    assert.equal(db.prepare("SELECT count(*) n FROM legacy_knowledge_snapshot_events WHERE json_extract(payload,'$.tool')='knowledge_snapshot_create'").get().n, 1);
  } finally { db.close(); }
});

test("automatic backup admission fence pauses scheduled work before native quiescence and resumes on backup failure", async t => {
  const f = await fixture(t), configured = await f.invoke("configure");
  await assert.rejects(createWorkspaceBackup(f.storage, join(f.root, "denied-backup"), {
    async acquireQuiescence() {
      assert.equal((await f.scheduler.status()).started, false);
      f.setTime(Date.parse(configured.next_run_utc) + 1);
      await new Promise(resolve => setTimeout(resolve, 25));
      assert.equal((await f.invoke("status")).tags.length, 0);
      throw new Error("native-quiescence-refused");
    },
  }), /native-quiescence-refused/);
  await f.scheduler.tick(); await f.scheduler.drain();
  assert.equal((await f.invoke("status")).tags.length, 1);
});

test("native schedule ownership opts into schema26 and rejects lowered or orphaned versions before ordinary effects", async t => {
  const f = await fixture(t);
  const db = f.storage.connectNative();
  try { assert.equal(db.prepare("PRAGMA user_version").get().user_version, 25); } finally { db.close(); }
  await f.invoke("configure", { enabled: false });
  const changed = f.storage.connectNative();
  try {
    changed.exec("PRAGMA user_version=25");
    assert.throws(() => verifyLegacyKnowledgeSnapshots(changed, f.data), /downgrade-fenced schema26/);
    changed.exec("PRAGMA user_version=26");
    verifyLegacyKnowledgeSnapshots(changed, f.data);
  } finally { changed.close(); }
  const orphan = await initialize(join(f.root, "orphan"));
  const storage = await Storage.open(orphan), bad = storage.connectNative();
  try {
    bad.exec("PRAGMA user_version=26");
    assert.throws(() => verifyLegacyKnowledgeSnapshots(bad, orphan), /Schema26 requires/);
    bad.exec("PRAGMA user_version=23");
  } finally { bad.close(); await storage.close(); }
});
