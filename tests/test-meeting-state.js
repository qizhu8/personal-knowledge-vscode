#!/usr/bin/env node
const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { MeetingStateStore } = require("../dist/meeting-state");

async function main() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pkm-meeting-state-test-"));
  try {
    const store = new MeetingStateStore(path.join(root, "chatrooms"), path.join(root, "notes"));
    const first = await store.startMeeting({
      roomId: "room-a", roomName: "Room A", title: "First Topic", problemStatement: "Initial discuss text",
      owner: "Host", lead: "Host", recorder: "Secretary", participants: ["Host", "Secretary", "Agent A"], host: "Host", triggerMessageId: "message-1", requestId: "start-1",
      expectedRevision: 0, startedAt: "2026-09-18T16:20:00.000Z",
    });
    assert.strictEqual(first.revision, 1);
    assert.strictEqual(first.topics[0].rounds[0].number, 1);
    assert.strictEqual((await store.recordDiscussionMessage({
      roomId: "room-a", participant: "Host", text: "Initial discuss text", sourceMessageId: "message-1",
    })).revision, 1, "the Discuss trigger must not be duplicated as an opinion");
    const peerUpdate = await store.recordDiscussionMessage({
      roomId: "room-a", participant: "Agent A", text: "Independent analysis", sourceMessageId: "message-2",
    });
    assert.strictEqual(peerUpdate.revision, 2);
    assert.strictEqual(peerUpdate.topics[0].rounds[0].opinions[0].participant, "Agent A");
    assert.strictEqual(peerUpdate.topics[0].rounds[0].conclusion, undefined, "a peer opinion must not overwrite the Lead summary");
    const revisedPeerUpdate = await store.recordDiscussionMessage({
      roomId: "room-a", participant: "Agent A", text: '@Host - Revised concise idea', sourceMessageId: "message-2b",
    });
    assert.strictEqual(revisedPeerUpdate.topics[0].rounds[0].opinions.length, 1, "each participant must have one current idea bullet per round");
    assert.strictEqual(revisedPeerUpdate.topics[0].rounds[0].opinions[0].text, "Revised concise idea");
    const leadUpdate = await store.recordDiscussionMessage({
      roomId: "room-a", participant: "Host", text: "Live synthesis", sourceMessageId: "message-3", finalLeadSummary: true,
    });
    assert.strictEqual(leadUpdate.revision, 4);
    assert.strictEqual(leadUpdate.topics[0].rounds[0].conclusion, "Live synthesis");
    assert.strictEqual((await store.recordDiscussionMessage({
      roomId: "room-a", participant: "Host", text: "Live synthesis", sourceMessageId: "message-3", finalLeadSummary: true,
    })).revision, 4, "message capture must be idempotent");
    assert.strictEqual((await store.startMeeting({
      roomId: "room-a", roomName: "ignored", title: "ignored", problemStatement: "ignored", owner: "ignored",
      lead: "ignored", recorder: "ignored", participants: [], host: "ignored", triggerMessageId: "ignored", requestId: "start-1", expectedRevision: 0,
    })).id, first.id, "a duplicate request ID must return the original result");
    await assert.rejects(store.startMeeting({
      roomId: "room-a", roomName: "Room A", title: "Second", problemStatement: "No", owner: "Host",
      lead: "Host", recorder: "Host", participants: ["Host"], host: "Host", triggerMessageId: "message-2", requestId: "start-2", expectedRevision: 0,
    }), /already has an active Meeting/);
    await assert.rejects(store.adjournMeeting({ roomId: "room-a", meetingId: first.id, actor: "Host", requestId: "end-bad", expectedRevision: 7 }), /revision conflict/);
    const ended = await store.adjournMeeting({
      roomId: "room-a", meetingId: first.id, actor: "Host", requestId: "end-1", expectedRevision: 4,
      endedAt: "2026-09-18T17:00:00.000Z",
    });
    assert.strictEqual(ended.status, "adjourned");
    assert.strictEqual(ended.revision, 5);
    assert.strictEqual((await store.adjournMeeting({ roomId: "room-a", meetingId: first.id, actor: "Host", requestId: "end-1", expectedRevision: 4 })).revision, 5);

    const second = await store.startMeeting({
      roomId: "room-a", roomName: "Room A", title: "Second Topic", problemStatement: "Later discuss text",
      owner: "Host", lead: "Host", recorder: "Host", participants: ["Host", "Agent B"], host: "Host", triggerMessageId: "message-2", requestId: "start-2",
      expectedRevision: 0, startedAt: "2026-09-19T09:42:00.000Z",
    });
    await store.adjournMeeting({ roomId: "room-a", meetingId: second.id, actor: "Host", requestId: "end-2", expectedRevision: 1 });

    const reopened = new MeetingStateStore(path.join(root, "chatrooms"), path.join(root, "notes"));
    const snapshot = reopened.snapshot("room-a");
    assert.strictEqual(snapshot.current, null);
    assert.deepStrictEqual(snapshot.history.map(meeting => meeting.title), ["Second Topic", "First Topic"]);
    assert.deepStrictEqual(reopened.snapshot("room-b"), { current: null, history: [], trash: [] }, "Meetings must be isolated by Room");
    assert(fs.existsSync(path.join(root, "notes", second.markdownPath)));
    const markdown = fs.readFileSync(path.join(root, "notes", second.markdownPath), "utf8");
    assert(markdown.includes("meeting_id:"));
    assert(markdown.includes("## Second Topic"));
    assert(markdown.includes("#### Round 1"));
    assert(markdown.includes("- Participants: Host, Agent B"));
    assert(markdown.includes("- Recorder: Host"));
    assert(markdown.includes("- Started: 2026-09-19T09:42:00.000Z"));
    assert.match(markdown, /- Ended: \d{4}-\d{2}-\d{2}T/);
    const trashed = await reopened.moveToTrash({ roomId:"room-a", meetingId:second.id, actor:"Host", requestId:"trash-2", expectedRevision:2 });
    assert.strictEqual(trashed.status, "trashed");
    assert(!fs.existsSync(path.join(root, "notes", second.markdownPath)), "trashed Meeting Markdown must leave the Notes surface");
    assert.deepStrictEqual(reopened.snapshot("room-a").history.map(meeting => meeting.title), ["First Topic"]);
    assert.deepStrictEqual(reopened.snapshot("room-a").trash.map(meeting => meeting.title), ["Second Topic"]);
    const restored = await reopened.restoreFromTrash({ roomId:"room-a", meetingId:second.id, actor:"Host", requestId:"restore-2", expectedRevision:3 });
    assert.strictEqual(restored.status, "adjourned");
    assert(fs.existsSync(path.join(root, "notes", second.markdownPath)), "restore must regenerate Meeting Markdown");
    const trashedAgain = await reopened.moveToTrash({ roomId:"room-a", meetingId:second.id, actor:"Host", requestId:"trash-2-again", expectedRevision:4 });
    await reopened.permanentlyDelete({ roomId:"room-a", meetingId:second.id, actor:"Host", requestId:"delete-2", expectedRevision:trashedAgain.revision });
    await reopened.permanentlyDelete({ roomId:"room-a", meetingId:second.id, actor:"Host", requestId:"delete-2", expectedRevision:trashedAgain.revision });
    assert.deepStrictEqual(reopened.snapshot("room-a").trash, []);
    console.log("Meeting state test: formal minutes, revisions, idempotency, history, Trash lifecycle, restart, and Markdown projection OK");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

main().catch(error => { console.error(error); process.exitCode = 1; });
