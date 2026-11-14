"use strict";
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { createHash } = require("node:crypto");
const vscode = require("vscode");
const hash = file => createHash("sha256").update(fs.readFileSync(file)).digest("hex");

exports.run = async () => {
  const root = process.env.PKM_ENV_INSTALLED_ROOT;
  const extension = vscode.extensions.getExtension("Uone.personal-knowledge");
  assert(extension, "Focused candidate must actually be installed.");
  assert(vscode.workspace.isTrusted, "Synthetic workspace must be trusted.");
  await extension.activate();
  const registry = path.join(root, "u/User/globalStorage/uone.personal-knowledge/environments/registry.json");
  const original = hash(registry);
  const { LocalEnvironmentCatalog } = require(path.join(extension.extensionPath, "dist/runtime/local-environment-catalog.js"));
  const store = new LocalEnvironmentCatalog(path.join(root, "u/User/globalStorage/uone.personal-knowledge/next-local-environments"));
  const restore = [], errors = [], infos = [], dialogs = [], inputs = [];
  let action, selectedId, deny = false, importCount = 0;
  function replace(object, key, value) { const old = object[key]; object[key] = value; restore.push(() => { object[key] = old; }); }
  replace(vscode.window, "showErrorMessage", async message => { errors.push(message); });
  replace(vscode.window, "showInformationMessage", async message => { infos.push(message); });
  replace(vscode.window, "showOpenDialog", async () => {
    const item = dialogs.shift(); assert(item, "Unexpected file picker"); return [vscode.Uri.file(item)];
  });
  replace(vscode.window, "showInputBox", async () => inputs.shift());
  replace(vscode.window, "showWarningMessage", async (message, options, button) => {
    if (!message.includes("environment catalog") && !message.includes("fixed Python Workflow")
      && !message.includes("Create a disposable PKM Next trial")) return undefined;
    assert(options.modal);
    if (message.includes("environment catalog")) { assert.match(options.detail, /No runtime execution/); importCount++; }
    return deny ? undefined : button;
  });
  replace(vscode.window, "showQuickPick", async items => {
    if (typeof items[0] === "string" && items.includes("Import legacy profile registry")) return action;
    if (selectedId) return items.find(item => item.description === selectedId);
    return undefined;
  });
  const manage = () => vscode.commands.executeCommand("personalKnowledge.nextTrialEnvironments");
  try {
    if (process.env.PKM_ENV_INSTALLED_PHASE === "reopen") {
      assert.equal(store.read().catalog.revision, 4);
      assert.equal(store.read().catalog.entries[0].id, "legacy-python");
      action = "Run registered Python Workflow diagnostic"; selectedId = "legacy-python";
      await manage();
      assert.match(errors.pop(), /fresh isolated Next trial/, "Persisted metadata must not revive prior host authority.");
      const trial = path.join(root, "trial-reopen"); fs.mkdirSync(trial, { mode: 0o700 });
      dialogs.push(trial, process.env.PKM_ENV_INSTALLED_NODE);
      await vscode.commands.executeCommand("personalKnowledge.nextTrialStart");
      await manage();
      assert(infos.some(message => /Python Workflow succeeded: 7/.test(message)));
      assert.deepEqual(errors, []);
      assert.equal(hash(registry), original);
      fs.writeFileSync(path.join(root, "reopened-result.json"), JSON.stringify({
        revision: 4, freshHostRequired: true, explicitPythonReselectionSucceeded: true, legacyRegistrySha256: original,
      }, null, 2));
      console.log("PASS installed Environments restart: metadata persisted, stale authority refused, fresh host re-selection succeeded.");
      return;
    }
    action = "Import legacy profile registry";
    await manage();
    assert.match(errors.pop(), /fresh isolated Next trial/);
    const trial = path.join(root, "trial");
    fs.mkdirSync(trial, { mode: 0o700 });
    dialogs.push(trial, process.env.PKM_ENV_INSTALLED_NODE);
    await vscode.commands.executeCommand("personalKnowledge.nextTrialStart");
    assert.deepEqual(errors, []);
    deny = true; dialogs.push(registry); await manage();
    assert.equal(store.read().catalog.revision, 0);
    deny = false; dialogs.push(registry); await manage();
    assert.equal(store.read().catalog.revision, 1);
    assert.equal(store.read().catalog.entries[0].id, "legacy-python");
    dialogs.push(registry); await manage();
    assert.equal(store.read().catalog.revision, 1, "Repeating the exact import is idempotent.");
    action = "Register local Node.js runtime";
    dialogs.push(process.env.PKM_ENV_INSTALLED_NODE); inputs.push("Installed local Node"); await manage();
    assert.equal(store.read().catalog.entries[1].kind, "runtime");
    selectedId = "legacy-python";
    action = "Run registered Python Workflow diagnostic"; await manage();
    assert(infos.some(message => /Python Workflow succeeded: 7/.test(message)), infos.join("\n"));
    action = "Unregister (keep all runtime files)"; await manage();
    assert.equal(store.read().catalog.entries.length, 1);
    assert(fs.existsSync(path.join(root, "legacy-venv/bin/python")));
    action = "Restore catalog revision"; inputs.push("1"); await manage();
    assert.equal(store.read().catalog.entries[0].id, "legacy-python");
    await vscode.commands.executeCommand("personalKnowledge.nextTrialClose");
    action = "Run registered Python Workflow diagnostic"; await manage();
    assert.match(errors.pop(), /fresh isolated Next trial/);
    assert.deepEqual(errors, []);
    assert.equal(hash(registry), original, "Actual old-profile registry must remain byte-identical.");
    assert(importCount >= 5);
    fs.writeFileSync(path.join(root, "installed-result.json"), JSON.stringify({
      scope: "focused installed overlay; real VS Code host and child, instrumented dialogs, not interactive UI qualification",
      installedExtension: extension.extensionPath, legacyRegistrySha256: original,
      revision: store.read().catalog.revision, pythonWorkflowSucceeded: true, importCount,
    }, null, 2));
    console.log("PASS installed Environments: old-profile import, denial/idempotency, Node registration, real Python Workflow, unregister/restore and closed-host refusal.");
  } finally {
    await vscode.commands.executeCommand("personalKnowledge.nextTrialClose");
    restore.reverse().forEach(fn => fn());
  }
};
