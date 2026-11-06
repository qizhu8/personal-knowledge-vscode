const assert = require("node:assert/strict");
const { test } = require("node:test");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const Module = require("node:module");
const ts = require("typescript");
const { DiagnosticLog } = require("../dist/runtime/diagnostic-log");
const { ApiChatStore } = require("../dist/chat/api-chat-store");

const root = path.resolve(__dirname, "..");
const tick = () => new Promise(resolve => setImmediate(resolve));

function fault(code) {
  return Object.assign(new Error(`${code}: injected fixture filesystem failure`), { code });
}

function fixture(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "pkm-chat-fault-"));
  const subscriptions = [];
  const trace = [], notices = [], posts = [];
  const state = { commands: [], prepare: async () => {}, connect: async () => { throw new Error("No fixture MCP connection configured"); } };
  const host = {
    env: { language: "en" }, lm: { tools: [] },
    Uri: { joinPath: (uri, ...parts) => ({ fsPath:path.join(uri.fsPath, ...parts) }) },
    commands: { registerCommand: () => ({ dispose() {} }), executeCommand: async command => { state.commands.push(command); } },
    workspace: {
      isTrusted: true, workspaceFolders: [],
      getConfiguration: () => ({ get: (_key, fallback) => fallback }),
      onDidChangeConfiguration: () => ({ dispose() {} }),
    },
    window: {
      registerWebviewViewProvider: (_id, provider) => { state.shell = provider; return { dispose() {} }; },
      showInputBox: async () => "Renamed fixture",
      showErrorMessage: async message => { notices.push(message); },
    },
  };
  const mcp = {
    warmMcpPythonProbes: async () => {},
    managedMcpServerDirectory: () => directory,
    readManagedMcpManifest: () => ({ generation:"fixture-generation" }),
    mcpServerDefinitionData: () => ({ command:"fixture-never-executed", args:[] }),
  };
  const originalLoad = Module._load;
  let tools, managed;
  try {
    Module._load = function(name, ...args) {
      return name === "vscode" ? host : originalLoad.call(this, name, ...args);
    };
    tools = require("../dist/chat/api-chat-tools");
    managed = require("../dist/chat/api-chat-mcp");
  } finally { Module._load = originalLoad; }
  const compile = (name, shell) => {
    const filename = path.join(root, "src/chat", `${name}.ts`);
    const output = ts.transpileModule(fs.readFileSync(filename, "utf8"), {
      compilerOptions:{ target:ts.ScriptTarget.ES2020, module:ts.ModuleKind.CommonJS, esModuleInterop:true },
      fileName:filename,
    }).outputText;
    const mod = new Module(filename, module);
    mod.filename = filename;
    mod.paths = Module._nodeModulePaths(path.dirname(filename));
    mod.require = name => {
      if (name === "vscode") return host;
      if (name === "../knowledge/filestore") return { getStorePath:() => directory };
      if (name === "../mcp/mcp") return mcp;
      if (name === "./api-chat-shell") return shell;
      if (name === "./api-chat-tools") return tools;
      if (name === "./api-chat-mcp") return { ...managed, connectManagedChatMcp:(...args) => state.connect(...args) };
      if (name === "./visualization-window") return { registerVisualizationWindow() {} };
      return name.startsWith(".") ? require(path.join(root, "dist/chat", name)) : require(name);
    };
    try {
      Module._load = function(name, ...args) {
        return name === "vscode" ? host : originalLoad.call(this, name, ...args);
      };
      mod._compile(output, filename);
    } finally { Module._load = originalLoad; }
    return mod.exports;
  };
  const shell = compile("api-chat-shell");
  shell.setChatStartupTrace(message => trace.push(message));
  const { ApiChatView } = compile("api-chat-view", shell);
  const store = new ApiChatStore(path.join(directory, ".pkm", "state"), "0123456789abcdef");
  const chat = store.create();
  const context = {
    subscriptions, extensionUri:{ fsPath:root },
    workspaceState:{ get:() => chat.id, update:async () => {} },
    globalStorageUri:{ fsPath:path.join(directory, "global") },
  };
  const backend = new ApiChatView(context, undefined, () => state.prepare());
  backend.store = store;
  backend.notifyChat = (_chat, _key, _kind, message) => notices.push(message);
  let publishes = 0;
  // Isolate backend admission/error paths from unrelated rendering costs and timers.
  backend.publish = () => { publishes++; posts.push({ type:"fixture-state", chatId:backend.chat?.id }); };
  const listeners = new Set(), disposers = [];
  const view = {
    visible:true,
    webview:{
      cspSource:"fixture", html:"",
      asWebviewUri: uri => ({ toString:() => uri.fsPath }),
      postMessage: async message => { posts.push(message); },
      onDidReceiveMessage: callback => {
        listeners.add(callback);
        return { dispose:() => listeners.delete(callback) };
      },
    },
    onDidChangeVisibility: callback => { state.visibility = callback; return { dispose() {} }; },
    onDidDispose: callback => { disposers.push(callback); return { dispose() {} }; },
    emit: async message => { for (const callback of [...listeners]) await callback(message); await tick(); await tick(); },
    close: () => { for (const callback of disposers) callback(); },
  };
  t.after(() => {
    view.close();
    for (const subscription of subscriptions) subscription.dispose();
    fs.rmSync(directory, { recursive:true, force:true });
  });
  const attach = () => backend.attachWebviewView(view, true);
  const ready = async () => {
    await backend.handle({ type:"ready" }).catch(error => backend.notify(error, { type:"ready" }));
    await tick(); await tick();
  };
  return { directory, state, trace, notices, posts, store, chat, backend, view, context, shell, attach, ready,
    publishes:() => publishes,
    chatFile:path.join(directory, ".pkm/state/api-chats", store.namespace, `${chat.id}.json`),
  };
}

test("PKM-FAULT-001: failed lazy backend import reports initializationError and allows a later explicit ready retry", { timeout:15000 }, async t => {
  const f = fixture(t);
  let attempts = 0;
  f.shell.registerApiChatShell(f.context, async () => {
    if (++attempts === 1) throw new Error("Cannot find module: injected damaged Chat component");
    return { attachWebviewView() {} };
  });
  f.state.shell.resolveWebviewView(f.view);
  await f.view.emit({ type:"ready" });
  assert.match(f.posts.at(-1).message, /damaged Chat component/);
  assert.equal(f.posts.at(-1).type, "initializationError");
  assert(f.trace.some(line => line.includes("backend load started")));
  assert(f.trace.some(line => line.includes("backend load failed")));
  await f.view.emit({ type:"ready" });
  assert.equal(attempts, 2);
  assert(f.trace.some(line => line.includes("backend load completed: attempt=2")));
});

test("PKM-FAULT-002: missing Webview HTML displays independent recovery UI and a failure trace", { timeout:15000 }, async t => {
  const f = fixture(t);
  f.context.extensionUri = { fsPath:path.join(f.directory, "missing-extension") };
  f.shell.registerApiChatShell(f.context, async () => { throw new Error("Backend must not load"); });
  assert.doesNotThrow(() => f.state.shell.resolveWebviewView(f.view));
  assert.match(f.view.webview.html, /PKM Chat could not load/);
  assert.match(f.view.webview.html, /ENOENT/);
  assert.match(f.view.webview.html, /id="retry"/);
  assert.match(f.view.webview.html, /id="logs"/);
  assert(!f.view.webview.html.includes('src='));
  assert(f.trace.some(line => line.includes("interface render failed")));
  await f.view.emit({ type:"showLogs" });
  assert.deepEqual(f.state.commands, ["personalKnowledge.showLogs"]);
  f.context.extensionUri = { fsPath:root };
  await f.view.emit({ type:"ready" });
  assert.match(f.view.webview.html, /id="pkm-chat-loading"/);
});

test("PKM-FAULT-003: a halted backend times out, retries independently and disposes a late stale result", { timeout:15000 }, async t => {
  const f = fixture(t);
  const originalTimer = setTimeout;
  const deadlines = [];
  t.mock.method(globalThis, "setTimeout", (callback, ms, ...args) => {
    if (ms === 180000) { deadlines.push(ms); return originalTimer(callback, 20, ...args); }
    return originalTimer(callback, ms, ...args);
  });
  let release, attempts = 0, disposed = 0, attached = 0;
  const entered = new Promise(resolve => {
    f.shell.registerApiChatShell(f.context, signal => {
      attempts++;
      if (attempts > 1) return Promise.resolve({ attachWebviewView() { attached++; } });
      resolve();
      return new Promise(done => { release = () => {
        assert.equal(signal.aborted, true);
        done({ dispose() { disposed++; }, attachWebviewView() { throw new Error("Stale backend must not attach"); } });
      }; });
    });
  });
  f.state.shell.resolveWebviewView(f.view);
  const first = f.view.emit({ type:"ready" });
  await entered;
  await f.view.emit({ type:"hostHealth", id:"fixture-health" });
  assert(f.posts.some(post => post.type === "hostHealth"));
  await first;
  assert.match(f.posts.at(-1).message, /timed out after 3 minutes/);
  assert.equal(deadlines[0], 180000);
  assert(f.trace.some(line => line.includes("backend load failed")));
  await f.view.emit({ type:"ready" });
  assert.equal(attempts, 2);
  assert.equal(attached, 1);
  release();
  await tick(); await tick();
  assert.equal(disposed, 1);
  assert.equal(attached, 1);
});

test("PKM-FAULT-004: MCP startup rejection leaves the Chat state published and reports an error, then can retry", { timeout:15000 }, async t => {
  const f = fixture(t);
  f.state.connect = async () => { throw new Error("Injected MCP startup failure"); };
  f.backend.view = f.view;
  await f.ready();
  assert(f.publishes() > 0);
  assert(f.posts.some(post => post.type === "error" && /MCP startup failure/.test(post.message)));
  assert.equal(f.backend.pkmMcpDiscovery, undefined);
  assert.equal(f.backend.discoveries.size, 0);
  f.state.connect = async () => ({ generation:"fixture-generation", catalog:[], invoke:async () => {}, close:async () => {} });
  await f.backend.discoverPkmMcp();
  assert(f.backend.managedMcp);
  t.diagnostic("Feedback: initial Chat state plus inline MCP error; discovery resets and explicit retry succeeds.");
});

test("PKM-FAULT-005: halted MCP preparation times out, clears busy state and fences late completion before retry", { timeout:15000 }, async t => {
  const f = fixture(t);
  const originalTimer = setTimeout;
  t.mock.method(globalThis, "setTimeout", (callback, ms, ...args) => originalTimer(callback, ms === 180000 ? 20 : ms, ...args));
  let release, connections = 0;
  f.state.connect = async () => {
    connections++;
    return { generation:"fixture-generation", catalog:[], invoke:async () => {}, close:async () => {} };
  };
  f.state.prepare = () => new Promise(resolve => { release = resolve; });
  f.backend.view = f.view;
  await f.ready();
  assert(f.publishes() > 0);
  assert.equal(f.backend.discoveries.size, 1);
  assert.equal(f.backend.isBusy, true);
  await f.backend.handle({ type:"hostHealth", id:"fixture-health" });
  assert(f.posts.some(post => post.type === "hostHealth"));
  assert(!f.posts.some(post => post.type === "error" || post.type === "initializationError"));
  assert(f.trace.some(line => line === "PKM MCP preparation started"));
  await assert.rejects(f.backend.pkmMcpDiscovery, /preparation timed out after 3 minutes/);
  await tick();
  assert(f.posts.some(post => post.type === "error" && /preparation timed out/.test(post.message)));
  assert.equal(f.backend.discoveries.size, 0);
  assert.equal(f.backend.isBusy, false);
  release();
  await tick(); await tick();
  assert.equal(connections, 0);
  f.state.prepare = async () => {};
  await f.backend.discoverPkmMcp();
  assert.equal(connections, 1);
  assert.equal(f.backend.discoveries.size, 0);
});

test("PKM-FAULT-006: compatible cached MCP generation is reused; a changed generation reconnects instead of using stale tools", { timeout:15000 }, async t => {
  const f = fixture(t);
  let connections = 0, closes = 0;
  f.state.connect = async () => {
    connections++;
    return { generation:"fixture-generation", catalog:[], invoke:async () => {}, close:async () => { closes++; } };
  };
  await f.backend.discoverPkmMcp();
  await f.backend.discoverPkmMcp();
  assert.equal(connections, 1);
  f.backend.managedMcp.connection.generation = "previous-generation";
  await f.backend.discoverPkmMcp();
  assert.equal(connections, 2);
  assert.equal(closes, 1);
});

test("PKM-FAULT-007: unreadable Chat root reports initializationError rather than an empty successful library", { timeout:15000 }, async t => {
  const f = fixture(t);
  const original = fs.readdirSync;
  t.mock.method(fs, "readdirSync", (file, ...args) => {
    if (String(file) === path.join(f.directory, ".pkm/state/api-chats")) throw fault("EACCES");
    return original(file, ...args);
  });
  f.backend.view = f.view;
  await f.ready();
  assert(f.posts.some(post => post.type === "initializationError" && /EACCES/.test(post.message)));
  assert.equal(f.publishes(), 0);
});

for (const mode of ["EACCES", "corrupt-json"]) test(`PKM-FAULT-008/${mode}: unreadable Chat reports its path without deleting data or silently switching selection`, { timeout:15000 }, async t => {
  const f = fixture(t);
  f.store.create();
  const prior = fs.readFileSync(f.chatFile);
  f.state.connect = async () => ({ generation:"fixture-generation", catalog:[], invoke:async () => {}, close:async () => {} });
  const original = fs.readFileSync;
  const injection = t.mock.method(fs, "readFileSync", (file, ...args) => {
    if (String(file) === f.chatFile) {
      if (mode === "corrupt-json") return "{invalid-json";
      throw fault(mode);
    }
    return original(file, ...args);
  });
  f.backend.view = f.view;
  await f.ready();
  assert.equal(f.backend.chat, undefined);
  assert.throws(() => f.store.list(), /Cannot read Chat/);
  assert(f.posts.some(post => post.type === "initializationError" && post.message.includes(f.chatFile)));
  assert.equal(f.publishes(), 0);
  assert(original(f.chatFile).equals(prior));
  injection.mock.restore();
  await f.ready();
  assert.equal(f.backend.chat.id, f.chat.id);
});

test("PKM-FAULT-009: corrupted shared library metadata produces an explicit initialization error", { timeout:15000 }, async t => {
  const f = fixture(t);
  fs.writeFileSync(path.join(f.directory, ".pkm/state/api-chats/library.json"), "{broken");
  f.backend.view = f.view;
  await f.ready();
  assert(f.posts.some(post => post.type === "initializationError"));
  assert.equal(f.publishes(), 0);
});

for (const code of ["EACCES", "ENOSPC"]) test(`PKM-FAULT-010/${code}: Chat save ${code} is reported and preserves the committed revision`, { timeout:15000 }, async t => {
  const f = fixture(t);
  const prior = fs.readFileSync(f.chatFile);
  f.backend.initialize();
  f.backend.view = f.view;
  const original = fs.writeFileSync;
  t.mock.method(fs, "writeFileSync", (file, ...args) => {
    if (String(file).startsWith(f.chatFile + ".") && String(file).endsWith(".tmp")) throw fault(code);
    return original(file, ...args);
  });
  await f.backend.handle({ type:"rename" }).catch(error => f.backend.notify(error, { type:"rename" }));
  assert(f.posts.some(post => post.type === "error" && post.message.includes(code)));
  assert(fs.readFileSync(f.chatFile).equals(prior));
  assert.equal(f.store.load(f.chat.id, false).title, "New chat");
  assert.equal(f.publishes(), 0);
  t.diagnostic(`Feedback: raw ${code} error; previous saved Chat remains intact; failed rename is not published as successful.`);
});

test("PKM-FAULT-011: ENOSPC during segmented-history commit preserves the prior Chat and fails explicitly", { timeout:15000 }, t => {
  const f = fixture(t);
  const prior = fs.readFileSync(f.chatFile);
  f.chat.messages = [{ id:require("node:crypto").randomUUID(), role:"assistant", status:"complete", content:"x".repeat(600000) }];
  const original = fs.renameSync;
  t.mock.method(fs, "renameSync", (from, to) => {
    if (String(to).startsWith(f.directory) && String(to).endsWith(".bin")) throw fault("ENOSPC");
    return original(from, to);
  });
  assert.throws(() => f.store.save(f.chat), { code:"ENOSPC" });
  assert(fs.readFileSync(f.chatFile).equals(prior));
  assert.equal(f.store.load(f.chat.id, false).messages.length, 0);
});

for (const code of ["EACCES", "ENOSPC"]) test(`PKM-FAULT-012/${code}: diagnostic failure notifies once and retains bounded explicitly unpersisted records`, t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "pkm-log-fault-"));
  t.after(() => fs.rmSync(directory, { recursive:true, force:true }));
  const warnings = [];
  const log = new DiagnosticLog(directory, 100000, 1000, error => warnings.push(error.message));
  const original = fs.appendFileSync;
  const injection = t.mock.method(fs, "appendFileSync", (file, ...args) => {
    if (String(file).startsWith(directory + path.sep)) throw fault(code);
    return original(file, ...args);
  });
  assert.doesNotThrow(() => log.record("fixture.failure"));
  log.record("fixture.failure-again");
  assert.equal(warnings.length, 1);
  assert(warnings[0].includes(code));
  assert.equal(log.latest()[0].persisted, false);
  assert.match(log.persistenceError, /remain in memory/);
  injection.mock.restore();
  log.record("fixture.recovered");
  assert.equal(log.latest().at(-1).dropped, 2);
  assert.equal(log.latest().at(-1).persisted, true);
  assert.equal(log.persistenceError, undefined);
  assert.equal(log.latest()[0].event, "fixture.failure");
});

test("asset-independent fallback escapes errors and its retry/log buttons work without packaged scripts", t => {
  const f = fixture(t);
  f.shell.renderApiChatFailure(f.view, new Error('<script>unsafe()</script> & "broken"'));
  assert(!f.view.webview.html.includes("<script>unsafe()"));
  assert.match(f.view.webview.html, /&lt;script&gt;unsafe\(\)&lt;\/script&gt;/);
  const buttons = { retry:{}, logs:{} }, messages = [];
  const script = f.view.webview.html.match(/<script nonce="[^"]+">([\s\S]*?)<\/script>/)[1];
  require("node:vm").runInNewContext(script, {
    acquireVsCodeApi:() => ({ postMessage:message => messages.push(message.type) }),
    document:{ getElementById:id => buttons[id] },
  });
  buttons.retry.onclick();
  buttons.logs.onclick();
  assert.deepEqual(messages, ["ready", "showLogs"]);
});

test("interface failure reaches Host diagnostics before store initialization or backend loading", async t => {
  const f = fixture(t);
  const original = fs.readdirSync;
  t.mock.method(fs, "readdirSync", (file, ...args) => {
    if (String(file).startsWith(f.directory + path.sep)) throw fault("EACCES");
    return original(file, ...args);
  });
  f.backend.view = f.view;
  await f.backend.handle({ type:"interfaceError", message:"Injected damaged frontend script" });
  assert.equal(f.backend.chat, undefined);
  assert.equal(f.publishes(), 0);
  assert(f.trace.some(line => line.includes("damaged frontend script")));
  f.shell.registerApiChatShell(f.context, async () => { throw new Error("Must not load backend"); });
  f.state.shell.resolveWebviewView(f.view);
  await f.view.emit({ type:"interfaceError", message:"Injected pre-backend script failure" });
  assert(f.trace.some(line => line.includes("pre-backend script failure")));
});

test("Chat List rendering receipts reach Host diagnostics without reading Chat storage or accepting arbitrary payloads", async t => {
  const f = fixture(t);
  const original = fs.readdirSync;
  t.mock.method(fs, "readdirSync", (file, ...args) => {
    if (String(file).startsWith(f.directory + path.sep)) throw fault("EACCES");
    return original(file, ...args);
  });
  await f.backend.handle({ type:"chatListRender", params:{ phase:"started", chats:2000 } });
  await f.backend.handle({ type:"chatListRender", params:{ phase:"completed", chats:2000, elapsedMs:80 } });
  assert(f.trace.includes("PKM Chat List render started: chats=2000"));
  assert(f.trace.includes("PKM Chat List render completed: chats=2000 elapsedMs=80"));
  const count = f.trace.length;
  await f.backend.handle({ type:"chatListRender", params:{ phase:"malformed", chats:-1, secret:"must-not-be-logged" } });
  assert.equal(f.trace.length, count);
  assert.equal(f.backend.chat, undefined);
  assert.equal(f.publishes(), 0);
});

for (const missing of ["host-health.js", "api-chat.js", "api-chat-library.js", "corrupt-html"]) test(`critical asset ${missing} fails into recoverable fallback without loading the backend`, t => {
  const f = fixture(t);
  const resources = path.join(f.directory, "extension/dist/webview");
  fs.mkdirSync(resources, { recursive:true });
  fs.copyFileSync(path.join(root, "dist/webview/api-chat.html"), path.join(resources, "api-chat.html"));
  for (const name of ["host-health.js", "api-chat.js", "api-chat-library.js"]) {
    if (name !== missing) fs.writeFileSync(path.join(resources, name), "");
  }
  if (missing === "corrupt-html") fs.writeFileSync(path.join(resources, "api-chat.html"), "<corrupted>");
  f.context.extensionUri = { fsPath:path.join(f.directory, "extension") };
  let loads = 0;
  f.shell.registerApiChatShell(f.context, async () => { loads++; throw new Error("Must not initialize"); });
  f.state.shell.resolveWebviewView(f.view);
  assert.match(f.view.webview.html, /PKM Chat could not load/);
  assert.equal(loads, 0);
  assert(f.trace.some(line => line.includes("interface render failed")));
});

test("in-memory diagnostic fallback remains bounded while disk writes keep failing", t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "pkm-log-limit-"));
  t.after(() => fs.rmSync(directory, { recursive:true, force:true }));
  const log = new DiagnosticLog(directory, 100000, 1000, () => {});
  const original = fs.appendFileSync;
  t.mock.method(fs, "appendFileSync", (file, ...args) => {
    if (String(file).startsWith(directory + path.sep)) throw fault("ENOSPC");
    return original(file, ...args);
  });
  for (let index = 0; index < 250; index++) log.record("fixture.failure", { index });
  const entries = log.latest(1000);
  assert.equal(entries.length, 200);
  assert.equal(entries[0].index, 50);
  assert(entries.every(entry => entry.persisted === false));
});

test("a concurrently deleted Chat file may leave listing, but ENOENT from an existing Chat is never silently omitted", t => {
  const f = fixture(t);
  const original = fs.readFileSync;
  const injection = t.mock.method(fs, "readFileSync", (file, ...args) => {
    if (String(file) === f.chatFile) throw fault("ENOENT");
    return original(file, ...args);
  });
  assert.throws(() => f.store.list(), /Cannot read Chat/);
  injection.mock.restore();
  t.mock.method(fs, "readFileSync", (file, ...args) => {
    if (String(file) === f.chatFile) { fs.unlinkSync(f.chatFile); throw fault("ENOENT"); }
    return original(file, ...args);
  });
  assert.deepEqual(f.store.list(), []);
});
