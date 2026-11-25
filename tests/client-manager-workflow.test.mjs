import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { VscodeClient } from "../clients/vscode/client.ts";
import { ManagerWorkflow, managerWorkflowScope } from "../clients/vscode/workflow-surfaces.ts";
import { operations } from "../clients/vscode/contracts.ts";
import { managerRuntimeStart } from "../dist/manager-runtime-contracts.js";
import { bindWebview } from "../clients/vscode/bridge.ts";
import { managerActor, nativeWorkspace, syntheticManager, until, pin } from "./batch06-manager-fixtures.mjs";
import { createSyntheticProvider } from "./chat-turn-native-fixtures.mjs";

async function connect(t, fixture, actor = managerActor, transform) {
  const origin = await fixture.listen(actor);
  const workspaceId = await fixture.storage.workspaceId();
  const requests = [], states = [];
  const client = new VscodeClient({
    secrets: { get: async key => key === "batch26.synthetic" ? fixture.bearer : undefined },
    attestServer: async (endpoint, info) => {
      assert.equal(endpoint, origin);
      assert.equal(info.workspaceId, workspaceId);
      assert.equal(info.actorId, actor.id);
      return { serverId: "pkm-v5", workspaceId, actorId: actor.id, protocolVersion: "v1" };
    },
    fetch: async (url, init) => {
      assert.equal(new URL(url).origin, origin, "only the disposable loopback server is contacted");
      assert.equal(init.headers.authorization, `Bearer ${fixture.bearer}`);
      const request = { method: url.split("/").at(-1), body: JSON.parse(init.body) };
      requests.push(request);
      const response = await fetch(url, init);
      return transform ? transform(request, response) : response;
    },
    onState: state => states.push(state),
  }, { origin, secretKey: "batch26.synthetic", expectedWorkspaceId: workspaceId });
  t.after(() => client.dispose());
  assert.equal((await client.connect()).status, "connected");
  return { client, requests, states, origin };
}
const deferred = () => {
  let release;
  const promise = new Promise(resolve => { release = resolve; });
  return { promise, release };
};
const code = expected => error => error.code === expected && error.effect === "not-committed";

test("actor-private typed receipt reads prove exact raw-wire pins without disclosing arguments or treating missing as noncommitted", async t => {
  const fixture = await nativeWorkspace(t), first = await connect(t, fixture);
  const body = { operation: "knowledge.document.create", version: 1, arguments: {
    content: "Private receipt fixture content", title: "  Raw wire title  ", id: "receipt-fixture-doc", operationId: randomUUID(),
  } };
  const post = input => fetch(`${first.origin}/v1/capability_call`, {
    method: "POST", headers: { authorization: `Bearer ${fixture.bearer}`, "content-type": "application/json" },
    body: JSON.stringify(input),
  });
  const created = await (await post(body)).json();
  assert.equal(created.result.title, "Raw wire title");
  const pin = { operationId: body.arguments.operationId, operation: body.operation,
    bodySha256: createHash("sha256").update(JSON.stringify(body)).digest("hex") };
  const receipt = await first.client.receiptGet(pin);
  assert.equal(receipt.state, "committed");
  assert.equal(receipt.actorId, managerActor.id);
  assert.deepEqual(Object.keys(receipt).sort(), ["actorId", "bodySha256", "operation", "operationId", "receiptSha256", "schema", "state"]);
  const foreign = await connect(t, fixture, { id: "receipt-foreign-reader", canWrite: false });
  assert.equal((await foreign.client.receiptGet(pin)).state, "unknown");
  for (const changed of [{ bodySha256: "b".repeat(64) }, { operationId: randomUUID() }, { operation: "knowledge.document.update" }])
    assert.equal((await first.client.receiptGet({ ...pin, ...changed })).state, "unknown");

  const chatInput = { id: randomUUID(), operationId: randomUUID(), expectedRevision: 0, title: "Receipt-owned Chat" };
  await first.client.chatCreate(chatInput);
  const chatBody = first.requests.find(item => item.method === "capability_call" && item.body.operation === "chat.session.create").body;
  assert.equal((await first.client.receiptGet({ operationId: chatInput.operationId, operation: chatBody.operation,
    bodySha256: createHash("sha256").update(JSON.stringify(chatBody)).digest("hex") })).state, "committed");

  const held = deferred(), entered = deferred(), bind = fixture.storage.bindBrowserMutationPin.bind(fixture.storage);
  const waiting = { ...body, arguments: { ...body.arguments, id: "receipt-fixture-held", operationId: randomUUID() } };
  fixture.storage.bindBrowserMutationPin = async (...args) => {
    await bind(...args);
    if (args[0].args.operationId === waiting.arguments.operationId) { entered.release(); await held.promise; }
  };
  fixture.addCleanup(held.release);
  const pending = post(waiting);
  await entered.promise;
  const waitingPin = { operationId: waiting.arguments.operationId, operation: waiting.operation,
    bodySha256: createHash("sha256").update(JSON.stringify(waiting)).digest("hex") };
  assert(["pending", "unknown"].includes((await first.client.receiptGet(waitingPin)).state));
  held.release();
  assert.equal((await pending).status, 200);
  assert.equal((await first.client.receiptGet(waitingPin)).state, "committed");
});

test("typed Extension clients share server-owned Chat, reattach after disconnect, cancel and archive without replay", async t => {
  const gate = deferred();
  const provider = createSyntheticProvider({ onOpen: async () => { await gate.promise; } });
  const fixture = await nativeWorkspace(t, { ...provider,
    toolCatalog: [{ name: "create_document", operation: "knowledge.document.create" }],
    reviewer: async request => ({ actorId: request.actorId, decisionId: randomUUID(), decision: "reject" }),
  });
  fixture.addCleanup(gate.release);
  const first = await connect(t, fixture);
  const second = await connect(t, fixture);
  const sessionId = randomUUID();
  const created = await first.client.chatCreate({ id: sessionId, title: "Shared durable Chat",
    operationId: randomUUID(), expectedRevision: 0 });
  const input = { id: randomUUID(), sessionId, operationId: randomUUID(), expectedRevision: 0,
    expectedSessionRevision: created.revision, messages: [{ role: "user", content: "Durable Extension input" }] };
  assert.throws(() => operations.chatStart.input.parse({ ...input, expectedSessionRevision: undefined }));
  assert.throws(() => operations.chatStart.input.parse({ ...input, messages: [{ role: "system", content: "forged" }] }));
  const accepted = await first.client.chatStart(input);
  await until(() => provider.counts().modelCalls === 1);
  first.client.disconnect();
  const discovery = await second.client.chatTurns({ sessionId, limit: 20 });
  assert.equal(discovery.items[0].id, accepted.id);
  assert.equal(discovery.items[0].status, "model");
  assert.equal((await second.client.chatMessages({ id: sessionId })).items[0].content, "Durable Extension input");
  await assert.rejects(second.client.chatArchive({ id: sessionId, expectedRevision: 2, operationId: randomUUID() }),
    error => error.code === "CONFLICT");
  const cancelled = await second.client.chatCancel({ id: accepted.id, expectedRevision: discovery.items[0].revision,
    operationId: randomUUID() });
  assert.equal(cancelled.status, "cancelled");
  gate.release();
  await fixture.runtime.services.chatTurns.settled(managerActor.id, accepted.id);
  assert.equal(provider.counts().modelCalls, 1);
  assert.equal((await first.client.connect()).status, "connected");
  const transcript = await first.client.chatMessages({ id: sessionId });
  assert.deepEqual(transcript.items.map(message => [message.role, message.status]),
    [["user", "complete"], ["assistant", "cancelled"]]);
  const archived = await second.client.chatArchive({ id: sessionId, expectedRevision: transcript.revision,
    operationId: randomUUID() });
  assert.notEqual(archived.archivedAt, null);
  assert.equal((await first.client.chatList({})).items.length, 0);
  assert.equal((await first.client.chatList({ includeArchived: true })).items[0].id, sessionId);
  assert.equal([...first.requests, ...second.requests].some(request => request.body.operation === "chat.session.append"), false);
});

test("typed Extension Chat retains exact mutation receipt identity when a successful server response is malformed", async t => {
  const fixture = await nativeWorkspace(t);
  let corrupted = false;
  const { client } = await connect(t, fixture, managerActor, async (request, response) => {
    if (!corrupted && request.method === "capability_call" && request.body?.operation === "chat.session.create") {
      corrupted = true;
      const envelope = await response.json();
      envelope.result = { schema: "unexpected" };
      return new Response(JSON.stringify(envelope), { status: 200, headers: { "content-type": "application/json" } });
    }
    return response;
  });
  const input = { id: randomUUID(), title: "Preserved receipt", operationId: randomUUID(), expectedRevision: 0 };
  await assert.rejects(client.chatCreate(input), error => error.code === "INVALID_CHAT_RESPONSE" && error.effect === "unknown");
  assert(client.state().pending.includes(input.operationId));
  assert.equal((await client.retryMutation(input.operationId)).id, input.id);
  assert.deepEqual(client.state().pending, []);
  assert.equal((await client.chatList()).items.length, 1);
});

test("typed VS Code Manager starts two native workers over authenticated HTTP, queues pinned feedback without blocking siblings and accepts exact E2E evidence", async t => {
  const manager = syntheticManager("feature", 2, { hold: true, publish: true });
  const sibling = deferred();
  let siblingEntered = false;
  const worker = manager.host.worker;
  manager.host.worker = async (input, signal) => {
    if (input.task.taskId === "worker-2") {
      siblingEntered = true;
      await sibling.promise;
    }
    return worker(input, signal);
  };
  const fixture = await nativeWorkspace(t, { manager: manager.config });
  fixture.addCleanup(() => { sibling.release(); manager.release(); });
  const { client, requests, states } = await connect(t, fixture);
  assert(client.state().capabilities.includes("managerStart"));
  assert(client.state().capabilities.includes("managerGet"));
  const input = manager.start("batch26-live");
  assert.deepEqual(operations.managerStart.input.parse(input), managerRuntimeStart.parse(input),
    "client uses the native bounded completion contract and budget");
  const lifecycle = new ManagerWorkflow(client, input.runId);
  const { runId: _runId, ...start } = input;
  const started = await lifecycle.start(start);
  assert.equal(started.schema, "pkm.manager.runtime/v1");
  assert.equal(started.runId, input.runId);
  assert.deepEqual(await lifecycle.start(start), started, "duplicate start replays the exact durable receipt");
  await until(() => siblingEntered && manager.calls.published === 1, "two independent native workers entered");
  const active = await lifecycle.reconcile();
  assert.equal(active.state, "active");
  assert.deepEqual(active.doing.map(task => task.taskId).sort(), ["worker-1", "worker-2"]);
  assert.equal(active.acceptance.status, "not-accepted");
  const early = await lifecycle.progress();
  const delivery = early.events.find(event => event.taskId === "worker-1" && event.result)?.result;
  assert(delivery, "live delivery is visible before the worker returns");
  assert.equal(delivery.verificationGrade, "delivery");
  assert.equal(delivery.verificationStatus, "pending");
  assert.equal(delivery.artifact.sourcePin.value, pin("a"));
  assert.equal(early.snapshot.completed.some(task => task.taskId === "worker-1"), false);
  assert.equal(manager.calls.integrate.length + manager.calls.verify.length, 0,
    "worker publication is not parent acceptance");
  const feedback = {
    operationId: randomUUID(), expectedVersion: early.snapshot.version,
    target: { kind: "result", taskId: "worker-1", attemptId: delivery.attemptId, resultId: delivery.id },
    message: "Revise only worker-1's acceptance detail.",
  };
  const receipt = await lifecycle.feedback(feedback);
  assert.equal(receipt.schema, "pkm.manager.progress.feedback-receipt/v1");
  assert.deepEqual(receipt.target, feedback.target);
  assert.equal(receipt.status, "applied");
  assert.equal(manager.calls.active, 1, "ordinary feedback returns while worker-1 is still held");
  assert.deepEqual(await lifecycle.feedback(feedback), receipt, "duplicate feedback returns identical receipt");
  await assert.rejects(lifecycle.feedback({ ...feedback, message: "Changed duplicate." }), code("CONFLICT"));
  await assert.rejects(lifecycle.feedback({ ...feedback, operationId: randomUUID() }), code("CONFLICT"));
  assert.equal((await client.managerGet({ runId: input.runId })).feedback.length, 1,
    "duplicate and stale feedback do not queue additional work");

  sibling.release();
  const siblingDone = await until(async () => {
    const snapshot = await lifecycle.reconcile();
    return snapshot.completed.some(task => task.taskId === "worker-2") && snapshot;
  }, "unrelated sibling proceeds after feedback while first worker remains held");
  assert.equal(siblingDone.state, "active");
  assert(siblingDone.doing.some(task => task.taskId === "worker-1"));
  assert.equal(siblingDone.integration.outputPin, null);
  assert.equal(siblingDone.verification.checks.length, 0);
  manager.release();
  const accepted = await until(async () => {
    const snapshot = await lifecycle.reconcile();
    return snapshot.acceptance.status === "accepted" && snapshot;
  }, "exact integrate/verify/acceptance");
  assert.equal(accepted.state, "succeeded");
  assert.equal(accepted.phase.label, "Accepted");
  assert.deepEqual(accepted.workers.map(task => [task.taskId, task.state]).sort(),
    [["worker-1", "completed"], ["worker-2", "completed"]]);
  assert.deepEqual(accepted.integration, {
    freezePin: pin("c"), outputPin: pin("e"),
    checks: [{ kind: "integration", result: { ok: true, pin: pin("e") }, pin: pin("c") }],
  });
  assert.deepEqual(accepted.verification.checks, [{ kind: "e2e", result: { ok: true, pin: pin("f") }, pin: pin("c") }]);
  assert.deepEqual(accepted.acceptance, { status: "accepted", pin: pin("f") });
  assert.equal(manager.calls.peak, 2);
  assert.equal(manager.calls.freeze.length, 1);
  assert.equal(manager.calls.integrate.length, 1);
  assert.equal(manager.calls.verify.length, 1);
  assert.deepEqual(manager.calls.worker.map(call => [call.taskId, call.feedback]),
    [["worker-1", []], ["worker-2", []], ["worker-1", [feedback.message]]]);
  assert.deepEqual(manager.calls.freeze[0].deliveries.map(item => [item.taskId, item.delivery.pin]).sort(),
    [["worker-1", pin("b")], ["worker-2", pin("a")]]);
  assert.equal(manager.calls.verify[0].freeze, pin("c"));
  assert.equal(manager.calls.verify[0].integration, pin("e"));
  assert.deepEqual(manager.calls.verify[0].contract, input.contract);
  const final = await lifecycle.progress();
  assert.equal(final.hasMore, false);
  assert(final.snapshot.results.some(result => result.scope === "run" && result.verificationGrade === "integration"
    && result.verificationStatus === "passed" && result.artifact.sourcePin.value === pin("e")));
  assert(final.snapshot.results.some(result => result.scope === "run" && result.verificationGrade === "accepted"
    && result.verificationStatus === "passed" && result.artifact.sourcePin.value === pin("f")));
  assert(requests.some(request => request.method === "capability_call" && request.body.operation === "manager.runtime.start"));
  assert(requests.some(request => request.method === "capability_read" && request.body.operation === "manager.runtime.get"));
  assert(requests.every(request => !/authorize|approve|resume/.test(request.body.operation ?? "")));
  assert(!JSON.stringify(states).includes(fixture.bearer));
  assert.equal(client.state().pending.length, 0);

  const resumed = new ManagerWorkflow(client, input.runId, { cursor: final.cursor });
  const tail = await resumed.progress();
  assert.equal(tail.events.length, 0);
  assert.equal(tail.eventsMayBeMissing, false, "opaque reconnect cursor does not invent a gap");
  assert.equal(tail.snapshot.acceptance.status, "accepted");
  const head = await client.managerEvents({ runId: input.runId, afterSeq: 0, limit: 1 });
  const db = new DatabaseSync(resolve(fixture.root, "core.sqlite"));
  try {
    assert.equal(db.prepare("DELETE FROM manager_runtime_events WHERE actor_id=? AND run_id=? AND seq=2")
      .run(managerActor.id, input.runId).changes, 1, "fixture-only retention fault creates a real durable cursor gap");
  } finally { db.close(); }
  const readsBefore = requests.length;
  const gap = await new ManagerWorkflow(client, input.runId, { cursor: head.nextCursor }).progress();
  assert.equal(gap.eventsMayBeMissing, true);
  assert.equal(gap.snapshotRefreshed, true);
  assert.equal(gap.snapshot.acceptance.status, "accepted", "gap refresh reconciles native evidence, not missing events");
  assert(requests.slice(readsBefore).some(request => request.body.operation === "manager.runtime.get"));
  assert(requests.slice(readsBefore).some(request => request.body.operation === "manager.progress.get"));
});

test("native capability availability, task authorization and strict client shapes remain trust boundaries", async t => {
  const disabled = await nativeWorkspace(t);
  const { client: unavailable } = await connect(t, disabled);
  const manager = syntheticManager("feature", 2, { host: { authorizeTask: () => false } });
  const input = manager.start("batch26-denied");
  assert(!unavailable.state().capabilities.includes("managerStart"));
  await assert.rejects(unavailable.managerStart(input), code("CAPABILITY_UNAVAILABLE"));
  const fixture = await nativeWorkspace(t, { manager: manager.config });
  const { client } = await connect(t, fixture);
  for (const extra of [{ actorId: "forged" }, { nativeOwnerId: "forged" }, { authorized: true }, { plan: manager.plan }]) {
    await assert.rejects(client.managerStart({ ...input, ...extra }), code("INVALID_ARGUMENT"));
    assert.equal(operations.managerStart.input.safeParse({ ...input, ...extra }).success,
      managerRuntimeStart.safeParse({ ...input, ...extra }).success);
  }
  await client.managerStart(input);
  const denied = await until(async () => {
    const run = await client.managerGet({ runId: input.runId });
    return run.state === "paused" && run;
  }, "native per-task authorization denies dispatch");
  assert.equal(manager.calls.worker.length, 0, "client capability is not native task permission");
  assert.equal(denied.checks.length, 0);
  assert.equal((await new ManagerWorkflow(client, input.runId).reconcile()).acceptance.status, "not-accepted");
  const { client: reader } = await connect(t, fixture, { ...managerActor, canWrite: false });
  assert(!reader.state().capabilities.includes("managerStart"));
  assert(!reader.state().capabilities.includes("managerFeedback"));
  await assert.rejects(reader.managerStart({ ...input, runId: "reader-start" }), code("CAPABILITY_UNAVAILABLE"));
  await assert.rejects(client.managerEvents({ runId: input.runId, afterSeq: 0, cursor: "cursor123" }), code("INVALID_ARGUMENT"));
  await assert.rejects(client.managerFeedback({ operationId: randomUUID(), runId: input.runId,
    expectedVersion: denied.version, target: { kind: "run" }, message: "Escalate", urgent: true }), code("INVALID_ARGUMENT"));
  const replies = [];
  const source = {};
  let receive;
  const webview = bindWebview(client, {
    onMessage: listener => { receive = listener; return { dispose() {} }; },
    postMessage: async message => { replies.push(message); },
  }, source);
  try {
    receive({ source, message: { requestId: "start-injection", action: "managerStart",
      input: { ...input, authorized: true, nativeOwnerId: "forged" } } });
    await until(() => replies.length === 1, "webview rejects manager authorization fields");
    assert.equal(replies.at(-1).error.code, "INVALID_ARGUMENT");
    receive({ source, message: { requestId: "review-injection", action: "openHumanReview", input: {} } });
    await until(() => replies.length === 2, "webview rejects native human review");
    assert.equal(replies.at(-1).error.code, "INVALID_ACTION");
    assert.equal(manager.calls.worker.length, 0);
    await assert.rejects(client.openHumanReview(), code("HUMAN_REVIEW_UNAVAILABLE"));
  } finally { webview.dispose(); }
  assert(managerWorkflowScope.notImplemented.includes("chat-or-webview-manager-authorization"));
  assert(managerWorkflowScope.notImplemented.includes("native-provider-or-worker-parity"));
});

test("malformed Manager write replies retain exact retry bodies; explicit cancellation fences held work without acceptance", async t => {
  const manager = syntheticManager("small", 1, { hold: true, publish: true });
  const fixture = await nativeWorkspace(t, { manager: manager.config });
  fixture.addCleanup(manager.release);
  let corruptOperation = "manager.runtime.start";
  const { client, requests } = await connect(t, fixture, managerActor, async (request, response) => {
    if (request.method !== "capability_call" || request.body.operation !== corruptOperation) return response;
    corruptOperation = undefined;
    const envelope = await response.json();
    if (request.body.operation === "manager.runtime.start") envelope.result.checks = "invalid";
    else envelope.result.runId = "other-run";
    return new Response(JSON.stringify(envelope), {
      status: response.status, headers: { "content-type": "application/json" },
    });
  });
  const input = manager.start("batch26-uncertain");
  await assert.rejects(client.managerStart(input), { code: "INVALID_MANAGER_RESPONSE", effect: "unknown" });
  assert.deepEqual(client.state().pending, [input.operationId]);
  await assert.rejects(client.managerStart({ ...input, operationId: randomUUID() }),
    { code: "PENDING_OUTCOME_UNKNOWN", effect: "unknown" });
  await until(() => manager.calls.published === 1);
  assert.equal((await client.managerGet({ runId: input.runId })).state, "active",
    "malformed reply does not undo the native committed start");
  assert.equal((await client.retryMutation(input.operationId)).runId, input.runId);
  assert.deepEqual(requests.filter(request => request.method === "capability_call" && request.body.operation === "manager.runtime.start")
    .map(request => request.body.arguments), [input, input], "uncertain start retries exactly, never dispatches a replacement");
  const lifecycle = new ManagerWorkflow(client, input.runId);
  const active = await lifecycle.reconcile();
  const feedback = { operationId: randomUUID(), expectedVersion: active.version,
    target: { kind: "task", taskId: "worker-1" }, message: "Keep the exact acceptance pin." };
  corruptOperation = "manager.progress.feedback";
  await assert.rejects(lifecycle.feedback(feedback), { code: "INVALID_MANAGER_RESPONSE", effect: "unknown" });
  assert.deepEqual(client.state().pending, [feedback.operationId]);
  const replay = await client.retryMutation(feedback.operationId);
  assert.deepEqual(replay.target, feedback.target);
  assert.equal((await client.managerGet({ runId: input.runId })).feedback.length, 1);
  assert.deepEqual(client.state().pending, []);
  const beforeCancel = await lifecycle.reconcile();
  const cancellation = { operationId: randomUUID(), expectedVersion: beforeCancel.version };
  const cancelled = await lifecycle.cancel(cancellation);
  assert.equal(cancelled.state, "cancelled");
  assert.deepEqual(await lifecycle.cancel(cancellation), cancelled);
  manager.release();
  await until(() => manager.calls.active === 0, "held native worker exits after cancellation");
  const snapshot = await lifecycle.reconcile();
  assert.equal(snapshot.state, "cancelled");
  assert.deepEqual(snapshot.acceptance, { status: "not-accepted", pin: null });
  assert.equal(snapshot.verification.checks.length, 0);
  assert.equal(manager.calls.verify.length, 0, "fenced late delivery cannot cause semantic acceptance");
});
