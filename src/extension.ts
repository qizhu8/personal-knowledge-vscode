import * as vscode from "vscode";
import * as path from "path";
import * as fs from "fs";
import { syncServer } from "./sync-server";
import {
  skillList, skillSearch, skillGet, skillUpsert, skillDelete,
  noteList, noteSearch, noteGet, noteUpsert, noteDelete, slugExists,
  noteExport, noteImport,
  setStorePath as dbSetStorePath, getStorePath, initDb,
} from "./db";
import {
  promptList, promptGetFile, promptGetAllVersionsOfFile,
  packageList, packageGet, packageFileGet,
  scriptList, scriptGet,
  promptImport, scriptImport, packageImport,
  setStorePath as storageSetStorePath,
} from "./storage";

// ── Git helper ─────────────────────────────────────────────────────────────
import { execSync } from "child_process";

function gitCommit(msg: string): void {
  try {
    const store = getStorePath();
    execSync(`git -C "${store}" add -A && git -C "${store}" commit -m "${msg.replace(/"/g, '\\"')}"`, { stdio: "pipe" });
  } catch { /* nothing to commit */ }
}

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

function makeWebviewOptions(context: vscode.ExtensionContext): vscode.WebviewOptions & vscode.WebviewPanelOptions {
  return {
    enableScripts: true,
    retainContextWhenHidden: true,
    localResourceRoots: [
      vscode.Uri.file(path.join(context.extensionPath, "dist", "webview")),
      vscode.Uri.file(path.join(context.extensionPath, "src",  "webview")), // fallback for dev
    ],
  };
}

function getWebviewHtml(webview: vscode.Webview, context: vscode.ExtensionContext): string {
  // prefer dist/webview (packaged), fall back to src/webview (development)
  const distPath = path.join(context.extensionPath, "dist", "webview", "panel.html");
  const srcPath  = path.join(context.extensionPath, "src",  "webview", "panel.html");
  const htmlPath = fs.existsSync(distPath) ? distPath : srcPath;
  return fs.readFileSync(htmlPath, "utf-8");
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
  panel.webview.html = getWebviewHtml(panel.webview, context);

  panel.webview.onDidReceiveMessage(
    msg => handleMessage(msg, m => panel?.webview.postMessage(m), context),
    undefined, context.subscriptions
  );

  panel.onDidDispose(() => { panel = undefined; }, undefined, context.subscriptions);
  return panel;
}

// ── Shared message handler (panel + sidebar) ───────────────────────────────
async function handleMessage(
  msg: any,
  respond: (m: object) => void,
  context: vscode.ExtensionContext
): Promise<void> {
  switch (msg.command) {

    case "list": {
      const { tab, filter, q } = msg;
      let data: unknown;
      if (tab === "skills")    data = q ? skillSearch(q) : skillList(filter === "all" ? undefined : filter);
      else if (tab === "notes")   data = q ? noteSearch(q) : noteList(filter === "all" ? undefined : filter);
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
        if (r) data = { type: "note", note_type: r.type, ...r };
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
        const parts = key.split("/");
        const r = scriptGet(parts[0], parts[1]);
        if (r) data = { type: "script", ...r };
      }
      respond({ command: "detail", data });
      break;
    }

    case "saveNote": {
      const { title, content, type, tags, slug: existingSlug } = msg;
      const slug = existingSlug ?? uniqueSlug(title || content.slice(0, 60));
      noteUpsert({ slug, title: title || slug, content, type, tags });
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
      const scripts  = scriptList().flatMap((c: any) => c.files.map((f: string) => ({ id: `${c.category}/${f}`, label: f, meta: c.category })));
      const packages = packageList().map((p: any) => ({ id: p.name, label: p.name, meta: p.lang }));
      respond({ command: "syncContentList", data: { skills, notes, prompts, scripts, packages } });
      break;
    }

    case "deleteNote": {
      const { slug } = msg;
      if (noteDelete(slug)) gitCommit(`delete(note): ${slug}`);
      vscode.window.setStatusBarMessage("$(trash) Note deleted", 3000);
      respond({ command: "saved" });
      respond({ command: "detail", data: null });
      break;
    }

    case "deleteSkill": {
      const { name } = msg;
      if (skillDelete(name)) gitCommit(`delete(skill): ${name}`);
      vscode.window.setStatusBarMessage("$(trash) Skill deleted", 3000);
      respond({ command: "saved" });
      respond({ command: "detail", data: null });
      break;
    }

    case "markDone": {
      const { slug } = msg;
      const row = noteGet(slug);
      if (row) {
        noteUpsert({ slug: row.slug, title: row.title,
          content: row.content + `\n\n---\n✓ Done (${new Date().toISOString().slice(0, 10)})`,
          type: "done", tags: JSON.parse(row.tags ?? "[]") });
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
        const info = generateMcpServer(context);
        respond({ command: "mcpGenerated", data: info });
        vscode.window.setStatusBarMessage("$(check) MCP server created", 4000);
      } catch (e: any) {
        respond({ command: "mcpError", data: { error: e.message } });
      }
      break;
    }
  }
}

// ── MCP server scaffold ────────────────────────────────────────────────────
function mcpStatus(): { installed: boolean; serverPath: string } {
  const serverPath = path.join(getStorePath(), "mcp-server", "server.py");
  return { installed: fs.existsSync(serverPath), serverPath };
}

function generateMcpServer(context: vscode.ExtensionContext): { serverPath: string; configSnippet: string } {
  const mcpDir    = path.join(getStorePath(), "mcp-server");
  const serverPy  = path.join(mcpDir, "server.py");
  const reqTxt    = path.join(mcpDir, "requirements.txt");
  const dbPath    = path.join(getStorePath(), "knowledge.db").replace(/\\/g, "/");

  fs.mkdirSync(mcpDir, { recursive: true });

  fs.writeFileSync(serverPy, `#!/usr/bin/env python3
"""
Personal Knowledge MCP Server — auto-generated by Personal Knowledge extension.
Exposes your skills and notes to AI assistants via the Model Context Protocol.

Install:  pip install fastmcp
Run:      python server.py
"""
import sqlite3, json
from pathlib import Path
from typing import Optional

try:
    from fastmcp import FastMCP
except ImportError:
    raise SystemExit("fastmcp not found. Run: pip install fastmcp")

DB_PATH = Path("${dbPath}")
mcp = FastMCP("Personal Knowledge")


def _db():
    conn = sqlite3.connect(str(DB_PATH))
    conn.row_factory = sqlite3.Row
    return conn


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
    """Full-text search across skill names, content, and descriptions."""
    with _db() as c:
        try:
            rows = c.execute(
                "SELECT s.name,s.description,s.category FROM skills s "
                "JOIN skills_fts f ON s.id=f.rowid WHERE skills_fts MATCH ? ORDER BY rank LIMIT 20",
                [query]).fetchall()
        except Exception:
            rows = c.execute(
                "SELECT name,description,category FROM skills WHERE name LIKE ? OR description LIKE ? LIMIT 20",
                [f"%{query}%", f"%{query}%"]).fetchall()
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
    """Full-text search across note titles and content."""
    with _db() as c:
        try:
            rows = c.execute(
                "SELECT n.slug,n.title,n.type FROM notes n "
                "JOIN notes_fts f ON n.id=f.rowid WHERE notes_fts MATCH ? ORDER BY rank LIMIT 20",
                [query]).fetchall()
        except Exception:
            rows = c.execute(
                "SELECT slug,title,type FROM notes WHERE title LIKE ? OR content LIKE ? LIMIT 20",
                [f"%{query}%", f"%{query}%"]).fetchall()
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

// ── Sidebar provider ───────────────────────────────────────────────────────
class SidebarProvider implements vscode.WebviewViewProvider {
  private _view?: vscode.WebviewView;

  constructor(private readonly context: vscode.ExtensionContext) {}

  resolveWebviewView(view: vscode.WebviewView): void {
    this._view = view;
    view.webview.options = makeWebviewOptions(this.context);
    view.webview.html    = getWebviewHtml(view.webview, this.context);
    view.webview.onDidReceiveMessage(
      msg => handleMessage(msg, m => view.webview.postMessage(m), this.context),
      undefined, this.context.subscriptions
    );
  }

  postMessage(m: object): void { this._view?.webview.postMessage(m); }
}

// ── Activation ─────────────────────────────────────────────────────────────
export async function activate(context: vscode.ExtensionContext): Promise<void> {
  // Configure store path from settings
  const cfg = vscode.workspace.getConfiguration("personalKnowledge");
  const customPath = cfg.get<string>("storePath") ?? "";
  dbSetStorePath(customPath);
  storageSetStorePath(customPath);

  // Initialize database (sql.js — pure JS, no native binaries)
  try {
    await initDb(context.extensionPath);
  } catch (e: any) {
    vscode.window.showErrorMessage(`Personal Knowledge: failed to open database — ${e.message}`);
    return;
  }

  // Register sidebar WebviewView provider
  const sidebarProvider = new SidebarProvider(context);
  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider("personalKnowledge.sidebarView", sidebarProvider)
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("personalKnowledge.open", () => getOrCreatePanel(context)),

    vscode.commands.registerCommand("personalKnowledge.addNote", () => {
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
      sidebarProvider.postMessage({ command: "saved" });
    }),

    vscode.commands.registerCommand("personalKnowledge.setupMcp", async () => {
      const p = getOrCreatePanel(context);
      p.webview.postMessage({ command: "openTab", tab: "mcp" });
    })
  );

  if (cfg.get<boolean>("openOnStartup")) getOrCreatePanel(context);
}

export function deactivate(): void {}
