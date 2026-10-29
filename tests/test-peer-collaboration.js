const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { randomUUID } = require("node:crypto");
const { PeerSession } = require("../dist/chatroom/peer-session");
const { PEER_PROTOCOL, parsePeerPacket, assertPeerEndpoint } = require("../dist/chatroom/peer-protocol");
const { ChatHub } = require("../dist/chatroom/chatroom-hub");
const { ChatClient } = require("../dist/chatroom/chatroom-client");
const { createPortalLink, parsePortalLink } = require("../dist/chatroom/portal-link");

async function until(predicate) {
  const deadline = Date.now() + 8000;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  throw new Error("Timed out waiting for peer state");
}
function packet(operation, pairId, requestId, payload = {}) {
  return { protocol: PEER_PROTOCOL, operation, pairId, requestId, payload };
}
async function fixture(t, options = {}) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "pkm-peer-"));
  const errors = [], pending = [], reviews = [];
  let runs = 0, approvals = 0, a, b;
  const send = (from, to) => (_target, value) => {
    pending.push(Promise.resolve().then(() => to().receive({ from, fromName: from, packet: value })));
  };
  const common = {
    roomId: "fixture-room", journalDirectory: directory,
    connected: () => true,
    changed() {}, error(error) { errors.push(error.message); },
    approvePair: async () => true,
    approveSwap: async () => options.swap !== false,
    approveTask: async () => { approvals++; return options.approve !== false; },
    execute: async (prompt, signal, id) => { runs++; return options.execute ? options.execute(prompt, signal, id) : { content: prompt, effects: 1 }; },
  };
  a = new PeerSession({ ...common, ...(options.autoReview !== undefined ? { autoReview: () => options.autoReview } : {}), reviewNeeded: review => reviews.push(review), chatId: randomUUID(), chatName: "Controller fixture", machine: "controller-host", endpoint: "wss://controller-host:443", send: send("controller", () => b) });
  b = new PeerSession({ ...common, taskAttempts: options.taskAttempts, chatId: randomUUID(), chatName: "Controlled fixture", machine: "controlled-host", endpoint: "wss://controlled-host:443", send: send("controlled", () => a) });
  if (options.offer) a.accept("controlled", b.offer());
  else a.pair("controlled", b.invite());
  await until(() => a.binding && b.binding);
  t.after(async () => { a.dispose(); b.dispose(); await Promise.all(pending); await fs.rm(directory, { recursive: true, force: true }); });
  return { a, b, errors, reviews, directory, common, get runs() { return runs; }, get approvals() { return approvals; } };
}

test("peer transport rejects unencrypted remote endpoints and malformed or oversized envelopes", () => {
  for (const url of ["ws://127.0.0.1:1234/room", "ws://[::1]/room", "wss://example.test/room"]) assert.doesNotThrow(() => assertPeerEndpoint(url));
  for (const url of ["ws://192.168.1.3/room", "http://localhost/room", "wss://user:secret@example.test/room", "wss://example.test/room?token=secret"]) {
    assert.throws(() => assertPeerEndpoint(url));
  }
  const value = packet("task", randomUUID(), randomUUID(), { prompt: "fixture" });
  assert.deepEqual(parsePeerPacket(value), value);
  for (const invalid of [null, [], { ...value, protocol: "unknown" }, { ...value, operation: "shell" },
    { ...value, requestId: "../escape" }, { ...value, payload: [] }, { ...value, payload: { prompt: "x".repeat(50 * 1024) } }]) {
    assert.throws(() => parsePeerPacket(invalid));
  }
});

test("pairing rejections reach only the matching pending request and terminate it immediately", async t => {
  const outgoing = [], errors = [];
  const options = {
    roomId:"fixture", connected:() => true, changed() {}, error:error => errors.push(error.message),
    approvePair:async () => false, approveSwap:async () => true, approveTask:async () => true, execute:async () => assert.fail("no task may run"),
  };
  const controller = new PeerSession({...options, send:(_to, value) => outgoing.push(value)});
  const controlled = new PeerSession({...options, send:(_to, value) => outgoing.push(value)});
  t.after(() => { controller.dispose(); controlled.dispose(); });
  controller.pair("executor", controlled.invite());
  const request = outgoing.shift();
  await controller.receive({from:"intruder", fromName:"intruder", packet:packet("pair-rejected", request.pairId, request.requestId, {error:"forged"})});
  await controller.receive({from:"executor", fromName:"executor", packet:packet("pair-rejected", request.pairId, randomUUID(), {error:"stale"})});
  assert.equal(controller.pairingFailure, undefined, "wrong sender and request cannot erase the pending pairing");
  await controlled.receive({from:"controller", fromName:"controller", packet:request});
  const rejection = outgoing.shift();
  assert.equal(rejection.operation, "pair-rejected");
  assert.equal(rejection.requestId, request.requestId);
  assert.doesNotThrow(() => parsePeerPacket(rejection));
  assert(!JSON.stringify(rejection).includes(request.payload.secret), "private pairing secret is never echoed");
  await controller.receive({from:"executor", fromName:"executor", packet:rejection});
  assert.match(controller.pairingFailure, /declined by the executing user/);
  assert.equal(controller.binding, undefined);
  assert.equal(controlled.binding, undefined);
  assert.doesNotThrow(() => controller.pair("executor", controlled.invite()), "a rejected pending pairing is cleared for an explicitly initiated new attempt");
});

test("pairing, per-task approval, original receipts and in-memory duplicate suppression", async t => {
  const f = await fixture(t);
  assert.equal(f.a.binding.role, "controller");
  assert.equal(f.b.binding.role, "controlled");
  assert.throws(() => f.b.submit("cannot control"), /controller/);
  const id = f.a.submit("one exact instruction");
  await until(() => f.a.receipts.get(id)?.state === "completed");
  assert.equal(f.runs, 1); assert.equal(f.approvals, 1);
  f.a.submit("one exact instruction", id);
  await until(() => f.b.receipts.get(id)?.state === "completed" && !f.b.processing.size);
  await new Promise(resolve => setTimeout(resolve, 30));
  assert.equal(f.runs, 1); assert.equal(f.approvals, 1);
  assert.throws(() => f.a.submit("changed instruction", id), /different content/);
  await f.b.receive({ from: "controller", fromName: "controller", packet: packet("task", f.b.binding.pairId, id, { prompt: "changed instruction" }) });
  assert(f.errors.some(error => /different content/.test(error)));
  assert.equal(f.runs, 1);
  const files = await fs.readdir(f.directory);
  assert.equal(files.length, 0);
});

test("denial remains denied on duplicate delivery, without execution or a second approval", async t => {
  const f = await fixture(t, { approve: false });
  const id = f.a.submit("denied instruction");
  await until(() => f.a.receipts.get(id)?.state === "denied");
  f.a.submit("denied instruction", id);
  await new Promise(resolve => setTimeout(resolve, 30));
  assert.equal(f.runs, 0); assert.equal(f.approvals, 1);
  assert.equal(f.a.receipts.get(id).state, "denied");
  assert.equal(f.reviews.filter(review => review.state === "denied").length, 1);
});

test("remote failures trigger one controller review without replaying the task", async t => {
  const f = await fixture(t, { execute:async () => { throw new Error("Fixture remote task failure"); } });
  const id = f.a.submit("Fail this original task");
  await until(() => f.a.receipts.get(id)?.state === "failed");
  assert.equal(f.reviews.filter(review => review.state === "failed").length, 1);
  assert.equal(f.reviews.find(review => review.state === "failed").requestId, id);
  assert.equal(f.runs, 1);
});

test("manual retry inspection is separate from original immutable failure and never replays execution", async t => {
  let inspected;
  const f = await fixture(t, { execute: async () => { throw new Error("Original attempt failed"); },
    taskAttempts: async requestId => { inspected = requestId; return { requestId, original: { status: "failed" }, latestResult: { status: "complete", replyId: randomUUID(), content: "Manual retry succeeded" } }; } });
  const id = f.a.submit("An original instruction");
  await until(() => f.a.receipts.get(id)?.state === "failed");
  const original = JSON.stringify(f.a.receipts.get(id));
  const attempts = await f.a.inspectAttempts(id);
  assert.equal(inspected, id);
  assert.equal(attempts.latestResult.content, "Manual retry succeeded");
  assert.equal(JSON.stringify(f.a.receipts.get(id)), original);
  assert.equal(f.runs, 1);
  await assert.rejects(f.a.inspectAttempts(randomUUID()), /original model task/);
});

test("task inspection rejects mismatched results and fails closed for legacy Hosts", async t => {
  const f = await fixture(t, { taskAttempts: async () => ({ requestId: randomUUID(), latestResult: { content: "Unrelated task" } }) });
  const id = f.a.submit("One instruction");
  await until(() => f.a.receipts.get(id)?.state === "completed");
  await assert.rejects(f.a.inspectAttempts(id), /do not match/);
  f.a.binding.peerCapabilities = [];
  await assert.rejects(f.a.inspectAttempts(id), /Upgrade both Hosts/);
  assert.equal(f.runs, 1);
});

test("task inspection cannot return absent lineage, stack local approvals, flip direction or outlive revocation", async t => {
  const missing = await fixture(t, { taskAttempts: async () => undefined });
  const original = missing.a.submit("An untagged legacy attempt");
  await until(() => missing.a.receipts.get(original)?.state === "completed");
  await assert.rejects(missing.a.inspectAttempts(original), /lineage is unavailable/);
  let release, inspecting = false;
  const f = await fixture(t, { taskAttempts: () => { inspecting = true; return new Promise(resolve => { release = resolve; }); } });
  const id = f.a.submit("One instruction");
  await until(() => f.a.receipts.get(id)?.state === "completed");
  const pending = f.a.inspectAttempts(id);
  await until(() => inspecting);
  await assert.rejects(f.a.inspectAttempts(id), /Another task attempt inspection/);
  assert.throws(() => f.a.requestSwap(), /result inspection/);
  const revoked = assert.rejects(pending, /Portal disconnected before attempt inspection completed/);
  f.b.revoke();
  await revoked;
  release({ requestId:id });
  assert.equal(f.runs, 1);
});

test("observations mirror only the approved task/Chat, use local freshness and reject reordered or unrelated frames", async t => {
  let finish;
  const f = await fixture(t, { execute: () => new Promise(resolve => { finish = resolve; }) });
  const id = f.a.submit("Observe this task only");
  await until(() => !!finish);
  const observation = { requestId:id, chatId:f.a.binding.peerChatId, sequence:1, at:Date.now() + 86400000, state:"waiting-approval", visibility:"task-only",
    approvals:[{ title:"Run program powershell.exe?" }], tools:[{ name:"run_process", status:"running" }] };
  f.b.observe(observation);
  await until(() => f.a.observations.has(id));
  assert.equal(f.a.observations.get(id).state, "waiting-approval");
  const waiting = f.reviews.filter(review => review.state === "waiting-approval").length;
  f.b.observe({ ...observation, sequence:2 });
  await until(() => f.a.observations.get(id).sequence === 2);
  assert.equal(f.reviews.filter(review => review.state === "waiting-approval").length, waiting, "heartbeats do not retrigger a waiting episode");
  assert(f.a.observations.get(id).receivedAt <= Date.now(), "peer clock is not local freshness evidence");
  f.b.observe({ ...observation, sequence:0, state:"running" });
  await new Promise(resolve => setTimeout(resolve, 10));
  assert.equal(f.a.observations.get(id).sequence, 2);
  await f.a.receive({ from:"controlled", fromName:"controlled", packet:packet("observe", f.a.binding.pairId, id, { observation:{ ...observation, sequence:2, chatId:randomUUID() } }) });
  assert(f.errors.some(error => /different Portal Chat/.test(error)));
  f.b.observe({ ...observation, sequence:3, visibility:"restricted", answer:"must not survive restricted parsing" });
  await until(() => f.a.observations.get(id).sequence === 3);
  assert.equal(f.a.observations.get(id).answer, undefined);
  assert.equal(f.a.observations.get(id).tools, undefined);
  f.b.observe({ ...observation, sequence:4, state:"running" });
  await until(() => f.a.observations.get(id).sequence === 4);
  f.b.observe({ ...observation, sequence:5, state:"waiting-input" });
  await until(() => f.a.observations.get(id).sequence === 5);
  assert.equal(f.reviews.filter(review => review.state === "waiting-input").length, 1);
  finish({ content:"done" });
  await until(() => f.a.receipts.get(id)?.state === "completed");
  assert.equal(f.reviews.filter(review => review.state === "completed").length, 1);
  assert(f.reviews.every(review => review.pairId === f.a.binding.pairId && review.requestId === id));
  await f.a.receive({ from:"controlled", fromName:"controlled", packet:packet("receipt", f.a.binding.pairId, id, { state:"completed" }) });
  assert.equal(f.reviews.filter(review => review.state === "completed").length, 1, "duplicate receipts must not reawaken controller");
  await f.a.receive({ from:"controlled", fromName:"controlled", packet:packet("observe", f.a.binding.pairId, id, { observation:{ ...observation, sequence:6, state:"waiting-input" } }) });
  assert.equal(f.reviews.filter(review => review.state === "waiting-input").length, 1, "late waiting frames cannot reopen a finished request");
  assert.throws(() => f.b.observe({ ...observation, requestId:randomUUID() }), /active|task/i);
});

test("unpaired, expired and wrong-peer packets never execute", async t => {
  const f = await fixture(t);
  await f.b.receive({ from: "intruder", fromName: "controller", packet: packet("task", f.b.binding.pairId, randomUUID(), { prompt: "spoof" }) });
  await f.b.receive({ from: "controller", fromName: "controller", packet: packet("task", randomUUID(), randomUUID(), { prompt: "stale pairing" }) });
  assert.equal(f.runs, 0); assert.equal(f.approvals, 0);
  f.a.revoke();
  await until(() => !f.b.binding);
  const code = f.b.invite();
  f.b.invitation.expiresAt = Date.now() - 1;
  const [, , pairId, secret] = code.split(":");
  await f.b.receive({ from: "controller", fromName: "controller", packet: packet("pair", pairId, randomUUID(), { secret }) });
  assert.equal(f.b.binding, undefined);
  assert(f.errors.some(error => /expired/.test(error)));
});

test("original request cancellation aborts work and reports unknown effects rather than success", async t => {
  const f = await fixture(t, { execute: async (_prompt, signal) => new Promise((resolve, reject) => {
    signal.addEventListener("abort", () => reject(new Error("Cancelled with possible effects")), { once: true });
  }) });
  const id = f.a.submit("long task");
  await until(() => f.runs === 1);
  f.a.cancel(id);
  await until(() => f.a.receipts.get(id)?.state === "unknown");
  assert.equal(f.runs, 1);
  f.a.submit("long task", id);
  await new Promise(resolve => setTimeout(resolve, 30));
  assert.equal(f.runs, 1);
});

test("temporary task receipts never touch disk and completed duplicate requests stay suppressed", async t => {
  const f = await fixture(t);
  const id = f.a.submit("original");
  await until(() => f.a.receipts.get(id)?.state === "completed");
  assert.deepEqual(await fs.readdir(f.directory),[]);
  f.a.receipts.delete(id);
  f.a.submit("original", id);
  await until(() => f.a.receipts.get(id)?.state === "completed");
  assert.equal(f.runs, 1);
});

test("a restarted Host has no pairing and rejects old tasks without disk recovery", async t => {
  let finish;
  const f = await fixture(t, { execute: async () => new Promise(resolve => { finish = resolve; }) });
  const id = f.a.submit("one side effect");
  await until(() => f.runs === 1);
  const receipts = [];
  const second = new PeerSession({ ...f.common, send: (_target, value) => receipts.push(value) });
  t.after(() => second.dispose());
  await second.receive({ from: "controller", fromName: "controller", packet: packet("task", f.b.binding.pairId, id, { prompt: "one side effect" }) });
  assert.equal(f.runs, 1);
  assert.equal(receipts.length,0);
  assert(f.errors.some(error=>/approved connection/.test(error)));
  finish({ effects: 1 });
  await until(() => f.a.receipts.get(id)?.state === "completed");
});

test("changed content is rejected during approval and task memory never evicts replay fingerprints",async t=>{
  const f=await fixture(t);
  let approve;
  f.b.options.approveTask=async()=>new Promise(resolve=>{approve=resolve;});
  const id=f.a.submit("approved content only");
  await until(()=>approve);
  await f.b.receive({from:"controller",fromName:"controller",packet:packet("task",f.b.binding.pairId,id,{prompt:"changed while pending"})});
  assert(f.errors.some(error=>/different content/.test(error)));
  assert.equal(f.runs,0);
  approve(true);await until(()=>f.a.receipts.get(id)?.state==="completed"&&!f.b.processing.size);
  while(f.b.tasks.size<1000)f.b.tasks.set(randomUUID(),{fingerprint:"previous",receipt:{state:"completed"}});
  await f.b.receive({from:"controller",fromName:"controller",packet:packet("task",f.b.binding.pairId,randomUUID(),{prompt:"must not execute"})});
  assert.equal(f.b.tasks.size,1000);
  assert(f.errors.some(error=>/1,000-task limit/.test(error)));
  f.a.submit("approved content only",id);
  await new Promise(resolve=>setTimeout(resolve,20));
  assert.equal(f.runs,1,"the earliest fingerprint still suppresses replay at capacity");
});

test("revocation while a local approval is pending prevents dispatch", async t => {
  const f = await fixture(t);
  let decide;
  f.b.options.approveTask = async () => new Promise(resolve => { decide = resolve; });
  const id = f.a.submit("await approval");
  await until(() => decide);
  f.a.revoke();
  await until(() => !f.b.binding);
  decide(true);
  await until(() => f.b.processing.size === 0);
  assert.equal(f.b.receipts.size,0,"revoked connections retain no receipts");
  assert.equal(f.runs, 0);
});

test("actual ChatHub and ChatClients relay private peer tasks without chat messages or history", { timeout: 20000 }, async t => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "pkm-peer-ws-"));
  const hub = new ChatHub(), secrets = new Map(), clients = [];
  hub.configureLifecycle(directory, 1024 * 1024, "fixture-owner", {
    get: async key => secrets.get(key), store: async (key, value) => { secrets.set(key, value); }, delete: async key => { secrets.delete(key); },
  });
  t.after(async () => { for (const client of clients) client.disconnect(); await hub.stop(); await fs.rm(directory, { recursive: true, force: true }); });
  await hub.start(0);
  const room = await hub.createRoom("Peer Fixture", "fixture-only-secret");
  const deliveries = [[], [], []], messages = [[], [], []];
  for (let index = 0; index < 3; index++) {
    const client = new ChatClient({
      onStatus() {}, onPresence() {}, onMessage: value => messages[index].push(value), onHistory() {}, onFileComplete() {},
      onPeer: value => deliveries[index].push(value),
    });
    clients.push(client);
    client.connect({ url: `ws://127.0.0.1:${hub.port}/${encodeURIComponent(room.room)}`,
      room: room.room, roomId: room.roomId, user: `Peer${index}`, kind: "human", token: room.secret, cid: `peer-${index}`,
      ...(index === 0 ? { hostToken: room.hostToken } : {}) });
    await until(() => client.isConnected);
  }
  const value = packet("task", randomUUID(), randomUUID(), { prompt: "private fixture instruction" });
  clients[0].sendPeer(clients[1].participantId, value);
  await until(() => deliveries[1].length === 1);
  assert.equal(deliveries[1][0].from, clients[0].participantId);
  assert.equal(deliveries[1][0].fromName, "Peer0");
  assert.deepEqual(deliveries[1][0].packet, value);
  assert.equal(deliveries[0].length, 0);
  assert.equal(deliveries[2].length, 0);
  assert(!messages.flat().some(message => message.text?.includes("private fixture instruction")));
  const persisted = await hub.persistence.openRoom(room.roomId, room.room);
  assert(!JSON.stringify(persisted.messages).includes("private fixture instruction"));
  clients[0].sendPeer("missing-participant", value);
  await until(() => messages[0].some(message => /connected peer/.test(message.text)));
  assert.equal(clients[0].isConnected, true, "Rejected peer delivery must not poison the Chat connection");
  const forged = packet("cancel", value.pairId, randomUUID());
  clients[0].ws.send(JSON.stringify({ t: "peer", target: clients[1].participantId, from: clients[2].participantId, fromName: "forged", packet: forged }));
  await until(() => deliveries[1].length === 2);
  assert.equal(deliveries[1][1].from, clients[0].participantId, "Hub binds sender from authenticated connection, never supplied frame fields");
  assert.equal(deliveries[1][1].fromName, "Peer0");
});

test("Portal offer makes the link creator controller and the explicit acceptor controlled, without a second pair prompt", async t => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "pkm-peer-"));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const errors = []; let pairPrompts = 0, a, b;
  const common = { roomId: "r", journalDirectory: directory, connected: () => true, changed() {}, error(e) { errors.push(e.message); },
    approvePair: async () => { pairPrompts++; return true; }, approveSwap: async () => true, approveTask: async () => true, execute: async prompt => prompt };
  a = new PeerSession({ ...common, send: (_t, value) => void b.receive({ from: "initiator", fromName: "initiator", packet: value }) });
  b = new PeerSession({ ...common, send: (_t, value) => void a.receive({ from: "receiver", fromName: "receiver", packet: value }) });
  b.accept("initiator", a.offer());
  await until(() => a.binding && b.binding);
  assert.equal(a.binding.role, "controller");
  assert.equal(b.binding.role, "controlled");
  assert.equal(pairPrompts, 0);
  const id = a.submit("hello");
  await until(() => a.receipts.get(id)?.state === "completed");
  assert.deepEqual(errors, []);
});

test("an offer redeemed as controller (or a legacy pair) never grants control to the redeemer", async t => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "pkm-peer-"));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const errors = []; let a, b;
  const common = { roomId: "r", journalDirectory: directory, connected: () => true, changed() {}, error(e) { errors.push(e.message); },
    approvePair: async () => true, approveSwap: async () => true, approveTask: async () => true, execute: async () => 1 };
  a = new PeerSession({ ...common, send: (_t, value) => void b.receive({ from: "a", fromName: "a", packet: value }) });
  b = new PeerSession({ ...common, send: (_t, value) => void a.receive({ from: "b", fromName: "b", packet: value }) });
  b.pair("a", a.offer());
  await until(() => errors.length);
  assert.match(errors[0], /wrong control direction/);
  assert.equal(a.binding, undefined); assert.equal(b.binding, undefined);
  const code = a.offer().split(":");
  await a.receive({ from: "b", fromName: "b", packet: packet("pair", code[2], randomUUID(), { secret: code[3] }) });
  assert.equal(a.binding, undefined, "legacy pair without role asks for control and must be rejected by an offer");
});

test("switching control direction requires explicit consent on the peer and flips both roles", async t => {
  const f = await fixture(t, { offer: true });
  assert.equal(f.a.binding.role, "controlled");
  assert.equal(f.b.binding.role, "controller");
  f.b.requestSwap();
  assert.throws(() => f.b.submit("blocked while pending"), /switch is pending/);
  await until(() => f.a.binding.role === "controller" && f.b.binding.role === "controlled");
  assert.equal(f.b.swapPending, false);
  const id = f.a.submit("after switch");
  await until(() => f.a.receipts.get(id)?.state === "completed");
  assert.throws(() => f.b.submit("old controller"), /controller/);
});

test("a declined switch leaves roles unchanged", async t => {
  const f = await fixture(t, { swap: false });
  f.a.requestSwap();
  await until(() => f.errors.some(error => /declined/.test(error)));
  assert.equal(f.a.binding.role, "controller");
  assert.equal(f.b.binding.role, "controlled");
  assert.equal(f.a.swapPending, false);
});

test("switching is refused while a remote task is active, and unsolicited answers are ignored", async t => {
  let release;
  const f = await fixture(t, { execute: () => new Promise(resolve => { release = resolve; }) });
  const id = f.a.submit("long task");
  await until(() => f.b.receipts.get(id)?.state === "running");
  assert.throws(() => f.b.requestSwap(), /active remote task/);
  f.a.requestSwap();
  await until(() => f.errors.some(error => /still active/.test(error)));
  assert.equal(f.a.binding.role, "controller");
  release("done");
  await until(() => f.a.receipts.get(id)?.state === "completed");
  await f.a.receive({ from: "controlled", fromName: "controlled", packet: packet("swapped", f.a.binding.pairId, randomUUID(), { accepted: true }) });
  assert.equal(f.a.binding.role, "controller", "a forged acceptance must not flip roles");
});

test("Portal link round-trips Room credentials and rejects tampering or non-loopback plain WS", () => {
  const code = `pkmpeer:v1:${randomUUID()}:${"a".repeat(48)}`;
  const value = { url: "ws://localhost:7345", room: "PKM Portal", roomId: "room-1", secret: "s3cret", code, controller: "p-1", name: "me@host" };
  const link = createPortalLink(value);
  assert.deepEqual(parsePortalLink(`  ${link}\n`), value);
  assert.throws(() => parsePortalLink(link.slice(0, -1) + (link.endsWith("A") ? "B" : "A")), /checksum/);
  assert.throws(() => parsePortalLink("pkchat:v1:abc.0123456789abcdef"), /not a complete/);
  assert.throws(() => createPortalLink({ ...value, url: "ws://192.168.1.5:7345" }), /WSS/);
  assert.throws(() => createPortalLink({ ...value, code: "bad" }), /pairing code/);
  assert.doesNotThrow(() => createPortalLink({ ...value, url: "wss://portal.example.test" }));
  for (const role of ["controller", "controlled"]) {
    assert.deepEqual(parsePortalLink(createPortalLink({ ...value, role })), { ...value, role });
  }
  assert.throws(() => createPortalLink({ ...value, role: "both" }), /control direction/);
});

test("Portal link over an actual ChatHub: receiver joins with link credentials and becomes controlled", { timeout: 20000 }, async t => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "pkm-portal-ws-"));
  const hub = new ChatHub(), secrets = new Map(), clients = [], sessions = [], errors = [];
  hub.configureLifecycle(directory, 1024 * 1024, "fixture-owner", {
    get: async key => secrets.get(key), store: async (key, value) => { secrets.set(key, value); }, delete: async key => { secrets.delete(key); },
  });
  t.after(async () => { for (const s of sessions) s.dispose(); for (const c of clients) c.disconnect(); await hub.stop(); await fs.rm(directory, { recursive: true, force: true }); });
  await hub.start(0);
  const room = await hub.createRoom("PKM Portal fixture");
  const members = [[], []];
  const connect = (index, opts) => {
    const client = new ChatClient({
      onStatus() {}, onMessage() {}, onHistory() {}, onFileComplete() {},
      onPresence: value => { members[index] = value; },
      onPeer: delivery => void sessions[index]?.receive(delivery),
    });
    clients[index] = client;
    sessions[index] = new PeerSession({ roomId: room.roomId, journalDirectory: path.join(directory, `j${index}`), connected: () => client.isConnected,
      send: (target, value) => client.sendPeer(target, value), changed() {}, error: e => errors.push(e.message),
      approvePair: async () => true, approveSwap: async () => true, approveTask: async () => true, execute: async prompt => ({ echoed: prompt }) });
    client.connect({ kind: "human", ...opts });
    return client;
  };
  const initiator = connect(0, { url: `ws://127.0.0.1:${hub.port}`, room: room.room, roomId: room.roomId, user: "me@host", token: room.secret, cid: "i", hostToken: room.hostToken });
  await until(() => initiator.isConnected && initiator.participantId);
  const link = parsePortalLink(createPortalLink({ url: `ws://localhost:${hub.port}`, room: room.room, roomId: room.roomId, secret: room.secret,
    code: sessions[0].offer(), controller: initiator.participantId, name: "me@host" }));
  const receiver = connect(1, { url: link.url, room: link.room, roomId: link.roomId, user: `${link.name}-2`, token: link.secret, cid: "r" });
  await until(() => receiver.isConnected && members[1].some(member => member.participantId === link.controller));
  sessions[1].accept(link.controller, link.code);
  await until(() => sessions[0].binding && sessions[1].binding);
  assert.equal(sessions[0].binding.role, "controller");
  assert.equal(sessions[1].binding.role, "controlled");
  const id = sessions[0].submit("hello over portal");
  await until(() => sessions[0].receipts.get(id)?.state === "completed");
  assert.deepEqual(sessions[0].receipts.get(id).result, { echoed: "hello over portal" });
  assert.deepEqual(errors, []);
});

test("a hub rejection marked connectionAlive keeps a non-host Portal client connected", { timeout: 20000 }, async t => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "pkm-peer-alive-"));
  const hub = new ChatHub(), secrets = new Map(), clients = [], statuses = [];
  hub.configureLifecycle(directory, 1024 * 1024, "fixture-owner", {
    get: async key => secrets.get(key), store: async (key, value) => { secrets.set(key, value); }, delete: async key => { secrets.delete(key); },
  });
  t.after(async () => { for (const client of clients) client.disconnect(); await hub.stop(); await fs.rm(directory, { recursive: true, force: true }); });
  await hub.start(0);
  const room = await hub.createRoom("Alive Fixture", "fixture-only-secret");
  const messages = [];
  for (let index = 0; index < 2; index++) {
    const client = new ChatClient({
      onStatus: value => { if (index === 1) statuses.push(value); }, onPresence() {}, onMessage: value => { if (index === 1) messages.push(value); },
      onHistory() {}, onFileComplete() {}, onPeer() {},
    });
    clients.push(client);
    client.connect({ url: `ws://127.0.0.1:${hub.port}/${encodeURIComponent(room.room)}`,
      room: room.room, roomId: room.roomId, user: `Alive${index}`, kind: "human", token: room.secret, cid: `alive-${index}`,
      ...(index === 0 ? { hostToken: room.hostToken } : {}) });
    await until(() => client.isConnected);
  }
  assert(clients[1].sendMeetingSnapshot({ current: null, history: [], trash: [] }));
  await until(() => messages.some(message => /Only the Room Host/.test(message.text)));
  assert.equal(clients[1].isConnected, true, "Portal UI must keep showing the live connection");
  assert(!statuses.includes("error"));
});

test("the controlled side learns whether the controller reviews automatically or must be queried", async t => {
  for (const autoReview of [true, false]) {
    const f = await fixture(t, { autoReview });
    assert.equal(f.b.binding.peerCapabilities.includes("review-mode-v1"), true);
    assert.equal(f.b.binding.peerCapabilities.includes("auto-review-v1"), autoReview);
  }
  const legacy = await fixture(t);
  assert.equal(legacy.b.binding.peerCapabilities.includes("review-mode-v1"), false);
});

test("an unredeemed link exposes only its local role and deadline, and clears once paired", async t => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "pkm-peer-"));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  let a, b;
  const common = { roomId: "r", journalDirectory: directory, connected: () => true, changed() {}, error() {},
    approvePair: async () => true, approveSwap: async () => true, approveTask: async () => true, execute: async prompt => prompt };
  a = new PeerSession({ ...common, send: (_t, value) => void b.receive({ from: "initiator", fromName: "initiator", packet: value }) });
  b = new PeerSession({ ...common, send: (_t, value) => void a.receive({ from: "receiver", fromName: "receiver", packet: value }) });
  assert.equal(a.pendingInvitation, undefined);
  const before = Date.now();
  const code = a.offer();
  const pending = a.pendingInvitation;
  assert.equal(pending.role, "controller");
  assert(pending.expiresAt >= before + 10 * 60_000 - 1000 && pending.expiresAt <= Date.now() + 10 * 60_000);
  assert.deepEqual(Object.keys(pending).sort(), ["expiresAt", "role"], "the link secret is never exposed");
  assert(!JSON.stringify(pending).includes(code.split(":").at(-1)));
  b.accept("initiator", code);
  await until(() => a.binding && b.binding);
  assert.equal(a.pendingInvitation, undefined);
  const c = new PeerSession({ ...common, send() {} });
  c.invite();
  assert.equal(c.pendingInvitation.role, "controlled");
  c.revoke();
  assert.equal(c.pendingInvitation, undefined, "revoking clears the unredeemed link");
  a.dispose(); b.dispose(); c.dispose();

  // A redeemed controlled-side link stays "in progress" while the local pairing approval is open.
  let release;
  const approval = new Promise(resolve => { release = resolve; });
  let d, e;
  d = new PeerSession({ ...common, approvePair: () => approval, send: (_t, value) => void e.receive({ from: "holder", fromName: "holder", packet: value }) });
  e = new PeerSession({ ...common, send: (_t, value) => void d.receive({ from: "redeemer", fromName: "redeemer", packet: value }) });
  const invitation = d.invite();
  e.pair("holder", invitation);
  await until(() => !d.pendingInvitation);
  assert.ok(d.pairingInProgress && d.pairingInProgress.expiresAt > Date.now(), "pairing approval keeps the open wait alive");
  assert.equal(d.binding, undefined);
  release(true);
  await until(() => d.binding && e.binding);
  assert.equal(d.pairingInProgress, undefined);
  d.dispose(); e.dispose();
});
