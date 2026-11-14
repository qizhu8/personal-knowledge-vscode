import assert from "node:assert/strict";
import { fork } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { once } from "node:events";
import { createServer } from "node:http";
import { createRequire } from "node:module";
import { DatabaseSync } from "node:sqlite";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { test } from "node:test";

const dist = process.env.PKM_TEST_NEXT_SERVER_DIST;
const legacyExtension = process.env.PKM_TEST_LEGACY_CHAT_EXTENSION;
const load = name => import(pathToFileURL(join(dist, `${name}.js`)).href);
const { create: createLegacyFixture } = createRequire(import.meta.url)("./next-trial-electron/api-chat-fixture.cjs");
const delay = ms => new Promise(resolveDelay => setTimeout(resolveDelay, ms));

for (const mode of ["crash", "scope-revoke"]) test(`adopted Root direct-parent Chat ${mode}`, {
  timeout: 90000, skip: process.platform !== "linux" || !dist || !legacyExtension,
}, async t => {
  const { resumeLegacyRootAdoptionExperimental } = await load("legacy-root-adoption");
  const { startAdoptedRootUnifiedHost } = await load("managed-client-host");
  const { attachAdoptedRootSessionChat } = await load("adopted-root-session-chat");
  const { createOwnerHostSessions } = await load("owner-host-sessions");
  const { acquireLinuxRootWriterFence } = await load("linux-root-writer-fence");
  const { createLegacyManagedChatLocalModel } = await load("legacy-api-chat-managed-provider");
  const dir = resolve(".migration-test-work", `adopted-crash-${randomUUID()}`);
  const root = join(dir, "root"), capture = join(dir, "capture"), hostConfig = join(dir, "host.json");
  const script = join(dir, "tree.mjs"), parentTicks = join(dir, "parent-ticks"), childTicks = join(dir, "child-ticks");
  mkdirSync(root, { recursive: true, mode: 0o700 });
  mkdirSync(join(root, "notes"), { mode: 0o700 });
  mkdirSync(capture, { mode: 0o700 });
  writeFileSync(join(root, "notes", "Existing.md"), "---\ntitle: Existing\n---\nOriginal crash fixture.\n", { mode: 0o600 });
  writeFileSync(script, `import {spawn} from "node:child_process"; import {appendFileSync} from "node:fs";
spawn(process.execPath, ["-e", ${JSON.stringify(`setInterval(() => require("node:fs").appendFileSync(${JSON.stringify(childTicks)}, "x"), 20)`)}], {stdio:"ignore"});
process.stdout.write("crash-owner-captured-log");
setInterval(() => appendFileSync(${JSON.stringify(parentTicks)}, "x"), 20);`, { mode: 0o600 });
  const mask = process.umask(0o077);
  let descriptor;
  try { descriptor = createLegacyFixture({ extension: legacyExtension, root }); } finally { process.umask(mask); }
  const identity = { namespace: descriptor.namespace, chatId: descriptor.inline };
  const archive = join(descriptor.state, "api-chats", identity.namespace, `${identity.chatId}.json`);
  const original = readFileSync(archive), key = randomUUID();
  const handle = `process_${createHash("sha256").update(key).digest("hex")}`;
  let server, processOwner, storage, managed, chat, database, succeeded = false;
  t.after(async () => {
    if (processOwner && processOwner.exitCode === null && processOwner.signalCode === null) {
      processOwner.kill("SIGKILL");
      await once(processOwner, "exit");
    }
    if (chat) await chat.close();
    if (managed) await managed.close();
    else if (storage) await storage.close();
    database?.close();
    if (server) { server.closeAllConnections(); await new Promise(resolveClose => server.close(resolveClose)); }
    if (succeeded) rmSync(dir, { recursive: true, force: true });
  });
  server = createServer(async (request, response) => {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    const input = JSON.parse(Buffer.concat(chunks).toString());
    const finished = input.messages.some(message => message.role === "tool");
    const delta = finished ? { content: "done" } : { tool_calls: [{ index: 0, id: "run", type: "function",
      function: { name: "run_process", arguments: JSON.stringify({ program: process.execPath, arguments: [script],
        cwd: root, timeoutSeconds: 60, background: true, idempotency_key: key }) } }] };
    response.writeHead(200, { "content-type": "text/event-stream" });
    response.end(`data: ${JSON.stringify({ choices: [{ index: 0, delta, finish_reason: null }] })}\n\n`
      + `data: ${JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: finished ? "stop" : "tool_calls" }] })}\n\ndata: [DONE]\n\n`);
  });
  await new Promise(resolveListen => server.listen(0, "127.0.0.1", resolveListen));
  const endpoint = `http://127.0.0.1:${server.address().port}/v1`, processDb = join(dir, "process.sqlite");
  writeFileSync(hostConfig, JSON.stringify({ schema: "pkm.native-host-config/v1", provider: "openai-compatible",
    endpoint, secretRef: "secret:fixture/model", model: "fixture", contextWindow: 16384, maxOutputTokens: 4096,
    outputTokenParameter: "max_tokens", includeUsage: true, tools: ["knowledge.document.create"] }), { mode: 0o600 });
  const launch = join(dir, "launch.json");
  writeFileSync(launch, JSON.stringify({ dist, root, capture, hostConfig, script, parentTicks, childTicks, processDb, endpoint, identity }), { mode: 0o600 });
  processOwner = fork(resolve("tests/next-trial-electron/adopted-root-crash-owner.mjs"), [launch],
    { stdio: ["ignore", "ignore", "pipe", "ipc"], env: { ...process.env } });
  let errors = "";
  processOwner.stderr.on("data", chunk => { errors += chunk.toString(); });
  const ready = await Promise.race([
    once(processOwner, "message").then(([message]) => message),
    once(processOwner, "exit").then(([code, signal]) => { throw new Error(`owner exited ${code}/${signal}: ${errors}`); }),
  ]);
  assert.equal(ready.type, "ready");
  if (mode === "scope-revoke") {
    const require = createRequire(import.meta.url), ts = require("typescript");
    const make = (file, imports) => {
      const source = readFileSync(file, "utf8"), module = { exports: {} };
      const js = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
      new Function("require", "module", "exports", js)(name => imports[name] ?? require(name), module, module.exports);
      return module.exports;
    };
    const event = () => ({ dispose() {} }), vscode = {
      workspace: { isTrusted: true, onDidChangeWorkspaceFolders: event, onDidChangeConfiguration: event },
      window: { showQuickPick: async choices => choices[0], showWarningMessage: async () => "Allow Selected Chat" },
    };
    const profileDir = join(dir, "profile");
    mkdirSync(profileDir, { mode: 0o700 });
    const issuer = make("src/chat/adopted-root-chat-authority.ts", {
      vscode, "../knowledge/filestore": { getStorePath: () => root },
    });
    const control = make("src/runtime/owner-parent-control.ts", {});
    const adapter = make("src/chat/adopted-root-chat-parent-session.ts", {
      "../runtime/owner-parent-control": control, "./adopted-root-chat-authority": issuer,
    });
    const hostSignal = new AbortController(), configurationFingerprint = createHash("sha256").update(readFileSync(hostConfig)).digest("hex");
    const hostFence = binding => {
      assert.equal(binding.root, root); assert.equal(binding.workspaceId, ready.workspaceId);
      assert.equal(binding.sessionId, ready.sessionId); assert.equal(binding.configurationFingerprint, configurationFingerprint);
    };
    const profile = await issuer.requestAdoptedRootChatAuthority(
      { subscriptions: [], globalStorageUri: { fsPath: profileDir }, secrets: { onDidChange: event } },
      { root, workspaceId: ready.workspaceId, sessionId: ready.sessionId, configurationFingerprint,
        candidates: [{ ...identity, title: "Original Chat" }], hostSignal: hostSignal.signal, assertHostCurrent: hostFence });
    const errors = [];
    const parent = adapter.createAdoptedRootChatParentSession({ authority: profile, root, workspaceId: ready.workspaceId,
      sessionId: ready.sessionId, configurationFingerprint, child: processOwner, hostSignal: hostSignal.signal,
      endpoint: ready.endpoint, bearer: ready.bearer, sourceFingerprint: ready.sourceFingerprint,
      assertHostCurrent: hostFence,
      assertTransportCurrent(binding, child) {
        assert.equal(child, processOwner); assert.equal(binding.endpoint, ready.endpoint);
        assert.equal(binding.bearer, ready.bearer); assert.equal(binding.sourceFingerprint, ready.sourceFingerprint);
      }, onCloseError(error) { errors.push(error); } });
    profile.dispose();
    assert.equal(parent.viewAuthority.session.signal.aborted, true);
    await parent.close();
    assert.deepEqual(errors, []);
    const stopped = [readFileSync(parentTicks).length, readFileSync(childTicks).length];
    await delay(200);
    assert.deepEqual([readFileSync(parentTicks).length, readFileSync(childTicks).length], stopped);
    processOwner.send({ type: "fixture-check-environment" });
    const [environment] = await once(processOwner, "message");
    assert.equal(environment.type, "fixture-environment-ok");
    await assert.rejects(acquireLinuxRootWriterFence(root, 100));
    const exit = once(processOwner, "exit");
    processOwner.disconnect();
    const [code, signal] = await exit;
    assert.equal(code, 0, `${signal}: ${errors}`);
    const fence = await acquireLinuxRootWriterFence(root, 1000);
    await fence.release();
    assert.deepEqual(readFileSync(archive), original);
    succeeded = true;
    return;
  }
  assert.equal(processOwner.kill("SIGKILL"), true);
  await once(processOwner, "exit");
  await delay(250);
  const stopped = [readFileSync(parentTicks).length, readFileSync(childTicks).length];
  await delay(200);
  assert.deepEqual([readFileSync(parentTicks).length, readFileSync(childTicks).length], stopped);

  const adoption = await resumeLegacyRootAdoptionExperimental(root, {
    snapshotAdmission: { authorityId: "private-crash-test", allowedTools: ["knowledge_snapshot_status"], authorize: () => true },
  });
  storage = adoption.storage;
  assert.equal(adoption.workspaceId, ready.workspaceId);
  const options = { optIn: true, dataPath: root, configPath: hostConfig, expectedWorkspaceId: adoption.workspaceId,
    policy: { authorizedConfigPath: hostConfig, allowedProviders: ["openai-compatible"], allowedEndpoints: [endpoint],
      allowedModels: ["fixture"], allowedTools: ["knowledge.document.create"], allowInsecureLoopback: true }, resolveSecret: async () => "fixture" };
  const unified = await startAdoptedRootUnifiedHost(options, adoption);
  managed = unified.managed;
  database = new DatabaseSync(processDb);
  const model = createLegacyManagedChatLocalModel({ endpoint, model: "fixture", apiKey: "fixture", tools: async () => [] });
  const sessions = createOwnerHostSessions(unified.ownerResourceContext(), adoption.workspaceId);
  const session = sessions.open({ hostKey: "crash-recovery-host", connection: new AbortController().signal,
    assertHostCurrent() {}, assertScopeCurrent() {}, onCloseError(error) { throw error; } });
  chat = await attachAdoptedRootSessionChat({ managed, owner: unified.ownerResourceContext(), session,
    profile: { workspaceId: adoption.workspaceId, actorId: "local:owner", root, profileId: "crash-profile",
      signal: new AbortController().signal, assertCurrent() {} }, onCloseError(error) { throw error; },
    ownerOptions: { database, captureDirectory: capture, previousOwnerId: ready.processOwnerId, commands: [],
      policy: async () => ({ available: true, trusted: true, permissionMode: "ask", localControls: true }),
      remember: async () => { throw new Error("No remembered grants."); } },
    chat: { chats: [identity], authorize: async () => true, provider: async () => "unused",
      managed: { model, authorize: async () => true, tools: { available: true, execute: async () => { throw new Error("Unexpected tool."); } } } } });
  const rpc = async input => {
    const response = await fetch(`${chat.endpoint}/rpc`, { method: "POST",
      headers: { authorization: `Bearer ${chat.bearer}`, "x-pkm-native-actor": "local:owner", "content-type": "application/json" },
      body: JSON.stringify(input) });
    const body = await response.json();
    assert.equal(response.status, 200, body.error);
    return body.value;
  };
  const status = await rpc({ method: "status" });
  const recovered = await rpc({ method: "process-control", ...identity, handle, operation: "status" });
  assert.equal(recovered.state, "unknown");
  assert.match(recovered.detail, /No historical PID is signalled/);
  const evidence = await chat.processes.execute({ root, workspaceId: adoption.workspaceId, actorId: "local:owner",
    sourceFingerprint: status.sourceFingerprint, ...identity }, {
    call: { name: "process_output", arguments: { handle, stream: "stdout", start: 0, length: 100 } },
    operationId: randomUUID(), signal: new AbortController().signal,
  });
  assert.match(JSON.parse(evidence.content).text, /crash-owner-captured-log/);
  const history = await rpc({ method: "history", ...identity });
  assert(history.messages.some(message => message.content === "Synthetic ordinary API Chat history."));
  assert(history.nativeTurns.some(turn => turn.id === ready.operationId));
  assert.deepEqual(readFileSync(archive), original);
  assert.equal(Number(database.prepare("SELECT count(*) AS n FROM runtime_process_jobs").get().n), 1);
  const afterRecovery = [readFileSync(parentTicks).length, readFileSync(childTicks).length];
  await delay(200);
  assert.deepEqual([readFileSync(parentTicks).length, readFileSync(childTicks).length], afterRecovery);
  succeeded = true;
});
