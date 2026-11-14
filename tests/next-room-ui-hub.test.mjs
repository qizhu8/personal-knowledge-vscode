import assert from "node:assert/strict";
import { test } from "node:test";
import { createRequire } from "node:module";
import { execFileSync } from "node:child_process";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import vm from "node:vm";
import { pathToFileURL } from "node:url";

const require = createRequire(import.meta.url);
const project = path.resolve(new URL("../legacy", import.meta.url).pathname);
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(check, label) {
  const end = Date.now() + 12000;
  while (Date.now() < end) { const result = await check(); if (result) return result; await wait(20); }
  throw new Error(`Timed out: ${label}`);
}

for (const [policy, portalEnabled] of [["legacy-client-id", false], ["host-approval", false],
  ["legacy-client-id", true], ["host-approval", true]]) {
  test(`real legacy Host UI methods use one Next owner (${policy}${portalEnabled ? ", Portal" : ""}) without a legacy writer`, async t => {
    const directory = path.join(project, ".migration-test-work", `room-ui-focused-${randomUUID()}`);
    fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
    const bundle = path.join(directory, "retained.cjs");
    const nativeBundle = path.join(directory, "native.mjs");
    const esbuild = require("esbuild");
    fs.writeFileSync(path.join(directory, "package.json"), '{"type":"module"}');
    const oldDirectory = path.join(directory, "legacy");
    fs.mkdirSync(oldDirectory);
    fs.writeFileSync(path.join(oldDirectory, "package.json"), '{"type":"commonjs"}');
    fs.symlinkSync(path.join(project, "../node_modules"), path.join(directory, "node_modules"), "dir");
    esbuild.buildSync({ entryPoints: [path.join(project, "../src/storage-worker.ts")],
      bundle: true, platform: "node", format: "esm", packages: "external",
      outfile: path.join(directory, "storage-worker.js"), logLevel: "silent" });
    esbuild.buildSync({ stdin: { contents: `
      export {ChatHub} from "./src/chatroom/chatroom-hub";
      export {ChatClient} from "./src/chatroom/chatroom-client";
      export {ChatJoinApprovalManager} from "./src/chatroom/chat-join-approval";
      export {ChatRoomCredentialStore} from "./src/chatroom/chat-room-credentials";
      export {chatRoomIdentity} from "./src/chatroom/chat-room-identity";
      export {messageAddressesManagedAgent} from "./src/chatroom/chat-managed-agent-routing";
      export {MeetingStateStore} from "./src/chatroom/meeting-state";
      export {ChatMeetingLifecycle,isFinalLeadSummary} from "./src/chatroom/chat-meeting-lifecycle";
      export {PeerSession} from "./src/chatroom/peer-session";
      export {PortalEndpointStore} from "./src/chatroom/portal-endpoint-store";
      export {PortalPermissions,PORTAL_PERMISSION_DIMENSIONS} from "./src/chatroom/portal-permissions";
      export {createPortalLink,parsePortalLink,preflightPortalEndpoint} from "./src/chatroom/portal-link";
      export {assertPeerEndpoint,PORTAL_TRANSPORT_PATH} from "./src/chatroom/peer-protocol";
      export {withCrossProcessLock} from "./src/runtime/cross-process-lock";
      export * from "./src/chatroom/chatroom-images";
      export * from "./src/chatroom/room-host-owner";
      export {WebSocketServer} from "ws";`, resolveDir: project },
      bundle: true, platform: "node", format: "cjs", packages: "external", outfile: bundle, logLevel: "silent" });
    esbuild.buildSync({ stdin: { contents: `
      export {initialize,Storage} from "./next-server/src/storage";
      export {createNextRoomUiHub} from "./next-server/src/next-room-ui-hub";
      export {createNextRoomPortalAuthority} from "./next-server/src/next-room-portals";
      export {copyPrivateRoomArchive} from "./next-server/src/legacy-chatroom-private-copy";
      export {rotateRoomJoinSecret,resolveRoomJoinSecretHash} from "./next-server/src/next-room-secret-state";`, resolveDir: project },
      bundle: true, platform: "node", format: "esm", packages: "external", outfile: nativeBundle, logLevel: "silent" });
    const retained = require(bundle), native = await import(pathToFileURL(nativeBundle));
    const baseline = path.join(project, "personal-knowledge-4.0.22.vsix");
    assert.equal(createHash("sha256").update(fs.readFileSync(baseline)).digest("hex"),
      "1804071cb3b9fc86edc5933d5001db6ea1a8d7a9adf30d6d2b3166fcd6048f27");
    let originalPortal, originalPeer, originalStore;
    if (portalEnabled) {
      const unpack = path.join(oldDirectory, "full-original");
      execFileSync("unzip", ["-q", baseline, "extension/dist/*", "-d", unpack]);
      const dist = path.join(unpack, "extension/dist");
      originalPortal = require(path.join(dist, "chatroom/portal-command.js"));
      originalPeer = require(path.join(dist, "chatroom/peer-session.js")).PeerSession;
      originalStore = require(path.join(dist, "chatroom/portal-endpoint-store.js")).PortalEndpointStore;
    }
    for (const name of ["chatroom-client", "chatroom-protocol", "peer-protocol"])
      fs.writeFileSync(path.join(oldDirectory, `${name}.js`),
        execFileSync("unzip", ["-p", baseline, `extension/dist/chatroom/${name}.js`]));
    const OldClient = require(path.join(oldDirectory, "chatroom-client.js")).ChatClient;
    const root = path.join(directory, "knowledge");
    await native.initialize(root);
    let storage = await native.Storage.open(root, { deferRecovery: true });
    const workspaceId = await storage.workspaceId(), values = new Map(), uiErrors = [], approvals = [], policyDialogs = [];
    const credentials = new retained.ChatRoomCredentialStore({
      async get(key) { return values.get(key); },
      async store(key, value) { values.set(key, value); },
      async delete(key) { values.delete(key); },
    });
    let allowed = true, legacyConstructions = 0, manager, registration;
    const guests = new Set(), received = [], files = new Map(), saves = [], noteViews = [];
    const providers = new Map();
    const portalState = new Map(), portalApprovals = [], ownerRequests = [];
    let copiedLink, portalRuns = 0, permitPortalCommand = true, ownerAllowed = true;
    const profile = path.join(directory, "private-profile");
    fs.mkdirSync(profile, { recursive: true, mode: 0o700 });
    const secretStorage = { async get(key) { return values.get(key); }, async store(key, value) { values.set(key, value); }, async delete(key) { values.delete(key); } };
    const portalContext = { workspaceState: { get(key, fallback) { return portalState.has(key) ? JSON.parse(JSON.stringify(portalState.get(key))) : fallback; },
      async update(key, value) { portalState.set(key, JSON.parse(JSON.stringify(value))); } }, secrets: secretStorage,
      globalStorageUri: { fsPath: profile }, fixtureCid: "original-profile-cid" };
    const share = path.join(directory, "shared.txt");
    fs.writeFileSync(share, "shared through the original UI");
    const noLegacy = () => { throw new Error("An adopted workspace must not initialize a legacy meeting/privacy writer."); };
    const warnings = [];
    const log = new Proxy({}, { get: (_target, key) => (...args) => { if (key === "warn") warnings.push(args.join(" ")); } });
    const globals = {
      process, Buffer, setTimeout, clearTimeout, setInterval, clearInterval,
      path, os, fs, createHash, randomBytes, randomUUID, log,
      getStorePath: () => root, adoptedRoomHostOwner: retained.adoptedRoomHostOwner,
      selectRoomHostHub: retained.selectRoomHostHub, ChatClient: retained.ChatClient,
      chatRoomIdentity: retained.chatRoomIdentity, chatCtx: undefined, _treeProvider: undefined,
      messageAddressesManagedAgent: retained.messageAddressesManagedAgent,
      isFinalLeadSummary: retained.isFinalLeadSummary,
      ChatHub: class extends retained.ChatHub { constructor() { super(); legacyConstructions++; throw new Error("Legacy Hub constructed."); } },
      MeetingStateStore: class { constructor() { noLegacy(); } }, ChatMeetingLifecycle: retained.ChatMeetingLifecycle,
      isTopLevelPrivate: noLegacy, setTopLevelPrivacy: noLegacy, MAX_FILE_BYTES: 25 * 1024 * 1024,
      decodeChatroomImages: retained.decodeChatroomImages, MAX_CHATROOM_IMAGE_BYTES: retained.MAX_CHATROOM_IMAGE_BYTES,
      chatroomImageMime: retained.chatroomImageMime,
      portalChanged() {}, postToPanel() {}, saveRekeyedSecret() {},
      agentSessionProjectStateData: noLegacy,
      PeerSession: retained.PeerSession, PortalEndpointStore: retained.PortalEndpointStore, PortalPermissions: retained.PortalPermissions,
      PORTAL_PERMISSION_DIMENSIONS: retained.PORTAL_PERMISSION_DIMENSIONS,
      withCrossProcessLock: retained.withCrossProcessLock,
      createPortalLink: retained.createPortalLink, parsePortalLink: retained.parsePortalLink,
      preflightPortalEndpoint: retained.preflightPortalEndpoint, assertPeerEndpoint: retained.assertPeerEndpoint,
      PORTAL_TRANSPORT_PATH: retained.PORTAL_TRANSPORT_PATH, portalLog(level, message) { warnings.push(`${level}: ${message}`); }, getChatCid: context => context.fixtureCid,
      portalChatBindingsReader: undefined, portalCommandRecorder: undefined, portalChooseContext: undefined,
      remoteChatExecutor: () => assert.fail("Next Portal must not use the legacy model executor"),
      listAiBackends: async () => [{ id: "focused-no-model", label: "No model execution" }],
      vscode: {
        window: {
          async showWarningMessage(message, options) {
            if (message === "Host this Room with the Next workspace owner?") {
              policyDialogs.push(options.detail);
              assert.match(options.detail, /not encrypted/);
              assert.match(options.detail, /impersonation risk/);
              assert.match(options.detail, /read-only Meeting view/);
              return policy === "legacy-client-id" ? "Keep Legacy Reconnect" : "Use Participant Credentials";
            }
            if (message === "Restore this historical participant identity?") {
              approvals.push(options.detail);
              assert.match(options.detail, /out of band/);
              return "Approve Identity Recovery";
            }
            if (message.startsWith("Save long-term permissions for ")) {
              assert.match(options.detail, /No reusable permissions/);
              assert.match(options.detail, /direct commands only/);
              return "Save permissions";
            }
            throw new Error(message);
          },
          async showOpenDialog() { return [{ fsPath: share }]; },
          async showSaveDialog() { return { fsPath: saves.shift() }; },
          async showInformationMessage() {},
          async showErrorMessage(message) { uiErrors.push(message); },
          async showQuickPick(items, options) {
            if (options?.title === "Local permissions accepted from this remote endpoint") return [];
            if (options?.title === "Allow remote control of THIS machine?") return "Enable receiving control";
            return items[0];
          },
          async showInputBox() { return "Managed Guest"; },
          async showTextDocument(document) { noteViews.push(document); },
          setStatusBarMessage() {},
        },
        Uri: { file(fsPath) { return { fsPath }; }, from(value) {
          return { ...value, toString() { return `${this.scheme}://${this.authority}${this.path}`; } };
        },
          parse(value) { const url = new URL(value); return { scheme: url.protocol.slice(0, -1), authority: url.host, path: url.pathname, fsPath: url.pathname }; } },
        env: { async asExternalUri(value) { return value; }, clipboard: { async writeText(value) { copiedLink = value; } } },
        EventEmitter: class { event = () => ({ dispose() {} }); fire() {} dispose() {} },
        FileType: { File: 1 }, FileChangeType: { Changed: 1 },
        FileSystemError: { NoPermissions(message) { return new Error(message); } },
        Disposable: class { constructor(dispose) { this.dispose = dispose; } },
        workspace: {
          isTrusted: true,
          getConfiguration: () => ({ get: () => 0 }),
          workspaceFolders: [{ uri: { scheme: "file", fsPath: directory } }],
          registerFileSystemProvider(scheme, provider) {
            providers.set(scheme, provider); return { dispose() { providers.delete(scheme); } };
          },
          async openTextDocument(uri) { return { uri, content: Buffer.from(await providers.get(uri.scheme).readFile(uri)).toString("utf8") }; },
        },
      },
    };
    const source = fs.readFileSync(path.join(project, "src/extension.ts"), "utf8");
    const classSource = source.slice(source.indexOf("class ChatRoomManager {"), source.indexOf("\nlet chatMgr:"));
    const compiled = require("typescript").transpileModule(classSource, {
      compilerOptions: { module: 1, target: 9 },
    }).outputText;
    const Manager = vm.compileFunction(`${compiled}\nreturn ChatRoomManager;`, Object.keys(globals))(...Object.values(globals));
    t.after(async () => {
      for (const guest of guests) guest.disconnect();
      await manager?.dispose();
      await registration?.dispose();
      await storage.close();
      fs.rmSync(directory, { recursive: true, force: true });
    });
    async function attachManager() {
      registration = retained.registerAdoptedRoomHostOwner({
      root, workspaceId, qualification: "new-next-workspace",
      assertAuthority() { if (!allowed) throw new Error("Owner revoked."); storage.assertWorkspaceLease(); },
      createHub(ui, assertSelectedOwner) { return native.createNextRoomUiHub({
        ...ui, storage, workspaceId, credentials, retained, qualification: "new-next-workspace",
        assertAuthority() { assertSelectedOwner(); if (!allowed) throw new Error("Owner revoked."); },
        ...(portalEnabled ? { portal: {
          async authorize(request) { ownerRequests.push(JSON.parse(JSON.stringify(request))); return request.operation !== "command" || ownerAllowed; },
          async executeCommand(input) {
            portalRuns++;
            return originalPortal.executePortalCommand(path.join(profile, "portal-processes", input.contextId),
              `${input.pairId}:${input.requestId}`, input.command, input.defaultCwd, input.signal);
          },
        } } : {}),
      }); },
      });
      manager = new Manager();
      manager.push = () => {};
      manager.portalConfirm = async () => true;
      manager.portalPrompt = async (_owner, request) => { portalApprovals.push(request); return { action: permitPortalCommand ? "run" : "cancel" }; };
      manager.setAdvertisedHost("127.0.0.1");
      manager.configurePersistence(path.join(root, "chatrooms"), "focused-profile", {});
      await manager.refreshStoredRooms();
    }
    await attachManager();
    if (!portalEnabled) {
      assert.throws(() => manager.portalPreflight(), /Next-owned Portal.*not admitted/);
      manager.configurePersistentPortals({ get workspaceState() { assert.fail("Unsupported Portal must not read saved state."); } });
      await assert.rejects(manager.connectPersistentEndpoint("saved-endpoint"), /Next-owned Portal.*not admitted/);
    }
    assert.equal(fs.existsSync(path.join(root, "chatrooms")), false, "No legacy archive directory is initialized.");
    const started = await manager.startHub(0);
    assert.equal(started.ok, true, started.error);
    assert.equal(policyDialogs.length, 1);
    if (portalEnabled) {
      assert.match(policyDialogs[0], /NOT upgraded by this Room policy/);
      const stored = new originalStore(portalContext.workspaceState, secretStorage);
      const endpoint = await stored.create({ name: "Original General endpoint", root, localMachine: os.hostname() });
      await stored.update(endpoint.id, { acceptsIncoming: true });
      manager.configurePersistentPortals(portalContext);
      manager.chatPortals.set(endpoint.id, { id: endpoint.id, label: endpoint.name, root, external: false });
      await manager.startPortal(portalContext, { id: endpoint.id, label: endpoint.name }, "controller");
      const link = retained.parsePortalLink(copiedLink);
      let peer, client, oldBinding;
      const createOldPeer = () => {
        peer = new originalPeer({ roomId: link.roomId, machine: os.hostname(), endpoint: link.url,
          chatName: "Original endpoint", connected: () => client?.isConnected === true, changed() {},
          persistent: { acceptsIncoming: () => true, localBinding: () => ({ endpointId: "original-remote", name: "Original endpoint", deleted: false, revision: 1 }) },
          approvePair: async () => true, approveSwap: async () => false, approveTask: async () => false,
          execute: async () => assert.fail("No model"), approveCommand: async () => false, executeCommand: async () => assert.fail("No reverse launch"),
          send(target, packet) { client.sendPeer(target, packet); }, error(error) { warnings.push(error.message); },
        });
        client = new OldClient({ onStatus(status, detail) { if (detail) warnings.push(`original transport ${status}: ${detail}`); }, onMessage() {}, onPresence() {
          if (peer.binding && client.isConnected) peer.publishEndpointState();
        }, onPeer(delivery) { void peer.receive(delivery); } });
        guests.add(client);
        client.connect({ url: link.url, room: "Portal", roomId: link.roomId, user: "Original endpoint", token: link.secret, cid: "original-portal-cid" });
      };
      createOldPeer();
      await until(() => client.isConnected && client.participantId, "original Portal transport");
      const oldIdentity = client.participantId;
      peer.accept(link.controller, link.code);
      try {
        await until(() => peer.binding && manager.chatPortals.get(endpoint.id).room.peer?.binding, "original private-code pairing");
      } catch (error) { throw new Error(`${error.message}; UI errors=${JSON.stringify(uiErrors)}; diagnostics=${JSON.stringify(warnings.slice(-15))}`); }
      peer.publishEndpointState();
      await until(() => manager.endpointReady(endpoint.id) && peer.endpointConfirmed, "persistent endpoint nonce/binding confirmation");
      assert.equal(manager.endpointStore.get(endpoint.id).acceptsIncoming, false, "Original pairing revokes prior incoming access.");
      await manager.managePersistentEndpoint(portalContext, "permissions", endpoint.id);
      await until(() => manager.endpointReady(endpoint.id) && peer.endpointConfirmed, "explicit incoming-control consent");
      manager.portalFiles.set(endpoint.id, { offer() { assert.fail("Cached legacy file adapter must not bypass the owner."); } });
      assert.throws(() => manager.filesForPortal({ id: endpoint.id, label: endpoint.name }, manager.chatPortals.get(endpoint.id).room),
        /Next Portal file transfers are not admitted/);
      manager.portalFiles.delete(endpoint.id);
      oldBinding = JSON.parse(JSON.stringify(peer.binding));
      assert.equal((await manager.hub.listStoredRooms()).length, 0, "Peer-only Portal must not manufacture a Room or Meeting.");
      assert.equal(approvals.length, 0, "Room strict approval must not silently change Portal identity recovery.");
      const effect = path.join(profile, "one-effect.txt");
      const command = { program: process.execPath, arguments: ["-e", `require('fs').appendFileSync(${JSON.stringify(effect)},'one\\n');console.log('PORTAL_REAL_STDOUT');console.error('PORTAL_REAL_STDERR')`], timeoutSeconds: 10 };
      const id = peer.submitCommand(command);
      await until(() => peer.receipts.get(id)?.state === "completed", "owner-admitted real process");
      assert.match(peer.receipts.get(id).result.stdout, /PORTAL_REAL_STDOUT/);
      assert.match(peer.receipts.get(id).result.stderr, /PORTAL_REAL_STDERR/);
      assert.equal(peer.receipts.get(id).result.modelCalls, 0);
      peer.submitCommand(command, id);
      await wait(100);
      assert.equal(portalRuns, 1);
      assert.equal(fs.readFileSync(effect, "utf8"), "one\n");
      const admission = ownerRequests.find(request => request.operation === "command");
      await assert.rejects(manager.hub.portalAuthority.executeCommand({ ...admission, requestId: id, command,
        defaultCwd: directory, signal: new AbortController().signal }), /one-use/);
      let captured;
      const immutable = native.createNextRoomPortalAuthority({ storage, workspaceId,
        assertAuthority() { if (!allowed) throw new Error("Owner revoked."); },
        executors: { async authorize() { return true; }, async executeCommand(input) { captured = input; } } });
      const harmless = { program: process.execPath, arguments: ["original-authorized-command"] };
      const exact = { ...admission, detail: { requestId: randomUUID(), command: harmless, defaultCwd: directory } };
      await immutable.authorize(exact);
      const pending = immutable.executeCommand({ ...exact, ...exact.detail, signal: new AbortController().signal });
      harmless.arguments[0] = "changed-after-execution-call";
      await pending;
      assert.equal(captured.command.arguments[0], "original-authorized-command");
      assert(Object.isFrozen(captured.command.arguments));
      const cancelled = { ...exact, detail: { ...exact.detail, requestId: randomUUID() } };
      await immutable.authorize(cancelled);
      const aborted = new AbortController(); aborted.abort();
      await assert.rejects(immutable.executeCommand({ ...cancelled, ...cancelled.detail, signal: aborted.signal }), /cancelled/);
      await assert.rejects(immutable.executeCommand({ ...cancelled, ...cancelled.detail, signal: new AbortController().signal }), /one-use/);
      assert.equal(await immutable.authorize({ ...exact, operation: "files" }), false);
      assert.equal(await immutable.authorize({ ...exact, operation: "task" }), false);
      permitPortalCommand = false;
      const denied = peer.submitCommand({ ...command, arguments: ["-e", "throw Error('must not run')"] });
      await until(() => peer.receipts.get(denied)?.state === "denied", "original local command decline");
      permitPortalCommand = true; ownerAllowed = false;
      const ownerDenied = peer.submitCommand({ ...command, arguments: ["-e", "throw Error('owner must deny')"] });
      await until(() => peer.receipts.get(ownerDenied)?.state === "failed", "independent owner denial");
      assert.equal(portalRuns, 1); ownerAllowed = true;
      const saved = manager.endpointStore.get(endpoint.id);
      assert.equal(saved.name, endpoint.name);
      assert.equal(saved.paired.transport.roomId, link.roomId);
      client.disconnect(); peer.dispose();
      await manager.dispose(); manager = undefined;
      await registration.dispose(); registration = undefined;
      await storage.close();
      storage = await native.Storage.open(root, { deferRecovery: true });
      await attachManager();
      manager.configurePersistentPortals(portalContext);
      await until(() => manager.chatPortals.get(endpoint.id)?.room?.client.isConnected, "owner-admitted saved listener restart");
      createOldPeer();
      await until(() => client.isConnected, "old profile reconnect");
      peer.restore(oldBinding); peer.publishEndpointState();
      await until(() => manager.endpointReady(endpoint.id) && peer.endpointConfirmed, "restarted pair confirmation");
      assert.equal(client.participantId, oldIdentity);
      assert.equal(manager.chatPortals.get(endpoint.id).room.peer.binding.pairId, saved.paired.binding.pairId);
      peer.submitCommand(command, id);
      await until(() => peer.receipts.get(id)?.state === "completed", "durable command result after endpoint/Storage restart");
      assert.equal(fs.readFileSync(effect, "utf8"), "one\n", "Restart replay must not repeat the external effect.");
      assert.equal((await manager.hub.listStoredRooms()).length, 0);
      assert(ownerRequests.some(request => request.operation === "restore"));
      await manager.managePersistentEndpoint(portalContext, "disconnect", endpoint.id);
      assert.deepEqual(JSON.parse(JSON.stringify(manager.endpointStore.get(endpoint.id))), JSON.parse(JSON.stringify(saved)));
      client.disconnect(); peer.dispose();
    }
    const created = await manager.createHostedRoom("Default Host Room", "focused-secret");
    manager.joinRoom({ ...created, url: started.wsUrl, user: "Host", token: created.secret, cid: "host" });
    await until(() => manager.activeRoom?.selfHost, "real Host UI connected as Host");
    function oldGuest(url = started.wsUrl) {
      const peer = new OldClient({ onStatus() {}, onMessage(message) { received.push(message); },
        onHistory(messages) { received.push(...messages); }, onPresence() {}, onRejected(code, message) { uiErrors.push(`${code}: ${message}`); },
        onFileComplete(meta, _from, bytes) { files.set(meta.fileId, Buffer.from(bytes)); } });
      guests.add(peer);
      peer.connect({ url, room: created.room, roomId: created.roomId,
        user: "Old Guest", token: created.secret, cid: "original-client-id", kind: "human" });
      return peer;
    }
    let guest = oldGuest();
    await until(() => guest.isConnected && guest.participantId, "original 4.0.22 Guest joined");
    const identity = guest.participantId;
    guest.disconnect();
    await until(() => manager.activeRoom.members.some(member => member.participantId === identity && member.present === false), "old Guest left");
    guest = oldGuest();
    await until(() => guest.isConnected && guest.participantId === identity, "historical identity manual rejoin");
    assert.equal(approvals.length, policy === "legacy-client-id" ? 0 : 1);
    guest.ws.terminate();
    await until(() => !guest.isConnected, "old client saw transport interruption");
    await until(() => guest.isConnected && guest.participantId === identity, "old client automatic retry");
    assert.equal(approvals.length, policy === "legacy-client-id" ? 0 : 2);
    manager.send("Meeting workflow problem", true, "required", "discuss", ["all"]);
    await until(() => manager.meetingStore.snapshot(created.roomId).current, "Discuss starts the canonical Meeting");
    const meetingId = manager.meetingStore.snapshot(created.roomId).current.id;
    guest.sendMeetingSnapshot({ current: { id: "forged-by-Guest" }, history: [], trash: [] });
    assert.equal(guest.sendText("Old Guest's recorded opinion", true, "required", undefined, ["Host"]), true);
    await until(async () => (await manager.meetingStore.readNote(created.roomId, meetingId)).content.includes("recorded opinion"),
      "old client discussion reaches the canonical Note").catch(error => {
        throw new Error(`${error.message}\nMeeting warnings: ${warnings.join("\n")}`);
      });
    assert.equal(manager.meetingStore.snapshot(created.roomId).current.id, meetingId, "A Guest cannot replace the Host's Meeting.");
    const beforeDeny = manager.meetingStore.snapshot(created.roomId), secrets = new Map(values);
    await credentials.delete(created.roomId);
    await assert.rejects(manager.adjournActiveMeeting(meetingId, "denied-adjourn", beforeDeny.current.revision),
      /Original Host credentials/);
    assert.deepEqual(manager.meetingStore.snapshot(created.roomId), beforeDeny);
    values.clear(); for (const [key, value] of secrets) values.set(key, value);
    await assert.rejects(manager.adjournActiveMeeting(meetingId, "stale-adjourn", beforeDeny.current.revision + 1), /revision conflict/);
    await manager.adjournActiveMeeting(meetingId, "accepted-adjourn", beforeDeny.current.revision);
    const adjourned = manager.meetingStore.snapshot(created.roomId);
    const noteBeforeRestart = await manager.meetingStore.readNote(created.roomId, meetingId);
    const failureDb = storage.connectNative();
    failureDb.exec(`CREATE TRIGGER reject_meeting_note BEFORE UPDATE ON next_room_meeting_notes
      BEGIN SELECT RAISE(ABORT,'Injected Note failure'); END;`);
    try {
      await assert.rejects(manager.mutateMeetingTrash("trash", meetingId, "failed-trash", adjourned.history[0].revision),
        /Injected Note failure/);
      assert.deepEqual(manager.meetingStore.snapshot(created.roomId), adjourned, "Note failure must roll back canonical state too.");
      assert.deepEqual(await manager.meetingStore.readNote(created.roomId, meetingId), noteBeforeRestart);
    } finally { failureDb.exec("DROP TRIGGER reject_meeting_note"); failureDb.close(); }
    manager.send("Adjourn this second Meeting when the Host stops", true, "required", "discuss", ["all"]);
    await until(() => manager.meetingStore.snapshot(created.roomId).current, "second Meeting is active before owner shutdown");
    const closingMeetingId = manager.meetingStore.snapshot(created.roomId).current.id;
    guest.disconnect();
    await manager.dispose();
    const afterStop = manager.meetingStore.snapshot(created.roomId);
    assert.equal(afterStop.current, null);
    assert(afterStop.history.some(meeting => meeting.id === closingMeetingId), "Host shutdown must adjourn the active Meeting.");
    await registration.dispose(); registration = undefined;
    await storage.close();
    storage = await native.Storage.open(root, { deferRecovery: true });
    await attachManager();
    const restarted = await manager.startHub(0);
    assert.equal(restarted.ok, true, restarted.error);
    const recovered = await manager.rehostRoom(created.roomId);
    manager.joinRoom({ ...recovered, url: restarted.wsUrl, user: "Host", token: recovered.secret, cid: "host" });
    await until(() => manager.activeRoom?.selfHost, "Host reopens Room after a real Storage restart");
    assert.deepEqual(manager.meetingStore.snapshot(created.roomId), afterStop);
    assert.deepEqual(await manager.meetingStore.readNote(created.roomId, meetingId), noteBeforeRestart);
    assert.equal(await manager.openActiveMeetingNote(meetingId), true);
    assert.equal(noteViews.at(-1).content, noteBeforeRestart.content);
    const provider = providers.get("pkm-room-meeting"), noteUri = noteViews.at(-1).uri;
    const manuallySaved = noteBeforeRestart.content + "\nExplicit owned editor save.\n";
    await provider.writeFile(noteUri, Buffer.from(manuallySaved));
    assert.equal((await manager.meetingStore.readNote(created.roomId, meetingId)).content, manuallySaved);
    const reviewed = await manager.meetingStore.readNote(created.roomId, meetingId);
    const otherSaved = manuallySaved + "\nAnother reviewed editor save.\n";
    await manager.meetingStore.writeNote(created.roomId, meetingId, otherSaved, reviewed.sha256);
    await provider.stat(noteUri);
    await assert.rejects(provider.writeFile(noteUri, Buffer.from("stale dirty editor")), /changed since/);
    assert.equal((await manager.meetingStore.readNote(created.roomId, meetingId)).content, otherSaved);
    await assert.rejects(provider.writeFile({ ...noteUri, authority: "another-profile" }, Buffer.from("foreign")), /Invalid owned/);
    await provider.readFile(noteUri);
    allowed = false;
    try { await assert.rejects(provider.writeFile(noteUri, Buffer.from("revoked dirty editor")), /revoked/); }
    finally { allowed = true; }
    assert.equal((await manager.meetingStore.readNote(created.roomId, meetingId)).content, otherSaved);
    guest = oldGuest(restarted.wsUrl);
    await until(() => guest.isConnected && guest.participantId === identity, "original client rejoined the restarted owner");
    await manager.mutateMeetingTrash("trash", meetingId, "meeting-trash", adjourned.history[0].revision);
    await assert.rejects(manager.meetingStore.readNote(created.roomId, meetingId), /Trash/);
    await assert.rejects(provider.readFile(noteUri), /Trash/);
    await manager.mutateMeetingTrash("restore", meetingId, "meeting-restore",
      manager.meetingStore.snapshot(created.roomId).trash[0].revision);
    assert.equal(Buffer.from(await provider.readFile(noteUri)).toString("utf8"), otherSaved);
    await manager.mutateMeetingTrash("trash", meetingId, "meeting-trash-final",
      manager.meetingStore.snapshot(created.roomId).history.find(meeting => meeting.id === meetingId).revision);
    await manager.mutateMeetingTrash("delete", meetingId, "meeting-delete",
      manager.meetingStore.snapshot(created.roomId).trash[0].revision);
    assert.equal(manager.meetingStore.snapshot(created.roomId).trash.length, 0);
    assert.deepEqual(fs.readdirSync(path.join(root, "notes")), [], "Native Meeting Notes never start a legacy Notes writer.");
    manager.send("@all structured Host message", true, "required", "chat", ["all"]);
    await until(() => received.some(message => message.text.includes("structured Host message")), "old Guest received original composer message");
    await manager.sendFileToActive();
    await until(() => [...files.values()].some(bytes => bytes.toString() === fs.readFileSync(share, "utf8")), "original share-file action");
    const png = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 1]);
    await manager.sendImages(manager.activeRoom.key, [{ mime: "image/png", dataBase64: png.toString("base64") }], ["Image caption"]);
    await until(() => [...files.values()].some(bytes => bytes.equals(png)), "original image composer");
    const sent = await guest.sendFile("from-old.txt", "text/plain", Buffer.from("old Guest payload"));
    assert.equal(sent.ok, true);
    await until(() => manager.activeRoom.files.has(sent.file.fileId), "Host received old file");
    const saved = path.join(directory, "saved.txt"); saves.push(saved);
    await manager.saveReceivedFile(manager.activeRoom.key, sent.file.fileId);
    assert.equal(fs.readFileSync(saved, "utf8"), "old Guest payload");
    const exported = path.join(directory, "export.md"); saves.push(exported);
    await manager.exportActive();
    assert.match(fs.readFileSync(exported, "utf8"), /structured Host message/);
    manager.moderate("edit", { participantId: identity, user: "Old Guest" }, "Renamed Guest", "Reviewer");
    await until(() => manager.activeRoom.members.some(member => member.participantId === identity && member.user === "Renamed Guest"
      && member.role === "Reviewer"), "original moderation edit");
    manager.renameSelf("Renamed Host");
    await until(() => manager.activeRoom.user === "Renamed Host", "original self rename");
    await manager.addManagedAgent({});
    await until(() => [...manager.managedAgents.values()].some(agent => agent.client.isConnected), "real managed agent lifecycle connected");
    const agent = [...manager.managedAgents.values()][0];
    manager.editManagedAgent(agent.id, "Edited Agent", "Test role", "🤖");
    await until(() => manager.activeRoom.members.some(member => member.user === "Edited Agent"), "managed agent edit");
    manager.removeManagedAgent(agent.id);
    await until(() => !manager.managedAgents.size, "managed agent removal");
    const previousSecret = (await credentials.load(created.roomId)).joinSecret;
    assert.equal(await manager.rotateRoomSecret(created.roomId), true);
    let rotatedSecret = (await credentials.load(created.roomId)).joinSecret;
    assert.notEqual(rotatedSecret, previousSecret);
    await until(() => manager.getRoomKey(created.roomId) === rotatedSecret, "original Host rekey/invite state");
    await manager.renameActiveRoom(created.roomId, "Renamed Room");
    await until(() => received.some(message => message.system && message.text.includes("Renamed Room")) || guest.opts.room === "Renamed Room",
      "active Room rename reached old client");
    await manager.adminCloseRoom(created.roomId);
    guest.disconnect();
    await manager.stopHub();
    let replaceEntered = false, releaseReplace;
    const replaceGate = new Promise(resolve => { releaseReplace = resolve; });
    const prepared = native.rotateRoomJoinSecret({ storage, roomId: created.roomId, current: rotatedSecret,
      next: "prepared-but-not-written", assertAuthority() { storage.assertWorkspaceLease(); },
      async replace() { replaceEntered = true; await replaceGate; throw new Error("Interrupted before profile write."); } });
    const rejected = assert.rejects(prepared, /Interrupted before/);
    await until(() => replaceEntered, "prepared secret rotation");
    const hash = value => createHash("sha256").update(value).digest("hex");
    assert.throws(() => native.resolveRoomJoinSecretHash(storage, created.roomId, hash(rotatedSecret), rotatedSecret),
      /in progress/, "A concurrent reader must not roll back an in-flight rotation.");
    releaseReplace();
    await rejected;
    assert.equal(native.resolveRoomJoinSecretHash(storage, created.roomId, hash(rotatedSecret), rotatedSecret), hash(rotatedSecret));
    let connections = 0;
    const failingStorage = {
      assertWorkspaceLease() { storage.assertWorkspaceLease(); },
      connectNative() {
        if (++connections === 2) throw new Error("Cannot open the rotation connection.");
        return storage.connectNative();
      },
    };
    await assert.rejects(native.rotateRoomJoinSecret({ storage: failingStorage, roomId: created.roomId,
      current: rotatedSecret, next: "never-prepared", assertAuthority() {},
      async replace() { assert.fail("A failed connection must not write profile credentials."); } }), /rotation connection/);
    assert.equal(native.resolveRoomJoinSecretHash(failingStorage, created.roomId, hash(rotatedSecret), rotatedSecret),
      hash(rotatedSecret), "A failed connection must not leave the Room permanently busy.");
    await assert.rejects(native.rotateRoomJoinSecret({ storage, roomId: created.roomId, current: rotatedSecret,
      next: "profile-write-committed-but-ack-lost", assertAuthority() { storage.assertWorkspaceLease(); },
      async replace(secret) { await credentials.replaceJoinSecret(created.roomId, secret); throw new Error("Interrupted after profile write."); } }),
    /Interrupted after/);
    const journalDb = storage.connectNative();
    try {
      const before = journalDb.prepare("SELECT * FROM next_room_secret_state WHERE room_id=?").get(created.roomId);
      assert.throws(() => native.resolveRoomJoinSecretHash(storage, created.roomId, hash(rotatedSecret), "unrelated-profile-secret"),
        /neither recorded/);
      assert.deepEqual(journalDb.prepare("SELECT * FROM next_room_secret_state WHERE room_id=?").get(created.roomId), before);
      assert.equal(before.current_hash, hash(rotatedSecret));
      assert.equal(before.pending_hash, hash("profile-write-committed-but-ack-lost"));
      assert.equal(JSON.stringify(before).includes("profile-write-committed-but-ack-lost"), false);
    } finally { journalDb.close(); }
    rotatedSecret = (await credentials.load(created.roomId)).joinSecret;
    await manager.renameStoredRoom(created.roomId, "Stored Rename");
    const repaired = await manager.repairStoredRoom(created.roomId);
    assert.equal(repaired.roomName, "Stored Rename");
    assert(repaired.messageCount > 0);
    const again = await manager.startHub(0);
    assert.equal(again.ok, true, again.error);
    const rehosted = await manager.rehostRoom(created.roomId);
    assert.equal(rehosted.room, "Stored Rename");
    assert.equal(rehosted.secret, rotatedSecret, "Profile secret rotation survives Hub restart.");
    assert.equal(legacyConstructions, 0);
    assert.equal(fs.existsSync(path.join(root, "chatrooms")), false);
    assert.deepEqual(uiErrors, []);
    await manager.adminCloseRoom(created.roomId);
    await manager.deleteStoredRoom(created.roomId);
    assert.equal((await manager.hub.listStoredRooms()).length, 0);
    assert.equal(await credentials.load(created.roomId), undefined);
    const legacySource = path.join(oldDirectory, "archive-source");
    for (const name of ["chat-persistence.js", "chat-persistence-worker.js", "chatroom/chat-persistence.js",
      "chatroom/chat-persistence-worker.js", "chatroom/meeting-state.js", "runtime/cross-process-lock.js", "sql-wasm.js", "sql-wasm.wasm"]) {
      const target = path.join(legacySource, "dist", name);
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.writeFileSync(target, execFileSync("unzip", ["-p", baseline, `extension/dist/${name}`]));
    }
    const fixture = require(path.join(project, "tests/next-trial-electron/chatroom-live-fixture.cjs"));
    const historicalCredentials = await credentials.create(fixture.roomId);
    const sourceRoot = path.join(directory, "closed-legacy-source");
    fs.mkdirSync(sourceRoot, { recursive: true, mode: 0o700 });
    const archive = await fixture.create({ extension: legacySource, root: sourceRoot,
      credentials: historicalCredentials, hostParticipantId: "historic-human" });
    const OriginalMeetings = require(path.join(legacySource, "dist/chatroom/meeting-state.js")).MeetingStateStore;
    const oldMeetings = new OriginalMeetings(path.join(sourceRoot, "chatrooms"), path.join(sourceRoot, "notes"));
    const oldMeeting = await oldMeetings.startMeeting({ roomId: fixture.roomId, roomName: "Historical multi-participant room",
      title: "Original retained Meeting", problemStatement: "Original problem", owner: "Historic Human", lead: "Historic Human",
      recorder: "Historic Human", participants: ["Historic Human", "Historic Agent"], host: "Historic Human",
      triggerMessageId: "original-discuss", requestId: "original-meeting-start", expectedRevision: 0 });
    await oldMeetings.adjournMeeting({ roomId: fixture.roomId, meetingId: oldMeeting.id, actor: "Historic Human",
      requestId: "original-adjourn", expectedRevision: oldMeeting.revision });
    const originalNote = path.join(sourceRoot, "notes", oldMeeting.markdownPath);
    fs.appendFileSync(originalNote, "\nOriginal manual Note edit; preserve exact bytes.\n");
    const originalBody = fs.readFileSync(originalNote, "utf8");
    const missingDocument = await oldMeetings.startMeeting({ roomId: fixture.roomId, roomName: "Historical multi-participant room",
      title: "Originally trashed document", problemStatement: "Original Trash", owner: "Historic Human", lead: "Historic Human",
      recorder: "Historic Human", participants: ["Historic Human"], host: "Historic Human",
      triggerMessageId: "original-trash-discuss", requestId: "original-trash-start", expectedRevision: 0,
      startedAt: new Date(Date.now() + 1000).toISOString() });
    await oldMeetings.adjournMeeting({ roomId: fixture.roomId, meetingId: missingDocument.id, actor: "Historic Human",
      requestId: "original-trash-adjourn", expectedRevision: missingDocument.revision });
    await oldMeetings.moveToTrash({ roomId: fixture.roomId, meetingId: missingDocument.id, actor: "Historic Human",
      requestId: "original-trash", expectedRevision: oldMeetings.snapshot(fixture.roomId).history.find(item => item.id === missingDocument.id).revision });
    const missingOriginalNote = path.join(sourceRoot, "notes", missingDocument.markdownPath);
    assert.equal(fs.existsSync(missingOriginalNote), false);
    const originalState = fs.readFileSync(path.join(sourceRoot, "chatrooms", fixture.roomId, "meetings/canonical.json"), "utf8");
    const unadoptedLiveRoot = path.join(directory, "unadopted-live-root");
    fs.mkdirSync(unadoptedLiveRoot, { mode: 0o700 });
    assert.throws(() => native.copyPrivateRoomArchive(storage, sourceRoot, unadoptedLiveRoot, fixture.roomId),
      /no Meeting Note privacy admission/);
    assert.equal(fs.existsSync(path.join(root, "chatrooms", fixture.roomId)), false);
    fs.cpSync(path.join(sourceRoot, "chatrooms"), path.join(root, "chatrooms"), { recursive: true });
    fs.cpSync(path.join(sourceRoot, "notes"), path.join(root, "notes"), { recursive: true });
    const archiveFile = path.join(root, "chatrooms", fixture.roomId, "chatroom.db");
    const copiedCanonical = path.join(root, "chatrooms", fixture.roomId, "meetings/canonical.json");
    const copiedNote = path.join(root, "notes", oldMeeting.markdownPath);
    const invalidState = JSON.parse(originalState);
    invalidState.meetings[0].markdownPath = "../outside-the-Meeting-collection.md";
    fs.writeFileSync(copiedCanonical, JSON.stringify(invalidState));
    try { await assert.rejects(manager.rehostRoom(fixture.roomId), /Invalid or cross-Room Meeting/); }
    finally { fs.writeFileSync(copiedCanonical, originalState); }
    const connectNative = storage.connectNative.bind(storage);
    storage.connectNative = () => {
      const db = connectNative();
      db.function("alter_note_during_admission", roomId => {
        if (roomId === fixture.roomId) fs.appendFileSync(copiedNote, "\nExternal edit during admission.\n");
        return 1;
      });
      db.exec(`CREATE TEMP TRIGGER meeting_admission_probe AFTER INSERT ON next_room_meetings
        BEGIN SELECT alter_note_during_admission(NEW.room_id); END`);
      return db;
    };
    try {
      await assert.rejects(manager.rehostRoom(fixture.roomId), /source changed/);
      const db = connectNative();
      try { assert.equal(db.prepare("SELECT COUNT(*) AS n FROM next_room_meetings WHERE room_id=?").get(fixture.roomId).n, 0); }
      finally { db.close(); }
      assert.match(fs.readFileSync(copiedNote, "utf8"), /External edit during admission/);
    } finally {
      storage.connectNative = connectNative;
      fs.writeFileSync(copiedNote, originalBody);
    }
    const historical = await manager.rehostRoom(fixture.roomId);
    manager.joinRoom({ ...historical, url: again.wsUrl, user: "Historic Human", token: historical.secret, cid: "host-after-upgrade" });
    await until(() => manager.activeRoom?.client.participantId === "historic-human", "original archived Host participant");
    assert.equal(manager.meetingStore.snapshot(fixture.roomId).history[0].id, oldMeeting.id);
    assert.equal((await manager.meetingStore.readNote(fixture.roomId, oldMeeting.id)).content, originalBody);
    assert.equal(await manager.openActiveMeetingNote(oldMeeting.id), true);
    assert.equal(noteViews.at(-1).content, originalBody);
    const importedSnapshot = manager.meetingStore.snapshot(fixture.roomId);
    fs.appendFileSync(copiedNote, "\nAn unexpected external source edit.\n");
    try {
      await assert.rejects(manager.meetingStore.readNote(fixture.roomId, oldMeeting.id), /source changed/);
      await assert.rejects(manager.mutateMeetingTrash("trash", oldMeeting.id, "changed-source-trash",
        importedSnapshot.history[0].revision), /source changed/);
      assert.deepEqual(manager.meetingStore.snapshot(fixture.roomId), importedSnapshot);
    } finally { fs.writeFileSync(copiedNote, originalBody); }
    const archiveSecrets = new Map(values), viewCount = noteViews.length;
    await credentials.delete(fixture.roomId);
    await assert.rejects(manager.openActiveMeetingNote(oldMeeting.id), /Original Host credentials/);
    assert.equal(noteViews.length, viewCount);
    values.clear(); for (const [key, value] of archiveSecrets) values.set(key, value);
    await manager.mutateMeetingTrash("trash", oldMeeting.id, "retained-note-trash",
      manager.meetingStore.snapshot(fixture.roomId).history.find(item => item.id === oldMeeting.id).revision);
    await assert.rejects(manager.meetingStore.readNote(fixture.roomId, oldMeeting.id), /Trash/);
    await manager.mutateMeetingTrash("restore", oldMeeting.id, "retained-note-restore",
      manager.meetingStore.snapshot(fixture.roomId).trash[0].revision);
    assert.equal((await manager.meetingStore.readNote(fixture.roomId, oldMeeting.id)).content, originalBody,
      "Restoring a retained document must not silently discard the original manual annotations.");
    await manager.mutateMeetingTrash("restore", missingDocument.id, "missing-original-document-restore",
      manager.meetingStore.snapshot(fixture.roomId).trash.find(item => item.id === missingDocument.id).revision);
    const regenerated = manager.meetingStore.snapshot(fixture.roomId).history.find(item => item.id === missingDocument.id);
    assert.equal((await manager.meetingStore.readNote(fixture.roomId, missingDocument.id)).content,
      manager.meetingStore.markdown(regenerated), "A missing original document must regenerate, not expose its trashed placeholder.");
    assert.equal(fs.existsSync(path.join(root, "notes", missingDocument.markdownPath)), false);
    assert.equal(await manager.rotateRoomSecret(historical.room), true);
    const historicalSecret = (await credentials.load(fixture.roomId)).joinSecret;
    await manager.renameActiveRoom(fixture.roomId, "Retained archive renamed in core");
    await manager.adminCloseRoom(fixture.roomId);
    await manager.stopHub();
    assert.equal((await manager.repairStoredRoom(fixture.roomId)).roomName, "Retained archive renamed in core");
    await assert.rejects(manager.deleteStoredRoom(fixture.roomId), /Retained migration archives are not deleted/);
    const finalStart = await manager.startHub(0);
    assert.equal(finalStart.ok, true, finalStart.error);
    const restoredArchive = await manager.rehostRoom(fixture.roomId);
    assert.equal(restoredArchive.secret, historicalSecret);
    assert.equal(restoredArchive.room, "Retained archive renamed in core");
    assert.equal(hash(fs.readFileSync(archiveFile)), archive.dbSha256, "The retained archive must remain byte-identical.");
    assert.equal(hash(fs.readFileSync(path.join(sourceRoot, "chatrooms", fixture.roomId, "chatroom.db"))), archive.dbSha256);
    assert.equal(fs.readFileSync(path.join(root, "chatrooms", fixture.roomId, "meetings/canonical.json"), "utf8"), originalState);
    assert.equal(fs.readFileSync(path.join(root, "notes", oldMeeting.markdownPath), "utf8"), originalBody);
    await manager.createHostedRoom("Shutdown probe", "shutdown-secret");
    await assert.rejects(registration.dispose(), /revoked/,
      "Forced authority revocation closes transport but must not claim successful unauthorized state cleanup.");
    registration = undefined;
    allowed = false;
    assert.throws(() => manager.meetingStore.snapshot(fixture.roomId), /revoked/);
    await assert.rejects(fetch(finalStart.wsUrl.replace("ws:", "http:") + "/health"));
    assert.throws(() => retained.selectRoomHostHub(root, () => { legacyConstructions++; }, {}), /revoked/);
    assert.equal(legacyConstructions, 0, "Revocation must never fall back to the legacy writer.");
  });
}

test("original Meeting dialogs preserve legacy defaults and disclose retained sources for Core Notes", () => {
  const source = fs.readFileSync(path.join(project, "src/webview/panel/10-chatroom.js"), "utf8");
  const functions = source.slice(source.indexOf("function chatMeetingContextMenu("), source.indexOf("function chatSelectMeetingSummary("));
  for (const storage of [undefined, "next-core"]) {
    const dialogs = [], sent = [];
    const context = {
      chat: { active: { selfHost: true, meetingNoteStorage: storage, meetings: { history: [{ id: "meeting", title: "Title", revision: 7 }] } } },
      showPaperMenu(_x, _y, items) { items.at(-1).onClick(); }, pkModal(value) { dialogs.push(value); },
      chatMeetingRequestId: () => "explicit-user-request", vscode: { postMessage(value) { sent.push(JSON.parse(JSON.stringify(value))); } },
    };
    vm.runInNewContext(`${functions}
      chatMeetingContextMenu({preventDefault(){},stopPropagation(){}}, "meeting");
      chatDeleteMeeting("meeting",7);`, context);
    if (storage === "next-core") {
      assert.match(dialogs[0].message, /Original retained Note files are not removed/);
      assert.match(dialogs[1].message, /Original retained source files.*not deleted/);
      assert.equal(dialogs[1].okLabel, "Remove Core Summary");
    } else {
      assert.equal(dialogs[0].message, "The generated Meeting Note will leave Notes until this Meeting is restored.");
      assert.equal(dialogs[1].okLabel, "Delete Permanently");
    }
    for (const dialog of dialogs) dialog.onOk();
    assert.deepEqual(sent.map(value => [value.command, value.meetingId, value.expectedRevision]),
      [["chatMeetingTrash", "meeting", 7], ["chatMeetingDelete", "meeting", 7]]);
  }
});

test("unadopted roots retain the legacy factory; experimental adoption cannot register", async () => {
  const directory = path.join(project, ".migration-test-work", `room-owner-${randomUUID()}`);
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  try {
    const file = path.join(directory, "owner.cjs");
    require("esbuild").buildSync({ entryPoints: [path.join(project, "src/chatroom/room-host-owner.ts")],
      bundle: true, platform: "node", format: "cjs", outfile: file, logLevel: "silent" });
    const mod = require(file), started = [];
    const old = mod.selectRoomHostHub(directory, () => ({ start(port) { started.push(port); }, stop() {} }), {});
    old.start(7345);
    assert.deepEqual(started, [7345]);
    assert.throws(() => mod.registerAdoptedRoomHostOwner({ root: directory, workspaceId: randomUUID(),
      qualification: "experimental-unqualified", assertAuthority() {}, createHub() {} }), /qualified/);
    assert.throws(() => mod.registerAdoptedRoomHostOwner({ root: directory, workspaceId: randomUUID(),
      qualification: "new-next-workspace", assertAuthority() {}, createHub() {} }), /already selected a legacy/);
    let live = true, creations = 0, finishStop;
    const nextRoot = path.join(directory, "next"), stopping = new Promise(resolve => { finishStop = resolve; });
    const nextOwner = { root: nextRoot, workspaceId: randomUUID(),
      qualification: "new-next-workspace", assertAuthority() { if (!live) throw new Error("revoked"); },
      createHub() { creations++; return { start() {}, stop() { return stopping; } }; } };
    const next = mod.registerAdoptedRoomHostOwner(nextOwner);
    const facade = mod.selectRoomHostHub(nextRoot, () => assert.fail("Next must not use legacy."), {});
    mod.selectRoomHostHub(nextRoot, () => assert.fail("Next must not use legacy."), {});
    assert.equal(creations, 1, "One workspace must reuse one Hub, not create competing UI writers.");
    live = false;
    const disposing = next.dispose();
    assert.throws(() => mod.registerAdoptedRoomHostOwner(nextOwner), /unique qualified/);
    finishStop();
    await disposing;
    assert.throws(() => mod.selectRoomHostHub(nextRoot, () => assert.fail("Revocation must not fall back."), {}), /revoked/);
    live = true;
    const replacement = mod.registerAdoptedRoomHostOwner({ ...nextOwner, createHub() { return { stop() {} }; } });
    assert.throws(() => facade.start(7345), /owner changed/);
    await replacement.dispose();
  } finally { fs.rmSync(directory, { recursive: true, force: true }); }
});
