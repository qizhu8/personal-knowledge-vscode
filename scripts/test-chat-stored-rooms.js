#!/usr/bin/env node
const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { ChatRoomLifecycle } = require("../dist/chat-room-lifecycle");

class MemorySecretStorage {
  constructor(values = new Map()) { this.values = values; }
  async get(key) { return this.values.get(key); }
  async store(key, value) { this.values.set(key, value); }
  async delete(key) { this.values.delete(key); }
}

function message(id, content, createdAt) {
  return {
    id,
    participantId: "participant-1",
    aliasAtSend: "Host",
    senderKind: "human",
    messageType: "chat",
    content,
    createdAt,
  };
}

async function main() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pkm-stored-rooms-test-"));
  const sharedSecrets = new Map();
  const ownerSecrets = new MemorySecretStorage(sharedSecrets);
  const owner = new ChatRoomLifecycle(root, "installation-owner", ownerSecrets, 60_000);
  const foreign = new ChatRoomLifecycle(root, "installation-foreign", new MemorySecretStorage(sharedSecrets), 60_000);
  let observer;
  try {
    const alpha = await owner.createRoom("Alpha", "alpha-secret");
    await owner.persistence.append(alpha.roomId, message("alpha-1", "first", 1));
    await owner.persistence.append(alpha.roomId, message("alpha-2", "second", 2));
    const beta = await owner.createRoom("Beta", "beta-secret");
    const foreignRoom = await foreign.createRoom("Foreign", "foreign-secret");

    assert.strictEqual(await owner.renameActiveRoom(alpha.roomId, "Alpha Live"), "Alpha Live");

    observer = new ChatRoomLifecycle(root, "installation-owner", ownerSecrets, 60_000);
    assert.deepStrictEqual(await observer.listStoredRooms(), [], "active Rooms must never appear as stored");

    await owner.deactivateRoom(alpha.roomId, "test");
    await owner.deactivateRoom(beta.roomId, "test");
    await foreign.deactivateRoom(foreignRoom.roomId, "test");
    let stored = await observer.listStoredRooms();
    assert.deepStrictEqual(new Set(stored.map(room => room.roomId)), new Set([alpha.roomId, beta.roomId]), "foreign Rooms must be excluded");
    assert(stored.every(room => room.canRehost), "owned Rooms with valid credentials must be Rehostable");
    assert.strictEqual(stored.find(room => room.roomId === alpha.roomId).messageCount, 2);
    assert.strictEqual(stored.find(room => room.roomId === alpha.roomId).roomName, "Alpha Live");
    assert.strictEqual(stored.find(room => room.roomId === beta.roomId).messageCount, 0);
    assert(stored[0].updatedAt >= stored[1].updatedAt, "Stored Rooms must be sorted by most recent activity");

    const rehosted = await observer.rehostRoom(alpha.roomId);
    assert.strictEqual(rehosted.joinSecret, "alpha-secret");
    stored = await observer.listStoredRooms();
    assert.deepStrictEqual(stored.map(room => room.roomId), [beta.roomId], "Rehosted Room must leave the Stored list");
    await observer.deactivateRoom(alpha.roomId, "test");

    await observer.renameStoredRoom(alpha.roomId, "Alpha Renamed");
    stored = await observer.listStoredRooms();
    assert.strictEqual(stored.find(room => room.roomId === alpha.roomId).roomName, "Alpha Renamed");
    await assert.rejects(observer.renameStoredRoom(alpha.roomId, "Beta"), /already exists/);
    await assert.rejects(foreign.renameStoredRoom(alpha.roomId, "Foreign Rename"), /does not own/);
    const renamedRehost = await observer.rehostRoom(alpha.roomId);
    assert.strictEqual(renamedRehost.roomId, alpha.roomId);
    assert.strictEqual(renamedRehost.roomName, "Alpha Renamed");
    assert.strictEqual(renamedRehost.joinSecret, "alpha-secret");
    assert.deepStrictEqual(renamedRehost.messages.map(item => item.id), ["alpha-1", "alpha-2"]);
    await observer.deactivateRoom(alpha.roomId, "rename verified");

    await ownerSecrets.delete(`personalKnowledge.chatroom.${beta.roomId}.host`);
    stored = await observer.listStoredRooms();
    const unavailable = stored.find(room => room.roomId === beta.roomId);
    assert(unavailable, "an owned Room with missing credentials must remain visible");
    assert.strictEqual(unavailable.canRehost, false);
    assert.match(unavailable.unavailableReason, /missing or invalid/i);
    await assert.rejects(observer.rehostRoom(beta.roomId), /missing or invalid/i);

    await assert.rejects(foreign.deleteStoredRoom(alpha.roomId), /does not own/);
    await observer.deleteStoredRoom(alpha.roomId);
    assert(!fs.existsSync(path.join(root, alpha.roomId)), "Delete Data must remove the Room directory");
    assert.strictEqual(await ownerSecrets.get(`personalKnowledge.chatroom.${alpha.roomId}.host`), undefined);
    assert.strictEqual(await ownerSecrets.get(`personalKnowledge.chatroom.${alpha.roomId}.join`), undefined);
    assert(!(await observer.listStoredRooms()).some(room => room.roomId === alpha.roomId));

    const publicJson = JSON.stringify(stored);
    assert(!publicJson.includes("CredentialHash"), "Stored Room UI data must not expose credential hashes");
    assert(!publicJson.includes("ownerInstallationId"), "Stored Room UI data must not expose installation identity");
    console.log("stored rooms test: ownership, active exclusion, Rehost, Rename, unavailable credentials, and Delete Data OK");
  } finally {
    await observer?.dispose().catch(() => {});
    await owner.dispose().catch(() => {});
    await foreign.dispose().catch(() => {});
    fs.rmSync(root, { recursive: true, force: true });
  }
}

main().catch(error => {
  console.error(error);
  process.exitCode = 1;
});