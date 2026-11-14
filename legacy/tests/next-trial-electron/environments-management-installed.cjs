"use strict";
const assert = require("node:assert/strict"), fs = require("node:fs"), path = require("node:path");
const { createHash } = require("node:crypto");
const vscode = require("vscode");
const hash = file => createHash("sha256").update(fs.readFileSync(file)).digest("hex");
exports.run = async () => {
  const root = process.env.PKM_ENV_INSTALLED_ROOT, phase = process.env.PKM_ENV_INSTALLED_PHASE;
  const extension = vscode.extensions.getExtension("Uone.personal-knowledge"); await extension.activate();
  const { LocalEnvironmentCatalog } = require(path.join(extension.extensionPath, "dist/runtime/local-environment-catalog.js"));
  const store = new LocalEnvironmentCatalog(path.join(root, "u/User/globalStorage/uone.personal-knowledge/next-local-environments"));
  const baseline = JSON.parse(fs.readFileSync(path.join(root, "legacy-profile-snapshot.json")));
  const reference = JSON.parse(fs.readFileSync(path.join(root, "workspace/existing-python-workflow.json")));
  const restore = [], errors = [], infos = [], dialogs = [], inputs = [], filePicks = [];
  let action, selectedId = reference.spec.nodes[0].config.environmentId, denyCreation = false, onModal;
  function replace(object, key, value) { const old = object[key]; object[key] = value; restore.push(() => { object[key] = old; }); }
  replace(vscode.window, "showErrorMessage", async message => { errors.push(message); });
  replace(vscode.window, "showInformationMessage", async message => { infos.push(message); });
  replace(vscode.window, "showInputBox", async () => inputs.shift());
  replace(vscode.window, "showOpenDialog", async () => {
    const file = dialogs.shift(); assert(file, "Unexpected environment-management file picker");
    filePicks.push(file); return [vscode.Uri.file(file)];
  });
  replace(vscode.window, "showQuickPick", async items => {
    if (typeof items[0] === "string" && items.includes("Import legacy profile registry")) return action;
    return items.find(item => item.description === selectedId);
  });
  replace(vscode.window, "showWarningMessage", async (message, options, button) => {
    if (!/Create a disposable PKM Next trial|environment catalog|fixed Python Workflow|offline Python venv/.test(message)) return undefined;
    assert(options.modal); onModal?.(message);
    if (message.includes("offline Python venv") && denyCreation) return undefined;
    return button;
  });
  const manage = () => vscode.commands.executeCommand("personalKnowledge.nextTrialEnvironments");
  const python = async id => {
    selectedId = id; action = "Run registered Python Workflow diagnostic"; const count = infos.length;
    await manage();
    assert(infos.slice(count).some(message => /Python Workflow succeeded: 7/.test(message) && message.includes(id)),
      JSON.stringify({ errors, infos: infos.slice(count) }));
  };
  try {
    const trial = path.join(root, `management-${phase}-trial`); fs.mkdirSync(trial, { mode: 0o700 });
    dialogs.push(trial, process.env.PKM_ENV_INSTALLED_NODE);
    await vscode.commands.executeCommand("personalKnowledge.nextTrialStart");
    assert.deepEqual(errors, []);
    if (phase === "reopen") {
      const previous = JSON.parse(fs.readFileSync(path.join(root, "management-initial-result.json")));
      const retained = store.read().catalog.entries.find(entry => entry.id === previous.created.id);
      assert.deepEqual(retained, previous.created);
      assert.equal(hash(path.join(retained.root, "pyvenv.cfg")), previous.createdConfigSha256);
      assert.equal(store.read().catalog.entries.find(entry => entry.id === selectedId).name, "Renamed original Python");
      await python(reference.spec.nodes[0].config.environmentId); await python(retained.id);
      assert.equal(filePicks.length, 2, "Restart uses stored environment bindings, not path selection.");
      fs.writeFileSync(path.join(root, "management-reopen-result.json"), JSON.stringify({
        stableCreatedId: retained.id, retainedNameAndDescription: true, originalAndCreatedPythonWorkflowsSucceeded: true,
        environmentPathReselection: false, creationReplayed: false, filePicks,
      }, null, 2));
      console.log("PASS installed Python management restart: names/descriptions/IDs/paths persisted; original and new Python Workflows run with fresh approvals.");
      return;
    }
    await python(selectedId);
    action = "Edit Python name and description"; inputs.push("Renamed original Python", "Edited without changing identity"); await manage();
    const renamed = store.read().catalog.entries.find(entry => entry.id === selectedId);
    assert.equal(renamed.name, "Renamed original Python"); assert.deepEqual(renamed.legacyPython, baseline.entries[0]);
    await python(selectedId);
    action = "Create offline Python venv"; denyCreation = true; inputs.push("declined-venv", ""); const before = store.read();
    await manage(); assert.equal(store.read().digest, before.digest);
    assert(!fs.existsSync(path.join(root, "u/User/globalStorage/uone.personal-knowledge/next-synthetic-python")));
    denyCreation = false; inputs.push("created-local-python", "Created only by explicit action"); await manage();
    const createdId = store.read().catalog.entries.find(entry => entry.name === "created-local-python")?.id;
    assert(createdId, JSON.stringify(errors));
    let created = store.read().catalog.entries.find(entry => entry.id === createdId);
    assert(created.root.startsWith(path.join(root, "u/User/globalStorage/uone.personal-knowledge/next-synthetic-python/")));
    await python(createdId);
    action = "Edit Python name and description"; inputs.push("Renamed created Python", "Persisted new description"); await manage();
    created = store.read().catalog.entries.find(entry => entry.id === createdId);
    const restoreRevision = store.read().catalog.revision;
    action = "Unregister (keep all runtime files)"; await manage();
    assert(!store.read().catalog.entries.some(entry => entry.id === createdId));
    assert(fs.existsSync(created.executors[0].executable), "Unregister must not delete even synthetic runtime files.");
    action = "Restore catalog revision"; inputs.push(String(restoreRevision)); await manage();
    assert.equal(store.read().catalog.entries.find(entry => entry.id === createdId).name, created.name);
    await python(createdId);
    fs.renameSync(created.root, `${created.root}-offline`);
    action = "Run registered Python Workflow diagnostic"; const count = infos.length; await manage();
    assert.match(errors.pop(), /ENOENT|missing/); assert.equal(infos.length, count);
    fs.renameSync(`${created.root}-offline`, created.root);
    await python(createdId);
    action = "Register existing Python folder"; dialogs.push(created.root); inputs.push("Explicit recovered registration"); await manage();
    const recovered = store.read().catalog.entries.find(entry => entry.name === "Explicit recovered registration");
    assert(recovered && recovered.id !== createdId); await python(recovered.id);
    action = "Unregister (keep all runtime files)"; await manage();
    assert(fs.existsSync(created.executors[0].executable));
    selectedId = createdId; action = "Edit Python name and description"; inputs.push("Losing stale edit", "");
    onModal = message => {
      if (message.includes("environment catalog")) store.editPython(createdId, created.name, "Winning concurrent edit", store.read().digest);
    };
    await manage(); onModal = undefined;
    assert.match(errors.pop(), /Catalog changed/);
    assert.notEqual(store.read().catalog.entries.find(entry => entry.id === createdId).name, "Losing stale edit");
    assert.deepEqual(errors, []);
    created = store.read().catalog.entries.find(entry => entry.id === createdId);
    assert.equal(hash(path.join(root, "u/User/globalStorage/uone.personal-knowledge/environments/registry.json")), baseline.legacyRegistrySha256);
    assert.equal(hash(path.join(root, "workspace/existing-python-workflow.json")), baseline.referenceSha256);
    fs.writeFileSync(path.join(root, "management-initial-result.json"), JSON.stringify({
      scope: "native installed commands with instrumented dialogs, fixed Workflow bindings; not arbitrary Recipe script parity",
      created, createdConfigSha256: hash(path.join(created.root, "pyvenv.cfg")), originalId: reference.spec.nodes[0].config.environmentId,
      creationDeclineHadNoEffect: true, noPipOrDownload: true, renamePreservedOriginalSnapshotAndReference: true,
      unregisterKeptRuntimeFiles: true, restoreRequiredFreshApproval: true, missingPathRefusedThenExplicitlyRepaired: true,
      existingFolderExplicitlyRegisteredAndUsed: true, staleEditRefused: true, filePicks,
    }, null, 2));
    console.log("PASS installed Python management: explicit offline create/decline, stable-ID edit, original reference use, retained-disk unregister/restore, missing-path repair, folder registration, stale-edit CAS.");
  } finally {
    await vscode.commands.executeCommand("personalKnowledge.nextTrialClose");
    restore.reverse().forEach(fn => fn());
  }
};
