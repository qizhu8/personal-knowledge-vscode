import { lstatSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { z } from "zod";
import { CoreError } from "./contracts.js";
import type { DataRuntimeRequest } from "./data-runtime.js";
import { sha256 } from "./file-write.js";
import {
  applyKnowledgeMutation, assertKnowledgeMutationRequestPlan, deserializeKnowledgeMutationPlan, inspectKnowledgeMutationRecovery,
  knowledgeMutationDefinitions, planKnowledgeMutation, recoverKnowledgeMutation,
  serializeKnowledgeMutationPlan, type KnowledgeMutationRequest,
} from "./knowledge-mutations.js";
import {
  deserializeTrashLifecyclePlan, executeTrashLifecycle, inspectTrashLifecycleEntry, inspectTrashLifecycleRecovery,
  planTrashLifecycle, planTrashRestore, previewTrashLifecycle, repinTrashLifecycleBackup, serializeTrashLifecyclePlan,
  trashLifecycleDefinitions, trashLifecycleLayout, type TrashLifecycleHost, type TrashLifecyclePlan,
} from "./trash-lifecycle.js";
import { trashEntryId } from "./trash-lifecycle-contracts.js";
import { knowledgeArea, resourcePath } from "./document-path.js";

export const migrationRuntimeDefinitions = [...knowledgeMutationDefinitions, ...trashLifecycleDefinitions];
export const MIGRATION_RUNTIME_DDL = `
CREATE TABLE IF NOT EXISTS migration_runtime_intents (
 operation_id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL, root_path TEXT NOT NULL,
 actor_id TEXT NOT NULL, operation TEXT NOT NULL, fingerprint TEXT NOT NULL,
 request_json TEXT NOT NULL, plan_json TEXT NOT NULL, digest TEXT NOT NULL
) STRICT;
CREATE TABLE IF NOT EXISTS migration_runtime_trash (
 entry_id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL, root_path TEXT NOT NULL,
 plan_json TEXT NOT NULL, digest TEXT NOT NULL
) STRICT;
CREATE TABLE IF NOT EXISTS migration_runtime_deletions (
 sequence INTEGER PRIMARY KEY, workspace_id TEXT NOT NULL, path TEXT NOT NULL, deleted_at TEXT NOT NULL,
 digest TEXT NOT NULL,
 UNIQUE(workspace_id,path)
) STRICT;
CREATE TABLE IF NOT EXISTS migration_runtime_trash_origins (
entry_id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL, plan_json TEXT NOT NULL,
request_json TEXT NOT NULL, digest TEXT NOT NULL
) STRICT;
CREATE TABLE IF NOT EXISTS migration_runtime_trash_restores (
 entry_id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL, operation_id TEXT NOT NULL UNIQUE,
 request_json TEXT NOT NULL, digest TEXT NOT NULL
) STRICT;
CREATE TABLE IF NOT EXISTS migration_runtime_knowledge_commits (
 sequence INTEGER PRIMARY KEY, workspace_id TEXT NOT NULL, operation_id TEXT NOT NULL UNIQUE,
 request_json TEXT NOT NULL, plan_json TEXT NOT NULL, result_json TEXT NOT NULL, digest TEXT NOT NULL
) STRICT;`;
export function initializeMigrationRuntime(database: DatabaseSync): void { database.exec(MIGRATION_RUNTIME_DDL); }
export interface MigrationRuntimeOptions {
  database: DatabaseSync;
  root: string;
  workspaceId: string;
  transaction<T>(work: () => T): T;
  reconcileIndex(): void;
  assertOperationAvailable(operationId: string): void;
  fingerprint?(request: DataRuntimeRequest): string;
  /** Storage, not this helper, explicitly provisions and qualifies the exact layout. */
  trash?: { layoutVersion: "pkm.trash-lifecycle/v1"; faultInjector?: (point: string) => void };
}
const text = z.string().min(1);
const digest = z.string().regex(/^[a-f0-9]{64}$/);
const intentSchema = z.strictObject({
  operation_id: z.uuid(), workspace_id: text, root_path: text,
  actor_id: text.max(500), operation: text.max(256), fingerprint: digest,
  request_json: text.max(16_000_000), plan_json: text.max(16_000_000), digest,
});
type Intent = z.infer<typeof intentSchema>;
const entrySchema = z.strictObject({
  entry_id: trashEntryId, workspace_id: text, root_path: text,
  plan_json: text.max(4_194_304), digest,
});
const requestSchema = z.strictObject({
  operation: text.max(256), actorId: text.max(500), args: z.record(z.string(), z.unknown()),
});
function conflict(message: string): never { throw new CoreError("RECOVERY_CONFLICT", message, "unknown"); }
export function readNativeTrashOrigins(database: DatabaseSync, workspaceId: string): Map<string, TrashLifecyclePlan> {
  const result = new Map<string, TrashLifecyclePlan>();
  if (!database.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='migration_runtime_trash_origins'").get()) return result;
  for (const row of database.prepare("SELECT * FROM migration_runtime_trash_origins").all()) {
    const plan = deserializeTrashLifecyclePlan(String(row.plan_json));
    const request = requestSchema.parse(JSON.parse(String(row.request_json)));
    const args = trashLifecycleDefinitions[1].input.parse(request.args);
    const receipt = database.prepare("SELECT * FROM receipts WHERE operation_id=?").get(plan.operationId);
    if (row.workspace_id !== workspaceId || row.entry_id !== plan.entryId || plan.action !== "trash"
      || row.digest !== sha256(JSON.stringify([row.entry_id, workspaceId, row.plan_json, row.request_json]))
      || request.operation !== "knowledge.trash.move" || request.actorId !== plan.actorId
      || row.request_json !== JSON.stringify({ operation: request.operation, actorId: request.actorId, args })
      || args.operationId !== plan.operationId || args.area !== plan.area || args.path !== plan.path
      || args.kind !== plan.targetKind || args.expectedTreeSha256 !== plan.expectedTreeSha256
      || args.expectedScanRevision !== plan.expectedScanRevision
      || (args.entryIdFormat === "original" ? !/^[0-9]+-[a-f0-9]{10}$/.test(plan.entryId) : plan.entryId !== plan.operationId)
      || !receipt || receipt.actor_id !== plan.actorId || receipt.operation !== request.operation
      || receipt.fingerprint !== sha256(String(row.request_json))
      || receipt.result !== JSON.stringify({ operationId: plan.operationId, action: "trash", entryId: plan.entryId, area: plan.area, path: plan.path })) {
      conflict("Native Trash provenance lost its immutable workspace/request/actor/move receipt binding.");
    }
    result.set(plan.entryId, plan);
  }
  return result;
}
export function assertNativeTrashRow(database: DatabaseSync, workspaceId: string, root: string,
  row: Record<string, unknown>, origins = readNativeTrashOrigins(database, workspaceId)): TrashLifecyclePlan {
  const parsed = entrySchema.parse(row);
  const plan = deserializeTrashLifecyclePlan(parsed.plan_json), origin = origins.get(parsed.entry_id);
  const portable = (value: TrashLifecyclePlan) => ({ ...value, expectedTreeSha256: "",
    moves: value.moves.map(move => ({ ...move, entries: move.entries.map(({ dev: _dev, ino: _ino, ...entry }) => entry) })) });
  if (parsed.workspace_id !== workspaceId || parsed.root_path !== root
    || parsed.digest !== sha256(JSON.stringify([parsed.entry_id, workspaceId, root, parsed.plan_json]))
    || plan.entryId !== parsed.entry_id || plan.action !== "trash"
    || origin && JSON.stringify(portable(plan)) !== JSON.stringify(portable(origin))) {
    conflict("Native Trash row lost its current root or immutable provenance.");
  }
  if (!origin) {
    const receipt = database.prepare("SELECT actor_id,operation,result,fingerprint FROM receipts WHERE operation_id=?").get(plan.operationId);
    const args = trashLifecycleDefinitions[1].input.parse({
      operationId: plan.operationId, area: plan.area, path: plan.path, kind: plan.targetKind,
      expectedTreeSha256: plan.expectedTreeSha256, expectedScanRevision: plan.expectedScanRevision,
      ...(!z.uuid().safeParse(plan.entryId).success ? { entryIdFormat: "original" } : {}),
    });
    if (!receipt || receipt.actor_id !== plan.actorId || receipt.operation !== "knowledge.trash.move"
      || receipt.fingerprint !== sha256(JSON.stringify({ operation: "knowledge.trash.move", actorId: plan.actorId, args }))
      || receipt.result !== JSON.stringify({ operationId: plan.operationId, action: "trash", entryId: plan.entryId, area: plan.area, path: plan.path })) {
      conflict("Native Trash row has no authoritative move receipt.");
    }
  }
  return plan;
}
export function nativeTrashSupersedesImportedPlan(database: DatabaseSync, workspaceId: string, original: TrashLifecyclePlan): boolean {
  const portable = (move: TrashLifecyclePlan["moves"][number]) => ({ ...move,
    entries: move.entries.map(({ dev: _dev, ino: _ino, ...entry }) => entry) });
  return [...readNativeTrashOrigins(database, workspaceId).values()].some(origin =>
    origin.area === original.area && original.moves.every(move => origin.moves.some(next =>
      JSON.stringify(portable(move)) === JSON.stringify(portable(next)))));
}
export function nativeKnowledgeSupersedesImportedPlan(database: DatabaseSync, workspaceId: string,
  original: TrashLifecyclePlan, inventory: ReadonlyArray<{ path: string; sha256: string | null }>): boolean {
  if (!original.documentPins.length
    || !database.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='migration_runtime_knowledge_commits'").get()) return false;
  const states = new Map(original.documentPins.map(pin => [pin.id, { ...pin }]));
  let changed = false;
  const committedIds = new Set<string>();
  for (const row of database.prepare("SELECT * FROM migration_runtime_knowledge_commits ORDER BY sequence").all()) {
    const request = requestSchema.parse(JSON.parse(String(row.request_json)));
    const definition = knowledgeMutationDefinitions.find(item => item.id === request.operation);
    if (!definition || !Number.isSafeInteger(row.sequence) || Number(row.sequence) < 1
      || row.workspace_id !== workspaceId || row.operation_id !== request.args.operationId
      || row.digest !== sha256(JSON.stringify([row.sequence, workspaceId, row.operation_id, row.request_json, row.plan_json, row.result_json]))) {
      conflict("Committed Knowledge successor lost its ordered workspace/request/plan binding.");
    }
    committedIds.add(String(row.operation_id));
    const args = definition.input.parse(request.args) as Record<string, unknown>;
    const plan = deserializeKnowledgeMutationPlan(String(row.plan_json));
    const result = definition.output.parse(JSON.parse(String(row.result_json)));
    const receipt = database.prepare("SELECT * FROM receipts WHERE operation_id=?").get(String(row.operation_id));
    if (row.request_json !== JSON.stringify({ operation: request.operation, actorId: request.actorId, args })
      || plan.operation !== request.operation || plan.actorId !== request.actorId
      || plan.operationId !== row.operation_id || JSON.stringify(plan.receipt) !== JSON.stringify(result)
      || !receipt || receipt.operation !== request.operation || receipt.actor_id !== request.actorId
      || receipt.fingerprint !== sha256(String(row.request_json)) || receipt.result !== row.result_json) {
      conflict("Committed Knowledge successor lost its exact immutable actor/request/result receipt.");
    }
    for (const row of database.prepare("SELECT operation_id,result FROM receipts WHERE operation IN ('knowledge.note.update','knowledge.skill.update','knowledge.research.update')").all()) {
      const result = JSON.parse(String(row.result));
      if (states.has(result.id) && result.area === original.area && !committedIds.has(String(row.operation_id))) {
        conflict("Imported restored Knowledge history has a native update receipt without its immutable successor provenance.");
      }
    }
    const state = states.get(result.id);
    if (!state || result.area !== state.area) continue;
    if (!request.operation.endsWith(".update") || plan.change.path !== state.path
      || plan.change.beforeSha256 !== state.sha256 || !plan.change.before
      || sha256(plan.change.before) !== state.sha256 || args.expectedRevision !== state.revision
      || args.expectedSha256 !== state.sha256 || result.revision !== state.revision + 1) {
      conflict("Committed Knowledge mutation is not a continuous successor of the imported restored document.");
    }
    states.set(result.id, { id: result.id, area: result.area, path: result.path, revision: result.revision, sha256: result.sha256 });
    changed = true;
  }
  if (!changed) return false;
  const origins = readNativeTrashOrigins(database, workspaceId);
  const purged = new Set(database.prepare("SELECT result FROM receipts WHERE operation IN ('knowledge.trash.delete.original','knowledge.trash.empty.original')")
    .all().flatMap(row => JSON.parse(String(row.result)).entries.map((entry: { runtimeEntryId: string }) => entry.runtimeEntryId)));
  const current = new Map(inventory.map(item => [item.path, item.sha256]));
  const available = (path: string, expected: string) => {
    if (current.has(path)) return current.get(path) === expected;
    for (const origin of origins.values()) for (const move of origin.moves) {
      const base = `${origin.area}/${move.originalPath}`;
      if (path !== base && !path.startsWith(base + "/")) continue;
      const suffix = path === base ? "" : path.slice(base.length + 1);
      if (!move.entries.some(entry => entry.path === suffix && entry.sha256 === expected)) continue;
      if (purged.has(origin.entryId)) return true;
      const bucketPath = `${origin.area}/.trash/${origin.entryId}/${move.slot}${suffix ? `/${suffix}` : ""}`;
      if (database.prepare("SELECT 1 FROM migration_runtime_trash WHERE entry_id=?").get(origin.entryId)
        && current.get(bucketPath) === expected) return true;
    }
    return false;
  };
  for (const state of states.values()) {
    if (!available(`${state.area}/${state.path}`, state.sha256)) {
      conflict("Restored Knowledge successor differs from its authenticated after-image/native Trash disposition.");
    }
  }
  for (const move of original.moves) for (const entry of move.entries) {
    if (entry.kind !== "file" || !entry.sha256) continue;
    const originalPath = `${move.originalPath}${entry.path ? `/${entry.path}` : ""}`;
    if (original.documentPins.some(pin => pin.path === originalPath)) continue;
    let destination = originalPath;
    for (const before of original.documentPins) {
      const assetRoot = before.path.replace(/\.md$/i, ".assets");
      if (originalPath === assetRoot || originalPath.startsWith(assetRoot + "/")) {
        destination = states.get(before.id)!.path.replace(/\.md$/i, ".assets") + originalPath.slice(assetRoot.length);
        break;
      }
    }
    if (!available(`${original.area}/${destination}`, entry.sha256)) {
      conflict("Restored Knowledge successor lost original paired or folder resource bytes.");
    }
  }
  return true;
}
export function readOriginalTrashDeletionHistory(database: DatabaseSync, workspaceId: string) {
  const rows = database.prepare("SELECT * FROM migration_runtime_deletions ORDER BY sequence").all();
  const records = rows.map(row => {
    if (!Number.isSafeInteger(row.sequence) || Number(row.sequence) < 1 || row.workspace_id !== workspaceId
      || typeof row.path !== "string" || !knowledgeArea.safeParse(row.path.split("/")[0]).success
      || !resourcePath.safeParse(row.path.slice(row.path.indexOf("/") + 1)).success
      || !z.string().datetime().safeParse(row.deleted_at).success
      || row.digest !== sha256(JSON.stringify([row.sequence, workspaceId, row.path, row.deleted_at]))) {
      conflict("Original-compatible deletion history lost its workspace, order, path or timestamp binding.");
    }
    return { path: row.path, deletedAt: row.deleted_at as string };
  });
  return { schema: 1 as const, records };
}

/** Existing backup authority must authenticate the complete copied DB/files first.
 * Stage and final destination share the same inodes after no-replace publication. */
export function rebindMigrationTrashBackup(database: DatabaseSync, stage: string, destination: string, workspaceId: string): void {
  if (database.isTransaction) conflict("Native Trash backup rebind requires its own shared transaction.");
  if (!database.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='migration_runtime_trash'").get()) return;
  if (database.prepare("SELECT 1 FROM migration_runtime_intents").get())
    conflict("Pending native Trash cannot be rebound as a committed backup.");
  if (database.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='legacy_trash_import_receipt'").get()
    && database.prepare("SELECT 1 FROM legacy_trash_import_receipt").get()) return;
  const rows = database.prepare("SELECT * FROM migration_runtime_trash").all();
  const rebound = rows.map(value => {
    const parsed = entrySchema.safeParse(value);
    if (!parsed.success) conflict("Copied native Trash row violates its committed schema.");
    const row = parsed.data;
    if (row.workspace_id !== workspaceId || resolve(row.root_path) !== row.root_path
      || row.digest !== sha256(JSON.stringify([row.entry_id, workspaceId, row.root_path, row.plan_json])))
      conflict("Copied native Trash row lost its workspace/root/plan binding.");
    const plan = deserializeTrashLifecyclePlan(row.plan_json);
    const receipt = database.prepare("SELECT actor_id,operation,result FROM receipts WHERE operation_id=?").get(plan.operationId);
    if (plan.action !== "trash" || plan.entryId !== row.entry_id
      || z.uuid().safeParse(plan.entryId).success && plan.entryId !== plan.operationId
      || !receipt || receipt.actor_id !== plan.actorId || receipt.operation !== "knowledge.trash.move"
      || receipt.result !== JSON.stringify({ operationId: plan.operationId, action: "trash", entryId: plan.entryId, area: plan.area, path: plan.path }))
      conflict("Copied native Trash requires its authoritative immutable move receipt.");
    const json = serializeTrashLifecyclePlan(repinTrashLifecycleBackup(stage, plan));
    return { id: row.entry_id, json };
  });
  if (database.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='migration_runtime_deletions'").get())
    readOriginalTrashDeletionHistory(database, workspaceId);
  database.exec("BEGIN IMMEDIATE");
  try {
    for (const { id, json } of rebound) database.prepare("UPDATE migration_runtime_trash SET root_path=?,plan_json=?,digest=? WHERE entry_id=?")
      .run(destination, json, sha256(JSON.stringify([id, workspaceId, destination, json])), id);
    database.exec("COMMIT");
  } catch (error) { database.exec("ROLLBACK"); throw error; }
}

/** One connection and the caller's exclusive workspace writer; no competing database or lock.
 * Intents commit before effects. Index, immutable global receipt, trash entry and intent removal
 * commit together. Recovery preflights every row before performing any filesystem effects. */
export class MigrationRuntime {
  private readonly db: DatabaseSync;
  private readonly root: string;
  private closed = false;
  constructor(private readonly options: MigrationRuntimeOptions) {
    if (!options.workspaceId || typeof options.transaction !== "function"
      || typeof options.reconcileIndex !== "function" || typeof options.assertOperationAvailable !== "function"
      || options.trash && options.trash.layoutVersion !== trashLifecycleLayout.version) {
      throw new CoreError("INVALID_CONFIGURATION", "Shared transaction/index ownership and an exact optional trash layout are required.");
    }
    this.db = options.database;
    this.root = resolve(options.root);
  }
  available(operation: string): boolean {
    return migrationRuntimeDefinitions.some(definition => definition.id === operation)
      && (!operation.startsWith("knowledge.trash.") || !!this.options.trash);
  }
  private check(): void {
    if (this.closed) throw new CoreError("UNAVAILABLE", "Migration runtime is closed.");
    if (this.db.isTransaction) throw new CoreError("TRANSACTION_BOUNDARY", "Migration runtime requires the shared writer outside a database transaction.");
  }
  private parse(value: DataRuntimeRequest): DataRuntimeRequest {
    const request = requestSchema.safeParse(value);
    if (!request.success) throw new CoreError("INVALID_ARGUMENT", "Exact authenticated mutation request required.");
    const definition = migrationRuntimeDefinitions.find(item => item.id === request.data.operation);
    if (!definition) throw new CoreError("NOT_FOUND", "Unknown migration runtime operation.");
    const args = definition.input.safeParse(request.data.args);
    if (!args.success) throw new CoreError("INVALID_ARGUMENT", "Migration operation violates its exact input schema.");
    return { operation: request.data.operation, actorId: request.data.actorId, args: args.data };
  }
  private authorize(request: DataRuntimeRequest): void {
    if (!this.available(request.operation)) throw new CoreError("UNAVAILABLE", "The native host has not qualified the explicit trash layout.");
  }
  private fingerprint(request: DataRuntimeRequest): string {
    return this.options.fingerprint?.(request) ?? sha256(JSON.stringify(request));
  }
  private pending(operationId: string): Intent | undefined {
    return this.db.prepare("SELECT * FROM migration_runtime_intents WHERE operation_id=?").get(operationId) as Intent | undefined;
  }
  private receipt(request: DataRuntimeRequest): { result: unknown } | undefined {
    const row = this.db.prepare("SELECT fingerprint,actor_id,operation,result FROM receipts WHERE operation_id=?").get(String(request.args.operationId));
    if (!row) return undefined;
    if (row.fingerprint !== this.fingerprint(request) || row.actor_id !== request.actorId || row.operation !== request.operation) {
      throw new CoreError("CONFLICT", "Global operationId belongs to a different immutable request or actor.");
    }
    const definition = migrationRuntimeDefinitions.find(item => item.id === request.operation)!;
    const result = definition.output.safeParse(JSON.parse(String(row.result)));
    if (!result.success) conflict("Committed migration receipt violates its exact output contract.");
    return { result: result.data };
  }
  private validate(value: Intent): DataRuntimeRequest {
    const parsed = intentSchema.safeParse(value);
    if (!parsed.success) conflict("Unknown migration intent row; preserve it without effects.");
    const row = parsed.data;
    let request: DataRuntimeRequest;
    try { request = this.parse(JSON.parse(row.request_json)); }
    catch { conflict("Unknown migration intent request; preserve it without effects."); }
    const binding = [row.operation_id, row.workspace_id, row.root_path, row.actor_id, row.operation,
      row.fingerprint, row.request_json, row.plan_json];
    if (row.workspace_id !== this.options.workspaceId || row.root_path !== this.root
      || row.operation_id !== request.args.operationId || row.actor_id !== request.actorId
      || row.operation !== request.operation || row.fingerprint !== this.fingerprint(request)
      || row.request_json !== JSON.stringify(request) || row.digest !== sha256(JSON.stringify(binding))
      || this.db.prepare("SELECT 1 FROM receipts WHERE operation_id=?").get(row.operation_id)
      || migrationRuntimeDefinitions.find(item => item.id === request.operation)!.readOnly) {
      conflict("Migration intent workspace, actor, operation, immutable request or digest does not match.");
    }
    this.authorize(request);
    return request;
  }
  private insert(request: DataRuntimeRequest, plan: string): void {
    if (!this.db.isTransaction) throw new CoreError("TRANSACTION_BOUNDARY", "Intent persistence requires the shared transaction.");
    const id = String(request.args.operationId);
    if (this.pending(id) || this.receipt(request)) throw new CoreError("CONFLICT", "Operation already owns a pending or committed intent.");
    this.options.assertOperationAvailable(id);
    if (request.operation === "knowledge.trash.move") {
      const entry = deserializeTrashLifecyclePlan(plan).entryId;
      if (this.db.prepare("SELECT 1 FROM migration_runtime_trash_origins WHERE entry_id=?").get(entry)) {
        throw new CoreError("CONFLICT", "Trash entry identity already belongs to immutable native provenance.");
      }
    }
    const binding = [id, this.options.workspaceId, this.root, request.actorId, request.operation,
      this.fingerprint(request), JSON.stringify(request), plan];
    this.db.prepare("INSERT INTO migration_runtime_intents VALUES(?,?,?,?,?,?,?,?,?)")
      .run(...binding, sha256(JSON.stringify(binding)));
  }
  private committedEntry(id: string): TrashLifecyclePlan {
    const parsed = entrySchema.safeParse(this.db.prepare("SELECT * FROM migration_runtime_trash WHERE entry_id=?").get(id));
    if (!parsed.success) throw new CoreError("NOT_FOUND", "An authoritative committed trash entry is required.");
    const row = parsed.data;
    if (row.workspace_id !== this.options.workspaceId || row.root_path !== this.root
      || row.digest !== sha256(JSON.stringify([row.entry_id, row.workspace_id, row.root_path, row.plan_json]))) {
      conflict("Committed trash entry workspace or digest changed.");
    }
    const plan = deserializeTrashLifecyclePlan(row.plan_json);
    if (plan.action !== "trash" || plan.entryId !== id
      || z.uuid().safeParse(id).success && plan.operationId !== id) conflict("Unknown committed trash entry identity.");
    return plan;
  }
  private bindPlan(row: Intent, request: DataRuntimeRequest): void {
    if (request.operation.startsWith("knowledge.trash.")) {
      const plan = deserializeTrashLifecyclePlan(row.plan_json);
      if (plan.actorId !== request.actorId || plan.operationId !== request.args.operationId
        || plan.expectedScanRevision !== request.args.expectedScanRevision
        || (request.operation === "knowledge.trash.move"
          ? plan.action !== "trash"
            || (request.args.entryIdFormat === "original"
              ? !/^[0-9]+-[a-f0-9]{10}$/.test(plan.entryId) : plan.entryId !== request.args.operationId)
            || plan.area !== request.args.area
            || plan.path !== request.args.path || plan.targetKind !== request.args.kind || plan.expectedTreeSha256 !== request.args.expectedTreeSha256
          : plan.action !== "restore" || plan.entryId !== request.args.entryId)) conflict("Trash plan no longer matches its immutable request.");
      if (plan.action === "restore") {
        const original = this.committedEntry(plan.entryId);
        const expected = { ...original, action: "restore", operationId: plan.operationId,
          actorId: plan.actorId, referencePins: plan.referencePins, expectedScanRevision: plan.expectedScanRevision };
        if (JSON.stringify(expected) !== row.plan_json) conflict("Restore plan no longer matches the authoritative trash entry.");
      } else if (this.db.prepare("SELECT 1 FROM migration_runtime_trash WHERE entry_id=?").get(plan.entryId)) {
        conflict("Pending trash intent collides with a committed entry.");
      }
    } else {
      const plan = deserializeKnowledgeMutationPlan(row.plan_json);
      if (plan.actorId !== request.actorId || plan.operationId !== request.args.operationId
        || plan.operation !== request.operation || plan.expectedScanRevision !== request.args.expectedScanRevision
        || request.operation.endsWith(".update") && (plan.receipt.id !== request.args.id
          || plan.change.beforeSha256 !== request.args.expectedSha256 || plan.receipt.revision !== Number(request.args.expectedRevision) + 1)) {
        conflict("Specialized mutation plan no longer matches its immutable request.");
      }
      assertKnowledgeMutationRequestPlan(this.root, plan, request as KnowledgeMutationRequest);
    }
  }
  private finish(request: DataRuntimeRequest, result: unknown, trash?: TrashLifecyclePlan): void {
    if (!this.db.isTransaction) throw new CoreError("TRANSACTION_BOUNDARY", "Final migration publication requires the shared transaction.");
    const row = this.pending(String(request.args.operationId));
    if (!row) conflict("Migration intent disappeared before final publication.");
    this.validate(row); this.bindPlan(row, request);
    const parsed = migrationRuntimeDefinitions.find(item => item.id === request.operation)!.output.safeParse(result);
    if (!parsed.success) conflict("Migration result violates its exact output schema.");
    this.options.reconcileIndex();
    if (trash?.action === "trash") {
      const binding = [trash.entryId, this.options.workspaceId, this.root, serializeTrashLifecyclePlan(trash)];
      this.db.prepare("INSERT INTO migration_runtime_trash VALUES(?,?,?,?,?)").run(...binding, sha256(JSON.stringify(binding)));
      const origin = [trash.entryId, this.options.workspaceId, serializeTrashLifecyclePlan(trash), JSON.stringify(request)];
      this.db.prepare("INSERT INTO migration_runtime_trash_origins VALUES(?,?,?,?,?)").run(...origin, sha256(JSON.stringify(origin)));
    } else if (trash) {
      this.db.prepare("DELETE FROM migration_runtime_trash WHERE entry_id=?").run(trash.entryId);
      const restored = [trash.entryId, this.options.workspaceId, trash.operationId, JSON.stringify(request)];
      this.db.prepare("INSERT INTO migration_runtime_trash_restores VALUES(?,?,?,?,?)").run(...restored, sha256(JSON.stringify(restored)));
    }
    if (trash && !z.uuid().safeParse(trash.entryId).success) {
      const paths = [...trash.moves].sort((a, b) => a.slot === b.slot ? 0 : a.slot === "payload" ? -1 : 1)
        .flatMap(move => move.entries.filter(entry => entry.kind === "file"
          && !entry.path.split("/").some(part => part.startsWith(".")))
          .map(entry => `${trash.area}/${move.originalPath}${entry.path ? `/${entry.path}` : ""}`));
      for (const path of paths) this.db.prepare("DELETE FROM migration_runtime_deletions WHERE workspace_id=? AND path=?")
        .run(this.options.workspaceId, path);
      if (trash.action === "trash") for (const path of paths) {
        const sequence = Number(this.db.prepare("SELECT COALESCE(MAX(sequence),0)+1 AS next FROM migration_runtime_deletions").get()!.next);
        const binding = [sequence, this.options.workspaceId, path, trash.deletedAt];
        this.db.prepare("INSERT INTO migration_runtime_deletions VALUES(?,?,?,?,?)").run(...binding, sha256(JSON.stringify(binding)));
      }
    }
    this.db.prepare("INSERT INTO receipts VALUES(?,?,?,?,?,?)").run(String(request.args.operationId),
      this.fingerprint(request), JSON.stringify(parsed.data), request.actorId, request.operation, new Date().toISOString());
    if (!trash) {
      const sequence = Number(this.db.prepare("SELECT COALESCE(MAX(sequence),0)+1 AS next FROM migration_runtime_knowledge_commits").get()!.next);
      const binding = [sequence, this.options.workspaceId, row.operation_id, row.request_json, row.plan_json, JSON.stringify(parsed.data)];
      this.db.prepare("INSERT INTO migration_runtime_knowledge_commits VALUES(?,?,?,?,?,?,?)").run(...binding, sha256(JSON.stringify(binding)));
    }
    this.db.prepare("DELETE FROM migration_runtime_intents WHERE operation_id=? AND digest=?").run(row.operation_id, row.digest);
  }
  async read(value: DataRuntimeRequest): Promise<unknown> {
    this.check();
    const request = this.parse(value); this.authorize(request);
    if (request.operation !== "knowledge.trash.lifecycle.preview") throw new CoreError("INVALID_ARGUMENT", "This migration operation is not read-only.");
    return this.options.transaction(() => previewTrashLifecycle(this.root, request.args));
  }
  async mutate(value: DataRuntimeRequest): Promise<unknown> {
    this.check();
    const request = this.parse(value); this.authorize(request);
    if (migrationRuntimeDefinitions.find(item => item.id === request.operation)!.readOnly) throw new CoreError("INVALID_ARGUMENT", "Read-only migration operation cannot mutate.");
    const prior = this.receipt(request); if (prior) return prior.result;
    const pending = this.pending(String(request.args.operationId));
    if (pending) {
      this.validate(pending);
      if (pending.request_json !== JSON.stringify(request)) throw new CoreError("CONFLICT", "OperationId belongs to a different pending request or actor.");
    }
    await this.recover();
    const recovered = this.receipt(request); if (recovered) return recovered.result;
    if (request.operation.startsWith("knowledge.trash.")) {
      const plan = this.options.transaction(() => request.operation === "knowledge.trash.move"
        ? planTrashLifecycle(this.root, request.actorId, request.args)
        : planTrashRestore(this.root, request.actorId, this.committedEntry(String(request.args.entryId)), request.args));
      return executeTrashLifecycle(this.root, plan, this.trashHost(request));
    }
    this.options.transaction(() => this.insert(request,
      serializeKnowledgeMutationPlan(planKnowledgeMutation(this.root, request as KnowledgeMutationRequest))));
    return this.execute(this.pending(String(request.args.operationId))!);
  }
  private trashHost(request: DataRuntimeRequest): TrashLifecycleHost {
    return {
      // The native caller already holds the sole shared workspace writer across this entire call.
      withWriterLock: work => work(),
      persistIntent: (_id, plan) => this.options.transaction(() => this.insert(request, plan)),
      readIntent: id => this.pending(id)?.plan_json,
      faultInjector: this.options.trash?.faultInjector,
      commitAtomic: (plan, result) => this.options.transaction(() => this.finish(request, result, plan)),
    };
  }
  private execute(row: Intent, recovering = false): unknown {
    const request = this.validate(row); this.bindPlan(row, request);
    if (request.operation.startsWith("knowledge.trash.")) {
      return executeTrashLifecycle(this.root, deserializeTrashLifecyclePlan(row.plan_json), this.trashHost(request), true);
    }
    const plan = deserializeKnowledgeMutationPlan(row.plan_json);
    const result = recovering ? recoverKnowledgeMutation(this.root, plan, row.operation_id)
      : applyKnowledgeMutation(this.root, plan, row.operation_id);
    this.options.transaction(() => this.finish(request, result));
    return result;
  }
  async inspectRecovery(): Promise<void> {
    this.check();
    readOriginalTrashDeletionHistory(this.db, this.options.workspaceId);
    const rows = this.db.prepare("SELECT * FROM migration_runtime_intents ORDER BY operation_id").all() as unknown as Intent[];
    for (const row of rows) {
      const request = this.validate(row); this.bindPlan(row, request);
      if (request.operation.startsWith("knowledge.trash.")) inspectTrashLifecycleRecovery(this.root, deserializeTrashLifecyclePlan(row.plan_json));
      else inspectKnowledgeMutationRecovery(this.root, deserializeKnowledgeMutationPlan(row.plan_json));
    }
    if (this.options.trash) {
      const entries = this.db.prepare("SELECT * FROM migration_runtime_trash ORDER BY entry_id").all();
      const plans = entries.map(entry => {
        const parsed = entrySchema.safeParse(entry);
        if (!parsed.success) conflict("Unknown committed trash row.");
        return this.committedEntry(parsed.data.entry_id);
      });
      for (const directory of trashLifecycleLayout.directories) {
        const area = directory.split("/")[0];
        const owned = new Set(plans.filter(plan => plan.area === area).map(plan => plan.entryId));
        for (const row of rows) {
          if (!row.operation.startsWith("knowledge.trash.")) continue;
          const plan = deserializeTrashLifecyclePlan(row.plan_json);
          if (plan.area === area) owned.add(plan.entryId);
        }
        const full = join(this.root, directory);
        let stat;
        try { stat = lstatSync(full); }
        catch (error) {
          // Explicit layout authorization permits provisioning absent empty roots only.
          if ((error as NodeJS.ErrnoException).code === "ENOENT" && owned.size === 0) continue;
          conflict("Allowlisted trash root is missing or unreadable; preserve journal-owned entries.");
        }
        if (!stat.isDirectory() || stat.isSymbolicLink()) conflict("Allowlisted trash root is not a real directory.");
        if (readdirSync(full).some(name => !owned.has(name))) conflict("Allowlisted trash root contains an unknown entry; preserve it.");
      }
      const restoring = new Set(rows.filter(row => row.operation === "knowledge.trash.restore")
        .map(row => deserializeTrashLifecyclePlan(row.plan_json).entryId));
      for (const plan of plans) if (!restoring.has(plan.entryId)) inspectTrashLifecycleEntry(this.root, plan);
    }
  }
  async recover(): Promise<void> {
    await this.inspectRecovery();
    const rows = this.db.prepare("SELECT * FROM migration_runtime_intents ORDER BY operation_id").all() as unknown as Intent[];
    for (const row of rows) this.execute(row, true);
  }
  async dispatch(request: DataRuntimeRequest): Promise<unknown> {
    return migrationRuntimeDefinitions.find(item => item.id === request.operation)?.readOnly ? this.read(request) : this.mutate(request);
  }
  close(): void { this.closed = true; }
}
