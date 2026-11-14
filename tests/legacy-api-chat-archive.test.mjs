import assert from "node:assert/strict";
import { test } from "node:test";
import { createRequire } from "node:module";
import { randomUUID, createHash } from "node:crypto";
import { chmodSync, mkdirSync, readFileSync, renameSync, writeFileSync, readdirSync, rmSync, linkSync, symlinkSync, utimesSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { resolve, join } from "node:path";
import { inspectLegacyApiChatArchive } from "../dist/legacy-api-chat-archive.js";
const require = createRequire(import.meta.url);
const project = resolve(new URL("../legacy", import.meta.url).pathname);
const fixture = require("../legacy/tests/next-trial-electron/api-chat-fixture.cjs");
const { ApiChatStore } = require("../legacy/dist/chat/api-chat-store.js");
function setup(t) {
  const directory = join(project, ".migration-test-work", `api-archive-${randomUUID()}`);
  const root = join(directory, "knowledge");
  mkdirSync(root, { recursive: true, mode: 0o700 });
  let descriptor;
  const mask = process.umask(0o077);
  try { descriptor = fixture.create({ extension: project, root }); } finally { process.umask(mask); }
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  return { root, ...descriptor, directory,
    segmentedFile: join(descriptor.state, "api-chats", fixture.namespace, `${descriptor.segmented}.json`) };
}
test("original empty shared control directories require an unchanged private ancestor", { skip: process.platform !== "linux" }, t => {
  const directory = join(project, ".migration-test-work", `empty-control-${randomUUID()}`);
  const parent = join(directory, "private"), root = join(parent, "knowledge");
  const control = join(root, ".pkm/state/api-chat-control"), requests = join(control, "requests"), hosts = join(control, "hosts");
  const hostId = randomUUID(), requestHost = join(requests, hostId);
  mkdirSync(requestHost, { recursive: true, mode: 0o700 });
  mkdirSync(hosts, { mode: 0o700 });
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  for (const dir of [root, control, hosts, requests, requestHost]) chmodSync(dir, 0o775);
  const initial = inspectLegacyApiChatArchive(root);
  assert.equal(initial.managed.controls.length, 0);
  const again = inspectLegacyApiChatArchive(root);
  assert.equal(again.sourceFingerprint, initial.sourceFingerprint);
  chmodSync(parent, 0o777);
  assert.throws(() => inspectLegacyApiChatArchive(root), /Unsafe private archive entity/);
  chmodSync(parent, 0o700);
  assert.notEqual(inspectLegacyApiChatArchive(root).sourceFingerprint, initial.sourceFingerprint);
  chmodSync(control, 0o777);
  assert.throws(() => inspectLegacyApiChatArchive(root), /Unsafe private archive entity/);
  chmodSync(control, 0o775);
  const extra = join(requestHost, `${"a".repeat(64)}.json`);
  writeFileSync(extra, "{}", { mode: 0o600 });
  assert.throws(() => inspectLegacyApiChatArchive(root));
  rmSync(extra);
  writeFileSync(join(hosts, `${hostId}.json`), JSON.stringify({ schema: "pkm.api-chat.host/v1", hostId, pid: 1,
    updatedAt: 1, operations: [], portalRequestDirectory: "private" }), { mode: 0o600 });
  assert.throws(() => inspectLegacyApiChatArchive(root), /must contain no records/);
  rmSync(join(hosts, `${hostId}.json`));
  execFileSync("mkfifo", [extra]);
  assert.throws(() => inspectLegacyApiChatArchive(root));
  rmSync(extra);
  symlinkSync(parent, join(control, "unexpected"));
  assert.throws(() => inspectLegacyApiChatArchive(root));
  rmSync(join(control, "unexpected"));
  assert.notEqual(inspectLegacyApiChatArchive(root).sourceFingerprint, initial.sourceFingerprint);
  const beforeReplacement = inspectLegacyApiChatArchive(root).sourceFingerprint;
  renameSync(parent, `${parent}-old`);
  mkdirSync(parent, { mode: 0o700 });
  renameSync(join(`${parent}-old`, "knowledge"), root);
  assert.notEqual(inspectLegacyApiChatArchive(root).sourceFingerprint, beforeReplacement);
});
test("archive verifies actual v1 PNG/v2 segmented writer layout and retains hash-verified earlier generations inertly", t => {
  const f = setup(t), store = new ApiChatStore(f.state, fixture.namespace);
  const chat = store.load(f.segmented, false);
  chat.messages.push({ id: randomUUID(), role: "assistant", content: "A real second legacy save.", status: "complete" });
  const mask = process.umask(0o077);
  try { store.save(chat); } finally { process.umask(mask); }
  const archive = inspectLegacyApiChatArchive(f.root);
  assert.deepEqual(archive.chats.find(chat => chat.id === f.inline).messages[0].images, [fixture.image]);
  assert.deepEqual(archive.chats.find(chat => chat.id === f.segmented).messages, store.load(f.segmented, false).messages);
  assert(archive.retainedBlobs.length > 0, "Previous immutable page is a real legacy writer output, not deleted or reinterpreted.");
  assert(archive.files.some(file => file.kind === "directory" && file.path === `.pkm/state/api-chats/${fixture.namespace}`));
  assert(archive.files.every(file => file.path.startsWith(".pkm/state/") && (!file.sha256 || /^[a-f0-9]{64}$/.test(file.sha256))));
  const before = archive.sourceFingerprint;
  utimesSync(join(f.state, "api-chats", fixture.namespace), new Date(1_000), new Date(1_000));
  assert.notEqual(inspectLegacyApiChatArchive(f.root).sourceFingerprint, before, "Directory identity/metadata are fingerprint-bound.");
});

test("original Chat history lock is not an archive-wide writer fence", {
  skip: !process.env.PKM_TEST_LEGACY_CHAT_EXTENSION,
}, async t => {
  const extension = resolve(process.env.PKM_TEST_LEGACY_CHAT_EXTENSION);
  const directory = join(project, ".migration-test-work", `original-chat-lock-${randomUUID()}`);
  const root = join(directory, "knowledge");
  mkdirSync(root, { recursive: true, mode: 0o700 });
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const mask = process.umask(0o077);
  let descriptor;
  try { descriptor = fixture.create({ extension, root }); } finally { process.umask(mask); }
  const { ApiChatStore: OriginalStore } = require(join(extension, "dist/chat/api-chat-store.js"));
  const { ChatLibrary } = require(join(extension, "dist/chat/chat-library.js"));
  const { withCrossProcessLock } = require(join(extension, "dist/runtime/cross-process-lock.js"));
  const store = new OriginalStore(descriptor.state, fixture.namespace);
  const chat = store.load(descriptor.inline, false);
  const archiveBefore = inspectLegacyApiChatArchive(root);
  const api = join(descriptor.state, "api-chats"), lock = join(api, "chats.lock");
  await withCrossProcessLock(lock, "Original Chat history", 1000, async () => {
    assert.throws(() => store.save(chat), /busy in another PKM window/);
    const library = new ChatLibrary(api);
    library.createGroup("Independent original Chat library writer");
    assert.equal(library.read().groups.length, 1);
    assert.throws(() => inspectLegacyApiChatArchive(root), { code: "LEGACY_API_CHAT_BLOCKED" });
  });
  assert.notEqual(inspectLegacyApiChatArchive(root).sourceFingerprint, archiveBefore.sourceFingerprint);
});

test("archive refuses corrupt chunks, missing graph members, orphan controls, links and active queues", async t => {
  const cases = {
    corrupt(f) {
      const directory = join(f.state, "api-chat-history", f.segmented);
      writeFileSync(join(directory, readdirSync(directory)[0]), "Not the named digest.");
    },
    missing(f) {
      const index = JSON.parse(readFileSync(f.segmentedFile));
      rmSync(join(f.state, "api-chat-history", f.segmented, `${index.messageHistory.pages[0].digest}.bin`));
    },
    orphan(f) { mkdirSync(join(f.state, "api-chat-history", randomUUID()), { mode: 0o700 }); },
    hardlink(f) {
      const file = join(f.state, "api-chats", fixture.namespace, `${f.inline}.json`);
      linkSync(file, join(f.directory, "linked.json"));
    },
    symlink(f) {
      const directory = join(f.state, "api-chat-history", f.segmented), file = join(directory, readdirSync(directory)[0]);
      const bytes = readFileSync(file); rmSync(file); writeFileSync(join(f.directory, "outside.bin"), bytes, { mode: 0o600 });
      symlinkSync(join(f.directory, "outside.bin"), file);
    },
    queue(f) {
      const metadata = JSON.parse(readFileSync(f.segmentedFile)); metadata.queuedInputs = [{ id: randomUUID(), text: "pending", mode: "task" }];
      writeFileSync(f.segmentedFile, JSON.stringify(metadata));
    },
    unknown(f) { writeFileSync(join(f.state, "api-chats", "unknown-control.json"), "{}", { mode: 0o600 }); },
    "library-orphan"(f) {
      writeFileSync(join(f.state, "api-chats/library.json"), JSON.stringify({
        version: 1, groups: [], placements: { [randomUUID()]: { groupId: "ungroup" } },
      }), { mode: 0o600 });
    },
    "library-duplicate-name"(f) {
      writeFileSync(join(f.state, "api-chats/library.json"), JSON.stringify({
        version: 1, groups: [{ id: `chat_group_${"a".repeat(32)}`, name: "Original" },
          { id: `chat_group_${"b".repeat(32)}`, name: "original" }], placements: {},
      }), { mode: 0o600 });
    },
    "library-live-lock"(f) { writeFileSync(join(f.state, "api-chats/library.lock"), "active", { mode: 0o600 }); },
  };
  for (const [name, corrupt] of Object.entries(cases)) await t.test(name, t => {
    const f = setup(t); corrupt(f);
    const before = createHash("sha256").update(readFileSync(f.segmentedFile)).digest("hex");
    assert.throws(() => inspectLegacyApiChatArchive(f.root), error => error.code === "LEGACY_API_CHAT_BLOCKED");
    assert.equal(createHash("sha256").update(readFileSync(f.segmentedFile)).digest("hex"), before);
  });
});
