import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { mkdir, readFile, rm } from "node:fs/promises";
import { createInterface } from "node:readline";
import { join, resolve } from "node:path";
import test from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { ProtocolClient, OPERATIONS } from "../browser/protocol.mjs";
import { KNOWLEDGE_LIFECYCLE_OPERATIONS, createKnowledgeLifecycleClient,
  knowledgeMutationScanRevision } from "../browser/knowledge-lifecycle.mjs";
import { startMcp } from "../dist/mcp.js";
import { managerActor, nativeWorkspace, until } from "./batch06-manager-fixtures.mjs";
import { createSyntheticProvider } from "./chat-turn-native-fixtures.mjs";
import { VscodeClient } from "../clients/vscode/client.ts";
import { initialize } from "../dist/storage.js";
import { startSharedManagedServer } from "../dist/shared-managed-server.js";
import { sharedManagedRequest } from "../dist/shared-managed-client.js";
import { stageIsolatedManagedGeneration, publishIsolatedManagedGeneration } from "../experimental/managed-migration.mjs";

const reader = Object.freeze({ id: "native:browser-search-reader", canWrite: false });
const invocation = (operation, args) => ({ operation, version: 1, arguments: args });
const hostileSource = '<script>window.pkmInjected = true</script>\nOLD pinned source';
const currentSource = '<script>window.pkmInjected = true</script>\nCURRENT pinned source';

test("stable Core manager preserves exact deterministic Chat across active-turn refusal, two-client handoff and HTML reload", { timeout: 240_000 }, async t => {
  const root = resolve("tests", `.managed-browser-chat-${randomUUID()}`);
  const token = randomUUID() + randomUUID(), managementToken = randomUUID() + randomUUID();
  const keyName = `PKM_CHAT_FIXTURE_${randomUUID().replaceAll("-", "_")}`;
  const key = "deterministic-local-provider-only";
  process.env[keyName] = key;
  const input = "Accepted managed browser input", answer = "Deterministic managed answer.";
  let release;
  const gate = new Promise(ready => { release = ready; });
  const providerCalls = [], providerErrors = [];
  const provider = createServer(async (request, response) => {
    try {
      let body = "";
      for await (const chunk of request) body += chunk;
      assert.equal(request.url, "/v1/chat/completions");
      assert.equal(request.headers.authorization, `Bearer ${key}`);
      const payload = JSON.parse(body);
      providerCalls.push(payload);
      assert.equal(payload.messages.at(-1).content, input);
      await gate;
      response.writeHead(200, { "content-type": "text/event-stream" });
      response.end(`data: ${JSON.stringify({ choices: [{ index: 0, delta: { content: answer }, finish_reason: null }] })}\n\n`
        + `data: ${JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: "stop" }] })}\n\n`
        + "data: [DONE]\n\n");
    } catch (error) {
      providerErrors.push(String(error)); response.writeHead(500); response.end();
    }
  });
  await new Promise(ready => provider.listen(0, "127.0.0.1", ready));
  const endpoint = `http://127.0.0.1:${provider.address().port}/v1`;
  let service, extension, child, sessionId;
  t.after(async () => {
    release();
    if (child && child.exitCode === null && child.signalCode === null) child.kill("SIGTERM");
    if (extension && sessionId) await until(async () => {
      const page = await extension.chatTurns({ sessionId }).catch(() => undefined);
      return page?.items.every(item => ["completed", "failed", "cancelled", "unknown"].includes(item.status));
    }, "managed Chat retirement").catch(() => {});
    extension?.dispose();
    await service?.close();
    provider.closeAllConnections();
    await new Promise(ready => provider.close(ready));
    delete process.env[keyName];
    await rm(root, { recursive: true, force: true });
  });
  await mkdir(root, { mode: 0o700 });
  const data = await initialize(join(root, "data"), { storageLayout: "separated" });
  const workspaceId = JSON.parse(await readFile(join(data, ".pkm-next-workspace"), "utf8")).id;
  const directory = join(data, "server-data", "runtime-control", "shared-manager");
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const managedRoot = join(root, "managed");
  const coreHostProfile = {
    schema: "pkm.shared-core-host/v1",
    config: { schema: "pkm.native-host-config/v1", provider: "openai-compatible", endpoint,
      secretRef: "secret:fixture/shared-chat", model: "deterministic-fixture", contextWindow: 16384,
      maxOutputTokens: 4096, outputTokenParameter: "max_tokens", includeUsage: false, tools: ["knowledge.document.get"] },
    policy: { allowedProviders: ["openai-compatible"], allowedEndpoints: [endpoint], allowedModels: ["deterministic-fixture"],
      allowedTools: ["knowledge.document.get"], allowInsecureLoopback: true },
    secretEnvironment: { "secret:fixture/shared-chat": keyName }, humanReview: "browser",
  };
  const first = await stageIsolatedManagedGeneration({ managedRoot, data, allowWrites: true, coreHostProfile });
  const second = await stageIsolatedManagedGeneration({ managedRoot, data, allowWrites: true, coreHostProfile });
  await publishIsolatedManagedGeneration(managedRoot, first.generation);
  service = await startSharedManagedServer({ directory, managedRoot, token, managementToken, backendKind: "standalone-core" });
  const admin = { origin: service.url, serviceId: service.serviceId, token: managementToken };
  const switchTo = async generation => {
    const approval = await sharedManagedRequest(admin, "/manage/approve", { action: "switch", generation });
    return sharedManagedRequest(admin, "/manage/switch", { generation, approvalId: approval.approvalId });
  };
  extension = new VscodeClient({
    secrets: { get: async () => token },
    attestServer: async (origin, info) => {
      assert.equal(origin, service.url); assert.equal(info.workspaceId, workspaceId); assert.equal(info.actorId, "local:owner");
      return { serverId: "pkm-v5", workspaceId, actorId: "local:owner", protocolVersion: "v1" };
    },
  }, { origin: service.url, secretKey: "fixture:shared-chat", expectedWorkspaceId: workspaceId });
  assert.equal((await extension.connect()).status, "connected");
  child = spawn(process.env.PYTHON ?? "python3", [resolve(import.meta.dirname, "browser-knowledge-search-e2e.py")],
    { stdio: ["pipe", "pipe", "pipe"] });
  let diagnostics = "", output = "", report, handlingFailure, before, previousPid, resetOperationId;
  child.stderr.on("data", bytes => { diagnostics += bytes; });
  child.stdout.on("data", bytes => { output += bytes; });
  const lines = createInterface({ input: child.stdout });
  const handling = (async () => {
    for await (const line of lines) {
      const event = JSON.parse(line);
      if (event.checkpoint === "managed-chat-running") {
        await until(() => providerCalls.length === 1, "actual configured provider dispatch");
        const sessions = await extension.chatList();
        assert.equal(sessions.items.length, 1); sessionId = sessions.items[0].id;
        const live = await extension.chatTurns({ sessionId });
        assert.equal(live.items.length, 1); assert.equal(live.items[0].status, "model");
        previousPid = service.status().backendPid;
        await assert.rejects(switchTo(second.generation), /active|background|BUSY|quiesce/i);
        assert.equal(service.status().backendPid, previousPid);
        assert.equal(service.status().phase, "accepting");
        assert.equal((await extension.chatMessages({ id: sessionId })).items[0].content, input);
        release();
        child.stdin.write('{"ready":true}\n');
      } else if (event.checkpoint === "managed-chat-completed") {
        before = await extension.chatMessages({ id: sessionId });
        assert.deepEqual(before.items.map(item => [item.role, item.status, item.content]),
          [["user", "complete", input], ["assistant", "complete", answer]]);
        assert.equal(providerCalls.length, 1);
        child.stdin.write('{"ready":true}\n');
      } else if (event.checkpoint === "managed-ui-approved") {
        assert.equal(service.status().generation, first.generation, "Requesting approval alone never switches a backend.");
        assert.equal(service.status().backendPid, previousPid);
        child.stdin.write('{"ready":true}\n');
      } else if (event.checkpoint === "managed-ui-switched") {
        assert.equal(service.status().generation, second.generation);
        assert.notEqual(service.status().backendPid, previousPid);
        assert.throws(() => process.kill(previousPid, 0), { code: "ESRCH" });
        assert.deepEqual(await extension.chatMessages({ id: sessionId }), before);
        child.stdin.write('{"ready":true}\n');
      } else if (event.checkpoint === "managed-ui-reset-unknown") {
        const pin = event.pin;
        resetOperationId = pin.operationId;
        const port = Number(new URL(service.url).port), originalOrigin = service.url;
        await service.close();
        service = await startSharedManagedServer({ directory, managedRoot, token, managementToken,
          backendKind: "standalone-core", port });
        assert.equal(service.url, originalOrigin);
        const observed = await sharedManagedRequest(admin, "/manage/operation-status", {
          operationId: pin.operationId, bodySha256: pin.bodySha256,
        });
        assert.equal(observed.status, "terminal");
        assert.equal(observed.record.phase, "completed");
        assert.equal(observed.record.action, "reset-index");
        assert.equal(observed.record.id, pin.operationId);
        assert.equal((await sharedManagedRequest(admin, "/manage/status")).history
          .filter(item => item.action === "reset-index").length, 1);
        child.stdin.write('{"ready":true}\n');
      } else if (event.checkpoint === "managed-chat-reloaded") {
        assert.deepEqual(await extension.chatMessages({ id: sessionId }), before);
        assert.equal(providerCalls.length, 1);
        const history = (await sharedManagedRequest(admin, "/manage/status")).history;
        assert.equal(history.filter(item => item.id === resetOperationId).length, 1,
          "Receipt observation and acknowledgement never execute the reset again.");
        child.stdin.write('{"ready":true}\n');
      } else report = event;
    }
  })().catch(error => { handlingFailure = error; child.kill("SIGTERM"); });
  const closed = new Promise((ready, reject) => { child.once("error", reject); child.once("close", ready); });
  const timer = setTimeout(() => child.kill("SIGTERM"), 120_000);
  child.stdin.write(JSON.stringify({ url: service.url, token, mode: "managed-chat", input, answer,
    serviceId: service.serviceId, managementToken, nextGeneration: second.generation }) + "\n");
  const status = await closed;
  clearTimeout(timer);
  await handling;
  if (handlingFailure) throw handlingFailure;
  assert.equal(status, 0, `${output}\n${diagnostics}`);
  assert.deepEqual(providerErrors, []);
  assert.deepEqual(report.errors, []);
  assert.equal(report.complete, true);
  assert.deepEqual(report.messages, [input, answer]);
  assert.equal(report.calls.filter(call => call.operation === "chat.turn.start").length, 1);
  assert.equal(report.calls.some(call => call.operation === "chat.session.append"), false);
});

test("production Browser reconciles a committed Knowledge receipt after reload without mutation replay", { timeout: 45_000 }, async t => {
  const f = await nativeWorkspace(t), id = "receipt-browser-doc", content = "Reconciled private fixture Markdown.";
  await f.runtime.core.dispatch("capability_call", invocation("knowledge.document.create", {
    operationId: randomUUID(), id, title: "Reload receipt fixture", content: "Original fixture Markdown.",
  }), managerActor);
  const url = await f.listen(managerActor);
  const child = spawn(process.env.PYTHON ?? "python3", [resolve(import.meta.dirname, "browser-knowledge-search-e2e.py")],
    { stdio: ["pipe", "pipe", "pipe"] });
  let output = "", diagnostics = "";
  child.stdout.on("data", bytes => { output += bytes; });
  child.stderr.on("data", bytes => { diagnostics += bytes; });
  const closed = new Promise((done, reject) => { child.once("error", reject); child.once("close", done); });
  const timer = setTimeout(() => child.kill("SIGTERM"), 30_000);
  f.addCleanup(() => { clearTimeout(timer); if (child.exitCode === null && child.signalCode === null) child.kill("SIGTERM"); });
  child.stdin.end(JSON.stringify({ url, token: f.bearer, mode: "receipt-reconcile", content }) + "\n");
  assert.equal(await closed, 0, `${output}\n${diagnostics}`);
  clearTimeout(timer);
  const report = JSON.parse(output.trim());
  assert.deepEqual(report.errors, []);
  assert.equal(report.reconciled, true);
  assert.equal(report.calls.filter(call => call.operation === "knowledge.document.update").length, 1);
  const current = await f.runtime.core.dispatch("capability_read", invocation("knowledge.document.get", { id }), managerActor);
  assert.equal(current.result.content, content);
  assert.equal(current.result.revision, 2);
});

test("production Browser reload preserves nonsecret unknown Knowledge write pins and blocks replacement", { timeout: 45_000 }, async t => {
  const f = await nativeWorkspace(t);
  const url = await f.listen(managerActor), title = "Reload uncertainty fixture", content = "Sensitive fixture Markdown.";
  const child = spawn(process.env.PYTHON ?? "python3", [resolve(import.meta.dirname, "browser-knowledge-search-e2e.py")],
    { stdio: ["pipe", "pipe", "pipe"] });
  let output = "", diagnostics = "";
  child.stdout.on("data", bytes => { output += bytes; });
  child.stderr.on("data", bytes => { diagnostics += bytes; });
  const closed = new Promise((done, reject) => { child.once("error", reject); child.once("close", done); });
  const timer = setTimeout(() => child.kill("SIGTERM"), 30_000);
  f.addCleanup(() => { clearTimeout(timer); if (child.exitCode === null && child.signalCode === null) child.kill("SIGTERM"); });
  child.stdin.end(JSON.stringify({ url, token: f.bearer, mode: "pending-write", title, content }) + "\n");
  assert.equal(await closed, 0, `${output}\n${diagnostics}`);
  clearTimeout(timer);
  const report = JSON.parse(output.trim());
  assert.deepEqual(report.errors, []);
  assert.equal(report.blocked, true);
  assert.equal(report.calls.filter(call => call.operation === "knowledge.note.create").length, 1);
  const found = await f.runtime.core.dispatch("capability_read", invocation("knowledge.note.search", {
    query: title, offset: 0, limit: 10,
  }), managerActor);
  assert.equal(found.result.items.length, 1, "The original server-committed write survives without replay or replacement.");
});

test("production Browser reloads and cancels an actual server-owned native Chat without model replay", { timeout: 45_000 }, async t => {
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  const provider = createSyntheticProvider({ onOpen: async () => { await gate; } });
  const f = await nativeWorkspace(t, { ...provider,
    toolCatalog: [{ name: "create_document", operation: "knowledge.document.create" }],
    reviewer: async request => ({ actorId: request.actorId, decisionId: randomUUID(), decision: "reject" }),
  });
  f.addCleanup(() => release());
  const url = await f.listen(managerActor);
  const child = spawn(process.env.PYTHON ?? "python3", [resolve(import.meta.dirname, "browser-knowledge-search-e2e.py")],
    { stdio: ["pipe", "pipe", "pipe"] });
  let diagnostics = "", output = "", report;
  child.stderr.on("data", bytes => { diagnostics += bytes; });
  child.stdout.on("data", bytes => { output += bytes; });
  const lines = createInterface({ input: child.stdout });
  const handling = (async () => {
    for await (const line of lines) {
      const event = JSON.parse(line);
      if (event.checkpoint === "chat-running") {
        assert.equal(provider.counts().modelCalls, 1);
        assert.equal(f.runtime.services.chatTurns.activity().active, 1);
        child.stdin.write('{"ready":true}\n');
      } else if (event.checkpoint === "chat-cancelled") {
        assert.equal(provider.counts().modelCalls, 1);
        release();
        child.stdin.write('{"ready":true}\n');
      } else report = event;
    }
  })();
  const closed = new Promise((done, reject) => { child.once("error", reject); child.once("close", done); });
  const timer = setTimeout(() => child.kill("SIGTERM"), 30_000);
  f.addCleanup(() => { clearTimeout(timer); if (child.exitCode === null && child.signalCode === null) child.kill("SIGTERM"); });
  child.stdin.write(JSON.stringify({ url, token: f.bearer, mode: "chat" }) + "\n");
  const status = await closed;
  clearTimeout(timer);
  await handling;
  assert.equal(status, 0, `${output}\n${diagnostics}`);
  assert.deepEqual(report.errors, []);
  assert.equal(report.cancelled, true);
  const starts = report.calls.filter(call => call.operation === "chat.turn.start");
  assert.equal(starts.length, 1);
  const sessionId = starts[0].arguments.sessionId;
  const transcript = await f.runtime.core.dispatch("capability_read", invocation("chat.session.messages", { id: sessionId }), managerActor);
  assert.deepEqual(transcript.result.items.map(item => [item.role, item.status]), [["user", "complete"], ["assistant", "cancelled"]]);
  assert.equal(transcript.result.items[0].content, "Durable browser input");
  assert.equal(report.calls.some(call => call.operation === "chat.session.append"), false);
  assert(report.calls.filter(call => call.operation === "chat.turn.list").length >= 3);
});

test("production Browser searches and opens a pinned Note through Core HTTP and read-only MCP", { timeout: 45_000 }, async t => {
  const f = await nativeWorkspace(t);
  const writerUrl = await f.listen(managerActor);
  const readerUrl = await f.listen(reader);
  const writerProtocol = new ProtocolClient({ origin: writerUrl,
    operations: { ...OPERATIONS, ...KNOWLEDGE_LIFECYCLE_OPERATIONS } });
  writerProtocol.authenticate(f.bearer);
  await writerProtocol.bootstrap();
  const writer = createKnowledgeLifecycleClient(writerProtocol);
  const receipt = await writer.noteCreate({
    operationId: randomUUID(), expectedScanRevision: await knowledgeMutationScanRevision(writer),
    title: "Pinned Browser Fixture", category: "Browser", content: hostileSource,
  });
  assert.equal(receipt.action, "create");

  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const mcp = await startMcp(f.runtime.core, reader, serverTransport);
  const mcpClient = new Client({ name: "browser-search-e2e", version: "1.0.0" });
  await mcpClient.connect(clientTransport);
  f.addCleanup(async () => { await mcpClient.close(); await mcp.close(); writerProtocol.dispose(); });
  const tools = (await mcpClient.listTools()).tools;
  assert(tools.some(tool => tool.name === "capability_read"));
  assert.equal(tools.some(tool => tool.name === "capability_call"), false, "reader MCP cannot discover mutation entry");
  const described = await mcpClient.callTool({ name: "capabilities_describe", arguments: { operation: "knowledge.note.search" } });
  assert.equal(described.isError, false);
  assert.equal(described.structuredContent.result.readOnly, true);
  const search = await mcpClient.callTool({ name: "capability_read", arguments: invocation("knowledge.note.search", {
    query: "Pinned Browser Fixture", offset: 0, limit: 10,
  }) });
  assert.equal(search.isError, false);
  const mcpSnapshot = search.structuredContent.result;
  const match = mcpSnapshot.items.find(item => item.documentId === receipt.id);
  assert.ok(match, JSON.stringify(mcpSnapshot));
  const opened = await mcpClient.callTool({ name: "capability_read", arguments: invocation("knowledge.note.get", {
    id: receipt.id, snapshotRevision: mcpSnapshot.snapshotRevision,
  }) });
  assert.equal(opened.isError, false);
  assert.equal(opened.structuredContent.result.item.content, hostileSource);
  assert.equal(opened.structuredContent.result.item.documentSha256, match.documentSha256);

  const child = spawn(process.env.PYTHON ?? "python", [resolve(import.meta.dirname, "browser-knowledge-search-e2e.py")],
    { stdio: ["pipe", "pipe", "pipe"] });
  let output = "", diagnostics = "", report;
  child.stdout.on("data", bytes => { output += bytes.toString(); });
  child.stderr.on("data", bytes => { diagnostics += bytes.toString(); });
  const lines = createInterface({ input: child.stdout });
  const handling = (async () => {
    for await (const line of lines) {
      const event = JSON.parse(line);
      if (event.checkpoint === "search-ready") {
        const latest = await writer.documentGet({ id: receipt.id });
        await writer.noteUpdate({
          operationId: randomUUID(), id: receipt.id,
          expectedScanRevision: await knowledgeMutationScanRevision(writer),
          expectedRevision: latest.revision, expectedSha256: latest.sha256,
          content: currentSource,
        });
        child.stdin.write('{"ready":true}\n');
      } else {
        report = event;
      }
    }
  })();
  const closed = new Promise((done, reject) => { child.once("error", reject); child.once("close", done); });
  const timer = setTimeout(() => child.kill("SIGTERM"), 30_000);
  f.addCleanup(() => { clearTimeout(timer); if (child.exitCode === null && child.signalCode === null) child.kill("SIGTERM"); });
  child.stdin.write(JSON.stringify({
    url: readerUrl, token: f.bearer, title: "Pinned Browser Fixture",
    initialSnapshotRevision: mcpSnapshot.snapshotRevision,
  }) + "\n");
  const status = await closed;
  clearTimeout(timer);
  await handling;
  assert.equal(status, 0, `${output}\n${diagnostics}`);
  assert.ok(report, output);
  assert.deepEqual(report.errors, []);
  assert.equal(report.injected, false);
  assert.equal(report.readOnly, true);
  assert(report.calls.some(call => call.operation === "knowledge.note.search"));
  const noteReads = report.calls.filter(call => call.operation === "knowledge.note.get");
  assert.equal(noteReads.length, 2, JSON.stringify(report.calls));
  assert.equal(noteReads[0].arguments.snapshotRevision, mcpSnapshot.snapshotRevision,
    "the first Browser open uses the exact search snapshot");
  assert.notEqual(noteReads[1].arguments.snapshotRevision, mcpSnapshot.snapshotRevision,
    "refreshing after a changed source obtains a new snapshot");
  assert(report.calls.some(call => call.operation === "knowledge.document.get"));
  assert.equal(report.calls.some(call => call.method === "capability_call"), false,
    "the Browser flow performs reads only");
  assert.equal((await writer.documentGet({ id: receipt.id })).content, currentSource);
  writerProtocol.dispose();
});
