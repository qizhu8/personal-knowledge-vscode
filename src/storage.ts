import { Worker } from "node:worker_threads";
import { codingProcessDatabasePath, workspaceStoragePaths } from "./workspace-storage-paths.js";
import { DatabaseSync } from "node:sqlite";
import { mkdir, lstat } from "node:fs/promises";
import { resolve, join } from "node:path";
import { CoreError, type StorageRequest } from "./contracts.js";
import type { BrowserMutationPin, BrowserMutationReceipt, BrowserMutationReceiptControl } from "./browser-mutation-receipt.js";
import { originalMcpTodoGenesisStorageAdmission } from "./original-mcp-todo-genesis-native.js";
import { verifyOriginalRecoveryState } from "./original-knowledge-recovery-state.js";
import { experimentalTodoGenesisFaultForStorage, reportExperimentalTodoGenesisFault } from "./original-mcp-todo-genesis-fault.js";
import { originalMcpTodoGenesisSourceControlForStorage, type OriginalMcpTodoGenesisSourceScope } from "./original-mcp-todo-genesis-native.js";
import { activateOriginalMcpTodoGenesisOwnerSource,
  type OriginalMcpTodoGenesisSourceControl } from "./original-mcp-todo-genesis-source.js";
import { activateReadoptedMemoryScope, bindMemoryScopeRevocation, deactivateMemoryScopeContinuity,
  type MemoryScopeContinuityRequest } from "./memory-scope-continuity.js";
import { knowledgeArea } from "./document-path.js";
import { activateOriginalMcpTodoSession, deactivateOriginalMcpTodoSession,
  activateOriginalMcpTodoWorker, readOriginalMcpDomain, type OriginalMcpTodoSession } from "./original-mcp-domain-state.js";
import { scanMarkdown } from "./markdown.js";
import { DataRuntime } from "./data-runtime.js";
import { MigrationRuntime } from "./migration-runtime.js";
import { remoteRuntimePending } from "./remote-runtime.js";
import { RUNTIME_PROCESS_DDL } from "./runtime-process-store.js";
import { closeSync, constants, existsSync, openSync, readFileSync } from "node:fs";
import { inspectLegacyControlRecovery } from "./legacy-control-import.js";
import { readLegacyExtensionPendingEnvelope } from "./legacy-command-extension-recovery.js";
import { recoverNativeLegacyCommands } from "./host-composition-legacy-commands.js";
import { readLegacyRecipeTrashPendingEnvelope } from "./legacy-recipe-trash.js";
import { assertPortalRecoveryClear } from "./host-composition-portal.js";
import { readLegacyStateReceipt, readLegacySkillMaintenanceGenesis, verifyBoundLegacyStateBytes, verifyLegacyRetrievalHistoryBinding } from "./host-composition-legacy-state.js";
import { inspectLegacySkillMaintenanceRecovery, recoverLegacySkillMaintenance } from "./legacy-skill-maintenance.js";
import { inspectLegacyRetrievalModelRecovery, recoverLegacyRetrievalModels } from "./legacy-retrieval-model.js";
import { inspectLegacyTodoBoardCreateIntent, type LegacyTodoBoardCreateArguments } from "./legacy-todo-board-create.js";
import { verifyLegacyKnowledgeRecovery } from "./legacy-knowledge-recovery.js";
import { verifyLegacyKnowledgeSnapshots } from "./legacy-knowledge-snapshots.js";
import { verifyLegacyActionArtifacts } from "./legacy-action-artifacts.js";
import { inspectLegacyInlineNoteFence } from "./legacy-inline-note-journal.js";
import { inspectPausedSnapshotJournal, assertSharedSourceRecoveryScope } from "./host-composition-legacy-snapshot-restore.js";
import { verifyInlineNoteWorkspace } from "./host-composition-legacy-inline-note.js";
import { inspectBatch15SkillPending, assertBatch15OtherPending, verifyBatch15SkillWorkspace } from "./host-composition-legacy-batch15-skill.js";
import { assertSkillSourceIntegrated } from "./host-composition-legacy-skill-source.js";
import { assertBatch16UnintegratedClear } from "./host-composition-legacy-batch16-fence.js";
import { validateLegacyMemoryErasureLedger } from "./legacy-memory-erasure.js";
import { inspectNativeClassificationPending } from "./legacy-classification-native.js";
import { inspectLegacyClassificationCommand } from "./legacy-classification-command.js";
import { nativeTodoUserInput, nativeTodoUiChats, NATIVE_TODO_USER_OPERATION, assertNativeTodoUserAuthority,
  assertNativeTodoUserRootAuthority, nativeTodoUserBoards,
  type NativeTodoUserInput, type NativeTodoUiChat, type NativeTodoUserAuthority } from "./native-todo-user-ui.js";
import { legacyTodoBoardCreateSlug } from "./legacy-todo-board-create-contracts.js";
import type { LinuxRootWriterFence } from "./linux-root-writer-fence.js";
import { assertLinuxLegacyWritersQuiescent } from "./linux-legacy-writer-quiescence.js";
import { readMembershipIntent } from "./legacy-subscription-membership-intent.js";
import { consumeMembershipRecoveryAuthority, type MembershipRecoveryPhase } from "./legacy-subscription-membership-authority.js";
import { nativeBoardLifecycleCatalog, nativeBoardLifecycleInput, NATIVE_BOARD_LIFECYCLE_OPERATION,
  type NativeBoardLifecycleInput } from "./native-board-lifecycle-state.js";

import { marker, rootAdoptionJournal, privateRoomRecovery, capturePlainWorkspaceControls, type PrivateRoomRecovery } from "./workspace-validation.js";
import { RootOwner, assertRootOwner, assertRootReadScope, type RootReadScope } from "./root-owner.js";
import type { RootClassification } from "./storage-startup-classification.js";
import type { FreshNoteQuery, FreshNoteQueryReply } from "./fresh-note-query-contracts.js";
import type { OriginalTodoAssignmentAdmission } from "./original-mcp-todo-assignment-gate.js";
import type { ManagedTaskOperation } from "./managed-chat-task-contracts.js";
export { initialize, validateWorkspace } from "./workspace-validation.js";
export type LegacyNotesReadQuery = FreshNoteQuery;
export type LegacyNotesReadResult = ({ readonly kind: "fresh" } & FreshNoteQueryReply)
  | { readonly kind: "canonical-required"; readonly reason: Extract<RootClassification, { kind: "full-required" }>["reason"] };

type Pending = { resolve: (value: unknown) => void; reject: (error: Error) => void };
const attachments = new WeakMap<RootOwner, Promise<Storage>>();
const storageConstructor = Symbol("canonical-storage");
const storageOwners = new WeakMap<object, RootOwner>();
export function assertStorage(value: unknown): asserts value is Storage {
  const owner = value && typeof value === "object" ? storageOwners.get(value) : undefined;
  assertRootOwner(owner);
}
interface NativeSnapshotSchedulerResource {
  pauseForBackup(): Promise<{ assertHeld(): void; release(): Promise<void> | void }>;
  close(): Promise<void>;
}
export class Storage {
  private readonly pending = new Map<number, Pending>();
  private sequence = 0;
  private closed = false;
  private drain: (() => void) | undefined;
  private closing: Promise<void> | undefined;
  private closeRequested = false;
  private snapshotScheduler?: NativeSnapshotSchedulerResource;
  private exited = false;
  private recovered = false;
  private memoryScopeActive = false;
  private recovery: Promise<void> | undefined;
  private worker: Worker;
  private get lease() { return this.owner.workspaceLease(); }
  private exclusiveTail: Promise<void> = Promise.resolve();
  private exclusiveQueued = 0;
  private exclusiveActive = false;
  private readonly retainedResources: Array<{ release(): Promise<void> | void }> = [];
  private constructor(
    token: typeof storageConstructor,
    private readonly root: string,
    private readonly rootAdoptionPrivacySha256: string | undefined,
    private readonly owner: RootOwner,
  ) {
    if (token !== storageConstructor) throw new CoreError("STORAGE_UNAVAILABLE", "Storage requires its canonical attachment constructor.", "unknown");
    assertRootOwner(owner);
    storageOwners.set(this, owner);
    this.worker = new Worker(new URL("./storage-worker.js", import.meta.url), {
      workerData: { root, adoptionPrivacySha256: rootAdoptionPrivacySha256 },
    });
  }

  /** Internal Room-only admission; the VS Code caller must first verify its independent profile pin. */
  static async openPrivateRoomRecovery(root: string, roomId: string, sourceFingerprint: string): Promise<Storage>;
  static async openPrivateRoomRecovery(root: string, archives: { roomId: string; sourceFingerprint: string }[], writerFence?: LinuxRootWriterFence): Promise<Storage>;
  static async openPrivateRoomRecovery(root: string, rooms: string | { roomId: string; sourceFingerprint: string }[], recovery?: string | LinuxRootWriterFence): Promise<Storage> {
    const archives = typeof rooms === "string" ? [{ roomId: rooms, sourceFingerprint: typeof recovery === "string" ? recovery : "" }] : rooms;
    if (resolve(root) !== root || !Array.isArray(archives) || archives.length > 128
      || archives.some(pin => !pin || !/^[A-Za-z0-9_-]{6,80}$/.test(pin.roomId) || !/^[a-f0-9]{64}$/.test(pin.sourceFingerprint))
      || new Set(archives.map(pin => pin.roomId)).size !== archives.length)
      throw new CoreError("INVALID_WORKSPACE", "Invalid private Room recovery binding.");
    return Storage.open(root, { deferRecovery: true, [privateRoomRecovery]: { root, archives },
      ...(typeof recovery === "object" ? { writerFence: recovery } : {}) });
  }
  static async open(directory: string, options: {
    deferRecovery?: boolean;
    adoptionToken?: string;
    writerFence?: LinuxRootWriterFence;
    [privateRoomRecovery]?: PrivateRoomRecovery;
  } = {}) {
    const owner = await RootOwner.acquire(directory, options);
    try {
      return await Storage.attach(owner, options);
    } catch (error) {
      await owner.close();
      throw error;
    }
  }
  static attach(owner: RootOwner, options: { deferRecovery?: boolean } = {}): Promise<Storage> {
    assertRootOwner(owner);
    owner.assertAttachmentAdmission();
    const existing = attachments.get(owner);
    if (existing) return existing;
    const task = Storage.startAttached(owner, options);
    attachments.set(owner, task);
    return task;
  }
  private static async startAttached(owner: RootOwner, options: { deferRecovery?: boolean }): Promise<Storage> {
    await owner.prepareStorageAttachment();
    owner.assertAttachmentAdmission();
    const root = owner.workspaceRoot();
    const activeStore = new Storage(storageConstructor, root, owner.rootAdoptionBootstrapPrivacySha256(), owner);
    owner.retainResource({
      closeAdmission: () => { activeStore.closeRequested = true; },
      release: () => activeStore.closeAttached(),
    });
    try {
      await new Promise<void>((resolve, reject) => {
        activeStore.worker.once("error", reject);
        activeStore.worker.once("exit", code => reject(new CoreError("STORAGE_UNAVAILABLE", `Storage exited before ready (${code}).`)));
        activeStore.worker.on("message", message => {
          if (message.ready) { resolve(); return; }
          const pending = activeStore.pending.get(message.id);
          if (!pending) return;
          activeStore.pending.delete(message.id);
          if (message.error) pending.reject(Object.assign(new CoreError(message.error.code, message.error.message, message.error.effect),
            message.error.experimentalTodoGenesisCheckpoint ? {
              experimentalTodoGenesisCheckpoint: message.error.experimentalTodoGenesisCheckpoint,
              cause: new CoreError(message.error.code, message.error.message, message.error.effect),
            } : {}));
          else pending.resolve(message.result);
          if (!activeStore.pending.size) activeStore.drain?.();
        });
        activeStore.worker.on("exit", code => {
          activeStore.exited = true;
          activeStore.closed = true;
          for (const pending of activeStore.pending.values()) pending.reject(new CoreError("STORAGE_UNAVAILABLE", `Storage worker exited (${code}); reconcile pending writes.`, "unknown"));
          activeStore.pending.clear();
          activeStore.drain?.();
        });
      });
      activeStore.worker.on("error", error => {
        console.error("PKM next storage worker:", error);
      });
      if (process.platform === "linux" && (existsSync(join(root, rootAdoptionJournal))
        || existsSync(join(root, ".pkm-next-original-mcp.json"))))
        await assertLinuxLegacyWritersQuiescent(root);
      owner.acquireWorkspaceLease();
      if (!options.deferRecovery && !activeStore.hasPendingLegacyNoteWorkItemsIntent() && !activeStore.hasPendingSharedSourceIntent()) await activeStore.recover();
      return activeStore;
    } catch (error) {
      try { await activeStore.worker.terminate(); }
      catch {
        throw new CoreError("STORAGE_UNAVAILABLE",
          "Storage startup failed and worker termination could not be verified; the writer fence remains held.", "unknown");
      }
      activeStore.exited = true;
      activeStore.closed = true;
      throw error;
    }
  }
  workspaceRoot(): string { return this.root; }
  rootAdoptionBootstrapPrivacySha256(): string | undefined { return this.rootAdoptionPrivacySha256; }
  retainResource(resource: { release(): Promise<void> | void }): void {
    if (this.closed) throw new CoreError("STORAGE_UNAVAILABLE", "Cannot retain a resource on closed storage.");
    this.retainedResources.push(resource);
  }
  retainNativeCleanup(resource: { release(): Promise<void> | void }): void {
    assertStorage(this);
    this.owner.retainResource(resource);
  }
  workspaceLease(): Readonly<{ ownerId: string; fence: number }> {
    this.assertWorkspaceLease();
    return this.lease!;
  }
  onLeaseLost(handler: (error: CoreError) => void): void { this.owner.onLeaseLost(handler); }
  /** Private backend port. Caller owns live actor/privacy/routing authorization; do not nest an exclusive. */
  async readLegacyNotes(scope: RootReadScope, query: LegacyNotesReadQuery): Promise<LegacyNotesReadResult> {
    assertStorage(this);
    const assertScope = () => {
      assertRootReadScope(scope, this.owner);
      if (scope.full?.storage !== this || this.closed || this.closing)
        throw new CoreError("STORAGE_UNAVAILABLE", "Fresh Note reads require this live native attachment.", "unknown");
    };
    assertScope();
    return this.withWorkspaceExclusive<LegacyNotesReadResult>(async () => {
      assertScope();
      const eligibility = await this.owner.qualifyFreshLegacyReadScope(scope);
      if (eligibility.kind !== "plain") return { kind: "canonical-required", reason: eligibility.reason };
      this.assertNoPendingLegacyNoteWorkItems();
      if (this.hasPendingSharedSourceIntent())
        throw new CoreError("RECOVERY_REQUIRED", "Shared-source recovery blocks fresh Note reads.", "unknown");
      const before = capturePlainWorkspaceControls(this.root);
      if (!before) return { kind: "canonical-required", reason: "layout" };
      if (!this.recovered)
        throw new CoreError("STORAGE_UNAVAILABLE", "Workspace recovery must complete before fresh Note reads are accepted.");
      const result = await new Promise<LegacyNotesReadResult>((resolveRead, reject) => {
        const id = ++this.sequence;
        this.pending.set(id, { resolve: value => resolveRead(value as LegacyNotesReadResult), reject });
        try {
          assertScope();
          this.worker.postMessage({ id, freshLegacyNotes: query, runtimeOwner: this.lease });
        } catch (error) { this.pending.delete(id); reject(error); }
      });
      assertScope();
      const current = await this.owner.qualifyFreshLegacyReadScope(scope);
      const after = capturePlainWorkspaceControls(this.root);
      if (!after || after.digest !== before.digest)
        throw new CoreError("CONFLICT", "Workspace controls changed during the Note read.");
      assertScope();
      if (result.kind === "fresh") {
        if (current.kind !== "plain")
          throw new CoreError("RECOVERY_REQUIRED", "Workspace state changed during the Note read.", "unknown");
      }
      return result;
    });
  }
  assertNoPendingLegacyNoteWorkItems(): void {
    if (this.hasPendingLegacyNoteWorkItemsIntent()) {
      throw new CoreError("BUSY", "A legacy Note operation requires exact native recovery before workspace admission.", "unknown");
    }
  }
  assertWorkspaceLease(): void {
    if (this.closed) throw new CoreError("STORAGE_UNAVAILABLE", "Workspace ownership lease is unavailable.", "unknown");
    this.owner.assertWorkspaceLease();
  }
  async workspaceId(): Promise<string> {
    if (this.closed) throw new CoreError("STORAGE_UNAVAILABLE", "Storage is closed.");
    return this.owner.workspaceId();
  }
  connectNative(): DatabaseSync {
    if (this.closed) throw new CoreError("STORAGE_UNAVAILABLE", "Storage is closed.");
    return this.owner.connectNative();
  }
  connectCodingProcess(): DatabaseSync {
    this.assertWorkspaceLease();
    if (workspaceStoragePaths(this.root).layout === "separated" && !existsSync(codingProcessDatabasePath(this.root)))
      closeSync(openSync(codingProcessDatabasePath(this.root), constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW ?? 0), 0o600));
    const database = new DatabaseSync(codingProcessDatabasePath(this.root));
    try {
      database.exec("PRAGMA busy_timeout=3000; PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA foreign_keys=ON;");
      const version = Number(database.prepare("PRAGMA user_version").get()?.user_version);
      if (![0, 1].includes(version)) throw new CoreError("INVALID_CONFIGURATION", "Unsupported coding process journal version.");
      database.exec("BEGIN IMMEDIATE");
      try {
        database.exec(RUNTIME_PROCESS_DDL);
        this.assertWorkspaceLease();
        database.exec("PRAGMA user_version=1; COMMIT");
      } catch (error) { if (database.isTransaction) database.exec("ROLLBACK"); throw error; }
      this.assertWorkspaceLease();
      return database;
    } catch (error) { database.close(); throw error; }
  }
  inspectCodingProcess(): void {
    this.assertWorkspaceLease();
    const path = codingProcessDatabasePath(this.root);
    if (!existsSync(path)) return;
    const database = new DatabaseSync(path, { readOnly: true });
    try {
      const version = Number(database.prepare("PRAGMA user_version").get()?.user_version);
      if (version !== 1 || database.prepare("PRAGMA quick_check").get()?.quick_check !== "ok")
        throw new CoreError("CODING_RESTART_FENCED", "Coding process journal requires native version/integrity reconciliation.", "unknown");
      if (database.prepare("SELECT 1 FROM runtime_process_owner WHERE closed=0 LIMIT 1").get()
        || database.prepare("SELECT 1 FROM runtime_process_jobs WHERE state IN ('QUEUED','RUNNING') LIMIT 1").get())
        throw new CoreError("CODING_RESTART_FENCED", "Interrupted coding checks require native observation; no process is relaunched.", "unknown");
      this.assertWorkspaceLease();
    } finally { database.close(); }
  }
  async provisionTrash(): Promise<void> {
    this.assertWorkspaceLease();
    for (const area of knowledgeArea.options) {
      const directory = join(this.root, area);
      await mkdir(directory, { recursive: true, mode: 0o700 });
      const stat = await lstat(directory);
      if (stat.isSymbolicLink() || !stat.isDirectory()) throw new CoreError("INVALID_WORKSPACE", "Trash area must be a real directory.");
      await mkdir(join(directory, ".trash"), { recursive: true, mode: 0o700 });
      const trash = await lstat(join(directory, ".trash"));
      if (trash.isSymbolicLink() || !trash.isDirectory()) throw new CoreError("INVALID_WORKSPACE", "Trash must be a real directory.");
    }
    this.assertWorkspaceLease();
  }
  async validateTrash(): Promise<void> {
    this.assertWorkspaceLease();
    for (const area of knowledgeArea.options) {
      for (const directory of [join(this.root, area), join(this.root, area, ".trash")]) {
        const info = await lstat(directory);
        if (info.isSymbolicLink() || !info.isDirectory()) throw new CoreError("INVALID_WORKSPACE", "Trash must be a real directory.");
      }
    }
    this.assertWorkspaceLease();
  }

  private createDefaultDataRuntime(database: DatabaseSync, root: string, workspaceId: string) {
    const storage = this;
    return new DataRuntime({
      database, root, workspaceId,
      transaction<T>(work: () => T): T {
        storage.assertWorkspaceLease();
        database.exec("BEGIN IMMEDIATE");
        try {
          const result = work();
          if (result && typeof (result as { then?: unknown }).then === "function") throw new Error("Async transaction callback.");
          storage.assertWorkspaceLease();
          database.exec("COMMIT");
          return result;
        } catch (error) {
          if (database.isTransaction) database.exec("ROLLBACK");
          throw error;
        }
      },
      reconcileIndex() {
        const docs = scanMarkdown(root);
        database.prepare("DELETE FROM documents").run();
        const insert = database.prepare("INSERT INTO documents(id,title,revision,deleted,sha256,path,area) VALUES(?,?,?,?,?,?,?)");
        for (const { record } of docs) insert.run(record.id, record.title, record.revision, record.deleted ? 1 : 0,
          record.sha256, record.path, record.area);
      },
      assertOperationAvailable(operationId) {
        if (remoteRuntimePending(database)) throw new CoreError("BUSY", "A remote operation requires native reconciliation.");
        for (const table of ["pending_write", "pending_todo", "pending_asset", "pending_resource",
          "pending_document_lifecycle", "pending_project_mutation", "data_runtime_intents", "migration_runtime_intents",
          "legacy_note_workitems_intent"]) {
          if (database.prepare(`SELECT 1 FROM ${table}`).get()) {
            throw new CoreError("BUSY", "A different durable workspace intent must be reconciled first.");
          }
          if (!operationId) throw new CoreError("INVALID_ARGUMENT", "Durable operationId is required.");
        }
      },
    });
  }
  recover(preflight?: (database: DatabaseSync) => Promise<void>): Promise<void> {
    if (this.recovered) return Promise.resolve();
    if (this.recovery) return this.recovery;
    if (this.closed) return Promise.reject(new CoreError("STORAGE_UNAVAILABLE", "Storage is closed."));
    this.recovery = (async () => {
      this.assertWorkspaceLease();
      this.inspectCodingProcess();
      const database = this.connectNative();
      try {
        const workspaceId = await this.workspaceId();
        verifyOriginalRecoveryState(database, this.root);
        for (const domain of ["todo", "memory"] as const) {
          const state = readOriginalMcpDomain(this.root, domain, database);
          if (state && !state.committed)
            throw new CoreError("RECOVERY_REQUIRED", "Original source-domain hydration requires its exact fresh native-approved continuation.");
        }
        verifyLegacyKnowledgeRecovery(database, this.root);
        verifyLegacyKnowledgeSnapshots(database, this.root);
        verifyLegacyActionArtifacts(database, workspaceId);
        inspectLegacyTodoBoardCreateIntent(database, this.root);
        inspectLegacyRetrievalModelRecovery(database, this.root);
        verifyLegacyRetrievalHistoryBinding(database, workspaceId);
        inspectLegacySkillMaintenanceRecovery(database, this.root, readLegacySkillMaintenanceGenesis(database, workspaceId));
        assertBatch16UnintegratedClear(database, true, undefined, !!preflight, false, !!preflight);
        if (assertSkillSourceIntegrated(database, !!preflight).active) return;
        if (validateLegacyMemoryErasureLedger(database, await this.workspaceId()).state !== "uninitialized")
          return;
        assertPortalRecoveryClear(database);
        readLegacyStateReceipt(database, workspaceId);
        const inlineIntent = inspectLegacyInlineNoteFence(database);
        const snapshotUnknown = inspectPausedSnapshotJournal(database);
        const skillIntent = inspectBatch15SkillPending(database);
        const classificationIntent = inspectNativeClassificationPending(database);
        const originalClassification = inspectLegacyClassificationCommand(database);
        if (originalClassification.pending || preflight && originalClassification.receipts.length) return;
        if (classificationIntent || preflight && database.prepare("SELECT 1 FROM legacy_classification_native_receipt LIMIT 1").get()) return;
        if (skillIntent) assertBatch15OtherPending(database);
        if (inlineIntent || snapshotUnknown) assertSharedSourceRecoveryScope(database, !!inlineIntent);
        if (inlineIntent && snapshotUnknown) throw new CoreError("RECOVERY_CONFLICT", "Multiple shared-source effects require reconciliation before any effect.", "unknown");
        const extension = readLegacyExtensionPendingEnvelope(database);
        const recipeTrash = readLegacyRecipeTrashPendingEnvelope(database);
        const noteIntent = database.prepare("SELECT operation_id,actor_id,operation,request_json,native_operation,native_args FROM legacy_note_workitems_intent WHERE singleton=1")
          .get() as Record<string, unknown> | undefined;
        if (!extension && !recipeTrash) inspectLegacyControlRecovery(database, workspaceId);
        if (recipeTrash && !preflight) throw new CoreError("RECOVERY_AUTHORITY_REQUIRED", "Recipe trash recovery requires an explicit native host policy.", "unknown");
        if (noteIntent && (!preflight || extension || recipeTrash)) {
          throw new CoreError("RECOVERY_AUTHORITY_REQUIRED", "Original Note recovery requires its exact injected native host before workspace recovery.", "unknown");
        }
        const pendingTables = ["pending_write", "pending_todo", "pending_asset", "pending_resource",
          "pending_document_lifecycle", "pending_project_mutation", "data_runtime_intents", "migration_runtime_intents",
          "legacy_note_workitems_intent", "legacy_inline_note_intent"];
        let intents = 0;
        for (const table of pendingTables) intents += Number(database.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get()!.count);
        if ((inlineIntent || snapshotUnknown) && (intents !== Number(!!inlineIntent) || extension || recipeTrash
          || remoteRuntimePending(database) || database.prepare("SELECT 1 FROM coding_worker_effects WHERE state='intent'").get()
          || database.prepare("SELECT 1 FROM coding_worker_records WHERE kind IN ('worker','check-intent') AND json_extract(record,'$.status')='intent'").get()))
          throw new CoreError("RECOVERY_CONFLICT", "Shared-source unknown journal conflicts with another workspace effect; no recovery attempted.", "unknown");
        if (!inlineIntent) await verifyInlineNoteWorkspace(database, this.root);
        if (!skillIntent) verifyBatch15SkillWorkspace(database, this.root);
        if (noteIntent) {
          let nativeArgs: Record<string, unknown>;
          try { nativeArgs = JSON.parse(String(noteIntent.native_args)) as Record<string, unknown>; }
          catch { throw new CoreError("RECOVERY_CONFLICT", "Original Note intent arguments are malformed.", "unknown"); }
          const nativeTodo = database.prepare("SELECT operation_id,actor_id,operation,board_slug FROM pending_todo WHERE singleton=1")
            .get() as Record<string, unknown> | undefined;
          if (nativeTodo) {
            if (nativeTodo.operation_id !== noteIntent.operation_id || nativeTodo.actor_id !== noteIntent.actor_id
              || nativeTodo.operation !== noteIntent.native_operation || nativeTodo.board_slug !== nativeArgs.board_slug) {
              throw new CoreError("RECOVERY_CONFLICT", "Native Todo intent disagrees with the original Note recovery envelope.", "unknown");
            }
            intents--;
          }
          if (database.prepare("SELECT 1 FROM legacy_note_workitems_receipt WHERE operation_id=?").get(String(noteIntent.operation_id))) {
            throw new CoreError("RECOVERY_CONFLICT", "Original Note intent already has a compatibility receipt; preserve it for reconciliation.", "unknown");
          }
        }
        const remotePending = remoteRuntimePending(database);
        if (remotePending && (intents || !preflight))
          throw new CoreError("RECOVERY_CONFLICT", "Remote effects require native preflight before any workspace recovery.", "unknown");
        if (database.prepare("SELECT 1 FROM coding_worker_effects WHERE state='intent' LIMIT 1").get()
          || database.prepare("SELECT 1 FROM coding_worker_records WHERE kind IN ('worker','check-intent') AND json_extract(record,'$.status')='intent' LIMIT 1").get())
          throw new CoreError("RECOVERY_CONFLICT", "Coding effects require read-only native reconciliation before workspace recovery.", "unknown");
        // Extension metadata is validated against its pending_project_mutation row above,
        // not a second independently executable intent.
        if (intents + Number(!!recipeTrash) > 1) throw new CoreError("RECOVERY_CONFLICT", "Multiple durable workspace intents require reconciliation before any effect.");
        if (extension) {
          const lease = this.workspaceLease();
          recoverNativeLegacyCommands(database, this.root, () => {
            const owner = database.prepare("SELECT owner_id,fence,lease_until FROM native_runtime_owner WHERE singleton=1").get();
            if (!owner || owner.owner_id !== lease.ownerId || owner.fence !== lease.fence || Number(owner.lease_until) <= Date.now()) {
              throw new CoreError("STORAGE_UNAVAILABLE", "Extension recovery owner lease is fenced.", "unknown");
            }
          });
          inspectLegacyControlRecovery(database, workspaceId);
        }
        if (preflight) await preflight(database);
        else if (!inlineIntent && !snapshotUnknown && !skillIntent) {
          const workspaceId = await this.workspaceId();
          const data = this.createDefaultDataRuntime(database, this.root, workspaceId);
          const migration = new MigrationRuntime({
            database, root: this.root, workspaceId,
            transaction: work => {
              this.assertWorkspaceLease();
              if (database.isTransaction) throw new CoreError("TRANSACTION_BOUNDARY", "Nested recovery transaction.");
              database.exec("BEGIN IMMEDIATE");
              try {
                const result = work();
                if (result && typeof (result as { then?: unknown }).then === "function") throw new CoreError("TRANSACTION_BOUNDARY", "Async recovery transaction.");
                this.assertWorkspaceLease(); database.exec("COMMIT"); return result;
              } catch (error) { if (database.isTransaction) database.exec("ROLLBACK"); throw error; }
            },
            reconcileIndex: () => {
              const documents = scanMarkdown(this.root);
              database.prepare("DELETE FROM documents").run();
              const insert = database.prepare("INSERT INTO documents(id,title,revision,deleted,sha256,path,area) VALUES(?,?,?,?,?,?,?)");
              for (const { record } of documents) insert.run(record.id, record.title, record.revision, record.deleted ? 1 : 0, record.sha256, record.path, record.area);
            },
            assertOperationAvailable: () => { throw new CoreError("BUSY", "Default recovery cannot create new intents."); },
          });
          try { await data.inspectRecovery(); await migration.inspectRecovery(); await data.recover(); await migration.recover(); }
          finally { data.close(); migration.close(); }
        }
        recoverLegacySkillMaintenance(database, this.root, {
          genesis: readLegacySkillMaintenanceGenesis(database, workspaceId),
          assertWorkspaceLease: () => this.assertWorkspaceLease(),
        });
        recoverLegacyRetrievalModels(database, this.root, { assertWorkspaceLease: () => this.assertWorkspaceLease() });
        if (readLegacyStateReceipt(database, workspaceId)?.plan.retrievalHistoryPlan) {
          await verifyBoundLegacyStateBytes(database, this.root, workspaceId);
        }
        const id = ++this.sequence;
        const response = new Promise<void>((resolve, reject) => {
          this.pending.set(id, {
            resolve: () => resolve(),
            reject,
          });
        });
        try { this.worker.postMessage({ id, recover: true, runtimeOwner: this.lease }); }
        catch (error) { this.pending.delete(id); throw error; }
        await response;
        this.recovered = true;
      } finally { database.close(); }
    })().finally(() => { this.recovery = undefined; });
    return this.recovery;
  }
  bindBrowserMutationPin(request: StorageRequest, bodySha256: string, receiptMode: "worker" | "unknown" = "worker"): Promise<void> {
    if (!this.recovered || this.exclusiveActive || this.exclusiveQueued)
      return Promise.reject(new CoreError("BUSY", "Mutation ingress requires a recovered available workspace."));
    return this.postMutationReceipt({ bind: { request, bodySha256, receiptMode } }).then(() => undefined);
  }
  readBrowserMutationReceipt(pin: BrowserMutationPin): Promise<BrowserMutationReceipt> {
    return this.postMutationReceipt({ read: pin }) as Promise<BrowserMutationReceipt>;
  }
  private postMutationReceipt(mutationReceipt: BrowserMutationReceiptControl): Promise<unknown> {
    if (this.closed || this.closeRequested || this.closing)
      return Promise.reject(new CoreError("STORAGE_UNAVAILABLE", "Storage is closed.", "unknown"));
    if (this.pending.size >= 32) return Promise.reject(new CoreError("BUSY", "Storage receipt queue is full.", "unknown"));
    return new Promise((resolve, reject) => {
      const id = ++this.sequence;
      this.pending.set(id, { resolve, reject });
      try {
        this.assertWorkspaceLease();
        this.worker.postMessage({ id, runtimeOwner: this.lease, mutationReceipt });
      } catch (error) { this.pending.delete(id); reject(error); }
    });
  }
  request(request: StorageRequest): Promise<unknown> {
    if (request.operation.startsWith("chat.task."))
      return Promise.reject(new CoreError("NATIVE_AUTHORITY_REQUIRED", "Managed Tasks require their actual private native Core scope."));
    if (request.actorId === "user:local" && request.operation === "todo.board.create")
      return Promise.reject(new CoreError("ACCESS_DENIED", "User Board creation requires the trusted fixture channel."));
    if (this.closed || this.closeRequested || this.closing) return Promise.reject(new CoreError("STORAGE_UNAVAILABLE", "Storage is closed."));
    if (!this.recovered) return Promise.reject(new CoreError("STORAGE_UNAVAILABLE", "Workspace recovery must complete before requests are accepted."));
    if (request.operation === "todo.board.create") {
      const admission = originalMcpTodoGenesisStorageAdmission(this, request);
      if (admission) return this.withWorkspaceExclusive(() =>
        this.postRequest(request, undefined, undefined, undefined, undefined, admission));
    }
    try { this.assertNoPendingLegacyNoteWorkItems(); }
    catch (error) { return Promise.reject(error); }
    try {
      if (this.hasPendingSharedSourceIntent()) throw new CoreError("RECOVERY_REQUIRED", "Shared-source journal requires explicit native reconciliation.", "unknown");
    } catch (error) { return Promise.reject(error); }
    if (this.exclusiveActive || this.exclusiveQueued) return Promise.reject(new CoreError("BUSY", "A native workspace journal is being applied; request was not dispatched."));
    return this.postRequest(request);
  }
  recoverOriginalMcpTodoGenesis(plan: import("./original-mcp-todo-genesis-contracts.js").OriginalMcpTodoGenesisPlan): Promise<unknown> {
    if (this.closed || this.closeRequested || this.closing || plan.request.phase !== "recover")
      return Promise.reject(new CoreError("STORAGE_UNAVAILABLE", "Todo genesis recovery requires its current private Root channel."));
    const request: StorageRequest = { operation: "todo.board.create", actorId: "mcp:external",
      args: { board_slug: plan.request.selection.boardSlug, operationId: plan.request.operationId } };
    const admission = originalMcpTodoGenesisStorageAdmission(this, request);
    if (!admission || admission.plan.planSha256 !== plan.planSha256)
      return Promise.reject(new CoreError("NATIVE_AUTHORITY_REQUIRED", "Fresh exact signed Todo genesis recovery is required."));
    return this.withWorkspaceExclusive(() => this.postRequest(request, undefined, undefined, undefined, undefined, admission));
  }
  async requestManagedChatTask(grant: object, operation: ManagedTaskOperation, args: Record<string, unknown>): Promise<unknown> {
    if (this.closed || this.closeRequested || this.closing || !this.recovered || this.exclusiveActive || this.exclusiveQueued)
      throw new CoreError("STORAGE_UNAVAILABLE", "Managed Task admission requires recovered available canonical Storage.");
    this.assertNoPendingLegacyNoteWorkItems();
    if (this.hasPendingSharedSourceIntent()) throw new CoreError("RECOVERY_REQUIRED", "Shared-source recovery blocks managed Tasks.");
    const { readManagedChatTaskWorkerAdmission } = await import("./managed-chat-task-native.js");
    const admission = await readManagedChatTaskWorkerAdmission(grant, this.owner, operation);
    this.assertWorkspaceLease();
    if (this.closed || this.closeRequested || this.closing || this.exclusiveActive || this.exclusiveQueued)
      throw new CoreError("BUSY", "Managed Task authority changed before worker dispatch.");
    if (this.pending.size >= 32) throw new CoreError("BUSY", "Storage queue is full.");
    return new Promise((resolve, reject) => {
      const id = ++this.sequence;
      this.pending.set(id, { resolve, reject });
      try { this.worker.postMessage({ id, managedChatTask: { operation, args, admission }, runtimeOwner: this.lease }); }
      catch (error) { this.pending.delete(id); reject(error); }
    });
  }
  async requestOriginalMcpTodoChatAssignment(prepared: unknown): Promise<unknown> {
    if (this.closed || this.closeRequested || this.closing || !this.recovered || this.exclusiveActive || this.exclusiveQueued)
      throw new CoreError("STORAGE_UNAVAILABLE", "Original Chat assignment requires recovered available canonical Storage.");
    this.assertNoPendingLegacyNoteWorkItems();
    if (this.hasPendingSharedSourceIntent()) throw new CoreError("RECOVERY_REQUIRED", "Shared-source recovery blocks original Chat assignment.");
    const { readOriginalMcpTodoAssignmentAdmission } = await import("./original-mcp-todo-assignment.js");
    const admission = await readOriginalMcpTodoAssignmentAdmission(prepared, this.owner);
    this.assertWorkspaceLease();
    if (this.closed || this.closeRequested || this.closing || this.exclusiveActive || this.exclusiveQueued)
      throw new CoreError("BUSY", "Original Chat assignment admission changed before dispatch.");
    return this.postOriginalTodoAssignment(admission);
  }
  private postOriginalTodoAssignment(originalTodoAssignment: OriginalTodoAssignmentAdmission): Promise<unknown> {
    if (this.pending.size >= 32) return Promise.reject(new CoreError("BUSY", "Storage queue is full."));
    return new Promise((resolve, reject) => {
      const id = ++this.sequence;
      this.pending.set(id, { resolve, reject });
      try {
        this.assertWorkspaceLease();
        this.worker.postMessage({ id, originalTodoAssignment, runtimeOwner: this.lease });
      } catch (error) { this.pending.delete(id); reject(error); }
    });
  }
  async requestOriginalTodoRole(resource: unknown): Promise<unknown> {
    if (this.closed || this.closeRequested || this.closing || !this.recovered || this.exclusiveActive || this.exclusiveQueued)
      throw new CoreError("BUSY", "Todo role effects require the current available canonical owner.");
    this.assertWorkspaceLease(); this.assertNoPendingLegacyNoteWorkItems();
    if (this.hasPendingSharedSourceIntent()) throw new CoreError("RECOVERY_REQUIRED", "Shared-source recovery blocks Todo roles.");
    const { readOriginalTodoRoleAdmission } = await import("./original-mcp-todo-role-native.js");
    const originalTodoRole = await readOriginalTodoRoleAdmission(resource, this.owner, this);
    if (this.pending.size >= 32 || this.closed || this.closeRequested || this.closing || this.exclusiveActive || this.exclusiveQueued)
      throw new CoreError("BUSY", "Todo role admission changed before worker dispatch.");
    return new Promise((resolve, reject) => {
      const id = ++this.sequence;
      this.pending.set(id, { resolve, reject });
      try {
        this.assertWorkspaceLease();
        this.worker.postMessage({ id, originalTodoRole, runtimeOwner: this.lease });
      } catch (error) { this.pending.delete(id); reject(error); }
    });
  }
  async requestOriginalRecovery(capsule: import("./original-knowledge-recovery-native.js").OriginalRecoveryWorkerCapsule): Promise<unknown> {
    if (this.closed || this.closeRequested || this.closing || !this.recovered || !this.exclusiveActive || this.pending.size)
      throw new CoreError("BUSY", "Recovery uses only its current exclusive, already attached canonical owner; no lost-Root admission bypass.");
    this.assertWorkspaceLease();
    const { readOriginalRecoveryWorkerCapsule } = await import("./original-knowledge-recovery-native.js");
    const originalRecovery = readOriginalRecoveryWorkerCapsule(this, capsule);
    return new Promise((resolve, reject) => {
      const id = ++this.sequence; this.pending.set(id, { resolve, reject });
      try { this.assertWorkspaceLease(); this.worker.postMessage({ id, originalRecovery, runtimeOwner: this.lease }); }
      catch (error) { this.pending.delete(id); reject(error); }
    });
  }
  async adoptMemoryScopeContinuity(request: MemoryScopeContinuityRequest,
    approval: { decisionId: string; actorId: string; expiresAtMs: number }, revocation?: SharedArrayBuffer): Promise<void> {
    if (request.workspaceId !== await this.workspaceId())
      throw new CoreError("NOT_AVAILABLE", "Memory admission belongs to another workspace.");
    await this.postMemoryScope({ request, approval, ...(revocation ? { revocation } : {}) });
    try {
      this.assertWorkspaceLease();
      activateReadoptedMemoryScope(this.root, request, approval);
      bindMemoryScopeRevocation(this.root, revocation);
      this.memoryScopeActive = true;
    } catch (error) {
      await this.revokeMemoryScopeContinuity();
      throw error;
    }
  }
  async adoptOriginalMcpTodoSession(session: OriginalMcpTodoSession): Promise<void> {
    await this.postOriginalTodoControl({ originalTodoSession: session });
    try { this.assertWorkspaceLease(); activateOriginalMcpTodoSession(this.root, session); }
    catch (error) { deactivateOriginalMcpTodoSession(this.root); throw error; }
  }
  async adoptOriginalMcpTodoWorker(receiptSha256: string): Promise<void> {
    await this.postOriginalTodoControl({ originalTodoWorkerReceiptSha256: receiptSha256 });
    this.assertWorkspaceLease(); activateOriginalMcpTodoWorker(this.root, receiptSha256);
  }
  async adoptOriginalMcpTodoGenesisSource(capsule: OriginalMcpTodoGenesisSourceScope): Promise<void> {
    const control = originalMcpTodoGenesisSourceControlForStorage(this, capsule);
    await this.postOriginalTodoControl({ originalTodoGenesisSource: control });
    const db = this.connectNative();
    try {
      this.assertWorkspaceLease();
      activateOriginalMcpTodoGenesisOwnerSource(this, db, capsule, this.lease);
    } finally { db.close(); }
  }
  private async postOriginalTodoControl(control: { originalTodoSession: OriginalMcpTodoSession }
    | { originalTodoWorkerReceiptSha256: string } | { originalTodoGenesisSource: OriginalMcpTodoGenesisSourceControl }): Promise<void> {
    if (this.closed || this.closeRequested || this.closing)
      throw new CoreError("STORAGE_UNAVAILABLE", "Storage is closed.");
    await new Promise<void>((resolve, reject) => {
      const id = ++this.sequence;
      this.pending.set(id, { resolve: () => resolve(), reject });
      try {
        this.assertWorkspaceLease();
        this.worker.postMessage({ id, ...control, runtimeOwner: this.lease });
      } catch (error) { this.pending.delete(id); reject(error); }
    });
  }
  async revokeMemoryScopeContinuity(): Promise<void> {
    deactivateMemoryScopeContinuity(this.root);
    this.memoryScopeActive = false;
    await this.postMemoryScope({ revoke: true });
  }
  private postMemoryScope(memoryScope: { request: MemoryScopeContinuityRequest;
    approval: { decisionId: string; actorId: string; expiresAtMs: number }; revocation?: SharedArrayBuffer } | { revoke: true }): Promise<void> {
    if (this.closed || this.closeRequested || this.closing) return Promise.reject(new CoreError("STORAGE_UNAVAILABLE", "Storage is closed."));
    if (this.pending.size >= 32) return Promise.reject(new CoreError("BUSY", "Storage queue is full."));
    return new Promise((resolve, reject) => {
      const id = ++this.sequence;
      this.pending.set(id, { resolve: () => resolve(), reject });
      try {
        this.assertWorkspaceLease();
        this.worker.postMessage({ id, memoryScope, runtimeOwner: this.lease });
      } catch (error) { this.pending.delete(id); reject(error); }
    });
  }
  requestLegacyNoteWorkItems(request: StorageRequest, operationId: string): Promise<unknown> {
    if (this.closed || !this.exclusiveActive && !this.recovery) {
      return Promise.reject(new CoreError("BUSY", "Legacy Note native dispatch requires its exclusive durable fence.", "unknown"));
    }
    if (!this.recovered && !this.recovery) {
      return Promise.reject(new CoreError("STORAGE_UNAVAILABLE", "Workspace recovery must complete before requests are accepted."));
    }
    try {
      this.assertWorkspaceLease();
      const database = this.connectNative();
      try {
        const intent = database.prepare("SELECT operation_id,actor_id,native_operation,native_args FROM legacy_note_workitems_intent WHERE singleton=1")
          .get() as { operation_id: string; actor_id: string; native_operation: string; native_args: string } | undefined;
        if (!intent || intent.operation_id !== operationId || intent.actor_id !== request.actorId
          || intent.native_operation !== request.operation || intent.native_args !== JSON.stringify(request.args)
          || request.args.operationId !== operationId) {
          throw new CoreError("RECOVERY_CONFLICT", "Native Todo request differs from the exact durable Note intent.", "unknown");
        }
      } finally { database.close(); }
    } catch (error) { return Promise.reject(error); }
    return this.postRequest(request, operationId);
  }
  nativeTodoUserBoards(authority?: NativeTodoUserAuthority): readonly string[] {
    this.assertWorkspaceLease();
    const db = this.connectNative();
    try { return nativeTodoUserBoards(this.root, authority, db); } finally { db.close(); }
  }
  async createNativeTodoUserBoard(input: LegacyTodoBoardCreateArguments, authority?: NativeTodoUserAuthority) {
    assertNativeTodoUserRootAuthority(this.root, authority);
    const slug = legacyTodoBoardCreateSlug({ title: input.title, category: input.category });
    const result = await this.withWorkspaceExclusive(() => this.requestLegacyTodoBoardCreate(input, "user:local", authority)) as { digest: string };
    return { ok: true as const, slug, items: [], digest: result.digest };
  }
  nativeTodoUserBoardTrash(authority?: NativeTodoUserAuthority) {
    this.assertWorkspaceLease();
    const db = this.connectNative();
    try {
      const allowed = nativeTodoUserBoards(this.root, authority, db, true);
      return [...nativeBoardLifecycleCatalog(this.root, db).values()].filter(event =>
        event.status === "trashed" && allowed.includes(event.boardKey)).map(event => {
        const trash = JSON.parse(event.trashPlan!);
        return { id: trash.entryId, kind: "item", name: event.path.split("/").at(-1), originalPath: event.path,
          deletedAt: trash.deletedAt, boardSlug: event.boardKey, noteId: event.noteId,
          digest: event.input.expectedDigest, documentDigest: event.documentSha256 };
      });
    } finally { db.close(); }
  }
  async requestNativeBoardLifecycle(value: NativeBoardLifecycleInput, authority?: NativeTodoUserAuthority): Promise<unknown> {
    const input = nativeBoardLifecycleInput.parse(value);
    assertNativeTodoUserRootAuthority(this.root, authority);
    if (!this.recovered || this.closeRequested || this.closing) throw new CoreError("BUSY", "Board file lifecycle requires a recovered native workspace.");
    return this.withWorkspaceExclusive(() => {
      this.assertNoPendingLegacyNoteWorkItems();
      if (this.hasPendingSharedSourceIntent())
        throw new CoreError("RECOVERY_REQUIRED", "Shared-source recovery blocks Board file lifecycle.", "unknown");
      const db = this.connectNative();
      try {
        if (!nativeTodoUserBoards(this.root, authority, db, true).includes(input.boardSlug))
          throw new CoreError("ACCESS_DENIED", "Board file lifecycle is outside the exact trusted fixture scope.");
      } finally { db.close(); }
      return this.postRequest({ operation: NATIVE_BOARD_LIFECYCLE_OPERATION, args: input, actorId: "user:local" },
        undefined, undefined, undefined, input);
    });
  }
  requestLegacyTodoBoardCreate(input: LegacyTodoBoardCreateArguments, actorId: string, authority?: NativeTodoUserAuthority): Promise<unknown> {
    if (this.closed || !this.recovered || !this.exclusiveActive) {
      return Promise.reject(new CoreError("BUSY", "Original Board creation requires a recovered exclusive native host."));
    }
    this.assertWorkspaceLease();
    if (actorId === "user:local") assertNativeTodoUserRootAuthority(this.root, authority);
    else if (actorId !== "mcp:external") return Promise.reject(new CoreError("ACCESS_DENIED", "Unknown Board creator identity."));
    this.assertNoPendingLegacyNoteWorkItems();
    if (this.hasPendingSharedSourceIntent()) return Promise.reject(new CoreError("RECOVERY_REQUIRED", "Shared-source recovery blocks Board creation.", "unknown"));
    return this.postRequest({ operation: "todo.board.create", args: {
      board_slug: input.category ? `${input.category}/${input.title}` : input.title, operationId: input.operationId,
    }, actorId }, undefined, input);
  }
  requestNativeTodoUser(value: NativeTodoUserInput, directory: NativeTodoUiChat[], authority?: NativeTodoUserAuthority): Promise<unknown> {
    if (this.closed || this.closeRequested || this.closing || !this.recovered || this.exclusiveActive || this.exclusiveQueued)
      return Promise.reject(new CoreError("BUSY", "Trusted Todo UI requires a recovered available native workspace."));
    this.assertNoPendingLegacyNoteWorkItems();
    if (this.hasPendingSharedSourceIntent()) return Promise.reject(new CoreError("RECOVERY_REQUIRED", "Shared-source recovery blocks Todo UI.", "unknown"));
    const input = nativeTodoUserInput.parse(value), chats = nativeTodoUiChats.parse(directory);
    const db = this.connectNative();
    try { assertNativeTodoUserAuthority(this.root, input.boardSlug, authority, db); } finally { db.close(); }
    return this.postRequest({ operation: NATIVE_TODO_USER_OPERATION, args: input, actorId: "user:local" },
      undefined, undefined, { input, chats });
  }
  private postRequest(request: StorageRequest, legacyNoteOperationId?: string, originalNoteCreate?: LegacyTodoBoardCreateArguments,
    nativeTodoUser?: { input: NativeTodoUserInput; chats: NativeTodoUiChat[] }, nativeBoardLifecycle?: NativeBoardLifecycleInput,
    originalTodoGenesis?: import("./original-mcp-todo-genesis.js").OriginalMcpTodoGenesisAdmission): Promise<unknown> {
    if (this.pending.size >= 32) return Promise.reject(new CoreError("BUSY", "Storage queue is full; request was not dispatched."));
    return new Promise((resolve, reject) => {
      const id = ++this.sequence;
      const experimentalTodoGenesisFault = originalTodoGenesis
        ? experimentalTodoGenesisFaultForStorage(this, originalTodoGenesis) : undefined;
      this.pending.set(id, { resolve, reject: error => {
        if (experimentalTodoGenesisFault && error instanceof CoreError && error.code === "TODO_GENESIS_EXPERIMENTAL_FAULT") {
          try { reportExperimentalTodoGenesisFault(this, experimentalTodoGenesisFault, error); }
          catch (callbackError) { reject(callbackError); return; }
        }
        reject(error);
      } });
      try {
        this.assertWorkspaceLease();
        this.worker.postMessage({ id, request, runtimeOwner: this.lease, ...(legacyNoteOperationId ? { legacyNoteOperationId } : {}),
          ...(originalNoteCreate ? { originalNoteCreate } : {}), ...(nativeTodoUser ? { nativeTodoUser } : {}),
          ...(nativeBoardLifecycle ? { nativeBoardLifecycle } : {}), ...(originalTodoGenesis ? { originalTodoGenesis } : {}),
          ...(experimentalTodoGenesisFault ? { experimentalTodoGenesisFault } : {}) });
      }
      catch (error) {
        this.pending.delete(id);
        console.error("PKM next storage dispatch:", error);
        reject(new CoreError("STORAGE_UNAVAILABLE", "Could not dispatch the request to storage."));
      }

    });
  }
  private hasPendingLegacyNoteWorkItemsIntent(): boolean {
    if (!this.owner.hasWorkspaceLease()) return false;
    const database = this.connectNative();
    try { return !!database.prepare("SELECT 1 FROM legacy_note_workitems_intent WHERE singleton=1").get(); }
    finally { database.close(); }
  }
  private hasPendingSharedSourceIntent(): boolean {
    const database = this.connectNative();
    try {
      return this.hasPendingSubscriptionMembership(database) || this.hasOtherPendingSharedSource(database);
    }
    finally { database.close(); }
  }
  private hasPendingSubscriptionMembership(database: DatabaseSync): boolean {
    const identity: unknown = JSON.parse(readFileSync(join(this.root, marker), "utf8"));
    if (!identity || typeof identity !== "object" || !("id" in identity) || typeof identity.id !== "string")
      throw new CoreError("INVALID_WORKSPACE", "Workspace identity is invalid.");
    return !!readMembershipIntent(database, identity.id);
  }
  private hasOtherPendingSharedSource(database: DatabaseSync): boolean {
    return !!inspectLegacyInlineNoteFence(database) || !!inspectPausedSnapshotJournal(database) || !!inspectBatch15SkillPending(database)
      || (["todo", "memory"] as const).some(domain => {
        const state = readOriginalMcpDomain(this.root, domain, database);
        return state && !state.committed;
      });
  }
  async withWorkspaceExclusive<T>(work: () => Promise<T> | T,
    recovery?: { authority: object; phase: MembershipRecoveryPhase }): Promise<T> {
    if (this.closed) throw new CoreError("STORAGE_UNAVAILABLE", "Storage is closed.");
    this.exclusiveQueued++;
    const previous = this.exclusiveTail;
    let release!: () => void;
    this.exclusiveTail = previous.then(() => new Promise<void>(resolve => { release = resolve; }));
    await previous;
    if (this.pending.size) await new Promise<void>(resolve => { this.drain = resolve; });
    this.exclusiveQueued--;
    this.exclusiveActive = true;
    try {
      this.assertWorkspaceLease();
      const database = this.connectNative();
      try {
        if (recovery) {
          consumeMembershipRecoveryAuthority(this, database, recovery.authority, recovery.phase);
          if (this.hasOtherPendingSharedSource(database) || this.hasPendingLegacyNoteWorkItemsIntent()
            || inspectLegacyTodoBoardCreateIntent(database, this.root)
            || ["pending_write", "pending_todo", "pending_asset", "pending_resource",
              "pending_document_lifecycle", "pending_project_mutation"].some(table =>
              !!database.prepare(`SELECT 1 FROM ${table} WHERE singleton=1`).get()))
            throw new CoreError("RECOVERY_REQUIRED", "Another workspace journal requires recovery.", "unknown");
        } else if (this.hasPendingSubscriptionMembership(database))
            throw new CoreError("RECOVERY_REQUIRED", "Subscription membership requires explicit recovery.", "unknown");
      } finally { database.close(); }
      return await work();
    } finally {
      this.exclusiveActive = false;
      release();
    }
  }
  registerNativeSnapshotScheduler(resource: NativeSnapshotSchedulerResource): () => void {
    if (this.closed || this.closeRequested || this.closing || this.snapshotScheduler)
      throw new CoreError("BUSY", "A native snapshot scheduler is already owned or Storage is closing.");
    this.snapshotScheduler = resource;
    return () => { if (this.snapshotScheduler === resource) this.snapshotScheduler = undefined; };
  }
  async acquireNativeSnapshotSchedulerQuiescence() {
    return this.snapshotScheduler?.pauseForBackup();
  }
  close(): Promise<void> { return this.owner.close(); }
  private closeAttached(): Promise<void> {
    deactivateOriginalMcpTodoSession(this.root);
    if (this.memoryScopeActive) {
      deactivateMemoryScopeContinuity(this.root);
      this.memoryScopeActive = false;
    }
    if (this.closing) return this.closing;
    if (!this.snapshotScheduler) this.closed = true;
    const closing = (async () => {
      await this.snapshotScheduler?.close();
      this.closed = true;
      await this.exclusiveTail;
      if (this.pending.size) await new Promise<void>(resolve => { this.drain = resolve; });
      if (!this.exited) await new Promise<void>((resolve, reject) => {
        this.worker.once("exit", code => code === 0 ? resolve() : reject(new CoreError("STORAGE_UNAVAILABLE", `Storage shutdown exited (${code}).`, "unknown")));
        this.worker.postMessage({ close: true });
      });
      while (this.retainedResources.length) {
        await this.retainedResources[this.retainedResources.length - 1].release();
        this.retainedResources.pop();
      }
    })();
    this.closing = closing.catch(error => {
      this.closing = undefined;
      throw error;
    });
    return this.closing;
  }
}
