import * as vscode from "vscode";
import { createHash } from "crypto";
import { LocalEnvironmentCatalog, type CatalogView } from "../runtime/local-environment-catalog";
import { LocalPythonManagerAuthority } from "../runtime/local-python-managers";
import { bashQuote } from "../runtime/local-python-lifecycle";
import { planCondaLifecycle, executeCondaLifecycle, listCondaRecoveries, restoreCondaLifecycle,
  prepareCondaActivation, validateCondaPrefix } from "../runtime/local-conda-lifecycle";

export const condaLifecycleActions = ["Activate registered conda in private Bash terminal",
  "Clone conda to managed prefix (keep original)", "Remove managed conda (keep recovery clone)", "Restore conda recovery clone"];
export async function manageCondaLifecycle(action: string, store: LocalEnvironmentCatalog, view: CatalogView,
  storage: string, check: () => void): Promise<void> {
  const selected = action === "Restore conda recovery clone" ? undefined : await vscode.window.showQuickPick(
    view.catalog.entries.filter(entry => entry.language === "python" && entry.kind === "environment" && entry.manager === "conda")
      .map(entry => ({ label: entry.name, description: entry.id, entry })),
    { placeHolder: "Registered conda prefix only; base/tool-containing prefixes are refused" });
  if (action !== "Restore conda recovery clone" && !selected) return;
  const fresh = () => {
    check();
    if (store.read().digest !== view.digest) throw new Error("Catalog changed; review conda lifecycle again.");
  };
  const files = await vscode.window.showOpenDialog({ canSelectFiles: true, canSelectFolders: false, canSelectMany: false,
    openLabel: "Select already-installed conda executable; never install a manager" });
  if (!files?.length) return;
  const activationOnly = action === "Activate registered conda in private Bash terminal";
  const caches = activationOnly ? undefined : await vscode.window.showOpenDialog({ canSelectFiles: false, canSelectFolders: true, canSelectMany: false,
    openLabel: "Select existing read-only conda archive cache; exact package digests required, no downloads" });
  if (!activationOnly && !caches?.length) return;
  const authority = new LocalPythonManagerAuthority(() => { try { check(); return true; } catch { return false; } });
  try {
    fresh();
    const tool = activationOnly ? authority.selectCondaQuery(files[0].fsPath)
      : authority.select("conda", files[0].fsPath, caches![0].fsPath);
    const progress = async (task: (signal: AbortSignal, report: (phase: string) => void) => Promise<void>) => {
      await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, cancellable: true,
        title: "Explicit offline conda lifecycle" }, async (p, token) => {
        const abort = new AbortController(), subscription = token.onCancellationRequested(() => abort.abort());
        if (token.isCancellationRequested) abort.abort();
        try { await task(abort.signal, phase => p.report({ message: phase })); }
        finally { subscription.dispose(); }
      });
    };
    if (action === "Restore conda recovery clone") {
      const operationId = await vscode.window.showQuickPick(listCondaRecoveries(storage),
        { placeHolder: "Select recorded conda removal; original path must be absent, no overwrite/replay" });
      if (!operationId) return;
      const decision = await vscode.window.showWarningMessage("Restore this conda recovery clone with the selected offline manager?",
        { modal: true, detail: `Operation: ${operationId}\nManager: ${tool.executable}\nRead-only cache: ${tool.cache}\nVerify immutable receipt/history and backup tree, require absent original path and no ID rebind, clone backup to the exact old managed path, verify Python, then restore missing metadata with original ID. Partial files/conflicts stay for explicit repair. Executes selected manager/copied Python with OS permissions, not a sandbox. No automatic replay, external-prefix removal, manager installation or download.` },
        "Restore verified conda clone");
      fresh(); authority.validate(tool);
      if (decision !== "Restore verified conda clone") return;
      await progress((signal, report) => restoreCondaLifecycle({ storage, operationId, store, expected: view.digest,
        authority, tool, check, signal, report }));
      await vscode.window.showInformationMessage("Conda prefix restored; fresh Workflow approval required, recovery clone retained.");
      return;
    }
    const entry = selected!.entry;
    if (action === "Activate registered conda in private Bash terminal") {
      const query = await vscode.window.showWarningMessage("Generate the selected conda Bash hook without an archive cache?",
        { modal: true, detail: `ID: ${entry.id}\nPrefix: ${entry.root}\nManager: ${tool.executable}\nCommand: shell.bash hook\nExecute the selected installed tool with OS-user permissions to produce shell text for a SEPARATE activation review. Private offline HOME/config/cache, no environment creation, package archive selection, installation, deletion or downloads. Cancel runs no tool and opens no terminal. This is not a Workflow execution grant.` },
        "Generate hook for review");
      fresh(); authority.validate(tool);
      if (query !== "Generate hook for review") return;
      const prepared = await prepareCondaActivation(storage, entry, authority, tool, fresh);
      const delimiter = `PKM_CONDA_${createHash("sha256").update(prepared.hook).digest("hex")}`;
      if (prepared.hook.split(/\r?\n/).includes(delimiter)) throw new Error("Conda hook delimiter collision.");
      const decision = await vscode.window.showWarningMessage("Activate this conda prefix using the reviewed installed Bash hook?",
        { modal: true, detail: `Prefix: ${entry.root}\nManager: ${tool.executable}\nPrivate HOME/config/cache: ${prepared.work}\nTree digest: ${prepared.snapshot.digest}\nExact conda shell.bash hook:\n${prepared.hook}\nPrefix activation scripts:\n${JSON.stringify(prepared.scripts)}\nA fresh prefix/manager check precedes terminal delivery. Hook uses approved snapshot; later conda activation/scripts are not atomically contained against same-user edits. Shell and package activation code run with OS permissions. Private offline manager HOME/config/cache, no base auto-activation, no installation/download or Workflow grant.` },
        "Open reviewed conda terminal");
      fresh(); authority.validate(tool); validateCondaPrefix(prepared.snapshot, entry);
      if (decision !== "Open reviewed conda terminal") return;
      const terminal = vscode.window.createTerminal({ name: `conda: ${entry.name}`, shellPath: "/bin/bash",
        shellArgs: ["--noprofile", "--norc"], env: { ...prepared.env, BASH_ENV: "", ENV: "",
          CONDA_PREFIX: "", CONDA_DEFAULT_ENV: "", CONDA_SHLVL: "0", CONDA_PROMPT_MODIFIER: "", _CE_CONDA: "", _CE_M: "" } });
      terminal.show();
      terminal.sendText(`source /dev/stdin <<'${delimiter}'\n${prepared.hook}\n${delimiter}\nconda activate ${bashQuote(entry.root!)}\n`, true);
      return;
    }
    const plan = planCondaLifecycle(storage, entry, action === "Remove managed conda (keep recovery clone)" ? "remove" : "clone");
    const decision = await vscode.window.showWarningMessage("Run this explicitly reviewed offline conda lifecycle?",
      { modal: true, detail: `Operation: ${plan.operation}\nID: ${entry.id}\nSource: ${plan.source.root}\nTarget: ${plan.target}\nTree digest: ${plan.source.digest}\nManager: ${tool.executable}\nRead-only source cache: ${tool.cache}\nExact archive count: ${plan.source.archives.length}\nCopy digest-matching local archives into private cache, use conda create --offline --copy --clone, verify copied Python. Clone migration preserves original and CAS rebinds same ID. Removal ONLY accepts managed clones: first create/verify a recovery clone and receipt, then conda env remove on the managed source with private offline CONDARC/CONDA_OFFLINE, then CAS unregister. STOP usage first; no global exclusion/process-tree safety claim. Cancellation/failure/crash retains backups/work/receipts and may leave partial source or stale metadata; inspect before explicit recovery. No rollback or automatic replay. No production/original-prefix deletion, manager installation, selected source-cache writes or network download. OS-user manager/package/Python code execution, not a sandbox.` },
      "Approve offline conda lifecycle");
    fresh(); authority.validate(tool); validateCondaPrefix(plan.source, entry);
    if (decision !== "Approve offline conda lifecycle") return;
    await progress((signal, report) => executeCondaLifecycle({ storage, entry, plan, store, expected: view.digest,
      authority, tool, check, signal, report }));
    await vscode.window.showInformationMessage(plan.operation === "clone"
      ? `Conda ${entry.id} migrated to a managed clone; original retained, fresh Workflow selection required.`
      : `Managed conda ${entry.id} removed; recovery clone ${plan.operationId} retained. No automatic restore.`);
  } finally { authority.revoke(); }
}
