import { z } from "zod";
import { resourcePath } from "../document-path.js";

export const legacyRetrievalHistorySourceSchema = z.strictObject({
  schema: z.literal("pkm.legacy-retrieval-history-source/v1"),
  sourceDatabase: z.string(),
  size: z.number().int().nonnegative().safe(),
  sha256: z.string().regex(/^[a-f0-9]{64}$/),
  stateSha256: z.string().regex(/^[a-f0-9]{64}$/),
  rawStateSha256: z.string().regex(/^[a-f0-9]{64}$/).optional(),
  schemaProfile: z.strictObject({
    settings: z.array(z.string()), models: z.array(z.string()), calls: z.array(z.string()), query_judgments: z.array(z.string()),
  }).optional(),
  device: z.string(), inode: z.string(), mtimeNs: z.string(), ctimeNs: z.string(),
  counts: z.strictObject({ settings: z.number().int().nonnegative(), models: z.number().int().nonnegative(),
    calls: z.number().int().nonnegative(), query_judgments: z.number().int().nonnegative() }),
});
export type LegacyRetrievalHistorySource = z.infer<typeof legacyRetrievalHistorySourceSchema>;
export const legacyRetrievalHistoryPlanSchema = z.strictObject({
  schema: z.literal("pkm.legacy-retrieval-history-import/v1"), stateRoot: z.string(), actorId: z.string().min(1),
  source: legacyRetrievalHistorySourceSchema,
  selectedPackageId: z.string().regex(/^[a-f0-9]{64}$/).nullable(),
  frozenRelease: z.strictObject({
    sha256: z.string().regex(/^[a-f0-9]{64}$/), releaseId: z.string().regex(/^[a-f0-9]{64}$/),
    packageId: z.string().regex(/^[a-f0-9]{64}$/), originalModelPath: z.string(),
  }).optional(),
  files: z.array(z.strictObject({ path: resourcePath, size: z.number().int().nonnegative().safe(),
    sha256: z.string().regex(/^[a-f0-9]{64}$/) })),
  directories: z.array(resourcePath),
  planSha256: z.string().regex(/^[a-f0-9]{64}$/),
});
export type LegacyRetrievalHistoryPlan = z.infer<typeof legacyRetrievalHistoryPlanSchema>;
