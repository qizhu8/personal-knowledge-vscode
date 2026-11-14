const assert = require("node:assert/strict");
const { test, afterEach, after } = require("node:test");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { createHash } = require("node:crypto");
const Module = require("node:module");

const never = () => new Promise(() => {});
const deferred = () => {
  let resolve, reject;
  const promise = new Promise((done, fail) => { resolve = done; reject = fail; });
  return { promise, resolve, reject };
};
async function bounded(promise, ms = 500) {
  let timer;
  try {
    return await Promise.race([promise, new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error("Readiness regression exceeded its deadline")), ms);
    })]);
  } finally { clearTimeout(timer); }
}

let focus, native, sdkCalls;
const host = {
  commands: { executeCommand: () => focus.promise },
  workspace: { isTrusted: true },
  lm: { selectChatModels: () => native.promise },
  authentication: {},
};
const originalLoad = Module._load;
let ApiChatView, ApiChatAgentControl, builtin, sdk, execution, client;
try {
  Module._load = function(name, ...args) {
    if (name === "vscode") return host;
    if (name === "../knowledge/filestore" && args[0]?.filename.endsWith("api-chat-view.js")) return { getStorePath: () => undefined };
    return originalLoad.call(this, name, ...args);
  };
  ({ ApiChatView } = require("../dist/chat/api-chat-view"));
  ({ ApiChatAgentControl } = require("../dist/chat/agent-control"));
  builtin = require("../dist/chat/api-chat-tools");
  sdk = require("../dist/chat/api-chat-copilot-sdk");
  execution = require("../dist/chat/chat-tool-execution");
  client = require("../dist/chat/api-chat-client");
} finally { Module._load = originalLoad; }
const originalSdkDiscovery = sdk.discoverCopilotSdkModels;
sdk.discoverCopilotSdkModels = async () => {
  sdkCalls++;
  return [{ id:"auto", name:"Auto", vendor:"copilot-sdk", maxInputTokens:8192, maxOutputTokens:2048 }];
};
after(() => { sdk.discoverCopilotSdkModels = originalSdkDiscovery; });
const directories = [];
afterEach(() => {
  for (const directory of directories.splice(0)) fs.rmSync(directory, { recursive:true, force:true });
});

function controlFixture(update = async () => {}) {
  focus = deferred();
  const chat = { id:"aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa", workspaceNamespace:"0123456789abcdef", title:"Readiness", context:[], messages:[
    { id:"old-reply", role:"assistant", status:"cancelled", content:"previous attempt" },
  ] };
  let sends = 0;
  const provider = Object.assign(Object.create(ApiChatView.prototype), {
    disposed:false, running:new Map(), queueDrains:new Set(), agentControlledRequests:new Set(), chats:new Map(), awaitingInput:new Set(),
    extension:{workspaceState:{update}}, openStore:() => {}, assertRunnable:() => {}, publish:() => {},
    notify:error => { throw error; },
    store:{namespace:chat.workspaceNamespace, resolveChat:() => chat, list:() => [chat], load:() => chat, assertAvailable:() => {}},
    settings:() => ({provider:"vscode", selectedProfile:{id:"vscode:copilot-sdk:auto"}}),
    send:async () => { sends++; chat.messages.push({id:"new-reply", role:"assistant", status:"complete", content:"done"}); },
  });
  return {chat, provider, sends:() => sends};
}

test("agent send does not await an unresponsive foreground-focus command", async () => {
  const f = controlFixture();
  try {
    const result = await bounded(f.provider.agentControl("send", {chatId:f.chat.id, prompt:"Readiness test"}));
    assert.equal(f.sends(), 1);
    assert.equal(result.reply.id, "new-reply");
    assert.equal(f.provider.running.size, 0);
  } finally { focus.resolve(); }
});

test("workspace-state persistence cannot block or replay an agent send", async () => {
  const state = deferred();
  const f = controlFixture(() => state.promise);
  try {
    const result = await bounded(f.provider.agentControl("send", {chatId:f.chat.id, prompt:"Non-blocking metadata"}));
    assert.equal(result.reply.id, "new-reply");
    assert.equal(f.sends(), 1);
    assert.equal(f.provider.running.size, 0);
    state.resolve(); focus.resolve();
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(f.sends(), 1, "late UI replies must never replay a request");
  } finally { state.resolve(); focus.resolve(); }
});

test("sidebar state and focus failures are reported without failing or replaying the send", async () => {
  const f = controlFixture(() => Promise.reject(new Error("state unavailable")));
  const notifications = [];
  f.provider.notify = error => notifications.push(error.message);
  const sending = f.provider.agentControl("send", {chatId:f.chat.id, prompt:"UI-independent dispatch"});
  focus.reject(new Error("focus unavailable"));
  const result = await bounded(sending);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(result.reply.id, "new-reply");
  assert.equal(f.sends(), 1);
  assert.equal(notifications.length, 2);
  assert(notifications.every(message => /not required for Chat dispatch/.test(message)));
});

test("actual control receipts settle the original pre-dispatch send after a Stop acknowledgement", async () => {
  const state = deferred(), entered = deferred();
  const f = controlFixture(() => state.promise);
  f.chat.modelProvider = "vscode";
  f.chat.vscodeModelId = "vscode:copilot-sdk:auto";
  f.provider.send = ApiChatView.prototype.send;
  f.provider.captureExecution = () => ({});
  f.provider.settings = () => ({provider:"vscode", needsModelConnection:true, selectedProfile:{id:f.chat.vscodeModelId}});
  f.provider.availableVscodeModels = () => { entered.resolve(); return never(); };
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "pkm-control-readiness-"));
  directories.push(directory);
  const control = new ApiChatAgentControl(directory, {}, (operation, args) => f.provider.agentControl(operation, args));
  const requests = path.join(directory, "api-chat-control", "requests", control.hostId);
  const sendId = "a".repeat(64), cancelId = "b".repeat(64);
  const enqueue = (id, operation, args) => fs.writeFileSync(path.join(requests, id + ".json"), JSON.stringify({
    schema:"pkm.api-chat.request/v1", hostId:control.hostId, requestId:id,
    status:"queued", operation, arguments:args, expiresAt:Date.now() + 60_000,
  }));
  try {
    enqueue(sendId, "send", {chatId:f.chat.id, prompt:"Cancel before dispatch"});
    control.poll(); await bounded(entered.promise);
    enqueue(cancelId, "cancel", {chatId:f.chat.id});
    control.poll();
    const receipts = await bounded((async () => {
      for (let attempt = 0; attempt < 40; attempt++) {
        const send = JSON.parse(fs.readFileSync(path.join(requests, sendId + ".json"), "utf8"));
        const cancel = JSON.parse(fs.readFileSync(path.join(requests, cancelId + ".json"), "utf8"));
        if (send.status === "failed" && cancel.status === "succeeded") return {send, cancel};
        await new Promise(resolve => setTimeout(resolve, 10));
      }
      throw new Error("Original send did not reach a terminal receipt");
    })());
    assert.match(receipts.send.error, /cancelled/i);
    assert.equal(receipts.cancel.result.cancellation.requested, true);
    assert.equal(f.sends(), 0);
    state.resolve(); focus.resolve();
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(f.sends(), 0);
    assert.deepEqual(f.chat.messages.map(message => message.id), ["old-reply"]);
  } finally { state.resolve(); focus.resolve(); control.dispose(); }
});

function fileFixture() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "pkm-chat-readiness-"));
  directories.push(directory);
  const uri = fsPath => ({scheme:"file", fsPath, path:fsPath});
  const documents = [];
  let opens = 0, stats = 0;
  const fileHost = {
    Uri:{file:uri},
    Range:class { constructor(start, end) { this.start = start; this.end = end; } },
    WorkspaceEdit:class { replace(target, range, text) { this.change = {target, range, text}; } },
    workspace:{
      isTrusted:true, workspaceFolders:[{uri:uri(directory)}], textDocuments:documents,
      getConfiguration:() => ({get:(_key, fallback) => fallback}),
      fs:{stat:() => { stats++; return never(); }},
      openTextDocument:() => { opens++; return never(); },
      applyEdit:async edit => {
        const {target, range, text} = edit.change;
        const document = documents.find(item => item.uri.fsPath === target.fsPath);
        document.text = document.text.slice(0, range.start) + text + document.text.slice(range.end);
        document.version++;
        return true;
      },
    },
  };
  const tools = builtin.createBuiltinTools(["read_file", "replace_text"], fileHost, undefined, undefined, async () => true);
  return {directory, documents, uri, fileHost, tools, opens:() => opens, stats:() => stats};
}

test("eight filesystem reads and version checks finish while editor IPC is unresponsive", async () => {
  const f = fileFixture();
  const controller = new AbortController();
  const read = f.tools.find(tool => tool.name === "read_file");
  try {
    const expected = Array.from({length:8}, (_, index) => `readiness-${index}\nsecond line`);
    expected.forEach((text, index) => fs.writeFileSync(path.join(f.directory, `file-${index}.txt`), text));
    const results = await bounded(Promise.all(expected.map(async (text, index) => {
      const args = {path:`file-${index}.txt`, startLine:1, endLine:2};
      const version = await read.readVersion(args, controller.signal);
      const result = JSON.parse(await read.execute(args, controller.signal));
      assert.equal(version, createHash("sha256").update(text).digest("hex"));
      assert.equal(result.content, text);
      assert.equal(result.staged, false);
      return result;
    })));
    assert.equal(results.length, 8);
    assert.equal(f.opens(), 0);
    assert.equal(f.stats(), 0, "filesystem-backed paths must not depend on renderer stat IPC");
  } finally { controller.abort(); }
});

test("filesystem reads preserve unsaved working-copy text, approved edits and their version", async () => {
  const f = fileFixture();
  const filename = path.join(f.directory, "draft.txt");
  fs.writeFileSync(filename, "disk content");
  f.documents.push({uri:f.uri(filename), isClosed:false, version:1, text:"unsaved content",
    getText() { return this.text; }, positionAt:offset => offset});
  const signal = new AbortController().signal;
  const read = f.tools.find(tool => tool.name === "read_file");
  const result = JSON.parse(await bounded(read.execute({path:"draft.txt"}, signal)));
  assert.equal(result.content, "unsaved content");
  assert.equal(f.opens(), 0);
  const edited = JSON.parse(await bounded(f.tools.find(tool => tool.name === "replace_text").execute({
    path:"draft.txt", oldText:"unsaved", newText:"staged",
  }, signal)));
  assert.equal(edited.saved, false);
  const staged = JSON.parse(await bounded(read.execute({path:"draft.txt"}, signal)));
  assert.equal(staged.content, "staged content");
  assert.equal(staged.staged, false, "legacy working-copy edits retain their existing staged flag");
  assert.equal(await read.readVersion({path:"draft.txt"}, signal), createHash("sha256").update("staged content").digest("hex"));
  assert.equal(fs.readFileSync(filename, "utf8"), "disk content");
});

test("read_file preserves BOM encodings, excludes secrets and rejects binary content", async () => {
  const f = fileFixture();
  fs.writeFileSync(path.join(f.directory, "utf16.txt"), Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from("Unicode text", "utf16le")]));
  fs.writeFileSync(path.join(f.directory, "binary.txt"), Buffer.from([0x61, 0, 0x62]));
  fs.writeFileSync(path.join(f.directory, ".env"), "excluded fixture");
  const read = f.tools.find(tool => tool.name === "read_file");
  const signal = new AbortController().signal;
  assert.equal(JSON.parse(await bounded(read.execute({path:"utf16.txt"}, signal))).content, "Unicode text");
  await assert.rejects(bounded(read.execute({path:"binary.txt"}, signal)), /binary/);
  await assert.rejects(bounded(read.execute({path:".env"}, signal)), /excluded/);
});

test("legacy-encoding editor reads have an exact bounded wait and apply no edit", async t => {
  t.mock.timers.enable({apis:["setTimeout"]});
  const f = fileFixture(), opened = deferred();
  const filename = path.join(f.directory, "legacy.txt");
  fs.writeFileSync(filename, "legacy fixture");
  f.fileHost.workspace.getConfiguration = () => ({get:() => "windows1252"});
  f.fileHost.workspace.openTextDocument = () => { opened.resolve(); return never(); };
  const read = f.tools.find(tool => tool.name === "read_file");
  const running = read.execute({path:"legacy.txt"}, new AbortController().signal);
  const rejection = assert.rejects(running, /editor did not open the text document within 30 seconds\. No edit was applied/);
  await opened.promise;
  t.mock.timers.tick(30_000);
  await rejection;
  assert.equal(fs.readFileSync(filename, "utf8"), "legacy fixture");
});

test("a hanging read-version provider is cancelled before tool execution, with no late replay", async () => {
  const controller = new AbortController(), version = deferred(), entered = deferred();
  let executions = 0;
  const tool = {name:"read_file", label:"Read files", execution:"parallel-read",
    readVersion:() => { entered.resolve(); return version.promise; },
    execute:async () => { executions++; return "actual output"; }};
  const request = {tools:[tool], messages:[], signal:controller.signal};
  const running = execution.executeChatToolBatch([{id:"read", type:"function", function:{name:"read_file", arguments:"{}"}}],
    request, [], new client.ChatToolLoopGuard(request), controller.signal, 0);
  await entered.promise;
  controller.abort();
  const rejection = assert.rejects(bounded(running), /cancelled/i);
  try { await rejection; }
  finally { version.resolve("late version"); }
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(executions, 0);
});

test("reconnecting a selected SDK model never waits for the native model catalog", async () => {
  native = deferred(); sdkCalls = 0;
  const controller = new AbortController();
  const provider = Object.assign(Object.create(ApiChatView.prototype), {
    modelEpoch:0, vscodeModels:[], modelDiscoveries:new Map(), discoveries:new Set(),
  });
  try {
    const models = await bounded(provider.availableVscodeModels(controller.signal, false, "copilot-sdk"));
    assert.deepEqual(models.map(model => model.vendor), ["copilot-sdk"]);
    assert.equal(sdkCalls, 1);
  } finally { controller.abort(); native.resolve([]); for (const discovery of provider.discoveries) discovery.abort(); }
});

test("source discoveries coalesce, and a source-only cache cannot masquerade as a full catalog", async () => {
  native = deferred(); sdkCalls = 0;
  const provider = Object.assign(Object.create(ApiChatView.prototype), {
    modelEpoch:0, vscodeModels:[], modelDiscoveries:new Map(), discoveries:new Set(),
  });
  const controller = new AbortController();
  try {
    await Promise.all([provider.availableVscodeModels(undefined, false, "copilot-sdk"),
      provider.availableVscodeModels(undefined, false, "copilot-sdk")]);
    assert.equal(sdkCalls, 1);
    const full = provider.availableVscodeModels(controller.signal);
    native.resolve([{id:"native", name:"Native", vendor:"copilot", maxInputTokens:8192}]);
    assert.deepEqual((await bounded(full)).map(model => model.vendor).sort(), ["copilot", "copilot-sdk"]);
    assert.equal(provider.modelCatalogComplete, true);
    assert.equal(provider.modelDiscoveries.size, 0);
  } finally { controller.abort(); native.resolve([]); for (const discovery of provider.discoveries) discovery.abort(); }
});

test("a catalog deadline reports timeout, not user cancellation, and rejects late catalog results", async t => {
  t.mock.timers.enable({apis:["setTimeout"]});
  native = deferred(); sdkCalls = 0;
  const provider = Object.assign(Object.create(ApiChatView.prototype), {
    modelEpoch:0, vscodeModels:[], modelDiscoveries:new Map(), discoveries:new Set(),
  });
  const running = provider.availableVscodeModels(undefined, true);
  const rejection = assert.rejects(running, /model discovery timed out after 30 seconds/);
  t.mock.timers.tick(30_000);
  await rejection;
  native.resolve([{id:"late", name:"Late", vendor:"copilot", maxInputTokens:8192}]);
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(provider.vscodeModels, []);
  assert.equal(provider.modelDiscoveries.size, 0);
  assert.equal(provider.discoveries.size, 0);
});
