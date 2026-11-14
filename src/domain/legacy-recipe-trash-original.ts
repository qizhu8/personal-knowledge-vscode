export const originalSources = [
  {
    path: "src/workflows/project-model.ts",
    sha256: "505f56e2351a9f173268007990eaf02f1014abe0dc4f722b12a8f6aa81c94195",
    symbols: ["moveRecipeToTrash", "restoreRecipeFromTrash"],
  },
  {
    path: "src/workflows/project-store.ts",
    sha256: "a88568af85c6cbf714cc8c9efcfb641da12502df888b4c6dd9e4b7e24dacc010",
    symbols: ["ProjectStore.moveRecipeToTrash", "ProjectStore.restoreRecipeFromTrash", "ProjectStore.mutate"],
  },
  {
    path: "src/workflows/recipe-filesystem-store.ts",
    sha256: "3ecfb22753d16455ff7427993fd4d017dc00c1d2ffd65be9414157e31421b6f5",
    symbols: ["RecipeFilesystemStore.moveToTrash", "RecipeFilesystemStore.restoreFromTrash", "RecipeFilesystemStore.replaceFromState"],
  },
  {
    path: "src/workflows/project-filesystem-store.ts",
    sha256: "20c0f58161b3f82181e48049e3ad95f0091ec41e1a1fba61413514c97502e0f8",
    symbols: ["ProjectFilesystemStore.checkCommand", "ProjectFilesystemStore.mutate"],
  },
] as const;

export const capturedDeclarations = [
  `export function moveRecipeToTrash(state: ProjectModelState, recipeId: string, trashedAt = new Date().toISOString()): ProjectModelState {
  const recipe = (state.recipes || []).find(candidate => candidate.recipeId === recipeId);
  if (!recipe) throw new ProjectModelError("recipe-not-found", "Recipe does not exist.");
  if (recipe.systemKind === "built-in") throw new ProjectModelError("system-recipe-delete", "Built-in Recipes cannot be moved to Trash.");
  return {
    ...state,
    recipes: (state.recipes || []).filter(candidate => candidate.recipeId !== recipeId),
    recipeTrash: [...(state.recipeTrash || []), { ...recipe, trashedAt }],
    audit: [...state.audit, { event: "recipe-trashed", entityId: recipeId }]
  };
}`,
  `export function restoreRecipeFromTrash(state: ProjectModelState, recipeId: string): ProjectModelState {
  const recipe = (state.recipeTrash || []).find(candidate => candidate.recipeId === recipeId);
  if (!recipe) throw new ProjectModelError("recipe-trash-not-found", "Recipe is not in Trash.");
  if ((state.recipes || []).some(candidate => candidate.recipeId === recipeId)) throw new ProjectModelError("identity-conflict", "A Recipe with the same identity already exists.");
  const { trashedAt: _trashedAt, ...restored } = recipe;
  return {
    ...state,
    recipes: [...(state.recipes || []), restored],
    recipeTrash: (state.recipeTrash || []).filter(candidate => candidate.recipeId !== recipeId),
    audit: [...state.audit, { event: "recipe-restored", entityId: recipeId }]
  };
}`,
  `  moveRecipeToTrash(command: ProjectStoreCommand, recipeId: string): ProjectStoreResult {
    return this.mutate(command, "recipe-trash-move", state => ({ state: moveRecipeToTrash(state, recipeId), entityId: recipeId }));
  }

  restoreRecipeFromTrash(command: ProjectStoreCommand, recipeId: string): ProjectStoreResult {
    return this.mutate(command, "recipe-trash-restore", state => ({ state: restoreRecipeFromTrash(state, recipeId), entityId: recipeId }));
  }`,
  `  moveToTrash(recipeId: string, trashedAt = new Date().toISOString()): StoredRecipeTrashRecord {
    const current = this.requireActive(recipeId);
    if (current.systemKind === "built-in") fail("built-in-read-only", "Built-in Recipes cannot be moved to Trash.");
    const source = this.locate(this.recipesRoot, recipeId)!;
    const trashed: StoredRecipeTrashRecord = { ...current, trashedAt };
    fs.mkdirSync(this.trashRoot, { recursive: true });
    atomicWriteJson(path.join(this.trashRoot, safeRecipeFileName(current.name, recipeId)), trashed);
    fs.rmSync(source, { force: true });
    pruneEmptyDirectories(this.recipesRoot, this.recipesRoot);
    this.ensureControl();
    return clone(trashed);
  }

  restoreFromTrash(recipeId: string): StoredRecipeRecord {
    if (this.list().recipes.some(recipe => recipe.recipeId === recipeId)) {
      fail("identity-conflict", "An active Recipe with the same identity already exists.");
    }
    const trashed = this.list().trash.find(recipe => recipe.recipeId === recipeId);
    if (!trashed) fail("recipe-trash-not-found", "Recipe is not in Trash.");
    const { trashedAt: _trashedAt, ...recipe } = trashed;
    const restored = this.put(recipe);
    const source = this.locate(this.trashRoot, recipeId);
    if (source) fs.rmSync(source, { force: true });
    pruneEmptyDirectories(this.trashRoot, this.trashRoot);
    return restored;
  }`,
  `    const next = makeEnvelope(storeVersion, {
        state: isRecipeOperation(operation) && this.recipeFilesystem.hasCanonicalStore()
          ? stripLegacyRecipeState(changed.state)
          : changed.state,
        receipts: [...current.payload.receipts, {
          commandId: command.commandId,
          fingerprint: command.fingerprint,
          operation,
          storeVersion,
          entityId: changed.entityId
        }].slice(-PROJECT_RECEIPT_LIMIT)
      });`,
  `      for (const recipe of recipes) {
        const category = normalizeRecipeCategory(recipe.category);
        const relative = recipeRelativePath(recipe.name, recipe.recipeId, category);
        const previous = existingById.get(recipe.recipeId);
        const previousRelative = previous
          ? recipeRelativePath(previous.name, previous.recipeId, previous.category)
          : relative;
        writeJson(path.join(stagedRoot, relative), prepareStoredRecipe({ ...recipe, ...(previous || {}) , ...recipe }, category, previousRelative, relative));
      }
      for (const recipe of trash) {
        const previous = existingById.get(recipe.recipeId);
        const category = normalizeRecipeCategory(recipe.category);
        const relative = recipeRelativePath(recipe.name, recipe.recipeId, category);
        const stored = prepareStoredRecipe({ ...recipe, ...(previous || {}), ...recipe }, category, relative, relative);
        writeJson(path.join(stagedRoot, ".trash", safeRecipeFileName(recipe.name, recipe.recipeId)), {
          ...stored,
          trashedAt: recipe.trashedAt || new Date().toISOString(),
        });
      }`,
  `function prepareStoredRecipe(
  input: RecipeRecord | StoredRecipeRecord,
  category: string,
  previousRelative: string,
  relative: string,
): StoredRecipeRecord {
  validateRecipeRecord(input);
  const candidateKnowledgeId = String((input as Partial<StoredRecipeRecord>).knowledgeId || "");
  const knowledgeId = /^knowledge_[a-f0-9]{24}$/.test(candidateKnowledgeId)
    ? candidateKnowledgeId
    : deterministicKnowledgeId(input.recipeId);
  const aliases = [...new Set([
    ...((input as Partial<StoredRecipeRecord>).aliases || [])
      .filter(alias => /^(note|skill|research|recipe):[^\\u0000-\\u001f]+$/.test(alias)),
    legacyKnowledgeAlias("recipe", input.recipeId),
    legacyKnowledgeAlias("recipe", previousRelative),
    legacyKnowledgeAlias("recipe", relative),
  ])].sort();
  const stored: StoredRecipeRecord = {
    ...clone(input),
    schema: KNOWLEDGE_SCHEMA_V1,
    knowledgeId,
    aliases,
    scope: "global",
    ...(category ? { category } : {}),
  };
  delete stored.projectId;
  if (!category) delete stored.category;
  return stored;
}`,
] as const;
