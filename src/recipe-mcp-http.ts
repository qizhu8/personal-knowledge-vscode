import { createServer } from "node:http";
import { randomUUID, timingSafeEqual } from "node:crypto";
import type { AddressInfo } from "node:net";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { startMcp } from "./mcp.js";
import type { Core } from "./core.js";
import type { Actor } from "./contracts.js";

/** Optional isolated host surface, never started by ordinary activation or CLI. */
export async function startRecipeMcpHttp(core: Core, actor: Actor, token: string) {
  if (token.length < 32) throw Error("A separate strong Recipe MCP bearer is required.");
  const sessions = new Map<string, { transport: StreamableHTTPServerTransport; mcp: Awaited<ReturnType<typeof startMcp>> }>();
  let active = 0;
  const server = createServer(async (req, res) => {
    const host = `127.0.0.1:${(server.address() as AddressInfo).port}`;
    const supplied = Buffer.from(req.headers.authorization || ""), expected = Buffer.from(`Bearer ${token}`);
    if (req.headers.host !== host || req.socket.remoteAddress !== "127.0.0.1"
      || req.headers.origin !== undefined && req.headers.origin !== `http://${host}`
      || supplied.length !== expected.length || !timingSafeEqual(supplied, expected)) {
      res.writeHead(403); res.end(); return;
    }
    if (req.url !== "/mcp") { res.writeHead(404); res.end(); return; }
    if (active >= 32) { res.writeHead(503); res.end(); return; }
    active++;
    try {
      if (req.method === "POST") {
        const chunks: Buffer[] = []; let bytes = 0;
        for await (const chunk of req) {
          bytes += chunk.length;
          if (bytes > 1048576) throw Error("Recipe MCP body exceeds its budget.");
          chunks.push(chunk);
        }
        const body: unknown = JSON.parse(Buffer.concat(chunks).toString("utf8"));
        let session = typeof req.headers["mcp-session-id"] === "string" ? sessions.get(req.headers["mcp-session-id"]) : undefined;
        if (!session) {
          if (req.headers["mcp-session-id"] || !body || typeof body !== "object"
            || (body as { method?: string }).method !== "initialize" || sessions.size >= 16) {
            res.writeHead(400); res.end(); return;
          }
          const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: randomUUID,
            enableJsonResponse: true, onsessioninitialized: id => { sessions.set(id, session!); } });
          const mcp = await startMcp(core, { ...actor, recipeProtocol: true }, transport);
          session = { transport, mcp };
          const closed = transport.onclose;
          transport.onclose = () => { if (transport.sessionId) sessions.delete(transport.sessionId); closed?.(); };
        }
        await session.transport.handleRequest(req, res, body);
      } else {
        const session = typeof req.headers["mcp-session-id"] === "string" ? sessions.get(req.headers["mcp-session-id"]) : undefined;
        if (!session) { res.writeHead(404); res.end(); return; }
        await session.transport.handleRequest(req, res);
      }
    } catch { if (!res.headersSent) res.writeHead(400); res.end(); }
    finally { active--; }
  });
  server.requestTimeout = 10000; server.headersTimeout = 10000; server.maxHeadersCount = 50;
  await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
  return { url: `http://127.0.0.1:${(server.address() as AddressInfo).port}/mcp`,
    async close() {
      await Promise.all([...sessions.values()].map(session => session.mcp.close()));
      sessions.clear(); server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve()));
    } };
}
