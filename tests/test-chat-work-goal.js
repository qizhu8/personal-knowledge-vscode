const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { randomUUID } = require("node:crypto");
const { prepareWorkGoal, recordWorkGoalTransition, reportWork, validWorkGoal, workGoalContext, workGoalInputs, workEvidenceKey, rootWorkCriterion } = require("../dist/chat/chat-work-goal");

const digest = "a".repeat(64);
const reviewMarkup = fs.readFileSync(path.join(__dirname, "../tools/work-intent-review/index.html"), "utf8");
const reviewData = JSON.parse(reviewMarkup.match(/<script id="review-data" type="application\/json">([\s\S]*?)<\/script>/)[1]);
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

test("previous-attempt evidence cannot resolve a resumed work objective", () => {
  const { chat, reply } = fixture();
  reportWork(chat, reply, report(chat, {
    status:"continue",
    nextAction:"Recheck the endpoint after the follow-up.",
    acceptance:[{ criterion:rootWorkCriterion, verified:true, evidenceCallIds:["probe"] }],
  }));
  const nextInputId = randomUUID();
  chat.messages.push({ id:nextInputId, role:"user", content:"Please verify the fix again." });
  prepareWorkGoal(chat, nextInputId, "Please verify the fix again.", digest);

  assert.equal(chat.workGoal.attemptInputId, nextInputId);
  assert.deepEqual(chat.workGoal.acceptance, [
    { criterion:rootWorkCriterion, verified:false, evidenceCallIds:[] },
  ]);
  assert.throws(() => reportWork(chat, reply, report(chat)), /No active work objective/);

  const nextReply = { id:randomUUID(), inputId:nextInputId, role:"assistant", status:"streaming", toolCalls:[] };
  chat.messages.push(nextReply);
  assert.throws(() => reportWork(chat, nextReply, report(chat, { acceptance:[
    { criterion:rootWorkCriterion, verified:true, evidenceCallIds:["probe"] },
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

test("a rejected replacement report names missing criteria and permits an explicit evidence-checked correction", () => {
  const { chat, reply } = fixture();
  const extra = "Deliver an isolated red regression, not a production repair.";
  reportWork(chat, reply, report(chat, { status:"continue", nextAction:"Run the isolated reproduction.", acceptance:[
    { criterion:rootWorkCriterion, verified:false, evidenceCallIds:[] },
    { criterion:extra, verified:false, evidenceCallIds:[] },
  ] }));
  const before = structuredClone(chat.workGoal);
  assert.throws(() => reportWork(chat, reply, report(chat, { acceptance:[
    { criterion:"The reproduction was delivered.", verified:true, evidenceCallIds:["probe"] },
  ] })), error => {
    assert.match(error.message, /preserve existing acceptance criteria verbatim/);
    assert(error.message.includes(rootWorkCriterion));
    assert(error.message.includes(extra));
    assert.match(error.message, /session_info.workGoal.acceptance/);
    return true;
  });
  assert.deepEqual(chat.workGoal, before);
  assert(workGoalContext(chat).includes("Copy EVERY existing acceptance criterion verbatim"));
  const corrected = report(chat, { acceptance:[
    { criterion:rootWorkCriterion, verified:true, evidenceCallIds:["probe"] },
    { criterion:extra, verified:true, evidenceCallIds:["probe"] },
  ] });
  corrected.acceptance[0].evidenceCallIds = ["missing-evidence"];
  assert.throws(() => reportWork(chat, reply, corrected), /execution\/validation/);
  assert.deepEqual(chat.workGoal, before);
  corrected.acceptance[0].evidenceCallIds = ["probe"];
  assert.equal(JSON.parse(reportWork(chat, reply, corrected)).recorded, true);
  assert.equal(chat.workGoal.status, "resolved");
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

test("only an explicit new-task command replaces a goal, preserving its unsettled history", () => {
  for (const status of ["active", "paused", "interrupted", "blocked", "needs_input"]) {
    const { chat } = fixture();
    chat.workGoal.status = status;
    const previous = structuredClone(chat.workGoal), id = randomUUID();
    const text = "开始新任务：修复另一个独立的回归。";
    chat.messages.push({ id, role:"user", content:text, status:"complete" });
    prepareWorkGoal(chat, id, text, "b".repeat(64));
    assert.notEqual(chat.workGoal.id, previous.id);
    assert.equal(chat.workGoal.inputId, id);
    assert.equal(chat.workGoal.attemptInputId, id);
    assert.equal(chat.workGoal.executionDigest, "b".repeat(64));
    assert.equal(chat.workGoal.status, "active");
    assert.equal(chat.workGoalHistory.length, 1);
    const archived = chat.workGoalHistory[0];
    assert.equal(archived.id, previous.id);
    assert.equal(archived.objective, previous.objective);
    assert.equal(archived.executionDigest, previous.executionDigest);
    assert.deepEqual(archived.acceptance, previous.acceptance);
    assert.equal(archived.status, status === "active" ? "paused" : status);
    assert(validWorkGoal(archived));
    assert(validWorkGoal(chat.workGoal));
    assert.deepEqual(workGoalInputs(chat), [id]);
    assert(!workGoalContext(chat).includes(previous.objective));
    assert.throws(() => prepareWorkGoal(chat, randomUUID(), "Continue", digest), /another execution context/);
    assert.equal(chat.workGoalHistory.length, 1, "failed resume does not archive or replace anything");
  }
});

test("new-task commands are anchored and require a concrete objective", () => {
  for (const text of ["Start a new task: Repair the second endpoint.", "开始新任务：修复独立回归。"]) {
    const chat = { includeHistory:false, messages:[] }, id = randomUUID();
    prepareWorkGoal(chat, id, text, digest);
    assert.equal(chat.workGoal.inputId, id);
    assert.equal(chat.workGoal.status, "active");
  }
  for (const text of ["Start a new task:", "开始新任务："]) {
    const { chat } = fixture(), previous = structuredClone(chat.workGoal);
    assert.throws(() => prepareWorkGoal(chat, randomUUID(), text, digest), /requires an objective/);
    assert.deepEqual(chat.workGoal, previous);
    assert.equal(chat.workGoalHistory, undefined);
  }
  for (const text of ["The note says 'Start a new task: fix this endpoint.'",
    "请解释“开始新任务：”是什么意思。", "> 开始新任务：修复问题。"]) {
    const { chat } = fixture(), previous = structuredClone(chat.workGoal);
    chat.workGoal.status = "paused";
    prepareWorkGoal(chat, randomUUID(), text, digest);
    assert.equal(chat.workGoal.id, previous.id, text);
    assert.equal(chat.workGoalHistory, undefined, text);
  }
});

test("successive new tasks preserve resolved evidence and History off never injects old objectives", () => {
  const { chat, reply } = fixture();
  reportWork(chat, reply, report(chat));
  const original = structuredClone(chat.workGoal);
  chat.includeHistory = false;
  for (const objective of ["Start a new task: Repair another endpoint.", "开始新任务：修复第三个问题。"]) {
    const id = randomUUID();
    chat.messages.push({ id, role:"user", content:objective, status:"complete" });
    prepareWorkGoal(chat, id, objective, digest);
    const context = workGoalContext(chat);
    assert(context.includes(objective), "the explicitly delegated current task remains available with History off");
    for (const archived of chat.workGoalHistory) assert(!context.includes(archived.objective));
    assert.deepEqual(workGoalInputs(chat), [id]);
  }
  assert.equal(chat.workGoalHistory.length, 2);
  assert.deepEqual(chat.workGoalHistory[0], original, "a completed goal retains its evidence, not a synthetic new completion");
  assert.equal(chat.workGoalHistory[1].status, "paused");
  assert.equal(chat.workGoalHistory[1].transitions.at(-1).reason, "user_superseded");
});

test("retrying the same explicit new-task input resumes its goal without another archival or retargeting", () => {
  for (const includeHistory of [true, false]) {
    const { chat } = fixture(), inputId = randomUUID(), text = "Start a new task: Repair another endpoint.";
    chat.includeHistory = includeHistory;
    chat.messages.push({ id:inputId, role:"user", content:text, status:"complete" });
    prepareWorkGoal(chat, inputId, text, "b".repeat(64));
    const id = chat.workGoal.id;
    chat.workGoal.status = "interrupted";
    chat.workGoal.acceptance[0].verified = true;
    chat.workGoal.acceptance[0].evidenceCallIds = ["old-probe"];
    assert.throws(() => prepareWorkGoal(chat, inputId, text, digest), /another execution context/);
    prepareWorkGoal(chat, inputId, text, "b".repeat(64));
    assert.equal(chat.workGoal.id, id);
    assert.equal(chat.workGoal.status, "active");
    assert.equal(chat.workGoalHistory.length, 1);
    assert.equal(chat.workGoal.transitions.at(-1).reason, "user_resumed");
    assert.equal(chat.workGoal.acceptance[0].verified, false);
    assert.deepEqual(chat.workGoal.acceptance[0].evidenceCallIds, []);
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
  prepareWorkGoal(chat, randomUUID(), "Please do not pause the current task.", digest);
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

test("work-goal transitions record lifecycle reasons without copying input text", () => {
  const { chat, reply } = fixture();
  const root = chat.workGoal;
  assert.deepEqual(root.transitions.map(item => item.reason), ["user_delegated"]);
  assert.equal(JSON.stringify(root.transitions).includes(root.objective), false);

  reportWork(chat, reply, report(chat, { status:"needs_input", reason:"Need the target endpoint.", acceptance:[
    { criterion:rootWorkCriterion, verified:false, evidenceCallIds:[] },
  ] }));
  const answerId = randomUUID();
  chat.messages.push({ id:answerId, role:"user", content:"localhost:3000" });
  prepareWorkGoal(chat, answerId, "localhost:3000", digest);
  const nextReply = { ...reply, inputId:answerId };
  nextReply.toolCalls = [{ id:"probe-2", name:"run_process", arguments:"{}", status:"complete", result:'{"exitCode":0}' }];
  reportWork(chat, nextReply, report(chat, { acceptance:[
    { criterion:rootWorkCriterion, verified:true, evidenceCallIds:["probe-2"] },
  ] }));

  assert.deepEqual(chat.workGoal.transitions.map(item => item.reason),
    ["user_delegated", "agent_needs_input", "user_answered", "agent_claimed_resolved"]);
  assert(chat.workGoal.transitions.every(item => !Object.hasOwn(item, "text") && !Object.hasOwn(item, "content")));
  assert(validWorkGoal(chat.workGoal));
});

test("transition history is bounded and legacy goals remain valid", () => {
  const { chat } = fixture();
  const legacy = { ...chat.workGoal };
  delete legacy.transitions;
  assert.equal(validWorkGoal(legacy), true);

  let goal = chat.workGoal;
  for (let index = 0; index < 70; index++) {
    goal = recordWorkGoalTransition(goal, index % 2 ? "active" : "paused",
      index % 2 ? "user_resumed" : "user_paused", randomUUID(), index);
  }
  assert.equal(goal.transitions.length, 64);
  assert.equal(goal.transitions[0].at, 6);
  assert(validWorkGoal(goal));
  assert.equal(validWorkGoal({ ...goal, transitions:[{ ...goal.transitions[0], reason:"unclassified" }] }), false);
});

test("user pause and explicit resume are distinct transitions", () => {
  const { chat } = fixture();
  const pauseId = randomUUID();
  prepareWorkGoal(chat, pauseId, "Pause the current task.", digest);
  assert.equal(chat.workGoal.status, "paused");
  assert.equal(chat.workGoal.transitions.at(-1).reason, "user_paused");
  const resumeId = randomUUID();
  prepareWorkGoal(chat, resumeId, "Continue.", digest);
  assert.equal(chat.workGoal.status, "active");
  assert.equal(chat.workGoal.transitions.at(-1).reason, "user_resumed");
  assert.equal(chat.workGoal.transitions.at(-1).inputId, resumeId);
});

test("work-intent baseline measures task admission and explicit stop/resume controls", t => {
  const taskOutcomes = [];
  const controlOutcomes = [];
  for (const item of reviewData.samples) {
    const chat = { includeHistory:true, messages:[] };
    const inputId = randomUUID();
    if (item.kind === "control") {
      prepareWorkGoal(chat, randomUUID(), "Please fix this endpoint.", digest);
      chat.workGoal.status = item.reference === "pause" ? "active" : "interrupted";
      prepareWorkGoal(chat, inputId, item.text, digest);
      controlOutcomes.push({ ...item, actual:chat.workGoal.status });
      continue;
    }
    prepareWorkGoal(chat, inputId, item.text, digest);
    const admitted = chat.workGoal?.transitions[0].reason === "user_delegated";
    taskOutcomes.push({ ...item, admitted });
  }
  const falseNegatives = taskOutcomes.filter(item => item.reference === "execute" && !item.admitted);
  const falsePositives = taskOutcomes.filter(item => item.reference !== "execute" && item.admitted);
  const controlErrors = controlOutcomes.filter(item => item.actual !== item.observed);
  assert.deepEqual(falseNegatives.map(item => item.text).sort(), [
    "Please research session memory and propose a plan.",
    "Please write a report comparing these options.",
    "Please test the current branch and summarize failures.",
    "Run the focused tests and summarize failures.",
    "我现在需要下线，把研究工作交给你。",
    "帮我认真研究 session memory 和 harness，并总结方案。",
    "帮我写一份对比文档。",
    "请测试当前分支并汇总失败。",
    "请整理这份报告。",
  ].sort());
  assert.deepEqual(falsePositives.map(item => item.text).sort(), [
    "Should I implement a memory retrieval controller?",
    "Can you investigate this timeout?",
    "Could you explain how I can fix this?",
    "Please tell me whether I should repair the login flow.",
    "The note says: 'Please fix this broken endpoint.'",
    "The README asks: implement a retrieval controller.",
    "I saw 'investigate this issue' in the log.",
  ].sort());
  assert.equal(taskOutcomes.length, 29);
  assert.equal(falseNegatives.length, 9);
  assert.equal(falsePositives.length, 7);
  assert.deepEqual(controlErrors.map(item => `${item.text} -> ${item.actual}`), []);
  t.diagnostic(`Provisional labels only: ${taskOutcomes.length} execution/exploration/quoted phrases; ${falseNegatives.length} false negatives (${falseNegatives.map(item => item.text).join(" | ")}); ${falsePositives.length} false positives (${falsePositives.map(item => item.text).join(" | ")}). Stop/resume: ${controlErrors.length} mismatches (${controlErrors.map(item => `${item.text} -> ${item.actual}`).join(" | ")}).`);
});
