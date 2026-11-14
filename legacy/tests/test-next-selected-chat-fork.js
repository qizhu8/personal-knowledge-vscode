"use strict";
const assert = require("node:assert/strict");
const { randomUUID } = require("node:crypto");
const fs = require("node:fs");
const { createServer } = require("node:http");
const Module = require("node:module");
const path = require("node:path");
const { test } = require("node:test");
const { create: createLegacyFixture } = require("./next-trial-electron/api-chat-fixture.cjs");

const extension = process.env.PKM_TRIAL_EXTENSION_DIST;
const server = process.env.PKM_TRIAL_SERVER_DIST;
const oldExtension = process.env.PKM_TEST_LEGACY_CHAT_EXTENSION;
if (!extension || !server || !oldExtension) throw Error("Run with isolated compiled and original legacy fixtures.");
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(read) {
  const end = Date.now() + 15000;
  for (;;) {
    const value = await read();
    if (value) return value;
    if (Date.now() >= end) throw new Error("Selected Chat test timed out.");
    await delay(25);
  }
}

for (const provider of ["http", "http-ui", "http-image", "vscode", "vscode-image", "vscode-image-plain", "vscode-image-unsupported", "vscode-image-malformed", "vscode-image-count-failed", "vscode-image-count-cancel", "vscode-cancel", "vscode-opening-cancel", "vscode-denied", "vscode-invalid", "vscode-text", "vscode-unsolicited", "sdk", "sdk-image", "sdk-invalid", "sdk-denied", "sdk-cancel", "sdk-user-deny", "sdk-approval-cancel", "sdk-stop-fails", "sdk-create-cancel", "sdk-remember", ...(process.env.PKM_REAL_SDK_MODULES ? ["sdk-real", "sdk-real-deny", "sdk-real-cancel", "sdk-real-remember"] : [])]) test(`real parent-fork selected Chat uses ${provider} model, user approval and revoke ACK`, { timeout: 60000 }, async t => {
  const directory = path.resolve(".migration-test-work", `selected-chat-fork-${randomUUID()}`);
  const root = path.join(directory, "old"), parent = path.join(directory, "next");
  fs.mkdirSync(root, { recursive: true, mode: 0o700 });
  fs.mkdirSync(parent, { mode: 0o700 });
  const previous = process.umask(0o077);
  let descriptor;
  try { descriptor = createLegacyFixture({ extension: oldExtension, root }); } finally { process.umask(previous); }
  const identity = { namespace: descriptor.namespace, chatId: descriptor.inline };
  const archiveFile = path.join(descriptor.state, "api-chats", identity.namespace, `${identity.chatId}.json`);
  if (provider.endsWith("-remember")) {
    const oldChat = JSON.parse(fs.readFileSync(archiveFile, "utf8"));
    oldChat.permissionMode = "allow-all";
    oldChat.permissionGrants = [`tool:${require("node:crypto").createHash("sha256")
      .update(JSON.stringify(["builtin", "run_process"])).digest("hex")}`];
    fs.writeFileSync(archiveFile, JSON.stringify(oldChat), { mode: 0o600 });
  }
  const original = fs.readFileSync(archiveFile);
  const program = fs.realpathSync(process.execPath), script = path.join(directory, "command.cjs"), ticks = path.join(directory, "ticks");
  const remembering = provider.endsWith("-remember"), realSdk = provider.startsWith("sdk-real");
  fs.writeFileSync(script, remembering
    ? `require('node:fs').appendFileSync(${JSON.stringify(ticks)},'x');`
    : `const fs=require('node:fs');setInterval(()=>fs.appendFileSync(${JSON.stringify(ticks)},'x'),20);`, { mode: 0o600 });
  const secret = `fixture-only-${randomUUID()}`;
  let calls = 0;
  const model = createServer(async (req, res) => {
    assert.equal(req.headers.authorization, `Bearer ${secret}`);
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const body = JSON.parse(Buffer.concat(chunks).toString());
    calls++;
    const done = body.messages.some(message => message.role === "tool");
    const delta = done ? { content: "Process started." } : { tool_calls: [{ index: 0, id: "run", type: "function",
      function: { name: "run_process", arguments: JSON.stringify({ program, arguments: [script],
        cwd: path.join(parent, "workspace"), timeoutSeconds: 60, background: true, idempotency_key: "independent-fork-test" }) } }] };
    res.writeHead(200, { "content-type": "text/event-stream" });
    res.end(`data: ${JSON.stringify({ choices: [{ index: 0, delta, finish_reason: null }] })}\n\n`
      + `data: ${JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: done ? "stop" : "tool_calls" }] })}\n\ndata: [DONE]\n\n`);
  });
  await new Promise(resolve => model.listen(0, "127.0.0.1", resolve));
  const file = path.join(extension, "runtime/next-managed-client.js");
  delete require.cache[require.resolve(file)];
  delete require.cache[require.resolve(path.join(extension, "runtime/next-vscode-model-bridge.js"))];
  const originalLoad = Module._load;
  class TextPart { constructor(value) { this.value = value; } }
  class DataPart { constructor(data, mimeType) { Object.assign(this, { data, mimeType }); } }
  class ToolCallPart { constructor(callId, name, input) { Object.assign(this, { callId, name, input }); } }
  class ToolResultPart { constructor(callId, content) { Object.assign(this, { callId, content }); } }
  class CancellationTokenSource {
    listeners = [];
    token = { isCancellationRequested: false, onCancellationRequested: listener => this.listeners.push(listener) };
    cancel() { this.token.isCancellationRequested = true; for (const listener of this.listeners) listener(); }
    dispose() {}
  }
  const vscodeFixture = {
    workspace: {
      isTrusted: true,
      onDidChangeConfiguration() { return { dispose() {} }; },
      onDidChangeWorkspaceFolders() { return { dispose() {} }; },
    }, CancellationTokenSource, LanguageModelTextPart: TextPart, LanguageModelDataPart: DataPart, LanguageModelToolCallPart: ToolCallPart,
    LanguageModelToolResultPart: ToolResultPart, LanguageModelChatMessage: {
      User: content => ({ role: "user", content }), Assistant: content => ({ role: "assistant", content }),
    },
  };
  let Client, createProfile, secretChanged;
  try {
    Module._load = function (name, ...args) {
      if (name === "vscode") return vscodeFixture;
      if (name === "./next-payload-verifier") return {
        verifyNextPayload: () => ({ root: server, entry: path.join(server, "managed-client-child.js") }),
      };
      return originalLoad.call(this, name, ...args);
    };
    Client = require(file).NextManagedClient;
    createProfile = require(path.join(extension, "runtime/next-chat-profile-authority.js")).createNextChatProfileAuthority;
  } finally { Module._load = originalLoad; }
  let client = new Client();
  t.after(async () => {
    if (!client.isStopped()) await client.close().catch(() => {});
    model.closeAllConnections(); await new Promise(resolve => model.close(resolve));
    fs.rmSync(directory, { recursive: true, force: true });
  });
  const workspaceId = await client.start(directory, parent, program, root);
  const profileSecrets = new Map();
  const secrets = { onDidChange(listener) { secretChanged = listener; return { dispose() {} }; },
    async get(key) { return profileSecrets.get(key); },
    async store(key, value) { profileSecrets.set(key, value); secretChanged?.({ key }); },
    async delete(key) { profileSecrets.delete(key); secretChanged?.({ key }); } };
  let profile = createProfile({ root: fs.realpathSync(root), workspaceId,
    currentRoot: () => fs.realpathSync(root), clientCurrent: () => client.ownsWorkspace(workspaceId),
    secrets });
  let owner = await client.selectChatOwner(profile, error => { throw error; });
  assert((await client.listSelectedChats(owner)).some(chat => chat.chatId === identity.chatId));
  let observedToken, countCalls = 0, sdkAborts = 0, sdkStops = 0, sdkCallbacks = 0, sdkCallbackResults = 0, sdkAbortFails = true;
  let sdkReleaseCreation;
  const isSdk = provider.startsWith("sdk");
  const nativeModel = { vendor: "fixture", id: "fake-model", name: "Fixture", maxInputTokens: 16384,
    maxOutputTokens: 1024, capabilities: { toolCalling: !["vscode-text", "vscode-unsolicited"].includes(provider),
      imageInput: ["vscode-image", "vscode-image-plain", "vscode-image-malformed", "vscode-image-count-failed", "vscode-image-count-cancel"].includes(provider) },
    async countTokens(_entry, token) {
      countCalls++; observedToken = token;
      if (provider === "vscode-image-count-cancel") await new Promise(resolve => token.onCancellationRequested(resolve));
      return provider === "vscode-image-count-failed" ? NaN : 100;
    },
    async sendRequest(prompt, options, token) {
      assert.equal(token.isCancellationRequested, false);
      if (["vscode-text", "vscode-unsolicited", "vscode-image-plain"].includes(provider)) assert.equal(options.tools, undefined);
      else assert.equal(options.tools.length, 4);
      calls++;
      if (provider === "vscode-image" || provider === "vscode-image-plain") {
        const parts = prompt.flatMap(message => Array.isArray(message.content) ? message.content : []);
        const images = parts.filter(part => part instanceof DataPart);
        assert.equal(images.length, 1);
        assert.equal(images[0].mimeType, "image/png");
        assert.deepEqual(Buffer.from(images[0].data), Buffer.from(image.dataBase64, "base64"));
      }
      observedToken = token;
      if (provider === "vscode-text" || provider === "vscode-image-plain")
        return { stream: (async function* () { yield new TextPart("Text only."); })() };
      if (provider === "vscode-denied") throw Object.assign(new Error(`private diagnostic ${secret}`), { code: "NoPermissions" });
      if (provider === "vscode-opening-cancel") {
        await new Promise(resolve => token.onCancellationRequested(resolve));
        throw new Error("cancelled");
      }
      if (provider === "vscode-cancel") return { stream: (async function* () {
        await new Promise(resolve => token.onCancellationRequested(resolve));
      })() };
      const done = prompt.some(message => Array.isArray(message.content) && message.content.some(part => part instanceof ToolResultPart));
      const part = done ? new TextPart("Process started.") : new ToolCallPart("run", provider === "vscode-invalid" ? "forbidden_command" : "run_process", {
        program, arguments: [script], cwd: path.join(parent, "workspace"),
        timeoutSeconds: 60, background: true, idempotency_key: "independent-fork-test",
      });
      return { stream: (async function* () { yield part; })() };
    } };
  if (isSdk) Object.assign(nativeModel, { vendor: "copilot-sdk", family: "fixture", version: "fixture",
    capabilities: { toolCalling: true, imageInput: provider === "sdk-image" }, copilotSdk: { routed: false } });
  const sdkResource = {
    async token() { return provider === "sdk-denied" ? undefined : secret; },
    async dispose() { sdkStops++; },
    async client() { return { sdk: { defineTool(name, config) { return { name, ...config }; } }, client: {
      async createSession(config) {
        if (provider === "sdk-create-cancel") await new Promise(resolve => { sdkReleaseCreation = resolve; });
        let listener;
        return {
          sessionId: randomUUID(), on(value) { listener = value; return () => { listener = undefined; }; },
          async send(request) {
            calls++;
            if (provider === "sdk-cancel") return "sent";
            if (provider === "sdk-image")
              assert.deepEqual(request.attachments, [{ type: "blob", data: image.dataBase64, mimeType: image.mimeType, displayName: image.label }]);
            const done = request.prompt.includes('"role":"tool"');
            setImmediate(() => {
              if (!listener) return;
              if (done) {
                listener({ type: "assistant.message", data: { messageId: "finish", content: "Process started.", toolRequests: [] } });
                listener({ type: "session.idle" });
              } else {
                listener({ type: "assistant.message", data: { messageId: "call", content: "", toolRequests: [{
                  toolCallId: "run", name: provider === "sdk-invalid" ? "forbidden_command" : "run_process",
                  arguments: { program, arguments: [script], cwd: path.join(parent, "workspace"), timeoutSeconds: 60,
                    ...(provider === "sdk-remember" ? { background: false } : { background: true, idempotency_key: "independent-fork-test" }) },
                }] } });
                if (provider !== "sdk-invalid") {
                  sdkCallbacks++;
                  void config.tools[0].handler({}, { toolCallId: "run" }).then(result => {
                    if (JSON.parse(result).error === "Not executed in the SDK session.") sdkCallbackResults++;
                  });
                }
              }
            });
            return "sent";
          },
          async abort() { sdkAborts++; if (provider === "sdk-stop-fails" && sdkAbortFails) throw Error(`private diagnostic ${secret}`); },
          async disconnect() {},
        };
      },
      async deleteSession() {},
    } }; },
  };
  let realTransport, sdkClient;
  if (provider.startsWith("sdk-real")) {
    const sdk = require(path.join(process.env.PKM_REAL_SDK_MODULES, "@github/copilot-sdk"));
    const rpc = require(path.join(process.env.PKM_REAL_SDK_MODULES, "vscode-jsonrpc/node"));
    const { localSdkTransport } = require("./next-trial-electron/sdk-local-transport.cjs");
    realTransport = await localSdkTransport({ rpc, program, args: [script], cwd: path.join(parent, "workspace"),
      mode: provider === "sdk-real-cancel" ? "cancel" : remembering ? "foreground" : "normal" });
    sdkClient = new sdk.CopilotClient({ connection: sdk.RuntimeConnection.forUri(realTransport.url), mode: "empty" });
    await sdkClient.start();
    const track = (array, callback) => {
      const push = array.push;
      array.push = function (...items) { callback(...items); return push.apply(this, items); };
    };
    track(realTransport.state.sends, () => { calls++; });
    track(realTransport.state.aborts, () => { sdkAborts++; });
    track(realTransport.state.callbacks, callback => { sdkCallbacks++; if (callback.afterAbort) sdkCallbackResults++; });
    Object.assign(sdkResource, {
      async token() { return "fixture-only-token"; },
      async client() { return { sdk, client: sdkClient }; },
      async dispose() { sdkStops++; await sdkClient.stop(); },
    });
    t.after(async () => { await sdkClient.stop().catch(() => {}); await realTransport.close(); });
  }
  let sdkModule;
  const selectedModel = provider.startsWith("http")
    ? { provider: "openai-compatible", endpoint: `http://127.0.0.1:${model.address().port}/v1`, model: "fixture", apiKey: secret }
    : { provider: "vscode", endpoint: "", model: nativeModel.id, apiKey: "",
      vscodeModelId: `vscode:${nativeModel.vendor}:fake-model`, vscodeTools: !["vscode-text", "vscode-unsolicited"].includes(provider),
      vscodeImageInput: nativeModel.capabilities.imageInput };
  const permissionKey = remembering ? await profile.preparePermissions(identity.namespace, identity.chatId) : undefined;
  let binding;
  try {
    Module._load = function (name, ...args) {
      if (name === "vscode") return vscodeFixture;
      if (isSdk && sdkModule && name === "../chat/api-chat-copilot-sdk") return { ...sdkModule,
        createPrivateCopilotSdk: (_host, directory) => {
          assert.equal(directory, path.join(parent, "control", `selected-sdk-${owner.session}`));
          assert.equal(fs.statSync(directory).mode & 0o777, 0o700);
          assert.equal(path.relative(root, directory).startsWith(".."), true);
          return sdkResource;
        } };
      return originalLoad.call(this, name, ...args);
    };
    if (isSdk) {
      sdkModule = require(path.join(extension, "chat/api-chat-copilot-sdk.js"));
      await client.privateCopilotSdk(owner);
    }
    binding = await client.startSelectedChat(owner, {
      chats: [identity], commands: ["vscode-text", "vscode-unsolicited"].includes(provider) ? []
        : [{ id: "node", program, cwd: path.join(parent, "workspace"), arguments: [[script]] }],
      model: { ...selectedModel, contextWindow: 16384, maxOutputTokens: 1024,
        outputTokenParameter: "max_tokens", includeUsage: false, status: "active" },
    }, !provider.startsWith("http") ? nativeModel : undefined, permissionKey);
  } finally { Module._load = originalLoad; }
  const rpc = async input => {
    const response = await fetch(`${binding.endpoint}/rpc`, { method: "POST",
      headers: { authorization: `Bearer ${binding.bearer}`, "x-pkm-native-actor": "local:owner", "content-type": "application/json" },
      body: JSON.stringify(input) });
    const result = await response.json();
    assert.equal(response.status, 200, result.error);
    return result.value;
  };
  const history = await rpc({ method: "history", ...identity });
  if (provider !== "vscode-image-plain")
    await rpc({ method: "task-control", input: { ...identity, kind: "create", title: "Test", operationId: randomUUID(),
      expectedRevision: history.taskControl.revision } });
  const image = { label: "fixture.png", mimeType: "image/png",
    dataBase64: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/l9sAAAAASUVORK5CYII=" };
  if (provider === "vscode-image-malformed") image.dataBase64 = "invalid";
  const input = { method: "continue", ...identity, operationId: randomUUID(), expectedRevision: 0, text: "Run the configured program.",
    ...(provider.includes("image") ? { images: [image] } : {}) };
  if (["http-image", "vscode-image-unsupported", "vscode-image-malformed"].includes(provider)) {
    const response = await fetch(`${binding.endpoint}/rpc`, { method: "POST",
      headers: { authorization: `Bearer ${binding.bearer}`, "x-pkm-native-actor": "local:owner", "content-type": "application/json" },
      body: JSON.stringify(input) });
    assert.notEqual(response.status, 200);
    assert.equal(calls, 0);
    assert.deepEqual(fs.readFileSync(archiveFile), original);
    await owner.revoke(); profile.dispose(); await client.close();
    return;
  }
  let uiListener, uiEvents;
  if (provider === "http-ui") {
    let shellModule, createSelectedOwnerChatViewBackend;
    const listeners = new Set(), commands = new Map(), subscriptions = [];
    let shellView, legacyLoads = 0;
    vscodeFixture.Uri = { joinPath: (uri, ...parts) => ({ fsPath: path.join(uri.fsPath, ...parts) }) };
    vscodeFixture.commands = {
      registerCommand(id, callback) { commands.set(id, callback); return { dispose() { commands.delete(id); } }; },
      async executeCommand() {},
    };
    vscodeFixture.window = {
      registerWebviewViewProvider(id, value) {
        assert.equal(id, "personalKnowledge.apiChat");
        shellView = value;
        return { dispose() {} };
      },
    };
    try {
      Module._load = function (name, ...args) {
        if (name === "vscode") return vscodeFixture;
        if (name === "./api-chat-shell") return { renderApiChat() {}, renderApiChatFailure(_view, error) { throw error; } };
        return originalLoad.call(this, name, ...args);
      };
      require(path.join(extension, "chat/native-chat-ui-experiment.js"));
    } finally { Module._load = originalLoad; }
    try {
      Module._load = function (name, ...args) {
        if (name === "vscode") return vscodeFixture;
        if (name === "../knowledge/filestore") return { getStorePath() { throw new Error("legacy Chat host must not start"); } };
        if (name === "./visualization-window") return { registerVisualizationWindow() { throw new Error("legacy visualization must not start"); } };
        return originalLoad.call(this, name, ...args);
      };
      shellModule = require(path.join(extension, "chat/api-chat-shell.js"));
      ({ createSelectedOwnerChatViewBackend } = require(path.join(extension, "chat/selected-owner-chat-ui.js")));
    } finally { Module._load = originalLoad; }
    const context = { subscriptions, extensionUri: { fsPath: path.dirname(extension) } };
    uiEvents = [];
    shellModule.registerApiChatShell(context, async () => { legacyLoads++; throw new Error("legacy writer must not start"); }, {
      async load() {
        const backend = await createSelectedOwnerChatViewBackend(context, {
          binding, connection: profile.signal, assertCurrent: owner.assertCurrent, drain: () => owner.revoke(),
        });
        t.after(() => backend.dispose());
        return backend;
      },
    });
    const view = { visible: true, onDidDispose() {}, webview: {
      cspSource: "fixture",
      asWebviewUri(uri) { return { toString() { return uri.fsPath; } }; },
      onDidReceiveMessage(listener) {
        listeners.add(listener);
        uiListener = value => { for (const current of [...listeners]) current(value); };
        return { dispose() { listeners.delete(listener); } };
      },
      async postMessage(value) { uiEvents.push(value); return true; },
    } };
    shellView.resolveWebviewView(view);
    uiListener({ type: "ready" });
    await until(() => uiEvents.find(event => event.type === "state" && event.chat.id === identity.chatId));
    assert.equal(legacyLoads, 0);
    uiListener({ type: "select", id: identity.chatId, requestId: "live-owner-selection" });
    await until(() => uiEvents.find(event => event.type === "state"
      && event.navigationRequestId === "live-owner-selection" && event.chat.id === identity.chatId));
    uiListener({ type: "send", chatId: identity.chatId, text: input.text, submissionId: input.operationId });
    await until(() => {
      const error = uiEvents.find(event => event.type === "error");
      if (error) throw new Error(error.message);
      return uiEvents.find(event => event.type === "sendAccepted" && event.submissionId === input.operationId);
    });
  } else await rpc(input);
  if (provider === "sdk-create-cancel") {
    await until(() => !!sdkReleaseCreation);
    await assert.rejects(owner.revoke(), /drain is unconfirmed/);
    assert.equal(sdkStops, 0);
    assert.equal(calls, 0);
    sdkReleaseCreation();
    await owner.revoke();
    assert.equal(sdkStops, 1);
    assert.equal(sdkAborts, 1);
    assert.deepEqual(fs.readFileSync(archiveFile), original);
    profile.dispose(); await client.close();
    return;
  }
  if (provider === "sdk-stop-fails") {
    const state = await until(async () => {
      const current = await rpc({ method: "history", ...identity });
      return current.messages.some(message => message.error?.includes("MODEL_PROVIDER_ERROR")) ? current : undefined;
    });
    assert.equal(JSON.stringify(state).includes(secret), false);
    await assert.rejects(owner.revoke(), error => /drain is unconfirmed/.test(error.message) && !error.message.includes(secret));
    assert.equal(sdkStops, 0);
    assert.equal(fs.existsSync(ticks), false);
    sdkAbortFails = false;
    await owner.revoke();
    assert.equal(sdkStops, 1);
    assert.deepEqual(fs.readFileSync(archiveFile), original);
    profile.dispose(); await client.close();
    return;
  }
  if (provider === "vscode-image-plain") {
    await rpc(input);
    const changed = await fetch(`${binding.endpoint}/rpc`, { method: "POST",
      headers: { authorization: `Bearer ${binding.bearer}`, "x-pkm-native-actor": "local:owner", "content-type": "application/json" },
      body: JSON.stringify({ ...input, images: [{ ...image, label: "different.png" }] }) });
    assert.notEqual(changed.status, 200);
    const state = await rpc({ method: "history", ...identity });
    assert.deepEqual(state.messages.find(message => message.content === input.text)?.images, [image]);
    assert.equal(calls, 1);
    assert.deepEqual(fs.readFileSync(archiveFile), original);
    await owner.revoke(); profile.dispose(); await client.close();
    return;
  }
  if (provider === "vscode-image-count-failed") {
    await until(async () => (await rpc({ method: "history", ...identity })).messages.some(message =>
      message.error?.includes("MODEL_PROVIDER_ERROR")));
    assert.equal(calls, 0);
    assert.deepEqual(fs.readFileSync(archiveFile), original);
    await owner.revoke(); profile.dispose(); await client.close();
    return;
  }
  if (provider === "vscode-text") {
    await until(async () => (await rpc({ method: "history", ...identity })).messages.some(message => message.content === "Text only."));
    assert.equal(calls, 1);
    assert.equal(fs.existsSync(ticks), false);
    assert.deepEqual(fs.readFileSync(archiveFile), original);
    await owner.revoke();
    profile.dispose();
    await client.close();
    return;
  }
  if (["vscode-denied", "vscode-invalid", "vscode-unsolicited", "sdk-denied", "sdk-invalid"].includes(provider)) {
    if (provider !== "sdk-denied") await until(() => calls > 0);
    const code = ["vscode-denied", "sdk-denied"].includes(provider) ? "MODEL_AUTHENTICATION" : "MODEL_PROVIDER_ERROR";
    const state = await until(async () => {
      const value = await rpc({ method: "history", ...identity });
      return value.messages.some(message => message.error?.includes(code)) ? value : undefined;
    });
    assert.equal(JSON.stringify(state).includes(secret), false);
    assert.equal(calls, provider === "sdk-denied" ? 0 : 1);
    assert.equal(fs.existsSync(ticks), false);
    assert.deepEqual(await rpc({ method: "process-approvals", ...identity }), []);
    assert.deepEqual(fs.readFileSync(archiveFile), original);
    await owner.revoke();
    profile.dispose();
    await client.close();
    return;
  }
  if (provider === "vscode-cancel" || provider === "vscode-opening-cancel" || provider === "vscode-image-count-cancel" || provider === "sdk-cancel" || provider === "sdk-real-cancel") {
    await until(() => provider === "vscode-image-count-cancel" ? countCalls > 0 : calls > 0);
    secretChanged({ key: "personalKnowledge.aiApiKey" });
    await owner.revoke();
    if (provider === "sdk-cancel" || provider === "sdk-real-cancel") { assert.equal(sdkAborts, 1); assert.equal(sdkStops, 1); }
    else assert.equal(observedToken.isCancellationRequested, true);
    if (provider === "vscode-image-count-cancel") assert.equal(calls, 0);
    assert.equal(fs.existsSync(ticks), false);
    assert.deepEqual(fs.readFileSync(archiveFile), original);
    profile.dispose();
    await client.close();
    return;
  }
  let prompt = await until(async () => (await rpc({ method: "process-approvals", ...identity }))[0]);
  assert.equal(fs.existsSync(ticks), false);
  if (isSdk) { assert.equal(sdkCallbacks, 1); assert.equal(sdkCallbackResults, 1); assert.equal(sdkAborts, 1); }
  if (provider === "sdk-approval-cancel") {
    profile.dispose(); await owner.revoke();
    assert.equal(fs.existsSync(ticks), false);
    assert.equal(calls, 1);
    assert.deepEqual(fs.readFileSync(archiveFile), original);
    await client.close();
    return;
  }
  if (provider === "sdk-user-deny" || provider === "sdk-real-deny") {
    await rpc({ method: "process-approval-decide", ...identity, id: prompt.id, choice: "deny" });
    await until(async () => !(await rpc({ method: "process-approvals", ...identity })).length);
    await delay(200);
    assert.equal(fs.existsSync(ticks), false);
    assert.deepEqual(fs.readFileSync(archiveFile), original);
    await owner.revoke(); profile.dispose(); await client.close();
    return;
  }
  if (remembering) {
    await rpc({ method: "process-approval-decide", ...identity, id: prompt.id, choice: "approve-once" });
    await until(() => fs.existsSync(ticks));
    const onceHistory = await until(async () => {
      const current = await rpc({ method: "history", ...identity });
      return current.messages.some(message => message.content === (realSdk ? "SDK_FIXTURE_SUCCESS" : "Process started.")) ? current : undefined;
    });
    await rpc({ method: "continue", ...identity, operationId: randomUUID(), expectedRevision: onceHistory.revision, text: "Ask again." });
    prompt = await until(async () => (await rpc({ method: "process-approvals", ...identity }))[0]);
    assert.equal(fs.readFileSync(ticks).length, 1);
  }
  if (provider === "http-ui") {
    await until(() => uiEvents.some(event => event.type === "state" && event.approvals.some(item => item.id === prompt.id)));
    uiListener({ type: "approval", id: prompt.id, value: "approve" });
  } else await rpc({ method: "process-approval-decide", ...identity, id: prompt.id, choice: "approve" });
  if (remembering) {
    await until(() => fs.readFileSync(ticks).length === 2);
    await until(async () => (await rpc({ method: "history", ...identity })).messages.filter(message => message.content === (realSdk ? "SDK_FIXTURE_SUCCESS" : "Process started.")).length >= 2);
  }
  await until(() => fs.existsSync(ticks));
  await until(() => calls >= 2);
  await until(async () => {
    const state = await rpc({ method: "history", ...identity });
    if (provider === "vscode-image" || provider === "sdk-image")
      assert.deepEqual(state.messages.find(message => message.content === input.text)?.images, [image]);
    const failure = state.messages.find(message => message.error?.includes("MODEL_"));
    if (failure) throw new Error(`Selected model failed: ${failure.error}`);
    return state.messages.some(message => message.content === (realSdk ? "SDK_FIXTURE_SUCCESS" : "Process started."));
  });
  if (remembering) {
    const { saveSelectedChatRecoveryPin } = require(path.join(extension, "runtime/next-selected-chat-recovery.js"));
    const pin = await saveSelectedChatRecoveryPin(secrets, { workspace: path.join(parent, "workspace"),
      legacyRoot: root, workspaceId, ...identity, snapshotRoot: binding.root, sourceFingerprint: binding.sourceFingerprint });
    const openAgain = async () => {
      await owner.revoke(); profile.dispose(); await client.close();
      client = new Client();
      await client.resumeSelectedChat(directory, pin, program, root);
      profile = createProfile({ root, workspaceId, currentRoot: () => root,
        clientCurrent: () => client.ownsWorkspace(workspaceId), secrets });
      owner = await client.selectChatOwner(profile, error => { throw error; });
      const currentKey = await profile.preparePermissions(identity.namespace, identity.chatId);
      if (sdkClient) await sdkClient.start();
      try {
        Module._load = function (name, ...args) {
          if (name === "vscode") return vscodeFixture;
          if (name === "../chat/api-chat-copilot-sdk") return { ...sdkModule, createPrivateCopilotSdk: () => sdkResource };
          return originalLoad.call(this, name, ...args);
        };
        await client.privateCopilotSdk(owner);
        binding = await client.startSelectedChat(owner, { chats: [identity],
          commands: [{ id: "node", program, cwd: path.join(parent, "workspace"), arguments: [[script]] }],
          model: { ...selectedModel, contextWindow: 16384, maxOutputTokens: 1024,
            outputTokenParameter: "max_tokens", includeUsage: false, status: "active" } }, nativeModel, currentKey);
      } finally { Module._load = originalLoad; }
    };
    const firstCalls = calls;
    await openAgain();
    const resumed = await rpc({ method: "history", ...identity });
    await rpc({ method: "continue", ...identity, operationId: randomUUID(), expectedRevision: resumed.revision, text: "Run again." });
    await until(() => fs.readFileSync(ticks).length === 3);
    await until(async () => (await rpc({ method: "history", ...identity })).messages.filter(message => message.content === (realSdk ? "SDK_FIXTURE_SUCCESS" : "Process started.")).length >= 3);
    assert.deepEqual(await rpc({ method: "process-approvals", ...identity }), []);
    assert.equal(calls, firstCalls + 2);
    await owner.revoke();
    await profile.resetPermissions();
    await openAgain();
    const resetHistory = await rpc({ method: "history", ...identity });
    await rpc({ method: "continue", ...identity, operationId: randomUUID(), expectedRevision: resetHistory.revision, text: "Run after reset." });
    const resetPrompt = await until(async () => (await rpc({ method: "process-approvals", ...identity }))[0]);
    await rpc({ method: "process-approval-decide", ...identity, id: resetPrompt.id, choice: "deny" });
    await until(async () => !(await rpc({ method: "process-approvals", ...identity })).length);
    assert.equal(fs.readFileSync(ticks).length, 3);
    assert.deepEqual(fs.readFileSync(archiveFile), original);
    await owner.revoke(); profile.dispose(); await client.close();
    return;
  }
  if (provider === "sdk-real") {
    assert.notEqual(realTransport.state.sends[0].sessionId, realTransport.state.sends[1].sessionId);
    const messages = realTransport.state.sends[1].prompt.split("\n").map(line => JSON.parse(line));
    assert(messages.some(message => message.role === "user" && message.content === input.text));
    const result = messages.find(message => message.role === "tool" && message.tool_call_id === "real-sdk-tool");
    const record = JSON.parse(result.content);
    assert.equal(record.schema, "pkm.chat.process/v1");
    assert.match(record.handle, /^process_[a-f0-9]{64}$/);
    assert.equal(record.spec.program, program);
  }
  secretChanged({ key: "personalKnowledge.aiApiKey" });
  assert.equal(profile.signal.aborted, true);
  await owner.revoke();
  if (isSdk) { assert.equal(sdkStops, 1); assert(sdkAborts >= 1); }
  profile.dispose();
  const stopped = fs.readFileSync(ticks).length;
  await delay(150);
  assert.equal(fs.readFileSync(ticks).length, stopped);
  assert(calls >= 1);
  assert.deepEqual(fs.readFileSync(archiveFile), original);
  const checkNoSecret = directory => {
    for (const name of fs.readdirSync(directory)) {
      const entry = path.join(directory, name), stat = fs.lstatSync(entry);
      if (stat.isDirectory()) checkNoSecret(entry);
      else if (stat.isFile()) assert.equal(fs.readFileSync(entry).includes(secret), false, `Credential persisted in ${entry}`);
    }
  };
  checkNoSecret(parent);
  await client.close();
});
