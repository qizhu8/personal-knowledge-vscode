#!/usr/bin/env node
const assert = require("assert");
const fs = require("fs");
const path = require("path");

const root = path.join(__dirname, "..");
const core = fs.readFileSync(path.join(root, "src/webview/panel/00-core.js"), "utf8");
const knowledge = fs.readFileSync(path.join(root, "src/webview/panel/20-knowledge.js"), "utf8");
const servers = fs.readFileSync(path.join(root, "src/webview/panel/40-servers.js"), "utf8");
const extension = fs.readFileSync(path.join(root, "src/extension.ts"), "utf8");
const subscriptions = fs.readFileSync(path.join(root, "src/subscriptions/subscriptions.ts"), "utf8");
const gateway = fs.readFileSync(path.join(root, "src/subscriptions/subscription-gateway-entry.ts"), "utf8");
const sync = fs.readFileSync(path.join(root, "src/sync/sync-server.ts"), "utf8");
const hub = fs.readFileSync(path.join(root, "src/chatroom/chatroom-hub.ts"), "utf8");

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
assert.match(extension, /path\.join\(signatureRoot, "\.pkm", "content-privacy\.json"\)/);
assert.match(extension, /_watcherRefreshTimer\.unref\?\.\(\)/);
assert.match(extension, /if \(_watcherRefreshTimer\) clearTimeout\(_watcherRefreshTimer\)/);
assert.match(extension, /_projectStateWatcher = createKnowledgeFileWatcher\([\s\S]{0,400}"projects\.json", "project-store\.json", "agent-groups", "api-chats", "agent-sessions", "agent-sessions-trash", "recipe-runs", "actions\/runs", "mcp-usage\/todos"/,
	"out-of-process Project, Recipe Run, Agent Session, Action and Todo writes must use bounded watchers");
assert.match(extension, /_recipeContentWatcher = createKnowledgeFileWatcher\(\[path\.join\(signatureRoot, "recipes"\)\]\)/,
	"out-of-process canonical Recipe file writes must be watched");
assert.doesNotMatch(extension, /vscode\.workspace\.createFileSystemWatcher\(/,
	"callback filtering cannot bound a recursive OS watcher");
assert.match(extension, /(?:postMessage|postToPanel)\(\{ command: "projectStateChanged", data: \{[\s\S]{0,300}scopes, changedPaths/,
	"managed state changes must send a lightweight invalidation instead of eagerly rebuilding snapshots");
assert.match(extension, /const scope = relativeStatePath === "projects\.json"[\s\S]{0,350}queueProjectRefresh\(scope, uri\)/,
	"state watcher invalidations must feed the coalesced scope queue");
assert.match(core, /state\.tab === 'recipes' \? scope === 'recipes'/,
	"Recipe Library must ignore high-frequency Agent Session and Recipe run writes");
assert.match(extension, /if \(!\[\.\.\.panels\.instances\.values\(\)\]\.some\(session => session\.ready && session\.panel\?\.visible\)\) return/);
assert.match(extension, /signature !== _knowledgeTreeSignature/);
assert.match(extension, /file watcher fallback detected a knowledge tree change/);
assert.match(extension, /const fallbackIntervalMs = 5 \* 60_000/);
assert.match(extension, /_watcherFallbackTimer = setInterval\(\(\) => checkContents\(true\), fallbackIntervalMs\)/,
	"fallback full-tree scans are infrequent safeguards for native watcher failures");
assert.match(extension, /if \(_watcherFallbackTimer\) clearInterval\(_watcherFallbackTimer\)/);
assert.match(extension, /retainContextWhenHidden: true/, "hidden panels retain their DOM and drafts across ordinary view switches");
assert.match(extension, /fs\.writeFileSync\(target\.fsPath, rec\.data\);\s*rc\?\.files\.delete\(fileId\);/, "saved received-file buffers are released");
assert.match(subscriptions, /30 \* 60_000/);
assert.match(subscriptions, /5 \* 60_000/);
assert.match(gateway, /watch\(dirname\(statePath\)/);
assert.match(gateway, /watchFile\(statePath, \{ interval: 10_000 \}/);
assert.doesNotMatch(gateway, /interval: 1_000/);
assert.match(gateway, /setTimeout\(\(\) => \{ reloadTimer = undefined; void reload/);
assert.match(sync, /2 \* 60_000/);
assert.match(hub, /setInterval\(\(\) => this\.sweep\(\), 60_000\)/);
assert.match(servers, /short-lived, user-visible active search/);

console.log("Resource polling test: visible-only heartbeat, active Server monitoring, bounded file watch, and reduced fallback sweeps OK");
