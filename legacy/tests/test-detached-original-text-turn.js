const assert = require("node:assert/strict");
const { join } = require("node:path");
const { randomUUID, createHash } = require("node:crypto");
const { mkdirSync, rmSync, realpathSync } = require("node:fs");
const { pathToFileURL } = require("node:url");
const { createServer } = require("node:http");
const { once } = require("node:events");
const { registerHooks } = require("node:module");
const { test } = require("node:test");
const { setTimeout: delay } = require("node:timers/promises");

const load = name => require(join(process.env.PKM_CHAT_TEST_BUILD || join(__dirname, "../dist"), "chat", name));
const hook = registerHooks({ resolve(specifier, context, next) {
  if (specifier === "vscode") throw Error("Detached turns cannot load the VS Code API");
  return next(specifier, context);
} });
const { approveDetachedOriginalTextTurn, approveDetachedOriginalConversation,
  bindDetachedOriginalTextTurn } = load("detached-original-text-turn");
const { captureExecutionContext } = load("execution-context");
const { ApiChatStore } = load("api-chat-store");
hook.deregister();

test("plain-Node Original Chat owner admits one exact native-approved turn and stops its persisted lease", { timeout: 8000 }, async t => {
  const tmp = join(__dirname, `.detached-turn-${randomUUID()}`);
  mkdirSync(tmp, { mode: 0o700 });
  t.after(() => rmSync(tmp, { recursive: true, force: true }));
  const root = realpathSync(tmp), uri = pathToFileURL(root).href;
  const namespace = createHash("sha256").update(uri).digest("hex").slice(0, 16);
  const grant = { workspaceRoot: root, actorId: "browser", generation: "fixture", chatHostId: randomUUID() };
  const execution = captureExecutionContext(grant.chatHostId, [{ uri: { scheme: "file", fsPath: root, toString: () => uri } }], root, true, "read-only");
  const store = new ApiChatStore(join(root, ".pkm", "state"), namespace);
  const chat = store.create();
  Object.assign(chat, { permissionMode: "read-only", includeHistory: false, builtinTools: [], vscodeTools: [],
    activityCreditLimit: -1, modelProvider: "openai-compatible", modelProfileId: "fixture" });
  store.save(chat);
  store.startTask(chat, "Existing Original Task");
  const sessionId = chat.sessionId;
  const requests = [];
  let resolveClosed, expiryStarted, expiryClosed;
  const closed = new Promise(resolve => { resolveClosed = resolve; });
  const expiring = new Promise(resolve => { expiryStarted = resolve; });
  const disconnectedOnExpiry = new Promise(resolve => { expiryClosed = resolve; });
  const server = createServer(async (req, res) => {
    let raw = "";
    for await (const chunk of req) raw += chunk;
    const body = JSON.parse(raw);
    requests.push(body);
    res.writeHead(200, { "content-type": "text/event-stream" });
    res.write('data: {"choices":[{"index":0,"delta":{"content":"fixture output"}}]}\n\n');
    if (body.messages.at(-1).content === "hold") res.once("close", resolveClosed);
    else if (body.messages.at(-1).content === "hold until expiry") {
      res.once("close", expiryClosed);
      expiryStarted();
    }
    else res.end('data: {"choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n');
  }).listen(0, "127.0.0.1");
  t.after(() => { server.closeAllConnections(); server.close(); });
  await once(server, "listening");
  const model = { provider: "openai-compatible", endpoint: `http://127.0.0.1:${server.address().port}/v1`,
    apiVersion: "2024-06-01", timeoutMs: 4000, contextWindow: 8192, maxOutputTokens: 512,
    profile: { id: "fixture", model: "fixture-model", label: "Fixture", status: "active", contextWindow: 8192, maxOutputTokens: 512 } };
  const approve = (text, yes = true) => approveDetachedOriginalTextTurn({ grant, namespace, chatId: chat.id, text, execution, model,
    assertNativeOwner() {}, async confirm(detail) { assert.equal(detail.text, text); assert.equal(detail.endpoint, model.endpoint); return yes; } });
  const bind = approval => bindDetachedOriginalTextTurn(approval, {
    assertCurrent(received) { assert.deepEqual(received, grant); },
    async readProviderKey(pinned) { assert.deepEqual(pinned, model); return "fixture-key"; },
    async withWriter(work) { return work(); },
  });
  assert.equal(await approve("unapproved", false), undefined);
  const noTools = store.load(chat.id, false);
  noTools.vscodeTools = ["copilot_listDirectory"];
  store.save(noTools);
  await assert.rejects(approve("not eligible"), /unavailable/);
  noTools.vscodeTools = [];
  store.save(noTools);
  const approval = await approve("finish");
  const owner = bind(approval);
  assert.throws(() => owner.getSendTarget(grant, { chatId: randomUUID() }), /unavailable/);
  const denied = owner.getSendTarget(grant, { chatId: chat.id });
  assert.equal((await owner.sendChatTurn(grant, { ...denied, text: "not approved" })).status, "not-sent");
  assert.equal(requests.length, 0);
  const target = owner.getSendTarget(grant, { chatId: chat.id });
  const competing = bind(approval);
  const otherTarget = competing.getSendTarget(grant, { chatId: chat.id });
  const admissions = await Promise.all([owner.sendChatTurn(grant, { ...target, text: "finish" }),
    competing.sendChatTurn(grant, { ...otherTarget, text: "finish" })]);
  assert.equal(admissions.filter(receipt => receipt.status === "completed").length, 1);
  assert.deepEqual(await owner.sendChatTurn(grant, { ...target, text: "finish" }), admissions[0]);
  assert.throws(() => bind(approval).getSendTarget(grant, { chatId: chat.id }), /unavailable/);
  assert.equal(requests.length, 1);
  assert.equal(requests[0].model, "fixture-model");
  assert.equal(requests[0].tools, undefined);
  assert.match(requests[0].messages[0].content, new RegExp(sessionId));

  const next = bind(await approve("hold"));
  const ref = next.getSendTarget(grant, { chatId: chat.id });
  const pending = next.sendChatTurn(grant, { ...ref, text: "hold" });
  for (let i = 0; i < 80 && requests.length < 2; i++) await delay(20);
  const persisted = store.load(chat.id, false);
  assert.equal(persisted.progress.attemptId, ref.turnId);
  assert.equal(persisted.sessionId, sessionId);
  assert.throws(() => store.assertRunnable(persisted), /already running/);
  assert.throws(() => next.stopChatTurn(grant, { ...ref, turnId: randomUUID() }), /unavailable/);
  assert.equal(next.stopChatTurn(grant, ref).status, "stop-requested");
  assert.equal((await pending).status, "cancelled");
  await closed;
  const settled = store.load(chat.id, false);
  assert.equal(settled.progress.status, "cancelled");
  assert.equal(settled.messages.at(-1).status, "cancelled");
  assert.equal(settled.messages.at(-1).taskId, sessionId);
  assert.match(requests[1].messages[1].content, /Original current-task instruction.*\nfinish/);
  assert.deepEqual(store.list().map(row => row.id), [chat.id]);

  const conversation = await approveDetachedOriginalConversation({ grant, namespace, chatId: chat.id, execution, model,
    assertNativeOwner() {}, async confirm() { return true; } });
  const now = Date.now();
  let clock = now;
  const mock = t.mock.method(Date, "now", () => clock);
  try {
    const expiresAt = now + 5_000;
    const expiringOwner = bind({ ...conversation, expiresAt });
    const target = expiringOwner.getSendTarget(grant, { chatId: chat.id });
    const inFlight = expiringOwner.sendChatTurn(grant, { ...target, text: "hold until expiry" });
    await expiring;
    clock = expiresAt;
    await assert.rejects(inFlight, /unavailable/);
    await disconnectedOnExpiry;
    assert.throws(() => expiringOwner.getSendTarget(grant, { chatId: chat.id }), /unavailable/);
    assert.throws(() => expiringOwner.readSettledReply(chat.id), /unavailable/);
    const cancelled = store.load(chat.id, false);
    assert.equal(cancelled.progress.attemptId, target.turnId);
    assert.equal(cancelled.progress.status, "cancelled");
    assert.equal(cancelled.messages.at(-1).status, "cancelled");
    assert.equal(cancelled.sessionId, sessionId);
  } finally { mock.mock.restore(); }
});
