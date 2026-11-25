import { randomUUID } from "node:crypto";
import { z } from "zod";
import { RootOwner, assertRootOwner } from "./root-owner.js";
import { CoreError, type Actor } from "./contracts.js";
import { assertOriginalMcpNativeHost, type OriginalMcpNativeHost } from "./original-mcp-native-host.js";
import { originalMcpApiChatSource, originalMcpApiChatSourceDeadline } from "./original-mcp-api-chat-source.js";
import { originalNativeChatDigest, originalNativeChatInferenceDigest,
  type OriginalNativeChatExecutionPlan, type OriginalNativeChatExecutionPort } from "./original-mcp-api-chat-contracts.js";
import { createChatTurnToolPort } from "./chat-turn-adapters.js";
import { ChatTurnToolError } from "./chat-turn.js";
import { ToolGateway } from "./tool-gateway.js";
import { CHAT_TOOL_GATEWAY_OUTPUT_BYTES } from "./tool-gateway-contracts.js";
import { assertStorage, type Storage } from "./storage.js";
import type { DatabaseSync } from "node:sqlite";
import { originalApiChatCreditUsage } from "./domain/original-api-chat-projection.js";
import { originalMcpApiChatTaskToolCatalog, beforeOriginalMcpApiChatTaskTool } from "./original-mcp-api-chat-task-adapter.js";
import { getOriginalTodoRoleExecutionScope } from "./original-mcp-todo-role-native.js";
import { originalSdkDigest, originalSdkSessionRequest, originalSdkSendingBoundary, originalSdkToolRequest,
  originalSdkUsageRequest, type OriginalSdkChatPlan, type OriginalSdkChatPort } from "./original-mcp-sdk-model-contracts.js";
import { originalMcpSdkChatPlanSchema } from "./original-mcp-native-chat-rpc.js";
import { originalNativeChatExecutionDdl } from "./original-mcp-api-chat-schema.js";

type Json = Record<string, any>;
export interface OriginalNativeChatPreparedContext {
  assertCurrent(): void;
  verifyChat(): Promise<void>;
}
const outputByteLimit = 16_777_216;
const liveExecutionOwners = new WeakSet<Storage>();
const retainedExecutors = new WeakMap<RootOwner, { host: OriginalMcpNativeHost; resource: {
  run(input: OriginalNativeChatExecutionPlan | OriginalSdkChatPlan, modelId: string, signal?: AbortSignal, prepared?: OriginalNativeChatPreparedContext): Promise<Json>;
} }>();
/** Reuse the actual current API executor; a role cannot install a provider or create a second owner. */
export function retainedOriginalMcpNativeExecution(owner: RootOwner, host: OriginalMcpNativeHost) {
  assertRootOwner(owner); host.assertCurrent();
  const entry = retainedExecutors.get(owner);
  if (!entry || entry.host !== host) throw new CoreError("NATIVE_AUTHORITY_REQUIRED", "A fresh same-owner native Chat continuation must establish the actual executor first.");
  return entry.resource;
}
function fail(message: string): never { throw new CoreError("RECOVERY_REQUIRED", `ORIGINAL_NATIVE_CHAT_EXECUTION_REQUIRED: ${message}`, "unknown"); }
function executionState(db: DatabaseSync, requestId: string): Json {
  const row = db.prepare("SELECT * FROM original_native_chat_executions WHERE request_id=?").get(requestId);
  if (!row) fail("No exact native execution exists.");
  const chunks = db.prepare("SELECT inference_id,text FROM original_native_chat_text WHERE request_id=? ORDER BY sequence").all(requestId);
  const events = db.prepare("SELECT type,payload FROM original_native_chat_events WHERE request_id=? ORDER BY sequence").all(requestId);
  if (JSON.parse(String(row.plan)).schema === "pkm.original-sdk-api-chat-execution/v1") {
    const payloads = events.map(event => ({ type: String(event.type), payload: JSON.parse(String(event.payload)) }));
    const sending = payloads.filter(event => event.type === "sdk-sending-approved").map(event => event.payload);
    const usage = payloads.filter(event => event.type === "sdk-usage").map(event => event.payload);
    return { requestId, provider: "copilot-sdk", status: row.status, failure: row.failure,
      output: chunks.map(chunk => String(chunk.text)).join(""), outputBytes: Number(row.output_bytes),
      planSha256: row.plan_sha256, replay: "never",
      toolRoundLimit: payloads.findLast(event => event.type === "sdk-execution-finished")?.payload.toolRoundLimit ?? null,
      tools: payloads.filter(event => event.type === "sdk-tool-result").map(event => ({
        name: event.payload.name, status: event.payload.resultStatus === "failed" ? "failed" : "complete",
      })),
      usage: usage.length ? {
        inputTokens: usage.reduce((sum, event) => sum + event.usage.inputTokens, 0),
        outputTokens: usage.reduce((sum, event) => sum + event.usage.outputTokens, 0),
      } : null,
      usageSource: usage.length ? "provider-reported" : null, reportedUsage: usage.map(event => event.usage),
      creditUsage: { ...originalApiChatCreditUsage(usage.map(event => ({ usage: event.usage }))),
        coverage: "provider-reported-observations-only", completeBillingProof: false },
      context: { provider: "copilot-sdk", admission: "awaited-sdk-sending-boundary",
        sendingBoundaryCount: sending.length, providerTokenCount: null,
        boundaries: sending.slice(-5).map(boundary => ({
          kind: boundary.kind, serializedBytes: boundary.measurement.serializedBytes,
          countingMethod: boundary.measurement.countingMethod,
        })), cost: null, costSource: "not-reported",
        evidence: "Actual SDK sending/session/tool provenance is retained locally, not native inference/token-count evidence." } };
  }
  const tools = new Map<string, Json>(), usageByInference = new Map<string, Json>();
  let toolRoundLimit: Json | null = null;
  for (const event of events) {
    const payload = JSON.parse(String(event.payload));
    if (event.type === "tool-intent") tools.set(payload.callId, { name: payload.name, status: "running" });
    if (event.type === "tool-result" && tools.has(payload.callId)) tools.get(payload.callId)!.status =
      payload.resultStatus === "failed" ? "failed" : "complete";
    if (event.type === "tool-failed" && tools.has(payload.callId)) tools.get(payload.callId)!.status = "failed";
    if (event.type === "execution-finished") toolRoundLimit = payload.toolRoundLimit;
    if (event.type === "usage") {
      const prior = usageByInference.get(payload.inferenceId);
      if (!prior || payload.source === "provider-reported" || prior.source !== "provider-reported")
        usageByInference.set(payload.inferenceId, payload);
    }
  }
  const usage = [...usageByInference.values()];
  const reported = usage.filter(item => item.source === "provider-reported");
  const inferences = db.prepare("SELECT inference_id,payload,authorized FROM original_native_chat_inferences WHERE request_id=? ORDER BY rowid")
    .all(requestId);
  return { requestId, status: row.status, output: chunks.map(item => String(item.text)).join(""),
    failure: row.failure, outputBytes: Number(row.output_bytes), planSha256: row.plan_sha256,
    round: Number(row.round), replay: "never", tools: [...tools.values()], toolRoundLimit,
    usage: usage.length ? { inputTokens: usage.reduce((sum, item) => sum + item.usage.inputTokens, 0),
      outputTokens: usage.reduce((sum, item) => sum + item.usage.outputTokens, 0) } : null,
    usageSource: usage.length && reported.length === usage.length ? "provider-reported" : usage.length ? "native-counted-or-mixed" : null,
    reportedUsage: reported.map(item => item.usage),
    creditUsage: originalApiChatCreditUsage(usage.map(item => ({ usage: item.source === "provider-reported" ? item.usage : undefined }))),
    context: { roundCount: inferences.length, omittedRounds: Math.max(0, inferences.length - 5),
      rounds: inferences.slice(-5).map(row => {
        const request = JSON.parse(String(row.payload));
        const observed = usageByInference.has(String(row.inference_id))
          || chunks.some(chunk => chunk.inference_id === row.inference_id);
        return { round: request.round, status: observed ? "native-observed" : row.authorized ? "authorized-not-confirmed" : "prepared",
          transportInputTokens: request.inputTokens, countingMethod: request.countingMethod };
      }),
      evidence: "Native inference/source identities, hashes and manifests are retained locally; not included in this summary." } };
}
export function readOriginalMcpNativeExecution(storage: Storage, host: OriginalMcpNativeHost, requestId: string): Json {
  assertStorage(storage); storage.assertWorkspaceLease(); assertOriginalMcpNativeHost(host, storage);
  originalMcpApiChatSource(storage, host);
  const db = storage.connectNative();
  try { return executionState(db, requestId); } finally { db.close(); }
}

/**
 * Same-owner durable adapter around the existing native model engine.
 * The transport must come from the fixed authenticated native-model lane;
 * accepting this embedding port is not a native identity/permission producer.
 */
export async function createOriginalMcpNativeExecution(owner: RootOwner, principal: Readonly<Actor>,
  host: OriginalMcpNativeHost, execution: OriginalNativeChatExecutionPort, sdkExecution?: OriginalSdkChatPort) {
  assertRootOwner(owner);
  const { storage, runtime } = await owner.ensureFull(), actor = Object.freeze({ ...principal });
  if (actor.id !== "mcp:external" || actor.boardWorker) fail("Exact native MCP actor required.");
  assertOriginalMcpNativeHost(host, storage);
  if (sdkExecution && host.nativeChat?.sdk !== sdkExecution)
    throw new CoreError("NATIVE_AUTHORITY_REQUIRED", "NATIVE_SDK_UNSUPPORTED_AUTHORITY: SDK execution must be the exact authenticated Host IPC resource.");
  if (liveExecutionOwners.has(storage)) throw new CoreError("BUSY", "This canonical owner already has its original native executor.");
  const db = storage.connectNative(), active = new Map<string, { abort: AbortController; done: Promise<Json> }>();
  const lifetime = new AbortController();
  let closed = false, fault: unknown;
  const current = () => {
    storage.assertWorkspaceLease(); assertOriginalMcpNativeHost(host, storage);
    originalMcpApiChatSource(storage, host);
    if (closed || fault || lifetime.signal.aborted) fail("Native execution admission is closed or faulted.");
  };
  const transaction = <T>(work: () => T): T => {
    current(); db.exec("BEGIN IMMEDIATE");
    try { const result = work(); current(); db.exec("COMMIT"); return result; }
    catch (error) {
      db.exec("ROLLBACK");
      if (error instanceof Error && "code" in error && String(error.code).startsWith("ERR_SQLITE")) fault = error;
      throw error;
    }
  };
  try { transaction(() => {
    db.exec(originalNativeChatExecutionDdl);
    db.prepare(`UPDATE original_native_chat_executions SET status='unknown',failure='HOST_RESTARTED'
      WHERE status IN ('prepared','running')`).run();
  }); } catch (error) { db.close(); throw error; }
  liveExecutionOwners.add(storage);
  const state = (requestId: string): Json => {
    current();
    return executionState(db, requestId);
  };
  const event = (requestId: string, type: string, payload: unknown) => {
    if (!db.isTransaction) fail("Native execution event requires its actual transaction.");
    const prior = db.prepare("SELECT sequence,sha256 FROM original_native_chat_events WHERE request_id=? ORDER BY sequence DESC LIMIT 1").get(requestId);
    const sequence = Number(prior?.sequence ?? 0) + 1, previous = String(prior?.sha256 ?? "0".repeat(64));
    if (sequence > 1_000_000) fail("Explicit native event envelope exhausted.");
    const text = JSON.stringify(payload);
    if (Buffer.byteLength(text) > 16_777_216) fail("Native event exceeds its explicit envelope.");
    const sha = originalNativeChatDigest({ requestId, sequence, type, payload, previous });
    db.prepare("INSERT INTO original_native_chat_events VALUES(?,?,?,?,?,?)").run(requestId, sequence, type, text, previous, sha);
    return sha;
  };
  const toolsFor = (plan: OriginalNativeChatExecutionPlan | OriginalSdkChatPlan, prepared?: OriginalNativeChatPreparedContext) => {
    const role = getOriginalTodoRoleExecutionScope(prepared, owner, host, plan);
    const catalog = role?.catalog ?? (plan.schema === "pkm.original-api-chat-execution/v1" && "managedTask" in plan
      ? originalMcpApiChatTaskToolCatalog(host, plan, host.options.toolCatalog)
      : host.options.toolCatalog);
    if (!catalog?.length) return undefined;
    if (!host.options.reviewer || !host.options.authorizeTool) fail("Real exact tool review/effect authority is required.");
    return createChatTurnToolPort({
      workspaceId: host.receipt.workspaceId,
      storage: { read(work) { current(); return work(db); },
        transaction(work) { return transaction(() => work(db)); } },
      reviewer: async (...args) => {
        current(); prepared?.assertCurrent();
        const result = await host.options.reviewer!(...args);
        await prepared?.verifyChat(); current(); prepared?.assertCurrent();
        return result;
      },
      gateway(actorId, turnId, verifyApproval) {
        if (actorId !== actor.id || turnId !== plan.requestId) fail("Tool principal/execution changed.");
        return new ToolGateway({
          dispatcher: { async dispatch(method, input, identity) {
            await prepared?.verifyChat(); current(); prepared?.assertCurrent();
            return role ? role.dispatch(method, input, identity) : runtime.core.dispatch(method, input, identity);
          } },
          actor, context: { workspaceId: host.receipt.workspaceId, turnId, contextDigest: originalNativeChatDigest(plan) },
          catalog, legacyChatOutput: true, limits: { outputBytes: CHAT_TOOL_GATEWAY_OUTPUT_BYTES },
          verifyApproval, authorize: async (...args) => {
            current(); prepared?.assertCurrent();
            const result = await host.options.authorizeTool!(...args);
            await prepared?.verifyChat(); current(); prepared?.assertCurrent();
            return result;
          },
        });
      },
    });
  };
  const runSdk = async (input: OriginalSdkChatPlan, modelId: string, signal?: AbortSignal,
    prepared?: OriginalNativeChatPreparedContext): Promise<Json> => {
    current(); prepared?.assertCurrent();
    if (!sdkExecution) throw new CoreError("NATIVE_AUTHORITY_REQUIRED", "NATIVE_SDK_RUNTIME_INCOMPATIBLE: the independently admitted SDK IPC lane is unavailable.");
    const plan = originalMcpSdkChatPlanSchema.parse(structuredClone(input));
    const source = originalMcpApiChatSource(storage, host), planSha256 = originalSdkDigest(plan);
    if (plan.epoch !== host.receipt.epoch || plan.hostReceiptSha256 !== host.receipt.receiptSha256
      || plan.sourcePlanSha256 !== source.planSha256 || !/^[a-f0-9]{64}$/.test(plan.requestId)
      || !modelId.startsWith("vscode:copilot-sdk:")) fail("SDK source/Host/model binding changed.");
    const prior = db.prepare("SELECT * FROM original_native_chat_executions WHERE request_id=?").get(plan.requestId);
    if (prior) {
      if (prior.plan_sha256 !== planSha256 || prior.native_model_id !== modelId) fail("SDK request conflicts; never replay.");
      return state(plan.requestId);
    }
    const role = getOriginalTodoRoleExecutionScope(prepared, owner, host, plan);
    const tools = toolsFor(plan, prepared), actualTools = tools ? await tools.modelTools(actor.id, plan.requestId) : [];
    await prepared?.verifyChat(); current(); prepared?.assertCurrent();
    if (originalSdkDigest(actualTools) !== originalSdkDigest(plan.tools)) fail("SDK tools differ from canonical Core catalogue.");
    const abort = new AbortController(), combined = AbortSignal.any([abort.signal, lifetime.signal, host.signal, ...(signal ? [signal] : [])]);
    const deadlineAtMs = plan.deadlineAtMs;
    if (deadlineAtMs <= Date.now() || deadlineAtMs > Date.now() + plan.budget.deadlineMs
      || deadlineAtMs > originalMcpApiChatSourceDeadline(storage, host) || combined.aborted) fail("SDK source expired before dispatch.");
    const recheck = async () => {
      await prepared?.verifyChat(); current(); prepared?.assertCurrent();
      if (combined.aborted || Date.now() >= deadlineAtMs) fail("SDK execution was cancelled or expired.");
    };
    const sessions = new Map<string, z.infer<typeof originalSdkSessionRequest>["binding"]>();
    const approved = new Set<string>(), usageIds = new Set<string>();
    let sendingCount = 0, reportedOutput = 0;
    transaction(() => {
      db.prepare("INSERT INTO original_native_chat_executions VALUES(?,?,?,?,'prepared',NULL,-1,0,NULL,?,?)")
        .run(plan.requestId, planSha256, JSON.stringify(plan), modelId, Date.now(), Date.now());
      event(plan.requestId, "sdk-execution-prepared", { provider: "copilot-sdk", planSha256,
        sourcePlanSha256: source.planSha256, ownerLease: owner.workspaceLease(), ...(role ? { todoRole: role.metadata } : {}) });
    });
    const timer = setTimeout(() => abort.abort("deadline"), deadlineAtMs - Date.now());
    const invoke = async () => {
      try {
        const outcome = await sdkExecution.run(plan, {
          async beforeSession(value) {
            await recheck();
            const input = originalSdkSessionRequest.parse(structuredClone(value)), binding = input.binding;
            if (input.ordinal !== sessions.size || sessions.has(binding.sdkSessionId)
              || binding.modelId !== modelId || binding.requestId !== plan.requestId
              || binding.selectionId !== plan.selectionId || binding.planSha256 !== planSha256
              || binding.sourcePlanSha256 !== source.planSha256 || binding.epoch !== host.receipt.epoch
              || binding.hostReceiptSha256 !== host.receipt.receiptSha256 || binding.deadlineAtMs > deadlineAtMs
              || binding.budget.maxRequestBytes !== plan.budget.maxRequestBytes
              || binding.budget.maxSendingBoundaries !== plan.budget.maxSendingBoundaries
              || input.ordinal === 1 && (plan.hardToolRoundLimit === null || input.previousSessionId !== [...sessions.keys()][0]))
              fail("SDK fresh session binding changed.");
            sessions.set(binding.sdkSessionId, binding);
            transaction(() => event(plan.requestId, "sdk-session-admitted", input));
          },
          async beforeSendingBoundary(value) {
            await recheck();
            const input = originalSdkSendingBoundary.parse(structuredClone(value)), { boundaryId, ...body } = input;
            if (!sessions.has(input.binding.sdkSessionId)
              || originalSdkDigest(sessions.get(input.binding.sdkSessionId)) !== originalSdkDigest(input.binding)
              || originalSdkDigest(body) !== boundaryId || ++sendingCount > plan.budget.maxSendingBoundaries
              || input.measurement.serializedBytes > plan.budget.maxRequestBytes) fail("SDK sending boundary changed.");
            transaction(() => event(plan.requestId, "sdk-sending-intent", input));
            await sdkExecution.authorizeBoundary(input, combined);
            await recheck();
            transaction(() => {
              event(plan.requestId, "sdk-sending-approved", input);
              db.prepare("UPDATE original_native_chat_executions SET status='running',current_inference=?,updated_at=? WHERE request_id=?")
                .run(input.binding.sdkSessionId, Date.now(), plan.requestId);
            });
            if (input.kind !== "websocket-connect") approved.add(input.binding.sdkSessionId);
          },
          async text(value) {
            await recheck();
            if (!approved.has(value.sdkSessionId) || !value.text) fail("SDK text lacks an approved sending session.");
            transaction(() => {
              const row = db.prepare("SELECT output_bytes FROM original_native_chat_executions WHERE request_id=?").get(plan.requestId)!;
              if (Number(row.output_bytes) + Buffer.byteLength(value.text) > outputByteLimit) fail("SDK text exceeds owned byte envelope.");
              const last = db.prepare("SELECT max(sequence) AS n FROM original_native_chat_text WHERE request_id=?").get(plan.requestId)!;
              db.prepare("INSERT INTO original_native_chat_text VALUES(?,?,?,?)")
                .run(plan.requestId, Number(last.n ?? 0) + 1, value.sdkSessionId, value.text);
              db.prepare("UPDATE original_native_chat_executions SET output_bytes=output_bytes+?,updated_at=? WHERE request_id=?")
                .run(Buffer.byteLength(value.text), Date.now(), plan.requestId);
            });
          },
          async usage(value) {
            await recheck();
            const input = originalSdkUsageRequest.parse(value);
            if (!approved.has(input.sdkSessionId) || usageIds.has(input.usageId)
              || input.usage.outputTokens > plan.outputTokenCap
              || reportedOutput + input.usage.outputTokens > plan.budget.maxTotalOutputTokens) fail("SDK reported usage exceeds its exact scope/budget.");
            usageIds.add(input.usageId); reportedOutput += input.usage.outputTokens;
            transaction(() => event(plan.requestId, "sdk-usage", input));
          },
          async tool(value) {
            await recheck();
            const input = originalSdkToolRequest.parse(structuredClone(value));
            const sent = db.prepare(`SELECT payload FROM original_native_chat_events WHERE request_id=? AND type='sdk-sending-approved'
              AND json_extract(payload,'$.boundaryId')=?`).get(plan.requestId, input.sendingBoundaryId);
            if (!tools || !approved.has(input.sdkSessionId) || input.sdkSessionId !== [...sessions.keys()][0]
              || !sent || JSON.parse(String(sent.payload)).binding.sdkSessionId !== input.sdkSessionId
              || !plan.tools.some(tool => tool.name === input.name)
              || originalSdkDigest(input.arguments) !== input.argumentsSha256) fail("SDK tool has no exact canonical provenance.");
            const operationId = randomUUID();
            transaction(() => {
              if (db.prepare("SELECT 1 FROM original_native_chat_events WHERE request_id=? AND type='sdk-tool-intent' AND json_extract(payload,'$.callId')=?")
                .get(plan.requestId, input.callId)) fail("SDK tool already has an intent; never replay.");
              event(plan.requestId, "sdk-tool-intent", { ...input, operationId });
            });
            try {
              const invokeTool = () => tools.tools.execute({ actor: actor.id, turnId: plan.requestId, operationId, signal: combined,
                call: { id: input.callId, name: input.name, arguments: input.arguments },
                onApproval(value) { transaction(() => event(plan.requestId, "sdk-tool-approval", value)); } });
              const output = await (role ? role.withinSdkTool(input, operationId, invokeTool) : invokeTool());
              await recheck();
              const observed = db.prepare(`SELECT r.*,b.context_json FROM approval_bridge_runs r
                JOIN approval_bridge_bindings b ON b.execution_id=r.execution_id
                WHERE r.execution_id=? AND r.workspace_id=? AND r.actor_id=? AND r.operation_id=?`)
                .get(output.executionId, host.receipt.workspaceId, actor.id, operationId);
              let effect: "not-committed" | "committed" = "not-committed";
              if (observed) {
                const context = JSON.parse(String(observed.context_json)), result = JSON.parse(String(observed.result_json));
                if (context.turnId !== plan.requestId || context.contextDigest !== planSha256
                  || !["succeeded", "failed"].includes(String(observed.status))
                  || result.schema !== "pkm.tool-result/v1" || !["not-committed", "committed"].includes(result.effect))
                  fail("SDK canonical effect receipt changed.");
                effect = result.effect;
              } else if (output.executionId !== `unavailable-${operationId}` || output.resultStatus !== "failed")
                fail("SDK canonical effect has no completed receipt.");
              const receiptSha256 = transaction(() => event(plan.requestId, "sdk-tool-result", {
                callId: input.callId, name: input.name, operationId, effect, executionId: output.executionId,
                resultStatus: output.resultStatus ?? "complete", contentSha256: originalSdkDigest(output.content),
              }));
              return { receiptSha256, effect, content: output.content };
            } catch {
              abort.abort("sdk-tool-outcome-unknown");
              transaction(() => event(plan.requestId, "sdk-tool-failed", { callId: input.callId, operationId, effect: "unknown" }));
              throw new CoreError("RECOVERY_REQUIRED", "SDK canonical tool failed; inspect exact durable receipts before any new request.", "unknown");
            }
          },
        }, combined);
        await recheck();
        if (outcome.status === "complete" && !approved.size) fail("SDK completion has no approved actual sending session.");
        transaction(() => {
          db.prepare("UPDATE original_native_chat_executions SET status=?,updated_at=? WHERE request_id=?")
            .run(outcome.status, Date.now(), plan.requestId);
          event(plan.requestId, "sdk-execution-finished", outcome);
        });
        return state(plan.requestId);
      } catch (error) {
        if (!closed && !host.signal.aborted && !lifetime.signal.aborted) transaction(() => {
          db.prepare("UPDATE original_native_chat_executions SET status=?,failure='SDK_EXECUTION_FAILED',updated_at=? WHERE request_id=?")
            .run(approved.size ? "unknown" : "failed", Date.now(), plan.requestId);
          event(plan.requestId, "sdk-execution-failed", { dispatch: approved.size ? "uncertain" : "not-sent" });
        });
        throw error;
      } finally { clearTimeout(timer); active.delete(plan.requestId); }
    };
    const done = Promise.resolve().then(invoke);
    active.set(plan.requestId, { abort, done });
    return done;
  };
  const run = async (input: OriginalNativeChatExecutionPlan | OriginalSdkChatPlan, nativeModelId: string, signal?: AbortSignal,
    prepared?: OriginalNativeChatPreparedContext): Promise<Json> => {
    if (input.schema === "pkm.original-sdk-api-chat-execution/v1") return runSdk(input, nativeModelId, signal, prepared);
    current();
    prepared?.assertCurrent();
    const plan = structuredClone(input), source = originalMcpApiChatSource(storage, host);
    if (plan.schema !== "pkm.original-api-chat-execution/v1" || !/^[a-f0-9]{64}$/.test(plan.requestId)
      || plan.sourcePlanSha256 !== source.planSha256 || !plan.selectionId || !nativeModelId
      || !Number.isSafeInteger(plan.outputTokenCap) || plan.outputTokenCap < 1
      || ![plan.budget.maxInputTokens, plan.budget.maxTotalOutputTokens, plan.budget.deadlineMs]
        .every(value => Number.isSafeInteger(value) && value > 0)
      || plan.hardToolRoundLimit !== null && (!Number.isSafeInteger(plan.hardToolRoundLimit)
        || plan.hardToolRoundLimit < 1 || plan.hardToolRoundLimit > 1000))
      fail("Invalid exact native execution plan.");
    const planSha256 = originalNativeChatDigest(plan), prior = db.prepare("SELECT * FROM original_native_chat_executions WHERE request_id=?").get(plan.requestId);
    if (prior) {
      if (prior.plan_sha256 !== planSha256 || prior.native_model_id !== nativeModelId) fail("Execution request conflicts; never replay it.");
      return state(plan.requestId);
    }
    const tools = toolsFor(plan, prepared);
    const role = getOriginalTodoRoleExecutionScope(prepared, owner, host, plan);
    const actualTools = tools ? await tools.modelTools(actor.id, plan.requestId) : [];
    await prepared?.verifyChat(); current(); prepared?.assertCurrent();
    if (originalNativeChatDigest(actualTools) !== originalNativeChatDigest(plan.tools)) fail("Native tools differ from canonical Core catalogue.");
    const abort = new AbortController(), combined = AbortSignal.any([abort.signal, lifetime.signal, host.signal, ...(signal ? [signal] : [])]);
    const deadline = Math.min(plan.budget.deadlineMs, originalMcpApiChatSourceDeadline(storage, host) - Date.now());
    if (deadline < 1 || combined.aborted) fail("Native model/source grant expired before dispatch.");
    transaction(() => {
      db.prepare("INSERT INTO original_native_chat_executions VALUES(?,?,?,?,'prepared',NULL,-1,0,NULL,?,?)")
        .run(plan.requestId, planSha256, JSON.stringify(plan), nativeModelId, Date.now(), Date.now());
      event(plan.requestId, "execution-prepared", {
        planSha256, sourcePlanSha256: source.planSha256, ownerLease: owner.workspaceLease(),
        ...(role ? { todoRole: role.metadata } : {}),
      });
    });
    const timer = setTimeout(() => abort.abort("deadline"), deadline);
    const invoke = async () => {
      try {
        const outcome = await execution.run(plan, {
          async beforeInference(request) {
            await prepared?.verifyChat(); current(); prepared?.assertCurrent();
            const snapshot = structuredClone(request), { requestSha256, ...body } = snapshot;
            if (combined.aborted || snapshot.planSha256 !== planSha256 || snapshot.sourcePlanSha256 !== source.planSha256
              || snapshot.selectionId !== plan.selectionId || originalNativeChatInferenceDigest(body) !== requestSha256
              || !Number.isSafeInteger(snapshot.round) || snapshot.round < 0 || snapshot.round > 1001
              || !Number.isSafeInteger(snapshot.inputTokens) || snapshot.inputTokens < 0 || snapshot.inputTokens > plan.budget.maxInputTokens)
              fail("Native inference binding/count changed.");
            transaction(() => {
              const prior = db.prepare("SELECT round FROM original_native_chat_executions WHERE request_id=?").get(plan.requestId)!;
              if (snapshot.round < Number(prior.round)) fail("Native inference round regressed.");
              const count = Number(db.prepare("SELECT count(*) AS n FROM original_native_chat_inferences WHERE request_id=?")
                .get(plan.requestId)!.n);
              if (plan.hardToolRoundLimit !== null && (count >= plan.hardToolRoundLimit + 1
                || count === plan.hardToolRoundLimit && Array.isArray(snapshot.nativeRequest.options.tools)
                  && snapshot.nativeRequest.options.tools.length))
                fail("Original hard-round boundary requires one tool-free summary only.");
              db.prepare("INSERT INTO original_native_chat_inferences VALUES(?,?,?,?,0,NULL,NULL)")
                .run(plan.requestId, snapshot.inferenceId, requestSha256, JSON.stringify(snapshot));
              event(plan.requestId, "model-intent", snapshot);
            });
            await host.authorizeNativeModelRequest(nativeModelId, requestSha256, combined);
            await prepared?.verifyChat(); current(); prepared?.assertCurrent();
            transaction(() => {
              if (combined.aborted) fail("Native model approval was revoked.");
              db.prepare("UPDATE original_native_chat_inferences SET authorized=1 WHERE request_id=? AND inference_id=?")
                .run(plan.requestId, snapshot.inferenceId);
              db.prepare("UPDATE original_native_chat_executions SET status='running',current_inference=?,round=?,updated_at=? WHERE request_id=?")
                .run(snapshot.inferenceId, snapshot.round, Date.now(), plan.requestId);
              event(plan.requestId, "model-authorized", { inferenceId: snapshot.inferenceId, requestSha256 });
            });
            prepared?.assertCurrent();
          },
          async text(request) {
            transaction(() => {
              const row = db.prepare("SELECT * FROM original_native_chat_executions WHERE request_id=?").get(plan.requestId)!;
              if (combined.aborted || row.current_inference !== request.inferenceId || typeof request.text !== "string" || !request.text
                || Number(row.output_bytes) + Buffer.byteLength(request.text) > outputByteLimit) fail("Native text exceeds its owned scope/envelope.");
              const last = db.prepare("SELECT max(sequence) AS n FROM original_native_chat_text WHERE request_id=?").get(plan.requestId)!;
              db.prepare("INSERT INTO original_native_chat_text VALUES(?,?,?,?)").run(plan.requestId, Number(last.n ?? 0) + 1, request.inferenceId, request.text);
              db.prepare("UPDATE original_native_chat_executions SET output_bytes=output_bytes+?,updated_at=? WHERE request_id=?")
                .run(Buffer.byteLength(request.text), Date.now(), plan.requestId);
            });
          },
          async usage(request) {
            transaction(() => {
              const count = request.usage.outputTokens;
              if (!["native-counted", "provider-reported"].includes(request.source) || !Number.isSafeInteger(count) || count < 0 || count > plan.outputTokenCap
                || !Number.isSafeInteger(request.usage.inputTokens) || request.usage.inputTokens < 0) fail("Invalid attributed native usage.");
              const row = db.prepare("SELECT * FROM original_native_chat_inferences WHERE request_id=? AND inference_id=?")
                .get(plan.requestId, request.inferenceId);
              if (!row || row.authorized !== 1) fail("Usage has no authorized inference.");
              const column = request.source === "native-counted" ? "native_output" : "reported_output";
              if (row[column] !== null && count < Number(row[column])) fail("Native usage regressed.");
              db.prepare(`UPDATE original_native_chat_inferences SET ${column}=? WHERE request_id=? AND inference_id=?`)
                .run(count, plan.requestId, request.inferenceId);
              const total = db.prepare(`SELECT sum(max(coalesce(native_output,0),coalesce(reported_output,0))) AS n
                FROM original_native_chat_inferences WHERE request_id=?`).get(plan.requestId)!;
              if (Number(total.n) > plan.budget.maxTotalOutputTokens) fail("Explicit native total-output budget exceeded.");
              event(plan.requestId, "usage", request);
            });
          },
          async tool(request) {
            await prepared?.verifyChat(); current(); prepared?.assertCurrent();
            if (!tools || combined.aborted || originalNativeChatDigest(request.arguments) !== request.argumentsSha256
              || !plan.tools.some(tool => tool.name === request.name)) fail("Native tool is outside the actual Core plan.");
            const operationId = randomUUID();
            transaction(() => {
              const row = db.prepare("SELECT current_inference,round FROM original_native_chat_executions WHERE request_id=?").get(plan.requestId)!;
              if (row.current_inference !== request.inferenceId || row.round !== request.round) fail("Native tool inference changed.");
              const count = Number(db.prepare("SELECT count(*) AS n FROM original_native_chat_inferences WHERE request_id=?")
                .get(plan.requestId)!.n);
              if (plan.hardToolRoundLimit !== null && count > plan.hardToolRoundLimit)
                fail("A tool-free summary cannot invoke a tool.");
              if (db.prepare("SELECT 1 FROM original_native_chat_events WHERE request_id=? AND type='tool-intent' AND json_extract(payload,'$.callId')=?")
                .get(plan.requestId, request.callId)) fail("Tool call already has an intent; never replay it.");
              event(plan.requestId, "tool-intent", { ...request, operationId });
            });
            try {
              if ("managedTask" in plan) await beforeOriginalMcpApiChatTaskTool(host, plan, request);
              const invokeTool = () => tools.tools.execute({
                actor: actor.id, turnId: plan.requestId, operationId, signal: combined,
                call: { id: request.callId, name: request.name, arguments: structuredClone(request.arguments) },
                onApproval(value) { transaction(() => event(plan.requestId, "tool-approval", value)); },
              });
              const output = await (role ? role.withinTool(request, operationId, invokeTool) : invokeTool());
              const observed = db.prepare(`SELECT r.*,b.context_json FROM approval_bridge_runs r
                JOIN approval_bridge_bindings b ON b.execution_id=r.execution_id
                WHERE r.execution_id=? AND r.workspace_id=? AND r.actor_id=? AND r.operation_id=?`)
                .get(output.executionId, host.receipt.workspaceId, actor.id, operationId);
              let effect: "not-committed" | "committed";
              if (!observed && output.executionId === `unavailable-${operationId}` && output.resultStatus === "failed") {
                effect = "not-committed";
              } else {
                if (!observed || observed.result_json === null || !["succeeded", "failed"].includes(String(observed.status)))
                  fail("Canonical tool has no completed actual approval/Core receipt.");
                const context = JSON.parse(String(observed.context_json)), result = JSON.parse(String(observed.result_json));
                if (context.turnId !== plan.requestId || context.contextDigest !== originalNativeChatDigest(plan)
                  || result.schema !== "pkm.tool-result/v1" || !["complete", "failed"].includes(result.status)
                  || !["not-committed", "committed"].includes(result.effect))
                  fail("Canonical tool receipt lost its exact execution/effect binding.");
                effect = result.effect;
              }
              const receiptSha256 = transaction(() => event(plan.requestId, "tool-result", {
                callId: request.callId, operationId, executionId: output.executionId, effect,
                resultStatus: output.resultStatus ?? "complete", contentSha256: originalNativeChatDigest(output.content),
              }));
              return { receiptSha256, effect, content: output.content };
            } catch (error) {
              const effect = error instanceof ChatTurnToolError ? error.effect : "unknown";
              transaction(() => event(plan.requestId, "tool-failed", { callId: request.callId, operationId, effect }));
              if (effect === "unknown" || effect === "committed") abort.abort("tool-outcome-unknown");
              throw error;
            }
          },
        }, combined);
        transaction(() => {
          const anyAuthorized = db.prepare("SELECT 1 FROM original_native_chat_inferences WHERE request_id=? AND authorized=1").get(plan.requestId);
          if (outcome.status === "complete" && (!anyAuthorized || combined.aborted)) fail("Completion lacks a current authorized native inference.");
          db.prepare("UPDATE original_native_chat_executions SET status=?,updated_at=? WHERE request_id=?")
            .run(outcome.status, Date.now(), plan.requestId);
          event(plan.requestId, "execution-finished", outcome);
        });
        return state(plan.requestId);
      } catch (error) {
        if (!closed && !host.signal.aborted && !lifetime.signal.aborted) transaction(() => {
          const sent = db.prepare("SELECT 1 FROM original_native_chat_inferences WHERE request_id=? AND authorized=1").get(plan.requestId);
          db.prepare("UPDATE original_native_chat_executions SET status=?,failure='NATIVE_EXECUTION_FAILED',updated_at=? WHERE request_id=?")
            .run(sent ? "unknown" : "failed", Date.now(), plan.requestId);
          event(plan.requestId, "execution-failed", { dispatched: !!sent });
        });
        throw error;
      } finally { clearTimeout(timer); active.delete(plan.requestId); }
    };
    const done = Promise.resolve().then(invoke);
    active.set(plan.requestId, { abort, done });
    return done;
  };
  const close = async () => {
    if (closed) return;
    closed = true; lifetime.abort();
    const tasks = [...active.values()];
    tasks.forEach(item => item.abort.abort("owner-closed"));
    const errors = (await Promise.allSettled(tasks.map(item => item.done))).filter(item => item.status === "rejected");
    db.close();
    liveExecutionOwners.delete(storage);
    retainedExecutors.delete(owner);
    if (fault) throw new AggregateError([fault, ...errors], "Native execution persistence failed.");
  };
  owner.retainResource({ closeAdmission() { lifetime.abort(); }, release: close });
  const resource = Object.freeze({ run, state, cancel(requestId: string) {
    current(); active.get(requestId)?.abort.abort("explicit-cancel");
    return { ...state(requestId), cancellationPending: active.has(requestId) };
  }, async modelTools(plan: OriginalNativeChatExecutionPlan | OriginalSdkChatPlan) {
    current(); const tools = toolsFor(plan);
    return tools ? tools.modelTools(actor.id, plan.requestId) : [];
  }, close });
  retainedExecutors.set(owner, { host, resource });
  return resource;
}
