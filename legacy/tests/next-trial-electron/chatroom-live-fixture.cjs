"use strict";
const fs = require("node:fs");
const path = require("node:path");
const { createHash } = require("node:crypto");
const roomId = "03422a37-fce6-456a-8fd1-a4614fed1727";
const file = { fileId: "historical-missing-file", name: "before-upgrade.txt", mime: "text/plain", size: 17 };
const messages = [
  { id: "history-human", participantId: "historic-human", aliasAtSend: "Historic Human", senderKind: "human",
    messageType: "chat", content: "Human discussion before upgrade.", createdAt: 1740000000000 },
  { id: "history-agent", participantId: "historic-agent", aliasAtSend: "Historic Agent", senderKind: "agent",
    messageType: "chat", content: "Agent discussion before upgrade.", createdAt: 1740000001000,
    metadata: { replyToMessageId: "history-human" } },
  { id: "history-file", participantId: "historic-human", aliasAtSend: "Historic Human", senderKind: "human",
    messageType: "file", content: "shared a file: before-upgrade.txt", createdAt: 1740000002000, metadata: { file } },
];
async function create({ extension, root, credentials, hostParticipantId, temporaryAgent, roomId: selectedRoomId = roomId,
  roomName = "Historical multi-participant room", descriptorName = "chatroom-live-fixture.json" }) {
  const roomId = selectedRoomId;
  const { ChatPersistence } = require(path.join(extension, "dist/chat-persistence.js"));
  const persistence = new ChatPersistence(path.join(root, "chatrooms"), 50, 0);
  try {
    await persistence.createRoom(roomId, roomName, {
      ownerInstallationId: "synthetic-old-live", hostCredentialHash: credentials?.hostCredentialHash ?? "e".repeat(64),
      joinSecretHash: credentials?.joinSecretHash ?? "f".repeat(64),
    });
    for (const [index, alias, kind, participantId] of [
      [0, "Historic Human", "human", "historic-human"], [1, "Historic Agent", "agent", "historic-agent"],
    ]) {
      await persistence.requestJoin(roomId, { requestId: `historic-join-${index}`, alias, clientKey: `historic-client-${index}`,
        kind, temporary: kind === "agent" && !!temporaryAgent, requestedAt: 1740000000000, expiresAt: 1740000300000 });
      await persistence.resolveJoin(roomId, { requestId: `historic-join-${index}`, participantId, outcome: "new", resolvedAt: 1740000000001 });
    }
    if (hostParticipantId) await persistence.recordLifecycle(roomId, "room.host_assigned", undefined, { participantId: hostParticipantId });
    await persistence.appendMany(roomId, messages);
    await persistence.recordLifecycle(roomId, "stopped", "stored", { reason: "isolated multi-participant fixture" });
    await persistence.setRoomState(roomId, "stored");
    await persistence.closeRoom(roomId);
  } finally { await persistence.dispose(); }
  const db = path.join(root, "chatrooms", roomId, "chatroom.db");
  const descriptor = { root, roomId, messages, file, dbSha256: createHash("sha256").update(fs.readFileSync(db)).digest("hex") };
  fs.writeFileSync(path.join(path.dirname(root), descriptorName), JSON.stringify(descriptor), { mode: 0o600, flag: "wx" });
  return descriptor;
}
module.exports = { create, roomId, messages, file };
