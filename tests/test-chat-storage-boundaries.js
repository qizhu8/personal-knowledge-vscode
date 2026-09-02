#!/usr/bin/env node
const assert = require("assert");
const fs = require("fs");
const path = require("path");

const root = path.join(__dirname, "..");
const extension = fs.readFileSync(path.join(root, "src", "extension.ts"), "utf8");
const worker = fs.readFileSync(path.join(root, "src", "chat-persistence-worker.ts"), "utf8");
const hub = fs.readFileSync(path.join(root, "src", "chatroom-hub.ts"), "utf8");
const credentials = fs.readFileSync(path.join(root, "src", "chat-room-credentials.ts"), "utf8");
const manifest = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));

assert.match(extension, /configurePersistence\(path\.join\(store, "chatrooms"\)/, "Room persistence must live under Knowledge Root/chatrooms");
assert.match(worker, /path\.join\(dir, "chatroom\.db"\)/);
assert.match(worker, /path\.join\(dir, "chatroom\.journal"\)/);
assert.match(worker, /CREATE TABLE IF NOT EXISTS messages/);
assert.match(worker, /CREATE TABLE IF NOT EXISTS memberships/);
assert.match(worker, /CREATE TABLE IF NOT EXISTS alias_history/);
assert.match(worker, /CREATE TABLE IF NOT EXISTS pending_joins/);
assert.match(credentials, /personalKnowledge\.chatroom\.\$\{roomId\}\.host/);
assert.match(credentials, /personalKnowledge\.chatroom\.\$\{roomId\}\.join/);
assert.match(extension, /personalKnowledge\.chatroom\.recent\.\$\{createHash\("sha256"\)/);
assert.match(extension, /if \(room\.secret\) await ctx\.secrets\.store/);
assert.match(extension, /delete room\.secret/);
assert.match(extension, /await ctx\.secrets\.delete\(chatRecentSecretKey\(id\)\)/);
const recentInsert = /list\.unshift\(\{[^\n]+\}\)/.exec(extension)?.[0] || "";
assert(recentInsert, "recent insert must exist");
assert.doesNotMatch(recentInsert, /secret/, "globalState recents must not retain Room secrets");
const rootSwitch = /registerCommand\("personalKnowledge\.reconfigureKnowledgeRoot"[\s\S]*?registerCommand\("personalKnowledge\.reconfigureEnvironmentsRoot"/.exec(extension)?.[0] || "";
assert.match(rootSwitch, /await chatMgr\?\.dispose\(\)/);
assert(rootSwitch.indexOf("await chatMgr?.dispose()") < rootSwitch.indexOf("await initStore(context, chosen)"), "Chatroom must flush/stop before switching roots");
assert.match(rootSwitch, /Chatroom history now uses/);
assert.match(hub, /if \(this\.persistence\) await this\.persistence\.append/);
assert.match(hub, /if \(!this\.persistence\) this\.scheduleFlush/);
const legacy = manifest.contributes.configuration.properties["personalKnowledge.chatSharedSecret"];
assert.strictEqual(legacy.scope, "machine");
assert.match(legacy.deprecationMessage, /SecretStorage/);

console.log("chat storage boundaries test: Knowledge Root DB, SecretStorage credentials, sanitized recents, root-switch flush, and legacy archive boundary OK");
