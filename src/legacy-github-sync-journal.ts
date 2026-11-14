import { z } from "zod";

const oid = z.string().regex(/^[a-f0-9]{40}$/);
const uuid = z.string().uuid();
export const experimentalLegacySyncJournalSchema = z.strictObject({
  schema: z.literal("pkm.experimental-legacy-sync/v1"),
  workspaceId: z.string().min(1), configHash: z.string().regex(/^[a-f0-9]{64}$/),
  targetId: z.string(), policyId: uuid, baseline: oid.optional(),
  baselineOperationId: uuid.optional(),
  phase: z.enum(["initial", "comparison", "idle", "conflict", "applying", "publishing", "review"]),
  sessionId: uuid.optional(), applyOperationId: uuid.optional(), publishOperationId: uuid.optional(),
  applyId: uuid.optional(),
  privacyHash: z.string().regex(/^[a-f0-9]{64}$/).optional(),
  trashMoves: z.array(z.strictObject({
    operationId: uuid, path: z.string().min(1), expectedTreeSha256: z.string().regex(/^[a-f0-9]{64}$/),
    expectedScanRevision: z.string().regex(/^[a-f0-9]{64}$/),
  })).optional(),
  trashRestores: z.array(z.strictObject({
    operationId: uuid, itemId: z.string().min(1), entryId: z.string().min(1),
    expectedScanRevision: z.string().regex(/^[a-f0-9]{64}$/),
  })).optional(),
  conflicts: z.array(z.strictObject({ id: z.string(), type: z.string(), itemId: z.string(), reason: z.string() })).optional(),
  legacyRecovery: z.strictObject({
    receiptSha256: z.string().regex(/^[a-f0-9]{64}$/), baseCommit: oid, pushedCommit: oid,
  }).optional(),
});
