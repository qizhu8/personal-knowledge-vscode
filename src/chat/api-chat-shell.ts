import * as vscode from "vscode";
import * as fs from "fs";
import * as path from "path";
import { randomBytes } from "crypto";
import type { ApiChatView } from "./api-chat-view";
import { getStorePath } from "../knowledge/filestore";
import { loadedExtensionBuild } from "../runtime/extension-host-runtime";
import { hostname } from "os";
import { ApiChatAgentControl } from "./agent-control";
import { registerVisualizationWindow } from "./visualization-window";

/** Startup timing sink (PKM log). Slow first starts are diagnosed from these lines, not guessed. */
export let chatStartupTrace: ((message: string) => void) | undefined;
export function setChatStartupTrace(trace: ((message: string) => void) | undefined): void { chatStartupTrace = trace; }

export function registerApiChatHost(context: vscode.ExtensionContext, handle: (operation: string, args: Record<string, unknown>) => Promise<unknown>, busy: () => boolean): void {
  let control: ApiChatAgentControl | undefined;
  let controlRoot: string | undefined;
  let registrationError = "";
  const refreshControl = () => {
    const root = getStorePath();
    const folders = vscode.workspace.workspaceFolders || [];
    const nextRoot = root && path.isAbsolute(root) && folders.length
      && folders.every(folder => ["file", "vscode-remote"].includes(folder.uri.scheme)) ? path.resolve(root) : undefined;
    if (nextRoot === controlRoot || busy()) return;
    control?.dispose(); control = undefined; controlRoot = undefined;
    if (!nextRoot) return;
    try {
      control = new ApiChatAgentControl(path.join(nextRoot, ".pkm", "state"), {
        workspacePaths: folders.map(folder => folder.uri.fsPath), build: loadedExtensionBuild, machine: hostname(),
      }, handle);
      controlRoot = nextRoot; registrationError = "";
    } catch (error) {
      const message = error instanceof Error ? error.message : "PKM Chat Host registration failed.";
      if (message !== registrationError) console.warn("PKM Chat Host registration failed: " + message);
      registrationError = message;
    }
  };
  refreshControl();
  const timer = setInterval(refreshControl, 1000); timer.unref();
  context.subscriptions.push({ dispose: () => { clearInterval(timer); control?.dispose(); } },
    vscode.workspace.onDidChangeConfiguration(event => { if (event.affectsConfiguration("personalKnowledge")) refreshControl(); }));
}

export function renderApiChat(view: vscode.WebviewView, context: vscode.ExtensionContext): void {
  const resources = vscode.Uri.joinPath(context.extensionUri, "dist", "webview");
  view.webview.options = { enableScripts: true, localResourceRoots: [resources] };
  const resource = (name: string) => view.webview.asWebviewUri(vscode.Uri.joinPath(resources, name)).toString();
  const assets: Record<string, string> = {
    cspSource: view.webview.cspSource, nonce: randomBytes(18).toString("base64"),
    styles: resource("api-chat.css"), script: resource("api-chat.js"), icons: resource("codicon.css"),
    marked: resource("marked.umd.js"), purify: resource("purify.min.js"),
    katex: resource("katex.js"), katexStyles: resource("katex.css"), mermaid: resource("mermaid.js"),
    libraryScript: resource("api-chat-library.js"), retrievalScript: resource("chat-retrieval-flow.js"),
    hostHealthScript: resource("host-health.js"), hostHealthStyles: resource("host-health.css"),
    harnessScript: resource("agent-harness.js"), harnessStyles: resource("agent-harness.css"),
    visualizationScript: resource("chat-visualization.js"),
  };
  view.webview.html = fs.readFileSync(path.join(resources.fsPath, "api-chat.html"), "utf8")
    .replace(/\{\{(\w+)\}\}/g, (match, key: string) => assets[key] || match);
}

export function registerApiChatShell(context: vscode.ExtensionContext, load: () => Promise<ApiChatView>): {
  readonly isBusy: boolean;
  portalChatBindings(): Promise<Array<{ id: string; title: string }>>;
  executeRemoteTask(prompt: string, signal: AbortSignal, requestId: string, chatId: string, observer?: import("../chatroom/portal-runtime").PortalObserver, source?: import("../chatroom/portal-runtime").PortalSource, profileSnapshot?: import("./persona-profiles").PersonaSnapshot): Promise<unknown>;
  readPortalTaskAttempts(chatId: string, requestId: string, replyId?: string): Promise<import("./portal-task-attempts").PortalTaskAttempts | undefined>;
  reviewPortalProfiles(chatId: string): Promise<import("./persona-profiles").PersonaSnapshot | undefined>;
  portalContext(chatId?: string, label?: string): Promise<{ id: string; label: string }>;
  renamePortalContext(chatId: string, label: string): Promise<{ id: string; label: string }>;
  choosePortalContext(): Promise<{ id: string; label: string } | undefined>;
  requestPortalInteraction(chatId: string, interaction: import("./portal-interaction").PortalInteraction, current: () => boolean): Promise<import("./portal-interaction").PortalInteractionAnswer | undefined>;
  receivePortalReview(chatId: string, review: import("../chatroom/portal-runtime").PortalReview): Promise<void>;
  recordPortalCommand(chatId: string, activity: import("./portal-command-activity").PortalCommandActivity): Promise<void>;
  recordPortalTransfer(chatId: string, status: import("../chatroom/portal-files").PortalTransferStatus, peerName: string): Promise<void>;
} {
  let backend: ApiChatView | undefined;
  let loading: Promise<ApiChatView> | undefined;
  const busy = () => !!loading && !backend || backend?.isBusy === true;
  const getBackend = async () => {
    try { backend = await (loading ||= load()); return backend; }
    catch (error) { loading = undefined; throw error; }
  };
  const shell: vscode.WebviewViewProvider = {
    resolveWebviewView(view) {
      const resolvedAt = Date.now();
      let closed = false;
      let connecting = false;
      const listener = view.webview.onDidReceiveMessage(async message => {
        if (!message || typeof message !== "object" || closed) return;
        if (message.type === "hostHealth") {
          if (typeof message.id === "string" && message.id.length <= 64)
            void view.webview.postMessage({ type: "hostHealth", id: message.id });
          return;
        }
        if (message.type !== "ready" || connecting) return;
        connecting = true;
        try {
          await new Promise<void>(resolve => setTimeout(resolve, 0));
          if (closed) return;
          const loadStartedAt = Date.now();
          backend = await getBackend();
          chatStartupTrace?.(`PKM Chat startup: view resolved→ready ${loadStartedAt - resolvedAt}ms, backend load ${Date.now() - loadStartedAt}ms`);
          if (closed) return;
          listener.dispose();
          backend.attachWebviewView(view, true);
        } catch (error) {
          loading = undefined;
          if (!closed) void view.webview.postMessage({ type: "initializationError", message: error instanceof Error ? error.message : String(error) });
        } finally { connecting = false; }
      });
      view.onDidDispose(() => { closed = true; listener.dispose(); });
      if (backend) { listener.dispose(); backend.resolveWebviewView(view); }
      else renderApiChat(view, context);
    },
  };
  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider("personalKnowledge.apiChat", shell, { webviewOptions: { retainContextWhenHidden: true } }),
    vscode.commands.registerCommand("personalKnowledge.openApiChat", async (locator?: string) => typeof locator === "string" ? (await getBackend()).openPkmChat(locator) : vscode.commands.executeCommand("personalKnowledge.apiChat.focus")),
    vscode.commands.registerCommand("personalKnowledge.readChatHarness", async (chatId: string, method: string, params: Record<string, unknown>) =>
      (await getBackend()).readVisualization(chatId, method, params)),
    vscode.commands.registerCommand("personalKnowledge.configureApiChatSession", async (sessionId: string, section: string) => (await getBackend()).configureAgent(sessionId, section)),
    vscode.commands.registerCommand("personalKnowledge.userProfileFragments", async (operation: string, params: Record<string, unknown>) => (await getBackend()).userProfileFragments(operation, params)),
    vscode.commands.registerCommand("personalKnowledge.recoverAgentSnapshot", async (snapshotId: string) => (await getBackend()).recoverAgentSnapshot(snapshotId)),
    vscode.commands.registerCommand("personalKnowledge.testApiChatE2E", async () => (await getBackend()).runAcceptance()),
    vscode.commands.registerCommand("personalKnowledge.exportMcpToolSets", async () => (await getBackend()).exportMcpToolSets()),
  );
  registerVisualizationWindow(context, getBackend);
  registerApiChatHost(context, async (operation, args) => (await getBackend()).agentControl(operation, args), busy);
  return { get isBusy() { return busy(); },
    readPortalTaskAttempts: async (chatId, requestId, replyId) => (await getBackend()).readPortalTaskAttempts(chatId, requestId, replyId),
    receivePortalReview: async (chatId, review) => (await getBackend()).receivePortalReview(chatId, review),
    portalChatBindings: async () => (await getBackend()).portalChatBindings(),
    recordPortalCommand: async (chatId, activity) => (await getBackend()).recordPortalCommand(chatId, activity),
    recordPortalTransfer: async (chatId, status, peerName) => (await getBackend()).recordPortalTransfer(chatId, status, peerName),
    executeRemoteTask: async (prompt, signal, requestId, chatId, observer, source, profileSnapshot) => (await getBackend()).executeRemoteTask(prompt, signal, requestId, chatId, observer, source, profileSnapshot),
    reviewPortalProfiles: async chatId => (await getBackend()).reviewPortalProfiles(chatId),
    requestPortalInteraction: async (chatId, interaction, current) => (await getBackend()).requestPortalInteraction(chatId, interaction, current),
    portalContext: async (chatId, label) => (await getBackend()).portalContext(chatId, label),
    renamePortalContext: async (chatId, label) => (await getBackend()).renamePortalContext(chatId, label),
    choosePortalContext: async () => (await getBackend()).choosePortalContext() };
}