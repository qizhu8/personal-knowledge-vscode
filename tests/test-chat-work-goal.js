const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { randomUUID } = require("node:crypto");
const { prepareWorkGoal, recordWorkGoalTransition, reportWork, validWorkGoal, workGoalContext, workGoalInputs, workEvidenceKey, workEvidenceHint, workEvidenceBatchHint, rootWorkCriterion } = require("../dist/chat/chat-work-goal");

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

test("batch evidence retains eight realistic identities at half the exact UTF8 cost", () => {
  const { chat, reply } = fixture();
  const names = ["read_file", "search_text", "run_process", "replace_text", "save_file", "capability_read", "find_files", "list_directory"];
  reply.toolCalls = names.map((name, index) => ({ ...reply.toolCalls[0], name,
    id:index % 2 ? `call_${randomUUID().replaceAll("-", "")}` : randomUUID(),
    result:'{"text":"raw résult 中文 remains unchanged"}',
  }));
  const ids = reply.toolCalls.map(call => call.id), before = structuredClone({ chat, reply, ids });
  const oldHints = ids.map(id => workEvidenceHint(chat, reply, id)).join("");
  const hint = workEvidenceBatchHint(chat, reply, ids), parsed = JSON.parse(hint);
  const oldBytes = Buffer.byteLength(oldHints, "utf8"), newBytes = Buffer.byteLength(hint, "utf8");
  console.log(`Batch evidence UTF8 bytes: old=${oldBytes}, new=${newBytes}`);
  assert.ok(newBytes <= oldBytes * 0.5, `${newBytes} must be <= ${oldBytes / 2}`);
  assert.ok(hint.length <= 2000);
  assert.equal(parsed.schema, "pkm.chat.work-evidence-hint/v2");
  assert.equal(parsed.goalId, chat.workGoal.id);
  assert.equal(parsed.attemptInputId, reply.inputId);
  assert.equal(parsed.omitted, 0);
  assert.deepEqual(parsed.evidence, reply.toolCalls.map(({ id, name }) => ({ id, name })));
  assert.deepEqual({ chat, reply, ids }, before);
});

test("batch evidence preserves single v1 and excludes duplicates and ineligible identities", () => {
  const { chat, reply } = fixture();
  reply.toolCalls.push(...["session_info", "report_work", "finish_debug", "record_harness"].map(name =>
    ({ ...reply.toolCalls[0], id:name, name })),
    { ...reply.toolCalls[0], id:"failed", status:"failed" },
    { ...reply.toolCalls[0], id:"running", status:"running" },
    { ...reply.toolCalls[0], id:"no-result", result:undefined },
    { ...reply.toolCalls[0], id:"" });
  const ids = ["probe", "probe", "missing", "", " ", ...reply.toolCalls.slice(1).map(call => call.id)];
  const before = structuredClone({ chat, reply, ids });
  assert.equal(workEvidenceBatchHint(chat, reply, ids), workEvidenceHint(chat, reply, "probe"));
  assert.equal(workEvidenceBatchHint(chat, reply, ids.slice(2)), undefined);
  assert.equal(workEvidenceBatchHint(chat, { ...reply, inputId:randomUUID() }, ids), undefined);
  assert.equal(workEvidenceBatchHint({ ...chat, workGoal:undefined }, reply, ids), undefined);
  assert.equal(workEvidenceBatchHint({ ...chat, workGoal:{ ...chat.workGoal, status:"blocked" } }, reply, ids), undefined);
  assert.deepEqual({ chat, reply, ids }, before);
});

test("batch evidence validates reserved budgets and reports exact whole-identity omissions", () => {
  const { chat, reply } = fixture();
  reply.toolCalls = Array.from({ length:40 }, (_, index) => ({ ...reply.toolCalls[0],
    id:index === 0 ? "oversized-" + "x".repeat(2200) : `call_${randomUUID().replaceAll("-", "")}`,
  }));
  const ids = reply.toolCalls.map(call => call.id), before = structuredClone({ chat, reply, ids });
  for (const budget of [200, 420, 700, 2000]) {
    const hint = workEvidenceBatchHint(chat, reply, ids, budget), parsed = JSON.parse(hint);
    assert.ok(hint.length <= budget);
    const retained = parsed.evidence || [];
    assert.equal(parsed.omitted, ids.length - retained.length);
    assert.ok(parsed.omitted > 0);
    assert.match(parsed.omissionNotice || parsed.note, /omitted|Omitted/);
    assert.ok(!hint.includes(ids[0]));
    for (const identity of retained) {
      assert.deepEqual(identity, { id:ids.find(id => id === identity.id), name:"run_process" });
    }
  }
  const overflow = JSON.parse(workEvidenceBatchHint(chat, reply, ids));
  assert.ok(overflow.evidence.length > 0);
  assert.ok(overflow.evidence.length < ids.length);
  for (const invalid of [0, 199, 2001, -1, 400.5, NaN, Infinity, "700", null]) {
    assert.throws(() => workEvidenceBatchHint(chat, reply, ids, invalid), RangeError);
  }
  const oversized = JSON.parse(workEvidenceBatchHint(chat, reply, [ids[0]]));
  assert.equal(oversized.omitted, 1);
  assert.deepEqual(oversized.evidence, []);
  assert.deepEqual({ chat, reply, ids }, before);
});

test("batch evidence retains all identities that fit before adding omission text", () => {
  const { chat, reply } = fixture();
  reply.toolCalls = ["call_" + "a".repeat(150), randomUUID()]
    .map(id => ({ ...reply.toolCalls[0], id }));
  const ids = reply.toolCalls.map(call => call.id);
  const complete = workEvidenceBatchHint(chat, reply, ids);
  const bounded = workEvidenceBatchHint(chat, reply, ids, complete.length);
  assert.equal(bounded, complete);
  assert.equal(JSON.parse(bounded).omitted, 0);
});

test("work evidence hint exposes only current eligible identity without mutation", () => {
  const { chat, reply } = fixture(), before = structuredClone(chat);
  const hint = workEvidenceHint(chat, reply, "probe");
  assert.equal(typeof hint, "string");
  assert.ok(hint.length <= 2000);
  const parsed = JSON.parse(hint);
  assert.deepEqual(parsed, {
    schema:"pkm.chat.work-evidence-hint/v1", goalId:chat.workGoal.id, attemptInputId:reply.inputId,
    evidence:{ id:"probe", name:"run_process" },
    note:"Identity candidate only; not semantic acceptance, permission, or managed completion.",
  });
  assert.doesNotMatch(hint, /arguments|exitCode|result|\\{\\}/);
  assert.deepEqual(chat, before);

  const oversized = structuredClone(reply);
  const longId = "x".repeat(2100);
  oversized.toolCalls[0].id = longId;
  const omitted = workEvidenceHint(chat, oversized, longId);
  assert.ok(omitted.length <= 2000);
  assert.equal(JSON.parse(omitted).omitted, true);
  assert.equal(JSON.parse(omitted).evidence, undefined);
  assert.ok(!omitted.includes(longId));
});

test("work evidence hint rejects foreign, missing, ineligible, incomplete, and old-goal calls", () => {
  const { chat, reply } = fixture();
  assert.equal(workEvidenceHint(chat, { ...reply, inputId:randomUUID() }, "probe"), undefined);
  assert.equal(workEvidenceHint(chat, reply, "missing"), undefined);
  for (const [name, status, result] of [
    ["session_info", "complete", "{}"], ["run_process", "running", undefined], ["run_process", "failed", "{}"],
  ]) {
    const candidate = { ...reply, toolCalls:[{ id:"candidate", name, status, result }] };
    assert.equal(workEvidenceHint(chat, candidate, "candidate"), undefined);
  }
  const oldAttempt = { ...reply, inputId:randomUUID() };
  assert.equal(workEvidenceHint(chat, oldAttempt, "probe"), undefined);
  chat.workGoal.status = "blocked";
  assert.equal(workEvidenceHint(chat, reply, "probe"), undefined);
});

test("work evidence hint identity can support the unchanged original report contract", () => {
  const { chat, reply } = fixture();
  const hint = JSON.parse(workEvidenceHint(chat, reply, "probe"));
  const originalReport = report(chat, { acceptance:[{
    criterion:rootWorkCriterion, verified:true, evidenceCallIds:[hint.evidence.id],
  }] });
  assert.deepEqual(originalReport.sourceInputIds, workGoalInputs(chat));
  assert.equal(originalReport.acceptance[0].criterion, rootWorkCriterion);
  reportWork(chat, reply, originalReport);
  assert.equal(chat.workGoal.status, "resolved");
  assert.deepEqual(chat.workGoal.acceptance[0], {
    criterion:rootWorkCriterion, verified:true, evidenceCallIds:["probe"],
  });
});

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

test("per-criterion evidence limits report the exact field and count without mutating rejected reports", () => {
  for (const [count, index] of [[42, 0], [33, 3]]) {
    const { chat, reply } = fixture();
    const args = report(chat, { status:"blocked", reason:"Validation remains incomplete.", acceptance:[
      { criterion:rootWorkCriterion, verified:false, evidenceCallIds:[] },
      ...Array.from({ length:4 }, (_, i) => ({ criterion:`PRIVATE_CRITERION_${i}`, verified:false, evidenceCallIds:[] })),
    ] });
    args.acceptance[index].evidenceCallIds = Array.from({ length:count }, (_, i) => `recorded-call-${i}`);
    const goal = chat.workGoal;
    const before = structuredClone({ chat, reply, args });
    assert.throws(() => reportWork(chat, reply, args), error => {
      assert.match(error.message, new RegExp(`acceptance\\[${index}\\]\\.evidenceCallIds`));
      assert.match(error.message, new RegExp(`contains ${count} IDs; maximum 32`));
      assert.match(error.message, /No work state was changed/);
      assert.doesNotMatch(error.message, /Provide 1–32 unique acceptance criteria|PRIVATE_CRITERION_|recorded-call-/);
      return true;
    });
    assert.equal(chat.workGoal, goal, "rejection retains the original Goal object");
    assert.deepEqual({ chat, reply, args }, before, "rejection changes neither Chat, Goal, reply nor submitted acceptance");
  }
});

test("per-criterion evidence limits accept 32 without adding unverified evidence rules", () => {
  for (const verified of [false, true]) {
    const { chat, reply } = fixture();
    const ids = Array.from({ length:32 }, (_, i) => `validation-${i}`);
    if (verified) reply.toolCalls = ids.map(id => ({ ...reply.toolCalls[0], id }));
    const args = report(chat, { status:"blocked", reason:"Other acceptance remains incomplete.", acceptance:[
      { criterion:rootWorkCriterion, verified:false, evidenceCallIds:[] },
      { criterion:"Boundary evidence", verified, evidenceCallIds:ids },
    ] });
    const before = structuredClone(args);
    assert.equal(JSON.parse(reportWork(chat, reply, args)).recorded, true);
    assert.equal(chat.workGoal.status, "blocked");
    assert.deepEqual(chat.workGoal.acceptance, before.acceptance);
    assert.deepEqual(args, before, "valid evidence is not truncated or selected");
    assert.equal(validWorkGoal(chat.workGoal), true);
  }
});

test("invalid evidence reports advertise only current eligible candidates and allow an exact correction", () => {
  const { chat, reply } = fixture();
  const actualValidationId = "actual-validation-1";
  const hiddenArgs = "HIDDEN_ARGUMENT_SENTINEL";
  const hiddenResult = "HIDDEN_RESULT_SENTINEL";
  reply.toolCalls = [
    { id:actualValidationId, name:"run_process", arguments:hiddenArgs, status:"complete", result:hiddenResult },
    { id:"session-info-id", name:"session_info", arguments:hiddenArgs, status:"complete", result:hiddenResult },
  ];
  const before = structuredClone(chat.workGoal);
  assert.throws(() => reportWork(chat, reply, report(chat, { acceptance:[
    { criterion:rootWorkCriterion, verified:true, evidenceCallIds:[actualValidationId, "session-info-id"] },
  ] })), error => {
    assert.match(error.message, /unique successful execution\/validation call IDs from this attempt, not reports or another attempt/);
    assert.match(error.message, /\[{"id":"actual-validation-1","name":"run_process"}\]/);
    assert.match(error.message, /Omitted eligible current-reply candidate count: 0/);
    assert(!error.message.includes(hiddenArgs));
    assert(!error.message.includes(hiddenResult));
    return true;
  });
  assert.deepEqual(chat.workGoal, before, "a rejected report leaves the entire goal unchanged");
  const corrected = report(chat, { acceptance:[
    { criterion:rootWorkCriterion, verified:true, evidenceCallIds:[actualValidationId] },
  ] });
  assert.equal(JSON.parse(reportWork(chat, reply, corrected)).recorded, true,
    "the advertised actual validation call ID succeeds on corrected retry");
});

test("duplicate, missing, old-attempt and empty evidence still reject without changing the goal", () => {
  for (const kind of ["duplicate", "missing", "old-attempt", "empty"]) {
    const { chat, reply } = fixture();
    const before = structuredClone(chat.workGoal);
    let evidenceCallIds = ["missing-call"];
    if (kind === "duplicate") evidenceCallIds = ["probe", "probe"];
    if (kind === "old-attempt") {
      chat.messages.push({ id:randomUUID(), inputId:"old-input", role:"assistant", status:"complete",
        toolCalls:[{ id:"old-attempt-call", name:"run_process", arguments:"old args", status:"complete", result:"old result" }] });
      evidenceCallIds = ["old-attempt-call"];
    }
    if (kind === "empty") {
      reply.toolCalls = [{ id:"excluded", name:"record_harness", arguments:"hidden", status:"complete", result:"hidden" }];
      evidenceCallIds = ["excluded"];
    }
    assert.throws(() => reportWork(chat, reply, report(chat, { acceptance:[
      { criterion:rootWorkCriterion, verified:true, evidenceCallIds },
    ] })), error => {
      assert.match(error.message, /execution\/validation call IDs from this attempt/);
      if (kind === "empty") {
        assert.match(error.message, /candidates \(id,name; maximum 8\): \[\]/);
        assert.match(error.message, /Omitted eligible current-reply candidate count: 0/);
        assert.match(error.message, /No eligible current-reply candidates are available/);
      } else {
        assert.match(error.message, /\[{"id":"probe","name":"run_process"}\]/);
      }
      if (kind === "old-attempt") assert(!error.message.includes("old-attempt-call"));
      return true;
    });
    assert.deepEqual(chat.workGoal, before, `${kind} rejection does not mutate any goal fields`);
  }
});

test("invalid evidence candidate diagnostics are capped at eight with an exact omitted count", () => {
  const { chat, reply } = fixture();
  reply.toolCalls = Array.from({ length:10 }, (_, index) => ({ id:`current-${index}`, name:"run_process",
    arguments:`ARGUMENT_${index}_SENTINEL`, status:"complete", result:`RESULT_${index}_SENTINEL` }));
  const before = structuredClone(chat.workGoal);
  assert.throws(() => reportWork(chat, reply, report(chat, { acceptance:[
    { criterion:rootWorkCriterion, verified:true, evidenceCallIds:["unknown"] },
  ] })), error => {
    const match = error.message.match(/Eligible current-reply candidates \(id,name; maximum 8\): (\[[^]*?\])\./);
    assert(match);
    const candidates = JSON.parse(match[1]);
    assert.equal(candidates.length, 8);
    assert.deepEqual(candidates[0], { id:"current-0", name:"run_process" });
    assert.match(error.message, /Omitted eligible current-reply candidate count: 2/);
    assert(error.message.includes("No work state changed."));
    assert(!error.message.includes("ARGUMENT_"));
    assert(!error.message.includes("RESULT_"));
    return true;
  });
  assert.deepEqual(chat.workGoal, before);
});

test("candidate diagnostics do not weaken current worker-version checks", () => {
  const { chat, reply } = fixture();
  chat.id = randomUUID();
  const version = { schema:"pkm.chat.worker-version/v1", managerChatId:chat.id, managerNamespace:"a".repeat(16),
    chatId:randomUUID(), namespace:"b".repeat(16), receiptId:randomUUID(), activityId:randomUUID(),
    attemptId:randomUUID(), messageId:randomUUID(), status:"complete", sha256:digest };
  reply.toolCalls.push({ id:"worker-evidence", name:"read_chat_result", arguments:"{}", status:"complete",
    result:JSON.stringify({ workerVersion:version }) });
  const before = structuredClone(chat.workGoal);
  assert.throws(() => reportWork(chat, reply, report(chat, { acceptance:[
    { criterion:rootWorkCriterion, verified:true, evidenceCallIds:["worker-evidence"] },
  ] }), () => ({ ...version, sha256:"c".repeat(64) })), /Worker evidence is stale/);
  assert.deepEqual(chat.workGoal, before);
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
  assert(workGoalContext(chat).includes("the first report can be the final resolved/blocked/needs_input report"));
  assert(workGoalContext(chat).includes("call session_info only when current evidence identities or changed requirements are missing"));
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

test("explicit project, agent and Board item commands are not Chat Goal stop commands", () => {
  const { workStop } = require("../dist/chat/chat-work-goal");
  for (const text of ["Pause the project.", "Pause the agent.", "Pause the work item.", "暂停项目。", "暂停 agent。", "暂停 Work Item。"])
    assert.equal(workStop.test(text), false, text);
  for (const text of ["Stop.", "Pause the current task.", "暂停当前任务。"])
    assert.equal(workStop.test(text), true, text);
});

test("Chat Goal pause is scoped and retains prior evidence until explicit same-context resume", () => {
  const { chat, reply } = fixture();
  const goalId = chat.workGoal.id, originalInputId = chat.workGoal.inputId;
  const priorReplyEvidence = structuredClone(reply);
  const pauseId = randomUUID();
  prepareWorkGoal(chat, pauseId, "Stop.", digest);
  assert.equal(chat.workGoal.status, "paused");
  assert.equal(chat.workGoal.id, goalId);
  assert.equal(chat.workGoal.inputId, originalInputId);
  assert.equal(chat.workGoal.transitions.at(-1).inputId, pauseId);
  assert.equal(chat.workGoal.transitions.at(-1).reason, "user_paused");
  assert.deepEqual(reply, priorReplyEvidence);
  prepareWorkGoal(chat, randomUUID(), "Here is a log.", digest);
  assert.equal(chat.workGoal.status, "paused");
  assert.throws(() => prepareWorkGoal(chat, randomUUID(), "Continue.", "b".repeat(64)), /another execution context/);
  assert.equal(chat.workGoal.status, "paused");
  prepareWorkGoal(chat, randomUUID(), "Continue.", digest);
  assert.equal(chat.workGoal.status, "active");
  assert.equal(chat.workGoal.id, goalId);
  assert.deepEqual(reply, priorReplyEvidence);
});

test("a failed read-only request does not block explicit same-context Goal continuation", () => {
  const { chat, reply } = fixture();
  reply.toolCalls = [{ id:"invalid-range", name:"read_file", arguments:'{"path":"fixture.txt","startLine":95,"endLine":170}',
    status:"failed", result:'{"error":"Start line 95 exceeds the document\'s 90 lines."}' }];
  const evidence = structuredClone(reply.toolCalls);
  prepareWorkGoal(chat, randomUUID(), "Stop.", digest);
  prepareWorkGoal(chat, randomUUID(), "Continue.", digest);
  assert.equal(chat.workGoal.status, "active");
  assert.equal(chat.workGoal.transitions.at(-1).reason, "user_resumed");
  assert.deepEqual(reply.toolCalls, evidence);
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
