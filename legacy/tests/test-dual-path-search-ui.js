const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const bundle = fs.readFileSync(require('node:path').join(__dirname, '../dist/webview/panel.js'), 'utf8');
const script = bundle.slice(bundle.indexOf('// BR-13 search begin'), bundle.indexOf('// BR-13 search end'));
const knowledge = fs.readFileSync(require('node:path').join(__dirname, '../src/webview/panel/20-knowledge.js'), 'utf8');
const treeSource = knowledge.slice(knowledge.indexOf('function buildCatTree('), knowledge.indexOf('function openCatFolderAddMenu('));
assert(script.includes('requestKnowledgeSearch'), 'built panel must contain the search controller');
const nodes = new Map();
function element() {
  return { style: {}, hidden: false, value: 'filter', textContent: '', innerHTML: '',
    setAttribute() {}, after() {}, before() {}, addEventListener() {}, querySelectorAll() { return []; } };
}
const messages = [];
const listeners = {};
const context = vm.createContext({
  document: { createElement: element, getElementById(id) { if (!nodes.has(id)) nodes.set(id, element()); return nodes.get(id); }, querySelectorAll() { return []; } },
  window: { addEventListener(type, handler) { listeners[type] = handler; } },
  state: { tab: 'notes', search: 'network' },
  ask(command, payload) { messages.push({ command, ...payload }); },
  esc: value => String(value).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;'),
  contentSearchChanged() {}, requestDetail() {},
  catExpanded: {}, privacyInherited: () => false, privacyDivider: () => '',
  folkDisplayName: value => value, privacyLock: () => '', brokerFolderMarker: () => '',
  uiIcon: () => '', githubSyncTypes: [], githubSyncFolderMarker: () => '',
  btoa: value => Buffer.from(value, 'binary').toString('base64'), unescape, encodeURIComponent,
});
vm.runInContext(treeSource, context);
vm.runInContext(script, context);
assert.equal(vm.runInContext('requestKnowledgeSearch({regex:false,caseSensitive:false})', context), false,
  'default Ctrl+F must use the existing filtered file tree, not ranked retrieval');
assert.equal(messages.length, 0);
assert.equal(nodes.get('item-list').hidden, false);
vm.runInContext('knowledgeSearchMode.value = "lexical"', context);
assert.equal(vm.runInContext('requestKnowledgeSearch({regex:false,caseSensitive:false})', context), true);
assert.equal(messages[0].mode, 'lexical');
assert.equal(nodes.get('item-list').hidden, true);
for (const status of ['off', 'ready', 'fallback', 'unavailable']) {
  context.result = { ok: true, search_mode: 'dual', semantic_status: status, semantic_reason: '<provider error>', hits: [
    { title: '<unsafe title>', source_label: 'both', path_evidence: [
      { path: 'lexical', rank: 1, score: 25, match: 'keyword', matched_field: 'title', matched_path: 'pkm://notes/a' },
      { path: 'semantic', rank: 2, score: .02, match: 'semantic', matched_field: 'embedding-index', matched_path: 'pkm://notes/a' },
    ] }, { title: 'keyword', source_label: 'from keyword search' }, { title: 'related', source_label: 'from embedding retrieval' },
  ] };
  const html = vm.runInContext('knowledgeSearchMarkup(result)', context);
  assert(html.includes(`Semantic: ${status}`));
  for (const text of ['Mode: dual', 'both · keyword search + embedding retrieval', 'from keyword search', 'from embedding retrieval', 'lexical: rank 1, raw score 25', 'semantic: rank 2, raw score 0.02']) assert(html.includes(text), text);
  assert(!html.includes('<unsafe title>'));
  assert(html.includes('&lt;provider error&gt;'));
}
context.result = { ok: true, search_mode: 'semantic', semantic_status: 'off', hits: [] };
assert(vm.runInContext('knowledgeSearchMarkup(result)', context).includes('No matching sources'));
vm.runInContext('requestKnowledgeSearch({regex:true,caseSensitive:false})', context);
assert.equal(nodes.get('item-list').hidden, false, 'existing regex search remains available');
console.log('BR-13 UI: built modes, source labels, per-path evidence, all semantic statuses and escaping OK');
