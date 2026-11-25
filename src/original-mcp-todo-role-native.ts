import { AsyncLocalStorage } from "node:async_hooks";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { CoreError, type Actor } from "./contracts.js";
import { assertRootOwner, type RootOwner } from "./root-owner.js";
import { assertStorage, type Storage } from "./storage.js";
import { assertOriginalMcpNativeHost, type OriginalMcpNativeHost } from "./original-mcp-native-host.js";
import { assertAuthenticatedOriginalMcpNativeSession, type AuthenticatedOriginalMcpNativeSession } from "./original-mcp-native-attachment.js";
import { originalMcpNativeRequestSession, originalMcpNativeSupportedMethods, requestOriginalMcpNative } from "./original-mcp-native-request.js";
import { readOriginalMcpTodoAuthority } from "./original-mcp-domain-state.js";
import { readOriginalMcpApiChatBinding, type OriginalMcpApiChatBindingSnapshot } from "./original-mcp-api-chat-binding.js";
import { readOriginalMcpApiChatSourceSession } from "./original-mcp-api-chat-source.js";
import { captureOriginalTodoAssignmentSourcePins, originalTodoAssignmentBindingPins } from "./original-mcp-todo-assignment-gate.js";
import { originalMcpPrivateTopLevels } from "./original-mcp-root-custody.js";
import { planTodo, scanBoards } from "./boards.js";
import { sha256 } from "./markdown.js";
import { todoDefinitions } from "./todo-definitions.js";
import { ToolGateway } from "./tool-gateway.js";
import { createChatTurnToolPort } from "./chat-turn-adapters.js";
import { originalTodoRoleOperations, originalTodoRoleDigest, originalTodoRolePayloads,
  originalTodoRoleDecision, originalTodoHumanDecision, parseOriginalTodoRolePayload,
  parseOriginalTodoRoleDecision, type OriginalTodoRolePayload } from "./original-mcp-todo-role-contracts.js";
import { originalTodoRoleAdmissionSchema, readOriginalTodoRoleEffect, type OriginalTodoRoleGrantData,
  type OriginalTodoRoleAdmission } from "./original-mcp-todo-role-gate.js";
import type { ToolGatewayBinding } from "./tool-gateway-contracts.js";
import type { OriginalNativeChatExecutionPlan, OriginalNativeChatExecutionPort, OriginalSdkChatPlan } from "./original-mcp-api-chat-contracts.js";
import { originalSdkToolRequest, originalSdkSendingBoundary } from "./original-mcp-sdk-model-contracts.js";
import { originalSdkTodoRoleCallback } from "./original-mcp-sdk-todo-role-provenance.js";

const manager: Readonly<Actor> = Object.freeze({ id: "mcp:external", canWrite: true });
type Callback = Parameters<Parameters<OriginalNativeChatExecutionPort["run"]>[1]["tool"]>[0];
type SdkCallback = z.infer<typeof originalSdkToolRequest>;
type Invocation = { provider: "vscode"; callback: Callback; operationId: string }
  | { provider: "copilot-sdk"; callback: SdkCallback; operationId: string };
type Json = Record<string, any>;
type Entry = {
  owner: RootOwner; storage: Storage; host: OriginalMcpNativeHost; binding: OriginalMcpApiChatBindingSnapshot;
  payload: OriginalTodoRolePayload; data: OriginalTodoRoleGrantData;
  plan: OriginalNativeChatExecutionPlan | OriginalSdkChatPlan; signal: AbortSignal; assertCurrent(): void; verifyChat(): Promise<void>;
  authorize(): Promise<void>;
  catalog: readonly ToolGatewayBinding[]; context: AsyncLocalStorage<Invocation>;
  finished: boolean; running: boolean; revoked: boolean; proof?: Json;
};
const roles = new WeakMap<object, Entry>();
const effects = new WeakMap<object, { owner: RootOwner; storage: Storage; admission: OriginalTodoRoleAdmission; check(): Promise<void> }>();
function deny(message = "A genuine exact native Todo role/human resource is required."): never {
  throw new CoreError("NATIVE_AUTHORITY_REQUIRED", message);
}
export function getOriginalTodoRoleExecutionScope(value: unknown, owner: RootOwner, host: OriginalMcpNativeHost,
  plan: OriginalNativeChatExecutionPlan | OriginalSdkChatPlan) {
  const entry = value && typeof value === "object" ? roles.get(value) : undefined;
  if (!entry) return;
  if (entry.owner !== owner || entry.host !== host || originalTodoRoleDigest(plan) !== entry.payload.request.planSha256
    || plan.requestId !== entry.payload.request.requestId) deny();
  entry.assertCurrent();
  return Object.freeze({
    catalog: entry.catalog, signal: entry.signal,
    metadata: Object.freeze({ actorId: entry.payload.request.actorId, role: entry.payload.request.role,
      boardSlug: entry.payload.request.boardSlug, workItemId: entry.payload.request.workItemId,
      decisionId: entry.data.decision.decisionId, requestSha256: entry.data.decision.requestSha256 }),
    async withinTool<T>(callback: Callback, operationId: string, work: () => Promise<T>): Promise<T> {
      await entry.verifyChat();
      if (entry.plan.schema !== "pkm.original-api-chat-execution/v1") deny();
      return entry.context.run({ provider: "vscode", callback: structuredClone(callback), operationId }, work);
    },
    async withinSdkTool<T>(callback: SdkCallback, operationId: string, work: () => Promise<T>): Promise<T> {
      await entry.verifyChat();
      if (entry.plan.schema !== "pkm.original-sdk-api-chat-execution/v1") deny();
      return entry.context.run({ provider: "copilot-sdk", callback: originalSdkToolRequest.parse(structuredClone(callback)), operationId }, work);
    },
    async dispatch(method: string, input: unknown, identity: Actor) {
      entry.assertCurrent();
      const invocation = entry.context.getStore();
      if (!invocation || identity.id !== "mcp:external" || identity.canWrite !== true || identity.boardWorker) deny();
      const request = z.strictObject({ operation: z.string(), version: z.literal(1),
        arguments: z.record(z.string(), z.unknown()) }).parse(input);
      const definition = todoDefinitions.find(item => item.id === request.operation);
      if (!definition || !(originalTodoRoleOperations[entry.payload.request.role] as readonly string[]).includes(request.operation)
        || method !== (definition.readOnly ? "capability_read" : "capability_call")) deny();
      const args = definition.input.parse(request.arguments);
      let callback;
      if (invocation.provider === "copilot-sdk") {
        const db = entry.storage.connectNative();
        try {
          const row = db.prepare(`SELECT payload FROM original_native_chat_events WHERE request_id=? AND type='sdk-sending-approved'
            AND json_extract(payload,'$.boundaryId')=?`).get(entry.plan.requestId, invocation.callback.sendingBoundaryId);
          const receipt = db.prepare(`SELECT execution_id FROM approval_bridge_runs WHERE operation_id=? AND actor_id='mcp:external'`)
            .get(invocation.operationId);
          if (!row || !receipt) deny();
          const sending = originalSdkSendingBoundary.parse(JSON.parse(String(row.payload)));
          if (sending.kind === "websocket-connect" || sending.binding.sdkSessionId !== invocation.callback.sdkSessionId) deny();
          callback = originalSdkTodoRoleCallback.parse({
            provider: "copilot-sdk", requestId: entry.plan.requestId, planSha256: originalTodoRoleDigest(entry.plan),
            sdkSessionId: invocation.callback.sdkSessionId, sendingBoundaryId: invocation.callback.sendingBoundaryId,
            sendingInvocationId: sending.sdkInvocationId, callId: invocation.callback.callId,
            argumentsSha256: invocation.callback.argumentsSha256, toolReceiptId: String(receipt.execution_id), operationId: invocation.operationId,
          });
        } finally { db.close(); }
      } else callback = { requestId: entry.plan.requestId, planSha256: originalTodoRoleDigest(entry.plan),
        inferenceId: invocation.callback.inferenceId, round: invocation.callback.round,
        callId: invocation.callback.callId, operationId: invocation.operationId };
      const admission = originalTodoRoleAdmissionSchema.parse({ kind: "tool", grant: entry.data, callback,
        operation: request.operation, arguments: args });
      const resource = Object.freeze({});
      effects.set(resource, { owner, storage: entry.storage, admission, check: () => entry.verifyChat() });
      const result = await entry.storage.requestOriginalTodoRole(resource);
      return { schema: "pkm.next-result/v1", requestId: randomUUID(), result };
    },
  });
}
/** Storage only: JSON copies, replacement buffers and caller-created success/permission DTOs are never authority. */
export async function readOriginalTodoRoleAdmission(value: unknown, owner: RootOwner, storage: Storage) {
  const entry = value && typeof value === "object" ? effects.get(value) : undefined;
  if (!entry || entry.owner !== owner || entry.storage !== storage) deny();
  await entry.check(); storage.assertWorkspaceLease();
  return originalTodoRoleAdmissionSchema.parse(entry.admission);
}

export async function createOriginalNativeTodoRoles(owner: RootOwner, host: OriginalMcpNativeHost,
  session: AuthenticatedOriginalMcpNativeSession) {
  assertRootOwner(owner);
  const { storage, runtime } = await owner.ensureFull();
  assertStorage(storage); assertOriginalMcpNativeHost(host, storage); assertAuthenticatedOriginalMcpNativeSession(session);
  if (!host.nativeChat?.apiChat || host.nativeChat.session !== session || !host.options.reviewer || !host.options.authorizeTool) deny();
  const methods = originalMcpNativeSupportedMethods(session);
  if (!methods.includes("todo.role.approve") || !methods.includes("todo.human.accept"))
    throw new CoreError("NOT_AVAILABLE", "MISSING_NATIVE_METHOD: both exact Todo role and independent human producers are required.");
  const own = new Set<Entry>(), lifetime = new AbortController();
  let closed = false, pending = false;
  const current = () => {
    assertRootOwner(owner); storage.assertWorkspaceLease(); assertOriginalMcpNativeHost(host, storage);
    assertAuthenticatedOriginalMcpNativeSession(session);
    if (closed || lifetime.signal.aborted || host.nativeChat?.session !== session) deny();
  };
  const selectionPins = (entry: Entry) => {
    const now = readOriginalMcpTodoAuthority(storage.workspaceRoot(), "mcp:external", entry.payload.request.boardSlug);
    const source = readOriginalMcpApiChatSourceSession(storage, host), g = entry.payload.request;
    if (now.intentSha256 !== g.intentSha256 || now.sessionDecisionId !== g.todoDecisionId
      || now.nativeHostReceiptSha256 !== g.nativeHostReceiptSha256 || now.revocation !== entry.data.todoRevocation
      || source.decisionId !== g.chatSourceDecisionId || source.revocation !== entry.data.chatRevocation
      || source.planSha256 !== g.chatSourcePlanSha256 || source.epoch !== g.nativeEpoch) deny();
  };
  function scope(value: unknown): Entry {
    const entry = value && typeof value === "object" ? roles.get(value) : undefined;
    if (!entry || !own.has(entry)) deny();
    entry.assertCurrent(); return entry;
  }
  const close = () => {
    if (closed) return;
    closed = true; lifetime.abort();
    for (const entry of own) { entry.revoked = true; Atomics.store(new Int32Array(entry.data.revocation), 0, 1); }
  };
  owner.retainResource({ closeAdmission: close, release: async () => close() });
  current();
  return Object.freeze({
    close,
    async prepare(input: { role: "worker" | "reviewer"; boardSlug: string; workItemId: string; chatId: string; ttlMs?: number },
      options: { signal?: AbortSignal } = {}) {
      input = z.strictObject({ role: z.enum(["worker", "reviewer"]), boardSlug: z.string(), workItemId: z.string(),
        chatId: z.string().uuid(), ttlMs: z.number().int().min(1).max(300_000).optional() }).parse(input);
      current();
      if (pending || own.size >= 128) deny();
      pending = true;
      try {
        const binding = await readOriginalMcpApiChatBinding(owner, host, manager, input.chatId);
        const authority = readOriginalMcpTodoAuthority(storage.workspaceRoot(), "mcp:external", input.boardSlug);
        const source = readOriginalMcpApiChatSourceSession(storage, host), signal = AbortSignal.any([
          lifetime.signal, host.signal, session.signal, binding.signal, ...(options.signal ? [options.signal] : []),
        ]);
        if (authority.nativeHostReceiptSha256 !== host.receipt.receiptSha256
          || source.nativeHostReceiptSha256 !== host.receipt.receiptSha256 || source.actorId !== manager.id
          || source.epoch !== session.activationId || binding.sourcePlanSha256 !== source.planSha256) deny();
        if (originalMcpPrivateTopLevels(storage.workspaceRoot(), "notes").has(input.boardSlug.split("/")[0]!)
          || input.boardSlug.split("/")[0]!.toLowerCase() === "system") deny("Private/System Boards are outside Todo role grants.");
        const db = storage.connectNative();
        let task: Json, boardDigest: string, sourcePins: OriginalTodoRoleGrantData["sourcePins"], bindingSha256: string;
        try {
          const board = scanBoards(storage.workspaceRoot(), db).get(input.boardSlug);
          if (!board) deny();
          boardDigest = sha256(board.raw);
          task = planTodo(storage.workspaceRoot(), { operation: "todo.workitem.get", actorId: manager.id,
            args: { board_slug: input.boardSlug, id: input.workItemId } }, undefined, db).result.item as Json;
          if (task.deletedAt || task.kind === "UserStory" || task.acceptanceDecision
            || input.role === "worker" && (task.state !== "Planning" || task.ownerId && task.ownerId !== `chat:${input.chatId}`)
            || input.role === "reviewer" && (task.state !== "Done" || task.ownerId === `chat:${input.chatId}`)) deny();
          sourcePins = captureOriginalTodoAssignmentSourcePins(storage.workspaceRoot(), db, input.chatId);
          bindingSha256 = originalTodoAssignmentBindingPins(db, binding);
          if (db.prepare("SELECT 1 FROM managed_chat_tasks WHERE actor_id=? AND chat_id=?").get(manager.id, input.chatId))
            deny("A managed Goal Chat cannot be silently converted to a Todo role.");
        } finally { db.close(); }
        const requestId = originalTodoRoleDigest({ kind: "todo-role", nonce: randomUUID(), role: input.role, binding: bindingSha256 });
        const selected = await host.nativeChat!.apiChat!.resolve({
          requestId, requestedModelId: "", chatUrl: binding.chatUrl, sourcePlanSha256: source.planSha256, expectedSelection: null,
        }, signal);
        if ((selected.protocol !== "pkm.original-api-chat-execution/v1"
          && selected.protocol !== "pkm.original-sdk-api-chat-execution/v1") || selected.epoch !== session.activationId)
          deny("The exact admitted model lane is required; no bounded/HTTP fallback.");
        const isSdk = selected.provider === "copilot-sdk";
        let modelId: string, selectionId: string;
        if (isSdk) {
          if (!host.nativeChat!.sdk) deny("NATIVE_SDK_RUNTIME_INCOMPATIBLE: the actual SDK role lane is unavailable.");
          const catalogue = await host.nativeChat!.sdk.catalogue(signal);
          const model = catalogue.models.find(model => model.id === selected.modelId && model.sdkModelId === selected.wireModelId);
          if (!model || catalogue.epoch !== session.activationId
            || /fixture|synthetic|mock/i.test(`${model.id} ${model.sdkModelId} ${model.label}`)) deny();
          const selection = await host.nativeChat!.sdk.select({ modelId: model.id, catalogueSha256: originalTodoRoleDigest(catalogue) }, signal);
          if (selection.model.id !== model.id || selection.epoch !== session.activationId) deny();
          modelId = model.id; selectionId = selection.selectionId;
        } else {
          const catalogue = await host.nativeChat!.models.catalogue(signal);
          const model = catalogue.models.find(item => item.id === selected.modelId && item.nativeModelId === selected.wireModelId);
          if (!model || catalogue.epoch !== session.activationId
            || /fixture|synthetic|mock/i.test(`${model.id} ${model.nativeModelId} ${model.vendor} ${model.label}`))
            deny("This role slice requires the actual non-fixture native model, never a canned role result.");
          const selection = await host.nativeChat!.models.select({ modelId: model.id, catalogueSha256: originalTodoRoleDigest(catalogue) }, signal);
          if (selection.modelId !== model.id || selection.epoch !== session.activationId) deny("Native role model selection changed.");
          modelId = model.nativeModelId; selectionId = selection.selectionId;
        }
        const catalog = originalTodoRoleOperations[input.role].map(operation => ({
          name: todoDefinitions.find(d => d.id === operation)!.transportName, operation, approvalRequired: true,
        }));
        const expiresAtMs = Math.min(Date.now() + (input.ttlMs ?? 300_000), authority.expiresAtMs, source.expiresAtMs, binding.expiresAtMs);
        const common = {
          requestId, chatUrl: binding.chatUrl, sourcePlanSha256: source.planSha256, selectionId, tools: [],
          hardToolRoundLimit: 8, outputTokenCap: selected.outputTokenCap,
        };
        const plan: OriginalNativeChatExecutionPlan | OriginalSdkChatPlan = selected.provider === "copilot-sdk" ? {
          ...common, schema: "pkm.original-sdk-api-chat-execution/v1", epoch: host.receipt.epoch,
          hostReceiptSha256: host.receipt.receiptSha256, deadlineAtMs: expiresAtMs,
          budget: { ...selected.budget, deadlineMs: Math.min(selected.budget.deadlineMs, input.ttlMs ?? 300_000) }, messages: [],
        } : {
          ...common, schema: "pkm.original-api-chat-execution/v1",
          budget: { ...selected.budget, deadlineMs: Math.min(selected.budget.deadlineMs, input.ttlMs ?? 300_000) }, messages: [],
        };
        plan.messages = [
            { role: "system", content: input.role === "worker"
              ? "You are the exact Todo worker Chat, not the manager/user/reviewer. Only the advertised exact-workitem tools are authorized. Claim the Planning task, read the now-WIP task, then perform this bounded structured-read objective. Submit only an actual evidence-backed result: evidence must copy item.native_role_evidence.id from a successful current WIP get_workitem response. Use its exact digest. Done/outcome is an agent report, never acceptance. No reviewerIds/user actions, other tasks/Chats, file/command/scheduler/private access. If the objective cannot be demonstrated by these actual reads, report the blocker in your reply and do NOT claim Success or submit fabricated evidence."
              : "You are the exact reviewer Chat, not its worker/user. Read the exact Done workitem and actual evidence. Record your genuine recommendation with add_workitem_comment using the current digest; explain remaining caveats. Comment only: never accept, delegate reviewerIds, change state or claim human approval. The independent human must decide acceptance. No other workitem/Chat/file/private/command access." },
            { role: "user", content: JSON.stringify({ board_slug: input.boardSlug, workItemId: input.workItemId,
              actorId: `chat:${input.chatId}`, role: input.role, task, expected_digest: boardDigest }) },
        ];
        if (isSdk) plan.messages = plan.messages.map(message => ({
          ...message, content: message.content.replace("item.native_role_evidence.id", "item.sdk_role_evidence.id"),
        }));
        const port = createChatTurnToolPort({ workspaceId: host.receipt.workspaceId,
          storage: { read: work => { const db = storage.connectNative(); try { return work(db); } finally { db.close(); } },
            transaction: () => deny("Role tool schema discovery cannot execute effects.") },
          gateway: (_actor, _turn, verifyApproval) => new ToolGateway({
            dispatcher: runtime.core, actor: manager, context: { workspaceId: host.receipt.workspaceId, turnId: requestId,
              contextDigest: originalTodoRoleDigest(plan) }, catalog, verifyApproval,
          }),
        });
        plan.tools = await port.modelTools(manager.id, requestId);
        const { receiptSha256: _receipt, ...hostBinding } = host.receipt;
        const payload = originalTodoRolePayloads["todo.role.approve"].parse({
          binding: hostBinding, request: {
            schema: isSdk ? "pkm.original-sdk-todo-role-request/v1" : "pkm.original-native-todo-role-request/v1",
            ...(isSdk ? { provider: "copilot-sdk" } : {}), role: input.role, root: storage.workspaceRoot(),
            workspaceId: host.receipt.workspaceId, custodyPlanSha256: host.receipt.planSha256,
            profileSha256: host.receipt.profileSha256, catalogSha256: host.receipt.sourceCatalogSha256,
            nativeHostReceiptSha256: host.receipt.receiptSha256, nativeEpoch: session.activationId,
            nativeBrokerId: session.brokerId, nativeIdentitySha256: session.identitySha256, ownerLease: owner.workspaceLease(),
            boardSlug: input.boardSlug, workItemId: input.workItemId, boardDigest, intentSha256: authority.intentSha256,
            todoDecisionId: authority.sessionDecisionId, chatSourcePlanSha256: source.planSha256,
            chatSourceDecisionId: source.decisionId, expiresAtMs, actorId: `chat:${input.chatId}`,
            chatId: input.chatId, chatUrl: binding.chatUrl, chatRevision: binding.coreRevision,
            bindingRequestId: binding.nativeRequestId, bindingSha256, requestId, planSha256: originalTodoRoleDigest(plan),
            modelId, selectionId,
          },
        });
        parseOriginalTodoRolePayload("todo.role.approve", payload, originalMcpNativeRequestSession(session));
        const check = async () => {
          current(); signal.throwIfAborted(); await binding.assertCurrent();
          const db = storage.connectNative();
          try {
            if (sha256(scanBoards(storage.workspaceRoot(), db).get(input.boardSlug)?.raw ?? "") !== boardDigest) deny("Board changed while native role consent was pending.");
          } finally { db.close(); }
        };
        await check();
        const decisionValue = await requestOriginalMcpNative(session, "todo.role.approve", payload, { signal, timeoutMs: 120000 });
        await check();
        const decision = parseOriginalTodoRoleDecision("todo.role.approve", decisionValue, payload);
        if (!decision) return null;
        const data: OriginalTodoRoleGrantData = { payload, decision: originalTodoRoleDecision.parse(decision),
          revocation: new SharedArrayBuffer(4), todoRevocation: authority.revocation, chatRevocation: source.revocation,
          source, sourcePins };
        const revocation = new AbortController();
        const roleSignal = AbortSignal.any([signal, revocation.signal]);
        const entry: Entry = { owner, storage, host, binding, payload, data, plan, signal: roleSignal,
          catalog, context: new AsyncLocalStorage(), finished: false, running: false, revoked: false,
          assertCurrent() {
            current(); roleSignal.throwIfAborted();
            if (entry.revoked || data.decision.expiresAtMs <= Date.now()
              || Atomics.load(new Int32Array(data.revocation), 0) !== 0) deny();
            selectionPins(entry);
          },
          async verifyChat() { entry.assertCurrent(); await binding.assertCurrent(); entry.assertCurrent(); },
          async authorize() {
            await entry.verifyChat();
            if (await host.nativeChat!.apiChat!.authorize({
              operation: "send", requestId, commandId: `todo-role-${requestId.slice(0, 32)}`,
              chatUrl: binding.chatUrl, sourcePlanSha256: source.planSha256, sourceUncertain: false,
              argumentsSha256: originalTodoRoleDigest(payload), selection: selected,
            }, roleSignal) !== true) deny("The exact native Chat request was denied.");
            await entry.verifyChat();
          },
        };
        const revoke = () => {
          entry.revoked = true; Atomics.store(new Int32Array(data.revocation), 0, 1); revocation.abort();
          signal.removeEventListener("abort", revoke);
        };
        const timer = setTimeout(revoke, Math.max(1, data.decision.expiresAtMs - Date.now())); timer.unref();
        signal.addEventListener("abort", revoke, { once: true });
        const resource = Object.freeze({ kind: "pkm.original-native-todo-role/v1" as const,
          role: input.role, actorId: payload.request.actorId, boardSlug: input.boardSlug, workItemId: input.workItemId,
          requestId, decisionId: data.decision.decisionId, expiresAtMs: data.decision.expiresAtMs,
          assertCurrent: entry.assertCurrent, verifyChat: entry.verifyChat,
          revoke() { clearTimeout(timer); revoke(); } });
        roles.set(resource, entry); own.add(entry);
        await entry.verifyChat();
        return resource;
      } finally { pending = false; }
    },
    async run(value: unknown) {
      const entry = scope(value);
      await entry.verifyChat();
      if (entry.finished || entry.running) deny("Role model execution is one-shot; never replay a result.");
      entry.running = true;
      try {
        await entry.authorize();
        const { retainedOriginalMcpNativeExecution } = await import("./original-mcp-api-chat-execution.js");
        const executor = retainedOriginalMcpNativeExecution(owner, host);
        const result = await executor.run(entry.plan, entry.payload.request.modelId, entry.signal, value as {
          assertCurrent(): void; verifyChat(): Promise<void>;
        });
        entry.finished = true;
        if (result.status !== "complete") deny("The actual role model did not complete; preserve its durable execution.");
        const db = storage.connectNative();
        try {
          const operation = entry.payload.request.role === "worker" ? "todo.workitem.submit" : "todo.workitem.comment";
          const rows = db.prepare(`SELECT * FROM original_native_todo_role_effects
            WHERE json_extract(admission_json,'$.grant.decision.decisionId')=?
            AND json_extract(admission_json,'$.operation')=? ORDER BY rowid`).all(entry.data.decision.decisionId, operation);
          if (rows.length !== 1) deny("Actual role completion requires exactly one canonical submission/recommendation.");
          const a = JSON.parse(String(rows[0]!.admission_json)), observed = JSON.parse(String(rows[0]!.result_json));
          const completed = db.prepare(`SELECT r.payload,a.status,a.result_json,b.context_json
            FROM original_native_chat_events r JOIN approval_bridge_runs a
            ON a.execution_id=json_extract(r.payload,'$.executionId')
            JOIN approval_bridge_bindings b ON b.execution_id=a.execution_id
            WHERE r.request_id=? AND r.type=? AND json_extract(r.payload,'$.callId')=?
            AND a.operation_id=? AND a.actor_id='mcp:external'`).get(entry.plan.requestId,
              entry.plan.schema === "pkm.original-sdk-api-chat-execution/v1" ? "sdk-tool-result" : "tool-result",
              a.callback.callId, a.callback.operationId);
          if (!completed || completed.status !== "succeeded" || !completed.result_json) deny("The role lacks its actual completed canonical model tool receipt.");
          const output = JSON.parse(String(completed.result_json)), event = JSON.parse(String(completed.payload));
          const context = JSON.parse(String(completed.context_json));
          if (output.status !== "complete" || output.effect !== "committed" || event.resultStatus !== "complete"
            || event.effect !== "committed" || originalTodoRoleDigest(output.result) !== originalTodoRoleDigest(observed)
            || context.turnId !== entry.plan.requestId || context.contextDigest !== originalTodoRoleDigest(entry.plan))
            deny("A durable write or model reply alone is not a successful role result.");
          if (observed.item?.state !== "Done" || observed.item?.acceptanceDecision
            || entry.payload.request.role === "worker" && observed.item?.ownerId !== entry.payload.request.actorId) deny();
          entry.proof = { requestId: entry.plan.requestId, planSha256: originalTodoRoleDigest(entry.plan),
            operationId: a.callback.operationId, actorId: entry.payload.request.actorId,
            decisionId: entry.data.decision.decisionId, requestSha256: entry.data.decision.requestSha256 };
          return { ...result, role: entry.payload.request.role, actorId: entry.payload.request.actorId,
            proof: Object.freeze({ ...entry.proof }), workitem: observed.item, acceptance: "not-claimed" };
        } finally { db.close(); }
      } finally { entry.running = false; entry.finished = true; }
    },
    async accept(input: { worker: unknown; reviewer: unknown }, options: { signal?: AbortSignal } = {}) {
      const worker = scope(input.worker), reviewer = scope(input.reviewer);
      await worker.verifyChat(); await reviewer.verifyChat();
      if (!worker.proof || !reviewer.proof || worker.payload.request.role !== "worker"
        || reviewer.payload.request.role !== "reviewer" || worker.payload.request.actorId === reviewer.payload.request.actorId) deny();
      const wp = worker.payload.request, rp = reviewer.payload.request;
      if (wp.boardSlug !== rp.boardSlug || wp.workItemId !== rp.workItemId) deny();
      const db = storage.connectNative();
      let item: Json, boardDigest: string;
      try {
        const board = scanBoards(storage.workspaceRoot(), db).get(wp.boardSlug);
        if (!board) deny();
        boardDigest = sha256(board.raw);
        item = planTodo(storage.workspaceRoot(), { operation: "todo.workitem.get", actorId: manager.id,
          args: { board_slug: wp.boardSlug, id: wp.workItemId } }, undefined, db).result.item as Json;
        const recommendation = readOriginalTodoRoleEffect(db, reviewer.proof.operationId);
        if (!recommendation || originalTodoRoleDigest(JSON.parse(String(recommendation.result_json)).item) !== originalTodoRoleDigest(item)) deny();
      } finally { db.close(); }
      const { receiptSha256: _receipt, ...binding } = host.receipt;
      const payload = originalTodoRolePayloads["todo.human.accept"].parse({ binding, request: {
        schema: "pkm.original-native-todo-human-request/v1", actorId: "user:local", operationId: randomUUID(),
        root: wp.root, workspaceId: wp.workspaceId, custodyPlanSha256: wp.custodyPlanSha256, profileSha256: wp.profileSha256,
        catalogSha256: wp.catalogSha256, nativeHostReceiptSha256: wp.nativeHostReceiptSha256,
        nativeEpoch: wp.nativeEpoch, nativeBrokerId: wp.nativeBrokerId, nativeIdentitySha256: wp.nativeIdentitySha256,
        ownerLease: wp.ownerLease, boardSlug: wp.boardSlug, workItemId: wp.workItemId, boardDigest,
        intentSha256: wp.intentSha256, todoDecisionId: wp.todoDecisionId, chatSourcePlanSha256: wp.chatSourcePlanSha256,
        chatSourceDecisionId: wp.chatSourceDecisionId, expiresAtMs: Math.min(Date.now() + 120000,
          worker.data.decision.expiresAtMs, reviewer.data.decision.expiresAtMs), item, itemSha256: originalTodoRoleDigest(item),
        worker: worker.proof, reviewer: reviewer.proof,
      } });
      parseOriginalTodoRolePayload("todo.human.accept", payload, originalMcpNativeRequestSession(session));
      const signal = AbortSignal.any([worker.signal, reviewer.signal, lifetime.signal, ...(options.signal ? [options.signal] : [])]);
      const check = async () => {
        await worker.verifyChat(); await reviewer.verifyChat();
        signal.throwIfAborted();
        const db = storage.connectNative();
        try {
          if (sha256(scanBoards(storage.workspaceRoot(), db).get(wp.boardSlug)?.raw ?? "") !== boardDigest) deny("The human acceptance target changed.");
        } finally { db.close(); }
      };
      await check();
      const result = await requestOriginalMcpNative(session, "todo.human.accept", payload, { signal, timeoutMs: 120000 });
      await check();
      const decision = parseOriginalTodoRoleDecision("todo.human.accept", result, payload);
      if (!decision) return { decision: "denied", acceptance: "not-claimed", boardDigest };
      const revocation = new SharedArrayBuffer(4);
      const invalidate = () => Atomics.store(new Int32Array(revocation), 0, 1);
      signal.addEventListener("abort", invalidate, { once: true });
      const resource = Object.freeze({});
      effects.set(resource, { owner, storage, admission: originalTodoRoleAdmissionSchema.parse({
        kind: "human", payload, decision: originalTodoHumanDecision.parse(decision), revocation,
        worker: worker.data, reviewer: reviewer.data,
      }), check });
      try { return await storage.requestOriginalTodoRole(resource); }
      finally { invalidate(); signal.removeEventListener("abort", invalidate); }
    },
  });
}
