import assert from "node:assert/strict";
import { test } from "node:test";
import { nativeRestoreAuthority } from "./host-composition-legacy-batch16-restore-fixture.mjs";
import { createHash, randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import { chmod, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Core } from "../dist/core.js";
import { compileWorkflowDefinitionV1 } from "../dist/domain/project-recipes-workflow-contracts.js";
import { compareImportParity } from "../dist/import-parity.js";
import { readLegacyProjectControl, readLegacyRecipeControl } from "../dist/legacy-control-import.js";
import { importLegacyWorkspace, planLegacyImport, recoverLegacyImportOutcome } from "../dist/legacy-import.js";
import { Storage } from "../dist/storage.js";
import { createWorkspaceBackup, restoreWorkspaceBackup } from "../dist/workspace-backup.js";

const root = dirname(fileURLToPath(import.meta.url));
const pythonExecutable = execFileSync("python3", ["-c", "import sys; print(sys.executable)"], { encoding: "utf8" }).trim();
const hash = value => createHash("sha256").update(value).digest("hex");
const id = (parent, kind) => `${kind === "default-project" ? "project_" : "thread_"}${hash(`pkm/${kind}/v1\0${parent}`).slice(0, 32)}`;
const row = (scope, key, value) => ({ scope, key, value });
const canonical = value => Array.isArray(value) ? `[${value.map(canonical).join(",")}]`
  : value && typeof value === "object" ? `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonical(value[key])}`).join(",")}}`
    : JSON.stringify(value);
async function fixture(t) {
  const parent = resolve(root, `.import-parity-project-${randomUUID()}`);
  const source = join(parent, "source");
  await mkdir(source, { recursive: true });
  t.after(() => rm(parent, { recursive: true, force: true }));
  async function file(path, data) {
    const full = join(source, path);
    await mkdir(dirname(full), { recursive: true });
    await writeFile(full, data);
  }
  const rootId = "root_fixture_original";
  const defaultId = id(rootId, "default-project");
  const threadId = id(defaultId, "general-thread");
  const project = { projectId: defaultId, name: "Default Project", systemKind: "default-project", version: 5 };
  const thread = { threadId, projectId: defaultId, name: "General", description: "", archived: false,
    systemKind: "general-thread", legacyAliases: ["legacy-general"], version: 2 };
  const projectPath = `project/Default-Project.${defaultId}/project.json`;
  const threadPath = `project/Default-Project.${defaultId}/threads/${threadId}.json`;
  const skill = "---\nname: Verify\ndescription: \"\"\ntags: []\n---\nRun tests.\n";
  const note = "---\ntitle: Release\ntype: general\ntags: []\n---\nNo publishing.\n";
  const skillProjection = { name: "Verify", description: "", category: "Coding", tags: [], content: "Run tests.\n" };
  const noteProjection = { title: "Release", type: "general", category: "Projects", tags: [], content: "No publishing.\n" };
  const bindings = [
    { bindingId: "verify", kind: "skill", knowledgeId: "Coding/Verify", contentHash: hash(canonical(skillProjection)), usage: "required" },
    { bindingId: "release", kind: "note", knowledgeId: "Projects/Release", contentHash: hash(canonical(noteProjection)), usage: "reference" },
  ];
  const workflow = { schema: "pkm.workflow.definition/v1", spec: { inputs: {},
    nodes: [{ nodeId: "work", kind: "pkm.step.noop/v1", config: {}, dependsOn: [] }],
    outputs: {}, completion: { requiredNodes: ["work"] } } };
  const compiled = compileWorkflowDefinitionV1(workflow);
  assert.equal(compiled.ok, true);
  const recipe = { schema: "pkm.knowledge/v1", knowledgeId: "knowledge_1234567890abcdef12345678",
    aliases: ["recipe:recipe_bound"], recipeId: "recipe_bound", scope: "global", category: "Project/Default Project/Review",
    name: "Bound Recipe", description: "Original", definition: workflow, executableDigest: compiled.executableDigest,
    revision: 7, origin: { kind: "imported", sourceRecipeId: "recipe_source", sourceKey: "fixture-source",
      sourceRevision: 4, sourceScope: "global" }, nodeBindings: [{ nodeId: "work", bindings }] };
  const recipePath = "recipes/Project/Default Project/Review/Bound-Recipe.recipe_bound.json";
  const files = {
    [projectPath]: `${JSON.stringify(project, null, 2)}\n`,
    [threadPath]: `${JSON.stringify(thread, null, 2)}\n`,
    [recipePath]: `${JSON.stringify(recipe, null, 2)}\n`,
    "skills/Coding/Verify.md": skill, "notes/Projects/Release.md": note,
  };
  for (const [path, content] of Object.entries(files)) await file(path, content);
  for (const dir of ["gantt", "collaboration"]) await mkdir(join(source, `project/Default-Project.${defaultId}`, dir));
  return { parent, source, target: join(parent, "target"), file, files, project, thread, recipe, projectPath, recipePath, rootId };
}
async function hashes(source) {
  const all = {};
  async function walk(dir, prefix = "") {
    for (const item of await readdir(dir, { withFileTypes: true })) {
      const rel = prefix ? `${prefix}/${item.name}` : item.name;
      if (item.isDirectory()) await walk(join(dir, item.name), rel);
      else if (item.isFile()) all[rel] = hash(await readFile(join(dir, item.name)));
      else throw new Error("Unexpected synthetic source entry");
    }
  }
  await walk(source);
  return all;
}
const call = (core, operation, args, write = false) => core.dispatch(write ? "capability_call" : "capability_read",
  { operation, version: 1, arguments: args }, { id: "fixture:owner", canWrite: write });
const result = async (...args) => {
  const response = await call(...args);
  assert.equal(response.error, undefined, JSON.stringify(response.error));
  return response.result;
};
const host = { acquireQuiescence: async () => ({ assertHeld() {}, release() {} }) };

test("canonical control-free Project/Recipe export retains original bytes, default identity, bindings and lifecycle", { timeout: 30_000 }, async t => {
  const f = await fixture(t);
  const original = await hashes(f.source);
  const plan = await planLegacyImport(f.source);
  assert.equal(plan.ready, true, JSON.stringify(plan.blockers));
  const receipt = await importLegacyWorkspace(plan, f.target, { pythonExecutable });
  assert.equal((await recoverLegacyImportOutcome(f.target)).status, "published");
  assert.equal(receipt.fingerprint, plan.fingerprint);
  const expected = [], actual = [];
  for (const [path, data] of Object.entries(f.files)) {
    expected.push(row("bytes", path, hash(data)));
    actual.push(row("bytes", path, hash(await readFile(join(f.target, path)))));
  }
  const storage = await Storage.open(f.target);
  try {
    const core = new Core(storage);
    const project = await result(core, "project.get", { id: f.project.projectId });
    const recipe = await result(core, "project.recipe.get", { id: f.recipe.recipeId,
      expectedRevision: f.recipe.revision, expectedExecutableDigest: f.recipe.executableDigest });
    expected.push(row("identity", "default-project", [id(f.rootId, "default-project"), f.thread]));
    actual.push(row("identity", "default-project", [project.item.projectId, project.threads[0]]));
    expected.push(row("source-version", "project-recipe", [5, 7, f.recipe.origin]));
    actual.push(row("source-version", "project-recipe", [project.item.version, recipe.item.revision, recipe.item.origin]));
    expected.push(row("reads", "recipe-binding", f.recipe.nodeBindings));
    actual.push(row("reads", "recipe-binding", recipe.item.nodeBindings));
    const bundle = await result(core, "project.recipe.bundle.get", { projectId: f.project.projectId, exportedAt: "2026-01-01T00:00:00.000Z" });
    expected.push(row("reads", "bundle-content-hashes", f.recipe.nodeBindings[0].bindings.map(binding => binding.contentHash).sort()));
    actual.push(row("reads", "bundle-content-hashes", bundle.item.knowledge.map(item => item.contentHash).sort()));

    await createWorkspaceBackup(storage, join(f.parent, "backup"), host, { pythonExecutable });
    const pin = await result(core, "project.mutation.pin", { entityKind: "project", id: f.project.projectId });
    const update = await result(core, "project.update", {
      operationId: randomUUID(), expectedSnapshotRevision: pin.snapshotRevision, projectId: f.project.projectId,
      expectedVersion: 5, expectedSha256: hash(f.files[f.projectPath]),
      overview: { goal: "Verified" }, reason: "Synthetic review", at: "2026-01-02T00:00:00.000Z",
    }, true);
    expected.push(row("mutations", "project-version", 6));
    actual.push(row("mutations", "project-version", update.item.version));
    const stale = await call(core, "project.update", {
      operationId: randomUUID(), expectedSnapshotRevision: pin.snapshotRevision, projectId: f.project.projectId,
      expectedVersion: 5, expectedSha256: hash(f.files[f.projectPath]),
      overview: { goal: "Stale" }, reason: "Stale", at: "2026-01-02T00:00:00.000Z",
    }, true);
    assert.equal(stale.error?.code, "CONFLICT");
    const recipePin = await result(core, "project.mutation.pin", { entityKind: "recipe", id: f.recipe.recipeId });
    const updatedRecipe = await result(core, "project.recipe.update", {
      operationId: randomUUID(), expectedSnapshotRevision: recipePin.snapshotRevision,
      recipeId: f.recipe.recipeId, expectedRevision: 7, expectedExecutableDigest: f.recipe.executableDigest,
      expectedSha256: hash(f.files[f.recipePath]), name: f.recipe.name, category: f.recipe.category,
      description: "Reviewed", definition: f.recipe.definition,
    }, true);
    expected.push(row("mutations", "recipe-version", [8, f.recipe.knowledgeId, f.recipe.nodeBindings]));
    actual.push(row("mutations", "recipe-version", [updatedRecipe.item.revision, updatedRecipe.item.knowledgeId, updatedRecipe.item.nodeBindings]));
  } finally { await storage.close(); }
  const restored = join(f.parent, "restored");
  await restoreWorkspaceBackup(join(f.parent, "backup"), restored, { pythonExecutable, nativeRestoreAuthority });
  const reopened = await Storage.open(restored);
  try {
    const core = new Core(reopened);
    const restoredProject = await result(core, "project.get", { id: f.project.projectId });
    const restoredRecipe = await result(core, "project.recipe.get", { id: f.recipe.recipeId });
    expected.push(row("backup-restore", "versions", [5, 7, f.recipe.nodeBindings]));
    actual.push(row("backup-restore", "versions", [restoredProject.item.version, restoredRecipe.item.revision, restoredRecipe.item.nodeBindings]));
  } finally { await reopened.close(); }
  expected.push(row("rollback", "source", original));
  actual.push(row("rollback", "source", await hashes(f.source)));
  assert.deepEqual(compareImportParity(expected, actual).filter(item => item.result !== "match"), []);
});

test("Project/Recipe import blocks stale bound content, unknown entries, trash and legacy control journals", async t => {
  const f = await fixture(t);
  await f.file("skills/Coding/Verify.md", "modified");
  let plan = await planLegacyImport(f.source);
  assert.equal(plan.ready, false);
  assert(plan.blockers.some(item => item.code === "unsupported-project-recipe"));
  await f.file("skills/Coding/Verify.md", f.files["skills/Coding/Verify.md"]);
  const valid = await planLegacyImport(f.source);
  assert.equal(valid.ready, true, JSON.stringify(valid.blockers));
  await f.file(f.recipePath, `${f.files[f.recipePath]} `);
  await assert.rejects(importLegacyWorkspace(valid, f.target, { pythonExecutable }), { code: "SOURCE_CHANGED" });
  await f.file("project/unknown.bin", "unknown");
  await f.file("recipes/.trash/old.json", "{}");
  await f.file(".pkm/state/project-store.json", JSON.stringify({ schema: 1, rootId: f.rootId, storeVersion: 8, receipts: [], canonicalDigest: "0".repeat(64) }));
  await f.file(".pkm/state/project-store-intent.json", "{}");
  await f.file(".pkm/state/recipe-store.json", '{"schema":1}');
  const before = await hashes(f.source);
  plan = await planLegacyImport(f.source);
  assert.equal(plan.ready, false);
  assert(plan.blockers.some(item => item.path === ".pkm"));
  await assert.rejects(importLegacyWorkspace(plan, f.target, { pythonExecutable }), { code: "IMPORT_BLOCKED" });
  assert.deepEqual(await hashes(f.source), before);
  await assert.rejects(readdir(f.target), { code: "ENOENT" });
});

test("each unsupported Project/Recipe surface blocks independently, without a target", async t => {
  for (const [path, content] of [
    ["project/unknown.bin", "unknown"],
    ["recipes/.trash/old.json", "{}"],
    ["recipes/Project/Default Project/Review/.unknown", "{}"],
    [".pkm/state/project-store.json", '{"schema":1,"rootId":"root_fixture_original","storeVersion":1,"canonicalDigest":"bad","receipts":[]}'],
    [".pkm/state/recipe-store.json", '{"schema":1,"unknown":true}'],
    [".pkm/state/project-store-intent.json", "{}"],
  ]) {
    const f = await fixture(t);
    await f.file(path, content);
    const before = await hashes(f.source);
    const plan = await planLegacyImport(f.source);
    assert.equal(plan.ready, false, `${path}: ${JSON.stringify(plan.blockers)}`);
    await assert.rejects(importLegacyWorkspace(plan, f.target, { pythonExecutable }), { code: "IMPORT_BLOCKED" });
    assert.deepEqual(await hashes(f.source), before);
    await assert.rejects(readdir(f.target), { code: "ENOENT" });
  }
});

test("mismatched original Thread identity and Recipe filenames cannot be imported", async t => {
  const f = await fixture(t);
  const threadPath = `project/Default-Project.${f.project.projectId}/threads/${f.thread.threadId}.json`;
  await f.file(threadPath, JSON.stringify({ ...f.thread, threadId: "thread_wrong" }));
  let plan = await planLegacyImport(f.source);
  assert.equal(plan.ready, false);
  assert(plan.blockers.some(item => item.code === "unsupported-project-recipe"));
  await f.file(threadPath, f.files[threadPath]);
  await rm(join(f.source, f.recipePath));
  await f.file("recipes/Project/Default Project/Review/Other.recipe_bound.json", f.files[f.recipePath]);
  plan = await planLegacyImport(f.source);
  assert.equal(plan.ready, false);
  assert(plan.blockers.some(item => item.code === "unsupported-project-recipe"));
  await assert.rejects(readdir(f.target), { code: "ENOENT" });
});

test("Project/Recipe publication interruption and target collision preserve the entire source", { timeout: 20_000 }, async t => {
  const f = await fixture(t);
  const before = await hashes(f.source);
  const plan = await planLegacyImport(f.source);
  assert.equal(plan.ready, true, JSON.stringify(plan.blockers));
  const shim = join(f.parent, "fail-publication");
  await writeFile(shim, `#!/usr/bin/env python3
import os, sys
if len(sys.argv) == 3:
    python = ${JSON.stringify(pythonExecutable)}
    os.execv(python, [python, *sys.argv[1:]])
print('renameat2-unavailable', file=sys.stderr)
sys.exit(78)
`);
  await chmod(shim, 0o700);
  await assert.rejects(importLegacyWorkspace(plan, f.target, { pythonExecutable: shim }), { code: "NO_REPLACE_UNAVAILABLE" });
  await assert.rejects(readdir(f.target), { code: "ENOENT" });
  assert.deepEqual(await hashes(f.source), before);
  await mkdir(f.target);
  await writeFile(join(f.target, "keep"), "untouched");
  await assert.rejects(importLegacyWorkspace(plan, f.target, { pythonExecutable }), { code: "DESTINATION_EXISTS" });
  assert.equal(await readFile(join(f.target, "keep"), "utf8"), "untouched");
  assert.deepEqual(await hashes(f.source), before);
});

test("valid original control with command receipts is preserved in dedicated SQLite state", async t => {
  const f = await fixture(t);
  const domain = { rootId: f.rootId, projects: [f.project], threads: [f.thread], ganttTasks: [], collaborationTasks: [] };
  const receipt = { commandId: "legacy-command-1", fingerprint: "legacy-fingerprint",
    operation: "updateProject", storeVersion: 8, entityId: f.project.projectId };
  const control = { schema: 1, rootId: f.rootId, storeVersion: 8, receipts: [receipt],
    canonicalDigest: hash(canonical(domain)) };
  const projectBytes = Buffer.from(`${JSON.stringify(control, null, 2)}\n`);
  const recipeBytes = Buffer.from('{"schema":1}\n');
  await f.file(".pkm/state/project-store.json", projectBytes);
  await f.file(".pkm/state/recipe-store.json", recipeBytes);
  const original = await hashes(f.source);
  const plan = await planLegacyImport(f.source);
  assert.equal(plan.ready, true, JSON.stringify(plan.blockers));
  const imported = await importLegacyWorkspace(plan, f.target, { pythonExecutable });
  assert.deepEqual(imported.controls.map(item => [item.path, item.sha256]), [
    [".pkm/state/project-store.json", hash(projectBytes)],
    [".pkm/state/recipe-store.json", hash(recipeBytes)],
  ]);
  const storage = await Storage.open(f.target);
  try {
    const workspaceId = await storage.workspaceId();
    const database = storage.connectNative();
    try {
      const savedProject = readLegacyProjectControl(database, workspaceId);
      const savedRecipe = readLegacyRecipeControl(database, workspaceId);
      assert.equal(savedProject.rootId, f.rootId);
      assert.equal(savedProject.controlBytes.compare(projectBytes), 0);
      assert.deepEqual(savedProject.receipts.map(({ ordinal: _ordinal, ...item }) => item), [receipt]);
      assert.equal(savedRecipe.controlBytes.compare(recipeBytes), 0);
    } finally { database.close(); }
  } finally { await storage.close(); }
  assert.deepEqual(await hashes(f.source), original);
});
