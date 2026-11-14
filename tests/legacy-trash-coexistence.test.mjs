import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID, createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import childProcess from "node:child_process";
import { mkdir, writeFile, readFile, rm, symlink } from "node:fs/promises";
import { resolve, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { syncBuiltinESMExports } from "node:module";
import { createRequire } from "node:module";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { planLegacyTrashImport, snapshotLegacyTrashTree } from "../dist/legacy-trash-import.js";
import { planLegacyImport, importLegacyWorkspace } from "../dist/legacy-import.js";
import { createNativeRuntime } from "../dist/native-runtime.js";
import { createNativeLegacyTrashAccess } from "../dist/host-composition-legacy-trash.js";
import { Storage } from "../dist/storage.js";
import { startMcp } from "../dist/mcp.js";
import { startLegacyNoteMcp } from "../dist/legacy-note-mcp.js";
import { legacyKnowledgeWrite } from "../dist/legacy-knowledge-write.js";
import { scanMarkdown } from "../dist/markdown.js";
import { createWorkspaceBackup, restoreWorkspaceBackup } from "../dist/workspace-backup.js";
import { nativeRestoreAuthority } from "./host-composition-legacy-batch16-restore-fixture.mjs";

const hash = value => createHash("sha256").update(value).digest("hex");
const pythonExecutable = execFileSync("python3", ["-c", "import sys;print(sys.executable)"], { encoding: "utf8" }).trim();
const actor = { id: "mcp:external", canWrite: true };
const nativeScope = { excludedRootNames: [".pkm", ".pkm-next-workspace"], excludedStateNames: [] };
const originalStore = createRequire(import.meta.url)("../legacy/dist/knowledge/filestore.js");
const raw = id => `---\n${["new-restore", "new-purge"].includes(id) ? "" : `schema: pkm.knowledge/v1\ndocumentId: ${id}\nknowledgeId: knowledge_${hash(id).slice(0, 24)}\n`}revision: 4\ntitle: ${id}\naliases: []\n---\nOriginal exact body.\n`;
const asset = Buffer.from([255, 0, 128, 10]);
function tx(db, work) {
  db.exec("BEGIN IMMEDIATE");
  try { const result = work(); db.exec("COMMIT"); return result; }
  catch (error) { db.exec("ROLLBACK"); throw error; }
}

for (const importedKind of ["document", "folder"])
test(`imported original ${importedKind} Trash coexists with authenticated MCP deletion/list/restore/purge across restart and relocated backup`, { timeout: 120_000 }, async t => {
  const parent = resolve("tests", `.trash-coexistence-${randomUUID()}`);
  t.after(() => rm(parent, { recursive: true, force: true }));
  const source = join(parent, "source"), target = join(parent, "target"), restored = join(parent, "restored");
  await mkdir(join(source, "notes"), { recursive: true, mode: 0o700 });
  await mkdir(join(source, ".pkm/state"), { recursive: true, mode: 0o700 });
  for (const area of ["skills", "papers"]) await mkdir(join(source, area));
  const oldPath = importedKind === "folder" ? "OriginalFolder/old.md" : "old.md";
  const oldSlug = oldPath.replace(/\.md$/, "");
  const oldDirectory = importedKind === "folder" ? "OriginalFolder/" : "";
  await mkdir(join(source, "notes", oldDirectory, "old.assets"), { recursive: true });
  await writeFile(join(source, "notes", oldPath), raw("old-note"));
  await writeFile(join(source, "notes", oldDirectory, "old.assets/a.bin"), asset);
  if (importedKind === "folder")
    await writeFile(join(source, "notes/OriginalFolder/untouched.md"), raw("untouched-note"));
  originalStore.setStorePath(source);
  const entry = originalStore.knowledgeMoveToTrash("notes", importedKind === "folder" ? "OriginalFolder" : "old.md",
    importedKind === "folder" ? "folder" : "item", "Original opaque name");
  assert(entry);
  const originalId = entry.id;
  const oldMetadata = await readFile(join(source, "notes/.trash", originalId, "metadata.json"), "utf8");
  const history = await readFile(join(source, ".pkm/state/knowledge-deletions.json"), "utf8");
  for (const id of ["new-restore", "new-purge", "new-retained", "new-uuid"]) {
    await mkdir(join(source, "notes", `${id}.assets`));
    await writeFile(join(source, "notes", `${id}.md`), raw(id));
    await writeFile(join(source, "notes", `${id}.assets/a.bin`), asset);
  }
  const trashPlan = await planLegacyTrashImport(source);
  const plan = await planLegacyImport(source, {}, { trashPlan });
  assert.equal(plan.ready, true, JSON.stringify(plan.blockers));
  const importedReceipt = await importLegacyWorkspace(plan, target, { pythonExecutable, trashImport: { actorId: actor.id, nativeScope } });
  const evidence = join(target, "legacy-import-evidence/.pkm/state");
  await writeFile(join(evidence, "unknown"), "retain exact bytes");
  await assert.rejects(snapshotLegacyTrashTree(target, true, nativeScope), /unrecognized data/);
  assert.equal(await readFile(join(evidence, "unknown"), "utf8"), "retain exact bytes");
  await rm(join(evidence, "unknown"));
  await rm(evidence, { recursive: true });
  await symlink(join(target, "notes"), evidence);
  await assert.rejects(snapshotLegacyTrashTree(target, true, nativeScope), /real directory/);
  await rm(evidence);
  await mkdir(evidence);
  let storage, runtime, canonicalServer, sourceServer, canonical, legacy;
  const policy = { trustedImportPlanSha256: trashPlan.planSha256, snapshotScope: nativeScope,
    authorize: id => id === actor.id };
  const close = async () => {
    await canonical?.close(); canonical = undefined;
    await legacy?.close(); legacy = undefined;
    await canonicalServer?.close(); canonicalServer = undefined;
    await sourceServer?.close(); sourceServer = undefined;
    await runtime?.close(); runtime = undefined;
    await storage?.close(); storage = undefined;
  };
  t.after(async () => { await close(); await rm(parent, { recursive: true, force: true }); });
  async function connect(root, adopt = false, recover = false) {
    storage = await Storage.open(root, { deferRecovery: recover });
    runtime = await createNativeRuntime({ storage, legacyTrash: { ...policy,
      ...(recover ? { recoveryActorId: actor.id } : {}),
      ...(adopt ? { import: { plan: trashPlan, authority: importedReceipt.legacyTrash.authority } } : {}) } });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    canonicalServer = await startMcp(runtime.core, actor, serverTransport);
    canonical = new Client({ name: "trash-coexistence", version: "1" });
    await canonical.connect(clientTransport);
    const [legacyTransport, sourceTransport] = InMemoryTransport.createLinkedPair();
    sourceServer = await startLegacyNoteMcp(storage, sourceTransport, { core: runtime.core, actor });
    legacy = new Client({ name: "trash-original-calls", version: "1" });
    await legacy.connect(legacyTransport);
  }
  async function invoke(operation, args = {}, write = false) {
    const response = await canonical.callTool({ name: write ? "capability_call" : "capability_read",
      arguments: { operation, version: 1, arguments: args } });
    assert.equal(response.structuredContent.error, undefined, JSON.stringify(response));
    return response.structuredContent.result;
  }
  async function trash(id) {
    const response = await legacy.callTool({ name: "legacy_knowledge_trash",
      arguments: { tool: "delete_note", arguments: { slug: id } } });
    assert.notEqual(response.isError, true, JSON.stringify(response));
    return response.structuredContent.value.trash;
  }
  await connect(target, true);
  const metadata = {};
  for (const id of ["new-restore", "new-purge", "new-retained"]) metadata[id] = await trash(id);
  const uuidPreview = await invoke("knowledge.trash.lifecycle.preview", { area: "notes", path: "new-uuid.md", kind: "document" });
  const uuidId = randomUUID();
  await invoke("knowledge.trash.move", { area: "notes", path: "new-uuid.md", kind: "document", operationId: uuidId,
    expectedTreeSha256: uuidPreview.treeSha256, expectedScanRevision: uuidPreview.scanRevision }, true);
  const listed = (await invoke("knowledge.trash.list")).items;
  assert.equal(listed.length, 5);
  assert(listed.some(entry => entry.id === uuidId && entry.runtimeEntryId === uuidId));
  const imported = listed.find(entry => entry.id === originalId);
  assert(imported);
  for (const id of Object.keys(metadata)) assert(listed.some(entry => entry.id === metadata[id].id));
  const importedGet = await invoke("knowledge.trash.get", { area: "notes", originalId });
  assert.equal(Buffer.from(importedGet.metadataBytes, "base64").toString("utf8"), oldMetadata);
  assert.deepEqual(importedGet.deletionHistory.current.records.slice(0, JSON.parse(history).records.length),
    JSON.parse(history).records);
  const nativeGet = await invoke("knowledge.trash.get", { area: "notes", originalId: metadata["new-restore"].id });
  assert.equal(nativeGet.entry.originalPath, "new-restore.md");
  assert.equal(nativeGet.deletionHistory.current.records.length, importedKind === "folder" ? 9 : 8);
  const restoreOp = randomUUID();
  const restoreArgs = { operationId: restoreOp, area: "notes", originalId: metadata["new-restore"].id };
  const restoreResult = await invoke("knowledge.trash.restore.original", restoreArgs, true);
  assert.deepEqual(await invoke("knowledge.trash.restore.original", restoreArgs, true), restoreResult);
  const otherActor = await runtime.core.dispatch("capability_call", {
    operation: "knowledge.trash.restore.original", version: 1, arguments: restoreArgs,
  }, { id: "different-actor", canWrite: true });
  assert.equal(otherActor.error.code, "NOT_AVAILABLE");
  assert.equal(await readFile(join(target, "notes/new-restore.md"), "utf8"), raw("new-restore"));
  assert.deepEqual(await readFile(join(target, "notes/new-restore.assets/a.bin")), asset);
  await invoke("knowledge.trash.delete.original", { operationId: randomUUID(), area: "notes", originalId: metadata["new-purge"].id }, true);
  await close();
  const attackDb = new DatabaseSync(join(target, "core.sqlite"));
  const attacked = attackDb.prepare("SELECT * FROM migration_runtime_trash_origins WHERE entry_id=?").get(metadata["new-retained"].id);
  attackDb.prepare("DELETE FROM migration_runtime_trash_origins WHERE entry_id=?").run(attacked.entry_id);
  attackDb.close();
  const attempt = await Storage.open(target);
  await assert.rejects(createNativeRuntime({ storage: attempt, legacyTrash: policy }), /provenance|receipt membership/i);
  await attempt.close();
  const fixDb = new DatabaseSync(join(target, "core.sqlite"));
  fixDb.prepare("INSERT INTO migration_runtime_trash_origins VALUES(?,?,?,?,?)").run(
    attacked.entry_id, attacked.workspace_id, attacked.plan_json, attacked.request_json, attacked.digest);
  const changedRequest = JSON.parse(attacked.request_json);
  changedRequest.actorId = "different-actor";
  const changedJson = JSON.stringify(changedRequest);
  fixDb.prepare("UPDATE migration_runtime_trash_origins SET request_json=?,digest=? WHERE entry_id=?").run(changedJson,
    hash(JSON.stringify([attacked.entry_id, attacked.workspace_id, attacked.plan_json, changedJson])), attacked.entry_id);
  fixDb.close();
  const forged = await Storage.open(target);
  await assert.rejects(createNativeRuntime({ storage: forged, legacyTrash: policy }), /provenance|actor/i);
  await forged.close();
  const restoreDb = new DatabaseSync(join(target, "core.sqlite"));
  restoreDb.prepare("UPDATE migration_runtime_trash_origins SET request_json=?,digest=? WHERE entry_id=?")
    .run(attacked.request_json, attacked.digest, attacked.entry_id);
  restoreDb.close();
  await connect(target);
  assert.equal((await invoke("knowledge.trash.list")).items.length, 3);
  const db = new DatabaseSync(join(target, "core.sqlite"), { readOnly: true });
  const origins = db.prepare("SELECT * FROM migration_runtime_trash_origins ORDER BY entry_id").all();
  assert.equal(origins.length, 4);
  const nativePlan = JSON.parse(origins[0].plan_json);
  assert.equal(nativePlan.actorId, actor.id);
  const originalReceipt = db.prepare("SELECT receipt_json FROM legacy_trash_import_receipt").get().receipt_json;
  assert.equal(JSON.parse(originalReceipt).original.entries.length, 1);
  db.close();
  const hostFactory = async (root, workspaceId, database, external) => {
    const ownedStorage = root === storage?.workspaceRoot() ? storage : await Storage.open(root);
    const connection = database ?? ownedStorage.connectNative();
    const composed = createNativeLegacyTrashAccess({ database: connection, storage: ownedStorage, root, workspaceId,
      policy: { ...policy, trustedImportPlanSha256: external.trustedImportPlanSha256, snapshotScope: external.snapshotScope },
      transaction: work => tx(connection, work), reconcileIndex() {}, assertOperationAvailable() {} });
    return { ...composed.host, close: async () => {
      if (!database) connection.close();
      if (ownedStorage !== storage) await ownedStorage.close();
    } };
  };
  const backupPolicy = { ...policy, actorId: actor.id, hostFactory };
  const backup = join(parent, "backup");
  await createWorkspaceBackup(storage, backup, { acquireQuiescence: async () => ({ assertHeld() {}, release() {} }) },
    { legacyTrash: backupPolicy });
  await close();
  await restoreWorkspaceBackup(backup, restored, { nativeRestoreAuthority,
    legacyTrash: { ...backupPolicy, expectedManifestSha256: hash(await readFile(join(backup, ".pkm-workspace-backup.json"))) } });
  await connect(restored);
  assert.equal((await invoke("knowledge.trash.list")).items.length, 3);
  const restoredDb = new DatabaseSync(join(restored, "core.sqlite"), { readOnly: true });
  assert.deepEqual(restoredDb.prepare("SELECT * FROM migration_runtime_trash_origins ORDER BY entry_id").all(), origins);
  restoredDb.close();
  await invoke("knowledge.trash.restore.original", { operationId: randomUUID(), area: "notes", originalId }, true);
  assert.equal(await readFile(join(restored, "notes", oldPath), "utf8"), raw("old-note"));
  assert.deepEqual(await readFile(join(restored, "notes", oldDirectory, "old.assets/a.bin")), asset);
  const historyDb = new DatabaseSync(join(restored, "core.sqlite"), { readOnly: true });
  const historyRow = historyDb.prepare("SELECT original_bytes,current_json FROM legacy_trash_import_history").get();
  assert.equal(Buffer.from(historyRow.original_bytes).toString("utf8"), history);
  const originalPaths = new Set(JSON.parse(history).records.map(record => record.path));
  assert.equal(JSON.parse(historyRow.current_json).records.some(record => originalPaths.has(record.path)), false);
  historyDb.close();
  await invoke("knowledge.trash.restore.original", { operationId: randomUUID(), area: "notes", originalId: metadata["new-retained"].id }, true);
  await invoke("knowledge.trash.restore.original", { operationId: randomUUID(), area: "notes", originalId: uuidId }, true);
  assert.equal((await invoke("knowledge.trash.list")).items.length, 0);
  const updatedOriginal = await legacy.callTool({ name: "legacy_knowledge_write", arguments: {
    tool: "update_note", arguments: { slug: oldSlug, title: "OriginalMoved", category: "Updated",
      content: "Updated original restored fact.\n![pair](old.assets/a.bin)\n" },
  } });
  assert.notEqual(updatedOriginal.isError, true, JSON.stringify(updatedOriginal));
  await close();
  await connect(restored);
  const changedOriginal = await readFile(join(restored, "notes/Updated/OriginalMoved.md"), "utf8");
  assert.match(changedOriginal, /documentId: "?old-note"?/);
  assert.match(changedOriginal, /revision: 5/);
  const successorDb = new DatabaseSync(join(restored, "core.sqlite"), { readOnly: true });
  const successor = successorDb.prepare("SELECT * FROM migration_runtime_knowledge_commits ORDER BY sequence").all();
  assert.equal(successor.length, 1);
  successorDb.close();
  await close();
  const successorAttackDb = new DatabaseSync(join(restored, "core.sqlite"));
  const committed = successor[0];
  const forgedRequest = JSON.parse(committed.request_json);
  forgedRequest.actorId = "different-native-writer";
  const forgedJson = JSON.stringify(forgedRequest);
  successorAttackDb.prepare("UPDATE migration_runtime_knowledge_commits SET request_json=?,digest=? WHERE operation_id=?")
    .run(forgedJson, hash(JSON.stringify([committed.sequence, committed.workspace_id, committed.operation_id,
      forgedJson, committed.plan_json, committed.result_json])), committed.operation_id);
  successorAttackDb.close();
  const forgedSuccessorStorage = await Storage.open(restored);
  await assert.rejects(createNativeRuntime({ storage: forgedSuccessorStorage, legacyTrash: policy }), /successor.*actor|immutable actor/i);
  await forgedSuccessorStorage.close();
  const successorFixDb = new DatabaseSync(join(restored, "core.sqlite"));
  successorFixDb.prepare("UPDATE migration_runtime_knowledge_commits SET request_json=?,digest=? WHERE operation_id=?")
    .run(committed.request_json, committed.digest, committed.operation_id);
  successorFixDb.close();
  await connect(restored);
  const secondBackup = join(parent, "backup-after-restored-update"), thirdRoot = join(parent, "relocated-after-restored-update");
  await createWorkspaceBackup(storage, secondBackup, { acquireQuiescence: async () => ({ assertHeld() {}, release() {} }) },
    { legacyTrash: backupPolicy });
  await close();
  await restoreWorkspaceBackup(secondBackup, thirdRoot, { nativeRestoreAuthority,
    legacyTrash: { ...backupPolicy, expectedManifestSha256: hash(await readFile(join(secondBackup, ".pkm-workspace-backup.json"))) } });
  await connect(thirdRoot);
  assert.equal(await readFile(join(thirdRoot, "notes/Updated/OriginalMoved.md"), "utf8"), changedOriginal);
  const thirdDb = new DatabaseSync(join(thirdRoot, "core.sqlite"), { readOnly: true });
  assert.deepEqual(thirdDb.prepare("SELECT * FROM migration_runtime_knowledge_commits ORDER BY sequence").all(), successor);
  thirdDb.close();
  await close();
  await connect(restored);
  for (const id of ["new-restore", "new-purge", "new-retained", "new-uuid"]) {
    assert.equal(await readFile(join(source, "notes", `${id}.md`), "utf8"), raw(id));
    assert.deepEqual(await readFile(join(source, "notes", `${id}.assets/a.bin`)), asset);
  }
  const retrash = await trash("Updated/OriginalMoved");
  await close();
  await connect(restored);
  assert.equal((await invoke("knowledge.trash.list")).items[0].id, retrash.id);
  await invoke("knowledge.trash.delete.original", { operationId: randomUUID(), area: "notes", originalId: retrash.id }, true);
  await close();
  await connect(restored);
  assert.equal((await invoke("knowledge.trash.list")).items.length, 0);
  const exec = childProcess.execFileSync;
  const recoveredIdentity = scanMarkdown(restored).find(doc => doc.record.path === "new-restore.md").record.id;
  let interrupted = false;
  childProcess.execFileSync = (...args) => {
    const result = exec(...args);
    if (Array.isArray(args[1]) && String(args[1][2]).endsWith("new-restore.assets")) {
      interrupted = true;
      throw new Error("coexistence assets-first interruption");
    }
    return result;
  };
  syncBuiltinESMExports();
  try {
    await assert.rejects(legacyKnowledgeWrite(runtime.core, storage, actor, { tool: "update_note", arguments: {
      slug: "new-restore", title: "Moved", category: "Recovered",
      content: "Updated without replacing identity.\n![pair](new-restore.assets/a.bin)\n",
    } }), /interrupted|no-replace move failed/);
  } finally { childProcess.execFileSync = exec; syncBuiltinESMExports(); }
  assert.equal(interrupted, true);
  const pendingDb = new DatabaseSync(join(restored, "core.sqlite"), { readOnly: true });
  const pending = pendingDb.prepare("SELECT * FROM migration_runtime_intents").get();
  assert.equal(pending.operation, "knowledge.note.update");
  assert.equal(pendingDb.prepare("SELECT 1 FROM receipts WHERE operation_id=?").get(pending.operation_id), undefined);
  pendingDb.close();
  await close();
  const unauthorizedRecovery = await Storage.open(restored, { deferRecovery: true });
  await assert.rejects(createNativeRuntime({ storage: unauthorizedRecovery, legacyTrash: policy }), /exact externally authorized actor/);
  await unauthorizedRecovery.close();
  await connect(restored, false, true);
  const moved = await readFile(join(restored, "notes/Recovered/Moved.md"), "utf8");
  assert.equal(scanMarkdown(restored).find(doc => doc.record.path === "Recovered/Moved.md").record.id, recoveredIdentity);
  assert.match(moved, /revision: 5/);
  assert.deepEqual(await readFile(join(restored, "notes/Recovered/Moved.assets/a.bin")), asset);
  const request = JSON.parse(pending.request_json);
  assert.equal((await invoke(request.operation, request.args, true)).revision, 5);
  assert.equal((await invoke("knowledge.trash.list")).items.length, 0);
  assert.equal(await readFile(join(source, ".pkm/state/knowledge-deletions.json"), "utf8"), history);
  assert.equal(await readFile(join(source, "notes/.trash", originalId, "metadata.json"), "utf8"), oldMetadata);
});
