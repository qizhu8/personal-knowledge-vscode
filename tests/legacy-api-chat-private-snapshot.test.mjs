import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { fork } from "node:child_process";
import { once } from "node:events";
import { chmodSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join, resolve } from "node:path";
import { test } from "node:test";
import { inspectLegacyApiChatArchive } from "../dist/legacy-api-chat-archive.js";
import { createLegacyChatPrivateSnapshot, reopenLegacyChatPrivateSnapshot } from "../dist/legacy-api-chat-private-snapshot.js";

const require = createRequire(import.meta.url);
const project = resolve(new URL("../legacy", import.meta.url).pathname);
const fixture = require("../legacy/tests/next-trial-electron/api-chat-fixture.cjs");

function setup(t) {
  const directory = join(project, ".migration-test-work", `chat-snapshot-test-${randomUUID()}`);
  const root = join(directory, "source"), parent = join(directory, "private");
  mkdirSync(root, { recursive: true, mode: 0o700 });
  mkdirSync(parent, { mode: 0o700 });
  const mask = process.umask(0o077);
  let descriptor;
  try { descriptor = fixture.create({ extension: process.env.PKM_TEST_LEGACY_CHAT_EXTENSION ?? project, root }); }
  finally { process.umask(mask); }
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  return { root, parent, descriptor };
}

test("reopening a pinned Chat snapshot tolerates restarted host records but rejects changed Chat content", t => {
  const { root, parent, descriptor } = setup(t), control = join(descriptor.state, "api-chat-control");
  const hosts = join(control, "hosts"), requests = join(control, "requests"), oldId = randomUUID();
  mkdirSync(hosts, { recursive: true, mode: 0o700 });
  mkdirSync(join(requests, oldId), { recursive: true, mode: 0o700 });
  const host = id => ({ schema: "pkm.api-chat.host/v1", hostId: id, pid: 123, updatedAt: 1000,
    operations: ["list"], portalRequestDirectory: "/isolated/portal", workspacePaths: [root] });
  writeFileSync(join(hosts, `${oldId}.json`), JSON.stringify(host(oldId)), { mode: 0o600 });
  const copy = createLegacyChatPrivateSnapshot(root, parent), fingerprint = inspectLegacyApiChatArchive(copy.root).sourceFingerprint;
  rmSync(join(hosts, `${oldId}.json`));
  const nextId = randomUUID();
  mkdirSync(join(requests, nextId), { mode: 0o700 });
  writeFileSync(join(hosts, `${nextId}.json`), JSON.stringify(host(nextId)), { mode: 0o600 });
  const reopened = reopenLegacyChatPrivateSnapshot(root, copy.root, fingerprint);
  assert.equal(reopened.root, copy.root);
  reopened.assertSnapshotCurrent();
  const { ChatLibrary } = require(join(process.env.PKM_TEST_LEGACY_CHAT_EXTENSION ?? project, "dist/chat/chat-library.js"));
  new ChatLibrary(join(descriptor.state, "api-chats")).createGroup("Changed after restart");
  assert.throws(() => reopenLegacyChatPrivateSnapshot(root, copy.root, fingerprint), { code: "LEGACY_CHAT_SOURCE_CONFLICT" });
});

test("reopening rejects a modified or substituted snapshot", t => {
  const { root, parent } = setup(t), copy = createLegacyChatPrivateSnapshot(root, parent);
  const fingerprint = inspectLegacyApiChatArchive(copy.root).sourceFingerprint;
  assert.throws(() => reopenLegacyChatPrivateSnapshot(root, copy.root, "0".repeat(64)), { code: "LEGACY_CHAT_SOURCE_CONFLICT" });
  chmodSync(copy.root, 0o750);
  assert.throws(() => reopenLegacyChatPrivateSnapshot(root, copy.root, fingerprint), /owner-private/);
});

test("private archive copy detects later source changes without writing the original", t => {
  const { root, parent, descriptor } = setup(t);
  const before = inspectLegacyApiChatArchive(root);
  const copy = createLegacyChatPrivateSnapshot(root, parent);
  assert.equal(copy.kind, "optimistic-snapshot");
  assert.equal(inspectLegacyApiChatArchive(root).sourceFingerprint, before.sourceFingerprint);
  assert.deepEqual(inspectLegacyApiChatArchive(copy.root).chats, before.chats);
  copy.assertSnapshotCurrent();
  const { ChatLibrary } = require(join(process.env.PKM_TEST_LEGACY_CHAT_EXTENSION ?? project, "dist/chat/chat-library.js"));
  new ChatLibrary(join(descriptor.state, "api-chats")).createGroup("Changed by original Chat interface");
  assert.throws(() => copy.assertSnapshotCurrent(), { code: "LEGACY_CHAT_SOURCE_CONFLICT" });
  assert.deepEqual(inspectLegacyApiChatArchive(copy.root).chats, before.chats);
});

test("private archive copy rejects live old locks and detects copy modifications", t => {
  const { root, parent, descriptor } = setup(t);
  const lock = join(descriptor.state, "api-chats", "chats.lock");
  mkdirSync(lock, { mode: 0o700 });
  assert.throws(() => createLegacyChatPrivateSnapshot(root, parent), { code: "LEGACY_API_CHAT_BLOCKED" });
  assert.deepEqual(readdirSync(parent), []);
  rmSync(lock, { recursive: true });
  const copy = createLegacyChatPrivateSnapshot(root, parent);
  writeFileSync(join(copy.root, ".pkm", "state", "api-chats", "library.json"),
    JSON.stringify({ version: 1, groups: [], placements: {} }), { mode: 0o600, flag: "wx" });
  assert.throws(() => copy.assertSnapshotCurrent(), { code: "LEGACY_CHAT_SOURCE_CONFLICT" });
});

test("private archive copy requires an isolated owner-private parent", t => {
  const { root, parent } = setup(t);
  assert.throws(() => createLegacyChatPrivateSnapshot(root, root), /separate canonical/);
  chmodSync(parent, 0o750);
  assert.throws(() => createLegacyChatPrivateSnapshot(root, parent), /owner-private/);
});

test("private archive copy reports concurrent original library writes", async t => {
  const { root, parent, descriptor } = setup(t);
  const extension = process.env.PKM_TEST_LEGACY_CHAT_EXTENSION ?? project;
  const child = fork(join(project, "tests", "fixtures", "chat-snapshot-library-writer.cjs"),
    [extension, join(descriptor.state, "api-chats")], { stdio: ["ignore", "ignore", "inherit", "ipc"] });
  t.after(() => { if (child.exitCode === null && child.signalCode === null) child.kill(); });
  await once(child, "message");
  try {
    assert.throws(() => createLegacyChatPrivateSnapshot(root, parent), error =>
      ["LEGACY_API_CHAT_BLOCKED", "LEGACY_CHAT_SOURCE_CONFLICT"].includes(error.code));
  } finally {
    child.send("stop");
    const [code] = await once(child, "exit");
    assert.equal(code, 0);
  }
});

test("snapshot copy tolerates only validated host replacement during capture", async t => {
  for (const changedField of [false, true]) await t.test(changedField ? "other host data changes" : "heartbeat", t => {
    const { root, parent, descriptor } = setup(t), id = randomUUID();
    const hosts = join(descriptor.state, "api-chat-control", "hosts");
    mkdirSync(hosts, { recursive: true, mode: 0o700 });
    mkdirSync(join(descriptor.state, "api-chat-control", "requests", id), { recursive: true, mode: 0o700 });
    const host = join(hosts, `${id}.json`);
    const initial = { schema: "pkm.api-chat.host/v1", hostId: id, pid: 123, updatedAt: 1000,
      operations: ["list"], portalRequestDirectory: "/isolated/portal", workspacePaths: [root] };
    writeFileSync(host, JSON.stringify(initial), { mode: 0o600 });
    const fs = require("node:fs"), ts = require("typescript");
    const source = readFileSync(join(project, "../src/legacy-api-chat-private-snapshot.ts"), "utf8");
    const js = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
    let replaced = false;
    const instrumented = { ...fs, writeFileSync(file, ...args) {
      if (!replaced && String(file).startsWith(parent + "/")) {
        replaced = true;
        const temporary = `${host}.${randomUUID()}.tmp`;
        writeFileSync(temporary, JSON.stringify({ ...initial, updatedAt: 4000,
          ...(changedField ? { operations: ["send"] } : {}) }), { mode: 0o600 });
        renameSync(temporary, host);
      }
      return fs.writeFileSync(file, ...args);
    } };
    const module = { exports: {} };
    new Function("require", "module", "exports", js)(name =>
      name === "node:fs" ? instrumented : name === "./legacy-api-chat-archive.js" ? { inspectLegacyApiChatArchive } : require(name),
    module, module.exports);
    if (changedField) {
      assert.throws(() => module.exports.createLegacyChatPrivateSnapshot(root, parent), { code: "LEGACY_CHAT_SOURCE_CONFLICT" });
    } else {
      const copy = module.exports.createLegacyChatPrivateSnapshot(root, parent);
      assert.equal(readFileSync(join(copy.root, ".pkm/state/api-chat-control/hosts", `${id}.json`), "utf8"), JSON.stringify(initial));
      assert.equal(JSON.parse(readFileSync(host, "utf8")).updatedAt, 4000);
      copy.assertSnapshotCurrent();
    }
    assert.equal(replaced, true);
  });
});

test("bounded graph-scan retry still rejects an original Chat change", t => {
  const { root, parent, descriptor } = setup(t), ts = require("typescript");
  const source = readFileSync(join(project, "../src/legacy-api-chat-private-snapshot.ts"), "utf8");
  const js = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
  let inject = false, changeChat = false;
  const inspect = path => {
    if (inject && path === root) {
      inject = false;
      if (changeChat) {
        const chatPath = join(descriptor.state, "api-chats", descriptor.namespace, `${descriptor.inline}.json`);
        const chat = JSON.parse(readFileSync(chatPath, "utf8")); chat.title = "Changed during scan";
        writeFileSync(chatPath, JSON.stringify(chat));
      }
      throw Object.assign(new Error("LEGACY_API_CHAT_BLOCKED: API Chat entities changed during graph verification."),
        { code: "LEGACY_API_CHAT_BLOCKED" });
    }
    return inspectLegacyApiChatArchive(path);
  };
  const module = { exports: {} };
  new Function("require", "module", "exports", js)(name =>
    name === "./legacy-api-chat-archive.js" ? { inspectLegacyApiChatArchive: inspect } : require(name),
  module, module.exports);
  const snapshot = module.exports.createLegacyChatPrivateSnapshot(root, parent);
  inject = true;
  snapshot.assertSnapshotCurrent();
  assert.equal(inject, false);
  changeChat = true; inject = true;
  assert.throws(() => snapshot.assertSnapshotCurrent(), { code: "LEGACY_CHAT_SOURCE_CONFLICT" });
  assert.equal(inject, false);
});

test("archive scan retries only recognized races and stops after three attempts", t => {
  const { root, parent } = setup(t), ts = require("typescript");
  const source = readFileSync(join(project, "../src/legacy-api-chat-private-snapshot.ts"), "utf8");
  const js = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
  for (const [message, expected] of [
    ["LEGACY_API_CHAT_BLOCKED: API Chat entities changed during graph verification.", 3],
    ["LEGACY_API_CHAT_BLOCKED: Invalid archived API host.", 1],
  ]) {
    let attempts = 0;
    const module = { exports: {} };
    new Function("require", "module", "exports", js)(name =>
      name === "./legacy-api-chat-archive.js" ? { inspectLegacyApiChatArchive: () => {
        attempts++;
        throw Object.assign(new Error(message), { code: "LEGACY_API_CHAT_BLOCKED" });
      } } : require(name), module, module.exports);
    assert.throws(() => module.exports.createLegacyChatPrivateSnapshot(root, parent), { message });
    assert.equal(attempts, expected);
  }
});

test("only an otherwise identical monotonic original host heartbeat is tolerated", async t => {
  for (const kind of ["heartbeat", "host-field", "regression", "same-timestamp-replace", "add-host",
    "remove-host", "request", "request-change", "duplicate-keys", "symlink", "copy", "chat"]) await t.test(kind, t => {
    const { root, parent, descriptor } = setup(t);
    const id = randomUUID(), control = join(descriptor.state, "api-chat-control");
    const hosts = join(control, "hosts"), requests = join(control, "requests", id);
    mkdirSync(hosts, { recursive: true, mode: 0o700 });
    mkdirSync(requests, { recursive: true, mode: 0o700 });
    const host = join(hosts, `${id}.json`);
    const value = { schema: "pkm.api-chat.host/v1", hostId: id, pid: 123, updatedAt: 1000,
      operations: ["list", "send"], portalRequestDirectory: "/isolated/portal",
      workspacePaths: [root], metadata: { retained: "unchanged" } };
    const write = (target, payload) => {
      const staging = `${target}.${randomUUID()}.tmp`;
      writeFileSync(staging, JSON.stringify(payload), { mode: 0o600 });
      renameSync(staging, target);
    };
    write(host, value);
    const requestId = "a".repeat(64), requestPath = join(requests, `${requestId}.json`);
    const request = { schema: "pkm.api-chat.request/v1", hostId: id, requestId,
      operation: "send", status: "queued", arguments: { chatId: descriptor.inline } };
    if (kind === "request-change") write(requestPath, request);
    const snapshot = createLegacyChatPrivateSnapshot(root, parent);
    const heartbeat = { ...value, updatedAt: 4000 };
    if (kind === "heartbeat") {
      write(host, heartbeat); snapshot.assertSnapshotCurrent();
      write(host, { ...heartbeat, updatedAt: 7000 }); snapshot.assertSnapshotCurrent();
      return;
    }
    if (kind === "host-field") write(host, { ...heartbeat, metadata: { retained: "modified" } });
    else if (kind === "regression") { write(host, heartbeat); snapshot.assertSnapshotCurrent(); write(host, value); }
    else if (kind === "same-timestamp-replace") write(host, value);
    else if (kind === "add-host") {
      const other = randomUUID();
      write(join(hosts, `${other}.json`), { ...heartbeat, hostId: other });
    } else if (kind === "remove-host") rmSync(host);
    else if (kind === "request") {
      write(requestPath, request);
    } else if (kind === "request-change") {
      write(host, heartbeat);
      write(requestPath, { ...request, status: "running" });
    } else if (kind === "duplicate-keys") {
      const staging = `${host}.${randomUUID()}.tmp`;
      writeFileSync(staging, JSON.stringify(heartbeat).replace('"updatedAt":4000', '"updatedAt":1,"updatedAt":4000'), { mode: 0o600 });
      renameSync(staging, host);
    } else if (kind === "symlink") { rmSync(host); symlinkSync(join(root, "fixture-sentinel"), host); }
    else if (kind === "copy") {
      const target = join(snapshot.root, ".pkm", "state", "api-chat-control", "hosts", `${id}.json`);
      write(target, heartbeat);
    } else {
      const target = join(descriptor.state, "api-chats", descriptor.namespace, `${descriptor.inline}.json`);
      const chat = JSON.parse(readFileSync(target, "utf8")); chat.title = "Original Chat changed";
      write(target, chat);
    }
    assert.throws(() => snapshot.assertSnapshotCurrent(), { code: "LEGACY_CHAT_SOURCE_CONFLICT" });
  });
});
