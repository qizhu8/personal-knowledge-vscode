#!/usr/bin/env node
const fs = require("fs");
const path = require("path");

const root = path.join(__dirname, "..");
const sourceDir = path.join(root, "src", "webview", "panel");
const outputDir = path.join(root, "dist", "webview");
const parts = [
  "00-core.js",
  "10-chatroom.js",
  "20-knowledge.js",
  "30-environments.js",
  "40-servers.js",
  "50-mcp.js",
  "60-init.js",
];

const bundle = parts
  .map((file) => fs.readFileSync(path.join(sourceDir, file), "utf-8"))
  .join("");

fs.writeFileSync(path.join(outputDir, "panel.js"), bundle);
fs.rmSync(path.join(outputDir, "panel"), { recursive: true, force: true });
console.log(`build-panel: joined ${parts.length} source files`);