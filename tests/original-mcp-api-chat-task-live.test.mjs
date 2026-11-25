import assert from "node:assert/strict";
import test from "node:test";
import { originalApiTaskLiveFixture } from "./original-mcp-api-chat-task-live-fixture.mjs";
import { originalNativeChatDigest } from "../dist/original-mcp-api-chat-contracts.js";
const enabled = process.env.PKM_TEST_MANAGED_TASK_LANE === "1";
const options = { timeout: 120000, skip: enabled ? false : "Requires the composed execution.task.run lane; run explicitly with PKM_TEST_MANAGED_TASK_LANE=1." };

test("original API approved fresh Task runs canonical evidence/Harness once, denied consent creates nothing and reply never completes the Task", options, async t => {
  const f = await originalApiTaskLiveFixture(t);
  const request = { host_id: f.workspaceId, chat_id: f.created.chatId, command_id: "canonical-api-task",
    prompt: "Start a new task: verify the exact fixture Note and preserve the original objective.", hard_tool_round_limit: 6 };
  f.allow(false);
  const denied = await f.call("api_chat_send", { ...request, command_id: "canonical-api-task-denied" });
  assert.equal((await f.receipt(denied.request_id)).status, "failed");
  let db = f.storage.connectNative();
  try { assert.equal(db.prepare("SELECT count(*) AS n FROM managed_chat_tasks").get().n, 0); }
  finally { db.close(); }
  f.allow(true);
  let modelRuns = 0;
  f.run(async (plan, ports) => {
    modelRuns++;
    assert(plan.messages.some(message => message.role === "user" && message.content === request.prompt));
    for (const name of ["get_document", "session_info", "record_harness", "report_work"])
      assert(plan.tools.some(tool => tool.name === name), `Missing actual scoped Core tool ${name}`);
    for (const name of ["spawn_workers", "start_recipe", "dispatch_any"])
      assert(!plan.tools.some(tool => tool.name === name), `Unqualified Task tool leaked: ${name}`);
    const inputId = plan.managedTask.inputId, receipts = [], proposals = [
      ["get_document", { id: "Entry" }, "note-evidence"],
      ["record_harness", { kind: "task", goal: request.prompt, sourceInputIds: [inputId] }, "task-report"],
      ["record_harness", { kind: "validation", stepId: "note", status: "start", summary: "Check actual Note.", sourceInputIds: [inputId] }, "validation-start"],
      ["record_harness", { kind: "validation", stepId: "note", status: "complete", summary: "Actual Note observed.", evidenceCallIds: ["note-evidence"] }, "validation-complete"],
      ["report_work", { status: "resolved", reason: "Actual canonical Note read.", sourceInputIds: [inputId],
        acceptance: [{ criterion: "The original user objective and all subsequent requirements are satisfied.",
          verified: true, evidenceCallIds: ["note-evidence"] }],
        contract: { scope: ["Read exact fixture Note"], nonGoals: [], stopWhen: "Required Note is observed." } }, "resolution"],
    ];
    for (const [round, [name, args, callId]] of proposals.entries()) {
      const id = await f.infer(plan, ports, round, receipts);
      await f.context(plan, ports, id, round, "after-round", true);
      const result = await ports.tool({ inferenceId: id, round, name, arguments: args, callId, argumentsSha256: originalNativeChatDigest(args) });
      assert(!result.content.includes('"status":"failed"'), result.content);
      receipts.push(result.receiptSha256);
      await f.context(plan, ports, id, round, "after-tools", true);
    }
    const round = proposals.length, id = await f.infer(plan, ports, round, receipts, []);
    await ports.text({ inferenceId: id, text: "Recorded evidence-backed agent resolution, not Task/human acceptance." });
    assert.equal((await f.context(plan, ports, id, round, "after-round", false)).decision, "finish");
    assert.equal((await f.context(plan, ports, id, round, "settled", false)).decision, "finish");
    return { status: "complete", toolRoundLimit: null };
  });
  const submitted = await f.call("api_chat_send", request), settled = await f.receipt(submitted.request_id);
  assert.equal(settled.status, "succeeded", settled.error);
  assert.equal(settled.result.managedTask.goal.status, "resolved");
  assert.equal(settled.result.managedTask.status, "active");
  assert.equal(settled.result.managedTask.taskCompletion, "not-claimed");
  assert.equal(settled.result.sessionAuthority, "native_core");
  assert.equal(settled.result.managedTask.harnessReports.length, 3);
  assert.equal((await f.call("api_chat_send", request)).request_id, submitted.request_id);
  assert.equal(modelRuns, 1);
  db = f.storage.connectNative();
  try {
    assert.equal(db.prepare("SELECT count(*) AS n FROM managed_chat_tasks").get().n, 1);
    assert.equal(db.prepare("SELECT count(*) AS n FROM managed_chat_task_attempts").get().n, 1);
    assert.equal(db.prepare("SELECT count(*) AS n FROM chat_session_messages").get().n, 2);
  } finally { db.close(); }
});

test("plain native responses hit original stale-ending policy, while explicitly approved follow-up retains the same canonical objective", options, async t => {
  const f = await originalApiTaskLiveFixture(t);
  let firstGoal;
  f.run(async (plan, ports) => {
    firstGoal = plan.managedTask.taskId;
    for (let round = 0; round < 2; round++) {
      const id = await f.infer(plan, ports, round, [], []);
      await ports.text({ inferenceId: id, text: "A model response is not acceptance." });
      const decision = await f.context(plan, ports, id, round, "after-round", false);
      if (round === 0) { assert.equal(decision.decision, "continue"); assert.match(decision.continuation, /objective is still open/); }
      else { assert.equal(decision.errorCode, "GOAL_STALE_ENDINGS"); return { status: "failed", toolRoundLimit: null }; }
    }
    assert.fail();
  });
  const args = { host_id: f.workspaceId, chat_id: f.created.chatId, command_id: "unresolved-task",
    prompt: "Start a new task: retain an unresolved objective until actual evidence exists.", hard_tool_round_limit: 6 };
  const submitted = await f.call("api_chat_send", args), first = await f.receipt(submitted.request_id);
  assert.equal(first.status, "outcome_unknown");
  const inspection = await f.call("api_chat_get", { host_id: f.workspaceId, chat_id: f.created.chatId });
  const inspected = await f.receipt(inspection.request_id);
  assert.equal(inspected.status, "succeeded", inspected.error);
  const before = inspected.result;
  assert(before.managedTask, JSON.stringify(before));
  assert.equal(before.managedTask.goal.status, "interrupted");
  assert.equal(before.managedTask.taskCompletion, "not-claimed");
  const goalId = before.managedTask.goal.id;
  f.run(async (plan, ports) => {
    assert.equal(plan.managedTask.taskId, firstGoal);
    const id = await f.infer(plan, ports, 0, []);
    await f.context(plan, ports, id, 0, "after-round", true);
    const initial = plan.messages.filter(message => message.role === "user").map(message => message.content);
    assert(initial.includes(args.prompt) && initial.includes("Continue the same exact objective."));
    const context = JSON.parse(plan.messages.at(-1).content.split("\n")[1]);
    assert.equal(context.inputId, plan.managedTask.inputId);
    const info = await ports.tool({ inferenceId: id, round: 0, name: "session_info", callId: "current-task",
      arguments: {}, argumentsSha256: originalNativeChatDigest({}) });
    const snapshot = JSON.parse(info.content);
    assert(snapshot, info.content);
    await f.context(plan, ports, id, 0, "after-tools", true);
    const reportId = await f.infer(plan, ports, 1, [info.receiptSha256]);
    await f.context(plan, ports, reportId, 1, "after-round", true);
    const report = { status: "needs_input", reason: "This deterministic fixture awaits an explicit user requirement.",
      sourceInputIds: snapshot.sourceInputIds, acceptance: snapshot.goal.acceptance.map(item => ({ ...item, verified: false, evidenceCallIds: [] })) };
    const result = await ports.tool({ inferenceId: reportId, round: 1, name: "report_work", callId: "input-handoff",
      arguments: report, argumentsSha256: originalNativeChatDigest(report) });
    await f.context(plan, ports, reportId, 1, "after-tools", true);
    const final = await f.infer(plan, ports, 2, [info.receiptSha256, result.receiptSha256], []);
    await ports.text({ inferenceId: final, text: "A precise needs-input handoff is not Task completion." });
    await f.context(plan, ports, final, 2, "after-round", false);
    await f.context(plan, ports, final, 2, "settled", false);
    return { status: "complete", toolRoundLimit: null };
  });
  const followup = await f.call("api_chat_send", { ...args, command_id: "explicit-task-followup", prompt: "Continue the same exact objective." });
  const completed = await f.receipt(followup.request_id); assert.equal(completed.status, "succeeded", completed.error);
  assert.equal(completed.result.managedTask.taskId, firstGoal);
  assert.equal(completed.result.managedTask.goal.id, goalId);
  assert.equal(completed.result.managedTask.goal.objective, args.prompt);
  assert.equal(completed.result.managedTask.goal.status, "needs_input");
  assert.equal(completed.result.managedTask.sourceInputIds.length, 2);
  assert.equal(completed.result.managedTask.taskCompletion, "not-claimed");
});
