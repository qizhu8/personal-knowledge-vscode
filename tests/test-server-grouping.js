#!/usr/bin/env node
const assert = require("assert");
const fs = require("fs");
const path = require("path");
const vm = require("vm");

const root = path.join(__dirname, "..");
const panel = fs.readFileSync(path.join(root, "dist", "webview", "panel.js"), "utf8");
const extension = fs.readFileSync(path.join(root, "src", "extension.ts"), "utf8");
const start = panel.indexOf("function serverGroupTree(entries)");
const end = panel.indexOf("function renderServerDashboard(servers)", start);
assert(start >= 0 && end > start, "Server grouping helpers must be bundled");

const stored = new Map([["pkm-server-group-Research/Vision", "0"]]);
const context = {
  Map, Set, encodeURIComponent, decodeURIComponent,
  serverGroupPaths: ["Hidden"],
  localStorage: { getItem: key => stored.get(key) ?? null, setItem: (key, value) => stored.set(key, value) },
  esc: value => String(value),
};
vm.createContext(context);
new vm.Script(`${panel.slice(start, end)}; this.tree=serverGroupTree; this.render=renderServerGroupNode; this.count=serverGroupCount;`).runInContext(context);

const entries = [
  { server: { name: "Old", category: "Research/Vision", pinned: false }, html: "<article>old</article>" },
  { server: { name: "Pinned", category: "Research/Vision", pinned: true }, html: "<article>pinned</article>" },
  { server: { name: "Nested", category: "Research/Vision/Models", pinned: false }, html: "<article>nested</article>" },
  { server: { name: "Root", category: "", pinned: false }, html: "<article>root</article>" },
];
const tree = context.tree(entries);
assert.strictEqual(context.count(tree), 4);
const html = context.render(tree);
assert(html.indexOf("root") < html.indexOf("Research"), "ungrouped root servers remain directly visible");
assert(html.indexOf("pinned") < html.indexOf("old"), "starred servers sort first inside their group");
assert.match(html, /📁 Research/);
assert.match(html, /📁 Vision/);
assert.match(html, /📁 Models/);
assert.match(html, /🙈 Hidden/);
assert.match(html, /excluded from Navigation/);
assert.match(html, /srv-group-count">3</);
assert.match(html, /Research%2FVision/);
assert.doesNotMatch(html, /Research%2FVision'\)" open/, "stored collapsed groups must remain collapsed");

assert.match(panel, /class="srv-star \$\{s\.pinned \? 'active' : ''\}"/);
assert.match(panel, /id="se-category-/);
assert.match(panel, /id="se-tags-/);
assert.match(panel, /id="server-search"/);
assert.doesNotMatch(panel, /id="server-search" value=/);
assert.match(panel, /nextSearchInput\.value = serverSearchQuery/);
assert.match(panel, /if \(restoreSearchFocus\)/);
assert.match(panel, /function filterServerDashboard\(value\)/);
assert.match(panel, /\[s\.name, s\.slug, s\.category, \.\.\.\(s\.tags \|\| \[\]\), s\.command, s\.python \|\| 'python3', s\.status\]/);
assert.match(panel, /if \(serverSearchQuery && visible\) group\.open = true/);
assert.match(panel, /toggle\('srv-search-hidden', !!serverSearchQuery && !visible\)/);
assert.match(panel, /else if \(!serverSearchQuery\) group\.open = serverGroupOpen/);
assert.match(panel, /serverSetPinned/);
assert.match(panel, /class="srv-drag-handle" draggable="true"/);
assert.doesNotMatch(panel, /class="srv-card" draggable="true"/);
assert.match(panel, /function serverGroupDrop\(event, category\)/);
assert.match(panel, /function renameServerGroup\(path\)/);
assert.match(panel, /function deleteServerGroup\(path\)/);
assert.match(panel, /class="srv-root-drop"/);
assert.match(panel, /function createServerGroup\(\)/);
assert.match(panel, /class="tbtn srv-new-group"/);
assert.match(panel, /function serverCardMenu\(event, slug\)/);
assert.match(panel, /label: 'Move to group', children/);
assert.match(panel, /＋ New group…/);
assert.match(extension, /case "serverSetPinned"/);
assert.match(extension, /case "serverMoveGroup"/);
assert.match(extension, /case "serverCreateGroup"/);
assert.match(extension, /toLowerCase\(\) !== "hidden"/);
assert.match(fs.readFileSync(path.join(root, "src", "webview", "panel.css"), "utf8"), /\.srv-hidden-group>summary\{[^}]*opacity:1/);
assert.match(fs.readFileSync(path.join(root, "src", "webview", "panel.css"), "utf8"), /\.srv-new-group\{background:var\(--vscode-button-background/);
assert.doesNotMatch(/case "serverSetPinned": \{([\s\S]*?)\n    \}\n    case /.exec(extension)?.[1] || "", /restartServer|stopServer|startServer/);

console.log("server grouping test: nested collapsible groups, counts, persisted collapse, settings, and starred ordering OK");