import assert from "node:assert/strict";
import { test } from "node:test";
import { createRequire } from "node:module";
import { randomUUID, createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { createServer } from "node:http";
import { DatabaseSync } from "node:sqlite";
import { prepareLegacyRootAdoptionExperimental, resumeLegacyRootAdoptionExperimental } from "../dist/legacy-root-adoption.js";
import { inspectLegacyApiChatArchive } from "../dist/legacy-api-chat-archive.js";
import { createNativeRuntime } from "../dist/native-runtime.js";
import { createLegacyManagedChatLocalModel } from "../dist/legacy-api-chat-managed-provider.js";
import { LegacyApiChatProcesses } from "../dist/legacy-api-chat-process.js";
import { RuntimeProcessService } from "../dist/runtime-process.js";
import { chatTurnFixture } from "./chat-turn-fixtures.mjs";
import { LegacyManagedApiChatRuntime } from "../dist/legacy-api-chat-managed-runtime.js";
import { createLegacyChatProcessApprovalBridge } from "../dist/legacy-api-chat-process-approval.js";
import { startLegacyApiChatUiHost } from "../dist/legacy-api-chat-ui-host.js";
import { until } from "./runtime-process-fixtures.mjs";

const require = createRequire(import.meta.url), project = resolve(new URL("../legacy", import.meta.url).pathname);
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

test("failed process drain keeps capture open and retry cannot report a false close", async () => {
  const runtime = Object.create(RuntimeProcessService.prototype);
  runtime.limits = { closeDrainMs: 0 };
  let attempts = 0;
  runtime.closeOwned = async () => { if (++attempts === 1) throw new Error("Unconfirmed child drain."); };
  const processes = Object.create(LegacyApiChatProcesses.prototype);
  processes.runtime = runtime;
  let capturesClosed = 0;
  processes.capture = { close() { capturesClosed++; } };
  await assert.rejects(processes.close(), /Unconfirmed child drain/);
  assert.equal(capturesClosed, 0);
  await processes.close();
  assert.equal(attempts, 2);
  assert.equal(capturesClosed, 1);
});

test("failed turn drain remains fatal and does not close managed storage on retry", async t => {
  const fixture = chatTurnFixture(), turns = fixture.service;
  t.after(() => fixture.db.close());
  turns.active.set("active", {
    controller: new AbortController(), done: Promise.reject(new Error("Turn persistence failed."))
  });
  const managed = Object.create(LegacyManagedApiChatRuntime.prototype);
  managed.turns = turns;
  let closed = 0, released = 0;
  managed.actor = "synthetic-fatal-owner"; managed.instanceId = "synthetic-fatal-instance";
  managed.transaction = fn => fn();
  managed.db = {
    prepare(sql) {
      assert.match(sql, /^DELETE FROM legacy_managed_chat_owner/);
      return { run() { released++; } };
    },
    close() { closed++; },
  };
  await assert.rejects(managed.close(), /Turn persistence failed/);
  assert.equal(released, 0);
  turns.active.clear();
  await assert.rejects(managed.close(), /Turn persistence failed/);
  assert.equal(released, 0);
  assert.equal(closed, 0);
});

test("process persistence failure remains blocked even when no tasks remain", async () => {
  const runtime = Object.create(RuntimeProcessService.prototype);
  runtime.limits = { closeDrainMs: 0, graceMs: 0 };
  runtime.tasks = new Map();
  runtime.persistenceFailure = new Error("Write failed.");
  runtime.captures = new Map();
  let releases = 0;
  runtime.store = { release() { releases++; } };
  await assert.rejects(runtime.close(), { code: "PERSISTENCE_UNAVAILABLE" });
  await assert.rejects(runtime.close(), { code: "PERSISTENCE_UNAVAILABLE" });
  assert.equal(releases, 0);
});

test("managed model and private Chat RPC control only the authorized live process tree", { timeout: 60000, skip: process.platform !== "linux" }, async t => {
  const directory = join(project, ".migration-test-work", `chat-process-${randomUUID()}`);
  const root = join(directory, "knowledge"), script = join(directory, "tree.mjs"),
    foregroundScript = join(directory, "foreground.mjs"), bulkScript = join(directory, "bulk.mjs"),
    slowScript = join(directory, "slow.mjs"), crashDirectory = join(directory, "crash-tree");
  let storage, native, ui, server, processes, database;
  t.after(async () => {
    try { await ui?.close(); if (!ui) await processes?.close(); await native?.close(); await storage?.close(); }
    finally {
      database?.close();
      if (server) { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
      rmSync(directory, { recursive: true, force: true });
    }
  });
  const mask = process.umask(0o077);
  let ordinary, other;
  try {
    require("../legacy/tests/next-trial-electron/api-chat-fixture.cjs").create({ extension: project, root });
    mkdirSync(crashDirectory, { mode: 0o700 });
    mkdirSync(join(root, "notes"), { mode: 0o700 });
    writeFileSync(join(root, "notes/Existing.md"), "---\ntitle: Existing\nrevision: 1\n---\nSynthetic process fixture.\n", { mode: 0o600 });
    const { ApiChatStore } = require("../legacy/dist/chat/api-chat-store.js");
    const store = new ApiChatStore(join(root, ".pkm/state"), "0123456789abcdef");
    ordinary = store.create(); store.save(ordinary); other = store.create(); store.save(other);
    writeFileSync(script, `
import {spawn} from "node:child_process";
import {appendFileSync, writeFileSync} from "node:fs";
import {join} from "node:path";
const [dir, depth = "0"] = process.argv.slice(2);
process.stdout.write("tree-started-" + depth);
writeFileSync(join(dir, "pid-" + depth), String(process.pid));
if (+depth < 2) spawn(process.execPath, [process.argv[1], dir, String(+depth + 1)], {stdio:"ignore"});
setInterval(() => appendFileSync(join(dir, "ticks-" + depth), "x"), 20);
`);
    writeFileSync(foregroundScript, `process.stdout.write("foreground-result"); process.stderr.write("foreground-error");`);
    writeFileSync(slowScript, `setTimeout(() => process.stdout.write("late"), 10000);`);
    writeFileSync(bulkScript, `
const bytes = Buffer.alloc(65536, 97);
for (let i = 0; i < 1024; i++) if (!process.stdout.write(bytes)) await new Promise(resolve => process.stdout.once("drain", resolve));
process.stderr.write("!");
`);
  } finally { process.umask(mask); }
  const identity = { namespace: ordinary.workspaceNamespace, chatId: ordinary.id };
  const another = { namespace: other.workspaceNamespace, chatId: other.id };
  const nonce = randomUUID(), actorId = randomUUID();
  writeFileSync(join(directory, "in-place-fixture-token"), nonce, { mode: 0o600 });
  const options = require("../legacy/tests/next-trial-electron/in-place-options.cjs").options;
  const prepared = await prepareLegacyRootAdoptionExperimental(root, options({ fixture: directory, root, nonce }));
  storage = (await resumeLegacyRootAdoptionExperimental(root, options({ fixture: directory, root, nonce, workspaceId: prepared.workspaceId }))).storage;
  native = await createNativeRuntime({ storage, workspaceId: await storage.workspaceId() });
  const fingerprint = inspectLegacyApiChatArchive(root).sourceFingerprint;
  database = new DatabaseSync(join(directory, "process.sqlite"));
  const captureDirectory = join(directory, "native-process-evidence");
  mkdirSync(captureDirectory, { mode: 0o700 });
  let allowed = true, modelCalls = 0;
  const approvalPrompts = [];
  const approval = createLegacyChatProcessApprovalBridge({
    assertOwner: () => storage.assertWorkspaceLease(),
    policy: async scope => ({ available: allowed && scope.chatId === identity.chatId,
      trusted: true, permissionMode: "ask", localControls: scope.chatId === identity.chatId }),
    requestPermission: async prompt => { approvalPrompts.push(prompt); return true; },
    confirmLocalStop: async () => true,
  });
  const processOptions = { database, captureDirectory, root, workspaceId: prepared.workspaceId, actorId,
    sourceFingerprint: fingerprint, assertOwner: () => storage.assertWorkspaceLease(),
    authorize: approval,
    commands: [{ id: "fixture", program: process.execPath, cwd: directory,
      arguments: args => [[script, directory], [script, crashDirectory], [foregroundScript], [bulkScript], [slowScript]]
        .some(value => JSON.stringify(args) === JSON.stringify(value)) }] };
  processes = new LegacyApiChatProcesses(processOptions);
  const key = ` ${randomUUID()} `, handle = `process_${createHash("sha256").update(key).digest("hex")}`;
  const args = { program: process.execPath, arguments: [script, directory], cwd: directory,
    timeoutSeconds: 86400, background: true, idempotency_key: key };
  let modelArgs = args, modelSawForeground = false;
  server = createServer(async (request, response) => {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    const body = JSON.parse(Buffer.concat(chunks).toString());
    if (body.messages.some(message => message.role === "tool" && String(message.content).includes("foreground-result")))
      modelSawForeground = true;
    modelCalls++;
    const completed = body.messages.some(message => message.role === "tool");
    const delta = completed ? { content: "Process launched." } : { tool_calls: [{ index: 0, id: "owned-process",
      type: "function", function: { name: "run_process", arguments: JSON.stringify(modelArgs) } }] };
    response.writeHead(200, { "content-type": "text/event-stream" });
    response.end(`data: ${JSON.stringify({ choices: [{ index: 0, delta, finish_reason: null }] })}\n\n`
      + `data: ${JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: completed ? "stop" : "tool_calls" }] })}\n\ndata: [DONE]\n\n`);
  });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  const model = createLegacyManagedChatLocalModel({ endpoint: `http://127.0.0.1:${server.address().port}/v1`,
    model: "synthetic-process", apiKey: "fixture",
    tools: async () => [{ name: "run_process", description: "Run the admitted fixture.",
      parameters: { type: "object", properties: {}, additionalProperties: true } }] });
  ui = await startLegacyApiChatUiHost({ storage, actorId, chats: [identity, another], authorize: async () => true,
    provider: async () => "unused", processes,
    managed: { model, authorize: async () => true,
      tools: { available: true, execute: async () => { throw new Error("Process tools must use the scoped adapter."); } } } });
  const rpc = async input => {
    const response = await fetch(`${ui.endpoint}/rpc`, { method: "POST",
      headers: { authorization: `Bearer ${ui.bearer}`, "x-pkm-native-actor": actorId, "content-type": "application/json" },
      body: JSON.stringify(input) });
    return { status: response.status, ...await response.json() };
  };
  const ok = async input => { const result = await rpc(input); assert.equal(result.status, 200, result.error); return result.value; };
  let state = (await ok({ method: "history", ...identity })).taskControl;
  state = await ok({ method: "task-control", input: { ...identity, kind: "create", title: "Process test",
    operationId: randomUUID(), expectedRevision: state.revision } });
  const turn = { ...identity, operationId: randomUUID(), expectedRevision: 0, text: "Launch the fixture once." };
  await ok({ method: "continue", ...turn });
  const history = await ui.managed.settled(identity, turn.operationId);
  assert.equal(history.nativeTurns.at(-1).status, "completed");
  assert.equal(approvalPrompts[0].once, true);
  assert.equal(approvalPrompts[0].binding.chatId, identity.chatId);
  assert(modelCalls >= 2);
  const duration = JSON.parse(database.prepare("SELECT record_json FROM runtime_process_jobs").get().record_json);
  assert.equal(duration.deadlineAt - duration.createdAt, 86_400_000);
  await until(() => [0, 1, 2].every(n => existsSync(join(directory, `ticks-${n}`))), 5000);
  const scope = { root, workspaceId: prepared.workspaceId, actorId, sourceFingerprint: fingerprint, ...identity };
  const execute = (name, args, binding = scope) => processes.execute(binding, {
    call: { name, arguments: args }, operationId: randomUUID(), signal: new AbortController().signal });
  const oldKey = `old-${randomUUID()}`, oldHandle = `process_${createHash("sha256").update(oldKey).digest("hex")}`;
  const evidence = join(root, ".pkm/state/api-chat-tool-results", identity.chatId);
  const oldDir = join(evidence, "processes", oldHandle);
  mkdirSync(oldDir, { recursive: true, mode: 0o700 });
  const oldRecord = { schema: "pkm.chat.process/v1", handle: oldHandle, spec: { program: process.execPath,
    arguments: [script, directory], cwd: directory, timeoutSeconds: 86400 }, state: "running",
    createdAt: Date.now(), updatedAt: Date.now(), stdoutBytes: 10, stderrBytes: 0, childPid: 1234 };
  writeFileSync(join(oldDir, "record.json"), JSON.stringify(oldRecord));
  writeFileSync(join(oldDir, "stdout.log"), "old-output");
  const foregroundIdentity = `${Date.now()}-${randomUUID()}`;
  writeFileSync(join(evidence, `${foregroundIdentity}.stdout.log`), "old-foreground");
  const originalRecord = JSON.parse((await execute("process_get", { handle: oldHandle })).content);
  assert.equal(originalRecord.state, "unknown");
  assert.equal(originalRecord.childPid, undefined);
  const oldOutput = JSON.parse((await execute("process_output", { handle: oldHandle, stream: "stdout", start: 4, length: 6 })).content);
  assert.equal(oldOutput.text, "output"); assert.equal(oldOutput.state, "unknown");
  const foregroundOutput = JSON.parse((await execute("process_output", {
    handle: `foreground_${foregroundIdentity}`, stream: "stdout", start: 0, length: 100 })).content);
  assert.equal(foregroundOutput.text, "old-foreground");
  await assert.rejects(execute("process_cancel", { handle: oldHandle }), /outside this Chat authority/);
  await assert.rejects(execute("run_process", { ...args, idempotency_key: oldKey }), /original Chat process/);
  const linkHandle = `process_${"f".repeat(64)}`;
  symlinkSync(oldDir, join(evidence, "processes", linkHandle));
  await assert.rejects(execute("process_get", { handle: linkHandle }));
  assert.deepEqual(JSON.parse(readFileSync(join(oldDir, "record.json"), "utf8")), oldRecord);
  const output = JSON.parse((await execute("process_output", { handle, stream: "stdout", start: 0, length: 100 })).content);
  assert.match(output.text, /tree-started-0/);
  assert.equal(JSON.parse((await execute("run_process", args)).content).handle, handle);
  await assert.rejects(execute("process_get", { handle }, { ...scope, ...another }), /authority/);
  await assert.rejects(execute("run_process", { ...args, arguments: ["unapproved"] }), /allowlist/);
  modelArgs = { program: process.execPath, arguments: [foregroundScript], cwd: directory };
  const foregroundTurn = { ...identity, operationId: randomUUID(), expectedRevision: history.revision,
    text: "Run the admitted foreground fixture." };
  await ok({ method: "continue", ...foregroundTurn });
  const foregroundHistory = await ui.managed.settled(identity, foregroundTurn.operationId);
  assert.equal(foregroundHistory.nativeTurns.at(-1).status, "completed");
  assert(approvalPrompts.some(prompt => !prompt.once && /foreground\.mjs/.test(prompt.detail)));
  assert.equal(modelSawForeground, true);
  const foregroundRow = database.prepare("SELECT handle FROM legacy_chat_process_bindings WHERE scope=? AND substr(handle,1,11)='foreground_'").get(
    database.prepare("SELECT scope FROM legacy_chat_process_bindings WHERE handle=?").get(handle).scope);
  assert(foregroundRow);
  const nativeForeground = JSON.parse((await execute("process_output", { handle: foregroundRow.handle,
    stream: "stdout", start: 0, length: 100 })).content);
  assert.equal(nativeForeground.text, "foreground-result");
  await assert.rejects(execute("run_process", { ...modelArgs, timeoutSeconds: 121 }), /1-120/);
  await assert.rejects(execute("run_process", { ...modelArgs, background: true, timeoutSeconds: 60 }), /idempotency key/);
  await assert.rejects(execute("process_cancel", { handle: foregroundRow.handle }), /background process handle/);
  const abort = new AbortController();
  const cancelledForeground = processes.execute(scope, { call: { name: "run_process", arguments: {
    program: process.execPath, arguments: [slowScript], cwd: directory } },
    operationId: randomUUID(), signal: abort.signal });
  await until(() => Number(database.prepare("SELECT count(*) n FROM legacy_chat_process_bindings WHERE substr(handle,1,11)='foreground_'").get().n) === 2);
  abort.abort();
  await assert.rejects(cancelledForeground, /foreground process/i);
  const bulk = JSON.parse((await execute("run_process", { program: process.execPath, arguments: [bulkScript],
    cwd: directory, timeoutSeconds: 60, background: true, idempotency_key: randomUUID() })).content);
  let bulkState;
  const bulkDeadline = Date.now() + 30000;
  do {
    bulkState = JSON.parse((await execute("process_get", { handle: bulk.handle })).content);
    if (!["launching", "running", "paused"].includes(bulkState.state)) break;
    await delay(50);
  } while (Date.now() < bulkDeadline);
  assert.equal(bulkState.state, "output-limit");
  assert.equal(bulkState.stdoutBytes + bulkState.stderrBytes, 64 * 1024 * 1024);
  const last = JSON.parse((await execute("process_output", { handle: bulk.handle, stream: "stdout",
    start: bulkState.stdoutBytes - 5, length: 5 })).content);
  assert.equal(last.text, "aaaaa");
  const slow = JSON.parse((await execute("run_process", { program: process.execPath, arguments: [slowScript],
    cwd: directory, timeoutSeconds: 60, background: true, idempotency_key: randomUUID() })).content);
  const cancelResult = JSON.parse((await execute("process_cancel", { handle: slow.handle })).content);
  assert(["launching", "running", "cancelled", "unknown"].includes(cancelResult.state));
  assert.match(cancelResult.detail, /managed process group only; descendants that leave it may continue/);
  if (["launching", "running"].includes(cancelResult.state)) assert.match(cancelResult.detail, /not yet confirmed/);
  assert(approvalPrompts.some(prompt => /Cancel this durable/.test(prompt.title) && prompt.detail.includes(slow.handle)));
  const control = (operation, chat = identity) => ({ method: "process-control", ...chat, handle, operation });
  assert.equal((await rpc(control("pause", another))).status, 409);
  allowed = false; assert.equal((await rpc(control("pause"))).status, 409); allowed = true;
  assert.equal((await ok(control("pause"))).state, "paused");
  await delay(80);
  const sizes = () => [0, 1, 2].map(n => readFileSync(join(directory, `ticks-${n}`)).length);
  const paused = sizes(); await delay(180); assert.deepEqual(sizes(), paused);
  assert.equal((await ok(control("resume"))).state, "running");
  await until(() => sizes().every((size, index) => size > paused[index]), 2000);
  const crashArgs = { program: process.execPath, arguments: [script, crashDirectory], cwd: directory,
    timeoutSeconds: 60, background: true, idempotency_key: randomUUID() };
  const crash = JSON.parse((await execute("run_process", crashArgs)).content);
  await until(() => [0, 1, 2].every(n => existsSync(join(crashDirectory, `ticks-${n}`))), 5000);
  const crashPids = [0, 1, 2].map(n => Number(readFileSync(join(crashDirectory, `pid-${n}`))));
  const crashRow = database.prepare("SELECT scope,job_id FROM legacy_chat_process_bindings WHERE handle=?").get(crash.handle);
  const guardian = processes.runtime.tasks.get(crashRow.job_id).group.child;
  const logBefore = JSON.parse((await execute("process_output", { handle: crash.handle, stream: "stdout", start: 0, length: 100 })).content);
  assert.match(logBefore.text, /tree-started-0/);
  let killedDuringPause = false;
  guardian.prependListener("message", value => {
    if (value?.type === "ack" && !killedDuringPause) {
      killedDuringPause = guardian.kill("SIGKILL");
    }
  });
  const pauseResponse = await rpc({ ...control("pause"), handle: crash.handle });
  assert([200, 409].includes(pauseResponse.status));
  assert.equal(killedDuringPause, true);
  const crashed = await processes.runtime.wait(crashRow.scope, crashRow.job_id);
  assert.equal(crashed.state, "INTERRUPTED"); assert.equal(crashed.effect, "unknown");
  await until(() => crashPids.every(pid => {
    try { return readFileSync(`/proc/${pid}/stat`, "utf8").replace(/^.*\) /, "")[0] === "Z"; }
    catch (error) { if (error.code === "ENOENT" || error.code === "ESRCH") return true; throw error; }
  }), 3000);
  const crashRecord = JSON.parse((await execute("process_get", { handle: crash.handle })).content);
  assert.equal(crashRecord.state, "unknown");
  assert.match(crashRecord.detail, /processes may still run/);
  await assert.rejects(execute("process_cancel", { handle: crash.handle }), /Unknown process outcome/);
  const logAfter = JSON.parse((await execute("process_output", { handle: crash.handle, stream: "stdout", start: 0, length: 100 })).content);
  assert.equal(logAfter.text, logBefore.text);
  await assert.rejects(execute("process_output", { handle: crash.handle, stream: "stdout", start: 0, length: 100 },
    { ...scope, ...another }), /authority/);
  const owned = [0, 1, 2].map(n => Number(readFileSync(join(directory, `pid-${n}`))));
  const ownedRow = database.prepare("SELECT scope,job_id FROM legacy_chat_process_bindings WHERE handle=?").get(handle);
  const owner = ownedRow.scope, ownedTask = processes.runtime.tasks.get(ownedRow.job_id);
  const ownedGroup = ownedTask.group, groupDone = ownedGroup.done;
  let releaseTerminal;
  const terminalGate = new Promise(resolve => { releaseTerminal = resolve; });
  // Payload exit can precede the guardian-close callback that persists the terminal receipt.
  ownedGroup.done = groupDone.then(async result => { await terminalGate; return result; });
  const unknown = `process_${"e".repeat(64)}`;
  database.prepare("INSERT INTO legacy_chat_process_bindings VALUES(?,?,?,?,NULL,?)")
    .run(owner, unknown, "{}", randomUUID(), Date.now() - 1000);
  const stop = { method: "task-control", input: { ...identity, kind: "cancel",
    operationId: randomUUID(), expectedRevision: state.revision } };
  try {
    const partial = await rpc(stop);
    assert.equal(partial.status, 409);
    assert.match(partial.error, /could not be cancelled/);
    assert.match(partial.error, new RegExp(crash.handle));
    await until(() => owned.every(pid => {
      try { return readFileSync(`/proc/${pid}/stat`, "utf8").replace(/^.*\) /, "")[0] === "Z"; }
      catch (error) { if (error.code === "ENOENT" || error.code === "ESRCH") return true; throw error; }
    }), 3000);
    const exited = await groupDone;
    assert.equal(exited.error, undefined);
    assert(ownedGroup.child.exitCode !== null || ownedGroup.child.signalCode !== null);
    const pending = processes.runtime.status(owner, ownedRow.job_id);
    assert.equal(pending.state, "RUNNING");
    assert.equal(pending.reason, "cancel");
    assert.equal(pending.finishedAt, null);
  } finally { releaseTerminal(); }
  const stopped = await processes.runtime.wait(owner, ownedRow.job_id);
  assert.equal(stopped.state, "CANCELLED");
  assert.equal(stopped.reason, "cancel");
  assert.equal(stopped.effect, "unknown");
  assert.equal(typeof stopped.finishedAt, "number");
  assert.equal(processes.runtime.tasks.has(ownedRow.job_id), false);
  const persisted = JSON.parse(database.prepare("SELECT record_json FROM runtime_process_jobs WHERE job_id=?")
    .get(ownedRow.job_id).record_json);
  assert.deepEqual(persisted, stopped);
  assert.equal((await ok(control("status"))).state, "cancelled");
  database.prepare("DELETE FROM legacy_chat_process_bindings WHERE scope=? AND handle=?").run(owner, unknown);
  const retry = await rpc(stop);
  assert.equal(retry.status, 409);
  assert.match(retry.error, new RegExp(crash.handle));
  state = (await ok({ method: "history", ...identity })).taskControl;
  assert.equal(state.stopped, true);
  await ui.close(); ui = undefined;
  assert.equal(processes.runtime.diagnostics().activeJobs, 0);
  assert.equal(processes.runtime.diagnostics().running, 0);
  assert.equal(processes.runtime.diagnostics().queued, 0);
  processes = new LegacyApiChatProcesses(processOptions);
  assert.equal(JSON.parse((await execute("process_get", { handle: crash.handle })).content).state, "unknown");
  assert.equal(JSON.parse((await execute("run_process", crashArgs)).content).state, "unknown");
  assert.equal(JSON.parse((await execute("process_output", { handle: crash.handle, stream: "stdout",
    start: 0, length: 100 })).content).text, logBefore.text);
});
