import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { createServer } from "node:http";
import { createServer as createSocketServer, connect as connectSocket } from "node:net";
import { createRequire } from "node:module";
import { DatabaseSync } from "node:sqlite";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { test } from "node:test";

const dist = process.env.PKM_TEST_NEXT_SERVER_DIST;
const oldExtension = process.env.PKM_TEST_LEGACY_CHAT_EXTENSION;
const load = name => import(pathToFileURL(join(dist, `${name}.js`)).href);
const { create: createLegacyFixture } = createRequire(import.meta.url)("./next-trial-electron/api-chat-fixture.cjs");
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

test("adopted host retains its claim when a startup factory cannot return a drainable resource", async t => {
  const require = createRequire(import.meta.url);
  const ts = require("typescript");
  const source = readFileSync("next-server/src/standalone-host.ts", "utf8");
  const js = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
  const dir = resolve(".migration-test-work", `adopted-startup-contract-${randomUUID()}`);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const config = join(dir, "host.json");
  writeFileSync(config, "{}", { mode: 0o600 });
  let closed = false;
  class Storage {
    assertWorkspaceLease() {}
    workspaceRoot() { return dir; }
    async workspaceId() { return "private-workspace"; }
    connectNative() { return { close() { closed = true; } }; }
  }
  const storage = new Storage();
  const stubs = {
    "./storage.js": { Storage },
    "./human-review.js": { createHumanReviewQueue: () => ({ native: { reviewer() {}, shutdown() {} }, handlers: {} }) },
    "./host-config.js": { buildHostConfigOptions: () => ({}) },
    "./legacy-recipe-host.js": { composeLegacyRecipeHost: async () => { throw new Error("unconfirmed factory failure"); } },
    "./native-runtime.js": {},
  };
  const module = { exports: {} };
  new Function("require", "module", "exports", js)(name => stubs[name] ?? (name.startsWith("node:") ? require(name) : {}), module, module.exports);
  const { startStandaloneHostFromAdoptedRoot, AdoptedHostStartupCleanupError } = module.exports;
  const adoption = { storage, sourceRoot: dir, workspaceId: "private-workspace", state: "committed", qualification: "experimental-unqualified" };
  const options = { dataPath: dir, configPath: config, policy: { authorizedConfigPath: config, allowedProviders: [],
    allowedEndpoints: [], allowedModels: [], allowedTools: [] }, resolveSecret() {}, authenticateHuman() {}, legacyRecipes: {} };
  let failure;
  try { await startStandaloneHostFromAdoptedRoot(options, adoption); } catch (error) { failure = error; }
  assert(failure instanceof AdoptedHostStartupCleanupError);
  await assert.rejects(failure.retryCleanup(), /without returning a drainable resource/);
  await assert.rejects(startStandaloneHostFromAdoptedRoot(options, adoption), /already claimed/);
  assert.equal(closed, false);
});

test("owner MCP attachment retains its child barrier if startup cleanup is unknown", { skip: !dist }, async () => {
  const { attachReadOnlyMcpToAdoptedOwner } = await load("adopted-root-owner-attachment");
  let closeChild, unregistered = false, closeError;
  const owner = { storage: {}, core: {}, workspaceId: "fixture", assertCurrent() {},
    registerChildClose(close) { closeChild = close; return () => { unregistered = true; }; } };
  await assert.rejects(attachReadOnlyMcpToAdoptedOwner({ owner, connection: new AbortController().signal,
    assertMcpAuthority() {}, onCloseError(error) { closeError = error; },
    async start() { throw new Error("transport startup failed"); } }), /unconfirmed/);
  assert(closeError);
  await assert.rejects(closeChild(), /did not return a drainable resource/);
  assert.equal(unregistered, false);
});

test("owner MCP attachment requires independent revocable authority and drains on disconnect", { skip: !dist }, async () => {
  const { attachReadOnlyMcpToAdoptedOwner } = await load("adopted-root-owner-attachment");
  let registered, current = true, drained = false, release;
  const work = new Promise(resolveWork => { release = resolveWork; });
  const owner = { storage: {}, core: {}, workspaceId: "fixture", assertCurrent() {},
    registerChildClose(close) { registered = close; return () => { registered = undefined; }; } };
  const connection = new AbortController();
  let context;
  const attachment = await attachReadOnlyMcpToAdoptedOwner({ owner, connection: connection.signal,
    assertMcpAuthority() { if (!current) throw new Error("MCP authority revoked"); },
    onCloseError(error) { throw error; },
    async start(value) { assert(registered); context = value; return { async close() { await work; drained = true; } }; } });
  current = false;
  assert.throws(() => context.assertCurrent(), /revoked/);
  connection.abort();
  assert(attachment.disconnectTask);
  assert.equal(drained, false);
  release();
  await attachment.disconnectTask;
  assert.equal(drained, true);
  assert.equal(registered, undefined);
  assert.throws(() => context.assertCurrent(), /closed/);
});

async function until(fn, label) {
  for (let i = 0; i < 600; i++) {
    const result = await fn();
    if (result) return result;
    await sleep(25);
  }
  throw new Error(`Timed out: ${label}`);
}

test("original Root adoption transfers the live lease to managed Chat and never releases it on unconfirmed child drain", {
  timeout: 90000, skip: process.platform !== "linux" || !dist || !oldExtension,
}, async t => {
  const { adoptLegacyRootInPlaceExperimental } = await load("legacy-root-adoption");
  const { startManagedClientHostFromAdoptedRoot, startAdoptedRootUnifiedHost } = await load("managed-client-host");
  const { attachReadOnlyMcpToAdoptedOwner } = await load("adopted-root-owner-attachment");
  const { attachAdoptedRootReadOnlyMcp } = await load("adopted-root-mcp");
  const { AdoptedHostStartupCleanupError } = await load("standalone-host");
  const { attachAdoptedRootSessionChat } = await load("adopted-root-session-chat");
  const { createOwnerHostSessions } = await load("owner-host-sessions");
  const { createLegacyManagedChatLocalModel } = await load("legacy-api-chat-managed-provider");
  const { acquireLinuxRootWriterFence } = await load("linux-root-writer-fence");
  const dir = resolve(".migration-test-work", `adopted-chat-owner-${randomUUID()}`);
  const root = join(dir, "root"), capture = join(dir, "capture"), config = join(dir, "host.json");
  const script = join(dir, "managed-parent.mjs"), parentTicks = join(dir, "parent-ticks"), childTicks = join(dir, "child-ticks");
  let key = randomUUID();
  const processHandle = () => `process_${createHash("sha256").update(key).digest("hex")}`;
  mkdirSync(root, { recursive: true, mode: 0o700 });
  mkdirSync(join(root, "notes"), { mode: 0o700 });
  writeFileSync(join(root, "notes", "Existing.md"), "---\ntitle: Existing\nrevision: 1\n---\nSynthetic original Root.\n", { mode: 0o600 });
  mkdirSync(capture, { mode: 0o700 });
  writeFileSync(script, `import {spawn} from "node:child_process"; import {appendFileSync} from "node:fs";
spawn(process.execPath, ["-e", ${JSON.stringify(`setInterval(() => require("node:fs").appendFileSync(${JSON.stringify(childTicks)}, "x"), 20)`)}], {stdio:"ignore"});
process.stdout.write("original-root-managed-process-log");
setInterval(() => appendFileSync(${JSON.stringify(parentTicks)}, "x"), 20);`, { mode: 0o600 });
  const mask = process.umask(0o077);
  let descriptor;
  try { descriptor = createLegacyFixture({ extension: oldExtension, root }); } finally { process.umask(mask); }
  const identity = { namespace: descriptor.namespace, chatId: descriptor.inline };
  const archive = join(descriptor.state, "api-chats", identity.namespace, `${identity.chatId}.json`);
  const original = readFileSync(archive);
  let adopted, host, child, processDb, server, released = false, startupUnconfirmed = false;
  let socketServer, clientSocket, serverSocket, socketClient, socketDir, releaseInventory, releaseMcp;
  t.after(async () => {
    releaseInventory?.();
    releaseMcp?.();
    clientSocket?.destroy();
    serverSocket?.destroy();
    if (socketClient) await socketClient.close();
    if (socketServer?.listening) await new Promise(resolveClose => socketServer.close(resolveClose));
    if (startupUnconfirmed) {
      if (server) { server.closeAllConnections(); await new Promise(resolveClose => server.close(resolveClose)); }
      return;
    }
    if (child) await child.close();
    if (host) await host.close();
    else if (adopted && !released) await adopted.storage.close();
    processDb?.close();
    if (server) { server.closeAllConnections(); await new Promise(resolveClose => server.close(resolveClose)); }
    rmSync(dir, { recursive: true, force: true });
    if (socketDir) rmSync(socketDir, { recursive: true, force: true });
  });
  let processRequested = false;
  server = createServer(async (request, response) => {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    const input = JSON.parse(Buffer.concat(chunks).toString());
    const toolResult = input.messages.some(message => message.role === "tool");
    const needsTool = processRequested && !toolResult;
    const delta = needsTool ? { tool_calls: [{ index: 0, id: "run", type: "function",
      function: { name: "run_process", arguments: JSON.stringify({ program: process.execPath, arguments: [script],
        cwd: root, timeoutSeconds: 60, background: true, idempotency_key: key }) } }] }
      : { content: "Adopted-root continuation." };
    response.writeHead(200, { "content-type": "text/event-stream" });
    response.end(`data: ${JSON.stringify({ choices: [{ index: 0, delta, finish_reason: null }] })}\n\n`
      + `data: ${JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: needsTool ? "tool_calls" : "stop" }] })}\n\ndata: [DONE]\n\n`);
  });
  await new Promise(resolveListen => server.listen(0, "127.0.0.1", resolveListen));
  const endpoint = `http://127.0.0.1:${server.address().port}/v1`;
  writeFileSync(config, JSON.stringify({ schema: "pkm.native-host-config/v1", provider: "openai-compatible",
    endpoint, secretRef: "secret:fixture/model", model: "fixture", contextWindow: 16384, maxOutputTokens: 4096,
    outputTokenParameter: "max_tokens", includeUsage: true, tools: ["knowledge.document.create"] }), { mode: 0o600 });
  adopted = await adoptLegacyRootInPlaceExperimental(root, {
    snapshotAdmission: { authorityId: "private-chat-owner-test", allowedTools: ["knowledge_snapshot_status"], authorize: () => true },
  });
  assert.equal(adopted.qualification, "experimental-unqualified");
  const options = { optIn: true, dataPath: root, configPath: config, expectedWorkspaceId: adopted.workspaceId,
    policy: { authorizedConfigPath: config, allowedProviders: ["openai-compatible"], allowedEndpoints: [endpoint],
      allowedModels: ["fixture"], allowedTools: ["knowledge.document.create"], allowInsecureLoopback: true },
    resolveSecret: async () => "fixture" };
  await assert.rejects(startManagedClientHostFromAdoptedRoot({ ...options, expectedWorkspaceId: randomUUID() }, adopted), /workspace binding/);
  await assert.rejects(startManagedClientHostFromAdoptedRoot({ ...options, configPath: join(dir, "absent") }, adopted), /configuration/);
  adopted.storage.assertWorkspaceLease();
  let unified;
  try { unified = await startAdoptedRootUnifiedHost(options, adopted); }
  catch (error) {
    startupUnconfirmed = error instanceof AdoptedHostStartupCleanupError || typeof error?.retryCleanup === "function";
    throw error;
  }
  host = unified.managed;
  await assert.rejects(startManagedClientHostFromAdoptedRoot(options, adopted), /already claimed/);
  const { StdioServerTransport } = await import("@modelcontextprotocol/sdk/server/stdio.js");
  const { Client } = await import("@modelcontextprotocol/sdk/client/index.js");
  socketDir = resolve(".migration-test-work", `m${randomUUID().replaceAll("-", "").slice(0, 12)}`);
  mkdirSync(socketDir, { mode: 0o700 });
  const socketPath = join(socketDir, "s");
  socketServer = createSocketServer();
  await new Promise(resolveListen => socketServer.listen(socketPath, resolveListen));
  const accepted = new Promise(resolveAccept => socketServer.once("connection", resolveAccept));
  clientSocket = connectSocket(socketPath);
  serverSocket = await accepted;
  const realConnection = new AbortController();
  serverSocket.once("close", () => realConnection.abort());
  const closeErrors = [];
  let transportCloseAttempts = 0;
  let mcpAuthorized = true;
  const realMcp = await attachAdoptedRootReadOnlyMcp({
    owner: unified.ownerResourceContext(), transport: new StdioServerTransport(serverSocket, serverSocket),
    connection: realConnection.signal, assertMcpAuthority() { if (!mcpAuthorized) throw new Error("MCP authority revoked"); },
    onCloseError(error) { closeErrors.push(error); },
    async closeConnection() {
      if (++transportCloseAttempts === 1) throw new Error("injected unconfirmed socket close");
      if (serverSocket.closed) return;
      const closed = new Promise(resolveClose => serverSocket.once("close", resolveClose));
      serverSocket.destroy();
      await closed;
    },
  });
  socketClient = new Client({ name: "private-fixture", version: "1.0.0" });
  await socketClient.connect(new StdioServerTransport(clientSocket, clientSocket));
  const tools = await socketClient.listTools();
  const names = tools.tools.map(tool => tool.name);
  assert.deepEqual(names.sort(), ["legacy_knowledge_read", "list_notes"]);
  assert.equal((await socketClient.callTool({ name: "legacy_knowledge_write", arguments: {} })).isError, true);
  assert.equal((await socketClient.callTool({ name: "legacy_indexed_knowledge_read", arguments: {} })).isError, true);
  const notes = await socketClient.callTool({ name: "list_notes", arguments: {} });
  assert.notEqual(notes.isError, true, JSON.stringify(notes));
  assert(JSON.stringify(notes).includes("Existing"));
  const legacyNote = await socketClient.callTool({ name: "legacy_knowledge_read",
    arguments: { tool: "get_note", arguments: { id: "Existing" } } });
  assert.notEqual(legacyNote.isError, true, JSON.stringify(legacyNote));
  assert(JSON.stringify(legacyNote).includes("Synthetic original Root."));
  let cancelLockEntered;
  const cancelLocked = new Promise(resolveHeld => { cancelLockEntered = resolveHeld; });
  const cancelHold = new Promise(resolveHold => { releaseInventory = resolveHold; });
  const cancelLock = adopted.storage.withWorkspaceExclusive(async () => { cancelLockEntered(); await cancelHold; });
  await cancelLocked;
  const cancelSignal = new AbortController();
  const cancelledRequest = socketClient.callTool({ name: "list_notes", arguments: {} }, undefined, { signal: cancelSignal.signal })
    .catch(error => error);
  await until(() => realMcp.inFlight === 1, "cancellable real MCP inventory");
  cancelSignal.abort();
  assert(await cancelledRequest instanceof Error);
  assert.equal(realMcp.inFlight, 1);
  adopted.storage.assertWorkspaceLease();
  releaseInventory(); releaseInventory = undefined;
  await cancelLock;
  await until(() => realMcp.inFlight === 0, "cancelled MCP effect completion");
  assert.notEqual((await socketClient.callTool({ name: "list_notes", arguments: {} })).isError, true);
  const mcpConnection = new AbortController();
  let mcpStarted = false, mcpClosed = false, mcpContext;
  const inFlightMcp = new Promise(resolveWork => { releaseMcp = resolveWork; });
  const mcp = await attachReadOnlyMcpToAdoptedOwner({ owner: unified.ownerResourceContext(), connection: mcpConnection.signal,
    assertMcpAuthority() {}, onCloseError(error) { throw error; },
    async start(context) {
      mcpStarted = true;
      mcpContext = context;
      assert.equal(context.storage, adopted.storage);
      assert.deepEqual(context.actor, { id: "mcp:external", canWrite: false });
      return { async close() { await inFlightMcp; mcpClosed = true; } };
    } });
  assert.equal(mcpStarted, true);
  mcpContext.assertCurrent();
  const room = await host.roomContext();
  const sessions = createOwnerHostSessions(unified.ownerResourceContext(), adopted.workspaceId);
  const hostSignal = new AbortController();
  let chatAllowed = true, mcpAllowed = true;
  const makeSession = () => sessions.open({ hostKey: "private-fixture-host", connection: hostSignal.signal,
    assertHostCurrent() {}, assertScopeCurrent(scope) {
      if (scope === "chat" && !chatAllowed || scope === "mcp" && !mcpAllowed) throw new Error("scope revoked");
    }, onCloseError(error) { throw error; } });
  let session = makeSession(), profileSignal = new AbortController(), intent;
  const selection = { workspaceId: adopted.workspaceId, actorId: "local:owner", assertCurrent() {} };
  const selected = host.selectedOwnerContext(selection);
  processDb = new DatabaseSync(join(dir, "process.sqlite"));
  const model = createLegacyManagedChatLocalModel({ endpoint, model: "fixture", apiKey: "fixture",
    tools: async () => [{ name: "run_process", description: "run", parameters: { type: "object", properties: {}, additionalProperties: true } }] });
  const childOptions = () => ({ managed: host, owner: unified.ownerResourceContext(), session,
    profile: intent ?? { workspaceId: adopted.workspaceId, actorId: "local:owner", root, profileId: "private-profile",
      signal: profileSignal.signal, assertCurrent(binding) {
        assert.deepEqual(binding.chats, [identity]);
        assert.equal(binding.root, root);
      } },
    onCloseError(error) { throw error; },
    ownerOptions: { database: processDb, captureDirectory: capture, commands: [{ id: "fixture", program: process.execPath, cwd: root,
      arguments: args => args.length === 1 && args[0] === script }],
      async policy() { return { available: true, trusted: true, permissionMode: "ask", localControls: true }; },
      async remember() { throw new Error("No remembered process permission in this fixture."); } },
    chat: { chats: [identity], authorize: async binding => binding.chatId === identity.chatId,
      provider: async () => "unused", managed: { model, authorize: async binding => binding.chatId === identity.chatId,
        tools: { available: true, execute: async () => { throw new Error("Unexpected tool."); } } } } });
  const makeChild = () => attachAdoptedRootSessionChat(childOptions());
  const mismatch = childOptions();
  await assert.rejects(attachAdoptedRootSessionChat({ ...mismatch, managed: { ...host, selectedOwnerContext() { return { storage: {} }; } } }),
    /same live Storage/);
  await assert.rejects(attachAdoptedRootSessionChat({ ...mismatch, profile: { ...mismatch.profile, root: dir } }), /binding/);
  await assert.rejects(attachAdoptedRootSessionChat({ ...mismatch, profile: { ...mismatch.profile,
    assertCurrent() { throw new Error("profile authority denied"); } } }), /profile authority denied/);
  child = await makeChild();
  const rpc = async (target, input) => {
    const response = await fetch(`${target.endpoint}/rpc`, { method: "POST",
      headers: { authorization: `Bearer ${target.bearer}`, "x-pkm-native-actor": "local:owner", "content-type": "application/json" },
      body: JSON.stringify(input) });
    const body = await response.json();
    assert.equal(response.status, 200, body.error);
    return body.value;
  };
  const status = await rpc(child, { method: "status" });
  assert.equal(status.root, root);
  let history = await rpc(child, { method: "history", ...identity });
  assert(history.messages.some(message => message.content === "Synthetic ordinary API Chat history."));
  await rpc(child, { method: "task-control", input: { ...identity, kind: "create", title: "Original Root Task",
    operationId: randomUUID(), expectedRevision: history.taskControl.revision } });
  const id = randomUUID();
  await rpc(child, { method: "continue", ...identity, operationId: id, expectedRevision: 0, text: "Continue old Chat." });
  await until(async () => (await rpc(child, { method: "history", ...identity })).nativeTurns
    ?.some(turn => turn.id === id && turn.status === "completed"), "original Root Chat continuation");
  mcpAllowed = false;
  await session.revokeScope("mcp");
  assert.throws(() => session.assertCurrent("mcp"), /revoked|unavailable/);
  session.assertCurrent("chat");
  profileSignal.abort();
  await child.revokeTask;
  child = undefined;
  profileSignal = new AbortController();
  const require = createRequire(import.meta.url), ts = require("typescript");
  const compile = file => ts.transpileModule(readFileSync(file, "utf8"), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  const sessionId = randomUUID(), profileDir = join(dir, "profile");
  mkdirSync(profileDir, { mode: 0o700 });
  const event = () => ({ dispose() {} });
  const intentVscode = { workspace: { isTrusted: true, onDidChangeWorkspaceFolders: event, onDidChangeConfiguration: event },
    window: { showQuickPick: async choices => choices[0], showWarningMessage: async () => "Allow Selected Chat" } };
  const intentModule = { exports: {} };
  new Function("require", "module", "exports", compile("src/chat/adopted-root-chat-authority.ts"))(
    name => name === "vscode" ? intentVscode : name === "../knowledge/filestore" ? { getStorePath: () => root } : require(name),
    intentModule, intentModule.exports);
  const configurationFingerprint = createHash("sha256").update(readFileSync(config)).digest("hex");
  intent = await intentModule.exports.requestAdoptedRootChatAuthority(
    { subscriptions: [], globalStorageUri: { fsPath: profileDir }, secrets: { onDidChange: event } },
    { root, workspaceId: adopted.workspaceId, sessionId, configurationFingerprint,
      candidates: [{ ...identity, title: "Synthetic ordinary Chat" }], hostSignal: session.signalFor("chat"),
      assertHostCurrent(binding) {
        assert.equal(binding.sessionId, sessionId);
        assert.equal(binding.configurationFingerprint, configurationFingerprint);
        session.assertCurrent("chat");
      } });
  child = await makeChild();
  assert((await rpc(child, { method: "history", ...identity })).nativeTurns.some(turn => turn.id === id));
  let viewProvider, shellView;
  const extensionDist = process.env.PKM_TEST_EXTENSION_DIST;
  let NativeProvider;
  const commands = new Map(), vscode = { workspace: { isTrusted: true }, window: {
    registerWebviewViewProvider(_id, provider) { shellView = provider; return { dispose() {} }; },
  }, Uri: { joinPath: (uri, ...parts) => ({ fsPath: join(uri.fsPath, ...parts) }) },
  commands: { registerCommand(name, callback) { commands.set(name, callback); return { dispose() {} }; },
    async executeCommand() {} } };
  if (extensionDist) {
    const Module = require("node:module"), originalLoad = Module._load;
    try {
      Module._load = function (name, ...args) {
        if (name === "vscode") return vscode;
        if (name === "./api-chat-shell") return { renderApiChat() {}, renderApiChatFailure(_view, error) { throw error; } };
        return originalLoad.call(this, name, ...args);
      };
      NativeProvider = require(join(extensionDist, "chat/native-chat-ui-experiment.js")).NativeChatUiProvider;
    } finally { Module._load = originalLoad; }
  }
  class StubProvider {
    constructor(_context, _binding, check) { this.check = check; viewProvider = this; }
    isBusy = false;
    attachWebviewView() { this.check(); }
    async openPkmChat(locator) { this.check(); this.locator = locator; }
    dispose() { this.disposed = true; }
  }
  const ViewProvider = NativeProvider ? class extends NativeProvider {
    constructor(...args) { super(...args); viewProvider = this; }
  } : StubProvider;
  const viewModule = { exports: {} };
  new Function("require", "module", "exports", "fetch", compile("src/chat/selected-owner-chat-ui.ts"))(
    name => name === "vscode" ? vscode
      : name === "./native-chat-ui-experiment" ? { NativeChatUiProvider: ViewProvider } : require(name),
    viewModule, viewModule.exports, fetch);
  const bridgeModule = { exports: {} };
  new Function("require", "module", "exports", compile("src/chat/adopted-root-chat-view.ts"))(
    name => name === "../knowledge/filestore" ? { getStorePath: () => root }
      : name === "./selected-owner-chat-ui" ? viewModule.exports : require(name), bridgeModule, bridgeModule.exports);
  const viewStatus = await rpc(child, { method: "status" });
  const viewAuthority = {
    root, workspaceId: adopted.workspaceId, sessionId, profileId: intent.profileId,
    sourceFingerprint: viewStatus.sourceFingerprint, endpoint: child.endpoint, bearer: child.bearer,
    session: { signal: session.signalFor("chat"), assertCurrent(binding) {
      assert.equal(binding.sessionId, sessionId);
      session.assertCurrent("chat");
    }, revokeChat: () => session.revokeScope("chat") },
    profile: intent,
  };
  const shellModule = { exports: {} };
  new Function("require", "module", "exports", compile("src/chat/api-chat-shell.ts"))(
    name => name === "vscode" ? vscode : name === "../knowledge/filestore" ? { getStorePath: () => root }
      : name === "../runtime/extension-host-runtime" || name === "./agent-control" || name === "./visualization-window" ? {}
      : name === "../runtime/async-deadline" ? { withAsyncDeadline: promise => promise } : require(name),
    shellModule, shellModule.exports);
  const context = { subscriptions: [], extensionUri: { fsPath: extensionDist ? resolve(extensionDist, "..") : dir } };
  let legacyLoads = 0;
  const shell = shellModule.exports.registerApiChatShell(context, async () => { legacyLoads++; throw new Error("legacy writer forbidden"); }, {
    load: signal => bridgeModule.exports.createAdoptedRootChatViewBackend(context, viewAuthority, signal),
  });
  const locator = `pkm://chats/${identity.namespace}/${identity.chatId}`;
  await commands.get("personalKnowledge.openApiChat")(locator);
  if (NativeProvider) {
    const listeners = new Set(), events = [];
    const view = { visible: true, onDidDispose() {}, webview: {
      cspSource: "fixture", asWebviewUri(uri) { return { toString() { return uri.fsPath; } }; },
      onDidReceiveMessage(listener) { listeners.add(listener); return { dispose() { listeners.delete(listener); } }; },
      async postMessage(value) { events.push(value); return true; },
    } };
    shellView.resolveWebviewView(view);
    for (const listener of [...listeners]) listener({ type: "ready" });
    const state = await until(() => {
      const error = events.find(event => event.type === "initializationError" || event.type === "error");
      if (error) throw new Error(error.message);
      return events.find(event => event.type === "state" && event.chat.id === identity.chatId);
    }, "ordinary shell actual Chat provider state");
    assert(state.chat.messages.some(message => message.content === "Synthetic ordinary API Chat history."));
  } else assert.equal(viewProvider.locator, locator);
  assert.equal(legacyLoads, 0);
  await shell.drainManagedWriter();
  assert.equal(NativeProvider ? viewProvider.stopped : viewProvider.disposed, true);
  assert.equal(intent.signal.aborted, true);
  intent.dispose();
  intent = undefined;
  session.assertCurrent("environment");
  child = undefined;
  await session.revoke();
  session = makeSession();
  profileSignal = new AbortController();
  child = await makeChild();
  history = await rpc(child, { method: "history", ...identity });
  assert(history.messages.some(message => message.content === "Synthetic ordinary API Chat history."));
  assert(history.nativeTurns.some(turn => turn.id === id && turn.status === "completed"));
  assert.deepEqual(readFileSync(archive), original);

  processRequested = true;
  const processTurn = randomUUID();
  await rpc(child, { method: "continue", ...identity, operationId: processTurn, expectedRevision: history.revision, text: "Run the fixture." });
  const prompt = await until(async () => (await rpc(child, { method: "process-approvals", ...identity }))[0], "fresh process approval");
  assert.equal(prompt.once, true);
  assert.equal(existsSync(parentTicks), false);
  await rpc(child, { method: "process-approval-decide", ...identity, id: prompt.id, choice: "approve" });
  await child.managed.settled(identity, processTurn);
  await until(() => existsSync(parentTicks) && existsSync(childTicks), "managed parent and descendant");
  const handle = processHandle();
  await rpc(child, { method: "process-control", ...identity, handle, operation: "pause" });
  await sleep(100);
  const paused = [readFileSync(parentTicks).length, readFileSync(childTicks).length];
  await sleep(150);
  assert.deepEqual([readFileSync(parentTicks).length, readFileSync(childTicks).length], paused);
  await rpc(child, { method: "process-control", ...identity, handle, operation: "resume" });
  await until(() => readFileSync(parentTicks).length > paused[0] && readFileSync(childTicks).length > paused[1], "resumed process tree");
  const stopping = rpc(child, { method: "process-control", ...identity, handle, operation: "stop" });
  const stopPrompt = await until(async () => (await rpc(child, { method: "process-approvals", ...identity }))[0], "local stop confirmation");
  await rpc(child, { method: "process-approval-decide", ...identity, id: stopPrompt.id, choice: "approve" });
  await stopping;
  const cancelled = [readFileSync(parentTicks).length, readFileSync(childTicks).length];
  await sleep(150);
  assert.deepEqual([readFileSync(parentTicks).length, readFileSync(childTicks).length], cancelled);
  key = randomUUID();
  const nextTurn = randomUUID(), nextHistory = await rpc(child, { method: "history", ...identity });
  await rpc(child, { method: "continue", ...identity, operationId: nextTurn, expectedRevision: nextHistory.revision, text: "Run again with approval." });
  const nextPrompt = await until(async () => (await rpc(child, { method: "process-approvals", ...identity }))[0], "second process approval");
  await rpc(child, { method: "process-approval-decide", ...identity, id: nextPrompt.id, choice: "approve" });
  await child.managed.settled(identity, nextTurn);
  await until(() => readFileSync(parentTicks).length > cancelled[0] && readFileSync(childTicks).length > cancelled[1], "second managed process tree");

  let inventoryEntered;
  const inventoryHeld = new Promise(resolveHeld => { inventoryEntered = resolveHeld; });
  const hold = new Promise(resolveHold => { releaseInventory = resolveHold; });
  const locked = adopted.storage.withWorkspaceExclusive(async () => { inventoryEntered(); await hold; });
  await inventoryHeld;
  const interrupted = socketClient.callTool({ name: "list_notes", arguments: {} }).catch(error => error);
  await until(() => realMcp.inFlight === 1, "actual MCP inventory in flight");
  mcpAuthorized = false;
  const denied = socketClient.listTools().catch(error => error);
  await until(() => !!realMcp.disconnectTask, "revoked MCP connection closes");
  assert.equal(realMcp.inFlight, 1);
  await socketClient.close(); socketClient = undefined;
  clientSocket.destroy();
  await until(() => !!realMcp.disconnectTask, "actual MCP transport disconnect");
  await sleep(100);
  assert.equal(realMcp.inFlight, 1);
  adopted.storage.assertWorkspaceLease();
  releaseInventory(); releaseInventory = undefined;
  await locked;
  await assert.rejects(realMcp.disconnectTask, /unconfirmed socket close/);
  assert(await interrupted instanceof Error);
  assert(await denied instanceof Error);
  assert.equal(realMcp.inFlight, 0);
  assert.equal(closeErrors.length, 1);
  adopted.storage.assertWorkspaceLease();
  await assert.rejects(acquireLinuxRootWriterFence(root, 100));
  await realMcp.close();
  assert.equal(transportCloseAttempts, 2);

  let attempts = 0;
  selected.registerChildClose(async () => { if (++attempts === 1) throw new Error("injected unresolved child"); });
  const closing = host.close();
  await sleep(100);
  assert.equal(mcpClosed, false);
  adopted.storage.assertWorkspaceLease();
  assert.throws(() => mcpContext.assertCurrent(), /closed|unavailable/);
  const whileMcpDrains = [readFileSync(parentTicks).length, readFileSync(childTicks).length];
  await sleep(150);
  assert.deepEqual([readFileSync(parentTicks).length, readFileSync(childTicks).length], whileMcpDrains);
  releaseMcp();
  await assert.rejects(closing, /child operations did not drain/);
  assert.equal(mcpClosed, true);
  await mcp.close();
  adopted.storage.assertWorkspaceLease();
  await assert.rejects(room.assertAuthority(), /revoked/);
  await assert.rejects(acquireLinuxRootWriterFence(root, 100));
  await assert.rejects(startManagedClientHostFromAdoptedRoot(options, adopted), /already claimed/);
  await assert.rejects(host.invoke("list", {}), /admission is closed/);
  const drained = [readFileSync(parentTicks).length, readFileSync(childTicks).length];
  await sleep(150);
  assert.deepEqual([readFileSync(parentTicks).length, readFileSync(childTicks).length], drained);
  await host.close(); host = undefined; released = true;
  assert.equal(attempts, 2);
  const fence = await acquireLinuxRootWriterFence(root, 1000);
  await fence.release();
});
