#!/usr/bin/env node
const assert = require("assert");
const fs = require("fs");
const path = require("path");

const root = path.join(__dirname, "..");
const panel = fs.readFileSync(path.join(root, "src", "webview", "panel", "30-environments.js"), "utf8");
const extension = fs.readFileSync(path.join(root, "src", "extension.ts"), "utf8");

assert.match(panel, /onclick="refreshEnvDashboard\(\)"/);
assert.match(panel, /ask\('envList', \{ refresh: true \}\)/);
assert.match(panel, /Force-refresh paths, Python versions, and disk sizes/);

const handler = /case "envList": \{([\s\S]*?)\n    \}\n    case /.exec(extension);
assert(handler, "envList handler must exist");
assert.match(handler[1], /if \(msg\.refresh\)/);
assert.match(handler[1], /for \(const environment of pyenvList\(\)\)/);
assert.match(handler[1], /await refreshEnvironmentVersion\(environment\.id\)/);
assert.match(handler[1], /if \(probe\.error\) refreshErrors\.push/);
assert.match(handler[1], /await refreshEnvironmentSize\(environment\.id\)/);
assert.match(handler[1], /if \(size\.error\) refreshErrors\.push/);
assert(handler[1].indexOf("await refreshEnvironmentVersion") < handler[1].indexOf('respond({ command: "envList"'), "forced metadata reads must finish before responding");

console.log("environment refresh test: top-level Refresh forces all card paths, Python versions, and disk sizes OK");