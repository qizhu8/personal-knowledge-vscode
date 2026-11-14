import { z } from "zod";

const count = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const snapshot = z.string().regex(/^[a-f0-9]{64}$/);
const cite = z.strictObject({ paper: z.string(), note: z.string() });
const graphNode = z.strictObject({
  key: z.string(), title: z.string(), year: z.number().nullable(), topic: z.string(),
  authors: z.array(z.string()), tags: z.array(z.string()), kind: z.enum(["idea", "paper"]),
  group: z.string(), pinned: z.boolean(), citationCount: count,
  conclusions: z.array(z.string()), implementation: z.array(z.string()), assumptions: z.array(z.string()),
  cites: z.array(cite), url: z.string(), file: z.string(), category: z.string(),
});
export const paperRecord = graphNode.omit({ key: true, citationCount: true }).extend({
  slug: z.string(), description: z.string(), publisher: z.string(),
  schema: z.literal("pkm.knowledge/v1").optional(), knowledgeId: z.string().regex(/^knowledge_[a-f0-9]{24}$/).optional(),
  revision: count.min(1).optional(), aliases: z.array(z.string()), links: z.array(z.json()),
  content: z.string(), created_at: z.string(), updated_at: z.string(),
});
export type PaperRecord = z.infer<typeof paperRecord>;
const namedCount = z.strictObject({ name: z.string(), count });
const pin = { revision: snapshot.optional() };
export const researchGraph = z.strictObject({
  nodes: z.array(graphNode).max(1024),
  edges: z.array(z.strictObject({ from: z.string(), to: z.string(), note: z.string() })).max(16_384),
  total: count, shown: count,
});
export const researchDefinitions = [
  {
    id: "knowledge.research.list", readOnly: true,
    description: "Page original Paper/Idea metadata, citation counts and original citation/year/title ordering. Excludes trashed documents and body; pin revision across pages and related research queries.",
    input: z.strictObject({
      ...pin, offset: count.max(1_000_000).default(0), limit: count.min(1).max(100).default(20),
    }),
    output: z.strictObject({
      revision: snapshot, items: z.array(paperRecord.omit({ content: true }).extend({ citationCount: count })),
      total: count, nextOffset: count.nullable(),
    }),
  },
  {
    id: "knowledge.research.facets", readOnly: true,
    description: "Original topic/tag counts and descending year facets over nontrashed Papers and Ideas. Counts/order retain legacy semantics; pin revision for a consistent research view.",
    input: z.strictObject(pin),
    output: z.strictObject({ revision: snapshot, topics: z.array(namedCount), tags: z.array(namedCount), years: z.array(z.number()) }),
  },
  {
    id: "knowledge.research.groups", readOnly: true,
    description: "Original user-assigned research groups/counts, custom groups alphabetically then the always-present Papers group. This read never changes metadata or creates folders.",
    input: z.strictObject(pin),
    output: z.strictObject({ revision: snapshot, items: z.array(namedCount) }),
  },
  {
    id: "knowledge.research.graph", readOnly: true,
    description: "Original citation graph: edges point from cited parent to citing child, title/slug references resolve case-insensitively. Neighbors expand one hop and may exceed the seed limit. Maximum 1024 shown nodes/16384 edges; overflow is explicit, never truncated.",
    input: z.strictObject({
      ...pin, topic: z.string().max(500).optional(), tag: z.string().max(500).optional(),
      minYear: z.number().int().min(1).max(9999).optional(), maxYear: z.number().int().min(1).max(9999).optional(),
      limit: count.min(1).max(100).default(10), neighbors: z.boolean().default(false), q: z.string().max(500).optional(),
    }).refine(value => value.minYear === undefined || value.maxYear === undefined || value.minYear <= value.maxYear,
      "minYear must not exceed maxYear."),
    output: researchGraph.extend({ revision: snapshot }),
  },
] as const;
