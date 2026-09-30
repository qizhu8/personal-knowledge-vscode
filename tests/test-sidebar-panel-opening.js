#!/usr/bin/env node
const assert = require("assert");
const fs = require("fs");
const path = require("path");

const root = path.join(__dirname, "..");
const extensionSource = fs.readFileSync(path.join(root, "src", "extension.ts"), "utf8");
const startupSource = fs.readFileSync(path.join(root, "tests", "extension-startup", "index.js"), "utf8");

const commandRegistration = extensionSource.indexOf('registerCommand("personalKnowledge.open", openMainPanel)');
const visibilityRegistration = extensionSource.indexOf("treeView.onDidChangeVisibility");
assert(commandRegistration >= 0 && commandRegistration < visibilityRegistration,
  "the open command must be registered before sidebar visibility can trigger it");
assert.match(extensionSource, /if \(treeView\.visible\) void openVisibleSidebar\(\)/,
  "an already-visible sidebar must open the main panel after activation");
assert.match(startupSource, /executeCommand\("workbench\.view\.extension\.personalKnowledgeBar"\)/,
  "startup coverage must open PKM through its Activity Bar container");
assert.doesNotMatch(startupSource, /if \(expectPanel\) await vscode\.commands\.executeCommand\("personalKnowledge\.open"\)/,
  "startup coverage must not bypass sidebar visibility handling");
assert.match(extensionSource, /vscode\.Uri\.joinPath\(context\.extensionUri, "dist", "webview"\)/,
  "remote Webviews must resolve packaged UI resources from context.extensionUri");
assert.doesNotMatch(extensionSource, /asWebviewUri\(vscode\.Uri\.file\(path\.join\(webviewDir/,
  "extension-owned Webview resources must not be reduced to local file URIs");

console.log("Sidebar panel opening tests passed");