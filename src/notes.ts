import { lstatSync, readFileSync } from "node:fs";
import { CoreError, type StorageRequest } from "./contracts.js";
import { checkedResourcePath } from "./document-path.js";
import { createNoteQueries, projectNote } from "./domain/notes.js";
import { readTodoBoard, todoBoardFilename } from "./domain/todo-board.js";
import { sha256 } from "./file-write.js";
import { knowledgeSnapshot } from "./knowledge-snapshot.js";
import type { MarkdownRecord } from "./markdown.js";
import type { DatabaseSync } from "node:sqlite";
import { readLegacyTodoRootProjection, verifyLegacyTodoProjectionReceipt } from "./legacy-todo-root-projection.js";
import { noteRecord } from "./note-contracts.js";
import { checkedBoardPath } from "./boards.js";
import { assertNativeBoardLifecycleFiles, nativeBoardLifecycleCatalog } from "./native-board-lifecycle-state.js";

export function readNotes(root: string, documents: MarkdownRecord[], request: StorageRequest, database?: DatabaseSync) {
  const sources = knowledgeSnapshot(root, documents, "notes", "Note", { maxDocuments: null, maxBytes: null });
  const catalog = nativeBoardLifecycleCatalog(root, database);
  for (const event of catalog.values()) assertNativeBoardLifecycleFiles(root, event, database);
  const planned = database ? readLegacyTodoRootProjection(root) : undefined;
  let projection: typeof planned;
  if (planned && database?.prepare("SELECT 1 FROM sqlite_master WHERE name='legacy_todo_root_projection'").get()) {
    const row = database.prepare("SELECT workspace_id FROM legacy_todo_root_projection").get();
    if (row) {
      verifyLegacyTodoProjectionReceipt(database, root, String(row.workspace_id), planned);
      projection = planned;
    }
  }
  const records = sources.map(source => {
    let board: { mtimeMs: number; digest: string } | undefined;
    try {
      const native = projection?.boards.find(item => item.markdown === `notes/${source.rel}`
        && item.markdownSha256 === source.document.record.sha256);
      const relocated = [...catalog.values()].find(item => item.status === "active" && item.path === source.rel
        && item.noteId === source.document.record.id);
      if (relocated && relocated.documentSha256 !== source.document.record.sha256)
        throw new CoreError("RECOVERY_CONFLICT", "Relocated Board descriptor differs from its durable identity receipt.", "unknown");
      const path = native || relocated ? checkedBoardPath(root, native?.slug ?? relocated!.boardKey, false)
        : checkedResourcePath(root, `${source.rel.replace(/\.md$/i, ".assets")}/${todoBoardFilename}`, false, "notes");
      const stat = lstatSync(path);
      if (!stat.isFile() || stat.isSymbolicLink()) throw new CoreError("INVALID_DOCUMENT", "Note Board backing must be a regular UTF-8 JSON file.");
      const bytes = readFileSync(path), raw = bytes.toString("utf8");
      if (!Buffer.from(raw, "utf8").equals(bytes)) throw new CoreError("INVALID_DOCUMENT", "Note Board backing is invalid UTF-8; bytes were not replaced.");
      try { readTodoBoard(raw); }
      catch (error) { throw new CoreError("INVALID_DOCUMENT", `Invalid Note Board backing: ${error instanceof Error ? error.message : String(error)}`); }
      board = { mtimeMs: stat.mtimeMs, digest: sha256(bytes) };
    } catch (error) {
      if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) {
        if (error instanceof CoreError) throw error;
        throw new CoreError("INVALID_DOCUMENT", error instanceof Error ? error.message : String(error));
      }
    }
    const parsed = noteRecord.safeParse(projectNote({ ...source, board }));
    if (!parsed.success) throw new CoreError("INVALID_DOCUMENT", `Note metadata violates the original read-model types: notes/${source.rel}. Use knowledge.metadata.get to inspect it.`);
    return { ...parsed.data, documentId: source.document.record.id, path: source.rel, documentSha256: source.document.record.sha256 };
  });
  const snapshotRevision = sha256(JSON.stringify(records));
  if (request.args.snapshotRevision !== undefined && request.args.snapshotRevision !== snapshotRevision) {
    throw new CoreError("CONFLICT", "Note snapshot changed; restart related queries/pagination.");
  }
  if (request.operation === "knowledge.note.get") {
    let path = request.args.path;
    if (typeof path === "string") {
      const aliases = [...catalog.values()].filter(item => item.aliases.includes(path as string));
      if (aliases.length > 1) throw new CoreError("CONFLICT", "Note path resolves to multiple retained Board identities.");
      if (aliases[0]) {
        if (aliases[0].status === "trashed") throw new CoreError("NOT_FOUND", "Board Note is in Trash.");
        const collision = records.find(record => record.path === path && record.documentId !== aliases[0]!.noteId);
        if (collision) throw new CoreError("CONFLICT", "Retained Board alias collides with an unexpected Note identity.");
        path = aliases[0].path;
      }
    }
    const found = records.filter(record => path !== undefined ? record.path === path
      : request.args.alias !== undefined ? record.aliases.includes(String(request.args.alias))
        : record.documentId === request.args.id || record.knowledgeId === request.args.id);
    if (!found.length) throw new CoreError("NOT_FOUND", "Note not found in this isolated workspace.");
    if (found.length > 1) throw new CoreError("CONFLICT", "Note identity or alias is ambiguous; use an exact list path.");
    return { item: found[0]!, snapshotRevision };
  }
  if (request.operation !== "knowledge.note.list") throw new CoreError("NOT_FOUND", "Unknown Note query.");
  const queries = createNoteQueries(records);
  const all = queries.noteList(request.args.type === undefined ? undefined : String(request.args.type), records.length, false);
  const offset = Number(request.args.offset), limit = Number(request.args.limit);
  const items = limit === 0 ? all.slice(offset) : all.slice(offset, offset + limit), next = offset + items.length;
  return { items, total: all.length, nextOffset: next < all.length ? next : null, snapshotRevision };
}
