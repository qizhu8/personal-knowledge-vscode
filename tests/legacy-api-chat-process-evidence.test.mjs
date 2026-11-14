import assert from "node:assert/strict";
import { test } from "node:test";
import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { mkdirSync, readFileSync, renameSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { originalProcessOutput, originalProcessRecord } from "../dist/legacy-api-chat-process-evidence.js";
import { LegacyApiChatProcesses } from "../dist/legacy-api-chat-process.js";

test("original Chat evidence is read only through bounded no-follow directory descriptors", t => {
  const project = resolve(new URL("../legacy", import.meta.url).pathname);
  const root = join(project, ".migration-test-work", `original-process-evidence-${randomUUID()}`);
  const chat = randomUUID(), other = randomUUID(), handle = `process_${"c".repeat(64)}`;
  const base = join(root, ".pkm/state/api-chat-tool-results", chat);
  const directory = join(base, "processes", handle);
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const record = { schema: "pkm.chat.process/v1", handle, state: "running",
    spec: { program: "/fixture/program", arguments: [], cwd: root, timeoutSeconds: 86400 },
    createdAt: 1, updatedAt: 2, stdoutBytes: 9, stderrBytes: 0, childPid: 123 };
  const recordFile = join(directory, "record.json"), outputFile = join(directory, "stdout.log");
  writeFileSync(recordFile, JSON.stringify(record)); writeFileSync(outputFile, "abc你好");
  const bytes = readFileSync(outputFile), before = readFileSync(recordFile);
  const observed = originalProcessRecord(root, chat, handle);
  assert.equal(observed.state, "unknown"); assert.equal(observed.childPid, undefined);
  const output = originalProcessOutput(root, chat, { handle, stream: "stdout", start: 3, length: 6 });
  assert.equal(output.text, "你好"); assert.equal(output.end, 9); assert.equal(output.state, "unknown");
  assert.throws(() => originalProcessOutput(root, other, { handle, stream: "stdout", start: 0, length: 2 }));
  const foreground = `${Date.now()}-${randomUUID()}`;
  writeFileSync(join(base, `${foreground}.stderr.log`), "foreground evidence");
  assert.equal(originalProcessOutput(root, chat, { handle: `foreground_${foreground}`, stream: "stderr",
    start: 11, length: 8 }).text, "evidence");
  const linked = `process_${"d".repeat(64)}`;
  symlinkSync(directory, join(base, "processes", linked));
  assert.throws(() => originalProcessRecord(root, chat, linked));
  assert.throws(() => originalProcessOutput(root, chat, { handle: "../escape", stream: "stdout", start: 0, length: 1 }));
  assert.throws(() => originalProcessOutput(root, chat, { handle, stream: "../../record.json", start: 0, length: 1 }));
  assert.throws(() => originalProcessOutput(root, chat, { handle, stream: "stdout", start: 0, length: 12001 }));
  assert.deepEqual(readFileSync(recordFile), before); assert.deepEqual(readFileSync(outputFile), bytes);
});

test("live original output changes are reported as conflicts rather than a stable read", {
  skip: process.platform !== "linux", timeout: 10000,
}, async t => {
  const root = resolve("tests", `.evidence-race-${randomUUID()}`);
  const chat = randomUUID(), id = `${Date.now()}-${randomUUID()}`;
  const base = join(root, ".pkm/state/api-chat-tool-results", chat);
  mkdirSync(base, { recursive: true, mode: 0o700 });
  const log = join(base, `${id}.stdout.log`);
  writeFileSync(log, "x".repeat(12000));
  const writer = spawn(process.execPath, ["-e", `
    const fs = require("node:fs");
    const fd = fs.openSync(process.argv[1], "a");
    process.stdout.write("ready");
    setInterval(() => fs.writeSync(fd, Buffer.alloc(4096, 65)), 1);
  `, log], { stdio: ["ignore", "pipe", "pipe"] });
  const stopped = new Promise(resolve => writer.once("close", resolve));
  t.after(async () => {
    if (writer.exitCode === null && writer.signalCode === null) writer.kill("SIGTERM");
    await stopped;
    rmSync(root, { recursive: true, force: true });
  });
  await new Promise((resolve, reject) => {
    writer.stdout.once("data", resolve);
    writer.once("error", reject);
  });
  let conflict;
  const deadline = Date.now() + 3000;
  while (Date.now() < deadline && !conflict) {
    try { originalProcessOutput(root, chat, { handle: `foreground_${id}`, stream: "stdout", start: 0, length: 12000 }); }
    catch (error) {
      if (!/changed while reading/.test(String(error))) throw error;
      conflict = error;
    }
  }
  assert.ok(conflict, "A concurrent write must be surfaced as an optimistic conflict.");
});

test("a separate Chat source cannot read old evidence without an explicit live capability", { skip: process.platform !== "linux" }, async t => {
  const dir = resolve("tests", `.evidence-capability-${randomUUID()}`);
  const root = join(dir, "snapshot"), capture = join(dir, "capture");
  mkdirSync(root, { recursive: true, mode: 0o700 }); mkdirSync(capture, { mode: 0o700 });
  const database = new DatabaseSync(join(dir, "process.sqlite"));
  const scope = { root, workspaceId: randomUUID(), actorId: "local:owner", sourceFingerprint: "fixture",
    namespace: "0123456789abcdef", chatId: randomUUID() };
  const service = new LegacyApiChatProcesses({ database, captureDirectory: capture, root, workspaceId: scope.workspaceId,
    actorId: scope.actorId, sourceFingerprint: scope.sourceFingerprint, commands: [], assertOwner() {},
    authorize: async () => true, readOriginalEvidence: false });
  t.after(async () => { await service.close(); database.close(); rmSync(dir, { recursive: true, force: true }); });
  const handle = `process_${"c".repeat(64)}`;
  await assert.rejects(service.control(scope, handle, "status"), /not admitted/);
  await assert.rejects(service.execute(scope, { call: { name: "process_output",
    arguments: { handle, stream: "stdout", start: 0, length: 10 } }, operationId: randomUUID(), signal: new AbortController().signal }), /not admitted/);
});

test("original evidence capability rejects an asynchronous fence or replaced root", { skip: process.platform !== "linux" }, async t => {
  const dir = resolve("tests", `.evidence-source-${randomUUID()}`);
  const root = join(dir, "snapshot"), original = join(dir, "original"), capture = join(dir, "capture");
  for (const path of [root, original, capture]) mkdirSync(path, { recursive: true, mode: 0o700 });
  const database = new DatabaseSync(join(dir, "process.sqlite"));
  const scope = { root, workspaceId: randomUUID(), actorId: "local:owner", sourceFingerprint: "fixture",
    namespace: "0123456789abcdef", chatId: randomUUID() };
  const options = { database, captureDirectory: capture, root, workspaceId: scope.workspaceId,
    actorId: scope.actorId, sourceFingerprint: scope.sourceFingerprint, commands: [], assertOwner() {},
    authorize: async () => true, readOriginalEvidence: false };
  assert.throws(() => new LegacyApiChatProcesses({ ...options,
    originalEvidence: { root: original, async assertCurrent() {} } }), /synchronous/);
  const service = new LegacyApiChatProcesses({ ...options, originalEvidence: { root: original, assertCurrent() {} } });
  t.after(async () => { await service.close(); database.close(); rmSync(dir, { recursive: true, force: true }); });
  renameSync(original, `${original}.moved`);
  mkdirSync(original, { mode: 0o700 });
  await assert.rejects(service.control(scope, `process_${"c".repeat(64)}`, "status"), /root changed/);
});
