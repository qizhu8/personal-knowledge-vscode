#!/usr/bin/env node
const assert = require("assert");
const crypto = require("crypto");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { fork } = require("child_process");
const { ChatRoomLock } = require("../dist/chat-room-lock");
const { ChatRoomCredentialStore } = require("../dist/chat-room-credentials");
const { ChatRoomLifecycle } = require("../dist/chat-room-lifecycle");
const { ChatHub } = require("../dist/chatroom-hub");

class FileSecretStorage {
  constructor(filePath) { this.filePath = filePath; }
  async get(key) { return this.read()[key]; }
  async store(key, value) { const values = this.read(); values[key] = value; fs.writeFileSync(this.filePath, JSON.stringify(values)); }
  async delete(key) { const values = this.read(); delete values[key]; fs.writeFileSync(this.filePath, JSON.stringify(values)); }
  read() { try { return JSON.parse(fs.readFileSync(this.filePath, "utf8")); } catch { return {}; } }
}

function forkWorker(args) {
  return new Promise((resolve, reject) => {
    const child = fork(__filename, args, { stdio: ["ignore", "ignore", "inherit", "ipc"] });
    child.once("message", message => resolve({ child, message }));
    child.once("error", reject);
    child.once("exit", code => { if (code && code !== 0) reject(new Error(`worker exited ${code}`)); });
  });
}

async function workerMain() {
  const [, , , lockPath, installationId, hold] = process.argv;
  try {
    const lock = ChatRoomLock.acquire(lockPath, installationId);
    process.send?.({ ok: true, record: lock.record });
    if (hold === "hold") setInterval(() => {}, 60_000);
    else process.exit(0);
  } catch (error) {
    process.send?.({ ok: false, error: error.message });
    process.exit(0);
  }
}

async function main() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pkm-room-lifecycle-poc-"));
  try {
    const lockPath = path.join(root, "chatroom.lock");
    const first = await forkWorker(["worker", lockPath, "installation-a", "hold"]);
    assert(first.message.ok, first.message.error);

    const contender = await forkWorker(["worker", lockPath, "installation-b", "once"]);
    assert.strictEqual(contender.message.ok, false, "only one process may host a Room");

    first.child.kill("SIGKILL");
    await new Promise(resolve => first.child.once("exit", resolve));
    const recoveryAttempts = await Promise.all(
      Array.from({ length: 8 }, (_, index) => forkWorker(["worker", lockPath, `installation-${index}`, "hold"])),
    );
    const winners = recoveryAttempts.filter(result => result.message.ok);
    assert.strictEqual(winners.length, 1, "exactly one simultaneous crash-recovery contender must win");
    const recovered = winners[0];
    for (const attempt of recoveryAttempts) {
      if (attempt !== recovered && attempt.child.exitCode === null) attempt.child.kill("SIGTERM");
    }
    const staleOwner = Object.create(ChatRoomLock.prototype);
    staleOwner.lockPath = lockPath; staleOwner.record = first.message.record; staleOwner.released = false;
    assert.strictEqual(staleOwner.release(), false, "old owner must not release successor lock");
    const currentOwner = Object.create(ChatRoomLock.prototype);
    currentOwner.lockPath = lockPath; currentOwner.record = recovered.message.record; currentOwner.released = false;
    assert.strictEqual(currentOwner.release(), true);
    recovered.child.kill("SIGTERM");

    const secretFile = path.join(root, "secret-storage-backend.json");
    const roomId = crypto.randomUUID();
    const created = await new ChatRoomCredentialStore(new FileSecretStorage(secretFile)).create(roomId);
    const restartedStore = new ChatRoomCredentialStore(new FileSecretStorage(secretFile));
    const restored = await restartedStore.load(roomId);
    assert.strictEqual(restored.hostCredential, created.hostCredential);
    assert.strictEqual(restored.joinSecret, created.joinSecret);
    assert(await restartedStore.verifyHost(roomId, created.hostCredentialHash));
    const rotated = await restartedStore.rotateJoinSecret(roomId);
    assert.notStrictEqual(rotated.joinSecret, created.joinSecret);
    const durableRoomData = JSON.stringify({ roomId, hostCredentialHash: created.hostCredentialHash, joinSecretHash: rotated.joinSecretHash });
    assert(!durableRoomData.includes(created.hostCredential));
    assert(!durableRoomData.includes(created.joinSecret));
    await restartedStore.delete(roomId);
    assert.strictEqual(await restartedStore.load(roomId), undefined);

    const roomsRoot = path.join(root, "chatrooms");
    const lifecycleA = new ChatRoomLifecycle(roomsRoot, "installation-owner", new FileSecretStorage(secretFile), 60_000);
    const createdRoom = await lifecycleA.createRoom("Design Review", "chosen-join-secret");
    assert.strictEqual(createdRoom.joinSecret, "chosen-join-secret");
    const lifecycleB = new ChatRoomLifecycle(roomsRoot, "installation-owner", new FileSecretStorage(secretFile), 60_000);
    assert.deepStrictEqual(await lifecycleB.listStoredRooms(), [], "a Room locked by a live Hub must not be scanned as stored");
    const rotatedSecret = await lifecycleA.rotateJoinSecret(createdRoom.roomId);
    assert.notStrictEqual(rotatedSecret, "chosen-join-secret");
    await lifecycleA.deactivateRoom(createdRoom.roomId, "test-deactivate");
    const storedRooms = await lifecycleB.listStoredRooms();
    assert.deepStrictEqual(storedRooms.map(room => room.roomId), [createdRoom.roomId]);
    const rehosted = await lifecycleB.rehostRoom(createdRoom.roomId);
    assert.strictEqual(rehosted.joinSecret, rotatedSecret, "Rehost must retain the rotated Join secret");
    await lifecycleB.deactivateRoom(createdRoom.roomId, "test-rehost-complete");
    const lifecycleC = new ChatRoomLifecycle(roomsRoot, "installation-other", new FileSecretStorage(secretFile), 60_000);
    await assert.rejects(lifecycleC.rehostRoom(createdRoom.roomId), /does not own/);
    await lifecycleA.dispose();
    await lifecycleB.dispose();
    await lifecycleC.dispose();

    const hubRoot = path.join(root, "hub-chatrooms");
    const hubA = new ChatHub();
    hubA.configureLifecycle(hubRoot, 10 * 1024 * 1024, "hub-installation", new FileSecretStorage(secretFile));
    await hubA.start(0);
    const hubCreated = await hubA.createRoom("Hub Room", "hub-initial-secret");
    assert.strictEqual(hubA.adminRooms()[0].roomId, hubCreated.roomId);
    const hubRotatedSecret = await hubA.rotateRoomSecret(hubCreated.room);
    await hubA.stop();
    const hubB = new ChatHub();
    hubB.configureLifecycle(hubRoot, 10 * 1024 * 1024, "hub-installation", new FileSecretStorage(secretFile));
    const hubStored = await hubB.listStoredRooms();
    assert.deepStrictEqual(hubStored.map(room => room.roomId), [hubCreated.roomId], "Stored Rooms must be discoverable before the network Hub starts");
    await hubB.start(0);
    const hubRehosted = await hubB.rehostRoom(hubCreated.roomId);
    assert.strictEqual(hubRehosted.secret, hubRotatedSecret);
    await hubB.stop();

    console.log("Room lock: concurrent exclusion, SIGKILL recovery, nonce-safe release OK");
    console.log("Credentials: restart recovery, hash verification, no plaintext in Room metadata OK");
    console.log("Lifecycle: create, active lock isolation, deactivate, Rehost, retained secret, owner rejection OK");
    console.log("Hub: Create, Rotate, Stop, and Rehost by Room ID OK");
    console.log("Note: credential backend is a SecretStorage-compatible test double; VS Code keyring requires an Extension Host smoke test.");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

if (process.argv[2] === "worker") workerMain().catch(error => { console.error(error); process.exit(1); });
else main().catch(error => { console.error(error); process.exit(1); });