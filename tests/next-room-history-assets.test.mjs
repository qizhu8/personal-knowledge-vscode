import assert from "node:assert/strict";
import { test } from "node:test";
import { createRequire } from "node:module";
import { createHash, createHmac, randomUUID, randomBytes } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { createServer } from "node:http";
import * as fs from "node:fs";
import * as path from "node:path";
import { pathToFileURL } from "node:url";

const project = path.resolve(new URL("../legacy", import.meta.url).pathname);
const require = createRequire(import.meta.url), hash = value => createHash("sha256").update(value).digest("hex");
test("full Room checkpoint atomically preserves canonical Meeting, manual Note and binary file bytes", async t => {
  const directory = path.join(project, ".migration-test-work", `room-full-assets-${randomUUID()}`);
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  fs.writeFileSync(path.join(directory, "package.json"), '{"type":"module"}');
  fs.symlinkSync(path.join(project, "../node_modules"), path.join(directory, "node_modules"), "dir");
  require("esbuild").buildSync({ stdin: { contents: `
    export {NextRoomHistorySync} from "./next-server/src/next-room-history-sync";
    export {NextRoomHistoryAssets} from "./next-server/src/next-room-history-assets";`, resolveDir: project },
    bundle: true, platform: "node", format: "esm", packages: "external",
    outfile: path.join(directory, "assets.mjs"), logLevel: "silent" });
  const { NextRoomHistorySync, NextRoomHistoryAssets } = await import(pathToFileURL(path.join(directory, "assets.mjs")));
  const roomId = randomUUID(), workspaceId = randomUUID(), participantId = randomUUID(), fileId = "binary-file";
  const metadata = JSON.stringify({ fileId, name: "original.bin", size: 40000, mime: "application/octet-stream" });
  const bytes = Buffer.from(Array.from({ length: 40000 }, (_, i) => i % 256));
  const note = "Original manual Note.\r\n字节必须保留。 \r\n";
  const meeting = { id: randomUUID(), roomId, status: "adjourned", revision: 2, startedAt: new Date().toISOString(),
    markdownPath: "Chatroom Meetings/original.md", topics: [], events: [] };
  const state = { roomId, roomName: "Full original Room", state: "stored", updatedAt: Date.now(), messages: [],
    identity: { memberships: [{ participantId, kind: "human", role: "host", temporary: false,
      createdAt: Date.now(), updatedAt: Date.now() }], aliases: [], pendingJoins: [] } };
  state.messages.push({ id: "file-offer", participantId, senderKind: "human", messageType: "file", content: "shared file",
    aliasAtSend: "Original Host", createdAt: Date.now(), metadata: { file: JSON.parse(metadata) } });
  const databases = [], open = () => {
    const db = new DatabaseSync(":memory:"); databases.push(db);
    db.exec(`CREATE TABLE legacy_room_runtime_rooms(room_id TEXT PRIMARY KEY,source_fingerprint TEXT,state_json TEXT);
      CREATE TABLE legacy_room_runtime_files(room_id TEXT,file_id TEXT,owner_id TEXT,metadata_json TEXT,complete INTEGER,sha256 TEXT,data BLOB,PRIMARY KEY(room_id,file_id));
      CREATE TABLE legacy_room_runtime_chunks(room_id TEXT,file_id TEXT,sequence INTEGER,data BLOB,sha256 TEXT);
      CREATE TABLE next_room_meetings(room_id TEXT PRIMARY KEY,state_json TEXT,source_canonical TEXT,source_hash TEXT,source_notes_json TEXT);
      CREATE TABLE next_room_meeting_notes(room_id TEXT,meeting_id TEXT,note_path TEXT UNIQUE,body TEXT,visible INTEGER,PRIMARY KEY(room_id,meeting_id));`);
    db.prepare("INSERT INTO legacy_room_runtime_rooms VALUES(?,?,?)").run(roomId, "b".repeat(64),
      JSON.stringify({ ...state, messages: [], identity: { memberships: [], aliases: [], pendingJoins: [] } }));
    db.prepare("INSERT INTO next_room_meetings VALUES(?,?,NULL,?,?)")
      .run(roomId, '{"schema":1,"meetings":[]}', hash("absent"), "[]");
    return db;
  };
  const source = open(), destination = open();
  source.prepare("UPDATE legacy_room_runtime_rooms SET state_json=?").run(JSON.stringify(state));
  source.prepare("UPDATE next_room_meetings SET state_json=?").run(JSON.stringify({ schema: 1, meetings: [meeting] }));
  const originalCanonical = JSON.stringify({ schema: 1, meetings: [meeting] }, null, 2).replaceAll("\n", "\r\n") + "\r\n";
  const originalNotes = JSON.stringify([{ id: meeting.id, path: meeting.markdownPath, body: note }], null, 2) + "\n";
  source.prepare("UPDATE next_room_meetings SET source_canonical=?,source_notes_json=?").run(originalCanonical, originalNotes);
  source.prepare("INSERT INTO next_room_meeting_notes VALUES(?,?,?,?,1)").run(roomId, meeting.id, meeting.markdownPath, note);
  source.prepare("INSERT INTO legacy_room_runtime_files VALUES(?,?,?,?,1,?,?)").run(roomId, fileId, participantId, metadata, hash(bytes), bytes);
  const secret = randomBytes(32), sign = purpose => ({ timestamp: Date.now(), nonce: randomBytes(18).toString("base64url"),
    signature: createHmac("sha256", secret).update(purpose).digest("base64url") });
  const verify = (purpose, proof) => proof.signature === sign(purpose).signature;
  let revoked = false, interrupted = true;
  const exporter = new NextRoomHistorySync(source, () => {}, new NextRoomHistoryAssets(source, () => {}));
  let selectedExporter = exporter;
  const server = createServer((request, response) => {
    if (interrupted && source.prepare("SELECT COUNT(*) AS n FROM next_room_full_history_nonces").get().n > 0) {
      response.destroy(); return;
    }
    selectedExporter.serve(request, response, roomId, { workspaceId, authorize: async (purpose, proof) => verify(purpose, proof),
      createProof: async purpose => sign(purpose), snapshot: async () => ({
        sourceFingerprint: "a".repeat(64), lineage: "c".repeat(64), state }) })
      .catch(() => { if (!response.headersSent) response.writeHead(503); response.end(); });
  });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); for (const db of databases) db.close(); });
  const assertLive = () => { if (revoked) throw new Error("Owner revoked."); };
  const importer = new NextRoomHistorySync(destination, assertLive, new NextRoomHistoryAssets(destination, assertLive));
  const options = { binding: { roomId, workspaceId, sourceFingerprint: "a".repeat(64), lineage: "c".repeat(64),
    activeUrl: `ws://127.0.0.1:${server.address().port}` }, destinationWorkspaceId: randomUUID(),
    destinationSourceFingerprint: "b".repeat(64), authorize: async () => assertLive(),
    createProof: async purpose => sign(purpose), verifyProof: async (purpose, proof) => verify(purpose, proof) };
  await t.test("partial checkpoint never publishes any Meeting or attachment", async () => {
    await assert.rejects(importer.pull(options), /fetch failed|socket/);
    assert(destination.prepare("SELECT length(data) AS bytes FROM next_room_full_history_incoming").get().bytes > 0);
    assert.equal(destination.prepare("SELECT COUNT(*) AS n FROM next_room_meeting_notes").get().n, 0);
    assert.equal(destination.prepare("SELECT COUNT(*) AS n FROM legacy_room_runtime_files").get().n, 0);
    revoked = true; await assert.rejects(importer.pull(options), /revoked/); revoked = false;
  });
  interrupted = false;
  await importer.pull(options);
  assert.equal(destination.prepare("SELECT state_json FROM next_room_meetings").get().state_json,
    source.prepare("SELECT state_json FROM next_room_meetings").get().state_json);
  assert.equal(destination.prepare("SELECT body FROM next_room_meeting_notes").get().body, note);
  assert.deepEqual(Buffer.from(destination.prepare("SELECT data FROM legacy_room_runtime_files").get().data), bytes);
  assert.deepEqual(Buffer.concat(destination.prepare("SELECT data FROM legacy_room_runtime_chunks ORDER BY sequence")
    .all().map(row => Buffer.from(row.data))), bytes);
  await t.test("original canonical bytes survive another export without replacing local admission provenance", async () => {
    const replica = new NextRoomHistoryAssets(destination, () => {});
    assert.equal(replica.snapshot(roomId).meetings.sourceCanonical, originalCanonical);
    assert.equal(replica.snapshot(roomId).meetings.sourceNotes, originalNotes);
    assert.equal(destination.prepare("SELECT source_canonical FROM next_room_meetings").get().source_canonical, null);
    destination.prepare("UPDATE next_room_meeting_transferred_sources SET source_canonical=?").run(originalCanonical + " ");
    await assert.rejects(importer.pull(options), /branch changed/);
    assert.equal(destination.prepare("SELECT COUNT(*) AS n FROM next_room_full_history_incoming").get().n, 0);
    destination.prepare("UPDATE next_room_meeting_transferred_sources SET source_canonical=?").run(originalCanonical);
    await importer.pull(options);
  });
  await t.test("another Room's private Note path blocks publication without deleting either branch", async () => {
    const isolated = open(), otherRoom = randomUUID();
    isolated.prepare("INSERT INTO next_room_meeting_notes VALUES(?,?,?,?,1)")
      .run(otherRoom, randomUUID(), meeting.markdownPath, "Other Room private bytes");
    const replica = new NextRoomHistorySync(isolated, () => {}, new NextRoomHistoryAssets(isolated, () => {}));
    await assert.rejects(replica.pull({ ...options, destinationWorkspaceId: randomUUID() }), /UNIQUE constraint/);
    assert.equal(isolated.prepare("SELECT body FROM next_room_meeting_notes WHERE room_id=?").get(otherRoom).body, "Other Room private bytes");
    assert.equal(isolated.prepare("SELECT state_json FROM next_room_meetings WHERE room_id=?").get(roomId).state_json, '{"schema":1,"meetings":[]}');
    assert.equal(isolated.prepare("SELECT COUNT(*) AS n FROM legacy_room_runtime_files").get().n, 0);
  });
  await t.test("a valid Host cannot replace an already transferred immutable file ID", async () => {
    const isolated = open(), replica = new NextRoomHistorySync(isolated, () => {}, new NextRoomHistoryAssets(isolated, () => {}));
    await replica.pull({ ...options, destinationWorkspaceId: randomUUID() });
    const altered = Buffer.alloc(bytes.length);
    source.prepare("UPDATE legacy_room_runtime_files SET sha256=?,data=?").run(hash(altered), altered);
    try {
      await assert.rejects(replica.pull(options), /immutable/);
      assert.deepEqual(Buffer.from(isolated.prepare("SELECT data FROM legacy_room_runtime_files").get().data), bytes);
      assert.equal(isolated.prepare("SELECT body FROM next_room_meeting_notes").get().body, note);
    } finally { source.prepare("UPDATE legacy_room_runtime_files SET sha256=?,data=?").run(hash(bytes), bytes); }
  });
  await t.test("saved-byte provenance must retain the actual digest", () => {
    source.exec("CREATE TABLE next_room_file_recoveries(room_id TEXT,file_id TEXT,sha256 TEXT,PRIMARY KEY(room_id,file_id))");
    source.prepare("INSERT INTO next_room_file_recoveries VALUES(?,?,?)").run(roomId, fileId, hash("not these bytes"));
    try { assert.throws(() => new NextRoomHistoryAssets(source, () => {}).snapshot(roomId), /provenance conflicts/); }
    finally { source.prepare("DELETE FROM next_room_file_recoveries WHERE room_id=? AND file_id=?").run(roomId, fileId); }
  });
  await t.test("consumed v1 Host proofs cannot replay across the explicit full-history namespace", async () => {
    const body = JSON.stringify({ version: 1, destinationWorkspaceId: options.destinationWorkspaceId,
      sourceFingerprint: options.binding.sourceFingerprint, lineage: options.binding.lineage, offset: 0 });
    const proof = sign(`history-sync:${roomId}:${hash(body)}`);
    const request = () => fetch(options.binding.activeUrl.replace("ws:", "http:") + `/api/native-rooms/${roomId}/history`,
      { method: "POST", body, headers: { "X-PKM-Host-Timestamp": String(proof.timestamp),
        "X-PKM-Host-Nonce": proof.nonce, "X-PKM-Host-Proof": proof.signature } });
    selectedExporter = new NextRoomHistorySync(source, () => {});
    try {
      const original = await request(); assert.equal(original.status, 503); await original.body.cancel();
      assert(source.prepare("SELECT 1 FROM next_room_history_nonces WHERE room_id=? AND nonce=?").get(roomId, proof.nonce));
      selectedExporter = exporter;
      const replay = await request(); assert.equal(replay.status, 503); await replay.body.cancel();
      assert.equal(source.prepare("SELECT 1 FROM next_room_full_history_nonces WHERE room_id=? AND nonce=?").get(roomId, proof.nonce), undefined);
    } finally { selectedExporter = exporter; }
  });
  await t.test("foreign Room, corrupt bytes and local manual edits cannot be overwritten", async () => {
    const assets = new NextRoomHistoryAssets(source, () => {}), snapshot = assets.snapshot(roomId);
    snapshot.files[0].data = Buffer.alloc(bytes.length).toString("base64");
    assert.throws(() => assets.validate(roomId, snapshot, state), /digest/);
    const cross = assets.snapshot(roomId); cross.meetings.state = JSON.stringify({ schema: 1, meetings: [{ ...meeting, roomId: randomUUID() }] });
    assert.throws(() => assets.validate(roomId, cross, state), /cross-Room/);
    const unauthorizedDb = open();
    const unauthorizedImporter = new NextRoomHistorySync(unauthorizedDb, () => {}, new NextRoomHistoryAssets(unauthorizedDb, () => {}));
    const unauthorized = { ...options, destinationWorkspaceId: randomUUID(),
      createProof: async purpose => ({ ...sign(purpose), signature: "A".repeat(43) }) };
    await assert.rejects(unauthorizedImporter.pull(unauthorized), /403/);
    assert.equal(unauthorizedDb.prepare("SELECT COUNT(*) AS n FROM next_room_meeting_notes").get().n, 0);
    destination.prepare("UPDATE next_room_meeting_notes SET body=?").run("Local private edit");
    await assert.rejects(importer.pull(options), /branch changed/);
    assert.equal(destination.prepare("SELECT body FROM next_room_meeting_notes").get().body, "Local private edit");
    assert.equal(source.prepare("SELECT body FROM next_room_meeting_notes").get().body, note);
  });
});
