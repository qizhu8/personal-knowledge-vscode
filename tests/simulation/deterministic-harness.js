"use strict";

const fs = require("fs");
const path = require("path");
const { WebSocket } = require("ws");
const { ChatHub } = require("../../dist/chatroom-hub");

class MemorySecretStorage {
  constructor(seed) { this.values = new Map(seed || []); }
  async get(key) { return this.values.get(key); }
  async store(key, value) { this.values.set(key, value); }
  async delete(key) { this.values.delete(key); }
}

class DeterministicClock {
  constructor(iso = "2020-01-01T00:00:00.000Z") { this.value = Date.parse(iso); }
  now = () => this.value;
  iso = () => new Date(this.value).toISOString();
  tick(milliseconds = 1) { this.value += milliseconds; return this.value; }
}

class DeterministicIds {
  constructor(prefix = "sim") { this.prefix = prefix; this.index = 0; }
  next = () => `${this.prefix}-${++this.index}`;
}

async function waitFor(predicate, description = "condition", timeout = 4000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const value = await predicate();
    if (value) return value;
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  throw new Error(`Timed out waiting for ${description}`);
}

class SimulatedActor {
  constructor(harness, name, kind, cid, temporary = false) {
    this.harness = harness;
    this.name = name;
    this.kind = kind;
    this.cid = cid;
    this.temporary = temporary;
    this.frames = [];
    this.socket = null;
    this.resumeAfter = "";
  }

  async connect(room, hostToken) {
    const socket = new WebSocket(this.harness.url);
    this.socket = socket;
    socket.on("message", raw => {
      const frame = JSON.parse(raw.toString());
      this.frames.push(frame);
      if (frame.t === "msg" && frame.id) this.resumeAfter = frame.id;
      if (frame.t === "history" && frame.messages.length) this.resumeAfter = frame.messages.at(-1).id;
    });
    await new Promise((resolve, reject) => {
      socket.once("open", resolve);
      socket.once("error", reject);
    });
    socket.send(JSON.stringify({
      t: "join", room: room.room, roomId: room.roomId, token: room.secret,
      user: this.name, kind: this.kind, cid: this.cid, hostToken,
      resumeAfter: this.resumeAfter || undefined, temporary: this.temporary,
    }));
    await this.wait(frame => frame.t === "join.ready", "join.ready");
    return this;
  }

  send(text, options = {}) {
    this.socket.send(JSON.stringify({ t: "msg", room: this.harness.room.room, text, kind: this.kind, ...options }));
  }

  wait(predicate, description) {
    return waitFor(() => this.frames.find(predicate), `${this.name} ${description}`);
  }

  waitCount(predicate, count, description) {
    return waitFor(() => {
      const matches = this.frames.filter(predicate);
      return matches.length >= count ? matches : undefined;
    }, `${this.name} ${description}`);
  }

  async disconnect() {
    if (!this.socket || this.socket.readyState === WebSocket.CLOSED) return;
    const socket = this.socket;
    socket.terminate();
    await waitFor(() => socket.readyState === WebSocket.CLOSED, `${this.name} disconnect`);
  }

  async reconnect(room = this.harness.room, hostToken) {
    await this.disconnect();
    return this.connect(room, hostToken);
  }
}

class DeterministicSimulationHarness {
  constructor(label = "chatroom-project") {
    this.root = fs.mkdtempSync(path.join(process.cwd(), `.simulation-${label}-`));
    this.chatroomsRoot = path.join(this.root, "chatrooms");
    this.projectsRoot = path.join(this.root, "projects");
    this.sessionsRoot = path.join(this.root, "sessions");
    this.notesRoot = path.join(this.root, "notes");
    this.clock = new DeterministicClock();
    this.ids = new DeterministicIds();
    this.secrets = new MemorySecretStorage();
    this.actors = [];
    this.hub = null;
    this.room = null;
  }

  async startHub() {
    this.hub = new ChatHub();
    this.hub.configureLifecycle(this.chatroomsRoot, 10 * 1024 * 1024, "simulation-installation", this.secrets);
    await this.hub.start(0);
    this.url = `ws://127.0.0.1:${this.hub.port}`;
    return this.hub;
  }

  async createRoom(name = "Deterministic Journey", ownership) {
    this.room = await this.hub.createRoom(name, "deterministic-secret", ownership);
    return this.room;
  }

  actor(name, kind, options = {}) {
    const actor = new SimulatedActor(this, name, kind, options.cid || `identity-${name.toLowerCase()}`, options.temporary);
    this.actors.push(actor);
    return actor;
  }

  async restartHub() {
    for (const actor of this.actors) await actor.disconnect();
    await this.hub.stop();
    await this.startHub();
    this.room = await this.hub.rehostRoom(this.room.roomId);
    return this.room;
  }

  async dispose() {
    for (const actor of this.actors) await actor.disconnect().catch(() => {});
    await this.hub?.stop().catch(() => {});
    fs.rmSync(this.root, { recursive: true, force: true });
  }
}

module.exports = {
  DeterministicClock,
  DeterministicIds,
  DeterministicSimulationHarness,
  MemorySecretStorage,
  waitFor,
};
