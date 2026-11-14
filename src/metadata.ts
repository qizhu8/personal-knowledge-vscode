import { lstatSync } from "node:fs";
import { join } from "node:path";
import { CoreError, metadataSchema } from "./contracts.js";
import { compileKnowledgeIdentityV1, compileKnowledgeLinksV1, type KnowledgeDiagnostic } from "./domain/knowledge-contracts.js";
import type { MarkdownRecord } from "./markdown.js";

const protectedFields = new Set([
  "schema", "knowledgeId", "documentId", "revision", "deleted", "aliases",
  "title", "documentKind", "workItems", "workitems", "work_items", "memory",
]);

export function readKnowledgeMetadata(before: MarkdownRecord) {
  const parsed = metadataSchema.safeParse(before.metadata.toJS({ maxAliasCount: 0 }));
  if (!parsed.success) throw new CoreError("INVALID_DOCUMENT", "This document contains YAML values not representable by the JSON metadata contract.");
  const metadata = parsed.data;
  const identity = compileKnowledgeIdentityV1({
    schema: metadata.schema, knowledgeId: metadata.knowledgeId,
    revision: metadata.revision, aliases: metadata.aliases,
  });
  const diagnostics: KnowledgeDiagnostic[] = identity.ok ? [] : [...identity.diagnostics];
  if (Object.hasOwn(metadata, "links")) {
    const links = compileKnowledgeLinksV1(metadata.links);
    if (!links.ok) diagnostics.push(...links.diagnostics.map(item => ({ ...item, pointer: `/links${item.pointer}` })));
  }
  const { content: _content, ...record } = before.record;
  return { ...record, metadata, diagnostics };
}

export function assertEditableDocument(root: string, before: MarkdownRecord) {
  if (before.metadata.getIn(["memory", "schema"]) === "pkm.explicit-memory/v1") {
    throw new CoreError("ACCESS_DENIED", "Explicit-memory authority requires sourced lifecycle operations and native human decisions, not generic Markdown mutations.");
  }
  let board = before.metadata.get("documentKind") === "todo-board";
  const backing = join(root, before.record.area, before.record.path.replace(/\.md$/i, ".assets"), "pkm-todo-board.json");
  try { lstatSync(backing); board = true; }
  catch (error) {
    if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
  }
  if (board) throw new CoreError("ACCESS_DENIED", "Todo Board descriptors/backing data require lifecycle commands; generic Markdown mutations cannot change them.");
}

export function patchKnowledgeMetadata(before: MarkdownRecord, values: unknown, remove: unknown): MarkdownRecord {
  const parsed = metadataSchema.safeParse(values);
  if (!parsed.success || !Array.isArray(remove) || remove.some(key => typeof key !== "string")) throw new CoreError("INVALID_ARGUMENT", "Expected JSON metadata fields and a string-array remove list.");
  const removals = remove.filter((key): key is string => typeof key === "string");
  const keys = [...Object.keys(parsed.data), ...removals];
  const protectedKey = keys.find(key => protectedFields.has(key));
  if (protectedKey) throw new CoreError("ACCESS_DENIED", `Metadata ${protectedKey} is maintained by document/identity/Todo lifecycle operations.`);
  const overlap = removals.find(key => Object.hasOwn(parsed.data, key));
  if (overlap) throw new CoreError("INVALID_ARGUMENT", `Cannot both set and remove metadata ${overlap}.`);
  if (Object.hasOwn(parsed.data, "links")) {
    const links = compileKnowledgeLinksV1(parsed.data.links);
    if (!links.ok) throw new CoreError("INVALID_ARGUMENT", `Invalid Knowledge links: ${links.diagnostics.map(item => `${item.pointer} ${item.message}`).join("; ")}`);
  }
  const metadata = before.metadata.clone();
  for (const [key, value] of Object.entries(parsed.data)) metadata.set(key, value);
  for (const key of removals) metadata.delete(key);
  return { ...before, metadata };
}
