import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFile, readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fixture, hash, hashes, pythonExecutable } from "./batch09-original-control-fixtures.mjs";
import { importLegacyWorkspace, planLegacyImport } from "../dist/legacy-import.js";
import { createNativeRuntime } from "../dist/native-runtime.js";
import { Storage } from "../dist/storage.js";
import { startHttp } from "../dist/http.js";
import { httpCall, invocation } from "./batch06-manager-fixtures.mjs";
import { readLegacyProjectControl } from "../dist/legacy-control-import.js";
import { planProjectMutation, serializeProjectMutationPlan } from "../dist/project-mutations.js";
import { scanMarkdown } from "../dist/markdown.js";
import { canonicalJson } from "../dist/domain/project-recipes-workflow-contracts.js";

const actor = { id: "batch09:native-control-owner", canWrite: true };
const nativeRestoreAuthority = {
  actorId: actor.id,
  async authorize(request) {
    return { authorityId: "disposable-fixture", actorId: request.actorId,
      requestSha256: hash(JSON.stringify(request)), expiresAt: Date.now() + 60_000,
      lineage: "unrelated", trustedEpoch: null };
  },
};
async function nativeFixture(t) {
  const f = await fixture(t);
  const sourceHashes = await hashes(f.source);
  await importLegacyWorkspace(await planLegacyImport(f.source), f.target, { pythonExecutable });
  let storage, runtime, listening;
  const bearer = randomUUID() + randomUUID();
  async function close() {
    if (listening) { await new Promise(resolve => listening.server.close(resolve)); listening = undefined; }
    if (runtime) { await runtime.close(); runtime = undefined; }
    if (storage) { await storage.close(); storage = undefined; }
  }
  async function open() {
    storage = await Storage.open(f.target, { deferRecovery: true });
    try {
      runtime = await createNativeRuntime({ storage, hostServices: { authorizeBackup: () => true, backupOptions: { nativeRestoreAuthority } } });
      listening = await startHttp(runtime.core, bearer, actor, 0);
    } catch (error) { await storage.close(); storage = undefined; throw error; }
  }
  await open();
  t.after(close);
  return {
    ...f, sourceHashes, close, open, get storage() { return storage; }, get runtime() { return runtime; },
    async call(operation, args, write = true) {
      return httpCall(listening.url, bearer, write ? "capability_call" : "capability_read", invocation(operation, args));
    },
    db(work) { const db = storage.connectNative(); try { return work(db); } finally { db.close(); } },
    async updateArguments() {
      const pin = await this.call("project.mutation.pin", { entityKind: "project", id: f.projectId }, false);
      assert.equal(pin.status, 200, JSON.stringify(pin.body));
      const project = JSON.parse(await readFile(join(f.target, f.projectPath), "utf8"));
      return { expectedSnapshotRevision: pin.body.result.snapshotRevision, projectId: f.projectId, expectedVersion: project.version,
        expectedSha256: hash(await readFile(join(f.target, f.projectPath))), overview: { goal: "Actual native control update" },
        reason: "Synthetic original control integration", at: "2026-11-07T00:00:00.000Z" };
    },
  };
}
test("actual imported original controls -> configured native Core HTTP command update/current snapshot replay/conflict/backup/restart", async t => {
  const f = await nativeFixture(t);
  const workspaceId = await f.storage.workspaceId();
  assert.notEqual(workspaceId, f.rootId);
  const historical = { operationId: randomUUID(), command: {
    commandId: f.originalReceipt.commandId, fingerprint: f.originalReceipt.fingerprint,
    operation: "historical-operation-not-newly-supported", expectedStoreVersion: 1,
  } };
  const replay = await f.call("project.legacy.command", historical);
  assert.equal(replay.status, 200, JSON.stringify(replay.body)); assert.equal(replay.body.result.replayed, true);
  assert.equal(replay.body.result.snapshot.rootId, f.rootId); assert.equal(replay.body.result.entityId, f.projectId);
  const command = { commandId: "actual-native-http-command", fingerprint: "original opaque caller update pin",
    operation: "project.update", expectedStoreVersion: 8 };
  const args = { operationId: randomUUID(), command, update: await f.updateArguments() };
  const before = await readFile(join(f.target, f.projectPath));
  const stale = await f.call("project.legacy.command", { ...args, update: { ...args.update, expectedSha256: "f".repeat(64) } });
  assert.notEqual(stale.status, 200); assert.deepEqual(await readFile(join(f.target, f.projectPath)), before);
  assert.equal(f.db(db => readLegacyProjectControl(db, workspaceId).storeVersion), 8);
  const direct = await f.call("project.update", { ...args.update, operationId: randomUUID() });
  assert.notEqual(direct.status, 200, "ordinary project mutation cannot bypass imported control");
  const updated = await f.call("project.legacy.command", args);
  assert.equal(updated.status, 200, JSON.stringify(updated.body)); assert.equal(updated.body.result.storeVersion, 9);
  assert.equal(updated.body.result.snapshot.projects[0].goal, args.update.overview.goal);
  const currentReplay = await f.call("project.legacy.command", historical);
  assert.equal(currentReplay.status, 200); assert.equal(currentReplay.body.result.snapshot.projects[0].goal, args.update.overview.goal,
    "historical command returns current snapshot, not stale original result");
  const count = f.db(db => db.prepare("SELECT COUNT(*) AS count FROM receipts").get().count);
  const same = await f.call("project.legacy.command", args);
  assert.equal(same.status, 200); assert.equal(same.body.result.replayed, true);
  assert.equal(f.db(db => db.prepare("SELECT COUNT(*) AS count FROM receipts").get().count), count);
  assert.notEqual((await f.call("project.legacy.command", { operationId: randomUUID(), command: { ...command, fingerprint: "different" } })).status, 200);
  assert.notEqual((await f.call("project.legacy.command", { operationId: randomUUID(), command: { ...command, commandId: "unsupported", operation: "project.delete", expectedStoreVersion: 9 } })).status, 200);
  const control = f.db(db => readLegacyProjectControl(db, workspaceId));
  assert.deepEqual(control.controlBytes, f.projectControlBytes); assert.equal(control.receipts.at(-1).commandId, command.commandId);
  assert.equal(f.db(db => db.prepare("SELECT COUNT(*) AS count FROM pending_project_mutation").get().count), 0);
  await f.runtime.services.hostServices.backup(f.backup);
  await f.runtime.services.hostServices.restore(f.backup, f.restored);
  assert.deepEqual(await readFile(join(f.restored, f.projectPath)), await readFile(join(f.target, f.projectPath)));
  const restoredDb = new DatabaseSync(join(f.restored, "core.sqlite"));
  try {
    assert.equal(restoredDb.prepare("PRAGMA user_version").get().user_version, 23);
    assert.deepEqual(readLegacyProjectControl(restoredDb, workspaceId).controlBytes, f.projectControlBytes);
  } finally { restoredDb.close(); }
  await f.close(); await f.open();
  assert.equal((await f.call("project.legacy.command", args)).body.result.replayed, true);
  assert.deepEqual(await hashes(f.source), f.sourceHashes); await assert.rejects(readdir(join(f.target, ".pkm")), { code: "ENOENT" });
});
for (const partial of [false, true]) {
  test(`native restart reconciles durable original command ${partial ? "exact after" : "before"} state atomically`, async t => {
    const f = await nativeFixture(t), workspaceId = await f.storage.workspaceId(), operationId = randomUUID();
    const update = await f.updateArguments(), command = { commandId: `interrupted-${partial}`, fingerprint: "opaque interrupted pin",
      operation: "project.update", expectedStoreVersion: 8 };
    const args = { operationId, command, update };
    const plan = planProjectMutation(f.target, { operation: "project.update", args: { ...update, operationId }, actorId: actor.id }, scanMarkdown(f.target));
    f.db(db => db.prepare(`INSERT INTO pending_project_mutation(singleton,operation_id,fingerprint,actor_id,operation,plan,legacy_command)
      VALUES(1,?,?,?,?,?,?)`).run(operationId, hash(JSON.stringify({ operation: "project.legacy.command", actorId: actor.id, args })),
      actor.id, "project.legacy.command", serializeProjectMutationPlan(plan), canonicalJson(command)));
    if (partial) for (const file of plan.files) await writeFile(join(f.target, file.relativePath), Buffer.from(file.afterBase64, "base64"));
    await f.close(); await f.open();
    const recovered = await f.call("project.legacy.command", args);
    assert.equal(recovered.status, 200, JSON.stringify(recovered.body)); assert.equal(recovered.body.result.replayed, true);
    assert.equal(f.db(db => readLegacyProjectControl(db, workspaceId).storeVersion), 9);
    assert.equal(f.db(db => db.prepare("SELECT COUNT(*) AS count FROM pending_project_mutation").get().count), 0);
    assert.deepEqual(await hashes(f.source), f.sourceHashes);
  });
}
test("schema12 workspace upgrades once to22 retaining native identity and creates controls only inside migration", async t => {
  const f = await nativeFixture(t), id = await f.storage.workspaceId();
  await f.close();
  const db = new DatabaseSync(join(f.target, "core.sqlite"));
  try {
    db.exec("DROP TABLE legacy_note_workitems_receipt; DROP TABLE legacy_note_workitems_intent; DROP TABLE legacy_note_workitems_admission; DROP TABLE legacy_note_workitems_native_binding; DROP TABLE legacy_project_receipt; DROP TABLE legacy_project_control; DROP TABLE legacy_recipe_control; ALTER TABLE pending_project_mutation DROP COLUMN legacy_command; PRAGMA user_version=12");
  } finally { db.close(); }
  await f.open();
  assert.equal(await f.storage.workspaceId(), id);
  assert.equal(f.db(db => db.prepare("PRAGMA user_version").get().user_version), 23);
  assert.equal(f.db(db => db.prepare("SELECT COUNT(*) AS count FROM legacy_project_control").get().count), 0);
  await f.close(); await f.open(); assert.equal(f.db(db => db.prepare("PRAGMA user_version").get().user_version), 23);
});
test("native original command recovery rejects unknown bytes or authority before mutation/version/receipt effects", async t => {
  for (const invalid of ["bytes", "command", "ordinary"]) {
    const f = await nativeFixture(t), operationId = randomUUID(), update = await f.updateArguments();
    const command = { commandId: `invalid-${invalid}`, fingerprint: "opaque invalid pin", operation: "project.update", expectedStoreVersion: 8 };
    const plan = planProjectMutation(f.target, { operation: "project.update", args: { ...update, operationId }, actorId: actor.id }, scanMarkdown(f.target));
    f.db(db => db.prepare(`INSERT INTO pending_project_mutation(singleton,operation_id,fingerprint,actor_id,operation,plan,legacy_command)
      VALUES(1,?,?,?,?,?,?)`).run(operationId, "e".repeat(64), actor.id, invalid === "ordinary" ? "project.update" : "project.legacy.command",
      serializeProjectMutationPlan(plan), invalid === "ordinary" ? null : canonicalJson({ ...command, ...(invalid === "command" ? { expectedStoreVersion: 7 } : {}) })));
    if (invalid === "bytes") await writeFile(join(f.target, f.projectPath), JSON.stringify({ ...f.project, goal: "Unknown concurrent bytes" }));
    const bytes = await readFile(join(f.target, f.projectPath));
    await f.close(); await assert.rejects(f.open());
    assert.deepEqual(await readFile(join(f.target, f.projectPath)), bytes);
    const db = new DatabaseSync(join(f.target, "core.sqlite"));
    try {
      assert.equal(db.prepare("SELECT store_version FROM legacy_project_control").get().store_version, 8);
      assert.equal(db.prepare("SELECT COUNT(*) AS count FROM receipts WHERE operation_id=?").get(operationId).count, 0);
      assert.equal(db.prepare("SELECT COUNT(*) AS count FROM pending_project_mutation").get().count, 1);
    } finally { db.close(); }
  }
});
test("prior version12 backup remains restorable and migrates to22 only on explicit isolated workspace open", async t => {
  const f = await nativeFixture(t), workspaceId = await f.storage.workspaceId();
  await f.runtime.services.hostServices.backup(f.backup);
  const db = new DatabaseSync(join(f.backup, "core.sqlite"));
  try {
    db.exec("DROP TABLE legacy_note_workitems_receipt; DROP TABLE legacy_note_workitems_intent; DROP TABLE legacy_note_workitems_admission; DROP TABLE legacy_note_workitems_native_binding; DROP TABLE legacy_project_receipt; DROP TABLE legacy_project_control; DROP TABLE legacy_recipe_control; ALTER TABLE pending_project_mutation DROP COLUMN legacy_command; PRAGMA user_version=12");
  } finally { db.close(); }
  const manifestPath = join(f.backup, ".pkm-workspace-backup.json");
  const manifest = JSON.parse(await readFile(manifestPath, "utf8")), bytes = await readFile(join(f.backup, "core.sqlite"));
  const file = manifest.files.find(file => file.path === "core.sqlite");
  file.sha256 = hash(bytes); file.size = bytes.length; manifest.databaseUserVersion = 12;
  manifest.totalBytes = manifest.files.reduce((sum, file) => sum + file.size, 0);
  await writeFile(manifestPath, JSON.stringify(manifest));
  await f.runtime.services.hostServices.restore(f.backup, f.restored);
  const restoredDb = new DatabaseSync(join(f.restored, "core.sqlite"));
  try { assert.equal(restoredDb.prepare("PRAGMA user_version").get().user_version, 12); } finally { restoredDb.close(); }
  const storage = await Storage.open(f.restored);
  try {
    assert.equal(await storage.workspaceId(), workspaceId);
    const db = storage.connectNative();
    try { assert.equal(db.prepare("PRAGMA user_version").get().user_version, 23); } finally { db.close(); }
  } finally { await storage.close(); }
});
