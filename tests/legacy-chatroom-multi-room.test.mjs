import assert from "node:assert/strict";
import { test } from "node:test";
import { createRequire } from "node:module";
import { fork } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync, copyFileSync, rmSync, existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { pathToFileURL } from "node:url";

const require = createRequire(import.meta.url);
const project = resolve(new URL("../legacy", import.meta.url).pathname);
const build = resolve(process.env.PKM_ROOM_RECOVERY_BUILD || join(project, "../dist"));
const fixture = require("../legacy/tests/next-trial-electron/chatroom-live-fixture.cjs");
const esbuild = require("esbuild"), ts = require("typescript");
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));

test("independently pinned Rooms share one Hub, isolate authority, and survive child crash", async t => {
  const directory = join(project, ".migration-test-work", `multi-room-${randomUUID()}`);
  const parent = join(directory, "trial"), root = join(parent, "workspace"), legacyRoot = join(directory, "legacy");
  const extension = join(directory, "old-source"), bundle = join(directory, "test-bridge.cjs");
  for (const dir of [parent, legacyRoot, join(extension, "dist")]) mkdirSync(dir, { recursive: true, mode: 0o700 });
  for (const name of ["chat-persistence", "chat-persistence-worker"])
    writeFileSync(join(extension, name === "chat-persistence" ? "dist" : "", `${name}.js`),
      ts.transpileModule(readFileSync(join(project, "src/chatroom", `${name}.ts`), "utf8"), {
        compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
      }).outputText);
  for (const name of ["sql-wasm.js", "sql-wasm.wasm"])
    copyFileSync(join(project, "node_modules/sql.js/dist", name), join(directory, name));
  esbuild.buildSync({ stdin: { contents: `
    export {ChatHub} from "./src/chatroom/chatroom-hub";
    export {ChatClient} from "./src/chatroom/chatroom-client";
    export {ChatJoinApprovalManager} from "./src/chatroom/chat-join-approval";
    export {ChatRoomCredentialStore} from "./src/chatroom/chat-room-credentials";
    export {attachNextRoomHostBridge} from "./src/chatroom/next-room-host-bridge";
    export {saveRoomRecoveryPin,loadRoomRecoveryPins,verifyRoomRecoveryCredential} from "./src/chatroom/next-room-recovery";`,
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
  const rooms = [fixture.roomId, randomUUID()];
  const credentials = await Promise.all(rooms.map(id => new mod.ChatRoomCredentialStore(secrets).create(id)));
  const { initialize, Storage } = await import(pathToFileURL(join(build, "storage.js")));
  const { inspectLegacyChatroomArchive } = await import(pathToFileURL(join(build, "legacy-chatroom-continuation.js")));
  await initialize(root);
  let storage = await Storage.open(root, { deferRecovery: true });
  const workspaceId = await storage.workspaceId();
  t.after(async () => {
    for (const peer of peers) peer.disconnect();
    for (const child of children) if (child.exitCode === null && child.signalCode === null) {
      const exited = new Promise(resolve => child.once("exit", resolve)); child.kill("SIGTERM"); await exited;
    }
    await storage?.close();
    rmSync(directory, { recursive: true, force: true });
  });
  const bindings = [];
  for (let i = 0; i < rooms.length; i++) {
    await fixture.create({ extension, root, credentials: credentials[i], hostParticipantId: "historic-human",
      roomId: rooms[i], roomName: `Room ${i}`, descriptorName: `room-${i}.json` });
    const binding = { root, workspaceId, actorId: "local:owner", roomId: rooms[i],
      sourceFingerprint: inspectLegacyChatroomArchive(root, rooms[i]).sourceFingerprint, operation: "reopen" };
    bindings.push(binding);
    if (i === 0) await mod.saveRoomRecoveryPin(secrets, binding, legacyRoot);
  }
  await storage.close(); storage = undefined;
  const first = await mod.loadRoomRecoveryPins(secrets, parent, legacyRoot);
  assert.equal(first.length, 1, "v1 recovery is retained");
  await assert.rejects(Storage.openPrivateRoomRecovery(root, first.map(({ roomId, sourceFingerprint }) => ({ roomId, sourceFingerprint }))), /adoption journal/);
  await mod.saveRoomRecoveryPin(secrets, bindings[1], legacyRoot, undefined, undefined, "Room 1");
  const pins = await mod.loadRoomRecoveryPins(secrets, parent, legacyRoot);
  assert.deepEqual(new Set(pins.map(pin => pin.roomId)), new Set(rooms), "v1 upgrades without losing its authority");
  assert.equal(pins.find(pin => pin.roomId === rooms[1]).roomName, "Room 1");
  const archives = pins.map(({ roomId, sourceFingerprint }) => ({ roomId, sourceFingerprint }));
  await assert.rejects(Storage.open(root, { deferRecovery: true }), /adoption journal/);
  await assert.rejects(Storage.openPrivateRoomRecovery(root, [...archives, archives[0]]), /Invalid/);
  await assert.rejects(Storage.openPrivateRoomRecovery(root, [archives[0], { ...archives[1], sourceFingerprint: "0".repeat(64) }]), /adoption journal/);
  const hostKey = id => `personalKnowledge.chatroom.${id}.host`;
  const original = values.get(hostKey(rooms[1]));
  values.set(hostKey(rooms[1]), values.get(hostKey(rooms[0])));
  await assert.rejects(mod.verifyRoomRecoveryCredential(secrets, pins.find(pin => pin.roomId === rooms[1])), /credential/);
  values.set(hostKey(rooms[1]), original);
  const indexKey = "personalKnowledge.next.isolatedRoomRecovery.v2", index = values.get(indexKey);
  values.set(indexKey, "invalid");
  await assert.rejects(mod.loadRoomRecoveryPins(secrets, parent, legacyRoot), /invalid/);
  values.set(indexKey, index);

  async function spawnHost() {
    const child = fork(join(build, "managed-client-child.js"), [], { stdio: ["ignore", "ignore", "inherit", "ipc"] });
    children.add(child); child.once("exit", () => children.delete(child));
    const messages = []; child.on("message", value => messages.push(value));
    const take = async (predicate, label, timeout = 30000) => {
      const end = Date.now() + timeout;
      while (Date.now() < end) {
        const index = messages.findIndex(predicate);
        if (index >= 0) return messages.splice(index, 1)[0];
        const error = messages.find(value => value.type === "startup-error");
        if (error) throw new Error(`Startup failed: ${error.message}`);
        if (child.exitCode !== null || child.signalCode !== null) throw new Error(`Child exited: ${label}`);
        await wait(10);
      }
      throw new Error(`Timed out: ${label}`);
    };
    const request = async value => {
      const id = randomUUID(); child.send({ ...value, id });
      return take(message => message.type === "result" && message.id === id, value.type);
    };
    child.send({ type: "start-room-recovery", pin: pins[0], archives, legacyRoot });
    assert.equal((await take(message => message.type === "ready", "ready")).roomOnly, true);
    return { child, request };
  }
  const host = await spawnHost();
  const bridges = bindings.map(binding => mod.attachNextRoomHostBridge({
    child: host.child, secrets, binding, authorized: () => true,
  }));
  const a = await host.request({ type: "room-open", roomId: rooms[0], binding: bindings[0], session: bridges[0].session,
    legacyReconnect: "proof-required", port: 0 });
  assert(a.result?.url, JSON.stringify(a));
  const port = Number(new URL(a.result.url).port);
  const invalid = await host.request({ type: "room-open", roomId: rooms[1], binding: bindings[1], session: bridges[0].session,
    legacyReconnect: "proof-required", port });
  assert(invalid.error, "Room A session cannot authorize Room B");
  const b = await host.request({ type: "room-open", roomId: rooms[1], binding: bindings[1], session: bridges[1].session,
    legacyReconnect: "proof-required", port });
  assert.equal(b.result?.url, a.result.url, JSON.stringify(b));
  assert.notEqual(a.result.secret, b.result.secret);
  assert.notEqual(a.result.hostToken, b.result.hostToken);
  const connections = [];
  for (const [index, opened] of [a.result, b.result].entries()) {
    let history = [];
    const peer = new mod.ChatClient({ onStatus() {}, onMessage() {}, onHistory(items) { history = items; },
      onPresence() {}, onRejected() {}, onFileComplete() {} });
    peers.add(peer);
    peer.connect({ url: opened.url, room: opened.room, roomId: rooms[index], user: `Guest ${index}`,
      cid: `new-room-client-${index}`, token: opened.secret });
    const end = Date.now() + 10000;
    while ((!peer.isConnected || !history.length) && Date.now() < end) await wait(10);
    assert(peer.isConnected && history.some(message => message.text === "Human discussion before upgrade."));
    connections.push(peer);
  }
  bridges[1].close();
  const revokedDeadline = Date.now() + 10000;
  while (connections[1].isConnected && Date.now() < revokedDeadline) await wait(10);
  assert(!connections[1].isConnected && connections[0].isConnected, "revoking Room B does not revoke Room A");
  bridges[1] = mod.attachNextRoomHostBridge({ child: host.child, secrets, binding: bindings[1], authorized: () => true });
  let rehosted;
  const reopenDeadline = Date.now() + 10000;
  while (Date.now() < reopenDeadline) {
    rehosted = await host.request({ type: "room-open", roomId: rooms[1], binding: bindings[1], session: bridges[1].session,
      legacyReconnect: "proof-required", port });
    if (rehosted.result) break;
    await wait(50);
  }
  assert.equal(rehosted.result?.url, a.result.url, JSON.stringify(rehosted));
  const secondPeer = new mod.ChatClient({ onStatus() {}, onMessage() {}, onHistory() {},
    onPresence() {}, onRejected() {}, onFileComplete() {} });
  peers.add(secondPeer);
  secondPeer.connect({ url: rehosted.result.url, room: rehosted.result.room, roomId: rooms[1],
    user: "Fresh Guest", cid: "fresh-after-revoke", token: rehosted.result.secret });
  const connectedDeadline = Date.now() + 10000;
  while (!secondPeer.isConnected && Date.now() < connectedDeadline) await wait(10);
  assert(secondPeer.isConnected);
  assert.equal((await host.request({ type: "room-close", roomId: rooms[0] })).result.closed, true);
  await wait(200);
  assert(!connections[0].isConnected && secondPeer.isConnected, "closing one Room preserves the other");
  bridges[0].close();
  const exited = new Promise(resolve => host.child.once("exit", resolve));
  host.child.kill("SIGKILL"); await exited; bridges[1].close();
  const recovered = await spawnHost();
  const restartedBridge = mod.attachNextRoomHostBridge({ child: recovered.child, secrets, binding: bindings[1], authorized: () => true });
  const reopened = await recovered.request({ type: "room-open", roomId: rooms[1], binding: bindings[1],
    session: restartedBridge.session, legacyReconnect: "proof-required", port });
  assert.equal(reopened.result?.authority, "verified-legacy-host-credential", JSON.stringify(reopened));
  assert.equal((await recovered.request({ type: "room-close" })).result.closed, true);
  restartedBridge.close();
  const finished = new Promise(resolve => recovered.child.once("exit", resolve));
  recovered.child.send({ type: "close" }); await finished;
});
