import { createHash } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { applyOriginalManagedTaskActionStarted } from "./original-mcp-api-chat-task-action.js";
import { CoreError } from "./host-composition-legacy-batch15-errors.js";
import { createChatSessionStore } from "./chat-session-store.js";
import { originalNativeChatDigest } from "./original-mcp-api-chat-contracts.js";
import { assertManagedTaskAdmission, managedTaskAuthorityFailure,
  type ManagedTaskAdmission } from "./managed-chat-task-admission.js";
import { managedTaskDefinitions, type ManagedTaskOperation, type ManagedTaskSnapshot } from "./managed-chat-task-contracts.js";
import { readOriginalMcpJournal } from "./original-mcp-root-custody.js";
import { toolResultContent } from "./domain/tool-gateway-projection.js";
import type { ToolGatewayResult } from "./tool-gateway-contracts.js";
import { originalManagedTaskAdoptionBegin, originalManagedTaskAdoptionStoredProof } from "./managed-chat-task-adoption-contracts.js";
import { originalManagedTaskAdoptionProvenance, readOriginalManagedTaskAdoptionReceipt } from "./managed-chat-task-adoption-state.js";
import { resumeReviewedOriginalManagedGoal } from "./managed-chat-task-adoption-goal.js";
import {
  prepareWorkGoal, reportWork, validateHarnessReport, recordWorkGoalTransition, workGoalInputs,
  validWorkGoal, currentTaskReport, newWorkGoal, type ApiConversation, type ChatMessage,
  type ChatWorkGoal, type HarnessReport, type TaskToolEvidence,
} from "./managed-chat-task-original.js";

type Json = Record<string, any>;
export const managedTaskDdl = `
CREATE TABLE managed_chat_tasks(
 task_id TEXT PRIMARY KEY,actor_id TEXT NOT NULL,chat_id TEXT NOT NULL,title TEXT NOT NULL,revision INTEGER NOT NULL,
 chat_revision INTEGER NOT NULL,status TEXT NOT NULL,goal TEXT NOT NULL,context_digest TEXT NOT NULL,
 source_plan_sha256 TEXT NOT NULL,current_attempt_id TEXT NOT NULL,create_operation_id TEXT NOT NULL UNIQUE,
 owner_id TEXT NOT NULL,owner_fence INTEGER NOT NULL,native_epoch TEXT NOT NULL);
CREATE UNIQUE INDEX managed_chat_tasks_active ON managed_chat_tasks(actor_id,chat_id) WHERE status!='cancelled';
CREATE TABLE managed_chat_task_attempts(
 ordinal INTEGER PRIMARY KEY AUTOINCREMENT,attempt_id TEXT NOT NULL UNIQUE,task_id TEXT NOT NULL,input_id TEXT NOT NULL UNIQUE,reply_id TEXT NOT NULL UNIQUE,
 request_id TEXT NOT NULL UNIQUE,status TEXT NOT NULL,plan_sha256 TEXT,created_at INTEGER NOT NULL,
 hard_tool_round_limit INTEGER,model_sha256 TEXT NOT NULL,native_model_id TEXT NOT NULL,
 FOREIGN KEY(task_id) REFERENCES managed_chat_tasks(task_id));
CREATE TABLE managed_chat_task_harness(
 task_id TEXT NOT NULL,attempt_id TEXT NOT NULL,sequence INTEGER NOT NULL,report_id TEXT NOT NULL UNIQUE,report TEXT NOT NULL,
 PRIMARY KEY(attempt_id,sequence),FOREIGN KEY(task_id) REFERENCES managed_chat_tasks(task_id));
CREATE TRIGGER managed_chat_task_harness_no_update BEFORE UPDATE ON managed_chat_task_harness
BEGIN SELECT RAISE(ABORT,'canonical Task Harness immutable'); END;
CREATE TRIGGER managed_chat_task_harness_no_delete BEFORE DELETE ON managed_chat_task_harness
BEGIN SELECT RAISE(ABORT,'canonical Task Harness immutable'); END;`;
export function initializeManagedChatTasks(db: DatabaseSync) {
  if (!db.isTransaction) throw new CoreError("TRANSACTION_REQUIRED", "Task schema belongs to the existing Core migration transaction.");
  if (!db.prepare("SELECT 1 FROM sqlite_master WHERE name='managed_chat_tasks'").get()) db.exec(managedTaskDdl);
  verifySchema(db);
}
function verifySchema(db: DatabaseSync) {
  const expected = new (db.constructor as typeof DatabaseSync)(":memory:");
  const query = "SELECT type,name,tbl_name,sql FROM sqlite_master WHERE name LIKE 'managed_chat_task%' ORDER BY name";
  try {
    expected.exec(managedTaskDdl);
    if (JSON.stringify(db.prepare(query).all()) !== JSON.stringify(expected.prepare(query).all()))
      throw new CoreError("STATE_CORRUPT", "Canonical Task schema or immutable Harness guards changed.");
  } finally { expected.close(); }
}
function fail(message: string): never { throw new CoreError("INVALID_ARGUMENT", message); }
function checkedGoal(raw: unknown): ChatWorkGoal {
  const value = JSON.parse(String(raw));
  if (!validWorkGoal(value)) throw new CoreError("STATE_CORRUPT", "Original Task goal state is corrupt; no state was discarded.");
  return value;
}

/** No connection, scheduler, model or receipts are owned here: the parent worker owns all of them. */
export function createManagedChatTaskStore(db: DatabaseSync, root: string) {
  const chats = createChatSessionStore(db);
  const task = (id: string, actorId: string): Json | undefined =>
    db.prepare("SELECT * FROM managed_chat_tasks WHERE task_id=? AND actor_id=?").get(id, actorId);
  const attempt = (id: string): Json => {
    const row = db.prepare("SELECT * FROM managed_chat_task_attempts WHERE attempt_id=?").get(id);
    if (!row) throw new CoreError("NOT_FOUND", "Canonical Task attempt was not found.");
    return row;
  };
  function guard(data: ManagedTaskAdmission, owner: { ownerId?: string; fence?: number }, operation: ManagedTaskOperation, args: Json) {
    verifySchema(db);
    const { chat } = assertManagedTaskAdmission(db, root, data, owner, operation), g = data.guard, row = task(g.taskId, g.actorId);
    if (operation === "chat.task.adopt") {
      if (g.mode !== "adopt" || args.operationId !== g.creationOperationId || row && row.create_operation_id !== args.operationId)
        managedTaskAuthorityFailure("The actual exact adoption operation is required before receipt replay.");
      return;
    }
    if (!chat) managedTaskAuthorityFailure("An actual canonical Chat is required.");
    const start = operation === "chat.task.start";
    if ((start || operation === "chat.task.attempt.start") && args.operationId !== g.creationOperationId)
      managedTaskAuthorityFailure("The exact native Task operation identity changed.");
    if (start && !row) {
      if (g.mode !== "start" || chat.revision !== g.initialChatRevision || g.expectedTaskRevision !== null)
        managedTaskAuthorityFailure("The fresh Chat changed before atomic Task/input creation.");
      if (g.replacement) {
        const previous = task(g.replacement.taskId, g.actorId);
        if (!previous || previous.chat_id !== g.chatId || previous.status === "cancelled"
          || previous.revision !== g.replacement.revision || previous.current_attempt_id !== g.replacement.attemptId
          || originalNativeChatDigest(JSON.parse(String(previous.goal))) !== g.replacement.goalSha256
          || previous.owner_id !== g.ownerLease.ownerId || previous.owner_fence !== g.ownerLease.fence
          || previous.native_epoch !== g.nativeEpoch || previous.source_plan_sha256 !== g.sourcePlanSha256
          || !["complete", "cancelled", "failed"].includes(String(attempt(previous.current_attempt_id).status))
          || !["succeeded", "failed"].includes(String(db.prepare(
            "SELECT status FROM original_api_chat_request_state WHERE request_id=?")
            .get(attempt(previous.current_attempt_id).request_id)?.status)))
          managedTaskAuthorityFailure("The separately reviewed previous Task is not exact and reconciled; never replace UNKNOWN effects.");
      }
      return;
    }
    if (!row || row.chat_id !== g.chatId || row.chat_revision !== chat.revision
      || row.owner_id !== g.ownerLease.ownerId || row.owner_fence !== g.ownerLease.fence
      || row.native_epoch !== g.nativeEpoch || row.context_digest !== g.contextDigest || row.source_plan_sha256 !== g.sourcePlanSha256)
      managedTaskAuthorityFailure("The current same-actor Task/Chat/owner/source binding changed.");
    if (g.expectedTaskRevision !== row.revision)
      throw new CoreError("CONFLICT", "The canonical Task changed before its worker transaction.");
    if (operation === "chat.task.attempt.start" && g.manualOrigin) {
      const m = g.manualOrigin, previous = attempt(row.current_attempt_id);
      const reply = db.prepare("SELECT record FROM chat_session_messages WHERE actor_id=? AND chat_id=? AND id=?")
        .get(g.actorId, g.chatId, m.retryOfReplyId);
      const input = db.prepare("SELECT record FROM chat_session_messages WHERE actor_id=? AND chat_id=? AND id=?")
        .get(g.actorId, g.chatId, m.originalInputId);
      const link = input && JSON.parse(String(input.record)).metadata?.planning;
      const native = db.prepare("SELECT status FROM original_native_chat_executions WHERE request_id=?").get(m.nativeRequestId);
      const uncertain = db.prepare(`SELECT count(*) AS n FROM original_native_chat_events WHERE request_id=?
        AND (type IN ('tool-result','tool-failed') AND json_extract(payload,'$.effect')='unknown'
          OR type='tool-failed' AND json_extract(payload,'$.effect')='committed')`).get(m.nativeRequestId);
      const unfinished = db.prepare(`SELECT count(*) AS n FROM original_native_chat_events i WHERE i.request_id=?
        AND i.type='tool-intent' AND NOT EXISTS (SELECT 1 FROM original_native_chat_events e WHERE e.request_id=i.request_id
          AND e.type IN ('tool-result','tool-failed') AND json_extract(e.payload,'$.callId')=json_extract(i.payload,'$.callId'))`)
        .get(m.nativeRequestId);
      if (row.status === "cancelled" || row.revision !== m.revision || previous.attempt_id !== m.retryOfAttemptId
        || previous.reply_id !== m.retryOfReplyId || previous.request_id !== m.nativeRequestId
        || originalNativeChatDigest(JSON.parse(String(row.goal))) !== m.goalSha256
        || !reply || !["failed", "cancelled", "interrupted"].includes(JSON.parse(String(reply.record)).status)
        || !["failed", "cancelled"].includes(String(previous.status))
        || !["failed", "cancelled"].includes(String(native?.status)) || Number(uncertain?.n) !== 0 || Number(unfinished?.n) !== 0
        || link?.schema !== "pkm.original-portal-task-link/v1" || link.requestId !== m.requestId
        || link.contextId !== m.contextId || link.pairId !== m.pairId || link.replyId !== m.originalReplyId
        || link.inputId !== m.originalInputId || link.taskId !== g.taskId || link.sourcePlanSha256 !== g.sourcePlanSha256
        || link.nativeEpoch !== g.nativeEpoch)
        managedTaskAuthorityFailure("An exact failed/cancelled reply and reviewed same-Task manual intent are required; uncertain tool effects cannot replay.");
    }
    if (start && row.create_operation_id !== args.operationId)
      throw new CoreError("CONFLICT", "This Task identity already belongs to another operation.");
    if (!start && operation !== "chat.task.attempt.start" && row.current_attempt_id !== g.attemptId)
      managedTaskAuthorityFailure("The native request belongs to a stale Task attempt.");
    if (!["chat.task.get", "chat.task.cancel", "chat.task.attempt.finish", "chat.task.attempt.start"].includes(operation) && row.status !== "active")
      managedTaskAuthorityFailure("The current Task is paused or cancelled.");
  }
  function execution(row: Json, a: Json, required: boolean): Json | undefined {
    if (!a.plan_sha256 || !db.prepare("SELECT 1 FROM sqlite_master WHERE name='original_native_chat_executions'").get()) {
      if (required) managedTaskAuthorityFailure("The Task attempt has no actual bound native execution.");
      return;
    }
    const actual = db.prepare("SELECT * FROM original_native_chat_executions WHERE request_id=?").get(a.request_id);
    if (!actual) {
      if (required) managedTaskAuthorityFailure("The native execution has not durably begun.");
      return;
    }
    const plan = JSON.parse(String(actual.plan));
    if (actual.plan_sha256 !== a.plan_sha256 || originalNativeChatDigest(plan) !== a.plan_sha256
      || plan.requestId !== a.request_id || plan.sourcePlanSha256 !== row.source_plan_sha256
      || !String(plan.chatUrl).endsWith(`/${row.chat_id}`))
      managedTaskAuthorityFailure("Native execution and Task intent lost their exact plan/source binding.");
    const nativeModel = db.prepare(`SELECT model_selection
      FROM original_api_chat_current_chats WHERE id=?`).get(row.chat_id);
    const model = JSON.parse(String(nativeModel?.model_selection));
    if (actual.native_model_id !== a.native_model_id || model.wireModelId !== a.native_model_id
      || originalNativeChatDigest(model) !== a.model_sha256 || plan.hardToolRoundLimit !== a.hard_tool_round_limit
      || plan.outputTokenCap !== model.outputTokenCap || plan.budget.maxInputTokens !== model.budget.maxInputTokens
      || plan.budget.maxTotalOutputTokens !== model.budget.maxTotalOutputTokens
      || plan.budget.deadlineMs < 1 || plan.budget.deadlineMs > model.budget.deadlineMs)
      managedTaskAuthorityFailure("The actual native model, permission or budget differs from this Task admission.");
    const inputs = db.prepare(`SELECT record FROM chat_session_messages WHERE actor_id=? AND chat_id=?
      AND json_extract(record,'$.taskId')=? AND json_extract(record,'$.role')='user'
      AND sequence<=(SELECT sequence FROM chat_session_messages WHERE actor_id=? AND chat_id=? AND id=?)`)
      .all(row.actor_id, row.chat_id, row.task_id, row.actor_id, row.chat_id, a.input_id);
    if (inputs.some(input => !plan.messages.some((message: Json) =>
      message.role === "user" && message.content === JSON.parse(String(input.record)).content)))
      managedTaskAuthorityFailure("An original Task instruction was omitted or rewritten in the provider plan.");
    return actual;
  }
  function evidence(row: Json, a: Json): TaskToolEvidence[] {
    const actual = execution(row, a, false);
    if (!actual) return [];
    const events = db.prepare(`SELECT type,payload FROM original_native_chat_events
      WHERE request_id=? AND type IN ('tool-intent','tool-result') ORDER BY sequence`).all(a.request_id);
    const calls = new Map<string, Json>(), results: TaskToolEvidence[] = [];
    for (const event of events) {
      const payload = JSON.parse(String(event.payload));
      if (event.type === "tool-intent") {
        if (calls.has(payload.callId)) throw new CoreError("STATE_CORRUPT", "Ambiguous actual native evidence call identity.");
        calls.set(payload.callId, payload);
      } else {
        const intent = calls.get(payload.callId);
        if (!intent || !payload.executionId || !["not-committed", "committed"].includes(payload.effect)) continue;
        const workspaceId = readOriginalMcpJournal(root)?.workspaceId;
        if (!workspaceId) managedTaskAuthorityFailure("Original-root canonical receipt ownership is unavailable.");
        const owned = db.prepare(`SELECT r.*,b.context_json,b.operation_id AS bound_operation,e.actor,e.tool,e.arguments_json,
          e.status AS execution_status,e.created_at,e.updated_at FROM approval_bridge_runs r
          JOIN approval_bridge_bindings b ON b.execution_id=r.execution_id
          JOIN execution_records e ON e.id=r.execution_id
          WHERE r.execution_id=? AND r.actor_id=? AND r.workspace_id=?`).get(payload.executionId, row.actor_id, workspaceId);
        if (!owned || owned.actor !== row.actor_id || owned.operation_id !== intent.operationId
          || owned.bound_operation !== intent.operationId || !["succeeded", "failed"].includes(String(owned.status))
          || owned.execution_status !== owned.status || typeof owned.result_json !== "string") continue;
        const context = JSON.parse(String(owned.context_json)), result = JSON.parse(owned.result_json);
        const actualArgs = JSON.parse(String(owned.arguments_json)); delete actualArgs.operationId;
        if (context.turnId !== a.request_id || context.contextDigest !== a.plan_sha256
          || originalNativeChatDigest(actualArgs) !== intent.argumentsSha256
          || result.schema !== "pkm.tool-result/v1" || result.effect !== payload.effect
          || result.status !== (owned.status === "succeeded" ? "complete" : "failed")) continue;
        const content = toolResultContent(result as ToolGatewayResult);
        if (payload.contentSha256 !== originalNativeChatDigest(content)) continue;
        const name = /worker|^agent\./.test(String(owned.tool)) ? "worker_evidence_uncomposed"
          : String(owned.tool).startsWith("chat.task.")
            ? owned.tool === "chat.task.report_work" ? "report_work" : owned.tool === "chat.task.get" ? "session_info" : "record_harness"
            : String(intent.name);
        results.push({ id: String(payload.callId), name, arguments: JSON.stringify(intent.arguments),
          status: owned.status === "succeeded" ? "complete" : "failed", result: content,
          startedAt: Number(owned.created_at), finishedAt: Number(owned.updated_at) });
      }
    }
    return results;
  }
  function view(row: Json, current: Json): { chat: ApiConversation; reply: ChatMessage } {
    const inputRows = db.prepare(`SELECT record FROM chat_session_messages WHERE actor_id=? AND chat_id=?
      AND json_extract(record,'$.taskId')=? AND json_extract(record,'$.role')='user' ORDER BY sequence`)
      .all(row.actor_id, row.chat_id, row.task_id);
    if (inputRows.length > 64) fail("Review and explicitly consolidate Task inputs before further continuation.");
    const messages = inputRows.map(item => JSON.parse(String(item.record)) as ChatMessage);
    const goal = checkedGoal(row.goal);
    if (goal.executionDigest !== row.context_digest
      || !messages.some(message => message.id === goal.inputId && message.content === goal.objective)
      || !messages.some(message => message.id === goal.attemptInputId))
      throw new CoreError("STATE_CORRUPT", "The goal lost its exact original user input/context binding.");
    const attempts = db.prepare("SELECT * FROM managed_chat_task_attempts WHERE task_id=? ORDER BY ordinal").all(row.task_id);
    let reply: ChatMessage | undefined;
    for (const a of attempts) {
      const reports = db.prepare("SELECT report FROM managed_chat_task_harness WHERE attempt_id=? ORDER BY sequence")
        .all(a.attempt_id).map(item => JSON.parse(String(item.report)) as HarnessReport);
      const message: ChatMessage = { id: String(a.reply_id), role: "assistant", content: "", taskId: String(row.task_id),
        inputId: String(a.input_id), status: a.status === "bound" ? "streaming" : String(a.status),
        progress: { attemptId: String(a.attempt_id), status: a.status === "bound" ? "running" : String(a.status) },
        harnessReports: reports, toolCalls: evidence(row, a) };
      messages.push(message);
      if (a.attempt_id === current.attempt_id) reply = message;
    }
    if (!reply) throw new CoreError("STATE_CORRUPT", "The canonical Task lost its current attempt.");
    return { chat: { id: String(row.chat_id), sessionId: String(row.task_id), includeHistory: true,
      messages, workGoal: goal }, reply };
  }
  function snapshot(row: Json): ManagedTaskSnapshot {
    const a = attempt(String(row.current_attempt_id)), { chat, reply } = view(row, a);
    const adoption = readOriginalManagedTaskAdoptionReceipt(db, root, String(row.chat_id));
    return {
      schema: "pkm.chat.managed-task/v1", taskId: String(row.task_id), chatId: String(row.chat_id), title: String(row.title),
      revision: Number(row.revision), chatRevision: Number(row.chat_revision), status: row.status,
      goal: checkedGoal(row.goal), attempt: { id: String(a.attempt_id), inputId: String(a.input_id), replyId: String(a.reply_id),
        requestId: String(a.request_id), status: a.status, planSha256: a.plan_sha256 === null ? null : String(a.plan_sha256) },
      sourceInputIds: workGoalInputs(chat), harnessReports: JSON.parse(JSON.stringify(reply.harnessReports ?? [])),
      sourceInputs: chat.messages.filter(message => message.role === "user").map(message => ({
        id: message.id, content: message.content, sha256: createHash("sha256").update(message.content).digest("hex"),
      })), latestTaskReport: JSON.parse(JSON.stringify(currentTaskReport(chat) ?? null)), harnessScope: "current-attempt",
      taskCompletion: "not-claimed", replay: "never", authority: "current-native",
      ...(adoption ? { adoption: originalManagedTaskAdoptionProvenance(adoption) } : {}),
    };
  }
  function origin(row: Json, a: Json, operation: ManagedTaskOperation, args: Json) {
    const native = execution(row, a, true)!;
    if (native.status !== "running" || a.status !== "bound" || row.status !== "active") managedTaskAuthorityFailure("Reports require the current running native attempt.");
    const expectedName = operation === "chat.task.report_work" ? "report_work" : "record_harness";
    const plain = { ...args }; delete plain.operationId;
    const intents = db.prepare(`SELECT payload FROM original_native_chat_events WHERE request_id=? AND type='tool-intent'
      AND json_extract(payload,'$.operationId')=?`).all(a.request_id, args.operationId);
    if (intents.length !== 1) managedTaskAuthorityFailure("A report must originate from one actual durable native tool intent.");
    const intent = JSON.parse(String(intents[0].payload));
    if (intent.name !== expectedName || originalNativeChatDigest(plain) !== intent.argumentsSha256)
      managedTaskAuthorityFailure("Caller arguments differ from the actual native report proposal.");
    const binding = db.prepare(`SELECT b.context_json,e.tool,e.actor FROM approval_bridge_bindings b
      JOIN execution_records e ON e.id=b.execution_id WHERE b.operation_id=?`).get(args.operationId);
    if (!binding || binding.actor !== row.actor_id || binding.tool !== operation
      || JSON.parse(String(binding.context_json)).turnId !== a.request_id
      || JSON.parse(String(binding.context_json)).contextDigest !== a.plan_sha256)
      managedTaskAuthorityFailure("The report has no same-owner canonical approval/tool dispatch binding.");
  }
  function execute(operation: ManagedTaskOperation, args: Json, data: ManagedTaskAdmission) {
    if (!db.isTransaction) throw new CoreError("TRANSACTION_REQUIRED", "Task effects and parent receipts share the canonical worker transaction.");
    const g = data.guard;
    const portalMetadata = g.manualOrigin ? { metadata: {
      schema: "pkm.chat.transcript-metadata/v1", planning: { schema: "pkm.original-portal-manual-link/v1",
        ...g.manualOrigin, taskId: g.taskId, inputId: g.inputId, replyId: g.replyId,
        nativeRequestId: g.requestId, nativeEpoch: g.nativeEpoch, sourcePlanSha256: g.sourcePlanSha256 },
    } } : g.portalOrigin ? { metadata: {
      schema: "pkm.chat.transcript-metadata/v1", planning: { schema: "pkm.original-portal-task-link/v1",
        ...g.portalOrigin, taskId: g.taskId, inputId: g.inputId, replyId: g.replyId,
        nativeRequestId: g.requestId, nativeEpoch: g.nativeEpoch, sourcePlanSha256: g.sourcePlanSha256 },
    } } : {};
    if (operation === "chat.task.adopt") {
      const begin = originalManagedTaskAdoptionBegin.parse(args), proof = data.adoption;
      if (!proof || begin.operationId !== g.creationOperationId || begin.adoptionSha256 !== originalNativeChatDigest(proof)
        || begin.taskId !== g.taskId || begin.attemptId !== g.attemptId || begin.inputId !== g.inputId || begin.replyId !== g.replyId
        || begin.requestId !== g.requestId || begin.chatId !== g.chatId || begin.prompt !== g.prompt
        || newWorkGoal.test(g.prompt) || !validWorkGoal(proof.source.goal))
        managedTaskAuthorityFailure("The exact preserved identity/adoption/continuation request changed.");
      let session = chats.execute({ operation: "chat.session.create", args: { id: g.chatId, title: proof.source.chatTitle,
        operationId: args.operationId, expectedRevision: 0 } }, g.actorId) as Json;
      for (const message of proof.source.messages) {
        const appended = chats.execute({ operation: "chat.session.append", args: { id: g.chatId, expectedRevision: session.revision,
          operationId: args.operationId, message } }, g.actorId) as Json;
        session = appended.session;
      }
      const appended = chats.execute({ operation: "chat.session.append", args: { id: g.chatId, expectedRevision: session.revision,
        operationId: args.operationId, message: { id: g.inputId, taskId: g.taskId, role: "user", content: g.prompt,
          status: "complete", inputOrigin: "agent", ...portalMetadata } } }, g.actorId) as Json;
      const goal = resumeReviewedOriginalManagedGoal(proof.source, { inputId: g.inputId, prompt: g.prompt, contextDigest: g.contextDigest });
      db.prepare("INSERT INTO managed_chat_tasks VALUES(?,?,?,?,1,?,'active',?,?,?,?,?,?,?,?)")
        .run(g.taskId, g.actorId, g.chatId, proof.source.taskTitle, appended.session.revision, JSON.stringify(goal),
          g.contextDigest, g.sourcePlanSha256, g.attemptId, args.operationId, g.ownerLease.ownerId, g.ownerLease.fence, g.nativeEpoch);
      db.prepare(`INSERT INTO managed_chat_task_attempts(attempt_id,task_id,input_id,reply_id,request_id,status,plan_sha256,created_at,
        hard_tool_round_limit,model_sha256,native_model_id) VALUES(?,?,?,?,?,'prepared',NULL,?,?,?,?)`)
        .run(g.attemptId, g.taskId, g.inputId, g.replyId, g.requestId, Date.now(), g.hardToolRoundLimit, g.modelSha256, g.nativeModelId);
      db.prepare("INSERT INTO original_api_chat_current_chats VALUES(?,?,?,?)")
        .run(g.chatId, proof.source.namespace, JSON.stringify(proof.review.selection), g.requestId);
      const stored = originalManagedTaskAdoptionStoredProof.parse({ proof, begin,
        nativeHostReceiptSha256: g.nativeHostReceiptSha256, nativeEpoch: g.nativeEpoch,
        ownerId: g.ownerLease.ownerId, ownerFence: g.ownerLease.fence });
      return { ...snapshot(task(g.taskId, g.actorId)!), adoption: originalManagedTaskAdoptionProvenance(stored), adoptionProof: stored };
    }
    if (operation === "chat.task.start" || operation === "chat.task.attempt.start") {
      const definition = managedTaskDefinitions.find(item => item.id === operation)!;
      const parsed = definition.input.parse(args);
      if (!("prompt" in parsed) || parsed.taskId !== g.taskId || parsed.attemptId !== g.attemptId
        || parsed.inputId !== g.inputId || parsed.replyId !== g.replyId || parsed.requestId !== g.requestId
        || parsed.chatId !== g.chatId || parsed.prompt !== g.prompt || parsed.expectedChatRevision !== g.initialChatRevision)
        managedTaskAuthorityFailure("The exact native Task/input/attempt admission changed.");
      const previous = task(g.taskId, g.actorId);
      if (operation === "chat.task.start" ? !!previous || !newWorkGoal.test(g.prompt) : !previous || newWorkGoal.test(g.prompt))
        fail("Create requires an explicit new Task; an existing Task attempt cannot silently replace its goal.");
      if (previous && !["complete", "cancelled", "failed"].includes(String(attempt(previous.current_attempt_id).status)))
        fail("Reconcile or cancel the previous native attempt before starting another.");
      if (previous && checkedGoal(previous.goal).status === "resolved" && !g.manualOrigin)
        fail("A resolved goal is not silently replaced by another attempt.");
      const currentChat = chats.execute({ operation: "chat.session.get", args: { id: g.chatId } }, g.actorId) as Json;
      if (currentChat.revision !== g.initialChatRevision) throw new CoreError("CONFLICT", "Chat revision changed.");
      const appended = chats.execute({ operation: "chat.session.append", args: { id: g.chatId, expectedRevision: g.initialChatRevision,
        operationId: args.operationId, message: { id: g.inputId, taskId: g.taskId, role: "user", content: g.prompt,
          status: "complete", inputOrigin: "agent", ...portalMetadata } } }, g.actorId) as Json;
      const chat: ApiConversation = previous ? view(previous, attempt(previous.current_attempt_id)).chat
        : { id: g.chatId, sessionId: g.taskId, includeHistory: true, messages: [
          { id: g.inputId, taskId: g.taskId, role: "user", content: g.prompt, status: "complete" },
        ] };
      if (g.manualOrigin && chat.workGoal?.status === "resolved") chat.workGoal = recordWorkGoalTransition({
        ...chat.workGoal, attemptInputId: g.inputId, executionDigest: g.contextDigest,
        acceptance: chat.workGoal.acceptance.map(item => ({ ...item, verified: false, evidenceCallIds: [] })),
      }, "active", "user_resumed", g.inputId);
      prepareWorkGoal(chat, g.inputId, g.prompt, g.contextDigest);
      if (!chat.workGoal || chat.workGoal.attemptInputId !== g.inputId) fail("The input did not create/resume the current original work goal.");
      if (!previous && g.replacement)
        db.prepare("UPDATE managed_chat_tasks SET status='cancelled' WHERE task_id=? AND actor_id=?")
          .run(g.replacement.taskId, g.actorId);
      if (!previous) db.prepare("INSERT INTO managed_chat_tasks VALUES(?,?,?,?,1,?,'active',?,?,?,?,?,?,?,?)")
        .run(g.taskId, g.actorId, g.chatId, currentChat.title, appended.session.revision, JSON.stringify(chat.workGoal),
          g.contextDigest, g.sourcePlanSha256, g.attemptId, args.operationId, g.ownerLease.ownerId, g.ownerLease.fence, g.nativeEpoch);
      else db.prepare("UPDATE managed_chat_tasks SET revision=revision+1,chat_revision=?,status='active',goal=?,current_attempt_id=? WHERE task_id=?")
        .run(appended.session.revision, JSON.stringify(chat.workGoal), g.attemptId, g.taskId);
      db.prepare(`INSERT INTO managed_chat_task_attempts(attempt_id,task_id,input_id,reply_id,request_id,status,plan_sha256,created_at,
        hard_tool_round_limit,model_sha256,native_model_id) VALUES(?,?,?,?,?,'prepared',NULL,?,?,?,?)`)
        .run(g.attemptId, g.taskId, g.inputId, g.replyId, g.requestId, Date.now(), g.hardToolRoundLimit, g.modelSha256, g.nativeModelId);
      return snapshot(task(g.taskId, g.actorId)!);
    }
    const row = task(g.taskId, g.actorId)!;
    const a = attempt(g.attemptId);
    if (operation === "chat.task.get") return snapshot(row);
    if (operation === "chat.task.attempt.bind") {
      if (a.status !== "prepared" || a.plan_sha256 !== null) fail("A Task attempt accepts one execution-plan intent only.");
      db.prepare("UPDATE managed_chat_task_attempts SET status='bound',plan_sha256=? WHERE attempt_id=?").run(args.planSha256, g.attemptId);
    } else if (operation === "chat.task.action_started") {
      applyOriginalManagedTaskActionStarted(db, g, args);
    } else if (operation === "chat.task.cancel") {
      const goal = checkedGoal(row.goal);
      const paused = goal.status === "resolved" ? goal : recordWorkGoalTransition(goal, "paused", "execution_cancelled");
      const terminal = a.status === "prepared" && a.plan_sha256 === null;
      db.prepare("UPDATE managed_chat_tasks SET status='paused',goal=? WHERE task_id=?").run(JSON.stringify(paused), g.taskId);
      db.prepare("UPDATE managed_chat_task_attempts SET status=? WHERE attempt_id=?").run(terminal ? "cancelled" : "cancel-requested", g.attemptId);
    } else if (operation === "chat.task.attempt.finish") {
      const native = execution(row, a, true)!;
      if (!["complete", "cancelled", "failed", "unknown"].includes(String(native.status))) fail("The actual provider attempt has not settled.");
      let goal = checkedGoal(row.goal), status = row.status;
      if (goal.status === "active" && native.status !== "complete") {
        goal = recordWorkGoalTransition(goal, native.status === "cancelled" ? "paused" : "interrupted",
          native.status === "cancelled" ? "execution_cancelled" : "execution_failed");
        status = native.status === "cancelled" ? "paused" : "interrupted";
      }
      const output = db.prepare("SELECT text FROM original_native_chat_text WHERE request_id=? ORDER BY sequence").all(a.request_id)
        .map(chunk => String(chunk.text)).join("");
      const appended = chats.execute({ operation: "chat.session.append", args: { id: g.chatId, expectedRevision: row.chat_revision,
        operationId: args.operationId, message: { id: a.reply_id, taskId: g.taskId, inputId: a.input_id, role: "assistant", content: output,
          status: native.status === "complete" ? "complete" : native.status === "cancelled" ? "cancelled"
            : native.status === "unknown" ? "interrupted" : "failed" } } }, g.actorId) as Json;
      db.prepare("UPDATE managed_chat_tasks SET status=?,goal=?,chat_revision=? WHERE task_id=?")
        .run(status, JSON.stringify(goal), appended.session.revision, g.taskId);
      db.prepare("UPDATE managed_chat_task_attempts SET status=? WHERE attempt_id=?").run(native.status, g.attemptId);
    } else {
      origin(row, a, operation, args);
      const { chat, reply } = view(row, a), reportArgs = { ...args }; delete reportArgs.operationId;
      if (operation === "chat.task.report_work") {
        reportWork(chat, reply, reportArgs);
        db.prepare("UPDATE managed_chat_tasks SET goal=? WHERE task_id=?").run(JSON.stringify(chat.workGoal), g.taskId);
      } else {
        const cited = Array.isArray(reportArgs.evidenceCallIds) ? reportArgs.evidenceCallIds : [];
        if (chat.messages.flatMap(message => message.toolCalls ?? []).some(call =>
          cited.includes(call.id) && call.name === "worker_evidence_uncomposed"))
          managedTaskAuthorityFailure("Worker result/version evidence is not composed for this fresh Task foundation.");
        const report = validateHarnessReport(chat, reply, reportArgs);
        db.prepare("INSERT INTO managed_chat_task_harness VALUES(?,?,?,?,?)").run(g.taskId, g.attemptId,
          Number(db.prepare("SELECT count(*) AS n FROM managed_chat_task_harness WHERE attempt_id=?").get(g.attemptId)!.n) + 1,
          report.id, JSON.stringify(report));
      }
    }
    db.prepare("UPDATE managed_chat_tasks SET revision=revision+1 WHERE task_id=?").run(g.taskId);
    return snapshot(task(g.taskId, g.actorId)!);
  }
  return { guard, execute };
}
