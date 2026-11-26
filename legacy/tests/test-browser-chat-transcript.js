const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const { join, dirname, isAbsolute } = require("node:path");
const { createHash, randomBytes, randomUUID } = require("node:crypto");
const { execFileSync, fork, spawn } = require("node:child_process");
const { once } = require("node:events");
const { createServer } = require("node:net");
const { request } = require("node:https");
const { createServer: createModelServer } = require("node:http");
const { pathToFileURL } = require("node:url");
const { setTimeout: delay } = require("node:timers/promises");
const build = process.env.PKM_CHAT_TEST_BUILD || join(__dirname, "../dist");
const load = name => require(join(build, name));
const { createBrowserChatTranscriptReader } = load("chat/browser-chat-transcript");
const { ApiChatStore } = load("chat/api-chat-store");
const { bindDetachedBrowserChatTranscript, bindNativeBrowserChatTranscriptConsent } =
  load("chat/detached-browser-chat-transcript");

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
  const home = join(__dirname, `.chat-${randomUUID().slice(0, 12)}`);
  fs.mkdirSync(home, { mode: 0o700 });
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
  const archive = process.env.PKM_TRANSCRIPT_TEST_VSIX;
  const digest = process.env.PKM_TRANSCRIPT_TEST_VSIX_SHA256;
  if (archive !== undefined || digest !== undefined) {
    assert(archive && isAbsolute(archive) && /^[a-f0-9]{64}$/.test(digest),
      "Supply an absolute candidate archive and its exact SHA-256.");
    assert.equal(execFileSync("sha256sum", ["--", archive], { encoding: "utf8" }).split(" ")[0], digest);
    execFileSync("unzip", ["-q", archive, "-d", dirname(installed)]);
    fs.renameSync(join(dirname(installed), "extension"), installed);
    const manifest = JSON.parse(fs.readFileSync(join(installed, "package.json")));
    assert.equal(`${manifest.publisher}.${manifest.name}`, "Uone.personal-knowledge");
    load("runtime/next-payload-verifier").verifyNextPayload(installed);
    return manifest.version;
  }
  const project = join(__dirname, "../..");
  const payload = join(installed, "next-runtime");
  const copy = (source, target) => {
    fs.mkdirSync(join(target, ".."), { recursive: true });
    fs.cpSync(source, target, { recursive: true, dereference: true });
  };
  copy(join(project, "legacy/dist"), join(installed, "dist"));
  if (process.env.PKM_CHAT_TEST_BUILD) copy(build, join(installed, "dist"));
  copy(join(project, "legacy/package.json"), join(installed, "package.json"));
  const version = JSON.parse(fs.readFileSync(join(installed, "package.json"))).version;
  require("../../scripts/stage-runtime.cjs").stage(payload, {
    production: true, extensionVersion: version, browserWebview: true,
  });
  if (process.env.PKM_CHAT_TEST_CORE_BUILD) {
    const manifestFile = join(payload, "manifest.json");
    const manifest = JSON.parse(fs.readFileSync(manifestFile));
    const name = "server/dist/browser-original-owner.js";
    const hash = bytes => createHash("sha256").update(bytes).digest("hex");
    copy(join(process.env.PKM_CHAT_TEST_CORE_BUILD, "browser-original-owner.js"), join(payload, name));
    manifest.files[name] = hash(fs.readFileSync(join(payload, name)));
    manifest.buildId = hash(JSON.stringify(manifest.files));
    fs.writeFileSync(manifestFile, JSON.stringify(manifest));
  }
  return version;
}

for (const mode of ["read", "send", "stop"])
test(`packaged PKM daemon ${mode} on the Original Chat over TLS after native writer exits`, { timeout: 60_000 }, async t => {
  const f = fixture();
  const installRoot = join(__dirname, `.transcript-install-${randomUUID()}`);
  fs.mkdirSync(installRoot, { mode: 0o700 });
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
  const { pkmServiceIdentity } = load("runtime/pkm-service");
  const { PKM_SERVICE_TRANSCRIPT_PROVISION } = load("runtime/pkm-service-browser-transcript");
  const env = { PATH: process.env.PATH, HOME: join(".", f.home.slice(__dirname.length + 1)), PKM_SERVICE_TEST_LIFECYCLE_MS: "50" };
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
  let modelCalls = 0, providerKey, providerStarted, providerClosed;
  if (mode !== "read") {
    const text = `fixture ${mode}`;
    f.namespace = createHash("sha256").update(pathToFileURL(f.grant.workspaceRoot).href).digest("hex").slice(0, 16);
    providerKey = `fixture-${randomUUID()}`;
    let started, closed;
    providerStarted = new Promise(resolve => { started = resolve; });
    providerClosed = new Promise(resolve => { closed = resolve; });
    const model = createModelServer(async (req, res) => {
      modelCalls++;
      let raw = "";
      for await (const chunk of req) raw += chunk;
      const request = JSON.parse(raw);
      if (req.url !== "/v1/chat/completions" || req.headers.authorization !== `Bearer ${providerKey}` ||
          request.model !== "fixture-model" || request.tools || request.messages.at(-1).content !== text) {
        res.writeHead(400).end();
        return;
      }
      res.once("close", closed);
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.write(`data: ${JSON.stringify({ choices: [{ index: 0, delta: { content: `saved fixture reply ${providerKey}` } }] })}\n\n`);
      started();
      if (mode === "send") res.end('data: {"choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n');
    }).listen(0, "127.0.0.1");
    t.after(() => { model.closeAllConnections(); model.close(); });
    await once(model, "listening");
    f.turn = { text, model: { provider: "openai-compatible", endpoint: `http://127.0.0.1:${model.address().port}/v1`,
      apiVersion: "2024-06-01", contextWindow: 8192, maxOutputTokens: 512, timeoutMs: 12000,
      profile: { id: "fixture", label: "Fixture", model: "fixture-model", status: "active", contextWindow: 8192, maxOutputTokens: 512 } } };
  }
  const certPath = join(f.home, "fixture-cert.pem"), keyPath = join(f.home, "fixture-key.pem");
  execFileSync("openssl", ["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-days", "1",
    "-subj", "/CN=127.0.0.1", "-addext", "subjectAltName=IP:127.0.0.1", "-keyout", keyPath, "-out", certPath],
  { env, stdio: "ignore" });
  const native = fork(fixtureEntry, [JSON.stringify(f)], { env, cwd: __dirname });
  const exited = once(native, "exit");
  const { chatId: nativeChat, otherId, approval } = await ready(native);

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
    ...(approval ? { turn: { approval, providerKey } } : {}),
  }), { mode: 0o600 });
  const daemon = spawn(process.execPath, [options.serviceEntryPath, JSON.stringify(options)], {
    env, cwd: __dirname, stdio: ["ignore", "pipe", "pipe"],
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
  if (mode === "read") {
    assert.equal((await send({ command: "originalChatTarget", chatId: nativeChat })).status, 409);
    const nativeConsent = bindNativeBrowserChatTranscriptConsent({ ...f, assertCurrent() {} }, async () => false);
    nativeConsent.revoke(nativeChat);
    assert.equal((await send({ ...read, cursor: page.nextCursor })).status, 409);
    assert.deepEqual(JSON.parse((await send({ command: "chatList" })).raw).items, []);
  } else {
    const target = { command: "originalChatTarget", chatId: nativeChat };
    assert.equal((await send({ ...target, chatId: otherId })).status, 409);
    const wrong = JSON.parse((await send(target)).raw);
    assert.equal(JSON.parse((await send({ ...wrong, command: "originalChatSend", text: "unapproved" })).raw).status, "not-sent");
    assert.equal(modelCalls, 0);
    const ref = JSON.parse((await send(target)).raw);
    const pending = send({ ...ref, command: "originalChatSend", text: f.turn.text });
    await providerStarted;
    if (mode === "stop") {
      const { chatId, turnId } = ref;
      assert.equal((await send({ command: "originalChatStop", chatId, turnId: randomUUID() })).status, 500);
      // Wait until the provider delta was consumed before cancelling the held stream.
      await delay(100);
      assert.equal(JSON.parse((await send({ command: "originalChatStop", chatId, turnId })).raw).status, "stop-requested");
    }
    assert.equal(JSON.parse((await pending).raw).status, mode === "stop" ? "cancelled" : "completed");
    await providerClosed;
    assert.equal(modelCalls, 1);
    assert.equal((await send(target)).status, 409);
    assert.equal((await send({ ...read, cursor: page.nextCursor })).status, 409);
    const reconnect = await tls("/webview/session", { token, remember: false });
    const reply = await tls("/webview/message", read, { cookie: reconnect.headers["set-cookie"][0].split(";")[0] });
    assert.equal(reply.status, 200);
    assert.equal(reply.raw.includes(providerKey), false);
    const saved = new ApiChatStore(join(f.grant.workspaceRoot, ".pkm", "state"), f.namespace).load(nativeChat, false);
    assert.equal(saved.sessionId, approval.sessionId);
    assert.equal(saved.progress.attemptId, ref.turnId);
    const messages = JSON.parse(reply.raw).messages;
    assert.equal(messages.length, 2);
    assert.equal(messages[0].content, f.turn.text);
    assert.equal(messages[1].content, "saved fixture reply [redacted]");
    assert.equal(saved.messages.at(-1).content, messages[1].content);
    assert.equal(saved.messages.at(-1).status, messages[1].status);
  }

  // The administrative client must reuse the live daemon; drain closes TLS as well as local IPC.
  execFileSync(process.execPath, [fixtureEntry, JSON.stringify({ installed: f.installed, drain: options })], { env, cwd: __dirname, timeout: 5000 });
  assert.equal((await stopped)[0], 0);
  await assert.rejects(tls("/webview/"), /ECONNREFUSED/);
});
