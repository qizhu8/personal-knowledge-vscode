#!/usr/bin/env node
const assert = require("assert");
const fs = require("fs");
const path = require("path");
const vm = require("vm");

const panelJs = fs.readFileSync(path.join(__dirname, "..", "dist", "webview", "panel.js"), "utf8");
const match = panelJs.match(/function chatParseRecipients\(text\)\s*\{[\s\S]*?\n\}\nfunction chatRecipientToken[\s\S]*?function chatMaterializeRecipient\(text\)\s*\{[\s\S]*?\n\}/);
assert(match, "Chatroom recipient materializer must be present in the bundled panel script");

const context = { chat: { active: null }, String };
vm.createContext(context);
new vm.Script(`${match[0]}; this.materialize = chatMaterializeRecipient;`).runInContext(context);

context.chat.active = { selfHost: true, members: [{ user: "Host", host: true, present: true }] };
assert.strictEqual(context.materialize("broadcast"), "@all broadcast");

context.chat.active = { selfHost: false, members: [{ user: "Room Host", host: true, present: true }, { user: "Guest", present: true }] };
assert.strictEqual(context.materialize("reply"), '@"Room Host" reply');
assert.strictEqual(context.materialize("@Someone explicit"), "@Someone explicit");
assert.strictEqual(context.materialize("/help"), "/help");

console.log("chat default recipient UI test: Host broadcasts and guests default to point-to-point Host replies OK");
