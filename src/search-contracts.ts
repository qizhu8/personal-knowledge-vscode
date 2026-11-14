import { z } from "zod";
import { documentPath } from "./document-path.js";
import { noteRecord } from "./note-contracts.js";
import { paperRecord } from "./research-contracts.js";
import { skillRecord } from "./skill-contracts.js";

const count = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const digest = z.string().regex(/^[a-f0-9]{64}$/);
const address = {
  documentId: z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,79}$/),
  path: documentPath,
  documentSha256: digest,
};
const literalSearch = {
  query: z.string().max(500),
  caseSensitive: z.boolean().default(false),
  regex: z.boolean().default(false),
  offset: count.default(0),
  limit: count.min(1).max(100).default(20),
};
const literalSearchInput = z.strictObject(literalSearch).refine(
  value => !value.regex,
  { message: "Regular-expression search is not supported; use a literal query.", path: ["regex"] },
);

const noteSearchItem = noteRecord.omit({ content: true }).extend(address);
const skillSearchItem = skillRecord.omit({ content: true, _key: true }).extend(address);
const paperSearchItem = paperRecord.omit({ content: true }).extend({
  citationCount: count,
  ...address,
});

export const searchDefinitions = [
  {
    id: "knowledge.note.search",
    readOnly: true,
    description: "Search the original Note fields with a bounded literal query. Body is matched internally but never returned. Pin snapshotRevision across pages; results retain descending update-time order and stable addresses. Host-specific absolute paths are not searchable.",
    input: literalSearchInput.extend({ snapshotRevision: digest.optional() }),
    output: z.strictObject({
      items: z.array(noteSearchItem).max(100),
      total: count,
      nextOffset: count.nullable(),
      snapshotRevision: digest,
    }),
  },
  {
    id: "knowledge.skill.search",
    readOnly: true,
    description: "Search the original Skill fields with a bounded literal query. Body is matched internally but never returned. Pin snapshotRevision across pages; original depth-first path order and stable addresses are retained.",
    input: literalSearchInput.extend({ snapshotRevision: digest.optional() }),
    output: z.strictObject({
      items: z.array(skillSearchItem).max(100),
      total: count,
      nextOffset: count.nullable(),
      snapshotRevision: digest,
    }),
  },
  {
    id: "knowledge.research.search",
    readOnly: true,
    description: "Search the original Paper/Idea fields with a bounded literal query. Body is matched internally but never returned. Pin revision across pages; citation-count/year/title order and stable addresses are retained.",
    input: literalSearchInput.extend({ revision: digest.optional() }),
    output: z.strictObject({
      items: z.array(paperSearchItem).max(100),
      total: count,
      nextOffset: count.nullable(),
      revision: digest,
    }),
  },
] as const;
