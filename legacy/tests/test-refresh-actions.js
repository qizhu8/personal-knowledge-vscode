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
const { githubSyncIgnoredPath } = require("../dist/sync/github-sync.js");
const { isPkmWatchDirectory } = require("../dist/runtime/bounded-file-watcher.js");
const watchers = [], timers = new Set(), notifications = [];
const signatureStarts = [], signatureScans = [];
const noop = () => {};
const watcherContext = vm.createContext({
  path, githubSyncIgnoredPath, AbortController, getStorePath: () => "/refresh-test-root", knowledgeTreeSignature: async () => { signatureScans.push(true); return ""; },
  githubSyncExcludedPaths: async () => new Set(), readGitHubSyncTargets: () => [],
  createKnowledgeFileWatcher: (roots, accept, descend) => {
      const watcher = { roots, accept, descend, dispose: noop, onDidCreate(callback) { this.create = callback; }, onDidChange(callback) { this.change = callback; }, onDidDelete(callback) { this.delete = callback; } };
      watchers.push(watcher); return watcher;
  },
  setTimeout: callback => { const timer = { callback, unref: noop }; timers.add(timer); return timer; },
  setImmediate: callback => signatureStarts.push(callback),
  clearTimeout: timer => timers.delete(timer), setInterval: callback => ({ callback, unref: noop }), clearInterval: noop,
  _watcher: null, _privacyWatcher: null, _projectStateWatcher: null, _projectContentWatcher: null, _recipeContentWatcher: null,
  _watcherRefreshTimer: null, _projectStateRefreshTimer: null, _watcherFallbackTimer: null,
  _watcherSignatureController: undefined,
  _watcherSkillProjectionChanged: false, _knowledgeTreeSignature: "", _treeProvider: { refresh: noop },
  panels: { instances: new Map([[{}, { ready: true, panel: { visible: true } }]]) },
  postToPanel: message => notifications.push(JSON.parse(JSON.stringify(message))),
  nativeHarnessServers: new Map(),
  contentCheckTask: { idle: noop, queued: noop, running: noop }, agentSessionJsonCache: { invalidate: noop },
  log: { info: noop, warn: noop },
  invalidateSharedContentCatalog: noop, schedulePublishedShareRefresh: noop, scheduleRetrievalRefresh: noop,
  refreshKnowledgeInventory: noop, githubSyncScheduler: { notifyContentChanged: noop },
});
vm.runInContext(ts.transpileModule(watcherFunction.getText(ast), { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText, watcherContext);
const changed = (watcher, relative) => watcher.change({ fsPath: path.join("/refresh-test-root", relative) });
const flushTimers = async () => {
  const pending = [...timers]; timers.clear(); pending.forEach(timer => timer.callback());
  await new Promise(resolve => setImmediate(resolve));
};
async function checkWatcherRefresh() {
watcherContext.startFileWatcher({ subscriptions: [] });
assert.strictEqual(signatureScans.length, 0, "registering core watchers must not scan the knowledge library synchronously");
assert.strictEqual(signatureStarts.length, 1, "the initial baseline starts after core registration yields");
const stateWatcher = watchers[2];
const actionRun = ".pkm/state/actions/runs/action_run_" + "a".repeat(32);
for (const relative of [".pkm/state/agent-sessions", actionRun, `${actionRun}/steps`, `${actionRun}/step-events`]) {
  assert(stateWatcher.descend(path.join("/refresh-test-root", relative)), `state metadata must remain watched: ${relative}`);
}
for (const relative of [`${actionRun}/artifacts`, `${actionRun}/workspace`, `${actionRun}/steps/nested`]) {
  assert(!stateWatcher.descend(path.join("/refresh-test-root", relative)), `execution payloads must not be scanned: ${relative}`);
}
for (const relative of ["packages/demo/node_modules/dependency/index.js", "scripts/__pycache__/review.pyc", "scripts/review.pyc"]) {
  changed(watchers[0], relative);
}
assert.strictEqual(timers.size, 0, "dependency/cache writes must not queue full-library refreshes");
changed(watchers[4], "recipes/review.json");
changed(watchers[2], ".pkm/state/agent-sessions/review.json");
changed(watchers[3], "project/review.md");
await flushTimers();
assert.strictEqual(notifications.length, 1);
assert.deepStrictEqual(notifications[0].data.scopes, ["agentSessions", "projects", "recipes"]);
assert.strictEqual(notifications[0].data.changedPaths.length, 3);
changed(watchers[4], "recipes/next.json");
await flushTimers();
assert.deepStrictEqual(notifications.at(-1).data.scopes, ["recipes"]);
changed(watchers[0], "notes/review.md");
changed(watchers[0], "scripts/review.py");
const scansBeforeBatch = signatureScans.length;
await flushTimers();
assert.deepStrictEqual(notifications.at(-1).data.changedPaths, ["notes/review.md", "scripts/review.py"]);
assert.strictEqual(signatureScans.length, scansBeforeBatch + 1, "concurrent watcher events must share one signature scan");
changed(watchers[0], "notes/review/_assets/diagram.png");
changed(watchers[1], ".pkm/content-privacy.json");
await flushTimers();
assert.deepStrictEqual(notifications.at(-1).data.changedPaths, [".pkm/content-privacy.json", "notes/review/_assets/diagram.png"],
  "real attachments and privacy changes must still invalidate content");
}

async function checkStagedSignatures() {
  const signatureFunction = ast.statements.find(statement => ts.isFunctionDeclaration(statement) && statement.name?.text === "knowledgeTreeSignature");
  assert(signatureFunction);
  const scanRoot = "/signature-test-root";
  const areas = ["notes", "skills", "papers", "prompts", "scripts", "packages", "servers", "recipes", "actions", "action-module-sets", "profiles"];
  const directories = {
    notes: [...Array.from({ length: 65 }, (_unused, index) => `note-${index}.md`), "_assets", ".hidden.md"],
    skills: ["SKILL.md"], scripts: ["__pycache__", "review.py"], packages: ["node_modules", "source.js"],
  };
  const reads = [], stats = [], phases = [], yields = [];
  const revisions = new Map();
  let blockedDirectory;
  const scanContext = vm.createContext({
    path, githubSyncIgnoredPath, isPkmWatchDirectory, assertPkmWatchRootAllowed: async () => {}, getStorePath: () => scanRoot,
    fs: { promises: {
      readdir: async directory => {
        const relative = path.relative(scanRoot, directory);
        reads.push(relative);
        if (blockedDirectory) await blockedDirectory;
        return directories[relative] || [];
      },
      lstat: async filename => {
        const relative = path.relative(scanRoot, filename);
        stats.push(relative);
        return { isSymbolicLink: () => false, isDirectory: () => false, mtimeMs: revisions.get(relative) || 1, size: 10 };
      },
    }, readdirSync: () => { throw new Error("synchronous directory read"); }, statSync: () => { throw new Error("synchronous stat"); } },
    loadProfiler: { record: (event, fields) => phases.push({ event, fields }) },
    setImmediate: callback => { yields.push(phases.length); setImmediate(callback); },
  });
  vm.runInContext(ts.transpileModule(signatureFunction.getText(ast), { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText, scanContext);
  const baseline = await scanContext.knowledgeTreeSignature(scanRoot);
  assert.deepStrictEqual(phases.map(phase => phase.fields.area), areas, "each feature area has its own scan phase");
  assert(yields.length > areas.length, "large feature areas must yield within the area as well as between areas");
  assert.strictEqual(yields[0], 0, "the first large area yields before completing");
  assert(!stats.some(relative => /node_modules|__pycache__|_assets|\.hidden/.test(relative)), "ignored files must not be statted");
  assert(baseline.includes("notes/note-0.md:1:10"));
  assert(baseline.includes("packages/source.js:1:10"));
  revisions.set("notes/note-0.md", 2);
  assert.notStrictEqual(await scanContext.knowledgeTreeSignature(scanRoot), baseline, "a content metadata change still changes the safety signature");
  const cancelled = new AbortController(); cancelled.abort();
  const beforeCancelled = reads.length;
  await assert.rejects(scanContext.knowledgeTreeSignature(scanRoot, cancelled.signal), /cancelled/);
  assert.strictEqual(reads.length, beforeCancelled, "a cancelled scan must not start filesystem IO");
  let releaseDirectory;
  blockedDirectory = new Promise(resolve => { releaseDirectory = resolve; });
  const interrupted = new AbortController();
  const beforeInterrupted = stats.length;
  const pending = scanContext.knowledgeTreeSignature(scanRoot, interrupted.signal);
  interrupted.abort(); releaseDirectory();
  await assert.rejects(pending, /cancelled/);
  assert.strictEqual(stats.length, beforeInterrupted, "cancellation during directory IO must prevent further file scanning");
  await new Promise(resolve => setImmediate(resolve));
  let currentSignature = "initial", passes = 0, releasePass;
  let blockedPass = new Promise(resolve => { releasePass = resolve; });
  watcherContext.knowledgeTreeSignature = async () => {
    passes++;
    const captured = currentSignature;
    if (blockedPass) await blockedPass;
    return captured;
  };
  const oldController = watcherContext._watcherSignatureController;
  watcherContext.startFileWatcher({ subscriptions: [] });
  assert(oldController.signal.aborted, "switching roots or restarting watchers cancels the old scan");
  signatureStarts.pop()();
  currentSignature = "watcher-change";
  changed(watchers.at(-5), "notes/during-scan.md"); await flushTimers();
  assert.strictEqual(passes, 1, "a watcher event must not start a concurrent pass");
  assert.deepStrictEqual(notifications.at(-1).data.changedPaths, ["notes/during-scan.md"], "watcher refresh must not wait for the background baseline");
  blockedPass = undefined; releasePass();
  await new Promise(resolve => setImmediate(resolve));
  assert.strictEqual(passes, 2, "changes during a scan require one follow-up pass");
  assert.strictEqual(watcherContext._knowledgeTreeSignature, currentSignature);
  const beforeFallback = notifications.length;
  watcherContext._watcherFallbackTimer.callback();
  await new Promise(resolve => setImmediate(resolve));
  assert.strictEqual(notifications.length, beforeFallback, "unchanged fallback scans must not refresh");
  currentSignature = "missed-watcher-change";
  watcherContext._watcherFallbackTimer.callback();
  await new Promise(resolve => setImmediate(resolve));
  assert.strictEqual(notifications.length, beforeFallback + 1, "fallback detection must still refresh a missed change");
  assert.strictEqual(notifications.at(-1).data.fallback, true);
  blockedPass = new Promise(resolve => { releasePass = resolve; });
  currentSignature = "old-root-pending";
  watcherContext._watcherFallbackTimer.callback();
  const beforeRestart = notifications.length;
  watcherContext.getStorePath = () => "/replacement-test-root";
  watcherContext.startFileWatcher({ subscriptions: [] });
  blockedPass = undefined; releasePass();
  await new Promise(resolve => setImmediate(resolve));
  assert.strictEqual(watcherContext._knowledgeTreeSignature, "", "an old-root scan must not commit into the replacement root's baseline");
  assert.strictEqual(notifications.length, beforeRestart, "cancelled fallback scans must not publish stale refreshes");
  watcherContext._watcherSignatureController.abort();
  signatureStarts.forEach(callback => callback());
}

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

async function checkEnvironmentRefreshErrors() {
  const messages = [];
  const probes = [];
  const fixture = vm.createContext({
    pyenvList: () => [{id:'good',name:'Good'}, {id:'bad',name:'Unavailable'}],
    pyenvPyVersion: async (id, force) => { probes.push(['version',id,force]); if (id === 'bad') throw new Error('interpreter missing'); },
    pyenvSize: async (id, force) => { probes.push(['size',id,force]); if (id === 'bad') throw new Error('folder unavailable'); },
    envListForUi: () => [{id:'good'}, {id:'bad',cached:true}], respond: message => messages.push(message),
    sweepEnvVersions: noop, sweepEnvSizes: noop,
  });
  const handler = extension.slice(extension.indexOf('    case "envList": {'), extension.indexOf('    case "envCondaList": {'));
  vm.runInContext(ts.transpileModule(`async function refreshFixture(msg) { switch ('envList') { ${handler} } }`,
    {compilerOptions:{target:ts.ScriptTarget.ES2022}}).outputText, fixture);
  await fixture.refreshFixture({refresh:true});
  assert.strictEqual(probes.length, 4, 'A failed probe must not stop other environments');
  assert(probes.every(probe => probe[2] === true));
  assert.strictEqual(messages[0].refreshErrors.length, 2);
  assert(messages[0].refreshErrors.some(error => error.includes('interpreter missing')));
  assert(messages[0].refreshErrors.some(error => error.includes('folder unavailable')));
  assert.strictEqual(messages[0].data[1].cached, true, 'Available stale data remains visible after a partial refresh failure');
  assert.match(core, /e\.data\.refreshErrors\?\.length\) showViewActionError/);
}
const manualRequests = [];
const manualContext = vm.createContext({
  command:'reloaded', data:{manual:true}, state:{tab:'notes',filter:'all',search:'keep filter'},
  renderNonce:0, pendingTreeRefresh:null, githubSyncUpdatedAt:1,
  currentDetailRequest:{type:'note',key:'review/detail'}, cachedKnowledgeTabs:new Set(['notes']),
  invalidateKnowledgeTabView:noop, ensureGitHubSyncStatus:noop,
  document:{querySelector:() => null}, ask:(command, payload) => manualRequests.push({command,payload}),
});
const manualHandler = core.slice(core.indexOf("  else if (command === 'reloaded')"), core.indexOf("  else if (command === 'knowledgeFolderScanFailed')")).replace('else if','if');
vm.runInContext(manualHandler, manualContext);
assert.strictEqual(manualRequests[0].payload.fresh, true, 'Manual refresh must bypass the cached inventory');
assert.strictEqual(manualRequests[0].payload.q, 'keep filter');
assert.strictEqual(manualRequests[1].payload.key, 'review/detail');
vm.runInContext(knowledge.slice(knowledge.indexOf('function doReload()'), knowledge.indexOf('function triggerImport()')), manualContext);
manualContext.doReload();
assert.strictEqual(manualContext.state.search, 'keep filter', 'Refresh must not discard the active find filter');
manualContext.state.tab = 'environments';
manualContext.doReload();
assert.strictEqual(manualRequests.at(-1).payload.refresh, true, 'Environment refresh must force the probes rather than only return cached cards');
checkWatcherRefresh().then(checkStagedSignatures).then(checkEnvironmentRefreshErrors).then(() => console.log("refresh actions test: staged/cancellable signature scans, detail/draft, Server, MCP, disk-backed knowledge and truthful partial environment failures OK"), error => { console.error(error); process.exitCode = 1; });