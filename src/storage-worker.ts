import { parentPort, workerData } from "node:worker_threads";
import { coreDatabasePath } from "./workspace-storage-paths.js";
import { DatabaseSync } from "node:sqlite";
import { join } from "node:path";
import { lstatSync, readFileSync } from "node:fs";
import { CoreError, type StorageRequest } from "./contracts.js";
import { initializeBrowserMutationPins, storageMutationFingerprint, bindBrowserMutationPin, readBrowserMutationReceipt,
  type BrowserMutationReceiptControl } from "./browser-mutation-receipt.js";
import { ExperimentalTodoGenesisFault, assertExperimentalTodoGenesisFaultControl,
  type ExperimentalTodoGenesisFaultControl } from "./original-mcp-todo-genesis-fault.js";
import { ORIGINAL_MCP_TODO_GENESIS_DDL, assertNoPendingOriginalMcpTodoGenesis,
  prepareOriginalMcpTodoGenesisIntent, finalizeOriginalMcpTodoGenesis,
  type OriginalMcpTodoGenesisAdmission } from "./original-mcp-todo-genesis.js";
import { receiveOriginalMcpTodoGenesisSourceControl,
  type OriginalMcpTodoGenesisSourceControl } from "./original-mcp-todo-genesis-source.js";
import { STORAGE_OWNER_DDL } from "./storage-owner-schema.js";
import { capturePlainWorkspaceControls, parseWorkspaceIdentity, validateWorkspace, type PlainWorkspaceControls } from "./workspace-validation.js";
import { classifyStorageStartup } from "./storage-startup-classification.js";
import { openFreshNoteIndex } from "./fresh-note-index-storage.js";
import type { FreshNoteGuardPhase, FreshNoteQueryModel, FreshNoteSource, FreshRootScan } from "./fresh-note-query-contracts.js";
import type { LegacyNotesReadQuery, LegacyNotesReadResult } from "./storage.js";
import { atomicMarkdownWrite, decodeMarkdown, encodeMarkdown, readMarkdown, scanMarkdown, sha256, type MarkdownRecord } from "./markdown.js";
import { atomicBoardWrite, planTodo, scanBoards } from "./boards.js";
import { OriginalTodoAssignmentGate, originalTodoAssignmentRequest,
  type OriginalTodoAssignmentAdmission } from "./original-mcp-todo-assignment-gate.js";
import { OriginalTodoRoleGate, originalTodoRoleStorageRequest, originalTodoRoleOperationId,
  ORIGINAL_TODO_HUMAN_OPERATION, type OriginalTodoRoleAdmission } from "./original-mcp-todo-role-gate.js";
import { originalSdkTodoRoleEvidenceId } from "./original-mcp-sdk-todo-role-provenance.js";
import { commandTodoBoard } from "./domain/todo-board.js";
import { prepareNativeBoardLifecycle, recoverNativeBoardLifecycle } from "./native-board-lifecycle.js";
import { assertNativeBoardWriteTarget, boardLifecycleFingerprint, nativeBoardLifecycleInput, NATIVE_BOARD_LIFECYCLE_OPERATION,
  type NativeBoardLifecycleInput } from "./native-board-lifecycle-state.js";
import { todoDefinitions } from "./todo-definitions.js";
import { documentPath, knowledgeArea } from "./document-path.js";
import { assertEditableDocument, patchKnowledgeMetadata, readKnowledgeMetadata } from "./metadata.js";
import { readDocumentAssets } from "./assets.js";
import { createUploads } from "./uploads.js";
import { readResearch } from "./research.js";
import { researchDefinitions } from "./research-contracts.js";
import { memoryDefinitions } from "./memory-contracts.js";
import { memoryTemporaryId, planMemory, memoryIntentResult, assertMemoryReceiptScope } from "./memory.js";
import { activateOriginalMcpTodoSession, activateOriginalMcpTodoWorker, deactivateOriginalMcpTodoSession,
  assertOriginalMcpTodoSession, originalMcpDomainFile, originalMcpDomainHash, type OriginalMcpTodoSession } from "./original-mcp-domain-state.js";
import { originalMemoryStore, readOriginalMemoryDocument } from "./original-mcp-memory-store.js";
import { atomicFileWrite } from "./file-write.js";
import { assertMemoryScopeActor } from "./memory-scope-continuity.js";
import { activateReadoptedMemoryScope, bindMemoryScopeRevocation, deactivateMemoryScopeContinuity,
  type MemoryScopeContinuityRequest } from "./memory-scope-continuity.js";
import { skillDefinitions } from "./skill-contracts.js";
import { readSkills } from "./skills.js";
import { libraryDefinitions } from "./library-contracts.js";
import { readLibrary } from "./library-reads.js";
import { readMutationScan } from "./mutation-scan.js";
import { noteDefinitions } from "./note-contracts.js";
import { readNotes } from "./notes.js";
import { searchDefinitions } from "./search-contracts.js";
import { readKnowledgeSearch } from "./search.js";
import { buildKnowledgeLinksSnapshot, knowledgeLinksResolveInput, linksDefinitions, LinksSnapshotError, resolveKnowledgeLinks } from "./links.js";
import { knowledgeSnapshot } from "./knowledge-snapshot.js";
import { readSkillRouting, skillRoutingDefinitions } from "./skill-routing.js";
import { readProjectRecipes, projectRecipeDefinitions } from "./project-recipes.js";
import { deserializeResourceLifecyclePlan, planResourceLifecycle, readResourceLifecycle, recoverResourceLifecycle, resourceLifecycleDefinitions, serializeResourceLifecyclePlan } from "./resource-lifecycle.js";
import { readWorkflowCompiler } from "./workflow-compiler.js";
import { workflowCompilerDefinitions } from "./workflow-compiler-contracts.js";
import { deserializeDocumentLifecyclePlan, planDocumentLifecycle, readDocumentLifecycle, recoverDocumentLifecycle, serializeDocumentLifecyclePlan } from "./document-lifecycle.js";
import { documentLifecycleDefinitions } from "./document-lifecycle-contracts.js";
import { subscriptionReadDefinitions } from "./subscription-reads-contracts.js";
import { readSubscriptions } from "./subscription-reads.js";
import { agentSnapshotReadDefinitions } from "./agent-snapshot-reads-contracts.js";
import { readAgentSnapshots } from "./agent-snapshot-reads.js";
import { projectMutationDefinitions } from "./project-mutations-contracts.js";
import { applyProjectMutation, deserializeProjectMutationPlan, planProjectMutation, readProjectMutationPin, recoverProjectMutation, serializeProjectMutationPlan } from "./project-mutations.js";
import { chatSessionDefinitions, CHAT_SESSION_LIMITS, type ChatSessionOperation } from "./chat-session-contracts.js";
import { initializeChatSessionSchema, createChatSessionStore } from "./chat-session-store.js";
import { initializeManagedChatTasks, createManagedChatTaskStore } from "./managed-chat-task-store.js";
import { managedTaskDefinitions } from "./managed-chat-task-contracts.js";
import { assertManagedTaskAdmission, type ManagedTaskWorkerRequest } from "./managed-chat-task-admission.js";
import { workflowRuntimeDefinitions, type WorkflowRuntimeRequest } from "./workflow-runtime-contracts.js";
import { initializeWorkflowRuntime, readWorkflowRuntime, mutateWorkflowRuntime } from "./workflow-runtime.js";
import { syncPlanDefinitions, type SyncPlanCreate, type SyncPlanDecision } from "./sync-plan-contracts.js";
import { initializeSyncPlanStore, SyncPlanStore } from "./sync-plan-store.js";
import { planSync, syncPlanHash } from "./sync-plan.js";
import { collaborationStateDefinitions } from "./collaboration-state-contracts.js";
import { COLLABORATION_STATE_DDL, CollaborationStateError, CollaborationStateStore } from "./collaboration-state.js";
import { actionCompilerDefinitions, type ActionCompilerOperation } from "./action-compiler-contracts.js";
import { readActionCompiler } from "./action-compiler.js";
import { ExecutionStateStore } from "./execution-state.js";
import { RUNTIME_PROCESS_DDL } from "./runtime-process-store.js";
import { ChatTurnStore } from "./chat-turn-store.js";
import { initializeApprovalBridgeSchema } from "./approval-bridge.js";
import { initializeWorkflowExecutor } from "./workflow-executor.js";
import { initializeAgentRuntimeSchema } from "./agent-runtime-store.js";
import { initializeDataRuntime } from "./data-runtime.js";
import { initializeManagerRuntimeSchema } from "./manager-runtime.js";
import { initializeMigrationRuntime } from "./migration-runtime.js";
import { ACTION_RUNTIME_DDL } from "./action-runtime.js";
import { initializeChannelRuntimeSchema } from "./channel-runtime.js";
import { initializeCodingWorkerSchema } from "./coding-worker-workspace.js";
import { initializeRemoteRuntimeSchema, remoteRuntimePending } from "./remote-runtime.js";
import { initializeLegacyControlSchema, inspectLegacyControlRecovery, readLegacyProjectControl,
  readCurrentLegacyProjectSnapshot, legacyProjectDomainDigest, LegacyControlImportError } from "./legacy-control-import.js";
import { checkLegacyProjectCommand, recordLegacyProjectCommand, legacyProjectCommandSchema, LegacyProjectCommandError } from "./legacy-project-command.js";
import { legacyProjectInvocationSchema } from "./host-composition-legacy-project-contracts.js";
import { canonicalJson } from "./domain/project-recipes-workflow-contracts.js";
import { initializeLegacyStateReceiptSchema, readLegacyStateReceipt } from "./host-composition-legacy-state.js";
import { initializePortalLifecycleSchema } from "./portal-lifecycle.js";
import { assertPortalRecoveryClear } from "./host-composition-portal.js";
import { initializeLegacyExtensionJournal } from "./legacy-command-extension-recovery.js";
import { initializeLegacyTrashImport } from "./legacy-trash-import-native.js";
import { recoverNativeLegacyCommands } from "./host-composition-legacy-commands.js";
import { initializeLegacyRecipeTrashJournal } from "./legacy-recipe-trash.js";
import { initializeLegacyNoteWorkItemsSchema } from "./host-composition-legacy-note-workitems.js";
import { initializeLegacySnapshotRestoreSchema } from "./legacy-snapshot-restore.js";
import { LEGACY_INLINE_NOTE_JOURNAL_DDL, inspectLegacyInlineNoteFence } from "./legacy-inline-note-journal.js";
import { LEGACY_SHARED_SOURCE_RECEIPT_DDL } from "./host-composition-legacy-inline-note.js";
import { inspectPausedSnapshotJournal } from "./host-composition-legacy-snapshot-restore.js";
import { readTodoBoard } from "./domain/todo-board.js";
import {
  LEGACY_TODO_BOARD_CREATE_DDL, LEGACY_TODO_BOARD_CREATE_PENDING_OPERATION, inspectLegacyTodoBoardCreateIntent, legacyTodoBoardCreateFingerprint,
  prepareLegacyTodoBoardCreate, recoverLegacyTodoBoardCreate, type LegacyTodoBoardCreateArguments,
} from "./legacy-todo-board-create.js";
import { verifyLegacyKnowledgeRecovery } from "./legacy-knowledge-recovery.js";
import {
  assertLegacyKnowledgeSnapshotAdoptionBootstrap, verifyLegacyKnowledgeSnapshots,
} from "./legacy-knowledge-snapshots.js";
import { verifyLegacyActionArtifacts } from "./legacy-action-artifacts.js";
import { initializeNativeLegacySkillJournal } from "./legacy-skill-lifecycle-native.js";
import { initializeNativeLegacySkillSourceJournal, validateNativeLegacySkillSourceJournalSchema } from "./legacy-skill-source-native.js";
import { assertSkillSourceIntegrated } from "./host-composition-legacy-skill-source.js";
import { BATCH15_SKILL_HISTORY_DDL, inspectBatch15SkillPending, verifyBatch15SkillWorkspace } from "./host-composition-legacy-batch15-skill.js";
import { assertBatch16UnintegratedClear } from "./host-composition-legacy-batch16-fence.js";
import {
  LEGACY_CLASSIFICATION_ADOPTION_DDL, LEGACY_CLASSIFICATION_NATIVE_DDL,
  verifyNativeClassificationAdoptionSchema, verifyNativeClassificationSchema,
} from "./legacy-classification-native.js";
import { LEGACY_MEMORY_ERASURE_DDL, validateLegacyMemoryErasureLedger } from "./legacy-memory-erasure.js";
import { LEGACY_CLASSIFICATION_COMMAND_DDL, verifyLegacyClassificationCommandSchema } from "./legacy-classification-command.js";
import { verifyOriginalRecoveryState, type OriginalRecoveryWorkerAdmission } from "./original-knowledge-recovery-state.js";
import { executeOriginalRecoveryWorker } from "./original-knowledge-recovery-worker.js";
import { nativeTodoUserDdl, nativeTodoUserInput, nativeTodoUiChats, planNativeTodoUser, nativeTodoUserFingerprint,
  prepareNativeTodoUserIntent, assertNativeTodoUserPending, NATIVE_TODO_USER_OPERATION,
  type NativeTodoUserInput, type NativeTodoUiChat } from "./native-todo-user-ui.js";

const workerConfiguration = workerData && typeof workerData === "object" ? workerData as {
  root?: unknown; adoptionPrivacySha256?: unknown;
} : undefined;
const root = typeof workerData === "string" ? workerData : String(workerConfiguration?.root);
const adoptionPrivacySha256 = typeof workerConfiguration?.adoptionPrivacySha256 === "string"
  ? workerConfiguration.adoptionPrivacySha256 : undefined;
const db = new DatabaseSync(coreDatabasePath(root));
const workerWorkspaceId = parseWorkspaceIdentity(readFileSync(join(root, ".pkm-next-workspace"), "utf8")).id;
const workerRootStat = lstatSync(root, { bigint: true });
const workerRootPin = `${workerRootStat.dev}:${workerRootStat.ino}`;
const databaseVersion = Number(db.prepare("PRAGMA user_version").get()!.user_version);
verifyOriginalRecoveryState(db, root, true);
verifyLegacyKnowledgeRecovery(db, root, true);
try { verifyLegacyKnowledgeSnapshots(db, root, true); }
catch (error) {
  if (!adoptionPrivacySha256) throw error;
  assertLegacyKnowledgeSnapshotAdoptionBootstrap(db, root, adoptionPrivacySha256);
}
verifyLegacyActionArtifacts(db, String(JSON.parse(readFileSync(join(root, ".pkm-next-workspace"), "utf8")).id), true);
if (![0, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22, 23, 24, 25, 26, 27, 28].includes(databaseVersion)) throw new Error(`Unsupported workspace database version ${databaseVersion}; no downgrade performed.`);
if (databaseVersion >= 14)
  readLegacyStateReceipt(db, String(JSON.parse(readFileSync(join(root, ".pkm-next-workspace"), "utf8")).id));
if (databaseVersion >= 20) {
  verifyNativeClassificationSchema(db);
  validateLegacyMemoryErasureLedger(db, JSON.parse(readFileSync(join(root, ".pkm-next-workspace"), "utf8")).id);
}
if (databaseVersion >= 21) verifyNativeClassificationAdoptionSchema(db);
if (databaseVersion >= 22) verifyLegacyClassificationCommandSchema(db);
if (databaseVersion >= 23 || db.prepare("SELECT 1 FROM sqlite_master WHERE name GLOB 'legacy_skill_source_native_*' LIMIT 1").get())
  validateNativeLegacySkillSourceJournalSchema(db);
assertBatch16UnintegratedClear(db, true, undefined, true, false, true);
if (databaseVersion >= 19) inspectBatch15SkillPending(db);
db.exec("PRAGMA busy_timeout=3000; PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA foreign_keys=ON;");
db.exec(`
  BEGIN IMMEDIATE;
  CREATE TABLE IF NOT EXISTS documents (
    id TEXT PRIMARY KEY, title TEXT NOT NULL, revision INTEGER NOT NULL,
    deleted INTEGER NOT NULL, sha256 TEXT NOT NULL, path TEXT, area TEXT
  );
  CREATE TABLE IF NOT EXISTS receipts (
    operation_id TEXT PRIMARY KEY, fingerprint TEXT NOT NULL, result TEXT NOT NULL,
    actor_id TEXT NOT NULL, operation TEXT NOT NULL, committed_at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS pending_write (
    singleton INTEGER PRIMARY KEY CHECK(singleton=1), operation_id TEXT NOT NULL,
    fingerprint TEXT NOT NULL, actor_id TEXT NOT NULL, operation TEXT NOT NULL,
    document_id TEXT NOT NULL, before_sha256 TEXT, after_markdown TEXT NOT NULL, document_path TEXT, document_area TEXT, result TEXT
  );
  CREATE TABLE IF NOT EXISTS pending_todo (
    singleton INTEGER PRIMARY KEY CHECK(singleton=1), operation_id TEXT NOT NULL,
    fingerprint TEXT NOT NULL, actor_id TEXT NOT NULL, operation TEXT NOT NULL,
    board_slug TEXT NOT NULL, before_sha256 TEXT, after_json TEXT NOT NULL, result TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS uploads (
    upload_id TEXT PRIMARY KEY, actor_id TEXT NOT NULL, document_id TEXT NOT NULL,
    area TEXT NOT NULL, document_path TEXT NOT NULL, document_revision INTEGER NOT NULL,
    document_sha256 TEXT NOT NULL, name TEXT NOT NULL, size INTEGER NOT NULL, digest TEXT NOT NULL,
    received_bytes INTEGER NOT NULL, status TEXT NOT NULL, result TEXT
  );
  CREATE TABLE IF NOT EXISTS upload_chunks (
    upload_id TEXT NOT NULL REFERENCES uploads(upload_id), offset INTEGER NOT NULL,
    content BLOB NOT NULL, PRIMARY KEY(upload_id,offset)
  );
  CREATE TABLE IF NOT EXISTS pending_asset (
    singleton INTEGER PRIMARY KEY CHECK(singleton=1), operation_id TEXT NOT NULL,
    fingerprint TEXT NOT NULL, actor_id TEXT NOT NULL, operation TEXT NOT NULL,
    upload_id TEXT NOT NULL, content BLOB NOT NULL, result TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS pending_resource (
    singleton INTEGER PRIMARY KEY CHECK(singleton=1), operation_id TEXT NOT NULL,
    fingerprint TEXT NOT NULL, actor_id TEXT NOT NULL, operation TEXT NOT NULL,
    plan TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS pending_document_lifecycle (
    singleton INTEGER PRIMARY KEY CHECK(singleton=1), operation_id TEXT NOT NULL,
    fingerprint TEXT NOT NULL, actor_id TEXT NOT NULL, operation TEXT NOT NULL,
    plan TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS pending_project_mutation (
    singleton INTEGER PRIMARY KEY CHECK(singleton=1), operation_id TEXT NOT NULL,
    fingerprint TEXT NOT NULL, actor_id TEXT NOT NULL, operation TEXT NOT NULL,
    plan TEXT NOT NULL
  );
`);
db.exec(nativeTodoUserDdl);
if (!db.prepare("PRAGMA table_info(documents)").all().some(column => column.name === "path")) db.exec("ALTER TABLE documents ADD COLUMN path TEXT");
if (!db.prepare("PRAGMA table_info(pending_write)").all().some(column => column.name === "document_path")) db.exec("ALTER TABLE pending_write ADD COLUMN document_path TEXT");
if (!db.prepare("PRAGMA table_info(documents)").all().some(column => column.name === "area")) db.exec("ALTER TABLE documents ADD COLUMN area TEXT");
if (!db.prepare("PRAGMA table_info(pending_write)").all().some(column => column.name === "document_area")) db.exec("ALTER TABLE pending_write ADD COLUMN document_area TEXT");
if (!db.prepare("PRAGMA table_info(pending_write)").all().some(column => column.name === "result")) db.exec("ALTER TABLE pending_write ADD COLUMN result TEXT");
if (!db.prepare("PRAGMA table_info(pending_project_mutation)").all().some(column => column.name === "legacy_command")) db.exec("ALTER TABLE pending_project_mutation ADD COLUMN legacy_command TEXT");
initializeLegacyControlSchema(db);
initializeLegacyStateReceiptSchema(db);
initializePortalLifecycleSchema(db);
initializeLegacyExtensionJournal(db);
initializeChatSessionSchema(db);
initializeManagedChatTasks(db);
initializeWorkflowRuntime(db);
initializeSyncPlanStore(db);
initializeBrowserMutationPins(db);
db.exec(COLLABORATION_STATE_DDL);
new ExecutionStateStore(db).initialize();
db.exec(RUNTIME_PROCESS_DDL);
new ChatTurnStore(db, { receipt: () => undefined }).initialize();
initializeApprovalBridgeSchema(db);
initializeWorkflowExecutor(db);
db.exec(LEGACY_TODO_BOARD_CREATE_DDL);
initializeAgentRuntimeSchema(db);
initializeDataRuntime(db);
initializeManagerRuntimeSchema(db);
initializeChannelRuntimeSchema(db);
initializeCodingWorkerSchema(db);
initializeRemoteRuntimeSchema(db);
initializeMigrationRuntime(db);
initializeLegacyTrashImport(db);
initializeLegacyRecipeTrashJournal(db);
initializeLegacyNoteWorkItemsSchema(db);
db.exec(ORIGINAL_MCP_TODO_GENESIS_DDL);
initializeLegacySnapshotRestoreSchema(db);
db.exec(LEGACY_INLINE_NOTE_JOURNAL_DDL);
db.exec(LEGACY_SHARED_SOURCE_RECEIPT_DDL);
db.exec(ACTION_RUNTIME_DDL);
db.exec(STORAGE_OWNER_DDL);
initializeNativeLegacySkillJournal(db);
initializeNativeLegacySkillSourceJournal(db);
db.exec(BATCH15_SKILL_HISTORY_DDL);
db.exec(LEGACY_CLASSIFICATION_NATIVE_DDL);
db.exec(LEGACY_CLASSIFICATION_ADOPTION_DDL);
db.exec(LEGACY_CLASSIFICATION_COMMAND_DDL);
verifyNativeClassificationAdoptionSchema(db);
db.exec(LEGACY_MEMORY_ERASURE_DDL);
db.exec(`PRAGMA user_version=${Math.max(23, databaseVersion)}; COMMIT;`);
const uploads = createUploads(db, root);
const chatSessions = createChatSessionStore(db);
const managedTasks = createManagedChatTaskStore(db, root);
const originalAssignments = new OriginalTodoAssignmentGate(root, db, (actorId, id) =>
  chatSessions.execute({ operation: "chat.session.get", args: { id } }, actorId) as { id: string; revision: number; archivedAt?: string });
const originalRoles = new OriginalTodoRoleGate(root, db, id =>
  chatSessions.execute({ operation: "chat.session.get", args: { id } }, "mcp:external") as { id: string; revision: number; archivedAt?: string });
const syncPlans = new SyncPlanStore(db);
const collaboration = new CollaborationStateStore(db, { initializeSchema: false });
type IndexedDocument = Pick<MarkdownRecord["record"], "id" | "title" | "revision" | "deleted" | "sha256" | "path" | "area">;
let indexedDocuments: IndexedDocument[] | undefined;
function insertDocumentIndex(documents: Iterable<IndexedDocument>): void {
  const insert = db.prepare("INSERT INTO documents(id,title,revision,deleted,sha256,path,area) VALUES(?,?,?,?,?,?,?)");
  for (const record of documents)
    insert.run(record.id, record.title, record.revision, record.deleted ? 1 : 0, record.sha256, record.path, record.area);
}
function reconcileIndex(): MarkdownRecord[] {
  const documents = scanMarkdown(root);
  if (indexedDocuments?.length === documents.length
    && documents.every(({ record }, index) => {
      const previous = indexedDocuments![index]!;
      return record.id === previous.id && record.title === previous.title
        && record.revision === previous.revision && record.deleted === previous.deleted
        && record.sha256 === previous.sha256 && record.path === previous.path && record.area === previous.area;
    })) return documents;
  db.prepare("DELETE FROM documents").run();
  insertDocumentIndex(documents.map(({ record }) => record));
  indexedDocuments = documents.map(({ record }) => ({
    id: record.id, title: record.title, revision: record.revision, deleted: record.deleted,
    sha256: record.sha256, path: record.path, area: record.area,
  }));
  return documents;
}
function normalizedLegacyNoteBoard(raw: string, before: string): string {
  const parsed = JSON.parse(raw), old = JSON.parse(before);
  for (const item of parsed.items) {
    const previous = old.items.find((entry: { id: string }) => entry.id === item.id);
    if (item.history?.length === (previous?.history?.length ?? 0) + 1) item.history[item.history.length - 1].at = "<new-event-time>";
    if (item.comments?.length === (previous?.comments?.length ?? 0) + 1) item.comments[item.comments.length - 1].at = "<new-comment-time>";
  }
  return JSON.stringify(parsed);
}
function assertLegacyNoteIntentRequest(request: StorageRequest, operationId?: string): Record<string, unknown> | undefined {
  const intent = db.prepare("SELECT * FROM legacy_note_workitems_intent WHERE singleton=1").get() as Record<string, unknown> | undefined;
  if (!intent) {
    if (operationId) throw new CoreError("RECOVERY_CONFLICT", "Original Note intent disappeared before canonical Todo dispatch.", "unknown");
    return undefined;
  }
  if (!operationId || operationId !== intent.operation_id || request.actorId !== intent.actor_id) {
    throw new CoreError("BUSY", "A different original Note operation requires exact recovery.", "unknown");
  }
  let args: Record<string, unknown>, requestArgs: Record<string, unknown>;
  try {
    args = JSON.parse(String(intent.native_args)) as Record<string, unknown>;
    requestArgs = JSON.parse(String(intent.request_json)) as Record<string, unknown>;
  } catch { throw new CoreError("RECOVERY_CONFLICT", "Original Note intent envelope is malformed.", "unknown"); }
  if (intent.native_operation !== request.operation || JSON.stringify(args) !== JSON.stringify(request.args)
    || args.operationId !== intent.operation_id
    || ![ "legacy.note.workitems.command", "legacy.note.workitems.upsert" ].includes(String(intent.operation))
    || requestArgs.operationId !== intent.operation_id || requestArgs.slug !== args.board_slug) {
    throw new CoreError("RECOVERY_CONFLICT", "Canonical Todo request does not match the exact original Note intent.", "unknown");
  }
  const definition = todoDefinitions.find(item => item.id === request.operation && !item.readOnly);
  if (!definition || !definition.input.safeParse(args).success) {
    throw new CoreError("RECOVERY_CONFLICT", "Original Note intent does not name a strict native Todo mutation.", "unknown");
  }
  return intent;
}
function assertLegacyNoteRecoveryEnvelope(operationId?: string) {
  const intent = db.prepare("SELECT * FROM legacy_note_workitems_intent WHERE singleton=1").get() as Record<string, unknown> | undefined;
  if (!intent) {
    if (operationId) throw new CoreError("RECOVERY_CONFLICT", "Original Note recovery identity is stale.", "unknown");
    return;
  }
  if (!operationId || operationId !== intent.operation_id) {
    throw new CoreError("RECOVERY_AUTHORITY_REQUIRED", "Original Note recovery requires its exact native operation and actor.", "unknown");
  }
  const pending = db.prepare("SELECT * FROM pending_todo WHERE singleton=1").get() as Record<string, unknown> | undefined;
  if (pending && (pending.operation_id !== intent.operation_id || pending.actor_id !== intent.actor_id
    || pending.operation !== intent.native_operation)) {
    throw new CoreError("RECOVERY_CONFLICT", "Native Todo intent conflicts with the original Note recovery envelope.", "unknown");
  }
  for (const table of ["pending_write", "pending_asset", "pending_resource", "pending_document_lifecycle",
    "pending_project_mutation", "data_runtime_intents", "migration_runtime_intents"]) {
    if (db.prepare(`SELECT 1 FROM ${table} LIMIT 1`).get()) {
      throw new CoreError("RECOVERY_CONFLICT", "Another native workspace intent conflicts with original Note recovery.", "unknown");
    }
  }
}
function recoverPending(legacyNoteOperationId?: string) {
  verifyOriginalRecoveryState(db, root);
  assertNoPendingOriginalMcpTodoGenesis(db);
  const assignmentPending = db.prepare("SELECT * FROM pending_todo WHERE singleton=1").get();
  if (assignmentPending) originalAssignments.pending(assignmentPending, activeRuntimeOwner ?? {});
  inspectLegacyTodoBoardCreateIntent(db, root);
  assertLegacyNoteRecoveryEnvelope(legacyNoteOperationId);
  const documentLifecycle = db.prepare("SELECT * FROM pending_document_lifecycle WHERE singleton=1").get();
  if (documentLifecycle?.operation === NATIVE_BOARD_LIFECYCLE_OPERATION) {
    recoverNativeBoardLifecycle(db, root);
    reconcileIndex();
  } else if (documentLifecycle) {
    const plan = deserializeDocumentLifecyclePlan(String(documentLifecycle.plan));
    if (plan.operationId !== String(documentLifecycle.operation_id) || plan.actorId !== String(documentLifecycle.actor_id)
      || String(documentLifecycle.operation) !== "knowledge.document.move") {
      throw new CoreError("INVALID_WORKSPACE", "Pending document lifecycle identity disagrees; preserve the journal for reconciliation.");
    }
    const result = recoverDocumentLifecycle(root, plan, String(documentLifecycle.operation_id));
    reconcileIndex();
    db.prepare("INSERT INTO receipts VALUES(?,?,?,?,?,?)").run(
      String(documentLifecycle.operation_id), String(documentLifecycle.fingerprint), JSON.stringify(result),
      String(documentLifecycle.actor_id), String(documentLifecycle.operation), new Date().toISOString(),
    );
    db.prepare("DELETE FROM pending_document_lifecycle WHERE singleton=1").run();
  }
  const resource = db.prepare("SELECT * FROM pending_resource WHERE singleton=1").get();
  if (resource) {
    const plan = deserializeResourceLifecyclePlan(String(resource.plan));
    if (plan.operationId !== String(resource.operation_id) || plan.actorId !== String(resource.actor_id)
      || String(resource.operation) !== `knowledge.asset.${plan.result.action}`) {
      throw new CoreError("INVALID_WORKSPACE", "Pending resource identity disagrees; preserve the journal for reconciliation.");
    }
    const result = recoverResourceLifecycle(root, plan, String(resource.operation_id));
    db.prepare("INSERT INTO receipts VALUES(?,?,?,?,?,?)").run(
      String(resource.operation_id), String(resource.fingerprint), JSON.stringify(result),
      String(resource.actor_id), String(resource.operation), new Date().toISOString(),
    );
    db.prepare("DELETE FROM pending_resource WHERE singleton=1").run();
  }
  uploads.recover();
  const todo = db.prepare("SELECT * FROM pending_todo WHERE singleton=1").get();
  if (todo) {
    originalRoles.withinPending(todo, activeRuntimeOwner ?? {}, checkRole => {
    assertNativeTodoUserPending(db, todo);
    const slug = String(todo.board_slug), raw = String(todo.after_json);
    assertOriginalMcpTodoSession(root, String(todo.actor_id), db, slug);
    originalAssignments.pending(todo, activeRuntimeOwner ?? {});
    recoverLegacyTodoBoardCreate(db, root);
    checkRole();
    if (scanBoards(root, db).get(slug)?.raw !== raw) atomicBoardWrite(root, slug, raw, todo.before_sha256 === null ? null : String(todo.before_sha256), db);
    checkRole();
    originalAssignments.pending(todo, activeRuntimeOwner ?? {});
    db.prepare("INSERT INTO receipts VALUES(?,?,?,?,?,?)").run(
      String(todo.operation_id), String(todo.fingerprint), String(todo.result),
      String(todo.actor_id), todo.operation === LEGACY_TODO_BOARD_CREATE_PENDING_OPERATION ? "todo.board.create" : String(todo.operation), new Date().toISOString(),
    );
    const noteIntent = db.prepare("SELECT * FROM legacy_note_workitems_intent WHERE operation_id=?")
      .get(String(todo.operation_id)) as Record<string, unknown> | undefined;
    if (noteIntent) {
      if (!legacyNoteOperationId || legacyNoteOperationId !== noteIntent.operation_id
        || String(todo.operation) !== String(noteIntent.native_operation)
        || String(todo.actor_id) !== String(noteIntent.actor_id)
        || String(todo.fingerprint) !== String(db.prepare("SELECT fingerprint FROM receipts WHERE operation_id=?")
          .get(String(todo.operation_id))?.fingerprint)) {
        throw new CoreError("RECOVERY_CONFLICT", "Native Todo finalization is not authorized by the exact original Note intent.", "unknown");
      }
      const request = JSON.parse(String(noteIntent.native_args)) as Record<string, unknown>;
      const intentBefore = String(noteIntent.before_json), expected = String(noteIntent.expected_json);
      if (JSON.stringify(request) !== JSON.stringify(JSON.parse(String(noteIntent.native_args)))
        || request.operationId !== noteIntent.operation_id || request.board_slug !== todo.board_slug) {
        throw new CoreError("RECOVERY_CONFLICT", "Original Note native arguments disagree with the pending Todo board.", "unknown");
      }
      const finalBoard = scanBoards(root, db).get(String(todo.board_slug))?.raw;
      if (!finalBoard || normalizedLegacyNoteBoard(finalBoard, intentBefore) !== expected) {
        throw new CoreError("RECOVERY_CONFLICT", "Native Todo effects differ from the pinned original Note effect.", "unknown");
      }
      const snapshot = readTodoBoard(finalBoard);
      const bridgeResult = JSON.stringify({ ok: true, ...snapshot });
      db.prepare(`INSERT INTO legacy_note_workitems_native_binding VALUES(?,?,?,?,?,?,?,?,?,?)`).run(
        String(noteIntent.operation_id), String(noteIntent.fingerprint), String(noteIntent.actor_id), String(noteIntent.operation),
        String(noteIntent.request_json), String(todo.fingerprint), String(todo.actor_id), String(todo.operation),
        String(todo.result), bridgeResult,
      );
    }
    db.prepare("DELETE FROM pending_todo WHERE singleton=1").run();
    });
  }
  const pending = db.prepare("SELECT * FROM pending_write WHERE singleton=1").get();
  if (!pending) return;
  const id = String(pending.document_id), raw = String(pending.after_markdown);
  const path = pending.document_path === null ? `${id}.md` : String(pending.document_path);
  const parsedArea = knowledgeArea.safeParse(pending.document_area ?? "notes");
  if (!parsedArea.success) throw new CoreError("INVALID_WORKSPACE", "Pending write has an invalid knowledge storage area; preserve the journal for reconciliation.");
  const area = parsedArea.data;
  const after = decodeMarkdown(id, raw, path, area);
  const memory = String(pending.operation).startsWith("memory.record.");
  const privateMemory = memory && originalMemoryStore(root);
  if (privateMemory) assertMemoryScopeActor(root, String(pending.actor_id));
  if (memory && (area !== "notes" || pending.result === null
    || JSON.stringify(memoryIntentResult(root, after, String(pending.operation), String(pending.operation_id))) !== String(pending.result))) {
    throw new CoreError("INVALID_WORKSPACE", "Pending memory state/result disagrees; preserve the journal for reconciliation.");
  }
  const current = privateMemory ? readOriginalMemoryDocument(root, id, path) : readMarkdown(root, id, path, area);
  if (current?.record.sha256 !== after.record.sha256) {
    if (privateMemory) atomicFileWrite(originalMcpDomainFile(root, "memory", id), raw,
      pending.before_sha256 === null ? null : String(pending.before_sha256), memoryTemporaryId(String(pending.operation_id)));
    else atomicMarkdownWrite(root, id, raw, pending.before_sha256 === null ? null : String(pending.before_sha256), path, area,
      memory ? memoryTemporaryId(String(pending.operation_id)) : String(pending.operation_id));
  }
  db.prepare("INSERT INTO receipts VALUES(?,?,?,?,?,?)").run(
    String(pending.operation_id), String(pending.fingerprint), memory ? String(pending.result) : JSON.stringify(after.record),
    String(pending.actor_id), String(pending.operation), new Date().toISOString(),
  );
  db.prepare("DELETE FROM pending_write WHERE singleton=1").run();
}
function recoverProjectIntent() {
  if (db.isTransaction) throw new CoreError("TRANSACTION_BOUNDARY", "Project filesystem recovery must run outside SQLite transactions.", "unknown");
  const pending = db.prepare("SELECT * FROM pending_project_mutation WHERE singleton=1").get();
  if (!pending) return;
  const plan = deserializeProjectMutationPlan(String(pending.plan));
  const legacy = pending.legacy_command === null ? undefined : legacyProjectCommandSchema.parse(JSON.parse(String(pending.legacy_command)));
  if (plan.operationId !== String(pending.operation_id) || plan.actorId !== String(pending.actor_id)
    || plan.operation !== (legacy ? "project.update" : String(pending.operation))
    || legacy && (pending.operation !== "project.legacy.command" || legacy.operation !== "project.update")) {
    throw new CoreError("INVALID_WORKSPACE", "Pending Project mutation identity disagrees; preserve the journal for reconciliation.");
  }
  const documents = scanMarkdown(root);
  let outcome = recoverProjectMutation(root, plan, documents);
  if (outcome.state === "missing") outcome = applyProjectMutation(root, plan, documents);
  if (outcome.state !== "complete") {
    throw new CoreError("RECOVERY_CONFLICT", outcome.state === "unknown" ? outcome.reason : "Project mutation remains missing.", "unknown");
  }
  assertWorkerOwner(activeRuntimeOwner);
  const legacySnapshot = legacy ? readCurrentLegacyProjectSnapshot(db, plan.workspaceId) : undefined;
  transaction(() => {
    const currentPending = db.prepare("SELECT * FROM pending_project_mutation WHERE singleton=1").get();
    if (JSON.stringify(currentPending) !== JSON.stringify(pending)) {
      throw new CoreError("RECOVERY_CONFLICT", "Project intent changed during filesystem recovery.", "unknown");
    }
    let receiptResult: unknown = outcome.result;
    if (legacy && legacySnapshot) {
      const storeVersion = recordLegacyProjectCommand(db, plan.workspaceId, legacy, {
        entityId: outcome.result.entityId, canonicalDigest: legacyProjectDomainDigest(legacySnapshot),
      });
      receiptResult = { snapshot: legacySnapshot, entityId: outcome.result.entityId, replayed: false, storeVersion };
    }
    db.prepare("INSERT INTO receipts VALUES(?,?,?,?,?,?)").run(
      String(pending.operation_id), String(pending.fingerprint), JSON.stringify(receiptResult),
      String(pending.actor_id), String(pending.operation), new Date().toISOString(),
    );
    db.prepare("DELETE FROM pending_project_mutation WHERE singleton=1").run();
  });
  if (legacy) inspectLegacyControlRecovery(db, plan.workspaceId);
}
let activeRuntimeOwner: { ownerId?: string; fence?: number } | undefined;
function transaction<T>(action: () => T): T {
  assertWorkerOwner(activeRuntimeOwner);
  db.exec("BEGIN IMMEDIATE");
  try {
    const result = action();
    assertWorkerOwner(activeRuntimeOwner);
    db.exec("COMMIT");
    return result;
  }
  catch (error) {
    if (db.isTransaction) db.exec("ROLLBACK");
    throw error;
  }
}
function executeBatch04(request: StorageRequest): unknown {
  const { operation, args, actorId } = request;
  const definition = [...chatSessionDefinitions, ...workflowRuntimeDefinitions, ...syncPlanDefinitions,
    ...collaborationStateDefinitions, ...actionCompilerDefinitions].find(item => item.id === operation);
  if (!definition) throw new CoreError("NOT_FOUND", "Unknown operation.");
  const dispatch = () => {
    if (chatSessionDefinitions.some(item => item.id === operation))
      return chatSessions.execute({ operation: operation as ChatSessionOperation, args }, actorId);
    if (workflowRuntimeDefinitions.some(item => item.id === operation)) {
      const workflow = { operation, args, actorId } as WorkflowRuntimeRequest & { actorId: string };
      return definition.readOnly ? readWorkflowRuntime(db, workflow)
        : mutateWorkflowRuntime(root, db, workflow, scanMarkdown(root));
    }
    if (actionCompilerDefinitions.some(item => item.id === operation))
      return readActionCompiler({ operation: operation as ActionCompilerOperation, args });
    if (syncPlanDefinitions.some(item => item.id === operation)) {
      try {
        if (operation === "sync.plan") return planSync(args as unknown as Parameters<typeof planSync>[0]);
        if (operation === "sync.plan.create") {
          const result = syncPlans.create({ ...args, actorId } as SyncPlanCreate);
          db.prepare("INSERT INTO sync_plan_owners VALUES(?,?)").run(String(args.sessionId), actorId);
          return result;
        }
        const owner = db.prepare("SELECT actor_id FROM sync_plan_owners WHERE session_id=?").get(String(args.sessionId));
        if (!owner || owner.actor_id !== actorId) throw new CoreError("NOT_FOUND", "Sync plan session not found.");
        if (operation === "sync.plan.get") return syncPlans.get(String(args.sessionId));
        return syncPlans.decide({ ...args, actorId } as SyncPlanDecision);
      } catch (error) {
        if (error instanceof CoreError) throw error;
        if (!(error instanceof Error) || /database is locked|database is busy|SQLITE_/i.test(error.message)) throw error;
        const conflict = /Session already exists|revision mismatch|operationId reused/.test(error.message);
        const missing = /Session not found|Conflict not found/.test(error.message);
        throw new CoreError(conflict ? "CONFLICT" : missing ? "NOT_FOUND" : "INVALID_ARGUMENT", error.message);
      }
    }
    const actor = { actorId, kind: request.collaborationKind ?? "agent" };
    if (operation === "collaboration.state.list") return collaboration.list(actor, args);
    if (operation === "collaboration.state.read") return collaboration.read(actor, String(args.roomId));
    return collaboration.leave(actor, args as unknown as Parameters<typeof collaboration.leave>[1]);
  };
  if (definition.readOnly) {
    assertWorkerOwner(activeRuntimeOwner);
    db.exec("BEGIN");
    try {
      const result = dispatch();
      assertWorkerOwner(activeRuntimeOwner);
      db.exec("COMMIT");
      return result;
    }
    catch (error) { if (db.isTransaction) db.exec("ROLLBACK"); throw error; }
  }
  const fingerprint = storageMutationFingerprint({ operation, actorId, args, collaborationKind: request.collaborationKind }, "batch04");
  return transaction(() => {
    recoverPending();
    const prior = db.prepare("SELECT fingerprint,result FROM receipts WHERE operation_id=?").get(String(args.operationId));
    if (prior) {
      if (prior.fingerprint !== fingerprint) throw new CoreError("CONFLICT", "operationId belongs to a different request or actor.");
      return JSON.parse(String(prior.result));
    }
    const result = dispatch();
    if (!definition.output.safeParse(result).success) throw new CoreError("INVALID_RESULT", "Mutation result violates its contract; rolled back.");
    db.prepare("INSERT INTO receipts VALUES(?,?,?,?,?,?)").run(String(args.operationId), fingerprint, JSON.stringify(result), actorId, operation, new Date().toISOString());
    return result;
  });
}
function executeManagedTask(request: ManagedTaskWorkerRequest, owner: { ownerId?: string; fence?: number }) {
  const definition = managedTaskDefinitions.find(item => item.id === request.operation);
  if (!definition) throw new CoreError("NOT_FOUND", "Unknown canonical Task operation.");
  const args = definition.input.parse(request.args), actorId = request.admission.guard.actorId;
  const fingerprint = syncPlanHash({ operation: request.operation, args, actorId,
    taskId: request.admission.guard.taskId, attemptId: request.admission.guard.attemptId,
    requestId: request.admission.guard.requestId });
  const result = transaction(() => {
    recoverPending();
    managedTasks.guard(request.admission, owner, request.operation, args);
    if (!definition.readOnly) {
      const prior = db.prepare("SELECT fingerprint,result FROM receipts WHERE operation_id=?").get(String((args as Record<string, unknown>).operationId));
      if (prior) {
        if (prior.fingerprint !== fingerprint) throw new CoreError("CONFLICT", "The operationId belongs to another Task request or actor.");
        assertManagedTaskAdmission(db, root, request.admission, owner, request.operation);
        return JSON.parse(String(prior.result));
      }
    }
    let value: unknown;
    try { value = managedTasks.execute(request.operation, args, request.admission); }
    catch (error) {
      if (error instanceof CoreError || !(error instanceof Error) || /SQLITE_|database is locked|database is busy/.test(error.message)) throw error;
      throw new CoreError("INVALID_ARGUMENT", error.message);
    }
    if (!definition.output.safeParse(value).success)
      throw new CoreError("INVALID_RESULT", "Canonical Task result violated its contract; the transaction was rolled back.");
    if (!definition.readOnly) db.prepare("INSERT INTO receipts VALUES(?,?,?,?,?,?)")
      .run(String((args as Record<string, unknown>).operationId), fingerprint, JSON.stringify(value), actorId, request.operation, new Date().toISOString());
    assertManagedTaskAdmission(db, root, request.admission, owner, request.operation);
    return value;
  });
  if (request.operation === "chat.task.cancel") Atomics.store(new Int32Array(request.admission.attemptRevocation), 0, 1);
  return result;
}
function execute(request: StorageRequest, legacyNoteOperationId?: string): unknown {
  const { operation, args, actorId, collaborationKind } = request;
  if (operation.startsWith("chat.task."))
    throw new CoreError("NATIVE_AUTHORITY_REQUIRED", "Generic requests cannot synthesize managed Task native admission.");
  assertLegacyNoteIntentRequest(request, legacyNoteOperationId);
  if ([...chatSessionDefinitions, ...workflowRuntimeDefinitions, ...syncPlanDefinitions,
    ...collaborationStateDefinitions, ...actionCompilerDefinitions].some(item => item.id === operation))
    return executeBatch04({ operation, args, actorId, collaborationKind });
  if (operation === "project.legacy.command") return executeLegacyProjectCommand({ operation, args, actorId });
  if (operation === "project.mutation.pin" || projectMutationDefinitions.some(item => item.id === operation)) return executeProjectMutation({ operation, args, actorId });
  if (documentLifecycleDefinitions.some(item => item.id === operation)) return executeDocumentLifecycle({ operation, args, actorId });
  if (resourceLifecycleDefinitions.some(item => item.id === operation)) return executeResourceLifecycle({ operation, args, actorId });
  if (operation.startsWith("knowledge.upload.")) return executeUpload({ operation, args, actorId });
  if (operation.startsWith("todo.")) return executeTodo(request, legacyNoteOperationId);
  const fingerprint = storageMutationFingerprint({ operation, actorId, args });
  const mutation = !["knowledge.document.get", "knowledge.document.list", "knowledge.metadata.get", "knowledge.asset.list", "knowledge.asset.get", "knowledge.mutation.scan",
    ...researchDefinitions.map(item => item.id), ...skillDefinitions.map(item => item.id), ...libraryDefinitions.map(item => item.id), ...noteDefinitions.map(item => item.id),
    ...searchDefinitions.map(item => item.id), ...linksDefinitions.map(item => item.id), ...skillRoutingDefinitions.map(item => item.id),
    ...projectRecipeDefinitions.map(item => item.id), ...workflowCompilerDefinitions.map(item => item.id)].includes(operation);
  const prepared = transaction(() => {
    assertLegacyNoteIntentRequest(request, legacyNoteOperationId);
    recoverPending(legacyNoteOperationId);
    if (mutation) {
      const receipt = db.prepare("SELECT fingerprint,result FROM receipts WHERE operation_id=?").get(String(args.operationId));
      if (receipt) {
        if (receipt.fingerprint !== fingerprint) throw new CoreError("CONFLICT", "operationId was already used for a different request or actor.");
        return { result: JSON.parse(String(receipt.result)) };
      }
    }
    const documents = reconcileIndex();
    const workflowDefinition = workflowCompilerDefinitions.find(item => item.id === operation);
    if (workflowDefinition) return { result: readWorkflowCompiler(root, { operation: workflowDefinition.id, args }, documents) };
    if (projectRecipeDefinitions.some(item => item.id === operation)) return { result: readProjectRecipes(root, { operation, args, actorId }, documents) };
    if (operation === "knowledge.links.resolve") {
      try {
        return { result: resolveKnowledgeLinks(buildKnowledgeLinksSnapshot({
          notes: knowledgeSnapshot(root, documents, "notes", "Note"),
          skills: knowledgeSnapshot(root, documents, "skills", "Skill"),
          research: knowledgeSnapshot(root, documents, "papers", "Research"),
        }), knowledgeLinksResolveInput.parse(args)) };
      } catch (error) {
        if (!(error instanceof LinksSnapshotError)) throw error;
        throw new CoreError(error.code === "SNAPSHOT_MISMATCH" ? "CONFLICT"
          : error.code === "BUSY" ? "BUSY" : "INVALID_DOCUMENT", error.message);
      }
    }
    if (searchDefinitions.some(item => item.id === operation)) return { result: readKnowledgeSearch(root, documents, { operation, args, actorId }) };
    if (skillRoutingDefinitions.some(item => item.id === operation)) return { result: readSkillRouting(root, documents, { operation, args, actorId }) };
    if (operation.startsWith("knowledge.research.")) return { result: readResearch(root, documents, { operation, args, actorId }) };
    if (operation.startsWith("knowledge.skill.")) return { result: readSkills(root, documents, { operation, args, actorId }) };
    if (operation.startsWith("knowledge.library.")) return { result: readLibrary(root, { operation, args }) };
    if (operation === "knowledge.mutation.scan") return { result: readMutationScan(root) };
    if (operation.startsWith("knowledge.note.")) return { result: readNotes(root, documents, { operation, args, actorId }, db) };
    if (operation === "knowledge.document.list") {
      const workspaceRevision = sha256(JSON.stringify(documents.map(({ record }) => [record.id, record.area, record.path, record.sha256])));
      if (args.workspaceRevision !== undefined && args.workspaceRevision !== workspaceRevision) throw new CoreError("CONFLICT", "Workspace changed; restart pagination.");
      const items = documents.map(({ record }) => record).filter(record => (args.includeDeleted || !record.deleted) && (args.area === undefined || args.area === record.area));
      const page = items.slice(Number(args.offset), Number(args.offset) + Number(args.limit)).map(({ content: _content, ...record }) => record);
      const next = Number(args.offset) + page.length;
      return { result: { items: page, total: items.length, nextOffset: next < items.length ? next : null, workspaceRevision } };
    }
    const before = documents.find(({ record, metadata }) => record.id === args.id || metadata.get("knowledgeId") === args.id);
    if (!mutation) {
      if (!before) throw new CoreError("NOT_FOUND", "Document not found.");
      if (operation.startsWith("knowledge.asset.")) return { result: readDocumentAssets(root, before, { operation, args, actorId }) };
      return { result: operation === "knowledge.metadata.get" ? readKnowledgeMetadata(before) : before.record };
    }
    if (operation === "knowledge.document.create") {
      if (before) throw new CoreError("CONFLICT", "Document ID already exists.");
    } else {
      if (!before) throw new CoreError("NOT_FOUND", "Document not found.");
      assertEditableDocument(root, before);
      if (before.record.revision !== args.expectedRevision || before.record.sha256 !== args.expectedSha256) throw new CoreError("CONFLICT", "Document revision or Markdown digest changed; reread before writing.");
      if (before.record.revision === Number.MAX_SAFE_INTEGER) throw new CoreError("CONFLICT", "Document revision exhausted.");
      if (["knowledge.document.update", "knowledge.metadata.update"].includes(operation) && before.record.deleted) throw new CoreError("CONFLICT", "Restore the document before editing.");
      if (operation === "knowledge.document.trash" && before.record.deleted) throw new CoreError("CONFLICT", "Already trashed.");
      if (operation === "knowledge.document.restore" && !before.record.deleted) throw new CoreError("CONFLICT", "Not trashed.");
    }
    const path = before?.record.path ?? String(args.path ?? `${args.id}.md`);
    const parsedArea = knowledgeArea.safeParse(args.area ?? "notes");
    if (!parsedArea.success) throw new CoreError("INVALID_ARGUMENT", "Invalid knowledge storage area.");
    const area = before?.record.area ?? parsedArea.data;
    if (area === "notes") assertNativeBoardWriteTarget(root, path, db);
    if (!documentPath.safeParse(path).success) throw new CoreError("INVALID_ARGUMENT", "Invalid relative Markdown path.");
    if (path.split("/")[0].toLowerCase() === "system") throw new CoreError("ACCESS_DENIED", "System Notes are read-only.");
    if (!before && documents.some(item => item.record.area === area && item.record.path === path)) throw new CoreError("CONFLICT", "A Markdown document already exists at the requested path.");
    if (!before && readMarkdown(root, String(args.id), path, area)) throw new CoreError("CONFLICT", "The requested filesystem path already exists, including platform case aliases.");
    const editing = operation === "knowledge.document.create" || operation === "knowledge.document.update";
    const previous = operation === "knowledge.metadata.update" ? patchKnowledgeMetadata(before!, args.set, args.remove) : before;
    const id = before?.record.id ?? String(args.id);
    const raw = encodeMarkdown(
      id, editing ? String(args.title) : before!.record.title,
      editing ? String(args.content) : before!.record.content,
      before ? before.record.revision + 1 : 1,
      operation === "knowledge.document.trash", previous, path, area,
    );
    db.prepare("INSERT INTO pending_write(singleton,operation_id,fingerprint,actor_id,operation,document_id,before_sha256,after_markdown,document_path,document_area) VALUES(1,?,?,?,?,?,?,?,?,?)").run(
      String(args.operationId), fingerprint, actorId, operation, id, before?.record.sha256 ?? null, raw, path, area,
    );
    return { pending: true };
  });
  if ("result" in prepared) return prepared.result;
  // The committed intent bridges SQLite and the atomic Markdown replacement.
  try {
    return transaction(() => {
      recoverPending(legacyNoteOperationId);
      reconcileIndex();
      const receipt = db.prepare("SELECT result FROM receipts WHERE operation_id=?").get(String(args.operationId));
      if (!receipt) throw new CoreError("STORAGE_ERROR", "Committed intent has no receipt; reconcile before retrying.", "unknown");
      return JSON.parse(String(receipt.result));
    });
  } catch (error) {
    // Another process may already have finalized our committed intent.
    if (error instanceof CoreError) throw new CoreError(error.code, error.message, "unknown");
    const busy = error instanceof Error && /database is locked|database is busy/.test(error.message);
    throw new CoreError(busy ? "BUSY" : "STORAGE_ERROR", `A write intent was committed; retry only the same operationId. ${error instanceof Error ? error.message : String(error)}`, "unknown");
  }
}

function executeProjectMutation(request: StorageRequest): unknown {
  const { operation, args, actorId } = request;
  const fingerprint = storageMutationFingerprint({ operation, actorId, args });
  const prepared = transaction(() => {
    recoverPending();
    if (operation === "project.mutation.pin") return { result: readProjectMutationPin(root, { operation, args, actorId }) };
    const workspaceId = String(JSON.parse(readFileSync(join(root, ".pkm-next-workspace"), "utf8")).id);
    if (readLegacyProjectControl(db, workspaceId)) throw new CoreError("LEGACY_COMMAND_REQUIRED", "Imported original Project control requires explicit legacy command admission.");
    const definition = projectMutationDefinitions.find(item => item.id === operation);
    if (!definition) throw new CoreError("NOT_FOUND", "Unknown Project mutation.");
    const receipt = db.prepare("SELECT fingerprint,result FROM receipts WHERE operation_id=?").get(String(args.operationId));
    if (receipt) {
      if (receipt.fingerprint !== fingerprint) throw new CoreError("CONFLICT", "operationId belongs to a different request or actor.");
      return { result: JSON.parse(String(receipt.result)) };
    }
    const plan = planProjectMutation(root, { operation: definition.id, args, actorId }, reconcileIndex());
    db.prepare("INSERT INTO pending_project_mutation(singleton,operation_id,fingerprint,actor_id,operation,plan) VALUES(1,?,?,?,?,?)").run(
      String(args.operationId), fingerprint, actorId, operation, serializeProjectMutationPlan(plan),
    );
    return { pending: true };
  });
  if ("result" in prepared) return prepared.result;
  try {
    recoverProjectIntent();
    return transaction(() => {
      recoverPending();
      const receipt = db.prepare("SELECT result FROM receipts WHERE operation_id=?").get(String(args.operationId));
      if (!receipt) throw new CoreError("STORAGE_ERROR", "Committed Project mutation intent has no receipt.", "unknown");
      return JSON.parse(String(receipt.result));
    });
  } catch (error) {
    throw new CoreError(error instanceof CoreError ? error.code : "STORAGE_ERROR",
      `Project mutation intent committed; retry only the same operationId. ${error instanceof Error ? error.message : String(error)}`, "unknown");
  }
}

function executeLegacyProjectCommand(request: StorageRequest): unknown {
  const { actorId } = request, args = legacyProjectInvocationSchema.parse(request.args);
  const workspaceId = String(JSON.parse(readFileSync(join(root, ".pkm-next-workspace"), "utf8")).id);
  const fingerprint = storageMutationFingerprint({ operation: request.operation, actorId, args });
  const prepared = transaction(() => {
    inspectLegacyControlRecovery(db, workspaceId);
    for (const table of ["pending_write", "pending_todo", "pending_asset", "pending_resource", "pending_document_lifecycle",
        "pending_project_mutation", "data_runtime_intents", "migration_runtime_intents"]) {
        if (db.prepare(`SELECT 1 FROM ${table} LIMIT 1`).get()) throw new CoreError("BUSY", "A workspace intent requires restart reconciliation.");
    }
    const snapshot = readCurrentLegacyProjectSnapshot(db, workspaceId);
    const decision = checkLegacyProjectCommand(db, workspaceId, args.command, snapshot);
    const prior = db.prepare("SELECT fingerprint,actor_id,operation FROM receipts WHERE operation_id=?").get(args.operationId);
    if (prior && (prior.fingerprint !== fingerprint || prior.actor_id !== actorId || prior.operation !== request.operation))
        throw new CoreError("CONFLICT", "Global operationId belongs to another request or actor.");
    if (decision.status === "replay") {
        const result = { snapshot: decision.snapshot, entityId: decision.entityId, replayed: true,
          storeVersion: readLegacyProjectControl(db, workspaceId)!.storeVersion };
        if (!prior) db.prepare("INSERT INTO receipts VALUES(?,?,?,?,?,?)")
          .run(args.operationId, fingerprint, JSON.stringify(result), actorId, request.operation, new Date().toISOString());
        return { result };
    }
    if (!args.update) throw new CoreError("INVALID_ARGUMENT", "A new project.update command requires explicit native CAS update arguments.");
    const plan = planProjectMutation(root, { operation: "project.update", args: { ...args.update, operationId: args.operationId }, actorId }, scanMarkdown(root));
    db.prepare(`INSERT INTO pending_project_mutation(singleton,operation_id,fingerprint,actor_id,operation,plan,legacy_command)
        VALUES(1,?,?,?,?,?,?)`).run(args.operationId, fingerprint, actorId, request.operation, serializeProjectMutationPlan(plan), canonicalJson(args.command));
    return { pending: true };
  });
  if ("result" in prepared) return prepared.result;
  recoverProjectIntent();
  return transaction(() => {
    const row = db.prepare("SELECT result FROM receipts WHERE operation_id=?").get(args.operationId);
    if (!row) throw new CoreError("RECOVERY_CONFLICT", "Legacy Project command remains pending.", "unknown");
    return JSON.parse(String(row.result));
  });
}

function executeDocumentLifecycle(request: StorageRequest): unknown {
  const { operation, args, actorId } = request;
  const fingerprint = storageMutationFingerprint({ operation, actorId, args });
  const prepared = transaction(() => {
    recoverPending();
    if (operation === "knowledge.document.lifecycle.preview") return { result: readDocumentLifecycle(root, reconcileIndex(), request) };
    const receipt = db.prepare("SELECT fingerprint,result FROM receipts WHERE operation_id=?").get(String(args.operationId));
    if (receipt) {
      if (receipt.fingerprint !== fingerprint) throw new CoreError("CONFLICT", "operationId belongs to a different request or actor.");
      return { result: JSON.parse(String(receipt.result)) };
    }
    const plan = planDocumentLifecycle(root, reconcileIndex(), request);
    if (plan.documentCas.area === "notes") assertNativeBoardWriteTarget(root, plan.result.document.afterPath, db);
    db.prepare("INSERT INTO pending_document_lifecycle VALUES(1,?,?,?,?,?)").run(
      String(args.operationId), fingerprint, actorId, operation, serializeDocumentLifecyclePlan(plan),
    );
    return { pending: true };
  });
  if ("result" in prepared) return prepared.result;
  try {
    return transaction(() => {
      recoverPending();
      const receipt = db.prepare("SELECT result FROM receipts WHERE operation_id=?").get(String(args.operationId));
      if (!receipt) throw new CoreError("STORAGE_ERROR", "Committed document lifecycle intent has no receipt.", "unknown");
      return JSON.parse(String(receipt.result));
    });
  } catch (error) {
    throw new CoreError(error instanceof CoreError ? error.code : "STORAGE_ERROR",
      `Document lifecycle intent committed; retry only the same operationId. ${error instanceof Error ? error.message : String(error)}`, "unknown");
  }
}

function executeResourceLifecycle(request: StorageRequest): unknown {
  const { operation, args, actorId } = request;
  const readOnly = operation === "knowledge.asset.lifecycle.preview";
  const fingerprint = storageMutationFingerprint({ operation, actorId, args });
  const prepared = transaction(() => {
    recoverPending();
    if (readOnly) return { result: readResourceLifecycle(root, reconcileIndex(), request) };
    const receipt = db.prepare("SELECT fingerprint,result FROM receipts WHERE operation_id=?").get(String(args.operationId));
    if (receipt) {
      if (receipt.fingerprint !== fingerprint) throw new CoreError("CONFLICT", "operationId belongs to a different request or actor.");
      return { result: JSON.parse(String(receipt.result)) };
    }
    const plan = planResourceLifecycle(root, reconcileIndex(), request);
    db.prepare("INSERT INTO pending_resource VALUES(1,?,?,?,?,?)").run(
      String(args.operationId), fingerprint, actorId, operation, serializeResourceLifecyclePlan(plan),
    );
    return { pending: true };
  });
  if ("result" in prepared) return prepared.result;
  try {
    return transaction(() => {
      recoverPending();
      const receipt = db.prepare("SELECT result FROM receipts WHERE operation_id=?").get(String(args.operationId));
      if (!receipt) throw new CoreError("STORAGE_ERROR", "Committed resource lifecycle intent has no receipt.", "unknown");
      return JSON.parse(String(receipt.result));
    });
  } catch (error) {
    throw new CoreError(error instanceof CoreError ? error.code : "STORAGE_ERROR",
      `Resource lifecycle intent committed; retry only the same operationId. ${error instanceof Error ? error.message : String(error)}`, "unknown");
  }
}

function executeUpload(request: StorageRequest): unknown {
  const { operation, args, actorId } = request;
  const readOnly = operation === "knowledge.upload.get" || operation === "knowledge.upload.list";
  const fingerprint = storageMutationFingerprint({ operation, actorId, args });
  const prepared = transaction(() => {
    recoverPending();
    if (!readOnly) {
      const receipt = db.prepare("SELECT fingerprint,result FROM receipts WHERE operation_id=?").get(String(args.operationId));
      if (receipt) {
        if (receipt.fingerprint !== fingerprint) throw new CoreError("CONFLICT", "operationId belongs to a different request or actor.");
        return { result: JSON.parse(String(receipt.result)) };
      }
    }
    const plan = uploads.plan(request, reconcileIndex);
    if ("result" in plan && !readOnly) db.prepare("INSERT INTO receipts VALUES(?,?,?,?,?,?)").run(
      String(args.operationId), fingerprint, JSON.stringify(plan.result), actorId, operation, new Date().toISOString(),
    );
    return plan;
  });
  if ("result" in prepared) return prepared.result;
  try {
    return transaction(() => {
      recoverPending();
      const receipt = db.prepare("SELECT result FROM receipts WHERE operation_id=?").get(String(args.operationId));
      if (!receipt) throw new CoreError("STORAGE_ERROR", "Committed resource intent has no receipt.", "unknown");
      return JSON.parse(String(receipt.result));
    });
  } catch (error) {
    throw new CoreError(error instanceof CoreError ? error.code : "STORAGE_ERROR",
      `Resource intent committed; retry only the same operationId. ${error instanceof Error ? error.message : String(error)}`, "unknown");
  }
}

function listTodoChats(actorId: string) {
  const definition = chatSessionDefinitions.find(item => item.id === "chat.session.list")!;
  const identity = JSON.parse(readFileSync(join(root, ".pkm-next-workspace"), "utf8"));
  if (!identity || typeof identity.id !== "string" || !/^[0-9a-f-]{36}$/i.test(identity.id))
    throw new CoreError("INVALID_WORKSPACE", "Workspace identity is invalid.");
  const workspaceNamespace = identity.id.replace(/-/g, "").slice(0, 16);
  const chats: { hostSessionId: string; title: string; chatUrl: string }[] = [];
  const seen = new Set<string>();
  let cursor: string | undefined;
  for (let pageNumber = 0; pageNumber < Math.ceil(CHAT_SESSION_LIMITS.sessionsPerActor / 100); pageNumber++) {
    const raw = chatSessions.execute({
      operation: "chat.session.list",
      args: { limit: 100, includeArchived: false, ...(cursor ? { cursor } : {}) },
    }, actorId);
    const page = definition.output.parse(raw) as { items: { id: string; title: string }[]; nextCursor: string | null };
    for (const chat of page.items) {
      if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(chat.id))
        throw new CoreError("INVALID_RESULT", "Native Chat identity cannot be represented by the Todo assignment contract.");
      chats.push({
        hostSessionId: chat.id, title: chat.title,
        chatUrl: `pkm://chats/${workspaceNamespace}/${chat.id}`,
      });
    }
    if (chats.length > CHAT_SESSION_LIMITS.sessionsPerActor)
      throw new CoreError("LIMIT_EXCEEDED", "Native Chat directory exceeds the supported actor limit.");
    cursor = page.nextCursor ?? undefined;
    if (!cursor) return chats;
    if (seen.has(cursor)) throw new CoreError("CURSOR_INVALID", "Native Chat directory repeated a cursor.");
    seen.add(cursor);
  }
  throw new CoreError("LIMIT_EXCEEDED", "Native Chat directory exceeded its bounded page count.");
}

function executeNativeTodoUser(input: NativeTodoUserInput, chats: NativeTodoUiChat[]): unknown {
  input = nativeTodoUserInput.parse(input);
  chats = nativeTodoUiChats.parse(chats);
  const fingerprint = nativeTodoUserFingerprint(input);
  const prepared = transaction(() => {
    recoverPending();
    if (input.kind !== "read") {
      const receipt = db.prepare("SELECT fingerprint,result,actor_id,operation FROM receipts WHERE operation_id=?").get(input.operationId);
      if (receipt) {
        if (receipt.fingerprint !== fingerprint || receipt.actor_id !== "user:local" || receipt.operation !== NATIVE_TODO_USER_OPERATION)
          throw new CoreError("CONFLICT", "Todo operationId belongs to a different request or authority.");
        return { result: JSON.parse(String(receipt.result)) };
      }
    }
    const plan = planNativeTodoUser(root, input, chats, db);
    if (!plan.write || input.kind === "read") return { result: plan.result };
    prepareNativeTodoUserIntent(db, input, plan.write.raw);
    db.prepare("INSERT INTO pending_todo VALUES(1,?,?,?,?,?,?,?,?)").run(input.operationId, fingerprint,
      "user:local", NATIVE_TODO_USER_OPERATION, plan.write.slug, plan.write.before, plan.write.raw,
      canonicalJson(plan.result));
    return { pending: true };
  });
  if ("result" in prepared) return prepared.result;
  try {
    return transaction(() => {
      recoverPending();
      return JSON.parse(String(db.prepare("SELECT result FROM receipts WHERE operation_id=?").get(
        input.kind !== "read" ? input.operationId : "")!.result));
    });
  } catch (error) {
    throw new CoreError(error instanceof CoreError ? error.code : "STORAGE_ERROR",
      `Todo user intent is durable; retry only the same operationId. ${error instanceof Error ? error.message : String(error)}`, "unknown");
  }
}

function executeOriginalTodoGenesis(request: StorageRequest, admission: OriginalMcpTodoGenesisAdmission,
  experimentalFault?: ExperimentalTodoGenesisFaultControl): unknown {
  if (experimentalFault) assertExperimentalTodoGenesisFaultControl(root, admission, experimentalFault);
  if (admission.plan.request.phase === "recover")
    return transaction(() => finalizeOriginalMcpTodoGenesis(root, db, request, admission));
  const prepared = transaction(() => {
    recoverPending();
    return prepareOriginalMcpTodoGenesisIntent(root, db, request, admission);
  });
  if ("result" in prepared) return prepared.result;
  try { return transaction(() => finalizeOriginalMcpTodoGenesis(root, db, request, admission, experimentalFault)); }
  catch (error) {
    if (error instanceof ExperimentalTodoGenesisFault) {
      console.error("PKM owned Todo publication checkpoint:", error.checkpoint);
      throw error;
    }
    throw Object.assign(new CoreError(error instanceof CoreError ? error.code : "STORAGE_ERROR",
      "Todo genesis intent is durable; fresh exact native recovery review is required.", "unknown"), { cause: error });
  }
}
function executeTodo(request: StorageRequest, legacyNoteOperationId?: string, originalNoteCreate?: LegacyTodoBoardCreateArguments,
  assignment?: OriginalTodoAssignmentAdmission, role?: OriginalTodoRoleAdmission): unknown {
  const definition = todoDefinitions.find(item => item.id === request.operation);
  if (!definition) throw new CoreError("NOT_FOUND", "Unknown Todo operation.");
  const fingerprint = originalNoteCreate ? legacyTodoBoardCreateFingerprint(request, originalNoteCreate) : storageMutationFingerprint(request, "todo");
  const prepared = transaction(() => {
    originalRoles.assertRequest(request, role, activeRuntimeOwner ?? {});
    originalAssignments.assertRequest(request, assignment, activeRuntimeOwner ?? {});
    assertLegacyNoteIntentRequest(request, legacyNoteOperationId);
    recoverPending(legacyNoteOperationId);
    if (!definition.readOnly) {
      const receipt = db.prepare("SELECT fingerprint,result FROM receipts WHERE operation_id=?").get(String(request.args.operationId));
      if (receipt) {
        if (receipt.fingerprint !== fingerprint) throw new CoreError("CONFLICT", "operationId belongs to a different request or actor.");
        if (assignment) originalAssignments.receipt(assignment, request, fingerprint);
        if (role) originalRoles.receipt(role, request, fingerprint);
        return { result: JSON.parse(String(receipt.result)) };
      }
    }
    if (request.operation === "todo.board.create") assertNativeBoardWriteTarget(root, `${String(request.args.board_slug)}.md`, db);
    const preparePlan = () => {
      if (role) {
        const board = scanBoards(root, db).get(String(request.args.board_slug));
        if (!board) throw new CoreError("NOT_FOUND", "The exact role Board is unavailable.");
        originalRoles.snapshot(role, sha256(board.raw));
        if (role.kind === "tool" && ["todo.workitem.submit", "todo.workitem.comment"].includes(request.operation))
          originalRoles.evidence(role, request.operation === "todo.workitem.submit" ? "WIP" : "Done");
      }
      return planTodo(root, request, () => listTodoChats(request.actorId), db);
    };
    const plan = role ? originalRoles.within(role, activeRuntimeOwner ?? {}, preparePlan) : preparePlan();
    if (!plan.write) {
      if (role?.kind === "tool") {
        const item = plan.result.item as Record<string, unknown>;
        const evidence = "provider" in role.callback ? {
          sdk_role_evidence: {
            id: originalSdkTodoRoleEvidenceId(role.callback), decisionId: role.grant.decision.decisionId,
            requestId: role.callback.requestId, sdkSessionId: role.callback.sdkSessionId,
            sendingBoundaryId: role.callback.sendingBoundaryId, toolReceiptId: role.callback.toolReceiptId,
          },
        } : { native_role_evidence: {
          id: `native-todo-evidence:${role.callback.callId}`, decisionId: role.grant.decision.decisionId,
          requestId: role.callback.requestId, inferenceId: role.callback.inferenceId,
        } };
        const result = { ...plan.result, item: { ...item, ...evidence } };
        originalRoles.persist(role, request, fingerprint, String(plan.result.digest), String(plan.result.digest), JSON.stringify(result));
        return { result };
      }
      return { result: plan.result };
    }
    if (originalNoteCreate) prepareLegacyTodoBoardCreate(db, root, request, originalNoteCreate, plan.write.raw, fingerprint);
    if (assignment) {
      definition.output.parse(plan.result);
      originalAssignments.persist(assignment, request, fingerprint, plan.write.raw, JSON.stringify(plan.result));
    }
    if (role) originalRoles.persist(role, request, fingerprint, plan.write.before!, sha256(plan.write.raw), JSON.stringify(plan.result));
    db.prepare("INSERT INTO pending_todo VALUES(1,?,?,?,?,?,?,?,?)").run(
      String(request.args.operationId), fingerprint, request.actorId, originalNoteCreate ? LEGACY_TODO_BOARD_CREATE_PENDING_OPERATION : request.operation,
      plan.write.slug, plan.write.before, plan.write.raw, JSON.stringify(plan.result),
    );
    return { pending: true };
  });
  if ("result" in prepared) return prepared.result;
  try {
    return transaction(() => {
      if (role) originalRoles.check(role, activeRuntimeOwner ?? {});
      originalAssignments.assertRequest(request, assignment, activeRuntimeOwner ?? {});
      recoverPending(legacyNoteOperationId);
      const receipt = db.prepare("SELECT result FROM receipts WHERE operation_id=?").get(String(request.args.operationId));
      if (!receipt) throw new CoreError("STORAGE_ERROR", "Committed Todo intent has no receipt.", "unknown");
      return JSON.parse(String(receipt.result));
    });
  } catch (error) {
    throw new CoreError(error instanceof CoreError ? error.code : "STORAGE_ERROR",
      `Todo intent committed; retry only the same operationId. ${error instanceof Error ? error.message : String(error)}`, "unknown");
  }
}
function executeOriginalTodoHuman(data: Extract<OriginalTodoRoleAdmission, { kind: "human" }>): unknown {
    const request = originalTodoRoleStorageRequest(data), fingerprint = sha256(JSON.stringify(request));
    const prepared = transaction(() => {
      originalRoles.check(data, activeRuntimeOwner ?? {});
      recoverPending();
      const receipt = db.prepare("SELECT * FROM receipts WHERE operation_id=?").get(String(request.args.operationId));
      if (receipt) {
        originalRoles.receipt(data, request, fingerprint);
        if (receipt.actor_id !== "user:local" || receipt.operation !== ORIGINAL_TODO_HUMAN_OPERATION || receipt.fingerprint !== fingerprint)
          throw new CoreError("CONFLICT", "The human decision operationId belongs to another effect.");
        return { result: JSON.parse(String(receipt.result)) };
      }
      return originalRoles.within(data, activeRuntimeOwner ?? {}, () => {
        const board = scanBoards(root, db).get(data.payload.request.boardSlug);
        if (!board) throw new CoreError("NOT_FOUND", "The exact acceptance Board is unavailable.");
        originalRoles.snapshot(data, sha256(board.raw));
        const target = planTodo(root, { operation: "todo.workitem.get", actorId: "mcp:external",
          args: { board_slug: data.payload.request.boardSlug, id: data.payload.request.workItemId } }, undefined, db);
        if (originalMcpDomainHash(target.result.item) !== data.payload.request.itemSha256)
          throw new CoreError("NATIVE_AUTHORITY_REQUIRED", "The reviewed human target changed.");
        const raw = commandTodoBoard(board.raw, data.payload.request.boardDigest, {
          action: "accept", id: data.payload.request.workItemId, reason: data.decision.reason,
        }, { id: "user:local", role: "user" });
        const snapshot = readTodoBoard(raw), result = { actorId: "user:local", board_slug: data.payload.request.boardSlug,
          digest: snapshot.digest, item: snapshot.items.find(item => item.id === data.payload.request.workItemId) };
        originalRoles.persist(data, request, fingerprint, data.payload.request.boardDigest, snapshot.digest, JSON.stringify(result));
        db.prepare("INSERT INTO pending_todo VALUES(1,?,?,?,?,?,?,?,?)").run(originalTodoRoleOperationId(data),
          fingerprint, request.actorId, request.operation, data.payload.request.boardSlug, data.payload.request.boardDigest, raw, JSON.stringify(result));
        return { pending: true };
      });
    });
    if ("result" in prepared) return prepared.result;
    return transaction(() => {
      originalRoles.check(data, activeRuntimeOwner ?? {});
      recoverPending();
      return JSON.parse(String(db.prepare("SELECT result FROM receipts WHERE operation_id=?").get(originalTodoRoleOperationId(data))!.result));
    });
}

function executeMemory(request: StorageRequest): unknown {
  const { operation, args, actorId } = request;
  const definition = memoryDefinitions.find(item => item.id === operation);
  if (!definition) throw new CoreError("NOT_FOUND", "Unknown memory operation.");
  const fingerprint = storageMutationFingerprint({ operation, actorId, args });
  const prepared = transaction(() => {
    recoverPending();
    if (!definition.readOnly) {
      const receipt = db.prepare("SELECT fingerprint,result FROM receipts WHERE operation_id=?").get(String(args.operation_id));
      if (receipt) {
        if (receipt.fingerprint !== fingerprint) throw new CoreError("CONFLICT", "Memory operation_id belongs to a different request/actor.");
        const result: unknown = JSON.parse(String(receipt.result));
        assertMemoryReceiptScope(root, actorId, result);
        return { result };
      }
    }
    if (request.receiptOnly) return { result: null };
    const plan = planMemory(root, reconcileIndex(), request);
    if (!("write" in plan)) return { result: plan.result };
    db.prepare("INSERT INTO pending_write(singleton,operation_id,fingerprint,actor_id,operation,document_id,before_sha256,after_markdown,document_path,document_area,result) VALUES(1,?,?,?,?,?,?,?,?,?,?)").run(
      String(args.operation_id), fingerprint, actorId, operation, plan.write.id, plan.write.before, plan.write.raw,
      plan.write.path, "notes", JSON.stringify(plan.result),
    );
    return { pending: true };
  });
  if ("result" in prepared) return prepared.result;
  try {
    return transaction(() => {
      recoverPending();
      const receipt = db.prepare("SELECT result FROM receipts WHERE operation_id=?").get(String(args.operation_id));
      if (!receipt) throw new CoreError("STORAGE_ERROR", "Committed memory intent has no receipt.", "unknown");
      return JSON.parse(String(receipt.result));
    });
  } catch (error) {
    throw new CoreError(error instanceof CoreError ? error.code : "STORAGE_ERROR",
      `Memory intent committed; retry only the same operation_id. ${error instanceof Error ? error.message : String(error)}`, "unknown");
  }
}

function recoverWorkspace() {
  const assignmentPending = db.prepare("SELECT * FROM pending_todo WHERE singleton=1").get();
  if (assignmentPending) originalAssignments.pending(assignmentPending, activeRuntimeOwner ?? {});
  if (assignmentPending) transaction(() => originalRoles.withinPending(assignmentPending, activeRuntimeOwner ?? {}, () => undefined));
  verifyLegacyKnowledgeRecovery(db, root);
  verifyLegacyKnowledgeSnapshots(db, root);
  verifyLegacyActionArtifacts(db, String(JSON.parse(readFileSync(join(root, ".pkm-next-workspace"), "utf8")).id));
  assertBatch16UnintegratedClear(db);
  assertSkillSourceIntegrated(db);
  const inline = inspectLegacyInlineNoteFence(db), snapshotUnknown = inspectPausedSnapshotJournal(db);
  if (inline || snapshotUnknown || inspectBatch15SkillPending(db)) return;
  assertPortalRecoveryClear(db);
  if (db.prepare("SELECT 1 FROM legacy_recipe_trash_intent LIMIT 1").get()) {
    throw new CoreError("RECOVERY_AUTHORITY_REQUIRED", "Recipe trash must be inspected and recovered by its authorized native host.", "unknown");
  }
  recoverNativeLegacyCommands(db, root, () => assertWorkerOwner(activeRuntimeOwner));
  recoverProjectIntent();
  readLegacyStateReceipt(db, String(JSON.parse(readFileSync(join(root, ".pkm-next-workspace"), "utf8")).id));
  const workspaceId = String(JSON.parse(readFileSync(join(root, ".pkm-next-workspace"), "utf8")).id);
  inspectLegacyControlRecovery(db, workspaceId);
  transaction(() => { recoverPending(); reconcileIndex(); scanBoards(root, db); });
}
function assertWorkerOwner(candidate?: { ownerId?: string; fence?: number }) {
  const owner = db.prepare("SELECT owner_id,fence,lease_until FROM native_runtime_owner WHERE singleton=1").get();
  if (!owner || owner.owner_id !== candidate?.ownerId || owner.fence !== candidate?.fence || Number(owner.lease_until) <= Date.now()) {
    throw new CoreError("STORAGE_UNAVAILABLE", "Workspace ownership lease is absent, expired, or fenced.", "unknown");
  }
}
let freshNoteModel: FreshNoteQueryModel | undefined;
let freshNoteIndex: ReturnType<typeof openFreshNoteIndex> | undefined;
let freshReadRunning = false;
let activeFreshRead: {
  controls: PlainWorkspaceControls;
  owner: { ownerId?: string; fence?: number };
  bootstrap: boolean;
  index?: IndexedDocument[];
} | undefined;
function assertFreshReadPhase(phase: FreshNoteGuardPhase) {
  const context = activeFreshRead;
  if (!context || phase === "initialize" && !context.bootstrap)
    throw new CoreError("ACCESS_DENIED", "Fresh Note cache has no current private worker scope.");
  assertWorkerOwner(context.owner);
  freshNoteIndex?.assertHeld();
  const controls = capturePlainWorkspaceControls(root);
  if (!controls || controls.workspaceId !== workerWorkspaceId || controls.rootPin !== workerRootPin
    || controls.digest !== context.controls.digest)
    throw new CoreError("CONFLICT", "Workspace controls changed during the fresh Note query.");
  const state = classifyStorageStartup(root, db);
  if (state.kind !== "plain")
    throw new CoreError("RECOVERY_REQUIRED", "Native workspace state blocks the fresh Note query.", "unknown");
  return { workspaceId: workerWorkspaceId, rootPin: workerRootPin };
}
function reconcileFreshNoteIndex(scan: FreshRootScan, delta: {
  readonly rebuild: boolean; readonly changed: readonly FreshNoteSource[]; readonly removed: readonly FreshNoteSource[];
}): undefined {
  if (!activeFreshRead || !db.isTransaction) throw new CoreError("TRANSACTION_BOUNDARY", "Fresh root index reconciliation requires its model transaction.");
  if (delta.rebuild) db.prepare("DELETE FROM documents").run();
  else {
    const remove = db.prepare("DELETE FROM documents WHERE area=? AND path=?");
    for (const source of [...delta.removed, ...delta.changed]) remove.run(source.area, source.path);
  }
  insertDocumentIndex(delta.rebuild ? scan.sources.values() : delta.changed);
  activeFreshRead.index = [...scan.sources.values()].map(source => ({
    id: source.id, title: source.title, revision: source.revision, deleted: source.deleted,
    sha256: source.sha256, path: source.path, area: source.area,
  }));
}
async function readFreshLegacyNotes(query: LegacyNotesReadQuery, candidate?: { ownerId?: string; fence?: number }): Promise<LegacyNotesReadResult> {
  if (freshReadRunning) throw new CoreError("BUSY", "A private fresh Note read is already active.");
  if (!query || !["list", "legacy-lexical"].includes(query.kind))
    throw new CoreError("INVALID_ARGUMENT", "Unknown private fresh Note query.");
  freshReadRunning = true;
  try {
    assertWorkerOwner(candidate);
    await validateWorkspace(root);
    const controls = capturePlainWorkspaceControls(root);
    if (!controls) return { kind: "canonical-required", reason: "layout" };
    if (controls.workspaceId !== workerWorkspaceId || controls.rootPin !== workerRootPin)
      throw new CoreError("STORAGE_UNAVAILABLE", "The worker workspace identity changed.", "unknown");
    const eligibility = classifyStorageStartup(root, db);
    if (eligibility.kind !== "plain") return { kind: "canonical-required", reason: eligibility.reason };
    const { initializeFreshNoteQuerySchema, createFreshNoteQueryModel } = await import("./fresh-note-query-model.js");
    const { createFreshRootScanner } = await import("./markdown-read.js");
    activeFreshRead = { controls, owner: candidate!, bootstrap: true };
    if (!freshNoteModel) {
      const guard = { assert: assertFreshReadPhase };
      freshNoteIndex ??= openFreshNoteIndex(root, db);
      activeFreshRead.controls = capturePlainWorkspaceControls(root)!;
      initializeFreshNoteQuerySchema(freshNoteIndex.database, guard);
      freshNoteModel = createFreshNoteQueryModel({ database: freshNoteIndex.database, scanner: createFreshRootScanner(root), guard,
        reconcileRootIndex: reconcileFreshNoteIndex,
        ...(freshNoteIndex.separate ? { externalDatabaseVersion: () => Number(db.prepare("PRAGMA data_version").get()?.data_version) } : {}) });
    }
    activeFreshRead.bootstrap = false;
    // documents remains in the durable transaction domain for document/recovery invariants.
    // The disposable query projection may commit first: any failure discards its in-memory generation.
    const separate = freshNoteIndex!.separate;
    if (separate) db.exec("BEGIN IMMEDIATE");
    let result, modelCommitted = false;
    try {
      result = freshNoteModel.executeFresh(query);
      modelCommitted = true;
      if (separate) db.exec("COMMIT");
    } catch (error) {
      if (separate && db.isTransaction) db.exec("ROLLBACK");
      if (separate && modelCommitted) {
        freshNoteModel.close();
        freshNoteModel = undefined;
      }
      throw error;
    }
    if (activeFreshRead.index) indexedDocuments = activeFreshRead.index;
    assertFreshReadPhase("after-query");
    const expectedControls = activeFreshRead.controls;
    activeFreshRead = undefined;
    await validateWorkspace(root);
    assertWorkerOwner(candidate);
    const after = capturePlainWorkspaceControls(root);
    if (!after || after.digest !== expectedControls.digest)
      throw new CoreError("CONFLICT", "Workspace controls changed after the fresh Note query.");
    return { kind: "fresh", ...result };
  } catch (error) {
    indexedDocuments = undefined;
    throw error;
  } finally { activeFreshRead = undefined; freshReadRunning = false; }
}
parentPort!.on("message", async ({ id, request, close, recover, runtimeOwner, legacyNoteOperationId, originalNoteCreate, nativeTodoUser, nativeBoardLifecycle, memoryScope, freshLegacyNotes, originalTodoSession, originalTodoWorkerReceiptSha256, originalTodoAssignment, managedChatTask, originalTodoGenesis, originalTodoGenesisSource, experimentalTodoGenesisFault, originalTodoRole, originalRecovery, mutationReceipt }: {
  id: number; request?: StorageRequest; close?: boolean; recover?: boolean; runtimeOwner?: { ownerId?: string; fence?: number };
  legacyNoteOperationId?: string;
  originalNoteCreate?: LegacyTodoBoardCreateArguments;
  nativeTodoUser?: { input: NativeTodoUserInput; chats: NativeTodoUiChat[] };
  nativeBoardLifecycle?: NativeBoardLifecycleInput;
  memoryScope?: { request: MemoryScopeContinuityRequest; approval: { decisionId: string; actorId: string; expiresAtMs: number }; revocation?: SharedArrayBuffer }
    | { revoke: true };
  freshLegacyNotes?: LegacyNotesReadQuery;
  originalTodoSession?: OriginalMcpTodoSession;
  originalTodoWorkerReceiptSha256?: string;
  originalTodoAssignment?: OriginalTodoAssignmentAdmission;
  managedChatTask?: ManagedTaskWorkerRequest;
  originalTodoGenesis?: OriginalMcpTodoGenesisAdmission;
  originalTodoGenesisSource?: OriginalMcpTodoGenesisSourceControl;
  experimentalTodoGenesisFault?: ExperimentalTodoGenesisFaultControl;
  originalTodoRole?: OriginalTodoRoleAdmission;
  originalRecovery?: OriginalRecoveryWorkerAdmission;
  mutationReceipt?: BrowserMutationReceiptControl;
}) => {
  if (mutationReceipt) {
    try {
      if (request || close || recover || legacyNoteOperationId || originalNoteCreate || nativeTodoUser || nativeBoardLifecycle
        || memoryScope || freshLegacyNotes || originalTodoSession || originalTodoWorkerReceiptSha256 || originalTodoAssignment
        || managedChatTask || originalTodoGenesis || originalTodoGenesisSource || experimentalTodoGenesisFault || originalTodoRole || originalRecovery)
        throw new CoreError("ACCESS_DENIED", "Mutation receipt controls require their exclusive private worker channel.");
      assertWorkerOwner(runtimeOwner);
      db.exec("bind" in mutationReceipt ? "BEGIN IMMEDIATE" : "BEGIN");
      try {
        let result;
        if ("bind" in mutationReceipt) {
          const { request: bound, bodySha256, receiptMode } = mutationReceipt.bind;
          if (receiptMode !== "worker" && receiptMode !== "unknown")
            throw new CoreError("INVALID_ARGUMENT", "Unknown mutation receipt dispatch context.");
          const batch04 = [...chatSessionDefinitions, ...workflowRuntimeDefinitions, ...syncPlanDefinitions,
            ...collaborationStateDefinitions, ...actionCompilerDefinitions].some(item => item.id === bound.operation);
          bindBrowserMutationPin(db, bound, bodySha256, receiptMode === "unknown" ? null
            : storageMutationFingerprint(bound, batch04 ? "batch04" : bound.operation.startsWith("todo.") ? "todo" : "standard"));
          result = true;
        } else result = readBrowserMutationReceipt(db, mutationReceipt.read);
        assertWorkerOwner(runtimeOwner);
        db.exec("COMMIT");
        parentPort!.postMessage({ id, result });
      } catch (error) {
        if (db.isTransaction) db.exec("ROLLBACK");
        throw error;
      }
    } catch (error) {
      parentPort!.postMessage({ id, error: { code: error instanceof CoreError ? error.code : "INVALID_ARGUMENT",
        message: error instanceof CoreError ? error.message : "Mutation receipt lookup or binding was refused.", effect: "unknown" } });
    }
    return;
  }
  if (originalRecovery) {
    try {
      if (request || close || recover || legacyNoteOperationId || originalNoteCreate || nativeTodoUser || nativeBoardLifecycle
        || memoryScope || freshLegacyNotes || originalTodoSession || originalTodoWorkerReceiptSha256 || originalTodoAssignment
        || managedChatTask || originalTodoGenesis || originalTodoGenesisSource || experimentalTodoGenesisFault || originalTodoRole)
        throw new CoreError("ACCESS_DENIED", "Recovery cannot accompany another actor/Role/domain request.");
      assertWorkerOwner(runtimeOwner);
      verifyLegacyKnowledgeRecovery(db, root);
      verifyLegacyKnowledgeSnapshots(db, root);
      assertBatch16UnintegratedClear(db);
      const result = executeOriginalRecoveryWorker(db, root, originalRecovery, runtimeOwner ?? {});
      parentPort!.postMessage({ id, result });
    } catch (error) {
      parentPort!.postMessage({ id, error: { code: error instanceof CoreError ? error.code : "RECOVERY_REQUIRED",
        message: error instanceof Error ? error.message : "Recovery failed.", effect: error instanceof CoreError ? error.effect : "unknown" } });
    }
    return;
  }
  if (!close) {
    try { verifyOriginalRecoveryState(db, root); }
    catch (error) {
      parentPort!.postMessage({ id, error: { code: "RECOVERY_REQUIRED",
        message: error instanceof Error ? error.message : "Recovery requires inspection.", effect: "unknown" } }); return;
    }
  }
  if (originalTodoRole && (request || close || recover || memoryScope || freshLegacyNotes || legacyNoteOperationId
    || originalNoteCreate || nativeTodoUser || nativeBoardLifecycle || originalTodoSession || originalTodoWorkerReceiptSha256
    || originalTodoAssignment || managedChatTask || originalTodoGenesis || originalTodoGenesisSource || experimentalTodoGenesisFault)) {
    parentPort!.postMessage({ id, error: { code: "ACCESS_DENIED", message: "Todo roles use their exclusive private Owner channel.", effect: "not-committed" } });
    return;
  }
  if (experimentalTodoGenesisFault && (!originalTodoGenesis || originalTodoGenesis.plan.request.phase !== "create"
    || !request || close || recover || memoryScope || freshLegacyNotes || legacyNoteOperationId || originalNoteCreate
    || nativeTodoUser || nativeBoardLifecycle || originalTodoSession || originalTodoWorkerReceiptSha256
    || originalTodoAssignment || managedChatTask || originalTodoGenesisSource)) {
    parentPort!.postMessage({ id, error: { code: "ACCESS_DENIED", message: "Owned Todo interruption requires its exact private creation envelope.", effect: "not-committed" } });
    return;
  }
  if (originalTodoGenesisSource) {
    try {
      assertWorkerOwner(runtimeOwner);
      if (request || close || recover || memoryScope || freshLegacyNotes || legacyNoteOperationId || originalNoteCreate
        || nativeTodoUser || nativeBoardLifecycle || originalTodoSession || originalTodoWorkerReceiptSha256
        || originalTodoAssignment || managedChatTask || originalTodoGenesis)
        throw new CoreError("ACCESS_DENIED", "Genesis source authority uses only the trusted Owner control channel.");
      receiveOriginalMcpTodoGenesisSourceControl(root, db, originalTodoGenesisSource, runtimeOwner ?? {});
      assertWorkerOwner(runtimeOwner);
      parentPort!.postMessage({ id, result: true });
    } catch (error) {
      parentPort!.postMessage({ id, error: { code: error instanceof CoreError ? error.code : "NATIVE_AUTHORITY_REQUIRED",
        message: "Exact genesis source control was refused.", effect: "not-committed" } });
    }
    return;
  }
  if (originalTodoGenesis && (!request || close || recover || memoryScope || freshLegacyNotes || legacyNoteOperationId
    || originalNoteCreate || nativeTodoUser || nativeBoardLifecycle || originalTodoSession
    || originalTodoWorkerReceiptSha256 || originalTodoAssignment || managedChatTask)) {
    parentPort!.postMessage({ id, error: { code: "ACCESS_DENIED", message: "Todo genesis uses its exact private Core channel.", effect: "not-committed" } });
    return;
  }
  if (managedChatTask && (request || close || recover || memoryScope || freshLegacyNotes || legacyNoteOperationId
    || originalNoteCreate || nativeTodoUser || nativeBoardLifecycle || originalTodoSession || originalTodoWorkerReceiptSha256 || originalTodoAssignment)) {
    parentPort!.postMessage({ id, error: { code: "ACCESS_DENIED", message: "Managed Task admission uses its exclusive private channel.", effect: "not-committed" } });
    return;
  }
  if (originalTodoAssignment && (request || close || recover || memoryScope || freshLegacyNotes || legacyNoteOperationId
    || originalNoteCreate || nativeTodoUser || nativeBoardLifecycle || originalTodoSession || originalTodoWorkerReceiptSha256)) {
    parentPort!.postMessage({ id, error: { code: "ACCESS_DENIED", message: "Private original assignment must use its exclusive typed channel.", effect: "not-committed" } });
    return;
  }
  if (originalTodoSession || originalTodoWorkerReceiptSha256) {
    try {
      assertWorkerOwner(runtimeOwner);
      if (request || close || recover || memoryScope || freshLegacyNotes || legacyNoteOperationId || originalNoteCreate || nativeTodoUser || nativeBoardLifecycle
        || originalTodoSession && originalTodoWorkerReceiptSha256 || originalTodoAssignment)
        throw new CoreError("ACCESS_DENIED", "Native Todo admission cannot accompany a generic operation.");
      if (originalTodoSession) activateOriginalMcpTodoSession(root, originalTodoSession, db);
      else activateOriginalMcpTodoWorker(root, originalTodoWorkerReceiptSha256!, db);
      assertWorkerOwner(runtimeOwner);
      parentPort!.postMessage({ id, result: true });
    } catch (error) {
      deactivateOriginalMcpTodoSession(root);
      parentPort!.postMessage({ id, error: { code: error instanceof CoreError ? error.code : "NOT_AVAILABLE",
        message: error instanceof Error ? error.message : String(error), effect: "not-committed" } });
    }
    return;
  }
  if (freshLegacyNotes) {
    try {
      if (request || close || recover || memoryScope || legacyNoteOperationId || originalNoteCreate || nativeTodoUser || nativeBoardLifecycle)
        throw new CoreError("ACCESS_DENIED", "Private fresh Note reads cannot accompany another worker operation.");
      const result = await readFreshLegacyNotes(freshLegacyNotes, runtimeOwner);
      parentPort!.postMessage({ id, result });
    } catch (error) {
      parentPort!.postMessage({ id, error: {
        code: error instanceof CoreError ? error.code : "STORAGE_ERROR",
        message: error instanceof Error ? error.message : String(error),
        effect: error instanceof CoreError ? error.effect : "unknown",
      } });
    }
    return;
  }
  if (close) { freshNoteModel?.close(); freshNoteIndex?.close(); db.close(); parentPort!.close(); return; }
  if (memoryScope) {
    try {
      assertWorkerOwner(runtimeOwner);
      if (request || recover || legacyNoteOperationId || originalNoteCreate || nativeTodoUser || nativeBoardLifecycle)
        throw new CoreError("ACCESS_DENIED", "Native Memory scope admission cannot accompany a generic request.");
      if ("revoke" in memoryScope) deactivateMemoryScopeContinuity(root);
      else {
        activateReadoptedMemoryScope(root, memoryScope.request, memoryScope.approval);
        bindMemoryScopeRevocation(root, memoryScope.revocation);
      }
      assertWorkerOwner(runtimeOwner);
      parentPort!.postMessage({ id, result: true });
    } catch (error) {
      deactivateMemoryScopeContinuity(root);
      parentPort!.postMessage({ id, error: { code: error instanceof CoreError ? error.code : "NOT_AVAILABLE",
        message: error instanceof Error ? error.message : String(error), effect: "not-committed" } });
    }
    return;
  }
  if (recover) {
    activeRuntimeOwner = runtimeOwner;
    try { assertWorkerOwner(runtimeOwner); recoverWorkspace(); parentPort!.postMessage({ id, result: true }); }
    catch (error) {
      const code = error instanceof CoreError ? error.code : "STORAGE_ERROR";
      parentPort!.postMessage({ id, error: { code, message: error instanceof Error ? error.message : String(error), effect: "unknown" } });
    } finally { activeRuntimeOwner = undefined; }
    return;
  }
  activeRuntimeOwner = runtimeOwner;
  try {
    assertWorkerOwner(runtimeOwner);
    const role = originalTodoRole ? transaction(() => originalRoles.admit(originalTodoRole, runtimeOwner ?? {})) : undefined;
    if (role) request = originalTodoRoleStorageRequest(role);
    if (managedChatTask) request = { operation: managedChatTask.operation, args: managedChatTask.args,
      actorId: managedChatTask.admission.guard.actorId };
    let assignment: OriginalTodoAssignmentAdmission | undefined;
    if (originalTodoAssignment) {
      if (request || close || recover || memoryScope || freshLegacyNotes || legacyNoteOperationId || originalNoteCreate || nativeTodoUser || nativeBoardLifecycle)
        throw new CoreError("ACCESS_DENIED", "Private original assignment cannot accompany a generic worker request.");
      assignment = transaction(() => originalAssignments.admit(originalTodoAssignment, runtimeOwner ?? {}));
      request = originalTodoAssignmentRequest(assignment);
    }
    if (request) originalAssignments.assertRequest(request, assignment, runtimeOwner ?? {});
    if (request) originalRoles.assertRequest(request, role, runtimeOwner ?? {});
    const assignmentPending = db.prepare("SELECT * FROM pending_todo WHERE singleton=1").get();
    if (assignmentPending) originalAssignments.pending(assignmentPending, runtimeOwner ?? {});
    if (assignmentPending) transaction(() => originalRoles.withinPending(assignmentPending, runtimeOwner ?? {}, () => undefined));
    verifyLegacyKnowledgeRecovery(db, root);
    verifyLegacyKnowledgeSnapshots(db, root);
    verifyLegacyActionArtifacts(db, String(JSON.parse(readFileSync(join(root, ".pkm-next-workspace"), "utf8")).id));
    assertBatch16UnintegratedClear(db);
    assertSkillSourceIntegrated(db);
    if (inspectLegacyInlineNoteFence(db) || inspectPausedSnapshotJournal(db) || inspectBatch15SkillPending(db))
      throw new CoreError("RECOVERY_REQUIRED", "Shared-source unknown journal blocks storage admission.", "unknown");
    verifyBatch15SkillWorkspace(db, root);
    if (request) assertLegacyNoteIntentRequest(request, legacyNoteOperationId);
    else if (legacyNoteOperationId) throw new CoreError("RECOVERY_CONFLICT", "Original Note operation marker has no request.", "unknown");
    assertPortalRecoveryClear(db);
    if (db.prepare("SELECT 1 FROM legacy_recipe_trash_intent LIMIT 1").get()) {
      throw new CoreError("RECOVERY_AUTHORITY_REQUIRED", "Recipe trash must be reconciled by its authorized native host.", "unknown");
    }
    recoverProjectIntent();
    inspectLegacyControlRecovery(db, String(JSON.parse(readFileSync(join(root, ".pkm-next-workspace"), "utf8")).id));
    readLegacyStateReceipt(db, String(JSON.parse(readFileSync(join(root, ".pkm-next-workspace"), "utf8")).id));
    if (db.prepare("SELECT 1 FROM data_runtime_intents").get()
      || db.prepare("SELECT 1 FROM migration_runtime_intents").get() || remoteRuntimePending(db)
      || db.prepare("SELECT 1 FROM coding_worker_effects WHERE state='intent' LIMIT 1").get()
      || db.prepare("SELECT 1 FROM coding_worker_records WHERE kind IN ('worker','check-intent') AND json_extract(record,'$.status')='intent' LIMIT 1").get()) {
      throw new CoreError("BUSY", "A native filesystem intent must be reconciled before storage requests.", "unknown");
    }
    let result: unknown;
    if (!request) throw new CoreError("INVALID_ARGUMENT", "Missing storage request.");
    const operation = request.operation;
    if (managedChatTask) {
      result = executeManagedTask(managedChatTask, runtimeOwner ?? {});
    } else if (nativeBoardLifecycle) {
      if (request.operation !== NATIVE_BOARD_LIFECYCLE_OPERATION || request.actorId !== "user:local"
        || canonicalJson(request.args) !== canonicalJson(nativeBoardLifecycle) || nativeTodoUser || originalNoteCreate || legacyNoteOperationId)
        throw new CoreError("ACCESS_DENIED", "Board file lifecycle requires its dedicated trusted user channel.");
      const input = nativeBoardLifecycleInput.parse(nativeBoardLifecycle), fingerprint = boardLifecycleFingerprint(input);
      const prepared = transaction(() => {
        recoverPending();
        const receipt = db.prepare("SELECT * FROM receipts WHERE operation_id=?").get(input.operationId);
        if (receipt) {
          if (receipt.operation !== NATIVE_BOARD_LIFECYCLE_OPERATION || receipt.actor_id !== "user:local" || receipt.fingerprint !== fingerprint)
            throw new CoreError("CONFLICT", "operationId belongs to a different Board file request or actor.");
          return { result: JSON.parse(String(receipt.result)) };
        }
        prepareNativeBoardLifecycle(db, root, input);
        return { pending: true };
      });
      result = "result" in prepared ? prepared.result : transaction(() => {
        recoverPending();
        const receipt = db.prepare("SELECT result FROM receipts WHERE operation_id=?").get(input.operationId);
        if (!receipt) throw new CoreError("RECOVERY_CONFLICT", "Board file operation remains pending.", "unknown");
        return JSON.parse(String(receipt.result));
      });
    } else if (request.operation === NATIVE_BOARD_LIFECYCLE_OPERATION) {
      throw new CoreError("ACCESS_DENIED", "Generic requests cannot synthesize the trusted Board file lifecycle channel.");
    } else if (nativeTodoUser) {
      if (request.operation !== NATIVE_TODO_USER_OPERATION || request.actorId !== "user:local"
        || canonicalJson(request.args) !== canonicalJson(nativeTodoUser.input) || originalNoteCreate || legacyNoteOperationId)
        throw new CoreError("ACCESS_DENIED", "Trusted Todo user channel cannot be synthesized by a generic request.");
      result = executeNativeTodoUser(nativeTodoUser.input, nativeTodoUser.chats);
    } else if (subscriptionReadDefinitions.some(item => item.id === operation)
      || agentSnapshotReadDefinitions.some(item => item.id === operation)) {
      transaction(() => { recoverPending(); });
      result = subscriptionReadDefinitions.some(item => item.id === operation)
        ? await readSubscriptions(root, request) : await readAgentSnapshots(root, request);
    } else result = role ? role.kind === "human" ? executeOriginalTodoHuman(role) : executeTodo(request, undefined, undefined, undefined, role)
      : originalTodoGenesis ? executeOriginalTodoGenesis(request, originalTodoGenesis, experimentalTodoGenesisFault)
      : assignment ? executeTodo(request, undefined, undefined, assignment)
      : originalNoteCreate ? executeTodo(request, legacyNoteOperationId, originalNoteCreate)
      : request.operation.startsWith("memory.record.") ? executeMemory(request) : execute(request, legacyNoteOperationId);
    parentPort!.postMessage({ id, result });
  }
  catch (error) {
    if (error instanceof LegacyProjectCommandError || error instanceof LegacyControlImportError) error = new CoreError(error.code, error.message);
    if (error instanceof CollaborationStateError) error = new CoreError(
      error.code === "OPERATION_CONFLICT" || error.code === "REVISION_CONFLICT" ? "CONFLICT" : error.code, error.message);
    const busy = error instanceof Error && /database is locked|database is busy/.test(error.message);
    if (!(error instanceof CoreError) && !busy) console.error("PKM next storage:", error);
    const pending = !!db.prepare("SELECT 1 FROM pending_write WHERE singleton=1").get()
      || !!db.prepare("SELECT 1 FROM pending_todo WHERE singleton=1").get()
      || !!db.prepare("SELECT 1 FROM pending_asset WHERE singleton=1").get()
      || !!db.prepare("SELECT 1 FROM pending_resource WHERE singleton=1").get()
      || !!db.prepare("SELECT 1 FROM pending_document_lifecycle WHERE singleton=1").get()
      || !!db.prepare("SELECT 1 FROM pending_project_mutation WHERE singleton=1").get()
      || !!db.prepare("SELECT 1 FROM data_runtime_intents").get()
      || !!db.prepare("SELECT 1 FROM migration_runtime_intents").get() || remoteRuntimePending(db)
      || !!db.prepare("SELECT 1 FROM legacy_note_workitems_intent").get();
    const noteIntent = db.prepare("SELECT operation_id,actor_id FROM legacy_note_workitems_intent WHERE singleton=1")
      .get() as { operation_id: string; actor_id: string } | undefined;
    const provenNoteRejection = error instanceof CoreError && error.effect === "not-committed" && request
      && !!legacyNoteOperationId && legacyNoteOperationId === noteIntent?.operation_id
      && request.actorId === noteIntent.actor_id && request.args.operationId === noteIntent.operation_id
      && !db.prepare("SELECT 1 FROM pending_todo WHERE singleton=1").get()
      && !db.prepare("SELECT 1 FROM receipts WHERE operation_id=?").get(noteIntent.operation_id);
    parentPort!.postMessage({ id, error: {
      code: error instanceof CoreError ? error.code : busy ? "BUSY" : "STORAGE_ERROR",
      message: error instanceof Error ? error.message : String(error),
      ...(error instanceof ExperimentalTodoGenesisFault ? { experimentalTodoGenesisCheckpoint: error.checkpoint } : {}),
      effect: provenNoteRejection ? "not-committed"
        : pending || !(error instanceof CoreError || busy) ? "unknown" : error instanceof CoreError ? error.effect : "not-committed",
    } });
  } finally { activeRuntimeOwner = undefined; }
});
parentPort!.postMessage({ ready: true });
