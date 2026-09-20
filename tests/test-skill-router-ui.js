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

assert.match(panelHtml, /data-tab="skillRouter">Skill Router</);
assert.match(panelJs, /state\.tab === 'skillRouter'[\s\S]{0,300}ask\('skillRouterStatus'/);
assert.match(panelJs, /command === 'skillRouterStatus'/);
assert.match(extensionTs, /case "skillRouterStatus"/);
assert.match(extensionTs, /activeProfile = enabledSolutions\.includes\("l1_online"\) \? "l1_online" : "copilot_default"/,
  'the active path must resolve from enabled mature solutions with automatic Copilot fallback');
assert.match(extensionTs, /case "setSkillRouterSolutionEnabled"/);
assert.match(extensionTs, /enabled\.add\("copilot_default"\)/,
  'every route update must preserve the automatic fallback');
assert.match(extensionTs, /Copilot default is the required automatic fallback and cannot be disabled yet/);
assert.doesNotMatch(extensionTs, /setSkillRouterProfile/,
  'an unimplemented path must not expose a persistence command');

const start = panelJs.indexOf('const skillRouterBenchmarks');
const end = panelJs.indexOf('// ── Init', start);
assert(start >= 0 && end > start, 'Skill Router renderer must be included before panel initialization');
const detail = { innerHTML: '' };
const calls = [];
const context = {
  console,
  esc: value => String(value ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'),
  ask: (command, data) => calls.push({ command, data }),
  document: {
    getElementById: id => id === 'detail' ? detail : null,
    querySelectorAll: () => [],
  },
};
vm.createContext(context);
new vm.Script(`${panelJs.slice(start, end)}; this.renderSkillRouterPane = renderSkillRouterPane; this.toggleSolution = skillRouterToggleSolution;`).runInContext(context);
context.renderSkillRouterPane({
  activeProfile: 'l1_online',
  enabledSolutions: ['copilot_default', 'l1_online'],
  solutions: {
    copilot_default: { available: true, mature: true, enabled: true, externallyServed: true },
    l1_exact: { available: false, mature: false, enabled: false },
    l1_online: { available: true, mature: true, enabled: true },
    l1_weighted: { available: false, mature: false, enabled: false, systemDisabled: true },
  },
  modelBasedRoutingEnabled: false,
  collector: {
    collectedTools: ['pkm.skill_context', 'pkm.search_knowledge', 'pkm.search_notes'],
    unavailableTools: ['vscode.tool_search', 'vscode.grep_search'],
    queryTextCollected: false,
  },
  corpus: { documentCount: 523, revision: 'abcdef1234567890' },
  runtime: { ready: true, documentCount: 523, corpusRevision: 'abcdef1234567890', engineVersion: '0.3.0', configurationHash: '1234567890abcdef' },
});
for (const text of ['Copilot default search', 'Exact only', 'Exact + BM25', 'Hybrid', 'Success rate', 'NDCG@5', 'Recall@1', 'Recall@5', 'Tokens saved', 'Latency']) {
  assert(detail.innerHTML.includes(text), `missing Skill Router performance content: ${text}`);
}
for (const text of ['Embedding', 'Retrieval', 'Calibration', 'Ranker', 'Results']) {
  assert(detail.innerHTML.includes(text), `missing parameter component: ${text}`);
}
assert.match(detail.innerHTML, /Automatic fallback: Exact \+ BM25 → Copilot default/);
assert.match(detail.innerHTML, /Hybrid[\s\S]*System disabled/);
assert.match(detail.innerHTML, /No benchmark has been imported/);
assert.match(detail.innerHTML, /Copilot default search[\s\S]*Required fallback/);
assert.match(detail.innerHTML, /Exact \+ BM25[\s\S]*Serving/);
assert.match(detail.innerHTML, /Proposed Parameter Map/);
assert.match(detail.innerHTML, /Skill Router privacy statement/);
assert.match(detail.innerHTML, /Raw query and task text, workspace paths, file names, diagnostics, and loaded knowledge content are excluded/);
assert.match(detail.innerHTML, /tool name, duration, success state, result count, hashed result identities, and active routes/);
assert.match(detail.innerHTML, /_feedback\/skill-usage\.jsonl/);
assert.match(detail.innerHTML, /does not train or modify embedding-model weights/);
assert.match(detail.innerHTML, /github\.com\/qizhu8\/personal-knowledge-vscode/);
assert(detail.innerHTML.indexOf('Proposed Parameter Map') < detail.innerHTML.indexOf('Skill Router privacy statement'),
  'privacy statement must appear below the parameter map');
assert(detail.innerHTML.indexOf('Skill Router privacy statement') < detail.innerHTML.indexOf('<h3>Runtime</h3>'),
  'privacy statement must appear before runtime details');
assert.match(detail.innerHTML, /Search data collector/);
assert.match(detail.innerHTML, /pkm\.skill_context · pkm\.search_knowledge · pkm\.search_notes/);
assert.match(detail.innerHTML, /tool_search and grep_search do not expose invocation events/);
assert.doesNotMatch(detail.innerHTML, /type="radio"|Choose target|Preferred target/);
assert.doesNotMatch(detail.innerHTML, /(^|[^a-z0-9])l2([^a-z0-9]|$)/i);
context.toggleSolution('l1_online', false);
assert.strictEqual(JSON.stringify(calls), JSON.stringify([{ command: 'setSkillRouterSolutionEnabled', data: { solution: 'l1_online', enabled: false } }]));
assert.match(panelCss, /\.sr-table-wrap\{max-width:100%;overflow-x:auto\}/);
assert.match(panelCss, /\.sr-parameter-map\{[^}]*overflow-x:auto/);

console.log('Skill Router UI: tab, truthful serving state, empty benchmark metrics, proposed parameters, and responsive containment OK');
