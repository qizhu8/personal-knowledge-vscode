#!/usr/bin/env node
const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { ChatHub } = require("../dist/chatroom-hub");
const { probeChatRoomActive } = require("../dist/chat-hub-health");

class MemorySecretStorage {
  constructor() { this.values = new Map(); }
  async get(key) { return this.values.get(key); }
  async store(key, value) { this.values.set(key, value); }
  async delete(key) { this.values.delete(key); }
}

async function main() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pkm-hub-health-test-"));
  const hub = new ChatHub();
  const observer = new ChatHub();
  const foreign = new ChatHub();
  const sharedSecrets = new MemorySecretStorage();
  try {
    hub.configureLifecycle(root, 1024 * 1024, "owner", sharedSecrets);
    await hub.start(0);
    const url = `ws://127.0.0.1:${hub.port}`;
    assert.strictEqual(await probeChatRoomActive(url, "Legacy Room"), false, "an empty reachable Hub must not block Rehost");
    const room = await hub.createRoom("Legacy Room", "secret");
    assert.strictEqual(await probeChatRoomActive(url, room.room, room.roomId), true);
    assert.strictEqual(await probeChatRoomActive(url, room.room, "wrong-room-id"), false, "modern recents must match Room UUID, not only name");
    assert.strictEqual(await probeChatRoomActive(url, room.room), true, "legacy recents without UUID may match by name");
    assert.strictEqual(await probeChatRoomActive(url, "Other Room", "wrong-room-id"), false);
    observer.configureLifecycle(root, 1024 * 1024, "owner-observer", sharedSecrets);
    await observer.start(0);
    const observed = await observer.listStoredRooms();
    assert(observed.some(item => item.roomId === room.roomId && item.activeElsewhere && item.canForceClose), "owner credentials must authorize Force Close without knowing the active Host");
    const unauthorizedClose = await fetch(`http://127.0.0.1:${hub.port}/api/rooms/${room.roomId}/close`, { method: "POST" });
    assert.strictEqual(unauthorizedClose.status, 401, "joined clients without a Host proof must not close the Room");
    foreign.configureLifecycle(root, 1024 * 1024, "foreign", new MemorySecretStorage());
    await foreign.start(0);
    assert(!(await foreign.listStoredRooms()).some(item => item.roomId === room.roomId), "joined/foreign installations must not discover an owned Hosted Room action");
    await assert.rejects(foreign.forceCloseRemoteRoom(room.roomId), /not found|hosted elsewhere|missing|invalid/i);
    await observer.forceCloseRemoteRoom(room.roomId);
    assert.strictEqual(await probeChatRoomActive(url, room.room, room.roomId), false);
    const closed = (await observer.listStoredRooms()).find(item => item.roomId === room.roomId);
    assert(closed && closed.canRehost && !closed.activeElsewhere, "owner force-close must release the Host and preserve a Rehostable Room");
    const rehosted = await observer.rehostRoom(room.roomId);
    assert.strictEqual(rehosted.roomId, room.roomId);
    await observer.adminCloseRoom(rehosted.room);
    console.log("Hub health test: active identity, owner-only remote close, Rehost, and foreign rejection OK");
  } finally {
    await foreign.stop().catch(() => {});
    await observer.stop().catch(() => {});
    await hub.stop().catch(() => {});
    fs.rmSync(root, { recursive: true, force: true });
  }
}

main().catch(error => {
  console.error(error);
  process.exitCode = 1;
});