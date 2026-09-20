#!/usr/bin/env node
const assert = require("assert");
const fs = require("fs");
const path = require("path");
const vm = require("vm");

const root = path.join(__dirname, "..");
const panel = fs.readFileSync(path.join(root, "dist", "webview", "panel.js"), "utf8");
const extension = fs.readFileSync(path.join(root, "src", "extension.ts"), "utf8");
const manifest = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));
const calls = [];
const askCommands = new Set();
let captured = [];

function event() { return { clientX: 1, clientY: 2, preventDefault() {}, stopPropagation() {} }; }
function invoke(items) {
  for (const item of items) {
    if (item.children) invoke(item.children);
    if (typeof item.onClick === "function") item.onClick();
  }
}
function slice(startMarker, endMarker) {
  const start = panel.indexOf(startMarker);
  const end = panel.indexOf(endMarker, start);
  assert(start >= 0 && end > start, `missing executable menu source: ${startMarker}`);
  return panel.slice(start, end);
}

const common = {
  console, Map, Set, URL, JSON, encodeURIComponent, decodeURIComponent,
  btoa: value => Buffer.from(String(value), "binary").toString("base64"),
  atob: value => Buffer.from(String(value), "base64").toString("binary"),
  escape, unescape,
  ask: (command, payload) => { askCommands.add(command); calls.push({ command, payload }); },
  showPaperMenu: (_x, _y, items) => { captured = items; },
  copyPathMenu: value => ({ label: "Copy Path", onClick: () => calls.push({ command: "copyText", payload: { text: value } }) }),
  appendPrivacyMenu: (items, type, value) => items.push({ label: "Set as Private", onClick: () => calls.push({ command: "contentSetPrivacy", payload: { type, value } }) }),
  pkModal: options => { calls.push({ command: "modal", payload: { title: options.title } }); options.onOk?.("Target", "Body", true); },
  openMarkdownItem: (...args) => calls.push({ command: "openMarkdownItem", payload: args }),
  editMarkdownMetadataItem: (...args) => calls.push({ command: "editMarkdownMetadataItem", payload: args }),
  confirmDeletePackage: name => calls.push({ command: "packageDelete", payload: { name } }),
  paperGroupsList: [{ name: "Papers" }, { name: "Research" }],
  notePinnedFolders: [],
};

const knowledge = vm.createContext({ ...common });
new vm.Script(`${slice("function paperCardMenu(", "// First confirmation:")};this.menus={paperCardMenu,paperGroupMenu,paperFolderMenu,promptFolderMenu,promptItemTrashMenu,skillFolderMenu,skillItemMenu,noteFolderMenu,scriptFolderMenu,scriptItemMenu,packageItemMenu};`).runInContext(knowledge);
const encodedSlugs = Buffer.from(unescape(encodeURIComponent(JSON.stringify(["Research/Paper"]))), "binary").toString("base64");
const encodedFolder = value => Buffer.from(unescape(encodeURIComponent(value)), "binary").toString("base64");
const knowledgeCases = [
  ["paperCardMenu", [event(), "Research/Paper", "Papers", false, "Research"]],
  ["paperGroupMenu", [event(), "Research"]],
  ["paperFolderMenu", [event(), encodedSlugs, "Research", "Research"]],
  ["promptFolderMenu", [event(), "Project", "Task", "v1"]],
  ["promptItemTrashMenu", [event(), "Project/Task/v1/prompt.md", "prompt.md", "Project", "Task", "v1"]],
  ["skillFolderMenu", [event(), encodedFolder("Coding/TypeScript"), "TypeScript"]],
  ["skillItemMenu", [event(), "Testing", "Coding/TypeScript"]],
  ["noteFolderMenu", [event(), encodedFolder("Research/RAG"), "RAG"]],
  ["scriptFolderMenu", [event(), encodedFolder("Scope/Checks"), "Checks"]],
  ["scriptItemMenu", [event(), "Scope/Checks/query.script", "Scope/Checks"]],
  ["packageItemMenu", [event(), "demo-package"]],
];
for (const [name, args] of knowledgeCases) {
  captured = [];
  knowledge.menus[name](...args);
  assert(captured.length, `${name} must create menu actions`);
  assert.doesNotThrow(() => invoke(captured), `${name} actions must execute`);
}

const note = vm.createContext({
  ...common,
  state: { items: [{ slug: "Research/Test", category: "Research" }] },
  openItem: (...args) => calls.push({ command: "openItem", payload: args }),
  copyContextPath: value => calls.push({ command: "copyText", payload: { text: value } }),
});
new vm.Script(`${slice("function noteContextMenuItems(", "// Right-click blank space")};this.menu=noteContextMenuItems;`).runInContext(note);
assert.doesNotThrow(() => invoke(note.menu("Research/Test", false)), "Note actions must execute");

const blank = vm.createContext({ ...common });
new vm.Script(`${slice("function blankContextMenuItems(", "document.addEventListener('click',")};this.menu=blankContextMenuItems;`).runInContext(blank);
for (const area of ["skills", "notes", "papers", "prompts", "scripts"]) {
  assert.doesNotThrow(() => invoke(blank.menu(area)), `${area} blank-area actions must execute`);
}

const chatMessage = vm.createContext({
  ...common,
  chatMessageById: () => ({ text: "Message body" }),
  chatQuoteMessage: id => calls.push({ command: "chatQuoteMessage", payload: { id } }),
  chatOpenMessageViewer: id => calls.push({ command: "chatOpenMessageViewer", payload: { id } }),
  navigator: { clipboard: { writeText: text => { calls.push({ command: "clipboard", payload: { text } }); return Promise.resolve(); } } },
  vscode: { postMessage: message => calls.push({ command: message.command, payload: message }) },
});
new vm.Script(`${slice("function chatMessageMenu(", "function chatPaintMode(")};this.menu=chatMessageMenu;`).runInContext(chatMessage);
captured = []; chatMessage.menu(event(), "message-id"); assert.doesNotThrow(() => invoke(captured), "Chat message actions must execute");

const chat = vm.createContext({ ...common });
new vm.Script(`${slice("function chatActiveRoomMenu(", "function chatPaintActive(")};this.menus={chatActiveRoomMenu,chatStoredRoomMenu,chatActiveElsewhereRoomMenu};`).runInContext(chat);
for (const [name, args] of [
  ["chatActiveRoomMenu", [event(), "room-key", "room-id", "Room"]],
  ["chatStoredRoomMenu", [event(), "room-id", "Room"]],
  ["chatActiveElsewhereRoomMenu", [event(), "room-id", "Room"]],
]) {
  captured = []; chat.menus[name](...args); assert.doesNotThrow(() => invoke(captured), `${name} actions must execute`);
}

const subscribed = vm.createContext({
  ...common,
  state: { tab: "notes" },
  subscriptionDecodeForkPayload: value => JSON.parse(decodeURIComponent(escape(Buffer.from(value, "base64").toString("binary")))),
  subscriptionFork: key => calls.push({ command: "subscriptionFork", payload: { key } }),
});
new vm.Script(`${slice("function subscriptionFolderForkMenu(", "function subscriptionForkAll(")};this.menus={subscriptionFolderForkMenu,subscriptionItemForkMenu,subscriptionGroupForkMenu};`).runInContext(subscribed);
const encodePayload = value => Buffer.from(unescape(encodeURIComponent(JSON.stringify(value))), "binary").toString("base64");
for (const [name, value, expectedPath] of [
  ["subscriptionItemForkMenu", { key: "opaque", title: "Remote Note", subscriptionId: "sub-item", pkmPath: "pkm://subscriptions/node-1/share-1/notes/Team/Remote%20Note.md" }, "pkm://subscriptions/node-1/share-1/notes/Team/Remote%20Note.md"],
  ["subscriptionFolderForkMenu", { path: "Team", keys: ["opaque"], subscriptionId: "sub-folder", pkmPath: "pkm://subscriptions/node-1/share-1/notes/Team" }, "pkm://subscriptions/node-1/share-1/notes/Team"],
]) {
  captured = []; subscribed.menus[name](event(), encodePayload(value)); invoke(captured);
  assert(calls.some(call => call.command === "copyText" && call.payload.text === expectedPath), `${name} must copy its canonical subscribed path`);
}
assert(calls.some(call => call.command === "subscriptionRefresh" && call.payload.id === "sub-item" && call.payload.force === true));
assert(calls.some(call => call.command === "subscriptionRefresh" && call.payload.id === "sub-folder" && call.payload.force === true));

const server = vm.createContext({
  ...common,
  serverCache: [{ slug: "api", name: "API", category: "Team" }],
  serverGroupPaths: ["Team", "Research"],
  serverPathPrivate: () => false,
  moveServerToGroup: (slug, group) => calls.push({ command: "moveServerToGroup", payload: { slug, group } }),
  createAndMoveServerGroup: slug => calls.push({ command: "createAndMoveServerGroup", payload: { slug } }),
});
new vm.Script(`${slice("function serverCardMenu(", "function renderServerGroupNode(")};this.menus={serverCardMenu,serverGroupMenu};`).runInContext(server);
for (const [name, args] of [["serverCardMenu", [event(), "api"]], ["serverGroupMenu", [event(), "Team"]]]) {
  captured = []; server.menus[name](...args); assert.doesNotThrow(() => invoke(captured), `${name} actions must execute`);
}

const subscription = vm.createContext({
  ...common,
  subscriptionRename: (...args) => calls.push({ command: "subscriptionRename", payload: args }),
});
new vm.Script(`${slice("function subscriptionBrokerMenu(", "function renderSubscriptionPane(")};this.menu=subscriptionBrokerMenu;`).runInContext(subscription);
const brokerPayload = encodePayload({ id: "sub-1", name: "Broker", alias: "Alias", nodeId: "node-1", shareId: "share-1" });
captured = []; subscription.menu(event(), brokerPayload); assert.doesNotThrow(() => invoke(captured), "Subscription actions must execute");
assert(calls.some(call => call.command === "subscriptionRefresh" && call.payload.id === "sub-1" && call.payload.force === true),
  "Subscriber right-click Refresh must force a Broker metadata and snapshot check");

for (const required of ["copyText", "noteMove", "knowledgeTrashMove", "skillMove", "scriptMove", "contentSetPrivacy", "chatRehostStoredRoom", "chatForceCloseHostedRoom", "subscriptionRefresh"]) {
  assert(calls.some(call => call.command === required), `executed menu suite must dispatch ${required}`);
}
assert(calls.filter(call => call.command === "copyText").length >= 15, "every folder/document menu must execute Copy Path");

const nativeCommands = [...new Set(manifest.contributes.menus["view/item/context"].map(item => item.command))];
for (const command of nativeCommands) {
  assert(extension.includes(`registerCommand("${command}"`), `native menu command is not registered: ${command}`);
}

for (const command of askCommands) {
  assert(extension.includes(`case "${command}"`), `webview menu command has no extension handler: ${command}`);
}

console.log(`context menu action test: executed ${knowledgeCases.length + 13} menu builders, ${calls.length} actions, ${askCommands.size} webview handlers, and ${nativeCommands.length} native commands OK`);
