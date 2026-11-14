import assert from "node:assert/strict";
import { test } from "node:test";
import { createRequire } from "node:module";
import { fork } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync, copyFileSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { initialize } from "../dist/storage.js";
import { inspectLegacyChatroomArchive } from "../dist/legacy-chatroom-continuation.js";
import { createLegacyChatroomClient } from "../dist/legacy-chatroom-runtime.js";

const require = createRequire(import.meta.url);
const fixture = require("../legacy/tests/next-trial-electron/chatroom-live-fixture.cjs");
const project = resolve(new URL("../legacy", import.meta.url).pathname);

test("extension-owned credential bridge scopes a real child and revocation drains its Room", async t => {
  const directory = join(project, ".migration-test-work", `room-ipc-${randomUUID()}`);
  const root = join(directory, "knowledge"), extension = join(directory, "old-source");
  mkdirSync(join(extension, "dist"), { recursive: true });
  const ts = require("typescript");
  for (const name of ["chat-persistence", "chat-persistence-worker"]) {
    writeFileSync(join(extension, name === "chat-persistence" ? "dist" : "", `${name}.js`),
      ts.transpileModule(readFileSync(join(project, "src/chatroom", `${name}.ts`), "utf8"), {
        compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
      }).outputText);
  }
  for (const name of ["sql-wasm.js", "sql-wasm.wasm"])
    copyFileSync(join(project, "node_modules/sql.js/dist", name), join(directory, name));
  const bundle = join(directory, "retained.cjs");
  require("esbuild").buildSync({ stdin: { contents: `
    export {ChatHub} from "./src/chatroom/chatroom-hub";
    export {ChatClient} from "./src/chatroom/chatroom-client";
    export {ChatJoinApprovalManager} from "./src/chatroom/chat-join-approval";
    export {ChatRoomCredentialStore} from "./src/chatroom/chat-room-credentials";
    export {NextRoomResumeStore} from "./src/chatroom/next-room-resume-store";
    export {attachNextRoomHostBridge} from "./src/chatroom/next-room-host-bridge";
    export {WebSocketServer} from "ws";`, resolveDir: project },
    bundle: true, platform: "node", format: "cjs", packages: "external", outfile: bundle, logLevel: "silent" });
  const retained = require(bundle), values = new Map();
  const secrets = { async get(key) { return values.get(key); },
    async store(key, value) { values.set(key, value); }, async delete(key) { values.delete(key); } };
  const credentialStore = new retained.ChatRoomCredentialStore(secrets);
  const credentials = await credentialStore.create(fixture.roomId);
  await initialize(root);
  const child = fork(join(project, "../tests/legacy-chatroom-host-ipc-child.mjs"), [root, bundle],
    { stdio: ["ignore", "ignore", "inherit", "ipc"] });
  let bridge, client, participant;
  const inbox = [];
  child.on("message", message => inbox.push(message));
  const take = async type => {
    const deadline = Date.now() + 15_000;
    while (Date.now() < deadline) {
      const index = inbox.findIndex(message => message.type === type);
      if (index >= 0) return inbox.splice(index, 1)[0];
      if (child.exitCode !== null || child.signalCode !== null) throw new Error(`Room child exited before ${type}.`);
      await new Promise(resolve => setTimeout(resolve, 10));
    }
    throw new Error(`Room child timed out waiting for ${type}.`);
  };
  t.after(async () => {
    client?.disconnect();
    participant?.disconnect();
    bridge?.close();
    if (child.exitCode === null && child.signalCode === null) {
      const exited = new Promise(resolve => child.once("exit", resolve));
      child.kill("SIGTERM");
      await exited;
    }
    rmSync(directory, { recursive: true, force: true });
  });
  const ready = await take("ready");
  await fixture.create({ extension, root, credentials, hostParticipantId: "historic-human" });
  const binding = { root, workspaceId: ready.workspaceId, actorId: "local:owner", roomId: fixture.roomId,
    sourceFingerprint: inspectLegacyChatroomArchive(root, fixture.roomId).sourceFingerprint, operation: "reopen" };
  let allowed = true;
  const approvals = [];
  bridge = retained.attachNextRoomHostBridge({ child, secrets, binding, authorized: () => allowed,
    approveParticipant: candidate => new Promise(resolve => approvals.push({ candidate, resolve })) });
  child.send({ type: "configure", session: bridge.session, binding, legacyReconnect: "host-approval" });
  await take("configured");
  child.send({ type: "probe", binding });
  assert.deepEqual(await take("probe-result"), { type: "probe-result", allowed: false, hasCredentials: false });
  child.send({ type: "reopen", roomId: fixture.roomId });
  const { result } = await take("opened");
  assert.equal(result.authority, "verified-legacy-host-credential");
  assert.equal(result.secret, credentials.joinSecret);
  client = createLegacyChatroomClient(retained.ChatClient, {
    onStatus() {}, onMessage() {}, onHistory() {}, onPresence() {}, onFileComplete() {},
  });
  client.connect({ url: result.url, room: result.room, roomId: fixture.roomId, user: "Host",
    cid: "ipc-host", token: result.secret, hostToken: result.hostToken });
  const deadline = Date.now() + 10_000;
  while (!client.isConnected && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 10));
  assert(client.isConnected);
  assert.equal(client.participantId, "historic-human");
  const wait = async (check, label) => {
    const limit = Date.now() + 10_000;
    while (Date.now() < limit) { if (check()) return; await new Promise(resolve => setTimeout(resolve, 10)); }
    throw new Error(`Timed out: ${label}`);
  };
  const resume = new retained.NextRoomResumeStore(secrets);
  let saved = false, rejected = false, history = [];
  const connectParticipant = () => {
    const peer = new retained.ChatClient({ onStatus() {}, onMessage() {}, onHistory(items) { history = items; },
      onPresence() {}, onFileComplete() {}, onRejected() { rejected = true; },
      loadResumeCredential: (roomId, url, cid, room) => roomId ? resume.load(roomId, url, cid) : resume.loadByName(room, url, cid),
      async onResumeCredential(value, room) { await resume.save(value, room); saved = true; } });
    peer.connect({ url: result.url, room: result.room, user: "Historic Agent",
      cid: "historic-client-1", kind: "agent", token: result.secret });
    return peer;
  };
  participant = connectParticipant();
  await wait(() => approvals.length === 1, "first approval");
  assert.equal(approvals[0].candidate.participantId, "historic-agent");
  assert.equal(approvals[0].candidate.clientId, "historic-client-1");
  assert(client.sendText("@all host remains responsive while approval is pending"));
  let pong = false;
  client.ws.on("message", data => { if (JSON.parse(String(data)).t === "pong") pong = true; });
  client.ws.send(JSON.stringify({ t: "ping" }));
  await wait(() => pong, "host ping while participant approval is pending");
  approvals.shift().resolve(false);
  await wait(() => rejected, "rejected identity recovery");
  assert(!participant.isConnected);
  participant.disconnect();
  rejected = false;
  participant = connectParticipant();
  await wait(() => approvals.length === 1, "second approval");
  const abandoned = approvals.shift();
  participant.disconnect();
  await new Promise(resolve => setTimeout(resolve, 50));
  participant = connectParticipant();
  await wait(() => approvals.length === 1, "replacement approval");
  const pending = approvals.shift();
  abandoned.resolve(true);
  const contender = connectParticipant();
  await wait(() => rejected, "duplicate approval rejected");
  contender.disconnect();
  pending.resolve(true);
  await wait(() => participant.isConnected && saved, "approved historical participant and saved proof");
  assert.equal(participant.participantId, "historic-agent");
  assert(history.some(item => item.id === "history-agent"));
  participant.disconnect();
  await wait(() => !participant.isConnected, "participant disconnect");
  participant = connectParticipant();
  await wait(() => participant.isConnected, "stored participant proof reconnect");
  assert.equal(participant.participantId, "historic-agent");
  assert.equal(approvals.length, 0, "stored proof must not prompt again");
  participant.disconnect();
  await resume.delete(fixture.roomId, result.url, "historic-client-1");
  await resume.deleteName(result.room, result.url, "historic-client-1");
  await new Promise(resolve => setTimeout(resolve, 50));
  participant = connectParticipant();
  await wait(() => approvals.length === 1, "approval before Host revocation");
  const revokedApproval = approvals.shift();
  allowed = false;
  await take("drained");
  revokedApproval.resolve(true);
  assert(!participant.isConnected, "A late approval cannot survive Host revocation.");
  await assert.rejects(fetch(result.url.replace("ws:", "http:")));
});
