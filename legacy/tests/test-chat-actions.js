const assert = require("node:assert/strict");
const { test } = require("node:test");
const Module = require("module");
const load = Module._load;
Module._load = function (name, ...args) { return name === "vscode" ? {} : load.call(this, name, ...args); };
const { createChatActionTools } = require("../dist/chat/chat-actions");
const { createBuiltinTools } = require("../dist/chat/api-chat-tools");
const { questionSchema, validateQuestionAnswer } = require("../dist/chat/chat-questions");
const { ApiChatView } = require("../dist/chat/api-chat-view");
const { streamApiChat } = require("../dist/chat/api-chat-client");
const { createVscodeTools } = require("../dist/chat/api-chat-mcp");
Module._load = load;

const runId = "action_run_" + "a".repeat(32);
const schema = { type: "object", properties: { alias: { type: "string", minLength: 1, maxLength: 80 } }, required: ["alias"] };
function tools(request, extra = {}) {
  return createChatActionTools({ enabled: ["run_action", "find_actions"], request,
    ask: async () => ({ alias: "research-agent" }), approve: async () => true,
    progress() {}, assertActive() {}, keyPrefix: "chat:fixture", ...extra });
}
const launch = { action_id: "core.delay", inputs: { seconds: 30 }, content_hash: "revision", idempotency_key: "once" };

test("inline ask_user supports a typed form without native dialogs", async () => {
  let asked = 0;
  const [ask] = createBuiltinTools(["ask_user"], { workspace: { isTrusted: true }, window: {
    showQuickPick() { throw Error("Native UI must not be used."); }, showInputBox() { throw Error("Native UI must not be used."); },
  } }, undefined, undefined, undefined, [], undefined, async (prompt, fields) => {
    asked++; assert.equal(prompt, "Choose alias"); assert.deepEqual(fields, schema); return { alias: "research-agent" };
  });
  assert.deepEqual(JSON.parse(await ask.execute({ question: "Choose alias", answer_schema: schema }, new AbortController().signal)),
    { answer: { alias: "research-agent" }, cancelled: false });
  assert.equal(asked, 1);
  assert.throws(() => validateQuestionAnswer(questionSchema(schema), { alias: "" }), /invalid/i);
  assert.throws(() => validateQuestionAnswer(questionSchema(schema), { alias: "ok", unknown: true }), /unknown/);
  assert.throws(() => questionSchema({ type: "object", properties: { nested: { type: "object" } } }), /Unsupported/);
  const fields = questionSchema({ type: "object", properties: { n: { type: "integer", minimum: 1 },
    choices: { type: "array", items: { type: "string", enum: ["a", "b"] } }, yes: { type: "boolean" } } });
  assert.throws(() => validateQuestionAnswer(fields, { n: 1.1 }), /Invalid/);
  assert.throws(() => validateQuestionAnswer(fields, { choices: ["unexpected"] }), /Invalid/);
  assert.deepEqual(validateQuestionAnswer(fields, { n: 1, choices: ["a"], yes: false }), { n: 1, choices: ["a"], yes: false });
});

test("durable wait returns the original Run to the agent without resubmission", async () => {
  const calls = []; let reads = 0;
  const [run] = tools(async (method, params) => {
    calls.push({ method, params });
    if (method === "definition_get") return { content_hash: "revision", effects: ["pure"] };
    if (method === "platform_call") return { run_id: runId, state: "waiting" };
    if (method === "checkpoints") return { checkpoints: [] };
    if (method === "run") return ++reads === 1 ? { run_id: runId, state: "waiting" }
      : { run_id: runId, state: "succeeded", execution_ok: true, output: { seconds: 30 } };
    return { ok: true };
  }).filter(tool => tool.name === "run_action");
  const result = JSON.parse(await run.execute(launch, new AbortController().signal));
  assert.equal(result.run_id, runId); assert.equal(result.state, "succeeded");
  assert.deepEqual(result.output, { seconds: 30 });
  assert.equal(calls.filter(item => item.method === "platform_call").length, 1);
  assert.equal(calls.find(item => item.method === "platform_call").params.idempotency_key, "chat:fixture:once");
  assert.equal(calls.filter(item => item.method === "safety_scan").length, 2);
});

test("form response verifies the schema before binding the exact checkpoint", async () => {
  const calls = [];
  const checkpoint = { run_id: runId, checkpoint_id: "checkpoint_exact", resume_token: "resume_exact",
    proposal_digest: "digest_exact", state: "waiting", owner: "user", answer_schema: schema,
    proposal: { prompt: "Choose alias" }, kind: "input" };
  const run = tools(async (method, params) => {
    calls.push({ method, params });
    if (method === "definition_get") return { content_hash: "revision", effects: ["human-input"] };
    if (method === "platform_call") return { run_id: runId, state: "waiting" };
    if (method === "checkpoints") return { checkpoints: [checkpoint] };
    if (method === "run") return { run_id: runId, state: "succeeded", output: { value: { alias: "research-agent" } } };
    return { ok: true };
  }, { ask: async (prompt, fields, signal, verify) => {
    assert.equal(prompt, "Choose alias"); await verify({ alias: "research-agent" }); return { alias: "research-agent" };
  } }).find(tool => tool.name === "run_action");
  const result = JSON.parse(await run.execute(launch, new AbortController().signal));
  assert.equal(result.output.value.alias, "research-agent");
  const response = calls.find(item => item.method === "respond_checkpoint").params;
  assert.deepEqual(response, { run_id: runId, checkpoint_id: checkpoint.checkpoint_id, resume_token: checkpoint.resume_token,
    proposal_digest: checkpoint.proposal_digest, answer: { alias: "research-agent" }, event_key: "chat-answer:checkpoint_exact" });
  assert(calls.findIndex(item => item.method === "check_checkpoint_answer") < calls.findIndex(item => item.method === "respond_checkpoint"));
});

test("attaching or cancelling never launches a replacement; failures are not success-shaped", async () => {
  const calls = [];
  const run = tools(async (method, params) => {
    calls.push({ method, params });
    return { run_id: runId, state: "failed", ok: true, execution_ok: false, error: "query failed" };
  }).find(tool => tool.name === "run_action");
  const result = JSON.parse(await run.execute({ run_id: runId }, new AbortController().signal));
  assert.equal(result.ok, false); assert.equal(result.error, "query failed");
  assert.deepEqual(calls.map(item => item.method), ["run"]);
  const signal = new AbortController(); let started = false; const cancelled = [];
  const pending = tools(async (method, params) => {
    if (method === "definition_get") return { content_hash: "revision" };
    if (method === "platform_call") { started = true; setTimeout(() => signal.abort(), 30); return { run_id: runId, state: "waiting" }; }
    if (method === "checkpoints") return { checkpoints: [] };
    if (method === "cancel_run") cancelled.push(params.run_id);
    return {};
  }).find(tool => tool.name === "run_action");
  await assert.rejects(pending.execute(launch, signal.signal), /original Run/);
  assert(started); assert.deepEqual(cancelled, [runId]);
  const submitting = new AbortController(); const acknowledged = [];
  const slowSubmission = tools(async (method, params) => {
    if (method === "definition_get") return { content_hash: "revision" };
    if (method === "platform_call") {
      submitting.abort();
      await new Promise(resolve => setTimeout(resolve, 20));
      return { run_id: runId, state: "running" };
    }
    if (method === "cancel_run") acknowledged.push(params.run_id);
    return {};
  }).find(tool => tool.name === "run_action");
  await assert.rejects(slowSubmission.execute(launch, submitting.signal), /original Run/);
  assert.deepEqual(acknowledged, [runId], "cancellation during dispatch must still capture and cancel the committed Run");
});

test("actual host decision handler retains invalid forms and rejects stale owners", async () => {
  const controller = new AbortController(); let resolved;
  const chat = { id: "chat", progress: { attemptId: "current" } };
  const decision = { chat, choices: [{ value: "submit" }, { value: "cancel" }], form: schema,
    signal: controller.signal, ownerSignal: controller.signal, attemptId: "current", executionContext: {},
    resolve(value) { resolved = value; } };
  const host = { disposed: false, initialize() {}, chat, decisions: new Map([["form", decision]]),
    running: new Map([["chat", controller]]), store: { assertAvailable() {} }, assertExecution() {}, assertRunnable() {}, publish() {} };
  await assert.rejects(ApiChatView.prototype.handle.call(host, { type: "decision", id: "form", value: "submit", answer: { alias: "" } }), /invalid/i);
  assert(host.decisions.has("form")); assert.equal(resolved, undefined);
  decision.verify = async () => { throw Error("Backend schema rejected this answer."); };
  await assert.rejects(ApiChatView.prototype.handle.call(host, { type: "decision", id: "form", value: "submit", answer: { alias: "good" } }), /Backend schema/);
  assert(host.decisions.has("form"));
  delete decision.verify;
  await ApiChatView.prototype.handle.call(host, { type: "decision", id: "form", value: "submit", answer: { alias: "research-agent" } });
  assert.deepEqual(JSON.parse(resolved), { alias: "research-agent" });
  host.decisions.set("form", { ...decision, attemptId: "old" });
  await assert.rejects(ApiChatView.prototype.handle.call(host, { type: "decision", id: "form", value: "submit", answer: { alias: "wrong-owner" } }), /different Chat attempt/);
});

test("actual Chatroom join preparation replaces a guessed alias before native tool dispatch", async () => {
  const fs = require("node:fs");
  const path = require("node:path");
  const ts = require("typescript");
  const vm = require("node:vm");
  const source = ts.createSourceFile("api-chat-view.ts", fs.readFileSync(path.join(__dirname, "../src/chat/api-chat-view.ts"), "utf8"),
    ts.ScriptTarget.Latest, true);
  let initializer;
  function visit(node) { if (ts.isVariableDeclaration(node) && node.name.getText(source) === "prepareChatroomJoin") initializer = node.initializer; ts.forEachChild(node, visit); }
  visit(source); assert(initializer);
  let asks = 0, dispatches = 0, captured;
  const request = async method => method === "definition_get" ? { content_hash: "revision" }
    : method === "platform_call" ? { run_id: runId, state: "waiting" }
    : method === "checkpoints" ? { checkpoints: [{ run_id: runId, checkpoint_id: "checkpoint_alias", resume_token: "token",
      proposal_digest: "digest", state: "waiting", owner: "user", answer_schema: schema, proposal: { prompt: "Choose alias" } }] }
    : method === "run" ? { run_id: runId, state: "succeeded", output: { value: { alias: "user-chosen" } } } : { ok: true };
  const options = { enabled: ["run_action"], request, approve: async () => true, progress() {}, assertActive() {}, keyPrefix: "fixture",
    ask: async (prompt, fields, signal, verify) => { asks++; await verify({ alias: "user-chosen" }); return { alias: "user-chosen" }; } };
  const context = { extension: {}, actionRequest: async () => ({ content_hash: "revision" }),
    createChatActionTools, actionOptions: options, randomUUID: () => "fixture-unique-key" };
  vm.runInNewContext(ts.transpileModule("this.prepare = " + initializer.getText(source), {
    compilerOptions: { target: ts.ScriptTarget.ES2020, module: ts.ModuleKind.CommonJS },
  }).outputText, context);
  class Text { constructor(value) { this.value = value; } }
  const host = { workspace: { isTrusted: true }, LanguageModelTextPart: Text,
    CancellationTokenSource: class { token = {}; cancel() {} dispose() {} },
    lm: { tools: [{ name: "mcp_pkm_chat_join", description: "Join", inputSchema: { type: "object" } }],
      invokeTool: async (name, options) => { dispatches++; captured = options.input; return { content: [new Text("joined")] }; } } };
  const native = createVscodeTools(["mcp_pkm_chat_join"], host, async () => {}, context.prepare);
  const signal = new AbortController().signal;
  await native[0].execute({ query: "chat_join" }, signal);
  await native[1].execute({ name: "mcp_pkm_chat_join", input: { magic_link: "isolated-fixture", name: "model-guessed" } }, signal);
  assert.equal(asks, 1); assert.equal(dispatches, 1); assert.equal(captured.name, "user-chosen");
  options.ask = async () => undefined;
  const cancelled = createVscodeTools(["mcp_pkm_chat_join"], host, async () => {}, context.prepare);
  await cancelled[0].execute({ query: "chat_join" }, signal);
  await assert.rejects(cancelled[1].execute({ name: "mcp_pkm_chat_join", input: { magic_link: "other-isolated-fixture", name: "guessed" } }, signal), /Joining cancelled/);
  assert.equal(dispatches, 1, "cancelled alias collection must never dispatch chat_join");
});

test("scripted agent receives a real worker's final result and human alias on the original Run", async () => {
  const fs = require("node:fs");
  const path = require("node:path");
  const os = require("node:os");
  const { execFile } = require("node:child_process");
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "pkm-native-actions-"));
  const store = path.join(temporary, "store");
  const root = path.resolve(__dirname, "..");
  const python = require("./dev-paths").testPython;
  const execute = (args, input) => new Promise((resolve, reject) => {
    const process = execFile(python, [path.join(root, "resources/action_modules.py"), ...args],
      { timeout: 30000, maxBuffer: 2 * 1024 * 1024 }, (error, stdout, stderr) => {
        if (error) return reject(Error(`${error.message}\n${stderr}`));
        try { const value = JSON.parse(stdout); if (value.ok === false) throw Error(value.error); resolve(value); }
        catch (failure) { reject(failure); }
      });
    process.stdin.end(input === undefined ? "" : JSON.stringify(input));
  });
  const calls = [];
  const request = async (method, params) => { calls.push({ method, params }); return execute(["--api", store], { method, params }); };
  try {
    await execute(["--configure-workspace", store, temporary]);
    const definition = await request("definition_get", { action_id: "core.delay" });
    let round = 0, observed, text = "";
    const liveTools = tools(request, { ask: async (prompt, schema, signal, verify) => {
      const answer = { alias: "chosen-by-user" }; await verify(answer); return answer;
    } });
    const toolEvent = call => `data: ${JSON.stringify({ choices: [{ delta: { tool_calls: [call] }, finish_reason: null }] })}\n\n`;
    const done = reason => `data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: reason }] })}\n\ndata: [DONE]\n\n`;
    await streamApiChat({ provider: "openai-compatible", endpoint: "https://fixture.invalid/v1", apiKey: "fixture",
      model: "scripted-no-network", signal: new AbortController().signal, tools: liveTools,
      messages: [{ role: "user", content: "Wait and return the final result." }], timeoutMs: 1000, loopReviewAfterMs: 60000,
      fetch: async (url, init) => {
        if (round++ === 0) return new Response(toolEvent({ index: 0, id: "wait-once", type: "function",
          function: { name: "run_action", arguments: JSON.stringify({ action_id: "core.delay", inputs: { seconds: 0.15 },
            content_hash: definition.content_hash, idempotency_key: "native-wait" }) } }) + done("tool_calls"),
          { headers: { "Content-Type": "text/event-stream" } });
        const payload = JSON.parse(init.body);
        observed = JSON.parse(payload.messages.find(message => message.role === "tool").content);
        assert.equal(observed.state, "succeeded");
        return new Response(`data: ${JSON.stringify({ choices: [{ delta: { content: "Completed " + observed.run_id }, finish_reason: null }] })}\n\n` + done("stop"),
          { headers: { "Content-Type": "text/event-stream" } });
      } }, delta => { text += delta; });
    assert(text.includes(observed.run_id));
    assert.deepEqual(observed.output, { seconds: 0.15 });
    const alias = await request("definition_get", { action_id: "core.chatroom-alias" });
    const aliasResult = JSON.parse(await liveTools.find(tool => tool.name === "run_action").execute({
      action_id: "core.chatroom-alias", inputs: { room: "isolated-room" }, content_hash: alias.content_hash,
      idempotency_key: "native-alias" }, new AbortController().signal));
    assert.equal(aliasResult.state, "succeeded");
    assert.deepEqual(aliasResult.output, { value: { alias: "chosen-by-user" } });
    assert.equal(calls.filter(call => call.method === "platform_call").length, 2);
    assert.equal(calls.filter(call => call.method === "respond_checkpoint").length, 1);
  } finally {
    await new Promise(resolve => setTimeout(resolve, 200));
    fs.rmSync(temporary, { recursive: true, force: true });
  }
});
