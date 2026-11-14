"use strict";
const fs = require("node:fs");
const vscode = require("vscode");
exports.activate = async () => {
  const extension = vscode.extensions.getExtension("uone.personal-knowledge");
  if (!extension) throw new Error("Synthetic installed extension is unavailable.");
  await extension.activate();
  await vscode.commands.executeCommand("personalKnowledge.openSubscriptions");
  fs.writeFileSync(process.env.PKM_NATIVE_SUBSCRIPTION_DRIVER_READY, "ready", { mode: 0o600 });
};
