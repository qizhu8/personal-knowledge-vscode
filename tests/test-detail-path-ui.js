#!/usr/bin/env node
const assert = require("assert");
const fs = require("fs");
const path = require("path");
const vm = require("vm");

const root = path.join(__dirname, "..");
const panel = fs.readFileSync(path.join(root, "dist", "webview", "panel.js"), "utf8");
const start = panel.indexOf("function detailContentPath(data)");
const end = panel.indexOf("function renderDetail(data)", start);
assert(start >= 0 && end > start, "detail path helpers must be bundled");
const context = { esc: value => String(value) };
vm.createContext(context);
new vm.Script(`${panel.slice(start, end)}; this.pathFor=detailContentPath; this.pathHtml=detailPathHtml;`).runInContext(context);

const cases = [
  [{ type: "skill", name: "Testing", category: "Wrong Parent", _key: "Coding/Python/Testing" }, "skills/Coding/Python/Testing.md"],
  [{ type: "note", slug: "Research/RAG/Index" }, "notes/Research/RAG/Index.md"],
  [{ type: "paper", slug: "Generative Retrieval/DSI" }, "papers/Generative Retrieval/DSI.md"],
  [{ type: "prompt", project: "Ads", task: "Review", version: "v3", file: "prompt.md" }, "prompts/Ads/Review/v3/prompt.md"],
  [{ type: "script", path: "Scope/Checks/query.script", file: "query.script" }, "scripts/Scope/Checks/query.script"],
  [{ type: "script", pkmPath: "packages/demo/src/index.ts", file: "src/index.ts" }, "packages/demo/src/index.ts"],
];
for (const [data, expected] of cases) {
  assert.strictEqual(context.pathFor(data), expected);
  assert.match(context.pathHtml(data), new RegExp(expected.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
}

for (const marker of [
  /d-title[^\n]+data\.name[\s\S]{0,180}detailPathHtml\(data\)[\s\S]{0,80}<div class="d-meta">/,
  /d-title[^\n]+data\.title[\s\S]{0,180}detailPathHtml\(data\)[\s\S]{0,80}<div class="d-meta">/,
  /d-title[^\n]+project[\s\S]{0,120}detailPathHtml\(data\)[\s\S]{0,80}<div class="d-meta">/,
  /d-title[^\n]+data\.file[\s\S]{0,100}detailPathHtml\(data\)[\s\S]{0,80}<div class="d-meta">/,
  /d-title[^\n]+d\.title[\s\S]{0,180}detailPathHtml\(d\)[\s\S]{0,80}<div class="d-meta">/,
]) assert.match(panel, marker);
assert.doesNotMatch(panel, /id: \$\{esc\(data\.slug\)\}/, "Note slug must not be duplicated in metadata after the path row");
assert.match(fs.readFileSync(path.join(root, "src", "webview", "panel.css"), "utf8"), /\.d-path\{[^}]*user-select:text/);

console.log("detail path UI test: full file paths and title/path/metadata ordering aligned across five content types OK");
