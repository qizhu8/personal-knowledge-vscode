import assert from "node:assert/strict";
import { test } from "node:test";
import { createRequire } from "node:module";
import { randomUUID, createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync, rmSync, cpSync, lstatSync, chmodSync, readdirSync, realpathSync } from "node:fs";
import { resolve, join, relative, dirname } from "node:path";
import { inspectLegacyApiChatArchive } from "../dist/legacy-api-chat-archive.js";
import { prepareLegacyRootAdoptionExperimental, resumeLegacyRootAdoptionExperimental } from "../dist/legacy-root-adoption.js";
import { createNativeRuntime } from "../dist/native-runtime.js";
import { LegacyApiChatRuntime } from "../dist/legacy-api-chat-runtime.js";
import { LegacyManagedApiChatRuntime } from "../dist/legacy-api-chat-managed-runtime.js";
import { createLegacyManagedChatLocalModel } from "../dist/legacy-api-chat-managed-provider.js";
import { createServer } from "node:http";
import { fork } from "node:child_process";
import { once } from "node:events";
import { startLegacyApiChatUiHost } from "../dist/legacy-api-chat-ui-host.js";
const require = createRequire(import.meta.url), project = resolve(new URL("../legacy", import.meta.url).pathname);
const fixture = require("../legacy/tests/next-trial-electron/api-chat-fixture.cjs");
const { ApiChatStore } = require("../legacy/dist/chat/api-chat-store.js");
const { WorkerTreeStore } = require("../legacy/dist/chat/worker-tree.js");
const hash = bytes => createHash("sha256").update(bytes).digest("hex");

function setup(t) {
  const directory = join(project, ".migration-test-work", `managed-api-${randomUUID()}`), root = join(directory, "knowledge");
  mkdirSync(root, { recursive: true, mode: 0o700 });
  let descriptor, store, chat;
  const mask = process.umask(0o077);
  try {
    descriptor = fixture.create({ extension: project, root });
    store = new ApiChatStore(descriptor.state, fixture.namespace);
    chat = store.load(descriptor.inline, false);
    store.startTask(chat, "Original source Task");
    const treeId = new WorkerTreeStore(join(descriptor.state, "api-chat-worker-trees")).create(chat.id);
    const environment = { schema: "pkm.chat.execution/v1", hostId: randomUUID(), targetId: "a".repeat(64),
      accountId: "b".repeat(64), knowledgeRoot: root, workspaceUris: [], workspacePaths: [], cwd: null, trusted: true };
    const executionContext = { ...environment, permissionMode: "allow-all",
      contextId: hash(JSON.stringify(environment)), digest: hash(JSON.stringify({ ...environment, permissionMode: "allow-all" })) };
    chat.workerState = { treeId, sleeping: false, stopped: false, events: [],
      executionContext };
    store.save(chat);
  } finally { process.umask(mask); }
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  return { directory, root, descriptor, store, chat };
}

test("control-only legacy state is pinned as inert evidence without inventing a Chat owner", t => {
  const directory = join(project, ".migration-test-work", `managed-control-only-${randomUUID()}`);
  const root = join(directory, "knowledge"), state = join(root, ".pkm/state");
  const hostId = randomUUID(), requestId = hash("unresolved original request");
  const control = join(state, "api-chat-control");
  mkdirSync(join(control, "hosts"), { recursive: true, mode: 0o700 });
  mkdirSync(join(control, "requests", hostId), { recursive: true, mode: 0o700 });
  const host = join(control, "hosts", `${hostId}.json`);
  const request = join(control, "requests", hostId, `${requestId}.json`);
  writeFileSync(host, JSON.stringify({ schema: "pkm.api-chat.host/v1", hostId, pid: 123,
    updatedAt: Date.now(), operations: ["send"], portalRequestDirectory: "/historical-only" }), { mode: 0o600 });
  writeFileSync(request, JSON.stringify({ schema: "pkm.api-chat.request/v1", hostId, requestId,
    status: "running", operation: "send", arguments: { id: randomUUID() } }), { mode: 0o600 });
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const before = readFileSync(request);
  const archive = inspectLegacyApiChatArchive(root);
  assert.deepEqual(archive.chats, []);
  assert.equal(archive.managed.authority, "archive_only");
  assert.deepEqual(archive.managed.uncertainControls, [requestId]);
  assert(archive.files.some(file => file.path.endsWith(`${requestId}.json`)));
  assert.deepEqual(readFileSync(request), before);

  mkdirSync(join(state, "agent-groups"), { mode: 0o700 });
  assert.throws(() => inspectLegacyApiChatArchive(root), { code: "LEGACY_API_CHAT_BLOCKED" });
  rmSync(join(state, "agent-groups"), { recursive: true });
  writeFileSync(join(control, "unknown"), "unrecognized", { mode: 0o600 });
  assert.throws(() => inspectLegacyApiChatArchive(root), { code: "LEGACY_API_CHAT_BLOCKED" });
});

test("managed receipt pins genuine legacy Task/empty-tree writer output without inheriting its old authority", t => {
  const f = setup(t), before = inspectLegacyApiChatArchive(f.root);
  assert.equal(before.managed.authority, "archive_only");
  assert.equal(before.managed.sessions[0].sessionId, f.chat.sessionId);
  assert.equal(before.managed.trees[0].id, f.chat.workerState.treeId);
  assert.equal(before.managed.trees[0].approvedQuota, undefined, "The original empty tree legitimately has no quota.");
  assert.deepEqual(before.managed.uncertainChats, []);
  assert(before.files.some(file => file.path === `.pkm/state/agent-sessions/${f.chat.sessionId}.json`));
  const sessionFile = join(f.descriptor.state, "agent-sessions", `${f.chat.sessionId}.json`);
  const session = JSON.parse(readFileSync(sessionFile));
  session.nativeChat.id = randomUUID();
  writeFileSync(sessionFile, JSON.stringify(session));
  assert.throws(() => inspectLegacyApiChatArchive(f.root), error => error.code === "LEGACY_API_CHAT_BLOCKED");
});

test("streaming legacy Task and queued/running controls stay explicitly uncertain and inert", t => {
  const f = setup(t);
  f.chat.messages.push({ id: randomUUID(), role: "assistant", content: "Incomplete original response.", status: "streaming",
    toolCalls: [{ id: "original-unacknowledged-read", name: "read_file", arguments: '{"path":"fixture.txt"}', status: "running" }] });
  const mask = process.umask(0o077);
  try { f.store.save(f.chat); } finally { process.umask(mask); }
  const control = join(f.descriptor.state, "api-chat-control"), hostId = randomUUID(), requestId = hash("synthetic original control request");
  mkdirSync(join(control, "hosts"), { recursive: true, mode: 0o700 });
  mkdirSync(join(control, "requests", hostId), { recursive: true, mode: 0o700 });
  writeFileSync(join(control, "requests", hostId, `${requestId}.json`), JSON.stringify({
    schema: "pkm.api-chat.request/v1", hostId, requestId, status: "running", operation: "send",
    arguments: { id: f.chat.id, text: "Unknown original request." }, expiresAt: Date.now() + 10000,
  }), { mode: 0o600 });
  const archive = inspectLegacyApiChatArchive(f.root);
  assert.deepEqual(archive.managed.uncertainChats, [f.chat.id]);
  assert.deepEqual(archive.managed.uncertainControls, [requestId]);
  assert.equal(archive.chats.find(chat => chat.id === f.chat.id).messages.at(-1).status, "streaming");
  const sessionFile = join(f.descriptor.state, "agent-sessions", `${f.chat.sessionId}.json`), original = readFileSync(sessionFile);
  assert.deepEqual(inspectLegacyApiChatArchive(f.root).managed, archive.managed);
  assert.deepEqual(readFileSync(sessionFile), original);
});

test("a completed original Task with an unacknowledged original send remains uncertain without replaying the old control", t => {
  const f = setup(t), hostId = randomUUID(), requestId = hash("original pending send");
  const requests = join(f.descriptor.state, "api-chat-control", "requests", hostId);
  mkdirSync(requests, { recursive: true, mode: 0o700 });
  writeFileSync(join(requests, `${requestId}.json`), JSON.stringify({
    schema: "pkm.api-chat.request/v1", hostId, requestId, status: "running", operation: "send",
    arguments: { id: f.chat.id, text: "Unknown old execution." },
  }), { mode: 0o600 });
  const archive = inspectLegacyApiChatArchive(f.root);
  assert.deepEqual(archive.managed.uncertainChats, [f.chat.id]);
  assert.deepEqual(archive.managed.uncertainControls, [requestId]);
});

test("real installed old worker root copy adopts losslessly but never silently falls back to plain text execution", {
  skip: !process.env.PKM_MANAGED_API_CHAT_SOURCE,
}, async t => {
  const source = realpathSync(process.env.PKM_MANAGED_API_CHAT_SOURCE);
  assert(source.startsWith(join(project, ".migration-test-work") + "/") && source.endsWith("/knowledge"));
  const fixtureDirectory = dirname(source);
  assert.match(fixtureDirectory.split("/").at(-1), /^native-chat-ui-[a-f0-9-]{36}$/);
  const descriptor = JSON.parse(readFileSync(join(fixtureDirectory, "api-chat-fixture.json")));
  assert.equal(realpathSync(descriptor.state), join(source, ".pkm/state"));
  const proof = JSON.parse(readFileSync(join(fixtureDirectory, "legacy-chat-worker-evidence.json")));
  assert(proof.calls.some(call => call.role === "manager" && call.name === "read_file" && call.sha256 === proof.inputSha256));
  assert(proof.calls.some(call => call.role === "child" && call.name === "read_file" && call.sha256 === proof.inputSha256));
  const directory = join(project, ".migration-test-work", `managed-installed-copy-${randomUUID()}`), root = join(directory, "knowledge");
  cpSync(source, root, { recursive: true, dereference: false });
  const original = new Map();
  function inventory(file) {
    const stat = lstatSync(file);
    assert(!stat.isSymbolicLink() && (stat.isDirectory() || stat.isFile()));
    chmodSync(file, stat.isDirectory() ? 0o700 : 0o600);
    if (stat.isDirectory()) for (const name of readdirSync(file)) inventory(join(file, name));
    else original.set(relative(root, file), hash(readFileSync(file)));
  }
  inventory(root);
  let storage, native, port, managed, denied, server, crashing, ui, revoked, releaseHost, releaseModel, calls = 0;
  t.after(async () => {
    if (crashing && crashing.exitCode === null && crashing.signalCode === null) {
      const exited = once(crashing, "exit"); crashing.kill("SIGKILL"); await exited;
    }
    releaseHost?.();
    releaseModel?.();
    try { await revoked?.close(); await ui?.close(); await denied?.close(); await managed?.close(); await port?.drain(); } finally {
      try { await native?.close(); } finally {
        await storage?.close();
        if (server) await new Promise(resolve => server.close(resolve));
        rmSync(directory, { recursive: true, force: true });
      }
    }
  });
  const nonce = randomUUID(), options = require("../legacy/tests/next-trial-electron/in-place-options.cjs").options;
  writeFileSync(join(directory, "in-place-fixture-token"), nonce, { mode: 0o600 });
  const prepared = await prepareLegacyRootAdoptionExperimental(root, options({ fixture: directory, root, nonce }));
  storage = (await resumeLegacyRootAdoptionExperimental(root, options({ fixture: directory, root, nonce, workspaceId: prepared.workspaceId }))).storage;
  native = await createNativeRuntime({ storage, workspaceId: await storage.workspaceId() });
  port = new LegacyApiChatRuntime({ storage, actorId: "synthetic-managed-original",
    authorize: async () => true, authorizeLibrary: async () => true,
    provider: async () => { calls++; throw new Error("A managed Task must never execute through the text-only provider."); } });
  const archive = inspectLegacyApiChatArchive(root), manager = archive.chats.find(chat => chat.id === proof.managerId);
  const identity = { namespace: manager.namespace, chatId: manager.id };
  assert.equal((await port.history(identity)).metadata.sessionId, proof.sessionId);
  assert.equal((await port.library()).state.groups[0].name, "Synthetic preserved task library");
  await assert.rejects(port.continue({ ...identity, operationId: randomUUID(), expectedRevision: 0, text: "Explicit fresh continuation." }),
    /dedicated freshly authorized native worker host/);
  assert.equal(calls, 0);
  const nativeBytes = `fresh-native-file-${randomUUID()}`, inputFile = join(directory, "fresh-input.txt");
  writeFileSync(inputFile, nativeBytes, { mode: 0o600 });
  let modelCalls = 0, toolReads = 0;
  const hostGate = new Promise(resolve => { releaseHost = resolve; });
  let modelObserved;
  const modelGate = new Promise(resolve => { releaseModel = resolve; });
  const observed = new Promise(resolve => { modelObserved = resolve; });
  server = createServer(async (request, response) => {
    try {
      assert.equal(request.url, "/v1/chat/completions");
      assert.equal(request.headers.authorization, "Bearer fresh-private-managed-token");
      const chunks = [];
      for await (const chunk of request) chunks.push(chunk);
      const body = JSON.parse(Buffer.concat(chunks).toString());
      assert.equal(body.tools[0].function.name, "read_file");
      modelCalls++;
      if (body.messages.findLast(message => message.role === "user").content.includes("HOST_PENDING"))
        await hostGate;
      if (body.messages.findLast(message => message.role === "user").content.includes("REVOKE_DURING_MODEL")) {
        modelObserved(); await modelGate;
      }
      const child = body.messages.findLast(message => message.role === "user").content.includes("NATIVE_CHILD_READ");
      const results = body.messages.filter(message => message.role === "tool").map(message => JSON.parse(message.content));
      const read = results.find(result => result.path === "fresh-input.txt"), spawned = results.find(result => result.workers);
      if (read) assert.equal(read.content, nativeBytes);
      let delta, finished = false;
      if (child && read) { delta = { content: `NATIVE_CHILD_ACTUAL_READ sha256:${hash(read.content)}` }; finished = true; }
      else if (!child && spawned) {
        assert.equal(spawned.workers[0].output, `NATIVE_CHILD_ACTUAL_READ sha256:${hash(read.content)}`);
        delta = { content: `NATIVE_ACTUAL_READ sha256:${hash(read.content)}` }; finished = true;
      } else {
        const name = read ? "spawn_workers" : "read_file";
        const arguments_ = read ? { tasks: [{ title: "Native independent worker", question: "NATIVE_CHILD_READ: Read fresh-input.txt once. Never write or retry." }] }
          : { path: "fresh-input.txt" };
        delta = { tool_calls: [{ index: 0, id: `fresh-native-${name}`, type: "function",
          function: { name, arguments: JSON.stringify(arguments_) } }] };
      }
      response.writeHead(200, { "content-type": "text/event-stream" });
      response.end(`data: ${JSON.stringify({ choices: [{ index: 0, delta, finish_reason: null }] })}\n\n`
        + `data: ${JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: finished ? "stop" : "tool_calls" }] })}\n\n`
        + 'data: {"choices":[],"usage":{"prompt_tokens":100,"completion_tokens":30}}\n\ndata: [DONE]\n\n');
    } catch (error) { response.writeHead(500); response.end(String(error)); }
  });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  const model = createLegacyManagedChatLocalModel({ endpoint: `http://127.0.0.1:${server.address().port}/v1`,
    apiKey: "fresh-private-managed-token", model: "synthetic-native-managed",
    tools: async (_actor, turnId) => {
      const scope = await managed.scope(turnId);
      return [{ name: "read_file", description: "Read only the freshly authorized synthetic file.",
        parameters: { type: "object", properties: { path: { type: "string" } }, required: ["path"], additionalProperties: false } },
      ...(!scope.parentTurnId ? [{ name: "spawn_workers", description: "Dispatch one freshly authorized native worker.",
        parameters: { type: "object", properties: { tasks: { type: "array", items: { type: "object",
          properties: { title: { type: "string" }, question: { type: "string" } }, required: ["title", "question"],
          additionalProperties: false } } }, required: ["tasks"], additionalProperties: false } }] : [])];
    },
  });
  const fresh = { storage, actorId: "synthetic-managed-original", model,
    authorize: async binding => binding.root === root && binding.chatId === identity.chatId
      && binding.sourceSessionId === proof.sessionId
      && (!binding.tool || binding.tool === "read_file" || binding.tool === "spawn_workers" && !binding.parentTurnId),
    tools: { available: true, async execute(request) {
      assert.equal(request.binding.sourceSessionId, proof.sessionId);
      if (request.call.name === "spawn_workers") {
        const child = await managed.delegate(request.turnId, request.operationId, 0);
        assert.equal(child.status, "completed");
        return { executionId: request.operationId, content: JSON.stringify({
          workers: [{ id: child.id, status: child.status, output: child.output }],
        }) };
      }
      assert.equal(request.call.name, "read_file");
      assert.deepEqual(request.call.arguments, { path: "fresh-input.txt" });
      const content = readFileSync(inputFile, "utf8");
      toolReads++;
      return { executionId: request.operationId, content: JSON.stringify({ path: "fresh-input.txt", content }) };
    } },
  };
  denied = new LegacyManagedApiChatRuntime({ ...fresh, actorId: "denied-native-managed", authorize: async () => false });
  await assert.rejects(denied.start({ ...identity, operationId: randomUUID(), expectedRevision: 0, text: "Denied Task." }),
    /FRESH_AUTHORITY_DENIED/);
  assert.equal(modelCalls, 0);
  managed = new LegacyManagedApiChatRuntime(fresh);
  assert.throws(() => new LegacyManagedApiChatRuntime(fresh), /exclusive runtime/);
  const next = { ...identity, operationId: randomUUID(), expectedRevision: 0, text: "Native continuation: read the freshly authorized file." };
  await managed.start(next);
  const continued = await managed.settled(identity, next.operationId);
  assert.equal(continued.messages.at(-1).content, `NATIVE_ACTUAL_READ sha256:${hash(nativeBytes)}`);
  assert.notEqual(hash(nativeBytes), proof.inputSha256, "The native tool result is not an echo of the old result.");
  assert.equal(continued.messages.at(-1).toolCalls[0].result, JSON.stringify({ path: "fresh-input.txt", content: nativeBytes }));
  assert.equal(continued.metadata.sessionId, proof.sessionId);
  assert.equal(continued.nativeWorkers.length, 1);
  assert.equal(continued.nativeWorkers[0].output, `NATIVE_CHILD_ACTUAL_READ sha256:${hash(nativeBytes)}`);
  assert.equal(modelCalls, 5); assert.equal(toolReads, 2);
  assert.equal((await managed.start(next)).status, "completed");
  assert.equal(modelCalls, 5); assert.equal(toolReads, 2);
  await managed.close(); managed = new LegacyManagedApiChatRuntime(fresh);
  assert.deepEqual((await managed.history(identity)).messages, continued.messages);
  assert.equal(modelCalls, 5); assert.equal(toolReads, 2);
  await managed.close(); managed = undefined;
  ui = await startLegacyApiChatUiHost({ storage, actorId: fresh.actorId, chats: [identity],
    authorize: async () => true, authorizeLibrary: async () => true,
    provider: async () => { throw new Error("Managed UI must never invoke the text-only fallback."); },
    managed: { model, authorize: fresh.authorize, tools: fresh.tools },
  });
  managed = ui.managed;
  const rpc = async input => {
    const response = await fetch(`${ui.endpoint}/rpc`, { method: "POST",
      headers: { authorization: `Bearer ${ui.bearer}`, "x-pkm-native-actor": fresh.actorId,
        "content-type": "application/json" }, body: JSON.stringify(input) });
    const result = await response.json();
    return { status: response.status, ...result };
  };
  assert.equal((await rpc({ method: "status" })).value.managed, true);
  const task = await rpc({ method: "harness", ...identity, sessionId: proof.sessionId });
  assert.equal(task.value.record.sessionId, proof.sessionId);
  assert.equal(task.value.history.nativeWorkers.length, 1);
  assert.equal(task.value.sourceWorkers.length, 1);
  const ts = require("typescript"), projection = { exports: {} };
  new Function("require", "module", "exports", ts.transpileModule(
    readFileSync(join(project, "src/chat/native-chat-harness-ui.ts"), "utf8"),
    { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText)(
    name => name === "./api-chat-store" ? require("../legacy/dist/chat/api-chat-store.js") : require(name),
    projection, projection.exports);
  const snapshot = (workerId, sessionId = proof.sessionId) =>
    projection.exports.nativeChatHarnessSnapshot(task.value, sessionId, true, workerId);
  const callsIn = snapshot => snapshot.harness.attempts.flatMap(attempt => attempt.toolCalls);
  assert(callsIn(snapshot()).some(call => call.name === "read_file" && call.resultPreview.includes(nativeBytes)));
  assert(callsIn(snapshot(task.value.history.nativeWorkers[0].id))
    .some(call => call.name === "read_file" && call.resultPreview.includes(nativeBytes)));
  assert(callsIn(snapshot(proof.workerReceiptId)).some(call => call.name === "read_file"));
  assert.throws(() => snapshot(randomUUID()), /outside this exact Task/);
  assert.throws(() => snapshot(undefined, `agent_session_${"0".repeat(32)}`), /exact authorized Task/);
  assert.equal((await rpc({ method: "harness", ...identity, sessionId: `agent_session_${"0".repeat(32)}` })).status, 409);
  const uiInput = { ...identity, operationId: randomUUID(), expectedRevision: 1,
    text: "HOST_PENDING: Continue this same original Task with an independent fresh read and child." };
  const accepted = await rpc({ method: "continue", ...uiInput });
  assert.equal(accepted.status, 200);
  assert(accepted.value.pending.some(item => item.operationId === uiInput.operationId && item.status === "running"));
  const libraryBefore = (await rpc({ method: "library" })).value;
  try {
    const trashed = await rpc({ method: "library-mutate", input: { kind: "trash", chatId: identity.chatId,
      operationId: randomUUID(), expectedRevision: libraryBefore.revision } });
    assert.equal(trashed.status, 409);
    assert.match(trashed.error, /unfinished native Task/);
  } finally { releaseHost(); }
  const uiCompleted = await managed.settled(identity, uiInput.operationId);
  assert.equal(uiCompleted.nativeTurns.length, 2);
  assert.equal(uiCompleted.nativeWorkers.length, 2);
  assert.equal(uiCompleted.nativeTurns.at(-1).status, "completed");
  assert.equal(modelCalls, 10); assert.equal(toolReads, 4);
  const readOnlyModel = createLegacyManagedChatLocalModel({ endpoint: `http://127.0.0.1:${server.address().port}/v1`,
    model: "synthetic-native-managed", apiKey: "fresh-private-managed-token",
    tools: async () => [{ name: "read_file", description: "Fresh exact synthetic read.",
      parameters: { type: "object", properties: { path: { type: "string" } }, required: ["path"], additionalProperties: false } }],
  });
  let permitted = true, revokedReads = 0;
  revoked = new LegacyManagedApiChatRuntime({ ...fresh, actorId: "revoked-after-real-effect", model: readOnlyModel,
    authorize: async binding => binding.operation === "history" || permitted,
    tools: { available: true, async execute(request) {
      assert.equal(request.call.name, "read_file");
      const content = readFileSync(inputFile, "utf8"); revokedReads++; permitted = false;
      return { executionId: request.operationId, content: JSON.stringify({ path: "fresh-input.txt", content }) };
    } },
  });
  const revokedInput = { ...identity, operationId: randomUUID(), expectedRevision: 0, text: "Read the fresh file once." };
  await revoked.start(revokedInput);
  const revokedOutcome = await revoked.settled(identity, revokedInput.operationId);
  assert.equal(revokedOutcome.nativeTurns[0].status, "unknown");
  assert.equal(revokedOutcome.pending[0].status, "prepared");
  assert.equal(revokedReads, 1); assert.equal(modelCalls, 11);
  await revoked.close(); revoked = undefined;
  permitted = true;
  revoked = new LegacyManagedApiChatRuntime({ ...fresh, actorId: "revoked-during-real-model", model: readOnlyModel,
    authorize: async binding => binding.operation === "history" || permitted,
    tools: { available: true, async execute() { throw new Error("Revoked model output must not dispatch any tool."); } },
  });
  const rejectedInput = { ...identity, operationId: randomUUID(), expectedRevision: 0, text: "REVOKE_DURING_MODEL: Read the fresh file." };
  await revoked.start(rejectedInput);
  await observed; permitted = false; releaseModel();
  const rejectedOutcome = await revoked.settled(identity, rejectedInput.operationId);
  assert.equal(rejectedOutcome.nativeTurns[0].status, "failed");
  assert.equal(rejectedOutcome.messages.at(-1).toolCalls.length, 0);
  assert.equal(modelCalls, 12); assert.equal(revokedReads, 1);
  await revoked.close(); revoked = undefined;
  await ui.close(); ui = undefined; managed = undefined;
  await denied.close(); denied = undefined;
  await port.drain(); port = undefined;
  await native.close(); native = undefined;
  await storage.close(); storage = undefined;
  const unknown = { ...identity, operationId: randomUUID(), expectedRevision: 2,
    text: "UNACKNOWLEDGED_NATIVE_READ: Read the fresh file once, never retry." };
  const configFile = join(directory, "native-crash-config.json");
  writeFileSync(configFile, JSON.stringify({ root, nonce, workspaceId: prepared.workspaceId, actorId: fresh.actorId,
    sourceSessionId: proof.sessionId, inputFile, input: unknown,
    endpoint: `http://127.0.0.1:${server.address().port}/v1` }), { mode: 0o600 });
  let stderr = "", ready = false;
  const effect = new Promise((resolve, reject) => {
    crashing = fork(join(project, "../tests/legacy-managed-runtime-crash-child.mjs"), [configFile],
      { execArgv: [], stdio: ["ignore", "ignore", "pipe", "ipc"] });
    const timer = setTimeout(() => reject(new Error(`Native crash helper timed out: ${stderr}`)), 30000);
    crashing.stderr.on("data", data => { stderr = (stderr + data).slice(-16000); });
    crashing.once("error", reject);
    crashing.once("exit", (code, signal) => { clearTimeout(timer); if (!signal) reject(new Error(`Native child exited ${code}: ${stderr}`)); });
    crashing.on("message", message => {
      if (message.kind === "failed") { clearTimeout(timer); reject(new Error(message.error)); }
      if (message.kind === "ready") { ready = true; assert.equal(message.workspaceId, prepared.workspaceId); }
      if (message.kind === "tool-effect") { clearTimeout(timer); resolve(message); }
    });
  });
  const actualEffect = await effect;
  assert(ready, "The isolated native runtime must respond before its real tool effect.");
  assert.equal(actualEffect.operationId, unknown.operationId);
  assert.equal(actualEffect.sha256, hash(nativeBytes));
  const exited = once(crashing, "exit");
  assert(crashing.kill("SIGKILL"));
  const [, signal] = await exited;
  assert.equal(signal, "SIGKILL");
  const callsAtCrash = modelCalls;
  storage = (await resumeLegacyRootAdoptionExperimental(root, options({
    fixture: directory, root, nonce, workspaceId: prepared.workspaceId,
  }))).storage;
  native = await createNativeRuntime({ storage, workspaceId: prepared.workspaceId });
  managed = new LegacyManagedApiChatRuntime({ ...fresh, storage });
  const interrupted = await managed.history(identity);
  assert.equal(interrupted.nativeTurns.at(-1).status, "unknown");
  assert.equal(interrupted.nativeTurns.at(-1).replay, "never");
  assert.equal(interrupted.pending.at(-1).status, "prepared");
  assert.equal((await managed.start(unknown)).status, "unknown");
  await assert.rejects(managed.start({ ...unknown, operationId: randomUUID(), expectedRevision: 3 }),
    /unfinished native Task outcome/);
  assert.equal(modelCalls, callsAtCrash, "Restart, reads and receipt replay must not call the model again.");
  assert.equal(toolReads, 4, "The killed child read must never be repeated in the reopened host.");
  for (const [file, digest] of original) assert.equal(hash(readFileSync(join(root, file))), digest, file);
});
