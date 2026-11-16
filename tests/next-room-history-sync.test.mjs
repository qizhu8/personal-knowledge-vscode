import assert from "node:assert/strict";
import { after, test } from "node:test";
import { createRequire } from "node:module";
import { execFileSync } from "node:child_process";
import { createHash, createHmac, randomBytes, randomUUID } from "node:crypto";
import { createServer, request as httpRequest } from "node:http";
import * as fs from "node:fs";
import * as path from "node:path";
import { pathToFileURL } from "node:url";

const require = createRequire(import.meta.url), project = path.resolve(new URL("..", import.meta.url).pathname);
const directories = [];
after(() => { for (const directory of directories) fs.rmSync(directory, { recursive: true, force: true }); });
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(check) {
  for (let count = 0; count < 320; count++) { if (await check()) return; await wait(25); }
  throw new Error("Live history condition was not observed.");
}
test("live Host-authorized cross-root transcript resumes a broken network transfer and fetches the new head", async t => {
  const directory = path.join(project, ".migration-test-work", `room-live-history-${randomUUID()}`);
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  directories.push(directory);
  fs.writeFileSync(path.join(directory, "package.json"), '{"type":"module"}');
  fs.symlinkSync(path.join(project, "legacy/node_modules"), path.join(directory, "node_modules"), "dir");
  const build = (file, contents) => require("esbuild").buildSync({ stdin: { contents, resolveDir: project },
    bundle: true, platform: "node", format: file.endsWith(".cjs") ? "cjs" : "esm", packages: "external",
    outfile: path.join(directory, file), logLevel: "silent" });
  build("native.mjs", `
    export {initialize,Storage} from "./src/storage";
    export {inspectNativeRoom,createNativeRoom} from "./src/native-chatroom-identity";
    export {createNextRoomUiHub} from "./src/next-room-ui-hub";
    export {inspectLegacyChatroomArchive} from "./src/legacy-chatroom-continuation";
    export {admitPrivateRoom} from "./src/next-room-private-admission";
    export {historyPurpose,roomHistoryLineage} from "./src/next-room-history-sync";`);
  build("storage-worker.js", 'import "./src/storage-worker";');
  build("retained.cjs", `export {ChatHub} from "./legacy/src/chatroom/chatroom-hub";
    export {ChatJoinApprovalManager} from "./legacy/src/chatroom/chat-join-approval"; export {WebSocketServer} from "ws";`);
  const archive = process.env.PKM_LEGACY_VSIX || path.join(project, "legacy/personal-knowledge-4.0.22.vsix");
  assert(fs.existsSync(archive), "Set PKM_LEGACY_VSIX to the authorized original 4.0.22 VSIX (SHA-256 1804071cb3b9fc86edc5933d5001db6ea1a8d7a9adf30d6d2b3166fcd6048f27).");
  assert.equal(createHash("sha256").update(fs.readFileSync(archive)).digest("hex"),
    "1804071cb3b9fc86edc5933d5001db6ea1a8d7a9adf30d6d2b3166fcd6048f27");
  const original = path.join(directory, "original"); fs.mkdirSync(original);
  fs.writeFileSync(path.join(original, "package.json"), '{"type":"commonjs"}');
  for (const file of ["chat-room-credentials", "chatroom-client", "chatroom-protocol", "peer-protocol"])
    fs.writeFileSync(path.join(original, `${file}.js`), execFileSync("unzip", ["-p", archive, `extension/dist/chatroom/${file}.js`]));
  const OldClient = require(path.join(original, "chatroom-client.js")).ChatClient;
  const Credentials = require(path.join(original, "chat-room-credentials.js")).ChatRoomCredentialStore;
  const native = await import(pathToFileURL(path.join(directory, "native.mjs")));
  const retained = require(path.join(directory, "retained.cjs")), stores = new Set(), hubs = [], clients = [];
  const credentials = values => new Credentials({ async get(key) { return values.get(key); },
    async store(key, value) { values.set(key, value); }, async delete(key) { values.delete(key); } });
  const open = async root => { const storage = await native.Storage.open(root, { deferRecovery: true }); stores.add(storage); return storage; };
  const dbRead = (storage, callback) => { const db = storage.connectNative(); try { return callback(db); } finally { db.close(); } };
  let sourceLive = true, destinationLive = true, destination;
  const sourceRoot = path.join(directory, "source"), destinationRoot = path.join(directory, "destination");
  await native.initialize(sourceRoot); await native.initialize(destinationRoot);
  const source = await open(sourceRoot), sourceValues = new Map(), sourceCredentials = credentials(sourceValues);
  const sourceHub = native.createNextRoomUiHub({ storage: source, workspaceId: await source.workspaceId(), credentials: sourceCredentials,
    retained, historyExport: true, qualification: "new-next-workspace", assertAuthority() { if (!sourceLive) throw new Error("Source owner revoked."); },
    async chooseReconnectPolicy() { return "legacy-client-id"; }, async approveParticipant() { return false; } });
  hubs.push(sourceHub); await sourceHub.start(0);
  const room = await sourceHub.createRoom("Live cross-root history");
  const definition = native.inspectNativeRoom(source, room.roomId);
  const state = storage => dbRead(storage, db => JSON.parse(db.prepare(
    "SELECT state_json FROM legacy_room_runtime_rooms WHERE room_id=?").get(room.roomId).state_json));
  const connect = async (label, cid, url = room.url, onHistory = () => {}) => {
    const client = new OldClient(new Proxy({ onHistory }, { get: (target, key) => target[key] ?? (() => {}) }));
    clients.push(client);
    client.connect({ url, room: room.room, roomId: room.roomId, user: label, token: room.secret, cid });
    await until(() => client.isConnected && client.participantId);
    return client;
  };
  const author = await connect("history-author", "history-author"), reader = await connect("history-reader", "history-reader");
  const readerId = reader.participantId;
  const send = async text => {
    assert(author.sendText(text, undefined, "none", "chat", ["history-reader"]));
    await until(() => state(source).messages.some(message => message.content === text));
  };
  for (let index = 0; index < 10; index++) await send(`Live original-client message ${index}: ${"x".repeat(5000)}`);
  const sourcePort = sourceHub.port;
  let breakTransfer = true, tamperPage = false;
  const requests = [];
  const proxy = createServer((request, response) => {
    const chunks = [];
    request.on("data", chunk => chunks.push(chunk));
    request.on("end", () => {
      const body = Buffer.concat(chunks);
      if (request.url.endsWith("/history")) {
        const input = JSON.parse(body);
        requests.push({ offset: input.offset, snapshot: input.snapshot });
        if (breakTransfer && input.offset > 0) { response.destroy(); return; }
      }
      const upstream = httpRequest({ hostname: "127.0.0.1", port: sourcePort, path: request.url,
        method: request.method, headers: request.headers }, incoming => {
        response.writeHead(incoming.statusCode, incoming.headers);
        if (tamperPage && request.url.endsWith("/history") && incoming.statusCode === 200) {
          const parts = [];
          incoming.on("data", chunk => parts.push(chunk));
          incoming.on("end", () => {
            const page = JSON.parse(Buffer.concat(parts));
            page.proof.signature = "A".repeat(43);
            response.end(JSON.stringify(page));
          });
        } else incoming.pipe(response);
      });
      upstream.on("error", () => response.destroy()); upstream.end(body);
    });
  });
  await new Promise(resolve => proxy.listen(0, "127.0.0.1", resolve));
  t.after(async () => {
    for (const client of clients) client.disconnect();
    for (const hub of hubs) await hub.stop().catch(() => {});
    await new Promise(resolve => { proxy.close(resolve); proxy.closeAllConnections(); });
    for (const storage of stores) await storage.close();
  });
  const endpoint = `ws://127.0.0.1:${proxy.address().port}`, destinationCredentials = credentials(new Map(sourceValues));
  const makeDestination = async () => {
    destination = await open(destinationRoot);
    if (!native.inspectNativeRoom(destination, room.roomId)) native.createNativeRoom(destination, definition);
    const hub = native.createNextRoomUiHub({ storage: destination, workspaceId: await destination.workspaceId(),
      credentials: destinationCredentials, retained, qualification: "new-next-workspace",
      assertAuthority() { if (!destinationLive) throw new Error("Destination owner revoked."); },
      async chooseReconnectPolicy() { return "legacy-client-id"; }, async approveParticipant() { return false; },
      remoteRooms: { synchronizeHistory: true, async resolve() {
        return { workspaceId: await source.workspaceId(), sourceFingerprint: definition.sourceFingerprint, activeUrl: endpoint,
          state: state(source).state === "stored" ? "released" : "active" };
      } } });
    hubs.push(hub); await hub.start(0); return hub;
  };
  let destinationHub = await makeDestination();
  await t.test("real transport interruption persists its immutable byte cursor without partially publishing history", async () => {
    await assert.rejects(destinationHub.syncRemoteRoomHistory(room.roomId), /fetch failed|socket|network/i);
    assert.equal(state(destination).messages.length, 0);
    const partial = dbRead(destination, db => db.prepare("SELECT digest,length(data) AS bytes FROM next_room_history_incoming").get());
    assert.equal(partial.bytes, 32768); assert.match(partial.digest, /^[a-f0-9]{64}$/);
    assert(requests.some(request => request.offset === 32768));
  });
  await t.test("owner/storage restart resumes the saved checkpoint then obtains messages committed while offline", async () => {
    await send("Committed while the destination network transfer was disconnected");
    await destinationHub.stop(); await destination.close(); stores.delete(destination);
    breakTransfer = false;
    destinationHub = await makeDestination();
    const resumedAt = requests.length, receipt = await destinationHub.syncRemoteRoomHistory(room.roomId);
    assert.equal(receipt.messageCount, 11); assert.equal(receipt.sourceState, "active");
    assert.equal(requests[resumedAt].offset, 32768);
    assert(requests.slice(resumedAt).some(request => request.offset === 0 && !request.snapshot));
    assert.equal(state(destination).messages.at(-1).content, "Committed while the destination network transfer was disconnected");
    assert.equal(dbRead(destination, db => db.prepare("SELECT COUNT(*) AS n FROM next_room_history_incoming").get().n), 0);
  });
  await t.test("an already-used unsynchronized destination is not silently selected as a replica", async () => {
    const branchRoot = path.join(directory, "existing-local-branch");
    await native.initialize(branchRoot);
    const branch = await open(branchRoot);
    native.createNativeRoom(branch, definition);
    const hub = native.createNextRoomUiHub({ storage: branch, workspaceId: await branch.workspaceId(),
      credentials: destinationCredentials, retained, qualification: "new-next-workspace", assertAuthority() {},
      async chooseReconnectPolicy() { return "legacy-client-id"; }, async approveParticipant() { return false; },
      remoteRooms: { synchronizeHistory: true, async resolve() {
        return { workspaceId: await source.workspaceId(), sourceFingerprint: definition.sourceFingerprint,
          activeUrl: endpoint, state: "active" };
      } } });
    hubs.push(hub); await hub.start(0);
    await hub.renameStoredRoom(room.roomId, "Unsynchronized local rename");
    const before = state(branch);
    await assert.rejects(hub.syncRemoteRoomHistory(room.roomId), /unsynchronized.*reconciliation/);
    assert.deepEqual(state(branch), before);
    await assert.rejects(hub.forceCloseRemoteRoom(room.roomId), /unsynchronized.*reconciliation/);
    assert.equal(state(source).state, "active");
    assert.equal(author.isConnected, true);
    fs.mkdirSync(path.join(branchRoot, "chatrooms", room.roomId, "meetings"), { recursive: true, mode: 0o700 });
    fs.writeFileSync(path.join(branchRoot, "chatrooms", room.roomId, "meetings", "canonical.json"),
      '{"schema":1,"meetings":[]}', { mode: 0o600 });
    await assert.rejects(hub.syncRemoteRoomHistory(room.roomId), /Retained Meeting archives|conflicts with a legacy archive/);
    assert.deepEqual(state(branch), before);
  });
  await t.test("a real original SQLite archive retains its old Guest and receives new history through independently admitted roots", async () => {
    const extension = path.join(directory, "old-archive-extension"), origin = path.join(directory, "closed-original");
    fs.mkdirSync(origin, { mode: 0o700 });
    for (const file of ["chat-persistence.js", "chat-persistence-worker.js", "chatroom/chat-persistence.js",
      "chatroom/chat-persistence-worker.js", "runtime/cross-process-lock.js", "sql-wasm.js", "sql-wasm.wasm"]) {
      const target = path.join(extension, "dist", file);
      fs.mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 });
      fs.writeFileSync(target, execFileSync("unzip", ["-p", archive, `extension/dist/${file}`]));
    }
    fs.writeFileSync(path.join(extension, "package.json"), '{"type":"commonjs"}');
    const oldId = randomUUID(), values = new Map(), originalCredentials = credentials(values);
    const secrets = await originalCredentials.create(oldId);
    const Persistence = require(path.join(extension, "dist/chat-persistence.js")).ChatPersistence;
    const persistence = new Persistence(path.join(origin, "chatrooms"), 20, 0);
    try {
      await persistence.createRoom(oldId, "Original live transcript", { ownerInstallationId: "original-private-host",
        hostCredentialHash: secrets.hostCredentialHash, joinSecretHash: secrets.joinSecretHash });
      for (const [id, alias] of [["old-host-member", "Old Host"], ["old-guest-member", "Old Guest"]]) {
        await persistence.requestJoin(oldId, { requestId: `original-${id}`, alias, clientKey: id,
          kind: "human", requestedAt: 1740000000000, expiresAt: 1740000300000 });
        await persistence.resolveJoin(oldId, { requestId: `original-${id}`, participantId: id,
          outcome: "new", resolvedAt: 1740000000001 });
      }
      await persistence.recordLifecycle(oldId, "room.host_assigned", undefined, { participantId: "old-host-member" });
      await persistence.append(oldId, { id: "original-chat", participantId: "old-host-member", aliasAtSend: "Old Host",
        senderKind: "human", messageType: "chat", content: "Original persisted discussion", createdAt: 1740000001000 });
      await persistence.closeRoom(oldId);
    } finally { await persistence.dispose(); }
    const originalBytes = fs.readFileSync(path.join(origin, "chatrooms", oldId, "chatroom.db"));
    const profile = map => ({ async get(key) { return map.get(key); }, async store(key, value) { map.set(key, value); },
      async delete(key) { map.delete(key); } });
    const admitted = async name => {
      const root = path.join(directory, name); await native.initialize(root);
      const storage = await open(root), secretProfile = profile(new Map(values)), credential = new Credentials(secretProfile);
      await native.admitPrivateRoom({ storage, sourceRoot: origin, roomId: oldId, profile: secretProfile, credentials: credential,
        assertAuthority() {}, async authorize() { return true; } });
      return { root, storage, credential };
    };
    const from = await admitted("original-source-next"), to = await admitted("original-destination-next");
    const fingerprint = native.inspectLegacyChatroomArchive(from.root, oldId).sourceFingerprint;
    const oldState = storage => dbRead(storage, db => JSON.parse(db.prepare(
      "SELECT state_json FROM legacy_room_runtime_rooms WHERE room_id=?").get(oldId).state_json));
    const base = { retained, qualification: "new-next-workspace", assertAuthority() {},
      async chooseReconnectPolicy() { return "legacy-client-id"; }, async approveParticipant() { return false; } };
    const hosting = native.createNextRoomUiHub({ ...base, storage: from.storage, workspaceId: await from.storage.workspaceId(),
      credentials: from.credential, historyExport: true });
    hubs.push(hosting); await hosting.start(0);
    const active = await hosting.rehostRoom(oldId);
    const guest = new OldClient(new Proxy({}, { get: () => () => {} })), writer = new OldClient(new Proxy({}, { get: () => () => {} }));
    clients.push(guest, writer);
    guest.connect({ url: active.url, room: active.room, roomId: oldId, user: "Old Guest",
      token: secrets.joinSecret, cid: "old-guest-member" });
    writer.connect({ url: active.url, room: active.room, roomId: oldId, user: "New Writer",
      token: secrets.joinSecret, cid: "new-live-writer" });
    await until(() => guest.isConnected && writer.isConnected);
    assert.equal(guest.participantId, "old-guest-member");
    const receiving = native.createNextRoomUiHub({ ...base, storage: to.storage, workspaceId: await to.storage.workspaceId(),
      credentials: to.credential, remoteRooms: { synchronizeHistory: true, async resolve() {
        return { workspaceId: await from.storage.workspaceId(), sourceFingerprint: fingerprint,
          historyLineage: native.roomHistoryLineage(from.storage, oldId), activeUrl: active.url,
          state: oldState(from.storage).state === "stored" ? "released" : "active" };
      } } });
    hubs.push(receiving); await receiving.start(0);
    assert.equal((await receiving.syncRemoteRoomHistory(oldId)).messageCount, 1);
    assert(writer.sendText("Live update after both old source copies were admitted", undefined, "none", "chat", ["Old Guest"]));
    await until(() => oldState(from.storage).messages.length === 2);
    await receiving.forceCloseRemoteRoom(oldId);
    assert.equal(oldState(to.storage).messages.at(-1).content, "Live update after both old source copies were admitted");
    const hostedHere = await receiving.rehostRoom(oldId), replay = [];
    const restored = new OldClient(new Proxy({ onHistory(messages) { replay.push(...messages); } },
      { get: (target, key) => target[key] ?? (() => {}) }));
    clients.push(restored);
    restored.connect({ url: hostedHere.url, room: hostedHere.room, roomId: oldId, user: "Old Guest",
      token: secrets.joinSecret, cid: "old-guest-member" });
    await until(() => restored.isConnected && replay.length === 2);
    assert.equal(restored.participantId, "old-guest-member");
    assert.equal(replay[0].text, "Original persisted discussion");
    assert.equal(replay[1].text, "Live update after both old source copies were admitted");
    assert.deepEqual(fs.readFileSync(path.join(origin, "chatrooms", oldId, "chatroom.db")), originalBytes);
    await receiving.adminCloseRoom(oldId);
    fs.writeFileSync(path.join(directory, "original-archive-live-result.json"), JSON.stringify({
      passed: true, originalArchiveCreatedByFixed422Persistence: true, independentPrivateAdmissions: true,
      originalGuestId: "old-guest-member", originalMessageCount: 1, transferredMessageCount: 2,
      unchangedOriginalDatabase: true, originalDatabaseSha256: createHash("sha256").update(originalBytes).digest("hex"),
      sourceFingerprint: fingerprint, destinationFingerprint: native.inspectLegacyChatroomArchive(to.root, oldId).sourceFingerprint,
      commonContentLineage: native.roomHistoryLineage(from.storage, oldId),
      profiles: "independent memory SecretStorage-like maps in source test; installed journey separately uses real product profiles",
    }, null, 2), { mode: 0o600 });
  });
  await t.test("original Force Close fetches the newly committed final head before another root rehosts it", async () => {
    tamperPage = true;
    await assert.rejects(destinationHub.syncRemoteRoomHistory(room.roomId), /response authority/);
    assert.equal(state(destination).messages.length, 11);
    tamperPage = false;
    await send("New live message after the resumed checkpoint, before Force Close");
    await destinationHub.forceCloseRemoteRoom(room.roomId);
    assert.equal(state(destination).messages.length, 12);
    assert.equal(state(destination).messages.at(-1).content, "New live message after the resumed checkpoint, before Force Close");
    const reopened = await destinationHub.rehostRoom(room.roomId), history = [];
    const restored = await connect("history-reader", "history-reader", reopened.url, messages => history.push(...messages));
    await until(() => history.length === 12);
    assert.equal(restored.participantId, readerId);
    assert.equal(history.at(-1).text, "New live message after the resumed checkpoint, before Force Close");
    await destinationHub.adminCloseRoom(room.roomId);
  });
  await t.test("a local post-handoff branch is refused rather than overwritten on a later pull", async () => {
    const before = state(destination);
    await assert.rejects(destinationHub.syncRemoteRoomHistory(room.roomId), /branch changed|diverges/);
    assert.deepEqual(state(destination), before);
  });
  await t.test("revoking the destination owner rejects another pull and retains its local branch", async () => {
    const before = state(destination);
    destinationLive = false;
    await assert.rejects(async () => destinationHub.syncRemoteRoomHistory(room.roomId), /revoked/);
    assert.deepEqual(state(destination), before);
  });
  await t.test("join-secret forgery, close-purpose reuse, proof replay and revoked source cannot export history", async () => {
    const body = JSON.stringify({ version: 1, destinationWorkspaceId: await destination.workspaceId(),
      sourceFingerprint: definition.sourceFingerprint, lineage: definition.sourceFingerprint, offset: 0 });
    const url = endpoint.replace("ws:", "http:") + `/api/native-rooms/${room.roomId}/history`;
    const post = proof => fetch(url, { method: "POST", body, headers: {
      "X-PKM-Host-Timestamp": String(proof.timestamp), "X-PKM-Host-Nonce": proof.nonce, "X-PKM-Host-Proof": proof.signature } });
    const timestamp = Date.now(), nonce = randomBytes(16).toString("base64url");
    const purpose = native.historyPurpose(room.roomId, body);
    assert.equal((await post({ timestamp, nonce, signature: createHmac("sha256", room.secret)
      .update(`${purpose}\n${timestamp}\n${nonce}`).digest("base64url") })).status, 403);
    assert.equal((await post(await sourceCredentials.createHostProof(room.roomId, `force-close:${room.roomId}`))).status, 403);
    const proof = await sourceCredentials.createHostProof(room.roomId, purpose);
    assert.equal((await post(proof)).status, 200); assert((await post(proof)).status >= 400);
    const valid = await sourceCredentials.createHostProof(room.roomId, purpose);
    sourceLive = false;
    const denied = await post(valid).catch(() => undefined);
    assert(denied === undefined || denied.status >= 400);
  });
  fs.writeFileSync(path.join(directory, "live-history-result.json"), JSON.stringify({
    passed: true, sourceMessages: 12, destinationMessages: state(destination).messages.length,
    realOriginalClient: "fixed 4.0.22", proxyRequests: requests, restartedDestinationStorage: true,
    finalRehostRestoredOriginalGuestId: true, transport: "plaintext ws/HTTP in private namespace",
    scope: "new opt-in Next transcript protocol; not original legacy cross-root replication or production default",
  }, null, 2), { mode: 0o600 });
});
