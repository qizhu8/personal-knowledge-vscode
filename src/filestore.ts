/**
 * filestore.ts — file-backed markdown store for skills & notes (files-as-truth).
 *
 * Skills:  <store>/skills/<Category/Path>/<Name>.md
 * Notes:   <store>/notes/<Category/Path>/<Title>.md
 *
 * Identity ("slug"/key) = the relative path without extension. Category = folder
 * path. Name/title = filename (exact value preserved in YAML frontmatter).
 * There is no database — the folder tree is the single source of truth. A caller
 * scans on demand; a file watcher (in extension.ts) triggers UI refreshes.
 */
import { homedir } from "os";
import { join, sep } from "path";
import {
  existsSync, readFileSync, writeFileSync, mkdirSync, readdirSync, statSync, rmSync,
} from "fs";
import { createHash } from "crypto";

let _store = join(homedir(), "personal-knowledge");

export function setStorePath(p: string): void {
  _store = p?.trim() || join(homedir(), "personal-knowledge");
}
export function getStorePath(): string { return _store; }

// ── Frontmatter (minimal, self-produced YAML subset) ───────────────────────
function parseFrontmatter(text: string): { fm: Record<string, any>; body: string } {
  const m = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(text);
  if (!m) return { fm: {}, body: text };
  const fm: Record<string, any> = {};
  for (const line of m[1].split(/\r?\n/)) {
    const i = line.indexOf(":");
    if (i < 0) continue;
    const key = line.slice(0, i).trim();
    const raw = line.slice(i + 1).trim();
    if (!key) continue;
    if (raw.startsWith("[")) { try { fm[key] = JSON.parse(raw); } catch { fm[key] = []; } }
    else { try { fm[key] = JSON.parse(raw); } catch { fm[key] = raw.replace(/^["']|["']$/g, ""); } }
  }
  return { fm, body: text.slice(m[0].length) };
}

function serializeFrontmatter(fm: Record<string, any>, body: string): string {
  const lines = ["---"];
  for (const [k, v] of Object.entries(fm)) {
    if (v === undefined || v === null) continue;
    if (Array.isArray(v) || typeof v === "string") lines.push(`${k}: ${JSON.stringify(v)}`);
    else lines.push(`${k}: ${v}`);
  }
  lines.push("---", "");
  return lines.join("\n") + (body ?? "");
}

// ── Path helpers ────────────────────────────────────────────────────────────
function safeName(s: string): string {
  return (s || "untitled").replace(/[/\\:*?"<>|\u0000-\u001f]/g, "").trim() || "untitled";
}
function safeCategory(cat: string): string {
  if (!cat || !cat.trim()) return "";
  return cat.split("/").map(s => s.trim()).filter(Boolean).map(s => safeName(s)).filter(Boolean).join("/");
}
function asArray(v: any): string[] {
  return Array.isArray(v) ? v : v ? [String(v)] : [];
}

interface MdFile { full: string; rel: string; mtime: number; }

function walkMd(dir: string, rel: string, out: MdFile[]): void {
  if (!existsSync(dir)) return;
  for (const name of readdirSync(dir)) {
    if (name.startsWith(".") || name === "_assets") continue;
    const full = join(dir, name);
    let st;
    try { st = statSync(full); } catch { continue; }
    const childRel = rel ? `${rel}/${name}` : name;
    if (st.isDirectory()) walkMd(full, childRel, out);
    else if (name.toLowerCase().endsWith(".md")) out.push({ full, rel: childRel, mtime: st.mtimeMs });
  }
}

const now = () => new Date().toISOString();
function relNoExt(rel: string): string { return rel.replace(/\.md$/i, ""); }
function catOf(keyPath: string): string {
  return keyPath.includes("/") ? keyPath.slice(0, keyPath.lastIndexOf("/")) : "";
}
function nameOf(keyPath: string): string {
  return keyPath.includes("/") ? keyPath.slice(keyPath.lastIndexOf("/") + 1) : keyPath;
}

// ── Notes ───────────────────────────────────────────────────────────────────
function notesRoot(): string { return join(_store, "notes"); }

function noteFromFile(f: MdFile): any {
  const { fm, body } = parseFrontmatter(readFileSync(f.full, "utf-8"));
  const key = relNoExt(f.rel);
  return {
    slug: key,
    title: fm.title || nameOf(key),
    type: fm.type || "general",
    tags: JSON.stringify(asArray(fm.tags)),
    category: catOf(key),
    content: body,
    created_at: fm.created || new Date(f.mtime).toISOString(),
    updated_at: new Date(f.mtime).toISOString(),
  };
}

function allNoteFiles(): MdFile[] { const out: MdFile[] = []; walkMd(notesRoot(), "", out); return out; }

export function noteList(type?: string, limit = 50): any[] {
  let rows = allNoteFiles().map(noteFromFile);
  if (type && type !== "all") rows = rows.filter(r => r.type === type);
  rows.sort((a, b) => (b.updated_at || "").localeCompare(a.updated_at || ""));
  return rows.slice(0, limit).map(({ content, ...meta }) => meta);
}

export function noteSearch(q: string): any[] {
  const needle = q.toLowerCase();
  return allNoteFiles().map(noteFromFile)
    .filter(r => r.title.toLowerCase().includes(needle) ||
                 r.content.toLowerCase().includes(needle) ||
                 r.slug.toLowerCase().includes(needle))
    .sort((a, b) => (b.updated_at || "").localeCompare(a.updated_at || ""))
    .slice(0, 100)
    .map(({ content, ...meta }) => meta);
}

export function noteGet(slug: string): any {
  const full = join(notesRoot(), slug + ".md");
  if (!existsSync(full)) return null;
  const st = statSync(full);
  return noteFromFile({ full, rel: slug + ".md", mtime: st.mtimeMs });
}

export function noteUpsert(row: {
  slug: string; title: string; content: string; type: string; tags: string[]; category?: string;
}): boolean {
  const existing = noteGet(row.slug);
  const category = safeCategory(row.category ?? existing?.category ?? "");
  const filename = safeName(row.title || nameOf(row.slug)) + ".md";
  const newRel = category ? `${category}/${filename}` : filename;
  const full = join(notesRoot(), newRel);
  const created = existing?.created_at ?? now();

  // Move/rename: if the identity path changed, remove the old file
  const oldFull = join(notesRoot(), row.slug + ".md");
  if (existing && relNoExt(newRel) !== row.slug && existsSync(oldFull)) {
    try { rmSync(oldFull, { force: true }); } catch { /* ignore */ }
  }
  mkdirSync(join(full, ".."), { recursive: true });
  const fm = { title: row.title, type: row.type, tags: row.tags ?? [], created };
  writeFileSync(full, serializeFrontmatter(fm, row.content ?? ""));
  return !existing;
}

export function noteDelete(slug: string): boolean {
  const full = join(notesRoot(), slug + ".md");
  if (!existsSync(full)) return false;
  try { rmSync(full, { force: true }); return true; } catch { return false; }
}

export function slugExists(slug: string): boolean {
  return existsSync(join(notesRoot(), slug + ".md"));
}

export function noteExport(): any[] {
  return allNoteFiles().map(noteFromFile);
}

export function noteImport(rows: any[]): number {
  let count = 0;
  for (const r of rows) {
    try {
      noteUpsert({
        slug: r.slug || safeName(r.title || "note"),
        title: r.title || r.slug || "note",
        content: r.content ?? "",
        type: r.type ?? "general",
        tags: Array.isArray(r.tags) ? r.tags : (typeof r.tags === "string" ? JSON.parse(r.tags || "[]") : []),
        category: r.category ?? "",
      });
      count++;
    } catch { /* skip invalid */ }
  }
  return count;
}

// ── Assets (pasted images) ───────────────────────────────────────────────────
// Images live in notes/_assets/<sha1>.<ext> and are referenced from markdown as
// `_assets/<sha1>.<ext>` (relative to the notes root). The webview rewrites those
// refs to webview URIs at render time. Content-hash naming de-dupes identical pastes.
export function saveNoteAsset(base64: string, ext: string): string {
  const buf = Buffer.from(base64, "base64");
  const hash = createHash("sha1").update(buf).digest("hex").slice(0, 16);
  const safeExt = (ext || "png").replace(/[^a-zA-Z0-9]/g, "").toLowerCase() || "png";
  const dir = join(_store, "notes", "_assets");
  mkdirSync(dir, { recursive: true });
  const rel = `_assets/${hash}.${safeExt}`;
  const full = join(dir, `${hash}.${safeExt}`);
  if (!existsSync(full)) writeFileSync(full, buf);
  return rel;
}

// ── Skills ──────────────────────────────────────────────────────────────────
function skillsRoot(): string { return join(_store, "skills"); }

function skillFromFile(f: MdFile): any {
  const { fm, body } = parseFrontmatter(readFileSync(f.full, "utf-8"));
  const key = relNoExt(f.rel);
  return {
    name: fm.name || nameOf(key),
    _key: key,
    description: fm.description ?? "",
    category: catOf(key),
    tags: JSON.stringify(asArray(fm.tags)),
    source_project: fm.source_project ?? null,
    content: body,
    created_at: fm.created || new Date(f.mtime).toISOString(),
    updated_at: new Date(f.mtime).toISOString(),
  };
}

function allSkillFiles(): MdFile[] { const out: MdFile[] = []; walkMd(skillsRoot(), "", out); return out; }

export function skillList(category?: string, tag?: string): any[] {
  let rows = allSkillFiles().map(skillFromFile);
  if (category) rows = rows.filter(r => r.category === category);
  if (tag) rows = rows.filter(r => asArray(JSON.parse(r.tags || "[]")).includes(tag));
  rows.sort((a, b) => (a.category || "").localeCompare(b.category || "") || a.name.localeCompare(b.name));
  return rows.map(({ content, _key, ...meta }) => meta);
}

export function skillSearch(q: string): any[] {
  const needle = q.toLowerCase();
  return allSkillFiles().map(skillFromFile)
    .filter(r => r.name.toLowerCase().includes(needle) ||
                 r.content.toLowerCase().includes(needle) ||
                 (r.description || "").toLowerCase().includes(needle))
    .slice(0, 100)
    .map(({ content, _key, ...meta }) => meta);
}

/** Find a skill's file by its (unique) name. */
function findSkillFile(name: string): MdFile | undefined {
  return allSkillFiles().find(f => {
    const { fm } = parseFrontmatter(readFileSync(f.full, "utf-8"));
    return (fm.name || nameOf(relNoExt(f.rel))) === name;
  });
}

export function skillGet(name: string): any {
  const f = findSkillFile(name);
  return f ? skillFromFile(f) : null;
}

export function skillUpsert(row: {
  name: string; content: string; description?: string; category?: string; tags?: string[]; source_project?: string;
}): boolean {
  const existingFile = findSkillFile(row.name);
  const existing = existingFile ? skillFromFile(existingFile) : null;
  const category = safeCategory(row.category ?? existing?.category ?? "");
  const filename = safeName(row.name) + ".md";
  const newRel = category ? `${category}/${filename}` : filename;
  const full = join(skillsRoot(), newRel);
  const created = existing?.created_at ?? now();

  if (existingFile && existingFile.full !== full) {
    try { rmSync(existingFile.full, { force: true }); } catch { /* ignore */ }
  }
  mkdirSync(join(full, ".."), { recursive: true });
  const fm = {
    name: row.name,
    description: row.description ?? existing?.description ?? "",
    tags: row.tags ?? (existing ? JSON.parse(existing.tags || "[]") : []),
    source_project: row.source_project ?? existing?.source_project ?? undefined,
    created,
  };
  writeFileSync(full, serializeFrontmatter(fm, row.content ?? ""));
  return !existing;
}

export function skillDelete(name: string): boolean {
  const f = findSkillFile(name);
  if (!f) return false;
  try { rmSync(f.full, { force: true }); return true; } catch { return false; }
}
