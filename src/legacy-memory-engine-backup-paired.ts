import { createHash, randomUUID } from "node:crypto";
import { constants, lstatSync, readFileSync } from "node:fs";
import { chmod, copyFile, lstat, mkdir, open, readFile, readdir, realpath, rename, rm } from "node:fs/promises";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { coreDatabaseFiles, coreDatabasePath } from "./workspace-storage-paths.js";
import { DatabaseSync } from "node:sqlite";
import { assertPairedMemoryWorkspaceIdle, type WorkspaceQuiescenceLease } from "./workspace-backup.js";
import { LegacyMemoryErasureOwnedWorker, type LegacyMemoryOwnedFixturePolicy } from "./legacy-memory-erasure-worker.js";
import { normalizeEngineSnapshot, verifyEngineDatabase } from "./legacy-memory-engine-backup.js";
import { validateLegacyMemoryErasureLedger } from "./legacy-memory-erasure.js";
import { acquireLinuxRootWriterFence, assertLinuxRootOwnerMarker } from "./linux-root-writer-fence.js";
import type { Storage } from "./storage.js";

const manifestName = ".pkm-paired-memory-backup.json";
const adoptionName = ".pkm-native-memory-adoption.json";
const publicationName = ".pkm-native-memory-publication.json";
const engineRelative = "packages/.pkm-native-memory/memory.sqlite3";
const hash = (value: string | Uint8Array) => createHash("sha256").update(value).digest("hex");
type File = { path: string; size: number; sha256: string };
type Pin = { dev: string; ino: string };
interface Manifest {
  schema: "pkm.paired-memory-backup/v1";
  workspaceId: string;
  operationId: string;
  actorId: string;
  sourceRoot: string;
  sourceRootPin: Pin;
  sourceDatabasePin: Pin;
  engine: { identity: string; database: string; pin: Pin; schema: 2; schemaSha256: string; tablesSha256: string };
  epoch: number;
  ledgerSha256: string;
  roots: Record<string, string>;
  receiptPins: Record<string, { journalSha256: string; globalSha256: string }>;
  files: File[];
  directories: string[];
}
export interface PairedMemoryAuthorityRequest {
  schema: "pkm.native-paired-memory-authority/v1";
  phase: "snapshot" | "stage" | "publish" | "open" | "resume";
  actorId: string;
  workspaceId: string;
  operationId: string;
  epoch: number;
  sourceRoot: string;
  destination: string;
  sourceRootPin: Pin;
  sourceDatabasePin: Pin;
  sourceEngine: Manifest["engine"];
  destinationParentPin: Pin;
  engineIdentity: string;
  manifestSha256: string | null;
  ledgerSha256: string;
  engineSeal?: PairedMemoryEngineSeal;
}
export interface PairedMemoryEngineSeal {
  state: "live" | "closed";
  manifestSha256: string;
  databasePin: Pin;
  epoch: number;
  schemaSha256: string;
  tablesSha256: string;
  ledgerSha256: string;
  size: number;
  sha256: string;
}
export interface PairedMemoryFixtureAuthority {
  scope: "exclusive-native-disposable-fixture";
  restoredEngineLayout: "native-controlled-inside-workspace";
  actorId: string;
  python: string;
  readonly ownedWorker: LegacyMemoryErasureOwnedWorker;
  engineStateAuthority: {
    /** Native state outside both restore targets; commit must durably persist before returning true. */
    read(request: Readonly<PairedMemoryAuthorityRequest>): PairedMemoryEngineSeal | null;
    commit(request: Readonly<PairedMemoryAuthorityRequest>, seal: Readonly<PairedMemoryEngineSeal>): boolean;
  };
  assertOwnership(request: Readonly<PairedMemoryAuthorityRequest>): boolean;
  authorize(request: Readonly<PairedMemoryAuthorityRequest>): {
    authorityId: string; actorId: string; requestSha256: string; expiresAt: number; trustedEpoch: number;
  } | null;
  acquireQuiescence(): Promise<WorkspaceQuiescenceLease>;
  publishNoReplace(stage: string, destination: string): Promise<void>;
}
export class PairedMemoryBackupError extends Error {
  constructor(readonly code: string, message: string) { super(message); this.name = "PairedMemoryBackupError"; }
}
async function pin(path: string, directory: boolean): Promise<Pin> {
  const stat = await lstat(path, { bigint: true });
  if (stat.isSymbolicLink() || (directory ? !stat.isDirectory() : !stat.isFile()) || await realpath(path) !== path)
    throw new PairedMemoryBackupError("UNSAFE_PATH", "Only canonical native-owned regular paths are admitted.");
  return { dev: String(stat.dev), ino: String(stat.ino) };
}
function equal(a: unknown, b: unknown) { return JSON.stringify(a) === JSON.stringify(b); }
function check(policy: PairedMemoryFixtureAuthority, request: PairedMemoryAuthorityRequest): void {
  const frozen = Object.freeze(structuredClone(request));
  if (!policy || policy.scope !== "exclusive-native-disposable-fixture" || !policy.actorId
    || policy.restoredEngineLayout !== "native-controlled-inside-workspace"
    || !(policy.ownedWorker instanceof LegacyMemoryErasureOwnedWorker)
    || typeof policy.engineStateAuthority?.read !== "function" || typeof policy.engineStateAuthority?.commit !== "function"
    || typeof policy.assertOwnership !== "function" || typeof policy.authorize !== "function"
    || request.actorId !== policy.actorId || policy.assertOwnership(frozen) !== true)
    throw new PairedMemoryBackupError("AUTHORITY_REQUIRED", "Explicit exclusive native fixture parent, actor, and writer ownership are required.");
  const decision = policy.authorize(frozen);
  if (!decision || !decision.authorityId || decision.actorId !== request.actorId
    || decision.requestSha256 !== hash(JSON.stringify(request)) || decision.trustedEpoch !== request.epoch
    || !Number.isSafeInteger(decision.expiresAt) || decision.expiresAt <= Date.now())
    throw new PairedMemoryBackupError("AUTHORITY_REQUIRED", "Independent native epoch and exact source/adoption authority denied this operation.");
}
async function sync(path: string) {
  const handle = await open(path, constants.O_RDONLY);
  try { await handle.sync(); } finally { await handle.close(); }
}
async function write(path: string, bytes: Uint8Array) {
  const handle = await open(path, "wx", 0o600);
  try { await handle.writeFile(bytes); await handle.sync(); } finally { await handle.close(); }
}
async function finalizePublication(root: string, manifestSha256: string) {
  const scratch = join(root, `.pkm-memory-publication-${randomUUID()}`);
  await write(scratch, Buffer.from(JSON.stringify({ state: "committed", manifestSha256 })));
  await rename(scratch, join(root, publicationName));
  await sync(root);
}
function rows(database: DatabaseSync): { schema: string; tables: string } {
  const objects = database.prepare("SELECT type,name,tbl_name,sql FROM sqlite_master ORDER BY name").all();
  const tables = database.prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").all();
  const values = tables.map(item => {
    const name = String(item.name).replaceAll('"', '""');
    return [item.name, database.prepare(`SELECT * FROM "${name}"`).all()
      .map(row => JSON.stringify(row, (_key, value) => value instanceof Uint8Array ? Array.from(value) : value)).sort()];
  });
  return { schema: hash(JSON.stringify(objects)), tables: hash(JSON.stringify(values)) };
}
async function engineArtifact(database: string, identity: string) {
  const file = await verifyEngineDatabase(database, identity);
  const db = new DatabaseSync(database, { readOnly: true });
  try { return { ...file, ...rows(db) }; } finally { db.close(); }
}
function ledger(database: DatabaseSync, workspaceId: string) {
  const validated = validateLegacyMemoryErasureLedger(database, workspaceId, {
    readGlobalReceipt(db, id) {
      const row = db.prepare("SELECT * FROM receipts WHERE operation_id=?").get(id);
      return row?.operation === "memory.scope.forget.native" ? {
        operation: "memory.scope.forget.native", operationId: String(row.operation_id),
        actorId: String(row.actor_id), fingerprint: String(row.fingerprint), result: JSON.parse(String(row.result)),
      } : null;
    },
  });
  if (validated.operations.some(item => item.status !== "committed"))
    throw new PairedMemoryBackupError("PENDING_JOURNAL", "Pending erasure effects block paired snapshots.");
  const exact = database.prepare("SELECT * FROM legacy_memory_erasure_operations ORDER BY operation_id").all();
  return { epoch: validated.epoch ?? 0, sha256: hash(JSON.stringify(exact)), operations: exact };
}
function assertEngineErasureState(database: DatabaseSync, operations: Array<Record<string, unknown>>) {
  const tombstones = new Set(database.prepare("SELECT chat FROM deleted_chats").all().map(item => hash(String(item.chat))));
  for (const item of operations) if (!tombstones.has(String(item.scope_sha256)))
    throw new PairedMemoryBackupError("ENGINE_MISMATCH", "Committed immutable forget receipt has no corresponding engine tombstone.");
}
function receiptPins(database: DatabaseSync, operations: Array<Record<string, unknown>>) {
  return Object.fromEntries(operations.map(item => {
    const operationId = String(item.operation_id);
    const global = database.prepare("SELECT * FROM receipts WHERE operation_id=?").get(operationId);
    if (!global) throw new PairedMemoryBackupError("LINEAGE_MISMATCH", "Immutable erasure receipt is absent from the shared Core ledger.");
    return [operationId, { journalSha256: hash(JSON.stringify(item)), globalSha256: hash(JSON.stringify(global)) }];
  }));
}
async function inventory(root: string, live: boolean, nativeScratch?: string): Promise<{ files: File[]; directories: string[] }> {
  const files: File[] = [], directories: string[] = [];
  let total = 0;
  const visit = async (path: string, prefix: string, depth: number) => {
    if (depth > 32) throw new PairedMemoryBackupError("QUOTA_EXCEEDED", "Fixture inventory depth exceeded.");
    for (const name of (await readdir(path)).sort()) {
      const relative = prefix ? `${prefix}/${name}` : name;
      if (live && process.platform === "linux" && relative === ".pkm-next-writer-fenced.json") {
        // Ownership binds this live inode/path, not portable backup bytes; restore binds its own stage under flock.
        await assertLinuxRootOwnerMarker(root);
        continue;
      }
      if (relative === manifestName || relative === adoptionName || relative === publicationName
        || live && [...coreDatabaseFiles, engineRelative,
          `${engineRelative}-wal`, `${engineRelative}-shm`].includes(relative)) continue;
      const full = join(path, name);
      if (live && prefix === "packages/.pkm-native-memory" && name.startsWith(".pkm-memory-snapshot-")) {
        if (full === nativeScratch) continue;
        throw new PairedMemoryBackupError("RECOVERY_REQUIRED", "Unrecognized native engine snapshot staging requires explicit reconciliation.");
      }
      const info = await lstat(full);
      if (info.isSymbolicLink() || !info.isFile() && !info.isDirectory())
        throw new PairedMemoryBackupError("UNSAFE_PATH", "Snapshot inventory contains unsupported entries.");
      if (!live && (info.mode & 0o777) !== (info.isDirectory() ? 0o700 : 0o600))
        throw new PairedMemoryBackupError("UNSAFE_PATH", "Paired snapshot entries must retain private native-controlled modes.");
      if (info.isDirectory()) { directories.push(relative); await visit(full, relative, depth + 1); }
      else {
        total += info.size;
        if (files.length >= 10_000 || info.size > 256 * 1024 * 1024 || total > 1024 * 1024 * 1024)
          throw new PairedMemoryBackupError("QUOTA_EXCEEDED", "Paired fixture snapshot quota exceeded.");
        files.push({ path: relative, size: info.size, sha256: hash(await readFile(full)) });
      }
    }
  };
  await visit(root, "", 0);
  return { files: files.sort((a, b) => a.path.localeCompare(b.path)), directories: directories.sort() };
}
async function inventoryIdentity(root: string, entries: Awaited<ReturnType<typeof inventory>>) {
  return Promise.all([...entries.files.map(item => item.path), ...entries.directories].sort().map(async path => {
    const stat = await lstat(join(root, path), { bigint: true });
    if (stat.isSymbolicLink()) throw new PairedMemoryBackupError("SOURCE_CHANGED", "Pinned fixture inventory became a symlink.");
    return [path, String(stat.dev), String(stat.ino), String(stat.mode),
      ...(stat.isDirectory() ? [] : [String(stat.size), String(stat.mtimeNs)])];
  }));
}
async function syncTree(root: string, directories: string[]) {
  for (const directory of [...directories].sort((a, b) => b.length - a.length)) await sync(join(root, directory));
  await sync(root);
}
async function inspect(root: string, allowPending = false) {
  const rootPin = await pin(root, true);
  await pin(join(root, manifestName), false);
  const bytes = await readFile(join(root, manifestName));
  const manifest = JSON.parse(bytes.toString()) as Manifest;
  if (!allowPending) {
    await pin(join(root, publicationName), false);
    const publication = JSON.parse((await readFile(join(root, publicationName))).toString());
    if (publication.state !== "committed" || publication.manifestSha256 !== hash(bytes))
      throw new PairedMemoryBackupError("RECOVERY_REQUIRED", "Native paired publication has not been durably confirmed.");
  }
  if (manifest.schema !== "pkm.paired-memory-backup/v1" || !Number.isSafeInteger(manifest.epoch) || manifest.epoch < 0
    || manifest.engine?.schema !== 2 || !/^[0-9a-f-]{36}$/i.test(manifest.workspaceId)
    || !equal(await inventory(root, false), { files: manifest.files, directories: manifest.directories }))
    throw new PairedMemoryBackupError("INVALID_BACKUP", "Paired artifact manifest or exact file inventory is invalid.");
  const marker = JSON.parse((await readFile(join(root, ".pkm-next-workspace"))).toString());
  if (marker.id !== manifest.workspaceId || marker.schema !== "pkm.next-workspace/v2")
    throw new PairedMemoryBackupError("WORKSPACE_MISMATCH", "Workspace identity does not match the paired artifact.");
  const artifact = await engineArtifact(join(root, engineRelative), manifest.engine.identity);
  const db = new DatabaseSync(coreDatabasePath(root), { readOnly: true });
  try {
    if (![21, 22, 23].includes(Number(db.prepare("PRAGMA user_version").get()?.user_version))
      || db.prepare("PRAGMA integrity_check").get()?.integrity_check !== "ok")
      throw new PairedMemoryBackupError("SCHEMA_MISMATCH", "Paired core snapshot is not a supported schema21/22/23 input.");
    assertPairedMemoryWorkspaceIdle(db, manifest.workspaceId);
    const state = ledger(db, manifest.workspaceId);
    if (state.epoch !== manifest.epoch || state.sha256 !== manifest.ledgerSha256
      || state.operations.some(item => typeof manifest.roots[String(item.operation_id)] !== "string")
      || !equal(receiptPins(db, state.operations), manifest.receiptPins))
      throw new PairedMemoryBackupError("LINEAGE_MISMATCH", "Immutable erasure receipts or ancestry differ from the manifest.");
    for (const item of state.operations) if (hash(manifest.roots[String(item.operation_id)]) !== item.root_sha256)
      throw new PairedMemoryBackupError("LINEAGE_MISMATCH", "Original immutable receipt root differs from adoption ancestry.");
  } finally { db.close(); }
  const engine = new DatabaseSync(join(root, engineRelative), { readOnly: true });
  try {
    if (artifact.schema !== manifest.engine.schemaSha256 || artifact.tables !== manifest.engine.tablesSha256)
      throw new PairedMemoryBackupError("ENGINE_MISMATCH", "Engine schema, references, invalidation, or table state differs.");
    const core = new DatabaseSync(coreDatabasePath(root), { readOnly: true });
    try { assertEngineErasureState(engine, ledger(core, manifest.workspaceId).operations); }
    finally { core.close(); }
  } finally { engine.close(); }
  if (!equal(await pin(root, true), rootPin))
    throw new PairedMemoryBackupError("SOURCE_CHANGED", "Paired artifact root changed while being inspected.");
  return { manifest, bytes, sha256: hash(bytes), rootPin };
}
async function absent(destination: string) {
  if (!isAbsolute(destination) || resolve(destination) !== destination)
    throw new PairedMemoryBackupError("INVALID_PATH", "Provide an absent canonical absolute destination.");
  const parent = dirname(destination);
  const parentPin = await pin(parent, true);
  try { await lstat(destination); throw new PairedMemoryBackupError("DESTINATION_EXISTS", "Paired destination must be absent."); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  if ((await readdir(parent)).some(name => name.startsWith(".pkm-paired.") && name.endsWith(".stage")))
    throw new PairedMemoryBackupError("RECOVERY_REQUIRED", "Unknown paired staging requires explicit inspection; never replay or discard.");
  return { parent, parentPin };
}

export async function createPairedMemoryWorkspaceBackup(storage: Storage, worker: LegacyMemoryErasureOwnedWorker,
  destination: string, policy: PairedMemoryFixtureAuthority) {
  if (policy.ownedWorker !== worker)
    throw new PairedMemoryBackupError("AUTHORITY_REQUIRED", "Paired snapshot requires the exact configured native-owned dispatcher.");
  const target = await absent(destination);
  const workspaceLease = await policy.acquireQuiescence();
  const root = storage.workspaceRoot();
  let lease: Awaited<ReturnType<typeof worker.acquireMemoryQuiescence>> | undefined;
  let stage: string | undefined, scratch: string | undefined;
  let resumeRequest: PairedMemoryAuthorityRequest | undefined;
  let unknown = false;
  try {
    return await storage.withWorkspaceExclusive(async () => {
      workspaceLease.assertHeld(); storage.assertWorkspaceLease();
      lease = await worker.acquireMemoryQuiescence();
      const binding = worker.engineBinding();
      const workspaceId = await storage.workspaceId();
      const rootPin = await pin(root, true);
      const dbPin = await pin(coreDatabasePath(root), false);
      const enginePin = await pin(binding.database, false);
      const db = storage.connectNative();
      try {
        assertPairedMemoryWorkspaceIdle(db, workspaceId);
        const state = ledger(db, workspaceId);
        const dataVersion = db.prepare("PRAGMA data_version").get()?.data_version;
        const before = await inventory(root, true);
        const sourceIdentities = await inventoryIdentity(root, before);
        const liveEngine = new DatabaseSync(binding.database, { readOnly: true });
        let liveState: ReturnType<typeof rows>;
        try {
          liveState = rows(liveEngine);
          assertEngineErasureState(liveEngine, state.operations);
        } finally { liveEngine.close(); }
        const inherited = worker.engineBinding().originalOperationRoot;
        const roots = Object.fromEntries(state.operations.map(item => [String(item.operation_id),
          inherited?.(String(item.operation_id)) ?? root]));
        const request: PairedMemoryAuthorityRequest = { schema: "pkm.native-paired-memory-authority/v1",
          phase: "snapshot", actorId: policy.actorId, workspaceId, operationId: randomUUID(),
          epoch: state.epoch, sourceRoot: root, destination, sourceRootPin: rootPin,
          destinationParentPin: target.parentPin, engineIdentity: binding.identity,
          sourceDatabasePin: dbPin, sourceEngine: { identity: binding.identity, database: binding.database, pin: enginePin,
            schema: 2, schemaSha256: liveState.schema, tablesSha256: liveState.tables },
          manifestSha256: null, ledgerSha256: state.sha256 };
        check(policy, request); lease.assertHeld(); workspaceLease.assertHeld();
        stage = join(target.parent, `.pkm-paired.${randomUUID()}.stage`);
        await mkdir(stage, { mode: 0o700 });
        for (const directory of before.directories) await mkdir(join(stage, directory), { recursive: true, mode: 0o700 });
        for (const file of before.files) {
          await mkdir(dirname(join(stage, file.path)), { recursive: true, mode: 0o700 });
          await copyFile(join(root, file.path), join(stage, file.path), constants.COPYFILE_EXCL);
          await chmod(join(stage, file.path), 0o600); await sync(join(stage, file.path));
        }
        db.exec(`VACUUM INTO '${coreDatabasePath(stage).replaceAll("'", "''")}'`);
        const core = new DatabaseSync(coreDatabasePath(stage));
        try {
          core.prepare("UPDATE native_runtime_owner SET lease_until=0 WHERE singleton=1").run();
          core.prepare("PRAGMA wal_checkpoint(TRUNCATE)").get();
          if (core.prepare("PRAGMA journal_mode=DELETE").get()?.journal_mode !== "delete")
            throw new PairedMemoryBackupError("DATABASE_BUSY", "Paired core snapshot could not be made standalone.");
        }
        finally { core.close(); }
        await chmod(coreDatabasePath(stage), 0o600);
        scratch = join(binding.runtimeDirectory, `.pkm-memory-snapshot-${randomUUID()}.sqlite3`);
        await binding.worker.snapshotDatabase(scratch);
        normalizeEngineSnapshot(scratch, binding.identity);
        await mkdir(dirname(join(stage, engineRelative)), { recursive: true, mode: 0o700 });
        await copyFile(scratch, join(stage, engineRelative), constants.COPYFILE_EXCL);
        await chmod(join(stage, engineRelative), 0o600);
        await verifyEngineDatabase(join(stage, engineRelative), binding.identity);
        const engine = new DatabaseSync(join(stage, engineRelative), { readOnly: true });
        let engineState: ReturnType<typeof rows>;
        try { engineState = rows(engine); } finally { engine.close(); }
        if (!equal(liveState, engineState))
          throw new PairedMemoryBackupError("ENGINE_MISMATCH", "SQLite backup did not preserve the entire quiescent live engine schema and table state.");
        const all = await inventory(stage, false);
        const manifest: Manifest = { schema: "pkm.paired-memory-backup/v1", workspaceId,
          actorId: policy.actorId, operationId: request.operationId, sourceRoot: root, sourceRootPin: rootPin,
          sourceDatabasePin: dbPin, engine: { identity: binding.identity, database: binding.database,
            pin: enginePin, schema: 2, schemaSha256: engineState.schema, tablesSha256: engineState.tables },
          epoch: state.epoch, ledgerSha256: state.sha256, roots, receiptPins: receiptPins(db, state.operations), ...all };
        const bytes = Buffer.from(JSON.stringify(manifest));
        await write(join(stage, manifestName), bytes);
        await inspect(stage, true);
        await write(join(stage, publicationName), Buffer.from(JSON.stringify({ state: "pending", manifestSha256: hash(bytes) })));
        if (!equal(before, await inventory(root, true, scratch)) || db.prepare("PRAGMA data_version").get()?.data_version !== dataVersion
          || ledger(db, workspaceId).sha256 !== state.sha256 || !equal(await pin(root, true), rootPin)
          || !equal(await pin(coreDatabasePath(root), false), dbPin)
          || !equal(await pin(binding.database, false), enginePin)
          || !equal(sourceIdentities, await inventoryIdentity(root, before)))
          throw new PairedMemoryBackupError("SOURCE_CHANGED", "Paired source inventory, SQLite epoch, or native identity changed.");
        const engineAfter = new DatabaseSync(binding.database, { readOnly: true });
        try {
          if (!equal(rows(engineAfter), liveState))
            throw new PairedMemoryBackupError("SOURCE_CHANGED", "Live engine schema, references, or invalidation state changed across the paired snapshot.");
        } finally { engineAfter.close(); }
        check(policy, { ...request, phase: "publish", manifestSha256: hash(bytes) });
        lease.assertHeld(); workspaceLease.assertHeld();
        await syncTree(stage, all.directories);
        const stagePin = await pin(stage, true);
        if (!equal(await pin(target.parent, true), target.parentPin))
          throw new PairedMemoryBackupError("SOURCE_CHANGED", "Paired backup parent identity changed.");
        unknown = true;
        try { await policy.publishNoReplace(stage, destination); }
        catch { throw new PairedMemoryBackupError("RECOVERY_REQUIRED", "Native paired backup publication outcome is unknown; writers remain fenced."); }
        if (!equal(await pin(destination, true), stagePin))
          throw new PairedMemoryBackupError("RECOVERY_REQUIRED", "Native publication did not adopt the exact paired stage inode.");
        stage = undefined; await sync(target.parent);
        check(policy, { ...request, phase: "publish", manifestSha256: hash(bytes) });
        await finalizePublication(destination, hash(bytes));
        resumeRequest = { ...request, phase: "resume", manifestSha256: hash(bytes) };
        unknown = false;
        return { backupPath: destination, manifestSha256: hash(bytes), workspaceId, epoch: state.epoch };
      } finally { db.close(); }
    });
  } catch (error) {
    if (unknown) throw new PairedMemoryBackupError("RECOVERY_REQUIRED", "Paired backup publication outcome requires explicit native reconciliation; all owned writers remain fenced.");
    throw error;
  } finally {
    if (scratch) await rm(scratch, { force: true });
    if (stage && !unknown) await rm(stage, { recursive: true, force: true });
    if (!unknown && resumeRequest) {
      try { check(policy, resumeRequest); }
      catch {
        worker.fenceUnknownOutcome();
        throw new PairedMemoryBackupError("RECOVERY_REQUIRED", "Published paired backup cannot resume owned writers without renewed native epoch authority.");
      }
    }
    if (unknown) worker.fenceUnknownOutcome();
    if (!unknown) {
      try { lease?.release(); }
      catch {
        worker.fenceUnknownOutcome();
        throw new PairedMemoryBackupError("RECOVERY_REQUIRED", "Native engine writer readmission failed; workspace admission remains fenced.");
      }
      await workspaceLease.release();
    }
  }
}

export async function restorePairedMemoryWorkspaceBackup(source: string, destination: string,
  policy: PairedMemoryFixtureAuthority) {
  const backup = await inspect(source);
  const target = await absent(destination);
  const request: PairedMemoryAuthorityRequest = { schema: "pkm.native-paired-memory-authority/v1",
    phase: "stage", actorId: policy.actorId, workspaceId: backup.manifest.workspaceId,
    operationId: backup.manifest.operationId, epoch: backup.manifest.epoch, sourceRoot: source,
    destination, sourceRootPin: backup.rootPin, destinationParentPin: target.parentPin,
    sourceDatabasePin: backup.manifest.sourceDatabasePin, sourceEngine: backup.manifest.engine,
    engineIdentity: backup.manifest.engine.identity, manifestSha256: backup.sha256, ledgerSha256: backup.manifest.ledgerSha256 };
  check(policy, request);
  const lease = await policy.acquireQuiescence();
  const ownedWorker = policy.ownedWorker;
  let engineLease: Awaited<ReturnType<LegacyMemoryErasureOwnedWorker["acquireMemoryQuiescence"]>> | undefined;
  let stage: string | undefined = join(target.parent, `.pkm-paired.${randomUUID()}.stage`);
  let unknown = false;
  let resumeRequest: PairedMemoryAuthorityRequest | undefined;
  try {
    lease.assertHeld(); check(policy, request);
    engineLease = await ownedWorker.acquireMemoryQuiescence();
    engineLease.assertHeld();
    await mkdir(stage, { mode: 0o700 });
    for (const directory of backup.manifest.directories) await mkdir(join(stage, directory), { recursive: true, mode: 0o700 });
    for (const file of backup.manifest.files) {
      await mkdir(dirname(join(stage, file.path)), { recursive: true, mode: 0o700 });
      await copyFile(join(source, file.path), join(stage, file.path), constants.COPYFILE_EXCL);
      await chmod(join(stage, file.path), 0o600); await sync(join(stage, file.path));
    }
    await write(join(stage, manifestName), backup.bytes);
    const staged = await inspect(stage, true);
    if (staged.sha256 !== backup.sha256 || (await inspect(source)).sha256 !== backup.sha256
      || !equal(await pin(dirname(destination), true), target.parentPin))
      throw new PairedMemoryBackupError("SOURCE_CHANGED", "Paired staged bytes or native publication parent changed.");
    const adoption = { schema: "pkm.native-memory-adoption/v1", request: { ...request, phase: "open" },
      manifestSha256: backup.sha256, destination, rootPin: await pin(stage, true),
      enginePin: await pin(join(stage, engineRelative), false), corePin: await pin(coreDatabasePath(stage), false),
      roots: backup.manifest.roots };
    await write(join(stage, adoptionName), Buffer.from(JSON.stringify(adoption)));
    await write(join(stage, publicationName), Buffer.from(JSON.stringify({ state: "pending", manifestSha256: backup.sha256 })));
    check(policy, { ...request, phase: "publish" }); lease.assertHeld(); engineLease.assertHeld();
    await syncTree(stage, backup.manifest.directories);
    try {
      if (process.platform === "linux") {
        const stagePublishPath = stage;
        const publicationEngineLease = engineLease;
        const fence = await acquireLinuxRootWriterFence(stagePublishPath);
        try {
          check(policy, { ...request, phase: "publish" }); lease.assertHeld(); engineLease.assertHeld();
          await fence.publishRootNoReplace(destination, () => {
            check(policy, { ...request, phase: "publish" }); lease.assertHeld(); publicationEngineLease.assertHeld();
            unknown = true;
            return policy.publishNoReplace(stagePublishPath, destination);
          });
        } finally { await fence.release(); }
      } else {
        unknown = true;
        await policy.publishNoReplace(stage, destination);
      }
    }
    catch (error) {
      if (unknown) throw new PairedMemoryBackupError("RECOVERY_REQUIRED", "Native paired restore publication outcome is unknown; writers remain fenced.");
      throw error;
    }
    if (!equal(await pin(destination, true), adoption.rootPin))
      throw new PairedMemoryBackupError("RECOVERY_REQUIRED", "Native publication did not adopt the exact paired stage inode.");
    stage = undefined; await sync(target.parent);
    check(policy, { ...request, phase: "publish" });
    await finalizePublication(destination, backup.sha256);
    resumeRequest = { ...request, phase: "resume" };
    unknown = false;
    return { workspaceRoot: destination, workspaceId: backup.manifest.workspaceId,
      database: join(destination, engineRelative), identity: backup.manifest.engine.identity, epoch: backup.manifest.epoch };
  } catch (error) {
    if (unknown) throw new PairedMemoryBackupError("RECOVERY_REQUIRED", "Paired restore publication outcome requires explicit native reconciliation; workspace writers remain fenced.");
    throw error;
  } finally {
    if (stage && !unknown) await rm(stage, { recursive: true, force: true });
    if (!unknown && resumeRequest) {
      try { check(policy, resumeRequest); }
      catch {
        ownedWorker.fenceUnknownOutcome();
        throw new PairedMemoryBackupError("RECOVERY_REQUIRED", "Published paired restore cannot resume workspace writers without renewed native epoch authority.");
      }
    }
    if (unknown) ownedWorker.fenceUnknownOutcome();
    if (!unknown) {
      try { engineLease?.release(); }
      catch {
        ownedWorker.fenceUnknownOutcome();
        throw new PairedMemoryBackupError("RECOVERY_REQUIRED", "Native engine writer readmission failed; restored workspace admission remains fenced.");
      }
      await lease.release();
    }
  }
}

export async function openPairedMemoryWorkspaceWorker(root: string, policy: PairedMemoryFixtureAuthority,
  workerPolicy: LegacyMemoryOwnedFixturePolicy) {
  await pin(join(root, adoptionName), false);
  const adoptionBytes = await readFile(join(root, adoptionName));
  const adoption = JSON.parse(adoptionBytes.toString());
  const manifest = JSON.parse((await readFile(join(root, manifestName))).toString()) as Manifest;
  await pin(join(root, publicationName), false);
  const publication = JSON.parse((await readFile(join(root, publicationName))).toString());
  const database = join(root, engineRelative);
  if (publication.state !== "committed" || publication.manifestSha256 !== adoption.manifestSha256
    || adoption.schema !== "pkm.native-memory-adoption/v1" || adoption.destination !== root
    || !equal(await pin(root, true), adoption.rootPin) || !equal(await pin(database, false), adoption.enginePin)
    || !equal(await pin(coreDatabasePath(root), false), adoption.corePin)
    || hash(await readFile(join(root, manifestName))) !== adoption.manifestSha256 || !equal(adoption.roots, manifest.roots))
    throw new PairedMemoryBackupError("ADOPTION_MISMATCH", "Restored file identity and immutable ancestry require exact native adoption.");
  const currentEpoch = () => {
    const coreStat = lstatSync(coreDatabasePath(root), { bigint: true });
    const rootStat = lstatSync(root, { bigint: true });
    const marker = JSON.parse(readFileSync(join(root, publicationName), "utf8"));
    if (!coreStat.isFile() || coreStat.isSymbolicLink() || (Number(coreStat.mode) & 0o777) !== 0o600
      || !equal({ dev: String(coreStat.dev), ino: String(coreStat.ino) }, adoption.corePin)
      || !equal({ dev: String(rootStat.dev), ino: String(rootStat.ino) }, adoption.rootPin)
      || marker.state !== "committed" || marker.manifestSha256 !== adoption.manifestSha256
      || hash(readFileSync(join(root, manifestName))) !== adoption.manifestSha256
      || hash(readFileSync(join(root, adoptionName))) !== hash(adoptionBytes))
      throw new PairedMemoryBackupError("ADOPTION_MISMATCH", "Live native workspace identity or durable adoption authority changed.");
    const db = new DatabaseSync(coreDatabasePath(root), { readOnly: true });
    try {
      if (![21, 22, 23].includes(Number(db.prepare("PRAGMA user_version").get()?.user_version)))
        throw new PairedMemoryBackupError("SCHEMA_MISMATCH", "Restored workspace schema changed after native adoption.");
      const validated = validateLegacyMemoryErasureLedger(db, manifest.workspaceId);
      const operations = db.prepare("SELECT * FROM legacy_memory_erasure_operations WHERE status='committed'").all();
      const currentPins = receiptPins(db, operations);
      if (Object.entries(manifest.receiptPins).some(([id, value]) => !equal(currentPins[id], value))
        || operations.some(item => manifest.roots[String(item.operation_id)] !== undefined
          && hash(manifest.roots[String(item.operation_id)]) !== item.root_sha256))
        throw new PairedMemoryBackupError("LINEAGE_MISMATCH", "Original immutable receipts or adopted source identity changed after restore.");
      const engine = new DatabaseSync(database, { readOnly: true });
      try {
        if (rows(engine).schema !== manifest.engine.schemaSha256)
          throw new PairedMemoryBackupError("ENGINE_MISMATCH", "Restored engine schema changed after native adoption.");
        assertEngineErasureState(engine, operations);
      } finally { engine.close(); }
      return validated.epoch ?? 0;
    } finally { db.close(); }
  };
  const currentLedgerHash = () => {
    const db = new DatabaseSync(coreDatabasePath(root), { readOnly: true });
    try { return ledger(db, manifest.workspaceId).sha256; } finally { db.close(); }
  };
  const artifact = await engineArtifact(database, manifest.engine.identity);
  const openRequest: PairedMemoryAuthorityRequest = { ...adoption.request, phase: "open", epoch: currentEpoch(),
    ledgerSha256: currentLedgerHash() };
  check(policy, openRequest);
  const accepted = policy.engineStateAuthority.read(Object.freeze(structuredClone(openRequest)));
  const originalFile = manifest.files.find(item => item.path === engineRelative);
  if (!originalFile)
    throw new PairedMemoryBackupError("INVALID_BACKUP", "Manifest does not pin the engine artifact.");
  const expected: PairedMemoryEngineSeal = accepted ?? {
    state: "closed",
    manifestSha256: adoption.manifestSha256, databasePin: adoption.enginePin, epoch: manifest.epoch,
    schemaSha256: manifest.engine.schemaSha256, tablesSha256: manifest.engine.tablesSha256,
    ledgerSha256: manifest.ledgerSha256,
    size: originalFile.size, sha256: originalFile.sha256,
  };
  if (expected.state !== "closed" || !equal(expected.databasePin, adoption.enginePin) || expected.manifestSha256 !== adoption.manifestSha256
    || expected.epoch !== openRequest.epoch || expected.ledgerSha256 !== openRequest.ledgerSha256 || expected.schemaSha256 !== artifact.schema
    || expected.tablesSha256 !== artifact.tables || expected.size !== artifact.size || expected.sha256 !== artifact.sha256)
    throw new PairedMemoryBackupError("ENGINE_MISMATCH", "Native worker open requires exact accepted engine table and artifact bytes.");
  check(policy, { ...openRequest, engineSeal: expected });
  const commitLiveState = () => {
    const epoch = currentEpoch();
    const engine = new DatabaseSync(database, { readOnly: true });
    let state: ReturnType<typeof rows>;
    try { state = rows(engine); } finally { engine.close(); }
    const seal: PairedMemoryEngineSeal = { state: "live", manifestSha256: adoption.manifestSha256,
      databasePin: adoption.enginePin, epoch, schemaSha256: state.schema, tablesSha256: state.tables,
      ledgerSha256: currentLedgerHash(),
      size: lstatSync(database).size, sha256: hash(readFileSync(database)) };
    const request: PairedMemoryAuthorityRequest = { ...adoption.request, phase: "resume", epoch, engineSeal: seal,
      ledgerSha256: seal.ledgerSha256 };
    check(policy, request);
    if (policy.engineStateAuthority.commit(Object.freeze(structuredClone(request)), Object.freeze(structuredClone(seal))) !== true)
      throw new PairedMemoryBackupError("RECOVERY_REQUIRED", "Owned engine effect requires an independently durable native content anchor.");
  };
  const assertAcceptedContent = () => {
    const request: PairedMemoryAuthorityRequest = { ...adoption.request, phase: "open", epoch: currentEpoch(),
      ledgerSha256: currentLedgerHash() };
    check(policy, request);
    const accepted = policy.engineStateAuthority.read(Object.freeze(structuredClone(request))) ?? expected;
    const engine = new DatabaseSync(database, { readOnly: true });
    try {
      const actual = rows(engine);
      if (accepted.manifestSha256 !== adoption.manifestSha256 || !equal(accepted.databasePin, adoption.enginePin)
        || accepted.epoch !== request.epoch || accepted.ledgerSha256 !== request.ledgerSha256
        || accepted.schemaSha256 !== actual.schema || accepted.tablesSha256 !== actual.tables)
        throw new PairedMemoryBackupError("ENGINE_MISMATCH", "Engine contents differ from the independently accepted native content anchor.");
    } finally { engine.close(); }
  };
  return LegacyMemoryErasureOwnedWorker.open({ python: policy.python, runtimeDirectory: dirname(database),
    database, identity: manifest.engine.identity }, {
    ...workerPolicy,
    assertFixtureOwnership(binding) {
      const stat = lstatSync(database, { bigint: true });
      if (!equal(adoption.enginePin, { dev: String(stat.dev), ino: String(stat.ino) }))
        return false;
      return workerPolicy.assertFixtureOwnership(binding);
    },
    assertWriterAdmission() {
      assertAcceptedContent();
      return true;
    },
    afterOwnedDispatch: commitLiveState,
    afterHeldRelease: commitLiveState,
    assertNativeAdoption: (currentRoot, workspaceId) => {
      if (currentRoot !== root || workspaceId !== manifest.workspaceId) return false;
      check(policy, { ...adoption.request, phase: "open", epoch: currentEpoch() });
      return true;
    },
    originalOperationRoot: operationId => manifest.roots[operationId],
    async afterSafeClose() {
      const epoch = currentEpoch();
      assertAcceptedContent();
      check(policy, { ...adoption.request, phase: "resume", epoch, ledgerSha256: currentLedgerHash() });
      if (workerPolicy.assertFixtureOwnership({ database, runtimeDirectory: dirname(database), identity: manifest.engine.identity }) !== true)
        throw new PairedMemoryBackupError("AUTHORITY_REQUIRED", "Closed engine normalization requires unchanged native fixture ownership.");
      normalizeEngineSnapshot(database, manifest.engine.identity);
      const sealed = await engineArtifact(database, manifest.engine.identity);
      const seal: PairedMemoryEngineSeal = { state: "closed", manifestSha256: adoption.manifestSha256,
        databasePin: await pin(database, false), epoch, schemaSha256: sealed.schema,
        tablesSha256: sealed.tables, ledgerSha256: currentLedgerHash(), size: sealed.size, sha256: sealed.sha256 };
      const request: PairedMemoryAuthorityRequest = { ...adoption.request, phase: "resume", epoch, engineSeal: seal,
        ledgerSha256: seal.ledgerSha256 };
      check(policy, request);
      if (policy.engineStateAuthority.commit(Object.freeze(structuredClone(request)), Object.freeze(structuredClone(seal))) !== true)
        throw new PairedMemoryBackupError("RECOVERY_REQUIRED", "Closed engine state requires independent native authority before later worker reopen.");
    },
  });
}
