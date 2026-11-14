import assert from "node:assert/strict";
import { test } from "node:test";
import { createRequire } from "node:module";
import { execFileSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { pathToFileURL } from "node:url";

const project = path.resolve(new URL("../legacy", import.meta.url).pathname), require = createRequire(import.meta.url);
const hash = value => createHash("sha256").update(value).digest("hex");
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(check) {
  for (let i = 0; i < 480; i++) { if (await check()) return; await wait(25); }
  throw new Error("Actual full Room runtime condition was not observed.");
}
test("original clients and backend-adapted Meeting reducer survive full native cross-root handoff and replay", async t => {
  const directory = path.join(project, ".migration-test-work", `room-full-live-${randomUUID()}`);
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  fs.writeFileSync(path.join(directory, "package.json"), '{"type":"module"}');
  fs.symlinkSync(path.join(project, "../node_modules"), path.join(directory, "node_modules"), "dir");
  const build = (file, contents) => require("esbuild").buildSync({
    stdin: { contents, resolveDir: project }, bundle: true, platform: "node",
    format: file.endsWith(".cjs") ? "cjs" : "esm", packages: "external",
    outfile: path.join(directory, file), logLevel: "silent" });
  build("native.mjs", `export {initialize,Storage} from "./next-server/src/storage";
    export {inspectLegacyChatroomArchive} from "./next-server/src/legacy-chatroom-continuation";
    export {roomHistoryLineage} from "./next-server/src/next-room-history-sync";
    export {inspectNativeRoom,createNativeRoom} from "./next-server/src/native-chatroom-identity";
    export {NextRoomHistoryAssets} from "./next-server/src/next-room-history-assets";
    export {createNextRoomUiHub} from "./next-server/src/next-room-ui-hub";`);
  build("storage-worker.js", 'import "./next-server/src/storage-worker";');
  build("retained.cjs", `export {ChatHub} from "./src/chatroom/chatroom-hub";
    export {ChatJoinApprovalManager} from "./src/chatroom/chat-join-approval";
    export {MeetingStateStore} from "./src/chatroom/meeting-state"; export {WebSocketServer} from "ws";`);
  const archive = path.join(project, "personal-knowledge-4.0.22.vsix");
  assert.equal(hash(fs.readFileSync(archive)), "1804071cb3b9fc86edc5933d5001db6ea1a8d7a9adf30d6d2b3166fcd6048f27");
  const original = path.join(directory, "original"); fs.mkdirSync(original);
  fs.writeFileSync(path.join(original, "package.json"), '{"type":"commonjs"}');
  for (const file of ["chatroom/chat-room-credentials", "chatroom/chatroom-client", "chatroom/chatroom-protocol",
    "chatroom/peer-protocol", "chatroom/meeting-state", "runtime/cross-process-lock",
    "chat-persistence", "chat-persistence-worker", "chatroom/chat-persistence", "chatroom/chat-persistence-worker"]) {
    fs.mkdirSync(path.dirname(path.join(original, file)), { recursive: true });
    fs.writeFileSync(path.join(original, file + ".js"), execFileSync("unzip", ["-p", archive, `extension/dist/${file}.js`]));
  }
  const OldClient = require(path.join(original, "chatroom/chatroom-client.js")).ChatClient;
  const Credentials = require(path.join(original, "chatroom/chat-room-credentials.js")).ChatRoomCredentialStore;
  const OriginalMeetingStateStore = require(path.join(original, "chatroom/meeting-state.js")).MeetingStateStore;
  for (const file of ["sql-wasm.js", "sql-wasm.wasm"])
    fs.writeFileSync(path.join(original, file), execFileSync("unzip", ["-p", archive, `extension/dist/${file}`]));
  const native = await import(pathToFileURL(path.join(directory, "native.mjs")));
  const retained = require(path.join(directory, "retained.cjs"));
  const storages = [], hubs = [], clients = [];
  t.after(async () => {
    for (const client of clients) client.disconnect();
    for (const hub of hubs) await hub.stop();
    for (const storage of storages) await storage.close();
  });
  const open = async name => {
    const root = path.join(directory, name); await native.initialize(root);
    const storage = await native.Storage.open(root, { deferRecovery: true }); storages.push(storage); return storage;
  };
  const source = await open("source"), destination = await open("destination"), secrets = new Map();
  const credentials = values => new Credentials({ async get(key) { return values.get(key); },
    async store(key, value) { values.set(key, value); }, async delete(key) { values.delete(key); } });
  const sourceCredentials = credentials(secrets);
  const dbRead = (storage, callback) => { const db = storage.connectNative(); try { return callback(db); } finally { db.close(); } };
  const common = { retained, qualification: "new-next-workspace", fullHistory: true,
    historyExport: true, ownerDirectory: true, assertAuthority() {},
    async chooseReconnectPolicy() { return "legacy-client-id"; }, async approveParticipant() { return false; } };
  await t.test("an original archive Host pin remains provenance after explicit Guest succession and runtime restart", async () => {
    const origin = await open("legacy-origin"), receiver = await open("legacy-receiver");
    const values = new Map(), originCredentials = credentials(values), legacyRoomId = randomUUID();
    const legacyCredentials = await originCredentials.create(legacyRoomId);
    const OldPersistence = require(path.join(original, "chat-persistence.js")).ChatPersistence;
    const persistence = new OldPersistence(path.join(origin.workspaceRoot(), "chatrooms"), 50, 0);
    try {
      await persistence.createRoom(legacyRoomId, "Original archive identity", {
        ownerInstallationId: "isolated-original-archive",
        hostCredentialHash: legacyCredentials.hostCredentialHash, joinSecretHash: legacyCredentials.joinSecretHash });
      for (const [index, participantId, alias, cid] of [
        [0, "p-original-host", "Archived Host", "archived-host-cid"],
        [1, "p-original-guest", "Archived Guest", "archived-guest-cid"]]) {
        await persistence.requestJoin(legacyRoomId, { requestId: `archived-join-${index}`, alias,
          clientKey: cid, kind: "human", temporary: false, requestedAt: Date.now(), expiresAt: Date.now() + 60000 });
        await persistence.resolveJoin(legacyRoomId, { requestId: `archived-join-${index}`,
          participantId, outcome: "new", resolvedAt: Date.now() });
      }
      await persistence.recordLifecycle(legacyRoomId, "room.host_assigned", undefined, { participantId: "p-original-host" });
      await persistence.setRoomState(legacyRoomId, "stored"); await persistence.closeRoom(legacyRoomId);
    } finally { await persistence.dispose(); }
    fs.cpSync(path.join(origin.workspaceRoot(), "chatrooms"), path.join(receiver.workspaceRoot(), "chatrooms"), { recursive: true });
    const pinned = root => hash(fs.readFileSync(path.join(root, "chatrooms", legacyRoomId, "chatroom.db")));
    const originalPin = pinned(origin.workspaceRoot());
    const legacyFingerprint = native.inspectLegacyChatroomArchive(origin.workspaceRoot(), legacyRoomId).sourceFingerprint;
    const originHub = native.createNextRoomUiHub({ ...common, storage: origin,
      workspaceId: await origin.workspaceId(), credentials: originCredentials });
    hubs.push(originHub); await originHub.start(0);
    const hosted = await originHub.rehostRoom(legacyRoomId);
    const peer = async (url, hostToken) => {
      const client = new OldClient(new Proxy({}, { get: () => () => {} })); clients.push(client);
      client.connect({ roomId: legacyRoomId, room: hosted.room, url, user: "Archived Guest",
        cid: "archived-guest-cid", token: hosted.secret, hostToken });
      await until(() => client.isConnected && client.participantId); return client;
    };
    const oldGuest = await peer(hosted.url);
    assert.equal(oldGuest.participantId, "p-original-guest");
    const receiverCredentials = credentials(new Map(values));
    const destinationHub = native.createNextRoomUiHub({ ...common, storage: receiver,
      workspaceId: await receiver.workspaceId(), credentials: receiverCredentials,
      remoteRooms: { synchronizeHistory: true, async resolve() {
        return { workspaceId: await origin.workspaceId(), sourceFingerprint: legacyFingerprint,
          historyLineage: native.roomHistoryLineage(origin, legacyRoomId), activeUrl: hosted.url,
          state: originHub.adminRooms().some(value => value.roomId === legacyRoomId) ? "active" : "released" };
      } } });
    hubs.push(destinationHub); await destinationHub.start(0);
    const transferred = await destinationHub.takeOverFullRoom(legacyRoomId);
    const nextHost = await peer(transferred.url, transferred.hostToken);
    assert.equal(nextHost.participantId, "p-original-guest");
    const marker = dbRead(receiver, db => db.prepare("SELECT * FROM next_room_host_successions WHERE room_id=?").get(legacyRoomId));
    assert.equal(marker.original_host, "p-original-host"); assert.equal(marker.assigned_host, "p-original-guest");
    nextHost.disconnect(); await destinationHub.stop();
    const recoveries = [];
    let approveRecovery = false;
    const restarted = native.createNextRoomUiHub({ ...common, storage: receiver,
      workspaceId: await receiver.workspaceId(), credentials: receiverCredentials,
      async chooseReconnectPolicy() { return "host-approval"; },
      async approveParticipant(request) { recoveries.push(request); return approveRecovery; } });
    hubs.push(restarted); await restarted.start(0);
    dbRead(receiver, db => db.prepare("DELETE FROM next_room_host_successions WHERE room_id=?").run(legacyRoomId));
    await assert.rejects(restarted.rehostRoom(legacyRoomId), /host binding conflicts/);
    dbRead(receiver, db => db.prepare("INSERT INTO next_room_host_successions VALUES(?,?,?,?)")
      .run(marker.room_id, marker.source_fingerprint, marker.original_host, marker.assigned_host));
    const reopened = await restarted.rehostRoom(legacyRoomId);
    const deniedStatuses = [];
    const noHostProof = new OldClient(new Proxy({
      onStatus(status, detail) { deniedStatuses.push({ status, detail }); },
    }, { get: (target, key) => target[key] ?? (() => {}) })); clients.push(noHostProof);
    noHostProof.connect({ roomId: legacyRoomId, room: hosted.room, url: reopened.url, user: "Archived Guest",
      cid: "archived-guest-cid", token: hosted.secret });
    await until(() => deniedStatuses.some(value => value.detail === "The Room host identity requires its host proof."));
    assert.equal(noHostProof.isConnected, false); assert.equal(recoveries.length, 0);
    noHostProof.disconnect();
    const denied = new OldClient(new Proxy({}, { get: () => () => {} })); clients.push(denied);
    denied.connect({ roomId: legacyRoomId, room: hosted.room, url: reopened.url, user: "Archived Guest",
      cid: "archived-guest-cid", token: hosted.secret, hostToken: reopened.hostToken });
    await until(() => recoveries.length === 1);
    assert.equal(recoveries[0].participantId, "p-original-guest");
    denied.disconnect();
    approveRecovery = true;
    const restored = await peer(reopened.url, reopened.hostToken);
    assert.equal(restored.participantId, "p-original-guest");
    assert.equal(recoveries.length, 2, "The valid Host token cannot bypass strict old-client identity approval.");
    restored.disconnect();
    await until(() => {
      const active = restarted.adminRooms().find(value => value.roomId === legacyRoomId);
      return !active || active.members === 0;
    });
    const retryRoom = restarted.adminRooms().some(value => value.roomId === legacyRoomId)
      ? reopened : await restarted.rehostRoom(legacyRoomId);
    const retry = await peer(retryRoom.url, retryRoom.hostToken);
    assert.equal(retry.participantId, "p-original-guest");
    assert.equal(recoveries.length, 3, "Every fresh old-client recovery requires approval, including retries.");
    assert.equal(pinned(origin.workspaceRoot()), originalPin);
    assert.equal(pinned(receiver.workspaceRoot()), originalPin);
    retry.disconnect(); await restarted.stop();
  });
  let sourceAdmitted = true;
  const sourceHub = native.createNextRoomUiHub({ ...common, storage: source,
    assertAuthority() { if (!sourceAdmitted) throw new Error("Source fixture authority revoked."); },
    workspaceId: await source.workspaceId(), credentials: sourceCredentials });
  hubs.push(sourceHub); await sourceHub.start(0);
  const room = await sourceHub.createRoom("Full original reducer Room"), definition = native.inspectNativeRoom(source, room.roomId);
  const received = new Map();
  const connect = async (url, label, cid, hostToken, receivedFiles = received) => {
    const client = new OldClient(new Proxy({ onFileComplete(meta, from, bytes) { receivedFiles.set(meta.fileId, Buffer.from(bytes)); } },
      { get: (target, key) => target[key] ?? (() => {}) }));
    clients.push(client);
    client.connect({ roomId: room.roomId, room: room.room, url, user: label, cid, token: room.secret, hostToken });
    await until(() => client.isConnected && client.participantId); return client;
  };
  const author = await connect(room.url, "Original Host", "original-host", room.hostToken);
  const authorId = author.participantId;
  const guest = await connect(room.url, "Original Guest", "original-guest");
  const guestId = guest.participantId;
  const bytes = Buffer.from(Array.from({ length: 73000 }, (_, i) => i % 251));
  const offer = await author.sendFile("original-binary.bin", "application/octet-stream", bytes);
  assert.equal(offer.ok, true);
  await until(() => received.has(offer.file.fileId));
  assert.deepEqual(received.get(offer.file.fileId), bytes);
  await t.test("explicit saved-byte recovery does not invent, replace or cross-admit legacy file metadata", async () => {
    fs.writeFileSync(path.join(directory, "captured-original-client-bytes.bin"), received.get(offer.file.fileId), { mode: 0o600 });
    dbRead(source, db => {
      db.prepare("DELETE FROM legacy_room_runtime_chunks WHERE room_id=? AND file_id=?").run(room.roomId, offer.file.fileId);
      db.prepare("DELETE FROM legacy_room_runtime_files WHERE room_id=? AND file_id=?").run(room.roomId, offer.file.fileId);
    });
    const isolated = await open("metadata-only-destination");
    native.createNativeRoom(isolated, definition);
    const replica = native.createNextRoomUiHub({ ...common, storage: isolated,
      workspaceId: await isolated.workspaceId(), credentials: credentials(new Map(secrets)),
      remoteRooms: { synchronizeHistory: true, async resolve() {
        return { workspaceId: await source.workspaceId(), sourceFingerprint: definition.sourceFingerprint,
          activeUrl: room.url, state: "active" };
      } } });
    hubs.push(replica); await replica.start(0);
    await assert.rejects(replica.syncRemoteRoomHistory(room.roomId), /503/);
    assert.equal(dbRead(isolated, db => db.prepare("SELECT COUNT(*) AS n FROM next_room_history_receipts").get().n), 0);
    const body = JSON.stringify({ version: 2, destinationWorkspaceId: await isolated.workspaceId(),
      sourceFingerprint: definition.sourceFingerprint, lineage: definition.sourceFingerprint, offset: 0 });
    const proof = await sourceCredentials.createHostProof(room.roomId, `history-sync:${room.roomId}:${hash(body)}`);
    const response = await fetch(room.url.replace("ws:", "http:") + `/api/native-rooms/${room.roomId}/history`, {
      method: "POST", body, headers: { "X-PKM-Host-Timestamp": String(proof.timestamp),
        "X-PKM-Host-Nonce": proof.nonce, "X-PKM-Host-Proof": proof.signature } });
    assert.equal(response.status, 503); await response.body.cancel();
    assert.equal(dbRead(source, db => db.prepare("SELECT COUNT(*) AS n FROM next_room_full_history_exports").get().n), 0);
    assert.deepEqual((await sourceHub.missingFilePayloads(room.roomId)).map(file => file.fileId), [offer.file.fileId]);
    const other = await sourceHub.createRoom("Unrelated recovery Room");
    await assert.rejects(sourceHub.recoverFileBytes(other.roomId, offer.file.fileId, bytes.toString("base64")), /unique retained attachment/);
    await assert.rejects(sourceHub.recoverFileBytes(room.roomId, offer.file.fileId, bytes.subarray(1).toString("base64")), /size/);
    sourceAdmitted = false;
    try { await assert.rejects(async () => sourceHub.recoverFileBytes(room.roomId, offer.file.fileId, bytes.toString("base64")), /revoked/); }
    finally { sourceAdmitted = true; }
    const recovered = await sourceHub.recoverFileBytes(room.roomId, offer.file.fileId,
      fs.readFileSync(path.join(directory, "captured-original-client-bytes.bin")).toString("base64"));
    assert.equal(recovered.sha256, hash(bytes));
    await sourceHub.recoverFileBytes(room.roomId, offer.file.fileId, bytes.toString("base64"));
    await assert.rejects(sourceHub.recoverFileBytes(room.roomId, offer.file.fileId,
      Buffer.alloc(bytes.length).toString("base64")), /must not be overwritten/);
    dbRead(source, db => db.prepare("UPDATE legacy_room_runtime_files SET complete=0 WHERE room_id=? AND file_id=?")
      .run(room.roomId, offer.file.fileId));
    await assert.rejects(sourceHub.recoverFileBytes(room.roomId, offer.file.fileId, bytes.toString("base64")), /incomplete upload/);
    dbRead(source, db => db.prepare("UPDATE legacy_room_runtime_files SET complete=1 WHERE room_id=? AND file_id=?")
      .run(room.roomId, offer.file.fileId));
    await replica.syncRemoteFullRoomHistory(room.roomId);
    dbRead(isolated, db => {
      assert.equal(db.prepare("SELECT sha256 FROM next_room_file_recoveries WHERE room_id=? AND file_id=?")
        .get(room.roomId, offer.file.fileId).sha256, hash(bytes));
      assert.deepEqual(Buffer.from(db.prepare("SELECT data FROM legacy_room_runtime_files WHERE room_id=? AND file_id=?")
        .get(room.roomId, offer.file.fileId).data), bytes);
      assert.equal(db.prepare("SELECT COUNT(*) AS n FROM next_room_history_incoming WHERE room_id=?").get(room.roomId).n, 1);
    });
    await replica.stop();
  });
  const meeting = await sourceHub.meetingStore.startMeeting({ roomId: room.roomId, roomName: room.room,
    title: "Original reducer Meeting", problemStatement: "Keep manual bytes", owner: "Original Host",
    lead: "Original Host", recorder: "Original Host", participants: ["Original Host", "Original Guest"],
    host: "Original Host", triggerMessageId: "discuss-trigger", requestId: randomUUID(), expectedRevision: 0 });
  await sourceHub.meetingStore.adjournMeeting({ roomId: room.roomId, meetingId: meeting.id,
    actor: "Original Host", requestId: randomUUID(), expectedRevision: meeting.revision });
  const manual = "Original manual bytes\r\n保留字节和空格。 \r\n";
  const legacyRoot = path.join(directory, "original-meeting-producer");
  const legacyNotes = path.join(legacyRoot, "notes");
  const originalStore = new OriginalMeetingStateStore(path.join(legacyRoot, "chatrooms"), legacyNotes);
  const originalMeeting = await originalStore.startMeeting({ roomId: room.roomId, roomName: room.room,
    title: "Original reducer Meeting", problemStatement: "Keep manual bytes", owner: "Original Host",
    lead: "Original Host", recorder: "Original Host", participants: ["Original Host", "Original Guest"],
    host: "Original Host", triggerMessageId: "discuss-trigger", requestId: randomUUID(), expectedRevision: 0 });
  await originalStore.adjournMeeting({ roomId: room.roomId, meetingId: originalMeeting.id,
    actor: "Original Host", requestId: randomUUID(), expectedRevision: originalMeeting.revision });
  const originalNotePaths = fs.readdirSync(legacyNotes, { recursive: true }).filter(file => file.endsWith(".md"));
  assert.equal(originalNotePaths.length, 1);
  const originalNote = path.join(legacyNotes, originalNotePaths[0]);
  fs.writeFileSync(originalNote, manual);
  const originalCanonical = path.join(legacyRoot, "chatrooms", room.roomId, "meetings", "canonical.json");
  const originalPins = [originalCanonical, originalNote].map(file => [file, hash(fs.readFileSync(file))]);
  assert.equal(originalStore.snapshot(room.roomId).history[0].status,
    sourceHub.meetingStore.snapshot(room.roomId).history[0].status);
  const reviewedNote = await sourceHub.meetingStore.readNote(room.roomId, meeting.id);
  await sourceHub.meetingStore.writeNote(room.roomId, meeting.id, fs.readFileSync(originalNote, "utf8"), reviewedNote.sha256);
  await t.test("owned Note saves reject stale reviewed content without overwriting manual bytes", async () => {
    await assert.rejects(sourceHub.meetingStore.writeNote(room.roomId, meeting.id, "stale overwrite", reviewedNote.sha256), /changed since/);
    const current = await sourceHub.meetingStore.readNote(room.roomId, meeting.id);
    sourceAdmitted = false;
    try { await assert.rejects(async () => sourceHub.meetingStore.writeNote(room.roomId, meeting.id, "revoked overwrite", current.sha256), /revoked/); }
    finally { sourceAdmitted = true; }
    assert.equal((await sourceHub.meetingStore.readNote(room.roomId, meeting.id)).content, manual);
  });
  const foreign = await sourceHub.createRoom("Other private Room");
  const privateMeeting = await sourceHub.meetingStore.startMeeting({ roomId: foreign.roomId, roomName: foreign.room,
    title: "Other Room private", problemStatement: "NEVER-EXPORT-OTHER-ROOM", owner: "Owner", lead: "Owner",
    recorder: "Owner", participants: ["Owner"], host: "Owner", triggerMessageId: "private-trigger",
    requestId: randomUUID(), expectedRevision: 0 });
  native.createNativeRoom(destination, definition);
  const destinationCredentials = credentials(new Map(secrets));
  const makeDestination = async () => {
    const hub = native.createNextRoomUiHub({ ...common, storage: destination,
      workspaceId: await destination.workspaceId(), credentials: destinationCredentials,
      remoteRooms: { synchronizeHistory: true, async resolve() {
        return { workspaceId: await source.workspaceId(), sourceFingerprint: definition.sourceFingerprint,
          activeUrl: room.url, state: sourceHub.adminRooms().some(value => value.roomId === room.roomId) ? "active" : "released" };
      } } });
    hubs.push(hub); await hub.start(0); return hub;
  };
  const destinationHub = await makeDestination();
  dbRead(source, db => {
    const assets = new native.NextRoomHistoryAssets(db, () => {});
    const current = JSON.parse(db.prepare("SELECT state_json FROM legacy_room_runtime_rooms WHERE room_id=?").get(room.roomId).state_json);
    assets.validate(room.roomId, assets.snapshot(room.roomId), current);
    assert(current.messages.some(message => message.messageType === "file"));
  });
  await destinationHub.syncRemoteFullRoomHistory(room.roomId);
  assert.equal((await destinationHub.meetingStore.readNote(room.roomId, meeting.id)).content, manual);
  assert.equal(dbRead(destination, db => db.prepare("SELECT COUNT(*) AS n FROM next_room_meetings WHERE room_id=?").get(foreign.roomId).n), 0);
  assert(!dbRead(destination, db => db.prepare("SELECT body FROM next_room_meeting_notes").all()).some(row => row.body.includes("NEVER-EXPORT-OTHER-ROOM")));
  await t.test("join-secret-only proof cannot export private canonical/manual/binary assets", async () => {
    const body = JSON.stringify({ version: 2, destinationWorkspaceId: await destination.workspaceId(),
      sourceFingerprint: definition.sourceFingerprint, lineage: definition.sourceFingerprint, offset: 0 });
    const proof = await credentials(new Map([...secrets].map(([key]) => [key, room.secret])))
      .createHostProof(room.roomId, `history-sync:${room.roomId}:${hash(body)}`);
    const response = await fetch(room.url.replace("ws:", "http:") + `/api/native-rooms/${room.roomId}/history`, {
      method: "POST", body,
      headers: { "X-PKM-Host-Timestamp": String(proof.timestamp), "X-PKM-Host-Nonce": proof.nonce, "X-PKM-Host-Proof": proof.signature } });
    assert.equal(response.status, 403); assert(!(await response.text()).includes(manual));
  });
  await t.test("full transfer does not replace the default transcript-only Force Close", async () => {
    await assert.rejects(destinationHub.forceCloseRemoteRoom(room.roomId), /unsynchronized|Meeting\/Note transfer/);
    assert(sourceHub.adminRooms().some(value => value.roomId === room.roomId));
    assert.equal(dbRead(destination, db => db.prepare("SELECT COUNT(*) AS n FROM next_room_history_receipts").get().n), 0);
  });
  const takeover = await destinationHub.takeOverFullRoom(room.roomId);
  assert(!sourceHub.adminRooms().some(value => value.roomId === room.roomId));
  const replayed = new Map();
  const receiver = await connect(takeover.url, "Original Guest", "original-guest", undefined, replayed);
  assert.equal(receiver.participantId, guestId);
  const receiverGuestId = receiver.participantId;
  await until(() => replayed.has(offer.file.fileId));
  assert.deepEqual(replayed.get(offer.file.fileId), bytes);
  receiver.disconnect(); await wait(100);
  const hostingReceiver = await connect(takeover.url, "Original Guest", "original-guest", takeover.hostToken, new Map());
  assert.equal(hostingReceiver.participantId, guestId, "An explicitly authorized Host join must retain this receiver's historical identity.");
  dbRead(destination, db => {
    const succession = db.prepare("SELECT original_host,assigned_host FROM next_room_host_successions WHERE room_id=?").get(room.roomId);
    assert.equal(succession.original_host, authorId);
    assert.equal(succession.assigned_host, guestId);
  });
  assert.equal((await destinationHub.meetingStore.readNote(room.roomId, meeting.id)).content, manual);
  const imported = destinationHub.meetingStore.snapshot(room.roomId).history.find(value => value.id === meeting.id);
  const trashed = await destinationHub.meetingStore.moveToTrash({ roomId: room.roomId, meetingId: meeting.id,
    actor: "Original Host", requestId: randomUUID(), expectedRevision: imported.revision });
  await destinationHub.meetingStore.restoreFromTrash({ roomId: room.roomId, meetingId: meeting.id,
    actor: "Original Host", requestId: randomUUID(), expectedRevision: trashed.revision });
  assert.equal((await destinationHub.meetingStore.readNote(room.roomId, meeting.id)).content, manual);
  const destinationManualSha256 = hash((await destinationHub.meetingStore.readNote(room.roomId, meeting.id)).content);
  assert(sourceHub.meetingStore.snapshot(foreign.roomId).current.id === privateMeeting.id);
  await t.test("explicit receiver Host identity and manual bytes survive a new local runtime", async () => {
    hostingReceiver.disconnect();
    await destinationHub.stop();
    const restarted = native.createNextRoomUiHub({ ...common, storage: destination,
      workspaceId: await destination.workspaceId(), credentials: destinationCredentials });
    hubs.push(restarted); await restarted.start(0);
    dbRead(destination, db => db.prepare("UPDATE next_room_host_successions SET assigned_host=? WHERE room_id=?").run(authorId, room.roomId));
    await assert.rejects(restarted.rehostRoom(room.roomId), /succession no longer matches/);
    assert.equal((await restarted.meetingStore.readNote(room.roomId, meeting.id)).content, manual);
    dbRead(destination, db => db.prepare("UPDATE next_room_host_successions SET assigned_host=? WHERE room_id=?").run(guestId, room.roomId));
    const restored = await restarted.rehostRoom(room.roomId);
    const actual = await connect(restored.url, "Original Guest", "original-guest", restored.hostToken, new Map());
    assert.equal(actual.participantId, guestId);
    assert.equal((await restarted.meetingStore.readNote(room.roomId, meeting.id)).content, manual);
    await restarted.stop();
  });
  await t.test("deleting an owned native Room removes transferred Note provenance without touching the other root", async () => {
    await destinationHub.stop();
    await destinationHub.deleteStoredRoom(room.roomId);
    dbRead(destination, db => {
      for (const table of ["next_room_meeting_notes", "next_room_meeting_imported_notes", "next_room_meeting_manual_notes",
        "next_room_meeting_transferred_sources", "next_room_full_history_receipts", "next_room_host_successions"])
        assert.equal(db.prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE room_id=?`).get(room.roomId).n, 0);
    });
    assert.equal((await sourceHub.meetingStore.readNote(room.roomId, meeting.id)).content, manual);
    assert(sourceHub.meetingStore.snapshot(foreign.roomId).current.id === privateMeeting.id);
  });
  for (const [file, expected] of originalPins) assert.equal(hash(fs.readFileSync(file)), expected);
  fs.writeFileSync(path.join(directory, "native-observations.json"), JSON.stringify({
    scope: "Source network fixture, not an installed UI or old filesystem-archive admission.",
    roomId: room.roomId, sourceGuestId: guestId, receiverGuestId,
    guestIdentityOrigin: "Native source Hub using the unchanged 4.0.22 client",
    fileBytes: replayed.get(offer.file.fileId).length,
    replayedFileSha256: hash(replayed.get(offer.file.fileId)), destinationManualSha256,
    originalProducerPins: originalPins.map(([file, sha256]) => ({ path: path.relative(directory, file), sha256 })),
    installedQualified: false, actualUiQualified: false,
  }, null, 2), { mode: 0o600 });
});
