import { z } from "zod";

const digest = z.string().regex(/^[a-f0-9]{64}$/);

export const legacyMemoryImportPlanSchema = z.strictObject({
  schema: z.literal("pkm.legacy-explicit-memory-import/v1"),
  sourceDatabase: z.string().min(1),
  sourceSize: z.number().int().positive(),
  sourceSha256: digest,
  sourceDevice: z.string().regex(/^[0-9]+$/),
  sourceInode: z.string().regex(/^[0-9]+$/),
  sourceMtimeNs: z.string().regex(/^-?(?:0|[1-9][0-9]{0,19})$/),
  sourceCtimeNs: z.string().regex(/^-?(?:0|[1-9][0-9]{0,19})$/),
  engineIdentity: z.string().min(1).max(512),
  actorId: z.string().min(1).max(256),
  records: z.number().int().nonnegative().max(4096),
  revisions: z.number().int().nonnegative().max(100_000),
  events: z.number().int().nonnegative().max(100_000),
  operations: z.number().int().nonnegative().max(100_000),
  scopes: z.array(z.string().min(1).max(1024)).max(4096),
  continuityScopeSha256: digest.optional(),
  planSha256: digest,
});

export const legacyMemoryImportReceiptSchema = z.strictObject({
  schema: z.literal("pkm.legacy-explicit-memory-import-receipt/v1"),
  sourceDatabaseSha256: digest,
  engineIdentity: z.string().min(1).max(512),
  actorId: z.string().min(1).max(256),
  records: z.number().int().nonnegative(),
  revisions: z.number().int().nonnegative(),
  events: z.number().int().nonnegative(),
  operations: z.number().int().nonnegative(),
  scopes: z.array(z.string().min(1).max(1024)).max(4096),
  documents: z.array(z.strictObject({
    id: z.string().regex(/^explicit-[a-f0-9]{64}$/),
    path: z.string().min(1),
    sha256: digest,
  })).max(4096),
  receiptSha256: digest,
});

export type LegacyMemoryImportPlan = z.infer<typeof legacyMemoryImportPlanSchema>;
export type LegacyMemoryImportReceipt = z.infer<typeof legacyMemoryImportReceiptSchema>;
