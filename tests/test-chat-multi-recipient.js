#!/usr/bin/env node
const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { WebSocket } = require("ws");
const { ChatHub } = require("../dist/chatroom-hub");

class MemorySecretStorage {
  constructor() { this.values = new Map(); }
  async get(key) { return this.values.get(key); }
  async store(key, value) { this.values.set(key, value); }
  async delete(key) { this.values.delete(key); }
}

function connect(url) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url); ws.frames = [];
    ws.on("message", raw => ws.frames.push(JSON.parse(raw.toString())));
    ws.once("open", () => resolve(ws)); ws.once("error", reject);
  });
}
async function waitFor(predicate, timeout = 3000) {
  const started = Date.now();
  while (Date.now() - started < timeout) {
    const value = predicate(); if (value) return value;
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  throw new Error("Timed out waiting for condition");
}
function join(ws, room, user, extra = {}) {
  ws.send(JSON.stringify({ t: "join", room: room.room, roomId: room.roomId, token: room.secret,
    user, kind: extra.kind || "agent", cid: `${user}-cid`, hostToken: extra.hostToken }));
}

async function main() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pkm-three-recipient-"));
  const sockets = []; let hub;
  try {
    hub = new ChatHub();
    assert.deepStrictEqual(hub.allMentionNames("email foo@example and literal x@Agent"), [],
      "Hub fallback parser must ignore email-like @ tokens embedded in words");
    assert.deepStrictEqual(hub.allMentionNames('ask @Amy and @"Agent A"'), ["Amy", "Agent A"]);
    hub.configureLifecycle(root, 1024 * 1024, "owner", new MemorySecretStorage());
    await hub.start(0);
    const room = await hub.createRoom("Three Recipients", "secret");
    const url = `ws://127.0.0.1:${hub.port}`;
    const host = await connect(url); sockets.push(host); join(host, room, "Host", { kind: "human", hostToken: room.hostToken });
    await waitFor(() => host.frames.find(frame => frame.t === "join.approved"));

    const aliases = ["Agent A", "Agent B", "Agent Three"];
    for (const alias of aliases) {
      const socket = await connect(url); sockets.push(socket); join(socket, room, alias);
      await waitFor(() => socket.frames.find(frame => frame.t === "join.ready"));
    }

    const text = '@"Agent A" @"Agent B" @"Agent Three" test all three';
    host.send(JSON.stringify({ t: "msg", room: room.room, text, kind: "human" }));
    const senderEcho = await waitFor(() => host.frames.find(frame => frame.t === "msg" && frame.text === text));
    assert.strictEqual(senderEcho.receipt?.ack, false, "sender echo must not count as recipient delivery");
    assert.strictEqual(host.frames.filter(frame => frame.t === "msg" && frame.text === text).length, 1,
      "Hub must echo the accepted message exactly once because clients do not render a local optimistic copy");
    const delivered = [];
    for (const socket of sockets.slice(1)) {
      delivered.push(await waitFor(() => socket.frames.find(frame => frame.t === "msg" && frame.text === text)));
    }
    assert.strictEqual(delivered.length, 3);
    assert(delivered.every(frame => frame.receipt?.ack === true), "all three recipients must be addressed");
    assert(delivered.every(frame => frame.receipt?.total === 3), "receipt target count must include all three recipients");
    const agentText = '@"Agent B" @"Agent Three" peer discussion';
    sockets[1].send(JSON.stringify({ t: "msg", room: room.room, text: agentText, kind: "agent", requireReply: true }));
    const peerB = await waitFor(() => sockets[2].frames.find(frame => frame.t === "msg" && frame.text === agentText));
    const peerThree = await waitFor(() => sockets[3].frames.find(frame => frame.t === "msg" && frame.text === agentText));
    assert.strictEqual(peerB.receipt?.total, 2);
    assert.strictEqual(peerThree.receipt?.total, 2);
    assert.strictEqual(peerB.responseRequired, true);

    const announceText = '@"Agent A" @"Agent B" FYI';
    host.send(JSON.stringify({ t: "msg", room: room.room, text: announceText, kind: "human",
      mode: "announce", replyPolicy: "none" }));
    const announce = await waitFor(() => sockets[1].frames.find(frame => frame.t === "msg" && frame.text === announceText));
    assert.strictEqual(announce.replyPolicy, "none");
    assert.strictEqual(announce.responseRequired, false);
    assert.strictEqual(announce.mode, "announce");

    const discussText = '@"Agent A" @"Agent B" review together';
    host.send(JSON.stringify({ t: "msg", room: room.room, text: discussText, kind: "human",
      mode: "discuss", replyPolicy: "required" }));
    const discuss = await waitFor(() => sockets[1].frames.find(frame => frame.t === "msg" && frame.text === discussText));
    assert.strictEqual(discuss.replyPolicy, "required");
    assert.strictEqual(discuss.mode, "discuss");
    assert.deepStrictEqual(new Set(discuss.discussionAudience), new Set(["Agent A", "Agent B"]));

    sockets[3].terminate();
    await waitFor(() => host.frames.find(frame => frame.t === "presence" &&
      frame.members?.find(member => member.user === "Agent Three")?.present === false));
    const offlineDiscussText = '@"Agent A" @"Agent B" @"Agent Three" continue with offline context';
    host.send(JSON.stringify({ t: "msg", room: room.room, text: offlineDiscussText, kind: "human",
      mode: "discuss", replyPolicy: "required" }));
    const offlineDiscuss = await waitFor(() => sockets[1].frames.find(frame => frame.t === "msg" && frame.text === offlineDiscussText));
    assert.deepStrictEqual(new Set(offlineDiscuss.discussionAudience), new Set(["Agent A", "Agent B", "Agent Three"]),
      "discussion audience must retain explicitly mentioned offline roster members");
    assert.strictEqual(offlineDiscuss.receipt?.total, 2, "live receipt total must count only connected delivery targets");

    const trailingText = '@Host status table\n\n| Item | State |\n|---|---|\n| build | ready |\n\n@"Agent B" @"Agent Three" please send latest delta';
    sockets[1].send(JSON.stringify({ t: "msg", room: room.room, text: trailingText, kind: "agent",
      recipients: ["Host", "Agent B", "Agent Three"], replyPolicy: "required" }));
    const trailingHost = await waitFor(() => host.frames.find(frame => frame.t === "msg" && frame.text === trailingText));
    const trailingB = await waitFor(() => sockets[2].frames.find(frame => frame.t === "msg" && frame.text === trailingText));
    assert.strictEqual(trailingHost.receipt?.total, 2);
    assert.strictEqual(trailingB.receipt?.ack, true);

    const legacyTrailingText = '@Host legacy body\n\n@"Agent B" @"Agent Three" all mentions route';
    sockets[1].send(JSON.stringify({ t: "msg", room: room.room, text: legacyTrailingText, kind: "agent", replyPolicy: "required" }));
    const legacyB = await waitFor(() => sockets[2].frames.find(frame => frame.t === "msg" && frame.text === legacyTrailingText));
    assert.strictEqual(legacyB.receipt?.total, 2, "legacy frames must route every valid online mention, not only the leading prefix");

    const quotedText = '@"Agent B" quoting the table';
    host.send(JSON.stringify({ t: "msg", room: room.room, text: quotedText, kind: "human",
      replyPolicy: "required", replyToMessageId: discuss.id }));
    const quoted = await waitFor(() => sockets[2].frames.find(frame => frame.t === "msg" && frame.text === quotedText));
    assert.strictEqual(quoted.replyToMessageId, discuss.id);
    await waitFor(async () => (await hub.persistence.openRoom(room.roomId, room.room)).messages.some(message =>
      message.content === quotedText && message.metadata?.replyToMessageId === discuss.id));

    const markdownText = '## Build report\n\n| Item | State |\n|---|---|\n| image | ready |';
    host.send(JSON.stringify({ t: "msg", room: room.room, text: markdownText, kind: "human",
      recipients: ["Agent A", "Agent B"], replyPolicy: "required" }));
    const markdown = await waitFor(() => sockets[1].frames.find(frame => frame.t === "msg" && frame.text === markdownText));
    assert(markdown.text.startsWith("## Build report"), "structured To recipients must not prefix Markdown text");
    assert.deepStrictEqual(markdown.recipients, ["agent a", "agent b"]);
    await waitFor(async () => (await hub.persistence.openRoom(room.roomId, room.room)).messages.some(message =>
      message.content === markdownText && message.metadata?.recipients?.join(",") === "agent a,agent b"));

    sockets[1].send(JSON.stringify({ t: "msg", room: room.room, text: "@Host accepted concurrently", kind: "agent", clientRequestId: "accepted-1" }));
    sockets[1].send(JSON.stringify({ t: "msg", room: room.room, text: "@all forbidden", kind: "agent", clientRequestId: "rejected-1" }));
    const acceptedReceipt = await waitFor(() => sockets[1].frames.find(frame => frame.t === "msg.accepted" && frame.clientRequestId === "accepted-1"));
    const rejectedReceipt = await waitFor(() => sockets[1].frames.find(frame => frame.t === "error" && frame.clientRequestId === "rejected-1"));
    assert(acceptedReceipt.messageId);
    assert.strictEqual(rejectedReceipt.code, "host-only-broadcast");
    assert.strictEqual(rejectedReceipt.correctable, true);
    assert.strictEqual(rejectedReceipt.connectionAlive, true);
    assert(!host.frames.some(frame => frame.t === "msg" && frame.text === "@all forbidden"));

    sockets[1].send(JSON.stringify({ t: "msg", room: room.room, text: "@all disguised broadcast", kind: "agent",
      recipients: ["Host"], clientRequestId: "rejected-disguised-1" }));
    const disguisedBroadcast = await waitFor(() => sockets[1].frames.find(frame => frame.t === "error" && frame.clientRequestId === "rejected-disguised-1"));
    assert.strictEqual(disguisedBroadcast.code, "host-only-broadcast");
    assert(!host.frames.some(frame => frame.t === "msg" && frame.text === "@all disguised broadcast"));

    sockets[1].send(JSON.stringify({ t: "msg", room: room.room, text: "@Ghost must not broadcast", kind: "agent", clientRequestId: "unknown-1" }));
    const unknownReceipt = await waitFor(() => sockets[1].frames.find(frame => frame.t === "error" && frame.clientRequestId === "unknown-1"));
    assert.strictEqual(unknownReceipt.code, "mention-required");
    assert.strictEqual(unknownReceipt.connectionAlive, true);
    assert(!host.frames.some(frame => frame.t === "msg" && frame.text === "@Ghost must not broadcast"));

    sockets[1].send(JSON.stringify({ t: "msg", room: room.room, text: "private metadata", kind: "agent",
      recipients: ["Ghost"], clientRequestId: "unknown-structured-1" }));
    const unknownStructured = await waitFor(() => sockets[1].frames.find(frame => frame.t === "error" && frame.clientRequestId === "unknown-structured-1"));
    assert.strictEqual(unknownStructured.code, "mention-required");
    assert(!host.frames.some(frame => frame.t === "msg" && frame.text === "private metadata"));
    console.log("chat multi-recipient test: Host reaches three Agents; Agent reaches two peers; non-Host @all rejected OK");
  } finally {
    for (const socket of sockets) try { socket.terminate(); } catch {}
    await hub?.stop().catch(() => {});
    fs.rmSync(root, { recursive: true, force: true });
  }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
