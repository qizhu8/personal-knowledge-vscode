import * as vscode from "vscode";
import * as path from "path";
import * as fs from "fs";
import { syncServer } from "./sync-server";
import {
  skillList, skillSearch, skillGet, skillUpsert, skillDelete,
  noteList, noteSearch, noteGet, noteUpsert, noteDelete, slugExists,
  noteExport, noteImport,
  setStorePath as fsSetStorePath, getStorePath,
} from "./filestore";
import { migrateDbToFiles } from "./migrate";
import {
  promptList, promptGetFile, promptGetAllVersionsOfFile,
  packageList, packageGet, packageFileGet,
  scriptList, scriptGet,
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

function makeWebviewOptions(context: vscode.ExtensionContext): vscode.WebviewOptions & vscode.WebviewPanelOptions {
  return {
    enableScripts: true,
    retainContextWhenHidden: true,
    localResourceRoots: [
      vscode.Uri.file(path.join(context.extensionPath, "dist", "webview")),
      vscode.Uri.file(path.join(context.extensionPath, "src",  "webview")),        // dev fallback
      vscode.Uri.file(path.join(context.extensionPath, "node_modules", "marked")), // dev marked
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

  // Inject the webview CSP source — required for VS Code to allow scripts to run
  html = html.replace(/%%CSP_SOURCE%%/g, webview.cspSource);
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

    case "saveSkill": {
      const { name, content, category, description, tags } = msg;
      skillUpsert({ name, content, category, description, tags });
      gitCommit(`save(skill): ${name}`);
      respond({ command: "saved" });
      vscode.window.setStatusBarMessage("$(check) Skill saved", 3000);
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
      const prompts  = promptList().flatMap(t => ({ id: `${t.project}/${t.task}`, label: t.task, meta: t.project }));
      const scripts  = (scriptList() as any[]).map((s: any) => ({ id: s.path, label: s.file, meta: s.category }));
      const packages = packageList().map((p: any) => ({ id: p.name, label: p.name, meta: p.lang }));
      respond({ command: "syncContentList", data: { skills, notes, prompts, scripts, packages } });
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
  const dbPath    = path.join(storePath, "knowledge.db").replace(/\\/g, "/");

  fs.mkdirSync(mcpDir, { recursive: true });

  fs.writeFileSync(serverPy, `#!/usr/bin/env python3
"""
${displayName} MCP Server — auto-generated by Personal Knowledge extension.
Exposes your skills and notes to AI assistants via the Model Context Protocol.

Read tools:  list_skills, search_skills, get_skill, list_notes, search_notes, get_note
Write tools: add_note, update_note, delete_note, add_skill, update_skill, delete_skill

Search uses an in-memory FTS5 'trigram' index (CJK-friendly, ranked) rebuilt at
startup. The shared knowledge.db is kept FTS-free so the VS Code extension
(sql.js) and this server (Python) can both read AND write it without a module
conflict. Writes here also update the markdown mirror so git history stays readable.

Install:  pip install fastmcp
Run:      python server.py
"""
import sqlite3, json, re, datetime
from pathlib import Path
from typing import Optional, List

try:
    from fastmcp import FastMCP
except ImportError:
    raise SystemExit("fastmcp not found. Run: pip install fastmcp")

DB_PATH = Path("${dbPath}")
STORE   = DB_PATH.parent
mcp = FastMCP("${displayName}")

_HAS_FTS5 = False


def _db():
    conn = sqlite3.connect(str(DB_PATH))
    conn.row_factory = sqlite3.Row
    return conn


def _now() -> str:
    return datetime.datetime.utcnow().isoformat()


def _slugify(title: str) -> str:
    s = re.sub(r"[^a-z0-9\\s-]", "", (title or "").lower()).strip()
    s = re.sub(r"\\s+", "-", s)[:40]
    return s or ("note-" + str(int(datetime.datetime.utcnow().timestamp())))


def _build_index(c: sqlite3.Connection) -> None:
    """Build an in-memory FTS5 trigram index over skills+notes for ranked CJK search."""
    global _HAS_FTS5
    try:
        c.execute("CREATE VIRTUAL TABLE temp.skills_fts USING fts5(name, content, description, tokenize='trigram')")
        c.execute("CREATE VIRTUAL TABLE temp.notes_fts  USING fts5(slug, title, content, tokenize='trigram')")
        for r in c.execute("SELECT name, content, description FROM skills"):
            c.execute("INSERT INTO temp.skills_fts(name,content,description) VALUES(?,?,?)",
                      [r["name"], r["content"], r["description"] or ""])
        for r in c.execute("SELECT slug, title, content FROM notes"):
            c.execute("INSERT INTO temp.notes_fts(slug,title,content) VALUES(?,?,?)",
                      [r["slug"], r["title"], r["content"]])
        _HAS_FTS5 = True
    except sqlite3.OperationalError:
        _HAS_FTS5 = False  # FTS5 unavailable — search_* will fall back to LIKE


def _mirror_note(row) -> None:
    try:
        cat = (row["category"] or "") if "category" in row.keys() else ""
        segs = [re.sub(r"[^A-Za-z0-9._-]", "_", s.strip()) for s in cat.split("/") if s.strip()]
        d = STORE.joinpath("notes", *segs); d.mkdir(parents=True, exist_ok=True)
        tags = row["tags"] if isinstance(row["tags"], str) else json.dumps(row["tags"] or [])
        fm = "---\\ntitle: " + json.dumps(row["title"]) + "\\ntype: " + (row["type"] or "general") + "\\ncategory: " + json.dumps(cat) + "\\ntags: " + tags + "\\n---\\n\\n"
        safe = re.sub(r"[^A-Za-z0-9._/-]", "_", row["slug"])
        (d / (safe + ".md")).write_text(fm + (row["content"] or ""), encoding="utf-8")
    except Exception:
        pass


def _mirror_skill(name, content, description, category, tags) -> None:
    try:
        safe = re.sub(r"[^A-Za-z0-9._/-]", "_", name)
        full = STORE / "skills" / (safe + ".md")
        full.parent.mkdir(parents=True, exist_ok=True)
        tj = tags if isinstance(tags, str) else json.dumps(tags or [])
        fm = "---\\nname: " + json.dumps(name) + "\\ndescription: " + json.dumps(description or "") + "\\ncategory: " + json.dumps(category or "") + "\\ntags: " + tj + "\\n---\\n\\n"
        full.write_text(fm + (content or ""), encoding="utf-8")
    except Exception:
        pass


# ── Read tools ──────────────────────────────────────────────────────────────
@mcp.tool()
def list_skills(category: Optional[str] = None) -> str:
    """List personal skills, optionally filtered by category."""
    with _db() as c:
        rows = (c.execute("SELECT name,description,category,tags FROM skills WHERE category=? ORDER BY name", [category])
                if category else
                c.execute("SELECT name,description,category,tags FROM skills ORDER BY category,name")).fetchall()
    return json.dumps([{"name": r["name"], "description": r["description"],
                        "category": r["category"], "tags": json.loads(r["tags"] or "[]")} for r in rows])


@mcp.tool()
def search_skills(query: str) -> str:
    """Ranked full-text search across skill names, content, and descriptions (CJK-friendly)."""
    with _db() as c:
        _build_index(c)
        rows = []
        if _HAS_FTS5:
            try:
                names = [x["name"] for x in c.execute(
                    "SELECT name FROM temp.skills_fts WHERE skills_fts MATCH ? ORDER BY rank LIMIT 20", [query])]
                for n in names:
                    r = c.execute("SELECT name,description,category FROM skills WHERE name=?", [n]).fetchone()
                    if r: rows.append(r)
            except sqlite3.OperationalError:
                rows = []
        if not rows:
            like = "%" + query + "%"
            rows = c.execute("SELECT name,description,category FROM skills WHERE name LIKE ? OR content LIKE ? OR description LIKE ? LIMIT 20",
                             [like, like, like]).fetchall()
    return json.dumps([{"name": r["name"], "description": r["description"], "category": r["category"]} for r in rows])


@mcp.tool()
def get_skill(name: str) -> str:
    """Get the full markdown content of a skill by exact name."""
    with _db() as c:
        row = c.execute("SELECT * FROM skills WHERE name=?", [name]).fetchone()
    if not row:
        return f"Skill '{name}' not found. Use list_skills or search_skills to find it."
    return json.dumps({"name": row["name"], "content": row["content"],
                       "description": row["description"], "category": row["category"],
                       "tags": json.loads(row["tags"] or "[]"), "updated_at": row["updated_at"]})


@mcp.tool()
def list_notes(type: Optional[str] = None) -> str:
    """List notes. type can be: general, todo, done, observation, data-path."""
    with _db() as c:
        rows = (c.execute("SELECT slug,title,type,updated_at FROM notes WHERE type=? ORDER BY updated_at DESC LIMIT 50", [type])
                if type and type != "all" else
                c.execute("SELECT slug,title,type,updated_at FROM notes ORDER BY updated_at DESC LIMIT 50")).fetchall()
    return json.dumps([{"slug": r["slug"], "title": r["title"], "type": r["type"], "updated_at": r["updated_at"]} for r in rows])


@mcp.tool()
def search_notes(query: str) -> str:
    """Ranked full-text search across note titles and content (CJK-friendly)."""
    with _db() as c:
        _build_index(c)
        rows = []
        if _HAS_FTS5:
            try:
                slugs = [x["slug"] for x in c.execute(
                    "SELECT slug FROM temp.notes_fts WHERE notes_fts MATCH ? ORDER BY rank LIMIT 20", [query])]
                for s in slugs:
                    r = c.execute("SELECT slug,title,type FROM notes WHERE slug=?", [s]).fetchone()
                    if r: rows.append(r)
            except sqlite3.OperationalError:
                rows = []
        if not rows:
            like = "%" + query + "%"
            rows = c.execute("SELECT slug,title,type FROM notes WHERE title LIKE ? OR content LIKE ? LIMIT 20",
                             [like, like]).fetchall()
    return json.dumps([{"slug": r["slug"], "title": r["title"], "type": r["type"]} for r in rows])


@mcp.tool()
def get_note(slug: str) -> str:
    """Get the full content of a note by slug."""
    with _db() as c:
        row = c.execute("SELECT * FROM notes WHERE slug=?", [slug]).fetchone()
    if not row:
        return f"Note '{slug}' not found. Use list_notes or search_notes to find it."
    return json.dumps({"slug": row["slug"], "title": row["title"], "content": row["content"],
                       "type": row["type"], "tags": json.loads(row["tags"] or "[]"),
                       "updated_at": row["updated_at"]})


# ── Write tools ─────────────────────────────────────────────────────────────
@mcp.tool()
def add_note(title: str, content: str, type: str = "general", tags: Optional[List[str]] = None,
             category: Optional[str] = None, slug: Optional[str] = None) -> str:
    """Create a new note. 'category' is a slash-separated path (e.g. Project/AutoLabeling/C2 Guideline)
    used to organize the note in the sidebar tree. 'type' is one of general/todo/done/observation/data-path."""
    slug = slug or _slugify(title or content[:60])
    ts = _now(); tj = json.dumps(tags or [])
    with _db() as c:
        exists = c.execute("SELECT 1 FROM notes WHERE slug=?", [slug]).fetchone()
        if exists:
            return json.dumps({"error": f"Note '{slug}' already exists. Use update_note instead."})
        c.execute("INSERT INTO notes(slug,title,content,type,category,tags,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?)",
                  [slug, title or slug, content, type, category, tj, ts, ts])
        c.commit()
        row = c.execute("SELECT * FROM notes WHERE slug=?", [slug]).fetchone()
        _mirror_note(row)
    return json.dumps({"ok": True, "slug": slug})


@mcp.tool()
def update_note(slug: str, title: Optional[str] = None, content: Optional[str] = None,
                type: Optional[str] = None, category: Optional[str] = None, tags: Optional[List[str]] = None) -> str:
    """Update fields of an existing note by slug. Only provided fields are changed.
    'category' is a slash-separated path for sidebar organization."""
    with _db() as c:
        row = c.execute("SELECT * FROM notes WHERE slug=?", [slug]).fetchone()
        if not row:
            return json.dumps({"error": f"Note '{slug}' not found."})
        new_title = title if title is not None else row["title"]
        new_content = content if content is not None else row["content"]
        new_type = type if type is not None else row["type"]
        new_cat = category if category is not None else (row["category"] if "category" in row.keys() else None)
        new_tags = json.dumps(tags) if tags is not None else row["tags"]
        c.execute("UPDATE notes SET title=?,content=?,type=?,category=?,tags=?,updated_at=? WHERE slug=?",
                  [new_title, new_content, new_type, new_cat, new_tags, _now(), slug])
        c.commit()
        _mirror_note(c.execute("SELECT * FROM notes WHERE slug=?", [slug]).fetchone())
    return json.dumps({"ok": True, "slug": slug})


@mcp.tool()
def delete_note(slug: str) -> str:
    """Delete a note by slug."""
    with _db() as c:
        c.execute("DELETE FROM notes WHERE slug=?", [slug]); c.commit()
    try:
        safe = re.sub(r"[^A-Za-z0-9._/-]", "_", slug)
        (STORE / "notes" / (safe + ".md")).unlink(missing_ok=True)
    except Exception:
        pass
    return json.dumps({"ok": True, "slug": slug})


@mcp.tool()
def add_skill(name: str, content: str, description: str = "", category: str = "",
              tags: Optional[List[str]] = None, source_project: str = "") -> str:
    """Create or overwrite a skill. 'name' may use '/' for hierarchy (e.g. General/DLIS/docker/my-skill)."""
    ts = _now(); tj = json.dumps(tags or [])
    with _db() as c:
        existing = c.execute("SELECT created_at FROM skills WHERE name=?", [name]).fetchone()
        created = existing["created_at"] if existing else ts
        c.execute(
            "INSERT INTO skills(name,content,description,category,tags,source_project,created_at,updated_at) "
            "VALUES(?,?,?,?,?,?,?,?) ON CONFLICT(name) DO UPDATE SET "
            "content=excluded.content, description=excluded.description, category=excluded.category, "
            "tags=excluded.tags, source_project=excluded.source_project, updated_at=excluded.updated_at",
            [name, content, description, category, tj, source_project, created, ts])
        c.commit()
        _mirror_skill(name, content, description, category, tj)
    return json.dumps({"ok": True, "name": name})


@mcp.tool()
def update_skill(name: str, content: Optional[str] = None, description: Optional[str] = None,
                 category: Optional[str] = None, tags: Optional[List[str]] = None) -> str:
    """Update fields of an existing skill by name. Only provided fields are changed."""
    with _db() as c:
        row = c.execute("SELECT * FROM skills WHERE name=?", [name]).fetchone()
        if not row:
            return json.dumps({"error": f"Skill '{name}' not found. Use add_skill to create it."})
        new_content = content if content is not None else row["content"]
        new_desc = description if description is not None else row["description"]
        new_cat = category if category is not None else row["category"]
        new_tags = json.dumps(tags) if tags is not None else row["tags"]
        c.execute("UPDATE skills SET content=?,description=?,category=?,tags=?,updated_at=? WHERE name=?",
                  [new_content, new_desc, new_cat, new_tags, _now(), name])
        c.commit()
        _mirror_skill(name, new_content, new_desc, new_cat, new_tags)
    return json.dumps({"ok": True, "name": name})


@mcp.tool()
def delete_skill(name: str) -> str:
    """Delete a skill by name."""
    with _db() as c:
        c.execute("DELETE FROM skills WHERE name=?", [name]); c.commit()
    try:
        safe = re.sub(r"[^A-Za-z0-9._/-]", "_", name)
        (STORE / "skills" / (safe + ".md")).unlink(missing_ok=True)
    except Exception:
        pass
    return json.dumps({"ok": True, "name": name})


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
  | 'root-skills' | 'root-notes' | 'root-prompts' | 'root-packages' | 'root-scripts'
  | 'skill-folder' | 'skill' | 'note-folder' | 'note'
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
      "root-skills": "book", "root-notes": "note", "root-prompts": "comment-discussion",
      "root-packages": "package", "root-scripts": "terminal",
      "skill-folder": "folder", "note-folder": "folder",
      "skill": "symbol-snippet", "note": "file-text",
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
    else if (nodeType === 'root-scripts' || nodeType === 'script-folder') this.contextValue = 'pk-scripts-container';
    // Leaf items support right-click Edit
    else if (nodeType === 'skill')       this.contextValue = 'pk-skill-item';
    else if (nodeType === 'note')        this.contextValue = 'pk-note-item';
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
  const pattern = new vscode.RelativePattern(getStorePath(), "{notes,skills}/**/*.md");
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
