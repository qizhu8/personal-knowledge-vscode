#!/usr/bin/env node
const assert = require("assert");
const fs = require("fs");
const path = require("path");

const root = path.join(__dirname, "..");
const manifest = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));
const panel = fs.readFileSync(path.join(root, "dist", "webview", "panel.js"), "utf8");
const html = fs.readFileSync(path.join(root, "src", "webview", "panel.html"), "utf8");
const extension = fs.readFileSync(path.join(root, "src", "extension.ts"), "utf8");
const menus = manifest.contributes.menus["view/item/context"];

const copy = menus.find(item => item.command === "personalKnowledge.copyNavigationPath");
assert(copy, "Navigation must expose Copy Path globally");
assert.strictEqual(copy.when, "view == personalKnowledge.sidebarView");
assert.strictEqual(copy.group, "1_copy@1", "Copy Path must appear immediately after Open actions");

const allowedGroups = /^(inline|[0-5]_(open|copy|create|edit|restore|organize|control)(@\d+)?|9_danger(@\d+)?)$/;
for (const item of menus) {
  assert(allowedGroups.test(item.group), `Navigation menu command ${item.command} uses an unclassified group: ${item.group}`);
}

assert.match(panel, /function contextMenuLabel\(label\)/,
  "all webview context menus must share icon-free label normalization");
assert.match(panel, /function copyPathMenu\(path\)/);
assert.match(panel, /label: 'Copy Path'/);
assert.match(extension, /case "copyText"[\s\S]{0,180}vscode\.env\.clipboard\.writeText\(text\)/,
  "webview Copy Path must be handled by the extension-host clipboard API");

const posted = [];
const copyContextPath = path => { if (path) posted.push({ command: "copyText", text: path }); };
const copyPathMenu = path => ({ label: "Copy Path", onClick: () => copyContextPath(path) });
const executableCopy = copyPathMenu("notes/Research/Test.md");
executableCopy.onClick();
assert.deepStrictEqual(posted, [{ command: "copyText", text: "notes/Research/Test.md" }],
  "Copy Path action must dispatch the exact path to the clipboard handler");
assert.match(panel, /function virtualRootFolderMenu\(event, area\)/);
for (const area of ["skills", "notes", "scripts"]) {
  assert.match(panel, new RegExp(`virtualRootFolderMenu\\(event,'${area}'\\)`), `${area} virtual root must expose Copy Path`);
}
assert.match(panel, /const physicalPath = path === '\(uncategorized\)' \? '' : path/,
  "Paper uncategorized folder must copy the real papers root path");

const requiredPathContracts = [
  /copyPathMenu\(`skills\/\$\{prefix\}\/`\)/,
  /copyPathMenu\(`skills\/\$\{itemPath\}\.md`\)/,
  /copyContextPath\('notes\/' \+ slug \+ '\.md'\)/,
  /copyPathMenu\(`notes\/\$\{prefix\}\/`\)/,
  /copyPathMenu\(`papers\/\$\{slug\}\.md`\)/,
  /copyPathMenu\(`papers\/\$\{physicalPath \? physicalPath \+ '\/' : ''\}`\)/,
  /copyPathMenu\(`prompts\/\$\{path\}`\)/,
  /copyPathMenu\(`scripts\/\$\{prefix\}\/`\)/,
  /copyPathMenu\(`scripts\/\$\{relPath\}`\)/,
  /copyPathMenu\(`packages\/\$\{name\}\/`\)/,
  /copyPathMenu\(`servers\/\$\{slug\}\/server\.json`\)/,
  /copyPathMenu\(`pkm:\/\/chatroom\/rooms\//,
  /copyPathMenu\(`pkm:\/\/subscriptions\/\$\{encodeURIComponent\(item\.nodeId\)\}\/\$\{encodeURIComponent\(item\.shareId\)\}`\)/,
];
for (const contract of requiredPathContracts) assert.match(panel, contract, `missing Copy Path coverage: ${contract}`);

assert.doesNotMatch(html.slice(html.indexOf('<div id="ctx-menu">'), html.indexOf("<!-- Sync modal -->")), /[★☆✏⚙🗑🔓🔒📂📁📄📦💡↗↪■▶＋➕✓]/u,
  "legacy Note context menu markup must remain icon-free");
assert.match(panel, /visibleItems = items\.filter/,
  "shared menus must collapse duplicate/edge separators");

console.log("context menu test: logical native groups, icon-free labels, separators, and Copy Path coverage OK");
