import * as fs from "fs";
import * as path from "path";
import { createHash, randomUUID } from "crypto";
import { withCrossProcessLockSync } from "../cross-process-lock";
import { canonicalJson } from "../workflow-contracts";
import { ProjectModelState } from "./project-model";
import { RuntimeModel } from "./runtime-model";

export const DURABLE_STORE_SCHEMA = 1;

export type CrashPoint = "before-journal" | "after-journal-fsync" | "after-snapshot-rename" | "after-journal-cleanup";

export interface StoreCommand {
  commandId: string;
  fingerprint: string;
  expectedStorageEpoch: number;
}

export interface OperationReceipt<Result = unknown> {
  commandId: string;
  fingerprint: string;
  operation: string;
  storageEpoch: number;
  result: Result;
}

export interface MigrationMarker {
  owner: string;
  fence: number;
  fromSchema: number;
  targetSchema: number;
  startedAtEpoch: number;
}

export interface DurableStorePayload {
  project: ProjectModelState;
  runtimes: Record<string, RuntimeModel>;
  receipts: OperationReceipt[];
  migration?: MigrationMarker;
}

export interface DurableStoreEnvelope {
  schema: number;
  storageEpoch: number;
  payload: DurableStorePayload;
  digest: string;
}

export interface StoreResult<Result> {
  envelope: DurableStoreEnvelope;
  receipt: OperationReceipt<Result>;
  replayed: boolean;
}

export interface StoreMutation<Result> {
  project?: ProjectModelState;
  runtimes?: Record<string, RuntimeModel>;
  result: Result;
}

export interface DurableStoreOptions {
  schema?: number;
  crash?: (point: CrashPoint) => void;
}

interface JournalRecord {
  baseEpoch: number;
  envelope: DurableStoreEnvelope;
}

interface PreparedMutation<Result> {
  project: ProjectModelState;
  runtimes: Record<string, RuntimeModel>;
  result: Result;
  migration?: MigrationMarker;
}

export class DurableStoreError extends Error {
  constructor(public readonly code: string, message: string) {
    super(message);
  }
}

export function payloadDigest(payload: DurableStorePayload): string {
  return createHash("sha256").update(canonicalJson(payload), "utf8").digest("hex");
}

export class DurableWorkflowStore {
  private readonly snapshotPath: string;
  private readonly journalPath: string;
  private readonly lockPath: string;
  private readonly schema: number;
  private readonly crash?: (point: CrashPoint) => void;

  constructor(readonly directory: string, options: DurableStoreOptions = {}) {
    this.snapshotPath = path.join(directory, "workflow-store.json");
    this.journalPath = path.join(directory, "workflow-store.journal");
    this.lockPath = path.join(directory, "workflow-store.lock");
    this.schema = options.schema ?? DURABLE_STORE_SCHEMA;
    this.crash = options.crash;
    if (!Number.isSafeInteger(this.schema) || this.schema < 1) fail("schema-invalid", "Store schema must be a positive safe integer.");
  }

  read(): DurableStoreEnvelope {
    return withCrossProcessLockSync(this.lockPath, "Workflow durable store", () => {
      const envelope = this.recover();
      if (!envelope) fail("store-missing", "Workflow durable store is not initialized.");
      return clone(envelope);
    });
  }

  initialize(project: ProjectModelState, command: StoreCommand, runtimes: Record<string, RuntimeModel> = {}): StoreResult<null> {
    return withCrossProcessLockSync(this.lockPath, "Workflow durable store", () => {
      const current = this.recover();
      if (current) return this.replayOrFail<null>(current, command);
      if (command.expectedStorageEpoch !== 0) fail("storage-epoch-conflict", "Expected storage epoch does not match the current epoch.");
      const receipt: OperationReceipt<null> = {
        commandId: command.commandId, fingerprint: command.fingerprint, operation: "initialize", storageEpoch: 1, result: null
      };
      const payload = validatePayload({ project: clone(project), runtimes: clone(runtimes), receipts: [receipt] });
      const envelope = makeEnvelope(this.schema, 1, payload);
      this.commit(0, envelope);
      return { envelope: clone(envelope), receipt: clone(receipt), replayed: false };
    });
  }

  transact<Result>(command: StoreCommand, operation: string, mutate: (payload: DurableStorePayload) => StoreMutation<Result>): StoreResult<Result> {
    return this.update(command, operation, this.schema, payload => {
      if (payload.migration) fail("migration-active", "Ordinary writes are blocked while a migration is active.");
      const mutation = mutate(clone(payload));
      return {
        project: clone(mutation.project ?? payload.project),
        runtimes: clone(mutation.runtimes ?? payload.runtimes),
        result: clone(mutation.result)
      };
    });
  }

  beginMigration(command: StoreCommand, owner: string, fence: number, targetSchema: number): StoreResult<MigrationMarker> {
    return this.update(command, "migration-begin", this.schema, payload => {
      if (!owner || !Number.isSafeInteger(fence) || fence < 1 || !Number.isSafeInteger(targetSchema) || targetSchema <= this.schema) {
        fail("migration-invalid", "Migration owner, fence, and target schema are invalid.");
      }
      if (payload.migration) fail("migration-active", "A migration is already active.");
      const marker: MigrationMarker = {
        owner, fence, fromSchema: this.schema, targetSchema, startedAtEpoch: command.expectedStorageEpoch + 1
      };
      return { project: payload.project, runtimes: payload.runtimes, migration: marker, result: marker };
    });
  }

  completeMigration<Result>(
    command: StoreCommand,
    owner: string,
    fence: number,
    migrate: (payload: DurableStorePayload) => StoreMutation<Result>
  ): StoreResult<Result> {
    return this.update(command, "migration-complete", payload => payload.migration!.targetSchema, payload => {
      const active = payload.migration;
      if (!active || active.owner !== owner || active.fence !== fence || active.fromSchema !== this.schema) {
        fail("migration-fenced", "Migration ownership or fence does not match the active marker.");
      }
      const mutation = migrate(clone(payload));
      return {
        project: clone(mutation.project ?? payload.project),
        runtimes: clone(mutation.runtimes ?? payload.runtimes),
        result: clone(mutation.result)
      };
    });
  }

  private update<Result>(
    command: StoreCommand,
    operation: string,
    outputSchema: number | ((payload: DurableStorePayload) => number),
    mutate: (payload: DurableStorePayload) => PreparedMutation<Result>
  ): StoreResult<Result> {
    return withCrossProcessLockSync(this.lockPath, "Workflow durable store", () => {
      const current = this.recover();
      if (!current) fail("store-missing", "Workflow durable store is not initialized.");
      const existing = current.payload.receipts.find(receipt => receipt.commandId === command.commandId);
      if (existing) return this.replay<Result>(current, command, existing);
      if (command.expectedStorageEpoch !== current.storageEpoch) fail("storage-epoch-conflict", "Expected storage epoch does not match the current epoch.");
      if (!operation) fail("operation-required", "Operation name is required.");
      const mutation = mutate(current.payload);
      const storageEpoch = current.storageEpoch + 1;
      const receipt: OperationReceipt<Result> = {
        commandId: command.commandId,
        fingerprint: command.fingerprint,
        operation,
        storageEpoch,
        result: clone(mutation.result)
      };
      const payload = validatePayload({
        project: mutation.project,
        runtimes: mutation.runtimes,
        receipts: [...current.payload.receipts, receipt],
        ...(mutation.migration ? { migration: mutation.migration } : {})
      });
      const schema = typeof outputSchema === "number" ? outputSchema : outputSchema(current.payload);
      const envelope = makeEnvelope(schema, storageEpoch, payload);
      this.commit(current.storageEpoch, envelope);
      return { envelope: clone(envelope), receipt: clone(receipt), replayed: false };
    });
  }

  private replayOrFail<Result>(current: DurableStoreEnvelope, command: StoreCommand): StoreResult<Result> {
    const existing = current.payload.receipts.find(receipt => receipt.commandId === command.commandId);
    if (!existing) fail("store-exists", "Workflow durable store is already initialized.");
    return this.replay(current, command, existing);
  }

  private replay<Result>(current: DurableStoreEnvelope, command: StoreCommand, existing: OperationReceipt): StoreResult<Result> {
    if (existing.fingerprint !== command.fingerprint) fail("command-conflict", "Command ID was already used with a different fingerprint.");
    return { envelope: clone(current), receipt: clone(existing) as OperationReceipt<Result>, replayed: true };
  }

  private recover(): DurableStoreEnvelope | undefined {
    fs.mkdirSync(this.directory, { recursive: true });
    const snapshot = this.readEnvelope(this.snapshotPath);
    if (!fs.existsSync(this.journalPath)) {
      if (snapshot && snapshot.schema !== this.schema) fail("store-corrupt", "Workflow durable store schema is not supported.");
      return snapshot;
    }
    let journal: JournalRecord;
    try {
      journal = JSON.parse(fs.readFileSync(this.journalPath, "utf8")) as JournalRecord;
    } catch {
      fail("journal-corrupt", "Workflow durable store journal is corrupt.");
    }
    if (!journal || !Number.isSafeInteger(journal.baseEpoch)) fail("journal-corrupt", "Workflow durable store journal is corrupt.");
    const next = verifyEnvelope(journal.envelope);
    if (journal.baseEpoch < 0 || next.storageEpoch !== journal.baseEpoch + 1) {
      fail("journal-conflict", "Workflow durable store journal has an invalid epoch transition.");
    }
    const schemaMatches = next.schema === this.schema || (snapshot?.schema === this.schema
      && snapshot.payload.migration?.fromSchema === this.schema && snapshot.payload.migration.targetSchema === next.schema);
    if (!schemaMatches) fail("journal-conflict", "Workflow durable store journal has an invalid schema transition.");
    if ((!snapshot && journal.baseEpoch === 0) || (snapshot && snapshot.storageEpoch === journal.baseEpoch)) {
      this.writeSnapshot(next);
    } else if (!snapshot || snapshot.storageEpoch !== next.storageEpoch || snapshot.digest !== next.digest) {
      fail("journal-conflict", "Workflow durable store journal does not extend the snapshot.");
    }
    this.removeJournal();
    return next;
  }

  private readEnvelope(file: string): DurableStoreEnvelope | undefined {
    if (!fs.existsSync(file)) return undefined;
    let parsed: unknown;
    try { parsed = JSON.parse(fs.readFileSync(file, "utf8")); }
    catch { fail("store-corrupt", "Workflow durable store snapshot is corrupt."); }
    return verifyEnvelope(parsed);
  }

  private commit(baseEpoch: number, envelope: DurableStoreEnvelope): void {
    this.crash?.("before-journal");
    this.writeFileAtomically(this.journalPath, canonicalJson({ baseEpoch, envelope }));
    this.crash?.("after-journal-fsync");
    this.writeSnapshot(envelope);
    this.crash?.("after-snapshot-rename");
    this.removeJournal();
    this.crash?.("after-journal-cleanup");
  }

  private writeSnapshot(envelope: DurableStoreEnvelope): void {
    this.writeFileAtomically(this.snapshotPath, canonicalJson(envelope));
  }

  private writeFileAtomically(target: string, contents: string): void {
    const temporary = `${target}.${process.pid}.${randomUUID()}.tmp`;
    const fd = fs.openSync(temporary, "wx", 0o600);
    try {
      fs.writeFileSync(fd, contents, "utf8");
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
    fs.renameSync(temporary, target);
    fsyncDirectory(this.directory);
  }

  private removeJournal(): void {
    fs.unlinkSync(this.journalPath);
    fsyncDirectory(this.directory);
  }
}

function makeEnvelope(schema: number, storageEpoch: number, payload: DurableStorePayload): DurableStoreEnvelope {
  return { schema, storageEpoch, payload, digest: payloadDigest(payload) };
}

function verifyEnvelope(value: unknown): DurableStoreEnvelope {
  if (!isRecord(value) || !Number.isSafeInteger(value.schema) || !Number.isSafeInteger(value.storageEpoch)
    || value.storageEpoch < 1 || !isRecord(value.payload)
    || typeof value.digest !== "string") {
    fail("store-corrupt", "Workflow durable store envelope is invalid.");
  }
  const envelope = value as unknown as DurableStoreEnvelope;
  const payload = validatePayload(envelope.payload);
  if (payloadDigest(payload) !== envelope.digest) fail("store-corrupt", "Workflow durable store digest does not match its payload.");
  return envelope;
}

function validatePayload(payload: DurableStorePayload): DurableStorePayload {
  if (!isRecord(payload) || !isRecord(payload.project) || !isRecord(payload.runtimes) || !Array.isArray(payload.receipts)) {
    fail("store-corrupt", "Workflow durable store payload is invalid.");
  }
  canonicalJson(payload);
  return payload;
}

function fsyncDirectory(directory: string): void {
  let fd: number | undefined;
  try {
    fd = fs.openSync(directory, "r");
    fs.fsyncSync(fd);
  } catch (error: any) {
    if (!error || !["EINVAL", "ENOTSUP", "EISDIR", "EPERM"].includes(error.code)) throw error;
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
}

function clone<T>(value: T): T {
  return JSON.parse(canonicalJson(value)) as T;
}

function isRecord(value: unknown): value is Record<string, any> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function fail(code: string, message: string): never {
  throw new DurableStoreError(code, message);
}