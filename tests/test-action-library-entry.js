const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const root = path.join(__dirname, "..");
const html = fs.readFileSync(path.join(root, "src", "webview", "panel.html"), "utf8");
const core = fs.readFileSync(path.join(root, "src", "webview", "panel", "00-core.js"), "utf8");
const extension = fs.readFileSync(path.join(root, "src", "extension.ts"), "utf8");

assert.match(html,
  /<span class="workspace-context-title">Automation<\/span>[\s\S]*?openActionLibrary\(event\)[^>]*>Action Library<\/button>[\s\S]*?data-tab="agentSessions"/,
  "Automation exposes Action Library before its persisted collection tabs");
assert.match(core,
  /function openActionLibrary\(event\)[\s\S]*?vscode\.postMessage\(\{ command:'openActionLibrary' \}\)/,
  "the navigation entry sends a dedicated extension-host request");
assert.match(extension,
  /case "openActionLibrary":[\s\S]*?openActionWorkbench\(context, undefined, undefined, true\)[\s\S]*?break/,
  "the extension host reuses the existing native Action Workbench");

console.log("action library entry test: main Automation navigation reuses the durable Action Workbench");
