import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import { cp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { runInThisContext } from "node:vm";
import test from "node:test";
import { nativeRestoreAuthority } from "./host-composition-legacy-batch16-restore-fixture.mjs";
import ts from "typescript";
import { DatabaseSync } from "node:sqlite";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { fixture, hash, hashes, pythonExecutable } from "./batch09-original-control-fixtures.mjs";
import { importLegacyWorkspace, planLegacyImport, recoverLegacyImportOutcome } from "../dist/legacy-import.js";
import { Storage, initialize } from "../dist/storage.js";
import { createNativeRuntime } from "../dist/native-runtime.js";
import { startHttp } from "../dist/http.js";
import { startMcp } from "../dist/mcp.js";
import { createWorkspaceBackup, restoreWorkspaceBackup } from "../dist/workspace-backup.js";
import { readLegacyProjectControl } from "../dist/legacy-control-import.js";
import { compileLegacyRecipeTrashEffectPlan, stageLegacyRecipeTrashEffect } from "../dist/legacy-recipe-trash.js";
import { createNativeRecipeTrashHost } from "../dist/host-composition-legacy-recipe-trash.js";
import { canonicalJson } from "../dist/domain/project-recipes-workflow-contracts.js";
import { httpCall, invocation } from "./batch06-manager-fixtures.mjs";

const actor = { id: "batch12:recipe-owner", canWrite: true };
const operation = "project.recipe.trash.command";
const policy = {
  recoveryActorId: actor.id,
  authorize: (id, op) => id === actor.id && ["recipe-trash-move", "recipe-trash-restore"].includes(op),
};
const require = createRequire(import.meta.url), modules = new Map();
function original(path) {
  if (modules.has(path)) return modules.get(path).exports;
  const module = { exports: {} }; modules.set(path, module);
  const code = ts.transpileModule(readFileSync(path, "utf8"), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  runInThisContext(`(function(require,module,exports,__filename,__dirname){${code}\n})`, { filename: path })(
    name => {
      if (!name.startsWith(".")) return require(name);
      const file = resolve(dirname(path), name);
      return original(existsSync(`${file}.ts`) ? `${file}.ts` : join(file, "index.ts"));
    }, module, module.exports, path, dirname(path));
  return module.exports;
}
function at(now, work) {
  const RealDate = globalThis.Date;
  globalThis.Date = class extends RealDate {
    constructor(...args) { super(...(args.length ? args : [RealDate.parse(now)])); }
    static now() { return RealDate.parse(now); }
  };
  try { return work(); } finally { globalThis.Date = RealDate; }
}
async function tree(root) {
  const files = {};
  async function walk(path) {
    for (const entry of await readdir(path, { withFileTypes: true })) {
      const full = join(path, entry.name);
      if (entry.isDirectory()) await walk(full);
      else files[relative(join(root, "recipes"), full)] = (await readFile(full)).toString("base64");
    }
  }
  await walk(join(root, "recipes"));
  return Object.fromEntries(Object.entries(files).sort(([a], [b]) => a.localeCompare(b)));
}
function tx(db, work) {
  db.exec("BEGIN IMMEDIATE");
  try { const result = work(); db.exec("COMMIT"); return result; }
  catch (error) { if (db.isTransaction) db.exec("ROLLBACK"); throw error; }
}
async function importedOriginal(t) {
  const f = await fixture(t), root = resolve(import.meta.dirname, "../legacy"), oracleRoot = join(f.parent, "oracle");
  await cp(f.source, oracleRoot, { recursive: true });
  const state = join(oracleRoot, ".pkm/state");
  const { RecipeFilesystemStore } = original(join(root, "src/workflows/recipe-filesystem-store.ts"));
  const { ProjectStore } = original(join(root, "src/workflows/project-store.ts"));
  new RecipeFilesystemStore(state).put(f.recipe);
  const store = new ProjectStore(state, randomUUID), before = store.list();
  const importedCommand = { commandId: "original-imported-trash", fingerprint: "original opaque trash pin",
    expectedStoreVersion: before.storeVersion };
  const moved = at("2026-11-07T12:00:00.000Z", () => store.moveRecipeToTrash(importedCommand, f.recipe.recipeId));
  await rm(f.source, { recursive: true }); await cp(oracleRoot, f.source, { recursive: true });
  // Export the canonical store; the older compatibility envelope remains unsupported.
  await rm(join(f.source, ".pkm/state/projects.json"));
  const authority = { sourceRootId: before.rootId, sourceStoreVersion: moved.snapshot.storeVersion };
  const sourceHashes = await hashes(f.source);
  assert.equal((await planLegacyImport(f.source)).ready, false);
  const plan = await planLegacyImport(f.source, {}, { recipeTrashAuthority: authority });
  assert.equal(plan.ready, true, JSON.stringify(plan.blockers));
  assert.equal(plan.recipeTrashPlan.trashFiles.length, 1);
  await assert.rejects(importLegacyWorkspace(plan, f.target, { pythonExecutable }), { code: "AUTHORITY_REQUIRED" });
  const receipt = await importLegacyWorkspace(plan, f.target, { pythonExecutable, recipeTrashAuthority: authority });
  assert.deepEqual(receipt.recipeTrashPlan, plan.recipeTrashPlan);
  assert.equal((await recoverLegacyImportOutcome(f.target)).status, "published");
  assert.deepEqual(await tree(f.target), await tree(oracleRoot));
  await assert.rejects(importLegacyWorkspace(plan, f.target, { pythonExecutable, recipeTrashAuthority: authority }), { code: "DESTINATION_EXISTS" });
  return { ...f, store, oracleRoot, authority, sourceHashes, plan, importedCommand };
}
async function native(t, f, root = f.target, configured = policy) {
  let storage, runtime, http, client, server;
  const bearer = randomUUID() + randomUUID();
  async function close() {
    await client?.close(); client = undefined;
    await server?.close(); server = undefined;
    if (http) await new Promise(resolve => http.server.close(resolve)); http = undefined;
    await runtime?.close(); runtime = undefined;
    await storage?.close(); storage = undefined;
  }
  async function open() {
    storage = await Storage.open(root, { deferRecovery: true });
    try {
      runtime = await createNativeRuntime({ storage, ...(configured ? { recipeTrash: configured } : {}),
        hostServices: { authorizeBackup: () => true, backupOptions: { nativeRestoreAuthority } } });
      http = await startHttp(runtime.core, bearer, actor, 0);
      const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
      server = await startMcp(runtime.core, actor, serverTransport);
      client = new Client({ name: "batch12-recipe-oracle", version: "1" });
      await client.connect(clientTransport);
    } catch (error) { await close(); throw error; }
  }
  await open(); t.after(close);
  return {
    open, close, get storage() { return storage; }, get runtime() { return runtime; },
    call: args => httpCall(http.url, bearer, "capability_call", invocation(operation, args)),
    async mcp(args) {
      const result = await client.callTool({ name: "capability_call", arguments: invocation(operation, args) });
      return JSON.parse(result.content[0].text);
    },
    db(work) { const db = storage.connectNative(); try { return work(db); } finally { db.close(); } },
  };
}
const argsFor = (f, version, op, commandId = randomUUID()) => ({
  operationId: randomUUID(), command: { commandId, fingerprint: `opaque:${commandId}`,
    operation: op, expectedStoreVersion: version, recipeId: f.recipe.recipeId },
});
test("live original Recipe trash -> one atomic native import -> Core HTTP/MCP move/restore/replay -> backup restore/restart", async t => {
  const f = await importedOriginal(t), n = await native(t, f), workspaceId = await n.storage.workspaceId();
  assert.notEqual(workspaceId, f.authority.sourceRootId);
  const originalBytes = await readFile(join(f.source, ".pkm/state/project-store.json"));
  const control = n.db(db => readLegacyProjectControl(db, workspaceId));
  assert.deepEqual(control.controlBytes, originalBytes);
  assert.equal(control.receipts.at(-1).commandId, f.importedCommand.commandId);
  const restore = argsFor(f, control.storeVersion, "recipe-trash-restore");
  const restored = await n.call(restore);
  assert.equal(restored.status, 200, JSON.stringify(restored.body)); assert.equal(restored.body.result.replayed, false);
  f.store.restoreRecipeFromTrash(restore.command, f.recipe.recipeId);
  assert.deepEqual(await tree(f.target), await tree(f.oracleRoot));
  const readRestored = await n.runtime.core.dispatch("capability_read",
    invocation("project.recipe.get", { id: f.recipe.recipeId }), actor);
  assert.ok(readRestored.result, JSON.stringify(readRestored));
  assert.equal(readRestored.result.item.trashedAt, "2026-11-07T12:00:00.000Z");
  const beforeReplay = await tree(f.target), count = n.db(db => db.prepare("SELECT COUNT(*) AS n FROM receipts").get().n);
  assert.equal((await n.mcp(restore)).result.replayed, true);
  assert.deepEqual(await tree(f.target), beforeReplay);
  assert.equal(n.db(db => db.prepare("SELECT COUNT(*) AS n FROM receipts").get().n), count);
  assert.equal(n.db(db => db.prepare("SELECT operation FROM receipts WHERE operation_id=?").get(restore.operationId).operation), operation);
  const historyReplay = { ...restore, operationId: randomUUID() };
  assert.equal((await n.call(historyReplay)).body.result.replayed, true);
  assert.equal(n.db(db => db.prepare("SELECT COUNT(*) AS n FROM receipts").get().n), count + 1);
  const conflict = await n.call({ ...restore, command: { ...restore.command, fingerprint: "tampered" } });
  assert.notEqual(conflict.status, 200);
  assert.notEqual((await n.call({ ...restore, actorId: "caller-cannot-grant-authority" })).status, 200);
  assert.notEqual((await n.call(argsFor(f, 1, "recipe-trash-move"))).status, 200);
  const move = argsFor(f, restored.body.result.storeVersion, "recipe-trash-move");
  const moved = await n.mcp(move);
  assert.ok(moved.result, JSON.stringify(moved));
  const trashed = Object.values(await tree(f.target)).map(bytes => JSON.parse(Buffer.from(bytes, "base64"))).find(recipe => recipe.trashedAt);
  at(trashed.trashedAt, () => f.store.moveRecipeToTrash(move.command, f.recipe.recipeId));
  assert.deepEqual(await tree(f.target), await tree(f.oracleRoot));
  assert.equal(n.db(db => db.prepare("SELECT COUNT(*) AS n FROM legacy_recipe_trash_intent").get().n), 0);
  assert.deepEqual(n.db(db => readLegacyProjectControl(db, workspaceId).controlBytes), originalBytes);
  await n.runtime.services.hostServices.backup(f.backup);
  await n.runtime.services.hostServices.restore(f.backup, f.restored);
  assert.deepEqual(await tree(f.restored), await tree(f.target));
  const r = await native(t, f, f.restored);
  assert.equal((await r.mcp(move)).result.replayed, true);
  const secondRestore = argsFor(f, moved.result.storeVersion, "recipe-trash-restore");
  assert.equal((await r.call(secondRestore)).status, 200);
  f.store.restoreRecipeFromTrash(secondRestore.command, f.recipe.recipeId);
  assert.deepEqual(await tree(f.restored), await tree(f.oracleRoot));
  await n.close(); await n.open();
  assert.equal((await n.call(move)).body.result.replayed, true);
  assert.deepEqual(await hashes(f.source), f.sourceHashes);
});

for (const state of ["before", "mixed", "unknown"]) test(`native Recipe pending ${state} recovery precedes generic validation and retains unknown journals`, async t => {
  const f = await importedOriginal(t), n = await native(t, f), workspaceId = await n.storage.workspaceId();
  const control = n.db(db => readLegacyProjectControl(db, workspaceId));
  const args = argsFor(f, control.storeVersion, "recipe-trash-restore");
  const envelope = { workspaceId, operationId: args.operationId, actorId: actor.id, command: args.command,
    callerHostFingerprint: hash(canonicalJson({ operation, workspaceId, actorId: actor.id, args,
      sourceControl: { rootId: control.rootId, sha256: control.controlSha256 } })) };
  let plan;
  await n.storage.withWorkspaceExclusive(() => n.db(db => {
    const host = createNativeRecipeTrashHost(db, workspaceId, policy, () => n.storage.assertWorkspaceLease());
    plan = compileLegacyRecipeTrashEffectPlan(db, f.target, envelope, host);
    tx(db, () => stageLegacyRecipeTrashEffect(db, envelope, plan));
  }));
  if (state === "mixed") {
    const file = plan.after.find(entry => entry.kind === "file" && !plan.before.some(before => before.path === entry.path));
    await mkdir(dirname(join(f.target, file.path)), { recursive: true });
    await writeFile(join(f.target, file.path), Buffer.from(file.base64, "base64"));
  }
  if (state === "unknown") {
    await writeFile(join(f.target, plan.before.find(entry => entry.kind === "file").path), '{"unknown":true}\n');
  }
  const pendingBefore = n.db(db => db.prepare("SELECT * FROM legacy_recipe_trash_intent").get());
  await assert.rejects(n.runtime.services.hostServices.backup(f.backup), { code: "PENDING_JOURNAL" });
  await n.close();
  const noPolicy = await Storage.open(f.target, { deferRecovery: true });
  try { await assert.rejects(createNativeRuntime({ storage: noPolicy }), { code: "RECOVERY_AUTHORITY_REQUIRED" }); }
  finally { await noPolicy.close(); }
  if (state === "unknown") {
    await assert.rejects(n.open(), { code: "RECOVERY_UNKNOWN_STATE" });
    const db = new DatabaseSync(join(f.target, "core.sqlite"));
    try {
      assert.deepEqual(db.prepare("SELECT * FROM legacy_recipe_trash_intent").get(), pendingBefore);
      assert.equal(db.prepare("SELECT COUNT(*) AS n FROM receipts WHERE operation_id=?").get(args.operationId).n, 0);
      assert.equal(readLegacyProjectControl(db, workspaceId).storeVersion, control.storeVersion);
    } finally { db.close(); }
  } else {
    await n.open();
    assert.equal((await n.call(args)).body.result.replayed, true);
    f.store.restoreRecipeFromTrash(args.command, f.recipe.recipeId);
    assert.deepEqual(await tree(f.target), await tree(f.oracleRoot));
  }
});

test("Recipe catalog defaults deny and forged caller host/actor fields never grant authority", async t => {
  const f = await importedOriginal(t), n = await native(t, f, f.target, null);
  const args = argsFor(f, f.authority.sourceStoreVersion, "recipe-trash-restore");
  const result = await n.call(args);
  assert.notEqual(result.status, 200);
  const nativeDenied = await n.runtime.core.dispatch("capabilities_describe", { operation }, actor);
  assert.equal(nativeDenied.error.code, "NOT_FOUND");
  assert.deepEqual(await tree(f.target), await tree(f.oracleRoot));
});

test("public Recipe receipts bind actor/global identity, establish historical replays atomically and outlive rolling256 history", { timeout: 120_000 }, async t => {
  const f = await importedOriginal(t), n = await native(t, f), workspaceId = await n.storage.workspaceId();
  const crossId = randomUUID();
  const other = await n.runtime.core.dispatch("capability_call", invocation("knowledge.document.create", {
    operationId: crossId, id: "recipe-cross-domain", title: "Synthetic", content: "isolated",
  }), actor);
  assert.ok(other.result, JSON.stringify(other));
  const cross = argsFor(f, f.authority.sourceStoreVersion, "recipe-trash-restore");
  cross.operationId = crossId;
  assert.equal((await n.call(cross)).body.error.code, "CONFLICT");
  const importedReplay = { operationId: randomUUID(), command: { ...f.importedCommand,
    operation: "recipe-trash-move", recipeId: f.recipe.recipeId } };
  const untouched = await tree(f.target), version = f.authority.sourceStoreVersion;
  n.db(db => db.exec(`CREATE TRIGGER reject_recipe_replay BEFORE INSERT ON receipts
    WHEN NEW.operation_id='${importedReplay.operationId}' BEGIN SELECT RAISE(ABORT,'synthetic replay receipt fault'); END`));
  assert.notEqual((await n.call(importedReplay)).status, 200);
  assert.equal(n.db(db => db.prepare("SELECT COUNT(*) AS n FROM receipts WHERE operation_id=?").get(importedReplay.operationId).n), 0);
  assert.equal(n.db(db => readLegacyProjectControl(db, workspaceId).storeVersion), version);
  assert.deepEqual(await tree(f.target), untouched);
  n.db(db => db.exec("DROP TRIGGER reject_recipe_replay"));
  const replay = await n.mcp(importedReplay);
  assert.equal(replay.result.replayed, true); assert.equal(replay.result.storeVersion, version);
  const importedGlobal = n.db(db => db.prepare("SELECT * FROM receipts WHERE operation_id=?").get(importedReplay.operationId));
  assert.equal(importedGlobal.operation, operation); assert.equal(importedGlobal.actor_id, actor.id);
  assert.equal(importedGlobal.fingerprint, hash(canonicalJson({ operation, workspaceId, actorId: actor.id, args: importedReplay,
    sourceControl: { rootId: f.authority.sourceRootId,
      sha256: hash(await readFile(join(f.source, ".pkm/state/project-store.json"))) } })));
  assert.equal((await n.runtime.core.dispatch("capability_call", invocation(operation, importedReplay),
    { id: "unauthorized-recipe-actor", canWrite: true })).result, undefined);
  assert.equal((await n.runtime.core.dispatch("capability_call", invocation(operation, importedReplay),
    { ...actor, canWrite: false })).error.code, "ACCESS_DENIED");
  let currentVersion = version, first, latest;
  for (let index = 0; index < 258; index++) {
    const args = argsFor(f, currentVersion, index % 2 ? "recipe-trash-move" : "recipe-trash-restore");
    if (!first) first = args;
    const response = await n.runtime.core.dispatch("capability_call", invocation(operation, args), actor);
    assert.ok(response.result, JSON.stringify(response));
    currentVersion = response.result.storeVersion; latest = args;
    if (index % 2) {
      const trashed = Object.values(await tree(f.target)).map(bytes => JSON.parse(Buffer.from(bytes, "base64"))).find(recipe => recipe.trashedAt);
      at(trashed.trashedAt, () => f.store.moveRecipeToTrash(args.command, f.recipe.recipeId));
    } else f.store.restoreRecipeFromTrash(args.command, f.recipe.recipeId);
  }
  assert.deepEqual(await tree(f.target), await tree(f.oracleRoot));
  const control = n.db(db => readLegacyProjectControl(db, workspaceId));
  assert.equal(control.receipts.length, 256);
  assert.equal(control.receipts.some(receipt => receipt.commandId === first.command.commandId), false);
  const pinned = await tree(f.target), receiptCount = n.db(db => db.prepare("SELECT COUNT(*) AS n FROM receipts").get().n);
  const globalRetry = await n.mcp(first);
  assert.equal(globalRetry.result.replayed, true); assert.equal(globalRetry.result.storeVersion, currentVersion);
  assert.equal(globalRetry.result.entityId, f.recipe.recipeId);
  assert.deepEqual(await tree(f.target), pinned);
  assert.equal(n.db(db => db.prepare("SELECT COUNT(*) AS n FROM receipts").get().n), receiptCount);
  const currentHistory = { ...latest, operationId: randomUUID() };
  assert.equal((await n.call(currentHistory)).body.result.storeVersion, currentVersion);
  assert.notEqual((await n.call({ ...first, operationId: randomUUID() })).status, 200,
    "evicted opaque history cannot invent a replay under a fresh global operation ID");
  await n.close(); await n.open();
  assert.equal((await n.call(first)).body.result.storeVersion, currentVersion);
});

for (const inputVersion of [12, 13, 14, 15, 16]) test(`explicit schema ${inputVersion} input migrates to schema22 Note/Recipe journals`, async t => {
  const f = await fixture(t), root = join(f.parent, "migration");
  await initialize(root);
  const initial = await Storage.open(root); await initial.close();
  const db = new DatabaseSync(join(root, "core.sqlite"));
  const removeRecipeJournal = inputVersion < 16 ? "DROP TABLE legacy_recipe_trash_intent; " : "";
  db.exec(`DROP TABLE legacy_note_workitems_receipt; DROP TABLE legacy_note_workitems_intent; DROP TABLE legacy_note_workitems_admission; DROP TABLE legacy_note_workitems_native_binding; ${removeRecipeJournal}PRAGMA user_version=${inputVersion}`); db.close();
  const storage = await Storage.open(root);
  try {
    const current = storage.connectNative();
    try {
      assert.equal(current.prepare("PRAGMA user_version").get().user_version, 23);
      assert.equal(current.prepare("SELECT COUNT(*) AS n FROM legacy_recipe_trash_intent").get().n, 0);
    } finally { current.close(); }
    const backup = join(f.parent, "migration-backup"), restored = join(f.parent, "migration-restored");
    await createWorkspaceBackup(storage, backup, { acquireQuiescence: async () => ({ assertHeld() {}, release() {} }) });
    const old = new DatabaseSync(join(backup, "core.sqlite"));
    old.exec(`DROP TABLE legacy_note_workitems_receipt; DROP TABLE legacy_note_workitems_intent; DROP TABLE legacy_note_workitems_admission; DROP TABLE legacy_note_workitems_native_binding; ${removeRecipeJournal}PRAGMA user_version=${inputVersion}`); old.close();
    const manifestPath = join(backup, ".pkm-workspace-backup.json");
    const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
    const oldBytes = await readFile(join(backup, "core.sqlite"));
    const sqlite = manifest.files.find(file => file.path === "core.sqlite");
    manifest.databaseUserVersion = inputVersion;
    sqlite.size = oldBytes.length; sqlite.sha256 = hash(oldBytes);
    manifest.totalBytes = manifest.files.reduce((sum, file) => sum + file.size, 0);
    await writeFile(manifestPath, `${JSON.stringify(manifest)}\n`);
    await restoreWorkspaceBackup(backup, restored, { nativeRestoreAuthority });
    const preserved = new DatabaseSync(join(restored, "core.sqlite"));
    assert.equal(preserved.prepare("PRAGMA user_version").get().user_version, inputVersion); preserved.close();
    const reopened = await Storage.open(restored);
    try {
      const migrated = reopened.connectNative();
      try { assert.equal(migrated.prepare("PRAGMA user_version").get().user_version, 23); }
      finally { migrated.close(); }
    } finally { await reopened.close(); }
  } finally { await storage.close(); }
});
