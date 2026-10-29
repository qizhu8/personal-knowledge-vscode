const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { createHash } = require("node:crypto");
const { canonicalJson, compileWorkflowDefinitionV1 } = require("../dist/workflows/workflow-contracts");
const { ProjectStore } = require("../dist/workflows/project-store");
const { initializeProjectModel, importRecipe } = require("../dist/workflows/project-model");
const { validateGitHubSyncCandidate } = require("../dist/sync/github-sync");

const root = fs.mkdtempSync(path.join(os.tmpdir(), "pkm-recompile-"));
const directory = path.join(root, ".pkm/state");
fs.mkdirSync(directory, { recursive: true });
const hash = value => createHash("sha256").update(canonicalJson(value)).digest("hex");
const definition = { schema: "pkm.workflow.definition/v1", spec: {
  inputs: {}, nodes: [
    { nodeId: "z_source", kind: "pkm.step.noop/v1", config: {}, dependsOn: [] },
    { nodeId: "a_finish", kind: "pkm.step.noop/v1", config: {}, dependsOn: [{ from: "z_source" }] },
  ], outputs: {}, completion: { requiredNodes: ["a_finish"] },
} };
const recipe = { recipeId: "recipe_legacy", scope: "global", name: "Legacy", description: "test", category: "Examples",
  revision: 1, definition, executableDigest: hash(definition), nodeBindings: [{ nodeId: "z_source", bindings: [
    { bindingId: "source-skill", kind: "skill", knowledgeId: "knowledge_source", contentHash: "a".repeat(64), usage: "required" },
  ] }] };
const store = new ProjectStore(directory, () => "root", { autoMigrate: false });
function seed(recipes = [recipe]) {
  const payload = { state: { ...initializeProjectModel(undefined, () => "root"), recipes }, receipts: [] };
  fs.writeFileSync(path.join(directory, "projects.json"), JSON.stringify({ schema: 1, storeVersion: 1, payload, digest: hash(payload) }));
}
const command = preview => ({ commandId: "approve", fingerprint: "approval", expectedStoreVersion: preview.storeVersion });
try {
  seed();
  const before = fs.readFileSync(path.join(directory, "projects.json"));
  const preview = store.previewRecipeRecompile(recipe.recipeId);
  assert(fs.readFileSync(path.join(directory, "projects.json")).equals(before), "preview must not persist changes");
  assert.equal(preview.compiled.revision, 2);
  assert.equal(preview.compiled.executableDigest, compileWorkflowDefinitionV1(definition).executableDigest);
  assert.equal(preview.compiled.nodeBindings[0].nodeId, "z_source");
  assert.equal(store.recipeSyncEntries()[0].recipe.executableDigest, recipe.executableDigest, "export must not repair hashes");
  assert.equal(store.recipeSyncEntries()[0].sourceLocator.path, path.join(directory, "projects.json"));
  assert.equal(store.recipeSyncEntries()[0].sourceLocator.jsonPointer, "/payload/state/recipes");
  const run = { recipeId: recipe.recipeId, recipeRevision: 1, executableDigest: recipe.executableDigest, definition };
  fs.mkdirSync(path.join(directory, "recipe-runs"));
  const runPath = path.join(directory, "recipe-runs/frozen.json");
  fs.writeFileSync(runPath, JSON.stringify(run));
  store.applyRecipeRecompile(command(preview), preview);
  assert.equal(fs.readFileSync(runPath, "utf8"), JSON.stringify(run), "frozen runs remain unchanged");
  const entry = store.recipeSyncEntries().find(entry => entry.recipe.recipeId === recipe.recipeId);
  validateGitHubSyncCandidate(entry.destination, Buffer.from(entry.content));
  assert.equal(entry.recipe.revision, 2);
  const imported = importRecipe(initializeProjectModel(undefined, () => "root"), entry.recipe,
    { sourceKey: "roundtrip", kind: "import" }, () => "copy");
  assert.equal(imported.recipes.find(item => item.origin?.sourceKey === "roundtrip").executableDigest, entry.recipe.executableDigest);

  seed();
  const stale = store.previewRecipeRecompile(recipe.recipeId);
  seed([{ ...recipe, description: "edited after review" }]);
  assert.throws(() => store.applyRecipeRecompile(command(stale), stale), /changed since preview/);
  seed();
  const versioned = store.previewRecipeRecompile(recipe.recipeId);
  store.createProject({ commandId: "another-writer", fingerprint: "another-writer", expectedStoreVersion: 1 }, "Concurrent project");
  assert.throws(() => store.applyRecipeRecompile(command(versioned), versioned), /version/i);
  seed([{ ...recipe, executableDigest: "f".repeat(64) }]);
  assert.throws(() => store.previewRecipeRecompile(recipe.recipeId), /not a verified legacy/);

  const consumerDefinition = structuredClone(definition);
  consumerDefinition.spec.nodes[0] = { nodeId: "z_source", kind: "pkm.subflow/v1",
    config: { recipeId: recipe.recipeId, revision: 1, executableDigest: recipe.executableDigest }, dependsOn: [] };
  const consumer = { ...recipe, recipeId: "recipe_consumer", definition: consumerDefinition,
    executableDigest: compileWorkflowDefinitionV1(consumerDefinition).executableDigest };
  seed([recipe, consumer]);
  const pinned = store.previewRecipeRecompile(recipe.recipeId);
  assert.deepEqual(pinned.pinnedConsumers, ["Recipe recipe_consumer"]);
  assert.throws(() => store.applyRecipeRecompile(command(pinned), pinned), /pinned references/);
  assert.equal(store.list().recipes.find(item => item.recipeId === recipe.recipeId).revision, 1);
  seed();
  fs.writeFileSync(runPath, JSON.stringify({ definition: consumerDefinition }));
  const runPinned = store.previewRecipeRecompile(recipe.recipeId);
  assert(runPinned.pinnedConsumers.some(item => item.includes("Run frozen.json")));
  assert.throws(() => store.applyRecipeRecompile(command(runPinned), runPinned), /pinned references/);
  fs.rmSync(runPath);
  seed();
  const forMigration = store.previewRecipeRecompile(recipe.recipeId);
  store.applyRecipeRecompile(command(forMigration), forMigration);
  const migration = store.migrateLegacyRecipes("preview");
  for (const action of ["stage", "verify", "cutover"]) {
    store.migrateLegacyRecipes(action, { sourceDigest: migration.sourceDigest });
  }
  const migrated = store.recipeSyncEntries().find(item => item.recipe.recipeId === recipe.recipeId);
  assert.equal(migrated.recipe.revision, 2, "migration retains the approved revision");
  assert.equal(migrated.recipe.executableDigest, forMigration.compiled.executableDigest);
  assert.equal(migrated.recipe.nodeBindings[0].nodeId, "z_source");
  assert.equal(migrated.sourceLocator.kind, "file");
  validateGitHubSyncCandidate(migrated.destination, Buffer.from(migrated.content));
  console.log("Recipe approved recompile, revision, frozen-run and pin safeguards passed");
} finally { fs.rmSync(root, { recursive: true, force: true }); }
