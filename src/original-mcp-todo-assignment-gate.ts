import { createHash } from "node:crypto";
import { realpathSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { z } from "zod";
import { CoreError } from "./host-composition-legacy-batch15-errors.js";
import type { StorageRequest } from "./contracts.js";
import { canonicalJson } from "./domain/project-recipes-workflow-contracts.js";
import { originalMcpDomainHash, readOriginalMcpTodoAuthority } from "./original-mcp-domain-state.js";
import { originalMcpPrivateBytes, readOriginalMcpJournal } from "./original-mcp-root-custody.js";
import { todoDefinitions } from "./todo-definitions.js";

const digest = z.string().regex(/^[a-f0-9]{64}$/), uuid = z.string().uuid();
const lease = z.strictObject({ ownerId: uuid, fence: z.number().int().positive() });
const buffer = z.custom<SharedArrayBuffer>(value => value instanceof SharedArrayBuffer && value.byteLength === 4);
const actor = z.strictObject({ id: z.string().min(1), canWrite: z.literal(true),
  boardWorker: z.strictObject({ boardSlug: z.string(), digest }).optional(),
  collaborationKind: z.enum(["human", "agent", "browser"]).optional(), recipeProtocol: z.literal(true).optional() });
const guard = z.strictObject({
  schema: z.literal("pkm.original-mcp-todo-chat-assignment-guard/v1"),
  root: z.string(), workspaceId: uuid, actorId: z.string(), requestSha256: digest, operationId: uuid,
  boardSlug: z.string(), boardDigest: digest, workItemId: z.string(), ownerId: z.string(),
  chatUrl: z.string(), coreSessionId: uuid, coreRevision: z.number().int().nonnegative(),
  intentSha256: digest, sessionDecisionId: z.string(), workerReceiptSha256: digest.optional(),
  nativeHostReceiptSha256: digest, sourcePlanSha256: digest, chatSourceDecisionId: z.string(),
  nativeEpoch: z.string(), nativeRequestId: digest, nativeBrokerId: uuid, nativeActivationId: uuid,
  nativeIdentitySha256: digest, ownerLease: lease, expiresAtMs: z.number().int().positive(),
});
const source = z.strictObject({ actorId: z.literal("mcp:external"), decisionId: z.string().min(1),
  expiresAtMs: z.number().int().positive(), root: z.string(), workspaceId: uuid,
  custodyPlanSha256: digest, profileSha256: digest, planSha256: digest,
  nativeHostReceiptSha256: digest, epoch: z.string(), revocation: buffer });
export const originalTodoAssignmentAdmissionSchema = z.strictObject({
  schema: z.literal("pkm.original-mcp-todo-assignment-storage/v1"), actor,
  arguments: z.record(z.string(), z.unknown()), guard, chatSourceAuthority: source,
  revocation: buffer, todoRevocation: buffer, chatSourceRevocation: buffer,
  bindingSha256: digest,
  sourcePins: z.array(z.strictObject({ path: z.string(), sha256: digest.nullable() })).length(2),
});
export type OriginalTodoAssignmentAdmission = z.infer<typeof originalTodoAssignmentAdmissionSchema>;
export const originalTodoAssignmentDdl = `
CREATE TABLE original_mcp_todo_assignments(
 operation_id TEXT PRIMARY KEY,fingerprint TEXT NOT NULL,request_json TEXT NOT NULL,
 guard_json TEXT NOT NULL,guard_sha256 TEXT NOT NULL,after_sha256 TEXT NOT NULL,result_json TEXT NOT NULL);
CREATE TRIGGER original_mcp_todo_assignments_no_update BEFORE UPDATE ON original_mcp_todo_assignments
BEGIN SELECT RAISE(ABORT,'original Todo assignment immutable'); END;
CREATE TRIGGER original_mcp_todo_assignments_no_delete BEFORE DELETE ON original_mcp_todo_assignments
BEGIN SELECT RAISE(ABORT,'original Todo assignment immutable'); END;`;
const hash = (bytes: Uint8Array | string) => createHash("sha256").update(bytes).digest("hex");
function fail(message = "A fresh private original Chat assignment admission is required; native existence and retained receipts grant nothing."): never {
  throw new CoreError("NATIVE_AUTHORITY_REQUIRED", message);
}
export function isOriginalTodoChatAssignment(root: string, db: DatabaseSync, request: StorageRequest): boolean {
  return !!readOriginalMcpJournal(root) && request.operation === "todo.workitem.assign"
    && typeof request.args.owner_id === "string" && request.args.owner_id.startsWith("chat:")
    && !!db.prepare("SELECT 1 FROM sqlite_master WHERE name='original_api_chat_source_chats'").get()
    && !!db.prepare("SELECT 1 FROM original_api_chat_source_chats WHERE id=?").get(request.args.owner_id.slice(5));
}
export function originalTodoAssignmentRequest(data: OriginalTodoAssignmentAdmission): StorageRequest {
  return { operation: "todo.workitem.assign", args: data.arguments, actorId: data.actor.id,
    ...(data.actor.boardWorker ? { boardWorker: data.actor.boardWorker } : {}) };
}
export function originalTodoAssignmentRecord(db: DatabaseSync, operationId: string): Record<string, unknown> | undefined {
  if (!db.prepare("SELECT 1 FROM sqlite_master WHERE name='original_mcp_todo_assignments'").get()) return;
  const expected = new DatabaseSync(":memory:");
  try {
    expected.exec(originalTodoAssignmentDdl);
    const query = "SELECT type,name,tbl_name,sql FROM sqlite_master WHERE name LIKE 'original_mcp_todo_assignments%' ORDER BY name";
    if (canonicalJson(db.prepare(query).all()) !== canonicalJson(expected.prepare(query).all())) fail("Original assignment receipt schema changed.");
  } finally { expected.close(); }
  return db.prepare("SELECT * FROM original_mcp_todo_assignments WHERE operation_id=?").get(operationId);
}
export function originalTodoAssignmentBindingPins(db: DatabaseSync, data: {
  coreSessionId: string; chatUrl: string; sourcePlanSha256: string; nativeEpoch: string;
  nativeRequestId: string; ownerLease: { ownerId: string; fence: number };
}): string {
  const row = db.prepare(`SELECT r.request_id,r.selection,r.active,r.status,r.engine,r.history_published,
    s.epoch,s.status AS request_status,q.operation,q.arguments,e.plan,e.plan_sha256,e.status AS execution_status,c.model_selection
    FROM original_api_chat_current_chats c JOIN original_api_chat_responses r ON r.chat_id=c.id
    JOIN original_api_chat_request_state s ON s.request_id=r.request_id
    JOIN original_api_chat_requests q ON q.request_id=r.request_id
    JOIN original_native_chat_executions e ON e.request_id=r.request_id WHERE c.id=?`).get(data.coreSessionId);
  if (!row || row.request_id !== data.nativeRequestId || row.epoch !== data.nativeEpoch
    || row.request_status !== "succeeded" || row.operation !== "send" || row.active !== 0
    || row.history_published !== 1 || row.status !== "complete" || row.execution_status !== "complete" || row.engine !== "native-original") fail();
  const plan = JSON.parse(String(row.plan)), selection = JSON.parse(String(row.selection)), model = JSON.parse(String(row.model_selection));
  if (plan.chatUrl !== data.chatUrl || plan.sourcePlanSha256 !== data.sourcePlanSha256 || plan.requestId !== row.request_id
    || originalMcpDomainHash(plan) !== row.plan_sha256 || selection.epoch !== data.nativeEpoch || selection.provider !== "vscode"
    || originalMcpDomainHash(selection) !== originalMcpDomainHash(model)
    || !db.prepare("SELECT 1 FROM original_native_chat_inferences WHERE request_id=? AND authorized=1").get(row.request_id)) fail();
  const event = db.prepare("SELECT payload FROM original_native_chat_events WHERE request_id=? AND type='execution-prepared' ORDER BY sequence LIMIT 1").get(row.request_id);
  if (!event || originalMcpDomainHash(JSON.parse(String(event.payload)).ownerLease) !== originalMcpDomainHash(data.ownerLease)) fail();
  return originalMcpDomainHash(row);
}
export function captureOriginalTodoAssignmentSourcePins(root: string, db: DatabaseSync, id: string) {
  const chat = db.prepare("SELECT metadata_path,metadata_sha256,namespace FROM original_api_chat_source_chats WHERE id=?").get(id);
  if (!chat || chat.metadata_path !== `.pkm/state/api-chats/${chat.namespace}/${id}.json`) fail();
  const paths = [String(chat.metadata_path), ".pkm/state/api-chats/library.json"];
  return paths.map((path, index) => {
    let sha256: string | null;
    try {
      const absolute = join(root, path);
      if (realpathSync(absolute) !== absolute) fail("Original Chat source became linked.");
      sha256 = hash(originalMcpPrivateBytes(absolute, 16_777_216));
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; sha256 = null; }
    if (index === 0 && sha256 !== chat.metadata_sha256) fail("Original Chat metadata changed.");
    return { path, sha256 };
  });
}
export class OriginalTodoAssignmentGate {
  private readonly admissions = new Map<string, OriginalTodoAssignmentAdmission>();
  constructor(private readonly root: string, private readonly db: DatabaseSync,
    private readonly readChat: (actorId: string, id: string) => { id: string; revision: number; archivedAt?: string }) {}
  admit(input: unknown, runtimeOwner: { ownerId?: string; fence?: number }): OriginalTodoAssignmentAdmission {
    const data = originalTodoAssignmentAdmissionSchema.parse(input);
    const args = todoDefinitions.find(item => item.id === "todo.workitem.assign")!.input.parse(data.arguments);
    if (canonicalJson(args) !== canonicalJson(data.arguments)) fail();
    if (data.guard.requestSha256 !== originalMcpDomainHash({ operation: "todo.workitem.assign", version: 1,
      actor: data.actor, arguments: data.arguments })) fail();
    this.check(data, runtimeOwner);
    const previous = this.admissions.get(data.guard.operationId);
    if (previous && canonicalJson(this.persisted(previous)) !== canonicalJson(this.persisted(data))) fail("A different assignment already owns this operationId.");
    this.admissions.set(data.guard.operationId, data);
    return data;
  }
  private persisted(data: OriginalTodoAssignmentAdmission) {
    const { revocation: _revocation, ...source } = data.chatSourceAuthority;
    return { actor: data.actor, arguments: data.arguments, guard: data.guard, source,
      bindingSha256: data.bindingSha256, sourcePins: data.sourcePins };
  }
  check(data: OriginalTodoAssignmentAdmission, runtimeOwner: { ownerId?: string; fence?: number }) {
    const g = data.guard, a = data.chatSourceAuthority, args = data.arguments, db = this.db;
    const journal = readOriginalMcpJournal(this.root);
    if (!journal || g.root !== this.root || g.workspaceId !== journal.workspaceId
      || g.actorId !== data.actor.id || data.actor.id !== "mcp:external"
      || g.ownerLease.ownerId !== runtimeOwner.ownerId || g.ownerLease.fence !== runtimeOwner.fence
      || g.ownerId !== `chat:${g.coreSessionId}` || g.ownerId !== args.owner_id
      || g.boardSlug !== args.board_slug || g.workItemId !== args.id || g.boardDigest !== args.expected_digest
      || g.operationId !== args.operationId || g.expiresAtMs <= Date.now()) fail();
    const owner = db.prepare("SELECT owner_id,fence,lease_until FROM native_runtime_owner WHERE singleton=1").get();
    if (!owner || owner.owner_id !== g.ownerLease.ownerId || owner.fence !== g.ownerLease.fence || Number(owner.lease_until) <= Date.now()) fail();
    if (data.chatSourceRevocation !== a.revocation) fail("The actual source consent resource must be preserved within admission.");
    for (const flag of [data.revocation, data.todoRevocation, data.chatSourceRevocation, a.revocation])
      if (Atomics.load(new Int32Array(flag), 0) !== 0) fail("Original assignment authority was revoked.");
    const authority = readOriginalMcpTodoAuthority(this.root, data.actor.id, g.boardSlug, db);
    if (authority.intentSha256 !== g.intentSha256 || authority.sessionDecisionId !== g.sessionDecisionId
      || authority.nativeHostReceiptSha256 !== g.nativeHostReceiptSha256 || authority.workerReceiptSha256 !== g.workerReceiptSha256
      || authority.expiresAtMs < g.expiresAtMs) fail();
    if (a.root !== this.root || a.workspaceId !== journal.workspaceId || a.actorId !== g.actorId
      || a.custodyPlanSha256 !== journal.plan.planSha256 || a.profileSha256 !== journal.plan.profileSha256
      || a.planSha256 !== g.sourcePlanSha256 || a.nativeHostReceiptSha256 !== g.nativeHostReceiptSha256
      || a.epoch !== g.nativeEpoch || a.decisionId !== g.chatSourceDecisionId || a.expiresAtMs < g.expiresAtMs
      || a.expiresAtMs <= Date.now() || g.nativeActivationId !== g.nativeEpoch) fail();
    const admitted = db.prepare("SELECT sha256 FROM original_api_chat_source_admission WHERE singleton=1").get();
    const host = db.prepare("SELECT payload FROM original_mcp_native_host_admissions WHERE receipt_sha256=?").get(g.nativeHostReceiptSha256);
    if (!admitted || admitted.sha256 !== g.sourcePlanSha256 || !host) fail();
    const native = JSON.parse(String(host.payload)), { receiptSha256, ...body } = native;
    if (receiptSha256 !== g.nativeHostReceiptSha256 || originalMcpDomainHash(body) !== receiptSha256
      || native.epoch !== g.nativeEpoch || native.root !== this.root || native.workspaceId !== g.workspaceId
      || native.actorId !== g.actorId || native.planSha256 !== a.custodyPlanSha256 || native.profileSha256 !== a.profileSha256
      || !Array.isArray(native.domains) || !native.domains.includes("api-chat-native")) fail();
    const chat = db.prepare("SELECT namespace,trashed_at FROM original_api_chat_source_chats WHERE id=?").get(g.coreSessionId);
    if (!chat || chat.trashed_at !== null || g.chatUrl !== `pkm://chats/${chat.namespace}/${g.coreSessionId}`) fail();
    if (canonicalJson(captureOriginalTodoAssignmentSourcePins(this.root, db, g.coreSessionId)) !== canonicalJson(data.sourcePins)) fail("Original Chat source changed before atomic assignment.");
    if (originalTodoAssignmentBindingPins(db, g) !== data.bindingSha256) fail("The native completed binding changed.");
    const session = this.readChat(g.actorId, g.coreSessionId);
    if (session.id !== g.coreSessionId || session.revision !== g.coreRevision || session.archivedAt) fail("The canonical same-actor Chat revision changed.");
  }
  assertRequest(request: StorageRequest, data: OriginalTodoAssignmentAdmission | undefined,
    runtimeOwner: { ownerId?: string; fence?: number }): void {
    if (!isOriginalTodoChatAssignment(this.root, this.db, request)) return;
    if (!data || canonicalJson(originalTodoAssignmentRequest(data)) !== canonicalJson(request)) fail();
    this.check(data, runtimeOwner);
  }
  persist(data: OriginalTodoAssignmentAdmission, request: StorageRequest, fingerprint: string, after: string, result: string) {
    if (!this.db.isTransaction) fail();
    if (!this.db.prepare("SELECT 1 FROM sqlite_master WHERE name='original_mcp_todo_assignments'").get()) this.db.exec(originalTodoAssignmentDdl);
    const payload = canonicalJson(this.persisted(data));
    this.db.prepare("INSERT INTO original_mcp_todo_assignments VALUES(?,?,?,?,?,?,?)")
      .run(data.guard.operationId, fingerprint, canonicalJson(request), payload, hash(payload), hash(after), result);
  }
  pending(todo: Record<string, unknown>, runtimeOwner: { ownerId?: string; fence?: number }) {
    const record = originalTodoAssignmentRecord(this.db, String(todo.operation_id));
    const request = record ? JSON.parse(String(record.request_json)) as StorageRequest : undefined;
    const target = todo.operation === "todo.workitem.assign" ? JSON.parse(String(todo.result)).item?.ownerId : undefined;
    const containsOriginal = typeof target === "string" && target.startsWith("chat:")
      && !!this.db.prepare("SELECT 1 FROM sqlite_master WHERE name='original_api_chat_source_chats'").get()
      && !!this.db.prepare("SELECT 1 FROM original_api_chat_source_chats WHERE id=?").get(target.slice(5));
    if (!record) { if (containsOriginal && readOriginalMcpJournal(this.root)) fail("An original-source assignment pending intent has no owning guard."); return; }
    const data = this.admissions.get(String(todo.operation_id));
    if (!data || !request || record.fingerprint !== todo.fingerprint || record.guard_sha256 !== hash(String(record.guard_json))
      || record.guard_json !== canonicalJson(this.persisted(data)) || record.request_json !== canonicalJson(originalTodoAssignmentRequest(data))
      || record.after_sha256 !== hash(String(todo.after_json)) || todo.operation !== "todo.workitem.assign"
      || record.result_json !== todo.result || todo.before_sha256 !== data.guard.boardDigest
      || todo.actor_id !== data.actor.id || todo.board_slug !== data.guard.boardSlug) fail("Pending original assignment requires its exact compatible live admission; restart does not restore it.");
    this.check(data, runtimeOwner);
  }
  receipt(data: OriginalTodoAssignmentAdmission, request: StorageRequest, fingerprint: string) {
    const record = originalTodoAssignmentRecord(this.db, data.guard.operationId);
    if (!record || record.fingerprint !== fingerprint || record.request_json !== canonicalJson(request)
      || record.guard_json !== canonicalJson(this.persisted(data)) || record.guard_sha256 !== hash(String(record.guard_json))) fail();
    const receipt = this.db.prepare("SELECT result,actor_id,operation FROM receipts WHERE operation_id=?").get(data.guard.operationId);
    if (!receipt || receipt.result !== record.result_json || receipt.actor_id !== data.guard.actorId || receipt.operation !== "todo.workitem.assign") fail();
  }
}
