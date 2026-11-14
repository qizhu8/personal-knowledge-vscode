import assert from "node:assert/strict";
import { test } from "node:test";
import { fork } from "node:child_process";
import { createRequire } from "node:module";
import { mkdirSync, rmSync, existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { randomBytes, randomUUID } from "node:crypto";
import { pathToFileURL } from "node:url";

const require = createRequire(import.meta.url), esbuild = require("esbuild");
const project = resolve(new URL("../legacy", import.meta.url).pathname);
const build = resolve(process.env.PKM_ROOM_RECOVERY_BUILD || join(project, "../dist"));
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));

test("new native Room requires the real profile bridge and survives a Host child crash", async t => {
  const directory = join(project, ".migration-test-work", `native-room-${randomUUID()}`);
  const parent = join(directory, "trial"), root = join(parent, "workspace"), legacyRoot = join(directory, "legacy");
  for (const dir of [parent, legacyRoot]) mkdirSync(dir, { recursive: true, mode: 0o700 });
  const bundle = join(directory, "test-bridge.cjs");
  esbuild.buildSync({ stdin: { contents: `
    export {ChatClient} from "./src/chatroom/chatroom-client";
    export {ChatRoomCredentialStore} from "./src/chatroom/chat-room-credentials";
    export {NextRoomResumeStore} from "./src/chatroom/next-room-resume-store";
    export {attachNextRoomHostBridge} from "./src/chatroom/next-room-host-bridge";
    export {saveRoomRecoveryPin,loadRoomRecoveryPins} from "./src/chatroom/next-room-recovery";`,
    resolveDir: project }, bundle: true, platform: "node", format: "cjs", packages: "external",
    outfile: bundle, logLevel: "silent" });
  if (!existsSync(join(build, "legacy-chatroom-retained.cjs"))) esbuild.buildSync({ stdin: { contents: `
    export {ChatHub} from "./src/chatroom/chatroom-hub";
    export {ChatJoinApprovalManager} from "./src/chatroom/chat-join-approval";
    export {WebSocketServer} from "ws";`, resolveDir: project }, bundle: true, platform: "node", format: "cjs",
    outfile: join(build, "legacy-chatroom-retained.cjs"), logLevel: "silent" });
  const mod = require(bundle), values = new Map(), children = new Set(), peers = new Set();
  const secrets = { async get(key) { return values.get(key); },
    async store(key, value) { values.set(key, value); }, async delete(key) { values.delete(key); } };
  const { initialize, Storage } = await import(pathToFileURL(join(build, "storage.js")));
  await initialize(root);
  let storage = await Storage.open(root, { deferRecovery: true });
  const workspaceId = await storage.workspaceId();
  const roomId = randomUUID(), credentials = await new mod.ChatRoomCredentialStore(secrets).create(roomId, "private-created-secret");
  const binding = { root, workspaceId, actorId: "local:owner", roomId,
    sourceFingerprint: randomBytes(32).toString("hex"), operation: "reopen" };
  await mod.saveRoomRecoveryPin(secrets, binding, legacyRoot, "New Room", "Real Host");
  const pin = (await mod.loadRoomRecoveryPins(secrets, parent, legacyRoot))[0];
  assert.equal(pin.origin, "native");
  assert.equal(pin.nativeHostName, "Real Host");
  await storage.close(); storage = undefined;
  t.after(async () => {
    for (const peer of peers) peer.disconnect();
    for (const child of children) if (child.exitCode === null && child.signalCode === null) {
      const exited = new Promise(resolve => child.once("exit", resolve)); child.kill("SIGTERM"); await exited;
    }
    await storage?.close();
    rmSync(directory, { recursive: true, force: true });
  });
  const natives = [{ roomId, name: "New Room", sourceFingerprint: binding.sourceFingerprint, hostCredentialHash: credentials.hostCredentialHash }];
  async function spawnHost() {
    const child = fork(join(build, "managed-client-child.js"), [], { stdio: ["ignore", "ignore", "inherit", "ipc"] });
    children.add(child); child.once("exit", () => children.delete(child));
    const messages = []; child.on("message", value => messages.push(value));
    async function take(predicate, label) {
      const end = Date.now() + 30000;
      while (Date.now() < end) {
        const index = messages.findIndex(predicate);
        if (index >= 0) return messages.splice(index, 1)[0];
        const error = messages.find(value => value.type === "startup-error");
        if (error) throw new Error(error.message);
        if (child.exitCode !== null || child.signalCode !== null) throw new Error(`Child exited before ${label}`);
        await wait(10);
      }
      throw new Error(`Timed out: ${label}`);
    }
    const request = async value => { const id = randomUUID(); child.send({ ...value, id });
      return take(message => message.type === "result" && message.id === id, value.type); };
    child.send({ type: "start-room-recovery", pin, legacyRoot, archives: [], natives });
    assert.equal((await take(message => message.type === "ready", "ready")).roomOnly, true);
    return { child, request };
  }
  const first = await spawnHost();
  assert.equal((await first.request({ type: "invoke", operation: "list", args: {} })).error, "BUSY_OR_INVALID");
  const bridge = mod.attachNextRoomHostBridge({ child: first.child, secrets, binding, authorized: () => true });
  const create = { type: "room-create", roomId, binding, session: bridge.session, name: "New Room",
    expectedHostHash: credentials.hostCredentialHash };
  const hostKey = `personalKnowledge.chatroom.${roomId}.host`, original = values.get(hostKey);
  values.set(hostKey, "wrong-host-credential");
  assert((await first.request(create)).error, "A Room secret alone cannot create a Host identity");
  values.set(hostKey, original);
  assert.equal((await first.request(create)).result.created, true);
  assert.equal((await first.request(create)).result.created, true, "Interrupted creation is idempotent");
  assert((await first.request({ ...create, name: "Changed Room" })).error, "A saved Room definition cannot be changed");
  assert((await first.request({ type: "room-name-check", name: "new room" })).error, "Room names are unique");
  assert.deepEqual((await first.request({ type: "room-inspect", roomId })).result, binding);
  const opened = await first.request({ type: "room-open", roomId, binding, session: bridge.session, legacyReconnect: "proof-required", port: 0 });
  assert.equal(opened.result?.authority, "verified-legacy-host-credential", JSON.stringify(opened));
  const port = Number(new URL(opened.result.url).port), resume = new mod.NextRoomResumeStore(secrets);
  const received = [];
  const hostClient = new mod.ChatClient({ onStatus() {}, onMessage() {}, onHistory() {},
    onPresence() {}, onRejected() {}, onFileComplete() {} });
  peers.add(hostClient);
  hostClient.connect({ ...opened.result, user: "Real Host", cid: "new-host", token: opened.result.secret });
  let hostDeadline = Date.now() + 10000;
  while (!hostClient.isConnected && Date.now() < hostDeadline) await wait(10);
  assert(hostClient.isConnected);
  const hostId = hostClient.participantId;
  let saved = false, guestHistory = [];
  const guestEvents = { onStatus() {}, onMessage(message) { received.push(message); }, onHistory(items) { guestHistory.push(...items); },
    onPresence() {}, onRejected() {}, onFileComplete() {},
    loadResumeCredential: (id, url, cid) => resume.load(id, url, cid),
    async onResumeCredential(value, room) { await resume.save(value, room); saved = true; } };
  const guest = new mod.ChatClient(guestEvents);
  peers.add(guest);
  guest.connect({ url: opened.result.url, room: opened.result.room, roomId, user: "Guest", cid: "new-guest",
    token: opened.result.secret });
  let deadline = Date.now() + 10000;
  while ((!guest.isConnected || !saved) && Date.now() < deadline) await wait(10);
  assert(guest.isConnected && saved);
  const guestId = guest.participantId;
  assert(hostClient.sendText("@all First native message"));
  deadline = Date.now() + 10000;
  while (!received.some(message => message.text?.includes("First native message")) && Date.now() < deadline) await wait(10);
  assert(received.some(message => message.text?.includes("First native message")), JSON.stringify(received));
  const exited = new Promise(resolve => first.child.once("exit", resolve));
  first.child.kill("SIGKILL"); await exited; bridge.close(); guest.disconnect();
  hostClient.disconnect();

  const second = await spawnHost();
  const newBridge = mod.attachNextRoomHostBridge({ child: second.child, secrets, binding, authorized: () => true });
  const recreated = await second.request({ ...create, session: newBridge.session });
  assert.equal(recreated.result.created, true);
  const reopened = await second.request({ type: "room-open", roomId, binding, session: newBridge.session,
    legacyReconnect: "proof-required", port });
  assert.equal(reopened.result?.authority, "verified-legacy-host-credential", JSON.stringify(reopened));
  hostClient.connect({ ...reopened.result, user: "Real Host", cid: "new-host", token: reopened.result.secret });
  hostDeadline = Date.now() + 10000;
  while (!hostClient.isConnected && Date.now() < hostDeadline) await wait(10);
  assert.equal(hostClient.participantId, hostId, "Host proof reclaims the original Host identity");
  saved = false; guestHistory = [];
  const restartedGuest = new mod.ChatClient(guestEvents);
  peers.add(restartedGuest);
  restartedGuest.connect({ url: reopened.result.url, room: reopened.result.room, roomId, user: "Guest", cid: "new-guest",
    token: reopened.result.secret });
  deadline = Date.now() + 10000;
  while ((!restartedGuest.isConnected || !guestHistory.some(item => item.text?.includes("First native message"))) && Date.now() < deadline) await wait(10);
  assert.equal(restartedGuest.participantId, guestId, "Credentialed Guest identity survives native Host crash");
  assert(guestHistory.some(item => item.text?.includes("First native message")), "New Room history survives crash");
  const secondId = randomUUID();
  const secondCredentials = await new mod.ChatRoomCredentialStore(secrets).create(secondId, "another-private-secret");
  const secondBinding = { ...binding, roomId: secondId, sourceFingerprint: randomBytes(32).toString("hex") };
  await mod.saveRoomRecoveryPin(secrets, secondBinding, legacyRoot, "Another Room", "Another Host");
  const secondBridge = mod.attachNextRoomHostBridge({ child: second.child, secrets, binding: secondBinding, authorized: () => true });
  assert.equal((await second.request({ type: "room-create", roomId: secondId, binding: secondBinding,
    session: secondBridge.session, name: "Another Room", expectedHostHash: secondCredentials.hostCredentialHash })).result.created, true,
  "A newly pinned Room can be created within an existing Room-only recovery");
  assert.deepEqual((await second.request({ type: "room-inspect", roomId: secondId })).result, secondBinding);
  const secondOpened = await second.request({ type: "room-open", roomId: secondId, binding: secondBinding,
    session: secondBridge.session, legacyReconnect: "proof-required", port });
  assert.equal(secondOpened.result?.authority, "verified-legacy-host-credential", JSON.stringify(secondOpened));
  assert.equal(Number(new URL(secondOpened.result.url).port), port, "Both Rooms share the retained Hub");
  assert.equal((await second.request({ type: "room-close", roomId: secondId })).result.closed, true);
  assert(restartedGuest.isConnected, "Closing the new Room does not disconnect the original Room");
  secondBridge.close();
  restartedGuest.disconnect();
  assert.equal((await second.request({ type: "room-close" })).result.closed, true);
  newBridge.close();
  const finished = new Promise(resolve => second.child.once("exit", resolve));
  second.child.send({ type: "close" }); await finished;
});
