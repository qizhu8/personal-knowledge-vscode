const assert = require("node:assert/strict");
const { test } = require("node:test");
const Module = require("node:module");
const load = Module._load;
Module._load = function (name, ...args) { return name === "vscode" ? {} : load.call(this, name, ...args); };
const { ApiChatView } = require("../dist/chat/api-chat-view");
const { ApiChatStore } = require("../dist/chat/api-chat-store");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
Module._load = load;

test("Chat visibility restores current state once without replaying ready or restarting discovery", async () => {
  const backend = new ApiChatView({});
  let published = 0, ready = 0, visibilityDisposed = 0, messagesDisposed = 0;
  backend.publish = () => { published++; };
  backend.handle = async message => { if (message.type === "ready") ready++; };
  function view() {
    let changed, disposed;
    return {
      visible: true,
      webview: { onDidReceiveMessage() { return { dispose() { messagesDisposed++; } }; } },
      onDidChangeVisibility(callback) { changed = callback; return { dispose() { visibilityDisposed++; } }; },
      onDidDispose(callback) { disposed = callback; return { dispose() {} }; },
      change(visible) { this.visible = visible; changed(); },
      close() { disposed(); },
    };
  }
  const first = view();
  backend.attachWebviewView(first, true);
  await new Promise(resolve => setTimeout(resolve, 10));
  assert.equal(ready, 1);
  for (let index = 0; index < 30; index++) {
    first.change(false);
    assert.equal(published, index);
    first.change(true);
    assert.equal(published, index + 1);
  }
  assert.equal(ready, 1, "Restoring visibility must not repeat initialization/MCP startup");
  const second = view();
  backend.attachWebviewView(second, true);
  await new Promise(resolve => setTimeout(resolve, 10));
  first.change(true);
  assert.equal(published, 30, "A replaced Webview cannot publish into the new view");
  first.close();
  assert.equal(backend.view, second);
  second.change(false); second.change(true);
  assert.equal(published, 31);
  second.close();
  assert.equal(visibilityDisposed, 2);
  assert.equal(messagesDisposed, 2);
  assert.equal(backend.view, undefined);
});

test("passive Host initialization and reload preserve crashed Goal evidence without execution admission", async t => {
  const { spawnSync } = require("node:child_process");
  const { readChatToolEvidence } = require("../dist/chat/chat-memory");
  const client = require("../dist/chat/api-chat-client");
  const native = require("../dist/chat/api-chat-vscode");
  const builtin = require("../dist/chat/api-chat-tools");
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "pkm-host-recovery-"));
  t.after(() => fs.rmSync(directory, { recursive:true, force:true }));
  const admissions = { send:0, http:0, native:0, toolFactories:0, tools:0 };
  // These are the production Host's send boundary and imported transports, not
  // callbacks on a separate store. Tripwires prevent accidental live work.
  for (const [object, key, counter] of [
    [ApiChatView.prototype, "send", "send"], [client, "streamApiChat", "http"],
    [native, "streamVscodeChat", "native"],
  ]) t.mock.method(object, key, () => { admissions[counter]++; throw new Error(`Unexpected recovery execution: ${counter}`); });
  const createBuiltinTools = builtin.createBuiltinTools;
  t.mock.method(builtin, "createBuiltinTools", (...args) => {
    admissions.toolFactories++;
    return createBuiltinTools(...args).map(tool => ({ ...tool, execute:async () => {
      admissions.tools++;
      throw new Error(`Unexpected recovery tool execution: ${tool.name}`);
    } }));
  });
  for (const goalStatus of ["paused", "active"]) {
    const child = spawnSync(process.execPath, ["-e", `
      const { ApiChatStore } = require(process.argv[1]);
      const { prepareWorkGoal, recordWorkGoalTransition } = require(process.argv[2]);
      const { randomUUID } = require("node:crypto");
      const store = new ApiChatStore(process.argv[3], "0123456789abcdef"), chat = store.create();
      store.startTask(chat, "Recovery regression");
      chat.includeHistory = true;
      const input = { id:randomUUID(), role:"user", taskId:chat.sessionId,
        content:"Start a new task: inspect the fixture", status:"complete" };
      chat.messages.push(input);
      prepareWorkGoal(chat, input.id, input.content, "a".repeat(64));
      if (process.argv[4] === "paused") chat.workGoal = recordWorkGoalTransition(chat.workGoal, "paused", "user_paused");
      chat.progress = { attemptId:randomUUID(), attempt:1, status:"running", ownerPid:process.pid,
        ownerHost:require("node:os").hostname(), startedAt:Date.now(), model:"fixture", steps:[] };
      const reply = { id:randomUUID(), inputId:input.id, taskId:chat.sessionId, role:"assistant",
        content:"Partial output", status:"streaming", progress:chat.progress, toolCalls:[
          { id:"terminal", name:"save_file", arguments:'{"path":"fixture","expectedHash":"original"}',
            status:"complete", result:"Original terminal receipt; not acceptance." },
          { id:"failed", name:"save_file", arguments:'{"path":"failed-fixture"}',
            status:"failed", result:"NOT_SAVED: disk full" },
          { id:"uncertain", name:"save_file", arguments:'{"path":"pending-fixture","expectedHash":"original"}', status:"running" },
        ] };
      chat.messages.push(reply); store.save(chat);
      require("node:fs").writeSync(1, JSON.stringify({ chatId:chat.id, replyId:reply.id, goal:chat.workGoal,
        calls:reply.toolCalls }));
      process.exit(17);
    `, require.resolve("../dist/chat/api-chat-store"), require.resolve("../dist/chat/chat-work-goal"), directory, goalStatus],
    { encoding:"utf8", timeout:10000 });
    assert.equal(child.status, 17, child.stderr);
    const recorded = JSON.parse(child.stdout);
    const makeHost = () => {
      const backend = new ApiChatView({ workspaceState:{ get:() => recorded.chatId, update:async () => {} } });
      backend.store = new ApiChatStore(directory, "0123456789abcdef");
      // Match the existing navigation fixture: suppress rendering/delegation enrichment,
      // never initialize/load/recover/send. No watcher or worker is started by this store seam.
      backend.publish = () => {};
      backend.refreshChatDelegations = () => {};
      return backend;
    };
    const first = makeHost();
    first.initialize(); // Actual Host -> load(false) -> recoverAbandoned -> durable recovery.
    const recovered = first.chat, expectedStatus = goalStatus === "active" ? "interrupted" : "paused";
    const check = chat => {
      assert.equal(chat.workGoal.status, expectedStatus);
      for (const key of ["id", "inputId", "attemptInputId", "objective", "executionDigest", "acceptance"])
        assert.deepEqual(chat.workGoal[key], recorded.goal[key]);
      assert.deepEqual(chat.workGoal.transitions.slice(0, recorded.goal.transitions.length), recorded.goal.transitions);
      assert(chat.workGoal.acceptance.every(item => !item.verified));
      const reply = chat.messages.find(message => message.id === recorded.replyId);
      assert.equal(reply.status, "interrupted");
      assert.equal(reply.content, "Partial output");
      assert.deepEqual(reply.toolCalls.slice(0, 2), recorded.calls.slice(0, 2));
      for (const call of recorded.calls) {
        const args = JSON.parse(readChatToolEvidence(chat, reply.id, { callId:call.id, kind:"arguments" }));
        assert.equal(args.content, call.arguments);
      }
      const unknown = JSON.parse(readChatToolEvidence(chat, reply.id, { callId:"uncertain" }));
      assert.equal(unknown.status, "failed");
      assert.match(unknown.content, /Execution may already have occurred/);
      assert.equal(JSON.parse(readChatToolEvidence(chat, reply.id, { callId:"terminal" })).content, recorded.calls[0].result);
      assert.equal(JSON.parse(readChatToolEvidence(chat, reply.id, { callId:"failed" })).content, recorded.calls[1].result);
      assert.deepEqual(admissions, { send:0, http:0, native:0, toolFactories:0, tools:0 });
    };
    check(recovered);
    first.initialize();
    await first.handle({ type:"select", id:recorded.chatId });
    check(first.chat);
    const restarted = makeHost();
    restarted.initialize();
    check(restarted.chat);
    assert.deepEqual(restarted.chat.workGoal, recovered.workGoal);
    assert.deepEqual(restarted.chat.messages, recovered.messages);
    // Force the existing select/reloadIfChanged path via a harmless fixture-only save.
    const externalStore = new ApiChatStore(directory, "0123456789abcdef");
    const external = externalStore.load(recorded.chatId, false);
    external.title = "Externally updated fixture"; externalStore.save(external);
    await restarted.handle({ type:"select", id:recorded.chatId });
    assert.equal(restarted.chat.title, external.title);
    check(restarted.chat);
  }
});

test("group creation and rapid selection publish the target before workspace persistence resolves", async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pkm-chat-navigation-"));
  t.after(() => fs.rmSync(root, { recursive:true, force:true }));
  const updates = [], published = [], posts = [];
  const backend = new ApiChatView({ workspaceState:{ update(key, value) {
    let resolve;
    const promise = new Promise(done => { resolve = done; });
    updates.push({ key, value, resolve }); return promise;
  } } });
  backend.store = new ApiChatStore(root, "0123456789abcdef");
  backend.initialize = () => {};
  backend.defaultModel = () => undefined;
  backend.refreshChatDelegations = () => {};
  backend.publish = requestId => published.push({ id:backend.chat.id, requestId });
  backend.view = { webview:{ postMessage:message => { posts.push(message); return Promise.resolve(true); } } };
  const groupId = backend.store.library.createGroup("PKM");
  const creating = backend.handle({ type:"new", groupId, requestId:"new-in-group" });
  assert.equal(published.length, 1, "Rendering must not wait for workspaceState.update");
  const first = backend.chat.id;
  assert.equal(backend.store.list()[0].groupId, groupId);
  assert.equal(backend.store.load(first, false).messages.length, 0);
  assert.deepEqual(posts[0], { type:"showChat", requestId:"new-in-group" });
  const ungrouped = backend.handle({ type:"new", groupId:"ungroup", requestId:"new-ungrouped" });
  const second = backend.chat.id;
  assert.equal(backend.store.list().find(chat => chat.id === second).groupId, "ungroup");
  const selecting = backend.handle({ type:"select", id:first, requestId:"select-first" });
  assert.deepEqual(published.at(-1), { id:first, requestId:"select-first" });
  const selectingAgain = backend.handle({ type:"select", id:second, requestId:"select-second" });
  assert.deepEqual(published.at(-1), { id:second, requestId:"select-second" });
  for (const update of updates.reverse()) update.resolve();
  await Promise.all([creating, ungrouped, selecting, selectingAgain]);
  assert.equal(backend.chat.id, second);
  assert.equal(published.length, 4, "Late persistence completions must not republish obsolete navigation");
  let loads = 0;
  const loadChat = backend.store.load.bind(backend.store);
  backend.store.load = (...args) => { loads++; return loadChat(...args); };
  const reselect = backend.handle({ type:"select", id:first, requestId:"unchanged" });
  assert.equal(loads, 0, "Unchanged previously loaded Chats reuse their file-validated history");
  updates.at(-1).resolve(); await reselect;
  const external = loadChat(first, false);
  external.title = "Renamed from another window";
  backend.store.save(external);
  backend.store.list();
  loads = 0;
  const changed = backend.handle({ type:"select", id:first, requestId:"changed" });
  assert.equal(loads, 1, "Changed files must be reloaded, not served from the in-memory cache");
  assert.equal(backend.chat.title, external.title);
  updates.at(-1).resolve(); await changed;
  const count = backend.store.list().length;
  await assert.rejects(backend.handle({ type:"new", groupId:"trash", requestId:"invalid" }), /existing Chat group/);
  assert.equal(backend.store.list().length, count, "Invalid groups must not create orphan Chats");
  backend.notifyChat = () => {};
  backend.notify(new Error("Chat load failed"), { type:"select", requestId:"failed-navigation" });
  assert.equal(posts.at(-1).requestId, "failed-navigation");
});
