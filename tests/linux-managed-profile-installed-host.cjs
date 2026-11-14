"use strict";
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vscode = require("vscode");
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));

exports.run = async () => {
  const { PKM_PROFILE_ROOT: root, PKM_PROFILE_CONTROL: control, PKM_PROFILE_LABEL: label,
    PKM_PROFILE_VERSION: expectedVersion } = process.env;
  assert(root && control && label && expectedVersion);
  const extension = vscode.extensions.getExtension("uone.personal-knowledge");
  assert(extension);
  assert.equal(extension.packageJSON.version, expectedVersion);
  await extension.activate();
  const store = require(path.join(extension.extensionPath, "dist/knowledge/filestore.js"));
  assert.equal(fs.realpathSync(store.getStorePath()), fs.realpathSync(root));
  const commands = await vscode.commands.getCommands(false);
  const enrolled = commands.includes("_personalKnowledge.managedWriterSessionStatus");
  assert.equal(enrolled, process.env.PKM_PROFILE_EXPECT_ENROLLED === "1");
  let status;
  if (enrolled) status = await vscode.commands.executeCommand("_personalKnowledge.managedWriterSessionStatus");
  fs.writeFileSync(path.join(control, `${label}-ready.json`),
    JSON.stringify({ pid: process.pid, version: extension.packageJSON.version, extensionPath: extension.extensionPath,
      session: process.env.PKM_MANAGED_WRITER_SESSION || null, status }), { flag: "wx" });
  let started = false, requested = false, discovery = 0;
  while (!fs.existsSync(path.join(control, `${label}-exit`))) {
    if (enrolled && !started && fs.existsSync(path.join(control, `${label}-git`))) {
      started = true;
      const { withManagedWriterOperation } = require(path.join(extension.extensionPath, "dist/runtime/managed-writer-session.js"));
      const { supervisedLegacyGit } = require(path.join(extension.extensionPath, "dist/runtime/linux-git-supervisor.js"));
      void withManagedWriterOperation(root, "github-sync", async () => {
        const git = supervisedLegacyGit(["-C", path.join(root, "repo"), "commit", "-m", "private fixture"],
          { cwd: root, env: process.env, timeout: 30000, maxBuffer: 1024 * 1024 });
        if (!git) throw new Error("Missing managed Git supervisor.");
        await git;
      }).then(() => fs.writeFileSync(path.join(control, `${label}-git-returned`), "returned"),
        error => fs.writeFileSync(path.join(control, `${label}-git-error`), String(error)));
    }
    if (enrolled && !requested && fs.existsSync(path.join(control, `${label}-handoff`))) {
      requested = true;
      void vscode.commands.executeCommand("_personalKnowledge.managedWriterSessionHandoff", 3000).then(
        result => fs.writeFileSync(path.join(control, `${label}-handoff-result`), JSON.stringify(result)),
        error => fs.writeFileSync(path.join(control, `${label}-handoff-error`), String(error)));
    }
    if (enrolled && fs.existsSync(path.join(control, `${label}-discover-${discovery}`))) {
      const profiles = await vscode.commands.executeCommand("_personalKnowledge.managedWriterSessionDiscover");
      fs.writeFileSync(path.join(control, `${label}-discovered-${discovery}`), JSON.stringify(profiles), { flag: "wx" });
      discovery++;
    }
    await pause(40);
  }
};
