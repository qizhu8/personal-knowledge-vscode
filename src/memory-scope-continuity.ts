import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { coreDatabasePath } from "./workspace-storage-paths.js";
import { DatabaseSync } from "node:sqlite";
import { pathToFileURL } from "node:url";
import { z } from "zod";
import { CoreError } from "./contracts.js";
import { sha256 } from "./file-write.js";
import { legacyMemoryImportReceiptSchema } from "./domain/memory-import-contracts.js";
import { readOriginalMcpJournal } from "./original-mcp-root-custody.js";

const legacyMemoryScopeContinuitySchema = z.strictObject({
  schema: z.literal("pkm.memory-scope-continuity/v1"),
  workspaceId: z.string().uuid(),
  scope: z.string().min(1).max(1024),
  sourceScopeSha256: z.string().regex(/^[a-f0-9]{64}$/),
  importReceiptSha256: z.string().regex(/^[a-f0-9]{64}$/),
  actorId: z.string().min(1).max(256),
  decisionId: z.string().min(1).max(256),
});
export const approvedMemoryScopeContinuitySchema = z.strictObject({
  schema: z.literal("pkm.memory-scope-continuity/v2"),
  workspaceId: z.string().uuid(),
  scope: z.string().min(1).max(1024),
  sourceScopeSha256: z.string().regex(/^[a-f0-9]{64}$/),
  sourceDatabaseSha256: z.string().regex(/^[a-f0-9]{64}$/),
  importPlanSha256: z.string().regex(/^[a-f0-9]{64}$/),
  importReceiptSha256: z.string().regex(/^[a-f0-9]{64}$/),
  actorId: z.string().min(1).max(256),
  decisionId: z.string().min(1).max(256),
  expiresAtMs: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
});
export const memoryScopeContinuitySchema = z.union([
  legacyMemoryScopeContinuitySchema, approvedMemoryScopeContinuitySchema,
]);
export type MemoryScopeContinuity = z.infer<typeof memoryScopeContinuitySchema>;
export type ApprovedMemoryScopeContinuity = z.infer<typeof approvedMemoryScopeContinuitySchema>;
export type MemoryScopeContinuityRequest = Omit<ApprovedMemoryScopeContinuity, "decisionId" | "expiresAtMs">;
export type MemoryScopeContinuityAuthorizer = (request: Readonly<MemoryScopeContinuityRequest>) =>
  Promise<{ actorId: string; decisionId: string; expiresAtMs: number } | null>
  | { actorId: string; decisionId: string; expiresAtMs: number } | null;

const activeSessions = new Map<string, ApprovedMemoryScopeContinuity>();
const revocations = new Map<string, Int32Array>();
export function bindMemoryScopeRevocation(root: string, buffer?: SharedArrayBuffer): void {
  if (!buffer) { revocations.delete(root); return; }
  if (!(buffer instanceof SharedArrayBuffer) || buffer.byteLength !== 4)
    throw new CoreError("NOT_AVAILABLE", "Invalid native Memory session revocation resource.");
  revocations.set(root, new Int32Array(buffer));
}
export function deactivateMemoryScopeContinuity(root: string): void {
  activeSessions.delete(root);
  revocations.delete(root);
}
export function openMemoryContinuitySnapshot(root: string): DatabaseSync {
  const database = new DatabaseSync(":memory:");
  try {
    const liveOriginal = !!readOriginalMcpJournal(root);
    database.prepare("ATTACH DATABASE ? AS imported")
      .run(`${pathToFileURL(coreDatabasePath(root)).href}?mode=ro${liveOriginal ? "" : "&immutable=1"}`);
    for (const table of ["legacy_memory_imports", "legacy_memory_scope_continuity", "legacy_memory_import_operations", "receipts"]) {
      if (database.prepare("SELECT 1 FROM imported.sqlite_master WHERE type='table' AND name=?").get(table))
        database.exec(`CREATE TEMP VIEW ${table} AS SELECT * FROM imported.${table}`);
    }
    return database;
  } catch (error) { database.close(); throw error; }
}
export function activateMemoryScopeContinuity(root: string,
  approval: { decisionId: string; actorId: string; expiresAtMs: number }): void {
  const database = openMemoryContinuitySnapshot(root);
  try {
    const marker = JSON.parse(readFileSync(join(root, ".pkm-next-workspace"), "utf8"));
    const binding = readMemoryScopeContinuity(database, String(marker.id));
    if (!binding || binding.schema !== "pkm.memory-scope-continuity/v2"
      || binding.actorId !== approval.actorId || binding.decisionId !== approval.decisionId
      || binding.expiresAtMs !== approval.expiresAtMs || binding.expiresAtMs <= Date.now()) {
      throw new CoreError("NOT_AVAILABLE", "Fresh exact host Memory admission is required.");
    }
    activeSessions.set(root, { ...binding });
  } finally { database.close(); }
}
export function activateReadoptedMemoryScope(root: string, request: MemoryScopeContinuityRequest,
  approval: { decisionId: string; actorId: string; expiresAtMs: number }): void {
  const parsed = approvedMemoryScopeContinuitySchema.parse({ ...request, ...approval });
  if (approval.actorId !== request.actorId || parsed.expiresAtMs <= Date.now()
    || parsed.expiresAtMs > Date.now() + 30 * 60_000)
    throw new CoreError("NOT_AVAILABLE", "A fresh bounded exact host session approval is required.");
  const database = openMemoryContinuitySnapshot(root);
  try {
    const binding = readMemoryScopeContinuity(database, request.workspaceId);
    if (!binding || binding.schema !== "pkm.memory-scope-continuity/v2"
      || JSON.stringify(continuityIdentity(binding)) !== JSON.stringify(continuityIdentity(parsed)))
      throw new CoreError("NOT_AVAILABLE", "Fresh host approval differs from imported Memory provenance.");
    activeSessions.set(root, parsed);
  } finally { database.close(); }
}
function continuityIdentity(binding: ApprovedMemoryScopeContinuity) {
  const { decisionId: _decisionId, expiresAtMs: _expiresAtMs, ...identity } = binding;
  return identity;
}
export const memoryScopeContinuityDdl = `CREATE TABLE legacy_memory_scope_continuity(
    singleton INTEGER PRIMARY KEY CHECK(singleton=1), binding_json TEXT NOT NULL, binding_sha256 TEXT NOT NULL
  )`;
export function persistMemoryScopeContinuity(database: DatabaseSync, binding: ApprovedMemoryScopeContinuity): void {
  const parsed = approvedMemoryScopeContinuitySchema.parse(binding);
  database.exec(memoryScopeContinuityDdl);
  const json = JSON.stringify(parsed);
  database.prepare("INSERT INTO legacy_memory_scope_continuity VALUES(1,?,?)").run(json, sha256(json));
}

export function readMemoryScopeContinuity(database: DatabaseSync, workspaceId: string): MemoryScopeContinuity | undefined {
  if (!database.prepare("SELECT 1 FROM sqlite_master WHERE name='legacy_memory_scope_continuity' UNION ALL SELECT 1 FROM sqlite_temp_master WHERE name='legacy_memory_scope_continuity'").get()) return undefined;
  try {
    const row = database.prepare("SELECT binding_json,binding_sha256 FROM legacy_memory_scope_continuity WHERE singleton=1").get();
    if (!row || sha256(String(row.binding_json)) !== row.binding_sha256) throw new Error();
    const binding = memoryScopeContinuitySchema.parse(JSON.parse(String(row.binding_json)));
    const imported = database.prepare("SELECT * FROM legacy_memory_imports WHERE singleton=1").get();
    if (!imported) throw new Error();
    const receipt = legacyMemoryImportReceiptSchema.parse(JSON.parse(String(imported.receipt_json)));
    const { receiptSha256, ...body } = receipt;
    if (binding.workspaceId !== workspaceId || imported.workspace_id !== workspaceId
      || sha256(JSON.stringify(body)) !== receiptSha256 || binding.importReceiptSha256 !== receiptSha256
      || imported.receipt_sha256 !== receiptSha256 || binding.actorId !== receipt.actorId
      || imported.actor_id !== binding.actorId || imported.source_sha256 !== receipt.sourceDatabaseSha256
      || imported.engine_identity !== receipt.engineIdentity || binding.sourceScopeSha256 !== sha256(binding.scope)
      || !receipt.scopes.includes(binding.scope)) throw new Error();
    if (binding.schema === "pkm.memory-scope-continuity/v2"
      && binding.sourceDatabaseSha256 !== receipt.sourceDatabaseSha256) throw new Error();
    return binding;
  } catch {
    throw new CoreError("INVALID_WORKSPACE", "Memory scope continuity lost its exact native-approved workspace/import binding; preserve it for reconciliation.");
  }
}

export function continuityScope(root: string): string | undefined {
  return activeContinuity(root)?.scope;
}

/** Evidence of an already admitted session, never an authority to activate one. */
export function readActiveMemoryScopeSession(root: string, actorId: string): Readonly<ApprovedMemoryScopeContinuity> {
  const binding = activeContinuity(root);
  if (!binding || binding.actorId !== actorId)
    throw new CoreError("NOT_AVAILABLE", "Fresh exact host Memory admission is required for this actor.");
  return Object.freeze({ ...binding });
}

export function assertMemoryScopeActor(root: string, actorId: string): void {
  const binding = activeContinuity(root);
  if (readOriginalMcpJournal(root) && !binding)
    throw new CoreError("NOT_AVAILABLE", "Original-root Memory requires a fresh exact native source/actor continuity session.");
  if (binding && binding.actorId !== actorId) {
    throw new CoreError("NOT_AVAILABLE", "Imported Memory scope is unavailable to this host actor.");
  }
}

function activeContinuity(root: string): ApprovedMemoryScopeContinuity | undefined {
  const revoked = revocations.get(root);
  if (revoked && Atomics.load(revoked, 0) !== 0) return undefined;
  if (!existsSync(coreDatabasePath(root))) return undefined;
  let database: DatabaseSync | undefined;
  try {
    database = openMemoryContinuitySnapshot(root);
    const marker = JSON.parse(readFileSync(join(root, ".pkm-next-workspace"), "utf8"));
    const binding = readMemoryScopeContinuity(database, String(marker.id));
    const active = activeSessions.get(root);
    if (!binding || binding.schema !== "pkm.memory-scope-continuity/v2" || !active || active.expiresAtMs <= Date.now()
      || JSON.stringify(continuityIdentity(active)) !== JSON.stringify(continuityIdentity(binding))) return undefined;
    return active;
  } catch (error) {
    if (error instanceof CoreError) throw error;
    throw new CoreError("INVALID_WORKSPACE", "Memory continuity authority could not be read safely.");
  } finally { database?.close(); }
}
