const assert = require("node:assert/strict");
const { readFile, writeFile } = require("node:fs/promises");
const { join } = require("node:path");
const vscode = require("vscode");

exports.activate = async () => {
  const fixture = JSON.parse(process.env.PKM_INSTALLED_CORE_CHAT);
  const progress = async stage => writeFile(join(fixture.root, "progress.json"), JSON.stringify({ stage }));
  const wait = async name => {
    const deadline = Date.now() + 120000;
    while (Date.now() < deadline) {
      try { return JSON.parse(await readFile(join(fixture.root, name), "utf8")); }
      catch (error) { if (error.code !== "ENOENT" && !(error instanceof SyntaxError)) throw error; }
      await new Promise(resolve => setTimeout(resolve, 50));
    }
    throw new Error(`Installed Chat UI did not acknowledge ${name}`);
  };
  try {
    const extension = vscode.extensions.getExtension("pkm-nonproduction.pkm-v5");
    assert(extension && extension.extensionPath === fixture.installed);
    await extension.activate();
    assert(extension.isActive);
    await progress("business-token");
    await vscode.commands.executeCommand("pkm.nextHost.setToken");
    await progress("shared-token");
    await vscode.commands.executeCommand("pkm.nextHost.setSharedToken");
    await progress("management-token");
    await vscode.commands.executeCommand("pkm.nextHost.setSharedManagementToken");
    await vscode.commands.executeCommand("pkm.next.connect");
    await vscode.commands.executeCommand("pkm.nextHost.open");
    await progress("chat-open");
    await wait("reopen-request.json");
    await vscode.commands.executeCommand("workbench.action.closeActiveEditor");
    await vscode.commands.executeCommand("pkm.nextHost.open");
    await progress("chat-reopened");
    await wait("handoff-request.json");
    await progress("handoff");
    const config = vscode.workspace.getConfiguration("pkm.nextHost");
    await config.update("sharedServer", {
      ...config.get("sharedServer"), generation: fixture.secondGeneration,
    }, vscode.ConfigurationTarget.Global);
    await wait("handoff-verified.json");
    await progress("handoff-complete");
    await wait("ui-passed.json");
    await writeFile(join(fixture.root, "runner-passed.json"), JSON.stringify({
      passed: true, extensionId: extension.id, extensionPath: extension.extensionPath,
      extensionActive: extension.isActive, extensionHostPid: process.pid,
      tokenProvisioning: "genuine contributed commands and native password InputBox; installed SecretStorage",
      fakeVscodeApi: false, sourcePanelImported: false,
    }));
    await progress("complete");
  } catch (error) {
    await writeFile(join(fixture.root, "progress.json"), JSON.stringify({ stage: "failed", error: String(error.stack || error) }));
  }
};
