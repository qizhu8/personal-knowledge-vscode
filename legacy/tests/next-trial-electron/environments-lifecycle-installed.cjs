"use strict";
const fs = require("node:fs"), path = require("node:path"), assert = require("node:assert/strict");
const vscode = require("vscode");
const { LocalEnvironmentCatalog } = require("./dist/runtime/local-environment-catalog.js");
exports.cases = async context => {
  const storage = path.join(context.root, "u/User/globalStorage/uone.personal-knowledge");
  const store = new LocalEnvironmentCatalog(path.join(storage, "next-local-environments"));
  const before = store.read(), source = before.catalog.entries.find(entry => entry.id === "legacy-python");
  assert(source); const config = fs.readFileSync(path.join(source.root, "pyvenv.cfg"));
  const registry = fs.readFileSync(path.join(storage, "environments/registry.json"));
  let terminal, command, copied;
  const create = vscode.window.createTerminal;
  vscode.window.createTerminal = options => {
    assert.equal(options.shellPath, "/bin/bash"); assert.deepEqual(options.shellArgs, ["--noprofile", "--norc"]);
    terminal = create(options);
    return { show() { terminal.show(); }, sendText(text, newline) { command = text; terminal.sendText(text, newline); } };
  };
  try {
    context.deny(true); context.selectManagement("Activate registered Python in clean Bash terminal", "python", source.id);
    await context.manage(); assert.equal(terminal, undefined);
    context.deny(false); await context.manage();
    assert(terminal); assert(command.includes("source /dev/stdin"));
    const pid = await terminal.processId; assert(Number.isInteger(pid) && pid > 0);
    const evidence = path.join(context.root, "native-terminal-prefix.json");
    const program = `import json,sys;open(${JSON.stringify(evidence)},'w').write(json.dumps({'prefix':sys.prefix}))`;
    terminal.sendText(`python -I -B -c '${program.replace(/'/g, "'\\''")}'`, true);
    await context.wait(() => fs.existsSync(evidence));
    assert.equal(JSON.parse(fs.readFileSync(evidence)).prefix, source.root);
    terminal.dispose(); terminal = undefined;
    context.selectManagement("Review Python folder deletion script (manual only)", "python", source.id);
    await context.manage();
    copied = await vscode.env.clipboard.readText();
    assert(copied.includes("MANUAL ONLY")); assert(fs.existsSync(source.root));
    context.selectManagement("Migrate Python venv copy (keep original)", "python", source.id);
    context.deny(true); await context.manage(); context.deny(false);
    assert.equal(store.read().digest, before.digest);
    await context.manage();
    const migrated = store.read().catalog.entries.find(entry => entry.id === source.id);
    assert.notEqual(migrated.root, source.root); assert.deepEqual(migrated.legacyPython, source.legacyPython);
    assert(fs.existsSync(source.root)); assert(fs.existsSync(migrated.root));
    assert.deepEqual(fs.readFileSync(path.join(source.root, "pyvenv.cfg")), config);
    context.selectManagement("Remove synthetic Python to quarantine", "python", source.id); await context.manage();
    assert(!fs.existsSync(migrated.root)); assert(!store.read().catalog.entries.some(entry => entry.id === source.id));
    context.selectManagement("Restore quarantined Python folder", "python", source.id); await context.manage();
    assert(fs.existsSync(migrated.root)); assert.equal(store.read().catalog.entries.find(entry => entry.id === source.id).root, migrated.root);
    store.restore(before.catalog.revision, store.read().digest);
    assert.equal(store.read().catalog.entries.find(entry => entry.id === source.id).root, source.root);
    assert.deepEqual(fs.readFileSync(path.join(storage, "environments/registry.json")), registry);
    assert.deepEqual(context.errors, []);
    return { actualTerminalPid: pid, actualTerminalPrefix: source.root, sourcePreserved: true, sameIdMigrated: true,
      quarantineAndExplicitRestore: true, originalCatalogBindingRestored: true, originalRegistryUnchanged: true,
      deletionWasClipboardOnly: true, scriptedDecisions: true, visualInteractionQualified: false };
  } finally {
    terminal?.dispose(); vscode.window.createTerminal = create;
  }
};
