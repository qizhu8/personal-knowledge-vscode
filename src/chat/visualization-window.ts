import * as vscode from "vscode";
import * as fs from "fs";
import * as path from "path";
import { randomBytes } from "crypto";

export interface VisualizationSource {
  visualizationLibrary(): { groups: Array<{ id: string; name: string }>; chats: Array<Record<string, unknown>> };
  readVisualization(chatId: string, method: string, params: Record<string, unknown>): Promise<unknown>;
  openVisualizationTarget(chatId: string, sourceUri?: string): Promise<void>;
  readonly onDidChangeRecords: vscode.Event<void>;
}

type WindowMessage = { type?: string; chatId?: string; sourceUri?: string; requestId?: string; method?: string; params?: Record<string, unknown> };

/** One editor-area window: Chat tree on the left, read-only Harness dashboard on the right. */
export class VisualizationWindow implements vscode.Disposable {
  private panel?: vscode.WebviewPanel;
  private source?: VisualizationSource;
  private readonly subscriptions: vscode.Disposable[] = [];
  private changeTimer?: ReturnType<typeof setTimeout>;
  private requestedChat?: string;

  constructor(private readonly context: vscode.ExtensionContext, private readonly load: () => Promise<VisualizationSource>) {}

  async open(chatId?: string): Promise<void> {
    if (chatId !== undefined && (typeof chatId !== "string" || !/^[a-f0-9-]{36}$/.test(chatId))) throw new Error("Choose a PKM Chat.");
    if (!vscode.workspace.isTrusted) throw new Error("Trust this workspace before inspecting execution records.");
    const source = await this.load();
    if (this.panel) {
      this.panel.reveal(undefined, false);
      if (chatId) void this.panel.webview.postMessage({ type: "select", chatId });
      return;
    }
    this.source = source;
    this.requestedChat = chatId;
    const resources = vscode.Uri.joinPath(this.context.extensionUri, "dist", "webview");
    const panel = vscode.window.createWebviewPanel("personalKnowledge.visualization", "PKM Visualization", vscode.ViewColumn.Active,
      { enableScripts: true, localResourceRoots: [resources], retainContextWhenHidden: false });
    this.panel = panel;
    const resource = (name: string) => panel.webview.asWebviewUri(vscode.Uri.joinPath(resources, name)).toString();
    const assets: Record<string, string> = {
      cspSource: panel.webview.cspSource, nonce: randomBytes(18).toString("base64"),
      icons: resource("codicon.css"), harnessStyles: resource("agent-harness.css"), styles: resource("visualization-window.css"),
      harnessScript: resource("agent-harness.js"), retrievalScript: resource("chat-retrieval-flow.js"), script: resource("visualization-window.js"),
    };
    panel.webview.html = fs.readFileSync(path.join(resources.fsPath, "visualization-window.html"), "utf8")
      .replace(/\{\{(\w+)\}\}/g, (match, key: string) => assets[key] || match);
    this.subscriptions.push(
      panel.webview.onDidReceiveMessage(message => { void this.handle(panel, message); }),
      source.onDidChangeRecords(() => this.changed(panel)),
      panel.onDidChangeViewState(() => { if (panel.visible) this.changed(panel); }),
      panel.onDidDispose(() => this.release(panel)),
    );
  }

  private changed(panel: vscode.WebviewPanel): void {
    if (this.panel !== panel || !panel.visible || this.changeTimer) return;
    this.changeTimer = setTimeout(() => {
      this.changeTimer = undefined;
      if (this.panel !== panel || !panel.visible) return;
      try { void panel.webview.postMessage({ type: "library", library: this.source!.visualizationLibrary(), changed: true }); }
      catch (error) { void panel.webview.postMessage({ type: "libraryError", message: error instanceof Error ? error.message : String(error) }); }
    }, 400);
  }

  private async handle(panel: vscode.WebviewPanel, message: WindowMessage): Promise<void> {
    if (this.panel !== panel || !message || typeof message !== "object") return;
    if (message.type === "ready") {
      const requested = this.requestedChat; this.requestedChat = undefined;
      try { void panel.webview.postMessage({ type: "library", library: this.source!.visualizationLibrary(), select: requested }); }
      catch (error) { void panel.webview.postMessage({ type: "libraryError", message: error instanceof Error ? error.message : String(error) }); }
      return;
    }
    if (message.type === "openChat" || message.type === "openSource") {
      try { await this.source!.openVisualizationTarget(message.chatId || "", message.type === "openSource" ? message.sourceUri ?? "" : undefined); }
      catch (error) { if (this.panel === panel) void panel.webview.postMessage({ type: "notice", message: error instanceof Error ? error.message : String(error) }); }
      return;
    }
    if (message.type !== "request" || typeof message.requestId !== "string" || message.requestId.length > 80) return;
    try {
      if (!vscode.workspace.isTrusted) throw new Error("Trust this workspace before inspecting execution records.");
      const data = await this.source!.readVisualization(message.chatId || "", message.method || "", message.params || {});
      if (this.panel === panel) void panel.webview.postMessage({ type: "result", requestId: message.requestId, chatId: message.chatId, data });
    } catch (error) {
      if (this.panel === panel) void panel.webview.postMessage({ type: "result", requestId: message.requestId, chatId: message.chatId,
        error: error instanceof Error ? error.message : String(error) });
    }
  }

  private release(panel: vscode.WebviewPanel): void {
    if (this.panel !== panel) return;
    this.panel = undefined; this.source = undefined; this.requestedChat = undefined;
    if (this.changeTimer) clearTimeout(this.changeTimer);
    this.changeTimer = undefined;
    for (const subscription of this.subscriptions.splice(0)) subscription.dispose();
  }

  dispose(): void { const panel = this.panel; if (panel) { this.release(panel); panel.dispose(); } }
}

export function registerVisualizationWindow(context: vscode.ExtensionContext, load: () => Promise<VisualizationSource>): VisualizationWindow {
  const window = new VisualizationWindow(context, load);
  context.subscriptions.push(window,
    vscode.commands.registerCommand("personalKnowledge.openVisualizationWindow", (chatId?: unknown) =>
      window.open(typeof chatId === "string" ? chatId : undefined)));
  return window;
}
