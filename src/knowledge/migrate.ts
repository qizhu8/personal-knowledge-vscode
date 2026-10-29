/**
 * migrate.ts — one-time, hidden migration from the legacy SQLite DB to
 * files-as-truth. Lazy-loads sql.js only if an un-migrated knowledge.db exists,
 * so fresh installs never pay for it. Idempotent and non-destructive: the old
 * knowledge.db is kept as a backup, and existing files are never overwritten.
 */
import { join } from "path";
import { existsSync, lstatSync, readFileSync, readdirSync } from "fs";
import { skillUpsert, noteUpsert, getStorePath } from "./filestore";

export interface MigrationResult { migrated: boolean; skills: number; notes: number; }

export async function migrateDbToFiles(extPath: string): Promise<MigrationResult> {
  const store = getStorePath();
  const dbPath = join(store, "knowledge.db");
  if (!existsSync(dbPath)) return { migrated: false, skills: 0, notes: 0 };
  const hasFiles = (directory: string): boolean => existsSync(directory)
    && (lstatSync(directory).isSymbolicLink() || readdirSync(directory, { withFileTypes: true }).some(entry =>
      entry.name !== ".gitkeep" && (entry.isSymbolicLink() || entry.isFile()
        || entry.isDirectory() && hasFiles(join(directory, entry.name)))));
  if (["skills", "notes"].some(area => hasFiles(join(store, area)))) {
    return { migrated: false, skills: 0, notes: 0 };
  }

  // Lazy-load sql.js (WASM build)
  const jsPath = existsSync(join(extPath, "dist", "sql-wasm.js"))
    ? join(extPath, "dist", "sql-wasm.js")
    : join(extPath, "node_modules", "sql.js", "dist", "sql-wasm.js");
  const wasmPath = existsSync(join(extPath, "dist", "sql-wasm.wasm"))
    ? join(extPath, "dist", "sql-wasm.wasm")
    : join(extPath, "node_modules", "sql.js", "dist", "sql-wasm.wasm");
  if (!existsSync(jsPath) || !existsSync(wasmPath)) {
    throw new Error("Legacy knowledge.db exists, but the SQLite migration runtime is unavailable.");
  }

  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const initSqlJs = require(jsPath);
  const SQL = await initSqlJs({ wasmBinary: readFileSync(wasmPath) });
  const db = new SQL.Database(readFileSync(dbPath));

  const rows = (sql: string): any[] => {
    const stmt = db.prepare(sql);
    const out: any[] = [];
    try {
      while (stmt.step()) out.push(stmt.getAsObject());
      return out;
    } finally {
      stmt.free();
    }
  };

  try {
    const tables = new Set(rows("SELECT name FROM sqlite_master WHERE type = 'table'").map(row => row.name));
    const skillRows = tables.has("skills") ? rows("SELECT name,content,description,category,tags,source_project FROM skills") : [];
    const noteRows = tables.has("notes") ? rows("SELECT slug,title,content,type,category,tags FROM notes") : [];
    const preparedSkills = skillRows.map(row => ({ ...row, tags: JSON.parse(row.tags || "[]") }));
    const preparedNotes = noteRows.map(row => ({ ...row, tags: JSON.parse(row.tags || "[]") }));
    if (["skills", "notes"].some(area => hasFiles(join(store, area)))) {
      return { migrated: false, skills: 0, notes: 0 };
    }
    let skills = 0, notes = 0;
    for (const s of preparedSkills) {
      skillUpsert({
        name: s.name, content: s.content ?? "",
        description: s.description ?? "", category: s.category ?? "",
        tags: s.tags, source_project: s.source_project ?? undefined,
      });
      skills++;
    }
    for (const n of preparedNotes) {
      noteUpsert({
        slug: n.slug || n.title, title: n.title || n.slug || "note",
        content: n.content ?? "", type: n.type ?? "general",
        tags: n.tags, category: n.category ?? "",
      });
      notes++;
    }
    return { migrated: skills + notes > 0, skills, notes };
  } finally {
    db.close();
  }
}
