const { test } = require("node:test");
const assert = require("node:assert/strict");
const Module = require("node:module"), fs = require("node:fs"), os = require("node:os"), path = require("node:path"), http = require("node:http");
const { randomUUID } = require("node:crypto");
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
