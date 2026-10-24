const { test } = require("node:test");
const assert = require("node:assert/strict");
const { randomUUID } = require("node:crypto");
const { prepareWorkGoal, reportWork, validWorkGoal, workGoalContext, workGoalInputs, workEvidenceKey, rootWorkCriterion } = require("../dist/chat/chat-work-goal");

const digest = "a".repeat(64);
function fixture() {
  const input = { id:randomUUID(), role:"user", content:"Please fix this broken endpoint.", status:"complete" };
  const chat = { includeHistory:true, messages:[input] };
  prepareWorkGoal(chat, input.id, input.content, digest);
  const reply = { id:randomUUID(), inputId:input.id, role:"assistant", status:"streaming",
    toolCalls:[{ id:"probe", name:"run_process", arguments:"{}", status:"complete", result:'{"exitCode":0}' }] };
  chat.messages.push(reply);
  return { chat, reply };
}
function report(chat, patch = {}) {
  return { status:"resolved", reason:"The endpoint regression passed.", sourceInputIds:workGoalInputs(chat),
    acceptance:[{ criterion:rootWorkCriterion, verified:true, evidenceCallIds:["probe"] }], ...patch };
}

test("root work objective survives narrower followups and blocked-answer resume", () => {
  const { chat, reply } = fixture(), root = structuredClone(chat.workGoal);
  reportWork(chat, reply, report(chat, { status:"needs_input", reason:"Need the target endpoint.", acceptance:[
    { criterion:rootWorkCriterion, verified:false, evidenceCallIds:[] },
  ] }));
  const id = randomUUID();
  chat.messages.push({ id, role:"user", content:"Here is the endpoint: localhost:3000" });
  prepareWorkGoal(chat, id, "Here is the endpoint: localhost:3000", digest);
  assert.equal(chat.workGoal.id, root.id);
  assert.equal(chat.workGoal.objective, root.objective);
  assert.equal(chat.workGoal.status, "active");
  assert.equal(chat.workGoal.attemptInputId, id);
  assert.equal(workGoalInputs(chat).length, 2);
  assert(validWorkGoal(chat.workGoal));
});

test("a successful diagnostic or report is not a goal acceptance certificate", () => {
  const { chat, reply } = fixture();
  assert.throws(() => reportWork(chat, reply, report(chat, { acceptance:[
    { criterion:rootWorkCriterion, verified:false, evidenceCallIds:[] },
  ] })), /every acceptance/);
  reply.toolCalls.push({ id:"summary", name:"finish_debug", arguments:"{}", status:"complete", result:"done" });
  assert.throws(() => reportWork(chat, reply, report(chat, { acceptance:[
    { criterion:rootWorkCriterion, verified:true, evidenceCallIds:["summary"] },
  ] })), /execution\/validation/);
  assert.equal(chat.workGoal.status, "active");
});

test("updates cannot silently remove criteria or ignore newer user input", () => {
  const { chat, reply } = fixture();
  reportWork(chat, reply, report(chat, { status:"continue", nextAction:"Repair and test the endpoint.", acceptance:[
    { criterion:rootWorkCriterion, verified:false, evidenceCallIds:[] },
  ] }));
  assert.throws(() => reportWork(chat, reply, report(chat, { acceptance:[
    { criterion:"A log was read", verified:true, evidenceCallIds:["probe"] },
  ] })), /preserve existing/i);
  const stale = report(chat);
  chat.messages.push({ id:randomUUID(), role:"user", content:"Preserve existing clients." });
  assert.throws(() => reportWork(chat, reply, stale), /all ordered sourceInputIds/);
});

test("pause and interruption require explicit resumption and never retarget", () => {
  for (const status of ["paused", "interrupted"]) {
    const { chat } = fixture();
    chat.workGoal.status = status;
    prepareWorkGoal(chat, randomUUID(), "Here is another log.", digest);
    assert.equal(chat.workGoal.status, status);
    assert.throws(() => prepareWorkGoal(chat, randomUUID(), "Continue", "b".repeat(64)), /another execution context/);
    prepareWorkGoal(chat, randomUUID(), "Continue", digest);
    assert.equal(chat.workGoal.status, "active");
  }
});

test("casual explanations and history-off requests do not resurrect hidden goals", () => {
  for (const content of ["How do I fix this endpoint?", "Please explain how to fix the endpoint.", "帮我解释一下怎么修复这个问题"]) {
    const ordinary = { includeHistory:true, messages:[] };
    prepareWorkGoal(ordinary, randomUUID(), content, digest);
    assert.equal(ordinary.workGoal, undefined);
  }
  const { chat } = fixture();
  chat.workGoal.status = "needs_input";
  const before = structuredClone(chat.workGoal);
  prepareWorkGoal(chat, randomUUID(), "Why is this happening?", digest);
  assert.deepEqual(chat.workGoal, before);
  chat.includeHistory = false;
  prepareWorkGoal(chat, randomUUID(), "Here is a log.", digest);
  assert.deepEqual(chat.workGoal, before);
  assert.throws(() => reportWork(chat, { inputId:randomUUID() }, report(chat)), /No active work/);
});

test("negative shutdown phrases do not cancel delegated work, but explicit stop does", () => {
  const { chat } = fixture();
  prepareWorkGoal(chat, randomUUID(), "Please investigate this. 不要停止调查，不得停止服务。", digest);
  assert.equal(chat.workGoal.status, "active");
  prepareWorkGoal(chat, randomUUID(), "Stop.", digest);
  assert.equal(chat.workGoal.status, "paused");
});

test("same diagnostic under new call identities is not fresh progress", () => {
  const { reply } = fixture(), before = workEvidenceKey(reply);
  reply.toolCalls.push({ ...reply.toolCalls[0], id:"duplicate-probe" });
  assert.equal(workEvidenceKey(reply), before);
  reply.toolCalls.push({ id:"work", name:"report_work", arguments:"{}", status:"complete", result:"another summary" });
  assert.equal(workEvidenceKey(reply), before);
  reply.toolCalls.push({ ...reply.toolCalls[0], id:"new-result", result:"different actual result" });
  assert.notEqual(workEvidenceKey(reply), before);
});

test("resolved state preserves evidence and publicly distinguishes agent claim from certification", () => {
  const { chat, reply } = fixture();
  const result = JSON.parse(reportWork(chat, reply, report(chat)));
  assert.equal(result.agentClaimNotIndependentCertification, true);
  assert.equal(chat.workGoal.status, "resolved");
  assert(workGoalContext(chat).includes(chat.workGoal.objective));
  assert(workGoalContext(chat).includes("not independent certification"));
  assert.equal(validWorkGoal({ ...chat.workGoal, status:"quiet" }), false);
});
