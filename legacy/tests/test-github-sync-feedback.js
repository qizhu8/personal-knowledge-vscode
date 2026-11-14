const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { test } = require("node:test");
const ts = require("typescript");
const { githubSyncFailureDetails } = require("../dist/sync/github-sync-scheduler");

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

test("Prompts and Scripts show Sync shields before status loads and Agent Snapshot stays excluded", () => {
  const f = ui(), shields = new Map();
  f.context.tabCacheIsFresh = () => true;
  f.context.document.createElement = () => ({ dataset:{}, setAttribute: () => {} });
  f.context.document.querySelector = selector => {
    const type = selector.match(/data-tab="(prompts|scripts)"/)?.[1];
    return type ? { querySelector: () => shields.get(type),
      appendChild: shield => shields.set(type, shield) } : null;
  };
  f.run("ensureGitHubSyncStatus()");
  for (const type of ["prompts", "scripts"]) {
    assert.equal(shields.get(type)?.dataset.status, "outline");
  }
  f.run("githubSyncOnState({shields:{prompts:'green',scripts:'yellow'}})");
  assert.equal(shields.get("prompts").dataset.status, "green");
  assert.equal(shields.get("scripts").dataset.status, "yellow");
});

test("Agent Snapshot tabs do not show GitHub Sync shields", () => {
  const f = ui();
  let removed = false;
  f.context.document.querySelector = selector => selector === '.tab[data-tab="agentSnapshots"]'
    ? { querySelector: () => ({ remove: () => { removed = true; } }),
      appendChild: () => assert.fail("Agent Snapshot must not receive a Sync shield") } : null;
  f.run("updateGitHubSyncShields()");
  assert.equal(removed, true, "previously rendered shields must also be removed");
  f.context.document.querySelector = selector => selector === '.tab[data-tab="agentSnapshots"]'
    ? { querySelector: () => null,
      appendChild: () => assert.fail("Agent Snapshot must not receive a Sync shield") } : null;
  f.run("updateGitHubSyncShields()");
});

test("Recipe and Action Library tabs display their corresponding content Sync status", () => {
  const f = ui(), shields = new Map();
  f.context.tabCacheIsFresh = () => true;
  f.context.document.createElement = () => ({ dataset:{}, setAttribute: () => {} });
  f.context.document.querySelector = selector => {
    const type = selector.match(/data-tab="(recipes|actionLibrary|actions)"/)?.[1];
    return type ? { querySelector: () => shields.get(type),
      appendChild: shield => shields.set(type, shield) } : null;
  };
  f.run("ensureGitHubSyncStatus()");
  for (const type of ["recipes", "actionLibrary", "actions"]) assert.equal(shields.get(type)?.dataset.status, "outline");
  f.run("githubSyncOnState({shields:{recipes:'green',actions:'yellow'},shieldReasons:{actions:['Pending changes']}})");
  assert.equal(shields.get("recipes").dataset.status, "green");
  for (const type of ["actionLibrary", "actions"]) {
    assert.equal(shields.get(type).dataset.status, "yellow");
    assert.match(shields.get(type).title, /Pending changes/);
  }
});

test("returning to GitHub Sync renders cached cards without rescanning content", () => {
  const f = ui();
  f.run(`renderGitHubSyncPane = () => {};
    showGitHubSyncTab(); showGitHubSyncTab();`);
  assert.equal(f.requests.filter(item => item.command === "githubSyncState").length, 1,
    "initial loading must deduplicate content scans");
  f.run(`githubSyncOnState({targets:[{id:'cached'}],fingerprintsDeferred:false});
    githubSyncStatusRequested = false;
    showGitHubSyncTab(); showGitHubSyncTab();`);
  assert.equal(f.run("githubSyncAwaitingState"), false);
  assert.equal(f.run("githubSyncData.targets[0].id"), "cached");
  assert.equal(f.requests.filter(item => item.command === "githubSyncState").length, 1,
    "tab switching must not trigger another catalog or fingerprint scan");
  assert.equal(f.requests.filter(item => item.command === "githubSyncRuntimeSnapshot").length, 4,
    "live runtime status still refreshes without blocking cached cards");
  f.run(`githubSyncUpdatedAt = 0; showGitHubSyncTab();`);
  assert.equal(f.run("githubSyncAwaitingState"), false,
    "invalidated content must remain visible during its background refresh");
  assert.equal(f.requests.filter(item => item.command === "githubSyncState").length, 2);
});

test("conflict review explains decisions and keeps bulk source selection secondary", () => {
  const f = ui();
  const card = f.run(`githubSyncConflictPanel('t', {files:[
    {path:'notes/Changed.md',type:'notes',candidateSource:'unresolved',reason:'content-conflict',hasLocal:true,hasRemote:true,hasBase:true},
    {path:'notes/Moved.md',type:'notes',candidateSource:'unresolved',reason:'remote-deletion',hasLocal:true,hasRemote:false,hasBase:true},
    {path:'notes/Prepared.md',type:'notes',candidateSource:'local',hasLocal:true,hasRemote:true}
  ]})`);
  assert.match(card, /Start with the 2 members marked Choice required/);
  assert.match(card, /Neither side is automatically newer or more correct/);
  assert.match(card, /Check whether this file was moved before choosing deletion/);
  assert.match(card, /Prepared candidates · approval required/);
  assert.match(card, /<details class="github-sync-bulk-options"><summary>Advanced · bulk choices/);
  assert.doesNotMatch(card, /class="github-sync-bulk-options" open/);
  assert.match(f.run(`githubSyncConflictGuidance({candidateSource:'remote'})`), /not yet approved/);
  assert.match(f.run(`githubSyncConflictGuidance({candidateSource:'unresolved',reason:'path-collision'})`),
    /shared path is not proof of duplicate content/);
});

test("conflict review keeps Compare usable and bulk choices collapsed in a real browser", async t => {
  const { chromium } = require(process.env.PKM_PLAYWRIGHT_PATH || "playwright");
  const browser = await chromium.launch({headless:true,
    ...(process.env.PKM_CHROMIUM_EXECUTABLE ? {executablePath:process.env.PKM_CHROMIUM_EXECUTABLE} : {})});
  t.after(() => browser.close());
  const page = await browser.newPage({viewport:{width:760,height:800}});
  const errors = [];
  page.on("pageerror", error => errors.push(error.message));
  await page.setContent('<main id="review"></main>');
  await page.addStyleTag({path:path.join(root, "dist/webview/panel.css")});
  await page.evaluate(() => Object.assign(window, {
    esc:value=>String(value??"").replaceAll("&","&amp;").replaceAll("<","&lt;").replaceAll('"',"&quot;"),
    uiIcon:(_name,label)=>label||"", __posts:[], state:{tab:"other"},
    ask:(command,payload)=>window.__posts.push({command,payload}),
  }));
  await page.addScriptTag({content:source});
  await page.evaluate(() => {
    const conflict = {id:"current",revision:6,files:[
      {path:"notes/Changed.md",type:"notes",candidateSource:"unresolved",reason:"content-conflict",hasLocal:true,hasRemote:true},
      {path:"notes/Prepared.md",type:"notes",candidateSource:"remote",hasLocal:false,hasRemote:true},
    ]};
    githubSyncData = {conflicts:{t:conflict}};
    renderGitHubSyncPane = () => {
      document.getElementById("review").innerHTML=githubSyncConflictPanel("t",conflict);
    };
    renderGitHubSyncPane();
  });
  assert.equal(await page.getByRole("button",{name:"All Use GitHub",exact:true}).isVisible(), false);
  assert.equal(await page.getByRole("button",{name:"Compare",exact:true}).count(), 1);
  await page.getByRole("button",{name:"Compare",exact:true}).click();
  assert.deepEqual(await page.evaluate(()=>__posts), [{
    command:"githubSyncConflictOpen",payload:{targetId:"t",conflictId:"current",revision:6,path:"notes/Changed.md",mode:"compare"},
  }]);
  assert.equal(await page.getByRole("button",{name:"Apply resolutions & Sync",exact:true}).isDisabled(), true);
  await page.locator(".github-sync-resolved-group > summary").click();
  await page.waitForFunction(()=>document.querySelectorAll(".github-sync-conflict-file").length===2);
  assert.equal(await page.locator(".github-sync-conflict-file button").filter({hasText:/^Compare$/}).count(), 2);
  await page.locator(".github-sync-resolved-group .github-sync-diff-folder > summary").click();
  assert.match(await page.locator(".github-sync-resolved-group").innerText(), /not yet approved/);
  await page.locator(".github-sync-bulk-options > summary").click();
  assert.equal(await page.getByRole("button",{name:"All Use GitHub",exact:true}).isVisible(), true);
  assert.deepEqual(errors, []);
});

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

test("reopening Sync preserves cached error details until updated evidence arrives", () => {
  const f = ui();
  f.run(`githubSyncData={targets:[{id:'t',name:'Cached',lastFailure:{error:'obsolete cached failure'}}],runtime:{}};
    githubSyncUpdatedAt=100;renderGitHubSyncPane=()=>{};showGitHubSyncTab()`);
  assert.doesNotMatch(f.run("githubSyncCards()"), /Refreshing current Sync status/);
  assert.match(f.run("githubSyncCards()"), /obsolete cached failure/);
  assert(!f.requests.some(request => request.command === "githubSyncState"));
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
  const conflict = { targetId:"t", id:"conflict-current", revision:6, files:[] };
  let conflicts = [];
  const pending = [];
  const context = vm.createContext({
    githubSyncStateSequence: 0, JSON, Set,
    readGitHubSyncTargets: () => targets,
    githubAuthenticationOptionsCache: undefined, githubSyncCatalogCache: { value: {} },
    emptyGitHubSyncCatalog: () => ({}), githubSyncStateDirectory: () => "",
    listGitHubSyncConflicts: () => conflicts, readGitHubSyncContentRepair: () => undefined,
    withGitHubSyncTargetLock: async (_host, _target, action) => action(),
    clearEquivalentGitHubSyncConflict: () => false, refreshStaleGitHubSyncConflicts: () => 0,
    GITHUB_SYNC_CONTENT_TYPES: [], githubSyncScheduler: { snapshot: () => ({}) },
    githubSyncSecretKey: () => "key", githubPublicationMigration: () => ({ status: () => undefined }),
    readGitHubSyncCredentials: host => host.secrets.get("key"), githubSyncFailureDetails,
  });
  vm.runInContext(ts.transpileModule(declaration.getText(ast), { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText, context);
  const host = { secrets: { get: () => new Promise(resolve => pending.push(resolve)) } };
  const old = context.githubSyncStateData(host, false);
  targets = [{ id: "t", authentication: { method: "vscode" }, lastSync: { at: "now" } }];
  const fresh = context.githubSyncStateData(host, false);
  pending[1]("token");
  const latest = await fresh;
  targets = [{ id: "t", authentication: { method: "vscode" }, lastSync: { at: "later" } }];
  pending[0]("token");
  const late = await old;
  assert(late.snapshotSequence > latest.snapshotSequence, "sequence follows the final state read, not request start time");
  assert.equal(late.targets[0].lastFailure, undefined, "even a long-running snapshot cannot carry pre-success target errors");
  assert.equal(latest.targets[0].lastSync.at, "now");
  assert.equal(late.targets[0].lastSync.at, "later", "a slower request rereads and publishes the latest persisted state");
  conflicts = [conflict];
  const conflictSnapshot = await context.githubSyncStateData({secrets:{get:async () => "token"}}, false);
  assert.equal(conflictSnapshot.conflicts.t.revision, 6, "the UI receives the actual persisted conflict version");
  const frontend = ui();
  frontend.context.snapshot = conflictSnapshot;
  frontend.run("githubSyncData = snapshot");
  const request = frontend.run("githubSyncConflictRequest('t', {source:'remote'})");
  assert.equal(request.conflictId, conflict.id);
  assert.equal(request.revision, conflict.revision, "a displayed conflict round-trips its version instead of submitting zero");
  conflict.revision = 7;
  assert.notEqual(request.revision, conflict.revision, "a genuinely concurrent edit still produces a stale request");
});
