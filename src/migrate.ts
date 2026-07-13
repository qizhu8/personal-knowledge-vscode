/**
 * migrate.ts — one-time, hidden migration from the legacy SQLite DB to
 * files-as-truth. Lazy-loads sql.js only if an un-migrated knowledge.db exists,
 * so fresh installs never pay for it. Idempotent and non-destructive: the old
 * knowledge.db is kept as a backup, and existing files are never overwritten.
 */
import { join } from "path";
import { existsSync, readFileSync, renameSync, mkdirSync } from "fs";
import { skillUpsert, noteUpsert, getStorePath } from "./filestore";

export interface MigrationResult { migrated: boolean; skills: number; notes: number; }

export async function migrateDbToFiles(extPath: string): Promise<MigrationResult> {
  const store = getStorePath();
  const dbPath = join(store, "knowledge.db");
  if (!existsSync(dbPath)) return { migrated: false, skills: 0, notes: 0 };

  // Lazy-load sql.js (WASM build)
  const jsPath = existsSync(join(extPath, "dist", "sql-wasm.js"))
    ? join(extPath, "dist", "sql-wasm.js")
    : join(extPath, "node_modules", "sql.js", "dist", "sql-wasm.js");
  const wasmPath = existsSync(join(extPath, "dist", "sql-wasm.wasm"))
    ? join(extPath, "dist", "sql-wasm.wasm")
    : join(extPath, "node_modules", "sql.js", "dist", "sql-wasm.wasm");
  if (!existsSync(jsPath) || !existsSync(wasmPath)) return { migrated: false, skills: 0, notes: 0 };

  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const initSqlJs = require(jsPath);
  const SQL = await initSqlJs({ wasmBinary: readFileSync(wasmPath) });
  const db = new SQL.Database(readFileSync(dbPath));

  const rows = (sql: string): any[] => {
    try {
      const stmt = db.prepare(sql);
      const out: any[] = [];
      while (stmt.step()) out.push(stmt.getAsObject());
      stmt.free();
      return out;
    } catch { return []; }
  };

  const skillRows = rows("SELECT name,content,description,category,tags,source_project FROM skills");
  const noteRows  = rows("SELECT slug,title,content,type,category,tags FROM notes");

  // Back up any pre-existing notes/ and skills/ folders (e.g. old 1.1.x flat/
  // underscore mirror files) so the fresh, DB-authoritative write has no collisions.
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const backupRoot = join(store, `_pre-files-backup-${stamp}`);
  for (const folder of ["notes", "skills"]) {
    const src = join(store, folder);
    if (existsSync(src)) {
      mkdirSync(backupRoot, { recursive: true });
      try { renameSync(src, join(backupRoot, folder)); } catch { /* ignore */ }
    }
  }

  let skills = 0, notes = 0;
  for (const s of skillRows) {
    try {
      skillUpsert({
        name: s.name, content: s.content ?? "",
        description: s.description ?? "", category: s.category ?? "",
        tags: JSON.parse(s.tags || "[]"), source_project: s.source_project ?? undefined,
      });
      skills++;
    } catch { /* skip */ }
  }
  for (const n of noteRows) {
    try {
      noteUpsert({
        slug: n.slug || n.title, title: n.title || n.slug || "note",
        content: n.content ?? "", type: n.type ?? "general",
        tags: JSON.parse(n.tags || "[]"), category: n.category ?? "",
      });
      notes++;
    } catch { /* skip */ }
  }
  db.close();

  return { migrated: true, skills, notes };
}
