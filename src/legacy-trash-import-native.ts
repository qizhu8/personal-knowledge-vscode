import { resolve, join } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { z } from "zod";
import { MigrationRuntime, initializeMigrationRuntime, assertNativeTrashRow, readNativeTrashOrigins, readOriginalTrashDeletionHistory, nativeTrashSupersedesImportedPlan, nativeKnowledgeSupersedesImportedPlan } from "./migration-runtime.js";
import {
  deserializeTrashLifecyclePlan, inspectTrashLifecycleEntry, inspectTrashLifecycleRecovery,
  planTrashRestore, repinTrashLifecycleBackup, serializeTrashLifecyclePlan, trashLifecycleDefinitions, trashLifecycleMetadata, type TrashLifecyclePlan,
} from "./trash-lifecycle.js";
import {
  legacyTrashDeletionSchema, legacyTrashFileSchema, legacyTrashImportPlanSchema,
  legacyTrashPurgeDefinitions, legacyTrashPurgeResultSchema, type LegacyTrashDeletion,
} from "./domain/legacy-trash-import-contracts.js";
import { removeTrashBucket } from "./trash-remove.js";
import {
  legacyTrashDocuments, legacyTrashImportSha256 as hash, legacyTrashStageReceiptPath, projectLegacyTrashPlans, qualifyLegacyTrashAuthority,
  snapshotLegacyTrashTree, trashImportAbsent, trashImportFail, trashImportRead, trashImportSync,
  validateLegacyTrashImportPlan, verifyLegacyTrashSource, verifyLegacyTrashStage,
  type LegacyTrashImportPlan, type LegacyTrashLayoutAuthority, type TrashImportSnapshot, type LegacyTrashSnapshotScope,
} from "./legacy-trash-import.js";

export const LEGACY_TRASH_IMPORT_DDL = `
CREATE TABLE IF NOT EXISTS legacy_trash_import_receipt (
 workspace_id TEXT PRIMARY KEY, root_path TEXT NOT NULL, receipt_json TEXT NOT NULL, digest TEXT NOT NULL
) STRICT;
CREATE TABLE IF NOT EXISTS legacy_trash_import_history (
 workspace_id TEXT PRIMARY KEY REFERENCES legacy_trash_import_receipt(workspace_id),
 original_bytes BLOB, original_sha256 TEXT, current_json TEXT NOT NULL, current_sha256 TEXT NOT NULL
) STRICT;
CREATE TABLE IF NOT EXISTS legacy_trash_import_restored (
 workspace_id TEXT NOT NULL REFERENCES legacy_trash_import_receipt(workspace_id),
 original_id TEXT NOT NULL, area TEXT NOT NULL, operation_id TEXT NOT NULL UNIQUE,
 request_json TEXT NOT NULL, digest TEXT NOT NULL,
 PRIMARY KEY(workspace_id,area,original_id)
) STRICT;`;
export function initializeLegacyTrashImport(database: DatabaseSync): void {
  if (!database.isTransaction) trashImportFail("TRANSACTION_REQUIRED", "Shared DDL ownership requires a transaction.");
  initializeMigrationRuntime(database);
  database.exec(LEGACY_TRASH_IMPORT_DDL);
}
const receiptSchema = z.strictObject({
  schema: z.literal("pkm.legacy-trash-adoption/v1"),
  original: legacyTrashImportPlanSchema,
  plans: z.array(z.string()),
  lineage: z.array(z.string().regex(/^[a-f0-9]{64}$/)),
});
export type LegacyTrashAdoptionReceipt = z.infer<typeof receiptSchema>;
export interface LegacyTrashNativeHost {
  database: DatabaseSync;
  root: string;
  workspaceId: string;
  /** External layout/import authority, not copied from the mutable DB being verified. */
  trustedImportPlanSha256: string;
  /** Exact independently trusted non-trash native roots skipped without traversing them. */
  snapshotScope?: LegacyTrashSnapshotScope;
  /** Same exclusive async writer used by every importer, runtime writer and backup. */
  withWriterLock<T>(work: () => Promise<T>): Promise<T>;
  /** Synchronous SQL only. The importer performs no filesystem IO in this callback. */
  transaction<T>(work: () => T): T;
  reconcileIndex(): void;
  assertOperationAvailable(operationId: string): void;
  /** Authenticated host policy. Absence denies every read and write. */
  authorize?(actorId: string, operation: "knowledge.trash.list" | "knowledge.trash.get" | "knowledge.trash.restore" | "knowledge.trash.delete" | "knowledge.trash.empty" | "knowledge.trash.backup" | "knowledge.trash.adopt"): boolean;
}
function outside(host: LegacyTrashNativeHost): void {
  if (host.database.isTransaction) trashImportFail("TRANSACTION_BOUNDARY", "Async preflight/effects must run outside SQL.");
  if (host.root !== resolve(host.root) || !host.workspaceId || !/^[a-f0-9]{64}$/.test(host.trustedImportPlanSha256)
    || typeof host.withWriterLock !== "function"
    || typeof host.transaction !== "function" || typeof host.reconcileIndex !== "function"
    || typeof host.assertOperationAvailable !== "function") trashImportFail("AUTHORITY_REQUIRED", "Explicit shared native ownership is required.");
}
export function authorizeLegacyTrashNative(host: LegacyTrashNativeHost, actor: string, operation: Parameters<NonNullable<LegacyTrashNativeHost["authorize"]>>[1]): void {
  outside(host);
  if (!actor || !host.authorize?.(actor, operation)) trashImportFail("ACCESS_DENIED", "Explicit authenticated native trash policy is required.");
}
function receiptDigest(workspace: string, root: string, json: string) { return hash(JSON.stringify([workspace, root, json])); }
type PurgeResult = z.infer<typeof legacyTrashPurgeResultSchema>;
const purgePlanSchema = z.strictObject({
  schema: z.literal("pkm.legacy-trash-purge/v1"),
  result: legacyTrashPurgeResultSchema,
  inventory: z.array(legacyTrashFileSchema),
});
function purgeDefinition(operation: string) {
  const definition = legacyTrashPurgeDefinitions.find(item => item.id === operation);
  if (!definition) trashImportFail("RECOVERY_CONFLICT", "Unknown permanent Trash operation.");
  return definition;
}
function purgeRequest(operation: string, actorId: string, result: PurgeResult) {
  const args = purgeDefinition(operation).input.parse({
    operationId: result.operationId, area: result.area,
    ...(result.action === "delete" ? { originalId: result.entries[0]?.originalId } : {}),
  });
  return { operation, actorId, args };
}
function validatePurgeResult(result: PurgeResult, operation: string, receipt: LegacyTrashAdoptionReceipt,
  database?: DatabaseSync, workspaceId?: string): void {
  if (result.action !== (operation === legacyTrashPurgeDefinitions[0].id ? "delete" : "empty")
    || result.count !== result.entries.length || result.action === "delete" && result.count !== 1
    || new Set(result.entries.map(item => item.runtimeEntryId)).size !== result.count) {
    trashImportFail("TAMPER", "Permanent Trash result has an inconsistent selection.");
  }
  for (const item of result.entries) {
    const entry = allTrashEntries(receipt, database, workspaceId).find(entry => entry.area === result.area && entry.originalId === item.originalId);
    if (!entry || item.runtimeEntryId !== entry.runtimeId || item.name !== entry.metadata.name
      || item.path !== entry.metadata.originalPath || item.kind !== entry.metadata.kind) {
      trashImportFail("TAMPER", "Permanent Trash result lost its original identity/metadata binding.");
    }
  }
}
export function readLegacyTrashPurgedIds(host: Pick<LegacyTrashNativeHost, "database">, receipt: LegacyTrashAdoptionReceipt): Set<string> {
  const ids = new Set<string>();
  const rows = host.database.prepare("SELECT * FROM receipts WHERE operation IN (?,?)")
    .all(...legacyTrashPurgeDefinitions.map(item => item.id));
  for (const row of rows) {
    const result = legacyTrashPurgeResultSchema.parse(JSON.parse(String(row.result)));
    validatePurgeResult(result, String(row.operation), receipt, host.database,
      String(host.database.prepare("SELECT workspace_id FROM legacy_trash_import_receipt").get()?.workspace_id));
    const request = purgeRequest(String(row.operation), String(row.actor_id), result);
    if (row.operation_id !== result.operationId || row.fingerprint !== hash(JSON.stringify(request))) {
      trashImportFail("TAMPER", "Permanent Trash receipt lost its immutable actor/request binding.");
    }
    for (const item of result.entries) {
      if (ids.has(item.runtimeEntryId)) trashImportFail("TAMPER", "A Trash entry has conflicting permanent deletion receipts.");
      ids.add(item.runtimeEntryId);
    }
  }
  return ids;
}
function allTrashEntries(receipt: LegacyTrashAdoptionReceipt, database?: DatabaseSync, workspaceId?: string) {
  const entries = [...receipt.original.entries];
  if (!database || !workspaceId) return entries;
  for (const plan of readNativeTrashOrigins(database, workspaceId).values()) {
    if (plan.area === "scripts" || plan.area === "prompts") continue;
    if (entries.some(entry => entry.runtimeId === plan.entryId)) trashImportFail("TAMPER", "Native Trash provenance collides with an imported original identity.");
    const bytes = trashLifecycleMetadata(plan);
    entries.push({
      ...receipt.original.entries[0]!, area: plan.area, originalId: plan.entryId, runtimeId: plan.entryId,
      metadata: JSON.parse(bytes.toString("utf8")), metadataBytes: bytes.toString("base64"),
      removedPaths: plan.moves.flatMap(move => move.entries.filter(entry => entry.kind === "file")
        .map(entry => `${plan.area}/${move.originalPath}${entry.path ? `/${entry.path}` : ""}`)),
    });
  }
  return entries;
}
export function readLegacyTrashAdoptionReceipt(host: LegacyTrashNativeHost): LegacyTrashAdoptionReceipt {
  const row = host.database.prepare("SELECT * FROM legacy_trash_import_receipt WHERE workspace_id=?").get(host.workspaceId);
  if (!row || row.root_path !== host.root || typeof row.receipt_json !== "string"
    || row.digest !== receiptDigest(host.workspaceId, host.root, row.receipt_json)) trashImportFail("TAMPER", "Imported trash receipt is not bound to this exact native workspace/root.");
  return validateLegacyTrashAdoptionReceipt(JSON.parse(row.receipt_json), host.trustedImportPlanSha256);
}
export function validateLegacyTrashAdoptionReceipt(value: unknown, trustedPlanSha256: string): LegacyTrashAdoptionReceipt {
  const receipt = receiptSchema.parse(value);
  validateLegacyTrashImportPlan(receipt.original);
  if (receipt.original.planSha256 !== trustedPlanSha256 || !/^[a-f0-9]{64}$/.test(trustedPlanSha256)) trashImportFail("TAMPER", "Original import proof differs from the externally trusted source/layout authority.");
  if (receipt.plans.length !== receipt.original.entries.length) trashImportFail("TAMPER", "Canonical projections do not cover the original history.");
  for (const [i, json] of receipt.plans.entries()) {
    const plan = deserializeTrashLifecyclePlan(json), entry = receipt.original.entries[i]!;
    if (plan.action !== "trash" || plan.entryId !== entry.runtimeId || plan.operationId !== entry.runtimeId
      || plan.path !== entry.metadata.originalPath || plan.area !== entry.area
      || plan.deletedAt !== new Date(entry.metadata.deletedAt).toISOString()
      || plan.targetKind !== (entry.metadata.kind === "folder" ? "folder" : "document")) {
      trashImportFail("TAMPER", "Canonical projection lost original deletion identity/path/time.");
    }
    const expected = [entry.metadata.assetsPath, entry.metadata.originalPath].filter((value): value is string => !!value);
    if (JSON.stringify(plan.moves.map(move => move.originalPath)) !== JSON.stringify(expected)) trashImportFail("TAMPER", "Original asset ownership changed.");
    for (const move of plan.moves) {
      const originalBase = `${entry.area}/.trash/${entry.originalId}/${move.slot}`;
      const original = receipt.original.inventory.filter(item => item.path === originalBase || item.path.startsWith(originalBase + "/"))
        .map(item => ({ path: item.path === originalBase ? "" : item.path.slice(originalBase.length + 1), kind: item.kind, size: item.size, sha256: item.sha256 }));
      const projection = move.entries.map(({ dev: _dev, ino: _ino, ...item }) => item);
      if (JSON.stringify(original) !== JSON.stringify(projection)) trashImportFail("TAMPER", "Canonical projection is not the original opaque content tree.");
    }
    const originalMetadata = Buffer.from(entry.metadataBytes, "base64");
    if (JSON.stringify(JSON.parse(originalMetadata.toString("utf8"))) !== JSON.stringify(entry.metadata)
      || hash(originalMetadata) !== receipt.original.inventory.find(item => item.path === `${entry.area}/.trash/${entry.originalId}/metadata.json`)?.sha256) {
      trashImportFail("TAMPER", "Opaque metadata history changed.");
    }
  }
  return receipt;
}
export function readLegacyTrashHistory(host: LegacyTrashNativeHost): { originalBytes: Buffer | null; current: LegacyTrashDeletion } {
  const receipt = readLegacyTrashAdoptionReceipt(host);
  const row = host.database.prepare("SELECT * FROM legacy_trash_import_history WHERE workspace_id=?").get(host.workspaceId);
  if (!row || typeof row.current_json !== "string" || row.current_sha256 !== hash(row.current_json)) trashImportFail("TAMPER", "Deletion state is not authenticated.");
  const originalBytes = row.original_bytes === null ? null : Buffer.from(row.original_bytes as Uint8Array);
  const expected = receipt.original.deletionBytes === null ? null : Buffer.from(receipt.original.deletionBytes, "base64");
  if (originalBytes === null ? expected !== null || row.original_sha256 !== null
    : expected === null || !originalBytes.equals(expected) || row.original_sha256 !== hash(originalBytes)) trashImportFail("TAMPER", "Original ordered opaque deletion journal changed.");
  const current = legacyTrashDeletionSchema.parse(JSON.parse(row.current_json));
  const original = expected ? legacyTrashDeletionSchema.parse(JSON.parse(expected.toString("utf8"))) : { schema: 1, records: [] };
  const restored = host.database.prepare("SELECT * FROM legacy_trash_import_restored WHERE workspace_id=? ORDER BY area,original_id").all(host.workspaceId);
  const removed = new Set<string>();
  for (const item of restored) {
    const entry = receipt.original.entries.find(entry => entry.area === item.area && entry.originalId === item.original_id);
    if (!entry || typeof item.operation_id !== "string") trashImportFail("TAMPER", "Unknown original restore history.");
    const result = host.database.prepare("SELECT actor_id,operation,result FROM receipts WHERE operation_id=?").get(item.operation_id);
    if (!result || result.operation !== "knowledge.trash.restore" || typeof result.result !== "string"
      || typeof item.request_json !== "string"
      || item.digest !== hash(JSON.stringify([host.workspaceId, entry.originalId, entry.area, item.operation_id, item.request_json]))) {
      trashImportFail("TAMPER", "Restore disposition lacks its real immutable native receipt/request.");
    }
    const output = trashLifecycleDefinitions[2].output.parse(JSON.parse(result.result));
    const request = JSON.parse(item.request_json);
    const args = trashLifecycleDefinitions[2].input.parse(request.args);
    const global = host.database.prepare("SELECT fingerprint FROM receipts WHERE operation_id=?").get(item.operation_id)!;
    if (request.operation !== result.operation || request.actorId !== result.actor_id
      || item.request_json !== JSON.stringify({ operation: "knowledge.trash.restore", actorId: result.actor_id, args })
      || global.fingerprint !== hash(item.request_json)
      || args.operationId !== item.operation_id || args.entryId !== entry.runtimeId
      || output.operationId !== item.operation_id || output.action !== "restore" || output.entryId !== entry.runtimeId
      || output.area !== entry.area || output.path !== entry.metadata.originalPath) {
      trashImportFail("TAMPER", "Restore receipt/request lost its original identity/path/actor binding.");
    }
    for (const path of entry.removedPaths) removed.add(path);
  }
  if (JSON.stringify(current.records) !== JSON.stringify(original.records.filter(record => !removed.has(record.path)))) {
    trashImportFail("TAMPER", "Current deletion state silently discarded or invented original history.");
  }
  const native = readOriginalTrashDeletionHistory(host.database, host.workspaceId);
  const nativePaths = new Set(native.records.map(record => record.path));
  return { originalBytes, current: { schema: 1, records: [
    ...current.records.filter(record => !nativePaths.has(record.path)), ...native.records,
  ] } };
}
async function verifyLegacyTrashNativeMarker(host: LegacyTrashNativeHost, receipt: LegacyTrashAdoptionReceipt): Promise<void> {
  if (!await trashImportAbsent(join(host.root, legacyTrashStageReceiptPath))) {
    try {
      const marker = JSON.parse((await trashImportRead(host.root, legacyTrashStageReceiptPath, 32 * 1024 * 1024)).toString("utf8"));
      const authority = qualifyLegacyTrashAuthority(receipt.original, host.root, marker.authority);
      if (authority.workspaceId !== host.workspaceId || JSON.stringify(marker) !== JSON.stringify({
        schema: "pkm.legacy-trash-stage/v1", authority, plan: receipt.original,
      })) trashImportFail("TAMPER", "Unrecognized original import marker/journal must be preserved without replay.");
    } catch { trashImportFail("TAMPER", "Unrecognized original import marker/journal must be preserved without replay."); }
  } else if (receipt.lineage.length === 0) trashImportFail("TAMPER", "Original adoption marker disappeared without an authenticated portable backup lineage.");
}
export async function inspectLegacyTrashNative(host: LegacyTrashNativeHost): Promise<{ receipt: LegacyTrashAdoptionReceipt; snapshot: TrashImportSnapshot }> {
  return inspectLegacyTrashNativeState(host);
}
async function inspectLegacyTrashNativeState(host: LegacyTrashNativeHost, pendingPurge?: PurgeResult): Promise<{ receipt: LegacyTrashAdoptionReceipt; snapshot: TrashImportSnapshot }> {
  outside(host);
  const pending = host.database.prepare("SELECT operation_id FROM migration_runtime_intents").all();
  if (pending.some(row => row.operation_id !== pendingPurge?.operationId)) {
    trashImportFail("PENDING_NATIVE_INTENT", "Native pending operations require separately qualified exact recovery.");
  }
  const receipt = readLegacyTrashAdoptionReceipt(host);
  readLegacyTrashHistory(host);
  await verifyLegacyTrashNativeMarker(host, receipt);
  const snapshot = await snapshotLegacyTrashTree(host.root, true, host.snapshotScope);
  const rows = host.database.prepare("SELECT * FROM migration_runtime_trash ORDER BY entry_id").all();
  const purged = readLegacyTrashPurgedIds(host, receipt);
  const nativeOrigins = readNativeTrashOrigins(host.database, host.workspaceId);
  for (const row of host.database.prepare("SELECT result FROM receipts WHERE operation='knowledge.trash.move'").all()) {
    const result = trashLifecycleDefinitions[1].output.parse(JSON.parse(String(row.result)));
    if (!nativeOrigins.has(result.entryId)) {
      trashImportFail("TAMPER", "A later native Trash move receipt lost its immutable provenance, even after restore or permanent deletion.");
    }
  }
  for (const origin of nativeOrigins.values()) {
    const restored = host.database.prepare("SELECT * FROM receipts WHERE operation='knowledge.trash.restore'").all()
      .filter(row => {
        const result = trashLifecycleDefinitions[2].output.parse(JSON.parse(String(row.result)));
        return result.entryId === origin.entryId;
      });
    for (const row of restored) {
      const result = trashLifecycleDefinitions[2].output.parse(JSON.parse(String(row.result)));
      const provenance = host.database.prepare("SELECT * FROM migration_runtime_trash_restores WHERE entry_id=?").get(origin.entryId);
      const request = provenance ? JSON.parse(String(provenance.request_json)) : null;
      const args = request ? trashLifecycleDefinitions[2].input.parse(request.args) : null;
      if (row.operation_id !== result.operationId || result.action !== "restore"
        || result.area !== origin.area || result.path !== origin.path || !provenance
        || provenance.workspace_id !== host.workspaceId || provenance.operation_id !== row.operation_id
        || provenance.digest !== hash(JSON.stringify([origin.entryId, host.workspaceId, row.operation_id, provenance.request_json]))
        || !request || !args || request.operation !== "knowledge.trash.restore" || request.actorId !== row.actor_id
        || args.entryId !== origin.entryId || args.operationId !== row.operation_id
        || provenance.request_json !== JSON.stringify({ operation: request.operation, actorId: request.actorId, args })
        || row.fingerprint !== hash(String(provenance.request_json))) {
        trashImportFail("TAMPER", "Native Trash restore disposition lost its exact entry/path receipt.");
      }
    }
    if (Number(rows.some(row => row.entry_id === origin.entryId)) + restored.length + Number(purged.has(origin.entryId)) !== 1) {
      trashImportFail("TAMPER", "Every native Trash origin needs exactly one current trash/restore/permanent-delete disposition.");
    }
  }
  const purging = new Set(pendingPurge?.entries.map(item => item.runtimeEntryId));
  const original = new Map(receipt.plans.map(json => [deserializeTrashLifecyclePlan(json).entryId, json]));
  for (const row of rows) {
    if (!original.has(String(row.entry_id))) {
      if (!nativeOrigins.has(String(row.entry_id))) trashImportFail("TAMPER", "A later native Trash row requires separate immutable provenance; receipt membership cannot be inferred.");
      const plan = assertNativeTrashRow(host.database, host.workspaceId, host.root, row, nativeOrigins);
      if (!purging.has(plan.entryId)) inspectTrashLifecycleEntry(host.root, plan);
      continue;
    }
    if (typeof row.entry_id !== "string" || row.workspace_id !== host.workspaceId || row.root_path !== host.root
      || row.plan_json !== original.get(row.entry_id) || row.digest !== hash(JSON.stringify([row.entry_id, row.workspace_id, row.root_path, row.plan_json]))) {
      trashImportFail("TAMPER", "Unknown/colliding native trash rows are not owned by this import receipt.");
    }
    if (!purging.has(row.entry_id)) inspectTrashLifecycleEntry(host.root, deserializeTrashLifecyclePlan(String(row.plan_json)));
  }
  const restoring = host.database.prepare("SELECT area,original_id FROM legacy_trash_import_restored WHERE workspace_id=?").all(host.workspaceId);
  for (const entry of receipt.original.entries) {
    const present = rows.some(row => row.entry_id === entry.runtimeId);
    const restored = restoring.some(row => row.area === entry.area && row.original_id === entry.originalId);
    if (Number(present) + Number(restored) + Number(purged.has(entry.runtimeId)) !== 1) {
      trashImportFail("TAMPER", "Every original entry must have exactly one trash, restore or permanent deletion disposition.");
    }
  }
  const knownBuckets = new Set(rows.map(row => `${deserializeTrashLifecyclePlan(String(row.plan_json)).area}/.trash/${row.entry_id}`));
  if (snapshot.inventory.some(item => item.path.includes("/.trash/") && ![...knownBuckets].some(base => item.path === base || item.path.startsWith(base + "/")))) {
    trashImportFail("UNKNOWN_BUCKET", "Unknown native trash buckets must not be ignored.");
  }
  return { receipt, snapshot };
}
export async function adoptLegacyTrashImport(
  host: LegacyTrashNativeHost, value: LegacyTrashImportPlan, authority?: LegacyTrashLayoutAuthority,
): Promise<LegacyTrashAdoptionReceipt> {
  outside(host);
  const plan = validateLegacyTrashImportPlan(value), trusted = qualifyLegacyTrashAuthority(plan, host.root, authority);
  if (trusted.workspaceId !== host.workspaceId || host.trustedImportPlanSha256 !== plan.planSha256) trashImportFail("AUTHORITY_REQUIRED", "Native workspace/import pin differs from trusted adoption authority.");
  authorizeLegacyTrashNative(host, trusted.actorId, "knowledge.trash.adopt");
  return host.withWriterLock(async () => {
    outside(host);
    if (!await trashImportAbsent(trusted.stage)) trashImportFail("RECOVERY_CONFLICT", "Publish the exact exclusive stage before adoption.");
    await verifyLegacyTrashSource(plan);
    const snapshot = await verifyLegacyTrashStage(plan, host.root, trusted, host.snapshotScope);
    const plans = await projectLegacyTrashPlans(plan, snapshot, trusted.actorId);
    // Preflight every filesystem/reference/identity fence before any DDL or SQL publication.
    for (const native of plans) {
      inspectTrashLifecycleEntry(host.root, native);
      if (inspectTrashLifecycleRecovery(host.root, native) !== native.moves.length) trashImportFail("RECOVERY_CONFLICT", "Only fully committed original trash state is adoptable.");
    }
    const receipt: LegacyTrashAdoptionReceipt = { schema: "pkm.legacy-trash-adoption/v1", original: plan,
      plans: plans.map(serializeTrashLifecyclePlan), lineage: [] };
    const json = JSON.stringify(receipt), originalBytes = plan.deletionBytes === null ? null : Buffer.from(plan.deletionBytes, "base64");
    const currentJson = JSON.stringify(originalBytes ? legacyTrashDeletionSchema.parse(JSON.parse(originalBytes.toString("utf8"))) : { schema: 1, records: [] });
    return host.transaction(() => {
      initializeLegacyTrashImport(host.database);
      if (host.database.prepare("SELECT 1 FROM legacy_trash_import_receipt").get()
        || host.database.prepare("SELECT 1 FROM migration_runtime_trash").get()
        || host.database.prepare("SELECT 1 FROM migration_runtime_intents").get()) trashImportFail("COLLISION", "Existing native/import state is never overwritten or inferred.");
      for (const native of plans) {
        host.assertOperationAvailable(native.entryId);
        if (host.database.prepare("SELECT 1 FROM receipts WHERE operation_id=?").get(native.entryId)) trashImportFail("COLLISION", "Original projection collides with a global operation.");
      }
      host.database.prepare("INSERT INTO legacy_trash_import_receipt VALUES(?,?,?,?)").run(host.workspaceId, host.root, json, receiptDigest(host.workspaceId, host.root, json));
      host.database.prepare("INSERT INTO legacy_trash_import_history VALUES(?,?,?,?,?)").run(host.workspaceId, originalBytes, originalBytes ? hash(originalBytes) : null, currentJson, hash(currentJson));
      for (const native of plans) {
        const binding = [native.entryId, host.workspaceId, host.root, serializeTrashLifecyclePlan(native)];
        host.database.prepare("INSERT INTO migration_runtime_trash VALUES(?,?,?,?,?)").run(...binding, hash(JSON.stringify(binding)));
      }
      return receipt;
    });
  });
}
/** Adopted Trash restore and permanent deletion under the shared native writer.
 * The host supplies its real transaction/index/policy; no implicit production grant. */
export class LegacyTrashNativeAccess {
  private readonly runtime: MigrationRuntime;
  private committing?: { originalId: string; area: string; operationId: string; requestJson: string };
  private planning?: TrashLifecyclePlan;
  constructor(private readonly host: LegacyTrashNativeHost) {
    outside(host);
    this.runtime = new MigrationRuntime({
      database: host.database, root: host.root, workspaceId: host.workspaceId,
      transaction: work => {
        if (!this.planning) return host.transaction(work);
        // This adapter exposes only restore. Its first callback is the native read-only
        // planner; execute it under the writer, outside SQL, against exact prior preflight.
        const expected = this.planning;
        this.planning = undefined;
        const result = work();
        if (serializeTrashLifecyclePlan(result as TrashLifecyclePlan) !== serializeTrashLifecyclePlan(expected)) {
          trashImportFail("RECOVERY_CONFLICT", "Native read-only planner changed its preflight restore binding.");
        }
        return result;
      },
      assertOperationAvailable: host.assertOperationAvailable, trash: { layoutVersion: "pkm.trash-lifecycle/v1" },
      reconcileIndex: () => {
        if (!host.database.isTransaction) trashImportFail("TRANSACTION_REQUIRED", "Original history reconciliation requires the exact native restore transaction.");
        if (!this.committing) { host.reconcileIndex(); return; }
        const receipt = readLegacyTrashAdoptionReceipt(host);
        const entry = receipt.original.entries.find(entry => entry.originalId === this.committing!.originalId && entry.area === this.committing!.area)!;
        const row = host.database.prepare("SELECT current_json FROM legacy_trash_import_history WHERE workspace_id=?").get(host.workspaceId)!;
        const current = legacyTrashDeletionSchema.parse(JSON.parse(String(row.current_json)));
        const paths = new Set(entry.removedPaths);
        const json = JSON.stringify({ schema: 1, records: current.records.filter(record => !paths.has(record.path)) });
        host.reconcileIndex();
        host.database.prepare("UPDATE legacy_trash_import_history SET current_json=?,current_sha256=? WHERE workspace_id=?").run(json, hash(json), host.workspaceId);
        const binding = [host.workspaceId, entry.originalId, entry.area, this.committing.operationId, this.committing.requestJson];
        host.database.prepare("INSERT INTO legacy_trash_import_restored VALUES(?,?,?,?,?,?)")
          .run(...binding, hash(JSON.stringify(binding)));
      },
    });
  }
  async list(actorId: string) {
    authorizeLegacyTrashNative(this.host, actorId, "knowledge.trash.list");
    return this.host.withWriterLock(async () => {
      const { receipt } = await inspectLegacyTrashNative(this.host);
      const ids = new Set(this.host.database.prepare("SELECT entry_id FROM migration_runtime_trash").all().map(row => row.entry_id));
      return allTrashEntries(receipt, this.host.database, this.host.workspaceId).filter(entry => ids.has(entry.runtimeId))
        .map(entry => ({ area: entry.area, ...entry.metadata, runtimeEntryId: entry.runtimeId }))
        .sort((a, b) => b.deletedAt.localeCompare(a.deletedAt));
    });
  }
  async get(actorId: string, area: string, originalId: string) {
    authorizeLegacyTrashNative(this.host, actorId, "knowledge.trash.get");
    return this.host.withWriterLock(async () => {
      const { receipt, snapshot } = await inspectLegacyTrashNative(this.host);
      const entry = allTrashEntries(receipt, this.host.database, this.host.workspaceId).find(entry => entry.area === area && entry.originalId === originalId);
      if (!entry || !this.host.database.prepare("SELECT 1 FROM migration_runtime_trash WHERE entry_id=?").get(entry.runtimeId)) {
        trashImportFail("NOT_FOUND", "Original authoritative trash entry is not currently trashed.");
      }
      const base = `${area}/.trash/${entry.runtimeId}`;
      return { entry: { area, ...entry.metadata, runtimeEntryId: entry.runtimeId },
        metadataBytes: Buffer.from(entry.metadataBytes, "base64"), deletionHistory: readLegacyTrashHistory(this.host),
        files: [...snapshot.files].filter(([path]) => path.startsWith(base + "/") && path !== base + "/metadata.json")
          .map(([path, bytes]) => ({ path: path.slice(base.length + 1), bytes: Buffer.from(bytes) })) };
    });
  }
  async restore(actorId: string, area: string, originalId: string, operationId: string): Promise<unknown> {
    authorizeLegacyTrashNative(this.host, actorId, "knowledge.trash.restore");
    if (!z.uuid().safeParse(operationId).success) trashImportFail("INVALID_ARGUMENT", "Exact native UUID restore operation required.");
    return this.host.withWriterLock(async () => {
      const { receipt, snapshot } = await inspectLegacyTrashNative(this.host);
      const entry = receipt.original.entries.find(entry => entry.area === area && entry.originalId === originalId);
      if (!entry) {
        const origin = readNativeTrashOrigins(this.host.database, this.host.workspaceId).get(originalId);
        if (!origin || origin.area !== area) trashImportFail("NOT_FOUND", "Unknown original/native trash identity.");
        const prior = this.host.database.prepare("SELECT * FROM migration_runtime_trash_restores WHERE entry_id=?").get(originalId);
        if (prior) {
          const request = JSON.parse(String(prior.request_json));
          if (prior.operation_id !== operationId || request.actorId !== actorId) {
            trashImportFail("CONFLICT", "Native Trash restore already belongs to a different immutable operation/actor.");
          }
          return this.runtime.mutate(request);
        }
        const active = await projectLegacyTrashPlansForActive(snapshot);
        const request = { operation: "knowledge.trash.restore", actorId, args: {
          operationId, entryId: originalId, expectedScanRevision: hash(JSON.stringify(active)),
        } };
        const row = this.host.database.prepare("SELECT * FROM migration_runtime_trash WHERE entry_id=?").get(originalId);
        if (!row) trashImportFail("NOT_FOUND", "Native Trash entry is not currently trashed.");
        const plan = assertNativeTrashRow(this.host.database, this.host.workspaceId, this.host.root, row);
        this.planning = planTrashRestore(this.host.root, actorId, plan, request.args);
        try { return await this.runtime.mutate(request); }
        finally { this.planning = undefined; }
      }
      if (readLegacyTrashPurgedIds(this.host, receipt).has(entry.runtimeId)) trashImportFail("NOT_FOUND", "Original Trash entry was permanently deleted.");
      const prior = this.host.database.prepare("SELECT operation_id FROM legacy_trash_import_restored WHERE workspace_id=? AND area=? AND original_id=?")
        .get(this.host.workspaceId, area, originalId);
      if (prior && prior.operation_id !== operationId) trashImportFail("CONFLICT", "Original deletion already has a different immutable restore.");
      const active = await projectLegacyTrashPlansForActive(snapshot);
      const args = { operationId, entryId: entry.runtimeId, expectedScanRevision: hash(JSON.stringify(active)) };
      const request = { operation: "knowledge.trash.restore", actorId, args };
      this.committing = { area, originalId, operationId, requestJson: JSON.stringify(request) };
      try {
        if (prior) {
          const row = this.host.database.prepare("SELECT actor_id,operation,result FROM receipts WHERE operation_id=?").get(operationId);
          if (!row || row.actor_id !== actorId || row.operation !== "knowledge.trash.restore") trashImportFail("CONFLICT", "Restore receipt belongs to a different actor/operation.");
          return trashLifecycleDefinitions[2].output.parse(JSON.parse(String(row.result)));
        }
        await this.runtime.inspectRecovery();
        const original = deserializeTrashLifecyclePlan(receipt.plans.find(json => deserializeTrashLifecyclePlan(json).entryId === entry.runtimeId)!);
        this.planning = planTrashRestore(this.host.root, actorId, original, args);
        return await this.runtime.mutate(request);
      } finally { this.committing = undefined; this.planning = undefined; }
    });
  }
  async purge(actorId: string, operation: string, value: unknown): Promise<PurgeResult> {
    const definition = purgeDefinition(operation);
    const args = definition.input.parse(value);
    const policy = operation === legacyTrashPurgeDefinitions[0].id ? "knowledge.trash.delete" : "knowledge.trash.empty";
    authorizeLegacyTrashNative(this.host, actorId, policy);
    return this.host.withWriterLock(async () => {
      const request = { operation, actorId, args };
      const fingerprint = hash(JSON.stringify(request));
      const prior = this.host.database.prepare("SELECT * FROM receipts WHERE operation_id=?").get(args.operationId);
      if (prior) {
        if (prior.operation !== operation || prior.actor_id !== actorId || prior.fingerprint !== fingerprint) {
          trashImportFail("CONFLICT", "Permanent Trash operationId belongs to a different request/actor.");
        }
        await inspectLegacyTrashNative(this.host);
        return definition.output.parse(JSON.parse(String(prior.result)));
      }
      const pending = this.host.database.prepare("SELECT * FROM migration_runtime_intents WHERE operation_id=?").get(args.operationId);
      if (pending) {
        if (pending.request_json !== JSON.stringify(request)) trashImportFail("CONFLICT", "Pending permanent Trash request/actor differs.");
        return this.recoverPurge(actorId);
      }
      const { receipt, snapshot } = await inspectLegacyTrashNative(this.host);
      const activeIds = new Set(this.host.database.prepare("SELECT entry_id FROM migration_runtime_trash").all().map(row => row.entry_id));
      const entries = allTrashEntries(receipt, this.host.database, this.host.workspaceId).filter(entry => entry.area === args.area && activeIds.has(entry.runtimeId)
        && (!("originalId" in args) || entry.originalId === args.originalId));
      if ("originalId" in args && entries.length !== 1) trashImportFail("NOT_FOUND", "Original Trash entry is not currently trashed.");
      const result: PurgeResult = {
        ok: true, operationId: args.operationId, action: "originalId" in args ? "delete" : "empty",
        area: args.area, count: entries.length,
        entries: entries.map(entry => ({ originalId: entry.originalId, runtimeEntryId: entry.runtimeId,
          name: entry.metadata.name, path: entry.metadata.originalPath, kind: entry.metadata.kind })),
      };
      const bases = entries.map(entry => `${entry.area}/.trash/${entry.runtimeId}`);
      const plan = purgePlanSchema.parse({
        schema: "pkm.legacy-trash-purge/v1", result,
        inventory: snapshot.inventory.filter(item => bases.some(base => item.path === base || item.path.startsWith(base + "/"))),
      });
      this.host.transaction(() => {
        this.host.assertOperationAvailable(args.operationId);
        const binding = [args.operationId, this.host.workspaceId, this.host.root, actorId, operation,
          fingerprint, JSON.stringify(request), JSON.stringify(plan)];
        this.host.database.prepare("INSERT INTO migration_runtime_intents VALUES(?,?,?,?,?,?,?,?,?)")
          .run(...binding, hash(JSON.stringify(binding)));
      });
      return this.recoverPurge(actorId);
    });
  }
  private async recoverPurge(actorId: string): Promise<PurgeResult> {
    outside(this.host);
    const rows = this.host.database.prepare("SELECT * FROM migration_runtime_intents").all();
    if (rows.length !== 1) trashImportFail("RECOVERY_CONFLICT", "Permanent Trash recovery requires exactly one recognized intent.");
    const row = rows[0]!;
    const definition = purgeDefinition(String(row.operation));
    authorizeLegacyTrashNative(this.host, actorId,
      definition.id === legacyTrashPurgeDefinitions[0].id ? "knowledge.trash.delete" : "knowledge.trash.empty");
    const plan = purgePlanSchema.parse(JSON.parse(String(row.plan_json)));
    const receipt = readLegacyTrashAdoptionReceipt(this.host);
    validatePurgeResult(plan.result, definition.id, receipt, this.host.database, this.host.workspaceId);
    const request = purgeRequest(definition.id, actorId, plan.result);
    const binding = [row.operation_id, row.workspace_id, row.root_path, row.actor_id, row.operation,
      row.fingerprint, row.request_json, row.plan_json];
    if (row.operation_id !== plan.result.operationId || row.workspace_id !== this.host.workspaceId
      || row.root_path !== this.host.root || row.actor_id !== actorId
      || row.request_json !== JSON.stringify(request) || row.fingerprint !== hash(JSON.stringify(request))
      || row.digest !== hash(JSON.stringify(binding))
      || this.host.database.prepare("SELECT 1 FROM receipts WHERE operation_id=?").get(plan.result.operationId)) {
      trashImportFail("RECOVERY_CONFLICT", "Permanent Trash intent lost its immutable workspace/request/actor binding.");
    }
    const selectedIds = new Set(plan.result.entries.map(item => item.runtimeEntryId));
    const active = this.host.database.prepare("SELECT entry_id,plan_json FROM migration_runtime_trash").all();
    const expectedIds = active.filter(item => {
      const original = deserializeTrashLifecyclePlan(String(item.plan_json));
      return original.area === plan.result.area && (plan.result.action === "empty" || selectedIds.has(String(item.entry_id)));
    }).map(item => String(item.entry_id));
    if (expectedIds.length !== selectedIds.size || expectedIds.some(id => !selectedIds.has(id))) {
      trashImportFail("RECOVERY_CONFLICT", "Permanent Trash selection changed after intent publication.");
    }
    const { snapshot } = await inspectLegacyTrashNativeState(this.host, plan.result);
    const bases = plan.result.entries.map(entry => `${plan.result.area}/.trash/${entry.runtimeEntryId}`);
    const selected = (path: string) => bases.some(base => path === base || path.startsWith(base + "/"));
    if (plan.inventory.some(item => !selected(item.path))
      || new Set(plan.inventory.map(item => item.path)).size !== plan.inventory.length
      || bases.some(base => !plan.inventory.some(item => item.path === base && item.kind === "directory"))) {
      trashImportFail("RECOVERY_CONFLICT", "Permanent Trash inventory escaped its exact selected buckets.");
    }
    for (const item of snapshot.inventory.filter(item => selected(item.path))) {
      const expected = plan.inventory.find(pin => pin.path === item.path);
      if (!expected || JSON.stringify(expected) !== JSON.stringify(item)) {
        trashImportFail("RECOVERY_CONFLICT", "Remaining Trash bytes or identity changed; preserve them without deletion.");
      }
    }
    try {
      for (const base of bases) await removeTrashBucket(join(this.host.root, base));
    } catch (error) {
      if (!(error instanceof Error) || !("code" in error) || typeof error.code !== "string") throw error;
      trashImportFail("TRASH_DELETE_FAILED",
        `Trash removal failed (${error.code}); operation ${plan.result.operationId} remains pending. Release file locks and retry the identical request or use authorized recovery.`);
    }
    // Windows does not provide portable directory fsync through Node. Do not mask
    // Windows access/sharing errors or claim Linux directory-durability guarantees.
    if (process.platform !== "win32" && bases.length) await trashImportSync(join(this.host.root, plan.result.area, ".trash"));
    for (const base of bases) {
      if (!await trashImportAbsent(join(this.host.root, base))) trashImportFail("RECOVERY_CONFLICT", "Permanent Trash deletion did not finish.");
    }
    this.host.transaction(() => {
      const current = this.host.database.prepare("SELECT digest FROM migration_runtime_intents WHERE operation_id=?").get(row.operation_id!);
      if (current?.digest !== row.digest) trashImportFail("RECOVERY_CONFLICT", "Permanent Trash intent changed before publication.");
      for (const entry of plan.result.entries) {
        this.host.database.prepare("DELETE FROM migration_runtime_trash WHERE entry_id=?").run(entry.runtimeEntryId);
      }
      this.host.database.prepare("INSERT INTO receipts VALUES(?,?,?,?,?,?)")
        .run(row.operation_id!, row.fingerprint!, JSON.stringify(plan.result), actorId, definition.id, new Date().toISOString());
      this.host.database.prepare("DELETE FROM migration_runtime_intents WHERE operation_id=?").run(row.operation_id!);
    });
    await inspectLegacyTrashNative(this.host);
    return plan.result;
  }
  async recover(actorId: string): Promise<void> {
    outside(this.host);
    return this.host.withWriterLock(async () => {
      const pending = this.host.database.prepare("SELECT operation FROM migration_runtime_intents").get();
      if (legacyTrashPurgeDefinitions.some(item => item.id === pending?.operation)) {
        await this.recoverPurge(actorId);
        return;
      }
      authorizeLegacyTrashNative(this.host, actorId, "knowledge.trash.restore");
      const receipt = readLegacyTrashAdoptionReceipt(this.host);
      readLegacyTrashHistory(this.host);
      await verifyLegacyTrashNativeMarker(this.host, receipt);
      const rows = this.host.database.prepare("SELECT * FROM migration_runtime_intents").all();
      if (rows.length !== 1) trashImportFail("RECOVERY_CONFLICT", "Recovery requires one exactly recognized immutable native restore intent.");
      const row = rows[0]!;
      if (row.actor_id !== actorId || row.operation !== "knowledge.trash.restore" || typeof row.plan_json !== "string") {
        trashImportFail("RECOVERY_CONFLICT", "Unknown original/native pending operation is never replayed.");
      }
      const plan = deserializeTrashLifecyclePlan(row.plan_json);
      const entry = receipt.original.entries.find(entry => entry.runtimeId === plan.entryId);
      const originalJson = receipt.plans.find(json => deserializeTrashLifecyclePlan(json).entryId === plan.entryId);
      if (!entry || !originalJson || plan.action !== "restore") trashImportFail("RECOVERY_CONFLICT", "Pending restore does not own an imported original deletion.");
      const original = deserializeTrashLifecyclePlan(originalJson);
      if (serializeTrashLifecyclePlan({ ...original, action: "restore", operationId: plan.operationId,
        actorId: plan.actorId, referencePins: plan.referencePins, expectedScanRevision: plan.expectedScanRevision }) !== row.plan_json) {
        trashImportFail("RECOVERY_CONFLICT", "Pending restore changed its original projection.");
      }
      await snapshotLegacyTrashTree(this.host.root, true, this.host.snapshotScope);
      // Native inspection validates all rows, immutable request bindings, paired prefixes,
      // content/inode/reference fences and every unknown bucket before any replay.
      await this.runtime.inspectRecovery();
      this.committing = { area: entry.area, originalId: entry.originalId, operationId: plan.operationId, requestJson: String(row.request_json) };
      try { await this.runtime.recover(); } finally { this.committing = undefined; }
      await inspectLegacyTrashNative(this.host);
    });
  }
  close(): void { this.runtime.close(); }
}
async function projectLegacyTrashPlansForActive(snapshot: TrashImportSnapshot) {
  // Reuse the translator's source-grounded identity decoder, with no trash ownership.
  return legacyTrashDocuments({ inventory: snapshot.inventory.filter(item => !item.path.includes("/.trash/")), files: snapshot.files }, [])
    .map(doc => ({ id: doc.record.id, area: doc.record.area, path: doc.record.path, revision: doc.record.revision, sha256: doc.record.sha256 }))
    .sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
}
/** Backup restore only: authenticated portable plans are re-pinned to copied inodes/root,
 * never reinterpreted as new original deletion events. Called before SQL, under the same writer. */
export async function rebindLegacyTrashBackup(
  host: LegacyTrashNativeHost, expectedReceipt: LegacyTrashAdoptionReceipt, backupSha256: string,
): Promise<void> {
  outside(host);
  validateLegacyTrashAdoptionReceipt(expectedReceipt, host.trustedImportPlanSha256);
  const snapshot = await snapshotLegacyTrashTree(host.root, true, host.snapshotScope);
  const row = host.database.prepare("SELECT * FROM legacy_trash_import_receipt WHERE workspace_id=?").get(host.workspaceId);
  const oldRoot = String(row?.root_path), oldJson = JSON.stringify(expectedReceipt);
  if (!row || row.receipt_json !== oldJson || row.digest !== receiptDigest(host.workspaceId, oldRoot, oldJson)
    || !/^[a-f0-9]{64}$/.test(backupSha256)) trashImportFail("TAMPER", "Backup DB receipt does not match authenticated portable lineage.");
  const plans: TrashLifecyclePlan[] = [];
  const existing = host.database.prepare("SELECT * FROM migration_runtime_trash ORDER BY entry_id").all();
  const purged = readLegacyTrashPurgedIds(host, expectedReceipt);
  for (const json of expectedReceipt.plans) {
    const old = deserializeTrashLifecyclePlan(json);
    const nativeRow = existing.find(row => row.entry_id === old.entryId);
    if (nativeRow && (nativeRow.plan_json !== json || nativeRow.root_path !== oldRoot || nativeRow.workspace_id !== host.workspaceId
      || nativeRow.digest !== hash(JSON.stringify([old.entryId, host.workspaceId, oldRoot, json])))) trashImportFail("TAMPER", "Backup native row binding changed.");
    const restored = host.database.prepare("SELECT 1 FROM legacy_trash_import_restored WHERE workspace_id=? AND area=? AND original_id=?")
      .get(host.workspaceId, old.area, expectedReceipt.original.entries.find(entry => entry.runtimeId === old.entryId)!.originalId);
    if (Number(!!nativeRow) + Number(!!restored) + Number(purged.has(old.entryId)) !== 1) trashImportFail("TAMPER", "Backup trash/restore/delete disposition is ambiguous.");
    if (purged.has(old.entryId)) {
      plans.push(old);
      continue;
    }
    if (restored && (nativeTrashSupersedesImportedPlan(host.database, host.workspaceId, old)
      || nativeKnowledgeSupersedesImportedPlan(host.database, host.workspaceId, old, snapshot.inventory))) {
      plans.push(old);
      continue;
    }
    const moves = old.moves.map(move => {
      const base = nativeRow ? `${old.area}/.trash/${old.entryId}/${move.slot}` : `${old.area}/${move.originalPath}`;
      const entries = snapshot.inventory.filter(item => item.path === base || item.path.startsWith(base + "/")).map(item => ({
        path: item.path === base ? "" : item.path.slice(base.length + 1), kind: item.kind, size: item.size, sha256: item.sha256, dev: item.dev, ino: item.ino,
      }));
      const portable = (items: typeof entries) => items.map(({ dev: _dev, ino: _ino, ...item }) => item);
      if (JSON.stringify(portable(entries)) !== JSON.stringify(portable(move.entries))) trashImportFail("TAMPER", "Restored backup content differs from authenticated original projection.");
      return { ...move, entries: entries.map(({ path, kind, dev, ino, size, sha256 }) => ({ path, kind, dev, ino, size, sha256 })) };
    });
    const native = deserializeTrashLifecyclePlan(serializeTrashLifecyclePlan({ ...old, moves, expectedTreeSha256: hash(JSON.stringify(moves)) }));
    if (nativeRow) inspectTrashLifecycleEntry(host.root, native);
    plans.push(native);
  }
  for (const row of existing.filter(row => !plans.some(plan => plan.entryId === row.entry_id))) {
    if (!readNativeTrashOrigins(host.database, host.workspaceId).has(String(row.entry_id))) {
      trashImportFail("TAMPER", "A copied later native Trash row has no immutable provenance.");
    }
    const old = assertNativeTrashRow(host.database, host.workspaceId, oldRoot, row);
    const native = repinTrashLifecycleBackup(host.root, old);
    inspectTrashLifecycleEntry(host.root, native);
    plans.push(native);
  }
  if (host.database.prepare("SELECT 1 FROM migration_runtime_intents").get()) trashImportFail("UNKNOWN_BUCKET", "Backup contains pending native state.");
  const receipt = { ...expectedReceipt, plans: plans.slice(0, expectedReceipt.plans.length).map(serializeTrashLifecyclePlan),
    lineage: expectedReceipt.lineage.at(-1) === backupSha256 ? expectedReceipt.lineage : [...expectedReceipt.lineage, backupSha256] };
  const json = JSON.stringify(receipt);
  host.transaction(() => {
    host.database.prepare("UPDATE legacy_trash_import_receipt SET root_path=?,receipt_json=?,digest=? WHERE workspace_id=?")
      .run(host.root, json, receiptDigest(host.workspaceId, host.root, json), host.workspaceId);
    for (const native of plans.filter(plan => existing.some(row => row.entry_id === plan.entryId))) {
      const planJson = serializeTrashLifecyclePlan(native);
      host.database.prepare("UPDATE migration_runtime_trash SET root_path=?,plan_json=?,digest=? WHERE entry_id=?")
        .run(host.root, planJson, hash(JSON.stringify([native.entryId, host.workspaceId, host.root, planJson])), native.entryId);
    }
  });
  await inspectLegacyTrashNative(host);
}
