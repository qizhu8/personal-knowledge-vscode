const { test } = require("node:test");
const assert = require("node:assert/strict");
const { activeHarnessBinding, assertHarnessRecipeBinding, validateHarnessReport, createHarnessReportTool, currentHarnessTask, currentHarnessTaskState } = require("../dist/chat/chat-harness-records");
const { build } = require("../src/webview/agent-harness");
const { ApiChatStore, apiChatHarnessSnapshot } = require("../dist/chat/api-chat-store");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { createHash } = require("node:crypto");
const { materializeRetrievalSource } = require("../dist/retrieval/retrieval-snapshot");

function fixture() {
  const reply = { id:"reply", role:"assistant", taskId:"task", content:"", status:"streaming",
    progress:{ attemptId:"attempt", status:"running", startedAt:1, model:"fixture", steps:[] },
    toolCalls:[{ id:"test-call", name:"test", arguments:"{}", result:"failure", status:"failed" }] };
  return { chat:{ sessionId:"task", messages:[{ id:"input", role:"user", taskId:"task", status:"complete", content:"Do not deploy." }, reply] }, reply };
}
function commit(chat, reply, args) {
  const report = validateHarnessReport(chat, reply, args);
  (reply.harnessReports ||= []).push(report);
  return report;
}

test("task goal/constraints use actual source input identities, supersede explicitly and survive failed replies", () => {
  const { chat, reply } = fixture();
  const initial = commit(chat, reply, { kind:"task", goal:"Fix tests", constraints:["Do not deploy"], acceptance:["Tests pass"], openQuestions:["Why failing?"], sourceInputIds:["input"] });
  const update = commit(chat, reply, { kind:"task", goal:"Investigate only", constraints:["Do not deploy"], sourceInputIds:["input"], supersedes:initial.id });
  assert.equal(currentHarnessTask(chat).id, update.id);
  reply.status = "failed";
  assert.equal(currentHarnessTask(chat).goal, "Investigate only");
  assert.equal(currentHarnessTask({ ...chat, sessionId:"another-task" }), undefined);
  assert.throws(() => commit(chat, reply, { kind:"task", goal:"x", sourceInputIds:["unknown"] }), /user input/);
  assert.throws(() => commit(chat, reply, { kind:"task", goal:"x", sourceInputIds:["input"], supersedes:"unknown" }), /earlier report/);
});

test("planning is a public explicit report, validates recursive parents and rejects cycles without modifying history", () => {
  const { chat, reply } = fixture();
  const plan = commit(chat, reply, { kind:"planning", possibilities:[{ id:"a", label:"Inspect", status:"selected" }, { id:"b", parentId:"a", label:"Tests", status:"candidate" }] });
  assert.equal(plan.source, "agent-report");
  assert.equal(plan.planning.possibilities[1].parentId, "a");
  const before = JSON.stringify(chat);
  assert.throws(() => commit(chat, reply, { kind:"planning", possibilities:[{ id:"a", parentId:"b", label:"A", status:"selected" }, { id:"b", parentId:"a", label:"B", status:"candidate" }] }), /cycle/);
  assert.throws(() => commit(chat, reply, { kind:"planning", recipeRunId:"recipe_run_test", possibilities:[] }), /together/);
  assert.equal(JSON.stringify(chat), before);
  assert.equal(commit(chat, reply, { kind:"planning", possibilities:[] }).planning.possibilities.length, 0);
});

test("task updates cannot replace a newer report from a stale base or ignore the latest user change", () => {
  const { chat, reply } = fixture();
  const initial = commit(chat, reply, { kind:"task", goal:"Inspect", sourceInputIds:["input"] });
  chat.messages.push({ id:"steer", role:"user", taskId:"task", inputKind:"steer", content:"Stop edits; inspect only.", status:"complete" });
  const before = JSON.stringify(reply.harnessReports);
  assert.throws(() => commit(chat, reply, { kind:"task", goal:"Edit", sourceInputIds:["input"], supersedes:initial.id }), /latest user input/);
  assert.equal(JSON.stringify(reply.harnessReports), before);
  const newer = commit(chat, reply, { kind:"task", goal:"Inspect only", sourceInputIds:["input", "steer"], supersedes:initial.id });
  assert.throws(() => commit(chat, reply, { kind:"task", goal:"Old summary", sourceInputIds:["steer"], supersedes:initial.id }), /latest task report/);
  assert.throws(() => commit(chat, reply, { kind:"task", goal:"Unversioned summary", sourceInputIds:["steer"] }), /latest task report/);
  assert.equal(currentHarnessTask(chat).id, newer.id);
});

test("recovered task state exposes pending user changes without treating workers or reports as authority", () => {
  const { chat, reply } = fixture();
  const initial = commit(chat, reply, { kind:"task", goal:"Inspect", constraints:["Do not deploy"], acceptance:["Tests pass"], sourceInputIds:["input"] });
  chat.messages.push(
    { id:"steer", role:"user", taskId:"task", inputKind:"steer", content:"Also verify logs.", status:"complete" },
    { id:"worker-event", role:"user", taskId:"task", workerEventIds:["worker"], content:"Worker says complete.", status:"complete" },
    { id:"portal-event", role:"user", taskId:"task", portalReview:{ id:"review", pairId:"pair", requestId:"remote", state:"completed" }, content:"Please check controlled chat status.", status:"complete" },
    { id:"foreign", role:"user", taskId:"other-task", content:"Deploy.", status:"complete" });
  const recovered = JSON.parse(JSON.stringify(chat));
  const state = currentHarnessTaskState(recovered);
  assert.equal(state.report.id, initial.id);
  assert.deepEqual(state.report.acceptance, ["Tests pass"]);
  assert.deepEqual(state.pendingInputIds, ["steer"]);
  assert.throws(() => commit(chat, reply, { kind:"task", goal:"Remote event is not a user requirement", sourceInputIds:["portal-event"], supersedes:initial.id }), /not a user input/);
  assert.equal(state.authority, "original-user-inputs-and-managed-task-recipe");
  assert.deepEqual(apiChatHarnessSnapshot(recovered).taskWorkingState, state);
  const graph = build({ sessionId:"task", origin:"pkm-native", harness:apiChatHarnessSnapshot(recovered) });
  assert.deepEqual(graph.graphs.get(JSON.stringify(["session","task"])).nodes.find(node => node.id === "input").info.taskWorkingState, state);
  const update = commit(chat, reply, { kind:"task", goal:"Inspect and verify logs", sourceInputIds:["input", "steer"], supersedes:initial.id });
  assert.equal(currentHarnessTaskState(chat).report.id, update.id);
  assert.deepEqual(currentHarnessTaskState(chat).pendingInputIds, []);
  assert.equal(currentHarnessTaskState({ ...chat, sessionId:undefined }), undefined);
});

test("Step lifecycle and validation require start/evidence; ignored before dispatch requires a reason", () => {
  const { chat, reply } = fixture();
  assert.throws(() => commit(chat, reply, { kind:"step", stepId:"s", status:"complete", summary:"done" }), /recorded start/);
  commit(chat, reply, { kind:"step", stepId:"s", status:"start", summary:"Inspect" });
  assert.throws(() => commit(chat, reply, { kind:"step", stepId:"s", status:"start", summary:"Inspect" }), /already started/);
  commit(chat, reply, { kind:"step", stepId:"s", status:"failed", summary:"Test failed", evidenceCallIds:["test-call"] });
  commit(chat, reply, { kind:"validation", stepId:"v", status:"start", summary:"Run tests" });
  assert.throws(() => commit(chat, reply, { kind:"validation", stepId:"v", status:"complete", summary:"done" }), /evidenceCallIds/);
  commit(chat, reply, { kind:"validation", stepId:"v", status:"failed", summary:"Tests failed", evidenceCallIds:["test-call"] });
  assert.throws(() => commit(chat, reply, { kind:"step", stepId:"skip", status:"ignored", summary:"Skip" }), /reason/);
  commit(chat, reply, { kind:"step", stepId:"skip", status:"ignored", summary:"No deployment", reason:"User explicitly prohibited deployment" });
  assert.equal(chat.sessionId, "task", "reports do not mutate task lifecycle authority");
});

test("report writer commits exactly once, respects cancellation and reports persist into native subgraphs", async () => {
  const { chat, reply } = fixture();
  const tool = createHarnessReportTool(chat, reply, report => (reply.harnessReports ||= []).push(report));
  await tool.execute({ kind:"step", stepId:"debug", status:"start", summary:"Debug" }, new AbortController().signal);
  await tool.execute({ kind:"step", stepId:"debug", status:"failed", summary:"Debug failed", evidenceCallIds:["test-call"] }, new AbortController().signal);
  assert.equal(reply.harnessReports.length, 2);
  const cancelled = new AbortController(); cancelled.abort();
  await assert.rejects(tool.execute({ kind:"planning", possibilities:[] }, cancelled.signal), /cancelled/);
  reply.toolCalls[0].harnessBinding = { stepId:"debug" };
  const snapshot = apiChatHarnessSnapshot({ ...chat, id:"fixture" });
  const graph = build({ sessionId:"task", origin:"pkm-native", harness:snapshot });
  const reported = graph.graphs.get(JSON.stringify(["reported-step","reply","debug"]));
  assert(reported.nodes.some(node => node.title === "test"), "actual recorded call is nested under its reported Step");
  assert.equal(graph.graphs.get(JSON.stringify(["chat-attempt","reply"])).nodes.find(node => node.kind === "Step (agent report)").status, "failed");
});

test("validation evidence rejects ambiguous, unavailable, foreign and duplicate calls without changing reports", () => {
  const { chat, reply } = fixture();
  commit(chat, reply, { kind:"validation", stepId:"check", status:"start", summary:"Check acceptance" });
  const before = JSON.stringify(reply.harnessReports);
  const outcome = { kind:"validation", stepId:"check", status:"complete", summary:"Accepted", evidenceCallIds:["test-call"] };
  assert.throws(() => commit(chat, reply, outcome), /failed tool evidence requires an explicit reason/);
  assert.throws(() => commit(chat, reply, { ...outcome, evidenceCallIds:["test-call","test-call"] }), /must not be duplicated/);
  chat.messages.unshift({ id:"old", role:"assistant", taskId:"task", status:"failed", content:"",
    toolCalls:[{ ...reply.toolCalls[0] }] });
  assert.throws(() => commit(chat, reply, { ...outcome, reason:"Expected negative test" }), /ambiguous/);
  chat.messages.shift();
  delete reply.toolCalls[0].result;
  assert.throws(() => commit(chat, reply, { ...outcome, reason:"Expected negative test" }), /available result/);
  reply.toolCalls[0].result = "failure";
  reply.toolCalls[0].status = "running";
  assert.throws(() => commit(chat, reply, outcome), /terminal recorded call/);
  reply.toolCalls[0].status = "failed";
  chat.messages.unshift({ id:"foreign", role:"assistant", taskId:"another-task", content:"",
    toolCalls:[{ id:"foreign-call", status:"complete", result:"private" }] });
  assert.throws(() => commit(chat, reply, { ...outcome, evidenceCallIds:["foreign-call"] }), /in this task/);
  assert.equal(JSON.stringify(reply.harnessReports), before);
  const accepted = commit(chat, reply, { ...outcome, reason:"Expected negative test: prohibited operation must fail." });
  assert.equal(accepted.status, "complete", "Expected negative tests remain valid, explicitly explained observations");
  assert.equal(accepted.source, "agent-report");
  assert.equal(chat.sessionId, "task", "Validation does not complete the managed Task");
});

test("validation can report semantic failure despite successful dispatch and retain failed retry evidence", () => {
  const { chat, reply } = fixture();
  reply.toolCalls.push({ id:"successful-call", name:"read_result", arguments:"{}", status:"complete", result:"Tests: 1 failed" });
  commit(chat, reply, { kind:"validation", stepId:"check", status:"start", summary:"Read test outcome" });
  commit(chat, reply, { kind:"validation", stepId:"check", status:"failed", summary:"Tests failed despite successful read", evidenceCallIds:["successful-call"] });
  commit(chat, reply, { kind:"validation", stepId:"check", status:"start", summary:"Validate retry" });
  assert.throws(() => commit(chat, reply, { kind:"validation", stepId:"check", status:"complete",
    summary:"Retry accepted", evidenceCallIds:["test-call","successful-call"] }), /explicit reason/);
  commit(chat, reply, { kind:"validation", stepId:"check", status:"complete", summary:"Retry accepted",
    evidenceCallIds:["test-call","successful-call"], reason:"First failure retained for comparison; retry was checked separately." });
  assert.deepEqual(reply.harnessReports.map(report => report.status), ["start","failed","start","complete"]);
  assert.equal(reply.toolCalls[0].status, "failed");
});

test("nested Steps retain ownership and distinct retries; finishing a child restores its active parent", () => {
  const { chat, reply } = fixture();
  commit(chat, reply, { kind:"step", stepId:"root", summary:"Root Step", status:"start" });
  const first = commit(chat, reply, { kind:"step", stepId:"child", parentStepId:"root", summary:"Child Step", status:"start" });
  assert.equal(activeHarnessBinding(reply).stepAttemptId, first.id);
  assert.throws(() => commit(chat, reply, { kind:"step", stepId:"root", summary:"Root Step", status:"complete" }), /running child/);
  reply.toolCalls[0].harnessBinding = { ...activeHarnessBinding(reply) };
  commit(chat, reply, { kind:"step", stepId:"child", summary:"Child Step", status:"failed" });
  assert.equal(activeHarnessBinding(reply).stepId, "root");
  const retry = commit(chat, reply, { kind:"step", stepId:"child", summary:"Child Step", status:"start" });
  assert.equal(retry.binding.parentStepId, "root");
  assert.notEqual(retry.binding.stepAttemptId, first.binding.stepAttemptId);
  commit(chat, reply, { kind:"step", stepId:"child", summary:"Child Step", status:"complete" });
  assert.equal(activeHarnessBinding(reply).stepId, "root");
  const model = build({ sessionId:"task", origin:"pkm-native", harness:apiChatHarnessSnapshot({ ...chat, id:"fixture" }) });
  const root = model.graphs.get(JSON.stringify(["reported-step", "reply", "root"]));
  const child = model.graphs.get(JSON.stringify(["reported-step", "reply", "child"]));
  assert.equal(child.parent, root.id);
  assert(root.nodes.some(node => node.child === child.id));
  assert.equal(child.nodes.find(node => node.title === "Step attempt 1").status, "failed");
  assert.equal(child.nodes.find(node => node.title === "Step attempt 2").status, "complete");
  const firstAttempt = model.graphs.get(JSON.stringify(["step-attempt", "reply", first.id]));
  assert(firstAttempt.nodes.some(node => node.title === "test"), "the failed call remains owned by the failed Step attempt");
  commit(chat, reply, { kind:"step", stepId:"root", summary:"Root Step", status:"complete" });
  assert.equal(activeHarnessBinding(reply), undefined);
  assert.throws(() => commit(chat, reply, { kind:"step", stepId:"new-child", parentStepId:"root", summary:"Child", status:"start" }), /running/);
});

test("L1 materialization returns the complete source, including tail evidence, or explicitly refuses the boundary", () => {
  const body = "prefix".repeat(900) + "\nTAIL: no deployment; test failed.";
  const result = materializeRetrievalSource({ body, visibility:"available" });
  assert.equal(result.content, body);
  assert(result.content.endsWith("test failed."));
  assert.equal(materializeRetrievalSource({ body:"x".repeat(160000), visibility:"available" }).content.length, 160000);
  const oversized = materializeRetrievalSource({ body:"x".repeat(160001), visibility:"available" });
  assert.equal(oversized.content, undefined);
  assert.match(oversized.reason, /No prefix/);
  assert.equal(materializeRetrievalSource({ body, visibility:"private" }).content, undefined);
});

test("Recipe binding verifies pinned Stage and actual Session/parent ownership, not agent claims", () => {
  const runs = {
    recipe_run_root:{ schema:"pkm.recipe.run/v1", runId:"recipe_run_root", definition:{ spec:{ nodes:[{ nodeId:"step" }] } }, nodes:{ step:{ childRunId:"recipe_run_child" } } },
    recipe_run_child:{ schema:"pkm.recipe.run/v1", runId:"recipe_run_child", definition:{ spec:{ nodes:[{ nodeId:"child-step" }] } }, parent:{ runId:"recipe_run_root", nodeId:"step" } },
  };
  const session = { recipeRunIds:["recipe_run_root"] };
  const read = id => runs[id];
  assertHarnessRecipeBinding({ recipeRunId:"recipe_run_child", recipeStageId:"child-step" }, session, read);
  assert.throws(() => assertHarnessRecipeBinding({ recipeRunId:"recipe_run_root", recipeStageId:"unknown" }, session, read), /pinned Run/);
  assert.throws(() => assertHarnessRecipeBinding({ recipeRunId:"recipe_run_root", recipeStageId:"step" }, { recipeRunIds:[] }, read), /not owned/);
  delete runs.recipe_run_root.nodes.step.childRunId;
  assert.throws(() => assertHarnessRecipeBinding({ recipeRunId:"recipe_run_child", recipeStageId:"child-step" }, session, read), /parent/);
});

test("native Chat binds only an original locally recorded Recipe creation in its current Task", t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pkm-recipe-binding-"));
  t.after(() => fs.rmSync(root, { recursive:true, force:true }));
  const store = new ApiChatStore(root, "0123456789abcdef");
  const chat = store.create();
  store.startTask(chat, "Original Recipe ownership");
  const command = "original-create";
  const id = `recipe_run_${createHash("sha256").update(command).digest("hex").slice(0, 24)}`;
  const childId = "recipe_run_nested";
  const filename = path.join(root, "recipe-runs", `${id}.json`);
  fs.mkdirSync(path.dirname(filename), { recursive:true });
  const run = { schema:"pkm.recipe.run/v1", runId:id, definition:{ spec:{ nodes:[{ nodeId:"nested" }] } },
    nodes:{ nested:{ childRunId:childId } }, receipts:{ [command]:{ response:JSON.stringify({ ok:true, run_id:id }) } } };
  fs.writeFileSync(filename, JSON.stringify(run));
  fs.writeFileSync(path.join(root, "recipe-runs", `${childId}.json`), JSON.stringify({
    schema:"pkm.recipe.run/v1", runId:childId, parent:{ runId:id, nodeId:"nested" },
    definition:{ spec:{ nodes:[{ nodeId:"execute" }] } },
  }));
  const binding = { recipeRunId:childId, recipeStageId:"execute" };
  const sessionPath = path.join(root, "agent-sessions", `${chat.sessionId}.json`);
  const before = fs.readFileSync(sessionPath, "utf8");
  const call = { id:"create", name:"name-is-not-authority", status:"complete", arguments:JSON.stringify({ command_id:command }),
    result:JSON.stringify({ structuredContent:{ ok:true, run_id:id } }) };
  const reply = { id:"reply", role:"assistant", content:"", status:"streaming", taskId:chat.sessionId, toolCalls:[call] };
  chat.messages.push(reply);
  const reject = () => {
    assert.throws(() => store.bindRecordedRecipe(chat, binding), /original creation receipt|parent/);
    assert.equal(fs.readFileSync(sessionPath, "utf8"), before, "rejected attachment cannot change ownership");
  };
  call.status = "running"; reject(); call.status = "complete";
  reply.taskId = "another-task"; reject(); reply.taskId = chat.sessionId;
  for (const result of ["null", "{malformed", JSON.stringify({ content:[null, { type:"text", text:"null" }] })]) {
    call.result = result; reject();
  }
  call.result = JSON.stringify({ ok:true, run_id:id, replayed:true }); reject();
  call.result = JSON.stringify({ content:[{ type:"text", text:JSON.stringify({ ok:true, run_id:id }) }] });
  delete run.receipts[command]; fs.writeFileSync(filename, JSON.stringify(run)); reject();
  run.receipts[command] = { response:JSON.stringify({ ok:true, run_id:id }) };
  delete run.nodes.nested.childRunId; fs.writeFileSync(filename, JSON.stringify(run)); reject();
  run.nodes.nested.childRunId = childId; fs.writeFileSync(filename, JSON.stringify(run));
  assert.throws(() => store.bindRecordedRecipe(chat, { ...binding, recipeStageId:"foreign-stage" }), /pinned Run/);
  assert.equal(fs.readFileSync(sessionPath, "utf8"), before);
  const session = JSON.parse(before);
  for (const field of ["schema", "sessionId", "hostSessionId"]) {
    const invalid = JSON.stringify({ ...session, [field]:"foreign" });
    fs.writeFileSync(sessionPath, invalid);
    assert.throws(() => store.bindRecordedRecipe(chat, binding), /authority is unavailable/);
    assert.equal(fs.readFileSync(sessionPath, "utf8"), invalid);
  }
  for (const result of [{ ok:true, run_id:id }, { structuredContent:{ ok:true, run_id:id } },
    { content:[{ type:"text", text:JSON.stringify({ ok:true, run_id:id }) }] }]) {
    fs.writeFileSync(sessionPath, before);
    call.result = JSON.stringify(result);
    store.bindRecordedRecipe(chat, binding);
    store.bindRecordedRecipe(chat, binding);
    assert.deepEqual(JSON.parse(fs.readFileSync(sessionPath, "utf8")).recipeRunIds, [id]);
  }
  store.save(chat);
  assert.deepEqual(JSON.parse(fs.readFileSync(sessionPath, "utf8")).recipeRunIds, [id], "normal Chat persistence preserves proven ownership");
});

test("snapshot exposes the recalled-memory receipt and retrieval timing for the Visualization window, not internal prepare state", () => {
  const { chat, reply } = fixture();
  reply.profileContext = {schema:"pkm.chat.profiles/v1",messageHash:"recorded-profile",user:{name:"Saved card",revision:2}};
  reply.memory = { schema:"pkm.chat.memory/v1", turn:"turn-1", model:"memory-model", durationMs:42,
    blocks:[{ kind:"focus-topic", piece:"topic:aml", characters:12 }], prepare:{ internal:true } };
  const receipt = { schema:"pkm.chat.retrieval/v1", query:"aml", selectedCount:1, model:"m", phase:"sent", candidates:[{ id:"n", label:"Note", selected:true }] };
  reply.retrievalActivity = { attempts:[{ kind:"lexical", at:5, durationMs:3, receipt }], rounds:[{ index:2, at:9, inputTokens:10, inputBudget:20, receipt }] };
  const [attempt] = apiChatHarnessSnapshot({ ...chat, id:"fixture" }).attempts;
  assert.deepEqual(attempt.profileContext,reply.profileContext,"historical Profile snapshot is exposed without rereading today's editable card");
  assert.deepEqual(attempt.memory, { turn:"turn-1", model:"memory-model", durationMs:42, error:undefined,
    blocks:[{ kind:"focus-topic", piece:"topic:aml", characters:12 }] });
  assert.deepEqual(attempt.retrieval.map(step => [step.kind, step.at, step.receipt.model, step.receipt.phase]),
    [["lexical-recall", 5, "m", "sent"], ["sent-round", 9, "m", "sent"]]);
  assert.equal(attempt.retrieval[1].round, 2, "the sent receipt names the model round it was transmitted in");
  attempt.memory.blocks[0].kind = "mutated";
  assert.equal(reply.memory.blocks[0].kind, "focus-topic", "snapshot copies, never aliases, the stored receipt");
  delete reply.memory;
  assert.equal(apiChatHarnessSnapshot({ ...chat, id:"fixture" }).attempts[0].memory, undefined);
});
