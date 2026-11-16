import assert from "node:assert/strict";
import { after, test } from "node:test";
import { createRequire } from "node:module";
import { execFileSync } from "node:child_process";
import { createHash, createHmac, randomBytes, randomUUID } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { pathToFileURL } from "node:url";

const require = createRequire(import.meta.url);
const project = path.resolve(new URL("..", import.meta.url).pathname);
const directories = [];
after(() => { for (const directory of directories) fs.rmSync(directory, { recursive: true, force: true }); });
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(check) {
  const end = Date.now() + 8000;
  while (Date.now() < end) { if (await check()) return; await wait(25); }
  throw new Error("Remote Room release was not confirmed.");
}
test("original Host proof closes only a credentialed admitted Room on the selected remote owner", async t => {
  const directory = path.join(project, ".migration-test-work", `room-remote-close-${randomUUID()}`);
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  directories.push(directory);
  fs.writeFileSync(path.join(directory, "package.json"), '{"type":"module"}');
  fs.symlinkSync(path.join(project, "legacy/node_modules"), path.join(directory, "node_modules"), "dir");
  const esbuild = require("esbuild");
  const build = (name, text) => esbuild.buildSync({ stdin: { contents: text, resolveDir: project },
    bundle: true, platform: "node", format: name.endsWith(".cjs") ? "cjs" : "esm",
    packages: "external", outfile: path.join(directory, name), logLevel: "silent" });
  build("native.mjs", `
    export {initialize,Storage} from "./src/storage";
    export {createNativeRoom,inspectNativeRoom} from "./src/native-chatroom-identity";
    export {createNextRoomUiHub} from "./src/next-room-ui-hub";`);
  build("storage-worker.js", 'import "./src/storage-worker";');
  build("retained.cjs", `
    export {ChatHub} from "./legacy/src/chatroom/chatroom-hub";
    export {ChatJoinApprovalManager} from "./legacy/src/chatroom/chat-join-approval";
    export {WebSocketServer} from "ws";`);
  const archive = process.env.PKM_LEGACY_VSIX || path.join(project, "legacy/personal-knowledge-4.0.22.vsix");
  assert(fs.existsSync(archive), "Set PKM_LEGACY_VSIX to the authorized original 4.0.22 VSIX (SHA-256 1804071cb3b9fc86edc5933d5001db6ea1a8d7a9adf30d6d2b3166fcd6048f27).");
  assert.equal(createHash("sha256").update(fs.readFileSync(archive)).digest("hex"),
    "1804071cb3b9fc86edc5933d5001db6ea1a8d7a9adf30d6d2b3166fcd6048f27");
  const original = path.join(directory, "original");
  fs.mkdirSync(original);
  fs.writeFileSync(path.join(original, "package.json"), '{"type":"commonjs"}');
  for (const name of ["chat-room-credentials", "chatroom-client", "chatroom-protocol", "peer-protocol"])
    fs.writeFileSync(path.join(original, `${name}.js`), execFileSync("unzip", ["-p", archive, `extension/dist/chatroom/${name}.js`]));
  const Credentials = require(path.join(original, "chat-room-credentials.js")).ChatRoomCredentialStore;
  const OldClient = require(path.join(original, "chatroom-client.js")).ChatClient;
  const native = await import(pathToFileURL(path.join(directory, "native.mjs")));
  const retained = require(path.join(directory, "retained.cjs"));
  const stores = [], hubs = [], clients = [];
  let receiverLive = true;
  t.after(async () => {
    for (const client of clients) { try { client.disconnect(); } catch {} }
    for (const hub of hubs) await hub.stop().catch(() => {});
    for (const storage of stores) await storage.close();
  });
  const root = path.join(directory, "receiver");
  await native.initialize(root);
  const storage = await native.Storage.open(root, { deferRecovery: true }); stores.push(storage);
  const values = new Map();
  const credentials = new Credentials({ async get(key) { return values.get(key); },
    async store(key, value) { values.set(key, value); }, async delete(key) { values.delete(key); } });
  const receiver = native.createNextRoomUiHub({ storage, workspaceId: await storage.workspaceId(), credentials, retained,
    qualification: "new-next-workspace", assertAuthority() { if (!receiverLive) throw new Error("Receiver owner revoked."); },
    async chooseReconnectPolicy() { return "legacy-client-id"; }, async approveParticipant() { return false; } });
  hubs.push(receiver);
  await receiver.start(0);
  const room = await receiver.createRoom("Remote original Host proof");
  const other = await receiver.createRoom("Unrelated private Room");
  const url = `http://127.0.0.1:${receiver.port}/api/rooms/${room.roomId}/close`;
  const post = proof => fetch(url, { method: "POST", headers: {
    "X-PKM-Host-Timestamp": String(proof.timestamp), "X-PKM-Host-Nonce": proof.nonce, "X-PKM-Host-Proof": proof.signature,
  } });
  const connection = new OldClient(new Proxy({}, { get: () => () => {} }));
  clients.push(connection);
  connection.connect({ url: `ws://127.0.0.1:${receiver.port}`, room: room.room, roomId: room.roomId,
    user: "Original private Host", token: room.secret, hostToken: room.hostToken, cid: "original-private-host" });
  await until(() => connection.isConnected && connection.participantId);
  const recipient = new OldClient(new Proxy({}, { get: () => () => {} }));
  clients.push(recipient);
  recipient.connect({ url: `ws://127.0.0.1:${receiver.port}`, room: room.room, roomId: room.roomId,
    user: "Private remote guest", token: room.secret, cid: "private-remote-guest" });
  await until(() => recipient.isConnected && recipient.participantId);
  const source = native.inspectNativeRoom(storage, room.roomId);
  assert.equal(connection.sendText("Private retained remote-close history", undefined, undefined, undefined, ["Private remote guest"]), true);
  const messages = () => {
    const db = storage.connectNative();
    try { return JSON.parse(db.prepare("SELECT state_json FROM legacy_room_runtime_rooms WHERE room_id=?").get(room.roomId).state_json).messages; }
    finally { db.close(); }
  };
  await until(() => messages().some(message => message.content === "Private retained remote-close history"));
  await t.test("join-secret forgery, wrong purpose and expired proof cannot close either Room", async () => {
    const nonce = randomBytes(16).toString("base64url"), timestamp = Date.now();
    const forgery = { nonce, timestamp, signature: createHmac("sha256", room.secret)
      .update(`force-close:${room.roomId}\n${timestamp}\n${nonce}`).digest("base64url") };
    assert.equal((await post(forgery)).status, 401);
    assert.equal((await post(await credentials.createHostProof(room.roomId, `force-close:${other.roomId}`))).status, 401);
    const expired = await credentials.createHostProof(room.roomId, `force-close:${room.roomId}`);
    expired.timestamp -= 31_000;
    assert.equal((await post(expired)).status, 401);
    assert.equal(receiver.adminRooms().length, 2);
  });
  await t.test("old Host proof returns accepted, disconnects its old client, preserves identity and cannot replay", async () => {
    const proof = await credentials.createHostProof(room.roomId, `force-close:${room.roomId}`);
    assert.equal((await post(proof)).status, 202);
    await until(() => !connection.isConnected && !recipient.isConnected && receiver.adminRooms().length === 1);
    assert.equal((await post(proof)).status, 409);
    assert.deepEqual(native.inspectNativeRoom(storage, room.roomId), source);
    assert(messages().some(message => message.content === "Private retained remote-close history"));
    const reopened = await receiver.rehostRoom(room.roomId);
    assert.equal(reopened.roomId, room.roomId);
    assert(messages().some(message => message.content === "Private retained remote-close history"));
    assert.equal((await post(proof)).status, 409, "A rehost must not reset nonce admission.");
  });
  const senderRoot = path.join(directory, "sender");
  await native.initialize(senderRoot);
  const senderStorage = await native.Storage.open(senderRoot, { deferRecovery: true }); stores.push(senderStorage);
  native.createNativeRoom(senderStorage, source);
  const senderValues = new Map(values);
  const senderCredentials = new Credentials({ async get(key) { return senderValues.get(key); },
    async store(key, value) { senderValues.set(key, value); }, async delete(key) { senderValues.delete(key); } });
  let missing = false;
  const descriptor = { activeUrl: `ws://127.0.0.1:${receiver.port}`, workspaceId: await storage.workspaceId(),
    sourceFingerprint: source.sourceFingerprint };
  const sender = native.createNextRoomUiHub({ storage: senderStorage, workspaceId: await senderStorage.workspaceId(),
    credentials: senderCredentials, retained, qualification: "new-next-workspace", assertAuthority() {},
    async chooseReconnectPolicy() { return "legacy-client-id"; }, async approveParticipant() { return false; },
    remoteRooms: { async resolve() {
      if (missing) return undefined;
      const db = storage.connectNative();
      try {
        const record = db.prepare("SELECT state_json FROM legacy_room_runtime_rooms WHERE room_id=?").get(room.roomId);
        return { ...descriptor, state: JSON.parse(record.state_json).state === "stored" ? "released" : "active" };
      } finally { db.close(); }
    } } });
  hubs.push(sender);
  await t.test("selected sender exposes the old Force Close action and waits for confirmed release", async () => {
    const stored = (await sender.listStoredRooms())[0];
    assert.equal(stored.activeElsewhere, true); assert.equal(stored.canForceClose, true); assert.equal(stored.canRehost, false);
    await sender.forceCloseRemoteRoom(room.roomId);
    assert.equal((await sender.listStoredRooms())[0].canRehost, true);
    await sender.start(0);
    assert.equal((await sender.rehostRoom(room.roomId)).roomId, room.roomId);
    assert(receiver.adminRooms().some(entry => entry.roomId === other.roomId));
  });
  await t.test("missing remote observation is not a confirmed release", async () => {
    await sender.adminCloseRoom(room.roomId);
    await receiver.rehostRoom(room.roomId);
    const createProof = senderCredentials.createHostProof.bind(senderCredentials);
    senderCredentials.createHostProof = async (...args) => { const proof = await createProof(...args); missing = true; return proof; };
    try { await assert.rejects(sender.forceCloseRemoteRoom(room.roomId), /changed|unavailable|unconfirmed/); }
    finally { missing = false; senderCredentials.createHostProof = createProof; }
    assert(receiver.adminRooms().some(entry => entry.roomId === room.roomId));
    missing = true;
    try {
      assert.equal((await sender.listStoredRooms())[0].canRehost, false);
      await assert.rejects(sender.rehostRoom(room.roomId), /unavailable/);
    } finally { missing = false; }
  });
  await t.test("receiver owner revocation denies a valid original Host proof", async () => {
    const proof = await credentials.createHostProof(room.roomId, `force-close:${room.roomId}`);
    receiverLive = false;
    const response = await post(proof).catch(() => undefined);
    assert(response === undefined || response.status >= 400);
  });
});
