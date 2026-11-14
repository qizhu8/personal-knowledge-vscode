import * as vscode from "vscode";
import * as fs from "fs";
import * as path from "path";
import { LocalEnvironmentCatalog } from "../runtime/local-environment-catalog";
import { LocalRuntimeAuthority, type LocalProgramParameters } from "../runtime/local-runtime-authority";
import type { NextManagedClient, LocalEnvironmentRunView } from "../runtime/next-managed-client";
import { runReviewedPythonProgram } from "./next-python-program";

export function registerNextLocalRuntime(context: vscode.ExtensionContext, current: () => NextManagedClient | undefined): void {
  let busy = false;
  context.subscriptions.push(vscode.commands.registerCommand("personalKnowledge.nextTrialRuntime", async () => {
    if (busy) return;
    busy = true;
    const owner = current(), workspace = vscode.workspace.workspaceFile?.toString()
      ?? vscode.workspace.workspaceFolders?.map(folder => folder.uri.toString()).join("\n");
    const check = () => {
      if (!owner || current() !== owner || !vscode.workspace.isTrusted
        || workspace !== (vscode.workspace.workspaceFile?.toString()
          ?? vscode.workspace.workspaceFolders?.map(folder => folder.uri.toString()).join("\n")))
        throw new Error("A trusted current fresh isolated Next trial is required.");
      return owner.pythonWorkspaceId();
    };
    let authority: LocalRuntimeAuthority | undefined;
    try {
      const workspaceId = check(), storage = fs.realpathSync(context.globalStorageUri.fsPath);
      const catalog = new LocalEnvironmentCatalog(path.join(storage, "next-local-environments"));
      authority = new LocalRuntimeAuthority(() => { try { check(); return true; } catch { return false; } },
        catalog, path.join(storage, "next-local-environment-runs"));
      const journal = authority.selectJournal(workspaceId, "local:owner");
      const action = await vscode.window.showQuickPick([
        "Run registered Node.js controlled program", "Run registered C# controlled program",
        "Inspect or cancel environment runs", "Recover interrupted environment history (no replay)",
        ...(vscode.workspace.getConfiguration?.("personalKnowledge").get<boolean>("experimental.localEnvironmentUpgrade", false) === true
          ? ["Run reviewed Python Workflow", "Run registered Node.js project entry (CommonJS)",
            "Run registered Node.js project entry (ESM / existing Node TypeScript)"] : []),
      ], { placeHolder: "Only explicitly reviewed native providers; no shell, installation or download" });
      if (!action) return;
      check();
      if (action === "Run reviewed Python Workflow") {
        await runReviewedPythonProgram({ owner: owner!, catalog, authority, journal, check });
        return;
      }
      const command = (request: Parameters<NextManagedClient["localEnvironmentCommand"]>[2]) =>
        owner!.localEnvironmentCommand(authority!, journal, request);
      const display = (runs: LocalEnvironmentRunView[]) => runs.map(run =>
        `${run.runId}: ${run.state}, effect ${run.effect}, ${run.provider}\n${run.jobs.map(job =>
          `${job.phase}: ${job.state} · exit ${job.exitCode ?? "none"}\n${job.stdout}${job.stderr}`).join("\n")}`).join("\n");
      if (action === "Recover interrupted environment history (no replay)") {
        const answer = await vscode.window.showWarningMessage("Recover this private environment run journal without replay?",
          { modal: true, detail: `${journal.directory}\nOnly an expired or closed owner may be recovered. Previously started effects become UNKNOWN, never pending/replayed. No persisted PID is signalled and no executable approval is restored.` },
          "Recover without replay");
        check();
        if (answer !== "Recover without replay") return;
        const runs = await command({ operation: "open", recover: true });
        await vscode.window.showInformationMessage(display(runs) || "No environment run history.");
        return;
      }
      if (action === "Inspect or cancel environment runs") {
        const runs = await command({ operation: "open", recover: false });
        const selected = await vscode.window.showQuickPick(runs.map(run => ({ label: `${run.environmentId} · ${run.state}`,
          description: run.runId, detail: `effect: ${run.effect} · ${run.provider}`, run })));
        if (!selected) return;
        if (["ready", "running"].includes(selected.run.state)) {
          const answer = await vscode.window.showWarningMessage("Cancel this host's active environment Workflow?",
            { modal: true, detail: `${selected.run.runId}\nCancellation fences results and stops the directly owned process. Started effects remain UNKNOWN; this does not prove rollback.` }, "Cancel owned run");
          check();
          if (answer === "Cancel owned run") await command({ operation: "cancel", runId: selected.run.runId });
        }
        await vscode.window.showInformationMessage(display((await command({ operation: "status" })).filter(run => run.runId === selected.run.runId)));
        return;
      }
      const node = action === "Run registered Node.js controlled program";
      const project = action.startsWith("Run registered Node.js project entry (");
      const entries = catalog.read().catalog.entries.filter(entry => project
        ? entry.language === "javascript" && entry.kind === "environment" && entry.manager === "node-project"
        : node ? entry.language === "javascript" && entry.kind === "runtime" : entry.language === "csharp" && entry.kind === "executor-set");
      const selected = await vscode.window.showQuickPick(entries.map(entry => ({ label: entry.name, description: entry.id, entry })),
        { placeHolder: project ? "Select an explicitly registered Node project environment" : node
          ? "Select an already registered Node.js runtime" : "Select an already registered C# executor set (requires local .NET 8 SDK)" });
      if (!selected) {
        if (!entries.length) await vscode.window.showInformationMessage("No eligible registered local runtime. Register it explicitly first; nothing was installed.");
        return;
      }
      const executor = node || project ? selected.entry.executors.find(item => item.id === "node")
        : (await vscode.window.showQuickPick(selected.entry.executors.map(item => ({
          label: item.id, description: item.executable, executor: item,
        })), { placeHolder: "Explicitly select the installed dotnet SDK executor; other C# tools are not qualified" }))?.executor;
      if (!executor) return;
      const files = project ? await vscode.window.showOpenDialog({ canSelectMany: false, canSelectFiles: true,
        canSelectFolders: false, defaultUri: vscode.Uri.file(selected.entry.root!),
        filters: { "JavaScript / TypeScript entry": ["cjs", "js", "mjs", "ts", "mts", "cts"] },
        openLabel: "Review exact entry; TypeScript reuses installed Node only (no npm/build/install)" }) : undefined;
      if (project && !files?.length) return;
      const runtime = authority.selectRuntime(journal, selected.entry.id, executor.id, files?.[0].fsPath);
      const input = await vscode.window.showInputBox({ prompt: "Program arguments as a JSON string array (12 arguments, 2048 UTF-8 bytes maximum)", value: '["hello","with spaces"]' });
      if (input === undefined) return;
      const args: unknown = JSON.parse(input);
      const wait = project ? "0" : await vscode.window.showInputBox({ prompt: "Controlled wait in milliseconds (0–20000); progress notification supports cancellation", value: "0" });
      if (wait === undefined) return;
      if (!Array.isArray(args) || args.length > 12 || args.some(item => typeof item !== "string" || item.length > 256 || item.includes("\0"))
        || Buffer.byteLength(JSON.stringify(args)) > 2048 || !/^\d+$/.test(wait) || Number(wait) > 20_000)
        throw new Error("Invalid controlled program arguments or wait duration.");
      const parameters: LocalProgramParameters = { args, waitMs: Number(wait) };
      const decision = await vscode.window.showWarningMessage(project ? "Run this explicitly reviewed Node project entry?" : "Run this registered native controlled Workflow program?",
        { modal: true, detail: `Workspace: ${workspaceId}\nActor: local:owner\nEnvironment: ${runtime.environmentId}\nExecutor: ${runtime.executorId}\nProvider: ${runtime.provider}\nExecutable: ${runtime.executable}\nTarget: ${runtime.target}\nArguments: ${JSON.stringify(parameters)}\nProgram: ${runtime.project
          ? `${runtime.project.format ?? "commonjs"} entry: ${runtime.project.entry}\nTypeScript: ${runtime.project.typescript ? "selected Node's existing strip-only support; unsupported syntax/runtime fails, no compiler download" : "no"}\nCWD: ${runtime.project.root}\nSource SHA-256: ${runtime.project.sourceSha256}\nPackage/lock inputs: ${JSON.stringify(runtime.project.files)}\nExact entry source:\n${runtime.project.source}\nLocal imports/dependencies are NOT recursively frozen. Reviewed code runs with your OS permissions and can have arbitrary effects; only the directly owned process is cancelled. 25-second runtime deadline. No npm/package hooks or installer is invoked by PKM.`
          : node ? "fixed Node.js argument echo + bounded cancellable wait, via stdin" : "fixed C# argument echo + bounded wait; offline compile with installed .NET 8 SDK/reference packs beneath the selected runtime, same owner and not group/world writable (no restore or package sources)"}\nJournal: ${journal.directory}\nArguments and bounded output persist locally. OS user permissions, not a sandbox. No inherited credentials or shell; PKM performs no installation or downloads. One-run approval only; interrupted effects are UNKNOWN and never automatically replayed.` },
        "Approve controlled Workflow");
      check();
      if (decision !== "Approve controlled Workflow") return;
      if (project && vscode.workspace.getConfiguration("personalKnowledge").get<boolean>("experimental.localEnvironmentUpgrade", false) !== true)
        throw new Error("The experimental project environment gate changed; no program admitted.");
      authority.validateRuntime(runtime, journal);
      await command({ operation: "open", recover: false });
      const initial = await command({ operation: "start", runtime, parameters }), runId = initial[0]?.runId;
      if (!runId) throw new Error("Environment run admission result missing; inspect history, do not replay.");
      const result = await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification,
        title: `PKM ${runtime.provider}: ${runId}`, cancellable: true }, async (_progress, token) => {
        let cancellation: Promise<unknown> | undefined;
        const subscription = token.onCancellationRequested(() => {
          cancellation ??= command({ operation: "cancel", runId });
          void cancellation.catch(() => undefined);
        });
        try {
          for (;;) {
            check();
            if (cancellation) await cancellation;
            const run = (await command({ operation: "status" })).find(item => item.runId === runId);
            if (!run) throw new Error("Environment run receipt missing; no automatic retry.");
            if (!["ready", "running"].includes(run.state) && run.jobs.every(job => !["QUEUED", "RUNNING"].includes(job.state))) return run;
            await new Promise(resolve => setTimeout(resolve, 200));
          }
        } finally { subscription.dispose(); }
      });
      await vscode.window.showInformationMessage(display([result]));
    } catch (error) {
      void vscode.window.showErrorMessage(`PKM Next Runtime: ${error instanceof Error ? error.message : "Outcome unknown."} Preserve the journal; no automatic replay or install.`);
    } finally { authority?.revoke(); busy = false; }
  }));
}
