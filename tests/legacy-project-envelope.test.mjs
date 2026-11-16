import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { cp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { nativeRestoreAuthority } from "./host-composition-legacy-batch16-restore-fixture.mjs";
import { originalProjectModules, projectOriginalSource } from "./legacy-project-original-captures.mjs";
import {
  applyProjectMutation, planProjectMutation, readProjectMutationPin,
} from "../dist/project-mutations.js";
import { readProjectRecipes } from "../dist/project-recipes.js";
import { importLegacyWorkspace, planLegacyImport } from "../dist/legacy-import.js";
import {
  legacyProjectDomainDigest, readCurrentLegacyProjectSnapshot,
} from "../dist/legacy-control-import.js";
import {
  initializeLegacyProjectEnvelopeSchema,
  planLegacyProjectEnvelope, prepareLegacyProjectEnvelopeAdoption,
  readLegacyProjectEnvelopeAdoption, recordLegacyProjectEnvelopeAdoption,
  stageLegacyProjectEnvelope, verifyLegacyProjectEnvelopeStage,
} from "../dist/legacy-project-envelope.js";
import { legacyProjectEnvelopeOriginalSources } from "../dist/domain/legacy-project-envelope-provenance.js";
import { Storage } from "../dist/storage.js";
import { createWorkspaceBackup, restoreWorkspaceBackup } from "../dist/workspace-backup.js";
import { pythonExecutable } from "./batch09-original-control-fixtures.mjs";

const testsRoot = dirname(fileURLToPath(import.meta.url));
const hash = value => createHash("sha256").update(value).digest("hex");
const request = (operation, args) => ({ operation, args, actorId: "legacy-project-envelope-test" });
const transaction = (database, action) => {
  database.exec("BEGIN IMMEDIATE");
  try { const result = action(); database.exec("COMMIT"); return result; }
  catch (error) { database.exec("ROLLBACK"); throw error; }
};

const original = originalProjectModules();
const { ProjectStore } = original("src/workflows/project-store.ts");
const { canonicalJson: originalCanonicalJson } = original("src/workflows/workflow-contracts.ts");
async function newFixture(t) {
  const parent = join(testsRoot, `.legacy-project-envelope-${randomUUID()}`);
  const source = join(parent, "source");
  await mkdir(join(source, ".pkm", "state"), { recursive: true });
  t.after(() => rm(parent, { recursive: true, force: true }));
  const store = new ProjectStore(join(source, ".pkm", "state"), randomUUID, { autoMigrate: false });
  const initial = store.list();
  const envelopePath = join(source, ".pkm", "state", "projects.json");
  const createCommand = {
    commandId: "original-project-create-command",
    fingerprint: "opaque-original-command-fingerprint",
    expectedStoreVersion: initial.storeVersion,
  };
  const created = store.createProject(createCommand, "Raw Envelope Project");
  const updateCommand = {
    commandId: "original-project-update-command",
    fingerprint: "opaque-update-fingerprint",
    expectedStoreVersion: created.snapshot.storeVersion,
  };
  store.updateProject(updateCommand, created.entityId, { goal: "Keep original history" }, "Original store oracle");
  const recipeCommand = {
    commandId: "original-recipe-create-command",
    fingerprint: "opaque-recipe-create-fingerprint",
    expectedStoreVersion: updateCommand.expectedStoreVersion + 1,
  };
  const recipe = store.createRecipe(recipeCommand, { kind: "project", projectId: created.entityId }, "Raw Recipe", "Guides");
  const recipeRecord = recipe.snapshot.recipes.find(item => item.recipeId === recipe.entityId);
  store.updateRecipe({
    commandId: "original-recipe-update-command",
    fingerprint: "opaque-recipe-update-fingerprint",
    expectedStoreVersion: recipe.snapshot.storeVersion,
  }, recipe.entityId, {
    name: recipeRecord.name,
    category: recipeRecord.category,
    description: "Original Recipe update history",
    definition: recipeRecord.definition,
  });
  const snapshot = store.list();
  const writerBytes = await readFile(envelopePath);
  const beforeReplay = writerBytes;
  const replay = store.createProject(createCommand, "Raw Envelope Project");
  assert.equal(replay.replayed, true);
  assert.deepEqual(await readFile(envelopePath), beforeReplay);
  const withOpaqueMetadata = JSON.parse(beforeReplay.toString("utf8"));
  withOpaqueMetadata.compatibilityEnvelopeMetadata = {
    format: "original-project-store",
    unknownField: { keep: ["byte-exact", 13, { opaque: true }] },
  };
  await writeFile(envelopePath, originalCanonicalJson(withOpaqueMetadata), "utf8");
  const sourceBytes = await readFile(envelopePath);
  const restartedStore = new ProjectStore(join(source, ".pkm", "state"), randomUUID, { autoMigrate: false });
  assert.deepEqual(restartedStore.list(), snapshot);
  assert.deepEqual(await readFile(envelopePath), sourceBytes);
  return {
    parent, source, envelopePath, sourceBytes, store, snapshot, createdProjectId: created.entityId,
    recipeId: recipe.entityId, storeVersion: snapshot.storeVersion,
  };
}

function normalizedDomain(snapshot) {
  const sort = (items, key) => [...items].sort((a, b) => a[key].localeCompare(b[key]));
  return {
    rootId: snapshot.rootId,
    projects: sort(snapshot.projects, "projectId"),
    threads: sort(snapshot.threads, "threadId"),
    ganttTasks: sort(snapshot.ganttTasks, "taskId"),
    collaborationTasks: sort(snapshot.collaborationTasks, "collaborationId"),
  };
}

test("live original ProjectStore writer produces a byte-pinned, complete staged envelope projection", async t => {
  const fixture = await newFixture(t);
  const sourceBytes = await readFile(fixture.envelopePath);
  const raw = JSON.parse(sourceBytes.toString("utf8"));
  assert.equal(raw.schema, 1);
  assert.equal(raw.compatibilityEnvelopeMetadata.unknownField.keep[0], "byte-exact");
  assert.ok(raw.payload.state.projects.some(project => project.projectId === fixture.createdProjectId));
  assert.ok(raw.payload.state.recipes.some(recipe => recipe.recipeId === fixture.recipeId));
  assert.equal(raw.payload.receipts.length, 4);

  for (const source of legacyProjectEnvelopeOriginalSources) {
    assert.equal(hash(projectOriginalSource(source.path, source.sha256)), source.sha256, source.path);
  }
  const plan = await planLegacyProjectEnvelope(fixture.source);
  assert.equal(plan.sourceSha256, hash(sourceBytes));
  assert.equal(plan.storeVersion, fixture.snapshot.storeVersion);
  assert.equal(plan.rootId, fixture.snapshot.rootId);
  assert.deepEqual(plan.orderedReceipts, raw.payload.receipts);
  assert.deepEqual(plan.counts, {
    projects: fixture.snapshot.projects.length,
    threads: fixture.snapshot.threads.length,
    ganttTasks: fixture.snapshot.ganttTasks.length,
    collaborationTasks: fixture.snapshot.collaborationTasks.length,
    recipes: fixture.snapshot.recipes.length,
  });

  const receipt = await stageLegacyProjectEnvelope(plan, join(fixture.parent, "stage"));
  assert.equal(receipt.sourceSha256, hash(sourceBytes));
  assert.equal(receipt.storeVersion, fixture.snapshot.storeVersion);
  await verifyLegacyProjectEnvelopeStage(plan, join(fixture.parent, "stage"), receipt);
  assert.deepEqual(await readFile(join(fixture.parent, "stage", "original-projects.json")), sourceBytes);
  assert.deepEqual(await readFile(fixture.envelopePath), sourceBytes);
});

test("unknown versions, digest ambiguity, missing system identities, duplicate receipts, and live migration markers fail closed", async t => {
  const fixture = await newFixture(t);
  const original = JSON.parse(fixture.sourceBytes.toString("utf8"));
  const cases = [
    ["unknown-version", envelope => { envelope.schema = 2; }, "UNSUPPORTED_FORMAT"],
    ["bad-digest", envelope => { envelope.digest = "0".repeat(64); }, "INVALID_DIGEST"],
    ["missing-default", envelope => {
      envelope.payload.state.projects = envelope.payload.state.projects.filter(item => item.systemKind !== "default-project");
      envelope.payload.state.threads = envelope.payload.state.threads.filter(item => item.systemKind !== "general-thread");
      envelope.digest = hash(originalCanonicalJson(envelope.payload));
    }, "MISSING_DEFAULT_GENERAL"],
    ["duplicate-receipt", envelope => {
      envelope.payload.receipts.push(structuredClone(envelope.payload.receipts[0]));
      envelope.digest = hash(originalCanonicalJson(envelope.payload));
    }, "INVALID_RECEIPTS"],
  ];
  for (const [name, change, code] of cases) {
    const source = join(fixture.parent, name);
    await cp(fixture.source, source, { recursive: true });
    const path = join(source, ".pkm", "state", "projects.json");
    const value = structuredClone(original);
    change(value);
    await writeFile(path, originalCanonicalJson(value), "utf8");
    await assert.rejects(planLegacyProjectEnvelope(source), { code });
  }
  const pending = join(fixture.parent, "pending");
  await cp(fixture.source, pending, { recursive: true });
  await writeFile(join(pending, ".pkm", "state", "project-store-intent.json"), "{}");
  await assert.rejects(planLegacyProjectEnvelope(pending), { code: "PENDING_INTENT" });
  const marked = join(fixture.parent, "marked");
  await cp(fixture.source, marked, { recursive: true });
  await mkdir(join(marked, ".pkm", "state", "project-store-migration"));
  await assert.rejects(planLegacyProjectEnvelope(marked), { code: "MIGRATION_MARKER" });
  assert.deepEqual(await readFile(fixture.envelopePath), fixture.sourceBytes);
});

test("stage identity, no-overwrite, exact-byte verification, and source freshness fence projection adoption", async t => {
  const fixture = await newFixture(t);
  const plan = await planLegacyProjectEnvelope(fixture.source);
  const stagePath = join(fixture.parent, "stage");
  const receipt = await stageLegacyProjectEnvelope(plan, stagePath);
  await assert.rejects(stageLegacyProjectEnvelope(plan, stagePath), { code: "STAGE_EXISTS" });
  await assert.rejects(verifyLegacyProjectEnvelopeStage(plan, stagePath, {
    ...receipt, stageId: randomUUID(),
  }), { code: "STAGE_IDENTITY_MISMATCH" });
  await writeFile(join(stagePath, "original-projects.json"), "changed");
  await assert.rejects(verifyLegacyProjectEnvelopeStage(plan, stagePath), { code: "STAGE_INVALID" });

  const freshPlan = await planLegacyProjectEnvelope(fixture.source);
  await writeFile(fixture.envelopePath, Buffer.concat([fixture.sourceBytes, Buffer.from(" ")]));
  await assert.rejects(stageLegacyProjectEnvelope(freshPlan, join(fixture.parent, "must-not-publish")));
  await assert.rejects(readdir(join(fixture.parent, "must-not-publish")), { code: "ENOENT" });
});

test("native import reads and mutates projected Projects/Recipes while backup/restart retains exact opaque envelope", { timeout: 90_000 }, async t => {
  const fixture = await newFixture(t);
  const plan = await planLegacyProjectEnvelope(fixture.source);
  const stageRoot = join(fixture.parent, "stage");
  const stageReceipt = await stageLegacyProjectEnvelope(plan, stageRoot);
  const projectionRoot = join(stageRoot, "projection");
  const importPlan = await planLegacyImport(projectionRoot);
  assert.equal(importPlan.ready, true, JSON.stringify(importPlan.blockers));
  const target = join(fixture.parent, "native");
  const importReceipt = await importLegacyWorkspace(importPlan, target, { pythonExecutable });
  assert.equal(importReceipt.controls.some(item => item.path === ".pkm/state/project-store.json"), true);

  const storage = await Storage.open(target);
  const workspaceId = await storage.workspaceId();
  const requestProject = request("project.list", { offset: 0, limit: 100 });
  const current = readProjectRecipes(target, requestProject);
  const nativeDb = storage.connectNative();
  try {
    const snapshot = readCurrentLegacyProjectSnapshot(nativeDb, workspaceId);
    assert.deepEqual(normalizedDomain(snapshot), normalizedDomain(fixture.snapshot));
    assert.equal(snapshot.storeVersion, fixture.snapshot.storeVersion);
    const recipePage = readProjectRecipes(target, request("project.recipe.list", { offset: 0, limit: 100 }));
    assert.ok(recipePage.items.some(recipe => recipe.recipeId === fixture.recipeId));
    for (const file of plan.projectionFiles.filter(item => item.kind === "recipe")) {
      const projectedRecipe = JSON.parse(Buffer.from(file.base64, "base64").toString("utf8"));
      const nativeRecipe = readProjectRecipes(target, request("project.recipe.get", { id: projectedRecipe.recipeId })).item;
      assert.deepEqual(nativeRecipe, projectedRecipe);
    }

    const stagedPayload = await prepareLegacyProjectEnvelopeAdoption(plan, stageRoot, stageReceipt, workspaceId);
    transaction(nativeDb, () => {
      initializeLegacyProjectEnvelopeSchema(nativeDb);
      recordLegacyProjectEnvelopeAdoption(nativeDb, stagedPayload);
    });
    const adoption = readLegacyProjectEnvelopeAdoption(nativeDb, workspaceId);
    assert.deepEqual(adoption?.sourceBytes, fixture.sourceBytes);
    assert.equal(adoption.receipt.sourceSha256, hash(fixture.sourceBytes));
  } finally { nativeDb.close(); }

  const backupPath = join(fixture.parent, "backup");
  await createWorkspaceBackup(storage, backupPath, {
    acquireQuiescence: async () => ({ assertHeld() {}, release() {} }),
  }, { pythonExecutable });
  await storage.close();
  const restored = join(fixture.parent, "restored");
  await restoreWorkspaceBackup(backupPath, restored, { pythonExecutable, nativeRestoreAuthority });
  const restarted = await Storage.open(restored);
  try {
    const restoredDb = restarted.connectNative();
    try {
      const restoredEnvelope = readLegacyProjectEnvelopeAdoption(restoredDb, workspaceId);
      assert.deepEqual(restoredEnvelope?.sourceBytes, fixture.sourceBytes);
      assert.equal(restoredEnvelope.receipt.sourceSha256, hash(fixture.sourceBytes));
    } finally { restoredDb.close(); }

    const projectPin = readProjectMutationPin(restored, request("project.mutation.pin", {
      entityKind: "project", id: fixture.createdProjectId,
    }));
    const projectPlan = planProjectMutation(restored, request("project.update", {
      operationId: randomUUID(), expectedSnapshotRevision: projectPin.snapshotRevision,
      projectId: fixture.createdProjectId, expectedVersion: projectPin.version,
      expectedSha256: projectPin.sha256, overview: { goal: "Native projected update" },
      reason: "Native mutation after restored import", at: "2026-11-07T00:00:00.000Z",
    }));
    assert.equal(applyProjectMutation(restored, projectPlan).state, "complete");
    const updatedProject = readProjectRecipes(restored, request("project.get", { id: fixture.createdProjectId }));
    assert.equal(updatedProject.item.goal, "Native projected update");

    const recipePin = readProjectMutationPin(restored, request("project.mutation.pin", {
      entityKind: "recipe", id: fixture.recipeId,
    }));
    const recipe = readProjectRecipes(restored, request("project.recipe.get", { id: fixture.recipeId })).item;
    const recipePlan = planProjectMutation(restored, request("project.recipe.update", {
      operationId: randomUUID(), expectedSnapshotRevision: recipePin.snapshotRevision,
      recipeId: fixture.recipeId, expectedRevision: recipePin.version,
      expectedExecutableDigest: recipePin.executableDigest, expectedSha256: recipePin.sha256,
      name: recipe.name, category: recipe.category, description: "Native projected Recipe update",
      definition: recipe.definition,
    }));
    assert.equal(applyProjectMutation(restored, recipePlan).state, "complete");
    const updatedRecipes = readProjectRecipes(restored, request("project.recipe.list", { offset: 0, limit: 100 }));
    assert.equal(updatedRecipes.items.find(item => item.recipeId === fixture.recipeId).description, "Native projected Recipe update");
    assert.equal(current.items.some(project => project.projectId === fixture.createdProjectId), true);
  } finally { await restarted.close(); }

  assert.deepEqual(await readFile(fixture.envelopePath), fixture.sourceBytes);
  const oracleAfterRestart = new ProjectStore(join(fixture.source, ".pkm", "state"), randomUUID, { autoMigrate: false });
  assert.deepEqual(oracleAfterRestart.list(), fixture.snapshot);
  assert.deepEqual(await readFile(fixture.envelopePath), fixture.sourceBytes);
});
