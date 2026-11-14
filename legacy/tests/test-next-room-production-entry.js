#!/usr/bin/env node
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const ts = require("typescript");

const panel = fs.readFileSync(path.join(__dirname, "../src/webview/panel/10-chatroom.js"), "utf8");
const formFunction = panel.slice(panel.indexOf("function chatHostIsolatedNextRoom()"), panel.indexOf("function chatGenKey()"));
const fields = Object.fromEntries([
  ["chat-hub-room", { value: " Studio " }], ["chat-hub-name", { value: " Alice " }],
  ["chat-hub-key", { value: " secret " }], ["chat-hub-port", { value: "7351" }],
  ["chat-host-form", { classList: { add() {} } }],
]);
const requests = [], errors = [];
const form = vm.createContext({
  document: { getElementById: id => fields[id] },
  ask: (command, payload) => requests.push({ command, payload }),
  chatToast: message => errors.push(message),
});
vm.runInContext(`${formFunction}\nchatHostIsolatedNextRoom()`, form);
assert.deepEqual(JSON.parse(JSON.stringify(requests[0])), {
  command: "chatStartNextIsolated", payload: { room: "Studio", user: "Alice", key: "secret", port: 7351 },
});
assert.equal(fields["chat-hub-key"].value, "", "the form clears its secret");
fields["chat-hub-port"].value = "123bad";
vm.runInContext("chatHostIsolatedNextRoom()", form);
assert.equal(requests.length, 1, "invalid ports do not start a Room");
assert.match(errors[0], /port/i);

const source = fs.readFileSync(path.join(__dirname, "../src/ui/next-managed-trial.ts"), "utf8");
const compiled = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
const commands = new Map(), uiErrors = [], inputs = [], created = [];
let starts = 0, closed = 0;
const vscode = {
  workspace: { isTrusted: false },
  commands: { registerCommand(name, handler) { commands.set(name, handler); return { dispose() {} }; } },
  window: {
    async showOpenDialog(options) { return [{ fsPath: options.canSelectFolders ? "/private/trial" : "/private/node" }]; },
    async showWarningMessage(message) { return message.startsWith("Create a disposable") ? "Create Trial" : "Host Isolated Room"; },
    async showErrorMessage(message) { uiErrors.push(message); },
    async showInformationMessage() {},
    async showInputBox(options) { inputs.push(options); return options.value; },
    async showQuickPick(items) {
      if (items.includes("Require participant credential to restore an identity")) return items[0];
      if (items.includes("Stop Host")) return "Stop Host";
      throw new Error("Unexpected picker");
    },
    createOutputChannel() { return { appendLine() {}, show() {}, dispose() {} }; },
  },
};
class Client {
  async start() { starts++; }
  savedRoomChoices() { return []; }
  async createIsolatedRoom(...args) {
    created.push(args);
    return { roomId: "room-id", room: args[0], url: "ws://127.0.0.1:7351", secret: args[2], hostToken: "host" };
  }
  nativeRoomHostName() { return "Alice"; }
  isStopped() { return false; }
  async closeIsolatedRoom() { closed++; }
}
class Peer {
  constructor(events) { this.events = events; }
  connect() { this.isConnected = true; this.events.onStatus("connected"); }
  disconnect() { this.isConnected = false; }
}
const deps = {
  vscode, "../runtime/next-managed-client": { NextManagedClient: Client },
  "./next-python-environment": { registerNextPythonEnvironment() {} },
  "./next-recipe-workbench": { openManagedRecipeWorkbench() {} },
  "../runtime/memory-migration-authority": {}, "../chatroom/chatroom-client": { ChatClient: Peer },
  "../chatroom/chat-room-credentials": {}, "../chatroom/chat-magic-link": {},
  "../chatroom/next-room-recovery": { async loadRoomRecoveryPins() { return []; } },
};
const moduleUnderTest = { exports: {} };
vm.runInThisContext(`(function(require,module,exports){${compiled}\n})`)(
  name => Object.hasOwn(deps, name) ? deps[name] : require(name), moduleUnderTest, moduleUnderTest.exports);
moduleUnderTest.exports.registerNextManagedTrial({ subscriptions: [], secrets: {}, extensionPath: "/extension" }, () => "/private/legacy");
const intent = { kind: "chatroom-host", ...requests[0].payload };
(async () => {
  const start = commands.get("personalKnowledge.nextTrialStart");
  await start(intent);
  assert.equal(starts, 0, "an untrusted form cannot start a child");
  assert.match(uiErrors.pop(), /Trusted workspace/);
  vscode.workspace.isTrusted = true;
  await start(intent);
  assert.equal(starts, 1);
  assert.deepEqual(inputs.map(item => item.value), ["Studio", "Alice", "secret", "7351"]);
  assert.equal(inputs[2].password, true);
  assert.deepEqual(created[0].slice(0, 3), ["Studio", "Alice", "secret"]);
  assert.equal(created[0][5], "proof-required", "the entry does not weaken the selected recovery policy");
  assert.equal(created[0][7], 7351);
  assert.equal(closed, 1);
  await start(intent);
  assert.equal(starts, 1, "an existing isolated trial is reused instead of opening another child");
  assert.equal(created.length, 2);
  assert.equal(closed, 2);
  assert.deepEqual(uiErrors, []);
  console.log("PASS: Chatroom form routes to an explicitly confirmed isolated Room");
})().catch(error => { console.error(error); process.exitCode = 1; });
