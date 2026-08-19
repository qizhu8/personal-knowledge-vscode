#!/usr/bin/env node
const assert = require("assert");
const fs = require("fs");
const path = require("path");
const vm = require("vm");

const panelJs = fs.readFileSync(path.join(__dirname, "..", "dist", "webview", "panel.js"), "utf8");
const extensionJs = fs.readFileSync(path.join(__dirname, "..", "dist", "extension.js"), "utf8");
assert(extensionJs.includes("scheduleCrossWindowRefresh"));
assert(extensionJs.includes("this.storedRooms.some(room => room.activeElsewhere)"));
assert(extensionJs.includes("active Room refresh failed"));
const match = panelJs.match(/function chatPaintStoredRooms\(\)\s*\{[\s\S]*?\n\}\n\nfunction chatPaintActive/);
assert(match, "chatPaintStoredRooms must be present in the bundled panel script");
const functionSource = match[0].replace(/\n\nfunction chatPaintActive$/, "");

function createElement() {
  return {
    innerHTML: "",
    hidden: false,
    classList: { toggle(_name, value) { this.owner.hidden = value; }, owner: null },
  };
}

const wrap = createElement(); wrap.classList.owner = wrap;
const box = createElement(); box.classList.owner = box;
const context = {
  chat: { storedRooms: [] },
  document: { getElementById: id => id === "chat-stored-wrap" ? wrap : id === "chat-stored-rooms" ? box : null },
  esc: value => String(value).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/'/g, "&#39;").replace(/"/g, "&quot;"),
  chatAgo: () => "left 2h ago",
};
vm.createContext(context);
new vm.Script(`${functionSource}; this.paint = chatPaintStoredRooms;`).runInContext(context);

context.paint();
assert.strictEqual(wrap.hidden, true, "empty Stored Rooms section must be hidden");
assert.strictEqual(box.innerHTML, "");

context.chat.storedRooms = [
  { roomId: "room-available", roomName: "Design <Review>", messageCount: 2, updatedAt: 1, canRehost: true },
  { roomId: "room-active-elsewhere", roomName: "Live Review", messageCount: 3, updatedAt: 1, canRehost: false,
    activeElsewhere: true, unavailableReason: "Active in another VS Code window." },
  { roomId: "room-unavailable", roomName: "Archive", messageCount: 0, updatedAt: 1, canRehost: false, unavailableReason: "Host credential is missing." },
];
context.paint();
assert.strictEqual(wrap.hidden, false);
assert.match(box.innerHTML, /chatRehostStoredRoom/);
assert.match(box.innerHTML, /chatRenameStoredRoom/);
assert.match(box.innerHTML, /chatDeleteStoredRoom/);
assert.match(box.innerHTML, /room-available/);
assert.doesNotMatch(box.innerHTML, /chatRehostStoredRoom[^>]+room-unavailable/);
assert.match(box.innerHTML, /Host credential is missing/);
assert.match(box.innerHTML, /2 messages · 2h ago/);
assert.match(box.innerHTML, /Active in another VS Code window · 3 messages/);
assert.match(box.innerHTML, /Design &lt;Review&gt;/, "Room names must be escaped");
assert.match(box.innerHTML, /disabled/, "unavailable Room action must be disabled");
const unavailableRow = box.innerHTML.slice(box.innerHTML.indexOf("room-unavailable"));
assert.doesNotMatch(unavailableRow, /chatRenameStoredRoom|chatDeleteStoredRoom/);
const activeElsewhereRow = box.innerHTML.slice(box.innerHTML.indexOf("room-active-elsewhere"), box.innerHTML.indexOf("room-unavailable"));
assert.doesNotMatch(activeElsewhereRow, /chatRehostStoredRoom|chatRenameStoredRoom|chatDeleteStoredRoom/);

console.log("stored rooms UI test: Rehostable, active elsewhere, unavailable, metadata, and escaping states OK");