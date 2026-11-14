"use strict";
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vscode = require("vscode");

exports.run = async () => {
  const fixture = process.env.PKM_PRIVATE_SYNC_UI_FIXTURE;
  assert(/^pkm-native-sync-ui-[a-f0-9-]{36}$/.test(path.basename(fixture)));
  const extension = vscode.extensions.getExtension("uone.personal-knowledge");
  assert(extension && !extension.isActive);
  assert.equal(path.dirname(fs.realpathSync(extension.extensionPath)), path.join(fixture, "x"));
  const manifest = require(path.join(extension.extensionPath, "package.json"));
  const main = require(path.join(extension.extensionPath, manifest.main));
  const activate = main.activate;
  let context;
  main.activate = function (value, ...args) { context = value; return activate.call(this, value, ...args); };
  try {
    await extension.activate();
    assert.equal(context.extension.id.toLowerCase(), "uone.personal-knowledge");
    assert.equal(fs.realpathSync(context.globalStorageUri.fsPath), path.join(fixture, "u/User/globalStorage/uone.personal-knowledge"));
    await context.secrets.store("personalKnowledge.githubSync.vscode.fixture-target",
      JSON.stringify({ accountLabel: "fixture", accessToken: "fixture-token" }));
    await vscode.commands.executeCommand("personalKnowledge.openPanelTab", "githubSync");
    fs.writeFileSync(path.join(fixture, "driver-ready"), "ready", { mode: 0o600 });
    for (let attempt = 0; attempt < 1800 && !fs.existsSync(path.join(fixture, "driver-done")); attempt++)
      await new Promise(resolve => setTimeout(resolve, 100));
    assert(fs.existsSync(path.join(fixture, "driver-done")), "Sync UI driver timed out.");
  } finally { main.activate = activate; }
};
