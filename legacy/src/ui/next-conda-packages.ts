import * as vscode from "vscode";
import { LocalEnvironmentCatalog, type CatalogView } from "../runtime/local-environment-catalog";
import { LocalPythonManagerAuthority } from "../runtime/local-python-managers";
import { readCondaPackageSnapshot, refreshCondaPackageSnapshot, type CondaPackageSnapshot } from "../runtime/local-conda-packages";

export const condaPackageActions = ["View registered conda package snapshot", "Refresh registered conda package snapshot (explicit tool)"];
async function show(snapshot: CondaPackageSnapshot, matches: boolean) {
  const escape = (text: string) => text.replace(/[\\|`*_[\]()<>]/g, "\\$&").replace(/[\r\n]/g, " ");
  const content = [`# Conda package snapshot`, "", `Environment ID: ${escape(snapshot.source.id)}`,
    `Prefix: ${escape(snapshot.source.root)}`, `Captured: ${escape(snapshot.capturedAt)}`,
    `State: ${matches ? "prefix metadata matches this snapshot" : "historical only; source missing, rebound or changed"}.`,
    "Viewing this cached table runs no manager and grants no execution approval.", "",
    "| Package | Version |", "| --- | --- |", ...snapshot.packages.map(pkg => `| ${escape(pkg.name)} | ${escape(pkg.version)} |`)].join("\n");
  const document = await vscode.workspace.openTextDocument({ language: "markdown", content });
  await vscode.window.showTextDocument(document, { preview: true });
}
export async function manageCondaPackages(action: string, store: LocalEnvironmentCatalog, view: CatalogView,
  storage: string, check: () => void): Promise<void> {
  const selected = await vscode.window.showQuickPick(view.catalog.entries
    .filter(entry => entry.language === "python" && entry.kind === "environment" && entry.manager === "conda")
    .map(entry => ({ label: entry.name, description: entry.id, entry })),
  { placeHolder: "Current Next catalog only; legacy registry and package caches are not queried or rewritten" });
  if (!selected) return;
  const fresh = () => {
    check();
    if (store.read().digest !== view.digest) throw new Error("Catalog changed; select and review the package query again.");
  };
  fresh();
  if (action === condaPackageActions[0]) {
    const cached = readCondaPackageSnapshot(storage, selected.entry); fresh();
    if (!cached) { await vscode.window.showInformationMessage("No Next package snapshot for this binding. Choose explicit refresh; opening the table never runs a manager."); return; }
    await show(cached.snapshot, cached.sourceMatches); return;
  }
  const files = await vscode.window.showOpenDialog({ canSelectMany: false, canSelectFiles: true, canSelectFolders: false,
    openLabel: "Select already-installed conda for this explicit offline package query; no archive cache needed" });
  if (!files?.length) return;
  const authority = new LocalPythonManagerAuthority(() => { try { fresh(); return true; } catch { return false; } });
  try {
    const tool = authority.selectCondaQuery(files[0].fsPath);
    const decision = await vscode.window.showWarningMessage("Refresh this registered conda package table with the explicitly selected installed tool?",
      { modal: true, detail: `ID: ${selected.entry.id}\nPrefix: ${selected.entry.root}\nManager: ${tool.executable}\nExact argv: list --json -p ${selected.entry.root}\nExecutes installed conda with OS permissions; not a sandbox. Private offline HOME/config/cache, plugins disabled. No install/update/solve/download, PATH fallback, legacy registry/cache write, Workflow grant or automatic retry. On failure/cancellation/stale catalog, keep the previous snapshot and retain private query work for inspection.` },
      "Refresh offline package snapshot");
    fresh(); authority.validate(tool);
    if (decision !== "Refresh offline package snapshot") return;
    await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, cancellable: true,
      title: "Explicit offline conda package query" }, async (progress, token) => {
      const cancellation = new AbortController(), subscription = token.onCancellationRequested(() => cancellation.abort());
      if (token.isCancellationRequested) cancellation.abort();
      try {
        await refreshCondaPackageSnapshot({ storage, store, entry: selected.entry, expected: view.digest,
          authority, tool, check: fresh, signal: cancellation.signal, report: phase => progress.report({ message: phase }) });
      } finally { subscription.dispose(); }
    });
    fresh();
    const cached = readCondaPackageSnapshot(storage, selected.entry);
    if (!cached) throw new Error("Package query did not publish a snapshot.");
    await show(cached.snapshot, cached.sourceMatches);
  } finally { authority.revoke(); }
}
