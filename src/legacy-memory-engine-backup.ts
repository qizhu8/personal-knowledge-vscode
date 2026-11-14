import { createHash, randomUUID } from "node:crypto";
import { createReadStream, constants, lstatSync } from "node:fs";
import { copyFile, chmod, lstat, mkdir, open, readFile, readdir, realpath, rm } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { Storage } from "./storage.js";
import type { LegacyMemoryOwnedFixtureBinding, LegacyMemoryErasureOwnedWorker } from "./legacy-memory-erasure-worker.js";
import {
  assertLegacyMemoryRestoreAdmitted, validateLegacyMemoryErasureLedger,
  type TrustedLegacyMemoryEpochAuthority,
} from "./legacy-memory-erasure.js";
import type { WorkspaceQuiescenceLease } from "./workspace-backup.js";

const manifestName = ".pkm-legacy-memory-engine-backup.json";
const engineName = "memory.sqlite3";
const manifestSchema = "pkm.legacy-memory-engine-backup/v1";
const workspaceSchema = "pkm.next-workspace/v2";
const digest = (value: Uint8Array | string) => createHash("sha256").update(value).digest("hex");

export class LegacyMemoryEngineBackupError extends Error {
  constructor(readonly code: string, message: string) { super(message); this.name = "LegacyMemoryEngineBackupError"; }
}

export interface LegacyMemoryEngineBackupRequest {
  schema: "pkm.native-memory-engine-backup-request/v1";
  phase: "snapshot" | "publish";
  actorId: string;
  operationId: string;
  workspaceId: string;
  workspaceRoot: string;
  workspaceDevice: string;
  workspaceInode: string;
  databaseDevice: string;
  databaseInode: string;
  engine: LegacyMemoryOwnedFixtureBinding;
  engineDevice: string;
  engineInode: string;
  memoryErasureEpoch: number;
  erasureLedgerSha256: string;
  workspaceInventorySha256: string;
  destination: string;
  artifactSha256?: string;
}

export interface LegacyMemoryEngineRestoreRequest {
  schema: "pkm.native-memory-engine-restore-request/v1";
  phase: "stage" | "publish";
  actorId: string;
  workspaceId: string;
  sourceRoot: string;
  sourceDevice: string;
  sourceInode: string;
  manifestSha256: string;
  artifactSha256: string;
  memoryErasureEpoch: number;
  targetRuntimeDirectory: string;
  targetDatabase: string;
  targetIdentity: string;
  stageDatabase: string | null;
}

export interface LegacyMemoryEngineBackupManifest {
  schema: typeof manifestSchema;
  workspaceSchema: typeof workspaceSchema;
  workspaceId: string;
  actorId: string;
  operationId: string;
  sourceWorkspace: { root: string; device: string; inode: string; databaseDevice: string; databaseInode: string };
  workspaceInventorySha256: string;
  erasureLedgerSha256: string;
  sourceEngine: { runtimeDirectory: string; database: string; identity: string; device: string; inode: string };
  memoryErasureEpoch: number;
  engineSchema: 2;
  artifact: { path: typeof engineName; size: number; sha256: string };
}

export interface NativeMemoryEngineBackupPolicy extends TrustedLegacyMemoryEpochAuthority {
  readonly scope: "exclusive-native-disposable-fixture";
  readonly actorId: string;
  acquireWorkspaceQuiescence(): Promise<WorkspaceQuiescenceLease>;
  assertFixtureOwnership(binding: Readonly<{
    workspaceRoot: string;
    workspaceId: string;
    engine: LegacyMemoryOwnedFixtureBinding;
    destination: string;
  }>): boolean;
  authorizeBackup(request: Readonly<LegacyMemoryEngineBackupRequest>): {
    actorId: string; requestSha256: string; authorityId: string; expiresAt: number; trustedEpoch: number;
  } | null;
  publishNoReplace(source: string, destination: string): Promise<void>;
}

export interface NativeMemoryEngineRestorePolicy extends TrustedLegacyMemoryEpochAuthority {
  readonly scope: "exclusive-native-disposable-fixture";
  readonly actorId: string;
  assertFixtureOwnership(binding: Readonly<{
    workspaceId: string;
    targetRuntimeDirectory: string;
    targetDatabase: string;
    targetIdentity: string;
  }>): boolean;
  authorizeRestore(request: Readonly<LegacyMemoryEngineRestoreRequest>): Promise<{
    actorId: string; requestSha256: string; authorityId: string; expiresAt: number;
    lineage: "unrelated" | "erasure-protected"; trustedEpoch: number;
  } | null>;
  publishNoReplace(source: string, destination: string): Promise<void>;
  python: string;
}

function assertAllowed(value: unknown): asserts value is true {
  if (value !== true) throw new LegacyMemoryEngineBackupError("AUTHORITY_REQUIRED",
    "Explicit native disposable-fixture ownership or restore authority is required.");
}

function assertAuthorization<T extends { actorId: string; requestSha256: string; authorityId: string; expiresAt: number }>(
  value: T | null, request: object, actorId: string, expectedEpoch: number,
): T {
  if (!value || value.actorId !== actorId || value.requestSha256 !== digest(JSON.stringify(request))
    || !value.authorityId || value.authorityId.length > 256 || /[\u0000-\u001f\u007f]/u.test(value.authorityId)
    || !Number.isSafeInteger(value.expiresAt) || value.expiresAt <= Date.now()
    || !("trustedEpoch" in value) || value.trustedEpoch !== expectedEpoch) {
    throw new LegacyMemoryEngineBackupError("AUTHORITY_REQUIRED", "Native approval is absent, expired, revoked, or not bound to the exact operation.");
  }
  return value;
}

async function statPin(path: string, directory: boolean): Promise<{ device: string; inode: string }> {
  try {
    const info = await lstat(path, { bigint: true });
    if (info.isSymbolicLink() || (directory ? !info.isDirectory() : !info.isFile()) || await realpath(path) !== path) throw new Error();
    return { device: String(info.dev), inode: String(info.ino) };
  } catch {
    throw new LegacyMemoryEngineBackupError("SOURCE_CHANGED", "A pinned workspace, engine, or target path is missing or unsafe.");
  }
}

async function syncDirectory(path: string): Promise<void> {
  const handle = await open(path, constants.O_RDONLY);
  try { await handle.sync(); } finally { await handle.close(); }
}

async function syncFile(path: string): Promise<void> {
  const handle = await open(path, constants.O_RDONLY);
  try { await handle.sync(); } finally { await handle.close(); }
}

async function hashFile(path: string): Promise<{ size: number; sha256: string }> {
  const hash = createHash("sha256");
  let size = 0;
  for await (const chunk of createReadStream(path)) {
    size += chunk.length;
    hash.update(chunk);
  }
  return { size, sha256: hash.digest("hex") };
}

export async function verifyEngineDatabase(path: string, identity: string): Promise<{ size: number; sha256: string }> {
  const file = lstatSync(path, { bigint: true });
  if (!file.isFile() || file.isSymbolicLink() || (Number(file.mode) & 0o777) !== 0o600) {
    throw new LegacyMemoryEngineBackupError("INVALID_ENGINE", "Engine snapshot must be a private regular file.");
  }
  for (const suffix of ["-wal", "-shm"]) {
    try { lstatSync(`${path}${suffix}`); throw new LegacyMemoryEngineBackupError("INVALID_ENGINE", "Engine snapshot may not depend on SQLite sidecars."); }
    catch (error) {
      if (error instanceof LegacyMemoryEngineBackupError) throw error;
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
  let database: DatabaseSync;
  try { database = new DatabaseSync(path, { readOnly: true }); }
  catch { throw new LegacyMemoryEngineBackupError("INVALID_ENGINE", "Engine snapshot is not a readable SQLite database."); }
  try {
    if (Number(database.prepare("PRAGMA user_version").get()?.user_version) !== 2
      || database.prepare("SELECT identity FROM metadata").get()?.identity !== identity
      || database.prepare("PRAGMA integrity_check").get()?.integrity_check !== "ok") {
      throw new LegacyMemoryEngineBackupError("INVALID_ENGINE", "Engine snapshot schema, identity, or integrity check failed.");
    }
  } catch (error) {
    if (error instanceof LegacyMemoryEngineBackupError) throw error;
    throw new LegacyMemoryEngineBackupError("INVALID_ENGINE", "Engine snapshot schema, identity, or integrity check failed.");
  } finally { database.close(); }
  const after = lstatSync(path, { bigint: true });
  if (file.dev !== after.dev || file.ino !== after.ino || file.size !== after.size || file.mtimeNs !== after.mtimeNs) {
    throw new LegacyMemoryEngineBackupError("SOURCE_CHANGED", "Engine snapshot changed while its bytes were pinned.");
  }
  const content = await hashFile(path);
  const afterHash = lstatSync(path, { bigint: true });
  if (file.dev !== afterHash.dev || file.ino !== afterHash.ino || file.size !== afterHash.size || file.mtimeNs !== afterHash.mtimeNs
    || content.size !== Number(file.size)) {
    throw new LegacyMemoryEngineBackupError("SOURCE_CHANGED", "Engine snapshot changed while its digest was computed.");
  }
  return content;
}

export function normalizeEngineSnapshot(path: string, identity: string): void {
  const database = new DatabaseSync(path);
  try {
    if (Number(database.prepare("PRAGMA user_version").get()?.user_version) !== 2
      || database.prepare("SELECT identity FROM metadata").get()?.identity !== identity) {
      throw new LegacyMemoryEngineBackupError("INVALID_ENGINE", "Engine snapshot identity or schema is inconsistent.");
    }
    const checkpoint = database.prepare("PRAGMA wal_checkpoint(TRUNCATE)").get();
    if (checkpoint && Number(checkpoint.busy) !== 0) throw new LegacyMemoryEngineBackupError("DATABASE_BUSY", "Snapshot SQLite WAL could not be checkpointed.");
    if (database.prepare("PRAGMA integrity_check").get()?.integrity_check !== "ok"
      || database.prepare("PRAGMA journal_mode=DELETE").get()?.journal_mode !== "delete") {
      throw new LegacyMemoryEngineBackupError("INVALID_ENGINE", "Engine snapshot checkpoint or journal normalization failed.");
    }
  } finally { database.close(); }
}

function memoryLedgerPin(database: DatabaseSync, workspaceId: string): { ledger: ReturnType<typeof validateLegacyMemoryErasureLedger>; sha256: string } {
  const ledger = validateLegacyMemoryErasureLedger(database, workspaceId, {
    readGlobalReceipt(db, operationId) {
      const row = db.prepare("SELECT * FROM receipts WHERE operation_id=?").get(operationId) as
        { operation_id: string; fingerprint: string; actor_id: string; operation: string; result: string } | undefined;
      return row?.operation === "memory.scope.forget.native"
        ? { operationId: row.operation_id, fingerprint: row.fingerprint, actorId: row.actor_id,
          operation: "memory.scope.forget.native", result: JSON.parse(row.result) } : null;
    },
  });
  return { ledger, sha256: digest(JSON.stringify(ledger)) };
}

async function workspaceInventory(root: string): Promise<string> {
  const entries: string[] = [];
  let totalBytes = 0;
  const visit = async (directory: string, relative: string) => {
    for (const entry of (await readdir(directory, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
      const path = join(directory, entry.name);
      const child = relative ? `${relative}/${entry.name}` : entry.name;
      const info = await lstat(path, { bigint: true });
      if (info.isSymbolicLink() || !info.isFile() && !info.isDirectory()) {
        throw new LegacyMemoryEngineBackupError("INVALID_WORKSPACE", "Workspace inventory contains a symlink or unsupported entry.");
      }
      if (info.isDirectory()) {
        entries.push(`${child}\0d\0${info.mode.toString(8)}\0${info.dev}\0${info.ino}`);
        await visit(path, child);
      } else {
        totalBytes += Number(info.size);
        if (entries.length >= 10_000 || totalBytes > 1024 * 1024 * 1024) {
          throw new LegacyMemoryEngineBackupError("QUOTA_EXCEEDED", "Workspace inventory exceeds the bounded fixture limit.");
        }
        entries.push(`${child}\0f\0${info.mode.toString(8)}\0${info.size}\0${info.dev}\0${info.ino}\0${digest(await readFile(path))}`);
      }
    }
  };
  await visit(root, "");
  return digest(entries.sort().join("\n"));
}

function validateManifest(value: unknown): LegacyMemoryEngineBackupManifest {
  if (!value || typeof value !== "object") throw new LegacyMemoryEngineBackupError("INVALID_MANIFEST", "Engine backup manifest is malformed.");
  const manifest = value as Partial<LegacyMemoryEngineBackupManifest>;
  if (manifest.schema !== manifestSchema || manifest.workspaceSchema !== workspaceSchema
    || typeof manifest.workspaceId !== "string" || !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(manifest.workspaceId)
    || typeof manifest.actorId !== "string" || !manifest.actorId || manifest.actorId.length > 256
    || /[\u0000-\u001f\u007f]/u.test(manifest.actorId)
    || typeof manifest.operationId !== "string" || !/^[0-9a-f-]{36}$/i.test(manifest.operationId)
    || !manifest.sourceWorkspace || typeof manifest.sourceWorkspace.root !== "string"
    || !/^[a-f0-9]{64}$/.test(manifest.workspaceInventorySha256 ?? "")
    || !/^[a-f0-9]{64}$/.test(manifest.erasureLedgerSha256 ?? "")
    || !manifest.sourceEngine || typeof manifest.sourceEngine.runtimeDirectory !== "string"
    || typeof manifest.sourceEngine.database !== "string" || typeof manifest.sourceEngine.identity !== "string"
    || !manifest.sourceEngine.identity || manifest.sourceEngine.identity.length > 512
    || /[\u0000-\u001f]/u.test(manifest.sourceEngine.identity)
    || manifest.engineSchema !== 2 || !Number.isSafeInteger(manifest.memoryErasureEpoch) || manifest.memoryErasureEpoch! < 0
    || !manifest.artifact || manifest.artifact.path !== engineName || !Number.isSafeInteger(manifest.artifact.size)
    || manifest.artifact.size! < 1 || !/^[a-f0-9]{64}$/.test(manifest.artifact.sha256 ?? "")) {
    throw new LegacyMemoryEngineBackupError("INVALID_MANIFEST", "Engine backup manifest fields are invalid.");
  }
  return manifest as LegacyMemoryEngineBackupManifest;
}

async function validateBackup(root: string) {
  const sourceRoot = resolve(root);
  if (!isAbsolute(root) || await realpath(sourceRoot) !== sourceRoot) throw new LegacyMemoryEngineBackupError("INVALID_PATH", "Backup path must be a real absolute directory.");
  const rootBefore = await statPin(sourceRoot, true);
  const manifestPath = join(sourceRoot, manifestName);
  const manifestBefore = await statPin(manifestPath, false);
  const manifestFileBefore = await lstat(manifestPath, { bigint: true });
  let bytes: Buffer;
  try { bytes = await readFile(manifestPath); }
  catch { throw new LegacyMemoryEngineBackupError("INVALID_MANIFEST", "Engine backup manifest is missing or unreadable."); }
  const manifestAfter = await statPin(manifestPath, false);
  const manifestFileAfter = await lstat(manifestPath, { bigint: true });
  if (manifestBefore.device !== manifestAfter.device || manifestBefore.inode !== manifestAfter.inode
    || manifestFileBefore.size !== manifestFileAfter.size || manifestFileBefore.mtimeNs !== manifestFileAfter.mtimeNs) {
    throw new LegacyMemoryEngineBackupError("SOURCE_CHANGED", "Engine backup manifest changed while it was read.");
  }
  let manifest: LegacyMemoryEngineBackupManifest;
  try { manifest = validateManifest(JSON.parse(bytes.toString("utf8"))); }
  catch (error) { if (error instanceof LegacyMemoryEngineBackupError) throw error; throw new LegacyMemoryEngineBackupError("INVALID_MANIFEST", "Engine backup manifest is malformed."); }
  const entries = (await readdir(sourceRoot)).sort();
  if (entries.join("\n") !== [manifestName, engineName].sort().join("\n")) {
    throw new LegacyMemoryEngineBackupError("INVALID_BACKUP", `Engine backup contains unrecognized entries: ${entries.join(", ")}.`);
  }
  const artifactPath = join(sourceRoot, engineName);
  const artifactPin = await statPin(artifactPath, false);
  const artifact = await verifyEngineDatabase(artifactPath, manifest.sourceEngine.identity);
  const artifactAfter = await statPin(artifactPath, false);
  if (artifactPin.device !== artifactAfter.device || artifactPin.inode !== artifactAfter.inode) {
    throw new LegacyMemoryEngineBackupError("SOURCE_CHANGED", "Engine backup artifact identity changed during validation.");
  }
  if (artifact.size !== manifest.artifact.size || artifact.sha256 !== manifest.artifact.sha256) {
    throw new LegacyMemoryEngineBackupError("SOURCE_CHANGED", "Engine backup artifact digest or size does not match its manifest.");
  }
  const rootPin = await statPin(sourceRoot, true);
  if (rootBefore.device !== rootPin.device || rootBefore.inode !== rootPin.inode) {
    throw new LegacyMemoryEngineBackupError("SOURCE_CHANGED", "Engine backup root identity changed during validation.");
  }
  return { manifest, manifestBytes: bytes, manifestSha256: digest(bytes), sourceRoot, rootPin, artifactPath, artifactPin };
}

export async function createLegacyMemoryEngineBackup(
  storage: Storage,
  owner: LegacyMemoryErasureOwnedWorker,
  destinationValue: string,
  policy: NativeMemoryEngineBackupPolicy,
): Promise<{ backupPath: string; manifestSha256: string; artifactSha256: string; workspaceId: string; memoryErasureEpoch: number }> {
  const destination = resolve(destinationValue);
  if (!isAbsolute(destinationValue) || !policy || policy.scope !== "exclusive-native-disposable-fixture"
    || !policy.actorId || typeof policy.assertFixtureOwnership !== "function"
    || typeof policy.authorizeBackup !== "function" || typeof policy.publishNoReplace !== "function"
    || typeof policy.acquireWorkspaceQuiescence !== "function") {
    throw new LegacyMemoryEngineBackupError("AUTHORITY_REQUIRED", "Native fixture ownership, workspace quiescence, external epoch, and no-replace authority are required.");
  }
  const workspaceRoot = storage.workspaceRoot();
  const engine = owner.engineBinding();
  const binding = Object.freeze({ runtimeDirectory: engine.runtimeDirectory, database: engine.database, identity: engine.identity });
  const runtimeRelativeToRoot = relative(workspaceRoot, binding.runtimeDirectory);
  if (runtimeRelativeToRoot === "" || runtimeRelativeToRoot !== ".."
    && !runtimeRelativeToRoot.startsWith(`..${sep}`) && !isAbsolute(runtimeRelativeToRoot)) {
    throw new LegacyMemoryEngineBackupError("ENGINE_MISMATCH", "Engine runtime must remain outside the workspace for this fixture-only backup path.");
  }
  const workspaceLease = await policy.acquireWorkspaceQuiescence();
  let engineLease: Awaited<ReturnType<LegacyMemoryErasureOwnedWorker["acquireMemoryQuiescence"]>> | undefined;
  let stage: string | undefined;
  let snapshotPath: string | undefined;
  let sourceDb: DatabaseSync | undefined;
  let publishAttempted = false;
  try {
    return await storage.withWorkspaceExclusive(async () => {
      workspaceLease.assertHeld();
      storage.assertWorkspaceLease();
      engineLease = await owner.acquireMemoryQuiescence();
      engineLease.assertHeld();
      assertAllowed(policy.assertFixtureOwnership(Object.freeze({
        workspaceRoot, workspaceId: await storage.workspaceId(), engine: binding, destination,
      })));
      const workspaceId = await storage.workspaceId();
      const workspacePin = await statPin(workspaceRoot, true);
      const workspaceDbPath = join(workspaceRoot, "core.sqlite");
      const databasePin = await statPin(workspaceDbPath, false);
      const enginePin = await statPin(binding.database, false);
      const inventoryBefore = await workspaceInventory(workspaceRoot);
      sourceDb = storage.connectNative();
      let dataVersion: number;
      let memoryErasureEpoch: number;
      if (sourceDb.isTransaction) throw new LegacyMemoryEngineBackupError("TRANSACTION_BOUNDARY", "Backup requires an idle workspace database.");
      const marker = JSON.parse((await readFile(join(workspaceRoot, ".pkm-next-workspace")).then(b => b.toString("utf8"))));
      if (marker.schema !== workspaceSchema || marker.id !== workspaceId) throw new LegacyMemoryEngineBackupError("WORKSPACE_MISMATCH", "Workspace marker identity changed.");
      const ledgerPin = memoryLedgerPin(sourceDb, workspaceId);
      if (ledgerPin.ledger.operations.some(operation => operation.status !== "committed")) {
        throw new LegacyMemoryEngineBackupError("PENDING_JOURNAL", "Pending or unresolved erasure history blocks backup.");
      }
      memoryErasureEpoch = ledgerPin.ledger.epoch ?? 0;
      const trusted = await policy.readTrustedEpoch({ workspaceId });
      if (!trusted || trusted.workspaceId !== workspaceId || !trusted.authorityId
        || !Number.isSafeInteger(trusted.epoch) || trusted.epoch !== memoryErasureEpoch) {
        throw new LegacyMemoryEngineBackupError("BACKUP_EPOCH_MISMATCH", "External native epoch does not match the live workspace ledger.");
      }
      const erasureLedgerSha256 = ledgerPin.sha256;
      dataVersion = Number(sourceDb.prepare("PRAGMA data_version").get()?.data_version);
      const operationId = randomUUID();
      const parent = dirname(destination);
      const parentPin = await statPin(parent, true);
      if ((await readdir(parent)).some(name => name.startsWith(".pkm-legacy-memory-backup.") && name.endsWith(".stage"))) {
        throw new LegacyMemoryEngineBackupError("RECOVERY_REQUIRED", "An unpublished engine backup stage requires explicit native inspection.");
      }
      try { await lstat(destination); throw new LegacyMemoryEngineBackupError("DESTINATION_EXISTS", "Backup destination already exists."); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
      let request: LegacyMemoryEngineBackupRequest = Object.freeze({
        schema: "pkm.native-memory-engine-backup-request/v1", phase: "snapshot",
        actorId: policy.actorId, operationId, workspaceId, workspaceRoot,
        workspaceDevice: workspacePin.device, workspaceInode: workspacePin.inode,
        databaseDevice: databasePin.device, databaseInode: databasePin.inode,
        engine: binding, engineDevice: enginePin.device, engineInode: enginePin.inode,
        memoryErasureEpoch, erasureLedgerSha256, workspaceInventorySha256: inventoryBefore, destination,
      });
      assertAuthorization(policy.authorizeBackup(request), request, policy.actorId, memoryErasureEpoch);
      workspaceLease.assertHeld(); engineLease.assertHeld();
      assertAllowed(policy.assertFixtureOwnership(Object.freeze({ workspaceRoot, workspaceId, engine: binding, destination })));
      snapshotPath = join(binding.runtimeDirectory, `.pkm-memory-snapshot-${randomUUID()}.sqlite3`);
      const snapshotResult = await engine.worker.snapshotDatabase(snapshotPath) as { identity?: unknown; schema?: unknown };
      if (snapshotResult.identity !== binding.identity || snapshotResult.schema !== 2) {
        throw new LegacyMemoryEngineBackupError("ENGINE_MISMATCH", "Native engine returned an inconsistent snapshot identity.");
      }
      normalizeEngineSnapshot(snapshotPath, binding.identity);
      const snapshot = await verifyEngineDatabase(snapshotPath, binding.identity);
      stage = join(parent, `.pkm-legacy-memory-backup.${randomUUID()}.stage`);
      await mkdir(stage, { mode: 0o700 });
      const stagedEngine = join(stage, engineName);
      await copyFile(snapshotPath, stagedEngine, constants.COPYFILE_EXCL);
      await chmod(stagedEngine, 0o600);
      const stagedSnapshot = await verifyEngineDatabase(stagedEngine, binding.identity);
      if (stagedSnapshot.sha256 !== snapshot.sha256 || stagedSnapshot.size !== snapshot.size) {
        throw new LegacyMemoryEngineBackupError("SOURCE_CHANGED", "Copied engine snapshot differs from its quiescent SQLite backup.");
      }
      await syncFile(stagedEngine);
      const manifest: LegacyMemoryEngineBackupManifest = {
        schema: manifestSchema, workspaceSchema, workspaceId, actorId: policy.actorId, operationId,
        sourceWorkspace: { root: workspaceRoot, device: workspacePin.device, inode: workspacePin.inode,
          databaseDevice: databasePin.device, databaseInode: databasePin.inode },
        workspaceInventorySha256: inventoryBefore, erasureLedgerSha256,
        sourceEngine: { runtimeDirectory: binding.runtimeDirectory, database: binding.database,
          identity: binding.identity, device: enginePin.device, inode: enginePin.inode },
        memoryErasureEpoch, engineSchema: 2,
        artifact: { path: engineName, size: stagedSnapshot.size, sha256: stagedSnapshot.sha256 },
      };
      const manifestBytes = Buffer.from(`${JSON.stringify(manifest)}\n`);
      const manifestHandle = await open(join(stage, manifestName), "wx", 0o600);
      try { await manifestHandle.writeFile(manifestBytes); await manifestHandle.sync(); } finally { await manifestHandle.close(); }
      await syncDirectory(stage);
      const manifestSha256 = digest(manifestBytes);
      const verified = await validateBackup(stage);
      if (verified.manifestSha256 !== manifestSha256 || verified.manifest.artifact.sha256 !== stagedSnapshot.sha256) {
        throw new LegacyMemoryEngineBackupError("INVALID_BACKUP", "Completed engine backup failed immutable self-verification.");
      }
      request = Object.freeze({ ...request, phase: "publish", artifactSha256: stagedSnapshot.sha256 });
      assertAuthorization(policy.authorizeBackup(request), request, policy.actorId, memoryErasureEpoch);
      workspaceLease.assertHeld(); engineLease.assertHeld(); storage.assertWorkspaceLease();
      assertAllowed(policy.assertFixtureOwnership(Object.freeze({ workspaceRoot, workspaceId, engine: binding, destination })));
      if (!sourceDb || Number(sourceDb.prepare("PRAGMA data_version").get()?.data_version) !== dataVersion) {
        throw new LegacyMemoryEngineBackupError("SOURCE_CHANGED", "Workspace database changed during engine snapshot.");
      }
      const ledgerAfter = memoryLedgerPin(sourceDb, workspaceId);
      if ((ledgerAfter.ledger.epoch ?? 0) !== memoryErasureEpoch
        || ledgerAfter.ledger.operations.some(operation => operation.status !== "committed")
        || ledgerAfter.sha256 !== erasureLedgerSha256) {
        throw new LegacyMemoryEngineBackupError("SOURCE_CHANGED", "Workspace erasure ledger changed during engine snapshot.");
      }
      sourceDb.close();
      sourceDb = undefined;
      if (await workspaceInventory(workspaceRoot) !== inventoryBefore) {
        throw new LegacyMemoryEngineBackupError("SOURCE_CHANGED", "Workspace inventory changed during engine snapshot.");
      }
      if (JSON.stringify(await statPin(workspaceRoot, true)) !== JSON.stringify(workspacePin)
        || JSON.stringify(await statPin(workspaceDbPath, false)) !== JSON.stringify(databasePin)
        || JSON.stringify(await statPin(binding.database, false)) !== JSON.stringify(enginePin)
        || JSON.stringify(await statPin(parent, true)) !== JSON.stringify(parentPin)) {
        throw new LegacyMemoryEngineBackupError("SOURCE_CHANGED", "Pinned workspace or engine identity changed during snapshot.");
      }
      workspaceLease.assertHeld(); engineLease.assertHeld();
      const stagePin = await statPin(stage, true);
      publishAttempted = true;
      try { await policy.publishNoReplace(stage, destination); }
      catch {
        try { await statPin(destination, true); stage = undefined; }
        catch { }
        throw new LegacyMemoryEngineBackupError("RECOVERY_REQUIRED",
          "Native backup publication outcome is uncertain; do not retry or discard an unknown stage.");
      }
      stage = undefined;
      try {
        const destinationPin = await statPin(destination, true);
        if (destinationPin.device !== stagePin.device || destinationPin.inode !== stagePin.inode) {
          throw new Error("Published backup does not match the authorized stage.");
        }
        await syncDirectory(parent);
      } catch {
        throw new LegacyMemoryEngineBackupError("RECOVERY_REQUIRED",
          "Backup was published but its durable directory state could not be verified.");
      }
      return { backupPath: destination, manifestSha256, artifactSha256: stagedSnapshot.sha256, workspaceId, memoryErasureEpoch };
    });
  } finally {
    sourceDb?.close();
    if (snapshotPath) await rm(snapshotPath, { force: true });
    if (stage && !publishAttempted) await rm(stage, { recursive: true, force: true });
    try { engineLease?.release(); } finally { await workspaceLease.release(); }
  }
}

export async function restoreLegacyMemoryEngineBackup(
  backupPath: string,
  targetRuntimeDirectoryValue: string,
  targetDatabaseValue: string,
  policy: NativeMemoryEngineRestorePolicy,
): Promise<{ database: string; identity: string; workspaceId: string; memoryErasureEpoch: number; artifactSha256: string }> {
  if (!policy || policy.scope !== "exclusive-native-disposable-fixture"
    || !policy.actorId || !policy.python || typeof policy.assertFixtureOwnership !== "function"
    || typeof policy.authorizeRestore !== "function" || typeof policy.publishNoReplace !== "function") {
    throw new LegacyMemoryEngineBackupError("AUTHORITY_REQUIRED", "External restore epoch and exclusive native fixture ownership are required.");
  }
  const backup = await validateBackup(backupPath);
  const targetRuntimeDirectory = resolve(targetRuntimeDirectoryValue);
  const targetDatabase = resolve(targetDatabaseValue);
  if (!isAbsolute(targetRuntimeDirectoryValue) || !isAbsolute(targetDatabaseValue)
    || dirname(targetDatabase) !== targetRuntimeDirectory) throw new LegacyMemoryEngineBackupError("INVALID_PATH", "Restore target must be an absolute runtime directory and direct-child database.");
  const targetParentPin = await statPin(targetRuntimeDirectory, true);
  const targetIdentity = backup.manifest.sourceEngine.identity;
  const pin = await assertLegacyMemoryRestoreAdmitted({
    workspaceId: backup.manifest.workspaceId,
    manifestSha256: backup.manifestSha256,
    memoryErasureEpoch: backup.manifest.memoryErasureEpoch,
  }, policy);
  const targetBinding = Object.freeze({ workspaceId: backup.manifest.workspaceId,
    targetRuntimeDirectory, targetDatabase, targetIdentity });
  assertAllowed(policy.assertFixtureOwnership(targetBinding));
  const assertSource = async () => {
    const current = await validateBackup(backup.sourceRoot);
    if (current.manifestSha256 !== backup.manifestSha256
      || current.rootPin.device !== backup.rootPin.device || current.rootPin.inode !== backup.rootPin.inode
      || current.artifactPin.device !== backup.artifactPin.device || current.artifactPin.inode !== backup.artifactPin.inode
      || current.manifest.memoryErasureEpoch !== pin.memoryErasureEpoch) {
      throw new LegacyMemoryEngineBackupError("SOURCE_CHANGED", "Engine backup source or lineage changed after validation.");
    }
  };
  const request: LegacyMemoryEngineRestoreRequest = Object.freeze({
    schema: "pkm.native-memory-engine-restore-request/v1", phase: "stage", actorId: policy.actorId,
    workspaceId: backup.manifest.workspaceId, sourceRoot: backup.sourceRoot,
    sourceDevice: backup.rootPin.device, sourceInode: backup.rootPin.inode,
    manifestSha256: backup.manifestSha256, artifactSha256: backup.manifest.artifact.sha256,
    memoryErasureEpoch: pin.memoryErasureEpoch, targetRuntimeDirectory, targetDatabase,
    targetIdentity, stageDatabase: null,
  });
  const checkAuthority = async (input: LegacyMemoryEngineRestoreRequest) => {
    const approval = await policy.authorizeRestore(input);
    if (!approval || approval.actorId !== policy.actorId
      || approval.requestSha256 !== digest(JSON.stringify(input)) || !approval.authorityId
      || approval.authorityId.length > 256 || /[\u0000-\u001f\u007f]/u.test(approval.authorityId)
      || !Number.isSafeInteger(approval.expiresAt) || approval.expiresAt <= Date.now()
      || approval.lineage !== "unrelated" && approval.lineage !== "erasure-protected"
      || approval.trustedEpoch !== pin.memoryErasureEpoch) {
      throw new LegacyMemoryEngineBackupError("AUTHORITY_REQUIRED", "Restore approval does not bind the exact source, target, lineage, and trusted epoch.");
    }
  };
  await checkAuthority(request);
  await assertSource();
  const stageDatabase = join(targetRuntimeDirectory, `.pkm-memory-restore-${randomUUID()}.sqlite3`);
  let published = false;
  try {
    const currentTarget = await readdir(targetRuntimeDirectory);
    if (currentTarget.some(name => name.startsWith(".pkm-memory-restore-") && name.endsWith(".sqlite3"))) {
      throw new LegacyMemoryEngineBackupError("RECOVERY_REQUIRED", "An unpublished engine restore stage requires explicit native inspection.");
    }
    if (currentTarget.includes(targetDatabase.split(/[\\/]/u).at(-1)!)) {
      throw new LegacyMemoryEngineBackupError("DESTINATION_EXISTS", "Restore target database or an entry with its name already exists.");
    }
    const requestForStage = Object.freeze({ ...request, phase: "stage" as const, stageDatabase });
    await checkAuthority(requestForStage);
    assertAllowed(policy.assertFixtureOwnership(targetBinding));
    await copyFile(backup.artifactPath, stageDatabase, constants.COPYFILE_EXCL);
    await chmod(stageDatabase, 0o600);
    await syncFile(stageDatabase);
    const staged = await verifyEngineDatabase(stageDatabase, targetIdentity);
    if (staged.sha256 !== backup.manifest.artifact.sha256 || staged.size !== backup.manifest.artifact.size) {
      throw new LegacyMemoryEngineBackupError("SOURCE_CHANGED", "Staged engine bytes do not match the immutable backup artifact.");
    }
    await assertSource();
    if (JSON.stringify(await statPin(targetRuntimeDirectory, true)) !== JSON.stringify(targetParentPin)) {
      throw new LegacyMemoryEngineBackupError("TARGET_CHANGED", "Restore target directory identity changed.");
    }
    const publishRequest = Object.freeze({ ...request, phase: "publish" as const, stageDatabase });
    await checkAuthority(publishRequest);
    assertAllowed(policy.assertFixtureOwnership(targetBinding));
    const stagePin = await statPin(stageDatabase, false);
    if (JSON.stringify(await statPin(targetRuntimeDirectory, true)) !== JSON.stringify(targetParentPin)) {
      throw new LegacyMemoryEngineBackupError("TARGET_CHANGED", "Restore target directory identity changed before publication.");
    }
    try { await policy.publishNoReplace(stageDatabase, targetDatabase); }
    catch {
      try { await statPin(targetDatabase, false); published = true; }
      catch { }
      throw new LegacyMemoryEngineBackupError("RECOVERY_REQUIRED",
        "Native restore publication outcome is uncertain; do not retry or overwrite the target.");
    }
    published = true;
    await syncDirectory(targetRuntimeDirectory);
    const targetPin = await statPin(targetDatabase, false);
    if (targetPin.device !== stagePin.device || targetPin.inode !== stagePin.inode) {
      throw new LegacyMemoryEngineBackupError("RECOVERY_REQUIRED", "Published engine does not match the authorized staged database.");
    }
    const { ChatMemoryWorker } = await import("./compute/chat-memory-worker.js");
    const opened = await ChatMemoryWorker.open({ python: policy.python, runtimeDirectory: targetRuntimeDirectory,
      database: targetDatabase, identity: targetIdentity });
    try {
      if (!opened.healthy || opened.ready?.identity !== targetIdentity || opened.ready?.schema !== 2) {
        throw new LegacyMemoryEngineBackupError("ENGINE_MISMATCH", "Restored engine did not pass its native worker handshake.");
      }
    } finally { await opened.close(); }
    return { database: targetDatabase, identity: targetIdentity, workspaceId: backup.manifest.workspaceId,
      memoryErasureEpoch: pin.memoryErasureEpoch, artifactSha256: staged.sha256 };
  } catch (error) {
    if (published) throw new LegacyMemoryEngineBackupError("RECOVERY_REQUIRED",
      "Restore was atomically published, but native worker verification failed; do not retry or overwrite the target.");
    throw error;
  } finally {
    if (!published) await rm(stageDatabase, { force: true });
  }
}
