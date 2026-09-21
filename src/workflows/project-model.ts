import { createHash, randomUUID } from "crypto";
import {
  NOOP_NODE_KIND,
  WORKFLOW_DEFINITION_SCHEMA,
  WorkflowDefinitionV1,
  compileWorkflowDefinitionV1
} from "../workflow-contracts";

export type ProjectSystemKind = "default-project";
export type ThreadSystemKind = "general-thread";
export type RecipeSystemKind = "built-in";
export type MigrationState = "pending" | "running" | "completed" | "failed";

export interface RecipeKnowledgeBinding {
  bindingId: string;
  kind: "skill" | "note";
  knowledgeId: string;
  contentHash: string;
  usage: "required" | "recommended" | "reference";
}

export interface RecipeNodeBindings {
  nodeId: string;
  bindings: RecipeKnowledgeBinding[];
}

export interface RecipeMetadataField {
  name: string;
  description: string;
  required?: boolean;
}

export interface RecipeMetadata {
  applicableFunctions: string[];
  solution: string;
  requiredInputs: RecipeMetadataField[];
  expectedOutputs: RecipeMetadataField[];
}

export interface ProjectRecord {
  projectId: string;
  name: string;
  systemKind?: ProjectSystemKind;
  version: number;
}

export interface ThreadRecord {
  threadId: string;
  projectId: string;
  name: string;
  description: string;
  archived: boolean;
  systemKind?: ThreadSystemKind;
  legacyAliases: string[];
  version: number;
}

export interface RecipeRecord {
  recipeId: string;
  scope: "global" | "project";
  projectId?: string;
  category?: string;
  systemKind?: RecipeSystemKind;
  name: string;
  description: string;
  metadata?: RecipeMetadata;
  editorLayout?: { nodePositions: Record<string, { x: number; y: number }> };
  definition: WorkflowDefinitionV1;
  nodeBindings?: RecipeNodeBindings[];
  executableDigest: string;
  revision: number;
}

export interface RecipeUpdate {
  name: string;
  category: string;
  description: string;
  metadata?: RecipeMetadata;
  editorLayout?: { nodePositions: Record<string, { x: number; y: number }> };
  definition: WorkflowDefinitionV1;
}

export interface LegacyRoom {
  identity: string;
  roomId?: string;
  name: string;
  description?: string;
  active?: boolean;
}

export interface MigrationEntry {
  legacyIdentity: string;
  state: MigrationState;
  threadId?: string;
  receiptId?: string;
  error?: string;
}

export interface ProjectModelState {
  schema: 1;
  rootId: string;
  projects: ProjectRecord[];
  threads: ThreadRecord[];
  recipes?: RecipeRecord[];
  migrations: MigrationEntry[];
  audit: Array<{ event: string; entityId: string }>;
}

export interface ThreadMovePlan {
  threadId: string;
  destinationProjectId: string;
  linkedActiveRunIds: string[];
  includedRunIds: string[];
  audienceChanges: boolean;
  audienceChangeConfirmed: boolean;
}

const ID_PATTERN = /^[A-Za-z][A-Za-z0-9._-]{0,127}$/;

function normalizeRecipeMetadata(metadata: RecipeMetadata | undefined): RecipeMetadata {
  const normalizeFields = (fields: RecipeMetadataField[] | undefined, includeRequired: boolean): RecipeMetadataField[] => (fields || [])
    .map(field => ({
      name: String(field?.name || "").trim(),
      description: String(field?.description || "").trim(),
      ...(includeRequired ? { required: field?.required !== false } : {})
    }))
    .filter(field => field.name);
  return {
    applicableFunctions: [...new Set((metadata?.applicableFunctions || []).map(value => String(value).trim()).filter(Boolean))],
    solution: String(metadata?.solution || "").trim(),
    requiredInputs: normalizeFields(metadata?.requiredInputs, true),
    expectedOutputs: normalizeFields(metadata?.expectedOutputs, false)
  };
}

export class ProjectModelError extends Error {
  constructor(public readonly code: string, message: string, public readonly details?: unknown) {
    super(message);
  }
}

export function deriveSystemId(parentId: string, key: "pkm/default-project/v1" | "pkm/general-thread/v1"): string {
  const prefix = key.includes("default-project") ? "project_" : "thread_";
  return prefix + createHash("sha256").update(`${key}\0${parentId}`, "utf8").digest("hex").slice(0, 32);
}

export function initializeProjectModel(existing: Partial<ProjectModelState> | undefined, createId: () => string = randomUUID): ProjectModelState {
  if (!existing) return ensureBuiltInRecipes(ensureSystemEntities({ schema: 1, rootId: `root_${createId()}`, projects: [], threads: [], recipes: [], migrations: [], audit: [] }));
  if (!existing.rootId) {
    if ((existing.projects?.length || 0) + (existing.threads?.length || 0) > 0) throw new ProjectModelError("root-identity-missing", "Root identity cannot be regenerated while child records exist.");
    return ensureBuiltInRecipes(ensureSystemEntities({ schema: 1, rootId: `root_${createId()}`, projects: [], threads: [], recipes: existing.recipes || [], migrations: existing.migrations || [], audit: existing.audit || [] }));
  }
  const restored: ProjectModelState = {
    schema: 1,
    rootId: existing.rootId,
    projects: [...(existing.projects || [])],
    threads: [...(existing.threads || [])],
    migrations: [...(existing.migrations || [])],
    audit: [...(existing.audit || [])]
  };
  if (existing.recipes) restored.recipes = [...existing.recipes];
  return ensureBuiltInRecipes(ensureSystemEntities(restored));
}

const BUILT_IN_RECIPES = [
  {
    key: "software-development",
    name: "Software Development",
    description: "Develop a software change from clarified requirements through implementation, validation, and delivery.",
    steps: ["understand", "plan", "implement", "validate", "deliver"]
  },
  {
    key: "bug-fix",
    name: "Bug Fix",
    description: "Reproduce a defect, identify its root cause, implement a focused fix, and verify against regressions.",
    steps: ["reproduce", "investigate", "fix", "regression-check", "report"]
  },
  {
    key: "ui-development",
    name: "UI Development",
    description: "Turn a user experience goal into an implemented, accessible, responsive, and reviewed interface.",
    steps: ["understand-ux", "prototype", "implement-ui", "validate-ui", "review"]
  }
] as const;

function builtInRecipeId(key: string): string {
  return `recipe_${createHash("sha256").update(`pkm/built-in-recipe/v1\0${key}`, "utf8").digest("hex").slice(0, 32)}`;
}

function compileLinearRecipe(steps: readonly string[]): { definition: WorkflowDefinitionV1; executableDigest: string } {
  const compiled = compileWorkflowDefinitionV1({
    schema: WORKFLOW_DEFINITION_SCHEMA,
    spec: {
      inputs: {},
      nodes: steps.map((nodeId, index) => ({
        nodeId,
        kind: NOOP_NODE_KIND,
        config: {},
        dependsOn: index ? [{ from: steps[index - 1], accept: ["succeeded"], required: true }] : []
      })),
      outputs: {},
      completion: { requiredNodes: [steps[steps.length - 1]] }
    }
  });
  if (!compiled.ok) throw new ProjectModelError("recipe-template-invalid", "Built-in Recipe template did not compile.");
  return { definition: compiled.model, executableDigest: compiled.executableDigest };
}

export function ensureBuiltInRecipes(state: ProjectModelState): ProjectModelState {
  const recipes = [...(state.recipes || [])];
  for (const descriptor of BUILT_IN_RECIPES) {
    const recipeId = builtInRecipeId(descriptor.key);
    const existing = recipes.find(recipe => recipe.recipeId === recipeId);
    if (existing) {
      if (existing.systemKind !== "built-in") throw new ProjectModelError("system-recipe-conflict", "Built-in Recipe identity is conflicting.");
      continue;
    }
    const compiled = compileLinearRecipe(descriptor.steps);
    recipes.push({
      recipeId,
      scope: "global",
      category: "Software Development",
      systemKind: "built-in",
      name: descriptor.name,
      description: descriptor.description,
      metadata: {
        applicableFunctions: ["Software Development"],
        solution: descriptor.description,
        requiredInputs: [{ name: "task", description: "The requested outcome and its constraints.", required: true }],
        expectedOutputs: [{ name: "result", description: "The implemented or analyzed result with validation evidence." }]
      },
      definition: compiled.definition,
      executableDigest: compiled.executableDigest,
      revision: 1
    });
  }
  return { ...state, recipes };
}

export function ensureSystemEntities(state: ProjectModelState): ProjectModelState {
  const defaultProjectId = deriveSystemId(state.rootId, "pkm/default-project/v1");
  const markedProjects = state.projects.filter(project => project.systemKind === "default-project");
  if (markedProjects.length > 1 || (markedProjects[0] && markedProjects[0].projectId !== defaultProjectId)) {
    throw new ProjectModelError("system-project-conflict", "Default Project identity is conflicting or duplicated.");
  }
  let projects = state.projects;
  let audit = state.audit;
  if (!markedProjects.length) {
    projects = [...projects, { projectId: defaultProjectId, name: "Default Project", systemKind: "default-project", version: 1 }];
    audit = [...audit, { event: "system-project-repaired", entityId: defaultProjectId }];
  }
  const generalThreadId = deriveSystemId(defaultProjectId, "pkm/general-thread/v1");
  const markedThreads = state.threads.filter(thread => thread.systemKind === "general-thread" && thread.projectId === defaultProjectId);
  if (markedThreads.length > 1 || (markedThreads[0] && markedThreads[0].threadId !== generalThreadId)) {
    throw new ProjectModelError("system-thread-conflict", "General Thread identity is conflicting or duplicated.");
  }
  let threads = state.threads;
  if (!markedThreads.length) {
    threads = [...threads, { threadId: generalThreadId, projectId: defaultProjectId, name: "General", description: "", archived: false, systemKind: "general-thread", legacyAliases: [], version: 1 }];
    audit = [...audit, { event: "system-thread-repaired", entityId: generalThreadId }];
  }
  return { ...state, projects, threads, audit };
}

export function createProject(state: ProjectModelState, name: string, createId: () => string = randomUUID): ProjectModelState {
  const normalized = name.trim();
  if (!normalized) throw new ProjectModelError("project-name-required", "Project name is required.");
  const projectId = `project_${createId()}`;
  if (state.projects.some(project => project.projectId === projectId)) throw new ProjectModelError("identity-conflict", "Generated Project identity already exists.");
  const generalThreadId = deriveSystemId(projectId, "pkm/general-thread/v1");
  return {
    ...state,
    projects: [...state.projects, { projectId, name: normalized, version: 1 }],
    threads: [...state.threads, { threadId: generalThreadId, projectId, name: "General", description: "", archived: false, systemKind: "general-thread", legacyAliases: [], version: 1 }],
    audit: [...state.audit, { event: "project-created", entityId: projectId }, { event: "system-thread-created", entityId: generalThreadId }]
  };
}

export function createThread(state: ProjectModelState, projectId: string, name: string, createId: () => string = randomUUID): ProjectModelState {
  if (!state.projects.some(project => project.projectId === projectId)) throw new ProjectModelError("project-not-found", "Project does not exist.");
  const normalized = name.trim();
  if (!normalized) throw new ProjectModelError("thread-name-required", "Thread name is required.");
  const threadId = `thread_${createId()}`;
  if (state.threads.some(thread => thread.threadId === threadId)) throw new ProjectModelError("identity-conflict", "Generated Thread identity already exists.");
  return {
    ...state,
    threads: [...state.threads, { threadId, projectId, name: normalized, description: "", archived: false, legacyAliases: [], version: 1 }],
    audit: [...state.audit, { event: "thread-created", entityId: threadId }]
  };
}

export function createRecipe(state: ProjectModelState, scope: { kind: "global" } | { kind: "project"; projectId: string }, name: string, createId: () => string = randomUUID): ProjectModelState {
  if (scope.kind === "project" && !state.projects.some(project => project.projectId === scope.projectId)) throw new ProjectModelError("project-not-found", "Project does not exist.");
  const normalized = name.trim();
  if (!normalized) throw new ProjectModelError("recipe-name-required", "Recipe name is required.");
  const recipeId = `recipe_${createId()}`;
  if ((state.recipes || []).some(recipe => recipe.recipeId === recipeId)) throw new ProjectModelError("identity-conflict", "Generated Recipe identity already exists.");
  const compiled = compileWorkflowDefinitionV1({
    schema: WORKFLOW_DEFINITION_SCHEMA,
    spec: {
      inputs: {},
      nodes: [{ nodeId: "start", kind: NOOP_NODE_KIND, config: {}, dependsOn: [] }],
      outputs: {},
      completion: { requiredNodes: ["start"] }
    }
  });
  if (!compiled.ok) throw new ProjectModelError("recipe-template-invalid", "Built-in Recipe template did not compile.");
  const recipe: RecipeRecord = {
    recipeId,
    scope: scope.kind,
    ...(scope.kind === "project" ? { projectId: scope.projectId } : {}),
    name: normalized,
    description: "",
    definition: compiled.model,
    executableDigest: compiled.executableDigest,
    revision: 1
  };
  return {
    ...state,
    recipes: [...(state.recipes || []), recipe],
    audit: [...state.audit, { event: "recipe-created", entityId: recipeId }]
  };
}

export function updateRecipe(state: ProjectModelState, recipeId: string, update: RecipeUpdate): ProjectModelState {
  const recipes = state.recipes || [];
  const index = recipes.findIndex(recipe => recipe.recipeId === recipeId);
  if (index < 0) throw new ProjectModelError("recipe-not-found", "Recipe does not exist.");
  const name = update.name.trim();
  if (!name) throw new ProjectModelError("recipe-name-required", "Recipe name is required.");
  const compiled = compileWorkflowDefinitionV1(update.definition);
  if (!compiled.ok) throw new ProjectModelError("recipe-definition-invalid", "Recipe definition is invalid.", { diagnostics: compiled.diagnostics });
  const current = recipes[index];
  const nodeIds = new Set(compiled.model.spec.nodes.map(node => node.nodeId));
  const nodePositions = Object.fromEntries(Object.entries(update.editorLayout?.nodePositions || current.editorLayout?.nodePositions || {})
    .filter(([nodeId, position]) => nodeIds.has(nodeId) && Number.isFinite(position?.x) && Number.isFinite(position?.y))
    .map(([nodeId, position]) => [nodeId, { x: Math.max(0, Math.round(position.x)), y: Math.max(0, Math.round(position.y)) }]));
  const next: RecipeRecord = {
    ...current,
    name,
    category: update.category.trim() || undefined,
    description: update.description.trim(),
    metadata: normalizeRecipeMetadata(update.metadata || current.metadata),
    ...(Object.keys(nodePositions).length ? { editorLayout: { nodePositions } } : {}),
    definition: compiled.model,
    executableDigest: compiled.executableDigest,
    revision: current.revision + 1
  };
  return {
    ...state,
    recipes: recipes.map((recipe, recipeIndex) => recipeIndex === index ? next : recipe),
    audit: [...state.audit, { event: "recipe-updated", entityId: recipeId }]
  };
}

export function migrateLegacyRoom(state: ProjectModelState, room: LegacyRoom, createId: () => string = randomUUID): ProjectModelState {
  const existingEntry = state.migrations.find(entry => entry.legacyIdentity === room.identity);
  if (existingEntry?.state === "completed") return state;
  if (room.active) return setMigration(state, room.identity, { state: "pending", error: "active-room-deferred" });
  const defaultProject = state.projects.find(project => project.systemKind === "default-project")!;
  const reusableRoomId = room.roomId && ID_PATTERN.test(room.roomId) && !state.threads.some(thread => thread.threadId === room.roomId);
  const threadId = reusableRoomId ? room.roomId! : `thread_${createId()}`;
  if (state.threads.some(thread => thread.threadId === threadId)) return setMigration(state, room.identity, { state: "failed", error: "thread-identity-conflict" });
  if (state.threads.some(thread => thread.legacyAliases.includes(room.identity))) return setMigration(state, room.identity, { state: "failed", error: "legacy-alias-conflict" });
  const aliasRequired = threadId !== room.roomId;
  const thread: ThreadRecord = {
    threadId,
    projectId: defaultProject.projectId,
    name: room.name.trim() || "Legacy Thread",
    description: room.description || "",
    archived: false,
    legacyAliases: aliasRequired ? [room.identity] : [],
    version: 1
  };
  const receiptId = `migration_${createHash("sha256").update(`${room.identity}\0${threadId}`).digest("hex").slice(0, 24)}`;
  const migrated = { ...state, threads: [...state.threads, thread], audit: [...state.audit, { event: "legacy-room-migrated", entityId: threadId }] };
  return setMigration(migrated, room.identity, { state: "completed", threadId, receiptId });
}

export function moveThread(state: ProjectModelState, plan: ThreadMovePlan): ProjectModelState {
  const thread = state.threads.find(candidate => candidate.threadId === plan.threadId);
  if (!thread) throw new ProjectModelError("thread-not-found", "Thread does not exist.");
  if (thread.systemKind === "general-thread") throw new ProjectModelError("system-thread-move-forbidden", "General Thread cannot move between Projects.");
  if (!state.projects.some(project => project.projectId === plan.destinationProjectId)) throw new ProjectModelError("project-not-found", "Destination Project does not exist.");
  const omittedRuns = plan.linkedActiveRunIds.filter(runId => !plan.includedRunIds.includes(runId));
  if (omittedRuns.length) throw new ProjectModelError("active-run-move-blocked", `Active Runs must move or be resolved: ${omittedRuns.join(", ")}`);
  if (plan.audienceChanges && !plan.audienceChangeConfirmed) throw new ProjectModelError("audience-confirmation-required", "Thread movement changes its effective audience.");
  if (thread.projectId === plan.destinationProjectId) return state;
  return {
    ...state,
    threads: state.threads.map(candidate => candidate.threadId === thread.threadId ? { ...candidate, projectId: plan.destinationProjectId, version: candidate.version + 1 } : candidate),
    audit: [...state.audit, { event: "thread-moved", entityId: thread.threadId }]
  };
}

export function resolveThreadId(state: ProjectModelState, identity: string): string | undefined {
  return state.threads.find(thread => thread.threadId === identity || thread.legacyAliases.includes(identity))?.threadId;
}

function setMigration(state: ProjectModelState, legacyIdentity: string, update: Omit<MigrationEntry, "legacyIdentity">): ProjectModelState {
  const entry = { legacyIdentity, ...update };
  const exists = state.migrations.some(candidate => candidate.legacyIdentity === legacyIdentity);
  return { ...state, migrations: exists ? state.migrations.map(candidate => candidate.legacyIdentity === legacyIdentity ? entry : candidate) : [...state.migrations, entry] };
}