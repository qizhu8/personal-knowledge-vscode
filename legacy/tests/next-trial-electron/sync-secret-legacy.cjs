"use strict";

const assert = require("node:assert/strict");
const path = require("node:path");
const vscode = require("vscode");

exports.run = async () => {
  const extension = vscode.extensions.getExtension("uone.personal-knowledge");
  assert(extension && !extension.isActive, "Fixture must capture the installed legacy activation context");
  const main = require(path.join(extension.extensionPath, require(path.join(extension.extensionPath, "package.json")).main));
  const original = main.activate;
  let context;
  main.activate = function (value, ...args) { context = value; return original.call(this, value, ...args); };
  try {
    await require("./legacy-upgrade.cjs").run();
    assert(context?.secrets, "Legacy installed extension did not receive SecretStorage");
    await context.secrets.store("personalKnowledge.githubSync.vscode.fixture-target",
      JSON.stringify({ accountLabel: "fixture", accessToken: "fixture-token" }));
    console.log("PASS: stored only a synthetic credential in the installed legacy extension's VS Code SecretStorage.");
  } finally { main.activate = original; }
};
