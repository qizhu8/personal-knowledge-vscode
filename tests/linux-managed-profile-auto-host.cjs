"use strict";
const fs = require("node:fs");
const path = require("node:path");
const vscode = require("vscode");

exports.activate = async context => {
  const { PKM_PROFILE_ROOT: root, PKM_PROFILE_CONTROL: control } = process.env;
  const label = process.env.PKM_PROFILE_LABEL_FROM_WORKSPACE === "1"
    ? path.basename(vscode.workspace.workspaceFolders?.[0]?.uri.fsPath || "") : process.env.PKM_PROFILE_LABEL;
  if (control && label) fs.writeFileSync(path.join(control, `${label}-activation-start-${process.pid}`), "");
  try {
  const extension = vscode.extensions.getExtension("uone.personal-knowledge");
  if (!root || !control || !label || !extension) throw new Error("Missing private profile fixture.");
  await extension.activate();
  const store = require(path.join(extension.extensionPath, "dist/knowledge/filestore.js"));
  if (fs.realpathSync(store.getStorePath()) !== fs.realpathSync(root)) throw new Error("Wrong fixture root.");
  const commands = await vscode.commands.getCommands(false);
  const enrolled = commands.includes("_personalKnowledge.managedWriterSessionStatus");
  const status = enrolled ? await vscode.commands.executeCommand("_personalKnowledge.managedWriterSessionStatus") : null;
  fs.writeFileSync(path.join(control, `${label}-ready-${process.pid}.json`), JSON.stringify({
    pid: process.pid, version: extension.packageJSON.version, session: process.env.PKM_MANAGED_WRITER_SESSION || null,
    extensionPath: extension.extensionPath, globalStorage: context.globalStorageUri.fsPath, status,
  }), { flag: "wx" });
  let started = false, discovered = false, inspected = false, oldWritten = false;
  const timer = setInterval(() => {
    if (enrolled && !started && fs.existsSync(path.join(control, `${label}-git`))) {
      started = true;
      fs.unlinkSync(path.join(control, `${label}-git`));
      const { withManagedWriterOperation } = require(path.join(extension.extensionPath, "dist/runtime/managed-writer-session.js"));
      const { supervisedLegacyGit } = require(path.join(extension.extensionPath, "dist/runtime/linux-git-supervisor.js"));
      void withManagedWriterOperation(root, "github-sync", async () => {
        const git = supervisedLegacyGit(["-C", path.join(root, "repo"), "commit", "-m", "private fixture"],
          { cwd: root, env: process.env, timeout: 30000, maxBuffer: 1024 * 1024 });
        if (!git) throw new Error("Managed Git supervisor unavailable.");
        await git;
      }).then(() => fs.writeFileSync(path.join(control, `${label}-git-returned`), ""),
        error => fs.writeFileSync(path.join(control, `${label}-git-error`), String(error)));
    }
    if (enrolled && !discovered && fs.existsSync(path.join(control, `${label}-discover`))) {
      discovered = true;
      void vscode.commands.executeCommand("_personalKnowledge.managedWriterSessionDiscover").then(
        result => fs.writeFileSync(path.join(control, `${label}-discovered-${process.pid}.json`), JSON.stringify(result)),
        error => fs.writeFileSync(path.join(control, `${label}-discover-error-${process.pid}`), String(error)));
    }
    if (enrolled && !inspected && fs.existsSync(path.join(control, `${label}-inspect`))) {
      inspected = true;
      const base = path.dirname(path.dirname(context.globalStorageUri.fsPath));
      const index = path.basename(path.dirname(base)) === "profiles" ? path.join(base, "extensions.json") : undefined;
      const runtime = require(path.join(extension.extensionPath, "dist/runtime/extension-host-runtime.js"));
      const installed = runtime.readInstalledExtensionRuntime(extension.extensionPath, extension.id, index);
      const compatible = installed && require(path.join(extension.extensionPath, "dist/runtime/managed-profile-activation.js"))
        .installedManagedProfileCompatible(installed.directory);
      const observed = vscode.extensions.getExtension("uone.personal-knowledge");
      void vscode.commands.executeCommand("_personalKnowledge.managedWriterSessionStatus").then(status =>
        fs.writeFileSync(path.join(control, `${label}-inspect-result.json`), JSON.stringify({
          globalStorage: context.globalStorageUri.fsPath, index, installed, loaded: runtime.loadedExtensionBuild, compatible, status,
          observed: observed && { version: observed.packageJSON.version, path: observed.extensionPath },
        })));
    }
    if (!enrolled && !oldWritten && fs.existsSync(path.join(control, `${label}-old-write`))) {
      oldWritten = true;
      try {
        store.noteUpsert({ slug: "legacy-after-stop", title: "Legacy After Stop", type: "note",
          content: "Synthetic stale-profile write." });
        fs.writeFileSync(path.join(control, `${label}-old-write-result`), "written");
      } catch (error) {
        fs.writeFileSync(path.join(control, `${label}-old-write-error`), String(error));
      }
    }
  }, 50);
  context.subscriptions.push({ dispose: () => clearInterval(timer) });
  } catch (error) {
    if (control && label) fs.writeFileSync(path.join(control, `${label}-activation-error-${process.pid}`), String(error?.stack || error));
    throw error;
  }
};
