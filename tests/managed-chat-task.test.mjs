import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import { execFileSync } from "node:child_process";
import { mkdir, rm } from "node:fs/promises";
import { createRequire } from "node:module";
import { join, resolve } from "node:path";
import test from "node:test";
import { managedTaskFixture } from "./managed-chat-task-fixture.mjs";
import { createOriginalMcpNativeExecution } from "../dist/original-mcp-api-chat-execution.js";
import { originalNativeChatDigest } from "../dist/original-mcp-api-chat-contracts.js";
import { activateOriginalMcpApiChatSource } from "../dist/original-mcp-api-chat-source.js";
import * as rules from "../dist/managed-chat-task-original.js";
import { ToolGateway } from "../dist/tool-gateway.js";

const require = createRequire(import.meta.url), archive = process.env.PKM_LEGACY_VSIX;
test("current Goal continuation recognizes Chinese task references while preserving identity, evidence reset and context guards", () => {
  const executionDigest = "a".repeat(64);
  const seed = status => {
    const inputId = randomUUID(), prompt = "Start a new task: preserve the original synthetic QA objective.";
    const chat = { id: randomUUID(), includeHistory: true,
      messages: [{ id: inputId, role: "user", content: prompt, status: "complete" }] };
    rules.prepareWorkGoal(chat, inputId, prompt, executionDigest);
    chat.workGoal.status = status;
    return chat;
  };
  for (const status of ["paused", "interrupted"]) {
    for (const text of ["继续刚才同一个合成 QA 目标，不要新建或替换目标。", "恢复上次的任务。", "继续之前那个工作。"]) {
      const chat = seed(status), original = structuredClone(chat.workGoal), inputId = randomUUID();
      chat.workGoal.acceptance[0] = { ...chat.workGoal.acceptance[0], verified: true, evidenceCallIds: ["historical"] };
      rules.prepareWorkGoal(chat, inputId, text, executionDigest);
      assert.equal(chat.workGoal.id, original.id);
      assert.equal(chat.workGoal.inputId, original.inputId);
      assert.equal(chat.workGoal.objective, original.objective);
      assert.equal(chat.workGoal.status, "active");
      assert.equal(chat.workGoal.attemptInputId, inputId);
      assert.equal(chat.workGoal.transitions.at(-1).reason, "user_resumed");
      assert.deepEqual(chat.workGoal.acceptance, original.acceptance);
    }
    for (const text of ["继续刚才的解释。", "继续说明刚才那个任务。", "继续刚才的解释，不要恢复任务。"]) {
      const chat = seed(status), original = structuredClone(chat.workGoal);
      rules.prepareWorkGoal(chat, randomUUID(), text, executionDigest);
      assert.deepEqual(chat.workGoal, original);
    }
    const chat = seed(status), original = structuredClone(chat.workGoal);
    assert.throws(() => rules.prepareWorkGoal(chat, randomUUID(),
      "继续刚才同一个合成 QA 目标。", "b".repeat(64)), /another execution context/);
    assert.deepEqual(chat.workGoal, original);
  }
});

test("canonical Goal/Harness pure rules preserve the SHA-pinned original transitions and validation failures", {
  timeout: 120000, skip: archive ? false : "Set PKM_LEGACY_VSIX to the pinned original package.",
}, async t => {
  const hash = createHash("sha256"); for await (const bytes of createReadStream(archive)) hash.update(bytes);
  assert.equal(hash.digest("hex"), "1804071cb3b9fc86edc5933d5001db6ea1a8d7a9adf30d6d2b3166fcd6048f27");
  const directory = resolve(".pkm-test-evidence", `managed-task-oracle-${randomUUID()}`);
  await mkdir(directory, { recursive: true, mode: 0o700 }); t.after(() => rm(directory, { recursive: true, force: true }));
  execFileSync("unzip", ["-q", archive, "extension/dist/*", "extension/package.json", "-d", directory], { stdio: "pipe", timeout: 60000 });
  const original = { ...require(join(directory, "extension/dist/chat/chat-work-goal.js")),
    ...require(join(directory, "extension/dist/chat/chat-harness-records.js")) };
  for (const name of ["newWorkGoal", "workStop", "delegatedWork"])
    assert.equal(rules[name].toString(), original[name].toString(), `Pinned original ${name} recognition changed.`);
  assert.equal(rules.rootWorkCriterion, original.rootWorkCriterion);
  const inputId = randomUUID(), attemptId = randomUUID(), taskId = `agent_session_${randomUUID().replaceAll("-", "")}`;
  const run = implementation => {
    const prompt = "Start a new task: preserve all original requirements.", executionDigest = "a".repeat(64);
    const chat = { id: randomUUID(), sessionId: taskId, includeHistory: true,
      messages: [{ id: inputId, taskId, role: "user", content: prompt, status: "complete" }] };
    implementation.prepareWorkGoal(chat, inputId, prompt, executionDigest);
    const reply = { id: randomUUID(), inputId, taskId, role: "assistant", content: "", status: "streaming",
      progress: { attemptId, status: "running" }, harnessReports: [], toolCalls: [
        { id: "real-evidence", name: "get_document", arguments: '{"id":"Entry"}', status: "complete", result: '{"content":"observed"}' },
        { id: "failed-evidence", name: "get_document", arguments: '{"id":"Missing"}', status: "failed", result: '{"error":"missing"}' },
      ] };
    chat.messages.push(reply);
    const report = { status: "resolved", reason: "Exact objective verified.", sourceInputIds: [inputId],
      acceptance: [{ criterion: implementation.rootWorkCriterion, verified: true, evidenceCallIds: ["real-evidence"] }],
      contract: { scope: ["Exact objective"], nonGoals: [], stopWhen: "Objective is verified." }, phase: "verifying" };
    const errors = [];
    for (const args of [{ ...report, acceptance: [] },
      { ...report, acceptance: [{ ...report.acceptance[0], evidenceCallIds: ["failed-evidence"] }] },
      { ...report, sourceInputIds: [randomUUID()] }]) {
      try { implementation.reportWork(chat, reply, args); assert.fail("Invalid original report was accepted."); }
      catch (error) { errors.push(error.message); }
    }
    const start = implementation.validateHarnessReport(chat, reply,
      { kind: "validation", stepId: "check", status: "start", summary: "Check actual source.", sourceInputIds: [inputId] });
    reply.harnessReports.push(start);
    const complete = implementation.validateHarnessReport(chat, reply,
      { kind: "validation", stepId: "check", status: "complete", summary: "Check complete.", evidenceCallIds: ["real-evidence"] });
    implementation.reportWork(chat, reply, report);
    return { errors, goal: chat.workGoal, start, complete };
  };
  const normalize = value => JSON.parse(JSON.stringify(value, (key, entry) =>
    ["id", "at", "stepAttemptId"].includes(key) ? "<generated>" : key === "transitions" ? entry.map(item => ({ ...item, at: 0 })) : entry));
  assert.deepEqual(normalize(run(rules)), normalize(run(original)));
});

test("actual Core Task creation is atomic, scoped, denied without consent and idempotent without duplicate input or goal", { timeout: 120000 }, async t => {
  const f = await managedTaskFixture(t);
  f.denyTask(true);
  await assert.rejects(f.foundation.prepareStart(f.preparation()), /consent was denied/);
  let db = f.storage.connectNative();
  try { assert.equal(db.prepare("SELECT count(*) AS n FROM managed_chat_tasks").get().n, 0); }
  finally { db.close(); }
  f.denyTask(false);
  let releaseApproval, approvalVisible;
  const visible = new Promise(resolve => { approvalVisible = resolve; });
  f.onTaskApproval(async () => { approvalVisible(); await new Promise(resolve => { releaseApproval = resolve; }); });
  const cancelledPreparation = new AbortController();
  const pendingPreparation = f.foundation.prepareStart(f.preparation(), { signal: cancelledPreparation.signal });
  await visible; cancelledPreparation.abort();
  await assert.rejects(pendingPreparation, /CANCELLED|cancelled/);
  releaseApproval(); f.onTaskApproval(undefined);
  db = f.storage.connectNative();
  try { assert.equal(db.prepare("SELECT count(*) AS n FROM managed_chat_tasks").get().n, 0); }
  finally { db.close(); }
  const request = f.preparation(), prepared = await f.foundation.prepareStart(request);
  assert(Object.isFrozen(prepared));
  await assert.rejects(f.foundation.start({ ...prepared }), /actual native Task preparation/);
  const first = await f.foundation.start(prepared), replay = await f.foundation.start(prepared);
  assert.deepEqual(replay.snapshot, first.snapshot);
  assert.equal(first.snapshot.goal.objective, request.prompt);
  assert.equal(first.snapshot.goal.status, "active");
  assert.equal(first.snapshot.sourceInputs[0].content, request.prompt);
  assert.equal(first.snapshot.attempt.status, "prepared");
  assert.equal(first.snapshot.taskCompletion, "not-claimed");
  const nativeCount = f.highLevelRequests.length;
  const submitted = await f.api.invoke("api_chat_send", { host_id: f.workspaceId, chat_id: f.created.chatId,
    prompt: "Do not silently treat this managed Task as ordinary Chat.", command_id: "uncomposed-task-followup" });
  const receipt = submitted.structuredContent;
  let blocked;
  for (let attempt = 0; attempt < 100; attempt++) {
    blocked = (await f.api.invoke("api_chat_request_get", { host_id: f.workspaceId, request_id: receipt.request_id })).structuredContent;
    if (!["queued", "running"].includes(blocked.status)) break;
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  assert.equal(blocked.status, "failed");
  assert.match(blocked.error, /MANAGED_GOAL_COMPOSITION_REQUIRED/);
  assert.equal(f.highLevelRequests.length, nativeCount);
  const toolOptions = { actor: f.actor, context: { workspaceId: f.workspaceId, turnId: first.attempt.requestId,
    contextDigest: "a".repeat(64) }, dispatcher: { async dispatch() { assert.fail("Unscoped Task tool must never dispatch."); } } };
  assert.throws(() => new ToolGateway({ ...toolOptions,
    catalog: [{ name: "report_work", operation: "chat.task.report_work" }] }), { code: "NOT_AVAILABLE" });
  await f.foundation.withinAttempt(first.attempt, async () => {
    assert.throws(() => new ToolGateway({ ...toolOptions,
      catalog: [{ name: "start_another_task", operation: "chat.task.start" }] }), { code: "NOT_AVAILABLE" });
    assert.throws(() => new ToolGateway({ ...toolOptions, context: { ...toolOptions.context, turnId: "foreign-request" },
      catalog: [{ name: "record_harness", operation: "chat.task.record_harness" }] }), { code: "NOT_AVAILABLE" });
  });
  assert.equal((await f.core("chat.task.report_work", { operationId: randomUUID() })).error.code, "NOT_AVAILABLE");
  await assert.rejects(f.storage.request({ operation: "chat.task.start", args: {}, actorId: f.actor.id }), /private native Core scope/);
  await assert.rejects(f.foundation.withinAttempt(first.attempt, async () => {
    const result = await f.core("chat.task.report_work", { operationId: randomUUID(), status: "resolved", reason: "Forged",
      sourceInputIds: [first.attempt.inputId], acceptance: [{ criterion: rules.rootWorkCriterion, verified: true, evidenceCallIds: ["fake"] }] });
    assert(result.error); throw new Error(result.error.message);
  }), /actual bound native execution|durably begun/);
  const cancelOperationId = randomUUID();
  const cancelled = await f.foundation.cancel(first.attempt, cancelOperationId);
  assert.deepEqual(await f.foundation.cancel(first.attempt, cancelOperationId), cancelled);
  assert.equal(cancelled.status, "paused");
  assert.equal(cancelled.attempt.status, "cancelled");
  assert.equal(cancelled.goal.status, "paused");
  assert.equal(first.attempt.signal.aborted, true);
  assert.throws(first.attempt.assertCurrent, /disarmed/);
  const next = await f.foundation.prepareAttempt(first.snapshot.taskId, f.preparation({
    expectedChatRevision: cancelled.chatRevision, prompt: "Continue the same exact objective.", commandId: `resume-${randomUUID()}`,
  }));
  const resumed = await f.foundation.start(next);
  assert.equal(resumed.snapshot.taskId, first.snapshot.taskId);
  assert.equal(resumed.snapshot.goal.id, first.snapshot.goal.id);
  assert.equal(resumed.snapshot.goal.status, "active");
  assert.equal(resumed.snapshot.sourceInputs.length, 2);
  db = f.storage.connectNative();
  try {
    assert.equal(db.prepare("SELECT count(*) AS n FROM managed_chat_tasks").get().n, 1);
    assert.equal(db.prepare("SELECT count(*) AS n FROM managed_chat_task_attempts").get().n, 2);
    assert.equal(db.prepare("SELECT count(*) AS n FROM chat_session_messages WHERE chat_id=?").get(f.created.chatId).n, 2);
  } finally { db.close(); }
});

async function planFor(f, attempt) {
  const catalogue = await f.host.nativeChat.models.catalogue(attempt.signal);
  const selected = await f.host.nativeChat.models.select({ modelId: f.selection().modelId,
    catalogueSha256: originalNativeChatDigest(catalogue) }, attempt.signal);
  const state = await f.foundation.get(attempt), model = f.selection();
  return { schema: "pkm.original-api-chat-execution/v1", requestId: attempt.requestId, chatUrl: attempt.chatUrl,
    selectionId: selected.selectionId, sourcePlanSha256: attempt.sourcePlanSha256,
    messages: state.sourceInputs.map(input => ({ role: "user", content: input.content })), tools: [],
    hardToolRoundLimit: 6, outputTokenCap: model.outputTokenCap, budget: model.budget };
}
test("real native/Core tool receipts drive original report_work and Harness while response completion alone leaves the goal open", { timeout: 120000 }, async t => {
  const f = await managedTaskFixture(t);
  const approved = await f.foundation.prepareStart(f.preparation());
  const created = await f.foundation.start(approved);
  const executor = await createOriginalMcpNativeExecution(f.owner, f.actor, f.host, f.foundation.execution);
  const plan = await planFor(f, created.attempt);
  plan.tools = await f.foundation.withinAttempt(created.attempt, () => executor.modelTools(plan));
  assert(plan.tools.some(tool => tool.name === "report_work") && plan.tools.some(tool => tool.name === "record_harness"));
  await f.foundation.bind(created.attempt, randomUUID(), originalNativeChatDigest(plan));
  f.modelRun(async (body, ports) => {
    const inferenceId = await f.inference(body, ports, 0, [], []);
    await ports.text({ inferenceId, text: "A completed native response is not managed acceptance." });
    return { status: "complete", toolRoundLimit: null };
  });
  await f.foundation.withinAttempt(created.attempt, () => executor.run(plan, f.selection().wireModelId,
    created.attempt.signal, f.foundation.preparedContext(created.attempt)));
  const finishOperationId = randomUUID();
  const first = await f.foundation.finish(created.attempt, finishOperationId);
  assert.deepEqual(await f.foundation.finish(created.attempt, finishOperationId), first);
  assert.equal(first.goal.status, "active");
  assert.equal(first.taskCompletion, "not-claimed");
  assert.equal(first.attempt.status, "complete");
  const prepared = await f.foundation.prepareAttempt(first.taskId, f.preparation({
    expectedChatRevision: first.chatRevision, prompt: "Continue and verify every original requirement.", commandId: `evidence-${randomUUID()}`,
  }));
  const next = await f.foundation.start(prepared), nextPlan = await planFor(f, next.attempt);
  nextPlan.tools = await f.foundation.withinAttempt(next.attempt, () => executor.modelTools(nextPlan));
  await f.foundation.bind(next.attempt, randomUUID(), originalNativeChatDigest(nextPlan));
  const sourceIds = next.snapshot.sourceInputIds, proposal = {
    status: "resolved", reason: "Read the actual canonical Note.", sourceInputIds: sourceIds,
    acceptance: [{ criterion: rules.rootWorkCriterion, verified: true, evidenceCallIds: ["actual-read"] }],
    contract: { scope: ["Verify the exact canonical Note"], nonGoals: [], stopWhen: "Required evidence is verified." }, phase: "verifying",
  };
  const reportResults = [];
  f.modelRun(async (body, ports) => {
    const receipts = [], proposals = [
      ["get_document", { id: "Entry" }, "actual-read"],
      ["record_harness", { kind: "task", goal: next.snapshot.goal.objective, sourceInputIds: sourceIds }, "task-report"],
      ["record_harness", { kind: "validation", stepId: "note-check", status: "start", summary: "Verify exact Note.", sourceInputIds: sourceIds }, "validation-start"],
      ["record_harness", { kind: "validation", stepId: "note-check", status: "complete", summary: "Actual read evidence.", evidenceCallIds: ["actual-read"] }, "validation-complete"],
      ["report_work", { ...proposal, acceptance: [{ ...proposal.acceptance[0], evidenceCallIds: ["task-report"] }] }, "invalid-report"],
      ["report_work", proposal, "resolved-report"],
    ];
    for (const [round, [name, args, callId]] of proposals.entries()) {
      const inferenceId = await f.inference(body, ports, round, receipts);
      const result = await ports.tool({ inferenceId, round, name, arguments: args, callId,
        argumentsSha256: originalNativeChatDigest(args) });
      receipts.push(result.receiptSha256); reportResults.push({ name, content: result.content });
      if (round === 0) assert.match(result.content, /Real canonical Task evidence fixture/);
    }
    const summary = await f.inference(body, ports, 6, receipts, []);
    await ports.text({ inferenceId: summary, text: "Recorded evidence-backed agent resolution; no managed Task completion claimed." });
    return { status: "complete", toolRoundLimit: { limit: 6, rounds: 6, reached: true } };
  });
  await f.foundation.withinAttempt(next.attempt, () => executor.run(nextPlan, f.selection().wireModelId,
    next.attempt.signal, f.foundation.preparedContext(next.attempt)));
  const completed = await f.foundation.finish(next.attempt, randomUUID());
  assert.equal(completed.goal.status, "resolved");
  assert.equal(completed.status, "active");
  assert.equal(completed.taskCompletion, "not-claimed");
  assert.equal(completed.harnessReports.length, 3);
  assert.equal(completed.harnessReports.at(-1).status, "complete");
  assert.equal(completed.latestTaskReport.source, "agent-report");
  assert.match(reportResults.find(result => result.name === "report_work").content, /unique successful|INVALID_ARGUMENT|failed/i);
  const db = f.storage.connectNative();
  try {
    assert.equal(db.prepare("SELECT count(*) AS n FROM managed_chat_tasks").get().n, 1);
    assert.equal(db.prepare("SELECT count(*) AS n FROM managed_chat_task_harness").get().n, 3);
    assert.throws(() => db.prepare("DELETE FROM managed_chat_task_harness").run(), /immutable/);
  } finally { db.close(); }
});

test("Task admission loses races to actual Chat changes or source revocation before worker publication and receipt replay", { timeout: 120000 }, async t => {
  const f = await managedTaskFixture(t);
  const prepared = await f.foundation.prepareStart(f.preparation());
  const lock = f.storage.connectNative();
  try {
    lock.exec("BEGIN IMMEDIATE");
    const creating = f.foundation.start(prepared); void creating.catch(() => {});
    await new Promise(resolve => setTimeout(resolve, 30));
    f.policies.revoke("chat");
    lock.exec("ROLLBACK");
    await assert.rejects(creating, /revoked|source|admission/i);
    assert.equal(lock.prepare("SELECT count(*) AS n FROM managed_chat_tasks").get().n, 0);
    assert.equal(lock.prepare("SELECT count(*) AS n FROM chat_session_messages WHERE chat_id=?").get(f.created.chatId).n, 0);
  } finally { if (lock.isTransaction) lock.exec("ROLLBACK"); lock.close(); }
  await activateOriginalMcpApiChatSource(f.storage, f.host, f.policies.chat);
  await assert.rejects(f.foundation.start(prepared), /source|review|admission/i);
  const approved = await f.foundation.prepareStart(f.preparation());
  const created = await f.foundation.start(approved);
  const changed = await f.core("chat.session.append", { id: f.created.chatId, expectedRevision: created.snapshot.chatRevision,
    operationId: randomUUID(), message: { id: randomUUID(), role: "user", content: "A newer user requirement.", status: "complete" } });
  assert.equal(changed.error, undefined);
  assert.throws(created.attempt.assertCurrent, /Chat changed/);
  await assert.rejects(f.foundation.get(created.attempt), /Chat.*binding|Task.*Chat|changed/i);
  await assert.rejects(f.foundation.start(approved), /Chat.*binding|Task.*Chat|changed/i);
});

test("a newer canonical Chat input during native model approval blocks provider admission without inventing Task completion", { timeout: 120000 }, async t => {
  const f = await managedTaskFixture(t);
  const { snapshot, attempt } = await f.foundation.start(await f.foundation.prepareStart(f.preparation()));
  const executor = await createOriginalMcpNativeExecution(f.owner, f.actor, f.host, f.foundation.execution);
  const plan = await planFor(f, attempt);
  plan.tools = await f.foundation.withinAttempt(attempt, () => executor.modelTools(plan));
  await f.foundation.bind(attempt, randomUUID(), originalNativeChatDigest(plan));
  let providerCalls = 0;
  f.modelRun(async (body, ports) => {
    await f.inference(body, ports, 0, [], []);
    providerCalls++;
    return { status: "complete", toolRoundLimit: null };
  });
  f.onModelApproval(async () => {
    const changed = await f.core("chat.session.append", { id: f.created.chatId, expectedRevision: snapshot.chatRevision,
      operationId: randomUUID(), message: { id: randomUUID(), role: "user", content: "A newer requirement must be reconciled.", status: "complete" } });
    assert.equal(changed.error, undefined);
  });
  await assert.rejects(f.foundation.withinAttempt(attempt, () => executor.run(plan, attempt.selection.wireModelId,
    attempt.signal, f.foundation.preparedContext(attempt))));
  assert.equal(providerCalls, 0);
  assert.equal(executor.state(attempt.requestId).status, "failed");
  await assert.rejects(f.foundation.finish(attempt, randomUUID()), /Chat.*binding|Task.*Chat|changed/i);
  const db = f.storage.connectNative();
  try {
    const actual = db.prepare("SELECT goal,status FROM managed_chat_tasks WHERE task_id=?").get(attempt.taskId);
    assert.equal(JSON.parse(actual.goal).status, "active");
    assert.equal(actual.status, "active");
  } finally { db.close(); }
});
