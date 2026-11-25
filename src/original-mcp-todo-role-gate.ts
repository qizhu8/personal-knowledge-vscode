import { z } from "zod";
import { DatabaseSync } from "node:sqlite";
import { CoreError, type StorageRequest } from "./contracts.js";
import { originalMcpDomainHash, readOriginalMcpTodoAuthority } from "./original-mcp-domain-state.js";
import { readOriginalMcpJournal, originalMcpPrivateTopLevels } from "./original-mcp-root-custody.js";
import { captureOriginalTodoAssignmentSourcePins, originalTodoAssignmentBindingPins } from "./original-mcp-todo-assignment-gate.js";
import { originalTodoRolePayloads, originalTodoRoleDecision, originalTodoHumanDecision, originalTodoRoleOperations,
  originalTodoRoleDigest } from "./original-mcp-todo-role-contracts.js";
import { withinOriginalTodoRoleScope } from "./original-mcp-todo-role-scope.js";
import { canonicalJson } from "./domain/project-recipes-workflow-contracts.js";
import { todoDefinitions } from "./todo-definitions.js";
import { sha256 } from "./markdown.js";
import { toolResultContent } from "./domain/tool-gateway-projection.js";
import { isMainThread, parentPort } from "node:worker_threads";
import { originalSdkTodoRoleCallback, originalSdkTodoRoleEvidenceId,
  assertOriginalSdkTodoRoleExecution, assertOriginalSdkTodoCompletedTool } from "./original-mcp-sdk-todo-role-provenance.js";

const digest = z.string().regex(/^[a-f0-9]{64}$/), uuid = z.string().uuid();
const buffer = z.custom<SharedArrayBuffer>(value => value instanceof SharedArrayBuffer && value.byteLength === 4);
const source = z.strictObject({
  actorId: z.literal("mcp:external"), decisionId: z.string(), expiresAtMs: z.number().int().positive(),
  root: z.string(), workspaceId: uuid, custodyPlanSha256: digest, profileSha256: digest,
  planSha256: digest, nativeHostReceiptSha256: digest, epoch: uuid, revocation: buffer,
});
export const originalTodoRoleGrantSchema = z.strictObject({
  payload: originalTodoRolePayloads["todo.role.approve"], decision: originalTodoRoleDecision,
  revocation: buffer, todoRevocation: buffer, chatRevocation: buffer, source,
  sourcePins: z.array(z.strictObject({ path: z.string(), sha256: digest.nullable() })).length(2),
});
export type OriginalTodoRoleGrantData = z.infer<typeof originalTodoRoleGrantSchema>;
const callback = z.strictObject({
  requestId: digest, planSha256: digest, inferenceId: digest, round: z.number().int().nonnegative(),
  callId: z.string().min(1).max(256), operationId: uuid,
});
export const originalTodoRoleAdmissionSchema = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("tool"), grant: originalTodoRoleGrantSchema,
    callback: z.union([callback, originalSdkTodoRoleCallback]),
    operation: z.string(), arguments: z.record(z.string(), z.unknown()) }),
  z.strictObject({ kind: z.literal("human"), payload: originalTodoRolePayloads["todo.human.accept"],
    decision: originalTodoHumanDecision, revocation: buffer,
    worker: originalTodoRoleGrantSchema, reviewer: originalTodoRoleGrantSchema }),
]);
export type OriginalTodoRoleAdmission = z.infer<typeof originalTodoRoleAdmissionSchema>;
export const ORIGINAL_TODO_HUMAN_OPERATION = "private.original-todo-human.accept";
export const originalTodoRoleEffectDdl = `
CREATE TABLE original_native_todo_role_effects(
 operation_id TEXT PRIMARY KEY,request_json TEXT NOT NULL,admission_json TEXT NOT NULL,
 admission_sha256 TEXT NOT NULL,fingerprint TEXT NOT NULL,before_sha256 TEXT NOT NULL,
 after_sha256 TEXT NOT NULL,result_json TEXT NOT NULL);
CREATE TRIGGER original_native_todo_role_effects_no_update BEFORE UPDATE ON original_native_todo_role_effects
BEGIN SELECT RAISE(ABORT,'native Todo role effect immutable'); END;
CREATE TRIGGER original_native_todo_role_effects_no_delete BEFORE DELETE ON original_native_todo_role_effects
BEGIN SELECT RAISE(ABORT,'native Todo role effect immutable'); END;`;
function deny(message = "The exact live Todo role/human admission is unavailable or stale."): never {
  throw new CoreError("NATIVE_AUTHORITY_REQUIRED", message);
}
const same = (a: unknown, b: unknown) => a !== undefined && b !== undefined && originalTodoRoleDigest(a) === originalTodoRoleDigest(b);
function persistedGrant(value: OriginalTodoRoleGrantData) {
  const { revocation: _revocation, ...source } = value.source;
  return { payload: value.payload, decision: value.decision, source, sourcePins: value.sourcePins };
}
export function persistedOriginalTodoRoleAdmission(data: OriginalTodoRoleAdmission) {
  return data.kind === "tool"
    ? { kind: data.kind, grant: persistedGrant(data.grant), callback: data.callback, operation: data.operation, arguments: data.arguments }
    : { kind: data.kind, payload: data.payload, decision: data.decision,
      worker: persistedGrant(data.worker), reviewer: persistedGrant(data.reviewer) };
}
export function originalTodoRoleStorageRequest(data: OriginalTodoRoleAdmission): StorageRequest {
  return data.kind === "tool"
    ? { operation: data.operation, args: data.arguments, actorId: data.grant.payload.request.actorId }
    : { operation: ORIGINAL_TODO_HUMAN_OPERATION, actorId: "user:local", args: {
      board_slug: data.payload.request.boardSlug, id: data.payload.request.workItemId,
      expected_digest: data.payload.request.boardDigest, operationId: data.payload.request.operationId,
      reason: data.decision.reason,
    } };
}
export function originalTodoRoleOperationId(data: OriginalTodoRoleAdmission) {
  return data.kind === "tool" ? data.callback.operationId : data.payload.request.operationId;
}
export function readOriginalTodoRoleEffect(db: DatabaseSync, operationId: string) {
  if (!db.prepare("SELECT 1 FROM sqlite_master WHERE name='original_native_todo_role_effects'").get()) return;
  const expected = new DatabaseSync(":memory:");
  try {
    expected.exec(originalTodoRoleEffectDdl);
    const query = "SELECT type,name,tbl_name,sql FROM sqlite_master WHERE name LIKE 'original_native_todo_role_effects%' ORDER BY name";
    if (!same(db.prepare(query).all(), expected.prepare(query).all())) deny("Todo role effect schema changed.");
  } finally { expected.close(); }
  return db.prepare("SELECT * FROM original_native_todo_role_effects WHERE operation_id=?").get(operationId);
}

export class OriginalTodoRoleGate {
  private readonly admissions = new Map<string, OriginalTodoRoleAdmission>();
  constructor(private readonly root: string, private readonly db: DatabaseSync,
    private readonly readChat: (id: string) => { id: string; revision: number; archivedAt?: string }) {}
  private grant(data: OriginalTodoRoleGrantData, lease: { ownerId?: string; fence?: number }) {
    const g = data.payload.request, s = data.source, b = data.payload.binding, db = this.db;
    const journal = readOriginalMcpJournal(this.root);
    for (const value of [data.revocation, data.todoRevocation, data.chatRevocation, s.revocation])
      if (Atomics.load(new Int32Array(value), 0) !== 0) deny("Todo role or its source was revoked.");
    if (!journal || g.root !== this.root || g.workspaceId !== journal.workspaceId
      || g.custodyPlanSha256 !== journal.plan.planSha256 || g.profileSha256 !== journal.plan.profileSha256
      || g.ownerLease.ownerId !== lease.ownerId || g.ownerLease.fence !== lease.fence
      || g.actorId !== `chat:${g.chatId}` || g.expiresAtMs <= Date.now()
      || data.decision.expiresAtMs <= Date.now() || data.decision.expiresAtMs > g.expiresAtMs
      || data.decision.actorId !== g.actorId || data.decision.epoch !== g.nativeEpoch
      || data.decision.requestSha256 !== originalTodoRoleDigest(data.payload)
      || originalMcpPrivateTopLevels(this.root, "notes").has(g.boardSlug.split("/")[0]!)
      || g.boardSlug.split("/")[0]!.toLowerCase() === "system") deny();
    const owner = db.prepare("SELECT owner_id,fence,lease_until FROM native_runtime_owner WHERE singleton=1").get();
    if (!owner || owner.owner_id !== lease.ownerId || owner.fence !== lease.fence || Number(owner.lease_until) <= Date.now()) deny();
    const authority = readOriginalMcpTodoAuthority(this.root, "mcp:external", g.boardSlug, db);
    if (authority.intentSha256 !== g.intentSha256 || authority.sessionDecisionId !== g.todoDecisionId
      || authority.nativeHostReceiptSha256 !== g.nativeHostReceiptSha256 || authority.expiresAtMs < g.expiresAtMs) deny();
    if (s.actorId !== "mcp:external" || s.root !== this.root || s.workspaceId !== g.workspaceId
      || s.custodyPlanSha256 !== g.custodyPlanSha256 || s.profileSha256 !== g.profileSha256
      || s.nativeHostReceiptSha256 !== g.nativeHostReceiptSha256 || s.epoch !== g.nativeEpoch
      || s.planSha256 !== g.chatSourcePlanSha256 || s.decisionId !== g.chatSourceDecisionId || s.expiresAtMs < g.expiresAtMs) deny();
    const source = db.prepare("SELECT sha256 FROM original_api_chat_source_admission WHERE singleton=1").get();
    const host = db.prepare("SELECT payload FROM original_mcp_native_host_admissions WHERE receipt_sha256=?").get(g.nativeHostReceiptSha256);
    if (source?.sha256 !== g.chatSourcePlanSha256 || !host) deny();
    const native = JSON.parse(String(host.payload)), { receiptSha256, ...body } = native;
    if (receiptSha256 !== g.nativeHostReceiptSha256 || !same(body, b) || originalMcpDomainHash(body) !== receiptSha256
      || b.root !== this.root || b.workspaceId !== g.workspaceId || b.actorId !== "mcp:external"
      || b.planSha256 !== g.custodyPlanSha256 || b.profileSha256 !== g.profileSha256
      || b.sourceCatalogSha256 !== g.catalogSha256 || b.epoch !== g.nativeEpoch
      || b.authorityId !== `native-rpc:${g.nativeBrokerId}` || !b.domains.includes("api-chat-native")) deny();
    const chat = db.prepare("SELECT namespace,trashed_at FROM original_api_chat_source_chats WHERE id=?").get(g.chatId);
    if (!chat || chat.trashed_at !== null || g.chatUrl !== `pkm://chats/${chat.namespace}/${g.chatId}`
      || !same(captureOriginalTodoAssignmentSourcePins(this.root, db, g.chatId), data.sourcePins)) deny();
    const pins = { coreSessionId: g.chatId, chatUrl: g.chatUrl, sourcePlanSha256: g.chatSourcePlanSha256,
      nativeEpoch: g.nativeEpoch, nativeRequestId: g.bindingRequestId, ownerLease: g.ownerLease };
    if (originalTodoAssignmentBindingPins(db, pins) !== g.bindingSha256) deny();
    const session = this.readChat(g.chatId);
    if (session.id !== g.chatId || session.revision !== g.chatRevision || session.archivedAt) deny();
  }
  check(data: OriginalTodoRoleAdmission, lease: { ownerId?: string; fence?: number }, replay = false) {
    if (data.kind === "human") {
      this.grant(data.worker, lease); this.grant(data.reviewer, lease);
      const p = data.payload.request, w = data.worker.payload.request, r = data.reviewer.payload.request;
      if (Atomics.load(new Int32Array(data.revocation), 0) !== 0 || p.expiresAtMs <= Date.now()
        || data.decision.expiresAtMs <= Date.now() || data.decision.expiresAtMs > p.expiresAtMs
        || data.decision.actorId !== "user:local" || data.decision.epoch !== p.nativeEpoch
        || data.decision.requestSha256 !== originalTodoRoleDigest(data.payload) || w.role !== "worker" || r.role !== "reviewer"
        || w.actorId === r.actorId || !same(data.payload.binding, data.worker.payload.binding)
        || !same(data.payload.binding, data.reviewer.payload.binding) || p.itemSha256 !== originalTodoRoleDigest(p.item)
        || p.item.id !== p.workItemId || p.item.state !== "Done" || p.item.acceptanceDecision !== undefined) deny();
      for (const g of [w, r]) {
        for (const key of ["root", "workspaceId", "custodyPlanSha256", "profileSha256", "catalogSha256",
          "nativeHostReceiptSha256", "nativeEpoch", "nativeBrokerId", "nativeIdentitySha256", "boardSlug",
          "workItemId", "intentSha256", "todoDecisionId", "chatSourcePlanSha256", "chatSourceDecisionId"] as const)
          if (p[key] !== g[key]) deny();
        if (!same(p.ownerLease, g.ownerLease) || p.expiresAtMs > g.expiresAtMs) deny();
      }
      this.proof(data.worker, p.worker, "todo.workitem.submit");
      const recommendation = this.proof(data.reviewer, p.reviewer, "todo.workitem.comment");
      const item = JSON.parse(String(recommendation.result_json)).item;
      if (!same(item, p.item) || item.ownerId !== w.actorId || item.state !== "Done"
        || !Array.isArray(item.comments) || !item.comments.some((c: Record<string, unknown>) =>
          c.actorId === r.actorId && typeof c.text === "string" && c.text.trim())) deny();
      return;
    }
    this.grant(data.grant, lease);
    const g = data.grant.payload.request, c = data.callback, db = this.db;
    if (c.requestId !== g.requestId || c.planSha256 !== g.planSha256
      || !(originalTodoRoleOperations[g.role] as readonly string[]).includes(data.operation)
      || data.arguments.board_slug !== g.boardSlug || data.arguments.id !== g.workItemId) deny();
    const definition = todoDefinitions.find(d => d.id === data.operation)!;
    if (!same(definition.input.parse(data.arguments), data.arguments)
      || !definition.readOnly && data.arguments.operationId !== c.operationId) deny();
    if ("provider" in c) {
      const { operationId: _op, ...modelArguments } = data.arguments;
      assertOriginalSdkTodoRoleExecution(db, data.grant, c, data.operation,
        definition.readOnly ? data.arguments : modelArguments, replay);
      return;
    }
    const execution = db.prepare("SELECT * FROM original_native_chat_executions WHERE request_id=?").get(c.requestId);
    const inference = db.prepare("SELECT authorized FROM original_native_chat_inferences WHERE request_id=? AND inference_id=?")
      .get(c.requestId, c.inferenceId);
    if (!execution || execution.plan_sha256 !== g.planSha256 || originalTodoRoleDigest(JSON.parse(String(execution.plan))) !== g.planSha256
      || execution.native_model_id !== g.modelId || execution.status !== "running" || inference?.authorized !== 1
      || !replay && (execution.current_inference !== c.inferenceId || execution.round !== c.round)) deny();
    const plan = JSON.parse(String(execution.plan));
    const prepared = db.prepare("SELECT payload FROM original_native_chat_events WHERE request_id=? AND type='execution-prepared' ORDER BY sequence LIMIT 1").get(c.requestId);
    if (plan.requestId !== g.requestId || plan.chatUrl !== g.chatUrl || plan.selectionId !== g.selectionId
      || plan.sourcePlanSha256 !== g.chatSourcePlanSha256 || !prepared) deny();
    const started = JSON.parse(String(prepared.payload));
    if (!same(started.ownerLease, g.ownerLease) || !same(started.todoRole, {
      actorId: g.actorId, role: g.role, boardSlug: g.boardSlug, workItemId: g.workItemId,
      decisionId: data.grant.decision.decisionId, requestSha256: data.grant.decision.requestSha256,
    })) deny("The actual model execution lacks this exact signed Todo role.");
    const intent = db.prepare(`SELECT payload FROM original_native_chat_events WHERE request_id=? AND type='tool-intent'
      AND json_extract(payload,'$.callId')=?`).get(c.requestId, c.callId);
    const { operationId: _op, ...modelArguments } = data.arguments;
    if (!intent) deny();
    const observed = JSON.parse(String(intent.payload));
    if (observed.operationId !== c.operationId || observed.inferenceId !== c.inferenceId || observed.round !== c.round
      || observed.name !== definition.transportName || !same(observed.arguments, definition.readOnly ? data.arguments : modelArguments)
      || observed.argumentsSha256 !== originalTodoRoleDigest(observed.arguments)) deny();
    const approval = db.prepare(`SELECT a.status,b.context_json,e.tool,e.actor,e.arguments_json AS arguments,e.status AS execution_status,
      e.approval_decision_id FROM approval_bridge_runs a JOIN approval_bridge_bindings b ON b.execution_id=a.execution_id
      JOIN execution_records e ON e.id=a.execution_id WHERE a.operation_id=? AND a.workspace_id=? AND a.actor_id='mcp:external'`)
      .get(c.operationId, g.workspaceId);
    if (!approval || approval.tool !== data.operation || approval.actor !== "mcp:external"
      || !approval.approval_decision_id || !same(JSON.parse(String(approval.arguments)), data.arguments)) deny();
    const context = JSON.parse(String(approval.context_json));
    if (context.turnId !== c.requestId || context.contextDigest !== c.planSha256
      || !replay && (approval.status !== "running" || approval.execution_status !== "running")) deny();
  }
  private proof(grant: OriginalTodoRoleGrantData, proof: {
    operationId: string; requestId: string; planSha256: string; actorId: string; decisionId: string; requestSha256: string;
  }, operation: string) {
    const g = grant.payload.request, row = readOriginalTodoRoleEffect(this.db, proof.operationId);
    if (!row || proof.requestId !== g.requestId || proof.planSha256 !== g.planSha256 || proof.actorId !== g.actorId
      || proof.decisionId !== grant.decision.decisionId || proof.requestSha256 !== grant.decision.requestSha256
      || row.admission_sha256 !== sha256(String(row.admission_json))) deny();
    const admission = JSON.parse(String(row.admission_json));
    if (admission.kind !== "tool" || admission.operation !== operation || !same(admission.grant, persistedGrant(grant))) deny();
    const execution = this.db.prepare("SELECT status,plan_sha256 FROM original_native_chat_executions WHERE request_id=?").get(g.requestId);
    if (execution?.status !== "complete" || execution.plan_sha256 !== g.planSha256) deny();
    this.completedTool(admission.callback, row.result_json);
    return row;
  }
  private completedTool(c: Extract<OriginalTodoRoleAdmission, { kind: "tool" }>["callback"], result: unknown) {
    if ("provider" in c) {
      assertOriginalSdkTodoCompletedTool(this.db, originalSdkTodoRoleCallback.parse(c), result);
      return;
    }
    const row = this.db.prepare(`SELECT r.payload,a.status,a.result_json,b.context_json FROM original_native_chat_events r
      JOIN approval_bridge_runs a ON a.execution_id=json_extract(r.payload,'$.executionId')
      JOIN approval_bridge_bindings b ON b.execution_id=a.execution_id WHERE r.request_id=? AND r.type='tool-result'
      AND json_extract(r.payload,'$.callId')=? AND a.operation_id=? AND a.actor_id='mcp:external'`)
      .get(c.requestId, c.callId, c.operationId);
    if (!row || row.status !== "succeeded" || !row.result_json) deny("Todo evidence lacks its actual completed native model tool receipt.");
    const owned = JSON.parse(String(row.result_json)), event = JSON.parse(String(row.payload)), context = JSON.parse(String(row.context_json));
    if (owned.status !== "complete" || !same(owned.result, JSON.parse(String(result)))
      || event.operationId !== c.operationId || event.resultStatus !== "complete"
      || event.effect !== owned.effect || event.contentSha256 !== originalTodoRoleDigest(toolResultContent(owned))
      || context.turnId !== c.requestId || context.contextDigest !== c.planSha256) deny();
  }
  evidence(data: Extract<OriginalTodoRoleAdmission, { kind: "tool" }>, expectedState: "WIP" | "Done") {
    const g = data.grant.payload.request;
    const rows = this.db.prepare(`SELECT * FROM original_native_todo_role_effects
      WHERE json_extract(admission_json,'$.grant.decision.decisionId')=? LIMIT 4096`).all(data.grant.decision.decisionId);
    const reads = rows.filter(row => {
      if (row.admission_sha256 !== sha256(String(row.admission_json))) deny();
      const a = JSON.parse(String(row.admission_json)), result = JSON.parse(String(row.result_json));
      if (a.kind !== "tool" || a.operation !== "todo.workitem.get" || !same(a.grant, persistedGrant(data.grant))
        || result.item?.state !== expectedState || result.digest !== data.arguments.expected_digest) return false;
      this.completedTool(a.callback, row.result_json);
      return true;
    });
    if (!reads.length) deny("Read this exact current workitem through the actual model callback before submission/recommendation.");
    if (data.operation === "todo.workitem.submit") {
      const evidence = data.arguments.evidence;
      if (!Array.isArray(evidence) || !evidence.length || evidence.some(id => !reads.some(row => {
        const a = JSON.parse(String(row.admission_json)), item = JSON.parse(String(row.result_json)).item;
        const evidenceId = "provider" in a.callback
          ? originalSdkTodoRoleEvidenceId(originalSdkTodoRoleCallback.parse(a.callback))
          : `native-todo-evidence:${a.callback.callId}`;
        return id === evidenceId && item.ownerId === g.actorId;
      }))) deny("Only actual current-role model read receipts may support this bounded result.");
      if (data.arguments.verification !== undefined) deny("This representative role slice does not fabricate verification reports.");
    }
  }
  snapshot(data: OriginalTodoRoleAdmission, currentDigest: string) {
    if (data.kind === "human") {
      if (currentDigest !== data.payload.request.boardDigest) deny("The exact human acceptance target changed.");
      return;
    }
    let expected = data.grant.payload.request.boardDigest;
    if (this.db.prepare("SELECT 1 FROM sqlite_master WHERE name='original_native_todo_role_effects'").get()) {
      const row = this.db.prepare(`SELECT * FROM original_native_todo_role_effects
        WHERE json_extract(admission_json,'$.grant.decision.decisionId')=? ORDER BY rowid DESC LIMIT 1`).get(data.grant.decision.decisionId);
      if (row) {
        if (row.admission_sha256 !== sha256(String(row.admission_json))) deny();
        expected = String(row.after_sha256);
      }
    }
    if (currentDigest !== expected) deny("An outside Board change cannot be inherited by a timed role grant.");
  }
  admit(value: unknown, lease: { ownerId?: string; fence?: number }) {
    if (isMainThread || !parentPort) deny("Only the canonical private Storage worker can admit role effects.");
    const data = originalTodoRoleAdmissionSchema.parse(value), id = originalTodoRoleOperationId(data);
    this.check(data, lease);
    const prior = this.admissions.get(id);
    if (prior && !same(persistedOriginalTodoRoleAdmission(prior), persistedOriginalTodoRoleAdmission(data))) deny();
    if (!prior && this.admissions.size >= 4096) deny("Todo role admission envelope is exhausted.");
    this.admissions.set(id, data);
    return data;
  }
  assertRequest(request: StorageRequest, data: OriginalTodoRoleAdmission | undefined, lease: { ownerId?: string; fence?: number }) {
    if (data) {
      if (!same(request, originalTodoRoleStorageRequest(data))) deny();
      this.check(data, lease);
    } else if (request.operation === ORIGINAL_TODO_HUMAN_OPERATION
      || readOriginalMcpJournal(this.root) && request.operation.startsWith("todo.") && request.actorId.startsWith("chat:")
      || typeof request.args.operationId === "string" && readOriginalTodoRoleEffect(this.db, request.args.operationId)) {
      deny("Generic requests and receipt copies cannot acquire a Todo role or human decision.");
    }
  }
  within<T>(data: OriginalTodoRoleAdmission, lease: { ownerId?: string; fence?: number }, work: () => T): T {
    this.check(data, lease);
    const request = originalTodoRoleStorageRequest(data);
    return withinOriginalTodoRoleScope(this.db, { root: this.root, actorId: request.actorId,
      boardSlug: String(request.args.board_slug) }, () => {
      const result = work();
      this.check(data, lease);
      return result;
    });
  }
  persist(data: OriginalTodoRoleAdmission, request: StorageRequest, fingerprint: string, before: string, after: string, result: string) {
    if (isMainThread || !parentPort || !this.db.isTransaction) deny();
    this.check(data, data.kind === "tool" ? data.grant.payload.request.ownerLease : data.payload.request.ownerLease);
    if (!this.db.prepare("SELECT 1 FROM sqlite_master WHERE name='original_native_todo_role_effects'").get())
      this.db.exec(originalTodoRoleEffectDdl);
    const admission = canonicalJson(persistedOriginalTodoRoleAdmission(data));
    this.db.prepare("INSERT INTO original_native_todo_role_effects VALUES(?,?,?,?,?,?,?,?)").run(
      originalTodoRoleOperationId(data), canonicalJson(request), admission, sha256(admission), fingerprint, before, after, result);
  }
  receipt(data: OriginalTodoRoleAdmission, request: StorageRequest, fingerprint: string) {
    const row = readOriginalTodoRoleEffect(this.db, originalTodoRoleOperationId(data));
    if (!row || row.fingerprint !== fingerprint || row.request_json !== canonicalJson(request)
      || row.admission_sha256 !== sha256(String(row.admission_json))
      || row.admission_json !== canonicalJson(persistedOriginalTodoRoleAdmission(data))) deny("Todo role receipt cannot restore authority.");
  }
  withinPending<T>(pending: Record<string, unknown>, lease: { ownerId?: string; fence?: number }, work: (check: () => void) => T): T {
    const row = readOriginalTodoRoleEffect(this.db, String(pending.operation_id));
    if (!row) {
      if (pending.operation === ORIGINAL_TODO_HUMAN_OPERATION
        || readOriginalMcpJournal(this.root) && String(pending.actor_id).startsWith("chat:"))
        deny("A role pending effect has no owning live admission.");
      return work(() => undefined);
    }
    const data = this.admissions.get(String(pending.operation_id));
    if (!data || row.admission_sha256 !== sha256(String(row.admission_json))
      || row.admission_json !== canonicalJson(persistedOriginalTodoRoleAdmission(data))
      || row.request_json !== canonicalJson(originalTodoRoleStorageRequest(data))
      || row.fingerprint !== pending.fingerprint || row.before_sha256 !== pending.before_sha256
      || row.after_sha256 !== sha256(String(pending.after_json)) || row.result_json !== pending.result
      || pending.actor_id !== originalTodoRoleStorageRequest(data).actorId
      || pending.operation !== originalTodoRoleStorageRequest(data).operation
      || pending.board_slug !== originalTodoRoleStorageRequest(data).args.board_slug) deny("Restart, copies and stale grants cannot recover a role effect.");
    return this.within(data, lease, () => work(() => this.check(data, lease)));
  }
}
