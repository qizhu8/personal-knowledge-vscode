const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const vm = require("node:vm");
const Module = require("node:module");
const { randomUUID } = require("node:crypto");
const ts = require("typescript");
const { PeerSession } = require("../dist/chatroom/peer-session");
const { assertPeerEndpoint } = require("../dist/chatroom/peer-protocol");
const { PortalPermissions, PORTAL_PERMISSION_DIMENSIONS } = require("../dist/chatroom/portal-permissions");
const { PortalFiles } = require("../dist/chatroom/portal-files");
const { toolPermissionScope } = require("../dist/chat/permissions");
const { PortalConnectionJournal, endpointLabel, endpointScope } = require("../dist/chatroom/portal-connections");
const { createPortalLink, parsePortalLink } = require("../dist/chatroom/portal-link");
const { validateQuestionAnswer } = require("../dist/chat/chat-questions");

function managerFixture() {
  const source = fs.readFileSync(path.join(__dirname, "../src/extension.ts"), "utf8");
  const ast = ts.createSourceFile("extension.ts", source, ts.ScriptTarget.Latest, true);
  const declaration = ast.statements.find(node => ts.isClassDeclaration(node) && node.name?.text === "ChatRoomManager");
  const scope = {
    PeerSession, PortalPermissions, PORTAL_PERMISSION_DIMENSIONS, PortalFiles, toolPermissionScope, PortalConnectionJournal, endpointLabel, endpointScope, portalChanged() {},
    assertPeerEndpoint, parsePortalLink, path, os, process, randomUUID, setTimeout, setInterval, clearInterval, AbortController, root: "/fixture", executions: [], confirmations: [],
    getStorePath: () => scope.root,
    portalInteraction: async (chatId, interaction, current) => {
      scope.confirmations.push({ chatId, title: interaction.title, options: { detail: interaction.detail }, interaction });
      assert(current(), "Chat-local consent must be current before display");
      if (scope.portalAnswer) {
        const answer = await scope.portalAnswer(chatId, interaction, current);
        if (answer?.action === "submit" && interaction.form) validateQuestionAnswer(interaction.form,answer.fields,16000);
        if (answer?.action === "submit" && interaction.verify) await interaction.verify(answer.fields);
        return answer;
      }
      return scope.allow === false ? undefined : { action: interaction.choices[0].value, fields: {} };
    },
    portalReviewReceiver: async (chatId, review) => { scope.reviews.push({ chatId, review }); }, reviews: [],
    remoteChatExecutor: async (prompt, _signal, requestId, chatId, _observer, source) => {
      scope.executions.push({ prompt, requestId, chatId, source });
      return { chatId, content: prompt };
    },
    vscode: { workspace: { isTrusted: true }, window: {
      showWarningMessage: async (title, options, action) => { scope.confirmations.push({ title, options }); return scope.allow === false ? undefined : action; },
      showInformationMessage: async () => {},
      setStatusBarMessage() {},
      showErrorMessage: async message => { scope.errors.push(message); },
    } },
    agentSessionProjectStateData: async () => ({}), postToPanel() {},
    log: { error() {} }, errors: [],
  };
  scope.requestNativePortalInteraction = async (interaction, current) => {
    scope.nativePrompts = (scope.nativePrompts || 0) + 1;
    return scope.portalInteraction("native", interaction, current);
  };
  vm.runInNewContext(ts.transpileModule(`${declaration.getText(ast)}\nglobalThis.Manager = ChatRoomManager;`, {
    compilerOptions: { target: ts.ScriptTarget.ES2022 },
  }).outputText, scope);
  const manager = new scope.Manager();
  manager.cleanupPortalPersistence = async()=>{};
  manager.push = () => {};
  return { scope, manager };
}

async function until(predicate) {
  const deadline = Date.now() + 3000;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error("Timed out waiting for Portal");
    await new Promise(resolve => setTimeout(resolve, 5));
  }
}

test("Chat-scoped routing keeps controller/controlled roles, endpoints, requests and disconnects independent", async t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "pkm-chat-portal-"));
  const { scope, manager } = managerFixture();
  const sessions = [];
  t.after(() => { for (const peer of sessions) peer.dispose(); fs.rmSync(directory, { recursive: true, force: true }); });
  scope.root = directory;
  const ids = [randomUUID(), randomUUID(), randomUUID()];
  const remotes = [], remoteChatIds = ids.map(() => randomUUID());
  for (let i = 0; i < ids.length; i++) {
    const owner = { id: ids[i], label: `Chat ${i}` };
    let remote;
    const room = { roomId: `room-${i}`, url: `wss://machine-${i}.example.test`, client: {
      isConnected: true, sendPeer: (_target, packet) => void remote.receive({ from: `local-${i}`, fromName: owner.label, packet }),
      disconnect() { this.isConnected = false; },
    } };
    const local = manager.ensurePeer(room, directory, owner);
    remote = new PeerSession({ roomId: room.roomId, chatId: remoteChatIds[i], machine: `host-${i}`, journalDirectory: path.join(directory, `remote-${i}`),
      connected: () => true, changed() {}, error: error => scope.errors.push(error.message),
      approvePair: async () => true, approveSwap: async () => true, approveTask: async () => true,
      execute: async prompt => ({ machine: i, content: prompt }),
      send: (_target, packet) => void local.receive({ from: `remote-${i}`, fromName: `Remote ${i}`, packet }),
    });
    sessions.push(local, remote);
    if (i === 2) remote.pair(`local-${i}`, local.invite());
    else local.pair(`remote-${i}`, remote.invite());
    await until(() => local.binding && remote.binding);
    manager.chatPortals.set(owner.id, { ...owner, root: directory, external: false, room });
    remotes.push(remote);
  }
  assert.equal(manager.portalStatus(ids[0]).binding.role, "controller");
  assert.equal(manager.portalStatus(ids[0]).binding.peerChatId, remoteChatIds[0]);
  assert.equal(manager.portalStatus(ids[0]).binding.peerMachine, "host-0");
  assert.equal(manager.portalStatus(ids[2]).binding.role, "controlled");
  const requestId = randomUUID();
  for (let i = 0; i < 2; i++) {
    const result = await manager.portalControl({}, { operation: "send", contextId: ids[i], prompt: `test ${i}`, requestId }, false);
    assert.equal(result.endpoint, `wss://machine-${i}.example.test`);
  }
  await until(() => ids.slice(0, 2).every(id => manager.chatPortals.get(id).room.peer.receipts.get(requestId)?.state === "completed"));
  for (let i = 0; i < 2; i++) {
    const result = await manager.portalControl({}, { operation: "get", contextId: ids[i], requestId }, false);
    assert.equal(result.receipt.result.machine, i);
  }
  assert.equal(scope.reviews.filter(item => item.review.state === "completed").length, 2, "native PKM controllers get automatic review events");
  const beforeExternal = scope.reviews.length;
  manager.chatPortals.get(ids[1]).external = true;
  const externalRequest = manager.chatPortals.get(ids[1]).room.peer.submit("external result is read manually");
  await until(() => manager.chatPortals.get(ids[1]).room.peer.receipts.get(externalRequest)?.state === "completed");
  assert.equal(scope.reviews.length, beforeExternal, "external Copilot contexts must not auto-wake their PKM companion");
  manager.chatPortals.get(ids[1]).external = false;
  await assert.rejects(manager.portalControl({}, { operation: "get", contextId: ids[2], requestId }, false), /Unknown request/);
  const incoming = remotes[2].submit("test bound local Chat");
  await until(() => remotes[2].receipts.get(incoming)?.state === "completed");
  assert.equal(scope.executions.length, 1);
  assert.equal(scope.executions[0].chatId, ids[2]);
  assert.equal(scope.executions[0].source.hostname, "host-2");
  assert.equal(scope.executions[0].source.chatName, "Remote 2");
  assert.equal(scope.executions[0].source.endpoint, "wss://machine-2.example.test");
  manager.chatPortals.get(ids[2]).external=true;
  scope.portalChooseContext=async()=>undefined;
  const cancelled=remotes[2].submit("no existing Chat selected");
  await until(()=>remotes[2].receipts.get(cancelled)?.state==="failed");
  assert.equal(scope.executions.length,1,"cancelling never creates or executes a Chat");
  const existingChat=randomUUID();
  scope.portalChooseContext=async()=>({id:existingChat,label:"Existing Chat"});
  const execute=scope.remoteChatExecutor;
  scope.remoteChatExecutor=async(...args)=>{
    assert(manager.portalStateForChat(existingChat).connected,"execution Chat sees its scoped Portal");
    assert.equal(manager.portalOwnerId(existingChat),ids[2]);
    args[4]({requestId:args[2],chatId:existingChat,sequence:0,at:Date.now(),state:"running",visibility:"task-only"});
    return execute(...args);
  };
  const selected=remotes[2].submit("execute only in selected existing Chat");
  await until(()=>remotes[2].receipts.get(selected)?.state==="completed");
  assert.equal(scope.executions[1].chatId,existingChat);
  assert.equal(remotes[2].observations.get(selected)?.chatId,ids[2],"wire observations retain the paired connection identity");
  assert.equal(manager.portalStateForChat(existingChat),undefined,"execution routing is released after completion");
  scope.portalChooseContext=async()=>{
    manager.invalidatePortal(ids[2]);
    return {id:existingChat,label:"Late existing Chat selection"};
  };
  const stale=remotes[2].submit("selection after revocation must not execute");
  await until(()=>remotes[2].receipts.get(stale)?.state==="failed");
  assert.equal(scope.executions.length,2);
  assert.equal(manager.portalStateForChat(existingChat),undefined);
  manager.chatPortals.get(ids[2]).external=false;
  await manager.portalControl({}, { operation: "disconnect", contextId: ids[0] }, false);
  assert.equal(manager.portalStatus(ids[0]).connected, false);
  assert.equal(manager.portalStateForChat(ids[0]),undefined,"disconnect must not publish an empty Portal as awaiting pairing");
  assert.equal(manager.portalStatus(ids[1]).connected, true);
  assert.equal(manager.portalStatus(ids[2]).connected, true);
  remotes[1].revoke();
  await until(()=>!manager.chatPortals.get(ids[1]).room.peer.binding);
  assert.equal(manager.portalStateForChat(ids[1]),undefined,"remote revocation hides the old endpoint and receipts even while transport remains");
  assert.deepEqual(scope.errors, []);
});

test("MCP cannot use a PKM Chat context, and external handles require fresh consent even for reads", async () => {
  const { scope, manager } = managerFixture();
  const id = randomUUID();
  manager.chatPortals.set(id, { id, label: "Explicit external context", root: scope.root, external: true });
  await assert.rejects(manager.portalControl({}, { operation: "status", contextId: id }, false), /Unknown Portal context/);
  scope.allow = false;
  await assert.rejects(manager.portalControl({}, { operation: "status", contextId: id }, true), /declined/);
  assert.equal(scope.confirmations.length, 1);
  scope.allow = true;
  assert.equal((await manager.portalControl({}, { operation: "status", contextId: id }, true)).connected, false);
  scope.root = "/different-root";
  await assert.rejects(manager.portalControl({}, { operation: "status", contextId: id }, true), /Unknown Portal context/);
});

test("opening without an owning Chat never falls back to any connected global Room", async () => {
  const { manager } = managerFixture();
  manager.rooms.set("unrelated", { client: { isConnected: true }, peer: { binding: { role: "controller" } } });
  await assert.rejects(manager.managePeer({}), /intended Chat/);
});

test("Portal setup asks only for role: Controller copies, Controlled pastes, with no naming or reversed links",async()=>{
  const {scope,manager}=managerFixture();
  const owner={id:randomUUID(),label:"Pairing fixture"};
  scope.vscode.window.showQuickPick=scope.vscode.window.showInputBox=scope.vscode.window.showWarningMessage=async()=>{throw new Error("Portal setup must use Chat cards");};
  const started=[],accepted=[];
  manager.startPortal=async(_context,actual,role)=>started.push({id:actual.id,role});
  manager.acceptPortal=async(_context,actual,link)=>accepted.push({id:actual.id,link});
  scope.portalAnswer=async(_id,interaction)=>{
    assert.equal(interaction.form,undefined);
    assert.deepEqual(Array.from(interaction.choices,choice=>choice.value),["controller","controlled","cancel"]);
    return {action:"controller",fields:{}};
  };
  await manager.managePeer({},owner);
  assert.deepEqual(started,[{id:owner.id,role:"controller"}]);
  assert.equal(scope.confirmations.length,1,"role selection directly creates a Controller invitation");
  const link=createPortalLink({url:"ws://127.0.0.1:7345/pkm/portal",room:"Portal",roomId:randomUUID(),
    secret:"a".repeat(48),code:`pkmpeer:v1:${randomUUID()}:${"b".repeat(48)}`,controller:"fixture-controller",role:"controller"});
  scope.portalAnswer=async(_id,interaction)=>{
    if(!interaction.form)return {action:"controlled",fields:{}};
    assert.deepEqual(Object.keys(interaction.form.properties),["link"]);
    assert.deepEqual(Array.from(interaction.secretFields),["link"]);
    await interaction.verify({link});
    return {action:"submit",fields:{link}};
  };
  await manager.managePeer({},owner);
  assert.deepEqual(accepted,[{id:owner.id,link}]);
  assert.equal(scope.confirmations.length,3);
  const reversed=createPortalLink({url:"ws://127.0.0.1:7345/pkm/portal",room:"Portal",roomId:randomUUID(),
    secret:"a".repeat(48),code:`pkmpeer:v1:${randomUUID()}:${"b".repeat(48)}`,controller:"fixture-controller",role:"controlled"});
  scope.portalAnswer=async(_id,interaction)=>interaction.form?{action:"submit",fields:{link:reversed}}:{action:"controlled",fields:{}};
  await assert.rejects(manager.managePeer({},owner),/created by the Controller/);
  assert.equal(accepted.length,1);
  scope.portalAnswer=async()=>({action:"cancel",fields:{}});
  await manager.managePeer({},owner);
  assert.equal(started.length,1);
  manager.chatPortals.get(owner.id).external=true;
  assert.equal(scope.nativePrompts,undefined);
  scope.portalRenameContext=async()=>assert.fail("External setup must not create or rename a Chat");
  scope.portalAnswer=async()=>({action:"controller",fields:{}});
  await manager.managePeer({},owner);
  assert.equal(manager.chatPortals.get(owner.id).label,"Pairing fixture","no name is requested or changed");
  assert.equal(scope.nativePrompts,1,"external setup routes through native interaction");
});

test("external open allocates only a Portal identity and never creates a PKM Chat",async()=>{
  const {scope,manager}=managerFixture();
  scope.portalChatContext=async()=>assert.fail("External Portal must not allocate a Chat");
  manager.managePeer=async(_context,owner)=>{
    assert(manager.chatPortals.get(owner.id).external);
    assert.equal(owner.label,"External agent");
  };
  const result=await manager.portalControl({}, {operation:"open",wait:false},true);
  assert.match(result.contextId,/^[a-f0-9-]{36}$/);
  assert.equal(manager.chatPortals.size,1);
  assert.equal(scope.executions.length,0);
});

test("external consent never opens a PKM Chat card and Chat-owned consent never opens native UI",async()=>{
  const {scope,manager}=managerFixture();
  const owner={id:randomUUID(),label:"Copilot"};
  manager.chatPortals.set(owner.id,{...owner,root:scope.root,external:true});
  scope.portalInteraction=async()=>assert.fail("External consent must not mount a Chat card");
  scope.requestNativePortalInteraction=async(_interaction,current)=>{
    assert(current());
    return {action:"confirm",fields:{}};
  };
  assert(await manager.portalConfirm(owner,"Connect","External consent","Allow"));
  manager.chatPortals.get(owner.id).external=false;
  scope.requestNativePortalInteraction=async()=>assert.fail("PKM Chat consent must stay in Chat");
  scope.portalInteraction=async(id,_interaction,current)=>{
    assert.equal(id,owner.id);assert(current());return {action:"confirm",fields:{}};
  };
  assert(await manager.portalConfirm(owner,"Connect","Chat consent","Allow"));
});

test("permission dimensions, scopes and fixed duration share one Chat card without native approval dialogs",async()=>{
  const {scope,manager}=managerFixture();
  const owner={id:randomUUID(),label:"Permission fixture"};
  const binding={pairId:randomUUID(),role:"controlled",peerName:"Trusted fixture"};
  const room={peer:{binding},client:{isConnected:true}};
  manager.chatPortals.set(owner.id,{...owner,root:scope.root,room});
  scope.vscode.window.showQuickPick=scope.vscode.window.showWarningMessage=async()=>{throw new Error("Permissions must use Chat cards");};
  scope.portalAnswer=async()=>({action:"submit",fields:{mode:"Selected permissions",permissions:["files-read","progress-read"],scope:"Workspace boundaries",minutes:15}});
  assert.equal(await manager.configurePortalPermissions(owner,room),true);
  assert.equal(scope.confirmations.length,1);
  assert(manager.portalToolAllowed(owner.id,"read_file"));
  assert.equal(manager.portalToolAllowed(owner.id,"run_process"),false);
  assert.equal(manager.portalToolAllowed(owner.id,"file-transfer"),false);
  scope.portalAnswer=async()=>({action:"submit",fields:{mode:"Allow All",scope:"Workspace boundaries",minutes:0,longLived:false}});
  await assert.rejects(manager.configurePortalPermissions(owner,room),/Explicitly acknowledge/);
  assert.equal(manager.portalToolAllowed(owner.id,"run_process"),false);
  scope.portalAnswer=async()=>({action:"revoke",fields:{}});
  assert.equal(await manager.configurePortalPermissions(owner,room),false);
  assert.equal(manager.portalToolAllowed(owner.id,"read_file"),false);
  scope.portalAnswer=async()=>({action:"submit",fields:{mode:"Selected permissions",permissions:["files-read"],scope:"Choose specific folders",minutes:15}});
  scope.vscode.window.showOpenDialog=async()=>{
    manager.invalidatePortal(owner.id);
    return [{scheme:"file",fsPath:path.join(scope.root,"allowed")}];
  };
  await assert.rejects(manager.configurePortalPermissions(owner,room),/changed during authorization/);
  assert.equal(manager.portalPermissions.has(owner.id),false,"a late native folder-picker result must not revive revoked permissions");
});

test("remembered external access removes repeated read prompts only for the live connection and rejects late approval", async () => {
  const { scope, manager } = managerFixture();
  const id = randomUUID();
  const room = { client: { isConnected: true }, peer: { binding: { pairId:randomUUID(), peerId:"controlled", role:"controller" }, receipts:new Map(), observations:new Map() } };
  manager.chatPortals.set(id, { id, label:"Current Copilot", root:scope.root, external:true, room });
  scope.portalAnswer = async () => ({ action:"submit", fields:{minutes:15} });
  await manager.portalControl({}, { operation:"status", contextId:id }, true);
  await manager.portalControl({}, { operation:"status", contextId:id }, true);
  assert.equal(scope.confirmations.length, 1, "reusable local MCP access must not reprompt every poll");
  manager.invalidatePortal(id);
  scope.portalAnswer = async () => { manager.invalidatePortal(id); return { action:"submit", fields:{minutes:15} }; };
  await assert.rejects(manager.portalControl({}, { operation:"status", contextId:id }, true), /changed during external authorization/);
  assert.equal(manager.externalPortalExpiry.has(id), false, "late approval cannot resurrect a revoked connection grant");
});

test("external status requests wait for the existing connection-authorization card instead of duplicating consent",async()=>{
  const {scope,manager}=managerFixture();
  const id=randomUUID(),binding={pairId:randomUUID(),peerName:"Controlled fixture",role:"controller"};
  const room={peer:{binding,receipts:new Map(),observations:new Map()},client:{isConnected:true}};
  manager.chatPortals.set(id,{id,label:"External fixture",root:scope.root,external:true,room});
  let permit;
  scope.portalAnswer=async(_id,interaction)=>{
    assert(!interaction.choices.some(choice=>choice.value==="once"),"an offer without an operation cannot offer Allow once");
    return new Promise(resolve=>{permit=()=>resolve({action:"submit",fields:{minutes:15}});});
  };
  const offer=manager.offerExternalAuthorization(id);
  const repeated=manager.offerExternalAuthorization(id);
  const status=manager.portalControl({}, {operation:"status",contextId:id},true);
  await until(()=>!!permit);
  assert.equal(scope.confirmations.length,1);
  permit();await Promise.all([offer,repeated,status]);
  assert.equal(scope.confirmations.length,1);
  assert(manager.externalAuthorized(id));
});

test("Portal file operation routes a multi-file batch without disconnecting and waits for controlled consent", async t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "pkm-portal-routing-files-"));
  const sender = managerFixture(), receiver = managerFixture();
  sender.scope.root = receiver.scope.root = directory;
  const destination = path.join(directory, "received"); fs.mkdirSync(destination);
  const paths = ["extension.vsix", "checksums.txt"].map((name, index) => {
    const file = path.join(directory, name); fs.writeFileSync(file, index ? "verified fixture" : Buffer.alloc(1024 * 1024, 42)); return file;
  });
  const a = { id: randomUUID(), label: "Build Linux" }, b = { id: randomUUID(), label: "Test Windows" };
  let local, remote;
  const roomA = { roomId: "files", url: "wss://receiver.example.test:443", client: { isConnected: true, sendPeer: (_target, packet) => void remote.receive({ from: "a", fromName: a.label, packet }) } };
  const roomB = { roomId: "files", url: "wss://sender.example.test:443", client: { isConnected: true, sendPeer: (_target, packet) => void local.receive({ from: "b", fromName: b.label, packet }) } };
  sender.manager.chatPortals.set(a.id, { ...a, root: directory, external: false, room: roomA });
  receiver.manager.chatPortals.set(b.id, { ...b, root: directory, external: false, room: roomB });
  local = sender.manager.ensurePeer(roomA, directory, a); remote = receiver.manager.ensurePeer(roomB, directory, b);
  t.after(() => {
    sender.manager.invalidatePortal(a.id); receiver.manager.invalidatePortal(b.id);
    local.dispose(); remote.dispose(); fs.rmSync(directory, { recursive: true, force: true });
  });
  local.pair("b", remote.invite()); await until(() => local.binding && remote.binding);
  receiver.scope.vscode.window.showOpenDialog = async () => [{ fsPath: destination }];
  let permit;
  receiver.scope.portalAnswer = (_chatId, interaction) => {
    return new Promise(resolve => { permit = () => resolve({action:interaction.choices[0].value,fields:{}}); });
  };
  const result = await sender.manager.portalControl({}, { operation: "files", contextId: a.id, paths }, false);
  await until(() => !!permit);
  assert(local.binding && remote.binding, "files is not a disconnect operation");
  assert.deepEqual(fs.readdirSync(destination), [], "no bytes before controlled approval");
  assert.match(receiver.scope.confirmations.at(-1).options.detail, /extension\.vsix.*SHA-256/s);
  permit();
  await until(() => sender.manager.portalStatus(a.id).transfers.some(item => item.transferId === result.transferId && item.state === "completed"));
  for (const source of paths) assert.deepEqual(fs.readFileSync(path.join(destination, path.basename(source))), fs.readFileSync(source));
  assert.deepEqual([...sender.scope.errors, ...receiver.scope.errors], []);
});

test("Portal leases gate real tool scopes, expire at a fixed deadline and never approve file batches", () => {
  const { scope, manager } = managerFixture();
  const id = randomUUID(), pairId = randomUUID();
  const room = { client: { isConnected: true }, peer: { binding: { pairId, role: "controlled" } } };
  manager.chatPortals.set(id, { id, root: scope.root, room });
  let now = 1000;
  const policy = new PortalPermissions({ chatId: id, connectionId: pairId, now: () => now });
  policy.grant({ mode: "scoped", permissions: ["files-read", "pkm-read"], durationMs: 900000 });
  manager.portalPermissions.set(id, policy);
  assert.equal(manager.portalToolAllowed(id, toolPermissionScope("builtin", "read_file")), true);
  assert.equal(manager.portalToolAllowed(id, "pkm_read"), true);
  assert.equal(manager.portalToolAllowed(id, "run_process"), false);
  assert.equal(manager.portalToolAllowed(id, "file-transfer"), false);
  now += 900000;
  assert.equal(manager.portalToolAllowed(id, "read_file"), false);
  policy.grant({ mode: "all", permissions: [...PORTAL_PERMISSION_DIMENSIONS], durationMs: null });
  assert.equal(manager.portalToolAllowed(id, "run_process"), true);
  assert.equal(manager.portalToolAllowed(id, "file-transfer"), false);
  manager.invalidatePortal(id);
  assert.equal(manager.portalToolAllowed(id, "run_process"), false);
  manager.portalPermissions.set(id, policy);
  manager.invalidatePortalsForContextChange("/different-root");
  assert.equal(manager.portalPermissions.has(id), false, "returning to the old Root cannot restore grants");
});

test("remote execution uses the existing bound Chat without changing selection, history or permissions", async () => {
  const originalLoad = Module._load;
  let ApiChatView;
  try {
    Module._load = function(name, ...args) {
      if (name === "vscode") return { workspace: { isTrusted: true }, window: { state: { focused: true } } };
      return originalLoad.call(this, name, ...args);
    };
    ({ ApiChatView } = require("../dist/chat/api-chat-view"));
  } finally { Module._load = originalLoad; }
  const chat = { id: randomUUID(), title: "Existing executor", workspaceNamespace: "0123456789abcdef", permissionMode: "ask",
    permissionGrants: ["original-local-grant"], messages: [{ role: "user", content: "original history" }] };
  const selected = { id: randomUUID() };
  const provider = Object.create(ApiChatView.prototype);
  Object.assign(provider, {
    disposed: false, chat: selected, chats: new Map([[chat.id, chat]]), running: new Map(), queueDrains: new Map(),
    remoteControlledRequests: new Set(), agentControlledRequests: new Set(), remoteSources: new Map(), approvals: new Map(), decisions: new Map(),
    openStore() {}, store: { namespace: chat.workspaceNamespace, resolveChat: id => { assert.equal(id, chat.id); return chat; } },
    assertRunnable() {},
    send: async (_prompt, target) => {
      assert.equal(target, chat);
      assert.equal(provider.remoteControlledRequests.has(chat.id), true);
      target.messages.push({ id: "reply", role: "assistant", status: "complete", content: "Windows tested" });
    },
  });
  const result = await provider.executeRemoteTask("test Windows", new AbortController().signal, randomUUID(), chat.id);
  assert.equal(result.chatId, chat.id);
  assert.equal(result.content, "Windows tested");
  assert.equal(provider.chat, selected);
  assert.equal(chat.messages[0].content, "original history");
  assert.deepEqual(chat.permissionGrants, ["original-local-grant"]);
  assert.equal(provider.remoteControlledRequests.size, 0);
  provider.running.set(chat.id, new AbortController());
  await assert.rejects(provider.executeRemoteTask("do not interrupt", new AbortController().signal, randomUUID(), chat.id), /busy/);
  Object.assign(provider, { notificationKeys: new Set(), view: { visible: true }, viewingChatId: chat.id, chat });
  assert.doesNotThrow(() => provider.notifyChat(chat, "focused-permission", "permission", "Run powershell.exe?"),
    "visible focused target Chat must not try to open an external warning");
  provider.running.clear();
  provider.send = async () => {};
  const observations = [];
  await assert.rejects(provider.executeRemoteTask("do not reuse an old answer", new AbortController().signal, randomUUID(), chat.id,
    value => observations.push(value)), /no reply/);
  assert.equal(observations.at(-1).state, "failed", "missing new assistant output must become an explicit failure snapshot");
  assert.equal(observations.at(-1).answer, undefined, "an old answer is not evidence for the new task");
});

test("controller provenance survives Chat storage and reload", t => {
  const { ApiChatStore } = require("../dist/chat/api-chat-store");
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "pkm-portal-source-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const store = new ApiChatStore(directory, "0123456789abcdef");
  const chat = store.create();
  const source = { hostname:"linux-controller", endpoint:"wss://linux-controller:7345", chatName:"Build and test Windows", chatId:randomUUID(), participantId:"approved-controller" };
  chat.messages.push({ id:randomUUID(), role:"user", status:"complete", content:"Diagnose Sync", portalSource:source });
  store.save(chat);
  assert.deepEqual(store.load(chat.id, false).messages[0].portalSource, source);
});

test("PKM agent tools route with their owning Chat, not a model-supplied context", async () => {
  const originalLoad = Module._load;
  let createBuiltinTools;
  try {
    Module._load = function(name, ...args) { return name === "vscode" ? {} : originalLoad.call(this, name, ...args); };
    ({ createBuiltinTools } = require("../dist/chat/api-chat-tools"));
  } finally { Module._load = originalLoad; }
  const calls = [];
  const host = { workspace: { isTrusted: true, workspaceFolders: [] }, commands: { executeCommand: async (...args) => { calls.push(args); return { connected: true }; } } };
  const tools = createBuiltinTools(["cross_machine_collaboration"], host, undefined, undefined, undefined, undefined, undefined, undefined, "own-chat");
  const portal = tools.find(tool => tool.name === "portal");
  assert(portal);
  await portal.execute({ operation: "status", contextId: "another-chat" }, new AbortController().signal);
  assert.equal(calls[0][1].contextId, "own-chat");
  assert.equal(JSON.parse(await portal.execute({ operation: "status" }, new AbortController().signal)).connected, true);
});

test("a failing Portal state listener cannot stop other views or the caller from refreshing", () => {
  const { portalChanged, onPortalChanged } = require("../dist/chatroom/portal-runtime");
  const seen = [];
  const original = console.error; console.error = message => seen.push(String(message));
  const broken = onPortalChanged(() => { throw new Error("hidden view publish failed"); });
  const healthy = onPortalChanged(() => seen.push("healthy"));
  try {
    assert.doesNotThrow(() => portalChanged());
    assert(seen.includes("healthy"), "later listeners still publish the open Portal");
    assert(seen.some(item => /hidden view publish failed/.test(item)));
  } finally { broken.dispose(); healthy.dispose(); console.error = original; }
});
