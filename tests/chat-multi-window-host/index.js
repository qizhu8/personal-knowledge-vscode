const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { createHash } = require("node:crypto");
const vscode = require("vscode");

async function connectWebviews(extensionPath, port) {
  const WebSocket = require(path.join(extensionPath, "node_modules/ws"));
  const version = await (await fetch(`http://127.0.0.1:${port}/json/version`)).json();
  const socket = new WebSocket(version.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => { socket.once("open", resolve); socket.once("error", reject); });
  let sequence = 0;
  const pending = new Map(), contexts = new Map(), attached = new Map();
  socket.on("message", bytes => {
    const message = JSON.parse(bytes.toString());
    if (message.method === "Runtime.executionContextCreated" && message.params.context.auxData?.isDefault) {
      contexts.set(`${message.sessionId}:${message.params.context.id}`,
        { sessionId: message.sessionId, contextId: message.params.context.id });
    }
    if (message.method === "Runtime.executionContextsCleared") {
      for (const [key, context] of contexts) if (context.sessionId === message.sessionId) contexts.delete(key);
    }
    if (message.method === "Runtime.executionContextDestroyed")
      contexts.delete(`${message.sessionId}:${message.params.executionContextId}`);
    if (message.method === "Target.detachedFromTarget") {
      for (const [key, context] of contexts) if (context.sessionId === message.params.sessionId) contexts.delete(key);
      for (const [targetId, sessionId] of attached) if (sessionId === message.params.sessionId) attached.delete(targetId);
    }
    const request = pending.get(message.id);
    if (!request) return;
    clearTimeout(request.timer); pending.delete(message.id);
    if (message.error) request.reject(new Error(JSON.stringify(message.error)));
    else request.resolve(message.result);
  });
  const request = (method, params = {}, sessionId) => new Promise((resolve, reject) => {
    const id = ++sequence;
    const timer = setTimeout(() => { pending.delete(id); reject(new Error(`CDP ${method} timed out`)); }, 10000);
    pending.set(id, { resolve, reject, timer });
    socket.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
  });
  const evaluate = async (context, expression) => {
    const result = await request("Runtime.evaluate", { expression, contextId: context.contextId,
      returnByValue: true, awaitPromise: true }, context.sessionId);
    if (result.exceptionDetails) throw new Error(JSON.stringify(result.exceptionDetails));
    return result.result.value;
  };
  return {
    async ready() {
      const { targetInfos } = await request("Target.getTargets");
      for (const target of targetInfos.filter(target => target.type === "iframe" && target.url.startsWith("vscode-webview:"))) {
        if (attached.has(target.targetId)) continue;
        const { sessionId } = await request("Target.attachToTarget", { targetId: target.targetId, flatten: true });
        attached.set(target.targetId, sessionId);
        await request("Runtime.enable", {}, sessionId);
      }
      for (const [key, context] of contexts) {
        try {
          if (await evaluate(context, "typeof globalThis.PkmWebviewApi === 'object' && globalThis.PkmHostHealth?.unavailable === false"))
            return { evaluate: callback => evaluate(context, `(${callback.toString()})()`) };
        } catch (error) {
          if (!/Session with given id not found|Cannot find context with specified id|Execution context was destroyed/.test(error.message)) throw error;
          contexts.delete(key);
        }
      }
    },
    dispose() {
      for (const request of pending.values()) { clearTimeout(request.timer); request.reject(new Error("CDP connection closed")); }
      pending.clear(); socket.close();
    },
  };
}

async function run() {
  const root = process.env.PKM_CHAT_WINDOWS_ROOT, index = process.env.PKM_CHAT_WINDOWS_INDEX;
  const phase = process.env.PKM_CHAT_WINDOWS_PHASE;
  const abort = () => fs.existsSync(path.join(root, "abort"));
  const waitFor = async (check, description, timeout = 90000) => {
    const deadline = Date.now() + timeout;
    while (Date.now() < deadline) {
      if (abort()) throw new Error("Multi-window acceptance aborted");
      const result = await check();
      if (result) return result;
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    throw new Error("Timed out: " + description);
  };
  const extension = vscode.extensions.getExtension("uone.personal-knowledge");
  assert(extension, "Installed extension must be discovered");
  const relative = path.relative(path.join(root, "extensions"), fs.realpathSync(extension.extensionPath));
  assert(relative && !relative.startsWith("..") && !path.isAbsolute(relative));
  await extension.activate();
  const actualStore = require(path.join(extension.extensionPath, "dist/knowledge/filestore")).getStorePath();
  assert.equal(path.resolve(actualStore), path.join(root, "knowledge"), "Do not touch production knowledge");
  fs.writeFileSync(path.join(root, `activated-${index}-${phase}`), "");
  await waitFor(() => fs.existsSync(path.join(root, "open-chat")), "simultaneous-open barrier");
  const started = Date.now();
  await Promise.all(Array.from({ length: 3 }, () => vscode.commands.executeCommand("personalKnowledge.openApiChat")));
  await vscode.commands.executeCommand("workbench.view.extension.personalKnowledgeChat");
  await vscode.commands.executeCommand("personalKnowledge.apiChat.focus");
  await vscode.commands.executeCommand("personalKnowledge.openApiChat", process.env.PKM_CHAT_FIXTURE_LOCATOR);
  const { chromium } = require(process.env.PKM_PLAYWRIGHT_PATH);
  const browser = await chromium.connectOverCDP(`http://127.0.0.1:${process.env.PKM_CHAT_DEBUG_PORT}`);
  const webviews = await connectWebviews(extension.extensionPath, process.env.PKM_CHAT_DEBUG_PORT);
  try {
    let frame;
    try { frame = await waitFor(() => webviews.ready(), "real Chat renderer initial state", 30000); }
    catch (error) {
      const diagnostic = await browser.newBrowserCDPSession();
      console.error("Chat CDP targets:", JSON.stringify(await diagnostic.send("Target.getTargets")));
      await diagnostic.detach();
      for (const page of browser.contexts().flatMap(context => context.pages())) {
        if (process.env.PKM_CHAT_WINDOWS_REPORT) await page.screenshot({
          path: path.join(path.dirname(process.env.PKM_CHAT_WINDOWS_REPORT), `pkm-chat-window-${index}.png`),
        });
        for (const candidate of page.frames()) {
          if (candidate.isDetached()) continue;
          console.error("Chat renderer diagnostic:", await candidate.evaluate(() => ({
            url: location.href, api: typeof globalThis.PkmWebviewApi,
            unavailable: globalThis.PkmHostHealth?.unavailable, text: document.body?.innerText.slice(0, 1200),
          })));
        }
      }
      throw error;
    }
    const health = () => frame.evaluate(() => new Promise((resolve, reject) => {
      const id = "four-window-" + Math.random().toString(16).slice(2), started = performance.now();
      const listener = event => {
        if (event.data?.type !== "hostHealth" || event.data.id !== id) return;
        clearTimeout(timer); window.removeEventListener("message", listener); resolve(performance.now() - started);
      };
      const timer = setTimeout(() => { window.removeEventListener("message", listener); reject(new Error("Chat Host health timed out")); }, 5000);
      window.addEventListener("message", listener);
      globalThis.PkmWebviewApi.postMessage({ type: "hostHealth", id });
    }));
    const responseMs = await health();
    assert(responseMs < 5000);
    const selected = await waitFor(() => frame.evaluate(() => document.getElementById("library-view").hidden
      && document.getElementById("chats").value), "selected shared conversation", 5000);
    assert.equal(selected, process.env.PKM_CHAT_FIXTURE_LOCATOR.split("/").pop(),
      "the real shared conversation, not just the Chat library, must open in every window");
    const switchTimes = [];
    for (let cycle = 0; cycle < 12; cycle++) {
      await vscode.commands.executeCommand("workbench.action.chat.open");
      await new Promise(resolve => setTimeout(resolve, 150));
      const switchedAt = Date.now();
      await vscode.commands.executeCommand("personalKnowledge.apiChat.focus");
      frame = await waitFor(() => webviews.ready(), "Chat renderer after native Chat switch", 10000);
      await health();
      switchTimes.push(Date.now() - switchedAt);
    }
    const identity = createHash("sha256").update(path.join(root, "knowledge")).digest("hex").slice(0, 16);
    const endpointPath = path.join(root, "storage", "retrieval", identity, "worker.json");
    await waitFor(() => fs.existsSync(endpointPath), "shared retrieval endpoint");
    const endpoint = JSON.parse(fs.readFileSync(endpointPath, "utf8"));
    const statusResponse = await fetch(`http://127.0.0.1:${endpoint.port}/status`,
      { headers: { "X-PKM-Retrieval-Token": endpoint.token }, signal: AbortSignal.timeout(10000) });
    assert(statusResponse.ok);
    const status = await statusResponse.json();
    assert.equal(status.pid, endpoint.pid);
    assert.equal(status.engine_version, "0.3.0.dev2026100504");
    fs.writeFileSync(path.join(root, `ready-${index}-${phase}.json`), JSON.stringify({
      pid: process.pid, openMs: Date.now() - started, healthMs: responseMs, rssBytes: process.memoryUsage().rss,
      workerPid: status.pid, workerPort: endpoint.port,
      nativeChatSwitches: switchTimes.length, switchMaxMs: Math.max(...switchTimes),
    }));
    let survived = false;
    await waitFor(async () => {
      if (!survived && fs.existsSync(path.join(root, "probe-survivors"))) {
        await health(); survived = true; fs.writeFileSync(path.join(root, `survived-${index}`), "");
      }
      return fs.existsSync(path.join(root, `finish-${index}-${phase}`));
    }, "remaining-window close/restart checks", 180000);
  } finally { webviews.dispose(); await browser.close(); }
}

module.exports = { run };
