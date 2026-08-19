#!/usr/bin/env node
const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { ChatPersistence } = require("../dist/chat-persistence");
const initSqlJs = require("sql.js");

function message(id, content) {
  return {
    id,
    participantId: "participant-1",
    aliasAtSend: "Agent",
    senderKind: "agent",
    messageType: "chat",
    content,
    metadata: { test: true },
    createdAt: Date.now(),
  };
}

async function crash(persistence) {
  await persistence.worker.terminate();
}

async function main() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pkm-chat-persistence-test-"));
  try {
    const first = new ChatPersistence(root, 60_000);
    assert.deepStrictEqual(await first.openRoom("room-a-001", "Room A"), { messages: [], replayed: 0 });
    assert.deepStrictEqual(await first.openRoom("room-b-001", "Room B"), { messages: [], replayed: 0 });
    await first.createRoom("room-d-001", "Room D", {
      ownerInstallationId: "installation-1",
      hostCredentialHash: "host-hash",
      joinSecretHash: "join-hash",
    });
    await assert.rejects(first.createRoom("room-d-001", "Changed", {
      ownerInstallationId: "installation-2", hostCredentialHash: "wrong", joinSecretHash: "wrong",
    }), /already exists/);
    await first.recordLifecycle("room-d-001", "room.deactivated", "stored", { reason: "test" });
    await first.append("room-a-001", message("a-1", "A before crash"));
    await first.append("room-b-001", message("b-1", "B persisted"));
    await first.openRoom("room-c-001", "Room C");
    await first.appendMany("room-c-001", [
      message("c-1", "Migrated first"),
      message("c-1", "Migrated duplicate"),
      message("c-2", "Migrated second"),
    ]);
    await first.flush("room-b-001");
    await crash(first);

    const second = new ChatPersistence(root, 60_000);
    const reopenedA = await second.openRoom("room-a-001", "Room A");
    const reopenedB = await second.openRoom("room-b-001", "Room B");
    const reopenedC = await second.openRoom("room-c-001", "Room C");
    assert.strictEqual(reopenedA.replayed, 1, "Room A should replay its unflushed journal");
    assert.deepStrictEqual(reopenedA.messages.map(item => item.id), ["a-1"]);
    assert.strictEqual(reopenedB.replayed, 0, "Room B journal should be truncated after flush");
    assert.deepStrictEqual(reopenedB.messages.map(item => item.id), ["b-1"]);
    assert.strictEqual(reopenedC.replayed, 3, "Batch migration should replay every durable journal record");
    assert.deepStrictEqual(reopenedC.messages.map(item => item.id), ["c-1", "c-2"], "Batch migration must preserve order and ignore duplicate IDs");

    // A Room's persistence failure must not prevent another Room from appending and flushing.
    const roomADir = path.join(root, "room-a-001");
    const hiddenADir = path.join(root, "room-a-hidden");
    fs.renameSync(roomADir, hiddenADir);
    await assert.rejects(second.flush("room-a-001"), /ENOENT/);
    await second.append("room-b-001", message("b-2", "B after A failure"));
    await second.flush("room-b-001");
    fs.renameSync(hiddenADir, roomADir);

    await second.closeRoom("room-a-001");
    await second.dispose();

    // Duplicate journal records are harmless because message_id is unique and replay uses INSERT OR IGNORE.
    const journalA = path.join(root, "room-a-001", "chatroom.journal");
    fs.appendFileSync(journalA, JSON.stringify({ op: "append", message: message("a-1", "duplicate") }) + "\n");

    const third = new ChatPersistence(root, 60_000);
    const stored = await third.listStoredRooms();
    assert.deepStrictEqual(stored.map(room => room.roomId).sort(), ["room-a-001", "room-b-001", "room-c-001", "room-d-001"]);
    assert(stored.every(room => room.state === "stored"), "Discovered rooms must never auto-reopen");
    assert.strictEqual(stored.find(room => room.roomId === "room-b-001").messageCount, 2);
    const finalA = await third.openRoom("room-a-001", "Room A");
    assert.deepStrictEqual(finalA.messages.map(item => item.id), ["a-1"]);
    await third.dispose();

    const SQL = await initSqlJs();
    const roomD = new SQL.Database(fs.readFileSync(path.join(root, "room-d-001", "chatroom.db")));
    const metadata = roomD.exec("SELECT state, owner_installation_id, host_credential_hash, join_secret_hash FROM room_metadata")[0].values[0];
    assert.deepStrictEqual(metadata, ["stored", "installation-1", "host-hash", "join-hash"]);
    const eventTypes = roomD.exec("SELECT event_type FROM room_events ORDER BY sequence")[0].values.map(row => row[0]);
    assert.deepStrictEqual(eventTypes, ["room.created", "room.deactivated"]);
    roomD.close();

    for (const room of ["room-a-001", "room-b-001", "room-c-001", "room-d-001"]) {
      assert(fs.existsSync(path.join(root, room, "chatroom.db")), `${room} DB should exist`);
      assert.strictEqual(fs.statSync(path.join(root, room, "chatroom.journal")).size, 0, `${room} journal should be drained`);
    }
    console.log("chat persistence test: isolation, lifecycle events, crash replay, dedup, and atomic flush OK");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

main().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
