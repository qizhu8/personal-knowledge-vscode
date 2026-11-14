import assert from "node:assert/strict";
import { test } from "node:test";
import { createRequire } from "node:module";
import { mkdirSync, readFileSync, writeFileSync, copyFileSync, rmSync, readdirSync, existsSync } from "node:fs";
import { resolve, join } from "node:path";
import { randomUUID, createHash } from "node:crypto";
import { once } from "node:events";
import { networkInterfaces } from "node:os";
import { execFileSync } from "node:child_process";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { initialize, Storage } from "../dist/storage.js";
import { LegacyChatroomRuntime, createLegacyChatroomClient } from "../dist/legacy-chatroom-runtime.js";
import { consumeLegacyChatroomHostGrant, createLegacyChatroomHostAuthority } from "../dist/legacy-chatroom-host-authority.js";
import { inspectLegacyChatroomArchive, inspectLegacyChatroomParticipants } from "../dist/legacy-chatroom-continuation.js";
import { adoptLegacyRootInPlaceExperimental } from "../dist/legacy-root-adoption.js";
const require = createRequire(import.meta.url);
const fixture = require("../legacy/tests/next-trial-electron/chatroom-live-fixture.cjs");
const project = resolve(new URL("../legacy", import.meta.url).pathname);
const sha = file => createHash("sha256").update(readFileSync(file)).digest("hex");
async function until(check, label) {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) { if (check()) return; await new Promise(resolve => setTimeout(resolve, 10)); }
  throw new Error(`Timed out: ${label}`);
}

test("participant resume proof is never forwarded to an unapproved endpoint", () => {
  const sent = [];
  class Client {
    participantId = "participant";
    identity = "client";
    onFrame() {}
    send(frame) { sent.push({ ...frame }); }
    connect(options) { this.send({ t: "join", cid: options.cid }); }
  }
  let credential;
  const client = createLegacyChatroomClient(Client, {
    onResumeCredential(value) { credential = value; }, onHistory() {}, onMessage() {}, onFileComplete() {},
  });
  const roomId = "synthetic-room", cid = "client", first = "ws://127.0.0.1:1111", second = "ws://127.0.0.1:2222";
  client.connect({ roomId, cid, url: first });
  client.onFrame(JSON.stringify({ t: "native.resume.credential", roomId, clientId: cid,
    participantId: "participant", secret: "a".repeat(43) }));
  client.connect({ roomId, cid, url: second });
  assert.equal(sent.at(-1).resumeCredential, undefined);
  client.connect({ roomId, cid, url: second, resumeCredential: { ...credential, url: second } });
  assert.equal(sent.at(-1).resumeCredential, credential.secret);
});

test("legacy credential and actor authority preserve host identity and fence client-ID impersonation", async t => {
  const directory = join(project, ".migration-test-work", `room-proof-${randomUUID()}`);
  const root = join(directory, "knowledge"), extension = join(directory, "legacy-source");
  mkdirSync(join(extension, "dist"), { recursive: true });
  const ts = require("typescript");
  for (const name of ["chat-persistence", "chat-persistence-worker"]) {
    writeFileSync(join(extension, name === "chat-persistence" ? "dist" : "", `${name}.js`),
      ts.transpileModule(readFileSync(join(project, "src/chatroom", `${name}.ts`), "utf8"), {
        compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
      }).outputText);
  }
  for (const name of ["sql-wasm.js", "sql-wasm.wasm"])
    copyFileSync(join(project, "node_modules/sql.js/dist", name), join(directory, name));
  const retainedFile = join(directory, "retained.cjs");
  require("esbuild").buildSync({ stdin: { contents: `
    export {ChatHub} from "./src/chatroom/chatroom-hub";
    export {ChatClient} from "./src/chatroom/chatroom-client";
    export {ChatJoinApprovalManager} from "./src/chatroom/chat-join-approval";
    export {ChatRoomCredentialStore} from "./src/chatroom/chat-room-credentials";
    export {WebSocketServer} from "ws";`, resolveDir: project },
    bundle: true, platform: "node", format: "cjs", packages: "external", outfile: retainedFile, logLevel: "silent" });
  const retained = require(retainedFile);
  let storage, runtime;
  const clients = [];
  t.after(async () => {
    for (const client of clients) client.disconnect();
    try { await runtime?.drain(); } finally {
      try { await storage?.close(); } finally { rmSync(directory, { recursive: true, force: true }); }
    }
  });
  await initialize(root);
  storage = await Storage.open(root, { deferRecovery: true });
  const secrets = new Map();
  const credentialStore = new retained.ChatRoomCredentialStore({
    async get(key) { return secrets.get(key); },
    async store(key, value) { secrets.set(key, value); },
    async delete(key) { secrets.delete(key); },
  });
  const credentials = await credentialStore.create(fixture.roomId);
  await fixture.create({ extension, root, credentials, hostParticipantId: "historic-human", temporaryAgent: true });
  const fingerprint = inspectLegacyChatroomArchive(root, fixture.roomId).sourceFingerprint;
  const networkAddress = Object.values(networkInterfaces()).flat().find(item => item && item.family === "IPv4" && !item.internal)?.address;
  const network = { bindAddress: networkAddress ?? "127.0.0.1", advertisedHost: networkAddress ?? "127.0.0.1", port: 0 };
  if (!networkAddress) t.diagnostic("No non-loopback IPv4 interface is available; network test used loopback.");
  const binding = { root, workspaceId: await storage.workspaceId(), actorId: "isolated-fixture-host",
    roomId: fixture.roomId, sourceFingerprint: fingerprint, operation: "reopen" };
  let allowed = false;
  const authorize = createLegacyChatroomHostAuthority({ storage, actorId: binding.actorId, credentials: credentialStore,
    authorizeActor: async actual => allowed && Object.entries(binding).every(([key, value]) => actual[key] === value) });
  assert.equal(await authorize(binding), false);
  allowed = true;
  assert.equal(await authorize({ ...binding, actorId: "untrusted-mcp-client" }), false);
  const hostKey = `personalKnowledge.chatroom.${fixture.roomId}.host`;
  const joinKey = `personalKnowledge.chatroom.${fixture.roomId}.join`;
  const oldHost = secrets.get(hostKey), oldJoin = secrets.get(joinKey);
  secrets.set(hostKey, "wrong-host-credential");
  assert.equal(await authorize(binding), false);
  secrets.set(hostKey, oldHost);
  secrets.set(joinKey, "wrong-join-secret");
  assert.equal(await authorize(binding), false);
  secrets.set(joinKey, oldJoin);
  const forged = createLegacyChatroomHostAuthority({ storage, actorId: binding.actorId,
    authorizeActor: async () => true, credentials: { async verifyHost() { return true; },
      async load() { return { ...credentials, joinSecret: "forged" }; } } });
  assert.equal(await forged(binding), false);
  let checks = 0;
  const revoked = createLegacyChatroomHostAuthority({ storage, actorId: binding.actorId, credentials: credentialStore,
    authorizeActor: async () => ++checks === 1 });
  assert.equal(await revoked(binding), false, "Actor revocation during credential lookup must deny admission.");
  const delayedGrant = await authorize(binding);
  allowed = false;
  assert.equal(await consumeLegacyChatroomHostGrant(delayedGrant, binding), undefined, "Revoked grants cannot be consumed.");
  allowed = true;
  const singleUseGrant = await authorize(binding);
  assert(await consumeLegacyChatroomHostGrant(singleUseGrant, binding));
  assert.equal(await consumeLegacyChatroomHostGrant(singleUseGrant, binding), undefined);
  const unverified = new LegacyChatroomRuntime({ storage, actorId: binding.actorId, retained, network,
    authorize: async () => true });
  try { await assert.rejects(unverified.reopen(fixture.roomId), /verified legacy Host credentials/); }
  finally { await unverified.drain(); }
  const open = async () => {
    runtime = new LegacyChatroomRuntime({ storage, actorId: "isolated-fixture-host", retained, network,
      authorize });
    return runtime.reopen(fixture.roomId);
  };
  let opened = await open();
  assert.equal(opened.authority, "verified-legacy-host-credential");
  assert.equal(opened.secret, credentials.joinSecret);
  assert(runtime.state(fixture.roomId).identity.memberships.find(member => member.participantId === "historic-agent").forgottenAt,
    "Temporary managed identities are forgotten on rehost, as in the legacy lifecycle.");
  assert.equal(new URL(opened.url).hostname, network.advertisedHost);
  assert.equal(runtime.server.address().address, network.bindAddress);
  await assert.rejects(runtime.hub.rotateRoomSecret(fixture.roomId), /credential host/);
  assert.equal((await credentialStore.load(fixture.roomId)).joinSecret, credentials.joinSecret);
  let presence = [];
  const received = new Map();
  const resumeCredentials = new Map();
  const connect = (user, cid, hostToken, resumeCredential) => {
    const client = createLegacyChatroomClient(retained.ChatClient, {
      onStatus() {}, onMessage() {}, onHistory() {}, onPresence(members) { presence = members; },
      onFileComplete(metadata, _from, bytes) { received.set(metadata.fileId, bytes); },
      onResumeCredential(value) { resumeCredentials.set(value.clientId, value); },
    });
    clients.push(client);
    client.connect({ url: opened.url, room: opened.room, roomId: fixture.roomId, user, cid, token: opened.secret,
      hostToken, resumeCredential });
    return client;
  };
  const host = connect("Host", "fixture-host-id", opened.hostToken);
  const peer = connect("Peer", "fixture-peer-id");
  await until(() => host.isConnected && peer.isConnected, "host and peer join");
  const hostId = host.participantId;
  assert.equal(hostId, "historic-human");
  const file = Buffer.alloc(8 * 1024 * 1024 + 1, 0x4b);
  const transfer = await host.sendFile("legacy-size.bin", "application/octet-stream", file);
  assert.equal(transfer.ok, true);
  await until(() => received.has(transfer.file.fileId), "legacy-sized file transfer");
  assert.deepEqual(received.get(transfer.file.fileId), file);
  const spoof = async (alias, includeRoomId, cid = "fixture-host-id", expected = "host-proof-required", resumeCredential) => {
    const ws = new (require("ws"))(opened.url);
    await once(ws, "open");
    const reply = new Promise((resolve, reject) => {
      ws.on("message", data => {
        const frame = JSON.parse(String(data));
        if (frame.t === "error") resolve(frame);
        else if (frame.t === "join.ready") reject(new Error("Host identity was impersonated."));
      });
      ws.on("error", reject);
      ws.on("close", () => reject(new Error("Connection closed without rejection.")));
    });
    ws.send(JSON.stringify({ t: "join", room: opened.room, ...(includeRoomId ? { roomId: fixture.roomId } : {}),
      user: alias, kind: "human", cid, token: opened.secret, resumeCredential }));
    assert.equal((await reply).code, expected);
    ws.terminate();
  };
  await spoof("Host", true);
  assert(host.isConnected);
  await spoof("Peer", true, "fixture-peer-id", "participant-proof-required");
  assert(peer.isConnected, "A shared Room secret and client ID must not evict another participant.");
  await until(() => resumeCredentials.has("fixture-peer-id"), "peer resume credential");
  const peerId = peer.participantId;
  peer.ws.terminate();
  await until(() => !peer.isConnected, "peer transport loss");
  await until(() => peer.isConnected, "credential-bound peer reconnect");
  assert.equal(peer.participantId, peerId);
  host.ws.terminate();
  host.disconnect();
  await until(() => presence.some(member => member.participantId === hostId && !member.present), "host departure");
  await spoof("Other Alias", false);
  const resumed = connect("Host", "fixture-host-id", opened.hostToken);
  await until(() => resumed.isConnected, "host reconnect");
  assert.equal(resumed.participantId, hostId);
  peer.ws.terminate();
  peer.disconnect();
  await until(() => presence.some(member => member.participantId === peer.participantId && !member.present), "peer departure");
  await spoof("Other Peer", false, "fixture-peer-id", "participant-proof-required");
  resumed.ws.terminate();
  resumed.disconnect();
  await runtime.drain();
  opened = await open();
  await spoof("Host", true);
  const restarted = connect("Host", "fixture-host-id", opened.hostToken);
  await until(() => restarted.isConnected, "host reconnect after restart");
  assert.equal(restarted.participantId, hostId);
  const restartedPeer = connect("Peer", "fixture-peer-id", undefined,
    { ...resumeCredentials.get("fixture-peer-id"), url: opened.url });
  await until(() => restartedPeer.isConnected, "credential-bound peer reconnect after restart");
  assert.equal(restartedPeer.participantId, peerId);
  assert(restarted.sendAdmin("kick", `participant:${peerId}`));
  await until(() => runtime.state(fixture.roomId).identity.memberships.some(member =>
    member.participantId === peerId && member.forgottenAt), "participant revocation");
  const afterRemoval = connect("Peer", "fixture-peer-id", undefined,
    { ...resumeCredentials.get("fixture-peer-id"), url: opened.url });
  await until(() => afterRemoval.isConnected, "removed participant rejoins as new identity");
  assert.notEqual(afterRemoval.participantId, peerId, "A removed identity must not be restored.");
});

test("native same-root Room: real clients, participant history, durable attachments, restart and protocol deduplication", async t => {
  const directory = join(project, ".migration-test-work", `room-live-${randomUUID()}`);
  const root = join(directory, "knowledge");
  let extension = join(directory, "legacy-source");
  mkdirSync(join(root, "notes"), { recursive: true });
  writeFileSync(join(root, "notes/Existing.md"), "---\ntitle: Existing\nrevision: 1\n---\nSynthetic.\n");
  const oldVsix = process.env.PKM_ROOM_LEGACY_VSIX ?? join(project, ".tmp/personal-knowledge-2.7.32-dev.vsix");
  if (existsSync(oldVsix)) {
    const extracted = join(directory, "old-installed");
    execFileSync("python3", ["-c", `
import pathlib, stat, sys, zipfile
with zipfile.ZipFile(sys.argv[1]) as archive:
    for entry in archive.infolist():
        name = pathlib.PurePosixPath(entry.filename)
        if name.is_absolute() or ".." in name.parts or stat.S_ISLNK(entry.external_attr >> 16):
            raise RuntimeError("Unsafe fixture VSIX path")
    archive.extractall(sys.argv[2])
`, oldVsix, extracted]);
    extension = join(extracted, "extension");
    assert.equal(JSON.parse(readFileSync(join(extension, "package.json"))).version, "2.7.32");
    console.log("REAL_LEGACY_CHATROOM_VSIX", JSON.stringify({ version: "2.7.32", sha256: sha(oldVsix) }));
  } else {
    mkdirSync(join(extension, "dist"), { recursive: true });
    const ts = require("typescript");
    for (const name of ["chat-persistence", "chat-persistence-worker"]) {
      writeFileSync(join(extension, name === "chat-persistence" ? "dist" : "", `${name}.js`),
        ts.transpileModule(readFileSync(join(project, "src/chatroom", `${name}.ts`), "utf8"), {
          compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
        }).outputText);
    }
    for (const name of ["sql-wasm.js", "sql-wasm.wasm"])
      copyFileSync(join(project, "node_modules/sql.js/dist", name), join(directory, name));
  }
  const retainedFile = join(directory, "retained.cjs");
  require("esbuild").buildSync({ stdin: { contents: `
    export {ChatHub} from "./src/chatroom/chatroom-hub";
    export {ChatClient} from "./src/chatroom/chatroom-client";
    export {ChatJoinApprovalManager} from "./src/chatroom/chat-join-approval";
    export {WebSocketServer} from "ws";`, resolveDir: project },
    bundle: true, platform: "node", format: "cjs", packages: "external", outfile: retainedFile, logLevel: "silent" });
  const retained = require(retainedFile);
  let storage, runtime;
  const clients = [];
  const servers = [];
  t.after(async () => {
    for (const entry of clients) entry.client.disconnect();
    try { for (const server of servers) await server.close(); try { await runtime?.drain(); } finally { await storage?.close(); } }
    finally { rmSync(directory, { recursive: true, force: true }); }
  });
  await fixture.create({ extension, root });
  const db = join(root, "chatrooms", fixture.roomId, "chatroom.db"), original = sha(db);
  const archive = inspectLegacyChatroomArchive(root, fixture.roomId);
  assert.equal(archive.messages.length, 3);
  assert.equal(inspectLegacyChatroomParticipants(root, fixture.roomId).memberships.length, 2);
  storage = (await adoptLegacyRootInPlaceExperimental(root, {})).storage;
  const workspaceId = await storage.workspaceId();
  const denied = new LegacyChatroomRuntime({ storage, actorId: "unapproved-host", retained, authorize: async () => false });
  try { await assert.rejects(denied.reopen(fixture.roomId), /host authority required/); }
  finally { await denied.drain(); }
  const surfacesOf = () => readdirSync(root).filter(name => !["core.sqlite-wal", "core.sqlite-shm"].includes(name)).sort();
  const surfaces = surfacesOf();
  const open = async () => {
    runtime = new LegacyChatroomRuntime({ storage, actorId: "private-profile-host", retained,
      legacyReconnect: "new-identity",
      authorize: async binding => binding.root === root && binding.roomId === fixture.roomId
        && binding.actorId === "private-profile-host" && binding.sourceFingerprint === archive.sourceFingerprint });
    return runtime.reopen(fixture.roomId);
  };
  let opened = await open();
  async function connect(alias, kind = "human", cid = alias) {
    const entry = { history: [], messages: [], presence: [], files: [], errors: [] };
    entry.client = createLegacyChatroomClient(retained.ChatClient, {
      onStatus() {}, onMessage: message => entry.messages.push(message),
      onHistory: messages => { entry.history = messages; }, onPresence: members => { entry.presence = members; },
      onFileComplete: (metadata, from, bytes) => entry.files.push({ metadata, from, bytes }),
      onRejected: (code, message) => entry.errors.push({ code, message }),
    });
    clients.push(entry);
    entry.client.connect({ url: opened.url, room: opened.roomName, roomId: fixture.roomId, user: alias, kind, cid,
      token: opened.secret, hostToken: alias === "Native Host" ? opened.hostToken : undefined });
    await until(() => entry.client.isConnected, `connect ${alias}`);
    return entry;
  }
  const host = await connect("Native Host"), peer = await connect("Native Peer", "agent");
  async function rejectHostImpersonation(alias) {
    const ws = new (require("ws"))(opened.url);
    await once(ws, "open");
    const rejected = new Promise((resolve, reject) => {
      ws.on("message", data => {
        const frame = JSON.parse(String(data));
        if (frame.t === "error") resolve(frame);
        if (frame.t === "join.ready") reject(new Error("Host identity was impersonated."));
      });
      ws.on("error", reject);
      ws.on("close", () => reject(new Error("Connection closed without rejection.")));
    });
    ws.send(JSON.stringify({ t: "join", room: opened.roomName, roomId: fixture.roomId,
      user: alias, kind: "human", cid: "Native Host", token: opened.secret }));
    assert.equal((await rejected).code, "host-proof-required");
    ws.terminate();
  }
  await rejectHostImpersonation("Native Host");
  assert.equal(host.client.isConnected, true, "An unauthenticated duplicate must not evict the host.");
  const originalHost = host.client.participantId;
  host.client.ws.terminate();
  host.client.disconnect();
  await until(() => !peer.presence.some(member => member.participantId === originalHost && member.present), "host offline");
  await rejectHostImpersonation("Different Alias");
  const returnedHost = await connect("Native Host");
  assert.equal(returnedHost.client.participantId, originalHost, "Valid host proof preserves reconnect identity.");
  const historicalClaim = await connect("Historic Human", "human", "historic-client-0");
  assert.notEqual(historicalClaim.client.participantId, "historic-human", "Legacy client IDs must not inherit historical identity or Host authority.");
  historicalClaim.client.disconnect();
  assert.deepEqual(host.history.slice(0, 3).map(message => message.id), fixture.messages.map(message => message.id));
  assert.equal(host.history[1].from, "Historic Agent");
  assert.equal(host.history[1].kind, "agent");
  await until(() => host.presence.some(member => member.participantId === "historic-human" || member.id === "historic-human"), "historic roster");
  assert.equal((await fetch(opened.downloadBase + fixture.file.fileId, {
    headers: { "X-PKM-Room-Secret": opened.secret },
  })).status, 404, "Old metadata must not be presented as recoverable attachment bytes.");
  assert.equal((await fetch(opened.downloadBase + fixture.file.fileId)).status, 403);
  assert.equal(returnedHost.client.sendText("Human continues after upgrade.", undefined, "none", undefined, ["Native Peer"]), true);
  assert.equal(peer.client.sendText("Agent continues after upgrade.", undefined, "none", undefined, ["Native Host"]), true);
  await until(() => returnedHost.messages.some(message => message.text === "Agent continues after upgrade."), "agent continuation");
  const bytes = Buffer.from("Actual synthetic binary attachment.\0".repeat(5000));
  const sent = await returnedHost.client.sendFile("after-upgrade.bin", "application/octet-stream", bytes);
  assert.equal(sent.ok, true);
  await until(() => peer.files.some(file => file.metadata.fileId === sent.file.fileId), "live actual file transfer");
  assert.deepEqual(peer.files.find(file => file.metadata.fileId === sent.file.fileId).bytes, bytes);
  const download = await fetch(opened.downloadBase + sent.file.fileId, { headers: { "X-PKM-Room-Secret": opened.secret } });
  assert.equal(download.status, 200);
  assert.deepEqual(Buffer.from(await download.arrayBuffer()), bytes);
  const request = { t: "msg", room: fixture.roomId, text: "One durable native operation.", recipients: ["all"],
    replyPolicy: "none", clientRequestId: "durable-request-0001" };
  returnedHost.client.ws.send(JSON.stringify(request));
  await until(() => returnedHost.messages.some(message => message.text === request.text), "durable message");
  const participant = returnedHost.client.participantId;
  for (const entry of clients) entry.client.disconnect();
  await runtime.drain(); runtime = undefined;
  await storage.close();
  storage = await Storage.open(root, { deferRecovery: true });
  opened = await open();
  const resumed = await connect("Native Host"), observer = await connect("Native Observer");
  assert.equal(resumed.client.participantId, participant, "Only an explicitly reauthorized native client identity resumes.");
  await until(() => observer.files.some(file => file.metadata.fileId === sent.file.fileId), "restart file replay into the real legacy client");
  assert.deepEqual(observer.files.find(file => file.metadata.fileId === sent.file.fileId).bytes, bytes);
  resumed.client.ws.send(JSON.stringify(request));
  await new Promise(resolve => setTimeout(resolve, 100));
  const inspector = storage.connectNative();
  try {
    const state = JSON.parse(inspector.prepare("SELECT state_json FROM legacy_room_runtime_rooms WHERE room_id=?").get(fixture.roomId).state_json);
    assert.equal(state.messages.filter(message => message.content === request.text).length, 1);
    assert.equal(state.messages.filter(message => message.metadata?.file?.fileId === sent.file.fileId).length, 1);
    assert.equal(inspector.prepare("SELECT count(*) AS n FROM legacy_room_runtime_files").get().n, 1);
  } finally { inspector.close(); }
  assert.equal(sha(db), original);
  assert.deepEqual(surfacesOf(), surfaces, "No new Knowledge Root surface is introduced.");
  assert.equal(observer.messages.filter(message => message.file?.fileId === sent.file.fileId).length, 0,
    "Replaying bytes must not add another UI note alongside durable history.");
  for (const entry of clients) entry.client.disconnect();
  await runtime.drain(); runtime = undefined;
  await storage.close(); storage = undefined;
  const nonce = randomUUID();
  writeFileSync(join(directory, "in-place-fixture-token"), nonce, { mode: 0o600 });
  writeFileSync(join(directory, "chatroom-host-grant.json"), JSON.stringify({
    root, nonce, workspaceId, retainedFile,
    roomRuntime: { roomId: fixture.roomId, sourceFingerprint: archive.sourceFingerprint },
  }), { mode: 0o600 });
  async function server(crash = false, reopen = true) {
    const transport = new StdioClientTransport({ command: process.execPath,
      args: [join(project, "tests/next-trial-electron/in-place-server.cjs"), directory, root, join(project, "../"), nonce],
      env: { ...process.env, PKM_IN_PLACE_PRIVATE_FIXTURE: nonce, PKM_ROOM_INTERRUPT_AFTER_FILE: crash ? nonce : "" }, stderr: "pipe" });
    const client = new Client({ name: "private-room-live-test", version: "1" });
    servers.push(client);
    await client.connect(transport);
    if (reopen) {
      const response = await client.callTool({ name: "legacy_chatroom_reopen", arguments: { roomId: fixture.roomId } });
      assert(!response.isError, JSON.stringify(response));
      opened = JSON.parse(response.content[0].text);
    }
    return { client, child: transport._process };
  }
  const interrupted = await server(true), exited = once(interrupted.child, "exit");
  const crashingHost = await connect("Native Host");
  let offer;
  const send = crashingHost.client.ws.send.bind(crashingHost.client.ws);
  crashingHost.client.ws.send = (raw, ...args) => {
    const frame = JSON.parse(String(raw));
    if (frame.t === "file.offer" && frame.file.name === "fixture-crash.bin") offer = frame;
    return send(raw, ...args);
  };
  const interruptedBytes = Buffer.from("Recover real pending bytes after process death.");
  await crashingHost.client.sendFile("fixture-crash.bin", "application/octet-stream", interruptedBytes).catch(() => {});
  assert.deepEqual(await exited, [77, null], "The server really exits between durable note and live file relay.");
  assert(offer);
  for (const entry of clients) entry.client.disconnect();
  await interrupted.client.close();
  const recovered = await server();
  const recoveredHost = await connect("Native Host"), recoveredPeer = await connect("Recovered Observer");
  assert.equal((await fetch(opened.downloadBase + offer.file.fileId,
    { headers: { "X-PKM-Room-Secret": opened.secret } })).status, 404);
  const chunk = { t: "file.chunk", room: fixture.roomId, fileId: offer.file.fileId, seq: 0,
    data: interruptedBytes.toString("base64"), last: true };
  for (const frame of [offer, chunk, offer, chunk]) recoveredHost.client.ws.send(JSON.stringify(frame));
  await until(() => recoveredPeer.files.some(file => file.metadata.fileId === offer.file.fileId), "resume interrupted payload");
  assert.deepEqual(recoveredPeer.files.find(file => file.metadata.fileId === offer.file.fileId).bytes, interruptedBytes);
  await new Promise(resolve => setTimeout(resolve, 100));
  assert.equal(recoveredPeer.files.filter(file => file.metadata.fileId === offer.file.fileId).length, 1);
  assert.equal(recoveredPeer.history.filter(message => message.file?.fileId === offer.file.fileId).length, 1);
  assert.equal(recoveredPeer.messages.filter(message => message.file?.fileId === offer.file.fileId).length, 0);
  for (const entry of clients) entry.client.disconnect();
  await recovered.client.close();
  assert.equal(sha(db), original);
  assert.deepEqual(surfacesOf(), surfaces);
  let shared = await server(false, false);
  const result = await require("../legacy/tests/next-trial-electron/chatroom-live-journey.cjs").run({
    fixture: directory, root, extension: project, runtime: join(project, "../"), identitySuffix: "-journey",
    call: async (name, args) => {
      const response = await shared.client.callTool({ name, arguments: args });
      assert(!response.isError, JSON.stringify(response));
      return JSON.parse(response.content[0].text);
    },
    restart: async crash => {
      await shared.client.close();
      shared = await server(crash, false);
      return shared.child;
    },
  });
  assert.equal(result.crashRecoveredWithoutDuplicateEffect, true);
  await shared.client.close();
  storage = await Storage.open(root, { deferRecovery: true });
  opened = await open();
  const epoch = storage.connectNative();
  try { epoch.prepare("UPDATE native_runtime_owner SET fence=fence+1 WHERE singleton=1").run(); }
  finally { epoch.close(); }
  await assert.rejects(runtime.reopen(fixture.roomId), /fenced|lease|owns.*workspace/i);
  await assert.rejects(runtime.drain(), /fenced|lease|owns.*workspace/i);
  runtime = undefined;
  await assert.rejects(fetch(opened.downloadBase + sent.file.fileId,
    { headers: { "X-PKM-Room-Secret": opened.secret } }), "Lease loss drains and confirms listener closure rather than switching epoch.");
  await storage.close(); storage = undefined;
  assert.equal(sha(db), original);
});
