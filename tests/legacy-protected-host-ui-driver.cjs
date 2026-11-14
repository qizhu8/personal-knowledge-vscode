const vscode = require("vscode");
const fs = require("node:fs");
const path = require("node:path");

exports.activate = async () => {
  const fixture = process.env.PKM_PRIVATE_SUBSCRIPTION_STATE_IMPORT;
  const config = JSON.parse(fs.readFileSync(path.join(fixture, "driver-config.json"), "utf8"));
  let opened = false;
  let reason;
  try {
    const extension = vscode.extensions.getExtension("Uone.personal-knowledge");
    if (!extension) throw new Error();
    await extension.activate();
    const request = path.join(fixture, "ui-driver-open");
    for (let attempt = 0; attempt < 600 && !fs.existsSync(request); attempt++)
      await new Promise(resolve => setTimeout(resolve, 100));
    if (!fs.existsSync(request)) throw new Error();
    const result = await vscode.commands.executeCommand("personalKnowledge.openIsolatedSubscriptionUiFixture",
      { nonce: config.nonce, shareId: config.shareId });
    opened = result?.opened === true;
  } catch (error) {
    const messages = ["Private Subscription signing denied.", "Private remote Subscription transport denied.",
      "Private Subscription UI denied.", "Private Subscription binding denied."];
    if (error instanceof Error && messages.includes(error.message)) reason = error.message;
  }
  fs.writeFileSync(path.join(fixture, "ui-driver-result.json"), JSON.stringify({ opened, ...(reason ? { reason } : {}) }), { mode: 0o600 });
};
