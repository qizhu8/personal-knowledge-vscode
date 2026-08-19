#!/usr/bin/env node
const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawn } = require("child_process");
const { WebSocket } = require("ws");
const { ChatHub } = require("../dist/chatroom-hub");

class MemorySecretStorage {
  constructor() { this.values = new Map(); }
  async get(key) { return this.values.get(key); }
  async store(key, value) { this.values.set(key, value); }
  async delete(key) { this.values.delete(key); }
}

function launch(url, room, roomId, secret, alias, mode = "join") {
  const child = spawn("python", [path.join(__dirname, "..", "scripts", "chat-mcp-approval-client.py"), url, room, roomId, secret, alias, mode], {
    cwd: path.join(__dirname, ".."), stdio: ["ignore", "pipe", "pipe"],
  });
  let stdout = "", stderr = "";
  child.stdout.on("data", data => { stdout += data; });
  child.stderr.on("data", data => { stderr += data; });
  const result = new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", code => {
      if (code) reject(new Error(`Python client exited ${code}: ${stderr}`));
      else {
        try { resolve(JSON.parse(stdout.trim())); }
        catch { reject(new Error(`Invalid Python client output: ${stdout}\n${stderr}`)); }
      }
    });
  });
  return { child, result };
}

function connectHost(url, room) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url);
    ws.once("error", reject);
    ws.once("open", () => ws.send(JSON.stringify({
      t: "join", room: room.room, roomId: room.roomId, user: "Host", token: room.secret,
      kind: "human", cid: "host-cid", hostToken: room.hostToken,
    })));
    ws.frames = [];
    ws.on("message", raw => {
      const frame = JSON.parse(raw.toString());
      ws.frames.push(frame);
      if (frame.t === "join.approved") resolve(ws);
    });
  });
}

async function waitHostFrame(host, predicate, timeout = 3000) {
  const started = Date.now();
  while (Date.now() - started < timeout) {
    const frame = host.frames.find(predicate);
    if (frame) return frame;
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  throw new Error(`Timed out waiting for Host frame: ${JSON.stringify(host.frames)}`);
}

async function main() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pkm-mcp-approval-test-"));
  let hub;
  let host;
  const children = [];
  try {
    hub = new ChatHub();
    hub.configureLifecycle(root, 10 * 1024 * 1024, "owner", new MemorySecretStorage());
    await hub.start(0);
    const room = await hub.createRoom("MCP Approval", "mcp-secret");
    const url = `ws://127.0.0.1:${hub.port}`;
    host = await connectHost(url, room);

    const approvedClient = launch(url, room.room, room.roomId, room.secret, "Python Agent");
    children.push(approvedClient.child);
    const approved = await approvedClient.result;
    assert.strictEqual(approved.ok, true);
    assert(approved.participant_id);
    assert(approved.elapsed < 1, "valid-secret chat_join must not wait for Host approval");

    const standbyClient = launch(url, room.room, room.roomId, room.secret, "Directed Python", "standby");
    children.push(standbyClient.child);
    await waitHostFrame(host, frame => frame.t === "agent.state" && frame.user === "Directed Python" && frame.state === "standby");

    host.send(JSON.stringify({ t: "msg", room: room.room, text: "@\"Directed Python\" please respond" }));
    const standby = await standbyClient.result;
    assert.strictEqual(standby.standby_event, "message");
    assert.strictEqual(standby.reply_required, true);
    assert.strictEqual(standby.reply_required_event_ids.length, 1);
    assert.strictEqual(standby.post_ok, true);
    assert.strictEqual(standby.runtime_state, "standby");
    await waitHostFrame(host, frame => frame.t === "msg" && frame.text === "@Host directed response");
    await waitHostFrame(host, frame => frame.t === "agent.state" && frame.user === "Directed Python" && frame.state === "standby");

    const stoppedClient = launch(url, room.room, room.roomId, room.secret, "Stopped Python", "stop");
    children.push(stoppedClient.child);
    await waitHostFrame(host, frame => frame.t === "agent.state" && frame.user === "Stopped Python" && frame.state === "standby");
    const rekeysBeforeStop = host.frames.filter(frame => frame.t === "rekey").length;
    host.send(JSON.stringify({ t: "msg", room: room.room, text: "/stop @\"Stopped Python\"" }));
    const stopped = await stoppedClient.result;
    assert.strictEqual(stopped.standby_event, "stopped");
    assert.strictEqual(stopped.standby_scope, "chatroom");
    assert.strictEqual(stopped.runtime_state, "idle");
    await waitHostFrame(host, frame => frame.t === "presence" && frame.members.some(member =>
      member.participantId === stopped.participant_id && member.present === false));
    const stoppedIdentity = await hub.persistence.identityState(room.roomId);
    const stoppedMembership = stoppedIdentity.memberships.find(item => item.participantId === stopped.participant_id);
    assert(stoppedMembership && stoppedMembership.forgottenAt == null, "/stop must preserve participant membership");
    assert.strictEqual(host.frames.filter(frame => frame.t === "rekey").length, rekeysBeforeStop,
      "/stop must not rotate the Room secret");

    const rejectedClient = launch(url, room.room, room.roomId, "wrong-secret", "Rejected Python");
    children.push(rejectedClient.child);
    const rejected = await rejectedClient.result;
    assert.strictEqual(rejected.ok, false);
    assert.strictEqual(rejected.error_code, "auth");

    const closedClient = launch(url, room.room, room.roomId, room.secret, "Closed Python", "closed");
    children.push(closedClient.child);
    await waitHostFrame(host, frame => frame.t === "agent.state" && frame.user === "Closed Python" && frame.state === "standby");
    host.send(JSON.stringify({ t: "leave", room: room.room }));
    const closed = await closedClient.result;
    assert.strictEqual(closed.standby_event, "closed");
    assert.strictEqual(closed.runtime_state, "idle");
    assert.strictEqual(hub.roomNames.length, 0, "Host leave must deactivate the Room for every participant");
    console.log("MCP Join test: immediate Join, auto-standby, directed wake, stop-to-Earlier, auth rejection, and Host-leave close OK");
  } finally {
    for (const child of children) if (child.exitCode === null) child.kill("SIGTERM");
    try { host?.terminate(); } catch {}
    await hub?.stop().catch(() => {});
    fs.rmSync(root, { recursive: true, force: true });
  }
}

main().catch(error => {
  console.error(error);
  process.exitCode = 1;
});