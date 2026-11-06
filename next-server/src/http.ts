import { createServer, type IncomingMessage } from "node:http";
import { timingSafeEqual, randomUUID } from "node:crypto";
import type { AddressInfo } from "node:net";
import { CoreError, type Actor } from "./contracts.js";
import type { Core } from "./core.js";

async function body(req: IncomingMessage): Promise<unknown> {
  let bytes = 0;
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    bytes += chunk.length;
    if (bytes > 131072) throw new CoreError("TOO_LARGE", "Request exceeds 128 KiB.");
    chunks.push(chunk);
  }
  try { return JSON.parse(Buffer.concat(chunks).toString("utf8")); }
  catch { throw new CoreError("INVALID_ARGUMENT", "Expected a JSON body."); }
}
export async function startHttp(core: Core, token: string, actor: Actor, port = 0) {
  if (token.length < 32) throw new CoreError("INVALID_CONFIGURATION", "PKM_NEXT_TOKEN must contain at least 32 characters.");
  let active = 0;
  const server = createServer(async (req, res) => {
    const reply = (status: number, value: Record<string, unknown>) => {
      res.writeHead(status, { "Content-Type": "application/json", "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" });
      res.end(JSON.stringify({ schema: "pkm.next-result/v1", requestId: randomUUID(), ...value }));
    };
    const supplied = Buffer.from(req.headers.authorization || "");
    const expected = Buffer.from(`Bearer ${token}`);
    if (supplied.length !== expected.length || !timingSafeEqual(supplied, expected)) {
      reply(401, { error: { code: "UNAUTHORIZED", message: "Bearer token required.", effect: "not-committed" } }); return;
    }
    if (req.headers.origin || !/^127\.0\.0\.1:\d+$/.test(req.headers.host || "")) {
      reply(403, { error: { code: "ACCESS_DENIED", message: "Only direct loopback API requests are supported; Browser access is not enabled.", effect: "not-committed" } }); return;
    }
    if (req.method !== "POST" || !/^\/v1\/[a-z_]+$/.test(req.url || "")) {
      reply(404, { error: { code: "NOT_FOUND", message: "Use POST /v1/<method>.", effect: "not-committed" } }); return;
    }
    if (active >= 32) { reply(503, { error: { code: "BUSY", message: "HTTP admission limit reached.", effect: "not-committed" } }); return; }
    active++;
    try {
      if (req.headers["content-type"]?.split(";")[0].trim() !== "application/json") throw new CoreError("INVALID_ARGUMENT", "Content-Type must be application/json.");
      const result = await core.dispatch(req.url!.slice(4), await body(req), actor);
      const status = result.error ? ({
        ACCESS_DENIED: 403, NOT_FOUND: 404, CONFLICT: 409, BUSY: 503, STORAGE_UNAVAILABLE: 503,
        STORAGE_ERROR: 500, INTERNAL: 500, INVALID_RESULT: 500,
      }[result.error.code] ?? 400) : 200;
      reply(status, result);
    } catch (error) {
      if (!(error instanceof CoreError)) console.error("PKM next HTTP:", error);
      reply(error instanceof CoreError && error.code === "TOO_LARGE" ? 413 : 400, { error: {
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
