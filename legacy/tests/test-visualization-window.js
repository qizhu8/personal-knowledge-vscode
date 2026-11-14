const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const Module = require("node:module");

const root = path.join(__dirname, "..");
const chatId = "11111111-1111-4111-8111-111111111111";
const state = { trusted:true, panels:[], commands:new Map(), executed:[] };
const listeners = () => { const set = new Set(); return { set, event:callback => { set.add(callback); return { dispose:() => set.delete(callback) }; } }; };
const vscode = {
  workspace:{ get isTrusted() { return state.trusted; } },
  ViewColumn:{ Active:-1 },
  Uri:{ joinPath:(base, ...parts) => ({ fsPath:path.join(base.fsPath, ...parts), toString() { return this.fsPath; } }) },
  commands:{ registerCommand(id, callback) { state.commands.set(id, callback); return { dispose() {} }; },
    async executeCommand(...args) { state.executed.push(args); } },
  window:{ createWebviewPanel(viewType, title, column, options) {
    const message = listeners(), view = listeners(), disposed = listeners();
    const panel = { viewType, title, options, visible:true, posted:[], revealed:0,
      webview:{ cspSource:"vscode-webview:", html:"", asWebviewUri:uri => `webview:${uri.fsPath}`, async postMessage(value) { panel.posted.push(value); return true; },
        onDidReceiveMessage:message.event },
      onDidChangeViewState:view.event, onDidDispose:disposed.event, reveal() { panel.revealed++; },
      send:value => [...message.set].map(callback => callback(value)), show(visible) { panel.visible = visible; [...view.set].forEach(callback => callback()); },
      dispose() { [...disposed.set].forEach(callback => callback()); }, listeners:{ message, view, disposed } };
    state.panels.push(panel);
    return panel;
  } },
};
const load = Module._load;
Module._load = function (request, ...rest) { return request === "vscode" ? vscode : load.call(this, request, ...rest); };
const { registerVisualizationWindow } = require("../dist/chat/visualization-window");
Module._load = load;

function source() {
  const changes = listeners(), reads = [], opened = [];
  return { reads, changes, opened, onDidChangeRecords:changes.event,
    async openVisualizationTarget(id, sourceUri) {
      opened.push([id, sourceUri]);
      if (!/^[0-9a-f-]{36}$/.test(id)) throw new Error("Choose a valid Chat.");
    },
    visualizationLibrary:() => ({ groups:[{ id:"g", name:"Group" }], chats:[{ id:chatId, title:"Chat", groupId:"g", status:"running" }] }),
    async readVisualization(id, method, params) {
      reads.push([id, method, params]);
      if (method !== "snapshot") throw new Error("Only Harness snapshots and full stored results can be read here.");
      return { sessionId:id };
    } };
}
const settle = () => new Promise(resolve => setImmediate(resolve));

test("Visualization window: one CSP-bound editor panel, trusted reads tagged by Chat, throttled visible-only change pushes, clean disposal", async () => {
  const context = { extensionUri:{ fsPath:root }, subscriptions:[] };
  const records = source();
  registerVisualizationWindow(context, async () => records);
  const command = state.commands.get("personalKnowledge.openVisualizationWindow");
  assert(command, "command registered");
  const manifest = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));
  assert(manifest.contributes.commands.some(item => item.command === "personalKnowledge.openVisualizationWindow"));

  await assert.rejects(command("../not-a-chat"), /Choose a PKM Chat/);
  await command(chatId);
  const [panel] = state.panels;
  assert.equal(panel.viewType, "personalKnowledge.visualization");
  assert.equal(panel.options.retainContextWhenHidden, false);
  assert.deepEqual(panel.options.localResourceRoots.map(uri => uri.fsPath), [path.join(root, "dist", "webview")]);
  assert.doesNotMatch(panel.webview.html, /\{\{\w+\}\}/, "every template slot is filled");
  const nonce = /nonce="([^"]+)"/.exec(panel.webview.html)[1];
  assert.match(panel.webview.html, new RegExp(`script-src 'nonce-${nonce.replace(/[+/=]/g, "\\$&")}'`));
  assert.equal((panel.webview.html.match(/<script /g) || []).length, (panel.webview.html.match(new RegExp(`nonce="${nonce.replace(/[+/=]/g, "\\$&")}"`, "g")) || []).length);

  panel.send({ type:"ready" });
  await settle();
  assert.deepEqual(panel.posted.at(-1).select, chatId, "the requesting Chat is preselected once");
  panel.send({ type:"ready" });
  await settle();
  assert.equal(panel.posted.at(-1).select, undefined, "a recreated webview restores from its own state, not a stale request");

  panel.send({ type:"request", requestId:"r1", chatId, method:"snapshot", params:{} });
  panel.send({ type:"request", requestId:"r2", chatId, method:"write", params:{} });
  await settle(); await settle();
  assert.deepEqual(panel.posted.find(item => item.requestId === "r1"), { type:"result", requestId:"r1", chatId, data:{ sessionId:chatId } });
  assert.match(panel.posted.find(item => item.requestId === "r2").error, /Only Harness snapshots/);
  state.trusted = false;
  panel.send({ type:"request", requestId:"r3", chatId, method:"snapshot", params:{} });
  await settle();
  assert.match(panel.posted.find(item => item.requestId === "r3").error, /Trust this workspace/);
  assert.equal(records.reads.length, 2, "untrusted reads never reach the record store");
  await assert.rejects(command(chatId), /Trust this workspace/);
  state.trusted = true;

  const before = panel.posted.length;
  for (let index = 0; index < 5; index++) [...records.changes.set].forEach(callback => callback());
  await new Promise(resolve => setTimeout(resolve, 450));
  assert.equal(panel.posted.length - before, 1, "bursts of record writes collapse into one library push");
  assert.equal(panel.posted.at(-1).changed, true);
  panel.visible = false;
  [...records.changes.set].forEach(callback => callback());
  await new Promise(resolve => setTimeout(resolve, 450));
  assert.equal(panel.posted.length - before, 1, "hidden windows are not refreshed");
  panel.show(true);
  await new Promise(resolve => setTimeout(resolve, 450));
  assert.equal(panel.posted.length - before, 2, "becoming visible catches up once");

  await command(chatId);
  assert.equal(state.panels.length, 1, "a second open reveals the same window");
  assert.equal(panel.revealed, 1);
  assert.deepEqual(panel.posted.at(-1), { type:"select", chatId });

  panel.send({ type:"openChat", chatId });
  panel.send({ type:"openChat", chatId:"x" });
  panel.send({ type:"openSource", chatId, sourceUri:"pkm://knowledge/knowledge_ab" });
  await settle();
  assert.deepEqual(records.opened, [[chatId, undefined], ["x", undefined], [chatId, "pkm://knowledge/knowledge_ab"]],
    "navigation goes through the source, which builds the full pkm://chats locator");
  assert.deepEqual(panel.posted.filter(item => item.type === "notice"), [{ type:"notice", message:"Choose a valid Chat." }],
    "navigation failures are shown, not swallowed");
  assert.deepEqual(state.executed, []);

  panel.dispose();
  assert.equal(records.changes.set.size, 0, "record subscription released");
  assert.equal(panel.listeners.message.set.size, 0);
  await command();
  assert.equal(state.panels.length, 2, "a closed window can be reopened");
  for (const item of context.subscriptions) item.dispose();
  assert.equal(records.changes.set.size, 0);
});
