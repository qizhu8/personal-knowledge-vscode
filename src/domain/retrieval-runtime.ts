import { createHash } from "node:crypto";

export const RETRIEVAL_RUNTIME_LIMITS = Object.freeze({
  sources: 128, sourceBytes: Number.MAX_SAFE_INTEGER, totalBytes: Number.MAX_SAFE_INTEGER,
  chunks: 2048, dimensions: 4096, vectorValues: 1024 * 1024, results: 100,
  queryBytes: 4096, checkpoints: 4, batch: 16,
});
export interface RetrievalScope { namespace: string; workspace: string; actor: string }
export interface RetrievalModelPin {
  id: string; revision: string; dimensions: number; architecture: "dense-section";
}
export interface RetrievalSource {
  id: string; revision: string; sha256: string; title: string; description: string; body: string;
}
export interface RetrievalChunk {
  id: string; sourceId: string; ordinal: number; text: string; vector: number[];
}
export interface RetrievalRanked {
  sourceId: string; chunkId: string; text: string; rank: number; score: number; similarity: number;
}
export class RetrievalRuntimeError extends Error {
  constructor(public readonly code: "INVALID_ARGUMENT" | "LIMIT" | "UNAVAILABLE" | "STALE_SOURCE" | "CONFLICT" | "INTEGRITY" | "FORBIDDEN", message: string) {
    super(message); this.name = "RetrievalRuntimeError";
  }
}
export function retrievalAssert(value: unknown, code: RetrievalRuntimeError["code"], message: string): asserts value {
  if (!value) throw new RetrievalRuntimeError(code, message);
}
export function retrievalDigest(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}
export function retrievalCompare(left: string, right: string): number {
  const a = Array.from(left, value => value.codePointAt(0)!), b = Array.from(right, value => value.codePointAt(0)!);
  for (let index = 0; index < Math.min(a.length, b.length); index++) {
    if (a[index] !== b[index]) return a[index] - b[index];
  }
  return a.length - b.length;
}
export function retrievalText(value: unknown, bytes: number, empty = false): asserts value is string {
  retrievalAssert(typeof value === "string" && (empty || value.trim().length > 0)
    && /^(?:[\u0000-\uD7FF\uE000-\uFFFF]|[\uD800-\uDBFF][\uDC00-\uDFFF])*$/.test(value)
    && !value.includes("\0") && Buffer.byteLength(value) <= bytes, "INVALID_ARGUMENT", "Invalid bounded retrieval text.");
}
export function retrievalScope(value: RetrievalScope): RetrievalScope {
  retrievalAssert(value && typeof value === "object", "INVALID_ARGUMENT", "Explicit retrieval scope required.");
  for (const key of ["namespace", "workspace", "actor"] as const) retrievalText(value[key], 256);
  return { namespace: value.namespace, workspace: value.workspace, actor: value.actor };
}
export function retrievalModel(value: RetrievalModelPin): RetrievalModelPin {
  retrievalAssert(value && typeof value === "object", "INVALID_ARGUMENT", "Explicit embedding model pin required.");
  retrievalText(value.id, 256); retrievalText(value.revision, 256);
  retrievalAssert(value.architecture === "dense-section" && Number.isSafeInteger(value.dimensions) && value.dimensions >= 1
    && value.dimensions <= RETRIEVAL_RUNTIME_LIMITS.dimensions, "INVALID_ARGUMENT", "Unsupported architecture or embedding dimensions.");
  return { id: value.id, revision: value.revision, dimensions: value.dimensions, architecture: value.architecture };
}
export function retrievalSources(values: readonly RetrievalSource[]): RetrievalSource[] {
  retrievalAssert(Array.isArray(values) && values.length <= RETRIEVAL_RUNTIME_LIMITS.sources, "LIMIT", "Retrieval source bound exceeded.");
  const ids = new Set<string>();
  let bytes = 0;
  const result = values.map(value => {
    retrievalAssert(value && typeof value === "object", "INVALID_ARGUMENT", "Invalid retrieval source.");
    retrievalText(value.id, 256); retrievalText(value.revision, 256);
    retrievalAssert(typeof value.sha256 === "string" && /^[a-f0-9]{64}$/.test(value.sha256), "INVALID_ARGUMENT", "Exact source SHA-256 required.");
    for (const key of ["title", "description", "body"] as const) retrievalText(value[key], RETRIEVAL_RUNTIME_LIMITS.sourceBytes, true);
    const source = { id: value.id, revision: value.revision, sha256: value.sha256, title: value.title, description: value.description, body: value.body };
    const size = Buffer.byteLength(JSON.stringify(source));
    bytes += size;
    retrievalAssert(size <= RETRIEVAL_RUNTIME_LIMITS.sourceBytes && bytes <= RETRIEVAL_RUNTIME_LIMITS.totalBytes, "LIMIT", "Retrieval source bytes exceeded.");
    retrievalAssert(!ids.has(source.id), "INVALID_ARGUMENT", "Duplicate source identity.");
    ids.add(source.id);
    return source;
  });
  return result.sort((a, b) => retrievalCompare(a.id, b.id));
}

/** Port of ArchitectureRetriever._sections: heading sections omit a pre-heading preamble. */
export function retrievalSections(source: RetrievalSource): string[] {
  // Python re/str whitespace excludes BOM and includes NEL; Python multiline anchors only on LF.
  const whitespace = "[\\t-\\r\\u001c-\\u0020\\u0085\\u00a0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000]";
  const strip = (value: string) => value.replace(new RegExp(`^${whitespace}+|${whitespace}+$`, "g"), "");
  const heading = new RegExp(`(?<![^\\n])#{1,6}${whitespace}+([^\\n]+?)${whitespace}*(?=\\n|$)`, "g");
  const matches = [...source.body.matchAll(heading)];
  const prefix = strip(`${source.title}\n${source.description}`);
  if (!matches.length) return [strip(`${prefix}\n${source.body}`)];
  return matches.map((match, index) => strip(`${prefix}\n${source.body.slice(match.index!, matches[index + 1]?.index ?? source.body.length)}`));
}
export function retrievalVector(value: unknown, dimensions: number): number[] {
  retrievalAssert(Array.isArray(value) && value.length === dimensions
    && value.every(item => typeof item === "number" && Number.isFinite(item)), "INVALID_ARGUMENT", "Invalid finite embedding vector dimensions.");
  return [...value];
}
export function retrievalCosine(left: readonly number[], right: readonly number[]): number {
  retrievalAssert(left.length > 0 && left.length <= RETRIEVAL_RUNTIME_LIMITS.dimensions && left.length === right.length
    && [...left, ...right].every(Number.isFinite), "INVALID_ARGUMENT", "Invalid cosine operands.");
  // Scaling avoids overflow/underflow without changing normalized dot-product semantics.
  const a = Math.max(...left.map(Math.abs)), b = Math.max(...right.map(Math.abs));
  if (!a || !b) return 0;
  let dot = 0, l2 = 0, r2 = 0;
  for (let index = 0; index < left.length; index++) {
    const l = left[index] / a, r = right[index] / b;
    dot += l * r; l2 += l * l; r2 += r * r;
  }
  return Math.max(-1, Math.min(1, dot / Math.sqrt(l2 * r2)));
}
export function retrievalLimit(value: number): number {
  retrievalAssert(Number.isSafeInteger(value) && value >= 1 && value <= RETRIEVAL_RUNTIME_LIMITS.results, "LIMIT", "Retrieval limit must be 1..100.");
  return value;
}
/** Original dense-section max-pooling, source-ID tie break, and reciprocal-rank public score. */
export function retrievalRank(chunks: readonly RetrievalChunk[], queryVector: readonly number[], limit = 5): RetrievalRanked[] {
  retrievalLimit(limit);
  retrievalAssert(chunks.length <= RETRIEVAL_RUNTIME_LIMITS.chunks, "LIMIT", "Ranking chunk bound exceeded.");
  const best = new Map<string, { chunk: RetrievalChunk; similarity: number }>();
  for (const chunk of chunks) {
    const similarity = retrievalCosine(queryVector, chunk.vector), previous = best.get(chunk.sourceId);
    if (!previous || similarity > previous.similarity) best.set(chunk.sourceId, { chunk, similarity });
  }
  return [...best.values()].sort((a, b) => b.similarity - a.similarity
    || retrievalCompare(a.chunk.sourceId, b.chunk.sourceId))
    .slice(0, limit).map(({ chunk, similarity }, index) => ({
      sourceId: chunk.sourceId, chunkId: chunk.id, text: chunk.text,
      rank: index + 1, score: 1 / (index + 1), similarity,
    }));
}
