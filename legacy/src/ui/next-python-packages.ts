import * as vscode from "vscode";
import { LocalEnvironmentCatalog, type CatalogView } from "../runtime/local-environment-catalog";
import { PythonEnvironmentAuthority } from "../runtime/python-environment-authority";
import type { PyEnv } from "../servers/pyenvs";
import { readPythonPackageSnapshot, refreshPipPackageSnapshot, pipPackageArgv, type PythonPackageSnapshot } from "../runtime/local-python-packages";
import { comparePythonSnapshots, similarPythonSnapshots } from "../runtime/local-python-analytics";
import { readPythonMetadataSnapshot } from "../runtime/local-python-inspection";
import { planMissingWheelInstall, selectMissingWheels, installMissingWheels } from "../runtime/local-python-wheel-install";

export const pythonPackageActions = ["View registered pip package snapshot", "Refresh registered pip package snapshot",
  "Compare registered Python package snapshots", "Find similar registered Python package snapshots",
  "Browse and filter Python package comparison", "Install missing merge packages from local wheels (synthetic only)"];
export const markdownCell = (value: string) => value.replace(/[\\|`*_[\]()<>]/g, "\\$&").replace(/[\r\n]/g, " ");
export async function showPythonReport(content: string) {
  await vscode.window.showTextDocument(await vscode.workspace.openTextDocument({ language: "markdown", content }), { preview: true });
}
function packageTable(snapshot: PythonPackageSnapshot, matches: boolean) {
  return ["# Pip package snapshot", "", `Environment ID: ${markdownCell(snapshot.source.id)}`,
    `Prefix: ${markdownCell(snapshot.source.root)}`, `Captured: ${snapshot.capturedAt}`,
    `State: ${matches ? "prefix-local metadata matches" : "historical; source missing or changed"}.`,
    "Saved snapshot, not a live query. System-site packages may change independently. No execution approval.", "",
    "| Package | Version |", "| --- | --- |",
    ...snapshot.packages.map(p => `| ${markdownCell(p.name)} | ${markdownCell(p.version)} |`)].join("\n");
}
async function browseComparison(result: ReturnType<typeof comparePythonSnapshots>, fresh: () => void) {
  type Column = "name" | "va" | "vb" | "status";
  type Row = typeof result.rows[number];
  type Item = vscode.QuickPickItem & { toggle?: boolean; column?: Column; row?: Row };
  const columns: [Column, string][] = [["name", "Package"], ["va", "A version"], ["vb", "B version"], ["status", "Change type"]];
  const statusOrder: Record<string, number> = { added: 0, deleted: 1, upgrade: 2, downgrade: 3, same: 4 };
  let hideSame = false, sort: { column?: Column; direction: number } = { direction: 0 };
  while (true) {
    fresh();
    const rows = result.rows.filter(row => !hideSame || row.status !== "same");
    const column = sort.column;
    if (column) rows.sort((a, b) => sort.direction * (column === "status"
      ? statusOrder[a.status] - statusOrder[b.status] || a.name.toLowerCase().localeCompare(b.name.toLowerCase())
      : String(a[column]).localeCompare(String(b[column]), undefined, { numeric: true, sensitivity: "base" })));
    const items: Item[] = [
      { label: hideSame ? "Show unchanged packages" : "Hide unchanged packages", toggle: true },
      ...columns.map(([column, label]) => ({ label: `Sort by ${label}`, column,
        description: sort.column === column ? sort.direction > 0 ? "ascending; select for descending" : "descending; select for original order"
          : "select for ascending" })),
      { label: `${rows.length}/${result.rows.length} packages; ${JSON.stringify(result.counts)}`, kind: vscode.QuickPickItemKind.Separator },
      ...rows.map(row => ({ label: row.name, description: `A: ${row.va || "—"} → B: ${row.vb || "—"} · ${row.status}`, row })),
    ];
    const selected = await vscode.window.showQuickPick(items, { title: `${result.a.name} → ${result.b.name}`,
      placeHolder: `${result.snapshots.some(s => !s.sourceMatches) ? "Historical: prefix missing or changed. " : ""}Type to filter names/versions/status; select controls to hide/sort; Escape closes. Saved snapshots only.`,
      matchOnDescription: true });
    fresh();
    if (!selected) return;
    if (selected.toggle) hideSame = !hideSame;
    else if (selected.column) sort = sort.column !== selected.column ? { column: selected.column, direction: 1 }
      : sort.direction > 0 ? { column: selected.column, direction: -1 } : { direction: 0 };
    else if (selected.row) {
      const row = selected.row;
      await vscode.window.showInformationMessage(`${row.name}\n${result.a.name}: ${row.va || "—"}\n${result.b.name}: ${row.vb || "—"}\n${row.status}\n${
        result.snapshots.map(s => `${s.id}: ${s.capturedAt} (${s.sourceMatches ? "prefix metadata matches" : "historical"})`).join("\n")
      }\nSaved comparison only; no package query, install, merge or Workflow approval.`);
    }
  }
}
export async function managePythonPackages(action: string, store: LocalEnvironmentCatalog, view: CatalogView,
  storage: string, check: () => void): Promise<void> {
  const entries = view.catalog.entries.filter(e => e.language === "python" && e.kind === "environment");
  const fresh = () => { check(); if (store.read().digest !== view.digest) throw new Error("Catalog changed; select again."); };
  const items = (pipOnly = false) => entries.filter(e => !pipOnly || e.manager !== "conda")
    .map(entry => ({ label: entry.name, description: entry.id, entry }));
  fresh();
  if (action === pythonPackageActions[3]) {
    const selected = await vscode.window.showQuickPick(items(), { canPickMany: true,
      placeHolder: "Choose 2–64 current catalog entries with explicit saved snapshots; no automatic refresh" });
    if (!selected || selected.length < 2) return;
    fresh();
    const result = similarPythonSnapshots(storage, selected.map(item => item.entry),
      entry => readPythonMetadataSnapshot(storage, entry)?.snapshot); fresh();
    await showPythonReport(["# Python package similarity", "", "Cached snapshots only; Jaccard package-name overlap, not execution/merge approval.",
      `Known different Python minor pairs skipped: ${result.skipped}. Sizes/versions are cached metadata or legacy estimates; unknown sizes are 0, not measured.`,
      ...result.snapshots.map(s => `${markdownCell(s.id)}: ${s.capturedAt} (${s.sourceMatches ? "prefix metadata matches" : "historical"})`), "",
      "| A | B | Jaccard | Exact versions | Shared | Estimated saved bytes |", "| --- | --- | --- | --- | --- | --- |",
      ...result.pairs.map(p => `| ${markdownCell(p.a.id)} | ${markdownCell(p.b.id)} | ${p.score} | ${p.exactScore} | ${p.shared} | ${p.saving} |`)].join("\n"));
    return;
  }
  const comparison = action === pythonPackageActions[2] || action === pythonPackageActions[4];
  const installing = action === pythonPackageActions[5];
  const selected = await vscode.window.showQuickPick(items(!comparison && !installing));
  if (!selected) return;
  fresh();
  if (installing) {
    const other = await vscode.window.showQuickPick(items().filter(e => e.entry.id !== selected.entry.id),
      { placeHolder: "Second saved snapshot: old merge counts/size choose the kept prefix; no drop deletion" });
    if (!other) return;
    fresh();
    const plan = planMissingWheelInstall(storage, selected.entry, other.entry);
    if (!plan.missing.length) { await vscode.window.showInformationMessage("No missing packages; differing existing versions are not upgraded."); return; }
    const files = await vscode.window.showOpenDialog({ canSelectMany: true, canSelectFiles: true, canSelectFolders: false,
      openLabel: "Select matching local py3-none-any wheels only; never download or build" });
    if (!files?.length) return;
    const wheels = selectMissingWheels(plan, files.map(file => file.fsPath));
    const authority = new PythonEnvironmentAuthority(() => { try { fresh(); return true; } catch { return false; } },
      () => [{ id: plan.keep.id, name: plan.keep.name, manager: "venv", path: plan.keep.root!, python: plan.keep.executors[0].executable }]);
    try {
      const handle = authority.select("next-offline-wheel-install", "local:owner", plan.keep.id);
      const answer = await vscode.window.showWarningMessage("Stop prefix usage before installing these missing merge packages into the synthetic venv?",
        { modal: true, detail: `Keep ID: ${plan.keep.id}\nPrefix: ${plan.keep.root}\nPython: ${handle.executable}\nOther prefix (retained): ${plan.drop.root}\nLocal wheels: ${JSON.stringify(wheels, null, 2)}\nExisting-version differences left unchanged: ${JSON.stringify(plan.differences)}\nValidate bounded pure wheel paths/metadata/RECORD, reject scripts/.data/startup hooks/native payloads and existing namespaces. Run pip install --no-index --no-deps --only-binary=:all: --no-compile --ignore-installed --disable-pip-version-check --no-cache-dir on private digest-checked copies. ignore-installed prevents pip uninstall; absence checks do not atomically exclude same-user path changes. OS-user Python/pip execution, NOT an atomic filesystem/network sandbox. Installs new files without rollback; dependencies are NOT resolved. No source builds, download, existing-version upgrade, prefix deletion, catalog rebind or automatic package refresh. Failure/cancel may leave partial packages; installer descendants may continue. Retain requested work, never automatically retry. Review/refresh separately; no Workflow grant.` },
        "Install reviewed local wheels");
      fresh(); authority.validate(handle, handle.workspaceId, handle.actorId);
      if (answer !== "Install reviewed local wheels") return;
      await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, cancellable: true,
        title: "Explicit offline missing-package install" }, async (progress, token) => {
        const abort = new AbortController(), subscription = token.onCancellationRequested(() => abort.abort());
        if (token.isCancellationRequested) abort.abort();
        try {
          const result = await installMissingWheels({ storage, store, expected: view.digest, plan, wheels, authority, handle,
            check: fresh, signal: abort.signal });
          progress.report({ message: `Installer verified; retained work ${result.work}` });
        } finally { subscription.dispose(); }
      });
      await vscode.window.showInformationMessage("Missing local packages installed; both prefixes retained. Kept-prefix cached table is now historical. Refresh separately; no Workflow approval.");
    } finally { authority.revoke(); }
    return;
  }
  if (comparison) {
    const target = await vscode.window.showQuickPick(items().filter(e => e.entry.id !== selected.entry.id),
      { placeHolder: "Target B: added/deleted/upgrade/downgrade are relative to A → B" });
    if (!target) return;
    fresh();
    const result = comparePythonSnapshots(storage, selected.entry, target.entry); fresh();
    if (action === pythonPackageActions[4]) { await browseComparison(result, fresh); return; }
    await showPythonReport(["# Python package comparison", "", `A: ${markdownCell(selected.entry.id)} → B: ${markdownCell(target.entry.id)}`,
      "Cached snapshots only. No package query/install; legacy numeric-components version ordering (not PEP 440).",
      ...result.snapshots.map(s => `${markdownCell(s.id)}: ${s.capturedAt} (${s.sourceMatches ? "prefix metadata matches" : "historical"})`),
      JSON.stringify(result.counts), "", "| Package | A | B | Status |", "| --- | --- | --- | --- |",
      ...result.rows.map(p => `| ${markdownCell(p.name)} | ${markdownCell(p.va)} | ${markdownCell(p.vb)} | ${p.status} |`)].join("\n"));
    return;
  }
  if (action === pythonPackageActions[0]) {
    const cached = readPythonPackageSnapshot(storage, selected.entry); fresh();
    if (!cached) { await vscode.window.showInformationMessage("No Next pip snapshot. Explicit refresh is required; viewing never executes Python or installs pip."); return; }
    await showPythonReport(packageTable(cached.snapshot, cached.sourceMatches)); return;
  }
  const authority = new PythonEnvironmentAuthority(() => { try { fresh(); return true; } catch { return false; } },
    () => entries.map(e => ({ id: e.id, name: e.name, manager: e.manager as PyEnv["manager"],
      path: e.root!, python: e.executors[0].executable })));
  try {
    const handle = authority.select("next-package-inspection", "local:owner", selected.entry.id);
    const decision = await vscode.window.showWarningMessage("Refresh this registered pip package table with its existing interpreter?",
      { modal: true, detail: `ID: ${selected.entry.id}\nPython: ${handle.executable}\nTarget: ${handle.target}\nArgv: ${pipPackageArgv.join(" ")}\nOS-user execution, not a sandbox. Installed Python/pip only; private HOME/cache, null pip config, no index/version check. No pip/ensurepip/package installation, download, PATH fallback, Workflow grant or auto-retry. Missing pip fails and preserves previous snapshot.` },
      "Refresh existing pip snapshot");
    fresh();
    if (decision !== "Refresh existing pip snapshot") return;
    await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, cancellable: true, title: "Explicit installed pip list" },
      async (progress, token) => {
        const abort = new AbortController(), subscription = token.onCancellationRequested(() => abort.abort());
        if (token.isCancellationRequested) abort.abort();
        try {
          await refreshPipPackageSnapshot({ storage, store, entry: selected.entry, expected: view.digest,
            authority, handle, check: fresh, signal: abort.signal, report: phase => progress.report({ message: phase }) });
        } finally { subscription.dispose(); }
      });
    fresh();
    const cached = readPythonPackageSnapshot(storage, selected.entry);
    if (!cached) throw new Error("Pip query did not publish a snapshot.");
    await showPythonReport(packageTable(cached.snapshot, cached.sourceMatches));
  } finally { authority.revoke(); }
}
