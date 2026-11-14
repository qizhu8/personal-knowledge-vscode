import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { spawnSync } from "node:child_process";
import { pathToFileURL } from "node:url";
const dist = path.resolve(process.env.PKM_TEST_RECIPE_DIST || "next-server/dist");
const { NativeRecipeLibrary } = await import(pathToFileURL(path.join(dist, "native-recipe-library.js")));
const { compileWorkflowDefinitionV1 } = await import(pathToFileURL(path.join(dist, "domain/project-recipes-workflow-contracts.js")));
const definition = { schema: "pkm.workflow.definition/v1", spec: { inputs: {}, outputs: {},
  nodes: [{ nodeId: "first", kind: "pkm.step.native/v1", config: { operation: "fixture", arguments: {} }, dependsOn: [] }],
  completion: { requiredNodes: ["first"] } } };
const original = { snapshotRevision: "a".repeat(64), recipes: [{ recipeId: `recipe_${randomUUID()}`,
  knowledgeId: `knowledge_${"b".repeat(24)}`, aliases: ["recipe:original"], scope: "global", revision: 2,
  name: "Original", description: "Preserved original", definition,
  executableDigest: compileWorkflowDefinitionV1(definition).executableDigest }] };
function setup(t) {
  const root = path.resolve(`.migration-test-work/native-recipe-library-${randomUUID()}`);
  fs.mkdirSync(root, { mode: 0o700 });
  const file = path.join(root, "core.sqlite"), opened = [];
  let owned = true;
  const open = () => {
    const database = new DatabaseSync(file);
    database.exec("PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL;");
    const library = new NativeRecipeLibrary({ database, workspaceId: "workspace",
      assertLease() { if (!owned) throw Error("Fenced workspace lease"); }, original: () => structuredClone(original) });
    opened.push(library); return library;
  };
  t.after(() => { for (const library of opened) library.close(); fs.rmSync(root, { recursive: true, force: true }); });
  return { root, file, open, fence() { owned = false; } };
}
function input(library, record, fields = library.editable(record)) {
  return { actorId: "actor", operationId: randomUUID(), recipeId: record.recipeId,
    expectedRevision: record.revision, expectedSnapshot: library.snapshot().snapshotRevision, fields };
}
test("native definitions persist identity, compiled digest, layout/references and atomic receipts; originals remain unchanged", t => {
  const env = setup(t), library = env.open(), before = structuredClone(original);
  const draft = library.draft(original.recipes[0].recipeId);
  assert.equal(library.snapshot().recipes.length, 1);
  const request = input(library, draft);
  request.fields.name = "Native authored";
  request.fields.editorLayout = { nodePositions: { first: { x: 7, y: 9 } }, boundaryPositions: { input: { x: 0, y: 0 } } };
  request.fields.nodeBindings = [{ nodeId: "first", bindings: [{ bindingId: "reference", kind: "note",
    knowledgeId: "knowledge_pinned_original", contentHash: "f".repeat(64), usage: "reference" }] }];
  const saved = library.save(request);
  assert.equal(saved.revision, 1); assert.deepEqual(library.save(request), saved);
  assert.notEqual(saved.knowledgeId, original.recipes[0].knowledgeId);
  const update = input(library, saved); update.fields.description = "Real revision two";
  const revised = library.save(update);
  assert.equal(revised.revision, 2); assert.equal(revised.knowledgeId, saved.knowledgeId);
  assert.deepEqual(revised.aliases, saved.aliases); assert.deepEqual(revised.nodeBindings, saved.nodeBindings);
  library.close();
  assert.deepEqual(env.open().snapshot().recipes.find(row => row.recipeId === saved.recipeId), revised);
  assert.deepEqual(original, before);
});
test("invalid graph, malformed references, stale CAS, operation reuse and fenced lease never mutate library", t => {
  const env = setup(t), library = env.open(), draft = library.draft(original.recipes[0].recipeId);
  const request = input(library, draft), invalid = structuredClone(request);
  invalid.fields.definition.spec.nodes[0].dependsOn = [{ from: "missing", accept: ["succeeded"], required: true }];
  assert.throws(() => library.save(invalid), /invalid/i);
  const badRef = structuredClone(request); badRef.fields.nodeBindings = [{ nodeId: "missing", bindings: [] }];
  assert.throws(() => library.save(badRef), /reference/);
  const saved = library.save(request);
  assert.throws(() => library.save({ ...request, operationId: randomUUID() }), /conflict/);
  assert.throws(() => library.save({ ...request, fields: { ...request.fields, name: "Different" } }), /reused/);
  assert.equal(library.snapshot().recipes.find(row => row.recipeId === draft.recipeId).revision, 1);
  const update = input(library, saved); env.fence();
  assert.throws(() => library.save(update), /Fenced/);
});
for (const point of ["before-commit", "after-commit"]) test(`real SIGKILL ${point}: native definition and receipt recover atomically`, t => {
  const env = setup(t), library = env.open(), request = input(library, library.draft(original.recipes[0].recipeId));
  library.close();
  const descriptor = path.join(env.root, "crash.json");
  fs.writeFileSync(descriptor, JSON.stringify({ file: env.file, original, request, point, dist }), { mode: 0o600 });
  const child = spawnSync(process.execPath, ["--input-type=module", "-e", `
    import fs from 'node:fs'; import path from 'node:path'; import {DatabaseSync} from 'node:sqlite'; import {pathToFileURL} from 'node:url';
    const c=JSON.parse(fs.readFileSync(process.argv[1]));
    const {NativeRecipeLibrary}=await import(pathToFileURL(path.join(c.dist,'native-recipe-library.js')));
    const database=new DatabaseSync(c.file); database.exec('PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL;');
    const library=new NativeRecipeLibrary({database,workspaceId:'workspace',assertLease(){},original:()=>c.original,
      fault(point){if(point===c.point)process.kill(process.pid,'SIGKILL');}});
    library.save(c.request); throw Error('Crash hook was not reached');
  `, descriptor], { encoding: "utf8", env: { ...process.env, TMPDIR: env.root }, timeout: 15000 });
  assert.equal(child.signal, "SIGKILL", child.stderr);
  const reopened = env.open(), record = reopened.snapshot().recipes.find(row => row.recipeId === request.recipeId);
  assert.equal(!!record, point === "after-commit");
  if (record) { assert.equal(record.revision, 1); assert.deepEqual(reopened.save(request), record); }
  else assert.equal(reopened.save(request).revision, 1);
});
