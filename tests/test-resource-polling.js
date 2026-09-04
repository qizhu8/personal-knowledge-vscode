#!/usr/bin/env node
const assert = require("assert");
const fs = require("fs");
const path = require("path");

const root = path.join(__dirname, "..");
const core = fs.readFileSync(path.join(root, "src/webview/panel/00-core.js"), "utf8");
const knowledge = fs.readFileSync(path.join(root, "src/webview/panel/20-knowledge.js"), "utf8");
const servers = fs.readFileSync(path.join(root, "src/webview/panel/40-servers.js"), "utf8");
const extension = fs.readFileSync(path.join(root, "src/extension.ts"), "utf8");
const subscriptions = fs.readFileSync(path.join(root, "src/subscriptions.ts"), "utf8");
const gateway = fs.readFileSync(path.join(root, "src/subscription-gateway-entry.ts"), "utf8");
const sync = fs.readFileSync(path.join(root, "src/sync-server.ts"), "utf8");
const hub = fs.readFileSync(path.join(root, "src/chatroom-hub.ts"), "utf8");

assert.match(core, /document\.visibilityState === 'visible'.*120000/);
assert.match(servers, /setTimeout\(\(\) => \{ if \(state\.tab === 'servers'\).*5000/);
assert.match(servers, /serverSubscriptionMonitor = setInterval/);
assert.match(servers, /60_000/);
assert.doesNotMatch(servers, /serverSubscriptionMonitor = setInterval\([\s\S]{0,220},\s*[1-9]_?000\)/);
assert.match(servers, /stopSubscribedServerMonitoring\(\)/);
assert.match(knowledge, /state\.tab === 'servers'.*stopSubscribedServerMonitoring\(\)/);
assert.match(extension, /subscribedServerGroupsForUi\(\)/);
assert.match(extension, /subscribedServerGroupsForUi\(String\(msg\.subscriptionId \|\| ""\), true\)/);
assert.match(extension, /_watcherRefreshTimer = setTimeout/);
assert.match(extension, /_watcherRefreshTimer\.unref\?\.\(\)/);
assert.match(extension, /if \(_watcherRefreshTimer\) clearTimeout\(_watcherRefreshTimer\)/);
assert.match(subscriptions, /30 \* 60_000/);
assert.match(subscriptions, /5 \* 60_000/);
assert.match(gateway, /watch\(dirname\(statePath\)/);
assert.match(gateway, /watchFile\(statePath, \{ interval: 10_000 \}/);
assert.doesNotMatch(gateway, /interval: 1_000/);
assert.match(gateway, /setTimeout\(\(\) => \{ reloadTimer = undefined; void reload/);
assert.match(sync, /2 \* 60_000/);
assert.match(hub, /setInterval\(\(\) => this\.sweep\(\), 60_000\)/);
assert.match(servers, /short-lived, user-visible active search/);

console.log("Resource polling test: visible-only heartbeat, active Server monitoring, native file watch, and reduced fallback sweeps OK");
