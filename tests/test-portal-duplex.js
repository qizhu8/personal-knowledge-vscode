const { test } = require("node:test");
const assert = require("node:assert/strict");
const { randomUUID } = require("node:crypto");
const { PeerSession } = require("../dist/chatroom/peer-session");
const { PEER_PROTOCOL, parsePortalEndpointIdentity, parsePeerPacket } = require("../dist/chatroom/peer-protocol");

async function until(predicate) {
  for (let i = 0; i < 300; i++) {
    if (predicate()) return;
    await new Promise(resolve => setTimeout(resolve, 5));
  }
  throw new Error("Duplex fixture timed out");
}

async function fixture(t, options = {}) {
  const sides = {}, packets = [], queued = [], errors = [];
  let hold = false;
  for (const id of ["a", "b"]) {
    const side = sides[id] = {
      local: { endpointId: `owner-${id}`, name: id, chatId: randomUUID(), chatName: `Chat ${id}`, deleted: false, revision: 1 },
      enabled: options.enabled === true, runs: [], approvals: 0, invalidations: 0, peers: [], traces: [],
    };
    const other = id === "a" ? "b" : "a";
    side.session = new PeerSession({
      roomId: "duplex", chatId: randomUUID(), connected: () => true, changed() {},
      persistent: options.temporary ? undefined : {
        acceptsIncoming: () => side.enabled, localBinding: () => ({ ...side.local }),
        changedPeer: state => side.peers.push(state),
      },
      invalidated: () => side.invalidations++,
      error: error => errors.push(error.message),
      approvePair: async () => true, approveSwap: async () => true,
      approveTask: async () => { side.approvals++; return options.approve ? options.approve(id) : true; },
      execute: async (prompt, signal, requestId) => {
        side.runs.push({ prompt, signal, requestId, chatId: side.local.chatId });
        return options.execute ? options.execute(id, signal, requestId) : { content: prompt };
      },
      approveCommand: async () => { side.approvals++; return true; },
      executeCommand: async (command, signal, requestId) => {
        side.runs.push({ command, signal, requestId });
        return options.command ? options.command(id, signal, requestId) : { state: "complete", exitCode: 0, stdout: id };
      },
      commandActivity: activity => side.traces.push(activity),
      send: (_target, packet) => {
        packets.push({ from: id, packet: structuredClone(packet) });
        const deliver = () => sides[other].session.receive({ from: id, fromName: id, packet });
        if (hold) queued.push(deliver);
        else queueMicrotask(() => { void deliver(); });
      },
    });
  }
  sides.a.session.pair("b", sides.b.session.invite());
  await until(() => sides.a.session.binding && sides.b.session.binding);
  if (!options.temporary && !options.unconfirmed) {
    sides.a.session.publishEndpointState();
    sides.b.session.publishEndpointState();
    await until(() => sides.a.session.peerConfirmed && sides.b.session.peerConfirmed);
  }
  t.after(() => { sides.a.session.dispose(); sides.b.session.dispose(); });
  return {
    ...sides, packets, errors,
    hold() { hold = true; },
    async flush() { hold = false; while (queued.length) await queued.shift()(); },
    deliver(to, from, packet) { return sides[to].session.receive({ from, fromName: from, packet: structuredClone(packet) }); },
    async publish(id) {
      sides[id].session.publishEndpointState();
      const peer = sides[id === "a" ? "b" : "a"];
      await until(() => peer.session.peerEndpoint?.revision === sides[id].local.revision
        && peer.session.peerEndpoint?.acceptsIncoming === sides[id].enabled);
    },
  };
}

const command = { program: "node", arguments: ["--version"], timeoutSeconds: 10 };
const terminal = (side, id, state) => side.session.receipts.get(id)?.state === state;

test("persistent-v1 requires confirmed state; both directions are disabled by default with explicit denials", async t => {
  const f = await fixture(t, { unconfirmed: true });
  assert(f.a.session.binding.peerCapabilities.includes("persistent-v1"));
  assert.throws(() => f.a.session.submit("not yet"), /not confirmed/);
  f.a.session.publishEndpointState();
  await until(() => f.a.session.peerConfirmed && f.b.session.peerConfirmed);
  assert.deepEqual(f.a.session.peerEndpoint, { ...f.b.local, acceptsIncoming: false });
  assert.notEqual(f.a.session.peerEndpoint.chatId, f.b.session.options.chatId);
  const a = f.a.session.submit("disabled A to B"), b = f.b.session.submitCommand(command);
  await until(() => terminal(f.a, a, "denied") && terminal(f.b, b, "denied"));
  assert.equal(f.a.approvals + f.b.approvals, 0);
  assert.equal(f.a.runs.length + f.b.runs.length, 0);
  assert.equal(f.b.session.incomingReceipts.get(a).state, "denied");
  assert.throws(() => f.a.session.requestSwap(), /duplex/);
  f.a.enabled = f.b.enabled = true;
  await f.publish("a"); await f.publish("b");
  const deniedPacket = f.packets.find(item => item.packet.requestId === a && item.packet.operation === "task").packet;
  await f.deliver("b", "a", deniedPacket);
  assert.equal(f.b.runs.length, 0, "enabling incoming cannot replay a denied request");
});

test("simultaneous tasks, commands and observations correlate in both directions independent of binding role", async t => {
  const release = {};
  const f = await fixture(t, { enabled: true, execute: id => new Promise(resolve => { release[id] = resolve; }) });
  const a = f.a.session.submit("A to B"), b = f.b.session.submit("B to A");
  await until(() => terminal(f.a, a, "running") && terminal(f.b, b, "running"));
  const observation = (side, requestId) => ({ requestId, chatId: side.local.chatId, sequence: 1, at: Date.now(), state: "running", visibility: "task-only" });
  f.a.session.observe(observation(f.a, b)); f.b.session.observe(observation(f.b, a));
  await until(() => f.a.session.observations.has(a) && f.b.session.observations.has(b));
  assert.throws(() => f.b.session.observe({ ...observation(f.b, a), chatId: randomUUID() }), /different local Chat/);
  release.a({ content: "a" }); release.b({ content: "b" });
  await until(() => terminal(f.a, a, "completed") && terminal(f.b, b, "completed"));
  const ca = f.a.session.submitCommand(command), cb = f.b.session.submitCommand(command);
  await until(() => terminal(f.a, ca, "completed") && terminal(f.b, cb, "completed"));
  assert(f.b.traces.filter(trace => trace.requestId === cb).every(trace => trace.role === "controller"));
  assert(f.a.traces.filter(trace => trace.requestId === cb).every(trace => trace.role === "controlled"));
  assert.equal(f.a.runs.length, 2); assert.equal(f.b.runs.length, 2);
  assert.deepEqual(f.errors, []);
});

test("cancel works for an active task after incoming permission is disabled", async t => {
  const f = await fixture(t, { enabled: true, execute: (_id, signal) => new Promise(resolve => {
    signal.addEventListener("abort", () => resolve({ cancelled: true }), { once: true });
  }) });
  const id = f.b.session.submit("active reverse-direction task");
  await until(() => terminal(f.b, id, "running"));
  f.a.enabled = false;
  await f.publish("a");
  assert.equal(f.a.runs[0].signal.aborted, false, "permission changes do not silently cancel active work");
  f.b.session.cancel(id);
  await until(() => f.a.runs[0].signal.aborted && terminal(f.b, id, "unknown"));
});

test("delete and rebind retain pairing, invalidate both directions and never run an old approval in the new Chat", async t => {
  let approve;
  const f = await fixture(t, { enabled: true, approve: id => id === "b" ? new Promise(resolve => { approve = resolve; }) : true,
    execute: (_id, signal) => new Promise(resolve => signal.addEventListener("abort", () => resolve("old result"))) });
  const toB = f.a.session.submit("approval in old B Chat"), toA = f.b.session.submit("running old A task");
  await until(() => terminal(f.a, toB, "awaiting-approval") && terminal(f.b, toA, "running"));
  const binding = f.a.session.binding, oldChat = f.b.local.chatId;
  f.b.local.deleted = true; f.b.local.revision++;
  await f.publish("b");
  assert.equal(f.a.session.binding, binding);
  assert.equal(f.a.session.peerEndpoint.deleted, true);
  assert.equal(f.a.runs[0].signal.aborted, true);
  assert.equal(f.a.session.receipts.get(toB).state, "unknown");
  assert.equal(f.b.session.receipts.get(toA).state, "unknown");
  f.b.local.chatId = randomUUID(); f.b.local.deleted = false; f.b.local.revision++;
  await f.publish("b");
  approve(true);
  await until(() => f.b.session.processing.size === 0);
  assert.equal(f.b.runs.length, 0);
  assert.notEqual(f.a.session.peerEndpoint.chatId, oldChat);
  assert(f.a.invalidations > 0 && f.b.invalidations > 0);
  assert(f.a.peers.some(state => state.deleted));
  assert.equal(f.a.session.receipts.get(toB).state, "unknown");
});

test("trusted restore executes nothing, resets state and rejects packets from earlier sessions", async t => {
  const f = await fixture(t, { enabled: true });
  const id = f.a.session.submit("original");
  await until(() => terminal(f.a, id, "completed"));
  const oldTask = f.packets.find(item => item.packet.operation === "task").packet;
  const oldReceipt = f.packets.find(item => item.packet.operation === "receipt" && item.packet.payload.state === "completed").packet;
  const oldState = f.packets.find(item => item.from === "a" && item.packet.operation === "endpoint-state").packet;
  const aBinding = structuredClone(f.a.session.binding), bBinding = structuredClone(f.b.session.binding);
  f.a.session.restore(aBinding); f.b.session.restore(bBinding);
  assert.equal(f.a.session.peerEndpoint, undefined);
  assert.equal(f.a.session.receipts.size, 0);
  assert.equal(f.b.runs.length, 1);
  assert.throws(() => f.a.session.submit("before exchange"), /not confirmed/);
  await f.deliver("b", "a", oldTask);
  assert.equal(f.b.runs.length, 1);
  f.a.session.publishEndpointState(); f.b.session.publishEndpointState();
  await until(() => f.a.session.peerConfirmed && f.b.session.peerConfirmed);
  await f.deliver("b", "a", oldTask); await f.deliver("a", "b", oldReceipt);
  assert.equal(f.b.runs.length, 1);
  assert.equal(f.a.session.receipts.size, 0);
  const next = f.a.session.submit("new transport");
  await until(() => terminal(f.a, next, "completed"));
  await f.deliver("b", "a", oldState);
  assert.equal(f.b.runs.length, 2);
  await f.deliver("b", "a", oldTask);
  assert.equal(f.b.runs.length, 2);
});

test("directional request ID collisions fail closed without executions or mixed receipts", async t => {
  const f = await fixture(t, { enabled: true });
  const id = randomUUID();
  f.hold();
  f.a.session.submit("A", id); f.b.session.submit("B", id);
  await f.flush();
  assert.equal(f.a.runs.length + f.b.runs.length, 0);
  assert.equal(f.a.session.receipts.get(id).state, "unknown");
  assert.equal(f.b.session.receipts.get(id).state, "unknown");
  assert.equal(f.a.session.incomingReceipts.get(id).state, "denied");
  assert.equal(f.b.session.incomingReceipts.get(id).state, "denied");
  assert.throws(() => f.a.session.submit("A", id), /collides/);
});

test("one-sided restore reconfirms presence, while repeated publications preserve metadata and never execute", async t => {
  const f = await fixture(t, { enabled: true });
  const binding = structuredClone(f.a.session.binding);
  f.a.session.restore(binding);
  assert.throws(() => f.a.session.submit("not confirmed"), /not confirmed/);
  f.a.session.publishEndpointState();
  await until(() => f.a.session.peerConfirmed && f.b.session.peerConfirmed);
  const invalidations = [f.a.invalidations, f.b.invalidations];
  for (let i = 0; i < 3; i++) {
    f.a.session.publishEndpointState(); f.b.session.publishEndpointState();
  }
  await new Promise(resolve => setTimeout(resolve, 20));
  assert.deepEqual([f.a.invalidations, f.b.invalidations], invalidations);
  assert.equal(f.a.runs.length + f.b.runs.length, 0);
  assert.deepEqual(f.a.session.peerEndpoint, { ...f.b.local, acceptsIncoming: true });
  const copy = f.a.session.peerEndpoint;
  copy.deleted = true;
  assert.equal(f.a.session.peerEndpoint.deleted, false);
  const id = f.b.session.submit("after one-sided restart");
  await until(() => terminal(f.b, id, "completed"));
});

test("per-task rejection cannot be replayed and an unpublished Chat change cannot execute", async t => {
  const f = await fixture(t, { enabled: true, approve: () => false });
  const id = f.a.session.submit("reject");
  await until(() => terminal(f.a, id, "denied"));
  f.a.session.submit("reject", id);
  await new Promise(resolve => setTimeout(resolve, 15));
  assert.equal(f.b.approvals, 1);
  assert.equal(f.b.runs.length, 0);
  f.b.local.chatId = randomUUID(); f.b.local.revision++;
  const stale = f.a.session.submit("old Chat");
  await until(() => terminal(f.a, stale, "denied"));
  assert.equal(f.b.approvals, 1);
  await f.publish("b");
  assert.equal(f.b.runs.length, 0);
  assert.throws(() => f.a.session.submit("bad ID", "not-a-uuid"), /identity/);
});

test("unknown remote, wrong pairing, forged stale revisions and malformed endpoint state cannot execute", async t => {
  const f = await fixture(t, { enabled: true });
  f.hold();
  const id = f.a.session.submit("authenticated only");
  const packet = f.packets.find(item => item.packet.requestId === id).packet;
  await f.deliver("b", "intruder", packet);
  await f.deliver("b", "a", { ...packet, pairId: randomUUID() });
  await f.deliver("b", "a", { ...packet, requestId: randomUUID(), payload: { ...packet.payload, persistent: { ...packet.payload.persistent, targetRevision: 0 } } });
  assert.equal(f.b.runs.length, 0);
  const state = f.packets.find(item => item.from === "a" && item.packet.operation === "endpoint-state").packet;
  await f.deliver("b", "a", { ...state, payload: { ...state.payload, endpoint: { ...f.a.local, acceptsIncoming: true, revision: -1 } } });
  assert.equal(f.b.session.peerEndpoint.revision, 1);
  await f.flush();
  await until(() => terminal(f.a, id, "completed"));
  assert.equal(f.b.runs.length, 1);
  for (const bad of [null, [], { ...f.a.local, acceptsIncoming: "yes" }, { ...f.a.local, acceptsIncoming: true, revision: Infinity },
    { ...f.a.local, acceptsIncoming: true, name: "x".repeat(201) }, { ...f.a.local, acceptsIncoming: true, extra: true }]) assert.throws(() => parsePortalEndpointIdentity(bad));
  assert.throws(() => f.a.session.restore({ ...f.a.session.binding, peerCapabilities: [] }), /persistent-v1/);
  assert.doesNotThrow(() => parsePeerPacket(state));
});

test("temporary sessions preserve role gating, duplicate suppression and reject restore or endpoint state", async t => {
  const f = await fixture(t, { temporary: true });
  assert(!f.a.session.binding.peerCapabilities.includes("persistent-v1"));
  assert.throws(() => f.b.session.submit("reverse"), /controller/);
  assert.throws(() => f.a.session.restore(f.a.session.binding), /persistent-v1/);
  assert.throws(() => f.a.session.publishEndpointState(), /persistent-v1/);
  await f.deliver("a", "b", { protocol: PEER_PROTOCOL, operation: "endpoint-state", pairId: f.a.session.binding.pairId, requestId: randomUUID(), payload: {} });
  assert(f.errors.some(error => /temporary/.test(error)));
  const id = f.a.session.submit("temporary");
  await until(() => terminal(f.a, id, "completed"));
  f.a.session.submit("temporary", id);
  await new Promise(resolve => setTimeout(resolve, 20));
  assert.equal(f.b.runs.length, 1);
  assert.equal(f.b.session.receipts.get(id).state, "completed");
  assert.equal(f.a.session.peerEndpoint, undefined);
});

test("endpointConfirmed tracks restore, handshake and binding invalidation until reconfirmed", async t => {
  const f = await fixture(t, { enabled: true });
  assert.equal(f.a.session.endpointConfirmed, true);
  assert.equal(f.b.session.endpointConfirmed, true);
  f.a.session.restore(structuredClone(f.a.session.binding));
  assert.equal(f.a.session.endpointConfirmed, false);
  f.a.session.publishEndpointState();
  await until(() => f.a.session.endpointConfirmed && f.b.session.endpointConfirmed);
  f.b.local.chatId = randomUUID(); f.b.local.revision++;
  assert.equal(f.b.session.endpointConfirmed, false, "an unpublished local Chat change is not ready");
  f.hold();
  f.b.session.publishEndpointState();
  assert.equal(f.b.session.endpointConfirmed, false, "a published change waits for the peer acknowledgement");
  await f.flush();
  await until(() => f.a.session.endpointConfirmed && f.b.session.endpointConfirmed);
  assert.equal(f.a.session.peerEndpoint.chatId, f.b.local.chatId);
  const id = f.a.session.submit("after reconfirm");
  await until(() => terminal(f.a, id, "completed"));
});

test("endpointConfirmed is always false for temporary Portals", async t => {
  const f = await fixture(t, { temporary: true });
  assert.equal(f.a.session.endpointConfirmed, false);
  assert.equal(f.b.session.endpointConfirmed, false);
});
