const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const http = require("node:http");
const { createHash, randomBytes } = require("node:crypto");
const vscode = require("vscode");
const digest = value => createHash("sha256").update(JSON.stringify(value)).digest("hex");

async function checkWebview(extension, snapshot, chat, store) {
  const { ApiChatView } = require(path.join(extension.extensionPath, "dist/chat/api-chat-view"));
  const provider = new ApiChatView({});
  provider.store = store;
  const panel = vscode.window.createWebviewPanel("ctx-acceptance", "CTX acceptance", vscode.ViewColumn.One,
    { enableScripts:true, localResourceRoots:[vscode.Uri.file(path.join(extension.extensionPath, "dist", "webview"))] });
  try {
    const nonce = randomBytes(16).toString("hex");
    const asset = name => panel.webview.asWebviewUri(vscode.Uri.file(path.join(extension.extensionPath, "dist", "webview", name)));
    const result = new Promise((resolve, reject) => {
      const timer = setTimeout(() => { listener.dispose(); reject(new Error("Installed Webview did not display CTX receipts")); }, 20000);
      const listener = panel.webview.onDidReceiveMessage(async value => {
        if (value.type === "visualizationRequest") {
          try {
            assert.equal(value.chatId, chat.id);
            const data = await provider.visualizationRequest(chat, value.method, value.params);
            await panel.webview.postMessage({ type:"visualizationResult", requestId:value.requestId, chatId:chat.id, data });
          } catch (error) {
            await panel.webview.postMessage({ type:"visualizationResult", requestId:value.requestId, chatId:chat.id, error:String(error) });
          }
          return;
        }
        clearTimeout(timer); listener.dispose();
        if (value.error) reject(new Error(value.error)); else resolve(value);
      });
    });
    panel.webview.html = `<!doctype html><html><head>
      <meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'nonce-${nonce}' ${panel.webview.cspSource}; style-src ${panel.webview.cspSource} 'unsafe-inline';">
      <link rel="stylesheet" href="${asset("agent-harness.css")}"></head><body><div id="root"></div>
      <button id="visualization">Visualization</button>
      <section id="visualization-panel" hidden><button id="visualization-steer">Steer</button><button id="visualization-window">Window</button><button id="visualization-close">Close</button><div id="visualization-content"></div></section>
      <script nonce="${nonce}" src="${asset("agent-harness.js")}"></script>
      <script nonce="${nonce}" src="${asset("chat-visualization.js")}"></script><script nonce="${nonce}">
      const api = acquireVsCodeApi();
      (async () => { try {
        const data = ${JSON.stringify(snapshot).replace(/</g, "\\u003c")};
        const view = PkmAgentHarness.mount(document.getElementById('root'), { initial:data, request:async () => data });
        [...document.querySelectorAll('#root button')].find(node => node.textContent === 'Full execution graph').click();
        const model = PkmAgentHarness.build(data);
        const budget = [...model.graphs.values()].find(graph => graph.nodes.some(node => node.kind === 'Budget receipt'));
        const route = [];
        for (let graph = budget; graph.parent; graph = model.graphs.get(graph.parent)) {
          route.unshift(model.graphs.get(graph.parent).nodes.find(node => node.child === graph.id).title);
        }
        for (const title of route) {
          const button = [...document.querySelectorAll('.pkm-harness-expand')].find(node => node.getAttribute('aria-label') === 'Open subgraph: ' + title);
          if (!button) throw new Error('Missing installed graph navigation: ' + title);
          button.click();
        }
        [...document.querySelectorAll('.pkm-harness-viewport button')].find(node => node.textContent === 'Round 0').click();
        const recorded = JSON.parse(document.querySelector('.pkm-harness-inspector pre').textContent);
        view.dispose();
        const inline = PkmChatVisualization({ post:(type, params) => api.postMessage({ type, ...params }), steer:() => {} });
        inline.setChat(${JSON.stringify(chat.id)});
        document.getElementById('visualization').click();
        for (let tries=0; !document.querySelector('#visualization-content .pkm-harness'); tries++) {
          const error=document.querySelector('#visualization-content [role="alert"]');
          if (error || tries > 100) throw new Error(error?.textContent || 'Inline graph failed to mount');
          await new Promise(resolve=>setTimeout(resolve,50));
        }
        if (document.getElementById('visualization-panel').hidden) throw new Error('Inline graph hidden');
        const heading=document.querySelector('#visualization-content h2').textContent;
        if (heading !== data.task) throw new Error('Wrong native Session in inline graph: ' + heading);
        inline.dispose();
        api.postMessage({ refinements:recorded.contextPlan.refinements, transport:recorded.transport.provider, inlineVisualization:true });
      } catch (error) { api.postMessage({ error:String(error) }); } })();
      </script></body></html>`;
    assert.deepEqual(await result, { refinements:1, transport:"http", inlineVisualization:true });
  } finally { provider.dispose(); panel.dispose(); }
}

async function checkBrowser(extension, snapshot) {
  const { createNativeHarnessServer } = require(path.join(extension.extensionPath, "dist/runtime/native-harness-server"));
  const { chromium } = require(process.env.PKM_PLAYWRIGHT_PATH || "playwright");
  const server = await createNativeHarnessServer({ extensionPath:extension.extensionPath, sessionId:snapshot.sessionId,
    access() {}, request:async () => snapshot });
  let browser;
  try {
    browser = await chromium.launch({ headless:true,
      ...(process.env.PKM_CTX_CHROMIUM_PATH ? { executablePath:process.env.PKM_CTX_CHROMIUM_PATH } : {}) });
    const page = await browser.newPage();
    await page.goto(server.url);
    await page.getByRole("heading", { name:snapshot.task, exact:true }).waitFor();
    await page.getByRole("button", { name:"Full execution graph", exact:true }).click();
    await page.getByRole("button", { name:`Open subgraph: ${snapshot.harness.attempts[0].associatedProblem || "Direct execution"}`, exact:true }).click();
    await page.getByRole("button", { name:"Open subgraph: Attempt 1", exact:true }).click();
    await page.getByRole("button", { name:"Open subgraph: 2 prepared rounds", exact:true }).click();
    await page.getByRole("button", { name:"Round 0", exact:true }).click();
    const receipt = JSON.parse(await page.locator(".pkm-harness-inspector pre").innerText());
    assert.equal(receipt.contextPlan.refinements, 1);
    assert.equal(receipt.transport.provider, "http");
  } finally { await browser?.close(); server.dispose(); }
}

async function checkNativeEnvelope(extension) {
  const { streamVscodeChat } = require(path.join(extension.extensionPath, "dist/chat/api-chat-vscode"));
  const prepared = [], prompts = [];
  const messages = [{ role:"system", content:"Keep the original conditions; never deploy." }, { role:"user", content:"Inspect only." }];
  const model = { id:"installed-native-boundary", vendor:"fixture", name:"Local native boundary", maxInputTokens:8192,
    countTokens:async value => Buffer.byteLength(typeof value === "string" ? value : JSON.stringify(value), "utf8"),
    sendRequest:async (prompt, options) => {
      prompts.push({ prompt, options });
      return { text:(async function* () { yield "Original native answer."; })() };
    },
  };
  await streamVscodeChat(model, { messages, tools:[], signal:new AbortController().signal,
    maxOutputTokens:128, contextWindow:4096, onTransportPrepared:receipt => prepared.push(receipt) }, () => {});
  assert.equal(prompts.length, 1);
  assert.equal(prepared.length, 1);
  const prompt = prompts[0].prompt;
  const text = typeof prompt[0].content === "string" ? prompt[0].content : prompt[0].content.map(part => part.value).join("");
  assert.equal(text, `[PKM instructions and reference context]\n${messages[0].content}`);
  assert.deepEqual(prepared[0].messageHashes, prompt.map(digest));
  assert.notEqual(prepared[0].messageHashes[0], prepared[0].messageHashes[1]);
  assert.equal(prepared[0].toolSchemaHash, digest([]));
  assert.equal(prepared[0].countingMethod, "vscode-countTokens-plus-overhead");
  assert.equal(prepared[0].inputTokens, 32 + prompt.reduce((total, message) => total + Buffer.byteLength(JSON.stringify(message), "utf8") + 32, 0));
}

async function run() {
  const root = process.env.PKM_CTX_ROOT, phase = process.env.PKM_CTX_PHASE;
  assert(root && ["initial", "restart"].includes(phase));
  const extension = vscode.extensions.getExtension("uone.personal-knowledge");
  assert(extension, "The installed VSIX was not discovered");
  const installedRelative = path.relative(path.join(root, "extensions"), fs.realpathSync(extension.extensionPath));
  assert(installedRelative && !installedRelative.startsWith("..") && !path.isAbsolute(installedRelative),
    "This acceptance requires the actually installed VSIX, not a development extension");
  assert.equal(digest(fs.readFileSync(path.join(extension.extensionPath, "dist/chat/chat-context.js"))),
    digest(fs.readFileSync(path.join(process.env.PKM_CTX_INSTALLED, "dist/chat/chat-context.js"))));
  assert.equal(path.resolve(vscode.workspace.getConfiguration("personalKnowledge").get("storePath") || ""),
    path.join(root, "knowledge"), "Refuse activation when the effective Knowledge Root is not the isolated fixture");
  await extension.activate();
  await vscode.commands.executeCommand("workbench.action.closeSidebar");
  assert.equal(path.resolve(require(path.join(extension.extensionPath, "dist/knowledge/filestore")).getStorePath()),
    path.join(root, "knowledge"), "Installed-host test must never use the real account's Knowledge Root");
  const moduleAt = name => require(path.join(extension.extensionPath, "dist", name));
  const { ApiChatStore, apiChatHarnessSnapshot } = moduleAt("chat/api-chat-store");
  const store = new ApiChatStore(path.join(root, "knowledge", ".pkm", "state"), "0123456789abcdef");
  let chat;
  if (phase === "initial") {
    const requests = [], server = http.createServer(async (request, response) => {
      const chunks = [];
      for await (const chunk of request) chunks.push(chunk);
      requests.push(JSON.parse(Buffer.concat(chunks).toString()));
      const delta = requests.length === 1 ? { tool_calls:[{ index:0, id:"installed-call", type:"function", function:{ name:"session_info", arguments:"{}" } }] }
        : { content:"Inspected stored identity; no deployment and no summary call." };
      response.writeHead(200, { "Content-Type":"text/event-stream" });
      response.end(`data: ${JSON.stringify({ choices:[{ delta, finish_reason:delta.tool_calls ? "tool_calls" : "stop" }] })}\n\ndata: [DONE]\n\n`);
    });
    await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
    const { ApiChatView } = moduleAt("chat/api-chat-view");
    const profile = { id:"ctx-installed", model:"ctx-installed", label:"CTX fixture", status:"active",
      contextWindow:262144, maxOutputTokens:1024, currency:"USD", includeUsage:false, outputTokenParameter:"max_tokens" };
    const candidate = { id:"installed-source", level:"l1-source", sourceId:"pkm://fixture/installed", sourceRevision:"r1",
      contentHash:"a".repeat(64), kind:"note", label:"Conditions", sourceUri:"pkm://fixture/installed", score:1,
      method:"fixture", selected:false, reason:"fixture",
      content:"# Experiment\n\n" + "Background.\n\n".repeat(1000) + "latency must not exceed 125 ms; never deploy.\n" };
    const provider = new ApiChatView({ secrets:{ get:async () => "local-fixture" } }, async () => [candidate]);
    try {
      chat = store.create(); chat.permissionMode = "read-only"; chat.includeHistory = false;
      chat.builtinTools = ["session_info"]; chat.vscodeTools = [];
      store.startTask(chat, "Installed CTX acceptance");
      provider.store = store; provider.chat = chat; provider.chats.set(chat.id, chat); provider.publish = () => {};
      provider.toolGroups = () => [{ id:"builtin", tools:[{ name:"session_info", enabled:true }] }];
      provider.settings = () => ({ provider:"openai-compatible", selectedProfile:profile, profiles:[profile],
        endpoint:`http://127.0.0.1:${server.address().port}/v1`, model:profile.model,
        contextWindow:8192, maxOutputTokens:1024, timeoutMs:10000, maxToolRounds:3, loopReviewAfterMs:60000 });
      await provider.send("What is the latency limit? Inspect identity without executing anything else.");
      const reply = chat.messages.at(-1);
      assert.equal(reply.status, "complete", reply.error);
      assert.equal(requests.length, 2);
      assert.equal(reply.toolCalls.length, 1);
      assert.equal(reply.budgetReceipts[0].contextPlan.refinements, 1);
      for (const [index, payload] of requests.entries()) assert.deepEqual(reply.budgetReceipts[index].transport.messageHashes, payload.messages.map(digest));
      fs.writeFileSync(path.join(root, "chat-id"), chat.id);
    } finally {
      provider.dispose(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve));
    }
  } else chat = store.load(fs.readFileSync(path.join(root, "chat-id"), "utf8"), false);
  const loaded = store.load(chat.id, false), reply = loaded.messages.at(-1);
  assert.equal(reply.status, "complete");
  assert.equal(JSON.parse(moduleAt("chat/chat-memory").readChatToolEvidence(loaded, reply.id, { callId:"installed-call", messageId:reply.id })).content, reply.toolCalls[0].result);
  const snapshot = { sessionId:loaded.sessionId, origin:"pkm-native", status:"complete", task:"Installed CTX acceptance",
    harness:apiChatHarnessSnapshot(loaded), todos:[], runs:[], actionRuns:[] };
  await checkWebview(extension, snapshot, loaded, store);
  await checkBrowser(extension, snapshot);
  await checkNativeEnvelope(extension);
  const standaloneVisualization = await require("./visualization").checkVisualizationWindow(extension, loaded, store);
  const liveVisualization = phase === "initial"
    ? await require("./visualization-live").checkLiveVisualization(extension, store, root)
    : await require("./visualization-live").checkLiveVisualizationRecord(extension, store, root);
  const visualizationChain = await require("./visualization-chain").checkVisualizationChain(extension, store, root, phase === "restart");
  const durableProcess = await require("./durable-process").checkDurableProcess(extension, root, phase === "restart");
  fs.writeFileSync(path.join(root, `${phase}.json`), JSON.stringify({ pid:process.pid, installed:true, webview:true, browser:true,
    nativeEnvelope:true, inlineVisualization:true, standaloneVisualization, liveVisualization, visualizationChain, durableProcess,
    refinements:reply.budgetReceipts[0].contextPlan.refinements, evidenceHash:digest([reply.toolCalls, reply.budgetReceipts]) }));
}

module.exports = { run };
