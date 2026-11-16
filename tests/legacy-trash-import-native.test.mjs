import assert from "node:assert/strict";
import { test } from "node:test";
import { randomUUID } from "node:crypto";
import { createRequire, syncBuiltinESMExports } from "node:module";
import fs from "node:fs";
import { existsSync, readFileSync } from "node:fs";
import { cp, mkdir, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { runInThisContext } from "node:vm";
import { DatabaseSync } from "node:sqlite";
import ts from "typescript";
import {
  planLegacyTrashImport, stageLegacyTrashImport, verifyLegacyTrashStage, verifyLegacyTrashSource,
  publishLegacyTrashStage, inspectLegacyTrashImportRecovery, snapshotLegacyTrashTree,
  legacyTrashImportSha256 as hash, legacyTrashImportSharedSeams,
  populateLegacyTrashImportStage,
} from "../dist/legacy-trash-import.js";
import {
  adoptLegacyTrashImport, LegacyTrashNativeAccess, readLegacyTrashAdoptionReceipt,
  readLegacyTrashHistory, inspectLegacyTrashNative,
} from "../dist/legacy-trash-import-native.js";
import { captureLegacyTrashBackup, restoreLegacyTrashBackup } from "../dist/legacy-trash-import-backup.js";
import { legacyTrashImportOriginal } from "../dist/domain/legacy-trash-import-original.js";
import { scanMarkdown, sha256 } from "../dist/markdown.js";
import { planTrashRestore, serializeTrashLifecyclePlan } from "../dist/trash-lifecycle.js";
import { acquireLinuxRootWriterFence, markLinuxRootNextOwned } from "../dist/linux-root-writer-fence.js";
import { readOriginalSource } from "../scripts/migration.mjs";
import { originalReleaseModules } from "./legacy-release-modules.mjs";

const require = createRequire(import.meta.url);
const repo = resolve(import.meta.dirname, "../legacy");
const releaseModules = originalReleaseModules();
const writer = releaseModules("src/knowledge/filestore.ts");
const deletionWriter = releaseModules("src/knowledge/knowledge-deletion-journal.ts");
const actor = "batch11:isolated-original-trash-oracle";
const code = expected => error => { assert.equal(error.code, expected, error.message); return true; };
const receiptsDDL = `CREATE TABLE receipts(operation_id TEXT PRIMARY KEY,fingerprint TEXT NOT NULL,
 result TEXT NOT NULL,actor_id TEXT NOT NULL,operation TEXT NOT NULL,created_at TEXT NOT NULL) STRICT;`;
async function hashes(root) {
  const snapshot = await snapshotLegacyTrashTree(root);
  return snapshot.inventory.map(({ dev, ino, ...entry }) => entry);
}
async function parentStageAuthority(stage, scope = { excludedRootNames: [], excludedStateNames: [] }) {
  const { lstat } = await import("node:fs/promises");
  const root = await lstat(stage);
  const originalRoots = (await readdir(stage)).sort();
  async function inventory() {
    const result = [];
    async function walk(path) {
      const stat = await lstat(join(stage, path));
      assert.equal(stat.isSymbolicLink(), false);
      result.push({ path, kind: stat.isDirectory() ? "directory" : "file",
        dev: stat.dev, ino: stat.ino, sha256: stat.isFile() ? hash(await readFile(join(stage, path))) : null });
      if (stat.isDirectory()) for (const child of (await readdir(join(stage, path))).sort()) await walk(`${path}/${child}`);
    }
    for (const path of scope.excludedRootNames) if (originalRoots.includes(path)) await walk(path);
    return result;
  }
  const original = await inventory(), inventorySha256 = hash(JSON.stringify(original));
  return { stage, dev: root.dev, ino: root.ino, inventorySha256, excludedRootNames: scope.excludedRootNames,
    async verifyInventory() {
      const roots = await readdir(stage);
      assert.equal(roots.some(name => !originalRoots.includes(name)
        && !["notes", "skills", "papers", ".legacy-trash-import.json", "core.sqlite"].includes(name)), false, "unknown parent-owned stage entry");
      assert.deepEqual(await inventory(), original, "parent-owned paths/bytes must remain pinned");
      return inventorySha256;
    } };
}
async function fixture(t, area = "notes", kind = "document", extras = false, missingParent = false) {
  const parent = resolve(import.meta.dirname, `.legacy-trash-import-${randomUUID()}`);
  const source = join(parent, "original"), destination = join(parent, "native"), stage = join(parent, "native-stage");
  const oracle = join(parent, "original-oracle");
  await mkdir(join(source, area, "Team"), { recursive: true });
  if (area !== "notes") await mkdir(join(source, "notes"), { recursive: true });
  const path = kind === "document" ? "Team/One.md" : "Team";
  const bytes = Buffer.from([255, 0, 128, 13, 10, 9, 0]);
  const one = '---\r\n# exact original opaque attributes\r\ndocumentId: original-trash-one\r\nknowledgeId: knowledge_000000000000000000000001\r\nrevision: 7\r\nsourceId: "imported-original-source-01"\r\ntitle: "Original One"\r\ncustom: [keep, exact]\r\n---\r\n![paired](One.assets/bytes.bin?q=1#view)\r\n';
  const two = '---\ndocumentId: original-trash-two\nknowledgeId: knowledge_000000000000000000000002\nrevision: 3\nsourceId: "imported-original-source-02"\n---\nSecond.\n';
  async function put(path, bytes, root = source) {
    const full = join(root, path); await mkdir(dirname(full), { recursive: true }); await writeFile(full, bytes);
  }
  await put(`${area}/Team/One.md`, one);
  await put(`${area}/Team/One.assets/bytes.bin`, bytes);
  await mkdir(join(source, area, "Team/One.assets/empty"));
  if (kind === "folder") await put(`${area}/Team/Two.md`, two);
  await put("notes/Outside.md", "---\ndocumentId: original-outside\nrevision: 1\n---\nOutside.\n");
  deletionWriter.recordKnowledgeResourceMutation(source, ["notes/PermanentlyGone.md"], [], () => true);
  const before = scanMarkdown(source).map(doc => ({ ...doc.record, sourceId: doc.metadata.get("sourceId"), knowledgeId: doc.metadata.get("knowledgeId") }));
  writer.setStorePath(source);
  const entry = area === "skills"
    ? kind === "folder" ? writer.skillFolderMoveToTrash("Team") : writer.knowledgePathMoveToTrash("skills", path)
    : writer.knowledgeMoveToTrash(area, path, kind === "folder" ? "folder" : "item", "Opaque original display name");
  assert.ok(entry, "fixture is created by the ORIGINAL mutation, never fabricated trash metadata");
  if (extras) {
    for (const [extraArea, extraName] of [[area, "Extra"], ["papers", "Unselected"]]) {
      await put(`${extraArea}/${extraName}.md`, `---\ndocumentId: trash-${extraName}\nrevision: 1\n---\n${extraName}\n`);
      assert.ok(writer.knowledgeMoveToTrash(extraArea, `${extraName}.md`, "item", extraName));
    }
  }
  const historyBytes = await readFile(join(source, ".pkm/state/knowledge-deletions.json"));
  const metadataBytes = await readFile(join(source, area, ".trash", entry.id, "metadata.json"));
  if (missingParent) await rm(join(source, area, "Team"), { recursive: true, force: true });
  await cp(source, oracle, { recursive: true });
  const sourceHashes = await hashes(source);
  const plan = await planLegacyTrashImport(source);
  const workspaceId = randomUUID();
  const authority = { source, destination, stage, workspaceId, actorId: actor,
    planSha256: plan.planSha256, layoutVersion: "pkm.trash-lifecycle/v1" };
  const hosts = [];
  async function hostFactory(root = destination, id = workspaceId) {
    const database = new DatabaseSync(join(root, "core.sqlite"));
    if (!database.prepare("SELECT 1 FROM sqlite_master WHERE name='receipts'").get()) database.exec(receiptsDDL);
    let locked = false, allowed = true, indexCommits = 0, failCommit = false;
    const host = {
      database, root, workspaceId: id, trustedImportPlanSha256: plan.planSha256,
      async withWriterLock(work) {
        assert.equal(database.isTransaction, false); assert.equal(locked, false);
        locked = true; try { return await work(); } finally { locked = false; }
      },
      transaction(work) {
        assert.equal(locked, true); assert.equal(database.isTransaction, false);
        database.exec("BEGIN IMMEDIATE");
        try { const result = work(); if (failCommit) throw new Error("synthetic SQL publication interruption"); database.exec("COMMIT"); return result; }
        catch (error) { database.exec("ROLLBACK"); throw error; }
      },
      reconcileIndex() { assert.equal(database.isTransaction, true); indexCommits++; },
      assertOperationAvailable(id) {
        assert.equal(database.isTransaction, true);
        assert.equal(database.prepare("SELECT 1 FROM receipts WHERE operation_id=?").get(id), undefined);
      },
      authorize(id) { return allowed && id === actor; },
      allow(value) { allowed = value; },
      failCommit(value) { failCommit = value; },
      indexCommits() { return indexCommits; },
      async close() { if (database.isOpen) database.close(); },
    };
    hosts.push(host); return host;
  }
  async function adopt() {
    await stageLegacyTrashImport(plan, destination, authority);
    assert.equal(await inspectLegacyTrashImportRecovery(plan, authority), "staged");
    await publishLegacyTrashStage(stage, destination);
    assert.equal(await inspectLegacyTrashImportRecovery(plan, authority), "published");
    const host = await hostFactory();
    await adoptLegacyTrashImport(host, plan, authority);
    return { host, access: new LegacyTrashNativeAccess(host) };
  }
  t.after(async () => { for (const host of hosts) await host.close(); await rm(parent, { recursive: true, force: true }); });
  return { parent, source, destination, stage, oracle, path, area, kind, bytes, one, two, before, entry,
    historyBytes, metadataBytes, sourceHashes, plan, authority, workspaceId, put, hostFactory, adopt };
}

test("native trash inventory validates generated root markers without accepting them as original source or excluding forged bindings",
  { skip: process.platform !== "linux" }, async t => {
    const root = resolve(import.meta.dirname, `.trash-marker-${randomUUID()}`);
    await mkdir(root, { mode: 0o700 });
    t.after(() => rm(root, { recursive: true, force: true }));
    const fence = await acquireLinuxRootWriterFence(root);
    try { await markLinuxRootNextOwned(root, fence); }
    finally { await fence.release(); }
    assert.deepEqual((await snapshotLegacyTrashTree(root, true)).inventory, []);
    await assert.rejects(snapshotLegacyTrashTree(root), code("UNKNOWN_LAYOUT"));
    const markerPath = join(root, ".pkm-next-writer-fenced.json");
    const marker = JSON.parse(await readFile(markerPath, "utf8"));
    await writeFile(markerPath, JSON.stringify({ ...marker, root: dirname(root) }));
    for (const scope of [undefined, { excludedRootNames: [".pkm-next-writer-fenced.json"], excludedStateNames: [] }])
      await assert.rejects(snapshotLegacyTrashTree(root, true, scope), code("RECOVERY_REQUIRED"));
  });

for (const area of ["notes", "skills", "papers"]) {
  test(`ORIGINAL ${area} restore with absent parents imports without provisioning and matches original bytes/history`, async t => {
    const f = await fixture(t, area, "document", false, true), { host, access } = await f.adopt();
    assert.equal(existsSync(join(f.destination, area, "Team")), false, "adoption is not a restore");
    const operationId = randomUUID();
    writer.setStorePath(f.oracle);
    const oracleResult = area === "skills" ? writer.skillTrashRestore(f.entry.id) : writer.knowledgeTrashRestore(area, f.entry.id);
    assert.equal(oracleResult.ok, true, oracleResult.error);
    const result = await access.restore(actor, area, f.entry.id, operationId);
    assert.equal(result.action, "restore");
    assert.equal(result.path, oracleResult.path);
    assert.deepEqual(await readFile(join(f.destination, area, f.path)), await readFile(join(f.oracle, area, f.path)));
    assert.deepEqual(await readFile(join(f.destination, area, "Team/One.assets/bytes.bin")), f.bytes);
    assert.deepEqual(readLegacyTrashHistory(host).current,
      JSON.parse(await readFile(join(f.oracle, ".pkm/state/knowledge-deletions.json"), "utf8")));
    assert.deepEqual(readLegacyTrashHistory(host).originalBytes, f.historyBytes);
    assert.deepEqual(await access.restore(actor, area, f.entry.id, operationId), result);
    assert.deepEqual(await hashes(f.source), f.sourceHashes);
    access.close();
    const reopened = new LegacyTrashNativeAccess(await f.hostFactory());
    assert.deepEqual(await reopened.list(actor), []);
    assert.deepEqual(await reopened.restore(actor, area, f.entry.id, operationId), result);
    reopened.close();
  });
}

for (const [area, kind] of [["notes", "document"], ["notes", "folder"], ["skills", "document"], ["skills", "folder"], ["papers", "folder"]]) {
  test(`permanent ORIGINAL ${area}/${kind} deletion preserves history and survives native restart/backup`, async t => {
    const f = await fixture(t, area, kind), { host, access } = await f.adopt();
    const operationId = randomUUID(), operation = "knowledge.trash.delete.original";
    const args = { operationId, area, originalId: f.entry.id };
    writer.setStorePath(f.oracle);
    const oracle = area === "skills" ? writer.skillTrashDelete(f.entry.id) : writer.knowledgeTrashDelete(area, f.entry.id);
    assert.equal(oracle.ok, true, oracle.error);
    const result = await access.purge(actor, operation, args);
    assert.equal(result.ok, true);
    assert.equal(result.count, 1);
    assert.equal(result.entries[0].name, oracle.name);
    assert.equal(result.entries[0].path, f.path);
    assert.deepEqual(await access.list(actor), []);
    assert.deepEqual(await access.purge(actor, operation, args), result);
    await assert.rejects(access.restore(actor, area, f.entry.id, randomUUID()), code("NOT_FOUND"));
    await assert.rejects(access.get(actor, area, f.entry.id), code("NOT_FOUND"));
    await assert.rejects(access.purge(actor, operation, { ...args, operationId: randomUUID() }), code("NOT_FOUND"));
    await assert.rejects(access.purge("other-actor", operation, args), code("ACCESS_DENIED"));
    assert.deepEqual(readLegacyTrashHistory(host).originalBytes, f.historyBytes);
    assert.deepEqual(readLegacyTrashHistory(host).current, JSON.parse(f.historyBytes.toString("utf8")));
    await assert.rejects(readFile(join(f.destination, area, ".trash", f.plan.entries[0].runtimeId, "payload")), { code: "ENOENT" });
    assert.deepEqual(await hashes(f.source), f.sourceHashes);
    access.close();
    const reopened = await f.hostFactory();
    const again = new LegacyTrashNativeAccess(reopened);
    assert.deepEqual(await again.list(actor), []);
    assert.deepEqual(await again.purge(actor, operation, args), result);
    const backupFile = join(f.parent, "purged-backup.json");
    const backupSha256 = await captureLegacyTrashBackup(reopened, actor, backupFile);
    const destination = join(f.parent, "purged-restored"), stage = join(f.parent, "purged-stage");
    await restoreLegacyTrashBackup({
      backupFile, backupSha256, workspaceId: f.workspaceId, actorId: actor,
      trustedImportPlanSha256: f.plan.planSha256, destination, stage, layoutVersion: "pkm.trash-lifecycle/v1",
    }, f.hostFactory, () => true);
    const restoredHost = await f.hostFactory(destination), restored = new LegacyTrashNativeAccess(restoredHost);
    assert.deepEqual(await restored.list(actor), []);
    assert.deepEqual(await restored.purge(actor, operation, args), result);
    await assert.rejects(restored.restore(actor, area, f.entry.id, randomUUID()), code("NOT_FOUND"));
    restored.close(); again.close();
  });
}
test("empty Trash pins the entire area, counts entries, preserves other areas and replays exactly", async t => {
  const f = await fixture(t, "notes", "document", true), { host, access } = await f.adopt();
  const args = { operationId: randomUUID(), area: "notes" };
  writer.setStorePath(f.oracle);
  const oracle = writer.knowledgeTrashEmpty("notes");
  assert.equal(oracle.ok, true);
  const result = await access.purge(actor, "knowledge.trash.empty.original", args);
  assert.equal(result.count, oracle.count);
  assert.equal(result.count, 2);
  assert.deepEqual((await access.list(actor)).map(item => item.area), ["papers"]);
  assert.deepEqual(await access.purge(actor, "knowledge.trash.empty.original", args), result);
  assert.equal((await access.purge(actor, "knowledge.trash.empty.original", {
    operationId: randomUUID(), area: "notes",
  })).count, 0);
  await assert.rejects(access.purge(actor, "knowledge.trash.empty.original", { ...args, area: "papers" }), code("CONFLICT"));
  assert.deepEqual(readLegacyTrashHistory(host).current, JSON.parse(f.historyBytes.toString("utf8")));
  const paper = (await access.list(actor))[0];
  await access.restore(actor, "papers", paper.id, randomUUID());
  assert.match(await readFile(join(f.destination, "papers/Unselected.md"), "utf8"), /Unselected/);
  access.close();
});
test("permanent Trash intent survives effects-before-SQL failure and restarts without revived bytes", async t => {
  const f = await fixture(t), { host, access } = await f.adopt();
  const args = { operationId: randomUUID(), area: f.area, originalId: f.entry.id };
  const transaction = host.transaction.bind(host);
  let calls = 0;
  host.transaction = work => {
    if (++calls === 2) throw new Error("synthetic post-unlink SQL failure");
    return transaction(work);
  };
  await assert.rejects(access.purge(actor, "knowledge.trash.delete.original", args), /post-unlink/);
  assert.equal(host.database.prepare("SELECT COUNT(*) AS n FROM migration_runtime_intents").get().n, 1);
  assert.equal(host.database.prepare("SELECT COUNT(*) AS n FROM receipts").get().n, 0);
  await assert.rejects(readFile(join(f.destination, f.area, ".trash", f.plan.entries[0].runtimeId, "payload")), { code: "ENOENT" });
  access.close(); await host.close();
  const reopened = await f.hostFactory(), again = new LegacyTrashNativeAccess(reopened);
  await assert.rejects(again.recover("other-actor"), code("ACCESS_DENIED"));
  await again.recover(actor);
  assert.deepEqual(await again.list(actor), []);
  assert.equal((await again.purge(actor, "knowledge.trash.delete.original", args)).count, 1);
  assert.equal(reopened.database.prepare("SELECT COUNT(*) AS n FROM migration_runtime_intents").get().n, 0);
  assert.deepEqual(readLegacyTrashHistory(reopened).originalBytes, f.historyBytes);
  again.close();
});
test("partial permanent deletion recovers only matching remaining bytes; unknown files and symlinks are preserved", async t => {
  const f = await fixture(t), { host, access } = await f.adopt();
  const args = { operationId: randomUUID(), area: f.area, originalId: f.entry.id };
  const transaction = host.transaction.bind(host);
  host.transaction = work => {
    const result = transaction(work);
    throw new Error("synthetic interruption after durable intent");
  };
  await assert.rejects(access.purge(actor, "knowledge.trash.delete.original", args), /durable intent/);
  host.transaction = transaction;
  const bucket = join(f.destination, f.area, ".trash", f.plan.entries[0].runtimeId);
  await rm(join(bucket, "assets/bytes.bin"));
  await writeFile(join(bucket, "unexpected.bin"), "external data must survive");
  await assert.rejects(access.recover(actor), code("RECOVERY_CONFLICT"));
  assert.equal(await readFile(join(bucket, "unexpected.bin"), "utf8"), "external data must survive");
  assert.deepEqual(await readFile(join(bucket, "payload")), Buffer.from(f.one));
  await rm(join(bucket, "unexpected.bin"));
  await symlink(join(f.source, f.area, ".trash", f.entry.id, "assets/bytes.bin"), join(bucket, "assets/bytes.bin"));
  await assert.rejects(access.recover(actor), code("UNSAFE_PATH"));
  assert.deepEqual(await readFile(join(f.source, f.area, ".trash", f.entry.id, "assets/bytes.bin")), f.bytes);
  await rm(join(bucket, "assets/bytes.bin"));
  await assert.rejects(access.list(actor), code("PENDING_NATIVE_INTENT"));
  await access.recover(actor);
  assert.deepEqual(await access.list(actor), []);
  assert.deepEqual(readLegacyTrashHistory(host).current, JSON.parse(f.historyBytes.toString("utf8")));
  access.close();
});

test("genuine original AST captures and state schema provenance remain source-grounded", async () => {
  for (const [file, capture] of Object.entries(legacyTrashImportOriginal)) {
    const raw = (await readOriginalSource(file, {
      sha256: capture.sha256, dataset: "linux-candidate-originals",
    })).toString("utf8");
    assert.equal(hash(raw), capture.sha256, file);
    const ast = ts.createSourceFile(file, raw, ts.ScriptTarget.Latest, true);
    for (const [name, text] of Object.entries(capture).filter(([name]) => name !== "sha256")) {
      const declarations = ast.statements.filter(node => node.name?.getText(ast) === name);
      assert.equal(declarations.length, 1, name); assert.equal(declarations[0].getText(ast), text, name);
    }
  }
  assert.match(legacyTrashImportSharedSeams.pendingOriginal, /No original trash compound journal/);
  assert.match(legacyTrashImportSharedSeams.backup, /not opted in/);
});
for (const [area, kind] of [["notes", "document"], ["notes", "folder"], ["skills", "document"], ["skills", "folder"], ["papers", "folder"]]) {
  test(`ORIGINAL ${area}/${kind} writer -> explicit native stage/adoption/list/get/actual restore -> before/after oracle`, async t => {
    const f = await fixture(t, area, kind);
    const { host, access } = await f.adopt();
    const listing = await access.list(actor);
    assert.equal(listing.length, 1); assert.equal(listing[0].id, f.entry.id);
    assert.equal(listing[0].deletedAt, f.entry.deletedAt); assert.equal(listing[0].name, f.entry.name);
    assert.notEqual(listing[0].runtimeEntryId, f.entry.id, "original millisecond ID needs an authenticated UUID projection");
    const get = await access.get(actor, area, f.entry.id);
    assert.deepEqual(get.metadataBytes, f.metadataBytes); assert.deepEqual(get.deletionHistory.originalBytes, f.historyBytes);
    assert.deepEqual(get.files.find(file => file.path.endsWith("bytes.bin")).bytes, f.bytes);
    const receipt = readLegacyTrashAdoptionReceipt(host);
    assert.equal(receipt.original.planSha256, f.plan.planSha256);
    assert.equal(host.database.prepare("SELECT COUNT(*) AS n FROM receipts").get().n, 0, "do not invent historical destination move receipts");
    writer.setStorePath(f.oracle);
    const oracleResult = area === "skills" ? writer.skillTrashRestore(f.entry.id) : writer.knowledgeTrashRestore(area, f.entry.id);
    assert.equal(oracleResult.ok, true, oracleResult.error);
    const operationId = randomUUID();
    const result = await access.restore(actor, area, f.entry.id, operationId);
    assert.equal(result.action, "restore"); assert.equal(result.entryId, listing[0].runtimeEntryId);
    assert.equal(host.indexCommits(), 1);
    assert.deepEqual(await access.restore(actor, area, f.entry.id, operationId), result);
    assert.equal(host.database.prepare("SELECT COUNT(*) AS n FROM receipts").get().n, 1);
    assert.equal(host.database.prepare("SELECT COUNT(*) AS n FROM migration_runtime_intents").get().n, 0);
    assert.equal(host.database.prepare("SELECT COUNT(*) AS n FROM migration_runtime_trash").get().n, 0);
    assert.deepEqual(await access.list(actor), []);
    assert.deepEqual(await readFile(join(f.destination, area, "Team/One.md")), await readFile(join(f.oracle, area, "Team/One.md")));
    assert.deepEqual(await readFile(join(f.destination, area, "Team/One.assets/bytes.bin")), f.bytes);
    const after = scanMarkdown(f.destination).map(doc => ({ ...doc.record, sourceId: doc.metadata.get("sourceId"), knowledgeId: doc.metadata.get("knowledgeId") }));
    assert.deepEqual(after, f.before);
    assert.deepEqual(readLegacyTrashHistory(host).current, deletionWriter.readKnowledgeSyncDeletions(f.oracle).length
      ? { schema: 1, records: deletionWriter.readKnowledgeSyncDeletions(f.oracle) } : { schema: 1, records: [] });
    assert.deepEqual(readLegacyTrashHistory(host).originalBytes, f.historyBytes, "original opaque deletion history persists after restore");
    assert.deepEqual(await hashes(f.source), f.sourceHashes);
    access.close(); await host.close();
    const restarted = await f.hostFactory();
    const again = new LegacyTrashNativeAccess(restarted);
    assert.deepEqual(await again.list(actor), []);
    assert.deepEqual(await again.restore(actor, area, f.entry.id, operationId), result);
    assert.deepEqual(readLegacyTrashHistory(restarted).originalBytes, f.historyBytes);
    again.close();
  });
}
test("native backup/restore rebinds authenticated inode/root projection while retaining original history and identity", async t => {
  const f = await fixture(t, "notes", "document", false, true);
  const { host, access } = await f.adopt();
  const backupFile = join(f.parent, "trash-backup.json");
  const backupSha256 = await captureLegacyTrashBackup(host, actor, backupFile);
  const destination = join(f.parent, "backup-restored"), stage = join(f.parent, "backup-stage");
  const authority = { backupFile, backupSha256, workspaceId: f.workspaceId, actorId: actor,
    trustedImportPlanSha256: f.plan.planSha256, destination, stage, layoutVersion: "pkm.trash-lifecycle/v1" };
  await assert.rejects(restoreLegacyTrashBackup(authority, f.hostFactory), code("AUTHORITY_REQUIRED"));
  await restoreLegacyTrashBackup(authority, f.hostFactory, () => true);
  const restored = await f.hostFactory(destination);
  const native = new LegacyTrashNativeAccess(restored);
  assert.equal((await native.list(actor))[0].id, f.entry.id);
  assert.deepEqual((await native.get(actor, f.area, f.entry.id)).metadataBytes, f.metadataBytes);
  assert.deepEqual(readLegacyTrashHistory(restored).originalBytes, f.historyBytes);
  assert.deepEqual(readLegacyTrashAdoptionReceipt(restored).lineage, [backupSha256]);
  await native.restore(actor, f.area, f.entry.id, randomUUID());
  assert.deepEqual(await readFile(join(destination, f.area, "Team/One.md")), Buffer.from(f.one));
  assert.deepEqual(await readFile(join(destination, f.area, "Team/One.assets/bytes.bin")), f.bytes);
  assert.equal((await access.list(actor)).length, 1, "backup restoration cannot mutate the originating native trash");
  await assert.rejects(restoreLegacyTrashBackup(authority, f.hostFactory, () => true), code("COLLISION"));
  await writeFile(backupFile, Buffer.from("tampered"));
  await assert.rejects(restoreLegacyTrashBackup({ ...authority, destination: join(f.parent, "tampered-destination"), stage: join(f.parent, "tampered-stage") }, f.hostFactory, () => true), code("TAMPER"));
  assert.deepEqual(await hashes(f.source), f.sourceHashes);
  native.close(); access.close();
});
test("restore SQL failure leaves paired bytes and exact native intent for qualified actual restart recovery", async t => {
  const f = await fixture(t), { host, access } = await f.adopt();
  // Persist a real immutable native request/plan, then emulate its assets-first crash prefix.
  const originalPlan = JSON.parse(readLegacyTrashAdoptionReceipt(host).plans[0]);
  const operationId = randomUUID();
  const pins = scanMarkdown(f.destination).map(doc => ({ id: doc.record.id, area: doc.record.area, path: doc.record.path,
    revision: doc.record.revision, sha256: doc.record.sha256 }));
  const args = { operationId, entryId: originalPlan.entryId, expectedScanRevision: sha256(JSON.stringify(pins)) };
  const plan = planTrashRestore(f.destination, actor, originalPlan, args);
  const request = { operation: "knowledge.trash.restore", actorId: actor, args };
  const json = JSON.stringify(request), serialized = serializeTrashLifecyclePlan(plan), fingerprint = hash(json);
  const binding = [operationId, f.workspaceId, f.destination, actor, request.operation, fingerprint, json, serialized];
  host.database.prepare("INSERT INTO migration_runtime_intents VALUES(?,?,?,?,?,?,?,?,?)").run(...binding, hash(JSON.stringify(binding)));
  const { rename } = await import("node:fs/promises");
  await rename(join(f.destination, f.area, ".trash", originalPlan.entryId, "assets"), join(f.destination, f.area, "Team/One.assets"));
  await assert.rejects(access.list(actor));
  host.failCommit(true);
  await assert.rejects(access.recover(actor), /synthetic SQL publication interruption/);
  assert.equal(host.database.prepare("SELECT COUNT(*) AS n FROM migration_runtime_intents").get().n, 1);
  assert.deepEqual(readLegacyTrashHistory(host).originalBytes, f.historyBytes);
  host.failCommit(false); access.close(); await host.close();
  const reopened = await f.hostFactory(), again = new LegacyTrashNativeAccess(reopened);
  await again.recover(actor);
  assert.deepEqual(await again.list(actor), []);
  assert.deepEqual(await readFile(join(f.destination, f.area, "Team/One.md")), Buffer.from(f.one));
  assert.equal(readLegacyTrashHistory(reopened).current.records.length, 1);
  assert.equal(reopened.database.prepare("SELECT COUNT(*) AS n FROM receipts").get().n, 1);
  assert.deepEqual(await hashes(f.source), f.sourceHashes); again.close();
});
for (const [name, mutate, expected] of [
  ["unknown original bucket", async f => f.put("notes/.trash/unknown/payload", "preserve"), "UNKNOWN_BUCKET"],
  ["pending original journal", async f => f.put(".pkm/state/knowledge-trash-intent.json", "{}"), "PENDING_OR_UNKNOWN_JOURNAL"],
  ["original deletion lock", async f => f.put(".pkm/state/knowledge-deletions.json.lock", "pending"), "PENDING_OR_UNKNOWN_JOURNAL"],
  ["original journal temporary", async f => f.put(".pkm/state/knowledge-deletions.json.1.tmp", "pending"), "PENDING_OR_UNKNOWN_JOURNAL"],
  ["unknown original state", async f => f.put(".pkm/state/unrecognized.json", "{}"), "PENDING_OR_UNKNOWN_JOURNAL"],
  ["unsupported prompts trash", async f => f.put("prompts/.trash/unknown/payload", "keep"), "UNKNOWN_LAYOUT"],
  ["source secret", async f => f.put("notes/credentials.json", "never import"), "UNSAFE_PATH"],
  ["outside asset reference", async f => f.put("notes/Outside.md", "---\ndocumentId: original-outside\nrevision: 1\n---\n![shared](Team/One.assets/bytes.bin)"), "REFERENCE_CONFLICT"],
  ["restore collision", async f => f.put("notes/Team/One.md", "---\ndocumentId: collision\n---\nDo not replace."), "COLLISION"],
  ["paired metadata tamper", async f => {
    const entry = { ...f.entry, assetsPath: "Wrong.assets" };
    await f.put(`notes/.trash/${f.entry.id}/metadata.json`, JSON.stringify(entry));
  }, "INCOMPLETE_OR_UNKNOWN_BUCKET"],
  ["history time mismatch", async f => {
    const value = JSON.parse(f.historyBytes); value.records[1].deletedAt = "2000-01-01T00:00:00.000Z";
    await f.put(".pkm/state/knowledge-deletions.json", JSON.stringify(value));
  }, "UNQUALIFIED_DELETION_HISTORY"],
]) {
  test(`${name} fails closed before any import stage/DDL/native effect`, async t => {
    const f = await fixture(t); await mutate(f);
    await assert.rejects(planLegacyTrashImport(f.source), code(expected));
    await assert.rejects(readdir(f.stage), { code: "ENOENT" });
    await assert.rejects(readdir(f.destination), { code: "ENOENT" });
  });
}
test("symlink, tamper, case collisions, absent authority and unrecognized partial-stage fences never overwrite", async t => {
  const f = await fixture(t);
  await assert.rejects(stageLegacyTrashImport(f.plan, f.destination), code("AUTHORITY_REQUIRED"));
  await f.put("notes/SecretLink.md", "", f.source);
  await rm(join(f.source, "notes/SecretLink.md"));
  await symlink(join(f.source, "notes/Outside.md"), join(f.source, "notes/Linked.md"));
  await assert.rejects(planLegacyTrashImport(f.source), code("UNSAFE_PATH"));
  await rm(join(f.source, "notes/Linked.md"));
  await f.put("notes/outside.md", "---\ndocumentId: case-other\n---\nCollision.");
  await assert.rejects(planLegacyTrashImport(f.source), code("COLLISION"));
  await rm(join(f.source, "notes/outside.md"));
  await stageLegacyTrashImport(f.plan, f.destination, f.authority);
  await f.put(`notes/.trash/${f.plan.entries[0].runtimeId}/payload`, "tamper", f.stage);
  await assert.rejects(verifyLegacyTrashStage(f.plan, f.stage, f.authority), code("TAMPER"));
  await assert.rejects(inspectLegacyTrashImportRecovery(f.plan, f.authority), code("TAMPER"));
  await assert.rejects(stageLegacyTrashImport(f.plan, f.destination, f.authority), code("COLLISION"));
  assert.deepEqual(await hashes(f.source), f.sourceHashes);
});
test("native policy, unknown rows/buckets, destination bytes, reference, history and receipt tamper fences", async t => {
  const f = await fixture(t), { host, access } = await f.adopt();
  host.allow(false);
  await assert.rejects(access.list(actor), code("ACCESS_DENIED"));
  await assert.rejects(access.get(actor, f.area, f.entry.id), code("ACCESS_DENIED"));
  await assert.rejects(access.restore(actor, f.area, f.entry.id, randomUUID()), code("ACCESS_DENIED"));
  host.allow(true);
  await assert.rejects(access.list("different:actor"), code("ACCESS_DENIED"));
  await f.put("notes/.trash/unrecognized/payload", "preserve", f.destination);
  await assert.rejects(access.restore(actor, f.area, f.entry.id, randomUUID()), code("UNKNOWN_BUCKET"));
  assert.deepEqual(await readFile(join(f.destination, "notes/.trash/unrecognized/payload")), Buffer.from("preserve"));
  await rm(join(f.destination, "notes/.trash/unrecognized"), { recursive: true });
  await f.put("notes/Team/One.md", "---\ndocumentId: collision\n---\nExisting bytes", f.destination);
  await assert.rejects(access.restore(actor, f.area, f.entry.id, randomUUID()));
  assert.match(await readFile(join(f.destination, "notes/Team/One.md"), "utf8"), /Existing bytes/);
  await rm(join(f.destination, "notes/Team/One.md"));
  await f.put("notes/Outside.md", "---\ndocumentId: original-outside\nrevision: 1\n---\n![outside](Team/One.assets/bytes.bin)", f.destination);
  await assert.rejects(access.restore(actor, f.area, f.entry.id, randomUUID()));
  await f.put("notes/Outside.md", "---\ndocumentId: original-outside\nrevision: 1\n---\nOutside.\n", f.destination);
  const good = host.database.prepare("SELECT * FROM migration_runtime_trash").get();
  host.database.prepare("UPDATE migration_runtime_trash SET digest=?").run("f".repeat(64));
  await assert.rejects(inspectLegacyTrashNative(host), code("TAMPER"));
  host.database.prepare("UPDATE migration_runtime_trash SET digest=?").run(good.digest);
  host.database.prepare("UPDATE legacy_trash_import_history SET current_json='{}'").run();
  await assert.rejects(access.list(actor), code("TAMPER"));
  assert.equal(host.database.prepare("SELECT COUNT(*) AS n FROM receipts").get().n, 0);
  assert.deepEqual(await hashes(f.source), f.sourceHashes); access.close();
});
test("source changes after planning and after stage block adoption with zero native rows", async t => {
  const f = await fixture(t);
  await stageLegacyTrashImport(f.plan, f.destination, f.authority);
  await publishLegacyTrashStage(f.stage, f.destination);
  const host = await f.hostFactory();
  await f.put("notes/Outside.md", "---\ndocumentId: original-outside\nrevision: 2\n---\nChanged");
  await assert.rejects(verifyLegacyTrashSource(f.plan), code("SOURCE_CHANGED"));
  await assert.rejects(adoptLegacyTrashImport(host, f.plan, f.authority), code("SOURCE_CHANGED"));
  assert.equal(host.database.prepare("SELECT COUNT(*) AS n FROM sqlite_master WHERE name='migration_runtime_trash'").get().n, 0);
});
test("actual native restore has no filesystem inspection/effect inside SQL transactions", async t => {
  const f = await fixture(t), { host, access } = await f.adopt();
  const names = ["lstatSync", "readdirSync", "openSync", "readSync", "writeSync", "fsyncSync", "mkdirSync", "unlinkSync", "rmdirSync"];
  const originals = new Map(names.map(name => [name, fs[name]]));
  for (const name of names) fs[name] = (...args) => {
    assert.equal(host.database.isTransaction, false, `${name} must stay outside SQL`);
    return originals.get(name)(...args);
  };
  syncBuiltinESMExports();
  try {
    await access.restore(actor, f.area, f.entry.id, randomUUID());
    assert.equal(host.indexCommits(), 1);
  } finally {
    for (const [name, fn] of originals) fs[name] = fn;
    syncBuiltinESMExports(); access.close();
  }
});
test("source incomplete assets-first state is not an inferred recoverable original journal", async t => {
  const f = await fixture(t);
  const payload = join(f.source, f.area, ".trash", f.entry.id, "payload");
  const bytes = await readFile(payload);
  await rm(payload);
  await assert.rejects(planLegacyTrashImport(f.source), code("INCOMPLETE_OR_UNKNOWN_BUCKET"));
  assert.deepEqual(await readFile(join(f.source, f.area, ".trash", f.entry.id, "assets/bytes.bin")), f.bytes);
  await writeFile(payload, bytes);
});
test("globally colliding knowledge identity and unqualified folder files fail before staging", async t => {
  const f = await fixture(t);
  await f.put("notes/Other.md", "---\ndocumentId: collision-other\nknowledgeId: knowledge_000000000000000000000001\n---\nKeep.");
  await assert.rejects(planLegacyTrashImport(f.source), code("COLLISION"));
  await assert.rejects(readdir(f.stage), { code: "ENOENT" });
  const folder = await fixture(t, "notes", "folder");
  await folder.put(`notes/.trash/${folder.entry.id}/payload/Unowned.bin`, Buffer.from([1, 2, 3]));
  await assert.rejects(planLegacyTrashImport(folder.source), code("UNQUALIFIED_LIFECYCLE"));
  await assert.rejects(readdir(folder.stage), { code: "ENOENT" });
});
test("adoption/global UUID collisions roll back all DDL without inventing import or move records", async t => {
  const f = await fixture(t);
  await stageLegacyTrashImport(f.plan, f.destination, f.authority);
  await publishLegacyTrashStage(f.stage, f.destination);
  const host = await f.hostFactory();
  host.allow(false);
  await assert.rejects(adoptLegacyTrashImport(host, f.plan, f.authority), code("ACCESS_DENIED"));
  host.allow(true);
  host.database.prepare("INSERT INTO receipts VALUES(?,?,?,?,?,?)")
    .run(f.plan.entries[0].runtimeId, "a".repeat(64), "{}", actor, "foreign-operation", "2026-11-07T00:00:00.000Z");
  await assert.rejects(adoptLegacyTrashImport(host, f.plan, f.authority));
  assert.equal(host.database.prepare("SELECT COUNT(*) AS n FROM sqlite_master WHERE name='legacy_trash_import_receipt'").get().n, 0);
  assert.equal(host.database.prepare("SELECT COUNT(*) AS n FROM receipts").get().n, 1);
  assert.deepEqual(await hashes(f.source), f.sourceHashes);
});
test("unknown native journal prevents recovery without any original/native bytes or history effects", async t => {
  const f = await fixture(t), { host, access } = await f.adopt();
  host.database.prepare("INSERT INTO migration_runtime_intents VALUES(?,?,?,?,?,?,?,?,?)")
    .run(randomUUID(), f.workspaceId, f.destination, actor, "unknown.journal", "a".repeat(64), "{}", "{}", "b".repeat(64));
  await assert.rejects(access.recover(actor), code("RECOVERY_CONFLICT"));
  await assert.rejects(access.restore(actor, f.area, f.entry.id, randomUUID()), code("PENDING_NATIVE_INTENT"));
  assert.deepEqual(await readFile(join(f.destination, "notes/.trash", f.plan.entries[0].runtimeId, "payload")), Buffer.from(f.one));
  assert.deepEqual(readLegacyTrashHistory(host).originalBytes, f.historyBytes);
  assert.equal(host.database.prepare("SELECT COUNT(*) AS n FROM receipts").get().n, 0); access.close();
});
test("backup/restart after native restore preserves real restore receipt, opaque original history and no revived trash", async t => {
  const f = await fixture(t), { host, access } = await f.adopt();
  const operationId = randomUUID(), result = await access.restore(actor, f.area, f.entry.id, operationId);
  const backupFile = join(f.parent, "restored-trash-backup.json");
  const backupSha256 = await captureLegacyTrashBackup(host, actor, backupFile);
  const destination = join(f.parent, "after-restore-backup"), stage = join(f.parent, "after-restore-stage");
  await restoreLegacyTrashBackup({ backupFile, backupSha256, workspaceId: f.workspaceId, actorId: actor,
    trustedImportPlanSha256: f.plan.planSha256, destination, stage, layoutVersion: "pkm.trash-lifecycle/v1" }, f.hostFactory, () => true);
  const restored = await f.hostFactory(destination), native = new LegacyTrashNativeAccess(restored);
  assert.deepEqual(await native.list(actor), []);
  assert.deepEqual(await native.restore(actor, f.area, f.entry.id, operationId), result);
  assert.deepEqual(readLegacyTrashHistory(restored).originalBytes, f.historyBytes);
  assert.equal(readLegacyTrashHistory(restored).current.records.length, 1);
  assert.equal(restored.database.prepare("SELECT COUNT(*) AS n FROM receipts").get().n, 1);
  assert.deepEqual(await hashes(f.source), f.sourceHashes); native.close(); access.close();
});
test("external trusted original plan pin rejects self-rehashed forged DB receipt across restart", async t => {
  const f = await fixture(t), { host, access } = await f.adopt();
  const row = host.database.prepare("SELECT * FROM legacy_trash_import_receipt").get();
  const receipt = JSON.parse(row.receipt_json);
  receipt.original.source = join(f.parent, "forged-source");
  const { planSha256, ...body } = receipt.original;
  receipt.original.planSha256 = hash(JSON.stringify(body));
  const json = JSON.stringify(receipt);
  host.database.prepare("UPDATE legacy_trash_import_receipt SET receipt_json=?,digest=?")
    .run(json, hash(JSON.stringify([f.workspaceId, f.destination, json])));
  await assert.rejects(access.list(actor), code("TAMPER"));
  assert.equal(host.database.prepare("SELECT COUNT(*) AS n FROM receipts").get().n, 0); access.close();
});
test("native unknown adoption marker and absent trusted import authority deny all effects", async t => {
  const f = await fixture(t), { host, access } = await f.adopt();
  const trusted = host.trustedImportPlanSha256;
  host.trustedImportPlanSha256 = "";
  await assert.rejects(access.list(actor), code("AUTHORITY_REQUIRED"));
  host.trustedImportPlanSha256 = trusted;
  await writeFile(join(f.destination, ".legacy-trash-import.json"), JSON.stringify({ schema: "unknown-native-journal", intent: "preserve" }));
  await assert.rejects(access.restore(actor, f.area, f.entry.id, randomUUID()), code("TAMPER"));
  assert.equal(host.database.prepare("SELECT COUNT(*) AS n FROM receipts").get().n, 0);
  assert.deepEqual(await readFile(join(f.destination, "notes/.trash", f.plan.entries[0].runtimeId, "payload")), Buffer.from(f.one));
  access.close();
});
test("explicit shared-root scope skips only trusted non-trash roots/state without traversing, retains source/native trash pins", async t => {
  const f = await fixture(t);
  await f.put("project/OwnedByOtherLane.json", "other lane untouched");
  await f.put(".pkm/state/project-store.json", "opaque other control");
  await symlink(join(f.source, "project"), join(f.source, "recipes"));
  const scope = { excludedRootNames: ["project", "recipes"], excludedStateNames: ["project-store.json"] };
  await assert.rejects(planLegacyTrashImport(f.source), code("PENDING_OR_UNKNOWN_JOURNAL"));
  const plan = await planLegacyTrashImport(f.source, scope);
  assert.deepEqual(plan.snapshotScope, scope);
  assert.equal(plan.inventory.some(item => item.path.startsWith("project") || item.path.startsWith("recipes")
    || item.path.endsWith("project-store.json")), false);
  await f.put("project/OwnedByOtherLane.json", "other lane may change");
  await verifyLegacyTrashSource(plan);
  const authority = { ...f.authority, planSha256: plan.planSha256 };
  await stageLegacyTrashImport(plan, f.destination, authority);
  await publishLegacyTrashStage(f.stage, f.destination);
  await f.put("project/NativeOtherLane.json", "native unrelated", f.destination);
  const host = await f.hostFactory();
  host.trustedImportPlanSha256 = plan.planSha256;
  host.snapshotScope = { excludedRootNames: ["project"], excludedStateNames: [] };
  await adoptLegacyTrashImport(host, plan, authority);
  const access = new LegacyTrashNativeAccess(host);
  assert.equal((await access.list(actor))[0].id, f.entry.id);
  await access.restore(actor, f.area, f.entry.id, randomUUID());
  assert.deepEqual(await readFile(join(f.destination, "project/NativeOtherLane.json")), Buffer.from("native unrelated"));
  await f.put(".pkm/state/unknown-intent.json", "{}");
  await assert.rejects(verifyLegacyTrashSource(plan), code("PENDING_OR_UNKNOWN_JOURNAL"));
  access.close();
});
test("snapshot exclusions cannot hide trash, deletion history, pending state, secrets or selected symlinks", async t => {
  const f = await fixture(t);
  for (const name of ["notes", "skills", "papers", ".pkm", "knowledge-trash-intent.json", "credentials"]) {
    await assert.rejects(planLegacyTrashImport(f.source, { excludedRootNames: [name], excludedStateNames: [] }), code("AUTHORITY_REQUIRED"));
  }
  for (const name of ["knowledge-deletions.json", "knowledge-deletions.json.lock", "knowledge-trash-intent.json", "unknown.tmp", "secrets.json"]) {
    await assert.rejects(planLegacyTrashImport(f.source, { excludedRootNames: [], excludedStateNames: [name] }), code("AUTHORITY_REQUIRED"));
  }
  await symlink(join(f.source, "notes/Outside.md"), join(f.source, "notes/Linked.md"));
  await assert.rejects(planLegacyTrashImport(f.source, { excludedRootNames: ["project"], excludedStateNames: [] }), code("UNSAFE_PATH"));
});
test("existing shared-owned stage population preserves exact active files and other lanes then actual native adoption/restore", async t => {
  const f = await fixture(t);
  await mkdir(f.stage);
  await f.put("notes/Outside.md", await readFile(join(f.source, "notes/Outside.md")), f.stage);
  await f.put("project/Other.json", "other lane bytes", f.stage);
  await f.put(".pkm/state/Other.json", "other lane control", f.stage);
  const scope = { excludedRootNames: ["project", ".pkm"], excludedStateNames: [] };
  const parentAuthority = await parentStageAuthority(f.stage, scope);
  const { lstat } = await import("node:fs/promises");
  const before = await lstat(join(f.stage, "notes/Outside.md"));
  await populateLegacyTrashImportStage(f.plan, f.destination, f.authority, scope, parentAuthority);
  assert.equal((await lstat(join(f.stage, "notes/Outside.md"))).ino, before.ino);
  await populateLegacyTrashImportStage(f.plan, f.destination, f.authority, scope, parentAuthority);
  assert.deepEqual(await readFile(join(f.stage, "project/Other.json")), Buffer.from("other lane bytes"));
  await assert.rejects(readdir(f.destination), { code: "ENOENT" });
  await publishLegacyTrashStage(f.stage, f.destination);
  const host = await f.hostFactory(); host.snapshotScope = scope;
  await adoptLegacyTrashImport(host, f.plan, f.authority);
  const access = new LegacyTrashNativeAccess(host);
  await access.restore(actor, f.area, f.entry.id, randomUUID());
  assert.deepEqual(await readFile(join(f.destination, "project/Other.json")), Buffer.from("other lane bytes"));
  assert.deepEqual(await readFile(join(f.destination, "notes/Team/One.md")), Buffer.from(f.one));
  access.close();
});
test("existing shared stage collision preflight writes no trash projection or marker and never replaces active bytes", async t => {
  const f = await fixture(t);
  await f.put("notes/Outside.md", "conflicting active bytes", f.stage);
  const parentAuthority = await parentStageAuthority(f.stage);
  await assert.rejects(populateLegacyTrashImportStage(f.plan, f.destination, f.authority, undefined, parentAuthority), code("COLLISION"));
  assert.deepEqual(await readFile(join(f.stage, "notes/Outside.md")), Buffer.from("conflicting active bytes"));
  await assert.rejects(readFile(join(f.stage, ".legacy-trash-import.json")), { code: "ENOENT" });
  await assert.rejects(readdir(join(f.stage, "notes/.trash")), { code: "ENOENT" });
});
test("composed stage denies missing parent inventory, changed digest/root identity and unknown independently owned bytes before effects", async t => {
  const f = await fixture(t);
  await f.put("project/Pinned.json", "original parent bytes", f.stage);
  const scope = { excludedRootNames: ["project"], excludedStateNames: [] };
  const parent = await parentStageAuthority(f.stage, scope);
  await assert.rejects(populateLegacyTrashImportStage(f.plan, f.destination, f.authority, scope), code("AUTHORITY_REQUIRED"));
  await assert.rejects(populateLegacyTrashImportStage(f.plan, f.destination, f.authority, scope,
    { ...parent, ino: parent.ino + 1 }), code("SOURCE_CHANGED"));
  await assert.rejects(populateLegacyTrashImportStage(f.plan, f.destination, f.authority, scope,
    { ...parent, verifyInventory: async () => "f".repeat(64) }), code("TAMPER"));
  await f.put("project/Unknown.json", "unvalidated parent addition", f.stage);
  await assert.rejects(populateLegacyTrashImportStage(f.plan, f.destination, f.authority, scope, parent));
  await assert.rejects(readdir(join(f.stage, "notes")), { code: "ENOENT" });
  await assert.rejects(readFile(join(f.stage, ".legacy-trash-import.json")), { code: "ENOENT" });
  assert.deepEqual(await hashes(f.source), f.sourceHashes);
});
