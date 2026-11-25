import assert from "node:assert/strict";
import { createServer } from "node:http";
import { randomUUID } from "node:crypto";
import { chmod, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import childProcess from "node:child_process";
import { syncBuiltinESMExports } from "node:module";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { initialize } from "../dist/storage.js";
import { startStandaloneHost } from "../dist/standalone-host.js";
import { attachAdoptedRootReadOnlyMcp } from "../dist/adopted-root-mcp.js";
import { startLegacyNoteMcp } from "../dist/legacy-note-mcp.js";
import { chatTurnInput } from "./chat-turn-fixtures.mjs";
import { startHttp } from "../dist/http.js";

const testsDirectory = dirname(fileURLToPath(import.meta.url));
const actor = { id: "synthetic-host-actor", canWrite: true };
const invoke = (operation, args) => ({ operation, version: 1, arguments: args });
const tick = () => new Promise(resolve => setTimeout(resolve, 10));

async function eventually(read, predicate, message) {
  for (let count = 0; count < 500; count++) {
    const value = await read();
    if (predicate(value)) return value;
    await tick();
  }
  throw new Error(message);
}

async function fixture(t) {
  const root = join(testsDirectory, `.standalone-host-${randomUUID()}`);
  const workspace = join(root, "workspace");
  const configDirectory = join(root, "config");
  const configPath = join(configDirectory, "host.json");
  const hosts = [];
  await mkdir(configDirectory, { recursive: true, mode: 0o700 });
  await initialize(workspace);
  const serverRequests = [];
  let responseNumber = 0;
  const server = createServer(async (request, response) => {
    let text = "";
    for await (const chunk of request) text += chunk;
    const payload = JSON.parse(text);
    serverRequests.push({ url: request.url, headers: request.headers, payload });
    if (request.url === "/redirect-target") {
      response.writeHead(500);
      response.end();
      return;
    }

    if (payload.messages.at(-1)?.content === "Do not follow a redirect.") {
      response.writeHead(302, { location: `http://127.0.0.1:${server.address().port}/redirect-target` });
      response.end();
      return;
    }
    if (payload.messages.at(-1)?.content === "Cancel this provider response.") {
      response.writeHead(200, { "content-type": "text/event-stream" });
      return;
    }
    const toolResponse = payload.messages.at(-1)?.role === "tool";
    const delta = toolResponse ? { content: "Synthetic answer." } : {
      tool_calls: [{ index: 0, id: `local-call-${++responseNumber}`, type: "function", function: {
        name: "knowledge_document_create",
        arguments: JSON.stringify({ id: "standalone-host-document", title: "Synthetic", content: "Local output." }),
      } }],
    };
    const body = `data: ${JSON.stringify({ choices: [{ index: 0, delta, finish_reason: null }] })}\n\n`
      + `data: ${JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: toolResponse ? "stop" : "tool_calls" }] })}\n\n`
      + "data: [DONE]\n\n";
    response.writeHead(200, { "content-type": "text/event-stream" });
    response.end(body);
  });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  const endpoint = `http://127.0.0.1:${address.port}/v1`;
  const config = {
    schema: "pkm.native-host-config/v1",
    provider: "openai-compatible",
    endpoint,
    secretRef: "secret:synthetic/local-provider",
    model: "synthetic-model",
    contextWindow: 16384,
    maxOutputTokens: 4096,
    outputTokenParameter: "max_tokens",
    includeUsage: true,
    tools: ["knowledge.document.create"],
  };
  await writeFile(configPath, JSON.stringify(config), { mode: 0o600 });
  const identity = JSON.parse(await readFile(join(workspace, ".pkm-next-workspace"), "utf8"));
  const secret = "synthetic-local-provider-secret-never-persist";
  const resolutions = [];
  const optionsFor = extra => ({
    dataPath: workspace,
    configPath,
    policy: {
      authorizedConfigPath: configPath,
      allowedProviders: ["openai-compatible"],
      allowedEndpoints: [endpoint],
      allowedModels: ["synthetic-model"],
      allowedTools: ["knowledge.document.create"],
      allowInsecureLoopback: true,
    },
    async resolveSecret(reference) {
      resolutions.push(reference);
      return secret;
    },
    authenticateHuman(evidence) {
      if (evidence !== "local-human-session") return null;
      return { actorId: actor.id, workspaceId: identity.id, readOnly: false, authorities: ["approval"] };
    },
    ...extra,
  });
  t.after(async () => {
    await Promise.all(hosts.map(async host => { try { await host.close(); } catch { /* Continue fixture cleanup. */ } }));
    await new Promise(resolve => server.close(resolve));
    await rm(root, { recursive: true, force: true });
  });
  return { root, workspace, configDirectory, configPath, endpoint, secret, config,
    resolutions, serverRequests, optionsFor, hosts };
}

async function start(f, extra) {
  const host = await startStandaloneHost(f.optionsFor(extra));
  f.hosts.push(host);
  return host;
}

async function readPrivateWorkerNote(client) {
  const result = await client.callTool({ name: "legacy_knowledge_read",
    arguments: { tool: "get_note", arguments: { slug: "Worker" } } });
  assert.notEqual(result.isError, true, JSON.stringify(result));
  assert.equal(result.structuredContent?.value?.content, "Actual private worker Note.\n");
}

test("real MCP owner children close before shared Storage without stopping a peer attachment", { timeout: 60_000 }, async t => {
  const f = await fixture(t);
  await writeFile(join(f.workspace, "notes", "Worker.md"), "---\ndocumentId: worker\ntitle: Worker\n---\nActual private worker Note.\n",
    { mode: 0o600 });
  const host = await start(f), owner = host.ownerResourceContext();
  const children = [], failures = [], originalSpawn = childProcess.spawn;
  childProcess.spawn = (...args) => {
    const child = originalSpawn(...args);
    if (args[1]?.includes("--persistent")) children.push(child);
    return child;
  };
  syncBuiltinESMExports();
  t.after(() => { childProcess.spawn = originalSpawn; syncBuiltinESMExports(); });
  const attach = async name => {
    const [clientTransport, transport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name, version: "1.0.0" });
    const attachment = await attachAdoptedRootReadOnlyMcp({
      owner, transport, connection: new AbortController().signal,
      assertMcpAuthority() { owner.assertCurrent(); },
      closeConnection: () => client.close(),
      onCloseError: error => failures.push(error),
    });
    await client.connect(clientTransport);
    assert.notEqual((await client.callTool({ name: "list_notes", arguments: {} })).isError, true);
    await readPrivateWorkerNote(client);
    return { client, attachment };
  };
  const first = await attach("first-owner-connection"), second = await attach("peer-owner-connection");
  assert.equal(children.length, 2);
  const [ownPid, peerPid] = children.map(child => child.pid);
  assert(Number.isInteger(ownPid) && Number.isInteger(peerPid));
  process.kill(ownPid, 0); process.kill(peerPid, 0);
  await first.attachment.close();
  assert.throws(() => process.kill(ownPid, 0), /ESRCH/);
  owner.storage.assertWorkspaceLease();
  process.kill(peerPid, 0);
  assert.notEqual((await second.client.callTool({ name: "list_notes", arguments: {} })).isError, true);
  await readPrivateWorkerNote(second.client);
  await host.close();
  assert.throws(() => process.kill(peerPid, 0), /ESRCH/);
  assert.throws(() => owner.storage.assertWorkspaceLease());
  assert.deepEqual(failures, []);
});

test("MCP server close reports abnormal termination of its actual private worker", { timeout: 60_000 }, async t => {
  const f = await fixture(t);
  await writeFile(join(f.workspace, "notes", "Worker.md"), "---\ndocumentId: worker\ntitle: Worker\n---\nActual private worker Note.\n",
    { mode: 0o600 });
  const host = await start(f), owner = host.ownerResourceContext();
  const children = [], originalSpawn = childProcess.spawn;
  childProcess.spawn = (...args) => {
    const child = originalSpawn(...args);
    if (args[1]?.includes("--persistent")) children.push(child);
    return child;
  };
  syncBuiltinESMExports();
  t.after(() => { childProcess.spawn = originalSpawn; syncBuiltinESMExports(); });
  const [clientTransport, transport] = InMemoryTransport.createLinkedPair();
  const server = await startLegacyNoteMcp(owner.storage, transport, {
    core: owner.core, actor: { id: "local:owner", canRead: true, canWrite: false },
  });
  const client = new Client({ name: "failed-owned-worker", version: "1.0.0" });
  await client.connect(clientTransport);
  await readPrivateWorkerNote(client);
  assert.equal(children.length, 1);
  const worker = children[0], pid = worker.pid;
  const exited = new Promise(resolve => worker.once("close", resolve));
  assert.equal(worker.kill("SIGKILL"), true);
  await exited;
  await assert.rejects(server.close(), /shutdown is unconfirmed/);
  assert.throws(() => process.kill(pid, 0), /ESRCH/);
  await client.close();
  owner.storage.assertWorkspaceLease();
  await host.close();
});

async function createTurnSession(host, input) {
  input.sessionId = randomUUID();
  input.expectedSessionRevision = 1;
  const created = await host.core.dispatch("capability_call", invoke("chat.session.create", {
    id: input.sessionId, title: "Standalone Chat", operationId: randomUUID(), expectedRevision: 0,
  }), actor);
  assert.equal(created.result.id, input.sessionId);
}

async function turn(host, input) {
  await createTurnSession(host, input);
  const started = await host.core.dispatch("capability_call", invoke("chat.turn.start", input), actor);
  assert.equal(started.result.id, input.id);
  return eventually(
    () => host.core.dispatch("capability_read", invoke("chat.turn.get", { id: input.id }), actor).then(value => value.result),
    value => ["completed", "failed", "cancelled", "unknown"].includes(value.status),
    "Chat turn did not reach a terminal state.",
  );
}

async function decideReview(host, capability, decision) {
  const entry = await eventually(
    () => Promise.resolve(host.humanReview.handlers.read(capability, {}).entries),
    entries => entries.length === 1,
    "Expected one pending local human review.",
  ).then(entries => entries[0]);
  return host.humanReview.handlers.decide(capability, {
    id: entry.id, expectedRevision: entry.revision, intentDigest: entry.intentDigest, decision,
  });
}

test("selected owner requires a synchronous live selection and revokes on host close", async t => {
  const env = await fixture(t);
  const host = await start(env);
  let selected = true;
  const selection = { workspaceId: host.workspaceId, actorId: "local:owner", assertCurrent() {
    if (!selected) throw new Error("Selection revoked.");
  } };
  assert.throws(() => host.selectedOwnerContext({ ...selection, workspaceId: "other" }), /unavailable/);
  assert.throws(() => host.selectedOwnerContext({ ...selection, assertCurrent: async () => {} }), /synchronous/);
  assert.throws(() => host.selectedOwnerContext({ ...selection, assertCurrent: () => false }), /return undefined/);
  const owner = host.selectedOwnerContext(selection);
  owner.assertCurrent();
  selected = false;
  assert.throws(() => owner.assertCurrent(), /Selection revoked/);
  assert.throws(() => owner.registerChildClose(async () => {}), /Selection revoked/);
  selected = true;
  const closing = host.close();
  assert.throws(() => owner.assertCurrent(), /unavailable/);
  await closing;
});

test("selected owner closes children before releasing the Storage lease", async t => {
  const env = await fixture(t);
  const host = await start(env);
  const owner = host.selectedOwnerContext({ workspaceId: host.workspaceId, actorId: "local:owner", assertCurrent() {} });
  let release;
  const pending = new Promise(resolve => { release = resolve; });
  let started = false, finished = false;
  owner.registerChildClose(async () => {
    started = true;
    await pending;
    owner.storage.assertWorkspaceLease();
    finished = true;
  });
  const closing = host.close();
  await eventually(() => started, Boolean, "Child shutdown did not start.");
  assert.throws(() => owner.assertCurrent(), /unavailable/);
  owner.storage.assertWorkspaceLease();
  release();
  await closing;
  assert.equal(finished, true);
  assert.throws(() => owner.storage.assertWorkspaceLease());
});

test("failed child drain retains Storage and allows a closed-admission retry", async t => {
  const env = await fixture(t);
  const host = await start(env);
  const owner = host.selectedOwnerContext({ workspaceId: host.workspaceId, actorId: "local:owner", assertCurrent() {} });
  let fail = true, attempts = 0, completed = 0;
  owner.registerChildClose(async () => { completed++; });
  const unregister = owner.registerChildClose(async () => {
    attempts++;
    if (fail) { unregister(); throw new Error("Still running."); }
  });
  await assert.rejects(host.close(), /child operations did not drain/);
  owner.storage.assertWorkspaceLease();
  assert.throws(() => owner.assertCurrent(), /unavailable/);
  fail = false;
  await host.close();
  assert.equal(attempts, 2);
  assert.equal(completed, 1);
});

test("standalone production composition keeps the selected root, requires exact host gate approval and resumes only a waiting gate", async t => {
  const env = await fixture(t);
  const chatId = randomUUID(), namespace = "a".repeat(16);
  const policy = { actorId: actor.id, namespace, chatId, sourceFingerprint: "f".repeat(64),
    authorize: async binding => binding.actorId === actor.id && binding.namespace === namespace && binding.chatId === chatId,
    externalReports: { id: "standalone-isolated-gate", authorizationDigest: "c".repeat(64), humanGates: true,
      authorizeDefinition: binding => binding.actorId === actor.id && binding.source?.kind === "recipe" },
  };
  let host = await startStandaloneHost(env.optionsFor({ legacyRecipes: policy }));
  env.hosts.push(host);
  assert.equal(host.recipeHost.binding.root, env.workspace);
  const { binding, recipes } = host.recipeHost;
  const state = await recipes.state(binding), recipeId = `recipe_${randomUUID()}`;
  await recipes.saveLibrary(binding, { namespace, chatId, operationId: randomUUID(), recipeId, expectedRevision: 0,
    expectedDigest: state.digest, fields: {
      name: "Synthetic standalone human gate", description: "Isolated fixture, not the original publishing Recipe.",
      definition: { schema: "pkm.workflow.definition/v1", spec: { inputs: {}, outputs: {},
        nodes: [{ nodeId: "gate", kind: "pkm.gate.human/v1", dependsOn: [],
          config: { inputKind: "approval", prompt: "Approve synthetic operation?" } }],
        completion: { requiredNodes: ["gate"] } } },
    } });
  const protocolActor = { ...actor, recipeProtocol: true };
  async function lifecycle(name, args) {
    const operation = `mcp.tool.recipe_run_${name}`, api = host.recipeHost.publicApi;
    const preview = await api.previewLazy(host.recipeHost.binding, { operation, args });
    await api.approveLazy(host.recipeHost.binding, { operation, args, previewDigest: preview.previewDigest });
    const response = await host.core.dispatch("capability_call", invoke(operation, args), protocolActor);
    assert(!response.error, JSON.stringify(response));
    assert.equal(response.result.ok, true, JSON.stringify(response));
    return response.result;
  }
  const started = await lifecycle("start", { recipe_id: recipeId, command_id: "standalone-human-start" });
  const waiting = await lifecycle("next", { run_id: started.run_id, command_id: "standalone-human-next" });
  assert.equal(waiting.next_action.kind, "request_user_input");
  await host.close();
  host = await startStandaloneHost(env.optionsFor({ legacyRecipes: policy }));
  env.hosts.push(host);
  const resumed = await lifecycle("get", { run_id: started.run_id, detail: "full" });
  assert.equal(resumed.next_action.challenge_id, waiting.next_action.challenge_id);
  const submit = { run_id: started.run_id, node_id: "gate", command_id: "standalone-human-reject",
    challenge_id: resumed.next_action.challenge_id, response_json: '{"approved":false}', detail: "full" };
  const token = randomUUID(), http = await startHttp(host.core, token, protocolActor, 0);
  try {
    const request = () => fetch(`${http.url}/v1/capability_call`, { method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify(invoke("mcp.tool.recipe_run_submit_input", submit)) });
    assert.equal((await request()).status, 403);
    const preview = await host.recipeHost.publicApi.previewLazy(host.recipeHost.binding,
      { operation: "mcp.tool.recipe_run_submit_input", args: submit });
    await host.recipeHost.publicApi.approveLazy(host.recipeHost.binding,
      { operation: preview.operation, args: preview.args, previewDigest: preview.previewDigest });
    const result = await (await request()).json();
    assert(!result.error, JSON.stringify(result));
    assert.equal(result.result.status, "completed");
    assert.equal(result.result.current_result.completed_nodes[0].outcome, "rejected");
    assert.equal((await request()).status, 403);
  } finally {
    http.server.closeAllConnections();
    await new Promise(resolve => http.server.close(resolve));
  }
  assert.equal(env.serverRequests.length, 0);
});

test("standalone host requires the exact owner-only config path and never exposes path errors", async t => {
  const f = await fixture(t);
  const wrongPath = join(f.configDirectory, "other.json");
  await writeFile(wrongPath, "{}", { mode: 0o600 });
  await assert.rejects(startStandaloneHost(f.optionsFor({ configPath: wrongPath })), {
    message: "Standalone host configuration is unavailable.",
  });
  await chmod(f.configPath, 0o644);
  await assert.rejects(start(f), { message: "Standalone host configuration is unavailable." });
  await chmod(f.configPath, 0o600);
  const linkPath = join(f.configDirectory, "linked.json");
  await symlink(f.configPath, linkPath);
  await assert.rejects(startStandaloneHost(f.optionsFor({
    configPath: linkPath,
    policy: { ...f.optionsFor().policy, authorizedConfigPath: linkPath },
  })), { message: "Standalone host configuration is unavailable." });
  assert.deepEqual(f.resolutions, []);
  assert.equal(f.serverRequests.length, 0);
});

test("standalone configured host uses only a local SSE provider, human approval and durable non-replay", async t => {
  const f = await fixture(t);
  let host = await start(f);
  assert.deepEqual(host.readiness, { ready: true, transport: "native", chatAvailable: true });
  assert(!JSON.stringify(host.readiness).includes(f.endpoint));
  assert.deepEqual(f.resolutions, []);
  const capability = await host.humanReview.openSession("local-human-session");

  const deniedInput = chatTurnInput({ messages: [{ role: "user", content: "Please create a document, but deny it." }] });
  const denied = await (async () => {
    const pending = turn(host, deniedInput);
    await decideReview(host, capability, "reject");
    return pending;
  })();
  assert.equal(denied.status, "failed");
  assert.equal(denied.failure, "APPROVAL_DENIED");

  const approvedInput = chatTurnInput({ messages: [{ role: "user", content: "Create a synthetic document, then summarize." }] });
  const approved = await (async () => {
    const pending = turn(host, approvedInput);
    await decideReview(host, capability, "approve");
    return pending;
  })();
  assert.equal(approved.status, "completed", JSON.stringify(approved));
  assert.equal(approved.output, "Synthetic answer.");
  assert.equal(f.serverRequests.length, 3);
  assert(f.serverRequests.every(item => item.headers.host.startsWith("127.0.0.1:")));
  assert(f.serverRequests.every(item => item.headers.authorization?.includes(f.secret)));
  assert(f.resolutions.length >= f.serverRequests.length);
  assert(f.resolutions.every(reference => reference === "secret:synthetic/local-provider"));

  const cancelInput = chatTurnInput({
    messages: [{ role: "user", content: "Cancel this provider response." }],
    deadlineMs: 10000,
  });
  await createTurnSession(host, cancelInput);
  const started = await host.core.dispatch("capability_call", invoke("chat.turn.start", cancelInput), actor);
  assert.equal(started.result.id, cancelInput.id);
  const inFlight = await eventually(
    () => host.core.dispatch("capability_read", invoke("chat.turn.get", { id: cancelInput.id }), actor).then(value => value.result),
    value => value.status === "model",
    "Cancelled turn never entered its model request.",
  );
  await eventually(() => Promise.resolve(f.serverRequests.length), count => count === 4,
    "Cancelled turn never opened its local provider request.");
  assert.equal(f.serverRequests.length, 4);
  const cancelled = await host.core.dispatch("capability_call", invoke("chat.turn.cancel", {
    id: cancelInput.id, expectedRevision: inFlight.revision, operationId: randomUUID(),
  }), actor);
  assert.equal(cancelled.result.status, "cancelled");
  await eventually(
    () => host.core.dispatch("capability_read", invoke("chat.turn.get", { id: cancelInput.id }), actor).then(value => value.result),
    value => value.status === "cancelled",
    "Cancellation was not persisted.",
  );

  const redirectInput = chatTurnInput({ messages: [{ role: "user", content: "Do not follow a redirect." }] });
  const redirected = await turn(host, redirectInput);
  assert.equal(redirected.status, "failed");
  assert.equal(f.serverRequests.length, 5);
  assert(f.serverRequests.every(item => item.url !== "/redirect-target"));

  const replay = await host.core.dispatch("capability_call", invoke("chat.turn.start", approvedInput), actor);
  assert.equal(replay.result.id, approvedInput.id);
  assert.equal(f.serverRequests.length, 5);

  await host.close();
  host.humanReview.closeSession(capability);
  host = await start(f);
  assert.equal(host.readiness.chatAvailable, true);
  const persisted = await host.core.dispatch("capability_read", invoke("chat.turn.get", { id: approvedInput.id }), actor);
  assert.equal(persisted.result.status, "completed");
  assert.equal(f.serverRequests.length, 5);
  await host.close();

  const database = await readFile(join(f.workspace, "core.sqlite"));
  assert.equal(database.includes(Buffer.from(f.secret)), false);
  assert.equal(database.includes(Buffer.from(f.config.secretRef)), false);
});
