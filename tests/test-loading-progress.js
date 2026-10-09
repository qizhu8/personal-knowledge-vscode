#!/usr/bin/env node
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const vm = require('vm');
const { githubSyncCatalogInWorker } = require("../dist/sync/github-sync-catalog-worker");
const { GITHUB_SYNC_CONTENT_TYPES, githubSyncTargetFingerprintState, normalizeGitHubSyncTarget } = require("../dist/sync/github-sync");
const { githubSyncFingerprintInWorker } = require("../dist/sync/github-sync-fingerprint-worker");

const root = path.join(__dirname, '..');
const core = fs.readFileSync(path.join(root, 'src/webview/panel/00-core.js'), 'utf8');
const knowledge = fs.readFileSync(path.join(root, 'src/webview/panel/20-knowledge.js'), 'utf8');
const extension = fs.readFileSync(path.join(root, 'src/extension.ts'), 'utf8');
const html = fs.readFileSync(path.join(root, 'src/webview/panel.html'), 'utf8');
const css = fs.readFileSync(path.join(root, 'src/webview/panel.css'), 'utf8');
const projects = fs.readFileSync(path.join(root, 'src/webview/panel/15-projects.js'), 'utf8');
const mcp = fs.readFileSync(path.join(root, 'src/webview/panel/50-mcp.js'), 'utf8');
const init = fs.readFileSync(path.join(root, 'src/webview/panel/60-init.js'), 'utf8');
const manifest = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));

for (const id of ['loading-banner', 'view-loading-progress', 'view-loading-stage', 'view-loading-count', 'view-loading-bar']) assert(html.includes(`id="${id}"`), `${id} must exist`);
assert.doesNotMatch(html, /<script src="%%(?:CYTOSCAPE|MERMAID|FORCEGRAPH3D)_SRC%%"><\/script>/, 'large graph libraries must not block initial panel rendering');
for (const [library, meta] of [['CYTOSCAPE', 'cytoscape'], ['MERMAID', 'mermaid'], ['FORCEGRAPH3D', 'forcegraph3d']]) {
  assert.match(html, new RegExp(`<meta name="pkm-${meta}-src" content="%%${library}_SRC%%">`));
}
for (const [placeholder, meta] of [['MARKED', 'marked'], ['HLJS', 'highlight'], ['KATEX', 'katex']]) {
  assert.match(html, new RegExp(`<meta name="pkm-${meta}-src" content="%%${placeholder}_SRC%%">`));
}
for (const placeholder of ['MARKED', 'HLJS', 'KATEX']) {
  assert.doesNotMatch(html, new RegExp(`<script src="%%${placeholder}_SRC%%"><\\/script>`), `${placeholder} must not block first paint`);
}
assert.match(html, /Opening the interface…/);
for (const id of ['topbar', 'mcp-global-warning', 'workspace-shell', 'ctx-menu', 'sync-modal-bg']) {
  assert.match(html, new RegExp(`<div id="${id}"[^>]* hidden(?:>| )`),
    `${id} must use native first-paint isolation before external CSS loads`);
}
assert.match(html, /class="loading-logo"[^>]* hidden/);
assert.match(html, /class="loading-stage-count" hidden/);
assert.match(html, /class="loading-bar"[^>]* hidden/);
assert.match(css, /--pkm-panel-css-ready:1/);
assert.match(core, /const panelStylesReady = getComputedStyle\(document\.documentElement\)[\s\S]{0,180}=== '1';/);
assert.match(core, /if \(panelStylesReady\) \{[\s\S]{0,260}removeAttribute\('hidden'\);/,
  'the panel must reveal application roots only after its stylesheet readiness marker is present');
assert.match(core, /Panel stylesheet did not load; startup UI remained isolated\./,
  'stylesheet failure must fail closed instead of exposing raw controls');
assert.match(init, /void loadMarkdownLibraries\(\)/);
assert.match(core, /command: 'webviewStartupTiming'/);
assert.match(core, /function loadMarkdownLibraries\(\)/);
assert.match(core, /function ensurePanelLibrary\(globalName, metaName\)/);
assert.match(html, /id="loading-banner"(?![^>]*class="hidden")/, 'the first-paint loading shell must be visible before JavaScript runs');
assert.match(css, /\.view-loading-progress/);
assert.match(css, /\.loading-bar\{[^}]*accent-color/);
for (const stage of ['preparing', 'scanning', 'building-tree', 'ready']) assert(extension.includes(`stage: "${stage}"`), `Extension must report ${stage}`);
for (const stage of ['integration', 'runtime', 'mcp', 'retrieval', 'routers']) assert(extension.includes(`stage: "${stage}"`), `MCP maintenance must report ${stage}`);
assert.match(extension, /current: itemCount, total: itemCount/);
assert.match(extension, /detail: `\$\{folderCount\} folders`/);
assert.match(extension, /const activationDuration = Date\.now\(\) - activationStartedAt[\s\S]{0,180}recordPerformanceMetric[\s\S]{0,180}activation complete durationMs=\$\{activationDuration\}/);
assert.match(extension, /if \(firstConfiguration\) void maybeSeedExamples/);
assert.match(extension, /private noteRootCache: PkFolder \| undefined/);
assert.match(core, /if \(progress\.stage === 'ready'\)/);
assert.match(core, /function updateLoadingProgress\(progress = \{\}\) \{\s*if \(initialLoadComplete\) return;/,
  'progress events must be ignored after the first page load');
assert.doesNotMatch(core, /Dismiss loading banner on first response/);
assert.match(core, /loadingLabels = \{ list:/);
for (const message of ['Opening the spellbook…', 'Opening the enchanted notebook…', 'Preparing the Muggle gateway…', 'Summoning a house-elf…']) {
  assert(core.includes(message), `Magical progress copy must include: ${message}`);
}
assert(html.includes('Opening the interface…'));
assert(init.includes('Still waiting for data from the extension…'));
for (const command of ['projectState', 'envList', 'serverList', 'subscriptionState', 'chatState', 'checkMcp', 'skillRouterStatus', 'list']) {
  assert.match(init, new RegExp(`ask\\('${command}'`), `Initial-load retry must support ${command}`);
}
assert(!init.includes('Retrying the current view'), 'waiting copy must not imply that the initial request failed');
assert(!init.includes('Database is initializing'), 'the retry fallback must not speculate about database state');
for (const message of ['Revealing the Projects map…', 'Opening the Recipes grimoire…']) {
  assert(projects.includes(message), `Wizard loading copy must preserve its technical term: ${message}`);
}
assert(mcp.includes('Checking component health and paths in the background...'));
assert(mcp.includes('Status has not been received yet.'));
assert.match(core, /command === 'inventoryBatch'[^\n]+progress only/,
  'incremental inventory batches must not repeatedly rebuild the visible tree');
assert.match(knowledge, /skill-list-progress[^\n]+Finding skills/,
  'opening Skills must show progress before its first result');
assert.match(css, /\.skill-list-progress progress\{/);
assert.match(extension, /if \(tab === "skills" && !msg\.silent[\s\S]{0,520}command: "listPartial"[\s\S]{0,140}setTimeout\(resolve, 16\)/,
  'Skills must stream bounded visible batches while yielding for paint');
assert.match(core, /command === 'list' \|\| command === 'listPartial'/);
assert.match(core, /\(e\.data\.q \|\| ''\) !== state\.search/,
  'stale Skills search results must not overwrite the active query');
assert.match(knowledge, /skillsListLoading \? `<div class="skill-list-progress"[^\n]+items\.length/,
  'partial Skills results must retain a visible count and pending indicator');
const skillList = { innerHTML: '' };
const skillView = {
  state: { tab:'skills', items:[], folders:[], search:'', filter:'all' },
  skillsListLoading: true,
  document: { getElementById: id => id === 'item-list' ? skillList : {} },
  ensureGitHubSyncStatus() {}, renderKnowledgeGroupControls() {},
  buildCatTree: items => items, seedFolders() {},
  renderGroupedKnowledgeTree: items => items.map(item => `<div>${item.name}</div>`).join(''),
  setKnowledgeListMarkup: (element, tab, markup) => { element.innerHTML = markup; },
  renderSubscribedGroups() {}, renderKnowledgeTrashDock() {},
};
vm.createContext(skillView);
const skillRenderStart = knowledge.indexOf('function renderList()');
vm.runInContext(`${knowledge.slice(skillRenderStart, knowledge.indexOf('\nfunction renderSubscribedGroups(', skillRenderStart))};this.render=renderList`, skillView);
skillView.render();
assert.match(skillList.innerHTML, /0 skills found; loading more/);
assert.doesNotMatch(skillList.innerHTML, /No skills/);
skillView.state.items = [{ name:'First' }, { name:'Second' }];
skillView.render();
assert.match(skillList.innerHTML, /2 skills found; loading more/);
assert.match(skillList.innerHTML, /First/);
assert.match(skillList.innerHTML, /Second/);
skillView.skillsListLoading = false;
skillView.render();
assert.doesNotMatch(skillList.innerHTML, /loading more/);
assert.match(skillList.innerHTML, /First/);
assert.match(core, /command === 'inventoryReady'[\s\S]{0,260}\['skills','notes','scripts'\]\.forEach\(invalidateKnowledgeTabView\)/);
assert.match(core, /command === 'inventoryReady'[\s\S]{0,360}ask\('list',[^\n]+null, true\)/,
  'completed inventory refreshes the visible indexed tab exactly once and silently');
assert.match(core, /command === 'reloaded'[\s\S]{0,420}changedArea === state\.tab/,
  'filesystem reload refreshes only the affected visible content tab');
assert.match(core, /function ask\(command, payload, button, silent = false\)/);
assert.match(core, /if \(!silent && loadingLabels\[command\]\)/);
assert.match(core, /\.\.\.\(silent \? \{ silent:true \} : \{\}\)/,
  'silent background refresh intent must reach the extension host');
assert.doesNotMatch(extension, /message: "Scanning Knowledge inventory…"/,
  'the background inventory worker must not emit visible progress');
for (const stage of ['scanning', 'building-tree', 'ready']) {
  assert.match(extension, new RegExp(`if \\(!msg\\.silent\\) respond\\(\\{ command: "loadingProgress", data: \\{ stage: "${stage}"`),
    `${stage} list progress must be suppressed for background refreshes`);
}
assert.match(core, /setTimeout\([\s\S]{0,300}, 1000\)/);
assert.match(core, /if \(isInitialViewResponse\(command, e\.data\)\) finishLoadingProgress\(\)/);
for (const command of ['subscriptionState', 'subscriptionError', 'subscriptionSecret', 'subscriptionCompleted']) {
  assert.match(core, new RegExp(`command === '${command}'[\\s\\S]{0,1200}finishLoadingProgress\\(\\)`), `${command} must close loading progress`);
}
assert.match(core, /function showInitialViewError\(title, message, retryCommand\)/);
assert.match(core, /GitHub Sync could not load[\s\S]{0,180}'githubSyncState'/,
  'GitHub Sync state failures must replace the indefinite loading view with a retryable error');
assert.match(core, /Sharing & Subscribe could not load[\s\S]{0,180}'subscriptionState'/,
  'Sharing & Subscribe state failures must replace the indefinite loading view with a retryable error');
const profilingSetting = manifest.contributes.configuration.properties['personalKnowledge.loadProfilingEnabled'];
assert.deepStrictEqual(profilingSetting && { type:profilingSetting.type, default:profilingSetting.default, scope:profilingSetting.scope },
  { type:'boolean', default:false, scope:'machine' },
  'load profiling must be an explicit machine-local opt-in');
for (const event of [
  'host.request.received', 'host.request.completed', 'host.list.source', 'host.list.sharing',
  'host.list.folders', 'host.list.groups', 'host.list.trash', 'host.list.privacy', 'host.list.respond',
  'host.mcp.status', 'host.mcp.python', 'host.mcp.runtime', 'host.mcp.skill_proposals',
  'host.mcp.skill_projection', 'host.mcp.usage'
]) assert(extension.includes(`"${event}"`), `load profiling must record ${event}`);
const knowledgePanel = fs.readFileSync(path.join(root, 'src/webview/panel/20-knowledge.js'), 'utf8');
for (const event of ['webview.workspace.clicked', 'webview.tab.clicked', 'webview.response.received', 'webview.response.rendered']) {
  assert(core.includes(`'${event}'`) || knowledgePanel.includes(`'${event}'`),
    `webview load profiling must record ${event}`);
}
assert.match(mcp, /Profile first-open and view loading/);
assert.match(mcp, /showLoadProfilingOutput/);
assert.match(mcp, /openLoadProfilingLog/);
assert.match(mcp, /clearLoadProfilingLog/);
assert.match(mcp, /renderIntegrationGuide\(data\)[\s\S]{0,100}<section data-settings-panel="debug">\$\{renderLoadProfiling\(data\)\}/,
  'low-frequency Load profiling controls must render in the Debug Settings subtab');
assert.match(extension, /type LoadProfileFields = Record<string, string \| number \| boolean \| undefined>/,
  'profiling fields must remain constrained to privacy-safe scalar metadata');
assert.strictEqual((init.match(/ask\('githubSyncState'/g) || []).length, 1,
  'GitHub Sync state must load only when its tab is restored, not as an unconditional startup prefetch');
const readyHandler = extension.slice(extension.indexOf('case "ready":'), extension.indexOf('case "projectState":'));
assert.match(readyHandler, /command: "mcpSummary"/,
  'ready must send only the lightweight MCP warning summary');
assert.doesNotMatch(readyHandler, /mcpPanelStatusData|sendMcpPathSizes/,
  'ready must not probe the MCP runtime, scan usage, or calculate path sizes');
const githubState = extension.slice(extension.indexOf('async function githubSyncStateData'), extension.indexOf('\nasync function gitHubSyncConflictData'));
assert.match(githubState, /if \(waitForExpensive\)[\s\S]*await githubSyncFingerprintInWorker/,
  'selected content fingerprints must only be computed during the deferred GitHub state pass');
assert.match(githubState, /fingerprintsDeferred: !waitForExpensive/,
  'deferred GitHub fingerprints must be explicit until the expensive pass completes');
const subscriptionState = extension.slice(extension.indexOf('async function subscriptionStateData'), extension.indexOf('\ninterface GitHubSubscriptionRequest'));
assert.doesNotMatch(subscriptionState, /refreshGatewayStatus/,
  'the first Network & Sharing response must use cached gateway state');
assert.match(extension, /case "subscriptionState":[\s\S]{0,260}respond\(\{ command: "subscriptionState"[\s\S]{0,260}refreshGatewayStatus/,
  'Network & Sharing must respond before refreshing gateway status in the background');
assert.match(extension, /Promise\.race\(\[[\s\S]{0,220}setTimeout\(\(\) => resolve\(undefined\), 1_000\)/,
  'Skill Router status must bound the foreground worker wait');
const skillRouterState = extension.slice(extension.indexOf('async function skillRouterStatusData'), extension.indexOf('\nasync function refreshRetrievalIndex'));
assert.doesNotMatch(skillRouterState, /currentRetrievalSnapshot\(\)/,
  'Skill Router status must not synchronously rebuild the complete retrieval corpus');
assert.match(skillRouterState, /knowledgeInventory\?\.snapshot/,
  'Skill Router status must use cached inventory metadata');
assert.match(extension, /case "githubSyncState":[\s\S]{0,180}githubSyncStateData\(context, false\)[\s\S]{0,260}githubSyncStateData\(context, true\)/,
  'GitHub Sync must return cached state before its single-flight catalog and credential refresh');
assert.match(extension, /githubSyncCatalogBuild\?\.revision === revision[\s\S]{0,220}return githubSyncCatalogBuild\.promise/,
  'concurrent GitHub state requests must share one catalog build');
assert.match(extension, /return githubSyncCatalogInWorker\(\{ root, servers, recipes \}\)/,
  'opening GitHub Sync must scan content outside the Extension Host');
assert.match(extension, /previousBuild\.catch\(\(\) => undefined\)\.then\(buildGitHubSyncCatalog\)/,
  'invalidated catalog scans must not race while creating Script identity sidecars');
assert.match(extension, /case "checkMcp":[\s\S]{0,180}mcpPanelStatusData\(String\(msg\.profileRequestId \|\| ""\), false\)/,
  'opening General & MCP must defer usage scanning');
assert.doesNotMatch(extension.slice(extension.indexOf('case "checkMcp":'), extension.indexOf('case "mcpSetFeatureDomain":')), /sendMcpPathSizes/,
  'opening General & MCP must defer disk-size traversal until explicitly requested');
assert.match(mcp, /ask\('refreshMcpUsage'/);
assert.match(mcp, /Not calculated/);

const responseStart = core.indexOf('function isInitialViewResponse');
const responseEnd = core.indexOf('\nfunction finishLoadingProgress', responseStart);
const responseContext = { state: { tab: 'recipes' } };
vm.createContext(responseContext);
vm.runInContext(`${core.slice(responseStart, responseEnd)};this.matches=isInitialViewResponse`, responseContext);
assert.strictEqual(responseContext.matches('projectState', {}), true);
assert.strictEqual(responseContext.matches('list', { tab:'recipes' }), false);
responseContext.state.tab = 'notes';
assert.strictEqual(responseContext.matches('list', { tab:'skills' }), false, 'A stale list response must not finish the active view');
assert.strictEqual(responseContext.matches('list', { tab:'notes' }), true);
for (const [tab, command] of Object.entries({ environments:'envList', servers:'serverList', agentSessions:'projectState', chatroom:'chatState', mcp:'mcpStatus', skillRouter:'skillRouterStatus', subscriptions:'subscriptionState' })) {
  responseContext.state.tab = tab;
  assert.strictEqual(responseContext.matches(command, {}), true, `${command} must finish ${tab} startup`);
}

function element() {
  return {
    textContent: '', value: 0, classList: { values: new Set(), toggle(name, enabled) { enabled ? this.values.add(name) : this.values.delete(name); }, add(name) { this.values.add(name); }, remove(name) { this.values.delete(name); }, contains(name) { return this.values.has(name); } },
    querySelector(selector) { return this.children?.[selector] || null; }, remove() {},
  };
}
const banner = element();
const sub = element(), amount = element(), bannerBar = element();
banner.children = { '.loading-sub': sub, '.loading-stage-count': amount, progress: bannerBar };
const strip = element(), stage = element(), detail = element(), count = element(), stripBar = element();
banner.classList.add('hidden');
strip.classList.add('hidden');
const elements = { 'loading-banner': banner, 'view-loading-progress': strip, 'view-loading-stage': stage, 'view-loading-detail': detail, 'view-loading-count': count, 'view-loading-bar': stripBar };
const start = core.indexOf('function updateLoadingProgress');
const end = core.indexOf('\n// ── Topbar overflow', start);
assert(start >= 0 && end > start);
let nextTimer = 0;
const timers = new Map();
const context = {
  initialLoadComplete: false, loadingProgressTimer: null, loadingRevealTimer: null, latestLoadingProgress: null, loadingProgressVisible: false,
  document: { getElementById: id => elements[id] || null },
  setTimeout: fn => { const id = ++nextTimer; timers.set(id, fn); return id; },
  clearTimeout: id => timers.delete(id), Number,
};
vm.createContext(context);
vm.runInContext(`${core.slice(start, end)};this.update=updateLoadingProgress;this.finish=finishLoadingProgress`, context);
context.update({ stage: 'scanning', percent: 25, current: 473, message: 'Opening the enchanted notebook…' });
assert(banner.classList.contains('hidden'), 'progress must remain hidden before one second');
context.update({ stage: 'ready', percent: 100, current: 473, total: 473, message: 'Ready' });
assert(banner.classList.contains('hidden'), 'fast jobs must finish without ever revealing progress');
assert.strictEqual(context.loadingProgressVisible, false);

context.initialLoadComplete = true;
const postLoadTimerCount = timers.size;
context.update({ stage: 'request', percent: 8, message: 'Refreshing from disk…' });
assert(strip.classList.contains('hidden'), 'post-load progress must remain hidden');
assert.strictEqual(timers.size, postLoadTimerCount, 'post-load progress must not schedule a delayed reveal');
assert.notStrictEqual(stage.textContent, 'Refreshing from disk…', 'post-load progress must not update the hidden strip');

context.initialLoadComplete = false;
banner.classList.add('hidden');
context.update({ stage: 'scanning', percent: 25, current: 473, message: 'Opening the enchanted notebook…' });
[...timers.values()].pop()();
assert.strictEqual(sub.textContent, 'Opening the enchanted notebook…');
assert.strictEqual(amount.textContent, '473 found');
assert.strictEqual(bannerBar.value, 25);
assert.strictEqual(context.initialLoadComplete, false);
context.update({ stage: 'ready', percent: 100, current: 473, total: 473, message: 'Ready', detail: '86 folders' });
assert.strictEqual(context.initialLoadComplete, true);
assert(banner.classList.contains('hidden'));

async function verifyFingerprintWorker() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'pkm-fingerprint-worker-'));
  try {
    const source = path.join(directory, 'skill.md');
    fs.writeFileSync(source, '---\nname: Test\n---\n# Test\n');
    const catalog = Object.fromEntries(GITHUB_SYNC_CONTENT_TYPES.map(type => [type, []]));
    catalog.skills.push({ id: 'Test', label: 'Test', cat: '', isPrivate: false, source, destination: 'skills/skill.md' });
    catalog.recipes.push({ id: 'recipe', label: 'Recipe', cat: '', isPrivate: false, content: '{"name":"Recipe","editorLayout":{}}', destination: 'recipes/recipe.json' });
    const target = normalizeGitHubSyncTarget({ name: 'Test', repository: 'owner/repo', branch: 'main' }, () => 'test');
    const expected = githubSyncTargetFingerprintState(target, catalog);
    let timerFired = false;
    const resultPromise = githubSyncFingerprintInWorker(target, catalog);
    setTimeout(() => { timerFired = true; }, 0);
    const actual = await resultPromise;
    assert.deepStrictEqual(actual, expected, 'worker must preserve fingerprint and folder semantics');
    assert(timerFired, 'the Extension Host event loop must keep running while fingerprints are calculated');
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
}

async function verifyCatalogWorker() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'pkm-catalog-worker-'));
  try {
    const skillDir = path.join(directory, 'skills', 'Shared');
    const assets = path.join(skillDir, '_assets');
    fs.mkdirSync(assets, { recursive: true });
    fs.writeFileSync(path.join(assets, 'icon.png'), Buffer.from([1, 2, 3]));
    fs.writeFileSync(path.join(skillDir, 'Test.md'), '---\nname: "Test"\n---\n![icon](_assets/icon.png)\n');
    fs.mkdirSync(path.join(directory, 'scripts'));
    fs.writeFileSync(path.join(directory, 'scripts', 'example.py'), 'print("hello")\n');
    fs.mkdirSync(path.join(directory, '.pkm'));
    fs.writeFileSync(path.join(directory, '.pkm', 'content-privacy.json'), JSON.stringify({ schema: 1, private: { skills: ['Shared'] } }));
    const recipe = { id: 'recipe', label: 'Recipe', cat: '', isPrivate: false, destination: 'recipes/recipe.json', content: '{}' };
    let timerFired = false;
    const pending = githubSyncCatalogInWorker({ root: directory, servers: [{ slug: 'server', name: 'Server', category: '', tags: [] }], recipes: [recipe] });
    setTimeout(() => { timerFired = true; }, 0);
    const catalog = await pending;
    assert(timerFired, 'the Host must remain responsive during catalog scanning');
    assert.strictEqual(catalog.skills.length, 1);
    assert.strictEqual(catalog.skills[0].isPrivate, true);
    assert.strictEqual(catalog.skills[0].dependencies[0].destination, 'skills/Shared/_assets/icon.png');
    assert.strictEqual(catalog.scripts[0].dependencies[0].destination.startsWith('scripts/'), true);
    assert.strictEqual(catalog.servers[0].source, path.join(directory, 'servers', 'server'));
    assert.deepStrictEqual(catalog.recipes, [recipe]);
    fs.writeFileSync(path.join(directory, '.pkm', 'content-privacy.json'), '{bad json');
    await assert.rejects(githubSyncCatalogInWorker({ root: directory, servers: [], recipes: [] }), /privacy metadata/,
      'catalog worker errors must propagate to Settings rather than hanging');
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
}

Promise.all([verifyFingerprintWorker(), verifyCatalogWorker()]).then(() => {
  console.log('loading progress test: staged loading and nonblocking catalog and fingerprints OK');
}).catch(error => { console.error(error); process.exitCode = 1; });
