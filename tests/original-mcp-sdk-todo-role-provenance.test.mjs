import assert from "node:assert/strict";
import Module, { createRequire } from "node:module";
import { resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";

const require = createRequire(import.meta.url);
const built = await require("esbuild").build({ stdin: {
  contents: 'export * from "./src/original-mcp-sdk-todo-role-provenance.ts"; export * from "./src/original-mcp-sdk-model-contracts.ts";',
  resolveDir: resolve("."),
}, bundle: true, platform: "node", format: "cjs", write: false, logLevel: "silent" });
const module = new Module(resolve("tests/.sdk-role-validation-memory.cjs"));
module.filename = module.id; module.paths = Module._nodeModulePaths(resolve("."));
module._compile(built.outputFiles[0].text, module.filename);
const { originalSdkDigest: digest, assertOriginalSdkTodoRoleExecution: validate } = module.exports;

// SQL metadata validation only: no usable signed grant, RootOwner, model or human authority.
function fixture(t) {
  const db = new DatabaseSync(":memory:"); t.after(() => db.close());
  db.exec(`CREATE TABLE original_native_chat_executions(request_id TEXT, status TEXT,plan_sha256 TEXT,plan TEXT,native_model_id TEXT,current_inference TEXT);
    CREATE TABLE original_native_chat_events(request_id TEXT,type TEXT,payload TEXT);
    CREATE TABLE approval_bridge_runs(execution_id TEXT,status TEXT,operation_id TEXT,workspace_id TEXT,actor_id TEXT);
    CREATE TABLE approval_bridge_bindings(execution_id TEXT,context_json TEXT);
    CREATE TABLE execution_records(id TEXT,actor TEXT,tool TEXT,status TEXT,approval_decision_id TEXT,arguments_json TEXT);`);
  const requestId = "a".repeat(64), source = "b".repeat(64), host = "c".repeat(64);
  const workspaceId = "10000000-0000-4000-8000-000000000001", operationId = "20000000-0000-4000-8000-000000000001";
  const ownerLease = { ownerId: "30000000-0000-4000-8000-000000000001", fence: 1 };
  const plan = { schema: "pkm.original-sdk-api-chat-execution/v1", requestId, chatUrl: "pkm://chats/metadata/fixture",
    selectionId: "selection-reference", epoch: "epoch-reference", hostReceiptSha256: host, sourcePlanSha256: source };
  const planSha256 = digest(plan), args = { board_slug: "Metadata/Fixture", id: "item-reference" };
  const grant = { payload: { request: { schema: "pkm.original-sdk-todo-role-request/v1", provider: "copilot-sdk",
    requestId, planSha256, modelId: "vscode:copilot-sdk:metadata-fixture", workspaceId, chatUrl: plan.chatUrl,
    selectionId: plan.selectionId, nativeEpoch: plan.epoch, nativeHostReceiptSha256: host, chatSourcePlanSha256: source,
    actorId: "chat:40000000-0000-4000-8000-000000000001", role: "worker",
    boardSlug: args.board_slug, workItemId: args.id, ownerLease } },
    decision: { decisionId: "metadata-not-a-signed-decision", requestSha256: "d".repeat(64) } };
  const binding = { provider: "copilot-sdk", admissionMode: "awaited-sdk-sending-boundary", requestId,
    selectionId: plan.selectionId, modelId: grant.payload.request.modelId, sdkSessionId: "session-reference",
    epoch: plan.epoch, hostReceiptSha256: host, sourcePlanSha256: source, planSha256,
    deadlineAtMs: Date.now() + 60000, budget: { maxRequestBytes: 1024, maxSendingBoundaries: 8 } };
  const body = { schema: "pkm.original-sdk-sending-boundary/v1", binding, sdkRequestId: "sending-request-reference",
    sdkInvocationId: "sending-invocation-reference", kind: "http-request", measurement: {
      provider: "copilot-sdk", countingMethod: "sdk-serialized-utf8-bytes", serializedBytes: 1,
      payloadSha256: "e".repeat(64), providerTokenCount: null }, authority: "model-sending-boundary-only" };
  const boundary = { ...body, boundaryId: digest(body) };
  const callback = { provider: "copilot-sdk", requestId, planSha256, sdkSessionId: binding.sdkSessionId,
    sendingBoundaryId: boundary.boundaryId, sendingInvocationId: boundary.sdkInvocationId,
    callId: "call-reference", argumentsSha256: digest(args), toolReceiptId: "execution-reference", operationId };
  db.prepare("INSERT INTO original_native_chat_executions VALUES(?,?,?,?,?,?)")
    .run(requestId, "running", planSha256, JSON.stringify(plan), grant.payload.request.modelId, binding.sdkSessionId);
  const event = (type, payload) => db.prepare("INSERT INTO original_native_chat_events VALUES(?,?,?)").run(requestId, type, JSON.stringify(payload));
  event("sdk-execution-prepared", { ownerLease, todoRole: {
    actorId: grant.payload.request.actorId, role: "worker", boardSlug: args.board_slug, workItemId: args.id,
    decisionId: grant.decision.decisionId, requestSha256: grant.decision.requestSha256 } });
  event("sdk-session-admitted", { binding });
  event("sdk-sending-approved", boundary);
  event("sdk-tool-intent", { ...callback, provenance: "sdk-session-tool-invocation", arguments: args, name: "get_workitem" });
  db.prepare("INSERT INTO approval_bridge_runs VALUES(?,?,?,?,?)").run(callback.toolReceiptId, "running", operationId, workspaceId, "mcp:external");
  db.prepare("INSERT INTO approval_bridge_bindings VALUES(?,?)").run(callback.toolReceiptId, JSON.stringify({ turnId: requestId, contextDigest: planSha256 }));
  db.prepare("INSERT INTO execution_records VALUES(?,?,?,?,?,?)")
    .run(callback.toolReceiptId, "mcp:external", "todo.workitem.get", "running", "metadata-approval-reference", JSON.stringify(args));
  return { db, callback, check: value => validate(db, grant, value ?? callback, "todo.workitem.get", args, false) };
}

test("matching SDK session/sending/canonical SQL metadata validates without native inference records", t => {
  const f = fixture(t); assert.doesNotThrow(() => f.check());
  assert.equal(f.db.prepare("SELECT count(*) AS n FROM sqlite_master WHERE name='original_native_chat_inferences'").get().n, 0);
});
test("missing approval, wrong canonical actor/workspace/session or receipt is refused", t => {
  for (const mutation of [
    "UPDATE execution_records SET approval_decision_id=NULL",
    "UPDATE execution_records SET actor='user:local'",
    "UPDATE approval_bridge_runs SET actor_id='user:local'",
    "UPDATE approval_bridge_runs SET workspace_id='50000000-0000-4000-8000-000000000001'",
    "UPDATE original_native_chat_executions SET current_inference='a-different-sdk-session'",
    "DELETE FROM original_native_chat_events WHERE type='sdk-sending-approved'",
  ]) {
    const f = fixture(t); f.db.exec(mutation);
    assert.throws(() => f.check(), error => error.code === "NATIVE_AUTHORITY_REQUIRED");
  }
  const f = fixture(t);
  assert.throws(() => f.check({ ...f.callback, toolReceiptId: "a-different-canonical-receipt" }), /provenance/);
  assert.throws(() => f.check({ ...f.callback, sdkSessionId: "a-different-sdk-session" }), /provenance/);
});
