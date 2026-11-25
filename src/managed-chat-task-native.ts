import { createHash, randomUUID } from "node:crypto";
import { z } from "zod";
import { CoreError, type Actor } from "./contracts.js";
import { assertRootOwner, type RootOwner } from "./root-owner.js";
import type { Storage } from "./storage.js";
import { assertOriginalMcpNativeHost, originalMcpRequestDigest, type OriginalMcpNativeHost } from "./original-mcp-native-host.js";
import { readOriginalMcpApiChatSourceSession } from "./original-mcp-api-chat-source.js";
import { originalNativeChatDigest, originalNativeChatSelection, type OriginalNativeChatExecutionPort } from "./original-mcp-api-chat-contracts.js";
import { managedTaskOperationIds, type ManagedTaskOperation, type ManagedTaskSnapshot, type ManagedTaskBegin } from "./managed-chat-task-contracts.js";
import { managedTaskAdmissionSchema, managedTaskAuthorityFailure, type ManagedTaskAdmission } from "./managed-chat-task-admission.js";
import { originalMcpApiChatRequestsNewTask } from "./original-mcp-api-chat-task.js";
import { withinNativeTaskScope, type ManagedTaskScope } from "./managed-chat-task-scope.js";
import { originalMcpNativeChatSupportedMethods } from "./original-mcp-native-chat-rpc.js";
import { assertOriginalManagedTaskAdoptionSource } from "./managed-chat-task-adoption-source.js";
import { readOriginalManagedTaskAdoptionSource } from "./managed-chat-task-adoption-source-native.js";
import { readOriginalManagedTaskAdoptionReceipt } from "./managed-chat-task-adoption-state.js";
import { originalManagedTaskAdoptionDecision, originalManagedTaskAdoptionRequest,
  originalManagedTaskAdoptionStoredProof, type OriginalManagedTaskAdoptionPort,
  type OriginalManagedTaskAdoptionProof } from "./managed-chat-task-adoption-contracts.js";

type Json = Record<string, any>;
interface Grant {
  owner: RootOwner; storage: Storage; actor: Readonly<Actor>; data: ManagedTaskAdmission;
  assertSource(): void; assertLive(): void; controller: AbortController;
  selection: Readonly<Extract<z.infer<typeof originalNativeChatSelection>, { protocol: "pkm.original-api-chat-execution/v1" }>>;
  nativeSelectionId?: string;
}
const grants = new WeakMap<object, Grant>();
const scopeTokens = new WeakMap<Grant, object>();
const lifecycle = new Set(["chat.task.attempt.bind", "chat.task.attempt.finish", "chat.task.cancel", "chat.task.get", "chat.task.action_started"]);
function allowed(g: Grant, operation: string) {
  const mode = g.data.guard.mode;
  return mode === "start" ? operation === "chat.task.start"
    : mode === "adopt" ? operation === "chat.task.adopt"
    : mode === "attempt" ? operation === "chat.task.attempt.start"
      : mode === "read" ? operation === "chat.task.get"
        : mode === "cancel" ? operation === "chat.task.cancel" || operation === "chat.task.get"
          : lifecycle.has(operation) || operation === "chat.task.report_work" || operation === "chat.task.record_harness";
}
export function readGenuineManagedTaskScope(value: object): ManagedTaskScope {
  const grant = grants.get(value);
  if (!grant) managedTaskAuthorityFailure("A real native Task capability is required, not a copied callback or context.");
  grant.assertSource();
  return { storage: grant.storage, actorId: grant.actor.id, workspaceId: grant.data.guard.workspaceId,
    requestId: grant.data.guard.requestId, mode: grant.data.guard.mode, grant: scopeTokens.get(grant)!,
    assertSource: grant.assertSource, assertLive: grant.assertLive,
    allows: operation => managedTaskOperationIds.includes(operation as ManagedTaskOperation) && allowed(grant, operation) };
}
/** Storage-only brand extraction. No caller-supplied policy, success receipt or JSON token is accepted. */
export async function readManagedChatTaskWorkerAdmission(value: unknown, owner: RootOwner, operation: ManagedTaskOperation) {
  const grant = value && typeof value === "object" ? grants.get(value) : undefined;
  if (!grant || grant.owner !== owner || !allowed(grant, operation)) managedTaskAuthorityFailure("The actual native Task capability is required.");
  grant.assertSource();
  const db = grant.storage.connectNative();
  let revision: number | null;
  try {
    const row = db.prepare("SELECT revision FROM managed_chat_tasks WHERE task_id=? AND actor_id=?")
      .get(grant.data.guard.taskId, grant.actor.id);
    revision = row ? Number(row.revision) : null;
  } finally { db.close(); }
  grant.assertSource();
  const guard = { ...grant.data.guard, expectedTaskRevision: revision };
  return managedTaskAdmissionSchema.parse({ ...grant.data, guard, guardSha256: originalNativeChatDigest(guard) });
}
export interface NativeManagedTaskAttempt {
  readonly taskId: string; readonly attemptId: string; readonly inputId: string; readonly replyId: string;
  readonly requestId: string; readonly chatUrl: string; readonly sourcePlanSha256: string;
  readonly signal: AbortSignal;
  readonly selection: Grant["selection"];
  readonly historicalMessageIds?: readonly string[];
  assertCurrent(): void;
}
export interface NativeManagedTaskStart {
  readonly taskId: string; readonly attemptId: string; readonly requestId: string;
}
const preparation = z.strictObject({
  chatId: z.string().uuid(), expectedChatRevision: z.number().int().nonnegative(),
  commandId: z.string().min(1).max(128), operationId: z.string().uuid(),
  prompt: z.string().min(1).max(16000).refine(value => !!value.trim()),
  hardToolRoundLimit: z.number().int().min(1).max(1000).nullable().default(null),
});
export type NativeManagedTaskPreparation = z.input<typeof preparation>;
const sha = (text: string) => createHash("sha256").update(text).digest("hex");

/** Admission and Core composition only: owns no database, inference engine, scheduler or effect implementation. */
export async function createNativeManagedChatTasks(owner: RootOwner, host: OriginalMcpNativeHost, actorInput: Readonly<Actor>) {
  assertRootOwner(owner);
  const { storage, runtime } = await owner.ensureFull(), actor = Object.freeze({ ...actorInput });
  assertOriginalMcpNativeHost(host, storage);
  const port = host.nativeChat;
  if (actor.id !== "mcp:external" || !actor.canWrite || actor.boardWorker || !port?.apiChat
    || host.receipt.authorityId !== `native-rpc:${port.session.brokerId}`)
    managedTaskAuthorityFailure("A fresh actual native Chat channel and same-owner actor are required.");
  const hostRevocation = new SharedArrayBuffer(4), lifetime = new AbortController();
  const attempts = new Map<string, Grant>();
  const invalidate = () => { Atomics.store(new Int32Array(hostRevocation), 0, 1); lifetime.abort(); };
  host.signal.addEventListener("abort", invalidate, { once: true });
  port.signal.addEventListener("abort", invalidate, { once: true });
  owner.retainResource({ closeAdmission: invalidate, release() {
    invalidate(); host.signal.removeEventListener("abort", invalidate); port.signal.removeEventListener("abort", invalidate);
  } });
  const current = () => {
    assertRootOwner(owner); assertOriginalMcpNativeHost(host, storage); port.assertCurrent();
    if (lifetime.signal.aborted) managedTaskAuthorityFailure("Native Task admission is closed.");
  };
  const readChat = async (id: string) => {
    const response = await runtime.core.dispatch("capability_read", { operation: "chat.session.get", version: 1, arguments: { id } }, actor);
    if (response.error) throw new CoreError(response.error.code, response.error.message, response.error.effect);
    return response.result as Json;
  };
  function readMap(chatId: string) {
    current();
    const db = storage.connectNative();
    try {
      const sourceChat = db.prepare("SELECT 1 FROM original_api_chat_source_chats WHERE id=?").get(chatId);
      const adoption = sourceChat ? readOriginalManagedTaskAdoptionReceipt(db, storage.workspaceRoot(), chatId) : undefined;
      if (sourceChat && !adoption)
        managedTaskAuthorityFailure("Original archived Chat/Task identities require their exact native adoption receipt.");
      const map = db.prepare(`SELECT c.*,q.operation,s.status,s.epoch FROM original_api_chat_current_chats c
        JOIN original_api_chat_requests q ON q.request_id=c.create_request_id
        JOIN original_api_chat_request_state s ON s.request_id=q.request_id WHERE c.id=?`).get(chatId);
      const actualIdentity = adoption ? map?.operation === "send" && map.create_request_id === adoption.begin.requestId
        && adoption.nativeHostReceiptSha256 === host.receipt.receiptSha256
        && adoption.ownerId === owner.workspaceLease().ownerId && adoption.ownerFence === owner.workspaceLease().fence
        && ["running", "succeeded", "outcome_unknown", "failed"].includes(String(map.status))
        : map?.operation === "create" && map.status === "succeeded";
      if (!map || !actualIdentity || map.epoch !== host.receipt.epoch)
        managedTaskAuthorityFailure("A current-epoch actual native create or independently reviewed adoption receipt is required.");
      const model = originalNativeChatSelection.parse(JSON.parse(String(map.model_selection)));
      if (model.protocol !== "pkm.original-api-chat-execution/v1" || model.provider !== "vscode" || model.epoch !== host.receipt.epoch)
        managedTaskAuthorityFailure("An exact original native model/permission/budget binding is required.");
      return { map, model, adoption };
    } finally { db.close(); }
  }
  const capture = async (input: NativeManagedTaskPreparation, previousTaskId?: string,
    options: { signal?: AbortSignal; adopt?: boolean;
      replacement?: NonNullable<ManagedTaskAdmission["guard"]["replacement"]>;
      portalOrigin?: ManagedTaskAdmission["guard"]["portalOrigin"];
      manualOrigin?: ManagedTaskAdmission["guard"]["manualOrigin"] } = {}): Promise<NativeManagedTaskStart> => {
    const args = preparation.parse(input); current();
    const requestSignal = AbortSignal.any([lifetime.signal, ...(options.signal ? [options.signal] : [])]);
    if (!options.adopt && !previousTaskId && !originalMcpApiChatRequestsNewTask(args.prompt)
      || previousTaskId && originalMcpApiChatRequestsNewTask(args.prompt))
      throw new CoreError("INVALID_ARGUMENT", "An explicit new Task and a same-goal follow-up are distinct native operations.");
    if (options.adopt && (args.expectedChatRevision !== 0 || previousTaskId || originalMcpApiChatRequestsNewTask(args.prompt)))
      throw new CoreError("INVALID_ARGUMENT", "Adoption requires explicit continuation, not a replacement Task or canonical identity.");
    if (originalMcpApiChatRequestsNewTask(args.prompt) && !args.prompt.replace(/^\s*(?:开始新任务|start a new task)\s*[:：]/i, "").trim())
      throw new CoreError("INVALID_ARGUMENT", "A new Task requires its complete nonempty objective.");
    let adoptionPort: OriginalManagedTaskAdoptionPort | undefined;
    if (options.adopt) {
      if (!originalMcpNativeChatSupportedMethods(port.session).some(method => String(method) === "chat.task.adopt")
        || !("adopt" in port.apiChat!) || typeof port.apiChat.adopt !== "function")
        managedTaskAuthorityFailure("MISSING_NATIVE_METHOD chat.task.adopt; ordinary send approval is not original Task adoption.");
      adoptionPort = port.apiChat as typeof port.apiChat & OriginalManagedTaskAdoptionPort;
    }
    const source = readOriginalMcpApiChatSourceSession(storage, host);
    const candidate = options.adopt ? await readOriginalManagedTaskAdoptionSource(storage, host, args.chatId) : undefined;
    const existing = candidate ? undefined : readMap(args.chatId);
    const map = existing?.map ?? { namespace: candidate!.namespace, create_request_id: "" };
    let model: Grant["selection"] | undefined = existing?.model;
    const chat = candidate ? undefined : await readChat(args.chatId); current();
    if (chat && (chat.archivedAt || chat.revision !== args.expectedChatRevision || chat.metadata?.sessionId))
      throw new CoreError("CONFLICT", "The current same-actor native Chat changed.");
    const lease = Object.freeze({ ...owner.workspaceLease() }), sourcePin = source.decisionId;
    const requestId = sha(JSON.stringify([host.receipt.workspaceId, args.commandId])
      .replace(",", ", ").replace(/[\u007f-\uffff]/g, value => `\\u${value.charCodeAt(0).toString(16).padStart(4, "0")}`));
    const chatUrl = `pkm://chats/${map.namespace}/${args.chatId}`;
    const assertPrepared = () => {
      current();
      if (requestSignal.aborted) managedTaskAuthorityFailure("The native Task request was cancelled before publication.");
      const now = readOriginalMcpApiChatSourceSession(storage, host);
      if (now.decisionId !== sourcePin || now.revocation !== source.revocation
        || Atomics.load(new Int32Array(source.revocation), 0) !== 0
        || originalNativeChatDigest(owner.workspaceLease()) !== originalNativeChatDigest(lease)
        || !candidate && originalNativeChatDigest(readMap(args.chatId).model) !== originalNativeChatDigest(model))
        managedTaskAuthorityFailure("Chat/source/model authority changed during native review.");
      if (candidate) {
        const db = storage.connectNative();
        try {
          assertOriginalManagedTaskAdoptionSource(db, storage.workspaceRoot(), candidate);
          if (db.prepare("SELECT 1 FROM original_api_chat_current_chats WHERE id=?").get(args.chatId)
            && originalNativeChatDigest(readMap(args.chatId).model) !== originalNativeChatDigest(model))
            managedTaskAuthorityFailure("The actual adopted model identity changed.");
        } finally { db.close(); }
      }
    };
    await host.authorizePublic({ operation: "mcp.tool.api_chat_send", version: 1, tool: "api_chat_send", readOnly: false,
      arguments: { host_id: host.receipt.workspaceId, chat_id: args.chatId, prompt: args.prompt, command_id: args.commandId,
        ...(args.hardToolRoundLimit === null ? {} : { hard_tool_round_limit: args.hardToolRoundLimit }) },
      argumentsDigest: originalMcpRequestDigest({ host_id: host.receipt.workspaceId, chat_id: args.chatId, prompt: args.prompt,
        command_id: args.commandId, ...(args.hardToolRoundLimit === null ? {} : { hard_tool_round_limit: args.hardToolRoundLimit }) }),
    }, requestSignal);
    assertPrepared();
    const selection = await port.apiChat!.resolve({ requestId, requestedModelId: model?.modelId ?? "", chatUrl,
      sourcePlanSha256: source.planSha256, expectedSelection: model ?? null }, requestSignal);
    assertPrepared();
    if (selection.protocol !== "pkm.original-api-chat-execution/v1" || selection.provider !== "vscode")
      managedTaskAuthorityFailure("Original Task execution requires the actual current native retained-model protocol.");
    if (model && originalNativeChatDigest(selection) !== originalNativeChatDigest(model))
      managedTaskAuthorityFailure("Task consent cannot retarget the original Chat model or budget.");
    model = selection;
    let nativeSelectionId: string | undefined;
    if (candidate) {
      const catalogue = await port.models.catalogue(requestSignal);
      assertPrepared();
      const actual = catalogue.models.find(item => item.id === model!.modelId);
      if (!actual || actual.nativeModelId !== model.wireModelId || model.budget.maxInputTokens > actual.maxInputTokens)
        managedTaskAuthorityFailure("The freshly reviewed original adoption model is no longer exact.");
      const selected = await port.models.select({ modelId: actual.id, catalogueSha256: originalNativeChatDigest(catalogue) }, requestSignal);
      assertPrepared();
      if (selected.modelId !== model.modelId || selected.epoch !== host.receipt.epoch)
        managedTaskAuthorityFailure("The actual adoption model selection changed.");
      nativeSelectionId = selected.selectionId;
    }
    const contextDigest = originalNativeChatDigest({ root: storage.workspaceRoot(), workspaceId: host.receipt.workspaceId,
      actorId: actor.id, chatId: args.chatId, nativeHostReceiptSha256: host.receipt.receiptSha256,
      sourcePlanSha256: source.planSha256, model });
    let adoption: OriginalManagedTaskAdoptionProof | undefined;
    if (candidate) {
      const { messages: _messages, pins: _pins, messageHashes: _hashes, ...original } = candidate;
      const review = originalManagedTaskAdoptionRequest.parse({
        schema: "pkm.chat.original-task-adoption-review/v1", requestId, commandId: args.commandId, chatUrl,
        sourcePlanSha256: source.planSha256, sourceSha256: originalNativeChatDigest(candidate), original, selection,
        prompt: args.prompt, argumentsSha256: originalMcpRequestDigest({ chatId: args.chatId, prompt: args.prompt,
          ...(args.hardToolRoundLimit === null ? {} : { hardToolRoundLimit: args.hardToolRoundLimit }) }),
        previousExecutionDigest: (candidate.goal as { executionDigest: string }).executionDigest, nextExecutionDigest: contextDigest,
        resetCurrentAcceptance: true, importOldPermissions: false, historicalEvidenceOnly: true, taskCompletion: "not-claimed",
      });
      const decision = originalManagedTaskAdoptionDecision.parse(await adoptionPort!.adopt(review, requestSignal));
      assertPrepared();
      if (decision.decision !== "adopt-and-revalidate" || decision.actorId !== actor.id || decision.requestId !== requestId
        || decision.epoch !== host.receipt.epoch || decision.bindingSha256 !== originalNativeChatDigest(review)
        || decision.expiresAtMs <= Date.now()) managedTaskAuthorityFailure("The exact original Task adoption was denied or changed.");
      adoption = { source: candidate, review, decision };
    }
    if (await port.apiChat!.authorize({ operation: "send", requestId, commandId: args.commandId, chatUrl,
      sourcePlanSha256: source.planSha256, sourceUncertain: false, selection,
      argumentsSha256: originalMcpRequestDigest({ chatId: args.chatId, prompt: args.prompt,
        ...(args.hardToolRoundLimit === null ? {} : { hardToolRoundLimit: args.hardToolRoundLimit }) }),
    }, requestSignal) !== true) managedTaskAuthorityFailure("Native Task send consent was denied.");
    assertPrepared();
    if (!candidate && (await readChat(args.chatId)).revision !== args.expectedChatRevision)
      throw new CoreError("CONFLICT", "Chat revision changed during exact native Task consent.");
    assertPrepared();
    const taskId = candidate?.taskId ?? previousTaskId ?? `agent_session_${randomUUID().replaceAll("-", "")}`;
    const attemptId = randomUUID(), inputId = randomUUID(), replyId = randomUUID();
    const guard: ManagedTaskAdmission["guard"] = {
      root: storage.workspaceRoot(), workspaceId: host.receipt.workspaceId, actorId: "mcp:external", ownerLease: lease,
      nativeHostReceiptSha256: host.receipt.receiptSha256, nativeEpoch: port.session.activationId,
      nativeBrokerId: port.session.brokerId, nativeIdentitySha256: port.session.identitySha256,
      sourcePlanSha256: source.planSha256, sourceDecisionId: source.decisionId,
      expiresAtMs: Math.min(source.expiresAtMs, adoption?.decision.expiresAtMs ?? source.expiresAtMs),
      chatId: args.chatId, chatUrl, chatCreateRequestId: candidate ? requestId : String(map.create_request_id), initialChatRevision: args.expectedChatRevision,
      taskId, attemptId, inputId, replyId, requestId, commandId: args.commandId, prompt: args.prompt,
      creationOperationId: args.operationId,
      nativeModelId: model.wireModelId, modelSha256: originalNativeChatDigest(model), contextDigest,
      hardToolRoundLimit: args.hardToolRoundLimit, mode: candidate ? "adopt" : previousTaskId ? "attempt" : "start", expectedTaskRevision: null,
      ...(options.replacement ? { replacement: options.replacement } : {}),
      ...(options.portalOrigin ? { portalOrigin: options.portalOrigin } : {}),
      ...(options.manualOrigin ? { manualOrigin: options.manualOrigin } : {}),
    };
    const controller = new AbortController(), attemptRevocation = new SharedArrayBuffer(4);
    requestSignal.addEventListener("abort", () => {
      Atomics.store(new Int32Array(attemptRevocation), 0, 1); controller.abort();
    }, { once: true });
    const sourceCheck = () => { assertPrepared(); if (guard.expiresAtMs <= Date.now()) managedTaskAuthorityFailure("Native source/adoption consent expired."); };
    const grant: Grant = { owner, storage, actor, controller, ...(nativeSelectionId ? { nativeSelectionId } : {}),
      selection: Object.freeze({ ...model, budget: Object.freeze({ ...model.budget }) }),
      data: { schema: "pkm.chat.managed-task-storage-admission/v1", guard, sourceAuthority: source,
        hostRevocation, attemptRevocation, guardSha256: originalNativeChatDigest(guard), ...(adoption ? { adoption } : {}) },
      assertSource: sourceCheck,
      assertLive() {
        sourceCheck();
        if (Atomics.load(new Int32Array(attemptRevocation), 0) !== 0 || controller.signal.aborted)
          managedTaskAuthorityFailure("The Task attempt was disarmed.");
        const db = storage.connectNative();
        try {
          const a = db.prepare(`SELECT a.status,t.current_attempt_id,t.chat_revision,c.revision,c.record FROM managed_chat_task_attempts a
            JOIN managed_chat_tasks t ON t.task_id=a.task_id JOIN chat_sessions c ON c.actor_id=t.actor_id AND c.id=t.chat_id
            WHERE a.attempt_id=?`).get(attemptId);
          if (a && (a.current_attempt_id !== attemptId || !["prepared", "bound"].includes(String(a.status))))
            managedTaskAuthorityFailure("The Task attempt is no longer live.");
          if (a && (a.chat_revision !== a.revision || JSON.parse(String(a.record)).archivedAt))
            managedTaskAuthorityFailure("The canonical Chat changed after Task preparation.");
          const pinned = db.prepare("SELECT plan_sha256 FROM managed_chat_task_attempts WHERE attempt_id=?").get(attemptId);
          const hasExecution = db.prepare("SELECT 1 FROM sqlite_master WHERE name='original_native_chat_executions'").get();
          const execution = hasExecution && db.prepare("SELECT plan,plan_sha256,native_model_id FROM original_native_chat_executions WHERE request_id=?").get(requestId);
          if (execution) {
            const plan = JSON.parse(String(execution.plan));
            if (!pinned?.plan_sha256 || pinned.plan_sha256 !== execution.plan_sha256
              || originalNativeChatDigest(plan) !== pinned.plan_sha256 || plan.requestId !== requestId
              || plan.chatUrl !== chatUrl || plan.sourcePlanSha256 !== source.planSha256
              || plan.hardToolRoundLimit !== args.hardToolRoundLimit || execution.native_model_id !== model.wireModelId
              || plan.outputTokenCap !== model.outputTokenCap
              || plan.budget.maxInputTokens !== model.budget.maxInputTokens
              || plan.budget.maxTotalOutputTokens !== model.budget.maxTotalOutputTokens
              || plan.budget.deadlineMs < 1 || plan.budget.deadlineMs > model.budget.deadlineMs)
              managedTaskAuthorityFailure("The actual provider plan differs from the native Task consent/budget.");
            const inputs = db.prepare(`SELECT record FROM chat_session_messages WHERE actor_id=? AND chat_id=?
              AND json_extract(record,'$.taskId')=? AND json_extract(record,'$.role')='user'
              AND sequence<=(SELECT sequence FROM chat_session_messages WHERE actor_id=? AND chat_id=? AND id=?)`)
              .all(actor.id, args.chatId, taskId, actor.id, args.chatId, inputId);
            if (inputs.some(input => !plan.messages.some((message: Json) =>
              message.role === "user" && message.content === JSON.parse(String(input.record)).content)))
              managedTaskAuthorityFailure("The whole original Task input history was omitted or rewritten.");
          }
        } finally { db.close(); }
      } };
    const token = Object.freeze({ taskId, attemptId, requestId });
    grants.set(token, grant);
    scopeTokens.set(grant, token);
    beginArguments.set(token, { operationId: args.operationId, taskId, attemptId, inputId, replyId, requestId,
      chatId: args.chatId, expectedChatRevision: args.expectedChatRevision, prompt: args.prompt,
      ...(adoption ? { adoptionSha256: originalNativeChatDigest(adoption) } : {}) });
    return token;
  };
  const perform = async (token: object, operation: ManagedTaskOperation, args: Json): Promise<ManagedTaskSnapshot> => {
    const grant = grants.get(token);
    if (!grant || grant.owner !== owner || grant.storage !== storage || !allowed(grant, operation))
      managedTaskAuthorityFailure("A genuine scoped native Task capability is required.");
    grant.assertSource();
    return withinNativeTaskScope(token, async () => {
      const response = await runtime.core.dispatch(operation === "chat.task.get" ? "capability_read" : "capability_call",
        { operation, version: 1, arguments: args }, actor);
      if (response.error) throw new CoreError(response.error.code, response.error.message, response.error.effect);
      try { grant.assertSource(); }
      catch { throw new CoreError("NATIVE_AUTHORITY_REQUIRED", "Task authority changed after dispatch; preserve/reconcile its receipt.", "unknown"); }
      return response.result as ManagedTaskSnapshot;
    });
  };
  const execution: OriginalNativeChatExecutionPort = Object.freeze({
    async run(...[plan, callbacks, signal]: Parameters<OriginalNativeChatExecutionPort["run"]>) {
      const grant = attempts.get(plan.requestId);
      if (!grant) managedTaskAuthorityFailure("The actual durable Task attempt was not registered for this native request.");
      grant.assertLive();
      if (!plan.messages.some(message => message.role === "user" && message.content === grant.data.guard.prompt))
        managedTaskAuthorityFailure("The whole consent-bound Task input was omitted or rewritten.");
      const scoped = <T>(work: () => Promise<T>) => withinNativeTaskScope(scopeTokens.get(grant)!, async () => {
        grant.assertLive(); const result = await work(); grant.assertLive(); return result;
      });
      return port.execution.run(plan, {
        beforeInference: request => scoped(() => callbacks.beforeInference(request)),
        tool: request => scoped(() => callbacks.tool(request)),
        text: request => scoped(() => callbacks.text(request)),
        usage: request => scoped(() => callbacks.usage(request)),
      }, AbortSignal.any([signal, grant.controller.signal, lifetime.signal]));
    },
  });
  return Object.freeze({
    execution,
    prepareStart: (input: NativeManagedTaskPreparation,
      options?: { signal?: AbortSignal; portalOrigin?: ManagedTaskAdmission["guard"]["portalOrigin"] }) => capture(input, undefined, options),
    prepareReplacement: (input: NativeManagedTaskPreparation,
      replacement: NonNullable<ManagedTaskAdmission["guard"]["replacement"]>,
      options?: { signal?: AbortSignal; portalOrigin?: ManagedTaskAdmission["guard"]["portalOrigin"] }) =>
      capture(input, undefined, { ...options, replacement }),
    prepareAttempt: (taskId: string, input: NativeManagedTaskPreparation,
      options?: { signal?: AbortSignal; manualOrigin?: ManagedTaskAdmission["guard"]["manualOrigin"] }) => capture(input, taskId, options),
    prepareAdoption: (input: NativeManagedTaskPreparation, options?: { signal?: AbortSignal }) => capture(input, undefined, { ...options, adopt: true }),
    preparedSelection(token: NativeManagedTaskStart) {
      const grant = grants.get(token);
      if (!grant || grant.owner !== owner) managedTaskAuthorityFailure("The actual native preparation is required.");
      grant.assertSource(); return grant.selection;
    },
    preparedModelSelectionId(token: NativeManagedTaskStart) {
      const grant = grants.get(token);
      if (!grant || grant.owner !== owner || !grant.nativeSelectionId)
        managedTaskAuthorityFailure("An actual transport-selected adoption model is required.");
      grant.assertSource(); return grant.nativeSelectionId;
    },
    async start(token: NativeManagedTaskStart) {
      const grant = grants.get(token), args = beginArguments.get(token);
      if (!grant || !args) managedTaskAuthorityFailure("The actual native Task preparation is required.");
      const adopted = grant.data.guard.mode === "adopt";
      const result = await perform(token, adopted ? "chat.task.adopt" : grant.data.guard.mode === "start" ? "chat.task.start" : "chat.task.attempt.start", args);
      const snapshot = { ...result };
      if (adopted) {
        originalManagedTaskAdoptionStoredProof.parse((result as Json).adoptionProof);
        delete (snapshot as Json).adoptionProof;
      }
      const nextGuard = { ...grant.data.guard, mode: "execute" as const };
      const next = { ...grant, data: { ...grant.data, guard: nextGuard, guardSha256: originalNativeChatDigest(nextGuard) } };
      const attempt: NativeManagedTaskAttempt = Object.freeze({ taskId: snapshot.taskId, attemptId: snapshot.attempt.id,
        inputId: snapshot.attempt.inputId, replyId: snapshot.attempt.replyId, requestId: snapshot.attempt.requestId,
        chatUrl: nextGuard.chatUrl, sourcePlanSha256: nextGuard.sourcePlanSha256,
        selection: next.selection,
        ...(() => {
          const db = storage.connectNative();
          try {
            const origin = readOriginalManagedTaskAdoptionReceipt(db, storage.workspaceRoot(), nextGuard.chatId);
            return origin ? { historicalMessageIds: Object.freeze(origin.proof.source.messageHashes.map(message => message.id)) } : {};
          } finally { db.close(); }
        })(),
        signal: AbortSignal.any([controllerSignal(grant), lifetime.signal]), assertCurrent: () => next.assertLive() });
      grants.set(attempt, next);
      scopeTokens.set(next, attempt);
      attempts.set(nextGuard.requestId, next);
      return { snapshot, attempt };
    },
    get: (attempt: NativeManagedTaskAttempt) => perform(attempt, "chat.task.get", {}),
    bind: (attempt: NativeManagedTaskAttempt, operationId: string, planSha256: string) =>
      perform(attempt, "chat.task.attempt.bind", { operationId, planSha256 }),
    finish: (attempt: NativeManagedTaskAttempt, operationId: string) =>
      perform(attempt, "chat.task.attempt.finish", { operationId }),
    preparedContext(attempt: NativeManagedTaskAttempt) {
      const grant = grants.get(attempt);
      if (!grant || grant.owner !== owner || grant.data.guard.mode !== "execute") managedTaskAuthorityFailure("A real Task attempt is required.");
      return Object.freeze({ assertCurrent: () => grant.assertLive(),
        async verifyChat() { await readChat(grant.data.guard.chatId); grant.assertLive(); } });
    },
    async cancel(attempt: NativeManagedTaskAttempt, operationId: string) {
      z.string().uuid().parse(operationId);
      try { return await perform(attempt, "chat.task.cancel", { operationId }); }
      finally {
        const g = grants.get(attempt);
        if (g) { Atomics.store(new Int32Array(g.data.attemptRevocation), 0, 1); g.controller.abort(); }
      }
    },
    async withinAttempt<T>(attempt: NativeManagedTaskAttempt, work: () => Promise<T>): Promise<T> {
      const grant = grants.get(attempt);
      if (!grant || grant.owner !== owner || grant.data.guard.mode !== "execute") managedTaskAuthorityFailure("A real Task attempt scope is required.");
      grant.assertLive();
      return withinNativeTaskScope(attempt, async () => { const result = await work(); grant.assertSource(); return result; });
    },
  });
}
const beginArguments = new WeakMap<object, ManagedTaskBegin>();
const controllerSignal = (grant: Grant) => grant.controller.signal;
