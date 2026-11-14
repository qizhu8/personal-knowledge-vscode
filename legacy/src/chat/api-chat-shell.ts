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
import { withAsyncDeadline } from "../runtime/async-deadline";

export const CHAT_STARTUP_TIMEOUT_MS = 180_000;

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
  const html = fs.readFileSync(path.join(resources.fsPath, "api-chat.html"), "utf8");
  if (!html.includes('id="pkm-chat-loading"') || !html.includes("{{hostHealthScript}}") || !html.includes("{{script}}")) {
    throw new Error("The packaged PKM Chat HTML is damaged. Reinstall the extension.");
  }
  for (const name of ["host-health.js", "api-chat.js", "api-chat-library.js", "api-chat.css", "codicon.css", "codicon.ttf"]) {
    fs.accessSync(path.join(resources.fsPath, name), fs.constants.R_OK);
  }
  view.webview.html = html.replace(/\{\{(\w+)\}\}/g, (match, key: string) => assets[key] || match);
}

export function renderApiChatFailure(view: vscode.WebviewView, error: unknown): void {
  const nonce = randomBytes(18).toString("base64");
  const message = (error instanceof Error ? error.message : "PKM Chat assets could not be loaded.")
    .replace(/[&<>"']/g, character => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[character]!);
  view.webview.options = { enableScripts: true, localResourceRoots: [] };
  view.webview.html = `<!doctype html><html><head><meta charset="utf-8">
    <meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'nonce-${nonce}'; style-src 'nonce-${nonce}'">
    <style nonce="${nonce}">body{font-family:var(--vscode-font-family);color:var(--vscode-foreground);background:var(--vscode-editor-background);padding:16px}p{overflow-wrap:anywhere}button{margin:4px;padding:6px 10px;color:var(--vscode-button-foreground);background:var(--vscode-button-background);border:0}</style>
    </head><body><section role="alert"><h2>PKM Chat could not load</h2><p>${message}</p>
    <p>Your Chat data has not been deleted. Check file permissions or reinstall the extension, then retry.</p></section>
    <button id="retry" type="button">Retry loading interface</button><button id="logs" type="button">Open diagnostic log</button>
    <script nonce="${nonce}">const api=acquireVsCodeApi();document.getElementById('retry').onclick=()=>api.postMessage({type:'ready'});document.getElementById('logs').onclick=()=>api.postMessage({type:'showLogs'});</script></body></html>`;
}

/** A view backend supplied by an already-authorized owner; this does not establish root ownership. */
export interface OwnedChatViewBackend {
  readonly isBusy: boolean;
  attachWebviewView(view: vscode.WebviewView, retainHtml: boolean): void;
  openPkmChat(locator: string): Promise<void>;
  drainManagedWriter(): Promise<void>;
  dispose(): void;
}

export function registerApiChatShell(context: vscode.ExtensionContext, load: (signal: AbortSignal) => Promise<ApiChatView>,
  ownedView?: { load(signal: AbortSignal): Promise<OwnedChatViewBackend> }): {
  readonly isBusy: boolean;
  drainManagedWriter(): Promise<void>;
  portalChatBindings(): Promise<Array<{ id: string; title: string }>>;
  preparePortalMutationPolicy(chatId: string): Promise<void>;
  assertPortalMutationAllowed(chatId: string): void;
  executeRemoteTask(prompt: string, signal: AbortSignal, requestId: string, chatId: string, observer?: import("../chatroom/portal-runtime").PortalObserver, source?: import("../chatroom/portal-runtime").PortalSource, profileSnapshot?: import("./persona-profiles").PersonaSnapshot): Promise<unknown>;
  readPortalTaskAttempts(chatId: string, requestId: string, replyId?: string): Promise<import("./portal-task-attempts").PortalTaskAttempts | undefined>;
  reviewPortalProfiles(chatId: string): Promise<import("./persona-profiles").PersonaSnapshot | undefined>;
  portalContext(chatId?: string, label?: string): Promise<{ id: string; label: string }>;
  renamePortalContext(chatId: string, label: string): Promise<{ id: string; label: string }>;
  choosePortalContext(): Promise<{ id: string; label: string } | undefined>;
  runNoteBoardConversion(prompt: string, title: string): Promise<void>;
  requestPortalInteraction(chatId: string, interaction: import("./portal-interaction").PortalInteraction, current: () => boolean): Promise<import("./portal-interaction").PortalInteractionAnswer | undefined>;
  receivePortalReview(chatId: string, review: import("../chatroom/portal-runtime").PortalReview): Promise<void>;
  recordPortalCommand(chatId: string, activity: import("./portal-command-activity").PortalCommandActivity): Promise<void>;
  recordPortalTransfer(chatId: string, status: import("../chatroom/portal-files").PortalTransferStatus, peerName: string): Promise<void>;
} {
  let backend: ApiChatView | OwnedChatViewBackend | undefined;
  let loading: Promise<ApiChatView | OwnedChatViewBackend> | undefined;
  let loadingController: AbortController | undefined;
  let managedWriterFenced = false;
  let attempt = 0;
  const busy = () => !!loading && !backend || backend?.isBusy === true;
  const getBackend = async () => {
    if (backend) return backend;
    if (loading) return loading;
    const controller = new AbortController();
    loadingController = controller;
    const id = ++attempt;
    chatStartupTrace?.(`PKM Chat backend load started: attempt=${id}`);
    const pending = Promise.resolve().then(() => {
      if (controller.signal.aborted) throw new Error("PKM Chat backend loading was cancelled.");
      return ownedView ? ownedView.load(controller.signal) : load(controller.signal);
    }).then(loaded => {
      if (controller.signal.aborted) {
        loaded.dispose();
        throw new Error("PKM Chat discarded a cancelled backend load.");
      }
      return loaded;
    });
    const current = withAsyncDeadline(pending, CHAT_STARTUP_TIMEOUT_MS,
      "PKM Chat backend loading timed out after 3 minutes. Reconnect to retry; no Chat request was sent.", controller.signal)
      .then(async loaded => {
        try {
          if (managedWriterFenced) await loaded.drainManagedWriter();
        } catch (error) {
          loaded.dispose();
          throw error;
        }
        backend = loaded;
        chatStartupTrace?.(`PKM Chat backend load completed: attempt=${id}`);
        return loaded;
      }, error => {
        controller.abort();
        chatStartupTrace?.(`PKM Chat backend load failed: attempt=${id} ${error instanceof Error ? error.message : String(error)}`);
        throw error;
      }).finally(() => {
        if (loading === current) { loading = undefined; loadingController = undefined; }
      });
    loading = current;
    return current;
  };
  const callBackend = async <T>(work: (chat: ApiChatView) => Promise<T>, cancellation = false): Promise<T> => {
    if (ownedView) throw new Error("This Chat operation is unavailable on the current owner; no legacy writer was started.");
    const chat = await getBackend() as ApiChatView;
    return chat.runHostWriter(() => work(chat), cancellation);
  };
  const legacyBackend = async (): Promise<ApiChatView> => {
    if (ownedView) throw new Error("This Chat operation is unavailable on the current owner; no legacy writer was started.");
    return await getBackend() as ApiChatView;
  };
  const shell: vscode.WebviewViewProvider = {
    resolveWebviewView(view) {
      const resolvedAt = Date.now();
      chatStartupTrace?.("PKM Chat view resolved");
      let closed = false;
      let connecting = false;
      let assetFailure = false;
      const render = () => {
        chatStartupTrace?.("PKM Chat interface render started");
        try {
          renderApiChat(view, context);
          assetFailure = false;
          chatStartupTrace?.("PKM Chat interface render completed");
        } catch (error) {
          assetFailure = true;
          chatStartupTrace?.(`PKM Chat interface render failed: ${error instanceof Error ? error.message : String(error)}`);
          renderApiChatFailure(view, error);
        }
      };
      const listener = view.webview.onDidReceiveMessage(async message => {
        if (!message || typeof message !== "object" || closed) return;
        if (message.type === "hostHealth") {
          if (typeof message.id === "string" && message.id.length <= 64)
            void view.webview.postMessage({ type: "hostHealth", id: message.id });
          return;
        }
        if (message.type === "showLogs") {
          await vscode.commands.executeCommand("personalKnowledge.showLogs");
          return;
        }
        if (message.type === "interfaceError") {
          chatStartupTrace?.(`PKM Chat interface failure: ${String(message.message || "A script failed to load.").slice(0, 600)}`);
          return;
        }
        if (message.type !== "ready" || connecting) return;
        if (assetFailure) { render(); return; }
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
          chatStartupTrace?.(`PKM Chat view initialization failed: ${error instanceof Error ? error.message : String(error)}`);
          if (!closed) void view.webview.postMessage({ type: "initializationError", message: error instanceof Error ? error.message : String(error) });
        } finally { connecting = false; }
      });
      view.onDidDispose(() => { closed = true; listener.dispose(); });
      render();
    },
  };
  context.subscriptions.push(
    { dispose: () => { loadingController?.abort(); if (ownedView) backend?.dispose(); } },
    vscode.window.registerWebviewViewProvider("personalKnowledge.apiChat", shell, { webviewOptions: { retainContextWhenHidden: true } }),
    vscode.commands.registerCommand("personalKnowledge.openApiChat", async (locator?: string) => typeof locator === "string"
      ? ownedView ? (await getBackend()).openPkmChat(locator) : callBackend(chat => chat.openPkmChat(locator))
      : vscode.commands.executeCommand("personalKnowledge.apiChat.focus")),
    vscode.commands.registerCommand("personalKnowledge.readChatHarness", async (chatId: string, method: string, params: Record<string, unknown>) =>
      (await legacyBackend()).readVisualization(chatId, method, params)),
    vscode.commands.registerCommand("personalKnowledge.configureApiChatSession", async (sessionId: string, section: string) => callBackend(chat => chat.configureAgent(sessionId, section))),
    vscode.commands.registerCommand("personalKnowledge.userProfileFragments", async (operation: string, params: Record<string, unknown>) => callBackend(chat => chat.userProfileFragments(operation, params), operation === "cancel")),
    vscode.commands.registerCommand("personalKnowledge.recoverAgentSnapshot", async (snapshotId: string) => callBackend(chat => chat.recoverAgentSnapshot(snapshotId))),
    vscode.commands.registerCommand("personalKnowledge.testApiChatE2E", async () => callBackend(chat => chat.runAcceptance())),
    vscode.commands.registerCommand("personalKnowledge.exportMcpToolSets", async () => callBackend(chat => chat.exportMcpToolSets())),
  );
  if (!ownedView) {
    registerVisualizationWindow(context, legacyBackend);
    registerApiChatHost(context, async (operation, args) => callBackend(chat => chat.agentControl(operation, args), operation === "cancel"), busy);
  }
  return { get isBusy() { return busy(); },
    drainManagedWriter: async () => {
      managedWriterFenced = true;
      const current = backend || (loading ? await loading : undefined);
      if (current) await current.drainManagedWriter();
    },
    readPortalTaskAttempts: async (chatId, requestId, replyId) => (await legacyBackend()).readPortalTaskAttempts(chatId, requestId, replyId),
    receivePortalReview: async (chatId, review) => callBackend(chat => chat.receivePortalReview(chatId, review)),
    portalChatBindings: async () => callBackend(async chat => chat.portalChatBindings()),
    preparePortalMutationPolicy: async chatId => callBackend(async chat => chat.assertPortalMutationAllowed(chatId)),
    assertPortalMutationAllowed: chatId => {
      if (ownedView) throw new Error("Portal Chat policy is unavailable on the current owner; no legacy writer was started.");
      if (!backend) throw new Error("The Chat workflow policy has not loaded. Retry this explicitly authorized operation.");
      (backend as ApiChatView).assertPortalMutationAllowed(chatId);
    },
    recordPortalCommand: async (chatId, activity) => callBackend(async chat => chat.recordPortalCommand(chatId, activity)),
    recordPortalTransfer: async (chatId, status, peerName) => callBackend(async chat => chat.recordPortalTransfer(chatId, status, peerName)),
    executeRemoteTask: async (prompt, signal, requestId, chatId, observer, source, profileSnapshot) => callBackend(chat => chat.executeRemoteTask(prompt, signal, requestId, chatId, observer, source, profileSnapshot)),
    reviewPortalProfiles: async chatId => callBackend(chat => chat.reviewPortalProfiles(chatId)),
    requestPortalInteraction: async (chatId, interaction, current) => callBackend(chat => chat.requestPortalInteraction(chatId, interaction, current)),
    portalContext: async (chatId, label) => callBackend(async chat => chat.portalContext(chatId, label)),
    renamePortalContext: async (chatId, label) => callBackend(async chat => chat.renamePortalContext(chatId, label)),
    choosePortalContext: async () => callBackend(chat => chat.choosePortalContext()),
    runNoteBoardConversion: async (prompt, title) => callBackend(chat => chat.runNoteBoardConversion(prompt, title)) };
}