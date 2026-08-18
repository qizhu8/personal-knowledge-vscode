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
    assert.deepStrictEqual(hub.leadingMentionNames('@Host discusses `@all` behavior'), ['Host']);
    assert.deepStrictEqual(hub.leadingMentionNames('plain text mentions @all later'), []);
    assert.deepStrictEqual(hub.leadingMentionNames('/stop @"Agent One"'), ['Agent One']);
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
        onRejected: (_code, message) => reject(new Error(message)),
      });
      managedClient.connect({ url, room: created.room, roomId: created.roomId, user: "Managed Agent", token: created.secret, kind: "agent", cid: "managed-test" });
    });
    await managedConnected;
    assert(managedClient.participantId, "managed agent must receive a participant ID through automatic Join");
    managedClient.disconnect();

    const mismatched = await connect(url); sockets.push(mismatched);
    sendJoin(mismatched, created.room, created.secret, "Wrong Room", { roomId: "different-room-id" });
    await waitFrame(mismatched, frame => frame.t === "error" && frame.code === "room-mismatch");
    assert.strictEqual(hub.pendingApprovals().length, 0, "Room ID mismatch must fail before reserving an alias");

    let guest = await connect(url); sockets.push(guest);
    sendJoin(guest, created.room, created.secret, "Agent One", { roomId: created.roomId });
    const approved = await waitFrame(guest, frame => frame.t === "join.approved");
    await waitFrame(guest, frame => frame.t === "presence");
    await waitFrame(host, frame => frame.t === "agent.state" && frame.user === "Agent One" && frame.state === "idle");
    guest.send(JSON.stringify({ t: "agent.state", room: created.room, state: "standby" }));
    await waitFrame(host, frame => frame.t === "agent.state" && frame.user === "Agent One" && frame.state === "standby");
    await waitFrame(host, frame => frame.t === "presence" && frame.members.some(member =>
      member.user === "Agent One" && member.runtimeState === "standby"));
    assert.notStrictEqual(approved.participantId, hostApproved.participantId);
    guest.send(JSON.stringify({ t: "msg", room: created.room, text: "message without direction" }));
    await waitFrame(guest, frame => frame.t === "error" && frame.code === "mention-required");
    assert(!host.frames.some(frame => frame.t === "msg" && frame.text === "message without direction"));
    guest.send(JSON.stringify({ t: "msg", room: created.room, text: "@Host participant identity message" }));
    const participantMessage = await waitFrame(host, frame => frame.t === "msg" && frame.text === "@Host participant identity message");
    assert.strictEqual(participantMessage.fromId, approved.participantId);
    assert.strictEqual(participantMessage.responseRequired, true, "require_reply must default true");
    guest.send(JSON.stringify({ t: "msg", room: created.room, text: "@Host substantive question", requireReply: true }));
    const explicitQuestion = await waitFrame(host, frame => frame.t === "msg" && frame.text === "@Host substantive question");
    assert.strictEqual(explicitQuestion.responseRequired, true, "Agent may explicitly continue a substantive discussion");
    guest.send(JSON.stringify({ t: "msg", room: created.room, text: "@Host FYI only", requireReply: false }));
    const explicitFyi = await waitFrame(host, frame => frame.t === "msg" && frame.text === "@Host FYI only");
    assert.strictEqual(explicitFyi.responseRequired, false);
    host.send(JSON.stringify({ t: "msg", room: created.room, text: "@all broadcast update" }));
    const broadcast = await waitFrame(guest, frame => frame.t === "msg" && frame.text === "@all broadcast update");
    assert.strictEqual(broadcast.responseRequired, true, "Host @all must request replies by default");
    guest.send(JSON.stringify({ t: "msg", room: created.room, text: "@all guest FYI" }));
    await waitFrame(guest, frame => frame.t === "error" && frame.code === "host-only-broadcast");
    assert(!host.frames.some(frame => frame.t === "msg" && frame.text === "@all guest FYI"), "non-Host @all must not broadcast");
    const duplicateAlias = await connect(url); sockets.push(duplicateAlias);
    sendJoin(duplicateAlias, created.room, created.secret, "Agent One", { roomId: created.roomId });
    const duplicateApproved = await waitFrame(duplicateAlias, frame => frame.t === "join.approved");
    assert.strictEqual(duplicateApproved.participantId, approved.participantId,
      "same alias and cid must reconnect by reusing the existing identity without Host approval");
    guest = duplicateAlias;
    const collidingAlias = await connect(url); sockets.push(collidingAlias);
    sendJoin(collidingAlias, created.room, created.secret, "Agent One", { roomId: created.roomId, cid: "different-cid" });
    await waitFrame(collidingAlias, frame => frame.t === "error" && frame.code === "name-taken");
    assert.strictEqual(hub.pendingApprovals().length, 0, "an alias collision must fail immediately without reserving approval");
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
    const reuseApproved = await waitFrame(reused, frame => frame.t === "join.approved");
    assert.strictEqual(reuseApproved.participantId, approved.participantId);
    const catchup = await waitFrame(reused, frame => frame.t === "history");
    assert.strictEqual(catchup.mode, "catchup");
    assert.deepStrictEqual(catchup.messages.map(message => message.id), [explicitQuestion.id, explicitFyi.id, broadcast.id, leaveMessage.id, missed.id]);
    assert.strictEqual(catchup.messages.find(message => message.id === explicitFyi.id).responseRequired, false,
      "explicit no-reply intent must survive persistence");

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
    await waitUntil(async () => (await hub.persistence.identityState(created.roomId)).memberships.some(
      membership => membership.participantId === approved.participantId && membership.forgottenAt));
    assert.strictEqual(host.frames.filter(frame => frame.t === "rekey").length, 0,
      "removing a member must not rotate the Room secret");

    const afterForget = await connect(url); sockets.push(afterForget);
    sendJoin(afterForget, created.room, created.secret, "Agent Renamed", { roomId: created.roomId });
    const afterForgetApproved = await waitFrame(afterForget, frame => frame.t === "join.approved");
    assert.notStrictEqual(afterForgetApproved.participantId, approved.participantId,
      "a forgotten client identity must receive a new participant ID");
    afterForget.close();

    const rotatedSecret = await hub.rotateRoomSecret(created.room);
    assert(rotatedSecret && rotatedSecret !== created.secret, "manual rotation must create a new Room secret");
    await waitFrame(host, frame => frame.t === "rekey" && frame.secret === rotatedSecret);

    const keeper = await connect(url); sockets.push(keeper);
    sendJoin(keeper, created.room, rotatedSecret, "Keeper", { roomId: created.roomId });
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
    const activeRenamed = await hub.renameActiveRoom(rehosted.roomId, "Approval Renamed");
    assert.strictEqual(activeRenamed, "approval renamed");
    await waitFrame(rehost, frame => frame.t === "room.renamed" && frame.room === "approval renamed");
    assert.deepStrictEqual(hub.roomNames, ["approval renamed"]);
    const hostSocketClosed = new Promise(resolve => rehost.once("close", resolve));
    rehost.close();
    await hostSocketClosed;
    await new Promise(resolve => setTimeout(resolve, 50));
    assert.deepStrictEqual(hub.roomNames, ["approval renamed"],
      "closing the Host tab/socket must not close the hosted Room");

    const reconnectedHost = await connect(`ws://127.0.0.1:${hub.port}`); sockets.push(reconnectedHost);
    sendJoin(reconnectedHost, activeRenamed, rehosted.secret, "Host", {
      roomId: rehosted.roomId, kind: "human", hostToken: rehosted.hostToken,
    });
    await waitFrame(reconnectedHost, frame => frame.t === "join.ready");
    reconnectedHost.send(JSON.stringify({ t: "msg", room: activeRenamed, text: "/leave" }));
    await waitUntil(async () => hub.roomNames.length === 0);
    const storedAfterLeave = await hub.listStoredRooms();
    assert(storedAfterLeave.some(room => room.roomId === rehosted.roomId), "Host /leave must store, not delete, the Room");
    const reopenedAfterLeave = await hub.rehostRoom(rehosted.roomId);
    assert.strictEqual(reopenedAfterLeave.roomId, rehosted.roomId, "Rehost after /leave must preserve Room identity");
    const historyAfterLeave = (await hub.persistence.openRoom(rehosted.roomId, rehosted.room)).messages;
    assert(historyAfterLeave.some(message => message.content === "/leave"), "Rehost after /leave must preserve message history");
    await hub.deactivateRoom(reopenedAfterLeave.room, "test cleanup");
    console.log("hub Join test: valid-secret auto Join, credential resume, collision, alias release, and Host Rehost identity OK");
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