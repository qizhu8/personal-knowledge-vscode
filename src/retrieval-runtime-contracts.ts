import { z } from "zod";

const text = (max: number) => z.string().min(1).max(max).refine(value =>
  /^(?:[\u0000-\uD7FF\uE000-\uFFFF]|[\uD800-\uDBFF][\uDC00-\uDFFF])*$/.test(value)
  && !value.includes("\0") && Buffer.byteLength(value) <= max);
const digest = z.string().regex(/^[a-f0-9]{64}$/);
export const retrievalRuntimeModel = z.strictObject({
  id: text(256), revision: text(256), dimensions: z.number().int().min(1).max(4096),
  architecture: z.literal("dense-section"),
});
/** Schema-only public discovery. Host registers only when its explicit embedder/index are available.
 * Actor, namespace, workspace, source readers, model configuration and database are never public inputs. */
export const retrievalRuntimeDefinitions = [{
  id: "retrieval.runtime.search", readOnly: true, nativeOnly: false,
  description: "Search an explicitly activated, pinned dense-section embedding index. Returns reciprocal-rank scores and cosine evidence; stale/deleted sources fail closed. No literal-search fallback.",
  input: z.strictObject({
    query: text(4096), limit: z.number().int().min(1).max(100).default(5), expectedIndexId: text(256).optional(),
    sourceIds: z.array(text(256)).max(128).refine(values => new Set(values).size === values.length).optional(),
  }),
  output: z.strictObject({
    indexId: text(256), sourceDigest: digest, model: retrievalRuntimeModel,
    hits: z.array(z.strictObject({
      sourceId: text(256), sourceRevision: text(256), sourceSha256: digest,
      chunkId: digest, text: z.string().max(1024 * 1024),
      rank: z.number().int().min(1).max(100), score: z.number().positive().max(1),
      similarity: z.number().min(-1).max(1), indexId: text(256), model: retrievalRuntimeModel,
    })).max(100),
  }),
}] as const;
