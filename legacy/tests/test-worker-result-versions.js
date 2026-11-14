const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs"), os = require("node:os"), path = require("node:path");
const { randomUUID } = require("node:crypto");
const { ApiChatStore, apiChatHarnessSnapshot, apiChatSessionHarnessSnapshot, verifyHarnessArtifacts } = require("../dist/chat/api-chat-store");
const { workerResultVersion, readWorkerResultVersion, workerEvidenceState, assertCurrentWorkerEvidence } = require("../dist/chat/worker-result-versions");
const { createHarnessReportTool } = require("../dist/chat/chat-harness-records");
const { prepareWorkGoal, reportWork, workGoalInputs, rootWorkCriterion } = require("../dist/chat/chat-work-goal");
const { build } = require("../src/webview/agent-harness");
const fixtures = require("./fixtures/chat-context");

function fixture(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "pkm-worker-version-"));
  t.after(() => fs.rmSync(directory, { recursive:true, force:true }));
  const state = path.join(directory, ".pkm", "state"), store = new ApiChatStore(state, fixtures.namespace);
  const manager = fixtures.conversation();
  store.save(manager); store.startTask(manager, "Worker evidence acceptance");
  const sessionId = manager.sessionId;
  const input = { id:randomUUID(), role:"user", taskId:sessionId, status:"complete", content:"Validate worker evidence" };
  const reply = { id:randomUUID(), role:"assistant", taskId:sessionId, inputId:input.id, content:"Accepted worker",
    status:"streaming", progress:{ attemptId:randomUUID(), status:"running", startedAt:1, model:"fixture", steps:[] }, toolCalls:[] };
  manager.messages = [input, reply];
  const receiptId = randomUUID(), attemptId = randomUUID(), activityId = randomUUID();
  const worker = fixtures.conversation({
    workerActivity:{ id:activityId, receiptId, attemptId, managerChatId:manager.id, treeId:randomUUID(), temporary:false, state:"completed" },
    progress:{ attemptId, status:"complete", startedAt:1, model:"fixture", steps:[] },
    messages:[{ id:randomUUID(), role:"assistant", content:"Worker version one", status:"complete",
      progress:{ attemptId, status:"complete", startedAt:1, model:"fixture", steps:[] } }],
  });
  const record = { id:receiptId, chatId:worker.id, chatUrl:`pkm://chats/${fixtures.namespace}/${worker.id}`,
    activityId, attemptId, temporary:false, status:"complete" };
  reply.delegations = [record];
  store.save(worker); store.save(manager);
  const read = version => readWorkerResultVersion(state, version);
  const readCall = () => {
    const version = workerResultVersion(manager, record, worker);
    const call = { id:randomUUID(), name:"read_chat_result", arguments:JSON.stringify({ receiptId }),
      result:JSON.stringify({ ...record, workerVersion:version, answer:worker.messages.at(-1).content }), status:"complete" };
    reply.toolCalls.push(call); return call;
  };
  const tool = createHarnessReportTool(manager, reply, report => {
    (reply.harnessReports ||= []).push(report); store.save(manager);
  }, undefined, calls => assertCurrentWorkerEvidence(calls, manager.id, read));
  const report = (status, ids) => tool.execute({ kind:"validation", stepId:"worker-check", status,
    summary:"Worker evidence checked", ...(ids ? { evidenceCallIds:ids } : {}) }, new AbortController().signal);
  const snapshot = () => verifyHarnessArtifacts(apiChatHarnessSnapshot(manager), [], undefined, state);
  return { directory, state, store, manager, worker, reply, record, read, readCall, report, snapshot };
}

function addDescendant(f, manager, depth = 1) {
  const attemptId = randomUUID(), receiptId = randomUUID(), activityId = randomUUID();
  const worker = fixtures.conversation({
    workerActivity:{ id:activityId, receiptId, attemptId, managerChatId:manager.id, treeId:randomUUID(), temporary:false, state:"completed" },
    progress:{ attemptId, status:"complete", startedAt:1, model:"fixture", steps:[] },
    messages:[{ id:randomUUID(), role:"assistant", content:`Descendant ${depth}`, status:"complete",
      progress:{ attemptId, status:"complete", startedAt:1, model:"fixture", steps:[] } }],
  });
  const record = { id:receiptId, chatId:worker.id, chatUrl:`pkm://chats/${fixtures.namespace}/${worker.id}`,
    activityId, attemptId, temporary:false, status:"complete" };
  const reply = manager.messages.at(-1);
  (reply.delegations ||= []).push(record);
  f.store.save(worker); f.store.save(manager);
  const cite = () => {
    const call = { id:randomUUID(), name:"read_chat_result", arguments:JSON.stringify({ receiptId }),
      result:JSON.stringify({ workerVersion:workerResultVersion(manager, record, worker) }), status:"complete" };
    (reply.toolCalls ||= []).push(call);
    (reply.harnessReports ||= []).push({ schema:"pkm.chat.harness-report/v1", id:randomUUID(), at:Date.now(),
      attemptId:reply.progress.attemptId, source:"agent-report", kind:"validation", binding:{ stepId:"descendant" },
      status:"complete", summary:"Descendant checked", evidenceCallIds:[call.id] });
    f.store.save(manager);
  };
  cite();
  return { worker, record, cite };
}

test("grandchild changes invalidate ancestor validation despite unchanged intermediate result bytes", async t => {
  const f = fixture(t), child = addDescendant(f, f.worker);
  const call = f.readCall();
  await f.report("start"); await f.report("complete", [call.id]);
  const original = JSON.stringify(f.worker.messages);
  child.worker.messages[0].content += " changed"; f.store.save(child.worker);
  assert.notEqual(workerEvidenceState([call], f.manager.id, f.read).status, "unchanged");
  assert.equal(JSON.stringify(f.worker.messages), original);
  assert.notEqual((await f.snapshot()).attempts.at(-1).validation.workerState.status, "unchanged");
  await f.report("start");
  await assert.rejects(f.report("complete", [call.id]), /Worker evidence/);
  const refreshedParentOnly = f.readCall();
  await assert.rejects(f.report("complete", [refreshedParentOnly.id]), /Worker evidence/,
    "rereading an unchanged intermediate result cannot repair its obsolete descendant evidence");
  child.cite();
  const fresh = f.readCall(); await f.report("complete", [fresh.id]);
  assert.equal((await f.snapshot()).attempts.at(-1).validation.workerState.status, "unchanged");
});

test("archived intermediate managers preserve descendant ownership and still detect live grandchild changes", t => {
  const f = fixture(t), child = addDescendant(f, f.worker);
  f.worker.workerActivity.temporary = true; f.record.temporary = true;
  f.store.save(f.worker); f.store.save(f.manager);
  const call = f.readCall();
  f.store.archiveWorker(f.worker, f.record); f.record.archived = true; f.store.save(f.manager);
  assert.equal(workerEvidenceState([call], f.manager.id, f.read).status, "unchanged");
  child.worker.messages[0].content += " changed"; f.store.save(child.worker);
  const state = workerEvidenceState([call], f.manager.id, f.read);
  assert.equal(state.status, "unavailable");
  assert.match(state.workers[0].reason, /descendant.*stale/);
});

test("descendant attempt changes propagate through verified work-goal evidence to ancestor report_work", t => {
  const f = fixture(t), child = addDescendant(f, f.worker);
  const response = f.worker.messages[0], evidenceId = response.toolCalls[0].id;
  response.inputId = randomUUID();
  prepareWorkGoal(f.worker, response.inputId, "Please fix the assigned work.", "b".repeat(64));
  f.worker.workGoal.acceptance = [{ criterion:rootWorkCriterion, verified:true, evidenceCallIds:[evidenceId] }];
  response.harnessReports = [];
  f.store.save(f.worker);
  const call = f.readCall();
  assert.equal(workerEvidenceState([call], f.manager.id, f.read).status, "unchanged");
  prepareWorkGoal(f.manager, f.reply.inputId, "Please fix the original task.", "a".repeat(64));
  const attemptId = randomUUID();
  child.worker.workerActivity.attemptId = attemptId; child.worker.workerActivity.state = "running";
  child.worker.progress = { ...child.worker.progress, attemptId, status:"running" };
  child.worker.messages.push({ id:randomUUID(), role:"assistant", content:"New attempt", status:"streaming",
    progress:{ ...child.worker.progress } });
  f.store.save(child.worker);
  const before = JSON.stringify(f.manager.workGoal);
  assert.throws(() => reportWork(f.manager, f.reply, { status:"resolved", reason:"Old chain accepted",
    sourceInputIds:workGoalInputs(f.manager),
    acceptance:[{ criterion:rootWorkCriterion, verified:true, evidenceCallIds:[call.id] }] }, f.read), /descendant.*stale/);
  assert.equal(JSON.stringify(f.manager.workGoal), before);
  f.worker.workGoal.acceptance[0].verified = false;
  f.worker.workGoal.acceptance[0].evidenceCallIds = [];
  f.store.save(f.worker);
  assert.equal(workerEvidenceState([call], f.manager.id, f.read).status, "stale",
    "removing a work-goal dependency changes the response version; it cannot silently repair an old parent read");
});

test("recursive checks reject missing, unversioned, foreign and failed descendants but ignore uncited historical reads", t => {
  for (const kind of ["missing", "legacy", "foreign", "failed", "uncited"]) {
    const f = fixture(t), child = addDescendant(f, f.worker);
    const response = f.worker.messages[0], read = response.toolCalls[0];
    if (kind === "legacy") read.result = "{}";
    if (kind === "foreign") {
      const result = JSON.parse(read.result);
      result.workerVersion.managerChatId = randomUUID(); read.result = JSON.stringify(result);
    }
    if (kind === "failed") {
      child.worker.workerActivity.state = "failed"; f.store.save(child.worker);
    }
    if (kind === "uncited") {
      read.result = "{}"; response.harnessReports = [];
    }
    f.store.save(f.worker);
    if (kind === "missing") fs.unlinkSync(path.join(f.state, "api-chats", fixtures.namespace, `${child.worker.id}.json`));
    const call = f.readCall(), state = workerEvidenceState([call], f.manager.id, f.read);
    assert.equal(state.status, kind === "uncited" ? "unchanged" : "unavailable", kind);
    if (kind !== "uncited") assert.match(state.workers[0].reason, /descendant/);
  }
});

test("recursive graph depth and total-result limits fail closed without truncating acceptance", t => {
  const f = fixture(t);
  let parent = f.worker;
  const nodes = [];
  for (let depth = 1; depth <= 32; depth++) {
    const child = addDescendant(f, parent, depth); nodes.push(child); parent = child.worker;
  }
  // Capture bottom-up so every saved parent cites its child's final result.
  for (let index = nodes.length - 1; index >= 0; index--) nodes[index].cite();
  const call = f.readCall(), state = workerEvidenceState([call], f.manager.id, f.read);
  assert.equal(state.status, "unavailable");
  assert.match(state.workers[0].reason, /32-level verification limit/);
  nodes.at(-2).worker.messages[0].harnessReports = [];
  f.store.save(nodes.at(-2).worker);
  for (let index = nodes.length - 2; index >= 0; index--) nodes[index].cite();
  assert.equal(workerEvidenceState([f.readCall()], f.manager.id, f.read).status, "unchanged",
    "exactly 32 results in a chain are allowed");
  const wide = fixture(t);
  for (let index = 0; index < 255; index++) addDescendant(wide, wide.worker, index);
  const response = wide.worker.messages[0];
  response.harnessReports.at(-1).evidenceCallIds = response.toolCalls.map(call => call.id);
  wide.store.save(wide.worker);
  assert.equal(workerEvidenceState([wide.readCall()], wide.manager.id, wide.read).status, "unchanged",
    "exactly 256 results across the graph are allowed");
  addDescendant(wide, wide.worker, 256);
  response.harnessReports.at(-1).evidenceCallIds = response.toolCalls.map(call => call.id);
  wide.store.save(wide.worker);
  const wideState = workerEvidenceState([wide.readCall()], wide.manager.id, wide.read);
  assert.equal(wideState.status, "unavailable");
  assert.match(wideState.workers[0].reason, /256-result verification limit/);
});

test("recursive shared descendants are not cycles, while cyclic evidence is explicitly rejected", t => {
  const f = fixture(t), child = addDescendant(f, f.worker);
  const shared = f.worker.messages[0].toolCalls[0];
  f.worker.messages[0].toolCalls.push({ ...shared, id:randomUUID() });
  f.worker.messages[0].harnessReports.at(-1).evidenceCallIds = f.worker.messages[0].toolCalls.map(call => call.id);
  f.store.save(f.worker);
  assert.equal(workerEvidenceState([f.readCall()], f.manager.id, f.read).status, "unchanged");

  const backRecord = { ...f.record, id:randomUUID() };
  backRecord.chatId = f.worker.id;
  child.worker.messages[0].delegations = [backRecord];
  const back = workerResultVersion(child.worker, backRecord, { ...f.worker, workerActivity:undefined });
  child.worker.messages[0].toolCalls = [{ id:randomUUID(), name:"read_chat_result", status:"complete", arguments:"{}",
    result:JSON.stringify({ workerVersion:back }) }];
  child.worker.messages[0].harnessReports = [{ kind:"validation", status:"complete", evidenceCallIds:[child.worker.messages[0].toolCalls[0].id] }];
  f.store.save(child.worker);
  // Keep the original child version so the traversal must detect the cycle before claiming acceptance.
  const state = workerEvidenceState([f.readCall()], f.manager.id, f.read);
  assert.equal(state.status, "unavailable");
  assert.match(state.workers[0].reason, /Cyclic worker evidence chain/);
});

test("parent validation binds the Host worker version; changed attempts reject old reads without rewriting history", async t => {
  const f = fixture(t), call = f.readCall();
  await f.report("start");
  await f.report("complete", [call.id]);
  assert.equal((await f.snapshot()).attempts.at(-1).validation.workerState.status, "unchanged");
  const history = JSON.stringify(f.reply.harnessReports), oldCall = call.result;
  const attemptId = randomUUID();
  f.worker.workerActivity.attemptId = attemptId; f.worker.workerActivity.state = "running";
  f.worker.progress = { ...f.worker.progress, attemptId, status:"running" };
  f.worker.messages.push({ id:randomUUID(), role:"assistant", status:"streaming", content:"New partial",
    progress:{ ...f.worker.progress } });
  f.store.save(f.worker);
  assert.equal((await f.snapshot()).attempts.at(-1).validation.workerState.status, "stale");
  await f.report("start");
  const count = f.reply.harnessReports.length;
  await assert.rejects(f.report("complete", [call.id]), /Worker evidence is stale/);
  assert.equal(f.reply.harnessReports.length, count);
  assert.equal(JSON.stringify(f.reply.harnessReports.slice(0, 2)), history);
  assert.equal(call.result, oldCall);
  const pending = f.readCall();
  await assert.rejects(f.report("complete", [pending.id]), /not complete/);
  f.worker.workerActivity.state = "completed"; f.worker.progress.status = "complete";
  Object.assign(f.worker.messages.at(-1), { status:"complete", content:"New completed result" });
  f.worker.messages.at(-1).progress.status = "complete"; f.store.save(f.worker);
  const fresh = f.readCall();
  await f.report("complete", [fresh.id]);
  assert.equal((await f.snapshot()).attempts.at(-1).validation.workerState.status, "unchanged");
});

test("same-attempt result changes and missing/invalid archives fail closed; unrelated permanent Chat work stays scoped", async t => {
  const f = fixture(t), call = f.readCall();
  f.worker.messages[0].content = "Changed bytes in the same attempt"; f.store.save(f.worker);
  assert.equal(workerEvidenceState([call], f.manager.id, f.read).status, "stale");
  const fresh = f.readCall();
  f.worker.workerActivity = { ...f.worker.workerActivity, receiptId:randomUUID(), id:randomUUID(), attemptId:randomUUID(), state:"running" };
  f.worker.progress = { ...f.worker.progress, attemptId:f.worker.workerActivity.attemptId, status:"running" };
  f.worker.messages.push({ id:randomUUID(), role:"assistant", status:"streaming", content:"Unrelated", progress:{ ...f.worker.progress } });
  f.store.save(f.worker);
  assert.equal(workerEvidenceState([fresh], f.manager.id, f.read).status, "unchanged");
  f.record.archived = true; f.store.save(f.manager);
  assert.match(workerEvidenceState([fresh], f.manager.id, f.read).workers[0].reason, /archive is unavailable/);
  const archive = path.join(f.state, "api-chat-worker-results", `${f.record.id}.json`);
  fs.mkdirSync(path.dirname(archive), { recursive:true }); fs.writeFileSync(archive, "{invalid");
  assert.equal(workerEvidenceState([fresh], f.manager.id, f.read).status, "unavailable");
});

test("worker terminal failures and stops invalidate an otherwise unchanged completed response", t => {
  const f = fixture(t), call = f.readCall();
  for (const state of ["failed", "interrupted", "cancelled", "running", "waiting-input"]) {
    f.worker.workerActivity.state = state; f.store.save(f.worker);
    assert.equal(workerEvidenceState([call], f.manager.id, f.read).status, "stale", state);
    const current = f.readCall();
    assert.throws(() => assertCurrentWorkerEvidence([current], f.manager.id, f.read), /not complete/, state);
  }
  f.worker.workerActivity.state = "completed";
  f.worker.progress.status = "cancelled";
  f.store.save(f.worker);
  assert.equal(workerEvidenceState([call], f.manager.id, f.read).status, "stale");
});

test("segmented worker history and immutable archived results retain exact versions across store reload", t => {
  const f = fixture(t);
  f.worker.messages[0].content = "large worker evidence ".repeat(40000);
  f.worker.workerActivity.temporary = true; f.record.temporary = true;
  f.store.save(f.worker); f.store.save(f.manager);
  const call = f.readCall();
  const stored = JSON.parse(fs.readFileSync(path.join(f.state, "api-chats", fixtures.namespace, `${f.worker.id}.json`), "utf8"));
  assert(stored.messageHistory, "exercise the segmented history path");
  assert.equal(workerEvidenceState([call], f.manager.id, f.read).status, "unchanged");
  f.store.archiveWorker(f.worker, f.record); f.record.archived = true; f.store.save(f.manager);
  assert.equal(workerEvidenceState([call], f.manager.id, f.read).status, "unchanged");
  const version = JSON.parse(call.result).workerVersion;
  const archivePath = path.join(f.state, "api-chat-worker-results", `${f.record.id}.json`);
  const archive = JSON.parse(fs.readFileSync(archivePath, "utf8"));
  archive.managerChatId = randomUUID(); fs.writeFileSync(archivePath, JSON.stringify(archive));
  assert.throws(() => readWorkerResultVersion(f.state, version), /Invalid worker evidence archive/);
});

test("snapshot refresh and Chat/Session history reload demote only the projection, then fresh evidence recovers", async t => {
  const f = fixture(t), call = f.readCall();
  await f.report("start"); await f.report("complete", [call.id]);
  f.reply.status = "complete"; f.reply.progress.status = "complete"; f.store.save(f.manager);
  const uninspected = apiChatHarnessSnapshot(f.manager);
  assert.equal(uninspected.attempts.at(-1).validation.workerState.status, "unchecked");
  const session = { sessionId:f.manager.sessionId, origin:"pkm-native", status:"completed", todos:[{ status:"succeeded" }], harness:uninspected };
  assert.equal(build(session).lifecycle.outcome, "unverified");
  session.harness = await f.snapshot();
  assert.equal(build(session).lifecycle.outcome, "complete");
  f.worker.messages[0].content += " changed"; f.store.save(f.worker);
  const reloaded = new ApiChatStore(f.state, fixtures.namespace).load(f.manager.id, false);
  const sessionRecord = JSON.parse(fs.readFileSync(path.join(f.state, "agent-sessions", `${f.manager.sessionId}.json`), "utf8"));
  for (const snapshot of [apiChatHarnessSnapshot(reloaded), apiChatSessionHarnessSnapshot(sessionRecord, f.manager.sessionId, f.state)]) {
    session.harness = await verifyHarnessArtifacts(snapshot, [], undefined, f.state);
    assert.equal(build(session).lifecycle.outcome, "unverified");
    assert.match(build(session).lifecycle.reason, /Worker evidence/);
  }
  assert.equal(session.status, "completed");
  assert.equal(reloaded.messages.at(-1).harnessReports.at(-1).status, "complete");
  assert.equal(reloaded.messages.at(-1).toolCalls[0].result, call.result);
});

test("report_work refuses obsolete worker acceptance and cannot mutate the objective on rejection", t => {
  const f = fixture(t), call = f.readCall();
  prepareWorkGoal(f.manager, f.reply.inputId, "Please fix this using worker evidence.", "a".repeat(64));
  const args = { status:"resolved", reason:"Worker accepted", sourceInputIds:workGoalInputs(f.manager),
    acceptance:[{ criterion:rootWorkCriterion, verified:true, evidenceCallIds:[call.id] }] };
  f.worker.messages[0].content += " edited"; f.store.save(f.worker);
  const before = JSON.stringify(f.manager.workGoal);
  assert.throws(() => reportWork(f.manager, f.reply, args, f.read), /Worker evidence is stale/);
  assert.equal(JSON.stringify(f.manager.workGoal), before);
  const fresh = f.readCall(); args.acceptance[0].evidenceCallIds = [fresh.id];
  reportWork(f.manager, f.reply, args, f.read);
  assert.equal(f.manager.workGoal.status, "resolved");
  f.worker.messages[0].content += " edited again"; f.store.save(f.worker);
  f.store.save(f.manager);
  return f.snapshot().then(snapshot => {
    assert.equal(snapshot.attempts.at(-1).validation.workerState.status, "stale");
    assert.equal(f.manager.workGoal.status, "resolved", "saved report remains historical");
  });
});

test("legacy, malformed, foreign, unfinished and uninspected worker reads cannot certify acceptance", async t => {
  const f = fixture(t), call = f.readCall(), valid = JSON.parse(call.result);
  for (const result of ["{}", "{bad", JSON.stringify({ ...valid, workerVersion:{ ...valid.workerVersion, managerChatId:randomUUID() } }),
    JSON.stringify({ ...valid, workerVersion:{ ...valid.workerVersion, receiptId:"../../elsewhere" } }),
    JSON.stringify({ ...valid, workerVersion:{ ...valid.workerVersion, status:"running" } })]) {
    const evidence = { ...call, result };
    assert.throws(() => assertCurrentWorkerEvidence([evidence], f.manager.id, f.read), /Worker evidence is unavailable/);
  }
  assert.throws(() => assertCurrentWorkerEvidence([call], f.manager.id), /unchecked/);
  assert.throws(() => assertCurrentWorkerEvidence([{ ...call, status:"failed" }], f.manager.id, f.read), /unavailable/);
  assertCurrentWorkerEvidence([{ ...call, name:"read_file", result:"Legacy unrelated evidence" }], f.manager.id);
  const tool = createHarnessReportTool(f.manager, f.reply, report => (f.reply.harnessReports ||= []).push(report));
  await f.report("start");
  await assert.rejects(tool.execute({ kind:"validation", stepId:"worker-check", status:"complete",
    summary:"No Host reader", evidenceCallIds:[call.id] }, new AbortController().signal), /unchecked/);
});

test("production Host report callback and native snapshot reader recheck current worker results", async t => {
  const f = fixture(t), call = f.readCall();
  const ts = require("typescript"), vm = require("node:vm");
  const viewSource = fs.readFileSync(path.join(__dirname, "../src/chat/api-chat-view.ts"), "utf8");
  const ast = ts.createSourceFile("api-chat-view.ts", viewSource, ts.ScriptTarget.Latest, true);
  let verify;
  const visit = node => {
    if (ts.isCallExpression(node) && node.expression.getText(ast) === "createHarnessReportTool") verify = node.arguments[4]?.getText(ast);
    ts.forEachChild(node, visit);
  };
  visit(ast); assert(verify, "Host must wire the current worker evidence gate, not only file capture");
  let assertions = 0;
  const host = { assertCurrentWorkerEvidence, readWorkerResultVersion, path, chat:f.manager, reply:f.reply, executionContext:{},
    getStorePath:() => f.directory, assertRunnable() { assertions++; } };
  vm.runInNewContext(ts.transpileModule(`globalThis.verify = ${verify};`, { compilerOptions:{ target:ts.ScriptTarget.ES2022 } }).outputText, host);
  host.verify([call]); assert.equal(assertions, 1);
  await f.report("start"); await f.report("complete", [call.id]);
  f.reply.status = "complete"; f.reply.progress.status = "complete";
  f.worker.messages[0].content += " updated"; f.store.save(f.worker);
  assert.throws(() => host.verify([call]), /stale/);
  const extension = ts.createSourceFile("extension.ts", fs.readFileSync(path.join(__dirname, "../src/extension.ts"), "utf8"), ts.ScriptTarget.Latest, true);
  const declaration = extension.statements.find(node => node.name?.text === "nativeHarnessRequest");
  const native = { path, verifyHarnessArtifacts, nativeHarnessAccess() {}, getStorePath:() => f.directory,
    currentProjectStore:() => ({ list:() => ({ recipes:[] }) }),
    agentSessionSnapshots:() => [{ harness:apiChatHarnessSnapshot(f.manager) }], readHarnessActions:() => ({}),
    agentSessionJsonCache:{ read() { assert.fail("No Action references expected"); } },
    vscode:{ workspace:{ isTrusted:true, workspaceFolders:[] } } };
  vm.runInNewContext(ts.transpileModule(declaration.getText(extension)
    + "\nglobalThis.request = nativeHarnessRequest;", { compilerOptions:{ target:ts.ScriptTarget.ES2022 } }).outputText, native);
  const snapshot = await native.request("snapshot", { sessionId:f.manager.sessionId });
  assert.equal(snapshot.harness.attempts.at(-1).validation.workerState.status, "stale");
});
