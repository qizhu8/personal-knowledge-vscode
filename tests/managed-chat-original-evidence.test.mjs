import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { createServer } from "node:http";
import { createRequire } from "node:module";
import { DatabaseSync } from "node:sqlite";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { test } from "node:test";
import { initialize } from "../dist/storage.js";
import { startStandaloneHost } from "../dist/standalone-host.js";
import { bindManagedClientHost } from "../dist/managed-client-host.js";
import { createLegacyManagedChatLocalModel } from "../dist/legacy-api-chat-managed-provider.js";
import { startManagedClientSnapshotChat } from "../dist/managed-client-snapshot-chat.js";

const require = createRequire(import.meta.url);
const originalExtension = process.env.PKM_TEST_LEGACY_CHAT_EXTENSION ?? resolve(import.meta.dirname, "../legacy");
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(read) {
  for (let n = 0; n < 300; n++) {
    const value = await read();
    if (value) return value;
    await delay(20);
  }
  throw new Error("Bounded Chat evidence condition timed out.");
}

test("selected managed Chat reads original tool logs without owning historical processes", {
  skip: process.platform !== "linux", timeout: 30000,
}, async t => {
  const dir = resolve("tests", `.original-chat-evidence-${randomUUID()}`);
  const source = join(dir, "original"), workspace = join(dir, "workspace"), capture = join(dir, "capture");
  const snapshots = join(dir, "snapshots"), config = join(dir, "host.json");
  for (const path of [source, capture, snapshots]) mkdirSync(path, { recursive: true, mode: 0o700 });
  let host, managed, child, database, server;
  t.after(async () => {
    try {
      await child?.close();
      if (managed) await managed.close(); else await host?.close();
      database?.close();
      if (server) { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
  const { ApiChatStore } = require(join(originalExtension, "dist/chat/api-chat-store.js"));
  const oldStore = new ApiChatStore(join(source, ".pkm/state"), "0123456789abcdef");
  const oldMask = process.umask(0o077);
  let chat, foreground, background, evidenceDir;
  try {
    chat = oldStore.create();
    evidenceDir = join(source, ".pkm/state/api-chat-tool-results", chat.id);
    const Module = require("node:module"), load = Module._load;
    let createBuiltinTools;
    try {
      Module._load = function (name, ...args) { return name === "vscode" ? {} : load.call(this, name, ...args); };
      ({ createBuiltinTools } = require(join(originalExtension, "dist/chat/api-chat-tools.js")));
    } finally { Module._load = load; }
    const vscode = { workspace: { isTrusted: true, workspaceFolders: [{ uri: { scheme: "file", fsPath: source } }] },
      Uri: { file: fsPath => ({ scheme: "file", fsPath }) } };
    const tools = createBuiltinTools(["run_process", "process_get"], vscode, undefined, undefined, async () => true, undefined, evidenceDir);
    const run = async (name, args) => JSON.parse(await tools.find(tool => tool.name === name).execute(args, new AbortController().signal));
    foreground = await run("run_process", { program: process.execPath, arguments: ["-e", "process.stdout.write('old foreground')"], timeoutSeconds: 5 });
    background = await run("run_process", { program: process.execPath, arguments: ["-e", "process.stdout.write('old background')"],
      timeoutSeconds: 5, background: true, idempotency_key: "old-key" });
    await until(async () => (await run("process_get", { handle: background.handle })).state === "complete");
  } finally { process.umask(oldMask); }
  const foregroundLog = join(evidenceDir, `${foreground.outputHandle.slice("foreground_".length)}.stdout.log`);
  const backgroundLog = join(evidenceDir, "processes", background.handle, "stdout.log");
  const oldForeground = readFileSync(foregroundLog), oldBackground = readFileSync(backgroundLog);
  assert.equal(oldForeground.toString(), "old foreground");
  assert.equal(oldBackground.toString(), "old background");

  await initialize(workspace);
  let modelToolOutput;
  server = createServer(async (request, response) => {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    const body = JSON.parse(Buffer.concat(chunks).toString());
    const tool = body.messages.find(message => message.role === "tool");
    if (tool) modelToolOutput = tool.content;
    const delta = tool ? { content: "done" } : { tool_calls: [{ index: 0, id: "original-log", type: "function",
      function: { name: "process_output", arguments: JSON.stringify({ handle: background.handle,
        stream: "stdout", start: 0, length: 100 }) } }] };
    response.writeHead(200, { "content-type": "text/event-stream" });
    response.end(`data: ${JSON.stringify({ choices: [{ index: 0, delta, finish_reason: null }] })}\n\n`
      + `data: ${JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: tool ? "stop" : "tool_calls" }] })}\n\ndata: [DONE]\n\n`);
  });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  const endpoint = `http://127.0.0.1:${server.address().port}/v1`;
  writeFileSync(config, JSON.stringify({ schema: "pkm.native-host-config/v1", provider: "openai-compatible", endpoint,
    secretRef: "secret:fixture/model", model: "fixture", contextWindow: 16384, maxOutputTokens: 4096,
    outputTokenParameter: "max_tokens", includeUsage: true, tools: ["knowledge.document.create"] }), { mode: 0o600 });
  host = await startStandaloneHost({ dataPath: workspace, configPath: config, policy: { authorizedConfigPath: config,
    allowedProviders: ["openai-compatible"], allowedEndpoints: [endpoint], allowedModels: ["fixture"],
    allowedTools: ["knowledge.document.create"], allowInsecureLoopback: true },
    resolveSecret: async () => "fixture", authenticateHuman: () => null });
  managed = bindManagedClientHost(host, host.workspaceId);
  let selected = true, evidenceCurrent = true, failDuringEvidence = false, evidenceChecks = 0;
  const selection = { workspaceId: host.workspaceId, actorId: "local:owner",
    assertCurrent() { if (!selected) throw new Error("selection revoked"); } };
  const connection = new AbortController();
  const foregroundArgs = ["-e", "process.stdout.write('new foreground')"];
  const backgroundArgs = ["-e", "process.stdout.write('new running');setInterval(()=>{},1000)"];
  database = new DatabaseSync(join(dir, "process.sqlite"));
  const model = createLegacyManagedChatLocalModel({ endpoint, model: "fixture", apiKey: "fixture",
    tools: async () => [{ name: "process_output", description: "Read output", parameters: { type: "object", properties: {}, additionalProperties: true } }] });
  child = await startManagedClientSnapshotChat({ managed, selection, connection: connection.signal,
    sourceRoot: source, privateParent: snapshots,
    profile: { id: "fixture", workspaceId: host.workspaceId, actorId: "local:owner", assertCurrent: selection.assertCurrent,
      policy: async binding => ({ available: binding.chatId === chat.id, trusted: true, permissionMode: "ask", localControls: true }),
      remember: async () => {} },
    commands: [{ id: "node", program: process.execPath, cwd: workspace, arguments: [foregroundArgs, backgroundArgs] }],
    owner: { database, captureDirectory: capture, originalEvidence: { root: source,
      assertCurrent() {
        selection.assertCurrent();
        if (!evidenceCurrent || (failDuringEvidence && ++evidenceChecks === 2)) throw new Error("original evidence revoked");
      } } },
    chat: { chats: [{ namespace: chat.workspaceNamespace, chatId: chat.id }],
      authorize: async binding => binding.chatId === chat.id,
      provider: async () => "unused", managed: { model, authorize: async binding => binding.chatId === chat.id,
        tools: { available: true, execute: async () => { throw new Error("Unexpected tool."); } } } },
    onCloseError(error) { throw error; } });
  const rpc = async input => {
    const response = await fetch(`${child.endpoint}/rpc`, { method: "POST",
      headers: { authorization: `Bearer ${child.bearer}`, "x-pkm-native-actor": "local:owner", "content-type": "application/json" },
      body: JSON.stringify(input) });
    return { status: response.status, ...await response.json() };
  };
  const status = await rpc({ method: "status" });
  assert.equal(status.status, 200);
  const scope = { root: child.snapshotRoot, workspaceId: host.workspaceId, actorId: "local:owner",
    sourceFingerprint: status.value.sourceFingerprint, namespace: chat.workspaceNamespace, chatId: chat.id };
  const call = (name, args, current = scope) => child.processes.execute(current, {
    call: { name, arguments: args }, operationId: randomUUID(), signal: new AbortController().signal });
  const oldOutput = async handle => JSON.parse((await call("process_output", { handle, stream: "stdout", start: 0, length: 100 })).content);
  assert.equal((await oldOutput(foreground.outputHandle)).text, "old foreground");
  assert.equal((await oldOutput(background.handle)).text, "old background");
  const historical = await rpc({ method: "process-control", namespace: scope.namespace, chatId: scope.chatId,
    operation: "status", handle: background.handle });
  assert.equal(historical.status, 200);
  assert.equal(historical.value.state, "complete");
  const identity = { namespace: scope.namespace, chatId: scope.chatId };
  const history = await rpc({ method: "history", ...identity });
  assert.equal(history.status, 200);
  const task = await rpc({ method: "task-control", input: { ...identity, kind: "create", title: "Read old output",
    operationId: randomUUID(), expectedRevision: history.value.taskControl.revision } });
  assert.equal(task.status, 200);
  const operationId = randomUUID();
  const continued = await rpc({ method: "continue", ...identity, operationId, expectedRevision: 0, text: "Read the old log." });
  assert.equal(continued.status, 200, continued.error);
  await child.managed.settled(identity, operationId);
  assert.match(String(modelToolOutput), /old background/);
  await assert.rejects(call("process_cancel", { handle: background.handle }), /outside this Chat authority/);
  await assert.rejects(call("process_output", { handle: foreground.outputHandle, stream: "stdout", start: 0, length: 100 },
    { ...scope, chatId: randomUUID() }), /unavailable|denied/);

  const approve = async pending => {
    const item = await until(async () => (await child.processApprovalUi.list(scope))[0]);
    await child.processApprovalUi.decide(scope, item.id, "approve");
    return JSON.parse((await pending).content);
  };
  await assert.rejects(approve(call("run_process", { program: process.execPath, arguments: foregroundArgs,
    cwd: workspace, timeoutSeconds: 20, background: true, idempotency_key: "old-key" })), /original Chat process already owns this handle/i);
  const freshForeground = await approve(call("run_process", { program: process.execPath, arguments: foregroundArgs, cwd: workspace }));
  assert.equal(freshForeground.stdout, "new foreground");
  const freshBackground = await approve(call("run_process", { program: process.execPath, arguments: backgroundArgs,
    cwd: workspace, timeoutSeconds: 20, background: true, idempotency_key: randomUUID() }));
  await until(async () => (await child.processes.control(scope, freshBackground.handle, "status")).state === "running");
  const cancelled = await approve(call("process_cancel", { handle: freshBackground.handle }));
  assert.ok(["cancelled", "running", "launching"].includes(cancelled.state));
  await until(async () => (await child.processes.control(scope, freshBackground.handle, "status")).state === "cancelled");
  failDuringEvidence = true; evidenceChecks = 0;
  await assert.rejects(oldOutput(background.handle), /evidence revoked/);
  failDuringEvidence = false;
  evidenceCurrent = false;
  await assert.rejects(oldOutput(background.handle), /evidence revoked/);
  assert.deepEqual(readFileSync(foregroundLog), oldForeground);
  assert.deepEqual(readFileSync(backgroundLog), oldBackground);
});
