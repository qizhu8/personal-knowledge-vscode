import assert from "node:assert/strict";
import test from "node:test";
import { randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { originalApiTaskLiveFixture } from "./original-mcp-api-chat-task-live-fixture.mjs";
import { createOriginalMcpNativePortalSource } from "../dist/original-mcp-portal-source.js";
import { createNativePublicOwnerBackend } from "../dist/native-public-mcp-owner.js";
import { createNativePublicFacade } from "../dist/native-public-mcp.js";
import { originalNativeChatDigest } from "../dist/original-mcp-api-chat-contracts.js";
const options = { timeout: 120000, skip: process.env.PKM_TEST_MANAGED_TASK_LANE !== "1" };
const until = async fn => {
  for (let i = 0; i < 600; i++) { const value = await fn(); if (value) return value; await new Promise(r => setTimeout(r, 20)); }
  throw new Error("Actual Portal Task did not settle.");
};
async function host(t, control) {
  const state = new Map(), secrets = new Map();
  const Store = createRequire(import.meta.url)("../dist/legacy-chatroom-retained.cjs").PortalEndpointStore;
  const store = new Store({ get: k => state.get(k), async update(k, v) { state.set(k, structuredClone(v)); } },
    { async get(k) { return secrets.get(k); }, async store(k, v) { secrets.set(k, v); }, async delete(k) { secrets.delete(k); } });
  let f;
  const source = createOriginalMcpNativePortalSource({ assertCurrent() {}, store: () => store, async decide(request) {
    if (request.phase === "pair-code") control.link = request.detail.privateLink;
    return { decision: "approve",
      ...(request.phase === "open" ? { role: control.role, ...(control.role === "controlled" ? { privateLink: control.link } : {}) } : {}),
      ...(request.phase === "task" ? { chatId: control.chatId ?? f.created.chatId } : {}),
      ...(request.phase === "permissions" ? { grant: { mode: "scoped", permissions: ["pkm-read", "progress-read"], durationMs: 120000 } } : {}) };
  } });
  f = await originalApiTaskLiveFixture(t, { portalSource: source, defaultPolicy: control.defaultPolicy,
    reviewSupport: control.reviewSupport,
    tools: [{ name: "save_document", operation: "knowledge.document.update", approvalRequired: true }] });
  await f.api.close();
  const backend = createNativePublicOwnerBackend(f.owner, { actor: f.actor, originalMcpHost: f.host });
  f.retain(() => backend.close());
  const directory = f.storage.workspaceRoot();
  await writeFile(join(directory, "active-generation.json"), '{"schema":"pkm.mcp.lifecycle/v1","generation":"portal-task"}');
  const facade = createNativePublicFacade(backend, { writable: true, catalogProfile: "original-full",
    manifest: { managedRoot: directory, generation: "portal-task", version: "0.1.0", components: {} }, closeBackend: async () => {} });
  const call = async (operation, values = {}) => (await facade.invoke("capability_call", {
    operation: "mcp.tool.portal_control", version: 1, arguments: {
      host_id: f.workspaceId, command_id: randomUUID(), operation, ...values } })).structuredContent;
  const receipt = id => until(async () => {
    const value = (await facade.invoke("capability_read", { operation: "mcp.tool.api_chat_request_get", version: 1,
      arguments: { host_id: f.workspaceId, request_id: id } })).structuredContent;
    return ["queued", "running"].includes(value.status) ? undefined : value;
  });
  return { ...f, source, control, call, receipt };
}
async function pair(t, settings = {}) {
  const a = await host(t, { role: "controller", ...settings }), b = await host(t, { role: "controlled", ...settings });
  const first = await a.call("open"); await until(() => a.control.link); b.control.link = a.control.link;
  const second = await b.call("open");
  const left = await a.receipt(first.request_id), right = await b.receipt(second.request_id);
  assert.equal(left.status, "succeeded", left.error); assert.equal(right.status, "succeeded", right.error);
  a.contextId = left.result.contextId; b.contextId = right.result.contextId;
  const grant = await b.receipt((await b.call("permissions", { context_id: b.contextId })).request_id);
  assert.equal(grant.status, "succeeded", grant.error);
  const observe = requestId => until(async () => {
    const value = await a.receipt((await a.call("get", { context_id: a.contextId, request_id: requestId })).request_id);
    assert.equal(value.status, "succeeded", value.error);
    return ["completed", "failed", "denied", "cancelled"].includes(value.result.receipt.state) ? value.result : undefined;
  });
  const send = async prompt => {
    const requestId = randomUUID(), queued = await a.receipt((await a.call("send", {
      context_id: a.contextId, request_id: requestId, prompt })).request_id);
    assert.equal(queued.status, "succeeded", queued.error);
    const observed = await observe(requestId);
    if (observed.receipt.state === "failed") {
      const db = b.storage.connectNative();
      try {
        observed.nativeErrors = db.prepare("SELECT status,error FROM original_api_chat_request_state WHERE error IS NOT NULL").all();
        if (db.prepare("SELECT 1 FROM sqlite_master WHERE name='original_native_chat_events'").get())
          observed.nativeEvents = db.prepare("SELECT type,payload FROM original_native_chat_events WHERE type NOT LIKE 'model-%' ORDER BY sequence DESC LIMIT 5").all();
      }
      finally { db.close(); }
    }
    return { requestId, observed };
  };
  return { a, b, send };
}
function needsInput(f, runs, names = ["get_document", "session_info", "record_harness", "report_work"]) {
  return async (plan, ports) => {
    runs.push(plan.managedTask.taskId);
    let receipts = [], snapshot;
    for (const [round, name] of names.entries()) {
      const id = await f.infer(plan, ports, round, receipts);
      await f.context(plan, ports, id, round, "after-round", true);
      const args = name === "get_document" ? { id: "Entry" } : name === "session_info" ? {}
        : name === "record_harness" ? { kind: "task", goal: plan.messages.find(m => m.role === "user").content,
          sourceInputIds: plan.messages.filter(m => m.role === "user").map(() => plan.managedTask.inputId).slice(0, 1) }
        : { status: "needs_input", reason: "Explicit deterministic needs-input handoff.",
          sourceInputIds: snapshot.sourceInputIds, acceptance: snapshot.goal.acceptance.map(item => ({
            ...item, verified: false, evidenceCallIds: [] })) };
      const result = await ports.tool({ inferenceId: id, round, name, arguments: args,
        callId: `fixture-${round}`, argumentsSha256: originalNativeChatDigest(args) });
      if (name === "session_info") snapshot = JSON.parse(result.content);
      assert(!result.content.includes('"status":"failed"'), result.content);
      receipts.push(result.receiptSha256); await f.context(plan, ports, id, round, "after-tools", true);
    }
    const id = await f.infer(plan, ports, names.length, receipts, []);
    await ports.text({ inferenceId: id, text: "Actual canonical Note and Harness recorded; Task completion is not claimed." });
    await f.context(plan, ports, id, names.length, "after-round", false); await f.context(plan, ports, id, names.length, "settled", false);
    return { status: "complete", toolRoundLimit: null };
  };
}
test("default signed bootstrap public Portal reviews its three actual Task semantic tools without a general catalogue", options, async t => {
  const { b, send } = await pair(t, { defaultPolicy: true }), runs = [];
  assert.equal(b.host.options.toolCatalog, undefined);
  b.run(async (plan, ports) => {
    assert.deepEqual(plan.tools.map(tool => tool.name).sort(), ["record_harness", "report_work", "session_info"]);
    return needsInput(b, runs, ["session_info", "record_harness", "report_work"])(plan, ports);
  });
  const result = await send("Record this independently approved Task Harness and await genuine input.");
  assert.equal(result.observed.receipt.state, "completed", JSON.stringify(result.observed));
  assert.deepEqual(b.nativeRequests.filter(request => request.method === "tool.review")
    .map(request => request.payload.review.record.tool),
  ["chat.task.get", "chat.task.record_harness", "chat.task.report_work"]);
  assert.equal(b.nativeRequests.filter(request => request.method === "tool.approve").length, 3);
});
test("default public Portal preserves the underlying native failure and never replays an unsupported semantic review", options, async t => {
  const { b, send } = await pair(t, { defaultPolicy: true, reviewSupport: false }), runs = [];
  b.run(needsInput(b, runs, ["session_info", "record_harness", "report_work"]));
  const result = await send("Do not bypass a producer missing the actual review method.");
  assert.equal(result.observed.receipt.state, "failed");
  assert(result.observed.nativeErrors.length, JSON.stringify(result.observed));
  assert(result.observed.receipt.error.includes(result.observed.nativeErrors[0].error), JSON.stringify(result.observed));
  assert.doesNotMatch(result.observed.receipt.error, /confirmed manual-retry chain is unavailable/);
  assert.equal(b.nativeRequests.filter(request => request.method === "tool.review").length, 0);
  assert.equal(b.nativeRequests.filter(request => request.method === "tool.approve").length, 0);
  const blocked = await send("A NEW Task cannot replay this unresolved native effect.");
  assert.equal(blocked.observed.receipt.state, "failed");
  assert.equal(runs.length, 1);
});
test("two public native Portal Hosts start independently approved NEW Tasks on one Chat and retain previous goals/Harness/receipts", options, async t => {
  const { a, b, send } = await pair(t), runs = [];
  b.run(needsInput(b, runs));
  const first = await send("Read exact Entry and await a genuine extra requirement.");
  assert.equal(first.observed.receipt.state, "completed", JSON.stringify(first.observed));
  const second = await send("Start a distinct independently approved objective.");
  assert.equal(second.observed.receipt.state, "completed", JSON.stringify(second.observed));
  assert.equal(runs.length, 2); assert.notEqual(runs[0], runs[1]);
  const db = b.storage.connectNative();
  try {
    const tasks = db.prepare("SELECT task_id,status,goal FROM managed_chat_tasks").all();
    assert.equal(tasks.length, 2);
    assert.equal(tasks.find(task => task.task_id === runs[0]).status, "cancelled");
    assert.equal(tasks.find(task => task.task_id === runs[1]).status, "active");
    assert.match(tasks.find(task => task.task_id === runs[0]).goal, /genuine extra requirement/);
    assert.equal(db.prepare("SELECT count(*) n FROM managed_chat_task_attempts").get().n, 2);
    assert.equal(db.prepare("SELECT count(*) n FROM chat_session_messages WHERE json_extract(record,'$.role')='assistant'").get().n, 2);
  } finally { db.close(); }
  const unchanged = await a.receipt((await a.call("get", { context_id: a.contextId, request_id: first.requestId })).request_id);
  assert.equal(unchanged.result.receipt.result.replyId, first.observed.receipt.result.replyId);
});
test("read-only Portal dimensions deny an actual native write before Core effect; exact separately approved manual retry is NEW and sharing does not replay", options, async t => {
  const { a, b, send } = await pair(t);
  let runs = 0;
  b.run(async (plan, ports) => {
    runs++;
    assert(plan.tools.some(tool => tool.name === "save_document"));
    const id = await b.infer(plan, ports, 0, []); await b.context(plan, ports, id, 0, "after-round", true);
    await assert.rejects(ports.tool({ inferenceId: id, round: 0, name: "save_document", callId: "denied-write",
      arguments: { id: "Entry", expectedRevision: 1, expectedSha256: "a".repeat(64), title: "Unapproved", content: "Never written." },
      argumentsSha256: originalNativeChatDigest({ id: "Entry", expectedRevision: 1, expectedSha256: "a".repeat(64), title: "Unapproved", content: "Never written." }) }));
    return { status: "failed", toolRoundLimit: null };
  });
  const failed = await send("Retain this exact objective after a denied write.");
  assert.equal(failed.observed.receipt.state, "failed", JSON.stringify(failed.observed));
  const reference = await until(() => b.source.references().find(ref => ref.requestId === failed.requestId));
  assert(["failed", "interrupted"].includes(reference.status));
  const db = b.storage.connectNative();
  try {
    assert.equal(db.prepare("SELECT count(*) n FROM original_native_chat_events WHERE type='tool-failed' AND json_extract(payload,'$.effect')='not-committed'").get().n, 1, JSON.stringify(failed.observed));
    assert.equal(db.prepare("SELECT count(*) n FROM execution_records WHERE tool='knowledge.document.update'").get().n, 0);
  } finally { db.close(); }
  const blocked = await send("NEW Task must not replace an unreconciled public UNKNOWN request.");
  assert.equal(blocked.observed.receipt.state, "failed"); assert.equal(runs, 1);
  const resumed = [];
  b.run(needsInput(b, resumed));
  const intent = await b.source.requestManual(reference.key, new AbortController().signal);
  const outcome = await until(() => b.source.outcomes().find(item => item.commandId === intent.commandId && item.status !== "queued"));
  assert.equal(outcome.status, "succeeded", JSON.stringify(outcome));
  assert.deepEqual(resumed, [reference.taskId]);
  const shared = await a.receipt((await a.call("attempts", { context_id: a.contextId, request_id: failed.requestId })).request_id);
  assert.equal(shared.status, "succeeded", shared.error);
  assert.equal(shared.result.taskAttempts.schema, "pkm.portal.task-attempts/v1");
  assert.equal(shared.result.taskAttempts.original.replyId, reference.originalReplyId);
  assert.notEqual(shared.result.taskAttempts.latestAttempt.replyId, reference.originalReplyId);
  assert.equal(shared.result.taskAttempts.latestAttempt.retryOfReplyId, reference.replyId);
  await a.receipt((await a.call("attempts", { context_id: a.contextId, request_id: failed.requestId })).request_id);
  assert.equal(resumed.length, 1);
});

test("Portal Task rejects an unadopted/non-current Chat before Task creation or model/effect execution", options, async t => {
  const { b, send } = await pair(t);
  b.control.chatId = randomUUID();
  b.run(async () => { assert.fail("A missing native Chat cannot execute a Task or model."); });
  const denied = await send("Never implicitly inherit an archived Goal or model.");
  assert.equal(denied.observed.receipt.state, "failed");
  assert.match(denied.observed.receipt.error, /independently adopted Chat/);
  const db = b.storage.connectNative();
  try { assert.equal(db.prepare("SELECT count(*) n FROM managed_chat_tasks").get().n, 0); }
  finally { db.close(); }
});
