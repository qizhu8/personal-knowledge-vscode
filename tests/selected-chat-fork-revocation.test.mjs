import assert from "node:assert/strict";
import { fork } from "node:child_process";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { createServer } from "node:http";
import { createRequire } from "node:module";
import { DatabaseSync } from "node:sqlite";
import { existsSync, lstatSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { test } from "node:test";
import { coreDatabasePath } from "../dist/workspace-storage-paths.js";

const require = createRequire(import.meta.url), ts = require("typescript");
process.umask(0o077);
const project = resolve(import.meta.dirname, "../legacy");
const dist = process.env.PKM_TEST_DIST ?? resolve("dist");
const legacy = process.env.PKM_TEST_LEGACY_CHAT_EXTENSION ?? project;
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(read, label, timeout = 15000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const value = await read();
    if (value) return value;
    await pause(25);
  }
  throw new Error(`Timed out: ${label}`);
}

class TextPart { constructor(value) { this.value = value; } }
class ToolCallPart { constructor(callId, name, input) { Object.assign(this, { callId, name, input }); } }
class ToolResultPart { constructor(callId, content) { Object.assign(this, { callId, content }); } }
class CancellationTokenSource { constructor() { this.token = {}; } cancel() {} dispose() {} }
const vscode = { CancellationTokenSource, LanguageModelTextPart: TextPart, LanguageModelToolCallPart: ToolCallPart,
  LanguageModelToolResultPart: ToolResultPart, LanguageModelChatMessage: {
    User: content => ({ role: "user", content }), Assistant: content => ({ role: "assistant", content }),
  } };
const source = readFileSync(join(project, "src/runtime/next-vscode-model-bridge.ts"), "utf8");
const js = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
const bridgeModule = { exports: {} };
new Function("require", "module", "exports", js)(name =>
  name === "vscode" ? vscode : name === "../chat/api-chat-client" ? {} : require(name), bridgeModule, bridgeModule.exports);

for (const scenario of ["approval-revoke", "casual-approval-revoke", "effect-revoke", "casual-effect-revoke", "preflight-timeout", "preflight-revoke",
  "dispatch-timeout", "dispatch-revoke", "after-commit-effect-revoke", "review-timeout", "review-revoke"]) test(`forked selected Chat ${scenario} retains steering and does not replay`, {
  timeout: 70000, skip: process.platform !== "linux",
}, async t => {
  const directory = join(project, ".migration-test-work", `selected-fork-${randomUUID()}`);
  const trial = join(directory, "trial"), root = join(directory, "legacy"), effect = join(directory, "effect.txt");
  const program = join(directory, "effect.cjs");
  for (const dir of [trial, root]) mkdirSync(dir, { recursive: true, mode: 0o700 });
  writeFileSync(program, `const fs=require("node:fs"), file=${JSON.stringify(effect)}; fs.appendFileSync(file, "effect\\n");
setTimeout(()=>{}, ${scenario === "effect-revoke" || scenario === "casual-effect-revoke" || scenario.startsWith("review") ? "30000"
    : scenario === "after-commit-effect-revoke" ? 'fs.readFileSync(file,"utf8").split("\\n").length > 2 ? 30000 : 400' : "400"});`, { mode: 0o600 });
  const { ApiChatStore } = require(join(legacy, "dist/chat/api-chat-store.js"));
  const archive = new ApiChatStore(join(root, ".pkm/state"), "0123456789abcdef");
  const chat = archive.create();
  archive.startTask(chat, "Isolated task");
  const identity = { namespace: chat.workspaceNamespace, chatId: chat.id };
  const original = readFileSync(join(root, ".pkm/state/api-chats", identity.namespace, `${identity.chatId}.json`));
  const server = createServer((request, response) => {
    request.resume();
    requests++;
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({ kind: requests === 1 || scenario === "after-commit-effect-revoke" && requests === 2 ? "tool" : "text",
      callId: `fixture-call-${requests}` }));
  });
  let requests = 0, child, bridge;
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(async () => {
    bridge?.dispose();
    if (child && child.exitCode === null && child.signalCode === null) {
      child.kill("SIGTERM");
      await Promise.race([once(child, "exit"), pause(5000)]);
      if (child.exitCode === null && child.signalCode === null) { child.kill("SIGKILL"); await once(child, "exit"); }
    }
    server.closeAllConnections(); await new Promise(resolve => server.close(resolve));
    rmSync(directory, { recursive: true, force: true });
  });
  child = fork(join(dist, "managed-client-child.js"), [], { stdio: ["ignore", "ignore", "inherit", "ipc"] });
  const received = [], pending = new Map(), withheld = new Set(), connection = new AbortController();
  let selected = true, held = false;
  let session = randomUUID();
  bridge = bridgeModule.exports.createNextVscodeModelBridge({ session, signal: connection.signal,
    assertCurrent() { if (!selected) throw new Error("Selection revoked"); },
    model: { maxInputTokens: 131072, capabilities: { toolCalling: true },
      async sendRequest() {
        const reply = await fetch(`http://127.0.0.1:${server.address().port}/model`, { method: "POST" }).then(r => r.json());
        return { stream: (async function* () {
          if (reply.kind === "tool") yield new ToolCallPart(reply.callId, "run_process", {
            program: process.execPath, arguments: [program], cwd: join(trial, "workspace"),
            timeoutSeconds: 30, background: false,
          });
          else yield new TextPart("local fixture response");
        })() };
      } },
    send(message) {
      if (withheld.has(message.id)) { held = true; return; }
      if (child.connected) child.send(message);
    } });
  const onMessage = message => {
    received.push(message);
    if (message.type === "selected-lm-open" && message.prepareOnly && scenario.startsWith("preflight"))
      withheld.add(message.id);
    if (message.type === "selected-lm-dispatch" && scenario.startsWith("dispatch"))
      withheld.add(message.id);
    if (bridge.handle(message)) return;
    if (message.type === "result" && pending.has(message.id)) {
      pending.get(message.id)(message); pending.delete(message.id);
    }
  };
  child.on("message", onMessage);
  const send = async message => {
    const id = randomUUID();
    const answer = new Promise(resolve => pending.set(id, resolve));
    child.send({ ...message, id });
    let timer;
    try {
      return await Promise.race([answer, new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(`IPC timeout: ${message.type}`)), 20000);
      })]);
    } finally { clearTimeout(timer); pending.delete(id); }
  };
  child.send({ type: "start", directory: trial, legacyRoot: root });
  const ready = await until(() => received.find(value => value.type === "ready" || value.type === "startup-error"), "child ready");
  assert.equal(ready.type, "ready", JSON.stringify(ready));
  assert((await send({ type: "selected-owner-open", session, workspaceId: ready.workspaceId, actorId: "local:owner" })).result);
  const startRequest = { type: "selected-chat-start", session, chats: [identity],
    commands: [{ id: "fixture", program: process.execPath, cwd: join(trial, "workspace"), arguments: [[program]] }],
    model: { provider: "vscode", endpoint: "", model: "fixture", apiKey: "", vscodeModelId: "fixture",
      vscodeTools: true, vscodeImageInput: false, timeoutMs: 1200, contextWindow: 65536, maxOutputTokens: 1024,
      outputTokenParameter: "max_tokens", includeUsage: true, status: "active" } };
  const started = await send(startRequest);
  assert(started.result, JSON.stringify(started));
  const rpc = async input => {
    const response = await fetch(`${started.result.endpoint}/rpc`, { method: "POST",
      headers: { authorization: `Bearer ${started.result.bearer}`, "x-pkm-native-actor": "local:owner",
        "content-type": "application/json" }, body: JSON.stringify(input) });
    return { status: response.status, ...await response.json() };
  };
  const ok = async input => { const result = await rpc(input); assert.equal(result.status, 200, JSON.stringify(result)); return result.value; };
  const history = () => ok({ method: "history", ...identity });
  if (scenario.startsWith("casual-")) {
    const active = await history();
    await ok({ method: "task-control", input: { ...identity, kind: "complete", operationId: randomUUID(),
      expectedRevision: active.taskControl.revision } });
    assert.equal((await history()).taskControl.activeSessionId, null);
  }
  const attempt = randomUUID();
  await ok({ method: "continue", ...identity, operationId: attempt, expectedRevision: (await history()).revision, text: "Run fixture." });
  const approval = await until(async () => {
    const prompts = await ok({ method: "process-approvals", ...identity });
    if (prompts[0]) return prompts[0];
    const current = await history();
    const turn = current.nativeTurns.find(turn => turn.id === attempt);
    if (turn && ["failed", "unknown", "cancelled"].includes(turn.status)) {
      const db = new DatabaseSync(coreDatabasePath(join(trial, "workspace")), { readOnly: true });
      const record = JSON.parse(db.prepare("SELECT record FROM chat_turn_records WHERE id=?").get(attempt).record);
      db.close();
      throw new Error(`Turn ended before approval: ${JSON.stringify({ turn, failure: record.failure })}`);
    }
  }, "process approval");
  const queuedId = randomUUID(), text = `RETAINED_${scenario}`;
  const current = await history();
  await ok({ method: "queue", input: { ...identity, kind: "enqueue", operationId: queuedId, submissionId: queuedId,
    expectedRevision: current.queueControl.revision, taskSessionId: current.taskControl.activeSessionId,
    mode: "steer", attemptId: attempt, text } });
  if (!scenario.endsWith("approval-revoke")) {
    await ok({ method: "process-approval-decide", ...identity, id: approval.id, choice: "approve-once" });
    await until(() => existsSync(effect), "real process effect");
  }
  if (scenario.startsWith("preflight") || scenario.startsWith("dispatch"))
    await until(() => held, "held model IPC response");
  if (scenario === "after-commit-effect-revoke") {
    const second = await until(async () => {
      const prompts = await ok({ method: "process-approvals", ...identity });
      const secondPrompt = prompts.find(prompt => prompt.id !== approval.id);
      if (secondPrompt) return secondPrompt;
      const state = await history();
      const turn = state.nativeTurns.find(turn => turn.id === attempt);
      if (["failed", "unknown", "cancelled", "completed"].includes(turn?.status))
        throw new Error(`Turn ended before second approval: ${JSON.stringify({ turn, requests, messages: state.messages })}`);
    }, "post-commit process approval");
    await ok({ method: "process-approval-decide", ...identity, id: second.id, choice: "approve-once" });
    await until(() => readFileSync(effect, "utf8") === "effect\neffect\n", "post-commit real process effect");
  }
  if (scenario.startsWith("review")) {
    const state = await history();
    await ok({ method: "task-control", input: { ...identity, kind: "cancel",
      operationId: randomUUID(), expectedRevision: state.taskControl.revision } });
    await until(async () => (await history()).nativeTurns.find(turn => turn.id === attempt && turn.uncertain), "unknown cancelled process");
    const snapshot = await ok({ method: "outcome-review", ...identity });
    const decision = rpc({ method: "outcome-decide", input: { ...identity, operationId: randomUUID(),
      expectedDigest: snapshot.digest, decision: "abandon-without-replay", reason: "Preserve the unacknowledged effect." } })
      .catch(error => ({ disconnected: String(error) }));
    const challenge = await until(() => received.find(value => value.type === "selected-chat-review-request"), "review IPC challenge");
    child.send({ type: "selected-chat-review-response", id: challenge.id, session: randomUUID(), approved: true });
    await pause(150);
    const before = new DatabaseSync(coreDatabasePath(join(trial, "workspace")), { readOnly: true });
    assert.equal(before.prepare("SELECT count(*) AS n FROM legacy_managed_chat_reviews").get().n, 0);
    before.close();
    if (scenario === "review-timeout") {
      const result = await decision;
      assert.equal(result.status, 409, JSON.stringify(result));
    } else {
      selected = false; connection.abort();
      assert.deepEqual((await send({ type: "selected-owner-revoke", session })).result, { revoked: true });
      await decision;
    }
    child.send({ type: "selected-chat-review-response", id: challenge.id, session, approved: true });
    await pause(150);
  } else if (scenario.endsWith("timeout")) {
    await until(async () => (await history()).nativeTurns.find(turn => turn.id === attempt && ["failed", "unknown", "cancelled"].includes(turn.status)), "timed out turn");
  } else {
    selected = false; connection.abort();
    const revoked = await send({ type: "selected-owner-revoke", session });
    assert.deepEqual(revoked.result, { revoked: true }, JSON.stringify(revoked));
  }
  const db = new DatabaseSync(coreDatabasePath(join(trial, "workspace")), { readOnly: true });
  const queue = JSON.parse(db.prepare("SELECT state_json FROM legacy_managed_chat_queue WHERE chat_id=?").get(identity.chatId).state_json);
  const turn = JSON.parse(db.prepare("SELECT record FROM chat_turn_records WHERE id=?").get(attempt).record);
  db.close();
  const item = queue.items.find(item => item.id === queuedId);
  assert(item, JSON.stringify(queue));
  assert.equal(item.text, text);
  const committed = scenario.startsWith("dispatch") || scenario === "after-commit-effect-revoke";
  assert.equal(item.status, committed ? "applied" : "queued");
  if (scenario === "preflight-timeout" || scenario === "dispatch-timeout")
    assert.equal(turn.failure, "MODEL_TIMEOUT", JSON.stringify(turn));
  if (scenario.endsWith("approval-revoke")) assert.equal(existsSync(effect), false);
  else assert.equal(readFileSync(effect, "utf8"), scenario === "after-commit-effect-revoke" ? "effect\neffect\n" : "effect\n");
  if (scenario.endsWith("effect-revoke") || scenario.startsWith("review"))
    assert.equal(turn.uncertain, true, JSON.stringify(turn));
  if (scenario.startsWith("review")) {
    const reviewDb = new DatabaseSync(coreDatabasePath(join(trial, "workspace")), { readOnly: true });
    assert.equal(reviewDb.prepare("SELECT count(*) AS n FROM legacy_managed_chat_reviews").get().n, 0);
    reviewDb.close();
  }
  assert.equal(requests, committed ? 2 : 1);
  await pause(150);
  assert.equal(requests, committed ? 2 : 1, "No automatic provider replay");
  assert.deepEqual(readFileSync(join(root, ".pkm/state/api-chats", identity.namespace, `${identity.chatId}.json`)), original);
  if (scenario.endsWith("timeout")) {
    selected = false; connection.abort();
    assert.deepEqual((await send({ type: "selected-owner-revoke", session })).result, { revoked: true });
  }
  const closed = once(child, "exit");
  child.send({ type: "close" });
  assert.deepEqual(await closed, [0, null]);
  const id = file => { const stat = lstatSync(file, { bigint: true }); return `${stat.dev}:${stat.ino}`; };
  const workspace = join(trial, "workspace"), snapshotRoot = started.result.root;
  const pin = { schema: "pkm.next-selected-chat-recovery/v1", parent: trial, parentIdentity: id(trial),
    workspaceIdentity: id(workspace), databaseIdentity: id(coreDatabasePath(workspace)),
    markerIdentity: id(join(workspace, ".pkm-next-workspace")), legacyRoot: root, legacyIdentity: id(root),
    workspaceId: ready.workspaceId, ...identity, snapshotRoot, snapshotParentIdentity: id(dirname(snapshotRoot)),
    snapshotIdentity: id(snapshotRoot), sourceFingerprint: started.result.sourceFingerprint };
  const beforeRestart = received.length;
  session = randomUUID();
  child = fork(join(dist, "managed-client-child.js"), [], { stdio: ["ignore", "ignore", "inherit", "ipc"] });
  child.on("message", onMessage);
  child.send({ type: "start-selected-chat-recovery", pin, legacyRoot: root });
  const reopened = await until(() => received.slice(beforeRestart).find(value => value.type === "ready" || value.type === "startup-error"), "recovery ready");
  assert.equal(reopened.type, "ready", JSON.stringify(reopened));
  assert((await send({ type: "selected-owner-open", session, workspaceId: ready.workspaceId, actorId: "local:owner" })).result);
  const restartedChat = await send({ ...startRequest, session });
  assert(restartedChat.result, JSON.stringify(restartedChat));
  const response = await fetch(`${restartedChat.result.endpoint}/rpc`, { method: "POST",
    headers: { authorization: `Bearer ${restartedChat.result.bearer}`, "x-pkm-native-actor": "local:owner",
      "content-type": "application/json" }, body: JSON.stringify({ method: "history", ...identity }) });
  const reopenedHistory = await response.json();
  assert.equal(response.status, 200, JSON.stringify(reopenedHistory));
  const restored = reopenedHistory.value.queueControl.items.find(value => value.id === queuedId);
  assert.equal(restored?.text, text);
  assert.equal(restored?.status, item.status);
  if (scenario.startsWith("casual-")) {
    assert.equal(reopenedHistory.value.taskControl.activeSessionId, null);
    assert.equal(reopenedHistory.value.messages.find(message => message.id === attempt).taskId, undefined);
  }
  if (item.status === "queued") assert.equal(reopenedHistory.value.queueControl.needsReview, true);
  if (scenario.endsWith("effect-revoke") || scenario.startsWith("review"))
    assert.equal(reopenedHistory.value.nativeTurns.find(value => value.id === attempt)?.uncertain, true);
  await pause(500);
  assert.equal(received.slice(beforeRestart).some(value => value.type === "selected-lm-open"), false);
  assert.equal(requests, committed ? 2 : 1, "Recovery must not replay");
  if (!scenario.endsWith("approval-revoke"))
    assert.equal(readFileSync(effect, "utf8"), scenario === "after-commit-effect-revoke" ? "effect\neffect\n" : "effect\n");
  const reopenedClosed = once(child, "exit");
  child.send({ type: "close" });
  assert.deepEqual(await reopenedClosed, [0, null]);
});
