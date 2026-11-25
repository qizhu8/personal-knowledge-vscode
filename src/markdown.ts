import { Document } from "yaml";
import { CoreError } from "./host-composition-legacy-batch15-errors.js";
import { checkedDocumentPath, type KnowledgeArea } from "./document-path.js";
import { compileKnowledgeIdentityV1, createKnowledgeId, KNOWLEDGE_SCHEMA_V1, legacyKnowledgeAlias } from "./domain/knowledge-contracts.js";
import { atomicFileWrite } from "./file-write.js";
import type { MarkdownRecord } from "./markdown-read.js";

export {
  decodeMarkdownPath, readKnowledgePathSnapshot, decodeMarkdown, readMarkdown, scanMarkdown, createFreshRootScanner,
  type MarkdownRecord, type MarkdownSnapshotRecord,
} from "./markdown-read.js";
export { sha256 } from "./file-write.js";

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
