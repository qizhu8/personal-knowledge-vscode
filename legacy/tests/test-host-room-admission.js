"use strict";
const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { randomUUID } = require("node:crypto");
const dist = process.env.PKM_TEST_DIST || path.resolve("dist");
const { HostWriterAdmission } = require(path.join(dist, "runtime/host-writer-admission"));
const { ChatHub } = require(path.join(dist, "chatroom/chatroom-hub"));
const { ChatClient } = require(path.join(dist, "chatroom/chatroom-client"));

async function until(predicate, label) {
  const deadline = Date.now() + 10000;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error(`Timed out: ${label}`);
    await new Promise(resolve => setTimeout(resolve, 10));
  }
}

test("real Room websocket queues are enrolled before processing and drain waits for persisted messages", {
  timeout: 30000,
}, async t => {
  const root = path.resolve(".migration-test-work", `room-admission-${randomUUID()}`);
  fs.mkdirSync(root, { recursive: true, mode: 0o700 });
  const owner = new HostWriterAdmission(root, () => root), logs = [], secrets = new Map(), messages = [];
  const hub = new ChatHub(message => logs.push(message), work => owner.observe("chat", work));
  const client = new ChatClient({
    onStatus() {}, onPresence() {}, onMessage: message => messages.push(message), onHistory() {}, onFileComplete() {},
  });
  hub.configureLifecycle(path.join(root, "chatrooms"), 1024 * 1024, "fixture-owner", {
    get: async key => secrets.get(key), store: async (key, value) => { secrets.set(key, value); }, delete: async key => { secrets.delete(key); },
  });
  let release;
  t.after(async () => {
    release?.();
    client.disconnect();
    await hub.stop();
    fs.rmSync(root, { recursive: true, force: true });
  });
  await hub.start(0);
  const room = await hub.createRoom("Admission fixture", "fixture-only-secret");
  client.connect({ url: `ws://127.0.0.1:${hub.port}/${encodeURIComponent(room.room)}`,
    room: room.room, roomId: room.roomId, user: "Fixture", kind: "human",
    token: room.secret, cid: "fixture-cid", hostToken: room.hostToken });
  await until(() => client.isConnected && owner.status().inFlight === 0, "Room connection");
  const persistence = hub.persistence, originalAppend = persistence.append.bind(persistence);
  let entered = false;
  persistence.append = async (id, message) => {
    if (message.content === "@all first admitted") {
      entered = true;
      await new Promise(resolve => { release = resolve; });
    }
    return originalAppend(id, message);
  };
  assert(client.sendText("@all first admitted"));
  try { await until(() => entered, "first message persistence"); }
  catch (error) { throw new Error(`${error.message}; logs=${JSON.stringify(logs)} messages=${JSON.stringify(messages)}`); }
  assert(client.sendText("@all second admitted"));
  await until(() => owner.status().kinds.chat >= 2, "second queued frame admission");
  const drain = owner.drain(5000);
  let drained = false;
  void drain.then(() => { drained = true; });
  assert(client.sendText("@all rejected during drain"));
  await until(() => logs.some(message => /admission is closed/i.test(message)), "rejected frame");
  await until(() => messages.some(message => /not accepting this frame; it was not processed/i.test(message.text)), "explicit rejection receipt");
  assert(client.isConnected);
  assert.equal(drained, false);
  release();
  await drain;
  const stored = await persistence.openRoom(room.roomId, room.room);
  assert(stored.messages.some(message => message.content === "@all first admitted"));
  assert(stored.messages.some(message => message.content === "@all second admitted"));
  assert(!stored.messages.some(message => message.content === "@all rejected during drain"));
  assert.equal(owner.status().cutoverAuthorized, false);
});
