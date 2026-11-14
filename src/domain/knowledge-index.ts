import { createHash } from "node:crypto";
import type { AppendStatement, CreatePiece, LinkPieces, SourceReference } from "../compute/contracts.js";
import { compileKnowledgeLinksV1 } from "./knowledge-contracts.js";

/** Rebuild-only bridge. Markdown authority never moves into the disposable compute database. */
export const KNOWLEDGE_INDEX_SCHEMA = "pkm.next.knowledge-index/v1" as const;
export const KNOWLEDGE_INDEX_LIMITS = Object.freeze({
  documents: 128, rawBytes: Number.MAX_SAFE_INTEGER, documentBytes: Number.MAX_SAFE_INTEGER,
  edges: 512, chunkCodePoints: 16_000, pendingRebuilds: 8,
});
export class KnowledgeIndexError extends Error {
  constructor(readonly code: "INVALID_ARGUMENT" | "STALE_SOURCE" | "STALE_PIN" | "LIMIT" | "BUSY" |
    "CANCELLED" | "STAGING_EXISTS" | "WORKER_FAILED" | "VALIDATION_FAILED" | "CLEANUP_FAILED",
    message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "KnowledgeIndexError";
  }
}
export interface KnowledgeIndexScope {
  /** Explicit account/root partition, not a display label. */
  partition: string;
  namespace: string;
}
export interface KnowledgeIndexSource {
  area: "notes" | "skills" | "papers";
  path: string;
  documentId: string;
  title: string;
  revision: number;
  rawSha256: string;
  /** Existing Knowledge-link revision semantics, distinct from the stronger compute source pin. */
  linkRevision: string;
  body: string;
  metadata: Record<string, unknown>;
}
export interface KnowledgeIndexPin {
  area: KnowledgeIndexSource["area"];
  path: string;
  documentId: string;
  identity: string;
  kind: "note" | "skill" | "research";
  revision: number;
  rawSha256: string;
  linkRevision: string;
  bodySha256: string;
  projectionSha256: string;
  sourceRevision: string;
  piece: string;
  source: SourceReference;
}
export interface KnowledgeIndexPlannedPiece {
  create: CreatePiece;
  pin: KnowledgeIndexPin;
  statements: AppendStatement[];
}
export interface KnowledgeIndexPlan {
  schema: typeof KNOWLEDGE_INDEX_SCHEMA;
  scope: string;
  workerIdentity: string;
  sourceDigest: string;
  contentDigest: string;
  counts: { documents: number; pieces: number; statements: number; sources: number; edges: number; bytes: number };
  pieces: KnowledgeIndexPlannedPiece[];
  edges: LinkPieces[];
  warnings: string[];
}

/** Stable JSON for source pins/receipts, not a replacement for the Python engine's digest(body). */
export function knowledgeIndexCanonical(value: unknown): string {
  if (value === null || typeof value === "string" || typeof value === "boolean") return JSON.stringify(value);
  if (typeof value === "number" && Number.isFinite(value)) return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(knowledgeIndexCanonical).join(",")}]`;
  if (value && typeof value === "object" && (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null)) {
    return `{${Object.keys(value).sort().map(key =>
      `${JSON.stringify(key)}:${knowledgeIndexCanonical((value as Record<string, unknown>)[key])}`).join(",")}}`;
  }
  throw new KnowledgeIndexError("INVALID_ARGUMENT", "Expected finite JSON projection metadata.");
}
export function knowledgeIndexHash(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}
export function knowledgeIndexWellFormed(value: string): boolean {
  return /^(?:[^\uD800-\uDFFF]|[\uD800-\uDBFF][\uDC00-\uDFFF])*$/u.test(value);
}
export function knowledgeIndexDigest(value: unknown): string { return knowledgeIndexHash(knowledgeIndexCanonical(value)); }
export function knowledgeIndexScope(root: string, scope: KnowledgeIndexScope): { scope: string; workerIdentity: string } {
  if (!scope || Object.keys(scope).some(key => key !== "partition" && key !== "namespace")) {
    throw new KnowledgeIndexError("INVALID_ARGUMENT", "Expected explicit partition and namespace.");
  }
  for (const value of [scope.partition, scope.namespace]) {
    if (typeof value !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._/-]{0,199}$/.test(value) ||
      value.split("/").some(part => !part || part === "." || part === "..")) {
      throw new KnowledgeIndexError("INVALID_ARGUMENT", "Invalid partition/namespace; empty, ambiguous or control-character scopes are forbidden.");
    }
  }
  const hash = knowledgeIndexDigest([KNOWLEDGE_INDEX_SCHEMA, root, scope.partition, scope.namespace]);
  return { scope: `ki:${hash}`, workerIdentity: `knowledge-index/v1:${hash}` };
}
const relations = new Set<LinkPieces["relation"]>([
  "abstracts", "part_of", "clarifies", "revises", "supersedes", "addresses", "implements", "verifies",
]);

/**
 * Original engine kinds are piece/message/topic/project, not Note/Skill/Paper.
 * Markdown documents are generic source pieces; their native kind and ALL metadata
 * are losslessly projected, never passed off as Chat messages or model-derived topics.
 * Explicit supported Knowledge links keep their direction (parent=source, child=target).
 * No inferred projects, summaries, model embeddings, or implicit-memory decisions.
 */
export function planKnowledgeIndex(root: string, scope: KnowledgeIndexScope, sources: readonly KnowledgeIndexSource[]): KnowledgeIndexPlan {
  if (sources.length > KNOWLEDGE_INDEX_LIMITS.documents) throw new KnowledgeIndexError("LIMIT", "At most 128 explicit documents per rebuild.");
  const bound = knowledgeIndexScope(root, scope);
  const identities = new Set<string>(), documentIds = new Set<string>(), paths = new Set<string>();
  const warnings: string[] = [];
  const pieces = [...sources].sort((a, b) => Buffer.compare(Buffer.from(`${a.area}/${a.path}`), Buffer.from(`${b.area}/${b.path}`))).map(source => {
    if (!["notes", "skills", "papers"].includes(source.area) || !/^[a-f0-9]{64}$/.test(source.rawSha256) ||
      typeof source.title !== "string" || !source.title || Buffer.byteLength(source.title) > 1024 ||
      !Number.isSafeInteger(source.revision) || source.revision < 1 || typeof source.linkRevision !== "string" ||
      !source.linkRevision || source.linkRevision.length > 256) {
      throw new KnowledgeIndexError("INVALID_ARGUMENT", "Invalid bounded source projection fields.");
    }
    const kind = source.area === "notes" ? "note" : source.area === "skills" ? "skill" : "research";
    const knowledgeId = source.metadata.knowledgeId;
    if (knowledgeId !== undefined && (typeof knowledgeId !== "string" || !/^knowledge_[a-f0-9]{24}$/.test(knowledgeId))) {
      throw new KnowledgeIndexError("INVALID_ARGUMENT", "Invalid Knowledge identity; refusing an ambiguous source.");
    }
    const identity = typeof knowledgeId === "string" ? knowledgeId : `${kind}:${source.documentId}`;
    const address = `${source.area}/${source.path}`;
    if (identities.has(identity) || documentIds.has(source.documentId) || paths.has(address)) {
      throw new KnowledgeIndexError("INVALID_ARGUMENT", "Duplicate source identity or path in the explicit snapshot.");
    }
    identities.add(identity); documentIds.add(source.documentId); paths.add(address);
    if (Buffer.byteLength(`markdown:${address}`) > 2048) throw new KnowledgeIndexError("LIMIT", "Source locator exceeds the engine's 2048-byte boundary.");
    if (/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/u.test(source.body) || !knowledgeIndexWellFormed(source.body)) {
      throw new KnowledgeIndexError("INVALID_ARGUMENT", "Unsupported body control characters or malformed Unicode.");
    }
    const projection = knowledgeIndexCanonical({ body: source.body, metadata: source.metadata, title: source.title, kind });
    const projectionSha256 = knowledgeIndexHash(projection);
    const sourceRevision = `r:${source.revision}:${source.rawSha256}:${projectionSha256}`;
    const piece = `${bound.scope}|k|${knowledgeIndexDigest(identity)}`;
    const reference: SourceReference = {
      id: `${bound.scope}|src|${knowledgeIndexDigest([identity, sourceRevision])}`,
      chat: bound.scope, revision: sourceRevision, locator: `markdown:${address}`,
    };
    const pin: KnowledgeIndexPin = {
      area: source.area, path: source.path, documentId: source.documentId, identity, kind,
      revision: source.revision, rawSha256: source.rawSha256, linkRevision: source.linkRevision, bodySha256: knowledgeIndexHash(source.body),
      projectionSha256, sourceRevision, piece, source: reference,
    };
    // Match original Chat _ingest's 16,000 Python-code-point chunks (not UTF-16 slices).
    const points = Array.from(projection), statements: AppendStatement[] = [];
    for (let offset = 0; offset < points.length; offset += KNOWLEDGE_INDEX_LIMITS.chunkCodePoints) {
      statements.push({
        piece, statement_id: `${piece}|${knowledgeIndexHash(sourceRevision).slice(0, 16)}|${offset}`,
        expected_revision: statements.length, body: points.slice(offset, offset + KNOWLEDGE_INDEX_LIMITS.chunkCodePoints).join(""),
        status: "observation", sources: [reference],
      });
    }
    return { create: { piece, label: source.title, kind: "piece" as const, scope: bound.scope }, pin, statements };
  });
  const byKnowledgeId = new Map(pieces.filter(item => item.pin.identity.startsWith("knowledge_")).map(item => [item.pin.identity, item]));
  const byIdentity = new Map(pieces.map(item => [item.pin.identity, item]));
  const edges = new Map<string, LinkPieces>();
  for (const source of sources) {
    if (source.metadata.links === undefined) continue;
    const compiled = compileKnowledgeLinksV1(source.metadata.links);
    if (!compiled.ok) throw new KnowledgeIndexError("INVALID_ARGUMENT", "Invalid typed Knowledge links; no partial graph was rebuilt.");
    const kind = source.area === "notes" ? "note" : source.area === "skills" ? "skill" : "research";
    const parent = byIdentity.get(String(source.metadata.knowledgeId ?? `${kind}:${source.documentId}`))!;
    for (const link of compiled.links) {
      const target = byKnowledgeId.get(link.target.replace(/^pkm:\/\/knowledge\//, ""));
      if (!target || !relations.has(link.relation as LinkPieces["relation"])) {
        if (link.required) throw new KnowledgeIndexError("INVALID_ARGUMENT", "Required link is outside this snapshot or unsupported by the original engine.");
        warnings.push(`${parent.pin.identity}: omitted optional ${link.relation} link ${link.target}`);
        continue;
      }
      // Preserve the original Knowledge-link revision contract; compute pins separately
      // bind actual raw bytes/body/metadata even when the author did not bump revision.
      if (link.mode === "pinned" && link.targetRevision !== target.pin.linkRevision) {
        throw new KnowledgeIndexError("STALE_PIN", "Pinned Knowledge target changed; no stale edge was applied.");
      }
      const edge: LinkPieces = { parent: parent.create.piece, child: target.create.piece, relation: link.relation as LinkPieces["relation"] };
      edges.set(knowledgeIndexCanonical(edge), edge);
      if (edges.size > KNOWLEDGE_INDEX_LIMITS.edges) throw new KnowledgeIndexError("LIMIT", "At most 512 explicit edges per rebuild.");
    }
  }
  const orderedEdges = [...edges].sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([, edge]) => edge);
  // Fail before launching a worker on abstraction cycles; other relation cycles are legal.
  const children = new Map<string, string[]>();
  for (const edge of orderedEdges) if (edge.relation === "abstracts") children.set(edge.parent, [...children.get(edge.parent) ?? [], edge.child]);
  const visiting = new Set<string>(), visited = new Set<string>();
  function visit(id: string): void {
    if (visiting.has(id)) throw new KnowledgeIndexError("INVALID_ARGUMENT", "Abstraction cycle in explicit Knowledge links.");
    if (visited.has(id)) return;
    visiting.add(id);
    for (const child of children.get(id) ?? []) visit(child);
    visiting.delete(id); visited.add(id);
  }
  for (const piece of pieces) visit(piece.create.piece);
  const statements = pieces.flatMap(item => item.statements);
  return {
    schema: KNOWLEDGE_INDEX_SCHEMA, ...bound, pieces, edges: orderedEdges, warnings: warnings.sort(),
    sourceDigest: knowledgeIndexDigest(pieces.map(item => item.pin)),
    contentDigest: knowledgeIndexDigest({ pieces: pieces.map(item => ({ create: item.create, statements: item.statements })), edges: orderedEdges }),
    counts: { documents: pieces.length, pieces: pieces.length, statements: statements.length, sources: pieces.length,
      edges: orderedEdges.length, bytes: statements.reduce((n, item) => n + Buffer.byteLength(item.body), 0) },
  };
}
