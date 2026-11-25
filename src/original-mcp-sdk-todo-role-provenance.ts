import { z } from "zod";
import type { DatabaseSync } from "node:sqlite";
import { CoreError } from "./contracts.js";
import { originalSdkDigest, originalSdkSendingBoundary } from "./original-mcp-sdk-model-contracts.js";
import type { OriginalTodoRoleGrantData } from "./original-mcp-todo-role-gate.js";
import { toolResultContent } from "./domain/tool-gateway-projection.js";
import { todoDefinitions } from "./todo-definitions.js";

const digest = z.string().regex(/^[a-f0-9]{64}$/), text = z.string().min(1).max(512);
export const originalSdkTodoRoleCallback = z.strictObject({
  provider: z.literal("copilot-sdk"), requestId: digest, planSha256: digest,
  sdkSessionId: text, sendingBoundaryId: digest, sendingInvocationId: text,
  callId: text, argumentsSha256: digest, toolReceiptId: text, operationId: z.string().uuid(),
});
export type OriginalSdkTodoRoleCallback = z.infer<typeof originalSdkTodoRoleCallback>;
function deny(): never { throw new CoreError("NATIVE_AUTHORITY_REQUIRED", "The exact signed SDK role/session/sending/tool provenance is unavailable or stale."); }
const same = (a: unknown, b: unknown) => a !== undefined && b !== undefined && originalSdkDigest(a) === originalSdkDigest(b);
export const originalSdkTodoRoleEvidenceId = (callback: OriginalSdkTodoRoleCallback) =>
  `sdk-todo-evidence:${originalSdkDigest(callback)}`;

/** Additional SDK evidence checks only; the existing worker grant/source/CAS/human checks remain mandatory. */
export function assertOriginalSdkTodoRoleExecution(db: DatabaseSync, grant: OriginalTodoRoleGrantData,
  value: OriginalSdkTodoRoleCallback, operation: string, modelArguments: Readonly<Record<string, unknown>>, replay: boolean) {
  const callback = originalSdkTodoRoleCallback.parse(value), g = grant.payload.request;
  if (g.schema !== "pkm.original-sdk-todo-role-request/v1" || g.provider !== "copilot-sdk") deny();
  const execution = db.prepare("SELECT * FROM original_native_chat_executions WHERE request_id=?").get(callback.requestId);
  if (!execution || execution.status !== "running" || execution.plan_sha256 !== callback.planSha256
    || callback.requestId !== g.requestId || callback.planSha256 !== g.planSha256
    || execution.native_model_id !== g.modelId || !replay && execution.current_inference !== callback.sdkSessionId) deny();
  const plan = JSON.parse(String(execution.plan));
  if (plan.schema !== "pkm.original-sdk-api-chat-execution/v1" || originalSdkDigest(plan) !== g.planSha256
    || plan.requestId !== g.requestId || plan.chatUrl !== g.chatUrl || plan.selectionId !== g.selectionId
    || plan.epoch !== g.nativeEpoch || plan.hostReceiptSha256 !== g.nativeHostReceiptSha256
    || plan.sourcePlanSha256 !== g.chatSourcePlanSha256) deny();
  const prepared = db.prepare("SELECT payload FROM original_native_chat_events WHERE request_id=? AND type='sdk-execution-prepared'")
    .get(g.requestId);
  const started = prepared && JSON.parse(String(prepared.payload));
  if (!started || !same(started.ownerLease, g.ownerLease) || !same(started.todoRole, {
    actorId: g.actorId, role: g.role, boardSlug: g.boardSlug, workItemId: g.workItemId,
    decisionId: grant.decision.decisionId, requestSha256: grant.decision.requestSha256,
  })) deny();
  const sent = db.prepare(`SELECT payload FROM original_native_chat_events WHERE request_id=? AND type='sdk-sending-approved'
    AND json_extract(payload,'$.boundaryId')=?`).get(g.requestId, callback.sendingBoundaryId);
  if (!sent) deny();
  const sending = originalSdkSendingBoundary.parse(JSON.parse(String(sent.payload))), { boundaryId, ...body } = sending;
  if (originalSdkDigest(body) !== boundaryId || sending.kind === "websocket-connect"
    || sending.binding.sdkSessionId !== callback.sdkSessionId || sending.sdkInvocationId !== callback.sendingInvocationId
    || sending.binding.requestId !== g.requestId || sending.binding.selectionId !== g.selectionId
    || sending.binding.planSha256 !== g.planSha256 || sending.binding.modelId !== g.modelId
    || sending.binding.sourcePlanSha256 !== g.chatSourcePlanSha256 || sending.binding.epoch !== g.nativeEpoch
    || sending.binding.hostReceiptSha256 !== g.nativeHostReceiptSha256) deny();
  const session = db.prepare(`SELECT payload FROM original_native_chat_events WHERE request_id=? AND type='sdk-session-admitted'
    AND json_extract(payload,'$.binding.sdkSessionId')=?`).get(g.requestId, callback.sdkSessionId);
  if (!session || !same(JSON.parse(String(session.payload)).binding, sending.binding)) deny();
  const intent = db.prepare(`SELECT payload FROM original_native_chat_events WHERE request_id=? AND type='sdk-tool-intent'
    AND json_extract(payload,'$.callId')=?`).get(g.requestId, callback.callId);
  if (!intent) deny();
  const observed = JSON.parse(String(intent.payload));
  const definition = todoDefinitions.find(definition => definition.id === operation);
  if (!definition) deny();
  if (observed.provenance !== "sdk-session-tool-invocation" || observed.sdkSessionId !== callback.sdkSessionId
    || observed.sendingBoundaryId !== callback.sendingBoundaryId || observed.operationId !== callback.operationId
    || observed.name !== definition.transportName
    || !same(observed.arguments, modelArguments) || observed.argumentsSha256 !== callback.argumentsSha256
    || originalSdkDigest(observed.arguments) !== callback.argumentsSha256) deny();
  const receipt = db.prepare(`SELECT r.execution_id,r.status,b.context_json,e.actor,e.tool,e.status AS execution_status,
    e.approval_decision_id,e.arguments_json FROM approval_bridge_runs r JOIN approval_bridge_bindings b ON b.execution_id=r.execution_id
    JOIN execution_records e ON e.id=r.execution_id WHERE r.operation_id=? AND r.workspace_id=? AND r.actor_id='mcp:external'`)
    .get(callback.operationId, g.workspaceId);
  if (!receipt || receipt.execution_id !== callback.toolReceiptId || receipt.actor !== "mcp:external"
    || receipt.tool !== operation || !receipt.approval_decision_id
    || !replay && (receipt.status !== "running" || receipt.execution_status !== "running")) deny();
  const canonicalArguments = definition.readOnly ? modelArguments : { ...modelArguments, operationId: callback.operationId };
  if (!same(JSON.parse(String(receipt.arguments_json)), canonicalArguments)) deny();
  const context = JSON.parse(String(receipt.context_json));
  if (context.turnId !== callback.requestId || context.contextDigest !== callback.planSha256) deny();
}

export function assertOriginalSdkTodoCompletedTool(db: DatabaseSync, value: OriginalSdkTodoRoleCallback, result: unknown) {
  const callback = originalSdkTodoRoleCallback.parse(value);
  const row = db.prepare(`SELECT r.payload,a.execution_id,a.status,a.result_json,b.context_json FROM original_native_chat_events r
    JOIN approval_bridge_runs a ON a.execution_id=json_extract(r.payload,'$.executionId')
    JOIN approval_bridge_bindings b ON b.execution_id=a.execution_id WHERE r.request_id=? AND r.type='sdk-tool-result'
    AND json_extract(r.payload,'$.callId')=? AND a.operation_id=? AND a.actor_id='mcp:external'`)
    .get(callback.requestId, callback.callId, callback.operationId);
  if (!row || row.execution_id !== callback.toolReceiptId || row.status !== "succeeded" || !row.result_json) deny();
  const output = JSON.parse(String(row.result_json)), event = JSON.parse(String(row.payload)), context = JSON.parse(String(row.context_json));
  if (output.status !== "complete" || !same(output.result, JSON.parse(String(result)))
    || event.operationId !== callback.operationId || event.resultStatus !== "complete" || event.effect !== output.effect
    || event.contentSha256 !== originalSdkDigest(toolResultContent(output))
    || context.turnId !== callback.requestId || context.contextDigest !== callback.planSha256) deny();
}
