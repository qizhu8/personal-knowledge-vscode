import * as vscode from "vscode";
import * as fs from "fs";
import { randomBytes } from "crypto";
import type { BackgroundTaskSnapshot } from "../runtime/background-task-registry";
import type { RetrievalWorkerLifecycle, RetrievalWorkerStatus } from "../retrieval/retrieval-worker";
import type { GitHubSyncTarget } from "../sync/github-sync";
import type { GitHubSyncRuntimeState } from "../sync/github-sync-scheduler";

export function indexBuildPercent(progress?: { current: number; total?: number }): number | undefined {
  if (!progress || !Number.isFinite(progress.current) || progress.current < 0
    || typeof progress.total !== "number" || !Number.isFinite(progress.total) || progress.total <= 0
    || progress.current > progress.total) return undefined;
  return Math.floor(progress.current / progress.total * 100);
}

export function dashboardSyncTargets(targets: GitHubSyncTarget[], runtime: Record<string, GitHubSyncRuntimeState>) {
  return targets.map(target => {
    const state = runtime[target.id];
    const success = Math.max(Date.parse(target.lastSync?.at || "") || 0, Date.parse(state?.lastSuccessAt || "") || 0);
    const failed = (Date.parse(target.lastFailure?.at || "") || 0) > success;
    const attempted = Date.parse(state?.lastAttemptAt || "") || 0;
    const superseded = success > 0 && attempted > 0 && attempted <= success;
    const runtimeFailed = !!state?.lastError && !superseded || state?.status === "error" && !superseded;
    const active = state?.status === "syncing" || state?.status === "queued";
    const attention = state?.status === "needs-attention" || state?.status === "blocked";
    const pending = Object.keys(target.lastSync?.entityBases || {}).length > 0;
    const status = active || attention ? state.status : pending ? "partial" : failed || runtimeFailed ? "error"
      : !target.automation.enabled ? "paused"
      : !state ? "unavailable" : superseded && (state.status === "error" || state.status === "partial") ? "scheduled" : state.status;
    return {
      id: target.id, name: target.name, status,
      detail: failed && !active && !attention ? target.lastFailure!.error : superseded && status === "scheduled" ? undefined : state?.detail,
      error: failed && !active ? target.lastFailure!.error : runtimeFailed && !active ? state?.lastError : undefined,
      lastSuccessAt: success ? new Date(success).toISOString() : undefined,
      nextSyncAt: state?.nextSyncAt,
    };
  });
}

export interface StatusDashboardSnapshot {
  updatedAt: string;
  host: { version: string; build: string; installedVersion?: string; installedBuild?: string; pid: number;
    node: string; vscode: string; hosts: number; busy: boolean; integration: string; error?: string };
  retrieval: { lifecycle: RetrievalWorkerLifecycle; observedAt?: string; status?: Pick<RetrievalWorkerStatus,
    "ready" | "ready_generation" | "building_generation" | "document_count" | "error">; error?: string };
  sync: ReturnType<typeof dashboardSyncTargets>;
  tasks: BackgroundTaskSnapshot;
}

export class StatusDashboard implements vscode.Disposable {
  private panel?: vscode.WebviewPanel;
  private timer?: ReturnType<typeof setTimeout>;
  private loadingPanel?: vscode.WebviewPanel;
  private subscriptions: vscode.Disposable[] = [];

  constructor(private readonly context: vscode.ExtensionContext,
    private readonly snapshot: () => Promise<StatusDashboardSnapshot>,
    private readonly diagnostics: () => Promise<unknown>) {}

  async open(): Promise<void> {
    if (this.panel) { this.panel.reveal(); return; }
    const resources = vscode.Uri.joinPath(this.context.extensionUri, "dist", "webview");
    const panel = vscode.window.createWebviewPanel("personalKnowledge.statusDashboard", "PKM Status Dashboard",
      vscode.ViewColumn.Active, { enableScripts: true, localResourceRoots: [resources], retainContextWhenHidden: false });
    this.panel = panel;
    this.subscriptions = [
      panel.webview.onDidReceiveMessage((message: { type?: string }) => {
        if (this.panel !== panel) return;
        if (message.type === "ready" || message.type === "refresh") void this.refresh(panel);
        else if (message.type === "diagnostics") void this.diagnostics().catch(error => vscode.window.showErrorMessage(String(error)));
        else if (message.type === "logs") void vscode.commands.executeCommand("personalKnowledge.showLogs");
        else if (message.type === "sync") void vscode.commands.executeCommand("personalKnowledge.openPanelTab", "githubSync");
      }),
      panel.onDidChangeViewState(() => {
        if (this.timer) clearTimeout(this.timer);
        this.timer = undefined;
        if (panel.visible) void this.refresh(panel);
      }),
      panel.onDidDispose(() => this.release(panel)),
    ];
    try {
      const template = await fs.promises.readFile(vscode.Uri.joinPath(resources, "status-dashboard.html").fsPath, "utf8");
      if (this.panel !== panel) return;
      const assets: Record<string, string> = { nonce: randomBytes(18).toString("base64"), cspSource: panel.webview.cspSource };
      for (const [key, name] of [["styles", "status-dashboard.css"], ["script", "status-dashboard.js"]]) {
        assets[key] = panel.webview.asWebviewUri(vscode.Uri.joinPath(resources, name)).toString();
      }
      panel.webview.html = template.replace(/\{\{(\w+)\}\}/g, (match, key: string) => assets[key] || match);
    } catch (error) { panel.dispose(); throw error; }
  }

  private async refresh(panel: vscode.WebviewPanel): Promise<void> {
    if (this.panel !== panel || !panel.visible || this.loadingPanel === panel) return;
    this.loadingPanel = panel;
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
    try {
      const snapshot = await this.snapshot();
      if (this.panel === panel && panel.visible) void panel.webview.postMessage({ type: "snapshot", snapshot });
    } catch (error) {
      if (this.panel === panel && panel.visible) void panel.webview.postMessage({ type: "error", message: String(error) });
    } finally {
      if (this.loadingPanel === panel) this.loadingPanel = undefined;
      if (this.panel === panel && panel.visible) this.timer = setTimeout(() => { this.timer = undefined; void this.refresh(panel); }, 2_000);
    }
  }

  private release(panel: vscode.WebviewPanel): void {
    if (this.panel !== panel) return;
    this.panel = undefined;
    if (this.loadingPanel === panel) this.loadingPanel = undefined;
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
    for (const subscription of this.subscriptions.splice(0)) subscription.dispose();
  }

  dispose(): void { const panel = this.panel; if (panel) { this.release(panel); panel.dispose(); } }
}
