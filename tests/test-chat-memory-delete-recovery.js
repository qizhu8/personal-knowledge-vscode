const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const { ApiChatStore } = require("../dist/chat/api-chat-store");
const { handleChatLibraryAction } = require("../dist/chat/library-actions");
const { ChatMemoryService, chatMemoryScope } = require("../dist/memory/chat-memory-service");

// Uses existing dist helpers (no build), the production Python worker and a temporary
// SQLite/blob store. Host UI confirmation is stubbed; no ApiChatView/model/cloud runs.
// The cleanup callback uses the owning namespace persisted before physical deletion.
async function fixture(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "pkm-delete-recovery-"));
  const options = { extensionRoot: path.resolve(__dirname, ".."),
    python: process.env.PYTHON || "python3", database: path.join(directory, "memory.sqlite3"),
    identity: "isolated-delete-recovery" };
  let memory = new ChatMemoryService(options);
  t.after(async () => {
    await memory.close();
    fs.rmSync(directory, { recursive: true, force: true });
  });
  const namespace = "0123456789abcdef";
  const store = new ApiChatStore(directory, namespace);
  const chat = store.create();
  const chatFile = path.join(directory, "api-chats", namespace, `${chat.id}.json`);
  const scope = chatMemoryScope(namespace, chat.id);
  const signal = new AbortController().signal;
  const run = async request => {
    if (request.purpose === "intent") return { text: JSON.stringify({
      focus: ["new:1"], new: [{ key: "new:1", label: "Recovery fixture" }],
    }) };
    if (request.purpose === "extract") return { text: JSON.stringify({ statements: [
      { topic: "T1", text: "Retain the fixture evidence after recovery.", status: "proposal" },
    ] }) };
    return { text: "Recovery fixture summary." };
  };
  const user = { id: "fixture-user", text: "Recovery fixture" };
  await memory.prepare(scope, "fixture-turn", user, [], 10000, run, signal);
  await memory.commit(scope, "fixture-turn", user,
    { id: "fixture-answer", text: "Retain the fixture evidence after recovery." }, run, signal);
  const host = { window: { showWarningMessage: async (_message, _options, choice) => choice } };
  const pieceIds = (await memory.inspect(scope)).pieces.map(piece => piece.id).sort();
  assert(pieceIds.length >= 3, "fixture must contain real committed Memory, not a callback counter");
  return { directory, namespace, store, chat, chatFile, scope, host, pieceIds, options,
    get memory() { return memory; },
    async restart() {
      await memory.close();
      memory = new ChatMemoryService(options);
      return new ApiChatStore(directory, namespace);
    } };
}

for (const operation of ["deleteChat", "emptyTrash"]) test(`${operation} failure must preserve Memory when the Trash Chat is restored`, async t => {
  const f = await fixture(t);
  const { directory, namespace, store, chat, chatFile, scope, host, pieceIds } = f;
  const events = [];
  const action = message => handleChatLibraryAction(message, store, host, () => false,
    id => events.push(`cache-forget:${id}`), async (id, owningNamespace) => {
      events.push("memory-start");
      assert(!fs.existsSync(chatFile), "Memory cleanup must follow irreversible Chat deletion");
      await f.memory.forget(chatMemoryScope(owningNamespace, id));
      events.push("memory-committed");
    }, id => events.push(`removed:${id}`));
  await action({ type: "trashChat", id: chat.id });
  assert(store.library.read().placements[chat.id].trashedAt);
  events.length = 0;
  // Fail the same production tombstone write as the original red regression,
  // independently of the cleanup callback's ordering.
  const groups = path.join(directory, "agent-groups");
  if (fs.existsSync(groups)) fs.renameSync(groups, path.join(directory, "fixture-groups-backup"));
  fs.writeFileSync(groups, "fixture ENOTDIR blocker");
  await assert.rejects(action({ type: operation, id: chat.id }), /ENOTDIR|EEXIST/);
  assert.deepEqual(events, [], "physical deletion failure must not start Memory cleanup or report removal");
  assert(fs.existsSync(chatFile), "failed permanent deletion must leave the Chat file");
  const reopened = new ApiChatStore(directory, namespace);
  assert(reopened.library.read().placements[chat.id].trashedAt, "failed Chat remains in Trash after reopening");
  assert.equal(reopened.load(chat.id, false).id, chat.id);
  assert.deepEqual((await f.memory.inspect(scope)).pieces.map(piece => piece.id).sort(), pieceIds);

  // Remove only the injected temporary blocker, then use the real restore path.
  fs.unlinkSync(path.join(directory, "agent-groups"));
  const backup = path.join(directory, "fixture-groups-backup");
  if (fs.existsSync(backup)) fs.renameSync(backup, path.join(directory, "agent-groups"));
  await handleChatLibraryAction({ type: "restoreChat", id: chat.id }, reopened, host,
    () => false, () => assert.fail("restore must not invoke deletion callbacks"),
    () => assert.fail("restore must not invoke Memory forget"));
  assert(reopened.list().some(item => item.id === chat.id && !item.trashedAt));
  assert.equal(reopened.load(chat.id, false).id, chat.id);
  await f.restart();
  const after = await f.memory.inspect(scope);
  assert.deepEqual(after.pieces.map(piece => piece.id).sort(), pieceIds,
    "restoring a Chat after failed permanent deletion must retain its committed Memory, including after worker restart");
  assert.deepEqual(fs.readdirSync(path.join(directory, "api-chat-deletions")), []);
});

for (const purged of [false, true]) test(`Memory cleanup failure (${purged ? "after" : "before"} purge) persists for explicit retry after restart`, async t => {
  const f = await fixture(t);
  f.store.trashChat(f.chat.id);
  let calls = 0;
  await assert.rejects(handleChatLibraryAction({ type:"deleteChat", id:f.chat.id }, f.store, f.host, () => false,
    () => assert.fail("cache removal is not successful cleanup"), async (id, namespace) => {
      calls++;
      assert(!fs.existsSync(f.chatFile));
      assert.equal(namespace, f.namespace);
      if (purged) await f.memory.forget(chatMemoryScope(namespace, id));
      throw new Error("Injected Memory cleanup failure");
    }), /Injected Memory cleanup failure/);
  const reopened = await f.restart();
  assert.equal(calls, 1, "reopening storage must not automatically replay cleanup");
  assert.deepEqual(reopened.list(true), []);
  assert.deepEqual(reopened.pendingDeletionCleanups().map(item => item.id), [f.chat.id]);
  assert.throws(() => reopened.restoreChat(f.chat.id), /ENOENT/);
  assert.deepEqual((await f.memory.inspect(f.scope)).pieces.map(piece => piece.id).sort(), purged ? [] : f.pieceIds);
  let forgot = 0;
  await handleChatLibraryAction({ type:"deleteChat", id:f.chat.id }, reopened, f.host, () => false,
    () => forgot++, async (id, namespace) => {
      calls++;
      await f.memory.forget(chatMemoryScope(namespace, id));
    });
  assert.equal(calls, 2);
  assert.equal(forgot, 1);
  assert.deepEqual(reopened.pendingDeletionCleanups(), []);
  await f.restart();
  assert.deepEqual((await f.memory.inspect(f.scope)).pieces, []);
});

for (const deleted of [false, true]) test(`restart after durable intent ${deleted ? "and physical deletion" : "before physical deletion"} preserves recovery`, async t => {
  const f = await fixture(t);
  f.store.trashChat(f.chat.id);
  f.store.prepareDeletion(f.chat.id);
  if (deleted) f.store.deleteChat(f.chat.id, true);
  const reopened = await f.restart();
  assert.deepEqual((await f.memory.inspect(f.scope)).pieces.map(piece => piece.id).sort(), f.pieceIds);
  assert.equal(reopened.pendingDeletionCleanups().length, deleted ? 1 : 0);
  if (!deleted) {
    reopened.restoreChat(f.chat.id);
    assert.equal(reopened.load(f.chat.id, false).id, f.chat.id);
    assert.deepEqual(fs.readdirSync(path.join(f.directory, "api-chat-deletions")), []);
  } else {
    await handleChatLibraryAction({ type:"emptyTrash" }, reopened, f.host, () => false, () => {},
      (id, namespace) => f.memory.forget(chatMemoryScope(namespace, id)));
    assert.deepEqual((await f.memory.inspect(f.scope)).pieces, []);
    assert.deepEqual(reopened.pendingDeletionCleanups(), []);
  }
});

for (const purged of [false, true]) test(`process exit ${purged ? "after" : "before"} Memory purge leaves deletion recoverable from another Host`, async t => {
  const f = await fixture(t);
  f.store.trashChat(f.chat.id);
  const script = `
    const { ApiChatStore } = require(${JSON.stringify(require.resolve("../dist/chat/api-chat-store"))});
    const { handleChatLibraryAction } = require(${JSON.stringify(require.resolve("../dist/chat/library-actions"))});
    const { ChatMemoryService, chatMemoryScope } = require(${JSON.stringify(require.resolve("../dist/memory/chat-memory-service"))});
    const fixture = JSON.parse(process.argv[1]);
    const store = new ApiChatStore(fixture.directory, fixture.namespace);
    const host = { window:{ showWarningMessage:async (_message, _options, choice) => choice } };
    handleChatLibraryAction({ type:"deleteChat", id:fixture.id }, store, host, () => false,
      () => { throw new Error("Process must exit before final cache cleanup"); },
      async (id, namespace) => {
        if (fixture.purged) {
          const memory = new ChatMemoryService(fixture.options);
          try { await memory.forget(chatMemoryScope(namespace, id)); }
          finally { await memory.close(); }
        }
        process.exit(23);
      }).catch(error => { console.error(error); process.exitCode = 1; });
  `;
  const result = spawnSync(process.execPath, ["-e", script, JSON.stringify({
    directory:f.directory, namespace:f.namespace, id:f.chat.id, options:f.options, purged,
  })], { encoding:"utf8", timeout:20000 });
  assert.ifError(result.error);
  assert.equal(result.status, 23, result.stderr);
  assert(!fs.existsSync(f.chatFile), "physical Chat deletion precedes Memory cleanup");
  assert.deepEqual((await f.memory.inspect(f.scope)).pieces.map(piece => piece.id).sort(), purged ? [] : f.pieceIds,
    "an already-open Memory reader observes the other Host's committed purge without restart");
  const reopened = await f.restart();
  assert.deepEqual(reopened.list(true), []);
  assert.deepEqual(reopened.pendingDeletionCleanups().map(item => item.id), [f.chat.id]);
  assert.throws(() => reopened.restoreChat(f.chat.id), /ENOENT/);
  let cleaned = 0;
  await handleChatLibraryAction({ type:"deleteChat", id:f.chat.id }, reopened, f.host, () => false, () => {},
    async (id, namespace) => {
      cleaned++;
      await f.memory.forget(chatMemoryScope(namespace, id));
    });
  assert.equal(cleaned, 1, "cleanup retries only after an explicit confirmed deletion request");
  assert.deepEqual(reopened.pendingDeletionCleanups(), []);
  await f.restart();
  assert.deepEqual((await f.memory.inspect(f.scope)).pieces, []);
});
