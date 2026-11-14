import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import { cp, mkdir, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { runInThisContext } from "node:vm";
import test from "node:test";
import ts from "typescript";
import { DatabaseSync } from "node:sqlite";
import {
  compileLegacyRecipeTrashEffectPlan, executeLegacyRecipeTrashCommand, initializeLegacyRecipeTrashJournal,
  inspectLegacyRecipeTrashPending, planLegacyRecipeTrashImport, readLegacyRecipeTrashPendingEnvelope,
  resumeLegacyRecipeTrashCommand,
  rollbackLegacyRecipeTrashCommand, stageLegacyRecipeTrashEffect, stageLegacyRecipeTrashImport,
  verifyLegacyRecipeTrashImportSource, verifyLegacyRecipeTrashImportStage,
} from "../dist/legacy-recipe-trash.js";
import { readLegacyProjectControl } from "../dist/legacy-control-import.js";
import { canonicalJson } from "../dist/domain/project-recipes-workflow-contracts.js";
import { capturedDeclarations, originalSources } from "../dist/domain/legacy-recipe-trash-original.js";
import { fixture, hash, pythonExecutable } from "./batch09-original-control-fixtures.mjs";
import { importLegacyWorkspace, planLegacyImport } from "../dist/legacy-import.js";

const repo = resolve(import.meta.dirname, "../legacy");
const require = createRequire(import.meta.url);
const originalModules = new Map();
function original(path) {
  if (originalModules.has(path)) return originalModules.get(path).exports;
  const module = { exports: {} };
  originalModules.set(path, module);
  const source = ts.transpileModule(readFileSync(path, "utf8"), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  runInThisContext(`(function(require,module,exports,__filename,__dirname){${source}\n})`, { filename: path })(
    name => {
      if (!name.startsWith(".")) return require(name);
      const candidate = resolve(dirname(path), name);
      return original(existsSync(`${candidate}.ts`) ? `${candidate}.ts` : join(candidate, "index.ts"));
    }, module, module.exports, path, dirname(path));
  return module.exports;
}

function transaction(database, work) {
  database.exec("BEGIN IMMEDIATE");
  try { const result = work(); database.exec("COMMIT"); return result; }
  catch (error) { database.exec("ROLLBACK"); throw error; }
}

async function recipeFiles(root) {
  const result = {};
  async function walk(directory) {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isSymbolicLink()) throw new Error("Oracle fixture unexpectedly contains a symlink.");
      if (entry.isDirectory()) await walk(path);
      else result[relative(join(root, "recipes"), path).split("\\").join("/")] = hash(await readFile(path));
    }
  }
  await walk(join(root, "recipes"));
  return Object.fromEntries(Object.entries(result).sort(([a], [b]) => a.localeCompare(b)));
}

function hostFor(root, workspaceId, databaseRef, allowed = true) {
  const secret = "batch12 synthetic host fingerprint key";
  const fingerprint = (envelope, binding) => hash(canonicalJson({
    secret,
    workspaceId: envelope.workspaceId,
    operationId: envelope.operationId,
    actorId: envelope.actorId,
    command: envelope.command,
    root: binding.root,
    rootId: binding.rootId,
    controlSha256: binding.controlSha256,
  }));
  const host = {
    recoveryActorId: "batch12-recipe-owner",
    assertExclusive() {},
    authorize(actorId, operation) {
      return allowed && actorId === "batch12-recipe-owner"
        && (operation === "recipe-trash-recovery-rollback"
          || operation === "recipe-trash-move" || operation === "recipe-trash-restore");
    },
    verifyCallerHostFingerprint(envelope, binding) {
      return envelope.callerHostFingerprint === fingerprint(envelope, binding);
    },
    assertOperationAvailable(operationId) {
      assert.ok(operationId);
      assert.equal(databaseRef.value.isTransaction, false);
    },
  };
  function envelope(command) {
    const current = readLegacyProjectControl(databaseRef.value, workspaceId);
    assert.ok(current);
    const value = {
      workspaceId,
      operationId: randomUUID(),
      actorId: "batch12-recipe-owner",
      callerHostFingerprint: "0".repeat(64),
      command,
    };
    value.callerHostFingerprint = fingerprint(value, {
      root: resolve(root), rootId: current.rootId, controlSha256: current.controlSha256,
    });
    return value;
  }
  return { host, envelope };
}

async function originalStoreFixture(t) {
  const f = await fixture(t);
  const oracleRoot = join(f.parent, "batch12-original-oracle");
  await cp(f.source, oracleRoot, { recursive: true });
  const state = join(oracleRoot, ".pkm", "state");
  const { RecipeFilesystemStore } = original(join(repo, "src/workflows/recipe-filesystem-store.ts"));
  const { ProjectStore } = original(join(repo, "src/workflows/project-store.ts"));
  new RecipeFilesystemStore(state).put(f.recipe);
  let generatedId = randomUUID();
  const store = new ProjectStore(state, () => generatedId);
  const initial = store.list();
  await rm(join(f.source, "recipes"), { recursive: true, force: true });
  await cp(join(oracleRoot, "recipes"), join(f.source, "recipes"), { recursive: true });

  const importPlan = await planLegacyImport(f.source);
  assert.deepEqual(importPlan.blockers, []);
  await importLegacyWorkspace(importPlan, f.target, { pythonExecutable });
  const workspaceId = JSON.parse(await readFile(join(f.target, ".pkm-next-workspace"), "utf8")).id;
  const database = new DatabaseSync(join(f.target, "core.sqlite"));
  transaction(database, () => initializeLegacyRecipeTrashJournal(database));
  const dbRef = { value: database };
  const { host, envelope } = hostFor(f.target, workspaceId, dbRef);
  t.after(() => dbRef.value.close());
  return {
    ...f, oracleRoot, store, initial, workspaceId, dbRef, host, envelope,
    reopen() {
      dbRef.value.close();
      dbRef.value = new DatabaseSync(join(f.target, "core.sqlite"));
    },
    setGeneratedId(value) { generatedId = value; },
  };
}

function withDate(now, action) {
  const RealDate = globalThis.Date;
  globalThis.Date = class extends RealDate {
    constructor(...args) { super(...(args.length ? args : [Date.parse(now)])); }
    static now() { return Date.parse(now); }
  };
  try { return action(); }
  finally { globalThis.Date = RealDate; }
}

test("trash and restore reproduce the live original ProjectStore/RecipeFilesystemStore oracle with restart and exact bytes", async t => {
  const f = await originalStoreFixture(t);
  const now = "2026-11-07T12:00:00.000Z";
  const initialFiles = await recipeFiles(f.oracleRoot);
  const initialNativeFiles = await recipeFiles(f.target);
  assert.deepEqual(initialNativeFiles, initialFiles);
  const nativeControl = readLegacyProjectControl(f.dbRef.value, f.workspaceId);
  assert.equal(nativeControl.storeVersion, f.initial.storeVersion);
  let command = {
    commandId: "original-trash-command-opaque",
    fingerprint: "the original command fingerprint is intentionally opaque",
    operation: "recipe-trash-move",
    expectedStoreVersion: f.initial.storeVersion,
    recipeId: f.recipe.recipeId,
  };
  const envelope = f.envelope(command);
  const plan = compileLegacyRecipeTrashEffectPlan(f.dbRef.value, f.target, envelope, f.host, now);
  const callerCopy = structuredClone(plan);
  assert.throws(() => transaction(f.dbRef.value, () => stageLegacyRecipeTrashEffect(f.dbRef.value, envelope, callerCopy)),
    error => error.code === "PLAN_NOT_ADMITTED");
  const originalTrash = withDate(now, () => f.store.moveRecipeToTrash({
    commandId: command.commandId, fingerprint: command.fingerprint, expectedStoreVersion: command.expectedStoreVersion,
  }, command.recipeId));
  assert.equal(originalTrash.entityId, f.recipe.recipeId);
  transaction(f.dbRef.value, () => stageLegacyRecipeTrashEffect(f.dbRef.value, envelope, plan));
  const pending = readLegacyRecipeTrashPendingEnvelope(f.dbRef.value);
  assert.deepEqual(pending, envelope);

  const newTrashFile = plan.after.find(entry => entry.kind === "file" && !plan.before.some(before => before.path === entry.path));
  assert.ok(newTrashFile);
  const partialPath = join(f.target, ...newTrashFile.path.split("/"));
  await mkdir(dirname(partialPath), { recursive: true });
  await writeFile(partialPath, Buffer.from(newTrashFile.base64, "base64"));
  assert.equal(inspectLegacyRecipeTrashPending(f.dbRef.value, f.target, envelope, f.host).state, "mixed");
  f.reopen();
  const recovered = resumeLegacyRecipeTrashCommand(f.dbRef.value, f.target, envelope, f.host,
    work => transaction(f.dbRef.value, work), now);
  assert.deepEqual(recovered, { entityId: command.recipeId, storeVersion: command.expectedStoreVersion + 1, replayed: false });
  const nativeTree = await recipeFiles(f.target), originalTree = await recipeFiles(f.oracleRoot);
  assert.deepEqual(await recipeFiles(f.target), await recipeFiles(f.oracleRoot));

  const nativeAfterTrash = readLegacyProjectControl(f.dbRef.value, f.workspaceId);
  const lastReceipt = nativeAfterTrash.receipts.at(-1);
  assert.deepEqual(
    { commandId: lastReceipt.commandId, fingerprint: lastReceipt.fingerprint, operation: lastReceipt.operation,
      storeVersion: lastReceipt.storeVersion, entityId: lastReceipt.entityId },
    { commandId: command.commandId, fingerprint: command.fingerprint, operation: command.operation,
      storeVersion: command.expectedStoreVersion + 1, entityId: command.recipeId },
  );
  assert.deepEqual(resumeLegacyRecipeTrashCommand(f.dbRef.value, f.target, envelope, f.host,
    work => transaction(f.dbRef.value, work), now),
    { entityId: command.recipeId, storeVersion: command.expectedStoreVersion + 1, replayed: true });

  const importSourceVersion = JSON.parse(await readFile(join(f.oracleRoot, ".pkm/state/project-store.json"), "utf8")).storeVersion;
  const importPlan = planLegacyRecipeTrashImport(f.oracleRoot, { sourceRootId: f.rootId, sourceStoreVersion: importSourceVersion });
  assert.equal(importPlan.trashFiles.length, 1);
  assert.equal(importPlan.receipts.at(-1).operation, "recipe-trash-move");
  const stagedImport = join(f.parent, "recipe-trash-import-stage");
  await stageLegacyRecipeTrashImport(importPlan, stagedImport);
  assert.deepEqual(verifyLegacyRecipeTrashImportStage(importPlan, stagedImport), {
    bytes: importPlan.totalBytes, trash: 1, planSha256: importPlan.planSha256, history: importPlan.receipts,
  });
  verifyLegacyRecipeTrashImportSource(f.oracleRoot, { sourceRootId: f.rootId, sourceStoreVersion: importSourceVersion }, importPlan);

  const restoreCommand = {
    commandId: "original-restore-command-opaque",
    fingerprint: "restore fingerprint also remains opaque",
    operation: "recipe-trash-restore",
    expectedStoreVersion: nativeAfterTrash.storeVersion,
    recipeId: f.recipe.recipeId,
  };
  const restoreEnvelope = f.envelope(restoreCommand);
  const restorePlan = compileLegacyRecipeTrashEffectPlan(f.dbRef.value, f.target, restoreEnvelope, f.host, now);
  const originalRestore = f.store.restoreRecipeFromTrash({
    commandId: restoreCommand.commandId,
    fingerprint: restoreCommand.fingerprint,
    expectedStoreVersion: restoreCommand.expectedStoreVersion,
  }, restoreCommand.recipeId);
  assert.equal(originalRestore.entityId, restoreCommand.recipeId);
  assert.equal(originalRestore.snapshot.recipes.find(recipe => recipe.recipeId === restoreCommand.recipeId)?.trashedAt, now);
  assert.equal(originalRestore.snapshot.recipeTrash.length, 0);
  const restored = executeLegacyRecipeTrashCommand(f.dbRef.value, f.target, restoreEnvelope, f.host,
    work => transaction(f.dbRef.value, work), now);
  assert.deepEqual(restored, { entityId: restoreCommand.recipeId, storeVersion: restoreCommand.expectedStoreVersion + 1, replayed: false });
  const nativeRestoredRecipe = JSON.parse(await readFile(join(f.target, "recipes/Project/Default Project/Review/Control.recipe_control.json"), "utf8"));
  const originalRestoredRecipe = JSON.parse(await readFile(join(f.oracleRoot, "recipes/Project/Default Project/Review/Control.recipe_control.json"), "utf8"));
  assert.equal(nativeRestoredRecipe.trashedAt, now);
  assert.deepEqual(nativeRestoredRecipe, originalRestoredRecipe, "restored Recipe record differs semantically from original writer");
  const nativeRestoredTree = await recipeFiles(f.target), originalRestoredTree = await recipeFiles(f.oracleRoot);
  assert.deepEqual(nativeRestoredTree, originalRestoredTree, "native restored Recipe bytes differ from original writer");
  assert.ok((await recipeFiles(f.target))[Object.keys(initialFiles).find(path => path.includes(f.recipe.recipeId))]);
  assert.equal(restorePlan.recipeId, restoreCommand.recipeId);
});

test("recipe trash rejects stale versions, mismatched host fingerprints, denied native permissions, links and references", async t => {
  const f = await originalStoreFixture(t);
  const now = "2026-11-07T12:00:00.000Z";
  const command = {
    commandId: "guarded-recipe-trash",
    fingerprint: "opaque-fingerprint",
    operation: "recipe-trash-move",
    expectedStoreVersion: f.initial.storeVersion - 1,
    recipeId: f.recipe.recipeId,
  };
  const stale = f.envelope(command);
  assert.throws(() => compileLegacyRecipeTrashEffectPlan(f.dbRef.value, f.target, stale, f.host, now),
    error => error.code === "STORE_VERSION_CONFLICT");
  const valid = f.envelope({ ...command, expectedStoreVersion: f.initial.storeVersion });
  const mismatch = { ...valid, callerHostFingerprint: "f".repeat(64) };
  assert.throws(() => compileLegacyRecipeTrashEffectPlan(f.dbRef.value, f.target, mismatch, f.host, now),
    error => error.code === "HOST_FINGERPRINT");
  const deny = hostFor(f.target, f.workspaceId, f.dbRef, false).host;
  assert.throws(() => compileLegacyRecipeTrashEffectPlan(f.dbRef.value, f.target, valid, deny, now),
    error => error.code === "FORBIDDEN");
  await mkdir(join(f.target, ".pkm/state/recipe-runs"), { recursive: true });
  await writeFile(join(f.target, ".pkm/state/recipe-runs/active.json"), "{}");
  assert.throws(() => compileLegacyRecipeTrashEffectPlan(f.dbRef.value, f.target, valid, f.host, now),
    error => error.code === "ACTIVE_WORKFLOW");
  await rm(join(f.target, ".pkm/state/recipe-runs"), { recursive: true });
  await writeFile(join(f.target, "project/reference.json"), JSON.stringify({ recipeId: f.recipe.recipeId }));
  assert.throws(() => compileLegacyRecipeTrashEffectPlan(f.dbRef.value, f.target, valid, f.host, now),
    error => error.code === "RECIPE_REFERENCED");
  await rm(join(f.target, "project/reference.json"));
  await symlink(join(f.target, "recipes"), join(f.target, "recipes/unsafe-link"));
  assert.throws(() => compileLegacyRecipeTrashEffectPlan(f.dbRef.value, f.target, valid, f.host, now),
    error => error.code === "SYMLINK" || error.code === "UNSUPPORTED_LAYOUT");
});

test("mixed Recipe trash recovery can be explicitly rolled back without a receipt or source mutation", async t => {
  const f = await originalStoreFixture(t);
  const command = {
    commandId: "rollback-recipe-trash",
    fingerprint: "opaque-rollback-fingerprint",
    operation: "recipe-trash-move",
    expectedStoreVersion: f.initial.storeVersion,
    recipeId: f.recipe.recipeId,
  };
  const envelope = f.envelope(command);
  const plan = compileLegacyRecipeTrashEffectPlan(f.dbRef.value, f.target, envelope, f.host, "2026-11-07T12:00:00.000Z");
  const initialFiles = await recipeFiles(f.target);
  transaction(f.dbRef.value, () => stageLegacyRecipeTrashEffect(f.dbRef.value, envelope, plan));
  const destination = plan.after.find(entry => entry.kind === "file" && !plan.before.some(old => old.path === entry.path));
  assert.ok(destination);
  const path = join(f.target, ...destination.path.split("/"));
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, Buffer.from(destination.base64, "base64"));
  assert.equal(inspectLegacyRecipeTrashPending(f.dbRef.value, f.target, envelope, f.host).state, "mixed");
  const result = rollbackLegacyRecipeTrashCommand(f.dbRef.value, f.target, envelope, f.host,
    work => transaction(f.dbRef.value, work));
  assert.deepEqual(result, { rolledBack: true, state: "mixed" });
  assert.deepEqual(await recipeFiles(f.target), await recipeFiles(f.oracleRoot));
  assert.deepEqual(await recipeFiles(f.target), initialFiles);
  assert.equal(readLegacyProjectControl(f.dbRef.value, f.workspaceId).storeVersion, f.initial.storeVersion);
  assert.equal(readLegacyRecipeTrashPendingEnvelope(f.dbRef.value), undefined);
});

test("trash captures remain tied to exact original model, stores, command history and supported operations", async () => {
  for (const source of originalSources) {
    assert.equal(hash(readFileSync(join(repo, source.path))), source.sha256, source.path);
    assert.ok(source.symbols.length > 0);
  }
  const [model, store, files] = [
    readFileSync(join(repo, originalSources[0].path), "utf8"),
    readFileSync(join(repo, originalSources[1].path), "utf8"),
    readFileSync(join(repo, originalSources[2].path), "utf8"),
  ];
  assert.ok(capturedDeclarations[0].includes("moveRecipeToTrash"));
  assert.ok(model.includes(capturedDeclarations[0]));
  assert.ok(model.includes(capturedDeclarations[1]));
  assert.ok(store.includes(capturedDeclarations[2]));
  assert.ok(files.includes(capturedDeclarations[3]));
  assert.ok(store.includes(capturedDeclarations[4]));
  assert.ok(files.includes(capturedDeclarations[5]));
  assert.ok(files.includes(capturedDeclarations[6]));
  assert.deepEqual(originalSources.map(source => source.symbols).slice(0, 3), [
    ["moveRecipeToTrash", "restoreRecipeFromTrash"],
    ["ProjectStore.moveRecipeToTrash", "ProjectStore.restoreRecipeFromTrash", "ProjectStore.mutate"],
    ["RecipeFilesystemStore.moveToTrash", "RecipeFilesystemStore.restoreFromTrash", "RecipeFilesystemStore.replaceFromState"],
  ]);
});

test("legacy Recipe command history remains ordered and capped at the original 256 receipts", async t => {
  const f = await originalStoreFixture(t);
  transaction(f.dbRef.value, () => {
    f.dbRef.value.prepare("DELETE FROM legacy_project_receipt WHERE workspace_id=?").run(f.workspaceId);
    const insert = f.dbRef.value.prepare(`INSERT INTO legacy_project_receipt
      (workspace_id,ordinal,command_id,fingerprint,operation,store_version,entity_id) VALUES(?,?,?,?,?,?,?)`);
    for (let index = 1; index <= 256; index++) {
      insert.run(f.workspaceId, index - 1, `historical-command-${index}`, `opaque-${index}`,
        "project.update", index, f.rootId);
    }
    f.dbRef.value.prepare("UPDATE legacy_project_control SET store_version=256 WHERE workspace_id=?").run(f.workspaceId);
  });
  const envelope = f.envelope({
    commandId: "history-rollover-command",
    fingerprint: "opaque-history-rollover-fingerprint",
    operation: "recipe-trash-move",
    expectedStoreVersion: 256,
    recipeId: f.recipe.recipeId,
  });
  const result = executeLegacyRecipeTrashCommand(f.dbRef.value, f.target, envelope, f.host,
    work => transaction(f.dbRef.value, work), "2026-11-07T12:00:00.000Z");
  assert.equal(result.storeVersion, 257);
  const control = readLegacyProjectControl(f.dbRef.value, f.workspaceId);
  assert.equal(control.receipts.length, 256);
  assert.equal(control.receipts[0].commandId, "historical-command-2");
  assert.equal(control.receipts.at(-1).commandId, "history-rollover-command");
  assert.deepEqual(control.receipts.map(receipt => receipt.storeVersion),
    Array.from({ length: 256 }, (_, index) => index + 2));
});
