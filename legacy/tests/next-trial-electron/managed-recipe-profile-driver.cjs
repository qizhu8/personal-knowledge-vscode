"use strict";
const fs = require("node:fs"), path = require("node:path"), vscode = require("vscode");
exports.run = async () => {
  const fixture = process.env.PKM_MANAGED_RECIPE_FIXTURE;
  if (!fixture || !fs.existsSync(path.join(fixture, "private-recipe-fixture-token"))) throw Error("Private fixture required.");
  const extension = vscode.extensions.getExtension("uone.personal-knowledge");
  if (!extension) throw Error("The actual PKM VSIX must be installed.");
  await extension.activate();
  if (extension.packageJSON.version !== "4.0.22") {
    let status;
    for (let attempt = 0; attempt < 120; attempt++) {
      status = await vscode.commands.executeCommand("_personalKnowledge.legacyRootUpgradeStatus");
      if (!status || !["pending", "checking"].includes(status.state)) break;
      await new Promise(resolve => setTimeout(resolve, 200));
    }
    fs.writeFileSync(path.join(fixture, "original-root-ordinary-status.json"), JSON.stringify(status ?? null));
  }
  fs.writeFileSync(path.join(fixture, "renderer-driver-ready.json"), JSON.stringify({
    extension: extension.extensionPath, version: extension.packageJSON.version, trusted: vscode.workspace.isTrusted,
  }));
  await new Promise(resolve => {
    const timer = setInterval(() => {
      if (fs.existsSync(path.join(fixture, "renderer-driver-finish"))) { clearInterval(timer); resolve(); }
    }, 100);
  });
};
