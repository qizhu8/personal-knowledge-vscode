import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import { existsSync, readFileSync } from "node:fs";
import { cp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { resolve, join, dirname } from "node:path";
import { runInThisContext } from "node:vm";
import { DatabaseSync, backup as sqliteBackup } from "node:sqlite";
import { test } from "node:test";
import { nativeRestoreAuthority } from "./host-composition-legacy-batch16-restore-fixture.mjs";
import ts from "typescript";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { fixture, pythonExecutable, hash, hashes } from "./batch09-original-control-fixtures.mjs";
import { importLegacyWorkspace, planLegacyImport } from "../dist/legacy-import.js";
import { Storage } from "../dist/storage.js";
import { createNativeRuntime } from "../dist/native-runtime.js";
import { startHttp } from "../dist/http.js";
import { startMcp } from "../dist/mcp.js";
import { legacyProjectDomainDigest, readLegacyProjectControl } from "../dist/legacy-control-import.js";
import { readProjectMutationPin } from "../dist/project-mutations.js";
import { readProjectRecipes } from "../dist/project-recipes.js";
import { compileLegacyExtensionEffectPlan, stageLegacyExtensionEffect, inspectLegacyExtensionPending } from "../dist/legacy-command-extension-recovery.js";
import { createWorkspaceBackup, restoreWorkspaceBackup } from "../dist/workspace-backup.js";
import { legacyProjectInvocationSchema } from "../dist/host-composition-legacy-project-contracts.js";

const require = createRequire(import.meta.url), modules = new Map();
function original(path) {
  if (modules.has(path)) return modules.get(path).exports;
  const mod = { exports: {} }; modules.set(path, mod);
  const code = ts.transpileModule(readFileSync(path, "utf8"), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
  runInThisContext(`(function(require,module,exports,__filename,__dirname){${code}\n})`, { filename: path })(
    name => {
      if (!name.startsWith(".")) return require(name);
      const next = resolve(dirname(path), name);
      return original(existsSync(`${next}.ts`) ? `${next}.ts` : join(next, "index.ts"));
    }, mod, mod.exports, path, dirname(path));
  return mod.exports;
}
const repo = resolve(import.meta.dirname, "../legacy");
const { ProjectStore } = original(join(repo, "src/workflows/project-store.ts"));
const { RecipeFilesystemStore } = original(join(repo, "src/workflows/recipe-filesystem-store.ts"));
const actor = { id: "batch10-native-original-oracle", canWrite: true };
const now = "2026-11-07T00:00:00.000Z";
const invoke = args => ({ operation: "project.legacy.command", version: 1, arguments: args });
function comparable(snapshot) {
  const copy = structuredClone(snapshot);
  for (const [field, id] of [["projects", "projectId"], ["threads", "threadId"], ["ganttTasks", "taskId"], ["collaborationTasks", "collaborationId"], ["recipes", "recipeId"]]) {
    copy[field].sort((a, b) => a[id].localeCompare(b[id]));
  }
  return copy;
}
async function setup(t) {
  const f = await fixture(t), oracleRoot = join(f.parent, "original-oracle");
  const projectId = `project_${randomUUID()}`, projectPath = `project/Oracle.${projectId}`;
  const project = { projectId, name: "Oracle", version: 1 };
  const thread = { threadId: `thread_${randomUUID()}`, projectId, name: "Imported Thread", description: "", archived: false, legacyAliases: [], version: 1 };
  await f.file(`${projectPath}/project.json`, `${JSON.stringify(project, null, 2)}\n`);
  await f.file(`${projectPath}/threads/${thread.threadId}.json`, `${JSON.stringify(thread, null, 2)}\n`);
  for (const name of ["gantt", "collaboration"]) await mkdir(join(f.source, projectPath, name));
  const domain = { ...f.domain, projects: [...f.domain.projects, project], threads: [...f.domain.threads, thread] };
  await f.file(".pkm/state/project-store.json", JSON.stringify({ ...f.projectControl, canonicalDigest: legacyProjectDomainDigest(domain) }));
  await cp(f.source, oracleRoot, { recursive: true });
  new RecipeFilesystemStore(join(oracleRoot, ".pkm/state")).put(f.recipe);
  let nextId;
  const store = new ProjectStore(join(oracleRoot, ".pkm/state"), () => nextId);
  store.list();
  await rm(join(f.source, "recipes"), { recursive: true });
  await cp(join(oracleRoot, "recipes"), join(f.source, "recipes"), { recursive: true });
  await rm(join(f.source, "recipes/.trash"), { recursive: true, force: true });
  const sourceHashes = await hashes(f.source);
  await importLegacyWorkspace(await planLegacyImport(f.source), f.target, { pythonExecutable });
  let storage, runtime, db, permitted = true;
  const result = {
    ...f, oracleRoot, store, newProjectId: projectId, newProjectPath: projectPath, sourceHashes,
    get db() { return db; }, get runtime() { return runtime; }, get storage() { return storage; },
    setId(id) { nextId = id; }, deny() { permitted = false; }, allow() { permitted = true; },
    async open(root = f.target) {
      storage = await Storage.open(root);
      runtime = await createNativeRuntime({ storage, legacyCommands: { authorize: candidate => permitted && candidate.id === actor.id } });
      db = storage.connectNative();
    },
    async close() { db?.close(); db = undefined; await runtime?.close(); runtime = undefined; await storage?.close(); storage = undefined; },
    version() { return readLegacyProjectControl(db, result.workspaceId).storeVersion; },
    pin(kind, id) { return readProjectMutationPin(f.target, { operation: "project.mutation.pin", actorId: actor.id, args: { entityKind: kind, id } }); },
    command(operation, args) { return { operationId: randomUUID(), command: {
      commandId: randomUUID(), fingerprint: "opaque original fingerprint, not native hash", operation, expectedStoreVersion: result.version(),
    }, args }; },
  };
  result.workspaceId = JSON.parse(await readFile(join(f.target, ".pkm-next-workspace"), "utf8")).id;
  await result.open();
  t.after(() => result.close());
  return result;
}
async function transport(f) {
  const bearer = "batch10-native-command-synthetic-token-000000000000";
  const http = await startHttp(f.runtime.core, bearer, actor, 0);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const mcp = await startMcp(f.runtime.core, actor, serverTransport);
  const client = new Client({ name: "batch10-original-commands", version: "1" }); await client.connect(clientTransport);
  return {
    async http(args) {
      const response = await fetch(`${http.url}/v1/capability_call`, { method: "POST", headers: { authorization: `Bearer ${bearer}`, "content-type": "application/json" }, body: JSON.stringify(invoke(args)) });
      return response.json();
    },
    async mcp(args) { return (await client.callTool({ name: "capability_call", arguments: invoke(args) })).structuredContent; },
    async close() { await client.close(); await mcp.close(); await new Promise(resolve => http.server.close(resolve)); },
  };
}

test("Core HTTP/MCP original archive/create/update effects match independent original full snapshots and immutable receipts", async t => {
  const f = await setup(t), io = await transport(f);
  let createdRequest, recipeId;
  try {
    const pin = f.pin("project", f.newProjectId);
    const archive = f.command("project-archive", { expectedSnapshotRevision: pin.snapshotRevision, projectId: f.newProjectId,
      expectedVersion: pin.version, expectedSha256: pin.sha256, at: now });
    const archived = await io.http(archive);
    assert.equal(archived.error, undefined, JSON.stringify(archived.error));
    const eventId = archived.result.snapshot.projects.find(item => item.projectId === f.newProjectId).timeline.at(-1).eventId;
    const crypto = require("node:crypto"), oldUUID = crypto.randomUUID, OldDate = globalThis.Date;
    crypto.randomUUID = () => eventId.slice("event_".length);
    globalThis.Date = class extends OldDate { constructor(...args) { super(...(args.length ? args : [now])); } };
    let expected;
    try { expected = f.store.lifecycleProject(archive.command, f.newProjectId, "archive"); }
    finally { crypto.randomUUID = oldUUID; globalThis.Date = OldDate; }
    assert.deepEqual(comparable(archived.result.snapshot), comparable(expected.snapshot));
    assert.deepEqual(await readFile(join(f.target, f.newProjectPath, "project.json")), await readFile(join(f.oracleRoot, f.newProjectPath, "project.json")));
    const revision = readProjectRecipes(f.target, { operation: "project.recipe.list", actorId: actor.id, args: {} }).snapshotRevision;
    const createInput = { scope: "global", name: "Transport Recipe", category: "Transport" };
    createdRequest = f.command("recipe-create", { ...createInput, expectedSnapshotRevision: revision });
    const created = await io.mcp(createdRequest);
    assert.equal(created.error, undefined, JSON.stringify(created.error));
    recipeId = created.result.entityId; f.setId(recipeId.slice("recipe_".length));
    const originalCreated = f.store.createRecipe(createdRequest.command, { kind: "global" }, createInput.name, createInput.category);
    assert.deepEqual(comparable(created.result.snapshot), comparable(originalCreated.snapshot));
    const recipePin = f.pin("recipe", recipeId);
    const recipe = created.result.snapshot.recipes.find(item => item.recipeId === recipeId);
    const updateInput = { name: "Renamed Transport Recipe", category: "Moved", description: "Current immutable replay content", definition: recipe.definition };
    const update = f.command("recipe-update", { ...updateInput, recipeId, expectedSnapshotRevision: recipePin.snapshotRevision,
      expectedRevision: recipePin.version, expectedSha256: recipePin.sha256, expectedExecutableDigest: recipePin.executableDigest });
    const wrong = await io.http({ ...update, args: { ...update.args, expectedSha256: "f".repeat(64) } });
    assert.ok(wrong.error); assert.equal(f.version(), created.result.storeVersion);
    const updated = await io.http(update);
    assert.equal(updated.error, undefined, JSON.stringify(updated.error));
    const originalUpdated = f.store.updateRecipe(update.command, recipeId, updateInput);
    assert.deepEqual(comparable(updated.result.snapshot), comparable(originalUpdated.snapshot));
    const scopeRevision = readProjectRecipes(f.target, { operation: "project.recipe.list", actorId: actor.id, args: {} }).snapshotRevision;
    const scoped = f.command("recipe-create", { expectedSnapshotRevision: scopeRevision, scope: "project",
      projectId: f.projectId, name: "Project Scoped Transport Recipe", category: "Guides" });
    const scopedResult = await io.mcp(scoped);
    assert.equal(scopedResult.error, undefined, JSON.stringify(scopedResult.error));
    f.setId(scopedResult.result.entityId.slice("recipe_".length));
    const originalScoped = f.store.createRecipe(scoped.command, { kind: "project", projectId: f.projectId }, scoped.args.name, scoped.args.category);
    assert.deepEqual(comparable(scopedResult.result.snapshot), comparable(originalScoped.snapshot));
    const replay = await io.mcp(createdRequest);
    assert.equal(replay.error, undefined, JSON.stringify(replay.error));
    assert.equal(replay.result.replayed, true);
    assert.equal(replay.result.snapshot.recipes.find(item => item.recipeId === recipeId).description, updateInput.description);
    const originalControl = JSON.parse(await readFile(join(f.oracleRoot, ".pkm/state/project-store.json"), "utf8"));
    const nativeControl = readLegacyProjectControl(f.db, f.workspaceId);
    assert.deepEqual(nativeControl.receipts.map(({ ordinal, ...receipt }) => receipt), originalControl.receipts);
    assert.equal(nativeControl.canonicalDigest, originalControl.canonicalDigest);
    assert.deepEqual(nativeControl.controlBytes, await readFile(join(f.source, ".pkm/state/project-store.json")));
    f.deny();
    assert.equal((await io.http(createdRequest)).error.code, "ACCESS_DENIED");
    f.allow();
    const forbidden = await f.runtime.core.dispatch("capability_call", { operation: "project.recipe.update", version: 1,
      arguments: { operationId: randomUUID(), ...update.args } }, actor);
    assert.ok(forbidden.error);
    let held = false;
    await createWorkspaceBackup(f.storage, f.backup, { acquireQuiescence: async () => {
      held = true; return { assertHeld: () => assert.equal(held, true), release: () => { held = false; } };
    } });
  } finally { await io.close(); }
  await f.close();
  await restoreWorkspaceBackup(f.backup, f.restored, { nativeRestoreAuthority });
  await f.open(f.restored);
  const replay = await f.runtime.core.dispatch("capability_call", invoke(createdRequest), actor);
  assert.equal(replay.error, undefined, JSON.stringify(replay.error));
  assert.equal(replay.result.snapshot.recipes.find(item => item.recipeId === recipeId).description, "Current immutable replay content");
  assert.deepEqual(await hashes(f.source), f.sourceHashes);
});

test("native SQL finalization rollback preserves exact-after intent and restart commits once without replaying effects", async t => {
  const f = await setup(t);
  const revision = readProjectRecipes(f.target, { operation: "project.recipe.list", actorId: actor.id, args: {} }).snapshotRevision;
  const request = f.command("recipe-create", { expectedSnapshotRevision: revision, scope: "global", name: "Rollback Recipe", category: "Rollback" });
  const prepare = DatabaseSync.prototype.prepare;
  let armed = true;
  DatabaseSync.prototype.prepare = function(sql) {
    const statement = prepare.call(this, sql);
    if (!/UPDATE legacy_project_control/i.test(sql)) return statement;
    return new Proxy(statement, { get(target, key) {
      if (key === "run") return (...args) => {
        if (armed) { armed = false; throw new Error("synthetic SQL rollback after filesystem effect"); }
        return target.run(...args);
      };
      const value = Reflect.get(target, key);
      return typeof value === "function" ? value.bind(target) : value;
    } });
  };
  let result;
  try { result = await f.runtime.core.dispatch("capability_call", invoke(request), actor); }
  finally { DatabaseSync.prototype.prepare = prepare; }
  assert.equal(armed, false);
  assert.equal(result.error.effect, "unknown");
  assert.equal(f.db.prepare("SELECT count(*) AS n FROM legacy_command_extension_intent").get().n, 1);
  assert.equal(f.db.prepare("SELECT count(*) AS n FROM receipts WHERE operation_id=?").get(request.operationId).n, 0);
  const version = f.version();
  const before = await hashes(f.target);
  await f.close(); await f.open();
  assert.equal(f.version(), version + 1);
  assert.equal(f.db.prepare("SELECT count(*) AS n FROM legacy_command_extension_intent").get().n, 0);
  assert.equal(f.db.prepare("SELECT count(*) AS n FROM receipts WHERE operation_id=?").get(request.operationId).n, 1);
  const replay = await f.runtime.core.dispatch("capability_call", invoke(request), actor);
  assert.equal(replay.error, undefined, JSON.stringify(replay.error));
  assert.equal(replay.result.replayed, true);
  const after = await hashes(f.target);
  for (const [path, digest] of Object.entries(before)) if (!path.startsWith("core.sqlite")) assert.equal(after[path], digest);
});

test("startup authenticates before/after/mixed Recipe rename journals before generic duplicate validation; unknown preserves bytes", async t => {
  for (const state of ["before", "after", "mixed", "unknown"]) {
    const f = await setup(t);
    const pin = f.pin("recipe", f.recipe.recipeId);
    const request = f.command("recipe-update", { recipeId: f.recipe.recipeId, expectedSnapshotRevision: pin.snapshotRevision,
      expectedRevision: pin.version, expectedSha256: pin.sha256, expectedExecutableDigest: pin.executableDigest,
      name: "Recovery Rename", category: "Recovery", description: "Synthetic recovery", definition: f.recipe.definition });
    const globalFingerprint = hash(JSON.stringify({ operation: "project.legacy.command", actorId: actor.id, args: legacyProjectInvocationSchema.parse(request) }));
    const envelope = { workspaceId: f.workspaceId, actorId: actor.id, operationId: request.operationId, globalFingerprint, command: request.command };
    const effect = compileLegacyExtensionEffectPlan(f.db, f.target, envelope, request.args);
    f.db.exec("BEGIN IMMEDIATE");
    try { stageLegacyExtensionEffect(f.db, envelope, effect); f.db.exec("COMMIT"); } catch (error) { f.db.exec("ROLLBACK"); throw error; }
    if (state !== "before") {
      const files = state === "mixed" ? effect.plan.files.slice(0, 1) : effect.plan.files;
      for (const file of files) {
        const path = join(f.target, file.relativePath);
        if (file.afterBase64 === undefined || file.afterBase64 === null) await rm(path);
        else { await mkdir(dirname(path), { recursive: true }); await writeFile(path, Buffer.from(file.afterBase64, "base64")); }
      }
    }
    if (state === "unknown") await writeFile(join(f.target, effect.plan.files[0].relativePath), "{}");
    else assert.equal(inspectLegacyExtensionPending(f.db, f.target, envelope).state, state);
    const journalBackup = join(f.parent, `pending-${state}.sqlite`);
    await sqliteBackup(f.db, journalBackup);
    const copied = new DatabaseSync(journalBackup, { readOnly: true });
    try {
      assert.equal(copied.prepare("SELECT count(*) AS n FROM pending_project_mutation").get().n, 1);
      assert.equal(copied.prepare("SELECT count(*) AS n FROM legacy_command_extension_intent").get().n, 1);
    } finally { copied.close(); }
    await f.close();
    const before = await hashes(f.target);
    if (state === "unknown") {
      await assert.rejects(f.open());
      const after = await hashes(f.target);
      for (const [path, digest] of Object.entries(before)) if (!path.startsWith("core.sqlite")) assert.equal(after[path], digest);
      const db = new DatabaseSync(join(f.target, "core.sqlite"), { readOnly: true });
      try { assert.equal(db.prepare("SELECT count(*) AS n FROM legacy_command_extension_intent").get().n, 1); } finally { db.close(); }
    } else {
      await f.open();
      assert.equal(f.db.prepare("SELECT count(*) AS n FROM legacy_command_extension_intent").get().n, 0);
      assert.equal(f.db.prepare("SELECT count(*) AS n FROM pending_project_mutation").get().n, 0);
      const replay = await f.runtime.core.dispatch("capability_call", invoke(request), actor);
      assert.equal(replay.error, undefined, JSON.stringify(replay.error));
      assert.equal(replay.result.replayed, true);
      assert.equal(replay.result.snapshot.recipes.find(item => item.recipeId === f.recipe.recipeId).name, "Recovery Rename");
    }
    await f.close();
  }
});
