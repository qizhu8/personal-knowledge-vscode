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
  try {
    hub.configureLifecycle(root, 1024 * 1024, "owner", new MemorySecretStorage());
    await hub.start(0);
    const url = `ws://127.0.0.1:${hub.port}`;
    assert.strictEqual(await probeChatRoomActive(url, "Legacy Room"), false, "an empty reachable Hub must not block Rehost");
    const room = await hub.createRoom("Legacy Room", "secret");
    assert.strictEqual(await probeChatRoomActive(url, room.room, room.roomId), true);
    assert.strictEqual(await probeChatRoomActive(url, room.room, "wrong-room-id"), false, "modern recents must match Room UUID, not only name");
    assert.strictEqual(await probeChatRoomActive(url, room.room), true, "legacy recents without UUID may match by name");
    assert.strictEqual(await probeChatRoomActive(url, "Other Room", "wrong-room-id"), false);
    await hub.adminCloseRoom(room.room);
    assert.strictEqual(await probeChatRoomActive(url, room.room, room.roomId), false);
    console.log("Hub health test: empty listener, active Room identity, and Deactivate probing OK");
  } finally {
    await hub.stop().catch(() => {});
    fs.rmSync(root, { recursive: true, force: true });
  }
}

main().catch(error => {
  console.error(error);
  process.exitCode = 1;
});