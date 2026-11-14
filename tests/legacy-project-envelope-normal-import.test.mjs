import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import { mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import vm from "node:vm";
import test from "node:test";
import { nativeRestoreAuthority } from "./host-composition-legacy-batch16-restore-fixture.mjs";
import ts from "typescript";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { importLegacyWorkspace, planLegacyImport } from "../dist/legacy-import.js";
import {
  readLegacyProjectControl,
  readCurrentLegacyProjectSnapshot,
} from "../dist/legacy-control-import.js";
import {
  readLegacyProjectEnvelopeAdoption,
} from "../dist/legacy-project-envelope.js";
import {
  readProjectRecipes,
} from "../dist/project-recipes.js";
import { Storage } from "../dist/storage.js";
import { createWorkspaceBackup, restoreWorkspaceBackup } from "../dist/workspace-backup.js";
import { createNativeRuntime } from "../dist/native-runtime.js";
import { startHttp } from "../dist/http.js";
import { startMcp } from "../dist/mcp.js";
import { pythonExecutable } from "./batch09-original-control-fixtures.mjs";

const testsRoot = dirname(fileURLToPath(import.meta.url));
const packageRoot = resolve(testsRoot, "../legacy");
const require = createRequire(import.meta.url);
const modules = new Map();
const hash = value => createHash("sha256").update(value).digest("hex");
const request = (operation, args) => ({ operation, args, actorId: "raw-project-normal-import-test" });
const actor = { id: "raw-project-normal-import-test", canWrite: true };
const invocation = (operation, args) => ({ operation, version: 1, arguments: args });
const transaction = (database, action) => {
  database.exec("BEGIN IMMEDIATE");
  try { const result = action(); database.exec("COMMIT"); return result; }
  catch (error) { database.exec("ROLLBACK"); throw error; }
};
function readControl(storage, workspaceId) {
  const database = storage.connectNative();
  try { return readLegacyProjectControl(database, workspaceId); }
  finally { database.close(); }
}

function original(path) {
  if (modules.has(path)) return modules.get(path).exports;
  const module = { exports: {} };
  modules.set(path, module);
  const code = ts.transpileModule(require("node:fs").readFileSync(path, "utf8"), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  const localRequire = name => name.startsWith(".")
    ? original(`${resolve(dirname(path), name)}.ts`)
    : require(name);
  vm.runInThisContext(`(function(require,module,exports,__filename,__dirname){${code}\n})`, { filename: path })
    (localRequire, module, module.exports, path, dirname(path));
  return module.exports;
}

const { ProjectStore } = original(join(packageRoot, "src/workflows/project-store.ts"));
const { canonicalJson } = original(join(packageRoot, "src/workflows/workflow-contracts.ts"));

test("original raw projects.json imports through one normal publish with Project/Recipe recovery", { timeout: 90_000 }, async t => {
  const parent = join(testsRoot, `.legacy-project-normal-import-${randomUUID()}`);
  const source = join(parent, "source");
  const target = join(parent, "native");
  await mkdir(join(source, ".pkm", "state"), { recursive: true });
  await mkdir(join(source, "notes"));
  await mkdir(join(source, "skills"));
  await mkdir(join(source, "papers"));
  t.after(() => rm(parent, { recursive: true, force: true }));

  const store = new ProjectStore(join(source, ".pkm", "state"), randomUUID, { autoMigrate: false });
  const initial = store.list();
  const project = store.createProject({
    commandId: "normal-import-project-create", fingerprint: "opaque-create", expectedStoreVersion: initial.storeVersion,
  }, "Imported Original Project");
  const recipe = store.createRecipe({
    commandId: "normal-import-recipe-create", fingerprint: "opaque-recipe", expectedStoreVersion: project.snapshot.storeVersion,
  }, { kind: "project", projectId: project.entityId }, "Imported Original Recipe", "Guides");
  const sourcePath = join(source, ".pkm", "state", "projects.json");
  const writtenBytes = await readFile(sourcePath);
  const envelope = JSON.parse(writtenBytes.toString("utf8"));
  envelope.compatibilityEnvelopeMetadata = { unknownField: { keep: ["opaque", 17] } };
  await writeFile(sourcePath, canonicalJson(envelope), "utf8");
  const sourceBytes = await readFile(sourcePath);
  const originalSnapshot = store.list();
  const plan = await planLegacyImport(source);
  assert.equal(plan.ready, true, JSON.stringify(plan.blockers));
  assert.ok(plan.projectEnvelopePlan);
  assert.equal(plan.projectEnvelopePlan.sourceSha256, hash(sourceBytes));
  assert.equal(await readFile(sourcePath, "utf8"), sourceBytes.toString("utf8"));

  const receipt = await importLegacyWorkspace(plan, target, { pythonExecutable });
  assert.equal(receipt.controls.some(item => item.path === ".pkm/state/project-store.json"), true);
  assert.deepEqual(await readFile(sourcePath), sourceBytes);

  let storage = await Storage.open(target);
  t.after(async () => { await storage?.close(); });
  const workspaceId = await storage.workspaceId();
  const database = storage.connectNative();
  try {
    const adoption = readLegacyProjectEnvelopeAdoption(database, workspaceId);
    assert.deepEqual(adoption?.sourceBytes, sourceBytes);
    assert.equal(adoption?.receipt.sourceSha256, hash(sourceBytes));
    const imported = readCurrentLegacyProjectSnapshot(database, workspaceId);
    assert.equal(imported.storeVersion, originalSnapshot.storeVersion);
    assert.deepEqual(imported.projects.map(item => item.projectId).sort(),
      originalSnapshot.projects.map(item => item.projectId).sort());
    assert.deepEqual(imported.threads.map(item => item.threadId).sort(),
      originalSnapshot.threads.map(item => item.threadId).sort());
    const importedRecipes = readProjectRecipes(target, request("project.recipe.list", { offset: 0, limit: 100 })).items;
    assert.deepEqual(importedRecipes.map(item => item.recipeId).sort(),
      originalSnapshot.recipes.map(item => item.recipeId).sort());
  } finally { database.close(); }

  await storage.close();
  storage = undefined;
  const backup = join(parent, "backup");
  let backupStorage = await Storage.open(target);
  t.after(async () => { await backupStorage?.close(); });
  await createWorkspaceBackup(backupStorage, backup, {
    acquireQuiescence: async () => ({ assertHeld() {}, release() {} }),
  }, { pythonExecutable });
  await backupStorage.close();
  backupStorage = undefined;
  const restored = join(parent, "restored");
  await restoreWorkspaceBackup(backup, restored, { pythonExecutable, nativeRestoreAuthority });
  const projectUpdateId = randomUUID();
  const recipeUpdateId = randomUUID();
  let projectUpdateArgs;
  let recipeUpdateArgs;
  let projectReadBeforeRestart;
  let recipeReadBeforeRestart;
  let projectMutationResult;
  let recipeMutationResult;
  let runtime;
  let restarted = await Storage.open(restored);
  let http;
  let mcpClient;
  let mcpServer;
  const runtimeOptions = { legacyCommands: { authorize: candidate => candidate.id === actor.id } };
  const openPublic = async storage => {
    runtime = await createNativeRuntime({ storage, ...runtimeOptions });
    http = await startHttp(runtime.core, "raw-project-normal-import-token-000000000000", actor, 0);
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    mcpServer = await startMcp(runtime.core, actor, serverTransport);
    mcpClient = new Client({ name: "raw-project-normal-import-test", version: "1" });
    await mcpClient.connect(clientTransport);
  };
  const closePublic = async () => {
    await mcpClient?.close(); mcpClient = undefined;
    await mcpServer?.close(); mcpServer = undefined;
    if (http) await new Promise(resolveClose => http.server.close(resolveClose));
    http = undefined;
    await runtime?.close(); runtime = undefined;
    await restarted?.close(); restarted = undefined;
  };
  const httpCall = async (method, operation, args) => {
    const response = await fetch(`${http.url}/v1/${method}`, {
      method: "POST",
      headers: { authorization: `Bearer raw-project-normal-import-token-000000000000`, "content-type": "application/json" },
      body: JSON.stringify(invocation(operation, args)),
    });
    return { status: response.status, envelope: await response.json() };
  };
  const mcpCall = (method, operation, args) => mcpClient.callTool({
    name: method, arguments: invocation(operation, args),
  });
  try {
    const restoredDatabase = restarted.connectNative();
    try {
      const restoredAdoption = readLegacyProjectEnvelopeAdoption(restoredDatabase, workspaceId);
      assert.deepEqual(restoredAdoption?.sourceBytes, sourceBytes);
      assert.equal(restoredAdoption?.receipt.sourceSha256, hash(sourceBytes));
    } finally { restoredDatabase.close(); }

    await openPublic(restarted);
    const projectPinEnvelope = await httpCall("capability_read", "project.mutation.pin", {
      entityKind: "project", id: project.entityId,
    });
    assert.equal(projectPinEnvelope.status, 200, JSON.stringify(projectPinEnvelope.envelope));
    const projectPin = projectPinEnvelope.envelope.result;
    assert.ok(projectPin);
    const controlBeforeProjectWrite = readControl(restarted, workspaceId);
    projectUpdateArgs = {
      operationId: projectUpdateId,
      command: {
        commandId: randomUUID(), fingerprint: "opaque-original-project-update",
        operation: "project.update", expectedStoreVersion: controlBeforeProjectWrite.storeVersion,
      },
      update: {
        projectId: project.entityId, expectedVersion: projectPin.version, expectedSha256: projectPin.sha256,
        overview: { goal: "Updated through native Project authority" },
        reason: "Normal raw-envelope import test", at: "2026-11-07T00:00:00.000Z",
        expectedSnapshotRevision: projectPin.snapshotRevision,
      },
    };
    const projectWrite = await httpCall("capability_call", "project.legacy.command", projectUpdateArgs);
    assert.equal(projectWrite.status, 200, JSON.stringify(projectWrite.envelope));
    assert.equal(projectWrite.envelope.error, undefined);
    projectMutationResult = projectWrite.envelope.result;
    assert.equal(projectMutationResult.snapshot.projects.find(item => item.projectId === project.entityId).goal,
      "Updated through native Project authority");

    const recipePinCall = await mcpCall("capability_read", "project.mutation.pin", {
      entityKind: "recipe", id: recipe.entityId,
    });
    const recipePin = recipePinCall.structuredContent.result;
    const currentRecipe = (await mcpCall("capability_read", "project.recipe.get", { id: recipe.entityId }))
      .structuredContent.result.item;
    const controlBeforeRecipeWrite = readControl(restarted, workspaceId);
    recipeUpdateArgs = {
      operationId: recipeUpdateId,
      command: {
        commandId: randomUUID(), fingerprint: "opaque-original-recipe-update",
        operation: "recipe-update", expectedStoreVersion: controlBeforeRecipeWrite.storeVersion,
      },
      args: {
        expectedSnapshotRevision: recipePin.snapshotRevision, recipeId: recipe.entityId,
        expectedRevision: recipePin.version, expectedExecutableDigest: recipePin.executableDigest,
        expectedSha256: recipePin.sha256, name: currentRecipe.name, category: currentRecipe.category,
        description: "Updated after raw-envelope import", definition: currentRecipe.definition,
      },
    };
    const recipeWrite = await mcpCall("capability_call", "project.legacy.command", recipeUpdateArgs);
    assert.equal(recipeWrite.structuredContent.error, undefined);
    recipeMutationResult = recipeWrite.structuredContent.result;
    assert.equal(recipeMutationResult.snapshot.recipes.find(item => item.recipeId === recipe.entityId).description,
      recipeUpdateArgs.args.description);

    projectReadBeforeRestart = (await mcpCall("capability_read", "project.get", { id: project.entityId }))
      .structuredContent.result;
    recipeReadBeforeRestart = (await httpCall("capability_read", "project.recipe.get", { id: recipe.entityId }))
      .envelope.result.item;
    assert.equal(projectReadBeforeRestart.item.goal, "Updated through native Project authority");
    assert.equal(recipeReadBeforeRestart.description, "Updated after raw-envelope import");
    const committedDatabase = restarted.connectNative();
    try {
      const control = readLegacyProjectControl(committedDatabase, workspaceId);
      assert.equal(control.storeVersion, originalSnapshot.storeVersion + 2);
      assert.deepEqual(control.receipts.slice(-2).map(item => item.operation), [
        "project.update", "recipe-update",
      ]);
      assert.equal(committedDatabase.prepare("SELECT count(*) AS n FROM receipts WHERE operation_id=?")
        .get(projectUpdateId).n, 1);
      assert.equal(committedDatabase.prepare("SELECT count(*) AS n FROM receipts WHERE operation_id=?")
        .get(recipeUpdateId).n, 1);
    } finally { committedDatabase.close(); }
  } finally { await closePublic(); }

  restarted = await Storage.open(restored);
  try {
    await openPublic(restarted);
    const projectRead = await httpCall("capability_read", "project.get", { id: project.entityId });
    assert.equal(projectRead.status, 200);
    assert.deepEqual(projectRead.envelope.result, projectReadBeforeRestart);
    const recipeRead = await mcpCall("capability_read", "project.recipe.get", { id: recipe.entityId });
    assert.deepEqual(recipeRead.structuredContent.result.item, recipeReadBeforeRestart);
    assert.deepEqual(projectRead.envelope.result, projectReadBeforeRestart);
    assert.deepEqual(recipeRead.structuredContent.result.item, recipeReadBeforeRestart);

    const projectReplay = await httpCall("capability_call", "project.legacy.command", projectUpdateArgs);
    assert.equal(projectReplay.status, 200);
    assert.equal(projectReplay.envelope.result.replayed, true);
    assert.equal(projectReplay.envelope.result.entityId, project.entityId);
    const currentStoreVersion = readControl(restarted, workspaceId).storeVersion;
    assert.equal(projectReplay.envelope.result.snapshot.storeVersion, currentStoreVersion);
    assert.equal(projectReplay.envelope.result.snapshot.projects.find(item => item.projectId === project.entityId).goal,
      "Updated through native Project authority");
    const recipeReplay = await mcpCall("capability_call", "project.legacy.command", recipeUpdateArgs);
    assert.equal(recipeReplay.structuredContent.result.replayed, true);
    assert.equal(recipeReplay.structuredContent.result.entityId, recipe.entityId);
    assert.equal(recipeReplay.structuredContent.result.snapshot.storeVersion, currentStoreVersion);
    assert.equal(recipeReplay.structuredContent.result.snapshot.recipes.find(item => item.recipeId === recipe.entityId).description,
      "Updated after raw-envelope import");

    const finalDatabase = restarted.connectNative();
    try {
      const finalAdoption = readLegacyProjectEnvelopeAdoption(finalDatabase, workspaceId);
      assert.deepEqual(finalAdoption?.sourceBytes, sourceBytes);
      assert.equal(finalAdoption?.receipt.sourceSha256, hash(sourceBytes));
      const finalControl = readLegacyProjectControl(finalDatabase, workspaceId);
      assert.equal(finalControl.storeVersion, originalSnapshot.storeVersion + 2);
      assert.deepEqual(finalControl.receipts.slice(-2).map(item => item.operation), [
        "project.update", "recipe-update",
      ]);
      assert.equal(finalDatabase.prepare("SELECT count(*) AS n FROM receipts WHERE operation_id=?")
        .get(projectUpdateId).n, 1);
      assert.equal(finalDatabase.prepare("SELECT count(*) AS n FROM receipts WHERE operation_id=?")
        .get(recipeUpdateId).n, 1);
    } finally { finalDatabase.close(); }
  } finally { await closePublic(); }
  const projectDirectories = await readdir(join(restored, "project"), { withFileTypes: true });
  let projectFile;
  for (const entry of projectDirectories.filter(item => item.isDirectory())) {
    const candidate = join(restored, "project", entry.name, "project.json");
    try {
      if (JSON.parse(await readFile(candidate, "utf8")).projectId === project.entityId) {
        projectFile = candidate;
        break;
      }
    } catch { continue; }
  }
  assert.ok(projectFile, "restored current Project control file exists");
  await writeFile(projectFile, JSON.stringify({ projectId: project.entityId, name: "Tampered current bytes", version: 99 }));
  await assert.rejects(Storage.open(restored), error => error?.code === "CONTROL_STORAGE_CORRUPT");
  assert.deepEqual(await readFile(sourcePath), sourceBytes);
});
