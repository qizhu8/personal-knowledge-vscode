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
  const child = spawn("python", [path.join(__dirname, "chat-mcp-approval-client.py"), url, room, roomId, secret, alias, mode], {
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

async function waitPending(hub, alias, timeout = 3000) {
  const started = Date.now();
  while (Date.now() - started < timeout) {
    const pending = hub.pendingApprovals().find(item => item.alias === alias);
    if (pending) return pending;
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  throw new Error(`Timed out waiting for pending alias ${alias}`);
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
    const pending = await waitPending(hub, "Python Agent");
    await new Promise(resolve => setTimeout(resolve, 150));
    assert.strictEqual(approvedClient.child.exitCode, null, "Python chat_join must remain blocked before Host approval");
    await hub.approveJoinNew(pending.requestId);
    const approved = await approvedClient.result;
    assert.strictEqual(approved.ok, true);
    assert(approved.participant_id);
    assert(approved.elapsed >= 0.1);

    const standbyClient = launch(url, room.room, room.roomId, room.secret, "Directed Python", "standby");
    children.push(standbyClient.child);
    const standbyPending = await waitPending(hub, "Directed Python");
    await hub.approveJoinNew(standbyPending.requestId);
    await waitHostFrame(host, frame => frame.t === "agent.state" && frame.user === "Directed Python" && frame.state === "standby");

    host.send(JSON.stringify({ t: "msg", room: room.room, text: "@\"Directed Python\" please respond" }));
    const standby = await standbyClient.result;
    assert.strictEqual(standby.standby_event, "message");
    assert.strictEqual(standby.post_ok, true);
    assert.strictEqual(standby.runtime_state, "standby");
    await waitHostFrame(host, frame => frame.t === "msg" && frame.text === "@Host directed response");
    await waitHostFrame(host, frame => frame.t === "agent.state" && frame.user === "Directed Python" && frame.state === "standby");

    const stoppedClient = launch(url, room.room, room.roomId, room.secret, "Stopped Python", "stop");
    children.push(stoppedClient.child);
    const stoppedPending = await waitPending(hub, "Stopped Python");
    await hub.approveJoinNew(stoppedPending.requestId);
    await waitHostFrame(host, frame => frame.t === "agent.state" && frame.user === "Stopped Python" && frame.state === "standby");
    const conversation = hub.rooms.get(room.room).conversation;
    conversation.active = true;
    conversation.participants = ["Stopped Python"];
    await hub.postCoordinatorMessage(room.room, "Conversation started — active agents: @\"Stopped Python\".");
    host.send(JSON.stringify({ t: "msg", room: room.room, text: "/stop_conversation" }));
    const stopped = await stoppedClient.result;
    assert.strictEqual(stopped.standby_event, "stopped");
    assert.strictEqual(stopped.runtime_state, "idle");

    const historyClient = launch(url, room.room, room.roomId, room.secret, "History Python", "history");
    children.push(historyClient.child);
    const historyPending = await waitPending(hub, "History Python");
    await hub.approveJoinNew(historyPending.requestId);
    const historyResult = await historyClient.result;
    assert.strictEqual(historyResult.standby_event, "timeout",
      "historical /stop_conversation must remain behind the standby cursor after Join");
    assert.strictEqual(historyResult.runtime_state, "standby");

    const inactiveStopClient = launch(url, room.room, room.roomId, room.secret, "Inactive Stop Python", "inactive-stop");
    children.push(inactiveStopClient.child);
    const inactiveStopPending = await waitPending(hub, "Inactive Stop Python");
    await hub.approveJoinNew(inactiveStopPending.requestId);
    await waitHostFrame(host, frame => frame.t === "agent.state" && frame.user === "Inactive Stop Python" && frame.state === "standby");
    host.send(JSON.stringify({ t: "msg", room: room.room, text: "/stop_conversation" }));
    const inactiveStop = await inactiveStopClient.result;
    assert.strictEqual(inactiveStop.standby_event, "timeout", "inactive conversation stop must not terminate standby");
    assert.strictEqual(inactiveStop.runtime_state, "standby");

    const rejectedClient = launch(url, room.room, room.roomId, room.secret, "Rejected Python");
    children.push(rejectedClient.child);
    const rejectedPending = await waitPending(hub, "Rejected Python");
    await hub.rejectJoin(rejectedPending.requestId, "Rejected by integration test.");
    const rejected = await rejectedClient.result;
    assert.strictEqual(rejected.ok, false);
    assert.match(rejected.error, /Rejected by integration test/);

    const closedClient = launch(url, room.room, room.roomId, room.secret, "Closed Python", "closed");
    children.push(closedClient.child);
    const closedPending = await waitPending(hub, "Closed Python");
    await hub.approveJoinNew(closedPending.requestId);
    await waitHostFrame(host, frame => frame.t === "agent.state" && frame.user === "Closed Python" && frame.state === "standby");
    host.send(JSON.stringify({ t: "leave", room: room.room }));
    const closed = await closedClient.result;
    assert.strictEqual(closed.standby_event, "closed");
    assert.strictEqual(closed.runtime_state, "idle");
    assert.strictEqual(hub.roomNames.length, 0, "Host leave must deactivate the Room for every participant");
    console.log("MCP approval test: Join, auto-standby, directed wake, post recovery, rejection, and Host-leave close OK");
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