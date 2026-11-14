import * as vscode from "vscode";
import * as fs from "fs";
import * as path from "path";
import { PythonEnvironmentAuthority } from "../runtime/python-environment-authority";
import { PythonProgramAuthority } from "../runtime/python-program-authority";
import type { LocalEnvironmentCatalog } from "../runtime/local-environment-catalog";
import type { LocalJournalHandle, LocalRuntimeAuthority } from "../runtime/local-runtime-authority";
import type { NextManagedClient } from "../runtime/next-managed-client";
import type { EnvManager } from "../servers/pyenvs";

export async function runReviewedPythonProgram(options: {
  owner: NextManagedClient; catalog: LocalEnvironmentCatalog; authority: LocalRuntimeAuthority;
  journal: LocalJournalHandle; check(): string;
}): Promise<void> {
  const { owner, catalog, authority, journal } = options, view = catalog.read();
  const check = () => {
    options.check();
    if (vscode.workspace.getConfiguration("personalKnowledge").get<boolean>("experimental.localEnvironmentUpgrade", false) !== true
      || catalog.read().digest !== view.digest) throw new Error("Python experimental gate/catalog changed; select and approve again.");
    return true;
  };
  check();
  const environments = new PythonEnvironmentAuthority(() => { try { return check(); } catch { return false; } },
    () => catalog.read().catalog.entries.filter(item => item.language === "python" && item.kind === "environment")
      .map(item => ({ id: item.id, name: item.name, manager: item.manager as EnvManager,
        path: item.root!, python: item.executors[0].executable })));
  const programs = new PythonProgramAuthority(() => { try { return check(); } catch { return false; } }, environments);
  try {
    const selected = await vscode.window.showQuickPick(view.catalog.entries
      .filter(item => item.language === "python" && item.kind === "environment")
      .map(item => ({ label: item.name, description: item.id, entry: item })));
    if (!selected) return;
    const handle = environments.select(owner.pythonWorkspaceId(), "local:owner", selected.entry.id);
    const files = await vscode.window.showOpenDialog({ canSelectMany: false, canSelectFiles: true,
      canSelectFolders: false, openLabel: "Review Python Workflow JSON in this trusted workspace (not an execution grant)" });
    if (!files?.length) return;
    const file = files[0].fsPath, folder = vscode.workspace.workspaceFolders?.find(folder => {
      const child = path.relative(folder.uri.fsPath, file); return child && !child.startsWith("..") && !path.isAbsolute(child);
    });
    if (!folder) throw new Error("The reviewed Workflow must be inside a current trusted workspace folder.");
    const input = await vscode.window.showInputBox({ prompt: "Exact Workflow inputs as a JSON object; args may use {{ inputs.key }} primitive values", value: "{}" });
    if (input === undefined) return;
    const inputs = JSON.parse(input);
    if (!inputs || Array.isArray(inputs) || typeof inputs !== "object" || Buffer.byteLength(input) > 4096)
      throw new Error("Bounded JSON object inputs are required.");
    const program = programs.select(handle, fs.realpathSync(folder.uri.fsPath), file, owner.pythonWorkspaceDirectory(), inputs);
    const answer = await vscode.window.showWarningMessage("Run this exact reviewed Python Workflow with OS user permissions?",
      { modal: true, detail: `Actor: local:owner\nWorkspace: ${handle.workspaceId}\nCWD: ${program.cwd}\nEnvironment: ${handle.environmentId}\nRoot: ${handle.root}\nInterpreter: ${handle.executable}\nTarget: ${handle.target}\nSource: ${file}\nSource SHA-256: ${program.sourceFile.sha256}\nExecutable digest: ${program.executableDigest}\nInputs: ${JSON.stringify(program.inputs)}\nExact definition (script and argv templates):\n${JSON.stringify(program.definition, null, 2)}\nNo sandbox: reviewed scripts have your OS permissions. Native launch uses -I -B - and literal argv, empty inherited environment; no automatic installation/download. Definition, inputs and bounded output persist in the private environment journal. One run only; restart recovers UNKNOWN without replay, never approval.` },
      "Approve exact Python Workflow");
    check();
    if (answer !== "Approve exact Python Workflow") return;
    programs.validate(program, owner.pythonWorkspaceId());
    programs.approve(program, owner.pythonWorkspaceId());
    await owner.localEnvironmentCommand(authority, journal, { operation: "open", recover: false });
    const initial = await owner.localEnvironmentCommand(authority, journal, { operation: "start-python", program }, programs);
    const runId = initial[0]?.runId; if (!runId) throw new Error("Python admission receipt missing; inspect history, do not replay.");
    const result = await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, cancellable: true,
      title: `Reviewed Python Workflow: ${runId}` }, async (_progress, token) => {
      let cancel: Promise<unknown> | undefined;
      const subscription = token.onCancellationRequested(() => {
        cancel ??= owner.localEnvironmentCommand(authority, journal, { operation: "cancel", runId });
        void cancel.catch(() => undefined);
      });
      try {
        for (;;) {
          options.check(); if (cancel) await cancel;
          const run = (await owner.localEnvironmentCommand(authority, journal, { operation: "status" })).find(item => item.runId === runId);
          if (!run) throw new Error("Python receipt missing; preserve history.");
          if (!["ready", "running"].includes(run.state) && run.jobs.every(job => !["RUNNING", "QUEUED"].includes(job.state))) return run;
          await new Promise(resolve => setTimeout(resolve, 100));
        }
      } finally { subscription.dispose(); }
    });
    await vscode.window.showInformationMessage(`Reviewed Python ${result.runId}: ${result.state}, effect ${result.effect}\n${result.jobs.map(job => `${job.phase}: ${job.state}\n${job.stdout}${job.stderr}`).join("\n")}`);
  } finally { programs.revoke(); environments.revoke(); }
}
