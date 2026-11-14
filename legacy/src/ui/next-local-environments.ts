import * as vscode from "vscode";
import * as path from "path";
import * as fs from "fs";
import { randomUUID } from "crypto";
import { LocalEnvironmentCatalog, inspectLocalEnvironment, type LocalEnvironment } from "../runtime/local-environment-catalog";
import { PythonEnvironmentAuthority } from "../runtime/python-environment-authority";
import type { EnvManager } from "../servers/pyenvs";
import type { NextManagedClient } from "../runtime/next-managed-client";
import { registerNextLocalRuntime } from "./next-local-runtime";
import { upgradeLocalEnvironmentProfile } from "../runtime/local-environment-upgrade";
import { inspectPythonFolder, planPythonCreation, createOfflinePythonEnvironment } from "../runtime/local-python-management";
import { LocalPythonManagerAuthority, type LocalPythonManager } from "../runtime/local-python-managers";
import { runtimeManagementActions, manageLocalRuntime } from "./next-local-runtime-management";
import { pythonLifecycleActions, managePythonLifecycle } from "./next-python-lifecycle";
import { condaLifecycleActions, manageCondaLifecycle } from "./next-conda-lifecycle";
import { condaPackageActions, manageCondaPackages } from "./next-conda-packages";
import { pythonPackageActions, managePythonPackages } from "./next-python-packages";
import { pythonInspectionActions, managePythonInspection } from "./next-python-inspection";
import { readPythonMetadataSnapshot } from "../runtime/local-python-inspection";

export function registerNextLocalEnvironments(context: vscode.ExtensionContext, current: () => NextManagedClient | undefined): void {
  const autoUpgrade = vscode.workspace.getConfiguration?.("personalKnowledge")
    .get<boolean>("experimental.localEnvironmentUpgrade", false) === true;
  if (autoUpgrade) {
    try {
      const storage = fs.existsSync(context.globalStorageUri.fsPath)
        ? fs.realpathSync(context.globalStorageUri.fsPath) : context.globalStorageUri.fsPath;
      const report = upgradeLocalEnvironmentProfile(storage, true, vscode.workspace.isTrusted);
      if (report.state === "repair-required")
        void vscode.window.showWarningMessage(`PKM experimental environment upgrade preserved configuration, but runtimes need repair: ${
          report.environments.filter(entry => !entry.available).map(entry => `${entry.id}: ${entry.issues.join(" ")}`).join("; ")
        } Nothing was installed or approved.`);
    } catch (error) {
      void vscode.window.showErrorMessage(`PKM experimental environment upgrade blocked: ${
        error instanceof Error ? error.message : "Profile unavailable."
      } Existing configuration kept; no execution, installation or automatic retry.`);
    }
  }
  registerNextLocalRuntime(context, current);
  let busy = false;
  context.subscriptions.push(vscode.commands.registerCommand("personalKnowledge.nextTrialEnvironments", async () => {
    if (busy) return;
    busy = true;
    const owner = current(), workspace = vscode.workspace.workspaceFile?.toString()
      ?? vscode.workspace.workspaceFolders?.map(folder => folder.uri.toString()).join("\n");
    const check = () => {
      if (!owner || current() !== owner || !vscode.workspace.isTrusted
        || workspace !== (vscode.workspace.workspaceFile?.toString()
          ?? vscode.workspace.workspaceFolders?.map(folder => folder.uri.toString()).join("\n")))
        throw new Error("A trusted workspace and current fresh isolated Next trial are required.");
      owner.pythonWorkspaceId();
    };
    try {
      check();
      const storageRoot = fs.existsSync(context.globalStorageUri.fsPath)
        ? fs.realpathSync(context.globalStorageUri.fsPath) : context.globalStorageUri.fsPath;
      const store = new LocalEnvironmentCatalog(path.join(storageRoot, "next-local-environments"));
      const view = store.read();
      const pythonEntries = view.catalog.entries.filter(item => item.language === "python" && item.kind === "environment");
      const pythonAuthority = () => new PythonEnvironmentAuthority(() => {
        try { check(); return store.read().digest === view.digest; } catch { return false; }
      }, () => store.read().catalog.entries.filter(item => item.language === "python" && item.kind === "environment")
        .map(item => ({ id: item.id, name: item.name, manager: item.manager as EnvManager,
          path: item.root ?? "", python: item.executors.find(executor => executor.id === "python")?.executable ?? "" })));
      const managementCheck = () => {
        check();
        if (vscode.workspace.getConfiguration?.("personalKnowledge").get<boolean>("experimental.localEnvironmentUpgrade", false) !== true)
          throw new Error("Enable the experimental local environment upgrade gate in this private profile first.");
      };
      const action = await vscode.window.showQuickPick([
        "Inspect registered environments", "Import legacy profile registry", "Register local Node.js runtime",
        "Register local C# executor set", "Run registered Python Workflow diagnostic",
        "Run or recover a controlled local runtime Workflow",
        "Unregister (keep all runtime files)", "Restore catalog revision",
        ...(autoUpgrade ? [...runtimeManagementActions, ...pythonLifecycleActions, ...condaLifecycleActions, ...condaPackageActions,
          ...pythonPackageActions, ...pythonInspectionActions,
          "Register existing Python folder", "Edit Python name and description", "Create offline Python venv",
          "Create offline Python venv with bundled pip",
          "Create offline conda environment", "Create offline uv environment"] : []),
      ], { placeHolder: "No downloads; managed-copy creation/removal needs its own explicit review and approval" });
      if (!action) return;
      check();
      const confirm = async (detail: string) => {
        const answer = await vscode.window.showWarningMessage("Change the isolated-trial machine-local environment catalog?",
          { modal: true, detail: `${detail}\nCatalog: ${context.globalStorageUri.fsPath}/next-local-environments\nNo runtime execution, package installation, file deletion or legacy registry write. Restoring metadata never restores execution approval.` },
          "Commit catalog change");
        check();
        return answer === "Commit catalog change";
      };
      if (pythonInspectionActions.includes(action)) {
        managementCheck();
        await managePythonInspection(action, store, view, storageRoot, managementCheck);
      } else if (pythonPackageActions.includes(action)) {
        managementCheck();
        await managePythonPackages(action, store, view, storageRoot, managementCheck);
      } else if (condaPackageActions.includes(action)) {
        managementCheck();
        await manageCondaPackages(action, store, view, storageRoot, managementCheck);
      } else if (condaLifecycleActions.includes(action)) {
        managementCheck();
        await manageCondaLifecycle(action, store, view, storageRoot, managementCheck);
      } else if (pythonLifecycleActions.includes(action)) {
        managementCheck();
        await managePythonLifecycle(action, store, view, storageRoot, managementCheck);
      } else if (runtimeManagementActions.includes(action)) {
        managementCheck();
        await manageLocalRuntime(action, store, view, managementCheck, confirm);
      } else if (action === "Inspect registered environments") {
        const entry = await vscode.window.showQuickPick(view.catalog.entries.map(item => {
          const status = inspectLocalEnvironment(item);
          let metadata = "";
          if (item.language === "python" && item.kind === "environment") {
            try {
              const cached = readPythonMetadataSnapshot(storageRoot, item);
              metadata = cached ? `Python ${cached.snapshot.pyVersion}; allocated ${cached.snapshot.sizeBytes} B; saved ${cached.snapshot.capturedAt}; not live`
                : `Legacy cached Python ${String(item.legacyPython?.pyVersion ?? "unknown")}; size ${String(item.legacyPython?.sizeBytes ?? "unknown")} B; not refreshed`;
            } catch { metadata = "Cached version/size unavailable; explicitly inspect/repair. No automatic probe."; }
          }
          return { label: item.name, description: `${item.language} · ${item.kind} · ${status.available ? "paths available, not approved" : "repair needed"}`,
            detail: `${status.issues.join(" ")}\n${metadata}\n${String(item.description ?? item.legacyPython?.description ?? "").slice(0, 8192)}\n${item.executors.map(executor => `${executor.id}: ${executor.executable}`).join(" · ")}` };
        }), { placeHolder: `Catalog revision ${view.catalog.revision}; availability is not executable authority` });
        if (entry) await vscode.window.showInformationMessage(entry.detail);
      } else if (action === "Import legacy profile registry") {
        const files = await vscode.window.showOpenDialog({ canSelectMany: false, canSelectFiles: true,
          canSelectFolders: false, openLabel: "Preview legacy registry.json (use a static profile copy)" });
        if (!files?.length) return;
        const file = files[0].fsPath, preview = store.previewLegacy(file);
        if (!await confirm(`Import ${preview.entries.length} Python environments from ${file}\nSource SHA-256: ${preview.sourceDigest}\n${preview.entries.map(item => `${item.id}: ${item.root}`).join("\n")}`)) return;
        const result = store.importLegacy(file, preview.sourceDigest, view.digest);
        await vscode.window.showInformationMessage(`Environment catalog revision ${result.catalog.revision}; legacy profile unchanged.`);
      } else if (action === "Register existing Python folder") {
        managementCheck();
        const files = await vscode.window.showOpenDialog({ canSelectMany: false, canSelectFiles: false,
          canSelectFolders: true, openLabel: "Select an existing venv/uv or conda prefix (no creation or repair)" });
        if (!files?.length) return;
        const name = await vscode.window.showInputBox({ prompt: "Registered Python environment name", value: path.basename(files[0].fsPath) });
        if (!name) return;
        const entry = inspectPythonFolder(files[0].fsPath, name);
        const authority = new PythonEnvironmentAuthority(() => {
          try { managementCheck(); return store.read().digest === view.digest; } catch { return false; }
        }, () => [{ id: entry.id, name: entry.name, manager: entry.manager as EnvManager,
          path: entry.root!, python: entry.executors[0].executable }]);
        try {
          const handle = authority.select(owner!.pythonWorkspaceId(), "local:owner", entry.id);
          if (!await confirm(`Register existing ${entry.manager} prefix ${entry.root}\nInterpreter: ${handle.executable}\nTarget: ${handle.target}\nNew ID: ${entry.id}. Existing Workflow references are never silently rebound.`)) return;
          managementCheck(); authority.validate(handle, owner!.pythonWorkspaceId(), "local:owner");
          store.register(entry, view.digest);
          await vscode.window.showInformationMessage(`Registered Python ${entry.id}. Runtime files unchanged; choose this ID explicitly when binding a Workflow.`);
        } finally { authority.revoke(); }
      } else if (action === "Edit Python name and description") {
        managementCheck();
        const selected = await vscode.window.showQuickPick(pythonEntries.map(entry => ({ label: entry.name, description: entry.id, entry })));
        if (!selected) return;
        const name = await vscode.window.showInputBox({ prompt: "Python display name (environment ID and paths stay unchanged)", value: selected.entry.name });
        if (name === undefined) return;
        const description = await vscode.window.showInputBox({ prompt: "Python description (blank clears it)",
          value: String(selected.entry.description ?? selected.entry.legacyPython?.description ?? "") });
        if (description === undefined) return;
        if (!await confirm(`Edit ${selected.entry.id}\nName: ${name.trim()}\nDescription: ${description.trim()}\nIDs, paths, original legacy snapshot and Workflow references stay unchanged.`)) return;
        managementCheck(); store.editPython(selected.entry.id, name.trim(), description.trim(), view.digest);
        await vscode.window.showInformationMessage(`Python metadata saved; environment ID ${selected.entry.id} and Workflow bindings unchanged.`);
      } else if (["Create offline Python venv", "Create offline Python venv with bundled pip",
        "Create offline conda environment", "Create offline uv environment"].includes(action)) {
        managementCheck();
        const manager = action === "Create offline conda environment" ? "conda" : action === "Create offline uv environment" ? "uv" : "venv";
        const bundledPip = action === "Create offline Python venv with bundled pip";
        const selected = manager === "conda" ? undefined : await vscode.window.showQuickPick(
          pythonEntries.map(entry => ({ label: entry.name, description: entry.id, entry })),
          { placeHolder: "Explicitly choose a registered local Python as base; no PATH fallback, Python download or installer" });
        if (manager !== "conda" && !selected) return;
        const authority = pythonAuthority();
        const managers = new LocalPythonManagerAuthority(() => {
          try { managementCheck(); return store.read().digest === view.digest; } catch { return false; }
        });
        try {
          const base = selected ? authority.select(owner!.pythonWorkspaceId(), "local:owner", selected.entry.id) : undefined;
          let tool: LocalPythonManager | undefined, pythonVersion: string | undefined;
          if (manager !== "venv") {
            const files = await vscode.window.showOpenDialog({ canSelectMany: false, canSelectFiles: true,
              canSelectFolders: false, openLabel: `Select already-installed local ${manager} executable (missing tool means unavailable; no install)` });
            if (!files?.length) {
              await vscode.window.showInformationMessage(`No installed ${manager} selected. Creation is unavailable; nothing was downloaded or installed.`);
              return;
            }
            const caches = manager === "conda" ? await vscode.window.showOpenDialog({ canSelectMany: false, canSelectFiles: false,
              canSelectFolders: true, openLabel: "Select local conda pkgs cache (read-only source; selected archives copied to synthetic cache)" }) : undefined;
            if (manager === "conda" && !caches?.length) return;
            tool = managers.select(manager, files[0].fsPath, caches?.[0].fsPath);
            if (manager === "conda") {
              pythonVersion = await vscode.window.showInputBox({ prompt: "Already cached Python version, e.g. 3.11 (offline; no latest/download)", value: "3.11" });
              if (pythonVersion === undefined) return;
            }
          }
          const name = await vscode.window.showInputBox({ prompt: "New synthetic Python environment name (letters, digits, dot, underscore or hyphen)" });
          if (!name) return;
          const description = await vscode.window.showInputBox({ prompt: "New environment description (optional)", value: "" });
          if (description === undefined) return;
          const entry = planPythonCreation(storageRoot, name.trim(), description.trim(), manager);
          const detail = tool ? `Manager: ${manager}\nExecutable: ${tool.executable}\nTarget: ${tool.target}\n${
            manager === "conda" ? `Read-only cache: ${tool.cache}\nPython: ${pythonVersion}\nOffline dry-run against a synthetic local channel, then copy only matching cached archives (digest checked) and install with --offline --copy into the synthetic prefix. Private HOME/config/cache; no existing environment or source-cache writes.`
              : `Base: ${base!.environmentId}\nPython: ${base!.executable}\nuv --offline --no-python-downloads --no-config venv --python <selected Python>; no seed or Python installation.`
          }` : `Base environment: ${base!.environmentId}\nInterpreter: ${base!.executable}\nTarget: ${base!.target}\nCommand: -I -B -m venv --without-pip <new prefix>${
            bundledPip ? "\nThen the NEW prefix Python -I -B invokes ensurepip.bootstrap(default_pip=True), using existing local wheels only (on Debian: /usr/share/python-wheels). Installs bundled pip/bootstrap dependencies and console scripts into the new prefix, not latest pip or arbitrary packages. Verify sys.prefix and prefix-local pip before registering. Private HOME/temp; no existing-prefix upgrade. Missing ensurepip/wheels fails; no apt, pip download, fallback or automatic repair. Installation is not rolled back; partial files remain. Cancellation/timeout stops the direct process only, not guaranteed installer descendants." : ""}`;
          const createLabel = manager === "venv" ? bundledPip ? "Create synthetic venv with bundled pip" : "Create synthetic venv"
            : `Create synthetic ${manager} environment`;
          const answer = await vscode.window.showWarningMessage(manager === "venv"
            ? "Create an offline Python venv in the synthetic profile directory?" : `Create an offline ${manager} environment from installed local resources?`,
            { modal: true, detail: `${detail}\nNew prefix: ${entry.root}\nThen verify the new interpreter's sys.prefix. OS user permissions, not a sandbox. No network download, PATH executable fallback, original-prefix changes or deletion. Cancellation stops only directly owned processes; partial files are retained and not automatically retried. Creation does not grant Workflow execution authority.` },
            createLabel);
          managementCheck();
          if (answer !== createLabel) return;
          await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, cancellable: true,
            title: `Create offline ${manager}: ${entry.id}` }, async (progress, token) => {
            const abort = new AbortController();
            const subscription = token.onCancellationRequested(() => abort.abort());
            if (token.isCancellationRequested) abort.abort();
            try {
              await createOfflinePythonEnvironment({ storage: storageRoot, entry, base, store, expected: view.digest, signal: abort.signal,
                bundledPip, report: phase => progress.report({ message: phase }),
                ...(tool ? { provider: managers.provider(tool, { pythonVersion, baseExecutable: base?.executable,
                  report: phase => progress.report({ message: phase }) }) } : {}),
                check() {
                  managementCheck();
                  if (base) authority.validate(base, owner!.pythonWorkspaceId(), "local:owner");
                  if (tool) managers.validate(tool);
                } });
            } finally { subscription.dispose(); }
          });
          await vscode.window.showInformationMessage(`Created offline Python ${entry.id} at ${entry.root}; explicitly select and approve it for each Workflow.`);
        } finally { authority.revoke(); managers.revoke(); }
      } else if (action === "Run or recover a controlled local runtime Workflow") {
        await vscode.commands.executeCommand("personalKnowledge.nextTrialRuntime");
      } else if (action === "Run registered Python Workflow diagnostic") {
        const selected = await vscode.window.showQuickPick(view.catalog.entries
          .filter(item => item.language === "python" && item.kind === "environment")
          .map(item => ({ label: item.name, description: item.id, entry: item })));
        if (!selected) return;
        const authority = pythonAuthority();
        try {
          const handle = authority.select(owner!.pythonWorkspaceId(), "local:owner", selected.entry.id);
          const decision = await vscode.window.showWarningMessage("Run the fixed Python Workflow diagnostic?",
            { modal: true, detail: `Environment: ${handle.environmentId}\nWorkspace: ${handle.workspaceId}\nActor: local:owner\nRoot: ${handle.root}\nInterpreter: ${handle.executable}\nTarget: ${handle.target}\nScript: print(7)\nRuns with OS user permissions, not a sandbox. No installation or network operation requested. One-run approval only; restore/restart requires re-selection.` },
            "Approve Python Workflow");
          check();
          if (decision !== "Approve Python Workflow") return;
          authority.validate(handle, owner!.pythonWorkspaceId(), "local:owner");
          const result = await owner!.runPythonTrial(authority, handle);
          if (result.state !== "succeeded") throw new Error(result.error ?? `Workflow ${result.state}; no automatic retry.`);
          await vscode.window.showInformationMessage(`Python Workflow ${result.state}: ${result.stdout.trim()} · environment ${result.environmentId} · ${result.runId}`);
        } finally { authority.revoke(); }
      } else if (action === "Unregister (keep all runtime files)") {
        const entry = await vscode.window.showQuickPick(view.catalog.entries.map(item => ({ label: item.name, description: item.id, entry: item })));
        if (!entry || !await confirm(`Unregister ${entry.entry.id}. All runtime files remain; restore a prior revision to recover metadata.`)) return;
        store.unregister(entry.entry.id, view.digest);
        await vscode.window.showInformationMessage("Unregistered metadata only; runtime files kept.");
      } else if (action === "Restore catalog revision") {
        const input = await vscode.window.showInputBox({ prompt: `Restore metadata from revision 0–${view.catalog.revision} as a new revision` });
        if (input === undefined) return;
        if (!/^(0|[1-9]\d*)$/.test(input)) throw new Error("Enter a catalog revision number.");
        const revision = Number(input), historical = store.read(revision);
        if (!await confirm(`Restore revision ${revision}: ${historical.catalog.entries.length} entries. No executors are re-approved.`)) return;
        store.restore(revision, view.digest);
        await vscode.window.showInformationMessage("Catalog metadata restored as a new revision; runtime approval remains revoked.");
      } else {
        const node = action === "Register local Node.js runtime";
        const files = await vscode.window.showOpenDialog({ canSelectMany: !node, canSelectFiles: true,
          canSelectFolders: false, openLabel: node ? "Select installed Node executable (no install)" : "Select installed C# executors (not a virtualenv)" });
        if (!files?.length) return;
        const name = await vscode.window.showInputBox({ prompt: node ? "Node.js runtime name" : "C# executor set name" });
        if (!name) return;
        const entry: LocalEnvironment = { id: `local-${randomUUID()}`, name, language: node ? "javascript" : "csharp",
          kind: node ? "runtime" : "executor-set", manager: "local",
          executors: files.map((file, index) => ({ id: node ? "node" : `executor-${index + 1}`, executable: file.fsPath })) };
        const status = inspectLocalEnvironment(entry);
        if (!status.available) throw new Error(status.issues.join(" "));
        if (!await confirm(`${entry.name} · ${entry.language} · ${entry.kind}\n${entry.executors.map(item => `${item.id}: ${item.executable}`).join("\n")}\nSelected executables are not run or trusted by this registration.`)) return;
        const rechecked = inspectLocalEnvironment(entry);
        if (!rechecked.available) throw new Error(rechecked.issues.join(" "));
        store.register(entry, view.digest);
        await vscode.window.showInformationMessage("Local runtime metadata registered; execution still requires a separate qualified host adapter.");
      }
    } catch (error) {
      void vscode.window.showErrorMessage(`PKM Next Environments: ${error instanceof Error ? error.message : "Catalog unavailable."} Keep runtime files. Recheck/restore the registered path, explicitly register a corrected folder and rebind its new ID, or restore catalog metadata. No automatic retry or installer.`);
    } finally { busy = false; }
  }));
}
