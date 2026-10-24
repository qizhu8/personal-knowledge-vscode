import * as vscode from "vscode";
import * as fs from "fs";
import * as path from "path";
import { execFile } from "child_process";
import { randomBytes, randomUUID } from "crypto";
import { getStorePath } from "../knowledge/filestore";
import { parsePkmLocator } from "../knowledge/knowledge-locator";
import { configuredMcpFeatureDomains, mcpRuntimeStatus, writeActionWorkspaceConfig } from "../mcp/mcp";
import { ActionWorkbenchServer, createActionWorkbenchServer } from "../runtime/action-workbench-server";
import { BaselineEventKind, recordBaselineEvent } from "../runtime/pkm-baseline";

const actionMethods = new Set(["catalog", "module_sets", "load", "remove", "import", "export", "validate", "queue", "cancel_validation",
  "resume_validation", "select_implementation", "save_graph", "check_graph", "call", "run", "runs", "recover_runs", "cancel_run", "choices", "answer_choice",
  "group_create", "action_rename", "action_move", "action_delete", "definition_read", "definition_save", "source_read", "source_save", "migration_preview", "locator_read",
  "checkpoints", "respond_checkpoint", "schedule_run", "wake_run", "reconcile_run", "safety_scan", "associate_project",
  "platform_call", "retrieve", "definition_get", "library_get", "templates", "template_create", "check_checkpoint_answer"]);
let actionChatAvailable = false;
let browserServer: { store: string; promise: Promise<ActionWorkbenchServer> } | undefined;
const observedRuns = new Map<string, string>();

function measureAction(context: vscode.ExtensionContext, kind: BaselineEventKind, durationMs?: number): void {
  const directory = context.globalStorageUri?.fsPath;
  if (!directory) return;
  recordBaselineEvent(path.join(directory, "performance"),
    vscode.workspace.getConfiguration("personalKnowledge").get<boolean>("loadProfilingEnabled", false),
    { kind, source: "action-runtime", evidence: "observed", ...(durationMs === undefined ? {} : { durationMs }) });
}

function observeAction(context: vscode.ExtensionContext, method: string, result: Record<string, unknown>, durationMs: number): void {
  if (!["call", "run", "cancel_run"].includes(method) || typeof result.run_id !== "string" || typeof result.state !== "string") return;
  if (method === "call" && result.launch_reused === false) {
    measureAction(context, "start-request");
    measureAction(context, result.reasonCode === "dispatch-failed" ? "start-failed" : "start-success", durationMs);
  }
  const identity = `${getStorePath()}:${result.run_id}`;
  const state = typeof result.userState === "string" ? result.userState : result.state;
  const previous = observedRuns.get(identity);
  if (state !== previous) {
    if (state === "Waiting") measureAction(context, "wait");
    if (previous === "Waiting" && ["Running", "Completed"].includes(state)) measureAction(context, "resume");
    if (state === "Reconciling") measureAction(context, "unknown-effect");
    if (previous || method === "call" && result.launch_reused === false) {
      if (state === "Completed") measureAction(context, "completed");
      if (state === "Failed") measureAction(context, "failed");
      if (state === "Cancelled") measureAction(context, "cancel");
    }
  }
  observedRuns.set(identity, state);
  if (observedRuns.size > 512) {
    const oldest = observedRuns.keys().next().value;
    if (oldest !== undefined) observedRuns.delete(oldest);
  }
}

function checkActionAccess(): void {
  if (!configuredMcpFeatureDomains().includes("automation")) throw new Error("Enable the PKM automation domain before using Actions.");
  if (!vscode.workspace.isTrusted) throw new Error("Actions require a trusted VS Code workspace.");
}

export async function actionRequest(context: vscode.ExtensionContext, method: string, params: Record<string, unknown>): Promise<any> {
  checkActionAccess();
  if (!actionMethods.has(method)) throw new Error("Unsupported Action operation.");
  const runtime = mcpRuntimeStatus();
  if (!runtime.healthy) throw new Error(runtime.error || "Configure the PKM Python runtime first.");
  const started = Date.now();
  return new Promise((resolve, reject) => {
    const child = execFile(runtime.python, [path.join(context.extensionPath, "resources", "action_modules.py"), "--api", getStorePath()],
      { timeout: 30000, maxBuffer: 2 * 1024 * 1024, windowsHide: true, env: { ...process.env, PYTHONUTF8: "1", PYTHONIOENCODING: "utf-8" } }, (error, stdout) => {
        if (error) return reject(new Error(`Action service failed: ${error.message}`));
        try {
          const result = JSON.parse(stdout);
          if (result.ok === false) reject(new Error(result.error || "Action request failed."));
          else {
            observeAction(context, method, result, Date.now() - started);
            resolve(result);
          }
        } catch { reject(new Error("Action service returned invalid JSON.")); }
      });
    child.stdin?.end(JSON.stringify({ method, params }));
  });
}

export function initializeActionChat(context: vscode.ExtensionContext): void {
  actionChatAvailable = false;
  context.subscriptions.push(vscode.commands.registerCommand("personalKnowledge.answerActionChoice", async (runId, requestId, index) => {
    if (typeof runId !== "string" || !/^action_run_[0-9a-f]{32}$/.test(runId)
      || typeof requestId !== "string" || !/^choice_[0-9a-f]{32}$/.test(requestId) || !Number.isInteger(index) || index < 0 || index > 23) {
      throw new Error("Invalid Action choice.");
    }
    await actionRequest(context, "answer_choice", { run_id: runId, request_id: requestId, index });
    if (actionChatAvailable) await vscode.commands.executeCommand("workbench.action.chat.open", { query: `@pkm-actions ${runId}` });
  }));
  const [major, minor] = vscode.version.split(".").map(Number);
  if (!(major > 1 || major === 1 && minor >= 91) || !vscode.chat?.createChatParticipant) return;
  const participant = vscode.chat.createChatParticipant("personalKnowledge.actions", async (request, _chatContext, stream, token) => {
    const runId = request.prompt.trim();
    if (!/^action_run_[0-9a-f]{32}$/.test(runId)) {
      stream.markdown("Select an active Action Run in the Workbench to answer its pending choices.");
      return;
    }
    try {
      if (token.isCancellationRequested) return;
      const choices = await actionRequest(context, "choices", { run_id: runId });
      if (token.isCancellationRequested) return;
      if (!choices.requests.length) stream.markdown("This Action Run has no pending choices.");
      for (const choice of choices.requests) {
        stream.markdown(new vscode.MarkdownString().appendText(choice.prompt).appendMarkdown("\n\n"));
        choice.options.forEach((option: { label: string }, index: number) => stream.button({
          command: "personalKnowledge.answerActionChoice", title: option.label,
          arguments: [choice.run_id, choice.request_id, index],
        }));
      }
    } catch (error) { stream.markdown(new vscode.MarkdownString().appendText((error as Error).message)); }
  });
  participant.iconPath = new vscode.ThemeIcon("comment-discussion");
  actionChatAvailable = true;
  context.subscriptions.push(participant);
}

export function openActionWorkbenchTab(context: vscode.ExtensionContext, runId?: string, actionId?: string, library = false): void {
  checkActionAccess();
  if (runId && !/^action_run_[0-9a-f]{32}$/.test(runId)) throw new Error("Invalid Action Run.");
  if (actionId && !/^[a-z][a-z0-9_.-]{2,100}$/.test(actionId)) throw new Error("Invalid Action identity.");
  const panel = vscode.window.createWebviewPanel("personalKnowledge.actions", "Action Workbench", vscode.ViewColumn.One,
    { enableScripts: true, retainContextWhenHidden: true });
  panel.webview.html = actionWorkbenchHtml(panel.webview, context, runId, actionId, library);
  const listener = panel.webview.onDidReceiveMessage(message => handleActionWorkbenchMessage(context, message, response => panel.webview.postMessage(response)));
  panel.onDidDispose(() => listener.dispose());
  context.subscriptions.push(panel, listener);
}

async function workbenchRequest(context: vscode.ExtensionContext, method: string, params: Record<string, unknown>, browser = false): Promise<any> {
  checkActionAccess();
  if (method === "copy_path" && !browser) {
    const reference = typeof params.reference === "string" ? params.reference : "";
    const parsed = parsePkmLocator(reference);
    if (parsed.kind !== "knowledge" && !(parsed.kind === "entity" && ["actions", "components"].includes(parsed.area))) {
      throw new Error("Choose an Action or Component PKM identity.");
    }
    await vscode.env.clipboard.writeText(parsed.locator);
    return { ok: true };
  }
  if (method === "open_project") {
    if (typeof params.run_id !== "string" || !/^action_run_[0-9a-f]{32}$/.test(params.run_id)) throw new Error("Invalid Action Run.");
    const projectId = await vscode.commands.executeCommand<string>("personalKnowledge.openActionRunProject", params.run_id);
    return { ok: true, project_id: projectId };
  }
  const platform = process.platform === "win32" ? "windows" : process.platform === "darwin" ? "macos" : "linux";
  const configuration = vscode.workspace.getConfiguration("personalKnowledge");
  const workspaceRoot = () => configuration.get<Record<string, string>>("actions.workspaceRoots", {})[platform];
  if (method === "access") {
    const runtime = mcpRuntimeStatus();
    if (!runtime.healthy) throw new Error(runtime.error || "Configure the PKM Python runtime first.");
    return { ok: true };
  }
  if (method === "open_browser" && !browser) {
    await openActionWorkbenchInBrowser(context, params.draft);
    return { ok: true };
  }
  if (method === "background_tasks") {
    if (!browser) await vscode.commands.executeCommand("personalKnowledge.openPanelTab", "backgroundTasks");
    return browser ? actionRequest(context, "queue", {}) : { ok: true };
  }
  if (method === "workspace") {
    if (browser) {
      if (typeof params.root !== "string" || !path.isAbsolute(params.root) || !fs.existsSync(params.root) || !fs.statSync(params.root).isDirectory()) {
        throw new Error("Choose an existing absolute directory on the execution host.");
      }
      const roots = configuration.get<Record<string, string>>("actions.workspaceRoots", {});
      await configuration.update("actions.workspaceRoots", { ...roots, [platform]: fs.realpathSync(params.root) }, vscode.ConfigurationTarget.Global);
    } else await vscode.commands.executeCommand("personalKnowledge.configureActionWorkspace");
    writeActionWorkspaceConfig();
    return { ok: true, workspace_root: workspaceRoot() || "" };
  }
  if (method === "import" && !params.local_path) {
    if (browser) throw new Error("Choose a ModuleSet package path on the execution host.");
    const selected = await vscode.window.showOpenDialog({ canSelectMany: false, filters: { "Action ModuleSet": ["pkm-actions"] } });
    if (!selected?.[0]) throw new Error("Import cancelled.");
    params.local_path = selected[0].fsPath;
  }
  if (method === "export" && !params.destination) {
    if (browser) throw new Error("Choose a ModuleSet destination on the execution host.");
    const selected = await vscode.window.showSaveDialog({ filters: { "Action ModuleSet": ["pkm-actions"] }, saveLabel: "Export selected Actions" });
    if (!selected) throw new Error("Export cancelled.");
    params.destination = selected.fsPath;
  }
  if (["call", "save_graph", "validate", "import", "export"].includes(method)) {
    let root = workspaceRoot();
    if (!root || !fs.existsSync(root) || !fs.statSync(root).isDirectory()) {
      if (browser) throw new Error("Select an Action working directory before continuing.");
      await vscode.commands.executeCommand("personalKnowledge.configureActionWorkspace");
      root = workspaceRoot();
      if (!root || !fs.existsSync(root) || !fs.statSync(root).isDirectory()) throw new Error("Select an available Action working directory before continuing.");
    }
    writeActionWorkspaceConfig();
  }
  const result = await actionRequest(context, method, params);
  return method === "catalog" ? { ...result, workspace_root: workspaceRoot() || "" } : result;
}

export async function openActionWorkbenchInBrowser(context: vscode.ExtensionContext, draft?: unknown): Promise<void> {
  await workbenchRequest(context, "access", {});
  const store = getStorePath();
  if (!store) throw new Error("Configure a Knowledge Root before opening the Workbench.");
  if (browserServer && browserServer.store !== store) {
    (await browserServer.promise).dispose();
    browserServer = undefined;
  }
  if (!browserServer) {
    const state = { store, promise: createActionWorkbenchServer({ extensionPath: context.extensionPath,
      request(method, params) {
        if (getStorePath() !== store) return Promise.reject(new Error("Knowledge Root changed. Reopen the Action Workbench from VS Code."));
        return workbenchRequest(context, method, params, true);
      } }) };
    browserServer = state;
    context.subscriptions.push({ dispose() { void state.promise.then(server => server.dispose()).catch(() => {}); if (browserServer === state) browserServer = undefined; } });
    state.promise.catch(() => { if (browserServer === state) browserServer = undefined; });
  }
  const server = await browserServer.promise;
  server.setDraft(draft || null);
  const local = new URL(server.url);
  const externalUri = await vscode.env.asExternalUri(vscode.Uri.parse(local.origin + "/"));
  const external = new URL(externalUri.toString());
  server.allowOrigin(external.origin);
  external.hash = `${local.hash}&launch=${randomUUID()}`;
  if (!await vscode.env.openExternal(vscode.Uri.parse(external.toString()))) throw new Error("The browser could not open the Action Workbench.");
}
/** Legacy commands focus the main panel; the standalone renderer is retained for compatibility/tests. */
export function openActionWorkbench(context: vscode.ExtensionContext, runId?: string, actionId?: string, library = false): void {
  checkActionAccess();
  if (runId && !/^action_run_[0-9a-f]{32}$/.test(runId)) throw new Error("Invalid Action Run.");
  if (actionId && !/^[a-z][a-z0-9_.-]{2,100}$/.test(actionId)) throw new Error("Invalid Action identity.");
  void vscode.commands.executeCommand("personalKnowledge.openEmbeddedActions", { runId, actionId, library });
}

function actionWorkbenchHtml(webview: vscode.Webview, context: vscode.ExtensionContext, runId?: string, actionId?: string, library = false): string {
  const nonce = randomBytes(24).toString("hex");
  const font = fs.readFileSync(path.join(context.extensionPath, "dist", "webview", "codicon.ttf")).toString("base64");
  const icons = fs.readFileSync(path.join(context.extensionPath, "dist", "webview", "codicon.css"), "utf8")
    .replace(/url\(["']?\.\/codicon\.ttf[^)]*\)/, `url("data:font/ttf;base64,${font}")`);
  let document = fs.readFileSync(path.join(context.extensionPath, "resources", "action-workbench.html"), "utf8");
  if (library) document = document.replace("initialView=vscode?.getState()||null",
    "initialView={...(vscode?.getState()||{}),libraryOpen:true}");
  if (runId) document = document.replace("initialView=vscode?.getState()||null",
    `initialView={...(vscode?.getState()||{}),currentRun:${JSON.stringify(runId)}}`);
  else if (actionId) document = document.replace("initialView=vscode?.getState()||null",
    `initialView={targetAction:${JSON.stringify(actionId)}}`);
  return document.replace("<head>", `<head><meta http-equiv="Content-Security-Policy" content="default-src 'none'; font-src data:; style-src 'unsafe-inline'; script-src 'nonce-${nonce}';"><style>${icons}</style>`)
    .replace(/<script>/g, `<script nonce="${nonce}">`);
}

export async function handleActionWorkbenchMessage(context: vscode.ExtensionContext, message: any, respond: (message: any) => unknown): Promise<void> {
  if (typeof message?.requestId !== "string" || typeof message?.method !== "string") return;
  try {
    if (message.method === "show_choices") {
      checkActionAccess();
      const runId = message.params?.run_id;
      if (typeof runId !== "string" || !/^action_run_[0-9a-f]{32}$/.test(runId)) throw new Error("Invalid Action Run.");
      if (actionChatAvailable) await vscode.commands.executeCommand("workbench.action.chat.open", { query: `@pkm-actions ${runId}` });
      await respond({ requestId: message.requestId, result: { ok: true, inline_chat: !actionChatAvailable } });
      return;
    }
    const result = await workbenchRequest(context, message.method, { ...(message.params || {}) });
    await respond({ requestId: message.requestId, result });
  } catch (error) {
    await respond({ requestId: message.requestId, result: { ok: false, error: (error as Error).message } });
  }
}

export function renderEmbeddedActionWorkbench(webview: vscode.Webview, context: vscode.ExtensionContext, snapshot: unknown): string {
  checkActionAccess();
  const state = JSON.stringify(snapshot || {}).replace(/</g, "\\u003c");
  const html = actionWorkbenchHtml(webview, context);
  const bridge = `let embeddedState=${state};const acquireVsCodeApi=()=>({getState:()=>embeddedState,setState:value=>{value={...value,libraryOpen:!!document.getElementById('action-library')?.open};embeddedState=value;parent.postMessage({channel:'pkm-actions',type:'state',state:value},'*');return value},postMessage:message=>parent.postMessage({channel:'pkm-actions',type:'request',message},'*')});
window.addEventListener('message',event=>{if(event.source!==parent||event.data?.channel!=='pkm-actions-control')return;if(event.data.command==='snapshot'){graph.name=document.getElementById('name').value;saveView();parent.postMessage({channel:'pkm-actions',type:'snapshot',state:embeddedState},'*')}});
window.addEventListener('load',()=>{document.addEventListener('input',()=>{graph.name=document.getElementById('name').value;queueMicrotask(saveView)});const library=document.getElementById('action-library');if(library)new MutationObserver(()=>saveView()).observe(library,{attributes:true,attributeFilter:['open']})});`;
  return html.replace(/(<script nonce="[a-f0-9]+">)/, (_, script) => script + bridge);
}
