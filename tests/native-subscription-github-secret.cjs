"use strict";
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vscode = require("vscode");

exports.run = async () => {
  const fixture = process.env.PKM_TEST_GITHUB_FIXTURE;
  assert(fixture && /^pkm-native-subscription-ui-[a-f0-9-]{36}$/.test(path.basename(fixture)));
  assert.equal(fs.realpathSync(fixture), fixture);
  assert.equal(process.env.PKM_PRIVATE_NATIVE_SUBSCRIPTION, "1");
  const extension = vscode.extensions.getExtension("uone.personal-knowledge");
  assert(extension && !extension.isActive);
  assert.equal(path.dirname(fs.realpathSync(extension.extensionPath)), path.join(fixture, "x"));
  const manifest = require(path.join(extension.extensionPath, "package.json"));
  const main = require(path.join(extension.extensionPath, manifest.main));
  const original = main.activate;
  let context;
  main.activate = function (value, ...args) { context = value; return original.call(this, value, ...args); };
  try {
    await extension.activate();
    assert.equal(context.extension.id.toLowerCase(), "uone.personal-knowledge");
    assert.equal(fs.realpathSync(context.globalStorageUri.fsPath),
      path.join(fixture, "u", "User", "globalStorage", "uone.personal-knowledge"));
    await context.secrets.store("personalKnowledge.githubSync.vscode.account-alice",
      JSON.stringify({ accountLabel: "alice", accessToken: "synthetic-github-host-token-12345" }));
    assert.ok(await context.secrets.get("personalKnowledge.githubSync.vscode.account-alice"));
    await vscode.commands.executeCommand("personalKnowledge.openSubscriptions");
    const ready = path.join(fixture, "driver-ready"), done = path.join(fixture, "github-test-done");
    fs.writeFileSync(ready, "ready", { mode: 0o600 });
    for (let attempt = 0; attempt < 1200 && !fs.existsSync(done); attempt++)
      await new Promise(resolve => setTimeout(resolve, 100));
    assert.ok(fs.existsSync(done), "Private UI driver did not finish");
  } finally { main.activate = original; }
};
