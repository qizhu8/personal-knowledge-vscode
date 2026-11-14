const vscode = require("vscode");
const fs = require("node:fs");
const path = require("node:path");

exports.activate = async () => {
  const fixture = process.env.PKM_PRIVATE_SUBSCRIPTION_STATE_IMPORT;
  const config = JSON.parse(fs.readFileSync(path.join(fixture, "driver-config.json"), "utf8"));
  let ok = false;
  try {
    const extension = vscode.extensions.getExtension("Uone.personal-knowledge");
    if (!extension) throw new Error();
    await extension.activate();
    const result = await vscode.commands.executeCommand("personalKnowledge.runIsolatedProtectedSubscriptionFixture",
      { nonce: config.nonce, shareId: config.shareId });
    ok = result?.delivered === true;
  } catch { /* Do not persist host diagnostics that might contain credentials. */ }
  fs.writeFileSync(path.join(fixture, "driver-result.json"), JSON.stringify({ ok }), { mode: 0o600 });
  await vscode.commands.executeCommand("workbench.action.quit");
};
