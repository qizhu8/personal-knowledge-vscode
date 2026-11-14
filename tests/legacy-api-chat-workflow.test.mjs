import assert from "node:assert/strict";
import { test } from "node:test";
import { createRequire } from "node:module";
import { randomUUID, createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync, rmSync, cpSync, chmodSync, readdirSync, lstatSync } from "node:fs";
import { resolve, join } from "node:path";
import { createServer } from "node:http";
import { inspectLegacyApiChatArchive } from "../dist/legacy-api-chat-archive.js";
import { prepareLegacyRootAdoptionExperimental, resumeLegacyRootAdoptionExperimental } from "../dist/legacy-root-adoption.js";
import { createNativeRuntime } from "../dist/native-runtime.js";
import { createLegacyManagedChatLocalModel } from "../dist/legacy-api-chat-managed-provider.js";
import { startLegacyApiChatUiHost } from "../dist/legacy-api-chat-ui-host.js";
import { ChatTurnToolError } from "../dist/chat-turn.js";
const require = createRequire(import.meta.url), project = resolve(new URL("../legacy", import.meta.url).pathname);
const digest = value => createHash("sha256").update(value).digest("hex");
const deferred = () => { let resolve; const promise = new Promise(value => { resolve = value; }); return { promise, resolve }; };

test("old queue under fresh authority: real HTTP steer/FIFO/edit/cancel/restart and user-required unknown abandonment never replay effects", { timeout: 90000 }, async t => {
  const directory = join(project, ".migration-test-work", `managed-workflow-${randomUUID()}`), root = join(directory, "knowledge");
  mkdirSync(root, { recursive: true, mode: 0o700 });
  let storage, native, ui, server;
  const steerRead = deferred(), releaseSteer = deferred(), modelSeen = deferred(), releaseModel = deferred(), unknownRead = deferred();
  const stopRead = deferred(), releaseStop = deferred();
  const knownDenied = deferred(), releaseDenial = deferred();
  const budgetRead = deferred(), releaseBudget = deferred();
  const cancelRead = deferred(), releaseCancelRead = deferred(), toolsEntered = deferred(), releaseTools = deferred();
  const steerUnknownRead = deferred(), releaseSteerUnknown = deferred(), steerUnknownEffect = deferred();
  const memoryEntered = deferred(), releaseMemory = deferred(), modelDispatches = [];
  t.after(async () => {
    releaseSteer.resolve(); releaseModel.resolve(); releaseStop.resolve(); releaseDenial.resolve(); releaseMemory.resolve();
    releaseBudget.resolve(); releaseCancelRead.resolve(); releaseTools.resolve(); releaseSteerUnknown.resolve();
    try { await ui?.close(); await native?.close(); await storage?.close(); }
    finally { if (server) { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
      rmSync(directory, { recursive: true, force: true }); }
  });
  const mask = process.umask(0o077);
  let chat, sourceId = randomUUID();
  try {
    if (process.env.PKM_MANAGED_API_CHAT_SOURCE) {
      const source = resolve(process.env.PKM_MANAGED_API_CHAT_SOURCE);
      assert(source.startsWith(join(project, ".migration-test-work") + "/") && source.endsWith("/knowledge"));
      cpSync(source, root, { recursive: true, dereference: false });
    } else {
      require("../legacy/tests/next-trial-electron/api-chat-fixture.cjs").create({ extension: project, root });
      mkdirSync(join(root, "notes"), { mode: 0o700 });
      writeFileSync(join(root, "notes/Existing.md"), "---\ntitle: Existing\nrevision: 1\n---\nSynthetic workflow.\n", { mode: 0o600 });
    }
    const visit = file => {
      const stat = lstatSync(file); assert(!stat.isSymbolicLink());
      chmodSync(file, stat.isDirectory() ? 0o700 : 0o600);
      if (stat.isDirectory()) for (const name of readdirSync(file)) visit(join(file, name));
    }; visit(root);
    const { ApiChatStore } = require("../legacy/dist/chat/api-chat-store.js");
    const store = new ApiChatStore(join(root, ".pkm/state"), "0123456789abcdef");
    chat = store.create(); store.startTask(chat, "Original workflow Task");
    chat.permissionMode = "allow-all";
    chat.queuedInputs = [{ id: sourceId, text: "ARCHIVED_QUEUE_INPUT", mode: "task" }];
    store.save(chat);
  } finally { process.umask(mask); }
  const identity = { namespace: chat.workspaceNamespace, chatId: chat.id }, archive = inspectLegacyApiChatArchive(root);
  const originals = new Map(archive.files.filter(file => lstatSync(join(root, file.path)).isFile())
    .map(file => [file.path, readFileSync(join(root, file.path))]));
  const nonce = randomUUID(), options = require("../legacy/tests/next-trial-electron/in-place-options.cjs").options;
  writeFileSync(join(directory, "in-place-fixture-token"), nonce, { mode: 0o600 });
  const prepared = await prepareLegacyRootAdoptionExperimental(root, options({ fixture: directory, root, nonce }));
  const open = async () => {
    storage = (await resumeLegacyRootAdoptionExperimental(root, options({ fixture: directory, root, nonce, workspaceId: prepared.workspaceId }))).storage;
    native = await createNativeRuntime({ storage, workspaceId: await storage.workspaceId() });
  }; await open();
  const bytes = `real-workflow-bytes-${randomUUID()}`;
  for (const name of ["queue-source.txt", "unknown-effect.txt", "stop-source.txt", "budget-source.txt", "cancel-source.txt", "steer-unknown-start.txt", "steer-unknown-effect.txt"]) writeFileSync(join(directory, name), bytes, { mode: 0o600 });
  const calls = [], reads = []; let reviewAllowed = false, queueAllowed = true, runGrants = Infinity, inflateTools = false, waitTools = false;
  server = createServer(async (request, response) => {
    try {
      assert.equal(request.headers.authorization, "Bearer fresh-workflow-only");
      const chunks = []; for await (const chunk of request) chunks.push(chunk);
      const body = JSON.parse(Buffer.concat(chunks).toString()), question = body.messages.findLast(message => message.role === "user").content;
      calls.push(question);
      if (question === "QUEUE_MODEL_HOLD") { modelSeen.resolve(); await releaseModel.promise; }
      if (question === "FRESH_AFTER_REVIEW") assert(!JSON.stringify(body.messages).includes("UNKNOWN_EFFECT"), "Abandoned instructions are not reconstructed as new prompts.");
      const result = body.messages.findLast(message => message.role === "tool");
      const needsRead = question === "STEER_UNKNOWN_EFFECT"
        ? !body.messages.slice(body.messages.findLastIndex(message => message.role === "user")).some(message => message.role === "tool")
        : ["WORKFLOW_ACTIVE", "UNKNOWN_EFFECT", "FRESH_AFTER_REVIEW", "STOP_STEER_ACTIVE", "KNOWN_QUEUE_FAILURE", "STEER_BUDGET_ACTIVE", "STEER_CANCEL_ACTIVE", "STEER_UNKNOWN_ACTIVE"].includes(question) && !result;
      if (result) assert.equal(JSON.parse(result.content).content, bytes);
      const delta = needsRead ? { tool_calls: [{ index: 0, id: question === "STEER_UNKNOWN_EFFECT" ? "steer-unknown-read" : "workflow-read", type: "function",
        function: { name: "read_file", arguments: JSON.stringify({ path: question === "UNKNOWN_EFFECT" ? "unknown-effect.txt"
          : question === "STOP_STEER_ACTIVE" ? "stop-source.txt" : question === "STEER_BUDGET_ACTIVE" ? "budget-source.txt"
          : question === "STEER_CANCEL_ACTIVE" ? "cancel-source.txt"
          : question === "STEER_UNKNOWN_ACTIVE" ? "steer-unknown-start.txt" : question === "STEER_UNKNOWN_EFFECT" ? "steer-unknown-effect.txt"
          : question === "KNOWN_QUEUE_FAILURE" ? "denied-before-read.txt" : "queue-source.txt" }) } }] }
        : { content: question.length >= 10000 ? "UNICODE_QUEUE_ACCEPTED" : `ACTUAL_WORKFLOW_RESULT:${question}` };
      response.writeHead(200, { "content-type": "text/event-stream" });
      response.end(`data: ${JSON.stringify({ choices: [{ index: 0, delta, finish_reason: null }] })}\n\n`
        + `data: ${JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: needsRead ? "tool_calls" : "stop" }] })}\n\ndata: [DONE]\n\n`);
    } catch (error) { response.writeHead(500); response.end(String(error)); }
  });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  const model = createLegacyManagedChatLocalModel({ endpoint: `http://127.0.0.1:${server.address().port}/v1`,
    model: "synthetic-workflow", apiKey: "fresh-workflow-only", tools: async () => {
      if (waitTools) { toolsEntered.resolve(); await releaseTools.promise; }
      return inflateTools ? Array.from({ length: 16 }, (_, index) => ({ name: `bounded_${index}`, description: "x".repeat(8192),
        parameters: { type: "object", properties: {} } }))
        : [{ name: "read_file", description: "Exact synthetic reads only.",
          parameters: { type: "object", properties: { path: { type: "string", enum: ["queue-source.txt", "unknown-effect.txt", "stop-source.txt", "budget-source.txt", "cancel-source.txt", "steer-unknown-start.txt", "steer-unknown-effect.txt", "denied-before-read.txt"] } }, required: ["path"], additionalProperties: false } }];
    } });
  const start = async () => {
    ui = await startLegacyApiChatUiHost({ storage, actorId: "private-workflow", chats: [identity], authorize: async () => true,
      provider: async () => { throw new Error("No plain fallback."); },
      managed: { model: { ...model, stream(request) {
          modelDispatches.push(request.messages.findLast(message => message.role === "user")?.content);
          return model.stream(request);
        } }, authorize: async binding => binding.chatId === chat.id && binding.root === root && (!binding.tool || binding.tool === "read_file"),
        memoryContext: async (_binding, request) => {
          if (request.messages.some(message => message.content === "MEMORY_CANCEL")) {
            memoryEntered.resolve(); await releaseMemory.promise;
          }
          return undefined;
        },
        authorizeQueue: async binding => queueAllowed && (binding.kind !== "run" || runGrants-- > 0),
        authorizeUserReview: async binding => binding.userRequired === true && reviewAllowed,
        tools: { available: true, async execute(request) {
          assert.equal(request.call.name, "read_file");
          if (request.call.arguments.path === "denied-before-read.txt") {
            knownDenied.resolve(); await releaseDenial.promise;
            throw new ChatTurnToolError("not-committed", "SYNTHETIC_KNOWN_DENIAL_BEFORE_FILESYSTEM_ACCESS");
          }
          const name = request.call.arguments.path; assert(["queue-source.txt", "unknown-effect.txt", "stop-source.txt", "budget-source.txt", "cancel-source.txt", "steer-unknown-start.txt", "steer-unknown-effect.txt"].includes(name));
          const content = readFileSync(join(directory, name), "utf8"); reads.push({ name, turn: request.turnId, sha256: digest(content) });
          if (name === "unknown-effect.txt" || name === "steer-unknown-effect.txt") {
            if (name === "unknown-effect.txt") unknownRead.resolve(); else steerUnknownEffect.resolve();
            await new Promise((_, reject) => {
              const abort = () => reject(new ChatTurnToolError("unknown", "REAL_READ_WITHOUT_ACK"));
              if (request.signal.aborted) abort(); else request.signal.addEventListener("abort", abort, { once: true });
            });
          } else if (name === "stop-source.txt") { stopRead.resolve(); await releaseStop.promise; }
          else if (name === "budget-source.txt") { budgetRead.resolve(); await releaseBudget.promise; }
          else if (name === "cancel-source.txt") { cancelRead.resolve(); await releaseCancelRead.promise; }
          else if (name === "steer-unknown-start.txt") { steerUnknownRead.resolve(); await releaseSteerUnknown.promise; }
          else if (reads.length === 1) { steerRead.resolve(); await releaseSteer.promise; }
          return { executionId: request.operationId, content: JSON.stringify({ path: name, content }) };
        } } },
    });
  }; await start();
  const rpc = async input => {
    const response = await fetch(`${ui.endpoint}/rpc`, { method: "POST", headers: { authorization: `Bearer ${ui.bearer}`,
      "x-pkm-native-actor": "private-workflow", "content-type": "application/json" }, body: JSON.stringify(input) });
    return { status: response.status, ...await response.json() };
  };
  const ok = async input => { const result = await rpc(input); assert.equal(result.status, 200, result.error); return result.value; };
  const history = () => ok({ method: "history", ...identity });
  const settle = async id => {
    const deadline = Date.now() + 15000;
    let current = await history();
    while (!current.nativeTurns.some(turn => turn.id === id) && Date.now() < deadline) {
      await new Promise(resolve => setTimeout(resolve, 20)); current = await history();
    }
    assert(current.nativeTurns.some(turn => turn.id === id), JSON.stringify(current.queueControl));
    return ui.managed.settled(identity, id);
  };
  const queue = async (kind, extra = {}) => ({ method: "queue", input: { ...identity, kind,
    operationId: randomUUID(), expectedRevision: (await history()).queueControl.revision, ...extra } });
  const control = async kind => ({ method: "task-control", input: { ...identity, kind,
    operationId: randomUUID(), expectedRevision: (await history()).taskControl.revision } });
  const send = async text => { const input = { ...identity, operationId: randomUUID(), expectedRevision: (await history()).revision, text };
    await ok({ method: "continue", ...input }); return input; };
  const enqueue = async (text, mode = "task", attemptId) => {
    const id = randomUUID(); const input = await queue("enqueue", { submissionId: id, text, mode, taskSessionId: chat.sessionId, ...(attemptId ? { attemptId } : {}) });
    input.input.operationId = id;
    await ok(input); return { id, input };
  };
  let snapshot = await ok({ method: "outcome-review", ...identity });
  assert(snapshot.sourceUncertain); assert.equal(snapshot.sourceEffects.queuedInputs[0].id, sourceId);
  const initialReview = { method: "outcome-decide", input: { ...identity, operationId: randomUUID(), expectedDigest: snapshot.digest,
    decision: "abandon-without-replay", reason: "Archive only. Do not execute or inherit the missing old window context." } };
  assert.equal((await rpc(initialReview)).status, 409); assert.equal(calls.length, 0);
  reviewAllowed = true; await ok(initialReview); assert.equal(calls.length, 0);
  const active = await send("WORKFLOW_ACTIVE"); await steerRead.promise;
  const activeReview = await ok({ method: "outcome-review", ...identity });
  assert.equal((await rpc({ method: "outcome-decide", input: { ...identity, operationId: randomUUID(),
    expectedDigest: activeReview.digest, decision: "abandon-without-replay", reason: "Must not decide during live execution." } })).status, 409);
  for (const [text, attemptId] of [["Wrong attempt", randomUUID()], ["start a new task: not steering", active.operationId]]) {
    assert.equal((await rpc(await queue("enqueue", { submissionId: randomUUID(), text, mode: "steer",
      taskSessionId: chat.sessionId, attemptId }))).status, 409);
  }
  const steering = await enqueue("Change criterion under this same attempt.", "steer", active.operationId);
  const token = randomUUID();
  await ok(await queue("edit", { id: steering.id, action: "begin", token }));
  assert.equal((await rpc(await queue("edit", { id: steering.id, action: "save", token: randomUUID(), text: "Wrong editor" }))).status, 409);
  await ok(await queue("edit", { id: steering.id, action: "save", token, text: "STEER_ACTUALLY_APPLIED" }));
  releaseSteer.resolve();
  const steered = await ui.managed.settled(identity, active.operationId);
  assert.equal(steered.messages.at(-1).content, "ACTUAL_WORKFLOW_RESULT:STEER_ACTUALLY_APPLIED");
  assert(steered.messages.some(message => message.inputKind === "steer" && message.submissionId === steering.id));
  assert.equal(reads.length, 1);
  const held = await send("QUEUE_MODEL_HOLD"); await modelSeen.promise;
  const a = await enqueue("QUEUED_A"), b = await enqueue("QUEUED_B");
  const revision = (await history()).queueControl.revision;
  const retried = await ok({ ...a.input, input: { ...a.input.input, expectedRevision: revision } });
  assert.equal(retried.revision, revision);
  assert.equal(retried.items.filter(item => item.id === a.id).length, 1);
  assert.equal((await rpc({ ...a.input, input: { ...a.input.input, expectedRevision: revision, text: "Other input" } })).status, 409);
  assert.equal(calls.filter(item => item === "QUEUED_A").length, 0);
  const fill = [];
  for (let index = 0; index < 18; index++) fill.push(await enqueue(`NEVER_EXECUTE_FILL_${index}`));
  assert.equal((await rpc(await queue("enqueue", { submissionId: randomUUID(), text: "Twenty-first input",
    mode: "task", taskSessionId: chat.sessionId }))).status, 409);
  for (const item of fill) await ok(await queue("remove", { id: item.id }));
  assert.deepEqual(await ok(a.input), JSON.parse(JSON.stringify((await rpc(a.input)).value)));
  assert.equal((await rpc({ ...a.input, input: { ...a.input.input, text: "Conflicting replay" } })).status, 409);
  await ok(await control("cancel")); releaseModel.resolve(); await ui.managed.settled(identity, held.operationId);
  await ok(await control("resume"));
  const count = calls.length;
  await ui.close(); ui = undefined; await native.close(); native = undefined; await storage.close(); storage = undefined;
  await open(); await start();
  assert.equal(calls.length, count); assert.equal((await history()).queueControl.needsReview, true);
  runGrants = 1;
  const dispatch = await ok(await queue("run"));
  const blockedDeadline = Date.now() + 10000;
  let blocked = await history();
  while (blocked.queueControl.revision === dispatch.revision && Date.now() < blockedDeadline) {
    await new Promise(resolve => setTimeout(resolve, 20)); blocked = await history();
  }
  assert(blocked.queueControl.needsReview, "Revoked dispatch authority retains the queue for explicit review, never silent retry.");
  assert.equal(calls.length, count); assert(!blocked.nativeTurns.some(turn => turn.id === a.id));
  runGrants = Infinity;
  await ok(await queue("run"));
  await settle(a.id);
  const deadline = Date.now() + 10000;
  while (!(await history()).nativeTurns.some(turn => turn.id === b.id) && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 20));
  await settle(b.id);
  assert.deepEqual(calls.slice(-2), ["QUEUED_A", "QUEUED_B"]);
  const unknown = await send("UNKNOWN_EFFECT"); await unknownRead.promise;
  const fresh = await enqueue("FRESH_AFTER_REVIEW");
  await ok(await control("cancel")); await ui.managed.settled(identity, unknown.operationId); await ok(await control("resume"));
  snapshot = await ok({ method: "outcome-review", ...identity });
  const decision = { method: "outcome-decide", input: { ...identity, operationId: randomUUID(), expectedDigest: snapshot.digest,
    decision: "abandon-without-replay", reason: "The real read lacks an acknowledgement. Preserve unknown, never retry it; only run the distinct queued intent." } };
  reviewAllowed = false; assert.equal((await rpc(decision)).status, 409);
  reviewAllowed = true;
  assert.equal((await rpc({ ...decision, input: { ...decision.input, expectedDigest: "0".repeat(64) } })).status, 409);
  const beforeReview = calls.length;
  const decided = await ok(decision); assert.equal(decided.outcome, "still-unknown"); assert.deepEqual(await ok(decision), decided);
  assert.equal(calls.length, beforeReview); assert.equal((await history()).queueControl.needsReview, true);
  queueAllowed = false; assert.equal((await rpc(await queue("run"))).status, 409); queueAllowed = true;
  await ok(await queue("run")); await settle(fresh.id);
  const reviewed = await history();
  assert.equal(reviewed.nativeTurns.find(turn => turn.id === unknown.operationId).status, "cancelled");
  assert(reviewed.nativeTurns.find(turn => turn.id === unknown.operationId).uncertain);
  assert.equal(reviewed.nativeTurns.find(turn => turn.id === unknown.operationId).userReview.outcome, "still-unknown");
  assert.equal(reads.filter(read => read.name === "unknown-effect.txt").length, 1);
  const adopted = randomUUID();
  await ok(await queue("adopt", { sourceId, submissionId: adopted, taskSessionId: chat.sessionId }));
  await settle(adopted);
  assert.equal(calls.at(-1), "ARCHIVED_QUEUE_INPUT");
  assert.equal((await history()).archivedQueue[0].imported, true);
  assert.equal((await rpc(await queue("adopt", { sourceId, submissionId: randomUUID(), taskSessionId: chat.sessionId }))).status, 409);
  const unicode = await enqueue("中".repeat(16000));
  const unicodeTurn = await settle(unicode.id);
  assert.equal(unicodeTurn.nativeTurns.at(-1).status, "completed");
  assert.equal(unicodeTurn.messages.at(-1).content, "UNICODE_QUEUE_ACCEPTED");
  assert.equal(calls.at(-1), "中".repeat(16000), "The original 16,000-character queue bound supports multibyte text too.");
  const beforeStop = calls.length, stop = await send("STOP_STEER_ACTIVE");
  await stopRead.promise;
  const stopSteer = await enqueue("pause the current task", "steer", stop.operationId);
  releaseStop.resolve();
  const stopped = await ui.managed.settled(identity, stop.operationId);
  assert.equal(stopped.nativeTurns.at(-1).status, "cancelled"); assert.equal(stopped.nativeTurns.at(-1).uncertain, false);
  assert(stopped.metadata.paused); assert.equal(calls.length, beforeStop + 1, "A stop steer prevents the next actual model request.");
  assert.equal((await history()).queueControl.items.find(item => item.id === stopSteer.id).status, "queued");
  await ok(await queue("remove", { id: stopSteer.id }));
  await ok(await control("resume")); assert.equal(calls.length, beforeStop + 1);
  const failed = await send("KNOWN_QUEUE_FAILURE"); await knownDenied.promise;
  const following = await enqueue("FOLLOWING_KNOWN_FAILURE");
  const beforeDenial = calls.length; releaseDenial.resolve();
  const denied = await ui.managed.settled(identity, failed.operationId);
  assert.equal(denied.nativeTurns.at(-1).status, "failed"); assert.equal(denied.nativeTurns.at(-1).uncertain, false);
  const failureDeadline = Date.now() + 10000;
  while (!(await history()).queueControl.needsReview && Date.now() < failureDeadline) await new Promise(resolve => setTimeout(resolve, 20));
  assert((await history()).queueControl.needsReview); assert.equal(calls.length, beforeDenial);
  await ok(await queue("run")); await settle(following.id);
  assert.equal(calls.at(-1), "FOLLOWING_KNOWN_FAILURE");
  assert.equal(calls.filter(question => question === "KNOWN_QUEUE_FAILURE").length, 1, "Explicit Run continues remaining distinct work, never retries the failed intent.");
  const budget = await send("STEER_BUDGET_ACTIVE");
  await budgetRead.promise;
  const retainedSteer = await enqueue("RETAINED_AFTER_BUDGET_" + "x".repeat(12000), "steer", budget.operationId);
  inflateTools = true;
  releaseBudget.resolve();
  const budgetResult = await ui.managed.settled(identity, budget.operationId);
  assert.equal(budgetResult.nativeTurns.find(turn => turn.id === budget.operationId).status, "failed");
  assert.equal(ui.managed.turns.get("legacy-managed:private-workflow", budget.operationId).failure, "INPUT_TOKEN_LIMIT");
  assert.equal(budgetResult.queueControl.items.find(item => item.id === retainedSteer.id).status, "queued");
  assert(!budgetResult.messages.some(message => message.submissionId === retainedSteer.id));
  assert.equal(calls.filter(question => question.startsWith("RETAINED_AFTER_BUDGET_")).length, 0);
  inflateTools = false;
  await ui.close(); ui = undefined; await native.close(); native = undefined; await storage.close(); storage = undefined;
  await open(); await start();
  assert.equal((await history()).queueControl.items.find(item => item.id === retainedSteer.id).status, "queued");
  assert((await history()).queueControl.needsReview);
  assert.equal(calls.filter(question => question.startsWith("RETAINED_AFTER_BUDGET_")).length, 0);
  await ok(await queue("run"));
  await settle(retainedSteer.id);
  assert.equal(calls.filter(question => question.startsWith("RETAINED_AFTER_BUDGET_")).length, 1);
  const cancelled = await send("STEER_CANCEL_ACTIVE");
  await cancelRead.promise;
  const cancelledSteer = await enqueue("RETAINED_AFTER_CANCEL", "steer", cancelled.operationId);
  waitTools = true; releaseCancelRead.resolve();
  await toolsEntered.promise;
  await ok(await control("cancel"));
  releaseTools.resolve(); waitTools = false;
  const cancelResult = await ui.managed.settled(identity, cancelled.operationId);
  assert.equal(cancelResult.queueControl.items.find(item => item.id === cancelledSteer.id).status, "queued");
  assert(!cancelResult.messages.some(message => message.submissionId === cancelledSteer.id));
  assert(!calls.includes("RETAINED_AFTER_CANCEL"));
  await ok(await control("resume"));
  await ok(await queue("remove", { id: cancelledSteer.id }));
  const activeUnknown = await send("STEER_UNKNOWN_ACTIVE");
  await steerUnknownRead.promise;
  const appliedUnknown = await enqueue("STEER_UNKNOWN_EFFECT", "steer", activeUnknown.operationId);
  releaseSteerUnknown.resolve();
  await Promise.race([steerUnknownEffect.promise, ui.managed.settled(identity, activeUnknown.operationId).then(value => {
    throw new Error(`Steered unknown effect was not dispatched: ${JSON.stringify(value.nativeTurns.at(-1))}`);
  })]);
  await ok(await control("cancel"));
  const uncertainSteer = await ui.managed.settled(identity, activeUnknown.operationId);
  assert(uncertainSteer.nativeTurns.find(turn => turn.id === activeUnknown.operationId).uncertain);
  assert.equal(uncertainSteer.queueControl.items.find(item => item.id === appliedUnknown.id).status, "applied");
  await ok(await control("resume"));
  const beforeUnknownRestart = calls.length;
  await ui.close(); ui = undefined; await native.close(); native = undefined; await storage.close(); storage = undefined;
  await open(); await start();
  assert.equal(calls.length, beforeUnknownRestart);
  snapshot = await ok({ method: "outcome-review", ...identity });
  await ok({ method: "outcome-decide", input: { ...identity, operationId: randomUUID(), expectedDigest: snapshot.digest,
    decision: "abandon-without-replay", reason: "The steered tool result is unknown; preserve its evidence without replay." } });
  assert.equal(calls.filter(question => question === "STEER_UNKNOWN_EFFECT").length, 1);
  assert.equal(reads.filter(read => read.name === "steer-unknown-effect.txt").length, 1);
  const memory = await send("MEMORY_CANCEL");
  await memoryEntered.promise;
  await ok(await control("cancel"));
  releaseMemory.resolve();
  await ui.managed.settled(identity, memory.operationId);
  assert(!modelDispatches.includes("MEMORY_CANCEL"), "Cancellation while memory is pending must prevent the model port from being invoked.");
  for (const [file, bytes] of originals) assert.deepEqual(readFileSync(join(root, file)), bytes);
});
