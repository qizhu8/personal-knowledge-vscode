const assert = require("node:assert/strict");
const { test } = require("node:test");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const http = require("node:http");
const { createHash } = require("node:crypto");
const Module = require("node:module");
const fixtures = require("./fixtures/chat-context");

const originalLoad = Module._load;
const host = {
  commands: {},
  env: { language: "en" },
  window: { showInformationMessage: async () => undefined, showWarningMessage: async () => undefined, showErrorMessage: async () => undefined },
  workspace: { isTrusted: true, workspaceFolders: [], getConfiguration: () => ({ get: (_key, fallback) => fallback }) },
  lm: { tools: [] },
  Uri:undefined,
  CancellationTokenSource:undefined, LanguageModelChatMessage:undefined,
  LanguageModelTextPart:undefined, LanguageModelToolCallPart:undefined, LanguageModelToolResultPart:undefined,
  LanguageModelDataPart:undefined, ConfigurationTarget:undefined,
  QuickPickItemKind:{ Separator:-1 },
};
let ApiChatView;
try {
  Module._load = function(name, ...args) {
    return name === "vscode" ? host : originalLoad.call(this, name, ...args);
  };
  ({ ApiChatView } = require("../dist/chat/api-chat-view"));
} finally {
  Module._load = originalLoad;
}
const { ApiChatStore } = require("../dist/chat/api-chat-store");
const { captureExecutionContext } = require("../dist/chat/execution-context");
const { chatMemorySegments, retrieveChatMemory, recentChatDialogue } = require("../dist/chat/chat-memory");
const { chatRetrievalReceipt } = require("../dist/chat/chat-retrieval");
const { estimateInputTokens, validateBudget } = require("../dist/chat/api-chat-models");
const { fitChatContext } = require("../dist/chat/chat-context");
const { rootWorkCriterion, workGoalInputs } = require("../dist/chat/chat-work-goal");

function workOutcome(chat, status, reason, evidenceCallIds = [], extra = {}) {
  return { status, reason, sourceInputIds:workGoalInputs(chat),
    acceptance:[{ criterion:rootWorkCriterion, verified:status === "resolved", evidenceCallIds }], ...extra };
}

const profile = {
  id: "synthetic-context-model", model: "synthetic-context-model", label: "Synthetic context model",
  status: "active", contextWindow: 262144, maxOutputTokens: 4096,
  currency: "USD", includeUsage: false, outputTokenParameter: "max_tokens",
};

function requestMessages(chat, query) {
  return ApiChatView.prototype.requestMessages.call({
    store: { namespace: fixtures.namespace }, toolGroups: () => [{ tools: [] }],
  }, chat, query);
}

function text(messages) {
  return messages.map(item => item.content).join("\n");
}

test("user-approved checkpoints bound 4/16/64/256 Task inputs without deleting originals or losing newer prohibitions", () => {
  const { createTaskContextCheckpoint, activeTaskContextCheckpoint, readTaskContextInput } = require("../dist/chat/task-context-checkpoint");
  const { workGoalInputs, workGoalContext } = require("../dist/chat/chat-work-goal");
  const taskId = "agent_session_" + "a".repeat(32);
  const measurements = [];
  for (const count of [4, 16, 64, 256]) {
    const chat = fixtures.conversation({ sessionId:taskId, messages:Array.from({length:count}, (_, index) =>
      fixtures.message("user", `Original requirement ${index}: ` + "Do not deploy. Preserve exact constraints. ".repeat(75), {taskId})) });
    const originals = JSON.stringify(chat.messages);
    const before = estimateInputTokens(requestMessages(chat, "Continue"));
    chat.workGoal = { id:chat.id, inputId:chat.messages[0].id, attemptInputId:chat.messages[count-1].id,
      objective:chat.messages[0].content, executionDigest:"a".repeat(64), status:"active",
      acceptance:[{criterion:rootWorkCriterion,verified:false,evidenceCallIds:[]}] };
    const summary = "Implement the verified repair. Do not deploy, restart services, or change credentials. Preserve exact evidence and all acceptance criteria.";
    chat.taskContextCheckpoints = [createTaskContextCheckpoint(chat, summary)];
    assert.equal(JSON.stringify(chat.messages), originals);
    const newer = fixtures.message("user", "NEW REQUIREMENT: do not change any Python files.", {taskId});
    chat.messages.push(newer);
    const messages = requestMessages(chat, "Continue");
    fitChatContext(messages, new Map(), 8192, []);
    const after = estimateInputTokens(messages);
    assert(after < 5000, `checkpoint input must fit under 5000 conservative units, got ${after}`);
    assert(after < before / 2);
    assert(text(messages).includes(summary) && text(messages).includes(newer.content));
    assert(!text(messages).includes("Original requirement 0:"));
    assert.equal(messages.filter(message => message.content.startsWith("Original current-task instruction")).length, 1);
    assert.deepEqual(workGoalInputs(chat), [chat.messages[count-1].id, newer.id]);
    assert(workGoalContext(chat).includes(summary));
    assert(!workGoalContext(chat).includes("Original requirement 0:"));
    const source = JSON.parse(readTaskContextInput(chat, chat.messages[0].id));
    assert.equal(source.content, chat.messages[0].content);
    assert.equal(JSON.parse(readTaskContextInput(chat, source.inputId, 0, 20, source.contentHash)).content, chat.messages[0].content.slice(0,20));
    assert.throws(() => readTaskContextInput(chat, source.inputId, 0, 20, "b".repeat(64)), /inputHash/);
    assert.throws(() => readTaskContextInput(chat, newer.id, 0, 5000, source.contentHash), /range/);
    assert.throws(() => ApiChatView.prototype.requestMessages.call({store:{namespace:fixtures.namespace},toolGroups:()=>[]},
      chat, "Retry", new Map(), chat, chat.messages[0].id), /retry predates/);
    measurements.push({count,before,after});
    chat.messages[0].content += " changed";
    assert.throws(() => activeTaskContextCheckpoint(chat), /changed or are missing/);
    chat.taskContextCheckpoints[0].revokedAt = new Date().toISOString();
    assert.equal(activeTaskContextCheckpoint(chat), undefined);
    assert(text(requestMessages(chat, "Continue")).includes("Original requirement 0:"));
    chat.includeHistory = false;
    assert.throws(() => readTaskContextInput(chat, source.inputId), /History is off/);
  }
  assert(Math.max(...measurements.map(item=>item.after)) - Math.min(...measurements.map(item=>item.after)) < 100,
    "approved prefix length must not cause prompt growth");
  console.log("Task checkpoint measured conservative input units:", JSON.stringify(measurements));
});

test("Task checkpoint review persists approvals and exact readback; History off and other Tasks cannot reuse them", () => {
  const { createTaskContextCheckpoint, activeTaskContextCheckpoint, readTaskContextInput } = require("../dist/chat/task-context-checkpoint");
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "pkm-checkpoint-store-"));
  try {
    const store = new ApiChatStore(directory, fixtures.namespace);
    const chat = store.create(); chat.sessionId = "agent_session_" + "c".repeat(32);
    chat.messages.push(fixtures.message("user", "Read-only. Never deploy.\n" + "x".repeat(5000), {taskId:chat.sessionId}));
    chat.messages.push(...Array.from({length:255},(_,index)=>fixtures.message("user",`Additional input ${index}: `+"keep evidence ".repeat(150),{taskId:chat.sessionId})));
    chat.taskContextCheckpoints = [createTaskContextCheckpoint(chat, "Read-only. Never deploy.")]; store.save(chat);
    const loaded = new ApiChatStore(directory, fixtures.namespace).load(chat.id, false);
    assert.deepEqual(loaded.taskContextCheckpoints, chat.taskContextCheckpoints);
    assert.deepEqual(loaded.messages.map(message=>[message.id,message.content]),chat.messages.map(message=>[message.id,message.content]));
    assert.equal(activeTaskContextCheckpoint(loaded).sourceInputIds.length,256);
    loaded.taskContextCheckpoints.push({...createTaskContextCheckpoint(loaded,"Still read-only."),revokedAt:new Date().toISOString()});
    assert.equal(activeTaskContextCheckpoint(loaded),undefined,"revoking the latest approval must not revive an older one");
    const preview = JSON.parse(readTaskContextInput(loaded, chat.messages[0].id));
    assert.equal(preview.truncated, true);
    assert.equal(JSON.parse(readTaskContextInput(loaded, preview.inputId, 3990, 4020, preview.contentHash)).content,
      chat.messages[0].content.slice(3990,4020));
    loaded.includeHistory = false; assert.equal(activeTaskContextCheckpoint(loaded), undefined);
    loaded.includeHistory = true; loaded.sessionId = "agent_session_" + "d".repeat(32);
    assert.equal(activeTaskContextCheckpoint(loaded), undefined);
    assert.throws(() => readTaskContextInput(loaded, preview.inputId), /not in the current Task/);
  } finally { fs.rmSync(directory,{recursive:true,force:true}); }
});

test("Task knowledge stewardship distinguishes abstraction, retrieval-first reuse and permission without changing casual or tool-free Chats", () => {
  const { CHAT_ASSET_CURATION_GUIDANCE } = require("../dist/chat/knowledge-reader");
  const chat = fixtures.conversation({ sessionId:"session-curation" });
  const render = (tools, value = chat) => ApiChatView.prototype.requestMessages.call({
    store:{ namespace:fixtures.namespace, save() { assert.fail("Preparing a request must not save assets"); } },
    toolGroups:() => [{ tools }],
  }, value, "Finish the verified task");
  assert(text(render([{ enabled:true }])).includes(CHAT_ASSET_CURATION_GUIDANCE));
  assert.match(CHAT_ASSET_CURATION_GUIDANCE, /search existing knowledge/);
  assert.match(CHAT_ASSET_CURATION_GUIDANCE, /not a compulsory promotion ladder/);
  assert.match(CHAT_ASSET_CURATION_GUIDANCE, /without user authorization/);
  assert(!text(render([])).includes(CHAT_ASSET_CURATION_GUIDANCE));
  assert(!text(render([{ enabled:true }], fixtures.conversation())).includes(CHAT_ASSET_CURATION_GUIDANCE));
});

test("advertised fixture E2E control reaches the real runner and rejects overrides without model dispatch", async () => {
  const { API_CHAT_CONTROL_OPERATIONS } = require("../dist/chat/agent-control");
  assert(API_CHAT_CONTROL_OPERATIONS.includes("fixture-e2e"));
  let calls = 0;
  const target = { disposed:false, runAcceptance:async () => { calls++; return { status:"fixture-result" }; } };
  assert.deepEqual(await ApiChatView.prototype.agentControl.call(target, "fixture-e2e", {}), { status:"fixture-result" });
  assert.equal(calls, 1);
  await assert.rejects(ApiChatView.prototype.agentControl.call(target, "fixture-e2e", { approve:true }), /no overrides/);
  assert.equal(calls, 1);
  target.runAcceptance = async () => undefined;
  assert.deepEqual(await ApiChatView.prototype.agentControl.call(target, "fixture-e2e", {}), { status:"cancelled" });
});

test("inline Visualization reads exact current-Chat evidence without starting a Task or calling a model", async () => {
  const chat = fixtures.conversation({ messages: [
    { id:"user", role:"user", content:"Inspect the fixture", status:"complete" },
    { id:"reply", role:"assistant", content:"Checking the evidence.", status:"streaming",
      toolCalls:[{ id:"call", name:"search_text", arguments:'{"query":"fixture"}', result:"x".repeat(2100), status:"complete" }] },
  ] });
  delete chat.sessionId;
  let checked = 0;
  const target = { store:{ assertAvailable(value) { assert.equal(value, chat); checked++; } } };
  const read = (method, params = {}) => ApiChatView.prototype.visualizationRequest.call(target, chat, method, params);
  const before = JSON.stringify(chat);
  const snapshot = await read("snapshot");
  assert.equal(snapshot.sessionId, chat.id);
  assert.deepEqual(snapshot.runs, []);
  assert.match(snapshot.harnessWarnings[0], /Chat-only/);
  assert.equal(snapshot.harness.attempts[0].toolCalls[0].name, "search_text");
  assert.equal(snapshot.harness.attempts[0].toolCalls[0].resultPreview.length, 2000);
  assert.equal(await read("result", { messageId:"reply", callId:"call" }), "x".repeat(2100));
  await assert.rejects(read("result", { messageId:"foreign", callId:"call" }), /unavailable/);
  await assert.rejects(read("run"), /read-only/);
  assert.equal(JSON.stringify(chat), before);
  assert.equal(checked, 4);
  host.workspace.isTrusted = false;
  try { await assert.rejects(read("snapshot"), /Trust/); }
  finally { host.workspace.isTrusted = true; }
});

test("Visualization bridge rejects stale Chat requests and returns errors to the correlated requester", async () => {
  const messages = [];
  let reads = 0;
  const target = { disposed:false, initialize() {}, chat:{ id:"current" },
    view:{ webview:{ postMessage:message => messages.push(message) } },
    visualizationRequest:async () => { reads++; return { fixture:true }; } };
  const request = { type:"visualizationRequest", requestId:"request", chatId:"old", method:"snapshot" };
  await ApiChatView.prototype.handle.call(target, request);
  assert.equal(reads, 0);
  assert.equal(messages[0].chatId, "old");
  assert.match(messages[0].error, /selected Chat changed/);
  await ApiChatView.prototype.handle.call(target, { ...request, chatId:"current" });
  assert.equal(reads, 1);
  assert.deepEqual(messages[1].data, { fixture:true });
});

test("Memory observation is scoped, revision checked and does not create an absent database", async t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "pkm-memory-observe-controller-"));
  t.after(() => fs.rmSync(directory, { recursive:true, force:true }));
  const { messageRevision } = require("../dist/memory/chat-memory-service");
  const content = "Original evidence";
  const chat = fixtures.conversation({ messages:[{ id:"original", role:"user", content, status:"complete" }] });
  const calls = [];
  const target = { store:{ assertAvailable() {} },
    memoryDatabasePath:() => path.join(directory, "absent.sqlite3"),
    memoryScope:() => "authorized/chat",
    chatMemory:() => ({ inspect:async (...args) => { calls.push(args); return { pieces:[] }; } }),
  };
  const read = (method, params = {}) => ApiChatView.prototype.visualizationRequest.call(target, chat, method, params);
  await assert.rejects(read("memoryOverview"), /did not create/);
  assert.equal(fs.existsSync(target.memoryDatabasePath()), false);
  assert.equal(calls.length, 0);
  fs.writeFileSync(target.memoryDatabasePath(), "");
  await read("memoryOverview", { scope:"foreign/chat" });
  assert.deepEqual(calls[0], ["authorized/chat", undefined, 0], "caller cannot replace the owning scope");
  await assert.rejects(read("memoryPiece", { piece:"piece", after:-1 }), /cursor/);
  const revision = messageRevision(content);
  assert.equal((await read("memorySource", { messageId:"original", revision })).content, content);
  await assert.rejects(read("memorySource", { messageId:"foreign", revision }), /unavailable/);
  chat.messages[0].content = "Edited evidence";
  await assert.rejects(read("memorySource", { messageId:"original", revision }), /changed/);
});

test("managed Visualization uses the authoritative reader and cannot override the owning Session", async t => {
  const previous = host.commands.executeCommand;
  t.after(() => { host.commands.executeCommand = previous; });
  const chat = fixtures.conversation({ sessionId:`agent_session_${"a".repeat(32)}` });
  host.commands.executeCommand = async (name, method, params) => {
    assert.equal(name, "personalKnowledge.readNativeHarness");
    assert.equal(method, "snapshot");
    assert.equal(params.sessionId, chat.sessionId);
    return { authoritative:true };
  };
  const target = { store:{ assertAvailable() {} } };
  assert.deepEqual(await ApiChatView.prototype.visualizationRequest.call(target, chat, "snapshot", {
    sessionId:"foreign",
  }), { authoritative:true, memoryReceiptReader:true, memoryStoreReader:true, profileReader:true });
});

test("Visualization window reads any non-Trash Chat by id: live records while running, stored records otherwise", async () => {
  const live = { id:"11111111-1111-4111-8111-111111111111", title:"Live title", messages:[{ id:"r", role:"assistant", delegations:[{}] }] };
  const stored = { id:"22222222-2222-4222-8222-222222222222", title:"Stored" };
  const loads = [], reads = [];
  const store = {
    list:() => [{ id:live.id, title:"Old title", status:"completed", groupId:"g", updatedAt:"2" },
      { id:stored.id, title:"Stored", status:"failed", groupId:"missing", updatedAt:"1", workerParentChatId:live.id, workerTreeId:"t" }],
    library:{ read:() => ({ groups:[{ id:"g", name:"Group", order:0 }], placements:{} }) },
    load(id, create) { loads.push([id, create]); if (id === stored.id) return stored; throw new Error("ENOENT /private/path"); },
  };
  const target = { disposed:false, openStore:() => store, running:new Set([live.id]), chats:new Map([[live.id, live]]), awaitingInput:new Set(),
    visualizationRequest:async (chat, method, params) => { reads.push([chat, method, params]); return chat.id; } };
  const library = ApiChatView.prototype.visualizationLibrary.call(target);
  assert.deepEqual(library.groups, [{ id:"g", name:"Group" }], "only display fields cross into the window");
  assert.equal(library.chats[0].title, "Live title");
  assert.equal(library.chats[0].status, "running");
  assert.equal(library.chats[0].workerManager, true);
  assert.deepEqual([library.chats[1].status, library.chats[1].workerParentChatId], ["failed", live.id]);

  const read = id => ApiChatView.prototype.readVisualization.call(target, id, "snapshot", {});
  assert.equal(await read(live.id), live.id);
  assert.deepEqual(loads, [], "a running Chat is read from memory, not a stale disk copy");
  assert.equal(await read(stored.id), stored.id);
  assert.deepEqual(loads, [[stored.id, false]], "reading never creates a Chat");
  await assert.rejects(read("33333333-3333-4333-8333-333333333333"), error => /unavailable in the current Knowledge Root/.test(error.message) && !/private/.test(error.message));
  await assert.rejects(read("../../escape-attempt-0000000000000000"), /Choose a PKM Chat/);
  assert.equal(reads.length, 2, "every read goes through the shared trust/Trash/read-only gate");
  target.disposed = true;
  await assert.rejects(read(stored.id), /Host is closed/);
  assert.throws(() => ApiChatView.prototype.visualizationLibrary.call(target), /Host is closed/);
  const observed = { recordListeners:new Set() };
  let calls = 0;
  observed.recordListeners.add(() => { throw new Error("observer bug"); });
  observed.recordListeners.add(() => calls++);
  ApiChatView.prototype.notifyRecordChanges.call(observed);
  assert.equal(calls, 1, "one failing observer does not stop others or the save/publish path");
});

test("Visualization window navigation builds full pkm://chats locators and routes other PKM sources to Go to PKM Path", async t => {
  const previous = host.commands.executeCommand;
  const executed = [], opened = [];
  host.commands.executeCommand = async (...args) => { executed.push(args); };
  t.after(() => { host.commands.executeCommand = previous; });
  const chatId = "11111111-1111-4111-8111-111111111111", other = "22222222-2222-4222-8222-222222222222";
  const ns = "0123456789abcdef";
  const target = { disposed:false, openStore:() => ({ list:() => [{ id:chatId, workspaceNamespace:ns }, { id:other, workspaceNamespace:"fedcba9876543210" }] }),
    openPkmChat:async locator => { opened.push(locator); } };
  const go = (id, uri) => ApiChatView.prototype.openVisualizationTarget.call(target, id, uri);
  await go(chatId);
  assert.deepEqual(opened, [`pkm://chats/${ns}/${chatId}`], "a bare id is never passed to the Chat opener");
  await go(chatId, `pkm://chats/${other}/memory/reply%3Adialogue`);
  assert.equal(opened[1], `pkm://chats/fedcba9876543210/${other}`, "memory evidence opens its owning Chat");
  await go(chatId, `pkm://knowledge/knowledge_${"a".repeat(24)}`);
  assert.equal(executed.length, 1);
  assert.equal(executed[0][0], "personalKnowledge.goToPkmPath");
  assert.match(executed[0][1], /^pkm:\/\/knowledge\//);
  await assert.rejects(go(chatId, "https://example.com"), /no navigable PKM path/);
  await assert.rejects(go(chatId, `pkm://chats/${"3".repeat(8)}-3333-4333-8333-${"3".repeat(12)}/memory/x`), /unavailable .*Trash/);
  await assert.rejects(go("33333333-3333-4333-8333-333333333333"), /Trash/);
  await assert.rejects(go("../x"), /Choose a PKM Chat/);
  host.workspace.isTrusted = false;
  try { await assert.rejects(go(chatId), /Trust/); } finally { host.workspace.isTrusted = true; }
  target.disposed = true;
  await assert.rejects(go(chatId), /Host is closed/);
  assert.equal(opened.length, 2);
});

test("CTX-U01: the synthetic original tool history exceeds 100,000 characters", () => {
  const chat = fixtures.largeToolHistory();
  const originalHistory = chat.messages.slice(-20).map(item =>
    item.content + JSON.stringify(item.toolCalls || [])).join("\n");
  assert(originalHistory.length > 100000);
  assert(chat.messages.length > 20);
  assert.equal(chat.messages.at(-1).toolCalls.length, 17);
  assert(originalHistory.includes(fixtures.evidence.beta));
});

test("CTX-U02: input plus reserved output is accepted exactly at the budget boundary", () => {
  const messages = [{ role: "user", content: "x".repeat(500) }];
  const input = estimateInputTokens(messages);
  assert.equal(validateBudget(profile, input + 128, 128, messages), input);
  assert.throws(() => validateBudget(profile, input + 127, 128, messages), /budget exceeded/);
});

test("CTX-U03: Chinese, tool arguments and tool schemas contribute to the input budget", () => {
  const plain = [{ role: "user", content: "ab" }];
  const chinese = [{ role: "user", content: "\u4f60\u597d" }];
  assert.equal(estimateInputTokens(chinese) - estimateInputTokens(plain), 4);
  const calls = [{ role: "assistant", content: "", tool_calls: [
    { id: "one", type: "function", function: { name: "inspect", arguments: JSON.stringify({ value: "x".repeat(500) }) } },
  ] }];
  assert(estimateInputTokens(calls) > estimateInputTokens([{ role: "assistant", content: "" }]) + 500);
  const schema = { role: "system", content: JSON.stringify({ name: "inspect", parameters: { type: "object" } }) };
  const input = estimateInputTokens([...plain, schema]);
  assert.throws(() => validateBudget(profile, input + 127, 128, [...plain, schema]), /budget exceeded/);
});

test("CTX-U04: different questions retrieve different older evidence subsets", () => {
  const chat = fixtures.olderEvidence();
  const alpha = retrieveChatMemory(chat, "alpha");
  const beta = retrieveChatMemory(chat, "beta");
  assert(alpha.length > 0 && beta.length > 0);
  assert(alpha.every(segment => segment.content === fixtures.evidence.alpha));
  assert(beta.every(segment => segment.content === fixtures.evidence.beta));
});

test("CTX-U05: explicit history exclusion prevents automatic history retrieval", () => {
  const chat = { ...fixtures.olderEvidence(), includeHistory: false };
  assert.deepEqual(retrieveChatMemory(chat, "docker-beta"), []);
  assert(!text(requestMessages(chat, "new question")).includes(fixtures.evidence.beta));
});

test("CTX-U05a: historical worker events do not evict authoritative recent dialogue", () => {
  const chat = fixtures.conversation({ messages: [
    ...Array.from({ length: 6 }, (_, index) => ({
      id: `user-${index}`, role: index % 2 ? "assistant" : "user",
      content: `authoritative dialogue ${index}`, status: "complete",
    })),
    ...Array.from({ length: 6 }, (_, index) => ({
      id: `worker-${index}`, role: "user", content: `repeated worker receipt ${index}`,
      status: "complete", workerEventIds: [`00000000-0000-4000-8000-${String(index).padStart(12, "0")}`],
    })),
  ] });
  assert.deepEqual(recentChatDialogue(chat).map(message => message.id),
    ["user-0", "user-1", "user-2", "user-3", "user-4", "user-5"]);
  assert(!text(requestMessages(chat, "next action")).includes("repeated worker receipt"));
});

test("CTX-U06: explicit context and current input are preserved without rewriting", () => {
  const content = "Pinned evidence: NOT approved; QPS=1250, concurrency=32, version=v2.";
  const query = "Do not execute anything. Explain the evidence.";
  const chat = fixtures.conversation({ context: [{ id: "pinned", label: "Explicit reference", content }] });
  const before = JSON.stringify(chat);
  const messages = requestMessages(chat, query);
  assert(text(messages).includes(content));
  assert.equal(messages.at(-1).content, query);
  assert.equal(JSON.stringify(chat), before);
});

test("CTX-U07: constructing context does not modify original tool evidence", () => {
  const chat = fixtures.largeToolHistory();
  const before = JSON.stringify(chat);
  requestMessages(chat, "docker-beta QPS");
  chatMemorySegments(chat);
  retrieveChatMemory(chat, "docker-beta");
  chatRetrievalReceipt(chat, "docker-beta", profile.id);
  assert.equal(JSON.stringify(chat), before);
});

test("CTX-U08: optional context fits exactly, drops one byte over, and never changes required input", () => {
  const required = { role: "user", content: "required question" };
  const optional = { role: "system", content: "exact original evidence" };
  const schema = [{ role: "system", content: '{"tools":[]}' }];
  const automatic = new Map([[optional, { ids: ["evidence"], priority: 1 }]]);
  const budget = estimateInputTokens([required, optional, ...schema]);
  const exact = [optional, required];
  assert.deepEqual([...fitChatContext(exact, automatic, budget, schema)], ["evidence"]);
  assert.deepEqual(exact, [optional, required]);
  const over = [optional, required];
  assert.deepEqual([...fitChatContext(over, automatic, budget - 1, schema)], []);
  assert.deepEqual(over, [required]);
  assert.equal(optional.content, "exact original evidence");
  assert.throws(() => fitChatContext([required], automatic, 1, schema), /required input/);
});

test("CTX-U09: budgeting preserves live tool call/result pairing and removes only historical references", () => {
  const evidence = { role: "system", content: "old optional evidence".repeat(100) };
  const call = { role: "assistant", content: "", tool_calls: [
    { id: "live", type: "function", function: { name: "read_file", arguments: "{}" } },
  ] };
  const outcome = { role: "tool", content: "NOT_SAVED: disk full", tool_call_id: "live" };
  const messages = [evidence, call, outcome];
  const selected = fitChatContext(messages, new Map([[evidence, { ids: ["old"], priority: 1 }]]), estimateInputTokens([call, outcome]));
  assert.equal(selected.size, 0);
  assert.deepEqual(messages, [call, outcome]);
});

test("CTX-U10: tool chunks retain reproducible ranges, status and content-sensitive identities", () => {
  const source = fixtures.failedToolHistory();
  const segments = chatMemorySegments(source).filter(segment => segment.sourceKind === "tool");
  assert(segments.some(segment => /status=failed/.test(segment.content) && segment.content.includes("NOT_SAVED")));
  assert(segments.some(segment => /status=complete/.test(segment.content) && segment.content.includes(fixtures.evidence.beta)));
  for (const segment of segments) {
    assert(segment.sourceRevision.length === 64);
    assert(segment.end > segment.start);
  }
  const changed = structuredClone(source);
  changed.messages[0].toolCalls[0].status = "failed";
  assert.notEqual(chatMemorySegments(changed)[0].id, segments[0].id);
});

test("CTX-R01: recent tool evidence remains retrievable instead of being excluded by position", () => {
  const chat = fixtures.largeToolHistory();
  const selected = retrieveChatMemory(chat, "docker-beta QPS");
  assert(selected.some(segment => segment.content.includes(fixtures.evidence.beta)),
    "Recent evidence must be eligible for retrieval once full tool history is no longer replayed");
});

test("debug follow-ups retain mandatory execution identities and current model configuration without replay", () => {
  const chat = fixtures.conversation({ modelProvider: "vscode", vscodeModelId: "copilot:fixture-model", messages: [
    fixtures.message("user", "Help debug the authentication problem"),
    { ...fixtures.message("assistant", "The server-side network check completed."), toolCalls: [
      { id: "verified-network", name: "run_process", arguments: '{"program":"python3","arguments":[]}',
        result: '{"exitCode":0,"stdout":"DNS OK"}', status: "complete" },
    ] },
    fixtures.message("user", "PKM Chat still works while Copilot Chat does not"),
  ] });
  const automatic = new Map();
  const messages = ApiChatView.prototype.requestMessages.call({
    store: { namespace: fixtures.namespace },
    toolGroups: () => [{ tools: [{ enabled: true, name: "read_file" }, { enabled: true, name: "run_process" }] }],
  }, chat, "Continue the investigation", automatic);
  const ledger = messages.find(message => message.content.includes("verified-network"));
  assert(ledger, "Recent executed-tool identities must not depend on lexical retrieval matching the new question");
  assert(!automatic.has(ledger), "Execution identities must not be dropped with optional recalled evidence");
  assert.match(ledger.content, /execution is not undone/);
  assert.match(ledger.content, /evidenceMessageId/);
  assert.match(messages[0].content, /copilot:fixture-model/);
  assert.match(messages[0].content, /actively collect evidence/);
  assert.match(messages[0].content, /not necessarily the user's local computer/);
  assert.match(messages[0].content, /Do not login\/logout/);
  chat.includeHistory = false;
  assert(!text(requestMessages(chat, "Continue")).includes("verified-network"), "History off must exclude earlier execution metadata");
});

for (const status of ["failed", "cancelled", "interrupted"]) {
  test(`CTX-R02/${status}: completed tool evidence survives failure of its containing response`, () => {
    const selected = retrieveChatMemory(fixtures.failedToolHistory(status), "docker-beta QPS");
    assert(selected.some(segment => segment.content.includes(fixtures.evidence.beta)),
      "Response status must not erase evidence from an independently completed tool");
  });
}

test("CTX-R03: failed tool outcomes remain available without becoming successful facts", () => {
  const chat = fixtures.failedToolHistory();
  const segments = chatMemorySegments(chat);
  assert(segments.some(segment => segment.content.includes("NOT_SAVED: disk full")),
    "Failed operation evidence is needed to prevent false success claims and unsafe retries");
});

test("CTX-R04: changed source content cannot reuse an old segment identity", () => {
  const chat = fixtures.conversation({ messages: [fixtures.message("assistant", "Original QPS=700")] });
  const original = chatMemorySegments(chat);
  const changed = chatMemorySegments({
    ...chat, messages: [{ ...chat.messages[0], content: "Corrected QPS=1250" }],
  });
  assert.notEqual(original[0].id, changed[0].id,
    "Feedback must identify an immutable source version, not just a mutable message position");
});

async function transportFixture(t, source, options = {}) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "pkm-context-contract-"));
  const requests = [];
  const retrievalQueries = [];
  const errors = [];
  const server = http.createServer(async (req, res) => {
    try {
      const chunks = [];
      for await (const chunk of req) chunks.push(chunk);
      const payload = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      requests.push(payload);
      const delta = options.respond ? await options.respond(payload, requests.length - 1) : { content:"Synthetic response" };
      res.writeHead(200, { "Content-Type": "text/event-stream" });
      res.end(`data: ${JSON.stringify({ choices: [{ delta, finish_reason:null }], ...(options.usage ? {usage:options.usage(requests.length - 1)} : {}) })}\n\n`
        + `data: ${JSON.stringify({ choices:[{ delta:{}, finish_reason:delta.tool_calls ? "tool_calls" : "stop" }] })}\n\ndata: [DONE]\n\n`);
    } catch (error) {
      errors.push(error);
      res.writeHead(500);
      res.end("Synthetic transport fixture failed");
    }
  });
  t.after(async () => {
    server.closeAllConnections();
    await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    fs.rmSync(directory, { recursive: true, force: true });
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const extension = { secrets: { get: async () => "synthetic-key" }, globalStorageUri: { fsPath: path.join(directory, "private-host") } };
  const retriever = async query => {
    retrievalQueries.push(query);
    if (options.retrievalError) throw options.retrievalError;
    if (options.retrievalHang) return new Promise(() => {});
    return options.invocation ? {candidates:options.candidates || [], invocation:options.invocation} : options.candidates || [];
  };
  if (options.sourceIsCurrent) retriever.sourceIsCurrent = options.sourceIsCurrent;
  if (options.refreshSourceValidation) retriever.refreshSourceValidation = options.refreshSourceValidation;
  if (options.feedback) retriever.feedback = options.feedback;
  const provider = new ApiChatView(extension, retriever);
  t.after(() => provider.dispose());
  provider.store = new ApiChatStore(path.join(directory, ".pkm", "state"), fixtures.namespace);
  provider.store.save(source);
  provider.chat = provider.store.load(source.id, false);
  provider.chats.set(source.id, provider.chat);
  provider.publish = () => {};
  if (!options.tools) provider.toolGroups = () => [{ id: "builtin", tools: [] }];
  provider.captureExecution = chat => captureExecutionContext(
    provider.executionHostId, [], directory, true, chat.permissionMode || "ask");
  provider.settings = () => ({
    provider: options.nativeModel ? "vscode" : "openai-compatible",
    selectedProfile: options.nativeModel ? require("../dist/chat/api-chat-vscode").vscodeModelProfile(options.nativeModel) : profile,
    profiles: [profile],
    endpoint: `http://127.0.0.1:${server.address().port}/v1`, model: profile.model,
    contextWindow: options.contextWindow || profile.contextWindow,
    maxOutputTokens: 1024, timeoutMs: 10000, maxToolRounds: options.maxToolRounds || 3, loopReviewAfterMs: 60000,
  });
  return { provider, requests, retrievalQueries, errors, directory };
}

test("successful Chat self-evaluates relevance, persists feedback and bills the separate no-tool model call; user correction overrides it", async t => {
  const labels = [], candidate = {id:"online-source", sourceId:"online-source", level:"l1-source", kind:"note",
    label:"Online evidence", sourceUri:"pkm://fixture/online", score:1, method:"synthetic:test", reason:"fixture", selected:false,
    sourceRevision:"1", contentHash:"a".repeat(64), content:"The target sampling upper limit is 1000."};
  const fixture = await transportFixture(t, fixtures.conversation(), {
    candidates:[candidate], invocation:{requestId:"online-query", retrievalId:"online-receipt", requestedRoute:"dual",
      servedRoute:"lexical+semantic", modelInvoked:true, semanticStatus:"ready", readyGeneration:1, corpusRevision:"fixture"},
    respond:(payload, round) => {
      if (!round) return {content:"The upper limit is 1000."};
      assert(!payload.tools?.length, "the evaluator must not execute tools");
      assert.equal(payload.max_tokens, 1024);
      assert.match(payload.messages[0].content, /self-evaluator/);
      return {content:'{"labels":[{"index":0,"relevant":true}]}'};
    },
    usage:round => ({prompt_tokens:round ? 20 : 10, completion_tokens:round ? 3 : 5}),
    feedback:async (...args) => {labels.push(args); return {ok:true, revision:labels.length, ranker_revision:labels.length,
      calibrator_revision:labels.length, provenance:args[2], trained:true, model_labels:args[2] === "model" ? 1 : 0, user_labels:args[2] === "user" ? 1 : 0};},
  });
  await fixture.provider.send("What is the upper sampling limit?");
  const reply = fixture.provider.chat.messages.at(-1);
  assert.equal(reply.status, "complete", reply.error);
  assert.equal(reply.content, "The upper limit is 1000.");
  assert.equal(reply.retrievalLearning?.status, "learned", JSON.stringify({learning:reply.retrievalLearning, retrieval:reply.retrieval}));
  assert.deepEqual(labels, [["online-receipt", ["online-source"], "model"]]);
  assert.equal(fixture.requests.length, 2);
  assert.equal(reply.budgetReceipts.length, 1, "self-evaluation must not overwrite the answer's round ledger");
  assert.equal(reply.auxiliaryModelUsage.length, 1);
  assert.equal(reply.usage.inputTokens, 30); assert.equal(reply.usage.outputTokens, 8);
  assert.equal(fixture.provider.store.load(fixture.provider.chat.id, false).messages.at(-1).retrievalLearning.provenance, "model");
  fixture.provider.requestDecision = async (...args) => {
    await args[7]({complete:true, relevant:[], missed:""});
    return "submit";
  };
  await fixture.provider.handle({type:"reviewRetrieval", chatId:fixture.provider.chat.id, id:reply.id});
  assert.deepEqual(labels.at(-1), ["online-receipt", [], "user"]);
  assert.equal(reply.retrievalLearning.provenance, "user");
  assert.deepEqual(fixture.errors, []);
});

test("invalid self-evaluation never trains and persists an explicit learning failure without changing the answer", async t => {
  let submissions = 0;
  const fixture = await transportFixture(t, fixtures.conversation(), {
    candidates:[{id:"bad-source", sourceId:"bad-source", kind:"note", label:"Fixture", sourceUri:"pkm://fixture/bad",
      score:1, method:"synthetic:test", reason:"fixture", selected:false, content:"Original evidence"}],
    invocation:{requestId:"bad-query", retrievalId:"bad-receipt", requestedRoute:"dual",
      servedRoute:"semantic", modelInvoked:true, semanticStatus:"ready", readyGeneration:1, corpusRevision:"fixture"},
    respond:(_payload, round) => ({content:round ? '{"labels":[]}' : "Answer"}),
    feedback:async () => {submissions++; return {ok:true};},
  });
  await fixture.provider.send("Compare the evidence");
  const reply = fixture.provider.chat.messages.at(-1);
  assert.equal(reply.status, "complete", reply.error);
  assert.equal(reply.content, "Answer");
  assert.equal(reply.retrievalLearning?.status, "failed", JSON.stringify(reply.retrieval));
  assert.match(reply.retrievalLearning.error, /every original source/);
  assert.equal(submissions, 0);
});

test("a later model self-evaluation cannot claim to retrain over protected user judgments", async t => {
  const fixture = await transportFixture(t, fixtures.conversation(), {
    candidates:[{id:"protected-source", sourceId:"protected-source", kind:"note", label:"Fixture", sourceUri:"pkm://fixture/protected",
      score:1, method:"synthetic:test", reason:"fixture", selected:false, content:"Original evidence"}],
    invocation:{requestId:"protected-query", retrievalId:"protected-receipt", requestedRoute:"dual",
      servedRoute:"semantic", modelInvoked:true, semanticStatus:"ready", readyGeneration:1, corpusRevision:"fixture"},
    respond:(_payload, round) => ({content:round ? '{"labels":[{"index":0,"relevant":false}]}' : "Answer"}),
    feedback:async () => ({ok:true, revision:2, ranker_revision:2, calibrator_revision:2,
      provenance:"user", trained:false, ignored:true, reason:"user-precedence", model_labels:0, user_labels:1}),
  });
  await fixture.provider.send("Compare the evidence");
  const reply = fixture.provider.chat.messages.at(-1);
  assert.equal(reply.status, "complete", reply.error);
  assert.equal(reply.retrievalLearning?.status, "user-protected");
  assert.equal(reply.retrievalLearning.acknowledgment.trained, false);
  assert.equal(reply.retrievalLearning.acknowledgment.ranker_revision, 2);
});

test("debug controller rejects advice-only completion and executes real log/process diagnostics before an explicit outcome", async t => {
  let logFile;
  const call = (id, name, args) => ({ tool_calls:[{ index:0, id, type:"function", function:{ name, arguments:JSON.stringify(args) } }] });
  const fixture = await transportFixture(t, fixtures.conversation({
    permissionMode:"allow-all", builtinTools:["run_process", "session_info"], vscodeTools:[],
  }), { tools:true, maxToolRounds:5, respond:(payload, round) => {
    if (round < 3) assert(payload.tools.some(tool => tool.function.name === "report_work"));
    if (round === 0) return { content:"You should inspect the logs." };
    if (round === 1) {
      assert(text(payload.messages).includes("The objective is still open"));
      return call("debug-log-probe", "run_process", {
        program:process.execPath, arguments:["-e", "const fs=require('fs');const s=fs.readFileSync(process.argv[1],'utf8');process.stdout.write(JSON.stringify({diagnosis:s.includes('ECONNREFUSED')?'local endpoint refused connection':'unknown'}))", logFile],
      });
    }
    if (round === 2) {
      assert(payload.messages.some(message => message.role === "tool" && message.content.includes("local endpoint refused connection")));
      return call("debug-current-evidence", "session_info", {});
    }
    if (round === 3) {
      const evidence = JSON.parse(payload.messages.filter(message => message.role === "tool").at(-1).content);
      const diagnostic = evidence.currentAttemptCalls.find(item => item.name === "run_process" && item.status === "complete");
      assert.equal(diagnostic.id, "debug-log-probe", "the model can discover exact native call identities without guessing");
      return call("debug-outcome", "report_work", workOutcome(fixture.provider.chat, "resolved",
        "The requested diagnostic identifies a refused local connection; the user prohibited repair.", [diagnostic.id]));
    }
    return { content:"The local log reports ECONNREFUSED; the diagnostic confirmed it. No repair was performed." };
  } });
  processWorkspace(t, fixture);
  logFile = path.join(fixture.directory, "diagnostic.log");
  fs.writeFileSync(logFile, "fixture endpoint: ECONNREFUSED 127.0.0.1:9999\n");
  await fixture.provider.send("Please debug this local log and identify the cause; do not change anything. 不要停止调查，不得停止服务；不要把检查当作修复。");
  const reply = fixture.provider.chat.messages.at(-1);
  assert.deepEqual(fixture.errors, []);
  assert.equal(reply.status, "complete", `${reply.error}\n${JSON.stringify(reply.toolCalls)}`);
  assert.equal(fixture.requests.length, 5);
  assert.equal(reply.toolCalls.find(call => call.id === "debug-log-probe").status, "complete");
  assert.equal(fixture.provider.chat.debugRequest.status, "completed");
  assert.deepEqual(fixture.provider.store.load(fixture.provider.chat.id, false).debugRequest.evidenceCallIds, ["debug-log-probe"]);
  assert.equal(fs.readFileSync(logFile, "utf8"), "fixture endpoint: ECONNREFUSED 127.0.0.1:9999\n");
  assert.deepEqual(fixture.errors, []);
});

test("debug controller bounds summary-only retries and accepts precise blockers without executing commands", async t => {
  for (const blocked of [false, true]) {
    const fixture = await transportFixture(t, fixtures.conversation({
      permissionMode:"read-only", builtinTools:["read_file"], vscodeTools:[],
    }), { tools:true, respond:(_payload, round) => blocked && round === 1 ? { tool_calls:[{
      index:0, id:"debug-blocked", type:"function", function:{ name:"report_work", arguments:JSON.stringify(
        workOutcome(fixture.provider.chat, "needs_input", "The target log path has not been provided.")) },
    }] } : { content:"Please provide the target log path." } });
    await fixture.provider.send("你去帮忙debug吧");
    const reply = fixture.provider.chat.messages.at(-1);
    assert.equal(reply.status, blocked ? "complete" : "failed", reply.error);
    assert.equal(fixture.requests.length, blocked ? 3 : 2, `${reply.error}\n${JSON.stringify(fixture.errors)}`);
    if (!blocked) assert.match(reply.error, /objective is still open/);
    assert(!reply.toolCalls?.some(call => call.name === "run_process"));
  }
});

test("delegated repair continues beyond a successful diagnostic and independently verifies the original symptom", async t => {
  let target;
  const call = (id, name, args) => ({ tool_calls:[{ index:0, id, type:"function", function:{ name, arguments:JSON.stringify(args) } }] });
  const fixture = await transportFixture(t, fixtures.conversation({
    permissionMode:"allow-all", builtinTools:["run_process"], vscodeTools:[],
  }), { tools:true, maxToolRounds:10, respond:(payload, round) => {
    const chat = fixture.provider.chat;
    if (round === 0) return call("probe", "run_process", {
      program:process.execPath, arguments:["-e", "console.log(require('fs').readFileSync(process.argv[1],'utf8'))", target],
    });
    if (round === 1) return call("partial", "report_work", workOutcome(chat, "continue",
      "The diagnostic found the wrong value, but the requested fix remains open.", [], { nextAction:"Repair the fixture and run the symptom check." }));
    if (round === 2) return { content:"The log was read; investigation complete." };
    if (round === 3) {
      assert(text(payload.messages).includes("The objective is still open"));
      return call("repair-and-verify", "run_process", { program:process.execPath, arguments:["-e",
        "const fs=require('fs'),assert=require('assert/strict');fs.writeFileSync(process.argv[1],'expected');assert.equal(fs.readFileSync(process.argv[1],'utf8'),'expected');console.log('SYMPTOM_CHECK_PASS')", target] });
    }
    if (round === 4) return call("resolved", "report_work", workOutcome(chat, "resolved",
      "Repaired the wrong value and passed the actual symptom check.", ["repair-and-verify"]));
    return { content:"The requested value is repaired and verified." };
  } });
  processWorkspace(t, fixture);
  target = path.join(fixture.directory, "broken-value.txt");
  fs.writeFileSync(target, "wrong");
  await fixture.provider.send("Please fix this fixture's wrong value. It must contain expected, not merely produce a diagnostic.");
  const chat = fixture.provider.store.load(fixture.provider.chat.id, false);
  assert.equal(chat.messages.at(-1).status, "complete", chat.messages.at(-1).error);
  assert.equal(chat.workGoal.status, "resolved");
  assert.equal(fs.readFileSync(target, "utf8"), "expected", "independent symptom acceptance, not report/tool count");
  assert.equal(chat.messages.filter(message => message.role === "user").length, 1, "no external next-step coaching");
  assert.equal(fixture.requests.length, 6);
  assert(chat.messages.at(-1).toolCalls.find(item => item.id === "repair-and-verify").result.includes("SYMPTOM_CHECK_PASS"));
});

test("a blocked work goal resumes on the answer without replacing its original objective", async t => {
  const call = (id, args) => ({ tool_calls:[{ index:0, id, type:"function", function:{ name:"report_work", arguments:JSON.stringify(args) } }] });
  const fixture = await transportFixture(t, fixtures.conversation({
    permissionMode:"read-only", builtinTools:["read_file"], vscodeTools:[],
  }), { tools:true, respond:(payload, round) => {
    if (round === 0 || round === 2) return call(`waiting-${round}`, workOutcome(fixture.provider.chat, "needs_input",
      round === 0 ? "The target address is missing." : "The provided address requires host access not currently granted."));
    return { content:"The goal remains blocked, not resolved." };
  } });
  await fixture.provider.send("Please investigate this unavailable endpoint.");
  const root = structuredClone(fixture.provider.chat.workGoal);
  await fixture.provider.send("The target is https://example.invalid");
  const goal = fixture.provider.store.load(fixture.provider.chat.id, false).workGoal;
  assert.equal(goal.id, root.id);
  assert.equal(goal.objective, root.objective);
  assert.equal(goal.status, "needs_input");
  assert.notEqual(goal.attemptInputId, root.attemptInputId);
  assert.equal(fixture.requests.length, 4);
  assert.equal(fixture.provider.chat.messages.at(-1).status, "complete");
});

test("cancelling delegated work disarms it and explicit resume checks prior effects without replay", async t => {
  let target, release, entered;
  const waiting = new Promise(resolve => { entered = resolve; });
  const call = (id, name, args) => ({ tool_calls:[{ index:0, id, type:"function", function:{ name, arguments:JSON.stringify(args) } }] });
  const fixture = await transportFixture(t, fixtures.conversation({
    permissionMode:"allow-all", builtinTools:["run_process"], vscodeTools:[],
  }), { tools:true, maxToolRounds:8, respond:async (payload, round) => {
    if (round === 0) return call("effect", "run_process", { program:process.execPath, arguments:["-e",
      "require('fs').appendFileSync(process.argv[1],'once\\n');console.log('effect recorded')", target] });
    if (round === 1) {
      entered();
      return await new Promise(resolve => { release = () => resolve({ content:"Interrupted answer." }); });
    }
    if (round === 2) {
      assert(text(payload.messages).includes("never replay uncertain effects"));
      return call("reconcile", "run_process", { program:process.execPath, arguments:["-e",
        "require('assert/strict').equal(require('fs').readFileSync(process.argv[1],'utf8'),'once\\n');console.log('prior effect verified, not replayed')", target] });
    }
    if (round === 3) return call("finish", "report_work", workOutcome(fixture.provider.chat, "resolved",
      "The authorized effect exists once and was independently rechecked.", ["reconcile"]));
    return { content:"Verified the existing result without replay." };
  } });
  processWorkspace(t, fixture);
  target = path.join(fixture.directory, "effect.txt");
  const send = fixture.provider.send("Please implement this one-time fixture effect and verify it.");
  await waiting;
  fixture.provider.running.get(fixture.provider.chat.id).abort();
  await send;
  release();
  assert.equal(fixture.provider.chat.workGoal.status, "paused");
  assert.equal(fs.readFileSync(target, "utf8"), "once\n");
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(fixture.requests.length, 2, "cancellation cannot auto-start another model round");
  const id = fixture.provider.chat.workGoal.id;
  await fixture.provider.send("Continue the existing task, checking the previous effect before doing anything else.");
  assert.equal(fixture.provider.chat.workGoal.id, id);
  assert.equal(fixture.provider.chat.workGoal.status, "resolved");
  assert.equal(fs.readFileSync(target, "utf8"), "once\n", "resume cannot blindly repeat the effect");
});

test("queue editor survives completion and releases all ordered inputs into a single model request", async t => {
  let release, started;
  const ready = new Promise(resolve => { started = resolve; });
  const finishing = new Promise(resolve => { release = resolve; });
  const fixture = await transportFixture(t, fixtures.conversation({ context:[], builtinTools:[], vscodeTools:[] }), {
    respond:async (_payload, round) => {
      if (round === 0) { started(); await finishing; }
      return { content:"Fixture completed" };
    },
  });
  const provider = fixture.provider, chat = provider.chat;
  const running = provider.send("Current request");
  await ready;
  const context = provider.captureExecution(chat);
  const first = { id:require("crypto").randomUUID(), text:"First queued instruction", mode:"task", executionContext:context };
  const second = { ...first, id:require("crypto").randomUUID(), text:"Second queued instruction" };
  await provider.handle({ type:"send", text:first.text, mode:"task", submissionId:first.id });
  await provider.handle({ type:"send", text:second.text, mode:"task", submissionId:second.id });
  const token = require("crypto").randomUUID();
  await provider.handle({ type:"beginQueuedEdit", chatId:chat.id, id:first.id, editToken:token });
  release();
  await running;
  await new Promise(resolve => setImmediate(resolve));
  await provider.drainQueue(chat);
  assert.equal(fixture.requests.length, 1, "editor holds dispatch after the active request completes");
  assert.equal(provider.store.load(chat.id, false).queuedInputs[0].editToken, token);
  await provider.handle({ type:"saveQueuedEdit", chatId:chat.id, id:first.id, editToken:token, text:"Edited first instruction" });
  assert.equal(chat.messages.at(-1).status, "complete", chat.messages.at(-1).error);
  assert.equal(fixture.requests.length, 2);
  assert.deepEqual(fixture.requests[1].messages.filter(message => message.role === "user").slice(-2).map(message => message.content),
    ["Edited first instruction", "Second queued instruction"]);
  assert.deepEqual(chat.messages.filter(message => message.submissionId).map(message => message.submissionId), [first.id, second.id]);
  assert.equal(chat.queuedInputs.length, 0);
});

test("oversized ordered batch fails before dispatch and retains every queued input without duplicating accepted history", async t => {
  const fixture = await transportFixture(t, fixtures.conversation({ context:[], builtinTools:[], vscodeTools:[] }), { contextWindow:8192 });
  const provider = fixture.provider, chat = provider.chat;
  const context = provider.captureExecution(chat);
  const batch = Array.from({ length:4 }, (_, index) => ({ id:require("crypto").randomUUID(), text:`${index}: ${"X".repeat(15000)}`,
    mode:"task", executionContext:context }));
  for (const input of batch) Object.assign(chat, provider.store.enqueueInput(chat, input));
  await provider.drainQueue(chat);
  assert.equal(fixture.requests.length, 0);
  assert.equal(chat.messages.at(-1).status, "failed");
  assert.deepEqual(chat.queuedInputs.map(input => input.id), batch.map(input => input.id));
  assert.equal(chat.messages.filter(message => message.submissionId).length, 0);
  assert.deepEqual(provider.store.load(chat.id, false).queuedInputs.map(input => input.id), batch.map(input => input.id));
});

test("four-turn Chat retains distinct retrieval queries and exact sent context manifests after reopening", async t => {
  const fixture = await transportFixture(t, fixtures.conversation({ context:[], builtinTools:[], vscodeTools:[] }), {
    candidates:[{ id:"four-turn-source", kind:"note", label:"Synthetic conditions", sourceUri:"pkm://fixture/four-turn",
      score:1, method:"synthetic:four-turn", selected:false, reason:"Fixture evidence",
      content:"SYNTHETIC_FOUR_TURN_CONDITION: latency must not exceed 125 ms; never deploy." }],
  });
  const evidence = [];
  for (const query of [
    "Find the synthetic latency condition.",
    "Explain that condition without changing its limit.",
    "Compare a synthetic 130 ms observation with that condition.",
    "Summarize the conclusion; do not deploy anything.",
  ]) {
    await fixture.provider.send(query);
    const reply = fixture.provider.chat.messages.at(-1);
    assert.equal(reply.status, "complete", `${reply.error}\n${JSON.stringify(reply.toolCalls)}`);
    assert.equal(reply.retrieval.query, query);
    assert.equal(reply.retrieval.phase, "sent");
    assert(reply.retrieval.candidates.some(candidate => candidate.id === "four-turn-source"
      && candidate.selected && candidate.evidenceState === "sent"));
    assertHttpManifests({ ...fixture, requests:[fixture.requests.at(-1)] });
    assert(text(fixture.requests.at(-1).messages).includes("SYNTHETIC_FOUR_TURN_CONDITION"));
    assert(text(fixture.requests.at(-1).messages).includes(query));
    evidence.push({ id:reply.id, attempt:reply.progress.attemptId,
      hash:createHash("sha256").update(JSON.stringify([reply.retrievalActivity, reply.budgetReceipts])).digest("hex") });
  }
  assert.equal(fixture.requests.length, 4);
  assert.equal(new Set(evidence.map(item => item.attempt)).size, 4);
  const reopened = new ApiChatStore(path.join(fixture.directory, ".pkm", "state"), fixtures.namespace).load(fixture.provider.chat.id, false);
  for (const recorded of evidence) {
    const reply = reopened.messages.find(message => message.id === recorded.id);
    assert.equal(createHash("sha256").update(JSON.stringify([reply.retrievalActivity, reply.budgetReceipts])).digest("hex"), recorded.hash);
  }
  assert.deepEqual(fixture.errors, []);
});

test("large-window HTTP Chat sends only bounded matching PKM passages and exposes hash-free cost diagnostics", async t => {
  const candidates = Array.from({ length:13 }, (_, index) => {
    const content = `# Copilot diagnostics ${index}\n\nCopilot failure evidence ${index}: inspect the current session error; never replay a job.\n\n# Archive\n\n${"Unrelated historical archive content. ".repeat(400)}`;
    return { id:`pkm://script/script_fixture_${index}`, sourceId:`pkm://script/script_fixture_${index}`,
      level:"l1-source", kind:"script", label:`Archive ${index}.md`, sourceUri:`pkm://script/script_fixture_${index}`,
      sourceRevision:`revision-${index}`, contentHash:createHash("sha256").update(content).digest("hex"),
      score:1 / (60 + index), method:"lexical:fixture", selected:false, reason:"Lexical hit", content };
  });
  const pinned = "Pinned manual reference: preserve this exact instruction.\n".repeat(400);
  const source = fixtures.conversation({ includeHistory:false, context:[{ id:"manual", label:"Manual attachment", content:pinned }],
    builtinTools:[], vscodeTools:[] });
  const fixture = await transportFixture(t, source, { candidates });
  for (const query of ["Explain Copilot failure diagnostics.", "Review Copilot failure evidence without replay."]) {
    await fixture.provider.send(query);
    const reply = fixture.provider.chat.messages.at(-1);
    assert.equal(reply.status, "complete", reply.error);
    const payload = fixture.requests.at(-1);
    const references = payload.messages.filter(message => message.content.startsWith("Automatically retrieved PKM references"));
    assert(references.length > 0, "matching structural passages remain available");
    assert(estimateInputTokens(references) <= 8000, "the actual dispatched automatic-reference payload must fit the independent budget");
    assert(text(payload.messages).includes(pinned) && text(payload.messages).includes(query));
    assert(!text(references).includes("Unrelated historical archive content"));
    for (const parent of candidates) assert(!text(payload.messages).includes(parent.content));
    const budget = reply.budgetReceipts.at(-1);
    assert.equal(budget.contextPlan.automaticKnowledge.inputBudget, 8000);
    assert.equal(budget.contextPlan.automaticKnowledge.estimatedAfter, estimateInputTokens(references));
    assert(budget.contextPlan.refinements > 0);
    assert(reply.retrieval.candidates.some(candidate => candidate.level === "l2-passage" && candidate.selected));
    const result = await fixture.provider.agentControl("get", { chatId:fixture.provider.chat.id });
    assert.equal(result.reply.context.roundCount, 1);
    assert.equal(result.reply.context.rounds[0].automaticKnowledge.inputBudget, 8000);
    assert(!/\b[a-f0-9]{64}\b/.test(JSON.stringify(result.reply.context)), "default diagnostics must not contain source hashes or manifests");
    assert(Buffer.byteLength(JSON.stringify(result.reply.context)) < 3000);
    assertHttpManifests({ ...fixture, requests:[payload] });
  }
  assert.deepEqual(fixture.errors, []);
});

test("Profile snapshots reach actual HTTP model rounds, remain stable during edits, and next attempts use current revisions", async t => {
  const { PersonaProfileStore } = require("../dist/chat/persona-profiles");
  let store, originalUser, agent;
  const fixture = await transportFixture(t, fixtures.conversation({ includeHistory:false,
    permissionMode:"allow-all", context:[], builtinTools:["session_info"], vscodeTools:[] }), {
    tools:true, respond:(_payload, round) => {
      if (round === 0) {
        store.save("user", { ...originalUser, preferences:"PROFILE_REVISION_TWO" }, originalUser);
        return { tool_calls:[{ index:0, id:"profile-session", type:"function", function:{ name:"session_info", arguments:"{}" } }] };
      }
      return { content:"Profile transport fixture answer" };
    },
  });
  store = new PersonaProfileStore(path.join(fixture.directory, "private-host"), require("../dist/knowledge/filestore").getStorePath());
  const card = { name:"Explicit developer", role:"SDE", focus:"Correctness", preferences:"PROFILE_REVISION_ONE", boundaries:"No extra authority" };
  originalUser = store.save("user", card);
  agent = store.save("agent", { ...card, preferences:"EXPLICIT_AGENT_PROFILE" });
  fixture.provider.chat.agentProfileId = agent.id;
  await fixture.provider.send("Inspect identity with explicit profile context.");
  const first = fixture.provider.chat.messages.at(-1);
  assert.equal(first.status, "complete", first.error);
  assert.equal(fixture.requests.length, 2);
  for (const payload of fixture.requests) {
    assert(text(payload.messages).includes("PROFILE_REVISION_ONE"));
    assert(!text(payload.messages).includes("PROFILE_REVISION_TWO"));
    assert(text(payload.messages).includes("EXPLICIT_AGENT_PROFILE"));
  }
  assert.equal(first.profileContext.user.revision, 1);
  assert(first.budgetReceipts.every(r => r.status === "sent" && r.contextPlan.manifest.some(m => m.hash === first.profileContext.messageHash)));
  const originalSnapshot = JSON.stringify(first.profileContext);
  assertHttpManifests(fixture);
  await fixture.provider.send("Use next attempt preferences.");
  assert(text(fixture.requests.at(-1).messages).includes("PROFILE_REVISION_TWO"));
  assert.equal(fixture.provider.chat.messages.at(-1).profileContext.user.revision, 2);
  store.delete(agent);
  await assert.rejects(fixture.provider.send("Deleted assignment must not silently fall back."), /unavailable or deleted/);
  const loaded = fixture.provider.store.load(fixture.provider.chat.id, false);
  assert.equal(JSON.stringify(loaded.messages.find(m => m.id === first.id).profileContext), originalSnapshot);
  assertHttpManifests({ ...fixture, requests:fixture.requests.slice(2) });
});

test("Profile retry is a new attempt, keeps historical snapshot, and budget overflow dispatches no model request", async t => {
  const { PersonaProfileStore } = require("../dist/chat/persona-profiles");
  const fixture = await transportFixture(t, fixtures.conversation({ includeHistory:false, context:[], builtinTools:[], vscodeTools:[] }), {
    respond:(_payload, round) => round === 0 ? {} : { content:"Retried with edited Profile" },
  });
  const store = new PersonaProfileStore(path.join(fixture.directory, "private-host"), require("../dist/knowledge/filestore").getStorePath());
  const card = { name:"User", role:"", focus:"", preferences:"RETRY_PROFILE_ONE", boundaries:"" };
  const original = store.save("user", card);
  const question = "Answer with current Profile";
  await fixture.provider.send(question);
  const first = fixture.provider.chat.messages.at(-1);
  assert.equal(first.status, "failed");
  store.save("user", { ...card, preferences:"RETRY_PROFILE_TWO" }, original);
  await fixture.provider.send(question, fixture.provider.chat, undefined, { replyId:first.id, inputId:first.inputId });
  const retry = fixture.provider.chat.messages.at(-1);
  assert.equal(retry.status, "complete", retry.error);
  assert.equal(retry.profileContext.user.revision, 2);
  assert.equal(first.profileContext.user.revision, 1);
  assert.equal(retry.progress.retryOf, first.progress.attemptId);
  assert(text(fixture.requests.at(-1).messages).includes("RETRY_PROFILE_TWO"));
  const settings = fixture.provider.settings();
  fixture.provider.settings = () => ({ ...settings, contextWindow:1280 });
  const sent = fixture.requests.length;
  await fixture.provider.send("Required Profile must fit without truncation.");
  assert.equal(fixture.requests.length, sent);
  assert.equal(fixture.provider.chat.messages.at(-1).status, "failed");
  assert.match(fixture.provider.chat.messages.at(-1).error, /budget|Context/);
});

test("Portal actual model send excludes controlled-user private Profiles unless an explicit request snapshot is provided", async t => {
  const { PersonaProfileStore, portalPersonaSnapshot } = require("../dist/chat/persona-profiles");
  const fixture = await transportFixture(t, fixtures.conversation({ includeHistory:false, context:[], builtinTools:[], vscodeTools:[] }));
  const store = new PersonaProfileStore(path.join(fixture.directory, "private-host"), require("../dist/knowledge/filestore").getStorePath());
  const card = { name:"Controlled user", role:"", focus:"", preferences:"CONTROLLED_PRIVATE_PROFILE", boundaries:"" };
  store.save("user", card);
  fixture.provider.openStore = () => fixture.provider.store;
  fixture.provider.retrieval = undefined;
  fixture.provider.requestPermission = async () => false;
  await fixture.provider.executeRemoteTask("No implicit private profile", new AbortController().signal, require("node:crypto").randomUUID(), fixture.provider.chat.id);
  assert(!text(fixture.requests.at(-1).messages).includes("CONTROLLED_PRIVATE_PROFILE"));
  assert.equal(fixture.provider.chat.messages.at(-1).profileContext, undefined);
  const controller = new PersonaProfileStore(path.join(fixture.directory, "controller-private"), fixture.directory);
  controller.save("user", { ...card, preferences:"EXPLICIT_CONTROLLER_PROFILE" });
  const snapshot = portalPersonaSnapshot(controller.capture());
  await fixture.provider.executeRemoteTask("Apply only approved snapshot", new AbortController().signal, require("node:crypto").randomUUID(),
    fixture.provider.chat.id, undefined, undefined, snapshot);
  assert(text(fixture.requests.at(-1).messages).includes("EXPLICIT_CONTROLLER_PROFILE"));
  assert(!text(fixture.requests.at(-1).messages).includes("CONTROLLED_PRIVATE_PROFILE"));
  assert.equal(fixture.provider.chat.messages.at(-1).profileContext.source, "portal-explicit");
  assert.equal(fixture.provider.remoteProfiles.size, 0);
});

test("Profile-assigned Chat adopts model/provider switches and preserves pinned text and native images without HTTP fallback", async t => {
  const { PersonaProfileStore } = require("../dist/chat/persona-profiles");
  const { vscodeModelProfile } = require("../dist/chat/api-chat-vscode");
  const { decodeChatImage } = require("../dist/chat/api-chat-client");
  class TextPart { constructor(value) { this.value = value; } }
  class DataPart { constructor(data, mimeType) { Object.assign(this, { data, mimeType }); } }
  const previous = { ...host }, nativeRequests = [];
  const makeModel = id => ({
    id, vendor:"profile-fixture", name:id, maxInputTokens:262144, capabilities:{ imageInput:true },
    countTokens:async value => Buffer.byteLength(typeof value === "string" ? value : JSON.stringify(value), "utf8"),
    sendRequest:async (messages, options) => {
      nativeRequests.push({ id, messages, options });
      return { stream:(async function* () { yield new TextPart(`Answer from ${id}`); })() };
    },
  });
  const models = [makeModel("vision-one"), makeModel("vision-two")];
  let providerChoice = "native", inputs = [];
  const cfg = { get:(_key, fallback) => fallback, update:async () => {} };
  Object.assign(host, {
    lm:{ tools:[], selectChatModels:async () => models },
    LanguageModelTextPart:TextPart, LanguageModelDataPart:DataPart,
    LanguageModelChatMessage:{ User:content => ({ role:1, content }), Assistant:content => ({ role:2, content }) },
    CancellationTokenSource:class { token = {}; cancel() {} dispose() {} },
    ConfigurationTarget:{ Global:1 },
    QuickPickItemKind:{ Separator:-1 },
    workspace:{ ...host.workspace, getConfiguration:() => cfg },
    window:{ ...host.window,
      showQuickPick:async items => { items = await items; return providerChoice === "native" ? items.find(item => item.id?.startsWith("vscode:")) : items.find(item => item.value === "openai-compatible"); },
      showInputBox:async () => inputs.shift(),
    },
  });
  t.after(() => { for (const key of Object.keys(host)) delete host[key]; Object.assign(host, previous); });
  const pinned = { id:"pinned-text", label:"requirements.txt", content:"PINNED_PROFILE_REQUIREMENT\nKeep exact attachment text: <profile> & \"quoted\"." };
  const fixture = await transportFixture(t, fixtures.conversation({ includeHistory:false,
    context:[pinned], builtinTools:[], vscodeTools:[] }));
  const provider = fixture.provider, base = provider.settings();
  const httpModels = [profile, { ...profile, id:"profile-http-two", model:"profile-http-two", label:"HTTP two" }];
  provider.settings = () => {
    const native = provider.chat.modelProvider === "vscode";
    const available = native ? models.map(vscodeModelProfile) : httpModels;
    const selected = available.find(item => item.id === (native ? provider.chat.vscodeModelId : provider.chat.modelProfileId)) || available[0];
    return { ...base, provider:native ? "vscode" : "openai-compatible", profiles:available,
      selectedProfile:selected, model:selected.model,
      contextWindow:provider.chat.contextWindow || base.contextWindow,
      maxOutputTokens:provider.chat.maxOutputTokens || base.maxOutputTokens };
  };
  const profiles = new PersonaProfileStore(path.join(fixture.directory, "private-host"), require("../dist/knowledge/filestore").getStorePath());
  profiles.save("user", { name:"User", role:"", focus:"", preferences:"COMBINATION_USER_PROFILE", boundaries:"" });
  const agent = profiles.save("agent", { name:"Agent", role:"SDE", focus:"Tests", preferences:"COMBINATION_ASSIGNED_AGENT", boundaries:"No authority" });
  provider.chat.agentProfileId = agent.id;
  await provider.send("First HTTP model with pinned attachment");
  await provider.handle({ type:"model", value:httpModels[1].id });
  await provider.send("Second HTTP model keeps assigned Agent");
  assert.equal(fixture.requests[0].model, profile.model);
  assert.equal(fixture.requests[1].model, httpModels[1].model);
  assert.equal(await provider.chooseVscodeModel(provider.chat), true);
  const image = { label:"profile-image.png", mimeType:"image/png",
    dataBase64:"iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a5wAAAABJRU5ErkJggg==" };
  provider.chat.images = [image];
  await provider.send("Native image with Profile and pinned text");
  assert.equal(provider.chat.messages.at(-1).status, "complete", provider.chat.messages.at(-1).error);
  await provider.handle({ type:"model", value:vscodeModelProfile(models[1]).id });
  provider.chat.images = [image];
  await provider.send("Switch native model, keep Profile and image");
  assert.equal(provider.chat.messages.at(-1).status, "complete", provider.chat.messages.at(-1).error);
  assert.deepEqual(nativeRequests.map(request => request.id), ["vision-one", "vision-two"]);
  for (const request of nativeRequests) {
    const parts = request.messages.flatMap(message => message.content);
    const data = parts.find(part => part instanceof DataPart);
    assert(data, "The actual native request must contain an image data part, not a textual placeholder");
    assert(Buffer.from(data.data).equals(decodeChatImage(image)));
    assert.equal(data.mimeType, image.mimeType);
    assert(parts.some(part => typeof part.value === "string" && part.value.includes(pinned.content)));
    assert(JSON.stringify(request.messages).includes("COMBINATION_ASSIGNED_AGENT"));
    assert(JSON.stringify(request.messages).includes("COMBINATION_USER_PROFILE"));
  }
  providerChoice = "http";
  inputs = [base.endpoint, httpModels[1].id, ""];
  await provider.handle({ type:"settings" });
  await provider.send("Back to HTTP with same explicit assignment and pinned text");
  assert.equal(fixture.requests.length, 3);
  assert.equal(fixture.requests.at(-1).model, httpModels[1].model);
  for (const payload of fixture.requests) {
    assert(text(payload.messages).includes(pinned.content));
    assert(text(payload.messages).includes("COMBINATION_ASSIGNED_AGENT"));
    assert(text(payload.messages).includes("COMBINATION_USER_PROFILE"));
  }
  const sent = fixture.requests.length;
  provider.chat.images = [image];
  await provider.send("HTTP must explicitly reject image input, not drop it or switch models");
  const rejected = provider.chat.messages.at(-1);
  assert.equal(rejected.status, "failed");
  assert.match(rejected.error, /Direct HTTP image transport/);
  assert.equal(fixture.requests.length, sent);
  assert.equal(nativeRequests.length, 2);
  assert.equal(provider.chat.agentProfileId, agent.id);
  const restored = provider.store.load(provider.chat.id, false);
  assert.equal(restored.agentProfileId, agent.id);
  assert.deepEqual(restored.context, [pinned]);
  const replies = restored.messages.filter(message => message.role === "assistant");
  assert.equal(replies.length, 6);
  for (const reply of replies) {
    assert.equal(reply.profileContext.agent.id, agent.id);
    assert.equal(reply.profileContext.agent.revision, 1);
    assert.equal(reply.profileContext.user.revision, 1);
    if (reply.status === "complete") {
      assert(reply.budgetReceipts.every(receipt => receipt.status === "sent"
        && receipt.contextPlan.manifest.some(item => item.hash === reply.profileContext.messageHash)));
    }
  }
  assert.equal(restored.messages.filter(message => message.role === "user" && message.images?.length).length, 3);
});

test("transport-child permission signals retain the original attempt owner", async () => {
  const owner = new AbortController(), child = new AbortController();
  const chat = fixtures.conversation({ permissionMode:"allow-all" });
  const provider = { running:new Map([[chat.id, owner]]), store:{ assertAvailable() {} }, remoteControlledRequests:new Set() };
  const permission = () => ApiChatView.prototype.requestPermission.call(
    provider, chat, "process", "Run local probe", "", child.signal, true, false, owner.signal);
  assert.equal(await permission(), true);
  provider.running.set(chat.id, new AbortController());
  await assert.rejects(permission(), /Request cancelled/);
  provider.running.set(chat.id, owner);
  await assert.rejects(ApiChatView.prototype.requestPermission.call(
    provider, chat, "process", "Unbound child", "", child.signal), /Request cancelled/);
  child.abort();
  await assert.rejects(permission(), /Request cancelled/);
  owner.abort();
  await assert.rejects(ApiChatView.prototype.requestPermission.call(
    provider, chat, "process", "Aborted owner", "", new AbortController().signal, true, false, owner.signal), /Request cancelled/);
});

test("fixture acceptance sends only synthetic tail references through the real controller/HTTP and scoped override expires", async t => {
  const fixture = await transportFixture(t, fixtures.conversation({ includeHistory:false,
    permissionMode:"read-only", context:[], builtinTools:[], vscodeTools:[] }), {
      candidates:[{ id:"private", kind:"note", sourceUri:"pkm://notes/private", label:"Private",
        content:"PRIVATE_CORPUS_MUST_NOT_BE_SENT", method:"fixture:private", score:1, selected:false, reason:"Private corpus sentinel" }],
    });
  const { retrieve } = require("../dist/chat/chat-e2e-fixture").createChatE2eFixture();
  fixture.provider.acceptanceRetrieval.set(fixture.provider.chat.id, retrieve);
  try {
    await fixture.provider.send("Return fixture-beta latency and conditions.");
    const reply = fixture.provider.chat.messages.at(-1);
    assert.equal(reply.status, "complete", reply.error);
    assert.equal(fixture.retrievalQueries.length, 0, "Production retrieval must not be called.");
    const body = JSON.stringify(fixture.requests);
    assert(!body.includes("PRIVATE_CORPUS_MUST_NOT_BE_SENT"));
    assert(body.includes("125 ms") && body.includes("Concurrency=32") && body.includes("No deployment is approved."));
    assert.equal(reply.retrieval.phase, "sent");
    assert(reply.retrieval.candidates.some(item => item.selected && item.range?.start > 160000));
    assert(!JSON.stringify(reply.retrieval).includes("maximum p99 latency"));
  } finally { fixture.provider.acceptanceRetrieval.delete(fixture.provider.chat.id); }
  await fixture.provider.send("Normal production retrieval after fixture completion.");
  assert.equal(fixture.retrievalQueries.length, 1);
});

test("transport-child pending approvals reject a replaced owner and abort with the child", async () => {
  const chat = fixtures.conversation({ permissionMode:"ask" });
  const owner = new AbortController();
  const provider = {
    running:new Map([[chat.id, owner]]), store:{ assertAvailable() {} }, approvals:new Map(),
    remoteControlledRequests:new Set(),
    baselineApprovalScopes:new Map(), measureBaseline() {}, setAwaitingInput() {},
    workerDecision() {}, clearWorkerDecision() {}, publish() {}, notifyChat() {},
  };
  const permission = signal => ApiChatView.prototype.requestPermission.call(
    provider, chat, "process", "Pending local probe", "", signal, true, false, owner.signal);
  const child = new AbortController(), pending = permission(child.signal);
  const approval = [...provider.approvals.values()][0];
  assert.equal(approval.signal, child.signal);
  provider.running.set(chat.id, new AbortController());
  approval.resolve(true);
  await assert.rejects(pending, /Request cancelled/);
  assert.equal(provider.approvals.size, 0);
  provider.running.set(chat.id, owner);
  const cancelled = permission(child.signal);
  child.abort();
  await assert.rejects(cancelled, /Request cancelled/);
  assert.equal(provider.approvals.size, 0);
});

test("remote task wrapper uses its bound Chat, preserves local configuration and binds original cancellation", async () => {
  const originalCommands = host.commands;
  host.commands = { executeCommand: async () => undefined };
  try {
    const chat = fixtures.conversation({ permissionMode:"allow-all", permissionGrants:["process"], includeHistory:true, messages:[] });
    const signal = new AbortController().signal;
    const requestId = "12345678-1234-1234-1234-123456789abc";
    let replyId;
    const target = {
      disposed:false, openStore() {}, chats:new Map(), store:{ namespace:fixtures.namespace, resolveChat:id => { assert.equal(id, chat.id); return chat; } },
      remoteControlledRequests:new Set(), agentControlledRequests:new Set(), running:new Map(), queueDrains:new Map(), assertRunnable() {},
      send: async (prompt, actual, parent) => {
        assert.equal(actual, chat); assert.equal(prompt, "remote exact instruction"); assert.equal(parent.signal, signal);
        assert.equal(parent.portalTask.requestId, requestId);
        replyId = parent.portalTask.replyId;
        assert.match(replyId, /^[a-f0-9-]{36}$/);
        assert.equal(actual.permissionMode, "allow-all"); assert.deepEqual(actual.permissionGrants, ["process"]);
        assert.equal(actual.includeHistory, true);
        assert(target.remoteControlledRequests.has(chat.id));
        assert(target.agentControlledRequests.has(chat.id));
        chat.messages.push({ id:replyId, role:"assistant", status:"complete", content:"verified fixture",
          portalTask:{ requestId, originalReplyId:replyId } });
      },
    };
    const result = await ApiChatView.prototype.executeRemoteTask.call(target, "remote exact instruction", signal, requestId, chat.id);
    assert.equal(result.requestId, requestId); assert.equal(result.replyId, replyId);
    assert.equal(target.remoteControlledRequests.size, 0); assert.equal(target.agentControlledRequests.size, 0);
    const aborted = new AbortController(); aborted.abort();
    await assert.rejects(ApiChatView.prototype.executeRemoteTask.call(target, "remote", aborted.signal, requestId), /live, trusted/);
  } finally { host.commands = originalCommands; }
});

test("real remote-controlled HTTP execution ignores Allow All and remembered grants for every call and excludes redelegation", async t => {
  const fixture = await transportFixture(t, fixtures.conversation({
    permissionMode:"allow-all", permissionGrants:["non-destructive"], builtinTools:["run_process", "spawn_workers", "ask_chat", "list_chats", "cross_machine_collaboration"], vscodeTools:[],
  }), { tools:true, respond:(_payload, round) => round < 2 ? { tool_calls:[{
    index:0, id:`remote-local-process-${round}`, type:"function",
    function:{ name:"run_process", arguments:JSON.stringify({
      program:process.execPath, arguments:["-e", `process.stdout.write('REMOTE_PERMISSION_${round}')`],
    }) },
  }] } : { content:"Remote evidence received." } });
  processWorkspace(t, fixture);
  const provider = fixture.provider;
  const approvals = [];
  provider.remoteControlledRequests.add(provider.chat.id);
  provider.notifyChat = (_chat, _key, kind, _detail, id) => {
    if (kind !== "permission") return;
    const pending = provider.approvals.get(id);
    approvals.push(_detail);
    assert(pending.once, "No remembered approvals for remote calls");
    assert.throws(() => provider.resolveApproval(id, "allow-all"), /Allow All cannot approve/);
    provider.resolveApproval(id, "approve-once");
  };
  await provider.send("Perform the two remote fixture probes.");
  assert.equal(provider.chat.messages.at(-1).status, "complete", provider.chat.messages.at(-1).error);
  assert.equal(approvals.filter(title => title === `Run program ${process.execPath}?`).length, 2, JSON.stringify(approvals));
  assert.equal(provider.chat.messages.at(-1).toolCalls.length, 2);
  const advertised = fixture.requests[0].tools.map(tool => tool.function.name);
  assert(advertised.includes("run_process"));
  for (const name of ["spawn_workers", "ask_chat", "list_chats", "cross_machine_collaboration"]) assert(!advertised.includes(name));
});

test("HTTP controller executes a real builtin process through its transport-child permission signal", async t => {
  const fixture = await transportFixture(t, fixtures.conversation({
    permissionMode:"allow-all", builtinTools:["run_process"], vscodeTools:[],
  }), { tools:true, respond:(_payload, round) => round === 0 ? { tool_calls:[{
    index:0, id:"real-local-process", type:"function",
    function:{ name:"run_process", arguments:JSON.stringify({
      program:process.execPath, arguments:["-e", "process.stdout.write('CTX_PERMISSION_PROCESS_OK')"],
    }) },
  }] } : { content:"Local process evidence received." } });
  processWorkspace(t, fixture);
  await fixture.provider.send("Execute exactly the advertised local process probe.");
  const reply = fixture.provider.chat.messages.at(-1);
  assert.equal(reply.status, "complete", reply.error);
  assert.equal(reply.toolCalls[0].status, "complete", reply.toolCalls[0].result);
  const result = JSON.parse(reply.toolCalls[0].result);
  assert.equal(result.exitCode, 0);
  assert.equal(result.stdout, "CTX_PERMISSION_PROCESS_OK");
  assert.equal(fs.readFileSync(result.stdoutLog, "utf8"), result.stdout);
  const invocation = reply.invocationBudgets.find(item => item.id === "tool:real-local-process");
  assert.equal(invocation.status, "complete");
  assert.equal(invocation.owner, "tool");
  assert.equal(invocation.deadlineMs, undefined);
  assert.equal(invocation.activeMs + invocation.userWaitMs, invocation.elapsedMs);
  assert.equal(reply.invocationBudgets.filter(item => item.id === invocation.id).length, 1);
  assert.equal(fixture.requests.length, 2);
  assert(fixture.requests[1].messages.some(message => message.role === "tool" && message.content.includes(result.stdout)));
});

test("actual WebSocket pair -> local instruction approval -> bound PKM Chat -> HTTP model -> approved process -> original peer receipt", { timeout:20000 }, async t => {
  const { ChatHub } = require("../dist/chatroom/chatroom-hub");
  const { ChatClient } = require("../dist/chatroom/chatroom-client");
  const { PeerSession } = require("../dist/chatroom/peer-session");
  const fixture = await transportFixture(t, fixtures.conversation({ permissionMode:"ask", builtinTools:["run_process"] }), {
    tools:true, respond:(_payload, round) => round === 0 ? { tool_calls:[{
      index:0, id:"peer-process", type:"function", function:{ name:"run_process", arguments:JSON.stringify({
        program:process.execPath, arguments:["-e", "process.stdout.write('PEER_REAL_EXECUTION')"],
      }) },
    }] } : { content:"PEER_REAL_EXECUTION verified" },
  });
  processWorkspace(t, fixture);
  const previousCommands = host.commands;
  host.commands = { ...host.commands, executeCommand:async () => undefined };
  t.after(() => { host.commands = previousCommands; });
  const provider = fixture.provider;
  let toolApprovals = 0, taskApprovals = 0;
  provider.notifyChat = (_chat, _key, kind, _detail, id) => {
    if (kind === "permission") { toolApprovals++; provider.resolveApproval(id, "approve-once"); }
  };
  const hub = new ChatHub(), secrets = new Map(), clients = [], sessions = [], errors = [];
  const roomDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "pkm-peer-pipeline-"));
  hub.configureLifecycle(roomDirectory, 1024 * 1024, "fixture-owner", {
    get:async key => secrets.get(key), store:async (key,value) => { secrets.set(key,value); }, delete:async key => { secrets.delete(key); },
  });
  t.after(async () => {
    sessions.forEach(session => session.dispose()); clients.forEach(client => client.disconnect());
    await hub.stop();
    fs.rmSync(roomDirectory, { recursive: true, force: true });
  });
  await hub.start(0);
  const room = await hub.createRoom("Peer Pipeline", "synthetic-room-secret");
  const wait = async predicate => {
    const end = Date.now() + 10000;
    while (Date.now() < end) {
      if (predicate()) return;
      await new Promise(resolve => setTimeout(resolve, 10));
    }
    throw new Error(`Peer pipeline timeout: ${errors.join("; ")}`);
  };
  for (let i = 0; i < 2; i++) {
    const client = new ChatClient({ onStatus() {}, onMessage() {}, onHistory() {}, onPresence() {}, onFileComplete() {},
      onPeer: delivery => { void sessions[i].receive(delivery); } });
    clients.push(client);
    sessions.push(new PeerSession({
      roomId:room.roomId, journalDirectory:path.join(fixture.directory, "peer-journal"),
      connected:() => client.isConnected, send:(target, packet) => client.sendPeer(target, packet),
      approvePair:async () => true, approveSwap:async () => true, approveTask:async () => { taskApprovals++; return true; },
      execute:(prompt, signal, id) => provider.executeRemoteTask(prompt, signal, id, fixture.provider.chat.id),
      changed() {}, error:error => errors.push(error.message),
    }));
    client.connect({ url:`ws://127.0.0.1:${hub.port}/Peer`, room:room.room, roomId:room.roomId, token:room.secret,
      user:`Machine${i}`, cid:`peer-machine-${i}`, kind:"human", ...(i === 0 ? { hostToken:room.hostToken } : {}) });
    await wait(() => client.isConnected);
  }
  sessions[0].pair(clients[1].participantId, sessions[1].invite());
  await wait(() => sessions[0].binding);
  const id = sessions[0].submit("Run the synthetic local process and report its exact stdout.");
  await wait(() => ["completed", "failed"].includes(sessions[0].receipts.get(id)?.state));
  const receipt = sessions[0].receipts.get(id);
  assert.equal(receipt.state, "completed", JSON.stringify(receipt));
  assert.equal(receipt.result.chatId, fixture.provider.chat.id, "Remote execution stays in the bound Chat");
  assert.match(receipt.result.content, /PEER_REAL_EXECUTION/);
  assert.equal(taskApprovals, 1); assert.equal(toolApprovals, 2, "Bound remote Chat approves retrieval separately from the process");
  const saved = provider.store.load(receipt.result.chatId, false);
  assert.equal(saved.permissionMode, "ask"); assert.deepEqual(saved.permissionGrants, []);
  assert.equal(saved.messages.at(-1).toolCalls[0].status, "complete");
  assert.match(saved.messages.at(-1).toolCalls[0].result, /PEER_REAL_EXECUTION/);
  sessions[0].submit("Run the synthetic local process and report its exact stdout.", id);
  await new Promise(resolve => setTimeout(resolve, 80));
  assert.equal(taskApprovals, 1); assert.equal(toolApprovals, 2);
  assert.equal(fixture.requests.length, 2, "Duplicate packet does not call the model or process again");
  assert.deepEqual(errors, []);
});

function processWorkspace(t, fixture) {
  const previousFolders = host.workspace.workspaceFolders, previousUri = host.Uri;
  const filestore = require("../dist/knowledge/filestore"), previousStore = filestore.getStorePath();
  const uri = file => ({ fsPath:file, scheme:"file", toString:() => require("node:url").pathToFileURL(file).toString() });
  host.Uri = { file:uri };
  host.workspace.workspaceFolders = [{ uri:uri(fixture.directory) }];
  filestore.setStorePath(fixture.directory);
  t.after(() => {
    host.workspace.workspaceFolders = previousFolders; host.Uri = previousUri;
    filestore.setStorePath(previousStore);
  });
  fixture.provider.captureExecution = chat => captureExecutionContext(fixture.provider.executionHostId,
    host.workspace.workspaceFolders, fixture.directory, true, chat.permissionMode);
}

test("failed foreground tool dispatch has its own terminal accounting without turning the answer into a tool success", async t => {
  const fixture = await transportFixture(t, fixtures.conversation({
    permissionMode: "allow-all", builtinTools: ["run_process"], vscodeTools: [],
  }), { tools: true, respond: (_payload, round) => round === 0 ? { tool_calls: [{
    index: 0, id: "invalid-program", type: "function", function: { name: "run_process", arguments: '{"program":""}' },
  }] } : { content: "The requested program was invalid; nothing was launched." } });
  processWorkspace(t, fixture);
  await fixture.provider.send("Try the invalid program and report its actual failure.");
  const reply = fixture.provider.store.load(fixture.provider.chat.id, false).messages.at(-1);
  assert.equal(reply.status, "complete", reply.error);
  assert.equal(reply.toolCalls[0].status, "failed", reply.toolCalls[0].result);
  const invocation = reply.invocationBudgets.find(item => item.id === "tool:invalid-program");
  assert.equal(invocation.status, "failed");
  assert.equal(invocation.userWaitMs, 0);
  assert.match(invocation.detail, /program/i);
  assert(invocation.finishedAt >= invocation.startedAt);
});

test("cancelling a pending tool approval freezes invocation clocks and never claims confirmed process termination", async t => {
  const fixture = await transportFixture(t, fixtures.conversation({
    permissionMode: "allow-all", builtinTools: ["run_process"], vscodeTools: [],
  }), { tools: true, respond: () => ({ tool_calls: [{
    index: 0, id: "cancelled-approval", type: "function", function: { name: "run_process", arguments: JSON.stringify({
      program: process.execPath, arguments: ["-e", "require('fs').writeFileSync('must-not-launch','unexpected')"],
      background: true, timeoutSeconds: 5, idempotency_key: "cancel-before-launch",
    }) },
  }] }) });
  processWorkspace(t, fixture);
  const sending = fixture.provider.send("Wait for approval before launching the process.");
  for (let index = 0; index < 300 && !fixture.provider.approvals.size; index++) await new Promise(resolve => setTimeout(resolve, 10));
  assert.equal(fixture.provider.approvals.size, 1);
  const running = fixture.provider.store.load(fixture.provider.chat.id, false).messages.at(-1);
  assert.equal(running.invocationBudgets.find(item => item.id === "tool:cancelled-approval").status, "running");
  await new Promise(resolve => setTimeout(resolve, 80));
  fixture.provider.running.get(fixture.provider.chat.id).abort();
  await sending;
  const reply = fixture.provider.store.load(fixture.provider.chat.id, false).messages.at(-1);
  assert.equal(reply.status, "cancelled");
  const invocation = reply.invocationBudgets.find(item => item.id === "tool:cancelled-approval");
  assert.equal(invocation.status, "cancelled");
  assert(invocation.userWaitMs >= 70, JSON.stringify(invocation));
  assert.equal(invocation.elapsedMs, invocation.activeMs + invocation.userWaitMs);
  assert.match(invocation.detail, /termination is not confirmed/);
  assert.equal(fixture.requests.length, 1);
  assert.equal(fs.existsSync(path.join(fixture.directory, "must-not-launch")), false);
  assert.equal(fixture.provider.approvals.size, 0);
});

test("offline new Chat workflow: explicit durable approval, real background command, original-handle status/output and persisted model evidence", async t => {
  let handle;
  const call = (name, args, round) => ({ tool_calls: [{
    index: 0, id: `durable-call-${round}`, type: "function", function: { name, arguments: JSON.stringify(args) },
  }] });
  const fixture = await transportFixture(t, fixtures.conversation({
    permissionMode: "allow-all", builtinTools: ["run_process", "process_get", "process_output"], vscodeTools: [],
  }), { tools: true, respond: async (payload, round) => {
    if (round === 0) return call("run_process", {
      program: process.execPath, arguments: ["-e", "require('fs').appendFileSync('durable-effect','once');setTimeout(()=>console.log('OFFLINE_DURABLE_ACCEPTANCE_OK'),100)"],
      background: true, timeoutSeconds: 5, idempotency_key: "offline-acceptance",
    }, round);
    const evidence = JSON.parse(payload.messages.filter(message => message.role === "tool").at(-1).content);
    if (round === 1) {
      handle = evidence.handle;
      assert.match(handle, /^process_[a-f0-9]{64}$/);
      const runtime = require("../dist/chat/chat-process-runtime");
      const directory = path.join(fixture.directory, ".pkm", "state", "api-chat-tool-results", fixture.provider.chat.id);
      for (let index = 0; index < 200 && ["launching", "running"].includes(runtime.getChatProcess(directory, handle).state); index++)
        await new Promise(resolve => setTimeout(resolve, 10));
      return call("process_get", { handle }, round);
    }
    if (round === 2) {
      assert.equal(evidence.handle, handle);
      assert.equal(evidence.state, "complete");
      assert.equal(evidence.exitCode, 0);
      return call("process_output", { handle, stream: "stdout", start: 0, length: 1000 }, round);
    }
    assert.equal(evidence.text, "OFFLINE_DURABLE_ACCEPTANCE_OK\n");
    return { content: "Verified the original background execution and its output; task acceptance is based on that evidence." };
  } });
  processWorkspace(t, fixture);
  const sending = fixture.provider.send("Run the isolated durable process once, verify the original handle and read its output.");
  for (let index = 0; index < 300 && !fixture.provider.approvals.size; index++) await new Promise(resolve => setTimeout(resolve, 10));
  assert.equal(fixture.provider.approvals.size, 1, "Allow All cannot auto-approve a durable lifetime");
  const [id, approval] = [...fixture.provider.approvals.entries()][0];
  assert.equal(approval.once, true);
  assert.match(approval.detail, /continues after window reload\. Chat Stop or process_cancel with the original handle cancels it/);
  await new Promise(resolve => setTimeout(resolve, 80));
  await fixture.provider.handle({ type: "approval", id, value: "approve" });
  await sending;
  const reply = fixture.provider.chat.messages.at(-1);
  assert.equal(reply.status, "complete", reply.error);
  assert.deepEqual(reply.toolCalls.map(tool => tool.name), ["run_process", "process_get", "process_output"]);
  assert(reply.toolCalls.every(tool => tool.status === "complete"), JSON.stringify(reply.toolCalls));
  assert.equal(fs.readFileSync(path.join(fixture.directory, "durable-effect"), "utf8"), "once");
  assert.equal(fixture.requests.length, 4);
  assertHttpManifests(fixture);
  const restored = fixture.provider.store.load(fixture.provider.chat.id, false).messages.at(-1);
  assert(restored.toolCalls.some(tool => tool.result.includes("OFFLINE_DURABLE_ACCEPTANCE_OK")));
  assert.equal(restored.budgetReceipts.at(-1).ledger.outcome.status, "complete");
  const processLedger = restored.budgetReceipts.flatMap(receipt => receipt.ledger.entries).filter(entry => entry.owner === "process");
  assert(processLedger.some(entry => entry.unit === "bytes" && entry.consumed.value > 0));
  assert(processLedger.some(entry => entry.unit === "milliseconds" && entry.limit.value === 5000));
  assert(restored.budgetReceipts.every(receipt => receipt.ledger.entries.find(entry => entry.id === "worker-quota").consumed.value === 0));
  const invocations = restored.invocationBudgets.filter(item => item.owner === "tool");
  assert.equal(invocations.length, 3, "Model rounds must not duplicate invocation totals");
  assert(invocations.every(item => item.status === "complete"));
  const dispatch = invocations.find(item => item.id === "tool:durable-call-0");
  assert(dispatch.userWaitMs >= 70, `Explicit approval wait must be excluded from active time: ${JSON.stringify(dispatch)}`);
  assert.equal(dispatch.elapsedMs, dispatch.activeMs + dispatch.userWaitMs);
  assert.equal(invocations.find(item => item.id === "tool:durable-call-1").userWaitMs, 0, "A later call must not inherit the previous approval wait");
});

test("real HTTP loop-review decisions retain their attempt owner across transport child signals", async t => {
  const fixture = await transportFixture(t, fixtures.conversation({
    builtinTools:["session_info"], vscodeTools:[],
  }), { tools:true, respond:(_payload, round) => round === 0 ? { tool_calls:[{
    index:0, id:"reviewed-identity", type:"function",
    function:{ name:"session_info", arguments:"{}" },
  }] } : { content:"Answer using the completed evidence only." } });
  const settings = fixture.provider.settings;
  fixture.provider.settings = () => ({ ...settings(), maxToolRounds:1, loopReviewAfterMs:undefined });
  const sending = fixture.provider.send("Read current identity once, then review further execution.");
  for (let index = 0; index < 200 && !fixture.provider.decisions.size; index++)
    await new Promise(resolve => setTimeout(resolve, 5));
  assert.equal(fixture.provider.decisions.size, 1, fixture.provider.chat.messages.at(-1)?.error);
  const [id, decision] = [...fixture.provider.decisions.entries()][0];
  assert.notEqual(decision.signal, fixture.provider.running.get(fixture.provider.chat.id).signal);
  await fixture.provider.handle({ type:"decision", id, value:"summarize" });
  await sending;
  const reply = fixture.provider.chat.messages.at(-1);
  assert.equal(reply.status, "complete", reply.error);
  assert.equal(reply.toolCalls.length, 1);
  assert.equal(reply.toolCalls[0].status, "complete");
  assert.equal(fixture.requests.length, 2);
  assert.equal(fixture.provider.decisions.size, 0);
});

function assertHttpManifests(fixture) {
  const stored = fixture.provider.store.load(fixture.provider.chat.id, false).messages.at(-1);
  assert.equal(stored.budgetReceipts.length, fixture.requests.length);
  for (const [index, payload] of fixture.requests.entries()) {
    const plan = stored.budgetReceipts[index].contextPlan;
    const transport = stored.budgetReceipts[index].transport;
    const timing = stored.budgetReceipts[index].ledger?.inferenceTiming;
    assert.equal(timing?.provider, "http");
    assert.equal(timing.outcome, "stream-ended");
    assert(timing.maxInactivityMs <= timing.elapsedMs);
    assert.equal(transport.provider, "http");
    assert.deepEqual(transport.messageHashes, payload.messages.map(message => createHash("sha256").update(JSON.stringify(message)).digest("hex")));
    assert.equal(transport.toolSchemaHash, createHash("sha256").update(JSON.stringify(payload.tools || [])).digest("hex"));
    assert.equal(transport.inputTokens, 32 + Buffer.byteLength(JSON.stringify([payload.messages, payload.tools || []]), "utf8"));
    assert.equal(plan.manifest.length, payload.messages.length);
    for (const [messageIndex, message] of payload.messages.entries()) {
      const entry = plan.manifest[messageIndex];
      assert.equal(entry.hash, createHash("sha256").update(JSON.stringify(message)).digest("hex"));
      assert.equal(entry.role, message.role);
      assert.deepEqual(entry.callIds, message.tool_calls?.map(call => call.id) || (message.tool_call_id ? [message.tool_call_id] : []));
    }
    const selected = stored.retrievalActivity.rounds[index].receipt.candidates.filter(candidate => candidate.selected).map(candidate => candidate.id).sort();
    assert.deepEqual([...new Set(plan.manifest.flatMap(entry => entry.referenceIds))].filter(id => !id.startsWith("tool:")).sort(), selected);
    assert.equal(plan.estimatedAfter, stored.budgetReceipts[index].consumed.estimatedInputTokens);
    assert(plan.estimatedAfter <= plan.inputBudget);
  }
}

test("CTX-T01: small context uses the real controller, disk store and HTTP transport", async t => {
  const fixture = await transportFixture(t, fixtures.conversation());
  await fixture.provider.send("Small synthetic question");
  const reply = fixture.provider.chat.messages.at(-1);
  assert.equal(reply.status, "complete", reply.error);
  assert.equal(fixture.requests.length, 1);
  assert.equal(fixture.retrievalQueries.length, 1);
  assert.equal(fixture.requests[0].messages.at(-1).content, "Small synthetic question");
  assert.equal(fixture.provider.store.load(fixture.provider.chat.id, false).messages.at(-1).content, "Synthetic response");
  const activity = reply.retrievalActivity;
  assert.equal(activity.attempts.length, 2);
  assert.deepEqual(activity.attempts.map(attempt => attempt.kind), ["memory", "knowledge"]);
  assert.equal(activity.rounds.length, 1);
  assert.equal(activity.rounds[0].index, 0);
  assert.equal(activity.rounds[0].countingMethod, "utf8-byte-estimate");
  assert.deepEqual(activity.rounds[0].receipt, reply.retrieval);
  assert.deepEqual(fixture.provider.store.load(fixture.provider.chat.id, false).messages.at(-1).retrievalActivity, activity);
  assertHttpManifests(fixture);
  assert.deepEqual(fixture.errors, []);
});

test("public explanation and conclusion reuse actual streamed rounds, persist exact ranges and require no summary request", async t => {
  const fixture = await transportFixture(t, fixtures.conversation({ builtinTools:["session_info"], vscodeTools:[] }), {
    tools:true, respond:(_payload, round) => round === 0
      ? { content:"I will inspect the recorded identity.\n", tool_calls:[{ index:0, id:"public-output-call", type:"function", function:{ name:"session_info", arguments:"{}" } }] }
      : { content:"Identity inspected; no other operation was performed." },
  });
  await fixture.provider.send("Inspect identity.");
  const reply = fixture.provider.chat.messages.at(-1);
  assert.equal(reply.status, "complete", reply.error);
  assert.equal(fixture.requests.length, 2, "Only the existing tool and answer requests, never a summary request");
  assert.equal(reply.publicOutputSegments.length, 2);
  assert.equal(reply.publicOutputSegments[0].hasToolCalls, true);
  assert.equal(reply.publicOutputSegments[1].hasToolCalls, undefined);
  assert.deepEqual(reply.publicOutputSegments.map(segment => reply.content.slice(segment.start, segment.end)),
    ["I will inspect the recorded identity.\n", "Identity inspected; no other operation was performed."]);
  assert.deepEqual(fixture.provider.store.load(fixture.provider.chat.id, false).messages.at(-1).publicOutputSegments, reply.publicOutputSegments);
  const snapshot = require("../dist/chat/api-chat-store").apiChatHarnessSnapshot(fixture.provider.chat);
  assert.deepEqual(snapshot.attempts.at(-1).publicOutputs.map(output => output.text),
    reply.publicOutputSegments.map(segment => reply.content.slice(segment.start, segment.end)));
});

test("CTX-M01/M02/M03: actual HTTP refines long automatic knowledge independently of the model window boundary", async t => {
  const body = "# Latency study\n\n" + "Unrelated background. ".repeat(400) + "\n\nlatency must not exceed 125 ms; do not deploy.\n";
  const candidate = { id:"measured-source", level:"l1-source", sourceId:"pkm://fixture/measured",
    sourceRevision:"r1", contentHash:"a".repeat(64), kind:"note", label:"Measured evidence",
    sourceUri:"pkm://fixture/measured", score:1, method:"synthetic:l1", selected:false, reason:"fixture", content:body };
  const question = "What is the latency limit?";
  const baseline = await transportFixture(t, fixtures.conversation(), { candidates:[candidate] });
  await baseline.provider.send(question);
  const before = baseline.provider.chat.messages.at(-1).budgetReceipts[0].contextPlan.estimatedBefore;
  for (const delta of [1, 0, -1]) {
    const fixture = await transportFixture(t, fixtures.conversation(), { candidates:[candidate], contextWindow:before + 1024 + delta });
    await fixture.provider.send(question);
    const reply = fixture.provider.chat.messages.at(-1), plan = reply.budgetReceipts?.[0]?.contextPlan;
    assert.equal(reply.status, "complete", reply.error);
    assert.equal(fixture.requests.length, 1, "No additional answer, compression or summary model calls");
    assert.equal(fixture.retrievalQueries.length, 1);
    assert.equal(plan.estimatedBefore, before);
    assert.equal(plan.inputBudget, before + delta);
    assert.equal(plan.refinements, 1);
    assert(plan.estimatedAfter <= plan.inputBudget);
    assert(plan.automaticKnowledge.estimatedAfter <= 8000);
    const transmitted = text(fixture.requests[0].messages);
    assert(!transmitted.includes("Unrelated background."));
    assert(transmitted.includes("latency must not exceed 125 ms; do not deploy."));
    assert(reply.retrieval.candidates.some(item => item.selected && item.level === "l2-passage"));
    assertHttpManifests(fixture);
    assert.deepEqual(fixture.errors, []);
  }
  assert.equal(candidate.content, body);
});

test("CTX-M07/M08: unavailable deterministic paths send no rewritten evidence and never make an LLM fallback request", async t => {
  for (const [kind, content, warning] of [
    ["script", "opaque NOT approved ".repeat(500), /not truncated|not rewritten|exceed/i],
    ["note", '{"records":[invalid opaque ' + "x".repeat(10000), /invalid JSON/i],
  ]) {
    const candidate = { id:`unavailable-${kind}`, level:"l1-source", sourceId:`pkm://fixture/${kind}`,
      sourceRevision:"r1", contentHash:"b".repeat(64), kind, label:"Unrecognized evidence",
      sourceUri:`pkm://fixture/${kind}`, score:1, method:"synthetic:l1", selected:false, reason:"fixture", content };
    const fixture = await transportFixture(t, fixtures.conversation(), { candidates:[candidate], contextWindow:4096 });
    const question = "Inspect opaque evidence; do not execute or infer approval.";
    await fixture.provider.send(question);
    const reply = fixture.provider.chat.messages.at(-1), plan = reply.budgetReceipts[0].contextPlan;
    assert.equal(reply.status, "complete", reply.error);
    assert.equal(fixture.requests.length, 1, "No extra fallback, rewrite or summary model request");
    assert.equal(fixture.retrievalQueries.length, 1);
    assert.equal(plan.refinements, 1);
    assert.equal(plan.stopReason, "no-progress");
    assert(plan.unresolved.includes(candidate.id));
    assert.equal(reply.retrieval.selectedCount, 0);
    assert.match(reply.retrieval.warning, warning);
    assert.equal(fixture.requests[0].messages.at(-1).content, question);
    assert(!text(fixture.requests[0].messages).includes("Automatically retrieved PKM references"));
    assert.equal(candidate.content, content, "Original content is neither shortened nor rewritten");
    assertHttpManifests(fixture);
  }
});

test("CTX-M05: real HTTP stops at the refinement attempt boundary and reports remaining evidence without another retrieval", async t => {
  const candidates = Array.from({ length:12 }, (_, index) => ({
    id:`bounded-source-${index}`, level:"l1-source", sourceId:`pkm://fixture/bounded-${index}`, sourceRevision:"r1",
    contentHash:String(index % 10).repeat(64), kind:"note", label:`Source ${index}`, sourceUri:`pkm://fixture/bounded-${index}`,
    score:12 - index, method:"fixture", selected:false, reason:"fixture",
    content:"# Measurements\n\n" + "Background.\n\n".repeat(2000) + `latency is 125 ms for entity-${index}.\n`,
  }));
  const fixture = await transportFixture(t, fixtures.conversation(), { candidates, contextWindow:16384 });
  await fixture.provider.send("What is the latency?");
  const reply = fixture.provider.chat.messages.at(-1), plan = reply.budgetReceipts[0].contextPlan;
  assert.equal(reply.status, "complete", reply.error);
  assert.equal(plan.refinements, 8);
  assert.equal(plan.stopReason, "refinement-limit");
  assert.equal(fixture.requests.length, 1);
  assert.equal(fixture.retrievalQueries.length, 1);
  assert.deepEqual(plan.unresolved.filter(id => id.startsWith("bounded-source-")), candidates.slice(8).map(item => item.id));
  assertHttpManifests(fixture);
});

test("CTX-M06/M10: real HTTP contains table entities with original units and shared-condition ranges", async t => {
  const body = "# Benchmark\n\nCPU-only; NOT approved.\n\n## Conditions\n\nConcurrency=32; version=v2; never deploy.\n\n## Results\n\n" +
    "| Entity | Latency (ms) |\n| --- | --- |\n" +
    Array.from({ length:220 }, (_, index) => `| ${index === 200 ? "docker-beta" : `other-${index}`} | 125 |\n`).join("");
  const candidate = { id:"table-source", level:"l1-source", sourceId:"pkm://fixture/table", sourceRevision:"r1", contentHash:"d".repeat(64),
    kind:"note", label:"Table", sourceUri:"pkm://fixture/table", score:1, method:"fixture", selected:false, reason:"fixture", content:body };
  const fixture = await transportFixture(t, fixtures.conversation(), { candidates:[candidate], contextWindow:4096 });
  await fixture.provider.send("What is the docker-beta latency?");
  const reply = fixture.provider.chat.messages.at(-1), transmitted = text(fixture.requests[0].messages);
  assert.equal(reply.status, "complete", reply.error);
  for (const evidence of ["| docker-beta | 125 |", "Latency (ms)", "Concurrency=32; version=v2; never deploy.", "CPU-only; NOT approved."]) assert(transmitted.includes(evidence), evidence);
  const selected = reply.retrieval.candidates.filter(item => item.selected);
  assert(selected.length >= 4);
  for (const item of selected) {
    assert.equal(item.parentId, candidate.id);
    assert.equal(item.parentRevision, candidate.sourceRevision);
    assert.equal(item.contentHash, createHash("sha256").update(body.slice(item.range.start, item.range.end)).digest("hex"));
    assert(transmitted.includes(body.slice(item.range.start, item.range.end)));
  }
  assert.equal(fixture.requests.length, 1);
  assertHttpManifests(fixture);
});

test("CTX-M05: accumulated knowledge candidates stop atomically at the boundary without failing the answer", async t => {
  const candidates = Array.from({ length:8 }, (_, index) => ({
    id:`candidate-boundary-${index}`, level:"l1-source", sourceId:`pkm://fixture/candidate-boundary-${index}`,
    sourceRevision:"r1", contentHash:String(index).repeat(64), kind:"note", label:`Table ${index}`,
    sourceUri:`pkm://fixture/candidate-boundary-${index}`, score:8 - index, method:"fixture", selected:false, reason:"fixture",
    content:`# Results ${index}\n\n| Entity | Latency (ms) |\n| --- | --- |\n` +
      Array.from({ length:1500 }, (_, row) => `| entity-${index}-${row} | 125 |\n`).join(""),
  }));
  const fixture = await transportFixture(t, fixtures.conversation(), { candidates, contextWindow:16384 });
  await fixture.provider.send("Inspect entity latency.");
  const reply = fixture.provider.chat.messages.at(-1), plan = reply.budgetReceipts[0].contextPlan;
  assert.equal(reply.status, "complete", reply.error);
  assert.equal(plan.stopReason, "candidate-limit");
  assert(plan.refinements < 8);
  assert(reply.retrieval.candidates.length <= 100);
  assert(plan.unresolved.some(id => id.startsWith("candidate-boundary-")));
  assert.match(reply.retrieval.warning, /100-candidate boundary/);
  assert.equal(fixture.retrievalQueries.length, 1);
  assert.equal(fixture.requests.length, 1);
  assertHttpManifests(fixture);
});

test("CTX-T02: an empty knowledge result adds no reference context", async t => {
  const fixture = await transportFixture(t, fixtures.conversation());
  await fixture.provider.send("Small synthetic question");
  assert.equal(fixture.requests.length, 1);
  assert(!text(fixture.requests[0].messages).includes("Automatically retrieved PKM references"));
  assert.equal(fixture.provider.chat.messages.at(-1).retrieval.selectedCount, 0);
  const invocations = fixture.provider.chat.messages.at(-1).invocationBudgets;
  assert.equal(invocations.length, 2);
  assert(invocations.every(item => item.status === "complete" && item.owner === "retrieval"));
  assert.equal(invocations.find(item => item.id === "retrieval:chat-memory").deadlineMs, undefined);
  assert.equal(invocations.find(item => item.id === "retrieval:knowledge-provider").deadlineMs.value, 5000);
});

test("CTX-T04: retrieval failure is isolated from the primary Chat request", async t => {
  const fixture = await transportFixture(t, fixtures.conversation(), {
    retrievalError: new Error("synthetic retrieval model failure"),
  });
  await fixture.provider.send("Continue without automatic references");
  const reply = fixture.provider.chat.messages.at(-1);
  assert.equal(reply.status, "complete", reply.error);
  assert.equal(fixture.requests.length, 1);
  assert(!text(fixture.requests[0].messages).includes("Automatically retrieved PKM references"));
  assert.match(reply.retrieval.warning, /retrieval unavailable/i);
  const invocation = reply.invocationBudgets.find(item => item.id === "retrieval:knowledge-provider");
  assert.equal(invocation.status, "unavailable", "An answer without retrieval must not mark retrieval successful");
  assert.match(invocation.detail, /synthetic retrieval model failure/);
  assert.deepEqual(fixture.errors, []);
});
  test("CTX-T05: malformed retrieval is rejected while a valid candidate still reaches HTTP", async t => {
    const candidate = {
      id: "valid-evidence", kind: "note", label: "Valid reference", sourceUri: "pkm://fixture/valid",
      score: 1, method: "synthetic:test", selected: true, reason: "fixture", content: "VALID_EXTERNAL_EVIDENCE",
    };
    const fixture = await transportFixture(t, fixtures.conversation(), {
      candidates: [null, { ...candidate, id: "invalid-score", score: NaN }, { ...candidate, id: "invalid-range", range: null }, candidate],
    });
    await fixture.provider.send("Continue with validated references only");
    const reply = fixture.provider.chat.messages.at(-1);
    assert.equal(reply.status, "complete", reply.error);
    assert.equal(fixture.requests.length, 1);
    assert(text(fixture.requests[0].messages).includes(candidate.content));
    assert.equal(reply.retrieval.selectedCount, 1);
    assert.match(reply.retrieval.warning, /degraded/i);
    assert.equal(reply.invocationBudgets.find(item => item.id === "retrieval:knowledge-provider").status, "degraded");
  });

  test("CTX-T06: an unresponsive retriever times out without blocking the primary answer", async t => {
    const fixture = await transportFixture(t, fixtures.conversation(), { retrievalHang: true });
    const started = Date.now();
    await fixture.provider.send("Answer without stalled retrieval");
    const reply = fixture.provider.chat.messages.at(-1);
    assert.equal(reply.status, "complete", reply.error);
    assert.equal(fixture.requests.length, 1);
    assert.match(reply.retrieval.warning, /deadline/i);
    const invocation = reply.invocationBudgets.find(item => item.id === "retrieval:knowledge-provider");
    assert.equal(invocation.status, "unavailable");
    assert.equal(invocation.deadlineMs.value, 5000);
    assert(invocation.elapsedMs >= 4900 && invocation.elapsedMs < 8000, JSON.stringify(invocation));
    assert.equal(invocation.userWaitMs, 0);
    assert(Date.now() - started < 8000, "Five-second retrieval deadline must bound dispatch delay");
  });

  test("CTX-T07: cancelling an unresponsive retriever promptly cancels Chat without model dispatch", async t => {
    const fixture = await transportFixture(t, fixtures.conversation(), { retrievalHang: true });
    const send = fixture.provider.send("Cancel stalled retrieval");
    const deadline = Date.now() + 2000;
    while (!fixture.retrievalQueries.length && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 5));
    assert.equal(fixture.retrievalQueries.length, 1);
    const started = Date.now();
    fixture.provider.running.get(fixture.provider.chat.id).abort();
    await send;
    assert(Date.now() - started < 1000);
    assert.equal(fixture.provider.chat.messages.at(-1).status, "cancelled");
    const reply = fixture.provider.store.load(fixture.provider.chat.id, false).messages.at(-1);
    const invocation = reply.invocationBudgets.find(item => item.id === "retrieval:knowledge-provider");
    assert.equal(invocation.status, "cancelled");
    assert(invocation.finishedAt >= invocation.startedAt);
    assert.equal(reply.budgetReceipts, undefined, "Cancelled retrieval has evidence even before a model round exists");
    assert.equal(fixture.requests.length, 0);
  });

  test("CTX-T08: receipt selection matches budgeted HTTP context; oversized sources are not cut", async t => {
    const candidates = Array.from({ length: 3 }, (_, index) => ({
      id: `reference-${index}`, kind: "note", label: `Reference ${index}`, sourceUri: `pkm://fixture/reference-${index}`,
      score: 10 - index, method: "synthetic:test", selected: true, reason: "fixture",
      content: `REFERENCE_${index}:` + "x".repeat(index === 2 ? 5000 : 3500),
    }));
    const fixture = await transportFixture(t, fixtures.largeToolHistory(), { contextWindow: 8192, candidates });
    await fixture.provider.send("docker-beta QPS concurrency=32 version=v2");
    const reply = fixture.provider.chat.messages.at(-1);
    assert.equal(reply.status, "complete", reply.error);
    const transmitted = text(fixture.requests[0].messages);
    assert(transmitted.includes(fixtures.evidence.beta));
    assert(!transmitted.includes("REFERENCE_2:"));
    const sourceSegments = new Map(chatMemorySegments(fixture.provider.chat).map(segment => [segment.id, segment]));
    for (const candidate of reply.retrieval.candidates) {
      assert.equal(candidate.selected, candidate.kind === "memory" ? transmitted.includes(sourceSegments.get(candidate.id).content) : transmitted.includes(candidate.sourceUri));
    }
    assert.equal(reply.retrieval.selectedCount, reply.retrieval.candidates.filter(candidate => candidate.selected).length);
    assert.match(reply.retrieval.candidates.find(candidate => candidate.id === "reference-2").reason, /L2/);
    assert.equal(candidates[0].reason, "fixture", "Provider-owned candidates must not be mutated");
    validateBudget(profile, 8192, 1024, fixture.requests[0].messages);
  });
test("CTX-T09: real HTTP receives verified tail passages and heading context, not a source prefix", async t => {
  const body = "# Experiment\n\n" + "Unrelated background.\n\n".repeat(300) + "latency must not exceed 125 ms; do not deploy.\n";
  const source = { id:"tail-source", level:"l1-source", sourceId:"pkm://notes/tail", sourceRevision:"r1", contentHash:"a".repeat(64),
    kind:"note", label:"Experiment", sourceUri:"pkm://notes/tail", score:1, method:"synthetic:l1", selected:false, reason:"fixture", content:body };
  const fixture = await transportFixture(t, fixtures.conversation(), { candidates:[source], contextWindow:4096 });
  await fixture.provider.send("What is the latency limit?");
  const reply = fixture.provider.chat.messages.at(-1);
  assert.equal(reply.status, "complete", reply.error);
  const transmitted = text(fixture.requests[0].messages);
  assert(transmitted.includes("latency must not exceed 125 ms; do not deploy."));
  assert(transmitted.includes("# Experiment"));
  assert(!transmitted.includes("Unrelated background."));
  const passage = reply.retrieval.candidates.find(candidate => candidate.level === "l2-passage" && candidate.range.start > 4000 && candidate.selected);
  assert(passage);
  assert.equal(body.slice(passage.range.start, passage.range.end), "latency must not exceed 125 ms; do not deploy.\n");
  assert(passage.contextIds.every(id => reply.retrieval.candidates.some(candidate => candidate.id === id && candidate.selected)));
  assert.equal(reply.retrieval.selectedCount, reply.retrieval.candidates.filter(candidate => candidate.selected).length);
  assert.deepEqual(fixture.provider.store.load(fixture.provider.chat.id, false).messages.at(-1).retrieval, reply.retrieval);
  assert.equal(source.content, body);
  assertHttpManifests(fixture);
  assert.deepEqual(fixture.errors, []);
});

test("CTX-M09/M14: actual multi-round HTTP excludes revoked source projections and persists matching sent manifests", async t => {
  let current = true, validations = 0;
  const candidate = { id:"revoked-source", kind:"note", label:"Private fixture", sourceUri:"pkm://fixture/private",
    score:1, method:"synthetic:test", selected:true, reason:"fixture", content:"PRIVATE_REVOKED_BODY" };
  const fixture = await transportFixture(t, fixtures.conversation({ builtinTools:["session_info"], vscodeTools:[] }), {
    tools:true, candidates:[candidate], sourceIsCurrent:() => current,
    refreshSourceValidation:() => { validations++; },
    respond:(_payload, round) => {
      if (round === 0) {
        current = false;
        return { tool_calls:[{ index:0, id:"identity-round", type:"function", function:{ name:"session_info", arguments:"{}" } }] };
      }
      return { content:"Synthetic response" };
    },
  });
  await fixture.provider.send("Inspect identity without running anything else.");
  const reply = fixture.provider.chat.messages.at(-1);
  assert.equal(reply.status, "complete", reply.error);
  assert.equal(fixture.requests.length, 2);
  assert.equal(fixture.retrievalQueries.length, 1, "Revalidation does not repeat L1 search");
  assert.equal(validations, 2);
  assert(text(fixture.requests[0].messages).includes(candidate.content));
  assert(!text(fixture.requests[1].messages).includes(candidate.content));
  assert.equal(reply.budgetReceipts[1].contextPlan.stopReason, "stale-source");
  assert.deepEqual(reply.budgetReceipts[1].contextPlan.unresolved, [candidate.id]);
  assert.equal(reply.retrieval.candidates.find(item => item.id === candidate.id).selected, false);
  assertHttpManifests(fixture);
  assert.deepEqual(fixture.errors, []);
});

test("CTX-M09/M10: production source validation excludes cached L2 after revision, privacy, content or deletion changes", async t => {
  const { retrievalSourceValidation, retrievalDocumentContentHash } = require("../dist/retrieval/retrieval-snapshot");
  for (const change of ["revision", "private", "body", "delete"]) {
    const body = "# Experiment\n\n" + "Background.\n\n".repeat(500) + "latency must not exceed 125 ms.\n";
    const document = { skill_id:"source", source_id:"pkm://fixture/source", source_uri:"pkm://fixture/source",
      source_revision:"r1", visibility:"available", content_type:"note", title:"Source", description:"",
      metadata:{}, provenance:{}, read_only:false, links:[], body };
    const candidate = { id:"source", level:"l1-source", sourceId:document.source_id, sourceRevision:"r1", contentHash:retrievalDocumentContentHash(document),
      kind:"note", label:"Source", sourceUri:document.source_id, score:1, method:"fixture", selected:false, reason:"fixture", content:body };
    let snapshot = { documents:[document] };
    const validation = retrievalSourceValidation(() => snapshot);
    validation.admit(candidate, document);
    const fixture = await transportFixture(t, fixtures.conversation({ builtinTools:["session_info"], vscodeTools:[] }), {
      tools:true, candidates:[candidate], contextWindow:8192, ...validation,
      respond:(_payload, round) => {
        if (round) return { content:"Unavailable old evidence is not a new fact." };
        snapshot = { documents:change === "delete" ? [] : [{ ...document,
          ...(change === "revision" ? { source_revision:"r2" } : change === "private" ? { visibility:"private" } : { body:body + "changed" }) }] };
        return { tool_calls:[{ index:0, id:`source-${change}`, type:"function", function:{ name:"session_info", arguments:"{}" } }] };
      },
    });
    await fixture.provider.send("What is the latency limit?");
    const reply = fixture.provider.store.load(fixture.provider.chat.id, false).messages.at(-1);
    assert.equal(reply.status, "complete", reply.error);
    assert(text(fixture.requests[0].messages).includes("latency must not exceed 125 ms."));
    assert(reply.retrievalActivity.rounds[0].receipt.candidates.some(item => item.level === "l2-passage" && item.selected));
    assert(!text(fixture.requests[1].messages).includes("latency must not exceed 125 ms."));
    assert.equal(reply.budgetReceipts[1].contextPlan.stopReason, "stale-source");
    assert(reply.retrieval.candidates.filter(item => item.level === "l2-passage").every(item => !item.selected));
    assert.equal(fixture.retrievalQueries.length, 1);
    assertHttpManifests(fixture);
  }
});

test("CTX-M12: real HTTP steering is persisted once, or remains queued when the prepared plan cannot commit", async t => {
  for (const fail of [true, false]) {
    const id = require("node:crypto").randomUUID(), instruction = "Use revised units; never deploy.";
    let fixture, failed = false;
    fixture = await transportFixture(t, fixtures.conversation({ builtinTools:["session_info"], vscodeTools:[] }), {
      tools:true, respond:async (_payload, round) => {
        if (!round) await fixture.provider.handle({ type:"send", text:instruction, mode:"steer", submissionId:id });
        return round < 2 ? { tool_calls:[{ index:0, id:`steer-${round}`, type:"function", function:{ name:"session_info", arguments:"{}" } }] }
          : { content:"Revised instruction accepted." };
      },
    });
    const persist = fixture.provider.persist.bind(fixture.provider);
    fixture.provider.persist = chat => {
      if (fail && !failed && chat.messages.at(-1)?.budgetReceipts?.length === 2) {
        failed = true;
        throw new Error("CTX fixture: prepared steering save failed");
      }
      return persist(chat);
    };
    await fixture.provider.send("Inspect identity.");
    const chat = fixture.provider.store.load(fixture.provider.chat.id, false), reply = chat.messages.at(-1);
    assert.equal(reply.status, fail ? "failed" : "complete", reply.error);
    assert.equal(chat.messages.filter(message => message.submissionId === id).length, fail ? 0 : 1);
    assert.equal(chat.queuedInputs.length, fail ? 1 : 0);
    assert.equal(fixture.requests.length, fail ? 1 : 3, "A failed commit must not dispatch the next inference");
    if (fail) {
      assert.match(reply.error, /prepared steering save failed/);
      assert.equal(chat.queuedInputs[0].id, id);
      assert.equal(chat.queuedInputs[0].text, instruction);
      assert.equal(reply.budgetReceipts.length, 1);
      assert.equal(reply.retrievalActivity.rounds.length, 1);
    } else {
      for (const payload of fixture.requests.slice(1)) assert.equal(payload.messages.filter(message => message.content === instruction).length, 1);
    }
    assertHttpManifests(fixture);
  }
});

test("native VS Code debug completion uses the same bounded execution gate and counts tokens as INFO", async t => {
  class TextPart { constructor(value) { this.value = value; } }
  class CallPart { constructor(callId, name, input) { Object.assign(this, { callId, name, input }); } }
  class ResultPart { constructor(callId, content) { Object.assign(this, { callId, content }); } }
  const previous = { ...host }, prompts = [];
  const model = { id:"native-debug", vendor:"fixture", name:"Native debug", maxInputTokens:262144,
    capabilities:{ toolCalling:true }, countTokens:async () => 100,
    sendRequest:async (messages, options) => {
      prompts.push({ messages, options });
      return { stream:(async function* () {
        if (prompts.length === 1) yield new TextPart("Please paste the logs.");
        else if (prompts.length === 2) yield new CallPart("native-debug-process", "run_process",
          { program:process.execPath, arguments:["-e", "process.stdout.write('NATIVE_DEBUG_ACTUAL_DIAGNOSTIC')"] });
        else if (prompts.length === 3) yield new CallPart("native-debug-finish", "report_work",
          workOutcome(fixture.provider.chat, "resolved", "Executed the requested local diagnostic; the user did not request a repair.", ["native-debug-process"]));
        else yield new TextPart("The actual local diagnostic completed.");
      })() };
    },
  };
  Object.assign(host, { lm:{ tools:[], selectChatModels:async () => [model] },
    LanguageModelTextPart:TextPart, LanguageModelToolCallPart:CallPart, LanguageModelToolResultPart:ResultPart,
    LanguageModelChatMessage:{ User:content => ({ role:1, content }), Assistant:content => ({ role:2, content }) },
    CancellationTokenSource:class { token = {}; cancel() {} dispose() {} },
  });
  t.after(() => { for (const key of Object.keys(host)) delete host[key]; Object.assign(host, previous); });
  const fixture = await transportFixture(t, fixtures.conversation({
    builtinTools:["run_process"], vscodeTools:[], permissionMode:"allow-all",
  }), { tools:true, nativeModel:model });
  processWorkspace(t, fixture);
  await fixture.provider.send("Debug this local diagnostic, without modifying anything.");
  const reply = fixture.provider.chat.messages.at(-1);
  assert.equal(reply.status, "complete", reply.error);
  assert.equal(prompts.length, 4);
  assert.equal(fixture.requests.length, 0);
  assert.equal(JSON.parse(reply.toolCalls[0].result).stdout, "NATIVE_DEBUG_ACTUAL_DIAGNOSTIC");
  assert.equal(fixture.provider.chat.debugRequest.status, "completed");
  const counts = reply.progress.steps.filter(step => step.operation === "token-count");
  assert.equal(counts.length, 0, "a fitting UTF-8 byte bound needs no tokenizer call");
  assert(counts.every(step => step.category === "info"), "local tokenizer work is never a model inference activity");
});

test("CTX-M14: native transformed prompts, Profiles and schemas match persisted transport hashes and tokenizer accounting", async t => {
  class TextPart { constructor(value) { this.value = value; } }
  class CallPart { constructor(callId, name, input) { Object.assign(this, { callId, name, input }); } }
  class ResultPart { constructor(callId, content) { Object.assign(this, { callId, content }); } }
  const previous = { ...host }, prompts = [], counts = [];
  const digest = value => createHash("sha256").update(JSON.stringify(value)).digest("hex");
  const model = { id:"native-envelope", vendor:"fixture", name:"Native envelope", maxInputTokens:262144,
    capabilities:{ toolCalling:true },
    countTokens:async input => { counts.push(input); return Buffer.byteLength(typeof input === "string" ? input : JSON.stringify(input), "utf8"); },
    sendRequest:async (messages, options) => {
      prompts.push({ messages, options });
      return { stream:(async function* () {
        if (prompts.length === 1) yield new CallPart("native-evidence", "run_process", {
          program:process.execPath, arguments:["-e", "process.stdout.write('CTX_NATIVE_PERMISSION_OK')"],
        });
        else yield new TextPart("Original native response; no summary call.");
      })() };
    },
  };
  Object.assign(host, { lm:{ tools:[], selectChatModels:async () => [model] },
    LanguageModelTextPart:TextPart, LanguageModelToolCallPart:CallPart, LanguageModelToolResultPart:ResultPart,
    LanguageModelChatMessage:{ User:content => ({ role:1, content }), Assistant:content => ({ role:2, content }) },
    CancellationTokenSource:class { token = {}; cancel() {} dispose() {} },
  });
  t.after(() => { for (const key of Object.keys(host)) delete host[key]; Object.assign(host, previous); });
  const fixture = await transportFixture(t, fixtures.conversation({
    builtinTools:["run_process"], vscodeTools:[], permissionMode:"allow-all",
  }), { tools:true, nativeModel:model });
  processWorkspace(t, fixture);
  const { PersonaProfileStore } = require("../dist/chat/persona-profiles");
  const profiles = new PersonaProfileStore(path.join(fixture.directory, "private-host"), require("../dist/knowledge/filestore").getStorePath());
  profiles.save("user", { name:"Native user", role:"", focus:"", preferences:"NATIVE_PROFILE_REQUIRED_CONTEXT", boundaries:"" });
  await fixture.provider.send("Run the native local process probe.");
  const stored = fixture.provider.store.load(fixture.provider.chat.id, false).messages.at(-1);
  assert.equal(stored.status, "complete", stored.error);
  assert.equal(stored.toolCalls[0].status, "complete", stored.toolCalls[0].result);
  const invocation = stored.invocationBudgets.find(item => item.id === "tool:native-evidence");
  assert.equal(invocation.status, "complete");
  assert.equal(invocation.userWaitMs, 0);
  assert.equal(stored.invocationBudgets.filter(item => item.owner === "tool").length, 1);
  const processResult = JSON.parse(stored.toolCalls[0].result);
  assert.equal(processResult.exitCode, 0);
  assert.equal(processResult.stdout, "CTX_NATIVE_PERMISSION_OK");
  assert.equal(fs.readFileSync(processResult.stdoutLog, "utf8"), processResult.stdout);
  assert.equal(prompts.length, 2);
  assert.equal(fixture.requests.length, 0);
  assert.equal(stored.budgetReceipts.length, 2);
  for (const [index, prompt] of prompts.entries()) {
    const receipt = stored.budgetReceipts[index];
    assert(JSON.stringify(prompt.messages).includes("NATIVE_PROFILE_REQUIRED_CONTEXT"));
    assert(receipt.contextPlan.manifest.some(item => item.hash === stored.profileContext.messageHash));
    assert.equal(receipt.transport.provider, "vscode");
    assert.equal(receipt.transport.countingMethod, "utf8-byte-upper-bound");
    assert.deepEqual(receipt.transport.messageHashes, prompt.messages.map(digest));
    assert.equal(receipt.transport.toolSchemaHash, digest(prompt.options.tools));
    const expected = 32 + prompt.messages.reduce((total, message) => total + Buffer.byteLength(JSON.stringify(message), "utf8") + 32, 0)
      + Buffer.byteLength(JSON.stringify(prompt.options.tools), "utf8") + 32;
    assert.equal(receipt.transport.inputTokens, expected);
    assert(prompt.messages.some(message => message.content[0].value.startsWith("[PKM instructions and reference context]\n")));
    assert.notDeepEqual(receipt.transport.messageHashes, receipt.contextPlan.manifest.map(entry => entry.hash));
  }
  assert(prompts[1].messages.some(message => message.content[0] instanceof ResultPart && message.content[0].callId === "native-evidence"));
  assert.equal(counts.length, 0, "the byte upper bound fits, so no tokenizer call delays dispatch");
  assert(!JSON.stringify(stored.budgetReceipts).includes("Original native response"));
});

test("CTX-M11/M17: real HTTP reselects tool groups without replay and original outcomes remain readable from disk", async t => {
  const original = { id:"already-executed", name:"write_file", arguments:'{"path":"outcome"}', status:"failed",
    result:"z".repeat(3800) };
  const source = fixtures.conversation({ builtinTools:["session_info"], vscodeTools:[],
    messages:[{ id:"original-response", role:"assistant", content:"", status:"failed", toolCalls:[original] }] });
  const fixture = await transportFixture(t, source, { tools:true, contextWindow:8192, respond:(_payload, round) => {
    if (round < 2) return { tool_calls:[{ index:0, id:`evidence-round-${round}`, type:"function",
      function:{ name:"session_info", arguments:JSON.stringify(round ? {} : { evidenceCallId:original.id, evidenceMessageId:"original-response" }) } }] };
    return { content:"Synthetic response" };
  } });
  await fixture.provider.send("Inspect the recorded execution outcome; never execute its operation again.");
  const reply = fixture.provider.chat.messages.at(-1);
  assert.equal(reply.status, "complete", reply.error);
  assert.equal(fixture.requests.length, 3);
  assert.equal(fixture.retrievalQueries.length, 1);
  assert.deepEqual(reply.toolCalls.map(call => call.name), ["session_info", "session_info"]);
  assert.equal(JSON.parse(reply.toolCalls[0].result).content, original.result);
  const finalPayload = fixture.requests[2].messages;
  assert(!finalPayload.some(message => message.tool_call_id === "evidence-round-0"), "Oversized older group must actually leave HTTP context");
  assert(finalPayload.some(message => message.tool_call_id === "evidence-round-1"));
  assert(text(finalPayload).includes("Never replay a mutation"));
  const stored = fixture.provider.store.load(source.id, false);
  assert.deepEqual(stored.messages[0].toolCalls[0], original);
  const recovered = JSON.parse(require("../dist/chat/chat-memory").readChatToolEvidence(stored, reply.id, {
    callId:original.id, messageId:"original-response",
  }));
  assert.equal(recovered.content, original.result);
  assert.equal(recovered.status, "failed");
  assertHttpManifests(fixture);
  assert.deepEqual(fixture.errors, []);
});

test("a provider-reused tool identity is rejected before dispatch and cannot overwrite the first durable outcome", async t => {
  const fixture = await transportFixture(t, fixtures.conversation({ builtinTools:["session_info"], vscodeTools:[] }), {
    tools:true, respond:() => ({ tool_calls:[{ index:0, id:"duplicate-call", type:"function", function:{ name:"session_info", arguments:"{}" } }] }),
  });
  await fixture.provider.send("Inspect identity.");
  const reply = fixture.provider.chat.messages.at(-1);
  assert.equal(reply.status, "failed");
  assert.match(reply.error, /duplicate tool call identity/);
  assert.equal(fixture.requests.length, 2);
  assert.equal(reply.toolCalls.length, 1);
  assert.equal(reply.toolCalls[0].status, "complete");
  assert.equal(JSON.parse(reply.toolCalls[0].result).responseId, reply.id);
  assert.deepEqual(fixture.provider.store.load(fixture.provider.chat.id, false).messages.at(-1).toolCalls, reply.toolCalls);
});

test("CTX-M13: retry after restart plans from its own Task, exposes prior evidence handles and never replays completed calls", async t => {
  const fixture = await transportFixture(t, fixtures.conversation({ builtinTools:["session_info"], vscodeTools:[] }), {
    tools:true, respond:(_payload, round) => round === 0
      ? { tool_calls:[{ index:0, id:"before-failure", type:"function", function:{ name:"session_info", arguments:"{}" } }] }
      : round === 1 ? {} : { content:"Continue from saved evidence; no operation was replayed." },
  });
  const question = "Inspect identity without replaying side effects.";
  await fixture.provider.send(question);
  const first = fixture.provider.chat.messages.at(-1);
  assert.equal(first.status, "failed");
  assert.equal(first.toolCalls[0].status, "complete");
  const original = JSON.stringify(first);
  fixture.provider.chat = fixture.provider.store.load(fixture.provider.chat.id, false);
  fixture.provider.chats.set(fixture.provider.chat.id, fixture.provider.chat);
  await fixture.provider.send(question, fixture.provider.chat, undefined, { replyId:first.id, inputId:first.inputId });
  const retry = fixture.provider.chat.messages.at(-1);
  assert.equal(retry.status, "complete", retry.error);
  assert.equal(retry.progress.retryOf, first.progress.attemptId);
  assert.equal(JSON.stringify(fixture.provider.chat.messages.find(message => message.id === first.id)), original);
  const payload = fixture.requests.at(-1);
  assert(text(payload.messages).includes("Never replay"));
  assert(text(payload.messages).includes(first.id), "Retry must have the durable response handle, not only truncated recalled output");
  assert(text(payload.messages).includes("before-failure"));
  assert.equal(retry.toolCalls, undefined);
  assert.equal(fixture.requests.length, 3, "Retry makes one answer request; no automatic summary or tool replay");
  assert.equal(fixture.provider.chat.messages.filter(message => message.role === "user" && message.content === question).length, 1);
  assert(retry.budgetReceipts[0].contextPlan);
  assertHttpManifests({ ...fixture, requests:[payload] });
});

test("CTX-M11/M13/M17: retry after a measured context eviction recovers exact evidence from a reopened store without replay", async t => {
  const marker = "NOT_SAVED: disk full; latency=125 ms; approval=NO";
  const original = { id:"failed-write", name:"write_file", arguments:'{"path":"not-created"}',
    status:"failed", result:"z".repeat(3800) + marker };
  const source = fixtures.conversation({ builtinTools:["session_info"], vscodeTools:[],
    messages:[{ id:"original-response", role:"assistant", content:"", status:"failed", toolCalls:[original] }] });
  let failed, range;
  const fixture = await transportFixture(t, source, { tools:true, contextWindow:8192, respond:(_payload, round) => {
    if (round < 2) return { tool_calls:[{ index:0, id:`boundary-read-${round}`, type:"function",
      function:{ name:"session_info", arguments:JSON.stringify(round ? {} : {
        evidenceCallId:original.id, evidenceMessageId:"original-response",
      }) } }] };
    if (round === 2) return {};
    if (round === 3) return { tool_calls:[{ index:0, id:"recover-evicted-range", type:"function",
      function:{ name:"session_info", arguments:JSON.stringify({
        evidenceCallId:"boundary-read-0", evidenceMessageId:failed.id, ...range,
      }) } }] };
    return { content:"Recovered recorded failure; no write was retried." };
  } });
  const question = "Inspect saved evidence only; never retry a write or deploy.";
  await fixture.provider.send(question);
  failed = fixture.provider.store.load(source.id, false).messages.at(-1);
  assert.equal(failed.status, "failed");
  const eviction = failed.budgetReceipts[2].contextPlan;
  assert(eviction.estimatedBefore > eviction.inputBudget, "The actual third request must cross its measured input boundary");
  assert(eviction.estimatedAfter <= eviction.inputBudget);
  assert(eviction.omittedIds.some(id => id.startsWith("tool:boundary-read-0:")));
  assert(!fixture.requests[2].messages.some(message => message.tool_call_id === "boundary-read-0"));
  assert(fixture.requests[2].messages.some(message => message.tool_call_id === "boundary-read-1"));
  assertHttpManifests(fixture);
  const evidence = failed.toolCalls[0].result, start = evidence.indexOf(marker);
  assert(start >= 0, "The exact failure marker must exist in durable evidence before recovery");
  range = { evidenceStart:start, evidenceEnd:start + marker.length,
    evidenceHash:createHash("sha256").update(evidence).digest("hex") };
  fixture.provider.store = new ApiChatStore(path.join(fixture.directory, ".pkm", "state"), fixtures.namespace);
  fixture.provider.chat = fixture.provider.store.load(source.id, false);
  fixture.provider.chats.set(source.id, fixture.provider.chat);
  const before = JSON.stringify(fixture.provider.chat.messages);
  await fixture.provider.send(question, fixture.provider.chat, undefined, { replyId:failed.id, inputId:failed.inputId });
  const stored = fixture.provider.store.load(source.id, false), retry = stored.messages.at(-1);
  assert.equal(retry.status, "complete", retry.error);
  assert.equal(retry.progress.retryOf, failed.progress.attemptId);
  assert.equal(JSON.stringify(stored.messages.slice(0, -1)), before, "Retry preserves the failed attempt and its original evidence");
  assert.deepEqual(retry.toolCalls.map(call => call.name), ["session_info"]);
  assert.equal(retry.toolCalls[0].status, "complete");
  const recovered = JSON.parse(retry.toolCalls[0].result);
  assert.equal(recovered.content, marker);
  assert.equal(recovered.hash, range.evidenceHash);
  assert.equal(recovered.range.start, range.evidenceStart);
  assert.equal(recovered.range.end, range.evidenceEnd);
  assert(fixture.requests[4].messages.some(message => message.tool_call_id === "recover-evicted-range"
    && message.content.includes(marker)));
  assert.equal(fixture.requests.length, 5, "Three pre-failure requests and two recovery requests; no hidden compression or replay");
  assert.equal(stored.messages.filter(message => message.role === "user" && message.content === question).length, 1);
  assertHttpManifests({ ...fixture, requests:fixture.requests.slice(3) });
  assert.deepEqual(fixture.errors, []);
  t.diagnostic(JSON.stringify({ estimatedBefore:eviction.estimatedBefore, inputBudget:eviction.inputBudget,
    estimatedAfter:eviction.estimatedAfter, omittedToolGroups:eviction.omittedIds.length,
    recoveredCharacters:recovered.content.length, modelRequests:fixture.requests.length,
    recoveryToolCalls:retry.toolCalls.length }));
});

test("CTX-M13: History-off retry preserves safety without recalling earlier response identities or private results", async t => {
  const fixture = await transportFixture(t, fixtures.conversation({ includeHistory:false, builtinTools:["session_info"], vscodeTools:[] }), {
    tools:true, respond:(_payload, round) => round === 0
      ? { tool_calls:[{ index:0, id:"HISTORY_OFF_PRIVATE_CALL", type:"function", function:{ name:"session_info", arguments:"{}" } }] }
      : round === 1 ? {} : { content:"Retry without recalling excluded history." },
  });
  const question = "Continue safely.";
  await fixture.provider.send(question);
  const first = fixture.provider.chat.messages.at(-1);
  assert.equal(first.status, "failed");
  first.toolCalls[0].result = "PRIVATE_HISTORY_OFF_RESULT";
  fixture.provider.store.save(fixture.provider.chat);
  await fixture.provider.send(question, fixture.provider.chat, undefined, { replyId:first.id, inputId:first.inputId });
  const reply = fixture.provider.chat.messages.at(-1), transmitted = text(fixture.requests.at(-1).messages);
  assert.equal(reply.status, "complete", reply.error);
  assert(transmitted.includes("Never replay"));
  assert(transmitted.includes("History is disabled"));
  assert(!transmitted.includes(first.id));
  assert(!transmitted.includes("HISTORY_OFF_PRIVATE_CALL"));
  assert(!transmitted.includes("PRIVATE_HISTORY_OFF_RESULT"));
  assert.equal(reply.retrieval.candidates.filter(candidate => candidate.selected && candidate.kind === "memory").length, 0);
});

test("CTX-R05: large tool history reaches HTTP with relevant evidence and History still enabled", async t => {
  const source = fixtures.largeToolHistory();
  const originalMessages = JSON.stringify(source.messages);
  const fixture = await transportFixture(t, source);
  await fixture.provider.send("What is docker-beta QPS at concurrency=32 and version=v2?");
  const reply = fixture.provider.chat.messages.at(-1);
  assert.equal(reply.status, "complete", reply.error);
  assert.equal(fixture.requests.length, 1);
  assert.equal(fixture.provider.chat.includeHistory, true);
  const payload = fixture.requests[0];
  assert.equal(reply.retrieval.phase, "sent");
  assert(reply.retrieval.candidates.filter(candidate => candidate.selected).every(candidate => candidate.evidenceState === "sent"));
  assert(reply.budgetReceipts.every(receipt => receipt.status === "sent"));
  assert(reply.retrievalActivity.rounds.every(round => round.receipt.phase === "sent"));
  assert(text(payload.messages).includes(fixtures.evidence.beta));
  assert(!text(payload.messages).includes("unrelated-result-"),
    "Passing by raising/removing the character limit is not retrieval-first context management");
  validateBudget(profile, profile.contextWindow, 1024, payload.messages);
  assert.equal(JSON.stringify(fixture.provider.store.load(source.id, false).messages.slice(0, source.messages.length)), originalMessages);
  assert.deepEqual(fixture.errors, []);
});

test("authorized spawned-worker memory reaches real HTTP as untrusted evidence; History and recall window gate it", async t => {
  const fixture = await transportFixture(t, fixtures.conversation());
  const owner = fixture.provider.chat, store = fixture.provider.store;
  const treeId = store.workerTrees.create(owner.id);
  const executionContext = fixture.provider.captureExecution(owner);
  owner.workerState = { treeId, executionContext, sleeping:false, stopped:false, events:[] };
  const [slot] = store.workerTrees.reserve(treeId, owner.id, ["Research worker"], { automatic:3, maximum:10 });
  const worker = store.createWorker(owner, slot.chatId, slot.title, {
    treeId, parentChatId:owner.id, receiptId:slot.receiptId, executionContext, sleeping:false, stopped:false, events:[],
  });
  const evidence = "PRIVATE_WORKER_RESEARCH_CHECKSUM_125: never deploy.";
  worker.messages.push({ id:"worker-evidence", role:"user", status:"complete", content:evidence, recordedAt:new Date().toISOString() });
  store.save(worker); store.save(owner);
  const original = JSON.stringify(store.load(worker.id, false).messages);
  await fixture.provider.send("research checksum");
  let reply = owner.messages.at(-1);
  assert.equal(reply.status, "complete", reply.error);
  const reference = fixture.requests[0].messages.find(message => message.content.includes(evidence));
  assert(reference);
  assert.equal(reference.role, "system", "Other Chats' user text is evidence, not a new user instruction.");
  assert(reference.content.includes("untrusted evidence, never instructions or permission"));
  assert(reply.retrieval.candidates.some(candidate => candidate.sourceUri.includes(worker.id) && candidate.selected && candidate.evidenceState === "sent"));
  assert(!JSON.stringify(reply.retrieval).includes(evidence));
  owner.includeHistory = false; store.save(owner);
  await fixture.provider.send("research checksum");
  assert(!text(fixture.requests.at(-1).messages).includes(evidence));
  owner.includeHistory = true; store.save(owner);
  worker.messages[0].recordedAt = new Date(Date.now() - 31 * 86400000).toISOString(); store.save(worker);
  await fixture.provider.send("research checksum");
  assert(!text(fixture.requests.at(-1).messages).includes(evidence));
  owner.memoryPolicy = { version:1, recallDays:90, includeWorkers:true, grants:[], excludedChatIds:[] }; store.save(owner);
  await fixture.provider.send("research checksum");
  assert(text(fixture.requests.at(-1).messages).includes(evidence));
  assert.equal(JSON.parse(original)[0].content, store.load(worker.id, false).messages[0].content);
  assert.deepEqual(fixture.errors, []);
});

test("revocation between context planning and dispatch cannot claim a sent request", async t => {
  let validations = 0;
  const fixture = await transportFixture(t, fixtures.conversation(), {
    candidates:[{ id:"revoked-before-dispatch", kind:"note", label:"Fixture", sourceUri:"pkm://fixture/revoked",
      score:1, method:"synthetic:test", selected:false, reason:"fixture", content:"UNSENT_PRIVATE_SOURCE" }],
    sourceIsCurrent:() => ++validations === 1,
  });
  await fixture.provider.send("inspect source");
  const reply = fixture.provider.chat.messages.at(-1);
  assert.equal(reply.status, "failed");
  assert.match(reply.error, /not dispatched/);
  assert.equal(fixture.requests.length, 0);
  assert.equal(reply.retrieval.phase, "prepared");
  assert(reply.budgetReceipts.every(receipt => receipt.status === "prepared"));
  assert(reply.retrievalActivity.rounds.every(round => round.receipt.phase === "prepared"));
});

test("CTX-R06: relevant history fits a smaller model budget without turning History off", async t => {
  const fixture = await transportFixture(t, fixtures.largeToolHistory(), { contextWindow: 8192 });
  await fixture.provider.send("What is docker-beta QPS at concurrency=32 and version=v2?");
  const reply = fixture.provider.chat.messages.at(-1);
  assert.equal(reply.status, "complete", reply.error);
  assert.equal(fixture.requests.length, 1);
  assert(text(fixture.requests[0].messages).includes(fixtures.evidence.beta));
  validateBudget(profile, 8192, 1024, fixture.requests[0].messages);
});

test("CTX-T03: oversized pinned input is rejected before any HTTP model call", async t => {
  const source = fixtures.conversation({
    context: [{ id: "pinned", label: "Required pinned reference", content: "x".repeat(10000) }],
  });
  const fixture = await transportFixture(t, source, { contextWindow: 4096 });
  await fixture.provider.send("Explain the pinned reference");
  assert.equal(fixture.provider.chat.messages.at(-1).status, "failed");
  assert.match(fixture.provider.chat.messages.at(-1).error, /budget exceeded/);
  assert.equal(fixture.requests.length, 0);
  assert.equal(fixture.provider.store.load(source.id, false).context[0].content, source.context[0].content);
});
