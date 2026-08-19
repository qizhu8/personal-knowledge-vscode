#!/usr/bin/env node
const assert = require("assert");
const fs = require("fs");
const path = require("path");
const { summarizeServerNavigation, summarizeChatNavigation } = require("../dist/navigation-status.js");

assert.deepStrictEqual(summarizeServerNavigation([]).kind, "offline");
assert.deepStrictEqual(summarizeServerNavigation([{ status: "stopped", proxyRunning: true }]).description, "all stopped");
assert.deepStrictEqual(summarizeServerNavigation([{ status: "running", proxyRunning: true }]).kind, "online");
assert.deepStrictEqual(summarizeServerNavigation([{ status: "running", proxyRunning: false }]).kind, "online");
assert.deepStrictEqual(summarizeServerNavigation([{ status: "starting", proxyRunning: true }]).kind, "attention");

assert.deepStrictEqual(summarizeChatNavigation({}).kind, "offline");
assert.deepStrictEqual(summarizeChatNavigation({ hubRunning: true }).description, "Hub running");
assert.deepStrictEqual(summarizeChatNavigation({ rooms: [{ status: "connected" }] }).kind, "online");
assert.deepStrictEqual(summarizeChatNavigation({ hubRunning: true, rooms: [{ status: "connecting" }] }).kind, "attention");

const extension = fs.readFileSync(path.join(__dirname, "..", "src", "extension.ts"), "utf8");
const manifest = fs.readFileSync(path.join(__dirname, "..", "package.json"), "utf8");
assert.match(extension, /new PkTreeItem\(this\.text\("tabs\.servers"\), "root-servers"/);
assert.doesNotMatch(extension, /applyStatus\(new PkTreeItem\(this\.text\("tabs\.servers"\), "root-servers"/);
assert.doesNotMatch(extension, /applyStatus\(new PkTreeItem\(this\.text\("tabs\.chatroom"\), 'root-chatroom'/);
assert.match(extension, /case 'root-servers': return this\._serverItems\(\)/);
assert.match(extension, /private _serverItems\(\): PkTreeItem\[\]/);
assert.match(extension, /new PkTreeItem\(server\.name, "server-item"/);
assert.match(extension, /applyStatus\(new PkTreeItem\(room\.roomName, "chat-hosted-room"/);
assert.match(extension, /applyStatus\(new PkTreeItem\(room\.room, "chat-room"/);
assert.match(extension, /this\.text\("nav\.runningPort", \{ port: server\.activePort \}\)/);
assert.match(extension, /personalKnowledge\.openServers/);
assert.match(extension, /case "serverSetForward"/);
assert.match(extension, /servers\.autoForward\.global\.v1", true/);
assert.doesNotMatch(extension, /servers\.autoForward\.v1/);
assert.match(extension, /globalState\.update\("servers\.autoForward\.global\.v1", enabled\)/);
const serverSetForwardCase = /case "serverSetForward": \{([\s\S]*?)\n    \}\n    case /.exec(extension);
assert(serverSetForwardCase, "serverSetForward handler must exist");
assert.doesNotMatch(serverSetForwardCase[1], /const slug =/);
assert.match(extension, /vscode\.env\.asExternalUri/);
assert.match(extension, /Close any existing tunnel manually in VS Code's Ports view/);
assert.match(extension, /new vscode\.ThemeIcon\("circle-filled"/);
assert.match(extension, /localizedText\(this\.context\.extensionPath, key, params\)/);
assert.match(extension, /summarizeChatNavigation\(snapshot as any\)/);
assert.doesNotMatch(extension, /setInterval\(\(\) => \{ void this\.refreshServerStatus\(\); \}, 5000\)/);
assert.match(extension, /if \(this\.serverStatusRefresh\) return this\.serverStatusRefresh/);
assert.match(manifest, /"command": "personalKnowledge\.openServers"/);
assert.match(manifest, /"command": "personalKnowledge\.startServerItem"/);
assert.match(manifest, /viewItem == pk-server-stopped/);
assert.match(manifest, /"command": "personalKnowledge\.stopServerItem"/);
assert.match(manifest, /"command": "personalKnowledge\.restartServerItem"/);
assert.match(manifest, /viewItem == pk-server-active/);

console.log("navigation status test: Servers and Chatroom online/attention/offline aggregation OK");