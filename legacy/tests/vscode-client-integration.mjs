import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { VscodeClient } from "../next-server/clients/vscode/client.ts";
import { ChatActivity, ManagerActivity } from "../next-server/clients/vscode/activity.ts";
import { bindWebview } from "../next-server/clients/vscode/bridge.ts";
import { httpCall, invocation, managerActor, nativeWorkspace, syntheticManager, until } from "../next-server/tests/batch06-manager-fixtures.mjs";
import { createSyntheticProvider } from "../next-server/tests/chat-turn-native-fixtures.mjs";
import { cliFixture } from "../next-server/tests/batch07-cli-fixtures.mjs";

test("isolated VS Code adapter handshakes with the actual authenticated spawned CLI workspace, never caller-only attestation", async t => {
  const f = await cliFixture(t), child = await f.launch([], false);
  const host = { secrets: { get: async () => f.token }, async attestServer(origin, info) {
    assert.equal(origin, child.url);
    assert.equal(info.workspaceId, f.identity.id);
    assert.equal(info.actorId, "local:owner");
    return { serverId: info.serverId, workspaceId: info.workspaceId, actorId: info.actorId, protocolVersion: info.protocolVersion };
  } };
  const client = new VscodeClient(host, { origin: child.url, secretKey: "synthetic", expectedWorkspaceId: f.identity.id });
  t.after(() => client.dispose());
  assert.equal((await client.connect()).status, "connected");
  assert.equal(client.state().workspaceId, f.identity.id);
  for (const change of [{ workspaceId: undefined }, { serverId: "other-server" }, { actorId: undefined },
    { protocolVersion: undefined }, { workspaceVersion: undefined }]) {
    let attestations = 0;
    const forged = new VscodeClient({ ...host, async attestServer() {
      attestations++; return { serverId: "pkm-next", workspaceId: f.identity.id, actorId: "local:owner", protocolVersion: "v1" };
    }, async fetch(url, init) {
      const response = await fetch(url, init);
      if (!url.endsWith("/server_info")) return response;
      const body = await response.json();
      Object.assign(body.result, change);
      return new Response(JSON.stringify(body), { status: response.status, headers: { "content-type": "application/json" } });
    } }, { origin: child.url, secretKey: "synthetic", expectedWorkspaceId: f.identity.id });
    try {
      await assert.rejects(forged.connect(), error => error.code === "INCOMPATIBLE_SERVER");
      assert.equal(attestations, 0, "host attestation cannot rescue missing server identity");
    } finally { forged.dispose(); }
  }
});

async function setup(t, options = {}, actor = managerActor, fetchOverride) {
  const f = await nativeWorkspace(t, options);
  const url = await f.listen(actor);
  const workspaceId = await f.storage.workspaceId();
  const states = [];
  const host = {
    secrets: { get: async key => key === "pkm-secret" ? f.bearer : undefined },
    attestServer: async (origin, info) => {
      assert.equal(origin, url); assert.equal(info.storage.workspaceSchema, "pkm.next-workspace/v2");
      assert.equal(info.workspaceId, workspaceId);
      assert.equal(info.actorId, actor.id);
      assert.equal(info.serverId, "pkm-next");
      return { serverId: info.serverId, workspaceId: info.workspaceId, actorId: info.actorId, protocolVersion: info.protocolVersion };
    },
    ...(fetchOverride ? { fetch: fetchOverride } : {}),
    onState: state => states.push(state),
  };
  const client = new VscodeClient(host, { origin: url, secretKey: "pkm-secret", expectedWorkspaceId: workspaceId });
  t.after(() => client.dispose());
  await client.connect();
  return { f, client, url, host, states, workspaceId };
}
const rejection = code => error => { assert.equal(error.code, code); return true; };

test("native knowledge CAS, authenticated capability discovery and same-ID unknown retry", async t => {
  let loseResponse = false;
  const bodies = [];
  const wrap = async (url, init) => {
    if (url.endsWith("/capability_call")) bodies.push(init.body);
    const response = await fetch(url, init);
    if (loseResponse && url.endsWith("/capability_call")) { loseResponse = false; throw new Error("lost response"); }
    return response;
  };
  const { f, client, url, states } = await setup(t, {}, managerActor, wrap);
  const create = { operationId: randomUUID(), id: "client-doc", title: "Original", content: "body" };
  assert.equal((await httpCall(url, f.bearer, "capability_call", invocation("knowledge.document.create", create))).status, 200);
  assert.equal((await client.knowledgeList({ limit: 1 })).items[0].id, create.id);
  const original = await client.knowledgeGet({ id: create.id });
  const edit = { id: original.id, operationId: randomUUID(), expectedRevision: original.revision,
    expectedSha256: original.sha256, title: "Changed", content: "Updated" };
  loseResponse = true;
  await assert.rejects(client.knowledgeEdit(edit), error => error.code === "TRANSPORT_ERROR" && error.effect === "unknown");
  assert.deepEqual(client.state().pending, [edit.operationId]);
  await assert.rejects(client.knowledgeEdit({ ...edit, operationId: randomUUID() }), rejection("PENDING_OUTCOME_UNKNOWN"));
  const replay = await client.retryMutation(edit.operationId);
  assert.equal(replay.content, "Updated");
  assert.equal(bodies[0], bodies[1]);
  assert.equal(client.state().pending.length, 0);
  await assert.rejects(client.knowledgeEdit({ ...edit, operationId: randomUUID() }), rejection("CONFLICT"));
  assert.equal((await client.knowledgeGet({ id: create.id })).revision, 2);
  assert(states.some(state => state.pending.includes(edit.operationId)));
});

test("read-only actor has no mutation capabilities, webview is channel-bound and cannot inject methods or native review", async t => {
  const actor = { id: "readonly-client", canWrite: false };
  const { client } = await setup(t, {}, actor);
  assert(client.state().capabilities.includes("knowledgeList"));
  assert(!client.state().capabilities.includes("knowledgeEdit"));
  await assert.rejects(client.knowledgeEdit({}), rejection("CAPABILITY_UNAVAILABLE"));
  let listener;
  const sent = [];
  const channel = {};
  const bridge = bindWebview(client, {
    onMessage(fn) { listener = fn; return { dispose() { listener = undefined; } }; },
    async postMessage(value) { sent.push(value); },
  }, channel);
  const send = (source, action, input = {}) => listener({ source, message: { requestId: randomUUID(), action, input } });
  send({}, "knowledgeList");
  send(channel, "execution.approve", { operation: "execution.approve" });
  send(channel, "openHumanReview");
  send(channel, "knowledgeList", { path: "/etc/passwd" });
  send(channel, "knowledgeList");
  await until(() => sent.length === 4, "bridge replies");
  assert.deepEqual(sent.map(item => item.error?.code).filter(Boolean).sort(), ["INVALID_ACTION", "INVALID_ACTION", "INVALID_ARGUMENT"]);
  assert.equal(sent.filter(item => item.result).length, 1);
  bridge.dispose();
});

test("Manager publishes an early result while running, feedback targets only one worker, disconnect never cancels", async t => {
  const manager = syntheticManager("migration", 4, { hold: true, publish: true });
  const { client, f } = await setup(t, { manager: manager.config });
  f.addCleanup(manager.release);
  const input = manager.start("vscode-live");
  assert.ok((await f.call("manager.runtime.start", input)).result);
  await until(() => manager.calls.published === 1 && manager.calls.worker.length === 4);
  const activity = new ManagerActivity(client, input.runId);
  let early;
  await until(async () => {
    const page = await activity.next();
    early = page.events.find(event => event.kind === "result" && event.taskId === "worker-1") ?? early;
    return early;
  });
  assert.equal(early.result.verificationStatus, "pending");
  const overview = await client.managerOverview({ runId: input.runId });
  assert.equal(overview.state, "active");
  assert(overview.doing.some(task => task.taskId === "worker-1"));
  await client.managerFeedback({ operationId: randomUUID(), runId: input.runId, expectedVersion: overview.version,
    target: { kind: "task", taskId: "worker-1" }, message: "Revise only this result." });
  assert.equal(manager.calls.worker.filter(call => call.taskId !== "worker-1").length, 3);
  client.disconnect();
  assert.equal((await f.call("manager.runtime.get", { runId: input.runId })).result.state, "active");
  manager.release();
  await until(async () => (await f.call("manager.runtime.get", { runId: input.runId })).result.state === "succeeded");
  assert.equal(manager.calls.worker.filter(call => call.feedback.length).length, 1);
});

test("explicit Manager cancellation fences its run without cancelling another server-owned run", async t => {
  const manager = syntheticManager("small", 1, { hold: true, publish: true });
  const { client, f } = await setup(t, { manager: manager.config });
  f.addCleanup(manager.release);
  const first = manager.start("cancel-one");
  const second = manager.start("retain-other");
  assert.ok((await f.call("manager.runtime.start", first)).result);
  await until(() => manager.calls.published === 1);
  assert.ok((await f.call("manager.runtime.start", second)).result);
  await until(async () => (await client.managerOverview({ runId: second.runId })).state === "succeeded");
  const snapshot = await client.managerOverview({ runId: first.runId });
  await client.managerCancel({ runId: first.runId, expectedVersion: snapshot.version, operationId: randomUUID() });
  assert.equal((await client.managerOverview({ runId: first.runId })).state, "cancelled");
  assert.equal((await client.managerOverview({ runId: second.runId })).state, "succeeded");
});

test("native Chat starts, exposes ordered events and disconnect does not cancel the turn", async t => {
  const provider = createSyntheticProvider();
  let release;
  let entered = false;
  const gate = new Promise(resolve => { release = resolve; });
  const transport = {
    supports: name => name === "openai-compatible",
    async open() {
      entered = true;
      await gate;
      const text = 'data: {"choices":[{"index":0,"delta":{"content":"Hello native"},"finish_reason":null}]}\n\n' +
        'data: {"choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n';
      return new ReadableStream({ start(controller) { controller.enqueue(new TextEncoder().encode(text)); controller.close(); } });
    },
  };
  const { client, f } = await setup(t, { modelConfig: provider.modelConfig, providerTransport: transport,
    toolCatalog: [{ name: "read_document", operation: "knowledge.document.get" }], reviewer: async () => null });
  f.addCleanup(release);
  const sessionId = randomUUID();
  await client.chatCreate({ id: sessionId, operationId: randomUUID(), expectedRevision: 0, title: "Native chat" });
  const id = randomUUID();
  const started = await client.chatStart({ id, sessionId, operationId: randomUUID(), expectedRevision: 0,
    messages: [{ role: "user", content: "Hello" }] });
  assert.equal(started.id, id);
  await until(() => entered);
  const events = await new ChatActivity(client, id).next();
  assert(events.events.length > 0);
  client.disconnect();
  const status = (await f.call("chat.turn.get", { id })).result.status;
  assert.notEqual(status, "cancelled");
  release();
  const final = await until(async () => {
    const turn = (await f.call("chat.turn.get", { id })).result;
    return turn.status === "completed" && turn;
  });
  assert.match(final.output, /Hello native/);
});
