import { createHash, randomUUID } from "node:crypto";
import { existsSync, lstatSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { CoreError, type Actor } from "./contracts.js";
import type { StorageRequest } from "./contracts.js";
import { Core, type NativeRuntimeDispatcher } from "./core.js";
import { Storage } from "./storage.js";
import { attachNativeSubscriptionHostIpc } from "./native-subscription-host-ipc.js";
import { createNativeSubscriptionProfileService, readNativeSubscriptionProfile } from "./native-subscription-profile.js";
import { readSubscriptions } from "./subscription-reads.js";
import { readMembershipIntent } from "./legacy-subscription-membership-intent.js";
import { ModelConfigService } from "./model-config.js";
import { ModelProviderService, type ModelProviderTransport } from "./model-provider.js";
import { ChatTurnService } from "./chat-turn.js";
import { ChatTurnStore, ChatTurnError } from "./chat-turn-store.js";
import { createChatTurnModelPort, createChatTurnToolPort } from "./chat-turn-adapters.js";
import type { ApprovalBridgeReviewer } from "./approval-bridge-contracts.js";
import { CHAT_TOOL_GATEWAY_OUTPUT_BYTES, type ToolApprovalBinding, type ToolGatewayBinding } from "./tool-gateway-contracts.js";
import { ToolGateway } from "./tool-gateway.js";
import { DataRuntime, type DataRuntimeHost } from "./data-runtime.js";
import { dataRuntimeDefinitions } from "./data-runtime-contracts.js";
import { folderLifecycleDefinitions } from "./folder-lifecycle-contracts.js";
import { scanMarkdown } from "./markdown.js";
import { WorkflowExecutor, type WorkflowStepAdapter, mutateWorkflowExecutor, readWorkflowExecutor } from "./workflow-executor.js";
import { workflowExecutorDefinitions } from "./workflow-executor-contracts.js";
import {
  createAgentRuntime, type AgentRuntimeHost, type AgentRuntimeOwnerToken,
} from "./agent-runtime.js";
import type { AgentRuntimeTask } from "./agent-runtime-contracts.js";
import type { AgentRuntimePinnedSnapshot, AgentRuntimeOwner } from "./agent-runtime-store.js";
import { AgentRuntimeError } from "./domain/agent-runtime-policy.js";
import { MemoryContextService, type MemoryContextDependencies } from "./memory-context.js";
import { createManagerRuntime, ManagerRuntimeError, type ManagerRuntimeHost, type ManagerOwner } from "./manager-runtime.js";
import { ManagerProgressService, ManagerProgressError } from "./manager-progress.js";
import { MigrationRuntime, migrationRuntimeDefinitions, assertNativeTrashRow, nativeTrashSupersedesImportedPlan, nativeKnowledgeSupersedesImportedPlan } from "./migration-runtime.js";
import { createProcessBridge, type ProcessBridgeOptions } from "./process-bridge.js";
import { buildHostConfigOptions, type HostConfigDependencies } from "./host-config.js";
import { createManagerChatExactComposition } from "./manager-chat.js";
import { managerChatWithin } from "./domain/manager-chat-contracts.js";
import { managerPlanDefinitionHash } from "./manager-plan.js";
import { managerTextConfigSchema, type ManagerTextConfig } from "./host-composition-manager.js";
import { createHostServices, type HostServicesOptions } from "./host-services.js";
import { createCodingWorkerWorkspace, createCodingWorkerManagerHost, recoverCodingWorkerEffects,
  type CodingWorkerWorkspaceOptions, type CodingWorkerManagerOptions } from "./coding-worker.js";
import { createChannelRuntime, ChannelRuntimeError, type ChannelActor, type ChannelRuntimeHost } from "./channel-runtime.js";
import { createRemoteRuntime, remoteRuntimePending, type RemoteRuntimeOptions } from "./remote-runtime.js";
import { createRemoteSubscriptionRuntime, inspectRemoteSubscriptionRecovery, type RemoteSubscriptionOptions } from "./remote-runtime-subscription.js";
import { createNativeSubscriptionBundle, inspectNativeSubscriptionBundles, type NativeSubscriptionBundleAuthority } from "./host-composition-subscription-bundle.js";
import { inspectLegacyControlRecovery } from "./legacy-control-import.js";
import { dispatchLegacySnapshot, dispatchNativeSubscriptionRead, readLegacyStateReceipt, verifyNativeSubscriptionIdentity, type NativeLegacySnapshotPolicy } from "./host-composition-legacy-state.js";
import type { NativeSubscriptionIdentityPolicy } from "./legacy-subscription-identity.js";
import { createPortalLifecycleHost, createPortalLifecycleRuntime, PortalLifecycleError } from "./portal-lifecycle.js";
import { assertPortalRecoveryClear, type NativePortalPolicy } from "./host-composition-portal.js";
import { dispatchNativeLegacyCommand, type NativeLegacyCommandPolicy } from "./host-composition-legacy-commands.js";
import { readLegacyExtensionPendingEnvelope } from "./legacy-command-extension-recovery.js";
import {
  adoptLegacyTrashImport, inspectLegacyTrashNative, readLegacyTrashAdoptionReceipt, readLegacyTrashHistory, readLegacyTrashPurgedIds,
} from "./legacy-trash-import-native.js";
import { legacyTrashPurgeDefinitions } from "./domain/legacy-trash-import-contracts.js";
import {
  legacyTrashDocuments, legacyTrashStageReceiptPath, LegacyTrashImportError, snapshotLegacyTrashTree,
} from "./legacy-trash-import.js";
import { deserializeTrashLifecyclePlan } from "./trash-lifecycle.js";
import {
  createNativeLegacyTrashAccess, type NativeLegacyTrashPolicy,
} from "./host-composition-legacy-trash.js";
import type { MarkdownRecord } from "./markdown.js";
import {
  createNativeRecipeTrashHost, dispatchNativeRecipeTrash, recoverNativeRecipeTrash, type NativeRecipeTrashPolicy,
} from "./host-composition-legacy-recipe-trash.js";
import {
  createNativeLegacyNoteWorkItemsComposition, inspectLegacyNoteWorkItemsState,
  verifyLegacyNoteWorkItemsWorkspace,
  type NativeLegacyNoteWorkItemsPolicy,
} from "./host-composition-legacy-note-workitems.js";
import { createLegacyReadSnapshot } from "./legacy-read-race.js";
import { checkedResourcePath } from "./document-path.js";
import { readDocumentAssets } from "./assets.js";
import { todoBoardFilename, readTodoBoard } from "./domain/todo-board.js";
import { createNativePausedSnapshotComposition, inspectPausedSnapshotJournal, snapshotRestoreOperations,
  type NativePausedSnapshotPolicy } from "./host-composition-legacy-snapshot-restore.js";
import { createNativeInlineNoteComposition, verifyInlineNoteWorkspace, type NativeLegacyInlineNotePolicy } from "./host-composition-legacy-inline-note.js";
import { inspectLegacyInlineNoteFence } from "./legacy-inline-note-journal.js";
import { createBatch15SkillComposition, inspectBatch15SkillPending, verifyBatch15SkillWorkspace, captureBatch15SkillHistory, type NativeBatch15SkillPolicy } from "./host-composition-legacy-batch15-skill.js";
import { createNativeLegacySkillSourceComposition, assertSkillSourceIntegrated, type NativeLegacySkillSourcePolicy } from "./host-composition-legacy-skill-source.js";
import { legacySkillSourceOperation, legacySkillSourceRemoveOperation, legacySkillSourceBridgeOperation } from "./host-composition-legacy-skill-source-contracts.js";
import { createBatch15AssetComposition, type NativeBatch15AssetPolicy } from "./host-composition-legacy-batch15-assets.js";
import { assertBatch16UnintegratedClear } from "./host-composition-legacy-batch16-fence.js";
import { createBatch16ClassificationComposition, type NativeBatch16ClassificationPolicy } from "./host-composition-legacy-batch16-classification.js";
import { inspectNativeClassificationPending } from "./legacy-classification-native.js";
import { createBatch16MemoryComposition, inspectBatch16MemoryLedger, type NativeBatch16MemoryPolicy } from "./host-composition-legacy-batch16-memory.js";
import { validateLegacyMemoryErasureLedger } from "./legacy-memory-erasure.js";
import { createLegacyClassificationCommandComposition, type NativeLegacyClassificationCommandPolicy } from "./legacy-classification-command-host.js";
import { LEGACY_CLASSIFICATION_COMMAND_ID } from "./legacy-classification-command-contracts.js";
import type { PluginRuntime } from "./plugin-runtime.js";

type JsonRecord = Record<string, unknown>;
const globalPendingTables = [
  "pending_write", "pending_todo", "pending_asset", "pending_resource",
  "pending_document_lifecycle", "pending_project_mutation", "data_runtime_intents", "migration_runtime_intents",
  "legacy_recipe_trash_intent",
  "legacy_note_workitems_intent",
  "legacy_inline_note_intent",
  "legacy_skill_native_intent",
  "legacy_skill_source_native_intent",
] as const;
const uuid = () => randomUUID();
const digest = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
function currentLegacyTrashEntries(database: DatabaseSync, root: string, workspaceId: string,
  receipt: ReturnType<typeof readLegacyTrashAdoptionReceipt>) {
  const expectedPlans = new Map(receipt.original.entries.map((entry, index) => [entry.runtimeId, receipt.plans[index]!]));
  const activeIds = new Set<string>();
  const rows = database.prepare("SELECT * FROM migration_runtime_trash").all() as Array<Record<string, unknown>>;
  for (const row of rows) {
    const entryId = row.entry_id;
    const planJson = typeof entryId === "string" ? expectedPlans.get(entryId) : undefined;
    if (!planJson) {
      assertNativeTrashRow(database, workspaceId, root, row);
      continue;
    }
    if (!planJson || row.workspace_id !== workspaceId || row.root_path !== root || row.plan_json !== planJson
      || row.digest !== digest([entryId, workspaceId, root, planJson])) {
      throw new CoreError("RECOVERY_CONFLICT", "Native trash rows do not match the immutable imported plan.");
    }
    activeIds.add(entryId as string);
  }
  const restored = database.prepare("SELECT area,original_id FROM legacy_trash_import_restored WHERE workspace_id=?")
    .all(workspaceId) as Array<{ area: string; original_id: string }>;
  const purged = readLegacyTrashPurgedIds({ database }, receipt);
  for (const entry of receipt.original.entries) {
    const hasRestore = restored.some(item => item.area === entry.area && item.original_id === entry.originalId);
    if (Number(activeIds.has(entry.runtimeId)) + Number(hasRestore) + Number(purged.has(entry.runtimeId)) !== 1) {
      throw new CoreError("RECOVERY_CONFLICT", "Every original trash entry requires one exact current native disposition.");
    }
  }
  return receipt.original.entries.filter(entry => activeIds.has(entry.runtimeId));
}

function verifyRestoredLegacyTrashFiles(
  snapshot: Awaited<ReturnType<typeof snapshotLegacyTrashTree>>,
  receipt: ReturnType<typeof readLegacyTrashAdoptionReceipt>,
  currentEntries: ReturnType<typeof currentLegacyTrashEntries>,
  pendingEntryId?: string,
  purgedIds: ReadonlySet<string> = new Set(),
  supersededIds: ReadonlySet<string> = new Set(),
): void {
  const currentIds = new Set(currentEntries.map(entry => entry.runtimeId));
  for (const [index, entry] of receipt.original.entries.entries()) {
    if (currentIds.has(entry.runtimeId) || entry.runtimeId === pendingEntryId || purgedIds.has(entry.runtimeId) || supersededIds.has(entry.runtimeId)) continue;
    const original = deserializeTrashLifecyclePlan(receipt.plans[index]!);
    for (const move of original.moves) {
      const base = `${entry.area}/${move.originalPath}`;
      const expected = move.entries.map(({ dev: _dev, ino: _ino, ...item }) => item)
        .sort((left, right) => left.path.localeCompare(right.path));
      const actual = snapshot.inventory.filter(item => item.path === base || item.path.startsWith(`${base}/`))
        .map(({ dev: _dev, ino: _ino, ...item }) => ({
          ...item, path: item.path === base ? "" : item.path.slice(base.length + 1),
        }))
        .sort((left, right) => left.path.localeCompare(right.path));
      if (JSON.stringify(actual) !== JSON.stringify(expected)) {
        throw new CoreError("RECOVERY_CONFLICT", "A committed original restore no longer matches its pinned active bytes.");
      }
    }
  }
}

function captureLegacyKnowledgeReadSnapshot(storage: Storage, operation: string, args: Readonly<Record<string, unknown>>) {
  const root = storage.workspaceRoot();
  const documents = scanMarkdown(root);
  const pins: Array<{ area: string; path: string; identity: string; revision: string; sha256: string }> = documents.map(({ record }) => ({
    area: record.area, path: record.path, identity: record.id, revision: String(record.revision), sha256: record.sha256,
  }));
  if (operation === "knowledge.note.list" || operation === "knowledge.note.search") {
    for (const document of documents.filter(item => item.record.area === "notes")) {
      const path = `${document.record.path.replace(/\.md$/i, ".assets")}/${todoBoardFilename}`;
      try {
        const full = checkedResourcePath(root, path, false, "notes");
        const stat = lstatSync(full);
        if (!stat.isFile() || stat.isSymbolicLink()) {
          throw new CoreError("INVALID_DOCUMENT", "Note Board backing must be a regular file.");
        }
        const bytes = readFileSync(full);
        const raw = bytes.toString("utf8");
        if (!Buffer.from(raw, "utf8").equals(bytes)) throw new CoreError("INVALID_DOCUMENT", "Note Board backing is not valid UTF-8.");
        const board = readTodoBoard(raw);
        pins.push({ area: "notes", path, identity: document.record.id, revision: String(document.record.revision), sha256: board.digest });
      } catch (error) {
        if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
      }
    }
  }
  if (operation === "knowledge.asset.list" || operation === "knowledge.asset.get") {
    const matches = documents.filter(({ record, metadata }) =>
      record.id === args.id || metadata.get("knowledgeId") === args.id);
    for (const document of matches) {
      let offset = 0, revision: string | undefined;
      while (true) {
        const page = readDocumentAssets(root, document, {
          operation: "knowledge.asset.list",
          args: { id: document.record.id, offset, limit: 100, ...(revision ? { revision } : {}) },
          actorId: "native-read-fence",
        } as StorageRequest) as { revision: string; items: Array<{ path: string; digest: string }>; nextOffset: number | null };
        revision ??= page.revision;
        for (const item of page.items) pins.push({
          area: document.record.area, path: item.path, identity: `${document.record.id}:${item.path}`,
          revision: document.record.sha256, sha256: item.digest.slice("sha256:".length),
        });
        if (page.nextOffset === null) break;
        offset = page.nextOffset;
      }
    }
  }
  return createLegacyReadSnapshot(pins);
}

export interface NativeRuntimeOptions {
  storage: Storage;
  experimentalSubscriptionHost?: { profile: string };
  plugins?: PluginRuntime;
  legacySnapshots?: NativeLegacySnapshotPolicy;
  subscriptionIdentity?: NativeSubscriptionIdentityPolicy;
  pausedSnapshots?: NativePausedSnapshotPolicy;
  legacyInlineNotes?: NativeLegacyInlineNotePolicy;
  batch15Skills?: NativeBatch15SkillPolicy;
  skillSource?: NativeLegacySkillSourcePolicy;
  batch15Assets?: NativeBatch15AssetPolicy;
  batch16Classification?: NativeBatch16ClassificationPolicy;
  originalClassification?: NativeLegacyClassificationCommandPolicy;
  batch16Memory?: NativeBatch16MemoryPolicy;
  legacyNoteWorkItems?: NativeLegacyNoteWorkItemsPolicy;
  portal?: NativePortalPolicy;
  legacyCommands?: NativeLegacyCommandPolicy;
  recipeTrash?: NativeRecipeTrashPolicy;
  workspaceId?: string;
  modelConfig?: ModelConfigService;
  recipeApi?: NonNullable<ConstructorParameters<typeof Core>[1]>["recipeApi"];
  providerTransport?: ModelProviderTransport;
  toolCatalog?: readonly ToolGatewayBinding[];
  reviewer?: ApprovalBridgeReviewer;
  authorizeTool?: (binding: ToolApprovalBinding, signal: AbortSignal) => Promise<boolean>;
  data?: DataRuntimeHost;
  memoryContext?: Omit<MemoryContextDependencies, "retrieve">;
  workflow?: {
    adapters: Readonly<Record<string, WorkflowStepAdapter>>;
    resolveRecipe?: ConstructorParameters<typeof WorkflowExecutor>[1]["resolveRecipe"];
    leaseMs?: number;
    process?: Omit<ProcessBridgeOptions, "database" | "workspaceRoot">;
  };
  hostConfig?: { json: string; dependencies: HostConfigDependencies };
  managerText?: ManagerTextConfig;
  coding?: {
    workspace: Omit<CodingWorkerWorkspaceOptions, "db" | "processDatabase" | "transaction" | "workspaceId" | "assertLease">;
    plan: CodingWorkerManagerOptions["plan"];
    authorizeTask: CodingWorkerManagerOptions["authorizeTask"];
    bounds?: CodingWorkerManagerOptions["bounds"];
  };
  channel?: {
    actorForPublic(actor: Readonly<Actor>): ChannelActor | undefined;
    resolveNativeActor: ChannelRuntimeHost["resolveActor"];
    authorizeHuman: ChannelRuntimeHost["authorizeHuman"];
    authorizeDirected: ChannelRuntimeHost["authorizeDirected"];
    taskAuthority?: ChannelRuntimeHost["taskAuthority"];
    taskAuthorityFactory?(context: Readonly<{
      database: DatabaseSync; workspaceId: string; assertLease(): void;
    }>): NonNullable<ChannelRuntimeHost["taskAuthority"]>;
    notify?: ChannelRuntimeHost["notify"];
  };
  remote?: Pick<RemoteRuntimeOptions, "authorize" | "sync" | "publisherPolicy">;
  subscription?: Pick<RemoteSubscriptionOptions, "endpoint" | "stagingRoot" | "secrets" | "fetch" | "authorityForActor" | "nativePolicy" | "authorize">;
  subscriptionBundle?: NativeSubscriptionBundleAuthority;
  hostServices?: Pick<HostServicesOptions, "action" | "authorizeBackup" | "backupOptions">;
  trash?: { layoutVersion: "pkm.trash-lifecycle/v1"; faultInjector?: (point: string) => void };
  legacyTrash?: NativeLegacyTrashPolicy;
  manager?: {
    ownerForActor(actorId: string): ManagerOwner;
    host: Omit<ManagerRuntimeHost, "resolveOwner">;
    leaseMs?: number;
    resumeInterrupted?: boolean;
  };
  agents?: {
    tasks: readonly AgentRuntimeTask[];
    snapshots?: readonly AgentRuntimePinnedSnapshot[];
    ownerForActor(actorId: string): AgentRuntimeOwner;
    host: Omit<AgentRuntimeHost, "resolveOwner"> & { close?(): Promise<void> };
  };
}
/**
 * Compose real native dependencies around one isolated workspace connection.
 * The default is intentionally useful for data operations only: model, tool,
 * approval, embedding, workflow and Agent capabilities require explicit host injection.
 */
export async function createNativeRuntime(options: NativeRuntimeOptions) {
  if (options.recipeTrash && typeof options.recipeTrash.authorize !== "function") {
    throw new CoreError("INVALID_CONFIGURATION", "Recipe trash requires an explicit native actor policy.");
  }
  if (options.legacyCommands && typeof options.legacyCommands.authorize !== "function") {
    throw new CoreError("INVALID_CONFIGURATION", "Native legacy commands require an explicit actor policy.");
  }
  const snapshotPolicy = options.legacySnapshots;
  if (snapshotPolicy && (!/^[a-f0-9]{64}$/.test(snapshotPolicy.receiptSha256)
    || typeof snapshotPolicy.authorize !== "function" || typeof snapshotPolicy.authority?.epoch !== "function"
    || typeof snapshotPolicy.authority?.key !== "function")) {
    throw new CoreError("INVALID_CONFIGURATION", "Native snapshots require explicit receipt, actor and key authorities.");
  }
  const legacySnapshots = snapshotPolicy ? Object.freeze({
    receiptSha256: snapshotPolicy.receiptSha256,
    authorize: snapshotPolicy.authorize.bind(snapshotPolicy),
    authority: Object.freeze({
      epoch: snapshotPolicy.authority.epoch.bind(snapshotPolicy.authority),
      key: snapshotPolicy.authority.key.bind(snapshotPolicy.authority),
    }),
  }) : undefined;
  if (options.hostConfig) {
    if (options.modelConfig || options.providerTransport || options.toolCatalog || options.reviewer || options.authorizeTool) {
      throw new CoreError("INVALID_CONFIGURATION", "Choose explicit host config or direct native Chat dependencies, not both.");
    }
    options = { ...options, ...buildHostConfigOptions(options.hostConfig.json, options.hostConfig.dependencies) };
  }
  const { storage } = options;
  const database = storage.connectNative();
  try { assertBatch16UnintegratedClear(database, false, undefined, !!options.batch16Classification, !!options.batch16Memory, !!options.originalClassification); }
  catch (error) { database.close(); throw error; }
  try { assertSkillSourceIntegrated(database, !!options.skillSource); }
  catch (error) { database.close(); throw error; }
  const root = storage.workspaceRoot();
  const workspaceId = await storage.workspaceId();
  if (options.workspaceId !== undefined && options.workspaceId !== workspaceId) {
    database.close();
    throw new CoreError("INVALID_CONFIGURATION", "Native runtime workspace identity does not match the initialized workspace.");
  }
  const assertOwner = () => storage.assertWorkspaceLease();
  const commandLease = storage.workspaceLease();
  const assertCommandOwner = () => {
    const current = database.prepare("SELECT owner_id,fence,lease_until FROM native_runtime_owner WHERE singleton=1").get();
    if (!current || current.owner_id !== commandLease.ownerId || current.fence !== commandLease.fence
      || Number(current.lease_until) <= Date.now()) throw new CoreError("STORAGE_UNAVAILABLE", "Native command owner lease is fenced.", "unknown");
  };
  let leaseFailure: CoreError | undefined;
  const transaction = <T>(work: () => T): T => {
    assertOwner();
    if (database.isTransaction) throw new CoreError("TRANSACTION_BOUNDARY", "Native transaction nesting is forbidden.");
    database.exec("BEGIN IMMEDIATE");
    try {
      const result = work();
      if (result && typeof (result as { then?: unknown }).then === "function") {
        throw new CoreError("TRANSACTION_BOUNDARY", "Native SQLite transactions must remain synchronous.");
      }
      assertOwner();
      database.exec("COMMIT");
      return result;
    } catch (error) {
      if (database.isTransaction) database.exec("ROLLBACK");
      throw error;
    }
  };
  const read = <T>(work: (db: DatabaseSync) => T): T => {
    assertOwner();
    if (database.isTransaction) throw new CoreError("TRANSACTION_BOUNDARY", "Native read must start outside a transaction.");
    const result = work(database);
    if (result && typeof (result as { then?: unknown }).then === "function") {
      throw new CoreError("TRANSACTION_BOUNDARY", "Native read callbacks must be synchronous.");
    }
    return result;
  };
  const noteWorkItems = options.legacyNoteWorkItems
    ? createNativeLegacyNoteWorkItemsComposition(storage, database, options.legacyNoteWorkItems, async (operation, args, actor) => {
      return await storage.requestLegacyNoteWorkItems({
        operation: operation as StorageRequest["operation"], args, actorId: actor.id,
      }, String(args.operationId)) as Record<string, unknown>;
    })
    : undefined;
  const noteIntentPending = !!database.prepare("SELECT 1 FROM legacy_note_workitems_intent WHERE singleton=1").get();
  const { batch16Classification, batch16Memory, originalClassification } = (() => {
    try {
      const classification = options.batch16Classification
        ? createBatch16ClassificationComposition(storage, database, workspaceId, options.batch16Classification, assertCommandOwner) : undefined;
      const memory = options.batch16Memory
        ? createBatch16MemoryComposition(storage, workspaceId, options.batch16Memory) : undefined;
      classification?.verify();
      inspectBatch16MemoryLedger(database, workspaceId);
      const originalClassification = options.originalClassification
        ? createLegacyClassificationCommandComposition(storage, database, workspaceId, options.originalClassification, assertCommandOwner) : undefined;
      originalClassification?.verify();
      return { batch16Classification: classification, batch16Memory: memory, originalClassification };
    } catch (error) { database.close(); throw error; }
  })();
  const sharedSourcePending = (() => {
    try { return !!readMembershipIntent(database, workspaceId) || !!inspectLegacyInlineNoteFence(database) || !!inspectPausedSnapshotJournal(database) || !!inspectBatch15SkillPending(database) || !!inspectNativeClassificationPending(database)
      || inspectBatch16MemoryLedger(database, workspaceId).operations.some(item => item.status === "pending"); }
    catch (error) { database.close(); throw error; }
  })();
  const recipeTrashHost = options.recipeTrash
    ? createNativeRecipeTrashHost(database, workspaceId, options.recipeTrash, assertCommandOwner) : undefined;
  try {
    if (!noteIntentPending && !sharedSourcePending) await storage.withWorkspaceExclusive(async () => {
      await noteWorkItems?.admitConfiguredBoards();
      await recoverNativeRecipeTrash(database, root, recipeTrashHost, transaction);
    });
  } catch (error) { database.close(); throw error; }
  let portalChannelEffect = false;
  const assertOperationAvailable = (operationId: string, allowCoding = false) => {
    assertSkillSourceIntegrated(database);
    if (inspectPausedSnapshotJournal(database)) throw new CoreError("RECOVERY_REQUIRED", "Unknown native Snapshot effect requires explicit confirmation.", "unknown");
    if (!portalChannelEffect) assertPortalRecoveryClear(database);
    inspectLegacyControlRecovery(database, workspaceId);
    if (remoteRuntimePending(database)) throw new CoreError("BUSY", "Remote effects must be reconciled first.");
    for (const table of globalPendingTables) {
      if (database.prepare(`SELECT 1 FROM ${table}`).get()) {
        throw new CoreError("BUSY", "A different durable workspace intent must be reconciled first.");
      }
      if (!allowCoding && (database.prepare("SELECT 1 FROM coding_worker_effects WHERE state='intent' LIMIT 1").get()
        || database.prepare("SELECT 1 FROM coding_worker_records WHERE kind IN ('worker','check-intent') AND json_extract(record,'$.status')='intent' LIMIT 1").get()))
        throw new CoreError("BUSY", "A coding effect must be reconciled first.");
    }
    if (!operationId) throw new CoreError("INVALID_ARGUMENT", "Durable operationId is required.");
  };
  const { inlineNotes, pausedSnapshots, batch15Skills, batch15Assets, skillSource } = (() => {
    try {
      const skillSource = options.skillSource
        ? createNativeLegacySkillSourceComposition(storage, database, workspaceId, options.skillSource, assertCommandOwner) : undefined;
      return {
        skillSource,
        batch15Skills: options.batch15Skills
          ? createBatch15SkillComposition(storage, database, workspaceId, options.batch15Skills, assertCommandOwner,
            skillSource ? actor => skillSource.replayLegacy(actor) : undefined) : undefined,
        batch15Assets: options.batch15Assets
          ? createBatch15AssetComposition(storage, database, workspaceId, options.batch15Assets, assertCommandOwner) : undefined,
        inlineNotes: options.legacyInlineNotes
          ? createNativeInlineNoteComposition(storage, database, options.legacyInlineNotes, assertCommandOwner, assertOperationAvailable) : undefined,
        pausedSnapshots: options.pausedSnapshots
          ? createNativePausedSnapshotComposition(storage, database, workspaceId, options.pausedSnapshots, assertCommandOwner, assertOperationAvailable) : undefined,
      };
    } catch (error) { database.close(); throw error; }
  })();
  const commitReceipt = (operationId: string, fingerprint: string, actorId: string, operation: string, result: unknown, allowCoding = false) => {
    const prior = database.prepare("SELECT fingerprint,actor_id,operation FROM receipts WHERE operation_id=?").get(operationId);
    if (prior) {
      if (prior.fingerprint !== fingerprint || prior.actor_id !== actorId || prior.operation !== operation) {
        throw new CoreError("CONFLICT", "Global operationId belongs to a different request or actor.");
      }
      return;
    }
    assertOperationAvailable(operationId, allowCoding);
    database.prepare("INSERT INTO receipts VALUES(?,?,?,?,?,?)")
      .run(operationId, fingerprint, JSON.stringify(result), actorId, operation, new Date().toISOString());
  };
  if (options.trash) {
    if (options.trash.layoutVersion !== "pkm.trash-lifecycle/v1") {
      database.close(); throw new CoreError("INVALID_CONFIGURATION", "Unsupported native trash layout.");
    }
  }
  if (options.legacyTrash && (!/^[a-f0-9]{64}$/.test(options.legacyTrash.trustedImportPlanSha256)
    || typeof options.legacyTrash.authorize !== "function" || !options.legacyTrash.snapshotScope)) {
    database.close();
    throw new CoreError("INVALID_CONFIGURATION", "Legacy trash requires an external import pin, native scope and actor policy.");
  }
  const data = new DataRuntime({
    database, root, workspaceId, transaction, reconcileIndex() {
      const documents = scanMarkdown(root);
      database.prepare("DELETE FROM documents").run();
      const insert = database.prepare("INSERT INTO documents(id,title,revision,deleted,sha256,path,area) VALUES(?,?,?,?,?,?,?)");
      for (const { record } of documents) insert.run(record.id, record.title, record.revision, record.deleted ? 1 : 0,
        record.sha256, record.path, record.area);
    },
    fingerprint: request => digest({ operation: request.operation, actorId: request.actorId, args: request.args }),
    assertOperationAvailable, host: options.data && wrapDataHost(options.data, assertOwner),
  });
  const dataServices = {
    read: (request: Parameters<DataRuntime["read"]>[0]) => storage.withWorkspaceExclusive(() => data.read(request)),
    mutate: (request: Parameters<DataRuntime["mutate"]>[0]) => storage.withWorkspaceExclusive(() => data.mutate(request)),
    inspectRecovery: () => storage.withWorkspaceExclusive(() => data.inspectRecovery()),
    recover: () => storage.withWorkspaceExclusive(() => data.recover()),
    searchReranked: (actorId: string, request: Parameters<DataRuntime["searchReranked"]>[1]) =>
      storage.withWorkspaceExclusive(() => data.searchReranked(actorId, request)),
    memoryRetriever: () => {
      const retrieve = data.memoryRetriever();
      return (input: Parameters<typeof retrieve>[0]) => storage.withWorkspaceExclusive(() => retrieve(input));
    },
    close: () => data.close(),
  };
  const trashLayout = options.trash ?? (options.legacyTrash ? { layoutVersion: "pkm.trash-lifecycle/v1" as const } : undefined);
  const migration = new MigrationRuntime({
    database, root, workspaceId, transaction, assertOperationAvailable, trash: trashLayout,
    fingerprint: request => digest({ operation: request.operation, actorId: request.actorId, args: request.args }),
    reconcileIndex() {
      const documents = scanMarkdown(root);
      database.prepare("DELETE FROM documents").run();
      const insert = database.prepare("INSERT INTO documents(id,title,revision,deleted,sha256,path,area) VALUES(?,?,?,?,?,?,?)");
      for (const { record } of documents) insert.run(record.id, record.title, record.revision, record.deleted ? 1 : 0,
        record.sha256, record.path, record.area);
    },
  });
  const migrationServices = {
    read: (request: Parameters<MigrationRuntime["read"]>[0]) => storage.withWorkspaceExclusive(() => migration.read(request)),
    mutate: (request: Parameters<MigrationRuntime["mutate"]>[0]) => storage.withWorkspaceExclusive(async () => {
      if (legacyTrashHost) {
        const inspected = await inspectLegacyTrashNative(legacyTrashHost.host);
        if (request.operation === "knowledge.trash.restore"
          && inspected.receipt.original.entries.some(entry => entry.runtimeId === request.args.entryId)) {
          throw new CoreError("NOT_AVAILABLE", "Imported original Trash must use its receipt-aware knowledge.trash.restore.original operation.");
        }
      }
      return migration.mutate(request);
    }),
    inspectRecovery: () => storage.withWorkspaceExclusive(() => migration.inspectRecovery()),
    recover: () => storage.withWorkspaceExclusive(() => migration.recover()),
  };
  let pendingLegacyTrashIndex: MarkdownRecord[] | undefined;
  const legacyTrashReconcileIndex = () => {
    if (!database.isTransaction) {
      throw new CoreError("TRANSACTION_BOUNDARY", "Imported trash index reconciliation requires the exact prepared restore snapshot.");
    }
    if (!pendingLegacyTrashIndex) {
      const documents = scanMarkdown(root);
      database.prepare("DELETE FROM documents").run();
      const insert = database.prepare("INSERT INTO documents(id,title,revision,deleted,sha256,path,area) VALUES(?,?,?,?,?,?,?)");
      for (const { record } of documents) insert.run(record.id, record.title, record.revision, Number(record.deleted), record.sha256, record.path, record.area);
      return;
    }
    const insert = database.prepare("INSERT INTO documents(id,title,revision,deleted,sha256,path,area) VALUES(?,?,?,?,?,?,?)");
    for (const { record } of pendingLegacyTrashIndex) {
      const prior = database.prepare("SELECT id,title,revision,deleted,sha256,path,area FROM documents WHERE id=?").get(record.id);
      if (prior) {
        if (prior.id !== record.id || prior.title !== record.title || prior.revision !== record.revision
          || prior.deleted !== Number(record.deleted) || prior.sha256 !== record.sha256
          || prior.path !== record.path || prior.area !== record.area) {
          throw new CoreError("CONFLICT", "Restored original document identity conflicts with the native index.");
        }
      } else {
        insert.run(record.id, record.title, record.revision, Number(record.deleted), record.sha256, record.path, record.area);
      }
    }
    pendingLegacyTrashIndex = undefined;
  };
  const legacyTrashHost = options.legacyTrash ? createNativeLegacyTrashAccess({
    database, storage, root, workspaceId, policy: options.legacyTrash,
    transaction, reconcileIndex: legacyTrashReconcileIndex, assertOperationAvailable,
  }) : undefined;
  const legacyTrashAccess = legacyTrashHost?.access;
  const legacyTrashDocumentsById = new Map<string, MarkdownRecord[]>();
  const legacyTrashReceiptRow = database.prepare("SELECT 1 FROM legacy_trash_import_receipt WHERE workspace_id=?").get(workspaceId);
  const legacyTrashMarkerPresent = existsSync(join(root, legacyTrashStageReceiptPath));
  if (!options.legacyTrash && (legacyTrashReceiptRow || legacyTrashMarkerPresent)) {
    database.close();
    throw new CoreError("RECOVERY_CONFLICT", "Imported legacy trash requires its explicit external plan pin and native actor policy.");
  }
  if (options.legacyTrash && legacyTrashReceiptRow && options.legacyTrash.import) {
    database.close();
    throw new CoreError("COLLISION", "An adopted trash receipt cannot be imported again.");
  }
  if (options.legacyTrash && !legacyTrashReceiptRow && !options.legacyTrash.import) {
    database.close();
    throw new CoreError("RECOVERY_CONFLICT", "Published legacy trash stage requires explicit adoption authority.");
  }
  if (options.legacyTrash?.import) {
    const { plan, authority } = options.legacyTrash.import;
    if (authority.destination !== root || authority.workspaceId !== workspaceId
      || authority.planSha256 !== options.legacyTrash.trustedImportPlanSha256 || !legacyTrashMarkerPresent) {
      database.close();
      throw new CoreError("AUTHORITY_REQUIRED", "Published stage does not match the externally pinned native adoption authority.");
    }
    await adoptLegacyTrashImport(legacyTrashHost!.host, plan, authority);
  }
  if (options.legacyTrash) {
    let pending = database.prepare("SELECT operation,actor_id,plan_json FROM migration_runtime_intents").get() as
      { operation?: string; actor_id?: string; plan_json?: string } | undefined;
    if (pending && legacyTrashPurgeDefinitions.some(item => item.id === pending!.operation)) {
      if (!options.legacyTrash.recoveryActorId || options.legacyTrash.recoveryActorId !== pending.actor_id) {
        database.close();
        throw new CoreError("RECOVERY_CONFLICT", "Permanent Trash recovery requires its exact externally authorized actor.");
      }
      try { await legacyTrashAccess!.recover(options.legacyTrash.recoveryActorId); }
      catch (error) { database.close(); throw error; }
      pending = undefined;
    }
    if (pending && (pending.operation === "knowledge.trash.move" || pending.operation === "knowledge.trash.restore")) {
      const imported = readLegacyTrashAdoptionReceipt(legacyTrashHost!.host);
      const entryId = (JSON.parse(String(pending.plan_json)) as { entryId?: string }).entryId;
      if (!imported.original.entries.some(entry => entry.runtimeId === entryId)) {
        if (!options.legacyTrash.recoveryActorId || options.legacyTrash.recoveryActorId !== pending.actor_id
          || !options.legacyTrash.authorize(pending.actor_id!, "knowledge.trash.restore")) {
          database.close();
          throw new CoreError("RECOVERY_CONFLICT", "Native Trash coexistence recovery requires its exact externally authorized actor.");
        }
        await storage.withWorkspaceExclusive(() => migration.recover());
        pending = undefined;
      }
    }
    if (pending && /^knowledge\.(note|skill|research)\.(create|update)$/.test(String(pending.operation))) {
      if (!options.legacyTrash.recoveryActorId || options.legacyTrash.recoveryActorId !== pending.actor_id
        || !options.legacyTrash.authorize(pending.actor_id!, "knowledge.trash.adopt")) {
        database.close();
        throw new CoreError("RECOVERY_CONFLICT", "Knowledge mutation coexistence recovery requires its exact externally authorized actor.");
      }
      await storage.withWorkspaceExclusive(() => migration.recover());
      pending = undefined;
    }
    let snapshot: Awaited<ReturnType<typeof snapshotLegacyTrashTree>>;
    let receipt: ReturnType<typeof readLegacyTrashAdoptionReceipt>;
    if (pending) {
      snapshot = await snapshotLegacyTrashTree(root, true, legacyTrashHost!.host.snapshotScope);
      receipt = readLegacyTrashAdoptionReceipt(legacyTrashHost!.host);
      readLegacyTrashHistory(legacyTrashHost!.host);
    } else {
      const inspected = await storage.withWorkspaceExclusive(() => inspectLegacyTrashNative(legacyTrashHost!.host));
      snapshot = inspected.snapshot;
      receipt = inspected.receipt;
    }
    const activeTrashEntries = currentLegacyTrashEntries(database, root, workspaceId, receipt);
    const nativeBuckets = new Set<string>();
    for (const row of database.prepare("SELECT * FROM migration_runtime_trash").all()) {
      if (receipt.original.entries.some(entry => entry.runtimeId === row.entry_id)) continue;
      const plan = assertNativeTrashRow(database, workspaceId, root, row);
      nativeBuckets.add(`${plan.area}/.trash/${plan.entryId}`);
    }
    const documents = legacyTrashDocuments(snapshot, activeTrashEntries.map(entry => ({ ...entry, originalId: entry.runtimeId })), nativeBuckets);
    const pendingEntryId = pending?.plan_json
      ? (JSON.parse(pending.plan_json) as { entryId?: string }).entryId : undefined;
    verifyRestoredLegacyTrashFiles(snapshot, receipt, activeTrashEntries, pendingEntryId,
      readLegacyTrashPurgedIds(legacyTrashHost!.host, receipt),
      new Set(receipt.plans.map(deserializeTrashLifecyclePlan).filter(plan =>
        nativeTrashSupersedesImportedPlan(database, workspaceId, plan)
        || nativeKnowledgeSupersedesImportedPlan(database, workspaceId, plan, snapshot.inventory)).map(plan => plan.entryId)));
    for (const entry of receipt.original.entries) {
      const paths = new Set(entry.removedPaths);
      legacyTrashDocumentsById.set(entry.originalId, documents.filter(doc =>
        doc.record.area === entry.area && paths.has(`${doc.record.area}/${doc.record.path}`)));
    }
    if (pending) {
      if (pending.operation !== "knowledge.trash.restore" || !options.legacyTrash.recoveryActorId
        || options.legacyTrash.recoveryActorId !== pending.actor_id) {
        database.close();
        throw new CoreError("RECOVERY_CONFLICT", "Imported trash recovery requires its exact externally authorized restore actor.");
      }
      const activePlan = JSON.parse(String(pending.plan_json)) as { entryId?: string };
      const entry = receipt.original.entries.find(item => item.runtimeId === activePlan.entryId);
      if (!entry) {
        database.close();
        throw new CoreError("RECOVERY_CONFLICT", "Pending native restore does not belong to an imported original deletion.");
      }
      pendingLegacyTrashIndex = legacyTrashDocumentsById.get(entry.originalId) ?? [];
      await legacyTrashAccess!.recover(options.legacyTrash.recoveryActorId);
    }
  }

  const nativeConfigured = !!options.modelConfig || !!options.providerTransport || !!options.toolCatalog || !!options.reviewer;
  if (nativeConfigured && (!options.modelConfig || !options.providerTransport || !options.toolCatalog?.length
    || !options.reviewer || !options.toolCatalog.every(item => item && typeof item.name === "string"
      && typeof item.operation === "string" && !/^(?:manager|chat\.turn|workflow\.executor|agent\.runtime|retrieval\.runtime|subscription\.materialize|sync\.apply|knowledge\.folder)\./.test(item.operation)))) {
    database.close();
    throw new CoreError("INVALID_CONFIGURATION", "Native Chat requires an explicit model config, provider transport, tool catalog and exact approval reviewer.");
  }
  let core!: Core;
  let modelProvider: ModelProviderService | undefined;
  let chatTurns: ChatTurnService | undefined;
  let approval: { approvals: unknown; recover(): { unknown: number } } | undefined;
  let memoryContext: MemoryContextService | undefined;
  let workflow: WorkflowExecutor | undefined;
  let agentRuntime: ReturnType<typeof createAgentRuntime> | undefined;
  let manager: ReturnType<typeof createManagerRuntime> | undefined;
  let managerProgress: ManagerProgressService | undefined;
  let managerChat: ReturnType<typeof createManagerChatExactComposition> | undefined;
  let process: ReturnType<typeof createProcessBridge> | undefined;
  let subscriptionHostIpc: ReturnType<typeof attachNativeSubscriptionHostIpc> | undefined;
  let hostServices: ReturnType<typeof createHostServices> | undefined;
  let coding: ReturnType<typeof createCodingWorkerManagerHost> | undefined;
  let codingProcess: DatabaseSync | undefined;
  let channel: ReturnType<typeof createChannelRuntime> | undefined;
  let portal: ReturnType<typeof createPortalLifecycleRuntime> | undefined;
  let channelTaskAuthority: ChannelRuntimeHost["taskAuthority"];
  let remote: ReturnType<typeof createRemoteRuntime> | undefined;
  let subscription: ReturnType<typeof createRemoteSubscriptionRuntime> | undefined;
  let subscriptionBundle: ReturnType<typeof createNativeSubscriptionBundle> | undefined;
  const channelTokens = new Map<string, object>();
  const channelActors = new WeakMap<object, ChannelActor>();
  const channelConnections = new Map<string, ReturnType<ReturnType<typeof createChannelRuntime>["connect"]>>();
  const portalConnections = new Map<string, ReturnType<ReturnType<typeof createChannelRuntime>["connect"]>>();
  const closePortalConnections = () => {
    for (const connection of portalConnections.values()) connection.disconnect();
    portalConnections.clear();
  };
  const channelToken = (actor: Actor) => {
    const identity = options.channel!.actorForPublic(Object.freeze({ ...actor }));
    if (!identity || identity.actorId !== actor.id) throw new CoreError("ACCESS_DENIED", "Channel identity is not authorized.");
    let token = channelTokens.get(actor.id);
    if (!token) {
      token = Object.freeze({});
      channelActors.set(token, Object.freeze({ ...identity }));
      channelTokens.set(actor.id, token);
    }
    if (channelActors.get(token)?.kind !== identity.kind) throw new CoreError("ACCESS_DENIED", "Channel authority changed; native re-enrollment is required.");
    return token;
  };
  const managerTokens = new Map<string, object>();
  const managerOwners = new WeakMap<object, ManagerOwner>();
  const progressMutations = new Map<string, { actorId: string; args: JsonRecord }>();
  const managerToken = (actorId: string) => {
    let token = managerTokens.get(actorId);
    if (!token) {
      const owner = options.manager!.ownerForActor(actorId);
      if (!owner || owner.actorId !== actorId) throw new CoreError("ACCESS_DENIED", "Native Manager owner does not match authenticated actor.");
      token = Object.freeze({}); managerOwners.set(token, Object.freeze({ ...owner })); managerTokens.set(actorId, token);
    }
    return token;
  };
  const ownerTokens = new Map<string, AgentRuntimeOwnerToken>();
  const ownersByToken = new WeakMap<object, AgentRuntimeOwner>();
  const workflowTasks = new Set<Promise<void>>();
  const nativeTasks = new Set<Promise<unknown>>();
  let closing = false;
  let quiescing = false;
  async function acquireWorkspaceQuiescence() {
    if (closing || quiescing) throw new CoreError("BUSY", "Native host admission is unavailable.");
    quiescing = true;
    await Promise.allSettled([...nativeTasks, ...workflowTasks]);
    assertOwner();
    if (closing || nativeTasks.size || workflowTasks.size || progressMutations.size)
      throw new CoreError("BUSY", "Native runtime could not establish a drained workspace fence.");
    let held = true;
    return {
      assertHeld() {
        assertOwner();
        if (!held || !quiescing || closing || nativeTasks.size || workflowTasks.size || progressMutations.size)
          throw new CoreError("BUSY", "Native workspace quiescence lease lost.");
      },
      release() { held = false; quiescing = false; },
    };
  }
  function track<T>(work: () => Promise<T>): Promise<T> {
    if (closing || quiescing) return Promise.reject(new CoreError("NOT_AVAILABLE", "Native runtime is closing or quiescing."));
    const promise = Promise.resolve().then(work);
    nativeTasks.add(promise);
    void promise.finally(() => nativeTasks.delete(promise)).catch(() => undefined);
    return promise;
  }
  function trackService<T extends object>(service: T, names: readonly (keyof T)[]): T {
    for (const name of names) {
      const callback = service[name] as (...args: unknown[]) => unknown;
      Object.assign(service, { [name]: (...args: unknown[]) => track(async () => {
        assertOwner();
        const value = await callback.apply(service, args);
        assertOwner();
        return value;
      }) });
    }
    return service;
  }

  try {
    if (read(() => readLegacyExtensionPendingEnvelope(database))) await storage.recover();
    read(() => inspectLegacyControlRecovery(database, workspaceId));
    read(() => assertPortalRecoveryClear(database));
    read(() => readLegacyStateReceipt(database, workspaceId));
    const remoteHost = {
      database, root, workspaceId, transaction, read, assertLease: assertOwner, assertOperationAvailable,
      claimReceipt: commitReceipt, exclusive: <T>(work: () => Promise<T>) => storage.withWorkspaceExclusive(work),
      reconcileIndex() {
        assertOwner();
        if (!database.isTransaction) throw new CoreError("TRANSACTION_BOUNDARY", "Remote index reconciliation requires the parent commit.");
        const documents = scanMarkdown(root);
        database.prepare("DELETE FROM documents").run();
        const insert = database.prepare("INSERT INTO documents(id,title,revision,deleted,sha256,path,area) VALUES(?,?,?,?,?,?,?)");
        for (const { record } of documents) insert.run(record.id, record.title, record.revision, record.deleted ? 1 : 0, record.sha256, record.path, record.area);
      },
      prepareIndex() {
        assertOwner();
        if (database.isTransaction) throw new CoreError("TRANSACTION_BOUNDARY", "Filesystem index scan must precede the commit transaction.");
        const documents = scanMarkdown(root);
        return () => {
          assertOwner();
          if (!database.isTransaction) throw new CoreError("TRANSACTION_BOUNDARY", "Index installation requires the parent commit transaction.");
          database.prepare("DELETE FROM documents").run();
          const insert = database.prepare("INSERT INTO documents(id,title,revision,deleted,sha256,path,area) VALUES(?,?,?,?,?,?,?)");
          for (const { record } of documents) insert.run(record.id, record.title, record.revision, record.deleted ? 1 : 0, record.sha256, record.path, record.area);
        };
      },
    };
    if (options.remote) {
      if (typeof options.remote.authorize !== "function") throw new CoreError("INVALID_CONFIGURATION", "Remote runtime requires explicit actor and publication policy.");
      remote = trackService(createRemoteRuntime({ ...remoteHost, ...options.remote }),
        ["pin", "plan", "decide", "apply", "publish", "status", "reconcile"]);
    }
    if (options.subscription) {
      if (options.subscription.stagingRoot === root || options.subscription.stagingRoot.startsWith(`${root}/`))
        throw new CoreError("INVALID_CONFIGURATION", "Subscription stage root must be distinct from KnowledgeRoot.");
      subscription = trackService(createRemoteSubscriptionRuntime({ ...remoteHost, ...options.subscription }), ["run", "readMirror"]);
      read(() => inspectRemoteSubscriptionRecovery(database, workspaceId));
    }
    read(() => inspectNativeSubscriptionBundles(database, workspaceId));
    read(() => inspectLegacyControlRecovery(database, workspaceId));
    if (options.subscriptionBundle) {
      subscriptionBundle = trackService(createNativeSubscriptionBundle(remoteHost, options.subscriptionBundle), ["run", "recover"]);
      subscriptionBundle.inspect();
    }
    if (database.prepare("SELECT 1 FROM remote_runtime_intents WHERE kind='remote.subscription.bundle' AND state!='complete' LIMIT 1").get()
      && !subscriptionBundle) throw new CoreError("RECOVERY_CONFLICT", "Bundle recovery requires explicit native bundle authority.", "unknown");
    if (remoteRuntimePending(database) && !remote && !subscription && !subscriptionBundle)
      throw new CoreError("RECOVERY_CONFLICT", "Remote effects require explicitly configured native reconciliation.", "unknown");
    remote?.inspect();
    if (options.modelConfig && options.providerTransport && options.toolCatalog?.length && options.reviewer) {
      modelProvider = new ModelProviderService({ modelConfig: options.modelConfig, transport: options.providerTransport });
      const chatStore = new ChatTurnStore(database, {
        receipt(receipt) {
          const prior = database.prepare("SELECT fingerprint,actor_id,operation FROM receipts WHERE operation_id=?")
            .get(receipt.operationId);
          if (prior) {
            if (prior.fingerprint !== receipt.fingerprint || prior.actor_id !== receipt.actor
              || prior.operation !== receipt.operation) throw new CoreError("CONFLICT", "Global operationId conflicts with another native mutation.");
            return;
          }
          assertOperationAvailable(receipt.operationId);
          database.prepare("INSERT INTO receipts VALUES(?,?,?,?,?,?)").run(
            receipt.operationId, receipt.fingerprint, JSON.stringify(receipt.result), receipt.actor,
            receipt.operation, new Date().toISOString(),
          );
        },
      });
      transaction(() => chatStore.initialize());
      const toolsPort = createChatTurnToolPort({
        workspaceId, storage: { read, transaction: fn => transaction(() => fn(database)) },
        reviewer: async request => { assertOwner(); const result = await options.reviewer!(request); assertOwner(); return result; },
        gateway(actorId, turnId, verifyApproval) {
          const current = chatTurns!.get(actorId, turnId);
          return new ToolGateway({
            dispatcher: {
              dispatch: async (method, input, actor) => { assertOwner(); return core.dispatch(method, input, actor); },
            },
            actor: { id: actorId, canWrite: true },
            context: { workspaceId, turnId, contextDigest: current.contextDigest },
            catalog: options.toolCatalog,
            legacyChatOutput: true,
            limits: { outputBytes: CHAT_TOOL_GATEWAY_OUTPUT_BYTES },
            verifyApproval,
            authorize: async (binding, signal) => {
              assertOwner();
              if (!options.authorizeTool) return !signal.aborted;
              const allowed = await options.authorizeTool(binding, signal);
              assertOwner();
              return allowed;
            },
          });
        },
      });
      approval = toolsPort;
      const guardedProvider = {
        get available() { return modelProvider!.available; },
        get preDispatchAdmission() { return modelProvider!.preDispatchAdmission; },
        async *stream(request: Parameters<ModelProviderService["stream"]>[0], beforeDispatch?: () => void) {
          assertOwner();
          for await (const event of modelProvider!.stream(request, beforeDispatch && (() => { assertOwner(); beforeDispatch(); }))) {
            assertOwner();
            yield event;
          }
        },
      };
      const model = createChatTurnModelPort(guardedProvider, { tools: (...args) => toolsPort.modelTools(...args) });
      chatTurns = new ChatTurnService({ store: chatStore, transaction, model, tools: toolsPort.tools });
    }

    if (options.workflow) {
      const configured = { ...options.workflow.adapters };
      if (options.workflow.process) {
        process = createProcessBridge({ ...options.workflow.process, database, workspaceRoot: root });
        if (configured["pkm.step.command/v1"]) throw new CoreError("INVALID_CONFIGURATION", "Native process adapter conflicts with the configured command step adapter.");
        configured["pkm.step.command/v1"] = process.adapter;
      }
      const adapters = Object.fromEntries(Object.entries(configured).map(([key, adapter]) => [key, {
        ...adapter,
        authorizeDefinition: (binding: Parameters<WorkflowStepAdapter["authorizeDefinition"]>[0]) => {
          assertOwner(); return adapter.authorizeDefinition(binding);
        },
        execute: async (invocation: Parameters<WorkflowStepAdapter["execute"]>[0], context: Parameters<WorkflowStepAdapter["execute"]>[1]) => {
          assertOwner();
          const result = await adapter.execute(invocation, context);
          assertOwner();
          return result;
        },
        validateOutput: (outputs: Record<string, unknown>) => { assertOwner(); return adapter.validateOutput(outputs); },
      }]));
      workflow = new WorkflowExecutor(database, {
        workspaceRoot: root, ownerId: uuid(), adapters, leaseMs: options.workflow.leaseMs, assertOwner,
        ...(options.workflow.resolveRecipe ? { resolveRecipe: options.workflow.resolveRecipe } : {}),
      });
    }
    if (options.coding) {
      if (options.manager || options.managerText || !modelProvider)
        throw new CoreError("INVALID_CONFIGURATION", "Coding requires explicit model authority and exclusive Manager composition.");
      const config = options.coding;
      if (config.workspace.sourceRoot === root || config.workspace.stageParent === root
        || config.workspace.sourceRoot.startsWith(`${root}/`) || config.workspace.stageParent.startsWith(`${root}/`)
        || root.startsWith(`${config.workspace.sourceRoot}/`) || root.startsWith(`${config.workspace.stageParent}/`))
        throw new CoreError("INVALID_CONFIGURATION", "Disposable coding roots must be distinct from KnowledgeRoot.");
      const workspaceOptions = { ...config.workspace, db: database, workspaceId, transaction, assertLease: assertOwner };
      storage.inspectCodingProcess();
      if (database.prepare("SELECT 1 FROM coding_worker_effects WHERE workspace_id=? LIMIT 1").get(workspaceId)) {
        recoverCodingWorkerEffects(workspaceOptions);
        throw new CoreError("CODING_RESTART_FENCED", "Coding effects require native reconciliation; restart never repatches or relaunches.");
      }
      await dataServices.inspectRecovery();
      await migrationServices.inspectRecovery();
      assertOperationAvailable("coding-workspace-init");
      codingProcess = storage.connectCodingProcess();
      const workspace = createCodingWorkerWorkspace({ ...workspaceOptions, processDatabase: codingProcess });
      coding = createCodingWorkerManagerHost({
        workspace, provider: modelProvider, transaction, resolveOwner: token => managerOwners.get(token),
        plan: config.plan, authorizeTask: config.authorizeTask, bounds: config.bounds,
        exclusiveRun: true,
        chatReceipt: receipt => commitReceipt(receipt.operationId, receipt.fingerprint, receipt.actor, receipt.operation, receipt.result, true),
      });
      options = { ...options, manager: {
        ownerForActor: actorId => {
          if (actorId !== config.workspace.owner.actorId) throw new CoreError("ACCESS_DENIED", "Coding workspace has a distinct native owner.");
          return config.workspace.owner;
        },
        host: coding.host,
        resumeInterrupted: false,
      } };
    }
    if (options.channel) {
      const config = options.channel;
      if (["actorForPublic", "resolveNativeActor", "authorizeHuman", "authorizeDirected"].some(key =>
        typeof config[key as keyof typeof config] !== "function"))
        throw new CoreError("INVALID_CONFIGURATION", "Channel requires separate native-human and directed authority policies.");
      if (config.taskAuthority && config.taskAuthorityFactory)
        throw new CoreError("INVALID_CONFIGURATION", "Channel must use one canonical parent task authority.");
      channelTaskAuthority = config.taskAuthority ?? config.taskAuthorityFactory?.(Object.freeze({ database, workspaceId, assertLease: assertOwner }));
      if (channelTaskAuthority && (typeof channelTaskAuthority.authorize !== "function" || typeof channelTaskAuthority.apply !== "function"))
        throw new CoreError("INVALID_CONFIGURATION", "Channel task authority requires synchronous parent SQL projection hooks.");
      channel = createChannelRuntime(database, {
        resolveActor: token => channelActors.get(token) ?? config.resolveNativeActor(token),
        authorizeHuman: config.authorizeHuman, authorizeDirected: config.authorizeDirected,
        taskAuthority: channelTaskAuthority, notify: config.notify, assertLease: assertOwner,
        transaction, claimReceipt(operationId, fingerprint, actorId, operation) {
          if (!actorId || !operation) throw new CoreError("ACCESS_DENIED", "Channel receipt requires native derived identity.");
          commitReceipt(operationId, fingerprint, actorId, operation, { operationId });
        },
      });
    }
    if (options.portal) {
      if (!channel || !options.channel || typeof options.portal.authorizeHuman !== "function"
        || typeof options.portal.authorizeRoom !== "function") {
        throw new CoreError("INVALID_CONFIGURATION", "Portal requires explicit native Channel, human and room authorities.");
      }
      const portalEffect = <T>(work: () => T): T => {
        if (portalChannelEffect || database.isTransaction) throw new CoreError("TRANSACTION_BOUNDARY", "Portal Channel effects must start outside SQL.");
        portalChannelEffect = true;
        try { return work(); } finally { portalChannelEffect = false; }
      };
      const nativeChannel = channel;
      portal = createPortalLifecycleRuntime(database, createPortalLifecycleHost({
        ...options.portal, assertLease: assertOwner, transaction,
        channel: {
          connect(token, input) {
            const identity = channelActors.get(token) ?? options.channel!.resolveNativeActor(token);
            if (!identity) throw new CoreError("ACCESS_DENIED", "Portal connection requires native actor identity.");
            const key = JSON.stringify([identity.actorId, identity.kind, input.channelId]);
            let connection = portalConnections.get(key);
            if (!connection) {
              connection = nativeChannel.connect(token, input);
              portalConnections.set(key, connection);
            }
            const current = connection;
            return { read: input => current.read(input),
              send: input => portalEffect(() => current.send(input)), disconnect() {} };
          },
          nativeInviteCreate(token, input) {
            return portalEffect(() => {
              const issued = nativeChannel.nativeInviteCreate(token, input);
              if (typeof issued.invitationId !== "string" || typeof issued.token !== "string") {
                throw new CoreError("INVALID_RESULT", "Channel invitation secret is unavailable.");
              }
              return { invitationId: issued.invitationId, token: issued.token };
            });
          },
          nativeHumanApprove: (token, input) => portalEffect(() => nativeChannel.nativeHumanApprove(token, input)),
          accept: (token, input) => portalEffect(() => nativeChannel.accept(token, input)),
          nativeRevoke(token, input) {
            const result = portalEffect(() => nativeChannel.nativeRevoke(token, input));
            const revoked = input as { channelId: string; participantId: string };
            for (const [key, connection] of portalConnections) {
              if (JSON.parse(key)[2] === revoked.channelId && connection.participantId === revoked.participantId) {
                connection.disconnect(); portalConnections.delete(key);
              }
            }
            return result;
          },
        },
        resolveActor: token => channelActors.get(token) ?? options.channel!.resolveNativeActor(token),
        claimReceipt(operationId, fingerprint, actorId, operation) {
          if (!database.isTransaction) throw new CoreError("TRANSACTION_BOUNDARY", "Portal receipts require the parent transaction.");
          commitReceipt(operationId, fingerprint, actorId, operation, { operationId });
        },
      }));
      trackService(portal, ["openExisting", "requestAdmission", "cancelAdmission", "approveAdmission", "admit",
        "route", "read", "leave", "revoke", "transfer", "startMeeting", "adjournMeeting", "connections", "status", "inspectRecovery", "readAdmission"]);
    }
    if (options.managerText) {
      if (options.manager || !modelProvider) throw new CoreError("INVALID_CONFIGURATION", "Pinned text Manager requires configured model authority and no other Manager host.");
      const config = managerTextConfigSchema.parse(options.managerText);
      managerChat = createManagerChatExactComposition({
        db: database, transaction, provider: modelProvider, workspaceId,
        workspaceVersion: () => { assertOwner(); return "pkm.next-workspace/v2"; },
        contract: config.contract, expected: config.expected,
        bounds: { maxConcurrentTurns: config.maxConcurrentTurns },
        receipt: receipt => commitReceipt(receipt.operationId, receipt.fingerprint, receipt.actor, receipt.operation, receipt.result),
        context: (_owner, task) => ({ entries: config.context.filter(item => managerChatWithin(item.path, task.readScope))
          .map(item => ({ ...item, pin: managerPlanDefinitionHash(item) })), assertCurrent: assertOwner }),
      });
      options = { ...options, manager: {
        ownerForActor: actorId => ({ actorId, nativeOwnerId: `text-${digest({ workspaceId, actorId })}` }),
        host: managerChat.host,
      } };
    }
    if (options.manager) {
      const supplied = options.manager.host;
      if (typeof options.manager.ownerForActor !== "function"
        || !["authorizeTask", "plan", "worker", "validate", "freeze", "integrate", "verify"].every(key =>
          typeof supplied?.[key as keyof typeof supplied] === "function")) {
        throw new CoreError("INVALID_CONFIGURATION", "Manager requires explicit trusted planning, worker and verification adapters.");
      }
      const guarded = <T extends (...args: never[]) => unknown>(callback: T): T => ((...args: never[]) => {
        assertOwner(); const result = callback(...args);
        if (result && typeof (result as { then?: unknown }).then === "function") {
          return Promise.resolve(result).then(value => { assertOwner(); return value; });
        }
        assertOwner(); return result;
      }) as T;
      const host = Object.fromEntries(["authorizeTask", "plan", "worker", "validate", "freeze", "integrate", "verify", "cancel", "reconcile"]
        .flatMap(name => {
          const callback = supplied[name as keyof typeof supplied];
          return typeof callback === "function" ? [[name, guarded(callback.bind(supplied) as (...args: never[]) => unknown)]] : [];
        })) as Omit<ManagerRuntimeHost, "resolveOwner">;
      manager = createManagerRuntime(database, {
        host: { ...host, resolveOwner: token => managerOwners.get(token) }, assertOwner, leaseMs: options.manager.leaseMs,
        onMutation({ owner, operationId, operation, args, result }) {
          const progress = progressMutations.get(operationId);
          if (progress) {
            if (operation !== "feedback" || progress.actorId !== owner.actorId) {
              throw new CoreError("CONFLICT", "Feedback receipt belongs to a different native request.");
            }
            commitReceipt(operationId, digest({ operation: "manager.progress.feedback", actorId: progress.actorId, args: progress.args }),
              progress.actorId, "manager.progress.feedback", {
                schema: "pkm.manager.progress.feedback-receipt/v1", feedbackId: operationId, runId: result.runId,
                target: progress.args.target, status: "applied", version: result.version, receivedAt: new Date(result.updatedAt).toISOString(),
              });
            return;
          }
          const publicOperation = `manager.runtime.${operation}`;
          commitReceipt(operationId, digest({ operation: publicOperation, actorId: owner.actorId, args }),
            owner.actorId, publicOperation, result, !!coding && operation !== "start");
        },
      });
      managerProgress = new ManagerProgressService(manager);
    }

    if (options.agents) {
      for (const task of options.agents.tasks) {
        if (!task || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,95}$/.test(task.key)) {
          throw new CoreError("INVALID_CONFIGURATION", "Invalid configured Agent task.");
        }
      }
      const host: AgentRuntimeHost = {
        resolveOwner(token) { return ownersByToken.get(token); },
        spawn: request => track(async () => { assertOwner(); const result = await options.agents!.host.spawn(request); assertOwner(); return result; }),
        inspect: request => track(async () => { assertOwner(); const result = await options.agents!.host.inspect(request); assertOwner(); return result; }),
        cancel: request => track(async () => { assertOwner(); await options.agents!.host.cancel(request); assertOwner(); }),
      };
      agentRuntime = createAgentRuntime(database, {
        tasks: options.agents.tasks, snapshots: options.agents.snapshots, host, assertOwner,
        onMutation({ actorId, opId, operation, args, receipt, session }) {
          const publicOperation = `agent.runtime.${operation}`;
          commitReceipt(opId, digest({ operation: publicOperation, actorId, args }), actorId,
            publicOperation, { receipt, session });
        },
      });
    }

    const dataAvailable = (operation: string) => {
      if (operation === "retrieval.runtime.availability") return true;
      if (operation === "retrieval.runtime.search") return !!options.data?.retrieval;
      if (operation.startsWith("retrieval.runtime.")) return false;
      if (operation === "subscription.materialize.apply") return false;
      return true;
    };
    if (options.hostServices?.action?.process && options.workflow?.process)
      throw new CoreError("INVALID_CONFIGURATION", "Action and Workflow cannot install competing native process owners.");
    hostServices = createHostServices({
      ...options.hostServices, database, storage, workspaceId,
      assertOwner,
      authorizeBackup(request) {
        assertOwner();
        inspectLegacyNoteWorkItemsState(database);
        if (request.operation === "backup" && existsSync(join(root, "coding-process.sqlite")))
          throw new CoreError("CODING_BACKUP_UNSUPPORTED", "Backup is refused before snapshot creation: the dedicated coding process journal requires multi-database qualification.");
        return options.hostServices?.authorizeBackup?.(request) ?? false;
      },
      beforeEffect() { assertOwner(); assertOperationAvailable("native-action"); },
      assertQuiescent() {
        if (nativeTasks.size || workflowTasks.size || progressMutations.size)
          throw new CoreError("BUSY", "Native operations must drain before backup.");
      },
      acquireQuiescence: acquireWorkspaceQuiescence,
    });
    const dispatcher: NativeRuntimeDispatcher = {
      available(operation, actor) {
        if (operation === legacySkillSourceOperation || operation === legacySkillSourceRemoveOperation || operation === legacySkillSourceBridgeOperation) return skillSource?.available(actor, operation) === true;
        if (operation === "knowledge.classification.native-strict.command") return batch16Classification?.available(actor) === true;
        if (operation === LEGACY_CLASSIFICATION_COMMAND_ID) return originalClassification?.available(actor) === true;
        if (operation === "memory.scope.forget.native") return batch16Memory?.available(actor) === true;
        if (operation.startsWith("legacy.skill.router.")) return batch15Skills?.available(actor, operation) === true;
        if (operation === "knowledge.legacy-links.resolve" || operation === "knowledge.asset.ownership.validate")
          return batch15Assets?.available(actor, operation) === true;
        if (snapshotRestoreOperations.has(operation)) return pausedSnapshots?.available(actor) === true;
        if (operation === "legacy.note.workitems.read" && inlineNotes) return true;
        if (["legacy.note.workitems.command", "legacy.note.workitems.upsert"].includes(operation) && inlineNotes)
          return actor ? actor.canWrite : true;
        if (operation.startsWith("legacy.note.workitems.")) return noteWorkItems?.available(operation, actor) === true;
        if (operation === "project.recipe.trash.command") return !!recipeTrashHost
          && (!actor || ["recipe-trash-move", "recipe-trash-restore"].some(operation =>
            recipeTrashHost.authorize(actor.id, operation as "recipe-trash-move" | "recipe-trash-restore")));
        if (operation === "project.legacy.command") return !!options.legacyCommands;
        if (["knowledge.trash.list", "knowledge.trash.get", "knowledge.trash.restore.original",
          ...legacyTrashPurgeDefinitions.map(item => item.id)].includes(operation)) {
          if (!legacyTrashAccess || !legacyTrashHost) return false;
          if (!actor) return true;
          const policyOperation = operation.endsWith(".original") ? operation.slice(0, -".original".length) : operation;
          try { return legacyTrashHost.host.authorize?.(actor.id, policyOperation as Parameters<NonNullable<typeof legacyTrashHost.host.authorize>>[1]) === true; }
          catch { return false; }
        }
        if (operation.startsWith("portal.lifecycle.")) {
          if (!portal || !options.channel) return false;
          if (!actor) return true;
          try { return options.channel.actorForPublic(actor)?.actorId === actor.id; } catch { return false; }
        }
        if (operation.startsWith("agent.snapshot.")) return ["agent.snapshot.list", "agent.snapshot.get", "agent.snapshot.read"].includes(operation);
        if (operation === "subscription.identity.get") return !!options.subscriptionIdentity;
        if (operation === "subscription.broker.share-markers") return true;
        if (operation.startsWith("remote.runtime.subscription.bundle.")) return !!subscriptionBundle;
        if (operation.startsWith("channel.runtime.")) {
          if (!channel) return false;
          if (actor) {
            try {
              const identity = options.channel!.actorForPublic(actor);
              if (!identity || identity.actorId !== actor.id) return false;
            } catch { return false; }
          }
          return !["channel.runtime.assign", "channel.runtime.update", "channel.runtime.reply"].includes(operation) || !!channelTaskAuthority;
        }
        if (operation.startsWith("action.runtime.")) return options.hostServices?.action !== undefined;
        if (operation === "manager.chat.artifacts") return !!managerChat;
        if (operation.startsWith("manager.")) return !!manager && (!actor || !options.coding || actor.id === options.coding.workspace.owner.actorId);
        if (migrationRuntimeDefinitions.some(item => item.id === operation)) return migration.available(operation);
        if (operation.startsWith("chat.turn.")) return !!chatTurns?.available;
        if (operation.startsWith("workflow.executor.")) return !!workflow;
        if (operation.startsWith("agent.runtime.")) return !!agentRuntime
          && ["agent.runtime.spawn", "agent.runtime.cancel", "agent.runtime.get", "agent.runtime.list"].includes(operation);
        if (operation.startsWith("knowledge.folder.lifecycle.") || operation === "knowledge.folder.move" || operation === "knowledge.folder.promote-delete"
          || operation.startsWith("sync.apply.") || operation === "sync.apply"
          || operation.startsWith("retrieval.runtime.") || operation === "subscription.materialize.apply") {
          const definition = [...folderLifecycleDefinitions, ...dataRuntimeDefinitions].find(item => item.id === operation);
          if (definition && "nativeOnly" in definition && definition.nativeOnly) return false;
          return dataAvailable(operation);
        }
        return false;
      },
      async dispatch(operation, args, actor) {
        return track(async () => {
        assertOwner();
        if (["subscription.list", "subscription.get", "subscription.acl.evaluate", "subscription.identity.get", "subscription.broker.share-markers"].includes(operation)) {
          if (options.experimentalSubscriptionHost && (operation === "subscription.list" || operation === "subscription.get")) {
            const profile = options.experimentalSubscriptionHost.profile;
            return storage.withWorkspaceExclusive(async () => {
              await verifyNativeSubscriptionIdentity(database, root, workspaceId, options.subscriptionIdentity, "read", null, actor);
              const result = await readSubscriptions(root, { operation, args, actorId: actor.id },
                () => readNativeSubscriptionProfile(storage, profile));
              await verifyNativeSubscriptionIdentity(database, root, workspaceId, options.subscriptionIdentity, "read", null, actor);
              return result;
            });
          }
          return dispatchNativeSubscriptionRead(operation, args, actor, { database, root, workspaceId, assertOwner }, options.subscriptionIdentity);
        }
        if (operation === legacySkillSourceOperation || operation === legacySkillSourceRemoveOperation || operation === legacySkillSourceBridgeOperation) {
          if (!skillSource) throw new CoreError("NOT_AVAILABLE", "Canonical Skill source native authority is unavailable.");
          return skillSource.dispatch(args, actor, operation);
        }
        if (operation === "knowledge.classification.native-strict.command") {
          if (!batch16Classification) throw new CoreError("NOT_AVAILABLE", "Native classification fixture authority is unavailable.");
          return batch16Classification.dispatch(args, actor);
        }
        if (operation === LEGACY_CLASSIFICATION_COMMAND_ID) {
          if (!originalClassification) throw new CoreError("NOT_AVAILABLE", "Original classification native fixture authority is unavailable.");
          return originalClassification.dispatch(args, actor);
        }
        if (operation === "memory.scope.forget.native") {
          if (!batch16Memory) throw new CoreError("NOT_AVAILABLE", "Native memory fixture authority is unavailable.");
          return batch16Memory.dispatch(args, actor);
        }
        if (operation.startsWith("legacy.skill.router.")) {
          if (!batch15Skills) throw new CoreError("NOT_AVAILABLE", "Native Skill fixture authority is unavailable.");
          return batch15Skills.dispatch(operation, args, actor);
        }
        if (operation === "knowledge.legacy-links.resolve" || operation === "knowledge.asset.ownership.validate") {
          if (!batch15Assets) throw new CoreError("NOT_AVAILABLE", "Native original inventory authority is unavailable.");
          return batch15Assets.dispatch(operation, args, actor);
        }
        if (snapshotRestoreOperations.has(operation)) {
          if (!pausedSnapshots) throw new CoreError("NOT_AVAILABLE", "Explicit native paused Snapshot policy is unavailable.");
          return pausedSnapshots.dispatch(operation, args, actor);
        }
        if (operation.startsWith("legacy.note.workitems.")) {
          const boardAdmitted = !!database.prepare("SELECT 1 FROM legacy_note_workitems_admission WHERE slug=?").get(String(args.slug ?? ""));
          if (operation === "legacy.note.workitems.read" && inlineNotes?.admitted(args.slug) && !boardAdmitted)
            return inlineNotes.read(String(args.slug), actor);
          if (["legacy.note.workitems.command", "legacy.note.workitems.upsert"].includes(operation) && inlineNotes?.admitted(args.slug) && !boardAdmitted)
            return inlineNotes.dispatch(operation, args, actor);
          if (!noteWorkItems) throw new CoreError("NOT_AVAILABLE", "Native Note Work Items policy is unavailable.");
          return noteWorkItems.dispatch(operation, args, actor);
        }
        if (operation === "project.recipe.trash.command") {
          if (!recipeTrashHost) throw new CoreError("NOT_AVAILABLE", "Native Recipe trash policy is unavailable.");
          return storage.withWorkspaceExclusive(() => {
            assertPortalRecoveryClear(database);
            return dispatchNativeRecipeTrash(database, root, workspaceId, actor, args, recipeTrashHost, transaction);
          });
        }
        if (operation === "project.legacy.command") {
          const command = args.command as { operation?: string };
          if (command.operation === "project.update" && args.args === undefined) {
            return storage.request({ operation, args, actorId: actor.id } as never);
          }
          if (!options.legacyCommands) throw new CoreError("NOT_AVAILABLE", "Native legacy command authority is unavailable.");
          return storage.withWorkspaceExclusive(() => {
            assertPortalRecoveryClear(database);
            return dispatchNativeLegacyCommand(database, root, workspaceId, actor, args, options.legacyCommands!, assertCommandOwner);
          });
        }
        if (operation === "knowledge.trash.list" || operation === "knowledge.trash.get"
          || operation === "knowledge.trash.restore.original" || legacyTrashPurgeDefinitions.some(item => item.id === operation)) {
          if (!legacyTrashAccess || !legacyTrashHost) throw new CoreError("NOT_AVAILABLE", "Authenticated original trash import policy is unavailable.");
          try {
            if (legacyTrashPurgeDefinitions.some(item => item.id === operation)) {
              return await legacyTrashAccess.purge(actor.id, operation, args);
            }
            if (operation === "knowledge.trash.list") return { items: await legacyTrashAccess.list(actor.id) };
            if (operation === "knowledge.trash.get") {
              const value = await legacyTrashAccess.get(actor.id, String(args.area), String(args.originalId));
              return {
                entry: value.entry,
                metadataBytes: value.metadataBytes.toString("base64"),
                deletionHistory: {
                  originalBytes: value.deletionHistory.originalBytes?.toString("base64") ?? null,
                  current: value.deletionHistory.current,
                },
                files: value.files.map(file => ({ path: file.path, bytes: file.bytes.toString("base64") })),
              };
            }
            const originalId = String(args.originalId);
            pendingLegacyTrashIndex = legacyTrashDocumentsById.get(originalId);
            try {
              return await legacyTrashAccess.restore(actor.id, String(args.area), originalId, String(args.operationId));
            } finally { pendingLegacyTrashIndex = undefined; }
          } catch (error) {
            if (error instanceof LegacyTrashImportError) {
              const purge = legacyTrashPurgeDefinitions.some(item => item.id === operation);
              const uncertain = purge && (
                database.prepare("SELECT 1 FROM migration_runtime_intents WHERE operation_id=?").get(String(args.operationId))
                || database.prepare("SELECT 1 FROM receipts WHERE operation_id=? AND actor_id=? AND operation=?")
                  .get(String(args.operationId), actor.id, operation));
              throw new CoreError(error.code, error.message, uncertain ? "unknown" : "not-committed");
            }
            throw error;
          }
        }
        if (operation.startsWith("portal.lifecycle.")) {
          if (!portal) throw new CoreError("NOT_AVAILABLE", "Native Portal policy is unavailable.");
          try {
            const token = channelToken(actor);
            switch (operation) {
              case "portal.lifecycle.connections": return await portal.connections(token, args);
              case "portal.lifecycle.status": return await portal.status(token, args);
              case "portal.lifecycle.read": return await portal.read(token, args);
              case "portal.lifecycle.route": return await portal.route(token, args);
              default: throw new CoreError("NOT_FOUND", "Unknown Portal operation.");
            }
          } catch (error) {
            if (error instanceof PortalLifecycleError) throw new CoreError(
              error.code === "UNAUTHORIZED" || error.code === "FORBIDDEN" ? "ACCESS_DENIED" : error.code, error.message);
            throw error;
          }
        }
        if (operation.startsWith("agent.snapshot.")) {
          return dispatchLegacySnapshot(operation, args, actor, {
            root, workspaceId, assertOwner,
            receipt: () => read(() => readLegacyStateReceipt(database, workspaceId)),
          }, legacySnapshots);
        }
        if (operation.startsWith("remote.runtime.subscription.bundle.")) {
          if (!subscriptionBundle) throw new CoreError("NOT_AVAILABLE", "Native bundle authority is unavailable.");
          if (operation === "remote.runtime.subscription.bundle.run") return subscriptionBundle.run(actor.id, args);
          if (operation === "remote.runtime.subscription.bundle.recover") return subscriptionBundle.recover(actor.id, args);
          throw new CoreError("NOT_FOUND", "Unknown bundle operation.");
        }
        if (operation.startsWith("channel.runtime.")) {
          try {
            const token = channelToken(actor);
            if (operation === "channel.runtime.accept") return channel!.accept(token, args);
            const key = JSON.stringify([actor.id, args.channelId]);
            if (operation === "channel.runtime.reconnect") {
              channelConnections.get(key)?.disconnect();
              const connection = channel!.connect(token, args);
              channelConnections.set(key, connection);
              return { participantId: connection.participantId, generation: connection.generation };
            }
            let connection = channelConnections.get(key);
            if (!connection) {
              connection = channel!.connect(token, { channelId: args.channelId });
              channelConnections.set(key, connection);
            }
            const method = operation.slice("channel.runtime.".length) as "read" | "wait" | "send" | "assign" | "update" | "reply" | "ack";
            return await connection[method](args);
          } catch (error) {
            if (error instanceof ChannelRuntimeError) throw new CoreError(
              error.code === "UNAUTHORIZED" ? "ACCESS_DENIED" : error.code === "REVISION_CONFLICT" ? "CONFLICT" : error.code, error.message);
            throw error;
          }
        }
        if (operation.startsWith("action.runtime.")) {
          const request = { operation, args, actorId: actor.id } as Parameters<ReturnType<typeof createHostServices>["readAction"]>[0];
          if (["action.runtime.get", "action.runtime.events"].includes(operation)) return read(() => hostServices!.readAction(request));
          const operationId = String(args.operationId), fingerprint = digest({ operation, actorId: actor.id, args });
          const result = transaction(() => {
            const prior = database.prepare("SELECT fingerprint,actor_id,operation,result FROM receipts WHERE operation_id=?").get(operationId);
            if (prior) {
              if (prior.fingerprint !== fingerprint || prior.actor_id !== actor.id || prior.operation !== operation)
                throw new CoreError("CONFLICT", "Global operationId belongs to another request or actor.");
              return JSON.parse(String(prior.result));
            }
            assertOperationAvailable(operationId);
            const value = hostServices!.mutateAction(request);
            commitReceipt(operationId, fingerprint, actor.id, operation, value);
            return value;
          });
          hostServices!.wake();
          return result;
        }
        if (migrationRuntimeDefinitions.some(item => item.id === operation)) {
          return storage.withWorkspaceExclusive(() => migration.dispatch({ operation, args, actorId: actor.id }));
        }
        if (operation.startsWith("manager.")) {
          try {
            const token = managerToken(actor.id);
            if (operation === "manager.chat.artifacts") {
              if (!managerChat) throw new CoreError("NOT_AVAILABLE", "Only pinned SQLite text artifacts are supported.");
              return { mode: "pinned-sqlite-text-artifacts/v1", artifacts: managerChat.readArtifacts(managerOwners.get(token)!, String(args.runId), String(args.freeze)) };
            }
            if (operation === "manager.progress.get") return await managerProgress!.overview(token, args);
            if (operation === "manager.progress.events") return await managerProgress!.events(token, args);
            if (["manager.runtime.start", "manager.runtime.feedback", "manager.runtime.cancel", "manager.progress.feedback"].includes(operation)) {
              if (progressMutations.has(String(args.operationId))) {
                throw new CoreError("BUSY", "Feedback with this operationId is already being validated.");
              }
              const prior = database.prepare("SELECT fingerprint,actor_id,operation,result FROM receipts WHERE operation_id=?").get(String(args.operationId));
              if (prior) {
                if (prior.fingerprint !== digest({ operation, actorId: actor.id, args }) || prior.actor_id !== actor.id || prior.operation !== operation)
                  throw new CoreError("CONFLICT", "Global operationId belongs to a different request or actor.");
                return JSON.parse(String(prior.result));
              }
              assertOperationAvailable(String(args.operationId), !!coding && operation !== "manager.runtime.start");
            }
            if (operation === "manager.progress.feedback") {
              const id = String(args.operationId);
              if (progressMutations.has(id)) throw new CoreError("BUSY", "Feedback with this operationId is already being validated.");
              progressMutations.set(id, { actorId: actor.id, args });
              try { return await managerProgress!.feedback(token, args); }
              finally { progressMutations.delete(id); }
            }
            switch (operation) {
              case "manager.runtime.start": return manager!.start(token, args as never);
              case "manager.runtime.get": return manager!.get(token, args);
              case "manager.runtime.events": return manager!.events(token, args);
              case "manager.runtime.feedback": return manager!.feedback(token, args as never);
              case "manager.runtime.cancel": return manager!.cancel(token, args as never);
              default: throw new CoreError("NOT_FOUND", "Manager recovery and result approval are native-only.");
            }
          } catch (error) {
            if (error instanceof ManagerRuntimeError) throw new CoreError(
              error.code === "UNAUTHORIZED" ? "ACCESS_DENIED" : error.code === "REVISION_CONFLICT" ? "CONFLICT" : error.code, error.message);
            if (error instanceof ManagerProgressError) throw new CoreError(
              error.code === "VERSION_CONFLICT" ? "CONFLICT" : error.code, error.message);
            throw error;
          }
        }
        if (operation.startsWith("chat.turn.")) return dispatchChat(chatTurns!, operation, args, actor);
        if (operation.startsWith("workflow.executor.")) return dispatchWorkflow(workflow!, operation, args, actor,
          database, assertOwner, transaction, commitReceipt, scheduleWorkflow);
        if (operation.startsWith("agent.runtime.")) return dispatchAgent(agentRuntime!, operation, args, actor,
          options.agents!, ownerTokens, ownersByToken, database);
        if (operation.startsWith("knowledge.folder.lifecycle.") || operation === "knowledge.folder.move" || operation === "knowledge.folder.promote-delete"
          || operation.startsWith("sync.apply.") || operation === "sync.apply"
          || operation.startsWith("retrieval.runtime.") || operation === "subscription.materialize.apply") {
          return dispatchData(storage, data, operation, args, actor);
        }
        throw new CoreError("NOT_FOUND", "Native operation is not registered.");
        });
      },
    };
    core = new Core(storage, { modelConfig: options.modelConfig, nativeRuntime: dispatcher, recipeApi: options.recipeApi,
      plugins: options.plugins, runPlugin: track,
      assertAdmission(request) {
        assertOwner();
        assertBatch16UnintegratedClear(database, false, workspaceId, !!batch16Classification, !!batch16Memory, !!originalClassification);
        storage.assertNoPendingLegacyNoteWorkItems();
        const input = request.input as { operation?: string; arguments?: Record<string, unknown> } | undefined;
        const sourceActivity = assertSkillSourceIntegrated(database, !!skillSource);
        if (sourceActivity.active) {
          if (sourceActivity.pending && (request.method !== "capability_call" || input?.operation !== sourceActivity.pending.operation
            || input.arguments?.operationId !== sourceActivity.pending.operationId || request.actor.id !== sourceActivity.pending.actorId))
            throw new CoreError("RECOVERY_REQUIRED", "Canonical Skill source intent requires its identical native-approved retry.", "unknown");
          if (request.method === "capability_call" && (input?.operation === legacySkillSourceOperation || input?.operation === legacySkillSourceRemoveOperation || input?.operation === legacySkillSourceBridgeOperation)) {
            if (!skillSource?.available(request.actor, input.operation))
              throw new CoreError("RECOVERY_AUTHORITY_REQUIRED", "Canonical Skill source retry needs live native authority.", "unknown");
          } else if (request.method === "capability_call" && input?.operation?.startsWith("legacy.skill.router.")) {
            skillSource!.replayLegacy(request.actor);
          } else {
            skillSource!.verify(request.actor);
          }
        }
        if (originalClassification) {
          const checked = originalClassification.verify();
          if (checked.pending && (request.method !== "capability_call" || input?.operation !== LEGACY_CLASSIFICATION_COMMAND_ID
            || input.arguments?.operationId !== checked.pending.request.operationId || request.actor.id !== checked.pending.actor.id))
            throw new CoreError("RECOVERY_REQUIRED", "Original classification requires identical native-approved recovery.", "unknown");
        }
        const memoryLedger = inspectBatch16MemoryLedger(database, workspaceId);
        const memoryPending = memoryLedger.operations.filter(item => item.status === "pending");
        if (memoryPending.length && (memoryPending.length !== 1 || request.method !== "capability_call"
          || input?.operation !== "memory.scope.forget.native"
          || input.arguments?.operationId !== memoryPending[0].operationId || request.actor.id !== memoryPending[0].actorId))
          throw new CoreError("RECOVERY_REQUIRED", "Memory erasure requires identical native-approved recovery.", "unknown");
        if (batch16Classification) {
          const checked = batch16Classification.verify(request.actor);
          if (checked.history.pending && (request.method !== "capability_call"
            || input?.operation !== "knowledge.classification.native-strict.command"
            || input.arguments?.operationId !== checked.history.pending.request.operationId
            || request.actor.id !== checked.history.pending.actor.id))
            throw new CoreError("RECOVERY_REQUIRED", "Classification intent requires its identical native-approved request.", "unknown");
        }
        const inlineIntent = inspectLegacyInlineNoteFence(database);
        const snapshotUnknown = inspectPausedSnapshotJournal(database);
        const skillIntent = inspectBatch15SkillPending(database);
        if (skillIntent) {
          const plan = JSON.parse(String(skillIntent.plan_json));
          if (request.method !== "capability_call" || input?.operation !== `legacy.skill.router.${plan.input.action}`
            || input.arguments?.operationId !== skillIntent.operation_id || request.actor.id !== plan.binding.actorId)
            throw new CoreError("RECOVERY_REQUIRED", "Workspace is fenced by unresolved Skill fixture intent.", "unknown");
          if (!batch15Skills?.available(request.actor, input.operation))
            throw new CoreError("RECOVERY_AUTHORITY_REQUIRED", "Pending Skill outcome needs its live native-owned actor authority.", "unknown");
        } else if (sourceActivity.active) captureBatch15SkillHistory(database, workspaceId);
        else verifyBatch15SkillWorkspace(database, root);
        if (inlineIntent && (!input || input.operation !== inlineIntent.operation
          || input.arguments?.operationId !== inlineIntent.operationId || request.actor.id !== inlineIntent.actor.id))
          throw new CoreError("RECOVERY_REQUIRED", "Workspace is fenced by unresolved inline Note intent.", "unknown");
        if (snapshotUnknown && !["agent.snapshot.confirm-native", "agent.snapshot.cancel-native", "agent.snapshot.restore-get"].includes(input?.operation ?? ""))
          throw new CoreError("RECOVERY_REQUIRED", "Workspace is fenced by unknown native Snapshot effect.", "unknown");
        if (closing || quiescing) throw new CoreError("BUSY", "Native host admission is stopped.");
      },
      legacyReadSnapshot: (operation, args) => captureLegacyKnowledgeReadSnapshot(storage, operation, args),
    });
    if (options.memoryContext && options.data?.retrieval) {
      memoryContext = new MemoryContextService({ ...options.memoryContext, retrieve: dataServices.memoryRetriever() });
    }

    function scheduleWorkflow(actorId: string, runId: string) {
      const work = async () => {
        for (let count = 0; count < 1024; count++) {
          if (closing) return;
          assertOwner();
          const current = workflow!.get(actorId, runId);
          if (current.dispatchMode === "explicit") return;
          if (!["ready", "running"].includes(current.state)) return;
          await workflow!.tick(actorId, runId);
        }
      };
      let task: Promise<void>;
      task = work().catch(() => undefined).finally(() => workflowTasks.delete(task));
      workflowTasks.add(task);
    }

    if (!noteIntentPending && !sharedSourcePending) {
      await dataServices.inspectRecovery();
      await migrationServices.inspectRecovery();
    }
    await storage.recover(async () => {
      if (readMembershipIntent(database, workspaceId) || inspectLegacyInlineNoteFence(database) || inspectPausedSnapshotJournal(database) || inspectBatch15SkillPending(database) || inspectNativeClassificationPending(database)
        || validateLegacyMemoryErasureLedger(database, workspaceId).operations.some(item => item.status === "pending")) return;
      if (noteIntentPending) {
        if (!noteWorkItems) throw new CoreError("RECOVERY_AUTHORITY_REQUIRED",
          "A pending original Note write requires its injected native actor policy.", "unknown");
        await noteWorkItems.recoverPending();
      }
      await dataServices.inspectRecovery();
      await migrationServices.inspectRecovery();
      await storage.withWorkspaceExclusive(async () => {
        read(() => inspectNativeSubscriptionBundles(database, workspaceId));
        read(() => inspectLegacyControlRecovery(database, workspaceId));
        remote?.inspect();
        if (subscription) read(() => inspectRemoteSubscriptionRecovery(database, workspaceId));
        await data.inspectRecovery(); await migration.inspectRecovery();
        await subscriptionBundle?.recoverPending();
        await data.recover(); await migration.recover();
      });
    });
    verifyLegacyNoteWorkItemsWorkspace(database, root);
    if (!inspectLegacyInlineNoteFence(database)) await verifyInlineNoteWorkspace(database, root);
    if (trashLayout) {
      if (remoteRuntimePending(database)) await storage.validateTrash();
      else {
        assertOperationAvailable("native-trash-provision");
        await storage.provisionTrash();
      }
    }
    if (chatTurns && !sharedSourcePending) chatTurns.recover();
    if (!sharedSourcePending) managerChat?.recover();
    if (!sharedSourcePending) approval?.recover();
    if (manager && !sharedSourcePending) {
      for (const row of database.prepare("SELECT actor_id,owner_id,run_id FROM manager_runtime_runs").all()) {
        let token: object;
        try { token = managerToken(String(row.actor_id)); }
        catch { continue; }
        const configuredOwner = managerOwners.get(token)!;
        if (configuredOwner.nativeOwnerId === row.owner_id) {
          const run = manager.recover(token, { runId: String(row.run_id) });
          if (options.manager?.resumeInterrupted && ["paused", "unknown"].includes(run.state)) {
            try {
              const reconciled = options.manager.host.reconcile ? await manager.reconcile(token, { runId: run.runId }) : run;
              if (reconciled.state === "paused") manager.resume(token, { runId: run.runId, expectedVersion: reconciled.version });
            } catch { /* Unresolved effects and invalid contracts remain durably fenced. */ }
          }
        }
      }
    }
    if (workflow && !sharedSourcePending) {
      for (const row of database.prepare("SELECT actor_id,run_id FROM workflow_executor_runs").all() as { actor_id: string; run_id: string }[]) {
        try {
          if (workflow.get(row.actor_id, row.run_id).dispatchMode === "explicit") continue;
          const recovered = workflow.recover(row.actor_id, row.run_id);
          if (["ready", "running"].includes(recovered.state)) scheduleWorkflow(row.actor_id, row.run_id);
        } catch { /* Live leases and unreadable runs remain fenced. */ }
      }
    }
    if (!sharedSourcePending) await hostServices.start();
    if (options.experimentalSubscriptionHost) {
      const profile = options.experimentalSubscriptionHost.profile;
      subscriptionHostIpc = attachNativeSubscriptionHostIpc(root, profile, createNativeSubscriptionProfileService(storage, profile));
    }
    storage.onLeaseLost(error => {
      leaseFailure = error;
      closing = true;
      for (const stop of [() => chatTurns?.close(), () => manager?.close(), () => process?.close(),
        () => options.agents?.host.close?.(), () => workflow?.close(), () => managerChat?.close(), () => hostServices?.close(),
        () => coding?.native.close(), () => portal?.dispose(), closePortalConnections, () => channel?.dispose(), () => remote?.close(), () => subscription?.close(), () => subscriptionBundle?.close(),
        () => options.plugins?.close(), () => subscriptionHostIpc?.close()]) {
        void Promise.resolve().then(stop).catch(() => undefined);
      }
    });
    let closeTask: Promise<void> | undefined;
    return {
      core,
      batch16Memory,
      acquireWorkspaceQuiescence,
      services: { modelProvider, chatTurns, approval, workflow, agentRuntime, manager, managerProgress, managerChat, hostServices, coding, channel, portal, remote, subscription, subscriptionBundle,
        managerToken, process, data: dataServices, migration: migrationServices, memoryContext },
      close() {
        if (closeTask) return closeTask;
        closing = true;
        portal?.dispose();
        closePortalConnections();
        channel?.dispose();
        closeTask = (async () => {
            const stopped = await Promise.allSettled([
              Promise.resolve().then(() => subscriptionHostIpc?.close()),
              Promise.resolve().then(() => chatTurns?.close()), Promise.resolve().then(() => manager?.close()),
              Promise.resolve().then(() => options.agents?.host.close?.()), Promise.resolve().then(() => workflow?.close()),
              Promise.resolve().then(() => process?.close()),
              Promise.resolve().then(() => managerChat?.close()), Promise.resolve().then(() => hostServices?.close()),
              Promise.resolve().then(() => coding?.native.close()), Promise.resolve().then(() => channel?.drain()),
              Promise.resolve().then(() => remote?.close()), Promise.resolve().then(() => subscription?.close()),
              Promise.resolve().then(() => subscriptionBundle?.close()),
              Promise.resolve().then(() => core.closePlugins()),
            ]);
            await Promise.allSettled([...nativeTasks]);
            await Promise.allSettled(workflowTasks);
            const failed = stopped.find(item => item.status === "rejected");
            if (failed?.status === "rejected") throw failed.reason;
            data.close();
            migration.close();
            ownerTokens.clear();
            managerTokens.clear();
            channelTokens.clear();
            channelConnections.clear();
            codingProcess?.close();
            database.close();
          if (leaseFailure) throw leaseFailure;
        })().catch(error => { closeTask = undefined; throw error; });
        return closeTask;
      },
    };
  } catch (error) {
    await subscriptionHostIpc?.close();
    portal?.dispose();
    closePortalConnections();
    closing = true;
    channel?.dispose();
    const stopped = await Promise.allSettled([
      Promise.resolve().then(() => manager?.close()), Promise.resolve().then(() => workflow?.close()),
      Promise.resolve().then(() => process?.close()), Promise.resolve().then(() => chatTurns?.close()),
      Promise.resolve().then(() => options.agents?.host.close?.()),
      Promise.resolve().then(() => managerChat?.close()), Promise.resolve().then(() => hostServices?.close()),
      Promise.resolve().then(() => coding?.native.close()), Promise.resolve().then(() => channel?.drain()),
      Promise.resolve().then(() => remote?.close()), Promise.resolve().then(() => subscription?.close()),
      Promise.resolve().then(() => subscriptionBundle?.close()),
      Promise.resolve().then(() => options.plugins?.close()),
    ]);
    await Promise.allSettled([...nativeTasks]);
    await Promise.allSettled(workflowTasks);
    const undrained = stopped.find(item => item.status === "rejected");
    if (undrained?.status === "rejected") throw undrained.reason;
    data.close();
    migration.close();
    codingProcess?.close();
    database.close();
    throw error;
  }
}

function dispatchChat(service: ChatTurnService, operation: string, args: JsonRecord, actor: Actor) {
  try {
    switch (operation) {
      case "chat.turn.start": return service.start(actor.id, args);
      case "chat.turn.get": return service.get(actor.id, String(args.id));
      case "chat.turn.events": return service.events(actor.id, String(args.id), Number(args.after), Number(args.limit));
      case "chat.turn.cancel": return service.cancel(actor.id, args);
      default: throw new CoreError("NOT_FOUND", "Unknown Chat turn operation.");
    }
  } catch (error) {
    if (error instanceof ChatTurnError) {
      const code = error.code === "NOT_FOUND" ? "NOT_FOUND" : error.code === "UNAUTHORIZED" ? "ACCESS_DENIED" : "INVALID_ARGUMENT";
      throw new CoreError(code, error.code);
    }
    throw error;
  }
}

function dispatchWorkflow(
  executor: WorkflowExecutor, operation: string, args: JsonRecord, actor: Actor, database: DatabaseSync,
  assertOwner: () => void, transaction: <T>(work: () => T) => T,
  commitReceipt: (operationId: string, fingerprint: string, actorId: string, operation: string, result: unknown) => void,
  schedule: (actorId: string, runId: string) => void,
) {
  if (operation === "workflow.executor.get") return readWorkflowExecutor(executor, { operation, actorId: actor.id, args });
  if (operation !== "workflow.executor.create" && operation !== "workflow.executor.cancel") {
    throw new CoreError("NOT_FOUND", "Unknown workflow executor operation.");
  }
  const parsed = workflowExecutorDefinitions.find(item => item.id === operation)!.input.parse(args) as JsonRecord;
  const operationId = String(parsed.operationId);
  const fingerprint = digest({ operation, actorId: actor.id, args: parsed });
  const prior = database.prepare("SELECT fingerprint,actor_id,operation,result FROM receipts WHERE operation_id=?").get(operationId);
  if (prior) {
    if (prior.fingerprint !== fingerprint || prior.actor_id !== actor.id || prior.operation !== operation) {
      throw new CoreError("CONFLICT", "Global operationId belongs to a different request or actor.");
    }
    return JSON.parse(String(prior.result));
  }
  let result!: unknown;
  transaction(() => {
    assertOwner();
    assertGlobalOperationAvailable(database, operationId);
    result = mutateWorkflowExecutor(executor, { operation, actorId: actor.id, args: parsed });
    commitReceipt(operationId, fingerprint, actor.id, operation, result);
  });
  if (operation === "workflow.executor.create") schedule(actor.id, String(parsed.runId));
  else executor.cancel(actor.id, parsed as never);
  return result;
}

function dispatchAgent(
  runtime: ReturnType<typeof createAgentRuntime>, operation: string, args: JsonRecord, actor: Actor,
  config: NonNullable<NativeRuntimeOptions["agents"]>, tokens: Map<string, AgentRuntimeOwnerToken>,
  owners: WeakMap<object, AgentRuntimeOwner>, database: DatabaseSync,
) {
  const tokenForActor = (actorId: string) => {
    let token = tokens.get(actorId);
    if (!token) {
      const owner = config.ownerForActor(actorId);
      if (owner.actorId !== actorId) throw new CoreError("ACCESS_DENIED", "Native Agent owner does not match the authenticated actor.");
      token = Object.freeze({});
      owners.set(token, owner); tokens.set(actorId, token);
    }
    return token;
  };
  try {
    if (operation === "agent.runtime.spawn" || operation === "agent.runtime.cancel") {
      const operationId = String(args.opId);
      const fingerprint = digest({ operation, actorId: actor.id, args });
      const prior = database.prepare("SELECT fingerprint,actor_id,operation,result FROM receipts WHERE operation_id=?").get(operationId);
      if (prior) {
        if (prior.fingerprint !== fingerprint || prior.actor_id !== actor.id || prior.operation !== operation) {
          throw new CoreError("CONFLICT", "Global operationId belongs to a different request or actor.");
        }
        const stored = JSON.parse(String(prior.result)) as { receipt: { rootId: string }; session: unknown };
        return { receipt: stored.receipt, session: runtime.get(tokenForActor(actor.id), { id: stored.receipt.rootId }) };
      }
    }
    switch (operation) {
      case "agent.runtime.spawn": return runtime.spawn(tokenForActor(actor.id), args as never);
      case "agent.runtime.cancel": return runtime.cancel(tokenForActor(actor.id), args as never);
      case "agent.runtime.get": return runtime.get(tokenForActor(actor.id), args);
      case "agent.runtime.list": return runtime.list(tokenForActor(actor.id), args);
      default: throw new CoreError("NOT_FOUND", "Agent reconnect/restore are host-only.");
    }
  } catch (error) {
    if (error instanceof AgentRuntimeError) {
      const code = error.code === "NOT_FOUND" ? "NOT_FOUND" : error.code === "UNAUTHORIZED" ? "ACCESS_DENIED" : "INVALID_ARGUMENT";
      throw new CoreError(code, error.message);
    }
    throw error;
  }
}

function dispatchData(storage: Storage, data: DataRuntime, operation: string, args: JsonRecord, actor: Actor) {
  const request = { operation, args, actorId: actor.id };
  const definition = [...folderLifecycleDefinitions, ...dataRuntimeDefinitions].find(item => item.id === operation);
  if (!definition) throw new CoreError("NOT_FOUND", "Unknown native data operation.");
  return storage.withWorkspaceExclusive(() => definition.readOnly ? data.read(request) : data.mutate(request));
}

function assertGlobalOperationAvailable(database: DatabaseSync, operationId: string) {
  for (const table of globalPendingTables) {
    if (database.prepare(`SELECT 1 FROM ${table}`).get()) {
      throw new CoreError("BUSY", "A different durable workspace intent must be reconciled first.");
    }
  }
  if (!operationId) throw new CoreError("INVALID_ARGUMENT", "Durable operationId is required.");
}

function wrapDataHost(host: DataRuntimeHost, assertOwner: () => void): DataRuntimeHost {
  const retrieval = host.retrieval && {
    ...host.retrieval,
    embedder: {
      ...host.retrieval.embedder,
      async encodeDocuments(texts: readonly string[]) {
        assertOwner();
        const result = await host.retrieval!.embedder.encodeDocuments(texts);
        assertOwner();
        return result;
      },
      async encodeQueries(texts: readonly string[]) {
        assertOwner();
        const result = await host.retrieval!.embedder.encodeQueries(texts);
        assertOwner();
        return result;
      },
    },
    readSources(scope: Parameters<NonNullable<typeof host.retrieval>["readSources"]>[0]) {
      assertOwner();
      return host.retrieval!.readSources(scope);
    },
    authorize(scope: Parameters<NonNullable<typeof host.retrieval>["authorize"]>[0],
      source: Parameters<NonNullable<typeof host.retrieval>["authorize"]>[1],
      action: Parameters<NonNullable<typeof host.retrieval>["authorize"]>[2]) {
      assertOwner();
      return host.retrieval!.authorize(scope, source, action);
    },
  };
  const subscription = host.subscription && {
    authority(actorId: string, source: Parameters<NonNullable<typeof host.subscription>["authority"]>[1]) {
      assertOwner();
      return host.subscription!.authority(actorId, source);
    },
    async nativeAuthorize(authority: Parameters<NonNullable<typeof host.subscription>["nativeAuthorize"]>[0],
      source: Parameters<NonNullable<typeof host.subscription>["nativeAuthorize"]>[1]) {
      assertOwner();
      const result = await host.subscription!.nativeAuthorize(authority, source);
      assertOwner();
      return result;
    },
  };
  return { ...host, ...(retrieval ? { retrieval } : {}), ...(subscription ? { subscription } : {}) };
}
