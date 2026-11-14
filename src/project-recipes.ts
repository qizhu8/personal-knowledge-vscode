import { createHash } from "node:crypto";
import {
  closeSync, constants, fstatSync, lstatSync, openSync, readFileSync, readdirSync,
} from "node:fs";
import { join, relative, resolve, sep } from "node:path";
import { z } from "zod";
import { CoreError, type StorageRequest } from "./contracts.js";
import {
  CapturedRecipeValidationError, normalizeRecipeCategory, recipeIdFromFile, safeRecipeCategorySegment,
  UNCATEGORIZED_RECIPE_DIRECTORY, validateRecipeRecord, validRecipeId,
} from "./domain/project-recipes-storage-rules.js";
import {
  deriveSystemId, PROJECT_ENTITY_DIRECTORIES, safeProjectDirectoryName,
} from "./domain/project-recipes-project-rules.js";
import { projectSystemEntityIssue } from "./domain/project-recipes.js";
import { normalizeCollaborationTaskRecord } from "./domain/project-recipes-collaboration-model.js";
import {
  exportProjectRecipeBundle, type BundledKnowledgeContent, type ProjectRecipeBundle,
} from "./domain/project-recipes-bundle.js";
import { compileKnowledgeIdentityV1 } from "./domain/knowledge-contracts.js";
import { canonicalJson as capturedCanonicalJson } from "./domain/project-recipes-workflow-contracts.js";
import { projectNote } from "./domain/notes.js";
import { projectSkill } from "./domain/skills.js";
import { knowledgeSnapshot } from "./knowledge-snapshot.js";
import { decodeMarkdown, sha256 as markdownSha256, type MarkdownRecord } from "./markdown.js";
import { noteRecord } from "./note-contracts.js";
import { skillRecord } from "./skill-contracts.js";
import { projectRecipeDefinitions as registryDefinitions } from "./project-recipes-contracts.js";
import { inspectLegacyUiRetiredState } from "./legacy-ui-retired-state.js";

export { projectRecipeDefinitions } from "./project-recipes-contracts.js";

const digest = z.string().regex(/^[a-f0-9]{64}$/);
const identity = z.string().regex(/^[A-Za-z][A-Za-z0-9._-]{0,127}$/);
const nonempty = z.string().min(1);
const json = z.json();
const metadataField = z.strictObject({
  name: z.string(), description: z.string(), required: z.boolean().optional(),
});
const binding = z.strictObject({
  bindingId: identity, kind: z.enum(["skill", "note"]), knowledgeId: nonempty,
  contentHash: digest, usage: z.enum(["required", "recommended", "reference"]),
});
const recipeSchema = z.strictObject({
  schema: z.literal("pkm.knowledge/v1").optional(),
  knowledgeId: z.string().regex(/^knowledge_[a-f0-9]{24}$/).optional(),
  aliases: z.array(z.string()).optional(),
  recipeId: identity,
  trashedAt: nonempty.refine(value =>
    Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value).optional(),
  scope: z.enum(["global", "project"]),
  projectId: identity.optional(),
  category: z.string().optional(),
  systemKind: z.literal("built-in").optional(),
  name: nonempty,
  description: z.string(),
  methodology: json.optional(),
  methodologyDigest: digest.optional(),
  metadata: z.strictObject({
    applicableFunctions: z.array(z.string()), solution: z.string(),
    requiredInputs: z.array(metadataField), expectedOutputs: z.array(metadataField),
  }).optional(),
  editorLayout: z.strictObject({
    nodePositions: z.record(z.string(), z.strictObject({ x: z.number().finite(), y: z.number().finite() })),
    boundaryPositions: z.strictObject({
      input: z.strictObject({ x: z.number().finite(), y: z.number().finite() }).optional(),
      output: z.strictObject({ x: z.number().finite(), y: z.number().finite() }).optional(),
    }).optional(),
  }).optional(),
  definition: json,
  nodeBindings: z.array(z.strictObject({ nodeId: identity, bindings: z.array(binding) })).optional(),
  executableDigest: digest,
  revision: z.number().int().safe().min(1),
  origin: z.strictObject({
    kind: z.string(), sourceRecipeId: z.string().optional(), sourceKey: z.string().optional(),
    sourceRevision: z.number().int().safe().positive().optional(),
    sourceScope: z.enum(["global", "project"]).optional(), brokerName: z.string().optional(),
    publisherUser: z.string().optional(), publisherHost: z.string().optional(),
  }).optional(),
});
const recipeSummary = z.strictObject({
  recipeId: identity, knowledgeId: z.string().regex(/^knowledge_[a-f0-9]{24}$/),
  revision: z.number().int().safe().min(1), name: nonempty, description: z.string(),
  category: z.string(), systemKind: z.literal("built-in").optional(), executableDigest: digest,
});
const trashedRecipeSchema = recipeSchema.extend({ trashedAt: nonempty.refine(value =>
  Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value) });

const projectSchema = z.strictObject({
  projectId: identity, name: nonempty, systemKind: z.literal("default-project").optional(),
  version: z.number().int().safe().min(1), goal: z.string().optional(),
  successCriteria: z.array(z.string()).optional(), status: z.enum(["planned", "active", "completed"]).optional(),
  currentMilestone: z.string().optional(), owner: z.string().optional(), deadline: z.string().optional(),
  autonomyPolicyReference: z.string().optional(), archivedAt: z.string().optional(), deletedAt: z.string().optional(),
  links: z.array(z.strictObject({
    kind: z.enum(["action-run", "recipe-run", "agent-session", "chat"]), id: nonempty, linkedAt: nonempty,
  })).optional(),
  decisions: z.array(z.strictObject({
    decisionId: identity, at: nonempty, reason: z.string(),
    changes: z.array(z.strictObject({ field: nonempty, before: json.nullable(), after: json.nullable() })),
  })).optional(),
  timeline: z.array(z.strictObject({
    eventId: identity, at: nonempty, kind: nonempty, summary: z.string(), sourceId: z.string().optional(),
  })).optional(),
});
const threadSchema = z.strictObject({
  threadId: identity, projectId: identity, name: nonempty, description: z.string(),
  archived: z.boolean(), systemKind: z.literal("general-thread").optional(),
  legacyAliases: z.array(z.string()),
  chatroom: z.strictObject({
    roomId: identity, roomName: z.string().refine(value => !!value.trim()), linkedAt: nonempty,
  }).optional(),
  version: z.number().int().safe().min(1),
});
const ganttTaskSchema = z.strictObject({
  taskId: identity, projectId: identity, threadId: identity.optional(), title: nonempty,
  startDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/), endDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  progress: z.number().int().min(0).max(100),
  status: z.enum(["not-started", "in-progress", "blocked", "completed"]),
  owners: z.array(z.strictObject({
    name: z.string().refine(value => !!value.trim() && value === value.trim()),
    role: z.string().refine(value => !!value.trim() && value === value.trim()),
  })),
  dependencyIds: z.array(identity), version: z.number().int().safe().min(1),
});
const collaborationTaskSchema = z.strictObject({
  collaborationId: identity, title: nonempty, projectId: identity, threadId: identity,
  ganttTaskId: identity.optional(), agentSessionId: identity.optional(), recipeRunId: identity.optional(),
  objective: z.string().optional(), context: z.string().optional(), expectedOutput: z.string().optional(),
  artifactType: z.string().optional(), acceptanceCriteria: z.array(z.string()),
  decisionRequired: z.boolean(), evidenceLinks: z.array(z.string()), evidenceSummary: z.string().optional(),
  decisionResult: z.string().optional(), resultArtifact: z.string().optional(), blockedWaitingOn: z.array(z.string()),
  completionClaim: z.boolean(), primaryOwner: z.string().optional(),
  ownerPartitions: z.array(z.strictObject({ owner: nonempty, scope: nonempty })),
  resolvedResponders: z.array(z.string()), reviewerApprovals: z.array(z.string()), expectedReviewers: z.array(z.string()),
  version: z.number().int().safe().min(1),
  status: z.enum(["assigned", "working", "review", "synthesis", "completed", "blocked", "timed-out"]),
  phase: z.enum(["assignment", "work", "handoff", "review", "synthesis", "completion"]),
  lead: nonempty, owners: z.array(z.string()), reviewers: z.array(z.string()), expectedResponders: z.array(z.string()),
  deadlineAt: z.string().optional(),
  warnings: z.array(z.strictObject({ code: z.string(), message: z.string(), at: nonempty })),
  convergenceState: z.enum([
    "contract-incomplete", "awaiting-work", "awaiting-responders", "awaiting-review",
    "awaiting-decision", "ready-to-complete", "converged", "blocked", "escalated",
  ]),
  history: z.array(z.strictObject({
    version: z.number().int().safe().min(1),
    action: z.enum(["assign", "start", "handoff", "approve", "reject", "synthesize", "complete", "block", "timeout", "resume"]),
    actor: nonempty, actorRole: z.enum(["Lead", "Worker", "Reviewer"]), at: nonempty,
    note: z.string().optional(), warnings: z.array(z.strictObject({ code: z.string(), message: z.string(), at: nonempty })).optional(),
    convergenceState: z.enum([
      "contract-incomplete", "awaiting-work", "awaiting-responders", "awaiting-review",
      "awaiting-decision", "ready-to-complete", "converged", "blocked", "escalated",
    ]).optional(),
  })),
});

export type ProjectRecord = z.infer<typeof projectSchema>;
export type ProjectRecipeRecord = z.infer<typeof recipeSchema>;
export type RecipeRecord = ProjectRecipeRecord;
export type BundledKnowledgeDocument = BundledKnowledgeContent;
export interface RecipeKnowledgeBinding {
  bindingId: string;
  kind: "skill" | "note";
  knowledgeId: string;
  contentHash: string;
  usage: "required" | "recommended" | "reference";
}
export type ProjectRecipeOperation =
  | "project.list"
  | "project.get"
  | "project.recipe.list"
  | "project.recipe.get"
  | "project.recipe.bundle.get";
export type ProjectRecipeRequest = Omit<StorageRequest, "operation"> & {
  operation: ProjectRecipeOperation;
  args: Record<string, unknown>;
};

type Project = z.infer<typeof projectSchema>;
type Thread = z.infer<typeof threadSchema>;
type GanttTask = z.infer<typeof ganttTaskSchema>;
type CollaborationTask = z.infer<typeof collaborationTaskSchema>;
type Recipe = z.infer<typeof recipeSchema>;

interface SourceFile {
  area: "project" | "recipes";
  areaRoot: string;
  relativePath: string;
  absolutePath: string;
  size: number;
  content?: Uint8Array;
  text?: string;
}
interface WorkspaceSnapshot {
  projects: Array<{ item: Project; threads: Thread[]; ganttTasks: GanttTask[]; collaborationTasks: CollaborationTask[] }>;
  recipes: Recipe[];
  revision: string;
}

function verifyNoSymlinkAncestors(path: string): void {
  let current = resolve(path);
  while (true) {
    let stat;
    try { stat = lstatSync(current); }
    catch (error) {
      if (isMissing(error)) throw new CoreError("INVALID_WORKSPACE", "Workspace path contains a missing component.");
      throw new CoreError("INVALID_WORKSPACE", "Could not inspect a workspace path component.");
    }
    if (stat.isSymbolicLink()) throw new CoreError("INVALID_WORKSPACE", "Workspace paths containing symlinks are not supported.");
    if (current !== resolve(path) && !stat.isDirectory()) {
      throw new CoreError("INVALID_WORKSPACE", "Workspace path ancestors must be directories.");
    }
    const parent = resolve(current, "..");
    if (parent === current) break;
    current = parent;
  }
}

export const PROJECT_RECIPE_LIMITS = Object.freeze({
  entries: 12_000,
  files: 8_000,
  fileBytes: 2 * 1024 * 1024,
  totalBytes: 32 * 1024 * 1024,
  depth: 24,
  pathLength: 2_048,
});
const MAX_ENTRIES = PROJECT_RECIPE_LIMITS.entries;
const MAX_FILES = PROJECT_RECIPE_LIMITS.files;
const MAX_FILE_BYTES = PROJECT_RECIPE_LIMITS.fileBytes;
const MAX_TOTAL_BYTES = PROJECT_RECIPE_LIMITS.totalBytes;
const MAX_DEPTH = PROJECT_RECIPE_LIMITS.depth;
const MAX_PATH_LENGTH = PROJECT_RECIPE_LIMITS.pathLength;
const UTF8 = new TextDecoder("utf-8", { fatal: true });

export function readProjectRecipes(
  root: string,
  request: StorageRequest | ProjectRecipeRequest,
  documents: MarkdownRecord[] = [],
  options: { originalRecipeInventory?: boolean;
    nativeRecipes?: { recipes: RecipeRecord[]; snapshotRevision: string } } = {},
): unknown {
  const args = parseRequest(request);
  const snapshot = readSnapshot(root, undefined, undefined, options.originalRecipeInventory !== false);
  if (options.nativeRecipes) {
    snapshot.recipes = options.nativeRecipes.recipes;
    snapshot.revision = options.nativeRecipes.snapshotRevision;
  }
  checkSnapshotPin(args.snapshotRevision, snapshot.revision);
  switch (String(request.operation)) {
    case "project.list": {
      const all = snapshot.projects.map(({ item }) => item);
      return page(all, args.offset, args.limit, snapshot.revision);
    }
    case "project.get": {
      const project = snapshot.projects.find(candidate => candidate.item.projectId === args.id);
      if (!project) throw new CoreError("NOT_FOUND", "Project not found in this isolated workspace.");
      if (args.expectedVersion !== undefined && args.expectedVersion !== project.item.version) {
        throw new CoreError("CONFLICT", "Project version changed; rediscover the Project.");
      }
      return {
        item: project.item, threads: project.threads, ganttTasks: project.ganttTasks,
        collaborationTasks: project.collaborationTasks, snapshotRevision: snapshot.revision,
      };
    }
    case "project.recipe.list": {
      const categoryPrefix = args.projectId === undefined ? undefined : projectCategoryPrefix(snapshot, args.projectId);
      const all = snapshot.recipes.filter(recipe => {
        const category = recipe.category || "";
        return (categoryPrefix === undefined || category === categoryPrefix || category.startsWith(`${categoryPrefix}/`))
          && (args.category === undefined || category === args.category);
      }).map(recipe => recipeSummary.parse({
        recipeId: recipe.recipeId, knowledgeId: recipe.knowledgeId, revision: recipe.revision,
        name: recipe.name, description: recipe.description, category: recipe.category || "",
        systemKind: recipe.systemKind, executableDigest: recipe.executableDigest,
      }));
      return page(all, args.offset, args.limit, snapshot.revision);
    }
    case "project.recipe.get": {
      const recipe = snapshot.recipes.find(candidate => candidate.recipeId === args.id);
      if (!recipe) throw new CoreError("NOT_FOUND", "Recipe not found in this isolated workspace.");
      if (args.expectedRevision !== undefined && args.expectedRevision !== recipe.revision
        || args.expectedExecutableDigest !== undefined && args.expectedExecutableDigest !== recipe.executableDigest) {
        throw new CoreError("CONFLICT", "Recipe no longer matches its pinned revision and executable digest.");
      }
      return { item: recipe, snapshotRevision: snapshot.revision };
    }
    case "project.recipe.bundle.get": {
      const project = snapshot.projects.find(candidate => candidate.item.projectId === args.projectId);
      if (!project) throw new CoreError("NOT_FOUND", "Project not found in this isolated workspace.");
      const prefix = projectCategoryPrefix(snapshot, args.projectId);
      const recipes = snapshot.recipes.filter(recipe => recipe.category === prefix || (recipe.category || "").startsWith(`${prefix}/`));
      const knowledge = buildProjectRecipeKnowledge(root, documents, recipes);
      let item: ProjectRecipeBundle;
      try {
        item = exportProjectRecipeBundle({
          project: project.item,
          recipes,
          knowledge,
          ...(args.exportedAt === undefined ? {} : { exportedAt: args.exportedAt }),
        });
      } catch (error) {
        throw new CoreError("INVALID_DOCUMENT", `Project Recipe bundle could not be verified: ${error instanceof Error ? error.message : "invalid bundle"}`);
      }
      return { item, snapshotRevision: snapshot.revision };
    }
    default:
      throw new CoreError("NOT_FOUND", "Unknown Project/Recipe read operation.");
  }
}

export function readProjectRecipeSnapshot(root: string): { recipes: RecipeRecord[]; snapshotRevision: string } {
  const snapshot = readSnapshot(root);
  return { recipes: snapshot.recipes, snapshotRevision: snapshot.revision };
}

export function buildProjectRecipeKnowledge(
  root: string,
  documents: MarkdownRecord[],
  recipes: Array<Pick<Recipe, "nodeBindings">>,
): BundledKnowledgeDocument[] {
  const bindings = recipes.flatMap(recipe => (recipe.nodeBindings || []).flatMap(node => node.bindings));
  if (!bindings.length) return [];
  if (!Array.isArray(documents)) throw new CoreError("INVALID_ARGUMENT", "Project Recipe Knowledge sources must be an array.");
  const verifiedDocuments = documents.map(document => {
    if (!document || typeof document.raw !== "string" || !document.record
      || Buffer.from(document.raw, "utf8").toString("utf8") !== document.raw
      || markdownSha256(document.raw) !== document.record.sha256) {
      throw new CoreError("INVALID_DOCUMENT", "Recipe-bound Markdown source is malformed or changed from its indexed digest.");
    }
    if (document.record.area !== "notes" && document.record.area !== "skills") return document;
    try { return decodeMarkdown(document.record.id, document.raw, document.record.path, document.record.area); }
    catch (error) {
      throw new CoreError("INVALID_DOCUMENT", `Recipe-bound Markdown source cannot be revalidated: ${error instanceof Error ? error.message : "invalid source"}`);
    }
  });
  const required = new Map<string, RecipeKnowledgeBinding>();
  for (const binding of bindings) {
    const key = `${binding.kind}\0${binding.knowledgeId}`;
    const previous = required.get(key);
    if (previous && previous.contentHash !== binding.contentHash) {
      throw new CoreError("CONFLICT", `Recipe bindings disagree about pinned content for ${binding.kind} ${binding.knowledgeId}.`);
    }
    required.set(key, binding);
  }

  const records = new Map<string, BundledKnowledgeContent>();
  for (const source of knowledgeSnapshot(root, verifiedDocuments, "skills", "Skill")) {
    const parsed = skillRecord.safeParse(projectSkill(source));
    if (!parsed.success) throw new CoreError("INVALID_DOCUMENT", `Skill metadata violates the original read-model types: skills/${source.rel}. Use knowledge.metadata.get to inspect it.`);
    const item = parsed.data;
    const knowledgeId = [item.category, item.name].filter(Boolean).join("/");
    const document = {
      name: item.name, description: item.description || "", category: item.category || "",
      tags: parseTagArray(item.tags, `skills/${source.rel}`), content: item.content || "",
    };
    addBundledKnowledge(records, required, {
      knowledgeId, kind: "skill", contentHash: hashText(capturedCanonicalJson(document)), document,
    });
  }
  for (const source of knowledgeSnapshot(root, verifiedDocuments, "notes", "Note")) {
    const parsed = noteRecord.safeParse(projectNote(source));
    if (!parsed.success) throw new CoreError("INVALID_DOCUMENT", `Note metadata violates the original read-model types: notes/${source.rel}. Use knowledge.metadata.get to inspect it.`);
    const item = parsed.data;
    const document = {
      title: item.title, type: item.type || "general", category: item.category || "",
      tags: parseTagArray(item.tags, `notes/${source.rel}`), content: item.content || "",
    };
    addBundledKnowledge(records, required, {
      knowledgeId: item.slug, kind: "note", contentHash: hashText(capturedCanonicalJson(document)), document,
    });
  }
  const missing = [...required.values()].filter(binding => !records.has(`${binding.kind}\0${binding.knowledgeId}`))
    .map(binding => `${binding.kind} ${binding.knowledgeId}`).sort();
  if (missing.length) throw new CoreError("NOT_FOUND", `Recipe-bound Note/Skill Markdown was not found: ${missing.join(", ")}.`);
  for (const [key, record] of records) {
    const binding = required.get(key)!;
    if (binding.contentHash !== record.contentHash) {
      throw new CoreError("CONFLICT", `Bound ${record.kind} ${record.knowledgeId} changed from its pinned content hash.`);
    }
  }
  return [...records.values()].sort((left, right) => compareText(left.knowledgeId, right.knowledgeId));
}

function addBundledKnowledge(
  records: Map<string, BundledKnowledgeContent>,
  required: Map<string, RecipeKnowledgeBinding>,
  candidate: BundledKnowledgeContent,
): void {
  const key = `${candidate.kind}\0${candidate.knowledgeId}`;
  if (!required.has(key)) return;
  if (records.has(key)) throw new CoreError("CONFLICT", `More than one Markdown document resolves to ${candidate.kind} ${candidate.knowledgeId}.`);
  records.set(key, candidate);
}

function parseTagArray(value: string, label: string): string[] {
  try {
    const parsed: unknown = JSON.parse(value);
    if (Array.isArray(parsed) && parsed.every(tag => typeof tag === "string")) return parsed;
  } catch { /* skillRecord/noteRecord already validate this source; retain an explicit fail-closed check. */ }
  throw new CoreError("INVALID_DOCUMENT", `Invalid original tag list in ${label}.`);
}

function parseRequest(request: StorageRequest | ProjectRecipeRequest): Record<string, any> {
  const definition = registryDefinitions.find(item => item.id === String(request.operation));
  if (!definition) throw new CoreError("NOT_FOUND", "Unknown Project/Recipe read operation.");
  const parsed = definition.input.safeParse(request.args);
  if (!parsed.success) throw new CoreError("INVALID_ARGUMENT", z.prettifyError(parsed.error));
  return parsed.data as Record<string, any>;
}

function page<T>(items: T[], offset: number, limit: number, snapshotRevision: string) {
  const pageItems = items.slice(offset, offset + limit);
  const next = offset + pageItems.length;
  return { items: pageItems, total: items.length, nextOffset: next < items.length ? next : null, snapshotRevision };
}

function checkSnapshotPin(pin: string | undefined, revision: string): void {
  if (pin !== undefined && pin !== revision) throw new CoreError("CONFLICT", "Project/Recipe snapshot changed; restart related reads and pagination.");
}

function projectCategoryPrefix(snapshot: WorkspaceSnapshot, projectId: string): string {
  const project = snapshot.projects.find(candidate => candidate.item.projectId === projectId)?.item;
  if (!project) throw new CoreError("NOT_FOUND", "Project not found in this isolated workspace.");
  const segment = safeRecipeCategorySegment(project.name);
  const conflicting = snapshot.projects.find(candidate => candidate.item.projectId !== projectId
    && safeRecipeCategorySegment(candidate.item.name).normalize("NFC").toLocaleLowerCase("en-US")
      === segment.normalize("NFC").toLocaleLowerCase("en-US"));
  if (conflicting) throw new CoreError("CONFLICT", "Project names map to the same original Recipe category; Project Recipe association is ambiguous.");
  return `Project/${segment}`;
}

export function readUnpublishedProjectSnapshotPin(root: string, directoryName: string): string {
  if (!directoryName || directoryName.includes("/") || directoryName.includes("\\")
    || directoryName === "." || directoryName === "..") throw new CoreError("INVALID_ARGUMENT", "Invalid unpublished Project directory.");
  return readSnapshot(root, undefined, directoryName).revision;
}

function readSnapshot(rootInput: string, extra: { bytes: number; count: number } = { bytes: 0, count: 0 },
  unpublishedProjectDirectory?: string, originalRecipeInventory = true): WorkspaceSnapshot {
  if (typeof rootInput !== "string" || !rootInput.trim()) throw new CoreError("INVALID_ARGUMENT", "Workspace root must be a non-empty path.");
  const root = resolve(rootInput);
  let rootStat;
  try { rootStat = lstatSync(root); }
  catch (error) {
    if (isMissing(error)) return emptySnapshot();
    throw new CoreError("INVALID_WORKSPACE", "Could not inspect the isolated workspace root.");
  }
  if (rootStat.isSymbolicLink() || !rootStat.isDirectory()) throw new CoreError("INVALID_WORKSPACE", "Workspace root must be a real directory, not a symlink.");
  verifyNoSymlinkAncestors(root);

  const files: SourceFile[] = [];
  let entries = extra.count;
  let totalBytes = extra.bytes;
  const addEntry = (area: SourceFile["area"], absolutePath: string, areaRoot: string, isDirectory: boolean) => {
    entries++;
    if (entries > MAX_ENTRIES) throw new CoreError("RESOURCE_LIMIT", "Project/Recipe workspace exceeds the entry-count limit.");
    const relativePath = relative(areaRoot, absolutePath).split(sep).join("/");
    if (!relativePath || relativePath.length > MAX_PATH_LENGTH || relativePath.startsWith("../")) {
      throw new CoreError("INVALID_DOCUMENT", "Project/Recipe path is not a bounded relative path.");
    }
    if (!isDirectory) {
      const stat = lstatSync(absolutePath);
      if (stat.size > MAX_FILE_BYTES) throw new CoreError("RESOURCE_LIMIT", `Project/Recipe file exceeds the per-file byte limit: ${relativePath}`);
      totalBytes += stat.size;
      if (totalBytes > MAX_TOTAL_BYTES) throw new CoreError("RESOURCE_LIMIT", "Project/Recipe workspace exceeds the combined byte limit.");
      if (files.length + extra.count >= MAX_FILES) throw new CoreError("RESOURCE_LIMIT", "Project/Recipe workspace exceeds the file-count limit.");
      files.push({ area, areaRoot, relativePath, absolutePath, size: stat.size });
    }
  };
  const optionalDirectory = (name: "project" | "recipes"): string | undefined => {
    const path = join(root, name);
    try {
      const stat = lstatSync(path);
      if (stat.isSymbolicLink() || !stat.isDirectory()) throw new CoreError("INVALID_DOCUMENT", `${name}/ must be a real directory, not a symlink or file.`);
      return path;
    } catch (error) {
      if (isMissing(error)) return undefined;
      throw error;
    }
  };

  const projectRoot = optionalDirectory("project");
  if (projectRoot) {
    const projectNames = sortedNames(projectRoot);
    if (!projectNames.length) throw new CoreError("INVALID_DOCUMENT", "Existing Project storage contains no canonical Project entities.");
    for (const projectName of projectNames) {
      const projectDirectory = join(projectRoot, projectName);
      const stat = lstatSync(projectDirectory);
      if (stat.isSymbolicLink() || !stat.isDirectory()) throw new CoreError("INVALID_DOCUMENT", `Project entry is not a directory: ${projectName}`);
      addEntry("project", projectDirectory, projectRoot, true);
      const children = sortedNames(projectDirectory);
      for (const child of children) {
        const childPath = join(projectDirectory, child);
        const childStat = lstatSync(childPath);
        if (child === "project.json") {
          if (childStat.isSymbolicLink() || !childStat.isFile()) throw new CoreError("INVALID_DOCUMENT", `Invalid Project entity file: ${projectName}/${child}`);
          addEntry("project", childPath, projectRoot, false);
        } else if ((PROJECT_ENTITY_DIRECTORIES as readonly string[]).includes(child)) {
          if (childStat.isSymbolicLink() || !childStat.isDirectory()) throw new CoreError("INVALID_DOCUMENT", `Invalid Project entity directory: ${projectName}/${child}`);
          addEntry("project", childPath, projectRoot, true);
          for (const fileName of sortedNames(childPath)) {
            const filePath = join(childPath, fileName);
            const fileStat = lstatSync(filePath);
            if (fileStat.isSymbolicLink() || !fileStat.isFile() || !fileName.endsWith(".json")) {
              throw new CoreError("INVALID_DOCUMENT", `Invalid Project entity entry: ${projectName}/${child}/${fileName}`);
            }
            addEntry("project", filePath, projectRoot, false);
          }
        } else {
          throw new CoreError("INVALID_DOCUMENT", `Unknown Project storage entry: ${projectName}/${child}`);
        }
      }
    }
  }

  const recipeRoot = optionalDirectory("recipes");
  if (recipeRoot) {
    const walkRecipes = (directory: string, depth: number) => {
      if (depth > MAX_DEPTH) throw new CoreError("RESOURCE_LIMIT", "Recipe category nesting exceeds the path-depth limit.");
      for (const name of sortedNames(directory)) {
        const filePath = join(directory, name);
        const stat = lstatSync(filePath);
        if (stat.isSymbolicLink()) throw new CoreError("INVALID_DOCUMENT", `Recipe storage cannot contain symlinks: ${name}`);
        if (stat.isDirectory()) {
          if (name === ".trash" && directory !== recipeRoot) throw new CoreError("INVALID_DOCUMENT", "Recipe .trash directory is only valid at the recipes root.");
          const relativeDirectory = relative(recipeRoot, filePath).split(sep).join("/");
          if (relativeDirectory !== ".trash" && relativeDirectory !== "Project"
            && relativeDirectory !== UNCATEGORIZED_RECIPE_DIRECTORY) {
            try { normalizeRecipeCategory(relativeDirectory); }
            catch { throw new CoreError("INVALID_DOCUMENT", `Invalid Recipe category directory: ${relativeDirectory}`); }
          }
          addEntry("recipes", filePath, recipeRoot, true);
          walkRecipes(filePath, depth + 1);
        } else if (stat.isFile() && name.endsWith(".json")) {
          addEntry("recipes", filePath, recipeRoot, false);
        } else {
          throw new CoreError("INVALID_DOCUMENT", `Unexpected Recipe storage entry: ${name}`);
        }
      }
    };
    walkRecipes(recipeRoot, 0);
  }

  const projectFiles = files.filter(file => file.area === "project");
  const recipeFiles = files.filter(file => file.area === "recipes");
  for (const file of files) readUtf8(file);
  const parsedProjects = readProjects(projectRoot, projectFiles, unpublishedProjectDirectory);
  const parsedRecipes = readRecipes(recipeRoot, recipeFiles);
  let legacyRecipePin: string | undefined;
  if (originalRecipeInventory && !recipeRoot && lstatSync(join(root, ".pkm/state/projects.json"), { throwIfNoEntry: false })) {
    const retired = inspectLegacyUiRetiredState(root);
    if (retired?.recipeEvolution) {
      const source = retired.files.find(file => file.path === ".pkm/state/projects.json")!;
      const fd = openSync(join(root, source.path), constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
      try {
        const before = fstatSync(fd, { bigint: true }), bytes = readFileSync(fd), after = fstatSync(fd, { bigint: true });
        if (String(before.dev) !== source.device || String(before.ino) !== source.inode || before.nlink !== 1n
          || String(before.mtimeNs) !== source.mtimeNs || String(before.ctimeNs) !== source.ctimeNs
          || before.size !== after.size || before.mtimeNs !== after.mtimeNs || before.ctimeNs !== after.ctimeNs
          || hashBytes(bytes) !== source.sha256)
          throw new CoreError("INVALID_DOCUMENT", "Original Recipe inventory changed while reading.");
        for (const original of JSON.parse(bytes.toString("utf8")).payload.state.recipes) {
          const item = recipeSchema.parse(original);
          validateRecipeRecord(item);
          parsedRecipes.push({ ...item, schema: "pkm.knowledge/v1",
            knowledgeId: `knowledge_${hashText(`recipe\0${item.recipeId}`).slice(0, 24)}`, aliases: [`recipe:${item.recipeId}`] });
        }
        legacyRecipePin = retired.sourceFingerprint;
      } finally { closeSync(fd); }
    }
  }
  validateProjectRelations(parsedProjects);
  const sourceHashes = files.map(file => [file.area, file.relativePath, hashBytes(file.content!)])
    .sort((left, right) => compareText(String(left[0]), String(right[0])) || compareText(String(left[1]), String(right[1])));
  if (legacyRecipePin) sourceHashes.push(["legacy-recipe-envelope", ".pkm/state/projects.json", legacyRecipePin]);
  const revision = hashText(canonicalJson(sourceHashes));
  return { projects: parsedProjects, recipes: parsedRecipes, revision };
}

function readProjects(root: string | undefined, files: SourceFile[], unpublishedProjectDirectory?: string) {
  if (!root) return [];
  const byPath = new Map(files.map(file => [file.relativePath, file]));
  const projects: WorkspaceSnapshot["projects"] = [];
  const projectIds = new Set<string>();
  const threadsById = new Set<string>();
  const tasksById = new Set<string>();
  const collaborationsById = new Set<string>();
  for (const projectDirectory of sortedNames(root)) {
    const projectPath = `${projectDirectory}/project.json`;
    const source = byPath.get(projectPath);
    if (!source && projectDirectory === unpublishedProjectDirectory
      && readdirSync(join(root, projectDirectory)).length === 0) continue;
    if (!source) throw new CoreError("INVALID_DOCUMENT", `Project directory is missing project.json: ${projectDirectory}`);
    const item = parseEntity(source, projectSchema, "Project");
    if (!validRecipeId(item.projectId) || !projectDirectory.endsWith(`.${item.projectId}`)
      || projectDirectory !== safeProjectDirectoryName(item.name, item.projectId)) {
      throw new CoreError("INVALID_DOCUMENT", `Project directory identity does not match project.json: ${projectDirectory}`);
    }
    if (projectIds.has(item.projectId)) throw new CoreError("INVALID_DOCUMENT", `Duplicate Project identity: ${item.projectId}`);
    projectIds.add(item.projectId);
    const threads = readEntityDirectory(byPath, `${projectDirectory}/threads`, threadSchema, "Thread");
    const ganttTasks = readEntityDirectory(byPath, `${projectDirectory}/gantt`, ganttTaskSchema, "Gantt task");
    const collaborationTasks = readEntityDirectory(byPath, `${projectDirectory}/collaboration`, collaborationTaskSchema, "Collaboration task");
    for (const task of collaborationTasks) {
      try {
        const normalized = normalizeCollaborationTaskRecord(task);
        if (capturedCanonicalJson(normalized) !== capturedCanonicalJson(task)) {
          throw new CoreError("INVALID_DOCUMENT", `Collaboration task requires original-model normalization: ${task.collaborationId}`);
        }
      } catch (error) {
        if (error instanceof CoreError) throw error;
        throw new CoreError("INVALID_DOCUMENT", `Collaboration task is invalid: ${task.collaborationId}`);
      }
    }
    for (const thread of threads) {
      if (threadsById.has(thread.threadId)) throw new CoreError("INVALID_DOCUMENT", `Duplicate Thread identity: ${thread.threadId}`);
      threadsById.add(thread.threadId);
    }
    for (const task of ganttTasks) {
      if (tasksById.has(task.taskId)) throw new CoreError("INVALID_DOCUMENT", `Duplicate Gantt task identity: ${task.taskId}`);
      tasksById.add(task.taskId);
    }
    for (const task of collaborationTasks) {
      if (collaborationsById.has(task.collaborationId)) throw new CoreError("INVALID_DOCUMENT", `Duplicate Collaboration identity: ${task.collaborationId}`);
      collaborationsById.add(task.collaborationId);
    }
    projects.push({ item, threads, ganttTasks, collaborationTasks });
  }
  projects.sort((left, right) => compareText(left.item.projectId, right.item.projectId));
  if (projects.length) {
    const systemProjects = projects.flatMap(project => project.item.systemKind === "default-project" ? [project.item] : []);
    if (systemProjects.length !== 1) throw new CoreError("INVALID_DOCUMENT", "Canonical Project storage requires exactly one system Default Project.");
  }
  return projects;
}

function readEntityDirectory<T>(files: Map<string, SourceFile>, directory: string, schema: z.ZodType<T>, label: string): T[] {
  const prefix = `${directory}/`;
  return [...files.values()].filter(file => file.relativePath.startsWith(prefix))
    .sort((left, right) => compareText(left.relativePath, right.relativePath))
    .map(file => parseEntity(file, schema, label));
}

function validateProjectRelations(projects: WorkspaceSnapshot["projects"]): void {
  const projectIds = new Set(projects.map(project => project.item.projectId));
  const threads = projects.flatMap(project => project.threads);
  const tasks = projects.flatMap(project => project.ganttTasks);
  const tasksById = new Map(tasks.map(task => [task.taskId, task]));
  for (const project of projects) {
    const { item, threads: projectThreads, ganttTasks, collaborationTasks } = project;
    for (const thread of projectThreads) {
      if (thread.projectId !== item.projectId) throw new CoreError("INVALID_DOCUMENT", `Thread belongs to a different Project: ${thread.threadId}`);
      if (thread.systemKind === "general-thread" && thread.threadId !== deriveSystemId(item.projectId, "pkm/general-thread/v1")) {
        throw new CoreError("INVALID_DOCUMENT", `General Thread identity is invalid: ${thread.threadId}`);
      }
      if (thread.chatroom?.roomId && !/^[A-Za-z][A-Za-z0-9._-]{0,127}$/.test(thread.chatroom.roomId)) {
        throw new CoreError("INVALID_DOCUMENT", `Thread Chatroom identity is invalid: ${thread.threadId}`);
      }
    }
    for (const task of ganttTasks) {
      if (!projectIds.has(task.projectId) || task.projectId !== item.projectId) throw new CoreError("INVALID_DOCUMENT", `Gantt task Project is invalid: ${task.taskId}`);
      if (task.threadId && !projectThreads.some(thread => thread.threadId === task.threadId)) {
        throw new CoreError("INVALID_DOCUMENT", `Gantt task Thread is invalid: ${task.taskId}`);
      }
      if (task.startDate > task.endDate || !validDate(task.startDate) || !validDate(task.endDate)) {
        throw new CoreError("INVALID_DOCUMENT", `Gantt task date range is invalid: ${task.taskId}`);
      }
      if (new Set(task.dependencyIds).size !== task.dependencyIds.length || task.dependencyIds.includes(task.taskId)) {
        throw new CoreError("INVALID_DOCUMENT", `Gantt task dependencies are invalid: ${task.taskId}`);
      }
      const ownerKeys = task.owners.map(owner => `${owner.name.toLocaleLowerCase()}\0${owner.role.toLocaleLowerCase()}`);
      if (new Set(ownerKeys).size !== ownerKeys.length) throw new CoreError("INVALID_DOCUMENT", `Gantt task owners are duplicated: ${task.taskId}`);
      for (const dependency of task.dependencyIds) {
        const referenced = tasksById.get(dependency);
        if (!referenced || referenced.projectId !== item.projectId) throw new CoreError("INVALID_DOCUMENT", `Gantt dependency is missing or cross-Project: ${dependency}`);
      }
    }
    for (const task of collaborationTasks) {
      if (task.projectId !== item.projectId || !projectThreads.some(thread => thread.threadId === task.threadId)) {
        throw new CoreError("INVALID_DOCUMENT", `Collaboration task Project/Thread reference is invalid: ${task.collaborationId}`);
      }
      if (task.ganttTaskId && !ganttTasks.some(candidate => candidate.taskId === task.ganttTaskId)) {
        throw new CoreError("INVALID_DOCUMENT", `Collaboration task Gantt reference is invalid: ${task.collaborationId}`);
      }
    }
  }
  for (const task of tasks) visitDependency(task.taskId, tasksById, new Set(), new Set());
  for (const thread of threads) if (!projectIds.has(thread.projectId)) throw new CoreError("INVALID_DOCUMENT", `Thread Project reference is missing: ${thread.threadId}`);
  const chatrooms = threads.flatMap(thread => thread.chatroom ? [thread.chatroom.roomId] : []);
  if (new Set(chatrooms).size !== chatrooms.length) throw new CoreError("INVALID_DOCUMENT", "A Chatroom is linked to more than one Thread.");
  const issue = projectSystemEntityIssue(projects.map(({ item, threads }) => ({ project: item, threads })));
  if (issue) throw new CoreError("INVALID_DOCUMENT", issue);
}

function visitDependency(id: string, byId: Map<string, GanttTask>, visiting: Set<string>, visited: Set<string>): void {
  if (visiting.has(id)) throw new CoreError("INVALID_DOCUMENT", `Gantt dependency cycle includes ${id}.`);
  if (visited.has(id)) return;
  visiting.add(id);
  for (const dependency of byId.get(id)?.dependencyIds || []) visitDependency(dependency, byId, visiting, visited);
  visiting.delete(id);
  visited.add(id);
}

function readRecipes(root: string | undefined, files: SourceFile[]): Recipe[] {
  if (!root) return [];
  const active: Recipe[] = [];
  const trash: Array<z.infer<typeof trashedRecipeSchema>> = [];
  const portablePaths = new Map<string, string>();
  for (const file of files.sort((left, right) => compareText(left.relativePath, right.relativePath))) {
    const inTrash = file.relativePath.startsWith(".trash/");
    const parsed = parseJson(readUtf8(file), file.relativePath);
    let recipe: Recipe;
    try {
      if (inTrash) {
        const { trashedAt: _trashedAt, ...record } = trashedRecipeSchema.parse(parsed);
        recipe = record;
      } else recipe = recipeSchema.parse(parsed);
      validateRecipeRecord(recipe as Recipe);
      const identityResult = compileKnowledgeIdentityV1({
        schema: (recipe as Recipe & { schema?: string }).schema,
        knowledgeId: (recipe as Recipe & { knowledgeId?: string }).knowledgeId,
        revision: recipe.revision,
        aliases: (recipe as Recipe & { aliases?: string[] }).aliases,
      });
      if (!identityResult.ok) throw new Error("Recipe Knowledge identity is invalid.");
    } catch (error) {
      if (error instanceof CapturedRecipeValidationError) {
        throw new CoreError("INVALID_DOCUMENT", `Recipe ${file.relativePath} violates ${error.code}: ${error.message}`);
      }
      if (error instanceof z.ZodError) throw new CoreError("INVALID_DOCUMENT", `Recipe ${file.relativePath} has invalid schema: ${z.prettifyError(error)}`);
      throw new CoreError("INVALID_DOCUMENT", `Recipe ${file.relativePath} is invalid: ${error instanceof Error ? error.message : "invalid record"}`);
    }
    const idFromPath = recipeIdFromFile(file.absolutePath);
    if (idFromPath !== recipe.recipeId) throw new CoreError("INVALID_DOCUMENT", `Recipe filename identity does not match JSON identity: ${file.relativePath}`);
    if (!inTrash) {
      const category = recipeCategoryFromRelative(file.relativePath);
      if (normalizeRecipeCategory(recipe.category) !== category) throw new CoreError("INVALID_DOCUMENT", `Recipe category does not match its parent path: ${file.relativePath}`);
    } else {
      const trashRecord = trashedRecipeSchema.safeParse(parsed);
      if (!trashRecord.success) throw new CoreError("INVALID_DOCUMENT", `Trashed Recipe requires its original schema and trashedAt: ${file.relativePath}`);
      trash.push(trashRecord.data);
    }
    const portablePath = file.relativePath.normalize("NFC").toLocaleLowerCase("en-US");
    const prior = portablePaths.get(portablePath);
    if (prior && prior !== file.relativePath) throw new CoreError("INVALID_DOCUMENT", `Recipe path collides by case/Unicode with ${prior}: ${file.relativePath}`);
    portablePaths.set(portablePath, file.relativePath);
    (inTrash ? [] : active).push(recipe);
  }
  for (const field of ["recipeId", "knowledgeId"] as const) {
    const seen = new Set<string>();
    for (const recipe of [...active, ...trash]) {
      const value = (recipe as Recipe & { knowledgeId: string })[field];
      if (seen.has(value)) throw new CoreError("INVALID_DOCUMENT", `Duplicate Recipe ${field}: ${value}`);
      seen.add(value);
    }
  }
  const categories = new Map<string, string>();
  for (const recipe of active) {
    const category = recipe.category || "";
    const key = category.normalize("NFC").toLocaleLowerCase("en-US");
    const prior = categories.get(key);
    if (prior !== undefined && prior !== category) throw new CoreError("INVALID_DOCUMENT", `Recipe categories collide by case/Unicode: ${prior} and ${category}`);
    categories.set(key, category);
  }
  return active.sort((left, right) => compareText(left.recipeId, right.recipeId));
}

function recipeCategoryFromRelative(path: string): string {
  const parent = path.includes("/") ? path.slice(0, path.lastIndexOf("/")) : "";
  return parent === UNCATEGORIZED_RECIPE_DIRECTORY ? "" : parent;
}

function emptySnapshot(): WorkspaceSnapshot {
  return { projects: [], recipes: [], revision: hashText("[]") };
}

function parseEntity<T>(file: SourceFile, schema: z.ZodType<T>, label: string): T {
  const parsed = schema.safeParse(parseJson(readUtf8(file), file.relativePath));
  if (!parsed.success) throw new CoreError("INVALID_DOCUMENT", `${label} ${file.relativePath} has invalid schema: ${z.prettifyError(parsed.error)}`);
  return parsed.data;
}

function parseJson(text: string, filePath: string): unknown {
  try {
    const value: unknown = JSON.parse(text);
    checkWellFormedUnicode(value);
    return value;
  } catch (error) {
    if (error instanceof CoreError) throw error;
    throw new CoreError("INVALID_DOCUMENT", `Invalid UTF-8/JSON in Project/Recipe source: ${filePath}`);
  }
}

function checkWellFormedUnicode(value: unknown): void {
  if (typeof value === "string") {
    if (/([\uD800-\uDBFF](?![\uDC00-\uDFFF]))|((?<![\uD800-\uDBFF])[\uDC00-\uDFFF])/.test(value)) {
      throw new CoreError("INVALID_DOCUMENT", "JSON contains a lone Unicode surrogate.");
    }
    return;
  }
  if (Array.isArray(value)) { value.forEach(checkWellFormedUnicode); return; }
  if (value && typeof value === "object") {
    for (const [key, child] of Object.entries(value)) { checkWellFormedUnicode(key); checkWellFormedUnicode(child); }
  }
}

function readUtf8(file: SourceFile): string {
  if (file.text !== undefined) return file.text;
  let descriptor: number | undefined;
  try {
    let ancestor = file.areaRoot;
    if (lstatSync(ancestor).isSymbolicLink() || !lstatSync(ancestor).isDirectory()) throw new Error("unsafe root");
    const parentSegments = relative(file.areaRoot, file.absolutePath).split(sep).slice(0, -1);
    for (const segment of parentSegments) {
      ancestor = join(ancestor, segment);
      const stat = lstatSync(ancestor);
      if (stat.isSymbolicLink() || !stat.isDirectory()) throw new Error("unsafe parent");
    }
    if (lstatSync(file.absolutePath).isSymbolicLink()) throw new Error("symlink");
    descriptor = openSync(file.absolutePath, constants.O_RDONLY | (constants.O_NOFOLLOW || 0));
    const stat = fstatSync(descriptor);
    if (!stat.isFile() || stat.size !== file.size || stat.size > MAX_FILE_BYTES) throw new Error("changed");
    const data = readFileSync(descriptor);
    if (data.length !== file.size) throw new Error("changed");
    file.content = data;
    file.text = UTF8.decode(data);
    return file.text;
  } catch {
    throw new CoreError("INVALID_DOCUMENT", `Project/Recipe source changed or is not safe to read: ${file.relativePath}`);
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
  }
}

function sortedNames(directory: string): string[] {
  return readdirSync(directory).sort(compareText);
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function validDate(value: string): boolean {
  const date = new Date(`${value}T00:00:00.000Z`);
  return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value;
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record).sort().map(key => `${JSON.stringify(key)}:${canonicalJson(record[key])}`).join(",")}}`;
}

function hashBytes(value: Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}
function hashText(value: string): string { return createHash("sha256").update(value, "utf8").digest("hex"); }

function isMissing(error: unknown): boolean {
  return !!error && typeof error === "object" && "code" in error && error.code === "ENOENT";
}
