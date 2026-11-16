import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import * as fs from "node:fs";
import { createRequire } from "node:module";
import * as path from "node:path";
import { test } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

const require = createRequire(import.meta.url);
const project = fileURLToPath(new URL("..", import.meta.url));
const archiveSha256 = "1804071cb3b9fc86edc5933d5001db6ea1a8d7a9adf30d6d2b3166fcd6048f27";
const hash = bytes => createHash("sha256").update(bytes).digest("hex");
const fileHash = file => hash(fs.readFileSync(file));

function sourceHashes(root) {
  const entries = [];
  function visit(directory) {
    for (const name of fs.readdirSync(directory).sort()) {
      const file = path.join(directory, name), stat = fs.lstatSync(file);
      assert(!stat.isSymbolicLink());
      if (stat.isDirectory()) visit(file);
      else {
        assert(stat.isFile());
        entries.push([path.relative(root, file).split(path.sep).join("/"), fileHash(file)]);
      }
    }
  }
  visit(root);
  return Object.fromEntries(entries);
}

function evidenceDirectory() {
  assert(process.env.PKM_TEST_REPORTS, "Set PKM_TEST_REPORTS to an owned external report directory.");
  const directory = path.resolve(process.env.PKM_TEST_REPORTS);
  const relative = path.relative(fs.realpathSync(project), directory);
  assert(relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative),
    "Simulation evidence must remain outside the checkout.");
  let ancestor = directory;
  while (!fs.existsSync(ancestor)) ancestor = path.dirname(ancestor);
  assert.equal(fs.realpathSync(ancestor), ancestor);
  assert.equal(fs.lstatSync(ancestor).uid, process.getuid());
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  const stat = fs.lstatSync(directory);
  assert(stat.isDirectory() && !stat.isSymbolicLink());
  assert.equal(fs.realpathSync(directory), directory);
  assert.equal(stat.uid, process.getuid());
  assert.equal(stat.mode & 0o077, 0);
  return directory;
}

test("nonprivate simulation: authenticated 4.0.22 source-function producers reject incomplete Room copies and recover explicit private admission", async () => {
  assert.equal(process.env.PKM_TEST_ISOLATED_NETWORK, "1", "Use the canonical isolated test runner.");
  const archive = process.env.PKM_LEGACY_VSIX;
  assert(archive, "Set PKM_LEGACY_VSIX to the authorized original 4.0.22 VSIX.");
  assert.equal(fileHash(archive), archiveSha256);
  const reports = evidenceDirectory(), id = randomUUID();
  const parent = path.join(project, ".migration-test-work");
  assert.equal(fs.realpathSync(parent), parent);
  const directory = path.join(parent, `room-admission-simulation-${id}`);
  fs.mkdirSync(directory, { mode: 0o700 });
  const evidence = {
    schema: "pkm.room-admission-simulation/v1", status: "unfinished-or-failed",
    provenance: "Authenticated original 4.0.22 source-function execution with nonprivate synthetic inputs.",
    exclusions: "Not historical customer data, installed-host/UI parity, or real keychain evidence.",
    archiveSha256, producerFiles: {},
  };
  const savedEnvironment = new Map(), values = new Map();
  const profile = {
    async get(key) { return values.get(key); },
    async store(key, value) { values.set(key, value); },
    async delete(key) { values.delete(key); },
  };
  let storage, persistence;
  try {
    const home = path.join(directory, "home"), profileRoot = path.join(directory, "profile");
    const source = path.join(directory, "source"), rejected = path.join(directory, "rejected");
    const admitted = path.join(directory, "admitted"), extension = path.join(directory, "original");
    for (const name of ["home", "profile", "source", "temp", "home/config", "home/data", "home/cache"])
      fs.mkdirSync(path.join(directory, name), { recursive: true, mode: 0o700 });
    const environment = {
      HOME: home, USERPROFILE: home, APPDATA: profileRoot, LOCALAPPDATA: profileRoot,
      XDG_CONFIG_HOME: path.join(home, "config"), XDG_DATA_HOME: path.join(home, "data"),
      XDG_CACHE_HOME: path.join(home, "cache"),
      TMPDIR: path.join(directory, "temp"), TMP: path.join(directory, "temp"), TEMP: path.join(directory, "temp"),
    };
    for (const key of Object.keys(process.env))
      if (/^PKM_.*(?:FIXTURE|INSTALLED|PROFILE)/.test(key)) environment[key] = undefined;
    for (const [key, value] of Object.entries(environment)) {
      savedEnvironment.set(key, process.env[key]);
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
    fs.writeFileSync(path.join(directory, "package.json"), '{"type":"module"}');
    fs.symlinkSync(path.join(project, "node_modules"), path.join(directory, "node_modules"), "dir");
    for (const name of ["chat-persistence.js", "chat-persistence-worker.js", "chatroom/chat-persistence.js",
      "chatroom/chat-persistence-worker.js", "chatroom/meeting-state.js", "chatroom/chat-room-credentials.js",
      "runtime/cross-process-lock.js", "sql-wasm.js", "sql-wasm.wasm"]) {
      const bytes = execFileSync("unzip", ["-p", archive, `extension/dist/${name}`], { maxBuffer: 16 * 1024 * 1024 });
      const file = path.join(extension, "dist", name);
      fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
      fs.writeFileSync(file, bytes, { flag: "wx", mode: 0o600 });
      assert.equal(fileHash(file), hash(bytes));
      evidence.producerFiles[`extension/dist/${name}`] = hash(bytes);
    }
    fs.writeFileSync(path.join(extension, "package.json"), '{"type":"commonjs"}');
    const Persistence = require(path.join(extension, "dist/chat-persistence.js")).ChatPersistence;
    const Credentials = require(path.join(extension, "dist/chatroom/chat-room-credentials.js")).ChatRoomCredentialStore;
    const Store = require(path.join(extension, "dist/chatroom/meeting-state.js")).MeetingStateStore;
    const credentials = new Credentials(profile), roomId = randomUUID();
    const secrets = await credentials.create(roomId), now = Date.now();
    persistence = new Persistence(path.join(source, "chatrooms"), 50, 0);
    await persistence.createRoom(roomId, "Nonprivate simulation Room", {
      ownerInstallationId: "synthetic-source-function-producer",
      hostCredentialHash: secrets.hostCredentialHash, joinSecretHash: secrets.joinSecretHash,
    });
    for (const participantId of ["simulation-host", "simulation-guest"]) {
      await persistence.requestJoin(roomId, { requestId: participantId, alias: participantId,
        clientKey: participantId, kind: "human", requestedAt: now, expiresAt: now + 60000 });
      await persistence.resolveJoin(roomId, { requestId: participantId, participantId, outcome: "new", resolvedAt: now });
    }
    await persistence.recordLifecycle(roomId, "room.host_assigned", undefined, { participantId: "simulation-host" });
    await persistence.appendMany(roomId, ["discuss", "opinion"].map((messageType, index) => ({
      id: `simulation-${messageType}`, participantId: "simulation-host", aliasAtSend: "simulation-host",
      senderKind: "human", messageType: messageType === "discuss" ? "discuss" : "chat",
      content: `Nonprivate synthetic ${messageType}`, createdAt: now + index,
    })));
    await persistence.setRoomState(roomId, "stored");
    await persistence.closeRoom(roomId);
    await persistence.dispose(); persistence = undefined;
    const old = new Store(path.join(source, "chatrooms"), path.join(source, "notes"));
    const meeting = await old.startMeeting({ roomId, roomName: "Nonprivate simulation Room",
      title: "Synthetic Meeting", problemStatement: "Exercise incomplete copy protections",
      owner: "simulation-host", lead: "simulation-host", recorder: "simulation-host",
      participants: ["simulation-host", "simulation-guest"], host: "simulation-host",
      triggerMessageId: "simulation-discuss", requestId: "simulation-start", expectedRevision: 0 });
    const discussed = await old.recordDiscussionMessage({ roomId, participant: "simulation-host",
      text: "Nonprivate synthetic opinion", sourceMessageId: "simulation-opinion" });
    assert(discussed);
    await old.adjournMeeting({ roomId, meetingId: meeting.id, actor: "simulation-host",
      requestId: "simulation-adjourn", expectedRevision: discussed.revision });
    const note = path.join(source, "notes", meeting.markdownPath);
    fs.appendFileSync(note, "\nSIMULATION ONLY: manually appended nonprivate Note text.\n");
    const golden = fs.readFileSync(note, "utf8"), originals = sourceHashes(source);
    evidence.generatedSourceFiles = originals;

    const build = (file, contents) => require("esbuild").buildSync({
      stdin: { contents, resolveDir: project }, bundle: true, platform: "node", format: "esm",
      packages: "external", outfile: path.join(directory, file), logLevel: "silent",
    });
    build("storage-worker.js", 'import "./src/storage-worker";');
    build("native.mjs", `
      export {initialize,Storage} from "./src/storage";
      export {inspectLegacyChatroomArchive} from "./src/legacy-chatroom-continuation";
      export {inspectRetainedMeetingSource} from "./src/next-room-meeting-source";
      export {copyPrivateRoomArchive} from "./src/legacy-chatroom-private-copy";
      export {admitPrivateRoom,openPrivateRoomAdmissions,assertPrivateRoomAdmissions} from "./src/next-room-private-admission";
      export {createNextRoomMeetings} from "./src/next-room-meetings";`);
    const native = await import(pathToFileURL(path.join(directory, "native.mjs")));
    const archiveFingerprint = native.inspectLegacyChatroomArchive(source, roomId).sourceFingerprint;
    const meetingSource = native.inspectRetainedMeetingSource(source, roomId);
    assert.equal(meetingSource.notes.length, 1);
    assert.equal(meetingSource.notes[0].body, golden);
    await native.initialize(rejected);
    storage = await native.Storage.open(rejected, { deferRecovery: true });
    assert.throws(() => native.copyPrivateRoomArchive(storage, source, home, roomId),
      /no Meeting Note privacy admission/);
    assert.equal(fs.existsSync(path.join(rejected, "chatrooms", roomId)), false);
    await storage.close(); storage = undefined;
    fs.cpSync(path.join(source, "chatrooms", roomId), path.join(rejected, "chatrooms", roomId), { recursive: true });
    await assert.rejects(async () => {
      const unexpected = await native.Storage.open(rejected, { deferRecovery: true });
      await unexpected.close();
    }, /exact in-place adoption journal/);
    assert.throws(() => native.inspectRetainedMeetingSource(rejected, roomId), /ENOENT/);
    assert.deepEqual(fs.readdirSync(path.join(rejected, "notes")), []);
    assert.deepEqual(sourceHashes(source), originals);

    await native.initialize(admitted);
    storage = await native.Storage.open(admitted, { deferRecovery: true });
    const workspaceId = await storage.workspaceId();
    const options = { profile, credentials, assertAuthority() {}, async authorize(binding) {
      assert.equal(binding.root, admitted);
      assert.equal(binding.workspaceId, workspaceId);
      assert.equal(binding.sourceRoot, source);
      assert.equal(binding.roomId, roomId);
      assert.equal(binding.sourceFingerprint, archiveFingerprint);
      assert.equal(binding.meetingHash, meetingSource.hash);
      assert(["admit", "recover", "use"].includes(binding.operation));
      return true;
    } };
    assert.equal(fs.existsSync(path.join(admitted, ".pkm-room-admission")), false);
    await native.admitPrivateRoom({ ...options, storage, sourceRoot: source, roomId });
    const intents = fs.readdirSync(path.join(admitted, ".pkm-room-admission"));
    assert.equal(intents.length, 1);
    const intent = path.join(admitted, ".pkm-room-admission", intents[0]);
    const read = name => JSON.parse(fs.readFileSync(path.join(intent, name), "utf8"));
    const plan = read("plan.json"), stage = read("staged.json"), commit = read("commit.json");
    const pin = JSON.parse(await profile.get(`personalKnowledge.next.privateRoomAdmission.v1.${workspaceId}`));
    assert.deepEqual(pin.entries[0].plan, plan);
    assert.equal(await profile.get(`personalKnowledge.next.privateRoomAdmissionStage.v1.${workspaceId}.${plan.intentId}`),
      hash(JSON.stringify(stage)));
    const receipt = () => {
      const db = storage.connectNative();
      try {
        const rows = db.prepare("SELECT room_id,plan_hash,stage_hash FROM next_private_room_admissions").all();
        assert.equal(rows.length, 1);
        assert.equal(rows[0].room_id, roomId);
        assert.equal(rows[0].plan_hash, hash(JSON.stringify(plan)));
        assert.equal(rows[0].stage_hash, hash(JSON.stringify(stage)));
        assert.equal(commit.planHash, rows[0].plan_hash);
        assert.equal(commit.stageHash, rows[0].stage_hash);
        return { ...rows[0] };
      } finally { db.close(); }
    };
    const beforeRecovery = receipt();
    const privateNotes = path.join(intent, "notes"), files = fs.readdirSync(privateNotes);
    assert.equal(files.length, 1);
    const privateNote = path.join(privateNotes, files[0]);
    assert.equal(fs.statSync(privateNotes).mode & 0o077, 0);
    assert.equal(fs.statSync(privateNote).mode & 0o077, 0);
    assert.equal(fs.readFileSync(privateNote, "utf8"), golden);
    const readAdmitted = async () => {
      await native.assertPrivateRoomAdmissions(storage);
      const meetings = native.createNextRoomMeetings({ storage, Store,
        assertAuthority: options.assertAuthority, async authorize(selectedRoom) { assert.equal(selectedRoom, roomId); } });
      await meetings.admit(roomId);
      assert.equal((await meetings.store.readNote(roomId, meeting.id)).content, golden);
      assert.deepEqual(fs.readdirSync(path.join(admitted, "notes")), []);
    };
    await readAdmitted();
    await storage.close(); storage = undefined;
    await assert.rejects(async () => {
      const unexpected = await native.Storage.open(admitted, { deferRecovery: true });
      await unexpected.close();
    }, /explicit independent profile-pin recovery/);
    storage = await native.openPrivateRoomAdmissions({ ...options, root: admitted });
    await readAdmitted();
    assert.deepEqual(receipt(), beforeRecovery);
    assert.equal(fs.readFileSync(privateNote, "utf8"), golden);
    assert.deepEqual(sourceHashes(source), originals);
    assert.equal(fileHash(archive), archiveSha256);
    evidence.admittedNoteSha256 = fileHash(privateNote);
    evidence.status = "passed";
  } finally {
    try {
      try {
        await persistence?.dispose(); persistence = undefined;
      } finally {
        await storage?.close(); storage = undefined;
      }
    } finally {
      for (const [key, value] of savedEnvironment)
        if (value === undefined) delete process.env[key]; else process.env[key] = value;
      fs.writeFileSync(path.join(reports, `room-admission-simulation-${id}.json`),
        JSON.stringify(evidence, null, 2) + "\n", { flag: "wx", mode: 0o600 });
      if (!persistence && !storage) fs.rmSync(directory, { recursive: true, force: true });
    }
  }
});
