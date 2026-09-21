import { createHash } from "crypto";
import { canonicalJson, compileWorkflowDefinitionV1 } from "../workflow-contracts";
import { ProjectRecord, RecipeKnowledgeBinding, RecipeRecord } from "./project-model";

export const PROJECT_RECIPE_BUNDLE_SCHEMA = "pkm.project-recipe-bundle/v1" as const;

export interface BundledKnowledgeContent {
  knowledgeId: string;
  kind: "skill" | "note";
  contentHash: string;
  document: Record<string, unknown>;
}

export interface ProjectRecipeBundle {
  schema: typeof PROJECT_RECIPE_BUNDLE_SCHEMA;
  exportedAt: string;
  project: Pick<ProjectRecord, "projectId" | "name" | "version">;
  recipes: RecipeRecord[];
  knowledge: BundledKnowledgeContent[];
  digest: string;
}

export class ProjectRecipeBundleError extends Error {
  constructor(public readonly code: string, message: string) {
    super(message);
  }
}

export function exportProjectRecipeBundle(input: {
  project: ProjectRecord;
  recipes: RecipeRecord[];
  knowledge: BundledKnowledgeContent[];
  exportedAt?: string;
}): ProjectRecipeBundle {
  const payload = normalizePayload({
    schema: PROJECT_RECIPE_BUNDLE_SCHEMA,
    exportedAt: input.exportedAt || new Date().toISOString(),
    project: input.project,
    recipes: input.recipes,
    knowledge: input.knowledge
  });
  return { ...payload, digest: bundleDigest(payload) };
}

export function parseProjectRecipeBundle(value: unknown): ProjectRecipeBundle {
  if (!isRecord(value) || value.schema !== PROJECT_RECIPE_BUNDLE_SCHEMA || typeof value.digest !== "string") {
    fail("bundle-invalid", "Project Recipe bundle envelope is invalid.");
  }
  const { digest, ...candidate } = value;
  const payload = normalizePayload(candidate);
  if (bundleDigest(payload) !== digest) fail("bundle-digest-mismatch", "Project Recipe bundle digest does not match its content.");
  return { ...payload, digest };
}

function normalizePayload(value: any): Omit<ProjectRecipeBundle, "digest"> {
  if (!isRecord(value) || value.schema !== PROJECT_RECIPE_BUNDLE_SCHEMA || typeof value.exportedAt !== "string"
    || !Number.isFinite(Date.parse(value.exportedAt)) || !isRecord(value.project) || !Array.isArray(value.recipes) || !Array.isArray(value.knowledge)) {
    fail("bundle-invalid", "Project Recipe bundle payload is invalid.");
  }
  const project = normalizeProject(value.project);
  const recipes = value.recipes.map(normalizeRecipe).sort((left: RecipeRecord, right: RecipeRecord) => compareStrings(left.recipeId, right.recipeId));
  const recipeIds = new Set<string>();
  for (const recipe of recipes) {
    if (recipeIds.has(recipe.recipeId)) fail("recipe-duplicate", `Recipe ${recipe.recipeId} is duplicated.`);
    recipeIds.add(recipe.recipeId);
  }
  const knowledge = value.knowledge.map(normalizeKnowledge).sort((left: BundledKnowledgeContent, right: BundledKnowledgeContent) => compareStrings(left.knowledgeId, right.knowledgeId));
  const knowledgeById = new Map<string, BundledKnowledgeContent>();
  for (const item of knowledge) {
    if (knowledgeById.has(item.knowledgeId)) fail("knowledge-duplicate", `Knowledge ${item.knowledgeId} is duplicated.`);
    knowledgeById.set(item.knowledgeId, item);
  }
  for (const recipe of recipes) validateBindings(recipe, knowledgeById);
  return { schema: PROJECT_RECIPE_BUNDLE_SCHEMA, exportedAt: value.exportedAt, project, recipes, knowledge };
}

function normalizeProject(value: Record<string, unknown>): ProjectRecipeBundle["project"] {
  if (typeof value.projectId !== "string" || !value.projectId || typeof value.name !== "string" || !value.name
    || !Number.isSafeInteger(value.version) || Number(value.version) < 1) fail("project-invalid", "Bundled Project identity is invalid.");
  return { projectId: value.projectId, name: value.name, version: Number(value.version) };
}

function normalizeRecipe(value: unknown): RecipeRecord {
  if (!isRecord(value) || typeof value.recipeId !== "string" || !value.recipeId || !["global", "project"].includes(String(value.scope))
    || typeof value.name !== "string" || typeof value.description !== "string" || typeof value.executableDigest !== "string"
    || !Number.isSafeInteger(value.revision) || Number(value.revision) < 1) fail("recipe-invalid", "Bundled Recipe metadata is invalid.");
  const compiled = compileWorkflowDefinitionV1(value.definition);
  if (!compiled.ok || compiled.executableDigest !== value.executableDigest) fail("recipe-definition-invalid", `Recipe ${value.recipeId} definition or executable digest is invalid.`);
  const nodeBindings = value.nodeBindings === undefined ? undefined : normalizeNodeBindings(value.nodeBindings, compiled.model.spec.nodes.map(node => node.nodeId));
  const metadata = isRecord(value.metadata) ? {
    applicableFunctions: Array.isArray(value.metadata.applicableFunctions) ? value.metadata.applicableFunctions.map(String) : [],
    solution: String(value.metadata.solution || ""),
    requiredInputs: normalizeMetadataFields(value.metadata.requiredInputs, true),
    expectedOutputs: normalizeMetadataFields(value.metadata.expectedOutputs, false)
  } : undefined;
  const editorLayout = isRecord(value.editorLayout) && isRecord(value.editorLayout.nodePositions)
    ? { nodePositions: Object.fromEntries(Object.entries(value.editorLayout.nodePositions).flatMap(([nodeId, position]) => {
      if (!compiled.model.spec.nodes.some(node => node.nodeId === nodeId) || !isRecord(position)
        || !Number.isFinite(position.x) || !Number.isFinite(position.y) || Number(position.x) < 0 || Number(position.y) < 0) return [];
      return [[nodeId, { x: Math.round(Number(position.x)), y: Math.round(Number(position.y)) }]];
    })) }
    : undefined;
  return JSON.parse(canonicalJson({
    recipeId: value.recipeId, scope: value.scope, ...(typeof value.projectId === "string" ? { projectId: value.projectId } : {}),
    ...(typeof value.category === "string" ? { category: value.category } : {}), ...(value.systemKind === "built-in" ? { systemKind: value.systemKind } : {}),
    name: value.name, description: value.description, ...(metadata ? { metadata } : {}), ...(editorLayout && Object.keys(editorLayout.nodePositions).length ? { editorLayout } : {}), definition: compiled.model, ...(nodeBindings ? { nodeBindings } : {}),
    executableDigest: value.executableDigest, revision: Number(value.revision)
  }));
}

function normalizeMetadataFields(value: unknown, includeRequired: boolean): Array<{ name: string; description: string; required?: boolean }> {
  if (!Array.isArray(value)) return [];
  return value.filter(isRecord).map(field => ({
    name: String(field.name || ""), description: String(field.description || ""),
    ...(includeRequired ? { required: field.required !== false } : {})
  })).filter(field => field.name);
}

function normalizeNodeBindings(value: unknown, nodeIds: string[]): RecipeRecord["nodeBindings"] {
  if (!Array.isArray(value)) fail("bindings-invalid", "Recipe node bindings must be an array.");
  const validNodes = new Set(nodeIds);
  const seenNodes = new Set<string>();
  return value.map(entry => {
    if (!isRecord(entry) || typeof entry.nodeId !== "string" || !validNodes.has(entry.nodeId) || !Array.isArray(entry.bindings) || seenNodes.has(entry.nodeId)) {
      fail("bindings-invalid", "Recipe node binding references an invalid or duplicate node.");
    }
    seenNodes.add(entry.nodeId);
    const seenBindings = new Set<string>();
    const bindings = entry.bindings.map(binding => normalizeBinding(binding, seenBindings)).sort((left, right) => compareStrings(left.bindingId, right.bindingId));
    return { nodeId: entry.nodeId, bindings };
  }).sort((left, right) => compareStrings(left.nodeId, right.nodeId));
}

function normalizeBinding(value: unknown, seen: Set<string>): RecipeKnowledgeBinding {
  if (!isRecord(value) || typeof value.bindingId !== "string" || !value.bindingId || seen.has(value.bindingId)
    || !["skill", "note"].includes(String(value.kind)) || typeof value.knowledgeId !== "string" || !value.knowledgeId
    || !/^[a-f0-9]{64}$/.test(String(value.contentHash)) || !["required", "recommended", "reference"].includes(String(value.usage))) {
    fail("binding-invalid", "Recipe knowledge binding is invalid or duplicated.");
  }
  seen.add(value.bindingId);
  return value as unknown as RecipeKnowledgeBinding;
}

function normalizeKnowledge(value: unknown): BundledKnowledgeContent {
  if (!isRecord(value) || typeof value.knowledgeId !== "string" || !value.knowledgeId || !["skill", "note"].includes(String(value.kind))
    || !isRecord(value.document) || !/^[a-f0-9]{64}$/.test(String(value.contentHash))) fail("knowledge-invalid", "Bundled knowledge content is invalid.");
  if (hash(canonicalJson(value.document)) !== value.contentHash) fail("knowledge-hash-mismatch", `Knowledge ${value.knowledgeId} content hash does not match.`);
  return value as unknown as BundledKnowledgeContent;
}

function validateBindings(recipe: RecipeRecord, knowledge: Map<string, BundledKnowledgeContent>): void {
  for (const node of recipe.nodeBindings || []) for (const binding of node.bindings) {
    const content = knowledge.get(binding.knowledgeId);
    if (!content || content.kind !== binding.kind || content.contentHash !== binding.contentHash) {
      fail("binding-unresolved", `Recipe ${recipe.recipeId} binding ${binding.bindingId} is not reproduced by the bundle.`);
    }
  }
}

function bundleDigest(payload: Omit<ProjectRecipeBundle, "digest">): string {
  return hash(canonicalJson(payload));
}

function hash(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function compareStrings(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function isRecord(value: unknown): value is Record<string, any> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function fail(code: string, message: string): never {
  throw new ProjectRecipeBundleError(code, message);
}