#!/usr/bin/env node
const assert = require("node:assert/strict");
const fs = require("node:fs");
const vm = require("node:vm");
const ts = require("typescript");

const source = fs.readFileSync(require("node:path").join(__dirname, "../src/ui/next-managed-trial.ts"), "utf8");
const compiled = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
const commands = new Map(), errors = [];
let starts = 0, prompts = 0;
const vscode = {
  workspace: { isTrusted: false },
  commands: { registerCommand(name, handler) { commands.set(name, handler); return { dispose() {} }; } },
  window: {
    async showOpenDialog(options) { return [{ fsPath: options.canSelectFolders ? "/private/trial" : "/private/node" }]; },
    async showWarningMessage() { prompts++; return "Reopen Room"; },
    async showErrorMessage(message) { errors.push(message); },
  },
};
const dependencies = {
  vscode,
  "../runtime/next-managed-client": { NextManagedClient: class { async resumeIsolatedRoom() { starts++; } } },
  "./next-python-environment": { registerNextPythonEnvironment() {} },
  "./next-recipe-workbench": { openManagedRecipeWorkbench() {} },
  "../runtime/memory-migration-authority": {},
  "../chatroom/chatroom-client": {},
  "../chatroom/chat-room-credentials": {},
  "../chatroom/chat-magic-link": {},
  "../chatroom/next-room-recovery": {
    async loadRoomRecoveryPins() { return [{ parent: "/private/trial", roomId: "room-id" }]; },
    async verifyRoomRecoveryCredential() {},
  },
};
const trialModule = { exports: {} };
vm.runInThisContext(`(function(require,module,exports){${compiled}\n})`, { filename: "next-managed-trial.js" })(
  name => Object.hasOwn(dependencies, name) ? dependencies[name] : require(name), trialModule, trialModule.exports);
trialModule.exports.registerNextManagedTrial({ subscriptions: [], secrets: {}, extensionPath: "/extension" }, () => "/private/legacy");
(async () => {
  const start = commands.get("personalKnowledge.nextTrialStart");
  await start();
  assert.equal(starts, 0, "an untrusted workspace must not boot even the Room-only child");
  assert.equal(prompts, 0, "an untrusted workspace must not offer recovery confirmation");
  assert.match(errors[0], /Trusted workspace approval is required/);
  vscode.workspace.isTrusted = true;
  let prompt;
  vscode.window.showWarningMessage = async (message, options, choice) => { prompt = { message, options, choice }; };
  await start({ kind: "chatroom-host", room: "New Room", user: "Host", key: "", port: 0 });
  assert.match(prompt.message, /create another Room/);
  assert.equal(prompt.choice, "Open Trial");
  assert.match(prompt.options.detail, /Other Rooms remain inactive/);
  assert.equal(starts, 0, "cancelling trial confirmation must not start a child");
  console.log("PASS: untrusted workspace cannot start Room recovery");
})().catch(error => { console.error(error); process.exitCode = 1; });
