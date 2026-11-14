import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { lstat, open, realpath } from "node:fs/promises";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";
import { encodeImportedMemoryDocument, explicitMemoryStateSchema, readMemoryRecord, type ExplicitMemoryState } from "./memory.js";
import { memoryDefinitions } from "./memory-contracts.js";
import {
  legacyMemoryImportPlanSchema, legacyMemoryImportReceiptSchema,
  type LegacyMemoryImportPlan, type LegacyMemoryImportReceipt,
} from "./domain/memory-import-contracts.js";

const maximumDatabaseBytes = 536_870_912;
const maximumRecords = 4096;
const maximumHistoryRows = 100_000;
const sourceSchema = "pkm.legacy-explicit-memory-import/v1";
const compare = (left: string, right: string) => left < right ? -1 : left > right ? 1 : 0;
const hash = (value: string | Uint8Array) => createHash("sha256").update(value).digest("hex");

export class LegacyMemoryImportError extends Error {
  constructor(readonly code: string, message: string) { super(message); this.name = "LegacyMemoryImportError"; }
}

type MemoryRow = { id: string; scope: string; revision: number; status: string; created_at: number; updated_at: number };
type RevisionRow = { memory_id: string; revision: number; content: string; sources: string; status: string; created_at: number; operation_id: string };
type EventRow = { sequence: number; memory_id: string; scope: string; revision: number; action: string; status: string; actor: string;
  decision_id: string | null; operation_id: string; created_at: number };
type OperationRow = { id: string; request_hash: string; result: string };
type SourceSnapshot = {
  sourceDatabase: string;
  sourceSize: number;
  sourceSha256: string;
  engineIdentity: string;
  device: string;
  inode: string;
  mtimeNs: string;
  ctimeNs: string;
};
type ImportedOperation = {
  operationId: string;
  method: string;
  operation: string;
  requestHash: string;
  params: Record<string, unknown>;
  fingerprint: string;
  actorId: string;
  result: Record<string, unknown>;
  committedAt: string;
};
export interface StagedLegacyMemoryImport {
  receipt: LegacyMemoryImportReceipt;
  operations: ImportedOperation[];
}

function fail(code: string, message: string): never { throw new LegacyMemoryImportError(code, message); }

function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  const entries = Object.entries(value).sort(([left], [right]) => compare(left, right));
  return `{${entries.map(([key, child]) => `${JSON.stringify(key)}:${canonicalJson(child)}`).join(",")}}`;
}

async function assertRealFilePath(path: string): Promise<string> {
  if (!isAbsolute(path)) fail("UNSAFE_PATH", "Memory Engine snapshot must be an absolute path.");
  const absolute = resolve(path);
  let current: string = sep;
  for (const component of absolute.slice(sep.length).split(sep).filter(Boolean)) {
    current = join(current, component);
    const stat = await lstat(current);
    if (current === absolute) {
      if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || (stat.mode & 0o077) !== 0
        || stat.size < 1 || stat.size > maximumDatabaseBytes) {
        fail("UNSAFE_SOURCE", "Memory Engine snapshot must be a bounded, private, unlinked regular file.");
      }
    } else if (!stat.isDirectory() || stat.isSymbolicLink()) {
      fail("UNSAFE_PATH", "Memory Engine snapshot path contains a symlink or non-directory.");
    }
  }
  if (await realpath(absolute) !== absolute) fail("UNSAFE_PATH", "Memory Engine snapshot path must be canonical.");
  return absolute;
}

async function snapshotSource(path: string): Promise<SourceSnapshot> {
  const sourceDatabase = await assertRealFilePath(path);
  for (const suffix of ["-wal", "-shm"]) {
    try { await lstat(`${sourceDatabase}${suffix}`); fail("UNQUIESCENT_SOURCE", "Memory Engine snapshot still has SQLite sidecars; use a closed, checkpointed disposable copy."); }
    catch (error) {
      if (error instanceof LegacyMemoryImportError) throw error;
      if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
    }
  }
  const before = await lstat(sourceDatabase, { bigint: true });
  const handle = await open(sourceDatabase, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0));
  try {
    const opened = await handle.stat({ bigint: true });
    const same = (value: typeof before) => value.dev === before.dev && value.ino === before.ino && value.size === before.size
      && value.mtimeNs === before.mtimeNs && value.ctimeNs === before.ctimeNs && value.nlink === 1n;
    if (!opened.isFile() || !same(opened)) fail("SOURCE_CHANGED", "Memory Engine snapshot changed before it was read.");
    const digest = createHash("sha256");
    let size = 0;
    for await (const chunk of handle.createReadStream({ autoClose: false })) {
      size += chunk.length;
      if (size > maximumDatabaseBytes) fail("LIMIT", "Memory Engine snapshot exceeds the bounded import size.");
      digest.update(chunk);
    }
    if (size !== Number(before.size) || !same(await handle.stat({ bigint: true }))
      || !same(await lstat(sourceDatabase, { bigint: true }))) fail("SOURCE_CHANGED", "Memory Engine snapshot changed while it was read.");
    const stat = await lstat(sourceDatabase, { bigint: true });
    const engineIdentity = inspectDatabase(sourceDatabase);
    const checkedAfter = await lstat(sourceDatabase, { bigint: true });
    if (!same(stat) || !same(checkedAfter)) fail("SOURCE_CHANGED", "Memory Engine snapshot changed during database inspection.");
    return {
      sourceDatabase, sourceSize: size, sourceSha256: digest.digest("hex"), engineIdentity,
      device: String(stat.dev), inode: String(stat.ino), mtimeNs: String(stat.mtimeNs), ctimeNs: String(stat.ctimeNs),
    };
  } finally { await handle.close(); }
}

function checkColumns(database: DatabaseSync, table: string, expected: string[]): void {
  const actual = database.prepare(`PRAGMA table_info("${table}")`).all().map(row => String(row.name));
  if (JSON.stringify(actual) !== JSON.stringify(expected)) fail("INVALID_ENGINE", `Original Memory Engine table ${table} has an unsupported schema.`);
}

function openImmutableDatabase(path: string): DatabaseSync {
  const uri = pathToFileURL(path);
  uri.searchParams.set("immutable", "1");
  return new DatabaseSync(uri.href, { readOnly: true });
}

function inspectDatabase(path: string): string {
  let database: DatabaseSync;
  try { database = openImmutableDatabase(path); }
  catch { fail("INVALID_ENGINE", "Memory Engine snapshot is not a readable SQLite database."); }
  try {
    if (Number(database.prepare("PRAGMA user_version").get()?.user_version) !== 2
      || database.prepare("PRAGMA integrity_check").get()?.integrity_check !== "ok") {
      fail("INVALID_ENGINE", "Memory Engine snapshot schema or integrity check failed.");
    }
    const identity = database.prepare("SELECT identity FROM metadata").get()?.identity;
    if (typeof identity !== "string" || !identity || Buffer.byteLength(identity, "utf8") > 512
      || /[\u0000-\u001f\u007f]/u.test(identity)) fail("INVALID_ENGINE", "Memory Engine snapshot identity is invalid.");
    checkColumns(database, "metadata", ["identity"]);
    checkColumns(database, "explicit_memories", ["id", "scope", "revision", "status", "created_at", "updated_at"]);
    checkColumns(database, "explicit_memory_revisions", ["memory_id", "revision", "content", "sources", "status", "created_at", "operation_id"]);
    checkColumns(database, "explicit_memory_events", ["sequence", "memory_id", "scope", "revision", "action", "status", "actor", "decision_id", "operation_id", "created_at"]);
    checkColumns(database, "operations", ["id", "request_hash", "result"]);
    return identity;
  } catch (error) {
    if (error instanceof LegacyMemoryImportError) throw error;
    fail("INVALID_ENGINE", "Memory Engine snapshot schema or integrity check failed.");
  } finally { database.close(); }
}

function operationFor(action: string): { method: string; operation: string } {
  switch (action) {
    case "proposed": return { method: "explicit_propose", operation: "memory.record.propose" };
    case "confirmed": return { method: "explicit_confirm", operation: "memory.record.confirm" };
    case "revised": return { method: "explicit_revise", operation: "memory.record.revise" };
    case "revoked": return { method: "explicit_revoke", operation: "memory.record.revoke" };
    default: return fail("INVALID_ENGINE", "Original Memory Engine contains an unsupported audit action.");
  }
}

function paramsFor(memory: MemoryRow, revision: RevisionRow, event: EventRow): Record<string, unknown> {
  if (event.action === "proposed") {
    return { id: memory.id, scope: memory.scope, content: revision.content, sources: JSON.parse(revision.sources) };
  }
  const authorization = { decision_id: event.decision_id, actor_id: event.actor };
  if (event.action === "revised") {
    return { id: memory.id, scope: memory.scope, expected_revision: revision.revision - 1,
      content: revision.content, sources: JSON.parse(revision.sources), host_authorization: authorization };
  }
  return { id: memory.id, scope: memory.scope, expected_revision: revision.revision - 1, host_authorization: authorization };
}

function validateSourceRows(path: string, actorId: string, engineIdentity: string): {
  states: Array<{ state: ExplicitMemoryState; operations: ImportedOperation[]; provenance: Record<string, string> }>;
  counts: { records: number; revisions: number; events: number; operations: number }; scopes: string[];
} {
  const database = openImmutableDatabase(path);
  try {
    const memories = database.prepare("SELECT * FROM explicit_memories ORDER BY id").all() as unknown as MemoryRow[];
    const revisions = database.prepare("SELECT * FROM explicit_memory_revisions ORDER BY memory_id,revision").all() as unknown as RevisionRow[];
    const events = database.prepare("SELECT * FROM explicit_memory_events ORDER BY sequence").all() as unknown as EventRow[];
    if (memories.length > maximumRecords || revisions.length > maximumHistoryRows || events.length > maximumHistoryRows) {
      fail("LIMIT", "Original explicit-memory history exceeds the bounded migration limits.");
    }
    const revisionsById = new Map<string, RevisionRow[]>();
    for (const revision of revisions) revisionsById.set(revision.memory_id, [...(revisionsById.get(revision.memory_id) ?? []), revision]);
    const eventByMemory = new Map<string, EventRow[]>();
    const eventByOperation = new Map<string, EventRow>();
    const sequences = new Set<number>();
    let previousSequence = 0;
    for (const event of events) {
      if (!Number.isSafeInteger(event.sequence) || event.sequence < 1 || sequences.has(event.sequence)
        || event.sequence <= previousSequence) fail("INVALID_ENGINE", "Original explicit-memory audit sequence is inconsistent.");
      sequences.add(event.sequence);
      previousSequence = event.sequence;
      if (eventByOperation.has(event.operation_id)) fail("INVALID_ENGINE", "Original explicit-memory operation is duplicated in the audit journal.");
      eventByOperation.set(event.operation_id, event);
      eventByMemory.set(event.memory_id, [...(eventByMemory.get(event.memory_id) ?? []), event]);
    }
    const readOperation = database.prepare("SELECT id,request_hash,result FROM operations WHERE id=?");
    const seenOperationIds = new Set<string>();
    const scopes = new Set<string>();
    const states: Array<{ state: ExplicitMemoryState; operations: ImportedOperation[]; provenance: Record<string, string> }> = [];
    for (const memory of memories) {
      const versions = revisionsById.get(memory.id) ?? [];
      const history = eventByMemory.get(memory.id) ?? [];
      if (!versions.length || versions.length !== history.length || versions.length !== memory.revision
        || versions.length > Number.MAX_SAFE_INTEGER || !Number.isSafeInteger(memory.revision)
        || memory.status !== versions.at(-1)?.status || !["pending", "confirmed", "revoked"].includes(memory.status)
        || !Number.isFinite(memory.created_at) || memory.created_at < 0
        || !Number.isFinite(memory.updated_at) || memory.updated_at < 0
        || memory.created_at !== versions[0]?.created_at || memory.updated_at !== versions.at(-1)?.created_at) {
        fail("INVALID_ENGINE", "Original explicit-memory current state and complete revision history disagree.");
      }
      if (!memory.id.startsWith("explicit-") || Buffer.byteLength(memory.id, "utf8") > 256
        || !memory.scope || Buffer.byteLength(memory.scope, "utf8") > 1024
        || /[\u0000-\u0008\u000b\u000c\u000e-\u001f]/u.test(memory.scope)) {
        fail("INVALID_ENGINE", "Original explicit-memory identity or scope is invalid.");
      }
      scopes.add(memory.scope);
      const parsedVersions = [];
      const importedOperations: ImportedOperation[] = [];
      let priorEvent: EventRow | undefined;
      for (const [index, revision] of versions.entries()) {
        const event = history[index]!;
        if (revision.revision !== index + 1 || event.revision !== revision.revision
          || event.memory_id !== memory.id || event.scope !== memory.scope
          || event.operation_id !== revision.operation_id || !revision.operation_id
          || Buffer.byteLength(revision.operation_id, "utf8") > 256
          || !Number.isFinite(revision.created_at) || revision.created_at < 0
          || revision.created_at !== event.created_at
          || !Number.isFinite(event.created_at) || event.created_at < 0
          || index > 0 && (event.sequence <= priorEvent!.sequence || event.created_at < priorEvent!.created_at
            || priorEvent!.status === "revoked" || event.action === "confirmed" && priorEvent!.status === "confirmed")) {
          fail("INVALID_ENGINE", "Original explicit-memory revisions violate lifecycle/audit invariants.");
        }
        const sources = JSON.parse(revision.sources) as unknown;
        const content = { content: revision.content, sources };
        const parsedContent = explicitMemoryStateSchema.shape.versions.element.pick({ content: true, sources: true }).parse(content);
        const expectedStatus = event.action === "confirmed" ? "confirmed" : event.action === "revoked" ? "revoked" : "pending";
        const expectedFirst = index === 0;
        if (revision.status !== (index < versions.length - 1 ? "superseded" : event.status)
          || event.status !== expectedStatus || (expectedFirst
            ? event.action !== "proposed" || event.actor !== "caller" || event.decision_id !== null
            : event.action === "proposed" || !event.decision_id)
          || !event.actor || Buffer.byteLength(event.actor, "utf8") > 256
          || event.decision_id !== null && (!event.decision_id || Buffer.byteLength(event.decision_id, "utf8") > 256)) {
          fail("INVALID_ENGINE", "Original explicit-memory event status or decision audit is invalid.");
        }
        const legacyOperation = operationFor(event.action);
        const params = paramsFor(memory, revision, event);
        const operationRow = readOperation.get(event.operation_id) as unknown as OperationRow | undefined;
        if (!operationRow || seenOperationIds.has(event.operation_id)
          || !/^[a-f0-9]{64}$/.test(operationRow.request_hash)
          || hash(canonicalJson([legacyOperation.method, params])) !== operationRow.request_hash) {
          fail("INVALID_ENGINE", "Original explicit-memory request hash or operation receipt is missing or inconsistent.");
        }
        seenOperationIds.add(event.operation_id);
        let legacyResult: Record<string, unknown>;
        try { legacyResult = JSON.parse(operationRow.result) as Record<string, unknown>; }
        catch { fail("INVALID_ENGINE", "Original explicit-memory operation result is invalid JSON."); }
        const expectedResult = {
          id: memory.id, scope: memory.scope, revision: revision.revision, current_revision: revision.revision,
          status: event.status, current_status: event.status, content: parsedContent.content, sources: parsedContent.sources,
          created_at: memory.created_at, updated_at: revision.created_at, revision_created_at: revision.created_at,
        };
        if (canonicalJson(legacyResult) !== canonicalJson(expectedResult)) {
          fail("INVALID_ENGINE", "Original explicit-memory operation result disagrees with its historical revision.");
        }
        const stateRevision = {
          ...parsedContent, revision: revision.revision,
          status: index < versions.length - 1 ? "superseded" as const : event.status as "pending" | "confirmed" | "revoked",
          event: {
            sequence: event.sequence, revision: event.revision, action: event.action as "proposed" | "confirmed" | "revised" | "revoked",
            status: event.status as "pending" | "confirmed" | "revoked", actor: event.actor,
            decision_id: event.decision_id, operation_id: event.operation_id, created_at: event.created_at,
          },
        };
        parsedVersions.push(stateRevision);
        const argsSchema = memoryDefinitions.find(item => item.id === legacyOperation.operation)!.input;
        let args: Record<string, unknown>;
        if (legacyOperation.operation === "memory.record.propose") {
          args = argsSchema.parse({ operation_id: event.operation_id, content: parsedContent.content, sources: parsedContent.sources }) as Record<string, unknown>;
        } else if (legacyOperation.operation === "memory.record.revise") {
          args = argsSchema.parse({
            content: parsedContent.content, sources: parsedContent.sources, id: memory.id,
            expected_revision: revision.revision - 1, operation_id: event.operation_id,
          }) as Record<string, unknown>;
        } else {
          args = argsSchema.parse({ id: memory.id, expected_revision: revision.revision - 1, operation_id: event.operation_id }) as Record<string, unknown>;
        }
        importedOperations.push({
          operationId: event.operation_id, method: legacyOperation.method, operation: legacyOperation.operation,
          requestHash: operationRow.request_hash, params, fingerprint: hash(JSON.stringify({
            operation: legacyOperation.operation, actorId, args,
          })), actorId, result: expectedResult, committedAt: String(event.created_at),
        });
        priorEvent = event;
      }
      const proposed = history[0]!;
      if (memory.id !== `explicit-${hash(`${memory.scope}\0${proposed.operation_id}`)}`) {
        fail("INVALID_ENGINE", "Original explicit-memory ID does not match its immutable scope/proposal operation.");
      }
      const state = explicitMemoryStateSchema.parse({
        schema: "pkm.explicit-memory/v1", id: memory.id, scope: memory.scope, versions: parsedVersions,
      });
      states.push({
        state, operations: importedOperations,
        provenance: {
          schema: "pkm.legacy-explicit-memory-origin/v1", sourceDatabaseSha256: "",
          engineIdentity, sourceScopeSha256: hash(memory.scope),
        },
      });
    }
    if (revisionsById.size !== memories.length || eventByMemory.size !== memories.length
      || seenOperationIds.size !== eventByOperation.size) {
      fail("INVALID_ENGINE", "Original explicit-memory tables contain orphaned revisions, events, or operation receipts.");
    }
    const total = { records: memories.length, revisions: revisions.length, events: events.length, operations: seenOperationIds.size };
    if (total.records > maximumRecords || total.revisions > maximumHistoryRows || total.events > maximumHistoryRows) {
      fail("LIMIT", "Original explicit-memory history exceeds the bounded migration limits.");
    }
    return { states, counts: total, scopes: [...scopes].sort(compare) };
  } catch (error) {
    if (error instanceof LegacyMemoryImportError) throw error;
    fail("INVALID_ENGINE", "Original explicit-memory tables could not be validated.");
  } finally { database.close(); }
}

async function validatedSource(path: string, actorId: string) {
  const snapshot = await snapshotSource(path);
  const data = validateSourceRows(snapshot.sourceDatabase, actorId, snapshot.engineIdentity);
  const current = await snapshotSource(snapshot.sourceDatabase);
  if (JSON.stringify(snapshot) !== JSON.stringify(current)) fail("SOURCE_CHANGED", "Memory Engine snapshot changed during validation.");
  return { snapshot, states: data.states, counts: data.counts, scopes: data.scopes };
}

function planDigest(plan: Omit<LegacyMemoryImportPlan, "planSha256">): string { return hash(JSON.stringify(plan)); }

export async function planLegacyMemoryImport(source: string, sourceRoot: string, actorId: string,
  continuityScopeSha256?: string): Promise<LegacyMemoryImportPlan> {
  if (!actorId || Buffer.byteLength(actorId, "utf8") > 256 || /[\u0000-\u001f\u007f]/u.test(actorId)) {
    fail("AUTHORITY_REQUIRED", "Original Memory receipt import requires the explicit current native actor ID.");
  }
  const root = resolve(sourceRoot), file = resolve(source);
  if (!isAbsolute(source) || file === root || relative(root, file).split(sep)[0] !== ".." && !isAbsolute(relative(root, file))) {
    fail("UNSAFE_PATH", "Use a separate, read-only Memory Engine snapshot outside the legacy workspace copy.");
  }
  const { snapshot, counts, scopes } = await validatedSource(file, actorId);
  if (continuityScopeSha256 !== undefined && (!/^[a-f0-9]{64}$/.test(continuityScopeSha256)
    || scopes.filter(scope => hash(scope) === continuityScopeSha256).length !== 1)) {
    fail("AUTHORITY_REQUIRED", "Continuity must explicitly select exactly one imported original repository scope by SHA-256.");
  }
  const body: Omit<LegacyMemoryImportPlan, "planSha256"> = {
    schema: sourceSchema, sourceDatabase: snapshot.sourceDatabase, sourceSize: snapshot.sourceSize,
    sourceSha256: snapshot.sourceSha256, sourceDevice: snapshot.device, sourceInode: snapshot.inode,
    sourceMtimeNs: snapshot.mtimeNs, sourceCtimeNs: snapshot.ctimeNs,
    engineIdentity: snapshot.engineIdentity, actorId,
    ...counts, scopes, ...(continuityScopeSha256 ? { continuityScopeSha256 } : {}),
  };
  return legacyMemoryImportPlanSchema.parse({ ...body, planSha256: planDigest(body) });
}

async function writeOwnedFile(path: string, bytes: Buffer): Promise<void> {
  const file = await open(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL, 0o600);
  try { await file.writeFile(bytes); await file.sync(); } finally { await file.close(); }
}

export async function stageLegacyMemoryImport(planInput: LegacyMemoryImportPlan, stage: string): Promise<StagedLegacyMemoryImport> {
  const plan = legacyMemoryImportPlanSchema.parse(planInput);
  const { planSha256, ...body } = plan;
  if (planDigest(body) !== planSha256) fail("PLAN_CHANGED", "Memory import plan was modified.");
  const data = await validatedSource(plan.sourceDatabase, plan.actorId);
  if (data.snapshot.sourceSha256 !== plan.sourceSha256 || data.snapshot.sourceSize !== plan.sourceSize
    || data.snapshot.engineIdentity !== plan.engineIdentity || data.snapshot.device !== plan.sourceDevice
    || data.snapshot.inode !== plan.sourceInode || data.snapshot.mtimeNs !== plan.sourceMtimeNs
    || data.snapshot.ctimeNs !== plan.sourceCtimeNs || JSON.stringify(data.counts) !== JSON.stringify({
      records: plan.records, revisions: plan.revisions, events: plan.events, operations: plan.operations,
    }) || JSON.stringify(data.scopes) !== JSON.stringify(plan.scopes)) {
    fail("SOURCE_CHANGED", "Original Memory Engine no longer matches the digest-bound import plan.");
  }
  const base = resolve(stage);
  const memoryRoot = join(base, "notes", "System", "Memory");
  const directoryParts = relative(base, memoryRoot).split(sep);
  let current = base;
  for (const part of directoryParts) {
    current = join(current, part);
    try { await import("node:fs/promises").then(fs => fs.mkdir(current, { mode: 0o700 })); }
    catch (error) { if (!(error instanceof Error && "code" in error && error.code === "EEXIST")) throw error; }
    const stat = await lstat(current);
    if (!stat.isDirectory() || stat.isSymbolicLink()) fail("STAGING_INVALID", "Memory Markdown staging path must remain a real directory.");
  }
  const documents: LegacyMemoryImportReceipt["documents"] = [];
  const operations: ImportedOperation[] = [];
  for (const item of data.states) {
    const state = item.state;
    const document = encodeImportedMemoryDocument(state, {
      ...item.provenance, sourceDatabaseSha256: plan.sourceSha256,
    });
    const record = readMemoryRecord(document);
    const path = `${document.record.path}`;
    await writeOwnedFile(join(base, "notes", ...path.split("/")), Buffer.from(document.raw, "utf8"));
    documents.push({ id: state.id, path: `notes/${path}`, sha256: document.record.sha256 });
    for (const imported of item.operations) operations.push({
      ...imported,
      result: { ...imported.result, documentSha256: document.record.sha256 },
    });
    if (record.scope !== state.scope) fail("STAGING_INVALID", "Imported Memory scope changed while building Markdown.");
  }
  const { receiptSha256: _receiptSha256, ...receiptBody } = legacyMemoryImportReceiptSchema.parse({
    schema: "pkm.legacy-explicit-memory-import-receipt/v1", sourceDatabaseSha256: plan.sourceSha256,
    engineIdentity: plan.engineIdentity, actorId: plan.actorId, records: plan.records, revisions: plan.revisions,
    events: plan.events, operations: plan.operations, scopes: plan.scopes, documents, receiptSha256: "0".repeat(64),
  });
  const receipt = legacyMemoryImportReceiptSchema.parse({ ...receiptBody, receiptSha256: hash(JSON.stringify(receiptBody)) });
  const after = await validatedSource(plan.sourceDatabase, plan.actorId);
  if (after.snapshot.sourceSha256 !== plan.sourceSha256 || after.snapshot.sourceSize !== plan.sourceSize) {
    fail("SOURCE_CHANGED", "Original Memory Engine changed while Markdown was staged.");
  }
  return { receipt, operations };
}

export function persistLegacyMemoryImport(database: DatabaseSync, workspaceId: string, imported: StagedLegacyMemoryImport): void {
  if (!workspaceId) fail("STAGING_INVALID", "Imported Memory receipts require a staged workspace identity.");
  database.exec(`
    CREATE TABLE IF NOT EXISTS legacy_memory_imports(
      singleton INTEGER PRIMARY KEY CHECK(singleton=1), workspace_id TEXT NOT NULL,
      source_sha256 TEXT NOT NULL, engine_identity TEXT NOT NULL, actor_id TEXT NOT NULL,
      receipt_sha256 TEXT NOT NULL, receipt_json TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS legacy_memory_import_operations(
      operation_id TEXT PRIMARY KEY, source_sha256 TEXT NOT NULL, method TEXT NOT NULL,
      request_hash TEXT NOT NULL, params_json TEXT NOT NULL, result_json TEXT NOT NULL
    );
  `);
  database.prepare("INSERT INTO legacy_memory_imports VALUES(1,?,?,?,?,?,?)").run(
    workspaceId, imported.receipt.sourceDatabaseSha256, imported.receipt.engineIdentity,
    imported.receipt.actorId, imported.receipt.receiptSha256, JSON.stringify(imported.receipt),
  );
  for (const operation of imported.operations) {
    database.prepare("INSERT INTO legacy_memory_import_operations VALUES(?,?,?,?,?,?)").run(
      operation.operationId, imported.receipt.sourceDatabaseSha256, operation.method,
      operation.requestHash, JSON.stringify(operation.params), JSON.stringify(operation.result),
    );
    database.prepare("INSERT INTO receipts(operation_id,fingerprint,result,actor_id,operation,committed_at) VALUES(?,?,?,?,?,?)").run(
      operation.operationId, operation.fingerprint, JSON.stringify(operation.result),
      operation.actorId, operation.operation, operation.committedAt,
    );
  }
}

export function readLegacyMemoryImportReceipt(database: DatabaseSync, workspaceId: string): LegacyMemoryImportReceipt | undefined {
  const row = database.prepare("SELECT workspace_id,receipt_json FROM legacy_memory_imports WHERE singleton=1").get() as
    { workspace_id: string; receipt_json: string } | undefined;
  if (!row) return undefined;
  if (row.workspace_id !== workspaceId) fail("STAGING_INVALID", "Imported Memory receipt belongs to a different workspace.");
  const receipt = legacyMemoryImportReceiptSchema.parse(JSON.parse(row.receipt_json));
  const { receiptSha256, ...body } = receipt;
  if (hash(JSON.stringify(body)) !== receiptSha256) fail("STAGING_INVALID", "Imported Memory receipt integrity check failed.");
  return receipt;
}

export type { LegacyMemoryImportPlan, LegacyMemoryImportReceipt };
