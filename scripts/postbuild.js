#!/usr/bin/env node
/* Post-build validation for the extension and browser Chatroom webviews. */
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

// 2. Syntax-check the extracted panel application script.
try {
  const panelJsPath = path.join(__dirname, "..", "dist", "webview", "panel.js");
  new vm.Script(fs.readFileSync(panelJsPath, "utf-8"), { filename: "panel.js" });
  if (!html.includes('href="%%PANEL_CSS%%"') || !html.includes('src="%%PANEL_JS%%"')) {
    throw new Error("panel.html is missing panel CSS/JS placeholders");
  }
  if (/<script(?![^>]*\bsrc=)[^>]*>[\s\S]*?<\/script>/.test(html) || /<style(?:\s[^>]*)?>/.test(html)) {
    throw new Error("panel.html must not contain inline JavaScript or CSS");
  }
  console.log("post-build: hljs CDN removed, panel.js syntax OK");
} catch (e) {
  console.error("post-build: PANEL SCRIPT ERROR —", e.message);
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

