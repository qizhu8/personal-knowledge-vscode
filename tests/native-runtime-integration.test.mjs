import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { Core } from "../dist/core.js";
import { folderLifecycleDefinitions, planFolderLifecycle, serializeFolderLifecyclePlan } from "../dist/folder-lifecycle.js";
import { startHttp } from "../dist/http.js";
import { startMcp } from "../dist/mcp.js";
import { scanMarkdown } from "../dist/markdown.js";
import { initialize, Storage } from "../dist/storage.js";
import { syncPlanHash } from "../dist/sync-plan.js";
import { chatTurnInput } from "./chat-turn-fixtures.mjs";
import { nativeActor, openNativeRuntime } from "./native-runtime-fixtures.mjs";
import { syncApplyFixtureBytes, syncApplyFixtureInput } from "./sync-apply-fixture.mjs";

const tests = dirname(fileURLToPath(import.meta.url));
const bearer = "native-runtime-synthetic-test-token-000000000000";
const invoke = (operation, arguments_) => ({ operation, version: 1, arguments: arguments_ });
const tick = () => new Promise(resolve => setTimeout(resolve, 10));
async function sessionInput(url) {
  const input = chatTurnInput({ expectedSessionRevision: 1 });
  const created = await post(url, "capability_call", invoke("chat.session.create", {
    id: input.sessionId, title: "Native server Chat", expectedRevision: 0, operationId: randomUUID(),
  }));
  assert.equal(created.status, 200, JSON.stringify(created.body));
  return input;
}

async function workspace(t) {
  const root = join(tests, `.native-runtime-${randomUUID()}`);
  await initialize(root);
  const storage = await Storage.open(root);
  let currentStorage = storage;
  let configured;
  let server;
  let closed = false;
  const cleanups = [];
  const result = {
    root, storage,
    addCleanup(action) { cleanups.push(action); },
    async configure(options = {}) {
      configured = await openNativeRuntime(currentStorage, options);
      return configured;
    },
    async replaceStorage(nextStorage, options = {}) {
      currentStorage = nextStorage;
      result.storage = nextStorage;
      configured = await openNativeRuntime(currentStorage, options);
      return configured;
    },
    async listen(core = configured.core, actor = nativeActor) {
      const current = await startHttp(core, bearer, actor, 0, undefined, undefined, configured?.runtime.services.chatTurns);
      server = current.server;
      return {
        url: current.url,
        transport: current,
        async close() {
          if (!server) return;
          const currentServer = server;
          server = undefined;
          await new Promise((resolve, reject) => currentServer.close(error => error ? reject(error) : resolve()));
        },
      };
    },
    async closeRuntimeAndStorage() {
      if (configured) {
        const currentRuntime = configured.runtime;
        configured = undefined;
        await currentRuntime.close();
      }
      if (currentStorage) {
        const currentStorageValue = currentStorage;
        currentStorage = undefined;
        await currentStorageValue.close();
      }
    },
    async dispose() {
      if (closed) return;
      closed = true;
      for (const action of cleanups.reverse()) await action();
      if (server) {
        const currentServer = server;
        server = undefined;
        await new Promise(resolve => currentServer.close(() => resolve()));
      }
      await result.closeRuntimeAndStorage();
      await rm(root, { recursive: true, force: true });
    },
  };
  t.after(() => result.dispose());
  return result;
}

async function post(url, method, body, authorization = bearer) {
  const response = await fetch(`${url}/v1/${method}`, {
    method: "POST",
    headers: { authorization: `Bearer ${authorization}`, "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  return { status: response.status, body: await response.json() };
}

async function terminalTurn(url, id, statuses = ["completed", "cancelled", "failed", "unknown"]) {
  const deadline = Date.now() + 8000;
  for (;;) {
    const response = await post(url, "capability_read", invoke("chat.turn.get", { id }));
    assert.equal(response.status, 200, JSON.stringify(response.body));
    if (statuses.includes(response.body.result.status)) return response.body.result;
    if (Date.now() >= deadline) throw new Error(`Turn did not reach a terminal state: ${JSON.stringify(response.body.result)}`);
    await tick();
  }
}

async function turnEvents(url, id) {
  const response = await post(url, "capability_read", invoke("chat.turn.events", { id, after: 0, limit: 100 }));
  assert.equal(response.status, 200, JSON.stringify(response.body));
  return response.body.result.events;
}

async function seedFolderIntent(root, actorId, args) {
  const operation = "knowledge.folder.move";
  const operationArgs = folderLifecycleDefinitions[1].input.parse(args);
  const request = { operation, args: operationArgs, actorId };
  const plan = serializeFolderLifecyclePlan(planFolderLifecycle(root, scanMarkdown(root), request));
  const requestJson = JSON.stringify(request);
  const fingerprint = createHash("sha256").update(JSON.stringify({ operation, actorId, args: operationArgs })).digest("hex");
  const workspaceId = JSON.parse(await readFile(join(root, ".pkm-next-workspace"), "utf8")).id;
  const binding = [workspaceId, resolve(root), actorId, operation, fingerprint, requestJson, plan];
  const digest = createHash("sha256").update(JSON.stringify([operationArgs.operationId, ...binding])).digest("hex");
  const database = new DatabaseSync(join(root, "core.sqlite"));
  try {
    database.prepare("INSERT INTO data_runtime_intents VALUES(?,?,?,?,?,?,?,?,?)")
      .run(operationArgs.operationId, ...binding, digest);
  } finally { database.close(); }
  return { request, plan: JSON.parse(plan) };
}

async function mcpClient(f, root, actorId, counterPath) {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [join(tests, "native-runtime-mcp-child.mjs"), root, actorId, counterPath],
    stderr: "pipe",
  });
  const client = new Client({ name: "native-runtime-integration", version: "1.0.0" });
  let diagnostics = "";
  transport.stderr?.on("data", chunk => { diagnostics += chunk.toString(); });
  let closed = false;
  const close = async () => {
    if (closed) return;
    closed = true;
    await client.close();
  };
  f.addCleanup(close);
  try { await client.connect(transport); }
  catch (error) { throw new Error(`Native MCP child failed to start: ${diagnostics}`, { cause: error }); }
  return {
    client,
    async call(method, args) {
      let result;
      try { result = await client.callTool({ name: method, arguments: args }); }
      catch (error) { throw new Error(`Native MCP call failed: ${diagnostics}`, { cause: error }); }
      return result.structuredContent ?? JSON.parse(result.content[0].text);
    },
    close,
  };
}

test("configured native host runs the provider-to-Chat-to-exact-approval-to-Core chain over HTTP and MCP without replay", async t => {
  const f = await workspace(t);
  const configured = await f.configure({ documentId: "native-chain-document" });
  const http = await f.listen();
  const input = await sessionInput(http.url);

  assert.equal((await post(http.url, "server_info", {}, "wrong-native-test-token")).status, 401);
  const started = await post(http.url, "capability_call", invoke("chat.turn.start", input));
  assert.equal(started.status, 200, JSON.stringify(started.body));
  assert.equal(started.body.result.id, input.id);
  const completed = await terminalTurn(http.url, input.id);
  assert.equal(completed.status, "completed");
  assert.match(completed.output, /Synthetic document verified/);
  assert.equal(configured.provider.counts().modelCalls, 2);
  assert.equal(configured.reviews.length, 1);
  assert.equal(configured.authorizations.length, 1);
  assert.equal(configured.reviews[0].record.tool, "knowledge.document.create");
  assert.equal(configured.reviews[0].record.arguments.id, "native-chain-document");
  assert.equal(configured.reviews[0].record.arguments.title, "Synthetic chain");
  assert.equal(configured.reviews[0].record.arguments.operationId, configured.reviews[0].executionOperationId);
  const transcript = await post(http.url, "capability_read", invoke("chat.session.messages", { id: input.sessionId }));
  assert.deepEqual(transcript.body.result.items.map(item => item.role), ["user", "assistant"]);
  const discovery = await post(http.url, "capability_read", invoke("chat.turn.list", { sessionId: input.sessionId }));
  assert.equal(discovery.body.result.items[0].id, input.id);

  const events = await turnEvents(http.url, input.id);
  assert(events.some(event => event.type === "tool-intent"));
  assert.deepEqual(events.filter(event => event.type === "approval").map(event => event.data.status), ["pending", "approved"]);
  const execution = events.find(event => event.type === "tool-complete").data.evidence;
  assert.equal(execution.operation, "knowledge.document.create");
  assert.equal(execution.operationId, events.find(event => event.type === "tool-intent").data.operationId);
  assert.equal(execution.executionId, events.find(event => event.type === "tool-complete").data.executionId);
  assert.equal(execution.resource, undefined, "Unrelated tool output cannot invent a Manager evidence link.");
  const document = await post(http.url, "capability_read", invoke("knowledge.document.get", { id: "native-chain-document" }));
  assert.equal(document.body.result.content, "Synthetic content.");
  assert.equal(document.body.result.title, "Synthetic chain");
  const foreign = await configured.core.dispatch("capability_read", invoke("chat.turn.get", { id: input.id }),
    { id: "native:other-actor", canWrite: true });
  assert.equal(foreign.error.code, "NOT_FOUND");

  await http.close();
  await f.closeRuntimeAndStorage();

  const retryCounter = join(tests, `.native-mcp-retry-${randomUUID()}`);
  f.addCleanup(() => rm(retryCounter, { force: true }));
  const mcp = await mcpClient(f, f.root, nativeActor.id, retryCounter);
  const retry = await mcp.call("capability_call", invoke("chat.turn.start", input));
  assert.deepEqual(retry.result, started.body.result);
  const afterRetry = await mcp.call("capability_read", invoke("chat.turn.get", { id: input.id }));
  assert.equal(afterRetry.result.status, "completed");
  const replayedEvents = await mcp.call("capability_read", invoke("chat.turn.events", { id: input.id, after: 0, limit: 100 }));
  assert.deepEqual(replayedEvents.result.events, events);
  await assert.rejects(readFile(retryCounter), { code: "ENOENT" });
  await mcp.close();

  const otherCounter = join(tests, `.native-mcp-other-${randomUUID()}`);
  f.addCleanup(() => rm(otherCounter, { force: true }));
  const other = await mcpClient(f, f.root, "native:other-actor", otherCounter);
  const isolated = await other.call("capability_read", invoke("chat.turn.get", { id: input.id }));
  assert.equal(isolated.error.code, "NOT_FOUND");
  await assert.rejects(readFile(otherCounter), { code: "ENOENT" });
  await other.close();
  await rm(retryCounter, { force: true });
  await rm(otherCounter, { force: true });
});

test("HTTP cancellation wins over a late native approval and prevents the tool effect", async t => {
  let finishDecision, enterReview;
  const reviewEntered = new Promise(resolve => { enterReview = resolve; });
  const decision = new Promise(resolve => { finishDecision = resolve; });
  let reviewed;
  const f = await workspace(t);
  const configured = await f.configure({
    reviewer: async request => {
      reviewed = request;
      enterReview();
      return decision;
    },
  });

  const http = await f.listen();
  const input = await sessionInput(http.url);
  const start = await post(http.url, "capability_call", invoke("chat.turn.start", input));
  assert.equal(start.status, 200, JSON.stringify(start.body));
  await reviewEntered;
  const pending = await post(http.url, "capability_read", invoke("chat.turn.get", { id: input.id }));
  assert.equal(pending.body.result.status, "approval");
  assert.equal(configured.runtime.services.chatTurns.activity().active, 1);
  const cancelled = await post(http.url, "capability_call", invoke("chat.turn.cancel", {
    id: input.id, expectedRevision: pending.body.result.revision, operationId: randomUUID(),
  }));
  assert.equal(cancelled.body.result.status, "cancelled");
  finishDecision({ actorId: reviewed.actorId, decisionId: randomUUID(), decision: "approve" });
  await tick();
  assert.equal((await terminalTurn(http.url, input.id)).status, "cancelled");
  assert.equal(configured.authorizations.length, 0);
  assert.equal(configured.provider.counts().modelCalls, 1);
  const absent = await post(http.url, "capability_read", invoke("knowledge.document.get", { id: "native-chain-document" }));
  assert.equal(absent.body.error.code, "NOT_FOUND");
});

test("public native Chat cannot omit session binding to bypass foreign or archived session admission", async t => {
  const f = await workspace(t);
  const configured = await f.configure();
  const http = await f.listen();
  const input = await sessionInput(http.url);
  const unbound = { ...input };
  delete unbound.expectedSessionRevision;
  for (const candidate of [unbound, { ...unbound, sessionBacked: false }, { ...unbound, mode: "raw" }]) {
    const response = await post(http.url, "capability_call", invoke("chat.turn.start", candidate));
    assert(response.body.error, JSON.stringify(response.body));
  }
  for (const candidate of [unbound, input]) {
    const response = await configured.core.dispatch("capability_call", invoke("chat.turn.start", candidate),
      { id: "native:foreign-caller", canWrite: true });
    assert.equal(response.error.code, "NOT_FOUND");
  }
  const archived = await post(http.url, "capability_call", invoke("chat.session.archive", {
    id: input.sessionId, expectedRevision: 1, operationId: randomUUID(),
  }));
  assert.equal(archived.body.result.revision, 2);
  for (const candidate of [unbound, { ...input, expectedSessionRevision: 2 }]) {
    const response = await post(http.url, "capability_call", invoke("chat.turn.start", candidate));
    assert.equal(response.body.error.code, "CONFLICT");
  }
  assert.equal(configured.provider.counts().modelCalls, 0);
  const transcript = await post(http.url, "capability_read", invoke("chat.session.messages", { id: input.sessionId }));
  assert.deepEqual(transcript.body.result.items, []);
});

for (const phase of ["provider", "tool"]) test(`cancelled native Chat blocks handoff until ignored-abort ${phase} retires`, async t => {
  let release, entered;
  const gate = new Promise(resolve => { release = resolve; });
  const ready = new Promise(resolve => { entered = resolve; });
  const f = await workspace(t);
  f.addCleanup(() => release());
  const configured = await f.configure(phase === "provider" ? { onOpen: async () => { entered(); await gate; } } : {});
  if (phase === "tool") {
    const dispatch = configured.core.dispatch.bind(configured.core);
    configured.core.dispatch = async (method, request, actor) => {
      if (method === "capability_call" && request?.operation === "knowledge.document.create") {
        entered(); await gate;
      }
      return dispatch(method, request, actor);
    };
  }
  const http = await f.listen();
  const input = await sessionInput(http.url);
  assert.equal((await post(http.url, "capability_call", invoke("chat.turn.start", input))).status, 200);
  await ready;
  const running = await post(http.url, "capability_read", invoke("chat.turn.get", { id: input.id }));
  const cancelled = await post(http.url, "capability_call", invoke("chat.turn.cancel", {
    id: input.id, operationId: randomUUID(), expectedRevision: running.body.result.revision,
  }));
  assert.equal(cancelled.body.result.status, "cancelled");
  await configured.runtime.services.chatTurns.settled(nativeActor.id, input.id);
  const before = await post(http.url, "capability_read", invoke("chat.session.messages", { id: input.sessionId }));
  assert.equal(before.body.result.items.at(-1).status, "cancelled");
  assert(configured.runtime.services.chatTurns.activity().active > 0);
  await assert.rejects(http.transport.quiesce(), error => error.code === "BUSY");
  release();
  for (let count = 0; configured.runtime.services.chatTurns.activity().active && count < 100; count++) await tick();
  assert.equal(configured.runtime.services.chatTurns.activity().active, 0);
  const after = await post(http.url, "capability_read", invoke("chat.session.messages", { id: input.sessionId }));
  assert.deepEqual(after.body.result, before.body.result, "Late work cannot overwrite a terminal transcript.");
  assert.equal(configured.provider.counts().modelCalls, 1);
  if (phase === "tool") {
    assert.equal(configured.runtime.services.chatTurns.activity().uncertain, 1);
    await assert.rejects(http.transport.quiesce(), error => error.code === "BUSY");
  } else await http.transport.quiesce();
});

test("two-client HTTP/MCP handoff refuses an actually running background Chat after start dispatch returns", async t => {
  let release, entered;
  const gate = new Promise(resolve => { release = resolve; });
  const ready = new Promise(resolve => { entered = resolve; });
  const f = await workspace(t);
  f.addCleanup(() => release());
  const configured = await f.configure({ onOpen: async (_request, count) => {
    if (count === 1) { entered(); await gate; }
  } });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const secondServer = await startMcp(configured.core, nativeActor, serverTransport);
  const secondClient = new Client({ name: "independent-chat-observer", version: "1.0.0" });
  await secondClient.connect(clientTransport);
  f.addCleanup(async () => { await secondClient.close(); await secondServer.close(); });
  const http = await f.listen();
  const input = await sessionInput(http.url);
  assert.equal((await post(http.url, "capability_call", invoke("chat.turn.start", input))).status, 200);
  await ready;
  const observed = await secondClient.callTool({ name: "capability_read",
    arguments: invoke("chat.turn.list", { sessionId: input.sessionId }) });
  assert.equal(observed.structuredContent.result.items[0].id, input.id);
  assert.equal(observed.structuredContent.result.items[0].status, "model");
  const conflicting = await secondClient.callTool({ name: "capability_call",
    arguments: invoke("chat.turn.start", chatTurnInput({ expectedSessionRevision: 2 })) });
  assert.equal(conflicting.structuredContent.error.code, "CONFLICT");
  assert.equal(configured.provider.counts().modelCalls, 1);
  assert.equal(configured.runtime.services.chatTurns.activity().active, 1);
  await assert.rejects(http.transport.quiesce(), error => error.code === "BUSY");
  assert.equal((await post(http.url, "capability_read", invoke("chat.turn.get", { id: input.id }))).status, 200,
    "failed handoff reopens admission rather than stranding the owner");
  release();
  await terminalTurn(http.url, input.id);
  await configured.runtime.services.chatTurns.settled(nativeActor.id, input.id);
  const terminal = await secondClient.callTool({ name: "capability_read",
    arguments: invoke("chat.turn.get", { id: input.id }) });
  assert.equal(terminal.structuredContent.result.status, "completed");
  await http.transport.quiesce();
  assert.equal(configured.runtime.services.chatTurns.activity().active, 0);
});

test("unknown tool outcome retains its receipt and does not replay after runtime restart", async t => {
  const f = await workspace(t);
  let configured = await f.configure({ documentId: "native-unknown-document" });
  const originalDispatch = configured.core.dispatch.bind(configured.core);
  configured.core.dispatch = async (method, request, actor) => {
    const result = await originalDispatch(method, request, actor);
    if (method === "capability_call" && request?.operation === "knowledge.document.create" && result.result) {
      throw new Error("Synthetic response loss after Core committed.");
    }
    return result;
  };
  let http = await f.listen();
  const input = await sessionInput(http.url);
  const started = await post(http.url, "capability_call", invoke("chat.turn.start", input));
  assert.equal(started.status, 200, JSON.stringify(started.body));
  const unknown = await terminalTurn(http.url, input.id);
  assert.equal(unknown.status, "unknown");
  assert.equal(unknown.uncertain, true);
  assert.equal(configured.provider.counts().modelCalls, 1);
  const events = await turnEvents(http.url, input.id);
  const toolEvent = events.find(event => event.type === "tool-intent");
  assert(toolEvent);
  const document = await post(http.url, "capability_read", invoke("knowledge.document.get", { id: "native-unknown-document" }));
  assert.equal(document.body.result.content, "Synthetic content.");
  const replay = await post(http.url, "capability_call", invoke("chat.turn.start", input));
  assert.deepEqual(replay.body.result, started.body.result);
  assert.equal(configured.provider.counts().modelCalls, 1);

  await http.close();
  await f.closeRuntimeAndStorage();
  const db = new DatabaseSync(join(f.root, "core.sqlite"));
  try {
    assert.equal(db.prepare("SELECT count(*) AS n FROM receipts WHERE operation_id=? AND actor_id=?")
      .get(toolEvent.data.operationId, nativeActor.id).n, 1);
  } finally { db.close(); }

  const storage = await Storage.open(f.root);
  configured = await f.replaceStorage(storage, { documentId: "native-unknown-document" });
  const restartedHttp = await f.listen(configured.core);
  const afterRestart = await post(restartedHttp.url, "capability_read", invoke("chat.turn.get", { id: input.id }));
  assert.equal(afterRestart.body.result.status, "unknown");
  const retry = await post(restartedHttp.url, "capability_call", invoke("chat.turn.start", input));
  assert.deepEqual(retry.body.result, started.body.result);
  assert.equal(configured.provider.counts().modelCalls, 0);
  const stillThere = await post(restartedHttp.url, "capability_read", invoke("knowledge.document.get", { id: "native-unknown-document" }));
  assert.equal(stillThere.body.result.content, "Synthetic content.");
});

test("default Core stays deny-by-default even when the explicit-memory authorizer is enabled", async t => {
  const f = await workspace(t);
  const core = new Core(f.storage, { authorizeMemoryDecision: async () => ({ decisionId: randomUUID(), actorId: nativeActor.id }) });
  const http = await f.listen(core);
  const catalog = await post(http.url, "capabilities_search", { query: "chat.turn.start" });
  assert.equal(catalog.body.result.total, 0);
  for (const operation of [
    "chat.turn.start", "agent.runtime.spawn", "retrieval.runtime.stage",
    "subscription.materialize.apply", "execution.approval.review",
  ]) {
    const described = await post(http.url, "capabilities_describe", { operation });
    assert.equal(described.body.error.code, "NOT_FOUND", operation);
  }
  const denied = await post(http.url, "capability_call", invoke("chat.turn.start", chatTurnInput()));
  assert(["NOT_AVAILABLE", "NOT_FOUND"].includes(denied.body.error.code), JSON.stringify(denied.body));
});

test("native Core applies folders and offline sync on one SQLite owner with safe cross-transport retries", async t => {
  const f = await workspace(t);
  let configured = await f.configure();
  const http = await f.listen();

  const created = await post(http.url, "capability_call", invoke("knowledge.document.create", {
    operationId: randomUUID(), id: "native-folder-document", area: "notes",
    path: "Archive/Team/moved.md", title: "Native folder move", content: "Synthetic folder content.",
  }));
  assert.equal(created.status, 200, JSON.stringify(created.body));

  const previewArgs = { area: "notes", path: "Archive/Team", destinationPath: "Current/Team" };
  const folderPreview = await post(http.url, "capability_read", invoke("knowledge.folder.lifecycle.preview", previewArgs));
  assert.equal(folderPreview.status, 200, JSON.stringify(folderPreview.body));
  const folderMoveArgs = {
    operationId: randomUUID(), ...previewArgs,
    expectedSourceSha256: folderPreview.body.result.sourceSha256,
    expectedScanRevision: folderPreview.body.result.scanRevision,
    expectedDestinationSha256: null,
  };
  const folderMove = await post(http.url, "capability_call", invoke("knowledge.folder.move", folderMoveArgs));
  assert.equal(folderMove.status, 200, JSON.stringify(folderMove.body));
  assert((await readFile(join(f.root, "notes/Current/Team/moved.md"), "utf8"))
    .includes("Synthetic folder content."));
  const movedDocument = await post(http.url, "capability_read", invoke("knowledge.document.get", { id: "native-folder-document" }));
  assert.equal(movedDocument.body.result.path, "Current/Team/moved.md");

  const availability = await post(http.url, "capability_read", invoke("retrieval.runtime.availability", {}));
  assert.equal(availability.body.result.available, false);
  const unavailableSearch = await post(http.url, "capability_read", invoke("retrieval.runtime.search", { query: "synthetic", limit: 1 }));
  assert(["NOT_FOUND", "NOT_AVAILABLE"].includes(unavailableSearch.body.error.code), JSON.stringify(unavailableSearch.body));

  const sessionId = randomUUID();
  const syncCreate = await post(http.url, "capability_call", invoke("sync.plan.create", {
    sessionId, operationId: randomUUID(), input: syncApplyFixtureInput,
  }));
  assert.equal(syncCreate.status, 200, JSON.stringify(syncCreate.body));
  const syncPreviewArgs = { sessionId, input: syncApplyFixtureInput };
  const syncPreview = await post(http.url, "capability_read", invoke("sync.apply.preview", syncPreviewArgs));
  assert.equal(syncPreview.status, 200, JSON.stringify(syncPreview.body));
  const syncApplyArgs = {
    operationId: randomUUID(), sessionId, input: syncApplyFixtureInput,
    expectedPlanHash: syncPreview.body.result.planHash,
  };

  const changedInput = structuredClone(syncApplyFixtureInput);
  const changedBytes = Buffer.from("different pinned source bytes");
  const changedFile = changedInput.remote.manifest.files[0];
  changedFile.contentBase64 = changedBytes.toString("base64");
  changedFile.digest = createHash("sha256").update(changedBytes).digest("hex");
  changedInput.remote.sha256 = syncPlanHash(changedInput.remote.manifest);
  const staleApply = await post(http.url, "capability_call", invoke("sync.apply", {
    ...syncApplyArgs, input: changedInput,
  }));
  assert.equal(staleApply.body.error.code, "CONFLICT", JSON.stringify(staleApply.body));
  await assert.rejects(readFile(join(f.root, "notes/offline-apply.md")), { code: "ENOENT" });

  const syncApply = await post(http.url, "capability_call", invoke("sync.apply", syncApplyArgs));
  assert.equal(syncApply.status, 200, JSON.stringify(syncApply.body));
  assert.deepEqual(await readFile(join(f.root, "notes/offline-apply.md")), syncApplyFixtureBytes);
  await http.close();
  await f.closeRuntimeAndStorage();

  const retryCounter = join(tests, `.native-data-mcp-retry-${randomUUID()}`);
  f.addCleanup(() => rm(retryCounter, { force: true }));
  const mcp = await mcpClient(f, f.root, nativeActor.id, retryCounter);
  assert.deepEqual(
    (await mcp.call("capability_call", invoke("knowledge.folder.move", folderMoveArgs))).result,
    folderMove.body.result,
  );
  assert.deepEqual(
    (await mcp.call("capability_call", invoke("sync.apply", syncApplyArgs))).result,
    syncApply.body.result,
  );
  await mcp.close();

  configured = await f.replaceStorage(await Storage.open(f.root, { deferRecovery: true }));
  const otherHttp = await f.listen(configured.core, { id: "native:other-actor", canWrite: true });
  const actorReplay = await post(otherHttp.url, "capability_call", invoke("sync.apply", syncApplyArgs));
  assert.equal(actorReplay.body.error.code, "CONFLICT", JSON.stringify(actorReplay.body));
  await otherHttp.close();
  await f.closeRuntimeAndStorage();

  const database = new DatabaseSync(join(f.root, "core.sqlite"));
  try {
    for (const [operationId, actorId, operation, result] of [
      [folderMoveArgs.operationId, nativeActor.id, "knowledge.folder.move", folderMove.body.result],
      [syncApplyArgs.operationId, nativeActor.id, "sync.apply", syncApply.body.result],
    ]) {
      const row = database.prepare("SELECT actor_id,operation,result FROM receipts WHERE operation_id=?").get(operationId);
      assert.deepEqual(Object.fromEntries(Object.entries(row)), {
        actor_id: actorId, operation, result: JSON.stringify(result),
      });
      assert.equal(database.prepare("SELECT count(*) AS count FROM receipts WHERE operation_id=?").get(operationId).count, 1);
    }
    assert.equal(database.prepare("SELECT path FROM documents WHERE id=?").get("native-folder-document").path, "Current/Team/moved.md");
  } finally { database.close(); }
});

test("native startup recovers a prepared folder intent and preserves unknown source bytes", async t => {
  for (const fault of ["prepared", "unknown-bytes"]) {
    await t.test(fault, async t => {
      const f = await workspace(t);
      await f.configure();
      const http = await f.listen();
      const created = await post(http.url, "capability_call", invoke("knowledge.document.create", {
        operationId: randomUUID(), id: `recovery-${fault}`, area: "notes",
        path: "Archive/Team/recovery.md", title: "Recovery fixture", content: "Original bytes.",
      }));
      assert.equal(created.status, 200, JSON.stringify(created.body));
      const previewArgs = { area: "notes", path: "Archive/Team", destinationPath: "Current/Team" };
      const preview = await post(http.url, "capability_read", invoke("knowledge.folder.lifecycle.preview", previewArgs));
      assert.equal(preview.status, 200, JSON.stringify(preview.body));
      const args = {
        operationId: randomUUID(), ...previewArgs,
        expectedSourceSha256: preview.body.result.sourceSha256,
        expectedScanRevision: preview.body.result.scanRevision,
        expectedDestinationSha256: null,
      };
      await http.close();
      await f.closeRuntimeAndStorage();
      const expected = await seedFolderIntent(f.root, nativeActor.id, args);

      const sourcePath = join(f.root, "notes/Archive/Team/recovery.md");
      const externalBytes = Buffer.from("external writer changed this source");
      if (fault === "unknown-bytes") await writeFile(sourcePath, externalBytes);
      const storage = await Storage.open(f.root, { deferRecovery: true });

      if (fault === "unknown-bytes") {
        await assert.rejects(openNativeRuntime(storage), /recovery|source|bytes|intent/i);
        await storage.close();
        assert.deepEqual(await readFile(sourcePath), externalBytes);
        await assert.rejects(readFile(join(f.root, "notes/Current/Team/recovery.md")), { code: "ENOENT" });
        const database = new DatabaseSync(join(f.root, "core.sqlite"));
        try {
          assert.equal(database.prepare("SELECT count(*) AS count FROM data_runtime_intents WHERE operation_id=?")
            .get(args.operationId).count, 1);
          assert.equal(database.prepare("SELECT count(*) AS count FROM receipts WHERE operation_id=?")
            .get(args.operationId).count, 0);
        } finally { database.close(); }
        return;
      }

      const configured = await f.replaceStorage(storage);
      const recoveredHttp = await f.listen(configured.core);
      const recovered = await post(recoveredHttp.url, "capability_read", invoke("knowledge.document.get", {
        id: `recovery-${fault}`,
      }));
      assert.equal(recovered.body.result.path, "Current/Team/recovery.md");
      assert.deepEqual(await readFile(join(f.root, "notes/Current/Team/recovery.md"), "utf8")
        .then(text => text.includes("Original bytes.")), true);
      const replay = await post(recoveredHttp.url, "capability_call", invoke("knowledge.folder.move", args));
      assert.deepEqual(replay.body.result, expected.plan.result);
      await recoveredHttp.close();
      await f.closeRuntimeAndStorage();
      const database = new DatabaseSync(join(f.root, "core.sqlite"));
      try {
        assert.equal(database.prepare("SELECT count(*) AS count FROM data_runtime_intents WHERE operation_id=?")
          .get(args.operationId).count, 0);
        assert.equal(database.prepare("SELECT count(*) AS count FROM receipts WHERE operation_id=?")
          .get(args.operationId).count, 1);
      } finally { database.close(); }
    });
  }
});

test("native startup recovers exact Note folder-pin sidecar bytes after folder rename", async t => {
  const f = await workspace(t);
  await f.configure();
  const http = await f.listen();
  const created = await post(http.url, "capability_call", invoke("knowledge.document.create", {
    operationId: randomUUID(), id: "pinned-folder-note", area: "notes",
    path: "Archive/Team/pinned.md", title: "Pinned note", content: "Body.",
  }));
  assert.equal(created.status, 200, JSON.stringify(created.body));
  const sidecar = join(f.root, "notes", ".pk-meta.json");
  const before = Buffer.from('{"pinnedFolders":["Archive","Archive/Team"]}\n');
  const after = Buffer.from(`${JSON.stringify({ pinnedFolders: ["Current", "Current/Team"] }, null, 2)}\n`);
  await writeFile(sidecar, before);
  const previewArgs = { area: "notes", path: "Archive", destinationPath: "Current" };
  const preview = await post(http.url, "capability_read", invoke("knowledge.folder.lifecycle.preview", previewArgs));
  assert.equal(preview.status, 200, JSON.stringify(preview.body));
  const args = {
    operationId: randomUUID(), ...previewArgs,
    expectedSourceSha256: preview.body.result.sourceSha256,
    expectedScanRevision: preview.body.result.scanRevision,
    expectedDestinationSha256: null,
  };
  await http.close();
  await f.closeRuntimeAndStorage();
  const expected = await seedFolderIntent(f.root, nativeActor.id, args);

  await rename(join(f.root, "notes", "Archive"), join(f.root, "notes", "Current"));
  const storage = await Storage.open(f.root, { deferRecovery: true });
  const configured = await f.replaceStorage(storage);
  const recoveredHttp = await f.listen(configured.core);
  assert.deepEqual(await readFile(sidecar), after);
  const replay = await post(recoveredHttp.url, "capability_call", invoke("knowledge.folder.move", args));
  assert.deepEqual(replay.body.result, expected.plan.result);
  await recoveredHttp.close();
  await f.closeRuntimeAndStorage();
  const database = new DatabaseSync(join(f.root, "core.sqlite"));
  try {
    assert.equal(database.prepare("SELECT count(*) AS count FROM data_runtime_intents WHERE operation_id=?")
      .get(args.operationId).count, 0);
    assert.equal(database.prepare("SELECT count(*) AS count FROM receipts WHERE operation_id=?")
      .get(args.operationId).count, 1);
  } finally { database.close(); }
});
