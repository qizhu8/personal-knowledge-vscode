import { Worker } from "node:worker_threads";
import { DatabaseSync } from "node:sqlite";
import { mkdir, readFile, readdir, writeFile, lstat, realpath } from "node:fs/promises";
import { resolve, join } from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { CoreError, type StorageRequest } from "./contracts.js";
import { activateReadoptedMemoryScope, deactivateMemoryScopeContinuity,
  type MemoryScopeContinuityRequest } from "./memory-scope-continuity.js";
import { knowledgeArea } from "./document-path.js";
import { scanMarkdown } from "./markdown.js";
import { DataRuntime } from "./data-runtime.js";
import { MigrationRuntime } from "./migration-runtime.js";
import { remoteRuntimePending } from "./remote-runtime.js";
import { RUNTIME_PROCESS_DDL } from "./runtime-process-store.js";
import { existsSync, readFileSync } from "node:fs";
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
import { assertLegacyKnowledgeSnapshotPrivacyRoot, verifyLegacyKnowledgeSnapshots } from "./legacy-knowledge-snapshots.js";
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
import { inspectLegacyRootInertInventory } from "./legacy-root-inert-state.js";
import { inspectLegacyUiBootstrapCompatibility, verifyLegacyUiBootstrapCompatibility } from "./legacy-ui-bootstrap-compatibility.js";
import { validateLegacyTodoRootProjection, verifyLegacyTodoProjectionReceipt, verifyLegacyTodoProjectionSource } from "./legacy-todo-root-projection.js";
import { nativeTodoUserInput, nativeTodoUiChats, NATIVE_TODO_USER_OPERATION, assertNativeTodoUserAuthority,
  assertNativeTodoUserRootAuthority, nativeTodoUserBoards,
  type NativeTodoUserInput, type NativeTodoUiChat, type NativeTodoUserAuthority } from "./native-todo-user-ui.js";
import { legacyTodoBoardCreateSlug } from "./legacy-todo-board-create-contracts.js";
import { legacyImportPlanSchema } from "./domain/legacy-import.js";
import {
  acquireLinuxRootWriterFence, assertLinuxRootOwnerMarker, isTrustedLinuxRootWriterFence, markLinuxRootNextOwned,
  type LinuxRootWriterFence,
} from "./linux-root-writer-fence.js";
import { assertLinuxLegacyWritersQuiescent } from "./linux-legacy-writer-quiescence.js";
import { readMembershipIntent } from "./legacy-subscription-membership-intent.js";
import { consumeMembershipRecoveryAuthority, type MembershipRecoveryPhase } from "./legacy-subscription-membership-authority.js";
import { nativeBoardLifecycleCatalog, nativeBoardLifecycleInput, NATIVE_BOARD_LIFECYCLE_OPERATION,
  type NativeBoardLifecycleInput } from "./native-board-lifecycle-state.js";

const marker = ".pkm-next-workspace";
const rootAdoptionJournal = ".pkm-next-root-adoption.json";
const rootAdoptionCommit = ".pkm-next-root-adoption.commit.json";
const jsonSha256 = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const privateRoomRecovery = Symbol("private-room-recovery");
type PrivateRoomRecovery = { root: string; archives: { roomId: string; sourceFingerprint: string }[] };
export async function initialize(directory: string) {
  const root = resolve(directory);
  await mkdir(root, { mode: 0o700 });
  await writeFile(join(root, marker), JSON.stringify({ schema: "pkm.next-workspace/v2", id: randomUUID() }), { flag: "wx", mode: 0o600 });
  await mkdir(join(root, "notes"), { mode: 0o700 });
  return root;
}
export async function validateWorkspace(directory: string, options: {
  adoptionToken?: string; [privateRoomRecovery]?: PrivateRoomRecovery;
} = {}) {
  const root = resolve(directory);
  if ((await lstat(root)).isSymbolicLink()) throw new CoreError("INVALID_WORKSPACE", "Workspace symlinks are not supported.");
  const entries = await readdir(root);
  const directories = new Set<string>([...knowledgeArea.options, "prompts", "scripts", "actions", "components",
    "packages", "boards", "project", "recipes", "subscriptions", "agent-snapshot-reads", "recipe-usage-reads",
    "knowledge-read-config", "legacy-import-evidence", "legacy-code-archive", ".pkm", ".pkm-action-authority", ".pkm-plugin-authority", ".pkm-room-admission",
    ".pkm-action-sources", ".pkm-action-builds", ".git", "chatrooms", "mcp-server", "servers"]);
  const inertRootFiles = new Set([".gitignore", "fixture-sentinel.txt"]);
  for (const name of ["_feedback", "_proposals"]) {
    if (!entries.includes(name)) continue;
    const rootStat = await lstat(join(root, name));
    if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) throw new CoreError("INVALID_WORKSPACE", "Skill maintenance root must be a real directory.");
    const children = await readdir(join(root, name));
    if (name === "_feedback" && children.some(child => child !== "skill-usage.jsonl" && !/^\.pkm-write-[a-fA-F0-9-]{36}$/.test(child))
      || name === "_proposals" && children.some(child => child !== "skills")) {
      throw new CoreError("INVALID_WORKSPACE", "Unknown Skill maintenance artifact state.");
    }
    if (name === "_proposals" && children.includes("skills")) {
      const stat = await lstat(join(root, name, "skills"));
      if (!stat.isDirectory() || stat.isSymbolicLink()) throw new CoreError("INVALID_WORKSPACE", "Skill proposal area must be a real directory.");
    }
    directories.add(name);
  }
  let inertInventory: ReturnType<typeof inspectLegacyRootInertInventory>;
  try { inertInventory = inspectLegacyRootInertInventory(root); }
  catch { throw new CoreError("INVALID_WORKSPACE", "Legacy inert root metadata changed or is unsafe."); }
  for (const name of inertInventory.paths) {
    if (!name.includes("/") && name.endsWith(".postcommit")) directories.add(name);
  }
  const allowed = new Set([marker, rootAdoptionJournal, rootAdoptionCommit, ...(process.platform === "linux" ? [".pkm-next-writer-fenced.json"] : []),
    ".legacy-trash-import.json", ...directories, ...inertRootFiles, "core.sqlite", "core.sqlite-wal", "core.sqlite-shm",
    ".pkm-paired-memory-backup.json", ".pkm-native-memory-adoption.json", ".pkm-native-memory-publication.json",
    "coding-process.sqlite", "coding-process.sqlite-wal", "coding-process.sqlite-shm"]);
  if (entries.some(name => !allowed.has(name))) throw new CoreError("INVALID_WORKSPACE", "Not an isolated next-server workspace. Legacy data directories must not be used.");
  if (entries.includes(".pkm-next-writer-fenced.json")) await assertLinuxRootOwnerMarker(root);
  if (entries.includes(".pkm-room-admission") && !options[privateRoomRecovery])
    throw new CoreError("RECOVERY_REQUIRED", "Private Room/Note admission requires explicit independent profile-pin recovery before workers start.");
  if (entries.includes(".pkm-room-admission")) {
    const stat = await lstat(join(root, ".pkm-room-admission"));
    if (!stat.isDirectory() || stat.isSymbolicLink() || stat.uid !== process.getuid?.() || (stat.mode & 0o077) !== 0)
      throw new CoreError("INVALID_WORKSPACE", "Private Room/Note admission directory is unsafe.");
  }
  if (options[privateRoomRecovery] || inertInventory.chatroomArchives?.length && !entries.includes(rootAdoptionJournal)) {
    const admission = options[privateRoomRecovery], archives = inertInventory.chatroomArchives ?? [];
    if (!admission || admission.root !== root || archives.length !== admission.archives.length
      || archives.some(archive => !admission.archives.some(pin =>
        pin.roomId === archive.roomId && pin.sourceFingerprint === archive.sourceFingerprint)))
      throw new CoreError("INVALID_WORKSPACE", "Non-empty legacy Chatroom archives require an exact in-place adoption journal.");
  }
  for (const name of entries) {
    const stat = await lstat(join(root, name));
    if (stat.isSymbolicLink() || !(directories.has(name) ? stat.isDirectory() : stat.isFile())) throw new CoreError("INVALID_WORKSPACE", "Workspace entries must be regular files or knowledge/boards directories.");
  }
  for (const name of [".pkm-action-sources", ".pkm-action-builds"]) {
    if (!entries.includes(name)) continue;
    const stat = await lstat(join(root, name));
    if (process.platform !== "win32" && ((stat.mode & 0o077) !== 0 || process.getuid && stat.uid !== process.getuid()))
      throw new CoreError("INVALID_WORKSPACE", "Action build directories must be private and owned.");
  }
  for (const authorityDirectory of [".pkm-action-authority", ".pkm-plugin-authority"]) {
    if (!entries.includes(authorityDirectory)) continue;
    const directory = join(root, authorityDirectory), stat = await lstat(directory);
    const files = await readdir(directory);
    if (process.platform !== "win32" && ((stat.mode & 0o077) !== 0 || process.getuid && stat.uid !== process.getuid())
      || files.some(name => name !== "host-authority.json"))
      throw new CoreError("INVALID_WORKSPACE", "Native authority directory is unsafe.");
    if (files.length) {
      const file = await lstat(join(directory, files[0]));
      if (!file.isFile() || file.isSymbolicLink() || file.nlink !== 1 || file.size > 8192
        || process.platform !== "win32" && ((file.mode & 0o077) !== 0 || process.getuid && file.uid !== process.getuid()))
        throw new CoreError("INVALID_WORKSPACE", "Native authority record is unsafe.");
    }
  }
  if (entries.includes(".pkm")) {
    if (entries.includes(rootAdoptionJournal) && !entries.includes(rootAdoptionCommit) && options.adoptionToken === undefined) {
      throw new CoreError("RECOVERY_REQUIRED", "An interrupted in-place root adoption must be resumed before workers can start.");
    }
    if (options.adoptionToken === undefined || !entries.includes(rootAdoptionJournal) || entries.includes(rootAdoptionCommit)) {
      let database: DatabaseSync | undefined;
      try {
        const databasePath = join(root, "core.sqlite");
        const stat = await lstat(databasePath);
        if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1) throw new Error("Unowned native database.");
        database = new DatabaseSync(databasePath, { readOnly: true });
        assertLegacyKnowledgeSnapshotPrivacyRoot(database, root);
      } catch {
        throw new CoreError("INVALID_WORKSPACE", "Legacy data directories must not be used without explicit native private snapshot authority.");
      } finally { database?.close(); }
    }
  }
  if (entries.includes(".pkm-native-memory-adoption.json") || entries.includes(".pkm-paired-memory-backup.json")) {
    if (!entries.includes(".pkm-native-memory-publication.json"))
      throw new CoreError("RECOVERY_REQUIRED", "Paired native memory publication requires explicit durable reconciliation.");
    const publication = JSON.parse(await readFile(join(root, ".pkm-native-memory-publication.json"), "utf8"));
    if (publication.state !== "committed")
      throw new CoreError("RECOVERY_REQUIRED", "Unknown paired native memory publication must not start workers or replay effects.");
  }
  if (!entries.includes(marker)) {
    throw new CoreError("INVALID_WORKSPACE", "This is not an initialized next-server workspace. Legacy roots require separate read-only adoption inspection.");
  }
  const identity: unknown = JSON.parse(await readFile(join(root, marker), "utf8"));
  if (!identity || typeof identity !== "object" || !("schema" in identity) || identity.schema !== "pkm.next-workspace/v2") throw new CoreError("INVALID_WORKSPACE", "Initialize a new Markdown-authoritative v2 workspace. Database-only prototype v1 workspaces are not automatically adopted.");
  if (!("id" in identity) || typeof identity.id !== "string" || !/^[0-9a-f-]{36}$/i.test(identity.id))
    throw new CoreError("INVALID_WORKSPACE", "Workspace identity is invalid.");
  if (!entries.includes("notes")) throw new CoreError("INVALID_WORKSPACE", "Workspace notes directory is missing.");
  const canonicalRoot = await realpath(root);
  if (entries.includes(rootAdoptionCommit) && !entries.includes(rootAdoptionJournal))
    throw new CoreError("RECOVERY_REQUIRED", "Root adoption commit has no matching durable plan.");
  if (entries.includes(rootAdoptionJournal)) {
    try {
      const journalStat = await lstat(join(root, rootAdoptionJournal));
      if (!journalStat.isFile() || journalStat.isSymbolicLink() || journalStat.nlink !== 1 || journalStat.size > 16_777_216)
        throw new Error("Unsafe adoption journal.");
      const journal: unknown = JSON.parse(await readFile(join(root, rootAdoptionJournal), "utf8"));
      if (!journal || typeof journal !== "object") throw new Error("Malformed adoption journal.");
      const value = journal as Record<string, unknown>;
      const { journalSha256, ...body } = value;
      if (value.schema !== "pkm.legacy-root-adoption-journal/v1" || value.state !== "prepared"
        || value.sourceRoot !== canonicalRoot || value.workspaceId !== identity.id
        || typeof value.token !== "string" || !/^[0-9a-f-]{36}$/i.test(value.token)
        || typeof value.sourceFingerprint !== "string" || !/^[a-f0-9]{64}$/.test(value.sourceFingerprint)
        || typeof journalSha256 !== "string" || !/^[a-f0-9]{64}$/.test(journalSha256)
        || jsonSha256(body) !== journalSha256
        || !value.rootIdentity || typeof value.rootIdentity !== "object"
        || !value.inventoryPlan || typeof value.inventoryPlan !== "object"
        || !Array.isArray(value.sourceEntries)) throw new Error("Invalid adoption journal binding.");
      const rootIdentity = value.rootIdentity as Record<string, unknown>;
      if (typeof rootIdentity.device !== "string" || typeof rootIdentity.inode !== "string"
        || !/^\d+$/.test(rootIdentity.device) || !/^\d+$/.test(rootIdentity.inode)) throw new Error("Invalid root identity.");
      const plan = legacyImportPlanSchema.parse(value.inventoryPlan);
      if (plan.schema !== "pkm.legacy-import-plan/v1" || plan.ready !== true || plan.planSha256 !== value.planSha256)
        throw new Error("Invalid bound inventory plan.");
      const canonicalArchives = (archives: NonNullable<typeof inertInventory.chatroomArchives>) => JSON.stringify(
        archives.map(archive => ({
          roomId: archive.roomId,
          sourceFingerprint: archive.sourceFingerprint,
          files: [...archive.files].sort((left, right) => left.path.localeCompare(right.path)).map(file => ({
            path: file.path, sha256: file.sha256, size: file.size, mode: file.mode,
            dev: file.dev, ino: file.ino, mtimeMs: file.mtimeMs,
          })),
        })).sort((left, right) => left.roomId.localeCompare(right.roomId)),
      );
      if (canonicalArchives(inertInventory.chatroomArchives ?? []) !== canonicalArchives(plan.inPlaceChatroomArchives ?? []))
        throw new Error("Chatroom archive identity differs from its adoption inventory binding.");
      if (!entries.includes(rootAdoptionCommit) && entries.includes(".pkm")
        && (plan.inPlaceOnly !== true || typeof plan.inPlacePkmPrivacySha256 !== "string"
          || !/^[a-f0-9]{64}$/.test(plan.inPlacePkmPrivacySha256)
          || !value.snapshotAdmission || typeof value.snapshotAdmission !== "object"))
        throw new Error("Pending .pkm adoption has no exact privacy or host-authority binding.");
      if (value.planSha256 === undefined || typeof value.planSha256 !== "string" || !/^[a-f0-9]{64}$/.test(value.planSha256))
        throw new Error("Invalid import plan digest.");
      const rootStat = await lstat(root, { bigint: true });
      if (rootStat.dev.toString() !== rootIdentity.device || rootStat.ino.toString() !== rootIdentity.inode)
        throw new Error("Root identity changed.");
      if (entries.includes(rootAdoptionCommit)) {
        const commitStat = await lstat(join(root, rootAdoptionCommit));
        if (!commitStat.isFile() || commitStat.isSymbolicLink() || commitStat.nlink !== 1 || commitStat.size > 4096)
          throw new Error("Unsafe adoption commit.");
        const commit: unknown = JSON.parse(await readFile(join(root, rootAdoptionCommit), "utf8"));
        if (!commit || typeof commit !== "object") throw new Error("Malformed adoption commit.");
        const record = commit as Record<string, unknown>;
        const { receiptSha256, ...receiptBody } = record;
        if (record.schema !== "pkm.legacy-root-adoption-commit/v1" || record.token !== value.token
          || record.sourceRoot !== value.sourceRoot || record.workspaceId !== value.workspaceId
          || record.sourceFingerprint !== value.sourceFingerprint || record.journalSha256 !== journalSha256
          || typeof receiptSha256 !== "string" || !/^[a-f0-9]{64}$/.test(receiptSha256)
          || jsonSha256(receiptBody) !== receiptSha256) throw new Error("Adoption commit does not match its journal.");
      } else if (options.adoptionToken !== value.token) {
        throw new CoreError("RECOVERY_REQUIRED", "An interrupted in-place root adoption must be resumed before workers can start.");
      }
      if (plan.inPlaceUiBootstrap) {
        const actual = inspectLegacyUiBootstrapCompatibility(canonicalRoot);
        if (!actual || !isDeepStrictEqual(actual, plan.inPlaceUiBootstrap))
          throw new Error("UI bootstrap compatibility differs from its prepared source.");
        if (entries.includes("core.sqlite")) {
          const database = new DatabaseSync(join(root, "core.sqlite"), { readOnly: true });
          try { verifyLegacyUiBootstrapCompatibility(database, String(value.workspaceId), plan.inPlaceUiBootstrap, !entries.includes(rootAdoptionCommit)); }
          finally { database.close(); }
        } else if (entries.includes(rootAdoptionCommit)) throw new Error("Committed UI compatibility has no native receipt database.");
      }
      const oldLayoutBoards = plan.entries.filter(entry => entry.kind === "board-backing" && entry.destination !== entry.source);
      if (oldLayoutBoards.length && value.todoProjection === undefined)
        throw new Error("Old-layout Todo authority has no bound native publication.");
      if (value.todoProjection !== undefined) {
        const projection = validateLegacyTodoRootProjection(value.todoProjection);
        if (projection.boards.length !== oldLayoutBoards.length) throw new Error("Incomplete old-layout Todo publication coverage.");
        if (projection.boards.some(board => !plan.entries.some(entry => entry.kind === "board-backing"
          && entry.source === board.source && entry.destination === board.destination && entry.sha256 === board.sha256
          && entry.boardSlug === board.slug && entry.size === board.size)
          || !plan.entries.some(entry => entry.source === board.markdown && entry.sha256 === board.markdownSha256)))
          throw new Error("Todo projection differs from its source inventory.");
        verifyLegacyTodoProjectionSource(canonicalRoot, projection, false);
        if (entries.includes(rootAdoptionCommit)) {
          const database = new DatabaseSync(join(root, "core.sqlite"), { readOnly: true });
          try { verifyLegacyTodoProjectionReceipt(database, canonicalRoot, String(value.workspaceId), projection); }
          finally { database.close(); }
        }
      }
    } catch (error) {
      if (error instanceof CoreError) throw error;
      throw new CoreError("RECOVERY_REQUIRED", "Root adoption journal is invalid or requires exact recovery.");
    }
  } else if (options.adoptionToken !== undefined) {
    throw new CoreError("RECOVERY_REQUIRED", "Adoption recovery token has no matching journal.");
  }
  return canonicalRoot;
}

type Pending = { resolve: (value: unknown) => void; reject: (error: Error) => void };
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
  private snapshotScheduler?: NativeSnapshotSchedulerResource;
  private exited = false;
  private recovered = false;
  private memoryScopeActive = false;
  private recovery: Promise<void> | undefined;
  private worker: Worker;
  private lease?: { ownerId: string; fence: number };
  private leaseDatabase?: DatabaseSync;
  private leaseTimer?: ReturnType<typeof setInterval>;
  private leaseLost = false;
  private leaseLostHandler?: (error: CoreError) => void;
  private exclusiveTail: Promise<void> = Promise.resolve();
  private exclusiveQueued = 0;
  private exclusiveActive = false;
  private readonly retainedResources: Array<{ release(): Promise<void> | void }> = [];
  private constructor(
    private readonly root: string,
    private readonly rootAdoptionPrivacySha256: string | undefined,
    private readonly writerFence: LinuxRootWriterFence,
  ) {
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
    const writerFence = options.writerFence === undefined
      ? await acquireLinuxRootWriterFence(directory)
      : options.writerFence;
    let store: Storage | undefined;
    try {
      writerFence.assertHeld();
      if (process.platform === "linux" && existsSync(join(resolve(directory), rootAdoptionJournal)))
        await assertLinuxLegacyWritersQuiescent(resolve(directory));
      const root = await validateWorkspace(directory, { adoptionToken: options.adoptionToken,
        [privateRoomRecovery]: options[privateRoomRecovery] });
      if (!isTrustedLinuxRootWriterFence(writerFence, root))
        throw new CoreError("STORAGE_UNAVAILABLE", "Storage requires the real exclusive Linux writer-fence resource.");
      if (process.platform === "linux" && existsSync(join(root, rootAdoptionJournal)))
        await assertLinuxLegacyWritersQuiescent(root);
      await markLinuxRootNextOwned(root, writerFence);
      let adoptionPrivacySha256: string | undefined;
      if (options.adoptionToken !== undefined) {
        const journal = JSON.parse(await readFile(join(root, rootAdoptionJournal), "utf8")) as Record<string, unknown>;
        const plan = journal.inventoryPlan as Record<string, unknown> | undefined;
        if (journal.token === options.adoptionToken && typeof plan?.inPlacePkmPrivacySha256 === "string")
          adoptionPrivacySha256 = plan.inPlacePkmPrivacySha256;
      }
      const activeStore = new Storage(root, adoptionPrivacySha256, writerFence);
      store = activeStore;
      await new Promise<void>((resolve, reject) => {
        activeStore.worker.once("error", reject);
        activeStore.worker.once("exit", code => reject(new CoreError("STORAGE_UNAVAILABLE", `Storage exited before ready (${code}).`)));
        activeStore.worker.on("message", message => {
          if (message.ready) { resolve(); return; }
          const pending = activeStore.pending.get(message.id);
          if (!pending) return;
          activeStore.pending.delete(message.id);
          if (message.error) pending.reject(new CoreError(message.error.code, message.error.message, message.error.effect));
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
      if (process.platform === "linux" && existsSync(join(root, rootAdoptionJournal)))
        await assertLinuxLegacyWritersQuiescent(root);
      activeStore.acquireWorkspaceLease();
      if (!options.deferRecovery && !activeStore.hasPendingLegacyNoteWorkItemsIntent() && !activeStore.hasPendingSharedSourceIntent()) await activeStore.recover();
      return activeStore;
    } catch (error) {
      if (store) {
        try { await store.worker.terminate(); }
        catch {
          throw new CoreError("STORAGE_UNAVAILABLE",
            "Storage startup failed and worker termination could not be verified; the writer fence remains held.", "unknown");
        }
        store.releaseWorkspaceLease();
      }
      await writerFence.release();
      throw error;
    }
  }
  workspaceRoot(): string { return this.root; }
  rootAdoptionBootstrapPrivacySha256(): string | undefined { return this.rootAdoptionPrivacySha256; }
  retainResource(resource: { release(): Promise<void> | void }): void {
    if (this.closed) throw new CoreError("STORAGE_UNAVAILABLE", "Cannot retain a resource on closed storage.");
    this.retainedResources.push(resource);
  }
  workspaceLease(): Readonly<{ ownerId: string; fence: number }> {
    this.assertWorkspaceLease();
    return this.lease!;
  }
  onLeaseLost(handler: (error: CoreError) => void): void { this.leaseLostHandler = handler; }
  assertNoPendingLegacyNoteWorkItems(): void {
    if (this.hasPendingLegacyNoteWorkItemsIntent()) {
      throw new CoreError("BUSY", "A legacy Note operation requires exact native recovery before workspace admission.", "unknown");
    }
  }
  assertWorkspaceLease(): void {
    if (this.closed || this.leaseLost || !this.lease) throw new CoreError("STORAGE_UNAVAILABLE", "Workspace ownership lease is unavailable.", "unknown");
    this.writerFence.assertHeld();
    const database = new DatabaseSync(join(this.root, "core.sqlite"));
    try {
      const owner = database.prepare("SELECT owner_id,fence,lease_until FROM native_runtime_owner WHERE singleton=1").get();
      if (owner?.owner_id !== this.lease.ownerId || owner?.fence !== this.lease.fence || Number(owner.lease_until) <= Date.now()) {
        this.loseWorkspaceLease();
        throw new CoreError("STORAGE_UNAVAILABLE", "Workspace ownership lease was lost.", "unknown");
      }
    } finally { database.close(); }
  }
  async workspaceId(): Promise<string> {
    if (this.closed) throw new CoreError("STORAGE_UNAVAILABLE", "Storage is closed.");
    const identity: unknown = JSON.parse(await readFile(join(this.root, marker), "utf8"));
    if (!identity || typeof identity !== "object" || !("id" in identity)
      || typeof identity.id !== "string" || !/^[0-9a-f-]{36}$/i.test(identity.id)) {
      throw new CoreError("INVALID_WORKSPACE", "Workspace identity is invalid.");
    }
    return identity.id;
  }
  connectNative(): DatabaseSync {
    if (this.closed) throw new CoreError("STORAGE_UNAVAILABLE", "Storage is closed.");
    const database = new DatabaseSync(join(this.root, "core.sqlite"));
    try {
      database.exec("PRAGMA busy_timeout=3000; PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA foreign_keys=ON;");
      return database;
    } catch (error) {
      database.close();
      throw error;
    }
  }
  connectCodingProcess(): DatabaseSync {
    this.assertWorkspaceLease();
    const database = new DatabaseSync(join(this.root, "coding-process.sqlite"));
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
    const path = join(this.root, "coding-process.sqlite");
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
  request(request: StorageRequest): Promise<unknown> {
    if (request.actorId === "user:local" && request.operation === "todo.board.create")
      return Promise.reject(new CoreError("ACCESS_DENIED", "User Board creation requires the trusted fixture channel."));
    if (this.closed || this.closing) return Promise.reject(new CoreError("STORAGE_UNAVAILABLE", "Storage is closed."));
    if (!this.recovered) return Promise.reject(new CoreError("STORAGE_UNAVAILABLE", "Workspace recovery must complete before requests are accepted."));
    try { this.assertNoPendingLegacyNoteWorkItems(); }
    catch (error) { return Promise.reject(error); }
    try {
      if (this.hasPendingSharedSourceIntent()) throw new CoreError("RECOVERY_REQUIRED", "Shared-source journal requires explicit native reconciliation.", "unknown");
    } catch (error) { return Promise.reject(error); }
    if (this.exclusiveActive || this.exclusiveQueued) return Promise.reject(new CoreError("BUSY", "A native workspace journal is being applied; request was not dispatched."));
    return this.postRequest(request);
  }
  async adoptMemoryScopeContinuity(request: MemoryScopeContinuityRequest,
    approval: { decisionId: string; actorId: string; expiresAtMs: number }): Promise<void> {
    if (request.workspaceId !== await this.workspaceId())
      throw new CoreError("NOT_AVAILABLE", "Memory admission belongs to another workspace.");
    await this.postMemoryScope({ request, approval });
    try {
      this.assertWorkspaceLease();
      activateReadoptedMemoryScope(this.root, request, approval);
      this.memoryScopeActive = true;
    } catch (error) {
      await this.revokeMemoryScopeContinuity();
      throw error;
    }
  }
  async revokeMemoryScopeContinuity(): Promise<void> {
    deactivateMemoryScopeContinuity(this.root);
    this.memoryScopeActive = false;
    await this.postMemoryScope({ revoke: true });
  }
  private postMemoryScope(memoryScope: { request: MemoryScopeContinuityRequest;
    approval: { decisionId: string; actorId: string; expiresAtMs: number } } | { revoke: true }): Promise<void> {
    if (this.closed || this.closing) return Promise.reject(new CoreError("STORAGE_UNAVAILABLE", "Storage is closed."));
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
    if (!this.recovered || this.closing) throw new CoreError("BUSY", "Board file lifecycle requires a recovered native workspace.");
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
    if (this.closed || this.closing || !this.recovered || this.exclusiveActive || this.exclusiveQueued)
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
    nativeTodoUser?: { input: NativeTodoUserInput; chats: NativeTodoUiChat[] }, nativeBoardLifecycle?: NativeBoardLifecycleInput): Promise<unknown> {
    if (this.pending.size >= 32) return Promise.reject(new CoreError("BUSY", "Storage queue is full; request was not dispatched."));
    return new Promise((resolve, reject) => {
      const id = ++this.sequence;
      this.pending.set(id, { resolve, reject });
      try {
        this.assertWorkspaceLease();
        this.worker.postMessage({ id, request, runtimeOwner: this.lease, ...(legacyNoteOperationId ? { legacyNoteOperationId } : {}),
          ...(originalNoteCreate ? { originalNoteCreate } : {}), ...(nativeTodoUser ? { nativeTodoUser } : {}),
          ...(nativeBoardLifecycle ? { nativeBoardLifecycle } : {}) });
      }
      catch (error) {
        this.pending.delete(id);
        console.error("PKM next storage dispatch:", error);
        reject(new CoreError("STORAGE_UNAVAILABLE", "Could not dispatch the request to storage."));
      }

    });
  }
  private hasPendingLegacyNoteWorkItemsIntent(): boolean {
    if (!this.lease) return false;
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
    return !!inspectLegacyInlineNoteFence(database) || !!inspectPausedSnapshotJournal(database) || !!inspectBatch15SkillPending(database);
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
    if (this.closed || this.closing || this.snapshotScheduler)
      throw new CoreError("BUSY", "A native snapshot scheduler is already owned or Storage is closing.");
    this.snapshotScheduler = resource;
    return () => { if (this.snapshotScheduler === resource) this.snapshotScheduler = undefined; };
  }
  async acquireNativeSnapshotSchedulerQuiescence() {
    return this.snapshotScheduler?.pauseForBackup();
  }
  close(): Promise<void> {
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
      this.releaseWorkspaceLease();
      await this.writerFence.release();
    })();
    this.closing = closing.catch(error => {
      this.closing = undefined;
      throw error;
    });
    return this.closing;
  }
  private acquireWorkspaceLease(): void {
    this.writerFence.assertHeld();
    if (!isTrustedLinuxRootWriterFence(this.writerFence, this.root))
      throw new CoreError("STORAGE_UNAVAILABLE", "Workspace ownership requires the real exclusive Linux writer fence.");
    const database = this.connectNative();
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
      database.exec("COMMIT");
      this.lease = { ownerId, fence };
      this.leaseTimer = setInterval(() => {
        try {
          const current = Date.now();
          database.exec("BEGIN IMMEDIATE");
          const updated = database.prepare(`UPDATE native_runtime_owner SET lease_until=?
            WHERE singleton=1 AND owner_id=? AND fence=? AND lease_until>?`)
            .run(current + duration, ownerId, fence, current);
          if (updated.changes !== 1) throw new CoreError("STORAGE_UNAVAILABLE", "Workspace ownership lease expired or changed.", "unknown");
          database.exec("COMMIT");
        } catch (error) {
          if (database.isTransaction) database.exec("ROLLBACK");
          this.loseWorkspaceLease(error);
        }
      }, Math.floor(duration / 3));
      this.leaseTimer.unref();
      this.leaseDatabase = database;
    } catch (error) {
      if (database.isTransaction) database.exec("ROLLBACK");
      throw error;
    } finally { if (!this.lease) database.close(); }
  }
  private loseWorkspaceLease(error?: unknown): void {
    if (this.leaseLost) return;
    this.leaseLost = true;
    if (this.leaseTimer) clearInterval(this.leaseTimer);
    this.leaseTimer = undefined;
    this.leaseLostHandler?.(error instanceof CoreError ? error
      : new CoreError("STORAGE_UNAVAILABLE", "Workspace ownership lease was lost.", "unknown"));
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
    } finally { database.close(); this.leaseDatabase = undefined; this.lease = undefined; }
  }
}
