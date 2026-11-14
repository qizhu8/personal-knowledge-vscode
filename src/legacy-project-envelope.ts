import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import type { DatabaseSync } from "node:sqlite";
import {
  lstat, mkdir, open, readFile, readdir, realpath, rm, writeFile,
} from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { z } from "zod";
import {
  legacyProjectDomainDigest, parseLegacyProjectControl, validateLegacyDefaultProjectIdentity,
  type LegacyProjectReceipt, type ProjectRecipeExportSummary,
} from "./legacy-control-import.js";
import { legacyProjectEnvelopeAdoptionDdl } from "./domain/legacy-project-envelope-provenance.js";
import {
  legacyKnowledgeAlias,
} from "./domain/knowledge-contracts.js";
import {
  normalizeRecipeCategory, safeRecipeCategorySegment, safeRecipeFileName, validateRecipeRecord,
} from "./domain/project-recipes-storage-rules.js";
import { safeProjectDirectoryName } from "./domain/project-recipes-project-rules.js";
import {
  projectCollaborationTaskSchema, projectGanttTaskSchema, projectRecordSchema, projectThreadSchema,
} from "./project-recipes-contracts.js";
import { canonicalJson } from "./domain/project-recipes-workflow-contracts.js";
import { inspectLegacyUiBootstrapCompatibility, type LegacyUiBootstrapCompatibility } from "./legacy-ui-bootstrap-compatibility.js";

const MAX_SOURCE_BYTES = 16 * 1024 * 1024;
const MAX_PROJECTION_FILE_BYTES = 2 * 1024 * 1024;
const MAX_PROJECTION_TOTAL_BYTES = 64 * 1024 * 1024;
const MAX_ENTRIES = 20_000;
const MAX_DEPTH = 32;
const sha256Pattern = /^[a-f0-9]{64}$/;
const receiptSchema = z.strictObject({
  commandId: z.string().min(1).max(4096),
  fingerprint: z.string().min(1).max(4096),
  operation: z.string().min(1).max(512),
  storeVersion: z.number().int().safe().positive(),
  entityId: z.string().min(1).max(4096),
});
const rawEnvelopeSchema = z.object({
  schema: z.literal(1),
  storeVersion: z.number().int().safe().positive(),
  payload: z.object({
    state: z.record(z.string(), z.unknown()),
    receipts: z.array(receiptSchema).max(256),
  }).passthrough(),
  digest: z.string().regex(sha256Pattern),
}).passthrough();
const projectStateSchema = z.object({
  schema: z.literal(1),
  rootId: z.string().min(1).max(4096).refine(value => !/[\u0000-\u001f\u007f]/.test(value)),
  projects: z.array(projectRecordSchema).max(4096),
  threads: z.array(projectThreadSchema).max(8192),
  ganttTasks: z.array(projectGanttTaskSchema).max(8192),
  collaborationTasks: z.array(projectCollaborationTaskSchema).max(8192),
  recipes: z.array(z.record(z.string(), z.unknown())).max(4096),
  recipeFolders: z.array(z.string()).max(8192),
  recipeTrash: z.array(z.record(z.string(), z.unknown())).max(4096),
  migrations: z.array(z.unknown()).max(8192),
  audit: z.array(z.unknown()).max(8192),
}).passthrough();

export interface LegacyProjectEnvelopeProjectionFile {
  path: string;
  kind: "project" | "recipe" | "control";
  base64: string;
  sha256: string;
}

export interface LegacyProjectEnvelopePlan {
  schema: "pkm.legacy-project-envelope-plan/v1";
  sourceRoot: string;
  sourcePath: ".pkm/state/projects.json";
  sourceStat: { dev: string; ino: string; size: number; mtimeNs: string; ctimeNs: string };
  sourceSha256: string;
  payloadSha256: string;
  rootId: string;
  storeVersion: number;
  projectControlBase64: string;
  projectControlSha256: string;
  projectionFiles: LegacyProjectEnvelopeProjectionFile[];
  projectionSha256: string;
  orderedReceipts: LegacyProjectReceipt[];
  counts: { projects: number; threads: number; ganttTasks: number; collaborationTasks: number; recipes: number };
  planSha256: string;
  uiBootstrap?: LegacyUiBootstrapCompatibility;
}

export interface LegacyProjectEnvelopeStageReceipt {
  schema: "pkm.legacy-project-envelope-stage-receipt/v1";
  stageId: string;
  planSha256: string;
  sourceSha256: string;
  sourceBytes: number;
  payloadSha256: string;
  projectionSha256: string;
  projectControlSha256: string;
  rootId: string;
  storeVersion: number;
  counts: LegacyProjectEnvelopePlan["counts"];
  orderedReceipts: LegacyProjectReceipt[];
  opaqueSourcePath: "original-projects.json";
  adoptionDdl: string;
}

export interface LegacyProjectEnvelopeAdoptionReceipt {
  schema: "pkm.legacy-project-envelope-adoption/v1";
  workspaceId: string;
  stageId: string;
  sourcePath: ".pkm/state/projects.json";
  sourceSha256: string;
  sourceBytes: number;
  payloadSha256: string;
  projectionSha256: string;
  rootId: string;
  storeVersion: number;
  projectControlSha256: string;
  orderedReceiptSha256: string;
  counts: LegacyProjectEnvelopePlan["counts"];
}

export interface LegacyProjectEnvelopeAdoptionPayload {
  receipt: LegacyProjectEnvelopeAdoptionReceipt;
  sourceBytes: Buffer;
  projectControlBytes: Buffer;
}

export class LegacyProjectEnvelopeError extends Error {
  constructor(readonly code: string, message: string) { super(message); }
}

const sha256 = (value: Uint8Array | string): string => createHash("sha256").update(value).digest("hex");
const portableKey = (path: string): string => path.normalize("NFC").toLocaleLowerCase("en-US");

function fail(code: string, message: string): never {
  throw new LegacyProjectEnvelopeError(code, message);
}

function exactJson(value: unknown): Buffer {
  return Buffer.from(`${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function planDigest(plan: Omit<LegacyProjectEnvelopePlan, "planSha256">): string {
  return sha256(canonicalJson(plan));
}

async function assertRealDirectory(path: string): Promise<string> {
  if (!isAbsolute(path)) fail("UNSAFE_PATH", "Provide an absolute disposable source or stage path.");
  const absolute = resolve(path);
  let current: string = sep;
  for (const part of absolute.slice(sep.length).split(sep).filter(Boolean)) {
    current = join(current, part);
    let stat;
    try { stat = await lstat(current); }
    catch { fail("UNSAFE_PATH", "Source and stage parents must already exist as real directories."); }
    if (stat.isSymbolicLink() || !stat.isDirectory()) fail("UNSAFE_PATH", "Source and stage paths cannot contain symlink or non-directory components.");
  }
  if (await realpath(absolute) !== absolute) fail("UNSAFE_PATH", "Source and stage paths cannot resolve through aliases.");
  return absolute;
}

async function readStableFile(root: string, relativePath: string): Promise<{ bytes: Buffer; stat: LegacyProjectEnvelopePlan["sourceStat"] }> {
  const path = join(root, ...relativePath.split("/"));
  let before;
  try { before = await lstat(path, { bigint: true }); }
  catch { fail("SOURCE_INVALID", "Original projects.json is missing."); }
  if (!before.isFile() || before.isSymbolicLink() || before.size > BigInt(MAX_SOURCE_BYTES)) {
    fail("SOURCE_INVALID", "Original projects.json must be a bounded regular file.");
  }
  const handle = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0));
  try {
    const opened = await handle.stat({ bigint: true });
    if (!opened.isFile() || opened.dev !== before.dev || opened.ino !== before.ino || opened.size !== before.size) {
      fail("SOURCE_CHANGED", "Original projects.json changed before it could be read.");
    }
    const bytes = await handle.readFile();
    const after = await handle.stat({ bigint: true });
    const pathAfter = await lstat(path, { bigint: true });
    if (bytes.length !== Number(before.size) || after.dev !== opened.dev || after.ino !== opened.ino
      || after.size !== opened.size || after.mtimeNs !== opened.mtimeNs || after.ctimeNs !== opened.ctimeNs
      || pathAfter.isSymbolicLink() || pathAfter.dev !== opened.dev || pathAfter.ino !== opened.ino) {
      fail("SOURCE_CHANGED", "Original projects.json changed while it was being read.");
    }
    return {
      bytes,
      stat: {
        dev: String(before.dev), ino: String(before.ino), size: Number(before.size),
        mtimeNs: String(before.mtimeNs), ctimeNs: String(before.ctimeNs),
      },
    };
  } finally {
    await handle.close();
  }
}

async function assertNoProjectMigrationState(root: string): Promise<void> {
  const stateDirectory = join(root, ".pkm", "state");
  let names: string[];
  try { names = await readdir(stateDirectory); }
  catch { fail("SOURCE_INVALID", "Original Project state directory is unavailable."); }
  let reconciled: LegacyUiBootstrapCompatibility | undefined;
  if (names.includes("project-store-migration")) {
    try { reconciled = inspectLegacyUiBootstrapCompatibility(root); }
    catch { fail("MIGRATION_MARKER", "Original Project cutover, source, backup, canonical tree or pending state cannot be reconciled."); }
  }
  for (const name of names) {
    if (name === "projects.json") continue;
    if (name === "project-store.json" || name === "recipe-store.json") {
      if (reconciled && name === "project-store.json") continue;
      fail("AMBIGUOUS_STORE", "A canonical Project/Recipe control coexists with projects.json.");
    }
    if (name === "project-store-intent.json" || name === "projects.lock" || name.startsWith("projects.lock.")) {
      fail("PENDING_INTENT", "A Project intent or lock must be resolved by the original writer before migration.");
    }
    if (name === "project-store-migration" || name === "recipe-store-migration") {
      if (reconciled && name === "project-store-migration") continue;
      fail("MIGRATION_MARKER", "An original Project/Recipe migration marker requires explicit reconciliation.");
    }
  }
}

function addProjectionFile(
  files: LegacyProjectEnvelopeProjectionFile[],
  seenPaths: Set<string>,
  path: string,
  kind: LegacyProjectEnvelopeProjectionFile["kind"],
  bytes: Buffer,
): void {
  if (bytes.length > MAX_PROJECTION_FILE_BYTES) {
    fail("RESOURCE_LIMIT", `Projected Project/Recipe file exceeds the canonical import limit: ${path}`);
  }
  const portable = portableKey(path);
  if (seenPaths.has(portable)) fail("DUPLICATE_PATH", `Projection paths collide: ${path}`);
  seenPaths.add(portable);
  files.push({ path, kind, base64: bytes.toString("base64"), sha256: sha256(bytes) });
}

function uniqueIds<T extends Record<string, unknown>>(records: T[], field: string, label: string): void {
  const ids = new Set<string>();
  for (const record of records) {
    const id = record[field];
    if (typeof id !== "string" || ids.has(id)) fail("DUPLICATE_IDENTITY", `${label} identity is missing or duplicated.`);
    ids.add(id);
  }
}

const recipeFields = new Set([
  "schema", "knowledgeId", "aliases", "recipeId", "trashedAt", "scope", "projectId", "category",
  "systemKind", "name", "description", "methodology", "methodologyDigest", "metadata", "editorLayout",
  "definition", "nodeBindings", "executableDigest", "revision", "origin",
]);

function projectRecipeRecords(
  state: z.infer<typeof projectStateSchema>,
  projects: Array<z.infer<typeof projectRecordSchema>>,
): Array<{ path: string; record: Record<string, unknown> }> {
  if (state.recipeTrash.length) {
    fail("UNSUPPORTED_RECIPE_TRASH", "Non-empty original Recipe trash requires the separately authorized trash-import path.");
  }
  const projectNames = new Map(projects.map(project => [project.projectId, project.name]));
  const projected = state.recipes.map(raw => {
    for (const key of Object.keys(raw)) {
      if (!recipeFields.has(key)) fail("UNSUPPORTED_RECIPE_METADATA", `Unrecognized Recipe record field: ${key}`);
    }
    const recipe = structuredClone(raw) as Record<string, unknown>;
    const recipeId = recipe.recipeId;
    const name = recipe.name;
    if (typeof recipeId !== "string" || typeof name !== "string") {
      fail("INVALID_RECIPE", "Original Recipe identity or name is missing.");
    }
    if (recipe.scope === "project") {
      const projectId = recipe.projectId;
      const projectName = typeof projectId === "string" ? projectNames.get(projectId) : undefined;
      if (!projectName) fail("INVALID_RECIPE_SCOPE", `Project-scoped Recipe has no original owner: ${recipeId}`);
      const subcategory = normalizeRecipeCategory(recipe.category);
      recipe.category = normalizeRecipeCategory([
        "Project", safeRecipeCategorySegment(projectName), subcategory,
      ].filter(Boolean).join("/"));
      recipe.scope = "global";
      delete recipe.projectId;
    } else if (recipe.scope === "global") {
      recipe.category = normalizeRecipeCategory(recipe.category);
      delete recipe.projectId;
    } else fail("INVALID_RECIPE_SCOPE", `Unknown original Recipe scope: ${recipeId}`);
    if (recipe.trashedAt !== undefined) fail("UNSUPPORTED_RECIPE_TRASH", "A trashed Recipe cannot be projected as an active Recipe.");
    try { validateRecipeRecord(recipe as never); }
    catch { fail("INVALID_RECIPE", `Original Recipe failed captured workflow validation: ${recipeId}`); }

    const knowledgeCandidate = recipe.knowledgeId;
    const knowledgeId = typeof knowledgeCandidate === "string" && /^knowledge_[a-f0-9]{24}$/.test(knowledgeCandidate)
      ? knowledgeCandidate
      : `knowledge_${sha256(`recipe\0${recipeId}`).slice(0, 24)}`;
    const category = String(recipe.category || "");
    const fileName = safeRecipeFileName(name, recipeId);
    const relativePath = `recipes/${category ? `${category}/` : "Uncategorized/"}${fileName}`;
    const aliases = Array.isArray(recipe.aliases)
      ? recipe.aliases.filter((alias): alias is string =>
        typeof alias === "string" && /^(note|skill|research|recipe):[^\u0000-\u001f]+$/.test(alias))
      : [];
    const stored: Record<string, unknown> = {
      ...recipe,
      schema: "pkm.knowledge/v1",
      knowledgeId,
      aliases: [...new Set([
        ...aliases,
        legacyKnowledgeAlias("recipe", recipeId),
        legacyKnowledgeAlias("recipe", relativePath.slice("recipes/".length)),
      ])].sort(),
      scope: "global",
    };
    if (!category) delete stored.category;
    return { path: relativePath, record: stored };
  });
  uniqueIds(projected.map(item => item.record), "recipeId", "Recipe");
  uniqueIds(projected.map(item => item.record), "knowledgeId", "Recipe Knowledge");

  const derivedFolders = new Set<string>();
  for (const { record } of projected) {
    const segments = String(record.category || "").split("/").filter(Boolean);
    for (let depth = 1; depth <= segments.length; depth++) derivedFolders.add(segments.slice(0, depth).join("/"));
  }
  for (const folder of state.recipeFolders) {
    let normalized: string;
    try { normalized = normalizeRecipeCategory(folder); }
    catch { fail("UNSUPPORTED_RECIPE_FOLDER", "Original Recipe folder is not a portable category."); }
    if (!normalized || !derivedFolders.has(normalized)) {
      fail("UNSUPPORTED_RECIPE_FOLDER", `Original empty or non-derived Recipe folder is not representable: ${folder}`);
    }
  }
  return projected;
}

function buildPlan(root: string, sourceStat: LegacyProjectEnvelopePlan["sourceStat"], bytes: Buffer): LegacyProjectEnvelopePlan {
  const text = bytes.toString("utf8");
  if (!Buffer.from(text, "utf8").equals(bytes)) fail("INVALID_ENVELOPE", "Original projects.json is not valid UTF-8.");
  let value: unknown;
  try { value = JSON.parse(text); }
  catch { fail("INVALID_ENVELOPE", "Original projects.json is not valid JSON."); }
  const parsedEnvelope = rawEnvelopeSchema.safeParse(value);
  if (!parsedEnvelope.success) fail("UNSUPPORTED_FORMAT", "Only the original ProjectStore envelope schema version 1 is supported.");
  const envelope = parsedEnvelope.data;
  const payloadSha256 = sha256(canonicalJson(envelope.payload));
  if (payloadSha256 !== envelope.digest) fail("INVALID_DIGEST", "Original ProjectStore payload digest is ambiguous or invalid.");
  const parsedState = projectStateSchema.safeParse(envelope.payload.state);
  if (!parsedState.success) fail("INVALID_STATE", "Original ProjectStore state is incomplete or contains invalid Project/Recipe data.");
  const state = parsedState.data;
  const projectIds = new Set<string>();
  const threadIds = new Set<string>();
  const taskIds = new Set<string>();
  uniqueIds(state.projects, "projectId", "Project");
  uniqueIds(state.threads, "threadId", "Thread");
  uniqueIds(state.ganttTasks, "taskId", "Gantt task");
  uniqueIds(state.collaborationTasks, "collaborationId", "Collaboration task");
  for (const item of state.projects) projectIds.add(item.projectId);
  for (const item of state.threads) {
    threadIds.add(item.threadId);
    if (!projectIds.has(item.projectId)) fail("INVALID_RELATION", `Thread owner Project is missing: ${item.threadId}`);
  }
  for (const item of state.ganttTasks) {
    taskIds.add(item.taskId);
    if (!projectIds.has(item.projectId) || (item.threadId && !threadIds.has(item.threadId))) {
      fail("INVALID_RELATION", `Gantt task Project or Thread is missing: ${item.taskId}`);
    }
  }
  for (const item of state.collaborationTasks) {
    if (!projectIds.has(item.projectId) || !threadIds.has(item.threadId)
      || (item.ganttTaskId && !taskIds.has(item.ganttTaskId))) {
      fail("INVALID_RELATION", `Collaboration task references a missing native identity: ${item.collaborationId}`);
    }
  }
  try { validateLegacyDefaultProjectIdentity(state.rootId, { projects: state.projects, threads: state.threads }); }
  catch { fail("MISSING_DEFAULT_GENERAL", "Original root does not contain its exact Default Project and General Thread identities."); }

  const receipts = envelope.payload.receipts as LegacyProjectReceipt[];
  const commandIds = new Set<string>();
  let priorVersion = 0;
  for (const receipt of receipts) {
    if (commandIds.has(receipt.commandId) || receipt.storeVersion <= priorVersion
      || receipt.storeVersion > envelope.storeVersion) {
      fail("INVALID_RECEIPTS", "Original Project receipt sequence is duplicated, unordered, or outside the current store version.");
    }
    commandIds.add(receipt.commandId);
    priorVersion = receipt.storeVersion;
  }

  const files: LegacyProjectEnvelopeProjectionFile[] = [];
  const seenPaths = new Set<string>();
  const projectPathById = new Map<string, string>();
  for (const project of state.projects) {
    const directory = safeProjectDirectoryName(project.name, project.projectId);
    const projectPath = `project/${directory}`;
    projectPathById.set(project.projectId, projectPath);
    addProjectionFile(files, seenPaths, `${projectPath}/project.json`, "project", exactJson(project));
  }
  for (const thread of state.threads) {
    const directory = projectPathById.get(thread.projectId);
    if (!directory) fail("INVALID_RELATION", `Thread owner Project is missing: ${thread.threadId}`);
    addProjectionFile(files, seenPaths, `${directory}/threads/${thread.threadId}.json`, "project", exactJson(thread));
  }
  for (const task of state.ganttTasks) {
    const directory = projectPathById.get(task.projectId);
    if (!directory) fail("INVALID_RELATION", `Gantt task owner Project is missing: ${task.taskId}`);
    addProjectionFile(files, seenPaths, `${directory}/gantt/${task.taskId}.json`, "project", exactJson(task));
  }
  for (const task of state.collaborationTasks) {
    const directory = projectPathById.get(task.projectId);
    if (!directory) fail("INVALID_RELATION", `Collaboration task owner Project is missing: ${task.collaborationId}`);
    addProjectionFile(files, seenPaths, `${directory}/collaboration/${task.collaborationId}.json`, "project", exactJson(task));
  }
  const recipes = projectRecipeRecords(state, state.projects);
  for (const item of recipes) addProjectionFile(files, seenPaths, item.path, "recipe", exactJson(item.record));
  const domain = {
    rootId: state.rootId,
    storeVersion: envelope.storeVersion,
    projects: state.projects as unknown as Array<Record<string, unknown>>,
    threads: state.threads as unknown as Array<Record<string, unknown>>,
    ganttTasks: state.ganttTasks as unknown as Array<Record<string, unknown>>,
    collaborationTasks: state.collaborationTasks as unknown as Array<Record<string, unknown>>,
  };
  const canonicalDigest = legacyProjectDomainDigest(domain);
  const summary: ProjectRecipeExportSummary = {
    projects: domain.projects, threads: domain.threads, ganttTasks: domain.ganttTasks,
    collaborationTasks: domain.collaborationTasks, recipes: recipes.map(item => item.record),
  };
  const control = {
    schema: 1,
    rootId: state.rootId,
    storeVersion: envelope.storeVersion,
    receipts,
    canonicalDigest,
  };
  const controlBytes = exactJson(control);
  parseLegacyProjectControl(controlBytes, summary);
  addProjectionFile(files, seenPaths, ".pkm/state/project-store.json", "control", controlBytes);
  files.sort((left, right) => left.path < right.path ? -1 : left.path > right.path ? 1 : 0);
  if (files.length > MAX_ENTRIES) fail("RESOURCE_LIMIT", "Original Project/Recipe projection exceeds the bounded file count.");
  if (files.reduce((total, file) => total + Buffer.byteLength(file.base64, "base64"), 0) > MAX_PROJECTION_TOTAL_BYTES) {
    fail("RESOURCE_LIMIT", "Original Project/Recipe projection exceeds the bounded total byte count.");
  }
  const projectionSha256 = sha256(canonicalJson(files.map(file => ({ path: file.path, kind: file.kind, sha256: file.sha256 }))));
  const body: Omit<LegacyProjectEnvelopePlan, "planSha256"> = {
    schema: "pkm.legacy-project-envelope-plan/v1",
    sourceRoot: root,
    sourcePath: ".pkm/state/projects.json",
    sourceStat,
    sourceSha256: sha256(bytes),
    payloadSha256,
    rootId: state.rootId,
    storeVersion: envelope.storeVersion,
    projectControlBase64: controlBytes.toString("base64"),
    projectControlSha256: sha256(controlBytes),
    projectionFiles: files,
    projectionSha256,
    orderedReceipts: receipts,
    counts: {
      projects: state.projects.length, threads: state.threads.length, ganttTasks: state.ganttTasks.length,
      collaborationTasks: state.collaborationTasks.length, recipes: recipes.length,
    },
  };
  return { ...body, planSha256: planDigest(body) };
}

export async function planLegacyProjectEnvelope(sourceRoot: string): Promise<LegacyProjectEnvelopePlan> {
  const root = await assertRealDirectory(sourceRoot);
  for (const path of [join(root, ".pkm"), join(root, ".pkm", "state")]) {
    const directory = await assertRealDirectory(path);
    if (directory !== path) fail("UNSAFE_PATH", "Original Project state path is not canonical.");
  }
  await assertNoProjectMigrationState(root);
  const source = await readStableFile(root, ".pkm/state/projects.json");
  const plan = buildPlan(root, source.stat, source.bytes);
  const uiBootstrap = (await readdir(join(root, ".pkm/state"))).includes("project-store-migration")
    ? inspectLegacyUiBootstrapCompatibility(root) : undefined;
  if (!uiBootstrap) return plan;
  const { planSha256: _digest, ...body } = plan;
  const bound = { ...body, uiBootstrap };
  return { ...bound, planSha256: planDigest(bound) };
}

function validatePlanShape(plan: LegacyProjectEnvelopePlan): void {
  if (!plan || plan.schema !== "pkm.legacy-project-envelope-plan/v1" || !sha256Pattern.test(plan.sourceSha256)
    || !sha256Pattern.test(plan.payloadSha256) || !sha256Pattern.test(plan.projectionSha256)
    || !sha256Pattern.test(plan.projectControlSha256) || !sha256Pattern.test(plan.planSha256)
    || plan.sourcePath !== ".pkm/state/projects.json" || !Number.isSafeInteger(plan.storeVersion) || plan.storeVersion < 1) {
    fail("INVALID_PLAN", "Project envelope plan is malformed.");
  }
  const { planSha256: digest, ...body } = plan;
  if (planDigest(body) !== digest) fail("INVALID_PLAN", "Project envelope plan was modified.");
  if (sha256(Buffer.from(plan.projectControlBase64, "base64")) !== plan.projectControlSha256
    || sha256(canonicalJson(plan.projectionFiles.map(file => ({ path: file.path, kind: file.kind, sha256: file.sha256 }))))
      !== plan.projectionSha256) {
    fail("INVALID_PLAN", "Project envelope plan files failed their digests.");
  }
  for (const file of plan.projectionFiles) {
    const bytes = Buffer.from(file.base64, "base64");
    if (sha256(bytes) !== file.sha256 || file.path.startsWith("/") || file.path.split("/").some(part => !part || part === "." || part === ".." || part.includes("\\"))) {
      fail("INVALID_PLAN", "Project envelope projection file is invalid.");
    }
  }
}

function isWithin(parent: string, candidate: string): boolean {
  const path = relative(parent, candidate);
  return path === "" || (path !== ".." && !path.startsWith(`..${sep}`) && !isAbsolute(path));
}

async function sourceMatches(plan: LegacyProjectEnvelopePlan): Promise<Buffer> {
  const current = await planLegacyProjectEnvelope(plan.sourceRoot);
  if (current.planSha256 !== plan.planSha256 || canonicalJson(current.sourceStat) !== canonicalJson(plan.sourceStat)) {
    fail("SOURCE_CHANGED", "Original ProjectStore source changed after planning.");
  }
  const source = await readStableFile(plan.sourceRoot, plan.sourcePath);
  if (source.stat.dev !== plan.sourceStat.dev || source.stat.ino !== plan.sourceStat.ino
    || source.stat.size !== plan.sourceStat.size || source.stat.mtimeNs !== plan.sourceStat.mtimeNs
    || source.stat.ctimeNs !== plan.sourceStat.ctimeNs || sha256(source.bytes) !== plan.sourceSha256) {
    fail("SOURCE_CHANGED", "Original projects.json identity or bytes changed after planning.");
  }
  return source.bytes;
}

async function stageParent(stageRoot: string, sourceRoot: string): Promise<string> {
  if (!isAbsolute(stageRoot)) fail("UNSAFE_PATH", "Stage destination must be absolute.");
  const root = resolve(stageRoot);
  await assertRealDirectory(dirname(root));
  if (root === sourceRoot || isWithin(sourceRoot, root) || isWithin(root, sourceRoot)) {
    fail("UNSAFE_PATH", "Keep the stage destination and disposable original source in separate directory trees.");
  }
  try {
    await lstat(root);
    fail("STAGE_EXISTS", "Project envelope staging never overwrites an existing destination.");
  } catch (error) {
    if (error instanceof LegacyProjectEnvelopeError) throw error;
    if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
  }
  return root;
}

async function writeStageFile(stageRoot: string, path: string, bytes: Uint8Array): Promise<void> {
  const target = join(stageRoot, ...path.split("/"));
  const directory = dirname(target);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const safe = await assertRealDirectory(directory);
  if (!isWithin(stageRoot, safe)) fail("UNSAFE_PATH", "Stage projection escaped its owner root.");
  await writeFile(target, bytes, { flag: "wx", mode: 0o600 });
}

function ownerBytes(stageId: string, plan: LegacyProjectEnvelopePlan): Buffer {
  return exactJson({
    schema: "pkm.legacy-project-envelope-stage/v1",
    stageId,
    planSha256: plan.planSha256,
    sourceSha256: plan.sourceSha256,
    projectionSha256: plan.projectionSha256,
  });
}

function stageReceipt(plan: LegacyProjectEnvelopePlan, stageId: string): LegacyProjectEnvelopeStageReceipt {
  return {
    schema: "pkm.legacy-project-envelope-stage-receipt/v1",
    stageId,
    planSha256: plan.planSha256,
    sourceSha256: plan.sourceSha256,
    sourceBytes: plan.sourceStat.size,
    payloadSha256: plan.payloadSha256,
    projectionSha256: plan.projectionSha256,
    projectControlSha256: plan.projectControlSha256,
    rootId: plan.rootId,
    storeVersion: plan.storeVersion,
    counts: plan.counts,
    orderedReceipts: plan.orderedReceipts,
    opaqueSourcePath: "original-projects.json",
    adoptionDdl: legacyProjectEnvelopeAdoptionDdl,
  };
}

export async function stageLegacyProjectEnvelope(
  input: LegacyProjectEnvelopePlan,
  destination: string,
): Promise<LegacyProjectEnvelopeStageReceipt> {
  validatePlanShape(input);
  const sourceBytes = await sourceMatches(input);
  const root = await stageParent(destination, input.sourceRoot);
  const stageId = randomUUID();
  await mkdir(root, { mode: 0o700 });
  try {
    const owner = ownerBytes(stageId, input);
    await writeFile(join(root, "stage-owner.json"), owner, { flag: "wx", mode: 0o600 });
    await writeStageFile(root, "original-projects.json", sourceBytes);
    await mkdir(join(root, "projection", "notes"), { recursive: true, mode: 0o700 });
    for (const file of input.projectionFiles) {
      await writeStageFile(root, `projection/${file.path}`, Buffer.from(file.base64, "base64"));
    }
    const binding = exactJson({
      schema: "pkm.legacy-project-envelope-binding/v1",
      stageId,
      planSha256: input.planSha256,
      sourcePath: input.sourcePath,
      sourceSha256: input.sourceSha256,
      sourceBytes: input.sourceStat.size,
      payloadSha256: input.payloadSha256,
      projectionSha256: input.projectionSha256,
      projectControlSha256: input.projectControlSha256,
      rootId: input.rootId,
      storeVersion: input.storeVersion,
      orderedReceipts: input.orderedReceipts,
      counts: input.counts,
      adoptionDdl: legacyProjectEnvelopeAdoptionDdl,
    });
    await writeStageFile(root, "binding.json", binding);
    const receipt = stageReceipt(input, stageId);
    await verifyLegacyProjectEnvelopeStage(input, root, receipt);
    return receipt;
  } catch (error) {
    try {
      const owner = JSON.parse(await readFile(join(root, "stage-owner.json"), "utf8")) as { stageId?: string; planSha256?: string };
      if (owner.stageId === stageId && owner.planSha256 === input.planSha256) await rm(root, { recursive: true, force: true });
    } catch {
      try { await rmdirOwnedEmpty(root); } catch { /* Preserve an unowned or changed stage for review. */ }
    }
    throw error;
  }
}

async function rmdirOwnedEmpty(path: string): Promise<void> {
  const entries = await readdir(path);
  if (entries.length === 0) await rm(path, { recursive: false });
}

async function collectFiles(root: string): Promise<Map<string, Buffer>> {
  const files = new Map<string, Buffer>();
  async function walk(directory: string, prefix: string, depth: number): Promise<void> {
    if (depth > MAX_DEPTH || files.size > MAX_ENTRIES) fail("STAGE_INVALID", "Staged Project envelope exceeds file inspection limits.");
    for (const name of (await readdir(directory)).sort()) {
      const relativePath = prefix ? `${prefix}/${name}` : name;
      const full = join(root, ...relativePath.split("/"));
      const stat = await lstat(full);
      if (stat.isSymbolicLink()) fail("STAGE_INVALID", "Staged Project envelope cannot contain symbolic links.");
      if (stat.isDirectory()) await walk(full, relativePath, depth + 1);
      else if (stat.isFile()) files.set(relativePath, await readFile(full));
      else fail("STAGE_INVALID", "Staged Project envelope contains a special file.");
    }
  }
  await walk(root, "", 0);
  return files;
}

export async function verifyLegacyProjectEnvelopeStage(
  input: LegacyProjectEnvelopePlan,
  stageRoot: string,
  expected?: LegacyProjectEnvelopeStageReceipt,
): Promise<LegacyProjectEnvelopeStageReceipt> {
  validatePlanShape(input);
  await sourceMatches(input);
  const root = await assertRealDirectory(stageRoot);
  const files = await collectFiles(root);
  const ownerBytes = files.get("stage-owner.json");
  const opaque = files.get("original-projects.json");
  const bindingBytes = files.get("binding.json");
  if (!ownerBytes || !opaque || !bindingBytes || sha256(opaque) !== input.sourceSha256
    || opaque.length !== input.sourceStat.size) {
    fail("STAGE_INVALID", "Staged opaque ProjectStore bytes or identity binding is missing.");
  }
  let owner: Record<string, unknown>, binding: Record<string, unknown>;
  try {
    owner = JSON.parse(ownerBytes.toString("utf8")) as Record<string, unknown>;
    binding = JSON.parse(bindingBytes.toString("utf8")) as Record<string, unknown>;
  } catch { fail("STAGE_INVALID", "Staged Project envelope identity metadata is malformed."); }
  if (owner.schema !== "pkm.legacy-project-envelope-stage/v1"
    || owner.planSha256 !== input.planSha256 || owner.sourceSha256 !== input.sourceSha256
    || owner.projectionSha256 !== input.projectionSha256 || typeof owner.stageId !== "string"
    || binding.schema !== "pkm.legacy-project-envelope-binding/v1" || binding.stageId !== owner.stageId
    || binding.planSha256 !== input.planSha256 || binding.sourceSha256 !== input.sourceSha256
    || binding.projectionSha256 !== input.projectionSha256 || binding.rootId !== input.rootId
    || binding.storeVersion !== input.storeVersion || canonicalJson(binding.orderedReceipts) !== canonicalJson(input.orderedReceipts)) {
    fail("STAGE_INVALID", "Staged Project envelope binding does not match the freshly validated source.");
  }
  if (expected && (expected.stageId !== owner.stageId || expected.planSha256 !== input.planSha256)) {
    fail("STAGE_IDENTITY_MISMATCH", "Staged Project envelope does not match the expected stage receipt.");
  }
  const expectedFiles = new Map<string, Buffer>([
    ["original-projects.json", opaque],
    ["stage-owner.json", ownerBytes],
    ["binding.json", bindingBytes],
    ...input.projectionFiles.map(file => [`projection/${file.path}`, Buffer.from(file.base64, "base64")] as [string, Buffer]),
  ]);
  if (files.size !== expectedFiles.size) fail("STAGE_INVALID", "Staged Project envelope has missing or unrecognized files.");
  for (const [path, bytes] of expectedFiles) {
    const staged = files.get(path);
    if (!staged || !staged.equals(bytes)) fail("STAGE_INVALID", `Staged Project envelope file failed exact-byte verification: ${path}`);
  }
  const receipt = stageReceipt(input, owner.stageId);
  if (expected && canonicalJson(expected) !== canonicalJson(receipt)) {
    fail("STAGE_IDENTITY_MISMATCH", "Staged Project envelope receipt changed.");
  }
  return receipt;
}

export async function prepareLegacyProjectEnvelopeAdoption(
  plan: LegacyProjectEnvelopePlan,
  stageRoot: string,
  receipt: LegacyProjectEnvelopeStageReceipt,
  workspaceId: string,
): Promise<LegacyProjectEnvelopeAdoptionPayload> {
  await verifyLegacyProjectEnvelopeStage(plan, stageRoot, receipt);
  const stage = await assertRealDirectory(stageRoot);
  const sourceBytes = await readFile(join(stage, receipt.opaqueSourcePath));
  const projectControlBytes = Buffer.from(plan.projectControlBase64, "base64");
  if (sha256(sourceBytes) !== receipt.sourceSha256 || sha256(projectControlBytes) !== receipt.projectControlSha256) {
    fail("STAGE_INVALID", "Opaque source or projected Project control changed before adoption.");
  }
  return {
    receipt: legacyProjectEnvelopeAdoptionReceipt(plan, receipt, workspaceId),
    sourceBytes,
    projectControlBytes,
  };
}

export function initializeLegacyProjectEnvelopeSchema(database: DatabaseSync): void {
  if (!database.isTransaction) fail("TRANSACTION_REQUIRED", "Project envelope schema must be initialized inside the native import transaction.");
  database.exec(legacyProjectEnvelopeAdoptionDdl);
  const columns = database.prepare("PRAGMA table_info(legacy_project_envelope)").all() as Array<{ name: string }>;
  const expected = [
    "workspace_id", "source_path", "source_schema", "source_sha256", "source_bytes", "payload_sha256",
    "projection_sha256", "root_id", "store_version", "stage_id", "adoption_receipt",
  ];
  if (canonicalJson(columns.map(column => column.name)) !== canonicalJson(expected)) {
    fail("SCHEMA_MISMATCH", "Native Project envelope table does not match the captured import DDL.");
  }
  const sql = database.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='legacy_project_envelope'").get() as { sql?: string } | undefined;
  const compactSql = String(sql?.sql || "").replace(/\s+/g, "").toLowerCase();
  for (const fragment of [
    "referenceslegacy_project_control(workspace_id)ondeletecascade",
    "source_path='.pkm/state/projects.json'",
    "length(source_bytes)<=16777216",
    "store_version>0",
  ]) {
    if (!compactSql.includes(fragment)) fail("SCHEMA_MISMATCH", "Native Project envelope table constraints changed.");
  }
}

export function recordLegacyProjectEnvelopeAdoption(
  database: DatabaseSync,
  payload: LegacyProjectEnvelopeAdoptionPayload,
): void {
  if (!database.isTransaction) fail("TRANSACTION_REQUIRED", "Project envelope adoption must share the native import transaction.");
  const { receipt, sourceBytes, projectControlBytes } = payload;
  if (receipt.schema !== "pkm.legacy-project-envelope-adoption/v1"
    || sha256(sourceBytes) !== receipt.sourceSha256 || sourceBytes.length !== receipt.sourceBytes
    || sha256(projectControlBytes) !== receipt.projectControlSha256) {
    fail("INVALID_ADOPTION", "Native Project envelope adoption payload failed its source pins.");
  }
  const control = database.prepare(`SELECT root_id,store_version,canonical_digest,control_bytes,control_sha256
    FROM legacy_project_control WHERE workspace_id=?`).get(receipt.workspaceId) as {
      root_id: string; store_version: number; canonical_digest: string; control_bytes: Uint8Array; control_sha256: string;
    } | undefined;
  if (!control || control.root_id !== receipt.rootId || control.store_version !== receipt.storeVersion
    || !Buffer.from(control.control_bytes).equals(projectControlBytes)
    || control.control_sha256 !== receipt.projectControlSha256) {
    fail("CONTROL_MISMATCH", "Imported native Project control is not bound to the exact source projection.");
  }
  let envelope: z.infer<typeof rawEnvelopeSchema>;
  try { envelope = rawEnvelopeSchema.parse(JSON.parse(sourceBytes.toString("utf8"))); }
  catch { fail("INVALID_ADOPTION", "Opaque source bytes no longer contain the supported ProjectStore envelope."); }
  if (sha256(canonicalJson(envelope.payload)) !== envelope.digest
    || envelope.digest !== receipt.payloadSha256 || envelope.storeVersion !== receipt.storeVersion
    || envelope.payload.state.rootId !== receipt.rootId
    || sha256(canonicalJson(envelope.payload.receipts)) !== receipt.orderedReceiptSha256) {
    fail("INVALID_ADOPTION", "Opaque ProjectStore envelope no longer matches its adoption receipt.");
  }
  const ordered = database.prepare(`SELECT ordinal,command_id,fingerprint,operation,store_version,entity_id
    FROM legacy_project_receipt WHERE workspace_id=? ORDER BY ordinal`).all(receipt.workspaceId) as Array<{
      ordinal: number; command_id: string; fingerprint: string; operation: string; store_version: number; entity_id: string;
    }>;
  const importedReceipts = ordered.map(({ ordinal: _ordinal, command_id, fingerprint, operation, store_version, entity_id }) => ({
    commandId: command_id, fingerprint, operation, storeVersion: store_version, entityId: entity_id,
  }));
  const sourceReceipts = envelope.payload.receipts as LegacyProjectReceipt[];
  if (canonicalJson(importedReceipts) !== canonicalJson(sourceReceipts)
    || ordered.some((entry, index) => entry.ordinal !== index)
    || sha256(canonicalJson(importedReceipts)) !== receipt.orderedReceiptSha256) {
    fail("CONTROL_MISMATCH", "Imported original Project receipts are not in the original order.");
  }
  const stored = database.prepare(`SELECT source_sha256,source_bytes,projection_sha256,stage_id,adoption_receipt
    FROM legacy_project_envelope WHERE workspace_id=?`).get(receipt.workspaceId) as {
      source_sha256: string; source_bytes: Uint8Array; projection_sha256: string; stage_id: string; adoption_receipt: string;
    } | undefined;
  if (stored) {
    if (stored.source_sha256 === receipt.sourceSha256 && Buffer.from(stored.source_bytes).equals(sourceBytes)
      && stored.projection_sha256 === receipt.projectionSha256 && stored.stage_id === receipt.stageId
      && stored.adoption_receipt === canonicalJson(receipt)) return;
    fail("ADOPTION_CONFLICT", "A different Project envelope is already adopted for this workspace.");
  }
  database.prepare(`INSERT INTO legacy_project_envelope(
    workspace_id,source_path,source_schema,source_sha256,source_bytes,payload_sha256,
    projection_sha256,root_id,store_version,stage_id,adoption_receipt
  ) VALUES(?,?,?,?,?,?,?,?,?,?,?)`).run(
    receipt.workspaceId, receipt.sourcePath, 1, receipt.sourceSha256, sourceBytes, receipt.payloadSha256,
    receipt.projectionSha256, receipt.rootId, receipt.storeVersion, receipt.stageId, canonicalJson(receipt),
  );
}

export function readLegacyProjectEnvelopeAdoption(
  database: DatabaseSync,
  workspaceId: string,
): { receipt: LegacyProjectEnvelopeAdoptionReceipt; sourceBytes: Buffer } | undefined {
  const row = database.prepare(`SELECT source_path,source_schema,source_sha256,source_bytes,payload_sha256,
    projection_sha256,root_id,store_version,stage_id,adoption_receipt
    FROM legacy_project_envelope WHERE workspace_id=?`).get(workspaceId) as {
      source_path: string; source_schema: number; source_sha256: string; source_bytes: Uint8Array;
      payload_sha256: string; projection_sha256: string; root_id: string; store_version: number;
      stage_id: string; adoption_receipt: string;
    } | undefined;
  if (!row) return undefined;
  const sourceBytes = Buffer.from(row.source_bytes);
  let receipt: LegacyProjectEnvelopeAdoptionReceipt;
  try { receipt = JSON.parse(row.adoption_receipt) as LegacyProjectEnvelopeAdoptionReceipt; }
  catch { fail("ADOPTION_CORRUPT", "Stored Project envelope adoption receipt is malformed."); }
  if (row.source_path !== ".pkm/state/projects.json" || row.source_schema !== 1
    || sha256(sourceBytes) !== row.source_sha256 || receipt.schema !== "pkm.legacy-project-envelope-adoption/v1"
    || receipt.workspaceId !== workspaceId || receipt.sourceSha256 !== row.source_sha256
    || receipt.payloadSha256 !== row.payload_sha256 || receipt.projectionSha256 !== row.projection_sha256
    || receipt.rootId !== row.root_id || receipt.storeVersion !== row.store_version
    || receipt.stageId !== row.stage_id || row.adoption_receipt !== canonicalJson(receipt)) {
    fail("ADOPTION_CORRUPT", "Stored Project envelope bytes or adoption receipt failed verification.");
  }
  let envelope: z.infer<typeof rawEnvelopeSchema>;
  try { envelope = rawEnvelopeSchema.parse(JSON.parse(sourceBytes.toString("utf8"))); }
  catch { fail("ADOPTION_CORRUPT", "Stored Project envelope is not a supported format."); }
  if (sha256(canonicalJson(envelope.payload)) !== envelope.digest || envelope.digest !== receipt.payloadSha256
    || envelope.storeVersion !== receipt.storeVersion || envelope.payload.state.rootId !== receipt.rootId
    || sha256(canonicalJson(envelope.payload.receipts)) !== receipt.orderedReceiptSha256) {
    fail("ADOPTION_CORRUPT", "Stored Project envelope payload digest or original receipt order is invalid.");
  }
  const ordered = database.prepare(`SELECT ordinal,command_id,fingerprint,operation,store_version,entity_id
    FROM legacy_project_receipt WHERE workspace_id=? ORDER BY ordinal`).all(workspaceId) as Array<{
      ordinal: number; command_id: string; fingerprint: string; operation: string; store_version: number; entity_id: string;
    }>;
  const importedReceipts = ordered.map(({ ordinal: _ordinal, command_id, fingerprint, operation, store_version, entity_id }) => ({
    commandId: command_id, fingerprint, operation, storeVersion: store_version, entityId: entity_id,
  }));
  const sourceReceipts = envelope.payload.receipts as LegacyProjectReceipt[];
  const suffixOperations = new Set([
    "project.update", "project-archive", "project-create", "recipe-create", "recipe-update",
    "thread-create", "thread-rename", "thread-move",
  ]);
  const sourcePrefix = importedReceipts.slice(0, sourceReceipts.length);
  const suffix = importedReceipts.slice(sourceReceipts.length);
  const commandIds = new Set<string>();
  let nextStoreVersion = receipt.storeVersion + 1;
  for (const [index, item] of importedReceipts.entries()) {
    if (ordered[index]?.ordinal !== index || commandIds.has(item.commandId)) {
      fail("ADOPTION_CORRUPT", "Stored native Project receipts have an invalid order or duplicate command identity.");
    }
    commandIds.add(item.commandId);
  }
  for (const item of suffix) {
    if (!suffixOperations.has(item.operation) || item.storeVersion !== nextStoreVersion) {
      fail("ADOPTION_CORRUPT", "Native Project history contains an unsupported or discontinuous post-adoption receipt.");
    }
    nextStoreVersion++;
  }
  const currentControl = database.prepare(`SELECT store_version FROM legacy_project_control WHERE workspace_id=?`)
    .get(workspaceId) as { store_version: number } | undefined;
  if (canonicalJson(sourcePrefix) !== canonicalJson(sourceReceipts)
    || !currentControl || currentControl.store_version !== nextStoreVersion - 1) {
    fail("ADOPTION_CORRUPT", "Stored native Project receipts no longer preserve the immutable source prefix and current version.");
  }
  return { receipt, sourceBytes };
}

/** Read-only initial-import verification; never grants adoption or mutation authority. */
export function verifyImportedProjectEnvelope(
  database: DatabaseSync, workspaceId: string, plan: LegacyProjectEnvelopePlan,
): void {
  validatePlanShape(plan);
  const adoption = readLegacyProjectEnvelopeAdoption(database, workspaceId);
  if (!adoption || adoption.receipt.sourceSha256 !== plan.sourceSha256 || adoption.sourceBytes.length !== plan.sourceStat.size
    || canonicalJson(buildPlan(plan.sourceRoot, plan.sourceStat, adoption.sourceBytes)) !== canonicalJson(plan)) {
    fail("ADOPTION_CORRUPT", "Imported Project envelope differs from the exact approved plan.");
  }
  const control = database.prepare(`SELECT control_bytes FROM legacy_project_control WHERE workspace_id=?`).get(workspaceId) as
    { control_bytes: Uint8Array } | undefined;
  const bytes = Buffer.from(plan.projectControlBase64, "base64");
  if (!control || !Buffer.from(control.control_bytes).equals(bytes) || sha256(bytes) !== plan.projectControlSha256)
    fail("ADOPTION_CORRUPT", "Imported Project control differs from its approved projection.");
  const ordered = database.prepare("SELECT COUNT(*) AS count FROM legacy_project_receipt WHERE workspace_id=?").get(workspaceId) as
    { count: number };
  if (ordered.count !== plan.orderedReceipts.length)
    fail("ADOPTION_CORRUPT", "Imported Project history changed after initial publication.");
}

export function legacyProjectEnvelopeAdoptionReceipt(
  plan: LegacyProjectEnvelopePlan,
  receipt: LegacyProjectEnvelopeStageReceipt,
  workspaceId: string,
): LegacyProjectEnvelopeAdoptionReceipt {
  validatePlanShape(plan);
  if (receipt.planSha256 !== plan.planSha256 || receipt.sourceSha256 !== plan.sourceSha256
    || receipt.projectionSha256 !== plan.projectionSha256 || receipt.rootId !== plan.rootId
    || receipt.storeVersion !== plan.storeVersion || !z.string().uuid().safeParse(workspaceId).success) {
    fail("STAGE_IDENTITY_MISMATCH", "Native adoption receipt must bind the exact validated stage and workspace.");
  }
  return {
    schema: "pkm.legacy-project-envelope-adoption/v1",
    workspaceId,
    stageId: receipt.stageId,
    sourcePath: plan.sourcePath,
    sourceSha256: plan.sourceSha256,
    sourceBytes: plan.sourceStat.size,
    payloadSha256: plan.payloadSha256,
    projectionSha256: plan.projectionSha256,
    rootId: plan.rootId,
    storeVersion: plan.storeVersion,
    projectControlSha256: plan.projectControlSha256,
    orderedReceiptSha256: sha256(canonicalJson(plan.orderedReceipts)),
    counts: plan.counts,
  };
}
