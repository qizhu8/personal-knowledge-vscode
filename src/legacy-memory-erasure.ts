import { createHash } from "node:crypto";
import { lstat, realpath } from "node:fs/promises";
import { lstatSync, realpathSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { z } from "zod";
import type { Storage } from "./storage.js";
import type { ChatMemoryWorker } from "./compute/chat-memory-worker.js";

const schemaVersion = 1;
const supportedDatabaseVersions = new Set([19, 20, 21, 22, 23]);
const text = (max: number) => z.string().min(1).max(max)
  .refine(value => !/[\u0000-\u001f\u007f]/u.test(value) && Buffer.byteLength(value, "utf8") <= max);
const digest = z.string().regex(/^[a-f0-9]{64}$/);
const safeInteger = z.number().int().safe().nonnegative();

export const legacyMemoryErasureDefinitions = [{
  id: "memory.scope.forget.native",
  nativeOnly: true,
  input: z.strictObject({
    operationId: z.string().uuid(),
    scope: text(1024),
    expectedSourcePin: digest,
    expectedEpoch: safeInteger,
  }),
  output: z.strictObject({
    schema: z.literal("pkm.native-memory-erasure-receipt/v1"),
    operationId: z.string().uuid(),
    actorId: text(256),
    workspaceId: z.string().uuid(),
    scopeSha256: digest,
    sourcePin: digest,
    removedStatements: safeInteger,
    erasureEpoch: safeInteger,
    erasure: z.literal("logical-only"),
    backupProtection: z.literal("local-ledger-only"),
  }),
}] as const;

const forgetInput = legacyMemoryErasureDefinitions[0].input;
export type LegacyMemoryForgetInput = z.infer<typeof forgetInput>;
export type LegacyMemoryErasureReceipt = z.infer<typeof legacyMemoryErasureDefinitions[0]["output"]>;

export class LegacyMemoryErasureError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
    this.name = "LegacyMemoryErasureError";
  }
}

export interface LegacyMemoryErasurePreview {
  schema: "pkm.native-memory-erasure-preview/v1";
  workspaceId: string;
  actorId: string;
  scopeSha256: string;
  sourcePin: string;
  expectedEpoch: number;
  livePieces: number;
  sourceReferences: number;
  dependentStatements: number;
  sourceStatements: number;
  logicalOnly: true;
}

export interface LegacyMemoryForgetAuthorizationRequest {
  schema: "pkm.native-memory-erasure-authorization/v1";
  operationId: string;
  actorId: string;
  workspaceId: string;
  rootSha256: string;
  scopeSha256: string;
  sourcePin: string;
  expectedEpoch: number;
  livePieces: number;
  sourceReferences: number;
  dependentStatements: number;
  sourceStatements: number;
}

export interface LegacyMemoryForgetDecision {
  decisionId: string;
  actorId: string;
  requestSha256: string;
}

export interface LegacyMemoryErasureLease {
  assertHeld(): void;
  release(): Promise<void> | void;
}

export interface LegacyMemoryErasureSqlContext {
  operationId: string;
  actorId: string;
  workspaceId: string;
  rootSha256: string;
  scopeSha256: string;
  requestSha256: string;
}

export interface LegacyMemoryErasureGlobalReceipt {
  operationId: string;
  actorId: string;
  fingerprint: string;
  operation: "memory.scope.forget.native";
  result: LegacyMemoryErasureReceipt;
}

export interface LegacyMemoryErasureSqlHooks {
  /** Synchronous SQL-only owner/fence check on the supplied connection; no filesystem access. */
  assertSqlLease?(database: DatabaseSync, context: Readonly<LegacyMemoryErasureSqlContext>): void;
  /** Synchronous SQL-only admission check, including all global pending tables, on this connection. */
  assertSqlAdmission?(database: DatabaseSync, context: Readonly<LegacyMemoryErasureSqlContext>): void;
  /** Read the shared Core receipt using this connection; null means absent. */
  readGlobalReceipt?(database: DatabaseSync, operationId: string): LegacyMemoryErasureGlobalReceipt | null;
  /** Insert the immutable shared Core receipt using this connection, inside the active transaction. */
  writeGlobalReceipt?(database: DatabaseSync, receipt: Readonly<LegacyMemoryErasureGlobalReceipt>): void;
  /** Re-evaluate current actor/policy for an already committed operation before returning its receipt. */
  authorizeReceiptReplay?(database: DatabaseSync,
    receipt: Readonly<LegacyMemoryErasureGlobalReceipt>): boolean;
}

export interface LegacyMemoryErasureHost {
  readonly actorId: string;
  authorizeForget?(request: Readonly<LegacyMemoryForgetAuthorizationRequest>):
    Promise<LegacyMemoryForgetDecision | null> | LegacyMemoryForgetDecision | null;
  acquireMemoryQuiescence?(): Promise<LegacyMemoryErasureLease>;
  /** Synchronous native policy for all-writer and parent/file ownership, live actor and external epoch. */
  assertEffectAuthority?(request: Readonly<LegacyMemoryEffectAuthorityRequest>): boolean;
  sql?: LegacyMemoryErasureSqlHooks;
}

export interface LegacyMemoryEffectAuthorityRequest {
  actorId: string;
  workspaceId: string;
  rootSha256: string;
  operationId: string;
  scopeSha256: string;
  requestSha256: string;
  expectedEpoch: number;
  phase: "before-effect" | "after-effect" | "replay";
  runtimeDirectory: string;
  database: string;
  directoryDevice: string;
  directoryInode: string;
  databaseDevice: string;
  databaseInode: string;
  ancestors: ReadonlyArray<Readonly<{ path: string; device: string; inode: string }>>;
}

export interface LegacyMemoryErasureEngineBinding {
  readonly worker: ChatMemoryWorker;
  readonly runtimeDirectory: string;
  readonly database: string;
  readonly identity: string;
  assertNativeAdoption?(root: string, workspaceId: string): boolean;
  originalOperationRoot?(operationId: string): string | undefined;
}

export interface TrustedLegacyMemoryEpochAuthority {
  /** Must read an independently persisted trusted value, never the workspace/backup being restored. */
  readTrustedEpoch(request: Readonly<{ workspaceId: string }>): Promise<{
    authorityId: string;
    workspaceId: string;
    epoch: number;
  } | null>;
}

export interface LegacyMemoryRestorePin {
  workspaceId: string;
  manifestSha256: string;
  memoryErasureEpoch: number | null;
}

export const LEGACY_MEMORY_ERASURE_DDL = `
  CREATE TABLE IF NOT EXISTS legacy_memory_erasure_schema(
    singleton INTEGER PRIMARY KEY CHECK(singleton=1), version INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS legacy_memory_erasure_state(
    singleton INTEGER PRIMARY KEY CHECK(singleton=1),
    workspace_id TEXT NOT NULL,
    epoch INTEGER NOT NULL CHECK(epoch>=0)
  );
  CREATE TABLE IF NOT EXISTS legacy_memory_erasure_operations(
    operation_id TEXT PRIMARY KEY,
    actor_id TEXT NOT NULL,
    workspace_id TEXT NOT NULL,
    root_sha256 TEXT NOT NULL,
    scope_sha256 TEXT NOT NULL,
    request_sha256 TEXT NOT NULL,
    source_pin TEXT NOT NULL,
    decision_id TEXT NOT NULL,
    expected_epoch INTEGER NOT NULL CHECK(expected_epoch>=0),
    live_pieces INTEGER NOT NULL CHECK(live_pieces>=0),
    source_references INTEGER NOT NULL CHECK(source_references>=0),
    dependent_statements INTEGER NOT NULL CHECK(dependent_statements>=0),
    source_statements INTEGER NOT NULL CHECK(source_statements>=0),
    authorization_request_sha256 TEXT NOT NULL,
    status TEXT NOT NULL CHECK(status IN ('pending','committed')),
    receipt_json TEXT,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  );
`;

const receiptSchema = legacyMemoryErasureDefinitions[0].output;
const authorizationSchema = z.strictObject({
  decisionId: text(256),
  actorId: text(256),
  requestSha256: digest,
});
const journalRowSchema = z.strictObject({
  operation_id: z.string().uuid(),
  actor_id: text(256),
  workspace_id: z.string().uuid(),
  root_sha256: digest,
  scope_sha256: digest,
  request_sha256: digest,
  source_pin: digest,
  decision_id: text(256),
  expected_epoch: safeInteger,
  live_pieces: safeInteger,
  source_references: safeInteger,
  dependent_statements: safeInteger,
  source_statements: safeInteger,
  authorization_request_sha256: digest,
  status: z.enum(["pending", "committed"]),
  receipt_json: z.string().nullable(),
  created_at: safeInteger,
  updated_at: safeInteger,
});

function sha256(value: string | Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

function encode(value: unknown): string {
  return JSON.stringify(value);
}

function parseJson<T>(schema: z.ZodType<T>, value: unknown, message: string): T {
  const parsed = schema.safeParse(value);
  if (!parsed.success) throw new LegacyMemoryErasureError("STATE_CORRUPT", message);
  return parsed.data;
}

function assertActor(actorId: unknown): asserts actorId is string {
  if (!text(256).safeParse(actorId).success) {
    throw new LegacyMemoryErasureError("AUTHORITY_REQUIRED", "Authenticated native actor context is required.");
  }
}

type EngineFilePin = ReadonlyArray<Readonly<{ path: string; device: string; inode: string }>>;

function captureEngineFilePin(engine: LegacyMemoryErasureEngineBinding): EngineFilePin {
  const runtime = resolve(engine.runtimeDirectory);
  const database = resolve(engine.database);
  if (!isAbsolute(engine.runtimeDirectory) || !isAbsolute(engine.database) || dirname(database) !== runtime) {
    throw new LegacyMemoryErasureError("ENGINE_MISMATCH", "Native memory database path is not a direct absolute runtime child.");
  }
  const paths = [database];
  for (let current = runtime;; current = dirname(current)) {
    paths.push(current);
    if (dirname(current) === current) break;
  }
  try {
    return paths.map((path, index) => {
      const info = lstatSync(path, { bigint: true });
      if (info.isSymbolicLink() || (index === 0 ? !info.isFile() : !info.isDirectory())
        || realpathSync(path) !== path) throw new Error("Unstable native memory path.");
      return Object.freeze({ path, device: info.dev.toString(), inode: info.ino.toString() });
    });
  } catch {
    throw new LegacyMemoryErasureError("ENGINE_MISMATCH", "Native memory database or ancestor is missing, replaced, or not canonical.");
  }
}

function assertEngineFilePin(engine: LegacyMemoryErasureEngineBinding, pin: EngineFilePin, unknown = false): void {
  try {
    if (encode(captureEngineFilePin(engine)) === encode(pin)) return;
  } catch { /* Treat inaccessible paths as an identity mismatch. */ }
  throw new LegacyMemoryErasureError(unknown ? "RECOVERY_REQUIRED" : "ENGINE_MISMATCH",
    unknown ? "Memory effect may have run after the engine file or ancestor changed; explicit recovery is required."
      : "Native memory database or ancestor changed after its ownership pin.");
}

function callSqlHook<T>(name: string, callback: (() => T) | undefined): T | undefined {
  if (!callback) return undefined;
  const result = callback();
  if (result && typeof (result as { then?: unknown }).then === "function") {
    throw new LegacyMemoryErasureError("TRANSACTION_BOUNDARY", `${name} must be synchronous SQL-only work.`);
  }
  return result;
}

function assertSqlLease(hooks: LegacyMemoryErasureSqlHooks | undefined, database: DatabaseSync,
  context: LegacyMemoryErasureSqlContext): void {
  callSqlHook("Native erasure SQL lease assertion",
    hooks?.assertSqlLease ? () => hooks.assertSqlLease!(database, context) : undefined);
}

function assertSqlAdmission(hooks: LegacyMemoryErasureSqlHooks | undefined, database: DatabaseSync,
  context: LegacyMemoryErasureSqlContext): void {
  callSqlHook("Native erasure SQL admission",
    hooks?.assertSqlAdmission ? () => hooks.assertSqlAdmission!(database, context) : undefined);
}

function readGlobalReceipt(hooks: LegacyMemoryErasureSqlHooks | undefined, database: DatabaseSync,
  operationId: string): LegacyMemoryErasureGlobalReceipt | null | undefined {
  return callSqlHook("Native erasure global receipt read",
    hooks?.readGlobalReceipt ? () => hooks.readGlobalReceipt!(database, operationId) : undefined);
}

function validateGlobalReceipt(value: unknown, expected: LegacyMemoryErasureGlobalReceipt): boolean {
  if (value === null || value === undefined) return false;
  const parsed = parseJson(z.strictObject({
    operationId: z.string().uuid(),
    actorId: text(256),
    fingerprint: digest,
    operation: z.literal("memory.scope.forget.native"),
    result: receiptSchema,
  }), value, "Shared Core erasure receipt is malformed.");
  return parsed.operationId === expected.operationId
    && parsed.actorId === expected.actorId
    && parsed.fingerprint === expected.fingerprint
    && parsed.operation === expected.operation
    && encode(parsed.result) === encode(expected.result);
}

function sqlTransaction<T>(
  database: DatabaseSync,
  hooks: LegacyMemoryErasureSqlHooks | undefined,
  context: LegacyMemoryErasureSqlContext,
  work: () => T,
): T {
  if (database.isTransaction) {
    throw new LegacyMemoryErasureError("TRANSACTION_BOUNDARY", "Nested native erasure SQLite transactions are forbidden.");
  }
  database.exec("BEGIN IMMEDIATE");
  try {
    assertSqlLease(hooks, database, context);
    assertSqlAdmission(hooks, database, context);
    const result = work();
    if (result && typeof (result as { then?: unknown }).then === "function") {
      throw new LegacyMemoryErasureError("TRANSACTION_BOUNDARY", "Native erasure SQL callbacks must be synchronous.");
    }
    assertSqlLease(hooks, database, context);
    database.exec("COMMIT");
    return result;
  } catch (error) {
    if (database.isTransaction) database.exec("ROLLBACK");
    throw error;
  }
}

function assertGlobalReceiptAbsent(hooks: LegacyMemoryErasureSqlHooks | undefined, database: DatabaseSync,
  operationId: string): void {
  const prior = readGlobalReceipt(hooks, database, operationId);
  if (prior !== undefined && prior !== null) {
    throw new LegacyMemoryErasureError("RECEIPT_CONFLICT",
      "Operation ID already has a shared Core receipt without a matching committed local erasure.");
  }
}

function validateCommittedReplay(database: DatabaseSync, hooks: LegacyMemoryErasureSqlHooks | undefined,
  context: LegacyMemoryErasureSqlContext, receipt: LegacyMemoryErasureReceipt): void {
  if (!hooks?.authorizeReceiptReplay) {
    throw new LegacyMemoryErasureError("AUTHORITY_REQUIRED",
      "Committed erasure replay requires a synchronous live-policy authority callback.");
  }
  const expected: LegacyMemoryErasureGlobalReceipt = {
    operationId: receipt.operationId,
    actorId: receipt.actorId,
    fingerprint: context.requestSha256,
    operation: "memory.scope.forget.native",
    result: receipt,
  };
  sqlTransaction(database, hooks, context, () => {
    if (hooks?.readGlobalReceipt && !validateGlobalReceipt(
      readGlobalReceipt(hooks, database, receipt.operationId), expected)) {
      throw new LegacyMemoryErasureError("STATE_CORRUPT",
        "Committed local erasure receipt disagrees with the shared Core receipt.");
    }
    if (hooks?.authorizeReceiptReplay) {
      const allowed = callSqlHook("Native erasure committed-replay policy",
        () => hooks.authorizeReceiptReplay!(database, expected));
      if (allowed !== true) throw new LegacyMemoryErasureError("AUTHORITY_REQUIRED",
        "Current native policy does not authorize replaying this erasure receipt.");
    }
  });
}

function assertWorkspaceDatabase(storage: Storage, database: DatabaseSync, root: string): void {
  storage.assertWorkspaceLease();
  const main = database.prepare("PRAGMA database_list").all().find(row => row.name === "main");
  if (!main?.file || resolve(String(main.file)) !== join(root, "core.sqlite")) {
    throw new LegacyMemoryErasureError("WORKSPACE_MISMATCH", "Native erasure ledger is not in the leased workspace database.");
  }
  const version = Number(database.prepare("PRAGMA user_version").get()?.user_version);
  if (!supportedDatabaseVersions.has(version)) {
    throw new LegacyMemoryErasureError("SCHEMA_MISMATCH", "Native erasure requires the current initialized workspace schema.");
  }
}

function ensureLedger(database: DatabaseSync, workspaceId: string): void {
  database.exec("BEGIN IMMEDIATE");
  try {
    const inspection = validateLegacyMemoryErasureLedger(database, workspaceId);
    if (inspection.state === "uninitialized") {
      if (!ledgerSchemaPresent(database)) database.exec(LEGACY_MEMORY_ERASURE_DDL);
      assertExactLedgerSchema(database);
      if (!ledgerIsEmpty(database)) {
        throw new LegacyMemoryErasureError("STATE_CORRUPT", "Native memory-erasure ledger is not pristine.");
      }
      database.prepare("INSERT INTO legacy_memory_erasure_schema(singleton,version) VALUES(1,?)").run(schemaVersion);
      database.prepare("INSERT INTO legacy_memory_erasure_state(singleton,workspace_id,epoch) VALUES(1,?,0)")
        .run(workspaceId);
    }
    database.exec("COMMIT");
  } catch (error) {
    if (database.isTransaction) database.exec("ROLLBACK");
    throw error;
  }
}

function normalizeSqlRows(rows: Array<Record<string, unknown>>): unknown[] {
  return rows.map(row => Object.fromEntries(Object.keys(row).sort().map(key => {
    const value = row[key];
    if (value instanceof Uint8Array) return [key, { bytes: value.byteLength, sha256: sha256(Buffer.from(value)) }];
    return [key, value];
  })));
}

function readScopeSnapshot(database: DatabaseSync, identity: string, scope: string) {
  const targetPieces = database.prepare("SELECT * FROM pieces WHERE scope=? ORDER BY id").all(scope) as Array<Record<string, unknown>>;
  const targetSources = database.prepare("SELECT * FROM sources WHERE chat=? ORDER BY id").all(scope) as Array<Record<string, unknown>>;
  const statementRows = database.prepare(`
    SELECT DISTINCT s.* FROM statements s
    WHERE s.piece IN (SELECT id FROM pieces WHERE scope=?)
       OR EXISTS (
         SELECT 1 FROM provenance p JOIN sources r ON r.id=p.source
         WHERE p.statement=s.id AND r.chat=?
       )
    ORDER BY s.id
  `).all(scope, scope) as Array<Record<string, unknown>>;
  const affectedPieces = database.prepare(`
    SELECT DISTINCT p.* FROM pieces p
    WHERE p.scope=?
       OR EXISTS (
         SELECT 1 FROM statements s JOIN provenance v ON v.statement=s.id
         JOIN sources r ON r.id=v.source
         WHERE s.piece=p.id AND r.chat=?
       )
    ORDER BY p.id
  `).all(scope, scope) as Array<Record<string, unknown>>;
  const summaries = database.prepare(`
    SELECT * FROM summaries WHERE piece IN (
      SELECT id FROM pieces WHERE scope=?
      UNION
      SELECT s.piece FROM statements s JOIN provenance v ON v.statement=s.id
      JOIN sources r ON r.id=v.source WHERE r.chat=?
    ) ORDER BY piece
  `).all(scope, scope) as Array<Record<string, unknown>>;
  const embeddings = database.prepare(`
    SELECT * FROM piece_embeddings WHERE piece IN (
      SELECT id FROM pieces WHERE scope=?
      UNION
      SELECT s.piece FROM statements s JOIN provenance v ON v.statement=s.id
      JOIN sources r ON r.id=v.source WHERE r.chat=?
    ) ORDER BY piece,representation,revision,embedding_space_id
  `).all(scope, scope) as Array<Record<string, unknown>>;
  const leases = database.prepare(`
    SELECT * FROM leases WHERE piece IN (
      SELECT id FROM pieces WHERE scope=?
      UNION
      SELECT s.piece FROM statements s JOIN provenance v ON v.statement=s.id
      JOIN sources r ON r.id=v.source WHERE r.chat=?
    ) ORDER BY id
  `).all(scope, scope) as Array<Record<string, unknown>>;
  const edges = database.prepare(`
    SELECT * FROM edges WHERE parent IN (SELECT id FROM pieces WHERE scope=?)
      OR child IN (SELECT id FROM pieces WHERE scope=?)
    ORDER BY parent,child,relation
  `).all(scope, scope) as Array<Record<string, unknown>>;
  const turns = database.prepare("SELECT * FROM turns WHERE scope=? ORDER BY id").all(scope) as Array<Record<string, unknown>>;
  const statementIds = statementRows.map(row => String(row.id));
  const sourceIds = targetSources.map(row => String(row.id));
  const provenance = statementIds.length || sourceIds.length
    ? database.prepare(`SELECT * FROM provenance WHERE statement IN (
        SELECT id FROM statements WHERE piece IN (SELECT id FROM pieces WHERE scope=?)
          OR EXISTS (SELECT 1 FROM provenance v JOIN sources r ON r.id=v.source WHERE v.statement=statements.id AND r.chat=?)
      ) OR source IN (SELECT id FROM sources WHERE chat=?) ORDER BY statement,source`)
      .all(scope, scope, scope) as Array<Record<string, unknown>>
    : [];
  const tombstone = !!database.prepare("SELECT 1 FROM deleted_chats WHERE chat=?").get(scope);
  const snapshot = {
    schema: "pkm.native-memory-scope-pin/v1",
    identity,
    targetPieces: normalizeSqlRows(targetPieces),
    targetSources: normalizeSqlRows(targetSources),
    affectedPieces: normalizeSqlRows(affectedPieces),
    statements: normalizeSqlRows(statementRows),
    provenance: normalizeSqlRows(provenance),
    summaries: normalizeSqlRows(summaries),
    embeddings: normalizeSqlRows(embeddings),
    leases: normalizeSqlRows(leases),
    edges: normalizeSqlRows(edges),
    turns: normalizeSqlRows(turns),
    tombstone,
  };
  const sourceReferences = targetSources.filter(row => Number(row.deleted) === 0).length;
  const targetIds = new Set(targetPieces.map(piece => String(piece.id)));
  const sourceStatementRows = database.prepare(`
    SELECT DISTINCT s.id,s.piece FROM statements s JOIN provenance v ON v.statement=s.id
    JOIN sources r ON r.id=v.source WHERE r.chat=? ORDER BY s.id
  `).all(scope) as Array<{ id: string; piece: string }>;
  const dependentStatements = sourceStatementRows.filter(row => !targetIds.has(String(row.piece))).length;
  return {
    pin: sha256(encode(snapshot)),
    tombstone,
    livePieces: targetPieces.filter(row => Number(row.evicted) === 0).length,
    sourceReferences,
    dependentStatements,
    sourceStatements: sourceStatementRows.length,
  };
}

function validatedJournalRows(database: DatabaseSync) {
  return database.prepare("SELECT * FROM legacy_memory_erasure_operations ORDER BY created_at,operation_id")
    .all().map(row => parseJson(journalRowSchema, row, "Native memory-erasure journal is malformed."));
}

export interface LegacyMemoryErasureLedgerInspection {
  schema: "pkm.native-memory-erasure-ledger-inspection/v1";
  state: "uninitialized" | "ready";
  workspaceId: string;
  epoch: number | null;
  operations: Array<{
    operationId: string;
    actorId: string;
    status: "pending" | "committed";
    expectedEpoch: number;
    erasureEpoch?: number;
    globalReceipt: "present" | "absent" | "not-checked";
  }>;
}

const ledgerTables = ["legacy_memory_erasure_schema", "legacy_memory_erasure_state",
  "legacy_memory_erasure_operations"] as const;
const ledgerStatements = LEGACY_MEMORY_ERASURE_DDL.split(";").map(value => value.trim()).filter(Boolean)
  .map(value => value.replace("CREATE TABLE IF NOT EXISTS ", "CREATE TABLE "));

function ledgerObjects(database: DatabaseSync) {
  return database.prepare(`SELECT type,name,tbl_name,sql FROM sqlite_master
    WHERE lower(name) GLOB 'legacy_memory_erasure_*'
       OR lower(tbl_name) IN ('legacy_memory_erasure_schema','legacy_memory_erasure_state','legacy_memory_erasure_operations')
    ORDER BY name`).all() as Array<{ type: string; name: string; tbl_name: string; sql: string | null }>;
}

function ledgerSchemaPresent(database: DatabaseSync): boolean {
  return ledgerObjects(database).length > 0;
}

function assertExactLedgerSchema(database: DatabaseSync): void {
  const expected: Array<{ type: string; name: string; tbl_name: string; sql: string | null }> =
    ledgerTables.map((name, index) => ({
    type: "table", name, tbl_name: name, sql: ledgerStatements[index],
  }));
  expected.push({ type: "index", name: "sqlite_autoindex_legacy_memory_erasure_operations_1",
    tbl_name: "legacy_memory_erasure_operations", sql: null });
  expected.sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0);
  const actual = ledgerObjects(database);
  if (actual.length !== expected.length || actual.some((row, i) =>
    row.type !== expected[i].type || row.name !== expected[i].name
      || row.tbl_name !== expected[i].tbl_name || row.sql !== expected[i].sql)) {
    throw new LegacyMemoryErasureError("STATE_CORRUPT",
      "Native memory-erasure ledger DDL or attached SQLite objects do not match the pinned schema.");
  }
}

function ledgerIsEmpty(database: DatabaseSync): boolean {
  return ledgerTables.every(table => !database.prepare(`SELECT 1 FROM ${table} LIMIT 1`).get());
}

/** Read-only ledger inspection. It never initializes tables or mutates workspace state. */
export function validateLegacyMemoryErasureLedger(
  database: DatabaseSync,
  workspaceIdValue: unknown,
  hooks?: Pick<LegacyMemoryErasureSqlHooks, "readGlobalReceipt">,
): LegacyMemoryErasureLedgerInspection {
  const workspaceId = parseInput(z.string().uuid(), workspaceIdValue, "Invalid native erasure workspace ID.");
  const uninitialized = (): LegacyMemoryErasureLedgerInspection => ({
    schema: "pkm.native-memory-erasure-ledger-inspection/v1",
    state: "uninitialized",
    workspaceId,
    epoch: null,
    operations: [],
  });
  if (!ledgerSchemaPresent(database)) {
    if (Number(database.prepare("PRAGMA user_version").get()?.user_version) >= 20) {
      throw new LegacyMemoryErasureError("STATE_CORRUPT", "Native memory-erasure DDL is missing.");
    }
    return uninitialized();
  }
  assertExactLedgerSchema(database);
  if (ledgerIsEmpty(database)) {
    return uninitialized();
  }
  const schema = database.prepare("SELECT version FROM legacy_memory_erasure_schema WHERE singleton=1").get() as
    { version?: number } | undefined;
  const state = database.prepare("SELECT workspace_id,epoch FROM legacy_memory_erasure_state WHERE singleton=1").get() as
    { workspace_id?: string; epoch?: number } | undefined;
  if (!schema || Number(schema.version) !== schemaVersion
    || !state || state.workspace_id !== workspaceId || !Number.isSafeInteger(state.epoch) || Number(state.epoch) < 0) {
    throw new LegacyMemoryErasureError("STATE_CORRUPT", "Native memory-erasure ledger schema or workspace epoch is inconsistent.");
  }
  const epoch = Number(state.epoch);
  const rows = validatedJournalRows(database);
  const seenEpochs = new Set<number>();
  const operations = rows.map(row => {
    let erasureEpoch: number | undefined;
    let globalReceipt: "present" | "absent" | "not-checked" = hooks?.readGlobalReceipt ? "absent" : "not-checked";
    let expectedReceipt: LegacyMemoryErasureGlobalReceipt | undefined;
    if (row.workspace_id !== workspaceId) {
      throw new LegacyMemoryErasureError("STATE_CORRUPT", "Native memory-erasure operation belongs to another workspace.");
    }
    if (row.status === "pending") {
      if (row.receipt_json !== null || row.expected_epoch !== epoch) {
        throw new LegacyMemoryErasureError("STATE_CORRUPT", "Pending erasure intent conflicts with the local epoch or receipt state.");
      }
    } else {
      if (!row.receipt_json) {
        throw new LegacyMemoryErasureError("STATE_CORRUPT", "Committed erasure receipt is missing.");
      }
      const receipt = parseJson(receiptSchema, JSON.parse(row.receipt_json), "Committed erasure receipt is malformed.");
      if (receipt.operationId !== row.operation_id || receipt.actorId !== row.actor_id
        || receipt.workspaceId !== row.workspace_id || receipt.scopeSha256 !== row.scope_sha256
        || receipt.sourcePin !== row.source_pin || receipt.erasureEpoch !== row.expected_epoch + 1
        || receipt.erasure !== "logical-only" || receipt.backupProtection !== "local-ledger-only"
        || seenEpochs.has(receipt.erasureEpoch)) {
        throw new LegacyMemoryErasureError("STATE_CORRUPT", "Committed erasure receipt disagrees with its journal pin.");
      }
      seenEpochs.add(receipt.erasureEpoch);
      erasureEpoch = receipt.erasureEpoch;
      expectedReceipt = {
        operationId: row.operation_id,
        actorId: row.actor_id,
        fingerprint: row.request_sha256,
        operation: "memory.scope.forget.native",
        result: receipt,
      };
    }
    if (hooks?.readGlobalReceipt) {
      const global = readGlobalReceipt(hooks, database, row.operation_id);
      if (row.status === "pending") {
        if (global) throw new LegacyMemoryErasureError("STATE_CORRUPT",
          "Pending erasure unexpectedly has a shared Core receipt.");
      } else if (!validateGlobalReceipt(global, expectedReceipt!)) {
        throw new LegacyMemoryErasureError("STATE_CORRUPT",
          "Committed erasure receipt is absent or disagrees with the shared Core receipt.");
      } else {
        globalReceipt = "present";
      }
    }
    return {
      operationId: row.operation_id,
      actorId: row.actor_id,
      status: row.status,
      expectedEpoch: row.expected_epoch,
      ...(erasureEpoch === undefined ? {} : { erasureEpoch }),
      globalReceipt,
    };
  });
  if ([...seenEpochs].some(value => value > epoch)) {
    throw new LegacyMemoryErasureError("STATE_CORRUPT", "Committed erasure receipt exceeds the local epoch.");
  }
  return {
    schema: "pkm.native-memory-erasure-ledger-inspection/v1",
    state: "ready",
    workspaceId,
    epoch,
    operations,
  };
}

function ledgerEpoch(database: DatabaseSync, workspaceId: string): number {
  const row = database.prepare("SELECT workspace_id,epoch FROM legacy_memory_erasure_state WHERE singleton=1")
    .get() as { workspace_id: string; epoch: number };
  if (row.workspace_id !== workspaceId || !Number.isSafeInteger(row.epoch) || row.epoch < 0) {
    throw new LegacyMemoryErasureError("STATE_CORRUPT", "Native memory-erasure epoch is corrupt.");
  }
  return Number(row.epoch);
}

function backupPin(value: LegacyMemoryRestorePin) {
  return parseJson(z.strictObject({
    workspaceId: z.string().uuid(),
    manifestSha256: digest,
    memoryErasureEpoch: safeInteger.nullable(),
  }), value, "Invalid workspace backup erasure pin.");
}

export function legacyMemoryBackupEpochMatches(backupEpoch: number | null, trustedEpoch: number): boolean {
  return Number.isSafeInteger(backupEpoch) && backupEpoch !== null && backupEpoch === trustedEpoch;
}

export async function assertLegacyMemoryRestoreAdmitted(
  backup: LegacyMemoryRestorePin,
  authority?: TrustedLegacyMemoryEpochAuthority,
): Promise<{ workspaceId: string; manifestSha256: string; memoryErasureEpoch: number }> {
  const pin = backupPin(backup);
  if (!authority || typeof authority.readTrustedEpoch !== "function") {
    throw new LegacyMemoryErasureError("BACKUP_AUTHORITY_REQUIRED",
      "Restore is denied without an external trusted erasure-epoch authority.");
  }
  const trusted = await authority.readTrustedEpoch({ workspaceId: pin.workspaceId });
  if (!trusted || !text(256).safeParse(trusted.authorityId).success
    || trusted.workspaceId !== pin.workspaceId || !Number.isSafeInteger(trusted.epoch) || trusted.epoch < 0
    || !legacyMemoryBackupEpochMatches(pin.memoryErasureEpoch, trusted.epoch)) {
    throw new LegacyMemoryErasureError("BACKUP_EPOCH_MISMATCH",
      "Backup erasure epoch is absent, stale, future, or not bound to this workspace.");
  }
  return { ...pin, memoryErasureEpoch: pin.memoryErasureEpoch! };
}

function parseInput<T>(schema: z.ZodType<T>, value: unknown, message: string): T {
  const parsed = schema.safeParse(value);
  if (!parsed.success) throw new LegacyMemoryErasureError("INVALID_INPUT", message);
  return parsed.data;
}

export class LegacyMemoryErasureService {
  constructor(
    private readonly storage: Storage,
    private readonly engine: LegacyMemoryErasureEngineBinding,
    private readonly host: LegacyMemoryErasureHost,
  ) {
    assertActor(host?.actorId);
    if (!engine || !engine.worker) {
      throw new LegacyMemoryErasureError("AUTHORITY_REQUIRED", "A native memory worker binding is required.");
    }
    if (!host || typeof host.acquireMemoryQuiescence !== "function") {
      throw new LegacyMemoryErasureError("AUTHORITY_REQUIRED", "A native memory ownership/quiescence lease is required.");
    }
    if (!!host.sql?.readGlobalReceipt !== !!host.sql?.writeGlobalReceipt) {
      throw new LegacyMemoryErasureError("AUTHORITY_REQUIRED",
        "Shared Core global receipt reads and writes must be configured together.");
    }
  }

  async preview(scopeValue: unknown): Promise<LegacyMemoryErasurePreview> {
    const scope = parseInput(text(1024), scopeValue, "Invalid memory scope.");
    return this.storage.withWorkspaceExclusive(async () => {
      const lease = await this.acquireMemoryLease();
      try {
        lease.assertHeld();
        const pin = captureEngineFilePin(this.engine);
        const binding = await this.workspaceBinding();
        lease.assertHeld();
        assertEngineFilePin(this.engine, pin);
        const snapshot = this.readEngineSnapshot(binding, scope);
        if (snapshot.tombstone) throw new LegacyMemoryErasureError("ALREADY_ERASED", "Memory scope is already tombstoned.");
        const database = this.storage.connectNative();
        try {
          assertWorkspaceDatabase(this.storage, database, binding.root);
          ensureLedger(database, binding.workspaceId);
          const epoch = ledgerEpoch(database, binding.workspaceId);
          return {
            schema: "pkm.native-memory-erasure-preview/v1",
            workspaceId: binding.workspaceId,
            actorId: this.host.actorId,
            scopeSha256: sha256(scope),
            sourcePin: snapshot.pin,
            expectedEpoch: epoch,
            livePieces: snapshot.livePieces,
            sourceReferences: snapshot.sourceReferences,
            dependentStatements: snapshot.dependentStatements,
            sourceStatements: snapshot.sourceStatements,
            logicalOnly: true,
          };
        } finally { database.close(); }
      } finally { await lease.release(); }
    });
  }

  async inspectPending(): Promise<Array<{
    operationId: string;
    actorId: string;
    status: "pending" | "committed";
    engineState: "not-applied" | "applied";
    erasureEpoch?: number;
  }>> {
    return this.storage.withWorkspaceExclusive(async () => {
      const lease = await this.acquireMemoryLease();
      try {
        lease.assertHeld();
        const pin = captureEngineFilePin(this.engine);
        const binding = await this.workspaceBinding();
        lease.assertHeld();
        assertEngineFilePin(this.engine, pin);
        const database = this.storage.connectNative();
        try {
          assertWorkspaceDatabase(this.storage, database, binding.root);
          ensureLedger(database, binding.workspaceId);
          const rows = validatedJournalRows(database);
          const engineDb = this.openEngineDatabase(binding);
          try {
            const deleted = engineDb.prepare("SELECT chat FROM deleted_chats").all() as Array<{ chat: string }>;
            const deletedHashes = new Set(deleted.map(row => sha256(row.chat)));
            return rows.map(row => {
              const engineState = deletedHashes.has(row.scope_sha256) ? "applied" : "not-applied";
              if (row.status === "committed") {
                if (engineState !== "applied" || !row.receipt_json) {
                  throw new LegacyMemoryErasureError("STATE_CORRUPT",
                    "Committed erasure receipt disagrees with the memory-engine tombstone.");
                }
                const receipt = parseJson(receiptSchema, JSON.parse(row.receipt_json), "Erasure receipt is malformed.");
                if (receipt.operationId !== row.operation_id || receipt.actorId !== row.actor_id
                  || receipt.workspaceId !== row.workspace_id || receipt.scopeSha256 !== row.scope_sha256
                  || receipt.sourcePin !== row.source_pin) {
                  throw new LegacyMemoryErasureError("STATE_CORRUPT", "Erasure receipt disagrees with its journal pin.");
                }
                return { operationId: row.operation_id, actorId: row.actor_id, status: row.status,
                  engineState, erasureEpoch: receipt.erasureEpoch };
              }
              return { operationId: row.operation_id, actorId: row.actor_id, status: row.status, engineState };
            });
          } finally { engineDb.close(); }
        } finally { database.close(); }
      } finally { await lease.release(); }
    });
  }

  async forget(inputValue: unknown): Promise<LegacyMemoryErasureReceipt> {
    const input = parseInput(forgetInput, inputValue, "Memory erasure arguments are invalid.");
    return this.storage.withWorkspaceExclusive(async () => {
      const lease = await this.acquireMemoryLease();
      try {
        lease.assertHeld();
        const pin = captureEngineFilePin(this.engine);
        const binding = await this.workspaceBinding();
        lease.assertHeld();
        assertEngineFilePin(this.engine, pin);
        const database = this.storage.connectNative();
        try {
          assertWorkspaceDatabase(this.storage, database, binding.root);
          ensureLedger(database, binding.workspaceId);
          this.inspectJournalEngineState(binding, validatedJournalRows(database));
          const scopeSha256 = sha256(input.scope);
          const operationRoot = this.engine.originalOperationRoot?.(input.operationId) ?? binding.root;
          const operationRootSha256 = sha256(operationRoot);
          const requestSha256 = sha256(encode({
            schema: "pkm.native-memory-forget-request/v1",
            operationId: input.operationId,
            actorId: this.host.actorId,
            workspaceId: binding.workspaceId,
            rootSha256: operationRootSha256,
            scopeSha256,
            expectedSourcePin: input.expectedSourcePin,
            expectedEpoch: input.expectedEpoch,
          }));
          const sqlContext: LegacyMemoryErasureSqlContext = {
            operationId: input.operationId,
            actorId: this.host.actorId,
            workspaceId: binding.workspaceId,
            rootSha256: operationRootSha256,
            scopeSha256,
            requestSha256,
          };
          const priorRaw = database.prepare("SELECT * FROM legacy_memory_erasure_operations WHERE operation_id=?")
            .get(input.operationId);
          if (priorRaw) {
            const prior = parseJson(journalRowSchema, priorRaw, "Native memory-erasure journal is malformed.");
            if (prior.actor_id !== this.host.actorId || prior.workspace_id !== binding.workspaceId
              || prior.root_sha256 !== operationRootSha256 || prior.scope_sha256 !== scopeSha256
              || prior.request_sha256 !== requestSha256 || prior.source_pin !== input.expectedSourcePin
              || prior.expected_epoch !== input.expectedEpoch) {
              throw new LegacyMemoryErasureError("RECEIPT_CONFLICT",
                "Operation ID is already bound to different actor, workspace, target, source pin, or arguments.");
            }
            if (prior.status === "committed") {
              if (!prior.receipt_json) throw new LegacyMemoryErasureError("STATE_CORRUPT", "Committed erasure receipt is missing.");
              const engineDb = this.openEngineDatabase(binding);
              try {
                const erased = (engineDb.prepare("SELECT chat FROM deleted_chats").all() as Array<{ chat: string }>)
                  .some(row => sha256(row.chat) === scopeSha256);
                if (!erased) throw new LegacyMemoryErasureError("STATE_CORRUPT",
                  "Committed erasure receipt has no matching memory-engine tombstone.");
              } finally { engineDb.close(); }
              const receipt = parseJson(receiptSchema, JSON.parse(prior.receipt_json), "Committed erasure receipt is malformed.");
              this.assertEffectAuthority(pin, lease, sqlContext, input.expectedEpoch, "replay");
              validateCommittedReplay(database, this.host.sql, sqlContext, receipt);
              lease.assertHeld();
              assertEngineFilePin(this.engine, pin);
              return receipt;
            }
          }

          const pending = validatedJournalRows(database).filter(row => row.status === "pending"
            && row.operation_id !== input.operationId);
          if (pending.length) {
            throw new LegacyMemoryErasureError("RECOVERY_REQUIRED",
              "Inspect every pending erasure and explicitly recover its exact actor/request before another effect.");
          }

          const engineDb = this.openEngineDatabase(binding);
          let engineApplied: boolean;
          let currentSnapshot: ReturnType<typeof readScopeSnapshot>;
          try {
            const deletedHashes = new Set((engineDb.prepare("SELECT chat FROM deleted_chats").all() as Array<{ chat: string }>)
              .map(row => sha256(row.chat)));
            engineApplied = deletedHashes.has(scopeSha256);
            currentSnapshot = readScopeSnapshot(engineDb, binding.identity, input.scope);
          } finally { engineDb.close(); }

          const epoch = ledgerEpoch(database, binding.workspaceId);
          if (!priorRaw) {
            if (epoch !== input.expectedEpoch) {
              throw new LegacyMemoryErasureError("STALE_EPOCH", "Local erasure epoch changed; reread the exact target before approval.");
            }
            if (engineApplied) throw new LegacyMemoryErasureError("ALREADY_ERASED", "Memory scope is already tombstoned.");
            if (currentSnapshot.pin !== input.expectedSourcePin) {
              throw new LegacyMemoryErasureError("STALE_SOURCE", "Memory scope changed after preview; no erasure was applied.");
            }
            if (typeof this.host.authorizeForget !== "function") {
              throw new LegacyMemoryErasureError("AUTHORITY_REQUIRED", "Native human exact-target erasure approval is required.");
            }
            const authorizationRequest: Readonly<LegacyMemoryForgetAuthorizationRequest> = Object.freeze({
              schema: "pkm.native-memory-erasure-authorization/v1",
              operationId: input.operationId,
              actorId: this.host.actorId,
              workspaceId: binding.workspaceId,
              rootSha256: binding.rootSha256,
              scopeSha256,
              sourcePin: input.expectedSourcePin,
              expectedEpoch: input.expectedEpoch,
              livePieces: currentSnapshot.livePieces,
              sourceReferences: currentSnapshot.sourceReferences,
              dependentStatements: currentSnapshot.dependentStatements,
              sourceStatements: currentSnapshot.sourceStatements,
            });
            const authorizationRequestSha256 = sha256(encode(authorizationRequest));
            const suppliedDecision = await this.host.authorizeForget(authorizationRequest);
            if (!suppliedDecision) {
              throw new LegacyMemoryErasureError("AUTHORITY_REQUIRED",
                "Native human exact-target erasure approval was denied or unavailable.");
            }
            const decision = parseJson(authorizationSchema, suppliedDecision, "Native human erasure approval is invalid.");
            if (decision.actorId !== this.host.actorId || decision.requestSha256 !== authorizationRequestSha256) {
              throw new LegacyMemoryErasureError("AUTHORITY_REQUIRED", "Native approval is not bound to this actor and exact source pin.");
            }
            initializePending(database, {
              operationId: input.operationId,
              actorId: this.host.actorId,
              workspaceId: binding.workspaceId,
              rootSha256: binding.rootSha256,
              scopeSha256,
              requestSha256,
              sourcePin: input.expectedSourcePin,
              decisionId: decision.decisionId,
              expectedEpoch: input.expectedEpoch,
              counts: currentSnapshot,
              authorizationRequestSha256,
            }, this.host.sql, sqlContext);
          } else {
            if (epoch !== input.expectedEpoch) {
              throw new LegacyMemoryErasureError("STALE_EPOCH", "Pending erasure epoch changed; preserve the journal for review.");
            }
            if (!engineApplied && currentSnapshot.pin !== input.expectedSourcePin) {
              throw new LegacyMemoryErasureError("STALE_SOURCE", "Pending memory scope changed; preserve the journal for review.");
            }
            if (typeof this.host.authorizeForget !== "function") {
              throw new LegacyMemoryErasureError("AUTHORITY_REQUIRED",
                "Pending erasure recovery requires the same native human authority.");
            }
            const prior = parseJson(journalRowSchema, priorRaw, "Pending native memory-erasure journal is malformed.");
            const authorizationRequest: Readonly<LegacyMemoryForgetAuthorizationRequest> = Object.freeze({
              schema: "pkm.native-memory-erasure-authorization/v1",
              operationId: input.operationId,
              actorId: this.host.actorId,
              workspaceId: binding.workspaceId,
              rootSha256: binding.rootSha256,
              scopeSha256,
              sourcePin: input.expectedSourcePin,
              expectedEpoch: input.expectedEpoch,
              livePieces: prior.live_pieces,
              sourceReferences: prior.source_references,
              dependentStatements: prior.dependent_statements,
              sourceStatements: prior.source_statements,
            });
            const suppliedDecision = await this.host.authorizeForget(authorizationRequest);
            if (!suppliedDecision) {
              throw new LegacyMemoryErasureError("AUTHORITY_REQUIRED",
                "Pending erasure recovery requires explicit human approval.");
            }
            const decision = parseJson(authorizationSchema, suppliedDecision, "Pending erasure approval is invalid.");
            if (decision.actorId !== prior.actor_id || decision.decisionId !== prior.decision_id
              || decision.requestSha256 !== prior.authorization_request_sha256
              || decision.requestSha256 !== sha256(encode(authorizationRequest))) {
              throw new LegacyMemoryErasureError("AUTHORITY_REQUIRED",
                "Recovery authority differs from the original native actor, request, or decision.");
            }
          }

          assertPendingAdmission(database, this.host.sql, sqlContext);
          this.assertEffectAuthority(pin, lease, sqlContext, input.expectedEpoch, "before-effect");
          let removedStatements: number;
          if (engineApplied) {
            removedStatements = priorRaw
              ? parseJson(journalRowSchema, priorRaw, "Pending native memory-erasure journal is malformed.").source_statements
              : currentSnapshot.sourceStatements;
          } else {
            try {
              const result = await this.engine.worker.forgetScope({ scope: input.scope });
              const resultObject = parseJson(z.record(z.string(), z.unknown()), result,
                "Memory engine returned an invalid forget result.");
              removedStatements = parseJson(safeInteger, resultObject.removed_statements,
                "Memory engine returned an invalid forget count.");
              const expected = priorRaw
                ? parseJson(journalRowSchema, priorRaw, "Pending native memory-erasure journal is malformed.").source_statements
                : currentSnapshot.sourceStatements;
              if (removedStatements !== expected) {
                throw new LegacyMemoryErasureError("RECOVERY_REQUIRED",
                  "Memory engine forget count disagrees with the exact source-reference pin.");
              }
            } catch {
              throw new LegacyMemoryErasureError("RECOVERY_REQUIRED",
                "Memory forget outcome is uncertain; inspect and explicitly recover the exact actor, request, and native authority.");
            }
          }
          this.assertEffectAuthority(pin, lease, sqlContext, input.expectedEpoch, "after-effect");
          const after = this.openEngineDatabase(binding);
          try {
            const state = readScopeSnapshot(after, binding.identity, input.scope);
            if (!state.tombstone || state.livePieces !== 0 || state.sourceReferences !== 0) {
              throw new LegacyMemoryErasureError("RECOVERY_REQUIRED", "Memory engine forget postconditions are incomplete.");
            }
          } finally { after.close(); }

          const nextEpoch = input.expectedEpoch + 1;
          if (!Number.isSafeInteger(nextEpoch)) throw new LegacyMemoryErasureError("EPOCH_EXHAUSTED", "Memory erasure epoch is exhausted.");
          const receipt = parseJson(receiptSchema, {
            schema: "pkm.native-memory-erasure-receipt/v1",
            operationId: input.operationId,
            actorId: this.host.actorId,
            workspaceId: binding.workspaceId,
            scopeSha256,
            sourcePin: input.expectedSourcePin,
            removedStatements,
            erasureEpoch: nextEpoch,
            erasure: "logical-only",
            backupProtection: "local-ledger-only",
          }, "Native memory-erasure receipt is invalid.");
          commitReceipt(database, input.operationId, requestSha256, receipt, this.host.sql, sqlContext);
          return receipt;
        } finally { database.close(); }
      } finally { await lease.release(); }
    });
  }

  private assertEffectAuthority(pin: EngineFilePin, lease: LegacyMemoryErasureLease,
    context: LegacyMemoryErasureSqlContext, expectedEpoch: number,
    phase: LegacyMemoryEffectAuthorityRequest["phase"]): void {
    const unknown = phase === "after-effect";
    try {
      lease.assertHeld();
      assertEngineFilePin(this.engine, pin, unknown);
      if (typeof this.host.assertEffectAuthority !== "function") {
        throw new LegacyMemoryErasureError("AUTHORITY_REQUIRED",
          "Native effect authority for actor, epoch, all writers and engine ownership is required.");
      }
      const request: Readonly<LegacyMemoryEffectAuthorityRequest> = Object.freeze({
        ...context, expectedEpoch, phase,
        runtimeDirectory: pin[1].path, database: pin[0].path,
        directoryDevice: pin[1].device, directoryInode: pin[1].inode,
        databaseDevice: pin[0].device, databaseInode: pin[0].inode,
        ancestors: Object.freeze(pin.slice(1)),
      });
      if (callSqlHook("Native memory effect authority", () => this.host.assertEffectAuthority!(request)) !== true) {
        throw new LegacyMemoryErasureError("AUTHORITY_REQUIRED", "Native memory effect authority denied this actor or epoch.");
      }
      lease.assertHeld();
      assertEngineFilePin(this.engine, pin, unknown);
    } catch (error) {
      if (unknown) throw new LegacyMemoryErasureError("RECOVERY_REQUIRED",
        "Memory effect outcome requires explicit recovery after native ownership or authority was lost.");
      throw error;
    }
  }

  private async workspaceBinding() {
    const root = resolve(this.storage.workspaceRoot());
    this.storage.assertWorkspaceLease();
    const actualRoot = await realpath(root).catch(() => "");
    if (!actualRoot || actualRoot !== root) {
      throw new LegacyMemoryErasureError("WORKSPACE_MISMATCH", "Native erasure root is not the selected canonical workspace.");
    }
    const workspaceId = await this.storage.workspaceId();
    const rootSha256 = sha256(root);
    const workerIdentity = this.engine.worker.ready?.identity;
    if (!this.engine.worker.healthy || typeof workerIdentity !== "string"
      || workerIdentity !== this.engine.identity || workerIdentity.length > 512
      || typeof this.engine.worker.forgetScope !== "function") {
      throw new LegacyMemoryErasureError("ENGINE_MISMATCH", "Native memory worker identity changed.");
    }
    const runtimeDirectory = resolve(this.engine.runtimeDirectory);
    const databasePath = resolve(this.engine.database);
    const runtimeRelativeToRoot = relative(root, runtimeDirectory);
    const runtimeInsideWorkspace = runtimeRelativeToRoot === "" ||
      runtimeRelativeToRoot !== ".." && !runtimeRelativeToRoot.startsWith(`..${sep}`) && !isAbsolute(runtimeRelativeToRoot);
    if (!isAbsolute(this.engine.runtimeDirectory) || !isAbsolute(this.engine.database)
      || dirname(databasePath) !== runtimeDirectory || databasePath === join(root, "core.sqlite")
      || runtimeInsideWorkspace && this.engine.assertNativeAdoption?.(root, workspaceId) !== true) {
      throw new LegacyMemoryErasureError("ENGINE_MISMATCH", "Memory engine must use its dedicated external runtime database.");
    }
    const directoryStat = await lstat(runtimeDirectory).catch(() => undefined);
    const databaseStat = await lstat(databasePath).catch(() => undefined);
    if (!directoryStat?.isDirectory() || directoryStat.isSymbolicLink()
      || !databaseStat?.isFile() || databaseStat.isSymbolicLink()
      || await realpath(runtimeDirectory) !== runtimeDirectory || await realpath(databasePath) !== databasePath) {
      throw new LegacyMemoryErasureError("ENGINE_MISMATCH", "Memory engine runtime database is not a pinned regular file.");
    }
    const engineDb = this.openEngineDatabase({ root, rootSha256, workspaceId, identity: this.engine.identity });
    try {
      const metadata = engineDb.prepare("SELECT identity FROM metadata").get() as { identity?: string } | undefined;
      if (metadata?.identity !== this.engine.identity) {
        throw new LegacyMemoryErasureError("ENGINE_MISMATCH", "Memory database does not match the live native worker identity.");
      }
    } finally { engineDb.close(); }
    return { root, rootSha256, workspaceId, identity: this.engine.identity };
  }

  private async acquireMemoryLease(): Promise<LegacyMemoryErasureLease> {
    const acquire = this.host.acquireMemoryQuiescence;
    if (typeof acquire !== "function") {
      throw new LegacyMemoryErasureError("AUTHORITY_REQUIRED", "Native memory ownership/quiescence is unavailable.");
    }
    const lease = await acquire.call(this.host);
    if (!lease || typeof lease.assertHeld !== "function" || typeof lease.release !== "function") {
      throw new LegacyMemoryErasureError("AUTHORITY_REQUIRED", "Native memory quiescence lease is invalid.");
    }
    return lease;
  }

  private openEngineDatabase(binding: { root: string; rootSha256: string; workspaceId: string; identity: string }) {
    const database = new DatabaseSync(resolve(this.engine.database));
    try {
      database.exec("PRAGMA busy_timeout=5000");
      const version = Number(database.prepare("PRAGMA user_version").get()?.user_version);
      if (version !== 2) throw new LegacyMemoryErasureError("ENGINE_MISMATCH", "Memory engine schema is unsupported.");
      const metadata = database.prepare("SELECT identity FROM metadata").get() as { identity?: string } | undefined;
      if (metadata?.identity !== binding.identity) {
        throw new LegacyMemoryErasureError("ENGINE_MISMATCH", "Memory engine database identity changed.");
      }
      const requiredTables = ["pieces", "sources", "deleted_chats", "leases", "statements", "provenance",
        "edges", "summaries", "turns", "piece_embeddings", "operations", "changes"];
      const actual = new Set((database.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as
        Array<{ name: string }>).map(row => row.name));
      if (requiredTables.some(name => !actual.has(name))) {
        throw new LegacyMemoryErasureError("ENGINE_MISMATCH", "Memory engine schema is incomplete.");
      }
      return database;
    } catch (error) {
      database.close();
      throw error;
    }
  }

  private inspectJournalEngineState(
    binding: { root: string; rootSha256: string; workspaceId: string; identity: string },
    rows: ReturnType<typeof validatedJournalRows>,
  ): void {
    const database = this.openEngineDatabase(binding);
    try {
      const deletedHashes = new Set((database.prepare("SELECT chat FROM deleted_chats").all() as Array<{ chat: string }>)
        .map(row => sha256(row.chat)));
      for (const row of rows) {
        const applied = deletedHashes.has(row.scope_sha256);
        if (row.status === "committed") {
          if (!applied || !row.receipt_json) {
            throw new LegacyMemoryErasureError("STATE_CORRUPT",
              "Committed erasure receipt disagrees with the memory-engine tombstone.");
          }
          const receipt = parseJson(receiptSchema, JSON.parse(row.receipt_json), "Erasure receipt is malformed.");
          if (receipt.operationId !== row.operation_id || receipt.actorId !== row.actor_id
            || receipt.workspaceId !== row.workspace_id || receipt.scopeSha256 !== row.scope_sha256
            || receipt.sourcePin !== row.source_pin) {
            throw new LegacyMemoryErasureError("STATE_CORRUPT", "Erasure receipt disagrees with its journal pin.");
          }
        }
      }
    } finally { database.close(); }
  }

  private readEngineSnapshot(binding: { root: string; rootSha256: string; workspaceId: string; identity: string }, scope: string) {
    const database = this.openEngineDatabase(binding);
    try { return readScopeSnapshot(database, binding.identity, scope); }
    finally { database.close(); }
  }
}

function initializePending(database: DatabaseSync, input: {
  operationId: string;
  actorId: string;
  workspaceId: string;
  rootSha256: string;
  scopeSha256: string;
  requestSha256: string;
  sourcePin: string;
  decisionId: string;
  expectedEpoch: number;
  counts: ReturnType<typeof readScopeSnapshot>;
  authorizationRequestSha256: string;
}, hooks: LegacyMemoryErasureSqlHooks | undefined, context: LegacyMemoryErasureSqlContext): void {
  sqlTransaction(database, hooks, context, () => {
    assertGlobalReceiptAbsent(hooks, database, input.operationId);
    const currentEpoch = ledgerEpoch(database, input.workspaceId);
    if (currentEpoch !== input.expectedEpoch) throw new LegacyMemoryErasureError("STALE_EPOCH", "Native erasure epoch changed.");
    database.prepare(`INSERT INTO legacy_memory_erasure_operations(
      operation_id,actor_id,workspace_id,root_sha256,scope_sha256,request_sha256,source_pin,
      decision_id,expected_epoch,live_pieces,source_references,dependent_statements,source_statements,
      authorization_request_sha256,status,receipt_json,created_at,updated_at
    ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,'pending',NULL,?,?)`).run(
      input.operationId, input.actorId, input.workspaceId, input.rootSha256, input.scopeSha256,
      input.requestSha256, input.sourcePin, input.decisionId, input.expectedEpoch, input.counts.livePieces,
      input.counts.sourceReferences, input.counts.dependentStatements, input.counts.sourceStatements,
      input.authorizationRequestSha256, Date.now(), Date.now());
  });
}

function assertPendingAdmission(database: DatabaseSync, hooks: LegacyMemoryErasureSqlHooks | undefined,
  context: LegacyMemoryErasureSqlContext): void {
  sqlTransaction(database, hooks, context, () => {
    const row = database.prepare(`SELECT actor_id,workspace_id,root_sha256,scope_sha256,request_sha256,status
      FROM legacy_memory_erasure_operations WHERE operation_id=?`).get(context.operationId) as {
      actor_id: string; workspace_id: string; root_sha256: string; scope_sha256: string;
      request_sha256: string; status: string;
    } | undefined;
    if (!row || row.actor_id !== context.actorId || row.workspace_id !== context.workspaceId
      || row.root_sha256 !== context.rootSha256 || row.scope_sha256 !== context.scopeSha256
      || row.request_sha256 !== context.requestSha256 || row.status !== "pending") {
      throw new LegacyMemoryErasureError("RECOVERY_REQUIRED",
        "Exact pending erasure intent changed before the memory effect.");
    }
    assertGlobalReceiptAbsent(hooks, database, context.operationId);
  });
}

function commitReceipt(database: DatabaseSync, operationId: string, requestSha256: string,
  receipt: LegacyMemoryErasureReceipt, hooks: LegacyMemoryErasureSqlHooks | undefined,
  context: LegacyMemoryErasureSqlContext): void {
  sqlTransaction(database, hooks, context, () => {
    const row = database.prepare("SELECT request_sha256,status FROM legacy_memory_erasure_operations WHERE operation_id=?")
      .get(operationId) as { request_sha256: string; status: string } | undefined;
    if (!row || row.request_sha256 !== requestSha256 || row.status !== "pending") {
      throw new LegacyMemoryErasureError("RECOVERY_REQUIRED", "Exact pending erasure intent changed before receipt commit.");
    }
    const current = ledgerEpoch(database, receipt.workspaceId);
    if (current !== receipt.erasureEpoch - 1) {
      throw new LegacyMemoryErasureError("STALE_EPOCH", "Local erasure epoch changed before receipt commit.");
    }
    const globalReceipt: LegacyMemoryErasureGlobalReceipt = {
      operationId,
      actorId: receipt.actorId,
      fingerprint: requestSha256,
      operation: "memory.scope.forget.native",
      result: receipt,
    };
    if (hooks?.writeGlobalReceipt) {
      assertGlobalReceiptAbsent(hooks, database, operationId);
      callSqlHook("Native erasure shared Core receipt write",
        () => hooks.writeGlobalReceipt!(database, globalReceipt));
      if (!validateGlobalReceipt(readGlobalReceipt(hooks, database, operationId), globalReceipt)) {
        throw new LegacyMemoryErasureError("STATE_CORRUPT",
          "Shared Core receipt write did not persist the exact immutable erasure receipt.");
      }
    }
    const raw = encode(receipt);
    database.prepare(`UPDATE legacy_memory_erasure_operations SET status='committed',
      receipt_json=?,updated_at=? WHERE operation_id=?`).run(raw, Date.now(), operationId);
    database.prepare("UPDATE legacy_memory_erasure_state SET epoch=? WHERE singleton=1")
      .run(receipt.erasureEpoch);
  });
}
