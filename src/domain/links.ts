import { z } from "zod";

const count = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const digest = z.string().regex(/^[a-f0-9]{64}$/);
const collection = z.enum(["notes", "skills", "research"]);
const knowledgeUri = z.string().regex(/^pkm:\/\/knowledge\/knowledge_[a-f0-9]{24}$/);
const sourceRevision = z.string().min(1).max(256);

export const linksSnapshotPins = z.strictObject({
  notes: digest,
  skills: digest,
  research: digest,
});

export const knowledgeLinkSource = z.strictObject({
  uri: knowledgeUri,
  collection,
  sourceRevision,
  links: z.unknown(),
});
export type KnowledgeLinkSource = z.infer<typeof knowledgeLinkSource>;

export const knowledgeLinksSnapshot = z.strictObject({
  pins: linksSnapshotPins,
  sources: z.array(knowledgeLinkSource),
});
export type KnowledgeLinksSnapshot = z.infer<typeof knowledgeLinksSnapshot>;
export type KnowledgeLinksSnapshotSource = z.infer<typeof knowledgeLinkSource>;

export const knowledgeLinksResolveInput = z.strictObject({
  starts: z.array(z.string().min(1).max(2048)).min(1).max(16),
  snapshotPins: linksSnapshotPins.optional(),
  direction: z.enum(["forward", "backlink", "both"]).default("both"),
  relations: z.array(z.string().regex(/^[a-z][a-z0-9.-]{0,63}$/)).max(64).optional(),
  maxDepth: count.max(16).default(4),
  maxNodes: count.min(1).max(256).default(100),
  maxEdges: count.min(1).max(1024).default(200),
  nodeOffset: count.default(0),
  edgeOffset: count.default(0),
  pageSize: count.min(1).max(50).default(50),
});
export type KnowledgeLinksResolveInput = z.infer<typeof knowledgeLinksResolveInput>;

export const knowledgeLinkNode = z.strictObject({
  uri: knowledgeUri,
  collection,
  sourceRevision,
});

export const knowledgeLinkEdge = z.strictObject({
  source: knowledgeUri,
  target: z.string().min(1).max(2048),
  relation: z.string().regex(/^[a-z][a-z0-9.-]{0,63}$/),
  mode: z.enum(["floating", "pinned"]),
  required: z.boolean(),
  targetRevision: z.string().min(1).max(256).optional(),
  resolved: z.boolean(),
});

export const knowledgeLinkDiagnostic = z.strictObject({
  code: z.enum([
    "invalid-link",
    "missing-start",
    "missing-target",
    "unsupported-start",
    "unsupported-target",
    "pinned-revision-mismatch",
    "cycle",
    "truncated",
  ]),
  message: z.string(),
  source: z.string().optional(),
  target: z.string().optional(),
  relation: z.string().optional(),
  pointer: z.string().optional(),
});

export const knowledgeLinksResolveOutput = z.strictObject({
  snapshotPins: linksSnapshotPins,
  nodes: z.array(knowledgeLinkNode).max(50),
  edges: z.array(knowledgeLinkEdge).max(50),
  diagnostics: z.array(knowledgeLinkDiagnostic).max(100),
  totalNodes: count,
  totalEdges: count,
  nextNodeOffset: count.nullable(),
  nextEdgeOffset: count.nullable(),
  truncated: z.boolean(),
});
export type KnowledgeLinksResolveOutput = z.infer<typeof knowledgeLinksResolveOutput>;

export const linksDefinitions = [
  {
    id: "knowledge.links.resolve",
    readOnly: true,
    description: "Resolve canonical pkm://knowledge links among Notes, Skills and Papers. Omit snapshotPins on the first page; reuse returned pins on continuation pages to fail closed if a collection changed. Returns bounded forward/backlink graph pages and explicit missing, unsupported and pinned-revision diagnostics. Script and Project targets are never resolved without adapters; no URLs are fetched and no files are changed.",
    input: knowledgeLinksResolveInput,
    output: knowledgeLinksResolveOutput,
  },
] as const;
