import { z } from "zod";
import { documentPath } from "./document-path.js";

const count = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const digest = z.string().regex(/^[a-f0-9]{64}$/);
export const noteRecord = z.strictObject({
  slug: z.string(), schema: z.literal("pkm.knowledge/v1").optional(),
  knowledgeId: z.string().regex(/^knowledge_[a-f0-9]{24}$/).optional(), revision: count.min(1).optional(),
  aliases: z.array(z.string()), title: z.string().min(1), description: z.string(), type: z.string(),
  documentKind: z.enum(["markdown", "todo-board"]), boardDigest: digest.optional(),
  tags: z.string().refine(value => {
    try { const tags: unknown = JSON.parse(value); return Array.isArray(tags) && tags.every(item => typeof item === "string"); }
    catch { return false; }
  }, "Note tags must encode the original string array."),
  pinned: z.boolean(), links: z.array(z.json()), category: z.string(), content: z.string(),
  created_at: z.string(), updated_at: z.string(),
});
export type NoteRecord = z.infer<typeof noteRecord>;
const address = {
  documentId: z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,79}$/), path: documentPath, documentSha256: digest,
};
export const noteDefinitions = [
  {
    id: "knowledge.note.list", readOnly: true,
    description: "Page original body-free Note metadata/type filters and descending updated-at ordering, including checked legacy Board classification/digest. Limit 0 returns all remaining Notes; positive limits are not capped at 100. Adds stable documentId/path/SHA addresses. Pin snapshotRevision across pages; does not import old Board commands.",
    input: z.strictObject({
      type: z.string().max(500).optional(), offset: count.default(0), limit: count.default(20),
      snapshotRevision: digest.optional(),
    }),
    output: z.strictObject({
      items: z.array(noteRecord.omit({ content: true }).extend(address)), total: count,
      nextOffset: count.nullable(), snapshotRevision: digest,
    }),
  },
  {
    id: "knowledge.note.get", readOnly: true,
    description: "Read original Note metadata/body by stable documentId/canonical knowledgeId, relative Markdown path, or preserved typed Note alias. Ambiguous aliases fail closed. Checked Board backing contributes digest/update time, never authority to edit. Pin snapshotRevision for a consistent Note collection.",
    input: z.strictObject({
      id: z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,79}$/).optional(), path: documentPath.optional(),
      alias: z.string().regex(/^note:[^\u0000-\u001f]+$/).max(2048).optional(),
      snapshotRevision: digest.optional(),
    }).refine(value => [value.id, value.path, value.alias].filter(item => item !== undefined).length === 1,
      "Provide exactly one of id, path or alias."),
    output: z.strictObject({ item: noteRecord.extend(address), snapshotRevision: digest }),
  },
] as const;
