#!/usr/bin/env node
const assert = require("assert");
const fs = require("fs");
const path = require("path");
const vm = require("vm");

const panelJs = fs.readFileSync(path.join(__dirname, "..", "dist", "webview", "panel.js"), "utf8");
const match = panelJs.match(/function chatHighlightableMentionNames\(\)\s*\{[\s\S]*?\n\}\n\/\/ Wrap @tokens[\s\S]*?function chatHighlightMentions\(escaped\)\s*\{[\s\S]*?\n\}/);
assert(match, "Chatroom mention highlighter must be present in the bundled panel script");

const context = {
  chat: { active: { self: "Me", members: [
    { user: "Me", present: true },
    { user: "Agent One", present: true },
    { user: "Fox & Jia", present: false },
  ] } },
  esc: value => String(value).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;"),
  Set,
};
vm.createContext(context);
new vm.Script(`${match[0]}; this.highlight = chatHighlightMentions;`).runInContext(context);

assert.match(context.highlight("@Me hello"), /chat-at-me/);
assert.match(context.highlight('@"Agent One" hello'), /chat-at-other/);
assert.match(context.highlight('@"Fox &amp; Jia" hello'), /chat-at-other/);
assert.match(context.highlight("@&quot;Agent One&quot; compatibility"), /chat-at-other/);
assert.match(context.highlight("@all hello"), /chat-at-me/);
assert.strictEqual(context.highlight("email @example and @Unknown"), "email @example and @Unknown");
console.log("chat mention highlight UI test: known aliases highlighted and unknown @words preserved OK");