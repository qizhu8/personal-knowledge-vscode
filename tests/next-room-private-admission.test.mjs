import assert from "node:assert/strict";
import { after, test } from "node:test";
import { createRequire } from "node:module";
import { randomUUID } from "node:crypto";
import { createHash } from "node:crypto";
import { execFileSync, fork } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { pathToFileURL } from "node:url";

const require = createRequire(import.meta.url);
const project = path.resolve(new URL("../legacy", import.meta.url).pathname);
const core = path.resolve(new URL("..", import.meta.url).pathname);
const directories = [];
after(() => { for (const directory of directories) fs.rmSync(directory, { recursive: true, force: true }); });
async function setup() {
  const directory = path.join(core, ".migration-test-work", `room-private-admission-${randomUUID()}`);
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  directories.push(directory);
  fs.writeFileSync(path.join(directory, "package.json"), '{"type":"module"}');
  fs.symlinkSync(path.join(project, "../node_modules"), path.join(directory, "node_modules"), "dir");
  const esbuild = require("esbuild");
  esbuild.buildSync({ entryPoints: [path.join(project, "../src/storage-worker.ts")],
    bundle: true, platform: "node", format: "esm", packages: "external",
    outfile: path.join(directory, "storage-worker.js"), logLevel: "silent" });
  esbuild.buildSync({ stdin: { contents: `
    export {initialize,Storage} from "./src/storage";
    export {inspectRetainedMeetingSource} from "./src/next-room-meeting-source";
    export {admitPrivateRoom,openPrivateRoomAdmissions,assertPrivateRoomAdmissions} from "./src/next-room-private-admission";
    export {createNextRoomMeetings} from "./src/next-room-meetings";
    export {copyPrivateRoomArchive} from "./src/legacy-chatroom-private-copy";`, resolveDir: core },
    bundle: true, platform: "node", format: "esm", packages: "external",
    outfile: path.join(directory, "native.mjs"), logLevel: "silent" });
  return { directory, native: await import(pathToFileURL(path.join(directory, "native.mjs"))) };
}

test("real installed original archive reproduces missing exact journal and missing private Note admission", async () => {
  const { directory, native } = await setup();
  const fixture = process.env.PKM_PRIVATE_ROOM_BASELINE_FIXTURE;
  assert(fixture && fs.existsSync(path.join(fixture, "meeting-state.json")),
    "Set PKM_PRIVATE_ROOM_BASELINE_FIXTURE to an authorized historical installed Room capture containing meeting-state.json, old-root and host-home; retired scratch is not a fixture.");
  const state = JSON.parse(fs.readFileSync(path.join(fixture, "meeting-state.json"), "utf8"));
  const source = path.join(fixture, "old-root"), root = path.join(directory, "next-root");
  await native.initialize(root);
  const storage = await native.Storage.open(root, { deferRecovery: true });
  try {
    assert.throws(() => native.copyPrivateRoomArchive(storage, source, path.join(fixture, "host-home"), state.roomId),
      /no Meeting Note privacy admission/);
    assert.equal(fs.existsSync(path.join(root, "chatrooms", state.roomId)), false);
  } finally { await storage.close(); }
  fs.cpSync(path.join(source, "chatrooms", state.roomId), path.join(root, "chatrooms", state.roomId), { recursive: true });
  await assert.rejects(native.Storage.open(root, { deferRecovery: true }), /exact in-place adoption journal/);
  assert.throws(() => native.inspectRetainedMeetingSource(root, state.roomId), /ENOENT/);
  const original = native.inspectRetainedMeetingSource(source, state.roomId);
  assert(original.notes.some(note => note.body.includes("Original private manual Note edit")));
  assert.equal(fs.readdirSync(path.join(root, "notes")).length, 0,
    "The failing reproduction must not copy a private Meeting Note into the public collection.");
});

async function original() {
  const setupResult = await setup(), { directory, native } = setupResult;
  const baseline = process.env.PKM_LEGACY_VSIX || path.join(project, "personal-knowledge-4.0.22.vsix");
  assert(fs.existsSync(baseline), "Set PKM_LEGACY_VSIX to the authorized original 4.0.22 VSIX (SHA-256 1804071cb3b9fc86edc5933d5001db6ea1a8d7a9adf30d6d2b3166fcd6048f27).");
  assert.equal(createHash("sha256").update(fs.readFileSync(baseline)).digest("hex"),
    "1804071cb3b9fc86edc5933d5001db6ea1a8d7a9adf30d6d2b3166fcd6048f27");
  const extension = path.join(directory, "original-extension"), sourceRoot = path.join(directory, "original-root");
  fs.mkdirSync(sourceRoot, { mode: 0o700 });
  for (const name of ["chat-persistence.js", "chat-persistence-worker.js", "chatroom/chat-persistence.js",
    "chatroom/chat-persistence-worker.js", "chatroom/meeting-state.js", "runtime/cross-process-lock.js", "sql-wasm.js", "sql-wasm.wasm"]) {
    const target = path.join(extension, "dist", name);
    fs.mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 });
    fs.writeFileSync(target, execFileSync("unzip", ["-p", baseline, `extension/dist/${name}`]));
  }
  fs.writeFileSync(path.join(extension, "package.json"), '{"type":"commonjs"}');
  const bundle = path.join(directory, "credentials.cjs");
  require("esbuild").buildSync({ stdin: { contents: 'export {ChatRoomCredentialStore} from "./src/chatroom/chat-room-credentials";',
    resolveDir: project }, bundle: true, platform: "node", format: "cjs", packages: "external",
    outfile: bundle, logLevel: "silent" });
  const values = new Map(), profile = { async get(key) { return values.get(key); },
    async store(key, value) { values.set(key, value); }, async delete(key) { values.delete(key); } };
  const credentials = new (require(bundle).ChatRoomCredentialStore)(profile);
  const fixture = require("../legacy/tests/next-trial-electron/chatroom-live-fixture.cjs");
  await fixture.create({ extension, root: sourceRoot, credentials: await credentials.create(fixture.roomId),
    hostParticipantId: "historic-human" });
  const Store = require(path.join(extension, "dist/chatroom/meeting-state.js")).MeetingStateStore;
  const old = new Store(path.join(sourceRoot, "chatrooms"), path.join(sourceRoot, "notes"));
  const active = await old.startMeeting({ roomId: fixture.roomId, roomName: "Original private Room",
    title: "Private retained Meeting", problemStatement: "Private problem", owner: "Original Host", lead: "Original Host",
    recorder: "Original Host", participants: ["Original Host", "Original Guest"], host: "Original Host",
    triggerMessageId: "discuss", requestId: "start", expectedRevision: 0 });
  await old.adjournMeeting({ roomId: fixture.roomId, meetingId: active.id, actor: "Original Host",
    requestId: "adjourn", expectedRevision: active.revision });
  const originalNote = path.join(sourceRoot, "notes", active.markdownPath);
  fs.appendFileSync(originalNote, "\nPrivate original manual annotations — retain exact bytes.\n");
  const golden = fs.readFileSync(originalNote, "utf8"), root = path.join(directory, "next-root");
  await native.initialize(root);
  let allowed = true;
  const options = { profile, credentials, assertAuthority() { if (!allowed) throw new Error("Owner revoked."); },
    async authorize() { return allowed; } };
  return { ...setupResult, sourceRoot, root, Store, originalNote, golden, options, profile, values,
    roomId: fixture.roomId, meetingId: active.id, revoke() { allowed = false; } };
}
function privateNote(root) {
  const intent = fs.readdirSync(path.join(root, ".pkm-room-admission"))[0];
  const dir = path.join(root, ".pkm-room-admission", intent, "notes");
  return path.join(dir, fs.readdirSync(dir)[0]);
}
test("exact private admission retains manual Note and Host proof across Storage restart without a public Note", async () => {
  const f = await original();
  let storage = await f.native.Storage.open(f.root, { deferRecovery: true });
  try {
    await assert.rejects(f.native.admitPrivateRoom({ ...f.options, storage, sourceRoot: f.sourceRoot, roomId: f.roomId,
      async authorize() { return false; } }), /approval denied/);
    assert.equal(fs.existsSync(path.join(f.root, ".pkm-room-admission")), false);
    await f.native.admitPrivateRoom({ ...f.options, storage, sourceRoot: f.sourceRoot, roomId: f.roomId });
    assert.equal(fs.readFileSync(privateNote(f.root), "utf8"), f.golden);
    assert.equal(fs.statSync(privateNote(f.root)).mode & 0o077, 0);
    assert.deepEqual(fs.readdirSync(path.join(f.root, "notes")), []);
    let meetings = f.native.createNextRoomMeetings({ storage, Store: f.Store,
      assertAuthority: f.options.assertAuthority, async authorize() {} });
    await meetings.admit(f.roomId);
    assert.equal((await meetings.store.readNote(f.roomId, f.meetingId)).content, f.golden);
    await storage.close(); storage = undefined;
    await assert.rejects(f.native.Storage.open(f.root, { deferRecovery: true }), /explicit independent profile-pin recovery/);
    storage = await f.native.openPrivateRoomAdmissions({ ...f.options, root: f.root });
    meetings = f.native.createNextRoomMeetings({ storage, Store: f.Store,
      assertAuthority: f.options.assertAuthority, async authorize() {} });
    await meetings.admit(f.roomId);
    assert.equal((await meetings.store.readNote(f.roomId, f.meetingId)).content, f.golden);
    const profileKey = [...f.values.keys()].find(key => key.startsWith("personalKnowledge.next.privateRoomAdmission"));
    const saved = f.values.get(profileKey); f.values.delete(profileKey);
    await assert.rejects(meetings.store.readNote(f.roomId, f.meetingId), /profile authorization was removed/);
    f.values.set(profileKey, saved);
    f.revoke();
    await assert.rejects(meetings.store.readNote(f.roomId, f.meetingId), /revoked/);
    assert.equal(fs.readFileSync(f.originalNote, "utf8"), f.golden);
  } finally { await storage?.close(); }
});
for (const phase of ["prepared", "staged", "published", "committed"]) {
  test(`durable private admission resumes ${phase} without overwriting original/manual text or repeating SQL receipts`, async () => {
    const f = await original();
    let storage = await f.native.Storage.open(f.root, { deferRecovery: true });
    try {
      await assert.rejects(f.native.admitPrivateRoom({ ...f.options, storage, sourceRoot: f.sourceRoot, roomId: f.roomId,
        checkpoint(value) { if (value === phase) throw new Error(`injected ${phase}`); } }), new RegExp(`injected ${phase}`));
      await storage.close(); storage = undefined;
      storage = await f.native.openPrivateRoomAdmissions({ ...f.options, root: f.root });
      const db = storage.connectNative();
      try { assert.equal(db.prepare("SELECT count(*) AS n FROM next_private_room_admissions").get().n, 1); }
      finally { db.close(); }
      assert.equal(fs.readFileSync(f.originalNote, "utf8"), f.golden);
      assert.equal(fs.readFileSync(privateNote(f.root), "utf8"), f.golden);
      assert.deepEqual(fs.readdirSync(path.join(f.root, "notes")), []);
    } finally { await storage?.close(); }
  });
}
for (const changed of ["original", "private-copy"]) {
  test(`recovery rejects ${changed} user edits and preserves both versions`, async () => {
    const f = await original();
    let storage = await f.native.Storage.open(f.root, { deferRecovery: true });
    try {
      await assert.rejects(f.native.admitPrivateRoom({ ...f.options, storage, sourceRoot: f.sourceRoot, roomId: f.roomId,
        checkpoint(value) { if (value === "staged") throw new Error("injected staged"); } }), /injected staged/);
      await storage.close(); storage = undefined;
      const file = changed === "original" ? f.originalNote : privateNote(f.root);
      fs.appendFileSync(file, "\nLater user edit, never overwrite.\n");
      const edited = fs.readFileSync(file);
      await assert.rejects(f.native.openPrivateRoomAdmissions({ ...f.options, root: f.root }), /changed/);
      assert.deepEqual(fs.readFileSync(file), edited);
      assert.equal(fs.readFileSync(changed === "original" ? privateNote(f.root) : f.originalNote, "utf8"), f.golden);
    } finally { await storage?.close(); }
  });
}
test("profile stage pin durable before filesystem receipt is recovered without inventing a new stage", async () => {
  const f = await original();
  let storage = await f.native.Storage.open(f.root, { deferRecovery: true }), interrupted = false;
  try {
    const profile = { get: f.profile.get, async store(key, value) {
      await f.profile.store(key, value);
      if (!interrupted && key.startsWith("personalKnowledge.next.privateRoomAdmissionStage")) {
        interrupted = true; throw new Error("profile store interrupted after durability");
      }
    } };
    await assert.rejects(f.native.admitPrivateRoom({ ...f.options, profile, storage, sourceRoot: f.sourceRoot, roomId: f.roomId }),
      /after durability/);
    await storage.close(); storage = undefined;
    storage = await f.native.openPrivateRoomAdmissions({ ...f.options, root: f.root });
    assert.equal(fs.readFileSync(privateNote(f.root), "utf8"), f.golden);
  } finally { await storage?.close(); }
});
test("profile cache acknowledgement lag cannot publish before the exact stage pin is observable", async () => {
  const f = await original(), storage = await f.native.Storage.open(f.root, { deferRecovery: true });
  let stale, remaining = 0;
  const profile = {
    async get(key) { if (remaining-- > 0) return stale; return f.profile.get(key); },
    async store(key, value) {
      stale = await f.profile.get(key); await f.profile.store(key, value); remaining = 3;
    },
  };
  try {
    await f.native.admitPrivateRoom({ ...f.options, storage, profile, sourceRoot: f.sourceRoot, roomId: f.roomId });
    await f.native.assertPrivateRoomAdmissions(storage);
    assert.equal(fs.readFileSync(privateNote(f.root), "utf8"), f.golden);
  } finally { await storage.close(); }
});
test("immutable stage PIN does not rewrite the prepared profile key whose late event can regress cached reads", async () => {
  const f = await original(), storage = await f.native.Storage.open(f.root, { deferRecovery: true });
  const first = new Map(), rewritten = new Set();
  const profile = {
    async get(key) { return rewritten.has(key) ? first.get(key) : f.profile.get(key); },
    async store(key, value) {
      if (first.has(key) && first.get(key) !== value) rewritten.add(key);
      else first.set(key, value);
      await f.profile.store(key, value);
    },
  };
  try {
    await f.native.admitPrivateRoom({ ...f.options, storage, profile, sourceRoot: f.sourceRoot, roomId: f.roomId });
    await f.native.assertPrivateRoomAdmissions(storage);
    assert.equal(rewritten.size, 0);
  } finally { await storage.close(); }
});
test("native receipt conflicts and replaced marker are not repaired by the profile pin", async () => {
  const f = await original();
  let storage = await f.native.Storage.open(f.root, { deferRecovery: true });
  try {
    await f.native.admitPrivateRoom({ ...f.options, storage, sourceRoot: f.sourceRoot, roomId: f.roomId });
    const db = storage.connectNative();
    try { db.prepare("UPDATE next_private_room_admissions SET stage_hash=?").run("0".repeat(64)); }
    finally { db.close(); }
    await storage.close(); storage = undefined;
    await assert.rejects(f.native.openPrivateRoomAdmissions({ ...f.options, root: f.root }), /receipt conflicts/);
    const marker = path.join(f.root, ".pkm-next-workspace"), saved = path.join(f.root, "saved-marker");
    fs.renameSync(marker, saved); fs.copyFileSync(saved, marker);
    await assert.rejects(f.native.openPrivateRoomAdmissions({ ...f.options, root: f.root }), /marker identity changed/);
  } finally { await storage?.close(); }
});
for (const phase of ["published", "committed"]) {
  test(`actual SIGKILL after ${phase} recovers exact private files and one native receipt`, async () => {
    const f = await original();
    const profileFile = path.join(f.directory, "private-profile.json"), configFile = path.join(f.directory, "crash-config.json");
    fs.writeFileSync(profileFile, JSON.stringify(Object.fromEntries(f.values)), { mode: 0o600 });
    fs.writeFileSync(configFile, JSON.stringify({ root: f.root, sourceRoot: f.sourceRoot, roomId: f.roomId, profileFile,
      credentialsBundle: path.join(f.directory, "credentials.cjs") }), { mode: 0o600 });
    const child = fork(path.join(project, "tests/next-trial-electron/room-admission-crash-worker.cjs"),
      [path.join(f.directory, "native.mjs"), configFile, phase], { stdio: ["ignore", "ignore", "pipe", "ipc"] });
    let stderr = ""; child.stderr.on("data", data => { stderr += data; });
    const exited = await new Promise((resolve, reject) => {
      const timeout = setTimeout(() => { child.kill("SIGKILL"); reject(new Error("Crash worker timeout.")); }, 20000);
      child.once("error", reject);
      child.once("exit", (code, signal) => { clearTimeout(timeout); resolve({ code, signal }); });
    });
    assert.equal(exited.signal, "SIGKILL", stderr);
    const stored = JSON.parse(fs.readFileSync(profileFile, "utf8"));
    for (const [key, value] of Object.entries(stored)) f.values.set(key, value);
    const storage = await f.native.openPrivateRoomAdmissions({ ...f.options, root: f.root });
    try {
      const db = storage.connectNative();
      try { assert.equal(db.prepare("SELECT count(*) AS n FROM next_private_room_admissions").get().n, 1); }
      finally { db.close(); }
      assert.equal(fs.readFileSync(privateNote(f.root), "utf8"), f.golden);
      assert.equal(fs.readFileSync(f.originalNote, "utf8"), f.golden);
      assert.deepEqual(fs.readdirSync(path.join(f.root, "notes")), []);
    } finally { await storage.close(); }
  });
}
