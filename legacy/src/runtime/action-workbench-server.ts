import * as fs from "fs";
import * as path from "path";
import * as http from "http";
import { randomBytes, timingSafeEqual } from "crypto";

export interface ActionWorkbenchServer {
  readonly url: string;
  allowOrigin(origin: string): void;
  setDraft(draft: unknown): void;
  dispose(): void;
}

export async function createActionWorkbenchServer(options: {
  extensionPath: string;
  assets?: ReadonlyArray<readonly [string, readonly [string, string]]>;
  request(method: string, params: Record<string, unknown>): Promise<unknown>;
}): Promise<ActionWorkbenchServer> {
  const token = randomBytes(32).toString("hex");
  const origins = new Set<string>();
  let draft: unknown = null;
  const assets = new Map(options.assets || [
    ["/", ["resources/action-workbench.html", "text/html; charset=utf-8"]],
    ["/codicon.css", ["dist/webview/codicon.css", "text/css; charset=utf-8"]],
    ["/codicon.ttf", ["dist/webview/codicon.ttf", "font/ttf"]],
  ]);
  const server = http.createServer((request, response) => {
    const send = (status: number, value: unknown) => {
      if (response.writableEnded) return;
      response.writeHead(status, { "Content-Type": "application/json", "Cache-Control": "no-store",
        "X-Content-Type-Options": "nosniff", "Referrer-Policy": "no-referrer" });
      response.end(JSON.stringify(value));
    };
    if (![...origins].some(origin => new URL(origin).host === request.headers.host)) {
      send(403, { ok: false, error: "Invalid Workbench host." });
      return;
    }
    if (request.method === "GET") {
      let pathname: string;
      try { pathname = new URL(request.url || "/", "http://127.0.0.1").pathname; }
      catch { return send(400, { ok: false, error: "Invalid Workbench URL." }); }
      const asset = assets.get(pathname);
      if (!asset) return send(404, { ok: false, error: "Unknown Workbench asset." });
      try {
        let content = fs.readFileSync(path.join(options.extensionPath, asset[0]));
        const nonce = randomBytes(24).toString("hex");
        if (pathname === "/") content = Buffer.from(content.toString("utf8")
          .replace("<head>", '<head><link rel="stylesheet" href="codicon.css">')
          .replace(/<script\b/g, `<script nonce="${nonce}"`));
        response.writeHead(200, { "Content-Type": asset[1], "Cache-Control": "no-store",
          "X-Content-Type-Options": "nosniff", "Referrer-Policy": "no-referrer",
          "Content-Security-Policy": `default-src 'none'; connect-src 'self'; font-src 'self'; style-src 'self' 'unsafe-inline'; script-src 'nonce-${nonce}'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'` });
        response.end(content);
      } catch { send(500, { ok: false, error: "Workbench assets are unavailable." }); }
      return;
    }
    const credential = Buffer.from(request.headers.authorization || "");
    const expected = Buffer.from(`Bearer ${token}`);
    if (request.method !== "POST" || request.url !== "/api" || !origins.has(request.headers.origin || "")
      || request.headers["content-type"] !== "application/json" || credential.length !== expected.length
      || !timingSafeEqual(credential, expected)) {
      send(403, { ok: false, error: "Unauthorized Workbench request." });
      return;
    }
    const chunks: Buffer[] = [];
    let length = 0;
    request.on("data", (chunk: Buffer) => {
      length += chunk.length;
      if (length > 1024 * 1024) { send(413, { ok: false, error: "Workbench request is too large." }); return; }
      chunks.push(chunk);
    });
    request.on("error", () => send(400, { ok: false, error: "Incomplete Workbench request." }));
    request.on("end", async () => {
      if (response.writableEnded) return;
      try {
        const value = JSON.parse(Buffer.concat(chunks).toString("utf8"));
        if (!value || typeof value.method !== "string" || !value.params || typeof value.params !== "object" || Array.isArray(value.params)) {
          return send(400, { ok: false, error: "Invalid Workbench operation." });
        }
        if (value.method === "session") {
          await options.request("access", {});
          return send(200, { ok: true, draft });
        }
        send(200, await options.request(value.method, value.params));
      } catch (error) { send(200, { ok: false, error: (error as Error).message }); }
    });
  });
  server.requestTimeout = 10000;
  server.headersTimeout = 5000;
  server.maxHeadersCount = 30;
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => { server.off("error", reject); resolve(); });
  });
  const origin = `http://127.0.0.1:${(server.address() as import("net").AddressInfo).port}`;
  origins.add(origin);
  return {
    url: `${origin}/#token=${token}`,
    allowOrigin(value) { const parsed = new URL(value); if (!["http:", "https:"].includes(parsed.protocol)) throw new Error("Invalid Workbench origin."); origins.add(parsed.origin); },
    setDraft(value) { draft = value; },
    dispose() { server.close(); server.closeAllConnections(); },
  };
}