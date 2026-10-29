const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { randomUUID } = require("node:crypto");
const ts = require("typescript");

function sourceModule(file) {
  const exports = {};
  vm.runInNewContext(ts.transpileModule(fs.readFileSync(path.join(__dirname, "..", file), "utf8"), {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
  }).outputText, { exports, Buffer });
  return exports;
}
const { portalTaskAttempts, portalTaskReplyLink, validPortalTaskLink } = sourceModule("src/chat/portal-task-attempts.ts");
const plain = value => JSON.parse(JSON.stringify(value));

function fixture() {
  const requestId = randomUUID(), inputId = randomUUID(), originalId = randomUUID(), taskId = "fixture-task";
  const original = {
    id: originalId, role: "assistant", inputId, taskId, status: "failed", content: "Original partial answer", error: "Original immutable failure",
    progress: { attemptId: randomUUID(), status: "failed", startedAt: 1, finishedAt: 2 },
    portalTask: portalTaskReplyLink(originalId, requestId),
    reasoningSummaries: [{ text: "PRIVATE REASONING" }], toolCalls: [{ name: "command", arguments: "PRIVATE ARGUMENTS", status: "complete", result: "PRIVATE TOOL OUTPUT" }],
  };
  const chat = { id: randomUUID(), messages: [{ id: inputId, role: "user", taskId, content: "Approved task", status: "complete" }, original] };
  const retry = (predecessor = original, status = "complete") => {
    const message = {
      id: randomUUID(), role: "assistant", inputId, taskId, content: "Manual retry succeeded", status,
      progress: { attemptId: randomUUID(), retryOf: predecessor.progress?.attemptId || predecessor.id, startedAt: 3 },
      portalTask: portalTaskReplyLink(randomUUID(), undefined, predecessor),
    };
    chat.messages.push(message);
    return message;
  };
  return { chat, requestId, original, retry };
}

test("original failure remains immutable; explicit manual retry has independent identities and latest result", () => {
  const { chat, requestId, original, retry } = fixture();
  const receipt = JSON.stringify(original), next = retry();
  const snapshot = portalTaskAttempts(chat, requestId);
  assert.equal(JSON.stringify(original), receipt);
  assert.equal(snapshot.requestId, requestId);
  assert.equal(snapshot.queriedAttempt.replyId, original.id);
  assert.equal(snapshot.result.status, "failed");
  assert.equal(snapshot.result.error, original.error);
  assert.equal(snapshot.latestAttempt.replyId, next.id);
  assert.equal(snapshot.latestAttempt.attemptId, next.progress.attemptId);
  assert.equal(snapshot.latestResult.content, next.content);
  assert.equal(snapshot.attempts[1].retryOfReplyId, original.id);
  assert.equal(snapshot.attempts[1].retryOfAttemptId, original.progress.attemptId);
  assert.equal(portalTaskAttempts(chat, requestId, next.id).queriedAttempt.replyId, next.id);
});

test("unrelated latest Chat messages, matching prompts and forged links cannot leak", () => {
  const { chat, requestId, original, retry } = fixture(), next = retry();
  const rogue = { ...next, id: randomUUID(), inputId: randomUUID(), content: "PRIVATE UNRELATED RESPONSE" };
  const otherTask = { ...next, id: randomUUID(), taskId: "other-task", content: "PRIVATE OTHER TASK" };
  const unconfirmed = { ...next, id: randomUUID(), portalTask: { ...next.portalTask, shareConfirmed: undefined }, content: "PRIVATE UNCONFIRMED" };
  const forgedParent = { ...next, id: randomUUID(), portalTask: { ...next.portalTask, retryOfReplyId: randomUUID() }, content: "PRIVATE FORGED" };
  const wrongAttempt = { ...next, id: randomUUID(), progress: { ...next.progress, retryOf: randomUUID() }, content: "PRIVATE WRONG ATTEMPT" };
  chat.messages.push(rogue, otherTask, unconfirmed, forgedParent, wrongAttempt,
    { id: randomUUID(), role: "assistant", content: "PRIVATE LATEST MESSAGE", status: "complete" });
  const snapshot = portalTaskAttempts(chat, requestId);
  assert.equal(snapshot.totalAttempts, 2);
  assert.equal(snapshot.latestAttempt.replyId, next.id);
  assert(!JSON.stringify(snapshot).includes("PRIVATE"));
  assert.equal(portalTaskAttempts(chat, requestId, rogue.id), undefined);
  assert.equal(portalTaskAttempts(chat, requestId, randomUUID()), undefined);
  assert.equal(portalTaskAttempts(chat, randomUUID()), undefined);
  assert.equal(portalTaskReplyLink(randomUUID(), undefined, { ...original, status: "complete" }), undefined);
  assert.equal(portalTaskReplyLink(randomUUID()), undefined, "a normal send is never linked");
});

test("retry chains remain explicit across reload, including cancelled/long-tool attempts", () => {
  const { chat, requestId, original, retry } = fixture();
  const cancelled = retry(original, "cancelled");
  cancelled.toolCalls = [{ status: "failed", result: "Request interrupted. Execution may already have occurred." }];
  const running = retry(cancelled, "streaming");
  running.toolCalls = [{ status: "running" }];
  const snapshot = portalTaskAttempts(plain(chat), requestId);
  assert.equal(snapshot.totalAttempts, 3);
  assert.equal(snapshot.latestAttempt.replyId, running.id);
  assert.equal(snapshot.latestAttempt.status, "streaming");
  assert.equal(snapshot.latestResult, undefined, "a previous success must not masquerade as the running attempt's result");
  assert.equal(snapshot.latestAttempt.uncertainToolEffects, true);
  assert.equal(snapshot.attempts[1].uncertainToolEffects, true);
  assert.equal(snapshot.original.status, "failed");
});

test("query is read-only, detached, bounded and rejects ambiguous or invalid identities", () => {
  const { chat, requestId, original, retry } = fixture();
  let predecessor = original;
  for (let index = 0; index < 25; index++) predecessor = retry(predecessor, "failed");
  predecessor.content = "😀".repeat(9000);
  const before = JSON.stringify(chat), snapshot = portalTaskAttempts(chat, requestId);
  assert.equal(snapshot.totalAttempts, 26);
  assert.equal(snapshot.attempts.length, 16);
  assert.equal(snapshot.omittedAttempts, 10);
  assert(Buffer.byteLength(snapshot.latestResult.content, "utf8") <= 8000);
  assert(snapshot.latestResult.truncated);
  snapshot.original.status = "complete";
  assert.equal(JSON.stringify(chat), before);
  assert.throws(() => portalTaskAttempts(chat, "latest"), /identity/);
  chat.messages.push({ ...original });
  assert.equal(portalTaskAttempts(chat, requestId), undefined, "ambiguous original replies fail closed");
  assert.equal(validPortalTaskLink({ requestId, originalReplyId: original.id, retryOfReplyId: randomUUID() }), false);
  assert.equal(validPortalTaskLink({ requestId, originalReplyId: original.id }), true);
});

function viewFixture() {
  const text = fs.readFileSync(path.join(__dirname, "../src/chat/api-chat-view.ts"), "utf8");
  const ast = ts.createSourceFile("api-chat-view.ts", text, ts.ScriptTarget.Latest, true);
  const declaration = ast.statements.find(node => ts.isClassDeclaration(node) && node.name?.text === "ApiChatView");
  const names = new Set(["executeRemoteTask", "readPortalTaskAttempts", "send", "chooseVscodeModel", "availableVscodeModels", "invalidateModels"]);
  const methods = declaration.members.filter(node => names.has(node.name?.getText(ast))).map(node => node.getText(ast)).join("\n");
  const scope = {
    randomUUID, portalTaskAttempts, portalTaskReplyLink, portalPersonaSnapshot: value => value,
    vscode: { workspace: { isTrusted: true, workspaceFolders: [] } }, chatPkmUrl: (_namespace, id) => `pkm://fixture/chat/${id}`,
    AbortController, setInterval, clearInterval, setTimeout, clearTimeout, console, Map, Set,
    assertVscodeModelCallable() {}, vscodeModelProfile: model => model,
    abortable(promise, signal) {
      return new Promise((resolve, reject) => {
        const cancel = () => reject(new Error("Request cancelled."));
        signal.addEventListener("abort", cancel, { once: true });
        if (signal.aborted) cancel();
        promise.then(resolve, reject).finally(() => signal.removeEventListener("abort", cancel));
      });
    },
  };
  vm.runInNewContext(ts.transpileModule(`class Fixture { ${methods} }\nglobalThis.Fixture = Fixture;`, {
    compilerOptions: { target: ts.ScriptTarget.ES2022 },
  }).outputText, scope);
  const { chat, requestId } = fixture();
  chat.messages = [];
  const store = { namespace: "fixture", resolveChat: id => { assert.equal(id, chat.id); return chat; } };
  const view = Object.assign(Object.create(scope.Fixture.prototype), {
    openStore() { this.store = store; return store; }, assertRunnable() {},
    chats: new Map(), running: new Map(), queueDrains: new Set(),
    remoteControlledRequests: new Set(), remoteSources: new Map(), remoteProfiles: new Map(), agentControlledRequests: new Set(),
    approvals: new Map(), decisions: new Map(),
  });
  return { view, chat, requestId, scope };
}

test("remote execution observes/returns its reserved reply, never an unrelated newer assistant response", async () => {
  const { view, chat, requestId } = viewFixture();
  const controller = new AbortController(), observations = [];
  let ownReply;
  view.send = async (_prompt, _chat, parent) => {
    ownReply = { id: parent.portalTask.replyId, inputId: randomUUID(), role: "assistant", content: "task result", status: "complete",
      progress: { attemptId: randomUUID(), steps: [{ label: "Own task stage" }] } };
    chat.messages.push(ownReply, { id: randomUUID(), role: "assistant", content: "PRIVATE LATEST RESPONSE", status: "complete" });
    chat.progress = { steps: [{ label: "PRIVATE LATEST STAGE" }] };
    assert.equal(parent.portalTask.requestId, requestId);
  };
  const result = await view.executeRemoteTask("approved task", controller.signal, requestId, chat.id, value => observations.push(value));
  assert.equal(result.replyId, ownReply.id);
  assert.equal(result.attemptId, ownReply.progress.attemptId);
  assert.equal(result.content, "task result");
  assert.equal(observations[0].stage, "Own task stage");
  assert(!JSON.stringify(observations).includes("PRIVATE"));
  assert.equal(view.remoteControlledRequests.size, 0);
});

test("remote cancellation never converts late completion to success or aborts an unrelated next request", async () => {
  const { view, chat, requestId } = viewFixture(), controller = new AbortController(), toolController = new AbortController();
  view.send = async (_prompt, _chat, parent) => {
    view.running.set(chat.id, toolController);
    chat.messages.push({ id: parent.portalTask.replyId, role: "assistant", content: "late result", status: "complete" });
    controller.abort();
  };
  await assert.rejects(view.executeRemoteTask("approved task", controller.signal, requestId, chat.id), /cancelled.*effects/);
  assert.equal(toolController.signal.aborted, false, "cancellation is bound to the original parent signal, not whichever request now owns this Chat");
  assert.equal(view.remoteControlledRequests.size, 0);
  assert.equal(view.agentControlledRequests.size, 0);
});

test("cancelled parent never dispatches, including during model discovery that ignores AbortSignal", async () => {
  const { view, chat } = viewFixture(), controller = new AbortController();
  view.captureExecution = () => ({ digest: "fixture" });
  view.settings = () => ({ provider: "vscode", needsModelConnection: true });
  chat.vscodeModelId = "fixture-model";
  chat.modelProvider = "vscode";
  let started;
  const discoveryStarted = new Promise(resolve => { started = resolve; });
  view.availableVscodeModels = async () => { started(); return new Promise(() => {}); };
  const result = view.send("task", chat, { signal: controller.signal });
  await discoveryStarted;
  controller.abort();
  await assert.rejects(result, /cancelled/);
  assert.equal(view.running.size, 0);
  assert.equal(chat.messages.length, 0);
  await assert.rejects(view.send("task", chat, { signal: controller.signal }), /cancelled before dispatch/);
});

test("read-only provider reloads persisted task identity rather than using an idle stale Chat", () => {
  const { view, chat, requestId } = viewFixture();
  const data = fixture();
  data.chat.id = chat.id;
  Object.assign(chat, data.chat);
  view.chats.set(chat.id, { ...chat, messages: [] });
  const snapshot = view.readPortalTaskAttempts(chat.id, data.requestId);
  assert.equal(snapshot.original.replyId, data.original.id);
  assert.equal(view.readPortalTaskAttempts(chat.id, requestId), undefined);
});

test("provider explicitly reads original failed reply after a successful manual retry has been persisted", () => {
  const { view, chat } = viewFixture(), data = fixture();
  const retried = data.retry();
  data.chat.id = chat.id;
  const reloaded = plain(data.chat);
  view.openStore = function () {
    this.store = { resolveChat: () => reloaded };
    return this.store;
  };
  const queriedOriginal = view.readPortalTaskAttempts(chat.id, data.requestId, data.original.id);
  assert.equal(queriedOriginal.queriedAttempt.status, "failed");
  assert.equal(queriedOriginal.result.error, "Original immutable failure");
  assert.equal(queriedOriginal.latestResult.replyId, retried.id);
  assert.equal(queriedOriginal.latestResult.status, "complete");
  assert.equal(view.readPortalTaskAttempts(chat.id, data.requestId, retried.id).result.content, "Manual retry succeeded");
});

test("explicit Copilot SDK Connect is cancellable, cleans discovery and does not reopen picker after cancellation", async () => {
  const { view, chat, scope } = viewFixture();
  view.discoveries = new Set();
  view.availableVscodeModels = async () => [];
  let pickerCalls = 0, cancellation, disposeCalls = 0, connectSignal;
  scope.vscode.QuickPickItemKind = { Separator: -1 };
  scope.vscode.ProgressLocation = { Notification: 15 };
  scope.vscode.window = {
    showQuickPick: async choices => { await choices; pickerCalls++; return { id: "__connect_copilot_sdk__" }; },
    withProgress: async (options, task) => {
      assert.equal(options.cancellable, true);
      const pending = task({}, {
        isCancellationRequested: false,
        onCancellationRequested: callback => { cancellation = callback; return { dispose() { disposeCalls++; } }; },
      });
      cancellation();
      return pending;
    },
  };
  scope.discoverCopilotSdkModels = (_host, signal, _deps, interactive) => {
    connectSignal = signal;
    assert.equal(interactive, true);
    return new Promise(() => {});
  };
  assert.equal(await view.chooseVscodeModel(chat), false);
  assert.equal(connectSignal.aborted, true);
  assert.equal(pickerCalls, 1);
  assert.equal(disposeCalls, 1);
  assert.equal(view.discoveries.size, 0);
});

test("force-refresh picker coalesces discovery already serving a send without changing its epoch", async () => {
  const { view, scope } = viewFixture();
  view.vscodeModels = [];
  view.modelEpoch = 0;
  let resolveDiscovery, calls = 0;
  scope.discoverVscodeModels = async () => { calls++; return new Promise(resolve => { resolveDiscovery = resolve; }); };
  const send = view.availableVscodeModels();
  const pending = view.modelDiscovery;
  const picker = view.availableVscodeModels(undefined, true);
  assert.equal(view.modelDiscovery, pending);
  assert.equal(view.modelEpoch, 0);
  assert.equal(calls, 1);
  const models = [{ id: "selected-model" }];
  resolveDiscovery(models);
  const [sendModels, pickerModels] = await Promise.all([send, picker]);
  assert.equal(sendModels, models);
  assert.equal(pickerModels, models);
  assert.equal(view.modelDiscovery, undefined);
  assert.equal(await view.availableVscodeModels(), models);
  const fresh = view.availableVscodeModels(undefined, true);
  assert.equal(calls, 2, "force still bypasses completed cached discovery");
  resolveDiscovery(models);
  await fresh;
});

test("actual catalog invalidation still fails stale discovery explicitly and never replaces selected model", async () => {
  const { view, scope } = viewFixture();
  view.vscodeModels = [];
  view.modelEpoch = 0;
  view.refresh = () => {};
  const resolvers = [];
  scope.discoverVscodeModels = () => new Promise(resolve => { resolvers.push(resolve); });
  const stale = view.availableVscodeModels();
  const rejected = assert.rejects(stale, /catalog changed during discovery/);
  view.invalidateModels();
  const fresh = view.availableVscodeModels(undefined, true);
  const freshPending = view.modelDiscovery;
  resolvers[0]([{ id: "stale" }]);
  await rejected;
  assert.equal(view.modelDiscovery, freshPending, "old cleanup must not remove new discovery");
  assert.equal(view.vscodeModels.length, 0);
  const selected = [{ id: "explicit-selected-model" }];
  resolvers[1](selected);
  assert.equal(await fresh, selected);
});

test("one cancelled picker wait does not cancel shared discovery serving a send", async () => {
  const { view, scope } = viewFixture();
  view.vscodeModels = [];
  view.modelEpoch = 0;
  let resolveDiscovery, discoverySignal;
  scope.discoverVscodeModels = (_host, signal) => {
    discoverySignal = signal;
    return new Promise(resolve => { resolveDiscovery = resolve; });
  };
  const send = view.availableVscodeModels();
  const cancellation = new AbortController();
  const picker = view.availableVscodeModels(cancellation.signal, true);
  cancellation.abort();
  await assert.rejects(picker, /cancelled/);
  assert.equal(discoverySignal.aborted, false);
  const models = [{ id: "selected-model" }];
  resolveDiscovery(models);
  assert.equal(await send, models);
  await assert.rejects(view.availableVscodeModels(cancellation.signal, true), /cancelled/);
  assert.equal(view.vscodeModels, models, "pre-cancelled force refresh must not clear the cache");
});

test("lazy Chat shell exposes an async request-scoped reader and coalesces backend loading", async () => {
  const text = fs.readFileSync(path.join(__dirname, "../src/chat/api-chat-shell.ts"), "utf8");
  const ast = ts.createSourceFile("api-chat-shell.ts", text, ts.ScriptTarget.Latest, true);
  const declaration = ast.statements.find(node => ts.isFunctionDeclaration(node) && node.name?.text === "registerApiChatShell");
  const scope = {
    vscode: {
      window: { registerWebviewViewProvider() { return { dispose() {} }; } },
      commands: { registerCommand() { return { dispose() {} }; } },
    },
    registerVisualizationWindow() {}, registerApiChatHost() {},
  };
  vm.runInNewContext(ts.transpileModule(`${declaration.getText(ast).replace(/^export /, "")}\nglobalThis.register = registerApiChatShell;`, {
    compilerOptions: { target: ts.ScriptTarget.ES2022 },
  }).outputText, scope);
  let loads = 0, release;
  const calls = [], payload = { requestId: randomUUID(), original: { status: "failed" } };
  const shell = scope.register({ subscriptions: [] }, async () => {
    loads++;
    await new Promise(resolve => { release = resolve; });
    return { readPortalTaskAttempts: (...args) => { calls.push(args); return args[2] === "unknown" ? undefined : payload; } };
  });
  assert.equal(loads, 0, "shell construction must remain lazy");
  const first = shell.readPortalTaskAttempts("chat-id", payload.requestId, "original-reply");
  const missing = shell.readPortalTaskAttempts("chat-id", payload.requestId, "unknown");
  assert.equal(typeof first.then, "function", "public wrapper must return a Promise");
  assert.equal(loads, 1);
  release();
  assert.equal(await first, payload);
  assert.equal(await missing, undefined);
  assert.deepEqual(calls, [
    ["chat-id", payload.requestId, "original-reply"],
    ["chat-id", payload.requestId, "unknown"],
  ]);
});
