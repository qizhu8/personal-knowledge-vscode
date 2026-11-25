import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import { appendFile, copyFile, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import {
  prepareInstalledNativeRoomCredentials, observeInstalledNativeRoomActivation,
  prepareInstalledNativeRoomOriginalWriters, prepareInstalledNativeRoomFixture,
  verifyInstalledNativeRoom, verifyInstalledNativeRoomRestored, installedNativeRoomUiProgram,
} from "./installed-native-room.mjs";

assert.equal(process.env.PKM_TEST_ISOLATED_NETWORK, "1",
  "Run the installed Room leaf's writer/oracle/guards in tests/framework/isolate.py. No fake platform APIs.");
const require = createRequire(import.meta.url), project = resolve(".");
const legacyVsix = process.env.PKM_LEGACY_VSIX
  || resolve("../personal-knowledge-vscode/personal-knowledge-4.0.22.vsix");
const python = execFileSync("python3", ["-I", "-B", "-c", "import sys;print(sys.executable)"], { encoding: "utf8" }).trim();
const hash = value => createHash("sha256").update(value).digest("hex");
async function fixture(t) {
  const directory = join(project, ".migration-test-work", `installed-room-leaf-${randomUUID()}`);
  const root = join(directory, `.installed-host-${randomUUID()}`);
  const installed = join(root, "x/pkm-nonproduction.pkm-v5-0.1.0");
  await mkdir(join(installed, "dist"), { recursive: true, mode: 0o700 });
  t.after(() => rm(directory, { recursive: true, force: true }));
  // An exact build-byte guard input, not a CLI installation or an installed acceptance receipt.
  await copyFile(resolve("clients/vscode-host/package.json"), join(installed, "package.json"));
  await copyFile(resolve("clients/vscode-host/dist/extension.cjs"), join(installed, "dist/extension.cjs"));
  return { directory, root, installed };
}
test("Room credential intent is hash-only; a normal Node process cannot observe/create native credentials or substitute platform APIs", async t => {
  const f = await fixture(t);
  const bad = join(f.directory, "not-original.vsix");
  await writeFile(bad, "A filename is not original producer provenance.", { mode: 0o600 });
  await assert.rejects(prepareInstalledNativeRoomCredentials({ ...f, legacyVsix: bad }),
    { code: "INSTALLED_ROOM_ORIGINAL_PACKAGE_CHANGED" });
  const intent = await prepareInstalledNativeRoomCredentials({ ...f, legacyVsix });
  assert.equal(intent.driverRoot, f.root);
  assert.equal(intent.originalPackageSha256, "1804071cb3b9fc86edc5933d5001db6ea1a8d7a9adf30d6d2b3166fcd6048f27");
  assert(!JSON.stringify(intent).includes('"hostCredential":'));
  assert(!JSON.stringify(intent).includes('"joinSecret":'));
  const before = await readFile(join(f.installed, "dist/extension.cjs"));
  assert.throws(() => observeInstalledNativeRoomActivation({ ...f, legacyVsix }),
    { code: "INSTALLED_ROOM_EXPLICIT_FIXTURE_DRIVER_REQUIRED" });
  const previous = process.env.PKM_HOST_INSTALLED_FIXTURE;
  try {
    process.env.PKM_HOST_INSTALLED_FIXTURE = JSON.stringify({ root: f.root, installed: f.installed, legacyVsix, nativeRoom: true });
    assert.throws(() => observeInstalledNativeRoomActivation({ ...f, legacyVsix }),
      { code: "INSTALLED_ROOM_REAL_EXTENSION_HOST_REQUIRED" });
  } finally {
    if (previous === undefined) delete process.env.PKM_HOST_INSTALLED_FIXTURE;
    else process.env.PKM_HOST_INSTALLED_FIXTURE = previous;
  }
  assert.deepEqual(await readFile(join(f.installed, "dist/extension.cjs")), before);
  assert.deepEqual((await readdir(f.root)).sort(), ["native-room-credential-intent.json", "x"]);
  await assert.rejects(prepareInstalledNativeRoomFixture({ ...f, legacyVsix, credentialIntent: { ...intent }, python,
    componentFixture: {} }), { code: "INSTALLED_ROOM_ACTUAL_CREDENTIAL_INTENT_REQUIRED" });
});
test("observer rejects changed installed/intent bindings and copied proof-like inputs before any production context is touched", async t => {
  const f = await fixture(t);
  const intent = await prepareInstalledNativeRoomCredentials({ ...f, legacyVsix });
  await assert.rejects(prepareInstalledNativeRoomCredentials({ ...f, legacyVsix }), error => error.code === "EEXIST");
  const path = join(f.root, "native-room-credential-intent.json");
  const original = await readFile(path);
  await writeFile(path, JSON.stringify({ ...intent, installedEntrySha256: "0".repeat(64) }), { mode: 0o600 });
  assert.throws(() => observeInstalledNativeRoomActivation({ ...f, legacyVsix }),
    { code: "INSTALLED_ROOM_CREDENTIAL_INTENT_CHANGED" });
  await writeFile(path, original, { mode: 0o600 });
  const previous = process.env.PKM_HOST_INSTALLED_FIXTURE;
  try {
    process.env.PKM_HOST_INSTALLED_FIXTURE = JSON.stringify({ root: f.root, installed: f.installed, legacyVsix, nativeRoom: true });
    await writeFile(join(f.root, "native-room-created-credentials.json"), JSON.stringify({
      roomId: intent.roomId, hostCredentialHash: "a".repeat(64), joinSecretHash: "b".repeat(64), unexpected: true,
    }), { mode: 0o600 });
    assert.throws(() => observeInstalledNativeRoomActivation({ ...f, legacyVsix }),
      { code: "INSTALLED_ROOM_HASH_ONLY_CREDENTIAL_EVIDENCE_REQUIRED" });
    await rm(join(f.root, "native-room-created-credentials.json"));
  } finally {
    if (previous === undefined) delete process.env.PKM_HOST_INSTALLED_FIXTURE;
    else process.env.PKM_HOST_INSTALLED_FIXTURE = previous;
  }
  await assert.rejects(verifyInstalledNativeRoom({ sourceFixture: { roomId: intent.roomId } }),
    { code: "INSTALLED_ROOM_ACTUAL_PREPARATION_REQUIRED" });
  await assert.rejects(verifyInstalledNativeRoomRestored({ roomId: intent.roomId }, { retirement: {}, restored: {} }),
    { code: "INSTALLED_ROOM_ACTUAL_PREPARATION_REQUIRED" });
  await assert.rejects(prepareInstalledNativeRoomCredentials({ root: f.directory, installed: f.installed, legacyVsix }),
    { code: "INSTALLED_ROOM_PRIVATE_DRIVER_REQUIRED" });
  assert.equal((await readdir(f.root)).includes("native-room-created-credentials.json"), false);
});
test("requested caller input is hash-bound before native activation and is never written into the credential intent", async t => {
  const f = await fixture(t), requestedJoinSecret = randomUUID();
  await assert.rejects(prepareInstalledNativeRoomCredentials({ ...f, legacyVsix, requestedJoinSecretSha256: "invalid" }),
    { code: "INSTALLED_ROOM_REQUESTED_JOIN_HASH_REQUIRED" });
  const intent = await prepareInstalledNativeRoomCredentials({
    ...f, legacyVsix, requestedJoinSecretSha256: hash(requestedJoinSecret),
  });
  assert.equal(intent.requestedJoinSecretSha256, hash(requestedJoinSecret));
  assert(!(await readFile(join(f.root, "native-room-credential-intent.json"), "utf8")).includes(requestedJoinSecret));
  assert.throws(() => observeInstalledNativeRoomActivation({ ...f, legacyVsix }),
    { code: "INSTALLED_ROOM_REQUESTED_JOIN_INPUT_MISMATCH" });
  assert.throws(() => observeInstalledNativeRoomActivation({ ...f, legacyVsix, requestedJoinSecret: "different" }),
    { code: "INSTALLED_ROOM_REQUESTED_JOIN_INPUT_MISMATCH" });
  assert.throws(() => observeInstalledNativeRoomActivation({ ...f, legacyVsix, requestedJoinSecret }),
    { code: "INSTALLED_ROOM_EXPLICIT_FIXTURE_DRIVER_REQUIRED" });
  assert.equal((await readdir(f.root)).includes("native-room-created-credentials.json"), false);
});
test("pinned original Room/Meeting writers consume hashes without SecretStorage; original status oracle never restores a participant or qualifies installation", {
  timeout: 90000,
}, async t => {
  const f = await fixture(t);
  const writer = await prepareInstalledNativeRoomOriginalWriters({ directory: join(f.directory, "original-writer"), legacyVsix, python });
  assert.equal(writer.installedProof, false);
  assert.deepEqual(JSON.parse(writer.statusExpected[0]), { ok: true, active_aliases: [], connections: [] });
  const named = JSON.parse(writer.statusExpected[1]);
  assert.equal(named.ok, false); assert.deepEqual(named.active_aliases, []);
  assert(named.error.includes(writer.statusCalls[1].name));
  const root = join(f.directory, "original-root"), roomId = randomUUID();
  await mkdir(root, { mode: 0o700 });
  const original = require("../../legacy/tests/next-trial-electron/chatroom-live-fixture.cjs");
  const hashes = { hostCredentialHash: hash("metadata-only-uncredentialed-writer-probe"),
    joinSecretHash: hash("this-does-not-create-a-native-secret-or-host-grant") };
  await original.create({ extension: writer.directory, root, roomId, credentials: hashes, hostParticipantId: "historic-human" });
  const Store = require(join(writer.directory, "dist/chatroom/meeting-state.js")).MeetingStateStore;
  const store = new Store(join(root, "chatrooms"), join(root, "notes"));
  const meeting = await store.startMeeting({ roomId, roomName: "Uncredentialed original writer probe",
    title: "Retain private manual Note", problemStatement: "Writer shape only; not installed proof",
    owner: "Historic Human", lead: "Historic Human", recorder: "Historic Human", participants: ["Historic Human", "Historic Agent"],
    host: "Historic Human", triggerMessageId: "history-human", requestId: "probe-start", expectedRevision: 0 });
  await store.adjournMeeting({ roomId, meetingId: meeting.id, actor: "Historic Human", requestId: "probe-adjourn",
    expectedRevision: meeting.revision });
  const note = join(root, "notes", meeting.markdownPath);
  await appendFile(note, "\nPrivate manual writer-probe annotation — never a native grant.\n");
  const reader = await import(pathToFileURL(resolve("clients/vscode-host/next-runtime/server/dist/legacy-chatroom-continuation.js")).href);
  const archive = reader.inspectLegacyChatroomArchive(root, roomId);
  const identity = reader.inspectLegacyChatroomParticipants(root, roomId);
  assert.equal(archive.messages.length, 3); assert.equal(identity.memberships.length, 2);
  const db = new DatabaseSync(join(root, "chatrooms", roomId, "chatroom.db"), { readOnly: true });
  try {
    const metadata = db.prepare("SELECT * FROM room_metadata WHERE room_id=?").get(roomId);
    assert.equal(metadata.host_credential_hash, hashes.hostCredentialHash);
    assert.equal(metadata.join_secret_hash, hashes.joinSecretHash);
    assert.equal(metadata.host_participant_id, "historic-human");
    assert.equal(metadata.owner_installation_id, "synthetic-old-live");
  } finally { db.close(); }
  assert.match(await readFile(note, "utf8"), /Private manual writer-probe annotation/);
  for (const [member, sha256] of Object.entries(writer.files))
    assert.equal(hash(await readFile(join(writer.directory, member))), sha256);
  await assert.rejects(verifyInstalledNativeRoom({ sourceFixture: writer }), { code: "INSTALLED_ROOM_ACTUAL_PREPARATION_REQUIRED" });
  assert.equal((await readdir(f.root)).includes("native-room-passed.json"), false);
});
test("the leaf's own actual-renderer modal driver parses as Python without launching an editor or replacing any native API", () => {
  execFileSync(python, ["-I", "-B", "-c", "import sys;compile(sys.stdin.read(),'<installed-native-room-ui>','exec')"], {
    input: installedNativeRoomUiProgram, timeout: 10000, stdio: ["pipe", "pipe", "pipe"],
  });
});
