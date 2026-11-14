import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { createServer } from "node:http";
import { once } from "node:events";
import test from "node:test";
import { channelFixture } from "./channel-runtime-fixtures.mjs";
import { createChannelRuntime, channelRuntimeDefinitions, initializeChannelRuntimeSchema } from "../dist/channel-runtime.js";

const rejects = (work, code) => assert.throws(work, error => error.code === code);
const rejection = (promise, code) => assert.rejects(promise, error => error.code === code);

test("parent initialization, strict schema inventory and default-deny identity/task authority", () => {
  const f = channelFixture({ noAuthority: true });
  try {
    rejects(() => initializeChannelRuntimeSchema(f.db), "TRANSACTION_REQUIRED");
    f.create();
    rejects(() => f.runtime.connect({}, { channelId: "channel-one" }), "UNAUTHORIZED");
    rejects(() => f.runtime.nativeInviteCreate(f.tokens.worker, {}), "INVALID_ARGUMENT");
    const worker = f.admit(), manager = f.runtime.connect(f.tokens.manager, { channelId: "channel-one" });
    rejects(() => manager.assign({ ...f.args(), recipientId: "worker", text: "work", task: f.task }), "TASK_AUTHORITY_UNAVAILABLE");
    for (const definition of channelRuntimeDefinitions) {
      assert.ok(!definition.id.includes("invite") && !definition.id.includes("approve"));
      assert.equal(definition.input.safeParse({ actorId: "human-manager", role: "manager" }).success, false);
    }
    rejects(() => worker.send({ ...f.args(), recipientId: "manager", text: "spoof", senderId: "manager" }), "INVALID_ARGUMENT");
  } finally { f.close(); }
});

test("host-issued invitation requires exact invited identity and human approval; secrets never persist", () => {
  const f = channelFixture();
  try {
    f.create();
    const input = { ...f.args(), actor: { actorId: "agent-worker", kind: "agent" }, participantId: "worker",
      role: "worker", expiresAt: f.now() + 60_000, memberExpiresAt: f.now() + 500_000 };
    const invitation = f.runtime.nativeInviteCreate(f.tokens.manager, input);
    rejects(() => f.runtime.nativeInviteCreate(f.tokens.manager, input), "INVITATION_ALREADY_ISSUED");
    rejects(() => f.accept("outsider", invitation), "INVITATION_FORBIDDEN");
    rejects(() => f.accept("worker", invitation), "HUMAN_APPROVAL_REQUIRED");
    rejects(() => f.runtime.nativeHumanApprove(f.tokens.worker, { ...f.args(), invitationId: invitation.invitationId }), "HUMAN_AUTHORITY_REQUIRED");
    f.approve(invitation);
    rejects(() => f.accept("worker", { ...invitation, token: "x".repeat(43) }), "INVITATION_FORBIDDEN");
    const acceptance = { ...f.args(), invitationId: invitation.invitationId, token: invitation.token };
    const result = f.runtime.accept(f.tokens.worker, acceptance);
    assert.deepEqual(f.runtime.accept(f.tokens.worker, acceptance), result);
    const persisted = f.db.prepare("SELECT record FROM channel_runtime_rooms").all().map(row => row.record).join("")
      + f.db.prepare("SELECT record FROM channel_runtime_receipts").all().map(row => row.record).join("");
    assert.equal(persisted.includes(invitation.token), false);
    assert.equal(persisted.includes("tokenSha256"), true);
    const oldConnection = f.runtime.connect(f.tokens.worker, { channelId: "channel-one" });
    f.runtime.nativeRevoke(f.tokens.manager, { ...f.args(), participantId: "worker" });
    rejects(() => f.runtime.accept(f.tokens.worker, acceptance), "FORBIDDEN");
    rejects(() => f.runtime.nativeInviteCreate(f.tokens.manager, { ...input, ...f.args() }), "MEMBERSHIP_EXISTS");
    const fresh = f.runtime.nativeInviteCreate(f.tokens.manager, { ...input, ...f.args(), participantId: "worker-new-generation" });
    f.approve(fresh); f.accept("worker", fresh);
    rejects(() => f.runtime.accept(f.tokens.worker, acceptance), "FORBIDDEN");
    rejects(() => oldConnection.read({ channelId: "channel-one" }), "CONNECTION_UNAVAILABLE");
    const freshConnection = f.runtime.connect(f.tokens.worker, { channelId: "channel-one" });
    assert.equal(freshConnection.participantId, "worker-new-generation");
    freshConnection.disconnect();
  } finally { f.close(); }
});

test("actual two loopback peers: directed Manager assignment -> worker update -> reply -> bounded wait", async () => {
  const f = channelFixture();
  f.create();
  const peers = { manager: f.runtime.connect(f.tokens.manager, { channelId: "channel-one" }), worker: f.admit() };
  const secrets = { manager: randomUUID(), worker: randomUUID() };
  const server = createServer(async (request, response) => {
    try {
      const [name, action] = request.url.slice(1).split("/");
      if (!peers[name] || request.headers["x-synthetic-peer"] !== secrets[name]) throw new Error("untrusted synthetic peer");
      let body = "";
      for await (const chunk of request) body += chunk;
      const args = JSON.parse(body);
      const result = await peers[name][action](args);
      response.writeHead(200, { "content-type": "application/json" }); response.end(JSON.stringify(result));
    } catch (error) {
      response.writeHead(400, { "content-type": "application/json" }); response.end(JSON.stringify({ code: error.code ?? "HARNESS_REJECTED" }));
    }
  });
  server.listen(0, "127.0.0.1"); await once(server, "listening");
  const base = `http://127.0.0.1:${server.address().port}`;
  const call = async (name, action, args) => {
    const response = await fetch(`${base}/${name}/${action}`, { method: "POST", headers: { "x-synthetic-peer": secrets[name] },
      body: JSON.stringify(args) });
    const result = await response.json();
    assert.equal(response.status, 200, JSON.stringify(result)); return result;
  };
  try {
    const pending = call("worker", "wait", { channelId: "channel-one", timeoutMs: 1000 });
    const assignment = await call("manager", "assign", { ...f.args(), recipientId: "worker", text: "pinned task", task: f.task });
    const delivered = await pending;
    assert.equal(delivered.messages.length, 1);
    assert.equal(delivered.messages[0].senderId, "manager");
    assert.equal(delivered.messages[0].id, assignment.message.id);
    const update = await call("worker", "update", { ...f.args(), assignmentId: assignment.message.id,
      task: assignment.message.task, text: "measured progress" });
    assert.equal(f.managerRun().version, 3);
    const reply = await call("worker", "reply", { ...f.args(), assignmentId: assignment.message.id,
      task: update.message.task, text: "native delivery", afterSeq: assignment.message.seq });
    assert.equal(reply.state, "waiting");
    assert.equal(reply.cursor, 1);
    assert.equal(f.managerRun().tasks[0].attempts[0].state, "delivered");
    const managerMailbox = await call("manager", "read", { channelId: "channel-one" });
    assert.deepEqual(managerMailbox.messages.map(message => message.kind), ["update", "reply"]);
    const waiting = await call("worker", "wait", { channelId: "channel-one", timeoutMs: 25 });
    assert.deepEqual(waiting.messages, []);
    assert.equal(waiting.state, "waiting");
    assert.equal(f.applications(), 3);
    assert.equal(f.runtime.diagnostics().activeWaits, 0);
  } finally {
    f.runtime.dispose(); await f.runtime.drain();
    server.closeAllConnections(); await new Promise(resolve => server.close(resolve));
    f.db.close();
  }
});

test("no broadcast wake, explicit edge ACL, cross-room isolation and peer hint cannot spoof", async () => {
  const f = channelFixture();
  try {
    f.create(); f.create("channel-two");
    const manager = f.runtime.connect(f.tokens.manager, { channelId: "channel-one" }), worker = f.admit();
    const observer = f.admit("observer", "channel-one", "observer");
    const controller = new AbortController();
    let observerSettled = false;
    const unrelated = observer.wait({ channelId: "channel-one", timeoutMs: 1000 }, controller.signal);
    const observed = unrelated.finally(() => { observerSettled = true; });
    const expectedRejection = rejection(observed, "WAIT_CANCELLED");
    const pending = worker.wait({ channelId: "channel-one", timeoutMs: 1000 });
    manager.send({ ...f.args(), recipientId: "worker", text: "only worker" });
    assert.equal((await pending).messages[0].text, "only worker");
    assert.equal(observerSettled, false);
    assert.deepEqual(observer.read({ channelId: "channel-one" }).messages, []);
    rejects(() => worker.read({ channelId: "channel-two" }), "FORBIDDEN");
    rejects(() => f.runtime.connect(f.tokens.worker, { channelId: "channel-two" }), "FORBIDDEN");
    rejects(() => observer.send({ ...f.args(), recipientId: "worker", text: "unapproved edge" }), "DIRECTED_FORBIDDEN");
    rejects(() => worker.receivePeerHint({ protocol: "pkm.peer/v1", operation: "receipt", pairId: worker.generation,
      requestId: randomUUID(), payload: { channelId: "channel-one", participantId: "observer" } }), "PEER_HINT_FORBIDDEN");
    worker.receivePeerHint({ protocol: "pkm.peer/v1", operation: "receipt", pairId: worker.generation,
      requestId: randomUUID(), payload: { channelId: "channel-one", participantId: "worker" } });
    controller.abort(); await expectedRejection;
    assert.equal(f.runtime.diagnostics().activeWaits, 0);
  } finally { f.close(); }
});

test("CAS, parent global receipts, authority pin and rollback share one SQL transaction", () => {
  const f = channelFixture();
  try {
    f.create();
    const manager = f.runtime.connect(f.tokens.manager, { channelId: "channel-one" }); f.admit();
    const input = { ...f.args(), recipientId: "worker", text: "one delivery", task: f.task };
    const receipt = manager.assign(input);
    assert.deepEqual(manager.assign(input), receipt);
    assert.equal(f.applications(), 1);
    rejects(() => manager.assign({ ...input, text: "changed" }), "OPERATION_CONFLICT");
    rejects(() => manager.send({ ...f.args(), expectedRevision: 1, recipientId: "worker", text: "stale" }), "REVISION_CONFLICT");
    const reserved = randomUUID();
    f.db.prepare("INSERT INTO fixture_global_receipts VALUES(?,?)").run(reserved, "other-slice");
    rejects(() => manager.send({ ...f.args(), operationId: reserved, recipientId: "worker", text: "conflict" }), "GLOBAL_OPERATION_CONFLICT");
    rejects(() => manager.assign({ ...f.args(), recipientId: "worker", text: "wrong pin",
      task: { ...f.task, definitionSha256: "c".repeat(64) } }), "TASK_PIN_FORBIDDEN");
    const before = f.revision("channel-one"), beforeManager = f.managerRun().version;
    const worker = f.runtime.connect(f.tokens.worker, { channelId: "channel-one" });
    const update = { ...f.args(), assignmentId: receipt.message.id, task: receipt.message.task, text: "rollback" };
    f.failReceipt(true);
    rejects(() => worker.update(update), "RECEIPT_FAILURE");
    assert.equal(f.revision("channel-one"), before); assert.equal(f.managerRun().version, beforeManager);
    f.failReceipt(false);
    f.host.taskAuthority.apply = () => { throw Object.assign(new Error("parent authority rejection"), { code: "AUTHORITY_REJECTED" }); };
    rejects(() => worker.update(update), "AUTHORITY_REJECTED");
    assert.equal(f.revision("channel-one"), before); assert.equal(f.managerRun().version, beforeManager);
    assert.equal(f.db.prepare("SELECT operation_id FROM fixture_global_receipts WHERE operation_id=?").get(update.operationId), undefined);
    assert.equal(f.db.isTransaction, false);
  } finally { f.close(); }
});

test("reply-and-wait commits task, cursor and state atomically; replay has no second effect; immediate arrival is not lost", async () => {
  const f = channelFixture();
  try {
    f.create(); const worker = f.admit(), manager = f.runtime.connect(f.tokens.manager, { channelId: "channel-one" });
    const assignment = manager.assign({ ...f.args(), recipientId: "worker", text: "task", task: f.task });
    const request = { ...f.args(), assignmentId: assignment.message.id, task: assignment.message.task,
      text: "done", afterSeq: assignment.message.seq };
    const controller = new AbortController();
    const combined = worker.replyAndWait(request, { channelId: "channel-one", timeoutMs: 1000 }, controller.signal);
    assert.equal(combined.receipt.state, "waiting");
    assert.deepEqual(worker.reply(request), combined.receipt);
    assert.equal(f.applications(), 2);
    manager.send({ ...f.args(), recipientId: "worker", text: "next directed message" });
    assert.equal((await combined.waiting).messages[0].text, "next directed message");
    assert.equal(f.runtime.diagnostics().activeWaits, 0);
  } finally { f.close(); }
});

test("revocation cancels pending wait and forbids receipts/read/reconnect; recipient offline is explicit", async () => {
  const f = channelFixture();
  try {
    f.create(); const worker = f.admit(), manager = f.runtime.connect(f.tokens.manager, { channelId: "channel-one" });
    const pending = rejection(worker.wait({ channelId: "channel-one", timeoutMs: 1000 }), "FORBIDDEN");
    f.runtime.nativeRevoke(f.tokens.manager, { ...f.args(), participantId: "worker" });
    await pending;
    rejects(() => worker.read({ channelId: "channel-one" }), "CONNECTION_UNAVAILABLE");
    rejects(() => f.runtime.connect(f.tokens.worker, { channelId: "channel-one" }), "FORBIDDEN");
    rejects(() => manager.send({ ...f.args(), recipientId: "worker", text: "revoked" }), "RECIPIENT_UNAVAILABLE");
    assert.equal(f.runtime.diagnostics().activeWaits, 0);
  } finally { f.close(); }
});

test("durable cursor, explicit retention gap, reconnect replacement and no offline auto-respawn", async () => {
  const f = channelFixture();
  try {
    f.create(); let worker = f.admit(); const manager = f.runtime.connect(f.tokens.manager, { channelId: "channel-one" });
    const send = { ...f.args(), recipientId: "worker", text: "persisted" };
    manager.send(send);
    worker.ack({ ...f.args(), throughSeq: 1 });
    const pending = rejection(worker.wait({ channelId: "channel-one", timeoutMs: 1000 }), "CONNECTION_REPLACED");
    worker = f.runtime.connect(f.tokens.worker, { channelId: "channel-one" });
    await pending;
    assert.deepEqual(worker.read({ channelId: "channel-one" }).messages, []);
    assert.deepEqual(manager.send(send).message.text, "persisted");
    f.runtime.nativeCompact(f.tokens.manager, { ...f.args(), participantId: "worker", throughSeq: 1 });
    rejects(() => worker.read({ channelId: "channel-one", afterSeq: 0 }), "CURSOR_GAP");
    rejects(() => worker.read({ channelId: "channel-one", afterSeq: 2 }), "INVALID_CURSOR");
    worker.disconnect();
    rejects(() => manager.assign({ ...f.args(), recipientId: "worker", text: "offline task", task: f.task }), "RECIPIENT_UNAVAILABLE");
    assert.equal(f.managerRun().version, 1);
    assert.equal(f.runtime.diagnostics().connections, 1);
  } finally { f.close(); }
});

test("expiry, host lease loss, cancellation, close and drain leave no background wait handles", async () => {
  const f = channelFixture();
  try {
    f.create();
    const invitation = f.invite("worker", "channel-one", "worker", f.now() + 10);
    f.advance(20);
    rejects(() => f.approve(invitation), "INVITATION_EXPIRED");
    const worker = f.admit();
    const expired = rejection(worker.wait({ channelId: "channel-one", timeoutMs: 1000 }), "MEMBERSHIP_EXPIRED");
    f.advance(600_000); f.runtime.notify({ channelId: "channel-one", participantId: "worker" }); await expired;
    assert.equal(f.runtime.diagnostics().activeWaits, 0);
  } finally { f.close(); }
  const g = channelFixture();
  try {
    g.create(); const worker = g.admit();
    const lost = rejection(worker.wait({ channelId: "channel-one", timeoutMs: 1000 }), "LEASE_LOST");
    g.loseLease(); g.runtime.notify({ channelId: "channel-one", participantId: "worker" }); await lost;
    assert.equal(g.runtime.diagnostics().activeWaits, 0);
  } finally { g.close(); }
  const h = channelFixture();
  try {
    h.create(); const worker = h.admit();
    const pending = rejection(worker.wait({ channelId: "channel-one", timeoutMs: 1000 }), "CHANNEL_UNAVAILABLE");
    h.runtime.nativeClose(h.tokens.manager, h.args()); await pending;
    rejects(() => h.runtime.connect(h.tokens.worker, { channelId: "channel-one" }), "CHANNEL_UNAVAILABLE");
    h.runtime.dispose(); await h.runtime.drain();
    assert.deepEqual(h.runtime.diagnostics(), { activeWaits: 0, connections: 0, closed: true });
  } finally { h.close(); }
});

test("authority mutation rolls back on invalid reply cursor; assignment ownership and pending task retention fail closed", () => {
  const f = channelFixture();
  try {
    f.create(); const worker = f.admit(), observer = f.admit("observer", "channel-one", "observer");
    const manager = f.runtime.connect(f.tokens.manager, { channelId: "channel-one" });
    const assignment = manager.assign({ ...f.args(), recipientId: "worker", text: "task", task: f.task });
    const before = f.managerRun(), roomRevision = f.revision("channel-one");
    const request = { ...f.args(), assignmentId: assignment.message.id, task: assignment.message.task, text: "reply", afterSeq: 0 };
    rejects(() => worker.reply(request), "INVALID_CURSOR");
    assert.deepEqual(f.managerRun(), before);
    assert.equal(f.revision("channel-one"), roomRevision);
    rejects(() => observer.update({ ...f.args(), assignmentId: assignment.message.id, task: assignment.message.task, text: "spoof" }), "TASK_ASSIGNMENT_FORBIDDEN");
    worker.ack({ ...f.args(), throughSeq: assignment.message.seq });
    rejects(() => f.runtime.nativeCompact(f.tokens.manager, { ...f.args(), participantId: "worker", throughSeq: 1 }), "TASK_DELIVERY_PENDING");
    const receipt = worker.reply({ ...f.args(), assignmentId: assignment.message.id, task: assignment.message.task, text: "done", afterSeq: 1 });
    rejects(() => worker.update({ ...f.args(), assignmentId: assignment.message.id, task: receipt.message.task, text: "after reply" }), "TASK_ALREADY_REPLIED");
    manager.ack({ ...f.args(), throughSeq: receipt.message.seq });
    f.runtime.nativeCompact(f.tokens.manager, { ...f.args(), participantId: "manager", throughSeq: receipt.message.seq });
    f.runtime.nativeCompact(f.tokens.manager, { ...f.args(), participantId: "worker", throughSeq: assignment.message.seq });
    assert.deepEqual(manager.read({ channelId: "channel-one" }).messages, []);
    rejects(() => worker.update({ ...f.args(), assignmentId: assignment.message.id, task: receipt.message.task, text: "retained fence" }), "TASK_ALREADY_REPLIED");
    assert.equal(f.managerRun().version, 3);
  } finally { f.close(); }
});

test("persisted membership/cursor survive runtime restart but presence never restores; dispose cancels and drains", async () => {
  const f = channelFixture();
  let restarted;
  try {
    f.create(); const worker = f.admit(), manager = f.runtime.connect(f.tokens.manager, { channelId: "channel-one" });
    manager.send({ ...f.args(), recipientId: "worker", text: "first" });
    worker.ack({ ...f.args(), throughSeq: 1 });
    manager.send({ ...f.args(), recipientId: "worker", text: "unread second" });
    f.runtime.dispose();
    restarted = createChannelRuntime(f.db, f.host, { pollMs: 10 });
    const newManager = restarted.connect(f.tokens.manager, { channelId: "channel-one" });
    rejects(() => newManager.send({ ...f.args(), recipientId: "worker", text: "no restored presence" }), "RECIPIENT_UNAVAILABLE");
    const newWorker = restarted.connect(f.tokens.worker, { channelId: "channel-one" });
    assert.deepEqual(newWorker.read({ channelId: "channel-one" }).messages.map(message => message.text), ["unread second"]);
    newWorker.ack({ ...f.args(), throughSeq: 2 });
    const pending = rejection(newWorker.wait({ channelId: "channel-one", timeoutMs: 1000 }), "CHANNEL_UNAVAILABLE");
    await rejection(restarted.drain(), "ACTIVE_WAITS");
    restarted.dispose(); await pending; await restarted.drain();
    assert.equal(restarted.diagnostics().activeWaits, 0);
  } finally { restarted?.dispose(); f.close(); }
});

test("accidentally asynchronous ACL/receipt hooks cannot grant authority or commit Channel mutations", () => {
  const f = channelFixture();
  try {
    f.create(); f.admit();
    const manager = f.runtime.connect(f.tokens.manager, { channelId: "channel-one" });
    const before = f.revision("channel-one");
    f.host.authorizeDirected = async () => true;
    rejects(() => manager.send({ ...f.args(), recipientId: "worker", text: "async grant" }), "DIRECTED_FORBIDDEN");
    f.host.authorizeDirected = () => true;
    f.host.taskAuthority.authorize = async () => true;
    rejects(() => manager.assign({ ...f.args(), recipientId: "worker", text: "async task grant", task: f.task }), "TASK_PIN_FORBIDDEN");
    f.host.claimReceipt = async () => {};
    rejects(() => manager.send({ ...f.args(), recipientId: "worker", text: "async receipt" }), "ASYNC_HOST_HOOK");
    assert.equal(f.revision("channel-one"), before);
    assert.equal(f.db.isTransaction, false);
  } finally { f.close(); }
});

test("reply preserves a newer acknowledged directed cursor without replaying or skipping the next message", async () => {
  const f = channelFixture();
  try {
    f.create(); const worker = f.admit(), manager = f.runtime.connect(f.tokens.manager, { channelId: "channel-one" });
    const assignment = manager.assign({ ...f.args(), recipientId: "worker", text: "task", task: f.task });
    manager.send({ ...f.args(), recipientId: "worker", text: "clarification" });
    worker.ack({ ...f.args(), throughSeq: 2 });
    const combined = worker.replyAndWait({ ...f.args(), assignmentId: assignment.message.id, task: assignment.message.task,
      text: "done with clarification", afterSeq: 2 }, { channelId: "channel-one", timeoutMs: 1000 });
    assert.equal(combined.receipt.cursor, 2);
    manager.send({ ...f.args(), recipientId: "worker", text: "next" });
    assert.deepEqual((await combined.waiting).messages.map(message => message.seq), [3]);
  } finally { f.close(); }
});
