import * as vscode from "vscode";
import { execFile } from "node:child_process";
import { isAbsolute, join } from "node:path";

type Inspection = {
  source: string;
  destination: string;
  python: string;
  plan: { ready: boolean; planSha256: string; blockers: unknown[] };
  blockers: unknown[];
};

function runHelper(node: string, helper: string, request: object): Promise<any> {
  return new Promise((resolve, reject) => {
    // No shell, PATH runtime discovery, inherited Node injection, or automatic retry.
    const env = { ...process.env };
    delete env.NODE_OPTIONS;
    delete env.NODE_PATH;
    delete env.ELECTRON_RUN_AS_NODE;
    const child = execFile(node, [helper], { env, maxBuffer: 64 * 1024 * 1024, windowsHide: true }, (error, stdout) => {
      if (error) { reject(new Error("Migration helper failed. Requires Node >=22.18 with node:sqlite. No automatic retry; reconcile the destination before retrying.")); return; }
      try {
        const result = JSON.parse(stdout);
        if (result.error) reject(new Error(`${result.error.code}: ${result.error.message}`));
        else resolve(result);
      } catch (error) { reject(error); }
    });
    child.stdin!.on("error", () => {});
    child.stdin!.end(JSON.stringify(request));
  });
}

export function registerFirstRunImport(context: vscode.ExtensionContext, output: vscode.OutputChannel): vscode.Disposable[] {
  let pending: { node: string; inspection: Inspection } | undefined;
  let busy = false;
  let disposed = false;
  const helper = join(context.extensionPath, "dist", "migration", "src", "import-helper.js");
  const pick = async (title: string, folders: boolean) => {
    const values = await vscode.window.showOpenDialog({
      title, canSelectFiles: !folders, canSelectFolders: folders, canSelectMany: false,
    });
    if (!values?.length) return;
    const uri = values[0];
    if (uri.scheme !== "file" || !isAbsolute(uri.fsPath)) throw new Error("Select an explicit absolute local filesystem path.");
    return uri.fsPath;
  };
  const guarded = (operation: () => Promise<void>) => async () => {
    if (disposed) return;
    if (busy) { await vscode.window.showWarningMessage("A migration operation is already running."); return; }
    busy = true;
    try { await operation(); }
    catch (error) {
      pending = undefined;
      const message = error instanceof Error ? error.message : "Migration failed";
      output.appendLine(message);
      output.show();
      await vscode.window.showErrorMessage(`PKM Next import: ${message}`);
    } finally { busy = false; }
  };
  return [
    vscode.commands.registerCommand("pkm.nextHost.importPreview", guarded(async () => {
      pending = undefined;
      const source = await pick("Select a quiescent DISPOSABLE legacy copy (never the live Knowledge Root)", true);
      if (!source) return;
      const destinationUri = await vscode.window.showSaveDialog({
        title: "Choose a NEW isolated destination directory path (must not exist)",
        saveLabel: "Select destination path",
      });
      if (!destinationUri) return;
      if (destinationUri.scheme !== "file" || !isAbsolute(destinationUri.fsPath))
        throw new Error("Select an explicit absolute local destination.");
      const destination = destinationUri.fsPath;
      const node = await pick("Select trusted Node.js executable (>=22.18, node:sqlite required)", false);
      if (!node) return;
      const python = await pick("Select trusted Python executable for atomic no-replace publication", false);
      if (!python) return;
      const acknowledge = "Inspect disposable copy";
      if (await vscode.window.showWarningMessage(
        `Read-only inspection only.\nSource: ${source}\nDestination: ${destination}\nI confirm the source is a quiescent disposable copy, not production data. No import or cutover is authorized.`,
        { modal: true }, acknowledge) !== acknowledge || disposed) return;
      const inspection: Inspection = await runHelper(node, helper, { action: "inspect", source, destination, python });
      if (disposed) return;
      output.appendLine("FIRST-RUN IMPORT PREVIEW — read-only; no import, publication, or cutover");
      output.appendLine(JSON.stringify(inspection, null, 2));
      output.show();
      if (!inspection.plan.ready || inspection.blockers.length) {
        await vscode.window.showWarningMessage("Import blocked. Review exact diagnostics in PKM Next Experimental output. Preserve the copy, resolve blockers with the appropriate native authority, then preview again. No approval was retained.");
        return;
      }
      pending = { node, inspection };
      await vscode.window.showInformationMessage("Review the read-only plan in PKM Next Experimental output, then run “PKM Next (Experimental): Confirm Inspected Import”. Nothing has been imported.");
    })),
    vscode.commands.registerCommand("pkm.nextHost.importConfirm", guarded(async () => {
      const approved = pending;
      pending = undefined;
      if (!approved) { await vscode.window.showWarningMessage("No ready inspected plan. Run Preview First-Run Import first."); return; }
      const { inspection, node } = approved;
      const confirm = "Import exact inspected plan";
      if (await vscode.window.showWarningMessage(
        `Create and publish a NEW isolated workspace?\nSource: ${inspection.source}\nDestination: ${inspection.destination}\nPlan SHA-256: ${inspection.plan.planSha256}\nNode: ${node}\nPython: ${inspection.python}\nThis writes staging/receipt files beside the destination and publishes without replacement. Source must remain quiescent. No production service switch or automatic replay.`,
        { modal: true }, confirm) !== confirm || disposed) return;
      const result = await runHelper(node, helper, { action: "import", inspection });
      output.appendLine(JSON.stringify(result, null, 2));
      output.show();
      await vscode.window.showInformationMessage("Isolated import published. No service was connected or switched. This is not full migration or cutover qualification.");
    })),
    { dispose() { disposed = true; pending = undefined; } },
  ];
}
