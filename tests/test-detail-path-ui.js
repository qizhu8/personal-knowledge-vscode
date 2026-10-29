#!/usr/bin/env node
const assert = require("assert");
const fs = require("fs");
const path = require("path");
const vm = require("vm");
const { test } = require("node:test");
const ts = require("typescript");

const root = path.join(__dirname, "..");
const panel = fs.readFileSync(path.join(root, "dist", "webview", "panel.js"), "utf8");
const canonicalStart = panel.indexOf("function canonicalPkmPath(path)");
const canonicalEnd = panel.indexOf("function copyContextPath(path)", canonicalStart);
const start = panel.indexOf("function detailContentPath(data)");
const end = panel.indexOf("function renderDetail(data)", start);
assert(canonicalStart >= 0 && canonicalEnd > canonicalStart && start >= 0 && end > start, "detail path helpers must be bundled");
const copied = [];
const context = { esc: value => String(value), vscode:{ postMessage:message => copied.push(message) } };
vm.createContext(context);
new vm.Script(`${panel.slice(canonicalStart, canonicalEnd)};${panel.slice(start, end)}; this.pathFor=detailContentPath; this.pathHtml=detailPathHtml;`).runInContext(context);
new vm.Script(panel.slice(canonicalEnd, panel.indexOf("function copyPathMenu(", canonicalEnd))).runInContext(context);

const cases = [
  [{ type: "skill", name: "Testing", category: "Wrong Parent", _key: "Coding/Python/Testing" }, "pkm://skills/Coding/Python/Testing.md"],
  [{ type: "note", slug: "Research/RAG/Index" }, "pkm://notes/Research/RAG/Index.md"],
  [{ type: "paper", slug: "Generative Retrieval/DSI" }, "pkm://papers/Generative%20Retrieval/DSI.md"],
  [{ type: "prompt", project: "Ads", task: "Review", version: "v3", file: "prompt.md" }, "pkm://prompts/Ads/Review/v3/prompt.md"],
  [{ type: "script", path: "Scope/Quality Checks/query.script", file: "query.script" }, "pkm://scripts/Scope/Quality%20Checks/query.script"],
  [{ type: "script", pkmPath: "packages/demo/src/index.ts", file: "src/index.ts" }, "pkm://packages/demo/src/index.ts"],
];
for (const [data, expected] of cases) {
  assert.strictEqual(context.pathFor(data), expected);
  assert.match(context.pathHtml(data), new RegExp(expected.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  context.currentDetail = data;
  context.copyDetailUrl();
  assert.strictEqual(copied.at(-1).command, "copyText");
  assert.strictEqual(copied.at(-1).text, expected, "Detail Copy URL uses the displayed PKM identity");
}
context.currentDetail = null;
const beforeEmpty = copied.length;
context.copyDetailUrl();
assert.strictEqual(copied.length, beforeEmpty);

for (const marker of [
  /d-title[^\n]+data\.name[\s\S]{0,180}detailPathHtml\(data\)[\s\S]{0,80}<div class="d-meta">/,
  /d-title[^\n]+data\.title[\s\S]{0,180}detailPathHtml\(data\)[\s\S]{0,80}<div class="d-meta">/,
  /d-title[^\n]+data\.file[\s\S]{0,100}detailPathHtml\(data\)[\s\S]{0,80}<div class="d-meta">/,
  /d-title[^\n]+d\.title[\s\S]{0,180}detailPathHtml\(d\)[\s\S]{0,80}<div class="d-meta">/,
]) assert.match(panel, marker);
const promptHeader = panel.indexOf('class="prompt-workbench-head"');
const promptTitle = panel.indexOf("meta?.title || task", promptHeader);
const promptPath = panel.indexOf("detailPathHtml(data)", promptTitle);
assert(promptHeader >= 0 && promptTitle > promptHeader && promptPath > promptTitle,
  "Prompt workbench must keep its title before the full PKM path");
assert.doesNotMatch(panel, /id: \$\{esc\(data\.slug\)\}/, "Note slug must not be duplicated in metadata after the path row");
assert.match(fs.readFileSync(path.join(root, "src", "webview", "panel.css"), "utf8"), /\.d-path\{[^}]*user-select:text/);

console.log("detail path UI test: full file paths and title/path/metadata ordering aligned across five content types OK");

test("legacy content-copy messages also copy PKM identities without publishing private content or starting a gateway", async () => {
  const extension = fs.readFileSync(path.join(root, "src", "extension.ts"), "utf8");
  const first = extension.indexOf('case "copyPublicContentLink": {');
  const last = extension.indexOf('case "writeLinkedExport":', first);
  assert(first >= 0 && last > first);
  const section = extension.slice(first, last);
  assert.doesNotMatch(section, /ensurePublicContentGateway|stablePublicContentUrl|isContentPathPrivate/);
  const values = [];
  const host = { navigationItemPath:require("../dist/ui/navigation-path").navigationItemPath,
    vscode:{ env:{ clipboard:{ writeText:async value => values.push(value) } }, window:{ setStatusBarMessage() {} } } };
  vm.createContext(host);
  vm.runInContext(ts.transpile(`async function copy(msg) { switch(msg.command) { ${section} } }`), host);
  for (const [kind, key, expected] of [
    ["script", "Scope/Quality Checks/query.script", "pkm://scripts/Scope/Quality%20Checks/query.script"],
    ["skill", "Coding/Python/Testing", "pkm://skills/Coding/Python/Testing.md"],
    ["note", "Private/Research Note", "pkm://notes/Private/Research%20Note.md"],
    ["paper", "Research/DSI", "pkm://papers/Research/DSI.md"],
  ]) {
    await host.copy({ command:"copyPublicContentLink", kind, key });
    assert.strictEqual(values.at(-1), expected);
  }
});
