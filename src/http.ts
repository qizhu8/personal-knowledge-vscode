import { createServer, type IncomingMessage } from "node:http";
import { timingSafeEqual, randomUUID } from "node:crypto";
import type { AddressInfo } from "node:net";
import { CoreError, type Actor } from "./contracts.js";
import type { Core } from "./core.js";
import { loadBrowserAssets } from "./browser-host.js";

async function body(req: IncomingMessage, maximum = Number.POSITIVE_INFINITY): Promise<unknown> {
  const chunks: Buffer[] = [];
  let bytes = 0;
  for await (const chunk of req) {
    bytes += chunk.length;
    if (bytes > maximum) throw new CoreError("INVALID_ARGUMENT", "Recipe HTTP body exceeds its bounded budget.");
    chunks.push(chunk);
  }
  try { return JSON.parse(Buffer.concat(chunks).toString("utf8")); }
  catch { throw new CoreError("INVALID_ARGUMENT", "Expected a JSON body."); }
}
export async function startHttp(core: Core, token: string, actor: Actor, port = 0,
  human?: { handle(req: IncomingMessage, res: import("node:http").ServerResponse, body: () => Promise<unknown>): Promise<boolean> },
  recipe?: { handle(req: IncomingMessage, res: import("node:http").ServerResponse, body: () => Promise<unknown>): Promise<void> }) {
  if (token.length < 32) throw new CoreError("INVALID_CONFIGURATION", "PKM_NEXT_TOKEN must contain at least 32 characters.");
  const { assets, headers: staticHeaders } = await loadBrowserAssets();
  let active = 0;
  const server = createServer(async (req, res) => {
    const reply = (status: number, value: Record<string, unknown>) => {
      res.writeHead(status, { "Content-Type": "application/json", "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" });
      res.end(JSON.stringify({ schema: "pkm.next-result/v1", requestId: randomUUID(), ...value }));
    };
    const address = server.address() as AddressInfo | null;
    const host = address ? `127.0.0.1:${address.port}` : "";
    if (req.headers.host !== host || req.socket.remoteAddress !== "127.0.0.1"
      || req.headers.origin !== undefined && req.headers.origin !== `http://${host}`) {
      reply(403, { error: { code: "ACCESS_DENIED", message: "Only exact same-origin loopback requests are supported.", effect: "not-committed" } }); return;
    }
    const assetPath = req.url === "/" ? "/index.html" : req.url;
    const asset = assets.get(assetPath ?? "");
    if (asset && (req.method === "GET" || req.method === "HEAD")) {
      res.writeHead(200, { ...staticHeaders, "Content-Type": assetPath!.endsWith(".html") ? "text/html; charset=utf-8"
        : assetPath!.endsWith(".css") ? "text/css; charset=utf-8" : "text/javascript; charset=utf-8" });
      res.end(req.method === "HEAD" ? undefined : asset); return;
    }
    if (human && await human.handle(req, res, () => body(req))) return;
    const supplied = Buffer.from(req.headers.authorization || "");
    const expected = Buffer.from(`Bearer ${token}`);
    if (supplied.length !== expected.length || !timingSafeEqual(supplied, expected)) {
      reply(401, { error: { code: "UNAUTHORIZED", message: "Bearer token required.", effect: "not-committed" } }); return;
    }
    const recipeRoute = !!recipe && /^\/api\/(?:recipe|validate)$/.test(req.url || "");
    if (!recipeRoute && (req.method !== "POST" || !/^\/v1\/[a-z_]+$/.test(req.url || ""))) {
      reply(404, { error: { code: "NOT_FOUND", message: "Use POST /v1/<method>.", effect: "not-committed" } }); return;
    }
    if (active >= 32) { reply(503, { error: { code: "BUSY", message: "HTTP admission limit reached.", effect: "not-committed" } }); return; }
    active++;
    try {
      if (!(recipeRoute && req.method === "GET") && req.headers["content-type"]?.split(";")[0].trim() !== "application/json") throw new CoreError("INVALID_ARGUMENT", "Content-Type must be application/json.");
      if (recipeRoute) { await recipe!.handle(req, res, () => body(req, 1048576)); return; }
      const result = await core.dispatch(req.url!.slice(4), await body(req), actor);
      const status = result.error ? ({
        ACCESS_DENIED: 403, NOT_FOUND: 404, CONFLICT: 409, BUSY: 503, STORAGE_UNAVAILABLE: 503,
        STORAGE_ERROR: 500, INTERNAL: 500, INVALID_RESULT: 500,
        RECOVERY_CONFLICT: 409, INVALID_DOCUMENT: 422,
        DOMAIN_REJECTED: 409, WORKITEM_FOCUS_CONFLICT: 409,
        NOT_AVAILABLE: 503,
        RECIPE_OPERATION_UNCERTAIN: 500,
      }[result.error.code] ?? 400) : 200;
      reply(status, result);
    } catch (error) {
      if (!(error instanceof CoreError)) console.error("PKM next HTTP:", error);
      reply(400, { error: {
        code: error instanceof CoreError ? error.code : "REQUEST_ERROR",
        message: error instanceof CoreError ? error.message : "Request failed; inspect server diagnostics.",
        effect: "not-committed",
      } });
    } finally { active--; }
  });
  server.requestTimeout = 10000;
  server.headersTimeout = 10000;
  server.timeout = 15000;
  server.maxHeadersCount = 50;
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", resolve);
  });
  return { server, url: `http://127.0.0.1:${(server.address() as AddressInfo).port}` };
}
