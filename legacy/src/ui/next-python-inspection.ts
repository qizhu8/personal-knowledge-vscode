import * as vscode from "vscode";
import * as path from "path";
import { LocalEnvironmentCatalog, type CatalogView, type LocalEnvironment } from "../runtime/local-environment-catalog";
import { PythonEnvironmentAuthority } from "../runtime/python-environment-authority";
import { LocalPythonManagerAuthority } from "../runtime/local-python-managers";
import { inspectPythonFolder } from "../runtime/local-python-management";
import { humanSize, type PyEnv } from "../servers/pyenvs";
import { readPythonMetadataSnapshot, refreshPythonMetadata, listInstalledCondaEnvironments } from "../runtime/local-python-inspection";
import { generatePythonMergeScript, condaManualDeleteScript } from "../runtime/local-python-merge";
import { showPythonReport, markdownCell } from "./next-python-packages";

export const pythonInspectionActions = ["View registered Python version and size snapshot", "Refresh registered Python version and allocated size",
  "List installed conda environments and register a prefix", "Preview and copy Python merge script", "Preview and copy conda manual deletion script"];
export async function managePythonInspection(action: string, store: LocalEnvironmentCatalog, view: CatalogView,
  storage: string, check: () => void): Promise<void> {
  const entries = view.catalog.entries.filter(e => e.language === "python" && e.kind === "environment");
  const fresh = () => { check(); if (store.read().digest !== view.digest) throw new Error("Catalog changed; select and review again."); };
  const items = (condaOnly = false) => entries.filter(e => !condaOnly || e.manager === "conda")
    .map(entry => ({ label: entry.name, description: entry.id, entry }));
  async function progress<T>(title: string, task: (signal: AbortSignal, report: (phase: string) => void) => Promise<T>) {
    return vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, cancellable: true, title }, async (reporter, token) => {
      const abort = new AbortController(), subscription = token.onCancellationRequested(() => abort.abort());
      if (token.isCancellationRequested) abort.abort();
      try { return await task(abort.signal, phase => reporter.report({ message: phase })); } finally { subscription.dispose(); }
    });
  }
  const managers = new LocalPythonManagerAuthority(() => { try { fresh(); return true; } catch { return false; } });
  try {
    fresh();
    if (action === pythonInspectionActions[2]) {
      const files = await vscode.window.showOpenDialog({ canSelectMany: false, canSelectFiles: true, canSelectFolders: false,
        openLabel: "Select already-installed conda; query only, no archive cache" });
      if (!files?.length) return;
      const tool = managers.selectCondaQuery(files[0].fsPath);
      const source = await vscode.window.showQuickPick(["Tool base only", "Selected inventory file copy", "Selected envs directory"],
        { placeHolder: "No implicit real HOME/config discovery; explicitly choose local inventory scope" });
      if (!source) return;
      let inventoryFile: string | undefined, envsDirectory: string | undefined;
      if (source !== "Tool base only") {
        const selected = await vscode.window.showOpenDialog({ canSelectMany: false,
          canSelectFiles: source === "Selected inventory file copy", canSelectFolders: source === "Selected envs directory",
          openLabel: source === "Selected inventory file copy" ? "Select environments.txt to copy read-only into private HOME" : "Select read-only conda envs directory" });
        if (!selected?.length) return;
        if (source === "Selected inventory file copy") inventoryFile = selected[0].fsPath;
        else envsDirectory = selected[0].fsPath;
      }
      const decision = await vscode.window.showWarningMessage("Query this installed conda inventory without changing environments?",
        { modal: true, detail: `${tool.executable} env list --json\nScope: ${inventoryFile || envsDirectory || "tool base only"}\nOS-user tool execution, not a sandbox. Private offline HOME/config/cache; selected inventory is copied, never rewritten. No installation, repair, package refresh, legacy registry/cache write or execution grant. Selecting a result previews a separate catalog registration.` },
        "Query selected inventory");
      fresh(); if (decision !== "Query selected inventory") return;
      const result = await progress("Explicit offline conda inventory", (signal, report) => listInstalledCondaEnvironments({
        storage, store, expected: view.digest, check: fresh, authority: managers, tool, inventoryFile, envsDirectory, signal, report }));
      fresh();
      await showPythonReport(["# Selected conda inventory", "", result.scope, `Retained query work: ${markdownCell(result.retainedWork)}`,
        ...result.roots.map(root => `- ${markdownCell(root)}`)].join("\n"));
      const selected = await vscode.window.showQuickPick(result.roots.map(root => ({ label: path.basename(root), description: root, root })),
        { placeHolder: "Optionally register one existing prefix; cancel keeps catalog unchanged" });
      if (!selected) return;
      const entry = inspectPythonFolder(selected.root, path.basename(selected.root));
      if (entry.manager !== "conda") throw new Error("Inventory result is not an available conda prefix.");
      const registered = entries.find(e => e.root === entry.root);
      if (registered) { await vscode.window.showInformationMessage(`Already registered as ${registered.id}; no duplicate or rebind.`); return; }
      const handle = new PythonEnvironmentAuthority(() => { try { fresh(); return true; } catch { return false; } },
        () => [{ id: entry.id, name: entry.name, manager: "conda", path: entry.root!, python: entry.executors[0].executable }]);
      try {
        const selection = handle.select("next-inventory-registration", "local:owner", entry.id);
        const commit = await vscode.window.showWarningMessage("Register this existing conda inventory prefix in the current Next catalog?",
          { modal: true, detail: `${entry.id}\n${entry.root}\n${selection.executable}\nMetadata only: no files/legacy registry changed; no Workflow approval or automatic provisioning.` },
          "Register selected prefix");
        fresh(); handle.validate(selection, selection.workspaceId, selection.actorId);
        if (commit === "Register selected prefix") store.register(entry, view.digest);
      } finally { handle.revoke(); }
      return;
    }
    const selected = await vscode.window.showQuickPick(items(action === pythonInspectionActions[4]));
    if (!selected) return;
    fresh();
    if (action === pythonInspectionActions[0]) { await showMetadata(selected.entry); return; }
    if (action === pythonInspectionActions[1]) {
      const authority = pythonAuthority();
      try {
        const handle = authority.select("next-python-metadata", "local:owner", selected.entry.id);
        const decision = await vscode.window.showWarningMessage("Probe registered Python version and allocated prefix size?",
          { modal: true, detail: `${handle.executable} -I -B -c <fixed version/stat probe> ${handle.root}\nOS-user execution, not a sandbox. Recursive lstat, no symlink following; maximum 250000 objects; allocated blocks rounded as Linux du -sk, not apparent bytes. Private HOME; no pip, downloads, installs, legacy writes or automatic retries. Cached snapshot is an estimate, never a live availability/execution grant.` },
          "Refresh version and size");
        fresh(); if (decision !== "Refresh version and size") return;
        await progress("Explicit Python version and size", (signal, report) => refreshPythonMetadata({
          storage, store, entry: selected.entry, expected: view.digest, authority, handle, check: fresh, signal, report }));
        fresh(); await showMetadata(selected.entry);
      } finally { authority.revoke(); }
      return;
    }
    let other: LocalEnvironment | undefined;
    if (action === pythonInspectionActions[3]) {
      const target = await vscode.window.showQuickPick(items().filter(i => i.entry.id !== selected.entry.id),
        { placeHolder: "Second saved package snapshot; script only, never executed" });
      if (!target) return;
      other = target.entry;
    }
    let tool: ReturnType<LocalPythonManagerAuthority["selectCondaQuery"]> | undefined;
    if (selected.entry.manager === "conda" || other?.manager === "conda") {
      const files = await vscode.window.showOpenDialog({ canSelectMany: false, canSelectFiles: true, canSelectFolders: false,
        openLabel: "Explicit installed conda for manual script text only; not executed" });
      if (!files?.length) return;
      tool = managers.selectCondaQuery(files[0].fsPath);
    }
    const result = other ? generatePythonMergeScript(storage, selected.entry, other, tool?.executable)
      : { script: condaManualDeleteScript(selected.entry, tool!.executable), keep: "", drop: selected.entry.name };
    fresh();
    await vscode.window.showTextDocument(await vscode.workspace.openTextDocument({ language: "shellscript", content: result.script }), { preview: true });
    const answer = await vscode.window.showWarningMessage("Copy this reviewed manual environment script, without executing it?",
      { modal: true, detail: `Keep: ${result.keep || "(not a merge)"}\nDrop: ${result.drop}\n${result.script.slice(0, 12000)}\nManual execution may install pinned missing packages or permanently delete a prefix. PKM does neither; metadata restore cannot restore files. No Workflow/terminal execution grant. Cancel leaves clipboard unchanged.` },
      "Copy script only");
    fresh(); if (tool) managers.validate(tool);
    if (answer === "Copy script only") await vscode.env.clipboard.writeText(result.script);
  } finally { managers.revoke(); }
  function pythonAuthority() {
    return new PythonEnvironmentAuthority(() => { try { fresh(); return true; } catch { return false; } },
      () => entries.map(e => ({ id: e.id, name: e.name, manager: e.manager as PyEnv["manager"],
        path: e.root!, python: e.executors[0].executable })));
  }
  async function showMetadata(entry: LocalEnvironment) {
    const data = readPythonMetadataSnapshot(storage, entry); fresh();
    if (!data) {
      await vscode.window.showInformationMessage(`No Next version/size snapshot for ${entry.id}. Original cached version: ${
        entry.legacyPython?.pyVersion || "unknown"}; original cached size: ${entry.legacyPython?.sizeBytes ?? "unknown"}. Explicit refresh required; no probing on view.`);
      return;
    }
    await showPythonReport(`# Python version and allocated size snapshot\n\nID: ${markdownCell(entry.id)}\n\nPython: ${data.snapshot.pyVersion}\n\nAllocated: ${humanSize(data.snapshot.sizeBytes)} (${data.snapshot.sizeBytes} bytes)\n\nCaptured: ${data.snapshot.capturedAt}\n\n${data.sourceMatches ? "Prefix metadata matches" : "Historical: source changed or missing"}; not a live size guarantee. No execution on view.`);
  }
}
