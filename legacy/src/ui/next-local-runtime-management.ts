import * as vscode from "vscode";
import { randomUUID } from "crypto";
import { LocalEnvironmentCatalog, inspectLocalEnvironment, type CatalogView, type LocalEnvironment } from "../runtime/local-environment-catalog";
import { inspectNodeProject, discoverLocalExecutors } from "../runtime/local-node-project";

export const runtimeManagementActions = [
  "Register Node.js project environment", "Discover local Node.js runtimes",
  "Discover local C# executor sets", "Reconfigure registered runtime or executor set",
];
export async function manageLocalRuntime(action: string, store: LocalEnvironmentCatalog, view: CatalogView,
  check: () => void, confirm: (detail: string) => Promise<boolean>): Promise<void> {
  const verify = (entry: LocalEnvironment) => {
    check();
    const status = inspectLocalEnvironment(entry);
    if (!status.available) throw new Error(status.issues.join(" "));
    if (entry.manager === "node-project") inspectNodeProject(entry.root!);
  };
  if (action === "Reconfigure registered runtime or executor set") {
    const selected = await vscode.window.showQuickPick(view.catalog.entries.filter(entry =>
      entry.language === "csharp" && entry.kind === "executor-set"
      || entry.language === "javascript" && (entry.kind === "runtime" || entry.manager === "node-project"))
      .map(entry => ({ label: entry.name, description: entry.id, entry })));
    if (!selected) return;
    const name = await vscode.window.showInputBox({ prompt: "Display name; environment ID stays unchanged", value: selected.entry.name });
    if (name === undefined) return;
    const input = await vscode.window.showInputBox({ prompt: "Explicit named executors as JSON [{id,executable}]; existing files only",
      value: JSON.stringify(selected.entry.executors) });
    if (input === undefined) return;
    const executors = JSON.parse(input) as LocalEnvironment["executors"];
    const root = selected.entry.manager === "node-project" ? await vscode.window.showInputBox({
      prompt: "Canonical project folder containing package.json; changing this explicitly rebinds this ID", value: selected.entry.root,
    }) : selected.entry.root;
    if (selected.entry.manager === "node-project" && root === undefined) return;
    const entry = { ...selected.entry, name, executors, ...(root !== undefined ? { root } : {}) };
    verify(entry);
    if (!await confirm(`Reconfigure ${entry.id}\nBefore: ${JSON.stringify(selected.entry)}\nAfter: ${JSON.stringify(entry)}\nAll previous runtime selections become stale. Metadata only; runtime files, old registry and installed tools are unchanged.`)) return;
    verify(entry);
    store.configureRuntime(entry.id, name, executors, view.digest, root);
    await vscode.window.showInformationMessage("Configuration saved with the same environment ID. Reselect and approve before execution.");
    return;
  }
  const nodeProject = action === "Register Node.js project environment";
  const folders = await vscode.window.showOpenDialog({ canSelectMany: false, canSelectFiles: false, canSelectFolders: true,
    openLabel: nodeProject ? "Select an existing owned Node project (package.json, no install/build)" : "Inspect only this installed executable folder (no PATH scan or probes)" });
  if (!folders?.length) return;
  let entry: LocalEnvironment;
  if (nodeProject) {
    const project = inspectNodeProject(folders[0].fsPath);
    const runtimes = view.catalog.entries.filter(item => item.language === "javascript" && item.kind === "runtime"
      && item.executors.some(executor => executor.id === "node"));
    const runtime = await vscode.window.showQuickPick(runtimes.map(item => ({ label: item.name, description: item.id, entry: item })),
      { placeHolder: "Select an explicitly registered Node runtime; no engine download or version fallback" });
    if (!runtime) {
      if (!runtimes.length) await vscode.window.showInformationMessage("Register/discover an already installed Node runtime first. Nothing was installed.");
      return;
    }
    entry = { id: `local-${randomUUID()}`, name: project.name, language: "javascript", kind: "environment",
      manager: "node-project", root: project.root, executors: [runtime.entry.executors.find(item => item.id === "node")!] };
    if (!await confirm(`Register project ${project.root}\n${JSON.stringify(project)}\nNode: ${entry.executors[0].executable}\nNo package script, dependency install, version probe or build runs. CommonJS entry selection and separate approval are required for execution.`)) return;
  } else {
    const node = action === "Discover local Node.js runtimes";
    const found = discoverLocalExecutors(folders[0].fsPath, node ? "javascript" : "csharp");
    const selected = await vscode.window.showQuickPick(found.map(executor => ({
      label: `${executor.id}: ${executor.executable}`, description: executor.target, executor,
    })), { canPickMany: true, placeHolder: node ? "Select one installed Node executable" : "Select named C# tools; only the existing .NET 8 provider is executable, other tools remain metadata" });
    if (!selected?.length) {
      if (!found.length) await vscode.window.showInformationMessage("No known executable in that folder; no recursive/PATH search, installer or download was used.");
      return;
    }
    if (node && selected.length !== 1) throw new Error("Select exactly one Node runtime, not multiple aliases.");
    const name = await vscode.window.showInputBox({ prompt: node ? "Node runtime name" : "C# executor set name",
      value: node ? "Local Node" : "Local C# executor set" });
    if (!name) return;
    entry = { id: `local-${randomUUID()}`, name, language: node ? "javascript" : "csharp",
      kind: node ? "runtime" : "executor-set", manager: "local",
      executors: selected.map(item => ({ id: item.executor.id, executable: item.executor.executable })) };
    if (!await confirm(`Register ${entry.kind}\n${entry.executors.map(item => `${item.id}: ${item.executable}`).join("\n")}\nNo tool was executed. A C# set has no required virtualenv/root; SDK qualification happens separately before execution.`)) return;
  }
  verify(entry);
  store.register(entry, view.digest);
  await vscode.window.showInformationMessage(`Registered ${entry.id}; metadata is not execution approval.`);
}
