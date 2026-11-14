import assert from "node:assert/strict";
import { test } from "node:test";
import { createRequire } from "node:module";
import { randomUUID, createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync, rmSync, cpSync, chmodSync, readdirSync, lstatSync } from "node:fs";
import { resolve, join, relative } from "node:path";
import { createServer } from "node:http";
import { pathToFileURL } from "node:url";

const dist = resolve(process.env.PKM_TEST_DIST ?? new URL("../dist", import.meta.url).pathname);
const load = name => import(pathToFileURL(join(dist, name)).href);
const { inspectLegacyApiChatArchive } = await load("legacy-api-chat-archive.js");
const { prepareLegacyRootAdoptionExperimental, resumeLegacyRootAdoptionExperimental } = await load("legacy-root-adoption.js");
const { createNativeRuntime } = await load("native-runtime.js");
const { createLegacyManagedChatLocalModel } = await load("legacy-api-chat-managed-provider.js");
const { startLegacyApiChatUiHost } = await load("legacy-api-chat-ui-host.js");
const { ChatTurnToolError } = await load("chat-turn.js");

const require = createRequire(import.meta.url), project = resolve(new URL("../legacy", import.meta.url).pathname);
const digest = value => createHash("sha256").update(value).digest("hex");
const deferred = () => { let resolve; const promise = new Promise(value => { resolve = value; }); return { promise, resolve }; };

test("real HTTP Task controls retain plain history, cancel real parent/child IO, persist and never replay unknown outcomes", {
  timeout: 90000,
}, async t => {
  const directory = join(project, ".migration-test-work", `managed-task-controls-${randomUUID()}`);
  const root = join(directory, "knowledge");
  mkdirSync(root, { recursive: true, mode: 0o700 });
  let storage, native, ui, server;
  const modelSeen = deferred(), releaseModel = deferred(), childRead = deferred();
  const casualModelSeen = deferred(), releaseCasualModel = deferred(), startEntered = deferred(), releaseStart = deferred();
  const steerSeen = deferred(), releaseSteer = deferred(), queueSeen = deferred(), releaseQueue = deferred();
  t.after(async () => {
    releaseModel.resolve();
    releaseCasualModel.resolve(); releaseStart.resolve();
    releaseSteer.resolve(); releaseQueue.resolve();
    try { await ui?.close(); await native?.close(); await storage?.close(); }
    finally {
      if (server) { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
      rmSync(directory, { recursive: true, force: true });
    }
  });
  const mask = process.umask(0o077);
  let ordinary;
  try {
    if (process.env.PKM_MANAGED_API_CHAT_SOURCE) {
      const source = resolve(process.env.PKM_MANAGED_API_CHAT_SOURCE);
      assert(source.startsWith(join(project, ".migration-test-work") + "/") && source.endsWith("/knowledge"));
      cpSync(source, root, { recursive: true, dereference: false });
    } else {
      require("../legacy/tests/next-trial-electron/api-chat-fixture.cjs").create({ extension: project, root });
      mkdirSync(join(root, "notes"), { mode: 0o700 });
      writeFileSync(join(root, "notes/Existing.md"), "---\ntitle: Existing\nrevision: 1\n---\nSynthetic Task control fixture.\n", { mode: 0o600 });
    }
    const visit = file => {
      const stat = lstatSync(file);
      assert(!stat.isSymbolicLink() && (stat.isFile() || stat.isDirectory()));
      chmodSync(file, stat.isDirectory() ? 0o700 : 0o600);
      if (stat.isDirectory()) for (const name of readdirSync(file)) visit(join(file, name));
    };
    visit(root);
    const { ApiChatStore } = require("../legacy/dist/chat/api-chat-store.js");
    const store = new ApiChatStore(join(root, ".pkm/state"), "0123456789abcdef");
    ordinary = store.create(); ordinary.title = "Original ordinary Chat for Task controls"; store.save(ordinary);
  } finally { process.umask(mask); }
  const identity = { namespace: ordinary.workspaceNamespace, chatId: ordinary.id };
  const before = inspectLegacyApiChatArchive(root);
  const sourceTask = before.chats.find(chat => chat.metadata.sessionId && !chat.metadata.workerState?.managerChatId);
  const sourceIdentity = sourceTask && { namespace: sourceTask.namespace, chatId: sourceTask.id };
  const original = new Map(before.files.filter(file => lstatSync(join(root, file.path)).isFile())
    .map(file => [file.path, readFileSync(join(root, file.path))]));
  const nonce = randomUUID(), options = require("../legacy/tests/next-trial-electron/in-place-options.cjs").options;
  writeFileSync(join(directory, "in-place-fixture-token"), nonce, { mode: 0o600 });
  const prepared = await prepareLegacyRootAdoptionExperimental(root, options({ fixture: directory, root, nonce }));
  const open = async () => {
    storage = (await resumeLegacyRootAdoptionExperimental(root,
      options({ fixture: directory, root, nonce, workspaceId: prepared.workspaceId }))).storage;
    native = await createNativeRuntime({ storage, workspaceId: await storage.workspaceId() });
  };
  await open();
  const inputFile = join(directory, "fresh-control-input.txt"), bytes = `actual-task-control-read-${randomUUID()}`;
  writeFileSync(inputFile, bytes, { mode: 0o600 });
  let modelCalls = 0, plainCalls = 0, reads = 0, permitted = true, nativeTask, childAborted = false, holdStart = false;
  server = createServer(async (request, response) => {
    try {
      const chunks = [];
      for await (const chunk of request) chunks.push(chunk);
      if (request.url === "/plain") { plainCalls++; response.end("RETAINED_REAL_PLAIN_HTTP_RESULT"); return; }
      assert.equal(request.url, "/v1/chat/completions");
      assert.equal(request.headers.authorization, "Bearer fresh-task-control-token");
      const body = JSON.parse(Buffer.concat(chunks).toString());
      assert(body.tools.every(tool => ["read_file", "spawn_workers"].includes(tool.function.name)));
      modelCalls++;
      const question = body.messages.findLast(message => message.role === "user").content;
      if (question.includes("ORIGINAL_CASUAL")) {
        response.writeHead(200, { "content-type": "text/event-stream" });
        response.end(`data: ${JSON.stringify({ choices: [{ index: 0, delta: { content: "Ordinary reply after archived Task." }, finish_reason: null }] })}\n\n`
          + `data: ${JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: "stop" }] })}\n\n`
          + "data: [DONE]\n\n");
        return;
      }
      if (question.includes("CONTROL_PAUSE_MODEL")) { modelSeen.resolve(); await releaseModel.promise; }
      if (question.includes("CONTROL_CASUAL_MODEL")) { casualModelSeen.resolve(); await releaseCasualModel.promise; }
      if (question.includes("CONTROL_CASUAL_STEER")) { steerSeen.resolve(); await releaseSteer.promise; }
      if (question.includes("CONTROL_CASUAL_QUEUE")) { queueSeen.resolve(); await releaseQueue.promise; }
      const results = body.messages.filter(message => message.role === "tool").map(message => JSON.parse(message.content));
      const read = results.find(result => result.path === "fresh-control-input.txt");
      if (read) assert.equal(read.content, bytes);
      const spawn = !!read && question.includes("CONTROL_STOP_CHILD");
      const finished = !!read && !spawn;
      const delta = finished ? { content: `ACTUAL_CONTROL_READ sha256:${digest(bytes)}` } : {
        tool_calls: [{ index: 0, id: spawn ? "control-spawn" : "control-read", type: "function", function: {
          name: spawn ? "spawn_workers" : "read_file",
          arguments: JSON.stringify(spawn ? { tasks: [{ title: "CONTROL_HELD_CHILD",
            question: "CONTROL_CHILD_READ: Read fresh-control-input.txt once. Never retry." }] } : { path: "fresh-control-input.txt" }),
        } }],
      };
      response.writeHead(200, { "content-type": "text/event-stream" });
      response.end(`data: ${JSON.stringify({ choices: [{ index: 0, delta, finish_reason: null }] })}\n\n`
        + `data: ${JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: finished ? "stop" : "tool_calls" }] })}\n\n`
        + "data: [DONE]\n\n");
    } catch (error) { response.writeHead(500); response.end(String(error)); }
  });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  const readTool = { name: "read_file", description: "Read this exact freshly authorized synthetic file.",
    parameters: { type: "object", properties: { path: { type: "string" } }, required: ["path"], additionalProperties: false } };
  const model = createLegacyManagedChatLocalModel({ endpoint: `http://127.0.0.1:${server.address().port}/v1`,
    model: "synthetic-task-controls", apiKey: "fresh-task-control-token",
    tools: async (_actor, turnId) => [readTool, ...(!(await ui.managed.scope(turnId)).parentTurnId ? [{
      name: "spawn_workers", description: "Delegate a fresh independently authorized child.",
      parameters: { type: "object", properties: { tasks: { type: "array", items: { type: "object",
        properties: { title: { type: "string" }, question: { type: "string" } }, required: ["title", "question"],
        additionalProperties: false } } }, required: ["tasks"], additionalProperties: false },
    }] : [])],
  });
  const start = async () => {
    ui = await startLegacyApiChatUiHost({ storage, actorId: "private-native-task-controls",
      chats: [identity, ...(sourceIdentity ? [sourceIdentity] : [])],
      authorize: async () => true,
      provider: async () => (await fetch(`http://127.0.0.1:${server.address().port}/plain`, { method: "POST" })).text(),
      managed: { model, authorize: async binding => {
        if (binding.operation === "start" && holdStart) { startEntered.resolve(); await releaseStart.promise; }
        return binding.root === root && [identity.chatId, sourceIdentity?.chatId].includes(binding.chatId)
          && (binding.operation === "history" || permitted);
      }, authorizeQueue: async () => permitted,
      tools: { available: true, async execute(request) {
        assert.equal(request.binding.sourceSessionId, undefined, "A new Task must not impersonate an archived Session.");
        assert.equal(request.binding.taskSessionId, nativeTask);
        if (request.call.name === "spawn_workers") {
          const child = await ui.managed.delegate(request.turnId, request.operationId, 0);
          return { executionId: request.operationId, content: JSON.stringify({ workers: [child] }) };
        }
        assert.equal(request.call.name, "read_file"); assert.deepEqual(request.call.arguments, { path: "fresh-control-input.txt" });
        const content = readFileSync(inputFile, "utf8"); reads++;
        if (request.binding.parentTurnId) {
          childRead.resolve({ child: request.turnId, parent: request.binding.parentTurnId, sha256: digest(content) });
          await new Promise((_, reject) => {
            const stop = () => { childAborted = true; reject(new ChatTurnToolError("unknown", "REAL_CHILD_READ_WITHOUT_ACK")); };
            if (request.signal.aborted) stop(); else request.signal.addEventListener("abort", stop, { once: true });
          });
        }
        return { executionId: request.operationId, content: JSON.stringify({ path: "fresh-control-input.txt", content }) };
      } } },
    });
  };
  await start();
  const rpc = async input => {
    const response = await fetch(`${ui.endpoint}/rpc`, { method: "POST", headers: {
      authorization: `Bearer ${ui.bearer}`, "x-pkm-native-actor": "private-native-task-controls",
      "content-type": "application/json" }, body: JSON.stringify(input) });
    return { status: response.status, ...await response.json() };
  };
  const ok = async input => { const result = await rpc(input); assert.equal(result.status, 200, result.error); return result.value; };
  let state = (await ok({ method: "history", ...identity })).taskControl;
  const control = (kind, extra = {}) => ({ method: "task-control", input: { ...identity, kind,
    operationId: randomUUID(), expectedRevision: state.revision, ...extra } });
  const plain = { method: "continue", ...identity, operationId: randomUUID(), expectedRevision: 0, text: "Retain this pre-Task plain request." };
  await ok(plain); assert.equal(plainCalls, 1);
  const invalidQueueId = randomUUID();
  assert.equal((await rpc({ method: "queue", input: { ...identity, kind: "enqueue", operationId: invalidQueueId,
    submissionId: invalidQueueId, expectedRevision: 0, taskSessionId: null, mode: "task",
    text: "Do not switch an untouched plain Chat into managed mode." } })).status, 409);
  assert((await ok({ method: "history", ...identity })).messages.some(message => message.content === "RETAINED_REAL_PLAIN_HTTP_RESULT"));
  const create = control("create", { title: "Fresh native controlled Task" });
  state = await ok(create); nativeTask = state.activeSessionId;
  assert.match(nativeTask, /^agent_session_[a-f0-9]{32}$/);
  assert.deepEqual(await ok(create), state, "A lost control response is recovered, not reapplied.");
  assert.match((await rpc(control("create", { title: "Cannot replace an active Task" }))).error, /Complete the current Task/);
  assert.equal((await rpc({ ...create, input: { ...create.input, title: "Different intent" } })).status, 409);
  assert.equal((await rpc({ method: "task-control", input: { ...create.input, chatId: randomUUID() } })).status, 409);
  const history = await ok({ method: "history", ...identity });
  assert(history.messages.some(message => message.content === "RETAINED_REAL_PLAIN_HTTP_RESULT"));
  assert.equal((await rpc(plain)).status, 409, "A plain operation cannot be reissued through the managed engine.");
  const pausedInput = { ...identity, operationId: randomUUID(), expectedRevision: 0, text: "CONTROL_PAUSE_MODEL: read once." };
  await ok({ method: "continue", ...pausedInput }); await modelSeen.promise;
  state = await ok(control("pause")); releaseModel.resolve();
  const paused = await ui.managed.settled(identity, pausedInput.operationId);
  assert.equal(paused.nativeTurns[0].status, "cancelled"); assert.equal(paused.nativeTurns[0].uncertain, false);
  assert.equal(modelCalls, 1); assert.equal(reads, 0);
  assert.equal((await rpc({ method: "continue", ...identity, operationId: randomUUID(), expectedRevision: 1, text: "Do not run while paused." })).status, 409);
  const stale = control("resume"); state = await ok(stale);
  assert.equal(modelCalls, 1); assert.equal(reads, 0);
  assert.equal((await rpc(control("pause", { expectedRevision: stale.input.expectedRevision }))).status, 409);
  permitted = false;
  assert.equal((await rpc(control("cancel"))).status, 409);
  permitted = true;
  const input = { ...identity, operationId: randomUUID(), expectedRevision: 1, text: "CONTROL_SINGLE_READ: read once." };
  await ok({ method: "continue", ...input });
  const read = await ui.managed.settled(identity, input.operationId);
  assert.equal(read.nativeTurns.at(-1).status, "completed"); assert.equal(reads, 1);
  const harness = await ok({ method: "harness", ...identity, sessionId: nativeTask });
  assert.equal(harness.metadataAuthority, "native_core"); assert.equal(harness.record.task, "Fresh native controlled Task");
  assert.equal(harness.history.messages.length, 4);
  assert(harness.history.messages.every(message => message.taskId === nativeTask));
  assert.deepEqual(harness.sourceWorkers, []);
  state = await ok(control("complete")); assert.equal(state.activeSessionId, null);
  assert((await ok({ method: "history", ...identity })).messages.some(message => message.content === read.messages.at(-1).content));
  nativeTask = undefined;
  const casual = { method: "continue", ...identity, operationId: randomUUID(), expectedRevision: 2,
    text: "CONTROL_SINGLE_READ: ordinary conversation after Task." };
  permitted = false;
  assert.equal((await rpc(casual)).status, 409);
  assert.equal(reads, 1, "Denied ordinary input did not invoke the provider or tool.");
  permitted = true;
  await ok(casual);
  const casualHistory = await ui.managed.settled(identity, casual.operationId);
  assert.equal(casualHistory.nativeTurns.at(-1).status, "completed");
  assert.equal(casualHistory.metadata.sessionId, undefined);
  assert.equal(casualHistory.messages.find(message => message.id === casual.operationId).taskId, undefined);
  assert.equal(reads, 2);
  const callsAfterCasual = modelCalls;
  await ok(casual);
  assert.equal(modelCalls, callsAfterCasual, "A repeated operation ID must never send to the provider again.");
  const formerHarness = await ok({ method: "harness", ...identity, sessionId: read.taskControl.activeSessionId });
  assert(!formerHarness.history.messages.some(message => message.id === casual.operationId));

  const steerParent = { method: "continue", ...identity, operationId: randomUUID(), expectedRevision: 3,
    text: "CONTROL_CASUAL_STEER: read once." };
  await ok(steerParent); await steerSeen.promise;
  const steerId = randomUUID();
  let queue = (await ok({ method: "history", ...identity })).queueControl;
  await ok({ method: "queue", input: { ...identity, kind: "enqueue", operationId: steerId, submissionId: steerId,
    expectedRevision: queue.revision, taskSessionId: null, mode: "steer", attemptId: steerParent.operationId,
    text: "Fresh ordinary steering input." } });
  releaseSteer.resolve();
  const steered = await ui.managed.settled(identity, steerParent.operationId);
  assert.equal(steered.nativeTurns.at(-1).status, "completed");
  assert.equal(steered.queueControl.items.find(item => item.id === steerId).status, "applied");
  assert.equal(steered.messages.find(message => message.id === steerId).taskId, undefined);

  const queueParent = { method: "continue", ...identity, operationId: randomUUID(), expectedRevision: 4,
    text: "CONTROL_CASUAL_QUEUE: read once." };
  await ok(queueParent); await queueSeen.promise;
  const queuedId = randomUUID();
  queue = (await ok({ method: "history", ...identity })).queueControl;
  await ok({ method: "queue", input: { ...identity, kind: "enqueue", operationId: queuedId, submissionId: queuedId,
    expectedRevision: queue.revision, taskSessionId: null, mode: "task", text: "Queued ordinary input." } });
  releaseQueue.resolve();
  await ui.managed.settled(identity, queueParent.operationId);
  const deadline = Date.now() + 10000;
  let queuedHistory;
  while (Date.now() < deadline) {
    queuedHistory = await ok({ method: "history", ...identity });
    if (queuedHistory.nativeTurns.some(turn => turn.id === queuedId && turn.status === "completed")) break;
    await new Promise(resolve => setTimeout(resolve, 25));
  }
  assert.equal(queuedHistory.nativeTurns.find(turn => turn.id === queuedId)?.status, "completed");
  assert.equal(queuedHistory.queueControl.items.find(item => item.id === queuedId).status, "dispatched");
  assert.equal(queuedHistory.messages.find(message => message.id === queuedId).taskId, undefined);
  assert.equal(reads, 5);
  const callsBeforeCancel = modelCalls;
  holdStart = true;
  const delayed = { method: "continue", ...identity, operationId: randomUUID(), expectedRevision: 6,
    text: "Cancel while admission is pending." };
  const delayedResponse = rpc(delayed);
  await startEntered.promise;
  state = await ok(control("cancel"));
  holdStart = false; releaseStart.resolve();
  assert.equal((await delayedResponse).status, 409);
  assert.equal(modelCalls, callsBeforeCancel, "Cancellation fences a delayed admission before model dispatch.");
  const runningCasual = { method: "continue", ...identity, operationId: randomUUID(), expectedRevision: 6,
    text: "CONTROL_CASUAL_MODEL: cancel running ordinary conversation." };
  await ok(runningCasual); await casualModelSeen.promise;
  assert.equal((await rpc(control("create", { title: "Cannot replace active ordinary conversation" }))).status, 409);
  state = await ok(control("cancel")); releaseCasualModel.resolve();
  const cancelledCasual = await ui.managed.settled(identity, runningCasual.operationId);
  assert.equal(cancelledCasual.nativeTurns.at(-1).status, "cancelled");
  assert.equal(cancelledCasual.taskControl.stopped, false);
  assert.equal(cancelledCasual.taskControl.activeSessionId, null);
  const beforeCasualRestart = modelCalls;
  await ui.close(); ui = undefined; await native.close(); native = undefined; await storage.close(); storage = undefined;
  await open(); await start();
  const casualRestart = await ok({ method: "history", ...identity });
  assert.equal(casualRestart.taskControl.activeSessionId, null);
  assert.equal(casualRestart.messages.find(message => message.id === casual.operationId).taskId, undefined);
  assert(casualRestart.messages.some(message => message.id === queuedId));
  assert.equal(modelCalls, beforeCasualRestart, "Restart did not repeat an ordinary model request.");
  if (sourceIdentity) {
    const sourceControl = (kind, expectedRevision, title) => ({ method: "task-control", input: { ...sourceIdentity,
      operationId: randomUUID(), expectedRevision, kind, ...(title ? { title } : {}) } });
    const completed = await ok(sourceControl("complete", 0));
    assert.equal(completed.activeSessionId, null);
    const sourceCasual = { method: "continue", ...sourceIdentity, operationId: randomUUID(), expectedRevision: 0,
      text: "ORIGINAL_CASUAL: talk after the archived Task." };
    await ok(sourceCasual);
    const sourceAfterCasual = await ui.managed.settled(sourceIdentity, sourceCasual.operationId);
    assert.equal(sourceAfterCasual.metadata.sessionId, undefined);
    assert.equal(sourceAfterCasual.messages.find(message => message.id === sourceCasual.operationId).taskId, undefined);
    const created = await ok(sourceControl("create", completed.revision, "New Task after original completed Task"));
    assert.notEqual(created.activeSessionId, sourceTask.metadata.sessionId);
    assert.equal(created.tasks[0].authority, "archive_only"); assert.equal(created.tasks[1].authority, "native_core");
    const sourceHarness = await ok({ method: "harness", ...sourceIdentity, sessionId: sourceTask.metadata.sessionId });
    assert.equal(sourceHarness.metadataAuthority, "archive_only");
    assert(sourceHarness.history.messages.length > 0, "Finishing a source Task does not hide its history.");
    assert(!sourceHarness.history.messages.some(message => message.id === sourceCasual.operationId));
    const newHarness = await ok({ method: "harness", ...sourceIdentity, sessionId: created.activeSessionId });
    assert.equal(newHarness.record.nativeChat.workerState, undefined, "Fresh Task evidence never inherits an archived execution tree.");
    assert.deepEqual(newHarness.history.messages, []); assert.deepEqual(newHarness.sourceWorkers, []);
  }
  state = await ok(control("create", { title: "Stop actual parent and child" })); nativeTask = state.activeSessionId;
  const stopInput = { ...identity, operationId: randomUUID(), expectedRevision: 7, text: "CONTROL_STOP_CHILD: read, spawn one child, never retry." };
  await ok({ method: "continue", ...stopInput });
  const effect = await childRead.promise;
  assert.equal(effect.parent, stopInput.operationId); assert.equal(effect.sha256, digest(bytes)); assert.equal(reads, 7);
  const stopping = await ok({ method: "history", ...identity });
  assert.equal(stopping.nativeWorkers[0].status, "tool");
  state = await ok(control("pause"));
  const parentPaused = await ui.managed.settled(identity, stopInput.operationId);
  assert(parentPaused.nativeTurns.at(-1).uncertain);
  assert.equal(parentPaused.nativeWorkers[0].status, "tool", "Legacy pause stops the parent, not an already authorized child.");
  assert.equal(childAborted, false);
  state = await ok(control("resume"));
  assert.equal(reads, 7, "Resume only changes control flags; it does not redispatch the parent or child.");
  state = await ok(control("cancel"));
  const cancelled = await ui.managed.settled(identity, stopInput.operationId);
  assert(cancelled.nativeTurns.at(-1).uncertain); assert(cancelled.nativeWorkers[0].uncertain);
  assert.equal(cancelled.nativeWorkers[0].status, "cancelled");
  assert.equal(childAborted, true);
  const counts = { modelCalls, reads };
  state = await ok(control("resume"));
  assert.equal((await rpc({ method: "continue", ...identity, operationId: randomUUID(), expectedRevision: 8, text: "Never replay the unknown tool." })).status, 409);
  assert.equal((await rpc(control("complete"))).status, 409);
  assert.equal((await rpc(control("create", { title: "Cannot escape unknown outcome" }))).status, 409);
  state = await ok(control("pause"));
  await ui.close(); ui = undefined; await native.close(); native = undefined; await storage.close(); storage = undefined;
  await open(); await start();
  const recovered = await ok({ method: "history", ...identity });
  assert.deepEqual(recovered.taskControl, state);
  assert.equal(recovered.nativeWorkers[0].id, effect.child);
  assert(recovered.nativeWorkers[0].uncertain); assert(recovered.nativeTurns.at(-1).uncertain);
  assert.equal(recovered.nativeWorkers[0].replay, "never");
  assert.equal(recovered.taskControl.paused, true);
  const resumeAfterRestart = control("resume");
  state = await ok(resumeAfterRestart);
  assert.deepEqual(await ok(resumeAfterRestart), state, "A durable resume receipt must not redispatch an interrupted intent.");
  assert.equal((await rpc({ method: "continue", ...identity, operationId: randomUUID(), expectedRevision: 3,
    text: "Unknown child remains blocked after persisted pause and resume." })).status, 409);
  assert.deepEqual({ modelCalls, reads }, counts);
  for (const [file, bytes] of original) assert.deepEqual(readFileSync(join(root, file)), bytes, relative(root, file));
  assert.equal(inspectLegacyApiChatArchive(root).sourceFingerprint, before.sourceFingerprint);
});
