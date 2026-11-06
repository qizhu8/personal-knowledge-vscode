const { test } = require("node:test");
const assert = require("node:assert/strict");
const Module = require("node:module"), fs = require("node:fs"), os = require("node:os"), path = require("node:path"), http = require("node:http");
const { randomUUID } = require("node:crypto");
const { executeMemoryOperation } = require("../dist/capabilities/memory-operations");
const fixtures = require("./fixtures/chat-context");
let capabilityProfile = "compact";
const host = {
  env: { language: "en" }, lm: { tools: [] },
  window: { showInformationMessage: async () => undefined, showWarningMessage: async () => undefined, showErrorMessage: async () => undefined },
  workspace: { isTrusted: true, workspaceFolders: [], getConfiguration: () => ({ get: (name, fallback) =>
    name === "apiChatCapabilityProfile" ? capabilityProfile : fallback }) },
};
const load = Module._load;
let ApiChatView, ApiChatStore, apiChatCreditUsage, captureExecutionContext;
try {
  Module._load = function(name, ...args) { return name === "vscode" ? host : load.call(this, name, ...args); };
  ({ ApiChatView } = require("../dist/chat/api-chat-view"));
  ({ ApiChatStore, apiChatCreditUsage } = require("../dist/chat/api-chat-store"));
  ({ captureExecutionContext } = require("../dist/chat/execution-context"));
} finally { Module._load = load; }

test("activity admission: final at-limit output settles; pending work waits for explicit credit choice", { timeout:15000 }, async t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "pkm-credit-admission-"));
  require("../dist/knowledge/filestore").setStorePath(directory);
  const client = require("../dist/chat/api-chat-client"), originalStream = client.streamApiChat;
  const originalWarning = host.window.showWarningMessage;
  const previousCapabilityProfile = capabilityProfile;
  const provider = new ApiChatView({ secrets:{ get:async () => "fixture" }, globalStorageUri:{ fsPath:path.join(directory, "private") } }, async () => []);
  provider.store = new ApiChatStore(path.join(directory, ".pkm", "state"), fixtures.namespace);
  provider.publish = () => {}; provider.queueProfileLearning = () => {};
  provider.captureExecution = target => captureExecutionContext(provider.executionHostId, [], directory, true, target.permissionMode);
  const errors = []; provider.notify = error => errors.push(String(error));
  const profile = { id:"fixture", label:"Fixture", model:"fixture", status:"active", contextWindow:64000, maxOutputTokens:4096, includeUsage:false };
  provider.settings = () => ({ provider:"openai-compatible", endpoint:"https://example.test/v1", selectedProfile:profile, profiles:[profile],
    model:"fixture", contextWindow:64000, maxOutputTokens:4096, timeoutMs:10000, maxToolRounds:10,
    loopReviewAfterMs:60000, activityReviewMs:1200000, activityCreditLimit:1 });
  t.after(() => { client.streamApiChat = originalStream; host.window.showWarningMessage = originalWarning;
    capabilityProfile = previousCapabilityProfile;
    provider.dispose(); fs.rmSync(directory, { recursive:true, force:true }); });
  for (const mode of ["final", "tool", "inference", "cancel"]) {
    const chat = fixtures.conversation({ includeHistory:false, permissionMode:"allow-all", builtinTools:["session_info"], vscodeTools:[] });
    provider.store.save(chat); provider.chat = chat; provider.chats.set(chat.id, chat);
    let choose, prompts = 0, admissions = 0, signalPrompt;
    const promptRequested = new Promise(resolve => { signalPrompt = resolve; });
    host.window.showWarningMessage = () => { prompts++; signalPrompt(); return new Promise(resolve => { choose = resolve; }); };
    client.streamApiChat = async (request, onText) => {
      await request.beforeRound(request.messages, 4096);
      const transport = client.chatTransportReceipt("http", request.messages, []);
      request.onTransportPrepared(transport); request.onTransportSent(transport);
      onText("Fixture answer.");
      request.onUsage({ inputTokens:10, outputTokens:2, copilotNanoAiu:1_000_000_000 });
      await request.afterRound?.(0);
      if (mode === "final") return;
      if (mode === "inference") await request.beforeRound(request.messages, 4096);
      else await request.tools.find(tool => tool.name === "session_info").execute({}, request.signal);
      admissions++;
    };
    capabilityProfile = "legacy";
    const sending = provider.send("Check activity admission.", chat);
    const result = await Promise.race([promptRequested.then(() => "prompted"), sending.then(() => "settled", () => "settled")]);
    if (mode === "final") {
      if (result === "prompted") { choose?.("Cancel activity"); await sending.catch(() => undefined); }
      assert.equal(result, "settled", "Completed output must settle with the credit UI unanswered");
      assert.equal(prompts, 0, "No extra-credit decision for nonexistent next work");
      const completed = provider.store.load(chat.id, false).messages.at(-1);
      assert.equal(completed.status, "complete");
      assert.equal(completed.content, "Fixture answer.");
    } else {
      assert.equal(result, "prompted", "At-limit work must wait for an explicit choice");
      assert.equal(admissions, 0); assert.equal(prompts, 1);
      choose(mode === "cancel" ? "Cancel activity" : "Continue (+50 credits)");
      await sending;
      assert.equal(admissions, mode === "cancel" ? 0 : 1);
      assert.equal(provider.store.load(chat.id, false).messages.at(-1).status, mode === "cancel" ? "cancelled" : "complete");
    }
    const creditUsage = apiChatCreditUsage(provider.store.load(chat.id, false).messages.at(-1));
    assert.equal(creditUsage.status, "reported", "Persisted provider-credit usage should be known for this request");
    assert.equal(creditUsage.totalNanoAiu, "1000000000");
    assert.equal(creditUsage.credits, "1");
  }
  capabilityProfile = "compact";
});

test("tool events checkpoint once with durable results and suppressed-stage fallback", { timeout:30000 }, async t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "pkm-tool-checkpoint-"));
  require("../dist/knowledge/filestore").setStorePath(directory);
  const client = require("../dist/chat/api-chat-client"), originalStream = client.streamApiChat;
  const provider = new ApiChatView({ secrets:{ get:async () => "fixture" }, globalStorageUri:{ fsPath:path.join(directory, "private") } }, async () => []);
  const chat = fixtures.conversation({ includeHistory:false, permissionMode:"allow-all", builtinTools:["read_file"], vscodeTools:[],
    messages:Array.from({ length:8 }, () => fixtures.message("assistant", "SYNTHETIC_EVIDENCE_".repeat(16000))) });
  provider.store = new ApiChatStore(path.join(directory, ".pkm", "state"), fixtures.namespace);
  provider.store.save(chat); provider.chat = chat; provider.chats.set(chat.id, chat);
  const historicalSnapshot = JSON.stringify(provider.store.load(chat.id, false).messages.slice(0, 8));
  const originalPersist = provider.persist.bind(provider), events = [];
  let persists = 0, publishes = 0, persistMs = 0;
  provider.persist = target => {
    const at = performance.now(); persists++;
    try { return originalPersist(target); } finally { persistMs += performance.now() - at; }
  };
  provider.publish = () => { publishes++; };
  provider.queueProfileLearning = () => {};
  provider.captureExecution = target => captureExecutionContext(provider.executionHostId, [], directory, true, target.permissionMode);
  const errors = []; provider.notify = error => errors.push(error);
  const profile = { id:"fixture", label:"Fixture", model:"fixture", status:"active", contextWindow:64000, maxOutputTokens:4096, includeUsage:false };
  provider.settings = () => ({ provider:"openai-compatible", endpoint:"https://example.test/v1",
    selectedProfile:profile, profiles:[profile], model:"fixture", contextWindow:64000, maxOutputTokens:4096,
    timeoutMs:10000, maxToolRounds:10, loopReviewAfterMs:60000, activityReviewMs:1200000, activityCreditLimit:-1 });
  t.after(() => {
    client.streamApiChat = originalStream; provider.dispose();
    fs.rmSync(directory, { recursive:true, force:true });
  });
  client.streamApiChat = async request => {
    await request.beforeRound(request.messages, 4096);
    const dispatch = event => {
      const before = { persists, publishes, persistMs }, at = performance.now();
      request.onTool(event);
      events.push({ status:event.status, persists:persists - before.persists, publishes:publishes - before.publishes,
        callbackMs:performance.now() - at, persistMs:persistMs - before.persistMs });
      const saved = provider.store.load(chat.id, false).messages.at(-1).toolCalls.find(item => item.id === event.id);
      assert.equal(saved.status, event.status, "Status is durable before the callback returns");
      if (event.result !== undefined) assert.equal(saved.result, event.result, "Original raw results are durable byte-for-byte");
    };
    for (let index = 0; index < 3; index++) dispatch({ id:`checkpoint-${index}`, name:"read_file", arguments:"{}", status:"running" });
    for (let index = 0; index < 3; index++) dispatch({ id:`checkpoint-${index}`, name:"read_file", arguments:"{}",
      status:index === 2 ? "failed" : "complete", result:JSON.stringify({ raw:`ORIGINAL_RESULT_${index}_\u00e9` }) });
    dispatch({ id:"checkpoint-2", name:"read_file", arguments:"{}", status:"failed", result:'{"error":"Updated terminal metadata"}' });
    provider.running.get(chat.id).abort();
    const before = { persists, publishes };
    request.onTool({ id:"late-cancelled", name:"read_file", arguments:"{}", status:"complete", result:"Must not be recorded" });
    assert.deepEqual({ persists, publishes }, before, "Cancelled callbacks do not checkpoint or refresh");
  };
  await provider.send("Measure non-mutating callback persistence.", chat);
  assert.deepEqual(errors, []);
  const saved = provider.store.load(chat.id, false);
  assert.equal(saved.messages.at(-1).status, "cancelled");
  assert.equal(saved.messages.at(-1).toolCalls.length, 3);
  assert.equal(JSON.stringify(saved.messages.slice(0, 8)), historicalSnapshot, "All historical evidence and metadata are unchanged");
  console.log(JSON.stringify({ fixture:"tool-event-checkpoint", events:events.length,
    persistCalls:events.reduce((sum, item) => sum + item.persists, 0), publishCalls:events.reduce((sum, item) => sum + item.publishes, 0),
    callbackMs:events.reduce((sum, item) => sum + item.callbackMs, 0), persistMs:events.reduce((sum, item) => sum + item.persistMs, 0),
    historicalBytes:Buffer.byteLength(chat.messages.slice(0, 8).map(item => item.content).join("")),
    providerCalls:0, timing:"local large-history Host replay only; UI publication counted, not rendered" }));
  assert.deepEqual(events.map(item => item.persists), [1, 1, 1, 1, 1, 1, 1], "Each new or suppressed-stage event needs exactly one checkpoint");
  assert.deepEqual(events.map(item => item.publishes), [1, 1, 1, 1, 1, 1, 1], "Each event refreshes exactly once");
});

test("default full native discovery admits the formerly overflowing 64k development input with complete coverage", async t => {
  const { estimateInputTokens } = require("../dist/chat/api-chat-models");
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "pkm-default-discovery-"));
  require("../dist/knowledge/filestore").setStorePath(directory);
  const client = require("../dist/chat/api-chat-client"), originalStream = client.streamApiChat;
  const provider = new ApiChatView({ secrets:{ get:async () => "fixture" }, globalStorageUri:{ fsPath:path.join(directory, "private") } }, async () => []);
  provider.store = new ApiChatStore(path.join(directory, ".pkm", "state"), fixtures.namespace);
  provider.publish = () => {}; provider.queueProfileLearning = () => {};
  provider.captureExecution = target => captureExecutionContext(provider.executionHostId, [], directory, true, target.permissionMode);
  provider.notify = error => { throw error; };
  const profile = { id:"fixture", label:"Fixture", model:"fixture", status:"active", contextWindow:64000,
    maxOutputTokens:4096, includeUsage:false, outputTokenParameter:"max_tokens" };
  provider.settings = () => ({ provider:"openai-compatible", endpoint:"https://example.test/v1",
    selectedProfile:profile, profiles:[profile], model:"fixture", contextWindow:64000, maxOutputTokens:4096,
    timeoutMs:10000, maxToolRounds:10, loopReviewAfterMs:60000, activityReviewMs:1200000, activityCreditLimit:-1 });
  t.after(() => {
    capabilityProfile = "compact"; client.streamApiChat = originalStream; provider.dispose();
    fs.rmSync(directory, { recursive:true, force:true });
  });
  let legacyNames, legacyBytes, compactBytes;
  for (const mode of ["legacy", "compact"]) {
    capabilityProfile = mode;
    const chat = fixtures.conversation({ permissionMode:"allow-all", vscodeTools:[] });
    provider.store.save(chat); provider.chat = chat; provider.chats.set(chat.id, chat);
    provider.agentControlledRequests.add(chat.id);
    let admitted = false;
    client.streamApiChat = async request => {
      const schemas = request.tools.map(({ execute, ...tool }) => tool);
      const bytes = Buffer.byteLength(JSON.stringify(schemas));
      const bound = estimateInputTokens([...request.messages, { role:"system", content:JSON.stringify(schemas) }]);
      if (mode === "legacy") {
        legacyNames = request.tools.map(tool => tool.name).sort(); legacyBytes = bytes;
        assert(bound > 59904, JSON.stringify({ bound, bytes, names:legacyNames }));
      } else {
        compactBytes = bytes;
        assert(bound < 24000, "full default input must leave substantial room within the original 59,904 budget");
        const list = request.tools.find(tool => tool.name === "capabilities_list"), aliases = [];
        let offset = 0, revision;
        do {
          const page = JSON.parse(await list.execute({ offset, limit:10, ...(revision ? { revision } : {}) }, request.signal));
          aliases.push(...page.operations.map(operation => operation.transportName));
          offset = page.nextOffset; revision = page.revision;
        } while (offset !== null);
        const core = request.tools.filter(tool => !/^capabilit/.test(tool.name)).map(tool => tool.name);
        assert.deepEqual([...core, ...aliases].sort(), legacyNames, "no enabled domain may disappear behind compact exposure");
        assert(bytes < legacyBytes * 0.4);
      }
      await request.beforeRound(request.messages, 4096);
      admitted = true;
      throw new Error("Fixture stopped after admission; no provider dispatch.");
    };
    await provider.send("Start a new task: Implement and test the bounded development task. " + "x".repeat(3119), chat);
    assert.equal(admitted, mode === "compact", chat.messages.at(-1).error);
    assert.match(chat.messages.at(-1).error, mode === "compact" ? /Fixture stopped after admission/ : /Context budget exceeded/);
  }
  console.log(JSON.stringify({ nativeLegacySchemaBytes:legacyBytes, nativeCompactSchemaBytes:compactBytes,
    inputBudget:59904, providerCalls:0, coverage:"every enabled original leaf" }));
});

test("real Chat request uses compact pilot discovery and invokes selected leaf under the original Host", { timeout: 15000 }, async t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "pkm-cap-native-")), requests = [];
  const started = performance.now(); let firstEffectiveResultMs;
  require("../dist/knowledge/filestore").setStorePath(directory);
  const server = http.createServer(async (req, res) => {
    let text = ""; for await (const chunk of req) text += chunk;
    const payload = JSON.parse(text); requests.push(payload);
    if (requests.length === 3) firstEffectiveResultMs = performance.now() - started;
    const call = (name, args) => ({ tool_calls: [{ index: 0, id: randomUUID(), type: "function", function: { name, arguments: JSON.stringify(args) } }] });
    const delta = requests.length === 1 ? call("capabilities_search", { query: "list_boards" })
      : requests.length === 2 ? call("capability_read", { operation: "todo.board.list", version: 1, arguments: {} })
        : { content: "No Boards were present; no work was claimed." };
    res.writeHead(200, { "Content-Type": "text/event-stream" });
    res.end(`data: ${JSON.stringify({ choices: [{ delta, finish_reason: delta.tool_calls ? "tool_calls" : "stop" }] })}\n\ndata: [DONE]\n\n`);
  });

  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  const provider = new ApiChatView({ secrets: { get: async () => "fixture" }, globalStorageUri: { fsPath: path.join(directory, "private") } }, async () => []);
  const chat = fixtures.conversation({ permissionMode: "allow-all", builtinTools: ["list_boards"], vscodeTools: [] });
  provider.store = new ApiChatStore(path.join(directory, ".pkm", "state"), fixtures.namespace);
  provider.store.save(chat); provider.chat = chat; provider.chats.set(chat.id, chat);
  provider.publish = () => {};
  const errors = []; provider.notify = error => errors.push(error);
  provider.captureExecution = target => captureExecutionContext(provider.executionHostId, [], directory, true, target.permissionMode);
  const profile = { id: "fixture", label: "Fixture", model: "fixture", status: "active", contextWindow: 32768, maxOutputTokens: 1024, includeUsage: false, outputTokenParameter: "max_tokens" };
  provider.settings = () => ({ provider: "openai-compatible", endpoint: `http://127.0.0.1:${server.address().port}/v1`,
    selectedProfile: profile, profiles: [profile], model: "fixture", contextWindow: 32768, maxOutputTokens: 1024, timeoutMs: 10000,
    maxToolRounds: 10, loopReviewAfterMs: 60000, activityReviewMs: 1200000, activityCreditLimit: -1 });
  t.after(async () => { provider.dispose(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); fs.rmSync(directory, { recursive: true, force: true }); });
  await provider.send("List available Boards without claiming work.", chat);
  assert.equal(requests.length, 3);
  const names = requests[0].tools.map(tool => tool.function.name);
  assert(names.includes("capabilities_search") && names.includes("capability_read"));
  assert(!names.includes("list_boards") && !names.includes("capability_call"));
  const evidence = JSON.parse(requests[2].messages.at(-1).content);
  assert.equal(evidence.operation, "todo.board.list", JSON.stringify(evidence));
  assert.equal(evidence.version, 1);
  assert.equal(evidence.result.total, 0);
  assert.deepEqual(errors, []);
  const saved = provider.store.load(chat.id, false);
  assert.equal(saved.messages.at(-1).toolCalls.filter(call => call.status === "complete").length, 2);
  console.log(JSON.stringify({ pilot: "native-todo-fixed-fixture", discoveryRounds: 1, effectiveOperations: 1,
    argumentOrSelectionErrors: 0, firstEffectiveResultMs, timing: "local deterministic HTTP fixture only, not provider latency" }));
});

test("real Host final-summary planning excludes old call groups and removed tool schemas", async t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "pkm-summary-host-"));
  require("../dist/knowledge/filestore").setStorePath(directory);
  const client = require("../dist/chat/api-chat-client"), originalStream = client.streamApiChat;
  const provider = new ApiChatView({ secrets:{ get:async () => "fixture" }, globalStorageUri:{ fsPath:path.join(directory, "private") } }, async () => []);
  const chat = fixtures.conversation({ permissionMode:"allow-all", builtinTools:["list_boards"], vscodeTools:[] });
  provider.store = new ApiChatStore(path.join(directory, ".pkm", "state"), fixtures.namespace);
  provider.store.save(chat); provider.chat = chat; provider.chats.set(chat.id, chat);
  provider.publish = () => {}; provider.queueProfileLearning = () => {};
  const errors = []; provider.notify = error => errors.push(error);
  provider.captureExecution = target => captureExecutionContext(provider.executionHostId, [], directory, true, target.permissionMode);
  const profile = { id:"fixture", label:"Fixture", model:"fixture", status:"active", contextWindow:32768,
    maxOutputTokens:1024, includeUsage:false, outputTokenParameter:"max_tokens" };
  provider.settings = () => ({ provider:"openai-compatible", endpoint:"https://example.test/v1",
    selectedProfile:profile, profiles:[profile], model:"fixture", contextWindow:32768, maxOutputTokens:1024,
    timeoutMs:10000, maxToolRounds:10, loopReviewAfterMs:60000, activityReviewMs:1200000, activityCreditLimit:-1 });
  let summaryBudget;
  client.streamApiChat = async (request, onText) => {
    await request.beforeRound(request.messages, 1024);
    for (const id of ["older-call", "latest-call"]) request.messages.push(
      { role:"assistant", content:"", tool_calls:[{ id, type:"function", function:{ name:"list_boards", arguments:"{}" } }] },
      { role:"tool", tool_call_id:id, content:"Previously completed fixture result." });
    await request.beforeRound(request.messages, 1024);
    const summary = request.messages.filter(message => !message.tool_calls && message.role !== "tool");
    const receipt = { role:"user", content:"Current-attempt final summary with complete paired receipts." };
    summary.push(receipt);
    await request.beforeRound(summary, 1024, undefined, { kind:"final-summary", inputOverhead:256 });
    summaryBudget = provider.chat.messages.at(-1).budgetReceipts.at(-1);
    assert(summary.includes(receipt), "the current-attempt summary request is mandatory during planning");
    assert(!summary.some(message => message.tool_calls || message.role === "tool"), "the old planner pool must not resurrect call groups");
    onText("Partial work remains; no operation was executed in this fixture.");
  };
  t.after(() => {
    client.streamApiChat = originalStream; provider.dispose();
    fs.rmSync(directory, { recursive:true, force:true });
  });
  await provider.send("Summarize existing observations without running operations.", chat);
  assert.deepEqual(errors, []);
  assert(summaryBudget);
  assert.equal(summaryBudget.contextPlan.toolSchemaHash, require("node:crypto").createHash("sha256").update("[]").digest("hex"));
  assert.equal(summaryBudget.effective.inputBudget, 32768 - 1024 - 256);
  assert(summaryBudget.contextPlan.manifest.every(message => !message.callIds.length));
});

test("native Chat wires private explicit Memory and a separate exact-record decision even under Allow All", { timeout: 15000 }, async t => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "pkm-memory-native-")), requests = [];
    require("../dist/knowledge/filestore").setStorePath(directory);
    const server = http.createServer(async (req, res) => {
      let text = ""; for await (const chunk of req) text += chunk;
      const payload = JSON.parse(text); requests.push(payload);
      const call = (operation, args) => ({ tool_calls: [{ index: 0, id: randomUUID(), type: "function",
        function: { name: operation.endsWith("search") ? "capability_read" : "capability_call",
          arguments: JSON.stringify({ operation, version: 1, arguments: args }) } }] });
      const result = requests.length === 2 ? JSON.parse(payload.messages.at(-1).content).result : undefined;
      const delta = requests.length === 1 ? call("memory.record.propose", { content: "Project conventions belong in explicit Memory.",
        sources: [{ id: "input", chat: "fixture-chat", revision: "r1", locator: "message/input" }], operation_id: "native-proposal" })
        : requests.length === 2 ? call("memory.record.confirm", { id: result.id, expected_revision: result.revision, operation_id: "native-confirm" })
          : [3, 5].includes(requests.length) ? call("memory.record.search", { query: "conventions" })
            : { content: "Confirmed and retrieved a versioned Memory record; no automatic application is asserted." };
      res.writeHead(200, { "Content-Type": "text/event-stream" });
      res.end(`data: ${JSON.stringify({ choices: [{ delta, finish_reason: delta.tool_calls ? "tool_calls" : "stop" }] })}\n\ndata: [DONE]\n\n`);
    });
    await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
    const provider = new ApiChatView({ secrets: { get: async () => "fixture" }, extensionPath: path.resolve(__dirname, ".."),
      globalStorageUri: { fsPath: path.join(directory, "private") } }, async () => []);
    const chat = fixtures.conversation({ permissionMode: "allow-all",
      builtinTools: ["memory_record_propose", "memory_record_confirm", "memory_record_search"], vscodeTools: [] });
    provider.store = new ApiChatStore(path.join(directory, ".pkm", "state"), fixtures.namespace);
    provider.store.save(chat); provider.chat = chat; provider.chats.set(chat.id, chat);
    provider.publish = () => {};
    const errors = [], decisions = []; provider.notify = error => errors.push(error);
    provider.queueProfileLearning = () => {};
    provider.captureExecution = target => captureExecutionContext(provider.executionHostId, [], directory, true, target.permissionMode);
    provider.requestDecision = async (target, title, detail, choices) => {
      decisions.push({ title, detail });
      assert.equal(target.id, chat.id);
      assert.equal(choices[0].value, "approve-memory");
      return "approve-memory";
    };
    const profile = { id: "fixture", label: "Fixture", model: "fixture", status: "active", contextWindow: 32768,
      maxOutputTokens: 1024, includeUsage: false, outputTokenParameter: "max_tokens" };
    provider.settings = () => ({ provider: "openai-compatible", endpoint: `http://127.0.0.1:${server.address().port}/v1`,
      selectedProfile: profile, profiles: [profile], model: "fixture", contextWindow: 32768, maxOutputTokens: 1024,
      timeoutMs: 10000, maxToolRounds: 10, loopReviewAfterMs: 60000, activityReviewMs: 1200000, activityCreditLimit: -1 });
    t.after(async () => { provider.dispose(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); fs.rmSync(directory, { recursive: true, force: true }); });
    await provider.send("Propose and confirm the exact Memory, then retrieve it.", chat);
    assert.deepEqual(errors, []);
    assert.equal(requests.length, 4);
    assert.equal(decisions.length, 1, "Allow All does not bypass the real Host decision surface");
    for (const value of ["Action: Confirm this Memory record revision.", "Project conventions belong in explicit Memory.",
      "Source ID: input", "Source revision: r1", "Chat: fixture-chat", "Locator: message/input", "Expected revision: 1",
      "Current record revision: 1", "Account: local-owner", "Operation ID (idempotency): native-confirm", "user:local",
      "eligible for future active Memory search"]) assert(decisions[0].detail.includes(value), value);
    assert.equal(JSON.parse(requests[3].messages.at(-1).content).result.records[0].status, "confirmed");
    assert(fs.existsSync(provider.memoryDatabasePath()), "uses the private Host database");
    const another = fixtures.conversation({ permissionMode: "allow-all", builtinTools: ["memory_record_search"], vscodeTools: [] });
    another.id = randomUUID();
    provider.store.save(another); provider.chats.set(another.id, another); provider.chat = another;
    await provider.send("Retrieve the confirmed project convention from another Chat.", another);
    assert.deepEqual(errors, []);
    assert.equal(requests.length, 6);
    const first = JSON.parse(requests[3].messages.at(-1).content).result.records[0];
    const recalled = JSON.parse(requests[5].messages.at(-1).content).result.records[0];
    assert.equal(recalled.id, first.id);
    assert.equal(recalled.revision, first.revision);
    assert.equal(decisions.length, 1, "another Chat recalls the exact persisted confirmation, not a second invented decision");
});

// Capture real Host tools without provider/network calls; all approvals below are synthetic.
async function withNativeMemoryFixture(t, exercise) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "pkm-native-memory-auth-"));
  require("../dist/knowledge/filestore").setStorePath(directory);
  const client = require("../dist/chat/api-chat-client"), originalStream = client.streamApiChat;
  const provider = new ApiChatView({ secrets: { get: async () => "fixture" }, extensionPath: path.resolve(__dirname, ".."),
    globalStorageUri: { fsPath: path.join(directory, "private") } }, async () => []);
  const chat = fixtures.conversation({ permissionMode: "allow-all",
    builtinTools: ["memory_record_confirm", "memory_record_revise", "memory_record_revoke"], vscodeTools: [] });
  provider.store = new ApiChatStore(path.join(directory, ".pkm", "state"), fixtures.namespace);
  provider.store.save(chat); provider.chat = chat; provider.chats.set(chat.id, chat);
  provider.publish = () => {}; provider.queueProfileLearning = () => {};
  const errors = []; provider.notify = error => errors.push(error);
  provider.captureExecution = target => captureExecutionContext(provider.executionHostId, [], directory, true, target.permissionMode);
  const profile = { id: "fixture", label: "Fixture", model: "fixture", status: "active", contextWindow: 32768,
    maxOutputTokens: 1024, includeUsage: false, outputTokenParameter: "max_tokens" };
  provider.settings = () => ({ provider: "openai-compatible", endpoint: "https://example.test/v1",
    selectedProfile: profile, profiles: [profile], model: "fixture", contextWindow: 32768, maxOutputTokens: 1024,
    timeoutMs: 10000, maxToolRounds: 10, loopReviewAfterMs: 60000, activityReviewMs: 1200000, activityCreditLimit: -1 });
  t.after(() => {
    client.streamApiChat = originalStream; provider.dispose();
    fs.rmSync(directory, { recursive: true, force: true });
  });
  const options = { python: process.env.PKM_TEST_PYTHON || "python3", database: provider.memoryDatabasePath(),
    extensionRoot: path.resolve(__dirname, ".."), identity: `pkm-chat:${directory}` };
  const sources = [{ id: "fixture-input", chat: chat.id, revision: "fixture-rev-1", locator: "message/fixture" }];
  const seed = action => executeMemoryOperation(options, directory, "memory_record_propose", {
    content: `Original ${action} content.`, sources, operation_id: `seed-${action}`,
  });
  const snapshot = async id => ({
    record: await executeMemoryOperation(options, directory, "memory_record_get", { id }),
    audit: await executeMemoryOperation(options, directory, "memory_record_audit", { id }),
  });
  let completed = false;
  client.streamApiChat = async (request, onText) => {
    const call = request.tools.find(tool => tool.name === "capability_call");
    assert(call, "real Host exposes the mutating capability dispatcher");
    await exercise({ provider, chat, call, seed, snapshot, sources });
    completed = true;
    onText("Isolated synthetic authorization fixtures completed; no real user approval.");
  };
  try {
    await provider.send("Exercise isolated native Memory authorization fixtures only.", chat);
    assert.deepEqual(errors, []);
    assert(completed, chat.messages.at(-1).error || "Host fixture did not complete");
  } finally { client.streamApiChat = originalStream; }
}

const nativeMemoryArguments = (action, record, sources) => ({
  operation: `memory.record.${action}`, version: 1, arguments: {
    id: record.id, expected_revision: record.revision, operation_id: `native-auth-${action}`,
    ...(action === "revise" ? { content: "Attempted synthetic replacement.", sources } : {}),
  },
});

test("native Memory abort during exact-record review rejects late synthetic approval for every mutation", { timeout: 30000 }, async t => {
  await withNativeMemoryFixture(t, async ({ provider, chat, call, seed, snapshot, sources }) => {
    let permissions = 0, decisions = 0;
    provider.requestPermission = async () => { permissions++; return true; }; // synthetic permission only
    for (const action of ["confirm", "revise", "revoke"]) {
      const record = await seed(action), before = await snapshot(record.id);
      const controller = new AbortController();
      let enter, release, settled = false;
      const entered = new Promise(resolve => { enter = resolve; });
      const approval = new Promise(resolve => { release = resolve; });
      provider.requestDecision = async (target, title, detail, choices, signal) => {
        decisions++;
        assert.equal(target.id, chat.id);
        assert.equal(title, `Memory ${action}: review exact record`);
        assert(detail.includes(record.id), "original authorizer reviewed the seeded exact record");
        assert.deepEqual(choices.map(choice => choice.value), ["approve-memory", "cancel"]);
        assert.equal(signal, controller.signal);
        assert.equal(signal.aborted, false);
        enter();
        return approval;
      };
      const outcome = call.execute(nativeMemoryArguments(action, record, sources), controller.signal)
        .then(value => ({ value }), error => ({ error })).then(result => { settled = true; return result; });
      await entered;
      assert.equal(decisions, permissions);
      assert.equal(settled, false, "tool is still waiting for the exact-record decision");
      controller.abort();
      assert.equal(controller.signal.aborted, true);
      release("approve-memory"); // deliberately late, synthetic approval must not authorize a write
      const result = await outcome;
      assert(result.error, `late ${action} approval unexpectedly succeeded: ${JSON.stringify(result.value)}`);
      assert.match(result.error.message, /Memory decision cancelled; no mutation was authorized/);
      assert.deepEqual(await snapshot(record.id), before, `${action}: full record and audit remain unchanged`);
    }
    assert.equal(permissions, 3);
    assert.equal(decisions, 3, "all three exact-record authorizers were entered before abort");
  });
});

test("native Portal-controlled Memory mutations are denied before permission or exact-record review", { timeout: 30000 }, async t => {
  await withNativeMemoryFixture(t, async ({ provider, chat, call, seed, snapshot, sources }) => {
    let permissions = 0, decisions = 0;
    provider.requestPermission = async () => { permissions++; assert.fail("Portal mutation reached the permission prompt"); };
    provider.requestDecision = async () => { decisions++; assert.fail("Portal mutation reached exact-record review"); };
    provider.remoteControlledRequests.add(chat.id);
    for (const action of ["confirm", "revise", "revoke"]) {
      const record = await seed(action), before = await snapshot(record.id);
      const controller = new AbortController();
      await assert.rejects(call.execute(nativeMemoryArguments(action, record, sources), controller.signal), error => {
        assert.equal(error.code, "ACCESS_DENIED");
        assert.match(error.message, /Portal-controlled requests cannot mutate explicit Memory/);
        return true;
      });
      assert.equal(permissions, 0);
      assert.equal(decisions, 0);
      assert.deepEqual(await snapshot(record.id), before, `${action}: full record and audit remain unchanged`);
    }
  });
});

test("native Memory cancel never mutates records and an approved stale revision is rejected after review wait", { timeout: 30000 }, async t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "pkm-memory-decisions-")), requests = [], decisions = [];
  require("../dist/knowledge/filestore").setStorePath(directory);
  const pendingCalls = [
    ["memory.record.confirm", "cancel-confirm"],
    ["memory.record.revise", "cancel-revise"],
    ["memory.record.revoke", "cancel-revoke"],
    ["memory.record.revise", "stale-review"],
  ];
  const server = http.createServer(async (req, res) => {
    let text = ""; for await (const chunk of req) text += chunk;
    const payload = JSON.parse(text); requests.push(payload);
    const index = requests.length - 1;
    const delta = index < pendingCalls.length
      ? { tool_calls: [{ index: 0, id: randomUUID(), type: "function", function: { name: "capability_call",
        arguments: JSON.stringify({ operation: pendingCalls[index][0], version: 1, arguments: {
          id: recordIds[pendingCalls[index][1]], expected_revision: 1, operation_id: `native-${pendingCalls[index][1]}`,
          ...(pendingCalls[index][0] === "memory.record.revise" ? { content: "Attempted replacement.", sources } : {}),
        } }) } }] }
      : { content: "Fixture review completed; this is not a real user approval." };
    res.writeHead(200, { "Content-Type": "text/event-stream" });
    res.end(`data: ${JSON.stringify({ choices: [{ delta, finish_reason: delta.tool_calls ? "tool_calls" : "stop" }] })}\n\ndata: [DONE]\n\n`);
  });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  const provider = new ApiChatView({ secrets: { get: async () => "fixture" }, extensionPath: path.resolve(__dirname, ".."),
    globalStorageUri: { fsPath: path.join(directory, "private") } }, async () => []);
  const chat = fixtures.conversation({ permissionMode: "allow-all",
    builtinTools: ["memory_record_confirm", "memory_record_revise", "memory_record_revoke"], vscodeTools: [] });
  provider.store = new ApiChatStore(path.join(directory, ".pkm", "state"), fixtures.namespace);
  provider.store.save(chat); provider.chat = chat; provider.chats.set(chat.id, chat);
  provider.publish = () => {}; provider.queueProfileLearning = () => {};
  const errors = []; provider.notify = error => errors.push(error);
  provider.captureExecution = target => captureExecutionContext(provider.executionHostId, [], directory, true, target.permissionMode);
  const profile = { id: "fixture", label: "Fixture", model: "fixture", status: "active", contextWindow: 32768,
    maxOutputTokens: 1024, includeUsage: false, outputTokenParameter: "max_tokens" };
  provider.settings = () => ({ provider: "openai-compatible", endpoint: `http://127.0.0.1:${server.address().port}/v1`,
    selectedProfile: profile, profiles: [profile], model: "fixture", contextWindow: 32768, maxOutputTokens: 1024,
    timeoutMs: 10000, maxToolRounds: 10, loopReviewAfterMs: 60000, activityReviewMs: 1200000, activityCreditLimit: -1 });
  const options = { python: process.env.PKM_TEST_PYTHON || "python3", database: provider.memoryDatabasePath(),
    extensionRoot: path.resolve(__dirname, ".."), identity: `pkm-chat:${directory}` };
  const sources = [{ id: "fixture-input", chat: chat.id, revision: "fixture-rev-1", locator: "message/fixture" }];
  const recordIds = {};
  const makeRecord = async key => {
    const record = await executeMemoryOperation(options, directory, "memory_record_propose", {
      content: `Original ${key} content.`, sources, operation_id: `seed-${key}`,
    });
    recordIds[key] = record.id;
    return record;
  };
  const snapshot = async id => ({
    record: await executeMemoryOperation(options, directory, "memory_record_get", { id }),
    audit: await executeMemoryOperation(options, directory, "memory_record_audit", { id }),
  });
  let staleSnapshot;
  provider.requestDecision = async (target, title, detail, choices) => {
    decisions.push({ title, detail });
    assert.equal(target.id, chat.id);
    assert.deepEqual(choices.map(choice => choice.value), ["approve-memory", "cancel"]);
    if (decisions.length < 4) return "cancel";
    assert.match(title, /revise/i);
    await new Promise(resolve => setImmediate(resolve)); // keep the exact-record decision pending while another writer advances it
    await executeMemoryOperation(options, directory, "memory_record_revise", {
      id: recordIds["stale-review"], expected_revision: 1, operation_id: "concurrent-writer",
      content: "Changed while local review was pending.", sources,
    }, () => ({ actorId: "user:local", decisionId: "fixture-concurrent-decision" }));
    staleSnapshot = await snapshot(recordIds["stale-review"]);
    return "approve-memory";
  };
  t.after(async () => { provider.dispose(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); fs.rmSync(directory, { recursive: true, force: true }); });

  const originals = {};
  for (const key of ["cancel-confirm", "cancel-revise", "cancel-revoke", "stale-review"]) {
    originals[key] = await makeRecord(key);
  }
  const cancelledBefore = {};
  for (const key of ["cancel-confirm", "cancel-revise", "cancel-revoke"]) cancelledBefore[key] = await snapshot(recordIds[key]);
  await provider.send("Exercise only isolated Memory decision fixtures; no real user approval is requested.", chat);

  assert.deepEqual(errors, []);
  assert.equal(requests.length, 5);
  assert.equal(decisions.length, 4);
  assert.deepEqual(decisions.slice(0, 3).map(decision => decision.title), [
    "Memory confirm: review exact record", "Memory revise: review exact record", "Memory revoke: review exact record",
  ]);
  for (const key of ["cancel-confirm", "cancel-revise", "cancel-revoke"]) {
    assert.deepEqual(await snapshot(recordIds[key]), cancelledBefore[key], `${key}: cancel leaves revision, content, status and audit unchanged`);
  }
  assert.equal(originals["stale-review"].revision, 1);
  assert(staleSnapshot, "the competing writer changed the record while Host decision awaited");
  assert.equal(staleSnapshot.record.revision, 2);
  assert.equal(staleSnapshot.record.content, "Changed while local review was pending.");
  assert.equal(staleSnapshot.record.status, "pending");
  assert.equal((await snapshot(recordIds["stale-review"])).record.revision, staleSnapshot.record.revision,
    "the original approval is rejected by revision CAS; no stale write lands");
  assert.deepEqual(await snapshot(recordIds["stale-review"]), staleSnapshot, "stale CAS rejection adds no content/status/audit mutation");
});

async function withHostSummaryBudgetFixture(stream, run) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "pkm-host-summary-stop-"));
  require("../dist/knowledge/filestore").setStorePath(directory);
  const client = require("../dist/chat/api-chat-client"), originalStream = client.streamApiChat;
  const provider = new ApiChatView({ secrets:{ get:async () => "fixture" }, globalStorageUri:{ fsPath:path.join(directory, "private") } }, async () => []);
  const chat = fixtures.conversation({ permissionMode:"allow-all", builtinTools:["read_file"], vscodeTools:[] });
  provider.store = new ApiChatStore(path.join(directory, ".pkm", "state"), fixtures.namespace);
  provider.store.save(chat); provider.chat = chat; provider.chats.set(chat.id, chat);
  provider.publish = () => {}; provider.queueProfileLearning = () => {};
  provider.captureExecution = target => captureExecutionContext(provider.executionHostId, [], directory, true, target.permissionMode);
  const profile = { id:"fixture", label:"Fixture", model:"fixture", status:"active", contextWindow:32768, maxOutputTokens:1024,
    includeUsage:false, outputTokenParameter:"max_tokens" };
  provider.settings = () => ({ provider:"openai-compatible", endpoint:"https://example.test/v1", selectedProfile:profile,
    profiles:[profile], model:"fixture", contextWindow:32768, maxOutputTokens:1024, timeoutMs:10000,
    maxToolRounds:10, loopReviewAfterMs:60000, activityReviewMs:1200000, activityCreditLimit:-1 });
  client.streamApiChat = stream;
  try { await run({ provider, chat }); }
  finally { client.streamApiChat = originalStream; provider.dispose(); fs.rmSync(directory, { recursive:true, force:true }); }
}

test("convergence stop diagnostics survive the actual Host callback and preserve the first-recovery boundary", async () => {
  const genericGoalFailure = "The user objective remains open; the response or tool budget ended without verified acceptance or a concrete blocker.";
  for (const kind of ["first-recovery", "terminal", "generic", "debug-terminal"]) {
    let decisions = [];
    await withHostSummaryBudgetFixture(async (request, onText) => {
      await request.beforeRound(request.messages, 1024);
      onText("Partial diagnostic output.");
      request.onTool({ id:"convergence-evidence", name:"read_file", arguments:'{"path":"fixture"}', status:"complete", result:"RETAINED_CONVERGENCE_EVIDENCE" });
      if (kind !== "generic") {
        decisions.push(await request.onToolLoopNotice({ reason:"repeated-failure", rounds:13, repeats:2 }, request.signal));
        if (["terminal", "debug-terminal"].includes(kind))
          decisions.push(await request.onToolLoopNotice({ reason:"no-progress", rounds:16, repeats:3 }, request.signal));
      }
    }, async ({ provider, chat }) => {
      const input = kind === "debug-terminal" ? "Please debug this issue." : "Start a new task: Verify terminal convergence diagnostics.";
      await provider.send(input, chat);
      const saved = provider.store.load(chat.id, false), reply = saved.messages.at(-1);
      assert.equal(reply.status, "failed");
      assert.equal(reply.content, "Partial diagnostic output.");
      assert.equal(reply.toolCalls.find(call => call.id === "convergence-evidence")?.result, "RETAINED_CONVERGENCE_EVIDENCE");
      if (kind === "terminal" || kind === "debug-terminal") {
        assert.deepEqual(decisions, ["continue", "summarize"]);
        assert.equal(saved.workGoal?.status, kind === "terminal" ? "interrupted" : undefined);
        assert.equal(saved.debugRequest?.status, kind === "debug-terminal" ? "investigating" : undefined);
        assert.match(reply.error, /Inference convergence stop: no-progress; round 16, repeats 3\./);
        assert.match(reply.error, /Completed tool results and partial output are retained/);
        assert.match(reply.error, kind === "terminal" ? /objective remains unresolved/ : /debug request remains unresolved/);
        assert.match(reply.error, /reconcile recorded results before an explicit next attempt/);
        assert.match(reply.error, /No automatic continuation will occur/);
      } else {
        if (kind === "first-recovery") assert.deepEqual(decisions, ["continue"]);
        assert.equal(reply.error, genericGoalFailure, "nonterminal recovery and ordinary incomplete work keep the existing diagnostic");
        assert.doesNotMatch(reply.error, /Inference convergence stop/);
        assert.equal(saved.workGoal.status, "interrupted");
      }
    });
  }
});

test("Host summary-budget stop report is bounded, truthful, and excludes raw tool bodies", () => {
  const { hostBudgetStopReport } = require("../dist/chat/chat-memory");
  const reply = { id:randomUUID(), toolCalls:Array.from({ length:49 }, (_, i) => ({
    id:`ID-${i}-${"🧪".repeat(500)}`, name:`NAME-${i}-${"🪷".repeat(500)}`,
    status:i < 13 ? "complete" : i < 30 ? "failed" : "running",
    arguments:`RAW_ARGUMENT_${i}_${"🧭".repeat(1500)}`, result:`RAW_RESULT_${i}_${"🧬".repeat(1500)}`,
  })) };
  const original = structuredClone(reply), report = hostBudgetStopReport(reply, { summaryNotSent:true });
  assert(Buffer.byteLength(report, "utf8") <= 12000);
  for (const [label, count] of [["complete",13], ["failed",17], ["unresolved",19]])
    assert.match(report, new RegExp(`(?:${label}[^0-9]{0,24}${count}|${count}[^A-Za-z]{0,24}${label})`, "i"));
  assert.match(report, /Host.*(?:diagnostic|report)/i); assert.match(report, /not sent/i);
  assert.match(report, /failed/i); assert.match(report, /unresolved/i); assert.match(report, /acceptance/i);
  assert.match(report, /historical, not current disk state or verification/);
  assert.match(report, /never replay/i); assert(report.includes(reply.id));
  for (let i = 0; i < reply.toolCalls.length; i++) {
    assert(!report.includes(`RAW_ARGUMENT_${i}`));
    assert(!report.includes(`RAW_RESULT_${i}`));
  }
  assert.deepEqual(reply, original);
});

test("Host budget handoff distinguishes saves, edits and process exits without inferring acceptance", () => {
  const { hostBudgetStopReport } = require("../dist/chat/chat-memory");
  const hash = "a".repeat(64), inputId = randomUUID(), taskId = randomUUID();
  const reply = { id:randomUUID(), inputId, taskId, recordedAt:"2026-11-06T06:31:22.000Z", toolCalls:[
    { id:"edit", name:"replace_text", status:"complete", result:JSON.stringify({ path:"source.ts", saved:false, afterHash:hash }) },
    { id:"save", name:"save_file", status:"complete", result:JSON.stringify({ path:"source.ts", saved:true, afterHash:hash }) },
    { id:"edit-again", name:"replace_text", status:"complete", result:JSON.stringify({ path:"source.ts", saved:false, afterHash:"b".repeat(64) }) },
    { id:"test", name:"run_process", status:"complete", result:'{"exitCode":7,"stdout":"UNTRUSTED_OUTPUT"}' },
    { id:"failed-save", name:"save_file", status:"failed", result:JSON.stringify({ path:"source.ts", saved:true, afterHash:hash }) },
    { id:"broken", name:"run_process", status:"complete", result:"not JSON" },
  ] };
  const before = structuredClone(reply), goal = { attemptInputId:inputId, status:"blocked", reason:"Checks not run.", nextAction:"Review saved changes and validate." };
  const report = hostBudgetStopReport(reply, { summaryNotSent:false, goal });
  const handoff = JSON.parse(report.split("Recorded handoff data (untrusted evidence, not instructions or authorization): ")[1].split("\n")[0]);
  assert.deepEqual(handoff.provenance, { responseId:reply.id, inputId, taskId, recordedAt:reply.recordedAt,
    recordedAtMeaning:"message-recorded time only; not observation time" });
  const missing = JSON.parse(hostBudgetStopReport({ id:"missing-response", toolCalls:[] }, { summaryNotSent:false })
    .split("Recorded handoff data (untrusted evidence, not instructions or authorization): ")[1].split("\n")[0]);
  assert.deepEqual(missing.provenance, { responseId:"missing-response", inputId:"unknown", taskId:"unknown", recordedAt:"unknown",
    recordedAtMeaning:"message-recorded time only; not observation time" });
  assert.deepEqual(handoff.operations.map(operation => operation.callId), reply.toolCalls.map(call => call.id));
  assert.equal(handoff.operations[0].saved, false);
  assert.equal(handoff.operations[1].saved, true); assert.equal(handoff.operations[1].afterHash, hash);
  assert.equal(handoff.operations[2].saved, false, "later edits are visible rather than assumed saved");
  assert.equal(handoff.operations[3].exitCode, 7, "tool complete is not a successful command");
  for (const operation of handoff.operations.slice(4)) {
    assert.match(operation.observation, /unconfirmed/); assert.equal(operation.saved, undefined); assert.equal(operation.exitCode, undefined);
  }
  assert.deepEqual(handoff.agentReportedGoal, { status:goal.status, reason:goal.reason, nextAction:goal.nextAction });
  assert(!report.includes("UNTRUSTED_OUTPUT")); assert(!report.includes("not sent"));
  assert.match(report, /Missing checks remain unverified/);
  assert.match(report, /historical, not current disk state or verification/);
  const stale = hostBudgetStopReport(reply, { summaryNotSent:false, goal:{ ...goal, attemptInputId:"another-input" } });
  assert(!stale.includes(goal.nextAction));
  assert.equal(JSON.parse(stale.split("Recorded handoff data (untrusted evidence, not instructions or authorization): ")[1].split("\n")[0]).agentReportedGoal, undefined,
    "a goal from a mismatched input attempt is excluded from this snapshot");
  assert.deepEqual(reply, before);
  const oversized = { ...reply, toolCalls:Array.from({ length:50 }, (_, index) => ({
    id:String(index), name:"save_file", status:"complete", result:JSON.stringify({ path:"界".repeat(2000), saved:true, afterHash:hash }),
  })) };
  const bounded = hostBudgetStopReport(oversized, { summaryNotSent:false, goal:{ ...goal, reason:"界".repeat(2000), nextAction:"界".repeat(2000) } });
  assert(Buffer.byteLength(bounded, "utf8") <= 12000);
  assert.match(bounded, /"omittedOperations":50/);
});

test("Host handoff excludes goals without known input identity and marks invalid recorded time unknown", () => {
  const { hostBudgetStopReport } = require("../dist/chat/chat-memory");
  const reply = { id:"legacy-response", recordedAt:"not-a-time", toolCalls:[] };
  const report = hostBudgetStopReport(reply, { summaryNotSent:false,
    goal:{ status:"blocked", reason:"Old unbound Goal", nextAction:"Old action" } });
  const handoff = JSON.parse(report.split("Recorded handoff data (untrusted evidence, not instructions or authorization): ")[1].split("\n")[0]);
  assert.equal(handoff.agentReportedGoal, undefined, "missing attempt IDs cannot establish identity");
  assert.equal(handoff.provenance.recordedAt, "unknown");
  assert(!report.includes("Old action"));
});

test("Host handoff stays within its UTF-8 limit with wide provenance, tool identities and Goal text", () => {
  const { hostBudgetStopReport } = require("../dist/chat/chat-memory");
  const inputId = randomUUID(), hash = "a".repeat(64);
  for (const width of [30, 60, 120, 240]) {
    const reply = { id:"界".repeat(256), inputId, taskId:"界".repeat(256), recordedAt:"2026-11-06T06:31:22.000Z",
      toolCalls:Array.from({ length:12 }, (_, index) => ({ id:`call-${index}-${"界".repeat(width)}`, name:"save_file", status:"complete",
        result:JSON.stringify({ path:"界".repeat(300), afterHash:hash, saved:true }) })) };
    const before = structuredClone(reply);
    const report = hostBudgetStopReport(reply, { summaryNotSent:false,
      goal:{ attemptInputId:inputId, status:"blocked", reason:"界".repeat(600), nextAction:"界".repeat(600) } });
    assert(Buffer.byteLength(report, "utf8") <= 12000, `wide identity width ${width} exceeded the byte limit`);
    assert.deepEqual(reply, before);
  }
});

test("Host handoff validates calendar correctness and canonical producer timestamps", () => {
  const { hostBudgetStopReport } = require("../dist/chat/chat-memory");
  const parse = report => JSON.parse(report.split("Recorded handoff data (untrusted evidence, not instructions or authorization): ")[1].split("\n")[0]);
  for (const [recordedAt, expected] of [
    ["2026-02-30T12:00:00.000Z", "unknown"],
    ["2025-02-29T12:00:00.000Z", "unknown"],
    ["2026-04-31T12:00:00.000Z", "unknown"],
    ["2026-11-06T24:00:00.000Z", "unknown"],
    ["2026-11-06", "unknown"], ["November 6, 2026", "unknown"],
    ["2026-11-06T06:31:22Z", "unknown"],
    ["2026-11-06T07:31:22.000+01:00", "unknown"],
    [undefined, "unknown"], ["not-a-time", "unknown"],
    ["2024-02-29T12:00:00.000Z", "2024-02-29T12:00:00.000Z"],
    ["2026-11-06T06:31:22.000Z", "2026-11-06T06:31:22.000Z"],
    [new Date(0).toISOString(), new Date(0).toISOString()],
    [new Date(-62198755200000).toISOString(), new Date(-62198755200000).toISOString()],
  ]) {
    const reply = { id:"fixture", recordedAt, toolCalls:[] }, before = structuredClone(reply);
    assert.equal(parse(hostBudgetStopReport(reply, { summaryNotSent:false })).provenance.recordedAt, expected, String(recordedAt));
    assert.deepEqual(reply, before, "source provenance is never rewritten");
  }
});

test("Host handoff bounds serialized escaped Goal and identity bytes without changing receipts", () => {
  const { hostBudgetStopReport } = require("../dist/chat/chat-memory");
  const parse = report => JSON.parse(report.split("Recorded handoff data (untrusted evidence, not instructions or authorization): ")[1].split("\n")[0]);
  // Exact independent audit counterexample: 13,046 UTF-8 bytes before the fix.
  const inputId = "fixture-input";
  const reply = { id:"r", inputId, toolCalls:Array.from({ length:12 }, (_, i) => ({
    id:"c" + i + "x".repeat(100), name:"save_file", status:"complete",
    arguments:'{"raw":"preserve me"}', result:JSON.stringify({ path:"x".repeat(700), saved:true, afterHash:"a".repeat(64) }),
  })) };
  const goal = { attemptInputId:inputId, status:"blocked", reason:"\u0000".repeat(600), nextAction:"\u0000".repeat(600) };
  const before = structuredClone({ reply, goal });
  const report = hostBudgetStopReport(reply, { summaryNotSent:false, goal });
  assert(Buffer.byteLength(report, "utf8") <= 12000, `original escaped probe: ${Buffer.byteLength(report, "utf8")} bytes`);
  assert.equal(parse(report).agentReportedGoal.status, "blocked");
  assert.match(report, /bounded|omitted/i, "derived truncation must be explicit");
  assert.deepEqual({ reply, goal }, before);
  for (const text of ["\u0000", "\u001f", '"', "\\", "界", "🧪", "\ud800"]) {
    const matchingGoal = { ...goal, reason:text.repeat(600), nextAction:text.repeat(600) };
    const matchingReport = hostBudgetStopReport(reply, { summaryNotSent:false, goal:matchingGoal });
    assert(Buffer.byteLength(matchingReport, "utf8") <= 12000, `matching Goal ${JSON.stringify(text)} exceeded byte limit`);
    assert.equal(parse(matchingReport).agentReportedGoal.status, "blocked");
    assert.deepEqual(reply, before.reply);
    const fixture = { ...reply, id:text.repeat(256), inputId:text.repeat(256), taskId:text.repeat(256),
      toolCalls:reply.toolCalls.map(call => ({ ...call, id:text.repeat(256), result:JSON.stringify({ path:text.repeat(700), saved:true, afterHash:"a".repeat(64) }) })) };
    for (const status of ["blocked", text.repeat(600)]) {
      const currentGoal = { attemptInputId:fixture.inputId, status, reason:text.repeat(600), nextAction:text.repeat(600) };
      const original = structuredClone({ fixture, currentGoal });
      const bounded = hostBudgetStopReport(fixture, { summaryNotSent:true, goal:currentGoal });
      assert(Buffer.byteLength(bounded, "utf8") <= 12000, `escaped ${JSON.stringify(text)} exceeded byte limit`);
      assert.match(bounded, /this request failed/);
      assert.match(bounded, /complete=12, failed=0, unresolved=0/);
      assert.equal(parse(bounded).operations.length + parse(bounded).omittedOperations, 12);
      assert.deepEqual({ fixture, currentGoal }, original);
    }
  }
});

test("ApiChatView persists handoff only for typed budget failure, not cancellation or lookalike errors", async () => {
  const { CopilotSdkSummaryBudgetError } = require("../dist/chat/api-chat-copilot-sdk");
  const { ChatBudgetExceededError, checkReportedOutput } = require("../dist/chat/api-chat-models");
  const { hostBudgetStopReport, readChatToolEvidence } = require("../dist/chat/chat-memory");
  const budgetText = "Final summary was not sent because it exceeds the input budget.";
  for (const kind of ["typed", "input", "output", "blocked", "generic", "cancel"]) {
    let provider, streamCalls = 0;
    const events = [
      { id:randomUUID(), name:"run_process", arguments:'{"command":"fixture"}', status:"complete", result:'{"exitCode":7}' },
      { id:randomUUID(), name:"read_file", arguments:'{"path":"fixture"}', status:"failed", result:"fixture failure" },
      { id:randomUUID(), name:"read_file", arguments:`{"raw":"${"🧪".repeat(900)}"}`, status:"complete", result:`RAW_RESULT_${"🧬".repeat(900)}` },
    ];
    const originalEvents = structuredClone(events);
    await withHostSummaryBudgetFixture(async (request, onText) => {
      streamCalls++;
      for (const event of events) request.onTool(event);
      if (!["input", "output", "blocked"].includes(kind)) request.onHardToolRoundLimit({ limit:1, rounds:1 });
      onText("existing partial output");
      if (kind === "cancel") provider.running.get(provider.chat.id).abort();
      if (kind === "blocked") {
        const chat = provider.chats.get(provider.chat.id);
        const reporting = request.tools.find(tool => tool.name === "report_work");
        assert(reporting, "the actual Host reporting tool is enabled for the active objective");
        await reporting.execute({ status:"blocked", reason:"Saved patch is unverified.", nextAction:"Run the focused checks before review.",
          sourceInputIds:require("../dist/chat/chat-work-goal").workGoalInputs(chat),
          acceptance:chat.workGoal.acceptance.map(item => ({ ...item, verified:false, evidenceCallIds:[] })),
        }, request.signal);
        throw new ChatBudgetExceededError("Input budget exceeded before final response.", "input");
      }
      if (kind === "input") throw new ChatBudgetExceededError("Input budget exceeded before next round.", "input");
      if (kind === "output") checkReportedOutput({ inputTokens:10, outputTokens:1025 }, 1024);
      throw kind === "generic" ? new Error(budgetText) : new CopilotSdkSummaryBudgetError(budgetText);
    }, async context => {
      provider = context.provider;
      await provider.send("Start a new task: Implement and test the bounded summary failure handling.", context.chat);
      assert.equal(streamCalls, 1, "the fixture reached the actual Host transport boundary");
      const saved = provider.store.load(context.chat.id, false), reply = saved.messages.at(-1);
      const report = hostBudgetStopReport(reply, { summaryNotSent:kind === "typed", goal:saved.workGoal });
      assert.equal(reply.status, kind === "cancel" ? "cancelled" : "failed"); assert(reply.error);
      assert.equal(saved.workGoal.status, kind === "cancel" ? "paused" : kind === "blocked" ? "blocked" : "interrupted");
      assert(reply.content.startsWith("existing partial output"));
      if (["typed", "input", "output", "blocked"].includes(kind)) { assert(reply.content.includes(report)); assert.match(reply.content, /Host.*(?:diagnostic|report)/i); }
      else assert.equal(reply.content, "existing partial output");
      assert(!/tests? passed|command succeeded|task accepted/i.test(reply.content));
      assert.deepEqual(reply.toolCalls.map(({ id, name, arguments: args, status, result }) => ({ id, name, arguments:args, status, result })), originalEvents);
      if (kind === "blocked") {
        assert(reply.content.includes("Saved patch is unverified."));
        assert(reply.content.includes("Run the focused checks before review."));
      }
      if (["typed", "input", "output", "blocked"].includes(kind)) {
        assert.equal(JSON.parse(readChatToolEvidence(saved, reply.id, { callId:events[0].id, messageId:reply.id })).content, events[0].result);
        assert.equal(streamCalls, 1, "reading persisted evidence does not replay tools or call the provider");
      }
    });
  }
});
