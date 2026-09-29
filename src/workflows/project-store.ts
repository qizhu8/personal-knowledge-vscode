import * as fs from "fs";
import * as path from "path";
import { createHash, randomUUID } from "crypto";
import { withCrossProcessLockSync } from "../cross-process-lock";
import { canonicalJson } from "../workflow-contracts";
import {
  ProjectModelError,
  ProjectModelState,
  ThreadMovePlan,
  createProject,
  createRecipe,
  createRecipeFolder,
  createThread,
  createGanttTask,
  createCollaborationTask,
  deleteGanttTask,
  deleteRecipeFolder,
  deleteRecipeFromTrash,
  deleteRecipe,
  initializeProjectModel,
  importRecipe,
  moveRecipeToTrash,
  replaceRecipeFromSync,
  moveThread,
  linkThreadChatroom,
  renameThread,
  GanttTaskInput,
  CollaborationTaskInput,
  RecipeImportOptions,
  RecipeRecord,
  RecipeUpdate,
  restoreRecipeFromTrash,
  transitionCollaborationTask,
  updateRecipe,
  updateGanttTask,
} from "./project-model";
import { CollaborationTransition } from "../collaboration-model";
import {
  LegacyProjectMigrationSource,
  ProjectFilesystemStore,
  ProjectFilesystemStoreError,
  ProjectMigrationReceipt,
  PROJECT_RECEIPT_LIMIT,
} from "./project-filesystem-store";
import {
  RecipeFilesystemStore,
  RecipeFilesystemStoreError,
  RecipeFileDiagnostic,
  RecipeMigrationReceipt,
  RecipeMigrationSource,
  safeRecipeCategorySegment,
} from "./recipe-filesystem-store";

export const PROJECT_STORE_SCHEMA = 1;

export interface ProjectStoreCommand {
  commandId: string;
  fingerprint: string;
  expectedStoreVersion: number;
}

export interface ProjectSnapshot {
  schema: 1;
  storeVersion: number;
  rootId: string;
  projects: ProjectModelState["projects"];
  threads: ProjectModelState["threads"];
  ganttTasks: NonNullable<ProjectModelState["ganttTasks"]>;
  collaborationTasks: NonNullable<ProjectModelState["collaborationTasks"]>;
  recipes: NonNullable<ProjectModelState["recipes"]>;
  recipeFolders: NonNullable<ProjectModelState["recipeFolders"]>;
  recipeTrash: NonNullable<ProjectModelState["recipeTrash"]>;
}

export interface ProjectStoreResult {
  snapshot: ProjectSnapshot;
  entityId: string;
  replayed: boolean;
}

export interface ProjectStoreOptions {
  autoMigrate?: boolean;
}

interface ProjectReceipt {
  commandId: string;
  fingerprint: string;
  operation: string;
  storeVersion: number;
  entityId: string;
}

interface ProjectStorePayload {
  state: ProjectModelState;
  receipts: ProjectReceipt[];
}

interface ProjectStoreEnvelope {
  schema: 1;
  storeVersion: number;
  payload: ProjectStorePayload;
  digest: string;
}

export class ProjectStoreError extends Error {
  constructor(public readonly code: string, message: string) {
    super(message);
  }
}

export class ProjectStore {
  private readonly filePath: string;
  private readonly lockPath: string;
  private readonly filesystem: ProjectFilesystemStore;
  private readonly recipeFilesystem: RecipeFilesystemStore;

  constructor(
    readonly directory: string,
    private readonly createId: () => string = randomUUID,
    private readonly options: ProjectStoreOptions = {},
  ) {
    this.filePath = path.join(directory, "projects.json");
    this.lockPath = path.join(directory, "projects.lock");
    this.filesystem = new ProjectFilesystemStore(directory);
    this.recipeFilesystem = new RecipeFilesystemStore(directory);
  }

  list(): ProjectSnapshot {
    return withCrossProcessLockSync(this.lockPath, "Project store", () => this.withFilesystemErrors(() => {
      const legacy = this.loadOrInitialize();
      this.ensureCanonical(legacy);
      this.upgradeManagedBuiltIns();
      return this.snapshot(legacy);
    }));
  }

  migrateLegacy(
    action: "preview" | "stage" | "verify" | "cutover" | "rollback",
    options: { sourceDigest?: string } = {},
  ): ProjectMigrationReceipt {
    return withCrossProcessLockSync(this.lockPath, "Project store", () => this.withFilesystemErrors(() => {
      const source = this.migrationSource(this.loadOrInitialize());
      if (action === "preview") return this.filesystem.previewMigration(source);
      if (action === "stage") return this.filesystem.stageMigration(source, options.sourceDigest);
      if (action === "verify") return this.filesystem.verifyMigration(source, options.sourceDigest);
      if (action === "cutover") return this.filesystem.cutoverMigration(source, options.sourceDigest);
      return this.filesystem.rollbackMigration(source, options.sourceDigest);
    }));
  }

  migrateLegacyRecipes(
    action: "preview" | "stage" | "verify" | "cutover" | "rollback",
    options: { sourceDigest?: string } = {},
  ): RecipeMigrationReceipt {
    return withCrossProcessLockSync(this.lockPath, "Project store", () => this.withFilesystemErrors(() => {
      const backupPath = path.join(this.directory, "recipe-store-migration", "legacy-projects.json");
      const status = this.recipeFilesystem.migrationStatus();
      const current = this.loadOrInitialize(status?.phase === "cutover");
      let sourceEnvelope = current;
      if (status?.phase === "cutover" && fs.existsSync(backupPath)) {
        try { sourceEnvelope = verifyEnvelope(JSON.parse(fs.readFileSync(backupPath, "utf8"))); }
        catch { fail("migration-backup-corrupt", "Legacy Recipe migration backup is corrupt."); }
      }
      const source = this.recipeMigrationSource(sourceEnvelope);
      if (action === "preview") return this.recipeFilesystem.previewMigration(source);
      if (action === "stage") {
        const receipt = this.recipeFilesystem.stageMigration(source, options.sourceDigest);
        fs.mkdirSync(path.dirname(backupPath), { recursive: true });
        if (!fs.existsSync(backupPath) || status?.phase === "rolled-back") fs.copyFileSync(this.filePath, backupPath);
        return receipt;
      }
      if (action === "verify") return this.recipeFilesystem.verifyMigration(source, options.sourceDigest);
      if (action === "cutover") {
        if (status?.phase === "cutover" && status.sourceDigest === source.sourceDigest) {
          if (current.payload.state.recipes || current.payload.state.recipeFolders || current.payload.state.recipeTrash) {
            if (!this.recipeFilesystem.legacySourceMatchesCutover(this.recipeMigrationSource(current))) {
              fail("migration-legacy-writer-conflict", "An older PKM process wrote Recipe data after migration. No data was discarded; restart all PKM clients before recovery.");
            }
            this.write(makeEnvelope(current.storeVersion, {
              state: stripLegacyRecipeState(current.payload.state),
              receipts: current.payload.receipts,
            }));
          }
          return status;
        }
        const receipt = this.recipeFilesystem.cutoverMigration(source, options.sourceDigest);
        this.write(makeEnvelope(current.storeVersion, {
          state: stripLegacyRecipeState(current.payload.state),
          receipts: current.payload.receipts,
        }));
        return receipt;
      }
      const receipt = this.recipeFilesystem.rollbackMigration(source, options.sourceDigest);
      if (fs.existsSync(backupPath)) {
        this.write(makeEnvelope(current.storeVersion, {
          state: mergeLegacyRecipeState(current.payload.state, sourceEnvelope.payload.state),
          receipts: current.payload.receipts,
        }));
      }
      return receipt;
    }));
  }

  listRecipeDiagnostics(): RecipeFileDiagnostic[] {
    return this.recipeFilesystem.hasCanonicalStore() ? this.recipeFilesystem.list().diagnostics : [];
  }

  recipeSyncEntries(): Array<{ recipe: RecipeRecord; destination: string; content: string }> {
    const snapshot = this.list();
    if (!this.recipeFilesystem.hasCanonicalStore()) {
      return snapshot.recipes.map(recipe => ({
        recipe,
        destination: ["recipes", ...(recipe.category || "").split("/").filter(Boolean),
          `${safeLegacyRecipeName(recipe.name)}.${recipe.recipeId}.json`].join("/"),
        content: `${canonicalJson(recipe)}\n`,
      }));
    }
    const byId = new Map(snapshot.recipes.map(recipe => [recipe.recipeId, recipe]));
    return this.recipeFilesystem.githubFiles().flatMap(destination => {
      const recipeId = /\.([A-Za-z][A-Za-z0-9._-]{0,127})\.json$/i.exec(destination)?.[1] || "";
      const recipe = byId.get(recipeId);
      if (!recipe) return [];
      return [{
        recipe,
        destination,
        content: fs.readFileSync(path.join(this.recipeFilesystem.knowledgeRoot, destination), "utf8"),
      }];
    });
  }

  createProject(command: ProjectStoreCommand, name: string): ProjectStoreResult {
    return this.mutate(command, "project-create", state => {
      const next = createProject(state, name, this.createId);
      return { state: next, entityId: next.projects[next.projects.length - 1].projectId };
    });
  }

  createThread(command: ProjectStoreCommand, projectId: string, name: string): ProjectStoreResult {
    return this.mutate(command, "thread-create", state => {
      const next = createThread(state, projectId, name, this.createId);
      return { state: next, entityId: next.threads[next.threads.length - 1].threadId };
    });
  }

  renameThread(command: ProjectStoreCommand, threadId: string, name: string): ProjectStoreResult {
    return this.mutate(command, "thread-rename", state => ({ state: renameThread(state, threadId, name), entityId: threadId }));
  }

  linkThreadChatroom(command: ProjectStoreCommand, threadId: string, association: { roomId: string; roomName: string; linkedAt: string }): ProjectStoreResult {
    return this.mutate(command, "thread-chatroom-link", state => ({ state: linkThreadChatroom(state, threadId, association), entityId: threadId }));
  }

  createGanttTask(command: ProjectStoreCommand, projectId: string, input: GanttTaskInput): ProjectStoreResult {
    return this.mutate(command, "gantt-task-create", state => {
      const next = createGanttTask(state, projectId, input, this.createId);
      return { state: next, entityId: next.ganttTasks![next.ganttTasks!.length - 1].taskId };
    });
  }

  updateGanttTask(command: ProjectStoreCommand, taskId: string, input: GanttTaskInput): ProjectStoreResult {
    return this.mutate(command, "gantt-task-update", state => ({ state: updateGanttTask(state, taskId, input), entityId: taskId }));
  }

  createCollaborationTask(command: ProjectStoreCommand, projectId: string, input: CollaborationTaskInput): ProjectStoreResult {
    return this.mutate(command, "collaboration-create", state => ({
      state: createCollaborationTask(state, projectId, input),
      entityId: input.collaborationId,
    }));
  }

  transitionCollaborationTask(command: ProjectStoreCommand, transition: CollaborationTransition): ProjectStoreResult {
    return this.mutate(command, `collaboration-${transition.action}`, state => ({
      state: transitionCollaborationTask(state, transition),
      entityId: transition.collaborationId,
    }));
  }

  deleteGanttTask(command: ProjectStoreCommand, taskId: string): ProjectStoreResult {
    return this.mutate(command, "gantt-task-delete", state => ({ state: deleteGanttTask(state, taskId), entityId: taskId }));
  }

  createRecipe(command: ProjectStoreCommand, scope: { kind: "global" } | { kind: "project"; projectId: string }, name: string, category = ""): ProjectStoreResult {
    return this.mutate(command, "recipe-create", state => {
      const next = createRecipe(state, scope, name, this.createId, category);
      return { state: next, entityId: next.recipes![next.recipes!.length - 1].recipeId };
    });
  }

  createRecipeFolder(command: ProjectStoreCommand, parent: string, name: string): ProjectStoreResult {
    return this.mutate(command, "recipe-folder-create", state => {
      const next = createRecipeFolder(state, parent, name);
      const entityId = next.audit[next.audit.length - 1].entityId;
      return { state: next, entityId };
    });
  }

  deleteRecipeFolder(command: ProjectStoreCommand, folder: string): ProjectStoreResult {
    return this.mutate(command, "recipe-folder-delete", state => {
      const next = deleteRecipeFolder(state, folder);
      return { state: next, entityId: next.audit[next.audit.length - 1].entityId };
    });
  }

  updateRecipe(command: ProjectStoreCommand, recipeId: string, update: RecipeUpdate): ProjectStoreResult {
    return this.mutate(command, "recipe-update", state => ({
      state: updateRecipe(state, recipeId, update),
      entityId: recipeId
    }));
  }

  importRecipe(command: ProjectStoreCommand, recipe: RecipeRecord, options: RecipeImportOptions): ProjectStoreResult {
    return this.mutate(command, "recipe-import", state => {
      const next = importRecipe(state, recipe, options, this.createId);
      const imported = next.recipes!.find(candidate => candidate.origin?.kind === options.kind
        && candidate.origin?.sourceKey === options.sourceKey && candidate.origin?.sourceRecipeId === recipe.recipeId);
      if (!imported) throw new ProjectStoreError("recipe-import-failed", "Imported Recipe was not persisted.");
      return { state: next, entityId: imported.recipeId };
    });
  }

  replaceRecipesFromSync(command: ProjectStoreCommand, recipes: RecipeRecord[]): ProjectStoreResult {
    return this.mutate(command, "recipe-github-sync", state => ({
      state: recipes.reduce((current, recipe) => replaceRecipeFromSync(current, recipe), state),
      entityId: recipes[0]?.recipeId || "recipes"
    }));
  }

  deleteRecipe(command: ProjectStoreCommand, recipeId: string): ProjectStoreResult {
    return this.mutate(command, "recipe-delete", state => ({
      state: deleteRecipe(state, recipeId),
      entityId: recipeId
    }));
  }

  moveRecipeToTrash(command: ProjectStoreCommand, recipeId: string): ProjectStoreResult {
    return this.mutate(command, "recipe-trash-move", state => ({ state: moveRecipeToTrash(state, recipeId), entityId: recipeId }));
  }

  restoreRecipeFromTrash(command: ProjectStoreCommand, recipeId: string): ProjectStoreResult {
    return this.mutate(command, "recipe-trash-restore", state => ({ state: restoreRecipeFromTrash(state, recipeId), entityId: recipeId }));
  }

  deleteRecipeFromTrash(command: ProjectStoreCommand, recipeId: string): ProjectStoreResult {
    return this.mutate(command, "recipe-trash-delete", state => ({ state: deleteRecipeFromTrash(state, recipeId), entityId: recipeId }));
  }

  moveThread(command: ProjectStoreCommand, plan: ThreadMovePlan): ProjectStoreResult {
    return this.mutate(command, "thread-move", state => ({ state: moveThread(state, plan), entityId: plan.threadId }));
  }

  private mutate(
    command: ProjectStoreCommand,
    operation: string,
    mutation: (state: ProjectModelState) => { state: ProjectModelState; entityId: string }
  ): ProjectStoreResult {
    return withCrossProcessLockSync(this.lockPath, "Project store", () => this.withFilesystemErrors(() => {
      validateCommand(command);
      const current = this.loadOrInitialize();
      this.ensureCanonical(current);
      if (this.filesystem.hasCanonicalStore()) {
        const replay = this.filesystem.checkCommand(command);
        if (replay) {
          return { snapshot: this.snapshot(current), entityId: replay.entityId, replayed: true };
        }
        const changed = mutation(this.aggregateState(current));
        const previousRecipes = this.recipeFilesystem.hasCanonicalStore() && isRecipeOperation(operation)
          ? this.recipeFilesystem.list()
          : undefined;
        if (previousRecipes) {
          const canonical = canonicalRecipeState(changed.state);
          this.recipeFilesystem.replaceFromState(
            canonical.recipes || [],
            canonical.recipeTrash || [],
            { managedBuiltIns: operation === "recipe-github-sync" },
          );
        }
        let result;
        try {
          result = this.filesystem.mutate(command, operation, changed.state, changed.entityId);
        } catch (error) {
          if (previousRecipes) {
            this.recipeFilesystem.replaceFromState(previousRecipes.recipes, previousRecipes.trash, { managedBuiltIns: true });
          }
          throw error;
        }
        if (isRecipeOperation(operation)) {
          const nextLegacy = makeEnvelope(result.snapshot.storeVersion, {
            state: this.recipeFilesystem.hasCanonicalStore()
              ? stripLegacyRecipeState(current.payload.state)
              : mergeLegacyRecipeState(current.payload.state, changed.state),
            receipts: current.payload.receipts,
          });
          this.write(nextLegacy);
          return { snapshot: this.snapshot(nextLegacy), entityId: changed.entityId, replayed: false };
        }
        return { snapshot: this.snapshot(current), entityId: changed.entityId, replayed: false };
      }
      const receipt = current.payload.receipts.find(candidate => candidate.commandId === command.commandId);
      if (receipt) {
        if (receipt.fingerprint !== command.fingerprint) fail("command-conflict", "Command ID was already used with a different fingerprint.");
        return { snapshot: this.snapshot(current), entityId: receipt.entityId, replayed: true };
      }
      if (command.expectedStoreVersion !== current.storeVersion) fail("store-version-conflict", "Expected Project store version does not match the current version.");
      const changed = mutation(clone(current.payload.state));
      const storeVersion = current.storeVersion + 1;
      const next = makeEnvelope(storeVersion, {
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
      });
      const previousRecipes = isRecipeOperation(operation) && this.recipeFilesystem.hasCanonicalStore()
        ? this.recipeFilesystem.list()
        : undefined;
      if (previousRecipes) {
        const canonical = canonicalRecipeState(changed.state);
        this.recipeFilesystem.replaceFromState(
          canonical.recipes || [],
          canonical.recipeTrash || [],
          { managedBuiltIns: operation === "recipe-github-sync" },
        );
      }
      try {
        this.write(next);
      } catch (error) {
        if (previousRecipes) {
          this.recipeFilesystem.replaceFromState(previousRecipes.recipes, previousRecipes.trash, { managedBuiltIns: true });
        }
        throw error;
      }
      return { snapshot: this.snapshot(next), entityId: changed.entityId, replayed: false };
    }));
  }

  private loadOrInitialize(allowLegacyRecipes = false): ProjectStoreEnvelope {
    fs.mkdirSync(this.directory, { recursive: true });
    if (!fs.existsSync(this.filePath)) {
      const initialized = initializeProjectModel(undefined, this.createId);
      const initial = makeEnvelope(1, {
        state: this.recipeFilesystem.hasCanonicalStore() ? stripLegacyRecipeState(initialized) : initialized,
        receipts: [],
      });
      this.write(initial);
      return initial;
    }
    let value: unknown;
    try { value = JSON.parse(fs.readFileSync(this.filePath, "utf8")); }
    catch { fail("store-corrupt", "Project store JSON is corrupt."); }
    const state = isRecord(value) && isRecord(value.payload) && isRecord(value.payload.state)
      ? value.payload.state
      : {};
    const containsLegacyRecipes = ["recipes", "recipeFolders", "recipeTrash"]
      .some(field => Object.prototype.hasOwnProperty.call(state, field));
    const canonicalRecipes = this.recipeFilesystem.hasCanonicalStore();
    const legacyVerified = canonicalRecipes && containsLegacyRecipes
      ? verifyEnvelope(value)
      : undefined;
    if (legacyVerified && !this.recipeFilesystem.legacySourceMatchesCutover(this.recipeMigrationSource(legacyVerified))) {
      fail("migration-legacy-writer-conflict", "An older PKM process wrote Recipe data after migration. No data was discarded; restart all PKM clients before recovery.");
    }
    const verified = legacyVerified && allowLegacyRecipes
      ? legacyVerified
      : verifyEnvelope(value, canonicalRecipes);
    if (this.filesystem.hasCanonicalStore() && !this.filesystem.legacySourceMatchesCutover(verified.payload.state)) {
      fail("migration-legacy-writer-conflict", "An older PKM process wrote Project data after migration. No data was discarded; restart all PKM clients before recovery.");
    }
    if ((value as ProjectStoreEnvelope).digest !== verified.digest) this.write(verified);
    return verified;
  }

  private snapshot(envelope: ProjectStoreEnvelope): ProjectSnapshot {
    const state = this.aggregateState(envelope);
    const storeVersion = this.filesystem.hasCanonicalStore() ? this.filesystem.list().storeVersion : envelope.storeVersion;
    return clone({ schema: 1, storeVersion, rootId: state.rootId, projects: state.projects, threads: state.threads, ganttTasks: state.ganttTasks || [], collaborationTasks: state.collaborationTasks || [], recipes: state.recipes || [], recipeFolders: state.recipeFolders || [], recipeTrash: state.recipeTrash || [] });
  }

  private aggregateState(envelope: ProjectStoreEnvelope): ProjectModelState {
    const recipes = this.recipeFilesystem.hasCanonicalStore() ? this.recipeFilesystem.list() : undefined;
    if (!this.filesystem.hasCanonicalStore()) {
      return recipes ? {
        ...clone(envelope.payload.state),
        recipes: recipes.recipes,
        recipeFolders: derivedRecipeFolders(recipes.recipes),
        recipeTrash: recipes.trash,
      } : clone(envelope.payload.state);
    }
    const canonical = this.filesystem.list();
    return {
      ...clone(envelope.payload.state),
      rootId: canonical.rootId,
      projects: canonical.projects,
      threads: canonical.threads,
      ganttTasks: canonical.ganttTasks,
      collaborationTasks: canonical.collaborationTasks,
      ...(recipes ? {
        recipes: recipes.recipes,
        recipeFolders: derivedRecipeFolders(recipes.recipes),
        recipeTrash: recipes.trash,
      } : {}),
      migrations: [],
      audit: [],
    };
  }

  private ensureCanonical(envelope: ProjectStoreEnvelope): void {
    if (this.filesystem.hasCanonicalStore() || this.options.autoMigrate === false) return;
    const source = this.migrationSource(envelope);
    const preview = this.filesystem.previewMigration(source);
    this.ensureProjectMigrationBackup(source.sourceDigest);
    this.filesystem.stageMigration(source, preview.sourceDigest);
    this.filesystem.verifyMigration(source, preview.sourceDigest);
    this.filesystem.cutoverMigration(source, preview.sourceDigest);
  }

  private ensureProjectMigrationBackup(sourceDigest: string): void {
    const directory = path.join(this.directory, "project-store-migration", "backups");
    const backupPath = path.join(directory, `${sourceDigest}.projects.json`);
    fs.mkdirSync(directory, { recursive: true });
    if (fs.existsSync(backupPath)) return;
    const content = fs.readFileSync(this.filePath);
    const descriptor = fs.openSync(backupPath, "wx", 0o400);
    try {
      fs.writeFileSync(descriptor, content);
      fs.fsyncSync(descriptor);
    } finally {
      fs.closeSync(descriptor);
    }
    fs.chmodSync(backupPath, 0o400);
    fsyncDirectory(directory);
  }

  private upgradeManagedBuiltIns(): void {
    if (!this.recipeFilesystem.hasCanonicalStore()) return;
    const builtIns = (initializeProjectModel(undefined, () => "managed").recipes || [])
      .filter(recipe => recipe.systemKind === "built-in");
    this.recipeFilesystem.replaceManagedBuiltIns(builtIns);
  }

  private migrationSource(envelope: ProjectStoreEnvelope): LegacyProjectMigrationSource {
    return {
      sourceDigest: envelope.digest,
      state: envelope.payload.state,
      storeVersion: envelope.storeVersion,
      receipts: envelope.payload.receipts.slice(-PROJECT_RECEIPT_LIMIT),
    };
  }

  private recipeMigrationSource(envelope: ProjectStoreEnvelope): RecipeMigrationSource {
    return {
      sourceDigest: envelope.digest,
      recipes: clone(envelope.payload.state.recipes || []),
      trash: clone(envelope.payload.state.recipeTrash || []),
      projects: clone(envelope.payload.state.projects || []),
      folders: clone(envelope.payload.state.recipeFolders || []),
    };
  }

  private withFilesystemErrors<T>(action: () => T): T {
    try {
      return action();
    } catch (error) {
      if (error instanceof ProjectFilesystemStoreError) throw new ProjectStoreError(error.code, error.message);
      if (error instanceof RecipeFilesystemStoreError) throw new ProjectStoreError(error.code, error.message);
      throw error;
    }
  }

  private write(envelope: ProjectStoreEnvelope): void {
    const temporary = `${this.filePath}.${process.pid}.${randomUUID()}.tmp`;
    const descriptor = fs.openSync(temporary, "wx", 0o600);
    try {
      fs.writeFileSync(descriptor, canonicalJson(envelope), "utf8");
      fs.fsyncSync(descriptor);
    } finally {
      fs.closeSync(descriptor);
    }
    fs.renameSync(temporary, this.filePath);
    fs.chmodSync(this.filePath, 0o600);
    fsyncDirectory(this.directory);
  }
}

function makeEnvelope(storeVersion: number, payload: ProjectStorePayload): ProjectStoreEnvelope {
  return { schema: PROJECT_STORE_SCHEMA, storeVersion, payload: clone(payload), digest: digest(payload) };
}

function verifyEnvelope(value: unknown, omitRecipes = false): ProjectStoreEnvelope {
  if (!isRecord(value) || value.schema !== PROJECT_STORE_SCHEMA || !Number.isSafeInteger(value.storeVersion) || Number(value.storeVersion) < 1
    || !isRecord(value.payload) || !isRecord(value.payload.state) || !Array.isArray(value.payload.receipts) || typeof value.digest !== "string") {
    fail("store-corrupt", "Project store envelope is invalid.");
  }
  const envelope = value as unknown as ProjectStoreEnvelope;
  if (digest(envelope.payload) !== envelope.digest) fail("store-corrupt", "Project store digest does not match its payload.");
  const state = omitRecipes
    ? stripLegacyRecipeState(initializeProjectModel(envelope.payload.state))
    : initializeProjectModel(envelope.payload.state);
  const {
    recipes: _migratedRecipes,
    recipeFolders: _migratedRecipeFolders,
    ganttTasks: _migratedGanttTasks,
    collaborationTasks: _migratedCollaborationTasks,
    ...stateWithoutSafeMigrations
  } = state;
  const stateBeforeSafeMigrations: Record<string, unknown> = { ...stateWithoutSafeMigrations };
  if (!omitRecipes && Object.prototype.hasOwnProperty.call(envelope.payload.state, "recipes")) {
    stateBeforeSafeMigrations.recipes = envelope.payload.state.recipes;
  }
  if (!omitRecipes && Object.prototype.hasOwnProperty.call(envelope.payload.state, "recipeFolders")) {
    stateBeforeSafeMigrations.recipeFolders = envelope.payload.state.recipeFolders;
  }
  if (Object.prototype.hasOwnProperty.call(envelope.payload.state, "ganttTasks")) {
    stateBeforeSafeMigrations.ganttTasks = envelope.payload.state.ganttTasks;
  }
  if (Object.prototype.hasOwnProperty.call(envelope.payload.state, "collaborationTasks")) {
    stateBeforeSafeMigrations.collaborationTasks = envelope.payload.state.collaborationTasks;
  }
  const persistedState = omitRecipes
    ? stripLegacyRecipeState(envelope.payload.state)
    : envelope.payload.state;
  if (canonicalJson(stateBeforeSafeMigrations) !== canonicalJson(persistedState)) fail("store-repair-required", "Project store system records require repair.");
  for (const receipt of envelope.payload.receipts) {
    if (!isRecord(receipt) || typeof receipt.commandId !== "string" || typeof receipt.fingerprint !== "string"
      || typeof receipt.operation !== "string" || !Number.isSafeInteger(receipt.storeVersion) || typeof receipt.entityId !== "string") {
      fail("store-corrupt", "Project store receipt is invalid.");
    }
  }
  return canonicalJson(state) === canonicalJson(envelope.payload.state)
    ? clone(envelope)
    : makeEnvelope(envelope.storeVersion, { state, receipts: envelope.payload.receipts });
}

function validateCommand(command: ProjectStoreCommand): void {
  if (!command || typeof command.commandId !== "string" || !command.commandId.trim() || typeof command.fingerprint !== "string" || !command.fingerprint.trim()
    || !Number.isSafeInteger(command.expectedStoreVersion) || command.expectedStoreVersion < 0) {
    fail("command-invalid", "Project command identity, fingerprint, and expected version are required.");
  }
}

function digest(payload: ProjectStorePayload): string {
  return createHash("sha256").update(canonicalJson(payload), "utf8").digest("hex");
}

function isRecipeOperation(operation: string): boolean {
  return operation.startsWith("recipe-");
}

function mergeLegacyRecipeState(
  legacy: ProjectModelState,
  changed: ProjectModelState,
): ProjectModelState {
  return clone({
    ...legacy,
    recipes: changed.recipes || [],
    recipeFolders: changed.recipeFolders || [],
    recipeTrash: changed.recipeTrash || [],
  });
}

function stripLegacyRecipeState(state: ProjectModelState): ProjectModelState {
  const {
    recipes: _recipes,
    recipeFolders: _recipeFolders,
    recipeTrash: _recipeTrash,
    ...recipeFree
  } = clone(state);
  return recipeFree;
}

function canonicalRecipeState(state: ProjectModelState): ProjectModelState {
  const projects = new Map(state.projects.map(project => [project.projectId, project.name]));
  const canonicalize = <T extends RecipeRecord>(recipe: T): T => {
    if (recipe.scope !== "project") return clone(recipe);
    const projectName = projects.get(String(recipe.projectId || ""));
    if (!projectName) fail("recipe-project-missing", "Project Recipe references a missing Project.");
    const result = {
      ...clone(recipe),
      scope: "global" as const,
      category: ["Project", safeRecipeCategorySegment(projectName), recipe.category || ""].filter(Boolean).join("/"),
    };
    delete result.projectId;
    return result;
  };
  return {
    ...state,
    recipes: (state.recipes || []).map(canonicalize),
    recipeTrash: (state.recipeTrash || []).map(recipe => ({
      ...canonicalize(recipe),
      trashedAt: recipe.trashedAt,
    })),
    recipeFolders: [],
  };
}

function derivedRecipeFolders(recipes: RecipeRecord[]): string[] {
  const result = new Set<string>();
  for (const recipe of recipes) {
    const segments = String(recipe.category || "").split("/").filter(Boolean);
    for (let depth = 1; depth <= segments.length; depth++) result.add(segments.slice(0, depth).join("/"));
  }

  return [...result].sort((left, right) => left.localeCompare(right));
}

function safeLegacyRecipeName(value: string): string {
  return String(value || "").trim().replace(/[<>:"/\\|?*\u0000-\u001f\u007f]/g, "-")
    .replace(/\s+/g, "-").replace(/-+/g, "-").replace(/^[ .-]+|[ .-]+$/g, "") || "Recipe";
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

function clone<T>(value: T): T {
  return JSON.parse(canonicalJson(value)) as T;
}

function isRecord(value: unknown): value is Record<string, any> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function fail(code: string, message: string): never {
  throw new ProjectStoreError(code, message);
}