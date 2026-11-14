import { lstatSync, readFileSync, readdirSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import { performance } from "node:perf_hooks";
import { Document, parseDocument, isMap } from "yaml";
import { CoreError, documentId, documentSchema, type DocumentRecord } from "./contracts.js";
import { checkedDocumentPath, documentPath, knowledgeArea, type KnowledgeArea } from "./document-path.js";
import { compileKnowledgeIdentityV1, createKnowledgeId, KNOWLEDGE_SCHEMA_V1, legacyKnowledgeAlias } from "./domain/knowledge-contracts.js";
import { atomicFileWrite, sha256 } from "./file-write.js";

export { sha256 } from "./file-write.js";
export interface MarkdownRecord { record: DocumentRecord & { path: string; area: KnowledgeArea }; raw: string; metadata: Document }
type CachedMarkdownRecord = {
  fingerprint: string;
  id: string;
  contentStart: number;
  record: Omit<MarkdownRecord["record"], "content">;
  metadata: Document;
};
const markdownScanCaches = new Map<string, Map<string, CachedMarkdownRecord>>();
const slowScanWarningMs = 2_000;
const slowScanWarningIntervalMs = 60_000;
let lastSlowScanWarningAt = 0;
function readRawMarkdown(path: string) {
  const bytes = readFileSync(path), raw = bytes.toString("utf8");
  if (!Buffer.from(raw, "utf8").equals(bytes)) throw new CoreError("INVALID_DOCUMENT", "Markdown must be valid UTF-8; invalid bytes were not replaced.");
  return raw;
}
function parseMetadata(raw: string, label: string) {
  const match = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(raw);
  if (!match && /^---(?:\r?\n|$)/.test(raw)) throw new CoreError("INVALID_DOCUMENT", `Document ${label} has unclosed YAML frontmatter.`);
  const metadata = match ? parseDocument(match[1], { uniqueKeys: true }) : new Document({});
  if (metadata.errors.length || !isMap(metadata.contents)) throw new CoreError("INVALID_DOCUMENT", `Document ${label} has invalid YAML frontmatter.`);
  let values: unknown;
  try { values = metadata.toJS({ maxAliasCount: 0 }); }
  catch { throw new CoreError("INVALID_DOCUMENT", `Document ${label} has unsupported YAML aliases.`); }
  if (!values || typeof values !== "object" || Array.isArray(values)) throw new CoreError("INVALID_DOCUMENT", `Document ${label} metadata must be an object.`);
  return { metadata, content: raw.slice(match?.[0].length ?? 0), contentStart: match?.[0].length ?? 0 };
}
function decodeMarkdownParts(id: string, raw: string, path: string, area: KnowledgeArea, metadata: Document, content: string, digest = sha256(raw)): MarkdownRecord {
  const parsed = documentSchema.safeParse({
    id, path, area, title: metadata.has("title") ? metadata.get("title") : basename(path).replace(/\.md$/i, ""),
    revision: metadata.has("revision") ? metadata.get("revision") : 1,
    deleted: metadata.has("deleted") ? metadata.get("deleted") : false,
    content, sha256: digest,
  });
  if (!parsed.success) throw new CoreError("INVALID_DOCUMENT", `Document ${path} metadata/content violates the document contract.`);
  return { record: { ...parsed.data, path, area }, raw, metadata };
}
export function decodeMarkdown(id: string, raw: string, path = `${id}.md`, area: KnowledgeArea = "notes"): MarkdownRecord {
  const parsed = parseMetadata(raw, path);
  return decodeMarkdownParts(id, raw, path, area, parsed.metadata, parsed.content);
}
export function readMarkdown(root: string, id: string, relative = `${id}.md`, area: KnowledgeArea = "notes"): MarkdownRecord | undefined {
  let path: string;
  try { path = checkedDocumentPath(root, relative, false, area); }
  catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return undefined;
    throw new CoreError("INVALID_DOCUMENT", error instanceof Error ? error.message : String(error));
  }
  let stat;
  try { stat = lstatSync(path); }
  catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return undefined;
    throw error;
  }
  if (!stat.isFile() || stat.isSymbolicLink()) throw new CoreError("INVALID_DOCUMENT", `Document ${relative} must be a regular Markdown file.`);
  return decodeMarkdown(id, readRawMarkdown(path), relative, area);
}
export function scanMarkdown(root: string): MarkdownRecord[] {
  const startedAt = performance.now();
  const result: MarkdownRecord[] = [];
  const ids = new Set<string>();
  const knowledgeIds = new Set<string>();
  const rootPath = resolve(root);
  let cache = markdownScanCaches.get(rootPath);
  if (!cache) {
    if (markdownScanCaches.size >= 16) {
      const oldest = markdownScanCaches.keys().next().value;
      if (oldest) markdownScanCaches.delete(oldest);
    }
    cache = new Map();
  }
  markdownScanCaches.delete(rootPath);
  markdownScanCaches.set(rootPath, cache);
  const seen = new Set<string>();
  function walk(directory: string, prefix: string, depth: number, area: KnowledgeArea) {
    if (depth > 32) throw new CoreError("INVALID_WORKSPACE", "Markdown nesting exceeds 32 levels.");
    const stat = lstatSync(directory);
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new CoreError("INVALID_WORKSPACE", "Notes directories must be real directories, not links.");
    const names = readdirSync(directory).sort();
    for (const name of names) {
      const path = join(directory, name), relative = prefix ? `${prefix}/${name}` : name;
      const entry = lstatSync(path, { bigint: true });
      if (entry.isSymbolicLink()) throw new CoreError("INVALID_DOCUMENT", `Notes symlinks are not supported: ${relative}`);
      if (name === ".gitkeep" && entry.isFile()) continue;
      if (area === "notes" && !prefix && name === ".pk-meta.json") {
        if (!entry.isFile()) throw new CoreError("INVALID_DOCUMENT", "The reserved Note folder-pin sidecar must be a regular file.");
        continue;
      }
      if (/^\.pkm-write-[a-fA-F0-9-]+$/.test(name) && entry.isFile()) continue;
      if (entry.isDirectory()) {
        if (name === ".trash" || name === "_assets") continue;
        if (/\.assets$/i.test(name)) {
          const owners = names.filter(candidate => /\.md$/i.test(candidate) && candidate.replace(/\.md$/i, "") === name.replace(/\.assets$/i, ""));
          if (owners.length !== 1 || !lstatSync(join(directory, owners[0]!)).isFile()) throw new CoreError("INVALID_DOCUMENT", `Unowned or ambiguous Markdown resource directory: ${relative}`);
          continue;
        }
        if (!documentPath.safeParse(`${relative}/placeholder.md`).success) throw new CoreError("INVALID_DOCUMENT", `Unsafe Notes folder: ${relative}`);
        walk(path, relative, depth + 1, area);
        continue;
      }
      if (!entry.isFile() || !documentPath.safeParse(relative).success) throw new CoreError("INVALID_DOCUMENT", `Unsupported notes entry: ${relative}`);
      seen.add(path);
      const fingerprint = `${entry.dev}:${entry.ino}:${entry.size}:${entry.mtimeNs}:${entry.ctimeNs}`;
      const cached = cache!.get(path);
      if (cached?.fingerprint === fingerprint) {
        const knowledgeId = cached.metadata.get("knowledgeId");
        if (ids.has(cached.id)) throw new CoreError("CONFLICT", `Duplicate document identity: ${cached.id}`);
        ids.add(cached.id);
        if (typeof knowledgeId === "string") {
          if (knowledgeIds.has(knowledgeId)) throw new CoreError("CONFLICT", `Duplicate knowledgeId: ${knowledgeId}`);
          knowledgeIds.add(knowledgeId);
        }
        const raw = readRawMarkdown(path);
        const document = {
          record: { ...cached.record, content: raw.slice(cached.contentStart) },
          raw,
          metadata: cached.metadata.clone(),
        };
        result.push(document);
        continue;
      }
      const raw = readRawMarkdown(path);
      const { metadata, content, contentStart } = parseMetadata(raw, relative);
      const values: unknown = metadata.toJS({ maxAliasCount: 0 });
      const aliases = values && typeof values === "object" && "aliases" in values ? values.aliases : undefined;
      const prototypeIds = metadata.get("schema") === "pkm.knowledge/v1" && metadata.has("revision") && metadata.has("deleted") && Array.isArray(aliases) ? [...new Set(aliases.filter((alias): alias is string =>
        typeof alias === "string" && alias.startsWith("note:") && documentId.safeParse(alias.slice(5)).success).map(alias => alias.slice(5)))] : [];
      const identity = metadata.has("documentId") ? metadata.get("documentId")
        : prototypeIds.length === 1 ? prototypeIds[0] : metadata.get("knowledgeId");
      const filename = basename(name).replace(/\.md$/i, "");
      const id = identity === undefined ? (area === "notes" && documentId.safeParse(filename).success && !prefix ? filename : `legacy_${sha256(area === "notes" ? relative : `${area}/${relative}`).slice(0, 32)}`) : identity;
      if (!documentId.safeParse(id).success) throw new CoreError("INVALID_DOCUMENT", `Invalid stable identity in ${relative}.`);
      if (typeof id !== "string") throw new CoreError("INVALID_DOCUMENT", `Document identity must be a string: ${relative}`);
      const knowledgeId = metadata.get("knowledgeId");
      if (typeof knowledgeId === "string") {
        if (knowledgeIds.has(knowledgeId)) throw new CoreError("CONFLICT", `Duplicate knowledgeId: ${knowledgeId}`);
        knowledgeIds.add(knowledgeId);
      }
      if (ids.has(id)) throw new CoreError("CONFLICT", `Duplicate document identity: ${id}`);
      ids.add(id);
      const document = decodeMarkdownParts(id, raw, relative, area, metadata, content);
      const { content: _content, ...record } = document.record;
      cache!.set(path, { fingerprint, id, contentStart, record, metadata: metadata.clone() });
      result.push(document);
    }
  }
  for (const area of knowledgeArea.options) {
    const directory = join(root, area);
    try { lstatSync(directory); }
    catch (error) {
      if (area !== "notes" && error instanceof Error && "code" in error && error.code === "ENOENT") continue;
      throw error;
    }
    walk(directory, "", 0, area);
  }
  const addresses = new Map<string, string>();
  for (const { record, metadata } of result) {
    const identity = metadata.get("knowledgeId");
    for (const key of [record.id, ...(typeof identity === "string" ? [identity] : [])]) {
      const address = `${record.area}/${record.path}`;
      if (addresses.has(key) && addresses.get(key) !== address) throw new CoreError("CONFLICT", `Ambiguous document/knowledge identity: ${key}`);
      addresses.set(key, address);
    }
  }
  for (const path of cache!.keys()) if (!seen.has(path)) cache!.delete(path);
  const documents = result.sort((left, right) => left.record.id < right.record.id ? -1 : left.record.id > right.record.id ? 1 : 0);
  const durationMs = performance.now() - startedAt;
  if (durationMs >= slowScanWarningMs && Date.now() - lastSlowScanWarningAt >= slowScanWarningIntervalMs) {
    lastSlowScanWarningAt = Date.now();
    console.warn("PKM next slow Markdown scan:", JSON.stringify({ durationMs: Math.round(durationMs), documents: documents.length }));
  }
  return documents;
}
export function encodeMarkdown(id: string, title: string, content: string, revision: number, deleted: boolean, previous?: MarkdownRecord, path = `${id}.md`, area: KnowledgeArea = "notes"): string {
  const kind = area === "skills" ? "skill" : area === "papers" ? "research" : "note";
  const metadata = previous?.metadata.clone() ?? new Document({
    schema: "pkm.knowledge/v1",
    knowledgeId: createKnowledgeId(),
    aliases: [`${kind}:${id}`],
  });
  if (!metadata.has("knowledgeId")) {
    metadata.set("knowledgeId", createKnowledgeId());
    if (!metadata.has("schema")) metadata.set("schema", "pkm.knowledge/v1");
  }
  const values: unknown = metadata.toJS({ maxAliasCount: 0 });
  const aliases = values && typeof values === "object" && "aliases" in values ? values.aliases : undefined;
  if (aliases !== undefined && (!Array.isArray(aliases) || aliases.some(alias => typeof alias !== "string"))) throw new CoreError("INVALID_DOCUMENT", "Knowledge aliases must be a string array; no metadata was replaced.");
  const nextAliases = [...new Set([...(Array.isArray(aliases) ? aliases : []), legacyKnowledgeAlias(kind, id), legacyKnowledgeAlias(kind, path)])].sort();
  const identity = compileKnowledgeIdentityV1({ schema: KNOWLEDGE_SCHEMA_V1, knowledgeId: metadata.get("knowledgeId"), revision, aliases: nextAliases });
  if (!identity.ok) throw new CoreError("INVALID_DOCUMENT", `Existing Knowledge identity must be repaired, not replaced: ${identity.diagnostics.map(item => `${item.pointer} ${item.message}`).join("; ")}`);
  metadata.set("aliases", nextAliases);
  metadata.set("documentId", id);
  metadata.set("title", title);
  metadata.set("revision", revision);
  metadata.set("deleted", deleted);
  return `---\n${metadata.toString()}---\n${content}`;
}
export function atomicMarkdownWrite(root: string, id: string, raw: string, expected: string | null, relative = `${id}.md`, area: KnowledgeArea = "notes", operationId?: string) {
  let destination: string;
  try { destination = checkedDocumentPath(root, relative, true, area); }
  catch (error) { throw new CoreError("INVALID_DOCUMENT", error instanceof Error ? error.message : String(error)); }
  atomicFileWrite(destination, raw, expected, operationId);
}
