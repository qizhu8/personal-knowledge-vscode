import { createServer, Server } from "http";
import { existsSync, readFileSync, statSync } from "fs";
import { extname, resolve, sep } from "path";

export interface LiveMarkdownServer {
  server: Server;
  localBaseUrl: string;
}

export async function startLiveMarkdownServer(
  assetRoots: Array<{ prefix: string; root: string }>,
  renderDocument: (documentPath: string) => string | undefined,
  mimeByExt: Record<string, string>,
  options: {
    listenHost?: string;
    port?: number;
    accessToken?: string;
    authorizePath?: (pathname: string) => boolean;
    identity?: Record<string, string | number | boolean>;
    favicon?: Buffer;
  } = {},
): Promise<LiveMarkdownServer> {
  const roots = assetRoots.map(item => ({ prefix: item.prefix.replace(/^\/+|\/+$/g, ""), root: resolve(item.root) }))
    .sort((left, right) => right.prefix.length - left.prefix.length);
  const accessToken = String(options.accessToken || "");
  const cookieName = `pkm_preview_${accessToken.slice(0, 10)}`;
  const server = createServer((req, res) => {
    try {
      const requestUrl = new URL(String(req.url || "/"), "http://localhost");
      if (requestUrl.pathname === "/.well-known/pkm-content") {
        res.writeHead(200, { "Content-Type": "application/json", "Cache-Control": "no-store" });
        res.end(JSON.stringify({ protocol: "pkm-content:v1", ...(options.identity || {}) })); return;
      }
      if (accessToken) {
        const queryAuthorized = requestUrl.searchParams.get("_pkm_token") === accessToken;
        const cookieAuthorized = String(req.headers.cookie || "").split(";").some(value => value.trim() === `${cookieName}=${accessToken}`);
        if (!queryAuthorized && !cookieAuthorized) { res.writeHead(403); res.end("Preview access denied"); return; }
        if (queryAuthorized) res.setHeader("Set-Cookie", `${cookieName}=${accessToken}; HttpOnly; SameSite=Strict; Path=/`);
      }
      const pathname = decodeURIComponent(requestUrl.pathname);
      if (pathname === "/favicon.ico" && options.favicon) {
        res.writeHead(200, { "Content-Type": "image/png", "Cache-Control": "public, max-age=86400" });
        res.end(options.favicon); return;
      }
      if (options.authorizePath && !options.authorizePath(pathname)) { res.writeHead(404); res.end("Not found"); return; }
      if (pathname.endsWith(".html")) {
        const documentPath = pathname.replace(/^\/+/, "").replace(/\.html$/i, "");
        const html = renderDocument(documentPath);
        if (!html) { res.writeHead(404); res.end("Markdown document not found"); return; }
        res.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store, no-cache, must-revalidate" });
        res.end(html); return;
      }
      const requested = pathname.replace(/^\/+/, "");
      const mapping = roots.find(item => !item.prefix || requested === item.prefix || requested.startsWith(item.prefix + "/"));
      if (!mapping) { res.writeHead(404); res.end("Not found"); return; }
      const relative = mapping.prefix ? requested.slice(mapping.prefix.length).replace(/^\/+/, "") : requested;
      const file = resolve(mapping.root, relative);
      if (!file.startsWith(mapping.root + sep) || !existsSync(file) || statSync(file).isDirectory()) {
        res.writeHead(404); res.end("Not found"); return;
      }
      const ext = extname(file).slice(1).toLowerCase();
      res.writeHead(200, { "Content-Type": mimeByExt[ext] || "application/octet-stream", "Cache-Control": "no-store" });
      res.end(readFileSync(file));
    } catch { res.writeHead(500); res.end("Preview error"); }
  });
  await new Promise<void>((resolveStarted, reject) => {
    server.once("error", reject);
    server.listen(options.port || 0, options.listenHost || "127.0.0.1", resolveStarted);
  });
  const port = (server.address() as any).port;
  return { server, localBaseUrl: `http://127.0.0.1:${port}` };
}