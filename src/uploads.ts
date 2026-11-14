import { randomUUID } from "node:crypto";
import { lstatSync, readFileSync } from "node:fs";
import { basename, join } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { CoreError, uploadStatus, type StorageRequest } from "./contracts.js";
import { checkedResourcePath, knowledgeArea, resourcePath } from "./document-path.js";
import { encodeSegment, markdownAssetDirectory } from "./domain/markdown-assets.js";
import { atomicFileWrite, sha256 } from "./file-write.js";
import { readMarkdown, type MarkdownRecord } from "./markdown.js";
import { assetImportOperation, isAssetImportJournal, planAssetImport, recoverAssetImport } from "./asset-import.js";

type Row = Record<string, unknown>;
const fileLimit = 16_777_216;

export function createUploads(db: DatabaseSync, root: string) {
  function validState(value: unknown) {
    const parsed = uploadStatus.safeParse(value);
    if (!parsed.success) throw new CoreError("INVALID_WORKSPACE", "Upload state violates its durable contract; preserve the database for reconciliation.");
    return parsed.data;
  }
  function snapshot(row: Row) {
    const value: unknown = row.result === null ? {
      uploadId: row.upload_id, documentId: row.document_id, area: row.area, path: row.document_path,
      name: row.name, size: Number(row.size), digest: row.digest,
      receivedBytes: Number(row.received_bytes), status: row.status,
    } : JSON.parse(String(row.result));
    return validState(value);
  }
  function owned(id: string, actor: string) {
    const row = db.prepare("SELECT * FROM uploads WHERE upload_id=?").get(id);
    if (!row) throw new CoreError("NOT_FOUND", "Upload not found.");
    if (row.actor_id !== actor) throw new CoreError("ACCESS_DENIED", "Upload belongs to a different actor.");
    return row;
  }
  function resourceBytes(path: string) {
    let stat;
    try { stat = lstatSync(path); }
    catch (error) {
      if (error instanceof Error && "code" in error && error.code === "ENOENT") return undefined;
      throw error;
    }
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > fileLimit) throw new CoreError("INVALID_DOCUMENT", "Resource destination must be a regular file under 16 MiB.");
    const bytes = readFileSync(path);
    if (bytes.length > fileLimit) throw new CoreError("CONFLICT", "Resource grew beyond the upload limit.");
    return bytes;
  }
  function destination(row: Row, create: boolean) {
    const parsed = knowledgeArea.safeParse(row.area);
    if (!parsed.success) throw new CoreError("INVALID_WORKSPACE", "Upload contains an invalid storage area.");
    const path = `${markdownAssetDirectory(String(row.document_path))}/${String(row.name)}`;
    let full: string;
    try { full = checkedResourcePath(root, path, create, parsed.data); }
    catch (error) {
      if (!create && error instanceof Error && "code" in error && error.code === "ENOENT") full = join(root, parsed.data, path);
      else throw new CoreError("INVALID_DOCUMENT", error instanceof Error ? error.message : String(error));
    }
    return { area: parsed.data, path, full };
  }
  function resourceResult(row: Row) {
    return validState({
      ...snapshot(row), status: "committed",
      resource: {
        area: String(row.area), path: `${markdownAssetDirectory(String(row.document_path))}/${String(row.name)}`,
        digest: String(row.digest), size: Number(row.size),
        uri: `${encodeSegment(basename(markdownAssetDirectory(String(row.document_path))))}/${encodeSegment(String(row.name))}`,
      },
    });
  }
  function finish(row: Row, result: unknown) {
    db.prepare("DELETE FROM upload_chunks WHERE upload_id=?").run(String(row.upload_id));
    db.prepare("UPDATE uploads SET status='committed',result=? WHERE upload_id=?").run(JSON.stringify(result), String(row.upload_id));
  }
  function pinned(row: Row, document: MarkdownRecord | undefined) {
    if (!document || document.record.deleted || document.record.sha256 !== row.document_sha256
      || document.record.revision !== Number(row.document_revision) || document.record.path !== row.document_path
      || document.record.area !== row.area) throw new CoreError("CONFLICT", "Upload document changed/moved/deleted; abort and begin again after rereading it.");
  }
  function plan(request: StorageRequest, documents: () => MarkdownRecord[]): { result: unknown } | { pending: true } {
    const { operation, args, actorId } = request;
    if (operation === assetImportOperation) return planAssetImport(db, root, request);
    if (operation === "knowledge.upload.list") {
      const rows = db.prepare("SELECT * FROM uploads WHERE actor_id=? AND status='active' ORDER BY upload_id LIMIT 5").all(actorId);
      if (rows.length > 4) throw new CoreError("INVALID_WORKSPACE", "Actor upload reservations exceed their durable limit.");
      return { result: { items: rows.map(snapshot), total: rows.length } };
    }
    if (operation === "knowledge.upload.begin") {
      const document = documents().find(item => item.record.id === args.id || item.metadata.get("knowledgeId") === args.id);
      if (!document) throw new CoreError("NOT_FOUND", "Upload document not found.");
      const before = document.record;
      if (before.deleted || before.revision !== args.expectedRevision || before.sha256 !== args.expectedSha256) throw new CoreError("CONFLICT", "Upload document changed; reread before beginning.");
      if (before.path.split("/")[0]!.toLowerCase() === "system") throw new CoreError("ACCESS_DENIED", "System resources are read-only.");
      if (String(args.name).toLowerCase() === "pkm-todo-board.json") throw new CoreError("ACCESS_DENIED", "Todo backing data requires Board commands.");
      if (!resourcePath.safeParse(`${markdownAssetDirectory(before.path)}/${String(args.name)}`).success) throw new CoreError("INVALID_ARGUMENT", "Combined document/resource path exceeds the portable resource contract.");
      const active = db.prepare("SELECT actor_id,size FROM uploads WHERE status='active'").all();
      if (active.length >= 8 || active.filter(row => row.actor_id === actorId).length >= 4
        || active.reduce((sum, row) => sum + Number(row.size), 0) + Number(args.size) > 67_108_864) throw new CoreError("BUSY", "Active upload reservation limit reached; use knowledge.upload.list, then finish or abort an existing upload.");
      const uploadId = randomUUID();
      db.prepare("INSERT INTO uploads VALUES(?,?,?,?,?,?,?,?,?,?,0,'active',NULL)").run(
        uploadId, actorId, before.id, before.area, before.path, before.revision, before.sha256,
        String(args.name), Number(args.size), String(args.digest),
      );
      return { result: snapshot(owned(uploadId, actorId)) };
    }
    const row = owned(String(args.uploadId), actorId);
    if (operation === "knowledge.upload.get") return { result: snapshot(row) };
    if (row.status !== "active") throw new CoreError("CONFLICT", "Upload is no longer active; retry only the original operationId for an uncertain previous result.");
    if (operation === "knowledge.upload.abort") {
      db.prepare("DELETE FROM upload_chunks WHERE upload_id=?").run(String(row.upload_id));
      db.prepare("UPDATE uploads SET status='aborted' WHERE upload_id=?").run(String(row.upload_id));
      return { result: snapshot(owned(String(row.upload_id), actorId)) };
    }
    if (operation === "knowledge.upload.append") {
      const content = Buffer.from(String(args.data), "base64");
      if (!content.length || content.length > 65_536 || content.toString("base64") !== args.data) throw new CoreError("INVALID_ARGUMENT", "Chunk must be canonical base64 encoding 1..65536 bytes.");
      if (Number(row.received_bytes) !== args.offset || Number(row.received_bytes) + content.length > Number(row.size)) throw new CoreError("CONFLICT", "Chunk offset/length does not match the reserved upload; read progress and retry the original request.");
      db.prepare("INSERT INTO upload_chunks VALUES(?,?,?)").run(String(row.upload_id), Number(args.offset), content);
      db.prepare("UPDATE uploads SET received_bytes=received_bytes+? WHERE upload_id=?").run(content.length, String(row.upload_id));
      return { result: snapshot(owned(String(row.upload_id), actorId)) };
    }
    if (operation !== "knowledge.upload.commit") throw new CoreError("NOT_FOUND", "Unknown upload operation.");
    pinned(row, documents().find(item => item.record.id === row.document_id));
    if (Number(row.received_bytes) !== Number(row.size)) throw new CoreError("CONFLICT", "Upload is incomplete.");
    const parts = db.prepare("SELECT content FROM upload_chunks WHERE upload_id=? ORDER BY offset").all(String(row.upload_id)).map(part => {
      if (!(part.content instanceof Uint8Array)) throw new CoreError("INVALID_WORKSPACE", "Upload chunk is not binary.");
      return part.content;
    });
    const content = Buffer.concat(parts);
    if (content.length !== Number(row.size) || `sha256:${sha256(content)}` !== row.digest) throw new CoreError("CONFLICT", "Upload checksum does not match its reserved digest; abort and restart with the correct bytes.");
    const target = destination(row, false);
    const existing = resourceBytes(target.full);
    const result = resourceResult(row);
    if (existing) {
      if (`sha256:${sha256(existing)}` !== row.digest) throw new CoreError("CONFLICT", "Upload would overwrite a different resource; existing bytes were preserved.");
      finish(row, result);
      return { result };
    }
    db.prepare("INSERT INTO pending_asset VALUES(1,?,?,?,?,?,?,?)").run(
      String(args.operationId), sha256(JSON.stringify({ operation, actorId, args })), actorId, operation,
      String(row.upload_id), content, JSON.stringify(result),
    );
    return { pending: true };
  }
  function recover() {
    const pending = db.prepare("SELECT * FROM pending_asset WHERE singleton=1").get();
    if (!pending) return;
    if (isAssetImportJournal(pending)) { recoverAssetImport(db, root, pending); return; }
    const row = owned(String(pending.upload_id), String(pending.actor_id));
    const result = validState(JSON.parse(String(pending.result)));
    if (JSON.stringify(result) !== JSON.stringify(resourceResult(row))) throw new CoreError("INVALID_WORKSPACE", "Pending resource result does not match the owned upload.");
    const area = knowledgeArea.safeParse(row.area);
    if (!area.success || !(pending.content instanceof Uint8Array)) throw new CoreError("INVALID_WORKSPACE", "Pending resource state is invalid.");
    pinned(row, readMarkdown(root, String(row.document_id), String(row.document_path), area.data));
    if (pending.content.length !== Number(row.size) || `sha256:${sha256(pending.content)}` !== row.digest) throw new CoreError("INVALID_WORKSPACE", "Pending resource checksum is invalid; preserve the journal.");
    const target = destination(row, true), existing = resourceBytes(target.full);
    if (!existing || `sha256:${sha256(existing)}` !== row.digest) atomicFileWrite(target.full, pending.content, null, String(pending.operation_id));
    db.prepare("INSERT INTO receipts VALUES(?,?,?,?,?,?)").run(
      String(pending.operation_id), String(pending.fingerprint), String(pending.result),
      String(pending.actor_id), String(pending.operation), new Date().toISOString(),
    );
    finish(row, result);
    db.prepare("DELETE FROM pending_asset WHERE singleton=1").run();
  }
  return { plan, recover };
}
