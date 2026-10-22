#!/usr/bin/env node
const assert = require("assert");
const fs = require("fs");
const path = require("path");
const vm = require("vm");
const { PortalConnectionJournal, endpointLabel, endpointScope } = require("../dist/chatroom/portal-connections");

const root = path.join(__dirname, "..");
const chatA = "11111111-1111-4111-8111-111111111111";
const chatB = "22222222-2222-4222-8222-222222222222";
const peerChat = "33333333-3333-4333-8333-333333333333";
let clock = 1_000_000;
const saves = [];
const journal = new PortalConnectionJournal(undefined, records => saves.push(records), () => clock);
const owner = (chatId, chatLabel) => ({ chatId, chatLabel, external: false, localMachine: "linux-box", endpoint: "ws://127.0.0.1:7345" });
const binding = (pairId, role, extra = {}) => ({ pairId, role, peerName: "Windows", peerMachine: "DESKTOP-56TITCC", peerChatId: peerChat, peerChatName: "windows debug", ...extra });

// Pairing records who is connected to whom; secret-bearing URL parts never reach storage.
journal.observe(owner(chatA, "Portal: windows debug"), binding("pair-1", "controller", { peerEndpoint: "ws://10.0.0.5:7345/room?token=SECRET#frag" }));
assert.equal(saves.length, 1);
assert.equal(saves[0][0].endpoint, "ws://10.0.0.5:7345");
assert(!JSON.stringify(saves).includes("SECRET"), "tokens in endpoint URLs must never be stored");
assert.equal(endpointLabel("not a url?x=1"), "not a url");

let live = new Map([[chatA, { pairId: "pair-1", connected: true }]]);
let snapshot = journal.snapshot(live, new Set());
assert.equal(snapshot.active, 1);
assert.deepEqual(snapshot.connections.map(item => [item.chatId, item.state, item.role, item.peerMachine]), [[chatA, "active", "controller", "DESKTOP-56TITCC"]]);

// Transport drop keeps the binding: reconnecting, not ended.
snapshot = journal.snapshot(new Map([[chatA, { pairId: "pair-1", connected: false }]]), new Set());
assert.equal(snapshot.connections[0].state, "reconnecting");
assert.equal(snapshot.active, 0);

// A role switch updates the same pairing instead of duplicating it.
clock += 1000;
journal.observe(owner(chatA, "Portal: windows debug"), binding("pair-1", "controlled"));
assert.equal(journal.snapshot(live, new Set()).connections.length, 1);
assert.equal(journal.snapshot(live, new Set()).connections[0].role, "controlled");

// Second Chat paired with someone else; then Chat A disconnects and becomes resumable history.
clock += 1000;
journal.observe(owner(chatB, "Sync review"), binding("pair-2", "controlled", { peerMachine: "mac-mini", peerChatName: "review" }));
clock += 1000;
journal.observe(owner(chatA, "Portal: windows debug"), undefined);
live = new Map([[chatA, { connected: false }], [chatB, { pairId: "pair-2", connected: true }]]);
snapshot = journal.snapshot(live, new Set([chatA]));
assert.deepEqual(snapshot.connections.map(item => [item.pairId, item.state, item.resumable]), [["pair-2", "active", false], ["pair-1", "ended", true]]);
assert.equal(snapshot.connections[1].endedAt, clock);

// A new pairing for Chat A ends any older open record, and only the newest record of a Chat offers re-attach.
clock += 1000;
journal.observe(owner(chatA, "Portal: windows debug"), binding("pair-3", "controller"));
clock += 1000;
journal.observe(owner(chatA, "Portal: windows debug"), undefined);
snapshot = journal.snapshot(new Map(), new Set([chatA]));
assert.deepEqual(snapshot.connections.filter(item => item.chatId === chatA).map(item => [item.pairId, item.resumable]), [["pair-3", true], ["pair-1", false]]);

// Records from a previous VS Code session are never shown as live, and corrupt storage is dropped.
const restored = new PortalConnectionJournal([...saves.at(-1), { pairId: "x" }, null, { ...saves.at(-1)[0], role: "admin" }], () => {}, () => clock);
assert.equal(restored.snapshot(new Map(), new Set()).connections.length, 3);
assert(restored.snapshot(new Map(), new Set()).connections.every(item => item.state === "ended"));
assert.equal(restored.forget("pair-1"), true);
assert.equal(restored.forget("missing"), false);
assert.equal(restored.snapshot(new Map(), new Set()).connections.length, 2);

// History is bounded.
const bounded = new PortalConnectionJournal(undefined, () => {}, () => ++clock);
for (let index = 0; index < 230; index++) bounded.observe(owner(chatA, "loop"), binding(`p-${index}`, "controller"));
assert.equal(bounded.snapshot(new Map(), new Set()).connections.length, 200);

// Webview renders live and historical rows with who ↔ whom, and only ended rows can be removed.
const uiSource = fs.readFileSync(path.join(root, "src", "webview", "panel", "16-portal-connections.js"), "utf8");
const detail = { style: {}, innerHTML: "" };
const asks = [];
const ui = {
  document: { getElementById: id => id === "detail" ? detail : null },
  state: { tab: "portalConnections" },
  esc: value => String(value ?? "").replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;"),
  ask: (...args) => asks.push(args),
  Date, Number, JSON, Array,
};
vm.createContext(ui);
vm.runInContext(`${uiSource};this.onSnapshot=portalConnectionsOnSnapshot;this.show=showPortalConnectionsTab`, ui);
ui.show();
assert.match(detail.innerHTML, /Loading Portal connections/);
assert.deepEqual(asks.at(-1), ["portalConnections", {}]);
ui.onSnapshot(journal.snapshot(new Map([[chatB, { pairId: "pair-2", connected: true }]]), new Set([chatA])));
const html = detail.innerHTML;
assert.match(html, /1 active/);
const [liveHtml, historyHtml] = html.split("History");
assert.match(liveHtml, /linux-box[\s\S]*Sync review[\s\S]*controlled by[\s\S]*mac-mini[\s\S]*review/);
assert.doesNotMatch(liveHtml, /Remove/);
assert.match(historyHtml, /DESKTOP-56TITCC[\s\S]*windows debug/);
assert.match(historyHtml, /re-attach available/);
assert.match(historyHtml, /portalConnectionForget/);
assert.match(historyHtml, /controls/);
ui.onSnapshot({ connections: [], pendingInvitations: [{ chatId: chatA, chatLabel: "Pending Chat", role: "controller", expiresAt: Date.now() + 60_000, endpoint: "ws://localhost:7345" }] });
assert.match(detail.innerHTML, /Copy magic link/);
assert.match(detail.innerHTML, /portalConnectionCopyMagicLink/);
assert.match(detail.innerHTML, /Pending Chat/);
assert.doesNotMatch(detail.innerHTML, /pkmportal:/, "the link itself never enters webview state or markup");
ui.onSnapshot({ connections: [], pendingInvitations: [{ chatId: chatA, chatLabel: "Expired", expiresAt: Date.now() - 1 }] });
assert.doesNotMatch(detail.innerHTML, /Copy magic link/);
ui.onSnapshot(null);
assert.match(detail.innerHTML, /No Portal is connected right now/);
assert.match(detail.innerHTML, /No past Portal connections/);
ui.onSnapshot({ connections: [{ ...snapshot.connections[0], chatLabel: "<img src=x onerror=alert(1)>", state: "ended" }] });
assert.doesNotMatch(detail.innerHTML, /<img/, "labels are escaped");

// Host and navigation wiring.
const read = file => fs.readFileSync(path.join(root, file), "utf8");
const extension = read("src/extension.ts");
assert.match(read("src/webview/panel.html"), /data-tab="portalConnections">Portal Connections/);
assert.match(read("src/webview/panel/00-core.js"), /projects:\[[^\]]*'portalConnections'/);
assert.match(read("src/webview/panel/00-core.js"), /command === 'portalConnections'[\s\S]{0,80}portalConnectionsOnSnapshot/);
assert.match(read("src/webview/panel/20-knowledge.js"), /state\.tab === 'portalConnections'[\s\S]{0,180}showPortalConnectionsTab/);
assert.match(read("scripts/build-panel.js"), /"16-portal-connections\.js"/);
assert.match(extension, /case "portalConnections":[\s\S]{0,120}portalConnectionHistory\(\)/);
assert.match(extension, /changed: \(\) => \{[\s\S]{0,400}portalJournal\?\.observe\(/);
assert.match(extension, /configurePortalJournal\(context\.globalState\)/);
assert.match(extension, /case "portalConnectionForget"[\s\S]{0,200}forgetPortalConnection/);
assert.match(extension, /Disconnect this Portal before removing it/);
assert.match(read("src/chat/api-chat-view.ts"), /openPkmChat\(locator: string\)[\s\S]{0,120}\[a-f0-9-\]\{36\}/);
// G3: endpoint reachability labels.
for (const [endpoint, scope] of [["ws://127.0.0.1:7345", "forwarded-localhost"], ["ws://localhost:1", "forwarded-localhost"], ["ws://[::1]:9", "forwarded-localhost"],
  ["wss://10.1.2.3:443", "lan"], ["wss://192.168.0.4", "lan"], ["wss://172.20.0.1", "lan"], ["wss://172.40.0.1", "remote"], ["wss://desktop-56titcc", "lan"],
  ["wss://box.local", "lan"], ["wss://pkm.example.com", "remote"], ["not a url", "unknown"], [undefined, "unknown"]]) assert.equal(endpointScope(endpoint), scope, String(endpoint));

// G1/G2/G4 host wiring: open waits for pairing, external grants are bound to pair+role, links stay in memory.
assert.match(extension, /if \(operation === "open"\) \{\s*await this\.managePeer\(context, entry\);\s*if \(args\.wait !== false\) await this\.waitForPortalPairing\(entry\);/);
assert.match(extension, /await this\.managePeer\(context, owner\);\s*if \(args\.wait !== false\) await this\.waitForPortalPairing/);
assert.match(extension, /state: connected \? "connected" : pending \? "awaiting-peer"/);
assert.match(extension, /binding\.pairId !== grant\.pairId \|\| binding\.role !== grant\.role/);
assert.match(extension, /if \(external && !this\.externalAuthorized\(id\)\)/);
assert.match(extension, /state !== announced && current\?\.external\) void this\.offerExternalAuthorization/);
assert.match(extension, /portalPendingLinks\.set\(owner\.id, \{ link, expiresAt: pendingInvitation\.expiresAt, endpoint: url \}\)/);
assert.doesNotMatch(extension, /log\.\w+\([^)]*pending(?:Links|Link)\.get/, "pending links are never logged");
assert.match(extension, /registerCommand\("personalKnowledge\.portalPendingLink"/);
assert.match(read("src/chat/api-chat-view.ts"), /case "portalPendingLink":[\s\S]{0,240}message\.value !== "copy" && message\.value !== "void"/);
assert.match(read("resources/api_chat_control.py"), /open completes after pairing, link expiry or void/);
// Two VS Code windows share one globalState key: neither may erase or resurrect the other's records.
{
  let shared;
  const store = { get: () => shared, set: value => { shared = value; } };
  const alive = new Set(["window-a", "window-b"]);
  const left = new PortalConnectionJournal(undefined, store.set, () => clock, store.get, "window-a", id => alive.has(id));
  const right = new PortalConnectionJournal(undefined, store.set, () => clock, store.get, "window-b", id => alive.has(id));
  const owner = chatId => ({ chatId, chatLabel: chatId, external: false, localMachine: "linux" });
  left.observe(owner("chat-a"), { pairId: "pair-a", role: "controller", peerName: "win" });
  right.observe(owner("chat-b"), { pairId: "pair-b", role: "controlled", peerName: "mac" });
  assert.deepEqual(shared.map(item => item.pairId).sort(), ["pair-a", "pair-b"]);
  left.observe(owner("chat-a"), undefined);
  assert.deepEqual(shared.map(item => item.pairId).sort(), ["pair-a", "pair-b"]);
  assert.ok(shared.find(item => item.pairId === "pair-a").endedAt);
  assert.ok(!shared.find(item => item.pairId === "pair-b").endedAt, "ending in one window never ends another window's binding");
  const seenFromLeft = left.snapshot(new Map(), new Set()).connections;
  assert.equal(seenFromLeft.find(item => item.pairId === "pair-b").state, "elsewhere");
  alive.delete("window-b");
  assert.equal(left.snapshot(new Map(), new Set()).connections.find(item => item.pairId === "pair-b").state, "ended", "a window without a heartbeat is not trusted as live");
  assert.equal(right.snapshot(new Map([["chat-b", { pairId: "pair-b", connected: true }]]), new Set()).connections.find(item => item.pairId === "pair-b").state, "active");
  assert.equal(right.forget("pair-a"), true);
  left.rename("chat-a", "renamed");
  assert.deepEqual(shared.map(item => item.pairId), ["pair-b"], "a record forgotten in one window is not resurrected by another");
}

console.log("portal connections test: journal, live state, history, UI and wiring OK");

require("node:test").test("unpaired invitations are discoverable without exposing secrets and copy revalidates current state", async () => {
  const ts = require("typescript");
  const ast = ts.createSourceFile("extension.ts", extension, ts.ScriptTarget.Latest, true);
  const manager = ast.statements.find(node => ts.isClassDeclaration(node) && node.name?.text === "ChatRoomManager");
  const methods = ["portalConnectionHistory", "portalPendingLink"].map(name => manager.members.find(node => node.name?.getText(ast) === name).getText(ast));
  const copied = [];
  let trusted = true, currentRoot = "root";
  const context = vm.createContext({
    Map, Set, Date, getStorePath: () => currentRoot, portalChanged: () => {},
    vscode: { workspace: { get isTrusted() { return trusted; } }, env: { clipboard: { writeText: async link => copied.push(link) } },
      window: { setStatusBarMessage: () => {} } },
  });
  vm.runInContext(ts.transpileModule(`class Host { ${methods.join("\n")} }; globalThis.Host = Host;`,
    { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText, context);
  const host = new context.Host();
  host.portalResumable = new Map();
  const peer = { pendingInvitation: { role: "controller", expiresAt: Date.now() + 60_000 } };
  const entry = { id: chatA, label: "Forgotten link", root: "root", external: false, room: { peer, client: { isConnected: true } } };
  host.chatPortals = new Map([[chatA, entry]]);
  host.portalPendingLinks = new Map([[chatA, { link: "pkmportal:v1:PRIVATE", expiresAt: peer.pendingInvitation.expiresAt, endpoint: "ws://localhost:7345" }]]);
  const pending = host.portalConnectionHistory();
  assert.equal(pending.connections.length, 0);
  assert.equal(pending.pendingInvitations[0].chatId, chatA);
  assert(!JSON.stringify(pending).includes("PRIVATE"));
  await host.portalPendingLink(chatA, "copy");
  assert.deepEqual(copied, ["pkmportal:v1:PRIVATE"]);
  trusted = false;
  await assert.rejects(host.portalPendingLink(chatA, "copy"), /context changed/);
  trusted = true; currentRoot = "another-root";
  await assert.rejects(host.portalPendingLink(chatA, "copy"), /context changed/);
  currentRoot = "root";
  host.portalPendingLinks.get(chatA).expiresAt = Date.now() - 1;
  assert.equal(host.portalConnectionHistory().pendingInvitations.length, 0);
  await assert.rejects(host.portalPendingLink(chatA, "copy"), /no longer available/);
  peer.pendingInvitation = undefined;
  await assert.rejects(host.portalPendingLink(chatA, "copy"), /no unredeemed/);
  assert.equal(copied.length, 1);
});
