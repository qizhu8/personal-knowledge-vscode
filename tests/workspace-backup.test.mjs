import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { cp, lstat, mkdir, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import test from "node:test";
import { DatabaseSync } from "node:sqlite";
import { createWorkspaceBackup, restoreWorkspaceBackup, WorkspaceBackupError } from "../dist/workspace-backup.js";
import { initialize, Storage } from "../dist/storage.js";

const request = (operation, args) => ({ operation, args, actorId: "test:owner" });
const nativeRestoreAuthority = {
  actorId: "test:owner",
  async authorize(request) {
    return { authorityId: "disposable-fixture", actorId: request.actorId,
      requestSha256: createHash("sha256").update(JSON.stringify(request)).digest("hex"),
      expiresAt: Date.now() + 60_000, lineage: "unrelated", trustedEpoch: null };
  },
};
async function workspace(t) {
  const parent = resolve("tests", `.workspace-backup-${randomUUID()}`);
  await mkdir(parent, { recursive: true });
  const source = join(parent, "source");
  await initialize(source);
  const storage = await Storage.open(source);
  t.after(async () => {
    await storage.close();
    await rm(parent, { recursive: true, force: true });
  });
  return { parent, source, storage };
}
const host = () => {
  let held = false;
  return {
    acquireQuiescence: async () => {
      assert.equal(held, false);
      held = true;
      return { assertHeld: () => assert.equal(held, true), release: () => { held = false; } };
    },
  };
};
async function expectBackupError(promise, code) {
  await assert.rejects(promise, error => error instanceof WorkspaceBackupError && error.code === code);
}

test("quiescent backup and absent-destination restore preserve Markdown, assets, workspace identity and standalone SQLite", { timeout: 20_000 }, async t => {
  const f = await workspace(t);
  const created = await f.storage.request(request("knowledge.document.create", {
    id: "synthetic-note", operationId: randomUUID(), title: "Synthetic only", content: "bounded fixture body",
  }));
  const createRequest = request("knowledge.document.create", {
    id: "receipt-note", operationId: randomUUID(), title: "Receipt fixture", content: "committed before WAL snapshot",
  });
  const receipt = await f.storage.request(createRequest);
  assert.equal(created.revision, 1);
  const assets = join(f.source, "notes", "synthetic-note.assets");
  await mkdir(assets);
  await writeFile(join(assets, "attachment.bin"), Buffer.from([0, 1, 2, 255]));
  const identity = await f.storage.workspaceId();
  const backupPath = join(f.parent, "backup");
  const acquired = host();
  const start = Date.now();
  const backup = await createWorkspaceBackup(f.storage, backupPath, acquired);
  const backupMs = Date.now() - start;
  assert.equal(backup.workspaceId, identity);
  assert.equal(backup.fileCount, 5);
  const manifest = JSON.parse(await readFile(join(backupPath, ".pkm-workspace-backup.json"), "utf8"));
  if (process.platform !== "win32") {
    for (const path of [".pkm-workspace-backup.json", ...manifest.files.map(file => file.path)])
      assert.equal((await lstat(join(backupPath, path))).mode & 0o777, 0o600, `Archive bytes stay private: ${path}`);
  }
  assert.deepEqual(await readFile(join(backupPath, "notes", "synthetic-note.assets", "attachment.bin")), Buffer.from([0, 1, 2, 255]));
  assert.deepEqual((await readdir(backupPath)).sort(), [".pkm-next-workspace", ".pkm-workspace-backup.json", "core.sqlite", "notes"].sort());
  for (const suffix of ["-wal", "-shm"]) await assert.rejects(readFile(join(backupPath, `core.sqlite${suffix}`)), { code: "ENOENT" });
  await expectBackupError(createWorkspaceBackup(f.storage, backupPath, acquired), "DESTINATION_EXISTS");

  const restored = join(f.parent, "restored");
  const restore = await restoreWorkspaceBackup(backupPath, restored, { nativeRestoreAuthority });
  assert.equal(restore.workspaceId, identity);
  assert.equal(restore.fileCount, backup.fileCount);
  assert.equal(await readFile(join(restored, "notes", "synthetic-note.md"), "utf8"), await readFile(join(f.source, "notes", "synthetic-note.md"), "utf8"));
  assert.deepEqual(await readFile(join(restored, "notes", "synthetic-note.assets", "attachment.bin")), Buffer.from([0, 1, 2, 255]));
  const reopened = await Storage.open(restored);
  try {
    assert.equal(await reopened.workspaceId(), identity);
    const read = await reopened.request({ operation: "knowledge.document.get", args: { id: "synthetic-note" }, actorId: "test:reader" });
    assert.equal(read.id, "synthetic-note");
    assert.deepEqual(await reopened.request(createRequest), receipt, "committed receipt survives the standalone SQLite snapshot");
  } finally { await reopened.close(); }
  await assert.rejects(restoreWorkspaceBackup(backupPath, restored), { code: "DESTINATION_EXISTS" });
  console.log(`WORKSPACE_BACKUP_RESULTS ${JSON.stringify({ backupMs, files: backup.fileCount, bytes: backup.totalBytes, restoreVerified: true })}`);
});

test("restore accepts older manifests without Markdown times and rejects malformed time fields", { timeout: 20_000 }, async t => {
  const f = await workspace(t);
  await f.storage.request(request("knowledge.document.create", {
    id: "old-backup-note", operationId: randomUUID(), title: "Old backup", content: "fixture",
  }));
  const backupPath = join(f.parent, "backup-old-format");
  await createWorkspaceBackup(f.storage, backupPath, host());
  const manifestPath = join(backupPath, ".pkm-workspace-backup.json");
  const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  const note = manifest.files.find(file => file.path === "notes/old-backup-note.md");
  assert.match(note.mtimeNs, /^-?\d+$/);
  note.mtimeNs = "not-a-time";
  await writeFile(manifestPath, JSON.stringify(manifest));
  await expectBackupError(restoreWorkspaceBackup(backupPath, join(f.parent, "malformed"), { nativeRestoreAuthority }), "INVALID_MANIFEST");
  delete note.mtimeNs;
  await writeFile(manifestPath, JSON.stringify(manifest));
  await restoreWorkspaceBackup(backupPath, join(f.parent, "old-restored"), { nativeRestoreAuthority });
  assert.equal(await readFile(join(f.parent, "old-restored", note.path), "utf8"), await readFile(join(f.source, note.path), "utf8"));
});

test("backup refuses unknown pending journals, source symlinks, quota excess and uncoordinated hosts", { timeout: 20_000 }, async t => {
  const f = await workspace(t);
  const destination = join(f.parent, "must-not-publish");
  await expectBackupError(createWorkspaceBackup(f.storage, destination, {}), "QUIESCENCE_REQUIRED");
  const database = f.storage.connectNative();
  try { database.exec("CREATE TABLE pending_future_journal(value TEXT NOT NULL); INSERT INTO pending_future_journal VALUES('synthetic-only');"); }
  finally { database.close(); }
  await expectBackupError(createWorkspaceBackup(f.storage, destination, host()), "PENDING_JOURNAL");
  await assert.rejects(readdir(destination), { code: "ENOENT" });

  const clean = join(f.parent, "clean");
  const isolated = await initialize(clean);
  const other = await Storage.open(isolated);
  try {
    await expectBackupError(createWorkspaceBackup(other, join(f.parent, "total-quota"), host(), {
      limits: { maxTotalBytes: 1024 },
    }), "QUOTA_EXCEEDED");
    await writeFile(join(isolated, "notes", "oversize.bin"), Buffer.alloc(64));
    await expectBackupError(createWorkspaceBackup(other, join(f.parent, "quota"), host(), {
      limits: { maxFileBytes: 32 },
    }), "QUOTA_EXCEEDED");
    await rm(join(isolated, "notes", "oversize.bin"));
    await symlink(join(isolated, "notes"), join(isolated, "skills"));
    await expectBackupError(createWorkspaceBackup(other, join(f.parent, "linked"), host()), "INVALID_WORKSPACE");
  } finally { await other.close(); }
});

test("empty synthetic workspaces retain their empty Notes directory through backup and restore", { timeout: 20_000 }, async t => {
  const f = await workspace(t);
  const backupPath = join(f.parent, "empty-backup");
  await createWorkspaceBackup(f.storage, backupPath, host());
  const manifest = JSON.parse(await readFile(join(backupPath, ".pkm-workspace-backup.json"), "utf8"));
  assert.deepEqual(manifest.directories, ["notes"]);
  const restored = join(f.parent, "empty-restored");
  await restoreWorkspaceBackup(backupPath, restored, { nativeRestoreAuthority });
  assert.deepEqual(await readdir(join(restored, "notes")), []);
});

test("legacy trash backup and restore require external plan and exact backup authority", { timeout: 20_000 }, async t => {
  const f = await workspace(t), backup = join(f.parent, "trash-backup"), destination = join(f.parent, "trash-restored");
  await createWorkspaceBackup(f.storage, backup, host());
  const workspaceId = await f.storage.workspaceId();
  const receipt = JSON.stringify({ schema: "synthetic-only" });
  const sourceDb = f.storage.connectNative();
  try {
    sourceDb.prepare("INSERT INTO legacy_trash_import_receipt VALUES(?,?,?,?)")
      .run(workspaceId, f.source, receipt, "0".repeat(64));
  } finally { sourceDb.close(); }
  await writeFile(join(f.source, ".legacy-trash-import.json"), receipt);
  await expectBackupError(createWorkspaceBackup(f.storage, join(f.parent, "unauthorized-trash-backup"), host()), "AUTHORITY_REQUIRED");
  await assert.rejects(readdir(join(f.parent, "unauthorized-trash-backup")), { code: "ENOENT" });

  const backupDb = new DatabaseSync(join(backup, "core.sqlite"));
  try {
    backupDb.prepare("INSERT INTO legacy_trash_import_receipt VALUES(?,?,?,?)")
      .run(workspaceId, f.source, receipt, "0".repeat(64));
  } finally { backupDb.close(); }
  const manifestPath = join(backup, ".pkm-workspace-backup.json");
  const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  const sqliteBytes = await readFile(join(backup, "core.sqlite"));
  const hash = bytes => createHash("sha256").update(bytes).digest("hex");
  manifest.files.find(file => file.path === "core.sqlite").size = sqliteBytes.length;
  manifest.files.find(file => file.path === "core.sqlite").sha256 = hash(sqliteBytes);
  manifest.files.sort((left, right) => left.path.localeCompare(right.path));
  manifest.totalBytes = manifest.files.reduce((sum, file) => sum + file.size, 0);
  await writeFile(manifestPath, JSON.stringify(manifest));
  await expectBackupError(restoreWorkspaceBackup(backup, destination), "AUTHORITY_REQUIRED");
  await assert.rejects(readdir(destination), { code: "ENOENT" });
});

test("restore rejects tampered hashes, unsafe paths, symlinks and schema mismatches without publishing", { timeout: 20_000 }, async t => {
  const f = await workspace(t);
  const good = join(f.parent, "good-backup");
  await createWorkspaceBackup(f.storage, good, host());

  const tampered = join(f.parent, "tampered");
  await cp(good, tampered, { recursive: true });
  await writeFile(join(tampered, "tampered.md"), "unlisted");
  await expectBackupError(restoreWorkspaceBackup(tampered, join(f.parent, "bad-hash")), "INVALID_MANIFEST");
  await assert.rejects(readdir(join(f.parent, "bad-hash")), { code: "ENOENT" });

  const changed = join(f.parent, "changed");
  await cp(good, changed, { recursive: true });
  await writeFile(join(changed, ".pkm-next-workspace"), "changed identity");
  await expectBackupError(restoreWorkspaceBackup(changed, join(f.parent, "bad-digest")), "HASH_MISMATCH");

  const mismatchedIdentity = join(f.parent, "mismatched-id");
  await cp(good, mismatchedIdentity, { recursive: true });
  const mismatchedManifestPath = join(mismatchedIdentity, ".pkm-workspace-backup.json");
  const mismatchedManifest = JSON.parse(await readFile(mismatchedManifestPath, "utf8"));
  mismatchedManifest.workspaceId = randomUUID();
  await writeFile(mismatchedManifestPath, JSON.stringify(mismatchedManifest));
  await expectBackupError(restoreWorkspaceBackup(mismatchedIdentity, join(f.parent, "bad-id")), "INVALID_WORKSPACE");

  const unsafe = join(f.parent, "unsafe");
  await cp(good, unsafe, { recursive: true });
  const manifestPath = join(unsafe, ".pkm-workspace-backup.json");
  const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  manifest.files[0].path = "../outside";
  await writeFile(manifestPath, JSON.stringify(manifest));
  await expectBackupError(restoreWorkspaceBackup(unsafe, join(f.parent, "bad-path")), "INVALID_MANIFEST");
  for (const [index, path] of [
    `notes/${"deep/".repeat(68)}../outside`,
    `notes/${"deep/".repeat(68)}/outside`,
    `/notes/${"deep/".repeat(68)}outside`,
    `notes/${"deep/".repeat(68)}C:outside`,
    `notes/${"deep/".repeat(68)}bad\\outside`,
  ].entries()) {
    manifest.files[0].path = path;
    await writeFile(manifestPath, JSON.stringify(manifest));
    await expectBackupError(restoreWorkspaceBackup(unsafe, join(f.parent, `bad-deep-path-${index}`)), "INVALID_MANIFEST");
  }

  const linked = join(f.parent, "linked-backup");
  await cp(good, linked, { recursive: true });
  await symlink(join(linked, "notes"), join(linked, "link"));
  await expectBackupError(restoreWorkspaceBackup(linked, join(f.parent, "bad-link")), "UNSAFE_ENTRY");
  const deepParent = join(linked, "notes", ...Array.from({ length: 68 }, () => "deep"));
  await mkdir(deepParent, { recursive: true });
  await symlink(join(linked, "notes"), join(deepParent, "link"));
  await rm(join(linked, "link"));
  await expectBackupError(restoreWorkspaceBackup(linked, join(f.parent, "bad-deep-link")), "UNSAFE_ENTRY");

  const schema = join(f.parent, "wrong-schema");
  await cp(good, schema, { recursive: true });
  const db = new DatabaseSync(join(schema, "core.sqlite"));
  try {
    db.exec("DROP TABLE legacy_note_workitems_receipt; DROP TABLE legacy_note_workitems_intent; DROP TABLE legacy_note_workitems_admission; DROP TABLE legacy_note_workitems_native_binding; PRAGMA user_version=11");
  } finally { db.close(); }
  const changedBytes = await readFile(join(schema, "core.sqlite"));
  const schemaManifestPath = join(schema, ".pkm-workspace-backup.json");
  const schemaManifest = JSON.parse(await readFile(schemaManifestPath, "utf8"));
  const item = schemaManifest.files.find(file => file.path === "core.sqlite");
  item.size = changedBytes.length;
  const { createHash } = await import("node:crypto");
  item.sha256 = createHash("sha256").update(changedBytes).digest("hex");
  schemaManifest.totalBytes = schemaManifest.files.reduce((sum, file) => sum + file.size, 0);
  await writeFile(schemaManifestPath, JSON.stringify(schemaManifest));
  await expectBackupError(restoreWorkspaceBackup(schema, join(f.parent, "bad-schema")), "SCHEMA_MISMATCH");
});
