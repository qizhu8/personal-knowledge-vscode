const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const path = require("node:path");
const os = require("node:os");
const vm = require("node:vm");
const { randomUUID } = require("node:crypto");
const extensionRoot = process.env.PKM_PORTAL_TRANSPORT_EXTENSION_ROOT || path.resolve(__dirname, "..");
const { ChatHub } = require(path.join(extensionRoot, "dist/chatroom/chatroom-hub"));
const { ChatClient } = require(path.join(extensionRoot, "dist/chatroom/chatroom-client"));
const { PeerSession } = require(path.join(extensionRoot, "dist/chatroom/peer-session"));
const { PORTAL_TRANSPORT_PATH, PEER_PROTOCOL, assertPeerEndpoint } = require(path.join(extensionRoot, "dist/chatroom/peer-protocol"));
const { createPortalLink, parsePortalLink } = require(path.join(extensionRoot, "dist/chatroom/portal-link"));
const { preflightPortalEndpoint } = require(path.join(extensionRoot, "dist/chatroom/portal-link"));
const { createChatMagicLink, parseChatMagicLink, chatInviteMessage } = require(path.join(extensionRoot, "dist/chatroom/chat-magic-link"));

async function until(predicate) {
  const deadline = Date.now() + 8000;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  throw new Error("Timed out waiting for Portal transport");
}

async function fixture(t) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "pkm-portal-relay-"));
  const hub = new ChatHub(), secrets = new Map(), clients = [];
  hub.configureLifecycle(directory, 1024 * 1024, "fixture-owner", {
    get:async key => secrets.get(key), store:async (key, value) => { secrets.set(key, value); }, delete:async key => { secrets.delete(key); },
  });
  await hub.start(0);
  const connect = async (channel, cid, options = {}) => {
    const received = [], notices = [];
    const client = new ChatClient({
      onStatus() {}, onPresence() {}, onHistory:() => { throw new Error("Portal must not replay Room history"); },
      onMessage:message => notices.push(message), onFileComplete:() => { throw new Error("Use Portal file protocol"); },
      onPeer:delivery => { received.push(delivery); options.onPeer?.(delivery); },
    });
    clients.push(client);
    client.connect({ url:`ws://127.0.0.1:${hub.port}${PORTAL_TRANSPORT_PATH}`, room:"Portal", roomId:channel.channelId,
      token:channel.secret, cid, user:cid });
    await until(() => client.isConnected || client.status === "error" || client.status === "disconnected");
    return { client, received, notices };
  };
  t.after(async () => {
    for (const client of clients) client.disconnect();
    await hub.stop();
    await fs.rm(directory, { recursive:true, force:true });
  });
  return { hub, secrets, directory, clients, connect };
}

test("dedicated Portal sockets isolate two endpoints without creating Rooms, credentials, archives or Meeting state", async t => {
  const f = await fixture(t);
  const before = await fs.readdir(f.directory);
  const channel = f.hub.createPortalChannel();
  const a = await f.connect(channel, "a"), b = await f.connect(channel, "b");
  assert(a.client.isConnected && b.client.isConnected);
  const value = { protocol:PEER_PROTOCOL, operation:"task", pairId:randomUUID(), requestId:randomUUID(), payload:{ prompt:"private task" } };
  a.client.sendPeer(b.client.participantId, value);
  await until(() => b.received.length === 1);
  assert.equal(b.received[0].from, a.client.participantId);
  assert.deepEqual(b.received[0].packet, value);
  assert.deepEqual(f.hub.adminRooms(), []);
  assert.deepEqual(await f.hub.listStoredRooms(), []);
  assert.equal(f.secrets.size, 0, "no Room credentials are created");
  assert.deepEqual(await fs.readdir(f.directory), before, "no per-Portal Room directory or transcript is created");
  const other = f.hub.createPortalChannel();
  const c = await f.connect(other, "c");
  a.client.sendPeer(c.client.participantId, value);
  await until(() => a.notices.some(message => /not connected/.test(message.text)));
  assert.equal(c.received.length, 0, "a channel cannot target another Portal");
  const third = await f.connect(channel, "third");
  assert.equal(third.client.isConnected, false, "a third endpoint cannot join");
  const invalid = await f.connect({ ...other, secret:"wrong-secret" }, "invalid");
  assert.equal(invalid.client.isConnected, false);
  a.client.ws.send(JSON.stringify({ t:"msg", text:"must not become a Chatroom message" }));
  await until(() => a.notices.some(message => /peer packets only/.test(message.text)));
  assert.equal(b.notices.length, 0);
  a.client.ws.send(JSON.stringify({ t:"peer", from:"forged", fromName:"forged", target:b.client.participantId, packet:value }));
  await until(() => b.received.length === 2);
  assert.equal(b.received[1].from, a.client.participantId);
  assert.equal(b.received[1].fromName, "a");
  const identity = b.client.participantId;
  b.client.disconnect();
  await until(() => a.client.members.length === 1);
  const rejoined = await f.connect(channel, "b");
  assert.equal(rejoined.client.participantId, identity, "transport identity survives reconnect without Room membership storage");
  const room = await f.hub.createRoom("portal", "ordinary-room-secret");
  const ordinary = new ChatClient({ onStatus() {}, onPresence() {}, onMessage() {}, onHistory() {}, onFileComplete() {} });
  f.clients.push(ordinary);
  ordinary.connect({ url:`ws://127.0.0.1:${f.hub.port}/portal`, room:room.room, roomId:room.roomId,
    token:room.secret, hostToken:room.hostToken, user:"Room Host", cid:"ordinary" });
  await until(() => ordinary.isConnected);
  assert.equal(f.hub.adminRooms().length, 1, "a Room named portal keeps its normal /portal join path");
  await f.hub.adminCloseAll();
  assert(a.client.isConnected && rejoined.client.isConnected && c.client.isConnected,
    "Close all Rooms does not close dedicated Portal channels");
  f.hub.closePortalChannel(channel.channelId);
  await until(() => !a.client.isConnected && !rejoined.client.isConnected);
  assert.equal(c.client.isConnected, true, "closing one Portal cannot close another");
});

test("endpoint preflight sends no credentials, creates no pairing and reports refused connections", async t => {
  const f = await fixture(t);
  const channel = f.hub.createPortalChannel();
  await preflightPortalEndpoint(`ws://127.0.0.1:${f.hub.port}${PORTAL_TRANSPORT_PATH}`);
  const a = await f.connect(channel, "preflight-a"), b = await f.connect(channel, "preflight-b");
  assert(a.client.isConnected && b.client.isConnected, "preflight never consumes one of the channel's two seats");
  const net = require("node:net");
  const server = net.createServer();
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  const port = server.address().port;
  await new Promise(resolve => server.close(resolve));
  await assert.rejects(preflightPortalEndpoint(`ws://127.0.0.1:${port}${PORTAL_TRANSPORT_PATH}`, 500),
    /Portal endpoint is unreachable|connection deadline/);
  const sockets = new Set();
  const stalled = net.createServer(socket => { sockets.add(socket); socket.on("close", () => sockets.delete(socket)); });
  await new Promise(resolve => stalled.listen(0, "127.0.0.1", resolve));
  t.after(async () => { for (const socket of sockets) socket.destroy(); await new Promise(resolve => stalled.close(resolve)); });
  await assert.rejects(preflightPortalEndpoint(`ws://127.0.0.1:${stalled.address().port}${PORTAL_TRANSPORT_PATH}`, 30),
    /connection deadline|handshake/);
  assert.throws(() => preflightPortalEndpoint("ws://192.168.1.1/pkm/portal"), /WSS\/TLS/);
});

test("real Portal relay preserves approval/deduplication but a restarted endpoint requires fresh pairing", async t => {
  const f = await fixture(t), channel = f.hub.createPortalChannel(), errors = [], sessions = [];
  let a, b, runs = 0, approvals = 0;
  const left = await f.connect(channel, "left", { onPeer:delivery => void a.receive(delivery) });
  const right = await f.connect(channel, "right", { onPeer:delivery => void b.receive(delivery) });
  const common = {
    roomId:channel.channelId, journalDirectory:path.join(f.directory, "peer-receipts"), changed() {},
    error:error => errors.push(error.message), approvePair:async () => true, approveSwap:async () => true,
    approveTask:async () => { approvals++; return true; }, execute:async prompt => { runs++; return { content:prompt }; },
  };
  a = new PeerSession({ ...common, chatId:randomUUID(), connected:() => left.client.isConnected, send:(target, packet) => left.client.sendPeer(target, packet) });
  b = new PeerSession({ ...common, chatId:randomUUID(), connected:() => right.client.isConnected, send:(target, packet) => right.client.sendPeer(target, packet),
  });
  sessions.push(a, b);
  t.after(() => { for (const peer of sessions) peer.dispose(); });
  b.accept(left.client.participantId, a.offer());
  await until(() => a.binding && b.binding);
  const requestId = a.submit("one approved task");
  await until(() => a.receipts.get(requestId)?.state === "completed");
  assert.equal(runs, 1); assert.equal(approvals, 1);
  a.submit("one approved task", requestId);
  await new Promise(resolve => setTimeout(resolve, 50));
  assert.equal(runs, 1);
  const storedChatId = b.options.chatId;
  b.dispose(); right.client.disconnect();
  await until(() => left.client.members.length === 1);
  const restarted = await f.connect(channel, "right", { onPeer:delivery => void b.receive(delivery) });
  b = new PeerSession({ ...common, chatId:storedChatId, connected:() => restarted.client.isConnected,
    send:(target, packet) => restarted.client.sendPeer(target, packet) });
  sessions.push(b);
  assert.equal(b.binding,undefined);
  assert.equal(runs, 1, "a restarted endpoint cannot replay or recover a task");
  assert.equal(await fs.stat(path.join(f.directory,"peer-receipts")).then(()=>true,()=>false),false);
  assert.deepEqual(errors, []);
  assert.deepEqual(f.hub.adminRooms(), []);
  assert.deepEqual(await f.hub.listStoredRooms(), []);
});

test("a reconnecting endpoint replaces its half-open socket and held receipts are re-delivered once", async t => {
  const f = await fixture(t), channel = f.hub.createPortalChannel(), errors = [];
  let a, b, release, online = true;
  const gate = new Promise(resolve => { release = resolve; });
  const left = await f.connect(channel, "left", { onPeer:delivery => void a.receive(delivery) });
  let right = await f.connect(channel, "right", { onPeer:delivery => void b.receive(delivery) });
  const common = { roomId:channel.channelId, changed() {}, error:error => errors.push(error.message), approvePair:async () => true, approveSwap:async () => true, approveTask:async () => true };
  a = new PeerSession({ ...common, chatId:randomUUID(), connected:() => left.client.isConnected, send:(target, packet) => left.client.sendPeer(target, packet), execute:async () => ({}) });
  b = new PeerSession({ ...common, chatId:randomUUID(), connected:() => online && right.client.isConnected, send:(target, packet) => right.client.sendPeer(target, packet),
    execute:async prompt => { await gate; return { content:prompt }; } });
  t.after(() => { a.dispose(); b.dispose(); });
  b.accept(left.client.participantId, a.offer());
  await until(() => a.binding && b.binding);
  const requestId = a.submit("long task");
  await until(() => a.receipts.get(requestId)?.state === "running");
  const identity = right.client.participantId, stale = right.client;
  stale.intentionalClose = true;
  // The relay still holds the old socket open when the same endpoint joins again.
  right = await f.connect(channel, "right", { onPeer:delivery => void b.receive(delivery) });
  assert.equal(right.client.isConnected, true, "the rejoin is not rejected as a duplicate endpoint");
  assert.equal(right.client.participantId, identity, "the rejoining endpoint keeps its identity");
  await until(() => stale.status === "disconnected");
  await until(() => left.client.members.length === 2);
  online = false;
  release();
  await until(() => b.receipts.get(requestId)?.state === "completed");
  await new Promise(resolve => setTimeout(resolve, 50));
  assert.equal(a.receipts.get(requestId)?.state, "running", "the completion is held while the transport is down");
  online = true;
  assert.equal(b.resync(Date.now()), 1);
  await until(() => a.receipts.get(requestId)?.state === "completed");
  assert.equal(b.resync(Date.now() + 1000), 0, "already re-delivered receipts are not resent");
  assert.deepEqual(errors, [], "held receipts do not surface transport errors");
});

test("actual Host start/accept uses dedicated transport and leaves Chatroom selection and Room maps untouched", async t => {
  const f = await fixture(t), ts = require("typescript");
  const extension = await fs.readFile(path.join(__dirname, "../src/extension.ts"), "utf8");
  const ast = ts.createSourceFile("extension.ts", extension, ts.ScriptTarget.Latest, true);
  const manager = ast.statements.find(node => ts.isClassDeclaration(node) && node.name?.text === "ChatRoomManager");
  let clipboard;
  const errors=[], portalEvents=[];
  const context = vm.createContext({
    Map, Set, Date, URL, Promise, process, path, AbortController, setTimeout, clearTimeout, setInterval, clearInterval, ChatHub, ChatClient, PORTAL_TRANSPORT_PATH, PORTAL_GRACE_MS:2500, endpointScope:() => "loopback",
    randomUUID, os, assertPeerEndpoint, createPortalLink, parsePortalLink, preflightPortalEndpoint, createChatMagicLink, chatInviteMessage, PeerSession,
    PortalPermissions:require("../dist/chatroom/portal-permissions").PortalPermissions,
    parsePortalCommand:require("../dist/chatroom/portal-command").parsePortalCommand,
    executePortalCommand:require("../dist/chatroom/portal-command").executePortalCommand,
    agentSessionProjectStateData:async()=>({}),postToPanel(){},
    getStorePath:() => f.directory, getChatCid:() => "fixturecid", portalChanged() {},
    portalLog:(level, message) => portalEvents.push(message), hubLog() {}, portalEvents:[],
    log:{ warn() {}, debug() {},error:message=>errors.push(message) },
    vscode:{ workspace:{ isTrusted:true, getConfiguration:() => ({ get:() => 0 }) },
      Uri:{ parse:value => value }, env:{ asExternalUri:async () => ({ scheme:"http", authority:`127.0.0.1:${f.hub.port}` }), clipboard:{ writeText:async value => { clipboard = value; } } },
      window:{ showQuickPick:async choices => choices[0], showInputBox:async options => options.value || clipboard,
        showInformationMessage:async () => undefined, showWarningMessage:async (_message, _options, action) => action, showErrorMessage:message=>errors.push(message), setStatusBarMessage() {} } },
  });
  vm.runInContext(ts.transpileModule(`${manager.getText(ast)}; globalThis.Host = ChatRoomManager;`,
    { compilerOptions:{ target:ts.ScriptTarget.ES2022 } }).outputText, context);
  const host = new context.Host();
  host.portalPrompt = async () => assert.fail("Controller creation automatically resolves its address without a configuration dialog");
  host.portalConfirm = async () => true;
  host.hub = f.hub; host.activeKey = "unchanged-chatroom";
  host.portalPreflight = () => f.directory;
  host.startHub = async () => ({ ok:true });
  host.push=()=>{};
  const owner = { id:randomUUID(), label:"Controller" }, receiver = { id:randomUUID(), label:"Controlled" };
  const hostContext = { globalStorageUri: { fsPath: f.directory } };
  host.chatPortals.set(owner.id, { ...owner, root:f.directory });
  const receiverHost = new context.Host();
  receiverHost.push=()=>{};
  receiverHost.portalPrompt = async (owner, interaction) => interaction.title.startsWith("Run direct command")
    ? { action: "run", fields: {} } : host.portalPrompt(owner, interaction);
  receiverHost.portalConfirm = host.portalConfirm;
  receiverHost.portalPreflight = host.portalPreflight;
  receiverHost.chatPortals.set(receiver.id, { ...receiver, root:f.directory });
  t.after(() => { for (const manager of [host, receiverHost]) for (const transport of manager.portalTransports.values()) transport.client.disconnect(); });
  await host.startPortal(hostContext, owner, "controller");
  assert.equal(new URL(parsePortalLink(clipboard).url).pathname, PORTAL_TRANSPORT_PATH);
  await receiverHost.acceptPortal(hostContext, receiver, clipboard);
  await until(()=>host.chatPortals.get(owner.id).room?.peer?.binding&&receiverHost.chatPortals.get(receiver.id).room?.peer?.binding);
  assert.equal(host.portalTransports.size, 1);
  assert.equal(receiverHost.portalTransports.size, 1);
  assert.equal(receiverHost.rooms.size, 0);
  assert.equal(host.rooms.size, 0, "Portal never calls Chatroom joinRoom");
  assert.equal(host.activeKey, "unchanged-chatroom");
  assert.deepEqual(f.hub.adminRooms(), []);
  assert.deepEqual(await f.hub.listStoredRooms(), []);
  assert.equal(host.state().rooms.length, 0, "Portal does not leak into Chatroom navigation");
  const sender = host.chatPortals.get(owner.id).room.peer;
  const resultId = sender.submitCommand({ program: process.execPath, arguments: ["-e", "console.log('HOST_DIRECT_COMMAND')"], timeoutSeconds: 10 });
  await until(() => ["completed", "failed", "denied"].includes(sender.receipts.get(resultId)?.state));
  assert.equal(sender.receipts.get(resultId).state, "completed", JSON.stringify(sender.receipts.get(resultId)));
  assert.match(sender.receipts.get(resultId).result.stdout, /HOST_DIRECT_COMMAND/);
  assert.equal(sender.receipts.get(resultId).result.modelCalls, 0);
  const policy = receiverHost.portalPermissions.get(receiver.id);
  policy.grant({ mode: "scoped", permissions: ["code-execute"], durationMs: 2000 });
  const expiredId = sender.submitCommand({ program: process.execPath, arguments: ["-e", "setInterval(() => {}, 1000)"], timeoutSeconds: 10 });
  await until(() => sender.receipts.get(expiredId)?.state === "running");
  await until(() => sender.receipts.get(expiredId)?.state === "cancelled");
  const revokedId = sender.submitCommand({ program: process.execPath, arguments: ["-e", "setInterval(() => {}, 1000)"], timeoutSeconds: 10 });
  await until(() => sender.receipts.get(revokedId)?.state === "running");
  receiverHost.invalidatePortal(receiver.id);
  await until(() => sender.receipts.get(revokedId)?.state === "cancelled");
  assert.equal(sender.receipts.get(revokedId).result.state, "cancelled", "revocation cancels the real executing process, not just its UI");
  receiverHost.chatPortals.get(receiver.id).room.peer.revoke();
  await until(()=>!host.portalTransports.has(owner.id)&&!receiverHost.portalTransports.has(receiver.id));
  const issued = parsePortalLink(clipboard);
  assert.ok(portalEvents.some(message => /link issued role=controller/.test(message)), "Portal logs link issuance");
  assert.ok(portalEvents.some(message => /paired with/.test(message)), "Portal logs pairing");
  assert.ok(portalEvents.some(message => /revoked locally/.test(message)) && portalEvents.some(message => /revoked by /.test(message)), "Portal logs both revoke sides");
  assert.ok(portalEvents.some(message => /closed reason=peer-session-unbound \(host: closing relay channel\)/.test(message)), "Portal logs the teardown trigger");
  assert.ok(portalEvents.every(message => !message.includes(issued.secret) && !message.includes(issued.code)), "Portal logs never contain link secrets or pairing codes");
  assert.equal(host.portalConnections.has(owner.id),false,"closing clears the transport credential");
  assert.equal(host.chatPortals.get(owner.id).room,undefined,"closing clears the paired session");
  assert.equal(host.portalTransports.has(owner.id),false);
  await host.startPortal(hostContext, owner, "controller");
  await receiverHost.acceptPortal(hostContext, receiver, clipboard);
  await until(()=>host.chatPortals.get(owner.id).room?.peer?.binding&&receiverHost.chatPortals.get(receiver.id).room?.peer?.binding);
  const hostBinding = host.chatPortals.get(owner.id).room.peer.binding, receiverBinding = receiverHost.chatPortals.get(receiver.id).room.peer.binding;
  receiverHost.portalTransports.get(receiver.id).client.ws.terminate();
  await until(()=>portalEvents.some(message => /interrupted: .*keeping pairing/.test(message)));
  assert.equal(host.portalStatus(owner.id).state === "reconnecting" || receiverHost.portalStatus(receiver.id).state === "reconnecting", true, "status shows the grace period");
  await until(()=>portalEvents.filter(message => /recovered after \d+s/.test(message)).length >= 2);
  assert.equal(host.chatPortals.get(owner.id).room.peer.binding, hostBinding, "a transport blip keeps the controller pairing");
  assert.equal(receiverHost.chatPortals.get(receiver.id).room.peer.binding, receiverBinding, "a transport blip keeps the controlled pairing");
  assert.equal(host.portalStatus(owner.id).state, "connected");
  assert.equal(receiverHost.portalTransports.get(receiver.id).client.participantId, hostBinding.peerId, "the reconnecting endpoint keeps its relay identity");
  host.portalTransports.get(owner.id).client.disconnect();
  await until(()=>!host.portalTransports.has(owner.id)&&!receiverHost.portalTransports.has(receiver.id));
  assert.equal(host.portalConnections.has(owner.id),false,"transport loss also erases credentials and prevents reconnect");
  await host.startPortal({}, owner, "controller");
  await receiverHost.acceptPortal({}, receiver, clipboard);
  await until(()=>host.chatPortals.get(owner.id).room?.peer?.binding&&receiverHost.chatPortals.get(receiver.id).room?.peer?.binding);
  const graceStarted = Date.now();
  receiverHost.portalTransports.get(receiver.id).client.disconnect();
  await new Promise(resolve => setTimeout(resolve, 600));
  assert.ok(host.chatPortals.get(owner.id).room?.peer?.binding, "a peer that left keeps the host pairing during the grace period");
  assert.equal(host.portalStatus(owner.id).state, "reconnecting");
  await until(()=>!host.portalTransports.has(owner.id), 6000);
  assert.ok(Date.now() - graceStarted >= 2400, "the host waits for the whole grace period");
  assert.ok(portalEvents.some(message => /closed reason=grace-expired after 2\.5s: peer .* left presence/.test(message)), "expiry is logged with its cause");
  assert.ok(errors.length === 0);
  const hosted = await f.hub.createRoom("Room with spaces", "fixture-room-secret");
  host.hostedKeys.set(hosted.roomId, hosted.secret);
  const invite = parseChatMagicLink(host.roomInvite(hosted.roomId).magicLink);
  assert.equal(decodeURIComponent(new URL(invite.url).pathname), "/Room with spaces", "UUID copy resolves the actual Room name, not a UUID-shaped path");
  assert.equal(invite.roomId, hosted.roomId);
  assert.equal(invite.secret, hosted.secret);
  assert.equal(typeof host.reattachPortal,"undefined","there is no restart-recovery entry point");
  assert.equal(f.hub.adminRooms().length, 1);
  const failedOwner = { id:randomUUID(), label:"Failed endpoint" };
  host.chatPortals.set(failedOwner.id, { ...failedOwner, root:f.directory });
  context.vscode.env.asExternalUri = async () => { throw new Error("Forwarding fixture failed"); };
  await assert.rejects(host.startPortal({}, failedOwner, "controller"), /Forwarding fixture failed/);
  assert.equal(host.portalTransports.has(failedOwner.id), false, "a failed invitation releases its socket/channel");
  assert.equal(host.chatPortals.get(failedOwner.id).room, undefined);
  assert.deepEqual(errors,[]);
});
