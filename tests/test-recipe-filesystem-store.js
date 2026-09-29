#!/usr/bin/env node
const assert = require("assert");
const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const { canonicalJson, compileWorkflowDefinitionV1 } = require("../dist/workflow-contracts.js");
const {
  RecipeFilesystemStore,
  RecipeFilesystemStoreError,
  safeRecipeFileName,
} = require("../dist/workflows/recipe-filesystem-store.js");
const { ProjectStore, ProjectStoreError } = require("../dist/workflows/project-store.js");

const roots = [];
const scratch = path.join(__dirname, ".recipe-filesystem-store-work");
const temporary = () => {
  fs.mkdirSync(scratch, { recursive: true });
  const root = path.join(scratch, crypto.randomUUID());
  fs.mkdirSync(root);
  roots.push(root);
  return root;
};
const definition = {
  schema: "pkm.workflow.definition/v1",
  spec: {
    inputs: {},
    nodes: [{ nodeId: "work", kind: "pkm.step.noop/v1", config: {}, dependsOn: [] }],
    outputs: {},
    completion: { requiredNodes: ["work"] },
  },
};
const compiled = compileWorkflowDefinitionV1(definition);
assert(compiled.ok);
const recipe = (recipeId, name, category = "", extra = {}) => ({
  recipeId,
  scope: "global",
  ...(category ? { category } : {}),
  name,
  description: "description",
  definition: compiled.model,
  executableDigest: compiled.executableDigest,
  revision: 7,
  ...extra,
});
const expectCode = (action, code) =>
  assert.throws(action, error => error instanceof RecipeFilesystemStoreError && error.code === code);

try {
  assert.strictEqual(safeRecipeFileName(" CON<> Name. ", "recipe_one"), "CON-Name.recipe_one.json");
  const root = temporary();
  const state = path.join(root, ".pkm", "state");
  const store = new RecipeFilesystemStore(state);
  const created = store.put(recipe("recipe_one", "One"));
  assert.strictEqual(created.category || "", "");
  assert(fs.existsSync(path.join(root, "recipes", "Uncategorized", "One.recipe_one.json")));
  assert.strictEqual(store.list().recipes[0].revision, 7);
  const identity = store.list().recipes[0];
  assert.match(identity.knowledgeId, /^knowledge_[a-f0-9]{24}$/);
  assert(identity.aliases.includes("recipe:recipe_one"));

  store.put({ ...identity, name: "Renamed", category: "Automation/Linux" });
  const moved = new RecipeFilesystemStore(state).list().recipes[0];
  assert.strictEqual(moved.recipeId, identity.recipeId);
  assert.strictEqual(moved.knowledgeId, identity.knowledgeId);
  assert(moved.aliases.some(alias => alias.includes("Uncategorized/One.recipe_one.json")));
  assert.strictEqual(moved.executableDigest, identity.executableDigest);
  assert(fs.existsSync(path.join(root, "recipes", "Automation", "Linux", "Renamed.recipe_one.json")));

  store.moveToTrash("recipe_one", "2026-09-28T00:00:00.000Z");
  assert.strictEqual(store.list().recipes.length, 0);
  assert.deepStrictEqual(store.list().deletionEvidence, ["recipe_one"]);
  assert(store.githubFiles().every(file => !file.includes(".trash")));
  store.restoreFromTrash("recipe_one");
  assert.strictEqual(store.list().recipes[0].knowledgeId, identity.knowledgeId);
  store.moveToTrash("recipe_one");
  store.deleteFromTrash("recipe_one");
  assert.deepStrictEqual(store.list().deletionEvidence, []);

  const builtIn = store.put(recipe("recipe_builtin", "Managed", "System", { systemKind: "built-in" }), { managed: true });
  expectCode(() => store.put({ ...builtIn, description: "changed" }), "built-in-read-only");
  const fork = store.forkBuiltIn("recipe_builtin", () => "fork");
  assert.strictEqual(fork.systemKind, undefined);
  assert.notStrictEqual(fork.recipeId, builtIn.recipeId);
  assert.notStrictEqual(fork.knowledgeId, builtIn.knowledgeId);
  store.replaceManagedBuiltIns([{ ...builtIn, description: "same revision must not replace" }]);
  assert.strictEqual(store.list().recipes.find(item => item.recipeId === builtIn.recipeId).description,
    builtIn.description, "equal packaged revisions must preserve the canonical built-in");
  store.replaceManagedBuiltIns([{ ...builtIn, revision: builtIn.revision - 1, description: "older must not replace" }]);
  assert.strictEqual(store.list().recipes.find(item => item.recipeId === builtIn.recipeId).description,
    builtIn.description, "older packaged revisions must preserve the canonical built-in");
  store.replaceManagedBuiltIns([{ ...builtIn, revision: builtIn.revision + 1, description: "managed upgrade" }]);
  const upgradedBuiltIn = store.list().recipes.find(item => item.recipeId === builtIn.recipeId);
  assert.strictEqual(upgradedBuiltIn.description, "managed upgrade");
  assert.strictEqual(upgradedBuiltIn.knowledgeId, builtIn.knowledgeId);
  assert(store.list().recipes.some(item => item.recipeId === fork.recipeId), "managed upgrades must preserve user forks");

  const healthyPath = path.join(root, "recipes", "Healthy");
  fs.mkdirSync(healthyPath, { recursive: true });
  fs.writeFileSync(path.join(healthyPath, "broken.recipe_bad.json"), "{");
  store.put(recipe("recipe_actual", "Mismatch", "Elsewhere"));
  fs.renameSync(path.join(root, "recipes", "Elsewhere", "Mismatch.recipe_actual.json"),
    path.join(healthyPath, "Mismatch.recipe_actual.json"));
  fs.writeFileSync(path.join(healthyPath, "digest.recipe_digest.json"),
    JSON.stringify(recipe("recipe_digest", "Digest", "Healthy", { executableDigest: "0".repeat(64) })));
  fs.writeFileSync(path.join(healthyPath, "definition.recipe_definition.json"),
    JSON.stringify({ ...recipe("recipe_definition", "Definition", "Healthy"), definition: { schema: "wrong" } }));
  const duplicateSource = store.list().recipes.find(item => item.recipeId === fork.recipeId);
  const duplicateDirectory = path.join(root, "recipes", "Duplicate");
  fs.mkdirSync(duplicateDirectory, { recursive: true });
  fs.writeFileSync(path.join(duplicateDirectory, `Duplicate.${fork.recipeId}.json`),
    JSON.stringify({ ...duplicateSource, name: "Duplicate", category: "Duplicate" }));
  store.put(recipe("recipe_case_upper", "Upper", "Case"));
  store.put(recipe("recipe_case_lower", "Lower", "case"));
  const diagnostics = store.list().diagnostics;
  assert(diagnostics.some(item => item.code === "invalid-json"));
  assert(diagnostics.some(item => item.code === "path-category-mismatch"));
  assert(diagnostics.some(item => item.code === "digest-mismatch"));
  assert(diagnostics.some(item => item.code === "definition-invalid"));
  assert(diagnostics.some(item => item.code === "duplicate-recipe-id"));
  assert(diagnostics.some(item => item.code === "duplicate-knowledge-id"));
  assert(diagnostics.some(item => item.code === "portable-category-collision"));
  assert(store.list().recipes.some(item => item.recipeId === "recipe_builtin"),
    "invalid files must not block healthy Recipes");

  const migrationRoot = temporary();
  const migrationState = path.join(migrationRoot, ".pkm", "state");
  const migration = new RecipeFilesystemStore(migrationState);
  const legacy = {
    sourceDigest: "a".repeat(64),
    recipes: [recipe("recipe_legacy", "Legacy", "Modules", {
      nodeBindings: [{ nodeId: "work", bindings: [] }],
      origin: { kind: "direct-sync", sourceKey: "source" },
    })],
    trash: [recipe("recipe_deleted", "Deleted")],
    projects: [],
  };
  const preview = migration.previewMigration(legacy);
  assert.strictEqual(preview.active, 1);
  assert.strictEqual(migration.stageMigration(legacy, preview.sourceDigest).phase, "staged");
  assert.strictEqual(migration.stageMigration(legacy, preview.sourceDigest).phase, "staged");
  assert.strictEqual(migration.verifyMigration(legacy, preview.sourceDigest).phase, "verified");
  assert.strictEqual(migration.cutoverMigration(legacy, preview.sourceDigest).phase, "cutover");
  const migrated = migration.list().recipes[0];
  assert.strictEqual(migrated.recipeId, "recipe_legacy");
  assert.strictEqual(migrated.revision, 7);
  assert.strictEqual(migrated.executableDigest, compiled.executableDigest);
  assert.deepStrictEqual(migrated.definition, compiled.model);
  assert.deepStrictEqual(migrated.nodeBindings, legacy.recipes[0].nodeBindings);
  assert.deepStrictEqual(migrated.origin, legacy.recipes[0].origin);
  assert.strictEqual(migration.cutoverMigration(legacy, preview.sourceDigest).phase, "cutover");
  assert.strictEqual(migration.rollbackMigration(legacy, preview.sourceDigest).phase, "rolled-back");
  assert(!fs.existsSync(path.join(migrationRoot, "recipes")));

  const changed = { ...legacy, sourceDigest: "b".repeat(64) };
  expectCode(() => migration.stageMigration(changed, legacy.sourceDigest), "migration-source-changed");

  const collisionRoot = temporary();
  const collisionState = path.join(collisionRoot, ".pkm", "state");
  const collision = new RecipeFilesystemStore(collisionState);
  collision.put(recipe("recipe_foreign", "Foreign"));
  expectCode(() => collision.stageMigration(legacy, legacy.sourceDigest), "migration-target-conflict");

  const interruptedRoot = temporary();
  const interruptedState = path.join(interruptedRoot, ".pkm", "state");
  const interrupted = new RecipeFilesystemStore(interruptedState);
  interrupted.stageMigration(legacy, legacy.sourceDigest);
  interrupted.verifyMigration(legacy, legacy.sourceDigest);
  fs.renameSync(path.join(interruptedState, "recipe-store-migration", "stage", "recipes"),
    path.join(interruptedRoot, "recipes"));
  assert.strictEqual(interrupted.cutoverMigration(legacy, legacy.sourceDigest).phase, "cutover");
  assert.strictEqual(interrupted.list().recipes[0].recipeId, "recipe_legacy");

  const sourceChangeRoot = temporary();
  const sourceChangeState = path.join(sourceChangeRoot, ".pkm", "state");
  const sourceChangeStore = new ProjectStore(sourceChangeState);
  const sourceChangeInitial = sourceChangeStore.list();
  const sourceChangePreview = sourceChangeStore.migrateLegacyRecipes("preview");
  sourceChangeStore.createRecipe({
    commandId: "change-source", fingerprint: "change-source",
    expectedStoreVersion: sourceChangeInitial.storeVersion,
  }, { kind: "global" }, "Changed Source");
  assert.throws(() => sourceChangeStore.migrateLegacyRecipes("stage", {
    sourceDigest: sourceChangePreview.sourceDigest,
  }), error => error instanceof ProjectStoreError && error.code === "migration-source-changed");

  const upgradedBuiltInRoot = temporary();
  const upgradedBuiltInState = path.join(upgradedBuiltInRoot, ".pkm", "state");
  const upgradedBuiltInSeed = new ProjectStore(upgradedBuiltInState, () => "upgraded-built-in-root", { autoMigrate: false });
  const upgradedBuiltInInitial = upgradedBuiltInSeed.list();
  const upgradedEnvelopePath = path.join(upgradedBuiltInState, "projects.json");
  const upgradedEnvelope = JSON.parse(fs.readFileSync(upgradedEnvelopePath, "utf8"));
  const tutorial = upgradedEnvelope.payload.state.recipes.find(item => item.name === "PKM Tutorial");
  const changedDefinition = JSON.parse(JSON.stringify(tutorial.definition));
  changedDefinition.spec.nodes.push({
    nodeId: "record-upgraded-result",
    kind: "pkm.step.noop/v1",
    config: {},
    generalInstruction: "Record the upgraded built-in result without replacing its pinned canonical semantics.",
    dependsOn: [{ from: "synthesize-answer", accept: ["succeeded"], required: true }],
  });
  changedDefinition.spec.completion.requiredNodes = ["record-upgraded-result"];
  const changedCompiled = compileWorkflowDefinitionV1(changedDefinition);
  assert(changedCompiled.ok);
  const upgradedTutorial = {
    ...tutorial,
    revision: tutorial.revision + 1,
    description: "Upgraded PKM Tutorial",
    definition: changedCompiled.model,
    executableDigest: changedCompiled.executableDigest,
    metadata: {
      ...tutorial.metadata,
      solution: "Preserve upgraded canonical built-in semantics.",
    },
    nodeBindings: [{
      nodeId: "record-upgraded-result",
      bindings: [{
        bindingId: "upgraded-binding",
        kind: "skill",
        knowledgeId: "knowledge_upgraded_tutorial",
        contentHash: "3".repeat(64),
        usage: "required",
      }],
    }],
  };
  upgradedEnvelope.payload.state.recipes = upgradedEnvelope.payload.state.recipes
    .map(item => item.recipeId === tutorial.recipeId ? upgradedTutorial : item);
  upgradedEnvelope.digest = crypto.createHash("sha256")
    .update(canonicalJson(upgradedEnvelope.payload), "utf8").digest("hex");
  fs.writeFileSync(upgradedEnvelopePath, canonicalJson(upgradedEnvelope));

  const upgradedMigration = new ProjectStore(upgradedBuiltInState, () => "unused", { autoMigrate: false });
  const upgradedPreview = upgradedMigration.migrateLegacyRecipes("preview");
  upgradedMigration.migrateLegacyRecipes("stage", { sourceDigest: upgradedPreview.sourceDigest });
  upgradedMigration.migrateLegacyRecipes("verify", { sourceDigest: upgradedPreview.sourceDigest });
  upgradedMigration.migrateLegacyRecipes("cutover", { sourceDigest: upgradedPreview.sourceDigest });
  const afterUpgradedCutover = upgradedMigration.list().recipes.find(item => item.recipeId === tutorial.recipeId);
  for (const field of ["recipeId", "revision", "executableDigest", "definition", "methodology",
    "methodologyDigest", "metadata", "nodeBindings", "origin", "systemKind"]) {
    assert.deepStrictEqual(afterUpgradedCutover[field], upgradedTutorial[field],
      `${field} must preserve the upgraded built-in through cutover`);
  }
  const afterUpgradedRestart = new ProjectStore(upgradedBuiltInState, () => "unused", { autoMigrate: false })
    .list().recipes.find(item => item.recipeId === tutorial.recipeId);
  assert.deepStrictEqual(afterUpgradedRestart, afterUpgradedCutover,
    "restart must preserve the upgraded canonical built-in exactly");
  assert.strictEqual(upgradedBuiltInInitial.recipes.find(item => item.recipeId === tutorial.recipeId).revision + 1,
    afterUpgradedRestart.revision);

  const adapterRoot = temporary();
  const adapterState = path.join(adapterRoot, ".pkm", "state");
  const adapter = new ProjectStore(adapterState);
  const before = adapter.list();
  const legacyAuthority = JSON.parse(fs.readFileSync(path.join(adapterState, "projects.json"), "utf8"));
  const adapterPreview = adapter.migrateLegacyRecipes("preview");
  adapter.migrateLegacyRecipes("stage", { sourceDigest: adapterPreview.sourceDigest });
  adapter.migrateLegacyRecipes("verify", { sourceDigest: adapterPreview.sourceDigest });
  adapter.migrateLegacyRecipes("cutover", { sourceDigest: adapterPreview.sourceDigest });
  const legacyEnvelope = JSON.parse(fs.readFileSync(path.join(adapterState, "projects.json"), "utf8"));
  assert(!Object.prototype.hasOwnProperty.call(legacyEnvelope.payload.state, "recipes"));
  assert(!Object.prototype.hasOwnProperty.call(legacyEnvelope.payload.state, "recipeFolders"));
  assert(!Object.prototype.hasOwnProperty.call(legacyEnvelope.payload.state, "recipeTrash"));

  const staleAuthority = JSON.parse(JSON.stringify(legacyEnvelope));
  for (const field of ["recipes", "recipeFolders", "recipeTrash"]) {
    if (Object.prototype.hasOwnProperty.call(legacyAuthority.payload.state, field)) {
      staleAuthority.payload.state[field] = legacyAuthority.payload.state[field];
    }
  }
  staleAuthority.digest = crypto.createHash("sha256")
    .update(canonicalJson(staleAuthority.payload), "utf8").digest("hex");
  fs.writeFileSync(path.join(adapterState, "projects.json"), canonicalJson(staleAuthority));
  new ProjectStore(adapterState).list();
  const healedAuthority = JSON.parse(fs.readFileSync(path.join(adapterState, "projects.json"), "utf8"));
  for (const field of ["recipes", "recipeFolders", "recipeTrash"]) {
    assert(!Object.prototype.hasOwnProperty.call(healedAuthority.payload.state, field),
      `loader must remove stale ${field} authority after canonical Recipe cutover`);
  }

  const divergentRecipeAuthority = JSON.parse(JSON.stringify(staleAuthority));
  divergentRecipeAuthority.payload.state.recipes[0].description = "written by an older process";
  divergentRecipeAuthority.digest = crypto.createHash("sha256")
    .update(canonicalJson(divergentRecipeAuthority.payload), "utf8").digest("hex");
  fs.writeFileSync(path.join(adapterState, "projects.json"), canonicalJson(divergentRecipeAuthority));
  assert.throws(
    () => new ProjectStore(adapterState).list(),
    error => error instanceof ProjectStoreError && error.code === "migration-legacy-writer-conflict",
    "post-cutover Recipe writes from an older process must be preserved as an explicit conflict",
  );
  assert.strictEqual(
    JSON.parse(fs.readFileSync(path.join(adapterState, "projects.json"), "utf8"))
      .payload.state.recipes[0].description,
    "written by an older process",
    "a conflicting legacy Recipe write must never be discarded",
  );
  fs.writeFileSync(path.join(adapterState, "projects.json"), canonicalJson(healedAuthority));

  const divergentProjectAuthority = JSON.parse(JSON.stringify(healedAuthority));
  divergentProjectAuthority.payload.state.projects.push({
    projectId: "project_old_writer",
    name: "Old Writer Project",
    createdAt: "2026-09-28T00:00:00.000Z",
    updatedAt: "2026-09-28T00:00:00.000Z",
  });
  divergentProjectAuthority.digest = crypto.createHash("sha256")
    .update(canonicalJson(divergentProjectAuthority.payload), "utf8").digest("hex");
  fs.writeFileSync(path.join(adapterState, "projects.json"), canonicalJson(divergentProjectAuthority));
  assert.throws(
    () => new ProjectStore(adapterState).list(),
    error => error instanceof ProjectStoreError && error.code === "migration-legacy-writer-conflict",
    "post-cutover Project writes from an older process must be preserved as an explicit conflict",
  );
  assert(
    JSON.parse(fs.readFileSync(path.join(adapterState, "projects.json"), "utf8"))
      .payload.state.projects.some(project => project.projectId === "project_old_writer"),
    "a conflicting legacy Project write must never be discarded",
  );
  fs.writeFileSync(path.join(adapterState, "projects.json"), canonicalJson(healedAuthority));

  const after = new ProjectStore(adapterState).list();
  const parity = items => items.map(item => [item.recipeId, item.revision, item.executableDigest])
    .sort((left, right) => left[0].localeCompare(right[0]));
  assert.deepStrictEqual(parity(after.recipes), parity(before.recipes));
  for (const migratedRecipe of after.recipes) {
    const legacyRecipe = before.recipes.find(item => item.recipeId === migratedRecipe.recipeId);
    for (const field of ["definition", "methodology", "methodologyDigest", "metadata", "editorLayout",
      "nodeBindings", "origin", "systemKind"]) {
      assert.deepStrictEqual(migratedRecipe[field], legacyRecipe[field], `${field} must survive migration`);
    }
  }
  const command = (commandId, version) => ({ commandId, fingerprint: `fp-${commandId}`, expectedStoreVersion: version });
  const authored = adapter.createRecipe(command("filesystem-create", after.storeVersion), { kind: "global" }, "Filesystem Recipe", "Automation");
  assert(authored.snapshot.recipes.some(item => item.recipeId === authored.entityId));
  const recipeFreeAfterCreate = JSON.parse(fs.readFileSync(path.join(adapterState, "projects.json"), "utf8"));
  assert(!Object.prototype.hasOwnProperty.call(recipeFreeAfterCreate.payload.state, "recipes"));
  const trashed = adapter.moveRecipeToTrash(command("filesystem-trash", authored.snapshot.storeVersion), authored.entityId);
  assert(trashed.snapshot.recipeTrash.some(item => item.recipeId === authored.entityId));
  const restored = adapter.restoreRecipeFromTrash(command("filesystem-restore", trashed.snapshot.storeVersion), authored.entityId);
  assert(restored.snapshot.recipes.some(item => item.recipeId === authored.entityId));
  const adapterBuiltIn = restored.snapshot.recipes.find(item => item.systemKind === "built-in");
  assert.throws(() => adapter.updateRecipe(command("built-in-update", restored.snapshot.storeVersion), adapterBuiltIn.recipeId, {
    name: adapterBuiltIn.name, category: adapterBuiltIn.category || "", description: "mutated", definition: adapterBuiltIn.definition,
  }), error => error instanceof ProjectStoreError && error.code === "built-in-read-only");
  assert.strictEqual(adapter.list().storeVersion, restored.snapshot.storeVersion);
  adapter.migrateLegacyRecipes("rollback", { sourceDigest: adapterPreview.sourceDigest });
  const restoredEnvelope = JSON.parse(fs.readFileSync(path.join(adapterState, "projects.json"), "utf8"));
  assert(Array.isArray(restoredEnvelope.payload.state.recipes));

  console.log("recipe filesystem store tests passed");
} finally {
  for (const root of roots) fs.rmSync(root, { recursive: true, force: true });
  fs.rmSync(scratch, { recursive: true, force: true });
}
