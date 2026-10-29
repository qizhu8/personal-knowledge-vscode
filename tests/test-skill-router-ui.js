#!/usr/bin/env node
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const root = path.join(__dirname, '..');
const panelHtml = fs.readFileSync(path.join(root, 'src', 'webview', 'panel.html'), 'utf8');
const panelJs = fs.readFileSync(path.join(root, 'dist', 'webview', 'panel.js'), 'utf8');
const panelCss = fs.readFileSync(path.join(root, 'dist', 'webview', 'panel.css'), 'utf8');
const extensionTs = fs.readFileSync(path.join(root, 'src', 'extension.ts'), 'utf8');

assert.match(panelHtml, /data-tab="skillRouter">Router</);
assert.match(panelJs, /state\.tab === 'skillRouter'[\s\S]{0,300}ask\('skillRouterStatus'/);
assert.match(panelJs, /command === 'skillRouterStatus'/);
assert.match(panelJs, /Retrieval & Performance/);
assert.match(panelJs, /Exact \+ BM25 works without it/);
assert.match(panelJs, /Embedding retrieval/);
assert.match(panelJs, /Download from Hugging Face/);
assert.match(panelJs, /Import model directory/);
assert.match(panelJs, /Import offline package/);
assert.match(panelJs, /Choose model Python/);
for (const command of ["retrievalSolutionImport", "retrievalSolutionRuntime", "retrievalSolutionEnable",
  "retrievalSolutionRebuild", "retrievalSolutionDisable", "retrievalSolutionDelete"]) {
  assert(extensionTs.includes(`case "${command}"`), `missing lifecycle handler ${command}`);
}
assert.match(panelJs, /Calibration Function/);
assert.match(extensionTs, /case "skillRouterStatus"/);
assert.match(extensionTs, /activeProfile = enabledSolutions\.includes\("l1_online"\) \? "l1_online" : "copilot_default"/,
  'the active path must resolve from enabled mature solutions with automatic Copilot fallback');
assert.match(extensionTs, /case "setSkillRouterSolutionEnabled"/);
assert.match(extensionTs, /case "setSkillRouterSourcePriority"/);
assert.match(extensionTs, /enabled\.add\("copilot_default"\)/,
  'every route update must preserve the automatic fallback');
assert.match(extensionTs, /Copilot default is the required automatic fallback and cannot be disabled yet/);
assert.doesNotMatch(extensionTs, /setSkillRouterProfile/,
  'an unimplemented path must not expose a persistence command');

const start = panelJs.indexOf('const skillRouterBenchmarks');
const panelRestoreStart = panelJs.indexOf('// UI snapshots contain data only', start);
const end = panelRestoreStart > start ? panelRestoreStart : panelJs.indexOf('// ── Init', start);
assert(start >= 0 && end > start, 'Skill Router renderer must be included before panel initialization');
const detail = { innerHTML: '' };
const routerSection = { dataset:{}, closest() { return this; }, setAttribute() {}, replaceWith() {}, appendChild() {},
  querySelector:() => null, querySelectorAll:() => [] };
const routerRoot = { querySelector:() => routerSection, querySelectorAll:() => [] };
const calls = [];
const timers = new Map();
const context = {
  console,
  state: { tab: 'skills' },
  setTimeout: callback => { const id = timers.size + 1; timers.set(id, callback); return id; },
  clearTimeout: id => timers.delete(id),
  esc: value => String(value ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'),
  ask: (command, data) => calls.push({ command, data }),
  settingsSubtabs: {},
  uiIcon: () => '',
  applySettingsSubtab: () => {},
  document: {
    createElement: () => ({ ...routerSection, dataset:{} }),
    getElementById: id => id === 'detail' ? detail : null,
    querySelector: () => routerRoot,
    querySelectorAll: () => [],
  },
};
vm.createContext(context);
const tabsStart = panelJs.indexOf('function settingsTabBar(');
const tabsEnd = panelJs.indexOf('function selectSettingsSubtab(', tabsStart);
assert(tabsStart >= 0 && tabsEnd > tabsStart);
new vm.Script(panelJs.slice(tabsStart, tabsEnd)).runInContext(context);
new vm.Script(`${panelJs.slice(start, end)}; this.renderSkillRouterPane = renderSkillRouterPane; this.toggleSolution = skillRouterToggleSolution; this.moveSource = skillRouterMoveSource; this.setStatusCache = data => { skillRouterStatusCache = data; };`).runInContext(context);
const routerData = {
  activeProfile: 'l1_online',
  enabledSolutions: ['copilot_default', 'l1_online'],
  solutions: {
    copilot_default: { available: true, mature: true, enabled: true, externallyServed: true },
    l1_exact: { available: false, mature: false, enabled: false },
    l1_online: { available: true, mature: true, enabled: true },
    l1_weighted: { available: false, mature: false, enabled: false, systemDisabled: true },
  },
  modelBasedRoutingEnabled: false,
  sourcePriority: ['pkm-personal', 'agent-native', 'subscriber:sub-1'],
  sources: [
    { id: 'pkm-personal', label: 'PKM Personal', kind: 'personal', detail: 'Personal Skills' },
    { id: 'agent-native', label: 'Agent Native', kind: 'native', detail: 'Host Skills' },
    { id: 'subscriber:sub-1', label: 'Team Broker', kind: 'subscriber', detail: 'Subscriber · Colleague' },
  ],
  collector: {
    collectedTools: ['pkm.skill_context', 'pkm.search_knowledge', 'pkm.search_notes'],
    unavailableTools: ['vscode.tool_search', 'vscode.grep_search'],
    queryTextCollected: false,
  },
  corpus: { documentCount: 523, revision: 'abcdef1234567890' },
  runtime: { ready: true, documentCount: 523, corpusRevision: 'abcdef1234567890', engineVersion: '0.3.0', configurationHash: '1234567890abcdef' },
};
context.renderSkillRouterPane(routerData);
assert.match(detail.innerHTML, /id="sr-text-solutions"/);
assert.match(detail.innerHTML, /No weights or dependencies are downloaded automatically|Loading model catalog/);
assert.match(detail.innerHTML, /Semantic path<\/dt><dd>Not reported/);
context.renderSkillRouterPane({ ...routerData, runtime: { ready: true, semanticStatus: 'unavailable',
  solution: { requested_package_id: null, active_package_id: null },
  skillServing: { ready: false, error: "No module named 'adaptive_skill_retrieval.architecture_retriever' <unsafe>" } } });
assert.match(detail.innerHTML, /Explicit semantic \/ dual readiness/);
assert.match(detail.innerHTML, /Semantic path<\/dt><dd>unavailable/);
assert.match(detail.innerHTML, /Frozen Skill release<\/dt><dd>Not ready/);
assert.match(detail.innerHTML, /No module named 'adaptive_skill_retrieval.architecture_retriever' &lt;unsafe&gt;/);
assert.doesNotMatch(detail.innerHTML, /<unsafe>/);
assert.match(extensionTs, /semanticStatus: status.semantic_status/);
assert.match(extensionTs, /skillServing: status.skill_serving/);
context.renderSkillRouterPane(routerData);
assert.match(detail.innerHTML, /data-settings-tab="sources"/);
assert.match(detail.innerHTML, /data-settings-tab="performance"/);
assert.match(detail.innerHTML, /data-settings-tab="privacy"/);
context.setStatusCache(routerData);
for (const text of ['Copilot default search', 'Exact + BM25', 'Model-based retrieval', 'Semantic / Dual', 'Success@5', 'Precision@5', 'NDCG@5', 'Latency p50 / p95', 'Run benchmark']) {
  assert(detail.innerHTML.includes(text), `missing Skill Router performance content: ${text}`);
}
for (const absent of ['Recall@1', 'Recall@5', 'Tokens saved']) assert(!detail.innerHTML.includes(absent), `${absent} has no measured signal`);
assert.match(detail.innerHTML, /No measured run yet/);
assert.doesNotMatch(detail.innerHTML, /<td>0%<\/td>/, 'missing metrics must not be shown as zero');
context.renderSkillRouterPane({ ...routerData, benchmark: { running:true } });
assert.match(detail.innerHTML, /Measuring…/);
assert.match(detail.innerHTML, /ask\('runSkillRouterBenchmark',\{\}\)" disabled/);
context.renderSkillRouterPane({ ...routerData, benchmark: { generatedAt:'2026-10-01T00:00:00Z', metrics: {
  judgedQueries:5, samples:25, successRate:0.8, precisionAt5:0.16, ndcgAt5:0.6, latencyMs:{ p50:9.2, p95:24.1 },
} } });
assert.match(detail.innerHTML, /5 labeled queries · 25 runs/);
assert.match(detail.innerHTML, /<td>80%<\/td><td>16%<\/td><td>60%<\/td>/);
assert.match(detail.innerHTML, /9\.2 \/ 24\.1 ms/);
context.renderSkillRouterPane({ ...routerData, benchmark: { error:'worker unavailable' } });
assert.match(detail.innerHTML, /Benchmark failed: worker unavailable/);
context.renderSkillRouterPane(routerData);
assert.match(detail.innerHTML, /Model retrieval is not enabled/);
assert.doesNotMatch(detail.innerHTML, /Proposed Parameter Map/);
assert.match(detail.innerHTML, /Automatic fallback: Exact \+ BM25 → Copilot default/);
assert.match(detail.innerHTML, /Skill source priority/);
assert.match(detail.innerHTML, /PKM Personal[\s\S]*Agent Native[\s\S]*Team Broker/);
assert.match(detail.innerHTML, /draggable="true"/);
assert.match(detail.innerHTML, /Agent Native is selected by the active Agent host/);
assert.match(detail.innerHTML, /data-sr-profile="model_based"[\s\S]*Not enabled/);
assert.doesNotMatch(detail.innerHTML, /Model-based Hybrid remains system-disabled/);
assert.match(extensionTs, /modelBasedRoutingEnabled: runtime\.semanticStatus === "ready"/);
context.renderSkillRouterPane({ ...routerData, runtime: { semanticStatus:'ready',
  solution:{ state:'ready', requested_package_id:'model', active_package_id:'model' } } });
assert.match(detail.innerHTML, /data-sr-profile="model_based"[\s\S]*Available/);
assert.doesNotMatch(detail.innerHTML.match(/data-sr-profile="model_based"[\s\S]*?<\/tr>/)[0], /Serving|type="checkbox"/);
context.renderSkillRouterPane(routerData);
assert.match(detail.innerHTML, /No measured run yet/);
assert.match(detail.innerHTML, /Copilot default search[\s\S]*Required fallback/);
assert.match(detail.innerHTML, /Exact \+ BM25[\s\S]*Serving/);
assert.match(detail.innerHTML, /Router Privacy Statement/);
assert.match(detail.innerHTML, /Raw query and task text, workspace paths, file names, diagnostics, and loaded knowledge content are excluded/);
assert.match(detail.innerHTML, /tool name, duration, success state, result count, hashed result identities, and active routes/);
assert.match(detail.innerHTML, /_feedback\/skill-usage\.jsonl/);
assert.match(detail.innerHTML, /does not train or modify embedding-model weights/);
assert.match(detail.innerHTML, /github\.com\/qizhu8\/personal-knowledge-vscode/);
assert(detail.innerHTML.indexOf('Router Privacy Statement') < detail.innerHTML.indexOf('<h3>Runtime</h3>'),
  'privacy statement must appear before runtime details');
assert.match(detail.innerHTML, /Search data collector/);
assert.match(detail.innerHTML, /pkm\.skill_context · pkm\.search_knowledge · pkm\.search_notes/);
assert.match(detail.innerHTML, /tool_search and grep_search do not expose invocation events/);
assert.doesNotMatch(detail.innerHTML, /type="radio"|Choose target|Preferred target/);
assert.match(detail.innerHTML, /L2 evidence ranges are materialized separately/);
assert.match(detail.innerHTML, /Candidate · planned/);
assert.match(detail.innerHTML, /150 updates is a proposal, not a configured gate/);
assert.match(detail.innerHTML, /aria-label="Stage details"/);
context.toggleSolution('l1_online', false);
context.moveSource('agent-native', -1);
assert.strictEqual(JSON.stringify(calls), JSON.stringify([
  { command: 'setSkillRouterSolutionEnabled', data: { solution: 'l1_online', enabled: false } },
  { command: 'setSkillRouterSourcePriority', data: { sourceIds: ['agent-native', 'pkm-personal', 'subscriber:sub-1'] } },
]));
assert.match(panelCss, /\.sr-table-wrap\{max-width:100%;overflow-x:auto\}/);
assert.match(panelCss, /\.sr-parameter-map\{[^}]*overflow-x:auto/);
assert.match(panelCss, /\.sr-source-row\{[^}]*cursor:grab/);
assert.match(panelCss, /\.sr-dashboard \.settings-subtabs\{[^}]*grid-template-columns:repeat\(3,minmax\(0,1fr\)\)/);
assert.match(panelJs, /unavailable: no reported judgments with a valid denominator/);
assert.match(panelJs, /Number\.isFinite\(point\.y\)/);
assert.match(panelJs, /Original and Current Calibration Functions/);

context.skillRouterSolutionsOnSnapshot({ packages: [], state: 'idle' });
assert.match(context.skillRouterSolutionsHtml(), /No imported models/);
context.skillRouterSolutionRequest('retrievalSolutionImport');
const operationId = calls.at(-1).data.requestId;
assert(operationId);
context.skillRouterSolutionRequest('retrievalSolutionEnable', 'ignored');
assert.equal(calls.at(-1).command, 'retrievalSolutionImport', 'pending mutations cannot be replayed');
context.skillRouterSolutionRequest('retrievalSolutions');
context.skillRouterSolutionsOnSnapshot({ state: 'idle', actionCompleted: false });
assert.match(context.skillRouterSolutionsHtml(), /Applying model configuration/);
context.skillRouterSolutionsOnSnapshot({ actionCompleted: true, operationId: 'another-panel' });
assert.match(context.skillRouterSolutionsHtml(), /Applying model configuration/);
[...timers.values()][0]();
assert.match(context.skillRouterSolutionsHtml(), /does not cancel or retry/);
context.skillRouterSolutionsOnSnapshot({ state: 'idle', packages: [], actionCompleted: true, operationId });
assert.doesNotMatch(context.skillRouterSolutionsHtml(), /Applying model configuration/);
assert.equal(timers.size, 0, 'only the matching action completion clears the timeout, including native picker cancellation');
console.log('Router UI: source priority, truthful serving, correlated operations and responsive containment OK');
