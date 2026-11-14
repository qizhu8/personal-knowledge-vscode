import { z } from "zod";
import { recipeLibraryEditable } from "./recipe-library-fields.js";
import { legacyRecipeLazyDefinitions, legacyRecipeLazyOperations } from "./legacy-recipe-lazy-contracts.js";

const digest = z.string().regex(/^[a-f0-9]{64}$/);
const scope = { namespace: z.string().regex(/^[a-f0-9]{16}$/), chatId: z.string().uuid() };
const mutation = { ...scope, operationId: z.string().uuid(), expectedDigest: digest };
const result = z.record(z.string(), z.json());
export const recipeProtocolOperations = new Set([
  "project.recipe.list", "project.recipe.get", "project.recipe.bundle.get",
  "workflow.compiler.capabilities", "workflow.definition.validate", "workflow.definition.compile",
  "recipe.compat.search", "recipe.library.state", "recipe.library.save",
  "mcp.tool.recipe_search", "mcp.tool.recipe_capabilities",
  "recipe.runtime.start", "recipe.runtime.get", "recipe.runtime.cancel", "recipe.history.get",
  ...legacyRecipeLazyOperations,
]);
export const legacyRecipeSearchInput = z.strictObject({
  query: z.string().max(4096).default(""), category: z.string().max(2048).default(""),
  project_id: z.string().max(256).default(""), limit: z.number().int().default(10),
  task_contract_json: z.string().max(262144).default("{}"),
});
export const recipePublicDefinitions = [
  ...legacyRecipeLazyDefinitions,
  { id: "mcp.tool.recipe_search", readOnly: true,
    description: "Original compact-facade Recipe metadata search ID and parameters, over the shared local native SQL catalog; no execution permission or remote subscription inference.",
    input: legacyRecipeSearchInput, output: result },
  { id: "mcp.tool.recipe_capabilities", readOnly: true,
    description: "Discover the bounded native Recipe mapping and explicit original lifecycle gaps; does not advertise unimplemented old execution semantics.",
    input: z.strictObject({}), output: result },
  { id: "recipe.compat.search", readOnly: true,
    description: "Original Recipe metadata ranking and Methodology fallback over the shared local native catalog. No subscribed remote catalog is inferred; candidates confer no execution permission.",
    input: legacyRecipeSearchInput, output: result },
  { id: "recipe.library.state", readOnly: true,
    description: "Read the current actor/root-bound native Recipe catalog digest, availability and historical-only legacy receipts. Reads never advance execution.",
    input: z.strictObject({}), output: result },
  { id: "recipe.library.save", readOnly: false,
    description: "Save a native Library definition with revision/catalog CAS and an atomic durable receipt after separate exact host approval. Never grants execution authority.",
    input: z.strictObject({ ...mutation, recipeId: z.string().min(1).max(256),
      expectedRevision: z.number().int().safe().nonnegative(), fields: recipeLibraryEditable }), output: result },
  { id: "recipe.runtime.start", readOnly: false,
    description: "Start a fresh native Recipe intention through the composed exact-root/actor host and genuine adapters. Separate fresh host approval is mandatory; this is not legacy lazy recipe_run_start.",
    input: z.strictObject({ ...mutation, recipeId: z.string().min(1).max(256), inputs: z.record(z.string(), z.json()) }),
    output: result },
  { id: "recipe.runtime.get", readOnly: true,
    description: "Pure read of one actor-owned native Recipe run. Never advances, materializes, retries or resumes old runs.",
    input: z.strictObject({ runId: z.string().regex(/^recipe_native_[a-f0-9]{32}$/) }), output: result },
  { id: "recipe.history.get", readOnly: true,
    description: "Pure exact-SHA read of an original Recipe run, including raw bytes, definition, inputs, receipts, results, progress and usage. Running originals are UNKNOWN, ownership is not inherited, and no getter, worker, replay or resume is invoked.",
    input: z.strictObject({ runId: z.string().regex(/^recipe_run_[a-f0-9]{24}$/), expectedSha256: digest }), output: result },
  { id: "recipe.runtime.cancel", readOnly: false,
    description: "Cancel one native Recipe at an exact version after separate fresh host approval. Effects are not rolled back.",
    input: z.strictObject({ ...mutation, runId: z.string().regex(/^recipe_native_[a-f0-9]{32}$/),
      expectedVersion: z.number().int().safe().positive() }), output: result },
] as const;
