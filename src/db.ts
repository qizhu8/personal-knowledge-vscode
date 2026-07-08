/**
 * db.ts — SQLite persistence layer using sql.js (pure JS, no native binaries).
 * Call setStorePath() then initDb() once from activate() before using any other export.
 */
import { homedir } from "os";
import { join } from "path";
import { mkdirSync, existsSync, readFileSync, writeFileSync } from "fs";

// ── Module-level state ────────────────────────────────────────────────────
let _db: any = null;
let _dbPath   = "";
let _storePath = join(homedir(), "personal-knowledge");

export function setStorePath(p: string): void {
  _storePath = p?.trim() || join(homedir(), "personal-knowledge");
}

export function getStorePath(): string { return _storePath; }

/** Initialize sql.js and open (or create) the database. */
export async function initDb(extPath: string): Promise<void> {
  const asmPath = existsSync(join(extPath, "dist", "sql-asm.js"))
    ? join(extPath, "dist", "sql-asm.js")
    : join(extPath, "node_modules", "sql.js", "dist", "sql-asm.js");

  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const initSqlJs = require(asmPath);
  const SQL = await initSqlJs();

  mkdirSync(_storePath, { recursive: true });
  _dbPath = join(_storePath, "knowledge.db");

  const buf = existsSync(_dbPath) ? readFileSync(_dbPath) : null;
  _db = buf ? new SQL.Database(buf) : new SQL.Database();

  _migrate();
  _saveDb();
}

function _getDb(): any {
  if (!_db) throw new Error("Personal Knowledge: database not initialized");
  return _db;
}

function _saveDb(): void {
  if (!_db || !_dbPath) return;
  writeFileSync(_dbPath, Buffer.from(_db.export() as Uint8Array));
}

function _all(sql: string, params: any[] = []): any[] {
  const stmt = _getDb().prepare(sql);
  stmt.bind(params);
  const rows: any[] = [];
  while (stmt.step()) rows.push(stmt.getAsObject());
  stmt.free();
  return rows;
}

function _get(sql: string, params: any[] = []): any {
  const stmt = _getDb().prepare(sql);
  stmt.bind(params);
  const row = stmt.step() ? stmt.getAsObject() : null;
  stmt.free();
  return row;
}

function _run(sql: string, params: any[] = []): void {
  const stmt = _getDb().prepare(sql);
  stmt.run(params);
  stmt.free();
}

function _rowsModified(): number { return _getDb().getRowsModified(); }

function _migrate(): void {
  const db = _getDb();
  db.run(`CREATE TABLE IF NOT EXISTS skills (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT UNIQUE NOT NULL, content TEXT NOT NULL DEFAULT '',
    description TEXT, category TEXT, tags TEXT NOT NULL DEFAULT '[]',
    source_project TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL)`);
  db.run(`CREATE VIRTUAL TABLE IF NOT EXISTS skills_fts USING fts5(
    name, content, description, content=skills, content_rowid=id)`);
  db.run(`CREATE TRIGGER IF NOT EXISTS skills_fts_insert AFTER INSERT ON skills BEGIN
    INSERT INTO skills_fts(rowid,name,content,description) VALUES(new.id,new.name,new.content,new.description);
  END`);
  db.run(`CREATE TRIGGER IF NOT EXISTS skills_fts_update AFTER UPDATE ON skills BEGIN
    INSERT INTO skills_fts(skills_fts,rowid,name,content,description) VALUES('delete',old.id,old.name,old.content,old.description);
    INSERT INTO skills_fts(rowid,name,content,description) VALUES(new.id,new.name,new.content,new.description);
  END`);
  db.run(`CREATE TRIGGER IF NOT EXISTS skills_fts_delete AFTER DELETE ON skills BEGIN
    INSERT INTO skills_fts(skills_fts,rowid,name,content,description) VALUES('delete',old.id,old.name,old.content,old.description);
  END`);
  db.run(`CREATE TABLE IF NOT EXISTS notes (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    slug TEXT UNIQUE NOT NULL, title TEXT NOT NULL,
    content TEXT NOT NULL DEFAULT '',
    type TEXT NOT NULL DEFAULT 'general', tags TEXT NOT NULL DEFAULT '[]',
    created_at TEXT NOT NULL, updated_at TEXT NOT NULL)`);
  db.run(`CREATE VIRTUAL TABLE IF NOT EXISTS notes_fts USING fts5(
    slug, title, content, content=notes, content_rowid=id)`);
  db.run(`CREATE TRIGGER IF NOT EXISTS notes_fts_insert AFTER INSERT ON notes BEGIN
    INSERT INTO notes_fts(rowid,slug,title,content) VALUES(new.id,new.slug,new.title,new.content);
  END`);
  db.run(`CREATE TRIGGER IF NOT EXISTS notes_fts_update AFTER UPDATE ON notes BEGIN
    INSERT INTO notes_fts(notes_fts,rowid,slug,title,content) VALUES('delete',old.id,old.slug,old.title,old.content);
    INSERT INTO notes_fts(rowid,slug,title,content) VALUES(new.id,new.slug,new.title,new.content);
  END`);
  db.run(`CREATE TRIGGER IF NOT EXISTS notes_fts_delete AFTER DELETE ON notes BEGIN
    INSERT INTO notes_fts(notes_fts,rowid,slug,title,content) VALUES('delete',old.id,old.slug,old.title,old.content);
  END`);
}

const _now = () => new Date().toISOString();

// ── Skills ────────────────────────────────────────────────────────────────
export function skillList(category?: string, tag?: string) {
  let rows = category
    ? _all("SELECT id,name,description,category,tags,updated_at FROM skills WHERE category=? ORDER BY name", [category])
    : _all("SELECT id,name,description,category,tags,updated_at FROM skills ORDER BY category,name");
  if (tag) rows = rows.filter((r: any) => (JSON.parse(r.tags || "[]") as string[]).includes(tag));
  return rows;
}

export function skillSearch(q: string) {
  try {
    return _all(`SELECT s.id,s.name,s.description,s.category,s.tags,s.updated_at
      FROM skills s JOIN skills_fts f ON s.id=f.rowid WHERE skills_fts MATCH ? ORDER BY rank`, [q]);
  } catch { return []; }
}

export function skillGet(name: string) {
  return _get("SELECT * FROM skills WHERE name=?", [name]);
}

export function skillUpsert(row: {
  name: string; content: string;
  description?: string; category?: string; tags?: string[]; source_project?: string;
}) {
  const existing = skillGet(row.name);
  const ts = _now();
  _run(
    `INSERT INTO skills(name,content,description,category,tags,source_project,created_at,updated_at)
     VALUES(?,?,?,?,?,?,?,?)
     ON CONFLICT(name) DO UPDATE SET
       content=excluded.content,
       description=COALESCE(excluded.description,description),
       category=COALESCE(excluded.category,category),
       tags=excluded.tags,
       source_project=COALESCE(excluded.source_project,source_project),
       updated_at=excluded.updated_at`,
    [
      row.name, row.content,
      row.description    ?? existing?.description    ?? null,
      row.category       ?? existing?.category       ?? null,
      JSON.stringify(row.tags ?? (existing ? JSON.parse(existing.tags || "[]") : [])),
      row.source_project ?? existing?.source_project ?? null,
      existing?.created_at ?? ts, ts,
    ]
  );
  _saveDb();
  return !existing;
}

export function skillDelete(name: string): boolean {
  _run("DELETE FROM skills WHERE name=?", [name]);
  const changed = _rowsModified() > 0;
  if (changed) _saveDb();
  return changed;
}

// ── Notes ─────────────────────────────────────────────────────────────────
export function noteList(type?: string, limit = 50) {
  if (type && type !== "all")
    return _all("SELECT id,slug,title,type,tags,updated_at FROM notes WHERE type=? ORDER BY updated_at DESC LIMIT ?", [type, limit]);
  return _all("SELECT id,slug,title,type,tags,updated_at FROM notes ORDER BY updated_at DESC LIMIT ?", [limit]);
}

export function noteSearch(q: string) {
  try {
    return _all(`SELECT n.id,n.slug,n.title,n.type,n.tags,n.updated_at
      FROM notes n JOIN notes_fts f ON n.id=f.rowid WHERE notes_fts MATCH ? ORDER BY rank`, [q]);
  } catch { return []; }
}

export function noteGet(slug: string) {
  return _get("SELECT * FROM notes WHERE slug=?", [slug]);
}

export function noteUpsert(row: {
  slug: string; title: string; content: string; type: string; tags: string[];
}) {
  const ts = _now();
  const existing = noteGet(row.slug);
  const tagsJson = JSON.stringify(row.tags);
  if (existing) {
    _run("UPDATE notes SET title=?,content=?,type=?,tags=?,updated_at=? WHERE slug=?",
      [row.title, row.content, row.type, tagsJson, ts, row.slug]);
  } else {
    _run("INSERT INTO notes(slug,title,content,type,tags,created_at,updated_at) VALUES(?,?,?,?,?,?,?)",
      [row.slug, row.title, row.content, row.type, tagsJson, ts, ts]);
  }
  _saveDb();
  return !existing;
}

export function noteDelete(slug: string): boolean {
  _run("DELETE FROM notes WHERE slug=?", [slug]);
  const changed = _rowsModified() > 0;
  if (changed) _saveDb();
  return changed;
}

export function slugExists(slug: string): boolean {
  return !!_get("SELECT 1 FROM notes WHERE slug=?", [slug]);
}

export function noteExport(): any[] {
  return _all("SELECT * FROM notes ORDER BY created_at");
}

export function noteImport(rows: any[]): number {
  const ts = _now();
  let count = 0;
  for (const r of rows) {
    try {
      _run(
        `INSERT INTO notes(slug,title,content,type,tags,created_at,updated_at)
         VALUES(?,?,?,?,?,?,?)
         ON CONFLICT(slug) DO UPDATE SET
           title=excluded.title, content=excluded.content,
           type=excluded.type, tags=excluded.tags, updated_at=excluded.updated_at`,
        [r.slug, r.title, r.content, r.type ?? "general",
         r.tags ?? "[]", r.created_at ?? ts, r.updated_at ?? ts]
      );
      count++;
    } catch { /* skip invalid rows */ }
  }
  if (count > 0) _saveDb();
  return count;
}
