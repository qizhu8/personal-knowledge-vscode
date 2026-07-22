import * as vscode from "vscode";
import * as path from "path";
import * as os from "os";
import * as http from "http";
import * as fs from "fs";
import { syncServer } from "./sync-server";
import {
  skillList, skillSearch, skillGet, skillUpsert, skillDelete, skillMoveCategory, skillMove,
  noteList, noteSearch, noteGet, noteUpsert, noteDelete, slugExists, noteMove, noteMoveFolder, noteSetPinned, noteFolderPins, noteSetFolderPinned,
  noteExport, noteImport, saveNoteAsset,
  paperList, paperSearch, paperGet, paperUpsert, paperDelete,
  paperFacets, paperGraph, savePaperFile,
  paperGroups, paperSetGroup, paperGroupRename, paperGroupDelete, paperSetPinned, paperSetTopic,
  setStorePath as fsSetStorePath, getStorePath,
} from "./filestore";
import { migrateDbToFiles } from "./migrate";
import {
  promptList, promptGetFile, promptGetAllVersionsOfFile,
  packageList, packageGet, packageFileGet,
  scriptList, scriptGet, scriptMove, scriptMoveFolder,
  promptImport, scriptImport, packageImport,
  setStorePath as storageSetStorePath,
} from "./storage";

// ── Git helper ─────────────────────────────────────────────────────────────
import { execSync } from "child_process";
import { createHash } from "crypto";

// ── Logging ────────────────────────────────────────────────────────────────
type LogLevel = "debug" | "info" | "warn" | "error";
const LEVEL_ORDER: Record<LogLevel, number> = { debug: 0, info: 1, warn: 2, error: 3 };

class Logger {
  private channel: vscode.OutputChannel;
  private logFile = "";
  private minLevel: LogLevel = "info";

  constructor() {
    this.channel = vscode.window.createOutputChannel("Personal Knowledge");
  }

  init(context: vscode.ExtensionContext): void {
    try {
      const dir = context.globalStorageUri.fsPath;
      fs.mkdirSync(dir, { recursive: true });
      this.logFile = path.join(dir, "personal-knowledge.log");
    } catch { /* file logging optional */ }
    this.refreshLevel();
  }

  refreshLevel(): void {
    const cfg = vscode.workspace.getConfiguration("personalKnowledge");
    this.minLevel = (cfg.get<LogLevel>("logLevel") ?? "info");
  }

  private write(level: LogLevel, msg: string): void {
    if (LEVEL_ORDER[level] < LEVEL_ORDER[this.minLevel]) return;
    const line = `[${new Date().toISOString()}] [${level.toUpperCase()}] ${msg}`;
    this.channel.appendLine(line);
    if (this.logFile) {
      try { fs.appendFileSync(this.logFile, line + "\n"); } catch { /* ignore */ }
    }
  }

  debug(msg: string): void { this.write("debug", msg); }
  info(msg: string):  void { this.write("info", msg); }
  warn(msg: string):  void { this.write("warn", msg); }
  error(msg: string): void { this.write("error", msg); }

  /** Log a user action (always at info level for auditability). */
  action(name: string, detail?: object): void {
    this.write("info", `action: ${name}${detail ? " " + JSON.stringify(detail) : ""}`);
  }

  show(): void { this.channel.show(); }
}

const log = new Logger();

/** Ensure the knowledge store is a git repository (init on first use). */
function ensureGitRepo(): void {
  try {
    const store = getStorePath();
    if (!store || !fs.existsSync(store)) return;
    if (fs.existsSync(path.join(store, ".git"))) return;
    execSync(`git -C "${store}" init`, { stdio: "pipe" });
    // Ignore the binary DB + WAL and generated MCP server; track the markdown mirror instead
    const gitignore = path.join(store, ".gitignore");
    if (!fs.existsSync(gitignore)) {
      fs.writeFileSync(gitignore, "knowledge.db\nknowledge.db-shm\nknowledge.db-wal\nmcp-server/\n");
    }
    execSync(`git -C "${store}" add -A && git -C "${store}" commit -m "init: personal knowledge store" --allow-empty`, { stdio: "pipe" });
    log.info(`initialized git repo in ${store}`);
  } catch (e: any) {
    log.warn(`ensureGitRepo failed: ${e?.message}`);
  }
}

function gitCommit(msg: string): void {
  try {
    const store = getStorePath();
    execSync(`git -C "${store}" add -A && git -C "${store}" commit -m "${msg.replace(/"/g, '\\"')}"`, { stdio: "pipe" });
  } catch { /* nothing to commit */ }
}

// (Notes & skills are persisted directly as files by filestore.ts — no separate mirror needed.)

// ── Slug from title ────────────────────────────────────────────────────────
function toSlug(title: string): string {
  return title.toLowerCase().replace(/[^a-z0-9\s-]/g, "").trim()
    .replace(/\s+/g, "-").slice(0, 40) || `note-${Date.now()}`;
}
function uniqueSlug(title: string): string {
  let slug = toSlug(title), n = 2;
  while (slugExists(slug)) slug = `${toSlug(title)}-${n++}`;
  return slug;
}

// Paper identity is its folder path + title (title preserved). paperUpsert
// writes to the sanitized path; this just builds the category/title key.
function uniquePaperSlug(title: string, category: string): string {
  const cat = (category || "").replace(/^\/+|\/+$/g, "");
  return (cat ? cat + "/" : "") + ((title || "paper").trim() || "paper");
}

// ── Standalone note HTML export ──────────────────────────────────────────────
/** Filesystem-safe filename part (no path separators or reserved chars). */
function safeFilePart(s: string): string {
  return (s || "").replace(/[/\\:*?"<>|\u0000-\u001f]/g, "").trim().slice(0, 120);
}

/**
 * Open a self-contained HTML document in the user's real browser — works both
 * locally and over Remote-SSH. We serve the doc from an ephemeral loopback HTTP
 * server and route the URL through `asExternalUri`, which tunnels the port to
 * the local machine on remote setups (and is a no-op locally). This avoids the
 * `vscode-remote:`/`file:` "select an app" prompt you get from opening a file URI.
 */
async function openHtmlInBrowser(doc: string): Promise<boolean> {
  return await new Promise<boolean>((resolve) => {
    let settled = false;
    const finish = (v: boolean) => { if (!settled) { settled = true; resolve(v); } };
    try {
      const server = http.createServer((req, res) => {
        res.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" });
        res.end(doc);
      });
      server.on("error", () => finish(false));
      // Auto-close after a grace period; a self-contained page needs one GET.
      const closeTimer = setTimeout(() => { try { server.close(); } catch { /* ignore */ } }, 120_000);
      closeTimer.unref?.();
      server.listen(0, "127.0.0.1", async () => {
        try {
          const port = (server.address() as any).port;
          const local = vscode.Uri.parse(`http://127.0.0.1:${port}/`);
          const external = await vscode.env.asExternalUri(local);
          const opened = await vscode.env.openExternal(external);
          finish(!!opened);
        } catch {
          try { server.close(); } catch { /* ignore */ }
          finish(false);
        }
      });
    } catch {
      finish(false);
    }
  });
}

const MIME_BY_EXT: Record<string, string> = {
  png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", gif: "image/gif",
  webp: "image/webp", svg: "image/svg+xml", bmp: "image/bmp", avif: "image/avif",
};

/** Inline `_assets/<file>` image references as base64 data URIs for a portable file.
 *  Assets live in the note's own folder: notes/<category>/_assets/<file>. */
function inlineNoteAssets(html: string, category = ""): string {
  const catSegs = String(category || "").split("/").map(s => s.trim()).filter(Boolean);
  const assetsDir = path.join(getStorePath(), "notes", ...catSegs, "_assets");
  return html.replace(/(src\s*=\s*)("|')_assets\/([^"']+)\2/gi, (m, pre, q, file) => {
    try {
      const name = decodeURIComponent(file);
      const full = path.join(assetsDir, name);
      if (!full.startsWith(assetsDir) || !fs.existsSync(full)) return m;
      const ext = (path.extname(name).slice(1) || "png").toLowerCase();
      const mime = MIME_BY_EXT[ext] || "application/octet-stream";
      const b64 = fs.readFileSync(full).toString("base64");
      return `${pre}${q}data:${mime};base64,${b64}${q}`;
    } catch { return m; }
  });
}

/** Serve a folder of exported note HTML files and open the entry file in the
 *  user's browser (works over Remote-SSH via asExternalUri). Used by the linked
 *  ("site") export so cross-note links resolve to sibling .html files. */
async function serveFolderInBrowser(dir: string, entry: string): Promise<boolean> {
  return await new Promise<boolean>((resolve) => {
    let settled = false;
    const finish = (v: boolean) => { if (!settled) { settled = true; resolve(v); } };
    try {
      const server = http.createServer((req, res) => {
        try {
          const urlPath = decodeURIComponent(String(req.url || "/").replace(/[?#].*$/, ""));
          const rel = urlPath === "/" ? entry : urlPath.replace(/^\/+/, "");
          const full = path.join(dir, rel);
          if (!full.startsWith(dir) || !fs.existsSync(full) || fs.statSync(full).isDirectory()) {
            res.writeHead(404); res.end("Not found"); return;
          }
          const ext = path.extname(full).slice(1).toLowerCase();
          const mime = ext === "html" ? "text/html; charset=utf-8"
            : ext === "css" ? "text/css" : ext === "js" ? "text/javascript"
            : (MIME_BY_EXT[ext] || "application/octet-stream");
          res.writeHead(200, { "Content-Type": mime, "Cache-Control": "no-store" });
          res.end(fs.readFileSync(full));
        } catch { res.writeHead(500); res.end("error"); }
      });
      server.on("error", () => finish(false));
      const closeTimer = setTimeout(() => { try { server.close(); } catch { /* ignore */ } }, 600_000);
      closeTimer.unref?.();
      server.listen(0, "127.0.0.1", async () => {
        try {
          const port = (server.address() as any).port;
          const local = vscode.Uri.parse(`http://127.0.0.1:${port}/${encodeURIComponent(entry)}`);
          const external = await vscode.env.asExternalUri(local);
          const opened = await vscode.env.openExternal(external);
          finish(!!opened);
        } catch { try { server.close(); } catch { /* ignore */ } finish(false); }
      });
    } catch { finish(false); }
  });
}

// Extract cross-note link targets ([[Title]] wiki links and [text](path.md)).
function extractNoteLinks(content: string): string[] {
  const out: string[] = [];
  let m: RegExpExecArray | null;
  const wiki = /\[\[([^\]|]+)(?:\|[^\]]+)?\]\]/g;
  while ((m = wiki.exec(content))) out.push(m[1].trim());
  const md = /\[[^\]]*\]\(\s*([^)]+?\.md)(?:[?#][^)]*)?\s*\)/gi;
  while ((m = md.exec(content))) out.push(m[1].trim());
  return out;
}

// Rewrite a note's cross-note links to point at sibling exported .html files.
function rewriteNoteLinks(
  content: string, fromSlug: string,
  resolve: (t: string, from: string) => string | null,
  filenames: Map<string, string>,
): string {
  content = content.replace(/\[\[([^\]|]+)(?:\|([^\]]+))?\]\]/g, (m, t, a) => {
    const label = String(a || t).trim();
    const slug = resolve(String(t).trim(), fromSlug);
    const fn = slug ? filenames.get(slug) : undefined;
    return fn ? `[${label}](${fn})` : label;
  });
  content = content.replace(/\[([^\]]*)\]\(\s*([^)]+?\.md)(?:[?#][^)]*)?\s*\)/gi, (m, label, pth) => {
    const slug = resolve(String(pth).trim(), fromSlug);
    const fn = slug ? filenames.get(slug) : undefined;
    return fn ? `[${label}](${fn})` : m;
  });
  return content;
}

/** Collect the transitive closure of notes reachable from `rootSlug` via links,
 *  assign each a flat .html filename, and rewrite links to those filenames. */
function collectLinkedNotes(rootSlug: string): any[] {
  const root = noteGet(rootSlug);
  if (!root) return [];
  const all = noteList(undefined, 100000) as any[];
  const resolve = (target: string, fromSlug: string): string | null => {
    if (/\.md(\?|#|$)/i.test(target) || target.includes("/")) {
      const s = resolveNoteSlugFromPath(target, fromSlug);
      if (s && noteGet(s)) return s;
    }
    const direct = target.replace(/\.md$/i, "");
    if (noteGet(direct)) return direct;
    const needle = direct.toLowerCase();
    const base = needle.split("/").pop() || needle;
    const hit = all.find(
      n => (n.title || "").toLowerCase() === needle ||
           (n.slug || "").toLowerCase() === needle ||
           (n.slug || "").toLowerCase().endsWith("/" + base) ||
           (n.title || "").toLowerCase() === base,
    );
    return hit ? hit.slug : null;
  };
  const used = new Set<string>();
  const filenames = new Map<string, string>();
  const mkFilename = (slug: string, title: string): string => {
    const base = (safeFilePart(title || slug).replace(/\//g, "_").replace(/\s+/g, "_") || "note").slice(0, 100);
    let name = base + ".html", i = 2;
    while (used.has(name.toLowerCase())) name = `${base}-${i++}.html`;
    used.add(name.toLowerCase());
    return name;
  };
  const visited = new Map<string, any>();
  visited.set(rootSlug, root);
  filenames.set(rootSlug, mkFilename(rootSlug, root.title));
  const queue = [rootSlug];
  while (queue.length) {
    const cur = queue.shift()!;
    const note = visited.get(cur);
    for (const raw of extractNoteLinks(note.content || "")) {
      const tslug = resolve(raw, cur);
      if (tslug && !visited.has(tslug)) {
        const tn = noteGet(tslug);
        if (tn) { visited.set(tslug, tn); filenames.set(tslug, mkFilename(tslug, tn.title)); queue.push(tslug); }
      }
    }
  }
  const out: any[] = [];
  for (const [slug, note] of visited) {
    out.push({
      slug, filename: filenames.get(slug),
      content: rewriteNoteLinks(note.content || "", slug, resolve, filenames),
    });
  }
  return out;
}

/** Wrap the webview-rendered note body in a self-contained, shareable HTML document. */
function buildStandaloneNoteHtml(msg: any, katexCss = ""): string {
  const esc = (s: string) => String(s ?? "")
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
  let tags: string[] = [];
  try { tags = JSON.parse(msg.tags || "[]"); } catch { tags = []; }
  const title = String(msg.title || msg.slug || "Note");
  const body = inlineNoteAssets(String(msg.bodyHtml || ""), String(msg.category || ""));
  const metaBits = [
    msg.noteType ? `<span class="pill type">${esc(msg.noteType)}</span>` : "",
    msg.category ? `<span class="pill cat">${esc(msg.category)}</span>` : "",
    ...tags.map(t => `<span class="pill tag">#${esc(t)}</span>`),
    msg.updatedAt ? `<span class="upd">Updated ${esc(String(msg.updatedAt).slice(0, 10))}</span>` : "",
  ].filter(Boolean).join("");

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="generator" content="Personal Knowledge (VS Code)">
<title>${esc(title)}</title>
<style>
:root{color-scheme:light}
*{box-sizing:border-box}
body{margin:0;background:#f6f7f9;color:#1f2328;font:16px/1.7 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Helvetica,Arial,sans-serif}
.wrap{max-width:820px;margin:32px auto;background:#fff;border:1px solid #e2e5e9;border-radius:12px;padding:40px 48px;box-shadow:0 1px 3px rgba(0,0,0,.06)}
h1.doc-title{font-size:28px;line-height:1.25;margin:0 0 12px;color:#0b1220}
.meta{display:flex;flex-wrap:wrap;gap:8px;align-items:center;margin-bottom:20px;padding-bottom:18px;border-bottom:1px solid #eceef1;font-size:12px}
.pill{padding:2px 9px;border-radius:20px;font-weight:600}
.pill.type{background:#eef2ff;color:#4f46e5}
.pill.cat{background:#ecfdf5;color:#059669}
.pill.tag{background:#f1f5f9;color:#475569}
.upd{color:#8a929c;margin-left:auto}
.prose{font-size:16px}
.prose h1,.prose h2,.prose h3,.prose h4{line-height:1.3;margin:1.5em 0 .5em;color:#0b1220;font-weight:650}
.prose h1{font-size:1.6em}.prose h2{font-size:1.35em;border-bottom:1px solid #eceef1;padding-bottom:.2em}.prose h3{font-size:1.15em}
.prose p{margin:.7em 0}
.prose a{color:#2563eb;text-decoration:none}.prose a:hover{text-decoration:underline}
.prose ul,.prose ol{padding-left:1.5em;margin:.6em 0}
.prose li{margin:.25em 0}
.prose img{max-width:100%;border-radius:6px;margin:.4em 0}
.prose li.tk{list-style:none;position:relative}
.prose li.tk>.tkm{display:inline-block;width:16px;height:16px;line-height:15px;text-align:center;border-radius:3px;font-size:11px;font-weight:700;margin:0 .5em 0 -1.5em;vertical-align:1px;box-sizing:border-box}
.prose li.tk-todo>.tkm{border:1.5px solid #9aa2ad;background:#fff}
.prose li.tk-done>.tkm{background:#2da44e;color:#fff;border:1.5px solid #2da44e}
.prose li.tk-prog>.tkm{background:#d29922;color:#3d2c00;border:1.5px solid #d29922}
.prose li.tk-block>.tkm{background:#e5484d;color:#fff;border:1.5px solid #e5484d}
.mermaid-diagram{margin:1em 0;text-align:center;overflow-x:auto}
.mermaid-diagram svg{max-width:100%;height:auto}
.mermaid-error{color:#b91c1c;font-size:.9em;text-align:left;white-space:pre-wrap;border:1px solid #f1a9a9;border-radius:6px;padding:8px}
.prose blockquote{border-left:4px solid #d0d7de;color:#57606a;margin:.9em 0;padding:.1em 1em}
.prose hr{border:none;border-top:1px solid #e2e5e9;margin:1.6em 0}
.prose table{border-collapse:collapse;width:100%;margin:1em 0;font-size:.95em}
.prose th,.prose td{border:1px solid #e2e5e9;padding:6px 10px}
.prose th{background:#f6f8fa;text-align:left}
.prose code{background:#f1f3f5;border-radius:4px;padding:.15em .4em;font-size:.88em;font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace}
.prose pre{background:#0d1117;color:#e6edf3;border-radius:8px;padding:16px;overflow:auto;margin:1em 0}
.prose pre code{background:none;padding:0;font-size:.86em;color:inherit}
.wikilink{color:#7c3aed;border-bottom:1px dashed #c4b5fd;font-weight:600}
/* highlight.js (github-dark subset) */
.hljs-comment,.hljs-quote{color:#8b949e}
.hljs-keyword,.hljs-selector-tag,.hljs-literal,.hljs-type{color:#ff7b72}
.hljs-string,.hljs-meta .hljs-string,.hljs-regexp,.hljs-addition{color:#a5d6ff}
.hljs-number,.hljs-symbol,.hljs-bullet{color:#79c0ff}
.hljs-title,.hljs-name,.hljs-section,.hljs-title.function_,.hljs-title.class_{color:#d2a8ff}
.hljs-built_in,.hljs-builtin-name,.hljs-attr,.hljs-attribute{color:#ffa657}
.hljs-variable,.hljs-template-variable,.hljs-params{color:#e6edf3}
.hljs-deletion{color:#ffa198}
.hljs-emphasis{font-style:italic}.hljs-strong{font-weight:700}
.math-block{overflow-x:auto;padding:4px 2px;margin:.6em 0}
.katex-display{margin:.5em 0}
@media print{body{background:#fff}.wrap{border:none;box-shadow:none;margin:0;max-width:none}}
${katexCss}
</style>
</head>
<body>
<div class="wrap">
<h1 class="doc-title">${esc(title)}</h1>
<div class="meta">${metaBits}</div>
<div class="prose">${body}</div>
</div>
</body>
</html>`;
}

// Cache the self-contained KaTeX CSS (fonts inlined as data URIs) for HTML export.
let _katexCssCache: string | undefined;
function katexCssForExport(context: vscode.ExtensionContext): string {
  if (_katexCssCache !== undefined) return _katexCssCache;
  try {
    const distDir = path.join(context.extensionPath, "dist", "webview");
    const srcDir  = path.join(context.extensionPath, "src",  "webview");
    const dir = fs.existsSync(path.join(distDir, "katex.css")) ? distDir : srcDir;
    const cssPath = path.join(dir, "katex.css");
    const fontsDir = path.join(dir, "fonts");
    if (!fs.existsSync(cssPath) || !fs.existsSync(fontsDir)) { _katexCssCache = ""; return ""; }
    let css = fs.readFileSync(cssPath, "utf-8");
    // Inline woff2 fonts as data URIs; drop the woff/ttf fallbacks (unused by modern browsers).
    css = css.replace(/url\(fonts\/([^)]+\.woff2)\)/g, (m, file) => {
      try {
        const b64 = fs.readFileSync(path.join(fontsDir, file)).toString("base64");
        return `url(data:font/woff2;base64,${b64})`;
      } catch { return m; }
    });
    css = css.replace(/,url\(fonts\/[^)]*\)\s*format\("[^"]*"\)/g, "");
    _katexCssCache = css;
  } catch {
    _katexCssCache = "";
  }
  return _katexCssCache;
}

// ── Panel management ───────────────────────────────────────────────────────
let panel: vscode.WebviewPanel | undefined;
let _treeProvider: PkTreeProvider | undefined;
let _panelReady = false;                       // webview has signalled it's ready
let _storeReady = false;                       // file store configured & migrated
let _pendingOpen: { type: string; key: string; edit?: boolean } | undefined; // item to open once ready

/** Open an item in the panel; queues it if the webview isn't ready yet. */
function openInPanel(context: vscode.ExtensionContext, type: string, key: string, edit = false): void {
  const p = getOrCreatePanel(context);
  p.reveal(vscode.ViewColumn.One);
  if (_panelReady) {
    p.webview.postMessage({ command: "openItem", type, key, edit });
  } else {
    _pendingOpen = { type, key, edit }; // flushed on the "ready" message
  }
}

/** Set store paths, run the one-time DB→files migration, mark ready, refresh. */
async function initStore(context: vscode.ExtensionContext, storePath: string): Promise<void> {
  fsSetStorePath(storePath);
  storageSetStorePath(storePath);
  // Hidden, idempotent migration from the legacy SQLite DB to files-as-truth
  if (!context.globalState.get<boolean>("migratedToFiles", false)) {
    try {
      const r = await migrateDbToFiles(context.extensionPath);
      if (r.migrated) log.info(`migrated ${r.skills} skills, ${r.notes} notes from DB to files`);
      await context.globalState.update("migratedToFiles", true);
    } catch (e: any) { log.warn(`migration skipped: ${e?.message}`); }
  }
  _storeReady = true;
  _treeProvider?.refresh();
}

/** Returns true if the file store is ready; otherwise runs the setup wizard. */
async function ensureSetup(context: vscode.ExtensionContext): Promise<boolean> {
  if (_storeReady) return true;

  const cfg = vscode.workspace.getConfiguration("personalKnowledge");
  const configuredPath = cfg.get<string>("storePath")?.trim() ?? "";
  const setupComplete  = context.globalState.get<boolean>("setupComplete", false);

  // Already configured — just activate the store
  if (setupComplete && configuredPath) {
    await initStore(context, configuredPath);
    return _storeReady;
  }

  // Not configured yet — show the wizard
  const chosen = await firstTimeSetup(context);
  if (!chosen) {
    vscode.window.showErrorMessage(
      "Personal Knowledge: you must complete setup before using this extension.",
      "Configure now"
    ).then(v => { if (v) ensureSetup(context); });
    return false;
  }
  await initStore(context, chosen);
  try { generateMcpServer(context); } catch { /* non-critical */ }
  return _storeReady;
}

// Resolve a note-link target to a note slug. `target` is a relative (./, ../,
// sub/x.md) or absolute .md path; `from` is the source note's slug. Returns the
// resolved slug (relative path w/o .md) or null if it escapes the notes store.
function resolveNoteSlugFromPath(target: string, from: string): string | null {
  const notesDir = path.join(getStorePath(), "notes");
  let clean: string;
  try { clean = decodeURIComponent(target.replace(/[?#].*$/, "")); }
  catch { clean = target.replace(/[?#].*$/, ""); }
  // Absolute filesystem path pointing inside the notes store.
  if (path.isAbsolute(clean)) {
    const rel = path.relative(notesDir, clean).replace(/\\/g, "/");
    if (!rel || rel === ".." || rel.startsWith("../")) return null;
    return rel.replace(/\.md$/i, "");
  }
  // Relative to the source note's folder (slug dir).
  const fromDir = from.includes("/") ? from.slice(0, from.lastIndexOf("/")) : "";
  const joined = path.posix.normalize(path.posix.join(fromDir, clean));
  if (joined === ".." || joined.startsWith("../")) return null;
  return joined.replace(/^\.\//, "").replace(/^\/+/, "").replace(/\.md$/i, "");
}

function makeWebviewOptions(context: vscode.ExtensionContext): vscode.WebviewOptions & vscode.WebviewPanelOptions {
  return {
    enableScripts: true,
    retainContextWhenHidden: true,
    localResourceRoots: [
      vscode.Uri.file(path.join(context.extensionPath, "dist", "webview")),
      vscode.Uri.file(path.join(context.extensionPath, "src",  "webview")),        // dev fallback
      vscode.Uri.file(path.join(context.extensionPath, "node_modules", "marked")), // dev marked
      vscode.Uri.file(getStorePath()),                                             // note/skill _assets
    ],
  };
}

function getWebviewHtml(webview: vscode.Webview, context: vscode.ExtensionContext): string {
  // prefer dist/webview (packaged), fall back to src/webview (dev)
  const distDir = path.join(context.extensionPath, "dist", "webview");
  const srcDir  = path.join(context.extensionPath, "src",  "webview");
  const webviewDir = fs.existsSync(path.join(distDir, "panel.html")) ? distDir : srcDir;
  let html = fs.readFileSync(path.join(webviewDir, "panel.html"), "utf-8");

  // Load marked as an external file (inlining breaks HTML parsing due to <!-- --> in marked)
  const markedFsPath = fs.existsSync(path.join(distDir, "marked.umd.js"))
    ? path.join(distDir, "marked.umd.js")
    : path.join(context.extensionPath, "node_modules", "marked", "lib", "marked.umd.js");
  const markedUri = webview.asWebviewUri(vscode.Uri.file(markedFsPath));
  html = html.replace(/%%MARKED_SRC%%/g, markedUri.toString());

  // Syntax highlighting (highlight.js bundled locally with a custom Scope grammar)
  const hljsJs  = webview.asWebviewUri(vscode.Uri.file(path.join(webviewDir, "hljs.js")));
  const hljsCss = webview.asWebviewUri(vscode.Uri.file(path.join(webviewDir, "hljs.css")));
  html = html.replace(/%%HLJS_SRC%%/g, hljsJs.toString());
  html = html.replace(/%%HLJS_CSS%%/g, hljsCss.toString());

  // Math rendering (KaTeX bundled locally: JS + CSS + fonts). Fonts are loaded
  // by katex.css via relative url(fonts/...) which resolve under webviewDir.
  const katexJs  = webview.asWebviewUri(vscode.Uri.file(path.join(webviewDir, "katex.js")));
  const katexCss = webview.asWebviewUri(vscode.Uri.file(path.join(webviewDir, "katex.css")));
  html = html.replace(/%%KATEX_SRC%%/g, katexJs.toString());
  html = html.replace(/%%KATEX_CSS%%/g, katexCss.toString());

  // Graph rendering (Cytoscape.js bundled locally) for the Papers graph view.
  const cytoscapeJs = webview.asWebviewUri(vscode.Uri.file(path.join(webviewDir, "cytoscape.js")));
  html = html.replace(/%%CYTOSCAPE_SRC%%/g, cytoscapeJs.toString());

  // Diagram rendering (Mermaid bundled locally) for ```mermaid fenced blocks.
  const mermaidJs = webview.asWebviewUri(vscode.Uri.file(path.join(webviewDir, "mermaid.js")));
  html = html.replace(/%%MERMAID_SRC%%/g, mermaidJs.toString());

  // Inject the webview CSP source — required for VS Code to allow scripts to run
  html = html.replace(/%%CSP_SOURCE%%/g, webview.cspSource);

  // Base URI for note image assets (notes/_assets/...). The webview rewrites
  // `_assets/` markdown image refs to `${NOTES_BASE}/_assets/...` at render time.
  const notesBase = webview.asWebviewUri(vscode.Uri.file(path.join(getStorePath(), "notes")));
  html = html.replace(/%%NOTES_BASE%%/g, notesBase.toString());
  return html;
}

function getOrCreatePanel(context: vscode.ExtensionContext): vscode.WebviewPanel {
  if (panel) { panel.reveal(vscode.ViewColumn.One); return panel; }

  panel = vscode.window.createWebviewPanel(
    "personalKnowledge",
    "Personal Knowledge",
    vscode.ViewColumn.One,
    makeWebviewOptions(context)
  );

  panel.iconPath = vscode.Uri.parse("data:image/svg+xml,<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 16 16'><text y='14' font-size='14'>📚</text></svg>");
  _panelReady = false; // fresh webview; wait for its "ready" signal
  const html = getWebviewHtml(panel.webview, context);
  panel.webview.html = html;
  log.info(`panel created (html ${html.length} bytes)`);

  // Debug: dump generated HTML for inspection (debug level only)
  if (LEVEL_ORDER["debug"] >= 0) {
    try {
      const dbgDir = context.globalStorageUri.fsPath;
      fs.mkdirSync(dbgDir, { recursive: true });
      fs.writeFileSync(path.join(dbgDir, "panel-generated.html"), html);
    } catch { /* ignore */ }
  }

  panel.webview.onDidReceiveMessage(
    msg => {
      log.debug(`webview → ${JSON.stringify(msg).slice(0, 200)}`);
      handleMessage(msg, m => panel?.webview.postMessage(m), context);
    },
    undefined, context.subscriptions
  );

  panel.onDidDispose(() => { panel = undefined; _panelReady = false; log.debug("panel disposed"); }, undefined, context.subscriptions);
  return panel;
}

// ── Shared message handler (panel + sidebar) ───────────────────────────────
async function handleMessage(
  msg: any,
  respond: (m: object) => void,
  context: vscode.ExtensionContext
): Promise<void> {
  try {
  // Log user-meaningful actions at info level; noisy list/detail at debug
  if (["saveNote", "saveSkill", "deleteNote", "deleteSkill", "markDone",
       "export", "import", "startSync", "joinSync", "revokeSync", "generateMcp"].includes(msg.command)) {
    log.action(`webview.${msg.command}`);
  } else {
    log.debug(`handleMessage: ${msg.command}`);
  }
  switch (msg.command) {

    case "ready": {
      // Webview finished loading — flush any queued item to open
      _panelReady = true;
      if (_pendingOpen) {
        const { type, key, edit } = _pendingOpen;
        _pendingOpen = undefined;
        respond({ command: "openItem", type, key, edit });
      }
      break;
    }

    case "reload": {
      // Files are the source of truth and always read fresh, so this just
      // re-renders the tree + current tab (external edits are already on disk).
      _treeProvider?.refresh();
      log.action("reload");
      respond({ command: "reloaded" });
      break;
    }

    case "list": {
      const { tab, filter, q } = msg;
      let data: unknown;
      if (tab === "skills")    data = q ? skillSearch(q) : skillList(filter === "all" ? undefined : filter);
      else if (tab === "notes")   data = q ? noteSearch(q) : noteList(undefined, 500); // client-side filtering
      else if (tab === "papers")  data = q ? paperSearch(q) : paperList();
      else if (tab === "prompts")  data = promptList();
      else if (tab === "packages") data = packageList();
      else if (tab === "scripts")  data = scriptList();
      else data = [];
      respond({ command: "list", data });
      break;
    }

    case "detail": {
      const { type, key } = msg;
      let data: unknown = null;
      if (type === "skill") {
        const r = skillGet(key);
        if (r) data = { type: "skill", ...r };
      } else if (type === "note") {
        const r = noteGet(key);
        if (r) data = { ...r, note_type: r.type, type: "note" };
      } else if (type === "paper") {
        const r = paperGet(key);
        if (r) data = { type: "paper", ...r };
      } else if (type === "prompt") {
        const [proj, task, ver, fname] = key.split("|");
        const r = promptGetFile(proj, task, ver, fname);
        if (r) {
          const allVers = promptGetAllVersionsOfFile(proj, task, fname);
          data = { type: "prompt", ...r, allVersions: allVers };
        }
      } else if (type === "promptDiff") {
        const [proj, task, fname] = key.split("|");
        const allVers = promptGetAllVersionsOfFile(proj, task, fname);
        data = { type: "promptDiff", project: proj, task, file: fname, allVersions: allVers };
      } else if (type === "package") {
        const r = packageGet(key);
        if (r) data = { type: "package", ...r };
      } else if (type === "packageFile") {
        const [pkg, ...rest] = key.split("|");
        const r = packageFileGet(pkg, rest.join("|"));
        if (r) data = { type: "script", ...r };
      } else if (type === "script") {
        // key is the full relative path (e.g. "AdCoherence/Analysis/foo.script")
        const r = scriptGet(key);
        if (r) data = { type: "script", ...r };
      }
      respond({ command: "detail", data });
      break;
    }

    case "saveNote": {
      const { title, content, type, tags, category, slug: existingSlug } = msg;
      const slug = existingSlug ?? uniqueSlug(title || content.slice(0, 60));
      noteUpsert({ slug, title: title || slug, content, type, tags, category });
      gitCommit(existingSlug ? `update(note): ${slug}` : `add(note): ${slug}`);
      respond({ command: "saved" });
      vscode.window.setStatusBarMessage("$(check) Note saved", 3000);
      break;
    }

    case "saveAsset": {
      // Pasted image from the note editor: persist to notes/<category>/_assets/<hash>.<ext>
      const { data, ext, reqId, category } = msg;
      try {
        const rel = saveNoteAsset(String(data || ""), String(ext || "png"), String(category || ""));
        respond({ command: "assetSaved", reqId, markdown: `![](${rel})` });
      } catch (e) {
        log.error(`saveAsset failed: ${String(e)}`);
        respond({ command: "assetSaved", reqId, error: String(e) });
      }
      break;
    }

    case "resolveNoteLink": {
      // Cross-note link: target may be a [[title]], a slug, or a relative /
      // absolute .md path. `from` is the source note's slug (for relative refs).
      const target = String(msg.target || "").trim();
      const from = String(msg.from || "").trim();
      const isWiki = !!msg.wiki;
      let r: any = null;

      // 1. Path-style links: resolve relative (./, ../, sub/x.md) against the
      //    source note's folder, or an absolute path that lives under notes/.
      if (!isWiki && target && (/\.md(\?|#|$)/i.test(target) || target.includes("/"))) {
        const slug = resolveNoteSlugFromPath(target, from);
        if (slug) r = noteGet(slug);
      }
      // 2. Direct slug (or a path relative to the notes root).
      if (!r && target) r = noteGet(target.replace(/\.md$/i, ""));
      // 3. Title / slug / basename fallback (covers [[Title]] wiki links).
      if (!r && target) {
        const needle = target.replace(/\.md$/i, "").toLowerCase();
        const base = needle.split("/").pop() || needle;
        const hit = (noteList(undefined, 10000) as any[]).find(
          n => (n.title || "").toLowerCase() === needle ||
               (n.slug || "").toLowerCase() === needle ||
               (n.slug || "").toLowerCase().endsWith("/" + base) ||
               (n.title || "").toLowerCase() === base,
        );
        if (hit) r = noteGet(hit.slug);
      }
      if (r) respond({ command: "detail", data: { ...r, note_type: r.type, type: "note" } });
      else respond({ command: "noteLinkMissing", target });
      break;
    }

    case "exportNoteHtml": {
      // Build a self-contained HTML document from the webview-rendered body and
      // either open it in the default browser or save it to a file.
      try {
        const doc = buildStandaloneNoteHtml(msg, katexCssForExport(context));
        const safe = safeFilePart(String(msg.title || msg.slug || "note")) || "note";
        if (msg.mode === "browser") {
          const opened = await openHtmlInBrowser(doc);
          if (opened) {
            vscode.window.setStatusBarMessage("$(globe) Note opened in browser", 4000);
          } else {
            // Couldn't open a browser (e.g. fully headless host) — offer to save instead.
            const out = path.join(os.tmpdir(), `pk-note-${safe}-${Date.now()}.html`);
            fs.writeFileSync(out, doc, "utf-8");
            const pick = await vscode.window.showInformationMessage(
              `Couldn't open a browser. Preview written to ${out}`, "Copy Path");
            if (pick === "Copy Path") await vscode.env.clipboard.writeText(out);
          }
        } else {
          const target = await vscode.window.showSaveDialog({
            saveLabel: "Export note as HTML",
            defaultUri: vscode.Uri.file(path.join(os.homedir(), `${safe}.html`)),
            filters: { HTML: ["html"] },
          });
          if (target) {
            fs.writeFileSync(target.fsPath, doc, "utf-8");
            const pick = await vscode.window.showInformationMessage(
              `Note exported to ${path.basename(target.fsPath)}`, "Open");
            if (pick === "Open") await vscode.env.openExternal(target);
          }
        }
      } catch (e) {
        log.error(`exportNoteHtml failed: ${String(e)}`);
        vscode.window.showErrorMessage(`Export failed: ${String(e)}`);
      }
      break;
    }

    case "collectLinkedNotes": {
      // Compute the transitive link closure of a note and send it back to the
      // webview to render (the markdown pipeline lives there).
      const rootSlug = String(msg.slug || "").trim();
      const notes = collectLinkedNotes(rootSlug);
      const entry = notes.find(n => n.slug === rootSlug) || notes[0];
      respond({ command: "linkedNotes", entryFilename: entry ? entry.filename : "", notes });
      break;
    }

    case "writeLinkedExport": {
      // Write each webview-rendered note into a temp folder and open the entry
      // file in the browser; cross-note links resolve to the sibling .html files.
      try {
        const files: any[] = Array.isArray(msg.files) ? msg.files : [];
        if (!files.length) { vscode.window.setStatusBarMessage("$(info) Nothing to export", 3000); break; }
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pk-notes-"));
        for (const f of files) {
          const note = noteGet(String(f.slug || "")) || {};
          const doc = buildStandaloneNoteHtml({
            title: note.title || f.slug, slug: f.slug, category: note.category || "",
            tags: note.tags || "[]", noteType: note.type || "general",
            updatedAt: note.updated_at || "", bodyHtml: f.bodyHtml || "",
          }, katexCssForExport(context));
          fs.writeFileSync(path.join(dir, String(f.filename)), doc, "utf-8");
        }
        const entry = String(msg.entryFilename || files[0].filename);
        const opened = await serveFolderInBrowser(dir, entry);
        if (opened) {
          vscode.window.setStatusBarMessage(`$(globe) Opened ${files.length} linked note${files.length > 1 ? "s" : ""} in browser`, 5000);
        } else {
          const pick = await vscode.window.showInformationMessage(
            `Couldn't open a browser. Notes written to ${dir}`, "Copy Path");
          if (pick === "Copy Path") await vscode.env.clipboard.writeText(dir);
        }
      } catch (e) {
        log.error(`writeLinkedExport failed: ${String(e)}`);
        vscode.window.showErrorMessage(`Linked export failed: ${String(e)}`);
      }
      break;
    }

    case "toast": {
      vscode.window.setStatusBarMessage(`$(info) ${String(msg.text || "")}`, 4000);
      break;
    }

    case "saveSkill": {
      const { name, content, category, description, tags } = msg;
      skillUpsert({ name, content, category, description, tags });
      gitCommit(`save(skill): ${name}`);
      respond({ command: "saved" });
      vscode.window.setStatusBarMessage("$(check) Skill saved", 3000);
      break;
    }

    case "skillRenameFolder": {
      const n = skillMoveCategory(String(msg.oldPrefix || ""), String(msg.newPrefix || ""));
      if (n) gitCommit(`rename(skill-folder): ${msg.oldPrefix} -> ${msg.newPrefix} (${n})`);
      _treeProvider?.refresh();
      respond({ command: "saved" });
      vscode.window.setStatusBarMessage(`$(check) Renamed folder (${n} skill${n === 1 ? "" : "s"})`, 3000);
      break;
    }

    case "skillMove": {
      if (skillMove(String(msg.name || ""), String(msg.category || ""))) {
        gitCommit(`move(skill): ${msg.name} -> ${msg.category || "(root)"}`);
        _treeProvider?.refresh();
      }
      respond({ command: "saved" });
      vscode.window.setStatusBarMessage("$(check) Skill moved", 3000);
      break;
    }

    case "noteMove": {
      if (noteMove(String(msg.slug || ""), String(msg.category || ""))) {
        gitCommit(`move(note): ${msg.slug} -> ${msg.category || "(root)"}`);
        _treeProvider?.refresh();
      }
      respond({ command: "saved" });
      vscode.window.setStatusBarMessage("$(check) Note moved", 3000);
      break;
    }

    case "noteMoveFolder": {
      const n = noteMoveFolder(String(msg.oldPrefix || ""), String(msg.newPrefix || ""));
      if (n) gitCommit(`move(note-folder): ${msg.oldPrefix} -> ${msg.newPrefix} (${n})`);
      _treeProvider?.refresh();
      respond({ command: "saved" });
      vscode.window.setStatusBarMessage(`$(check) Moved folder (${n} note${n === 1 ? "" : "s"})`, 3000);
      break;
    }

    case "noteSetPinned": {
      if (noteSetPinned(String(msg.slug || ""), !!msg.pinned)) {
        gitCommit(`${msg.pinned ? "pin" : "unpin"}(note): ${msg.slug}`);
        _treeProvider?.refresh();
      }
      respond({ command: "saved" });
      break;
    }

    case "noteFolderPins": {
      respond({ command: "noteFolderPins", data: noteFolderPins() });
      break;
    }

    case "noteSetFolderPinned": {
      if (noteSetFolderPinned(String(msg.prefix || ""), !!msg.pinned)) {
        gitCommit(`${msg.pinned ? "pin" : "unpin"}(note-folder): ${msg.prefix}`);
        _treeProvider?.refresh();
      }
      respond({ command: "noteFolderPins", data: noteFolderPins() });
      break;
    }

    case "savePaper": {
      const p = msg.paper || {};
      const slug = p.slug || uniquePaperSlug(p.title || "paper", p.category || "");
      paperUpsert({
        slug, title: p.title || slug, content: p.content ?? "",
        authors: p.authors ?? [], year: p.year ?? null, topic: p.topic ?? "",
        publisher: p.publisher ?? "", tags: p.tags ?? [], url: p.url ?? "",
        file: p.file ?? "", conclusions: p.conclusions ?? [], cites: p.cites ?? [],
        category: p.category ?? "", kind: p.kind ?? "paper", group: p.group ?? "Papers", pinned: !!p.pinned,
      });
      gitCommit(p.slug ? `update(paper): ${slug}` : `add(paper): ${slug}`);
      respond({ command: "saved" });
      vscode.window.setStatusBarMessage("$(check) Paper saved", 3000);
      break;
    }

    case "paperGroups": {
      respond({ command: "paperGroups", data: paperGroups() });
      break;
    }

    case "paperSetGroup": {
      if (paperSetGroup(String(msg.slug || ""), String(msg.group || "Papers"))) {
        gitCommit(`group(paper): ${msg.slug} -> ${msg.group}`);
      }
      respond({ command: "saved" });
      break;
    }

    case "paperSetGroupMany": {
      const slugs: string[] = Array.isArray(msg.slugs) ? msg.slugs : [];
      const group = String(msg.group || "Papers");
      let n = 0;
      for (const s of slugs) if (paperSetGroup(String(s), group)) n++;
      if (n) gitCommit(`group(paper x${n}): -> ${group}`);
      respond({ command: "saved" });
      vscode.window.setStatusBarMessage(`$(check) Moved ${n} to “${group}”`, 3000);
      break;
    }

    case "paperSetPinned": {
      if (paperSetPinned(String(msg.slug || ""), !!msg.pinned)) {
        gitCommit(`${msg.pinned ? "pin" : "unpin"}(paper): ${msg.slug}`);
      }
      respond({ command: "saved" });
      break;
    }

    case "paperSetTopic": {
      if (paperSetTopic(String(msg.slug || ""), String(msg.topic || ""))) {
        gitCommit(`topic(paper): ${msg.slug} -> ${msg.topic || "(none)"}`);
      }
      respond({ command: "saved" });
      vscode.window.setStatusBarMessage("$(check) Topic updated", 3000);
      break;
    }

    case "scriptMove": {
      if (scriptMove(String(msg.relPath || ""), String(msg.category || ""))) {
        gitCommit(`move(script): ${msg.relPath} -> ${msg.category || "(root)"}`);
        _treeProvider?.refresh();
      }
      respond({ command: "saved" });
      vscode.window.setStatusBarMessage("$(check) Script moved", 3000);
      break;
    }

    case "scriptMoveFolder": {
      const n = scriptMoveFolder(String(msg.oldPrefix || ""), String(msg.newPrefix || ""));
      if (n) gitCommit(`move(script-folder): ${msg.oldPrefix} -> ${msg.newPrefix} (${n})`);
      _treeProvider?.refresh();
      respond({ command: "saved" });
      vscode.window.setStatusBarMessage(`$(check) Moved folder (${n} script${n === 1 ? "" : "s"})`, 3000);
      break;
    }

    case "paperGroupRename": {
      const n = paperGroupRename(String(msg.oldName || ""), String(msg.newName || ""));
      if (n) gitCommit(`group(rename): ${msg.oldName} -> ${msg.newName} (${n})`);
      respond({ command: "saved" });
      vscode.window.setStatusBarMessage(`$(check) Renamed group (${n} item${n === 1 ? "" : "s"})`, 3000);
      break;
    }

    case "paperGroupDelete": {
      const n = paperGroupDelete(String(msg.name || ""));
      if (n) gitCommit(`group(delete): ${msg.name} -> Papers (${n})`);
      respond({ command: "saved" });
      vscode.window.setStatusBarMessage(`$(check) Deleted group (${n} item${n === 1 ? "" : "s"} moved to Papers)`, 3000);
      break;
    }

    case "deletePaper": {
      const { slug } = msg;
      if (paperDelete(slug)) gitCommit(`delete(paper): ${slug}`);
      respond({ command: "saved" });
      respond({ command: "detail", data: null });
      vscode.window.setStatusBarMessage("$(trash) Paper deleted", 3000);
      break;
    }

    case "paperFacets": {
      respond({ command: "paperFacets", data: paperFacets() });
      break;
    }

    case "paperGraph": {
      respond({ command: "paperGraph", data: paperGraph(msg.opts || {}) });
      break;
    }

    case "savePaperFile": {
      // Uploaded local paper file (e.g. a PDF) -> papers/<category>/_assets/<hash>.<ext>
      const { data, ext, category, reqId } = msg;
      try {
        const rel = savePaperFile(String(data || ""), String(ext || "pdf"), String(category || ""));
        respond({ command: "paperFileSaved", reqId, file: rel });
      } catch (e) {
        log.error(`savePaperFile failed: ${String(e)}`);
        respond({ command: "paperFileSaved", reqId, error: String(e) });
      }
      break;
    }

    case "openPaperLink": {
      // Open a paper's remote URL or its local file in the OS default app.
      const url = String(msg.url || "").trim();
      const file = String(msg.file || "").trim();
      const category = String(msg.category || "").trim();
      try {
        if (url) {
          await vscode.env.openExternal(vscode.Uri.parse(url));
        } else if (file) {
          const segs = category.split("/").map(s => s.trim()).filter(Boolean);
          const full = path.join(getStorePath(), "papers", ...segs, file);
          await vscode.env.openExternal(vscode.Uri.file(full));
        }
      } catch (e) {
        vscode.window.showErrorMessage(`Couldn't open paper: ${String(e)}`);
      }
      break;
    }

    case "export": {
      const rows = skillList() as any[];
      const bundle = {
        from: process.env.USER ?? "user",
        created_at: new Date().toISOString(),
        skills: rows.map(r => ({
          name: r.name, content: skillGet(r.name)?.content ?? "",
          metadata: { description: r.description, category: r.category,
                      tags: JSON.parse(r.tags ?? "[]"), source_project: r.source_project }
        }))
      };
      respond({ command: "exported", data: bundle });
      break;
    }

    case "startSync": {
      const { selected, contentTypes, expiresMinutes, port } = msg;
      const sel = selected ?? { skills: [], notes: [], prompts: [], scripts: [], packages: [] };
      try {
        await syncServer.ensureStarted(port ?? 19877);
        const session = syncServer.createSession(sel, contentTypes ?? ["skills"], expiresMinutes ?? 30);
        respond({ command: "syncStarted", data: {
          id: session.id, url: session.url, username: session.username,
          password: session.password, expires: session.expires.toISOString(),
          contentTypes: session.contentTypes, selected: session.selected,
        }});
      } catch (e: any) {
        respond({ command: "syncError", data: { error: e.message } });
      }
      break;
    }

    case "getSyncSessions": {
      const sessions = syncServer.allSessions().map(s => ({
        id: s.id, url: s.url, username: s.username, password: s.password,
        expires: s.expires.toISOString(), enabled: s.enabled,
        skillCount: s.selected.skills.length || "all",
        created: s.created.toISOString(),
      }));
      respond({ command: "syncSessions", data: { sessions } });
      break;
    }

    case "revokeSync": {
      syncServer.revokeSession(msg.id);
      const sessions = syncServer.allSessions().map(s => ({
        id: s.id, url: s.url, username: s.username, password: s.password,
        expires: s.expires.toISOString(), enabled: s.enabled,
        skillCount: s.selected.skills.length || "all",
        created: s.created.toISOString(),
      }));
      respond({ command: "syncSessions", data: { sessions } });
      vscode.window.setStatusBarMessage("$(circle-slash) Sync link revoked", 3000);
      break;
    }

    case "joinSync": {
      const { syncUrl, username, password } = msg;
      try {
        const response = await fetch(`${syncUrl}/sync/bundle`, {
          headers: { "Authorization": "Basic " + Buffer.from(`${username}:${password}`).toString("base64") },
          signal: AbortSignal.timeout(15_000),
        });
        if (!response.ok) {
          respond({ command: "syncError", data: { error: `Server returned ${response.status}: ${await response.text()}` } });
          return;
        }
        const bundle = await response.json() as any;
        const counts: Record<string, number> = {};
        for (const s of bundle?.skills ?? []) {
          const m = s.metadata ?? {};
          skillUpsert({ name: s.name, content: s.content,
            description: m.description, category: m.category,
            tags: m.tags, source_project: m.source_project });
          counts.skills = (counts.skills ?? 0) + 1;
        }
        if (bundle?.notes?.length)    counts.notes    = noteImport(bundle.notes);
        for (const p of bundle?.papers ?? []) {
          paperUpsert({
            slug: p.slug, title: p.title, content: p.content ?? "",
            authors: p.authors, year: p.year, topic: p.topic, publisher: p.publisher,
            tags: p.tags, url: p.url, file: p.file, conclusions: p.conclusions,
            cites: p.cites, category: p.category,
          });
          counts.papers = (counts.papers ?? 0) + 1;
        }
        if (bundle?.prompts?.length)  counts.prompts  = promptImport(bundle.prompts);
        if (bundle?.scripts?.length)  counts.scripts  = scriptImport(bundle.scripts);
        if (bundle?.packages?.length) counts.packages = packageImport(bundle.packages);
        const total   = Object.values(counts).reduce((a, b) => a + b, 0);
        const summary = Object.entries(counts).map(([k, v]) => `${v} ${k}`).join(", ");
        gitCommit(`sync: ${summary} from ${bundle?.from ?? "remote"}`);
        respond({ command: "syncJoined", data: { count: total, summary, from: bundle?.from ?? "remote" } });
        respond({ command: "saved" });
        vscode.window.setStatusBarMessage(`$(cloud-download) Synced: ${summary}`, 5000);
      } catch (e: any) {
        respond({ command: "syncError", data: { error: e.message } });
      }
      break;
    }

    case "getSyncSkillList": {
      const rows = skillList() as any[];
      respond({ command: "syncSkillList", data: { skills: rows.map((r: any) => ({ name: r.name, category: r.category })) } });
      break;
    }

    case "getSyncContentList": {
      const skills   = (skillList() as any[]).map((r: any) => ({ id: r.name,  label: r.name,  meta: r.category ?? "" }));
      const notes    = (noteList(undefined, 200) as any[]).map((r: any) => ({ id: r.slug,  label: r.title, meta: r.type }));
      const papers   = (paperList() as any[]).map((p: any) => ({ id: p.slug, label: p.title, meta: p.topic || (p.year ? String(p.year) : "") }));
      const prompts  = promptList().flatMap(t => ({ id: `${t.project}/${t.task}`, label: t.task, meta: t.project }));
      const scripts  = (scriptList() as any[]).map((s: any) => ({ id: s.path, label: s.file, meta: s.category }));
      const packages = packageList().map((p: any) => ({ id: p.name, label: p.name, meta: p.lang }));
      respond({ command: "syncContentList", data: { skills, notes, papers, prompts, scripts, packages } });
      break;
    }

    case "deleteNote": {
      const { slug } = msg;
      if (noteDelete(slug)) { gitCommit(`delete(note): ${slug}`); }
      vscode.window.setStatusBarMessage("$(trash) Note deleted", 3000);
      respond({ command: "saved" });
      respond({ command: "detail", data: null });
      break;
    }

    case "deleteSkill": {
      const { name } = msg;
      if (skillDelete(name)) { gitCommit(`delete(skill): ${name}`); }
      vscode.window.setStatusBarMessage("$(trash) Skill deleted", 3000);
      respond({ command: "saved" });
      respond({ command: "detail", data: null });
      break;
    }

    case "markDone": {
      const { slug } = msg;
      const row = noteGet(slug);
      if (row) {
        const newContent = row.content + `\n\n---\n✓ Done (${new Date().toISOString().slice(0, 10)})`;
        const tags = JSON.parse(row.tags ?? "[]");
        noteUpsert({ slug: row.slug, title: row.title, content: newContent, type: "done", tags, category: row.category });
        gitCommit(`done(note): ${slug}`);
        vscode.window.setStatusBarMessage("$(check) Marked as done", 3000);
      }
      respond({ command: "saved" });
      break;
    }

    case "import": {
      const { bundle } = msg;
      let count = 0;
      for (const s of bundle?.skills ?? []) {
        const m = s.metadata ?? {};
        skillUpsert({ name: s.name, content: s.content,
          description: m.description, category: m.category,
          tags: m.tags, source_project: m.source_project });
        count++;
      }
      gitCommit(`import(skills): ${count} from ${bundle?.from ?? "unknown"}`);
      respond({ command: "saved" });
      vscode.window.setStatusBarMessage(`$(check) Imported ${count} skill(s)`, 4000);
      break;
    }

    // ── MCP ──────────────────────────────────────────────────────────────
    case "checkMcp": {
      const info = mcpStatus();
      respond({ command: "mcpStatus", data: info });
      break;
    }

    case "generateMcp": {
      try {
        const preview = !!msg.previewOnly;
        const info = generateMcpServer(context);
        respond({ command: "mcpGenerated", data: { ...info, preview } });
        if (!preview) vscode.window.setStatusBarMessage("$(check) MCP server created", 4000);
      } catch (e: any) {
        respond({ command: "mcpError", data: { error: e.message } });
      }
      break;
    }

    case "aiSummary": {
      try {
        const result = await aiSummarizeScript(context, msg.path, msg.backend, !!msg.cacheOnly);
        respond({ command: "aiSummary", data: result });
      } catch (e: any) {
        respond({ command: "aiSummary", data: { error: e.message } });
      }
      break;
    }

    case "listAiBackends": {
      try {
        const backends = await listAiBackends(context);
        respond({ command: "aiBackends", data: { backends } });
      } catch (e: any) {
        respond({ command: "aiBackends", data: { backends: [], error: e.message } });
      }
      break;
    }

    case "saveScript": {
      const { path: relPath, content } = msg;
      const full = path.join(getStorePath(), "scripts", relPath);
      // Guard against path traversal outside the scripts folder
      const scriptsRoot = path.join(getStorePath(), "scripts");
      if (!path.resolve(full).startsWith(path.resolve(scriptsRoot) + path.sep)) {
        respond({ command: "scriptSaved", data: { error: "Invalid script path." } });
        break;
      }
      if (!fs.existsSync(full)) {
        respond({ command: "scriptSaved", data: { error: `Script not found: ${relPath}` } });
        break;
      }
      const confirm = await vscode.window.showWarningMessage(
        `Save changes to "${relPath}"? This overwrites the file and commits it to git.`,
        { modal: true },
        "Save & Commit"
      );
      if (confirm !== "Save & Commit") {
        respond({ command: "scriptSaved", data: { cancelled: true } });
        break;
      }
      try {
        fs.writeFileSync(full, content);
        // Content changed → all cached AI summaries for this script are stale
        fs.rmSync(scriptCacheDir(relPath), { recursive: true, force: true });
        gitCommit(`edit(script): ${relPath}`);
        log.action("script.save", { path: relPath });
        vscode.window.setStatusBarMessage("$(check) Script saved & committed", 3000);
        respond({ command: "scriptSaved", data: { ok: true, path: relPath } });
      } catch (e: any) {
        respond({ command: "scriptSaved", data: { error: e.message } });
      }
      break;
    }
  }
  } catch (e: any) {
    // Ensure the webview never hangs on a loading banner due to an unhandled error
    log.error(`handleMessage(${msg.command}) failed: ${e?.stack ?? e?.message ?? e}`);
    if (msg.command === "list") {
      respond({ command: "list", data: [] });
    }
  }
}

// ── MCP server scaffold ────────────────────────────────────────────────────
function mcpStatus(): { installed: boolean; serverPath: string } {
  const serverPath = path.join(getStorePath(), "mcp-server", "server.py");
  return { installed: fs.existsSync(serverPath), serverPath };
}

function generateMcpServer(context: vscode.ExtensionContext): { serverPath: string; configSnippet: string } {
  const storePath = getStorePath();
  const rawName    = path.basename(storePath);
  // Sanitize for use as MCP server ID / config key (no spaces or special chars)
  const serverName = rawName.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") || "personal-knowledge";
  const displayName = rawName; // human-readable (can have spaces)
  const mcpDir    = path.join(storePath, "mcp-server");
  const serverPy  = path.join(mcpDir, "server.py");
  const reqTxt    = path.join(mcpDir, "requirements.txt");
  const storeFwd  = storePath.replace(/\\/g, "/");

  fs.mkdirSync(mcpDir, { recursive: true });

  fs.writeFileSync(serverPy, `#!/usr/bin/env python3
"""
${displayName} MCP Server — auto-generated by Personal Knowledge extension.
Exposes your skills and notes to AI assistants via the Model Context Protocol.

Skills and notes are stored as plain markdown files under skills/ and notes/ —
the files are the single source of truth (there is no database). Writes made by
this server appear immediately in the VS Code panel via its file watcher, and
show up in git history as readable .md diffs.

Read tools:  list_skills, search_skills, get_skill, list_notes, search_notes, get_note,
             list_papers, search_papers, get_paper, paper_graph
Write tools: add_note, update_note, delete_note, add_skill, update_skill, delete_skill,
             add_paper, update_paper, delete_paper

Search builds an in-memory FTS5 'trigram' index (CJK-friendly, ranked) at call
time, falling back to substring matching when FTS5 is unavailable.

Install:  pip install fastmcp
Run:      python server.py
"""
import json, re, sqlite3, datetime
from pathlib import Path
from typing import Optional, List

try:
    from fastmcp import FastMCP
except ImportError:
    raise SystemExit("fastmcp not found. Run: pip install fastmcp")

STORE  = Path(r"${storeFwd}")
NOTES  = STORE / "notes"
SKILLS = STORE / "skills"
mcp = FastMCP("${displayName}")


def _now() -> str:
    return datetime.datetime.utcnow().isoformat()


# ── Frontmatter (matches the extension's minimal YAML subset) ────────────────
def _parse(text):
    m = re.match(r"^---\\r?\\n(.*?)\\r?\\n---\\r?\\n?", text, re.S)
    if not m:
        return {}, text
    fm = {}
    for line in m.group(1).splitlines():
        i = line.find(":")
        if i < 0:
            continue
        k = line[:i].strip()
        raw = line[i + 1:].strip()
        if not k:
            continue
        try:
            fm[k] = json.loads(raw)
        except Exception:
            fm[k] = raw.strip("\\"'")
    return fm, text[m.end():]


def _serialize(fm, body):
    lines = ["---"]
    for k, v in fm.items():
        if v is None:
            continue
        if isinstance(v, bool):
            lines.append(f"{k}: {'true' if v else 'false'}")
        elif isinstance(v, (list, str)):
            lines.append(f"{k}: {json.dumps(v, ensure_ascii=False)}")
        else:
            lines.append(f"{k}: {v}")
    lines += ["---", ""]
    return "\\n".join(lines) + (body or "")


# ── Paths / identity (identity = relative path w/o .md; category = folders) ──
def _safe_name(s):
    s = re.sub(r'[/\\\\:*?"<>|]', "", s or "")
    s = "".join(ch for ch in s if ord(ch) >= 32).strip()
    return s or "untitled"


def _safe_cat(cat):
    if not cat or not cat.strip():
        return ""
    return "/".join(_safe_name(p.strip()) for p in cat.split("/") if p.strip())


def _cat_of(key):
    return key.rsplit("/", 1)[0] if "/" in key else ""


def _name_of(key):
    return key.rsplit("/", 1)[-1]


def _walk(root):
    out = []
    if not root.exists():
        return out
    for p in root.rglob("*.md"):
        rel = p.relative_to(root)
        if any(part.startswith(".") or part == "_assets" for part in rel.parts):
            continue
        out.append((p, rel.as_posix()[:-3]))
    return out


def _mtime(p):
    return datetime.datetime.utcfromtimestamp(p.stat().st_mtime).isoformat()


# ── Notes ────────────────────────────────────────────────────────────────────
def _note(p, key):
    fm, body = _parse(p.read_text(encoding="utf-8"))
    return {"slug": key, "title": fm.get("title") or _name_of(key),
            "type": fm.get("type") or "general", "tags": fm.get("tags") or [],
            "category": _cat_of(key), "content": body, "updated_at": _mtime(p)}


def _all_notes():
    return [_note(p, k) for p, k in _walk(NOTES)]


def _note_get(slug):
    p = NOTES / (slug + ".md")
    return _note(p, slug) if p.exists() else None


def _note_write(slug, title, content, type_, tags, category, created=None):
    cat = _safe_cat(category or "")
    fname = _safe_name(title or _name_of(slug)) + ".md"
    rel = (cat + "/" + fname) if cat else fname
    full = NOTES / rel
    old = NOTES / (slug + ".md")
    if old.exists() and rel[:-3] != slug:
        try: old.unlink()
        except Exception: pass
    full.parent.mkdir(parents=True, exist_ok=True)
    fm = {"title": title, "type": type_ or "general", "tags": tags or [],
          "created": created or _now()}
    full.write_text(_serialize(fm, content or ""), encoding="utf-8")
    return rel[:-3]


# ── Skills ───────────────────────────────────────────────────────────────────
def _skill(p, key):
    fm, body = _parse(p.read_text(encoding="utf-8"))
    return {"name": fm.get("name") or _name_of(key), "description": fm.get("description") or "",
            "category": _cat_of(key), "tags": fm.get("tags") or [],
            "source_project": fm.get("source_project"), "content": body, "updated_at": _mtime(p)}


def _all_skills():
    return [_skill(p, k) for p, k in _walk(SKILLS)]


def _find_skill(name):
    for p, k in _walk(SKILLS):
        fm, _ = _parse(p.read_text(encoding="utf-8"))
        if (fm.get("name") or _name_of(k)) == name:
            return p, k
    return None, None


def _skill_get(name):
    p, k = _find_skill(name)
    return _skill(p, k) if p else None


def _skill_write(name, content, description, category, tags, source_project=None, created=None):
    cat = _safe_cat(category or "")
    fname = _safe_name(name) + ".md"
    rel = (cat + "/" + fname) if cat else fname
    full = SKILLS / rel
    oldp, _ = _find_skill(name)
    if oldp is not None and str(oldp) != str(full):
        try: oldp.unlink()
        except Exception: pass
    full.parent.mkdir(parents=True, exist_ok=True)
    fm = {"name": name, "description": description or "", "tags": tags or [],
          "source_project": source_project, "created": created or _now()}
    full.write_text(_serialize(fm, content or ""), encoding="utf-8")
    return name


# ── Papers ───────────────────────────────────────────────────────────────────
PAPERS = STORE / "papers"

def _arr(x):
    return x if isinstance(x, list) else ([x] if x else [])

def _year(v):
    if isinstance(v, int): return v
    try: return int(str(v))
    except Exception: return None

def _norm_cites(v):
    out = []
    if isinstance(v, list):
        for e in v:
            if isinstance(e, str):
                if e.strip(): out.append({"paper": e.strip(), "note": ""})
            elif isinstance(e, dict):
                p = str(e.get("paper") or e.get("key") or "").strip()
                if p: out.append({"paper": p, "note": str(e.get("note") or e.get("comment") or "")})
    return out

def _paper(p, key):
    fm, body = _parse(p.read_text(encoding="utf-8"))
    return {"slug": key, "title": fm.get("title") or _name_of(key),
            "kind": "idea" if fm.get("kind") == "idea" else "paper",
            "group": (str(fm.get("group")).strip() if fm.get("group") else "") or "Papers",
            "pinned": fm.get("pinned") is True,
            "authors": _arr(fm.get("authors")), "year": _year(fm.get("year")),
            "topic": fm.get("topic") or "", "publisher": fm.get("publisher") or "",
            "tags": _arr(fm.get("tags")), "url": fm.get("url") or "", "file": fm.get("file") or "",
            "conclusions": _arr(fm.get("conclusions")), "cites": _norm_cites(fm.get("cites")),
            "category": _cat_of(key), "content": body, "updated_at": _mtime(p)}

def _all_papers():
    return [_paper(p, k) for p, k in _walk(PAPERS)]

def _paper_get(slug):
    p = PAPERS / (slug + ".md")
    return _paper(p, slug) if p.exists() else None

def _paper_resolver(all_p):
    by_key = {p["slug"].lower(): p["slug"] for p in all_p}
    by_title = {p["title"].lower(): p["slug"] for p in all_p}
    def r(ref):
        k = str(ref or "").lower()
        if k.endswith(".md"): k = k[:-3]
        return by_key.get(k) or by_title.get(k)
    return r

def _citation_counts(all_p):
    resolve = _paper_resolver(all_p)
    counts = {}
    for p in all_p:
        for c in p["cites"]:
            t = resolve(c["paper"])
            if t: counts[t] = counts.get(t, 0) + 1
    return counts

def _paper_write(slug, title, content, authors, year, topic, publisher, tags, url, file, conclusions, cites, category, created=None, kind=None, group=None, pinned=None):
    cat = _safe_cat(category or "")
    fname = _safe_name(title or _name_of(slug)) + ".md"
    rel = (cat + "/" + fname) if cat else fname
    full = PAPERS / rel
    old = PAPERS / (slug + ".md")
    # Preserve user-set kind/group/pinned when the caller doesn't specify them.
    if (kind is None or group is None or pinned is None) and old.exists():
        prev, _ = _parse(old.read_text(encoding="utf-8"))
        if kind is None: kind = prev.get("kind")
        if group is None: group = prev.get("group")
        if pinned is None: pinned = prev.get("pinned")
    if old.exists() and rel[:-3] != slug:
        try: old.unlink()
        except Exception: pass
    full.parent.mkdir(parents=True, exist_ok=True)
    fm = {"title": title,
          "kind": "idea" if kind == "idea" else None,
          "group": (str(group).strip() if group and str(group).strip() != "Papers" else None),
          "pinned": True if pinned is True else None,
          "authors": authors or [], "year": _year(year), "topic": topic or "",
          "publisher": publisher or "", "tags": tags or [], "url": url or "", "file": file or "",
          "conclusions": conclusions or [], "cites": _norm_cites(cites or []), "created": created or _now()}
    full.write_text(_serialize(fm, content or ""), encoding="utf-8")
    return rel[:-3]


# ── In-memory FTS5 index (built from files at call time) ─────────────────────
def _index(skills, notes):
    try:
        c = sqlite3.connect(":memory:")
        c.execute("CREATE VIRTUAL TABLE s USING fts5(name, content, description, tokenize='trigram')")
        c.execute("CREATE VIRTUAL TABLE n USING fts5(slug, title, content, tokenize='trigram')")
        for r in skills:
            c.execute("INSERT INTO s VALUES(?,?,?)", [r["name"], r["content"], r["description"]])
        for r in notes:
            c.execute("INSERT INTO n VALUES(?,?,?)", [r["slug"], r["title"], r["content"]])
        return c
    except sqlite3.OperationalError:
        return None


# ── Read tools ──────────────────────────────────────────────────────────────
@mcp.tool()
def list_skills(category: Optional[str] = None) -> str:
    """List personal skills, optionally filtered by category (a slash-separated folder path)."""
    rows = _all_skills()
    if category:
        rows = [r for r in rows if r["category"] == category]
    rows.sort(key=lambda r: (r["category"], r["name"]))
    return json.dumps([{"name": r["name"], "description": r["description"],
                        "category": r["category"], "tags": r["tags"]} for r in rows])


@mcp.tool()
def search_skills(query: str) -> str:
    """Ranked full-text search across skill names, content, and descriptions (CJK-friendly)."""
    skills = _all_skills()
    hits = []
    idx = _index(skills, [])
    if idx is not None:
        try:
            names = [x[0] for x in idx.execute(
                "SELECT name FROM s WHERE s MATCH ? ORDER BY rank LIMIT 20", [query])]
            by = {}
            for s in skills:
                by.setdefault(s["name"], s)
            hits = [by[n] for n in names if n in by]
        except sqlite3.OperationalError:
            hits = []
    if not hits:
        q = query.lower()
        hits = [s for s in skills if q in s["name"].lower()
                or q in (s["content"] or "").lower() or q in (s["description"] or "").lower()][:20]
    return json.dumps([{"name": s["name"], "description": s["description"], "category": s["category"]} for s in hits])


@mcp.tool()
def get_skill(name: str) -> str:
    """Get the full markdown content of a skill by exact name."""
    r = _skill_get(name)
    if not r:
        return f"Skill '{name}' not found. Use list_skills or search_skills to find it."
    return json.dumps({"name": r["name"], "content": r["content"], "description": r["description"],
                       "category": r["category"], "tags": r["tags"], "updated_at": r["updated_at"]})


@mcp.tool()
def list_notes(type: Optional[str] = None) -> str:
    """List notes. type can be: general, todo, done, observation, data-path."""
    rows = _all_notes()
    if type and type != "all":
        rows = [r for r in rows if r["type"] == type]
    rows.sort(key=lambda r: r["updated_at"], reverse=True)
    return json.dumps([{"slug": r["slug"], "title": r["title"], "type": r["type"],
                        "category": r["category"], "updated_at": r["updated_at"]} for r in rows[:50]])


@mcp.tool()
def search_notes(query: str) -> str:
    """Ranked full-text search across note titles and content (CJK-friendly)."""
    notes = _all_notes()
    hits = []
    idx = _index([], notes)
    if idx is not None:
        try:
            slugs = [x[0] for x in idx.execute(
                "SELECT slug FROM n WHERE n MATCH ? ORDER BY rank LIMIT 20", [query])]
            by = {r["slug"]: r for r in notes}
            hits = [by[s] for s in slugs if s in by]
        except sqlite3.OperationalError:
            hits = []
    if not hits:
        q = query.lower()
        hits = [r for r in notes if q in r["title"].lower() or q in (r["content"] or "").lower()][:20]
    return json.dumps([{"slug": r["slug"], "title": r["title"], "type": r["type"]} for r in hits])


@mcp.tool()
def get_note(slug: str) -> str:
    """Get the full content of a note by slug (its relative path without .md)."""
    r = _note_get(slug)
    if not r:
        return f"Note '{slug}' not found. Use list_notes or search_notes to find it."
    return json.dumps({"slug": r["slug"], "title": r["title"], "content": r["content"],
                       "type": r["type"], "tags": r["tags"], "category": r["category"],
                       "updated_at": r["updated_at"]})


# ── Write tools ─────────────────────────────────────────────────────────────
@mcp.tool()
def add_note(title: str, content: str, type: str = "general", tags: Optional[List[str]] = None,
             category: Optional[str] = None, slug: Optional[str] = None) -> str:
    """Create a new note. 'category' is a slash-separated path (e.g. Project/AutoLabeling/C2 Guideline)
    used to organize the note in the sidebar tree. 'type' is one of general/todo/done/observation/data-path.
    The note's identity ('slug') is its relative path without .md and is returned on success."""
    cat = _safe_cat(category or "")
    key = (cat + "/" + title) if cat else title
    if _note_get(key):
        return json.dumps({"error": f"Note '{key}' already exists. Use update_note instead."})
    new_slug = _note_write(key, title or key, content, type, tags or [], cat)
    return json.dumps({"ok": True, "slug": new_slug})


@mcp.tool()
def update_note(slug: str, title: Optional[str] = None, content: Optional[str] = None,
                type: Optional[str] = None, category: Optional[str] = None, tags: Optional[List[str]] = None) -> str:
    """Update fields of an existing note by slug. Only provided fields are changed.
    Changing title/category moves the underlying file; the new slug is returned."""
    row = _note_get(slug)
    if not row:
        return json.dumps({"error": f"Note '{slug}' not found."})
    new_slug = _note_write(
        slug,
        title if title is not None else row["title"],
        content if content is not None else row["content"],
        type if type is not None else row["type"],
        tags if tags is not None else row["tags"],
        category if category is not None else row["category"],
    )
    return json.dumps({"ok": True, "slug": new_slug})


@mcp.tool()
def delete_note(slug: str) -> str:
    """Delete a note by slug (its relative path without .md)."""
    p = NOTES / (slug + ".md")
    try: p.unlink(missing_ok=True)
    except Exception: pass
    return json.dumps({"ok": True, "slug": slug})


@mcp.tool()
def add_skill(name: str, content: str, description: str = "", category: str = "",
              tags: Optional[List[str]] = None, source_project: str = "") -> str:
    """Create or overwrite a skill. 'category' is a slash-separated folder path
    (e.g. General/DLIS/docker); 'name' is the skill's unique identifier."""
    created = None
    existing = _skill_get(name)
    _skill_write(name, content, description, category, tags or [], source_project or None, created)
    return json.dumps({"ok": True, "name": name})


@mcp.tool()
def update_skill(name: str, content: Optional[str] = None, description: Optional[str] = None,
                 category: Optional[str] = None, tags: Optional[List[str]] = None) -> str:
    """Update fields of an existing skill by name. Only provided fields are changed."""
    row = _skill_get(name)
    if not row:
        return json.dumps({"error": f"Skill '{name}' not found. Use add_skill to create it."})
    _skill_write(
        name,
        content if content is not None else row["content"],
        description if description is not None else row["description"],
        category if category is not None else row["category"],
        tags if tags is not None else row["tags"],
        row["source_project"],
    )
    return json.dumps({"ok": True, "name": name})


@mcp.tool()
def delete_skill(name: str) -> str:
    """Delete a skill by name."""
    p, _ = _find_skill(name)
    if p is not None:
        try: p.unlink()
        except Exception: pass
    return json.dumps({"ok": True, "name": name})


# ── Paper tools ──────────────────────────────────────────────────────────────
@mcp.tool()
def list_papers(topic: Optional[str] = None) -> str:
    """List papers (optionally filtered by topic), sorted by citation count (popularity)."""
    all_p = _all_papers(); counts = _citation_counts(all_p)
    rows = [p for p in all_p if (not topic or p["topic"] == topic)]
    rows.sort(key=lambda p: (-(counts.get(p["slug"], 0)), -(p["year"] or 0), p["title"]))
    return json.dumps([{"slug": p["slug"], "title": p["title"], "year": p["year"],
                        "authors": p["authors"], "topic": p["topic"], "publisher": p["publisher"],
                        "tags": p["tags"], "citation_count": counts.get(p["slug"], 0)} for p in rows])


@mcp.tool()
def search_papers(query: str) -> str:
    """Search papers by title, authors, topic, publisher, tags, or year."""
    q = query.lower(); all_p = _all_papers(); counts = _citation_counts(all_p)
    hits = [p for p in all_p if q in p["title"].lower() or q in p["topic"].lower()
            or q in p["publisher"].lower() or q in " ".join(p["authors"]).lower()
            or q in " ".join(p["tags"]).lower() or q in str(p["year"] or "")]
    return json.dumps([{"slug": p["slug"], "title": p["title"], "year": p["year"],
                        "topic": p["topic"], "citation_count": counts.get(p["slug"], 0)} for p in hits[:50]])


@mcp.tool()
def get_paper(slug: str) -> str:
    """Get a paper's full record (metadata, conclusions, cites with notes, body) by slug."""
    p = _paper_get(slug)
    if not p:
        return f"Paper '{slug}' not found. Use list_papers or search_papers to find it."
    p["citation_count"] = _citation_counts(_all_papers()).get(slug, 0)
    return json.dumps(p)


@mcp.tool()
def add_paper(title: str, authors: Optional[List[str]] = None, year: Optional[int] = None,
              topic: str = "", publisher: str = "", tags: Optional[List[str]] = None,
              url: str = "", conclusions: Optional[List[str]] = None,
              cites: Optional[List[dict]] = None, category: str = "", content: str = "") -> str:
    """Create a paper. 'cites' is a list of {paper, note}: paper is a cited paper's title or slug,
    note explains how this paper uses it ('A cites B' means A is a child of B). 'category' is a
    slash-separated folder path; 'conclusions' is a list shown in the citation graph."""
    cat = _safe_cat(category or "")
    key = (cat + "/" + title) if cat else title
    if _paper_get(key):
        return json.dumps({"error": f"Paper '{key}' already exists. Use update_paper instead."})
    new = _paper_write(key, title, content, authors or [], year, topic, publisher, tags or [],
                       url, "", conclusions or [], cites or [], cat)
    return json.dumps({"ok": True, "slug": new})


@mcp.tool()
def update_paper(slug: str, title: Optional[str] = None, authors: Optional[List[str]] = None,
                 year: Optional[int] = None, topic: Optional[str] = None, publisher: Optional[str] = None,
                 tags: Optional[List[str]] = None, url: Optional[str] = None,
                 conclusions: Optional[List[str]] = None, cites: Optional[List[dict]] = None,
                 category: Optional[str] = None, content: Optional[str] = None) -> str:
    """Update fields of an existing paper by slug. Only provided fields are changed."""
    p = _paper_get(slug)
    if not p:
        return json.dumps({"error": f"Paper '{slug}' not found."})
    new = _paper_write(slug,
        title if title is not None else p["title"],
        content if content is not None else p["content"],
        authors if authors is not None else p["authors"],
        year if year is not None else p["year"],
        topic if topic is not None else p["topic"],
        publisher if publisher is not None else p["publisher"],
        tags if tags is not None else p["tags"],
        url if url is not None else p["url"],
        p["file"],
        conclusions if conclusions is not None else p["conclusions"],
        cites if cites is not None else p["cites"],
        category if category is not None else p["category"])
    return json.dumps({"ok": True, "slug": new})


@mcp.tool()
def delete_paper(slug: str) -> str:
    """Delete a paper by slug."""
    try: (PAPERS / (slug + ".md")).unlink(missing_ok=True)
    except Exception: pass
    return json.dumps({"ok": True, "slug": slug})


@mcp.tool()
def paper_graph(topic: Optional[str] = None, limit: int = 10, neighbors: bool = False) -> str:
    """Citation graph of the top papers. Returns {nodes, edges}: each edge is
    {from: cited_parent, to: citing_child, note}. 'limit' keeps the top-N by citations
    (optionally within 'topic'); set neighbors=true to also include directly-connected papers."""
    all_p = _all_papers(); resolve = _paper_resolver(all_p); counts = _citation_counts(all_p)
    by = {p["slug"]: p for p in all_p}
    filtered = [p for p in all_p if (not topic or p["topic"] == topic)]
    filtered.sort(key=lambda p: (-(counts.get(p["slug"], 0)), -(p["year"] or 0)))
    node_set = set(p["slug"] for p in filtered[:max(1, limit)])
    if neighbors:
        for s in list(node_set):
            p = by.get(s)
            if not p: continue
            for c in p["cites"]:
                t = resolve(c["paper"])
                if t: node_set.add(t)
            for q in all_p:
                for c in q["cites"]:
                    if resolve(c["paper"]) == s: node_set.add(q["slug"])
    nodes = [{"key": by[s]["slug"], "title": by[s]["title"], "year": by[s]["year"],
              "topic": by[s]["topic"], "citation_count": counts.get(s, 0),
              "conclusions": by[s]["conclusions"]} for s in node_set if s in by]
    edges = []
    for p in all_p:
        if p["slug"] not in node_set: continue
        for c in p["cites"]:
            t = resolve(c["paper"])
            if t and t in node_set:
                edges.append({"from": t, "to": p["slug"], "note": c["note"]})
    return json.dumps({"nodes": nodes, "edges": edges, "total": len(filtered), "shown": len(nodes)})


if __name__ == "__main__":
    mcp.run()
`);

  fs.writeFileSync(reqTxt, "fastmcp>=2.0.0\n");

  const configSnippet = JSON.stringify({
    mcpServers: {
      "personal-knowledge": {
        command: "python",
        args: [serverPy],
      }
    }
  }, null, 2);

  return { serverPath: serverPy, configSnippet };
}

// ── AI Summary for scripts ──────────────────────────────────────────────────
// ── AI backends ─────────────────────────────────────────────────────────────
interface AiBackend { id: string; label: string; kind: "copilot" | "azure-openai" | "openai-compatible"; model: string; }

/** Scan for available AI backends: live Copilot models + configured HTTP endpoints. */
async function listAiBackends(context: vscode.ExtensionContext): Promise<AiBackend[]> {
  const out: AiBackend[] = [];

  // Copilot — enumerate the actual models the VS Code LM API offers
  const lm = (vscode as any).lm;
  if (lm?.selectChatModels) {
    try {
      const models = await lm.selectChatModels({ vendor: "copilot" });
      for (const m of models || []) {
        out.push({ id: `copilot:${m.id}`, label: `Copilot · ${m.name || m.id}`, kind: "copilot", model: m.id });
      }
    } catch { /* Copilot not available */ }
  }

  // HTTP backends — available when an endpoint + API key are configured
  const cfg = vscode.workspace.getConfiguration("personalKnowledge");
  const endpoint = cfg.get<string>("aiEndpoint")?.trim();
  const model = cfg.get<string>("aiModel")?.trim() || "gpt-4o-mini";
  const backend = cfg.get<string>("aiBackend");
  const key = await context.secrets.get("personalKnowledge.aiApiKey");
  if (endpoint && key) {
    if (backend === "azure-openai")
      out.push({ id: `azure:${model}`, label: `Azure OpenAI · ${model}`, kind: "azure-openai", model });
    else
      out.push({ id: `openai:${model}`, label: `OpenAI-compatible · ${model}`, kind: "openai-compatible", model });
  } else if (endpoint) {
    // Endpoint set but no key — surface as needing configuration
    const kind = backend === "azure-openai" ? "azure-openai" : "openai-compatible";
    out.push({ id: `${kind}:${model}:needkey`, label: `${kind === "azure-openai" ? "Azure OpenAI" : "OpenAI-compatible"} · ${model} (set API key)`, kind, model });
  }
  return out;
}

/** Run a prompt against a specific backend and return the text response. */
async function runAiPrompt(context: vscode.ExtensionContext, backend: AiBackend, prompt: string): Promise<string> {
  if (backend.kind === "copilot") {
    const lm = (vscode as any).lm;
    if (!lm?.selectChatModels) throw new Error("Language Model API unavailable (needs VS Code 1.90+ with Copilot).");
    let models = await lm.selectChatModels({ vendor: "copilot", id: backend.model });
    if (!models?.length) models = await lm.selectChatModels({ vendor: "copilot" });
    const model = models?.[0];
    if (!model) throw new Error("No Copilot chat model available. Sign in to GitHub Copilot.");
    const messages = [ (vscode as any).LanguageModelChatMessage.User(prompt) ];
    const resp = await model.sendRequest(messages, {}, new vscode.CancellationTokenSource().token);
    let out = ""; for await (const chunk of resp.text) out += chunk;
    return out.trim();
  }

  // HTTP backends (Azure OpenAI / OpenAI-compatible)
  const cfg = vscode.workspace.getConfiguration("personalKnowledge");
  const endpoint = (cfg.get<string>("aiEndpoint") ?? "").trim().replace(/\/$/, "");
  const apiKey = await context.secrets.get("personalKnowledge.aiApiKey");
  if (!endpoint) throw new Error("No AI endpoint configured (personalKnowledge.aiEndpoint).");
  if (!apiKey) throw new Error('No API key set. Run "Personal Knowledge: Set AI API Key".');

  let url: string; const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (backend.kind === "azure-openai") {
    const ver = cfg.get<string>("aiAzureApiVersion") || "2024-06-01";
    url = `${endpoint}/openai/deployments/${backend.model}/chat/completions?api-version=${ver}`;
    headers["api-key"] = apiKey;
  } else {
    url = `${endpoint}/chat/completions`;
    headers["Authorization"] = `Bearer ${apiKey}`;
  }
  const body = { model: backend.model, messages: [{ role: "user", content: prompt }], temperature: 0.2, max_tokens: 700 };
  const resp = await fetch(url, { method: "POST", headers, body: JSON.stringify(body), signal: AbortSignal.timeout(60_000) });
  if (!resp.ok) throw new Error(`Endpoint returned ${resp.status}: ${(await resp.text()).slice(0, 200)}`);
  const j: any = await resp.json();
  return (j?.choices?.[0]?.message?.content ?? "").trim();
}

// ── AI Summary for scripts ──────────────────────────────────────────────────
/** Per-script cache directory under scripts/.ai-cache/<sanitized-path>/ */
function scriptCacheDir(relPath: string): string {
  const slug = relPath.replace(/[^A-Za-z0-9._-]+/g, "_");
  return path.join(getStorePath(), "scripts", ".ai-cache", slug);
}

async function aiSummarizeScript(
  context: vscode.ExtensionContext, relPath: string, backendId?: string, cacheOnly = false
): Promise<{ summary?: string; cached?: boolean; error?: string; backend?: string; miss?: boolean }> {
  const r = scriptGet(relPath);
  if (!r) return cacheOnly ? { miss: true } : { error: `Script not found: ${relPath}` };

  // Resolve the backend: requested id, else first available
  const backends = await listAiBackends(context);
  if (!backends.length) {
    return cacheOnly ? { miss: true } : { error: "No AI backend available. Enable Copilot, or set an endpoint + API key in Settings." };
  }
  const backend = backends.find(b => b.id === backendId) ?? backends[0];
  if (backend.id.endsWith(":needkey")) {
    return cacheOnly ? { miss: true } : { error: 'API key not set. Run "Personal Knowledge: Set AI API Key".', backend: backend.label };
  }

  // Cache key includes the backend id so switching model/provider regenerates.
  // Files live in a per-script subfolder so they can be removed on delete/edit.
  const hash = createHash("sha256").update(backend.id + "\0" + r.content).digest("hex").slice(0, 16);
  const cacheDir = scriptCacheDir(relPath);
  const cacheFile = path.join(cacheDir, `${hash}.md`);
  if (fs.existsSync(cacheFile)) {
    return { summary: fs.readFileSync(cacheFile, "utf-8"), cached: true, backend: backend.label };
  }
  // Cache-only peek (used when opening a script): don't call the AI on a miss
  if (cacheOnly) return { miss: true, backend: backend.label };

  const prompt = [
    `You are analyzing a data-processing script written in: ${r.lang}.`,
    `File: ${r.path}`,
    ``,
    `Produce a concise Markdown summary with these sections:`,
    `- **Purpose**: what this script does (1-2 sentences)`,
    `- **How it works**: key steps / data flow`,
    `- **Inputs**: source streams/tables/files it reads`,
    `- **Output**: what it produces and where`,
    `- **Potential issues**: correctness, performance, or maintenance concerns`,
    ``,
    `Keep it under 250 words. Here is the script:`,
    ``,
    "```",
    r.content.slice(0, 24000),
    "```",
  ].join("\n");

  try {
    const out = await runAiPrompt(context, backend, prompt);
    if (!out) return { error: "The model returned an empty response.", backend: backend.label };
    // Prepend a machine-readable header noting which backend produced this
    const withHeader = `<!-- backend: ${backend.id} | generated: ${new Date().toISOString()} -->\n\n${out}`;
    fs.mkdirSync(cacheDir, { recursive: true });
    fs.writeFileSync(cacheFile, withHeader);
    return { summary: withHeader, cached: false, backend: backend.label };
  } catch (e: any) {
    return { error: `AI request failed: ${e?.message ?? e}`, backend: backend.label };
  }
}


// ── Sidebar tree provider ──────────────────────────────────────────────────
type PkNodeType =
  | 'root-skills' | 'root-notes' | 'root-papers' | 'root-prompts' | 'root-packages' | 'root-scripts'
  | 'skill-folder' | 'skill' | 'note-folder' | 'note' | 'paper-folder' | 'paper'
  | 'prompt-project' | 'prompt-task' | 'prompt-version' | 'prompt-file'
  | 'package' | 'script-folder' | 'script-file';

interface PkFolder { folders: Map<string, PkFolder>; items: any[]; }

class PkTreeItem extends vscode.TreeItem {
  constructor(
    label: string,
    public readonly nodeType: PkNodeType,
    collapsibleState: vscode.TreeItemCollapsibleState,
    public readonly nodeData: any = {}
  ) {
    super(label, collapsibleState);
    const ICONS: Partial<Record<PkNodeType, string>> = {
      "root-skills": "book", "root-notes": "note", "root-papers": "library", "root-prompts": "comment-discussion",
      "root-packages": "package", "root-scripts": "terminal",
      "skill-folder": "folder", "note-folder": "folder", "paper-folder": "folder",
      "skill": "symbol-snippet", "note": "file-text", "paper": "file-pdf",
      "prompt-project": "folder", "prompt-task": "symbol-file",
      "prompt-version": "versions", "prompt-file": "file-code",
      "package": "package", "script-folder": "folder", "script-file": "file-code",
    };
    const icon = ICONS[nodeType];
    if (icon) this.iconPath = new vscode.ThemeIcon(icon);
    if (nodeData?.description) this.tooltip = nodeData.description;

    // contextValue drives right-click "New item" menus (see package.json view/item/context)
    if (nodeType === 'root-skills' || nodeType === 'skill-folder')      this.contextValue = 'pk-skills-container';
    else if (nodeType === 'root-notes' || nodeType === 'note-folder')   this.contextValue = 'pk-notes-container';
    else if (nodeType === 'root-papers' || nodeType === 'paper-folder') this.contextValue = 'pk-papers-container';
    else if (nodeType === 'root-scripts' || nodeType === 'script-folder') this.contextValue = 'pk-scripts-container';
    // Leaf items support right-click Edit
    else if (nodeType === 'skill')       this.contextValue = 'pk-skill-item';
    else if (nodeType === 'note')        this.contextValue = 'pk-note-item';
    else if (nodeType === 'paper')       this.contextValue = 'pk-paper-item';
    else if (nodeType === 'script-file') this.contextValue = 'pk-script-item';
  }
}

class PkTreeProvider implements vscode.TreeDataProvider<PkTreeItem> {
  private _onChange = new vscode.EventEmitter<PkTreeItem | undefined | void>();
  readonly onDidChangeTreeData = this._onChange.event;

  refresh(): void { this._onChange.fire(); }
  getTreeItem(e: PkTreeItem): vscode.TreeItem { return e; }

  getChildren(element?: PkTreeItem): PkTreeItem[] {
    const C = vscode.TreeItemCollapsibleState.Collapsed;
    if (!element) {
      return [
        new PkTreeItem("Skills",   'root-skills',   vscode.TreeItemCollapsibleState.Collapsed),
        new PkTreeItem("Notes",    'root-notes',    C),
        new PkTreeItem("Papers",   'root-papers',   C),
        new PkTreeItem("Prompts",  'root-prompts',  C),
        new PkTreeItem("Packages", 'root-packages', C),
        new PkTreeItem("Scripts",  'root-scripts',  C),
      ];
    }
    try {
      switch (element.nodeType) {
        case 'root-skills':    return this._skillFolder([]);
        case 'skill-folder':   return this._skillFolder(element.nodeData.path);
        case 'root-notes':     return this._noteFolder([]);
        case 'note-folder':    return this._noteFolder(element.nodeData.path);
        case 'root-papers':    return this._paperFolder([]);
        case 'paper-folder':   return this._paperFolder(element.nodeData.path);
        case 'root-prompts':   return this._promptProjects();
        case 'prompt-project': return this._promptTasks(element.nodeData.project);
        case 'prompt-task':    return this._promptVersions(element.nodeData.project, element.nodeData.task);
        case 'prompt-version': return this._promptFiles(element.nodeData);
        case 'root-packages':  return this._packageItems();
        case 'root-scripts':   return this._scriptFolder([]);
        case 'script-folder':  return this._scriptFolder(element.nodeData.path);
      }
    } catch { /* DB/store not ready yet */ }
    return [];
  }

  // ── Generic recursive path tree ──────────────────────────────────────────
  private static _maxDepth(): number {
    const d = vscode.workspace.getConfiguration("personalKnowledge").get<number>("maxTreeDepth", 4);
    return Math.max(1, Math.min(d ?? 4, 12));
  }

  /** Build a nested folder tree from entries {path, data}. Folder depth is capped so
   *  the leaf occupies the final level; deeper path segments collapse into the leaf. */
  private _buildPathTree(entries: { path: string[]; data: any }[]): PkFolder {
    const maxDepth = PkTreeProvider._maxDepth();
    const root: PkFolder = { folders: new Map(), items: [] };
    for (const e of entries) {
      const folderSegs = e.path.slice(0, Math.max(0, maxDepth - 1));
      let node = root;
      for (const seg of folderSegs) {
        if (!node.folders.has(seg)) node.folders.set(seg, { folders: new Map(), items: [] });
        node = node.folders.get(seg)!;
      }
      node.items.push(e.data);
    }
    return root;
  }

  private _navigate(root: PkFolder, path: string[]): PkFolder | undefined {
    let node = root;
    for (const seg of path) {
      const next = node.folders.get(seg);
      if (!next) return undefined;
      node = next;
    }
    return node;
  }

  // ── Skills (recursive by category path) ──────────────────────────────────
  private _skillRoot(): PkFolder {
    const entries = (skillList() as any[]).map(s => {
      const cat = (s.category || "").trim();
      const path = cat ? cat.split("/").map((x: string) => x.trim()).filter(Boolean) : ["(uncategorized)"];
      return { path, data: s };
    });
    return this._buildPathTree(entries);
  }

  private _skillFolder(path: string[]): PkTreeItem[] {
    const node = this._navigate(this._skillRoot(), path);
    if (!node) return [];
    const out: PkTreeItem[] = [];
    for (const name of [...node.folders.keys()].sort((a, b) =>
      a === "(uncategorized)" ? 1 : b === "(uncategorized)" ? -1 : a.localeCompare(b))) {
      const folder = node.folders.get(name)!;
      const count = this._countLeaves(folder);
      const item = new PkTreeItem(name, 'skill-folder', vscode.TreeItemCollapsibleState.Collapsed,
        { path: [...path, name] });
      item.description = String(count);
      out.push(item);
    }
    for (const s of node.items.sort((a: any, b: any) => a.name.localeCompare(b.name))) {
      const item = new PkTreeItem(s.name, 'skill', vscode.TreeItemCollapsibleState.None,
        { key: s.name, description: s.description });
      item.command = { command: 'personalKnowledge.openSkill', title: 'Open', arguments: [s.name] };
      if (s.description) item.description = s.description;
      out.push(item);
    }
    return out;
  }

  private _countLeaves(node: PkFolder): number {
    let n = node.items.length;
    for (const f of node.folders.values()) n += this._countLeaves(f);
    return n;
  }

  // ── Notes (recursive by category path; uncategorized grouped together) ───
  private _noteRoot(): PkFolder {
    const entries = (noteList(undefined, 500) as any[]).map(n => {
      const cat = (n.category || "").trim();
      const path = cat ? cat.split("/").map((x: string) => x.trim()).filter(Boolean) : ["(uncategorized)"];
      return { path, data: n };
    });
    return this._buildPathTree(entries);
  }

  private _noteFolder(path: string[]): PkTreeItem[] {
    const node = this._navigate(this._noteRoot(), path);
    if (!node) return [];
    const out: PkTreeItem[] = [];
    for (const name of [...node.folders.keys()].sort((a, b) =>
      a === "(uncategorized)" ? 1 : b === "(uncategorized)" ? -1 : a.localeCompare(b))) {
      const folder = node.folders.get(name)!;
      const item = new PkTreeItem(name, 'note-folder', vscode.TreeItemCollapsibleState.Collapsed,
        { path: [...path, name] });
      item.description = String(this._countLeaves(folder));
      out.push(item);
    }
    for (const n of node.items.sort((a: any, b: any) => (b.updated_at || "").localeCompare(a.updated_at || ""))) {
      const item = new PkTreeItem(n.title, 'note', vscode.TreeItemCollapsibleState.None, { key: n.slug });
      item.description = n.updated_at?.slice(0, 10);
      item.command = { command: 'personalKnowledge.openNote', title: 'Open', arguments: [n.slug] };
      out.push(item);
    }
    return out;
  }

  // ── Papers (category → paper) ────────────────────────────────────────────
  private _paperRoot(): PkFolder {
    const entries = (paperList() as any[]).map(p => {
      const cat = (p.category || "").trim();
      const path = cat ? cat.split("/").map((x: string) => x.trim()).filter(Boolean) : ["(uncategorized)"];
      return { path, data: p };
    });
    return this._buildPathTree(entries);
  }

  private _paperFolder(path: string[]): PkTreeItem[] {
    const node = this._navigate(this._paperRoot(), path);
    if (!node) return [];
    const out: PkTreeItem[] = [];
    for (const name of [...node.folders.keys()].sort((a, b) =>
      a === "(uncategorized)" ? 1 : b === "(uncategorized)" ? -1 : a.localeCompare(b))) {
      const folder = node.folders.get(name)!;
      const item = new PkTreeItem(name, 'paper-folder', vscode.TreeItemCollapsibleState.Collapsed,
        { path: [...path, name] });
      item.description = String(this._countLeaves(folder));
      out.push(item);
    }
    // Sort papers by citation count (popularity), then year desc
    for (const p of node.items.sort((a: any, b: any) => (b.citationCount - a.citationCount) || ((b.year || 0) - (a.year || 0)))) {
      const item = new PkTreeItem(p.title, 'paper', vscode.TreeItemCollapsibleState.None, { key: p.slug });
      item.description = `${p.year || ""}${p.citationCount ? "  ·  " + p.citationCount + "★" : ""}`.trim();
      item.command = { command: 'personalKnowledge.openPaper', title: 'Open', arguments: [p.slug] };
      out.push(item);
    }
    return out;
  }

  // ── Prompts (project → task → version → file) ────────────────────────────
  private _promptProjects(): PkTreeItem[] {
    const projects = [...new Set(promptList().map(t => t.project))].sort();
    return projects.map(p =>
      new PkTreeItem(p, 'prompt-project', vscode.TreeItemCollapsibleState.Collapsed, { project: p }));
  }

  private _promptTasks(project: string): PkTreeItem[] {
    return promptList().filter(t => t.project === project).map(t =>
      new PkTreeItem(t.task, 'prompt-task', vscode.TreeItemCollapsibleState.Collapsed,
        { project, task: t.task }));
  }

  private _promptVersions(project: string, task: string): PkTreeItem[] {
    const t = promptList().find(x => x.project === project && x.task === task);
    if (!t) return [];
    return t.versions.map(v =>
      new PkTreeItem(v.version, 'prompt-version', vscode.TreeItemCollapsibleState.Collapsed,
        { project, task, version: v.version, files: v.files }));
  }

  private _promptFiles(nd: any): PkTreeItem[] {
    return (nd.files ?? []).map((f: any) => {
      const item = new PkTreeItem(f.name, 'prompt-file', vscode.TreeItemCollapsibleState.None,
        { project: nd.project, task: nd.task, version: nd.version, file: f.name });
      const key = `${nd.project}|${nd.task}|${nd.version}|${f.name}`;
      item.command = { command: 'personalKnowledge.openPrompt', title: 'Open', arguments: [key] };
      return item;
    });
  }

  // ── Packages ─────────────────────────────────────────────────────────────
  private _packageItems(): PkTreeItem[] {
    return (packageList() as any[]).map((p: any) => {
      const item = new PkTreeItem(p.name, 'package', vscode.TreeItemCollapsibleState.None,
        { key: p.name, description: p.description });
      item.description = p.lang;
      item.command = { command: 'personalKnowledge.openPackage', title: 'Open', arguments: [p.name] };
      return item;
    });
  }

  // ── Scripts (recursive by folder path) ───────────────────────────────────
  private _scriptRoot(): PkFolder {
    const entries = (scriptList() as any[]).map(s => {
      const cat = (s.category || "").trim();
      const path = cat && cat !== "(root)" ? cat.split("/").map((x: string) => x.trim()).filter(Boolean) : [];
      return { path, data: s };
    });
    return this._buildPathTree(entries);
  }

  private _scriptFolder(path: string[]): PkTreeItem[] {
    const node = this._navigate(this._scriptRoot(), path);
    if (!node) return [];
    const out: PkTreeItem[] = [];
    for (const name of [...node.folders.keys()].sort()) {
      const folder = node.folders.get(name)!;
      const item = new PkTreeItem(name, 'script-folder', vscode.TreeItemCollapsibleState.Collapsed,
        { path: [...path, name] });
      item.description = String(this._countLeaves(folder));
      out.push(item);
    }
    for (const s of node.items.sort((a: any, b: any) => a.file.localeCompare(b.file))) {
      const item = new PkTreeItem(s.file, 'script-file', vscode.TreeItemCollapsibleState.None, { key: s.path });
      item.description = s.lang;
      item.command = { command: 'personalKnowledge.openScript', title: 'Open', arguments: [s.path] };
      out.push(item);
    }
    return out;
  }
}

// ── First-run setup wizard ─────────────────────────────────────────────────
async function firstTimeSetup(context: vscode.ExtensionContext): Promise<string | undefined> {
  const defaultPath = path.join(require("os").homedir(), "personal-knowledge");

  const pick = await vscode.window.showInformationMessage(
    "Welcome to Personal Knowledge! Choose where to store your knowledge base:",
    { modal: true },
    "Use default  (~/personal-knowledge)",
    "Browse existing folder…",
    "Type a custom path…"
  );

  if (!pick) return undefined;

  let chosenPath: string | undefined;

  if (pick === "Browse existing folder…") {
    const result = await vscode.window.showOpenDialog({
      canSelectFolders: true,
      canSelectFiles: false,
      canSelectMany: false,
      openLabel: "Select knowledge store folder",
      title: "Personal Knowledge — store location",
    });
    if (!result?.[0]) return undefined;
    chosenPath = result[0].fsPath;

  } else if (pick === "Type a custom path…") {
    chosenPath = await vscode.window.showInputBox({
      prompt: "Enter the full path for your knowledge store",
      placeHolder: defaultPath,
      value: defaultPath,
      validateInput: v => v?.trim() ? null : "Path cannot be empty",
    });
    if (!chosenPath) return undefined;
    chosenPath = chosenPath.trim();

  } else {
    chosenPath = defaultPath;
  }

  // Create the folder if it doesn't exist
  if (!fs.existsSync(chosenPath)) {
    const confirm = await vscode.window.showWarningMessage(
      `Folder does not exist: ${chosenPath}\n\nCreate it?`,
      { modal: true },
      "Create folder"
    );
    if (confirm !== "Create folder") return undefined;
    fs.mkdirSync(chosenPath, { recursive: true });
  }

  await vscode.workspace.getConfiguration("personalKnowledge")
    .update("storePath", chosenPath, vscode.ConfigurationTarget.Global);
  await context.globalState.update("setupComplete", true);
  return chosenPath;
}

// ── Activation ─────────────────────────────────────────────────────────────
export async function activate(context: vscode.ExtensionContext): Promise<void> {
  log.init(context);
  log.info(`activating extension v${context.extension?.packageJSON?.version ?? "?"}`);
  context.subscriptions.push(
    vscode.workspace.onDidChangeConfiguration(e => {
      if (e.affectsConfiguration("personalKnowledge.logLevel")) log.refreshLevel();
      if (e.affectsConfiguration("personalKnowledge.maxTreeDepth")) _treeProvider?.refresh();
    })
  );

  const cfg = vscode.workspace.getConfiguration("personalKnowledge");
  let configuredPath = cfg.get<string>("storePath")?.trim() ?? "";
  const setupComplete = context.globalState.get<boolean>("setupComplete", false);
  log.debug(`configuredPath="${configuredPath}" setupComplete=${setupComplete}`);

  // First-time setup: ask user where to store their knowledge base
  if (!setupComplete && !configuredPath) {
    const chosen = await firstTimeSetup(context);
    if (!chosen) {
      vscode.window.showErrorMessage(
        "Personal Knowledge: setup not completed. Click the sidebar icon or open the panel to configure.",
        "Configure now"
      ).then(v => { if (v) ensureSetup(context); });
    }
    configuredPath = chosen ?? "";
  }

  fsSetStorePath(configuredPath);
  storageSetStorePath(configuredPath);

  // Register sidebar tree view + commands FIRST so they're always available
  const treeProvider = new PkTreeProvider();
  _treeProvider = treeProvider;
  const treeView = vscode.window.createTreeView("personalKnowledge.sidebarView", {
    treeDataProvider: treeProvider,
    showCollapseAll: true,
  });
  // Clicking the Activity Bar icon: ensure setup then open main panel
  treeView.onDidChangeVisibility(async e => {
    if (e.visible) {
      log.action("sidebar.open");
      if (!(await ensureSetup(context))) return;
      vscode.commands.executeCommand("personalKnowledge.open");
    }
  });
  context.subscriptions.push(treeView);

  context.subscriptions.push(
    vscode.commands.registerCommand("personalKnowledge.open", async () => {
      log.action("command.open");
      if (!(await ensureSetup(context))) return;
      getOrCreatePanel(context);
    }),

    vscode.commands.registerCommand("personalKnowledge.refreshTree", () => {
      log.action("command.refreshTree");
      treeProvider.refresh();
    }),

    // ── Add new item at a folder (right-click on container) ────────────────
    vscode.commands.registerCommand("personalKnowledge.addSkillHere", async (item?: PkTreeItem) => {
      if (!(await ensureSetup(context))) return;
      const cat = (item?.nodeData?.path ?? []).join("/");
      const name = await vscode.window.showInputBox({ prompt: "New skill name", placeHolder: "e.g. my-new-skill" });
      if (!name?.trim()) return;
      skillUpsert({ name: name.trim(), content: "", category: cat || undefined });
      gitCommit(`add(skill): ${name.trim()}`);
      treeProvider.refresh();
      openInPanel(context, "skill", name.trim());
    }),

    vscode.commands.registerCommand("personalKnowledge.addNoteHere", async (item?: PkTreeItem) => {
      if (!(await ensureSetup(context))) return;
      const cat = (item?.nodeData?.path ?? []).join("/");
      const title = await vscode.window.showInputBox({ prompt: "New note title", placeHolder: "e.g. Investigation findings" });
      if (!title?.trim()) return;
      const key = (cat ? cat + "/" : "") + title.trim();
      noteUpsert({ slug: key, title: title.trim(), content: "", type: "general", tags: [], category: cat } as any);
      gitCommit(`add(note): ${title.trim()}`);
      treeProvider.refresh();
      openInPanel(context, "note", key);
    }),

    vscode.commands.registerCommand("personalKnowledge.addScriptHere", async (item?: PkTreeItem) => {
      if (!(await ensureSetup(context))) return;
      const folder = (item?.nodeData?.path ?? []).join("/");
      const fname = await vscode.window.showInputBox({
        prompt: "New script filename (include extension)",
        placeHolder: "e.g. My New Query.script",
        validateInput: v => v?.trim() ? (/[\\/]/.test(v) ? "No slashes — pick the folder by right-clicking it" : null) : "Filename required",
      });
      if (!fname?.trim()) return;
      const rel = folder ? `${folder}/${fname.trim()}` : fname.trim();
      const full = path.join(getStorePath(), "scripts", rel);
      if (fs.existsSync(full)) { vscode.window.showWarningMessage(`Script already exists: ${rel}`); return; }
      fs.mkdirSync(path.dirname(full), { recursive: true });
      fs.writeFileSync(full, "");
      gitCommit(`add(script): ${rel}`);
      treeProvider.refresh();
      openInPanel(context, "script", rel);
    }),

    // ── Edit item (right-click on a leaf) ─────────────────────────────────
    vscode.commands.registerCommand("personalKnowledge.editSkill", async (item?: PkTreeItem) => {
      if (!(await ensureSetup(context)) || !item?.nodeData?.key) return;
      openInPanel(context, "skill", item.nodeData.key, true);
    }),
    vscode.commands.registerCommand("personalKnowledge.editNote", async (item?: PkTreeItem) => {
      if (!(await ensureSetup(context)) || !item?.nodeData?.key) return;
      openInPanel(context, "note", item.nodeData.key, true);
    }),
    vscode.commands.registerCommand("personalKnowledge.editScript", async (item?: PkTreeItem) => {
      if (!(await ensureSetup(context)) || !item?.nodeData?.key) return;
      openInPanel(context, "script", item.nodeData.key, true);
    }),

    vscode.commands.registerCommand("personalKnowledge.deleteScript", async (item?: PkTreeItem) => {
      if (!(await ensureSetup(context)) || !item?.nodeData?.key) return;
      const relPath = item.nodeData.key as string;
      const full = path.join(getStorePath(), "scripts", relPath);
      const scriptsRoot = path.join(getStorePath(), "scripts");
      if (!path.resolve(full).startsWith(path.resolve(scriptsRoot) + path.sep)) return;
      const confirm = await vscode.window.showWarningMessage(
        `Delete script "${relPath}"? This removes the file and its AI-summary cache, and commits the deletion to git.`,
        { modal: true }, "Delete"
      );
      if (confirm !== "Delete") return;
      try {
        fs.rmSync(full, { force: true });
        fs.rmSync(scriptCacheDir(relPath), { recursive: true, force: true }); // remove correlated AI cache
        gitCommit(`delete(script): ${relPath}`);
        log.action("script.delete", { path: relPath });
        vscode.window.setStatusBarMessage("$(trash) Script deleted", 3000);
        treeProvider.refresh();
        panel?.webview.postMessage({ command: "detail", data: null });
      } catch (e: any) {
        vscode.window.showErrorMessage(`Delete failed: ${e.message}`);
      }
    }),

    vscode.commands.registerCommand("personalKnowledge.openSkill", async (name: string) => {
      log.action("command.openSkill", { name });
      if (!(await ensureSetup(context))) return;
      openInPanel(context, "skill", name);
    }),

    vscode.commands.registerCommand("personalKnowledge.openNote", async (slug: string) => {
      log.action("command.openNote", { slug });
      if (!(await ensureSetup(context))) return;
      openInPanel(context, "note", slug);
    }),

    vscode.commands.registerCommand("personalKnowledge.openPaper", async (slug: string) => {
      log.action("command.openPaper", { slug });
      if (!(await ensureSetup(context))) return;
      openInPanel(context, "paper", slug);
    }),

    vscode.commands.registerCommand("personalKnowledge.openPrompt", async (key: string) => {
      log.action("command.openPrompt", { key });
      if (!(await ensureSetup(context))) return;
      openInPanel(context, "prompt", key);
    }),

    vscode.commands.registerCommand("personalKnowledge.openPackage", async (name: string) => {
      log.action("command.openPackage", { name });
      if (!(await ensureSetup(context))) return;
      openInPanel(context, "package", name);
    }),

    vscode.commands.registerCommand("personalKnowledge.openScript", async (key: string) => {
      log.action("command.openScript", { key });
      if (!(await ensureSetup(context))) return;
      openInPanel(context, "script", key);
    }),

    vscode.commands.registerCommand("personalKnowledge.addNote", async () => {
      if (!(await ensureSetup(context))) return;
      const p = getOrCreatePanel(context);
      p.webview.postMessage({ command: "focusNoteForm" });
    }),

    vscode.commands.registerCommand("personalKnowledge.saveSkill", async () => {
      const editor = vscode.window.activeTextEditor;
      if (!editor) return;
      const selection = editor.document.getText(editor.selection);
      if (!selection) { vscode.window.showInformationMessage("Select text first to save as a skill."); return; }

      const name = await vscode.window.showInputBox({
        prompt: "Skill name (slug)", placeHolder: "e.g. my-workflow-tip",
        validateInput: v => v?.trim() ? null : "Name required",
      });
      if (!name) return;
      const category = await vscode.window.showInputBox({ prompt: "Category (optional)", placeHolder: "e.g. dlis" });
      skillUpsert({ name: name.trim(), content: selection, category: category?.trim() });
      gitCommit(`save(skill): ${name.trim()}`);
      vscode.window.setStatusBarMessage("$(check) Skill saved to knowledge store", 3000);
      panel?.webview.postMessage({ command: "saved" });
      treeProvider.refresh();
    }),

    vscode.commands.registerCommand("personalKnowledge.setupMcp", async () => {
      log.action("command.setupMcp");
      const p = getOrCreatePanel(context);
      p.webview.postMessage({ command: "openTab", tab: "mcp" });
    }),

    vscode.commands.registerCommand("personalKnowledge.showLogs", () => log.show()),

    vscode.commands.registerCommand("personalKnowledge.setAiKey", async () => {
      const key = await vscode.window.showInputBox({
        prompt: "Enter your AI API key (stored securely in VS Code SecretStorage)",
        password: true,
        ignoreFocusOut: true,
        placeHolder: "sk-… or Azure key",
      });
      if (key === undefined) return; // cancelled
      if (key.trim()) {
        await context.secrets.store("personalKnowledge.aiApiKey", key.trim());
        vscode.window.showInformationMessage("Personal Knowledge: AI API key saved.");
      } else {
        await context.secrets.delete("personalKnowledge.aiApiKey");
        vscode.window.showInformationMessage("Personal Knowledge: AI API key cleared.");
      }
    })
  );

  // Initialize the file store (runs the one-time DB→files migration) if configured
  if (configuredPath) {
    try {
      await initStore(context, configuredPath);
      log.info(`file store ready at ${getStorePath()}`);
      ensureGitRepo();
      startFileWatcher(context);
      treeProvider.refresh();
      panel?.webview.postMessage({ command: "saved" }); // re-fetch if panel already open
      if (!setupComplete) {
        try {
          const mcp = generateMcpServer(context);
          log.info(`MCP server generated at ${mcp.serverPath}`);
          vscode.window.showInformationMessage(
            `✅ Knowledge store ready at: ${getStorePath()}  |  MCP server: ${mcp.serverPath}  |  Install: pip install fastmcp`,
            "Open Panel"
          ).then(v => { if (v) getOrCreatePanel(context); });
        } catch (e: any) { log.warn(`MCP generation failed: ${e?.message}`); }
      }
    } catch (e: any) {
      log.error(`store init failed: ${e?.stack ?? e?.message}`);
      vscode.window.showErrorMessage(`Personal Knowledge: failed to initialize store — ${e.message}`);
    }
  }

  if (configuredPath && cfg.get<boolean>("openOnStartup")) getOrCreatePanel(context);
  log.info("activation complete");
}

// ── File watcher: auto-refresh when notes/skills change on disk ─────────────
let _watcher: vscode.FileSystemWatcher | undefined;
function startFileWatcher(context: vscode.ExtensionContext): void {
  _watcher?.dispose();
  const pattern = new vscode.RelativePattern(getStorePath(), "{notes,skills,papers}/**/*.md");
  _watcher = vscode.workspace.createFileSystemWatcher(pattern);
  const onChange = () => {
    _treeProvider?.refresh();
    panel?.webview.postMessage({ command: "reloaded" }); // re-fetch current tab
  };
  _watcher.onDidCreate(onChange);
  _watcher.onDidChange(onChange);
  _watcher.onDidDelete(onChange);
  context.subscriptions.push(_watcher);
}

export function deactivate(): void { _watcher?.dispose(); log.info("deactivated"); }
