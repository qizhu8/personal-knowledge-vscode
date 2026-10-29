#!/usr/bin/env node
const assert = require("assert");
const fs = require("fs");
const path = require("path");
const vm = require("vm");

const root = path.join(__dirname, "..");
const panel = fs.readFileSync(path.join(root, "dist/webview/panel.js"), "utf8");
const extension = fs.readFileSync(path.join(root, "src/extension.ts"), "utf8");
const manifest = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));

assert.match(panel, /\['skills','notes','papers','prompts','scripts'\]\.includes\(area\)/);
assert.match(panel, /knowledgeTrashRestore/);
assert.match(panel, /knowledgeTrashDelete/);
assert.match(panel, /knowledgeTrashEmpty/);
assert.match(panel, /moveKnowledgeFolderToTrash\('notes'/);
assert.match(panel, /moveKnowledgeFolderToTrash\('scripts'/);
assert.match(panel, /moveKnowledgeFolderToTrash\('prompts'/);
assert.match(panel, /moveKnowledgeItemToTrash\('prompts'/);
assert.match(panel, /moveKnowledgeItemToTrash\('scripts'/);
assert.match(panel, /Move this Paper to Trash/);
assert.match(panel, /Move All to Trash/);
assert.match(panel, /function confirmDeleteAllPapers\(\)/);
assert.match(panel, /ask\('deleteAllPapers'\)/);
assert.doesNotMatch(panel, /onclick="confirmDeleteAllPapers\(/, "Research must not expose a Move All to Trash action button");
assert.doesNotMatch(panel, /class="agent-session-quick-trash"/, "Archived Session trash actions belong to the context menu");
assert.match(panel, /function catTreeTrashDock\(/);
assert.match(panel, /Move Note to Trash/);
assert.match(extension, /case "knowledgeTrashMove"/);
const filestore = fs.readFileSync(path.join(root, "src/knowledge/filestore.ts"), "utf8");
assert.match(filestore, /return recordKnowledgeTrashDeletion\(area, entry, source\.full, move\)/,
  "both panel and Navigation Trash workflows must persist deletion intent for every supported knowledge area at the file mutation boundary");
assert.match(extension, /case "knowledgeTrashRestore"/);
assert.match(extension, /case "knowledgeTrashDelete"/);
assert.match(extension, /case "knowledgeTrashEmpty"/);
assert.match(extension, /if \(!result\.ok\) \{\s*vscode\.window\.showErrorMessage\(`Empty \$\{area\} Trash failed after deleting \$\{result\.count\} of \$\{count\} entries:/,
  "Navigation Empty Trash must surface partial or failed OneDrive deletion");
assert.match(extension, /case "deleteAllPapers"/);
assert.match(extension, /paperMoveAllToTrash\(\)/);
assert.match(extension, /new PkTreeItem\("Trash", "knowledge-trash"/);
assert.match(extension, /case 'knowledge-trash': return this\._knowledgeTrashItems/);
for (const command of ["personalKnowledge.trashKnowledgeItem", "personalKnowledge.restoreKnowledgeTrash", "personalKnowledge.deleteKnowledgeTrashEntry", "personalKnowledge.emptyKnowledgeTrash"]) {
  assert(manifest.contributes.commands.some(item => item.command === command), `missing ${command}`);
}

const knowledge = fs.readFileSync(path.join(root, "src/webview/panel/20-knowledge.js"), "utf8");
const start = knowledge.indexOf("function applyKnowledgeTrashResultToView(");
const end = knowledge.indexOf("function updateCachedKnowledgeTabSubscriptions", start);
let renders = 0;
const invalidated = [];
const context = {
  state: { tab:"notes", items:[{slug:"Projects/Old"},{slug:"Project/Old"},{slug:"ProjectsExtra/Other"}],
    folders:["Projects","Projects/Nested","Project","ProjectsExtra"], knowledgeTrash:[] },
  invalidateKnowledgeTabView: area => invalidated.push(area), renderList: () => renders++,
};
vm.createContext(context);
vm.runInContext(knowledge.slice(start, end), context);
context.applyKnowledgeTrashResultToView({ok:false,area:"notes",path:"Projects"});
assert.strictEqual(renders, 0, "a failed deletion must not clear the current view");
const entry = {id:"trash-folder",kind:"folder",originalPath:"Projects",name:"Projects"};
context.applyKnowledgeTrashResultToView({ok:true,action:"moved",area:"notes",path:"Projects",entry});
assert.deepStrictEqual(context.state.items.map(item => item.slug), ["Project/Old","ProjectsExtra/Other"]);
assert.deepStrictEqual(context.state.folders, ["Project","ProjectsExtra"]);
assert.strictEqual(context.state.knowledgeTrash[0], entry);
assert.strictEqual(renders, 1, "a successful result must render without waiting for a list round trip");
assert.deepStrictEqual(invalidated, ["notes"]);

const projects = fs.readFileSync(path.join(root, "src/webview/panel/15-projects.js"), "utf8");
const confirmations = [], deletes = [];
const trashContext = vm.createContext({
  esc:String, uiIcon:() => '', pkModal:modal => confirmations.push(modal),
  ask:(command,payload) => deletes.push({command,payload}),
  projectSnapshot:{recipeTrash:[{scope:'global'}],agentSessionTrash:[{sessionId:'fixture'}]},
});
vm.runInContext(projects.slice(projects.indexOf('function catTreeTrashDock('), projects.indexOf('function workspaceCatTreeToggle(')), trashContext);
vm.runInContext(projects.slice(projects.indexOf('function emptyAgentSessionTrash('), projects.indexOf('function catTreeTrashToggle(')), trashContext);
vm.runInContext(knowledge.slice(knowledge.indexOf('function emptyKnowledgeTrash('), knowledge.indexOf('function deleteKnowledgeTrashEntry(')), trashContext);
assert.match(trashContext.catTreeTrashDock('Trash',0,'',"emptyKnowledgeTrash('notes')"), /class="knowledge-trash-empty"[^>]*disabled>Delete All/);
assert.match(trashContext.catTreeTrashDock('Trash',3,'items',"emptyKnowledgeTrash('notes')"), /class="pk-group-count">3</);
for (const area of ['skills','notes','papers','prompts','scripts']) trashContext.emptyKnowledgeTrash(area);
trashContext.emptyRecipeTrash();
trashContext.emptyAgentSessionTrash();
assert.strictEqual(confirmations.length, 7, 'Every supported CatTree Trash uses confirmation');
assert.strictEqual(deletes.length, 0, 'Opening or cancelling confirmation must never delete content');
confirmations.forEach(modal => { assert.strictEqual(modal.okLabel,'Delete All'); assert.strictEqual(modal.danger,true); modal.onOk(); });
assert.strictEqual(deletes.length, 7);
assert.strictEqual(deletes[0].command,'skillTrashEmpty');
assert.strictEqual(deletes[5].command,'recipeTrash');
assert.strictEqual(deletes[6].command,'agentSessionTrash');

console.log("Knowledge Trash UI test: shared dock and Navigation workflows cover Notes, Papers, Prompts, and Scripts OK");
