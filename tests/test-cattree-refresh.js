#!/usr/bin/env node
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const os = require('os');
const childProcess = require('child_process');

const root = path.join(__dirname, '..');
const knowledge = fs.readFileSync(path.join(root, 'src/webview/panel/20-knowledge.js'), 'utf8');
const start = knowledge.indexOf('function expandedCategoryKey');
const end = knowledge.indexOf('\nfunction renderCatTree', start);
assert(start >= 0 && end > start, 'category refresh helpers must be present');

const context = { catExpanded: {}, btoa: value => Buffer.from(value, 'binary').toString('base64'), unescape, encodeURIComponent };
vm.createContext(context);
vm.runInContext(knowledge.slice(start, end), context);

const noteRenderStart = knowledge.indexOf('function noteFilename');
const noteRenderEnd = knowledge.indexOf('\nfunction toggleNotePin', noteRenderStart);
const renderContext = {
  ICON: { general: 'N' },
  uiIcon: name => `<span class="codicon codicon-${name}"></span>`,
  esc: value => String(value),
  hl: value => String(value),
  privacyLock: () => '',
  brokerShareMarker: () => '',
};
vm.createContext(renderContext);
vm.runInContext(knowledge.slice(noteRenderStart, noteRenderEnd), renderContext);
const renderedNote = renderContext.noteLi({
  slug: 'Project/AAGL_Improvement/Module Optimizer/LP Processor/progress.md',
  title: 'LPFeatureProcessor v1.1 Optimization Progress',
  type: 'general',
  updated_at: '2026-09-17T02:16:01Z',
}, '', 8);
assert.match(renderedNote, /LPFeatureProcessor v1\.1 Optimization Progress/);
assert.match(renderedNote, /progress\.md\.md · 2026-09-17/);
assert.match(renderedNote, /title="notes\/Project\/AAGL_Improvement\/Module Optimizer\/LP Processor\/progress\.md\.md"/);

const category = 'Project/AAGL_Improvement/Module Optimizer/LP Processor';
const note = { slug: `${category}/progress.md`, category, updated_at: '2026-09-17T01:09:06Z' };
context.revealRefreshedTreeItems('notes', [], [note], { changedPath: `notes/${category}/progress.md.md` });

const segments = category.split('/');
for (let depth = 1; depth <= segments.length; depth++) {
  const key = context.expandedCategoryKey(segments.slice(0, depth), 'notes');
  assert.strictEqual(context.catExpanded[key], true, `ancestor ${segments.slice(0, depth).join('/')} must be expanded`);
}

assert.strictEqual(context.revealRefreshedTreeItems('skills', [], [], { changedPath: `notes/${category}/progress.md.md` }), false, 'another tab must not consume a pending note path');

context.catExpanded = {};
context.revealRefreshedTreeItems('notes', [{ ...note, updated_at: 'old' }], [note], { changedPath: `notes/${category}/progress.md.md` });
assert.strictEqual(context.catExpanded[context.expandedCategoryKey(segments, 'notes')], undefined, 'editing an existing note must not expand its category');

context.revealRefreshedTreeItems('notes', [{ ...note, updated_at: 'old' }], [note], { manual: true });
assert.strictEqual(context.catExpanded[context.expandedCategoryKey(segments, 'notes')], true, 'manual refresh must reveal one updated note');

context.catExpanded = {};
const skills = [
  { name: 'changed-skill', category: 'Coding/Changed', updated_at: 'new' },
  { name: 'unrelated-skill', category: 'Research/Unrelated', updated_at: 'new' },
];
context.revealRefreshedTreeItems('skills', [], skills, { changedPath: 'skills/Coding/Changed/changed-skill.md' });
assert.strictEqual(context.catExpanded[context.expandedCategoryKey(['Coding', 'Changed'], 'skills')], true, 'the changed Skill category must be revealed');
assert.strictEqual(context.catExpanded[context.expandedCategoryKey(['Research', 'Unrelated'], 'skills')], undefined, 'an initial or cross-tab list must not expand unrelated Skill categories');
const catTreeAreas = ['skills', 'notes', 'papers', 'scripts', 'environments'];
const sharedPathKeys = catTreeAreas.map(area => context.expandedCategoryKey(['Shared'], area));
assert.strictEqual(new Set(sharedPathKeys).size, catTreeAreas.length, 'all shared CatTree areas must have isolated expansion state');

const treeStart = knowledge.indexOf('function buildCatTree');
const treeEnd = knowledge.indexOf('\nfunction openCatFolderAddMenu', treeStart);
assert(treeStart >= 0 && treeEnd > treeStart, 'CatTree helpers must be present');
const treeContext = {
  state: { tab: 'notes' }, catExpanded: {}, notePinnedFolders: [],
  btoa: value => Buffer.from(value, 'binary').toString('base64'), unescape, encodeURIComponent,
  privacyInherited: () => false, privacyDivider: () => '', privacyLock: () => '',
  brokerFolderMarker: () => '', uiIcon: () => '', folkDisplayName: value => value,
  esc: value => String(value),
};
vm.createContext(treeContext);
vm.runInContext(knowledge.slice(treeStart, treeEnd), treeContext);
const emptyFolderTree = treeContext.buildCatTree([], item => item.category, '(uncategorized)');
treeContext.seedFolders(emptyFolderTree, ['Research/Future Work', 'Project/Unrelated']);
const matchedEmptyFolder = treeContext.renderCatTree(emptyFolderTree, [], 0, () => '', 'future work');
assert.match(matchedEmptyFolder, /Future Work/, 'search must return an empty folder whose path matches');
assert.doesNotMatch(matchedEmptyFolder, /Unrelated/, 'search must still hide unrelated empty folders');
assert.doesNotMatch(matchedEmptyFolder, /tree-cat-body" style="display:none"/, 'search must expand the retained path so the empty folder is visible');

const markupStart = knowledge.indexOf("let knowledgeListMarkup =");
const markupEnd = knowledge.indexOf('\nfunction renderList', markupStart);
assert(markupStart >= 0 && markupEnd > markupStart, 'stable CatTree markup helper must be present');
const markupContext = { CSS: { escape: value => value } };
vm.createContext(markupContext);
vm.runInContext(knowledge.slice(markupStart, markupEnd), markupContext);
let markupWrites = 0;
const listElement = {
  _html: '', scrollTop: 0, scrollHeight: 100, clientHeight: 50,
  get innerHTML() { return this._html; },
  set innerHTML(value) { markupWrites++; this._html = value; },
  querySelector: () => null,
};
assert.strictEqual(markupContext.setKnowledgeListMarkup(listElement, 'notes', '<div>same</div>'), true);
listElement.scrollTop = 35;
assert.strictEqual(markupContext.setKnowledgeListMarkup(listElement, 'notes', '<div>same</div>'), false, 'identical markup must preserve the live DOM');
assert.strictEqual(markupWrites, 1, 'identical markup must not write innerHTML twice');
assert.strictEqual(listElement.scrollTop, 35, 'skipped render must preserve scroll position');
assert.strictEqual(markupContext.setKnowledgeListMarkup(listElement, 'notes', '<div>changed</div>'), true);
assert.strictEqual(listElement.scrollTop, 35, 'real rerender must restore scroll position');

const tabCacheStart = knowledge.indexOf('const cachedKnowledgeTabs =');
const tabCacheEnd = knowledge.indexOf('\nfunction paintWorkspaceNavigation', tabCacheStart);
assert(tabCacheStart >= 0 && tabCacheEnd > tabCacheStart, 'per-tab view cache helpers must be present');
class FakeContainer {
  constructor(children = []) { this.childNodes = []; children.forEach(child => this.appendChild(child)); }
  get firstChild() { return this.childNodes[0] || null; }
  appendChild(child) {
    if (child instanceof FakeContainer) {
      while (child.firstChild) this.appendChild(child.firstChild);
      return child;
    }
    if (child.parent) child.parent.childNodes.splice(child.parent.childNodes.indexOf(child), 1);
    child.parent = this;
    this.childNodes.push(child);
    return child;
  }
  replaceChildren(fragment) {
    this.childNodes.forEach(child => { child.parent = null; });
    this.childNodes = [];
    this.appendChild(fragment);
  }
}
const cachedNodes = Array.from({ length: 5000 }, (_, index) => ({ index, parent: null }));
const cacheElements = {
  'item-list': new FakeContainer(cachedNodes),
  'sidebar-filters': new FakeContainer([{ kind: 'filter', parent: null }]),
  'knowledge-trash-dock': new FakeContainer([{ kind: 'trash', parent: null }]),
};
const cachedItems = Array.from({ length: 5000 }, (_, index) => ({ slug: `note-${index}` }));
const tabCacheContext = {
  state: { filter: 'all', search: '', items: cachedItems, folders: ['Large'], subscriptionGroups: [], knowledgeTrash: [], privateTopLevels: [], brokerSharedFolders: {} },
  document: { createDocumentFragment: () => new FakeContainer(), getElementById: id => cacheElements[id] },
};
vm.createContext(tabCacheContext);
vm.runInContext(knowledge.slice(tabCacheStart, tabCacheEnd), tabCacheContext);
tabCacheContext.stashKnowledgeTabView('notes');
assert.strictEqual(cacheElements['item-list'].childNodes.length, 0, 'switching away must detach the mounted large tree');
assert.strictEqual(tabCacheContext.restoreKnowledgeTabView('notes'), true, 'a previously loaded tab must restore without requesting another list');
assert.strictEqual(cacheElements['item-list'].childNodes.length, 5000);
assert.strictEqual(cacheElements['item-list'].childNodes[3210], cachedNodes[3210], 'restoration must reuse the original DOM nodes instead of rebuilding markup');
assert.strictEqual(tabCacheContext.state.items, cachedItems, 'restoration must reuse the matching data snapshot');
tabCacheContext.invalidateKnowledgeTabView('notes');
assert.strictEqual(tabCacheContext.restoreKnowledgeTabView('notes'), false, 'an invalidated tab must require fresh data');

const extension = fs.readFileSync(path.join(root, 'src/extension.ts'), 'utf8');
const core = fs.readFileSync(path.join(root, 'src/webview/panel/00-core.js'), 'utf8');
assert.match(extension, /changedPath = path\.relative\(getStorePath\(\), uri\.fsPath\)/);
assert.match(core, /pendingTreeRefresh = data \|\| \{\}/);
assert.match(extension, /respond\(\{ command: "list", tab, data, folders/);
assert.match(core, /e\.data\.tab && e\.data\.tab !== state\.tab\) return/);
assert.match(knowledge, /search\.value = ''[\s\S]{0,80}state\.search = ''/);
assert.match(knowledge, /ask\('refreshKnowledgeFolder', \{ area: state\.tab, category \}\)/);
assert.match(extension, /case "refreshKnowledgeFolder"[\s\S]{0,1200}Folder scan timed out after 3 seconds/);
assert.match(extension, /target !== root && !target\.startsWith\(root \+ path\.sep\)/);

const fixtureRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'pkm-cattree-search-'));
const noteDir = path.join(fixtureRoot, 'notes', 'Project', 'AAGL_Improvement', 'Module Optimizer', 'LP Processor');
fs.mkdirSync(noteDir, { recursive: true });
const notePath = path.join(noteDir, 'progress.md.md');
fs.writeFileSync(notePath, '---\ntitle: "LPFeatureProcessor v1.1 Optimization Progress"\ntype: "general"\n---\nbody');
const compiled = path.join(fixtureRoot, 'compiled');
fs.mkdirSync(compiled, { recursive: true });
childProcess.execFileSync('npx', ['esbuild', path.join(root, 'src/filestore.ts'), '--bundle', '--platform=node', '--format=cjs', `--outfile=${path.join(compiled, 'filestore.js')}`], { cwd: root, stdio: 'ignore' });
const filestore = require(path.join(compiled, 'filestore.js'));
filestore.setStorePath(fixtureRoot);
const expectedSlug = 'Project/AAGL_Improvement/Module Optimizer/LP Processor/progress.md';
for (const query of ['progress.md.md', 'notes/Project/AAGL_Improvement/Module Optimizer/LP Processor/progress.md.md', notePath]) {
  assert.strictEqual(filestore.noteSearch(query)[0]?.slug, expectedSlug, `note search must match original path: ${query}`);
}
const firstMetadata = filestore.noteList(undefined, 10)[0];
assert.strictEqual(firstMetadata.content, undefined, 'tree metadata must not carry Note bodies');
fs.writeFileSync(notePath, '---\ntitle: "Updated Progress Title"\ntype: "general"\n---\nupdated body with a different size');
const updatedMetadata = filestore.noteList(undefined, 10)[0];
assert.strictEqual(updatedMetadata.title, 'Updated Progress Title', 'mtime/size changes must invalidate only the changed Note metadata');
fs.rmSync(fixtureRoot, { recursive: true, force: true });

console.log('Category tree refresh test: live folder scans and original double-extension path search OK');