import { parentPort, workerData } from "node:worker_threads";
import { DatabaseSync } from "node:sqlite";
import { join } from "node:path";
import { readFileSync } from "node:fs";
import { CoreError, type StorageRequest } from "./contracts.js";
import { atomicMarkdownWrite, decodeMarkdown, encodeMarkdown, readMarkdown, scanMarkdown, sha256, type MarkdownRecord } from "./markdown.js";
import { atomicBoardWrite, planTodo, scanBoards } from "./boards.js";
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
import { activateReadoptedMemoryScope, deactivateMemoryScopeContinuity,
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
import { nativeTodoUserDdl, nativeTodoUserInput, nativeTodoUiChats, planNativeTodoUser, nativeTodoUserFingerprint,
  prepareNativeTodoUserIntent, assertNativeTodoUserPending, NATIVE_TODO_USER_OPERATION,
  type NativeTodoUserInput, type NativeTodoUiChat } from "./native-todo-user-ui.js";

const workerConfiguration = workerData && typeof workerData === "object" ? workerData as {
  root?: unknown; adoptionPrivacySha256?: unknown;
} : undefined;
const root = typeof workerData === "string" ? workerData : String(workerConfiguration?.root);
const adoptionPrivacySha256 = typeof workerConfiguration?.adoptionPrivacySha256 === "string"
  ? workerConfiguration.adoptionPrivacySha256 : undefined;
const db = new DatabaseSync(join(root, "core.sqlite"));
const databaseVersion = Number(db.prepare("PRAGMA user_version").get()!.user_version);
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
initializeWorkflowRuntime(db);
initializeSyncPlanStore(db);
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
initializeLegacySnapshotRestoreSchema(db);
db.exec(LEGACY_INLINE_NOTE_JOURNAL_DDL);
db.exec(LEGACY_SHARED_SOURCE_RECEIPT_DDL);
db.exec(ACTION_RUNTIME_DDL);
db.exec(`CREATE TABLE IF NOT EXISTS native_runtime_owner (
  singleton INTEGER PRIMARY KEY CHECK(singleton=1), owner_id TEXT NOT NULL,
  fence INTEGER NOT NULL CHECK(fence>0), lease_until INTEGER NOT NULL
)`);
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
const syncPlans = new SyncPlanStore(db);
const collaboration = new CollaborationStateStore(db, { initializeSchema: false });
type IndexedDocument = Pick<MarkdownRecord["record"], "id" | "title" | "revision" | "deleted" | "sha256" | "path" | "area">;
let indexedDocuments: IndexedDocument[] | undefined;
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
  const insert = db.prepare("INSERT INTO documents(id,title,revision,deleted,sha256,path,area) VALUES(?,?,?,?,?,?,?)");
  for (const { record } of documents) insert.run(record.id, record.title, record.revision, record.deleted ? 1 : 0, record.sha256, record.path, record.area);
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
    assertNativeTodoUserPending(db, todo);
    const slug = String(todo.board_slug), raw = String(todo.after_json);
    recoverLegacyTodoBoardCreate(db, root);
    if (scanBoards(root, db).get(slug)?.raw !== raw) atomicBoardWrite(root, slug, raw, todo.before_sha256 === null ? null : String(todo.before_sha256));
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
  if (memory && (area !== "notes" || pending.result === null
    || JSON.stringify(memoryIntentResult(root, after, String(pending.operation), String(pending.operation_id))) !== String(pending.result))) {
    throw new CoreError("INVALID_WORKSPACE", "Pending memory state/result disagrees; preserve the journal for reconciliation.");
  }
  const current = readMarkdown(root, id, path, area);
  if (current?.record.sha256 !== after.record.sha256) atomicMarkdownWrite(root, id, raw, pending.before_sha256 === null ? null : String(pending.before_sha256), path, area,
    memory ? memoryTemporaryId(String(pending.operation_id)) : String(pending.operation_id));
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
  const fingerprint = syncPlanHash({ operation, actorId, args,
    ...(operation.startsWith("collaboration.state.") ? { collaborationKind: request.collaborationKind ?? "agent" } : {}) });
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
function execute(request: StorageRequest, legacyNoteOperationId?: string): unknown {
  const { operation, args, actorId, collaborationKind } = request;
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
  const fingerprint = sha256(JSON.stringify({ operation, actorId, args }));
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
  const fingerprint = sha256(JSON.stringify({ operation, actorId, args }));
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
  const fingerprint = sha256(JSON.stringify({ operation: request.operation, actorId, args }));
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
  const fingerprint = sha256(JSON.stringify({ operation, actorId, args }));
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
  const fingerprint = sha256(JSON.stringify({ operation, actorId, args }));
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
  const fingerprint = sha256(JSON.stringify({ operation, actorId, args }));
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

function executeTodo(request: StorageRequest, legacyNoteOperationId?: string, originalNoteCreate?: LegacyTodoBoardCreateArguments): unknown {
  const definition = todoDefinitions.find(item => item.id === request.operation);
  if (!definition) throw new CoreError("NOT_FOUND", "Unknown Todo operation.");
  const fingerprint = originalNoteCreate ? legacyTodoBoardCreateFingerprint(request, originalNoteCreate) : sha256(JSON.stringify(request));
  const prepared = transaction(() => {
    assertLegacyNoteIntentRequest(request, legacyNoteOperationId);
    recoverPending(legacyNoteOperationId);
    if (!definition.readOnly) {
      const receipt = db.prepare("SELECT fingerprint,result FROM receipts WHERE operation_id=?").get(String(request.args.operationId));
      if (receipt) {
        if (receipt.fingerprint !== fingerprint) throw new CoreError("CONFLICT", "operationId belongs to a different request or actor.");
        return { result: JSON.parse(String(receipt.result)) };
      }
    }
    if (request.operation === "todo.board.create") assertNativeBoardWriteTarget(root, `${String(request.args.board_slug)}.md`, db);
    const plan = planTodo(root, request, () => listTodoChats(request.actorId), db);
    if (!plan.write) return { result: plan.result };
    if (originalNoteCreate) prepareLegacyTodoBoardCreate(db, root, request, originalNoteCreate, plan.write.raw, fingerprint);
    db.prepare("INSERT INTO pending_todo VALUES(1,?,?,?,?,?,?,?,?)").run(
      String(request.args.operationId), fingerprint, request.actorId, originalNoteCreate ? LEGACY_TODO_BOARD_CREATE_PENDING_OPERATION : request.operation,
      plan.write.slug, plan.write.before, plan.write.raw, JSON.stringify(plan.result),
    );
    return { pending: true };
  });
  if ("result" in prepared) return prepared.result;
  try {
    return transaction(() => {
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

function executeMemory(request: StorageRequest): unknown {
  const { operation, args, actorId } = request;
  const definition = memoryDefinitions.find(item => item.id === operation);
  if (!definition) throw new CoreError("NOT_FOUND", "Unknown memory operation.");
  const fingerprint = sha256(JSON.stringify({ operation, actorId, args }));
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
parentPort!.on("message", async ({ id, request, close, recover, runtimeOwner, legacyNoteOperationId, originalNoteCreate, nativeTodoUser, nativeBoardLifecycle, memoryScope }: {
  id: number; request?: StorageRequest; close?: boolean; recover?: boolean; runtimeOwner?: { ownerId?: string; fence?: number };
  legacyNoteOperationId?: string;
  originalNoteCreate?: LegacyTodoBoardCreateArguments;
  nativeTodoUser?: { input: NativeTodoUserInput; chats: NativeTodoUiChat[] };
  nativeBoardLifecycle?: NativeBoardLifecycleInput;
  memoryScope?: { request: MemoryScopeContinuityRequest; approval: { decisionId: string; actorId: string; expiresAtMs: number } }
    | { revoke: true };
}) => {
  if (close) { db.close(); parentPort!.close(); return; }
  if (memoryScope) {
    try {
      assertWorkerOwner(runtimeOwner);
      if (request || recover || legacyNoteOperationId || originalNoteCreate || nativeTodoUser || nativeBoardLifecycle)
        throw new CoreError("ACCESS_DENIED", "Native Memory scope admission cannot accompany a generic request.");
      if ("revoke" in memoryScope) deactivateMemoryScopeContinuity(root);
      else activateReadoptedMemoryScope(root, memoryScope.request, memoryScope.approval);
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
    if (nativeBoardLifecycle) {
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
    } else if (subscriptionReadDefinitions.some(item => item.id === request.operation)
      || agentSnapshotReadDefinitions.some(item => item.id === request.operation)) {
      transaction(() => { recoverPending(); });
      result = subscriptionReadDefinitions.some(item => item.id === request.operation)
        ? await readSubscriptions(root, request) : await readAgentSnapshots(root, request);
    } else result = originalNoteCreate ? executeTodo(request, legacyNoteOperationId, originalNoteCreate)
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
      effect: provenNoteRejection ? "not-committed"
        : pending || !(error instanceof CoreError || busy) ? "unknown" : error instanceof CoreError ? error.effect : "not-committed",
    } });
  } finally { activeRuntimeOwner = undefined; }
});
parentPort!.postMessage({ ready: true });
