const vscode = require("vscode"), fs = require("node:fs"), path = require("node:path");
exports.activate = async () => {
  const fixture = process.env.PKM_ORDINARY_ENV_FIXTURE;
  const phase = fs.readFileSync(path.join(fixture, "phase"), "utf8");
  try {
    const receipt = JSON.parse(fs.readFileSync(path.join(fixture, "fixture-receipt.json")));
    const extension = vscode.extensions.getExtension("Uone.personal-knowledge");
    if (!extension) throw Error("Original extension ID is not installed.");
    await extension.activate();
    const registry = require(path.join(extension.extensionPath, "dist/servers/pyenvs.js"));
    const store = require(path.join(extension.extensionPath, "dist/knowledge/filestore.js"));
    const entries = registry.pyenvList();
    if (!entries.some(entry => entry.id === receipt.id) || !entries.some(entry => entry.id === receipt.venvId))
      throw Error("The actual activated extension did not reuse the original registry.");
    if (path.resolve(store.getStorePath()) !== receipt.knowledgeRoot) throw Error("Actual Root changed.");
    const gate = vscode.workspace.getConfiguration("personalKnowledge").get("experimental.localEnvironmentUpgrade", false);
    if (gate) throw Error("Next import gate must stay disabled.");
    await vscode.commands.executeCommand("personalKnowledge.open");
    fs.writeFileSync(path.join(fixture, `host-${phase}.json`), JSON.stringify({
      phase, version: extension.packageJSON.version, extensionPath: extension.extensionPath,
      actualRoot: store.getStorePath(), registry: entries, gate,
    }, null, 2));
    const timer = setInterval(() => {
      if (fs.existsSync(path.join(fixture, `close-${phase}`))) {
        clearInterval(timer); void vscode.commands.executeCommand("workbench.action.closeWindow");
      }
    }, 100);
  } catch (error) {
    fs.writeFileSync(path.join(fixture, `host-error-${phase}.txt`), String(error.stack || error));
  }
};
