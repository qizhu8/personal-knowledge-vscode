import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
import { appendFile, chmod, lstat, mkdir, readFile, readdir, rm, rmdir, symlink, unlink, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { DatabaseSync } from "node:sqlite";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { test } from "node:test";
import { Storage } from "../dist/storage.js";
import { createNativeRuntime } from "../dist/native-runtime.js";
import { legacyKnowledgeWrite } from "../dist/legacy-knowledge-write.js";
import { planLegacyImport } from "../dist/legacy-import.js";
import { legacyRollbackDatabaseFingerprint } from "../dist/legacy-root-rollback-baseline.js";
import {
  exportLegacyRootSqliteSnapshotExperimental, inspectLegacyRootSqliteSnapshotExperimental,
} from "../dist/legacy-root-sqlite-export.js";
import {
  adoptLegacyRootInPlaceExperimental, legacyRootAdoptionLockDirectory,
  prepareLegacyRootAdoptionExperimental, resumeLegacyRootAdoptionExperimental,
  rollbackPreparedLegacyRootAdoptionExperimental, rollbackCommittedLegacyRootAdoptionExperimental,
} from "../dist/legacy-root-adoption.js";

const require = createRequire(import.meta.url);
const work = resolve(process.env.PKM_ROLLBACK_TEST_WORK || ".migration-test-work");
const legacyDist = process.env.PKM_LEGACY_DIST;
const managedDist = process.env.PKM_MANAGED_DIST;
const note = "---\ntitle: Existing\ndocumentId: synthetic-note\nrevision: 1\n---\nOriginal synthetic content.\n";
const hash = text => createHash("sha256").update(text).digest("hex");
const noFile = path => assert.rejects(lstat(path), { code: "ENOENT" });

async function fixture(t) {
  const root = join(work, `adoption-rollback-${randomUUID()}`);
  await mkdir(join(root, "notes"), { recursive: true, mode: 0o700 });
  await writeFile(join(root, "notes/Existing.md"), note, { mode: 0o600 });
  t.after(async () => {
    await rm(root, { recursive: true, force: true });
    const locks = legacyRootAdoptionLockDirectory(root), id = hash(root).slice(0, 40);
    for (const suffix of [".sqlite", ".sqlite-journal", ".sqlite-wal", ".sqlite-shm", ".writer.lock", ".writer-fenced.json"])
      await rm(join(locks, id + suffix), { force: true });
    try { await rmdir(locks); } catch (error) {
      if (!["ENOENT", "ENOTEMPTY"].includes(error.code)) throw error;
    }
  });
  return root;
}

test("prepared-only rollback preserves the old Note and restores its legacy write workflow", { timeout: 60000 }, async t => {
  const root = await fixture(t), original = join(root, "notes/Existing.md");
  const before = await lstat(original, { bigint: true });
  const prepared = await prepareLegacyRootAdoptionExperimental(root, {});
  const rolledBack = await rollbackPreparedLegacyRootAdoptionExperimental(root);
  assert.equal(rolledBack.workspaceId, prepared.workspaceId);
  assert.equal(rolledBack.qualification, "experimental-unqualified");
  assert.equal(await readFile(original, "utf8"), note);
  assert.equal((await lstat(original, { bigint: true })).ino, before.ino);
  for (const file of [".pkm-next-workspace", ".pkm-next-root-adoption.json", ".pkm-next-root-adoption-rollback.json", "core.sqlite"])
    await noFile(join(root, file));
  await assert.rejects(Storage.open(root), { code: "INVALID_WORKSPACE" });
  assert(legacyDist, "PKM_LEGACY_DIST must point to the isolated compiled legacy extension");
  const store = require(join(legacyDist, "knowledge/filestore.js"));
  store.setStorePath(root);
  assert.equal(store.noteGet("Existing").content, "Original synthetic content.\n");
  store.noteUpsert({ slug: "Existing", title: "Existing", type: "note", tags: [], content: "Legacy write after rollback.\n" });
  assert.equal(store.noteGet("Existing").content, "Legacy write after rollback.\n");
});

test("private empty Action settings are bound as inert original state, not execution authority", { timeout: 60000 }, async t => {
  const root = await fixture(t), actions = join(root, ".pkm/state/actions");
  await mkdir(actions, { recursive: true, mode: 0o700 });
  await writeFile(join(root, ".pkm/content-privacy.json"), '{"schema":1,"private":{}}', { mode: 0o600 });
  const settings = join(actions, "settings.json"), original = '{\n  "workspace_roots": {},\n  "toolchains": {}\n}';
  await writeFile(settings, original, { mode: 0o600 });
  const hostId = randomUUID(), control = join(root, ".pkm/state/api-chat-control");
  await mkdir(join(control, "hosts"), { recursive: true, mode: 0o700 });
  await mkdir(join(control, "requests", hostId), { recursive: true, mode: 0o700 });
  const host = join(control, "hosts", `${hostId}.json`);
  const hostBytes = JSON.stringify({ schema: "pkm.api-chat.host/v1", hostId, pid: 123,
    updatedAt: 1700000000000, operations: ["send"], portalRequestDirectory: "/historical-only" });
  await writeFile(host, hostBytes, { mode: 0o600 });
  const plan = await planLegacyImport(root, {}, { inPlaceAdoption: true });
  assert.equal(plan.ready, true, JSON.stringify(plan.blockers));
  assert.equal(plan.inPlaceEmptyActionSettingsSha256, hash(original));
  assert.equal(plan.entries.find(entry => entry.source === ".pkm/state/actions/settings.json").sha256, hash(original));
  assert(plan.inPlaceApiChatArchive.files.some(file => file.path.endsWith(`${hostId}.json`) && file.sha256 === hash(hostBytes)));
  await prepareLegacyRootAdoptionExperimental(root, {
    snapshotAdmission: {
      authorityId: "synthetic-root-snapshot-authority",
      allowedTools: ["knowledge_snapshot_status"],
      authorize: () => true,
    },
  });
  await rollbackPreparedLegacyRootAdoptionExperimental(root);
  assert.equal(await readFile(settings, "utf8"), original);
  assert.equal(await readFile(host, "utf8"), hostBytes);
  await chmod(settings, 0o644);
  await assert.rejects(planLegacyImport(root, {}, { inPlaceAdoption: true }), {
    code: "PKM_STATE_UNSUPPORTED", path: ".pkm/state/actions/settings.json",
  });
  await chmod(settings, 0o600);
  await writeFile(settings, '{"workspace_roots":{"Linux":"/configured"},"toolchains":{}}');
  await assert.rejects(planLegacyImport(root, {}, { inPlaceAdoption: true }), {
    code: "PKM_STATE_UNSUPPORTED", path: ".pkm/state/actions/settings.json",
  });
  assert.match(await readFile(settings, "utf8"), /configured/);
});

test("changed Action settings after preparation prevent rollback without erasing the change", { timeout: 60000 }, async t => {
  const root = await fixture(t), actions = join(root, ".pkm/state/actions");
  await mkdir(actions, { recursive: true, mode: 0o700 });
  await writeFile(join(root, ".pkm/content-privacy.json"), '{"schema":1,"private":{}}', { mode: 0o600 });
  const settings = join(actions, "settings.json");
  await writeFile(settings, '{"workspace_roots":{},"toolchains":{}}', { mode: 0o600 });
  await prepareLegacyRootAdoptionExperimental(root, {
    snapshotAdmission: {
      authorityId: "synthetic-root-snapshot-authority",
      allowedTools: ["knowledge_snapshot_status"],
      authorize: () => true,
    },
  });
  const changed = '{"workspace_roots":{"Linux":"/new-config"},"toolchains":{}}';
  await writeFile(settings, changed);
  await assert.rejects(rollbackPreparedLegacyRootAdoptionExperimental(root), { code: "SOURCE_CHANGED" });
  assert.equal(await readFile(settings, "utf8"), changed);
  await lstat(join(root, ".pkm-next-root-adoption.json"));
});

test("opt-in post-commit baseline detects later database-only writes without relying on lease changes", { timeout: 60000 }, async t => {
  const root = await fixture(t);
  const adopted = await adoptLegacyRootInPlaceExperimental(root, { experimentalPostCommitRollbackBaseline: true });
  await adopted.storage.close();
  const receipt = JSON.parse(await readFile(join(root, ".pkm-next-root-adoption.commit.json"), "utf8"));
  const db = new DatabaseSync(join(root, "core.sqlite"));
  try {
    assert.equal(legacyRollbackDatabaseFingerprint(db), receipt.rollbackBaselineSha256);
    db.exec("CREATE TABLE rollback_test_later_write(value TEXT); INSERT INTO rollback_test_later_write VALUES('preserve me');");
    assert.notEqual(legacyRollbackDatabaseFingerprint(db), receipt.rollbackBaselineSha256);
  } finally { db.close(); }
});

test("unchanged committed state archives safely and restores the original Note writer", { timeout: 60000 }, async t => {
  const root = await fixture(t);
  const adopted = await adoptLegacyRootInPlaceExperimental(root, { experimentalPostCommitRollbackBaseline: true });
  const workspaceId = await adopted.storage.workspaceId();
  await adopted.storage.close();
  const result = await rollbackCommittedLegacyRootAdoptionExperimental(root, { workspaceId });
  assert.equal(result.qualification, "experimental-unqualified");
  assert.equal(await readFile(join(result.archive, ".gitignore"), "utf8"), "*\n");
  await lstat(join(result.archive, "core.sqlite"));
  await lstat(join(result.archive, "writer-fenced.json"));
  for (const file of [".pkm-next-workspace", ".pkm-next-root-adoption.json", ".pkm-next-root-adoption.commit.json",
    ".pkm-next-root-adoption-rollback.json", "core.sqlite"]) await noFile(join(root, file));
  assert.equal(await readFile(join(root, "notes/Existing.md"), "utf8"), note);
  const store = require(join(legacyDist, "knowledge/filestore.js"));
  store.setStorePath(root);
  store.noteUpsert({ slug: "Existing", title: "Existing", type: "note", tags: [], content: "Legacy post-rollback write.\n" });
  assert.equal(store.noteGet("Existing").content, "Legacy post-rollback write.\n");
  const retry = await rollbackCommittedLegacyRootAdoptionExperimental(root, { workspaceId });
  assert.equal(retry.archive, result.archive);
  assert.equal(store.noteGet("Existing").content, "Legacy post-rollback write.\n");
});

test("completed rollback archives permit re-adoption but reject later tampering", { timeout: 60000 }, async t => {
  const root = await fixture(t);
  const first = await adoptLegacyRootInPlaceExperimental(root, { experimentalPostCommitRollbackBaseline: true });
  const firstId = await first.storage.workspaceId();
  await first.storage.close();
  const archived = await rollbackCommittedLegacyRootAdoptionExperimental(root, { workspaceId: firstId });
  const second = await adoptLegacyRootInPlaceExperimental(root, { experimentalPostCommitRollbackBaseline: true });
  const secondId = await second.storage.workspaceId();
  await second.storage.close();
  await rollbackCommittedLegacyRootAdoptionExperimental(root, { workspaceId: secondId });
  await appendFile(join(archived.archive, "core.sqlite"), "tampered");
  await assert.rejects(adoptLegacyRootInPlaceExperimental(root, {}), /archive/i);
  assert.equal(await readFile(join(root, "notes/Existing.md"), "utf8"), note);
});

test("changed rollback archive controls block re-adoption without erasing evidence", { timeout: 60000 }, async t => {
  for (const control of [".gitignore", "manifest.json", "complete.json"]) {
    const root = await fixture(t);
    const adopted = await adoptLegacyRootInPlaceExperimental(root, { experimentalPostCommitRollbackBaseline: true });
    const workspaceId = await adopted.storage.workspaceId();
    await adopted.storage.close();
    const { archive } = await rollbackCommittedLegacyRootAdoptionExperimental(root, { workspaceId });
    const file = join(archive, control);
    await appendFile(file, "tampered");
    await assert.rejects(adoptLegacyRootInPlaceExperimental(root, {}), /archive/i, control);
    assert.match(await readFile(file, "utf8"), /tampered$/);
    assert.equal(await readFile(join(root, "notes/Existing.md"), "utf8"), note);
  }
});

test("post-commit rollback refuses later Note or SQLite writes without losing either", { timeout: 60000 }, async t => {
  const root = await fixture(t);
  const adopted = await adoptLegacyRootInPlaceExperimental(root, { experimentalPostCommitRollbackBaseline: true });
  const workspaceId = await adopted.storage.workspaceId();
  const runtime = await createNativeRuntime({ storage: adopted.storage });
  try {
    await legacyKnowledgeWrite(runtime.core, adopted.storage, { id: "fixture-owner", canWrite: true }, {
      tool: "update_note", arguments: { slug: "Existing", content: "Do not overwrite this committed Note.\n" },
    });
  } finally { await runtime.close(); await adopted.storage.close(); }
  await assert.rejects(rollbackCommittedLegacyRootAdoptionExperimental(root, { workspaceId }), { code: "SOURCE_CHANGED" });
  assert.match(await readFile(join(root, "notes/Existing.md"), "utf8"), /Do not overwrite/);
  await lstat(join(root, ".pkm-next-root-adoption.commit.json"));

  const dbRoot = await fixture(t), second = await adoptLegacyRootInPlaceExperimental(dbRoot, { experimentalPostCommitRollbackBaseline: true });
  const dbWorkspaceId = await second.storage.workspaceId();
  await second.storage.close();
  const db = new DatabaseSync(join(dbRoot, "core.sqlite"));
  try { db.exec("CREATE TABLE rollback_test_later_write(value TEXT); INSERT INTO rollback_test_later_write VALUES('preserve me');"); }
  finally { db.close(); }
  await assert.rejects(rollbackCommittedLegacyRootAdoptionExperimental(dbRoot, { workspaceId: dbWorkspaceId }), { code: "SOURCE_CHANGED" });
  const verify = new DatabaseSync(join(dbRoot, "core.sqlite"), { readOnly: true });
  try { assert.equal(verify.prepare("SELECT value FROM rollback_test_later_write").get().value, "preserve me"); }
  finally { verify.close(); }
});

test("post-commit rollback preserves an independently changed legacy file", { timeout: 60000 }, async t => {
  const root = await fixture(t);
  const adopted = await adoptLegacyRootInPlaceExperimental(root, { experimentalPostCommitRollbackBaseline: true });
  const workspaceId = await adopted.storage.workspaceId();
  await adopted.storage.close();
  const changed = "Legacy writer changed this file after adoption.\n";
  await writeFile(join(root, "notes/Existing.md"), changed);
  await assert.rejects(rollbackCommittedLegacyRootAdoptionExperimental(root, { workspaceId }), { code: "SOURCE_CHANGED" });
  assert.equal(await readFile(join(root, "notes/Existing.md"), "utf8"), changed);
  await lstat(join(root, "core.sqlite"));
  await lstat(join(root, ".pkm-next-workspace"));
});

test("rollback after interruption refuses subsequent legacy writes", { timeout: 60000 }, async t => {
  const root = await fixture(t);
  const adopted = await adoptLegacyRootInPlaceExperimental(root, { experimentalPostCommitRollbackBaseline: true });
  const workspaceId = await adopted.storage.workspaceId();
  await adopted.storage.close();
  await assert.rejects(rollbackCommittedLegacyRootAdoptionExperimental(root, {
    workspaceId, experimentalRollbackCheckpoint: point => { if (point === "journal-archived") throw new Error("interrupted"); },
  }), /interrupted/);
  const changed = "Legacy file changed after interrupted rollback.\n";
  await writeFile(join(root, "notes/Existing.md"), changed);
  await assert.rejects(rollbackCommittedLegacyRootAdoptionExperimental(root, { workspaceId }), { code: "SOURCE_CHANGED" });
  assert.equal(await readFile(join(root, "notes/Existing.md"), "utf8"), changed);
  await lstat(join(root, ".pkm-next-root-adoption-rollback.json"));
  await lstat(join(root, "core.sqlite"));
});

test("rollback after interruption refuses subsequent database writes", { timeout: 60000 }, async t => {
  const root = await fixture(t);
  const adopted = await adoptLegacyRootInPlaceExperimental(root, { experimentalPostCommitRollbackBaseline: true });
  const workspaceId = await adopted.storage.workspaceId();
  await adopted.storage.close();
  await assert.rejects(rollbackCommittedLegacyRootAdoptionExperimental(root, {
    workspaceId, experimentalRollbackCheckpoint: point => { if (point === "journal-archived") throw new Error("interrupted"); },
  }), /interrupted/);
  const db = new DatabaseSync(join(root, "core.sqlite"));
  try { db.exec("CREATE TABLE changed_after_interruption(value TEXT); INSERT INTO changed_after_interruption VALUES('retain');"); }
  finally { db.close(); }
  await assert.rejects(rollbackCommittedLegacyRootAdoptionExperimental(root, { workspaceId }), { code: "SOURCE_CHANGED" });
  const verify = new DatabaseSync(join(root, "core.sqlite"), { readOnly: true });
  try { assert.equal(verify.prepare("SELECT value FROM changed_after_interruption").get().value, "retain"); }
  finally { verify.close(); }
  await lstat(join(root, ".pkm-next-root-adoption-rollback.json"));
});

test("post-commit rollback preserves unknown SQLite sidecars", { timeout: 60000 }, async t => {
  const root = await fixture(t);
  const adopted = await adoptLegacyRootInPlaceExperimental(root, { experimentalPostCommitRollbackBaseline: true });
  const workspaceId = await adopted.storage.workspaceId();
  await adopted.storage.close();
  const sidecar = join(root, "core.sqlite-wal"), bytes = "unattributed SQLite sidecar";
  await writeFile(sidecar, bytes, { mode: 0o600 });
  await assert.rejects(rollbackCommittedLegacyRootAdoptionExperimental(root, { workspaceId }), { code: "RECOVERY_REQUIRED" });
  assert.equal(await readFile(sidecar, "utf8"), bytes);
  await lstat(join(root, ".pkm-next-workspace"));
  await lstat(join(root, "core.sqlite"));
});

test("SQLite-only committed data exports losslessly from an adopted root without rolling it back", { timeout: 60000 }, async t => {
  const root = await fixture(t);
  const adopted = await adoptLegacyRootInPlaceExperimental(root, { experimentalPostCommitRollbackBaseline: true });
  const workspaceId = await adopted.storage.workspaceId();
  const database = adopted.storage.connectNative();
  try {
    database.exec("CREATE TABLE synthetic_sqlite_only(id INTEGER PRIMARY KEY, text_value TEXT, blob_value BLOB, nullable TEXT)");
    database.prepare("INSERT INTO synthetic_sqlite_only VALUES(?,?,?,?)").run(123, "Retain this SQLite-only value", Buffer.from([0, 1, 255]), null);
    database.prepare("INSERT INTO synthetic_sqlite_only VALUES(?,?,?,?)").run(9007199254740993n, "Second row", Buffer.from([7]), null);
  } finally { database.close(); }
  const outputDir = join(work, `sqlite-export-${randomUUID()}`);
  await mkdir(outputDir, { mode: 0o700 });
  t.after(() => rm(outputDir, { recursive: true, force: true }));
  const destination = join(outputDir, "data.sqlite");
  let held = false;
  const host = { acquireQuiescence: async () => {
    assert.equal(held, false); held = true;
    return { assertHeld: () => assert.equal(held, true), release: () => { held = false; } };
  } };
  try {
    const invalid = join(outputDir, "not-published.sqlite");
    let released = false;
    await assert.rejects(exportLegacyRootSqliteSnapshotExperimental(adopted.storage, invalid, {
      acquireQuiescence: async () => ({
        assertHeld: () => { throw new Error("lease revoked"); }, release: () => { released = true; },
      }),
    }), /lease revoked/);
    assert.equal(released, true);
    await noFile(invalid);
    const result = await exportLegacyRootSqliteSnapshotExperimental(adopted.storage, destination, host);
    assert.equal(result.workspaceId, workspaceId);
    assert.equal(held, false);
    assert.equal((await lstat(destination)).mode & 0o777, 0o600);
    assert((await inspectLegacyRootSqliteSnapshotExperimental(destination, result.sha256)).tables.includes("synthetic_sqlite_only"));
    const firstPage = await inspectLegacyRootSqliteSnapshotExperimental(destination, result.sha256,
      { table: "synthetic_sqlite_only", offset: 0, limit: 1 });
    assert.deepEqual(firstPage.rows[0], [
      { name: "id", type: "integer", value: "123" },
      { name: "text_value", type: "text", value: "Retain this SQLite-only value" },
      { name: "blob_value", type: "blob", base64: "AAH/" },
      { name: "nullable", type: "null" },
    ]);
    assert.equal(firstPage.nextOffset, 1);
    const lastPage = await inspectLegacyRootSqliteSnapshotExperimental(destination, result.sha256,
      { table: "synthetic_sqlite_only", offset: firstPage.nextOffset, limit: 1 });
    assert.equal(lastPage.rows[0][0].value, "9007199254740993");
    assert.equal(lastPage.nextOffset, undefined);
    await assert.rejects(inspectLegacyRootSqliteSnapshotExperimental(destination, result.sha256,
      { table: 'synthetic_sqlite_only"; DROP TABLE synthetic_sqlite_only;--', offset: 0, limit: 1 }));
    await assert.rejects(inspectLegacyRootSqliteSnapshotExperimental(destination, "0".repeat(64)), /digest changed/);
    const snapshotUrl = pathToFileURL(destination);
    snapshotUrl.search = "?immutable=1";
    const restored = new DatabaseSync(snapshotUrl, { readOnly: true });
    try {
      const row = restored.prepare("SELECT * FROM synthetic_sqlite_only").get();
      assert.equal(row.id, 123); assert.equal(row.text_value, "Retain this SQLite-only value");
      assert.deepEqual(Buffer.from(row.blob_value), Buffer.from([0, 1, 255])); assert.equal(row.nullable, null);
    } finally { restored.close(); }
    const originalExport = await readFile(destination);
    await assert.rejects(exportLegacyRootSqliteSnapshotExperimental(adopted.storage, destination, host), { code: "EEXIST" });
    assert.deepEqual(await readFile(destination), originalExport);
    await assert.rejects(exportLegacyRootSqliteSnapshotExperimental(adopted.storage, join(root, "bad.sqlite"), host));
    await chmod(outputDir, 0o755);
    await assert.rejects(exportLegacyRootSqliteSnapshotExperimental(adopted.storage, join(outputDir, "unsafe.sqlite"), host));
    await chmod(outputDir, 0o700);
    assert.deepEqual(await readdir(outputDir), ["data.sqlite"]);
  } finally { await adopted.storage.close(); }
  await assert.rejects(rollbackCommittedLegacyRootAdoptionExperimental(root, { workspaceId }), { code: "SOURCE_CHANGED" });
  await lstat(join(root, "core.sqlite"));
});

test("post-commit rollback refuses an adoption without an opted-in baseline", { timeout: 60000 }, async t => {
  const root = await fixture(t);
  const adopted = await adoptLegacyRootInPlaceExperimental(root, {});
  const workspaceId = await adopted.storage.workspaceId();
  await adopted.storage.close();
  await assert.rejects(rollbackCommittedLegacyRootAdoptionExperimental(root, { workspaceId }), { code: "RECOVERY_REQUIRED" });
  await lstat(join(root, ".pkm-next-workspace"));
  await lstat(join(root, "core.sqlite"));
});

test("completed rollback rejects a symlinked completion receipt", { timeout: 60000 }, async t => {
  const root = await fixture(t);
  const adopted = await adoptLegacyRootInPlaceExperimental(root, { experimentalPostCommitRollbackBaseline: true });
  const workspaceId = await adopted.storage.workspaceId();
  await adopted.storage.close();
  const result = await rollbackCommittedLegacyRootAdoptionExperimental(root, { workspaceId });
  const complete = join(result.archive, "complete.json"), target = join(root, "unrelated-receipt.json");
  const content = await readFile(complete);
  await writeFile(target, content, { mode: 0o600 });
  await unlink(complete);
  await symlink(target, complete);
  await assert.rejects(rollbackCommittedLegacyRootAdoptionExperimental(root, { workspaceId }), { code: "RECOVERY_REQUIRED" });
  assert.deepEqual(await readFile(target), content);
});

for (const point of ["intent-published", "journal-archived", "owner-archived", "completed"]) {
  test(`post-commit rollback recovers SIGKILL at ${point}`, { timeout: 60000 }, async t => {
    const root = await fixture(t);
    const adopted = await adoptLegacyRootInPlaceExperimental(root, { experimentalPostCommitRollbackBaseline: true });
    const workspaceId = await adopted.storage.workspaceId();
    await adopted.storage.close();
    const moduleUrl = new URL("../dist/legacy-root-adoption.js", import.meta.url).href;
    const child = spawnSync(process.execPath, ["--input-type=module", "-e", `
      const { rollbackCommittedLegacyRootAdoptionExperimental } = await import(process.argv[1]);
      await rollbackCommittedLegacyRootAdoptionExperimental(process.argv[2], {
        workspaceId: process.argv[3],
        experimentalRollbackCheckpoint: point => { if (point === process.argv[4]) process.kill(process.pid, "SIGKILL"); },
      });
    `, moduleUrl, root, workspaceId, point], { cwd: dirname(fileURLToPath(import.meta.url)), encoding: "utf8", timeout: 30000 });
    assert.equal(child.signal, "SIGKILL", `${child.stdout}\n${child.stderr}`);
    const result = await rollbackCommittedLegacyRootAdoptionExperimental(root, { workspaceId });
    await lstat(join(result.archive, "core.sqlite"));
    await noFile(join(root, ".pkm-next-workspace"));
    assert.equal(await readFile(join(root, "notes/Existing.md"), "utf8"), note);
  });
}

for (const { point, missingMarker } of [
  { point: "intent-published", missingMarker: false },
  { point: "journal-removed", missingMarker: false },
  { point: "intent-published", missingMarker: true },
]) {
  test(`SIGKILL during ${point}${missingMarker ? " before workspace marker" : ""} resumes rollback without opening Next`, { timeout: 60000 }, async t => {
    const root = await fixture(t), original = join(root, "notes/Existing.md");
    const before = await lstat(original, { bigint: true });
    await prepareLegacyRootAdoptionExperimental(root, {});
    if (missingMarker) await unlink(join(root, ".pkm-next-workspace"));
    const moduleUrl = new URL("../dist/legacy-root-adoption.js", import.meta.url).href;
    const child = spawnSync(process.execPath, ["--input-type=module", "-e", `
      const { rollbackPreparedLegacyRootAdoptionExperimental } = await import(process.argv[1]);
      await rollbackPreparedLegacyRootAdoptionExperimental(process.argv[2], {
        experimentalRollbackCheckpoint: point => { if (point === process.argv[3]) process.kill(process.pid, "SIGKILL"); },
      });
    `, moduleUrl, root, point], { cwd: dirname(fileURLToPath(import.meta.url)), encoding: "utf8", timeout: 30000 });
    assert.equal(child.signal, "SIGKILL", child.stderr);
    await noFile(join(root, ".pkm-next-workspace"));
    await assert.rejects(Storage.open(root), { code: "INVALID_WORKSPACE" });
    await assert.rejects(resumeLegacyRootAdoptionExperimental(root, {}), { code: "RECOVERY_REQUIRED" });
    await rollbackPreparedLegacyRootAdoptionExperimental(root);
    await noFile(join(root, ".pkm-next-root-adoption-rollback.json"));
    await noFile(join(root, ".pkm-next-root-adoption.json"));
    assert.equal(await readFile(original, "utf8"), note);
    assert.equal((await lstat(original, { bigint: true })).ino, before.ino);
  });
}

test("rollback recovers a journal written before its workspace marker", { timeout: 60000 }, async t => {
  const root = await fixture(t);
  const prepared = await prepareLegacyRootAdoptionExperimental(root, {});
  await unlink(join(root, ".pkm-next-workspace"));
  const result = await rollbackPreparedLegacyRootAdoptionExperimental(root);
  assert.equal(result.workspaceId, prepared.workspaceId);
  await noFile(join(root, ".pkm-next-root-adoption.json"));
  await noFile(join(root, ".pkm-next-root-adoption-rollback.json"));
  assert.equal(await readFile(join(root, "notes/Existing.md"), "utf8"), note);
});

test("legacy write during interrupted rollback leaves the journal and intent for recovery", { timeout: 60000 }, async t => {
  const root = await fixture(t);
  assert(legacyDist, "PKM_LEGACY_DIST must point to an isolated compiled legacy extension");
  await prepareLegacyRootAdoptionExperimental(root, {});
  await assert.rejects(rollbackPreparedLegacyRootAdoptionExperimental(root, {
    experimentalRollbackCheckpoint: point => { if (point === "intent-published") throw new Error("fixture interruption"); },
  }), /fixture interruption/);
  const oldStore = require(join(legacyDist, "knowledge/filestore.js"));
  oldStore.setStorePath(root);
  oldStore.noteUpsert({ slug: "Existing", title: "Existing", type: "note", tags: [], content: "Legacy concurrent change.\n" });
  await assert.rejects(rollbackPreparedLegacyRootAdoptionExperimental(root), { code: "SOURCE_CHANGED" });
  assert.match(await readFile(join(root, "notes/Existing.md"), "utf8"), /Legacy concurrent change/);
  await lstat(join(root, ".pkm-next-root-adoption.json"));
  await lstat(join(root, ".pkm-next-root-adoption-rollback.json"));
  await noFile(join(root, ".pkm-next-workspace"));
  await assert.rejects(Storage.open(root), { code: "INVALID_WORKSPACE" });
});

test("duplicate workspace marker cannot leave an unjournaled Next workspace during rollback", { timeout: 60000 }, async t => {
  const root = await fixture(t);
  const prepared = await prepareLegacyRootAdoptionExperimental(root, {});
  await assert.rejects(rollbackPreparedLegacyRootAdoptionExperimental(root, {
    experimentalRollbackCheckpoint: point => { if (point === "intent-published") throw new Error("fixture interruption"); },
  }), /fixture interruption/);
  await writeFile(join(root, ".pkm-next-workspace"), JSON.stringify({
    schema: "pkm.next-workspace/v2", id: prepared.workspaceId,
  }), { mode: 0o600 });
  await assert.rejects(rollbackPreparedLegacyRootAdoptionExperimental(root), { code: "RECOVERY_REQUIRED" });
  await lstat(join(root, ".pkm-next-root-adoption.json"));
  await lstat(join(root, ".pkm-next-root-adoption-rollback.json"));
  await assert.rejects(Storage.open(root), { code: "INVALID_WORKSPACE" });
});

test("changed old data or a published Next Note is never removed by prepared-only rollback", { timeout: 60000 }, async t => {
  const changed = await fixture(t), changedNote = join(changed, "notes/Existing.md");
  await prepareLegacyRootAdoptionExperimental(changed, {});
  assert(legacyDist, "PKM_LEGACY_DIST must point to an isolated compiled legacy extension");
  const oldStore = require(join(legacyDist, "knowledge/filestore.js"));
  oldStore.setStorePath(changed);
  oldStore.noteUpsert({ slug: "Existing", title: "Existing", type: "note", tags: [], content: "Changed synthetic content.\n" });
  await assert.rejects(rollbackPreparedLegacyRootAdoptionExperimental(changed), { code: "SOURCE_CHANGED" });
  assert.match(await readFile(changedNote, "utf8"), /Changed synthetic/);
  await lstat(join(changed, ".pkm-next-root-adoption.json"));

  const root = await fixture(t);
  const adopted = await adoptLegacyRootInPlaceExperimental(root, {});
  const runtime = await createNativeRuntime({ storage: adopted.storage });
  try {
    const result = await legacyKnowledgeWrite(runtime.core, adopted.storage, { id: "fixture-owner", canWrite: true }, {
      tool: "update_note", arguments: { slug: "Existing", content: "Next committed write.\n" },
    });
    assert.deepEqual(JSON.parse(result.text), { ok: true, slug: "Existing" });
  } finally { await runtime.close(); await adopted.storage.close(); }
  const published = await readFile(join(root, "notes/Existing.md"));
  await assert.rejects(rollbackPreparedLegacyRootAdoptionExperimental(root), { code: "RECOVERY_REQUIRED" });
  assert.deepEqual(await readFile(join(root, "notes/Existing.md")), published);
  assert.match(published.toString(), /Next committed write/);
  await lstat(join(root, "core.sqlite"));
  await lstat(join(root, ".pkm-next-root-adoption.commit.json"));
  const reopened = await Storage.open(root);
  const reopenedRuntime = await createNativeRuntime({ storage: reopened });
  try {
    const result = await reopenedRuntime.core.dispatch("capability_read", {
      operation: "knowledge.note.get", version: 1, arguments: { id: "synthetic-note" },
    }, { id: "fixture-owner", canWrite: true });
    assert.equal(result.error, undefined, JSON.stringify(result));
    assert.equal(result.result.item.content, "Next committed write.\n");
  } finally { await reopenedRuntime.close(); await reopened.close(); }
});

test("a drained, rotated and refenced managed session is preserved by the in-place adoption receipt", { timeout: 60000 }, async t => {
  const root = await fixture(t);
  assert(managedDist, "PKM_MANAGED_DIST must point to the isolated compiled current extension");
  const session = require(join(managedDist, "runtime/managed-writer-session.js"));
  await mkdir(join(root, ".pkm/state"), { recursive: true, mode: 0o700 });
  await writeFile(join(root, ".pkm/content-privacy.json"), '{"schema":1,"private":{"notes":[]}}', { mode: 0o600 });
  const id = randomUUID();
  session.provisionManagedWriterSession(root, id);
  const profile = session.registerManagedProfile(root, id, hash("synthetic-profile"), true);
  session.completeManagedProfile(root, profile);
  session.closeManagedWriterAdmission(root, id);
  assert.equal(session.fenceManagedWriterSession(root, id).registeredWritersDrained, true);
  const successor = session.rotateManagedWriterSession(root, id);
  assert.equal(successor.cutoverAuthorized, false);
  session.closeManagedWriterAdmission(root, successor.sessionId);
  assert.equal(session.fenceManagedWriterSession(root, successor.sessionId).registeredWritersDrained, true);
  const plan = await planLegacyImport(root, {}, { inPlaceAdoption: true });
  assert.equal(plan.ready, true, JSON.stringify(plan.blockers));
  assert.equal(plan.inPlaceManagedWriterSession.sessionId, successor.sessionId);
  assert.equal(plan.inPlaceManagedWriterSession.files.some(file => file.path.endsWith("/fenced")), true);
  const prepared = await prepareLegacyRootAdoptionExperimental(root, {
    snapshotAdmission: {
      authorityId: "synthetic-root-snapshot-authority",
      allowedTools: ["knowledge_snapshot_status"],
      authorize: () => true,
    },
  });
  assert.equal(prepared.recoveredPendingPlan, false);
  await lstat(join(root, ".pkm-next-root-adoption.json"));
  await assert.rejects(lstat(join(root, "core.sqlite")), { code: "ENOENT" });
  assert.equal(await readFile(join(root, "notes/Existing.md"), "utf8"), note);
});

test("an unrotated managed session remains an exact adoption blocker", { timeout: 60000 }, async t => {
  const root = await fixture(t);
  assert(managedDist, "PKM_MANAGED_DIST must point to the isolated compiled current extension");
  await mkdir(join(root, ".pkm/state"), { recursive: true, mode: 0o700 });
  await writeFile(join(root, ".pkm/content-privacy.json"), '{"schema":1,"private":{"notes":[]}}', { mode: 0o600 });
  const session = require(join(managedDist, "runtime/managed-writer-session.js"));
  const id = randomUUID();
  session.provisionManagedWriterSession(root, id);
  await assert.rejects(planLegacyImport(root, {}, { inPlaceAdoption: true }), error => {
    assert.equal(error.code, "PKM_STATE_UNSUPPORTED");
    assert.equal(error.path, ".pkm/state/managed-writer-session");
    return true;
  });
  assert.deepEqual(await readdir(join(root, ".pkm/state/managed-writer-session")), ["operations", "session.json"]);
  await noFile(join(root, ".pkm-next-root-adoption.json"));
});
