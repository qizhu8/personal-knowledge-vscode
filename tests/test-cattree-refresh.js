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
  esc: value => String(value),
  hl: value => String(value),
  privacyLock: () => '',
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
  const key = context.expandedCategoryKey(segments.slice(0, depth));
  assert.strictEqual(context.catExpanded[key], true, `ancestor ${segments.slice(0, depth).join('/')} must be expanded`);
}

assert.strictEqual(context.revealRefreshedTreeItems('skills', [], [], { changedPath: `notes/${category}/progress.md.md` }), false, 'another tab must not consume a pending note path');

context.catExpanded = {};
context.revealRefreshedTreeItems('notes', [{ ...note, updated_at: 'old' }], [note], { manual: true });
assert.strictEqual(context.catExpanded[context.expandedCategoryKey(segments)], true, 'manual refresh must reveal an updated note');

const extension = fs.readFileSync(path.join(root, 'src/extension.ts'), 'utf8');
const core = fs.readFileSync(path.join(root, 'src/webview/panel/00-core.js'), 'utf8');
assert.match(extension, /changedPath = path\.relative\(getStorePath\(\), uri\.fsPath\)/);
assert.match(core, /pendingTreeRefresh = data \|\| \{\}/);
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