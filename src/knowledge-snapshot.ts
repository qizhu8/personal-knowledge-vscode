import { lstatSync } from "node:fs";
import { CoreError } from "./contracts.js";
import { checkedDocumentPath, type KnowledgeArea } from "./document-path.js";
import type { MarkdownRecord } from "./markdown.js";
import { readKnowledgeMetadata } from "./metadata.js";

export interface KnowledgeSnapshotLimits {
  maxDocuments?: number | null;
  maxBytes?: number | null;
}

export function knowledgeSnapshot(root: string, documents: MarkdownRecord[], area: KnowledgeArea, label: string, limits: KnowledgeSnapshotLimits = {}) {
  const sources = documents.filter(item => item.record.area === area && !item.record.deleted);
  const maxDocuments = limits.maxDocuments === undefined ? 4096 : limits.maxDocuments;
  const maxBytes = limits.maxBytes === undefined ? 33_554_432 : limits.maxBytes;
  if (maxDocuments !== null && sources.length > maxDocuments || maxBytes !== null
    && sources.reduce((sum, item) => sum + Buffer.byteLength(item.raw, "utf8"), 0) > maxBytes) {
    throw new CoreError("BUSY", `${label} snapshot exceeds its document or byte limit; no partial query was returned.`);
  }
  // Legacy stable-sort/resolver ties follow depth-first paths, not Knowledge IDs.
  sources.sort((left, right) => {
    const a = left.record.path.split("/"), b = right.record.path.split("/");
    for (let index = 0; index < Math.min(a.length, b.length); index++) {
      const compared = Buffer.compare(Buffer.from(a[index]!), Buffer.from(b[index]!));
      if (compared) return compared;
    }
    return a.length - b.length;
  });
  return sources.map(document => {
    const stat = lstatSync(checkedDocumentPath(root, document.record.path, false, area));
    if (!stat.isFile() || stat.isSymbolicLink()) throw new CoreError("INVALID_DOCUMENT", `${label} source is no longer a regular Markdown file.`);
    return {
      document, rel: document.record.path, mtime: stat.mtimeMs,
      fm: readKnowledgeMetadata(document).metadata, body: document.record.content,
    };
  });
}
