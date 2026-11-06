import { parentPort, workerData } from "node:worker_threads";
import { DatabaseSync } from "node:sqlite";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { CoreError, type StorageRequest } from "./contracts.js";

const db = new DatabaseSync(join(String(workerData), "core.sqlite"));
const databaseVersion = Number(db.prepare("PRAGMA user_version").get()!.user_version);
if (![0, 1].includes(databaseVersion)) throw new Error(`Unsupported workspace database version ${databaseVersion}; no downgrade performed.`);
db.exec("PRAGMA busy_timeout=3000; PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL;");
db.exec(`
  CREATE TABLE IF NOT EXISTS metadata (id INTEGER PRIMARY KEY CHECK(id=1), revision INTEGER NOT NULL);
  INSERT OR IGNORE INTO metadata VALUES(1,0);
  CREATE TABLE IF NOT EXISTS documents (
    id TEXT PRIMARY KEY, title TEXT NOT NULL, content TEXT NOT NULL,
    revision INTEGER NOT NULL, deleted INTEGER NOT NULL CHECK(deleted IN(0,1))
  );
  CREATE TABLE IF NOT EXISTS receipts (
    operation_id TEXT PRIMARY KEY, fingerprint TEXT NOT NULL, result TEXT NOT NULL,
    actor_id TEXT NOT NULL, operation TEXT NOT NULL, committed_at TEXT NOT NULL
  );
  PRAGMA user_version=1;
`);

function get(id: unknown) {
  const row = db.prepare("SELECT * FROM documents WHERE id=?").get(String(id));
  if (!row) throw new CoreError("NOT_FOUND", "Document not found.");
  return { id: String(row.id), title: String(row.title), content: String(row.content), revision: Number(row.revision), deleted: row.deleted === 1 };
}
function execute({ operation, args, actorId }: StorageRequest): unknown {
  if (operation === "knowledge.document.get") return get(args.id);
  if (operation === "knowledge.document.list") {
    db.exec("BEGIN");
    try {
      const workspaceRevision = Number(db.prepare("SELECT revision FROM metadata WHERE id=1").get()!.revision);
      if (args.workspaceRevision !== undefined && args.workspaceRevision !== workspaceRevision) throw new CoreError("CONFLICT", "Workspace changed; restart pagination.");
      const include = args.includeDeleted ? 1 : 0;
      const total = Number(db.prepare("SELECT count(*) AS total FROM documents WHERE deleted=0 OR ?=1").get(include)!.total);
      const items = db.prepare("SELECT id,title,revision,deleted FROM documents WHERE deleted=0 OR ?=1 ORDER BY id LIMIT ? OFFSET ?")
        .all(include, Number(args.limit), Number(args.offset)).map(row => ({ ...row, deleted: row.deleted === 1 }));
      db.exec("COMMIT");
      const next = Number(args.offset) + items.length;
      return { items, total, nextOffset: next < total ? next : null, workspaceRevision };
    } catch (error) { db.exec("ROLLBACK"); throw error; }
  }
  const fingerprint = createHash("sha256").update(JSON.stringify({ operation, actorId, args })).digest("hex");
  db.exec("BEGIN IMMEDIATE");
  try {
    const receipt = db.prepare("SELECT fingerprint,result FROM receipts WHERE operation_id=?").get(String(args.operationId));
    if (receipt) {
      if (receipt.fingerprint !== fingerprint) throw new CoreError("CONFLICT", "operationId was already used for a different request or actor.");
      db.exec("COMMIT");
      return JSON.parse(String(receipt.result));
    }
    if (operation === "knowledge.document.create") {
      if (db.prepare("SELECT id FROM documents WHERE id=?").get(String(args.id))) throw new CoreError("CONFLICT", "Document ID already exists.");
      db.prepare("INSERT INTO documents VALUES(?,?,?,1,0)").run(String(args.id), String(args.title), String(args.content));
    } else {
      const before = get(args.id);
      if (before.revision !== args.expectedRevision) throw new CoreError("CONFLICT", "Document revision changed; reread before writing.");
      const deleted = operation === "knowledge.document.trash";
      if (operation === "knowledge.document.update") {
        if (before.deleted) throw new CoreError("CONFLICT", "Restore the document before editing.");
        db.prepare("UPDATE documents SET title=?,content=?,revision=revision+1 WHERE id=?").run(String(args.title), String(args.content), before.id);
      } else {
        if (before.deleted === deleted) throw new CoreError("CONFLICT", deleted ? "Already trashed." : "Not trashed.");
        db.prepare("UPDATE documents SET deleted=?,revision=revision+1 WHERE id=?").run(deleted ? 1 : 0, before.id);
      }
    }
    const result = get(args.id);
    db.prepare("UPDATE metadata SET revision=revision+1 WHERE id=1").run();
    db.prepare("INSERT INTO receipts VALUES(?,?,?,?,?,?)").run(String(args.operationId), fingerprint, JSON.stringify(result), actorId, operation, new Date().toISOString());
    db.exec("COMMIT");
    return result;
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}

parentPort!.on("message", ({ id, request }: { id: number; request: StorageRequest }) => {
  try { parentPort!.postMessage({ id, result: execute(request) }); }
  catch (error) {
    const busy = error instanceof Error && /database is locked|database is busy/.test(error.message);
    if (!(error instanceof CoreError) && !busy) console.error("PKM next storage:", error);
    parentPort!.postMessage({ id, error: {
      code: error instanceof CoreError ? error.code : busy ? "BUSY" : "STORAGE_ERROR",
      message: error instanceof Error ? error.message : String(error),
      effect: error instanceof CoreError || busy ? "not-committed" : "unknown",
    } });
  }
});
parentPort!.postMessage({ ready: true });
