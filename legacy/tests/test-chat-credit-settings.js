const { test } = require("node:test");
const assert = require("node:assert/strict");
const Module = require("node:module");
const fs = require("node:fs"), os = require("node:os"), path = require("node:path");
const { randomUUID } = require("node:crypto");

const host = { workspace: { getConfiguration: () => ({ get: (_key, fallback) => fallback }) } };
const originalLoad = Module._load;
let ApiChatView, ApiChatStore;
try {
  Module._load = function(name, ...args) { return name === "vscode" ? host : originalLoad.call(this, name, ...args); };
  ({ ApiChatView } = require("../dist/chat/api-chat-view"));
  ({ ApiChatStore } = require("../dist/chat/api-chat-store"));
} finally { Module._load = originalLoad; }

function fixture(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "pkm-credit-settings-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const store = new ApiChatStore(directory, "0123456789abcdef");
  const group = store.library.createGroup("Four test Chats");
  const chats = Array.from({ length: 4 }, () => {
    const chat = store.create();
    chat.title = "Same name"; chat.paused = true;
    store.save(chat); store.library.move(chat.id, group); return chat;
  });
  const outside = store.create(), messages = [];
  const provider = Object.assign(Object.create(ApiChatView.prototype), {
    store, chats: new Map(), running: new Map(), vscodeModels: [], chat: chats[0],
    defaultModel: () => undefined, persist: chat => store.save(chat),
    initialize() {}, publish() {}, view: { webview: { postMessage: message => messages.push(message) } },
    send() { throw new Error("Credit configuration must not dispatch work"); },
  });
  return { directory, store, provider, group, chats, outside, messages, ids: chats.map(chat => chat.id) };
}

test("four-Chat credit settings persist exact IDs, preserve paused state and leave other Chats unchanged", t => {
  const f = fixture(t), outside = f.store.load(f.outside.id, false);
  const original = f.chats.map(chat => f.store.load(chat.id, false));
  assert.deepEqual(f.provider.setActivityCreditLimits(f.ids, 1000, f.group), f.ids);
  const reopened = new ApiChatStore(f.directory, f.store.namespace);
  for (const [index, id] of f.ids.entries()) {
    const chat = reopened.load(id, false);
    assert.equal(chat.activityCreditLimit, 1000);
    for (const key of ["paused", "messages", "workGoal", "permissionMode", "modelProvider", "activityBudgetBypass"]) {
      assert.deepEqual(chat[key], original[index][key], `${key} must not be changed by a credit setting`);
    }
    assert.equal(f.provider.settings(chat).activityCreditLimit, 1000);
    assert.equal(f.provider.settings(chat).activityCreditLimitDefault, 200);
    assert.equal(f.provider.settings(chat).activityReviewMs, 1200000);
    assert.equal(reopened.list().find(item => item.id === id).activityCreditLimit, 1000);
  }
  assert.deepEqual(reopened.load(f.outside.id, false), outside);
  const future = f.store.create(); f.store.library.move(future.id, f.group);
  assert.equal(f.provider.settings(future).activityCreditLimit, 200, "a snapshot batch is not a future group default");
});

test("single-Chat zero, large and Unlimited limits are distinct from inherited default and time bypass", t => {
  const f = fixture(t), id = f.ids[0];
  for (const limit of [0, 1000, 1_000_000_000, -1, null]) {
    f.provider.setActivityCreditLimits([id], limit);
    const chat = f.store.load(id, false);
    assert.equal(chat.activityCreditLimit, limit === null ? undefined : limit);
    const settings = f.provider.settings(chat);
    assert.equal(settings.activityCreditLimit, limit === null ? 200 : limit);
    assert.equal(settings.activityReviewMs, 1200000);
    assert.equal(chat.activityBudgetBypass, undefined);
  }
});

test("invalid limits, duplicate IDs, stale membership and Trash targets fail before any save", t => {
  const f = fixture(t), baseline = f.ids.map(id => fs.readFileSync(f.store.file(id), "utf8"));
  for (const limit of [undefined, "1000", -2, 1.5, NaN, Infinity, 1_000_000_001, true, {}]) {
    assert.throws(() => f.provider.setActivityCreditLimits(f.ids, limit, f.group), /integer credit limit/);
  }
  assert.throws(() => f.provider.setActivityCreditLimits([f.ids[0], f.ids[0]], 1000, f.group), /Choose existing/);
  assert.throws(() => f.provider.setActivityCreditLimits(f.ids, 1000), /Choose existing/);
  f.store.library.move(f.ids[3], "ungroup");
  assert.throws(() => f.provider.setActivityCreditLimits(f.ids, 1000, f.group), /membership changed/);
  f.store.trashChat(f.ids[3]);
  assert.throws(() => f.provider.setActivityCreditLimits([f.ids[3]], 1000), /unavailable/);
  assert.deepEqual(f.ids.map(id => fs.readFileSync(f.store.file(id), "utf8")), baseline);
});

test("remote-running Chats and existing session time/credit bypass are not overwritten", t => {
  const f = fixture(t), chat = f.store.load(f.ids[3], false);
  chat.activityBudgetBypass = "session"; f.store.save(chat);
  assert.throws(() => f.provider.setActivityCreditLimits(f.ids, 1000, f.group), /Re-enable activity limits/);
  assert(f.ids.every(id => f.store.load(id, false).activityCreditLimit === undefined));
  assert.equal(f.store.load(chat.id, false).activityBudgetBypass, "session");
  delete chat.activityBudgetBypass;
  chat.progress = { startedAt: Date.now(), status: "running", model: "fixture", steps: [] };
  f.store.save(chat);
  assert.throws(() => f.provider.setActivityCreditLimits(f.ids, 1000, f.group), /another window/);
  assert(f.ids.every(id => f.store.load(id, false).activityCreditLimit === undefined));
});

test("a locally running response keeps its captured limit; configured cap applies to future responses", t => {
  const f = fixture(t), chat = f.chats[0];
  const currentSettings = f.provider.settings(chat);
  f.provider.running.set(chat.id, new AbortController()); f.provider.chats.set(chat.id, chat);
  f.provider.setActivityCreditLimits([chat.id], 1000);
  assert.equal(currentSettings.activityCreditLimit, 200);
  assert.equal(f.provider.settings(chat).activityCreditLimit, 1000);
  assert.equal(f.provider.running.get(chat.id).signal.aborted, false);
});

test("save failures disclose exact partial completion and do not fake rollback or replay", async t => {
  const f = fixture(t);
  let writes = 0;
  f.provider.persist = chat => { if (++writes === 2) throw new Error("fixture disk failure"); f.store.save(chat); };
  const requestId = randomUUID();
  await assert.rejects(f.provider.handle({ type: "activityCredits", requestId, params: { chatIds: f.ids, groupId: f.group, limit: 1000 } }),
    error => error.message.includes(`Saved Chat IDs: ${f.ids[0]}`) && error.message.includes(`Failed Chat: ${f.ids[1]}`));
  assert.equal(writes, 2);
  assert.equal(f.store.load(f.ids[0], false).activityCreditLimit, 1000);
  assert(f.ids.slice(1).every(id => f.store.load(id, false).activityCreditLimit === undefined));
  assert.equal(f.messages.length, 1); assert.equal(f.messages[0].requestId, requestId);
  assert.match(f.messages[0].error, /fixture disk failure/);
});

test("Host acknowledgement follows actual saved settings without dispatch or model discovery", async t => {
  const f = fixture(t), requestId = randomUUID();
  await f.provider.handle({ type: "activityCredits", requestId, params: { chatIds: f.ids, groupId: f.group, limit: 1000 } });
  assert.deepEqual(f.messages, [{ type: "activityCreditsSaved", requestId, saved: f.ids }]);
});

test("persisted invalid per-Chat credit limits are rejected on load", t => {
  const f = fixture(t), file = f.store.file(f.ids[0]), original = fs.readFileSync(file, "utf8");
  for (const value of ["1000", -2, 1.5, 1_000_000_001, null]) {
    fs.writeFileSync(file, JSON.stringify({ ...JSON.parse(original), activityCreditLimit: value }));
    assert.throws(() => f.store.load(f.ids[0], false), /chat history format/i);
  }
});

test("invalid credit limits are rejected before saving any file", t => {
  const f = fixture(t), chat = f.store.load(f.ids[0], false), original = fs.readFileSync(f.store.file(chat.id), "utf8");
  for (const limit of [-2, 1.5, Infinity, "1000", null]) {
    chat.activityCreditLimit = limit;
    assert.throws(() => f.store.save(chat), /Invalid Chat activity credit limit/);
    assert.equal(fs.readFileSync(f.store.file(chat.id), "utf8"), original);
  }
});

test("a Chat moved out during a batch is not edited as an outside-group target", t => {
  const f = fixture(t);
  f.provider.persist = chat => {
    f.store.save(chat);
    if (chat.id === f.ids[0]) f.store.library.move(f.ids[1], "ungroup");
  };
  assert.throws(() => f.provider.setActivityCreditLimits(f.ids, 1000, f.group), /moved out of the group/);
  assert.equal(f.store.load(f.ids[0], false).activityCreditLimit, 1000);
  assert(f.ids.slice(1).every(id => f.store.load(id, false).activityCreditLimit === undefined));
});
