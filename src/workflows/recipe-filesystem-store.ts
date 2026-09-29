import * as fs from "fs";
import * as path from "path";
import { createHash, randomUUID } from "crypto";
import { canonicalJson, compileWorkflowDefinitionV1 } from "../workflow-contracts";
import {
  KNOWLEDGE_SCHEMA_V1,
  KnowledgeIdentityMetadata,
  compileKnowledgeIdentityV1,
  legacyKnowledgeAlias,
} from "../knowledge-contracts";
import { compileRecipeMethodologyV1 } from "./methodology-model";
import { ProjectRecord, RecipeRecord, RecipeTrashRecord } from "./project-model";

export const RECIPE_FILESYSTEM_STORE_SCHEMA = 1;
export const UNCATEGORIZED_RECIPE_DIRECTORY = "Uncategorized";

export type StoredRecipeRecord = RecipeRecord & KnowledgeIdentityMetadata;
export type StoredRecipeTrashRecord = StoredRecipeRecord & { trashedAt: string };

export interface RecipeFileDiagnostic {
  code: string;
  path: string;
  message: string;
  recipeId?: string;
  knowledgeId?: string;
}

export interface RecipeFilesystemSnapshot {
  recipes: StoredRecipeRecord[];
  trash: StoredRecipeTrashRecord[];
  categories: string[];
  diagnostics: RecipeFileDiagnostic[];
  deletionEvidence: string[];
}

export interface RecipeMigrationSource {
  sourceDigest: string;
  recipes: RecipeRecord[];
  trash: RecipeTrashRecord[] | RecipeRecord[];
  projects: ProjectRecord[];
  folders?: string[];
}

export type RecipeMigrationPhase = "previewed" | "staged" | "verified" | "cutover" | "rolled-back";

export interface RecipeMigrationReceipt {
  phase: RecipeMigrationPhase;
  sourceDigest: string;
  canonicalDigest: string;
  active: number;
  trash: number;
  categories: number;
  legacyFolders: number;
  projectScoped: number;
  collisions: RecipeFileDiagnostic[];
}

interface RecipeMigrationMarker extends RecipeMigrationReceipt {
  hadTarget: boolean;
}

interface RecipeStoreControl {
  schema: 1;
  migration?: RecipeMigrationReceipt;
}

export class RecipeFilesystemStoreError extends Error {
  constructor(public readonly code: string, message: string, public readonly diagnostics: RecipeFileDiagnostic[] = []) {
    super(message);
  }
}

export class RecipeFilesystemStore {
  readonly knowledgeRoot: string;
  readonly recipesRoot: string;
  readonly trashRoot: string;
  readonly controlPath: string;
  private readonly migrationRoot: string;
  private readonly markerPath: string;

  constructor(readonly stateDirectory: string) {
    this.knowledgeRoot = path.basename(stateDirectory) === "state" && path.basename(path.dirname(stateDirectory)) === ".pkm"
      ? path.dirname(path.dirname(stateDirectory))
      : stateDirectory;
    this.recipesRoot = path.join(this.knowledgeRoot, "recipes");
    this.trashRoot = path.join(this.recipesRoot, ".trash");
    this.controlPath = path.join(stateDirectory, "recipe-store.json");
    this.migrationRoot = path.join(stateDirectory, "recipe-store-migration");
    this.markerPath = path.join(this.migrationRoot, "migration.json");
  }

  hasCanonicalStore(): boolean {
    return fs.existsSync(this.recipesRoot) && fs.existsSync(this.controlPath);
  }

  list(): RecipeFilesystemSnapshot {
    return scanRecipeTree(this.recipesRoot);
  }

  put(recipe: RecipeRecord | StoredRecipeRecord, options: { managed?: boolean } = {}): StoredRecipeRecord {
    const category = normalizeRecipeCategory(recipe.category);
    const current = this.findAny(recipe.recipeId);
    if (current?.systemKind === "built-in" && !options.managed) {
      fail("built-in-read-only", "Built-in Recipes are read-only; fork the Recipe before customization.");
    }
    const relative = recipeRelativePath(recipe.name, recipe.recipeId, category);
    const previousRelative = current ? recipeRelativePath(current.name, current.recipeId, current.category) : relative;
    const previousFile = current ? this.locate(this.recipesRoot, current.recipeId) : undefined;
    const stored = prepareStoredRecipe(recipe, category, previousRelative, relative);
    const snapshot = this.list();
    const identityConflict = [...snapshot.recipes, ...snapshot.trash]
      .find(candidate => candidate.recipeId !== stored.recipeId && candidate.knowledgeId === stored.knowledgeId);
    if (identityConflict) fail("duplicate-knowledge-id", `Knowledge identity is already used by Recipe ${identityConflict.recipeId}.`);
    fs.mkdirSync(path.dirname(path.join(this.recipesRoot, relative)), { recursive: true });
    atomicWriteJson(path.join(this.recipesRoot, relative), stored);
    if (previousFile && previousFile !== path.join(this.recipesRoot, relative)) fs.rmSync(previousFile, { force: true });
    pruneEmptyDirectories(this.recipesRoot, this.recipesRoot);
    this.ensureControl();
    return clone(stored);
  }

  moveToTrash(recipeId: string, trashedAt = new Date().toISOString()): StoredRecipeTrashRecord {
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
  }

  deleteFromTrash(recipeId: string): void {
    const source = this.locate(this.trashRoot, recipeId);
    if (!source) fail("recipe-trash-not-found", "Recipe is not in Trash.");
    fs.rmSync(source, { force: true });
    pruneEmptyDirectories(this.trashRoot, this.trashRoot);
  }

  forkBuiltIn(recipeId: string, createId: () => string = randomUUID): StoredRecipeRecord {
    const source = this.requireActive(recipeId);
    if (source.systemKind !== "built-in") fail("recipe-not-built-in", "Only a built-in Recipe requires a managed fork.");
    const nextId = `recipe_${createId()}`;
    const fork: RecipeRecord = {
      ...source,
      recipeId: nextId,
      name: `${source.name} (Fork)`,
      revision: 1,
      origin: {
        kind: "built-in-fork",
        sourceRecipeId: source.recipeId,
        sourceRevision: source.revision,
      },
    };
    delete (fork as Partial<RecipeRecord>).systemKind;
    delete (fork as Partial<StoredRecipeRecord>).knowledgeId;
    delete (fork as Partial<StoredRecipeRecord>).schema;
    delete (fork as Partial<StoredRecipeRecord>).aliases;
    return this.put(fork);
  }

  replaceManagedBuiltIns(recipes: RecipeRecord[]): void {
    const snapshot = this.list();
    const managed = snapshot.recipes.filter(recipe => recipe.systemKind === "built-in");
    const existing = new Map(managed.map(recipe => [recipe.recipeId, recipe]));
    const packagedIds = new Set<string>();
    for (const recipe of recipes) {
      if (recipe.systemKind !== "built-in") fail("managed-recipe-invalid", "Managed Recipe upgrades may contain only built-ins.");
      validateRecipeRecord(recipe);
      if (packagedIds.has(recipe.recipeId)) fail("managed-recipe-invalid", "Managed Recipe upgrades contain a duplicate identity.");
      packagedIds.add(recipe.recipeId);
      const current = existing.get(recipe.recipeId);
      if (current && recipe.revision <= current.revision) continue;
      this.put({
        ...recipe,
        ...(current ? {
          schema: current.schema,
          knowledgeId: current.knowledgeId,
          aliases: [...new Set([
            ...current.aliases,
            legacyKnowledgeAlias("recipe", recipeRelativePath(current.name, current.recipeId, current.category)),
          ])],
        } : {}),
      }, { managed: true });
    }
  }

  replaceFromState(
    recipes: RecipeRecord[],
    trash: RecipeTrashRecord[] = [],
    options: { managedBuiltIns?: boolean } = {},
  ): RecipeFilesystemSnapshot {
    const staging = path.join(this.stateDirectory, `.recipe-store-write-${process.pid}-${randomUUID()}`);
    const stagedRoot = path.join(staging, "recipes");
    const existing = this.list();
    const existingById = new Map([...existing.recipes, ...existing.trash].map(recipe => [recipe.recipeId, recipe]));
    if (!options.managedBuiltIns) {
      for (const recipe of [...recipes, ...trash]) {
        const current = existingById.get(recipe.recipeId);
        if (current?.systemKind === "built-in"
          && canonicalJson(stripKnowledge(current)) !== canonicalJson(stripKnowledge(recipe))) {
          fail("built-in-read-only", "Built-in Recipes are read-only; fork the Recipe before customization.");
        }
      }
    }
    try {
      for (const recipe of recipes) {
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
      }
      const verified = scanRecipeTree(stagedRoot);
      if (verified.diagnostics.length || verified.recipes.length !== recipes.length || verified.trash.length !== trash.length) {
        fail("store-write-verification-failed", "Staged Recipe files failed verification.", verified.diagnostics);
      }
      replaceDirectory(stagedRoot, this.recipesRoot, staging);
      this.ensureControl();
      return this.list();
    } finally {
      fs.rmSync(staging, { recursive: true, force: true });
    }
  }

  renameCategory(from: string, to: string): RecipeFilesystemSnapshot {
    const source = normalizeRecipeCategory(from);
    const target = normalizeRecipeCategory(to);
    if (!source) fail("category-invalid", "Uncategorized cannot be renamed as a physical category.");
    const snapshot = this.list();
    const changed = snapshot.recipes.map(recipe => {
      const category = recipe.category || "";
      if (category !== source && !category.startsWith(`${source}/`)) return recipe;
      return { ...recipe, category: `${target}${category.slice(source.length)}`.replace(/^\/+/, ""), revision: recipe.revision + 1 };
    });
    if (canonicalJson(changed) === canonicalJson(snapshot.recipes)) fail("category-not-found", `Recipe category does not exist: ${source}`);
    return this.replaceFromState(changed, snapshot.trash);
  }

  deleteCategory(category: string, action: "move-to-parent" | "trash"): RecipeFilesystemSnapshot {
    const source = normalizeRecipeCategory(category);
    if (!source) fail("category-invalid", "Uncategorized cannot be deleted.");
    const snapshot = this.list();
    const affected = snapshot.recipes.filter(recipe => recipe.category === source || recipe.category?.startsWith(`${source}/`));
    if (!affected.length) fail("category-not-found", `Recipe category does not exist: ${source}`);
    if (action === "trash") {
      for (const recipe of affected) this.moveToTrash(recipe.recipeId);
      return this.list();
    }
    const parent = source.includes("/") ? source.slice(0, source.lastIndexOf("/")) : "";
    const changed = snapshot.recipes.map(recipe => {
      if (recipe.category !== source && !recipe.category?.startsWith(`${source}/`)) return recipe;
      const suffix = (recipe.category || "").slice(source.length).replace(/^\/+/, "");
      return { ...recipe, category: [parent, suffix].filter(Boolean).join("/"), revision: recipe.revision + 1 };
    });
    return this.replaceFromState(changed, snapshot.trash);
  }

  githubFiles(): string[] {
    const snapshot = this.list();
    const healthy = new Set(snapshot.recipes.map(recipe => recipe.recipeId));
    return walkFiles(this.recipesRoot, true)
      .filter(file => healthy.has(recipeIdFromFile(file)))
      .map(file => portable(path.relative(this.knowledgeRoot, file)))
      .sort();
  }

  previewMigration(source: RecipeMigrationSource): RecipeMigrationReceipt {
    validateSourceDigest(source);
    const projected = projectLegacyRecipes(source);
    const collisions = [...sourceMigrationCollisions(projected), ...migrationCollisions(projected, this.list())];
    return migrationReceipt("previewed", source.sourceDigest, projected.recipes, projected.trash, collisions, source);
  }

  stageMigration(source: RecipeMigrationSource, expectedSourceDigest?: string): RecipeMigrationReceipt {
    fenceSource(source, expectedSourceDigest);
    const projected = projectLegacyRecipes(source);
    const receipt = migrationReceipt("staged", source.sourceDigest, projected.recipes, projected.trash,
      [...sourceMigrationCollisions(projected), ...migrationCollisions(projected, this.list())], source);
    if (receipt.collisions.length) fail("migration-target-conflict", "Recipe migration target contains conflicting identities.", receipt.collisions);
    const marker = this.readMarker(false);
    if (marker && marker.sourceDigest !== source.sourceDigest && marker.phase !== "rolled-back") {
      fail("migration-source-changed", "Legacy Recipe source changed after migration staging began.");
    }
    if (marker && marker.sourceDigest === receipt.sourceDigest && marker.canonicalDigest === receipt.canonicalDigest
      && ["staged", "verified"].includes(marker.phase)
      && (fs.existsSync(this.stagingRoot()) || this.targetMatches(marker))) {
      return { ...marker, phase: marker.phase as "staged" | "verified" };
    }
    fs.rmSync(path.join(this.migrationRoot, "stage"), { recursive: true, force: true });
    fs.rmSync(this.markerPath, { force: true });
    writeRecipeTree(this.stagingRoot(), projected.recipes, projected.trash);
    const staged = scanRecipeTree(this.stagingRoot());
    if (staged.diagnostics.length) fail("migration-staging-invalid", "Legacy Recipes produced invalid staged files.", staged.diagnostics);
    const next = { ...receipt, hadTarget: fs.existsSync(this.recipesRoot) };
    this.writeMarker(next);
    return receipt;
  }

  verifyMigration(source: RecipeMigrationSource, expectedSourceDigest?: string): RecipeMigrationReceipt {
    fenceSource(source, expectedSourceDigest);
    const marker = this.requireMarker(source.sourceDigest);
    const root = fs.existsSync(this.stagingRoot()) ? this.stagingRoot() : this.targetMatches(marker) ? this.recipesRoot : "";
    if (!root) fail("migration-not-staged", "Recipe migration staging is missing.");
    const snapshot = scanRecipeTree(root);
    if (snapshot.diagnostics.length || snapshotDigest(snapshot) !== marker.canonicalDigest) {
      fail("migration-verification-failed", "Staged Recipe data failed semantic verification.", snapshot.diagnostics);
    }
    const verified = { ...marker, phase: "verified" as const };
    this.writeMarker(verified);
    return withoutMarkerInternal(verified);
  }

  cutoverMigration(source: RecipeMigrationSource, expectedSourceDigest?: string): RecipeMigrationReceipt {
    fenceSource(source, expectedSourceDigest);
    const control = this.readControl();
    if (control?.migration?.phase === "cutover" && control.migration.sourceDigest === source.sourceDigest) {
      return control.migration;
    }
    let marker = this.requireMarker(source.sourceDigest);
    if (marker.phase !== "verified") {
      this.verifyMigration(source, expectedSourceDigest);
      marker = this.requireMarker(source.sourceDigest);
    }
    if (fs.existsSync(this.recipesRoot)) {
      if (this.targetMatches(marker) && !fs.existsSync(this.stagingRoot())) {
        const recovered = { ...withoutMarkerInternal(marker), phase: "cutover" as const };
        this.writeControl({ schema: 1, migration: recovered });
        this.writeMarker({ ...marker, phase: "cutover" });
        return recovered;
      }
      fail("migration-target-conflict", "Canonical Recipe target already exists; migration will not choose a winner.");
    }
    fs.mkdirSync(path.dirname(this.recipesRoot), { recursive: true });
    fs.renameSync(this.stagingRoot(), this.recipesRoot);
    const cutover = { ...withoutMarkerInternal(marker), phase: "cutover" as const };
    this.writeControl({ schema: 1, migration: cutover });
    this.writeMarker({ ...marker, phase: "cutover" });
    fsyncDirectory(this.knowledgeRoot);
    return cutover;
  }

  rollbackMigration(source: RecipeMigrationSource, expectedSourceDigest?: string): RecipeMigrationReceipt {
    fenceSource(source, expectedSourceDigest);
    const marker = this.requireMarker(source.sourceDigest);
    if (marker.phase === "rolled-back") return withoutMarkerInternal(marker);
    if (marker.phase === "cutover" && this.targetMatches(marker)) {
      fs.rmSync(this.recipesRoot, { recursive: true, force: true });
    }
    fs.rmSync(path.join(this.migrationRoot, "stage"), { recursive: true, force: true });
    const rolledBack = { ...marker, phase: "rolled-back" as const };
    this.writeMarker(rolledBack);
    this.writeControl({ schema: 1, migration: withoutMarkerInternal(rolledBack) });
    return withoutMarkerInternal(rolledBack);
  }

  migrationStatus(): RecipeMigrationReceipt | undefined {
    const control = this.readControl()?.migration;
    if (control) return control;
    const marker = this.readMarker(false);
    return marker ? withoutMarkerInternal(marker) : undefined;
  }

  verifyCutover(expectedSourceDigest?: string): RecipeMigrationReceipt {
    const receipt = this.readControl()?.migration;
    if (!receipt || receipt.phase !== "cutover") {
      fail("migration-not-cutover", "Canonical Recipe migration has not completed cutover.");
    }
    if (expectedSourceDigest && expectedSourceDigest !== receipt.sourceDigest) {
      fail("migration-source-changed", "Legacy Recipe source changed after preview.");
    }
    const snapshot = this.list();
    if (snapshot.diagnostics.length || snapshotDigest(snapshot) !== receipt.canonicalDigest
      || snapshot.recipes.length !== receipt.active || snapshot.trash.length !== receipt.trash) {
      fail("migration-verification-failed", "Canonical Recipe data failed restart verification.", snapshot.diagnostics);
    }
    return receipt;
  }

  legacySourceMatchesCutover(source: RecipeMigrationSource): boolean {
    const migration = this.readControl()?.migration;
    if (!migration || migration.phase !== "cutover") return true;
    const projected = projectLegacyRecipes(source);
    const collisions = sourceMigrationCollisions(projected);
    if (collisions.length) return false;
    return migrationReceipt(
      "previewed",
      source.sourceDigest,
      projected.recipes,
      projected.trash,
      collisions,
      source,
    ).canonicalDigest === migration.canonicalDigest;
  }

  private ensureControl(): void {
    fs.mkdirSync(this.stateDirectory, { recursive: true });
    if (!fs.existsSync(this.controlPath)) this.writeControl({ schema: 1 });
  }

  private requireActive(recipeId: string): StoredRecipeRecord {
    const recipe = this.list().recipes.find(candidate => candidate.recipeId === recipeId);
    if (!recipe) fail("recipe-not-found", "Recipe does not exist or is invalid.");
    return recipe;
  }

  private findAny(recipeId: string): StoredRecipeRecord | StoredRecipeTrashRecord | undefined {
    const snapshot = this.list();
    return [...snapshot.recipes, ...snapshot.trash].find(recipe => recipe.recipeId === recipeId);
  }

  private locate(root: string, recipeId: string): string | undefined {
    return walkFiles(root, root === this.recipesRoot).find(file => recipeIdFromFile(file) === recipeId);
  }

  private stagingRoot(): string {
    return path.join(this.migrationRoot, "stage", "recipes");
  }

  private readControl(): RecipeStoreControl | undefined {
    if (!fs.existsSync(this.controlPath)) return undefined;
    try {
      const value = JSON.parse(fs.readFileSync(this.controlPath, "utf8"));
      if (!isRecord(value) || value.schema !== RECIPE_FILESYSTEM_STORE_SCHEMA) throw new Error("invalid");
      return value as RecipeStoreControl;
    } catch {
      fail("store-corrupt", "Recipe filesystem control state is corrupt.");
    }
  }

  private writeControl(control: RecipeStoreControl): void {
    atomicWriteJson(this.controlPath, control);
  }

  private readMarker(required: boolean): RecipeMigrationMarker | undefined {
    if (!fs.existsSync(this.markerPath)) {
      if (required) fail("migration-not-staged", "Recipe migration state is missing.");
      return undefined;
    }
    try {
      const value = JSON.parse(fs.readFileSync(this.markerPath, "utf8"));
      if (!isRecord(value) || typeof value.sourceDigest !== "string" || typeof value.canonicalDigest !== "string"
        || typeof value.hadTarget !== "boolean") throw new Error("invalid");
      return value as RecipeMigrationMarker;
    } catch {
      fail("migration-state-corrupt", "Recipe migration state is corrupt.");
    }
  }

  private requireMarker(sourceDigest: string): RecipeMigrationMarker {
    const marker = this.readMarker(true)!;
    if (marker.sourceDigest !== sourceDigest) fail("migration-source-changed", "Legacy Recipe source changed after staging.");
    return marker;
  }

  private writeMarker(marker: RecipeMigrationMarker): void {
    atomicWriteJson(this.markerPath, marker);
  }

  private targetMatches(marker: RecipeMigrationMarker): boolean {
    if (!fs.existsSync(this.recipesRoot)) return false;
    const snapshot = scanRecipeTree(this.recipesRoot);
    return !snapshot.diagnostics.length && snapshotDigest(snapshot) === marker.canonicalDigest;
  }
}

function prepareStoredRecipe(
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
      .filter(alias => /^(note|skill|research|recipe):[^\u0000-\u001f]+$/.test(alias)),
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
}

function validateRecipeRecord(value: RecipeRecord): void {
  if (!isRecord(value) || !validRecipeId(value.recipeId) || typeof value.name !== "string" || !value.name.trim()
    || value.scope !== "global" || value.projectId !== undefined
    || typeof value.description !== "string" || !Number.isSafeInteger(value.revision) || value.revision < 1) {
    fail("recipe-invalid", "Recipe metadata is invalid.");
  }
  const compiled = compileWorkflowDefinitionV1(value.definition);
  if (!compiled.ok) fail("definition-invalid", "Recipe workflow definition is invalid.");
  if (compiled.executableDigest !== value.executableDigest) fail("digest-mismatch", "Recipe executable digest does not match its definition.");
  if (value.methodology) {
    const methodology = compileRecipeMethodologyV1(value.methodology);
    if (!methodology.ok) fail("methodology-invalid", "Recipe Methodology Manifest is invalid.");
    if (methodology.methodologyDigest !== value.methodologyDigest) fail("methodology-digest-mismatch", "Recipe methodology digest is invalid.");
  } else if (value.methodologyDigest) {
    fail("methodology-digest-mismatch", "Recipe methodology digest exists without a Methodology Manifest.");
  }
}

function scanRecipeTree(root: string): RecipeFilesystemSnapshot {
  const diagnostics: RecipeFileDiagnostic[] = [];
  const active: Array<{ file: string; recipe: StoredRecipeRecord }> = [];
  const trash: Array<{ file: string; recipe: StoredRecipeTrashRecord }> = [];
  for (const file of walkFiles(root, false)) {
    const relative = portable(path.relative(root, file));
    const inTrash = relative.startsWith(".trash/");
    let value: unknown;
    try { value = JSON.parse(fs.readFileSync(file, "utf8")); }
    catch {
      diagnostics.push({ code: "invalid-json", path: relative, message: "Recipe file is not valid JSON." });
      continue;
    }
    if (!isRecord(value)) {
      diagnostics.push({ code: "invalid-schema", path: relative, message: "Recipe file must contain an object." });
      continue;
    }
    const recipeId = String(value.recipeId || "");
    const knowledgeId = String(value.knowledgeId || "");
    try {
      validateRecipeRecord(value as unknown as RecipeRecord);
      const identity = compileKnowledgeIdentityV1({
        schema: value.schema,
        knowledgeId: value.knowledgeId,
        revision: value.revision,
        aliases: value.aliases,
      });
      if (!identity.ok) throw new RecipeFilesystemStoreError("identity-invalid", "Recipe Knowledge identity is invalid.");
      if (!inTrash) {
        const category = categoryFromRelative(relative);
        if (normalizeRecipeCategory(value.category) !== category) {
          diagnostics.push({ code: "path-category-mismatch", path: relative, recipeId, knowledgeId,
            message: "Recipe category does not match its parent directory." });
          continue;
        }
      }
      if (recipeIdFromFile(file) !== recipeId) {
        diagnostics.push({ code: "path-recipe-id-mismatch", path: relative, recipeId, knowledgeId,
          message: "Recipe filename identity does not match its JSON identity." });
        continue;
      }
      if (inTrash) {
        if (typeof value.trashedAt !== "string" || !value.trashedAt) {
          diagnostics.push({ code: "trash-metadata-invalid", path: relative, recipeId, knowledgeId,
            message: "Trashed Recipe requires trashedAt." });
          continue;
        }
        trash.push({ file: relative, recipe: clone(value as unknown as StoredRecipeTrashRecord) });
      } else {
        active.push({ file: relative, recipe: clone(value as unknown as StoredRecipeRecord) });
      }
    } catch (error) {
      const code = error instanceof RecipeFilesystemStoreError ? error.code : "invalid-schema";
      diagnostics.push({ code, path: relative, recipeId: recipeId || undefined, knowledgeId: knowledgeId || undefined,
        message: error instanceof Error ? error.message : "Recipe file is invalid." });
    }
  }
  const invalidFiles = new Set<string>();
  const categoriesByPortableName = new Map<string, Map<string, string[]>>();
  for (const entry of active) {
    const category = categoryFromRelative(entry.file);
    const portableCategory = category.normalize("NFC").toLocaleLowerCase("en-US");
    const variants = categoriesByPortableName.get(portableCategory) || new Map<string, string[]>();
    variants.set(category, [...(variants.get(category) || []), entry.file]);
    categoriesByPortableName.set(portableCategory, variants);
  }
  for (const variants of categoriesByPortableName.values()) {
    if (variants.size < 2) continue;
    const files = [...variants.values()].flat();
    files.forEach(file => invalidFiles.add(file));
    diagnostics.push({
      code: "portable-category-collision",
      path: files.sort()[0],
      message: "Recipe categories differ only by case or Unicode normalization.",
    });
  }
  const portablePaths = new Map<string, string>();
  for (const entry of [...active, ...trash]) {
    const portablePath = entry.file.normalize("NFC").toLocaleLowerCase("en-US");
    const previous = portablePaths.get(portablePath);
    if (previous && previous !== entry.file) {
      invalidFiles.add(previous);
      invalidFiles.add(entry.file);
      diagnostics.push({
        code: "portable-path-collision",
        path: entry.file,
        recipeId: entry.recipe.recipeId,
        knowledgeId: entry.recipe.knowledgeId,
        message: `Recipe path differs only by case or Unicode normalization from ${previous}.`,
      });
    } else portablePaths.set(portablePath, entry.file);
  }
  for (const [field, code] of [["recipeId", "duplicate-recipe-id"], ["knowledgeId", "duplicate-knowledge-id"]] as const) {
    const seen = new Map<string, string>();
    for (const entry of [...active, ...trash]) {
      const value = entry.recipe[field];
      const previous = seen.get(value);
      if (previous) {
        invalidFiles.add(previous);
        invalidFiles.add(entry.file);
        diagnostics.push({ code, path: entry.file, recipeId: entry.recipe.recipeId, knowledgeId: entry.recipe.knowledgeId,
          message: `${field} duplicates ${previous}.` });
      } else seen.set(value, entry.file);
    }
  }
  const recipes = active.filter(entry => !invalidFiles.has(entry.file)).map(entry => entry.recipe)
    .sort((left, right) => left.recipeId.localeCompare(right.recipeId));
  const validTrash = trash.filter(entry => !invalidFiles.has(entry.file)).map(entry => entry.recipe)
    .sort((left, right) => left.recipeId.localeCompare(right.recipeId));
  const categories = [...new Set(recipes.map(recipe => recipe.category || ""))].sort();
  return {
    recipes,
    trash: validTrash,
    categories,
    diagnostics: diagnostics.sort((left, right) => left.path.localeCompare(right.path) || left.code.localeCompare(right.code)),
    deletionEvidence: validTrash.map(recipe => recipe.recipeId).sort(),
  };
}

function projectLegacyRecipes(source: RecipeMigrationSource): { recipes: RecipeRecord[]; trash: RecipeTrashRecord[] } {
  const projects = new Map(source.projects.map(project => [project.projectId, project.name]));
  const project = <T extends RecipeRecord>(recipe: T): T => {
    if (recipe.scope !== "project") return clone(recipe);
    const projectName = projects.get(String(recipe.projectId || ""));
    if (!projectName) fail("migration-project-name-required", `Project name is required for Recipe ${recipe.recipeId}.`);
    const category = ["Project", safeRecipeCategorySegment(projectName), recipe.category || ""].filter(Boolean).join("/");
    const result = { ...clone(recipe), scope: "global" as const, category };
    delete result.projectId;
    return result;
  };
  return {
    recipes: source.recipes.map(project),
    trash: source.trash.map(recipe => {
      const migrated = project(recipe as RecipeTrashRecord);
      return { ...migrated, trashedAt: (recipe as RecipeTrashRecord).trashedAt || new Date(0).toISOString() };
    }),
  };
}

function writeRecipeTree(root: string, recipes: RecipeRecord[], trash: RecipeTrashRecord[]): void {
  for (const recipe of recipes) {
    const category = normalizeRecipeCategory(recipe.category);
    const relative = recipeRelativePath(recipe.name, recipe.recipeId, category);
    writeJson(path.join(root, relative), prepareStoredRecipe(recipe, category, relative, relative));
  }
  for (const recipe of trash) {
    const category = normalizeRecipeCategory(recipe.category);
    const relative = recipeRelativePath(recipe.name, recipe.recipeId, category);
    writeJson(path.join(root, ".trash", safeRecipeFileName(recipe.name, recipe.recipeId)), {
      ...prepareStoredRecipe(recipe, category, relative, relative),
      trashedAt: recipe.trashedAt,
    });
  }
}

function migrationReceipt(
  phase: RecipeMigrationPhase,
  sourceDigest: string,
  recipes: RecipeRecord[],
  trash: RecipeTrashRecord[],
  collisions: RecipeFileDiagnostic[],
  source?: RecipeMigrationSource,
): RecipeMigrationReceipt {
  const projected = recipes.map(recipe => ({ ...recipe, category: normalizeRecipeCategory(recipe.category) }));
  const categories = new Set([...projected, ...trash].map(recipe => normalizeRecipeCategory(recipe.category)));
  return {
    phase,
    sourceDigest,
    canonicalDigest: createHash("sha256").update(canonicalJson({
      recipes: projected.map(recipe => prepareStoredRecipe(
        recipe,
        normalizeRecipeCategory(recipe.category),
        recipeRelativePath(recipe.name, recipe.recipeId, normalizeRecipeCategory(recipe.category)),
        recipeRelativePath(recipe.name, recipe.recipeId, normalizeRecipeCategory(recipe.category)),
      )).sort(byRecipeId),
      trash: trash.map(recipe => ({
        ...prepareStoredRecipe(
          recipe,
          normalizeRecipeCategory(recipe.category),
          recipeRelativePath(recipe.name, recipe.recipeId, normalizeRecipeCategory(recipe.category)),
          recipeRelativePath(recipe.name, recipe.recipeId, normalizeRecipeCategory(recipe.category)),
        ),
        trashedAt: recipe.trashedAt,
      })).sort(byRecipeId),
    }), "utf8").digest("hex"),
    active: recipes.length,
    trash: trash.length,
    categories: categories.size,
    legacyFolders: source?.folders?.length || 0,
    projectScoped: source ? [...source.recipes, ...source.trash].filter(recipe => recipe.scope === "project").length : 0,
    collisions,
  };
}

function snapshotDigest(snapshot: RecipeFilesystemSnapshot): string {
  return createHash("sha256").update(canonicalJson({
    recipes: snapshot.recipes.sort(byRecipeId),
    trash: snapshot.trash.sort(byRecipeId),
  }), "utf8").digest("hex");
}

function migrationCollisions(
  projected: { recipes: RecipeRecord[]; trash: RecipeTrashRecord[] },
  target: RecipeFilesystemSnapshot,
): RecipeFileDiagnostic[] {
  if (!target.recipes.length && !target.trash.length && !target.diagnostics.length) return [];
  const diagnostics = [...target.diagnostics];
  const targetById = new Map([...target.recipes, ...target.trash].map(recipe => [recipe.recipeId, recipe]));
  const projectedIds = new Set([...projected.recipes, ...projected.trash].map(recipe => recipe.recipeId));
  for (const recipe of [...projected.recipes, ...projected.trash]) {
    const existing = targetById.get(recipe.recipeId);
    if (existing && canonicalJson(stripKnowledge(existing)) !== canonicalJson(stripKnowledge(recipe))) {
      diagnostics.push({ code: "migration-recipe-collision", path: recipe.recipeId, recipeId: recipe.recipeId,
        message: "Target contains the same Recipe identity with different content." });
    } else if (!existing) {
      diagnostics.push({ code: "migration-target-not-empty", path: recipe.recipeId, recipeId: recipe.recipeId,
        message: "Target contains unrelated Recipe content." });
    }
  }
  for (const recipe of [...target.recipes, ...target.trash]) {
    if (!projectedIds.has(recipe.recipeId)) {
      diagnostics.push({ code: "migration-target-not-empty", path: recipe.recipeId, recipeId: recipe.recipeId,
        message: "Target contains unrelated Recipe content." });
    }
  }
  return diagnostics;
}

function sourceMigrationCollisions(
  projected: { recipes: RecipeRecord[]; trash: RecipeTrashRecord[] },
): RecipeFileDiagnostic[] {
  const diagnostics: RecipeFileDiagnostic[] = [];
  const seenIds = new Set<string>();
  const seenKnowledge = new Set<string>();
  for (const recipe of [...projected.recipes, ...projected.trash]) {
    if (seenIds.has(recipe.recipeId)) {
      diagnostics.push({ code: "duplicate-recipe-id", path: recipe.recipeId, recipeId: recipe.recipeId,
        message: "Legacy source contains a duplicate Recipe identity." });
    }
    seenIds.add(recipe.recipeId);
    const knowledgeId = (recipe as Partial<StoredRecipeRecord>).knowledgeId || deterministicKnowledgeId(recipe.recipeId);
    if (seenKnowledge.has(knowledgeId)) {
      diagnostics.push({ code: "duplicate-knowledge-id", path: recipe.recipeId, recipeId: recipe.recipeId, knowledgeId,
        message: "Legacy source contains a duplicate Knowledge identity." });
    }
    seenKnowledge.add(knowledgeId);
  }
  return diagnostics;
}

function stripKnowledge(recipe: RecipeRecord | StoredRecipeRecord): RecipeRecord {
  const { schema: _schema, knowledgeId: _knowledgeId, aliases: _aliases, ...value } = recipe as StoredRecipeRecord;
  return value;
}

export function safeRecipeFileName(name: string, recipeId: string): string {
  if (!validRecipeId(recipeId)) fail("recipe-id-invalid", "Recipe identity is not portable.");
  let safe = String(name || "").normalize("NFC").replace(/[<>:"/\\|?*\u0000-\u001f\u007f]/g, "-")
    .replace(/\s+/g, "-").replace(/-+/g, "-").replace(/^[ .-]+|[ .-]+$/g, "");
  if (!safe) safe = "Recipe";
  if (/^(CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(?:\.|$)/i.test(safe)) safe = `${safe}-Recipe`;
  safe = safe.slice(0, Math.max(1, 180 - recipeId.length)).replace(/[ .]+$/g, "") || "Recipe";
  return `${safe}.${recipeId}.json`;
}

function normalizeRecipeCategory(value: unknown): string {
  const raw = String(value || "").trim().normalize("NFC").replace(/\\/g, "/");
  if (!raw) return "";
  if (raw.startsWith("/") || raw.endsWith("/") || raw.includes("//")) fail("category-invalid", "Recipe category is not portable.");
  const segments = raw.split("/");
  if (segments[0] === "Project" && segments.length < 2) {
    fail("category-invalid", "Recipes under the reserved Project category require a Project subcategory.");
  }
  if (segments.some(segment => !segment || segment === "." || segment === ".." || segment === ".trash"
    || segment === UNCATEGORIZED_RECIPE_DIRECTORY || /[<>:"\\|?*\u0000-\u001f\u007f]/.test(segment)
    || /[ .]$/.test(segment) || /^(CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(?:\.|$)/i.test(segment))) {
    fail("category-invalid", "Recipe category contains a reserved or non-portable segment.");
  }
  return segments.join("/");
}

export function safeRecipeCategorySegment(value: string): string {
  let safe = String(value || "").trim().normalize("NFC")
    .replace(/[<>:"/\\|?*\u0000-\u001f\u007f]/g, "-")
    .replace(/\s+/g, " ").replace(/^[ .]+|[ .]+$/g, "");
  if (!safe) safe = "Project";
  if (/^(CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(?:\.|$)/i.test(safe)) safe = `${safe}-Project`;
  return safe.slice(0, 120).replace(/[ .]+$/g, "") || "Project";
}

function recipeRelativePath(name: string, recipeId: string, category: unknown): string {
  const normalized = normalizeRecipeCategory(category);
  return portable(path.join(normalized || UNCATEGORIZED_RECIPE_DIRECTORY, safeRecipeFileName(name, recipeId)));
}

function categoryFromRelative(relative: string): string {
  const parent = portable(path.dirname(relative));
  return parent === UNCATEGORIZED_RECIPE_DIRECTORY ? "" : parent;
}

function deterministicKnowledgeId(recipeId: string): string {
  return `knowledge_${createHash("sha256").update(`recipe\0${recipeId}`, "utf8").digest("hex").slice(0, 24)}`;
}

function walkFiles(root: string, excludeTrash: boolean): string[] {
  if (!fs.existsSync(root)) return [];
  const result: string[] = [];
  const visit = (directory: string): void => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      if (excludeTrash && directory === root && entry.name === ".trash") continue;
      const target = path.join(directory, entry.name);
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) visit(target);
      else if (entry.isFile() && entry.name.endsWith(".json")) result.push(target);
    }
  };
  visit(root);
  return result;
}

function recipeIdFromFile(file: string): string {
  return /\.([A-Za-z][A-Za-z0-9._-]{0,127})\.json$/i.exec(path.basename(file))?.[1] || "";
}

function validRecipeId(value: unknown): value is string {
  return typeof value === "string" && /^[A-Za-z][A-Za-z0-9._-]{0,127}$/.test(value);
}

function replaceDirectory(staged: string, target: string, workspace: string): void {
  const previous = path.join(workspace, "previous");
  try {
    if (fs.existsSync(target)) fs.renameSync(target, previous);
    fs.renameSync(staged, target);
    fs.rmSync(previous, { recursive: true, force: true });
    fsyncDirectory(path.dirname(target));
  } catch (error) {
    if (!fs.existsSync(target) && fs.existsSync(previous)) fs.renameSync(previous, target);
    throw error;
  }
}

function pruneEmptyDirectories(root: string, preserve: string): boolean {
  if (!fs.existsSync(root)) return true;
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    if (entry.isDirectory()) pruneEmptyDirectories(path.join(root, entry.name), preserve);
  }
  if (root !== preserve && fs.readdirSync(root).length === 0) fs.rmdirSync(root);
  return !fs.existsSync(root) || fs.readdirSync(root).length === 0;
}

function writeJson(file: string, value: unknown): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
}

function atomicWriteJson(file: string, value: unknown): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temporary = `${file}.${process.pid}.${randomUUID()}.tmp`;
  const descriptor = fs.openSync(temporary, "wx", 0o600);
  try {
    fs.writeFileSync(descriptor, `${JSON.stringify(value, null, 2)}\n`, "utf8");
    fs.fsyncSync(descriptor);
  } finally {
    fs.closeSync(descriptor);
  }
  fs.renameSync(temporary, file);
  fs.chmodSync(file, 0o600);
  fsyncDirectory(path.dirname(file));
}

function fsyncDirectory(directory: string): void {
  let descriptor: number | undefined;
  try {
    descriptor = fs.openSync(directory, "r");
    fs.fsyncSync(descriptor);
  } catch (error: any) {
    if (!error || !["EINVAL", "ENOTSUP", "EISDIR", "EPERM"].includes(error.code)) throw error;
  } finally {
    if (descriptor !== undefined) fs.closeSync(descriptor);
  }
}

function fenceSource(source: RecipeMigrationSource, expected?: string): void {
  validateSourceDigest(source);
  if (expected && expected !== source.sourceDigest) fail("migration-source-changed", "Legacy Recipe source changed after preview.");
}

function validateSourceDigest(source: RecipeMigrationSource): void {
  if (!/^[a-f0-9]{64}$/.test(source.sourceDigest)) fail("migration-source-invalid", "Legacy Recipe source digest is invalid.");
}

function withoutMarkerInternal(marker: RecipeMigrationMarker): RecipeMigrationReceipt {
  const { hadTarget: _hadTarget, ...receipt } = marker;
  return receipt;
}

function portable(value: string): string {
  return value.split(path.sep).join("/");
}

function byRecipeId(left: RecipeRecord, right: RecipeRecord): number {
  return left.recipeId.localeCompare(right.recipeId);
}

function clone<T>(value: T): T {
  return JSON.parse(canonicalJson(value)) as T;
}

function isRecord(value: unknown): value is Record<string, any> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function fail(code: string, message: string, diagnostics: RecipeFileDiagnostic[] = []): never {
  throw new RecipeFilesystemStoreError(code, message, diagnostics);
}
