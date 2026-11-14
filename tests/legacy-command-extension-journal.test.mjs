import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { DatabaseSync } from "node:sqlite";
import { join } from "node:path";
import { fixture, pythonExecutable } from "./batch09-original-control-fixtures.mjs";
import { importLegacyWorkspace, planLegacyImport } from "../dist/legacy-import.js";
import { readCurrentLegacyProjectSnapshot, readLegacyProjectControl, legacyProjectDomainDigest,
  inspectLegacyControlRecovery } from "../dist/legacy-control-import.js";
import { checkLegacyExtensionCommand, stageLegacyExtensionIntent,
  finalizeLegacyExtensionIntent } from "../dist/legacy-command-extension-journal.js";
import { applyProjectMutation, planProjectMutation, readProjectMutationPin } from "../dist/project-mutations.js";
import { readProjectRecipes } from "../dist/project-recipes.js";
import { scanMarkdown } from "../dist/markdown.js";

const actorId = "legacy-extension-test";
function transaction(db, callback) {
  db.exec("BEGIN IMMEDIATE");
  try { const result = callback(); db.exec("COMMIT"); return result; }
  catch (error) { db.exec("ROLLBACK"); throw error; }
}
const request = (operation, args) => ({ operation, args, actorId });

test("candidate Recipe plans use native effects and atomically journal opaque original commands", async t => {
  const f = await fixture(t);
  await importLegacyWorkspace(await planLegacyImport(f.source), f.target, { pythonExecutable });
  const db = new DatabaseSync(join(f.target, "core.sqlite"));
  t.after(() => db.close());
  const workspaceId = JSON.parse(await readFile(join(f.target, ".pkm-next-workspace"), "utf8")).id;
  const snapshot = () => readCurrentLegacyProjectSnapshot(db, workspaceId);
  const revision = () => readProjectRecipes(f.target, request("project.list", { offset: 0, limit: 100 })).snapshotRevision;
  function envelope(command, operationId) {
    return { workspaceId, operationId, actorId, globalFingerprint: "a".repeat(64), command };
  }
  const createId = randomUUID();
  const create = { commandId: "create", fingerprint: "opaque-fingerprint", operation: "recipe-create", expectedStoreVersion: 8 };
  const createPlan = planProjectMutation(f.target, request("project.recipe.create", {
    operationId: createId, expectedSnapshotRevision: revision(), scope: "global", name: "Synthetic Recipe", category: "Examples",
  }), scanMarkdown(f.target));
  const before = snapshot(), beforeDigest = legacyProjectDomainDigest(before);
  assert.throws(() => stageLegacyExtensionIntent(db, envelope(create, createId), createPlan, beforeDigest),
    error => error.code === "TRANSACTION_REQUIRED");
  transaction(db, () => stageLegacyExtensionIntent(db, envelope(create, createId), createPlan, beforeDigest));
  assert.throws(() => inspectLegacyControlRecovery(db, workspaceId),
    error => error.code === "CONTROL_RECOVERY_CONFLICT", "existing startup gate does not recognize this intent");
  assert.equal(applyProjectMutation(f.target, createPlan, scanMarkdown(f.target)).state, "complete");
  const after = snapshot();
  assert.equal(legacyProjectDomainDigest(after), beforeDigest, "Recipe effects do not alter the Project-domain digest");
  assert.throws(() => transaction(db, () => {
    finalizeLegacyExtensionIntent(db, envelope(create, createId), after, "2026-11-07T00:00:00.000Z");
    throw new Error("simulate rollback");
  }), /simulate rollback/);
  assert.equal(readLegacyProjectControl(db, workspaceId).storeVersion, 8);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM pending_project_mutation").get().n, 1);
  transaction(db, () => finalizeLegacyExtensionIntent(db, envelope(create, createId), after, "2026-11-07T00:00:00.000Z"));
  assert.equal(readLegacyProjectControl(db, workspaceId).storeVersion, 9);
  assert.equal(checkLegacyExtensionCommand(db, workspaceId, { ...create, operation: "unknown", expectedStoreVersion: 1 }).status, "replay");
  assert.throws(() => checkLegacyExtensionCommand(db, workspaceId, { ...create, fingerprint: "different" }),
    error => error.code === "COMMAND_CONFLICT");
  assert.throws(() => checkLegacyExtensionCommand(db, workspaceId, { ...create, commandId: "stale" }),
    error => error.code === "STORE_VERSION_CONFLICT");
  const pin = readProjectMutationPin(f.target, request("project.mutation.pin", { entityKind: "recipe", id: createPlan.result.entityId }));
  const updateId = randomUUID(), update = { commandId: "update", fingerprint: "another opaque pin",
    operation: "recipe-update", expectedStoreVersion: 9 };
  const item = createPlan.result.item;
  const updatePlan = planProjectMutation(f.target, request("project.recipe.update", {
    operationId: updateId, expectedSnapshotRevision: pin.snapshotRevision, recipeId: item.recipeId,
    expectedRevision: pin.version, expectedExecutableDigest: pin.executableDigest, expectedSha256: pin.sha256,
    name: item.name, category: item.category, description: "Updated", definition: item.definition,
  }), scanMarkdown(f.target));
  const beforeUpdate = snapshot();
  transaction(db, () => stageLegacyExtensionIntent(db, envelope(update, updateId), updatePlan, legacyProjectDomainDigest(beforeUpdate)));
  assert.equal(applyProjectMutation(f.target, updatePlan, scanMarkdown(f.target)).state, "complete");
  const afterUpdate = snapshot();
  transaction(db, () => finalizeLegacyExtensionIntent(db, envelope(update, updateId), afterUpdate, "2026-11-07T00:01:00.000Z"));
  assert.equal(readLegacyProjectControl(db, workspaceId).storeVersion, 10);
  assert.equal(readProjectRecipes(f.target, request("project.recipe.get", { id: item.recipeId })).item.description, "Updated");
  assert.deepEqual(readLegacyProjectControl(db, workspaceId).receipts.slice(-2).map(row => row.operation), ["recipe-create", "recipe-update"]);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM pending_project_mutation").get().n, 0);
  inspectLegacyControlRecovery(db, workspaceId);

  transaction(db, () => {
    db.prepare("UPDATE legacy_project_control SET store_version=300 WHERE workspace_id=?").run(workspaceId);
    db.prepare("DELETE FROM legacy_project_receipt WHERE workspace_id=?").run(workspaceId);
    const insert = db.prepare(`INSERT INTO legacy_project_receipt
      (workspace_id,ordinal,command_id,fingerprint,operation,store_version,entity_id) VALUES(?,?,?,?,?,?,?)`);
    for (let i = 0; i < 256; i++) insert.run(workspaceId, i, `historical-${i}`, "opaque", "historical", i + 1, f.projectId);
  });
  const thirdId = randomUUID(), third = { commandId: "rolling", fingerprint: "opaque", operation: "recipe-create", expectedStoreVersion: 300 };
  const thirdPlan = planProjectMutation(f.target, request("project.recipe.create", {
    operationId: thirdId, expectedSnapshotRevision: revision(), scope: "global", name: "Rolling", category: "Examples",
  }), scanMarkdown(f.target));
  transaction(db, () => stageLegacyExtensionIntent(db, envelope(third, thirdId), thirdPlan, legacyProjectDomainDigest(afterUpdate)));
  assert.equal(applyProjectMutation(f.target, thirdPlan, scanMarkdown(f.target)).state, "complete");
  const thirdSnapshot = snapshot();
  transaction(db, () => finalizeLegacyExtensionIntent(db, envelope(third, thirdId), thirdSnapshot, "2026-11-07T00:02:00.000Z"));
  const rolling = readLegacyProjectControl(db, workspaceId);
  assert.equal(rolling.receipts.length, 256);
  assert.equal(rolling.receipts[0].commandId, "historical-1");
  assert.equal(rolling.receipts.at(-1).commandId, "rolling");
  assert.equal(rolling.storeVersion, 301);
});
