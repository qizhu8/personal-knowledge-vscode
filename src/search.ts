import { lstatSync, readFileSync } from "node:fs";
import { CoreError, type StorageRequest } from "./contracts.js";
import { checkedResourcePath } from "./document-path.js";
import { noteSearchValues, paperSearchValues, literalSearchMatches, skillSearchValues } from "./domain/search.js";
import { createPaperQueries, projectPaper } from "./domain/research.js";
import { projectNote } from "./domain/notes.js";
import { projectSkill } from "./domain/skills.js";
import { sha256 } from "./file-write.js";
import { knowledgeSnapshot } from "./knowledge-snapshot.js";
import type { MarkdownRecord } from "./markdown.js";
import { noteRecord } from "./note-contracts.js";
import { paperRecord } from "./research-contracts.js";
import { searchDefinitions } from "./search-contracts.js";
import { skillRecord } from "./skill-contracts.js";
import { readTodoBoard, todoBoardFilename } from "./domain/todo-board.js";

type SearchKind = "note" | "skill" | "research";

function parsedRequest(request: StorageRequest) {
  const definition = searchDefinitions.find(item => item.id === request.operation);
  if (!definition) throw new CoreError("NOT_FOUND", "Unknown knowledge search.");
  const parsed = definition.input.safeParse(request.args);
  if (!parsed.success) {
    throw new CoreError("INVALID_ARGUMENT", parsed.error.issues.map(issue => `${issue.path.join(".")}: ${issue.message}`).join("; "));
  }
  return parsed.data;
}

function noteSnapshot(root: string, documents: MarkdownRecord[]) {
  const sources = knowledgeSnapshot(root, documents, "notes", "Note", { maxDocuments: null, maxBytes: null });
  const records = sources.map(source => {
    let board: { mtimeMs: number; digest: string } | undefined;
    try {
      const path = checkedResourcePath(root, `${source.rel.replace(/\.md$/i, ".assets")}/${todoBoardFilename}`, false, "notes");
      const stat = lstatSync(path);
      if (!stat.isFile() || stat.isSymbolicLink()) {
        throw new CoreError("INVALID_DOCUMENT", "Note Board backing must be a regular UTF-8 JSON file.");
      }
      const bytes = readFileSync(path), raw = bytes.toString("utf8");
      if (!Buffer.from(raw, "utf8").equals(bytes)) {
        throw new CoreError("INVALID_DOCUMENT", "Note Board backing is invalid UTF-8; bytes were not replaced.");
      }
      try { readTodoBoard(raw); }
      catch (error) {
        throw new CoreError("INVALID_DOCUMENT", `Invalid Note Board backing: ${error instanceof Error ? error.message : String(error)}`);
      }
      board = { mtimeMs: stat.mtimeMs, digest: sha256(bytes) };
    } catch (error) {
      if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) {
        if (error instanceof CoreError) throw error;
        throw new CoreError("INVALID_DOCUMENT", error instanceof Error ? error.message : String(error));
      }
    }
    const parsed = noteRecord.safeParse(projectNote({ ...source, board }));
    if (!parsed.success) throw new CoreError("INVALID_DOCUMENT", `Note metadata violates the original read-model types: notes/${source.rel}. Use knowledge.metadata.get to inspect it.`);
    return {
      ...parsed.data,
      documentId: source.document.record.id,
      path: source.rel,
      documentSha256: source.document.record.sha256,
    };
  });
  return { sources, records, revision: sha256(JSON.stringify(records)) };
}

function skillSnapshot(root: string, documents: MarkdownRecord[]) {
  const sources = knowledgeSnapshot(root, documents, "skills", "Skill");
  const records = sources.map(source => {
    const parsed = skillRecord.safeParse(projectSkill(source));
    if (!parsed.success) throw new CoreError("INVALID_DOCUMENT", `Skill metadata violates the original read-model types: skills/${source.rel}. Use knowledge.metadata.get to inspect it.`);
    return {
      ...parsed.data,
      documentId: source.document.record.id,
      path: source.rel,
      documentSha256: source.document.record.sha256,
    };
  });
  return { sources, records, revision: sha256(JSON.stringify(records)) };
}

function researchSnapshot(root: string, documents: MarkdownRecord[]) {
  const sources = knowledgeSnapshot(root, documents, "papers", "Research");
  const records = sources.map(source => {
    const parsed = paperRecord.safeParse(projectPaper(source));
    if (!parsed.success) throw new CoreError("INVALID_DOCUMENT", `Research metadata violates the original read-model types: papers/${source.rel}. Use knowledge.metadata.get to inspect it.`);
    return {
      ...parsed.data,
      documentId: source.document.record.id,
      path: source.rel,
      documentSha256: source.document.record.sha256,
    };
  });
  const legacyView = records.map(({ documentId: _documentId, path: _path, documentSha256: _documentSha256, ...paper }) => paper);
  return { sources, records, revision: sha256(JSON.stringify(legacyView)) };
}

function page<T>(items: T[], offset: number, limit: number) {
  const result = items.slice(offset, offset + limit);
  const next = offset + result.length;
  return { items: result, total: items.length, nextOffset: next < items.length ? next : null };
}

function matches(options: { query: string; caseSensitive: boolean }, values: unknown[]) {
  return literalSearchMatches(options, values);
}

export function readKnowledgeSearch(root: string, documents: MarkdownRecord[], request: StorageRequest): unknown {
  const args = parsedRequest(request);
  const kind: SearchKind = request.operation === "knowledge.note.search" ? "note"
    : request.operation === "knowledge.skill.search" ? "skill" : "research";
  const offset = args.offset, limit = args.limit;

  if (kind === "note") {
    const { sources, records, revision } = noteSnapshot(root, documents);
    if ("snapshotRevision" in args && args.snapshotRevision !== undefined && args.snapshotRevision !== revision) {
      throw new CoreError("CONFLICT", "Note search snapshot changed; restart related queries/pagination.");
    }
    const all = records.map((record, index) => ({ record, source: sources[index]! }))
      .filter(({ record, source }) => matches(args, noteSearchValues(record, source.rel)))
      .sort((left, right) => (right.record.updated_at || "").localeCompare(left.record.updated_at || ""));
    const result = page(all, offset, limit);
    const items = result.items.map(({ record }) => {
      const { content: _content, ...metadata } = record;
      return metadata;
    });
    return searchDefinitions[0].output.parse({ ...result, items, snapshotRevision: revision });
  }

  if (kind === "skill") {
    const { records, revision } = skillSnapshot(root, documents);
    if ("snapshotRevision" in args && args.snapshotRevision !== undefined && args.snapshotRevision !== revision) {
      throw new CoreError("CONFLICT", "Skill search snapshot changed; restart related queries/pagination.");
    }
    const all = records.filter(record => matches(args, skillSearchValues(record))).map(({ content: _content, _key: _key, ...record }) => record);
    return searchDefinitions[1].output.parse({ ...page(all, offset, limit), snapshotRevision: revision });
  }

  const { sources, records, revision } = researchSnapshot(root, documents);
  if ("revision" in args && args.revision !== undefined && args.revision !== revision) {
    throw new CoreError("CONFLICT", "Research search snapshot changed; restart related queries/pagination.");
  }
  const bySlug = new Map(records.map(record => [record.slug, record]));
  const sourceBySlug = new Map(records.map((record, index) => [record.slug, sources[index]!]));
  const ordered = createPaperQueries(records).paperList();
  const all = ordered.filter(item => {
    const paper = bySlug.get(item.slug);
    return paper !== undefined && matches(args, paperSearchValues(paper));
  }).map(item => {
    const paper = bySlug.get(item.slug)!;
    const source = sourceBySlug.get(item.slug)!;
    const { content: _content, ...metadata } = paper;
    return {
      ...metadata,
      citationCount: item.citationCount,
      documentId: source.document.record.id,
      path: source.rel,
      documentSha256: source.document.record.sha256,
    };
  });
  return searchDefinitions[2].output.parse({ ...page(all, offset, limit), revision });
}
