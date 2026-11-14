import type { RecipeRecord } from "./project-model";

/** Optional fields absent from JSON must stay absent from the command fingerprint. */
export function recipeEditorUpdateInput(body: Partial<RecipeRecord>, nodeBindings: RecipeRecord["nodeBindings"]) {
  if (body.definition === undefined) throw new Error("Recipe definition is required.");
  return {
    name: String(body.name || ""), category: String(body.category || ""), description: String(body.description || ""),
    definition: body.definition,
    nodeBindings: nodeBindings ?? [],
    ...(body.methodology === undefined ? {} : { methodology: body.methodology }),
    ...(body.metadata === undefined ? {} : { metadata: body.metadata }),
    ...(body.editorLayout === undefined ? {} : { editorLayout: body.editorLayout }),
  };
}
