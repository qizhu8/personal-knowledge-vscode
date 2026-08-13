import * as vscode from "vscode";
import * as path from "path";
import * as os from "os";
import * as http from "http";
import * as fs from "fs";
import { syncServer } from "./sync-server";
import {
  skillList, skillSearch, skillGet, skillUpsert, skillDelete, skillMoveCategory, skillMove, skillSetPinned,
  noteList, noteSearch, noteGet, noteUpsert, noteDelete, slugExists, noteMove, noteMoveFolder, noteSetPinned, noteFolderPins, noteSetFolderPinned,
  noteExport, noteImport, saveNoteAsset,
  paperList, paperSearch, paperGet, paperUpsert, paperDelete,
  paperFacets, paperGraph, savePaperFile,
  paperGroups, paperSetGroup, paperGroupRename, paperGroupDelete, paperSetPinned, paperSetTopic,
  setStorePath as fsSetStorePath, getStorePath,
  folderCreate, folderList, storeEntryMove, storeSafeName,
} from "./filestore";
import { migrateDbToFiles } from "./migrate";
import {
  initServers, disposeServers, serverList, serverImport, serverCreate,
  serverUpdate, serverDelete, startServer, stopServer, restartServer, setServerPort, serverLog, serverDir,
} from "./servers";
import { ChatHub, ChatClient, ChatMessage, Member, FileMeta, AgentRuntimeState, MAX_FILE_BYTES } from "./chatroom";
import { BOT_NAME } from "./chat-commands";
import { StoredChatRoom } from "./chat-room-lifecycle";
import { chatRoomIdentity, joinedRoomRecents } from "./chat-room-identity";
import { PendingJoinApproval } from "./chat-join-approval";
import { probeChatRoomActive } from "./chat-hub-health";
import {
  initPyenvs, pyenvList, pyenvAdd, pyenvUpdate, pyenvDelete,
  condaEnvs, detectFolderEnv, pyenvPackages, pyenvCompare,
  pyenvSize, pyenvActivateScript, pyenvActivateCommands, pyenvCreate, pyenvSimilarity, pyenvPyVersion, pyenvMigrate, pyenvDeleteScript, pyenvMergeScript,
} from "./pyenvs";
import {
  promptList, promptGetFile, promptGetAllVersionsOfFile,
  packageList, packageGet, packageFileGet, packageDelete,
  scriptList, scriptSearch, scriptGet, scriptMove, scriptMoveFolder,
  promptImport, scriptImport, packageImport,
  setStorePath as storageSetStorePath,
} from "./storage";

// ── Git helper ─────────────────────────────────────────────────────────────
import { execSync } from "child_process";
import { createHash, randomBytes, randomUUID } from "crypto";
import { createSyncMagicCode, parseSyncMagicCode } from "./sync-magic-code";
import { createChatMagicLink, chatInviteMessage } from "./chat-magic-link";
import { startLiveMarkdownServer } from "./live-note-server";
import { managedEnvironmentsRoot } from "./environment-paths";
import { AiBackend, aiSummarizeScript, listAiBackends, runAiPrompt, scriptCacheDir } from "./ai";
import {
  cancelMcpPythonScan, combinedMcpInstallInstruction, combinedMcpRegistry,
  detectMcpPython, ensureMcpRuntime, generateMcpServer,
  mcpRuntimeManualCommands, mcpRuntimeStatus, mcpServerDefinitionData, mcpStatus, streamMcpPythonCandidates,
  validateMcpPython,
} from "./mcp";
import {
  addPkmSkillCustomTarget, injectPkmSkill, pkmSkillProjectionStatus,
  removeInjectedPkmSkill, removePkmSkillCustomTarget, resolvePkmSkillTargetPath,
} from "./pkm-skill-projection";

// Background one-shot sweep to compute on-disk sizes for envs missing a cached
// value, then refresh the panel so sizes show up "by default".
let _sizeSweeping = false;
async function sweepEnvSizes(respond: (m: any) => void): Promise<void> {
  if (_sizeSweeping) return;
  const missing = pyenvList().filter(e => typeof e.sizeBytes !== "number");
  if (!missing.length) return;
  _sizeSweeping = true;
  try {
    for (const e of missing) { try { await pyenvSize(e.id, true); } catch { /* ignore */ } }
    respond({ command: "envList", data: envListForUi() });
  } finally { _sizeSweeping = false; }
}

// Fast background sweep to detect Python versions for envs missing one.
let _verSweeping = false;
async function sweepEnvVersions(respond: (m: any) => void): Promise<void> {
  if (_verSweeping) return;
  const missing = pyenvList().filter(e => !e.pyVersion);
  if (!missing.length) return;
  _verSweeping = true;
  try {
    for (const e of missing) { try { await pyenvPyVersion(e.id, true); } catch { /* ignore */ } }
    respond({ command: "envList", data: envListForUi() });
  } finally { _verSweeping = false; }
}

// Resolve the extension-managed environments root (for the Migrate action).
function pyenvsRoot(): string {
  return managedEnvironmentsRoot();
}

// Env list enriched with a `managed` flag (already inside the managed root).
function envListForUi(): any[] {
  const rp = path.resolve(pyenvsRoot());
  return pyenvList().map(e => {
    const pathExists = !!e.path && fs.existsSync(e.path);
    const pythonExists = !!e.python && fs.existsSync(e.python);
    return {
      ...e,
      managed: !!e.path && path.resolve(e.path).startsWith(rp + path.sep),
      missing: (!!e.path && !pathExists) || (!!e.python && !pythonExists),
      pathExists,
      pythonExists,
    };
  });
}

function mcpPanelStatusData(): object {
  const info = mcpStatus();
  const python = detectMcpPython();
  const runtime = mcpRuntimeStatus();
  const proposalDir = getStorePath() ? path.join(getStorePath(), "_proposals", "skills") : "";
  const skillProposals = proposalDir && fs.existsSync(proposalDir)
    ? fs.readdirSync(proposalDir).filter(name => name.endsWith(".md")).sort().reverse().map(name => ({ name, path: path.join(proposalDir, name) }))
    : [];
  return {
    ...info,
    combinedRegistry: runtime.healthy ? combinedMcpRegistry() : "",
    agencyInstallInstruction: combinedMcpInstallInstruction(),
    nativeMcpProvider: _nativeMcpProvider,
    mcpPython: python,
    mcpRuntime: runtime,
    pkmSkill: chatCtx && getStorePath() ? pkmSkillProjectionStatus(chatCtx) : null,
    skillProposals,
    skillProposalDir: proposalDir,
  };
}

// ── Logging ────────────────────────────────────────────────────────────────
type LogLevel = "debug" | "info" | "warn" | "error";
const LEVEL_ORDER: Record<LogLevel, number> = { debug: 0, info: 1, warn: 2, error: 3 };

class Logger {
  private channel: vscode.OutputChannel;
  private logFile = "";
  private minLevel: LogLevel = "info";

  constructor() {
    this.channel = vscode.window.createOutputChannel("Personal Knowledge Manager");
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

/** Package list enriched with git-tracking info (tracked in the store, or its own repo). */
function packagesWithGit(): any[] {
  const store = getStorePath();
  const tracked = new Set<string>();
  try {
    const out = execSync("git ls-files -- packages/", { cwd: store, encoding: "utf-8", maxBuffer: 1 << 24 });
    for (const line of out.split("\n")) { const m = line.match(/^packages\/([^/]+)\//); if (m) tracked.add(m[1]); }
  } catch { /* not a git repo */ }
  return (packageList() as any[]).map(p => ({
    ...p,
    gitRepo: fs.existsSync(path.join(store, "packages", p.name, ".git")),
    gitTracked: tracked.has(p.name),
  }));
}

/** Human summary of what a sync session shares, across ALL content types. */
function syncSummary(s: { contentTypes: string[]; selected: Record<string, string[]> }): string {
  const types = s.contentTypes || [];
  if (!types.length) return "nothing";
  return types.map(t => {
    const arr = (s.selected as any)?.[t] || [];
    return arr.length ? `${arr.length} ${t}` : `all ${t}`;
  }).join(", ");
}

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

/** Inline `_assets/<file>` image references as base64 data URIs for a portable file. */
function inlineMarkdownAssets(html: string, area = "notes", category = ""): string {
  const safeArea = ["notes", "skills", "papers"].includes(area) ? area : "notes";
  const catSegs = String(category || "").split("/").map(s => s.trim()).filter(Boolean);
  const assetsDir = path.join(getStorePath(), safeArea, ...catSegs, "_assets");
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

let liveNoteServer: http.Server | undefined;
let liveNoteBaseUrl: vscode.Uri | undefined;

function markdownPreviewPath(kind: "note" | "skill" | "paper", key: string): string {
  const prefix = kind === "note" ? "" : `${kind}s/`;
  return "/" + (prefix + key).split("/").map(segment => encodeURIComponent(segment)).join("/") + ".html";
}

function notePreviewPath(slug: string): string { return markdownPreviewPath("note", slug); }

function rewriteLiveNoteLinks(markdown: string, slug: string): string {
  const all = noteList(undefined, 100000) as any[];
  const resolve = (target: string): string | null => {
    if (/\.md(?:[?#]|$)/i.test(target) || target.includes("/")) {
      const resolved = resolveNoteSlugFromPath(target, slug);
      if (resolved && noteGet(resolved)) return resolved;
    }
    const clean = target.replace(/\.md$/i, "");
    if (noteGet(clean)) return clean;
    const needle = clean.toLowerCase();
    const base = needle.split("/").pop();
    const hit = all.find(note => String(note.slug).toLowerCase() === needle
      || String(note.title).toLowerCase() === needle
      || String(note.slug).toLowerCase().endsWith("/" + base));
    return hit?.slug || null;
  };
  return outsideCode(markdown, segment => segment
    .replace(/\[\[([^\]|]+)(?:\|([^\]]+))?\]\]/g, (_match, target, alias) => {
      const linked = resolve(String(target).trim());
      const label = String(alias || target).trim();
      return linked ? `[${label}](${notePreviewPath(linked)})` : label;
    })
    .replace(/\[([^\]]*)\]\(\s*([^)]+?)\.md((?:[?#][^)]*)?)\s*\)/gi, (match, label, target, suffix) => {
      const linked = resolve(`${target}.md`);
      return linked ? `[${label}](${notePreviewPath(linked)}${suffix || ""})` : match;
    }));
}

function liveMarkdownHtml(documentPath: string, context: vscode.ExtensionContext): string | undefined {
  let item: any;
  let kind: "note" | "skill" | "paper";
  if (documentPath.startsWith("skills/")) {
    kind = "skill";
    const key = documentPath.slice("skills/".length);
    const listed = (skillList() as any[]).find(skill => (skill.category ? `${skill.category}/${skill.name}` : skill.name) === key);
    item = listed ? skillGet(listed.name) : undefined;
  } else if (documentPath.startsWith("papers/")) {
    kind = "paper";
    item = paperGet(documentPath.slice("papers/".length));
  } else {
    kind = "note";
    item = noteGet(documentPath);
  }
  if (!item) return undefined;
  const { renderMarkdown } = require("./live-markdown") as { renderMarkdown(markdown: string): string };
  const markdown = kind === "note" ? rewriteLiveNoteLinks(item.content || "", item.slug) : item.content || "";
  const bodyHtml = renderMarkdown(markdown);
  return buildStandaloneNoteHtml({
    title: item.title || item.name, slug: item.slug || item._key, category: item.category,
    tags: Array.isArray(item.tags) ? JSON.stringify(item.tags) : item.tags || "[]",
    noteType: kind, updatedAt: item.updated_at, bodyHtml,
    description: item.description, sourceProject: item.source_project,
    authors: item.authors, year: item.year, publisher: item.publisher, url: item.url,
  }, katexCssForExport(context));
}

async function openLiveMarkdownPreview(kind: "note" | "skill" | "paper", key: string, context: vscode.ExtensionContext): Promise<boolean> {
  if (!liveNoteServer) {
    const started = await startLiveMarkdownServer(
      [
        { prefix: "skills", root: path.join(getStorePath(), "skills") },
        { prefix: "papers", root: path.join(getStorePath(), "papers") },
        { prefix: "", root: path.join(getStorePath(), "notes") },
      ],
      documentPath => liveMarkdownHtml(documentPath, context),
      MIME_BY_EXT,
    );
    liveNoteServer = started.server;
    liveNoteBaseUrl = await vscode.env.asExternalUri(vscode.Uri.parse(started.localBaseUrl));
  }
  return vscode.env.openExternal(vscode.Uri.parse(liveNoteBaseUrl!.toString().replace(/\/$/, "") + markdownPreviewPath(kind, key)));
}

// Apply `fn` only OUTSIDE fenced/inline code so link handling never touches code
// blocks (e.g. a mermaid `[[Kafka]]` node), matching how marked tokenizes code.
function outsideCode(md: string, fn: (seg: string) => string): string {
  return String(md).split(/(```[\s\S]*?```|`[^`\n]*`)/g).map((p, i) => (i % 2 === 0) ? fn(p) : p).join("");
}

// Extract cross-note link targets ([[Title]] wiki links and [text](path.md)).
function extractNoteLinks(content: string): string[] {
  const out: string[] = [];
  outsideCode(content, seg => {
    let m: RegExpExecArray | null;
    const wiki = /\[\[([^\]|]+)(?:\|[^\]]+)?\]\]/g;
    while ((m = wiki.exec(seg))) out.push(m[1].trim());
    const md = /\[[^\]]*\]\(\s*([^)]+?\.md)(?:[?#][^)]*)?\s*\)/gi;
    while ((m = md.exec(seg))) out.push(m[1].trim());
    return seg;
  });
  return out;
}

// Rewrite a note's cross-note links to point at sibling exported .html files.
function rewriteNoteLinks(
  content: string, fromSlug: string,
  resolve: (t: string, from: string) => string | null,
  filenames: Map<string, string>,
): string {
  return outsideCode(content, seg => {
    seg = seg.replace(/\[\[([^\]|]+)(?:\|([^\]]+))?\]\]/g, (m, t, a) => {
      const label = String(a || t).trim();
      const slug = resolve(String(t).trim(), fromSlug);
      const fn = slug ? filenames.get(slug) : undefined;
      return fn ? `[${label}](${fn})` : label;
    });
    seg = seg.replace(/\[([^\]]*)\]\(\s*([^)]+?\.md)(?:[?#][^)]*)?\s*\)/gi, (m, label, pth) => {
      const slug = resolve(String(pth).trim(), fromSlug);
      const fn = slug ? filenames.get(slug) : undefined;
      return fn ? `[${label}](${fn})` : m;
    });
    return seg;
  });
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
  const body = inlineMarkdownAssets(String(msg.bodyHtml || ""), String(msg.area || "notes"), String(msg.category || ""));
  const metaBits = [
    msg.noteType ? `<span class="pill type">${esc(msg.noteType)}</span>` : "",
    msg.category ? `<span class="pill cat">${esc(msg.category)}</span>` : "",
    ...tags.map(t => `<span class="pill tag">#${esc(t)}</span>`),
    msg.updatedAt ? `<span class="upd">Updated ${esc(String(msg.updatedAt).slice(0, 10))}</span>` : "",
  ].filter(Boolean).join("");
  const authors = Array.isArray(msg.authors) ? msg.authors.join(", ") : String(msg.authors || "");
  const detailRows = [
    ["Description", msg.description], ["Source", msg.sourceProject],
    ["Authors", authors], ["Year", msg.year], ["Publisher", msg.publisher], ["URL", msg.url],
  ].filter(([, value]) => value !== undefined && value !== null && String(value).trim());
  const details = detailRows.length
    ? `<dl class="details">${detailRows.map(([label, value]) => `<dt>${esc(label)}</dt><dd>${esc(value)}</dd>`).join("")}</dl>`
    : "";

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="generator" content="Personal Knowledge Manager (VS Code)">
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
.details{display:grid;grid-template-columns:max-content 1fr;gap:4px 14px;margin:0 0 20px;font-size:13px}.details dt{color:#667085;font-weight:600}.details dd{margin:0;overflow-wrap:anywhere}
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
${details}
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
let _pendingTab: string | undefined;           // tab to switch to once the webview is ready
let _pendingMcpRegenerateHighlight = false;
let _nativeMcpProvider = false;
let _mcpDefinitionsChanged: vscode.EventEmitter<void> | undefined;
let _mcpRegenerationPromptedFor = "";
let _pkmSkillUpdatePromptedFor = "";

function refreshMcpDefinitions(): void {
  _mcpDefinitionsChanged?.fire();
}

function registerNativeMcpProvider(context: vscode.ExtensionContext): void {
  const api = vscode as any;
  if (typeof api.lm?.registerMcpServerDefinitionProvider !== "function" || typeof api.McpStdioServerDefinition !== "function") return;
  const changed = new vscode.EventEmitter<void>();
  _mcpDefinitionsChanged = changed;
  const createDefinition = () => {
    const data = mcpServerDefinitionData();
    const definition = new api.McpStdioServerDefinition(data.label, data.command, data.args, {}, data.version);
    definition.cwd = vscode.Uri.file(data.cwd);
    return definition;
  };
  const provider = {
    onDidChangeMcpServerDefinitions: changed.event,
    provideMcpServerDefinitions: () => getStorePath() && mcpRuntimeStatus().healthy ? [createDefinition()] : [],
    resolveMcpServerDefinition: () => createDefinition(),
  };
  context.subscriptions.push(changed, api.lm.registerMcpServerDefinitionProvider("personalKnowledge.pkm", provider));
  _nativeMcpProvider = true;
}

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

function knowledgeContentUri(area: KnowledgeMarkdownArea, key: string): vscode.Uri {
  return vscode.Uri.from({ scheme: "pkm-content", authority: area, path: `/${key}.md` });
}

async function openStoreMarkdown(area: KnowledgeMarkdownArea, key: string): Promise<void> {
  const doc = await vscode.workspace.openTextDocument(knowledgeContentUri(area, key));
  await vscode.window.showTextDocument(doc, { preview: false });
}

async function closeNavigationSidebar(): Promise<void> {
  await vscode.commands.executeCommand("workbench.action.closeSidebar");
}

function openChatroomPanel(context: vscode.ExtensionContext): void {
  const chatPanel = getOrCreatePanel(context);
  chatPanel.reveal(vscode.ViewColumn.One);
  if (_panelReady) chatPanel.webview.postMessage({ command: "openTab", tab: "chatroom" });
  else _pendingTab = "chatroom";
}

type KnowledgeMarkdownArea = "skills" | "notes" | "papers";

function knowledgeMarkdownInfo(uri: vscode.Uri): { area: KnowledgeMarkdownArea; key: string; category: string } | undefined {
  if (uri.scheme === "pkm-content" && ["skills", "notes", "papers"].includes(uri.authority)) {
    const key = uri.path.replace(/^\//, "").replace(/\.md$/i, "");
    const category = key.includes("/") ? key.slice(0, key.lastIndexOf("/")) : "";
    return { area: uri.authority as KnowledgeMarkdownArea, key, category };
  }
  if (uri.scheme !== "file" || path.extname(uri.fsPath).toLowerCase() !== ".md") return undefined;
  const store = path.resolve(getStorePath());
  const rel = path.relative(store, path.resolve(uri.fsPath)).split(path.sep).join("/");
  if (rel.startsWith("../") || path.isAbsolute(rel)) return undefined;
  const match = /^(skills|notes|papers)\/(.+)\.md$/i.exec(rel);
  if (!match) return undefined;
  const area = match[1].toLowerCase() as KnowledgeMarkdownArea;
  const key = match[2];
  const category = key.includes("/") ? key.slice(0, key.lastIndexOf("/")) : "";
  return { area, key, category };
}

class KnowledgeMetadataCodeLensProvider implements vscode.CodeLensProvider {
  provideCodeLenses(document: vscode.TextDocument): vscode.CodeLens[] {
    const info = knowledgeMarkdownInfo(document.uri);
    if (!info) return [];
    const range = new vscode.Range(0, 0, 0, 0);
    return [
      new vscode.CodeLens(range, { command: "personalKnowledge.editMarkdownContent", title: "$(edit) Edit Content", arguments: [info.area, info.key] }),
      new vscode.CodeLens(range, { command: "personalKnowledge.editMarkdownMetadata", title: "$(settings-gear) Edit Metadata", arguments: [document.uri] }),
    ];
  }
}

class KnowledgeContentFileSystem implements vscode.FileSystemProvider {
  private readonly changed = new vscode.EventEmitter<vscode.FileChangeEvent[]>();
  readonly onDidChangeFile = this.changed.event;
  watch(): vscode.Disposable { return new vscode.Disposable(() => undefined); }
  stat(uri: vscode.Uri): vscode.FileStat {
    const info = knowledgeMarkdownInfo(uri);
    if (!info || !this.get(info)) throw vscode.FileSystemError.FileNotFound(uri);
    return { type: vscode.FileType.File, ctime: 0, mtime: Date.now(), size: Buffer.byteLength(this.get(info).content || "") };
  }
  readDirectory(): [string, vscode.FileType][] { return []; }
  createDirectory(): void { throw vscode.FileSystemError.NoPermissions("Directories are not supported."); }
  readFile(uri: vscode.Uri): Uint8Array {
    const info = knowledgeMarkdownInfo(uri);
    const item = info && this.get(info);
    if (!info || !item) throw vscode.FileSystemError.FileNotFound(uri);
    return Buffer.from(item.content || "", "utf8");
  }
  writeFile(uri: vscode.Uri, content: Uint8Array): void {
    const info = knowledgeMarkdownInfo(uri);
    const item = info && this.get(info);
    if (!info || !item) throw vscode.FileSystemError.FileNotFound(uri);
    const body = Buffer.from(content).toString("utf8");
    if (info.area === "skills") skillUpsert({ ...item, name: item.name, content: body, tags: JSON.parse(item.tags || "[]") });
    else if (info.area === "notes") noteUpsert({ ...item, slug: item.slug, content: body, tags: JSON.parse(item.tags || "[]") });
    else paperUpsert({ ...item, slug: item.slug, content: body });
    gitCommit(`edit(content): ${info.area}/${info.key}`);
    this.changed.fire([{ type: vscode.FileChangeType.Changed, uri }]);
    _treeProvider?.refresh();
    panel?.webview.postMessage({ command: "reloaded" });
  }
  delete(): void { throw vscode.FileSystemError.NoPermissions("Delete from the Knowledge tree instead."); }
  rename(): void { throw vscode.FileSystemError.NoPermissions("Rename with Edit Metadata instead."); }
  private get(info: { area: KnowledgeMarkdownArea; key: string }): any {
    if (info.area === "skills") {
      const listed = (skillList() as any[]).find(item => (item.category ? `${item.category}/${item.name}` : item.name) === info.key);
      return listed ? skillGet(listed.name) : undefined;
    }
    return info.area === "notes" ? noteGet(info.key) : paperGet(info.key);
  }
}

async function editMarkdownMetadata(uri?: vscode.Uri): Promise<void> {
  const document = uri ? vscode.workspace.textDocuments.find(d => d.uri.toString() === uri.toString())
    ?? await vscode.workspace.openTextDocument(uri) : vscode.window.activeTextEditor?.document;
  if (!document) return;
  const info = knowledgeMarkdownInfo(document.uri);
  if (!info) { vscode.window.showInformationMessage("This is not a Personal Knowledge Manager Markdown file."); return; }
  if (document.isDirty && !(await document.save())) return;

  let current: any;
  if (info.area === "skills") {
    const listed = (skillList() as any[]).find(s => {
      const key = s.category ? `${s.category}/${s.name}` : s.name;
      return key === info.key;
    });
    current = skillGet(listed?.name || path.basename(info.key));
  } else if (info.area === "notes") current = noteGet(info.key);
  else current = paperGet(info.key);
  if (!current) { vscode.window.showWarningMessage("Knowledge metadata could not be read from disk."); return; }

  const oldTitle = info.area === "skills" ? current.name : current.title;
  const title = await vscode.window.showInputBox({
    title: "Edit Knowledge Metadata (1/4)", prompt: info.area === "skills" ? "Name" : "Title", value: oldTitle,
    validateInput: value => !value.trim() ? "Title is required" : /[\\/]/.test(value) ? "Title cannot contain slashes" : null,
  });
  if (title === undefined) return;
  const description = await vscode.window.showInputBox({
    title: "Edit Knowledge Metadata (2/4)", prompt: "Description", value: current.description || "",
  });
  if (description === undefined) return;
  const oldTags = Array.isArray(current.tags) ? current.tags : JSON.parse(current.tags || "[]");
  const tagsText = await vscode.window.showInputBox({
    title: "Edit Knowledge Metadata (3/4)", prompt: "Tags (comma-separated)", value: oldTags.join(", "),
  });
  if (tagsText === undefined) return;
  const category = await selectKnowledgeFolder(info.area, info.category);
  if (category === undefined) return;
  const cleanTitle = title.trim();
  const cleanCategory = category.split(/[\\/]/).map(part => part.trim()).filter(Boolean).join("/");
  const tags = tagsText.split(",").map(tag => tag.trim()).filter(Boolean);

  if (info.area === "skills") {
    const collision = skillGet(cleanTitle);
    const safeTitle = storeSafeName(cleanTitle);
    const destinationKey = cleanCategory ? `${cleanCategory}/${safeTitle}` : safeTitle;
    const destinationExists = destinationKey !== info.key && fs.existsSync(path.join(getStorePath(), "skills", `${destinationKey}.md`));
    if ((cleanTitle !== current.name && collision) || destinationExists) {
      vscode.window.showWarningMessage(`A skill file already exists at "${destinationKey}.md". No files were changed.`);
      return;
    }
    skillUpsert({
      name: cleanTitle, content: current.content, category: cleanCategory,
      description: description.trim(), tags, source_project: current.source_project,
    });
    if (cleanTitle !== current.name) skillDelete(current.name);
  } else if (info.area === "notes") {
    const safeTitle = storeSafeName(cleanTitle);
    const newKey = cleanCategory ? `${cleanCategory}/${safeTitle}` : safeTitle;
    if (newKey !== current.slug && noteGet(newKey)) { vscode.window.showWarningMessage(`Note already exists: ${newKey}`); return; }
    noteUpsert({
      slug: current.slug, title: cleanTitle, content: current.content, type: current.type,
      tags, category: cleanCategory, pinned: current.pinned, description: description.trim(),
    });
  } else {
    const safeTitle = storeSafeName(cleanTitle);
    const newKey = cleanCategory ? `${cleanCategory}/${safeTitle}` : safeTitle;
    if (newKey !== current.slug && paperGet(newKey)) { vscode.window.showWarningMessage(`Paper or idea already exists: ${newKey}`); return; }
    paperUpsert({ ...current, slug: current.slug, title: cleanTitle, description: description.trim(), tags, category: cleanCategory });
  }

  const safeTitle = storeSafeName(cleanTitle);
  const newKey = cleanCategory ? `${cleanCategory}/${safeTitle}` : safeTitle;
  gitCommit(`metadata(${info.area}): ${info.key} -> ${newKey}`);
  _treeProvider?.refresh();
  panel?.webview.postMessage({ command: "reloaded" });
  const newUri = knowledgeContentUri(info.area, newKey);
  const newDocument = await vscode.workspace.openTextDocument(newUri);
  await vscode.window.showTextDocument(newDocument, { preview: false });
  vscode.window.setStatusBarMessage("$(check) Knowledge metadata updated", 3000);
}

function categoryFromTreeItem(item?: PkTreeItem): string {
  return (item?.nodeData?.path ?? []).filter((segment: string) => segment !== "(uncategorized)").join("/");
}

type KnowledgeFolderArea = "skills" | "notes" | "papers" | "scripts";
type KnowledgeFolderPick = vscode.QuickPickItem & { action: "select" | "parent" | "child" | "create" | "type"; name?: string };

async function selectKnowledgeFolder(area: KnowledgeFolderArea, initial = ""): Promise<string | undefined> {
  let current = initial.replace(/\\/g, "/").replace(/^\/+|\/+$/g, "");
  while (true) {
    const prefix = current ? `${current}/` : "";
    const children = [...new Set(folderList(area)
      .filter(folder => folder.startsWith(prefix))
      .map(folder => folder.slice(prefix.length).split("/")[0])
      .filter(Boolean))].sort((left, right) => left.localeCompare(right));
    const choices: KnowledgeFolderPick[] = [
      { label: "$(check) Select this folder", description: current || "Root", action: "select" },
    ];
    if (current) choices.push({ label: "$(arrow-left) Parent folder", description: current.slice(0, current.lastIndexOf("/")) || "Root", action: "parent" });
    for (const name of children) choices.push({ label: `$(folder) ${name}`, description: prefix + name, action: "child", name });
    choices.push(
      { label: "$(new-folder) New subfolder...", description: current || "Root", action: "create" },
      { label: "$(keyboard) Type a path...", description: "Enter a slash-separated path", action: "type" },
    );
    const picked = await vscode.window.showQuickPick(choices, {
      title: `Choose ${area === "papers" ? "Paper / Idea" : area[0].toUpperCase() + area.slice(1)} folder`,
      placeHolder: current ? `Current: ${current}` : "Current: Root",
    });
    if (!picked) return undefined;
    if (picked.action === "select") return current;
    if (picked.action === "parent") {
      current = current.includes("/") ? current.slice(0, current.lastIndexOf("/")) : "";
    } else if (picked.action === "child") {
      current = prefix + picked.name!;
    } else if (picked.action === "create") {
      const name = await vscode.window.showInputBox({
        title: "New subfolder", prompt: `Create inside ${current || "Root"}`,
        validateInput: value => !value.trim() ? "Folder name is required" : /[\\/]/.test(value) || value.trim() === "." || value.trim() === ".." ? "Enter one folder name" : null,
      });
      if (name === undefined) continue;
      const next = prefix + name.trim();
      if (!folderCreate(area, next)) { vscode.window.showErrorMessage(`Could not create folder: ${next}`); continue; }
      gitCommit(`add(folder): ${area}/${next}`);
      _treeProvider?.refresh();
      current = next;
    } else {
      const typed = await vscode.window.showInputBox({
        title: "Type folder path", prompt: "Slash-separated path; leave blank for Root", value: current,
        validateInput: value => value.split(/[\\/]/).some(part => part.trim() === "." || part.trim() === "..") ? "Path cannot contain '.' or '..'" : null,
      });
      if (typed === undefined) continue;
      const clean = typed.split(/[\\/]/).map(part => part.trim()).filter(Boolean).join("/");
      if (clean && !folderList(area).includes(clean) && !folderCreate(area, clean)) {
        vscode.window.showErrorMessage(`Could not create folder: ${clean}`);
        continue;
      }
      if (clean) gitCommit(`add(folder): ${area}/${clean}`);
      return clean;
    }
  }
}

async function createScriptAtFolder(folder: string): Promise<string | undefined> {
  const cleanFolder = await selectKnowledgeFolder("scripts", folder);
  if (cleanFolder === undefined) return undefined;
  const filename = await vscode.window.showInputBox({
    prompt: "New script filename (include extension)", placeHolder: "e.g. My New Query.script",
    validateInput: value => value?.trim() ? (/[\\/]/.test(value) ? "Filename cannot contain slashes" : null) : "Filename required",
  });
  if (!filename?.trim()) return undefined;
  const rel = cleanFolder ? `${cleanFolder}/${filename.trim()}` : filename.trim();
  const root = path.resolve(getStorePath(), "scripts");
  const full = path.resolve(root, rel);
  if (!full.startsWith(root + path.sep)) return undefined;
  if (fs.existsSync(full)) { vscode.window.showWarningMessage(`Script already exists: ${rel}`); return undefined; }
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, "");
  gitCommit(`add(script): ${rel}`);
  _treeProvider?.refresh();
  const document = await vscode.workspace.openTextDocument(vscode.Uri.file(full));
  await vscode.window.showTextDocument(document, { preview: false });
  return rel;
}

async function deleteScriptAtPath(relPath: string): Promise<boolean> {
  const root = path.resolve(getStorePath(), "scripts");
  const full = path.resolve(root, relPath);
  if (!full.startsWith(root + path.sep) || !fs.existsSync(full) || fs.statSync(full).isDirectory()) return false;
  const confirm = await vscode.window.showWarningMessage(
    `Delete script "${relPath}"? This removes the file and its AI-summary cache, and commits the deletion to git.`,
    { modal: true }, "Delete"
  );
  if (confirm !== "Delete") return false;
  fs.rmSync(full, { force: true });
  fs.rmSync(scriptCacheDir(relPath), { recursive: true, force: true });
  gitCommit(`delete(script): ${relPath}`);
  log.action("script.delete", { path: relPath });
  _treeProvider?.refresh();
  panel?.webview.postMessage({ command: "reloaded" });
  vscode.window.setStatusBarMessage("$(trash) Script deleted", 3000);
  return true;
}

// ── Chatroom orchestrator ──────────────────────────────────────────────────
// Owns the (optional self-hosted) hub and a set of room connections — one person
// can hold multiple rooms at once. Keeps a per-room in-session chat buffer plus
// received-file buffers (never written to disk unless the user saves them), and
// forwards live events to the webview chatroom tab.
interface RoomConn {
  key:     string;             // durable Room UUID when available; URL+name for legacy Rooms
  url:     string;
  room:    string;
  roomId?: string;
  user:    string;
  client:  ChatClient;
  messages: ChatMessage[];
  members:  Member[];
  status:   string;
  statusDetail: string;
  unread:   number;
  selfHost: boolean;   // this client is the room's host (can moderate)
  selfMuted: boolean;  // the host has muted this client
  agentStates: Record<string, AgentRuntimeState>;
  files:    Map<string, { meta: FileMeta; from: string; data: Buffer }>; // received, awaiting save
}

interface ManagedChatAgent {
  id: string;
  name: string;
  backend: AiBackend;
  role: string;
  systemPrompt: string;
  roomKey: string;
  client: ChatClient;
  messages: ChatMessage[];
  status: string;
  active: boolean;
  busy: boolean;
  generation: number;
}

interface HostedRoomNavigationItem {
  roomId: string;
  roomName: string;
  active: boolean;
  canRehost: boolean;
  unavailableReason?: string;
}

class ChatRoomManager {
  private hub:   ChatHub | undefined;
  private rooms: Map<string, RoomConn> = new Map();
  private hostedKeys: Map<string, string> = new Map();   // room -> secret this host set
  private activeKey = "";
  private managedAgents: Map<string, ManagedChatAgent> = new Map();
  private storedRooms: StoredChatRoom[] = [];
  private archiveDir = "";
  private persistenceRoot = "";
  private installationId = "";
  private secretStorage: vscode.SecretStorage | undefined;
  private approvalPrompted = new Set<string>();
  private approvalPromptTimer: NodeJS.Timeout | undefined;
  private archiveLimitBytes = 10 * 1024 * 1024;
  private static readonly MAX_MSGS = 5000;   // session display cap; the hub's byte budget is the real limit

  private static roomKey(url: string, room: string, roomId?: string): string {
    return chatRoomIdentity(url, room, roomId);
  }

  private static managedAgentPrompt(name: string, role: string): string {
    return [
      `You are ${name}, an expert participant in a multi-agent engineering discussion.`,
      `Your role and background: ${role}`,
      "Chatroom protocol: remain in standby while connected. Respond only to messages directed to you or @all, then return to standby. The host may disconnect you with /stop.",
      "Respond to the latest addressed message using relevant shared context. Ask focused questions when evidence is missing. Propose concrete next steps, challenge weak assumptions, and keep replies concise. Do not emit Chatroom slash commands.",
    ].join("\n");
  }

  private bindHub(hub: ChatHub): void {
    hub.onApprovalsChanged(() => {
      this.push();
      if (this.approvalPromptTimer) clearTimeout(this.approvalPromptTimer);
      this.approvalPromptTimer = setTimeout(() => {
        this.approvalPromptTimer = undefined;
        void this.promptNewApprovals();
      }, 200);
      this.approvalPromptTimer.unref?.();
    });
  }

  private async promptNewApprovals(): Promise<void> {
    for (const pending of this.hub?.pendingApprovals() || []) {
      if (this.approvalPrompted.has(pending.requestId)) continue;
      this.approvalPrompted.add(pending.requestId);
      const NEW = "New User", REUSE = "Reuse Identity", REJECT = "Reject";
      const actions = pending.reusableParticipants.length ? [NEW, REUSE, REJECT] : [NEW, REJECT];
      const pick = await vscode.window.showInformationMessage(
        `${pending.kind === "agent" ? "Agent" : pending.kind === "browser" ? "Browser user" : "User"} "${pending.alias}" wants to join Room "${this.roomNameForId(pending.roomId)}".`,
        ...actions,
      );
      if (!pick) continue;
      if (!this.pendingJoin(pending.requestId)) {
        vscode.window.showInformationMessage(`Join request from "${pending.alias}" is no longer pending.`);
        continue;
      }
      try {
        if (pick === NEW) await this.approveJoinNew(pending.requestId);
        else if (pick === REUSE) await this.pickAndApproveReuse(pending);
        else if (pick === REJECT) await this.rejectJoin(pending.requestId);
      } catch (error: any) {
        vscode.window.showErrorMessage(`Couldn't process Join request: ${error?.message || error}`);
      }
    }
  }

  private async pickAndApproveReuse(pending: PendingJoinApproval): Promise<void> {
    const picked = await vscode.window.showQuickPick(
      pending.reusableParticipants.map(participant => ({
        label: participant.previousAlias || participant.participantId.slice(0, 8),
        description: participant.kind,
        detail: `Room participant ${participant.participantId}`,
        participantId: participant.participantId,
      })),
      { title: `Reuse identity for ${pending.alias}`, placeHolder: "Choose an offline participant identity" },
    );
    if (picked) await this.approveJoinReuse(pending.requestId, picked.participantId);
  }

  private roomNameForId(roomId: string): string {
    return this.hub?.adminRooms().find(room => room.roomId === roomId)?.room || roomId.slice(0, 8);
  }

  /** Configure on-disk chat archiving (dir + byte cap). Applies to the live hub too. */
  configureArchive(dir: string, limitBytes: number): void {
    this.archiveDir = dir;
    this.archiveLimitBytes = limitBytes;
    this.hub?.configureArchive(dir, limitBytes);
  }

  configurePersistence(rootDir: string, installationId: string, secretStorage: vscode.SecretStorage): void {
    this.persistenceRoot = rootDir;
    this.installationId = installationId;
    this.secretStorage = secretStorage;
    this.hub?.configureLifecycle(rootDir, this.archiveLimitBytes, installationId, secretStorage);
    void this.refreshStoredRooms().catch(error => log.warn(`chat: couldn't refresh Stored Rooms: ${(error as Error).message}`));
  }

  get activeRoom(): RoomConn | undefined { return this.rooms.get(this.activeKey); }
  activateRoom(url: string, room: string, roomId?: string): boolean {
    const key = ChatRoomManager.roomKey(url, room, roomId);
    if (!this.rooms.has(key)) return false;
    this.setActive(key);
    return true;
  }
  activateRoomById(roomId: string): boolean {
    const room = [...this.rooms.values()].find(candidate => candidate.roomId === roomId);
    if (!room) return false;
    this.setActive(room.key);
    return true;
  }
  async closeHostedRoomById(roomId: string): Promise<void> {
    const room = [...this.rooms.values()].find(candidate => candidate.roomId === roomId);
    if (!room) throw new Error("The active hosted Room was not found.");
    await this.closeOrLeaveRoom(room.key);
  }
  get hubIsRunning(): boolean { return !!this.hub?.isRunning; }
  get hubPort(): number { return this.hub?.port ?? 0; }

  /** Push the full snapshot (room list + active room detail) to the webview. */
  push(): void {
    postToPanel({ command: "chatState", data: this.state() });
  }

  private roomSummary(r: RoomConn) {
    return { key: r.key, room: r.room, roomId: r.roomId, url: r.url, status: r.status, unread: r.unread, selfHost: r.selfHost };
  }

  state(): object {
    const active = this.activeRoom;
    return {
      rooms: [...this.rooms.values()].map(r => this.roomSummary(r)),
      activeKey: this.activeKey,
      active: active ? {
        key: active.key, room: active.room, url: active.url,
        status: active.status, statusDetail: active.statusDetail,
        members: active.members, messages: active.messages, self: active.user,
        selfHost: active.selfHost, selfMuted: active.selfMuted,
        hasRoomKey: !!this.getRoomKey(active.room),
        agentStates: active.agentStates,
        files: [...active.files.values()].map(f => ({ fileId: f.meta.fileId, name: f.meta.name, from: f.from, size: f.meta.size })),
      } : null,
      hubRunning: !!this.hub?.isRunning,
      hubUrl:     this.hub?.isRunning ? `ws://${ChatHub.localIp()}:${this.hub.port}` : "",
      hubHttpUrl: this.hub?.isRunning ? `http://${ChatHub.localIp()}:${this.hub.port}` : "",
      hubPort:    this.hub?.port ?? 0,
      hubAdminRooms: this.hub?.isRunning
        ? this.hub.adminRooms().map(r => ({ ...r, hasKey: this.hostedKeys.has(r.room) }))
        : [],
      pendingApprovals: this.hub?.pendingApprovals() || [],
      storedRooms: this.storedRooms,
      managedAgents: [...this.managedAgents.values()].map(agent => ({
        id: agent.id, name: agent.name, role: agent.role, backend: agent.backend.label,
        roomKey: agent.roomKey, status: agent.status,
        active: agent.active, busy: agent.busy,
      })),
    };
  }

  hostedRoomsForNavigation(): HostedRoomNavigationItem[] {
    const active = new Map(this.hub?.adminRooms().map(room => [room.roomId, room]) || []);
    const rows: HostedRoomNavigationItem[] = [...active.values()].map(room => ({
      roomId: room.roomId, roomName: room.room, active: true, canRehost: true,
    }));
    for (const stored of this.storedRooms) {
      if (active.has(stored.roomId)) continue;
      rows.push({ roomId: stored.roomId, roomName: stored.roomName, active: false,
        canRehost: stored.canRehost, unavailableReason: stored.unavailableReason });
    }
    return rows.sort((left, right) => left.roomName.localeCompare(right.roomName));
  }

  async addManagedAgent(context: vscode.ExtensionContext): Promise<void> {
    const room = this.activeRoom;
    if (!room || !room.selfHost) {
      vscode.window.showWarningMessage("Host and open a room before adding a managed agent.");
      return;
    }
    const secret = this.getRoomKey(room.room);
    if (!secret) {
      vscode.window.showWarningMessage(`No host secret is available for room "${room.room}".`);
      return;
    }
    const backends = await listAiBackends(context);
    if (!backends.length) {
      vscode.window.showWarningMessage("No AI backend is available. Sign in to Copilot or configure an AI endpoint.");
      return;
    }
    const picked = await vscode.window.showQuickPick(
      backends.map(backend => ({ label: backend.label, backend })),
      { placeHolder: "Model for this Chatroom agent" },
    );
    if (!picked) return;
    const name = (await vscode.window.showInputBox({
      prompt: "Agent display name", placeHolder: "DockerAgent",
      validateInput: value => value.trim() ? undefined : "Enter a unique agent name",
    }))?.trim();
    if (!name) return;
    if ([...this.managedAgents.values()].some(agent => agent.roomKey === room.key && agent.name.toLowerCase() === name.toLowerCase())) {
      vscode.window.showWarningMessage(`Managed agent "${name}" already exists in this room.`);
      return;
    }
    const role = (await vscode.window.showInputBox({
      prompt: `Role and background for ${name}`,
      placeHolder: "Owns Docker build, deployment, and container test workflows",
    }))?.trim() || "Contribute your expertise, ask clarifying questions, and critique proposals constructively.";
    this.createManagedAgent(context, room, secret, name, picked.backend, role);
  }

  private createManagedAgent(
    context: vscode.ExtensionContext,
    room: RoomConn,
    secret: string,
    name: string,
    backend: AiBackend,
    role: string,
  ): void {
    const id = randomBytes(6).toString("hex");
    const agent: ManagedChatAgent = {
      id, name, backend, role, roomKey: room.key, client: null as any,
      systemPrompt: ChatRoomManager.managedAgentPrompt(name, role),
      messages: [], status: "connecting", active: true, busy: false, generation: 0,
    };
    agent.client = new ChatClient({
      onStatus: (status, detail) => {
        agent.status = detail ? `${status}: ${detail}` : status;
        if (status === "connected") agent.client.sendAgentState("standby");
        if (status === "disconnected") {
          agent.active = false;
          agent.busy = false;
          agent.generation++;
        }
        this.push();
      },
      onMessage: message => this.onManagedAgentMessage(context, agent, message),
      onHistory: messages => { agent.messages = messages.slice(-80); },
      onPresence: () => {}, onFileComplete: () => {}, onAgentState: () => {},
      onRejected: (_code, message) => { agent.status = `error: ${message}`; agent.active = false; this.push(); },
      onJoinPending: requestId => {
        this.approvalPrompted.add(requestId);
        void this.approveJoinNew(requestId).catch(error => {
          agent.status = `error: ${(error as Error).message}`;
          agent.active = false;
          this.push();
        });
      },
      onRenamed: newName => { agent.name = newName; this.push(); },
      onRekey: () => {},
    }, message => log.debug(`managed-agent[${name}]: ${message}`));
    this.managedAgents.set(id, agent);
    agent.client.connect({ url: room.url, room: room.room, roomId: room.roomId, user: name, token: secret, kind: "agent", cid: `managed-${id}` });
    log.action("chat.managedAgent.add", { room: room.room, name, backend: backend.id });
    this.push();
  }

  private messageMentions(text: string, name: string): boolean {
    const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    return /@(all|everyone)\b/i.test(text) || new RegExp(`@(?:"${escaped}"|${escaped})(?=\\s|$|[,.!?;:])`, "i").test(text);
  }

  private ensureDirectedReply(text: string, target: string): string {
    const value = text.trim();
    if (/@(?:"[^"\n]{1,60}"|[\p{L}\p{N}_][\p{L}\p{N}_-]{0,59})/u.test(value)) return value;
    const cleaned = target.replace(/"/g, "").trim() || "Host";
    const mention = /^[A-Za-z0-9_][\w-]{0,59}$/.test(cleaned) ? `@${cleaned}` : `@"${cleaned}"`;
    return `${mention} ${value}`;
  }

  private async onManagedAgentMessage(context: vscode.ExtensionContext, agent: ManagedChatAgent, message: ChatMessage): Promise<void> {
    if (message.id && agent.messages.some(existing => existing.id === message.id)) return;
    agent.messages.push(message);
    if (agent.messages.length > 80) agent.messages.splice(0, agent.messages.length - 80);
    const text = String(message.text || "").trim();
    const low = text.toLowerCase();
    if (!agent.active || agent.busy || message.from.toLowerCase() === agent.name.toLowerCase()) return;
    const directed = this.messageMentions(text, agent.name);
    if (!directed) return;
    const generation = agent.generation;
    agent.busy = true;
    agent.client.sendAgentState("thinking");
    this.push();
    try {
      const transcript = agent.messages.slice(-30)
        .filter(item => !item.system)
        .map(item => `${item.from || "system"}: ${item.text}`)
        .join("\n");
      const prompt = `${agent.systemPrompt}\n\nChatroom transcript:\n${transcript}\n\nReply as ${agent.name} to the latest turn. Return only the message to post.`;
      const reply = await runAiPrompt(context, agent.backend, prompt);
      if (agent.generation === generation && reply.trim()) {
        const replyTarget = message.from === BOT_NAME
          ? [...agent.messages].reverse().find(item => item.from && item.from !== BOT_NAME && item.from.toLowerCase() !== agent.name.toLowerCase())?.from || "Host"
          : message.from || "Host";
        agent.client.sendAgentState("sending");
        agent.client.sendText(this.ensureDirectedReply(reply, replyTarget));
      }
    } catch (error: any) {
      if (agent.generation === generation) agent.client.sendText(`@Host I could not respond: ${error?.message || String(error)}`);
      log.error(`managed agent ${agent.name} failed: ${error?.message || error}`);
    } finally {
      if (agent.generation === generation) agent.busy = false;
      if (agent.generation === generation) agent.client.sendAgentState(agent.active ? "standby" : "idle");
      this.push();
    }
  }

  removeManagedAgent(id: string): void {
    const agent = this.managedAgents.get(id);
    if (!agent) return;
    agent.active = false; agent.generation++;
    const room = this.rooms.get(agent.roomKey);
    const target = `cid:managed-${agent.id}:${agent.name.trim().toLowerCase()}`;
    if (!room?.selfHost || !room.client.sendAdmin("kick", target)) {
      try { agent.client.disconnect(); } catch { /* ignore */ }
    }
    this.managedAgents.delete(id);
    log.action("chat.managedAgent.remove", { name: agent.name });
    this.push();
  }

  editManagedAgent(id: string, name: string, role: string): void {
    const agent = this.managedAgents.get(id);
    if (!agent) return;
    const nextName = name.trim().slice(0, 60);
    const nextRole = role.trim().slice(0, 120);
    if (!nextName) return;
    const duplicate = [...this.managedAgents.values()].some(other => other.id !== id && other.roomKey === agent.roomKey && other.name.toLowerCase() === nextName.toLowerCase());
    if (duplicate) { vscode.window.showWarningMessage(`Managed agent "${nextName}" already exists in this room.`); return; }
    const room = this.rooms.get(agent.roomKey);
    const target = agent.client.participantId
      ? `participant:${agent.client.participantId}`
      : `cid:managed-${agent.id}:${agent.name.trim().toLowerCase()}`;
    if (!room?.selfHost || !room.client.sendAdmin("edit", target, nextName, nextRole)) {
      vscode.window.showWarningMessage("Reconnect the hosted room before editing this managed agent.");
      return;
    }
    agent.name = nextName;
    agent.role = nextRole;
    agent.systemPrompt = ChatRoomManager.managedAgentPrompt(nextName, nextRole);
    log.action("chat.managedAgent.edit", { name: nextName, role: nextRole });
    this.push();
  }

  joinRoom(opts: { url: string; room: string; roomId?: string; user: string; token: string; cid?: string; hostToken?: string }): void {
    const key = ChatRoomManager.roomKey(opts.url, opts.room, opts.roomId);
    let rc = this.rooms.get(key);
    if (opts.roomId) {
      const sameRoom = [...this.rooms.values()].filter(item => item.roomId === opts.roomId);
      if (!rc && sameRoom.length) {
        rc = sameRoom[0];
        const previousKey = rc.key;
        this.rooms.delete(previousKey);
        rc.key = key;
        for (const agent of this.managedAgents.values()) {
          if (agent.roomKey === previousKey) agent.roomKey = key;
        }
        if (this.activeKey === previousKey) this.activeKey = key;
        this.rooms.set(key, rc);
      }
      for (const duplicate of sameRoom) {
        if (duplicate === rc) continue;
        try { duplicate.client.disconnect(); } catch { /* ignore */ }
        this.rooms.delete(duplicate.key);
        if (this.activeKey === duplicate.key) this.activeKey = key;
        for (const [id, agent] of this.managedAgents) {
          if (agent.roomKey === duplicate.key) { try { agent.client.disconnect(); } catch { /* ignore */ } this.managedAgents.delete(id); }
        }
      }
    }
    if (rc) {
      rc.url = opts.url; rc.room = opts.room; rc.user = opts.user; rc.roomId = opts.roomId ?? rc.roomId;
      rc.client.connect({ ...opts, kind: "human" }); this.setActive(key); return;
    }

    rc = {
      key, url: opts.url, room: opts.room, roomId: opts.roomId, user: opts.user,
      client: null as any, messages: [], members: [], status: "connecting", statusDetail: "",
      unread: 0, selfHost: false, selfMuted: false, agentStates: {}, files: new Map(),
    };
    rc.client = new ChatClient(
      {
        onStatus:   (s, d) => { rc!.status = s; rc!.statusDetail = d ?? ""; this.push(); },
        onMessage:  m => this.addMessage(rc!, m),
        onHistory:  ms => { rc!.messages = ms.slice(-ChatRoomManager.MAX_MSGS); if (rc!.key === this.activeKey) this.push(); },
        onPresence: mm => {
          rc!.members = mm;
          const me = mm.find(x => x.participantId && x.participantId === rc!.client.participantId);
          rc!.selfHost = !!me?.host;
          rc!.selfMuted = !!me?.muted;
          this.push();
        },
        onAgentState: (user, state) => {
          rc!.agentStates[user] = state;
          postToPanel({ command: "chatAgentState", data: { key: rc!.key, user, state } });
        },
        onReadReceipt: (messageId, read, total) => this.updateReadReceipt(rc!, messageId, read, total),
        onFileComplete: (meta, from, data) => this.onFileReceived(rc!, meta, from, data),
        onRejected: (code, m) => this.onJoinRejected(rc!, code, m),
        onRenamed:  name => { rc!.user = name; this.push(); },
        onRekey:    secret => this.onRekey(rc!, secret),
      },
      m => log.debug(`chat[${rc!.room}]: ${m}`)
    );
    this.rooms.set(key, rc);
    this.activeKey = key;
    rc.client.connect({ ...opts, kind: "human" });
    log.action("chat.join", { room: opts.room, user: opts.user });
  }

  async closeOrLeaveRoom(key: string): Promise<void> {
    const rc = this.rooms.get(key);
    if (!rc) return;
    const locallyHosted = !!this.hub?.adminRooms().some(room =>
      (rc.roomId && room.roomId === rc.roomId) || (!rc.roomId && room.room === ChatHub.canonRoom(rc.room)));
    if (locallyHosted && this.hub?.isRunning) {
      await this.hub.adminCloseRoom(rc.room);
    } else {
      try { rc.client.disconnect(); } catch { /* ignore */ }
    }
    this.rooms.delete(key);
    if (this.activeKey === key) this.activeKey = this.rooms.keys().next().value ?? "";
    if (locallyHosted) await this.refreshStoredRooms();
    log.action(locallyHosted ? "chat.closeRoom" : "chat.leave", { room: rc.room, roomId: rc.roomId });
    this.push();
  }

  async renameActiveRoom(roomId: string, roomName: string): Promise<void> {
    if (!this.hub?.isRunning) throw new Error("The Chat Hub is not running.");
    const rc = [...this.rooms.values()].find(room => room.roomId === roomId);
    if (!rc) throw new Error("The active Room connection was not found.");
    const previousKey = rc.key;
    const previousRoom = rc.room;
    const nextRoom = await this.hub.renameActiveRoom(roomId, roomName);
    const nextKey = ChatRoomManager.roomKey(rc.url, nextRoom, roomId);
    this.rooms.delete(previousKey);
    rc.room = nextRoom;
    rc.key = nextKey;
    this.rooms.set(nextKey, rc);
    const secret = this.hostedKeys.get(ChatHub.canonRoom(previousRoom));
    this.hostedKeys.delete(ChatHub.canonRoom(previousRoom));
    if (secret) this.hostedKeys.set(ChatHub.canonRoom(nextRoom), secret);
    for (const agent of this.managedAgents.values()) if (agent.roomKey === previousKey) agent.roomKey = nextKey;
    if (this.activeKey === previousKey) this.activeKey = nextKey;
    _treeProvider?.refresh();
    this.push();
  }

  setActive(key: string): void {
    if (!this.rooms.has(key)) return;
    this.activeKey = key;
    const rc = this.rooms.get(key)!;
    rc.unread = 0;
    this.push();
  }

  private addMessage(rc: RoomConn, m: ChatMessage): void {
    // Ignore a message we already have by id (e.g. history backfill overlapping a
    // live echo on reconnect) so previously-saved messages never pile up.
    if (m.id && rc.messages.some(x => x.id === m.id)) return;
    rc.messages.push(m);
    if (rc.messages.length > ChatRoomManager.MAX_MSGS) rc.messages.splice(0, rc.messages.length - ChatRoomManager.MAX_MSGS);
    if (rc.key === this.activeKey) {
      postToPanel({ command: "chatMessage", data: { key: rc.key, message: m } });
    } else {
      if (!m.system) rc.unread++;
      this.push();
    }
  }

  private updateReadReceipt(rc: RoomConn, messageId: string, read: number, total: number): void {
    const message = rc.messages.find(item => item.id === messageId);
    if (!message) return;
    message.receipt = { read, total };
    postToPanel({ command: "chatReadReceipt", data: { key: rc.key, messageId, read, total } });
  }

  private onFileReceived(rc: RoomConn, meta: FileMeta, from: string, data: Buffer): void {
    rc.files.set(meta.fileId, { meta, from, data });
    postToPanel({ command: "chatFileReady", data: { key: rc.key, fileId: meta.fileId, name: meta.name, from, size: meta.size } });
    if (rc.key === this.activeKey) this.push();
    log.action("chat.fileReceived", { room: rc.room, name: meta.name, size: meta.size });
  }

  // The Hub has already persisted this rotation. Refresh live invite actions;
  // durable hosted Rooms never copy their secret into globalState recents.
  private onRekey(rc: RoomConn, secret: string): void {
    this.hostedKeys.set(ChatHub.canonRoom(rc.room), secret);
    saveRekeyedSecret(rc.url, rc.room, secret, rc.roomId);
    this.push();
    log.action("chat.rekey", { room: rc.room });
  }

  // Terminal join failure (bad secret or duplicate name): drop the room and tell
  // the user so they can fix the name/secret and re-join.
  private onJoinRejected(rc: RoomConn, code: string, msg: string): void {
    try { rc.client.disconnect(); } catch { /* ignore */ }
    this.rooms.delete(rc.key);
    if (this.activeKey === rc.key) this.activeKey = this.rooms.keys().next().value ?? "";
    postToPanel({ command: "chatToast", data: { error: msg } });
    this.push();
    log.action("chat.joinRejected", { room: rc.room, code });
  }

  send(text: string, responseRequired?: boolean): boolean {
    const rc = this.activeRoom;
    return rc ? rc.client.sendText(text, responseRequired) : false;
  }

  /** Host-only: moderate a member in the active room. Target identified by its
   *  stable identity (sid) when available, else by display name. */
  moderate(action: "kick" | "mute" | "unmute" | "rename" | "edit", target: { participantId?: string; sid?: string; user: string }, name?: string, role?: string): void {
    const rc = this.activeRoom;
    if (!rc) return;
    const key = target.participantId
      ? `participant:${target.participantId}`
      : target.sid
        ? `cid:${target.sid}:${(target.user || "").trim().toLowerCase()}`
        : `name:${(target.user || "").trim().toLowerCase()}`;
    rc.client.sendAdmin(action, key, name, role);
  }

  /** Rename yourself in the active room. Allowed for any member; the hub rejects
   *  it if the new alias duplicates another present member. */
  renameSelf(newName: string): void {
    const rc = this.activeRoom;
    if (!rc) return;
    const nn = (newName || "").trim().slice(0, 60);
    if (!nn) return;
    const id = rc.client.identity;
    const selfKey = id ? `cid:${id}:${rc.user.trim().toLowerCase()}` : `name:${rc.user.trim().toLowerCase()}`;
    rc.client.sendAdmin("rename", selfKey, nn);
  }

  /** Your current display name in the active room ("" if none). */
  get selfName(): string { return this.activeRoom?.user ?? ""; }

  async sendFileToActive(): Promise<void> {
    const rc = this.activeRoom;
    if (!rc || !rc.client.isConnected) { vscode.window.showWarningMessage("Join a room before sharing a file."); return; }
    const picks = await vscode.window.showOpenDialog({ canSelectMany: false, openLabel: "Share to room" });
    if (!picks || !picks.length) return;
    const fsPath = picks[0].fsPath;
    try {
      const stat = fs.statSync(fsPath);
      if (stat.size > MAX_FILE_BYTES) { vscode.window.showErrorMessage(`File too large (max ${MAX_FILE_BYTES / 1024 / 1024} MB).`); return; }
      const data = fs.readFileSync(fsPath);
      const res = await rc.client.sendFile(path.basename(fsPath), "application/octet-stream", data);
      if (!res.ok) vscode.window.showErrorMessage(`Share failed: ${res.error}`);
      else log.action("chat.fileSent", { room: rc.room, name: path.basename(fsPath), size: stat.size });
    } catch (e: any) {
      vscode.window.showErrorMessage(`Share failed: ${e?.message ?? e}`);
    }
  }

  async saveReceivedFile(key: string, fileId: string): Promise<void> {
    const rc = this.rooms.get(key);
    const rec = rc?.files.get(fileId);
    if (!rec) { vscode.window.showWarningMessage("This file is no longer available (peers must be online to receive it)."); return; }
    const target = await vscode.window.showSaveDialog({ defaultUri: vscode.Uri.file(path.join(os.homedir(), rec.meta.name)), saveLabel: "Save shared file" });
    if (!target) return;
    try {
      fs.writeFileSync(target.fsPath, rec.data);
      vscode.window.showInformationMessage(`Saved ${rec.meta.name}`);
      log.action("chat.fileSaved", { name: rec.meta.name });
    } catch (e: any) {
      vscode.window.showErrorMessage(`Save failed: ${e?.message ?? e}`);
    }
  }

  /** Export the active room's transcript to a Markdown or JSON file. */
  async exportActive(): Promise<void> {
    const rc = this.activeRoom;
    if (!rc || !rc.messages.length) { vscode.window.showWarningMessage("No messages to export in this room."); return; }
    const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
    const base  = `chatroom-${rc.room}-${stamp}`;
    const target = await vscode.window.showSaveDialog({
      defaultUri: vscode.Uri.file(path.join(os.homedir(), `${base}.md`)),
      filters: { Markdown: ["md"], JSON: ["json"] },
      saveLabel: "Download transcript",
    });
    if (!target) return;
    try {
      const isJson = target.fsPath.toLowerCase().endsWith(".json");
      const doc = isJson
        ? JSON.stringify({ room: rc.room, url: rc.url, exportedAt: new Date().toISOString(), messages: rc.messages }, null, 2)
        : this.toMarkdown(rc);
      fs.writeFileSync(target.fsPath, doc, "utf-8");
      vscode.window.showInformationMessage(`Transcript saved: ${path.basename(target.fsPath)}`);
      log.action("chat.export", { room: rc.room, count: rc.messages.length });
    } catch (e: any) {
      vscode.window.showErrorMessage(`Export failed: ${e?.message ?? e}`);
    }
  }

  private toMarkdown(rc: RoomConn): string {
    const lines: string[] = [`# Chatroom: ${rc.room}`, "", `_Exported ${new Date().toLocaleString()} · ${rc.messages.length} messages_`, ""];
    for (const m of rc.messages) {
      const t = new Date(m.ts).toLocaleTimeString();
      if (m.system) { lines.push(`> _${m.text}_  \`${t}\``, ""); continue; }
      const who = `${m.kind === "agent" ? "🤖 " : ""}${m.from}`;
      lines.push(`**${who}** · \`${t}\``, "", m.text, "");
    }
    return lines.join("\n");
  }

  async startHub(port: number): Promise<{ ok: boolean; wsUrl?: string; httpUrl?: string; error?: string }> {
    try {
      if (!this.hub) {
        this.hub = new ChatHub(m => log.info(m));
        this.bindHub(this.hub);
      }
      this.hub.configureArchive(this.archiveDir, this.archiveLimitBytes);
      if (this.secretStorage && this.installationId) {
        this.hub.configureLifecycle(this.persistenceRoot, this.archiveLimitBytes, this.installationId, this.secretStorage);
      } else {
        this.hub.configurePersistence(this.persistenceRoot, this.archiveLimitBytes);
      }
      if (this.hub.isRunning) {
        const ip0 = ChatHub.localIp();
        return { ok: true, wsUrl: `ws://${ip0}:${this.hub.port}`, httpUrl: `http://${ip0}:${this.hub.port}` };
      }
      log.info(`chat: starting hub on port ${port}`);
      try {
        await this.hub.start(port);
      } catch (e: any) {
        // If the preferred port is busy, fall back to an OS-assigned free port
        // so a stale/duplicate hub never blocks hosting.
        if (e?.code === "EADDRINUSE" && port !== 0) {
          log.warn(`chat: port ${port} busy — retrying on an ephemeral port`);
          await this.hub.start(0);
        } else {
          throw e;
        }
      }
      const ip = ChatHub.localIp();
      const wsUrl = `ws://${ip}:${this.hub.port}`;
      const httpUrl = `http://${ip}:${this.hub.port}`;
      log.info(`chat: hub ready — join URL ${wsUrl} · browser view ${httpUrl}`);
      log.action("chat.startHub", { port: this.hub.port });
      this.push();
      return { ok: true, wsUrl, httpUrl };
    } catch (e: any) {
      const detail = e?.message || String(e);
      log.error(`chat.startHub failed (port ${port}): code=${e?.code ?? "?"} ${detail}`);
      if (e?.stack) log.error(e.stack);
      return { ok: false, error: detail };
    }
  }

  async refreshStoredRooms(): Promise<void> {
    if (!this.persistenceRoot || !this.installationId || !this.secretStorage) return;
    if (!this.hub) {
      this.hub = new ChatHub(m => log.info(m));
      this.bindHub(this.hub);
      this.hub.configureArchive(this.archiveDir, this.archiveLimitBytes);
      this.hub.configureLifecycle(this.persistenceRoot, this.archiveLimitBytes, this.installationId, this.secretStorage);
    }
    this.storedRooms = await this.hub.listStoredRooms();
    _treeProvider?.refresh();
    this.push();
  }

  async renameStoredRoom(roomId: string, roomName: string): Promise<void> {
    await this.hub?.renameStoredRoom(roomId, roomName);
    await this.refreshStoredRooms();
  }

  async deleteStoredRoom(roomId: string): Promise<void> {
    await this.hub?.deleteStoredRoom(roomId);
    await this.refreshStoredRooms();
  }

  async createHostedRoom(room: string, requestedSecret?: string): Promise<{ roomId: string; room: string; secret: string; hostToken: string }> {
    if (!this.hub?.isRunning) throw new Error("Start the Chat Hub before creating a Room.");
    const created = await this.hub.createRoom(room, requestedSecret);
    this.hostedKeys.set(created.room, created.secret);
    await this.refreshStoredRooms();
    this.push();
    return created;
  }

  async rehostRoom(roomId: string): Promise<{ roomId: string; room: string; secret: string; hostToken: string }> {
    if (!this.hub?.isRunning) throw new Error("Start the Chat Hub before Rehosting a Room.");
    const rehosted = await this.hub.rehostRoom(roomId);
    this.hostedKeys.set(rehosted.room, rehosted.secret);
    await this.refreshStoredRooms();
    this.push();
    return rehosted;
  }

  async stopHub(): Promise<void> {
    await this.hub?.stop();
    this.hostedKeys.clear();
    await this.refreshStoredRooms();
    log.action("chat.stopHub");
    this.push();
  }

  async adminCloseRoom(room: string): Promise<void> {
    await this.hub?.adminCloseRoom(room);
    this.hostedKeys.delete(ChatHub.canonRoom(room));
    await this.refreshStoredRooms();
    log.action("chat.adminCloseRoom", { room });
    this.push();
  }

  /** Rotate a hosted room's secret on demand. The rekey flows back via onRekey. */
  async rotateRoomSecret(room: string): Promise<boolean> {
    const s = await this.hub?.rotateRoomSecret(room);
    if (s) {
      this.hostedKeys.set(ChatHub.canonRoom(room), s);
      const active = [...this.rooms.values()].find(connection => ChatHub.canonRoom(connection.room) === ChatHub.canonRoom(room));
      if (active) saveRekeyedSecret(active.url, active.room, s);
      log.action("chat.rotateSecret", { room });
    }
    return !!s;
  }

  async adminCloseAll(): Promise<void> {
    await this.hub?.adminCloseAll();
    this.hostedKeys.clear();
    await this.refreshStoredRooms();
    log.action("chat.adminCloseAll");
    this.push();
  }

  pendingJoin(requestId: string): PendingJoinApproval | undefined {
    return this.hub?.pendingApprovals().find(item => item.requestId === requestId);
  }

  async approveJoinNew(requestId: string): Promise<void> {
    await this.hub?.approveJoinNew(requestId);
    this.push();
  }

  async approveJoinReuse(requestId: string, participantId: string): Promise<void> {
    await this.hub?.approveJoinReuse(requestId, participantId);
    this.push();
  }

  async rejectJoin(requestId: string, reason?: string): Promise<void> {
    await this.hub?.rejectJoin(requestId, reason);
    this.push();
  }

  // Per-room secrets this host set, so we can copy/share them later.
  rememberRoomKey(room: string, key: string): void { this.hostedKeys.set(ChatHub.canonRoom(room), key); }
  getRoomKey(room: string): string | undefined { return this.hostedKeys.get(ChatHub.canonRoom(room)); }

  roomInvite(room: string): { magicLink: string; message: string } | undefined {
    const secret = this.getRoomKey(room);
    if (!secret) return undefined;
    const connection = [...this.rooms.values()].find(item => ChatHub.canonRoom(item.room) === ChatHub.canonRoom(room));
    let base = connection?.url || (this.hub?.port ? `ws://${ChatHub.localIp()}:${this.hub.port}` : "");
    if (!base) return undefined;
    const parsed = new URL(base);
    parsed.pathname = `/${encodeURIComponent(ChatHub.canonRoom(room))}`;
    parsed.search = ""; parsed.hash = "";
    const url = parsed.toString().replace(/\/$/, "");
    const roomId = this.hub?.adminRooms().find(item => item.room === ChatHub.canonRoom(room))?.roomId;
    const magicLink = createChatMagicLink(url, secret, roomId);
    return { magicLink, message: chatInviteMessage(magicLink) };
  }

  async dispose(): Promise<void> {
    for (const agent of this.managedAgents.values()) { try { agent.client.disconnect(); } catch { /* ignore */ } }
    this.managedAgents.clear();
    for (const rc of this.rooms.values()) { try { rc.client.disconnect(); } catch { /* ignore */ } }
    this.rooms.clear();
    try { await this.hub?.stop(); } catch { /* ignore */ }
  }
}

let chatMgr: ChatRoomManager | undefined;
function getChatMgr(): ChatRoomManager {
  if (!chatMgr) chatMgr = new ChatRoomManager();
  return chatMgr;
}

// Extension context kept for chat helpers that run outside a message handler
// (e.g. secret rotation triggered by a hub event).
let chatCtx: vscode.ExtensionContext | undefined;
function saveRekeyedSecret(url: string, room: string, secret: string, roomId?: string): void {
  if (!chatCtx) return;
  const id = chatRoomIdentity(url, room, roomId);
  const list = chatRecents(chatCtx);
  const entry = list.find(recent => chatRoomIdentity(recent.url, recent.room, recent.roomId) === id);
  if (entry && (!entry.host || !entry.roomId)) { entry.secret = secret; void chatCtx.globalState.update(CHAT_RECENTS_KEY, list); }
}

// A stable per-installation chat identity so this user is recognizable across
// reloads/reconnects (extension joins carry it as their cid). Persisted in
// globalState; generated once.
let chatCid = "";
function getChatCid(context: vscode.ExtensionContext): string {
  if (chatCid) return chatCid;
  chatCid = context.globalState.get<string>("chatIdentityCid", "") || "";
  if (!chatCid) {
    chatCid = randomBytes(4).toString("hex");
    void context.globalState.update("chatIdentityCid", chatCid);
  }
  return chatCid;
}

let chatInstallationId = "";
function getChatInstallationId(context: vscode.ExtensionContext): string {
  if (chatInstallationId) return chatInstallationId;
  chatInstallationId = context.globalState.get<string>("chatInstallationId", "") || "";
  if (!chatInstallationId) {
    chatInstallationId = randomUUID();
    void context.globalState.update("chatInstallationId", chatInstallationId);
  }
  return chatInstallationId;
}

/** Post a message to the panel webview if it's open. */
function postToPanel(m: object): void {
  panel?.webview.postMessage(m);
}

// ── Chatroom recents (persisted across sessions) ────────────────────────────
const CHAT_RECENTS_KEY = "pk.chat.recents";
interface RecentRoom { id: string; url: string; room: string; roomId?: string; user: string; host: boolean; port: number; secret?: string; lastJoined: number; }

function chatUrlPort(wsUrl: string): number {
  try { return Number(new URL(wsUrl).port) || 7345; } catch { return 7345; }
}
function chatRecents(ctx: vscode.ExtensionContext): RecentRoom[] {
  return joinedRoomRecents(ctx.globalState.get<RecentRoom[]>(CHAT_RECENTS_KEY, []));
}
async function migrateChatRecents(ctx: vscode.ExtensionContext): Promise<void> {
  const raw = ctx.globalState.get<RecentRoom[]>(CHAT_RECENTS_KEY, []);
  const joined = joinedRoomRecents(raw.map(room => ({ ...room })));
  if (JSON.stringify(raw) !== JSON.stringify(joined)) await ctx.globalState.update(CHAT_RECENTS_KEY, joined);
}
function chatRecentsForUi(ctx: vscode.ExtensionContext): object[] {
  return chatRecents(ctx).map(r => ({ id: r.id, url: r.url, room: r.room, roomId: r.roomId, user: r.user, host: r.host }));
}
async function saveChatRecent(ctx: vscode.ExtensionContext, e: { url: string; room: string; roomId?: string; user: string; secret?: string; host?: boolean }): Promise<void> {
  const current = chatRecents(ctx);
  if (e.host) {
    await ctx.globalState.update(CHAT_RECENTS_KEY, current);
    _treeProvider?.refresh();
    return;
  }
  const id = chatRoomIdentity(e.url, e.room, e.roomId);
  const prev = current.find(room => chatRoomIdentity(room.url, room.room, room.roomId) === id);
  const list = current.filter(room => chatRoomIdentity(room.url, room.room, room.roomId) !== id);
  list.unshift({ id, url: e.url, room: e.room, roomId: e.roomId ?? prev?.roomId, user: e.user, host: false, port: chatUrlPort(e.url), secret: e.secret ?? prev?.secret, lastJoined: Date.now() });
  await ctx.globalState.update(CHAT_RECENTS_KEY, list.slice(0, 50));
  _treeProvider?.refresh();
}
async function forgetChatRecent(ctx: vscode.ExtensionContext, id: string): Promise<void> {
  await ctx.globalState.update(CHAT_RECENTS_KEY, chatRecents(ctx).filter(r => r.id !== id));
  _treeProvider?.refresh();
}

async function openHostedRoom(context: vscode.ExtensionContext, roomId: string): Promise<void> {
  const manager = getChatMgr();
  if (manager.activateRoomById(roomId)) {
    openChatroomPanel(context);
    return;
  }
  const stored = manager.hostedRoomsForNavigation().find(room => room.roomId === roomId);
  if (!stored) throw new Error("Hosted Room was not found.");
  if (!stored.canRehost) throw new Error(stored.unavailableReason || "This Room cannot be Rehosted.");
  const cfg = vscode.workspace.getConfiguration("personalKnowledge");
  const started = await manager.startHub(cfg.get<number>("chatHubPort") ?? 7345);
  if (!started.ok) throw new Error(started.error || "Couldn't start Chat Hub.");
  const hosted = await manager.rehostRoom(roomId);
  const url = `ws://127.0.0.1:${manager.hubPort}`;
  manager.joinRoom({ url, room: hosted.room, roomId: hosted.roomId, user: "Host", token: hosted.secret,
    cid: getChatCid(context), hostToken: hosted.hostToken });
  openChatroomPanel(context);
}

async function promptRenameHostedRoom(room: HostedRoomNavigationItem): Promise<void> {
  const roomName = await vscode.window.showInputBox({
    title: room.active ? "Rename Active Room" : "Rename Stored Room",
    value: room.roomName,
    prompt: "Room UUID, history, identities, and Join secret remain unchanged.",
    validateInput: value => value.trim() ? undefined : "Room name is required.",
  });
  if (roomName === undefined || roomName.trim() === room.roomName.trim()) return;
  if (room.active) await getChatMgr().renameActiveRoom(room.roomId, roomName);
  else await getChatMgr().renameStoredRoom(room.roomId, roomName);
}

async function confirmAndDeleteStoredRoom(context: vscode.ExtensionContext, roomId: string, roomName: string): Promise<boolean> {
  const confirmed = await vscode.window.showWarningMessage(
    `Permanently delete Stored Room "${roomName}" and all of its messages, participants, alias history, and credentials?`,
    { modal: true }, "Continue",
  );
  if (confirmed !== "Continue") return false;
  const finalConfirmation = await vscode.window.showWarningMessage(
    `Final confirmation: permanently delete "${roomName}"? This cannot be undone or recovered by Rehost.`,
    { modal: true }, "Delete Data Permanently",
  );
  if (finalConfirmation !== "Delete Data Permanently") return false;
  await getChatMgr().deleteStoredRoom(roomId);
  await context.globalState.update(CHAT_RECENTS_KEY, chatRecents(context).filter(room => room.roomId !== roomId));
  _treeProvider?.refresh();
  return true;
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

// ── First-run example content ────────────────────────────────────────────────
/** True if the store has no user content in any of the file-backed types. */
function storeIsEmpty(): boolean {
  const root = getStorePath();
  const hasFiles = (dir: string): boolean => {
    if (!fs.existsSync(dir)) return false;
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      if (e.name.startsWith(".")) continue;
      const p = path.join(dir, e.name);
      if (e.isDirectory()) { if (hasFiles(p)) return true; }
      else return true;
    }
    return false;
  };
  return !["skills", "notes", "papers", "prompts", "scripts", "packages"]
    .some(t => hasFiles(path.join(root, t)));
}

/** Seed a small set of example items (one per folder) + a getting-started guide,
 *  so brand-new users have something to mimic. Only called on an empty store. */
function seedExamples(): void {
  const GS = "Getting Started";
  const md = (...lines: string[]) => lines.join("\n") + "\n";

  const guide = md(
    "# Getting Started with Personal Knowledge Manager",
    "",
    "Welcome! Your knowledge base is just a folder of plain Markdown files — everything",
    "in the panel is a file on disk. You (or an AI assistant via MCP) can edit them directly.",
    "",
    "> Every item tagged **Getting Started** is an example. Open it, copy its structure for",
    "> your own work, then delete the examples when you're comfortable.",
    "",
    "## 🧠 Skills",
    "Reusable know-how (`skills/<Category>/<name>.md`). Add one with the **＋** button on the",
    "Skills tab, or right-click a sidebar folder → *Add skill here*.",
    "",
    "## 📝 Notes",
    "Quick Markdown notes with live preview — `[[wiki links]]`, pasted images, Mermaid",
    "diagrams, KaTeX math (`$...$`), and task lists (`[ ] [x] [~] [!]`). Pin a note or folder",
    "to keep it on top. Files: `notes/<Category>/<Title>.md`.",
    "",
    "## 📄 Papers",
    "Track research papers and your own **ideas** with a citation graph (2D/3D). Each paper is",
    "`papers/<Topic>/<Title>.md` with metadata, conclusions, citations, and an optional URL/file.",
    "",
    "## 🧩 Prompts",
    "Versioned prompt files: `prompts/<project>/<task>/<version>/<file>` — keep iterations side by side.",
    "",
    "## 📦 Packages",
    "Browse small reusable code packages (`packages/<name>/…`) you want handy across projects.",
    "",
    "## 📜 Scripts",
    "Organise scripts in a folder tree (`scripts/<Category>/<file>`) with language tags, syntax",
    "highlighting, and an **AI Summary** button.",
    "",
    "## 🐍 Python Environments",
    "Manage conda / venv / uv envs: Python version + size, compare two envs, find near-duplicates",
    "to merge, open an activated shell, or migrate an env into a central folder. (Machine-local.)",
    "",
    "## 🖥 Servers",
    "Run local servers as managed packages: start/stop, change port, view logs, and reach each",
    "through a stable proxy URL.",
    "",
    "## 🔄 Sync",
    "Share with another machine: the host generates a one-paste encrypted **Magic Code**; the receiver",
    "pastes it, then chooses to **merge directly** or drop everything into a **new group** to review.",
    "",
    "## 🤖 MCP (for AI assistants)",
    "The MCP tab generates a Python server with read+write tools over these files. Run",
    "`pip install fastmcp` and point your assistant (Claude, Copilot, …) at it.",
    "",
    "---",
    "Files are the source of truth — edit here, in your editor, or via MCP, and the panel",
    "refreshes automatically. Everything is git-tracked, so nothing is lost.",
  );

  skillUpsert({
    name: "getting-started", category: GS,
    description: "How to use each part of Personal Knowledge Manager",
    tags: ["guide", "onboarding"], content: guide,
  });

  skillUpsert({
    name: "example-skill", category: GS,
    description: "A template skill — copy its structure for your own",
    tags: ["example"],
    content: md(
      "# Example Skill",
      "",
      "A **skill** is reusable know-how you want to find again — a checklist, a command, a gotcha.",
      "",
      "## When to use",
      "Describe the situation this applies to.",
      "",
      "## Steps",
      "1. First do this.",
      "2. Then that.",
      "",
      "## Gotchas",
      "- Note anything that bit you.",
      "",
      "_Delete this example once you've added your own skills._",
    ),
  });

  noteUpsert({
    slug: `${GS}/Welcome`, title: "Welcome", type: "general",
    tags: ["example"], category: GS, pinned: true,
    content: md(
      "# 👋 Welcome to Personal Knowledge Manager",
      "",
      "This is an **example note**. Notes render Markdown live:",
      "",
      "- Task list:",
      "  - [x] done",
      "  - [ ] todo",
      "  - [~] in progress",
      "  - [!] blocked",
      "- Math: $e^{i\\pi} + 1 = 0$",
      "- A diagram:",
      "",
      "```mermaid",
      "flowchart LR",
      "  Idea --> Note --> Skill",
      "```",
      "",
      "Jump to the [[getting-started]] guide. Paste an image straight in — it's stored next to",
      "the note. Pin this note (★) to keep it on top.",
      "",
      "_Delete this example once you're comfortable._",
    ),
  });

  paperUpsert({
    slug: "example-paper", title: "Example Paper — how papers work",
    category: GS, topic: GS, authors: ["You"], year: 2025, tags: ["example"],
    conclusions: ["Papers are plain Markdown with metadata", "The graph links citations you list"],
    content: md(
      "# Example Paper",
      "",
      "Papers track research (or your own **ideas**) with authors, year, conclusions, and",
      "citations. List a citation by another paper's title or slug and it shows up in the graph.",
      "",
      "Attach a remote **URL** or upload a local PDF. Toggle the 2D/3D graph to explore links.",
      "",
      "_Delete this example when you add real papers._",
    ),
  });

  promptImport([{
    project: "example-project", task: "summarize", version: "v1", file: "system.md",
    content: md(
      "# System prompt (example)",
      "",
      "You are a concise assistant. Summarize the user's text in 3 bullet points.",
      "",
      "Keep versions of a prompt side by side under prompts/<project>/<task>/<version>/.",
    ),
  }]);

  scriptImport([{
    category: GS, file: "hello.py",
    content: md(
      "#!/usr/bin/env python3",
      '"""Example script. Scripts get language tags, highlighting, and an AI Summary button."""',
      "",
      "def main() -> None:",
      '    print("Hello from your knowledge base!")',
      "",
      'if __name__ == "__main__":',
      "    main()",
    ),
  }]);

  packageImport([{
    name: "example-package",
    files: [
      { path: "README.md", content: md("# example-package", "", "Drop small reusable libraries here to keep them handy across projects.") },
      { path: "hello.py", content: md("def hello() -> str:", '    return "hi from example-package"') },
    ],
  }]);
}

/** Seed examples once, only for a brand-new (empty) store. */
async function maybeSeedExamples(context: vscode.ExtensionContext): Promise<void> {
  if (context.globalState.get<boolean>("examplesSeeded", false)) return;
  try {
    if (!storeIsEmpty()) { await context.globalState.update("examplesSeeded", true); return; }
    seedExamples();
    gitCommit("seed: getting-started examples");
    log.info("seeded getting-started examples into empty store");
  } catch (e: any) {
    log.warn(`example seeding skipped: ${e?.message}`);
  }
  await context.globalState.update("examplesSeeded", true);
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
      "Personal Knowledge Manager: you must complete setup before using this extension.",
      "Configure now"
    ).then(v => { if (v) ensureSetup(context); });
    return false;
  }
  await initStore(context, chosen);
  void offerMcpRuntimeSetup(context);
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

  const panelJs = webview.asWebviewUri(vscode.Uri.file(path.join(webviewDir, "panel.js")));
  const panelCss = webview.asWebviewUri(vscode.Uri.file(path.join(webviewDir, "panel.css")));
  html = html.replace(/%%PANEL_JS%%/g, panelJs.toString());
  html = html.replace(/%%PANEL_CSS%%/g, panelCss.toString());

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

  // 3D citation graph (3d-force-graph + three.js bundled locally).
  const fg3dJs = webview.asWebviewUri(vscode.Uri.file(path.join(webviewDir, "forcegraph3d.js")));
  html = html.replace(/%%FORCEGRAPH3D_SRC%%/g, fg3dJs.toString());

  // Inject the webview CSP source — required for VS Code to allow scripts to run
  html = html.replace(/%%CSP_SOURCE%%/g, webview.cspSource);

  // Base URI for note image assets (notes/_assets/...). The webview rewrites
  // `_assets/` markdown image refs to `${NOTES_BASE}/_assets/...` at render time.
  const notesBase = webview.asWebviewUri(vscode.Uri.file(path.join(getStorePath(), "notes")));
  html = html.replace(/%%NOTES_BASE%%/g, notesBase.toString());

  // Stamp the extension version so the running webview build is always visible.
  const version = (context.extension?.packageJSON?.version as string) || "?";
  html = html.replace(/%%PKM_VERSION%%/g, version);
  return html;
}

function getOrCreatePanel(context: vscode.ExtensionContext): vscode.WebviewPanel {
  if (panel) { panel.reveal(vscode.ViewColumn.One); return panel; }

  panel = vscode.window.createWebviewPanel(
    "personalKnowledge",
    "Personal Knowledge Manager",
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
      if (_pendingTab) {
        const tab = _pendingTab;
        _pendingTab = undefined;
        respond({ command: "openTab", tab });
      }
      if (_pendingMcpRegenerateHighlight) {
        _pendingMcpRegenerateHighlight = false;
        respond({ command: "highlightMcpRegenerate" });
      }
      respond({ command: "mcpStatus", data: mcpPanelStatusData() });
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

    // ── Chatroom (agent room) ────────────────────────────────────────────
    case "chatState": {
      // Webview opened the tab — send current config defaults + live state.
      const cfg = vscode.workspace.getConfiguration("personalKnowledge");
      respond({
        command: "chatConfig",
        data: {
          hubUrl:      (cfg.get<string>("chatHubUrl") || "").trim(),
          room:        (cfg.get<string>("chatRoom") || "general").trim(),
          displayName: (cfg.get<string>("chatDisplayName") || os.userInfo().username || "user").trim(),
          hasSecret:   !!(cfg.get<string>("chatSharedSecret") || "").trim(),
          hubPort:     cfg.get<number>("chatHubPort") ?? 7345,
        },
      });
      getChatMgr().push();
      respond({ command: "chatRecents", data: { recents: chatRecentsForUi(context) } });
      break;
    }

    case "chatConnect": {
      // Per-room secret: the joiner enters the room's secret (given by the host).
      const secret = (msg.secret || "").toString().trim();
      if (!secret) {
        respond({ command: "chatToast", data: { error: "Enter the room secret the host gave you." } });
        break;
      }
      let url  = (msg.url  || "").trim();
      let room = (msg.room || "").trim();
      // A connection string may embed the room: ws://host:port/room
      if (url) {
        try {
          const u = new URL(url);
          const seg = u.pathname.replace(/^\/+|\/+$/g, "");
          if (seg && !room) room = decodeURIComponent(seg.split("/").pop() || "");
          if (seg) url = `${u.protocol}//${u.host}`;
        } catch { /* leave as-is */ }
      }
      if (!room) room = "general";
      const user = (msg.user || os.userInfo().username || "user").trim();
      if (!url) {
        respond({ command: "chatToast", data: { error: "Enter a hub URL (ws://host:port)." } });
        break;
      }
      getChatMgr().joinRoom({ url, room, user, token: secret, cid: getChatCid(context) });
      await saveChatRecent(context, { url, room, user, secret, host: false });
      respond({ command: "chatRecents", data: { recents: chatRecentsForUi(context) } });
      break;
    }

    case "chatRejoin": {
      const id = String(msg.id || "");
      const entry = chatRecents(context).find(r => r.id === id);
      if (!entry) break;
      const recentSecret = (entry.secret || "").trim();
      if (!entry.host && !recentSecret) { respond({ command: "chatToast", data: { error: `No stored secret for room "${entry.room}". Use ＋ Join room and enter it.` } }); break; }

      const reachable = await probeChatRoomActive(entry.url, entry.room, entry.roomId);
      if (reachable) {
        const secret = entry.host ? getChatMgr().getRoomKey(entry.room) : recentSecret;
        if (!secret) { respond({ command: "chatToast", data: { error: `Room "${entry.room}" is reachable but not active in this Extension instance.` } }); break; }
        getChatMgr().joinRoom({ url: entry.url, room: entry.room, roomId: entry.roomId, user: entry.user, token: secret, cid: getChatCid(context) });
        await saveChatRecent(context, entry);
      } else if (entry.host) {
        const REHOST = "Rehost & Join", REMOVE = "Remove";
        const pick = await vscode.window.showInformationMessage(
          `Your hub for room "${entry.room}" isn't running.`, REHOST, REMOVE);
        if (pick === REHOST) {
          const res = await getChatMgr().startHub(entry.port);
          if (!res.ok) { vscode.window.showErrorMessage(`Couldn't start hub: ${res.error}`); break; }
          try {
            const hosted = entry.roomId
              ? await getChatMgr().rehostRoom(entry.roomId)
              : await getChatMgr().createHostedRoom(entry.room, recentSecret || undefined);
            const localUrl = `ws://127.0.0.1:${getChatMgr().hubPort}`;
            getChatMgr().joinRoom({ url: localUrl, room: hosted.room, roomId: hosted.roomId, user: entry.user, token: hosted.secret, cid: getChatCid(context), hostToken: hosted.hostToken });
            await saveChatRecent(context, { url: localUrl, room: hosted.room, roomId: hosted.roomId, user: entry.user, host: true });
          } catch (error: any) {
            vscode.window.showErrorMessage(`Couldn't Rehost Room: ${error?.message || error}`);
          }
        } else if (pick === REMOVE) {
          await forgetChatRecent(context, id);
        }
      } else {
        const REMOVE = "Remove from recents", KEEP = "Keep";
        const pick = await vscode.window.showWarningMessage(
          `Room "${entry.room}" at ${entry.url} seems offline (the host may not be online).`, REMOVE, KEEP);
        if (pick === REMOVE) await forgetChatRecent(context, id);
      }
      respond({ command: "chatRecents", data: { recents: chatRecentsForUi(context) } });
      break;
    }

    case "chatForgetRoom": {
      await forgetChatRecent(context, String(msg.id || ""));
      respond({ command: "chatRecents", data: { recents: chatRecentsForUi(context) } });
      break;
    }

    case "chatSetActive": {
      getChatMgr().setActive((msg.key || "").toString());
      break;
    }

    case "chatLeave": {
      await getChatMgr().closeOrLeaveRoom((msg.key || "").toString());
      break;
    }

    case "chatSend": {
      const responseRequired = typeof msg.responseRequired === "boolean" ? msg.responseRequired : undefined;
      const ok = getChatMgr().send((msg.text || "").toString(), responseRequired);
      if (!ok) getChatMgr().push();
      break;
    }

    case "chatAddManagedAgent": {
      await getChatMgr().addManagedAgent(context);
      break;
    }

    case "chatRemoveManagedAgent": {
      getChatMgr().removeManagedAgent(String(msg.id || ""));
      break;
    }
    case "chatEditManagedAgent": {
      const id = String(msg.id || "");
      const currentName = String(msg.name || "");
      const name = await vscode.window.showInputBox({
        prompt: `New name for managed agent "${currentName}"`, value: currentName,
        validateInput: value => value.trim() ? undefined : "Enter a name",
      });
      if (!name) break;
      const role = await vscode.window.showInputBox({
        prompt: `Role for "${name.trim()}" (leave empty to clear)`, value: String(msg.role || ""),
        placeHolder: "e.g. Security reviewer, Research agent",
      });
      if (role === undefined) break;
      getChatMgr().editManagedAgent(id, name, role);
      break;
    }

    case "chatShareFile": {
      await getChatMgr().sendFileToActive();
      break;
    }

    case "chatSaveFile": {
      await getChatMgr().saveReceivedFile((msg.key || "").toString(), (msg.fileId || "").toString());
      break;
    }

    case "chatExport": {
      await getChatMgr().exportActive();
      break;
    }

    case "chatStartHub": {
      const cfg = vscode.workspace.getConfiguration("personalKnowledge");
      // Port: 0 (or blank) means auto-pick a free port; otherwise try the given
      // port and fall back to a free one if it's busy. Persist a chosen port.
      let port = Number(msg.port);
      if (!Number.isFinite(port)) port = cfg.get<number>("chatHubPort") ?? 7345;
      if (port > 0) await cfg.update("chatHubPort", port, vscode.ConfigurationTarget.Global);
      const room = (String(msg.room || "").trim()) || (cfg.get<string>("chatRoom") || "general").trim();
      const user = (String(msg.user || "").trim()) || "Host";   // hosts default to "Host"
      // Per-room secret: use the host's typed key, reuse a prior one, or generate one.
      let key = String(msg.key || "").trim();
      if (!key) key = getChatMgr().getRoomKey(room) || randomBytes(9).toString("base64url");

      const res = await getChatMgr().startHub(port);
      log.info(`chat: startHub result ok=${res.ok}${res.error ? " error=" + res.error : ""}${res.wsUrl ? " url=" + res.wsUrl : ""}`);
      respond({ command: "chatHubResult", data: res });
      if (res.ok) {
        let created: { roomId: string; room: string; secret: string; hostToken: string };
        try { created = await getChatMgr().createHostedRoom(room, key); }
        catch (error: any) {
          vscode.window.showErrorMessage(`Couldn't create Room: ${error?.message || error}`);
          break;
        }
        key = created.secret;
        if (room) await cfg.update("chatRoom", room, vscode.ConfigurationTarget.Global);
        const localUrl = `ws://127.0.0.1:${getChatMgr().hubPort}`;
        getChatMgr().joinRoom({ url: localUrl, room: created.room, roomId: created.roomId, user, token: key, cid: getChatCid(context), hostToken: created.hostToken });
        await saveChatRecent(context, { url: localUrl, room: created.room, roomId: created.roomId, user, host: true });
        respond({ command: "chatRecents", data: { recents: chatRecentsForUi(context) } });
        const browserUrl = `${res.httpUrl}/room/${encodeURIComponent(room)}`;
        const COPY = "Copy Magic Link Invite", BROWSER = "Open Browser View";
        vscode.window.showInformationMessage(
          `Hosting room "${room}" as ${user}. Copy one message to let an MCP agent join; browser viewers can still open the room link.`,
          COPY, BROWSER
        ).then(pick => {
          if (pick === COPY) {
            const invite = getChatMgr().roomInvite(room);
            if (invite) vscode.env.clipboard.writeText(invite.message);
          }
          else if (pick === BROWSER) vscode.env.openExternal(vscode.Uri.parse(browserUrl));
        });
      } else {
        const SHOW = "Show Logs";
        vscode.window.showErrorMessage(`Couldn't start chat hub: ${res.error || "unknown error"}`, SHOW)
          .then(pick => { if (pick === SHOW) vscode.commands.executeCommand("personalKnowledge.showLogs"); });
      }
      break;
    }

    case "chatStopHub": {
      await getChatMgr().stopHub();
      break;
    }

    case "chatCopyInvite": {
      const room = String(msg.room || "").trim();
      const invite = getChatMgr().roomInvite(room);
      if (!invite) { vscode.window.showWarningMessage(`Couldn't create an invite for room "${room}".`); break; }
      await vscode.env.clipboard.writeText(invite.message);
      vscode.window.setStatusBarMessage("$(copy) Chatroom Magic Link invite copied", 4000);
      break;
    }

    case "chatAdminCloseRoom": {
      await getChatMgr().adminCloseRoom(String(msg.room || ""));
      break;
    }

    case "chatRehostStoredRoom": {
      const roomId = String(msg.roomId || "").trim();
      if (!roomId) break;
      const cfg = vscode.workspace.getConfiguration("personalKnowledge");
      const port = cfg.get<number>("chatHubPort") ?? 7345;
      const manager = getChatMgr();
      const started = await manager.startHub(port);
      if (!started.ok) {
        vscode.window.showErrorMessage(`Couldn't start Chat Hub: ${started.error || "unknown error"}`);
        break;
      }
      try {
        const hosted = await manager.rehostRoom(roomId);
        const recent = chatRecents(context).find(room => room.host && room.roomId === roomId);
        const user = recent?.user || "Host";
        const localUrl = `ws://127.0.0.1:${manager.hubPort}`;
        manager.joinRoom({ url: localUrl, room: hosted.room, roomId: hosted.roomId, user, token: hosted.secret, cid: getChatCid(context), hostToken: hosted.hostToken });
        await saveChatRecent(context, { url: localUrl, room: hosted.room, roomId, user, host: true });
        respond({ command: "chatRecents", data: { recents: chatRecentsForUi(context) } });
      } catch (error: any) {
        vscode.window.showErrorMessage(`Couldn't Rehost Room: ${error?.message || error}`);
        await manager.refreshStoredRooms();
      }
      break;
    }

    case "chatRenameStoredRoom": {
      const roomId = String(msg.roomId || "");
      const currentName = String(msg.roomName || "");
      const roomName = await vscode.window.showInputBox({
        title: "Rename Stored Room",
        value: currentName,
        prompt: "The Room UUID, history, participants, and Join secret stay unchanged.",
        validateInput: value => value.trim() ? undefined : "Room name is required.",
      });
      if (roomName === undefined || roomName.trim() === currentName.trim()) break;
      try { await getChatMgr().renameStoredRoom(roomId, roomName); }
      catch (error: any) { vscode.window.showErrorMessage(`Couldn't rename Room: ${error?.message || error}`); }
      break;
    }

    case "chatRenameActiveRoom": {
      const roomId = String(msg.roomId || "");
      const currentName = String(msg.roomName || "");
      const roomName = await vscode.window.showInputBox({
        title: "Rename Active Room",
        value: currentName,
        prompt: "Connected members stay in the Room; Room UUID, history, identities, and Join secret remain unchanged.",
        validateInput: value => value.trim() ? undefined : "Room name is required.",
      });
      if (roomName === undefined || roomName.trim() === currentName.trim()) break;
      try { await getChatMgr().renameActiveRoom(roomId, roomName); }
      catch (error: any) { vscode.window.showErrorMessage(`Couldn't rename active Room: ${error?.message || error}`); }
      break;
    }

    case "chatDeleteStoredRoom": {
      const roomId = String(msg.roomId || "");
      const roomName = String(msg.roomName || "");
      try {
        await confirmAndDeleteStoredRoom(context, roomId, roomName);
        respond({ command: "chatRecents", data: { recents: chatRecentsForUi(context) } });
      } catch (error: any) {
        vscode.window.showErrorMessage(`Couldn't delete Room data: ${error?.message || error}`);
      }
      break;
    }

    case "chatApproveJoinNew": {
      const requestId = String(msg.requestId || "");
      try { await getChatMgr().approveJoinNew(requestId); }
      catch (error: any) { vscode.window.showErrorMessage(`Couldn't approve Join: ${error?.message || error}`); }
      break;
    }

    case "chatApproveJoinReuse": {
      const requestId = String(msg.requestId || "");
      const pending = getChatMgr().pendingJoin(requestId);
      if (!pending) { vscode.window.showWarningMessage("This Join request is no longer pending."); break; }
      if (!pending.reusableParticipants.length) { vscode.window.showWarningMessage("No offline participant identity is available to reuse."); break; }
      const picked = await vscode.window.showQuickPick(
        pending.reusableParticipants.map(participant => ({
          label: participant.previousAlias || participant.participantId.slice(0, 8),
          description: participant.kind,
          detail: `Room participant ${participant.participantId}`,
          participantId: participant.participantId,
        })),
        { title: `Reuse identity for ${pending.alias}`, placeHolder: "Choose an offline participant identity" },
      );
      if (!picked) break;
      try { await getChatMgr().approveJoinReuse(requestId, picked.participantId); }
      catch (error: any) { vscode.window.showErrorMessage(`Couldn't reuse identity: ${error?.message || error}`); }
      break;
    }

    case "chatRejectJoin": {
      const requestId = String(msg.requestId || "");
      try { await getChatMgr().rejectJoin(requestId); }
      catch (error: any) { vscode.window.showErrorMessage(`Couldn't reject Join: ${error?.message || error}`); }
      break;
    }

    case "chatRotateSecret": {
      const room = String(msg.room || "").trim();
      if (!room) break;
      const pick = await vscode.window.showWarningMessage(
        `Refresh the key and Magic Link for room "${room}"? Current members stay connected; the old Magic Link stops working.`,
        { modal: true }, "Refresh Key");
      if (pick !== "Refresh Key") break;
      if (!await getChatMgr().rotateRoomSecret(room)) { vscode.window.showWarningMessage(`Room "${room}" has no secret to rotate.`); break; }
      const invite = getChatMgr().roomInvite(room);
      if (invite) {
        await vscode.env.clipboard.writeText(invite.message);
        vscode.window.showInformationMessage("New key generated. The refreshed Magic Link invite was copied.");
      }
      break;
    }

    case "chatModerate": {
      const action = String(msg.action || "");
      if (!["kick", "mute", "unmute", "rename", "edit"].includes(action)) break;
      const sid  = msg.sid ? String(msg.sid) : "";
      const participantId = msg.participantId ? String(msg.participantId) : "";
      const user = String(msg.user || "member");
      let name: string | undefined;
      let role: string | undefined;
      if (action === "kick") {
        const pick = await vscode.window.showWarningMessage(
          `Permanently remove "${user}" from this room roster? They will disappear from Earlier. If online, they will be disconnected and the room key will rotate.`,
          { modal: true }, "Remove Permanently");
        if (pick !== "Remove Permanently") break;
      }
      if (action === "rename" || action === "edit") {
        const input = await vscode.window.showInputBox({
          prompt: `New name for "${user}"`, value: user,
          validateInput: v => v.trim() ? undefined : "Enter a name",
        });
        if (!input) break;
        name = input.trim();
      }
      if (action === "edit") {
        const input = await vscode.window.showInputBox({
          prompt: `Role for "${name}" (leave empty to clear)`, value: String(msg.role || ""),
          placeHolder: "e.g. Security reviewer, Research agent",
        });
        if (input === undefined) break;
        role = input.trim();
      }
      getChatMgr().moderate(action as "kick" | "mute" | "unmute" | "rename" | "edit", { participantId, sid, user }, name, role);
      break;
    }

    case "chatRenameSelf": {
      const cur = getChatMgr().selfName || String(msg.user || "");
      const input = await vscode.window.showInputBox({
        prompt: "Your new display name in this room", value: cur,
        validateInput: v => v.trim() ? undefined : "Enter a name",
      });
      if (!input) break;
      getChatMgr().renameSelf(input.trim());
      break;
    }

    case "chatAdminCloseAll": {
      const pick = await vscode.window.showWarningMessage(
        "Deactivate ALL rooms on your hub? Everyone will be disconnected.",
        { modal: true }, "Close All Rooms");
      if (pick === "Close All Rooms") await getChatMgr().adminCloseAll();
      break;
    }

    case "openExternal": {
      const url = String(msg.url || "").trim();
      if (url) { try { await vscode.env.openExternal(vscode.Uri.parse(url)); } catch { /* ignore */ } }
      break;
    }

    case "list": {
      const { tab, filter, q } = msg;
      let data: unknown;
      if (tab === "skills")    data = q ? skillSearch(q) : skillList(filter === "all" ? undefined : filter);
      else if (tab === "notes")   data = q ? noteSearch(q) : noteList(undefined, 500); // client-side filtering
      else if (tab === "papers")  data = q ? paperSearch(q) : paperList();
      else if (tab === "prompts")  data = promptList();
      else if (tab === "packages") data = packagesWithGit();
      else if (tab === "scripts")  data = q ? scriptSearch(q) : scriptList();
      else data = [];
      const folders = (tab === "skills" || tab === "notes") ? folderList(tab) : undefined;
      respond({ command: "list", data, folders });
      break;
    }

    case "folderCreate": {
      const area = String(msg.area || "");
      if (area !== "skills" && area !== "notes") break;
      const parent = String(msg.parent || "").replace(/^\/+|\/+$/g, "");
      const name = String(msg.name || "").trim();
      if (!name) break;
      const rel = parent ? `${parent}/${name}` : name;
      if (folderCreate(area, rel)) {
        gitCommit(`add(folder): ${area}/${rel}`);
        _treeProvider?.refresh();
        vscode.window.setStatusBarMessage("$(new-folder) Folder created", 3000);
      }
      const data = area === "skills" ? skillList() : noteList(undefined, 500);
      respond({ command: "list", data, folders: folderList(area) });
      break;
    }

    case "createKnowledgeItem": {
      const area = String(msg.area || "");
      if (area !== "skills" && area !== "notes" && area !== "papers") break;
      const category = await selectKnowledgeFolder(area, String(msg.category || ""));
      if (category === undefined) break;
      const title = await vscode.window.showInputBox({
        prompt: area === "skills" ? "New skill name" : area === "notes" ? "New note title" : `New ${msg.kind === "idea" ? "idea" : "paper"} title`,
      });
      if (!title?.trim()) break;
      if (area === "skills") {
        if (skillGet(title.trim())) { vscode.window.showWarningMessage(`Skill already exists: ${title.trim()}`); break; }
        skillUpsert({ name: title.trim(), content: "", category });
        gitCommit(`add(skill): ${title.trim()}`);
        await openStoreMarkdown("skills", category ? `${category}/${title.trim()}` : title.trim());
      } else if (area === "notes") {
        const slug = (category ? `${category}/` : "") + title.trim();
        if (noteGet(slug)) { vscode.window.showWarningMessage(`Note already exists: ${slug}`); break; }
        noteUpsert({ slug, title: title.trim(), content: "", type: "general", tags: [], category });
        gitCommit(`add(note): ${slug}`);
        await openStoreMarkdown("notes", slug);
      } else if (area === "papers") {
        const slug = uniquePaperSlug(title.trim(), category);
        if (paperGet(slug)) { vscode.window.showWarningMessage(`Paper or idea already exists: ${slug}`); break; }
        paperUpsert({
          slug, title: title.trim(), content: "", category,
          kind: msg.kind === "idea" ? "idea" : "paper",
          topic: String(msg.topic || ""), group: String(msg.group || "Papers"),
        });
        gitCommit(`add(${msg.kind === "idea" ? "idea" : "paper"}): ${slug}`);
        await openStoreMarkdown("papers", slug);
      } else break;
      _treeProvider?.refresh();
      respond({ command: "saved" });
      break;
    }

    case "createPromptItem": {
      const project = String(msg.project || "").trim() || await vscode.window.showInputBox({ prompt: "Prompt project" });
      if (!project?.trim()) break;
      const task = String(msg.task || "").trim() || await vscode.window.showInputBox({ prompt: "Prompt task" });
      if (!task?.trim()) break;
      const version = String(msg.version || "").trim() || await vscode.window.showInputBox({ prompt: "Prompt version", value: "v1" });
      if (!version?.trim()) break;
      const file = await vscode.window.showInputBox({
        prompt: "New prompt filename", placeHolder: "prompt.md",
        validateInput: value => value?.trim() && !/[\\/]/.test(value) ? null : "Enter a filename without slashes",
      });
      if (!file?.trim()) break;
      const segments = [project, task, version, file].map(value => String(value).trim());
      if (segments.some(value => value === "." || value === "..")) break;
      const full = path.join(getStorePath(), "prompts", ...segments);
      if (fs.existsSync(full)) { vscode.window.showWarningMessage(`Prompt already exists: ${segments.join("/")}`); break; }
      fs.mkdirSync(path.dirname(full), { recursive: true });
      fs.writeFileSync(full, "");
      gitCommit(`add(prompt): ${segments.join("/")}`);
      _treeProvider?.refresh();
      respond({ command: "saved" });
      const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(full));
      await vscode.window.showTextDocument(doc, { preview: false });
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
        if (r) {
          const papers = paperList() as any[];
          const resolvedCites = (r.cites || []).map((cite: any) => {
            const ref = String(cite.paper || "").toLowerCase();
            const target = papers.find(p => String(p.slug).toLowerCase() === ref || String(p.title).toLowerCase() === ref);
            return { ...cite, slug: target?.slug || "", title: target?.title || cite.paper };
          });
          const currentRefs = new Set([String(r.slug).toLowerCase(), String(r.title).toLowerCase()]);
          const citedBy = papers.flatMap(paper => (paper.cites || []).flatMap((cite: any) =>
            currentRefs.has(String(cite.paper || "").toLowerCase())
              ? [{ slug: paper.slug, title: paper.title, note: cite.note || "" }]
              : []));
          data = { type: "paper", ...r, resolvedCites, citedBy };
        }
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
      const rootSlug = String(msg.slug || "").trim();
      if (msg.exportMode === "browser") {
        const opened = await openLiveMarkdownPreview("note", rootSlug, context);
        if (opened) vscode.window.setStatusBarMessage(`$(globe) Live preview: ${notePreviewPath(rootSlug)}`, 5000);
        else vscode.window.showWarningMessage("Couldn't open the live Note preview in a browser.");
        break;
      }
      // Static Site export still renders the transitive linked-note closure in
      // the webview so diagrams can be embedded for offline use.
      const notes = collectLinkedNotes(rootSlug);
      const entry = notes.find(n => n.slug === rootSlug) || notes[0];
      respond({ command: "linkedNotes", entryFilename: entry ? entry.filename : "", notes, mode: msg.exportMode || "browser" });
      break;
    }

    case "openMarkdownPreview": {
      const kind = String(msg.kind || "") as "note" | "skill" | "paper";
      if (!(["note", "skill", "paper"] as string[]).includes(kind)) break;
      const key = String(msg.key || "").trim();
      const opened = await openLiveMarkdownPreview(kind, key, context);
      if (opened) vscode.window.setStatusBarMessage(`$(globe) Live preview: ${markdownPreviewPath(kind, key)}`, 5000);
      else vscode.window.showWarningMessage("Couldn't open the Markdown preview in a browser.");
      break;
    }

    case "writeLinkedExport": {
      // Write each webview-rendered note as a standalone HTML file with clickable
      // cross-note links. mode 'save' -> a folder the user picks (portable,
      // shareable, runs offline); otherwise -> a temp folder opened in the browser.
      try {
        const files: any[] = Array.isArray(msg.files) ? msg.files : [];
        if (!files.length) { vscode.window.setStatusBarMessage("$(info) Nothing to export", 3000); break; }
        const entry = String(msg.entryFilename || files[0].filename);
        const writeAll = (dir: string) => {
          for (const f of files) {
            const note = noteGet(String(f.slug || "")) || {};
            const doc = buildStandaloneNoteHtml({
              title: note.title || f.slug, slug: f.slug, category: note.category || "",
              tags: note.tags || "[]", noteType: note.type || "general",
              updatedAt: note.updated_at || "", bodyHtml: f.bodyHtml || "",
            }, katexCssForExport(context));
            fs.writeFileSync(path.join(dir, String(f.filename)), doc, "utf-8");
          }
        };

        if (msg.mode === "save") {
          const picked = await vscode.window.showOpenDialog({
            canSelectFolders: true, canSelectFiles: false, canSelectMany: false,
            openLabel: "Export linked notes here",
            defaultUri: vscode.Uri.file(os.homedir()),
          });
          if (!picked || !picked.length) break;
          const entryNote = files.find(f => f.filename === entry) || files[0];
          const baseName = safeFilePart(String(entryNote.slug || "notes").split("/").pop() || "notes") || "notes";
          const outDir = path.join(picked[0].fsPath, `${baseName}-linked`);
          fs.mkdirSync(outDir, { recursive: true });
          writeAll(outDir);
          const entryPath = path.join(outDir, entry);
          const pick = await vscode.window.showInformationMessage(
            `Exported ${files.length} linked note${files.length > 1 ? "s" : ""} to ${outDir}. Open ${entry} to browse offline.`,
            "Reveal", "Open");
          if (pick === "Reveal") await vscode.commands.executeCommand("revealFileInOS", vscode.Uri.file(entryPath));
          else if (pick === "Open") await vscode.env.openExternal(vscode.Uri.file(entryPath));
          break;
        }

        const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pk-notes-"));
        writeAll(dir);
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

    // ── Servers dashboard ────────────────────────────────────────────────────
    case "serverList": {
      respond({ command: "serverList", data: await serverList() });
      break;
    }
    case "serverStart": {
      const r = startServer(String(msg.slug || ""));
      if (!r.ok && r.error) vscode.window.showErrorMessage(`Start failed: ${r.error}`);
      await new Promise(res => setTimeout(res, 400));
      respond({ command: "serverList", data: await serverList() });
      break;
    }
    case "serverStop": {
      stopServer(String(msg.slug || ""));
      await new Promise(res => setTimeout(res, 300));
      respond({ command: "serverList", data: await serverList() });
      break;
    }
    case "serverRestart": {
      const r = await restartServer(String(msg.slug || ""));
      if (!r.ok && r.error) vscode.window.showErrorMessage(`Restart failed: ${r.error}`);
      respond({ command: "serverList", data: await serverList() });
      break;
    }
    case "serverSetPort": {
      const r = await setServerPort(String(msg.slug || ""), Number(msg.port) || 0);
      if (!r.ok && r.error) vscode.window.showErrorMessage(`Change port failed: ${r.error}`);
      respond({ command: "serverList", data: await serverList() });
      break;
    }
    case "serverImport": {
      const r = serverImport(String(msg.sourceDir || ""), String(msg.name || ""));
      if (r.ok) gitCommit(`server import: ${r.slug}`);
      else if (r.error) vscode.window.showErrorMessage(`Import failed: ${r.error}`);
      respond({ command: "serverList", data: await serverList() });
      break;
    }
    case "serverCreate": {
      const r = serverCreate(String(msg.name || ""));
      if (r.ok) gitCommit(`server create: ${r.slug}`);
      respond({ command: "serverList", data: await serverList() });
      break;
    }
    case "serverUpdate": {
      serverUpdate(String(msg.slug || ""), msg.patch || {});
      gitCommit(`server update: ${msg.slug}`);
      respond({ command: "serverList", data: await serverList() });
      break;
    }
    case "serverDelete": {
      serverDelete(String(msg.slug || ""));
      gitCommit(`server delete: ${msg.slug}`);
      respond({ command: "serverList", data: await serverList() });
      break;
    }
    case "serverLog": {
      respond({ command: "serverLog", slug: msg.slug, text: serverLog(String(msg.slug || ""), 300) });
      break;
    }
    case "serverPickFolder": {
      const picked = await vscode.window.showOpenDialog({
        canSelectFolders: true, canSelectFiles: false, canSelectMany: false,
        openLabel: "Select server folder",
      });
      respond({ command: "serverPickFolder", dir: picked && picked.length ? picked[0].fsPath : "" });
      break;
    }
    case "serverOpenUrl": {
      try {
        const ext = await vscode.env.asExternalUri(vscode.Uri.parse(String(msg.url || "")));
        await vscode.env.openExternal(ext);
      } catch (e: any) { vscode.window.showErrorMessage(`Couldn't open URL: ${e?.message}`); }
      break;
    }
    case "serverOpenFolder": {
      const dir = serverDir(String(msg.slug || ""));
      if (dir && fs.existsSync(dir)) {
        try { await vscode.commands.executeCommand("revealInExplorer", vscode.Uri.file(dir)); } catch { /* ignore */ }
        try { await vscode.commands.executeCommand("vscode.openFolder", vscode.Uri.file(dir), { forceNewWindow: true }); }
        catch (e: any) { vscode.window.showErrorMessage(`Couldn't open folder: ${e?.message}`); }
      } else {
        vscode.window.showErrorMessage("Server folder not found");
      }
      break;
    }
    case "serverCopy": {
      await vscode.env.clipboard.writeText(String(msg.text || ""));
      vscode.window.setStatusBarMessage("$(check) Copied", 2500);
      break;
    }

    // ── Python Environments ──────────────────────────────────────────────────
    case "envList": {
      respond({ command: "envList", data: envListForUi() });
      void sweepEnvVersions(respond);
      void sweepEnvSizes(respond);
      break;
    }
    case "envCondaList": {
      respond({ command: "envCondaList", data: await condaEnvs() });
      break;
    }
    case "envDetectFolder": {
      respond({ command: "envDetectFolder", data: detectFolderEnv(String(msg.dir || "")) });
      break;
    }
    case "envPickFolder": {
      const picked = await vscode.window.showOpenDialog({
        canSelectFolders: true, canSelectFiles: false, canSelectMany: false,
        openLabel: "Select environment folder",
      });
      respond({ command: "envPickFolder", dir: picked && picked.length ? picked[0].fsPath : "" });
      break;
    }
    case "envAdd": {
      pyenvAdd(msg.env || {});
      respond({ command: "envList", data: envListForUi() });
      vscode.window.setStatusBarMessage("$(check) Environment added", 3000);
      break;
    }
    case "envUpdate": {
      pyenvUpdate(String(msg.id || ""), msg.patch || {});
      respond({ command: "envList", data: envListForUi() });
      break;
    }
    case "envDelete": {
      const r = await pyenvDelete(String(msg.id || ""), !!msg.removeFiles);
      respond({ command: "envList", data: envListForUi() });
      respond({ command: "envDeleteResult", data: r });
      break;
    }
    case "envPackages": {
      const r = await pyenvPackages(String(msg.id || ""), !!msg.refresh);
      respond({ command: "envPackages", id: msg.id, ...r });
      break;
    }
    case "envCompare": {
      respond({ command: "envCompare", data: await pyenvCompare(String(msg.a || ""), String(msg.b || "")) });
      break;
    }
    case "envSimilarity": {
      respond({ command: "envSimilarity", data: await pyenvSimilarity() });
      break;
    }
    case "envMergeScript": {
      const r = await pyenvMergeScript(String(msg.a || ""), String(msg.b || ""));
      if (r.error || !r.script) { respond({ command: "envMergeScript", error: r.error || "no script" }); break; }
      await vscode.env.clipboard.writeText(r.script);
      vscode.window.setStatusBarMessage("$(check) Merge script copied — review and run it yourself", 4000);
      respond({ command: "envMergeScript", script: r.script, keep: r.keep, drop: r.drop });
      break;
    }
    case "envSize": {
      const r = await pyenvSize(String(msg.id || ""), !!msg.refresh);
      respond({ command: "envSize", id: msg.id, ...r });
      break;
    }
    case "envMigrate": {
      const target = pyenvsRoot();
      const env = pyenvList().find(e => e.id === msg.id);
      const r = await vscode.window.withProgress(
        { location: vscode.ProgressLocation.Notification, title: `Migrating “${env?.name || msg.id}” → ${target}…`, cancellable: false },
        () => pyenvMigrate(String(msg.id || ""), target),
      );
      if (r.ok) {
        respond({ command: "envList", data: envListForUi() });
        respond({ command: "envMigrated", ok: true });
        void sweepEnvSizes(respond);
        vscode.window.setStatusBarMessage("$(check) Environment migrated", 3000);
      } else {
        respond({ command: "envMigrated", ok: false, error: r.error, log: r.log });
      }
      break;
    }
    case "envDeleteScript": {
      const { script, error } = pyenvDeleteScript(String(msg.id || ""));
      if (error || !script) { respond({ command: "envDeleteScript", id: msg.id, error: error || "no script" }); break; }
      await vscode.env.clipboard.writeText(script);
      vscode.window.setStatusBarMessage("$(check) Delete command copied — run it yourself", 4000);
      respond({ command: "envDeleteScript", id: msg.id, script });
      break;
    }
    case "envCreate": {
      const input = msg.input || {};
      const r = await vscode.window.withProgress(
        { location: vscode.ProgressLocation.Notification, title: `Creating ${input.manager} environment “${input.name}”…`, cancellable: false },
        () => pyenvCreate(input),
      );
      if (r.ok) {
        respond({ command: "envList", data: envListForUi() });
        respond({ command: "envCreated", ok: true });
        void sweepEnvSizes(respond);
        vscode.window.setStatusBarMessage("$(check) Environment created", 3000);
      } else {
        respond({ command: "envCreated", ok: false, error: r.error, log: r.log });
      }
      break;
    }
    case "envCreatePickDir": {
      const picked = await vscode.window.showOpenDialog({
        canSelectFolders: true, canSelectFiles: false, canSelectMany: false,
        openLabel: "Select parent folder for the new environment",
      });
      respond({ command: "envCreatePickDir", dir: picked && picked.length ? picked[0].fsPath : "" });
      break;
    }
    case "envActivate": {
      const { lines, display, error } = pyenvActivateCommands(String(msg.id || ""));
      if (error || !lines.length) { respond({ command: "envActivate", id: msg.id, error: error || "no activation command" }); break; }
      const env = pyenvList().find(e => e.id === msg.id);
      const term = vscode.window.createTerminal(`env: ${env?.name || msg.id}`);
      term.show();
      for (const line of lines) term.sendText(line, true); // per-line: works in PowerShell 5.1 and bash
      respond({ command: "envActivate", id: msg.id, script: display, termName: `env: ${env?.name || msg.id}` });
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

    case "skillSetPinned": {
      const name = String(msg.name || "");
      if (skillSetPinned(name, !!msg.pinned)) {
        gitCommit(`${msg.pinned ? "pin" : "unpin"}(skill): ${name}`);
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
        file: p.file ?? "", conclusions: p.conclusions ?? [], implementation: p.implementation ?? [],
        assumptions: p.assumptions ?? [], cites: p.cites ?? [],
        category: p.category ?? "", kind: p.kind ?? "paper", group: p.group ?? "Papers", pinned: !!p.pinned,
      });
      gitCommit(p.slug ? `update(paper): ${slug}` : `add(paper): ${slug}`);
      respond({ command: "saved" });
      vscode.window.setStatusBarMessage("$(check) Paper saved", 3000);
      break;
    }

    case "paperPicker": {
      respond({ command: "paperPicker", data: (paperList() as any[]).map(p => ({ slug: p.slug, title: p.title })) });
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

    case "openStoreFolder": {
      const area = String(msg.area || "");
      if (!["scripts", "packages", "notes", "skills", "papers", "prompts"].includes(area)) break;
      const root = path.join(getStorePath(), area);
      const full = path.join(root, String(msg.rel || ""));
      if (!path.resolve(full).startsWith(path.resolve(root))) break;
      if (!fs.existsSync(full)) { vscode.window.showWarningMessage(`Folder not found: ${msg.rel}`); break; }
      await vscode.commands.executeCommand("vscode.openFolder", vscode.Uri.file(full), { forceNewWindow: true });
      break;
    }
    case "openStoreFile": {
      const area = String(msg.area || "");
      if (!["scripts", "packages", "notes", "skills", "papers", "prompts"].includes(area)) break;
      const root = path.join(getStorePath(), area);
      const full = path.join(root, String(msg.rel || ""));
      if (!path.resolve(full).startsWith(path.resolve(root))) break;
      if (!fs.existsSync(full)) { vscode.window.showWarningMessage(`File not found: ${msg.rel}`); break; }
      const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(full));
      await vscode.window.showTextDocument(doc, { preview: false });
      break;
    }

    case "openKnowledgeContent": {
      const area = String(msg.area || "") as KnowledgeMarkdownArea;
      if (area !== "skills" && area !== "notes" && area !== "papers") break;
      await openStoreMarkdown(area, String(msg.key || ""));
      break;
    }

    case "editKnowledgeMetadata": {
      const area = String(msg.area || "") as KnowledgeMarkdownArea;
      if (area !== "skills" && area !== "notes" && area !== "papers") break;
      await editMarkdownMetadata(knowledgeContentUri(area, String(msg.key || "")));
      break;
    }

    case "updateKnowledgeMetadataField": {
      const area = String(msg.area || "") as KnowledgeMarkdownArea;
      const key = String(msg.key || "");
      const field = String(msg.field || "");
      const value = String(msg.value ?? "").trim();
      const rejectMetadataUpdate = (error: string): void => {
        vscode.window.showWarningMessage(error);
        respond({ command: "metadataUpdateResult", data: { ok: false, error } });
      };
      if (!(["skills", "notes", "papers"] as string[]).includes(area)
          || !["title", "tags", "description", "source_project"].includes(field)
          || (field === "source_project" && area !== "skills")) break;
      if (field === "title" && (!value || /[\\/]/.test(value))) {
        rejectMetadataUpdate("Title is required and cannot contain slashes.");
        break;
      }
      const tags = value.split(",").map(tag => tag.trim()).filter(Boolean);
      let refreshed: any;
      let newKey = key;
      if (area === "skills") {
        const listed = (skillList() as any[]).find(item => (item.category ? `${item.category}/${item.name}` : item.name) === key);
        const current = listed && skillGet(listed.name);
        if (!current) { rejectMetadataUpdate(`Skill not found: ${key}`); break; }
        const name = field === "title" ? value : current.name;
        const safeName = storeSafeName(name);
        const destinationKey = current.category ? `${current.category}/${safeName}` : safeName;
        const destinationExists = destinationKey !== key && fs.existsSync(path.join(getStorePath(), "skills", `${destinationKey}.md`));
        if ((name !== current.name && skillGet(name)) || destinationExists) { rejectMetadataUpdate(`A skill file already exists at "${destinationKey}.md". No files were changed.`); break; }
        skillUpsert({
          name, content: current.content, category: current.category,
          description: field === "description" ? value : current.description,
          tags: field === "tags" ? tags : JSON.parse(current.tags || "[]"),
          source_project: field === "source_project" ? value : current.source_project,
        });
        if (name !== current.name) skillDelete(current.name);
        newKey = destinationKey;
        refreshed = { type: "skill", ...skillGet(name) };
      } else if (area === "notes") {
        const current = noteGet(key);
        if (!current) { rejectMetadataUpdate(`Note not found: ${key}`); break; }
        const title = field === "title" ? value : current.title;
        const safeTitle = storeSafeName(title);
        newKey = current.category ? `${current.category}/${safeTitle}` : safeTitle;
        if (newKey !== current.slug && noteGet(newKey)) { rejectMetadataUpdate(`A note already exists at "${newKey}.md". No files were changed.`); break; }
        noteUpsert({
          slug: current.slug, title, content: current.content, type: current.type,
          tags: field === "tags" ? tags : JSON.parse(current.tags || "[]"),
          category: current.category, pinned: current.pinned,
          description: field === "description" ? value : current.description,
        });
        const updated = noteGet(newKey);
        refreshed = updated && { ...updated, note_type: updated.type, type: "note" };
      } else {
        const current = paperGet(key);
        if (!current) { rejectMetadataUpdate(`Paper or idea not found: ${key}`); break; }
        const title = field === "title" ? value : current.title;
        const safeTitle = storeSafeName(title);
        newKey = current.category ? `${current.category}/${safeTitle}` : safeTitle;
        if (newKey !== current.slug && paperGet(newKey)) { rejectMetadataUpdate(`A paper or idea already exists at "${newKey}.md". No files were changed.`); break; }
        paperUpsert({
          ...current, slug: current.slug, title,
          tags: field === "tags" ? tags : current.tags,
          description: field === "description" ? value : current.description,
        });
        refreshed = { type: "paper", ...paperGet(newKey) };
      }
      if (!refreshed) break;
      gitCommit(`metadata(${area}): ${key} ${field}`);
      _treeProvider?.refresh();
      respond({ command: "detail", data: refreshed });
      respond({ command: "metadataUpdateResult", data: { ok: true, field, key: newKey } });
      vscode.window.setStatusBarMessage(`$(check) ${field === "source_project" ? "Source" : field} updated`, 3000);
      break;
    }

    case "packageDelete": {
      const name = String(msg.name || "").trim();
      if (!name) break;
      const dir = path.join(getStorePath(), "packages", name);
      if (!fs.existsSync(dir)) { vscode.window.showWarningMessage(`Package not found: ${name}`); break; }
      // Second confirmation (native modal) — first one happens in the webview.
      const CONFIRM = "Delete Package";
      const pick = await vscode.window.showWarningMessage(
        `Permanently delete package "${name}"? This removes the entire folder and cannot be undone.`,
        { modal: true, detail: dir },
        CONFIRM
      );
      if (pick !== CONFIRM) { respond({ command: "saved" }); break; }
      if (packageDelete(name)) {
        gitCommit(`delete(package): ${name}`);
        _treeProvider?.refresh();
        vscode.window.setStatusBarMessage("$(check) Package deleted", 3000);
        respond({ command: "list", tab: "packages", data: packagesWithGit() });
      } else {
        vscode.window.showErrorMessage(`Failed to delete package: ${name}`);
        respond({ command: "saved" });
      }
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

    case "createScript": {
      const rel = await createScriptAtFolder(String(msg.folder || ""));
      if (rel) respond({ command: "saved" });
      break;
    }

    case "deleteScript": {
      try { if (await deleteScriptAtPath(String(msg.relPath || ""))) respond({ command: "saved" }); }
      catch (e: any) { vscode.window.showErrorMessage(`Delete failed: ${e.message}`); }
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
          id: session.id, magicCode: createSyncMagicCode(session), expires: session.expires.toISOString(),
          contentTypes: session.contentTypes, selected: session.selected,
          summary: syncSummary(session),
        }});
      } catch (e: any) {
        respond({ command: "syncError", data: { error: e.message } });
      }
      break;
    }

    case "getSyncSessions": {
      const sessions = syncServer.allSessions().map(s => ({
        id: s.id,
        expires: s.expires.toISOString(), enabled: s.enabled,
        skillCount: s.selected.skills.length || "all",
        summary: syncSummary(s),
        created: s.created.toISOString(),
      }));
      respond({ command: "syncSessions", data: { sessions } });
      break;
    }

    case "revokeSync": {
      syncServer.revokeSession(msg.id);
      const sessions = syncServer.allSessions().map(s => ({
        id: s.id,
        expires: s.expires.toISOString(), enabled: s.enabled,
        skillCount: s.selected.skills.length || "all",
        summary: syncSummary(s),
        created: s.created.toISOString(),
      }));
      respond({ command: "syncSessions", data: { sessions } });
      vscode.window.setStatusBarMessage("$(circle-slash) Magic Code revoked", 3000);
      break;
    }

    case "joinSync": {
      const mode = msg.mode === "group" ? "group" : "overwrite";
      try {
        const { syncUrl, username, password } = parseSyncMagicCode(msg.magicCode);
        const response = await fetch(`${syncUrl}/sync/bundle`, {
          headers: { "Authorization": "Basic " + Buffer.from(`${username}:${password}`).toString("base64") },
          signal: AbortSignal.timeout(15_000),
        });
        if (!response.ok) {
          respond({ command: "syncError", data: { error: `Server returned ${response.status}: ${await response.text()}` } });
          return;
        }
        const bundle = await response.json() as any;
        const from = bundle?.from ?? "remote";
        // "group" mode isolates everything under <type>/_incoming/<label>/… so
        // nothing overwrites existing items; the user merges offline afterwards.
        const seg = (s: string) => String(s || "").trim().replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40);
        const stamp = () => { const d = new Date(), p = (n: number) => String(n).padStart(2, "0"); return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}`; };
        const label = mode === "group" ? (seg(msg.groupLabel) || `${seg(from)}-${stamp()}`) : "";
        const prefix = label ? `_incoming/${label}` : "";
        const pcat = (c?: string) => prefix ? (c ? `${prefix}/${c}` : prefix) : (c || "");
        const slugPfx = prefix ? prefix.replace(/[^A-Za-z0-9]+/g, "-").replace(/^-+|-+$/g, "") : "";
        const counts: Record<string, number> = {};
        for (const s of bundle?.skills ?? []) {
          const m = s.metadata ?? {};
          skillUpsert({ name: s.name, content: s.content,
            description: m.description, category: pcat(m.category),
            tags: m.tags, source_project: m.source_project });
          counts.skills = (counts.skills ?? 0) + 1;
        }
        if (bundle?.notes?.length) {
          const notes = prefix ? bundle.notes.map((n: any) => ({ ...n, category: pcat(n.category) })) : bundle.notes;
          counts.notes = noteImport(notes);
        }
        const importedSlugs = new Set((bundle?.papers ?? []).map((p: any) => p.slug));
        const remap = (s: string) => (prefix && importedSlugs.has(s)) ? `${slugPfx}-${s}` : s;
        for (const p of bundle?.papers ?? []) {
          paperUpsert({
            slug: prefix ? `${slugPfx}-${p.slug}` : p.slug, title: p.title, content: p.content ?? "",
            authors: p.authors, year: p.year, topic: p.topic, publisher: p.publisher,
            tags: p.tags, url: p.url, file: p.file, conclusions: p.conclusions,
            implementation: p.implementation, assumptions: p.assumptions, cites: [],
            category: pcat(p.category), group: prefix ? label : p.group,
          });
          counts.papers = (counts.papers ?? 0) + 1;
        }
        for (const p of bundle?.papers ?? []) {
          const slug = prefix ? `${slugPfx}-${p.slug}` : p.slug;
          const current = paperGet(slug);
          if (!current) continue;
          const cites = Array.isArray(p.cites) ? p.cites.map((cite: any) => {
            if (typeof cite === "string") return { paper: remap(cite), note: "" };
            return cite?.paper ? { paper: remap(cite.paper), note: cite.note || "" } : cite;
          }) : [];
          paperUpsert({ ...current, cites });
        }
        if (bundle?.prompts?.length) {
          const prompts = prefix ? bundle.prompts.map((x: any) => ({ ...x, project: `${prefix}/${x.project}` })) : bundle.prompts;
          counts.prompts = promptImport(prompts);
        }
        if (bundle?.scripts?.length) {
          const scripts = prefix ? bundle.scripts.map((x: any) => ({ ...x, category: pcat(x.category) })) : bundle.scripts;
          counts.scripts = scriptImport(scripts);
        }
        if (bundle?.packages?.length) {
          const pkgs = prefix ? bundle.packages.map((x: any) => ({ ...x, name: `${prefix}/${x.name}` })) : bundle.packages;
          counts.packages = packageImport(pkgs);
        }
        const total   = Object.values(counts).reduce((a, b) => a + b, 0);
        const summary = Object.entries(counts).map(([k, v]) => `${v} ${k}`).join(", ");
        gitCommit(`sync: ${summary} from ${from}${label ? ` (group ${label})` : ""}`);
        respond({ command: "syncJoined", data: { count: total, summary, from, group: label || undefined } });
        respond({ command: "saved" });
        vscode.window.setStatusBarMessage(`$(cloud-download) Synced: ${summary}${label ? " → " + label : ""}`, 5000);
      } catch (e: any) {
        respond({ command: "syncError", data: { error: e.message } });
      }
      break;
    }

    case "verifySyncMagicCode": {
      try {
        parseSyncMagicCode(msg.magicCode);
        respond({ command: "syncMagicCodeVerified", data: { requestId: msg.requestId, ok: true } });
      } catch (error: any) {
        respond({ command: "syncMagicCodeVerified", data: { requestId: msg.requestId, ok: false, error: error?.message || "Magic Code is invalid." } });
      }
      break;
    }

    case "getSyncSkillList": {
      const rows = skillList() as any[];
      respond({ command: "syncSkillList", data: { skills: rows.map((r: any) => ({ name: r.name, category: r.category })) } });
      break;
    }

    case "getSyncContentList": {
      const skills   = (skillList() as any[]).map((r: any) => ({ id: r.name,  label: r.name,  cat: r.category ?? "", meta: "" }));
      const notes    = (noteList(undefined, 200) as any[]).map((r: any) => ({ id: r.slug,  label: r.title, cat: r.category ?? "", meta: r.type }));
      const papers   = (paperList() as any[]).map((p: any) => ({ id: p.slug, label: p.title, cat: p.category ?? p.topic ?? "", meta: p.year ? String(p.year) : "" }));
      const prompts  = promptList().flatMap(t => ({ id: `${t.project}/${t.task}`, label: t.task, cat: t.project, meta: "" }));
      const scripts  = (scriptList() as any[]).map((s: any) => ({ id: s.path, label: s.file, cat: s.category ?? "", meta: s.lang }));
      const packages = packageList().map((p: any) => ({ id: p.name, label: p.name, cat: "", meta: p.lang }));
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
      respond({ command: "mcpStatus", data: mcpPanelStatusData() });
      void offerMcpServerRegeneration(context);
      void offerPkmSkillProjectionUpdate(context);
      break;
    }

    case "pkmSkillInject": {
      try {
        const target = injectPkmSkill(context, String(msg.id || ""));
        log.action("pkmSkill.inject", { target: target.id, path: target.skillPath, state: target.state });
        respond({ command: "mcpStatus", data: mcpPanelStatusData() });
        vscode.window.setStatusBarMessage("$(check) PKM Skill injected", 4000);
      } catch (error: any) {
        respond({ command: "mcpError", data: { error: error?.message || String(error) } });
      }
      break;
    }

    case "pkmSkillRemove": {
      try {
        removeInjectedPkmSkill(context, String(msg.id || ""));
        log.action("pkmSkill.remove", { target: String(msg.id || "") });
        respond({ command: "mcpStatus", data: mcpPanelStatusData() });
      } catch (error: any) {
        respond({ command: "mcpError", data: { error: error?.message || String(error) } });
      }
      break;
    }

    case "pkmSkillBrowseCustomTarget": {
      const picked = await vscode.window.showOpenDialog({ canSelectFiles: false, canSelectFolders: true, canSelectMany: false, title: "Select an Agent Skills root folder" });
      if (!picked?.[0]) break;
      const label = await vscode.window.showInputBox({ title: "Custom Agent Target", prompt: "Name shown in PKM Config.", value: path.basename(picked[0].fsPath) || "Custom Agent" });
      if (label === undefined) break;
      await addPkmSkillCustomTarget(context, picked[0].fsPath, label);
      log.action("pkmSkill.customTarget.add", { path: picked[0].fsPath });
      respond({ command: "mcpStatus", data: mcpPanelStatusData() });
      break;
    }

    case "pkmSkillEnterCustomTarget": {
      const windows = process.platform === "win32";
      const entered = await vscode.window.showInputBox({
        title: "Enter Agent Skills Root",
        prompt: "PKM will create pkm-skills/SKILL.md inside this directory. Environment variables and ~ are supported.",
        placeHolder: windows ? "%USERPROFILE%\\.copilot\\skills or C:\\AgentSkills" : "~/.copilot/skills or /home/me/agent-skills",
        validateInput: value => {
          try { resolvePkmSkillTargetPath(value); return undefined; }
          catch (error) { return (error as Error).message; }
        },
      });
      if (entered === undefined) break;
      const resolved = resolvePkmSkillTargetPath(entered);
      const label = await vscode.window.showInputBox({
        title: "Custom Agent Target",
        prompt: `Resolved root: ${resolved}`,
        value: path.basename(resolved) || "Custom Agent",
      });
      if (label === undefined) break;
      await addPkmSkillCustomTarget(context, resolved, label);
      log.action("pkmSkill.customTarget.add", { path: resolved, source: "manual" });
      respond({ command: "mcpStatus", data: mcpPanelStatusData() });
      break;
    }

    case "pkmSkillRemoveCustomTarget": {
      try { removeInjectedPkmSkill(context, String(msg.id || "")); } catch { /* an absent projection is fine */ }
      await removePkmSkillCustomTarget(context, String(msg.id || ""));
      log.action("pkmSkill.customTarget.remove", { target: String(msg.id || "") });
      respond({ command: "mcpStatus", data: mcpPanelStatusData() });
      break;
    }

    case "pkmSkillOpenProposals": {
      const directory = path.join(getStorePath(), "_proposals", "skills");
      fs.mkdirSync(directory, { recursive: true });
      await vscode.commands.executeCommand("revealFileInOS", vscode.Uri.file(directory));
      log.action("pkmSkill.proposals.open", { directory });
      break;
    }

    case "mcpDetectPython": {
      void streamMcpPythonCandidates(respond);
      break;
    }

    case "mcpCancelPythonScan": {
      cancelMcpPythonScan();
      respond({ command: "mcpPythonScanComplete", data: { cancelled: true, text: "Scan cancelled." } });
      break;
    }

    case "mcpBrowsePython": {
      const picks = await vscode.window.showOpenDialog({
        canSelectFiles: true, canSelectFolders: false, canSelectMany: false,
        openLabel: "Select Python executable", title: "Select Python 3.10+ for PKM MCP",
      });
      if (picks?.[0]) {
        const result = validateMcpPython(picks[0].fsPath);
        respond({ command: "mcpPythonResult", data: { ...result, valid: !result.error, source: "configured" } });
      }
      break;
    }

    case "mcpSetPython": {
      const result = validateMcpPython(String(msg.path || ""));
      if (result.error) {
        respond({ command: "mcpPythonResult", data: { ...result, valid: false, source: "configured", saved: false } });
        break;
      }
      await vscode.workspace.getConfiguration("personalKnowledge").update("mcpPythonPath", result.path, vscode.ConfigurationTarget.Global);
      respond({ command: "mcpRuntimeProgress", data: { text: "Creating or repairing the managed PKM MCP runtime and installing dependencies…" } });
      try {
        const runtime = await ensureMcpRuntime(context);
        refreshMcpDefinitions();
        respond({ command: "mcpPythonResult", data: { ...result, valid: true, source: "configured", saved: true, runtime } });
        _treeProvider?.refresh();
        respond({ command: "envList", data: envListForUi() });
      } catch (error: any) {
        respond({ command: "mcpRuntimeResult", data: { ok: false, error: error?.message || String(error), commands: mcpRuntimeManualCommands(result.path) } });
      }
      break;
    }

    case "mcpRepairRuntime": {
      const base = detectMcpPython();
      if (!base.valid) { respond({ command: "mcpRuntimeResult", data: { ok: false, error: base.error, commands: [] } }); break; }
      respond({ command: "mcpRuntimeProgress", data: { text: "Repairing the managed PKM MCP runtime…" } });
      try {
        const runtime = await ensureMcpRuntime(context);
        refreshMcpDefinitions();
        respond({ command: "mcpRuntimeResult", data: { ok: true, runtime } });
        _treeProvider?.refresh();
        respond({ command: "envList", data: envListForUi() });
      } catch (error: any) {
        respond({ command: "mcpRuntimeResult", data: { ok: false, error: error?.message || String(error), commands: mcpRuntimeManualCommands(base.path) } });
      }
      break;
    }

    case "generateMcp": {
      try {
        if (!mcpRuntimeStatus().healthy) throw new Error("Managed PKM MCP runtime is not healthy. Create or Repair it first.");
        const preview = !!msg.previewOnly;
        const info = preview
          ? { serverPath: mcpStatus().serverPath, configSnippet: combinedMcpRegistry() }
          : generateMcpServer(context);
        if (!preview) refreshMcpDefinitions();
        respond({ command: "mcpGenerated", data: { ...info, preview } });
        if (!preview) vscode.window.setStatusBarMessage("$(check) MCP server created", 4000);
      } catch (e: any) {
        respond({ command: "mcpError", data: { error: e.message } });
      }
      break;
    }

    case "generateChatMcp": {
      try {
        if (!mcpRuntimeStatus().healthy) throw new Error("Managed PKM MCP runtime is not healthy. Create or Repair it first.");
        const preview = !!msg.previewOnly;
        const info = preview
          ? { serverPath: mcpStatus().serverPath, configSnippet: combinedMcpRegistry() }
          : generateMcpServer(context);
        if (!preview) refreshMcpDefinitions();
        respond({ command: "mcpGenerated", data: { ...info, preview } });
        if (!preview) vscode.window.setStatusBarMessage("$(check) Unified PKM MCP server created", 4000);
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

async function offerMcpRuntimeSetup(context: vscode.ExtensionContext): Promise<void> {
  if (context.globalState.get<boolean>("mcpRuntimeSetupOffered.v1", false) || mcpRuntimeStatus().healthy) return;
  await context.globalState.update("mcpRuntimeSetupOffered.v1", true);
  const base = detectMcpPython();
  const openSetup = () => { const panel = getOrCreatePanel(context); panel.reveal(vscode.ViewColumn.One); if (_panelReady) panel.webview.postMessage({ command: "openTab", tab: "mcp" }); else _pendingTab = "mcp"; };
  if (!base.valid) {
    const choice = await vscode.window.showWarningMessage(
      "Personal Knowledge Manager is ready, but MCP requires Python 3.10+. Install Python or specify an executable in Config. PKM features remain available.",
      "Open Config", "Later");
    if (choice === "Open Config") openSetup();
    return;
  }
  const choice = await vscode.window.showInformationMessage(
    `Python ${base.version} detected at ${base.path}. Create a dedicated runtime for the unified PKM MCP server?`,
    "Create MCP Runtime", "Choose Another Python", "Later");
  if (choice === "Choose Another Python") { openSetup(); return; }
  if (choice !== "Create MCP Runtime") return;
  try {
    await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: "Creating PKM MCP Runtime", cancellable: false }, async progress => {
      progress.report({ message: "Creating environment and installing dependencies…" });
      await ensureMcpRuntime(context);
    });
    _treeProvider?.refresh();
    vscode.window.showInformationMessage("PKM MCP Runtime is ready and registered in Envs.", "Open Config")
      .then(result => { if (result === "Open Config") openSetup(); });
  } catch (error: any) {
    vscode.window.showErrorMessage(`MCP runtime setup failed: ${error?.message || String(error)}`, "Open Config")
      .then(result => { if (result === "Open Config") openSetup(); });
  }
}

function openMcpSetup(context: vscode.ExtensionContext, highlightRegenerate = false): void {
  const mcpPanel = getOrCreatePanel(context);
  mcpPanel.reveal(vscode.ViewColumn.One);
  if (_panelReady) {
    void mcpPanel.webview.postMessage({ command: "openTab", tab: "mcp" });
    if (highlightRegenerate) void mcpPanel.webview.postMessage({ command: "highlightMcpRegenerate" });
  } else {
    _pendingTab = "mcp";
    _pendingMcpRegenerateHighlight ||= highlightRegenerate;
  }
}

async function regenerateMcpServerCode(context: vscode.ExtensionContext): Promise<void> {
  try {
    const info = generateMcpServer(context);
    refreshMcpDefinitions();
    _treeProvider?.refresh();
    panel?.webview.postMessage({ command: "mcpStatus", data: mcpPanelStatusData() });
    await vscode.window.showInformationMessage(
      `PKM MCP server code regenerated at ${info.serverPath}. Restart the pkm MCP server to load it.`,
      "Open Config",
    ).then(choice => { if (choice === "Open Config") openMcpSetup(context, true); });
  } catch (error: any) {
    const choice = await vscode.window.showErrorMessage(
      `Could not regenerate PKM MCP server code: ${error?.message || String(error)}`,
      "Open Config",
    );
    if (choice === "Open Config") openMcpSetup(context, true);
  }
}

async function offerMcpServerRegeneration(context: vscode.ExtensionContext): Promise<void> {
  const status = mcpStatus();
  if (status.current || !mcpRuntimeStatus().healthy) return;
  const promptKey = `${status.installedVersion || "missing"}->${status.expectedVersion}`;
  if (_mcpRegenerationPromptedFor === promptKey) return;
  _mcpRegenerationPromptedFor = promptKey;
  const installed = status.installed ? `v${status.installedVersion}` : "missing";
  const choice = await vscode.window.showWarningMessage(
    `PKM MCP server code is ${installed}; v${status.expectedVersion} is required. Regenerate it now, then restart the pkm MCP server.`,
    "Regenerate Server Code", "Open Config", "Later",
  );
  if (choice === "Regenerate Server Code") await regenerateMcpServerCode(context);
  else if (choice === "Open Config") openMcpSetup(context, true);
}

async function offerPkmSkillProjectionUpdate(context: vscode.ExtensionContext): Promise<void> {
  if (!getStorePath()) return;
  const status = pkmSkillProjectionStatus(context);
  const stale = status.targets.filter(target => target.state === "outdated" || target.state === "content-outdated");
  if (!stale.length) return;
  const promptKey = `${status.routerVersion}:${status.targets.map(target => `${target.id}:${target.expectedSourceHash}`).join("|")}`;
  if (_pkmSkillUpdatePromptedFor === promptKey) return;
  _pkmSkillUpdatePromptedFor = promptKey;
  const choice = await vscode.window.showWarningMessage(
    `PKM Skill Router needs updating in ${stale.length} Agent target${stale.length === 1 ? "" : "s"}.`,
    "Update Injected Skill", "Open Config", "Later",
  );
  if (choice === "Update Injected Skill") {
    for (const target of stale) injectPkmSkill(context, target.id);
    log.action("pkmSkill.updateAll", { targets: stale.map(target => target.id) });
    panel?.webview.postMessage({ command: "mcpStatus", data: mcpPanelStatusData() });
  } else if (choice === "Open Config") {
    openMcpSetup(context);
  }
}

// ── Sidebar tree provider ──────────────────────────────────────────────────
type PkNodeType =
  | 'root-skills' | 'root-notes' | 'root-papers' | 'root-prompts' | 'root-packages' | 'root-scripts' | 'root-chatroom' | 'root-mcp'
  | 'chat-hosted-group' | 'chat-joined-group' | 'chat-hosted-room' | 'chat-room'
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
      "root-packages": "package", "root-scripts": "terminal", "root-chatroom": "comment-discussion", "root-mcp": "server-process",
      "chat-hosted-group": "broadcast", "chat-joined-group": "plug", "chat-hosted-room": "broadcast", "chat-room": "comment",
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
    else if (nodeType === 'root-prompts' || nodeType === 'prompt-project' || nodeType === 'prompt-task' || nodeType === 'prompt-version') this.contextValue = 'pk-prompts-container';
    else if (nodeType === 'root-scripts' || nodeType === 'script-folder') this.contextValue = 'pk-scripts-container';
    // Leaf items support right-click Edit
    else if (nodeType === 'skill')       this.contextValue = 'pk-skill-item';
    else if (nodeType === 'note')        this.contextValue = 'pk-note-item';
    else if (nodeType === 'paper')       this.contextValue = 'pk-paper-item';
    else if (nodeType === 'script-file') this.contextValue = 'pk-script-item';
  }
}

class PkTreeProvider implements vscode.TreeDataProvider<PkTreeItem> {
  constructor(private readonly context: vscode.ExtensionContext) {}
  private _onChange = new vscode.EventEmitter<PkTreeItem | undefined | void>();
  readonly onDidChangeTreeData = this._onChange.event;

  refresh(): void { this._onChange.fire(); }
  getTreeItem(e: PkTreeItem): vscode.TreeItem { return e; }

  getChildren(element?: PkTreeItem): PkTreeItem[] {
    const C = vscode.TreeItemCollapsibleState.Collapsed;
    if (!element) {
      const chatroom = new PkTreeItem("Chatroom", 'root-chatroom', C);
      chatroom.command = { command: "personalKnowledge.openChatroom", title: "Open Chatroom" };
      const mcp = new PkTreeItem("Config", "root-mcp", vscode.TreeItemCollapsibleState.None);
      mcp.command = { command: "personalKnowledge.setupMcp", title: "Open Config" };
      return [
        new PkTreeItem("Skills",   'root-skills',   vscode.TreeItemCollapsibleState.Collapsed),
        new PkTreeItem("Notes",    'root-notes',    C),
        new PkTreeItem("Papers",   'root-papers',   C),
        new PkTreeItem("Prompts",  'root-prompts',  C),
        new PkTreeItem("Packages", 'root-packages', C),
        new PkTreeItem("Scripts",  'root-scripts',  C),
        chatroom,
        mcp,
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
        case 'root-chatroom': return this._chatGroups();
        case 'chat-hosted-group': return this._hostedRooms();
        case 'chat-joined-group': return this._chatRooms();
      }
    } catch { /* DB/store not ready yet */ }
    return [];
  }

  private _chatGroups(): PkTreeItem[] {
    const recents = chatRecents(this.context);
    const hostedRooms = getChatMgr().hostedRoomsForNavigation();
    const hosted = new PkTreeItem("Hosted Rooms", "chat-hosted-group", vscode.TreeItemCollapsibleState.Collapsed);
    const joined = new PkTreeItem("Recent Joined Rooms", "chat-joined-group", vscode.TreeItemCollapsibleState.Collapsed);
    hosted.description = String(hostedRooms.length);
    joined.description = String(recents.length);
    return [hosted, joined];
  }

  private _hostedRooms(): PkTreeItem[] {
    return getChatMgr().hostedRoomsForNavigation().map(room => {
      const item = new PkTreeItem(room.roomName, "chat-hosted-room", vscode.TreeItemCollapsibleState.None, room);
      item.contextValue = room.active ? "pk-chat-hosted-room-active" : "pk-chat-hosted-room-stored";
      item.description = room.active ? "active" : room.canRehost ? "stored" : "unavailable";
      item.tooltip = room.active ? "Active hosted Room" : room.unavailableReason || "Stored Room · click to Rehost";
      item.command = { command: "personalKnowledge.openHostedRoomItem", title: room.active ? "Open Room" : "Rehost Room", arguments: [room.roomId] };
      return item;
    });
  }

  private _chatRooms(): PkTreeItem[] {
    return chatRecents(this.context)
      .sort((left, right) => right.lastJoined - left.lastJoined)
      .map(room => {
        const item = new PkTreeItem(room.room, "chat-room", vscode.TreeItemCollapsibleState.None, { id: room.id });
        item.description = `as ${room.user}`;
        item.tooltip = `${room.url}/${encodeURIComponent(room.room)}\nAlias: ${room.user}`;
        item.command = { command: "personalKnowledge.openChatRoomItem", title: "Open Room", arguments: [room.id] };
        return item;
      });
  }

  // ── Generic recursive path tree ──────────────────────────────────────────
  private static _maxDepth(): number {
    const d = vscode.workspace.getConfiguration("personalKnowledge").get<number>("maxTreeDepth", 4);
    return Math.max(1, Math.min(d ?? 4, 12));
  }

  /** Build a nested folder tree from entries {path, data}. */
  private _buildPathTree(entries: { path: string[]; data: any }[], maxDepth = PkTreeProvider._maxDepth()): PkFolder {
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

  private _addFolderPaths(root: PkFolder, folders: string[], maxDepth = PkTreeProvider._maxDepth()): PkFolder {
    for (const folder of folders) {
      let node = root;
      for (const segment of folder.split("/").filter(Boolean).slice(0, maxDepth - 1)) {
        if (!node.folders.has(segment)) node.folders.set(segment, { folders: new Map(), items: [] });
        node = node.folders.get(segment)!;
      }
    }
    return root;
  }

  // ── Skills (recursive by category path) ──────────────────────────────────
  private _skillRoot(): PkFolder {
    const entries = (skillList() as any[]).map(s => {
      const cat = (s.category || "").trim();
      const path = cat ? cat.split("/").map((x: string) => x.trim()).filter(Boolean) : ["(uncategorized)"];
      return { path, data: s };
    });
    return this._addFolderPaths(this._buildPathTree(entries), folderList("skills"));
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
        { path: [...path, name], relPath: [...path, name].join("/") });
      item.description = String(count);
      out.push(item);
    }
    for (const s of node.items.sort((a: any, b: any) => a.name.localeCompare(b.name))) {
      const item = new PkTreeItem(s.name, 'skill', vscode.TreeItemCollapsibleState.None,
        { key: s.category ? `${s.category}/${s.name}` : s.name, relPath: `${s.category ? `${s.category}/` : ""}${s.name}.md`, description: s.description });
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
    return this._addFolderPaths(this._buildPathTree(entries), folderList("notes"));
  }

  private _noteFolder(path: string[]): PkTreeItem[] {
    const node = this._navigate(this._noteRoot(), path);
    if (!node) return [];
    const out: PkTreeItem[] = [];
    for (const name of [...node.folders.keys()].sort((a, b) =>
      a === "(uncategorized)" ? 1 : b === "(uncategorized)" ? -1 : a.localeCompare(b))) {
      const folder = node.folders.get(name)!;
      const item = new PkTreeItem(name, 'note-folder', vscode.TreeItemCollapsibleState.Collapsed,
        { path: [...path, name], relPath: [...path, name].join("/") });
      item.description = String(this._countLeaves(folder));
      out.push(item);
    }
    for (const n of node.items.sort((a: any, b: any) => (b.updated_at || "").localeCompare(a.updated_at || ""))) {
      const item = new PkTreeItem(n.title, 'note', vscode.TreeItemCollapsibleState.None, { key: n.slug, relPath: `${n.slug}.md` });
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
    return this._addFolderPaths(this._buildPathTree(entries), folderList("papers"));
  }

  private _paperFolder(path: string[]): PkTreeItem[] {
    const node = this._navigate(this._paperRoot(), path);
    if (!node) return [];
    const out: PkTreeItem[] = [];
    for (const name of [...node.folders.keys()].sort((a, b) =>
      a === "(uncategorized)" ? 1 : b === "(uncategorized)" ? -1 : a.localeCompare(b))) {
      const folder = node.folders.get(name)!;
      const item = new PkTreeItem(name, 'paper-folder', vscode.TreeItemCollapsibleState.Collapsed,
        { path: [...path, name], relPath: [...path, name].join("/") });
      item.description = String(this._countLeaves(folder));
      out.push(item);
    }
    // Sort papers by citation count (popularity), then year desc
    for (const p of node.items.sort((a: any, b: any) => (b.citationCount - a.citationCount) || ((b.year || 0) - (a.year || 0)))) {
      const item = new PkTreeItem(p.title, 'paper', vscode.TreeItemCollapsibleState.None, { key: p.slug, relPath: `${p.slug}.md` });
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
    return this._addFolderPaths(this._buildPathTree(entries, Number.POSITIVE_INFINITY), folderList("scripts"), Number.POSITIVE_INFINITY);
  }

  private _scriptFolder(path: string[]): PkTreeItem[] {
    const node = this._navigate(this._scriptRoot(), path);
    if (!node) return [];
    const out: PkTreeItem[] = [];
    for (const name of [...node.folders.keys()].sort()) {
      const folder = node.folders.get(name)!;
      const item = new PkTreeItem(name, 'script-folder', vscode.TreeItemCollapsibleState.Collapsed,
        { path: [...path, name], relPath: [...path, name].join("/") });
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

type TreeMoveArea = "skills" | "notes" | "papers" | "prompts" | "scripts";
type TreeMoveLevel = "folder" | "file" | "project" | "task" | "version";
interface TreeMoveInfo { area: TreeMoveArea; relPath: string; level: TreeMoveLevel; }

function treeMoveInfo(item: PkTreeItem, asTarget = false): TreeMoveInfo | undefined {
  const rootAreas: Partial<Record<PkNodeType, TreeMoveArea>> = {
    "root-skills": "skills", "root-notes": "notes", "root-papers": "papers", "root-prompts": "prompts", "root-scripts": "scripts",
  };
  const rootArea = rootAreas[item.nodeType];
  if (rootArea) return asTarget ? { area: rootArea, relPath: "", level: rootArea === "prompts" ? "project" : "folder" } : undefined;
  const areaByType: Partial<Record<PkNodeType, TreeMoveArea>> = {
    "skill-folder": "skills", skill: "skills", "note-folder": "notes", note: "notes",
    "paper-folder": "papers", paper: "papers", "script-folder": "scripts", "script-file": "scripts",
  };
  const area = areaByType[item.nodeType];
  if (area) {
    if (item.nodeType.endsWith("folder")) {
      if (item.nodeData.relPath === "(uncategorized)") return asTarget ? { area, relPath: "", level: "folder" } : undefined;
      return { area, relPath: item.nodeData.relPath, level: "folder" };
    }
    return asTarget ? undefined : { area, relPath: item.nodeData.relPath, level: "file" };
  }
  if (item.nodeType === "prompt-project") return { area: "prompts", relPath: item.nodeData.project, level: "project" };
  if (item.nodeType === "prompt-task") return { area: "prompts", relPath: `${item.nodeData.project}/${item.nodeData.task}`, level: "task" };
  if (item.nodeType === "prompt-version") return { area: "prompts", relPath: `${item.nodeData.project}/${item.nodeData.task}/${item.nodeData.version}`, level: "version" };
  if (item.nodeType === "prompt-file" && !asTarget) {
    return { area: "prompts", relPath: `${item.nodeData.project}/${item.nodeData.task}/${item.nodeData.version}/${item.nodeData.file}`, level: "file" };
  }
  return undefined;
}

class PkTreeDragAndDropController implements vscode.TreeDragAndDropController<PkTreeItem> {
  private static readonly mime = "application/vnd.code.tree.personalKnowledge.sidebarView";
  readonly dragMimeTypes = [PkTreeDragAndDropController.mime];
  readonly dropMimeTypes = [PkTreeDragAndDropController.mime];

  handleDrag(source: readonly PkTreeItem[], dataTransfer: vscode.DataTransfer): void {
    const info = source.length === 1 ? treeMoveInfo(source[0]) : undefined;
    if (info) dataTransfer.set(PkTreeDragAndDropController.mime, new vscode.DataTransferItem(JSON.stringify(info)));
  }

  async handleDrop(target: PkTreeItem | undefined, dataTransfer: vscode.DataTransfer): Promise<void> {
    if (!target) { vscode.window.showInformationMessage("Drop onto a category root or folder."); return; }
    const raw = dataTransfer.get(PkTreeDragAndDropController.mime);
    const destination = treeMoveInfo(target, true);
    if (!raw || !destination) { vscode.window.showWarningMessage("Files can only be dropped onto folders."); return; }
    let source: TreeMoveInfo;
    try { source = JSON.parse(await raw.asString()); } catch { return; }
    if (source.area !== destination.area) { vscode.window.showWarningMessage("Items cannot be moved between knowledge areas."); return; }
    if (source.area === "prompts") {
      const allowedParent: Record<TreeMoveLevel, TreeMoveLevel | undefined> = { project: "project", task: "project", version: "task", file: "version", folder: undefined };
      const requiredDepth: Partial<Record<TreeMoveLevel, number>> = { project: 0, task: 1, version: 2, file: 3 };
      const destinationDepth = destination.relPath ? destination.relPath.split("/").length : 0;
      if (allowedParent[source.level] !== destination.level || destinationDepth !== requiredDepth[source.level]) {
        vscode.window.showWarningMessage("Prompts must keep the project / task / version / file hierarchy.");
        return;
      }
    }
    const result = storeEntryMove(source.area, source.relPath, destination.relPath);
    if (!result.ok) { vscode.window.showWarningMessage(result.error || "Move failed."); return; }
    gitCommit(`move(${source.area}): ${source.relPath} -> ${result.newPath}`);
    _treeProvider?.refresh();
    panel?.webview.postMessage({ command: "reloaded" });
    vscode.window.setStatusBarMessage(`$(move) Moved to ${result.newPath}`, 3000);
  }
}

// ── First-run setup wizard ─────────────────────────────────────────────────
async function firstTimeSetup(context: vscode.ExtensionContext): Promise<string | undefined> {
  const defaultPath = path.join(require("os").homedir(), "personal-knowledge");

  const pick = await vscode.window.showInformationMessage(
    "Welcome to Personal Knowledge Manager! Choose where to store your knowledge base:",
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
      title: "Personal Knowledge Manager — store location",
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
  chatCtx = context;
  await migrateChatRecents(context);
  const applyChatArchiveCfg = () => {
    const c = vscode.workspace.getConfiguration("personalKnowledge");
    const mb = Math.max(0, c.get<number>("chatHistoryLimitMB") ?? 10);
    const dir = path.join(context.globalStorageUri.fsPath, "chat-history");
    getChatMgr().configureArchive(dir, Math.round(mb * 1024 * 1024));
    const store = getStorePath();
    if (store) getChatMgr().configurePersistence(path.join(store, "chatrooms"), getChatInstallationId(context), context.secrets);
  };
  applyChatArchiveCfg();
  context.subscriptions.push(
    vscode.workspace.registerFileSystemProvider("pkm-content", new KnowledgeContentFileSystem(), { isCaseSensitive: true }),
    vscode.languages.registerCodeLensProvider([{ language: "markdown", scheme: "file" }, { language: "markdown", scheme: "pkm-content" }], new KnowledgeMetadataCodeLensProvider()),
    vscode.workspace.onDidChangeConfiguration(e => {
      if (e.affectsConfiguration("personalKnowledge.logLevel")) log.refreshLevel();
      if (e.affectsConfiguration("personalKnowledge.maxTreeDepth")) _treeProvider?.refresh();
      if (e.affectsConfiguration("personalKnowledge.chatHistoryLimitMB")) applyChatArchiveCfg();
      if (e.affectsConfiguration("personalKnowledge.storePath") || e.affectsConfiguration("personalKnowledge.environmentsPath") || e.affectsConfiguration("personalKnowledge.mcpPythonPath")) refreshMcpDefinitions();
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
        "Personal Knowledge Manager: setup not completed. Click the sidebar icon or open the panel to configure.",
        "Configure now"
      ).then(v => { if (v) ensureSetup(context); });
    }
    configuredPath = chosen ?? "";
  }

  fsSetStorePath(configuredPath);
  storageSetStorePath(configuredPath);
  applyChatArchiveCfg();

  // Servers + Python Environments subsystems (machine-local runtime state).
  try {
    const stateBase = context.globalStorageUri.fsPath;
    initPyenvs(path.join(stateBase, "environments"), m => log.info(`[env] ${m}`));
    if (configuredPath) {
      const pport = vscode.workspace.getConfiguration("personalKnowledge").get<number>("serversProxyPort", 39501);
      initServers(path.join(getStorePath(), "servers"), path.join(stateBase, "servers"), pport, m => log.info(`[servers] ${m}`));
    }
  } catch (e: any) { log.warn(`servers/env init failed: ${e?.message}`); }

  registerNativeMcpProvider(context);

  // Register sidebar tree view + commands FIRST so they're always available
  const treeProvider = new PkTreeProvider(context);
  _treeProvider = treeProvider;
  const treeView = vscode.window.createTreeView("personalKnowledge.sidebarView", {
    treeDataProvider: treeProvider,
    dragAndDropController: new PkTreeDragAndDropController(),
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

    vscode.commands.registerCommand("personalKnowledge.editMarkdownMetadata", editMarkdownMetadata),
    vscode.commands.registerCommand("personalKnowledge.editMarkdownContent", async (area: KnowledgeMarkdownArea, key: string) => {
      await openStoreMarkdown(area, key);
    }),

    // ── Add new item at a folder (right-click on container) ────────────────
    vscode.commands.registerCommand("personalKnowledge.addSkillHere", async (item?: PkTreeItem) => {
      if (!(await ensureSetup(context))) return;
      const cat = await selectKnowledgeFolder("skills", categoryFromTreeItem(item));
      if (cat === undefined) return;
      const name = await vscode.window.showInputBox({ prompt: "New skill name", placeHolder: "e.g. my-new-skill" });
      if (!name?.trim()) return;
      if (skillGet(name.trim())) { vscode.window.showWarningMessage(`Skill already exists: ${name.trim()}`); return; }
      skillUpsert({ name: name.trim(), content: "", category: cat || undefined });
      gitCommit(`add(skill): ${name.trim()}`);
      treeProvider.refresh();
      await openStoreMarkdown("skills", cat ? `${cat}/${name.trim()}` : name.trim());
    }),

    vscode.commands.registerCommand("personalKnowledge.addNoteHere", async (item?: PkTreeItem) => {
      if (!(await ensureSetup(context))) return;
      const cat = await selectKnowledgeFolder("notes", categoryFromTreeItem(item));
      if (cat === undefined) return;
      const title = await vscode.window.showInputBox({ prompt: "New note title", placeHolder: "e.g. Investigation findings" });
      if (!title?.trim()) return;
      const key = (cat ? cat + "/" : "") + title.trim();
      if (noteGet(key)) { vscode.window.showWarningMessage(`Note already exists: ${key}`); return; }
      noteUpsert({ slug: key, title: title.trim(), content: "", type: "general", tags: [], category: cat } as any);
      gitCommit(`add(note): ${title.trim()}`);
      treeProvider.refresh();
      await openStoreMarkdown("notes", key);
    }),

    vscode.commands.registerCommand("personalKnowledge.addPaperHere", async (item?: PkTreeItem) => {
      if (!(await ensureSetup(context))) return;
      const category = await selectKnowledgeFolder("papers", categoryFromTreeItem(item));
      if (category === undefined) return;
      const title = await vscode.window.showInputBox({ prompt: "New paper title", placeHolder: "e.g. Attention Is All You Need" });
      if (!title?.trim()) return;
      const slug = uniquePaperSlug(title.trim(), category);
      if (paperGet(slug)) { vscode.window.showWarningMessage(`Paper or idea already exists: ${slug}`); return; }
      paperUpsert({ slug, title: title.trim(), content: "", category, kind: "paper" });
      gitCommit(`add(paper): ${slug}`);
      treeProvider.refresh();
      await openStoreMarkdown("papers", slug);
    }),

    vscode.commands.registerCommand("personalKnowledge.addIdeaHere", async (item?: PkTreeItem) => {
      if (!(await ensureSetup(context))) return;
      const category = await selectKnowledgeFolder("papers", categoryFromTreeItem(item));
      if (category === undefined) return;
      const title = await vscode.window.showInputBox({ prompt: "New idea title", placeHolder: "e.g. Retrieval with adaptive memory" });
      if (!title?.trim()) return;
      const slug = uniquePaperSlug(title.trim(), category);
      if (paperGet(slug)) { vscode.window.showWarningMessage(`Paper or idea already exists: ${slug}`); return; }
      paperUpsert({ slug, title: title.trim(), content: "", category, kind: "idea" });
      gitCommit(`add(idea): ${slug}`);
      treeProvider.refresh();
      await openStoreMarkdown("papers", slug);
    }),

    vscode.commands.registerCommand("personalKnowledge.addPromptHere", async (item?: PkTreeItem) => {
      if (!(await ensureSetup(context))) return;
      const data = item?.nodeData ?? {};
      const project = data.project || await vscode.window.showInputBox({ prompt: "Prompt project" });
      if (!project?.trim()) return;
      const task = data.task || await vscode.window.showInputBox({ prompt: "Prompt task" });
      if (!task?.trim()) return;
      const version = data.version || await vscode.window.showInputBox({ prompt: "Prompt version", value: "v1" });
      if (!version?.trim()) return;
      const file = await vscode.window.showInputBox({
        prompt: "New prompt filename",
        placeHolder: "prompt.md",
        validateInput: value => value?.trim() && !/[\\/]/.test(value) ? null : "Enter a filename without slashes",
      });
      if (!file?.trim()) return;
      const segments = [project, task, version, file].map(value => String(value).trim());
      if (segments.some(value => value === "." || value === "..")) return;
      const full = path.join(getStorePath(), "prompts", ...segments);
      if (fs.existsSync(full)) { vscode.window.showWarningMessage(`Prompt already exists: ${segments.join("/")}`); return; }
      fs.mkdirSync(path.dirname(full), { recursive: true });
      fs.writeFileSync(full, "");
      gitCommit(`add(prompt): ${segments.join("/")}`);
      treeProvider.refresh();
      const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(full));
      await vscode.window.showTextDocument(doc, { preview: false });
    }),

    vscode.commands.registerCommand("personalKnowledge.addScriptHere", async (item?: PkTreeItem) => {
      if (!(await ensureSetup(context))) return;
      const folder = (item?.nodeData?.path ?? []).join("/");
      await createScriptAtFolder(folder);
    }),

    // ── Edit item (right-click on a leaf) ─────────────────────────────────
    vscode.commands.registerCommand("personalKnowledge.editSkill", async (item?: PkTreeItem) => {
      if (!(await ensureSetup(context)) || !item?.nodeData?.key) return;
      await openStoreMarkdown("skills", item.nodeData.key);
    }),
    vscode.commands.registerCommand("personalKnowledge.editNote", async (item?: PkTreeItem) => {
      if (!(await ensureSetup(context)) || !item?.nodeData?.key) return;
      await openStoreMarkdown("notes", item.nodeData.key);
    }),
    vscode.commands.registerCommand("personalKnowledge.editPaper", async (item?: PkTreeItem) => {
      if (!(await ensureSetup(context)) || !item?.nodeData?.key) return;
      await openStoreMarkdown("papers", item.nodeData.key);
    }),
    vscode.commands.registerCommand("personalKnowledge.editScript", async (item?: PkTreeItem) => {
      if (!(await ensureSetup(context)) || !item?.nodeData?.key) return;
      const full = path.join(getStorePath(), "scripts", item.nodeData.key);
      const document = await vscode.workspace.openTextDocument(vscode.Uri.file(full));
      await vscode.window.showTextDocument(document, { preview: false });
    }),

    vscode.commands.registerCommand("personalKnowledge.deleteScript", async (item?: PkTreeItem) => {
      if (!(await ensureSetup(context)) || !item?.nodeData?.key) return;
      try {
        await deleteScriptAtPath(item.nodeData.key as string);
      } catch (e: any) {
        vscode.window.showErrorMessage(`Delete failed: ${e.message}`);
      }
    }),

    vscode.commands.registerCommand("personalKnowledge.openSkill", async (name: string) => {
      log.action("command.openSkill", { name });
      if (!(await ensureSetup(context))) return;
      openInPanel(context, "skill", name);
      await closeNavigationSidebar();
    }),

    vscode.commands.registerCommand("personalKnowledge.openNote", async (slug: string) => {
      log.action("command.openNote", { slug });
      if (!(await ensureSetup(context))) return;
      openInPanel(context, "note", slug);
      await closeNavigationSidebar();
    }),

    vscode.commands.registerCommand("personalKnowledge.openPaper", async (slug: string) => {
      log.action("command.openPaper", { slug });
      if (!(await ensureSetup(context))) return;
      openInPanel(context, "paper", slug);
      await closeNavigationSidebar();
    }),

    vscode.commands.registerCommand("personalKnowledge.openPrompt", async (key: string) => {
      log.action("command.openPrompt", { key });
      if (!(await ensureSetup(context))) return;
      openInPanel(context, "prompt", key);
      await closeNavigationSidebar();
    }),

    vscode.commands.registerCommand("personalKnowledge.openPackage", async (name: string) => {
      log.action("command.openPackage", { name });
      if (!(await ensureSetup(context))) return;
      openInPanel(context, "package", name);
      await closeNavigationSidebar();
    }),

    vscode.commands.registerCommand("personalKnowledge.openScript", async (key: string) => {
      log.action("command.openScript", { key });
      if (!(await ensureSetup(context))) return;
      openInPanel(context, "script", key);
      await closeNavigationSidebar();
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
      p.reveal(vscode.ViewColumn.One);
      if (_panelReady) p.webview.postMessage({ command: "openTab", tab: "mcp" });
      else _pendingTab = "mcp";
      await closeNavigationSidebar();
    }),

    vscode.commands.registerCommand("personalKnowledge.openChatroom", async () => {
      log.action("command.openChatroom");
      openChatroomPanel(context);
      await closeNavigationSidebar();
    }),

    vscode.commands.registerCommand("personalKnowledge.openHostedRoomItem", async (itemOrRoomId: PkTreeItem | string) => {
      const roomId = typeof itemOrRoomId === "string" ? itemOrRoomId : String(itemOrRoomId?.nodeData?.roomId || "");
      if (!roomId) return;
      try { await openHostedRoom(context, roomId); }
      catch (error: any) { vscode.window.showErrorMessage(`Couldn't open Hosted Room: ${error?.message || error}`); }
    }),

    vscode.commands.registerCommand("personalKnowledge.renameHostedRoom", async (item: PkTreeItem) => {
      const room = item?.nodeData as HostedRoomNavigationItem;
      if (!room?.roomId) return;
      try { await promptRenameHostedRoom(room); }
      catch (error: any) { vscode.window.showErrorMessage(`Couldn't rename Room: ${error?.message || error}`); }
    }),

    vscode.commands.registerCommand("personalKnowledge.closeHostedRoom", async (item: PkTreeItem) => {
      const room = item?.nodeData as HostedRoomNavigationItem;
      if (!room?.roomId || !room.active) return;
      try { await getChatMgr().closeHostedRoomById(room.roomId); }
      catch (error: any) { vscode.window.showErrorMessage(`Couldn't close Room: ${error?.message || error}`); }
    }),

    vscode.commands.registerCommand("personalKnowledge.deleteHostedRoom", async (item: PkTreeItem) => {
      const room = item?.nodeData as HostedRoomNavigationItem;
      if (!room?.roomId || room.active) return;
      try { await confirmAndDeleteStoredRoom(context, room.roomId, room.roomName); }
      catch (error: any) { vscode.window.showErrorMessage(`Couldn't delete Room: ${error?.message || error}`); }
    }),

    vscode.commands.registerCommand("personalKnowledge.openChatRoomItem", async (id: string) => {
      const entry = chatRecents(context).find(room => room.id === id);
      if (!entry || (!entry.host && !entry.secret)) {
        vscode.window.showWarningMessage("This room has no saved key. Join it again using a fresh Magic Link.");
        return;
      }
      const manager = getChatMgr();
      if (manager.activateRoom(entry.url, entry.room, entry.roomId)) {
      } else if (entry.host) {
        const reachable = await probeChatRoomActive(entry.url, entry.room, entry.roomId);
        if (reachable) {
          const secret = manager.getRoomKey(entry.room);
          if (!secret) { vscode.window.showWarningMessage("This Room is hosted by another Extension instance."); return; }
          manager.joinRoom({ url: entry.url, room: entry.room, roomId: entry.roomId, user: entry.user, token: secret, cid: getChatCid(context) });
        } else {
          const result = await manager.startHub(entry.port);
          if (!result.ok) { vscode.window.showErrorMessage(`Couldn't Rehost Room: ${result.error}`); return; }
          try {
            const hosted = entry.roomId
              ? await manager.rehostRoom(entry.roomId)
              : await manager.createHostedRoom(entry.room, entry.secret);
            const url = `ws://127.0.0.1:${manager.hubPort}`;
            manager.joinRoom({ url, room: hosted.room, roomId: hosted.roomId, user: entry.user, token: hosted.secret, cid: getChatCid(context), hostToken: hosted.hostToken });
            await saveChatRecent(context, { url, room: hosted.room, roomId: hosted.roomId, user: entry.user, host: true });
          } catch (error: any) {
            vscode.window.showErrorMessage(`Couldn't Rehost Room: ${error?.message || error}`);
            return;
          }
        }
      } else {
        manager.joinRoom({ url: entry.url, room: entry.room, roomId: entry.roomId, user: entry.user, token: entry.secret!, cid: getChatCid(context) });
        await saveChatRecent(context, entry);
      }
      openChatroomPanel(context);
      await closeNavigationSidebar();
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
        vscode.window.showInformationMessage("Personal Knowledge Manager: AI API key saved.");
      } else {
        await context.secrets.delete("personalKnowledge.aiApiKey");
        vscode.window.showInformationMessage("Personal Knowledge Manager: AI API key cleared.");
      }
    })
  );

  // Initialize the file store (runs the one-time DB→files migration) if configured
  if (configuredPath) {
    try {
      await initStore(context, configuredPath);
      log.info(`file store ready at ${getStorePath()}`);
      ensureGitRepo();
      await maybeSeedExamples(context);
      startFileWatcher(context);
      treeProvider.refresh();
      panel?.webview.postMessage({ command: "saved" }); // re-fetch if panel already open
      void offerMcpRuntimeSetup(context);
      void offerMcpServerRegeneration(context);
      void offerPkmSkillProjectionUpdate(context);
    } catch (e: any) {
      log.error(`store init failed: ${e?.stack ?? e?.message}`);
      vscode.window.showErrorMessage(`Personal Knowledge Manager: failed to initialize store — ${e.message}`);
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
  const onChange = (uri: vscode.Uri) => {
    _treeProvider?.refresh();
    panel?.webview.postMessage({ command: "reloaded" }); // re-fetch current tab
    if (uri.fsPath === path.join(getStorePath(), "skills", "System", "PKM", "PKM Skills.md")) {
      panel?.webview.postMessage({ command: "mcpStatus", data: mcpPanelStatusData() });
      void offerPkmSkillProjectionUpdate(context);
    }
  };
  _watcher.onDidCreate(onChange);
  _watcher.onDidChange(onChange);
  _watcher.onDidDelete(onChange);
  context.subscriptions.push(_watcher);
}

export async function deactivate(): Promise<void> {
  _watcher?.dispose();
  disposeServers();
  await chatMgr?.dispose();
  liveNoteServer?.close();
  liveNoteServer = undefined;
  liveNoteBaseUrl = undefined;
  log.info("deactivated");
}
