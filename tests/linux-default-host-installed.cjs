const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vscode = require("vscode");

exports.run = async () => {
  const { PKM_FIXTURE_ROOT: root, PKM_FIXTURE_VERSION: version } = process.env;
  const extension = vscode.extensions.getExtension("Uone.personal-knowledge");
  assert(extension);
  assert.equal(extension.packageJSON.version, version);
  assert.equal(extension.packageJSON.main, "./dist/extension.js");
  assert.equal(vscode.extensions.getExtension("pkm-nonproduction.pkm-v5"), undefined);
  assert(extension.packageJSON.contributes.mcpServerDefinitionProviders.some(provider => provider.id === "personalKnowledge.pkm"));
  const activationDeadline = Date.now() + 45_000;
  while (!extension.isActive && Date.now() < activationDeadline)
    await new Promise(resolve => setTimeout(resolve, 250));
  assert(extension.isActive, "The installed host did not activate automatically.");
  const store = require(path.join(extension.extensionPath, "dist/knowledge/filestore.js"));
  assert.equal(store.getStorePath(), root);
  assert.equal(vscode.workspace.getConfiguration("personalKnowledge").get("storePath"), root);
  await vscode.commands.executeCommand("personalKnowledge.openNote", "fixture.md");
  await vscode.commands.executeCommand("personalKnowledge.openApiChat");
  if (version === "4.0.22") return;
  const payload = JSON.parse(fs.readFileSync(path.join(extension.extensionPath, "next-runtime/manifest.json")));
  const deadline = Date.now() + 120_000;
  let status;
  do {
    status = await vscode.commands.executeCommand("_personalKnowledge.legacyRootUpgradeStatus");
    if (status && !["pending", "checking"].includes(status.state)) break;
    await new Promise(resolve => setTimeout(resolve, 250));
  } while (Date.now() < deadline);
  assert.equal(status?.state, "blocked", JSON.stringify(status));
  assert.equal(status.root, root);
  assert.equal(status.cutoverAuthorized, false);
  assert.equal(status.verifiedPayloadBuildId, payload.buildId);
  assert(status.blockers.some(blocker => blocker.code === "direct-adoption-unqualified"));
  console.log(`Installed compatible host verified Core ${status.verifiedPayloadBuildId}; original-root cutover blocked.`);
};
