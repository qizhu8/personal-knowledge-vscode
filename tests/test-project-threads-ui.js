#!/usr/bin/env node
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const root = path.join(__dirname, '..');
const source = fs.readFileSync(path.join(root, 'src/webview/panel/15-projects.js'), 'utf8');
const css = fs.readFileSync(path.join(root, 'src/webview/panel.css'), 'utf8');
const start = source.indexOf('function projectSectionBody(');
const end = source.indexOf('\nfunction renderProjects()', start);
assert(start >= 0 && end > start);
const project = { projectId:'project_default' };
const threads = [
  { threadId:'general', name:'General', systemKind:'general-thread' },
  ...Array.from({ length:6 }, (_, index) => ({
    threadId:`thread_${index}`, name:index === 0 ? 'A long-running delivery discussion' : `Topic ${index}`,
    ...(index === 1 ? { archived:true } : {}),
    ...(index === 2 ? { chatroom:{ roomId:'abcdef0123456789' } } : {}),
  })),
];
const context = {
  projectRoute:{ section:'Overview' },
  projectSnapshot:{ projects:[project, { projectId:'other', name:'Other Project' }] },
  projectTodoExecutions:() => [],
  projectCollaborationBody:() => '',
  projectZero:() => '',
  esc:value => String(value).replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;'),
};
vm.createContext(context);
vm.runInContext(source.slice(start, end), context);

const overview = context.projectSectionBody(project, threads, []);
assert.match(overview, /View all 7/);
assert.strictEqual((overview.match(/project-thread-compact-main/g) || []).length, 5, 'Overview stays a preview');
assert.match(overview, /projectOpenThread\('general'\)/);
assert.doesNotMatch(overview, /projectOpenThread\('thread_5'\)/);
assert.match(overview, /Chatroom linked/);
assert.match(overview, /System thread/);

context.projectRoute.section = 'Threads';
const list = context.projectSectionBody(project, threads, []);
assert.strictEqual((list.match(/class="project-thread-row"/g) || []).length, 7);
assert.strictEqual((list.match(/class="project-thread-actions"/g) || []).length, 7);
assert.match(list, /projectOpenThread\('thread_5'\)/);
assert.match(list, /projectRenameThread\('thread_0'\)/);
assert.match(list, /projectMoveThread\('thread_0',this.value\)/);
assert.match(list, /System thread/);
assert.doesNotMatch(list, /projectRenameThread\('general'\)/);
assert.doesNotMatch(list, /projectMoveThread\('general'/);
const collaborationStart = source.indexOf('function projectCollaborationBody(');
const collaborationEnd = source.indexOf('\nfunction projectRenameThread(', collaborationStart);
vm.runInContext(source.slice(collaborationStart, collaborationEnd), context);
assert.match(context.projectCollaborationBody(project, threads), /<details class="project-band project-collaboration-create"><summary/);
assert.doesNotMatch(context.projectCollaborationBody(project, threads), /<details class="project-band project-collaboration-create" open/);
assert.match(css, /\.project-thread-actions\{[^}]*flex-wrap:wrap/);
assert.match(css, /@media\(max-width:720px\)\{[^\n]*\.project-thread-row\{align-items:flex-start;flex-direction:column/);
console.log('project Threads UI: bounded overview, grouped actions and narrow layout OK');