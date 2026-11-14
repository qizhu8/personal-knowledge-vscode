#!/usr/bin/env node
const assert = require("assert");
const fs = require("fs");
const path = require("path");
const vm = require("vm");
const { marked } = require("marked");
const katex = require("katex");

const panelJs = fs.readFileSync(path.join(__dirname, "..", "dist", "webview", "panel.js"), "utf8");
const safeMarkedSource = panelJs.match(/let chatMarkdownRenderer;[\s\S]*?function chatSafeMarked\(text\)\s*\{[\s\S]*?\n\}/);
assert(safeMarkedSource, "Chatroom safe Markdown parser must be bundled");
const context = {
  marked,
  esc: value => String(value ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;"),
};
vm.createContext(context);
new vm.Script(`${safeMarkedSource[0]}; this.render = chatSafeMarked;`).runInContext(context);

const table = context.render("| Component | Status |\n|---|---|\n| GPU | Ready |");
assert.match(table, /<table>/);
assert.match(table, /<td>GPU<\/td>/);
const hostile = context.render("<script>globalThis.pwned=true</script><img src=x onerror=alert(1)>");
assert.doesNotMatch(hostile, /<script>|<img/);
assert.match(hostile, /&lt;script&gt;/);

const math = katex.renderToString("E=mc^2", { throwOnError: false, strict: false });
assert.match(math, /class="katex"/);
assert(panelJs.includes("chatSanitizeMarkdown(root)"));
assert(panelJs.includes("renderMermaid(root)"));
assert(panelJs.includes("code.language-mermaid"));
assert(panelJs.includes("chatHighlightMentionText(root)"));
assert(panelJs.includes("root.querySelectorAll('pre code:not(.language-mermaid)').forEach(safeHljs)"));

console.log("chat Markdown test: GFM table, raw-HTML escaping, KaTeX, Mermaid, highlighting, and mention integration OK");
