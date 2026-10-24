const assert = require("node:assert/strict");
const { test } = require("node:test");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const http = require("node:http");
const Module = require("node:module");
const { randomUUID, createHash } = require("node:crypto");
const { WorkerTreeStore, workerLimits, workerIsDescendant } = require("../dist/chat/worker-tree");
const fixtures = require("./fixtures/chat-context");
const originalLoad = Module._load;
let maximum = 10;
const host = {
  env: { language: "en" },
  window: { showInformationMessage: async () => undefined, showWarningMessage: async () => undefined, showErrorMessage: async () => undefined },
  workspace: { isTrusted: true, workspaceFolders: [], getConfiguration: () => ({ get: (key, fallback) => key === "apiChatMaximumWorkers" ? maximum : fallback }) },
  lm: { tools: [] },
};
let ApiChatView;
let ApiChatStore, apiChatStatus, captureExecutionContext;
try {
  Module._load = function(name, ...args) { return name === "vscode" ? host : originalLoad.call(this, name, ...args); };
  ({ ApiChatView } = require("../dist/chat/api-chat-view"));
  ({ ApiChatStore, apiChatStatus } = require("../dist/chat/api-chat-store"));
  ({ captureExecutionContext } = require("../dist/chat/execution-context"));
} finally { Module._load = originalLoad; }

async function until(predicate, label) {
  const deadline = Date.now() + 4000;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error(`Timed out: ${label}`);
    await new Promise(resolve => setTimeout(resolve, 5));
  }
}

function answer(res, content) {
  res.writeHead(200, { "Content-Type": "text/event-stream" });
  res.end(`data: ${JSON.stringify({ choices: [{ delta: { content }, finish_reason: "stop" }] })}\n\ndata: [DONE]\n\n`);
}
function tool(res, name, args) {
  res.writeHead(200, { "Content-Type": "text/event-stream" });
  res.end(`data: ${JSON.stringify({ choices: [{ delta: { tool_calls: [{ index: 0, id: randomUUID(), type: "function", function: { name, arguments: JSON.stringify(args) } }] }, finish_reason: "tool_calls" }] })}\n\ndata: [DONE]\n\n`);
}

async function harness(t, respond) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "pkm-worker-test-"));
  const requests = [];
  const approvals = [];
  const errors = [];
  const server = http.createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const payload = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    requests.push(payload);
    respond(payload, res);
  });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  const privateDirectory = path.join(directory, "private-host");
  const provider = new ApiChatView({
    secrets: { get: async () => "synthetic-key" },
    globalStorageUri: { fsPath: privateDirectory },
  }, async () => []);
  provider.store = new ApiChatStore(path.join(directory, ".pkm", "state"), fixtures.namespace);
  const root = fixtures.conversation({ permissionMode: "allow-all", builtinTools: ["spawn_workers", "list_chats"], vscodeTools: [] });
  provider.store.save(root); provider.chat = root; provider.chats.set(root.id, root);
  provider.publish = () => provider.dispatchWorkerEvents();
  provider.notify = error => errors.push(error);
  provider.captureExecution = chat => captureExecutionContext(provider.executionHostId, [], directory, true, chat.permissionMode || "ask");
  provider.requestPermission = async (_chat, _scope, _title, _detail, _signal, _local, once) => { if (once) approvals.push({ once }); return !once; };
  const profile = { id: "fixture", model: "fixture", label: "Fixture", status: "active", contextWindow: 32768, maxOutputTokens: 1024, currency: "USD", includeUsage: false, outputTokenParameter: "max_tokens" };
  provider.settings = () => ({ provider: "openai-compatible", endpoint: `http://127.0.0.1:${server.address().port}/v1`, selectedProfile: profile, profiles: [profile],
    model: profile.model, contextWindow: profile.contextWindow, maxOutputTokens: 1024, timeoutMs: 10000, maxToolRounds: 10, loopReviewAfterMs: 60000 });
  t.after(async () => {
    provider.dispose();
    await until(() => provider.running.size === 0, "cancelled workers finish");
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
    fs.rmSync(directory, { recursive: true, force: true });
    maximum = 10;
  });
  return { provider, root, requests, approvals, errors, privateDirectory };
}

test("unconfigured private Host Profiles preserve real manager/worker dispatch without creating cards or injecting persona context", async t => {
  let workerGate;
  const fixture = await harness(t, (payload, res) => {
    const prompt = payload.messages.at(-1).content;
    if (prompt === "NO_PROFILE_MANAGER") {
      tool(res, "spawn_workers", { tasks:[{ title:"No Profile worker", question:"NO_PROFILE_WORKER" }] });
    } else if (prompt === "NO_PROFILE_WORKER") workerGate = res;
    else answer(res, "Manager handled the original worker event");
  });
  await fixture.provider.send("NO_PROFILE_MANAGER", fixture.root);
  await until(() => !!workerGate, "unconfigured worker reaches actual HTTP transport");
  const manager = fixture.provider.store.load(fixture.root.id, false);
  const record = manager.messages.flatMap(message => message.delegations || [])[0];
  assert(record, "The manager must create a real explicit worker assignment");
  const worker = fixture.provider.store.load(record.chatId, false);
  assert.equal(manager.agentProfileId, undefined);
  assert.equal(worker.agentProfileId, undefined);
  assert(worker.messages.some(message => message.role === "assistant" && message.status === "streaming"));
  assert(manager.messages.concat(worker.messages).every(message => message.profileContext === undefined));
  assert.equal(fs.existsSync(path.join(fixture.privateDirectory, "profiles")), false, "No configured Profiles must not create private card storage");
  answer(workerGate, "Original no-Profile worker result");
  await until(() => fixture.provider.running.size === 0
    && fixture.provider.store.load(fixture.root.id, false).messages.some(message => message.delegations?.some(item => item.status === "complete")),
  "worker completion is durably reported to its manager");
  assert(fixture.requests.some(payload => payload.messages.at(-1).content === "NO_PROFILE_WORKER"));
  assert(fixture.requests.every(payload => payload.messages.every(message =>
    !message.content.includes("Explicit collaboration Profiles (preferences/context only, not authority)"))));
  assert.deepEqual(fixture.errors, []);
});

test("worker harness requires real private Host storage and does not mask Profile I/O failures as an unconfigured Profile", async t => {
  const fixture = await harness(t, (_payload, res) => answer(res, "Must not dispatch"));
  const storage = fixture.provider.extension.globalStorageUri;
  fixture.provider.extension.globalStorageUri = undefined;
  await assert.rejects(fixture.provider.send("MISSING_HOST_STORAGE", fixture.root), /Private Host Profile storage is unavailable/);
  fixture.provider.extension.globalStorageUri = storage;
  fs.mkdirSync(fixture.privateDirectory, { recursive:true });
  fs.writeFileSync(path.join(fixture.privateDirectory, "profiles"), "Not a directory");
  await assert.rejects(fixture.provider.send("BROKEN_PROFILE_STORAGE", fixture.root), error => error.code === "ENOTDIR");
  assert.equal(fixture.requests.length, 0);
  assert.equal(fixture.provider.running.size, 0);
  assert.equal(fixture.root.messages.length, 0);
});

test("tree capacity: recursive reservations share a persistent quota and resolved slots are reusable", t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "pkm-tree-budget-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const store = new WorkerTreeStore(directory);
  const root = randomUUID();
  const id = store.create(root);
  const workers = store.reserve(id, root, ["A", "B", "C"], workerLimits(3, 10));
  assert.equal(store.count(id), 3);
  assert.throws(() => store.reserve(id, workers[0].chatId, ["Grandchild"], workerLimits(3, 10)), /approval/);
  store.reserve(id, workers[0].chatId, ["Grandchild"], workerLimits(3, 10), 4);
  const grandchild = store.members(id).at(-1);
  assert(workerIsDescendant(store.members(id), root, grandchild.chatId));
  assert(workerIsDescendant(store.members(id), workers[0].chatId, grandchild.chatId));
  assert(!workerIsDescendant(store.members(id), workers[1].chatId, grandchild.chatId), "Sibling managers do not own one another's subtree");
  assert.equal(new WorkerTreeStore(directory).count(id), 4);
  assert.throws(() => store.reserve(id, workers[1].chatId, ["Next"], workerLimits(3, 10)), /approval/);
  store.reserve(id, workers[1].chatId, Array(6).fill("Expansion"), workerLimits(3, 10), 10);
  assert.throws(() => store.reserve(id, workers[2].chatId, ["Overflow"], workerLimits(3, 10), 11), /limit exceeded/);
  assert.throws(() => store.reserve(id, randomUUID(), ["Foreign"], workerLimits(3, 20), 11), /does not belong/);
  assert.throws(() => workerLimits(11, 10), /limits/);
  for (const slot of store.members(id)) store.release(id, slot.receiptId);
  assert.equal(store.count(id), 0);
  assert.equal(new WorkerTreeStore(directory).quota(id, workerLimits(3, 10)), 10);
  const reused = store.reserve(id, root, Array(10).fill("Reused"), workerLimits(3, 10));
  assert.equal(reused.length, 10, "Previously approved capacity requires no new approval");
  assert.equal(store.count(id), 10);
});

test("manager resumes a failed worker from recorded progress without replacing history, replaying tools or expanding quota", async t => {
  let resumedResponse;
  const fixture = await harness(t, (payload, res) => {
    const prompt = payload.messages.at(-1).content;
    if (prompt === "RESUME_ROOT") tool(res, "spawn_workers", { tasks: [{ title: "Recover existing progress", question: "FAIL_WORKER" }] });
    else if (prompt === "FAIL_WORKER") tool(res, "list_chats", {});
    else if (prompt.startsWith("Resume the existing worker assignment:")) resumedResponse = res;
    else if (payload.messages.at(-1).role === "tool") {
      res.writeHead(200, { "Content-Type": "text/event-stream" });
      res.end(`data: ${JSON.stringify({ choices: [{ delta: { content: "Partial checkpoint" }, finish_reason: "stop" }], usage: { prompt_tokens: 200, completion_tokens: 1025 } })}\n\ndata: [DONE]\n\n`);
    } else answer(res, "Manager event");
  });
  const { provider } = fixture;
  await provider.send("RESUME_ROOT", fixture.root);
  await provider.handle({ type: "pause" });
  const record = () => provider.store.load(fixture.root.id, false).messages.flatMap(message => message.delegations || [])[0];
  await until(() => record()?.status === "failed", "worker output failure reported");
  const failedRecord = record();
  const failedWorker = provider.store.load(failedRecord.chatId, false);
  const failedMessage = failedWorker.messages.at(-1);
  const originalHistory = failedWorker.messages.map(message => message.id);
  const treeId = failedWorker.workerActivity.treeId;
  const count = provider.store.workerTrees.count(treeId);
  assert.equal(failedMessage.toolCalls.length, 1);
  assert.equal(failedMessage.toolCalls[0].status, "complete");
  assert.match(failedMessage.error, /per-inference token budget/);
  const overview = provider.workerOverview(provider.chat, provider.store.list(true));
  const node = overview.nodes.find(node => node.chatId === failedWorker.id);
  assert.equal(node.canResume, true); assert.match(node.error, /per-inference token budget/);
  await assert.rejects(provider.handle({ type: "workerResume", id: failedRecord.id, value: randomUUID() }), /activity changed/);
  const unrelated = fixtures.conversation({ workerState: { ...provider.chat.workerState } });
  provider.store.save(unrelated);
  await assert.rejects(provider.resumeWorker(unrelated, failedRecord.id, failedRecord.attemptId), /no active worker tree/);
  provider.queueDrains.add(failedWorker.id);
  try {
    await assert.rejects(provider.resumeWorker(provider.chat, failedRecord.id, failedRecord.attemptId), /Only an idle/);
  } finally { provider.queueDrains.delete(failedWorker.id); }
  const resume = provider.handle({ type: "workerResume", id: failedRecord.id, value: failedRecord.attemptId, chatId: fixture.root.id });
  await until(() => resumedResponse, "worker continuation dispatched");
  const current = provider.store.load(failedWorker.id, false);
  assert.deepEqual(current.messages.slice(0, originalHistory.length).map(message => message.id), originalHistory);
  assert.equal(current.messages[originalHistory.length - 1].error, failedMessage.error);
  assert.equal(current.workerActivity.id, failedWorker.workerActivity.id);
  assert.notEqual(current.workerActivity.attemptId, failedRecord.attemptId);
  assert.equal(current.workerActivity.receiptId, failedRecord.id);
  assert.equal(provider.chat.id, fixture.root.id, "manager view must not be retargeted to the worker");
  assert.equal(provider.store.workerTrees.count(treeId), count);
  assert.equal(fixture.approvals.length, 0, "Resume reuses the existing occupied worker slot");
  const request = fixture.requests.at(-1);
  assert(request.messages.some(message => message.content.includes("Original assignment:\nFAIL_WORKER")));
  assert(request.messages.some(message => message.content.includes("Partial checkpoint") && message.content.includes("list_chats: complete")));
  assert(request.messages.at(-1).content.includes("do not replay completed operations automatically"));
  await assert.rejects(provider.handle({ type: "workerResume", id: failedRecord.id, value: failedRecord.attemptId }), /activity changed/);
  answer(resumedResponse, "Continued from saved evidence"); await resume;
  assert.equal(provider.store.workerTrees.count(treeId), 0);
  const archive = provider.store.workerResult(failedRecord.id).chat;
  assert.deepEqual(archive.messages.slice(0, originalHistory.length).map(message => message.id), originalHistory);
  assert.equal(archive.messages.at(-1).content, "Continued from saved evidence");
  assert.equal(archive.messages.flatMap(message => message.toolCalls || []).length, 1, "Resume never replays previously recorded tool calls itself");
  assert.equal(record().archived, true);
  await assert.rejects(provider.handle({ type: "workerResume", id: failedRecord.id, value: archive.workerActivity.attemptId }), /does not own/);
  assert.deepEqual(fixture.errors, []);
});

test("CTX-M13: delegated HTTP rounds use the shared planner and cannot read parent or foreign Chat evidence", async t => {
  let childRounds = 0;
  const fixture = await harness(t, (payload, res) => {
    const prompt = payload.messages.at(-1).content;
    if (prompt === "CTX_ROOT") {
      tool(res, "spawn_workers", { tasks:[{ title:"Context isolation", question:"CTX_CHILD" }] });
    } else if (payload.messages.some(message => message.role === "user" && message.content === "CTX_CHILD")) {
      if (++childRounds === 1) tool(res, "session_info", { evidenceCallId:"parent-private-call" });
      else answer(res, "Foreign evidence was unavailable; task complete.");
    } else answer(res, "Manager received child observation.");
  });
  fixture.root.builtinTools = ["spawn_workers", "session_info"];
  fixture.root.messages.push({ id:randomUUID(), role:"assistant", status:"failed", content:"PARENT_PRIVATE_RESPONSE",
    toolCalls:[{ id:"parent-private-call", name:"private_operation", arguments:'{"value":"PARENT_PRIVATE_ARGUMENT"}',
      status:"complete", result:"PARENT_PRIVATE_RESULT" }] });
  fixture.provider.store.save(fixture.root);
  await fixture.provider.send("CTX_ROOT", fixture.root);
  await until(() => {
    const manager = fixture.provider.store.load(fixture.root.id, false);
    const records = manager.messages.flatMap(message => message.delegations || []);
    return records.length === 1 && records[0].archived && !fixture.provider.running.has(fixture.root.id);
  }, "delegated context isolation completes");
  const manager = fixture.provider.store.load(fixture.root.id, false);
  const record = manager.messages.flatMap(message => message.delegations || [])[0];
  const worker = fixture.provider.store.workerResult(record.id).chat;
  const reply = worker.messages.at(-1);
  assert.equal(reply.status, "complete", reply.error);
  assert.equal(reply.toolCalls.length, 1);
  assert.equal(reply.toolCalls[0].status, "failed");
  assert.match(reply.toolCalls[0].result, /missing|outside|excluded/);
  const childRequests = fixture.requests.filter(payload =>
    payload.messages.some(message => message.role === "user" && message.content === "CTX_CHILD"));
  assert.equal(childRequests.length, 2);
  assert.equal(reply.budgetReceipts.length, childRequests.length);
  for (const [round, payload] of childRequests.entries()) {
    assert(!JSON.stringify(payload.messages).includes("PARENT_PRIVATE"));
    const plan = reply.budgetReceipts[round].contextPlan;
    assert(plan);
    assert.equal(plan.manifest.length, payload.messages.length);
    assert.deepEqual(plan.manifest.map(entry => entry.hash), payload.messages.map(message =>
      createHash("sha256").update(JSON.stringify(message)).digest("hex")));
  }
  assert.equal(worker.messages[0].fromChatId, fixture.root.id, "Only explicit assignment provenance links the worker to its manager");
  assert.equal(manager.messages[0].toolCalls[0].result, "PARENT_PRIVATE_RESULT");
  assert.deepEqual(fixture.errors, []);
});

test("three workers overlap; manager sleeps without polling and wakes after each completion", async t => {
  const gates = new Map();
  const fixture = await harness(t, (payload, res) => {
    const prompt = payload.messages.at(-1).content;
    if (prompt === "ROOT_TASK") tool(res, "spawn_workers", { tasks: [0, 1, 2].map(index => ({ title: `Worker ${index}`, question: `WORKER_${index}` })) });
    else if (/^WORKER_/.test(prompt)) gates.set(prompt, res);
    else answer(res, "Manager decision using explicit worker event");
  });

  await fixture.provider.send("ROOT_TASK", fixture.root);
  await until(() => gates.size === 3, "all workers entered HTTP concurrently");
  const root = () => fixture.provider.store.load(fixture.root.id, false);
  assert.equal(root().workerState.sleeping, true);
  assert.equal(apiChatStatus(root()), "awaiting-result");
  assert.equal(fixture.provider.store.list().find(chat => chat.id === fixture.root.id).workerManager, true, "Sleeping managers retain teacher identity");
  assert(fixture.provider.store.list().filter(chat => chat.workerParentChatId === fixture.root.id).every(chat => !chat.workerManager), "Workers without their own dispatch receipts remain workers");
  assert.equal(fixture.requests.length, 4, "No extra manager request after dispatch");
  await new Promise(resolve => setTimeout(resolve, 80));
  assert.equal(fixture.requests.length, 4, "Sleep must not poll");
  assert.equal(fixture.approvals.length, 0, "First three workers are autonomous even under shared accounting");
  for (let index = 0; index < 3; index++) {
    answer(gates.get(`WORKER_${index}`), `RESULT_${index}`);
    await until(() => fixture.requests.filter(request => request.messages.at(-1).content.startsWith("Worker events")).length === index + 1 && !fixture.provider.running.has(fixture.root.id), `wake ${index}`);
    assert.equal(root().workerState.sleeping, index < 2);
  }
  const records = root().messages.flatMap(message => message.delegations || []);
  assert.equal(records.length, 3);
  assert(records.every(record => record.status === "complete" && record.answer.startsWith("RESULT_")));
  assert.equal(fixture.provider.store.workerTrees.count(root().workerState.treeId), 0);
  assert(records.every(record => record.archived));
  assert(records.every(record => fixture.provider.store.workerResult(record.id).chat.messages.some(message => message.content.startsWith("RESULT_"))));
  assert(records.every(record => !fixture.provider.store.list().some(chat => chat.id === record.chatId)), "Temporary Chats are destroyed after evidence is durable");
  assert.equal(fixture.provider.store.list().find(chat => chat.id === fixture.root.id).workerManager, true, "Teacher identity survives removal of temporary worker Chats");
  assert.deepEqual(fixture.errors, []);
  for (const request of fixture.requests.filter(request => /^WORKER_/.test(request.messages.at(-1).content))) {
    assert(!JSON.stringify(request.messages).includes("ROOT_TASK"), "Workers have no hidden shared parent Memory");
  }
});

test("two ready siblings share one batch and dispatch without an intermediate manager request", async t => {
  const gates = [];
  const fixture = await harness(t, (payload, res) => {
    const prompt = payload.messages.at(-1).content;
    if (prompt === "ROOT_TASK") {
      assert.match(payload.messages[0].content, /ONE spawn_workers.tasks array/);
      const spawn = payload.tools.find(tool => tool.function.name === "spawn_workers");
      assert.match(spawn.function.description, /ALL currently ready independent sibling tasks/);
      tool(res, "spawn_workers", { tasks: [{ title: "Literature", question: "WORKER_A" }, { title: "Methods", question: "WORKER_B" }] });
    } else if (/^WORKER_/.test(prompt)) gates.push(res);
    else answer(res, "Decision");
  });
  await fixture.provider.send("ROOT_TASK", fixture.root);
  await until(() => gates.length === 2, "two requests overlap");
  assert.equal(fixture.requests.length, 3);
  assert.equal(fixture.provider.store.load(fixture.root.id, false).workerState.sleeping, true);
  gates.forEach((res, index) => answer(res, `Sibling result ${index}`));
  await until(() => fixture.provider.running.size === 0, "siblings finish");
  assert.deepEqual(fixture.errors, []);
});

test("recursive fourth worker requires explicit approval even with Allow All; denial creates no child", async t => {
  let rootResponse;
  const fixture = await harness(t, (payload, res) => {
    const prompt = payload.messages.at(-1).content;
    if (prompt === "ROOT_TASK") tool(res, "spawn_workers", { tasks: [0, 1, 2].map(index => ({ title: `Worker ${index}`, question: `WORKER_${index}` })) });
    else if (prompt === "WORKER_0") tool(res, "spawn_workers", { tasks: [{ title: "Recursive child", question: "GRANDCHILD" }] });
    else if (/^WORKER_/.test(prompt)) answer(res, "Sibling done");
    else { rootResponse = payload; answer(res, "Decision"); }
  });
  await fixture.provider.send("ROOT_TASK", fixture.root);
  await until(() => fixture.approvals.length === 1 && fixture.provider.running.size === 0, "denied recursive spawn finishes");
  assert.equal(fixture.provider.store.workerTrees.count(fixture.provider.store.load(fixture.root.id, false).workerState.treeId), 0);
  assert(!fixture.requests.some(request => request.messages.at(-1).content === "GRANDCHILD"));
  assert(fixture.requests.some(request => request.messages.some(message => message.role === "tool" && /expansion declined/i.test(message.content))));
  assert(rootResponse);
});

test("explicit peer messages queue while recipient is busy, then wake it without sharing history", async t => {
  const gates = new Map();
  let sent = false;
  const fixture = await harness(t, (payload, res) => {
    const prompt = payload.messages.at(-1).content;
    if (prompt === "ROOT_TASK") tool(res, "spawn_workers", { tasks: [{ title: "Sender", question: "SENDER_PRIVATE_TASK" }, { title: "Receiver", question: "RECEIVER_TASK" }] });
    else if (prompt === "SENDER_PRIVATE_TASK" && !sent) gates.set("sender", res);
    else if (prompt === "RECEIVER_TASK") gates.set("receiver", res);
    else answer(res, "Handled explicit event");
  });
  await fixture.provider.send("ROOT_TASK", fixture.root);
  await until(() => gates.size === 2, "peers ready");
  const records = fixture.provider.store.load(fixture.root.id, false).messages.flatMap(message => message.delegations || []);
  sent = true;
  tool(gates.get("sender"), "send_worker_message", { chatUrl: records[1].chatUrl, message: "EXPLICIT_METRIC: QPS=1250" });
  await until(() => fixture.provider.chats.get(records[1].chatId).workerState.events.some(event => event.message), "message persisted in busy inbox");
  assert(!fixture.requests.some(request => request.messages.at(-1).content.includes("EXPLICIT_METRIC")));
  answer(gates.get("receiver"), "Receiver initial work complete");
  await until(() => fixture.requests.some(request => request.messages.at(-1).content.includes("EXPLICIT_METRIC")) && fixture.provider.running.size === 0, "peer wake delivered");
  const delivery = fixture.requests.find(request => request.messages.at(-1).content.includes("EXPLICIT_METRIC"));
  assert(!JSON.stringify(delivery.messages).includes("SENDER_PRIVATE_TASK"));
  assert(delivery.messages.at(-1).content.includes(records[0].chatId));
  assert.equal(fixture.provider.store.workerTrees.count(fixture.root.workerState.treeId), 0);
});

test("busy manager queues concurrent completions and handles them once after its active decision", async t => {
  const gates = new Map();
  let managerGate;
  let wakes = 0;
  const fixture = await harness(t, (payload, res) => {
    const prompt = payload.messages.at(-1).content;
    if (prompt === "ROOT_TASK") tool(res, "spawn_workers", { tasks: [0, 1, 2].map(index => ({ title: `Worker ${index}`, question: `WORKER_${index}` })) });
    else if (/^WORKER_/.test(prompt)) gates.set(prompt, res);
    else if (++wakes === 1) managerGate = res;
    else answer(res, "Processed queued completions");
  });
  await fixture.provider.send("ROOT_TASK", fixture.root);
  await until(() => gates.size === 3, "workers running");
  answer(gates.get("WORKER_0"), "First result");
  await until(() => managerGate, "manager handling first event");
  answer(gates.get("WORKER_1"), "Second result");
  answer(gates.get("WORKER_2"), "Third result");
  await until(() => fixture.provider.chats.get(fixture.root.id).workerState.events.length === 2, "busy events queued");
  assert.equal(wakes, 1);
  answer(managerGate, "First decision complete");
  await until(() => wakes === 2 && fixture.provider.running.size === 0, "one follow-up processes queued events");
  const root = fixture.provider.store.load(fixture.root.id, false);
  assert.equal(root.workerState.events.length, 0);
  assert.equal(root.workerState.sleeping, false);
  assert.equal(wakes, 2, "No duplicate manager dispatch");
});

test("Stop while sleeping cancels workers and prevents automatic wake; resume processes the saved event", async t => {
  let gate;
  const fixture = await harness(t, (payload, res) => {
    const prompt = payload.messages.at(-1).content;
    if (prompt === "ROOT_TASK") tool(res, "spawn_workers", { tasks: [{ title: "Worker", question: "WORKER_TASK" }] });
    else if (prompt === "WORKER_TASK") gate = res;
    else answer(res, "Resumed decision");
  });
  await fixture.provider.send("ROOT_TASK", fixture.root);
  await until(() => gate, "worker running");
  fixture.provider.chat = fixture.provider.store.load(fixture.root.id, false);
  fixture.provider.chats.set(fixture.root.id, fixture.provider.chat);
  await fixture.provider.handle({ type: "cancel" });
  await until(() => fixture.provider.running.size === 0, "Stop cancels the running worker without waiting for it");
  try { answer(gate, "Too late"); } catch {}
  const stopped = fixture.provider.store.load(fixture.root.id, false);
  assert.deepEqual(stopped.messages.flatMap(message => message.delegations || []).map(record => record.status), ["cancelled"]);
  assert.equal(stopped.workerState.events[0].phase, "cancelled");
  assert.equal(apiChatStatus(stopped), "stopped");
  assert.equal(stopped.workerState.events.length, 1);
  assert.equal(fixture.requests.length, 2, "Stopping a sleeping manager must not wake the manager");
  fixture.provider.chat = stopped; fixture.provider.chats.set(stopped.id, stopped);
  await fixture.provider.handle({ type: "resume" });
  await until(() => fixture.requests.length === 3 && fixture.provider.running.size === 0, "saved event resumed");
});

test("ordinary lifecycle updates never wake; real permission episodes wake once and resume is UI-only", async t => {
  let gate;
  const fixture = await harness(t, (payload, res) => {
    const prompt = payload.messages.at(-1).content;
    if (prompt === "ROOT_TASK") tool(res, "spawn_workers", { tasks: [{ title: "Worker", question: "WORKER_TASK" }] });
    else if (prompt === "WORKER_TASK") gate = res;
    else answer(res, "Lifecycle decision");
  });

  await fixture.provider.send("ROOT_TASK", fixture.root);
  await until(() => gate, "worker running");
  const workerId = fixture.provider.store.load(fixture.root.id, false).messages.flatMap(message => message.delegations || [])[0].chatId;
  fixture.provider.setAwaitingInput(workerId, true);
  fixture.provider.setAwaitingInput(workerId, false);
  await new Promise(resolve => setTimeout(resolve, 50));
  assert.equal(fixture.requests.length, 2, "Fake approval callbacks/progress do not trigger model decisions");
  fixture.provider.setAwaitingInput(workerId, true);
  const worker = fixture.provider.chats.get(workerId);
  fixture.provider.workerDecision(worker, "permission", "Real human approval required", true);
  await until(() => fixture.requests.length === 3 && !fixture.provider.running.has(fixture.root.id), "actionable permission wake");
  fixture.provider.reportWorkerState(worker);
  fixture.provider.workerDecision(worker, "permission", "Real human approval required", true);
  fixture.provider.clearWorkerDecision(worker);
  fixture.provider.setAwaitingInput(workerId, false);
  await new Promise(resolve => setTimeout(resolve, 50));
  assert.equal(fixture.requests.length, 3, "Episode deduplication and resume avoid extra requests");
  answer(gate, "Terminal result");
  await until(() => fixture.provider.running.size === 0, "worker done");
});

  test("existing Chat assignments retain history/group and release the activity binding for reuse", async t => {
    let target;
    const fixture = await harness(t, (payload, res) => {
      const prompt = payload.messages.at(-1).content;
      if (prompt === "ASSIGN") {
        assert(payload.tools.some(tool => tool.function.name === "assign_workers"), "Assignment is advertised before any spawn");
        tool(res, "assign_workers", { tasks: [{ chatUrl: `pkm://chats/${fixtures.namespace}/${target.id}`, title: "Existing specialist", question: "EXISTING_TASK" }] });
      } else answer(res, prompt === "EXISTING_TASK" ? "Existing result" : "Manager handled result");
    });
    target = fixture.provider.store.create();
    target.messages.push({ id: randomUUID(), role: "user", content: "HISTORICAL_USER_CONTEXT", status: "complete" });
    target.permissionMode = "allow-all"; fixture.provider.store.save(target);
    const groupId = fixture.provider.store.library.createGroup("Existing group");
    fixture.provider.store.library.move(target.id, groupId);
    await fixture.provider.send("ASSIGN", fixture.root);
    await until(() => fixture.provider.running.size === 0 && fixture.requests.length >= 3, "existing activity resolved");
    let saved = fixture.provider.store.load(target.id, false);
    assert(saved.messages.some(message => message.content === "HISTORICAL_USER_CONTEXT"));
    assert(saved.messages.some(message => message.fromChatId === fixture.root.id && message.delegationId));
    assert.equal(saved.workerActivity, undefined);
    assert.equal(saved.workerState, undefined, "Assignment is not permanent ownership");
    assert.equal(fixture.provider.store.library.read().placements[target.id].groupId, groupId);
    assert.equal(fixture.provider.store.workerTrees.count(fixture.root.workerState.treeId), 0);
    await fixture.provider.send("ASSIGN", fixture.provider.store.load(fixture.root.id, false));
    await until(() => fixture.provider.running.size === 0 && fixture.requests.length >= 6, "same Chat reused");
    saved = fixture.provider.store.load(target.id, false);
    assert.equal(saved.messages.filter(message => message.content === "EXISTING_TASK").length, 2);
    assert.deepEqual(fixture.errors, []);
  });

  test("held clarification advertises exact control IDs and manager response resumes without spawning", async t => {
    let fixture;
    fixture = await harness(t, (payload, res) => {
      const prompt = payload.messages.at(-1).content;
      if (prompt === "ROOT_TASK") tool(res, "spawn_workers", { tasks: [{ title: "Clarifying", question: "ASK_MANAGER" }] });
      else if (prompt === "ASK_MANAGER") {
        assert(payload.tools.some(tool => tool.function.name === "request_manager_input"));
        tool(res, "request_manager_input", { reason: "clarification", question: "Which dataset?" });
      } else if (prompt.startsWith("Worker events") && prompt.includes("decision: clarification")) {
        const manager = fixture.provider.store.load(fixture.root.id, false);
        const record = manager.messages.flatMap(message => message.delegations || [])[0];
        const worker = fixture.provider.chats.get(record.chatId);
        assert(prompt.includes(worker.workerActivity.decision.episodeId), "Episode is supplied, not guessed");
        tool(res, "respond_worker", { receiptId: record.id, activityId: record.activityId, attemptId: record.attemptId,
          episodeId: worker.workerActivity.decision.episodeId, answer: "Use dataset B" });
      } else answer(res, "Resolved task");
    });
    await fixture.provider.send("ROOT_TASK", fixture.root);
    await until(() => fixture.requests.some(payload => payload.messages.some(message => message.role === "tool" && message.content === "Use dataset B")) && fixture.provider.running.size === 0, "worker resumed");
    assert.equal(fixture.provider.store.workerTrees.members(fixture.root.workerState.treeId).length, 1);
    assert.deepEqual(fixture.errors, []);
  });

  test("PKM reports dead-owner interruption once durably while manager is paused, then archives on resolution", async t => {
    const fixture = await harness(t, (_payload, res) => answer(res, "No live task used"));
    const { provider, root } = fixture;
    const treeId = provider.store.workerTrees.create(root.id);
    root.paused = true;
    root.workerState = { treeId, executionContext: provider.captureExecution(root), sleeping: true, stopped: false, events: [] };
    const [slot] = provider.store.workerTrees.reserve(treeId, root.id, ["Crashed"], workerLimits(3, 10));
    const activityId = randomUUID(); const attemptId = randomUUID();
    const worker = provider.store.createWorker(root, slot.chatId, slot.title, { treeId, parentChatId: root.id, receiptId: slot.receiptId, executionContext: provider.captureExecution(root), sleeping: false, stopped: false, events: [] });
    const deadPid = require("node:child_process").spawnSync(process.execPath, ["-e", ""]).pid;
    worker.progress = { attemptId, executionContext: provider.captureExecution(worker), ownerPid: deadPid, ownerHost: os.hostname(), startedAt: Date.now(), status: "running", model: "fixture", steps: [] };
    worker.workerActivity = { id: activityId, receiptId: slot.receiptId, managerChatId: root.id, treeId, temporary: true, state: "running", attemptId };
    worker.messages = [{ id: randomUUID(), role: "user", content: "Crash fixture", status: "complete", delegationId: slot.receiptId },
      { id: randomUUID(), role: "assistant", content: "Partial evidence", status: "streaming", progress: worker.progress }];
    root.messages.push({ id: randomUUID(), role: "assistant", content: "", status: "complete", delegations: [{ id: slot.receiptId, chatId: worker.id, chatUrl: `pkm://chats/${fixtures.namespace}/${worker.id}`, status: "running", treeId, activityId, attemptId, temporary: true }] });
    provider.store.save(worker); provider.store.save(root);
    provider.superviseWorkers(); provider.superviseWorkers();
    const saved = provider.store.load(root.id, false);
    assert.equal(saved.workerState.events.length, 1);
    assert.equal(saved.workerState.events[0].phase, "failed");
    assert.equal(saved.workerState.events[0].activityId, activityId);
    assert.equal(fixture.requests.length, 0, "Paused manager has no billing wake");
    assert.equal(provider.store.workerTrees.count(treeId), 1, "Failure occupies capacity until resolved");
    const failed = provider.store.load(worker.id, false);
    assert.equal(failed.workerActivity.state, "interrupted");
    const release = provider.store.workerTrees.release.bind(provider.store.workerTrees);
    provider.store.workerTrees.release = () => { throw new Error("Injected crash after archive/delete"); };
    assert.throws(() => provider.finalizeWorker(failed, true), /Injected crash/);
    assert(provider.store.hasWorkerResult(slot.receiptId), "Evidence is saved before any deletion");
    provider.store.workerTrees.release = release;
    provider.superviseWorkers();
    assert.equal(provider.store.workerTrees.count(treeId), 0);
    assert.equal(provider.store.workerResult(slot.receiptId).chat.messages.at(-1).content, "Partial evidence");
    assert(!provider.store.list().some(chat => chat.id === worker.id));
    assert.equal(provider.store.load(root.id, false).messages.at(-1).delegations[0].archived, true, "Restart supervision recovers deletion/release receipt window");
    assert.deepEqual(fixture.errors, []);
  });

  test("quota questions are tools-disabled, bill usage, and never constitute consent", async t => {
    const fixture = await harness(t, (payload, res) => {
      assert(!payload.tools?.length, "Clarification cannot execute any tools");
      answer(res, "Six is reusable concurrent capacity.");
    });
    const { provider, root } = fixture;
    root.progress = { attemptId: randomUUID(), executionContext: provider.captureExecution(root), startedAt: Date.now(), status: "running", model: "fixture", steps: [] };
    root.messages.push({ id: randomUUID(), role: "assistant", content: "", status: "streaming" });
    provider.store.save(root);
    const controller = new AbortController(); provider.running.set(root.id, controller);
    const id = randomUUID(); let approved = false;
    provider.approvals.set(id, { chat: root, scope: "worker-expansion", title: "Increase capacity", detail: "3 to 6", once: true, signal: controller.signal, ownerSignal: controller.signal, resolve: () => { approved = true; } });
    await provider.handle({ type: "approvalQuestion", id, text: "Will completed work free the capacity?" });
    assert.equal(approved, false);
    assert(provider.approvals.has(id));
    assert.equal(root.workerState, undefined, "No worker tree or capacity created");
    assert.equal(provider.store.list().length, 1);
    assert.equal(provider.approvals.get(id).questions[0].answer, "Six is reusable concurrent capacity.");
    await assert.rejects(provider.handle({ type: "approvalQuestion", id: randomUUID(), text: "Foreign" }), /no longer pending/);
    await provider.handle({ type: "approval", id, value: "deny" });
    assert.equal(root.permissionGrants?.includes("worker-expansion") || false, false);
    provider.running.delete(root.id);
  });

test("exact persisted stop cancels only the delegated attempt; stale reports and human permission responses are rejected", async t => {
  const gates = new Map();
  const fixture = await harness(t, (payload, res) => {
    const prompt = payload.messages.at(-1).content;
    if (prompt === "ROOT_TASK") tool(res, "spawn_workers", { tasks: [{ title: "A", question: "WORKER_A" }, { title: "B", question: "WORKER_B" }] });
    else if (prompt.startsWith("WORKER_")) gates.set(prompt, res);
    else answer(res, "Scoped decision");
  });
  await fixture.provider.send("ROOT_TASK", fixture.root);
  await until(() => gates.size === 2, "both activities executing");
  const records = fixture.provider.store.load(fixture.root.id, false).messages.flatMap(message => message.delegations || []);
  const worker = fixture.provider.chats.get(records[0].chatId);
  const activity = worker.workerActivity;
  assert.throws(() => fixture.provider.postWorkerEvent(fixture.root.id, { id: randomUUID(), receiptId: records[0].id, phase: "failed", activityId: activity.id, attemptId: randomUUID() }), /stale/);
  assert.throws(() => fixture.provider.store.requestWorkerStop(worker.id, randomUUID(), activity.id, "Foreign", activity.attemptId), /stale|controlled/);
  assert.throws(() => fixture.provider.store.requestWorkerStop(worker.id, fixture.root.id, activity.id, "Old attempt", randomUUID()), /stale|controlled/);
  fixture.provider.workerDecision(worker, "permission", "Human must approve", true);
  assert.throws(() => fixture.provider.store.requestWorkerResponse(worker.id, fixture.root.id, activity.id, activity.attemptId, activity.decision.episodeId, "Approve", "continue"), /authorize/);
  fixture.provider.clearWorkerDecision(worker);
  const revision = fixture.provider.store.load(worker.id, false).revision;
  fixture.provider.store.requestWorkerStop(worker.id, fixture.root.id, activity.id, "Scoped stop", activity.attemptId);
  assert.equal(fixture.provider.store.load(worker.id, false).revision, revision, "Foreign controls do not conflict with streaming Chat writes");
  await until(() => !fixture.provider.running.has(worker.id), "persisted stop observed");
  assert(fixture.provider.running.has(records[1].chatId), "Sibling activity remains running");
  const archived = fixture.provider.store.workerResult(records[0].id).chat;
  assert.equal(archived.workerActivity.state, "cancelled");
  assert.match(archived.messages.at(-1).error, /Scoped stop.*effects may already/);
  answer(gates.get("WORKER_B"), "Unaffected sibling");
  await until(() => fixture.provider.running.size === 0, "sibling resolved");
  assert.deepEqual(fixture.errors, []);
});

test("existing active-time limit excludes waits and emits one PKM warning without stopping execution", async t => {
  let gate;
  const fixture = await harness(t, (payload, res) => {
    const prompt = payload.messages.at(-1).content;
    if (prompt === "ROOT_TASK") tool(res, "spawn_workers", { tasks: [{ title: "Long", question: "LONG_TASK" }] });
    else if (prompt === "LONG_TASK") gate = res;
    else answer(res, "Manager decision");
  });
  const settings = fixture.provider.settings;
  fixture.provider.settings = () => ({ ...settings(), loopReviewAfterMs: 300 });
  await fixture.provider.send("ROOT_TASK", fixture.root);
  await until(() => gate, "long task running");
  fixture.root.paused = true; fixture.provider.persist(fixture.root);
  const record = fixture.root.messages.flatMap(message => message.delegations || [])[0];
  const worker = fixture.provider.chats.get(record.chatId);
  fixture.provider.setAwaitingInput(worker.id, true);
  await new Promise(resolve => setTimeout(resolve, 1200));
  assert.equal(worker.workerActivity.decision, undefined, "Approval wait is not active execution");
  fixture.provider.setAwaitingInput(worker.id, false);
  await until(() => worker.workerActivity.decision?.reason === "runtime-limit", "active-time warning");
  const episodeId = worker.workerActivity.decision.episodeId;
  assert.equal(worker.workerActivity.state, "running", "Needs decision does not mean execution has stopped");
  assert(fixture.provider.running.has(worker.id));
  await new Promise(resolve => setTimeout(resolve, 1100));
  assert.equal(worker.workerActivity.decision.episodeId, episodeId);
  assert.equal(fixture.provider.store.load(fixture.root.id, false).workerState.events.length, 1);
  fixture.provider.store.requestWorkerResponse(worker.id, fixture.root.id, worker.workerActivity.id, worker.workerActivity.attemptId, episodeId, "Continue", "continue");
  await until(() => !worker.workerActivity.decision, "persisted continue observed");
  answer(gate, "Long work complete");
  await until(() => !fixture.provider.running.has(worker.id), "long activity resolved");
  assert.deepEqual(fixture.errors, []);
});

test("suspected loop has repeated-tool evidence and manager can summarize the held activity", async t => {
  let fixture;
  fixture = await harness(t, (payload, res) => {
    const prompt = payload.messages.at(-1).content;
    if (prompt === "ROOT_TASK") tool(res, "spawn_workers", { tasks: [{ title: "Loop evidence", question: "LOOP_TASK" }] });
    else if (prompt === "LOOP_TASK" || payload.messages.some(message => message.content === "LOOP_TASK") && payload.tools?.length) tool(res, "list_chats", {});
    else if (prompt.startsWith("Worker events") && prompt.includes("suspected-loop")) {
      const manager = fixture.provider.store.load(fixture.root.id, false);
      const record = manager.messages.flatMap(message => message.delegations || [])[0];
      const worker = fixture.provider.chats.get(record.chatId);
      assert.match(prompt, /repeated identical calls\/results: [3-9]/);
      tool(res, "respond_worker", { receiptId: record.id, activityId: record.activityId, attemptId: record.attemptId, episodeId: worker.workerActivity.decision.episodeId, answer: "Summarize existing evidence", decision: "summarize" });
    } else answer(res, "Bounded evidence summary");
  });
  const settings = fixture.provider.settings;
  fixture.provider.settings = () => ({ ...settings(), loopReviewAfterMs: 1 });
  await fixture.provider.send("ROOT_TASK", fixture.root);
  await until(() => fixture.requests.some(request => request.messages.at(-1).content.includes("suspected-loop")) && fixture.provider.running.size === 0, "loop summarized");
  assert.equal(fixture.provider.store.workerTrees.count(fixture.root.workerState.treeId), 0);
  assert.equal(fixture.provider.store.workerTrees.members(fixture.root.workerState.treeId).length, 1, "No replacement worker created");
  assert.deepEqual(fixture.errors, []);
});

test("Chat Stop also cancels the Chat's durable background processes", async t => {
  const fixture = await harness(t, (_payload, res) => answer(res, "unused"));
  const { setStorePath, getStorePath } = require("../dist/knowledge/filestore");
  const { launchChatProcess, getChatProcess } = require("../dist/chat/chat-process-runtime");
  const previous = getStorePath();
  const store = fs.mkdtempSync(path.join(os.tmpdir(), "pkm-stop-store-"));
  setStorePath(store);
  const root = path.join(store, ".pkm", "state", "api-chat-tool-results", fixture.root.id);
  const other = path.join(store, ".pkm", "state", "api-chat-tool-results", randomUUID());
  const spec = cwd => ({ program: process.execPath, arguments: ["-e", "setInterval(()=>{},100)"], cwd, timeoutSeconds: 10 });
  fs.mkdirSync(root, { recursive: true }); fs.mkdirSync(other, { recursive: true });
  const mine = await launchChatProcess(root, "stop-me", spec(store));
  const foreign = await launchChatProcess(other, "keep-me", spec(store));
  t.after(async () => {
    const { cancelChatProcess } = require("../dist/chat/chat-process-runtime");
    try { cancelChatProcess(other, foreign.handle); } catch {}
    const deadline = Date.now() + 8000;
    while (Date.now() < deadline && ["launching", "running"].includes(getChatProcess(other, foreign.handle).state)) await new Promise(resolve => setTimeout(resolve, 30));
    setStorePath(previous); fs.rmSync(store, { recursive: true, force: true });
  });
  const settle = async (dir, handle, predicate) => {
    const deadline = Date.now() + 8000;
    while (Date.now() < deadline) { const record = getChatProcess(dir, handle); if (predicate(record)) return record; await new Promise(resolve => setTimeout(resolve, 30)); }
    assert.fail(JSON.stringify(getChatProcess(dir, handle)));
  };
  await settle(root, mine.handle, record => record.state === "running");
  await settle(other, foreign.handle, record => record.state === "running");
  await fixture.provider.handle({ type: "cancel" });
  assert.equal((await settle(root, mine.handle, record => !["launching", "running"].includes(record.state))).state, "cancelled");
  assert.equal(getChatProcess(other, foreign.handle).state, "running", "Stop must not touch another Chat's processes");
  assert.deepEqual(fixture.errors, []);
});
