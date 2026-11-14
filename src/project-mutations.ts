import { createHash } from "node:crypto";
import {
  closeSync, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync, readdirSync, rmdirSync, unlinkSync,
} from "node:fs";
import { dirname, relative, resolve, sep } from "node:path";
import { CoreError } from "./contracts.js";
import { atomicFileWrite, sha256 } from "./file-write.js";
import { compileKnowledgeIdentityV1, legacyKnowledgeAlias } from "./domain/knowledge-contracts.js";
import {
  canonicalJson, compileWorkflowDefinitionV1, NOOP_NODE_KIND, WORKFLOW_DEFINITION_SCHEMA,
} from "./domain/project-recipes-workflow-contracts.js";
import { compileRecipeMethodologyV1 } from "./domain/project-recipes-methodology-model.js";
import {
  deriveSystemId, safeProjectDirectoryName,
} from "./domain/project-recipes-project-rules.js";
import {
  normalizeRecipeCategory, safeRecipeCategorySegment, safeRecipeFileName, validateRecipeRecord,
} from "./domain/project-recipes-storage-rules.js";
import {
  buildProjectRecipeKnowledge, readProjectRecipes, readUnpublishedProjectSnapshotPin,
} from "./project-recipes.js";
import {
  projectRecordSchema, projectRecipeSchema, projectThreadSchema,
} from "./project-recipes-contracts.js";
import {
  projectMutationInputs, projectMutationPlanSchema, projectMutationReadDefinitions,
  type ProjectMutationFile, type ProjectMutationOperation, type ProjectMutationPlan,
  type ProjectMutationRequest, type ProjectMutationPlanResult,
} from "./project-mutations-contracts.js";
import type { MarkdownRecord } from "./markdown.js";

export { projectMutationDefinitions, projectMutationReadDefinitions } from "./project-mutations-contracts.js";
export type {
  ProjectMutationFile, ProjectMutationOperation, ProjectMutationPlan, ProjectMutationRequest,
  ProjectMutationPlanResult,
} from "./project-mutations-contracts.js";

const MAX_FILE_BYTES = 2 * 1024 * 1024;
const MAX_PLAN_BYTES = 8 * 1024 * 1024;
const runtimeGuardPaths = [
  ".pkm/state/actions/runs",
  ".pkm/state/agent-sessions",
  ".pkm/state/recipe-runs",
] as const;
interface Snapshot {
  snapshotRevision: string;
  actorId: string;
  workspaceId: string;
  projects: Array<Record<string, any>>;
  recipes: Array<Record<string, any>>;
}

interface MutationPlanOptions {
  rootPin: string;
  actorId: string;
  workspaceId: string;
  files: ProjectMutationFile[];
  guards?: Array<{ relativePath: string; sha256: string }>;
  result: ProjectMutationPlanResult;
}

function fail(code: string, message: string): never {
  throw new CoreError(code, message);
}

function parseArgs(operationName: ProjectMutationOperation, args: unknown): Record<string, any> {
  const parsed = projectMutationInputs[operationName].safeParse(args);
  if (!parsed.success) fail("INVALID_ARGUMENT", `Invalid ${operationName} mutation: ${parsed.error.message}`);
  return parsed.data as Record<string, any>;
}

function readSnapshot(root: string, actorId: string): Snapshot {
  const projectPage = readProjectRecipes(root, {
    operation: "project.list", args: { offset: 0, limit: 100 }, actorId: "project-mutation",
  }) as { items: Array<Record<string, any>>; total: number; nextOffset: number | null; snapshotRevision: string };
  const projects = [...projectPage.items];
  for (let offset = projectPage.nextOffset; offset !== null;) {
    const page = readProjectRecipes(root, {
      operation: "project.list",
      args: { offset, limit: 100, snapshotRevision: projectPage.snapshotRevision },
      actorId: "project-mutation",
    }) as typeof projectPage;
    projects.push(...page.items);
    offset = page.nextOffset;
  }
  const recipePage = readProjectRecipes(root, {
    operation: "project.recipe.list",
    args: { offset: 0, limit: 100, snapshotRevision: projectPage.snapshotRevision },
    actorId: "project-mutation",
  }) as { items: Array<Record<string, any>>; total: number; nextOffset: number | null; snapshotRevision: string };
  const recipes = [...recipePage.items];
  for (let offset = recipePage.nextOffset; offset !== null;) {
    const page = readProjectRecipes(root, {
      operation: "project.recipe.list",
      args: { offset, limit: 100, snapshotRevision: projectPage.snapshotRevision },
      actorId: "project-mutation",
    }) as typeof recipePage;
    recipes.push(...page.items);
    offset = page.nextOffset;
  }
  if (projects.length !== projectPage.total || recipes.length !== recipePage.total
    || recipePage.snapshotRevision !== projectPage.snapshotRevision) {
    fail("CONFLICT", "Project/Recipe snapshot changed while preparing the mutation.");
  }
  return { snapshotRevision: projectPage.snapshotRevision, actorId, workspaceId: readWorkspaceId(root), projects, recipes };
}

function assertSnapshotPin(snapshot: Snapshot, pin: string): void {
  if (snapshot.snapshotRevision !== pin) fail("CONFLICT", "Project/Recipe snapshot changed; rediscover before mutating.");
}

function currentProject(root: string, snapshot: Snapshot, projectId: string, version?: number): Record<string, any> {
  const result = readProjectRecipes(root, {
    operation: "project.get",
    args: { id: projectId, ...(version === undefined ? {} : { expectedVersion: version }), snapshotRevision: snapshot.snapshotRevision },
    actorId: "project-mutation",
  }) as { item: Record<string, any> };
  return result.item;
}

function currentRecipe(root: string, snapshot: Snapshot, recipeId: string, revision?: number, executableDigest?: string): Record<string, any> {
  const result = readProjectRecipes(root, {
    operation: "project.recipe.get",
    args: {
      id: recipeId,
      ...(revision === undefined ? {} : { expectedRevision: revision }),
      ...(executableDigest === undefined ? {} : { expectedExecutableDigest: executableDigest }),
      snapshotRevision: snapshot.snapshotRevision,
    },
    actorId: "project-mutation",
  }) as { item: Record<string, any> };
  return result.item;
}

function projectPath(project: Record<string, any>): string {
  return `project/${safeProjectDirectoryName(project.name, project.projectId)}/project.json`;
}

function threadPath(project: Record<string, any>, threadId: string): string {
  return `project/${safeProjectDirectoryName(project.name, project.projectId)}/threads/${threadId}.json`;
}

function recipePath(recipe: Record<string, any>): string {
  const category = normalizeRecipeCategory(recipe.category);
  return `recipes/${category || "Uncategorized"}/${safeRecipeFileName(recipe.name, recipe.recipeId)}`;
}

function deterministicUuid(seed: string): string {
  const bytes = createHash("sha256").update(seed, "utf8").digest().subarray(0, 16);
  bytes[6] = (bytes[6]! & 0x0f) | 0x50;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = bytes.toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function stableEntityId(prefix: string, operationId: string): string {
  return `${prefix}${deterministicUuid(`${operationId}\0${prefix}`)}`;
}

function jsonBytes(value: unknown): Buffer {
  const bytes = Buffer.from(`${JSON.stringify(value, null, 2)}\n`, "utf8");
  if (bytes.length > MAX_FILE_BYTES) fail("RESOURCE_LIMIT", "Mutation result exceeds the original 2 MiB file limit.");
  return bytes;
}

function checkedAbsolute(root: string, relativePath: string): string {
  const absoluteRoot = resolve(root);
  if (!relativePath || relativePath.includes("\\") || relativePath.startsWith("/")
    || relativePath.split("/").some(part => !part || part === "." || part === "..")) {
    fail("INVALID_DOCUMENT", "Mutation plan contains a non-portable target path.");
  }
  const absolute = resolve(absoluteRoot, ...relativePath.split("/"));
  const local = relative(absoluteRoot, absolute);
  if (!local || local === ".." || local.startsWith(`..${sep}`) || resolve(absoluteRoot, local) !== absolute) {
    fail("INVALID_DOCUMENT", "Mutation plan target escapes the isolated workspace.");
  }
  return absolute;
}

function assertNoSymlinkAncestors(path: string): void {
  let current = resolve(path);
  const initial = current;
  while (true) {
    let stat;
    try { stat = lstatSync(current); }
    catch (error) {
      if (isMissing(error)) {
        current = resolve(current, "..");
        if (current === resolve(current, "..")) break;
        continue;
      } else {
        throw new CoreError("INVALID_WORKSPACE", "Could not inspect a mutation path component.");
      }
    }
    if (stat.isSymbolicLink()) fail("INVALID_WORKSPACE", "Mutation paths containing symlinks are not supported.");
    if (current !== initial && !stat.isDirectory()) fail("INVALID_WORKSPACE", "Mutation path ancestors must be directories.");
    const parent = resolve(current, "..");
    if (parent === current) break;
    current = parent;
  }
}

function readFileState(root: string, relativePath: string): { bytes: Buffer; digest: string } | undefined {
  const absolute = checkedAbsolute(root, relativePath);
  assertNoSymlinkAncestors(absolute);
  let stat;
  try { stat = lstatSync(absolute); }
  catch (error) {
    if (isMissing(error)) return undefined;
    throw new CoreError("INVALID_WORKSPACE", "Could not inspect a mutation target.");
  }
  if (!stat.isFile() || stat.isSymbolicLink()) fail("INVALID_DOCUMENT", "Mutation target is not a regular file.");
  if (stat.size > MAX_FILE_BYTES) fail("RESOURCE_LIMIT", "Mutation target exceeds the original 2 MiB file limit.");
  const bytes = readFileSync(absolute);
  return { bytes, digest: sha256(bytes) };
}

function readWorkspaceId(root: string): string {
  const marker = readFileState(root, ".pkm-next-workspace");
  if (!marker || marker.bytes.length > 4096) fail("INVALID_WORKSPACE", "A valid isolated next-server workspace marker is required.");
  let value: unknown;
  try { value = JSON.parse(marker.bytes.toString("utf8")); }
  catch { fail("INVALID_WORKSPACE", "Isolated workspace marker is malformed."); }
  if (!value || typeof value !== "object" || !("schema" in value) || value.schema !== "pkm.next-workspace/v2"
    || !("id" in value) || !projectMutationPlanSchema.shape.workspaceId.safeParse(value.id).success) {
    fail("INVALID_WORKSPACE", "Isolated workspace marker has an invalid identity.");
  }
  return value.id as string;
}

export function readProjectMutationPin(
  root: string,
  request: { operation: "project.mutation.pin"; args: Record<string, unknown>; actorId: string },
): { entityKind: "project" | "recipe"; entityId: string; version: number; sha256: string; snapshotRevision: string; executableDigest?: string } {
  const parsed = projectMutationReadDefinitions[0].input.safeParse(request.args);
  if (request.operation !== "project.mutation.pin" || !parsed.success) fail("INVALID_ARGUMENT", "Invalid Project mutation pin request.");
  const snapshot = readSnapshot(root, request.actorId);
  if (parsed.data.snapshotRevision !== undefined) assertSnapshotPin(snapshot, parsed.data.snapshotRevision);
  const isProject = parsed.data.entityKind === "project";
  const item = isProject ? currentProject(root, snapshot, parsed.data.id) : currentRecipe(root, snapshot, parsed.data.id);
  const file = readFileState(root, isProject ? projectPath(item) : recipePath(item));
  if (!file) fail("NOT_FOUND", "Entity is not stored at its normalized mutation path.");
  verifySnapshotUnchanged(root, snapshot.snapshotRevision);
  return projectMutationReadDefinitions[0].output.parse({
    entityKind: parsed.data.entityKind, entityId: parsed.data.id, version: isProject ? item.version : item.revision,
    sha256: file.digest, snapshotRevision: snapshot.snapshotRevision,
    ...(isProject ? {} : { executableDigest: item.executableDigest }),
  });
}

function fileChange(root: string, relativePath: string, after: Buffer | null, order: number): ProjectMutationFile {
  const before = readFileState(root, relativePath);
  return {
    relativePath, order,
    beforeSha256: before?.digest ?? null,
    beforeBase64: before?.bytes.toString("base64") ?? null,
    afterSha256: after ? sha256(after) : null,
    afterBase64: after?.toString("base64") ?? null,
  };
}

function checkEntitySha(root: string, relativePath: string, expectedSha256: string): Buffer {
  const current = readFileState(root, relativePath);
  if (!current || current.digest !== expectedSha256) fail("CONFLICT", "Entity file SHA256 changed; rediscover before mutating.");
  return current.bytes;
}

function result(
  operation: ProjectMutationOperation,
  operationId: string,
  snapshotRevision: string,
  entityKind: "project" | "recipe",
  item: Record<string, any>,
  createdThread?: Record<string, any>,
): ProjectMutationPlanResult {
  return {
    operationId, operation, entityKind, entityId: entityKind === "project" ? item.projectId : item.recipeId,
    version: entityKind === "project" ? item.version : item.revision,
    snapshotRevision, item, ...(createdThread ? { createdThread } : {}),
  } as ProjectMutationPlanResult;
}

function createPlan(
  operation: ProjectMutationOperation,
  operationId: string,
  options: MutationPlanOptions,
): ProjectMutationPlan {
  const plan = projectMutationPlanSchema.parse({
    schema: "pkm.project-mutation-plan/v1",
    operationId, operation, rootPin: options.rootPin, actorId: options.actorId, workspaceId: options.workspaceId,
    files: options.files.sort((left, right) => left.order - right.order),
    guards: options.guards || [],
    result: options.result,
  });
  validatePlan(plan);
  return plan;
}

function projectCreatePlan(root: string, args: Record<string, any>, snapshot: Snapshot): ProjectMutationPlan {
  assertSnapshotPin(snapshot, args.expectedSnapshotRevision);
  const defaults = snapshot.projects.filter(item => item.systemKind === "default-project");
  if (defaults.length !== 1) fail("CONFLICT", "Canonical Default Project is missing or ambiguous; mutations never initialize or repair it.");
  currentProject(root, snapshot, defaults[0]!.projectId);
  const operationId = args.operationId as string;
  const sources = (args.sources || []) as Array<{ kind: string; id: string }>;
  const chat = sources.find(link => link.kind === "chat");
  const promoted = chat && snapshot.projects.find(project =>
    (project.links || []).some((link: { kind: string; id: string }) => link.kind === "chat" && link.id === chat.id));
  if (promoted) {
    const item = currentProject(root, snapshot, promoted.projectId);
    const plan = createPlan("project.create", operationId, {
      rootPin: snapshot.snapshotRevision, actorId: snapshot.actorId, workspaceId: snapshot.workspaceId, files: [],
      result: result("project.create", operationId, snapshot.snapshotRevision, "project", item),
    });
    verifySnapshotUnchanged(root, snapshot.snapshotRevision);
    return plan;
  }
  const projectId = stableEntityId("project_", operationId);
  if (snapshot.projects.some(item => item.projectId === projectId)) fail("CONFLICT", "Generated Project identity already exists.");
  const createdAt = args.at as string;
  const templates: Record<string, Record<string, unknown>> = {
    research: {
      goal: "Produce a source-backed research synthesis",
      successCriteria: ["Trace key claims to evidence", "Record inclusion and exclusion reasons"],
      currentMilestone: "Scope and collect", status: "planned",
    },
    delivery: {
      goal: "Deliver a reviewed outcome",
      successCriteria: ["Verify acceptance criteria", "Retain review evidence"],
      currentMilestone: "Define outcome", status: "planned",
    },
  };
  if (args.template && !templates[args.template]) fail("INVALID_ARGUMENT", "Unknown Project template.");
  const project: Record<string, any> = {
    projectId, name: String(args.name).trim(), version: 1,
    timeline: [{
      eventId: stableEntityId("event_", `${operationId}:created`), at: createdAt,
      kind: "project-created", summary: args.template ? `Created from ${args.template} template` : "Created blank Project",
    }],
  };
  const input = { ...(templates[args.template] || {}), ...(args.overview || {}) };
  const fields = ["goal", "successCriteria", "status", "currentMilestone", "owner", "deadline", "autonomyPolicyReference"] as const;
  const changed: Array<{ field: string; before: unknown; after: unknown }> = [];
  for (const field of fields) {
    if (input[field] === undefined) continue;
    const value: unknown = field === "successCriteria"
      ? (input[field] as string[]).map(item => item.trim()).filter(Boolean)
      : String(input[field]).trim();
    if (field === "deadline" && value && (typeof value !== "string" || !validDate(value))) fail("INVALID_ARGUMENT", "Deadline must be a valid ISO calendar date.");
    const previous = field === "successCriteria" ? [] : "";
    if (JSON.stringify(previous) !== JSON.stringify(value)) {
      project[field] = value;
      changed.push({ field, before: previous, after: value });
    }
  }
  if (changed.length) {
    project.version += 1;
    const changedContract = changed.some(change => change.field === "goal" || change.field === "successCriteria");
    const eventId = stableEntityId("event_", `${operationId}:initial-overview`);
    const decisionId = changedContract ? stableEntityId("decision_", `${operationId}:initial-overview`) : eventId;
    if (changedContract) {
      project.decisions = [{
        decisionId, at: createdAt, reason: "Initial Project intent", changes: changed,
      }];
    }
    const sourcePatterns: Record<string, RegExp> = {
      "action-run": /^action_run_[0-9a-f]{32}$/,
      "recipe-run": /^[A-Za-z][A-Za-z0-9_-]{1,127}$/,
      "agent-session": /^agent_session_[A-Za-z0-9_-]+$/,
      chat: /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/,
    };
    for (let index = 0; index < sources.length; index += 1) {
      const source = sources[index]!;
      if (!sourcePatterns[source.kind]?.test(source.id)) fail("INVALID_ARGUMENT", "Invalid Project source identity.");
      if ((project.links || []).some((link: { kind: string; id: string }) => link.kind === source.kind && link.id === source.id)) continue;
      project.version += 1;
      project.links = [...(project.links || []), { ...source, linkedAt: createdAt }];
      project.timeline.push({
        eventId: stableEntityId("event_", `${operationId}:source:${index}`),
        at: createdAt, kind: "source-linked", summary: `Linked ${source.kind}`, sourceId: source.id,
      });
    }
    project.timeline.push({
      eventId, at: createdAt,
      kind: changedContract ? "decision" : "overview-updated",
      summary: changedContract ? "Initial Project intent" : "Project overview updated",
      sourceId: decisionId,
    });
  }
  const thread: Record<string, any> = {
    threadId: deriveSystemId(projectId, "pkm/general-thread/v1"), projectId,
    name: "General", description: "", archived: false,
    legacyAliases: [], version: 1,
  };
  const projectBytes = jsonBytes(project);
  const threadBytes = jsonBytes(thread);
  const planResult = result("project.create", operationId, snapshot.snapshotRevision, "project", project, thread);
  const files = [
    fileChange(root, projectPath(project), projectBytes, 0),
    fileChange(root, threadPath(project, thread.threadId), threadBytes, 1),
  ];
  if (files.some(file => file.beforeSha256 !== null)) fail("CONFLICT", "Generated Project or General Thread target already exists.");
  const plan = createPlan("project.create", operationId, {
    rootPin: snapshot.snapshotRevision, actorId: snapshot.actorId, workspaceId: snapshot.workspaceId,
    files,
    result: planResult,
  });
  verifySnapshotUnchanged(root, snapshot.snapshotRevision);
  return plan;
}

function projectUpdatePlan(root: string, args: Record<string, any>, snapshot: Snapshot): ProjectMutationPlan {
  assertSnapshotPin(snapshot, args.expectedSnapshotRevision);
  const current = currentProject(root, snapshot, args.projectId, args.expectedVersion);
  if (current.archivedAt || current.deletedAt) fail("CONFLICT", "Archived or deleted Projects cannot be edited.");
  const path = projectPath(current);
  const beforeBytes = checkEntitySha(root, path, args.expectedSha256);
  const next = structuredClone(current);
  const changes: Array<{ field: string; before: unknown; after: unknown }> = [];
  const fields = ["goal", "successCriteria", "status", "currentMilestone", "owner", "deadline", "autonomyPolicyReference"] as const;
  for (const field of fields) {
    const raw = args.overview[field];
    if (raw === undefined) continue;
    const value: unknown = field === "successCriteria" ? (raw as string[]).map(item => item.trim()).filter(Boolean) : String(raw).trim();
    if (field === "deadline" && value && (typeof value !== "string" || !validDate(value))) fail("INVALID_ARGUMENT", "Deadline must be a valid ISO calendar date.");
    const previous = current[field] ?? (field === "successCriteria" ? [] : "");
    if (JSON.stringify(previous) === JSON.stringify(value)) continue;
    next[field] = value;
    changes.push({ field, before: previous, after: value });
  }
  let afterBytes: Buffer | null = null;
  if (changes.length) {
    const changedContract = changes.some(change => change.field === "goal" || change.field === "successCriteria");
    if (changedContract && !String(args.reason).trim()) fail("INVALID_ARGUMENT", "Goal or success-criteria changes require an explicit reason.");
    next.version += 1;
    const decisionId = stableEntityId("decision_", `${args.operationId}:project-update`);
    const eventId = stableEntityId("event_", `${args.operationId}:project-update`);
    if (changedContract) {
      next.decisions = [...(current.decisions || []), {
        decisionId, at: args.at, reason: String(args.reason).trim(), changes,
      }];
    }
    next.timeline = [...(current.timeline || []), {
      eventId, at: args.at,
      kind: changedContract ? "decision" : "overview-updated",
      summary: changedContract ? String(args.reason).trim() : "Project overview updated",
      sourceId: decisionId,
    }];
    afterBytes = jsonBytes(next);
  }
  const plan = createPlan("project.update", args.operationId, {
    rootPin: snapshot.snapshotRevision, actorId: snapshot.actorId, workspaceId: snapshot.workspaceId,
    files: [fileChange(root, path, afterBytes || beforeBytes, 0)],
    result: result("project.update", args.operationId, snapshot.snapshotRevision, "project", changes.length ? next : current),
  });
  if (beforeBytes.length > MAX_FILE_BYTES) fail("RESOURCE_LIMIT", "Project record exceeds the original file limit.");
  verifySnapshotUnchanged(root, snapshot.snapshotRevision);
  return plan;
}

function projectArchivePlan(root: string, args: Record<string, any>, snapshot: Snapshot): ProjectMutationPlan {
  assertSnapshotPin(snapshot, args.expectedSnapshotRevision);
  const current = currentProject(root, snapshot, args.projectId, args.expectedVersion);
  if (current.systemKind === "default-project") fail("CONFLICT", "The Default Project cannot be archived.");
  const path = projectPath(current);
  checkEntitySha(root, path, args.expectedSha256);
  const guards = checkRuntimeEmpty(root);
  const next = {
    ...current,
    version: current.version + 1,
    archivedAt: args.at,
    timeline: [...(current.timeline || []), {
      eventId: stableEntityId("event_", `${args.operationId}:project-archive`),
      at: args.at, kind: "project-archive", summary: "Project archive",
    }],
  };
  const plan = createPlan("project.archive", args.operationId, {
    rootPin: snapshot.snapshotRevision, actorId: snapshot.actorId, workspaceId: snapshot.workspaceId,
    files: [fileChange(root, path, jsonBytes(next), 0)],
    guards,
    result: result("project.archive", args.operationId, snapshot.snapshotRevision, "project", next),
  });
  verifySnapshotUnchanged(root, snapshot.snapshotRevision);
  return plan;
}

function projectRecipeCreatePlan(root: string, args: Record<string, any>, documents: MarkdownRecord[], snapshot: Snapshot): ProjectMutationPlan {
  assertSnapshotPin(snapshot, args.expectedSnapshotRevision);
  let category = normalizeRecipeCategory(args.category);
  if (args.scope === "project") {
    const project = currentProject(root, snapshot, args.projectId);
    const prefix = `Project/${safeRecipeCategorySegment(project.name)}`;
    category = normalizeRecipeCategory([prefix, category].filter(Boolean).join("/"));
  }
  const operationId = args.operationId as string;
  const recipeId = stableEntityId("recipe_", operationId);
  if (snapshot.recipes.some(recipe => recipe.recipeId === recipeId)) fail("CONFLICT", "Generated Recipe identity already exists.");
  const knowledgeId = `knowledge_${createHash("sha256").update(`recipe\0${recipeId}`, "utf8").digest("hex").slice(0, 24)}`;
  if (snapshot.recipes.some(recipe => recipe.knowledgeId === knowledgeId)) fail("CONFLICT", "Generated Recipe Knowledge identity already exists.");
  const compiled = compileWorkflowDefinitionV1({
    schema: WORKFLOW_DEFINITION_SCHEMA,
    spec: {
      inputs: {}, nodes: [{ nodeId: "start", kind: NOOP_NODE_KIND, config: {}, dependsOn: [] }],
      outputs: {}, completion: { requiredNodes: ["start"] },
    },
  });
  if (!compiled.ok) fail("INVALID_DOCUMENT", "Original no-op Recipe template did not compile.");
  const path = recipePath({ recipeId, name: String(args.name).trim(), category });
  const aliases = [...new Set([
    legacyKnowledgeAlias("recipe", recipeId),
    legacyKnowledgeAlias("recipe", path.slice("recipes/".length)),
  ])].sort();
  const recipe: Record<string, any> = {
    schema: "pkm.knowledge/v1", knowledgeId, aliases,
    recipeId, scope: "global", ...(category ? { category } : {}),
    name: String(args.name).trim(), description: "", definition: compiled.model,
    executableDigest: compiled.executableDigest, revision: 1,
  };
  validateStoredRecipe(recipe);
  buildProjectRecipeKnowledge(root, documents, [recipe]);
  const bytes = jsonBytes(recipe);
  const file = fileChange(root, path, bytes, 0);
  if (file.beforeSha256 !== null) fail("CONFLICT", "Generated Recipe target already exists.");
  const plan = createPlan("project.recipe.create", operationId, {
    rootPin: snapshot.snapshotRevision, actorId: snapshot.actorId, workspaceId: snapshot.workspaceId,
    files: [file],
    result: result("project.recipe.create", operationId, snapshot.snapshotRevision, "recipe", recipe),
  });
  verifyPlanBindings(root, plan, documents);
  verifySnapshotUnchanged(root, snapshot.snapshotRevision);
  return plan;
}

function projectRecipeUpdatePlan(root: string, args: Record<string, any>, documents: MarkdownRecord[], snapshot: Snapshot): ProjectMutationPlan {
  assertSnapshotPin(snapshot, args.expectedSnapshotRevision);
  const current = currentRecipe(root, snapshot, args.recipeId, args.expectedRevision, args.expectedExecutableDigest);
  if (current.systemKind === "built-in") fail("CONFLICT", "Built-in Recipes are read-only; fork the Recipe before customization.");
  const oldPath = recipePath(current);
  checkEntitySha(root, oldPath, args.expectedSha256);
  const compiled = compileWorkflowDefinitionV1(args.definition);
  if (!compiled.ok) fail("INVALID_ARGUMENT", "Recipe workflow definition is invalid.");
  const methodSource = args.methodology ?? current.methodology;
  const methodology = methodSource === undefined ? undefined : compileRecipeMethodologyV1(methodSource);
  if (methodology && !methodology.ok) fail("INVALID_ARGUMENT", "Recipe Methodology Manifest is invalid.");
  const nodeIds = new Set(compiled.model.spec.nodes.map(node => node.nodeId));
  const layout: Record<string, { x: number; y: number }> = args.editorLayout?.nodePositions ?? current.editorLayout?.nodePositions ?? {};
  const nodePositions = Object.fromEntries(Object.entries(layout)
    .filter(([nodeId, position]) => nodeIds.has(nodeId) && Number.isFinite(position?.x) && Number.isFinite(position?.y))
    .map(([nodeId, position]) => [nodeId, { x: Math.max(0, Math.round(position.x)), y: Math.max(0, Math.round(position.y)) }]));
  const sourceBindings = args.nodeBindings ?? current.nodeBindings ?? [];
  const nodeBindings = normalizeBindings(sourceBindings, nodeIds);
  const metadata = normalizeMetadata(args.metadata || current.metadata);
  const category = normalizeRecipeCategory(String(args.category).trim());
  const updated: Record<string, any> = {
    ...current,
    name: String(args.name).trim(),
    ...(category ? { category } : {}),
    description: String(args.description).trim(),
    metadata,
    ...(methodology?.ok ? { methodology: methodology.model, methodologyDigest: methodology.methodologyDigest } : {}),
    ...(Object.keys(nodePositions).length ? { editorLayout: { nodePositions } } : {}),
    definition: compiled.model,
    ...(nodeBindings.length ? { nodeBindings } : {}),
    executableDigest: compiled.executableDigest,
    revision: current.revision + 1,
  };
  if (!category) delete updated.category;
  if (!nodeBindings.length) delete updated.nodeBindings;
  if (!methodology && current.methodology === undefined) {
    delete updated.methodology;
    delete updated.methodologyDigest;
  }
  const newPath = recipePath(updated);
  if (newPath !== oldPath && readFileState(root, newPath)) {
    fail("CONFLICT", "The normalized Recipe destination already contains a file.");
  }
  updated.aliases = [...new Set([
    ...(current.aliases || []),
    legacyKnowledgeAlias("recipe", current.recipeId),
    legacyKnowledgeAlias("recipe", oldPath.slice("recipes/".length)),
    legacyKnowledgeAlias("recipe", newPath.slice("recipes/".length)),
  ])].sort();
  validateStoredRecipe(updated);
  buildProjectRecipeKnowledge(root, documents, [updated]);
  const existingOther = snapshot.recipes.find(recipe => recipe.recipeId !== updated.recipeId
    && (recipe.knowledgeId === updated.knowledgeId || recipe.recipeId === updated.recipeId));
  if (existingOther) fail("CONFLICT", "Recipe identity or Knowledge identity conflicts with another Recipe.");
  const files = newPath === oldPath
    ? [fileChange(root, oldPath, jsonBytes(updated), 0)]
    : [
      fileChange(root, newPath, jsonBytes(updated), 0),
      fileChange(root, oldPath, null, 1),
    ];
  const plan = createPlan("project.recipe.update", args.operationId, {
    rootPin: snapshot.snapshotRevision, actorId: snapshot.actorId, workspaceId: snapshot.workspaceId,
    files,
    result: result("project.recipe.update", args.operationId, snapshot.snapshotRevision, "recipe", updated),
  });
  verifyPlanBindings(root, plan, documents);
  verifySnapshotUnchanged(root, snapshot.snapshotRevision);
  return plan;
}

export function planProjectMutation(
  root: string,
  request: ProjectMutationRequest,
  documents: MarkdownRecord[] = [],
): ProjectMutationPlan {
  const operation = request.operation;
  if (!operation || !(operation in projectMutationInputs)) fail("NOT_FOUND", "Unknown Project mutation operation.");
  const args = parseArgs(operation, request.args);
  if (!Array.isArray(documents)) fail("INVALID_ARGUMENT", "Recipe Knowledge documents must be an array.");
  if (typeof request.actorId !== "string" || !request.actorId.trim() || request.actorId.length > 500) {
    fail("INVALID_ARGUMENT", "A trusted mutation actor identity is required.");
  }
  const snapshot = readSnapshot(root, request.actorId);
  switch (operation) {
    case "project.create": return projectCreatePlan(root, args, snapshot);
    case "project.update": return projectUpdatePlan(root, args, snapshot);
    case "project.archive": return projectArchivePlan(root, args, snapshot);
    case "project.recipe.create": return projectRecipeCreatePlan(root, args, documents, snapshot);
    case "project.recipe.update": return projectRecipeUpdatePlan(root, args, documents, snapshot);
  }
}

export function serializeProjectMutationPlan(plan: ProjectMutationPlan): string {
  validatePlan(plan);
  const serialized = JSON.stringify(plan);
  if (Buffer.byteLength(serialized, "utf8") > MAX_PLAN_BYTES) fail("RESOURCE_LIMIT", "Project mutation journal plan exceeds 8 MiB.");
  return serialized;
}

export function deserializeProjectMutationPlan(value: string | unknown): ProjectMutationPlan {
  let decoded = value;
  if (typeof value === "string") {
    if (Buffer.byteLength(value, "utf8") > MAX_PLAN_BYTES) fail("RESOURCE_LIMIT", "Project mutation journal plan exceeds 8 MiB.");
    try { decoded = JSON.parse(value); }
    catch { fail("INVALID_DOCUMENT", "Project mutation journal plan is not valid JSON."); }
  }
  const plan = projectMutationPlanSchema.safeParse(decoded);
  if (!plan.success) fail("INVALID_DOCUMENT", "Project mutation journal plan has an invalid shape.");
  validatePlan(plan.data);
  return plan.data;
}

export type ProjectMutationRecovery =
  | { state: "missing"; operationId: string }
  | { state: "complete"; operationId: string; result: ProjectMutationPlanResult }
  | { state: "unknown"; operationId: string; reason: string };

export function recoverProjectMutation(
  root: string,
  value: ProjectMutationPlan | string | unknown,
  documents: MarkdownRecord[] = [],
): ProjectMutationRecovery {
  return runProjectMutation(root, value, documents, false);
}

export function applyProjectMutation(
  root: string,
  value: ProjectMutationPlan | string | unknown,
  documents: MarkdownRecord[] = [],
): ProjectMutationRecovery {
  return runProjectMutation(root, value, documents, true);
}

function runProjectMutation(
  root: string,
  value: ProjectMutationPlan | string | unknown,
  documents: MarkdownRecord[],
  applyMissing: boolean,
): ProjectMutationRecovery {
  let plan: ProjectMutationPlan;
  try { plan = deserializeProjectMutationPlan(value); }
  catch (error) {
    const operationId = typeof value === "object" && value !== null && "operationId" in value
      ? String((value as { operationId: unknown }).operationId) : "unknown";
    return { state: "unknown", operationId, reason: error instanceof Error ? error.message : "Invalid mutation plan." };
  }
  try {
    if (readWorkspaceId(root) !== plan.workspaceId) {
      return { state: "unknown", operationId: plan.operationId, reason: "Workspace identity differs from the committed plan." };
    }
    verifyPlanBindings(root, plan, documents);
    const states = plan.files.map(file => classifyFile(root, file));
    if (states.includes("unknown")) {
      return { state: "unknown", operationId: plan.operationId, reason: "A target file matches neither its pinned before nor after bytes." };
    }
    if (!checkGuards(root, plan.guards)) {
      return { state: "unknown", operationId: plan.operationId, reason: "A guarded isolated runtime path changed after planning." };
    }
    if (!plan.files.length) {
      verifySnapshotUnchanged(root, plan.rootPin);
      if (plan.operation !== "project.create") {
        return { state: "unknown", operationId: plan.operationId, reason: "No-op plan operation is invalid." };
      }
      const current = readProjectRecipes(root, {
        operation: "project.get",
        args: { id: plan.result.entityId, snapshotRevision: plan.rootPin },
        actorId: plan.actorId,
      }) as { item: Record<string, any> };
      if (canonicalJson(current.item) !== canonicalJson(plan.result.item)
        || !(current.item.links || []).some((link: { kind: string }) => link.kind === "chat")) {
        return { state: "unknown", operationId: plan.operationId, reason: "Promoted Project no longer matches its pinned chat-linked record." };
      }
      return { state: "complete", operationId: plan.operationId, result: plan.result };
    }
    if (states.every(state => state === "after")) {
      return { state: "complete", operationId: plan.operationId, result: plan.result };
    }
    if (states.every(state => state === "before")) {
      if (!applyMissing) return { state: "missing", operationId: plan.operationId };
      if (plan.operation === "project.create") {
        // A failed atomic publication can leave only the plan-owned parent directories.
        for (const path of [dirname(plan.files[0]!.relativePath)]) {
          const target = checkedAbsolute(root, path);
          assertNoSymlinkAncestors(target);
          try {
            const stat = lstatSync(target);
            if (!stat.isDirectory() || stat.isSymbolicLink() || readdirSync(target).length) {
              return { state: "unknown", operationId: plan.operationId, reason: "Unpublished Project directory contains unrecognized entries." };
            }
            if (readUnpublishedProjectSnapshotPin(root, path.split("/").at(-1)!) !== plan.rootPin) {
              return { state: "unknown", operationId: plan.operationId, reason: "Original snapshot changed before unpublished Project recovery." };
            }
            rmdirSync(target);
            syncDirectory(dirname(target));
          } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
          }
        }
      }
      verifySnapshotUnchanged(root, plan.rootPin);
    }
    for (const file of [...plan.files].sort((left, right) => left.order - right.order)) {
      if (classifyFile(root, file) === "after") continue;
      const target = checkedAbsolute(root, file.relativePath);
      assertNoSymlinkAncestors(target);
      if (file.afterBase64 === null) {
        const current = readFileState(root, file.relativePath);
        if (!current || current.digest !== file.beforeSha256) {
          return { state: "unknown", operationId: plan.operationId, reason: "A delete target changed before recovery." };
        }
        unlinkSync(target);
        syncDirectory(dirname(target));
      } else {
        const content = Buffer.from(file.afterBase64, "base64");
        mkdirSync(dirname(target), { recursive: true });
        atomicFileWrite(target, content, file.beforeSha256, plan.operationId);
      }
    }
    const recovered = plan.files.map(file => classifyFile(root, file));
    if (recovered.every(state => state === "after") && checkGuards(root, plan.guards)) {
      return { state: "complete", operationId: plan.operationId, result: plan.result };
    }
    return { state: "unknown", operationId: plan.operationId, reason: "Mutation recovery did not reach the planned after-state." };
  } catch (error) {
    return { state: "unknown", operationId: plan.operationId, reason: error instanceof Error ? error.message : "Mutation recovery failed." };
  }
}

function classifyFile(root: string, file: ProjectMutationFile): "before" | "after" | "unknown" {
  const current = readFileState(root, file.relativePath);
  const digest = current?.digest ?? null;
  if (digest === file.afterSha256 && (current?.bytes.toString("base64") ?? null) === file.afterBase64) return "after";
  if (digest === file.beforeSha256 && (current?.bytes.toString("base64") ?? null) === file.beforeBase64) return "before";
  return "unknown";
}

function validatePlan(plan: ProjectMutationPlan): void {
  const parsed = projectMutationPlanSchema.safeParse(plan);
  if (!parsed.success) fail("INVALID_DOCUMENT", "Project mutation plan has an invalid shape.");
  const data = parsed.data;
  const resultItem = data.result.item as any;
  if (data.result.operationId !== data.operationId || data.result.operation !== data.operation
    || data.result.snapshotRevision !== data.rootPin
    || data.result.entityKind !== (data.operation.startsWith("project.recipe.") ? "recipe" : "project")
    || data.result.entityId !== (data.result.entityKind === "project"
      ? resultItem.projectId : resultItem.recipeId)
    || data.result.version !== (data.result.entityKind === "project"
      ? resultItem.version : resultItem.revision)) {
    fail("INVALID_DOCUMENT", "Mutation plan result does not match its operation and entity.");
  }
  if (data.files.reduce((sum, file) => sum + decodedSize(file.beforeBase64) + decodedSize(file.afterBase64), 0) > MAX_PLAN_BYTES) {
    fail("RESOURCE_LIMIT", "Mutation plan bytes exceed the 8 MiB limit.");
  }
  const paths = new Set<string>();
  const orders = new Set<number>();
  for (const file of data.files) {
    checkedAbsolute(".", file.relativePath);
    if (paths.has(file.relativePath) || orders.has(file.order)) fail("INVALID_DOCUMENT", "Mutation plan targets or orders are duplicated.");
    paths.add(file.relativePath);
    orders.add(file.order);
    validateEncoded(file.beforeBase64, file.beforeSha256);
    validateEncoded(file.afterBase64, file.afterSha256);
  }
  if (data.files.length > 1 && data.files.length !== 2) fail("INVALID_DOCUMENT", "Mutation plan contains too many writes.");
  validateOperationFiles(data);
  for (const guard of data.guards) {
    if (!runtimeGuardPaths.includes(guard.relativePath as typeof runtimeGuardPaths[number])) {
      fail("INVALID_DOCUMENT", "Mutation plan contains an unsupported runtime guard.");
    }
  }
  if (data.operation !== "project.archive" && data.guards.length) fail("INVALID_DOCUMENT", "Only Project archive plans may contain runtime guards.");
  if (data.operation === "project.archive" && (data.guards.length !== runtimeGuardPaths.length
    || new Set(data.guards.map(guard => guard.relativePath)).size !== runtimeGuardPaths.length
    || data.guards.some(guard => guard.sha256 !== sha256("missing\0") && guard.sha256 !== sha256("directory\0")))) {
    fail("INVALID_DOCUMENT", "Project archive requires all three original runtime safety guards.");
  }
}

function validateOperationFiles(plan: ProjectMutationPlan): void {
  const { operation, files, result: output } = plan;
  const record = output.item as Record<string, any>;
  if (operation === "project.create") {
    if (files.length === 0 && !output.createdThread) {
      if (record.systemKind === "default-project") fail("INVALID_DOCUMENT", "Project creation cannot return the protected Default Project.");
      return;
    }
    if (files.length !== 2 || !output.createdThread || output.createdThread.threadId !== deriveSystemId(record.projectId, "pkm/general-thread/v1")
      || output.createdThread.projectId !== record.projectId
      || record.projectId !== stableEntityId("project_", plan.operationId)
      || record.systemKind !== undefined
      || files[0]!.relativePath !== projectPath(record)
      || files[1]!.relativePath !== threadPath(record, output.createdThread.threadId)
      || files.some(file => file.beforeSha256 !== null || file.afterBase64 === null)
      || files[0]!.order !== 0 || files[1]!.order !== 1) {
      fail("INVALID_DOCUMENT", "Project create plan has targets outside the Project and its derived General Thread.");
    }
    const savedProject = validateJsonFile(files[0]!, "project", output.entityId) as Record<string, any>;
    const savedThread = validateJsonFile(files[1]!, "thread", output.entityId) as Record<string, any>;
    if (canonicalJson(savedProject) !== canonicalJson(output.item)
      || canonicalJson(savedThread) !== canonicalJson(output.createdThread)) {
      fail("INVALID_DOCUMENT", "Project create result does not match its durable records.");
    }
  } else if (operation === "project.update" || operation === "project.archive") {
    if (output.createdThread || files.length !== 1
      || (files.length === 1 && (files[0]!.relativePath !== projectPath(record)
        || files[0]!.beforeSha256 === null || files[0]!.afterBase64 === null))) {
      fail("INVALID_DOCUMENT", "Project update/archive plan may only replace its pinned Project record.");
    }
    if (files.length) {
      if (files[0]!.order !== 0) fail("INVALID_DOCUMENT", "Project update/archive write order is invalid.");
      const savedProject = validateJsonFile(files[0]!, "project", output.entityId) as Record<string, any>;
      if (canonicalJson(savedProject) !== canonicalJson(output.item)) fail("INVALID_DOCUMENT", "Project result does not match its durable record.");
      const previousProject = validateJsonFile(files[0]!, "project", output.entityId, true) as Record<string, any>;
      if (previousProject.projectId !== savedProject.projectId
        || (canonicalJson(previousProject) !== canonicalJson(savedProject) && savedProject.version !== previousProject.version + 1)) {
        fail("INVALID_DOCUMENT", "Project update/archive must retain identity and increment exactly one version.");
      }
      const mutable = operation === "project.archive"
        ? ["version", "archivedAt", "timeline"]
        : ["version", "goal", "successCriteria", "status", "currentMilestone", "owner", "deadline",
          "autonomyPolicyReference", "decisions", "timeline"];
      if (!sameExcept(previousProject, savedProject, mutable)) {
        fail("INVALID_DOCUMENT", "Project mutation changed fields outside its validated operation.");
      }
      if (operation === "project.archive" && (previousProject.systemKind === "default-project"
        || savedProject.archivedAt === undefined)) {
        fail("INVALID_DOCUMENT", "Project archive result violates the Default Project protection or archived state.");
      }
    }
  } else if (operation === "project.recipe.create") {
    if (output.createdThread || files.length !== 1 || files[0]!.relativePath !== recipePath(record)
      || record.recipeId !== stableEntityId("recipe_", plan.operationId)
      || record.revision !== 1 || record.systemKind !== undefined
      || record.knowledgeId !== `knowledge_${createHash("sha256").update(`recipe\0${record.recipeId}`, "utf8").digest("hex").slice(0, 24)}`
      || files[0]!.beforeSha256 !== null || files[0]!.afterBase64 === null || files[0]!.order !== 0) {
      fail("INVALID_DOCUMENT", "Recipe create plan has a target outside its normalized Recipe file.");
    }
    const savedRecipe = validateJsonFile(files[0]!, "recipe", output.entityId) as Record<string, any>;
    if (canonicalJson(savedRecipe) !== canonicalJson(output.item)) fail("INVALID_DOCUMENT", "Recipe create result does not match its durable record.");
  } else {
    if (output.createdThread || (files.length !== 1 && files.length !== 2)
      || files.some(file => file.afterBase64 === null && file.order !== 1)) {
      fail("INVALID_DOCUMENT", "Recipe update plan contains invalid file operations.");
    }
    const after = files.find(file => file.afterBase64 !== null);
    const before = files.find(file => file.afterBase64 === null);
    if (!after || after.order !== 0 || after.relativePath !== recipePath(record)
      || (files.length === 1 && after.beforeSha256 === null)
      || (files.length === 2 && after.beforeSha256 !== null)) {
      fail("INVALID_DOCUMENT", "Recipe update plan's new target does not match its normalized Recipe.");
    }
    const savedRecipe = validateJsonFile(after, "recipe", output.entityId) as Record<string, any>;
    if (canonicalJson(savedRecipe) !== canonicalJson(output.item)) fail("INVALID_DOCUMENT", "Recipe update result does not match its durable record.");
    if (after.beforeBase64 !== null) {
      const previousRecipe = validateJsonFile(after, "recipe", output.entityId, true) as Record<string, any>;
      if (previousRecipe.knowledgeId !== savedRecipe.knowledgeId || previousRecipe.revision + 1 !== savedRecipe.revision) {
        fail("INVALID_DOCUMENT", "Recipe update must retain its Knowledge identity and increment exactly one revision.");
      }
      if (!sameExcept(previousRecipe, savedRecipe, [
        "name", "category", "description", "methodology", "methodologyDigest", "metadata", "editorLayout",
        "definition", "nodeBindings", "executableDigest", "revision", "aliases",
      ])) {
        fail("INVALID_DOCUMENT", "Recipe update changed fields outside its validated editor contract.");
      }
    }
    if (before) {
      if (files.length !== 2 || before.beforeSha256 === null || before.order !== 1
        || before.relativePath !== `recipes/${normalizeRecipeCategory((JSON.parse(Buffer.from(before.beforeBase64!, "base64").toString("utf8")) as any).category) || "Uncategorized"}/${safeRecipeFileName((JSON.parse(Buffer.from(before.beforeBase64!, "base64").toString("utf8")) as any).name, output.entityId)}`) {
        fail("INVALID_DOCUMENT", "Recipe update plan's old target is not the Recipe's validated source file.");
      }
      const previousRecipe = validateJsonFile(before, "recipe", output.entityId, true) as Record<string, any>;
      if (previousRecipe.knowledgeId !== savedRecipe.knowledgeId || previousRecipe.revision + 1 !== savedRecipe.revision) {
        fail("INVALID_DOCUMENT", "Recipe update must retain its Knowledge identity and increment exactly one revision.");
      }
      if (!sameExcept(previousRecipe, savedRecipe, [
        "name", "category", "description", "methodology", "methodologyDigest", "metadata", "editorLayout",
        "definition", "nodeBindings", "executableDigest", "revision", "aliases",
      ])) {
        fail("INVALID_DOCUMENT", "Recipe update changed fields outside its validated editor contract.");
      }
    }
  }
}

function validateJsonFile(file: ProjectMutationFile, kind: "project" | "thread" | "recipe", entityId: string, before = false): unknown {
  const base64 = before ? file.beforeBase64 : file.afterBase64;
  if (base64 === null) fail("INVALID_DOCUMENT", "Mutation plan is missing a required record.");
  let value: unknown;
  try { value = JSON.parse(Buffer.from(base64, "base64").toString("utf8")); }
  catch { fail("INVALID_DOCUMENT", "Mutation plan contains invalid JSON."); }
  if (!value || typeof value !== "object" || Array.isArray(value)) fail("INVALID_DOCUMENT", "Mutation plan record must be a JSON object.");
  const item = value as Record<string, any>;
  if (kind === "project") {
    if (!projectRecordSchema.safeParse(item).success) fail("INVALID_DOCUMENT", "Mutation plan Project record violates its original schema.");
    if (item.projectId !== entityId) fail("INVALID_DOCUMENT", "Mutation plan Project identity does not match its result.");
  } else if (kind === "thread") {
    if (!projectThreadSchema.safeParse(item).success) fail("INVALID_DOCUMENT", "Mutation plan Thread record violates its original schema.");
    if (item.projectId !== entityId || item.threadId !== deriveSystemId(entityId, "pkm/general-thread/v1")) {
      fail("INVALID_DOCUMENT", "Mutation plan Thread identity does not match its derived Project relationship.");
    }
  } else {
    if (!projectRecipeSchema.safeParse(item).success) fail("INVALID_DOCUMENT", "Mutation plan Recipe record violates its original schema.");
    if (item.recipeId !== entityId) fail("INVALID_DOCUMENT", "Mutation plan Recipe identity does not match its result.");
    validateStoredRecipe(item);
  }
  return item;
}

function validateStoredRecipe(value: Record<string, any>): void {
  try { validateRecipeRecord(value as any); }
  catch (error) { fail("INVALID_DOCUMENT", `Mutation plan Recipe is invalid: ${error instanceof Error ? error.message : "validation failed"}`); }
  const identity = compileKnowledgeIdentityV1({
    schema: value.schema, knowledgeId: value.knowledgeId, revision: value.revision, aliases: value.aliases,
  });
  if (!identity.ok || value.scope !== "global" || value.projectId !== undefined) {
    fail("INVALID_DOCUMENT", "Mutation plan Recipe Knowledge identity or storage scope is invalid.");
  }
}

function sameExcept(before: Record<string, any>, after: Record<string, any>, mutable: string[]): boolean {
  const allowed = new Set(mutable);
  const keys = new Set([...Object.keys(before), ...Object.keys(after)]);
  for (const key of keys) {
    if (allowed.has(key)) continue;
    if (canonicalJson(before[key] === undefined ? null : before[key]) !== canonicalJson(after[key] === undefined ? null : after[key])) {
      return false;
    }
  }
  return true;
}

function verifyPlanBindings(root: string, plan: ProjectMutationPlan, documents: MarkdownRecord[]): void {
  if (!plan.operation.startsWith("project.recipe.")) return;
  for (const file of plan.files) {
    if (file.afterBase64 === null) continue;
    const recipe = JSON.parse(Buffer.from(file.afterBase64, "base64").toString("utf8")) as Record<string, any>;
    if (recipe.nodeBindings?.length) {
      buildProjectRecipeKnowledge(root, documents, [recipe]);
      for (const document of documents) {
        if (document.record.deleted || (document.record.area !== "notes" && document.record.area !== "skills")) continue;
        const fileState = readFileState(root, `${document.record.area}/${document.record.path}`);
        if (!fileState || fileState.digest !== document.record.sha256
          || fileState.bytes.toString("utf8") !== document.raw) {
          fail("CONFLICT", "Recipe-bound Knowledge source changed after it was indexed.");
        }
      }
    }
  }
}

function normalizeMetadata(metadata: Record<string, any> | undefined): Record<string, any> {
  const fields = (values: Array<Record<string, any>> | undefined, required: boolean) => (values || [])
    .map(field => ({
      name: String(field?.name || "").trim(),
      description: String(field?.description || "").trim(),
      ...(required ? { required: field?.required !== false } : {}),
    }))
    .filter(field => field.name);
  return {
    applicableFunctions: [...new Set((metadata?.applicableFunctions || []).map((value: unknown) => String(value).trim()).filter(Boolean))],
    solution: String(metadata?.solution || "").trim(),
    requiredInputs: fields(metadata?.requiredInputs, true),
    expectedOutputs: fields(metadata?.expectedOutputs, false),
  };
}

function normalizeBindings(
  value: Array<{ nodeId: string; bindings: Array<Record<string, any>> }>,
  nodeIds: Set<string>,
): Array<{ nodeId: string; bindings: Array<Record<string, any>> }> {
  const seenNodes = new Set<string>();
  return value.filter(node => nodeIds.has(node.nodeId)).map(node => {
    if (seenNodes.has(node.nodeId)) fail("INVALID_ARGUMENT", `Recipe bindings repeat Step ${node.nodeId}.`);
    seenNodes.add(node.nodeId);
    const seenBindings = new Set<string>();
    const bindings = node.bindings.map(binding => {
      if (!binding.bindingId || !["skill", "note"].includes(binding.kind) || !binding.knowledgeId
        || !/^[a-f0-9]{64}$/.test(binding.contentHash) || !["required", "recommended", "reference"].includes(binding.usage)) {
        fail("INVALID_ARGUMENT", `Recipe binding on Step ${node.nodeId} is invalid.`);
      }
      const identity = `${binding.kind}:${binding.knowledgeId}`;
      if (seenBindings.has(identity)) fail("INVALID_ARGUMENT", `Recipe binding ${identity} is duplicated on Step ${node.nodeId}.`);
      seenBindings.add(identity);
      return { ...binding };
    });
    return { nodeId: node.nodeId, bindings };
  }).filter(node => node.bindings.length);
}

function checkRuntimeEmpty(root: string): Array<{ relativePath: string; sha256: string }> {
  return runtimeGuardPaths.map(relativePath => {
    const absolute = checkedAbsolute(root, relativePath);
    assertNoSymlinkAncestors(absolute);
    let stat;
    try { stat = lstatSync(absolute); }
    catch (error) {
      if (isMissing(error)) return { relativePath, sha256: sha256("missing\0") };
      throw new CoreError("INVALID_WORKSPACE", "Could not inspect isolated runtime state.");
    }
    if (!stat.isDirectory() || stat.isSymbolicLink()) fail("CONFLICT", "Isolated runtime state is not a regular directory; Project archival is unsafe.");
    const entries = readdirSync(absolute, { withFileTypes: true });
    if (entries.length) fail("CONFLICT", "Project archival is blocked because isolated Run records are present and their terminal state cannot be verified.");
    return { relativePath, sha256: sha256("directory\0") };
  });
}

function checkGuards(root: string, guards: Array<{ relativePath: string; sha256: string }>): boolean {
  for (const guard of guards) {
    try {
      const current = guardState(root, guard.relativePath);
      if (current !== guard.sha256) return false;
    } catch { return false; }
  }
  return true;
}

function guardState(root: string, relativePath: string): string {
  const absolute = checkedAbsolute(root, relativePath);
  assertNoSymlinkAncestors(absolute);
  let stat;
  try { stat = lstatSync(absolute); }
  catch (error) {
    if (isMissing(error)) return sha256("missing\0");
    throw error;
  }
  if (!stat.isDirectory() || stat.isSymbolicLink()) return "invalid";
  return readdirSync(absolute).length ? "nonempty" : sha256("directory\0");
}

function verifySnapshotUnchanged(root: string, pin: string): void {
  const current = readProjectRecipes(root, {
    operation: "project.list",
    args: { offset: 0, limit: 1, snapshotRevision: pin },
    actorId: "project-mutation",
  }) as { snapshotRevision: string };
  if (current.snapshotRevision !== pin) fail("CONFLICT", "Project/Recipe snapshot changed while preparing the mutation.");
}

function validateEncoded(base64: string | null, expected: string | null): void {
  if (base64 === null) {
    if (expected !== null) fail("INVALID_DOCUMENT", "Mutation plan digest and bytes disagree.");
    return;
  }
  if (expected === null || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(base64)) {
    fail("INVALID_DOCUMENT", "Mutation plan contains invalid base64 bytes.");
  }
  const bytes = Buffer.from(base64, "base64");
  if (bytes.length > MAX_FILE_BYTES || bytes.toString("base64") !== base64 || sha256(bytes) !== expected) {
    fail("INVALID_DOCUMENT", "Mutation plan bytes do not match their SHA256 or file limit.");
  }
}

function decodedSize(value: string | null): number {
  return value === null ? 0 : Buffer.from(value, "base64").length;
}

function validDate(value: string): boolean {
  return /^\d{4}-\d{2}-\d{2}$/.test(value) && Number.isFinite(Date.parse(value))
    && new Date(value).toISOString().slice(0, 10) === value;
}

function syncDirectory(directory: string): void {
  if (process.platform === "win32") return;
  let descriptor: number | undefined;
  try {
    descriptor = openSync(directory, "r");
    fsyncSync(descriptor);
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
  }
}

function isMissing(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && (error as { code?: string }).code === "ENOENT";
}
