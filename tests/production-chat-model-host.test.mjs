import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { createServer } from "node:http";
import { createRequire } from "node:module";
import { DatabaseSync } from "node:sqlite";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { test } from "node:test";
import { initialize } from "../dist/storage.js";
import { startStandaloneHost } from "../dist/standalone-host.js";
import { bindManagedClientHost } from "../dist/managed-client-host.js";
import { startManagedClientSnapshotChat } from "../dist/managed-client-snapshot-chat.js";
import { createProductionChatModel } from "../dist/production-chat-model.js";

const require = createRequire(import.meta.url);
const originalExtension = process.env.PKM_TEST_LEGACY_CHAT_EXTENSION ?? resolve("..");

test("selected managed Chat uses its HTTP model and reports provider failure without fallback", { timeout: 30000 }, async t => {
  const dir = resolve("tests", `.production-model-host-${randomUUID()}`);
  const source = join(dir, "source"), workspace = join(dir, "workspace"), capture = join(dir, "capture");
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
  const mask = process.umask(0o077);
  let chat;
  try { chat = new ApiChatStore(join(source, ".pkm/state"), "0123456789abcdef").create(); }
  finally { process.umask(mask); }
  await initialize(workspace);
  let calls = 0, reject = false, observed;
  server = createServer(async (req, res) => {
    calls++;
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    observed = { url: req.url, authorization: req.headers.authorization, body: JSON.parse(Buffer.concat(chunks).toString()) };
    if (reject) { res.writeHead(401); res.end("fixture-key provider-detail-must-not-leak"); return; }
    res.writeHead(200, { "content-type": "text/event-stream" });
    res.end(`data: ${JSON.stringify({ choices: [{ index: 0, delta: { content: "configured model response" }, finish_reason: null }] })}\n\n`
      + `data: ${JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: "stop" }] })}\n\ndata: [DONE]\n\n`);
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
  let selected = true;
  const selection = { workspaceId: host.workspaceId, actorId: "local:owner",
    assertCurrent() { if (!selected) throw new Error("owner revoked"); } };
  const connection = new AbortController();
  const model = createProductionChatModel({ provider: "openai-compatible", endpoint, model: "chosen-model",
    apiKey: "fixture-key", contextWindow: 16384, maxOutputTokens: 1024, outputTokenParameter: "max_tokens",
    includeUsage: false, status: "active", assertCurrent: selection.assertCurrent, tools: async () => [] });
  database = new DatabaseSync(join(dir, "process.sqlite"));
  const identity = { namespace: chat.workspaceNamespace, chatId: chat.id };
  child = await startManagedClientSnapshotChat({ managed, selection, connection: connection.signal,
    sourceRoot: source, privateParent: snapshots,
    profile: { id: "fixture", workspaceId: host.workspaceId, actorId: "local:owner", assertCurrent: selection.assertCurrent,
      policy: async () => ({ available: true, trusted: true, permissionMode: "ask", localControls: true }), remember: async () => {} },
    commands: [], owner: { database, captureDirectory: capture },
    chat: { chats: [identity], authorize: async binding => binding.chatId === chat.id,
      provider: async () => "unused", managed: { model, authorize: async binding => binding.chatId === chat.id,
        tools: { available: true, execute: async () => { throw new Error("Unexpected tool."); } } } },
    onCloseError(error) { throw error; } });
  const rpc = async input => {
    const response = await fetch(`${child.endpoint}/rpc`, { method: "POST",
      headers: { authorization: `Bearer ${child.bearer}`, "x-pkm-native-actor": "local:owner", "content-type": "application/json" },
      body: JSON.stringify(input) });
    const result = await response.json();
    assert.equal(response.status, 200, result.error);
    return result.value;
  };
  const history = await rpc({ method: "history", ...identity });
  await rpc({ method: "task-control", input: { ...identity, kind: "create", title: "Test model",
    operationId: randomUUID(), expectedRevision: history.taskControl.revision } });
  const first = randomUUID();
  await rpc({ method: "continue", ...identity, operationId: first, expectedRevision: 0, text: "First request." });
  const done = await child.managed.settled(identity, first);
  assert.match(JSON.stringify(done.messages), /configured model response/);
  assert.equal(observed.url, "/v1/chat/completions");
  assert.equal(observed.authorization, "Bearer fixture-key");
  assert.equal(observed.body.model, "chosen-model");
  assert.equal(observed.body.max_tokens, 1024);
  assert.equal(calls, 1);
  assert.equal(JSON.stringify(done).includes("fixture-key"), false);

  reject = true;
  const second = randomUUID(), current = await rpc({ method: "history", ...identity });
  await rpc({ method: "continue", ...identity, operationId: second, expectedRevision: current.revision, text: "Second request." });
  const failed = await child.managed.settled(identity, second);
  assert.equal(failed.nativeTurns.at(-1).status, "failed");
  assert.match(failed.messages.at(-1).error, /MODEL_AUTHENTICATION.*credentials/);
  assert.equal(JSON.stringify(failed).includes("fixture-key"), false);
  assert.equal(JSON.stringify(failed).includes("provider-detail-must-not-leak"), false);
  assert.equal(calls, 2);
  selected = false; connection.abort();
  await child.disconnectTask;
  child = undefined;
  await managed.close(); managed = undefined; host = undefined;
});
