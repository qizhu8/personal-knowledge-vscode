import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { methods, type Core } from "./core.js";
import { resultEnvelope, type Actor } from "./contracts.js";

export async function startMcp(core: Core, actor: Actor) {
  const server = new McpServer({ name: "pkm-next-mcp-server", version: "0.1.0" });
  for (const [name, method] of Object.entries(methods)) {
    if (!actor.canWrite && !method.readOnly) continue;
    server.registerTool(name, {
      description: method.description,
      inputSchema: method.schema,
      outputSchema: resultEnvelope,
      annotations: { readOnlyHint: method.readOnly, destructiveHint: !method.readOnly, idempotentHint: true, openWorldHint: false },
    }, async (args: unknown) => {
      const result = await core.dispatch(name, args, actor);
      return { isError: !!result.error, content: [{ type: "text" as const, text: JSON.stringify(result) }], structuredContent: result };
    });
  }
  await server.connect(new StdioServerTransport());
  return server;
}
