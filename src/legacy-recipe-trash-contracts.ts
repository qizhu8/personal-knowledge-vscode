import { z } from "zod";

const digest = z.string().regex(/^[a-f0-9]{64}$/);
const identity = z.string().regex(/^[A-Za-z][A-Za-z0-9._-]{0,127}$/);
const receipt = z.strictObject({
  commandId: z.string().min(1).max(4096),
  fingerprint: z.string().min(1).max(4096),
  operation: z.string().min(1).max(512),
  storeVersion: z.number().int().safe().positive(),
  entityId: z.string().min(1).max(4096),
});

export const LEGACY_RECIPE_TRASH_OPERATIONS = [
  "recipe-trash-move",
  "recipe-trash-restore",
] as const;

export const legacyRecipeTrashCommandSchema = z.strictObject({
  commandId: z.string().min(1).max(4096),
  fingerprint: z.string().min(1).max(4096),
  operation: z.enum(LEGACY_RECIPE_TRASH_OPERATIONS),
  expectedStoreVersion: z.number().int().safe().positive(),
  recipeId: identity,
});
export type LegacyRecipeTrashCommand = z.infer<typeof legacyRecipeTrashCommandSchema>;

export const legacyRecipeTrashEnvelopeSchema = z.strictObject({
  workspaceId: z.string().uuid(),
  operationId: z.string().uuid(),
  actorId: z.string().min(1).max(500),
  callerHostFingerprint: digest,
  command: legacyRecipeTrashCommandSchema,
});
export type LegacyRecipeTrashEnvelope = z.infer<typeof legacyRecipeTrashEnvelopeSchema>;

const fileEntry = z.strictObject({
  path: z.string().min(1).max(2048),
  kind: z.literal("file"),
  sha256: digest,
  base64: z.string().max(2_796_204),
});
const directoryEntry = z.strictObject({
  path: z.string().min(1).max(2048),
  kind: z.literal("directory"),
});
export const legacyRecipeTrashTreeEntrySchema = z.discriminatedUnion("kind", [fileEntry, directoryEntry]);
const tree = z.array(legacyRecipeTrashTreeEntrySchema).max(8192);

export const legacyRecipeTrashEffectPlanSchema = z.strictObject({
  schema: z.literal("pkm.legacy-recipe-trash-effect/v1"),
  workspaceId: z.string().uuid(),
  operationId: z.string().uuid(),
  actorId: z.string().min(1).max(500),
  callerHostFingerprint: digest,
  command: legacyRecipeTrashCommandSchema,
  rootId: z.string().min(1).max(4096),
  controlSha256: digest,
  canonicalDigest: digest,
  priorReceipts: z.array(receipt).max(256),
  recipeId: identity,
  before: tree,
  after: tree,
  planSha256: digest,
});
export type LegacyRecipeTrashEffectPlan = z.infer<typeof legacyRecipeTrashEffectPlanSchema>;
export type LegacyRecipeTrashTreeEntry = z.infer<typeof legacyRecipeTrashTreeEntrySchema>;

export const legacyRecipeTrashImportPlanSchema = z.strictObject({
  schema: z.literal("pkm.legacy-recipe-trash-import/v1"),
  sourceRootId: z.string().min(1).max(4096),
  sourceStoreVersion: z.number().int().safe().positive(),
  sourceControlSha256: digest,
  sourceControlBytes: z.string().max(2_796_204),
  receipts: z.array(receipt).max(256),
  trashFiles: z.array(fileEntry).max(4096),
  totalBytes: z.number().int().safe().nonnegative().max(8 * 1024 * 1024),
  planSha256: digest,
});
export type LegacyRecipeTrashImportPlan = z.infer<typeof legacyRecipeTrashImportPlanSchema>;
