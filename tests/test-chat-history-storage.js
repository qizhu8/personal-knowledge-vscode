const assert = require("node:assert/strict");
const { test } = require("node:test");
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const { randomUUID } = require("node:crypto");
const { ApiChatStore, apiChatSessionDiagnostics, apiChatContextSummary, apiChatDiagnostics, chatHistoryPage } = require("../dist/chat/api-chat-store");
const { ChatHistoryStorage } = require("../dist/chat/chat-history-storage");
const { createAgentSnapshot, readAgentSnapshotContents } = require("../dist/agent-sessions/agent-snapshots");
const { prepareWorkGoal, rootWorkCriterion } = require("../dist/chat/chat-work-goal");

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pkm-history-test-"));
  const directory = path.join(root, ".pkm", "state");
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const store = new ApiChatStore(directory, "0123456789abcdef");
  const chat = store.create();
  return { root, directory, store, chat, file: path.join(directory, "api-chats", store.namespace, `${chat.id}.json`) };
}
function message(content, extra = {}) {
  return { id: randomUUID(), role: "assistant", content, status: "complete", ...extra };
}

test("host recovery disarms persisted root work and preserves uncertain effects without replay", t => {
  const { store, chat, directory } = fixture(t);
  const input = message("Please fix this broken fixture.", { role:"user" });
  chat.includeHistory = true;
  chat.messages = [input];
  prepareWorkGoal(chat, input.id, input.content, "a".repeat(64));
  const root = structuredClone(chat.workGoal);
  chat.messages.push(message("", { inputId:input.id, status:"streaming",
    toolCalls:[{ id:"unknown-effect", name:"run_process", arguments:"{}", status:"running" }] }));
  store.save(chat);
  const reader = new ApiChatStore(directory, store.namespace);
  assert.equal(reader.load(chat.id, false).workGoal.status, "active", "observation must not claim a running host died");
  const recovered = reader.load(chat.id, true);
  assert.equal(recovered.workGoal.status, "interrupted");
  assert.equal(recovered.workGoal.id, root.id);
  assert.equal(recovered.workGoal.objective, root.objective);
  assert.equal(recovered.messages.at(-1).toolCalls[0].status, "failed");
  assert.match(recovered.messages.at(-1).toolCalls[0].result, /may already have occurred/);
  prepareWorkGoal(recovered, randomUUID(), "Here is another log.", "a".repeat(64));
  assert.equal(recovered.workGoal.status, "interrupted");
  prepareWorkGoal(recovered, randomUUID(), "Continue", "a".repeat(64));
  assert.equal(recovered.workGoal.status, "active");
  assert.equal(recovered.messages.at(-1).toolCalls.length, 1);
  store.save(recovered);
  assert.equal(reader.load(chat.id, false).workGoal.id, root.id);
});

test("stored goal claims reject missing root acceptance and unverified resolution", t => {
  const { store, chat, directory } = fixture(t);
  const input = message("Please fix this fixture.", { role:"user" });
  chat.messages = [input];
  prepareWorkGoal(chat, input.id, input.content, "a".repeat(64));
  const goal = structuredClone(chat.workGoal);
  for (const acceptance of [[], [{ criterion:"Only a log was read", verified:true, evidenceCallIds:["probe"] }],
    [{ criterion:rootWorkCriterion, verified:false, evidenceCallIds:[] }],
    [{ criterion:rootWorkCriterion, verified:true, evidenceCallIds:[] }]]) {
    const broken = store.create();
    broken.messages = [input];
    broken.workGoal = { ...goal, status:"resolved", acceptance };
    store.save(broken);
    assert.throws(() => new ApiChatStore(directory, store.namespace).load(broken.id, false), /Unsupported chat history/);
  }
});

test("typed Activity boundaries survive storage and compact diagnostics while legacy steps remain readable", t => {
  const { store, chat, directory } = fixture(t);
  const progress = { attemptId:"activity-types", model:"fixture", status:"complete", startedAt:100, finishedAt:900, steps:[
    { label:"Memory: understanding the question", at:100, finishedAt:200, status:"complete", category:"llm", operation:"inference" },
    { label:"Counting input tokens", at:300, finishedAt:400, status:"complete", category:"llm", operation:"token-count" },
    { label:"Tool", at:500, finishedAt:600, status:"complete", category:"cmd", operation:"command" },
    { label:"Retrieval", at:600, finishedAt:700, status:"complete", category:"info", operation:"retrieval" },
    { label:"Legacy local display", at:800, status:"complete" },
  ] };
  chat.messages = [message("Fixture", { progress })];
  store.save(chat);
  const restored = new ApiChatStore(directory, store.namespace).load(chat.id, false);
  assert.deepEqual(restored.messages[0].progress.steps, progress.steps);
  const compact = apiChatDiagnostics(restored).attempts[0].progress.steps;
  assert.deepEqual(compact.map(step => [step.category, step.operation, step.finishedAt]),
    progress.steps.map(step => [step.category, step.operation, step.finishedAt]));
  for (const invalid of [{ category:"charged" }, { operation:"unknown" }, { finishedAt:99 }]) {
    const broken = store.create();
    broken.messages = [message("Fixture", { progress:{ ...progress, steps:[{ ...progress.steps[0], ...invalid }] } })];
    store.save(broken);
    assert.throws(() => new ApiChatStore(directory, store.namespace).load(broken.id, false));
  }
});

test("default context diagnostics stay compact and hash-free without altering full local receipts", () => {
  const hash = "abcdef0123456789".repeat(4);
  const receipt = { schema:"pkm.chat.context-plan/v1", inputBudget:456800, estimatedBefore:385406, estimatedAfter:7900,
    refinements:8, stopReason:"selected-subset", omittedIds:Array(100).fill(hash), unresolved:Array(100).fill(hash),
    toolSchemaHash:hash, manifest:Array.from({ length:128 }, () => ({ role:"system", hash, referenceIds:[hash], callIds:[] })),
    automaticKnowledge:{ inputBudget:8000, estimatedBefore:380000, estimatedAfter:7900, countingMethod:"utf8-byte-upper-bound" } };
  const reply = message("Private response", { budgetReceipts:Array.from({ length:30 }, (_, round) => ({
    round, status:"sent", countingMethod:"utf8-byte-estimate", consumed:{ estimatedInputTokens:7900 },
    contextPlan:receipt, selectedReferenceIds:Array(100).fill(hash),
    transport:{ inputTokens:2200, countingMethod:"vscode-countTokens-plus-overhead", messageHashes:Array(128).fill(hash) },
  })), retrieval:{ selectedCount:100, warning:"Private source path",
    candidates:Array.from({ length:100 }, () => ({ selected:true, kind:"script", label:hash, sourceRevision:hash, contentHash:hash })) },
    progress:{ status:"complete", steps:Array.from({ length:600 }, (_, at) => ({ at, label:"Preparing context", status:"complete" })) } });
  const summary = apiChatContextSummary(reply);
  assert.equal(summary.roundCount, 30);
  assert.equal(summary.rounds.length, 5);
  assert.equal(summary.omittedRounds, 25);
  assert.equal(summary.retrieval.selectedKinds.script, 100);
  assert.equal(summary.rounds[0].omittedReferenceCount, 100);
  assert(!JSON.stringify(summary).includes(hash));
  assert(!JSON.stringify(summary).includes("Private source path"));
  assert(Buffer.byteLength(JSON.stringify(summary)) < 3000);
  const diagnostics = apiChatDiagnostics({ id:"fixture", messages:Array(30).fill(reply) });
  assert.equal(diagnostics.attempts.length, 5);
  assert.equal(diagnostics.omittedAttempts, 25);
  assert.equal(diagnostics.attempts[0].progress.steps.length, 12);
  assert.equal(diagnostics.attempts[0].progress.omittedSteps, 588);
  assert(!JSON.stringify(diagnostics).includes(hash));
  assert(Buffer.byteLength(JSON.stringify(diagnostics)) < 25000);
  assert.equal(reply.budgetReceipts[0].contextPlan.manifest.length, 128);
  assert.equal(reply.budgetReceipts[0].contextPlan.manifest[0].hash, hash);
  assert.equal(reply.budgetReceipts.length, 30, "compaction must never rewrite stored evidence");
});

test("read-only diagnostic CLI accepts a Chat URL and returns counts without dumping stored evidence", t => {
  const { root, store, chat, file } = fixture(t);
  chat.messages = [message("Private user content", { role:"user" }), message("Private assistant content")];
  store.save(chat);
  const before = fs.readFileSync(file);
  const command = require("node:child_process").spawnSync(process.execPath, [
    path.join(__dirname, "../scripts/export-chat-diagnostics.js"), root, `pkm://chats/${store.namespace}/${chat.id}`,
  ], { encoding:"utf8" });
  assert.equal(command.status, 0, command.stderr);
  const diagnostics = JSON.parse(command.stdout);
  assert.equal(diagnostics.chatId, chat.id);
  assert.equal(diagnostics.attempts[0].context.roundCount, 0);
  assert(!command.stdout.includes("Private user content") && !command.stdout.includes("Private assistant content"));
  assert(fs.readFileSync(file).equals(before), "diagnostic reads must not recover or rewrite a Chat");
});

test("unchanged selected Chat refresh reuses validated history and detects another window's save", t => {
  const { directory, store, chat } = fixture(t);
  chat.messages = [message("x".repeat(2_000_000))];
  store.save(chat);
  const selected = store.load(chat.id, false);
  const original = fs.readFileSync;
  let segments = 0;
  fs.readFileSync = function (file, ...args) {
    if (String(file).endsWith(".bin")) segments++;
    return original.call(this, file, ...args);
  };
  try {
    assert.equal(store.reloadIfChanged(selected), selected);
    assert.equal(store.reloadIfChanged(selected), selected);
    assert.equal(segments, 0, "publishing unchanged state must not unpack and hash history again");
    const other = new ApiChatStore(directory, store.namespace);
    const updated = other.load(chat.id, false);
    updated.title = "Updated in another window";
    other.save(updated);
    const refreshed = store.reloadIfChanged(selected);
    assert.notEqual(refreshed, selected);
    assert.equal(refreshed.title, updated.title);
    assert(refreshed.revision > selected.revision);
    assert.equal(store.reloadIfChanged(refreshed), refreshed);
  } finally { fs.readFileSync = original; }
});

test("large legacy Chat migrates on save without a cumulative limit or lost evidence", t => {
  const { directory, store, chat, file } = fixture(t);
  chat.messages = Array.from({ length: 80 }, (_, index) => message(`Message ${index}`, {
    toolCalls: [{ id: randomUUID(), name: "recorded-tool", arguments: '{"fixture":true}', status: "complete", result: `${index}:` + "\u4e2d".repeat(24_000) }],
  }));
  fs.writeFileSync(file, JSON.stringify(chat));
  assert(fs.statSync(file).size > 5_000_000);
  const legacy = store.load(chat.id, false);
  assert.deepEqual(legacy.messages, chat.messages);
  store.save(legacy);
  const packed = JSON.parse(fs.readFileSync(file, "utf8"));
  assert.equal(packed.version, 2, "Older builds must reject this record rather than overwrite its external history");
  assert.equal(packed.messageHistory.messageCount, 80);
  assert.equal(packed.messages.length, 0);
  assert(fs.statSync(file).size < 30_000);
  assert.deepEqual(store.load(chat.id, false).messages, chat.messages);
  const files = fs.readdirSync(path.join(directory, "api-chat-history", chat.id));
  const before = files.map(name => ({ name, mtime: fs.statSync(path.join(directory, "api-chat-history", chat.id, name)).mtimeMs }));
  store.save(legacy);
  assert.deepEqual(files.map(name => ({ name, mtime: fs.statSync(path.join(directory, "api-chat-history", chat.id, name)).mtimeMs })), before);
  const stale = store.load(chat.id, false);
  legacy.messages.push(message("Continuation, no new Chat required"));
  store.save(legacy);
  assert.throws(() => store.save(stale), /changed in another window/);
  assert.equal(store.load(chat.id, false).messages.length, 81);
  assert.equal(store.list()[0].status, "completed");
});

test("a single large Unicode message spans bounded segments and round-trips exactly", t => {
  const { directory, store, chat } = fixture(t);
  chat.messages = [message("\u{1f680}".repeat(1_400_000))];
  store.save(chat);
  assert.deepEqual(store.load(chat.id, false).messages, chat.messages);
  for (const name of fs.readdirSync(path.join(directory, "api-chat-history", chat.id))) {
    assert(fs.statSync(path.join(directory, "api-chat-history", chat.id, name)).size <= 1024 * 1024);
  }
});

test("history pages load older evidence by identity without changing model context or stored history", t => {
  const { directory, store, chat, file } = fixture(t);
  chat.messages = Array.from({ length: 151 }, (_, index) => message(`${index}:` + "x".repeat(6000)));
  store.save(chat);
  const original = fs.readFileSync(file);
  const tail = chatHistoryPage(chat);
  assert.equal(tail.messages.length, 20); assert.equal(tail.start, 131); assert.equal(tail.total, 151);
  let page = tail; const recovered = [...tail.messages];
  while (page.start) {
    page = chatHistoryPage(chat, page.messages[0].id);
    assert(page.messages.length <= 20);
    recovered.unshift(...page.messages);
  }
  assert.deepEqual(recovered, chat.messages);
  const storage = new ChatHistoryStorage(directory);
  const packed = JSON.parse(original);
  assert.deepEqual(storage.messages(packed, 64, 84), chat.messages.slice(64, 84));
  assert(fs.readFileSync(file).equals(original));
  assert.throws(() => chatHistoryPage(chat, "stale-id"), /cursor is stale/);
});

test("segment corruption or missing segments is explicit and never returns shortened history", t => {
  const { directory, store, chat, file } = fixture(t);
  chat.messages = [message("x".repeat(1_100_000))]; store.save(chat);
  const packed = JSON.parse(fs.readFileSync(file, "utf8"));
  const index = path.join(directory, "api-chat-history", chat.id, `${packed.messageHistory.pages[0].digest}.bin`);
  const saved = fs.readFileSync(index);
  fs.writeFileSync(index, "tampered");
  assert.throws(() => store.load(chat.id, false), /integrity/);
  fs.writeFileSync(index, saved); fs.unlinkSync(index);
  assert.throws(() => store.load(chat.id, false), /ENOENT/);
});

test("failed segment writes preserve the previous committed revision", t => {
  const { store, chat, file } = fixture(t);
  const prior = fs.readFileSync(file);
  chat.messages = [message("x".repeat(800_000))];
  const rename = fs.renameSync;
  try {
    fs.renameSync = (from, to) => { if (to.endsWith(".bin")) throw new Error("fixture segment write failure"); return rename(from, to); };
    assert.throws(() => store.save(chat), /fixture segment write failure/);
  } finally { fs.renameSync = rename; }
  assert(fs.readFileSync(file).equals(prior));
  assert.equal(store.load(chat.id, false).messages.length, 0);
});

test("Task mirrors share segments and diagnostics resolve their exact snapshot after Chat changes", t => {
  const { root, directory, store, chat } = fixture(t);
  store.startTask(chat, "Large Task");
  chat.messages = [message("x".repeat(5_100_000), { error: "Local fixture failure", status: "failed" })];
  store.save(chat);
  const file = path.join(directory, "agent-sessions", `${chat.sessionId}.json`);
  const session = JSON.parse(fs.readFileSync(file, "utf8"));
  assert(fs.statSync(file).size < 30_000);
  assert(session.nativeChat.messageHistory);
  assert.throws(() => apiChatSessionDiagnostics(session, chat.sessionId), /owning state directory/);
  assert.equal(apiChatSessionDiagnostics(session, chat.sessionId, directory).attempts[0].outputCharacters, 5_100_000);
  const snapshot = createAgentSnapshot(root, chat.sessionId);
  const contents = readAgentSnapshotContents(root, snapshot.snapshot.snapshotId);
  assert.deepEqual(contents.session.nativeChat.messages, chat.messages);
  assert.equal(contents.session.nativeChat.messageHistory, undefined, "Snapshots must be self-contained rather than depending on mutable external storage");
  store.completeTask(chat);
  chat.messages.push(message("Next task evidence")); store.save(chat);
  const old = new ChatHistoryStorage(directory).unpack(session.nativeChat);
  assert.equal(old.messages.length, 1);
  assert.equal(old.messages[0].content.length, 5_100_000);
});

test("worker archives above 6 MB retain exact evidence after temporary Chat removal", t => {
  const { store, chat } = fixture(t);
  const receiptId = randomUUID();
  chat.messages = [message("x".repeat(6_100_000))];
  chat.workerActivity = { id: randomUUID(), managerChatId: randomUUID(), treeId: randomUUID(), receiptId, temporary: true, state: "completed" };
  store.save(chat);
  const record = { id: receiptId };
  store.archiveWorker(chat, record);
  assert.deepEqual(store.workerResult(receiptId).chat.messages, chat.messages);
  assert.throws(() => store.load(chat.id, false), /ENOENT/);
});

test("permanent deletion reclaims unowned segments but keeps completed Task evidence", t => {
  const { directory, store, chat } = fixture(t);
  chat.messages = [message("x".repeat(600_000))]; store.save(chat);
  store.trashChat(chat.id); store.deleteChat(chat.id);
  assert(!fs.existsSync(path.join(directory, "api-chat-history", chat.id)));
  const tasked = store.create(); store.startTask(tasked, "Retained Task");
  tasked.messages = [message("y".repeat(600_000))]; store.save(tasked);
  const sessionId = tasked.sessionId;
  store.completeTask(tasked); store.trashChat(tasked.id); store.deleteChat(tasked.id);
  const session = JSON.parse(fs.readFileSync(path.join(directory, "agent-sessions", `${sessionId}.json`)));
  assert.equal(apiChatSessionDiagnostics(session, sessionId, directory).attempts[0].outputCharacters, 600_000);
});

test("controller publishes only a recent page and rejects cross-Chat or stale history requests", async t => {
  const { store, chat } = fixture(t);
  chat.messages = Array.from({ length: 151 }, (_, index) => message(`${index}:` + "x".repeat(40_000)));
  store.save(chat);
  const Module = require("node:module");
  const load = Module._load;
  let ApiChatView;
  try {
    Module._load = function(name, ...args) { return name === "vscode" ? { env: { language: "en" }, workspace: { getConfiguration: () => ({ get: (_key, fallback) => fallback }) } } : load.call(this, name, ...args); };
    ({ ApiChatView } = require("../dist/chat/api-chat-view"));
  } finally { Module._load = load; }
  const posts = [];
  const provider = new ApiChatView({ extensionPath: path.resolve(__dirname, ".."), workspaceState: { update: async () => {} } });
  provider.store = store; provider.chat = chat; provider.chats.set(chat.id, chat);
  provider.view = { webview: { postMessage: post => { posts.push(post); return Promise.resolve(true); } } };
  provider.initialize = () => {};
  provider.dispatchOwnedInputs = () => {};
  provider.dispatchWorkerEvents = () => {};
  provider.settings = () => ({});
  provider.toolGroups = () => [{ tools: [] }];
  provider.requestMessages = () => [];
  provider.workerOverview = () => ({ nodes: [] });
  provider.publish();
  const state = posts.at(-1);
  assert.equal(state.type, "state");
  assert(state.chat.messages.length <= 20);
  assert.equal(state.history.total, 151);
  assert(state.history.start > 0);
  assert.equal(chat.messages.length, 151);
  const read = fs.readFileSync;
  let repeatedSegmentReads = 0;
  fs.readFileSync = function (file, ...args) {
    if (String(file).endsWith(".bin")) repeatedSegmentReads++;
    return read.call(this, file, ...args);
  };
  try { provider.publish(); provider.publish(); }
  finally { fs.readFileSync = read; }
  assert.equal(repeatedSegmentReads, 0, "actual publish and abandoned-owner check must not unpack unchanged idle history");
  const before = state.chat.messages[0].id;
  await provider.handle({ type: "historyPage", chatId: chat.id, id: before });
  const older = posts.at(-1);
  assert.equal(older.type, "historyPage");
  assert.equal(older.beforeId, before);
  assert.deepEqual(older.messages, chat.messages.slice(older.start, state.history.start));
  await assert.rejects(provider.handle({ type: "historyPage", chatId: randomUUID(), id: before }), /selected Chat changed/);
  await assert.rejects(provider.handle({ type: "historyPage", chatId: chat.id, id: randomUUID() }), /cursor is stale/);
  assert.equal(store.load(chat.id, false).revision, chat.revision, "Browsing history must not persist or dispatch an inference");
});

test("image safety remains per message rather than imposing a cumulative history cutoff", t => {
  const { store, chat } = fixture(t);
  const image = { label: "fixture.png", mimeType: "image/png", dataBase64: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a5wAAAABJRU5ErkJggg==" };
  const count = Math.floor(2 * 1024 * 1024 / Buffer.from(image.dataBase64, "base64").length) + 1;
  chat.messages = Array.from({ length: count }, () => message("Historic image", { images: [image] }));
  assert.doesNotThrow(() => store.validateImages(chat));
  assert.throws(() => store.validateImages({ ...chat, messages: [message("Invalid image count", { images: [image, image, image] })] }), /At most two/);
  assert.throws(() => store.validateImages({ ...chat, messages: [message("Invalid image size", { images: [{ ...image, dataBase64: Buffer.alloc(512 * 1024 + 1).toString("base64") }] })] }), /512 KB/);
});

test("Chat listing reuses unchanged files and still reflects renames and deletes", t => {
  const { directory, store, chat } = fixture(t);
  chat.title = "First"; store.save(chat);
  const other = store.create(); other.title = "Other"; store.save(other);
  assert.deepEqual(store.list().map(item => item.title).sort(), ["First", "Other"]);
  const read = fs.readFileSync, reads = [];
  fs.readFileSync = function (file, ...args) { reads.push(String(file)); return read.call(this, file, ...args); };
  try {
    store.list(); store.list(true);
    assert.deepEqual(reads.filter(file => /api-chats.*\.json$/.test(file) && !file.endsWith("library.json")), [], "unchanged Chat files are not re-read");
  } finally { fs.readFileSync = read; }
  const renamed = store.load(chat.id, false); renamed.title = "Renamed with a much longer title"; store.save(renamed);
  assert(store.list().some(item => item.id === chat.id && item.title === "Renamed with a much longer title"));
  fs.rmSync(path.join(directory, "api-chats", store.namespace, `${other.id}.json`));
  assert.deepEqual(store.list().map(item => item.id), [chat.id]);
});
