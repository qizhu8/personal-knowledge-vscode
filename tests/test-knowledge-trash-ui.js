#!/usr/bin/env node
const assert = require("assert");
const fs = require("fs");
const path = require("path");

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
assert.match(panel, /Move Note to Trash/);
assert.match(extension, /case "knowledgeTrashMove"/);
assert.match(extension, /case "knowledgeTrashRestore"/);
assert.match(extension, /case "knowledgeTrashDelete"/);
assert.match(extension, /case "knowledgeTrashEmpty"/);
assert.match(extension, /new PkTreeItem\("Trash", "knowledge-trash"/);
assert.match(extension, /case 'knowledge-trash': return this\._knowledgeTrashItems/);
for (const command of ["personalKnowledge.trashKnowledgeItem", "personalKnowledge.restoreKnowledgeTrash", "personalKnowledge.deleteKnowledgeTrashEntry", "personalKnowledge.emptyKnowledgeTrash"]) {
  assert(manifest.contributes.commands.some(item => item.command === command), `missing ${command}`);
}

console.log("Knowledge Trash UI test: shared dock and Navigation workflows cover Notes, Papers, Prompts, and Scripts OK");
