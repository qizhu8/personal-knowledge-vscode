import assert from "node:assert/strict";
import { test } from "node:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { createRequire } from "node:module";
import { createHash, randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import { pathToFileURL } from "node:url";

const require = createRequire(import.meta.url), project = path.resolve(new URL("../legacy", import.meta.url).pathname);
const digest = file => createHash("sha256").update(fs.readFileSync(file)).digest("hex");
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(check) {
  for (let count = 0; count < 320; count++) { if (await check()) return; await wait(25); }
  throw new Error("Original client did not recover its actual history/identity.");
}
test("malformed saved Collaboration selections report blocked and cannot silently retry the legacy writer", async t => {
  for (const saved of ["{", "null"]) await t.test(saved, async () => {
    const directory = path.join(project, ".migration-test-work", `collaboration-selection-${randomUUID()}`);
    fs.mkdirSync(directory, { mode: 0o700 });
    const source = path.join(directory, "source");
    fs.mkdirSync(source, { mode: 0o700 });
    let commands = new Map(), savedKey;
    const subscriptions = [], secrets = { async get(key) {
      if (!savedKey) savedKey = key;
      return key === savedKey ? saved : undefined;
    } };
    let confirmations = 0, legacyStops = 0;
    const symbol = `collaboration-selection-${randomUUID()}`;
    globalThis[symbol] = {
      workspace: { isTrusted: true, getConfiguration() { return { get(_key, fallback) { return fallback; } }; } },
      commands: { registerCommand(name, handler) { commands.set(name, handler); return { dispose() {} }; } },
      window: { async showErrorMessage() {}, async showInformationMessage() {},
        async showWarningMessage() { confirmations++; return "Upgrade Collaboration"; } },
    };
    const mock = path.join(directory, "vscode.cjs");
    fs.writeFileSync(mock, `module.exports=globalThis[${JSON.stringify(symbol)}];`);
    const output = path.join(directory, "activation.cjs");
    require("esbuild").buildSync({ stdin: { contents: 'export {registerNextCollaboration} from "./src/chatroom/next-collaboration-activation";',
      resolveDir: project }, bundle: true, platform: "node", format: "cjs", packages: "external",
      alias: { vscode: mock }, outfile: output, logLevel: "silent" });
    try {
      await require(output).registerNextCollaboration({
        subscriptions, globalStorageUri: { fsPath: directory }, secrets,
      }, () => source, async () => { legacyStops++; });
      assert.equal(commands.get("_personalKnowledge.nextCollaborationStatus")().route, "blocked-next-selection");
      assert.equal((await commands.get("personalKnowledge.upgradeCollaboration")()).route, "blocked-next-selection");
      assert.equal(confirmations, 0);
      assert.equal(legacyStops, 0);
      commands = new Map();
      await require(output).registerNextCollaboration({
        subscriptions, globalStorageUri: { fsPath: path.join(directory, "another-profile") }, secrets,
      }, () => source, async () => { legacyStops++; });
      assert.equal(commands.get("_personalKnowledge.nextCollaborationStatus")().route, "legacy",
        "Sharing a credential backend must not opt another profile into this source root.");
    } finally {
      for (const subscription of subscriptions) subscription.dispose();
      delete globalThis[symbol];
    }
  });
});
test("configured original profile recovers a real old Room/Meeting/Note into one persistent Collaboration owner", async t => {
  const directory = path.join(project, ".migration-test-work", `collaboration-upgrade-${randomUUID()}`);
  fs.mkdirSync(directory, { mode: 0o700 });
  fs.writeFileSync(path.join(directory, "package.json"), '{"type":"module"}');
  fs.symlinkSync(path.join(project, "../node_modules"), path.join(directory, "node_modules"), "dir");
  const build = (file, contents) => require("esbuild").buildSync({ stdin: { contents, resolveDir: project },
    bundle: true, platform: "node", format: file.endsWith(".cjs") ? "cjs" : "esm", packages: "external",
    outfile: path.join(directory, file), logLevel: "silent" });
  build("next-collaboration-child.js", 'import "./next-server/src/next-collaboration-child";');
  build("storage-worker.js", 'import "./next-server/src/storage-worker";');
  build("legacy-chatroom-retained.cjs", `export {ChatHub} from "./src/chatroom/chatroom-hub";
    export {ChatJoinApprovalManager} from "./src/chatroom/chat-join-approval";
    export {MeetingStateStore} from "./src/chatroom/meeting-state"; export {WebSocketServer} from "ws";`);
  build("client.cjs", 'export {NextCollaborationClient} from "./src/chatroom/next-collaboration-client";');
  build("project.cjs", 'export {ProjectStore} from "./src/workflows/project-store";');
  build("inspect.mjs", `export {inspectLegacyChatroomArchive} from "./next-server/src/legacy-chatroom-continuation";
    export {resolveRoomOwner} from "./next-server/src/next-room-owner-directory";`);
  const archive = path.join(project, "personal-knowledge-4.0.22.vsix");
  assert.equal(digest(archive), "1804071cb3b9fc86edc5933d5001db6ea1a8d7a9adf30d6d2b3166fcd6048f27");
  const extension = path.join(directory, "original");
  for (const file of ["chat-persistence.js", "chat-persistence-worker.js", "chatroom/chat-persistence.js",
    "chatroom/chat-persistence-worker.js", "runtime/cross-process-lock.js", "sql-wasm.js", "sql-wasm.wasm",
    "chatroom/meeting-state.js", "chatroom/chat-room-credentials.js", "chatroom/chatroom-client.js",
    "chatroom/chatroom-protocol.js", "chatroom/peer-protocol.js"]) {
    const target = path.join(extension, "dist", file);
    fs.mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 });
    fs.writeFileSync(target, execFileSync("unzip", ["-p", archive, `extension/dist/${file}`]));
  }
  fs.writeFileSync(path.join(extension, "package.json"), '{"type":"commonjs"}');
  const Persistence = require(path.join(extension, "dist/chat-persistence.js")).ChatPersistence;
  const Credentials = require(path.join(extension, "dist/chatroom/chat-room-credentials.js")).ChatRoomCredentialStore;
  const Meetings = require(path.join(extension, "dist/chatroom/meeting-state.js")).MeetingStateStore;
  const OldClient = require(path.join(extension, "dist/chatroom/chatroom-client.js")).ChatClient;
  const Client = require(path.join(directory, "client.cjs")).NextCollaborationClient;
  const native = await import(pathToFileURL(path.join(directory, "inspect.mjs")));
  const values = new Map(), profile = { async get(key) { return values.get(key); },
    async store(key, value) { values.set(key, value); }, async delete(key) { values.delete(key); } };
  const credentials = new Credentials(profile), roomId = randomUUID();
  const originalCredentials = await credentials.create(roomId);
  const source = path.join(directory, "original-user-root"), root = path.join(directory, "workspace");
  fs.mkdirSync(source, { mode: 0o755 });
  const persistence = new Persistence(path.join(source, "chatrooms"), 20, 0);
  try {
    await persistence.createRoom(roomId, "Original installed Room", { ownerInstallationId: "original-user",
      hostCredentialHash: originalCredentials.hostCredentialHash, joinSecretHash: originalCredentials.joinSecretHash });
    for (const [participantId, clientKey, alias] of [["old-host", "old-host-client", "Original Host"],
      ["old-guest", "old-guest-client", "Original Guest"]]) {
      await persistence.requestJoin(roomId, { requestId: clientKey, alias, clientKey, kind: "human",
        requestedAt: 1740000000000, expiresAt: 1740000300000 });
      await persistence.resolveJoin(roomId, { requestId: clientKey, participantId, outcome: "new", resolvedAt: 1740000000001 });
    }
    await persistence.recordLifecycle(roomId, "room.host_assigned", undefined, { participantId: "old-host" });
    await persistence.append(roomId, { id: "original-message", participantId: "old-host", aliasAtSend: "Original Host",
      senderKind: "human", messageType: "chat", content: "Original durable Room data", createdAt: 1740000001000 });
    await persistence.closeRoom(roomId);
  } finally { await persistence.dispose(); }
  const originalMeetings = new Meetings(path.join(source, "chatrooms"), path.join(source, "notes"));
  const meeting = await originalMeetings.startMeeting({ roomId, roomName: "Original installed Room", title: "Original Meeting",
    problemStatement: "Preserve actual old canonical data", owner: "Original Host", lead: "Original Host", recorder: "Original Host",
    participants: ["Original Host", "Original Guest"], host: "Original Host", triggerMessageId: "original-message",
    requestId: "original-start", expectedRevision: 0 });
  await originalMeetings.adjournMeeting({ roomId, meetingId: meeting.id, actor: "Original Host",
    requestId: "original-adjourn", expectedRevision: meeting.revision });
  const note = path.join(source, "notes", meeting.markdownPath);
  const originalNote = fs.readFileSync(note, "utf8") + "\nOriginal manual Note edit must survive.\n";
  fs.writeFileSync(note, originalNote);
  const generalNote = path.join(source, "notes", "Independent Note.md");
  fs.writeFileSync(generalNote, "# Independent original Note\n\nStill on the original PKM route.\n");
  const originals = [path.join(source, "chatrooms", roomId, "chatroom.db"),
    path.join(source, "chatrooms", roomId, "meetings/canonical.json"), note, generalNote];
  const before = originals.map(digest);
  const projectStore = new (require(path.join(directory, "project.cjs")).ProjectStore)(path.join(source, ".pkm/state"));
  const command = () => ({ commandId: randomUUID(), fingerprint: randomUUID(), expectedStoreVersion: projectStore.list().storeVersion });
  const projectId = projectStore.createProject(command(), "Original product Project").entityId;
  const threadId = projectStore.createThread(command(), projectId, "Original product thread").entityId;
  let live = true, client, guest, portalAllowed = true, portalRuns = 0, pendingExecution;
  t.after(async () => { guest?.disconnect(); await client?.close(); });
  const open = async bootstrap => {
    client = new Client({ entry: path.join(directory, "next-collaboration-child.js"), root, sourceRoot: source,
      bootstrap, credentials, profile, assertCurrent() { if (!live) throw new Error("Configured profile revoked."); },
      strict: false,
      project: value => projectStore.inspectCollaborationOwnership(value.projectId, value.threadId, value.roomId),
      portal: {
        async authorize(value) { assert.equal(value.root, source); return portalAllowed; },
        async executeCommand(value) {
          portalRuns++;
          if (!pendingExecution) return { stdout: "original retained executor", requestId: value.requestId };
          return new Promise((_resolve, reject) => {
            pendingExecution();
            value.signal.addEventListener("abort", () => reject(new Error("Original executor cancelled.")), { once: true });
          });
        },
      },
      authorize(binding) { return binding.sourceRoot === source && binding.root === root; } });
    await client.start();
    return client.hub({ async chooseReconnectPolicy() { assert.fail("Default product compatibility must not add a Host policy dialog."); },
      async approveParticipant() { return false; } }, () => {});
  };
  let hub = await open(true);
  assert.equal(client.status().roomIds[0], roomId);
  assert.equal(hub.meetingStore.snapshot(roomId).history[0].id, meeting.id);
  assert.equal((await hub.meetingStore.readNote(roomId, meeting.id)).content, originalNote);
  await hub.start(0);
  let opened = await hub.rehostRoom(roomId);
  let history = [];
  const connectGuest = async () => {
    guest = new OldClient(new Proxy({ onHistory(value) { history = value; } },
      { get: (target, key) => target[key] ?? (() => {}) }));
    guest.connect({ url: opened.url, room: opened.room, roomId, user: "Original Guest",
      cid: "old-guest-client", token: opened.secret });
    await until(() => guest.isConnected && guest.participantId);
  };
  await connectGuest();
  assert.equal(guest.participantId, "old-guest");
  assert(history.some(message => message.id === "original-message"));
  const definition = native.inspectLegacyChatroomArchive(root, roomId);
  const lineage = createHash("sha256").update(JSON.stringify({ roomId,
    files: definition.files.map(file => ({ path: file.path, sha256: file.sha256, size: file.size })) })).digest("hex");
  const owner = await native.resolveRoomOwner({ roomId, url: opened.url, workspaceId: randomUUID(), historyLineage: lineage,
    assertAuthority() {}, createProof: purpose => credentials.createHostProof(roomId, purpose),
    verifyProof: (purpose, proof) => credentials.verifyHostProof(roomId, originalCredentials.hostCredentialHash, purpose, proof) });
  assert.equal(owner.workspaceId, client.status().workspaceId);
  assert.equal(owner.state, "active");
  await t.test("real child IPC retains pair-channel identity and exact one-use Portal command admission", async () => {
    const channelId = randomUUID(), contextId = randomUUID();
    await hub.createPortalChannel(channelId, "private-original-channel-key");
    assert(hub.portalChannelsSnapshot().some(value => value.channel === channelId.slice(0, 8)));
    const input = { root: source, contextId, operation: "command", pairId: randomUUID(), peerId: randomUUID(),
      detail: { requestId: randomUUID(), command: { program: "node", args: ["--version"] }, defaultCwd: source } };
    const execution = { ...input, ...input.detail, signal: new AbortController().signal };
    assert.equal(await hub.portalAuthority.authorize(input), true);
    await assert.rejects(hub.portalAuthority.executeCommand({ ...execution, command: { program: "other" } }), /matching one-use/);
    assert.equal(portalRuns, 0);
    assert.equal(await hub.portalAuthority.authorize(input), true);
    assert.equal((await hub.portalAuthority.executeCommand(execution)).stdout, "original retained executor");
    await assert.rejects(hub.portalAuthority.executeCommand(execution), /matching one-use/);
    portalAllowed = false;
    assert.equal(await hub.portalAuthority.authorize(input), false);
    assert.equal(portalRuns, 1);
    portalAllowed = true;
  });
  await t.test("Project/thread creation retry preserves the active Room and read-only ownership checks", async () => {
    const pair = { projectId, threadId }, wrong = { projectId, threadId: randomUUID() };
    await assert.rejects(hub.createRoom("Wrong Project Room", undefined, wrong), /ownership is unavailable/);
    const created = await hub.createRoom("Project Room", undefined, pair);
    const retry = await hub.createRoom("Project Room", undefined, pair);
    assert.equal(retry.roomId, created.roomId);
    assert.equal(retry.hostToken, created.hostToken);
    assert.equal(hub.adminRooms().filter(value => value.roomId === created.roomId).length, 1);
    const stored = await hub.listStoredRooms();
    assert.equal(stored.find(value => value.roomId === created.roomId).threadId, threadId);
    projectStore.linkThreadChatroom(command(), threadId, { roomId: created.roomId, roomName: created.room, linkedAt: new Date().toISOString() });
    const projectTree = directory => Object.fromEntries(fs.readdirSync(directory).sort().flatMap(name => {
      const file = path.join(directory, name);
      return fs.statSync(file).isDirectory() ? Object.entries(projectTree(file)) : [[file, digest(file)]];
    }));
    const original = projectTree(path.join(source, ".pkm/state"));
    assert.equal(projectStore.inspectCollaborationOwnership(projectId, threadId, randomUUID()), false);
    assert.equal(projectStore.inspectCollaborationOwnership(projectId, threadId, created.roomId), true);
    assert.deepEqual(projectTree(path.join(source, ".pkm/state")), original);
    assert.equal((await hub.createRoom("Project Room", undefined, pair)).roomId, created.roomId);
    projectStore.linkThreadChatroom(command(), threadId, { roomId: "12345678-1234-4234-8234-123456789abc",
      roomName: "Different association", linkedAt: new Date().toISOString() });
    assert.equal((await hub.listStoredRooms()).find(value => value.roomId === created.roomId).hasHostAuthority, false,
      "A denied Project binding stays visible without breaking the whole child snapshot.");
    projectStore.linkThreadChatroom(command(), threadId, { roomId: created.roomId, roomName: created.room,
      linkedAt: new Date().toISOString() });
    await hub.adminCloseRoom(created.roomId);
    await hub.deleteStoredRoom(created.roomId);
    assert(!(await hub.listStoredRooms()).some(value => value.roomId === created.roomId));
    const numericThread = projectStore.createThread(command(), projectId, "Numeric UUID archive").entityId;
    const numericRoom = "12345678-1234-4234-8234-123456789abc";
    projectStore.linkThreadChatroom(command(), numericThread, { roomId: numericRoom, roomName: "Original numeric UUID",
      linkedAt: new Date().toISOString() });
    assert.equal(projectStore.inspectCollaborationOwnership(projectId, numericThread, numericRoom), true);
  });
  await t.test("the configured endpoint does not turn a join secret into original Host authority", async () => {
    const forgedValues = new Map(values);
    forgedValues.set(`personalKnowledge.chatroom.${roomId}.host`, originalCredentials.joinSecret);
    const forged = new Credentials({ async get(key) { return forgedValues.get(key); },
      async store(key, value) { forgedValues.set(key, value); }, async delete(key) { forgedValues.delete(key); } });
    await assert.rejects(native.resolveRoomOwner({ roomId, url: opened.url, workspaceId: randomUUID(), historyLineage: lineage,
      assertAuthority() {}, createProof: purpose => forged.createHostProof(roomId, purpose),
      verifyProof: async (purpose, proof) => forged.verifyHostProof(roomId, (await forged.load(roomId)).hostCredentialHash, purpose, proof) }),
    /authenticate \(403\)/);
    assert.equal(guest.isConnected, true);
  });
  await t.test("a profile without the original Host cannot bootstrap an archive from its path", async () => {
    const empty = { async get() {}, async store() {}, async delete() {} };
    const unownedRoot = path.join(directory, "unowned-workspace");
    const denied = new Client({ entry: path.join(directory, "next-collaboration-child.js"), root: unownedRoot,
      sourceRoot: source, bootstrap: true, credentials: new Credentials(empty), profile: empty,
      assertCurrent() {}, authorize() { return true; } });
    try { await assert.rejects(denied.start(), /Original Host credentials/); }
    finally { await denied.close(); }
    assert.equal(fs.existsSync(path.join(unownedRoot, "chatrooms", roomId)), false);
    assert.deepEqual(originals.map(digest), before);
  });
  guest.disconnect();
  await t.test("stop between the consumed child grant and its parent continuation cannot start the original executor", async () => {
    const request = client.request, input = { root: source, contextId: randomUUID(), operation: "command", detail: {
      requestId: randomUUID(), command: { program: "node", args: [] }, defaultCwd: source } };
    let consumed, release;
    const consumption = new Promise(resolve => { consumed = resolve; }), held = new Promise(resolve => { release = resolve; });
    client.request = async function(operation, ...args) {
      const result = await request.call(this, operation, ...args);
      if (operation === "portal.consume") { consumed(); await held; }
      return result;
    };
    const runs = portalRuns;
    try {
      assert.equal(await hub.portalAuthority.authorize(input), true);
      const execution = hub.portalAuthority.executeCommand({ ...input, ...input.detail, signal: new AbortController().signal });
      const rejected = assert.rejects(execution, /stopped before command execution/);
      await consumption;
      await hub.stop();
      release(); await rejected;
      assert.equal(portalRuns, runs);
    } finally { release(); client.request = request; }
    await hub.start(0);
    await hub.rehostRoom(roomId);
  });
  await t.test("stopping the Hub cancels the original executor instead of accepting an owner-alive check", async () => {
    const input = { root: source, contextId: randomUUID(), operation: "command", detail: {
      requestId: randomUUID(), command: { program: "node", args: [] }, defaultCwd: source } };
    let started;
    const running = new Promise(resolve => { started = resolve; });
    pendingExecution = started;
    assert.equal(await hub.portalAuthority.authorize(input), true);
    const execution = hub.portalAuthority.executeCommand({ ...input, ...input.detail, signal: new AbortController().signal });
    const rejected = assert.rejects(execution, /cancelled/);
    await running;
    await hub.stop();
    await rejected;
    pendingExecution = undefined;
  });
  await hub.stop();
  const pidBefore = client.status().pid;
  await client.close();
  assert.throws(() => process.kill(pidBefore, 0), /ESRCH/);
  hub = await open(false);
  assert.notEqual(client.status().pid, pidBefore);
  assert.equal((await hub.meetingStore.readNote(roomId, meeting.id)).content, originalNote);
  await hub.start(0);
  opened = await hub.rehostRoom(roomId);
  await connectGuest();
  assert.equal(guest.participantId, "old-guest");
  assert(history.some(message => message.id === "original-message"));
  assert.deepEqual(originals.map(digest), before, "original SQLite, canonical, manual Note and ordinary Note bytes unchanged");
  await t.test("explicit bootstrap retry includes all source Rooms instead of silently selecting a partial admission", async () => {
    guest.disconnect(); await hub.stop(); await client.close();
    const laterRoom = randomUUID(), credential = await credentials.create(laterRoom);
    const writer = new Persistence(path.join(source, "chatrooms"), 20, 0);
    try {
      await writer.createRoom(laterRoom, "Remaining original Room", { ownerInstallationId: "original-user",
        hostCredentialHash: credential.hostCredentialHash, joinSecretHash: credential.joinSecretHash });
      await writer.closeRoom(laterRoom);
    } finally { await writer.dispose(); }
    const hostKey = `personalKnowledge.chatroom.${laterRoom}.host`, savedHost = await profile.get(hostKey);
    await profile.delete(hostKey);
    await assert.rejects(open(true), /Original Host credentials|Room .* has incomplete credentials/);
    await client.close();
    await profile.store(hostKey, savedHost);
    hub = await open(true);
    assert.deepEqual(client.status().roomIds.toSorted(), [roomId, laterRoom].toSorted());
    assert.equal((await hub.meetingStore.readNote(roomId, meeting.id)).content, originalNote);
    assert.deepEqual(originals.map(digest), before);
  });
  live = false;
  assert.throws(() => hub.adminRooms(), /revoked/);
});
