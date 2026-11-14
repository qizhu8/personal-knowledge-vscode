import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { createServer } from "node:http";
import { createRequire } from "node:module";
import { DatabaseSync } from "node:sqlite";
import { existsSync, mkdirSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { test } from "node:test";
import { initialize, Storage } from "../dist/storage.js";
import { createLegacyManagedChatLocalModel } from "../dist/legacy-api-chat-managed-provider.js";
import { startOwnedLegacyChatProcessUiHost } from "../dist/legacy-api-chat-process-owned-host.js";

const require = createRequire(import.meta.url);
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(check) {
  const end = Date.now() + 10000;
  for (;;) {
    const result = await check();
    if (result) return result;
    if (Date.now() > end) throw new Error("Owned Chat fixture timed out.");
    await delay(20);
  }
}

test("owned fresh Next workspace routes model process tools through live user decisions and Chat RPC", {
  timeout: process.env.PKM_OWNED_PROCESS_UI === "1" ? 180000 : 30000, skip: process.platform !== "linux",
}, async t => {
  const directory = resolve("tests", `.owned-chat-process-${randomUUID()}`);
  const root = join(directory, "workspace"), source = join(directory, "source");
  const capture = join(directory, "capture"), script = join(directory, "program.mjs");
  let storage, database, host, provider;
  t.after(async () => {
    try {
      await host?.close(); await storage?.close(); database?.close();
      if (provider) { provider.closeAllConnections(); await new Promise(resolve => provider.close(resolve)); }
    } finally { rmSync(directory, { recursive: true, force: true }); }
  });
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  mkdirSync(capture, { mode: 0o700 });
  mkdirSync(source, { mode: 0o700 });
  await initialize(root);
  const { ApiChatStore } = require("../legacy/dist/chat/api-chat-store.js");
  const archive = new ApiChatStore(join(source, ".pkm/state"), "0123456789abcdef");
  const mask = process.umask(0o077);
  let chat, other;
  try { chat = archive.create(); other = archive.create(); }
  finally { process.umask(mask); }
  const identity = { namespace: chat.workspaceNamespace, chatId: chat.id };
  const otherIdentity = { namespace: other.workspaceNamespace, chatId: other.id };
  const originalHandle = `process_${"e".repeat(64)}`;
  const originalEvidence = join(source, ".pkm/state/api-chat-tool-results", chat.id, "processes", originalHandle);
  mkdirSync(originalEvidence, { recursive: true, mode: 0o700 });
  writeFileSync(join(originalEvidence, "stdout.log"), "private-original");
  writeFileSync(script, `import {appendFileSync,writeFileSync} from "node:fs";
writeFileSync(${JSON.stringify(join(directory, "started"))}, "yes");
process.stdout.write("owned-log");
setInterval(() => appendFileSync(${JSON.stringify(join(directory, "ticks"))}, "x"), 20);`);
  storage = await Storage.open(root);
  database = new DatabaseSync(join(directory, "process.sqlite"));
  const actorId = randomUUID(), key = randomUUID(), crashKey = randomUUID();
  const handle = `process_${createHash("sha256").update(key).digest("hex")}`;
  const crashHandle = `process_${createHash("sha256").update(crashKey).digest("hex")}`;
  let live = true, holdAdmission;
  const sourceIdentity = statSync(source, { bigint: true });
  const chatSource = { root: source, assertCurrent: () => {
    const current = statSync(source, { bigint: true });
    if (!live || realpathSync(source) !== source || current.dev !== sourceIdentity.dev || current.ino !== sourceIdentity.ino)
      throw new Error("source lost");
  } };
  const policy = { available: true, trusted: true, permissionMode: "ask", localControls: true };
  const owner = {
    storage, actorId, database, captureDirectory: capture, chatSource,
    assertCurrent: () => { if (!live) throw new Error("owner lost"); },
    policy: async binding => ({ ...policy, available: policy.available && binding.chatId === identity.chatId }),
    remember: async () => { throw new Error("This test only approves one-shot requests."); },
    commands: [{ id: "fixture", program: process.execPath, cwd: root,
      arguments: args => JSON.stringify(args) === JSON.stringify([script]) }],
  };
  provider = createServer(async (request, response) => {
    const chunks = []; for await (const chunk of request) chunks.push(chunk);
    const body = JSON.parse(Buffer.concat(chunks).toString());
    const userIndex = body.messages.findLastIndex(message => message.role === "user");
    const text = String(body.messages[userIndex]?.content);
    const current = text.includes("Read output") ? "process_output" : "run_process";
    const finished = body.messages.slice(userIndex + 1).some(message => message.role === "tool");
    const args = current === "run_process"
      ? { program: process.execPath, arguments: [script], cwd: root, timeoutSeconds: 60, background: true,
        idempotency_key: text.includes("Start crash program") ? crashKey : key }
      : { handle, stream: "stdout", start: 0, length: 100 };
    const delta = finished ? { content: "done" } : { tool_calls: [{ index: 0, id: "process-call",
      type: "function", function: { name: current, arguments: JSON.stringify(args) } }] };
    response.writeHead(200, { "content-type": "text/event-stream" });
    response.end(`data: ${JSON.stringify({ choices: [{ index: 0, delta, finish_reason: null }] })}\n\n`
      + `data: ${JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: finished ? "stop" : "tool_calls" }] })}\n\ndata: [DONE]\n\n`);
  });
  await new Promise(resolve => provider.listen(0, "127.0.0.1", resolve));
  const model = createLegacyManagedChatLocalModel({ endpoint: `http://127.0.0.1:${provider.address().port}/v1`,
    model: "fixture", apiKey: "fixture", tools: async () => ["run_process", "process_output"].map(name => ({
      name, description: name, parameters: { type: "object", properties: {}, additionalProperties: true },
    })) });
  const chatOptions = { chats: [identity, otherIdentity],
    authorize: async () => true, provider: async () => "unused",
    managed: { model, authorize: async () => { if (holdAdmission) await holdAdmission(); return true; },
      tools: { available: true, execute: async () => { throw new Error("Wrong tool port."); } } } };
  host = await startOwnedLegacyChatProcessUiHost({ owner, chat: chatOptions });
  const rpc = async input => {
    const response = await fetch(`${host.endpoint}/rpc`, { method: "POST",
      headers: { authorization: `Bearer ${host.bearer}`, "x-pkm-native-actor": actorId, "content-type": "application/json" },
      body: JSON.stringify(input) });
    return { status: response.status, ...await response.json() };
  };
  const ok = async input => { const result = await rpc(input); assert.equal(result.status, 200, result.error); return result.value; };
  const list = () => ok({ method: "process-approvals", ...identity });
  const task = await ok({ method: "history", ...identity });
  await ok({ method: "task-control", input: { ...identity, kind: "create", title: "Test",
    operationId: randomUUID(), expectedRevision: task.taskControl.revision } });
  if (process.env.PKM_OWNED_PROCESS_UI === "1") {
    const status = await ok({ method: "status" });
    try {
      await require("../legacy/tests/next-trial-electron/owned-process-ui.cjs").run({
        project: resolve(".."), fixture: directory, source, workspace: root, host, actorId,
        sourceFingerprint: status.sourceFingerprint, workspaceId: status.workspaceId, ...identity,
      });
    } catch (error) {
      console.error("PRIVATE_UI_PENDING", JSON.stringify(await list()));
      console.error("PRIVATE_UI_PROCESS_STATE", JSON.stringify(await rpc({ method: "process-control", ...identity, handle, operation: "status" })));
      throw error;
    }
    assert.equal((await ok({ method: "process-control", ...identity, handle, operation: "status" })).state, "cancelled");
    const row = database.prepare("SELECT scope,job_id FROM legacy_chat_process_bindings WHERE handle=?").get(crashHandle);
    assert.ok(row);
    const running = await until(async () => {
      const current = await ok({ method: "process-control", ...identity, handle: crashHandle, operation: "status" });
      return current.state === "running" && current.stdoutBytes > 0 ? current : false;
    });
    assert.equal(running.state, "running");
    const guardian = host.processes.runtime.tasks.get(row.job_id).group.child;
    assert.equal(guardian.kill("SIGKILL"), true);
    const interrupted = await host.processes.runtime.wait(row.scope, row.job_id);
    assert.equal(interrupted.state, "INTERRUPTED");
    assert.equal(interrupted.effect, "unknown");
    await host.close();
    host = await startOwnedLegacyChatProcessUiHost({ owner, chat: chatOptions });
    const restarted = await ok({ method: "process-control", ...identity, handle: crashHandle, operation: "status" });
    assert.equal(restarted.state, "unknown");
    assert.match(restarted.detail, /No historical PID is signalled/);
    const receipt = await host.processes.execute({ root: source, workspaceId: status.workspaceId, actorId,
      sourceFingerprint: status.sourceFingerprint, ...identity }, {
      call: { name: "process_output", arguments: { handle: crashHandle, stream: "stdout", start: 0, length: 100 } },
      operationId: randomUUID(), signal: new AbortController().signal,
    });
    assert.match(JSON.parse(receipt.content).text, /owned-log/);
    console.log("PASS guardian SIGKILL, host restart preserves UNKNOWN and captured log");
    return;
  }
  const operationId = randomUUID();
  await ok({ method: "continue", ...identity, operationId, expectedRevision: 0, text: "Start the program." });
  const prompt = await until(async () => (await list())[0]);
  assert.equal(prompt.once, true);
  assert.equal(existsSync(join(directory, "started")), false);
  assert.equal((await rpc({ method: "process-approvals", ...otherIdentity })).status, 409);
  assert.equal((await rpc({ method: "process-approval-decide", ...otherIdentity, id: prompt.id, choice: "approve" })).status, 409);
  assert.equal((await rpc({ method: "process-approval-decide", ...identity, id: prompt.id, choice: "allow-all" })).status, 409);
  assert.equal((await rpc({ method: "process-control", ...identity, handle: originalHandle, operation: "status" })).status, 409);
  await assert.rejects(host.processes.execute({ root: source, workspaceId: await storage.workspaceId(), actorId,
    sourceFingerprint: (await ok({ method: "status" })).sourceFingerprint, ...identity }, {
    call: { name: "process_output", arguments: { handle: originalHandle, stream: "stdout", start: 0, length: 10 } },
    operationId: randomUUID(), signal: new AbortController().signal,
  }), /Original process evidence is not admitted/);
  await ok({ method: "process-approval-decide", ...identity, id: prompt.id, choice: "approve" });
  await host.managed.settled(identity, operationId);
  await until(() => existsSync(join(directory, "ticks")));
  const control = operation => ({ method: "process-control", ...identity, handle, operation });
  assert.equal((await ok(control("pause"))).state, "paused");
  await delay(80);
  const stoppedTicks = readFileSync(join(directory, "ticks")).length;
  await delay(100); assert.equal(readFileSync(join(directory, "ticks")).length, stoppedTicks);
  assert.equal((await ok(control("resume"))).state, "running");
  await until(() => readFileSync(join(directory, "ticks")).length > stoppedTicks);
  const nextId = randomUUID(), history = await ok({ method: "history", ...identity });
  await ok({ method: "continue", ...identity, operationId: nextId, expectedRevision: history.revision, text: "Read output." });
  const outputHistory = await host.managed.settled(identity, nextId);
  assert.match(JSON.stringify(outputHistory.messages), /owned-log/);
  const disconnect = new AbortController();
  const abandoned = fetch(`${host.endpoint}/rpc`, { method: "POST",
    headers: { authorization: `Bearer ${host.bearer}`, "x-pkm-native-actor": actorId, "content-type": "application/json" },
    body: JSON.stringify(control("stop")), signal: disconnect.signal });
  const abandonedResult = assert.rejects(abandoned, /abort/i);
  const abandonedPrompt = await until(async () => (await list()).find(item => item.kind === "stop"));
  disconnect.abort();
  await abandonedResult;
  await until(async () => !(await list()).some(item => item.id === abandonedPrompt.id));
  assert.equal((await rpc({ method: "process-approval-decide", ...identity, id: abandonedPrompt.id, choice: "approve" })).status, 409);
  assert.equal((await ok(control("status"))).state, "running");
  const stopping = ok(control("stop"));
  const stopPrompt = await until(async () => (await list()).find(item => item.kind === "stop"));
  assert.match(stopPrompt.detail, /detached descendants may continue/i);
  await ok({ method: "process-approval-decide", ...identity, id: stopPrompt.id, choice: "approve" });
  const requested = await stopping;
  assert(["running", "cancelled"].includes(requested.state));
  await until(async () => (await ok(control("status"))).state === "cancelled");
  let entered, release;
  const admissionStarted = new Promise(resolve => { entered = resolve; });
  holdAdmission = () => { entered(); return new Promise(resolve => { release = resolve; }); };
  const staleAdmission = rpc({ method: "history", ...identity });
  await admissionStarted;
  live = false;
  release();
  assert.equal((await staleAdmission).status, 409);
  holdAdmission = undefined;
  assert.equal((await rpc(control("status"))).status, 409);
  live = true;
});
