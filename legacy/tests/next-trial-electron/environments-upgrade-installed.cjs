"use strict";
const assert = require("node:assert/strict"), fs = require("node:fs"), path = require("node:path");
const { execFileSync } = require("node:child_process");
const { createHash } = require("node:crypto");
const vscode = require("vscode");
const hash = file => createHash("sha256").update(fs.readFileSync(file)).digest("hex");

exports.run = async () => {
  const root = process.env.PKM_ENV_INSTALLED_ROOT, phase = process.env.PKM_ENV_INSTALLED_PHASE;
  const deletionOnly = process.env.PKM_ENV_INSTALLED_PYTHON_DELETE_ONLY === "1";
  const skipGeneralExecution = deletionOnly || process.env.PKM_ENV_INSTALLED_CONDA_CRASH === "1";
  const extension = vscode.extensions.getExtension("Uone.personal-knowledge");
  assert(extension); assert(vscode.workspace.isTrusted);
  const storage = path.join(root, "u/User/globalStorage/uone.personal-knowledge");
  const registry = path.join(storage, "environments/registry.json");
  const cache = path.join(storage, "environments/legacy-python.packages.json");
  const reference = path.join(root, "workspace/existing-python-workflow.json");
  const snapshotFile = path.join(root, "legacy-profile-snapshot.json");
  if (phase === "legacy") {
    assert.equal(extension.packageJSON.version, "4.0.22");
    await extension.activate();
    const old = require(path.join(extension.extensionPath, "dist/servers/pyenvs.js"));
    assert.equal(old.pyenvList()[0].id, "legacy-python", "Actual installed old activation reads its own private profile.");
    old.pyenvUpdate("legacy-python", { description: "用户原有配置—不重新选择路径", condaName: "kept-original-name",
      extraMetadata: { reference: "preserve-original", tags: ["existing"] } });
    if (process.env.PKM_ENV_INSTALLED_MANAGEMENT === "1") {
      const vm = require("node:vm"), requests = [];
      let modal;
      const fields = { "ne-mgr": { value: "venv" }, "ne-name": { value: "old-create-form" },
        "ne-dir": { value: path.join(root, "synthetic-old-create-parent") }, "ne-base": { value: old.pyenvList()[0].python },
        "ne-ver": { value: "" }, "ne-desc": { value: "explicit old create input" }, "ne-msg": {} };
      const context = vm.createContext({ pkModal(value) { modal = value; }, ask(command, payload) { requests.push({ command, payload }); },
        document: { getElementById(id) { return fields[id]; } } });
      vm.runInContext(fs.readFileSync(path.join(root, "old-environments-ui.js"), "utf8"), context);
      context.records = old.pyenvList();
      vm.runInContext("envCache=records; editEnv('legacy-python')", context);
      modal.onOk("Old UI renamed Python", "old UI saved description");
      const edit = requests.at(-1); assert.equal(edit.command, "envUpdate");
      assert.deepEqual(Object.keys(edit.payload.patch).sort(), ["description", "name"]);
      old.pyenvUpdate(edit.payload.id, edit.payload.patch);
      vm.runInContext("deleteEnv('legacy-python','Old UI renamed Python')", context);
      assert.equal(modal.checkbox.checked, false);
      modal.onOk(undefined, undefined, false);
      assert.equal(requests.at(-1).command, "envDelete"); assert.equal(requests.at(-1).payload.removeFiles, false);
      vm.runInContext("submitNewEnv()", context);
      assert.equal(requests.at(-1).command, "envCreate"); assert.equal(requests.at(-1).payload.input.manager, "venv");
      vm.runInContext("activateEnv('legacy-python')", context);
      assert.equal(requests.at(-1).command, "envActivate");
      fs.writeFileSync(path.join(root, "old-ui-management-map.json"), JSON.stringify({
        sourceSha256: hash(path.join(root, "old-environments-ui.js")),
        scope: "actual shipped old UI functions evaluated with controlled modal/form; not visual clicks",
        supportedCreateManagers: ["conda", "venv", "uv"], editFields: ["name", "description"],
        identityChangeSupported: false, globalDefaultSelectionSupported: false, removalDefaultDeletesFiles: false,
        binding: "Workflow Python node config.environmentId; not a global environment selection",
        capturedCommands: requests.map(request => request.command), oldRenamePersisted: old.pyenvList()[0].name,
      }, null, 2));
    }
    old.pyenvAdd({ name: "missing-python", manager: "venv", path: path.join(root, "missing-existing-prefix"),
      python: path.join(root, "missing-existing-prefix/bin/python"), description: "Keep missing configuration, never install." });
    const entries = old.pyenvList();
    fs.writeFileSync(cache, '{"packages":[{"name":"old-package-cache","version":"1"}],"capturedAt":"old"}\n');
    const definition = { schema: "pkm.workflow.definition/v1", spec: { inputs: {}, outputs: {},
      nodes: [{ nodeId: "existing-python", kind: "pkm.step.script/v1", dependsOn: [],
        config: { runtime: "python", environmentId: entries[0].id, script: "print(7)", timeoutSeconds: 30, maxOutputBytes: 4096 } }],
      completion: { requiredNodes: ["existing-python"] } } };
    const compiled = require(path.join(extension.extensionPath, "dist/workflows/workflow-contracts.js")).compileWorkflowDefinitionV1(definition);
    assert(compiled.ok, JSON.stringify(compiled));
    fs.writeFileSync(reference, JSON.stringify(definition, null, 2));
    let condaReferenceSha256;
    if (process.env.PKM_ENV_INSTALLED_MANAGERS === "1") {
      const conda = entries.find(entry => entry.manager === "conda"); assert(conda);
      const condaDefinition = JSON.parse(JSON.stringify(definition));
      condaDefinition.spec.nodes[0].config.environmentId = conda.id;
      assert(require(path.join(extension.extensionPath, "dist/workflows/workflow-contracts.js")).compileWorkflowDefinitionV1(condaDefinition).ok);
      const condaReference = path.join(root, "workspace/existing-conda-workflow.json");
      fs.writeFileSync(condaReference, JSON.stringify(condaDefinition, null, 2)); condaReferenceSha256 = hash(condaReference);
    }
    const output = execFileSync(entries[0].python, ["-I", "-B", "-c", "import sys; print(sys.prefix)"],
      { cwd: root, env: {}, encoding: "utf8" }).trim();
    assert.equal(output, entries[0].path);
    assert(!fs.existsSync(path.join(storage, "next-local-environments")));
    fs.writeFileSync(snapshotFile, JSON.stringify({
      installedOldExtension: extension.extensionPath, oldVersion: extension.packageJSON.version, entries,
      legacyRegistrySha256: hash(registry), packageCacheSha256: hash(cache), referenceSha256: hash(reference),
      referenceExecutableDigest: compiled.executableDigest, existingPythonPrefix: output,
      ...(condaReferenceSha256 ? { condaReferenceSha256 } : {}),
    }, null, 2));
    console.log("PASS actual installed old baseline: private profile config/cache and Workflow environmentId reference, existing Python usable.");
    return;
  }
  const errors = [], warnings = [];
  const originalError = vscode.window.showErrorMessage, originalWarning = vscode.window.showWarningMessage;
  const originalPicker = vscode.window.showOpenDialog;
  vscode.window.showErrorMessage = async message => { errors.push(message); };
  vscode.window.showWarningMessage = async message => { warnings.push(message); };
  vscode.window.showOpenDialog = async () => assert.fail("Activation must discover the current profile without import/path dialogs.");
  try { await extension.activate(); }
  finally {
    vscode.window.showErrorMessage = originalError; vscode.window.showWarningMessage = originalWarning;
    vscode.window.showOpenDialog = originalPicker;
  }
  assert.deepEqual(errors, []);
  assert(warnings.some(message => /runtimes need repair/.test(message) && /missing-python/.test(message)), warnings.join("\n"));
  const baseline = JSON.parse(fs.readFileSync(snapshotFile));
  const { LocalEnvironmentCatalog, inspectLocalEnvironment } = require(path.join(extension.extensionPath, "dist/runtime/local-environment-catalog.js"));
  const store = new LocalEnvironmentCatalog(path.join(storage, "next-local-environments"));
  const before = store.read();
  for (const original of baseline.entries) {
    const retained = before.catalog.entries.find(entry => entry.id === original.id);
    assert(retained, original.id); assert.deepEqual(retained.legacyPython, original);
    assert.equal(retained.root, original.path); assert.equal(retained.executors[0].executable, original.python);
  }
  assert.equal(inspectLocalEnvironment(before.catalog.entries.find(entry => entry.id === "missing-python")).available, false);
  const definition = JSON.parse(fs.readFileSync(reference));
  const compiled = require(path.join(extension.extensionPath, "dist/workflows/workflow-contracts.js")).compileWorkflowDefinitionV1(definition);
  assert(compiled.ok); assert.equal(compiled.executableDigest, baseline.referenceExecutableDigest);
  assert.equal(definition.spec.nodes[0].config.environmentId, "legacy-python");
  if (phase === "initial") assert.equal(before.catalog.revision, 1, "First new activation automatically migrates exactly once.");
  if (phase === "reopen") {
    if (process.env.PKM_ENV_INSTALLED_CONDA_CRASH === "1") {
      const initial = JSON.parse(fs.readFileSync(path.join(root, "managers-initial-result.json")));
      assert.equal(before.digest, initial.lifecycle.beforeCrashCatalogDigest, "Crash restart does not replay or repair metadata.");
    } else {
      const initial = JSON.parse(fs.readFileSync(path.join(root, "upgrade-initial-result.json")));
      assert.equal(before.digest, initial.catalogDigest, "Restart neither re-imports nor changes Node bindings.");
      if (!deletionOnly) assert(before.catalog.entries.some(entry => entry.language === "javascript"));
    }
  }
  if (process.env.PKM_ENV_INSTALLED_MANAGEMENT === "1") await require("./environments-management-installed.cjs").run();
  if (process.env.PKM_ENV_INSTALLED_MANAGERS === "1" || process.env.PKM_ENV_INSTALLED_PYTHON_DELETE_ONLY === "1")
    await require("./environments-managers-installed.cjs").run();
  if (!skipGeneralExecution) await require("./environments-execution-installed.cjs").run();
  const after = store.read();
  assert.equal(hash(registry), baseline.legacyRegistrySha256);
  assert.equal(hash(cache), baseline.packageCacheSha256);
  assert.equal(hash(reference), baseline.referenceSha256);
  const execution = skipGeneralExecution ? { filePicks: [] } : JSON.parse(fs.readFileSync(path.join(root,
    phase === "initial" ? "execution-initial-result.json" : "execution-reopened-result.json")));
  if (!skipGeneralExecution) assert.equal(execution.missingPythonRefused, true);
  if (phase === "reopen" && !skipGeneralExecution) assert.equal(execution.filePicks.length,
    process.env.PKM_ENV_INSTALLED_PYTHON_PROGRAM === "1" || process.env.PKM_ENV_INSTALLED_NODE_PROJECT === "1" ? 3 : 2,
    "Only fresh trial/broker and explicitly reviewed source selection, never environment path reselection.");
  fs.writeFileSync(path.join(root, `upgrade-${phase}-result.json`), JSON.stringify({
    scope: "real old-to-new installed private-profile overlay, instrumented dialogs; not arbitrary Recipe/script execution qualification",
    automaticDiscovery: true, explicitImport: false, activationPathPickers: 0,
    originalIdsAndFullConfigurationPreserved: true, originalReferenceBytesAndDigestPreserved: true,
    missingRuntimeReportedNotSuccessful: true, noRuntimeDownloadOrInstall: true,
    catalogDigest: after.digest, revision: after.catalog.revision, executionFilePicks: execution.filePicks,
    nodeAndPythonUsable: !skipGeneralExecution, ...(skipGeneralExecution ? { pythonUsable: true, nodeWorkflowQualification: false } : {}),
    restart: phase === "reopen",
  }, null, 2));
  console.log(`PASS installed automatic upgrade ${phase}: no import or environment path reselection, original reference/config/cache kept, ${skipGeneralExecution ? "real Python usable; no Node workflow qualification" : "missing runtime refused, real Python/Node usable"}.`);
};
