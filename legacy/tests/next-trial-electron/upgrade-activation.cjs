"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const childProcess = require("node:child_process");
const vscode = require("vscode");

exports.run = async () => {
  const extension = vscode.extensions.getExtension("uone.personal-knowledge");
  const root = process.env.PKM_TRIAL_ELECTRON_LEGACY;
  assert(extension);
  assert.equal(fs.realpathSync(extension.extensionPath), fs.realpathSync(process.env.PKM_TRIAL_ELECTRON_EXTENSION));
  const originalFork = childProcess.fork, originalPicker = vscode.window.showOpenDialog;
  const nextChildren = [];
  childProcess.fork = function (file, ...args) {
    if (String(file).includes("next-runtime")) nextChildren.push(file);
    return originalFork.call(this, file, ...args);
  };
  vscode.window.showOpenDialog = async () => { throw new Error("Upgrade must reuse the configured root without asking for a path"); };
  try {
    await extension.activate();
    const store = require(path.join(extension.extensionPath, "dist/knowledge/filestore.js"));
    assert.equal(fs.realpathSync(store.getStorePath()), fs.realpathSync(root));
    assert.deepEqual(nextChildren, [], "Production activation must not start Next");
    assert.match(fs.readFileSync(process.env.PKM_UPGRADE_SENTINEL || path.join(root, "fixture-sentinel.txt"), "utf8"), /untouched/);
    fs.writeFileSync(path.join(process.env.PKM_TRIAL_ELECTRON_ROOT, "passed.json"),
      JSON.stringify({ passed: true, upgradeActivationPassed: true }), { flag: "wx" });
    console.log("PASS: upgraded installed extension reused the configured root without a path picker or automatic Next launch.");
  } finally { childProcess.fork = originalFork; vscode.window.showOpenDialog = originalPicker; }
};
