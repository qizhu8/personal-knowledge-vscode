const assert = require("node:assert/strict");
const { readFileSync } = require("node:fs");
const { test } = require("node:test");
const { transformSync } = require("esbuild");

const source = readFileSync("src/chatroom/next-room-resume-store.ts", "utf8");
const code = transformSync(source, { loader: "ts", format: "cjs" }).code;
const loaded = { exports: {} };
new Function("require", "module", "exports", code)(require, loaded, loaded.exports);
const { NextRoomResumeStore } = loaded.exports;

test("participant secrets are scoped to endpoint and corrupt entries fail closed", async () => {
  const entries = new Map();
  const store = new NextRoomResumeStore({
    async get(key) { return entries.get(key); },
    async store(key, value) { entries.set(key, value); },
    async delete(key) { entries.delete(key); },
  });
  const credential = { roomId: "room-id", url: "ws://localhost:9000", clientId: "client",
    participantId: "participant", secret: "a".repeat(43) };
  await store.save(credential, "Room name");
  assert.deepEqual(await store.load(credential.roomId, credential.url, credential.clientId), credential);
  assert.deepEqual(await store.loadByName("Room name", credential.url, credential.clientId), credential);
  assert.equal(await store.loadByName("Other", credential.url, credential.clientId), undefined);
  assert.equal(await store.loadByName("Room name", "ws://localhost:9001", credential.clientId), undefined);
  assert.equal(await store.load(credential.roomId, "ws://localhost:9001", credential.clientId), undefined);
  await assert.rejects(() => store.save({ ...credential, url: "https://example.test" }));
  const key = [...entries.keys()][0];
  entries.set(key, JSON.stringify({ ...credential, participantId: "" }));
  assert.equal(await store.load(credential.roomId, credential.url, credential.clientId), undefined);
  assert.equal(await store.loadByName("Room name", credential.url, credential.clientId), undefined);
  await store.deleteName("Room name", credential.url, credential.clientId);
  await store.delete(credential.roomId, credential.url, credential.clientId);
  assert.equal(entries.size, 0);
});
