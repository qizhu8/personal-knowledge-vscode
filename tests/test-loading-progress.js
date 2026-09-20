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
assert.doesNotMatch(core, /Dismiss loading banner on first response/);
assert.match(core, /loadingLabels = \{ list:/);
assert.match(core, /command === 'inventoryBatch'[\s\S]{0,180}\['skills','notes','scripts'\]\.includes\(state\.tab\)/);
assert.match(core, /command === 'inventoryBatch'[\s\S]{0,260}ask\('list',[^\n]+null, true\)/,
  'background inventory refreshes must not reveal progress');
assert.match(core, /command === 'reloaded'[\s\S]{0,260}\['skills','notes','papers','prompts','packages','scripts'\]\.includes\(state\.tab\)/,
  'filesystem reload must not request a list for Chatroom');
assert.match(core, /command === 'reloaded'[\s\S]{0,360}ask\('list',[^\n]+null, true\)/,
  'filesystem reload list refreshes must remain silent');
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
for (const command of ['subscriptionState', 'subscriptionError', 'subscriptionSecret', 'subscriptionCompleted']) {
  assert.match(core, new RegExp(`command === '${command}'[\\s\\S]{0,1200}finishLoadingProgress\\(\\)`), `${command} must close loading progress`);
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
context.update({ stage: 'scanning', percent: 25, current: 473, message: 'Scanning notes files…' });
assert(banner.classList.contains('hidden'), 'progress must remain hidden before one second');
context.update({ stage: 'ready', percent: 100, current: 473, total: 473, message: 'Ready' });
assert(banner.classList.contains('hidden'), 'fast jobs must finish without ever revealing progress');
assert.strictEqual(context.loadingProgressVisible, false);

context.initialLoadComplete = true;
context.update({ stage: 'request', percent: 8, message: 'Refreshing from disk…' });
assert(strip.classList.contains('hidden'), 'post-load progress must also wait one second');
const reveal = [...timers.values()].pop();
assert(reveal, 'slow jobs must schedule a delayed reveal');
reveal();
assert(!strip.classList.contains('hidden'), 'slow jobs must reveal progress after one second');
assert.strictEqual(stage.textContent, 'Refreshing from disk…');
context.finish();
assert(strip.classList.contains('hidden'), 'terminal responses must close progress');

context.initialLoadComplete = false;
banner.classList.add('hidden');
context.update({ stage: 'scanning', percent: 25, current: 473, message: 'Scanning notes files…' });
[...timers.values()].pop()();
assert.strictEqual(sub.textContent, 'Scanning notes files…');
assert.strictEqual(amount.textContent, '473 found');
assert.strictEqual(bannerBar.value, 25);
assert.strictEqual(context.initialLoadComplete, false);
context.update({ stage: 'ready', percent: 100, current: 473, total: 473, message: 'Ready', detail: '86 folders' });
assert.strictEqual(context.initialLoadComplete, true);
assert(banner.classList.contains('hidden'));

console.log('loading progress test: one-second threshold, staged counts, fast-job suppression, and Subscription cleanup OK');
