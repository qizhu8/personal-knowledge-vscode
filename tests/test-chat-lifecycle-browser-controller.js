const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { setTimeout: delay } = require("node:timers/promises");
const { chromium } = require(process.env.PKM_PLAYWRIGHT_PATH || "playwright");
const { ApiChatStore, apiChatGroupSnapshots } = require("../dist/chat/api-chat-store");

// Uses the existing isolated Host fixture; only model output and native desktop prompts are scripted.
module.exports = async function testChatLifecycle(ApiChatView, context, client, confirm, configuration) {
  const webview = path.join(__dirname, "..", "dist", "webview");
  const originalStream = client.streamApiChat;
  const defaultModel = context.globalState.get("apiChat.defaultModel");
  const endpoint = configuration.aiEndpoint;
  const provider = new ApiChatView({ ...context, extensionPath:path.resolve(__dirname, ".."),
    secrets:{ ...context.secrets, get:async () => "fixture-only-test-key" } });
  const browser = await chromium.launch({ headless:true,
    ...(process.env.PKM_CHROMIUM_EXECUTABLE ? { executablePath:process.env.PKM_CHROMIUM_EXECUTABLE } : {}) });
  const page = await browser.newPage({ viewport:{ width:390, height:900 } });
  const treePage = await browser.newPage();
  page.setDefaultTimeout(10000);
  const errors = [], pending = new Set(), requests = [], hostPosts = [];
  const viewerPosts = [];
  let viewer;
  let delivery = Promise.resolve();
  let recordsSubscription;
  page.on("pageerror", error => errors.push(error.message));
  treePage.on("pageerror", error => errors.push(error.message));
  const wait = async (predicate, label) => {
    for (let index = 0; index < 1000; index++) {
      if (predicate()) return;
      if (errors.length) assert.fail(errors.join("\n"));
      await delay(10);
    }
    assert.fail(`Timed out: ${label}; ${JSON.stringify({ progress:provider.chat?.progress, error:provider.chat?.messages.at(-1)?.error,
      approvals:[...provider.approvals.values()].map(item => item.title), decisions:[...provider.decisions.values()].map(item => item.title),
      pending:pending.size, discovery:!!provider.pkmMcpDiscovery, connected:!!provider.managedMcp })}`);
  };
  const idle = async () => { await wait(() => !pending.size, "Host dispatches settling"); await delivery; };
  const snapshots = () => apiChatGroupSnapshots(provider.store.stateDirectory);
  try {
    configuration.aiEndpoint = "https://example.test/v1";
    await context.globalState.update("apiChat.defaultModel", { provider:"openai-compatible",
      profile:{ id:"next", model:"next-api", label:"next", status:"active", contextWindow:32768, maxOutputTokens:1024 } });
    client.streamApiChat = (request, onText) => request.purpose === "memory" ? Promise.resolve()
      : new Promise((resolve, reject) => {
        request.signal.addEventListener("abort", () => reject(new Error("Request cancelled.")), { once:true });
        requests.push({ request, onText, resolve, reject });
      });
    await page.exposeFunction("__pkmPost", message => {
      const task = provider.handle(message).catch(error => {
        errors.push(`${message.type}: ${error.message}`);
        provider.notify(error, message);
      });
      pending.add(task);
      void task.finally(() => pending.delete(task));
    });
    const html = fs.readFileSync(path.join(webview, "api-chat.html"), "utf8")
      .replace(/<meta http-equiv[^>]*>/, "").replace(/<link[^>]*>/g, "").replace(/<script[^>]*><\/script>/g, "");
    await page.route("http://localhost/pkm-lifecycle", route => route.fulfill({ contentType:"text/html", body:html }));
    await page.goto("http://localhost/pkm-lifecycle");
    await page.evaluate(() => {
      window.acquireVsCodeApi = () => ({ getState:() => ({ screen:"library" }), setState:state => { window.__saved = state; },
        postMessage:message => { void window.__pkmPost(message); } });
      window.addEventListener("message", event => { if (event.data.type === "state") window.__hostState = event.data; });
    });
    provider.view = { visible:true, webview:{ postMessage:message => {
      hostPosts.push(message);
      delivery = delivery.then(() => page.evaluate(data => window.dispatchEvent(new MessageEvent("message", { data })), JSON.parse(JSON.stringify(message))));
      return delivery.then(() => true);
    } } };
    await treePage.setContent('<main id="tree" aria-label="Agent Sessions"></main>');
    const built = fs.readFileSync(path.join(webview, "panel.js"), "utf8");
    const functions = (filename, start, end) => {
      const source = fs.readFileSync(path.join(__dirname, "..", "src", "webview", "panel", filename), "utf8");
      const chunk = source.slice(source.indexOf(start), source.indexOf(end));
      assert(chunk.length && built.includes(chunk), "Agent Sessions uses the built production renderer");
      return chunk;
    };
    await treePage.addScriptTag({ content:`
      let projectSnapshot = { agentSessionGroups:[] }, selectedAgentSessionId = '', selectedAgentChatId = '', agentSessionPortalFilter = 'all';
      const state = { tab:'agentSessions' }, catExpanded = {}, githubSyncTypes = [];
      const esc = value => String(value).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
      const uiIcon = name => '<i class="codicon codicon-'+name+'"></i>';
      const privacyInherited = () => false, privacyDivider = () => '';
      const agentSessionStatusIndicator = () => '', agentSessionLivenessLabel = () => '';
      ${functions("20-knowledge.js", "function buildCatTree(", "// Ensure each given folder")}
      ${functions("20-knowledge.js", "function countTreeLeaves(", "function openCatFolderAddMenu(")}
      ${functions("20-knowledge.js", "function toggleCat(", "function hl(")}
      ${functions("15-projects.js", "function agentSessionGroupKey(", "function renderNativeAgentArchitecture(")}
    ` });
    recordsSubscription = provider.onDidChangeRecords(() => {
      const groups = snapshots();
      delivery = delivery.then(() => treePage.evaluate(groups => {
        projectSnapshot.agentSessionGroups = groups;
        document.getElementById("tree").innerHTML = agentSessionTree([]);
      }, groups));
    });
    await page.addStyleTag({ path:path.join(webview, "api-chat.css") });
    for (const script of ["marked.umd.js", "purify.min.js", "api-chat-library.js", "agent-harness.js", "chat-visualization.js", "api-chat.js"]) {
      await page.addScriptTag({ path:path.join(webview, script) });
    }
    await idle();
    viewer = new ApiChatView({ ...context, extensionPath:path.resolve(__dirname, "..") });
    viewer.view = { visible:true, webview:{ postMessage:message => { viewerPosts.push(message); return Promise.resolve(true); } } };
    await viewer.handle({ type:"ready" });
    const viewerHas = (id, trash = false) => viewerPosts.filter(message => message.type === "state").at(-1)?.library.chats
      .some(chat => chat.id === id && !!chat.trashedAt === trash);
    const baseline = provider.store.list().length;
    await page.locator("#list-new").click(); await idle();
    const id = provider.chat.id;
    assert.equal(provider.settings().needsModelConnection, false);
    assert.equal(provider.store.list().length, baseline + 1);
    await wait(() => viewerHas(id), "another Chat view auto-refreshing after New, without a manual refresh");
    assert(snapshots().some(group => group.hostSessionId === id && !group.deletedAt), "No Task Chat appears in Agent Sessions");
    const groupId = snapshots().find(group => group.hostSessionId === id).groupId;
    assert.match(await treePage.locator(`.tree-cat-hdr[title="${groupId}"] .tree-cat-count`).innerText(), /0 Tasks/);
    assert.match(await treePage.locator(`.tree-cat-hdr[title="${groupId}"] .agent-session-chat-title`).getAttribute("title"), /No Task · Chat history is separate/);
    assert(provider.visualizationLibrary().chats.some(chat => chat.id === id));
    assert(hostPosts.filter(message => message.type === "state").at(-1).library.chats.some(chat => chat.id === id));
    assert.equal(provider.managedMcp, undefined, "This scenario must exercise a first send without a managed connection");
    assert.equal(provider.pkmMcpDiscovery, undefined, "The read-only startup must not have already initiated discovery");
    await page.locator("#prompt").fill("Daily-use lifecycle fixture");
    assert.equal(await page.locator("#send").isEnabled(), true, JSON.stringify(await page.evaluate(() => ({
      settings:window.__hostState.settings, tokens:document.getElementById("tokens").textContent,
      invalid:[...document.querySelectorAll(":invalid")].map(node => ({ id:node.id, value:node.value, message:node.validationMessage })),
    }))));
    await page.locator("#send").click();
    await page.getByRole("button", { name:"Allow All", exact:true }).click();
    await wait(() => requests.length === 1, "first model request");
    assert(provider.managedMcp, "The first send must initialize managed tools without reopening Chat");
    assert.equal(provider.chat.permissionMode, "allow-all");
    requests[0].onText("Partial answer retained");
    requests[0].reject(new Error("Fixture provider unavailable")); await idle();
    assert.equal(provider.chat.messages.at(-1).status, "failed");
    assert.match(await page.locator(".message-error").last().innerText(), /Fixture provider unavailable/);
    await page.locator("#prompt").fill("Keep my newer draft");
    await page.getByRole("button", { name:/Retry response in place/ }).click();
    await page.getByRole("button", { name:"Cancel", exact:true }).click(); await idle();
    assert.equal(requests.length, 1, "cancelling Retry must not dispatch");
    await page.getByRole("button", { name:/Retry response in place/ }).click();
    await page.getByRole("button", { name:"Retry", exact:true }).click();
    await wait(() => requests.length === 2, "confirmed Retry");
    requests[1].onText("Retried successfully"); requests[1].resolve(); await idle();
    assert.equal(provider.chat.messages.filter(message => message.role === "user").length, 1);
    assert.deepEqual(provider.chat.messages.filter(message => message.role === "assistant").map(message => message.status), ["failed", "complete"]);
    assert.equal(await page.locator("#prompt").inputValue(), "Keep my newer draft");
    assert.equal(await page.getByRole("button", { name:/Retry response in place/ }).count(), 0);
    assert.equal(await page.locator("#chat-status .wizard-sleeping").count(), 1);

    await page.locator("#send").click();
    await wait(() => requests.length === 3, "cancellable request");
    requests[2].onText("Another retained partial answer");
    await page.locator("#stop").click(); await idle();
    assert.equal(provider.chat.messages.at(-1).status, "cancelled");
    assert.match(provider.chat.messages.at(-1).error, /^Response stopped/);
    const retained = JSON.stringify(provider.chat.messages.at(-1));
    requests[2].onText("Late output"); requests[2].resolve(); await delay(30);
    assert.equal(JSON.stringify(provider.chat.messages.at(-1)), retained);
    assert.equal(requests.length, 3, "Stop must not retry");

    const active = provider.chat.id;
    const companion = provider.portalContext(undefined, "Lifecycle companion");
    await delivery;
    assert.equal(provider.chat.id, active, "external Portal creation must not switch the active Chat");
    const placement = provider.store.list().find(chat => chat.id === companion.id);
    assert.notEqual(placement.groupId, "ungroup");
    assert.equal(snapshots().find(group => group.hostSessionId === companion.id).libraryGroupTitle, "Portal");
    assert.equal(requests.length, 3, "Portal creation must not invoke the model");
    assert.equal(provider.portalContext(active).id, active);
    assert.equal(provider.store.list().find(chat => chat.id === active).groupId, "ungroup", "opening a normal Chat Portal does not regroup it");

    await page.getByRole("button", { name:"Back to Chat List", exact:true }).click();
    const row = page.locator(`[data-node-chat-id="${id}"] > .chat-list-row`);
    confirm(undefined);
    await row.getByRole("button", { name:"Chat actions", exact:true }).click();
    await page.getByRole("menuitem", { name:"Move to Trash", exact:true }).click(); await idle();
    assert(provider.store.list().some(chat => chat.id === id), "cancelled Trash preserves the Chat everywhere");
    confirm("Move to Trash");
    await row.getByRole("button", { name:"Chat actions", exact:true }).click();
    await page.getByRole("menuitem", { name:"Move to Trash", exact:true }).click(); await idle();
    assert(!provider.store.list().some(chat => chat.id === id));
    assert(snapshots().find(group => group.hostSessionId === id).deletedAt);
    assert.equal(await treePage.locator(`.tree-cat-hdr[title="${groupId}"]`).count(), 0, "Trash removes the rendered live Agent Sessions row");
    assert(!provider.visualizationLibrary().chats.some(chat => chat.id === id));
    assert.equal(await page.locator(`.chat-list-trash [data-node-chat-id="${id}"]`).count(), 1);
    await wait(() => viewerHas(id, true), "another Chat view auto-refreshing after Trash");
    await row.getByRole("button", { name:"Chat actions", exact:true }).click();
    await page.getByRole("menuitem", { name:"Restore Chat", exact:true }).click(); await idle();
    assert(provider.store.list().some(chat => chat.id === id));
    assert(!snapshots().find(group => group.hostSessionId === id).deletedAt);
    await wait(() => viewerHas(id), "another Chat view auto-refreshing after restore");
    assert.equal(await treePage.locator(`.tree-cat-hdr[title="${groupId}"]`).count(), 1, "Restore returns the same rendered Chat Group");
    await row.getByRole("button", { name:"Chat actions", exact:true }).click();
    await page.getByRole("menuitem", { name:"Move to Trash", exact:true }).click(); await idle();
    confirm("Delete permanently");
    await row.getByRole("button", { name:"Chat actions", exact:true }).click();
    await page.getByRole("menuitem", { name:"Delete permanently", exact:true }).click(); await idle();
    assert(!provider.store.list(true).some(chat => chat.id === id));
    assert(!snapshots().some(group => group.hostSessionId === id));
    assert.equal(await treePage.locator(`.tree-cat-hdr[title="${groupId}"]`).count(), 0);
    assert.equal(await page.locator(`[data-node-chat-id="${id}"]`).count(), 0);
    await wait(() => !viewerHas(id, true) && !viewerHas(id), "another Chat view auto-refreshing after permanent deletion");
    const reopened = new ApiChatStore(provider.store.stateDirectory, provider.store.namespace);
    assert(!reopened.list(true).some(chat => chat.id === id), "deletion persists across a new store");
    assert.equal(requests.length, 3, "library mutations and reload do not replay model/tool work");
    assert.deepEqual(errors, []);
    console.log("PKM daily browser/controller lifecycle passed: New -> failure -> Retry cancel/confirm -> Stop/late output -> Portal group -> Trash cancel/confirm -> restore -> delete; Chat List, Agent Sessions and Visualization data agree.");
  } finally {
    client.streamApiChat = originalStream;
    configuration.aiEndpoint = endpoint;
    recordsSubscription?.dispose();
    viewer?.dispose();
    await viewer?.memory?.service.close();
    provider.dispose();
    await provider.memory?.service.close();
    await delivery;
    await browser.close();
    await context.globalState.update("apiChat.defaultModel", defaultModel);
  }
};
