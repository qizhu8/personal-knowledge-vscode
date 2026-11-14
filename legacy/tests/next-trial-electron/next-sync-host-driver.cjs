"use strict";
const fs = require("node:fs");
const assert = require("node:assert/strict");
const vscode = require("vscode");

exports.activate = async () => {
  const marker = process.env.PKM_SYNC_HOST_DRIVER_MARKER;
  try {
    const extension = vscode.extensions.getExtension("uone.personal-knowledge");
    assert(extension, "Target extension is not installed");
    await extension.activate();
    const status = await vscode.commands.executeCommand("personalKnowledge.inspectNextSyncHost", "fixture-target");
    assert.equal(status.schema, "pkm.next-sync-host-observation/v1");
    assert.equal(status.targetId, "fixture-target");
    assert.equal(status.credential, "available");
    assert.equal(status.recovery.transaction, "recorded");
    assert.equal(status.recovery.coordinator, "pending");
    assert.equal(status.recovery.serviceResults, "pending");
    assert.equal(status.recovery.experimentalJournal, "pending");
    assert.equal(status.cutover, "BLOCKED_LEGACY_WRITER_EXCLUSION");
    assert(!JSON.stringify(status).includes("fixture-token"));
    await assert.rejects(vscode.commands.executeCommand("personalKnowledge.executeNextSyncHost"), /blocked/);
    fs.writeFileSync(marker, JSON.stringify({ passed: true, status }), { flag: "wx", mode: 0o600 });
  } catch (error) {
    fs.writeFileSync(marker, JSON.stringify({ passed: false, error: String(error?.message ?? error) }), { flag: "wx", mode: 0o600 });
  } finally {
    setTimeout(() => { void vscode.commands.executeCommand("workbench.action.quit"); }, 100);
  }
};
