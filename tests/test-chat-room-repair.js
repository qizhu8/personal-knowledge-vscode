#!/usr/bin/env node
const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { ChatHub } = require("../dist/chatroom-hub");

class MemorySecretStorage {
  constructor() { this.values = new Map(); }
  async get(key) { return this.values.get(key); }
  async store(key, value) { this.values.set(key, value); }
  async delete(key) { this.values.delete(key); }
}

async function main() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pkm-room-repair-test-"));
  const hub = new ChatHub();
  try {
    hub.configureLifecycle(root, 10 * 1024 * 1024, "repair-owner", new MemorySecretStorage());
    await hub.start(0);
    const created = await hub.createRoom("AAGL Discussion", "repair-secret");
    await hub.persistence.append(created.roomId, {
      id: "message-before-repair",
      participantId: "host-participant",
      aliasAtSend: "Host",
      senderKind: "human",
      messageType: "chat",
      content: "Preserve this message",
      createdAt: Date.now(),
    });

    assert.deepStrictEqual(hub.roomNames, ["aagl discussion"]);
    const repaired = await hub.repairStoredRoom(created.roomId);
    assert.strictEqual(repaired.roomName, "aagl discussion");
    assert.strictEqual(repaired.messageCount, 1);
    assert.strictEqual(repaired.closedOrphans, 1, "repair must close a zero-member local zombie Room");
    assert.deepStrictEqual(hub.roomNames, []);

    const stored = (await hub.listStoredRooms()).find(room => room.roomId === created.roomId);
    assert(stored && stored.canRehost && !stored.activeElsewhere, "repaired Room must become Rehostable");
    const reopened = await hub.rehostRoom(created.roomId);
    const history = await hub.persistence.openRoom(created.roomId, reopened.room);
    assert(history.messages.some(message => message.id === "message-before-repair"), "repair must preserve Room history");
    await hub.adminCloseRoom(reopened.room);

    const packageJson = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "package.json"), "utf8"));
    assert(packageJson.contributes.commands.some(command => command.command === "personalKnowledge.repairStoredRoom"));
    assert(packageJson.contributes.menus["view/item/context"].some(item =>
      item.command === "personalKnowledge.repairStoredRoom" && item.when.includes("pk-chat-hosted-room-stored")));
    const panel = fs.readFileSync(path.join(__dirname, "..", "dist", "webview", "panel.js"), "utf8");
    assert.match(panel, /chatRepairStoredRoom/);
    assert.match(panel, /Repair Room/);

    console.log("Chat Room repair test: zombie cleanup, Rehost readiness, history preservation, and context menus OK");
  } finally {
    await hub.stop().catch(() => {});
    fs.rmSync(root, { recursive: true, force: true });
  }
}

main().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
