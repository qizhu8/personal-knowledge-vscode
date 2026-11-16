import test from "node:test";
import { nativeRestoreAuthority } from "./host-composition-legacy-batch16-restore-fixture.mjs";
import assert from "node:assert/strict";
import { createRequire, syncBuiltinESMExports } from "node:module";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { existsSync, readFileSync } from "node:fs";
import { cp, mkdir, readFile, writeFile, rm } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import vm from "node:vm";
import ts from "typescript";
import { DatabaseSync } from "node:sqlite";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { fixture, pythonExecutable, hash } from "./batch09-original-control-fixtures.mjs";
import { importLegacyWorkspace, planLegacyImport } from "../dist/legacy-import.js";
import { legacyProjectDomainDigest, readLegacyProjectControl } from "../dist/legacy-control-import.js";
import { readProjectRecipes } from "../dist/project-recipes.js";
import { readProjectMutationPin } from "../dist/project-mutations.js";
import { safeProjectDirectoryName } from "../dist/domain/project-recipes-project-rules.js";
import { canonicalJson } from "../dist/domain/project-recipes-workflow-contracts.js";
import { initializeLegacyExtensionJournal, compileLegacyExtensionEffectPlan, stageLegacyExtensionEffect,
  inspectLegacyExtensionPending, recoverLegacyExtensionEffects, commitLegacyExtensionEffects } from "../dist/legacy-command-extension-recovery.js";
import { readLegacyExtensionPendingEnvelope } from "../dist/legacy-command-extension-recovery.js";
import { checkLegacyExtensionCommand } from "../dist/legacy-command-extension-journal.js";
import { executeLegacyExtensionCommand, readLegacyExtensionSnapshot } from "../dist/legacy-command-extension-runtime.js";
import { originalLegacyCommandSources } from "../dist/domain/legacy-command-extension-provenance.js";
import { createNativeRuntime } from "../dist/native-runtime.js";
import { startHttp } from "../dist/http.js";
import { startMcp } from "../dist/mcp.js";
import { Storage } from "../dist/storage.js";
import { createWorkspaceBackup, restoreWorkspaceBackup } from "../dist/workspace-backup.js";
import { projectOriginalSource } from "./legacy-project-original-captures.mjs";

// Execute the current original TypeScript, not a potentially stale extension build.
const repository = resolve(dirname(fileURLToPath(import.meta.url)), "../legacy");
const require = createRequire(import.meta.url), modules = new Map();
function original(path) {
  if (modules.has(path)) return modules.get(path).exports;
  const module = { exports: {} }; modules.set(path, module);
  const code = ts.transpileModule(readFileSync(path, "utf8"), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  const localRequire = name => {
    if (!name.startsWith(".")) return require(name);
    const candidate = resolve(dirname(path), name);
    const file = existsSync(`${candidate}.ts`) ? `${candidate}.ts` : join(candidate, "index.ts");
    return original(file);
  };
  vm.runInThisContext(`(function(require,module,exports,__filename,__dirname){${code}\n})`, { filename: path })
    (localRequire, module, module.exports, path, dirname(path));
  return module.exports;
}
const { ProjectStore } = original(join(repository, "src/workflows/project-store.ts"));
const { RecipeFilesystemStore } = original(join(repository, "src/workflows/recipe-filesystem-store.ts"));
const actorId = "legacy-extension-oracle";
const now = "2026-11-07T00:00:00.000Z";
function comparable(snapshot) {
  const copy = structuredClone(snapshot);
  for (const [field, id] of [["projects", "projectId"], ["threads", "threadId"], ["ganttTasks", "taskId"],
    ["collaborationTasks", "collaborationId"], ["recipes", "recipeId"]]) {
    copy[field].sort((a, b) => a[id].localeCompare(b[id]));
  }
  return copy;
}
function transaction(db, action) {
  db.exec("BEGIN IMMEDIATE");
  try { const result = action(); db.exec("COMMIT"); return result; }
  catch (error) { db.exec("ROLLBACK"); throw error; }
}
test("original oracle source fingerprints remain distinct from native implementation qualification", () => {
  for (const source of originalLegacyCommandSources) {
    assert.equal(hash(projectOriginalSource(source.path, source.sha256)), source.sha256, source.path);
    assert.ok(source.symbols.length > 0);
  }
});
async function setup(t) {
  const f = await fixture(t), oracleRoot = join(f.parent, "oracle");
  const projectId = `project_${randomUUID()}`;
  const projectPath = `project/${safeProjectDirectoryName("Oracle Project", projectId)}`;
  const project = { projectId, name: "Oracle Project", version: 1 };
  const thread = { threadId: `thread_${randomUUID()}`, projectId, name: "Imported Thread", description: "",
    archived: false, legacyAliases: [], version: 1 };
  await f.file(`${projectPath}/project.json`, `${JSON.stringify(project, null, 2)}\n`);
  await f.file(`${projectPath}/threads/${thread.threadId}.json`, `${JSON.stringify(thread, null, 2)}\n`);
  await mkdir(join(f.source, projectPath, "gantt"));
  await mkdir(join(f.source, projectPath, "collaboration"));
  const domain = { ...f.domain, projects: [...f.domain.projects, project], threads: [...f.domain.threads, thread] };
  await f.file(".pkm/state/project-store.json", JSON.stringify({ ...f.projectControl,
    canonicalDigest: legacyProjectDomainDigest(domain) }));
  await cp(f.source, oracleRoot, { recursive: true });
  new RecipeFilesystemStore(join(oracleRoot, ".pkm/state")).put(f.recipe);
  let nextId = randomUUID();
  const store = new ProjectStore(join(oracleRoot, ".pkm/state"), () => nextId);
  const initial = store.list();
  assert.equal(legacyProjectDomainDigest(initial), legacyProjectDomainDigest(domain));
  await rm(join(f.source, "recipes"), { recursive: true });
  await cp(join(oracleRoot, "recipes"), join(f.source, "recipes"), { recursive: true });
  await rm(join(f.source, "recipes/.trash"), { recursive: true, force: true });
  const importPlan = await planLegacyImport(f.source);
  assert.equal(importPlan.blockers.length, 0, JSON.stringify(importPlan.blockers));
  await importLegacyWorkspace(importPlan, f.target, { pythonExecutable });
  let db;
  const workspaceId = JSON.parse(await readFile(join(f.target, ".pkm-next-workspace"), "utf8")).id;
  function open() { db = new DatabaseSync(join(f.target, "core.sqlite")); }
  open(); t.after(() => db.close());
  transaction(db, () => initializeLegacyExtensionJournal(db));
  const request = (operation, args) => ({ operation, args, actorId });
  const revision = () => readProjectRecipes(f.target, request("project.list", { offset: 0, limit: 100 })).snapshotRevision;
  const envelope = (operation, version) => ({ workspaceId, operationId: randomUUID(), actorId,
    globalFingerprint: hash(operation + randomUUID()), command: { commandId: randomUUID(),
      fingerprint: "opaque original user command", operation, expectedStoreVersion: version } });
  return { ...f, store, oracleRoot, projectId, projectPath, workspaceId, request, revision, envelope,
    get db() { return db; }, reopen() { db.close(); open(); }, setNextId(id) { nextId = id; } };
}

test("real original ProjectStore archive and Recipe create/update oracle equals native effects, receipts and restart", async t => {
  const f = await setup(t);
  let version = readLegacyProjectControl(f.db, f.workspaceId).storeVersion;
  const archive = f.envelope("project-archive", version);
  const pin = readProjectMutationPin(f.target, f.request("project.mutation.pin", { entityKind: "project", id: f.projectId }));
  const effect = compileLegacyExtensionEffectPlan(f.db, f.target, archive, {
    expectedSnapshotRevision: pin.snapshotRevision, projectId: f.projectId, expectedVersion: pin.version,
    expectedSha256: pin.sha256, at: now,
  });
  // Date/UUID entropy are dependencies of the original source; pin them to the native event.
  const crypto = require("crypto"), oldUUID = crypto.randomUUID, OldDate = globalThis.Date;
  const eventId = effect.plan.result.item.timeline.at(-1).eventId;
  crypto.randomUUID = () => eventId.slice("event_".length);
  globalThis.Date = class extends OldDate { constructor(...args) { super(...(args.length ? args : [now])); } };
  let expected;
  try { expected = f.store.lifecycleProject(archive.command, f.projectId, "archive"); }
  finally { crypto.randomUUID = oldUUID; globalThis.Date = OldDate; }
  assert.deepEqual(effect.plan.result.item, expected.snapshot.projects.find(item => item.projectId === f.projectId));
  transaction(f.db, () => stageLegacyExtensionEffect(f.db, archive, effect));
  f.reopen();
  assert.equal(inspectLegacyExtensionPending(f.db, f.target, archive).state, "before");
  const verified = recoverLegacyExtensionEffects(f.db, f.target, archive);
  assert.equal(legacyProjectDomainDigest(verified.snapshot), legacyProjectDomainDigest(expected.snapshot));
  transaction(f.db, () => commitLegacyExtensionEffects(f.db, archive, verified, now));
  assert.deepEqual(comparable(readLegacyExtensionSnapshot(f.db, f.target, f.workspaceId)), comparable(expected.snapshot));
  assert.deepEqual(await readFile(join(f.target, effect.plan.files[0].relativePath)),
    await readFile(join(f.oracleRoot, effect.plan.files[0].relativePath)));
  version++;
  assert.equal(readLegacyProjectControl(f.db, f.workspaceId).storeVersion, expected.snapshot.storeVersion);
  assert.equal(checkLegacyExtensionCommand(f.db, f.workspaceId, { ...archive.command, expectedStoreVersion: 1 }).status, "replay");

  const create = f.envelope("recipe-create", version);
  const createEffect = compileLegacyExtensionEffectPlan(f.db, f.target, create, {
    expectedSnapshotRevision: f.revision(), scope: "global", name: "Oracle Recipe", category: "Examples",
  });
  f.setNextId(createEffect.plan.result.entityId.slice("recipe_".length));
  const created = f.store.createRecipe(create.command, { kind: "global" }, "Oracle Recipe", "Examples");
  assert.deepEqual(createEffect.plan.result.item, created.snapshot.recipes.find(item => item.recipeId === created.entityId));
  transaction(f.db, () => stageLegacyExtensionEffect(f.db, create, createEffect));
  const createdVerified = recoverLegacyExtensionEffects(f.db, f.target, create);
  f.reopen();
  assert.equal(inspectLegacyExtensionPending(f.db, f.target, create).state, "after");
  transaction(f.db, () => commitLegacyExtensionEffects(f.db, create, createdVerified, now));
  assert.deepEqual(comparable(readLegacyExtensionSnapshot(f.db, f.target, f.workspaceId)), comparable(created.snapshot));
  assert.deepEqual(await readFile(join(f.target, createEffect.plan.files[0].relativePath)),
    await readFile(join(f.oracleRoot, createEffect.plan.files[0].relativePath)));
  version++;
  const recipe = createEffect.plan.result.item;
  const recipePin = readProjectMutationPin(f.target, f.request("project.mutation.pin", { entityKind: "recipe", id: recipe.recipeId }));
  const update = f.envelope("recipe-update", version);
  const input = { name: "Moved Oracle Recipe", category: "Renamed", description: " Oracle update ", definition: recipe.definition };
  const updateEffect = compileLegacyExtensionEffectPlan(f.db, f.target, update, {
    ...input, expectedSnapshotRevision: recipePin.snapshotRevision, recipeId: recipe.recipeId,
    expectedRevision: recipePin.version, expectedExecutableDigest: recipePin.executableDigest, expectedSha256: recipePin.sha256,
  });
  const updated = f.store.updateRecipe(update.command, recipe.recipeId, input);
  assert.deepEqual(updateEffect.plan.result.item, updated.snapshot.recipes.find(item => item.recipeId === recipe.recipeId));
  transaction(f.db, () => stageLegacyExtensionEffect(f.db, update, updateEffect));
  const firstFile = updateEffect.plan.files[0];
  await mkdir(dirname(join(f.target, firstFile.relativePath)), { recursive: true });
  await writeFile(join(f.target, firstFile.relativePath), Buffer.from(firstFile.afterBase64, "base64"));
  f.reopen();
  assert.equal(inspectLegacyExtensionPending(f.db, f.target, update).state, "mixed");
  const updatedVerified = recoverLegacyExtensionEffects(f.db, f.target, update);
  transaction(f.db, () => commitLegacyExtensionEffects(f.db, update, updatedVerified, now));
  assert.deepEqual(comparable(readLegacyExtensionSnapshot(f.db, f.target, f.workspaceId)), comparable(updated.snapshot));
  assert.deepEqual(await readFile(join(f.target, updateEffect.plan.files[0].relativePath)),
    await readFile(join(f.oracleRoot, updateEffect.plan.files[0].relativePath)));
  assert.deepEqual(readProjectRecipes(f.target, f.request("project.recipe.get", { id: recipe.recipeId })).item,
    updated.snapshot.recipes.find(item => item.recipeId === recipe.recipeId));
  const actualControl = readLegacyProjectControl(f.db, f.workspaceId);
  const originalControl = JSON.parse(await readFile(join(f.oracleRoot, ".pkm/state/project-store.json"), "utf8"));
  assert.deepEqual(actualControl.receipts.map(({ ordinal, ...receipt }) => receipt), originalControl.receipts);
  assert.equal(actualControl.storeVersion, originalControl.storeVersion);
  assert.equal(actualControl.canonicalDigest, originalControl.canonicalDigest);
  f.reopen();
  assert.equal(checkLegacyExtensionCommand(f.db, f.workspaceId, { ...update.command, operation: "historical", expectedStoreVersion: 1 }).status, "replay");
  const { backup: sqliteBackup } = await import("node:sqlite");
  await sqliteBackup(f.db, join(f.parent, "backup.sqlite"));
  const reopened = new DatabaseSync(join(f.parent, "backup.sqlite"));
  try {
    assert.deepEqual(readLegacyProjectControl(reopened, f.workspaceId), readLegacyProjectControl(f.db, f.workspaceId));
    assert.equal(reopened.prepare("SELECT COUNT(*) AS n FROM legacy_command_extension_intent").get().n, 0);
    assert.equal(reopened.prepare("SELECT COUNT(*) AS n FROM pending_project_mutation").get().n, 0);
  } finally { reopened.close(); }
});

test("explicit native command runtime runs multiple new operations and replays current snapshots without SQL filesystem work", async t => {
  const f = await setup(t);
  const fs = require("node:fs"), originals = new Map();
  for (const name of ["lstatSync", "readFileSync", "readdirSync", "mkdirSync", "unlinkSync", "openSync", "closeSync",
    "fstatSync", "fsyncSync", "writeFileSync", "renameSync"]) {
    const fn = fs[name]; originals.set(name, fn);
    fs[name] = (...args) => {
      assert.equal(f.db.isTransaction, false, `${name} must not run inside a SQL transaction`);
      return fn(...args);
    };
  }
  syncBuiltinESMExports();
  t.after(() => { for (const [name, fn] of originals) fs[name] = fn; syncBuiltinESMExports(); });
  const host = { assertExclusive() {} };
  const beforeVersion = readLegacyProjectControl(f.db, f.workspaceId).storeVersion;
  const create = f.envelope("recipe-create", beforeVersion);
  const args = { expectedSnapshotRevision: f.revision(), scope: "global", name: "Runtime Recipe", category: "Runtime" };
  const result = executeLegacyExtensionCommand(f.db, f.target, { envelope: create, args }, host, now);
  assert.equal(result.storeVersion, beforeVersion + 1);
  const recipe = result.snapshot.recipes.find(item => item.recipeId === result.entityId);
  const pin = readProjectMutationPin(f.target, f.request("project.mutation.pin", { entityKind: "recipe", id: recipe.recipeId }));
  const update = f.envelope("recipe-update", result.storeVersion);
  const updateArgs = { expectedSnapshotRevision: pin.snapshotRevision, recipeId: recipe.recipeId, expectedRevision: pin.version,
    expectedExecutableDigest: pin.executableDigest, expectedSha256: pin.sha256,
    name: recipe.name, category: recipe.category, description: "Current content", definition: recipe.definition };
  assert.throws(() => executeLegacyExtensionCommand(f.db, f.target, { envelope: update,
    args: { ...updateArgs, expectedSha256: "f".repeat(64) } }, host, now));
  assert.equal(readLegacyProjectControl(f.db, f.workspaceId).storeVersion, result.storeVersion);
  assert.equal(f.db.prepare("SELECT COUNT(*) AS n FROM pending_project_mutation").get().n, 0);
  const updated = executeLegacyExtensionCommand(f.db, f.target, { envelope: update, args: updateArgs }, host, now);
  f.reopen();
  const replay = executeLegacyExtensionCommand(f.db, f.target, { envelope: { ...create,
    command: { ...create.command, operation: "historical", expectedStoreVersion: 1 } } }, host, now);
  assert.equal(replay.replayed, true);
  assert.equal(replay.snapshot.recipes.find(item => item.recipeId === recipe.recipeId).description, "Current content");
  assert.equal(replay.storeVersion, updated.storeVersion);
  const conflict = { ...create, command: { ...create.command, fingerprint: "different" } };
  assert.throws(() => executeLegacyExtensionCommand(f.db, f.target, { envelope: conflict }, host, now),
    error => error.code === "COMMAND_CONFLICT");
  assert.throws(() => executeLegacyExtensionCommand(f.db, f.target, { envelope: { ...create, globalFingerprint: "f".repeat(64) } }, host, now),
    error => error.code === "GLOBAL_OPERATION_CONFLICT");
  const projectPin = readProjectMutationPin(f.target, f.request("project.mutation.pin", { entityKind: "project", id: f.projectId }));
  const archive = f.envelope("project-archive", updated.storeVersion);
  const archived = executeLegacyExtensionCommand(f.db, f.target, { envelope: archive, args: {
    expectedSnapshotRevision: projectPin.snapshotRevision, projectId: f.projectId, expectedVersion: projectPin.version,
    expectedSha256: projectPin.sha256, at: now,
  } }, host, now);
  assert.equal(archived.snapshot.projects.find(item => item.projectId === f.projectId).archivedAt, now);
  assert.equal(archived.storeVersion, updated.storeVersion + 1);
  assert.equal(f.db.prepare("SELECT COUNT(*) AS n FROM legacy_command_extension_intent").get().n, 0);
  const threadCreate = f.envelope("thread-create", archived.storeVersion);
  const createdThread = executeLegacyExtensionCommand(f.db, f.target, {
    envelope: threadCreate, args: { projectId: f.projectId, name: "Runtime Thread" },
  }, host, now);
  assert.equal(createdThread.storeVersion, archived.storeVersion + 1);
  assert.equal(createdThread.snapshot.threads.find(item => item.threadId === createdThread.entityId).name, "Runtime Thread");
});

test("Project/Thread command traverses authenticated Core HTTP and MCP transports with original identity and replay", async t => {
  const f = await setup(t), actor = { id: actorId, canWrite: true }, storage = await Storage.open(f.target);
  let runtime, http, mcp, client;
  t.after(async () => {
    await client?.close();
    await mcp?.close();
    if (http) await new Promise(resolve => http.server.close(resolve));
    await runtime?.close();
    await storage.close();
  });
  runtime = await createNativeRuntime({ storage, legacyCommands: {
    authorize: (candidate, workspaceId) => candidate.id === actorId && candidate.canWrite && workspaceId === f.workspaceId,
    projectThreadMoveGuard: () => ({ linkedActiveRunIds: [], audienceChanges: false }),
  } });
  http = await startHttp(runtime.core, "batch11-synthetic-project-token-000000000000", actor, 0);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  mcp = await startMcp(runtime.core, actor, serverTransport);
  client = new Client({ name: "batch11-project-thread", version: "1" });
  await client.connect(clientTransport);
  const control = readLegacyProjectControl(f.db, f.workspaceId);
  const command = { commandId: `batch11-thread-${randomUUID()}`, fingerprint: "opaque-original-thread-create",
    operation: "thread-create", expectedStoreVersion: control.storeVersion };
  const args = { operationId: randomUUID(), command, args: { projectId: f.projectId, name: "Transport Thread" } };
  const invocation = { operation: "project.legacy.command", version: 1, arguments: args };
  const response = await fetch(`${http.url}/v1/capability_call`, {
    method: "POST",
    headers: { authorization: `Bearer batch11-synthetic-project-token-000000000000`, "content-type": "application/json" },
    body: JSON.stringify(invocation),
  });
  assert.equal(response.status, 200);
  const httpResult = (await response.json()).result;
  assert.equal(httpResult.replayed, false);
  const created = httpResult.snapshot.threads.find(item => item.threadId === httpResult.entityId);
  assert.deepEqual({ ...created, version: 1 }, { threadId: created.threadId, projectId: f.projectId,
    name: "Transport Thread", description: "", archived: false, legacyAliases: [], version: 1 });
  f.setNextId(created.threadId.slice("thread_".length));
  const original = f.store.createThread(command, f.projectId, "Transport Thread");
  assert.deepEqual(created, original.snapshot.threads.find(item => item.threadId === created.threadId));
  const replay = await client.callTool({ name: "capability_call", arguments: invocation });
  assert.equal(replay.isError, false);
  assert.equal(replay.structuredContent.result.replayed, true);
  assert.equal(replay.structuredContent.result.snapshot.threads.filter(item => item.threadId === created.threadId).length, 1);
  const moveVersion = readLegacyProjectControl(f.db, f.workspaceId).storeVersion;
  const unguardedMove = { operationId: randomUUID(), command: {
    commandId: `batch11-move-${randomUUID()}`, fingerprint: "opaque-original-thread-move",
    operation: "thread-move", expectedStoreVersion: moveVersion,
  }, args: { threadId: created.threadId, destinationProjectId: f.projectId, linkedActiveRunIds: ["untrusted"],
    includedRunIds: [], audienceChanges: false, audienceChangeConfirmed: false } };
  const denied = await fetch(`${http.url}/v1/capability_call`, {
    method: "POST",
    headers: { authorization: `Bearer batch11-synthetic-project-token-000000000000`, "content-type": "application/json" },
    body: JSON.stringify({ operation: "project.legacy.command", version: 1, arguments: unguardedMove }),
  });
  assert.notEqual(denied.status, 200);
  assert.equal(readLegacyProjectControl(f.db, f.workspaceId).storeVersion, moveVersion);

  const callHttp = async arguments_ => {
    const response = await fetch(`${http.url}/v1/capability_call`, {
      method: "POST",
      headers: { authorization: `Bearer batch11-synthetic-project-token-000000000000`, "content-type": "application/json" },
      body: JSON.stringify({ operation: "project.legacy.command", version: 1, arguments: arguments_ }),
    });
    assert.equal(response.status, 200);
    return (await response.json()).result;
  };
  const projectCreate = f.envelope("project-create", readLegacyProjectControl(f.db, f.workspaceId).storeVersion);
  const newProject = await callHttp({ operationId: projectCreate.operationId, command: projectCreate.command,
    args: { name: "Transport Project" } });
  f.setNextId(newProject.entityId.slice("project_".length));
  const actualProject = newProject.snapshot.projects.find(item => item.projectId === newProject.entityId);
  const originalProject = f.store.createProject(projectCreate.command, "Transport Project");
  assert.equal(actualProject.projectId, originalProject.snapshot.projects.find(item => item.projectId === newProject.entityId).projectId);
  assert.equal(actualProject.name, "Transport Project");

  const rename = f.envelope("thread-rename", readLegacyProjectControl(f.db, f.workspaceId).storeVersion);
  const renameArgs = { threadId: created.threadId, name: "Renamed transport thread" };
  const renamed = await callHttp({ operationId: rename.operationId, command: rename.command, args: renameArgs });
  const originalRename = f.store.renameThread(rename.command, renameArgs.threadId, renameArgs.name);
  assert.deepEqual(renamed.snapshot.threads.find(item => item.threadId === created.threadId),
    originalRename.snapshot.threads.find(item => item.threadId === created.threadId));

  const move = f.envelope("thread-move", readLegacyProjectControl(f.db, f.workspaceId).storeVersion);
  const moveArgs = { threadId: created.threadId, destinationProjectId: newProject.entityId, linkedActiveRunIds: [],
    includedRunIds: [], audienceChanges: false, audienceChangeConfirmed: false };
  const moved = await callHttp({ operationId: move.operationId, command: move.command, args: moveArgs });
  const originalMove = f.store.moveThread(move.command, moveArgs);
  assert.deepEqual(moved.snapshot.threads.find(item => item.threadId === created.threadId),
    originalMove.snapshot.threads.find(item => item.threadId === created.threadId));
});

test("Project/Thread no-op and mixed move recover through public transports, replay, and backup", async t => {
  const f = await setup(t), actor = { id: actorId, canWrite: true };
  let storage = await Storage.open(f.target), runtime, http, mcp, client;
  const closeTransports = async () => {
    await client?.close(); client = undefined;
    await mcp?.close(); mcp = undefined;
    if (http) await new Promise(resolve => http.server.close(resolve));
    http = undefined;
  };
  const closeRuntime = async () => {
    await closeTransports();
    await runtime?.close(); runtime = undefined;
  };
  const bearer = ["batch11", "project", "thread", "transport", "recovery"].join("-").padEnd(48, "x");
  const openRuntime = async () => createNativeRuntime({ storage, legacyCommands: {
    authorize: (candidate, workspaceId) => candidate.id === actorId && candidate.canWrite && workspaceId === f.workspaceId,
    projectThreadMoveGuard: () => ({ linkedActiveRunIds: [], audienceChanges: false }),
  } });
  const openTransports = async () => {
    runtime = await openRuntime();
    http = await startHttp(runtime.core, bearer, actor, 0);
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    mcp = await startMcp(runtime.core, actor, serverTransport);
    client = new Client({ name: "batch11-thread-recovery", version: "1" });
    await client.connect(clientTransport);
  };
  t.after(async () => { await closeRuntime(); await storage?.close(); });
  const callHttp = async arguments_ => {
    const response = await fetch(`${http.url}/v1/capability_call`, {
      method: "POST",
      headers: { authorization: "Bearer " + bearer, "content-type": "application/json" },
      body: JSON.stringify({ operation: "project.legacy.command", version: 1, arguments: arguments_ }),
    });
    return { status: response.status, body: await response.json() };
  };
  const callMcp = async arguments_ => client.callTool({ name: "capability_call", arguments: {
    operation: "project.legacy.command", version: 1, arguments: arguments_,
  } });
  const version = () => readLegacyProjectControl(f.db, f.workspaceId).storeVersion;
  const issue = (operation, args) => {
    const envelope = f.envelope(operation, version());
    return { operationId: envelope.operationId, command: envelope.command, args };
  };
  const compareSnapshot = native => {
    const oracle = f.store.list();
    assert.equal(legacyProjectDomainDigest(native.snapshot), legacyProjectDomainDigest(oracle));
    assert.equal(native.storeVersion, oracle.storeVersion);
  };

  await openTransports();
  const create = issue("thread-create", { projectId: f.projectId, name: "Transport created thread" });
  const created = await callHttp(create);
  assert.equal(created.status, 200);
  f.setNextId(created.body.result.entityId.slice("thread_".length));
  const expectedCreate = f.store.createThread(create.command, f.projectId, create.args.name);
  assert.equal(legacyProjectDomainDigest(created.body.result.snapshot), legacyProjectDomainDigest(expectedCreate.snapshot));
  const originalThread = created.body.result.snapshot.threads.find(item => item.threadId === created.body.result.entityId);
  const threadPath = join(f.target, f.projectPath, "threads", `${originalThread.threadId}.json`);
  const originalThreadBytes = await readFile(threadPath);
  const sameName = issue("thread-rename", { threadId: originalThread.threadId, name: ` ${originalThread.name} ` });
  const expectedRename = f.store.renameThread(sameName.command, originalThread.threadId, sameName.args.name);
  const noopRename = await callMcp(sameName);
  assert.equal(noopRename.isError, false, JSON.stringify(noopRename));
  assert.equal(noopRename.structuredContent.result.replayed, false);
  assert.equal(legacyProjectDomainDigest(noopRename.structuredContent.result.snapshot),
    legacyProjectDomainDigest(expectedRename.snapshot));
  assert.equal(noopRename.structuredContent.result.storeVersion, expectedRename.snapshot.storeVersion);
  assert.equal(noopRename.structuredContent.result.snapshot.threads.find(item => item.threadId === originalThread.threadId).name,
    originalThread.name);
  assert.deepEqual(await readFile(threadPath), originalThreadBytes);
  assert.equal(f.db.prepare("SELECT COUNT(*) AS n FROM receipts WHERE operation_id=?").get(sameName.operationId).n, 1);
  assert.equal(f.db.prepare("SELECT COUNT(*) AS n FROM legacy_project_receipt WHERE command_id=?")
    .get(sameName.command.commandId).n, 1);

  const sameProject = issue("thread-move", {
    threadId: originalThread.threadId, destinationProjectId: originalThread.projectId,
    linkedActiveRunIds: [], includedRunIds: [], audienceChanges: false, audienceChangeConfirmed: false,
  });
  const expectedNoopMove = f.store.moveThread(sameProject.command, sameProject.args);
  const noopMove = await callHttp(sameProject);
  assert.equal(noopMove.status, 200);
  assert.equal(legacyProjectDomainDigest(noopMove.body.result.snapshot), legacyProjectDomainDigest(expectedNoopMove.snapshot));
  assert.equal(noopMove.body.result.storeVersion, expectedNoopMove.snapshot.storeVersion);
  assert.equal(noopMove.body.result.snapshot.threads.find(item => item.threadId === originalThread.threadId).projectId,
    originalThread.projectId);
  assert.deepEqual(await readFile(threadPath), originalThreadBytes);
  assert.equal(f.db.prepare("SELECT COUNT(*) AS n FROM receipts WHERE operation_id=?").get(sameProject.operationId).n, 1);
  assert.equal(f.db.prepare("SELECT COUNT(*) AS n FROM legacy_project_receipt WHERE command_id=?")
    .get(sameProject.command.commandId).n, 1);

  const stale = issue("thread-rename", { threadId: originalThread.threadId, name: "Stale CAS" });
  stale.command.expectedStoreVersion--;
  const beforeStaleVersion = version();
  assert.notEqual((await callHttp(stale)).status, 200);
  assert.equal(version(), beforeStaleVersion);
  assert.equal(f.db.prepare("SELECT COUNT(*) AS n FROM legacy_command_extension_intent").get().n, 0);

  const destinationProjectId = f.domain.projects[0].projectId;
  assert.notEqual(destinationProjectId, originalThread.projectId);
  const moveToDefault = issue("thread-move", {
    threadId: originalThread.threadId, destinationProjectId,
    linkedActiveRunIds: [], includedRunIds: [], audienceChanges: false, audienceChangeConfirmed: false,
  });
  const expectedFirstMove = f.store.moveThread(moveToDefault.command, moveToDefault.args);
  const fs = require("node:fs"), originalOpen = fs.openSync;
  let beforeInjected = false;
  fs.openSync = function(path, ...args) {
    if (!beforeInjected && String(path).includes(`.pkm-write-${moveToDefault.operationId}`)) {
      beforeInjected = true;
      throw new Error("batch11 injected interruption before Thread move filesystem effects");
    }
    return originalOpen.call(this, path, ...args);
  };
  syncBuiltinESMExports();
  let beforeInterrupted;
  try { beforeInterrupted = await callHttp(moveToDefault); }
  finally { fs.openSync = originalOpen; syncBuiltinESMExports(); }
  assert.equal(beforeInjected, true);
  assert.notEqual(beforeInterrupted.status, 200);
  assert.equal(version(), moveToDefault.command.expectedStoreVersion);
  assert.equal(f.db.prepare("SELECT COUNT(*) AS n FROM legacy_command_extension_intent").get().n, 1);
  const beforePending = readLegacyExtensionPendingEnvelope(f.db);
  assert.ok(beforePending);
  assert.equal(inspectLegacyExtensionPending(f.db, f.target, beforePending).state, "before");
  assert.equal(inspectLegacyExtensionPending(f.db, f.target, beforePending).effect.schema,
    "pkm.legacy-project-thread-extension/v1");

  await closeRuntime();
  await storage.close(); storage = undefined;
  storage = await Storage.open(f.target);
  await openTransports();
  const recoveredFirstMove = await callMcp(moveToDefault);
  assert.equal(recoveredFirstMove.isError, false);
  assert.equal(recoveredFirstMove.structuredContent.result.replayed, true);
  assert.equal(legacyProjectDomainDigest(recoveredFirstMove.structuredContent.result.snapshot),
    legacyProjectDomainDigest(expectedFirstMove.snapshot));
  assert.equal(recoveredFirstMove.structuredContent.result.storeVersion, expectedFirstMove.snapshot.storeVersion);
  assert.equal(f.db.prepare("SELECT COUNT(*) AS n FROM legacy_command_extension_intent").get().n, 0);

  const moveBack = issue("thread-move", {
    threadId: originalThread.threadId, destinationProjectId: originalThread.projectId,
    linkedActiveRunIds: [], includedRunIds: [], audienceChanges: false, audienceChangeConfirmed: false,
  });
  const expectedMove = f.store.moveThread(moveBack.command, moveBack.args);
  const originalUnlink = fs.unlinkSync;
  let mixedInjected = false;
  fs.unlinkSync = function(path, ...args) {
    const result = originalUnlink.call(this, path, ...args);
    if (!mixedInjected && String(path).endsWith(`${originalThread.threadId}.json`)) {
      mixedInjected = true;
      throw new Error("batch11 injected interruption after source Thread removal");
    }
    return result;
  };
  syncBuiltinESMExports();
  let interrupted;
  try { interrupted = await callHttp(moveBack); }
  finally { fs.unlinkSync = originalUnlink; syncBuiltinESMExports(); }
  assert.equal(mixedInjected, true);
  assert.notEqual(interrupted.status, 200);
  assert.equal(version(), moveBack.command.expectedStoreVersion);
  assert.equal(f.db.prepare("SELECT COUNT(*) AS n FROM legacy_command_extension_intent").get().n, 1);
  const pending = readLegacyExtensionPendingEnvelope(f.db);
  assert.ok(pending);
  assert.equal(inspectLegacyExtensionPending(f.db, f.target, pending).state, "mixed");
  assert.equal(inspectLegacyExtensionPending(f.db, f.target, pending).effect.schema,
    "pkm.legacy-project-thread-extension/v1");

  const effect = inspectLegacyExtensionPending(f.db, f.target, pending).effect.effect;
  const affected = effect.files[0];
  const affectedPath = join(f.target, ...affected.relativePath.split("/"));
  const originalAffectedBytes = existsSync(affectedPath) ? await readFile(affectedPath) : undefined;
  if (originalAffectedBytes) await writeFile(affectedPath, Buffer.concat([originalAffectedBytes, Buffer.from("tampered")]));
  else await writeFile(affectedPath, "unexpected");
  await closeRuntime();
  await storage.close(); storage = undefined;
  await assert.rejects(Storage.open(f.target), error => typeof error?.code === "string");
  assert.equal(f.db.prepare("SELECT COUNT(*) AS n FROM legacy_command_extension_intent").get().n, 1);
  assert.equal(version(), moveBack.command.expectedStoreVersion);
  assert.equal(f.db.prepare("SELECT 1 FROM receipts WHERE operation_id=?").get(moveBack.operationId), undefined);
  if (originalAffectedBytes) await writeFile(affectedPath, originalAffectedBytes);
  else await rm(affectedPath);

  storage = await Storage.open(f.target);
  await openTransports();
  const recoveredMove = await callMcp(moveBack);
  assert.equal(recoveredMove.isError, false);
  assert.equal(recoveredMove.structuredContent.result.replayed, true);
  assert.equal(legacyProjectDomainDigest(recoveredMove.structuredContent.result.snapshot),
    legacyProjectDomainDigest(expectedMove.snapshot));
  assert.equal(recoveredMove.structuredContent.result.storeVersion, expectedMove.snapshot.storeVersion);
  assert.equal(f.db.prepare("SELECT COUNT(*) AS n FROM legacy_command_extension_intent").get().n, 0);
  assert.equal(f.db.prepare("SELECT COUNT(*) AS n FROM pending_project_mutation").get().n, 0);
  assert.deepEqual(await readFile(join(f.target, ...effect.files.find(file => file.afterSha256 !== null)
    .relativePath.split("/"))), Buffer.from(effect.files.find(file => file.afterSha256 !== null).afterBase64, "base64"));
  assert.equal(f.store.list().threads.find(item => item.threadId === originalThread.threadId).projectId, originalThread.projectId);

  const backupPath = join(f.parent, "thread-recovery-backup"), restoredPath = join(f.parent, "thread-recovery-restored");
  await createWorkspaceBackup(storage, backupPath, {
    acquireQuiescence: async () => ({ assertHeld() {}, release() {} }),
  });
  await closeRuntime();
  await storage.close(); storage = undefined;
  await restoreWorkspaceBackup(backupPath, restoredPath, { nativeRestoreAuthority });
  storage = await Storage.open(restoredPath);
  runtime = await createNativeRuntime({ storage, legacyCommands: {
    authorize: (candidate, workspaceId) => candidate.id === actorId && candidate.canWrite && workspaceId === f.workspaceId,
    projectThreadMoveGuard: () => ({ linkedActiveRunIds: [], audienceChanges: false }),
  } });
  const persisted = await runtime.core.dispatch("capability_read", {
    operation: "project.get", version: 1, arguments: { id: originalThread.projectId },
  }, actor);
  assert.equal(persisted.error, undefined);
  assert.ok(persisted.result.threads.some(item => item.threadId === originalThread.threadId
    && item.projectId === originalThread.projectId));
  compareSnapshot(recoveredMove.structuredContent.result);
});

test("Project-scoped original Recipe creation canonicalizes scope and category identically in explicit runtime", async t => {
  const f = await setup(t), envelope = f.envelope("recipe-create", readLegacyProjectControl(f.db, f.workspaceId).storeVersion);
  const args = { expectedSnapshotRevision: f.revision(), scope: "project", projectId: f.projectId,
    name: "Scoped Oracle Recipe", category: "Guides" };
  const effect = compileLegacyExtensionEffectPlan(f.db, f.target, envelope, args);
  f.setNextId(effect.plan.result.entityId.slice("recipe_".length));
  const expected = f.store.createRecipe(envelope.command, { kind: "project", projectId: f.projectId }, args.name, args.category);
  const result = executeLegacyExtensionCommand(f.db, f.target, { envelope, args }, { assertExclusive() {} }, now);
  assert.deepEqual(comparable(result.snapshot), comparable(expected.snapshot));
  assert.deepEqual(await readFile(join(f.target, effect.plan.files[0].relativePath)),
    await readFile(join(f.oracleRoot, effect.plan.files[0].relativePath)));
  f.reopen();
  const replay = executeLegacyExtensionCommand(f.db, f.target, { envelope }, { assertExclusive() {} }, now);
  assert.equal(replay.replayed, true);
  assert.deepEqual(comparable(replay.snapshot), comparable(expected.snapshot));
});

test("recognized pending inspector rejects unknown and unrelated bytes before writing or committing", async t => {
  const f = await setup(t);
  const create = f.envelope("recipe-create", readLegacyProjectControl(f.db, f.workspaceId).storeVersion);
  const effect = compileLegacyExtensionEffectPlan(f.db, f.target, create, {
    expectedSnapshotRevision: f.revision(), scope: "global", name: "Guarded", category: "Examples",
  });
  assert.throws(() => compileLegacyExtensionEffectPlan(f.db, f.source, create, {
    expectedSnapshotRevision: f.revision(), scope: "global", name: "Wrong root", category: "",
  }), error => error.code === "CONTROL_RECOVERY_CONFLICT");
  transaction(f.db, () => stageLegacyExtensionEffect(f.db, create, effect));
  assert.throws(() => transaction(f.db, () => inspectLegacyExtensionPending(f.db, f.target, create)),
    error => error.code === "FILESYSTEM_TRANSACTION_FORBIDDEN");
  const target = join(f.target, effect.plan.files[0].relativePath);
  await mkdir(dirname(target), { recursive: true }); await writeFile(target, "unknown");
  f.reopen();
  assert.throws(() => recoverLegacyExtensionEffects(f.db, f.target, create), error => error.code === "CONTROL_RECOVERY_CONFLICT");
  assert.equal(await readFile(target, "utf8"), "unknown");
  assert.equal(readLegacyProjectControl(f.db, f.workspaceId).storeVersion, create.command.expectedStoreVersion);
  await rm(target);
  const unaffected = join(f.target, f.projectPath, "project.json"), bytes = await readFile(unaffected);
  await writeFile(unaffected, `${bytes}\n`);
  assert.throws(() => recoverLegacyExtensionEffects(f.db, f.target, create), error => error.code === "CONTROL_RECOVERY_CONFLICT");
  assert.equal(existsSync(target), false);
  await writeFile(unaffected, bytes);
  transaction(f.db, () => f.db.prepare("UPDATE legacy_command_extension_intent SET effect_sha256=?").run("f".repeat(64)));
  assert.throws(() => recoverLegacyExtensionEffects(f.db, f.target, create), error => error.code === "CONTROL_RECOVERY_CONFLICT");
  assert.equal(existsSync(target), false);
});

test("bounded commands deny unrelated Recipe normalization, protected Projects and guarded runtime state before admission", async t => {
  const f = await setup(t);
  const create = f.envelope("recipe-create", readLegacyProjectControl(f.db, f.workspaceId).storeVersion);
  const originalBytes = await readFile(join(f.target, f.recipePath));
  const recipe = JSON.parse(originalBytes);
  recipe.aliases = ["recipe:recipe_control"];
  await writeFile(join(f.target, f.recipePath), `${JSON.stringify(recipe, null, 2)}\n`);
  assert.throws(() => compileLegacyExtensionEffectPlan(f.db, f.target, create, {
    expectedSnapshotRevision: f.revision(), scope: "global", name: "Denied", category: "Examples",
  }), error => error.code === "LEGACY_RECIPE_CANONICALIZATION_REQUIRED");
  await writeFile(join(f.target, f.recipePath), originalBytes);
  const defaultPin = readProjectMutationPin(f.target, f.request("project.mutation.pin", { entityKind: "project", id: f.project.projectId }));
  assert.throws(() => compileLegacyExtensionEffectPlan(f.db, f.target, f.envelope("project-archive", create.command.expectedStoreVersion), {
    expectedSnapshotRevision: defaultPin.snapshotRevision, projectId: f.project.projectId, expectedVersion: defaultPin.version,
    expectedSha256: defaultPin.sha256, at: now,
  }));
  const pin = readProjectMutationPin(f.target, f.request("project.mutation.pin", { entityKind: "project", id: f.projectId }));
  const directory = join(f.target, ".pkm/state/recipe-runs");
  await mkdir(directory, { recursive: true }); await writeFile(join(directory, "unverified.json"), "{}");
  assert.throws(() => compileLegacyExtensionEffectPlan(f.db, f.target, f.envelope("project-archive", create.command.expectedStoreVersion), {
    expectedSnapshotRevision: pin.snapshotRevision, projectId: f.projectId, expectedVersion: pin.version,
    expectedSha256: pin.sha256, at: now,
  }));
  assert.equal(f.db.prepare("SELECT COUNT(*) AS n FROM pending_project_mutation").get().n, 0);
  assert.equal(f.db.prepare("SELECT COUNT(*) AS n FROM legacy_command_extension_intent").get().n, 0);
});

for (const operation of ["project-archive", "recipe-create", "recipe-update"]) {
  for (const state of ["before", "after"]) {
    test(`${operation} restart from exact ${state} bytes retains pinned journal and rolls forward once`, async t => {
      const f = await setup(t), command = f.envelope(operation, readLegacyProjectControl(f.db, f.workspaceId).storeVersion);
      let args;
      if (operation === "project-archive") {
        const pin = readProjectMutationPin(f.target, f.request("project.mutation.pin", { entityKind: "project", id: f.projectId }));
        args = { expectedSnapshotRevision: pin.snapshotRevision, projectId: f.projectId,
          expectedVersion: pin.version, expectedSha256: pin.sha256, at: now };
      } else if (operation === "recipe-create") {
        args = { expectedSnapshotRevision: f.revision(), scope: "global", name: "Restart Recipe", category: "Restart" };
      } else {
        const pin = readProjectMutationPin(f.target, f.request("project.mutation.pin", { entityKind: "recipe", id: f.recipe.recipeId }));
        args = { expectedSnapshotRevision: pin.snapshotRevision, recipeId: f.recipe.recipeId,
          expectedRevision: pin.version, expectedExecutableDigest: pin.executableDigest, expectedSha256: pin.sha256,
          name: f.recipe.name, category: f.recipe.category, description: "Restart update", definition: f.recipe.definition };
      }
      const effect = compileLegacyExtensionEffectPlan(f.db, f.target, command, args);
      transaction(f.db, () => stageLegacyExtensionEffect(f.db, command, effect));
      if (state === "after") recoverLegacyExtensionEffects(f.db, f.target, command);
      const { backup } = await import("node:sqlite");
      await backup(f.db, join(f.parent, "pending-backup.sqlite"));
      const saved = new DatabaseSync(join(f.parent, "pending-backup.sqlite"));
      try {
        assert.deepEqual(readLegacyExtensionPendingEnvelope(saved), command);
        assert.equal(saved.prepare("SELECT COUNT(*) AS n FROM pending_project_mutation").get().n, 1);
      } finally { saved.close(); }
      f.reopen();
      assert.deepEqual(readLegacyExtensionPendingEnvelope(f.db), command);
      assert.equal(inspectLegacyExtensionPending(f.db, f.target, command).state, state);
      const verified = recoverLegacyExtensionEffects(f.db, f.target, command);
      assert.throws(() => transaction(f.db, () => {
        commitLegacyExtensionEffects(f.db, command, verified, now); throw new Error("rollback");
      }), /rollback/);
      assert.equal(readLegacyProjectControl(f.db, f.workspaceId).storeVersion, command.command.expectedStoreVersion);
      assert.equal(f.db.prepare("SELECT COUNT(*) AS n FROM legacy_command_extension_intent").get().n, 1);
      transaction(f.db, () => commitLegacyExtensionEffects(f.db, command, verified, now));
      f.reopen();
      assert.equal(readLegacyExtensionPendingEnvelope(f.db), undefined);
      assert.equal(checkLegacyExtensionCommand(f.db, f.workspaceId, command.command).status, "replay");
      assert.equal(readLegacyProjectControl(f.db, f.workspaceId).storeVersion, command.command.expectedStoreVersion + 1);
      assert.equal(f.db.prepare("SELECT COUNT(*) AS n FROM receipts WHERE operation_id=?").get(command.operationId).n, 1);
    });
  }
}
