"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vscode = require("vscode");

exports.run = async () => {
  const extension = vscode.extensions.getExtension("uone.personal-knowledge");
  assert(extension, "Legacy extension is not installed");
  assert.equal(fs.realpathSync(extension.extensionPath), fs.realpathSync(process.env.PKM_UPGRADE_EXTENSION));
  await extension.activate();
  const oldStore = require(path.join(extension.extensionPath, "dist/filestore.js"));
  assert.equal(fs.realpathSync(oldStore.getStorePath()), fs.realpathSync(process.env.PKM_UPGRADE_ROOT));
  assert.match(fs.readFileSync(process.env.PKM_UPGRADE_SENTINEL
    || path.join(process.env.PKM_UPGRADE_ROOT, "fixture-sentinel.txt"), "utf8"), /untouched/);
  if (process.env.PKM_UPGRADE_CHATROOM_FIXTURE === "1") {
    await require("./chatroom-fixture.cjs").create({ extension: extension.extensionPath, root: process.env.PKM_UPGRADE_ROOT });
    await require("./chatroom-live-fixture.cjs").create({ extension: extension.extensionPath, root: process.env.PKM_UPGRADE_ROOT });
    console.log("PASS: actual installed legacy ChatPersistence wrote and closed a nonempty synthetic Room.");
  }
};
