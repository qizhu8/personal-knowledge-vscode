#!/usr/bin/env node
const assert = require("assert");
const fs = require("fs");
const path = require("path");

const panel = fs.readFileSync(path.join(__dirname, "../src/webview/panel/20-knowledge.js"), "utf8");
const core = fs.readFileSync(path.join(__dirname, "../src/webview/panel/00-core.js"), "utf8");
const css = fs.readFileSync(path.join(__dirname, "../src/webview/panel.css"), "utf8");

assert(panel.includes("renderGroupedKnowledgeTree(root, 'skills'"), "Skills must use visual Groups");
assert(panel.includes("renderGroupedKnowledgeTree(root, 'notes'"), "Notes must use visual Groups");
assert(panel.includes("renderGroupedKnowledgeTree(root, 'papers'"), "Research must use visual Groups");
assert(panel.includes("Move top-level folder to Group"), "top-level folder context menus must support visual reassignment");
assert(panel.includes("No files or folders will be moved or deleted."), "Group deletion must disclose its non-destructive behavior");
assert(panel.includes("paperFolderRename"), "Research folders must expose rename/move parity");
assert(panel.includes("paperFolderDelete"), "Research folders must expose delete/promote parity");
assert(core.includes("state.knowledgeGroups = e.data.knowledgeGroups || null"), "list responses must update visual Group state");
assert(css.includes(".knowledge-visual-group"), "visual Groups must render their configured color");

console.log("knowledge groups UI test: shared CatTree groups, folder assignment, and Research parity OK");
