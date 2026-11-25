import { createHash, randomUUID } from "node:crypto";
import { CoreError, type Actor } from "./contracts.js";
import { assertRootOwner, type RootOwner } from "./root-owner.js";
import type { Storage } from "./storage.js";
import { assertOriginalMcpNativeHost, type OriginalMcpNativeHost } from "./original-mcp-native-host.js";
import { originalMcpNativeChatSupportedMethods } from "./original-mcp-native-chat-rpc.js";
import { originalMcpApiChatSourceDeadline } from "./original-mcp-api-chat-source.js";
import { createNativeManagedChatTasks, type NativeManagedTaskAttempt, type NativeManagedTaskStart } from "./managed-chat-task-native.js";
import type { ManagedTaskSnapshot } from "./managed-chat-task-contracts.js";
import { validWorkGoal, type TaskToolEvidence } from "./managed-chat-task-original.js";
import { originalMcpApiChatRequestsNewTask } from "./original-mcp-api-chat-task.js";
import { originalNativeChatDigest, originalNativeChatSelection, type OriginalNativeChatExecutionPlan,
  type OriginalNativeChatExecutionPort } from "./original-mcp-api-chat-contracts.js";
import {
  originalNativeTaskBinding, originalNativeTaskContextRequest, originalNativeTaskContextResult,
  originalNativeTaskExecutionMethod, type OriginalNativeManagedTaskExecutionPlan,
} from "./original-mcp-api-chat-task-execution-contracts.js";
import { readOriginalMcpNativeExecution, type createOriginalMcpNativeExecution } from "./original-mcp-api-chat-execution.js";
import type { ToolGatewayBinding, ToolGatewayResult } from "./tool-gateway-contracts.js";
import { toolResultContent } from "./domain/tool-gateway-projection.js";
import { readOriginalManagedTaskAdoptionReceipt } from "./managed-chat-task-adoption-state.js";
import { OriginalApiChatContextAssembler } from "./domain/original-api-chat-context.js";
import { ChatTurnToolError } from "./chat-turn.js";

type Json = Record<string, any>;
type Service = Awaited<ReturnType<typeof createNativeManagedChatTasks>>;
type Runner = Awaited<ReturnType<typeof createOriginalMcpNativeExecution>>;
type Session = NonNullable<OriginalMcpNativeHost["nativeChat"]>["session"];
interface Entry {
  owner: RootOwner; storage: Storage; host: OriginalMcpNativeHost; actor: Readonly<Actor>; service: Service; attempt: NativeManagedTaskAttempt;
  initial: ManagedTaskSnapshot; binding: OriginalNativeManagedTaskExecutionPlan["managedTask"];
  plan?: OriginalNativeManagedTaskExecutionPlan; planSha256?: string; evidenceKey: string; staleEndings: number;
  lastRound: number; afterToolsRound: number; settled: boolean; accepted: boolean;
  semanticFailure?: "GOAL_STALE_ENDINGS" | "GOAL_UNFINISHED" | "TASK_STATE_INVALID";
  portal?: OriginalPortalTaskFilter;
}
export interface OriginalPortalTaskFilter {
  assertCurrent(): void;
  authorizeTool(name: string, arguments_: Json): Promise<void>;
  replacement?: { taskId: string; revision: number; attemptId: string; goalSha256: string };
  origin?: { requestId: string; contextId: string; pairId: string };
  manualOrigin?: NonNullable<Parameters<Awaited<ReturnType<typeof createNativeManagedChatTasks>>["prepareAttempt"]>[2]>["manualOrigin"];
}
const portalFilters = new WeakMap<Session, Map<string, OriginalPortalTaskFilter>>();
/** Additional connection policy only: native model, Task and exact tool effect approvals remain mandatory. */
export function registerOriginalPortalTaskFilter(host: OriginalMcpNativeHost, requestId: string, filter: OriginalPortalTaskFilter) {
  if (!host.nativeChat) fail("NATIVE_TASK_AUTHENTICATED_CHANNEL_REQUIRED");
  filter.assertCurrent();
  const filters = portalFilters.get(host.nativeChat.session) ?? new Map<string, OriginalPortalTaskFilter>();
  if (filters.has(requestId)) fail("PORTAL_TASK_FILTER_ALREADY_BOUND");
  filters.set(requestId, filter); portalFilters.set(host.nativeChat.session, filters);
  return () => { if (filters.get(requestId) === filter) filters.delete(requestId); };
}
const contexts = new WeakMap<Session, Map<string, Entry>>();
const semantics: readonly ToolGatewayBinding[] = Object.freeze([
  Object.freeze({ name: "session_info", operation: "chat.task.get", approvalRequired: true }),
  Object.freeze({ name: "report_work", operation: "chat.task.report_work", approvalRequired: true }),
  Object.freeze({ name: "record_harness", operation: "chat.task.record_harness", approvalRequired: true }),
]);
const semanticNames = new Set(["session_info", "report_work", "record_harness", "finish_debug"]);
const sha = (text: string) => createHash("sha256").update(text).digest("hex");
const emptyEvidenceKey = sha(JSON.stringify([]));
function fail(message: string): never { throw new CoreError("NATIVE_AUTHORITY_REQUIRED", message); }
function registered(session: Session, plan: OriginalNativeChatExecutionPlan, bound = true) {
  const entry = contexts.get(session)?.get(plan.requestId);
  const binding = originalNativeTaskBinding.parse("managedTask" in plan ? plan.managedTask : undefined);
  if (!entry || originalNativeChatDigest(binding) !== originalNativeChatDigest(entry.binding)
    || plan.chatUrl !== entry.attempt.chatUrl || plan.sourcePlanSha256 !== entry.attempt.sourcePlanSha256
    || bound && (!entry.planSha256 || originalNativeChatDigest(plan) !== entry.planSha256))
    fail("NATIVE_TASK_CONTEXT_BINDING: an actual service-issued same-Core Task execution is required.");
  entry.attempt.assertCurrent();
  return entry;
}
function catalogue(base: readonly ToolGatewayBinding[]) {
  const result = base.filter(item => !/^(?:agent\.|worker\.|project\.recipe\.|recipe\.)/.test(item.operation)
    && !/(?:^|[._-])(?:worker|workers|recipe|checkpoint|file[_-]?version)(?:[._-]|$)/i.test(`${item.name}.${item.operation}`)
    && !["mcp.tool.capability_call", "mcp.tool.capability_read"].includes(item.operation))
    .map(item => ({ ...item }));
  for (const binding of semantics) {
    const sameName = result.find(item => item.name === binding.name);
    if (sameName && (sameName.operation !== binding.operation || sameName.approvalRequired !== true))
      fail(`NATIVE_TASK_TOOL_CATALOGUE_CONFLICT: ${binding.name}`);
    if (!sameName) result.push({ ...binding });
  }
  return result;
}

/** Executor integration hook. JSON metadata alone cannot register a context or enter the native Core scope. */
export function originalMcpApiChatTaskToolCatalog(host: OriginalMcpNativeHost, plan: OriginalNativeChatExecutionPlan,
  base: readonly ToolGatewayBinding[] = []) {
  if (!host.nativeChat) fail("NATIVE_TASK_AUTHENTICATED_CHANNEL_REQUIRED");
  registered(host.nativeChat.session, plan, false);
  return catalogue(base);
}

/** Invoke after this exact tool intent is durable, before the existing canonical tool gateway executes it. */
export async function beforeOriginalMcpApiChatTaskTool(host: OriginalMcpNativeHost, plan: OriginalNativeChatExecutionPlan,
  request: Parameters<Parameters<OriginalNativeChatExecutionPort["run"]>[1]["tool"]>[0]) {
  if (!host.nativeChat) fail("NATIVE_TASK_AUTHENTICATED_CHANNEL_REQUIRED");
  const entry = registered(host.nativeChat.session, plan);
  entry.portal?.assertCurrent();
  try { await entry.portal?.authorizeTool(request.name, request.arguments); }
  catch (error) {
    if (error instanceof Error && error.message === "PORTAL_TOOL_DIMENSION_DENIED")
      throw new ChatTurnToolError("not-committed", "PORTAL_TOOL_DIMENSION_DENIED");
    throw error;
  }
  entry.portal?.assertCurrent();
  if (semanticNames.has(request.name)) return;
  const snapshot = await entry.service.get(entry.attempt);
  entry.attempt.assertCurrent();
  if (!validWorkGoal(snapshot.goal)) fail("NATIVE_TASK_GOAL_STATE");
  if (snapshot.goal.status === "active") return;
  const { runtime } = await entry.owner.ensureFull();
  await entry.service.withinAttempt(entry.attempt, async () => {
    const response = await runtime.core.dispatch("capability_call", { operation: "chat.task.action_started", version: 1,
      arguments: { operationId: randomUUID(), callId: request.callId } }, entry.actor);
    if (response.error) throw new CoreError(response.error.code,
      `NATIVE_TASK_ACTION_REOPEN_INTERFACE_REQUIRED: ${response.error.message}`, response.error.effect);
  });
  const current = await entry.service.get(entry.attempt);
  if (!validWorkGoal(current.goal) || current.goal.status !== "active"
    || current.goal.acceptance.some(item => item.verified || item.evidenceCallIds.length))
    fail("NATIVE_TASK_ACTION_REOPEN_STATE");
}

function evidence(entry: Entry, requestId: string, planSha256: string): TaskToolEvidence[] {
  const db = entry.storage.connectNative();
  try {
    const rows = db.prepare(`SELECT i.payload AS intent,r.payload AS result,b.context_json,a.result_json,a.status,a.operation_id,
      a.actor_id,a.workspace_id,e.tool FROM original_native_chat_events i JOIN original_native_chat_events r
      ON r.request_id=i.request_id AND r.type='tool-result' AND json_extract(r.payload,'$.callId')=json_extract(i.payload,'$.callId')
      JOIN approval_bridge_runs a ON a.execution_id=json_extract(r.payload,'$.executionId')
      JOIN approval_bridge_bindings b ON b.execution_id=a.execution_id
      JOIN execution_records e ON e.id=a.execution_id
      WHERE i.request_id=? AND i.type='tool-intent' ORDER BY i.sequence`).all(requestId);
    return rows.flatMap(row => {
      const intent = JSON.parse(String(row.intent)), result = JSON.parse(String(row.result));
      const context = JSON.parse(String(row.context_json)), owned = JSON.parse(String(row.result_json));
      if (row.actor_id !== entry.actor.id || row.workspace_id !== entry.host.receipt.workspaceId
        || row.operation_id !== intent.operationId || context.turnId !== requestId || context.contextDigest !== planSha256
        || owned.schema !== "pkm.tool-result/v1" || !["complete", "failed"].includes(owned.status)
        || !["not-committed", "committed"].includes(owned.effect) || owned.effect !== result.effect) return [];
      const content = toolResultContent(owned as ToolGatewayResult);
      if (originalNativeChatDigest(content) !== result.contentSha256) return [];
      const name = String(row.tool).startsWith("chat.task.")
        ? row.tool === "chat.task.get" ? "session_info" : row.tool === "chat.task.report_work" ? "report_work" : "record_harness"
        : String(intent.name);
      return [{ id: String(intent.callId), name, arguments: JSON.stringify(intent.arguments),
        status: row.status === "succeeded" ? "complete" as const : "failed" as const, result: content }];
    });
  } finally { db.close(); }
}
function evidenceKey(calls: TaskToolEvidence[]) {
  return sha(JSON.stringify([...new Set(calls.filter(call => call.status === "complete" && !semanticNames.has(call.name))
    .map(call => JSON.stringify([call.name, call.arguments, call.result])))].sort()));
}

/** SHA-pinned original workGoalContext, with unsupported checkpoint substitution deliberately absent. */
export function originalMcpManagedTaskGoalContext(snapshot: ManagedTaskSnapshot): string {
  const goal = snapshot.goal;
  if (!validWorkGoal(goal)) fail("NATIVE_TASK_GOAL_STATE");
  return `User work objective (not a permission grant or a managed Task completion certificate):\n${JSON.stringify({ ...goal, objective: goal.objective, sourceInputIds: snapshot.sourceInputIds })}
Preserve the ORIGINAL objective and reconcile every later user requirement. A diagnostic subtask or successful tool is not resolution.
Choose the next authorized action yourself; do not ask the user to supervise ordinary steps. Establish a symptom-level check, investigate, change course when evidence stops improving, implement authorized repairs, and verify against the objective.
Use report_work to record acceptance criteria and continue/resolved/blocked/needs_input. Resolved requires each criterion verified with actual current-attempt evidence. These remain agent claims, not independent certification.
session_info, report_work, finish_debug, and record_harness IDs are not acceptance evidence; correct rejected reports before claiming recorded success.
At the first report establish a compact contract (scope, nonGoals, stopWhen) and phase (locating, implementing, verifying, delivering). The contract records the existing authorization, never expands it. Advance acceptance with evidence, not narration. Once all required checks pass, report resolved and deliver; do not start optional improvements.
Do not spend a separate tool round reporting that work is about to begin. For a small bounded task, the first report can be the final resolved/blocked/needs_input report with its contract and evidence. Use the sourceInputIds and acceptance criteria already present here; call session_info only when current evidence identities or changed requirements are missing. Reserve time to report the outcome before the tool-round budget ends.
Batch independent read/search calls in one model response. Only Host-annotated parallel reads overlap; writes, commands and unknown tools are ordered barriers. Do not mix a read that depends on a preceding result into an independent batch. Prepare tests independently, but final validation must use a ready, version-pinned implementation handoff. Do not poll independent workers.
Copy EVERY existing acceptance criterion verbatim from the current work objective (or session_info.workGoal.acceptance when a refresh is needed), including the original-objective criterion; append new criteria rather than replacing the list. Explicitly report each criterion's verified state and current-attempt evidenceCallIds. Leave unmet criteria unverified; never infer that specific subcriteria automatically verify the original objective.
If only part is done, record continue with the next action and keep working. For a genuine blocker, name the exact missing input/permission/external result and leave unverified criteria open.
Cancellation/interruption disarms work: never replay uncertain effects. A resumed attempt must inspect recorded effects before repeating any operation. Existing permission, context, queue, worker and budget guards still apply.`;
}

/** Called only by the authenticated task RPC callback route with its actual server-side session and plan. */
export async function dispatchOriginalMcpApiChatTaskContext(session: Session, plan: OriginalNativeChatExecutionPlan, input: unknown) {
  const entry = registered(session, plan), request = originalNativeTaskContextRequest.parse(input);
  if (request.bindingSha256 !== entry.binding.bindingSha256 || request.sourcePlanSha256 !== entry.attempt.sourcePlanSha256
    || request.planSha256 !== entry.planSha256 || entry.settled) fail("NATIVE_TASK_CONTEXT_BINDING");
  const { storage } = await entry.owner.ensureFull(), db = storage.connectNative();
  try {
    const current = db.prepare("SELECT current_inference,round,status FROM original_native_chat_executions WHERE request_id=?")
      .get(plan.requestId);
    const inference = db.prepare("SELECT authorized FROM original_native_chat_inferences WHERE request_id=? AND inference_id=?")
      .get(plan.requestId, request.inferenceId);
    if (!current || current.status !== "running" || current.current_inference !== request.inferenceId
      || current.round !== request.round || inference?.authorized !== 1) fail("NATIVE_TASK_CONTEXT_INFERENCE");
  } finally { db.close(); }
  if (request.phase === "after-round") {
    if (request.round !== entry.lastRound + 1) fail("NATIVE_TASK_CONTEXT_ORDER");
    entry.lastRound = request.round;
  } else if (request.round !== entry.lastRound || request.phase === "after-tools"
    && (!request.hasToolCalls || entry.afterToolsRound === request.round)) fail("NATIVE_TASK_CONTEXT_ORDER");
  const snapshot = await entry.service.get(entry.attempt);
  entry.attempt.assertCurrent();
  if (!validWorkGoal(snapshot.goal)) fail("NATIVE_TASK_GOAL_STATE");
  const key = evidenceKey(evidence(entry, plan.requestId, entry.planSha256!));
  let decision: "continue" | "finish" | "reject" = "continue", continuation: string | null = null;
  let errorCode: "GOAL_STALE_ENDINGS" | "GOAL_UNFINISHED" | "TASK_STATE_INVALID" | null = null;
  if (snapshot.status !== "active" || ["paused", "interrupted"].includes(snapshot.goal.status)) {
    decision = "reject"; errorCode = "TASK_STATE_INVALID";
  } else if (request.phase === "settled") {
    entry.settled = true;
    decision = snapshot.goal.status === "active" ? "reject" : "finish";
    if (decision === "reject") errorCode = "GOAL_UNFINISHED";
  } else if (request.phase === "after-round" && !request.hasToolCalls && !request.finalSummary) {
    if (snapshot.goal.status === "active") {
      entry.staleEndings = key === entry.evidenceKey ? entry.staleEndings + 1 : 0;
      entry.evidenceKey = key;
      if (entry.staleEndings > 1) { decision = "reject"; errorCode = "GOAL_STALE_ENDINGS"; }
      else continuation = `${originalMcpManagedTaskGoalContext(snapshot)}\nThe objective is still open. Do not stop at this subtask or summary. Choose and execute the next authorized action, or report_work with a precise remaining blocker.`;
    } else decision = "finish";
  }
  if (request.phase === "after-tools") entry.afterToolsRound = request.round;
  if (decision === "reject") { entry.settled = true; entry.semanticFailure = errorCode ?? "TASK_STATE_INVALID"; }
  if (request.phase === "settled" && decision === "finish") entry.accepted = true;
  return originalNativeTaskContextResult.parse({
    schema: "pkm.original-native-task-context/v1", requestId: plan.requestId, bindingSha256: entry.binding.bindingSha256,
    planSha256: entry.planSha256, decision, continuation, errorCode, goalStatus: snapshot.goal.status,
    taskRevision: snapshot.revision, evidenceSha256: key, stopAfterTools: false,
  });
}

/** Composition of the existing canonical Goal service and the one existing executor, never another driver. */
export async function createOriginalMcpApiChatTaskAdapter(owner: RootOwner, host: OriginalMcpNativeHost, principal: Readonly<Actor>) {
  assertRootOwner(owner);
  const { storage, runtime } = await owner.ensureFull(), actor = Object.freeze({ ...principal });
  assertOriginalMcpNativeHost(host, storage);
  if (!host.nativeChat || !originalMcpNativeChatSupportedMethods(host.nativeChat.session).some(method => String(method) === originalNativeTaskExecutionMethod))
    fail("ORIGINAL_NATIVE_CHAT_MANAGED_GOAL_COMPOSITION_REQUIRED: MISSING_NATIVE_METHOD execution.task.run.");
  catalogue(host.options.toolCatalog ?? []);
  const service = await createNativeManagedChatTasks(owner, host, actor);
  const entries = contexts.get(host.nativeChat.session) ?? new Map<string, Entry>();
  contexts.set(host.nativeChat.session, entries);
  const ownEntries = new Map<string, Entry>();
  const preparations = new WeakMap<object, { prepared: NativeManagedTaskStart; selected: { selectionId: string } }>();
  const core = async (operation: string, args: Json) => {
    const response = await runtime.core.dispatch("capability_read", { operation, version: 1, arguments: args }, actor);
    if (response.error) throw new CoreError(response.error.code, response.error.message, response.error.effect);
    return response.result as Json;
  };
  const read = <T>(work: (db: ReturnType<typeof storage.connectNative>) => T) => {
    assertOriginalMcpNativeHost(host, storage);
    const db = storage.connectNative(); try { return work(db); } finally { db.close(); }
  };
  const execution: OriginalNativeChatExecutionPort = Object.freeze({
    async run(...[plan, callbacks, signal]: Parameters<OriginalNativeChatExecutionPort["run"]>) {
      const entry = registered(host.nativeChat!.session, plan);
      if (!ownEntries.has(plan.requestId)) fail("NATIVE_TASK_EXECUTOR_OWNER");
      const open = () => { if (entry.settled) fail("NATIVE_TASK_SETTLED_EXECUTION_REFUSED"); };
      return service.execution.run(entry.plan!, {
        async beforeInference(request) { open(); await callbacks.beforeInference(request); open(); },
        async tool(request) { open(); return callbacks.tool(request); },
        async text(request) { open(); await callbacks.text(request); },
        async usage(request) { open(); await callbacks.usage(request); },
      }, signal);
    },
  });
  return Object.freeze({
    execution,
    async prepare(input: { chatId: string; requestId: string; commandId: string; prompt: string; hardToolRoundLimit: number | null },
      signal: AbortSignal) {
      const state = read(db => ({
        map: db.prepare("SELECT * FROM original_api_chat_current_chats WHERE id=?").get(input.chatId),
        source: db.prepare("SELECT 1 FROM original_api_chat_source_chats WHERE id=?").get(input.chatId),
        task: db.prepare("SELECT task_id FROM managed_chat_tasks WHERE actor_id=? AND chat_id=? AND status!='cancelled'").get(actor.id, input.chatId),
        canonical: db.prepare("SELECT 1 FROM chat_sessions WHERE actor_id=? AND id=?").get(actor.id, input.chatId),
      }));
      if (state.source && !state.task) {
        if (state.map || state.canonical)
          fail("NATIVE_TASK_ADOPTION_COLLISION: the original Chat already has independently owned canonical state.");
        const prepared = await service.prepareAdoption({ chatId: input.chatId, commandId: input.commandId,
          prompt: input.prompt, hardToolRoundLimit: input.hardToolRoundLimit, expectedChatRevision: 0,
          operationId: randomUUID() }, { signal });
        if (prepared.requestId !== input.requestId) fail("NATIVE_TASK_COMMAND_BINDING");
        service.preparedSelection(prepared);
        const token = Object.freeze({ requestId: input.requestId });
        preparations.set(token, { prepared, selected: { selectionId: service.preparedModelSelectionId(prepared) } });
        return token;
      }
      if (state.source && !read(db => readOriginalManagedTaskAdoptionReceipt(db, storage.workspaceRoot(), input.chatId)))
        fail("NATIVE_TASK_ACTUAL_ADOPTION_RECEIPT_REQUIRED");
      const chat = await core("chat.session.get", { id: input.chatId });
      if (chat.archivedAt || chat.metadata && Object.keys(chat.metadata).length)
        fail("NATIVE_TASK_FRESH_TEXT_CHAT_REQUIRED: managed/worker/checkpoint/Recipe metadata is not accepted.");
      const page = await core("chat.session.messages", { id: input.chatId, afterSequence: 0, limit: 100 });
      if (page.hasMore || page.items.some((item: Json) => !["user", "assistant", "system"].includes(item.role)
        || typeof item.content !== "string" || item.images?.length))
        fail("NATIVE_TASK_TEXT_CONTEXT_REQUIRED: bounded text history only; no image/checkpoint/worker fallback.");
      if (!state.map) fail("NATIVE_TASK_FRESH_NATIVE_CREATED_OR_ADOPTED_CHAT_REQUIRED");
      const portal = portalFilters.get(host.nativeChat!.session)?.get(input.requestId);
      portal?.assertCurrent();
      if (state.task && originalMcpApiChatRequestsNewTask(input.prompt) && !portal?.replacement)
        fail("NATIVE_TASK_EXPLICIT_REPLACEMENT_NOT_COMPOSED: use a fresh native-created Chat for another new Task.");
      const selection = originalNativeChatSelection.parse(JSON.parse(String(state.map.model_selection)));
      if (selection.protocol !== "pkm.original-api-chat-execution/v1" || selection.epoch !== host.receipt.epoch)
        fail("NATIVE_TASK_CURRENT_ORIGINAL_MODEL_REQUIRED");
      const catalogue = await host.nativeChat!.models.catalogue(signal);
      const model = catalogue.models.find(item => item.id === selection.modelId);
      if (!model || model.nativeModelId !== selection.wireModelId || selection.budget.maxInputTokens > model.maxInputTokens)
        fail("NATIVE_TASK_EXACT_MODEL_REQUIRED");
      const selected = await host.nativeChat!.models.select({ modelId: model.id, catalogueSha256: originalNativeChatDigest(catalogue) }, signal);
      if (selected.modelId !== model.id || selected.epoch !== host.receipt.epoch) fail("NATIVE_TASK_EXACT_MODEL_REQUIRED");
      const args = { chatId: input.chatId, expectedChatRevision: chat.revision, commandId: input.commandId,
        operationId: randomUUID(), prompt: input.prompt, hardToolRoundLimit: input.hardToolRoundLimit };
      const prepared = portal?.replacement ? await service.prepareReplacement(args, portal.replacement, { signal, portalOrigin: portal.origin })
        : state.task ? await service.prepareAttempt(String(state.task.task_id), args, { signal, manualOrigin: portal?.manualOrigin })
        : await service.prepareStart(args, { signal, portalOrigin: portal?.origin });
      if (prepared.requestId !== input.requestId) fail("NATIVE_TASK_COMMAND_BINDING");
      const currentSelection = read(db => db.prepare("SELECT model_selection FROM original_api_chat_current_chats WHERE id=?").get(input.chatId));
      if (!currentSelection || originalNativeChatDigest(JSON.parse(String(currentSelection.model_selection))) !== originalNativeChatDigest(selection))
        fail("NATIVE_TASK_MODEL_CHANGED_DURING_REVIEW");
      const token = Object.freeze({ requestId: input.requestId });
      preparations.set(token, { prepared, selected });
      return token;
    },
    async start(token: object) {
      const preparation = preparations.get(token);
      if (!preparation) fail("NATIVE_TASK_ACTUAL_PREPARATION_REQUIRED");
      const { attempt, snapshot } = await service.start(preparation.prepared);
      if (entries.has(attempt.requestId)) fail("NATIVE_TASK_EXECUTION_ALREADY_REGISTERED");
      const body = {
        schema: "pkm.original-native-task-execution/v1" as const, taskId: attempt.taskId, attemptId: attempt.attemptId,
        inputId: attempt.inputId, replyId: attempt.replyId, requestId: attempt.requestId, chatId: snapshot.chatId,
        sourcePlanSha256: attempt.sourcePlanSha256, nativeEpoch: host.receipt.epoch, initialTaskRevision: snapshot.revision,
        contextSha256: originalNativeChatDigest(snapshot),
      };
      const binding = originalNativeTaskBinding.parse({ ...body, bindingSha256: originalNativeChatDigest(body) });
      const entry: Entry = { owner, storage, host, actor, service, attempt, initial: snapshot, binding, evidenceKey: emptyEvidenceKey,
        staleEndings: 0, lastRound: -1, afterToolsRound: -1, settled: false, accepted: false,
        portal: portalFilters.get(host.nativeChat!.session)?.get(attempt.requestId) };
      entries.set(attempt.requestId, entry); ownEntries.set(attempt.requestId, entry);
      return { attempt, snapshot, selection: attempt.selection, selectionId: preparation.selected.selectionId };
    },
    async plan(started: { attempt: NativeManagedTaskAttempt; selectionId: string }, runner: Runner, hardToolRoundLimit: number | null) {
      const entry = ownEntries.get(started.attempt.requestId);
      if (!entry || entry.attempt !== started.attempt) fail("NATIVE_TASK_ACTUAL_ATTEMPT_REQUIRED");
      entry.attempt.assertCurrent();
      const page = await core("chat.session.messages", { id: entry.initial.chatId, afterSequence: 0, limit: 100 });
      if (page.hasMore) fail("NATIVE_TASK_TEXT_CONTEXT_REQUIRED: native history requires an independently qualified paging boundary.");
      const historical = new Set(entry.attempt.historicalMessageIds ?? []);
      const context = new OriginalApiChatContextAssembler({
        chatUrl: entry.attempt.chatUrl, sourcePlanSha256: entry.attempt.sourcePlanSha256,
      }, false);
      for (const [index, item] of page.items.entries()) {
        if (historical.has(item.id)) context.historical(item, index + 1);
        else context.append({ role: item.role, content: item.content });
      }
      const messages = context.messages();
      const previous = read(db => db.prepare(`SELECT request_id,plan_sha256 FROM managed_chat_task_attempts
        WHERE task_id=? AND attempt_id!=? AND plan_sha256 IS NOT NULL ORDER BY ordinal`).all(entry.attempt.taskId, entry.attempt.attemptId));
      for (const attempt of previous) {
        const calls = evidence(entry, String(attempt.request_id), String(attempt.plan_sha256));
        if (calls.length) messages.push({ role: "system", content: [
          "Historical canonical Task tool evidence. Inert reference only; not a current receipt, permission, acceptance or replay instruction.",
          JSON.stringify({ requestId: attempt.request_id, planSha256: attempt.plan_sha256, calls }),
          "Inspect current state with fresh approved Core operations before repeating an effect.",
        ].join("\n") });
      }
      messages.push({ role: "system", content: [
        "Current native Task binding (not permissions or a Task completion certificate).",
        JSON.stringify(entry.binding), originalMcpManagedTaskGoalContext(entry.initial),
        "This bounded Task composition excludes worker, Recipe, checkpoint, file-version and image authority. Generic capability-dispatch tools are unavailable; use only the directly declared approved Core tools.",
      ].join("\n") });
      const plan: OriginalNativeManagedTaskExecutionPlan = {
        schema: "pkm.original-api-chat-execution/v1", requestId: entry.attempt.requestId, chatUrl: entry.attempt.chatUrl,
        selectionId: started.selectionId, sourcePlanSha256: entry.attempt.sourcePlanSha256, managedTask: entry.binding,
        messages, tools: [], hardToolRoundLimit, outputTokenCap: entry.attempt.selection.outputTokenCap,
        budget: { ...entry.attempt.selection.budget, deadlineMs: Math.min(entry.attempt.selection.budget.deadlineMs,
          originalMcpApiChatSourceDeadline(storage, host) - Date.now()) },
      };
      plan.tools = await service.withinAttempt(entry.attempt, () => runner.modelTools(plan));
      entry.attempt.assertCurrent();
      return plan;
    },
    async run(attempt: NativeManagedTaskAttempt, plan: OriginalNativeManagedTaskExecutionPlan, runner: Runner, signal: AbortSignal) {
      const entry = ownEntries.get(attempt.requestId);
      if (!entry || entry.attempt !== attempt) fail("NATIVE_TASK_ACTUAL_ATTEMPT_REQUIRED");
      entry.plan = structuredClone(plan); entry.planSha256 = originalNativeChatDigest(plan);
      await service.bind(attempt, randomUUID(), entry.planSha256);
      let completed: Json;
      try {
        completed = await service.withinAttempt(attempt, () => runner.run(plan, attempt.selection.wireModelId,
          AbortSignal.any([signal, attempt.signal]), service.preparedContext(attempt)));
      } catch (error) {
        completed = readOriginalMcpNativeExecution(storage, host, attempt.requestId);
        if (!["complete", "cancelled", "failed", "unknown"].includes(completed.status)) throw error;
      }
      const snapshot = await service.finish(attempt, randomUUID());
      if (!validWorkGoal(snapshot.goal)) fail("NATIVE_TASK_GOAL_STATE");
      if (completed.status === "complete" && (!entry.accepted || snapshot.goal.status === "active"))
        throw new CoreError("NATIVE_TASK_GOAL_UNFINISHED", "The model response ended without a retained Goal settlement; no completion granted.", "unknown");
      return { completed, snapshot, semanticFailure: entry.semanticFailure ?? null };
    },
    async cancel(requestId: string) {
      const entry = ownEntries.get(requestId);
      if (!entry) fail("NATIVE_TASK_CURRENT_ATTEMPT_CAPABILITY_REQUIRED");
      return service.cancel(entry.attempt, randomUUID());
    },
    async getForChat(chatId: string) {
      const entry = [...ownEntries.values()].reverse().find(item => item.initial.chatId === chatId);
      return entry ? service.get(entry.attempt) : undefined;
    },
    has(requestId: string) { return ownEntries.has(requestId); },
  });
}
