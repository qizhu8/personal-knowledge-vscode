#!/usr/bin/env node
const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { ChatHub } = require("../dist/chatroom-hub");
const { ChatMeetingLifecycle, isFinalLeadSummary, latestDiscussAfterCompletedMeeting } = require("../dist/chat-meeting-lifecycle");
const { MeetingStateStore } = require("../dist/meeting-state");

class MemorySecretStorage {
  constructor() { this.values = new Map(); }
  async get(key) { return this.values.get(key); }
  async store(key, value) { this.values.set(key, value); }
  async delete(key) { this.values.delete(key); }
}

async function startMeeting(store, roomId, triggerMessageId, title, startedAt) {
  return store.startMeeting({
    roomId, roomName: "Lifecycle", title, problemStatement: title,
    owner: "Host", lead: "Host", recorder: "Host", participants: ["Host"], host: "Host",
    triggerMessageId, requestId: `start:${triggerMessageId}`, expectedRevision: 0, startedAt,
  });
}

async function main() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pkm-chat-meeting-lifecycle-"));
  let hub;
  try {
    const noMeetingLifecycle = new ChatMeetingLifecycle({ snapshot: () => ({ current: null }) });
    assert.strictEqual(await noMeetingLifecycle.adjournRoom("empty"), null);
    let retryAttempts = 0;
    const retryLifecycle = new ChatMeetingLifecycle({
      snapshot: () => ({ current: { id: "retry-meeting", host: "Fallback Host", revision: retryAttempts + 1 } }),
      adjournMeeting: async input => {
        retryAttempts++;
        if (retryAttempts === 1) throw new Error("Meeting revision conflict");
        assert.strictEqual(input.actor, "Fallback Host");
        return { id: input.meetingId };
      },
    });
    assert.strictEqual((await retryLifecycle.adjournRoom("retry-room")).id, "retry-meeting");
    assert.strictEqual(retryAttempts, 2);
    const brokenLifecycle = new ChatMeetingLifecycle({
      snapshot: () => ({ current: { id: "broken", host: "Host", revision: 1 } }),
      adjournMeeting: async () => { throw new Error("disk unavailable"); },
    });
    await assert.rejects(brokenLifecycle.adjournRoom("broken-room"), /disk unavailable/);
    const exhaustedLifecycle = new ChatMeetingLifecycle({
      snapshot: () => ({ current: { id: "conflict", host: "Host", revision: 1 } }),
      adjournMeeting: async () => { throw new Error("revision conflict"); },
    });
    await assert.rejects(exhaustedLifecycle.adjournRoom("conflict-room"), /revision conflict/);

    const chatroomsRoot = path.join(root, "chatrooms");
    const store = new MeetingStateStore(chatroomsRoot, path.join(root, "notes"));
    const meetings = new ChatMeetingLifecycle(store);
    hub = new ChatHub();
    hub.configureLifecycle(chatroomsRoot, 10 * 1024 * 1024, "installation-owner", new MemorySecretStorage());
    const closeReasons = [];
    hub.onRoomDeactivating(async (roomId, reason) => {
      closeReasons.push(reason);
      await meetings.adjournRoom(roomId, "Host");
    });
    await hub.start(0);

    const firstRoom = await hub.createRoom("Admin Close", "secret-one");
    const first = await startMeeting(store, firstRoom.roomId, "discuss-1", "First", "2026-09-20T10:00:00.000Z");
    await Promise.all([hub.adminCloseRoom(firstRoom.roomId), hub.adminCloseRoom(firstRoom.roomId)]);
    assert.strictEqual(store.snapshot(firstRoom.roomId).current, null);
    assert.strictEqual(store.snapshot(firstRoom.roomId).history[0].id, first.id);
    assert.deepStrictEqual(closeReasons, ["closed by admin"], "concurrent close requests must run the lifecycle hook once");

    const firstRehost = await hub.rehostRoom(firstRoom.roomId);
    const oldDiscuss = { id: "discuss-1", from: "Host", fromId: "host", text: "First", ts: Date.parse("2026-09-20T10:00:00.000Z"), kind: "human", mode: "discuss" };
    assert.strictEqual(meetings.latestDiscussAfterLastMeeting(firstRoom.roomId, [oldDiscuss]), undefined,
      "a completed Meeting trigger must not be revived after Rehost");
    const newDiscuss = { ...oldDiscuss, id: "discuss-2", text: "Second", ts: Date.now() + 1000 };
    assert.strictEqual(meetings.latestDiscussAfterLastMeeting(firstRoom.roomId, [oldDiscuss, newDiscuss]).id, "discuss-2");
    const second = await startMeeting(store, firstRoom.roomId, "discuss-2", "Second", new Date(newDiscuss.ts).toISOString());

    const secondRoom = await hub.createRoom("Close All", "secret-two");
    const third = await startMeeting(store, secondRoom.roomId, "discuss-3", "Third", "2026-09-20T11:00:00.000Z");
    await hub.adminCloseAll();
    assert(store.snapshot(firstRehost.roomId).history.some(meeting => meeting.id === second.id));
    assert(store.snapshot(secondRoom.roomId).history.some(meeting => meeting.id === third.id));
    assert.strictEqual(closeReasons.filter(reason => reason === "closed by admin").length, 3);

    const shutdownRoom = await hub.rehostRoom(firstRoom.roomId);
    const fourth = await startMeeting(store, shutdownRoom.roomId, "discuss-4", "Fourth", "2026-09-20T12:00:00.000Z");
    await hub.stop();
    hub = undefined;
    assert(store.snapshot(shutdownRoom.roomId).history.some(meeting => meeting.id === fourth.id));
    assert(closeReasons.includes("hub-shutdown"), "Stop Hub must use the same Meeting lifecycle hook");

    const snapshot = store.snapshot(firstRoom.roomId);
    assert.strictEqual(latestDiscussAfterCompletedMeeting(snapshot, [{ ...newDiscuss, mode: "ask" }]), undefined,
      "non-Discuss messages must never start a Meeting");
    assert.strictEqual(isFinalLeadSummary({ ...newDiscuss, from: "Host", replyPolicy: "none" }, "Host"), false,
      "ending a Lead reply must not implicitly overwrite the Topic conclusion");
    assert.strictEqual(isFinalLeadSummary({ ...newDiscuss, from: "Peer", finalTopicSummary: true }, "Host"), false,
      "a non-Lead cannot declare the final Topic Summary");
    assert.strictEqual(isFinalLeadSummary({ ...newDiscuss, from: "host", finalTopicSummary: true }, "Host"), true,
      "the selected Lead can explicitly declare the final Topic Summary");
    console.log("chat Meeting lifecycle test: Admin Close, Close All, Stop Hub, idempotency, and Rehost boundary OK");
  } finally {
    await hub?.stop().catch(() => {});
    fs.rmSync(root, { recursive: true, force: true });
  }
}

main().catch(error => { console.error(error); process.exitCode = 1; });