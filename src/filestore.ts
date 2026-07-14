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
// Images live in the NOTE'S OWN folder: notes/<category>/_assets/<sha1>.<ext>,
// referenced from markdown as `_assets/<sha1>.<ext>` (relative to the note file).
// Content-hash naming de-dupes identical pastes. The webview rewrites those refs
// to webview URIs at render time. `category` is the note's folder path (may be "").
export function saveNoteAsset(base64: string, ext: string, category = ""): string {
  const buf = Buffer.from(base64, "base64");
  const hash = createHash("sha1").update(buf).digest("hex").slice(0, 16);
  const safeExt = (ext || "png").replace(/[^a-zA-Z0-9]/g, "").toLowerCase() || "png";
  const cat = safeCategory(category);
  const dir = cat ? join(_store, "notes", ...cat.split("/"), "_assets") : join(_store, "notes", "_assets");
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

// ── Papers ────────────────────────────────────────────────────────────────
// Files: papers/<Category>/<Title>.md. Frontmatter carries bibliographic
// metadata, a list of conclusions (shown in the graph), and a `cites` list where
// each entry is { paper, note } — the note describes how THIS paper uses the
// cited (parent) paper's conclusions. "A cites B" ⇒ A is a child of B.
// A paper may also link to a remote `url` and/or a local `file` (uploaded under
// the paper's own _assets/ folder). The markdown body is your free-text notes.
function papersRoot(): string { return join(_store, "papers"); }

export interface Cite { paper: string; note: string; }

function normalizeCites(v: any): Cite[] {
  if (!Array.isArray(v)) return [];
  const out: Cite[] = [];
  for (const e of v) {
    if (typeof e === "string") { if (e.trim()) out.push({ paper: e.trim(), note: "" }); }
    else if (e && typeof e === "object") {
      const paper = String(e.paper ?? e.key ?? e.target ?? "").trim();
      if (paper) out.push({ paper, note: String(e.note ?? e.comment ?? "") });
    }
  }
  return out;
}

function toYear(v: any): number | null {
  if (typeof v === "number") return v;
  if (v == null || v === "") return null;
  const n = parseInt(String(v), 10);
  return Number.isFinite(n) ? n : null;
}

function paperFromFile(f: MdFile): any {
  const { fm, body } = parseFrontmatter(readFileSync(f.full, "utf-8"));
  const key = relNoExt(f.rel);
  return {
    slug: key,
    title: fm.title || nameOf(key),
    kind: fm.kind === "idea" ? "idea" : "paper",
    group: (fm.group && String(fm.group).trim()) || "Papers",
    authors: asArray(fm.authors),
    year: toYear(fm.year),
    topic: fm.topic || "",
    publisher: fm.publisher || "",
    tags: asArray(fm.tags),
    url: fm.url || "",
    file: fm.file || "",
    conclusions: asArray(fm.conclusions),
    cites: normalizeCites(fm.cites),
    category: catOf(key),
    content: body,
    created_at: fm.created || new Date(f.mtime).toISOString(),
    updated_at: new Date(f.mtime).toISOString(),
  };
}

function allPaperFiles(): MdFile[] { const out: MdFile[] = []; walkMd(papersRoot(), "", out); return out; }

/** Resolve a cite reference (a paper slug or a title) to a canonical slug. */
function buildPaperResolver(all: any[]): (ref: string) => string | null {
  const byKey = new Map<string, string>(), byTitle = new Map<string, string>();
  for (const p of all) { byKey.set(p.slug.toLowerCase(), p.slug); byTitle.set(String(p.title).toLowerCase(), p.slug); }
  return (ref: string) => {
    const r = String(ref || "").toLowerCase().replace(/\.md$/i, "");
    return byKey.get(r) || byTitle.get(r) || null;
  };
}

/** citationCount(P) = number of library papers that cite P (P's children count). */
function citationCounts(all: any[]): Map<string, number> {
  const resolve = buildPaperResolver(all);
  const counts = new Map<string, number>();
  for (const p of all) for (const c of p.cites) {
    const t = resolve(c.paper);
    if (t) counts.set(t, (counts.get(t) || 0) + 1);
  }
  return counts;
}

export function paperList(): any[] {
  const all = allPaperFiles().map(paperFromFile);
  const counts = citationCounts(all);
  return all
    .map(({ content, ...meta }) => ({ ...meta, citationCount: counts.get(meta.slug) || 0 }))
    .sort((a, b) => (b.citationCount - a.citationCount) || ((b.year || 0) - (a.year || 0)) || a.title.localeCompare(b.title));
}

export function paperSearch(q: string): any[] {
  const n = q.toLowerCase();
  return paperList().filter(p =>
    p.title.toLowerCase().includes(n) ||
    p.topic.toLowerCase().includes(n) ||
    p.publisher.toLowerCase().includes(n) ||
    (p.authors as string[]).join(" ").toLowerCase().includes(n) ||
    (p.tags as string[]).join(" ").toLowerCase().includes(n) ||
    String(p.year || "").includes(n));
}

export function paperGet(slug: string): any {
  const full = join(papersRoot(), slug + ".md");
  if (!existsSync(full)) return null;
  const st = statSync(full);
  return paperFromFile({ full, rel: slug + ".md", mtime: st.mtimeMs });
}

export function paperUpsert(row: {
  slug: string; title: string; content?: string; authors?: string[]; year?: number | string | null;
  topic?: string; publisher?: string; tags?: string[]; url?: string; file?: string;
  conclusions?: string[]; cites?: Cite[]; category?: string; kind?: string; group?: string;
}): boolean {
  const existing = paperGet(row.slug);
  const category = safeCategory(row.category ?? existing?.category ?? "");
  const filename = safeName(row.title || nameOf(row.slug)) + ".md";
  const newRel = category ? `${category}/${filename}` : filename;
  const full = join(papersRoot(), newRel);
  const created = existing?.created_at ?? now();

  const oldFull = join(papersRoot(), row.slug + ".md");
  if (existing && relNoExt(newRel) !== row.slug && existsSync(oldFull)) {
    try { rmSync(oldFull, { force: true }); } catch { /* ignore */ }
  }
  mkdirSync(join(full, ".."), { recursive: true });
  const fm: Record<string, any> = {
    title: row.title,
    kind: (row.kind ?? existing?.kind) === "idea" ? "idea" : undefined,
    group: (() => { const g = (row.group ?? existing?.group ?? "").trim(); return g && g !== "Papers" ? g : undefined; })(),
    authors: row.authors ?? existing?.authors ?? [],
    year: toYear(row.year ?? existing?.year),
    topic: row.topic ?? existing?.topic ?? "",
    publisher: row.publisher ?? existing?.publisher ?? "",
    tags: row.tags ?? existing?.tags ?? [],
    url: row.url ?? existing?.url ?? "",
    file: row.file ?? existing?.file ?? "",
    conclusions: row.conclusions ?? existing?.conclusions ?? [],
    cites: normalizeCites(row.cites ?? existing?.cites ?? []),
    created,
  };
  writeFileSync(full, serializeFrontmatter(fm, row.content ?? existing?.content ?? ""));
  return !existing;
}

export function paperDelete(slug: string): boolean {
  const full = join(papersRoot(), slug + ".md");
  if (!existsSync(full)) return false;
  try { rmSync(full, { force: true }); return true; } catch { return false; }
}

/** Distinct topics / tags / year range for filter UIs (each with a count). */
export function paperFacets(): { topics: { name: string; count: number }[]; tags: { name: string; count: number }[]; years: number[] } {
  const all = allPaperFiles().map(paperFromFile);
  const topics = new Map<string, number>(), tags = new Map<string, number>(), years = new Set<number>();
  for (const p of all) {
    if (p.topic) topics.set(p.topic, (topics.get(p.topic) || 0) + 1);
    for (const t of p.tags) tags.set(t, (tags.get(t) || 0) + 1);
    if (p.year) years.add(p.year);
  }
  const sortByCount = (m: Map<string, number>) => [...m.entries()].map(([name, count]) => ({ name, count })).sort((a, b) => b.count - a.count || a.name.localeCompare(b.name));
  return { topics: sortByCount(topics), tags: sortByCount(tags), years: [...years].sort((a, b) => b - a) };
}

/** Build the citation graph (nodes + edges). Edge from = cited parent, to = citing child. */
export function paperGraph(opts: {
  topic?: string; tag?: string; minYear?: number; maxYear?: number; limit?: number; neighbors?: boolean; q?: string;
} = {}): any {
  const all = allPaperFiles().map(paperFromFile);
  const resolve = buildPaperResolver(all);
  const counts = citationCounts(all);
  const bySlug = new Map<string, any>(all.map(p => [p.slug, p]));

  const nlc = (opts.q || "").toLowerCase();
  const filtered = all.filter(p => {
    if (opts.topic && p.topic !== opts.topic) return false;
    if (opts.tag && !p.tags.includes(opts.tag)) return false;
    if (opts.minYear && (p.year || 0) < opts.minYear) return false;
    if (opts.maxYear && (p.year || 9999) > opts.maxYear) return false;
    if (nlc && !(p.title.toLowerCase().includes(nlc) || p.topic.toLowerCase().includes(nlc) ||
                 (p.authors as string[]).join(" ").toLowerCase().includes(nlc))) return false;
    return true;
  });
  filtered.sort((a, b) => (counts.get(b.slug)! || 0) - (counts.get(a.slug)! || 0) || ((b.year || 0) - (a.year || 0)));

  const limit = opts.limit && opts.limit > 0 ? opts.limit : 10;
  const nodeSet = new Set<string>(filtered.slice(0, limit).map(p => p.slug));

  if (opts.neighbors) {
    for (const s of [...nodeSet]) {
      const p = bySlug.get(s);
      if (!p) continue;
      for (const c of p.cites) { const t = resolve(c.paper); if (t) nodeSet.add(t); }      // parents (cited)
      for (const q of all) for (const c of q.cites) { if (resolve(c.paper) === s) nodeSet.add(q.slug); } // children (citing)
    }
  }

  const nodes = [...nodeSet].map(s => bySlug.get(s)).filter(Boolean).map(p => ({
    key: p.slug, title: p.title, year: p.year, topic: p.topic, authors: p.authors, tags: p.tags,
    kind: p.kind, group: p.group, citationCount: counts.get(p.slug) || 0, conclusions: p.conclusions, url: p.url, file: p.file, category: p.category,
  }));
  const edges: any[] = [];
  for (const p of all) {
    if (!nodeSet.has(p.slug)) continue;
    for (const c of p.cites) {
      const t = resolve(c.paper);
      if (t && nodeSet.has(t)) edges.push({ from: t, to: p.slug, note: c.note });
    }
  }
  return { nodes, edges, total: filtered.length, shown: nodes.length };
}

/** Store an uploaded paper file (e.g. a PDF) under the paper's own _assets/ folder. */
export function savePaperFile(base64: string, ext: string, category = ""): string {
  const buf = Buffer.from(base64, "base64");
  const hash = createHash("sha1").update(buf).digest("hex").slice(0, 16);
  const safeExt = (ext || "pdf").replace(/[^a-zA-Z0-9]/g, "").toLowerCase() || "pdf";
  const cat = safeCategory(category);
  const dir = cat ? join(_store, "papers", ...cat.split("/"), "_assets") : join(_store, "papers", "_assets");
  mkdirSync(dir, { recursive: true });
  const rel = `_assets/${hash}.${safeExt}`;
  const full = join(dir, `${hash}.${safeExt}`);
  if (!existsSync(full)) writeFileSync(full, buf);
  return rel;
}

// ── Paper groups (user-assigned, distinct from the derived topic) ────────────
// A group is just a label on each paper; "Papers" is the default. Groups are
// derived from the items (a group exists while ≥1 paper is in it).
export function paperGroups(): { name: string; count: number }[] {
  const counts = new Map<string, number>();
  for (const p of allPaperFiles().map(paperFromFile)) {
    const g = p.group || "Papers";
    counts.set(g, (counts.get(g) || 0) + 1);
  }
  counts.set("Papers", counts.get("Papers") || 0); // always present
  const custom = [...counts.entries()].filter(([n]) => n !== "Papers")
    .sort((a, b) => a[0].localeCompare(b[0]));
  return [...custom, ["Papers", counts.get("Papers")!] as [string, number]]
    .map(([name, count]) => ({ name, count }));
}

export function paperSetGroup(slug: string, group: string): boolean {
  const p = paperGet(slug);
  if (!p) return false;
  paperUpsert({ ...p, group: (group || "Papers").trim() || "Papers" });
  return true;
}

export function paperGroupRename(oldName: string, newName: string): number {
  const to = (newName || "").trim();
  if (!to || !oldName) return 0;
  let n = 0;
  for (const p of allPaperFiles().map(paperFromFile)) {
    if ((p.group || "Papers") === oldName) { paperUpsert({ ...p, group: to }); n++; }
  }
  return n;
}

export function paperGroupDelete(name: string): number {
  if (!name || name === "Papers") return 0; // can't delete the default
  let n = 0;
  for (const p of allPaperFiles().map(paperFromFile)) {
    if ((p.group || "Papers") === name) { paperUpsert({ ...p, group: "Papers" }); n++; }
  }
  return n;
}

