import assert from "node:assert/strict";
import { readFile, rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { initialize } from "../dist/storage.js";
import {
  applyProjectMutation, deserializeProjectMutationPlan, planProjectMutation,
  projectMutationDefinitions, readProjectMutationPin, recoverProjectMutation, serializeProjectMutationPlan,
} from "../dist/project-mutations.js";
import { readProjectRecipes } from "../dist/project-recipes.js";
import {
  installProjectMutationTransportFixture, projectMutationFixtureExpected, projectMutationFixtureRequests,
} from "./project-mutations-fixtures.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), ".transport-fixture-project-mutations", "workspace");
const parent = dirname(root);
const actorId = "fixture-actor";
const invoke = request => ({ ...request, actorId });
const pin = (kind, id) => readProjectMutationPin(root, invoke({
  operation: "project.mutation.pin", args: { entityKind: kind, id },
}));

test("transport fixture installs against the real workspace ID and supplies replayable pin-based requests", async () => {
  await rm(parent, { recursive: true, force: true });
  try {
    const { mkdir } = await import("node:fs/promises");
    await mkdir(parent);
    await initialize(root);
    const markerBefore = await readFile(join(root, ".pkm-next-workspace"));
    const fixture = await installProjectMutationTransportFixture(root);
    assert.deepEqual(await readFile(join(root, ".pkm-next-workspace")), markerBefore);
    assert.equal(fixture.workspaceId, JSON.parse(markerBefore).id);
    const list = readProjectRecipes(root, invoke({ operation: "project.list", args: {} }));
    const projectCreate = projectMutationFixtureRequests(list.snapshotRevision).createProject;
    const projectPlan = planProjectMutation(root, invoke(projectCreate));
    assert.equal(projectPlan.actorId, actorId);
    assert.equal(projectPlan.workspaceId, fixture.workspaceId);
    assert.equal(recoverProjectMutation(root, projectPlan).state, "missing");
    const created = applyProjectMutation(root, deserializeProjectMutationPlan(serializeProjectMutationPlan(projectPlan)));
    assert.equal(created.state, "complete");
    assert.deepEqual(created.result, projectPlan.result);
    assert.deepEqual(projectMutationDefinitions[0].output.parse(created.result), created.result);
    assert.equal(created.result.item.name, projectMutationFixtureExpected.createdProject.name);
    assert.equal(created.result.item.version, projectMutationFixtureExpected.createdProject.version);
    const p = pin("project", created.result.entityId);
    const projectUpdate = projectMutationFixtureRequests(p.snapshotRevision, p).updateProject;
    const updatePlan = planProjectMutation(root, invoke(projectUpdate));
    const updated = applyProjectMutation(root, updatePlan);
    assert.equal(updated.state, "complete");
    assert.equal(updated.result.item.goal, projectMutationFixtureExpected.updatedProject.goal);
    assert.equal(updated.result.item.version, projectMutationFixtureExpected.updatedProject.version);
    const p2 = pin("project", updated.result.entityId);
    const recipeCreate = projectMutationFixtureRequests(p2.snapshotRevision, p2).createRecipe;
    const recipePlan = planProjectMutation(root, invoke(recipeCreate));
    const createdRecipe = applyProjectMutation(root, recipePlan);
    assert.equal(createdRecipe.state, "complete");
    assert.equal(createdRecipe.result.item.category, projectMutationFixtureExpected.createdRecipe.category);
    const r = pin("recipe", createdRecipe.result.entityId);
    assert.equal(r.executableDigest, createdRecipe.result.item.executableDigest);
    const recipeUpdate = projectMutationFixtureRequests(r.snapshotRevision, undefined, r).updateRecipe;
    const recipeUpdatePlan = planProjectMutation(root, invoke(recipeUpdate));
    const updatedRecipe = applyProjectMutation(root, recipeUpdatePlan);
    assert.equal(updatedRecipe.state, "complete");
    assert.equal(updatedRecipe.result.item.description, projectMutationFixtureExpected.updatedRecipe.description);
    assert.equal(updatedRecipe.result.item.revision, projectMutationFixtureExpected.updatedRecipe.revision);
    const finalPin = pin("recipe", updatedRecipe.result.entityId);
    assert.equal(finalPin.version, 2);
    assert.equal(finalPin.sha256, recipeUpdatePlan.files[0].afterSha256);
  } finally {
    await rm(parent, { recursive: true, force: true });
  }
});
