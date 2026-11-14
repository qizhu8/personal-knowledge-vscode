import { z } from "zod";
import { resourcePath } from "../document-path.js";
import { trashEntryId } from "../trash-lifecycle-contracts.js";

export const legacyTrashImportVersion = "pkm.legacy-trash-import/v1" as const;
export const legacyTrashImportAreas = ["notes", "skills", "papers"] as const;
const excludedName = z.string().min(1).max(255).refine(value =>
  !/[\/\\\u0000-\u001f]/.test(value) && value !== "." && value !== "..");
export const legacyTrashSnapshotScopeSchema = z.strictObject({
  excludedRootNames: z.array(excludedName).max(256),
  excludedStateNames: z.array(excludedName).max(256),
});
export type LegacyTrashSnapshotScope = z.infer<typeof legacyTrashSnapshotScopeSchema>;
const digest = z.string().regex(/^[a-f0-9]{64}$/);
const originalPath = resourcePath.refine(path => path.split("/").every(part =>
  !part.startsWith(".") && part !== "_assets" && part.toLowerCase() !== "system"
  && !/secret|credential|token|privatekey/i.test(part)));
export const legacyTrashMetadataSchema = z.strictObject({
  id: z.string().regex(/^[0-9]+-[a-f0-9]{10}$/),
  kind: z.enum(["item", "skill", "folder"]),
  name: z.string().min(1).max(4096),
  originalPath,
  deletedAt: z.string().refine(value => Number.isFinite(Date.parse(value))),
  assetsPath: originalPath.optional(),
});
export const adoptedTrashMetadataSchema = legacyTrashMetadataSchema.extend({ id: trashEntryId });
export const legacyTrashDeletionSchema = z.strictObject({
  schema: z.literal(1),
  records: z.array(z.strictObject({
    path: z.string().max(4096).refine(value => /^(skills|notes|papers|prompts|scripts)\//.test(value)
      && value.split("/").every(part => !!part && part !== "." && part !== "..")
      && !/[\\\u0000-\u001f]/.test(value)),
    deletedAt: z.string().refine(value => Number.isFinite(Date.parse(value))),
  })),
});
export const legacyTrashFileSchema = z.strictObject({
  path: z.string().max(4096),
  kind: z.enum(["file", "directory"]),
  dev: z.number().int().safe().nonnegative(),
  ino: z.number().int().safe().nonnegative(),
  size: z.number().int().safe().nonnegative(),
  sha256: digest.nullable(),
});
export const legacyTrashEntrySchema = z.strictObject({
  area: z.enum(legacyTrashImportAreas),
  originalId: legacyTrashMetadataSchema.shape.id,
  runtimeId: z.uuid(),
  metadata: legacyTrashMetadataSchema,
  metadataBytes: z.string(),
  removedPaths: z.array(z.string()).max(2048),
});
export const legacyTrashImportPlanSchema = z.strictObject({
  schema: z.literal(legacyTrashImportVersion),
  source: z.string().min(1),
  sourceSha256: digest,
  inventory: z.array(legacyTrashFileSchema).max(8192),
  entries: z.array(legacyTrashEntrySchema).max(2048),
  deletionBytes: z.string().nullable(),
  snapshotScope: legacyTrashSnapshotScopeSchema.optional(),
  planSha256: digest,
});
export type LegacyTrashImportPlan = z.infer<typeof legacyTrashImportPlanSchema>;
export type LegacyTrashImportEntry = z.infer<typeof legacyTrashEntrySchema>;
export type LegacyTrashInventory = z.infer<typeof legacyTrashFileSchema>[];
export type LegacyTrashDeletion = z.infer<typeof legacyTrashDeletionSchema>;

export const legacyTrashPurgeResultSchema = z.strictObject({
  ok: z.literal(true),
  operationId: z.uuid(),
  action: z.enum(["delete", "empty"]),
  area: z.enum(legacyTrashImportAreas),
  count: z.number().int().safe().nonnegative(),
  entries: z.array(z.strictObject({
    originalId: trashEntryId,
    runtimeEntryId: trashEntryId,
    name: z.string(),
    path: originalPath,
    kind: legacyTrashMetadataSchema.shape.kind,
  })),
});
const purgeInput = z.strictObject({ operationId: z.uuid(), area: z.enum(legacyTrashImportAreas) });
export const legacyTrashPurgeDefinitions = [
  {
    id: "knowledge.trash.delete.original", readOnly: false,
    description: "Permanently remove one adopted Trash bucket and paired assets, with durable retry/recovery. Retains deletion history; not secure erasure of backups.",
    input: purgeInput.extend({ originalId: trashEntryId }),
    output: legacyTrashPurgeResultSchema,
  },
  {
    id: "knowledge.trash.empty.original", readOnly: false,
    description: "Permanently remove the adopted Trash entries in one area using an exact durable selection. Retains deletion history; never removes active documents.",
    input: purgeInput,
    output: legacyTrashPurgeResultSchema,
  },
] as const;

/** No host default or production cutover. The shared importer must qualify every seam explicitly. */
export const legacyTrashImportSharedSeams = Object.freeze({
  journal: ".pkm/state/knowledge-deletions.json: schema=1, ordered records[{path,deletedAt}]; preserve exact bytes, including unrelated/permanent historical deletions",
  pendingOriginal: "No original trash compound journal exists. knowledge-deletions is write-before-move with rollback, not a recoverable intent. Any lock, *.tmp, unknown state/journal, incomplete or assets-only bucket blocks; no inferred replay.",
  importInventory: "notes|skills|papers/.trash/<milliseconds>-<10 lowercase hex>/{metadata.json,payload,assets?}, plus .pkm/state/knowledge-deletions.json; native UUID projection and exact .legacy-trash-import.json adoption marker; prompts/scripts trash unsupported and blocked; fully pinned source and explicit native layout authority required",
  receipt: "legacy_trash_import_receipt binds workspace/root, original source digest, opaque metadata+deletion bytes, original IDs, deterministic UUID projections, canonical native plans and backup lineage; never synthesize historical move receipts",
  ddl: "LEGACY_TRASH_IMPORT_DDL plus existing MIGRATION_RUNTIME_DDL, inside the sole shared transaction; schema migration/version ownership remains with shared storage",
  backup: "Include all three legacy_trash_import_* tables, migration_runtime_trash, native trash trees and receipts; authenticate portable bytes before re-pinning inode/root bindings. The original adoption marker is replaced only by authenticated backup lineage. Existing shared backup is not opted in.",
  allowlist: "Explicit trusted source, absent stage/destination, plan digest, workspace, actor and pkm.trash-lifecycle/v1; native host retains an externally trusted original import-plan digest across restart/backup (never trust a self-rehashed DB row). Sole async writer lock spans all preflight/effects/adoption. Permanent deletion owns only exact preflighted adopted buckets, never generic active paths.",
  nativePolicy: "Explicit knowledge.trash.list/get/restore/delete/empty grants. Imported original IDs resolve through immutable receipt to native UUIDs. Restore clears only exact original removed paths; permanent deletion retains ordered original opaque history and uses a durable migration_runtime_intents selection plus immutable global receipts. Interrupted deletion requires exact native actor-authorized recovery before reads/backup.",
  transactionBoundary: "Importer/backup filesystem IO is async and outside SQL. The explicit restore adapter runs MigrationRuntime's sole read-only plan callback under the same writer but outside SQL, checks the preflight plan byte-for-byte, and uses real SQL transactions only for intent/final publication. No shared runtime/storage edits.",
  sharedSnapshot: "Optional explicit LegacyTrashSnapshotScope {excludedRootNames,excludedStateNames}: exact non-trash names are skipped without stat/read/traversal. Scope is immutable in original plan; native host supplies independent scope. notes|skills|papers and original .pkm/state/knowledge-deletions.json remain owned; unknown selected state/buckets, pending/security-sensitive exclusion names and selected symlinks still fail closed. No scope means unchanged standalone strict denial.",
  composedStage: "populateLegacyTrashImportStage(plan,finalAbsentDestination,exactAuthority,nativeScope,parentStageAuthority) requires existing shared-importer-owned stage under its writer plus exact stage dev/ino, parent inventory SHA256 and async verifier returning that same immutable digest. Excluded root names exactly match scope and parent verifier authenticates all independently owned paths/root membership before effects and after projection. All existing selected paths are preflighted against exact original active bytes/canonical trash projection; unknown/conflicting paths fail before effects. Only absent directories/files are added with exclusive writes, exact marker last, then selected verification/fsync. Never publishes/removes/replaces. Exact complete marker replay verifies; unknown/partial marker blocks.",
});
