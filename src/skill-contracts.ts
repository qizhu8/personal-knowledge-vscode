import { z } from "zod";
import { documentPath } from "./document-path.js";

const count = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const digest = z.string().regex(/^[a-f0-9]{64}$/);
export const skillRecord = z.strictObject({
  name: z.string().min(1), _key: z.string(),
  schema: z.literal("pkm.knowledge/v1").optional(), knowledgeId: z.string().regex(/^knowledge_[a-f0-9]{24}$/).optional(),
  revision: count.min(1).optional(), aliases: z.array(z.string()), description: z.string(), category: z.string(),
  tags: z.string().refine(value => {
    try { const tags: unknown = JSON.parse(value); return Array.isArray(tags) && tags.every(item => typeof item === "string"); }
    catch { return false; }
  }, "Skill tags must encode the original string array."),
  source_project: z.string().nullable(), recipe_required: z.boolean(), recipe_hint: z.string(),
  related_skills: z.array(z.string()), links: z.array(z.json()), priority: z.enum(["normal", "high", "highest"]),
  pinned: z.boolean(), content: z.string(), created_at: z.string(), updated_at: z.string(),
});
export type SkillRecord = z.infer<typeof skillRecord>;
const address = {
  documentId: z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,79}$/),
  path: documentPath, documentSha256: digest,
};
export const skillDefinitions = [
  {
    id: "knowledge.skill.list", readOnly: true,
    description: "Page original body-free Skill metadata with category/tag filtering and category/name ordering. Retains JSON-encoded tags, priority and recipe fields; adds stable documentId/path/SHA pins. Pin snapshotRevision across pages.",
    input: z.strictObject({
      category: z.string().max(2048).optional(), tag: z.string().max(500).optional(),
      offset: count.max(1_000_000).default(0), limit: count.min(1).max(100).default(20), snapshotRevision: digest.optional(),
    }),
    output: z.strictObject({
      items: z.array(skillRecord.omit({ content: true, _key: true }).extend(address)), total: count,
      nextOffset: count.nullable(), snapshotRevision: digest,
    }),
  },
  {
    id: "knowledge.skill.get", readOnly: true,
    description: "Read the original Skill model/body by exact name OR stable documentId/canonical knowledgeId. Duplicate names are a conflict: use list addresses to disambiguate. Reads never rewrite identity or call a model; optional snapshotRevision pins the collection.",
    input: z.strictObject({
      name: z.string().min(1).max(500).optional(),
      id: z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,79}$/).optional(), snapshotRevision: digest.optional(),
    }).refine(value => (value.name === undefined) !== (value.id === undefined), "Provide exactly one of name or id."),
    output: z.strictObject({ item: skillRecord.extend(address), snapshotRevision: digest }),
  },
] as const;
