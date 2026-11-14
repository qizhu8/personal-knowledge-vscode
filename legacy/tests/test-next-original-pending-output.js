"use strict";
const assert = require("node:assert/strict");
const { test } = require("node:test");
const fs = require("node:fs");
const path = require("node:path");
const { randomUUID } = require("node:crypto");
const { DatabaseSync } = require("node:sqlite");

const extension = process.env.PKM_TEST_LEGACY_CHAT_EXTENSION;
const server = process.env.PKM_TRIAL_SERVER_DIST;
if (!extension || !server) throw Error("Provide the original installed extension and isolated Next server build.");
const old = require(path.join(extension, "chat/chat-process-runtime.js"));
const { originalProcessOutput } = require(path.join(server, "legacy-api-chat-process-evidence.js"));
const { LegacyApiChatProcesses } = require(path.join(server, "legacy-api-chat-process.js"));

test("original pending output stays readable through the authorized selected-Chat tool", { skip: process.platform !== "linux" }, async t => {
  const root = path.resolve(".migration-test-work", `original-pending-${randomUUID()}`);
  const original = path.join(root, "original"), snapshot = path.join(root, "snapshot"), capture = path.join(root, "capture");
  for (const dir of [original, snapshot, capture]) fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const chatId = randomUUID(), chatRoot = path.join(original, ".pkm/state/api-chat-tool-results", chatId);
  const handle = `process_${"a".repeat(64)}`, directory = path.join(chatRoot, "processes", handle);
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  const now = Date.now(), record = { schema: "pkm.chat.process/v1", handle, state: "launching",
    spec: { program: "/fixture/program", arguments: [], cwd: root, timeoutSeconds: 30 },
    createdAt: now, updatedAt: now, stdoutBytes: 0, stderrBytes: 0 };
  const recordFile = path.join(directory, "record.json");
  fs.writeFileSync(recordFile, JSON.stringify(record));
  const scope = { root: snapshot, workspaceId: randomUUID(), actorId: "local:owner", sourceFingerprint: "fixture",
    namespace: "0123456789abcdef", chatId };
  const db = new DatabaseSync(path.join(root, "process.sqlite")), approvals = [];
  let allowed = true, current = true;
  const service = new LegacyApiChatProcesses({ database: db, captureDirectory: capture, root: snapshot,
    workspaceId: scope.workspaceId, actorId: scope.actorId, sourceFingerprint: scope.sourceFingerprint,
    commands: [], assertOwner() {}, authorize: async (_scope, action) => { approvals.push(action); return allowed; },
    originalEvidence: { root: original, assertCurrent() { if (!current) throw Error("Source fence revoked"); } } });
  t.after(async () => { await service.close(); db.close(); fs.rmSync(root, { recursive: true, force: true }); });
  const input = { handle, stream: "stdout", start: 17, length: 10 };
  for (const state of ["launching", "cancelled"]) {
    record.state = state; fs.writeFileSync(recordFile, JSON.stringify(record));
    const expected = old.readChatProcessOutput(chatRoot, handle, "stdout", 17, 10);
    assert.deepEqual(expected, { handle, stream: "stdout", start: 17, end: 17, availableBytes: 0, text: "", state, pending: true });
    const result = await service.execute(scope, { call: { name: "process_output", arguments: input },
      operationId: randomUUID(), signal: new AbortController().signal });
    assert.deepEqual(JSON.parse(result.content), { ...expected, state: state === "launching" ? "unknown" : state });
  }
  assert.deepEqual(approvals, ["process_output", "process_output"]);
  const call = () => service.execute(scope, { call: { name: "process_output", arguments: input },
    operationId: randomUUID(), signal: new AbortController().signal });
  allowed = false;
  await assert.rejects(call(), /authority denied/);
  allowed = true; current = false;
  await assert.rejects(call(), /Source fence revoked/);
  current = true;
  for (const state of ["running", "paused", "complete", "unknown"]) {
    record.state = state;
    if (state === "paused") record.pausedAt = now;
    fs.writeFileSync(recordFile, JSON.stringify(record));
    assert.throws(() => originalProcessOutput(original, chatId, input));
  }
  record.state = "cancelled"; delete record.pausedAt;
  record.stdoutBytes = 1;
  fs.writeFileSync(recordFile, JSON.stringify(record));
  assert.throws(() => originalProcessOutput(original, chatId, input));
  record.stdoutBytes = 0;
  fs.writeFileSync(recordFile, JSON.stringify(record));
  fs.symlinkSync(path.join(root, "missing-target"), path.join(directory, "stdout.log"));
  assert.throws(() => originalProcessOutput(original, chatId, input));
  assert.deepEqual(JSON.parse(fs.readFileSync(recordFile, "utf8")), record);
});
