const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { chromium } = require(process.env.PKM_PLAYWRIGHT_PATH || "playwright");

const root = path.join(__dirname, "..");
const built = fs.readFileSync(path.join(root, "dist/webview/panel.js"), "utf8");
function builtFunctions(file, start, end) {
  const source = fs.readFileSync(path.join(root, "src/webview/panel", file), "utf8");
  const chunk = source.slice(source.indexOf(start), source.indexOf(end));
  assert(chunk.length > 0 && built.includes(chunk), "Exercise the current built production renderer");
  return chunk;
}
const renderer = [
  builtFunctions("20-knowledge.js", "function buildCatTree(", "// Ensure each given folder"),
  builtFunctions("20-knowledge.js", "function countTreeLeaves(", "function openCatFolderAddMenu("),
  builtFunctions("20-knowledge.js", "function toggleCat(", "function hl("),
  builtFunctions("15-projects.js", "function agentSessionGroupKey(", "function renderNativeAgentArchitecture("),
].join("\n");

test("Agent Sessions routes Chat reads separately from managed Tasks and surfaces reader failures", async () => {
  const source = fs.readFileSync(path.join(root, "src/extension.ts"), "utf8");
  const dispatch = source.slice(source.indexOf('case "nativeHarness": {'), source.indexOf('case "projectState": {'));
  const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
  const handle = new AsyncFunction("msg", "respond", "vscode", "nativeHarnessRequest", "openNativeHarnessBrowser", "context", `switch(msg.command) { ${dispatch} }`);
  const calls = [], replies = [];
  let failure;
  const host = {commands:{async executeCommand(...args) { calls.push(args); if (failure) throw failure; return {sessionId:args[1]}; }}};
  const readTask = async (...args) => { calls.push(["task", ...args]); return {task:true}; };
  const openBrowser = async (...args) => { calls.push(["browser", ...args]); return {browser:true}; };
  const invoke = (method, params) => handle({command:"nativeHarness",requestId:"request",method,params}, value => replies.push(value), host, readTask, openBrowser, {});
  await invoke("snapshot", {chatId:"11111111-1111-4111-8111-111111111111",sessionId:"not-a-managed-task"});
  assert.deepEqual(calls[0], ["personalKnowledge.readChatHarness", "11111111-1111-4111-8111-111111111111", "snapshot", {chatId:"11111111-1111-4111-8111-111111111111",sessionId:"not-a-managed-task"}]);
  assert.equal(replies.at(-1).data.sessionId, "11111111-1111-4111-8111-111111111111");
  failure = new Error("This Chat is unavailable in the current Knowledge Root.");
  await invoke("result", {chatId:"11111111-1111-4111-8111-111111111111"});
  assert.equal(replies.at(-1).error, failure.message);
  await invoke("snapshot", {chatId:42});
  assert.equal(replies.at(-1).error, "Choose a PKM Chat.");
  assert.equal(calls.length, 2, "Invalid Chat reads do not fall through to the Task reader");
  await invoke("snapshot", {sessionId:"agent_session_" + "a".repeat(32)});
  assert.equal(calls.at(-1)[0], "task");
  await invoke("openBrowser", {sessionId:"agent_session_" + "a".repeat(32)});
  assert.equal(calls.at(-1)[0], "browser");
});

test("built Agent Session tree retains empty Chats without false expansion and supports real parent keyboard expansion", async t => {
  const browser = await chromium.launch({ headless: true });
  t.after(() => browser.close());
  const page = await browser.newPage();
  const errors = [];
  page.on("pageerror", error => errors.push(error.message));
  await page.setContent('<main id="tree" aria-label="Agent Sessions"></main>');
  await page.addScriptTag({ content: `
    const projectSnapshot = { agentSessionGroups: [
      { groupId:'empty', hostSessionId:'079bf2d9-f761-4a46-9a00-662f05ce9f16', hostKind:'pkm', libraryGroupId:'research', libraryGroupTitle:'Research', title:'Empty Chat', portal:{connected:false,binding:{role:'controlled'}} },
      { groupId:'parent', hostSessionId:'parent-chat', hostKind:'pkm', libraryGroupId:'research', libraryGroupTitle:'Research', title:'Parent Chat', workerTreeId:'tree', portal:{connected:true,binding:{role:'controller'}} },
      { groupId:'worker', hostSessionId:'worker-chat', hostKind:'pkm', libraryGroupId:'research', libraryGroupTitle:'Research', title:'Worker Chat', workerTreeId:'tree', workerParentChatId:'parent-chat' }
    ] };
    const state = { tab:'agentSessions' }, catExpanded = {}, githubSyncTypes = [];
    const selectedAgentSessionId = '', selectedAgentChatId = '';
    let agentSessionPortalFilter = 'all';
    const esc = value => String(value).replace(/[&<>"']/g, char => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[char]));
    const uiIcon = name => '<i class="codicon codicon-'+name+'"></i>';
    const privacyInherited = () => false, privacyDivider = () => '';
    const agentSessionStatusIndicator = () => '', agentSessionLivenessLabel = () => '';
    let menuTarget = '', selectedTask = '', selectedChat = '';
    function agentSessionFolderMenu(event, path) { event.preventDefault(); event.stopPropagation(); menuTarget = path; }
    function agentSessionSelect(id) { selectedTask = id; }
    function agentSessionChatSelect(id) { selectedChat = id; }
    ${renderer}
    document.getElementById('tree').innerHTML = agentSessionTree([
      {sessionId:'task-parent', groupId:'parent', task:'Parent Task'}
    ]);
  ` });
  const empty = page.locator('.tree-cat-hdr[title="empty"]');
  assert.equal(await empty.getAttribute("role"), "group");
  assert.equal(await empty.getAttribute("aria-expanded"), null);
  assert.equal(await empty.locator(".tree-cat-arrow").innerText(), "");
  assert.match(await empty.innerText(), /Empty Chat.*No Task/s);
  assert.equal(await empty.locator(".tree-cat-count").innerText(), "0 Tasks");
  assert.equal(await empty.locator(".agent-session-pkm-icon").count(), 1);
  assert.equal(await empty.evaluate(node => node.nextElementSibling === null), true);
  assert.equal(await empty.getByRole("button", { name:"Open Chat Dashboard: Empty Chat" }).count(), 1);
  await empty.getByRole("button", { name:"Open Chat Dashboard: Empty Chat" }).press("Enter");
  assert.equal(await page.evaluate(() => selectedChat), "079bf2d9-f761-4a46-9a00-662f05ce9f16");
  await empty.getByRole("button", { name: "Chat Group actions" }).click();
  assert.equal(await page.evaluate(() => menuTarget), "empty");
  const parent = page.locator('.tree-cat-hdr[title="parent"]');
  assert.equal(await parent.getAttribute("aria-expanded"), "true", "A parent with only empty worker Chats is still expandable");
  const worker = page.locator('.tree-cat-hdr[title="worker"]');
  assert.equal(await worker.getAttribute("aria-expanded"), null);
  await parent.focus();
  await page.keyboard.press("Enter");
  assert.equal(await parent.getAttribute("aria-expanded"), "false");
  assert.equal(await worker.isVisible(), false);
  await page.keyboard.press("Space");
  assert.equal(await worker.isVisible(), true);
  const task = page.getByRole("button", { name: /Parent Task/ }).first();
  await task.press("Enter");
  assert.equal(await page.evaluate(() => selectedTask), "task-parent");
  assert.match(await parent.innerText(), /Controller · Connected/);
  await page.evaluate(() => {
    agentSessionPortalFilter = "controlled";
    document.getElementById("tree").innerHTML = agentSessionTree([{sessionId:"task-parent",groupId:"parent",task:"Parent Task"}]);
  });
  assert.match(await empty.innerText(), /Controlled · Disconnected/);
  assert.equal(await parent.count(), 0);
  await page.evaluate(() => {
    agentSessionPortalFilter = "connected";
    document.getElementById("tree").innerHTML = agentSessionTree([{sessionId:"task-parent",groupId:"parent",task:"Parent Task"}]);
  });
  assert.match(await parent.innerText(), /Controller · Connected/);
  assert.equal(await empty.count(), 0);
  assert.deepEqual(errors, []);
});

test("ordinary Chat selection mounts its real read-only dashboard, survives refresh and isolates late replies and Task selection", async t => {
  const browser = await chromium.launch({ headless:true });
  t.after(() => browser.close());
  const page = await browser.newPage();
  const errors = [];
  page.on("pageerror", error => errors.push(error.message));
  const first = "11111111-1111-4111-8111-111111111111", second = "22222222-2222-4222-8222-222222222222";
  const task = "agent_session_" + "a".repeat(32);
  await page.setContent('<main id="detail"></main>');
  await page.addScriptTag({ path:path.join(root, "dist/webview/agent-harness.js") });
  await page.addScriptTag({ content:`
    let selectedAgentSessionId = '', selectedAgentChatId = '', agentSessionPortalFilter = 'all';
    let agentSessionGraphResizeObserver = null;
    const agentSessionTreeCollapsed = false, agentSessionFullscreenRunId = '', agentSessionGraphViewport = {};
    const state = {tab:'agentSessions'}, catExpanded = {}, githubSyncTypes = [];
    const projectSnapshot = {
      agentSessionGroups:[
        {groupId:'first',hostKind:'pkm',hostSessionId:'${first}',title:'First Chat',portal:{connected:true,binding:{role:'controlled'}}},
        {groupId:'second',hostKind:'pkm',hostSessionId:'${second}',title:'Second Chat'},
        {groupId:'managed',hostKind:'pkm',hostSessionId:'33333333-3333-4333-8333-333333333333',title:'Managed Chat'}
      ],
      agentSessions:[{sessionId:'${task}',groupId:'managed',origin:'pkm-native',task:'Existing managed Task',status:'running'}]
    };
    const requests = [], vscode = {postMessage:message => requests.push(message)};
    const esc = value => String(value).replace(/[&<>"']/g, char => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[char]));
    const uiIcon = name => '<i class="codicon codicon-'+name+'"></i>';
    const privacyInherited = () => false, privacyDivider = () => '';
    const agentSessionStatusIndicator = () => '', agentSessionLivenessLabel = () => '';
    const captureRefreshView = () => null, restoreRefreshView = () => {};
    const catTreeTrashDock = () => '', workspaceCatTreeDivider = () => '';
    const agentSessionLayoutLinks = () => {};
    ${renderer}
    ${builtFunctions("15-projects.js", "function agentSessionSelect(", "function agentSessionPersistGraphView(")}
    ${builtFunctions("15-projects.js", "let nativeHarnessView = null;", "function renderAgentSnapshots(")}
    renderAgentSessions();
    function reply(index, title) {
      const request = requests[index];
      window.dispatchEvent(new MessageEvent('message', {data:{
        command:'nativeHarnessResult',requestId:request.requestId,
        data:{origin:'pkm-native',sessionId:request.params.chatId || request.params.sessionId,
          task:title,status:'idle',runs:[],todos:[],harness:{state:'idle',attempts:[]},
          harnessWarnings:request.params.chatId ? ['Chat-only execution view. No managed Task or pinned Recipe bindings.'] : []}
      }}));
    }
  ` });
  assert.equal(await page.locator("#native-agent-harness h2").innerText(), "Existing managed Task");
  await page.getByRole("button", {name:"Open Chat Dashboard: First Chat",exact:true}).press("Enter");
  assert.equal(await page.locator("#native-agent-harness h2").innerText(), "First Chat");
  assert.match(await page.locator(".agent-session-content > .agent-session-group-binding").innerText(), /does not create a managed Task/);
  assert.match(await page.locator(".agent-session-list-head").innerText(), /1 tasks total/);
  assert.equal(await page.getByText("No Agent Sessions", {exact:true}).count(), 0);
  assert.equal(await page.locator("#native-agent-harness").getByRole("button", {name:"Open in browser",exact:true}).count(), 0);
  await page.evaluate(() => {
    window.firstRoot = nativeHarnessView.root;
    renderAgentSessions();
    if (nativeHarnessView.root !== window.firstRoot) throw new Error('Refresh remounted the selected Chat');
  });
  assert.equal(await page.getByRole("button", {name:"Open Chat Dashboard: First Chat",exact:true}).getAttribute("aria-pressed"), "true");
  await page.getByRole("button", {name:"Open Chat Dashboard: Second Chat",exact:true}).press("Space");
  await page.evaluate(() => { reply(2, 'Second Chat persisted'); reply(1, 'STALE First Chat'); });
  await page.getByRole("heading", {name:"Second Chat persisted",exact:true}).waitFor();
  assert.equal(await page.getByRole("heading", {name:"STALE First Chat",exact:true}).count(), 0);
  assert.match(await page.locator(".pkm-harness-warning").innerText(), /Chat-only execution view/);
  await page.getByRole("button", {name:/Existing managed Task/}).first().press("Enter");
  assert.equal(await page.locator("#native-agent-harness h2").innerText(), "Existing managed Task");
  assert.deepEqual(await page.evaluate(() => requests.map(request => ({
    command:request.command,method:request.method,chatId:request.params.chatId || null,sessionId:request.params.sessionId
  }))), [
    {command:"nativeHarness",method:"snapshot",chatId:null,sessionId:task},
    {command:"nativeHarness",method:"snapshot",chatId:first,sessionId:first},
    {command:"nativeHarness",method:"snapshot",chatId:second,sessionId:second},
    {command:"nativeHarness",method:"snapshot",chatId:null,sessionId:task},
  ]);
  await page.getByRole("button", {name:"Open Chat Dashboard: First Chat",exact:true}).click();
  await page.evaluate(() => { projectSnapshot.agentSessionGroups[0].deletedAt = '2026-10-22'; renderAgentSessions(); reply(4, 'DELETED Chat'); });
  assert.equal(await page.locator("#native-agent-harness h2").innerText(), "Existing managed Task");
  assert.equal(await page.getByRole("button", {name:"Open Chat Dashboard: First Chat",exact:true}).count(), 0);
  assert.equal(await page.evaluate(() => projectSnapshot.agentSessions.length), 1, "No synthetic Task was created");
  assert.deepEqual(errors, []);
});
