import { randomUUID } from "node:crypto";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema, type CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { sharedManagedRequest, type SharedManagedBinding } from "./shared-managed-client.js";

/** Stable front door: existing MCP sessions survive a manager-owned compatible backend handoff. */
export async function startSharedManagedRelay(binding: SharedManagedBinding) {
  const clientId = randomUUID();
  await sharedManagedRequest(binding, "/shared/enroll", { clientId });
  const server = new Server({ name: "pkm-v5-shared-isolated", version: "0.1.0" },
    { capabilities: { tools: {} } });
  server.setRequestHandler(ListToolsRequestSchema, async () => {
    const result = await sharedManagedRequest(binding, "/shared/tools", { clientId });
    return { tools: result.tools };
  });
  server.setRequestHandler(CallToolRequestSchema, async request => {
    const result = await sharedManagedRequest(binding, "/shared/call", {
      clientId, name: request.params.name, arguments: request.params.arguments ?? {},
    });
    return result.result as CallToolResult;
  });
  const end = () => { void server.close().catch(() => {}); };
  server.onclose = () => {
    process.stdin.removeListener("end", end);
    void sharedManagedRequest(binding, "/shared/leave", { clientId }).catch(() => {});
  };
  try { await server.connect(new StdioServerTransport()); }
  catch (error) {
    await sharedManagedRequest(binding, "/shared/leave", { clientId }).catch(() => {});
    throw error;
  }
  process.stdin.once("end", end);
  return server;
}

if (process.argv[1]?.replaceAll("\\", "/").endsWith("/shared-managed-relay.js")) {
  const { PKM_SHARED_ORIGIN: origin, PKM_SHARED_SERVICE_ID: serviceId, PKM_SHARED_TOKEN: token } = process.env;
  delete process.env.PKM_SHARED_TOKEN;
  if (!origin || !serviceId || !token) throw new Error("Explicit shared service enrollment required.");
  await startSharedManagedRelay({ origin, serviceId, token });
}
