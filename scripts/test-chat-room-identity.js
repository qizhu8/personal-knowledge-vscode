#!/usr/bin/env node
const assert = require("assert");
const { chatRoomIdentity, joinedRoomRecents } = require("../dist/chat-room-identity");

assert.strictEqual(
  chatRoomIdentity("ws://10.0.0.8:7345", "Design Review"),
  chatRoomIdentity("ws://10.0.0.8:49152", " design   review "),
  "legacy identity must ignore port and normalize the Room name",
);
assert.notStrictEqual(
  chatRoomIdentity("ws://10.0.0.8:7345", "Design Review"),
  chatRoomIdentity("ws://10.0.0.9:7345", "Design Review"),
  "different hosts must remain distinct",
);
assert.strictEqual(
  chatRoomIdentity("ws://localhost:7345", "Local"),
  chatRoomIdentity("ws://127.0.0.1:9000", "Local"),
  "loopback aliases must deduplicate",
);
assert.strictEqual(
  chatRoomIdentity("ws://old:1", "Old", "room-uuid"),
  chatRoomIdentity("ws://new:2", "Renamed", "room-uuid"),
  "durable Room UUID must win over endpoint changes",
);

const recents = joinedRoomRecents([
  { id: "hosted", url: "ws://10.0.0.8:7345", room: "Hosted", host: true, lastJoined: 5 },
  { id: "old-port", url: "ws://10.0.0.8:7345", room: "Joined", host: false, lastJoined: 1 },
  { id: "new-port", url: "ws://10.0.0.8:9000", room: "Joined", host: false, lastJoined: 4 },
]);
assert.strictEqual(recents.length, 1, "Hosted Rooms and duplicate Joined endpoints must be removed");
assert.strictEqual(recents[0].url, "ws://10.0.0.8:9000", "most recently joined endpoint must be retained");
console.log("chat room identity test: joined-only recents, UUID identity, and port-insensitive legacy dedup OK");
