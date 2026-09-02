#!/usr/bin/env node
const assert = require("assert");
const fs = require("fs");
const path = require("path");
const { ChatHub } = require("../dist/chatroom-hub.js");

const hub = new ChatHub();
assert.ok(hub.publicHost);
hub.setAdvertisedHost("review-host.example");
assert.strictEqual(hub.publicHost, "review-host.example");
assert.throws(() => hub.setAdvertisedHost("bad host name"), /Invalid Chatroom advertised host/);

const root = path.join(__dirname, "..");
const manifest = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));
const setting = manifest.contributes.configuration.properties["personalKnowledge.chatInviteHost"];
assert.strictEqual(setting.scope, "machine");
assert.match(setting.description, /Magic Links/);

const extension = fs.readFileSync(path.join(root, "src", "extension.ts"), "utf8");
assert.match(extension, /serverNetworkAddresses\(\)\.map/);
assert.match(extension, /chatInviteHostOptions\(context\)/);
assert.match(extension, /getChatMgr\(\)\.setAdvertisedHost/);
assert.match(extension, /case "chatSetInviteHost"/);
assert.match(extension, /Choose an available Invite interface before hosting a Room/);
assert.match(extension, /ConfigurationTarget\.Global/);
assert.match(extension, /ws:\/\/\$\{this\.advertisedHost\(\)\}:\$\{this\.hub\.port\}/);
assert.match(extension, /let base = this\.hub\?\.port \? `ws:\/\/\$\{this\.advertisedHost\(\)\}/);

const panel = fs.readFileSync(path.join(root, "dist", "webview", "panel.js"), "utf8");
assert.match(panel, /id="chat-invite-host"/);
assert.match(panel, /function chatPaintInviteHosts\(\)/);
assert.match(panel, /function chatInviteHostChanged\(address\)/);
assert.match(panel, /Magic Links will advertise/);
assert.match(panel, /Saved interface is unavailable/);
assert.match(panel, /ask\('chatSetInviteHost', \{ address \}\)/);

console.log("Chat invite host test: selectable machine-local hostname/interface, unavailable-state protection, and advertised URL wiring OK");
