#!/usr/bin/env node
const assert = require("assert");
const fs = require("fs");
const path = require("path");

const root = path.join(__dirname, "..");
const core = fs.readFileSync(path.join(root, "src", "webview", "panel", "00-core.js"), "utf8");
const knowledge = fs.readFileSync(path.join(root, "src", "webview", "panel", "20-knowledge.js"), "utf8");
const servers = fs.readFileSync(path.join(root, "src", "webview", "panel", "40-servers.js"), "utf8");
const mcp = fs.readFileSync(path.join(root, "src", "webview", "panel", "50-mcp.js"), "utf8");
const extension = fs.readFileSync(path.join(root, "src", "extension.ts"), "utf8");
const vscodeIgnore = fs.readFileSync(path.join(root, ".vscodeignore"), "utf8");

assert.match(core, /if \(currentDetailRequest\) ask\('detail', currentDetailRequest\)/);
assert.match(knowledge, /function requestDetail\(type, key\)/);
assert.match(knowledge, /state\.tab = t\.dataset\.tab;[\s\S]{0,120}currentDetail = null;[\s\S]{0,80}currentDetailRequest = null;/);
for (const type of ["prompt", "promptDiff", "packageFile"]) assert(knowledge.includes(`requestDetail('${type}'`), `${type} must retain its exact refresh request`);
assert.match(knowledge, /currentDetail = data;/);

assert.match(servers, /ask\('serverList',\{\}\).*Force-refresh server process, port, and link status/);
assert.match(mcp, /ask\('refreshMcpPathSizes', \{\}\)/);
assert.match(extension, /mcpPathSizeGeneration \+= 1;[\s\S]{0,100}mcpPathSizeCache\.clear\(\)/);
assert.match(extension, /case "reload":[\s\S]{0,300}respond\(\{ command: "reloaded" \}\)/);
assert.match(vscodeIgnore, /^\*\*\/\*\.map$/m);
assert.match(vscodeIgnore, /^scripts\/poc-\*\.js$/m);

console.log("refresh actions test: current detail, Server status, MCP sizes, and disk-backed knowledge refresh contracts OK");