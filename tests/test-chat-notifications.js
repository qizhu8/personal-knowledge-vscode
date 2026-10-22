const assert = require("assert");
const fs = require("fs");
const path = require("path");

const settle = () => new Promise(resolve => setImmediate(resolve));

exports.testCatalogs = () => {
  const root = path.resolve(__dirname, "../resources/locales");
  const { locales } = JSON.parse(fs.readFileSync(path.join(root, "manifest.json"), "utf8"));
  const keys = ["apiChat.allowOnce", "apiChat.refuse", ...["permission", "input", "responseComplete", "taskComplete", "failed", "memoryFailed"]
    .map(kind => `apiChat.notification.${kind}`)];
  const english = JSON.parse(fs.readFileSync(path.join(root, "en.json"), "utf8")).strings;
  for (const { id } of locales) {
    const strings = JSON.parse(fs.readFileSync(path.join(root, `${id}.json`), "utf8")).strings;
    for (const key of keys) {
      assert(strings[key]?.trim(), `${id}: ${key}`);
      const placeholders = text => [...text.matchAll(/\{(\w+)\}/g)].map(match => match[1]).sort();
      assert.deepStrictEqual(placeholders(strings[key]), placeholders(english[key]), `${id}: ${key}`);
    }
  }
  console.log(`Chat notification catalogs: ${keys.length} keys verified across ${locales.length} locales.`);
};

exports.testPermissions = async (provider, notifications, owner) => {
  const chat = provider.chat;
  const request = (signal = owner.signal, once = false) => provider.requestPermission(chat, "notification-fixture",
    "Notification permission", "Inspect this exact action before deciding.", signal, false, once, owner.signal);
  const openPkmChat = provider.openPkmChat;
  const opened = [];
  provider.openPkmChat = async url => { opened.push(url); };
  try {
    const before = notifications.length;
    const allowed = request();
    const notice = notifications.at(-1);
    assert.strictEqual(notifications.length, before + 1);
    assert.deepStrictEqual(notice.actions, ["Open Chat"]);
    assert.match(notice.title, /needs authorization/);
    provider.publish(); provider.publish();
    assert.strictEqual(notifications.length, before + 1, "Publishing state must not duplicate a pending notification");
    const selected = provider.chat;
    provider.chat = provider.store.create();
    notice.resolve("Allow once");
    await settle();
    const allowedId = [...provider.approvals.keys()][0];
    assert(provider.approvals.has(allowedId), "A notification must not authorize tools");
    provider.resolveApproval(allowedId, "approve-once");
    assert.strictEqual(await allowed, true, "A toast resolves its owning Chat, not the selected Chat");
    provider.chat = selected;
    assert(!chat.permissionGrants.includes("notification-fixture"), "Allow once must not remember a grant");
    assert(!provider.store.load(chat.id, false).permissionGrants.includes("notification-fixture"));

    const openPending = request();
    const openId = [...provider.approvals.keys()][0];
    notifications.at(-1).resolve("Open Chat");
    await settle();
    assert.match(opened.at(-1), new RegExp(`${chat.id}$`));
    assert(provider.approvals.has(openId), "Open Chat must not grant or refuse permission");
    provider.resolveApproval(openId, "deny");
    assert.strictEqual(await openPending, false);

    const failedOpen = request();
    const failedOpenId = [...provider.approvals.keys()][0];
    const openFixture = provider.openPkmChat;
    provider.openPkmChat = async () => { throw new Error("Notification navigation fixture failed."); };
    notifications.at(-1).resolve("Open Chat"); await settle();
    assert.strictEqual(notifications.at(-1).kind, "error");
    assert.match(notifications.at(-1).title, /Notification navigation fixture failed/);
    assert(provider.approvals.has(failedOpenId), "Failed navigation must not resolve authorization");
    provider.openPkmChat = openFixture;
    provider.resolveApproval(failedOpenId, "deny"); assert.strictEqual(await failedOpen, false);

    const dismissed = request();
    const dismissedId = [...provider.approvals.keys()][0];
    notifications.at(-1).resolve(undefined);
    await settle();
    assert(provider.approvals.has(dismissedId), "Dismissing a notification leaves the decision pending");
    provider.resolveApproval(dismissedId, "deny"); assert.strictEqual(await dismissed, false);

    const denied = request();
    notifications.at(-1).resolve("Refuse");
    await settle();
    provider.resolveApproval([...provider.approvals.keys()][0], "deny");
    assert.strictEqual(await denied, false);

    const all = request();
    notifications.at(-1).resolve("Allow All");
    await settle();
    assert.notStrictEqual(chat.permissionMode, "allow-all", "Only the Chat's inline approval can grant Allow All");
    provider.resolveApproval([...provider.approvals.keys()][0], "allow-all");
    assert.strictEqual(await all, true);
    assert.strictEqual(chat.permissionMode, "allow-all");
    assert.strictEqual(provider.store.load(chat.id, false).permissionMode, "allow-all");
    await provider.handle({ type: "permissionMode", value: "ask" });

    const batch = request(owner.signal, true);
    const batchId = [...provider.approvals.keys()][0];
    assert.deepStrictEqual(notifications.at(-1).actions, ["Open Chat"], "Special batch/quota safeguards stay in Chat");
    notifications.at(-1).resolve("Allow All"); await settle();
    assert(provider.approvals.has(batchId));
    provider.resolveApproval(batchId, "deny"); assert.strictEqual(await batch, false);

    const cancelled = new AbortController();
    const stale = request(cancelled.signal);
    const staleNotice = notifications.at(-1);
    cancelled.abort(); await assert.rejects(stale, /cancelled/);
    const stored = JSON.stringify(provider.store.load(chat.id, false));
    staleNotice.resolve("Allow All"); await settle();
    assert.strictEqual(JSON.stringify(provider.store.load(chat.id, false)), stored, "A cancelled notification must not mutate permissions");

    const replacedSignal = new AbortController();
    const replaced = request(replacedSignal.signal);
    const replacedNotice = notifications.at(-1);
    provider.running.set(chat.id, new AbortController());
    replacedNotice.resolve("Allow All"); await settle();
    assert.strictEqual(chat.permissionMode, "ask", "An approval cannot transfer to a replacement request");
    replacedSignal.abort(); await assert.rejects(replaced, /cancelled/);
    provider.running.set(chat.id, owner);

    const question = provider.requestDecision(chat, "Choose the next step", "A user answer is required.",
      [{ value: "yes", label: "Yes" }, { value: "no", label: "No" }], owner.signal);
    const decisionId = [...provider.decisions.keys()][0];
    assert.match(notifications.at(-1).title, /waiting for your input/);
    assert.deepStrictEqual(notifications.at(-1).actions, ["Open Chat"]);
    notifications.at(-1).resolve("Open Chat"); await settle();
    assert(provider.decisions.has(decisionId), "Opening a question must not answer it");
    await provider.handle({ type: "decision", id: decisionId, value: "no" });
    assert.strictEqual(await question, "no");

    const disposalSignal = new AbortController();
    const disposal = request(disposalSignal.signal);
    const disposalNotice = notifications.at(-1);
    provider.disposed = true;
    disposalNotice.resolve("Allow All"); await settle();
    assert.strictEqual(chat.permissionMode, "ask", "Disposed hosts must ignore late actions");
    provider.disposed = false;
    disposalSignal.abort(); await assert.rejects(disposal, /cancelled/);

    const oneTimeInline = request();
    await provider.handle({ type: "approval", id: [...provider.approvals.keys()][0], value: "approve-once" });
    assert.strictEqual(await oneTimeInline, true);
    assert(!chat.permissionGrants.includes("notification-fixture"));
  } finally {
    provider.openPkmChat = openPkmChat;
    provider.chat = chat;
    provider.disposed = false;
  }
};

exports.testTerminal = async (provider, notifications) => {
  const chat = provider.chat;
  const count = notifications.length;
  provider.notifyChat(chat, "terminal-fixture", "responseComplete");
  provider.notifyChat(chat, "terminal-fixture", "responseComplete");
  assert.strictEqual(notifications.length, count + 1, "An event identity is notified only once");
  assert.match(notifications.at(-1).title, /response completed/);
  provider.notifyChat(chat, "task-fixture", "taskComplete");
  assert.match(notifications.at(-1).title, /Task completed/);
  assert.strictEqual(notifications.at(-1).kind, "info");
  provider.notifyChat(chat, "failed-fixture", "failed", "Provider refused the request.");
  assert.match(notifications.at(-1).title, /Provider refused/);
  assert.strictEqual(notifications.at(-1).kind, "error");
  provider.notifyChat(chat, "memory-fixture", "memoryFailed", "Extraction budget exceeded.");
  assert.match(notifications.at(-1).title, /response saved, but memory organization failed/);
  assert.strictEqual(notifications.at(-1).kind, "error");
};

if (require.main === module) exports.testCatalogs();
