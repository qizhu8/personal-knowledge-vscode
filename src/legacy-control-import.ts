import { createHash } from "node:crypto";
import { workspaceRootForDatabase } from "./workspace-storage-paths.js";
import { lstatSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { z } from "zod";
import { canonicalJson } from "./domain/project-recipes-workflow-contracts.js";
import { legacyKnowledgeAlias } from "./domain/knowledge-contracts.js";
import { normalizeRecipeCategory, safeRecipeFileName } from "./domain/project-recipes-storage-rules.js";
import { safeProjectDirectoryName } from "./domain/project-recipes-project-rules.js";
import { projectMutationPlanSchema } from "./project-mutations-contracts.js";
import { validateProjectRecipeExport } from "./import-parity-project.js";
import { legacyProjectCommandSchema, LEGACY_PROJECT_COMMAND_OPERATIONS } from "./legacy-project-command-contracts.js";

const digestSchema = z.string().regex(/^[a-f0-9]{64}$/);
const projectReceiptSchema = z.strictObject({
  commandId: z.string().min(1).max(4096),
  fingerprint: z.string().min(1).max(4096),
  operation: z.string().min(1).max(512),
  storeVersion: z.number().int().safe().positive(),
  entityId: z.string().min(1).max(4096),
});

export const legacyProjectMigrationSchema = z.strictObject({
  phase: z.enum(["previewed", "staged", "verified", "cutover", "rolled-back"]),
  sourceDigest: digestSchema,
  canonicalDigest: digestSchema,
  projects: z.number().int().safe().nonnegative(),
  threads: z.number().int().safe().nonnegative(),
  ganttTasks: z.number().int().safe().nonnegative(),
  collaborationTasks: z.number().int().safe().nonnegative(),
});

export const legacyProjectControlSchema = z.strictObject({
  schema: z.literal(1),
  rootId: z.string().min(1).max(4096).refine(value => !/[\u0000-\u001f\u007f]/.test(value)),
  storeVersion: z.number().int().safe().positive(),
  receipts: z.array(projectReceiptSchema).max(256),
  canonicalDigest: digestSchema,
  migration: legacyProjectMigrationSchema.optional(),
});

export const legacyRecipeMigrationSchema = z.strictObject({
  phase: z.enum(["previewed", "staged", "verified", "cutover", "rolled-back"]),
  sourceDigest: digestSchema,
  canonicalDigest: digestSchema,
  active: z.number().int().safe().nonnegative(),
  trash: z.number().int().safe().nonnegative(),
  categories: z.number().int().safe().nonnegative(),
  legacyFolders: z.number().int().safe().nonnegative(),
  projectScoped: z.number().int().safe().nonnegative(),
  collisions: z.array(z.strictObject({
    code: z.string(),
    path: z.string(),
    message: z.string(),
    recipeId: z.string().optional(),
    knowledgeId: z.string().optional(),
  })),
});

export const legacyRecipeControlSchema = z.strictObject({
  schema: z.literal(1),
  migration: legacyRecipeMigrationSchema.optional(),
});

export type LegacyProjectControl = z.infer<typeof legacyProjectControlSchema>;
export type LegacyRecipeControl = z.infer<typeof legacyRecipeControlSchema>;

export interface LegacyProjectDomain {
  rootId: string;
  storeVersion: number;
  projects: Array<Record<string, unknown>>;
  threads: Array<Record<string, unknown>>;
  ganttTasks: Array<Record<string, unknown>>;
  collaborationTasks: Array<Record<string, unknown>>;
}

export interface LegacyProjectReceipt {
  commandId: string;
  fingerprint: string;
  operation: string;
  storeVersion: number;
  entityId: string;
}

export interface ImportedProjectControl {
  rootId: string;
  storeVersion: number;
  canonicalDigest: string;
  controlBytes: Buffer;
  controlSha256: string;
  receipts: LegacyProjectReceipt[];
  control: LegacyProjectControl;
}

export interface ImportedRecipeControl {
  controlBytes: Buffer;
  controlSha256: string;
  control: LegacyRecipeControl;
}

export interface ProjectRecipeExportSummary {
  projects: Array<Record<string, unknown>>;
  threads: Array<Record<string, unknown>>;
  ganttTasks: Array<Record<string, unknown>>;
  collaborationTasks: Array<Record<string, unknown>>;
  recipes: Array<Record<string, unknown>>;
}

export class LegacyControlImportError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
  }
}

export function initializeLegacyControlSchema(database: DatabaseSync): void {
  if (!database.isTransaction) {
    throw new LegacyControlImportError("TRANSACTION_REQUIRED", "Legacy control schema must be created inside the native migration transaction.");
  }
  database.exec(`
    CREATE TABLE IF NOT EXISTS legacy_project_control(
      workspace_id TEXT PRIMARY KEY,
      root_id TEXT NOT NULL CHECK(length(root_id) BETWEEN 1 AND 4096),
      store_version INTEGER NOT NULL CHECK(store_version > 0),
      canonical_digest TEXT NOT NULL CHECK(length(canonical_digest)=64 AND canonical_digest NOT GLOB '*[^0-9a-f]*'),
      control_bytes BLOB NOT NULL CHECK(typeof(control_bytes)='blob'),
      control_sha256 TEXT NOT NULL CHECK(length(control_sha256)=64 AND control_sha256 NOT GLOB '*[^0-9a-f]*')
    );
    CREATE TABLE IF NOT EXISTS legacy_recipe_control(
      workspace_id TEXT PRIMARY KEY,
      control_bytes BLOB NOT NULL CHECK(typeof(control_bytes)='blob'),
      control_sha256 TEXT NOT NULL CHECK(length(control_sha256)=64 AND control_sha256 NOT GLOB '*[^0-9a-f]*')
    );
    CREATE TABLE IF NOT EXISTS legacy_project_receipt(
      workspace_id TEXT NOT NULL REFERENCES legacy_project_control(workspace_id) ON DELETE CASCADE,
      ordinal INTEGER NOT NULL CHECK(ordinal BETWEEN 0 AND 255),
      command_id TEXT NOT NULL CHECK(length(command_id) BETWEEN 1 AND 4096),
      fingerprint TEXT NOT NULL CHECK(length(fingerprint) BETWEEN 1 AND 4096),
      operation TEXT NOT NULL CHECK(length(operation) BETWEEN 1 AND 512),
      store_version INTEGER NOT NULL CHECK(store_version > 0),
      entity_id TEXT NOT NULL CHECK(length(entity_id) BETWEEN 1 AND 4096),
      PRIMARY KEY(workspace_id,ordinal),
      UNIQUE(workspace_id,command_id)
    ) WITHOUT ROWID;
  `);
}

const sha256 = (value: Uint8Array | string): string => createHash("sha256").update(value).digest("hex");
const byLocale = (field: string) => (left: Record<string, unknown>, right: Record<string, unknown>) =>
  String(left[field]).localeCompare(String(right[field]));

export function legacyProjectDomainDigest(domain: LegacyProjectDomain): string {
  const sorted = {
    rootId: domain.rootId,
    projects: [...domain.projects].sort(byLocale("projectId")),
    threads: [...domain.threads].sort(byLocale("threadId")),
    ganttTasks: [...domain.ganttTasks].sort(byLocale("taskId")),
    collaborationTasks: [...domain.collaborationTasks].sort(byLocale("collaborationId")),
  };
  return sha256(canonicalJson(sorted));
}

function parseControlBytes<T>(bytes: Uint8Array, schema: z.ZodType<T>, name: string): T {
  if (bytes.byteLength === 0 || bytes.byteLength > 2 * 1024 * 1024) {
    throw new LegacyControlImportError("INVALID_CONTROL", `${name} control file exceeds the supported size.`);
  }
  const buffer = Buffer.from(bytes);
  const text = buffer.toString("utf8");
  if (!Buffer.from(text, "utf8").equals(buffer)) {
    throw new LegacyControlImportError("INVALID_CONTROL", `${name} control file is not valid UTF-8.`);
  }
  let value: unknown;
  try { value = JSON.parse(text); }
  catch { throw new LegacyControlImportError("INVALID_CONTROL", `${name} control file is not valid JSON.`); }
  const parsed = schema.safeParse(value);
  if (!parsed.success) {
    throw new LegacyControlImportError("INVALID_CONTROL", `${name} control file does not match the supported schema.`);
  }
  return parsed.data;
}

function assertQuiescentProjectMigration(
  migration: LegacyProjectControl["migration"],
  domain: LegacyProjectDomain,
  canonicalDigest: string,
): void {
  if (!migration) return;
  if (!["cutover", "rolled-back"].includes(migration.phase)
    || migration.canonicalDigest !== canonicalDigest
    || migration.projects !== domain.projects.length
    || migration.threads !== domain.threads.length
    || migration.ganttTasks !== domain.ganttTasks.length
    || migration.collaborationTasks !== domain.collaborationTasks.length) {
    throw new LegacyControlImportError("UNQUIESCENT_CONTROL", "Project migration control is not a source-matched quiescent receipt.");
  }
}

export function validateLegacyDefaultProjectIdentity(
  rootId: string,
  model: Pick<ProjectRecipeExportSummary, "projects" | "threads">,
): { projectId: string; threadId: string } {
  const projectId = `project_${sha256(`pkm/default-project/v1\0${rootId}`).slice(0, 32)}`;
  const defaultProjects = model.projects.filter(project => project.systemKind === "default-project");
  if (defaultProjects.length !== 1 || defaultProjects[0]?.projectId !== projectId) {
    throw new LegacyControlImportError("INVALID_CONTROL_IDENTITY", "Existing Default Project does not match the original root identity.");
  }
  const threadId = `thread_${sha256(`pkm/general-thread/v1\0${projectId}`).slice(0, 32)}`;
  const defaultThreads = model.threads.filter(thread =>
    thread.systemKind === "general-thread" && thread.projectId === projectId);
  if (defaultThreads.length !== 1 || defaultThreads[0]?.threadId !== threadId) {
    throw new LegacyControlImportError("INVALID_CONTROL_IDENTITY", "Existing General Thread does not match the original root identity.");
  }
  return { projectId, threadId };
}

export function parseLegacyProjectControl(
  bytes: Uint8Array,
  model: ProjectRecipeExportSummary,
): ImportedProjectControl {
  const control = parseControlBytes(bytes, legacyProjectControlSchema, "Project");
  const domain: LegacyProjectDomain = {
    rootId: control.rootId,
    storeVersion: control.storeVersion,
    projects: model.projects,
    threads: model.threads,
    ganttTasks: model.ganttTasks,
    collaborationTasks: model.collaborationTasks,
  };
  const canonicalDigest = legacyProjectDomainDigest(domain);
  if (canonicalDigest !== control.canonicalDigest) {
    throw new LegacyControlImportError("INVALID_CONTROL_DIGEST", "Project control digest does not match the complete original Project tree.");
  }
  validateLegacyDefaultProjectIdentity(control.rootId, model);
  const commandIds = new Set<string>();
  let priorVersion = 0;
  for (const receipt of control.receipts) {
    if (commandIds.has(receipt.commandId) || receipt.storeVersion <= priorVersion || receipt.storeVersion > control.storeVersion) {
      throw new LegacyControlImportError("INVALID_CONTROL_RECEIPTS", "Project receipt history is duplicated, unordered, or outside the current store version.");
    }
    commandIds.add(receipt.commandId);
    priorVersion = receipt.storeVersion;
  }
  assertQuiescentProjectMigration(control.migration, domain, canonicalDigest);
  const controlBytes = Buffer.from(bytes);
  return {
    rootId: control.rootId,
    storeVersion: control.storeVersion,
    canonicalDigest,
    controlBytes,
    controlSha256: sha256(controlBytes),
    receipts: control.receipts,
    control,
  };
}

export function parseLegacyRecipeControl(
  bytes: Uint8Array,
  model: ProjectRecipeExportSummary,
): ImportedRecipeControl {
  const control = parseControlBytes(bytes, legacyRecipeControlSchema, "Recipe");
  const migration = control.migration;
  if (migration) {
    const categories = new Set<string>();
    const recipes = model.recipes.map(recipe => {
      const recipeId = String(recipe.recipeId);
      const category = normalizeRecipeCategory(recipe.category);
      categories.add(category);
      const relativePath = `${category || "Uncategorized"}/${safeRecipeFileName(String(recipe.name), recipeId)}`;
      const candidate = String(recipe.knowledgeId || "");
      const knowledgeId = /^knowledge_[a-f0-9]{24}$/.test(candidate)
        ? candidate
        : `knowledge_${sha256(`recipe\0${recipeId}`).slice(0, 24)}`;
      const aliases = [...new Set([
        ...(Array.isArray(recipe.aliases)
          ? recipe.aliases.filter((alias): alias is string => typeof alias === "string" && /^(note|skill|research|recipe):[^\u0000-\u001f]+$/.test(alias))
          : []),
        legacyKnowledgeAlias("recipe", recipeId),
        legacyKnowledgeAlias("recipe", relativePath),
      ])].sort();
      const stored: Record<string, unknown> = {
        ...recipe,
        schema: "pkm.knowledge/v1",
        knowledgeId,
        aliases,
        scope: "global",
        ...(category ? { category } : {}),
      };
      delete stored.projectId;
      if (!category) delete stored.category;
      return stored;
    }).sort(byLocale("recipeId"));
    const currentDigest = sha256(canonicalJson({ recipes, trash: [] }));
    if (!["cutover", "rolled-back"].includes(migration.phase)
      || migration.trash !== 0 || migration.collisions.length !== 0
      || migration.active !== model.recipes.length || migration.categories !== categories.size
      || migration.canonicalDigest !== currentDigest) {
      throw new LegacyControlImportError("UNQUIESCENT_CONTROL", "Recipe migration control is not a source-matched quiescent receipt.");
    }
  }
  const controlBytes = Buffer.from(bytes);
  return { controlBytes, controlSha256: sha256(controlBytes), control };
}

export function insertLegacyControlSnapshot(
  database: DatabaseSync,
  workspaceId: string,
  project: ImportedProjectControl | undefined,
  recipe: ImportedRecipeControl | undefined,
): void {
  if (!database.isTransaction) throw new Error("Legacy controls must be inserted inside the workspace transaction.");
  if (project) {
    database.prepare(`INSERT INTO legacy_project_control
      (workspace_id,root_id,store_version,canonical_digest,control_bytes,control_sha256)
      VALUES(?,?,?,?,?,?)`)
      .run(workspaceId, project.rootId, project.storeVersion, project.canonicalDigest, project.controlBytes, project.controlSha256);
    const insertReceipt = database.prepare(`INSERT INTO legacy_project_receipt
      (workspace_id,ordinal,command_id,fingerprint,operation,store_version,entity_id)
      VALUES(?,?,?,?,?,?,?)`);
    project.receipts.forEach((receipt, ordinal) => insertReceipt.run(
      workspaceId, ordinal, receipt.commandId, receipt.fingerprint, receipt.operation, receipt.storeVersion, receipt.entityId));
  }
  if (recipe) {
    database.prepare(`INSERT INTO legacy_recipe_control
      (workspace_id,control_bytes,control_sha256) VALUES(?,?,?)`)
      .run(workspaceId, recipe.controlBytes, recipe.controlSha256);
  }
}

export interface StoredLegacyProjectControl {
  rootId: string;
  storeVersion: number;
  canonicalDigest: string;
  controlBytes: Buffer;
  controlSha256: string;
  importedControl: LegacyProjectControl;
  receipts: Array<LegacyProjectReceipt & { ordinal: number }>;
}

export function readLegacyProjectControl(database: DatabaseSync, workspaceId: string): StoredLegacyProjectControl | undefined {
  const row = database.prepare(`SELECT root_id,store_version,canonical_digest,control_bytes,control_sha256
    FROM legacy_project_control WHERE workspace_id=?`).get(workspaceId) as
    | { root_id: string; store_version: number; canonical_digest: string; control_bytes: Uint8Array; control_sha256: string }
    | undefined;
  if (!row) return undefined;
  const controlBytes = Buffer.from(row.control_bytes);
  if (sha256(controlBytes) !== row.control_sha256) {
    throw new LegacyControlImportError("CONTROL_STORAGE_CORRUPT", "Stored original Project control bytes failed their SHA256 pin.");
  }
  const importedControl = parseControlBytes(controlBytes, legacyProjectControlSchema, "Project");
  if (importedControl.rootId !== row.root_id || !Number.isSafeInteger(row.store_version) || row.store_version < importedControl.storeVersion
    || !digestSchema.safeParse(row.canonical_digest).success) {
    throw new LegacyControlImportError("CONTROL_STORAGE_CORRUPT", "Stored Project control metadata is inconsistent.");
  }
  const receipts = database.prepare(`SELECT ordinal,command_id,fingerprint,operation,store_version,entity_id
    FROM legacy_project_receipt WHERE workspace_id=? ORDER BY ordinal`).all(workspaceId) as
    Array<{ ordinal: number; command_id: string; fingerprint: string; operation: string; store_version: number; entity_id: string }>;
  const commandIds = new Set<string>();
  let priorVersion = 0;
  if (!Number.isSafeInteger(row.store_version) || receipts.length > 256
    || receipts.some((receipt, index) => {
      if (receipt.ordinal !== index || commandIds.has(receipt.command_id)
        || receipt.store_version <= priorVersion || receipt.store_version > row.store_version) return true;
      commandIds.add(receipt.command_id);
      priorVersion = receipt.store_version;
      return false;
    })) {
    throw new LegacyControlImportError("CONTROL_STORAGE_CORRUPT", "Stored Project command receipt ordering is invalid.");
  }
  return {
    rootId: row.root_id,
    storeVersion: row.store_version,
    canonicalDigest: row.canonical_digest,
    controlBytes,
    controlSha256: row.control_sha256,
    importedControl,
    receipts: receipts.map(receipt => ({
      ordinal: receipt.ordinal,
      commandId: receipt.command_id,
      fingerprint: receipt.fingerprint,
      operation: receipt.operation,
      storeVersion: receipt.store_version,
      entityId: receipt.entity_id,
    })),
  };
}

export function readLegacyRecipeControl(database: DatabaseSync, workspaceId: string): ImportedRecipeControl | undefined {
  const row = database.prepare(`SELECT control_bytes,control_sha256 FROM legacy_recipe_control WHERE workspace_id=?`)
    .get(workspaceId) as { control_bytes: Uint8Array; control_sha256: string } | undefined;
  if (!row) return undefined;
  const controlBytes = Buffer.from(row.control_bytes);
  if (sha256(controlBytes) !== row.control_sha256) {
    throw new LegacyControlImportError("CONTROL_STORAGE_CORRUPT", "Stored original Recipe control bytes failed their SHA256 pin.");
  }
  const control = parseControlBytes(controlBytes, legacyRecipeControlSchema, "Recipe");
  return { controlBytes, controlSha256: row.control_sha256, control };
}

function workspaceRoot(database: DatabaseSync): string {
  const rows = database.prepare("PRAGMA database_list").all() as Array<{ name: string; file: string }>;
  const main = rows.find(row => row.name === "main");
  if (!main?.file) throw new LegacyControlImportError("CONTROL_STORAGE_CORRUPT", "Workspace database has no stable file path.");
  return workspaceRootForDatabase(main.file);
}

function projectRecipeEntries(root: string): Array<{ source: string; kind: string; size?: number }> {
  const entries: Array<{ source: string; kind: string; size?: number }> = [];
  function walk(directory: string, relativePath: string, depth: number): void {
    if (depth > 32 || entries.length > 20_000) {
      throw new LegacyControlImportError("CONTROL_STORAGE_CORRUPT", "Project/Recipe workspace exceeds recovery inspection limits.");
    }
    let names: string[];
    try { names = readdirSync(directory).sort(); }
    catch { throw new LegacyControlImportError("CONTROL_STORAGE_CORRUPT", "Project/Recipe workspace cannot be inspected safely."); }
    for (const name of names) {
      const path = relativePath ? `${relativePath}/${name}` : name;
      const full = join(root, ...path.split("/"));
      let stat;
      try { stat = lstatSync(full); }
      catch { throw new LegacyControlImportError("CONTROL_STORAGE_CORRUPT", "Project/Recipe entry changed during recovery inspection."); }
      if (stat.isSymbolicLink() || (!stat.isDirectory() && !stat.isFile())) {
        throw new LegacyControlImportError("CONTROL_STORAGE_CORRUPT", "Project/Recipe recovery does not follow links or special files.");
      }
      entries.push({ source: path, kind: stat.isDirectory() ? "directory" : "unsupported", ...(stat.isFile() ? { size: stat.size } : {}) });
      if (stat.isDirectory()) walk(full, path, depth + 1);
    }
  }
  for (const area of ["project", "recipes"]) {
    const full = join(root, area);
    try {
      const stat = lstatSync(full);
      if (stat.isSymbolicLink() || !stat.isDirectory()) {
        throw new LegacyControlImportError("CONTROL_STORAGE_CORRUPT", "Project/Recipe root is not a real directory.");
      }
      entries.push({ source: area, kind: "directory" });
      walk(full, area, 1);
    } catch (error) {
      if (error instanceof LegacyControlImportError) throw error;
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        throw new LegacyControlImportError("CONTROL_STORAGE_CORRUPT", "Project/Recipe root cannot be inspected safely.");
      }
    }
  }
  return entries;
}

export function readCurrentLegacyProjectSnapshot(database: DatabaseSync, workspaceId: string): LegacyProjectDomain {
  const control = readLegacyProjectControl(database, workspaceId);
  if (!control) throw new LegacyControlImportError("LEGACY_CONTROL_MISSING", "Workspace has no imported original Project control.");
  const root = workspaceRoot(database);
  let model: ProjectRecipeExportSummary;
  try { model = validateProjectRecipeExport(root, projectRecipeEntries(root)); }
  catch { throw new LegacyControlImportError("CONTROL_STORAGE_CORRUPT", "Project/Recipe workspace failed canonical snapshot inspection."); }
  validateLegacyDefaultProjectIdentity(control.rootId, model);
  return {
    rootId: control.rootId,
    storeVersion: control.storeVersion,
    projects: model.projects,
    threads: model.threads,
    ganttTasks: model.ganttTasks,
    collaborationTasks: model.collaborationTasks,
  };
}

function readWorkspaceProjectFile(root: string, relativePath: string): Buffer {
  const full = join(root, ...relativePath.split("/"));
  let before;
  try { before = lstatSync(full); }
  catch { throw new LegacyControlImportError("CONTROL_STORAGE_CORRUPT", "Pending Project mutation file is unavailable."); }
  if (!before.isFile() || before.isSymbolicLink()) {
    throw new LegacyControlImportError("CONTROL_STORAGE_CORRUPT", "Pending Project mutation file is not a regular file.");
  }
  let bytes: Buffer;
  try { bytes = readFileSync(full); }
  catch { throw new LegacyControlImportError("CONTROL_STORAGE_CORRUPT", "Pending Project mutation file cannot be read safely."); }
  const after = lstatSync(full);
  if (!after.isFile() || after.isSymbolicLink() || after.dev !== before.dev || after.ino !== before.ino || after.size !== before.size
    || bytes.length !== before.size) {
    throw new LegacyControlImportError("CONTROL_STORAGE_CORRUPT", "Pending Project mutation file changed during inspection.");
  }
  return bytes;
}

function inspectPendingLegacyProjectCommand(
  database: DatabaseSync,
  workspaceId: string,
  control: StoredLegacyProjectControl,
  current: LegacyProjectDomain,
): boolean {
  const rows = database.prepare(`SELECT singleton,operation_id,fingerprint,actor_id,operation,plan,legacy_command
    FROM pending_project_mutation`).all() as Array<{
      singleton: number; operation_id: string; fingerprint: string; actor_id: string;
      operation: string; plan: string; legacy_command: string | null;
    }>;
  if (!rows.length) return false;
  if (rows.length !== 1) throw new LegacyControlImportError("CONTROL_RECOVERY_CONFLICT", "Multiple pending Project mutations require native reconciliation.");
  const pending = rows[0]!;
  if (pending.singleton !== 1 || pending.operation !== "project.legacy.command" || pending.legacy_command === null
    || !/^[a-f0-9]{64}$/.test(pending.fingerprint)) {
    throw new LegacyControlImportError("CONTROL_RECOVERY_CONFLICT", "Unrecognized Project intent cannot cross an imported original control.");
  }
  let commandValue: unknown, planValue: unknown;
  try {
    commandValue = JSON.parse(pending.legacy_command);
    planValue = JSON.parse(pending.plan);
  } catch {
    throw new LegacyControlImportError("CONTROL_RECOVERY_CONFLICT", "Pending legacy Project command or mutation plan is invalid JSON.");
  }
  const command = legacyProjectCommandSchema.safeParse(commandValue);
  const plan = projectMutationPlanSchema.safeParse(planValue);
  if (!command.success || canonicalJson(command.data) !== pending.legacy_command
    || !(LEGACY_PROJECT_COMMAND_OPERATIONS as readonly string[]).includes(command.data.operation)
    || command.data.expectedStoreVersion !== control.storeVersion
    || control.receipts.some(receipt => receipt.commandId === command.data.commandId)
    || !plan.success || plan.data.operation !== "project.update"
    || plan.data.operationId !== pending.operation_id || plan.data.actorId !== pending.actor_id
    || plan.data.workspaceId !== workspaceId || plan.data.result.operation !== "project.update"
    || plan.data.result.operationId !== pending.operation_id || plan.data.result.entityKind !== "project"
    || plan.data.result.entityId !== plan.data.result.item.projectId || plan.data.files.length !== 1) {
    throw new LegacyControlImportError("CONTROL_RECOVERY_CONFLICT", "Pending legacy Project command does not match the supported mutation plan.");
  }
  const file = plan.data.files[0]!;
  const resultItem = plan.data.result.item;
  if (!("projectId" in resultItem) || typeof resultItem.projectId !== "string" || typeof resultItem.name !== "string") {
    throw new LegacyControlImportError("CONTROL_RECOVERY_CONFLICT", "Pending Project plan result has no Project identity.");
  }
  const projectId = resultItem.projectId;
  const relativePath = `project/${safeProjectDirectoryName(resultItem.name, projectId)}/project.json`;
  if (file.relativePath !== relativePath || file.beforeBase64 === null || file.beforeSha256 === null
    || file.afterBase64 === null || file.afterSha256 === null) {
    throw new LegacyControlImportError("CONTROL_RECOVERY_CONFLICT", "Pending Project mutation does not target one canonical existing Project record.");
  }
  const beforeBytes = Buffer.from(file.beforeBase64, "base64");
  const afterBytes = Buffer.from(file.afterBase64, "base64");
  if (beforeBytes.toString("base64") !== file.beforeBase64 || afterBytes.toString("base64") !== file.afterBase64
    || sha256(beforeBytes) !== file.beforeSha256 || sha256(afterBytes) !== file.afterSha256) {
    throw new LegacyControlImportError("CONTROL_RECOVERY_CONFLICT", "Pending Project before/after bytes do not match their durable pins.");
  }
  let beforeRecord: Record<string, unknown>, afterRecord: Record<string, unknown>;
  try {
    beforeRecord = JSON.parse(beforeBytes.toString("utf8"));
    afterRecord = JSON.parse(afterBytes.toString("utf8"));
  } catch {
    throw new LegacyControlImportError("CONTROL_RECOVERY_CONFLICT", "Pending Project record bytes are invalid JSON.");
  }
  if (canonicalJson(afterRecord) !== canonicalJson(resultItem)
    || beforeRecord.projectId !== resultItem.projectId
    || afterRecord.projectId !== resultItem.projectId) {
    throw new LegacyControlImportError("CONTROL_RECOVERY_CONFLICT", "Pending Project plan result does not match its exact after-bytes.");
  }
  const currentBytes = readWorkspaceProjectFile(workspaceRoot(database), file.relativePath);
  const currentHash = sha256(currentBytes);
  if (currentHash !== file.beforeSha256 && currentHash !== file.afterSha256) {
    throw new LegacyControlImportError("CONTROL_RECOVERY_CONFLICT", "Current Project record matches neither side of the recognized intent.");
  }
  const beforeDomain: LegacyProjectDomain = {
    ...current,
    projects: current.projects.map(project => project.projectId === resultItem.projectId ? beforeRecord : project),
  };
  if (legacyProjectDomainDigest(beforeDomain) !== control.canonicalDigest) {
    throw new LegacyControlImportError("CONTROL_RECOVERY_CONFLICT", "Pending Project intent does not project back to the stored canonical before-state.");
  }
  return true;
}

export function inspectLegacyControlRecovery(database: DatabaseSync, workspaceId: string): void {
  const foreignControls = database.prepare(`SELECT
    (SELECT COUNT(*) FROM legacy_project_control WHERE workspace_id<>?) +
    (SELECT COUNT(*) FROM legacy_recipe_control WHERE workspace_id<>?) +
    (SELECT COUNT(*) FROM legacy_project_receipt WHERE workspace_id<>?) AS count`).get(workspaceId, workspaceId, workspaceId) as { count: number };
  const orphanReceipts = database.prepare(`SELECT 1 FROM legacy_project_receipt r
    LEFT JOIN legacy_project_control c ON c.workspace_id=r.workspace_id
    WHERE c.workspace_id IS NULL LIMIT 1`).get();
  if (Number(foreignControls.count) !== 0 || orphanReceipts) {
    throw new LegacyControlImportError("CONTROL_STORAGE_CORRUPT", "Legacy control or receipt rows are foreign to this workspace or orphaned.");
  }
  const projectControl = readLegacyProjectControl(database, workspaceId);
  const recipeControl = readLegacyRecipeControl(database, workspaceId);
  if (!projectControl && !recipeControl) return;
  const root = workspaceRoot(database);
  try { validateProjectRecipeExport(root, projectRecipeEntries(root)); }
  catch (error) { throw new LegacyControlImportError("CONTROL_STORAGE_CORRUPT",
    `Project/Recipe workspace failed canonical recovery inspection: ${error instanceof Error ? error.message : "unknown validator failure"}`); }
  if (projectControl) {
    const imported = parseControlBytes(projectControl.controlBytes, legacyProjectControlSchema, "Project");
    const current = readCurrentLegacyProjectSnapshot(database, workspaceId);
    if (imported.rootId !== projectControl.rootId) {
      throw new LegacyControlImportError("CONTROL_STORAGE_CORRUPT", "Original Project root identity changed.");
    }
    const pending = inspectPendingLegacyProjectCommand(database, workspaceId, projectControl, current);
    if (!pending && legacyProjectDomainDigest(current) !== projectControl.canonicalDigest) {
      throw new LegacyControlImportError("CONTROL_STORAGE_CORRUPT", "Current Project tree does not match the durable original control digest.");
    }
  }
  if (recipeControl) {
    try { parseControlBytes(recipeControl.controlBytes, legacyRecipeControlSchema, "Recipe"); }
    catch { throw new LegacyControlImportError("CONTROL_STORAGE_CORRUPT", "Current Recipe tree does not match its durable original control."); }
  }
}

export function legacyControlSha256(bytes: Uint8Array | string): string {
  return sha256(bytes);
}
