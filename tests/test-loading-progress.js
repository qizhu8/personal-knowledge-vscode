#!/usr/bin/env node
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const root = path.join(__dirname, '..');
const core = fs.readFileSync(path.join(root, 'src/webview/panel/00-core.js'), 'utf8');
const extension = fs.readFileSync(path.join(root, 'src/extension.ts'), 'utf8');
const html = fs.readFileSync(path.join(root, 'src/webview/panel.html'), 'utf8');
const css = fs.readFileSync(path.join(root, 'src/webview/panel.css'), 'utf8');
const projects = fs.readFileSync(path.join(root, 'src/webview/panel/15-projects.js'), 'utf8');
const mcp = fs.readFileSync(path.join(root, 'src/webview/panel/50-mcp.js'), 'utf8');
const init = fs.readFileSync(path.join(root, 'src/webview/panel/60-init.js'), 'utf8');

for (const id of ['loading-banner', 'view-loading-progress', 'view-loading-stage', 'view-loading-count', 'view-loading-bar']) assert(html.includes(`id="${id}"`), `${id} must exist`);
assert.match(html, /id="loading-banner" class="hidden"/);
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
assert(html.includes('Brewing a potion for your knowledge store…'));
assert(init.includes('Still waiting for data from the extension…'));
for (const command of ['projectState', 'envList', 'serverList', 'subscriptionState', 'chatState', 'checkMcp', 'skillRouterStatus', 'list']) {
  assert.match(init, new RegExp(`ask\\('${command}'`), `Initial-load retry must support ${command}`);
}
assert(!init.includes('Retrying the current view'), 'waiting copy must not imply that the initial request failed');
assert(!init.includes('Database is initializing'), 'the retry fallback must not speculate about database state');
for (const message of ['Revealing the Projects map…', 'Opening the Recipes grimoire…']) {
  assert(projects.includes(message), `Wizard loading copy must preserve its technical term: ${message}`);
}
assert(mcp.includes('Consulting the MCP server wards…'));
assert.match(core, /command === 'inventoryBatch'[^\n]+progress only/,
  'incremental inventory batches must not repeatedly rebuild the visible tree');
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

console.log('loading progress test: initial-load-only progress, staged counts, and fast-job suppression OK');
