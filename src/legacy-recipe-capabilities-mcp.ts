import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { projectRecipeDefinitions } from "./project-recipes-contracts.js";
import { workflowCompilerDefinitions } from "./workflow-compiler-contracts.js";

export function controlledLegacyRecipeCapabilities(nodeKinds: string[], executionSemantics: string) {
  return {
    autonomous: true, maxAutoNodes: { minimum: 1, maximum: 1000 },
    maxAutoSeconds: { minimum: 1, maximum: 3600 }, nodeKinds,
    executionSemantics, loops: executionSemantics === "original-recipe-metadata/v1", autonomousLoops: false,
    externalReportsRequireExplicitCaller: true, humanInputRequiresExplicitCaller: true,
  };
}

const originalRecipeLifecycleTools = [
  "recipe_search",
  "recipe_create_from_skill",
  "recipe_run_start",
  "recipe_run_start_adhoc",
  "recipe_run_get",
  "recipe_run_next",
  "recipe_run_progress",
  "recipe_run_report",
  "recipe_run_submit_input",
  "recipe_usage_summary",
] as const;

const recipeReadOperations = projectRecipeDefinitions
  .filter(operation => operation.id.startsWith("project.recipe.") && operation.readOnly)
  .map(operation => ({ operation: operation.id, readOnly: true as const }));
const workflowReadOperations = workflowCompilerDefinitions
  .filter(operation => operation.readOnly)
  .map(operation => ({ operation: operation.id, readOnly: true as const }));

type WorkflowCapabilities = z.infer<typeof workflowCompilerDefinitions[0]["output"]>;
type CapabilityReader = () => unknown | Promise<unknown>;

export function projectRecipeCapabilities(workflowCapabilities: unknown, nativeRecipes = false) {
  const native = workflowCompilerDefinitions[0].output.parse(workflowCapabilities) as WorkflowCapabilities;
  const result = {
    schema: "pkm.recipe.capabilities-projection/v1",
    capability: "pkm-recipes",
    projection: {
      status: "bounded",
      originalRecipeRuntime: "not-implemented-by-native-workflow-surfaces",
    },
    scope: [
      "read-only native Recipe metadata",
      "bounded deterministic workflow validation and compilation",
    ],
    useWhen: [
      "discovering validated native Recipe metadata",
      "checking or statically compiling a bounded workflow definition",
    ],
    doNotUseWhen: [
      "searching Recipes by task semantics or creating Recipes",
      "using this projection to start, schedule, advance, or report Recipe runs",
      "treating static compiler output as execution or expecting provider, model, network, or autonomous behavior from these compiler operations",
    ],
    nativeOperations: {
      recipes: recipeReadOperations,
      workflows: workflowReadOperations,
    },
    workflow: {
      schema: native.schema,
      definitionSchema: native.definitionSchema,
      execution: native.execution,
      formats: native.formats,
      limits: native.limits,
      kinds: native.kinds,
      unavailable: native.unavailable,
    },
    legacyRecipeToolsNotProvided: [...originalRecipeLifecycleTools],
  };
  return nativeRecipes ? { ...result,
    nativeOperations: { ...result.nativeOperations,
      recipes: result.nativeOperations.recipes.filter(item => item.operation !== "project.recipe.bundle.get") },
    nativeLibrary: { authority: "same-root-native-sqlite", metadataSearch: "original-local-metadata-and-family-fallback",
      readOperations: ["mcp.tool.recipe_search", "project.recipe.list", "project.recipe.get", "workflow.definition.validate", "workflow.definition.compile", "recipe.library.state"],
      executionOperations: ["recipe.runtime.start", "recipe.runtime.get", "recipe.runtime.cancel"],
      authorization: "Read exact per-actor catalog; mutation availability is separately composed and requires fresh exact host approval. A bearer alone never authorizes execution.",
      legacyExecutionCompatibility: "unavailable: native full-graph execution is not legacy lazy next/report/input/autonomous lifecycle",
      unavailable: ["subscribed-recipe-search", "project.recipe.bundle.get", "recipe_create_from_skill", "legacy-script-environment-authority"] },
    legacyRecipeToolsNotProvided: result.legacyRecipeToolsNotProvided.filter(name => name !== "recipe_search"),
  } : result;
}

export function registerRecipeCapabilitiesTool(
  server: McpServer,
  readWorkflowCapabilities: CapabilityReader,
  nativeRecipes = false,
  readComposedCapabilities?: () => Promise<Record<string, unknown>>,
): void {
  server.registerTool("recipe_capabilities", {
    description: "Read a bounded projection of native Recipe metadata and static workflow compiler capabilities. This does not advertise legacy Recipe lifecycle or execution support.",
    inputSchema: z.strictObject({}),
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
  }, async () => {
    const projected = readComposedCapabilities ? await readComposedCapabilities()
      : projectRecipeCapabilities(await readWorkflowCapabilities(), nativeRecipes);
    return {
      content: [{ type: "text", text: JSON.stringify(projected) }],
      structuredContent: projected,
    };
  });
}
