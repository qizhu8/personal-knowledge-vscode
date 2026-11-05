const { test } = require("node:test");
const assert = require("node:assert/strict");
const Module = require("node:module"), fs = require("node:fs"), os = require("node:os"), path = require("node:path"), http = require("node:http");
const { randomUUID } = require("node:crypto");
const { executeMemoryOperation } = require("../dist/capabilities/memory-operations");
const fixtures = require("./fixtures/chat-context");
const host = {
  env: { language: "en" }, lm: { tools: [] },
  window: { showInformationMessage: async () => undefined, showWarningMessage: async () => undefined, showErrorMessage: async () => undefined },
  workspace: { isTrusted: true, workspaceFolders: [], getConfiguration: () => ({ get: (name, fallback) =>
    name === "apiChatCapabilityProfile" ? "compact" : fallback }) },
};
const load = Module._load;
let ApiChatView, ApiChatStore, captureExecutionContext;
try {
  Module._load = function(name, ...args) { return name === "vscode" ? host : load.call(this, name, ...args); };
  ({ ApiChatView } = require("../dist/chat/api-chat-view"));
  ({ ApiChatStore } = require("../dist/chat/api-chat-store"));
  ({ captureExecutionContext } = require("../dist/chat/execution-context"));
} finally { Module._load = load; }

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
      decisions.push({ title, detail: JSON.parse(detail) });
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
    assert.equal(decisions[0].detail.storedContent, "Project conventions belong in explicit Memory.");
    assert.equal(decisions[0].detail.storedSources[0].revision, "r1");
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

test("Host summary-budget stop report is bounded, truthful, and excludes raw tool bodies", () => {
  const { hostSummaryBudgetStopReport } = require("../dist/chat/chat-memory");
  const reply = { id:randomUUID(), toolCalls:Array.from({ length:49 }, (_, i) => ({
    id:`ID-${i}-${"🧪".repeat(500)}`, name:`NAME-${i}-${"🪷".repeat(500)}`,
    status:i < 13 ? "complete" : i < 30 ? "failed" : "running",
    arguments:`RAW_ARGUMENT_${i}_${"🧭".repeat(1500)}`, result:`RAW_RESULT_${i}_${"🧬".repeat(1500)}`,
  })) };
  const original = structuredClone(reply), report = hostSummaryBudgetStopReport(reply);
  assert(Buffer.byteLength(report, "utf8") <= 12000);
  for (const [label, count] of [["complete",13], ["failed",17], ["unresolved",19]])
    assert.match(report, new RegExp(`(?:${label}[^0-9]{0,24}${count}|${count}[^A-Za-z]{0,24}${label})`, "i"));
  assert.match(report, /Host.*(?:diagnostic|report)/i); assert.match(report, /not sent/i);
  assert.match(report, /failed/i); assert.match(report, /unresolved/i); assert.match(report, /acceptance/i);
  assert.match(report, /never replay/i); assert(report.includes(reply.id));
  for (let i = 0; i < reply.toolCalls.length; i++) {
    assert(!report.includes(`RAW_ARGUMENT_${i}`));
    assert(!report.includes(`RAW_RESULT_${i}`));
  }
  assert.deepEqual(reply, original);
});

test("ApiChatView appends the Host stop report only for typed, active summary-budget failure", async () => {
  const { CopilotSdkSummaryBudgetError } = require("../dist/chat/api-chat-copilot-sdk");
  const { hostSummaryBudgetStopReport, readChatToolEvidence } = require("../dist/chat/chat-memory");
  const budgetText = "Final summary was not sent because it exceeds the input budget.";
  for (const kind of ["typed", "generic", "cancel"]) {
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
      request.onHardToolRoundLimit({ limit:1, rounds:1 }); onText("existing partial output");
      if (kind === "cancel") provider.running.get(provider.chat.id).abort();
      throw kind === "generic" ? new Error(budgetText) : new CopilotSdkSummaryBudgetError(budgetText);
    }, async context => {
      provider = context.provider;
      await provider.send("Start a new task: Implement and test the bounded summary failure handling.", context.chat);
      assert.equal(streamCalls, 1, "the fixture reached the actual Host transport boundary");
      const saved = provider.store.load(context.chat.id, false), reply = saved.messages.at(-1), report = hostSummaryBudgetStopReport(reply);
      assert.equal(reply.status, kind === "cancel" ? "cancelled" : "failed"); assert(reply.error);
      assert.equal(saved.workGoal.status, kind === "cancel" ? "paused" : "interrupted");
      assert(reply.content.startsWith("existing partial output"));
      if (kind === "typed") { assert(reply.content.includes(report)); assert.match(reply.content, /Host.*(?:diagnostic|report)/i); }
      else assert.equal(reply.content, "existing partial output");
      assert(!/tests? passed|command succeeded|task accepted/i.test(reply.content));
      assert.deepEqual(reply.toolCalls.map(({ id, name, arguments: args, status, result }) => ({ id, name, arguments:args, status, result })), originalEvents);
      if (kind === "typed") {
        assert.equal(JSON.parse(readChatToolEvidence(saved, reply.id, { callId:events[0].id, messageId:reply.id })).content, events[0].result);
        assert.equal(streamCalls, 1, "reading persisted evidence does not replay tools or call the provider");
      }
    });
  }
});
