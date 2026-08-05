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
): Promise<LiveMarkdownServer> {
  const roots = assetRoots.map(item => ({ prefix: item.prefix.replace(/^\/+|\/+$/g, ""), root: resolve(item.root) }))
    .sort((left, right) => right.prefix.length - left.prefix.length);
  const server = createServer((req, res) => {
    try {
      const pathname = decodeURIComponent(new URL(String(req.url || "/"), "http://localhost").pathname);
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
    server.listen(0, "127.0.0.1", resolveStarted);
  });
  const port = (server.address() as any).port;
  return { server, localBaseUrl: `http://127.0.0.1:${port}` };
}