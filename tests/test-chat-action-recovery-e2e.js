const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const net = require("net");
const { spawn, execFile } = require("child_process");
const { streamApiChat } = require("../dist/chat/api-chat-client");
const Module = require("module");
const originalLoad = Module._load;
Module._load = function(name, ...args) {
  if (name === "vscode") return {};
  return originalLoad.call(this, name, ...args);
};
const { connectApiChatMcp } = require("../dist/chat/api-chat-mcp");
Module._load = originalLoad;
const { ApiChatStore } = require("../dist/chat/api-chat-store");
const root = path.resolve(__dirname, "..");
const python = require("./dev-paths").testPython;
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const event = delta => `data: ${JSON.stringify({ choices: [{ delta, finish_reason: null }] })}\n\n`;
const finish = reason => `data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: reason }] })}\n\ndata: [DONE]\n\n`;

(async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "pkm-chat-action-e2e-"));
  const store = path.join(directory, "store");
  const reservation = net.createServer();
  await new Promise(resolve => reservation.listen(0, "127.0.0.1", resolve));
  const port = reservation.address().port;
  await new Promise(resolve => reservation.close(resolve));
  const process_ = spawn(python, [path.join(root, "tests/test-action-recovery-e2e.py"), "--serve", store, String(port)],
    { stdio: ["ignore", "ignore", "pipe"] });
  let stderr = "";
  process_.stderr.on("data", value => { stderr = (stderr + value).slice(-8000); });
  let connection;
  const signal = new AbortController();
  try {
    for (let attempt = 0; attempt < 200; attempt++) {
      if (process_.exitCode !== null) throw Error(stderr);
      if (fs.existsSync(path.join(directory, "fixture.json"))) {
        try {
          const response = await fetch(`http://127.0.0.1:${port}/mcp`, { signal: AbortSignal.timeout(500) });
          if (response.status === 406 || response.ok) break;
        } catch {}
      }
      await sleep(50);
    }
    const fixture = JSON.parse(fs.readFileSync(path.join(directory, "fixture.json")));
    const approvals = [], events = [];
    let allowResponse = false;
    connection = await connectApiChatMcp({ id: "fixture", label: "Fixture PKM", enabled: true, tools: [],
      url: `http://127.0.0.1:${port}/mcp` }, 0, undefined, signal.signal, async (name, args) => {
      approvals.push(name);
      if (name.endsWith("action_checkpoint_respond") && !allowResponse) throw Error("Explicit user checkpoint decision required.");
    });
    const tool = remote => {
      const value = connection.tools.find(item => item.remoteName === remote);
      assert(value, remote);
      return value;
    };
    async function api(method, params) {
      return new Promise((resolve, reject) => {
        const child = execFile(python, [path.join(root, "resources/action_modules.py"), "--api", store],
          { timeout: 30000 }, (error, stdout) => {
            if (error) return reject(error);
            try { const result = JSON.parse(stdout); assert.notStrictEqual(result.ok, false, result.error); resolve(result); }
            catch (failure) { reject(failure); }
          });
        child.stdin.end(JSON.stringify({ method, params }));
      });
    }
    let runId, checkpoint, round = 0, text = "";
    const resultValue = encoded => {
      const result = JSON.parse(encoded);
      return result.structuredContent || JSON.parse(result.content.find(item => item.type === "text").text);
    };
    await streamApiChat({ provider: "openai-compatible", endpoint: "https://fixture.invalid/v1", apiKey: "fixture",
      model: "scripted-no-network", messages: [{ role: "user", content: "Start a durable Action and show its exact approval proposal. Do not approve it." }],
      signal: signal.signal, maxToolRounds: 6, tools: connection.tools, onTool: entry => {
        events.push(entry);
        if (entry.status !== "complete") return;
        const result = resultValue(entry.result);
        if (entry.name === tool("action_call").label) runId = result.run_id;
        if (entry.name === tool("action_run_checkpoints").label) checkpoint = result.checkpoints[0];
      }, fetch: async () => {
        let data;
        if (round++ === 0) data = event({ tool_calls: [{ index: 0, id: "launch-once", type: "function", function: {
          name: tool("action_call").name, arguments: JSON.stringify({ action_id: fixture.action_id,
            inputs: {}, idempotency_key: "chat-original-intent", content_hash: fixture.content_hash }) } }] }) + finish("tool_calls");
        else if (round === 2) {
          for (let attempt = 0; attempt < 100; attempt++) {
            if ((await api("run", { run_id: runId })).state === "waiting") break;
            await sleep(20);
          }
          data = event({ tool_calls: [{ index: 0, id: "inspect-checkpoint", type: "function", function: {
            name: tool("action_run_checkpoints").name, arguments: JSON.stringify({ run_id: runId }) } }] }) + finish("tool_calls");
        } else data = event({ content: `Run ${runId} is waiting for your decision. No active worker is held.` }) + finish("stop");
        return new Response(data, { headers: { "Content-Type": "text/event-stream" } });
      } }, delta => { text += delta; });
    assert(runId && checkpoint);
    assert(text.includes(runId));
    assert.strictEqual(checkpoint.kind, "approval");
    assert.strictEqual((await api("run", { run_id: runId })).execution.workerPid, null);
    const response = { run_id: runId, checkpoint_id: checkpoint.checkpoint_id, resume_token: checkpoint.resume_token,
      proposal_digest: checkpoint.proposal_digest, answer: { approved: true }, event_key: "explicit-user-decision" };
    await assert.rejects(tool("action_checkpoint_respond").execute(response, signal.signal), /Explicit user/);
    assert.strictEqual((await api("run", { run_id: runId })).state, "waiting");
    allowResponse = true;
    await assert.rejects(tool("action_checkpoint_respond").execute({ ...response, proposal_digest: "stale" }, signal.signal),
      /execution may already have occurred/);
    assert.strictEqual((await api("run", { run_id: runId })).state, "waiting");
    let responseRound = 0, responseCompleted = false;
    await streamApiChat({ provider: "openai-compatible", endpoint: "https://fixture.invalid/v1", apiKey: "fixture",
      model: "scripted-no-network", signal: signal.signal, tools: connection.tools,
      messages: [{ role: "user", content: `I approve the exact proposal ${checkpoint.proposal_digest} for ${runId}. Continue that Run.` }],
      onTool: entry => {
        events.push(entry);
        if (entry.name === tool("action_checkpoint_respond").label && entry.status === "complete") {
          assert.strictEqual(resultValue(entry.result).run_id, runId);
          responseCompleted = true;
        }
      }, fetch: async () => new Response(responseRound++ === 0
        ? event({ tool_calls: [{ index: 0, id: "explicit-approval", type: "function", function: {
          name: tool("action_checkpoint_respond").name, arguments: JSON.stringify(response) } }] }) + finish("tool_calls")
        : event({ content: "The original Run is continuing after your exact approval." }) + finish("stop"),
      { headers: { "Content-Type": "text/event-stream" } }) }, () => {});
    assert(responseCompleted);
    for (let attempt = 0; attempt < 100; attempt++) {
      if ((await api("run", { run_id: runId })).state === "succeeded") break;
      await sleep(20);
    }
    const completed = await api("run", { run_id: runId });
    assert.strictEqual(completed.state, "succeeded");
    assert.deepStrictEqual(completed.output, { value: { approved: true } });
    await assert.rejects(tool("action_checkpoint_respond").execute(response, signal.signal), /Duplicate MCP/);
    await connection.close();
    connection = await connectApiChatMcp({ id: "fixture", label: "Fixture PKM", enabled: true, tools: [],
      url: `http://127.0.0.1:${port}/mcp` }, 0, undefined, signal.signal, async () => {});
    const replay = resultValue(await tool("action_call").execute({ action_id: fixture.action_id, inputs: {},
      idempotency_key: "chat-original-intent", content_hash: fixture.content_hash }, signal.signal));
    assert.strictEqual(replay.run_id, runId, "A new Chat request must reconcile the original invocation, not create a replacement.");
    const chatDirectory = path.join(directory, "chat-state");
    const chatStore = new ApiChatStore(chatDirectory, "0123456789abcdef");
    const chat = chatStore.create();
    chat.messages = [{ id: "user", role: "user", content: "Start isolated Action", status: "complete" },
      { id: "assistant", role: "assistant", content: text, status: "complete", toolCalls: events.filter(item => item.status === "complete") }];
    chatStore.save(chat);
    const restored = new ApiChatStore(chatDirectory, chatStore.namespace).load(chat.id);
    assert(restored.messages[1].toolCalls.some(call => call.result.includes(runId)));
    assert(approvals.some(name => name.endsWith("action_call")));
    console.log("Chat -> real HTTP MCP -> durable Action -> released Waiting -> explicit decision -> same Run completion -> persisted Chat evidence passed.");
  } finally {
    if (connection) await connection.close();
    signal.abort();
    if (process_.exitCode === null) {
      process_.kill("SIGTERM");
      await new Promise(resolve => process_.once("exit", resolve));
    }
    fs.rmSync(directory, { recursive: true, force: true });
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
