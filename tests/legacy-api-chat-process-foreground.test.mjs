import assert from "node:assert/strict";
import { test } from "node:test";
import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { LegacyApiChatProcesses } from "../dist/legacy-api-chat-process.js";

test("foreground receipt and output survive host close without replay; cwd changes during approval are rejected", {
  skip: process.platform !== "linux", timeout: 10000,
}, async t => {
  const project = resolve(new URL("../legacy", import.meta.url).pathname);
  const directory = join(project, ".migration-test-work", `foreground-process-${randomUUID()}`);
  const root = join(directory, "root"), cwd = join(directory, "cwd"), captureDirectory = join(directory, "capture");
  for (const dir of [root, cwd, captureDirectory]) mkdirSync(dir, { recursive: true, mode: 0o700 });
  const marker = join(directory, "executions"), script = join(directory, "program.mjs");
  writeFileSync(script, `import {appendFileSync} from "node:fs"; appendFileSync(process.argv[2], "x"); process.stdout.write("persisted");`);
  const database = new DatabaseSync(join(directory, "process.sqlite"));
  const scope = { root, workspaceId: randomUUID(), actorId: randomUUID(), sourceFingerprint: "a".repeat(64),
    namespace: "0123456789abcdef", chatId: randomUUID() };
  let service, block = false, release, entered;
  const waiting = new Promise(resolve => { entered = resolve; });
  const options = { ...scope, database, captureDirectory, assertOwner() {},
    commands: [{ id: "fixture", program: process.execPath, cwd,
      arguments: args => JSON.stringify(args) === JSON.stringify([script, marker]) }],
    authorize: async () => { if (block) { entered(); await new Promise(resolve => { release = resolve; }); } return true; } };
  t.after(async () => { await service?.close(); database.close(); rmSync(directory, { recursive: true, force: true }); });
  const execute = (name, args, operationId = randomUUID()) => service.execute(scope, {
    call: { name, arguments: args }, operationId, signal: new AbortController().signal });
  const args = { program: process.execPath, arguments: [script, marker], cwd };
  service = new LegacyApiChatProcesses(options);
  const operationId = randomUUID();
  const result = JSON.parse((await execute("run_process", args, operationId)).content);
  assert.equal(result.stdout, "persisted");
  assert.equal(result.exitCode, 0);
  await assert.rejects(execute("run_process", args, operationId), /will not be replayed/);
  assert.equal(readFileSync(marker, "utf8"), "x");
  await service.close();
  service = new LegacyApiChatProcesses(options);
  const output = JSON.parse((await execute("process_output", { handle: result.outputHandle,
    stream: "stdout", start: 0, length: 100 })).content);
  assert.equal(output.text, "persisted");
  await assert.rejects(execute("run_process", args, operationId), /will not be replayed/);
  block = true;
  const pending = execute("run_process", args);
  await waiting;
  renameSync(cwd, join(directory, "original-cwd"));
  mkdirSync(cwd, { mode: 0o700 });
  release();
  await assert.rejects(pending, /working directory changed/);
  assert.equal(readFileSync(marker, "utf8"), "x");
});
