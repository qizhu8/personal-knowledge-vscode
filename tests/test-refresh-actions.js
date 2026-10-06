#!/usr/bin/env node
const assert = require("assert");
const fs = require("fs");
const path = require("path");

const root = path.join(__dirname, "..");
const core = fs.readFileSync(path.join(root, "src", "webview", "panel", "00-core.js"), "utf8");
const knowledge = fs.readFileSync(path.join(root, "src", "webview", "panel", "20-knowledge.js"), "utf8");
const servers = fs.readFileSync(path.join(root, "src", "webview", "panel", "40-servers.js"), "utf8");
const mcp = fs.readFileSync(path.join(root, "src", "webview", "panel", "50-mcp.js"), "utf8");
const extension = fs.readFileSync(path.join(root, "src", "extension.ts"), "utf8");
const vscodeIgnore = fs.readFileSync(path.join(root, ".vscodeignore"), "utf8");
const vm = require("vm");

const scriptDraft = { value: "unsaved script", selectionStart: 3, selectionEnd: 8 };
const scriptContext = vm.createContext({
  currentDetail: { type: "script", path: "review/demo.py", content: "old" },
  document: { getElementById: id => id === "se-script" ? scriptDraft : null },
});
vm.runInContext(knowledge.slice(knowledge.indexOf("function renderDetail(data)"), knowledge.indexOf("\nfunction openMarkdownItem")), scriptContext);
vm.runInContext("renderDetail({type:'script',path:'review/demo.py',content:'new on disk'})", scriptContext);
assert.strictEqual(scriptDraft.value, "unsaved script");
assert.strictEqual(scriptDraft.selectionStart, 3);
assert.strictEqual(scriptContext.currentDetail.content, "new on disk");

const detailResponses = [];
const detailContext = vm.createContext({
  command: "detail", state: { tab: "notes" }, detailRequestSequence: 2,
  currentDetailRequest: { type: "note", key: "review-b" }, pendingEditSlug: null, pendingEditType: null,
  renderDetail: data => detailResponses.push(data),
});
const detailHandler = core.slice(core.indexOf("  else if (command === 'detail')"), core.indexOf("  else if (command === 'saved')")).replace("else if", "if");
for (const [requestId, tab, slug] of [[1, "notes", "review-a"], [2, "scripts", "wrong-tab"], [2, "notes", "review-b"]]) {
  detailContext.e = { data: { detailRequestId: requestId, detailTab: tab } };
  detailContext.data = { type: "note", slug };
  vm.runInContext(`(() => { ${detailHandler} })()`, detailContext);
}
assert.deepStrictEqual(detailResponses.map(data => data.slug), ["review-b"]);

let cancelled = false;
const cancelMessages = [];
const cancelContext = vm.createContext({
  currentDetailRequest: { type: "packageFile", key: "package|review.py" },
  currentDetail: { type: "script", path: "review.py" },
  document: { getElementById: () => ({ remove: () => { cancelled = true; } }) },
  ask: (command, payload) => cancelMessages.push({ command, payload }),
});
vm.runInContext(knowledge.slice(knowledge.indexOf("function cancelScriptEdit()"), knowledge.indexOf("function submitScriptEdit()")), cancelContext);
cancelContext.cancelScriptEdit();
assert(cancelled);
assert.strictEqual(cancelMessages[0].payload.type, "packageFile");

const ts = require("typescript");
const ast = ts.createSourceFile("extension.ts", extension, ts.ScriptTarget.Latest, true);
const watcherFunction = ast.statements.find(statement => ts.isFunctionDeclaration(statement) && statement.name?.text === "startFileWatcher");
assert(watcherFunction);
const watchers = [], timers = new Set(), notifications = [];
const noop = () => {};
const watcherContext = vm.createContext({
  path, getStorePath: () => "/refresh-test-root", knowledgeTreeSignature: () => "",
  vscode: { RelativePattern: class { constructor(base, pattern) { this.base = base; this.pattern = pattern; } }, workspace: {
    createFileSystemWatcher: () => {
      const watcher = { dispose: noop, onDidCreate(callback) { this.create = callback; }, onDidChange(callback) { this.change = callback; }, onDidDelete(callback) { this.delete = callback; } };
      watchers.push(watcher); return watcher;
    },
  } },
  setTimeout: callback => { const timer = { callback, unref: noop }; timers.add(timer); return timer; },
  clearTimeout: timer => timers.delete(timer), setInterval: () => ({ unref: noop }), clearInterval: noop,
  _watcher: null, _privacyWatcher: null, _projectStateWatcher: null, _projectContentWatcher: null, _recipeContentWatcher: null,
  _watcherRefreshTimer: null, _projectStateRefreshTimer: null, _watcherFallbackTimer: null,
  _watcherSkillProjectionChanged: false, _knowledgeTreeSignature: "", _panelReady: true, _treeProvider: { refresh: noop },
  panel: { visible: true, webview: { postMessage: message => notifications.push(JSON.parse(JSON.stringify(message))) } },
  contentCheckTask: { idle: noop, queued: noop, running: noop }, agentSessionJsonCache: { invalidate: noop },
  invalidateSharedContentCatalog: noop, schedulePublishedShareRefresh: noop, scheduleRetrievalRefresh: noop,
  refreshKnowledgeInventory: noop, githubSyncScheduler: { notifyContentChanged: noop },
});
vm.runInContext(ts.transpileModule(watcherFunction.getText(ast), { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText, watcherContext);
watcherContext.startFileWatcher({ subscriptions: [] });
const changed = (watcher, relative) => watcher.change({ fsPath: path.join("/refresh-test-root", relative) });
const flushTimers = () => { const pending = [...timers]; timers.clear(); pending.forEach(timer => timer.callback()); };
changed(watchers[4], "recipes/review.json");
changed(watchers[2], ".pkm/state/agent-sessions/review.json");
changed(watchers[3], "project/review.md");
flushTimers();
assert.strictEqual(notifications.length, 1);
assert.deepStrictEqual(notifications[0].data.scopes, ["agentSessions", "projects", "recipes"]);
assert.strictEqual(notifications[0].data.changedPaths.length, 3);
changed(watchers[4], "recipes/next.json");
flushTimers();
assert.deepStrictEqual(notifications.at(-1).data.scopes, ["recipes"]);
changed(watchers[0], "notes/review.md");
changed(watchers[0], "scripts/review.py");
flushTimers();
assert.deepStrictEqual(notifications.at(-1).data.changedPaths, ["notes/review.md", "scripts/review.py"]);

const chatSource = fs.readFileSync(path.join(root, "src", "chatroom/chatroom-browser.ts"), "utf8");
const chatLog = { scrollTop: 120, scrollHeight: 1000, clientHeight: 200, appendChild() { this.scrollHeight += 40; } };
const chatContext = vm.createContext({ document: {
  getElementById: () => chatLog,
  createElement: () => ({ appendChild: noop }),
} });
vm.runInContext(chatSource.slice(chatSource.indexOf("  function addFileLink(name,url)"), chatSource.indexOf('  document.getElementById("input").addEventListener')), chatContext);
chatContext.addFileLink("fixture.txt", "blob:fixture");
assert.strictEqual(chatLog.scrollTop, 120, "file completion preserves historical reading position");
chatLog.scrollTop = chatLog.scrollHeight - chatLog.clientHeight;
chatContext.addFileLink("latest.txt", "blob:latest");
assert.strictEqual(chatLog.scrollTop, chatLog.scrollHeight, "file completion follows when already at the bottom");

assert.match(core, /if \(currentDetailRequest\) ask\('detail', currentDetailRequest\)/);
assert.match(knowledge, /function requestDetail\(type, key\)/);
assert.match(knowledge, /state\.tab = t\.dataset\.tab;[\s\S]{0,120}currentDetail = null;[\s\S]{0,80}currentDetailRequest = null;/);
for (const type of ["prompt", "promptDiff", "packageFile"]) assert(knowledge.includes(`requestDetail('${type}'`), `${type} must retain its exact refresh request`);
assert.match(knowledge, /currentDetail = data;/);

assert.match(servers, /data-pending-label="Refreshing…" onclick="ask\('serverList',\{\},this\)".*Force-refresh server process, port, and link status/);
for (const [command, label] of [["serverStart", "Starting…"], ["serverStop", "Stopping…"], ["serverRestart", "Restarting…"], ["serverInspectExternal", "Inspecting…"]]) {
  assert(servers.includes(`data-pending-label="${label}"`), `${command} must render its pending label`);
  assert(servers.includes(`ask('${command}',{slug:'\${esc(s.slug)}'},this)`), `${command} must provide immediate click feedback`);
  assert.match(core, new RegExp(`${command}:\\d+`), `${command} must have an operation timeout`);
}
assert.match(core, /command === 'serverList'\) \{ finishAction\('serverList','serverStart','serverStop','serverRestart','serverInspectExternal'\)/,
  "the authoritative Server refresh must finish every lifecycle action");
assert.match(mcp, /beginMcpUiAction\('refreshMcpPathSizes', \{\}, button\)/);
assert.match(extension, /mcpPathSizeGeneration \+= 1;[\s\S]{0,100}mcpPathSizeCache\.clear\(\)/);
assert.match(extension, /case "reload":[\s\S]{0,300}respond\(\{ command: "reloaded", data: \{ manual: true \} \}\)/);
assert.match(vscodeIgnore, /^\*\*\/\*\.map$/m);
assert.match(vscodeIgnore, /^scripts\/poc-\*\.js$/m);

console.log("refresh actions test: current detail, Server status, MCP sizes, and disk-backed knowledge refresh contracts OK");