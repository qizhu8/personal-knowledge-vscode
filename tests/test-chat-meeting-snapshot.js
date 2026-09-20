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
    const socket = new WebSocket(url); socket.frames = [];
    socket.on("message", raw => socket.frames.push(JSON.parse(raw.toString())));
    socket.once("open", () => resolve(socket)); socket.once("error", reject);
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
function join(socket, room, user, hostToken) {
  socket.send(JSON.stringify({ t:"join", room:room.room, roomId:room.roomId, token:room.secret, user, kind:"human", cid:`${user}-cid`, hostToken }));
}

async function main() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pkm-meeting-snapshot-"));
  const sockets = []; let hub;
  try {
    hub = new ChatHub();
    hub.configureLifecycle(root, 1024 * 1024, "owner", new MemorySecretStorage());
    await hub.start(0);
    const room = await hub.createRoom("Meeting Visibility", "secret");
    const url = `ws://127.0.0.1:${hub.port}`;
    const host = await connect(url); sockets.push(host); join(host, room, "Host", room.hostToken);
    await waitFor(() => host.frames.find(frame => frame.t === "join.ready"));
    const attendee = await connect(url); sockets.push(attendee); join(attendee, room, "Attendee");
    await waitFor(() => attendee.frames.find(frame => frame.t === "join.ready"));

    const snapshot = { current:{ id:"meeting-1", revision:1, participants:["Host", "Attendee"] }, history:[], trash:[] };
    attendee.send(JSON.stringify({ t:"meeting.snapshot", room:room.room, snapshot:{ current:null, history:[], trash:[] } }));
    const rejected = await waitFor(() => attendee.frames.find(frame => frame.t === "error" && frame.code === "meeting-host-only"));
    assert.strictEqual(rejected.connectionAlive, true);

    host.send(JSON.stringify({ t:"meeting.snapshot", room:room.room, snapshot }));
    const delivered = await waitFor(() => attendee.frames.find(frame => frame.t === "meeting.snapshot"));
    assert.deepStrictEqual(delivered.snapshot, snapshot);

    const late = await connect(url); sockets.push(late); join(late, room, "Late Attendee");
    const replayed = await waitFor(() => late.frames.find(frame => frame.t === "meeting.snapshot"));
    assert.deepStrictEqual(replayed.snapshot, snapshot);
    console.log("chat Meeting snapshot test: owner-only publish, attendee delivery, and late-join replay OK");
  } finally {
    for (const socket of sockets) try { socket.terminate(); } catch {}
    await hub?.stop().catch(() => {});
    fs.rmSync(root, { recursive:true, force:true });
  }
}
main().catch(error => { console.error(error); process.exitCode = 1; });