import type { DatabaseSync } from "node:sqlite";
import { createHash } from "node:crypto";
import { closeSync, constants, fstatSync, openSync, readSync } from "node:fs";
import { CoreError } from "./contracts.js";
import { checkedDocumentPath } from "./document-path.js";
import { decodeMarkdown } from "./markdown.js";
import { freshRecipeKnowledgeDocuments } from "./recipe-knowledge-context.js";

/** Read only explicitly host-approved document IDs from the existing index; never enumerate a root. */
export function readIndexedRecipeKnowledgeDocuments(options: {
  root: string; database: DatabaseSync; documentIds: readonly string[]; assertLease(): void;
}) {
  options.assertLease();
  const ids = options.documentIds;
  if (!Array.isArray(ids) || ids.length > 128 || new Set(ids).size !== ids.length
    || ids.some(id => typeof id !== "string" || !id || id.length > 256))
    throw new CoreError("INVALID_ARGUMENT", "An exact bounded host-approved Recipe document scope is required.");
  const statement = options.database.prepare("SELECT id,path,area,sha256,deleted FROM documents WHERE id=?");
  let total = 0;
  const documents = ids.map(id => {
    const row = statement.get(id);
    if (!row || row.deleted !== 0 || !["notes", "skills"].includes(String(row.area)))
      throw new CoreError("ACCESS_DENIED", "Recipe document is absent or outside the host-approved Note/Skill scope.");
    const area = row.area as "notes" | "skills", relative = String(row.path);
    const fd = openSync(checkedDocumentPath(options.root, relative, false, area),
      constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    try {
      const before = fstatSync(fd, { bigint: true });
      if (!before.isFile() || before.nlink !== 1n || before.size > 2_097_152n || (total += Number(before.size)) > 2_097_152)
        throw new CoreError("RESOURCE_LIMIT", "Recipe Knowledge exceeds its bounded current document scope.");
      const buffer = Buffer.alloc(Number(before.size) + 1);
      let length = 0;
      while (length < buffer.length) {
        const count = readSync(fd, buffer, length, buffer.length - length, null);
        if (!count) break;
        length += count;
      }
      const bytes = buffer.subarray(0, length), after = fstatSync(fd, { bigint: true });
      if (before.dev !== after.dev || before.ino !== after.ino || before.size !== after.size
        || before.mtimeNs !== after.mtimeNs || before.ctimeNs !== after.ctimeNs || length !== Number(before.size)
        || createHash("sha256").update(bytes).digest("hex") !== row.sha256)
        throw new CoreError("CONFLICT", "Recipe document differs from its existing indexed bytes.");
      return decodeMarkdown(id, new TextDecoder("utf-8", { fatal: true }).decode(bytes), relative, area);
    } finally { closeSync(fd); }
  });
  options.assertLease();
  return freshRecipeKnowledgeDocuments(options.root, documents);
}
