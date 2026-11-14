import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import { mkdirSync, readFileSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { test } from "node:test";
import { inspectLegacyApiChatArchive } from "../dist/legacy-api-chat-archive.js";
import { createLegacyChatPrivateSnapshot } from "../dist/legacy-api-chat-private-snapshot.js";

const require = createRequire(import.meta.url);
const extension = process.env.PKM_SELECTED_INSTALLED_EXTENSION;
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));

test("the actual old Chat Host heartbeat preserves an otherwise unchanged optimistic selected snapshot",
  { timeout: 15000, skip: !extension && "Requires an explicitly isolated installed extension" }, async t => {
  const directory = resolve("tests", `.live-control-${randomUUID()}`);
  const source = join(directory, "source"), snapshots = join(directory, "snapshots"), ipc = join(directory, "ipc");
  for (const dir of [source, snapshots, ipc]) mkdirSync(dir, { recursive: true, mode: 0o700 });
  const oldTmp = process.env.TMPDIR;
  const mask = process.umask(0o077);
  process.env.TMPDIR = ipc;
  let control;
  t.after(() => {
    control?.dispose();
    if (oldTmp === undefined) delete process.env.TMPDIR; else process.env.TMPDIR = oldTmp;
    process.umask(mask);
    rmSync(directory, { recursive: true, force: true });
  });
  const { ApiChatStore } = require(join(extension, "dist/chat/api-chat-store.js"));
  const { ApiChatAgentControl } = require(join(extension, "dist/chat/agent-control.js"));
  const state = join(source, ".pkm/state");
  const chat = new ApiChatStore(state, "0123456789abcdef").create();
  const chatFile = join(state, "api-chats", chat.workspaceNamespace, `${chat.id}.json`);
  const chatBefore = readFileSync(chatFile);
  control = new ApiChatAgentControl(state, { workspacePaths: [source] }, async () => ({}));
  const hostFile = join(state, "api-chat-control", "hosts", `${control.hostId}.json`);
  const originalHost = readFileSync(hostFile, "utf8");
  const snapshot = createLegacyChatPrivateSnapshot(source, snapshots);
  snapshot.assertSnapshotCurrent();
  const before = inspectLegacyApiChatArchive(source);
  const deadline = Date.now() + 7000;
  while (readFileSync(hostFile, "utf8") === originalHost && Date.now() < deadline) await wait(100);
  assert.notEqual(readFileSync(hostFile, "utf8"), originalHost, "Actual host did not heartbeat");
  const after = inspectLegacyApiChatArchive(source);
  assert.notEqual(after.sourceFingerprint, before.sourceFingerprint);
  const changed = after.files.filter(item => JSON.stringify(item) !== JSON.stringify(before.files.find(old => old.path === item.path)));
  assert.deepEqual(changed.map(item => item.path).sort(), [
    ".pkm/state/api-chat-control/hosts", `.pkm/state/api-chat-control/hosts/${control.hostId}.json`,
  ].sort());
  assert.deepEqual(readFileSync(chatFile), chatBefore, "Original Chat contents changed");
  snapshot.assertSnapshotCurrent();
});
