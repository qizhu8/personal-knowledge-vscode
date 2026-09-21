#!/usr/bin/env node
const fs = require("fs");
const path = require("path");

const root = path.join(__dirname, "..");
const sourceDir = path.join(root, "src", "webview", "panel");
const outputDir = path.join(root, "dist", "webview");
const parts = [
  path.join(root, "src", "webview", "components", "disclosure-action-card.js"),
  "00-core.js",
  "10-chatroom.js",
  "15-projects.js",
  "20-knowledge.js",
  "30-environments.js",
  "40-servers.js",
  "45-subscriptions.js",
  "50-mcp.js",
  "51-skill-router.js",
  "60-init.js",
];

const bundle = parts
  .map((file) => fs.readFileSync(path.isAbsolute(file) ? file : path.join(sourceDir, file), "utf-8"))
  .join("");

fs.writeFileSync(path.join(outputDir, "panel.js"), bundle);
fs.rmSync(path.join(outputDir, "panel"), { recursive: true, force: true });
console.log(`build-panel: joined ${parts.length} source files`);