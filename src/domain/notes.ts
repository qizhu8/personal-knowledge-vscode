import { readKnowledgeIdentity } from "./knowledge-contracts.js";
import type { NoteRecord } from "../note-contracts.js";

export interface NoteSource {
  rel: string; mtime: number; fm: Record<string, unknown>; body: string;
  board?: { mtimeMs: number; digest: string };
}

function asArray(v: any): string[] {
  return Array.isArray(v) ? v : v ? [String(v)] : [];
}

function relNoExt(rel: string): string { return rel.replace(/\.md$/i, ""); }

function catOf(keyPath: string): string {
  return keyPath.includes("/") ? keyPath.slice(0, keyPath.lastIndexOf("/")) : "";
}

function nameOf(keyPath: string): string {
  return keyPath.includes("/") ? keyPath.slice(keyPath.lastIndexOf("/") + 1) : keyPath;
}

export function projectNote(f: NoteSource, includeContent = true): unknown {
  const { fm, body } = f;
  const key = relNoExt(f.rel);
  const boardStat = f.board;
  const row = {
    slug: key,
    ...readKnowledgeIdentity(fm, "note", key),
    title: fm.title || nameOf(key),
    description: fm.description || "",
    type: fm.type || "general",
    documentKind: boardStat || fm.documentKind === "todo-board" ? "todo-board" : "markdown",
    ...(boardStat ? { boardDigest: boardStat.digest } : {}),
    tags: JSON.stringify(asArray(fm.tags)),
    pinned: fm.pinned === true,
    links: Array.isArray(fm.links) ? fm.links : [],
    category: catOf(key),
    ...(includeContent ? { content: body } : {}),
    created_at: fm.created || new Date(f.mtime).toISOString(),
    updated_at: new Date(Math.max(f.mtime, boardStat?.mtimeMs || 0)).toISOString(),
  };
  return row;
}

export function createNoteQueries<T extends NoteRecord>(notes: T[]) {
  function allNoteFiles() { return notes; }
  function noteFromFile(note: T, includeContent = true) {
    if (includeContent) return note;
    const { content: _content, ...metadata } = note;
    return metadata;
  }

function noteList(type?: string, limit = 50, includeContent = false): any[] {
  let rows = allNoteFiles().map(file => noteFromFile(file, includeContent));
  if (type && type !== "all") rows = rows.filter(r => r.type === type);
  rows.sort((a, b) => (b.updated_at || "").localeCompare(a.updated_at || ""));
  const limited = rows.slice(0, limit);
  return limited;
}

  return { noteList };
}
