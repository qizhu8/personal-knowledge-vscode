const test = require("node:test");
const assert = require("node:assert/strict");
const { createBrowserChatTranscriptReader } = require("../dist/chat/browser-chat-transcript");
const fs = require("node:fs");
const { join, relative } = require("node:path");
const { randomUUID } = require("node:crypto");
const { fork } = require("node:child_process");
const { once } = require("node:events");
const { ApiChatStore } = require("../dist/chat/api-chat-store");
const { bindDetachedBrowserChatTranscript, bindNativeBrowserChatTranscriptConsent } =
  require("../dist/chat/detached-browser-chat-transcript");

const grant = { actorId: "browser", workspaceRoot: "/fixture", generation: "g1", chatHostId: "00000000-0000-0000-0000-000000000001" };
const chatId = "00000000-0000-0000-0000-000000000002";
const message = (role, content) => ({ id: content, role, content, status: "complete", toolCalls: [{ secret: true }] });

test("transcript cursors grant only the reviewed snapshot and expose no tool evidence", async () => {
  const messages = [message("user", "question"), message("assistant", "answer")];
  let allowed = true, prompts = 0;
  const read = createBrowserChatTranscriptReader(grant, {
    assertCurrent() { if (!allowed) throw Error("revoked"); },
    async load() { return { title: "Test", messages }; },
    async confirm() { prompts++; return true; },
  });
  const first = await read(grant, { chatId, limit: 1 });
  await assert.rejects(read({ ...grant, actorId: "other" }, { chatId, cursor: first.nextCursor }), /not available/);
  const second = await read(grant, { chatId, cursor: first.nextCursor });
  assert.deepEqual([...first.messages, ...second.messages], messages.map(({ id, role, content, status }) => ({ id, role, content, status })));
  assert.equal(prompts, 1);
  messages.push(message("user", "new turn"));
  await assert.rejects(read(grant, { chatId, cursor: first.nextCursor }), /not available/);
  allowed = false;
  await assert.rejects(read(grant, { chatId, cursor: first.nextCursor }), /revoked/);
});

test("decline or revoke during native consent releases no transcript", async () => {
  let allowed = true;
  const read = createBrowserChatTranscriptReader(grant, {
    assertCurrent() { if (!allowed) throw Error("revoked"); },
    async load() { return { title: "Test", messages: [message("user", "secret")] }; },
    async confirm() { return false; },
  });
  await assert.rejects(read(grant, { chatId }), /not available/);
  const revoke = createBrowserChatTranscriptReader(grant, {
    assertCurrent() { if (!allowed) throw Error("revoked"); },
    async load() { return { title: "Test", messages: [message("user", "secret")] }; },
    async confirm() { allowed = false; return true; },
  });
  await assert.rejects(revoke(grant, { chatId }), /revoked/);
});

function fixture() {
  const home = join(__dirname, `.transcript-${randomUUID().slice(0, 8)}`);
  const root = join(home, "knowledge");
  fs.mkdirSync(root, { recursive: true, mode: 0o700 });
  return { home, grant: { ...grant, workspaceRoot: fs.realpathSync(root) }, namespace: "0123456789abcdef",
    token: randomUUID(), globalStoragePath: join(home, "global") };
}

test("native receipt requires exact per-Chat consent and is rechecked on every page", async t => {
  const f = fixture();
  t.after(() => fs.rmSync(f.home, { recursive: true, force: true }));
  let valid = true, confirmed = false;
  const authority = { ...f, assertCurrent() { if (!valid) throw Error("revoked"); } };
  const state = join(f.grant.workspaceRoot, ".pkm", "state");
  const store = new ApiChatStore(state, f.namespace);
  const chat = store.create();
  chat.messages.push({ id: "one", role: "user", status: "complete", content: "one" },
    { id: "two", role: "assistant", status: "complete", content: "two" });
  store.save(chat);
  const other = store.create();
  const native = bindNativeBrowserChatTranscriptConsent(authority, async () => confirmed);
  const read = bindDetachedBrowserChatTranscript(authority);
  const consent = join(state, "browser-transcript-consent");
  await assert.rejects(read(f.grant, { chatId: chat.id }), /not available/);
  assert.equal(await native.allow(chat.id), false);
  assert.equal(fs.existsSync(consent), false);
  confirmed = true;
  assert.equal(await native.allow(chat.id), true);
  const first = await read(f.grant, { chatId: chat.id, limit: 1 });
  for (const alternate of [{ generation: "g2" }, { actorId: "other" }, { chatHostId: randomUUID() }]) {
    const otherGrant = { ...f.grant, ...alternate };
    const otherRead = bindDetachedBrowserChatTranscript({ ...authority, grant: otherGrant });
    await assert.rejects(otherRead(otherGrant, { chatId: chat.id }), /not available/);
  }
  const wrongWorkspace = bindDetachedBrowserChatTranscript({ ...authority, namespace: "fedcba9876543210" });
  await assert.rejects(wrongWorkspace(f.grant, { chatId: chat.id }), /not available/);
  await assert.rejects(read(f.grant, { chatId: other.id }), /not available/);
  const file = join(consent, fs.readdirSync(consent).find(name => name.endsWith(".json")));
  const receipt = fs.readFileSync(file, "utf8");
  fs.writeFileSync(file, JSON.stringify({ ...JSON.parse(receipt), expiresAt: Date.now() - 1 }));
  await assert.rejects(read(f.grant, { chatId: chat.id, cursor: first.nextCursor }), /not available/);
  fs.writeFileSync(file, receipt);
  store.library.trash(chat.id);
  await assert.rejects(read(f.grant, { chatId: chat.id, cursor: first.nextCursor }), /not available/);
  store.library.restore(chat.id);
  chat.messages[1].content = "new unapproved content";
  store.save(chat);
  await assert.rejects(read(f.grant, { chatId: chat.id }), /not available/);

  let approve;
  const anotherWindow = bindNativeBrowserChatTranscriptConsent(authority, () => new Promise(resolve => { approve = resolve; }));
  const pending = anotherWindow.allow(chat.id);
  native.revoke(chat.id);
  approve(true);
  await assert.rejects(pending, /not available/);
  await native.allow(chat.id);
  const renewed = await read(f.grant, { chatId: chat.id, limit: 1 });
  await native.allow(chat.id);
  await assert.rejects(read(f.grant, { chatId: chat.id, cursor: renewed.nextCursor }), /not available/);
  native.revoke(chat.id);
  await assert.rejects(read(f.grant, { chatId: chat.id }), /not available/);
  valid = false;
  await assert.rejects(native.allow(chat.id), /revoked/);
});

test("loopback fixture in detached PKM service reads segmented Original Chat after native writer exits", { timeout: 15_000 }, async t => {
  const f = fixture();
  const subprocess = mode => fork(join(__dirname, "fixture-detached-browser-chat.js"), [mode, JSON.stringify(f)], {
    cwd: __dirname, env: { PATH: process.env.PATH, HOME: relative(__dirname, f.home) },
  });
  const children = [];
  t.after(async () => {
    for (const child of children) if (child.exitCode === null && child.signalCode === null) {
      const done = once(child, "exit");
      child.kill();
      await done;
    }
    fs.rmSync(f.home, { recursive: true, force: true });
  });
  const ready = async child => {
    children.push(child);
    return Promise.race([once(child, "message").then(([data]) => data),
      once(child, "exit").then(([code]) => { throw Error(`Fixture exited before ready: ${code}`); })]);
  };
  const port = await ready(subprocess("service"));
  const native = subprocess("native");
  const exited = once(native, "exit");
  const nativeChat = await ready(native);
  assert.equal((await exited)[0], 0);

  const storedPath = join(f.grant.workspaceRoot, ".pkm", "state", "api-chats", f.namespace, `${nativeChat}.json`);
  const original = fs.readFileSync(storedPath);
  assert.equal(JSON.parse(original).version, 2);
  const url = `http://127.0.0.1:${port}/transcript?chatId=${nativeChat}`;
  assert.equal((await fetch(url)).status, 401);
  const options = { headers: { authorization: `Bearer ${f.token}` } };
  const first = await fetch(url, options);
  assert.equal(first.status, 200);
  const page = await first.json();
  assert.equal(page.chatId, nativeChat);
  assert.deepEqual(page.messages, [{ id: "q", role: "user", status: "complete", content: "same Original Chat question" }]);
  const next = await fetch(`${url}&cursor=${page.nextCursor}`, options);
  assert.equal(next.status, 200);
  assert.deepEqual((await next.json()).messages, [{ id: "a", role: "assistant", status: "complete", content: "same Original Chat answer" }]);
  assert.deepEqual(fs.readFileSync(storedPath), original);
  assert.deepEqual(fs.readdirSync(join(f.grant.workspaceRoot, ".pkm", "state", "api-chats", f.namespace)), [`${nativeChat}.json`]);
});
