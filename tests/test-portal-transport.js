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

test("actual Host start/accept uses dedicated transport and leaves Chatroom selection and Room maps untouched", async t => {
  const f = await fixture(t), ts = require("typescript");
  const extension = await fs.readFile(path.join(__dirname, "../src/extension.ts"), "utf8");
  const ast = ts.createSourceFile("extension.ts", extension, ts.ScriptTarget.Latest, true);
  const manager = ast.statements.find(node => ts.isClassDeclaration(node) && node.name?.text === "ChatRoomManager");
  let clipboard;
  const errors=[];
  const context = vm.createContext({
    Map, Set, Date, URL, Promise, setTimeout, clearTimeout, setInterval, clearInterval, ChatHub, ChatClient, PORTAL_TRANSPORT_PATH,
    randomUUID, os, assertPeerEndpoint, createPortalLink, parsePortalLink, createChatMagicLink, chatInviteMessage, PeerSession,
    PortalPermissions:require("../dist/chatroom/portal-permissions").PortalPermissions,
    agentSessionProjectStateData:async()=>({}),postToPanel(){},
    getStorePath:() => f.directory, getChatCid:() => "fixturecid", portalChanged() {},
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
  host.chatPortals.set(owner.id, { ...owner, root:f.directory });
  const receiverHost = new context.Host();
  receiverHost.push=()=>{};
  receiverHost.portalPrompt = host.portalPrompt;
  receiverHost.portalConfirm = host.portalConfirm;
  receiverHost.portalPreflight = host.portalPreflight;
  receiverHost.chatPortals.set(receiver.id, { ...receiver, root:f.directory });
  t.after(() => { for (const manager of [host, receiverHost]) for (const transport of manager.portalTransports.values()) transport.client.disconnect(); });
  await host.startPortal({}, owner, "controller");
  assert.equal(new URL(parsePortalLink(clipboard).url).pathname, PORTAL_TRANSPORT_PATH);
  await receiverHost.acceptPortal({}, receiver, clipboard);
  await until(()=>host.chatPortals.get(owner.id).room?.peer?.binding&&receiverHost.chatPortals.get(receiver.id).room?.peer?.binding);
  assert.equal(host.portalTransports.size, 1);
  assert.equal(receiverHost.portalTransports.size, 1);
  assert.equal(receiverHost.rooms.size, 0);
  assert.equal(host.rooms.size, 0, "Portal never calls Chatroom joinRoom");
  assert.equal(host.activeKey, "unchanged-chatroom");
  assert.deepEqual(f.hub.adminRooms(), []);
  assert.deepEqual(await f.hub.listStoredRooms(), []);
  assert.equal(host.state().rooms.length, 0, "Portal does not leak into Chatroom navigation");
  receiverHost.chatPortals.get(receiver.id).room.peer.revoke();
  await until(()=>!host.portalTransports.has(owner.id)&&!receiverHost.portalTransports.has(receiver.id));
  assert.equal(host.portalConnections.has(owner.id),false,"closing clears the transport credential");
  assert.equal(host.chatPortals.get(owner.id).room,undefined,"closing clears the paired session");
  assert.equal(host.portalTransports.has(owner.id),false);
  await host.startPortal({}, owner, "controller");
  await receiverHost.acceptPortal({}, receiver, clipboard);
  await until(()=>host.chatPortals.get(owner.id).room?.peer?.binding&&receiverHost.chatPortals.get(receiver.id).room?.peer?.binding);
  host.portalTransports.get(owner.id).client.disconnect();
  await until(()=>!host.portalTransports.has(owner.id)&&!receiverHost.portalTransports.has(receiver.id));
  assert.equal(host.portalConnections.has(owner.id),false,"transport loss also erases credentials and prevents reconnect");
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
