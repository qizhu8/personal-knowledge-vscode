#!/usr/bin/env node
/* Post-build step for the webview:
 *  1. Remove the blocking highlight.js CDN <script> (CSS kept for styling).
 *  2. Syntax-check the main inline <script> so a stray edit can never ship a
 *     broken webview (a single syntax error kills ALL webview JS silently).
 */
const fs = require("fs");
const vm = require("vm");
const path = require("path");

const htmlPath = path.join(__dirname, "..", "dist", "webview", "panel.html");
let html = fs.readFileSync(htmlPath, "utf-8");

// 1. Strip blocking hljs CDN script tag
html = html.replace(
  /<script src="https:\/\/cdnjs\.cloudflare\.com\/[^"]*highlight[^"]*"><\/script>/,
  ""
);
fs.writeFileSync(htmlPath, html);

// 2. Extract and syntax-check the main inline script
const scripts = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)];
if (scripts.length === 0) {
  console.error("post-build: no inline <script> found in panel.html");
  process.exit(1);
}
const inline = scripts[scripts.length - 1][1]; // the big app script (last inline block)
try {
  new vm.Script(inline, { filename: "panel.html:inline" });
  console.log("post-build: hljs CDN removed, inline script syntax OK");
} catch (e) {
  console.error("post-build: INLINE SCRIPT SYNTAX ERROR —", e.message);
  process.exit(1);
}

// 3. Syntax-check the chat browser-view HTML (generated at runtime in chatroom.ts,
//    so it never reaches panel.html's check — a stray edit there kills the page).
try {
  const { browserViewHtml } = require(path.join(__dirname, "..", "dist", "chatroom.js"));
  const bv = browserViewHtml();
  const bvScripts = [...bv.matchAll(/<script>([\s\S]*?)<\/script>/g)];
  for (const s of bvScripts) new vm.Script(s[1], { filename: "browser-view:inline" });
  console.log("post-build: browser-view script syntax OK");
} catch (e) {
  console.error("post-build: BROWSER-VIEW SCRIPT SYNTAX ERROR —", e.message);
  process.exit(1);
}

