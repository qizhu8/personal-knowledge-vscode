const test = require("node:test");
const assert = require("node:assert/strict");
const { createBrowserChatTranscriptReader } = require("../dist/chat/browser-chat-transcript");
const fs = require("node:fs");
const { join } = require("node:path");
const { tmpdir } = require("node:os");
const { randomBytes, randomUUID } = require("node:crypto");
const { execFileSync, fork, spawn } = require("node:child_process");
const { once } = require("node:events");
const { createServer } = require("node:net");
const { request } = require("node:https");
const { setTimeout: delay } = require("node:timers/promises");
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
  const home = fs.mkdtempSync(join(tmpdir(), "pkm-chat-"));
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

function installFixture(installed) {
  const project = join(__dirname, "../..");
  const payload = join(installed, "next-runtime");
  const copy = (source, target) => {
    fs.mkdirSync(join(target, ".."), { recursive: true });
    fs.cpSync(source, target, { recursive: true, dereference: true });
  };
  copy(join(project, "legacy/dist"), join(installed, "dist"));
  copy(join(project, "legacy/package.json"), join(installed, "package.json"));
  const version = JSON.parse(fs.readFileSync(join(installed, "package.json"))).version;
  require("../../scripts/stage-runtime.cjs").stage(payload, {
    production: true, extensionVersion: version, browserWebview: true,
  });
  return version;
}

test("installed-layout PKM daemon serves only the consented Original Chat over TLS after native writer exits", { timeout: 30_000 }, async t => {
  const f = fixture();
  const installRoot = fs.mkdtempSync(join(__dirname, ".transcript-install-"));
  f.installed = join(installRoot, "uone.personal-knowledge-fixture");
  f.grant.chatHostId = randomUUID();
  const children = [];
  t.after(async () => {
    for (const child of children) if (child.exitCode === null && child.signalCode === null) {
      const done = once(child, "exit");
      child.kill();
      await done;
    }
    fs.rmSync(f.home, { recursive: true, force: true });
    fs.rmSync(installRoot, { recursive: true, force: true });
  });
  const options = { knowledgeRoot: f.grant.workspaceRoot, globalStoragePath: f.globalStoragePath,
    extensionVersion: installFixture(f.installed),
    serviceEntryPath: join(f.installed, "dist/runtime/pkm-service-entry.js") };
  const { pkmServiceIdentity } = require("../dist/runtime/pkm-service");
  const { PKM_SERVICE_TRANSCRIPT_PROVISION } = require("../dist/runtime/pkm-service-browser-transcript");
  const env = { PATH: process.env.PATH, HOME: f.home, PKM_SERVICE_TEST_LIFECYCLE_MS: "50" };
  const fixtureEntry = join(__dirname, "fixture-detached-browser-chat.js");
  const ready = async child => {
    children.push(child);
    return Promise.race([once(child, "message").then(([data]) => data),
      once(child, "exit").then(([code]) => { throw Error(`Fixture exited before ready: ${code}`); })]);
  };
  const pin = createServer().listen(0, "127.0.0.1");
  await once(pin, "listening");
  const { port } = pin.address();
  await new Promise(resolve => pin.close(resolve));
  const origin = `https://127.0.0.1:${port}`;
  const certPath = join(f.home, "fixture-cert.pem"), keyPath = join(f.home, "fixture-key.pem");
  execFileSync("openssl", ["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-days", "1",
    "-subj", "/CN=127.0.0.1", "-addext", "subjectAltName=IP:127.0.0.1", "-keyout", keyPath, "-out", certPath],
  { env, stdio: "ignore" });
  const native = fork(fixtureEntry, [JSON.stringify(f)], { env });
  const exited = once(native, "exit");
  const { chatId: nativeChat, otherId } = await ready(native);

  const identity = pkmServiceIdentity(options);
  const root = fs.statSync(options.knowledgeRoot);
  const cert = fs.readFileSync(certPath, "utf8"), token = randomBytes(32).toString("base64url");
  const file = join(identity.serviceDirectory, PKM_SERVICE_TRANSCRIPT_PROVISION);
  fs.mkdirSync(identity.serviceDirectory, { recursive: true, mode: 0o700 });
  fs.writeFileSync(file, JSON.stringify({
    schema: "pkm.service-browser-transcript/v1", serviceIdentity: identity.identity,
    root: options.knowledgeRoot, rootDevice: root.dev, rootInode: root.ino, actorId: f.grant.actorId,
    generation: f.grant.generation, chatHostId: f.grant.chatHostId, namespace: f.namespace, chatId: nativeChat,
    address: "127.0.0.1", port, httpsOrigin: origin, cert, key: fs.readFileSync(keyPath, "utf8"), token,
  }), { mode: 0o600 });
  const daemon = spawn(process.execPath, [options.serviceEntryPath, JSON.stringify(options)], {
    env, stdio: ["ignore", "pipe", "pipe"],
  });
  children.push(daemon);
  let startupError = "";
  daemon.stderr.on("data", chunk => { startupError += chunk; });
  const stopped = once(daemon, "exit");
  const metadata = join(identity.serviceDirectory, "endpoint.json");
  for (let i = 0; i < 200 && !fs.existsSync(metadata); ++i) {
    assert.equal(daemon.exitCode, null, `daemon exited before publishing its private endpoint: ${startupError}`);
    await delay(25);
  }
  assert.equal(JSON.parse(fs.readFileSync(metadata)).pid, daemon.pid);
  native.send(options);
  assert.equal((await exited)[0], 0);
  assert.equal(JSON.parse(fs.readFileSync(metadata)).pid, daemon.pid);
  const tls = (path, body, headers = {}) => new Promise((resolve, reject) => {
    const req = request(`${origin}${path}`, { ca: cert, agent: false, method: body === undefined ? "GET" : "POST",
      headers: { origin, "content-type": "application/json", ...headers } }, res => {
      let raw = "";
      res.setEncoding("utf8").on("data", chunk => { raw += chunk; });
      res.on("end", () => resolve({ status: res.statusCode, headers: res.headers, raw }));
    });
    req.on("error", reject);
    req.end(body === undefined ? undefined : JSON.stringify(body));
  });

  const storedPath = join(f.grant.workspaceRoot, ".pkm", "state", "api-chats", f.namespace, `${nativeChat}.json`);
  const original = fs.readFileSync(storedPath);
  assert.equal(JSON.parse(original).version, 2);
  const read = { command: "chatMessages", id: nativeChat };
  assert.equal((await tls("/mcp", read)).status, 404);
  assert.equal((await tls("/webview/message", read)).status, 401);
  assert.equal((await tls("/webview/session", { token, remember: true }, { origin: "https://not-pkm.test" })).status, 403);
  assert.equal((await tls("/webview/session", { token: randomUUID(), remember: true })).status, 401);
  const login = await tls("/webview/session", { token, remember: true });
  assert.equal(login.status, 200);
  const [cookie] = login.headers["set-cookie"];
  assert.match(cookie, /HttpOnly; Secure; SameSite=Strict/);
  const session = { cookie: cookie.split(";")[0] };
  assert.equal((await tls("/webview/", undefined, session)).headers.location, "/webview/chat");
  assert.match((await tls("/webview/chat", undefined, session)).raw, /webview-chat\.js/);
  const send = cmd => tls("/webview/message", cmd, session);
  assert.deepEqual(JSON.parse((await send({ command: "chatList" })).raw).items.map(row => row.id), [nativeChat]);
  assert.equal((await send({ ...read, id: otherId })).status, 409);
  assert.equal((await send({ command: "list", q: "", caseSensitive: false })).status, 409);
  const first = await send(read);
  assert.equal(first.status, 200);
  const page = JSON.parse(first.raw);
  assert.equal(page.chatId, nativeChat);
  assert.deepEqual(page.messages.slice(0, 2), [
    { id: "q", role: "user", status: "complete", content: "same Original Chat question" },
    { id: "a", role: "assistant", status: "complete", content: "same Original Chat answer" },
  ]);
  const next = await send({ ...read, cursor: page.nextCursor });
  assert.equal(next.status, 200);
  assert.deepEqual(JSON.parse(next.raw).messages, [{ id: "m20", role: "user", status: "complete", content: "message 20" }]);
  assert.deepEqual(fs.readFileSync(storedPath), original);
  const nativeConsent = bindNativeBrowserChatTranscriptConsent({ ...f, assertCurrent() {} }, async () => false);
  nativeConsent.revoke(nativeChat);
  assert.equal((await send({ ...read, cursor: page.nextCursor })).status, 409);
  assert.deepEqual(JSON.parse((await send({ command: "chatList" })).raw).items, []);

  // The administrative client must reuse the live daemon; drain closes TLS as well as local IPC.
  execFileSync(process.execPath, [fixtureEntry, JSON.stringify({ installed: f.installed, drain: options })], { env, timeout: 5000 });
  assert.equal((await stopped)[0], 0);
  await assert.rejects(tls("/webview/"), /ECONNREFUSED/);
});
