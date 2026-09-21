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
assert.match(extension, /options\.find\(item => item\.kind === "hostname"\)\?\.address \|\| options\[0\]\?\.address/);
assert.match(extension, /getChatMgr\(\)\.setAdvertisedHost/);
assert.match(extension, /case "chatSetInviteHost"/);
assert.match(extension, /Choose an available Invite interface before hosting a Room/);
assert.match(extension, /ConfigurationTarget\.Global/);
assert.match(extension, /ws:\/\/\$\{this\.advertisedHost\(\)\}:\$\{this\.hub\.port\}/);
assert.match(extension, /let base = this\.hub\?\.port \? `ws:\/\/\$\{this\.advertisedHost\(\)\}/);

const panel = fs.readFileSync(path.join(root, "dist", "webview", "panel.js"), "utf8");
assert.doesNotMatch(panel, /id="chat-invite-host"/,
	"Projects/Threads must not duplicate the machine-level Invite interface setting");
assert.doesNotMatch(panel, /Hosting on/);
assert.doesNotMatch(panel, /function chatPaintInviteHosts\(\)/);
assert.doesNotMatch(panel, /function chatInviteHostChanged\(address\)/);

console.log("Chat invite host test: machine-local Settings wiring retained without duplicate Threads controls OK");
