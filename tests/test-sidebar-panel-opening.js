#!/usr/bin/env node
const assert = require("assert");
const fs = require("fs");
const path = require("path");

const root = path.join(__dirname, "..");
const extensionSource = fs.readFileSync(path.join(root, "src", "extension.ts"), "utf8");
const startupSource = fs.readFileSync(path.join(root, "tests", "extension-startup", "index.js"), "utf8");

const commandRegistration = extensionSource.indexOf('registerCommand("personalKnowledge.open", openMainPanel)');
const visibilityRegistration = extensionSource.indexOf("treeView.onDidChangeVisibility");
assert(commandRegistration >= 0 && commandRegistration < visibilityRegistration,
  "the open command must be registered before sidebar visibility can trigger it");
assert.match(extensionSource, /if \(treeView\.visible\) void openVisibleSidebar\(\)/,
  "an already-visible sidebar must open the main panel after activation");
assert.match(startupSource, /executeCommand\("workbench\.view\.extension\.personalKnowledgeBar"\)/,
  "startup coverage must open PKM through its Activity Bar container");
assert.doesNotMatch(startupSource, /if \(expectPanel\) await vscode\.commands\.executeCommand\("personalKnowledge\.open"\)/,
  "startup coverage must not bypass sidebar visibility handling");
assert.match(extensionSource, /vscode\.Uri\.joinPath\(context\.extensionUri, "dist", "webview"\)/,
  "remote Webviews must resolve packaged UI resources from context.extensionUri");
assert.doesNotMatch(extensionSource, /asWebviewUri\(vscode\.Uri\.file\(path\.join\(webviewDir/,
  "extension-owned Webview resources must not be reduced to local file URIs");

const panelDisposeStart = extensionSource.indexOf("target.onDidDispose(() => {");
const panelDisposeClosing = "}, undefined, context.subscriptions);";
const panelDisposeEnd = extensionSource.indexOf(panelDisposeClosing, panelDisposeStart);
assert(panelDisposeStart >= 0 && panelDisposeEnd > panelDisposeStart);
const disposedPanelMessages = [];
const clearedPanelTimers = [];
let panelDisposeCallback;
const disposedPanel = {
  get visible() { throw new Error("Webview is disposed"); },
  get active() { throw new Error("Webview is disposed"); },
  onDidDispose(callback) { panelDisposeCallback = callback; },
};
const panelTimer = {};
const panelDisposeSandbox = {
  target: disposedPanel, panel: disposedPanel, context: { subscriptions: [] },
  session: { ready:true, recoveryTimer:panelTimer, lastHeartbeat:Date.now(), lastDiagnostic:"fixture diagnostic" },
  panels: { remove(target) { assert.strictEqual(target, disposedPanel); } },
  clearTimeout: timer => clearedPanelTimers.push(timer),
  loadProfiler: { record() {} },
  log: { info: message => disposedPanelMessages.push(message) },
};
require("vm").runInNewContext(extensionSource.slice(panelDisposeStart, panelDisposeEnd + panelDisposeClosing.length), panelDisposeSandbox);
assert.strictEqual(typeof panelDisposeCallback, "function");
assert.doesNotThrow(() => panelDisposeCallback(), "panel disposal must not read invalidated Webview getters");
assert.strictEqual(panelDisposeSandbox.panel, disposedPanel, "disposing a tab must not clear another active tab");
assert.strictEqual(panelDisposeSandbox.session.ready, false);
assert.strictEqual(panelDisposeSandbox.session.recoveryTimer, undefined);
assert.deepStrictEqual(clearedPanelTimers, [panelTimer]);
assert.match(disposedPanelMessages[0], /panel disposed heartbeatAgeMs=\d+ lastDiagnostic=fixture diagnostic/);

const compiled = fs.readFileSync(path.join(root, "dist", "extension.js"), "utf8");
const activation = compiled.indexOf("async function activate(context)");
const chatStart = compiled.indexOf("let apiChat;", activation);
const chatEnd = compiled.indexOf("githubSyncDiagnostics.init(context);", chatStart);
assert(activation >= 0 && chatStart > activation && chatEnd > chatStart);
assert.doesNotMatch(compiled.slice(0, activation), /require\("\.\/chat\/api-chat-view"\)/,
  "Chat must not load before the guarded activation path");
const messages = [];
let deferredLoad;
const shellProvider = { isBusy: false };
const sandbox = {
  context: {}, __importStar: value => value,
  require: () => { throw new Error("fixture Chat dependency failure"); },
  api_chat_shell_1: { registerApiChatShell: (_context, load) => { deferredLoad = load; return shellProvider; } },
  log: { error: message => messages.push(message) },
  vscode: { window: { showErrorMessage: message => { messages.push(message); return Promise.resolve(); } } },
};
require("vm").runInNewContext(`(async () => { ${compiled.slice(chatStart, chatEnd)} return apiChat; })()`, sandbox)
  .then(async provider => {
    assert.strictEqual(provider, shellProvider);
    assert.strictEqual(messages.length, 0, "activation must not import the heavy Chat backend");
    await assert.rejects(deferredLoad(), /fixture Chat dependency failure/);

    let registered;
    let commands = 0;
    const exports = {};
    const vscode = {
      workspace: { workspaceFolders: [], onDidChangeConfiguration: () => ({ dispose() {} }) },
      Uri: { joinPath: (uri, ...parts) => ({ fsPath: path.join(uri.fsPath, ...parts) }) },
      window: { registerWebviewViewProvider: (_id, value) => { registered = value; return { dispose() {} }; } },
      commands: { registerCommand: () => { commands++; return { dispose() {} }; } },
    };
    require("vm").runInNewContext(fs.readFileSync(path.join(root, "dist/chat/api-chat-shell.js"), "utf8"), {
      exports, require: name => {
        if (name === "vscode") return vscode;
        if (name.endsWith("/filestore")) return { getStorePath: () => "" };
        if (name.endsWith("/extension-host-runtime")) return {};
        if (name === "./visualization-window") return { registerVisualizationWindow() {} };
        if (name === "./agent-control") return require("../dist/chat/agent-control");
        return require(name);
      },
      setTimeout: callback => queueMicrotask(callback),
      setInterval: () => ({ unref() {} }), clearInterval() {},
    });
    let loads = 0;
    let handoff;
    exports.registerApiChatShell({ extensionUri: { fsPath: root }, subscriptions: [] }, async () => {
      loads++;
      if (loads === 1) throw new Error("fixture backend unavailable");
      return { attachWebviewView: (view, retainHtml) => { handoff = { view, retainHtml }; }, isBusy: false };
    });
    assert.strictEqual(commands, 5);
    assert.strictEqual(loads, 0);
    const listeners = new Set();
    const posted = [];
    const view = { webview: {
      cspSource: "fixture", asWebviewUri: uri => ({ toString: () => uri.fsPath }),
      onDidReceiveMessage: callback => { listeners.add(callback); return { dispose: () => listeners.delete(callback) }; },
      postMessage: message => { posted.push(message); },
    }, onDidDispose() {} };
    registered.resolveWebviewView(view);
    const html = view.webview.html;
    assert(html.includes('id="pkm-chat-loading"'), "Chat must render before the backend loads");
    const emit = async message => { for (const callback of [...listeners]) await callback(message); };
    await emit({ type: "hostHealth", id: "fixture-ping" });
    assert.strictEqual(posted[0].id, "fixture-ping");
    assert.strictEqual(loads, 0, "heartbeat must not load the backend");
    await emit({ type: "ready" });
    assert.strictEqual(posted.at(-1).type, "initializationError");
    assert(posted.at(-1).message.includes("fixture backend unavailable"));
    assert.strictEqual(view.webview.html, html, "failed initialization must preserve the page");
    await emit({ type: "send", text: "must not replay" });
    assert.strictEqual(loads, 1);
    await emit({ type: "ready" });
    assert.strictEqual(loads, 2);
    assert.strictEqual(handoff.view, view);
    assert.strictEqual(handoff.retainHtml, true);
    assert.strictEqual(view.webview.html, html, "successful handoff must preserve the page and draft");
    assert.strictEqual(listeners.size, 0);

    const lifecycleContext = { extensionUri: { fsPath: root }, subscriptions: [] };
    const attachedViews = [];
    let lifecycleLoads = 0;
    let releaseBackend;
    const backendGate = new Promise(resolve => { releaseBackend = resolve; });
    const lifecycleBackend = {
      isBusy: false,
      attachWebviewView: (nextView, retainHtml) => {
        assert(!nextView.closed, "a disposed view must never receive the backend");
        attachedViews.push({ view: nextView, retainHtml });
      },
      resolveWebviewView(nextView) {
        exports.renderApiChat(nextView, lifecycleContext);
        this.attachWebviewView(nextView, false);
      },
    };
    exports.registerApiChatShell(lifecycleContext, async () => {
      lifecycleLoads++;
      return backendGate;
    });
    const createLifecycleView = () => {
      const callbacks = new Set();
      const disposals = [];
      const nextView = { closed: false, webview: {
        ...view.webview,
        onDidReceiveMessage: callback => {
          callbacks.add(callback);
          return { dispose: () => callbacks.delete(callback) };
        },
      }, onDidDispose: callback => { disposals.push(callback); } };
      return { view: nextView, callbacks,
        ready: async () => { for (const callback of [...callbacks]) await callback({ type: "ready" }); },
        close: () => { nextView.closed = true; for (const callback of disposals) callback(); },
      };
    };
    const closingView = createLifecycleView();
    registered.resolveWebviewView(closingView.view);
    const pendingReady = closingView.ready();
    await Promise.resolve(); await Promise.resolve();
    assert.strictEqual(lifecycleLoads, 1);
    closingView.close();
    const replacementView = createLifecycleView();
    registered.resolveWebviewView(replacementView.view);
    const replacementReady = replacementView.ready();
    releaseBackend(lifecycleBackend);
    await Promise.all([pendingReady, replacementReady]);
    assert.strictEqual(lifecycleLoads, 1, "reopening during initialization must share the pending backend");
    assert.strictEqual(attachedViews.length, 1);
    assert.strictEqual(attachedViews[0].view, replacementView.view);
    assert.strictEqual(attachedViews[0].retainHtml, true);
    assert.strictEqual(closingView.callbacks.size, 0);
    assert.strictEqual(replacementView.callbacks.size, 0);
    replacementView.close();
    for (let iteration = 0; iteration < 20; iteration++) {
      const reopened = createLifecycleView();
      registered.resolveWebviewView(reopened.view);
      assert(reopened.view.webview.html.includes('id="pkm-chat-loading"'));
      await reopened.ready();
      assert.strictEqual(reopened.callbacks.size, 0);
      reopened.close();
    }
    assert.strictEqual(lifecycleLoads, 1, "repeated view recreation must not reload the backend");
    assert.strictEqual(attachedViews.length, 21);
    for (const subscription of lifecycleContext.subscriptions) subscription.dispose();

    const backendCompiled = fs.readFileSync(path.join(root, "dist/chat/api-chat-view.js"), "utf8");
    const registrationStart = backendCompiled.indexOf("function registerApiChat(");
    const registrationEnd = backendCompiled.indexOf("\nclass ApiChatView", registrationStart);
    assert(registrationStart >= 0 && registrationEnd > registrationStart);
    const registration = backendCompiled.slice(registrationStart, registrationEnd);
    async function activationRegistrationTest(activationCode) {
      const providers = new Map();
      const commandNames = new Set();
      const disposals = [];
      const instances = [];
      const registrationCalls = [];
      const integrationContext = { extensionUri: { fsPath: root }, subscriptions: [] };
      let modelListeners = 0;
      const integrationHost = {
        ...vscode,
        window: { registerWebviewViewProvider: (id, value) => {
          if (providers.has(id)) throw new Error(`View provider for '${id}' already registered`);
          providers.set(id, value);
          return { dispose: () => providers.delete(id) };
        } },
        commands: { registerCommand: name => {
          assert(!commandNames.has(name), `Command already registered: ${name}`);
          commandNames.add(name);
          return { dispose: () => commandNames.delete(name) };
        } },
        lm: { onDidChangeChatModels: () => { modelListeners++; return { dispose() {} }; } },
      };
      const integrationShell = {};
      require("vm").runInNewContext(fs.readFileSync(path.join(root, "dist/chat/api-chat-shell.js"), "utf8"), {
        exports: integrationShell,
        require: name => name === "vscode" ? integrationHost : name.endsWith("/filestore") ? { getStorePath: () => "" } : name.endsWith("/extension-host-runtime") ? {} : name === "./agent-control" ? require("../dist/chat/agent-control") : name === "./visualization-window" ? { registerVisualizationWindow() {} } : require(name),
        setTimeout: callback => queueMicrotask(callback),
        setInterval: () => ({ unref() {} }), clearInterval() {},
      });
      const registrationSandbox = {
        vscode: integrationHost, api_chat_shell_1: integrationShell,
        ApiChatView: class {
          constructor() { this.isBusy = false; instances.push(this); }
          attachWebviewView(nextView, retainHtml) { this.attached = { view: nextView, retainHtml }; }
          dispose() { disposals.push(this); }
        },
      };
      require("vm").runInNewContext(registration, registrationSandbox);
      const backendModule = { registerApiChat: (...args) => {
        registrationCalls.push(args);
        return registrationSandbox.registerApiChat(...args);
      } };
      await require("vm").runInNewContext(`(async () => { ${activationCode} return apiChat; })()`, {
        ...sandbox, context: integrationContext, api_chat_shell_1: integrationShell,
        retrieval_snapshot_1: require("../dist/retrieval/retrieval-snapshot"),
        currentRetrievalSnapshot: () => ({ documents: [], corpus_revision: "fixture" }),
        require: name => { assert.strictEqual(name, "./chat/api-chat-view"); return backendModule; },
      });
      try {
        assert.strictEqual(registrationCalls.length, 0, "Activation must defer backend registration");
        assert.strictEqual(providers.size, 1);
        const integrationListeners = new Set();
        const integrationPosts = [];
        const integrationView = { webview: {
          ...view.webview,
          onDidReceiveMessage: callback => { integrationListeners.add(callback); return { dispose: () => integrationListeners.delete(callback) }; },
          postMessage: message => { integrationPosts.push(message); },
        }, onDidDispose() {} };
        providers.get("personalKnowledge.apiChat").resolveWebviewView(integrationView);
        const initialHtml = integrationView.webview.html;
        for (const callback of [...integrationListeners]) await callback({ type: "ready" });
        const initializationError = integrationPosts.find(message => message.type === "initializationError");
        if (initializationError) throw new Error(initializationError.message);
        assert.strictEqual(registrationCalls.length, 1);
        assert.strictEqual(registrationCalls[0][0], integrationContext);
        assert.strictEqual(typeof registrationCalls[0][1], "function");
        assert.strictEqual(registrationCalls[0][2], false, "The backend must not register another view or command facade");
        assert.strictEqual(providers.size, 1); assert.strictEqual(commandNames.size, 5);
        assert.strictEqual(modelListeners, 1, "Backend lifecycle listeners must remain registered");
        assert.strictEqual(instances[0].attached.view, integrationView);
        assert.strictEqual(instances[0].attached.retainHtml, true);
        assert.strictEqual(integrationView.webview.html, initialHtml);
        assert.strictEqual(integrationListeners.size, 0, "Only the backend may own the view after handoff");
      } finally {
        for (const subscription of integrationContext.subscriptions) subscription.dispose();
      }
      assert.strictEqual(providers.size, 0); assert.strictEqual(commandNames.size, 0);
      assert.strictEqual(disposals.length, 1);
    }
    const activationCode = compiled.slice(chatStart, chatEnd);
    await activationRegistrationTest(activationCode);
    const duplicateRegistration = activationCode.replace(/\), false\);(?=\s*\}\);)/, "));");
    assert.notStrictEqual(duplicateRegistration, activationCode, "The regression mutation must remove the backend's duplicate-registration guard");
    await assert.rejects(activationRegistrationTest(duplicateRegistration), /View provider for 'personalKnowledge\.apiChat' already registered/);
    console.log("Sidebar opening, lazy Chat loading, initialization recovery and duplicate-provider registration regression tests passed");
  }).catch(error => { console.error(error); process.exitCode = 1; });