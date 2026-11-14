import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import { methods, type Core } from "./core.js";
import { resultEnvelope, type Actor } from "./contracts.js";
import { registerLegacyApiChatReadTools } from "./legacy-api-chat-read.js";
import { registerRecipeCapabilitiesTool } from "./legacy-recipe-capabilities-mcp.js";
import { legacyRecipeSearchInput } from "./recipe-public-contracts.js";
import { legacyRecipeLazyOperations } from "./legacy-recipe-lazy-contracts.js";

export async function startMcp(core: Core, actor: Actor, transport: Transport = new StdioServerTransport()) {
  const server = new McpServer({ name: "pkm-next-mcp-server", version: "0.1.0" });
  const recipe = await core.dispatch("capabilities_describe", { operation: "recipe.compat.search" }, actor);
  const nativeRecipes = !recipe.error;
  for (const [name, method] of Object.entries(methods)) {
    if (!actor.canWrite && !method.readOnly) continue;
    server.registerTool(name, {
      description: method.description,
      inputSchema: method.schema,
      ...(nativeRecipes && (name === "capability_read" || name === "capability_call") ? {} : { outputSchema: resultEnvelope }),
      annotations: { readOnlyHint: method.readOnly, destructiveHint: !method.readOnly,
        idempotentHint: method.readOnly, openWorldHint: name === "capability_call" },
    }, async (args: unknown) => {
      const result = await core.dispatch(name, args, actor);
      const operation = (args as { operation?: string })?.operation;
      const value = nativeRecipes && !result.error
        && (name === "capability_read" && (operation === "mcp.tool.recipe_search" || operation === "mcp.tool.recipe_capabilities")
          || name === "capability_call" && !!operation && legacyRecipeLazyOperations.has(operation))
        ? result.result as Record<string, unknown> : result;
      return { isError: !!result.error, content: [{ type: "text" as const, text: JSON.stringify(value) }], structuredContent: value };
    });
  }
  if (!actor.recipeProtocol) registerLegacyApiChatReadTools(server, core, actor);
  if (nativeRecipes) server.registerTool("recipe_search", {
    description: "Original local Recipe metadata ranking and Methodology fallback over the same native Library as the UI. No subscribed catalog or execution authority is inferred.",
    inputSchema: legacyRecipeSearchInput,
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  }, async args => {
    const response = await core.dispatch("capability_read", { operation: "recipe.compat.search", version: 1, arguments: args }, actor);
    const result = response.error ? response : response.result!;
    return { isError: !!response.error, content: [{ type: "text" as const, text: JSON.stringify(result) }],
      structuredContent: result as Record<string, unknown> };
  });
  registerRecipeCapabilitiesTool(server, async () => {
    const result = await core.dispatch("capability_read", {
      operation: "workflow.compiler.capabilities", version: 1, arguments: {},
    }, actor);
    if ("error" in result && result.error) throw new Error(result.error.message);
    if (!("result" in result)) throw new Error("Native workflow compiler capabilities are unavailable.");
    return result.result;
  }, nativeRecipes, nativeRecipes ? async () => {
    const result = await core.dispatch("capability_read", {
      operation: "mcp.tool.recipe_capabilities", version: 1, arguments: {},
    }, actor);
    if (result.error) throw new Error(result.error.message);
    return result.result as Record<string, unknown>;
  } : undefined);
  await server.connect(transport);
  return server;
}
