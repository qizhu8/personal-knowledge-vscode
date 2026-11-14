import * as vscode from "vscode";
import { LocalEnvironmentCatalog, type CatalogView } from "../runtime/local-environment-catalog";
import { planPythonLifecycle, validatePythonLifecycle, pythonActivationCommand, planPythonMigration,
  migratePythonCopy } from "../runtime/local-python-lifecycle";
import { planPythonRemoval, removePythonToQuarantine, listPythonRemovals, restorePythonQuarantine } from "../runtime/local-python-lifecycle";
import { listPythonDeletions, inspectPythonDeletion } from "../runtime/local-python-lifecycle";

export const pythonLifecycleActions = ["Activate registered Python in clean Bash terminal",
  "Review Python folder deletion script (manual only)", "Migrate Python venv copy (keep original)",
  "Remove synthetic Python to quarantine", "Restore quarantined Python folder",
  "Inspect recorded permanent Python deletion"];
export async function managePythonLifecycle(action: string, store: LocalEnvironmentCatalog, view: CatalogView,
  storage: string, check: () => void): Promise<void> {
  if (["Permanently delete external registered Python files and unregister",
    "Permanently delete synthetic Python files and unregister"].includes(action)) {
    check();
    await vscode.window.showWarningMessage("Permanent Python deletion is disabled for both external and synthetic prefixes.",
      { modal: true, detail: "Recursive path-based removal can erase nested mount/bind-mount contents, including on the same device. Mount-table checks and inode rechecks do not atomically exclude concurrent mounts or directory redirection. No deletion, receipt, metadata change or terminal action will run. Use metadata-only unregister to keep runtime files." });
    return;
  }
  if (action === "Inspect recorded permanent Python deletion") {
    const operation = await vscode.window.showQuickPick(listPythonDeletions(storage),
      { placeHolder: "Read-only requested deletion outcomes; no retry, restore or execution" });
    if (!operation) return;
    check();
    const outcome = inspectPythonDeletion(storage, operation, store);
    const document = await vscode.workspace.openTextDocument({ language: "json", content: JSON.stringify(outcome, null, 2) });
    await vscode.window.showTextDocument(document, { preview: true });
    return;
  }
  if (action === "Restore quarantined Python folder") {
    const operation = await vscode.window.showQuickPick(listPythonRemovals(storage), { placeHolder: "Select a recorded quarantine operation; no replay or overwrite" });
    if (!operation) return;
    const answer = await vscode.window.showWarningMessage("Restore this quarantined Python folder and its original metadata?",
      { modal: true, detail: `Operation: ${operation}\nThe recorded folder/config/activation must match; the original path must be absent and its ID not rebound elsewhere. Restore the exact original path, then re-register the same ID only if absent. Other catalog edits and the legacy registry remain unchanged. A failure may leave files restored before metadata; inspect explicitly. No automatic replay, downloads or execution grant.` },
      "Restore quarantined folder");
    check();
    if (answer === "Restore quarantined folder") {
      restorePythonQuarantine(storage, operation, store, view.digest, check);
      await vscode.window.showInformationMessage("Quarantined Python restored. Fresh Workflow approval required.");
    }
    return;
  }
  const selected = await vscode.window.showQuickPick(view.catalog.entries.filter(entry => entry.language === "python"
    && entry.kind === "environment").map(entry => ({ label: entry.name, description: entry.id, entry })),
  { placeHolder: "Explicit Python venv/uv only; conda and C# are not treated as venv folders" });
  if (!selected) return;
  const { entry } = selected, plan = planPythonLifecycle(entry);
  const fresh = () => {
    check();
    if (store.read().digest !== view.digest) throw new Error("Catalog changed; review the current environment.");
    validatePythonLifecycle(plan, entry);
  };
  fresh();
  if (action === "Remove synthetic Python to quarantine") {
    const removal = planPythonRemoval(storage, entry);
    const answer = await vscode.window.showWarningMessage("Remove this synthetic prefix to recoverable quarantine?",
      { modal: true, detail: `ID: ${entry.id}\nSource: ${entry.root}\nQuarantine: ${removal.target}\nOnly this profile's synthetic venv/uv copies are eligible. STOP all usage first; PKM does not claim exclusion against outside processes or terminate persisted PIDs. Rename the prefix, then CAS unregister metadata, retaining history and a durable requested receipt. Nothing is permanently erased; the legacy registry and external/original prefixes are not changed. Cancel/conflict/crash may leave the prefix moved while metadata remains; explicitly restore using the recorded operation. No automatic rollback, retries, installers or downloads.` },
      "Remove to quarantine");
    fresh();
    if (answer !== "Remove to quarantine") return;
    removePythonToQuarantine({ storage, entry, plan: removal, store, expected: view.digest, check });
    await vscode.window.showInformationMessage(`Removed ${entry.id} to quarantine. Restore operation ${removal.operationId}; no permanent erasure.`);
  } else if (action === "Migrate Python venv copy (keep original)") {
    const migration = planPythonMigration(storage, entry);
    const answer = await vscode.window.showWarningMessage("Copy and rebind this Python environment in the private profile?",
      { modal: true, detail: `ID: ${entry.id}\nSource: ${entry.root}\nDestination: ${migration.target}\nSource tree SHA-256: ${migration.sourceTreeSha256}\nCopy files/symlinks without following symlinks, rewrite copied bin text/config paths, execute the copied interpreter to verify sys.prefix, then CAS the catalog with the SAME ID and original legacy snapshot. This is OS-user code execution, not a sandbox. Original prefix and legacy registry remain untouched. A failure/cancel keeps the partial copy and receipt; inspect catalog before manual repair. No automatic retry, conda clone, source removal, package installation or download. Metadata restore can select the preserved original but never restores an execution grant.` },
      "Copy and rebind, keep original");
    fresh();
    if (answer !== "Copy and rebind, keep original") return;
    await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, cancellable: true,
      title: `Copy Python environment ${entry.id}` }, async (_progress, token) => {
      const abort = new AbortController(), subscription = token.onCancellationRequested(() => abort.abort());
      if (token.isCancellationRequested) abort.abort();
      try { await migratePythonCopy({ storage, entry, plan: migration, store, expected: view.digest, check, signal: abort.signal }); }
      finally { subscription.dispose(); }
    });
    await vscode.window.showInformationMessage(`Copied Python ${entry.id}; original retained. Fresh Workflow selection is required.`);
  } else if (action === "Review Python folder deletion script (manual only)") {
    const answer = await vscode.window.showWarningMessage("Copy a permanent deletion script for manual review only?",
      { modal: true, detail: `${plan.deletionScript}\nPKM does NOT execute this script, unregister metadata, stop users of the prefix or prove atomic filesystem exclusion. Its identity/config preflight is not a sandbox or rollback. Restore cannot recover deleted files; stop usage and back up before manually running it.` },
      "Copy deletion script only");
    fresh();
    if (answer !== "Copy deletion script only") return;
    await vscode.env.clipboard.writeText(plan.deletionScript);
    await vscode.window.showInformationMessage("Deletion script copied only. No files or metadata deleted.");
  } else {
    const command = pythonActivationCommand(plan);
    const answer = await vscode.window.showWarningMessage("Activate the reviewed Python source in a new clean Bash terminal?",
      { modal: true, detail: `ID: ${entry.id}\nPrefix: ${entry.root}\nActivation SHA-256: ${plan.activationSha256}\nExact source (executed from the approved snapshot, not reopened):\n${plan.activation}\n/bin/bash --noprofile --norc; no installer or package operation. Activation is arbitrary shell code with your OS permissions; terminal environment is interactive and may inherit user variables. This grants no Next Workflow approval. Closing the terminal discards activation; PKM does not claim process-tree containment or rollback.` },
      "Open reviewed activation terminal");
    fresh();
    if (answer !== "Open reviewed activation terminal") return;
    const terminal = vscode.window.createTerminal({ name: `env: ${entry.name}`, shellPath: "/bin/bash",
      shellArgs: ["--noprofile", "--norc"], env: { BASH_ENV: "", ENV: "" } });
    terminal.show(); terminal.sendText(command, true);
  }
}
