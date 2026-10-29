#!/usr/bin/env node
const fs = require("fs");
const path = require("path");

const root = path.join(__dirname, "..");
const sourceDir = path.join(root, "src", "webview", "panel");
const outputDir = path.join(root, "dist", "webview");
const parts = [
  path.join(root, "src", "webview", "components", "media-zoom.js"),
  path.join(root, "src", "webview", "components", "disclosure-action-card.js"),
  path.join(root, "src", "webview", "components", "accessible-interactions.js"),
  path.join(root, "src", "webview", "components", "sortable-data-table.js"),
  "00-core.js",
  "05-onboarding.js",
  "10-chatroom.js",
  path.join(root, "src", "webview", "recipe-graph-shared.js"),
  path.join(root, "src", "webview", "agent-harness.js"),
  "15-projects.js",
  "16-portal-connections.js",
  "20-knowledge.js",
  "21-search.js",
  "30-environments.js",
  "40-servers.js",
  "45-subscriptions.js",
  "46-github-sync.js",
  "50-mcp.js",
  "51-skill-router.js",
  "52-background-tasks.js",
  "53-panel-instances.js",
  "54-persona-profiles.js",
  "60-init.js",
];

const bundle = parts
  .map((file) => fs.readFileSync(path.isAbsolute(file) ? file : path.join(sourceDir, file), "utf-8"))
  .join("");

fs.writeFileSync(path.join(outputDir, "panel.js"), bundle);
fs.writeFileSync(path.join(outputDir, "standalone-mermaid.js"),
  fs.readFileSync(path.join(root, "src", "webview", "components", "media-zoom.js"), "utf8") + "\n"
  + fs.readFileSync(path.join(root, "src", "webview", "standalone-mermaid.js"), "utf8"));
fs.rmSync(path.join(outputDir, "panel"), { recursive: true, force: true });
console.log(`build-panel: joined ${parts.length} source files`);