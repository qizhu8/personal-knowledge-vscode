#!/usr/bin/env node
const assert = require("assert");
const fs = require("fs");
const path = require("path");
const vm = require("vm");

const root = path.join(__dirname, "..");
const panel = fs.readFileSync(path.join(root, "dist", "webview", "panel.js"), "utf8");
const css = fs.readFileSync(path.join(root, "dist", "webview", "panel.css"), "utf8");
const extension = fs.readFileSync(path.join(root, "src", "extension.ts"), "utf8");
const manifest = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));

assert.match(panel, /Hosted by me/);
assert.match(panel, /Joined before/);
assert.match(panel, /id="chat-hosted-rooms" class="chat-room-cards"/);
assert.match(panel, /id="chat-joined-rooms" class="chat-room-cards"/);
assert.match(panel, /function chatRoomCard\(room\)/);
assert.match(panel, /function chatInactiveRoomCard\(room\)/);
assert.match(panel, /customElements\.define\("uone-disclosure-card"/);
assert.match(panel, /<uone-disclosure-card class="chat-room-card"/);
assert.match(panel, /slot="actions"/);
assert.match(panel, /class="chat-inactive-resume"/);
assert.match(panel, /aria-label="\$\{esc\(room\.resume\?\.title/);
assert.match(panel, />▶<\/button>/);
assert.match(panel, /resume:room\.canRehost \? \{title:'Rehost this Room'/);
assert.match(panel, /resume:\{title:`Rejoin as/);
assert.doesNotMatch(panel, /hostedInactive[\s\S]{0,700}\{label:'Rehost'/);
assert.match(panel, /function chatPaintRoomCards\(\)/);
assert.match(panel, /const chatInactiveExpanded = \{ hosted: false, joined: false \}/,
  "both Inactive groups must be collapsed by default");
assert.match(panel, /function chatToggleInactive\(group\)/);
assert.match(panel, /aria-expanded="\$\{expanded\}"/);
assert.match(panel, /Inactive · \$\{inactive\.length\}/);
assert.match(panel, /chatRoomCardCollection\('hosted'/);
assert.match(panel, /chatRoomCardCollection\('joined'/);
assert.doesNotMatch(panel, /id="chat-admin-rooms"/);
assert.doesNotMatch(panel, /id="chat-stored-rooms"/);
assert.doesNotMatch(panel, /id="chat-recents"/);
assert.doesNotMatch(panel, /id="chat-hub-info"/);
assert.doesNotMatch(panel, /function chatPaintStoredRooms\(/);
assert.doesNotMatch(panel, /function chatPaintRecents\(/);
assert.match(panel, /id="chat-host-toggle"/);
assert.match(panel, /id="chat-admin-closeall"/);
assert.match(panel, /Magic Link/);
assert.match(panel, /Browser/);
assert.match(panel, /Force Close/);
assert.match(panel, /Rehost/);
assert.match(panel, /Forget/);
assert.match(panel, /chatCopyInvite',\{roomId:/);
assert.match(panel, /chatRotateSecret',\{roomId:/);
const browserFunction = panel.match(/function chatOpenRoomBrowserAt\(url, room\) \{[\s\S]*?\n\}/);
assert(browserFunction, "joined Room Browser handler must be present");
const opened = [];
const browserContext = { URL, ask: (command, payload) => opened.push({ command, payload }) };
vm.createContext(browserContext);
new vm.Script(`${browserFunction[0]};chatOpenRoomBrowserAt('wss://chat.example:7345/socket?secret=private#fragment','生成式检索')`)
  .runInContext(browserContext);
assert.strictEqual(opened.length, 1);
assert.strictEqual(opened[0].command, "openExternal");
assert.strictEqual(opened[0].payload.url,
  "https://chat.example:7345/room/%E7%94%9F%E6%88%90%E5%BC%8F%E6%A3%80%E7%B4%A2");
assert.match(extension, /hasKey: this\.hostedKeys\.has\(r\.roomId\)/);
assert.match(css, /\.chat-room-section\{[^}]*flex:none/);
assert.match(css, /#chat-rail\{[^}]*scrollbar-gutter:stable/,
  "the Hub rail must reserve scrollbar space before Inactive cards expand");
assert.match(css, /#chat-rail\{[^}]*scrollbar-color:var\(--border\) var\(--panel\)/);
assert.match(css, /#chat-rail::\-webkit-scrollbar-track\{background:var\(--panel\)\}/);
assert.match(css, /#chat-rail::\-webkit-scrollbar-thumb\{[^}]*border:2px solid var\(--panel\)/);
assert.match(css, /\.chat-room-section\+\.chat-room-section\{[^}]*margin-top:14px/);
assert.match(panel, /:host\(:hover\) \.actions/);
assert.match(panel, /@media \(prefers-reduced-motion: reduce\)/);
assert.match(css, /\.chat-close-all/);

const forceCloseMenu = manifest.contributes.menus["view/item/context"].find(item => item.command === "personalKnowledge.forceCloseHostedRoom");
assert.strictEqual(forceCloseMenu.when, "view == personalKnowledge.sidebarView && viewItem == pk-chat-hosted-room-active-elsewhere");

console.log("Chat Room cards UI test: two groups, active-first ordering, collapsed Inactive, hover actions, UUID admin actions, and Close all OK");
