import { DatabaseSync } from "node:sqlite";
import { closeSync, constants, existsSync, fstatSync, lstatSync, openSync, realpathSync, type BigIntStats } from "node:fs";
import { readFile, readdir } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { CoreError } from "./host-composition-legacy-batch15-errors.js";
import {
  acquireLinuxRootWriterFence, isTrustedLinuxRootWriterFence, markLinuxRootNextOwned,
  type LinuxRootWriterFence,
} from "./linux-root-writer-fence.js";
import {
  capturePlainWorkspaceControls, isPlainWorkspaceLayout, marker, rootAdoptionJournal, validateWorkspace, type WorkspaceValidationOptions,
} from "./workspace-validation.js";
import { classifyStorageStartup, type RootClassification } from "./storage-startup-classification.js";
import { STORAGE_OWNER_DDL } from "./storage-owner-schema.js";
import { coreDatabaseFile, coreDatabaseFiles, coreDatabasePath, workspaceStoragePaths, storageLayoutMarker } from "./workspace-storage-paths.js";
import type { Storage } from "./storage.js";
import type { NativeRuntimeOptions, createNativeRuntime } from "./native-runtime.js";
import type { FreshNoteQuery, FreshNoteQueryReply } from "./fresh-note-query-contracts.js";
import type { RootOwnerBasicNoteRead } from "./root-owner-basic-note-read.js";

type NativeRuntime = Awaited<ReturnType<typeof createNativeRuntime>>;
export interface FullRootAttachment {
  readonly storage: Storage;
  readonly runtime: NativeRuntime;
}
export interface RootOwnerOptions extends WorkspaceValidationOptions {
  writerFence?: LinuxRootWriterFence;
  native?: Omit<NativeRuntimeOptions, "storage">;
  /**
   * Trusted same-process factory, deferred until full attachment. Returned fields override native;
   * actual Storage always wins. Register allocated resources with storage.retainNativeCleanup
   * before a possible throw, including failures before createNativeRuntime takes ownership.
   */
  prepareNative?: (storage: Storage) => Promise<Omit<NativeRuntimeOptions, "storage">>;
  /** Denial-only private-state protection, never a writer or human-approval authority. */
  assertPrivateStateProtection?: () => void;
}
function assertPrivateStateProtection(check?: () => void) {
  if (!check) return;
  const result = check() as unknown;
  if (result !== undefined) {
    if (result && (typeof result === "object" || typeof result === "function") && "then" in result)
      void Promise.resolve(result).catch(() => {});
    throw new CoreError("STORAGE_UNAVAILABLE", "Private-state protection must be synchronous and fail closed.", "unknown");
  }
}
export interface RootReadScope {
  readonly root: string;
  readonly workspaceId: string;
  readonly full: FullRootAttachment | undefined;
  assertHeld(): void;
}
interface RootOwnerResource {
  /** Publish shutdown synchronously; owned work must remain usable until release drains it. */
  closeAdmission?(): void;
  release(): Promise<void> | void;
}
const owners = new WeakMap<object, LinuxRootWriterFence>();
const claimedFences = new WeakMap<LinuxRootWriterFence, object>();
const ownerConstructor = Symbol("canonical-root-owner");
const scopes = new WeakMap<object, { owner: RootOwner; active: boolean; validatedPlainControls?: string }>();
export function assertRootOwner(value: unknown): asserts value is RootOwner {
  if (!value || typeof value !== "object" || !owners.has(value))
    throw new CoreError("STORAGE_UNAVAILABLE", "Storage requires its actual canonical root-owner scope.", "unknown");
}
export function assertRootReadScope(value: unknown, owner: RootOwner): asserts value is RootReadScope {
  assertRootOwner(owner);
  const binding = value && typeof value === "object" ? scopes.get(value) : undefined;
  if (!binding?.active || binding.owner !== owner)
    throw new CoreError("STORAGE_UNAVAILABLE", "Root read scope is absent, expired, or belongs to another owner.", "unknown");
  owner.assertWorkspaceLease();
}

export class RootOwner {
  private lease?: { ownerId: string; fence: number };
  private leaseDatabase?: DatabaseSync;
  private leaseFilePins?: string;
  private leaseFailure?: CoreError;
  private leaseTimer?: ReturnType<typeof setInterval>;
  private leaseLost = false;
  private readonly leaseLostHandlers = new Set<(error: CoreError) => void>();
  private state: "fenced" | "plain" | "upgrading" | "full" | "failed" | "closing" | "closed" = "fenced";
  private fullTask?: Promise<FullRootAttachment>;
  private full?: FullRootAttachment;
  private failure?: unknown;
  private closing?: Promise<void>;
  private readonly resources: RootOwnerResource[] = [];
  private activeReads = 0;
  private readonly readDrains = new Set<() => void>();
  private dataVersion?: number;
  private databaseIdentity?: string;
  private identity!: string;
  private classification: RootClassification = { kind: "full-required", reason: "schema" };
  private freshLegacyContext = false;
  private basicNoteTask?: Promise<RootOwnerBasicNoteRead>;
  private constructor(
    token: typeof ownerConstructor,
    private readonly root: string,
    private readonly writerFence: LinuxRootWriterFence,
    private readonly options: RootOwnerOptions,
    private readonly adoptionPrivacySha256?: string,
    private readonly prepareNative?: RootOwnerOptions["prepareNative"],
    private readonly privateStateProtection?: () => void,
  ) {
    if (token !== ownerConstructor || !isTrustedLinuxRootWriterFence(writerFence, root))
      throw new CoreError("STORAGE_UNAVAILABLE", "Root ownership requires its canonical constructor and real writer fence.", "unknown");
    owners.set(this, writerFence);
  }

  /** Opt-in composition for the native public factory; Storage.open remains full bootstrap. */
  static async open(directory: string, options: RootOwnerOptions = {}): Promise<RootOwner> {
    const owner = await RootOwner.acquire(directory, options);
    try {
      owner.classification = options.native !== undefined || !isPlainWorkspaceLayout(await readdir(owner.root), options)
        ? { kind: "full-required", reason: options.native !== undefined ? "native-context" : "layout" }
        : classifyStorageStartup(owner.root);
      if (owner.classification.kind === "plain") {
        const database = owner.connectNative();
        try { database.exec(STORAGE_OWNER_DDL); } finally { database.close(); }
        owner.acquireWorkspaceLease();
        const version = Number(owner.leaseDatabase!.prepare("PRAGMA data_version").get()?.data_version);
        owner.classification = classifyStorageStartup(owner.root, owner.leaseDatabase);
        if (owner.classification.kind === "plain"
          && Number(owner.leaseDatabase!.prepare("PRAGMA data_version").get()?.data_version) === version) {
          owner.state = "plain";
          owner.captureDatabaseGuard(version);
          return owner;
        }
        if (owner.classification.kind === "plain")
          owner.classification = { kind: "full-required", reason: "durable-state" };
      }
      await owner.ensureFull();
      return owner;
    } catch (error) {
      owner.fail(error);
      await owner.close();
      throw error;
    }
  }

  /** Shared admission only; the full Storage worker must bootstrap before acquiring its lease. */
  static async acquire(directory: string, options: RootOwnerOptions = {}): Promise<RootOwner> {
    const prepareNative = options.prepareNative;
    if (prepareNative !== undefined && typeof prepareNative !== "function")
      throw new CoreError("INVALID_CONFIGURATION", "Deferred native preparation requires a same-process function.");
    const privateStateProtection = options.assertPrivateStateProtection;
    if (privateStateProtection !== undefined && typeof privateStateProtection !== "function")
      throw new CoreError("INVALID_CONFIGURATION", "Private-state protection requires a synchronous denial-only function.");
    assertPrivateStateProtection(privateStateProtection);
    const writerFence = options.writerFence === undefined
      ? await acquireLinuxRootWriterFence(directory) : options.writerFence;
    if (claimedFences.has(writerFence))
      throw new CoreError("BUSY", "This writer-fence resource already belongs to a canonical root owner.");
    const claim = {};
    claimedFences.set(writerFence, claim);
    try {
      writerFence.assertHeld();
      const quiescent = async (root: string) => {
        if (process.platform === "linux" && (existsSync(join(root, rootAdoptionJournal))
          || existsSync(join(root, ".pkm-next-original-mcp.json")))) {
          const { assertLinuxLegacyWritersQuiescent } = await import("./linux-legacy-writer-quiescence.js");
          await assertLinuxLegacyWritersQuiescent(root);
        }
      };
      await quiescent(resolve(directory));
      const root = await validateWorkspace(directory, { ...options, originalMcpReadFence: writerFence });
      if (!isTrustedLinuxRootWriterFence(writerFence, root))
        throw new CoreError("STORAGE_UNAVAILABLE", "Storage requires the real exclusive Linux writer-fence resource.");
      await quiescent(root);
      assertPrivateStateProtection(privateStateProtection);
      if (workspaceStoragePaths(root).layout === "separated"
        && !lstatSync(coreDatabasePath(root), { throwIfNoEntry: false }))
        closeSync(openSync(coreDatabasePath(root), constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW ?? 0), 0o600));
      await markLinuxRootNextOwned(root, writerFence);
      let adoptionPrivacySha256: string | undefined;
      if (options.adoptionToken !== undefined) {
        const journal = JSON.parse(await readFile(join(root, rootAdoptionJournal), "utf8")) as Record<string, unknown>;
        const plan = journal.inventoryPlan as Record<string, unknown> | undefined;
        if (journal.token === options.adoptionToken && typeof plan?.inPlacePkmPrivacySha256 === "string")
          adoptionPrivacySha256 = plan.inPlacePkmPrivacySha256;
      }
      const owner = new RootOwner(ownerConstructor, root, writerFence, options, adoptionPrivacySha256, prepareNative, privateStateProtection);
      owner.identity = await owner.workspaceId();
      return owner;
    } catch (error) {
      await writerFence.release();
      claimedFences.delete(writerFence);
      throw error;
    }
  }

  workspaceRoot(): string { assertRootOwner(this); return this.root; }
  rootAdoptionBootstrapPrivacySha256(): string | undefined { assertRootOwner(this); return this.adoptionPrivacySha256; }
  startupClassification(): Readonly<RootClassification> { assertRootOwner(this); return Object.freeze({ ...this.classification }); }
  hasWorkspaceLease(): boolean { assertRootOwner(this); return !!this.lease; }
  async workspaceId(): Promise<string> {
    assertRootOwner(this);
    const identity: unknown = JSON.parse(await readFile(join(this.root, marker), "utf8"));
    if (!identity || typeof identity !== "object" || !("id" in identity)
      || typeof identity.id !== "string" || !/^[0-9a-f-]{36}$/i.test(identity.id))
      throw new CoreError("INVALID_WORKSPACE", "Workspace identity is invalid.");
    return identity.id;
  }
  connectNative(): DatabaseSync {
    assertRootOwner(this);
    if (this.state === "closed") throw new CoreError("STORAGE_UNAVAILABLE", "Storage is closed.");
    assertPrivateStateProtection(this.privateStateProtection);
    const database = new DatabaseSync(coreDatabasePath(this.root));
    try {
      database.exec("PRAGMA busy_timeout=3000; PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA foreign_keys=ON;");
      return database;
    } catch (error) { database.close(); throw error; }
  }
  retainResource(resource: RootOwnerResource): void {
    assertRootOwner(this);
    if (this.state === "closed")
      throw new CoreError("STORAGE_UNAVAILABLE", "Cannot retain a resource on closed storage.");
    this.resources.push(resource);
    if (this.state === "closing") resource.closeAdmission?.();
  }
  workspaceLease(): Readonly<{ ownerId: string; fence: number }> {
    this.assertWorkspaceLease();
    return this.lease!;
  }
  onLeaseLost(handler: (error: CoreError) => void): void { assertRootOwner(this); this.leaseLostHandlers.add(handler); }
  assertWorkspaceLease(): void {
    assertRootOwner(this);
    if (this.state === "closed" || !this.lease)
      throw new CoreError("STORAGE_UNAVAILABLE", "Workspace ownership lease is unavailable.", "unknown");
    if (this.leaseLost) throw this.leaseFailure!;
    try {
      assertPrivateStateProtection(this.privateStateProtection);
      this.assertLeaseFilePins();
      const database = this.leaseDatabase;
      if (!database) throw new CoreError("STORAGE_UNAVAILABLE", "Workspace ownership lease is unavailable.", "unknown");
      if (database.isTransaction)
        throw new CoreError("TRANSACTION_BOUNDARY", "Ownership assertions require the live autocommit lease connection.", "unknown");
      const owner = database.prepare("SELECT owner_id,fence,lease_until FROM native_runtime_owner WHERE singleton=1").get();
      if (owner?.owner_id !== this.lease.ownerId || owner?.fence !== this.lease.fence || Number(owner.lease_until) <= Date.now()) {
        throw new CoreError("STORAGE_UNAVAILABLE", "Workspace ownership lease was lost.", "unknown");
      }
      this.assertLeaseFilePins();
    } catch (error) {
      const failure = error instanceof CoreError ? error
        : new CoreError("STORAGE_UNAVAILABLE", "Workspace ownership lease could not be verified.", "unknown");
      this.loseWorkspaceLease(failure);
      throw failure;
    }
  }
  private filePin(stat: BigIntStats): string[] {
    return [stat.dev, stat.ino, stat.mode, stat.uid, stat.gid, stat.nlink].map(String);
  }
  private captureLeaseFilePins(auxiliary = true): string {
    try {
      if (realpathSync(this.root) !== this.root) throw new Error("Noncanonical root.");
      const parents: string[][] = [];
      let directory = workspaceStoragePaths(this.root).serverData;
      while (true) {
        const stat = lstatSync(directory, { bigint: true });
        if (!stat.isDirectory() || stat.isSymbolicLink() || stat.nlink < 1n) throw new Error("Unsafe root parent.");
        // Directory link counts legitimately change when owned areas/sibling fixtures are created.
        parents.push([directory, ...this.filePin(stat).slice(0, -1)]);
        const parent = dirname(directory);
        if (parent === directory) break;
        directory = parent;
      }
      const files: Array<[string, string[] | null]> = [];
      for (const name of auxiliary ? coreDatabaseFiles : [coreDatabaseFile]) {
        const stat = lstatSync(join(workspaceStoragePaths(this.root).serverData, name), { bigint: true, throwIfNoEntry: false });
        if (!stat) {
          if (name === coreDatabaseFile) throw new Error("Owned database disappeared.");
          files.push([name, null]);
          continue;
        }
        if (!stat.isFile() || stat.isSymbolicLink()) throw new Error("Unsafe owned database file.");
        files.push([name, this.filePin(stat)]);
      }
      const layout = lstatSync(join(this.root, storageLayoutMarker), { bigint: true, throwIfNoEntry: false });
      if (layout) files.push([storageLayoutMarker, this.filePin(layout)]);
      return JSON.stringify([parents, files]);
    } catch (error) {
      if (error instanceof CoreError && error.code === "STORAGE_UNAVAILABLE") throw error;
      throw new CoreError("CONFLICT", "The owned workspace database path, identity, or permissions changed.", "unknown");
    }
  }
  private assertLeaseFilePins(): void {
    if (!this.leaseFilePins || this.captureLeaseFilePins() !== this.leaseFilePins)
      throw new CoreError("CONFLICT", "The owned workspace database path, identity, or permissions changed.", "unknown");
    this.writerFence.assertHeld();
  }
  private openLeaseDatabase(): { database: DatabaseSync; primaryPins: string } {
    this.writerFence.assertHeld();
    const primaryPins = this.captureLeaseFilePins(false);
    const file = openSync(coreDatabasePath(this.root), constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    let database: DatabaseSync | undefined;
    try {
      const opened = fstatSync(file, { bigint: true });
      const openingPin = (stat: BigIntStats) => JSON.stringify([
        ...this.filePin(stat), String(stat.size), String(stat.mtimeNs), String(stat.ctimeNs),
      ]);
      if (!opened.isFile() || openingPin(opened)
        !== openingPin(lstatSync(coreDatabasePath(this.root), { bigint: true })))
        throw new CoreError("CONFLICT", "The workspace database changed while opening its lease connection.", "unknown");
      database = this.connectNative();
      if (this.captureLeaseFilePins(false) !== primaryPins
        || openingPin(fstatSync(file, { bigint: true })) !== openingPin(opened)
        || openingPin(lstatSync(coreDatabasePath(this.root), { bigint: true })) !== openingPin(opened))
        throw new CoreError("CONFLICT", "The workspace database changed while opening its lease connection.", "unknown");
      this.writerFence.assertHeld();
      return { database, primaryPins };
    } catch (error) { database?.close(); throw error; }
    finally { closeSync(file); }
  }
  acquireWorkspaceLease(): void {
    assertRootOwner(this);
    assertPrivateStateProtection(this.privateStateProtection);
    if (this.lease) { this.assertWorkspaceLease(); return; }
    this.writerFence.assertHeld();
    if (!isTrustedLinuxRootWriterFence(this.writerFence, this.root))
      throw new CoreError("STORAGE_UNAVAILABLE", "Workspace ownership requires the real exclusive Linux writer fence.");
    const { database, primaryPins } = this.openLeaseDatabase();
    const ownerId = randomUUID(), now = Date.now(), duration = 30_000;
    try {
      database.exec("BEGIN IMMEDIATE");
      this.writerFence.assertHeld();
      const prior = database.prepare("SELECT owner_id,fence,lease_until FROM native_runtime_owner WHERE singleton=1").get();
      if (prior && (typeof prior.owner_id !== "string" || !prior.owner_id
        || !Number.isSafeInteger(prior.fence) || Number(prior.fence) < 1 || Number(prior.fence) >= Number.MAX_SAFE_INTEGER
        || !Number.isSafeInteger(prior.lease_until) || Number(prior.lease_until) < 0)) {
        throw new CoreError("RECOVERY_REQUIRED", "Native workspace owner lease is malformed and requires exact reconciliation.");
      }
      // On Linux the exclusive root flock is the process-liveness authority; SQL remains the monotonic fencing token.
      if (prior && Number(prior.lease_until) > now && process.platform !== "linux")
        throw new CoreError("BUSY", "Another process currently owns this workspace.", "not-committed");
      const fence = prior ? Number(prior.fence) + 1 : 1;
      database.prepare(`INSERT INTO native_runtime_owner VALUES(1,?,?,?)
        ON CONFLICT(singleton) DO UPDATE SET owner_id=excluded.owner_id,fence=excluded.fence,lease_until=excluded.lease_until`)
        .run(ownerId, fence, now + duration);
      this.writerFence.assertHeld();
      if (this.captureLeaseFilePins(false) !== primaryPins)
        throw new CoreError("CONFLICT", "The workspace database changed before ownership commit.", "unknown");
      database.exec("COMMIT");
      this.lease = { ownerId, fence };
      this.leaseDatabase = database;
      if (this.captureLeaseFilePins(false) !== primaryPins)
        throw new CoreError("CONFLICT", "The workspace database changed during ownership commit.", "unknown");
      this.leaseFilePins = this.captureLeaseFilePins();
      this.leaseTimer = setInterval(() => {
        try {
          assertPrivateStateProtection(this.privateStateProtection);
          this.assertLeaseFilePins();
          const current = Date.now();
          database.exec("BEGIN IMMEDIATE");
          const updated = database.prepare(`UPDATE native_runtime_owner SET lease_until=?
            WHERE singleton=1 AND owner_id=? AND fence=? AND lease_until>?`)
            .run(current + duration, ownerId, fence, current);
          if (updated.changes !== 1) throw new CoreError("STORAGE_UNAVAILABLE", "Workspace ownership lease expired or changed.", "unknown");
          this.assertLeaseFilePins();
          assertPrivateStateProtection(this.privateStateProtection);
          database.exec("COMMIT");
        } catch (error) {
          if (database.isTransaction) database.exec("ROLLBACK");
          this.loseWorkspaceLease(error);
        }
      }, Math.floor(duration / 3));
      this.leaseTimer.unref();
    } catch (error) {
      if (database.isTransaction) database.exec("ROLLBACK");
      throw error;
    } finally { if (!this.lease) database.close(); }
  }
  async prepareStorageAttachment(): Promise<void> {
    this.assertAttachmentAdmission();
    if (this.state === "plain") this.state = "upgrading";
    await this.drainReads();
    await this.closeBasicNotes();
    this.assertAttachmentAdmission();
  }
  assertAttachmentAdmission(): void {
    assertRootOwner(this);
    assertPrivateStateProtection(this.privateStateProtection);
    if (this.state === "closed" || this.state === "failed" || this.state === "closing" && !this.fullTask)
      throw this.failure ?? new CoreError("STORAGE_UNAVAILABLE", "Root admission is closed.", "unknown");
    this.writerFence.assertHeld();
  }
  private loseWorkspaceLease(error?: unknown): void {
    if (this.leaseLost) return;
    this.leaseLost = true;
    if (this.leaseTimer) clearInterval(this.leaseTimer);
    this.leaseTimer = undefined;
    const failure = error instanceof CoreError ? error
      : new CoreError("STORAGE_UNAVAILABLE", "Workspace ownership lease was lost.", "unknown");
    this.leaseFailure = failure;
    this.failure = failure;
    if (this.state !== "closing" && this.state !== "closed") this.state = "failed";
    for (const handler of this.leaseLostHandlers) handler(failure);
  }
  private releaseWorkspaceLease(): void {
    if (this.leaseTimer) clearInterval(this.leaseTimer);
    this.leaseTimer = undefined;
    if (!this.lease) return;
    const database = this.leaseDatabase;
    if (!database) { this.lease = undefined; return; }
    try {
      database.exec("BEGIN IMMEDIATE");
      database.prepare("UPDATE native_runtime_owner SET lease_until=0 WHERE singleton=1 AND owner_id=? AND fence=?")
        .run(this.lease.ownerId, this.lease.fence);
      database.exec("COMMIT");
    } catch {
      if (database.isTransaction) database.exec("ROLLBACK");
    } finally { database.close(); this.leaseDatabase = undefined; this.leaseFilePins = undefined; this.lease = undefined; }
  }

  ensureFull(): Promise<FullRootAttachment> {
    assertRootOwner(this);
    if (this.state === "closing" || this.state === "closed")
      return Promise.reject(this.failure ?? new CoreError("STORAGE_UNAVAILABLE", "Root admission is closed.", "unknown"));
    if (this.state === "failed" && this.full)
      return Promise.reject(this.failure);
    if (this.fullTask) return this.fullTask;
    if (this.state === "failed")
      return Promise.reject(this.failure ?? new CoreError("STORAGE_UNAVAILABLE", "Root admission is closed.", "unknown"));
    this.state = "upgrading";
    this.fullTask = (async () => {
      await this.drainReads();
      await this.closeBasicNotes();
      const { Storage } = await import("./storage.js");
      const storage = await Storage.attach(this, { deferRecovery: true });
      const prepared = this.prepareNative ? await this.prepareNative(storage) : undefined;
      if (this.prepareNative && (!prepared || typeof prepared !== "object" || Array.isArray(prepared)))
        throw new CoreError("INVALID_CONFIGURATION", "Deferred native preparation must return native runtime options.");
      storage.assertWorkspaceLease();
      this.freshLegacyContext = this.options.native === undefined
        && Object.keys(prepared ?? {}).every(key => ["trash", "legacyNoteWorkItems", "workspaceId"].includes(key));
      const { createNativeRuntime } = await import("./native-runtime.js");
      const runtime = await createNativeRuntime({ ...this.options.native, ...prepared, storage });
      this.retainResource({ release: () => runtime.close() });
      this.full = Object.freeze({ storage, runtime });
      if (this.state !== "closing") this.state = "full";
      return this.full;
    })().catch(error => { this.fail(error); throw error; });
    return this.fullTask;
  }
  private fail(error: unknown): void { this.failure = error; if (this.state !== "closing") this.state = "failed"; }
  supportsFreshLegacyReads(scope: RootReadScope): boolean {
    assertRootReadScope(scope, this);
    if (!scope.full) return this.state !== "failed" && !this.full
      && this.options.native === undefined && this.classification.kind === "plain";
    return !!this.full && scope.full === this.full && this.options.native === undefined && this.freshLegacyContext;
  }
  /** Private native backend port; only an admitted plain scope may own the minimal query connection. */
  async readBasicLegacyNotes(scope: RootReadScope, query: FreshNoteQuery): Promise<FreshNoteQueryReply | undefined> {
    assertRootReadScope(scope, this);
    if (scope.full || !this.supportsFreshLegacyReads(scope)) return undefined;
    const attachment = await (this.basicNoteTask ??= import("./root-owner-basic-note-read.js")
      .then(module => {
        assertRootReadScope(scope, this);
        const { database } = this.openLeaseDatabase();
        try {
          this.assertWorkspaceLease();
          return module.createRootOwnerBasicNoteRead(this, database, error => { this.fail(error); });
        } catch (error) { database.close(); throw error; }
      }).catch(error => { this.basicNoteTask = undefined; this.fail(error); throw error; }));
    assertRootReadScope(scope, this);
    return attachment.read(scope, query);
  }
  private async closeBasicNotes(): Promise<void> {
    if (!this.basicNoteTask) return;
    await (await this.basicNoteTask).close();
    this.basicNoteTask = undefined;
  }
  async validateReadScope(scope: RootReadScope): Promise<void> {
    assertRootReadScope(scope, this);
    await validateWorkspace(this.root, { ...this.options, originalMcpReadFence: this.writerFence });
    if (await this.workspaceId() !== this.identity) throw new CoreError("INVALID_WORKSPACE", "Workspace identity changed while owned.");
    assertRootReadScope(scope, this);
  }
  /** Current canonical DB qualification, not an actor authorization or reusable caller token. */
  async qualifyFreshLegacyReadScope(scope: RootReadScope): Promise<RootClassification> {
    assertRootReadScope(scope, this);
    const binding = scopes.get(scope)!;
    let before: ReturnType<typeof capturePlainWorkspaceControls>;
    if (binding.validatedPlainControls && isPlainWorkspaceLayout([], this.options)) {
      try { before = capturePlainWorkspaceControls(this.root); }
      catch (error) {
        if (!(error instanceof CoreError && error.code === "INVALID_WORKSPACE")) throw error;
        await this.validateReadScope(scope);
        throw error;
      }
    }
    if (!before || binding.validatedPlainControls !== before.digest) {
      await this.validateReadScope(scope);
      before = capturePlainWorkspaceControls(this.root);
    }
    if (!this.supportsFreshLegacyReads(scope)) return { kind: "full-required", reason: "native-context" };
    if (!before) return { kind: "full-required", reason: "layout" };
    const database = this.leaseDatabase!;
    const version = Number(database.prepare("PRAGMA data_version").get()?.data_version);
    const classification = classifyStorageStartup(this.root, database);
    assertRootReadScope(scope, this);
    if (Number(database.prepare("PRAGMA data_version").get()?.data_version) !== version)
      throw new CoreError("CONFLICT", "Workspace database changed during fresh qualification.");
    const after = capturePlainWorkspaceControls(this.root);
    if (!after || after.digest !== before.digest)
      throw new CoreError("CONFLICT", "Workspace controls changed during fresh qualification.");
    assertRootReadScope(scope, this);
    // Only the canonical filesystem validation is reusable within this live scope, never SQL or lease results.
    if (isPlainWorkspaceLayout([], this.options)) binding.validatedPlainControls = after.digest;
    return classification;
  }
  private captureDatabaseGuard(version: number): void {
    this.dataVersion = version;
    const stat = lstatSync(coreDatabasePath(this.root), { bigint: true });
    this.databaseIdentity = `${stat.dev}:${stat.ino}`;
  }
  private async refreshPlainAdmission(): Promise<boolean> {
    this.assertWorkspaceLease();
    await validateWorkspace(this.root, { ...this.options, originalMcpReadFence: this.writerFence });
    if (await this.workspaceId() !== this.identity)
      throw new CoreError("INVALID_WORKSPACE", "Workspace identity changed while owned.");
    if (!isPlainWorkspaceLayout(await readdir(this.root), this.options)) {
      this.classification = { kind: "full-required", reason: "layout" };
      return false;
    }
    const stat = lstatSync(coreDatabasePath(this.root), { bigint: true });
    if (`${stat.dev}:${stat.ino}` !== this.databaseIdentity) {
      this.classification = { kind: "full-required", reason: "schema" };
      const error = new CoreError("CONFLICT", "The owned workspace database identity changed.", "unknown");
      this.loseWorkspaceLease(error);
      throw error;
    }
    const database = this.leaseDatabase;
    if (!database) throw new CoreError("STORAGE_UNAVAILABLE", "Root admission is closed.", "unknown");
    const version = Number(database.prepare("PRAGMA data_version").get()?.data_version);
    if (version !== this.dataVersion) {
      this.classification = classifyStorageStartup(this.root, database);
      if (this.classification.kind !== "plain") return false;
      if (Number(database.prepare("PRAGMA data_version").get()?.data_version) !== version) {
        this.classification = { kind: "full-required", reason: "durable-state" };
        return false;
      }
      this.dataVersion = version;
    }
    return true;
  }
  /** A lifetime/read-consistency scope only; it does not authenticate or authorize a Note operation. */
  async withReadScope<T>(work: (scope: RootReadScope) => T | Promise<T>): Promise<T> {
    assertRootOwner(this);
    if (this.state === "plain" && !await this.refreshPlainAdmission()) await this.ensureFull();
    if (this.state === "upgrading") await this.fullTask;
    if (this.state !== "plain" && this.state !== "full")
      throw this.failure ?? new CoreError("STORAGE_UNAVAILABLE", "Root admission is closed.", "unknown");
    this.assertWorkspaceLease();
    const startedPlain = this.state === "plain";
    this.activeReads++;
    let changed = false;
    const scope: RootReadScope = Object.freeze({
      root: this.root, workspaceId: this.identity, full: this.full,
      assertHeld: () => assertRootReadScope(scope, this),
    });
    scopes.set(scope, { owner: this, active: true });
    try {
      const result = await work(scope);
      scope.assertHeld();
      if (startedPlain && !await this.refreshPlainAdmission()) {
        changed = true;
      } else return result;
    } finally {
      scopes.get(scope)!.active = false;
      this.activeReads--;
      if (!this.activeReads) { for (const drain of this.readDrains) drain(); this.readDrains.clear(); }
    }
    if (changed) await this.ensureFull();
    throw new CoreError("CONFLICT", "Root admission changed during the read; its result was not published.");
  }
  private drainReads(): Promise<void> {
    return this.activeReads ? new Promise(resolveDrain => { this.readDrains.add(resolveDrain); }) : Promise.resolve();
  }
  close(): Promise<void> {
    assertRootOwner(this);
    if (this.closing) return this.closing;
    if (this.state === "closed") return Promise.resolve();
    this.state = "closing";
    this.closing = (async () => {
      for (const resource of this.resources) resource.closeAdmission?.();
      await this.drainReads();
      await this.closeBasicNotes();
      if (this.fullTask) await this.fullTask.catch(() => undefined);
      while (this.resources.length) {
        await this.resources[this.resources.length - 1].release();
        this.resources.pop();
      }
      this.releaseWorkspaceLease();
      await this.writerFence.release();
      claimedFences.delete(this.writerFence);
      this.state = "closed";
    })().catch(error => { this.failure = error; this.state = "failed"; this.closing = undefined; throw error; });
    return this.closing;
  }
}
