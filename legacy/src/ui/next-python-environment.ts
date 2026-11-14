import * as vscode from "vscode";
import { pyenvList, pyenvRegistryReady } from "../servers/pyenvs";
import { PythonEnvironmentAuthority } from "../runtime/python-environment-authority";
import type { NextManagedClient } from "../runtime/next-managed-client";
import { registerNextLocalEnvironments } from "./next-local-environments";

/** Separate host command: no webview/MCP request can choose an executable or script. */
export function registerNextPythonEnvironment(context: vscode.ExtensionContext, current: () => NextManagedClient | undefined): void {
  registerNextLocalEnvironments(context, current);
  let busy = false;
  context.subscriptions.push(vscode.commands.registerCommand("personalKnowledge.nextTrialPython", async () => {
    if (busy) { void vscode.window.showErrorMessage("A Python trial is already pending."); return; }
    busy = true;
    const owner = current(), workspace = vscode.workspace.workspaceFile?.toString()
      ?? vscode.workspace.workspaceFolders?.map(folder => folder.uri.toString()).join("\n");
    const authority = new PythonEnvironmentAuthority(() => vscode.workspace.isTrusted && current() === owner
      && workspace === (vscode.workspace.workspaceFile?.toString()
        ?? vscode.workspace.workspaceFolders?.map(folder => folder.uri.toString()).join("\n")));
    try {
      if (!owner || !vscode.workspace.isTrusted) throw new Error("Open a trusted workspace and start a fresh isolated Next trial first.");
      if (!pyenvRegistryReady()) throw new Error("Wait for the host environment registry to finish initialization.");
      const workspaceId = owner.pythonWorkspaceId();
      const selected = await vscode.window.showQuickPick(pyenvList().map(env => ({
        label: env.name, description: `${env.id} · ${env.manager}`, detail: env.python, environmentId: env.id,
      })), { placeHolder: "Choose an already registered Python environment (no creation, install, migration or deletion)" });
      if (!selected) return;
      const handle = authority.select(workspaceId, "local:owner", selected.environmentId);
      const decision = await vscode.window.showWarningMessage("Run the fixed Python Workflow trial in this registered environment?",
        { modal: true, detail: `Trusted VS Code workspace: ${workspace ?? "(empty trusted window)"}\nIsolated Next workspace: ${workspaceId}\nActor: local:owner\nEnvironment: ${handle.environmentId}\nRoot: ${handle.root}\nInterpreter: ${handle.executable}\nCanonical target: ${handle.target}\nScript: print(7)\nRuns with your OS user permissions, not a sandbox. No shell, pip, package changes or network operation is requested. Approval is only for this run; restart/restore requires selection again.` },
        "Approve Python Workflow");
      if (decision !== "Approve Python Workflow") return;
      authority.validate(handle, owner.pythonWorkspaceId(), "local:owner");
      const result = await owner.runPythonTrial(authority, handle);
      if (result.state !== "succeeded") throw new Error(`${result.error ?? "Python Workflow did not succeed"} Run: ${result.runId}; exit: ${result.exitCode ?? "none"}.`);
      await vscode.window.showInformationMessage(`Python Workflow ${result.state}: ${result.stdout.trim()} · environment ${result.environmentId} · ${result.runId}`);
    } catch (error) {
      void vscode.window.showErrorMessage(`PKM Next Python: ${error instanceof Error ? error.message : "Execution unavailable."} No automatic retry.`);
    } finally { authority.revoke(); busy = false; }
  }));
}
