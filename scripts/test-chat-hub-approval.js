#!/usr/bin/env node
const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { WebSocket } = require("ws");
const { ChatHub } = require("../dist/chatroom-hub");
const { ChatClient } = require("../dist/chatroom-client");

class MemorySecretStorage {
  constructor(values = new Map()) { this.values = values; }
  async get(key) { return this.values.get(key); }
  async store(key, value) { this.values.set(key, value); }
  async delete(key) { this.values.delete(key); }
}

function connect(url) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url);
    ws.frames = [];
    ws.waiters = [];
    ws.on("message", raw => {
      const frame = JSON.parse(raw.toString());
      ws.frames.push(frame);
      for (const waiter of [...ws.waiters]) {
        if (!waiter.predicate(frame)) continue;
        ws.waiters.splice(ws.waiters.indexOf(waiter), 1);
        clearTimeout(waiter.timer);
        waiter.resolve(frame);
      }
    });
    ws.once("open", () => resolve(ws));
    ws.once("error", reject);
  });
}

function waitFrame(ws, predicate, timeout = 2000) {
  const existing = ws.frames.find(predicate);
  if (existing) return Promise.resolve(existing);
  return new Promise((resolve, reject) => {
    const waiter = { predicate, resolve, timer: setTimeout(() => {
      ws.waiters.splice(ws.waiters.indexOf(waiter), 1);
      reject(new Error(`Timed out waiting for frame; received ${JSON.stringify(ws.frames)}`));
    }, timeout) };
    ws.waiters.push(waiter);
  });
}

function sendJoin(ws, room, secret, user, extra = {}) {
  ws.send(JSON.stringify({ t: "join", room, token: secret, user, kind: "agent", cid: `${user}-cid`, ...extra }));
}

async function waitUntil(predicate, timeout = 2000) {
  const started = Date.now();
  while (Date.now() - started < timeout) {
    if (await predicate()) return;
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  throw new Error("Condition timed out");
}

async function main() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pkm-hub-approval-test-"));
  const secrets = new MemorySecretStorage();
  let hub;
  const sockets = [];
  let managedClient;
  try {
    hub = new ChatHub();
    assert.deepStrictEqual(hub.conversationMentions('@Host discusses `@all` behavior'), ['Host']);
    assert.deepStrictEqual(hub.conversationMentions('plain text mentions @all later'), []);
    assert.deepStrictEqual(hub.conversationMentions('/release @"Agent One"'), ['Agent One']);
    hub.configureLifecycle(root, 10 * 1024 * 1024, "installation-owner", secrets);
    await hub.start(0);
    const created = await hub.createRoom("Approval", "join-secret");
    const url = `ws://127.0.0.1:${hub.port}`;

    const host = await connect(url); sockets.push(host);
    sendJoin(host, created.room, created.secret, "Host", { roomId: created.roomId, kind: "human", hostToken: created.hostToken });
    const hostApproved = await waitFrame(host, frame => frame.t === "join.approved");
    assert.strictEqual(hub.adminRooms()[0].owner, "Host");
    const hostPresence = await waitFrame(host, frame => frame.t === "presence" && frame.members.some(member => member.participantId === hostApproved.participantId));
    assert.strictEqual(hostPresence.members.find(member => member.participantId === hostApproved.participantId).host, true);

    const managedConnected = new Promise((resolve, reject) => {
      managedClient = new ChatClient({
        onStatus: status => { if (status === "connected") resolve(); },
        onMessage: () => {}, onHistory: () => {}, onPresence: () => {}, onFileComplete: () => {},
        onJoinPending: requestId => { void hub.approveJoinNew(requestId).catch(reject); },
        onRejected: (_code, message) => reject(new Error(message)),
      });
      managedClient.connect({ url, room: created.room, roomId: created.roomId, user: "Managed Agent", token: created.secret, kind: "agent", cid: "managed-test" });
    });
    await managedConnected;
    assert(managedClient.participantId, "managed agent must receive a participant ID through automatic Host approval");
    managedClient.disconnect();

    const mismatched = await connect(url); sockets.push(mismatched);
    sendJoin(mismatched, created.room, created.secret, "Wrong Room", { roomId: "different-room-id" });
    await waitFrame(mismatched, frame => frame.t === "error" && frame.code === "room-mismatch");
    assert.strictEqual(hub.pendingApprovals().length, 0, "Room ID mismatch must fail before reserving an alias");

    const guest = await connect(url); sockets.push(guest);
    sendJoin(guest, created.room, created.secret, "Agent One", { roomId: created.roomId });
    const pending = await waitFrame(guest, frame => frame.t === "join.pending");
    assert(!guest.frames.some(frame => frame.t === "history" || frame.t === "presence"), "pending Join must not receive Room data");
    guest.send(JSON.stringify({ t: "msg", room: created.room, text: "should not post" }));
    await waitFrame(guest, frame => frame.t === "error" && frame.code === "join-pending");
    assert(!host.frames.some(frame => frame.t === "msg" && frame.text === "should not post"));
    await hub.approveJoinNew(pending.requestId);
    const approved = await waitFrame(guest, frame => frame.t === "join.approved");
    await waitFrame(guest, frame => frame.t === "presence");
    await waitFrame(host, frame => frame.t === "agent.state" && frame.user === "Agent One" && frame.state === "standby");
    assert.notStrictEqual(approved.participantId, hostApproved.participantId);
    guest.send(JSON.stringify({ t: "msg", room: created.room, text: "message without direction" }));
    await waitFrame(guest, frame => frame.t === "error" && frame.code === "mention-required");
    assert(!host.frames.some(frame => frame.t === "msg" && frame.text === "message without direction"));
    guest.send(JSON.stringify({ t: "msg", room: created.room, text: "@Host participant identity message" }));
    const participantMessage = await waitFrame(host, frame => frame.t === "msg" && frame.text === "@Host participant identity message");
    assert.strictEqual(participantMessage.fromId, approved.participantId);
    await waitUntil(async () => (await hub.persistence.openRoom(created.roomId, created.room)).messages.some(
      message => message.content === "@Host participant identity message" && message.participantId === approved.participantId));

    const guestClosed = new Promise(resolve => guest.once("close", resolve));
    guest.send(JSON.stringify({ t: "msg", room: created.room, text: "/leave" }));
    const leaveMessage = await waitFrame(host, frame => frame.t === "msg" && frame.from === "Agent One" && frame.text === "/leave");
    await guestClosed;
    await waitUntil(async () => {
      const aliases = (await hub.persistence.identityState(created.roomId)).aliases;
      return aliases.some(alias => alias.participantId === approved.participantId && alias.releasedAt);
    });
    host.send(JSON.stringify({ t: "msg", room: created.room, text: "@all missed while disconnected" }));
    const missed = await waitFrame(host, frame => frame.t === "msg" && frame.text === "@all missed while disconnected");

    const reused = await connect(url); sockets.push(reused);
    sendJoin(reused, created.room, created.secret, "Agent One", { roomId: created.roomId, resumeAfter: participantMessage.id });
    const reusePending = await waitFrame(reused, frame => frame.t === "join.pending");
    const reusable = hub.pendingApprovals().find(item => item.requestId === reusePending.requestId).reusableParticipants;
    assert(reusable.some(item => item.participantId === approved.participantId));
    await hub.approveJoinReuse(reusePending.requestId, approved.participantId);
    const reuseApproved = await waitFrame(reused, frame => frame.t === "join.approved");
    assert.strictEqual(reuseApproved.participantId, approved.participantId);
    const catchup = await waitFrame(reused, frame => frame.t === "history");
    assert.strictEqual(catchup.mode, "catchup");
    assert.deepStrictEqual(catchup.messages.map(message => message.id), [leaveMessage.id, missed.id]);

    host.send(JSON.stringify({
      t: "admin", room: created.room, action: "edit",
      target: `participant:${approved.participantId}`, name: "Agent Renamed", role: "Reviewer",
    }));
    await waitFrame(reused, frame => frame.t === "renamed" && frame.name === "Agent Renamed");
    await waitFrame(host, frame => frame.t === "presence" && frame.members.some(
      member => member.participantId === approved.participantId && member.user === "Agent Renamed" && member.role === "Reviewer"));
    await waitUntil(async () => (await hub.persistence.identityState(created.roomId)).aliases.some(
      alias => alias.participantId === approved.participantId && alias.alias === "Agent Renamed" && !alias.releasedAt));
    reused.close();
    await waitUntil(async () => (await hub.persistence.identityState(created.roomId)).aliases.some(
      alias => alias.participantId === approved.participantId && alias.alias === "Agent Renamed" && alias.releasedAt));
    host.send(JSON.stringify({ t: "admin", room: created.room, action: "kick", target: `participant:${approved.participantId}` }));
    const rekey = await waitFrame(host, frame => frame.t === "rekey" && frame.secret !== created.secret);
    await waitUntil(async () => (await hub.persistence.identityState(created.roomId)).memberships.some(
      membership => membership.participantId === approved.participantId && membership.forgottenAt));

    const afterForget = await connect(url); sockets.push(afterForget);
    sendJoin(afterForget, created.room, rekey.secret, "Agent Renamed", { roomId: created.roomId });
    const forgottenPending = await waitFrame(afterForget, frame => frame.t === "join.pending");
    assert(!hub.pendingApprovals().find(item => item.requestId === forgottenPending.requestId).reusableParticipants.some(
      item => item.participantId === approved.participantId), "forgotten participant must not be offered for Reuse");
    await hub.rejectJoin(forgottenPending.requestId, "Forgotten identity test complete.");

    const rejected = await connect(url); sockets.push(rejected);
    sendJoin(rejected, created.room, rekey.secret, "Rejected", { roomId: created.roomId });
    const rejectPending = await waitFrame(rejected, frame => frame.t === "join.pending");
    await hub.rejectJoin(rejectPending.requestId, "Host said no.");
    const rejection = await waitFrame(rejected, frame => frame.t === "error" && frame.code === "join-rejected");
    assert.strictEqual(rejection.msg, "Host said no.");

    const keeper = await connect(url); sockets.push(keeper);
    sendJoin(keeper, created.room, rekey.secret, "Keeper", { roomId: created.roomId });
    const keeperPending = await waitFrame(keeper, frame => frame.t === "join.pending");
    await hub.approveJoinNew(keeperPending.requestId);
    const keeperApproved = await waitFrame(keeper, frame => frame.t === "join.approved");
    host.send(JSON.stringify({
      t: "admin", room: created.room, action: "edit",
      target: `participant:${keeperApproved.participantId}`, name: "Keeper", role: "Analyst",
    }));
    await waitUntil(async () => (await hub.persistence.identityState(created.roomId)).memberships.some(
      membership => membership.participantId === keeperApproved.participantId && membership.role === "Analyst"));
    keeper.close();
    await waitUntil(async () => (await hub.persistence.identityState(created.roomId)).aliases.some(
      alias => alias.participantId === keeperApproved.participantId && alias.releasedAt));

    for (const socket of sockets) try { socket.close(); } catch {}
    await hub.stop();
    hub = new ChatHub();
    hub.configureLifecycle(root, 10 * 1024 * 1024, "installation-owner", secrets);
    await hub.start(0);
    const rehosted = await hub.rehostRoom(created.roomId);
    const rehost = await connect(`ws://127.0.0.1:${hub.port}`); sockets.push(rehost);
    sendJoin(rehost, rehosted.room, rehosted.secret, "Host", { roomId: rehosted.roomId, kind: "human", hostToken: rehosted.hostToken });
    const rehostApproved = await waitFrame(rehost, frame => frame.t === "join.approved");
    assert.strictEqual(rehostApproved.participantId, hostApproved.participantId, "Host participant identity must survive Rehost");
    const restoredPresence = await waitFrame(rehost, frame => frame.t === "presence" && frame.members.some(member => member.participantId === keeperApproved.participantId));
    const restoredKeeper = restoredPresence.members.find(member => member.participantId === keeperApproved.participantId);
    assert.strictEqual(restoredKeeper.present, false);
    assert.strictEqual(restoredKeeper.role, "Analyst");
    assert(!restoredPresence.members.some(member => member.participantId === approved.participantId), "forgotten participant must not return in Earlier");
    rehost.send(JSON.stringify({ t: "msg", room: rehosted.room, text: "/leave" }));
    await waitUntil(async () => hub.roomNames.length === 0);
    const storedAfterLeave = await hub.listStoredRooms();
    assert(storedAfterLeave.some(room => room.roomId === rehosted.roomId), "Host /leave must store, not delete, the Room");
    const reopenedAfterLeave = await hub.rehostRoom(rehosted.roomId);
    assert.strictEqual(reopenedAfterLeave.roomId, rehosted.roomId, "Rehost after /leave must preserve Room identity");
    const historyAfterLeave = (await hub.persistence.openRoom(rehosted.roomId, rehosted.room)).messages;
    assert(historyAfterLeave.some(message => message.content === "/leave"), "Rehost after /leave must preserve message history");
    await hub.deactivateRoom(reopenedAfterLeave.room, "test cleanup");
    console.log("hub approval test: Host proof, /leave history retention, New, Reuse, Reject, alias release, and Host Rehost identity OK");
  } finally {
    for (const socket of sockets) try { socket.terminate(); } catch {}
    try { managedClient?.disconnect(); } catch {}
    await hub?.stop().catch(() => {});
    fs.rmSync(root, { recursive: true, force: true });
  }
}

main().catch(error => {
  console.error(error);
  process.exitCode = 1;
});