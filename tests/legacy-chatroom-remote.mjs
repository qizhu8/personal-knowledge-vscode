import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync, copyFileSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { join, resolve } from "node:path";
import { initialize, Storage } from "../dist/storage.js";
import { inspectLegacyChatroomArchive } from "../dist/legacy-chatroom-continuation.js";
import { createLegacyChatroomHostAuthority } from "../dist/legacy-chatroom-host-authority.js";
import { createLegacyChatroomClient, LegacyChatroomRuntime } from "../dist/legacy-chatroom-runtime.js";

const require = createRequire(import.meta.url);
const project = resolve(new URL("../legacy", import.meta.url).pathname);
const fixture = require("../legacy/tests/next-trial-electron/chatroom-live-fixture.cjs");
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(check, label) {
  for (let i = 0; i < 400; i++) { const value = check(); if (value) return value; await delay(25); }
  throw new Error(`Timed out: ${label}`);
}

if (process.argv[2] === "--peer") {
  let client;
  const report = value => { if (process.connected) process.send(value); };
  process.send({ type: "namespace", pid: process.pid });
  process.on("message", async message => {
    try {
      if (message.type === "join") {
        client?.disconnect();
        const retained = require(message.retained);
        client = createLegacyChatroomClient(retained.ChatClient, {
          onStatus(status) { if (status === "connected") report({ type: "connected", participantId: client.participantId }); },
          onMessage(value) { report({ type: "message", text: value.text }); },
          onHistory() {}, onPresence() {},
          onRejected(code, message) { report({ type: "rejected", code, message }); },
          onResumeCredential() { report({ type: "credential" }); },
          onFileComplete(meta, _from, bytes) { report({ type: "file", name: meta.name, size: bytes.length, byte: bytes[0] }); },
        });
        client.connect({ ...message.options, user: message.user || "Remote Peer", cid: message.cid || "remote-peer",
          kind: message.kind || "human" });
      } else if (message.type === "send") {
        assert(client.sendText("@Host peer-to-host"));
      } else if (message.type === "reconnect") {
        client.ws.terminate();
      } else if (message.type === "close") {
        client?.disconnect();
        process.disconnect();
      }
    } catch (error) { process.send({ type: "error", message: String(error) }); }
  });
} else if (process.argv[2] !== "--inside") {
  const result = spawnSync("unshare", ["-Urn", process.execPath, process.argv[1], "--inside"],
    { cwd: project, env: { PATH: process.env.PATH || "" }, stdio: "inherit", timeout: 90000 });
  if (result.error || result.status !== 0) throw result.error || new Error(`Private remote test failed: ${result.status ?? result.signal}`);
} else {
  const directory = join(project, ".migration-test-work", `remote-room-${randomUUID()}`);
  const root = join(directory, "knowledge"), extension = join(directory, "legacy-source");
  let peer, storage, runtime, host;
  const messages = [];
  function run(command, args) {
    const result = spawnSync(command, args, { stdio: "pipe" });
    if (result.status !== 0) throw new Error(`${command} failed: ${result.stderr}`);
  }
  try {
    mkdirSync(join(extension, "dist"), { recursive: true, mode: 0o700 });
    const ts = require("typescript");
    for (const name of ["chat-persistence", "chat-persistence-worker"]) {
      writeFileSync(join(extension, name === "chat-persistence" ? "dist" : "", `${name}.js`),
        ts.transpileModule(readFileSync(join(project, "src/chatroom", `${name}.ts`), "utf8"), {
          compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
        }).outputText);
    }
    for (const name of ["sql-wasm.js", "sql-wasm.wasm"])
      copyFileSync(join(project, "node_modules/sql.js/dist", name), join(directory, name));
    const retainedFile = join(directory, "retained.cjs");
    require("esbuild").buildSync({ stdin: { contents: `
      export {ChatHub} from "./src/chatroom/chatroom-hub";
      export {ChatClient} from "./src/chatroom/chatroom-client";
      export {ChatJoinApprovalManager} from "./src/chatroom/chat-join-approval";
      export {ChatRoomCredentialStore} from "./src/chatroom/chat-room-credentials";
      export {WebSocketServer} from "ws";`, resolveDir: project },
      bundle: true, platform: "node", format: "cjs", packages: "external", outfile: retainedFile, logLevel: "silent" });
    const retained = require(retainedFile);
    await initialize(root);
    storage = await Storage.open(root, { deferRecovery: true });
    const secrets = new Map(), credentialStore = new retained.ChatRoomCredentialStore({
      async get(key) { return secrets.get(key); },
      async store(key, value) { secrets.set(key, value); },
      async delete(key) { secrets.delete(key); },
    });
    const credentials = await credentialStore.create(fixture.roomId);
    await fixture.create({ extension, root, credentials, hostParticipantId: "historic-human" });
    const binding = { root, workspaceId: await storage.workspaceId(), actorId: "isolated-fixture-host",
      roomId: fixture.roomId, sourceFingerprint: inspectLegacyChatroomArchive(root, fixture.roomId).sourceFingerprint, operation: "reopen" };
    const authorize = createLegacyChatroomHostAuthority({ storage, actorId: binding.actorId, credentials: credentialStore,
      authorizeActor: async actual => Object.entries(binding).every(([key, value]) => actual[key] === value) });

    peer = spawn("unshare", ["-n", process.execPath, process.argv[1], "--peer"],
      { cwd: project, env: { PATH: process.env.PATH || "" }, stdio: ["ignore", "ignore", "inherit", "ipc"] });
    peer.on("message", value => messages.push(value));
    peer.on("error", error => messages.push({ type: "error", message: String(error) }));
    const ns = await until(() => messages.find(value => value.type === "namespace"), "peer network namespace");
    run("ip", ["link", "set", "lo", "up"]);
    run("ip", ["link", "add", "pkmhost", "type", "veth", "peer", "name", "pkmpeer"]);
    run("ip", ["link", "set", "pkmpeer", "netns", String(ns.pid)]);
    run("ip", ["addr", "add", "10.77.0.1/30", "dev", "pkmhost"]);
    run("ip", ["link", "set", "pkmhost", "up"]);
    for (const args of [["link", "set", "lo", "up"], ["addr", "add", "10.77.0.2/30", "dev", "pkmpeer"],
      ["link", "set", "pkmpeer", "up"]]) run("nsenter", ["-t", String(ns.pid), "-n", "ip", ...args]);
    const approvals = [];
    runtime = new LegacyChatroomRuntime({ storage, actorId: binding.actorId, retained, authorize,
      legacyReconnect: "host-approval",
      approveLegacyParticipant: candidate => new Promise(resolve => approvals.push({ candidate, resolve })),
      network: { bindAddress: "10.77.0.1", advertisedHost: "10.77.0.1", port: 0 } });
    const opened = await runtime.reopen(fixture.roomId);
    let remoteText = false;
    const hostEvents = [];
    host = createLegacyChatroomClient(retained.ChatClient, {
      onStatus() {}, onMessage(value) { hostEvents.push(value.text); if (value.text === "@Host peer-to-host") remoteText = true; },
      onHistory() {}, onPresence() {}, onFileComplete() {},
    });
    host.connect({ ...opened, roomId: fixture.roomId, user: "Host", cid: "host", token: opened.secret });
    peer.send({ type: "join", retained: retainedFile, options: { url: opened.url, room: opened.room,
      roomId: fixture.roomId, token: opened.secret } });
    await until(() => host.isConnected && messages.some(value => value.type === "connected")
      && messages.some(value => value.type === "credential"), "remote join and credential");
    const participantId = messages.find(value => value.type === "connected").participantId;
    peer.send({ type: "send" });
    assert(host.sendText("@all host-to-peer"));
    try { await until(() => remoteText && messages.some(value => value.type === "message" && value.text === "@all host-to-peer"), "bidirectional messages"); }
    catch (error) { throw new Error(`${error}; host=${JSON.stringify(hostEvents)} peer=${JSON.stringify(messages)}`); }
    const file = await host.sendFile("remote.bin", "application/octet-stream", Buffer.alloc(65537, 0x5a));
    assert(file.ok);
    const received = await until(() => messages.find(value => value.type === "file"), "remote attachment");
    assert.deepEqual({ name: received.name, size: received.size, byte: received.byte }, { name: "remote.bin", size: 65537, byte: 0x5a });
    peer.send({ type: "reconnect" });
    const reconnected = await until(() => messages.filter(value => value.type === "connected").length >= 2
      && messages.filter(value => value.type === "connected").at(-1), "remote reconnect");
    assert.equal(reconnected.participantId, participantId);
    const previousCount = messages.filter(value => value.type === "connected").length;
    peer.send({ type: "join", retained: retainedFile, user: "Historic Agent", cid: "historic-client-1", kind: "agent",
      options: { url: opened.url, room: opened.room, roomId: fixture.roomId, token: opened.secret } });
    const approval = await until(() => approvals.shift(), "remote historical identity approval");
    assert.equal(approval.candidate.participantId, "historic-agent");
    approval.resolve(true);
    const historical = await until(() => messages.filter(value => value.type === "connected").length > previousCount
      && messages.filter(value => value.type === "connected").at(-1), "remote historical participant");
    assert.equal(historical.participantId, "historic-agent");
    await until(() => messages.filter(value => value.type === "credential").length >= 2, "historical participant credential");
    peer.send({ type: "reconnect" });
    const historicalReconnect = await until(() => messages.filter(value => value.type === "connected").length > previousCount + 1
      && messages.filter(value => value.type === "connected").at(-1), "historical participant credential reconnect");
    assert.equal(historicalReconnect.participantId, "historic-agent");
    assert.equal(approvals.length, 0);
    assert(!messages.some(value => value.type === "error"), JSON.stringify(messages));
    console.log("PASS private separate network namespaces: messages, attachment and approved historical identity credential reconnect");
  } finally {
    host?.disconnect();
    if (peer && peer.exitCode === null && peer.signalCode === null) {
      const exited = new Promise(resolve => peer.once("exit", resolve));
      if (peer.connected) peer.send({ type: "close" }); else peer.kill("SIGTERM");
      await exited;
    }
    try { await runtime?.drain(); } finally {
      try { await storage?.close(); } finally { rmSync(directory, { recursive: true, force: true }); }
    }
  }
}
