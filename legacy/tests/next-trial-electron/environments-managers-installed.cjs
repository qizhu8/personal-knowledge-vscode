"use strict";
const assert = require("node:assert/strict"), fs = require("node:fs"), path = require("node:path");
const { createHash } = require("node:crypto");
const vscode = require("vscode");
const hash = file => createHash("sha256").update(fs.readFileSync(file)).digest("hex");
exports.run = async () => {
  const root = process.env.PKM_ENV_INSTALLED_ROOT, phase = process.env.PKM_ENV_INSTALLED_PHASE;
  const extension = vscode.extensions.getExtension("Uone.personal-knowledge"); await extension.activate();
  const storage = path.join(root, "u/User/globalStorage/uone.personal-knowledge");
  const { LocalEnvironmentCatalog } = require(path.join(extension.extensionPath, "dist/runtime/local-environment-catalog.js"));
  const store = new LocalEnvironmentCatalog(path.join(storage, "next-local-environments"));
  const baseline = JSON.parse(fs.readFileSync(path.join(root, "legacy-profile-snapshot.json")));
  const deletionOnly = process.env.PKM_ENV_INSTALLED_PYTHON_DELETE_ONLY === "1";
  const original = baseline.entries.find(entry => entry.manager === (deletionOnly ? "venv" : "conda")); assert(original);
  const reference = path.join(root, "workspace", deletionOnly ? "existing-python-workflow.json" : "existing-conda-workflow.json");
  const synthetic = path.join(storage, "next-synthetic-python");
  const restore = [], errors = [], infos = [], dialogs = [], inputs = [], filePicks = [], phases = [];
  let action, selectedId = original.id, cancelCreate = false, recoveryId;
  let selectedIds = [];
  const values = [];
  let declineCopy = false;
  let declineDeletion = false;
  const lifecycleEnabled = process.env.PKM_ENV_INSTALLED_CONDA_LIFECYCLE === "1";
  const replace = (object, key, value) => { const old = object[key]; object[key] = value; restore.push(() => { object[key] = old; }); };
  replace(vscode.window, "showErrorMessage", async message => { errors.push(message); });
  replace(vscode.window, "showInformationMessage", async message => { infos.push(message); });
  replace(vscode.window, "showInputBox", async () => inputs.shift());
  replace(vscode.window, "showOpenDialog", async () => {
    const file = dialogs.shift(); assert(file, "Unexpected manager file picker");
    filePicks.push(file); return [vscode.Uri.file(file)];
  });
  replace(vscode.window, "showQuickPick", async (items, options) => {
    if (typeof items[0] === "string" && items.includes("Import legacy profile registry")) return action;
    if (typeof items[0] === "string" && /^[a-f0-9-]{36}$/.test(items[0])) return items.find(id => id === recoveryId);
    if (typeof items[0] === "string") { const value = values.shift(); return items.find(item => item === value); }
    if (options?.canPickMany) { const result = items.filter(item => selectedIds.includes(item.description)); selectedIds = []; return result; }
    const wanted = selectedIds.length ? selectedIds.shift() : selectedId;
    return items.find(item => item.description === wanted);
  });
  replace(vscode.window, "showWarningMessage", async (message, options, button) => {
    assert.match(message, /Create a disposable PKM Next trial|environment catalog|fixed Python Workflow|offline (?:conda|uv) environment|offline Python venv|Permanently delete this synthetic Python prefix|reviewed offline conda lifecycle|reviewed installed Bash hook|Restore this conda recovery clone|Refresh this registered conda package table|registered pip package table|registered Python version|installed conda inventory|Register this existing conda inventory|Copy this reviewed manual/);
    assert(options.modal);
    if (declineCopy && /Copy this reviewed manual/.test(message)) { declineCopy = false; return undefined; }
    if (declineDeletion && /Permanently delete this synthetic Python prefix/.test(message)) { declineDeletion = false; return undefined; }
    return button;
  });
  const originalProgress = vscode.window.withProgress;
  replace(vscode.window, "withProgress", (options, task) => originalProgress(options, async (progress, token) => {
    const cancellation = new vscode.CancellationTokenSource();
    const subscription = token.onCancellationRequested(() => cancellation.cancel());
    try {
      return await task({ report(value) {
        phases.push(value.message); progress.report(value);
        if (cancelCreate && value.message === "conda-create") cancellation.cancel();
      } }, cancellation.token);
    } finally { subscription.dispose(); cancellation.dispose(); }
  }));
  const manage = () => vscode.commands.executeCommand("personalKnowledge.nextTrialEnvironments");
  const python = async id => {
    selectedId = id; action = "Run registered Python Workflow diagnostic"; const before = infos.length;
    await manage();
    assert(infos.slice(before).some(message => /Python Workflow succeeded: 7/.test(message) && message.includes(id)),
      JSON.stringify({ errors, infos: infos.slice(before) }));
  };
  const directories = () => fs.readdirSync(synthetic).filter(name => fs.existsSync(path.join(synthetic, name, ".pkm-creation.json")));
  const create = async (name, cache = process.env.PKM_ENV_INSTALLED_CONDA_CACHE) => {
    action = "Create offline conda environment";
    dialogs.push(process.env.PKM_ENV_INSTALLED_CONDA, cache); inputs.push("3.11", name, "Explicit installed offline manager fixture");
    await manage();
  };
  const lifecycleContext = { root, dialogs, errors, inputs, infos, phases, filePicks, values, manage, python, originalId: original.id,
    select(value, id) { action = value; selectedId = id; selectedIds = []; },
    selectIds(value, ids) { action = value; selectedIds = [...ids]; },
    declineCopy() { declineCopy = true; },
    declineDeletion() { declineDeletion = true; },
    recovery(id) { recoveryId = id; } };
  try {
    const trial = path.join(root, `managers-${phase}-trial`); fs.mkdirSync(trial, { mode: 0o700 });
    dialogs.push(trial, process.env.PKM_ENV_INSTALLED_NODE);
    await vscode.commands.executeCommand("personalKnowledge.nextTrialStart");
    assert.deepEqual(errors, []);
    assert.equal(hash(reference), deletionOnly ? baseline.referenceSha256 : baseline.condaReferenceSha256);
    if (deletionOnly) {
      const helper = require("./environments-python-deletion-installed.cjs");
      const file = path.join(root, "python-deletion-only-initial-result.json");
      const result = phase === "reopen" ? await helper.reopen(lifecycleContext, JSON.parse(fs.readFileSync(file)))
        : await helper.cases(lifecycleContext, original.id);
      fs.writeFileSync(phase === "reopen" ? path.join(root, "python-deletion-only-reopen-result.json") : file,
        JSON.stringify(result, null, 2));
      assert.equal(hash(reference), baseline.referenceSha256);
      return;
    }
    if (phase === "reopen") {
      const previous = JSON.parse(fs.readFileSync(path.join(root, "managers-initial-result.json")));
      const lifecycle = lifecycleEnabled ? await require("./environments-conda-lifecycle-installed.cjs").reopen(lifecycleContext, previous.lifecycle) : undefined;
      const packages = process.env.PKM_ENV_INSTALLED_CONDA_PACKAGES === "1"
        ? await require("./environments-conda-packages-installed.cjs").reopen(lifecycleContext, previous.packages) : undefined;
      const pythonPackages = process.env.PKM_ENV_INSTALLED_PYTHON_PACKAGES === "1"
        ? await require("./environments-python-packages-installed.cjs").reopen(lifecycleContext, previous.pythonPackages) : undefined;
      const pythonDeletion = process.env.PKM_ENV_INSTALLED_PYTHON_DELETE === "1"
        ? await require("./environments-python-deletion-installed.cjs").reopen(lifecycleContext, previous.pythonDeletion) : undefined;
      assert.deepEqual(store.read().catalog.entries.find(entry => entry.id === previous.created.id), previous.created);
      assert.equal(hash(path.join(previous.created.root, "conda-meta/history")), previous.createdHistorySha256);
      assert.deepEqual(directories().sort(), previous.retainedDirectories);
      assert(previous.retainedFailures.every(folder => fs.existsSync(folder)));
      await python(original.id); await python(previous.created.id);
      assert.equal(filePicks.length, lifecycleEnabled ? 4 : 2, "Only fresh trial setup and explicitly requested restore's manager/cache selection.");
      if (!lifecycleEnabled) assert.deepEqual(phases, [], "No manager process or creation replay on restart.");
      fs.writeFileSync(path.join(root, "managers-reopen-result.json"), JSON.stringify({
        legacyAndCreatedCondaBindingsUsable: true, stableIdsAndOriginalReference: true,
        environmentPathReselection: false, noCreationReplay: true, retainedFailuresStillPresent: true, filePicks,
        ...(lifecycle ? { lifecycle } : {}),
        ...(packages ? { packages } : {}),
        ...(pythonPackages ? { pythonPackages } : {}),
        ...(pythonDeletion ? { pythonDeletion } : {}),
      }, null, 2));
      console.log("PASS installed conda restart: original/new bindings usable, paths/IDs stable, no manager replay or path reselection.");
      return;
    }
    await python(original.id);
    const beforeCancellation = directories(), cancellationDigest = store.read().digest;
    cancelCreate = true; await create("cancelled-conda"); cancelCreate = false;
    assert.match(errors.pop(), /cancelled/i); assert.equal(store.read().digest, cancellationDigest);
    const cancelled = directories().filter(name => !beforeCancellation.includes(name)); assert.equal(cancelled.length, 1);
    const cancelledRoot = path.join(synthetic, cancelled[0]);
    assert(fs.existsSync(cancelledRoot));
    action = "Register existing Python folder"; dialogs.push(cancelledRoot); inputs.push("Incomplete prefix must not succeed");
    await manage(); assert(errors.pop()); assert.equal(store.read().digest, cancellationDigest);
    const empty = path.join(root, "manager-empty-cache"); fs.mkdirSync(empty, { mode: 0o700 });
    const beforeFailure = directories();
    await create("unavailable-cached-python", empty);
    assert.match(errors.pop(), /failed|unavailable|not found/i); assert.equal(store.read().digest, cancellationDigest);
    const failed = directories().filter(name => !beforeFailure.includes(name)); assert.equal(failed.length, 1);
    const beforeUv = directories();
    selectedId = original.id; action = "Create offline uv environment"; dialogs.push(path.join(root, "unavailable-local-uv"));
    await manage(); assert.match(errors.pop(), /uv.*unavailable|unavailable.*uv/i);
    assert.equal(store.read().digest, cancellationDigest); assert.deepEqual(directories(), beforeUv);
    await create("installed-offline-conda");
    const created = store.read().catalog.entries.find(entry => entry.name === "installed-offline-conda");
    assert(created && created.manager === "conda", JSON.stringify(errors));
    await python(created.id);
    action = "Edit Python name and description"; inputs.push("Renamed offline conda", "Stable conda ID"); await manage();
    const revision = store.read().catalog.revision;
    action = "Unregister (keep all runtime files)"; await manage();
    assert(fs.existsSync(created.executors[0].executable)); assert(!store.read().catalog.entries.some(entry => entry.id === created.id));
    action = "Restore catalog revision"; inputs.push(String(revision)); await manage();
    await python(created.id);
    assert.deepEqual(errors, []); assert.deepEqual(inputs, []); assert.deepEqual(dialogs, []);
    const initialFile = path.join(root, "managers-initial-result.json");
    const initialResult = {
      scope: "installed native commands, real offline conda and Python Workflow, instrumented dialogs/progress; no visual-click qualification",
      created: store.read().catalog.entries.find(entry => entry.id === created.id),
      createdHistorySha256: hash(path.join(created.root, "conda-meta/history")),
      actualOldCondaAutomaticallyDiscoveredAndUsed: true, actualNewCondaCreatedAndBound: true,
      actualOwnedCreateChildCancelled: true, incompletePrefixRegistrationRefused: true,
      emptyCacheFailedNotSuccessful: true, unavailableUvExplicitlyRefused: true,
      noDownloads: true, nonDestructiveUnregisterRestore: true, oldReferencePreserved: true,
      retainedFailures: [cancelledRoot, path.join(synthetic, failed[0])],
      retainedDirectories: directories().sort(), phases, filePicks,
    };
    fs.writeFileSync(initialFile, JSON.stringify(initialResult, null, 2));
    const lifecycle = lifecycleEnabled ? await require("./environments-conda-lifecycle-installed.cjs").cases(lifecycleContext) : undefined;
    const packages = process.env.PKM_ENV_INSTALLED_CONDA_PACKAGES === "1"
      ? await require("./environments-conda-packages-installed.cjs").cases(lifecycleContext, created.id) : undefined;
    const pythonPackages = process.env.PKM_ENV_INSTALLED_PYTHON_PACKAGES === "1"
      ? await require("./environments-python-packages-installed.cjs").cases(lifecycleContext) : undefined;
    const pythonDeletion = process.env.PKM_ENV_INSTALLED_PYTHON_DELETE === "1"
      ? await require("./environments-python-deletion-installed.cjs").cases(lifecycleContext, pythonPackages.entries[0].id) : undefined;
    fs.writeFileSync(initialFile, JSON.stringify({ ...initialResult, ...(lifecycle ? { lifecycle } : {}),
      ...(packages ? { packages } : {}), ...(pythonPackages ? { pythonPackages } : {}),
      ...(pythonDeletion ? { pythonDeletion, retainedDirectories: directories().sort() } : {}) }, null, 2));
    console.log("PASS installed managers: real old conda auto-upgrade/use, explicit offline create/bind, actual cancel/retained files, empty-cache failure, missing uv refusal and non-destructive management.");
  } finally {
    await vscode.commands.executeCommand("personalKnowledge.nextTrialClose");
    restore.reverse().forEach(fn => fn());
  }
};
