import { createServer, Server } from "http";
import { createHash } from "crypto";
import { existsSync, readFileSync, statSync } from "fs";
import { extname, resolve, sep } from "path";

function liveRefreshScript(version: string): string {
  return `<script data-pkm-live-refresh>
(() => {
  const version = ${JSON.stringify(version)};
  const key = 'pkm-reader-position:' + location.pathname;
  let dirty = false;
  const searchPanel = document.querySelector('.reader-search');
  if (searchPanel) {
    searchPanel.hidden = true;
    let returnFocus;
    document.addEventListener('keydown', event => {
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'f') {
        event.preventDefault();
        returnFocus = document.activeElement;
        document.querySelector('.reader-sidebar > details').open = true;
        searchPanel.hidden = false;
        searchPanel.querySelector('input').focus();
      } else if (event.key === 'Escape' && !searchPanel.hidden) {
        event.preventDefault();
        const input = searchPanel.querySelector('input');
        input.value = '';
        input.dispatchEvent(new Event('input', { bubbles:true }));
        searchPanel.hidden = true;
        returnFocus?.focus();
      }
    });
  }
  document.addEventListener('input', event => {
    if (event.target.closest('.reader-search')) return;
    if (event.target.matches('input,textarea,select') || event.target.isContentEditable) dirty = true;
  });
  window.addEventListener('load', () => {
    try {
      const saved = JSON.parse(sessionStorage.getItem(key) || 'null');
      sessionStorage.removeItem(key);
      if (!saved) return;
      const search = document.querySelector('.reader-search input');
      if (search && saved.search) { search.value = saved.search; search.dispatchEvent(new Event('input', { bubbles:true })); }
      if (searchPanel) searchPanel.hidden = !saved.searchOpen;
      const library = document.querySelector('.reader-sidebar > details');
      if (library) library.open = saved.libraryOpen !== false;
      const sidebar = document.querySelector('.reader-sidebar');
      if (sidebar) sidebar.scrollTop = saved.sidebarY || 0;
      scrollTo(saved.x, saved.y);
    } catch {}
  });
  async function check() {
    try {
      if (document.visibilityState !== 'hidden' && !dirty && document.documentElement.dataset.pkmDirty !== 'true') {
        const response = await fetch(location.href, { method:'HEAD', cache:'no-store', credentials:'same-origin' });
        if (response.ok && response.headers.get('ETag') && response.headers.get('ETag') !== version) {
          if (!dirty && document.documentElement.dataset.pkmDirty !== 'true') {
            try { sessionStorage.setItem(key, JSON.stringify({ x:scrollX, y:scrollY, search:document.querySelector('.reader-search input')?.value || '', searchOpen:searchPanel && !searchPanel.hidden, libraryOpen:document.querySelector('.reader-sidebar > details')?.open, sidebarY:document.querySelector('.reader-sidebar')?.scrollTop || 0 })); } catch {}
            location.reload();
            return;
          }
        } else if (response.status === 403 || response.status === 404) {
          location.reload();
          return;
        }
      }
    } catch {}
    setTimeout(check, 2000);
  }
  setTimeout(check, 2000);
})();
</script>`;
}

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
        const version = `"${createHash("sha256").update(html).digest("hex")}"`;
        res.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store, no-cache, must-revalidate", ETag: version });
        if (req.method === "HEAD") { res.end(); return; }
        const script = liveRefreshScript(version);
        res.end(html.includes("</body>") ? html.replace("</body>", `${script}</body>`) : html + script); return;
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