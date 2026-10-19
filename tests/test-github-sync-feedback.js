const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { test } = require("node:test");
const ts = require("typescript");

const root = path.resolve(__dirname, "..");
const source = fs.readFileSync(path.join(root, "src/webview/panel/46-github-sync.js"), "utf8");
const core = fs.readFileSync(path.join(root, "src/webview/panel/00-core.js"), "utf8");

function ui() {
  const requests = [], finished = [], timers = [];
  const context = vm.createContext({
    esc: value => String(value ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/"/g, "&quot;"),
    uiIcon: (_name, label) => label || "", Map, Set,
    state: { tab: "other" }, document: { querySelector: () => null, querySelectorAll: () => [], getElementById: () => null },
    vscode: { postMessage: message => requests.push(message) },
    pendingActionButtons: new Map(),
    ask: (command, payload) => requests.push({ command, payload }),
    finishAction: command => finished.push(command),
    setTimeout: callback => { timers.push(callback); return timers.length; },
    clearTimeout: () => {},
  });
  vm.runInContext(source, context);
  return { context, requests, finished, timers, run: text => vm.runInContext(text, context) };
}

test("late full snapshots cannot resurrect resolved conflicts, errors or paused selections", () => {
  const f = ui();
  f.run(`githubSyncOnState({snapshotSequence:12,targets:[{id:'t',name:'Current',automation:{enabled:false},
    lastSync:{at:'2026-10-18T02:00:00Z'}}],runtime:{t:{status:'paused',lastSuccessAt:'2026-10-18T02:00:00Z'}},
    conflicts:{},contentRepairs:{}})`);
  const before = f.run("githubSyncCards()");
  const accepted = f.run(`githubSyncOnState({snapshotSequence:11,targets:[{id:'t',name:'Old',automation:{enabled:false},
    pausedItems:[{type:'skills',itemId:'Old pause'}],lastFailure:{at:'2026-10-18T01:00:00Z',error:'old failure'}}],
    conflicts:{t:{id:'old',createdAt:'2026-10-18T01:00:00Z',files:[]}},
    contentRepairs:{t:{id:'old-repair',issues:[]}}})`);
  assert.equal(accepted, false);
  assert.equal(f.run("githubSyncCards()"), before);
  assert(!f.run("githubSyncCards()").includes("Old pause"));
});

test("reopening Sync waits for current metadata rather than painting cached errors for one frame", () => {
  const f = ui();
  f.run(`githubSyncData={targets:[{id:'t',name:'Cached',lastFailure:{error:'obsolete cached failure'}}],runtime:{}};
    githubSyncUpdatedAt=100;renderGitHubSyncPane=()=>{};showGitHubSyncTab()`);
  assert.match(f.run("githubSyncCards()"), /Refreshing current Sync status/);
  assert.doesNotMatch(f.run("githubSyncCards()"), /obsolete cached failure/);
  assert(f.requests.some(request => request.command === "githubSyncState"));
  f.run("githubSyncOnState({targets:[],runtime:{},conflicts:{},contentRepairs:{}})");
  assert.doesNotMatch(f.run("githubSyncCards()"), /Refreshing current Sync status/);
});

test("success runtime events hide obsolete conflict/repair cards before the full refresh, without hiding partial or new issues", () => {
  const f = ui();
  f.run(`githubSyncData={targets:[{id:'t',name:'Target',automation:{enabled:false},
    lastSync:{at:'2026-10-18T01:00:00Z',entityBases:{old:'base'}},
    lastFailure:{at:'2026-10-18T01:00:00Z',error:'old failure'}}],
    runtime:{t:{status:'error'}},conflicts:{t:{id:'old',createdAt:'2026-10-18T01:00:00Z',files:[]}},
    contentRepairs:{t:{id:'old-repair',createdAt:'2026-10-18T01:00:00Z',issues:[]}}};
    githubSyncOnRuntimeState({targetId:'t',state:{status:'paused',lastSuccessAt:'2026-10-18T02:00:00Z'}})`);
  const cards = f.run("githubSyncCards()");
  assert.doesNotMatch(cards, /old failure|local content validation|github-sync-conflict-actions|Partially synchronized/);
  assert.match(cards, /Sync completed successfully/);
  assert(f.requests.some(request => request.command === "githubSyncState"));
  f.run(`githubSyncData.runtime.t.status='partial'`);
  assert.match(f.run("githubSyncCards()"), /local content validation/);
  f.run(`githubSyncData.runtime.t.status='paused';githubSyncData.contentRepairs.t.createdAt='2026-10-18T02:01:00Z'`);
  assert.match(f.run("githubSyncCards()"), /local content validation/);
});

test("repair feedback survives repeated state renders and ends only on its matching explicit result", () => {
  const f = ui();
  f.run(`githubSyncBeginRepairAction('githubSyncRepairPause',{targetId:'t',path:'skills/Empty.md'})`);
  assert.match(f.run("githubSyncActionFeedbackPanel('t')"), /role="status"[\s\S]*Waiting for pause approval/);
  const panel = () => f.run(`githubSyncContentRepairPanel('t',{id:'r',issues:[{path:'skills/Empty.md',
    reason:'content-validation',lines:[],canOpen:true,canTrash:true}]})`);
  assert.match(panel(), /disabled aria-busy="true"[\s\S]*Waiting for pause approval/);
  f.run("githubSyncOnState({targets:[],runtime:{}})");
  assert.match(panel(), /disabled aria-busy="true"/);
  f.run(`githubSyncOnRepairResult({targetId:'t',action:'githubSyncRepairTrash',message:'unrelated'})`);
  assert.equal(f.finished.length, 0);
  f.run(`githubSyncOnRepairResult({targetId:'t',action:'githubSyncRepairPause',repairRequestId:999,message:'late previous operation'})`);
  assert.equal(f.finished.length, 0);
  f.run(`githubSyncOnRepairResult({targetId:'t',action:'githubSyncRepairPause',cancelled:true,message:'Cancelled. No changes were made.'})`);
  assert.match(f.run("githubSyncActionFeedbackPanel('t')"), /Cancelled. No changes were made/);
  assert.doesNotMatch(panel(), /disabled/);
  assert.deepEqual(f.finished, ["githubSyncRepairPause"]);
  f.run(`githubSyncBeginRepairAction('githubSyncRepairTrash',{targetId:'t',path:'skills/Empty.md'});
    githubSyncOnRepairResult({targetId:'t',action:'githubSyncRepairTrash',error:'Source changed <unsafe>'})`);
  assert.match(f.run("githubSyncActionFeedbackPanel('t')"), /role="alert"[\s\S]*Source changed &lt;unsafe>/);
});

test("actual ask wiring starts repair feedback, prevents repeat clicks, and all repair commands have timeouts", () => {
  const f = ui();
  const calls = [];
  Object.assign(f.context, {
    beginAction: () => true,
    loadProfileRequest: () => "",
    window: {},
    updateLoadingProgress: () => {},
  });
  vm.runInContext(core.slice(core.indexOf("function ask("), core.indexOf("\nfunction captureRefreshView(")), f.context);
  vm.runInContext(core.slice(core.indexOf("const actionTimeouts ="), core.indexOf("\nfunction restoreActionButton(")), f.context);
  f.run(`for (const command of githubSyncRepairCommands) {
    if (!(actionTimeouts[command] > 0)) throw new Error('Missing timeout '+command);
  }`);
  f.run(`ask('githubSyncRepairTrash',{targetId:'t',path:'skills/Empty.md'},{});
    ask('githubSyncRepairTrash',{targetId:'t',path:'skills/Empty.md'},{});`);
  assert.equal(f.requests.filter(request => request.command === "githubSyncRepairTrash").length, 1);
  assert.match(f.run("githubSyncActionFeedbackPanel('t')"), /Waiting for Trash approval/);
  const stateHandler = core.slice(core.indexOf("  else if (command === 'githubSyncState')"),
    core.indexOf("  else if (command === 'githubSyncRepairResult')")).replace("else if", "if");
  f.context.finishAction = (...commands) => calls.push(...commands);
  f.context.finishLoadingProgress = () => {};
  f.context.command = "githubSyncState";
  f.context.data = { snapshotSequence: 20, targets: [], runtime: {} };
  vm.runInContext(stateHandler, f.context);
  assert(!calls.includes("githubSyncRepairTrash"), "a background state refresh cannot complete an in-flight repair");
  const errorHandler = core.slice(core.indexOf("  else if (command === 'githubSyncError')"),
    core.indexOf("  else if (command === 'subscriptionChanged')")).replace("else if", "if");
  f.context.command = "githubSyncError";
  f.context.data = { action: "githubSyncRepairTrash", targetId: "t", repairRequestId: 999, error: "Late old failure" };
  f.context.pendingActionButtons.set("githubSyncRepairTrash", [{}]);
  f.context.failAction = () => { throw new Error("A stale error completed a newer action"); };
  vm.runInContext(errorHandler, f.context);
  assert.match(f.run("githubSyncActionFeedbackPanel('t')"), /Waiting for Trash approval/);
  f.context.data = { action: "githubSyncRepairTrash", targetId: "t", error: "CAS rejected" };
  vm.runInContext(errorHandler, f.context);
  assert.match(f.run("githubSyncActionFeedbackPanel('t')"), /role="alert"[\s\S]*CAS rejected/);
});

test("host snapshots reread target state after async work and tag overlapping responses monotonically", async () => {
  const extension = fs.readFileSync(path.join(root, "src/extension.ts"), "utf8");
  const ast = ts.createSourceFile("extension.ts", extension, ts.ScriptTarget.Latest, true);
  const declaration = ast.statements.find(node => ts.isFunctionDeclaration(node) && node.name?.text === "githubSyncStateData");
  assert(declaration);
  let targets = [{ id: "t", authentication: { method: "vscode" }, lastFailure: { error: "old" } }];
  const pending = [];
  const context = vm.createContext({
    githubSyncStateSequence: 0, JSON, Set,
    readGitHubSyncTargets: () => targets,
    githubAuthenticationOptionsCache: undefined, githubSyncCatalogCache: { value: {} },
    emptyGitHubSyncCatalog: () => ({}), githubSyncStateDirectory: () => "",
    listGitHubSyncConflicts: () => [], readGitHubSyncContentRepair: () => undefined,
    GITHUB_SYNC_CONTENT_TYPES: [], githubSyncScheduler: { snapshot: () => ({}) },
    githubSyncSecretKey: () => "key", githubPublicationMigration: () => ({ status: () => undefined }),
  });
  vm.runInContext(ts.transpileModule(declaration.getText(ast), { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText, context);
  const host = { secrets: { get: () => new Promise(resolve => pending.push(resolve)) } };
  const old = context.githubSyncStateData(host, false);
  targets = [{ id: "t", authentication: { method: "vscode" }, lastSync: { at: "now" } }];
  const fresh = context.githubSyncStateData(host, false);
  pending[1]("token");
  const latest = await fresh;
  pending[0]("token");
  const late = await old;
  assert(latest.snapshotSequence > late.snapshotSequence);
  assert.equal(late.targets[0].lastFailure, undefined, "even a long-running snapshot cannot carry pre-success target errors");
  assert.equal(late.targets[0].lastSync.at, "now");
});
