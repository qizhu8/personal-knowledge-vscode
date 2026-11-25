import type { DatabaseSync, StatementSync } from "node:sqlite";
import { CoreError } from "./host-composition-legacy-batch15-errors.js";
import {
  isQualifiedFreshRootScan, type FreshNoteQuery, type FreshNoteQueryModel, type FreshNoteQueryOptions,
  type FreshNoteSource, type FreshRootScan,
} from "./fresh-note-query-contracts.js";
import {
  buildLegacyInventoryView, legacyInventoryPage, normalizeLegacyList, projectLegacyNote, pythonJson,
  type LegacyInventoryView, type LegacyProjectedNote,
} from "./domain/legacy-note-query-original.js";
import { assertLegacyNoteUnicode, pythonLower } from "./domain/legacy-note-query-unicode.js";

export const FRESH_NOTE_QUERY_SCHEMA_VERSION = 1;
export const FRESH_NOTE_QUERY_DDL = Object.freeze([
  `CREATE TABLE fresh_note_query_meta (
    singleton INTEGER PRIMARY KEY CHECK(singleton=1), schema_version INTEGER NOT NULL,
    workspace_id TEXT NOT NULL, root_pin TEXT NOT NULL, generation INTEGER NOT NULL,
    guard_digest TEXT NOT NULL
  )`,
  `CREATE TABLE fresh_note_query_sources (
    area TEXT NOT NULL, path TEXT NOT NULL, document_id TEXT NOT NULL,
    sha256 TEXT NOT NULL, source_pin TEXT NOT NULL, PRIMARY KEY(area,path)
  )`,
  `CREATE TABLE fresh_note_query_identities (
    identity_key TEXT NOT NULL, area TEXT NOT NULL, path TEXT NOT NULL, key_kind TEXT NOT NULL,
    PRIMARY KEY(identity_key,area,path,key_kind)
  )`,
  `CREATE TABLE fresh_note_query_notes (
    source_key TEXT NOT NULL UNIQUE, slug TEXT NOT NULL, walk_key BLOB NOT NULL,
    title TEXT NOT NULL, content TEXT NOT NULL, type_json TEXT NOT NULL,
    inventory_json TEXT NOT NULL, lower_title BLOB NOT NULL, lower_content BLOB NOT NULL,
    search_eligible INTEGER NOT NULL CHECK(search_eligible IN (0,1))
  )`,
  "CREATE VIRTUAL TABLE fresh_note_query_fts USING fts5(slug,title,content, tokenize='trigram')",
]);
export const FRESH_NOTE_QUERY_DERIVED_TABLES = Object.freeze([
  "fresh_note_query_meta", "fresh_note_query_sources", "fresh_note_query_identities", "fresh_note_query_notes",
  "fresh_note_query_fts", "fresh_note_query_fts_data", "fresh_note_query_fts_idx", "fresh_note_query_fts_content",
  "fresh_note_query_fts_docsize", "fresh_note_query_fts_config",
]);
const objectNames = FRESH_NOTE_QUERY_DDL.map(sql => /CREATE (?:VIRTUAL )?TABLE (\w+)/.exec(sql)![1]!);
const sqlFingerprint = (sql: string) => sql.replace(/\s+/g, " ").trim();
type Guard = FreshNoteQueryOptions["guard"];

function scope(guard: Guard, phase: Parameters<Guard["assert"]>[0]) {
  if (!guard || typeof guard.assert !== "function")
    throw new CoreError("ACCESS_DENIED", "Fresh Note queries require a trusted native guard.");
  const value = guard.assert(phase);
  if (!value || typeof value.workspaceId !== "string" || !value.workspaceId || typeof value.rootPin !== "string" || !value.rootPin)
    throw new CoreError("ACCESS_DENIED", "Fresh Note queries require a live trusted workspace/root binding.");
  return Object.freeze({ workspaceId: value.workspaceId, rootPin: value.rootPin });
}
/** Only the active trusted root owner may initialize these disposable query tables. */
export function initializeFreshNoteQuerySchema(database: DatabaseSync, guard: Guard): void {
  const before = scope(guard, "initialize");
  if (database.isTransaction) throw new CoreError("BUSY", "Fresh Note schema initialization requires its own owner transaction.");
  database.exec("BEGIN IMMEDIATE");
  try {
    for (let index = 0; index < FRESH_NOTE_QUERY_DDL.length; index++) {
      const name = objectNames[index]!, ddl = FRESH_NOTE_QUERY_DDL[index]!;
      const existing = database.prepare("SELECT sql FROM sqlite_master WHERE name=?").get(name);
      if (existing && sqlFingerprint(String(existing.sql)) !== sqlFingerprint(ddl))
        throw new CoreError("STORAGE_ERROR", `Fresh Note derived schema differs: ${name}.`);
      if (!existing) database.exec(ddl);
    }
    const row = database.prepare("SELECT schema_version FROM fresh_note_query_meta WHERE singleton=1").get();
    if (row && row.schema_version !== FRESH_NOTE_QUERY_SCHEMA_VERSION)
      throw new CoreError("STORAGE_ERROR", "Unsupported fresh Note derived schema version.");
    const after = scope(guard, "initialize");
    if (before.workspaceId !== after.workspaceId || before.rootPin !== after.rootPin)
      throw new CoreError("ACCESS_DENIED", "Fresh Note schema owner changed during initialization.");
    database.exec("COMMIT");
  } catch (error) {
    if (database.isTransaction) database.exec("ROLLBACK");
    if (error instanceof CoreError) throw error;
    throw new CoreError("NOT_AVAILABLE", `Native SQLite trigram Note index is unavailable: ${String(error)}`);
  }
}
function sourcePin(source: FreshNoteSource): string {
  return `${source.statPin}:${source.sha256}:${source.dependencyPin}`;
}
function databasePin(db: DatabaseSync): string {
  return `${db.prepare("PRAGMA data_version").get()!.data_version}:${db.prepare("PRAGMA schema_version").get()!.schema_version}:${db.prepare("SELECT total_changes() AS n").get()!.n}`;
}
function sameScope(a: ReturnType<typeof scope>, b: ReturnType<typeof scope>) {
  if (a.workspaceId !== b.workspaceId || a.rootPin !== b.rootPin)
    throw new CoreError("ACCESS_DENIED", "Fresh Note workspace/root authority changed.");
}
function checkedScan(scan: FreshRootScan, expected: ReturnType<typeof scope>) {
  if (!isQualifiedFreshRootScan(scan) || scan.rootPin !== expected.rootPin)
    throw new CoreError("ACCESS_DENIED", "Fresh Note sources were not qualified by the bound native scanner.");
}
function queryError(error: unknown): never {
  if (error instanceof CoreError) throw error;
  if (error instanceof Error && /database is locked|database is busy|SQLITE_BUSY/i.test(error.message))
    throw new CoreError("BUSY", "The root index is busy; no cached Note result was returned.");
  throw new CoreError("STORAGE_ERROR", `Fresh Note query failed without returning cached results: ${String(error)}`);
}
function assertDerivedSchema(db: DatabaseSync) {
  for (let index = 0; index < objectNames.length; index++) {
    const row = db.prepare("SELECT sql FROM sqlite_master WHERE name=?").get(objectNames[index]!);
    if (!row || sqlFingerprint(String(row.sql)) !== sqlFingerprint(FRESH_NOTE_QUERY_DDL[index]!))
      throw new CoreError("STORAGE_ERROR", "The trusted owner must initialize the exact fresh Note schema first.");
  }
}

export function createFreshNoteQueryModel(options: FreshNoteQueryOptions): FreshNoteQueryModel {
  const db = options.database, guard = options.guard;
  const owner = scope(guard, "initialize");
  if (options.scanner.rootPin !== owner.rootPin) throw new CoreError("ACCESS_DENIED", "Fresh Note scanner belongs to another root.");
  assertLegacyNoteUnicode();
  assertDerivedSchema(db);
  let closed = false, active = false, accepted: ReadonlyMap<string, FreshNoteSource> | undefined;
  let projected = new Map<string, LegacyProjectedNote>(), views = new Map<string, LegacyInventoryView>();
  let lastPage: { view: LegacyInventoryView; key: string; text: string } | undefined;
  let knownDatabasePin = databasePin(db), generation = 0;
  let knownExternalVersion = options.externalDatabaseVersion?.();
  const statements = new Map<string, StatementSync>();
  const prepare = (sql: string): StatementSync => {
    let statement = statements.get(sql);
    if (!statement) { statement = db.prepare(sql); statements.set(sql, statement); }
    return statement;
  };
  const statistics = { reconciliations: 0, ftsUpdates: 0, generations: 0 };

  function executeFresh(query: FreshNoteQuery) {
    if (closed) throw new CoreError("STORAGE_UNAVAILABLE", "Fresh Note query model is closed.");
    if (active || db.isTransaction) throw new CoreError("BUSY", "Fresh Note queries require their exclusive owner transaction.");
    active = true;
    try {
      sameScope(owner, scope(guard, "before"));
      // Take the existing SQLite writer fence before observing a foreign index writer.
      // Even a zero-delta transaction writes no projection rows.
      db.exec("BEGIN IMMEDIATE");
      const foreign = knownDatabasePin !== databasePin(db) || knownExternalVersion !== options.externalDatabaseVersion?.();
      if (foreign) assertDerivedSchema(db);
      const first = options.scanner.scan(); checkedScan(first, owner);
      const rebuild = accepted === undefined || foreign;
      const changed = [...first.sources].filter(([key, source]) => rebuild || !accepted!.has(key)
        || sourcePin(source) !== sourcePin(accepted!.get(key)!));
      const removed = rebuild ? [] : [...accepted!].filter(([key]) => !first.sources.has(key));
      const hasDelta = rebuild || changed.length !== 0 || removed.length !== 0;
      const next = hasDelta ? new Map(projected) : projected;
      const nextViews = hasDelta ? new Map<string, LegacyInventoryView>() : new Map(views);
      let nextPage = hasDelta ? undefined : lastPage;
      let ftsUpdates = 0;
      try {
        if (rebuild) {
          // A foreign writer may have changed postings/rank configuration, not just content rows.
          statements.clear();
          db.exec(`DROP TABLE fresh_note_query_fts; ${FRESH_NOTE_QUERY_DDL[4]};
            DELETE FROM fresh_note_query_notes; DELETE FROM fresh_note_query_identities; DELETE FROM fresh_note_query_sources;`);
          next.clear();
        }
        const deleteSource = (key: string, area: string, path: string) => {
          const row = prepare("SELECT rowid,search_eligible FROM fresh_note_query_notes WHERE source_key=?").get(key);
          if (row?.search_eligible) { prepare("DELETE FROM fresh_note_query_fts WHERE rowid=?").run(row.rowid!); ftsUpdates++; }
          prepare("DELETE FROM fresh_note_query_notes WHERE source_key=?").run(key);
          prepare("DELETE FROM fresh_note_query_identities WHERE area=? AND path=?").run(area, path);
          prepare("DELETE FROM fresh_note_query_sources WHERE area=? AND path=?").run(area, path);
          next.delete(key);
        };
        for (const [key, source] of removed) deleteSource(key, source.area, source.path);
        for (const [key, source] of changed) {
          prepare(`INSERT INTO fresh_note_query_sources VALUES(?,?,?,?,?)
            ON CONFLICT(area,path) DO UPDATE SET document_id=excluded.document_id,sha256=excluded.sha256,source_pin=excluded.source_pin`)
            .run(source.area, source.path, source.id, source.sha256, sourcePin(source));
          const previousSource = accepted?.get(key);
          if (rebuild || !previousSource || previousSource.id !== source.id || previousSource.knowledgeId !== source.knowledgeId) {
            if (!rebuild) prepare("DELETE FROM fresh_note_query_identities WHERE area=? AND path=?").run(source.area, source.path);
            prepare("INSERT INTO fresh_note_query_identities VALUES(?,?,?,?)").run(source.id, source.area, source.path, "document");
            if (source.knowledgeId !== null) prepare("INSERT INTO fresh_note_query_identities VALUES(?,?,?,?)")
              .run(source.knowledgeId, source.area, source.path, "knowledge");
          }
          if (source.area !== "notes") continue;
          const note = projectLegacyNote(source), previous = next.get(key);
          const ftsChanged = !previous || previous.searchEligible !== note.searchEligible || previous.row.slug !== note.row.slug
            || previous.title !== note.title || previous.content !== note.content;
          prepare(`INSERT INTO fresh_note_query_notes VALUES(?,?,?,?,?,?,?,?,?,?)
            ON CONFLICT(source_key) DO UPDATE SET slug=excluded.slug,walk_key=excluded.walk_key,title=excluded.title,
            content=excluded.content,type_json=excluded.type_json,inventory_json=excluded.inventory_json,
            lower_title=excluded.lower_title,lower_content=excluded.lower_content,search_eligible=excluded.search_eligible`)
            .run(key, note.row.slug, note.walkKey, note.title, note.content, pythonJson(note.row.type), pythonJson(note.row),
              Buffer.from(pythonLower(note.title)), Buffer.from(pythonLower(note.content)), note.searchEligible ? 1 : 0);
          if (ftsChanged) {
            if (!rebuild) {
              const row = prepare("SELECT rowid FROM fresh_note_query_notes WHERE source_key=?").get(key)!;
              prepare("DELETE FROM fresh_note_query_fts WHERE rowid=?").run(row.rowid!);
              if (note.searchEligible) prepare("INSERT INTO fresh_note_query_fts(rowid,slug,title,content) VALUES(?,?,?,?)")
                .run(row.rowid!, note.row.slug, note.title, note.content);
            }
            ftsUpdates++;
          }
          next.set(key, note);
        }
        if (rebuild) prepare(`INSERT INTO fresh_note_query_fts(rowid,slug,title,content)
          SELECT rowid,slug,title,content FROM fresh_note_query_notes WHERE search_eligible=1 ORDER BY rowid`).run();
        if (hasDelta && options.reconcileRootIndex) {
          const result = options.reconcileRootIndex(first, Object.freeze({ rebuild,
            changed: Object.freeze(changed.map(([, source]) => source)),
            removed: Object.freeze(removed.map(([, source]) => source)) }));
          if (result !== undefined) throw new CoreError("INVALID_ARGUMENT", "Root index reconciliation must be synchronous and return undefined.");
        }
        let text: string;
        if (query.kind === "list") {
          const args = normalizeLegacyList(query.arguments);
          if (!first.directories.has(`notes/${args.directory}`))
            throw new CoreError("INVALID_ARGUMENT", `Notes directory was not found: ${args.directory}`);
          const key = pythonJson([args.directory, args.recursive, args.type]);
          let view = nextViews.get(key);
          if (!view) {
            view = buildLegacyInventoryView([...next.values()].map(note => note.row), args);
            while (nextViews.size && (nextViews.size >= 32
              || [...nextViews.values()].reduce((sum, item) => sum + item.bytes, view.bytes) > 8 * 1024 * 1024))
              nextViews.delete(nextViews.keys().next().value!);
            if (view.bytes <= 8 * 1024 * 1024) nextViews.set(key, view);
          }
          const pageKey = pythonJson([args.offset, args.limit, args.revision]);
          if (nextPage?.view === view && nextPage.key === pageKey) text = nextPage.text;
          else {
            text = legacyInventoryPage(view, args);
            nextPage = view.bytes <= 1024 * 1024 && Buffer.byteLength(text) <= 1024 * 1024
              ? { view, key: pageKey, text } : undefined;
          }
        } else if (query.kind === "legacy-lexical") {
          const args = query.arguments;
          if (typeof args.query !== "string" || !/^(?:[^\uD800-\uDFFF]|[\uD800-\uDBFF][\uDC00-\uDFFF])*$/.test(args.query)) throw new CoreError("INVALID_ARGUMENT", "query must be a well-formed string.");
          if (args.limit != null && (!Number.isFinite(args.limit) || typeof args.limit !== "number"))
            throw new CoreError("INVALID_ARGUMENT", "limit must be an integer.");
          const limit = Math.max(1, Math.min(Math.trunc(args.limit || 20), 100));
          let rows: Array<Record<string, unknown>> = [];
          try {
            rows = prepare(`SELECT n.source_key FROM fresh_note_query_fts
              JOIN fresh_note_query_notes n ON n.rowid=fresh_note_query_fts.rowid
              WHERE fresh_note_query_fts MATCH ? ORDER BY rank,n.walk_key LIMIT ?`).all(args.query, limit);
          } catch (error) {
            if (!(error instanceof Error) || !/fts5: syntax error|unterminated string|unknown special query|no such column:/i.test(error.message)) throw error;
          }
          if (!rows.length) {
            const lowered = Buffer.from(pythonLower(args.query));
            rows = prepare(`SELECT source_key FROM fresh_note_query_notes WHERE search_eligible=1
              AND (instr(lower_title,?)>0 OR instr(lower_content,?)>0) ORDER BY walk_key LIMIT ?`).all(lowered, lowered, limit);
          }
          text = pythonJson(rows.map(row => {
            const note = next.get(String(row.source_key));
            if (!note) throw new CoreError("STORAGE_ERROR", "Note index returned a source outside the fresh projection.");
            return { slug: note.row.slug, title: note.row.title, type: note.row.type };
          }), false, true);
        } else throw new CoreError("INVALID_ARGUMENT", "Unknown private fresh Note query.");
        let expectedDatabasePin = databasePin(db);
        sameScope(owner, scope(guard, "after-query"));
        if (databasePin(db) !== expectedDatabasePin) throw new CoreError("CONFLICT", "The root index changed during a Note read.");
        const second = options.scanner.scan(); checkedScan(second, owner);
        if (first.guardDigest !== second.guardDigest)
          throw new CoreError("CONFLICT", "Knowledge changed during Note query; restart from the first page.");
        sameScope(owner, scope(guard, "after-scan"));
        if (databasePin(db) !== expectedDatabasePin) throw new CoreError("CONFLICT", "The root index changed during a Note read.");
        const nextGeneration = generation + (hasDelta ? 1 : 0);
        if (hasDelta) prepare(`INSERT INTO fresh_note_query_meta VALUES(1,?,?,?,?,?)
          ON CONFLICT(singleton) DO UPDATE SET schema_version=excluded.schema_version,workspace_id=excluded.workspace_id,
          root_pin=excluded.root_pin,generation=excluded.generation,guard_digest=excluded.guard_digest`)
          .run(FRESH_NOTE_QUERY_SCHEMA_VERSION, owner.workspaceId, owner.rootPin, nextGeneration, first.guardDigest);
        expectedDatabasePin = databasePin(db);
        sameScope(owner, scope(guard, "before-commit"));
        if (databasePin(db) !== expectedDatabasePin) throw new CoreError("CONFLICT", "The root index changed before Note query commit.");
        db.exec("COMMIT");
        accepted = first.sources; projected = next; views = nextViews; lastPage = nextPage; generation = nextGeneration;
        statistics.reconciliations += hasDelta ? 1 : 0;
        statistics.ftsUpdates += ftsUpdates; statistics.generations = generation;
        // FTS sync can increment this connection's total_changes during COMMIT.
        // Only refresh that local counter; never absorb a foreign post-commit data_version.
        knownDatabasePin = `${expectedDatabasePin.split(":").slice(0, 2).join(":")}:${db.prepare("SELECT total_changes() AS n").get()!.n}`;
        knownExternalVersion = options.externalDatabaseVersion?.();
        return Object.freeze({ text, generation, guardDigest: first.guardDigest });
      } catch (error) {
        if (db.isTransaction) {
          db.exec("ROLLBACK");
          if (!foreign && accepted) knownDatabasePin = `${knownDatabasePin.split(":").slice(0, 2).join(":")}:${db.prepare("SELECT total_changes() AS n").get()!.n}`;
        }
        throw error;
      }
    } catch (error) {
      if (db.isTransaction) db.exec("ROLLBACK");
      return queryError(error);
    }
    finally { active = false; }
  }
  return Object.freeze({ executeFresh, statistics: () => Object.freeze({ ...statistics }), close() {
    if (active) throw new CoreError("BUSY", "Fresh Note query is still active.");
    closed = true; accepted = undefined; projected.clear(); views.clear(); lastPage = undefined; statements.clear();
  } });
}
