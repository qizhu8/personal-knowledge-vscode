const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { ApiChatStore } = require("../dist/chat/api-chat-store");
const { handleChatLibraryAction } = require("../dist/chat/library-actions");

function fixture(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "pkm-library-actions-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const store = new ApiChatStore(directory, "0123456789abcdef");
  let approve = true, typed = "", cancel = false, disposed = 0;
  const host = { window: {
    showWarningMessage: async (_text, _options, choice) => approve ? choice : undefined,
    createQuickPick() {
      let change, accept, hide;
      return { value:"", items:[], selectedItems:[],
        onDidChangeValue(callback) { change = callback; },
        onDidAccept(callback) { accept = callback; }, onDidHide(callback) { hide = callback; },
        show() {
          this.value = typed; change();
          this.selectedItems = [this.items.find(item => item.newName || item.label.toLowerCase() === typed.toLowerCase()) || this.items[0]];
          cancel ? hide() : accept();
        }, dispose() { disposed++; }
      };
    }
  } };
  const forgotten = [];
  return { directory, store, host, forgotten, action:(message, cleanup) => handleChatLibraryAction(message, store, host, () => false, id => forgotten.push(id), cleanup),
    approve(value) { approve = value; }, type(value) { typed = value; }, cancel(value) { cancel = value; }, get disposed() { return disposed; } };
}

test("Move to group accepts a typed new name, reuses case-insensitive names and cancellation creates nothing", async t => {
  const f = fixture(t), chat = f.store.create();
  f.type("  New work  "); await f.action({ type:"moveChat", id:chat.id });
  const group = f.store.library.read().groups[0];
  assert.equal(group.name, "New work");
  assert.equal(f.store.list()[0].groupId, group.id);
  f.type("new WORK"); await f.action({ type:"moveChat", id:chat.id });
  assert.equal(f.store.library.read().groups.length, 1);
  f.type("Other group"); f.cancel(true); await f.action({ type:"moveChat", id:chat.id });
  assert.equal(f.store.library.read().groups.length, 1);
  assert.equal(f.store.list()[0].groupId, group.id);
  f.cancel(false); f.type("Ungroup"); await f.action({ type:"moveChat", id:chat.id });
  assert.equal(f.store.list()[0].groupId, "ungroup");
  assert.equal(f.disposed, 4);
});

test("Portal companions share a named group without renaming existing groups or losing Trash placement", t => {
  const f = fixture(t), first = f.store.create(), second = f.store.create();
  f.store.library.moveToNamedGroup(first.id, "Portal");
  f.store.library.moveToNamedGroup(second.id, "portal");
  assert.equal(f.store.library.read().groups.length, 1);
  assert.equal(f.store.list()[0].groupId, f.store.list()[1].groupId);
  assert.equal(f.store.library.read().groups[0].name, "Portal");
  f.store.trashChat(first.id);
  f.store.library.moveToNamedGroup(first.id, "Portal");
  assert(f.store.list(true).find(item => item.id === first.id).trashedAt);
  assert.throws(() => f.store.library.moveToNamedGroup(second.id, "Trash"), /already exists/);
  assert.equal(f.store.library.read().groups.length, 1);
});
test("Empty Trash removes every physical Chat across namespace stores and survives reopening", async t => {
  const f = fixture(t), second = new ApiChatStore(f.directory, "fedcba9876543210");
  const chats = [f.store.create(), second.create(), f.store.create()];
  const keep = f.store.create();
  chats.forEach(chat => f.store.trashChat(chat.id));
  const files = chats.map(chat => path.join(f.directory, "api-chats", chat.workspaceNamespace, `${chat.id}.json`));
  assert(files.every(file => fs.existsSync(file)));
  f.approve(false); await f.action({ type:"emptyTrash" });
  assert(files.every(file => fs.existsSync(file)));
  f.approve(true);
  const scopes = [];
  await f.action({ type:"emptyTrash" }, async id => {
    const chat = f.store.load(id, false);
    scopes.push([id, chat.workspaceNamespace]);
  });
  assert(files.every(file => !fs.existsSync(file)));
  assert.equal(scopes.length, 3);
  assert(scopes.some(([id, namespace]) => id === chats[1].id && namespace === "fedcba9876543210"));
  assert.equal(f.store.library.read().placements[chats[0].id], undefined);
  const reopened = new ApiChatStore(f.directory, "0123456789abcdef");
  assert.deepEqual(reopened.list(true).map(chat => chat.id), [keep.id]);
});

test("Empty Trash reports cleanup failures, preserves failed Chats and still deletes the other items", async t => {
  const f = fixture(t), chats = [f.store.create(), f.store.create(), f.store.create()];
  chats.forEach(chat => f.store.trashChat(chat.id));
  await assert.rejects(f.action({ type:"emptyTrash" }, async id => {
    if (id === chats[1].id) throw new Error("Memory cleanup unavailable");
    assert(f.store.load(id, false));
  }), /remain in Trash:[\s\S]*Memory cleanup unavailable/);
  assert.deepEqual(f.store.list(true).map(chat => chat.id), [chats[1].id]);
  assert(f.store.list(true)[0].trashedAt);
  f.store.restoreChat(chats[1].id);
  assert.equal(f.store.list()[0].id, chats[1].id);
});

test("large Chat trash, restore, Memory scope lookup and deletion never read history segments on the UI thread", async t => {
  const f = fixture(t), chat = f.store.create();
  chat.messages = Array.from({ length: 64 }, (_, index) => ({
    id: `fixture-${index}`, role: "assistant", status: "complete", content: `${index}:` + "x".repeat(256_000),
  }));
  f.store.save(chat);
  const read = fs.readFileSync, segmentReads = [];
  fs.readFileSync = function (file, ...args) {
    if (String(file).endsWith(".bin")) segmentReads.push(String(file));
    return read.call(this, file, ...args);
  };
  try {
    await f.action({ type: "trashChat", id: chat.id });
    await f.action({ type: "restoreChat", id: chat.id });
    await f.action({ type: "trashChat", id: chat.id });
    await f.action({ type: "deleteChat", id: chat.id }, async id => {
      assert.equal(await f.store.memoryNamespace(id), chat.workspaceNamespace);
    });
  } finally { fs.readFileSync = read; }
  assert.deepEqual(segmentReads, [], "all segment parsing, hashing and removal must happen outside Extension Host");
  assert.deepEqual(f.store.list(true), []);
  assert(!fs.existsSync(path.join(f.directory, "api-chat-history", chat.id)));
});

test("a contended Chat lock leaves the UI heartbeat responsive instead of synchronously waiting", async t => {
  const { withCrossProcessLock } = require("../dist/runtime/cross-process-lock");
  const { performance } = require("node:perf_hooks");
  const f = fixture(t), chat = f.store.create();
  let mutation, ticks = 0, maxGap = 0, last = performance.now();
  const heartbeat = setInterval(() => {
    const now = performance.now(); maxGap = Math.max(maxGap, now - last); last = now; ticks++;
  }, 10);
  try {
    await withCrossProcessLock(path.join(f.directory, "api-chats", "chats.lock"), "fixture", 2000, async () => {
      mutation = f.store.libraryMutation("trash", chat.id);
      await new Promise(resolve => setTimeout(resolve, 500));
    });
    await mutation;
  } finally { clearInterval(heartbeat); }
  assert(ticks >= 10, `UI heartbeat did not run while awaiting lock: ${ticks} ticks`);
  assert(maxGap < 250, `UI heartbeat was blocked for ${maxGap.toFixed(1)}ms`);
  assert(f.store.list(true)[0].trashedAt);
});

test("async deletion still rejects a Chat that became running after the UI checked it", async t => {
  const f = fixture(t), chat = f.store.create();
  f.store.trashChat(chat.id);
  chat.messages.push({ id: "running", role: "assistant", status: "streaming", content: "" });
  fs.writeFileSync(path.join(f.directory, "api-chats", chat.workspaceNamespace, `${chat.id}.json`), JSON.stringify(chat));
  await assert.rejects(f.store.libraryMutation("delete", chat.id), /Stop the running Chat/);
  assert(fs.existsSync(path.join(f.directory, "api-chats", chat.workspaceNamespace, `${chat.id}.json`)));
});

test("current Task todos are read-only, refreshed from the owned Session and never borrowed from another Chat", t => {
  const f = fixture(t), chat = f.store.create();
  assert.deepEqual(f.store.taskPlan(chat), { items:[] });
  f.store.startTask(chat, "Task plan");
  const file = path.join(f.directory, "agent-sessions", `${chat.sessionId}.json`);
  const session = JSON.parse(fs.readFileSync(file, "utf8"));
  session.todos = [{ todoId:"first", title:"Inspect", status:"succeeded" }, { todoId:"second", title:"Test", status:"pending", parentTodoId:"first" }];
  fs.writeFileSync(file, JSON.stringify(session));
  const before = fs.readFileSync(file, "utf8");
  assert.deepEqual(f.store.taskPlan(chat).items, session.todos.map(({ todoId, title, status }) => ({ todoId, title, status })));
  assert.equal(fs.readFileSync(file, "utf8"), before);
  session.hostSessionId = f.store.create().id;
  fs.writeFileSync(file, JSON.stringify(session));
  assert.throws(() => f.store.taskPlan(chat), /does not belong/);
});

test("built Automation navigation places Action Library third, before Recipe Library and the Action Workbench", () => {
  const html = fs.readFileSync(path.join(__dirname, "..", "dist", "webview", "panel.html"), "utf8");
  const automation = html.match(/aria-label="Automation views">([\s\S]*?)<\/div>/)[1];
  assert.deepEqual([...automation.matchAll(/<button\b[^>]*>([^<]+)<\/button>/g)].map(match => match[1]),
    ["Agent Sessions", "Agent Snapshot", "Action Library", "Recipe Library", "Action Workbench"]);
});

test("operation identities and public summaries persist without entering the visible assistant answer", t => {
  const f = fixture(t), chat = f.store.create();
  const progress = { startedAt:1, finishedAt:3, model:"fixture", status:"complete", steps:[
    { label:"Generating response", kind:"model", round:0, at:1, status:"complete" },
    { label:"Completed tool: read_file", kind:"tool", round:0, toolCallId:"call", at:2, status:"complete" },
  ] };
  chat.messages.push({ id:"reply", role:"assistant", status:"complete", content:"Visible answer", progress,
    reasoningSummaries:[{ round:0, text:"Public provider summary" }] });
  f.store.save(chat);
  const loaded = f.store.load(chat.id, false).messages[0];
  assert.deepEqual(loaded.progress.steps, progress.steps);
  assert.deepEqual(loaded.reasoningSummaries, [{ round:0, text:"Public provider summary" }]);
  assert.equal(loaded.content, "Visible answer");
  assert.deepEqual(require("../dist/chat/api-chat-store").apiChatHarnessSnapshot(f.store.load(chat.id, false)).attempts[0].reasoningSummaries,
    loaded.reasoningSummaries);
});
