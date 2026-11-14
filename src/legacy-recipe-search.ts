import type { ProjectRecipeRecord } from "./project-recipes-contracts.js";

const object = (value: unknown): Record<string, unknown> =>
  value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
const array = (value: unknown): unknown[] => Array.isArray(value) ? value : [];
const text = (value: unknown): string => {
  if (!value) return "";
  if (typeof value === "object") return JSON.stringify(value);
  return String(value);
};
const order = (a: string, b: string) => {
  const left = Array.from(a), right = Array.from(b);
  for (let i = 0; i < Math.min(left.length, right.length); i++) {
    const difference = left[i]!.codePointAt(0)! - right[i]!.codePointAt(0)!;
    if (difference) return difference;
  }
  return left.length - right.length;
};
function summary(recipe: ProjectRecipeRecord, score = 0) {
  const metadata = recipe.metadata, methodology = object(recipe.methodology);
  return { recipe_id: recipe.recipeId, name: recipe.name, description: recipe.description || "",
    category: recipe.category || "", metadata: {
      applicable_functions: metadata?.applicableFunctions || [], solution: metadata?.solution || "",
      required_inputs: metadata?.requiredInputs || [], expected_outputs: metadata?.expectedOutputs || [],
    }, scope: recipe.scope, project_id: recipe.projectId ?? null, revision: recipe.revision,
    executable_digest: recipe.executableDigest, methodology: recipe.methodology ? {
      family: methodology.family ?? null, phase: methodology.phase ?? null, abstract: !!methodology.abstract,
      capabilities: methodology.capabilities || [], artifacts: methodology.artifacts || { inputs: [], outputs: [] },
      gates: methodology.gates || [], invariants: methodology.invariants || [],
      communication: methodology.communication || {}, retrieval: methodology.retrieval || {},
      digest: recipe.methodologyDigest ?? null,
    } : null, node_count: array(object(object(recipe.definition).spec).nodes).length, score };
}

/** Original local metadata/family fallback algorithm; no subscribed-catalog authority is inferred. */
export function searchLocalRecipes(recipes: ProjectRecipeRecord[], input: {
  query: string; category: string; project_id: string; limit: number; task_contract_json: string;
}) {
  try {
    let contract: unknown;
    try { contract = JSON.parse(input.task_contract_json || "{}"); }
    catch (error) { throw Error(`task_contract_json must be valid JSON: ${error instanceof Error ? error.message : "Invalid JSON"}`); }
    if (!contract || typeof contract !== "object" || Array.isArray(contract)) throw Error("task_contract_json must decode to dict");
    const terms = input.query.toLowerCase().split(/\s+/).filter(Boolean);
    const category = input.category.trim().toLowerCase();
    const available = recipes.filter(recipe => recipe.scope === "global" || recipe.projectId === input.project_id);
    const candidates = available.flatMap(recipe => {
      if (category && !(recipe.category || "").toLowerCase().startsWith(category)) return [];
      const metadata = recipe.metadata, methodology = object(recipe.methodology);
      const artifacts = object(methodology.artifacts), retrieval = object(methodology.retrieval);
      const communication = object(methodology.communication);
      const nodes = array(object(object(recipe.definition).spec).nodes).map(object);
      const fields = [...metadata?.requiredInputs || [], ...metadata?.expectedOutputs || []];
      const content = [recipe.name, recipe.description, recipe.category, ...metadata?.applicableFunctions || [],
        metadata?.solution, ...fields.map(field => field.name), ...fields.map(field => field.description),
        ...nodes.map(node => node.nodeId), ...nodes.map(node => node.kind), methodology.family, methodology.phase,
        ...array(methodology.capabilities), ...array(artifacts.inputs), ...array(artifacts.outputs),
        ...array(methodology.gates), ...array(methodology.invariants), communication.minimumAssurance,
        ...array(communication.escalateOn), ...array(retrieval.intents), ...array(retrieval.terminology),
        ...array(retrieval.operationalPoints)].map(text).join("\n").toLowerCase();
      if (!terms.every(term => content.includes(term))) return [];
      const name = recipe.name.toLowerCase();
      const score = (category ? (recipe.category || "").toLowerCase() === category ? 40 : 20 : 0)
        + (input.query && input.query.toLowerCase() === name ? 30 : 10 * terms.filter(term => name.includes(term)).length)
        + 5 * terms.filter(term => content.includes(term)).length;
      return [summary(recipe, score)];
    });
    const sorted = (rows: ReturnType<typeof summary>[]) => rows.sort((a, b) =>
      b.score - a.score || order(a.name, b.name) || order(a.recipe_id, b.recipe_id)).slice(0, Math.max(1, Math.min(input.limit || 10, 50)));
    const base = { schema: "pkm.recipe.api/v1", ok: true };
    if (candidates.length) {
      const rows = sorted(candidates);
      return { ...base, outcome: "candidates", qualification: "metadata-only-v1", candidates: rows,
        next_action: { kind: "qualify_recipe", candidate_recipe_ids: rows.map(row => row.recipe_id),
          read_only_recipe_paths: [], task_contract: contract } };
    }
    const family = text(object(contract).methodologyFamily || object(contract).family).trim().toLowerCase();
    const concrete = available.filter(recipe => !object(recipe.methodology).abstract);
    let fallback = family ? concrete.filter(recipe => text(object(recipe.methodology).family).toLowerCase() === family) : [];
    let kind = fallback.length ? "family-fallback" : "";
    if (!fallback.length) {
      fallback = concrete.filter(recipe => object(recipe.methodology).family === "universal-unknown-task");
      kind = fallback.length ? "universal-fallback" : "";
    }
    if (fallback.length) {
      const rows = sorted(fallback.map(recipe => summary(recipe)));
      return { ...base, outcome: kind, qualification: "methodology-fallback-v1", candidates: rows,
        next_action: { kind: "qualify_recipe", candidate_recipe_ids: rows.map(row => row.recipe_id),
          task_contract: contract, fallback: kind, reason: kind === "family-fallback"
            ? "No exact metadata match; selected the requested Methodology family."
            : "No exact or family match; selected the universal unknown-task fallback." } };
    }
    return { ...base, outcome: "no-match", qualification: "metadata-only-v1", candidates: [],
      next_action: { kind: "design_recipe", task_contract: contract,
        reason: "No accessible metadata candidate matched. Recipe persistence requires the extension authoring bridge." } };
  } catch (error) {
    return { schema: "pkm.recipe.api/v1", ok: false,
      error: { code: "recipe-search-failed", message: error instanceof Error ? error.message : "Invalid search." } };
  }
}
