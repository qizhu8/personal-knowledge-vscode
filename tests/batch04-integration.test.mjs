import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import { mkdir, rm } from "node:fs/promises";
import { DatabaseSync } from "node:sqlite";
import { spawn, execFileSync } from "node:child_process";
import { once } from "node:events";
import { createInterface } from "node:readline";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { chatSessionFixture } from "./chat-session-fixtures.mjs";
import { workflowRuntimeTransportFixtures } from "./workflow-runtime-fixtures.mjs";
import { syncPlanCreateFixture } from "./sync-plan-fixture.mjs";
import { originalActionCompilerFixtures } from "./action-compiler-original-fixtures.mjs";
import { loadCollaborationModules, actors, mutation } from "./collaboration-state-fixtures.mjs";
import { Storage } from "../dist/storage.js";

const cli = resolve("dist/cli.js");
const adapter = fileURLToPath(new URL("./batch04-adapter-child.mjs", import.meta.url));
const token = `${randomUUID()}${randomUUID()}`;
const ownerActor = { id: "local:owner", canWrite: true, collaborationKind: "human" };
const readerActor = { id: "local:reader", canWrite: false, collaborationKind: "agent" };
const invoke = (operation, args) => ({ operation, version: 1, arguments: args });
const errorCode = response => response.body?.error?.code;
const hasOperationPrefix = (items, prefix) => items.some(item =>
  [item.operation, item.id, item.name].some(value => typeof value === "string" && value.startsWith(prefix)));
const adapterEnv = (data, transport, actor) => ({
  ...process.env,
  PKM_NEXT_TOKEN: token,
  PKM_BATCH04_DATA: data,
  PKM_BATCH04_TRANSPORT: transport,
  PKM_BATCH04_ACTOR_ID: actor.id,
  PKM_BATCH04_CAN_WRITE: String(actor.canWrite),
  PKM_BATCH04_COLLABORATION_KIND: actor.collaborationKind,
});

async function workspace(t) {
  const root = resolve("tests", `.batch04-integration-${randomUUID()}`);
  const data = join(root, "workspace");
  await mkdir(root);
  t.after(() => rm(root, { recursive: true, force: true }));
  execFileSync(process.execPath, [cli, "init", "--data", data], { stdio: "ignore" });
  return { root, data };
}

async function startHttp(t, data, actor = ownerActor) {
  const child = spawn(process.execPath, [adapter], {
    cwd: resolve("."),
    env: adapterEnv(data, "http", actor),
    stdio: ["ignore", "pipe", "pipe"],
  });
  let diagnostics = "";
  child.stderr.on("data", chunk => { diagnostics += chunk; });
  let stopped = false;
  const stop = async () => {
    if (stopped) return;
    stopped = true;
    if (child.exitCode === null && child.signalCode === null) {
      const exited = once(child, "exit");
      child.kill("SIGTERM");
      await exited;
    }
  };
  t.after(stop);
  const url = await new Promise((resolveUrl, reject) => {
    const lines = createInterface({ input: child.stdout });
    const timeout = setTimeout(() => {
      child.kill("SIGTERM");
      reject(new Error(`HTTP readiness timeout: ${diagnostics}`));
    }, 10000);
    lines.on("line", line => {
      try {
        const message = JSON.parse(line);
        if (message.ready) {
          clearTimeout(timeout);
          lines.close();
          resolveUrl(message.url);
        }
      } catch (error) {
        clearTimeout(timeout);
        lines.close();
        reject(error);
      }
    });
    child.once("exit", code => {
      clearTimeout(timeout);
      reject(new Error(`HTTP server exited ${code}: ${diagnostics}`));
    });
  });
  return {
    stop,
    async call(method, input) {
      const response = await fetch(`${url}/v1/${method}`, {
        method: "POST",
        headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
        body: JSON.stringify(input),
      });
      return { status: response.status, body: await response.json() };
    },
  };
}

async function startMcp(t, data, actor = ownerActor) {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [adapter],
    env: adapterEnv(data, "mcp", actor),
    stderr: "pipe",
  });
  const client = new Client({ name: "batch04-integration-test", version: "1.0.0" });
  let stopped = false;
  const stop = async () => {
    if (stopped) return;
    stopped = true;
    await client.close();
  };
  t.after(stop);
  await client.connect(transport);
  return {
    client,
    stop,
    async call(name, args) {
      const response = await client.callTool({ name, arguments: args });
      return response.structuredContent ?? JSON.parse(response.content[0].text);
    },
  };
}

function assertSuccess(response) {
  assert.equal(response.body?.error, undefined, JSON.stringify(response.body?.error));
  assert.equal(response.schema ?? response.body?.schema, "pkm.next-result/v1");
  return response.body?.result ?? response.result;
}

function assertMcpSuccess(response) {
  assert.equal(response.error, undefined, JSON.stringify(response.error));
  return response.result;
}

function assertError(response, expected) {
  assert.equal(errorCode(response), expected, JSON.stringify(response.body));
}

test("Batch 04 public operations share HTTP/MCP receipts, actor isolation and durable SQLite state", { timeout: 60000 }, async t => {
  const { data } = await workspace(t);
  const initialStorage = await Storage.open(data);
  await initialStorage.close();
  const database = new DatabaseSync(join(data, "core.sqlite"));
  assert.equal(Number(database.prepare("PRAGMA user_version").get().user_version), 23);
  const collaboration = await loadCollaborationModules();
  const state = new collaboration.store.CollaborationStateStore(database, {
    authorizeHuman: () => true,
    now: () => Date.parse("2026-01-02T03:04:05.000Z"),
  });
  const roomId = "batch04-fixture-room";
  state.create(actors.host, { roomId, operationId: randomUUID(), name: "Synthetic room", alias: "Host" });
  const nativeOwner = { actorId: "local:owner", kind: "human" };
  state.join(nativeOwner, mutation(roomId, 1, { alias: "Owner" }));
  const collaborationRevision = state.read(nativeOwner, roomId).revision;
  assert(database.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'collaboration_rooms'").get());
  database.close();

  const ownerHttp = await startHttp(t, data);
  const ownerEnvelope = {
    async call(method, input) { return (await ownerHttp.call(method, input)).body; },
  };
  const chatCreateArgs = structuredClone(chatSessionFixture.create.args);
  chatCreateArgs.operationId = randomUUID();
  const chatCreate = invoke(chatSessionFixture.create.operation, chatCreateArgs);
  const created = assertSuccess(await ownerHttp.call("capability_call", chatCreate));
  assert.equal(created.generation, "unavailable");
  assert.equal(created.replay, "never");
  assert.deepEqual(assertMcpSuccess(await ownerEnvelope.call("capability_call", chatCreate)), created);

  const alteredRetry = invoke(chatSessionFixture.create.operation, { ...chatCreateArgs, title: "Different request" });
  assertError(await ownerHttp.call("capability_call", alteredRetry), "CONFLICT");
  assertError(await ownerHttp.call("capability_read", chatCreate), "ACCESS_DENIED");
  assertError(await ownerHttp.call("capability_call", invoke(chatSessionFixture.get.operation, chatSessionFixture.get.args)), "ACCESS_DENIED");
  assertError(await ownerHttp.call("capability_read", invoke(chatSessionFixture.get.operation, {
    ...chatSessionFixture.get.args, actorId: "local:owner",
  })), "INVALID_ARGUMENT");

  const chatAppendArgs = structuredClone(chatSessionFixture.append.args);
  chatAppendArgs.operationId = randomUUID();
  const chatAppend = invoke(chatSessionFixture.append.operation, chatAppendArgs);
  const appended = assertMcpSuccess(await ownerEnvelope.call("capability_call", chatAppend));
  assert.equal(appended.message.replay, "never");
  assert.deepEqual(assertSuccess(await ownerHttp.call("capability_call", chatAppend)), appended);

  const competing = ["first", "second"].map(label => invoke(chatSessionFixture.append.operation, {
    operationId: randomUUID(),
    id: chatSessionFixture.create.args.id,
    expectedRevision: appended.session.revision,
    message: {
      id: `batch04-${label}`, role: "user", content: `Synthetic ${label} append`,
      status: "complete", recordedAt: "2026-01-02T03:04:06.000Z",
    },
  }));
  const writes = await Promise.all([
    ownerHttp.call("capability_call", competing[0]),
    ownerEnvelope.call("capability_call", competing[1]),
  ]);
  const results = writes.map((response, index) => {
    const value = index === 0 ? response.body : response;
    return value.error ? { error: value.error.code } : { result: value.result };
  });
  assert.equal(results.filter(value => value.result).length, 1);
  assert.equal(results.filter(value => value.error === "CONFLICT").length, 1);
  const winningIndex = results.findIndex(value => value.result);
  const winningRequest = competing[winningIndex];
  const winningResult = results[winningIndex].result;
  assert.deepEqual(assertMcpSuccess(await ownerEnvelope.call("capability_call", winningRequest)), winningResult);
  assertError(await ownerHttp.call("capability_call", invoke(chatSessionFixture.append.operation, {
    ...winningRequest.arguments, message: { ...winningRequest.arguments.message, content: "Changed after commit" },
  })), "CONFLICT");

  const workflowCreate = workflowRuntimeTransportFixtures[0];
  const workflowArgs = structuredClone(workflowCreate.args);
  workflowArgs.operationId = randomUUID();
  workflowArgs.runId = "batch04-noop-run";
  const workflowMutation = invoke(workflowCreate.operation, workflowArgs);
  const workflow = assertMcpSuccess(await ownerEnvelope.call("capability_call", workflowMutation));
  assert.equal(workflow.execution, "host-only-noop");
  assert.equal(workflow.state, "ready");
  assert.deepEqual(workflow.nodes.map(node => node.state), ["pending"]);
  assertError(await ownerHttp.call("capability_call", invoke(workflowCreate.operation, {
    ...workflowArgs, operationId: chatCreateArgs.operationId, runId: "batch04-reused-operation",
  })), "CONFLICT");
  const workflowCancel = invoke("workflow.run.cancel", {
    operationId: randomUUID(), runId: workflow.runId, expectedVersion: workflow.version,
  });
  const cancelled = assertSuccess(await ownerHttp.call("capability_call", workflowCancel));
  assert.equal(cancelled.state, "cancelled");
  assert.deepEqual(assertMcpSuccess(await ownerEnvelope.call("capability_call", workflowCancel)), cancelled);

  const syncArgs = {
    ...syncPlanCreateFixture,
    sessionId: randomUUID(),
    operationId: randomUUID(),
  };
  delete syncArgs.actorId;
  const syncCreate = invoke("sync.plan.create", syncArgs);
  const syncSession = assertSuccess(await ownerHttp.call("capability_call", syncCreate));
  const syncDecision = invoke("sync.plan.decide", {
    sessionId: syncArgs.sessionId,
    operationId: randomUUID(),
    expectedRevision: syncSession.revision,
    conflictId: syncSession.plan.conflicts[0].id,
    choice: "remote",
    reason: "Synthetic offline review",
  });
  const decided = assertMcpSuccess(await ownerEnvelope.call("capability_call", syncDecision));
  assert.equal(decided.revision, syncSession.revision + 1);
  assertError(await ownerHttp.call("capability_call", invoke("sync.plan.create", {
    ...syncArgs, actorId: "forged-actor",
  })), "INVALID_ARGUMENT");

  const collaborationList = assertSuccess(await ownerHttp.call("capability_read", invoke("collaboration.state.list", {})));
  assert.match(JSON.stringify(collaborationList), new RegExp(roomId));
  const collaborationReadArgs = { roomId };
  const room = assertMcpSuccess(await ownerEnvelope.call("capability_read", invoke("collaboration.state.read", collaborationReadArgs)));
  assert.equal(room.roomId, roomId);
  const leave = invoke("collaboration.state.leave", {
    operationId: randomUUID(), roomId, expectedRevision: collaborationRevision,
  });
  const left = assertSuccess(await ownerHttp.call("capability_call", leave));
  assert.deepEqual(assertMcpSuccess(await ownerEnvelope.call("capability_call", leave)), left);
  const ownerAfterLeave = await ownerEnvelope.call("capability_read", invoke("collaboration.state.read", collaborationReadArgs));
  assert.equal(ownerAfterLeave.result.members.find(member => member.actorId === "local:owner").present, false);
  assertError(await ownerHttp.call("capability_call", invoke("collaboration.state.leave", {
    ...leave.arguments, actorId: "fixture-host",
  })), "INVALID_ARGUMENT");

  const actionCapabilities = assertSuccess(await ownerHttp.call("capability_read", invoke("action.compiler.capabilities", {})));
  assert.equal(actionCapabilities.runtimeStatus, "not-runnable-here");
  const actionCheck = assertMcpSuccess(await ownerEnvelope.call("capability_read", invoke("action.definition.check", {
    source: { kind: "inline", definition: structuredClone(originalActionCompilerFixtures.example) },
  })));
  assert.equal(actionCheck.persisted, false);
  assert.equal(actionCheck.executed, false);
  const actionCompilation = assertMcpSuccess(await ownerEnvelope.call("capability_read", invoke("action.definition.compile", {
    source: { kind: "inline", definition: structuredClone(originalActionCompilerFixtures.example) },
  })));
  assert.equal(actionCompilation.status, "valid");
  assertError(await ownerHttp.call("capability_call", invoke("action.compiler.capabilities", {})), "ACCESS_DENIED");

  await ownerHttp.stop();
  const readerHttp = await startHttp(t, data, readerActor);
  const readerEnvelope = {
    async call(method, input) { return (await readerHttp.call(method, input)).body; },
  };
  assert.equal((await readerHttp.call("capability_call", chatCreate)).status, 403);
  const readerChat = await readerEnvelope.call("capability_read", invoke(chatSessionFixture.get.operation, chatSessionFixture.get.args));
  assert.equal(readerChat.error.code, "NOT_FOUND");
  assertError(await readerHttp.call("capability_read", invoke(chatSessionFixture.get.operation, chatSessionFixture.get.args)), "NOT_FOUND");
  const readerRoomList = assertMcpSuccess(await readerEnvelope.call("capability_read", invoke("collaboration.state.list", {})));
  assert.doesNotMatch(JSON.stringify(readerRoomList), new RegExp(roomId));
  const readerRoom = await readerEnvelope.call("capability_read", invoke("collaboration.state.read", collaborationReadArgs));
  assert(readerRoom.error);
  await readerHttp.stop();
  const readerMcp = await startMcp(t, data, readerActor);
  assert(!(await readerMcp.client.listTools()).tools.some(tool => tool.name === "capability_call"));
  assert.equal((await readerMcp.call("capability_read", invoke(chatSessionFixture.get.operation, chatSessionFixture.get.args))).error.code, "NOT_FOUND");
  await readerMcp.stop();
  const otherWriter = await startHttp(t, data, { id: "local:other", canWrite: true, collaborationKind: "agent" });
  assertError(await otherWriter.call("capability_call", chatCreate), "CONFLICT");
  assertError(await otherWriter.call("capability_read", invoke(chatSessionFixture.get.operation, chatSessionFixture.get.args)), "NOT_FOUND");
  await otherWriter.stop();

  const ownerHttp2 = await startHttp(t, data);
  const pluginDiscovery = assertSuccess(await ownerHttp2.call("capability_read", invoke("plugin.runtime.discover", {})));
  const teams = pluginDiscovery.items.find(item => item.id === "teams");
  assert.equal(teams.available, false);
  assert.equal(teams.unavailableReason, "implementation_not_injected");
  const pluginStatus = assertSuccess(await ownerHttp2.call("capability_read", invoke("plugin.runtime.status", { pluginId: "teams" })));
  assert.equal(pluginStatus.available, false);
  assert.equal(pluginStatus.unavailableReason, "implementation_not_injected");
  const modelCatalog = assertSuccess(await ownerHttp2.call("capabilities_search", { query: "model.config" }));
  assert(!hasOperationPrefix(modelCatalog.items, "model.config."));
  const unavailableModel = await ownerHttp2.call("capability_read", invoke("model.config.catalog", {}));
  assert(["NOT_FOUND", "NOT_AVAILABLE"].includes(errorCode(unavailableModel)));
  const processCatalog = assertSuccess(await ownerHttp2.call("capabilities_search", { query: "runtime.process" }));
  assert(!hasOperationPrefix(processCatalog.items, "runtime.process."));
  const unavailableProcess = await ownerHttp2.call("capability_call", invoke("runtime.process.launch", { command: "must-not-run" }));
  assert(["NOT_FOUND", "NOT_AVAILABLE"].includes(errorCode(unavailableProcess)));
  const executionCatalog = assertSuccess(await ownerHttp2.call("capabilities_search", { query: "execution" }));
  assert(!hasOperationPrefix(executionCatalog.items, "execution."));

  await ownerHttp2.stop();
  const ownerMcp = await startMcp(t, data);
  assert.deepEqual(assertMcpSuccess(await ownerMcp.call("capability_call", chatCreate)), created);
  const mcpPluginStatus = assertMcpSuccess(await ownerMcp.call("capability_read",
    invoke("plugin.runtime.status", { pluginId: "teams" })));
  assert.equal(mcpPluginStatus.unavailableReason, "implementation_not_injected");
  await ownerMcp.stop();
  const restarted = await startHttp(t, data);
  assert.deepEqual(assertSuccess(await restarted.call("capability_call", chatCreate)), created);
  const durableMessages = assertSuccess(await restarted.call("capability_read", invoke(
    chatSessionFixture.messages.operation, chatSessionFixture.messages.args,
  )));
  assert.equal(durableMessages.items.length, 2);
  assert.deepEqual(assertSuccess(await restarted.call("capability_call", workflowCancel)), cancelled);
  assert.deepEqual(assertSuccess(await restarted.call("capability_read", invoke("sync.plan.get", { sessionId: syncArgs.sessionId }))), decided);
});
