import * as vscode from "vscode";
import * as path from "path";
import { NativeChatUiProvider, type NativeChatUiBinding } from "./native-chat-ui-experiment";
import type { OwnedChatViewBackend } from "./api-chat-shell";

export const SELECTED_CHAT_VIEW = "personalKnowledge.nextSelectedChat";
export const FOCUS_SELECTED_CHAT_COMMAND = "personalKnowledge.focusNextSelectedChat";
const AVAILABLE_CONTEXT = "personalKnowledge.nextSelectedChatAvailable";
let activeRegistration = false;
let contextUpdates = Promise.resolve();
function setAvailable(available: boolean): Promise<void> {
  const update = contextUpdates.then(() => vscode.commands.executeCommand("setContext", AVAILABLE_CONTEXT, available)).then(() => {});
  contextUpdates = update.catch(() => {});
  return update;
}

interface SelectedOwnerChatUiOptions {
  binding: NativeChatUiBinding;
  connection: AbortSignal;
  assertCurrent(): void;
  resetPermissions?(): Promise<void>;
}

async function validateSelectedOwnerChatUi(options: SelectedOwnerChatUiOptions, onRevoked: () => void): Promise<{
  binding: NativeChatUiBinding; check(): void;
}> {
  const binding = Object.freeze({ ...options.binding });
  const endpoint = new URL(binding.endpoint);
  if (binding.fixture !== undefined || binding.todoBoards?.length || !path.isAbsolute(binding.root)
    || !binding.nonce || !/^[a-f0-9-]{36}$/.test(binding.workspaceId) || !binding.actorId
    || !/^[a-f0-9]{64}$/.test(binding.sourceFingerprint) || !/^[A-Za-z0-9_-]{43}$/.test(binding.bearer)
    || endpoint.protocol !== "http:" || endpoint.hostname !== "127.0.0.1" || !endpoint.port
    || endpoint.pathname !== "/" || endpoint.username || endpoint.password || endpoint.search || endpoint.hash)
    throw new Error("Invalid selected Chat host binding.");
  const check = () => {
    try {
      if (options.connection.aborted || vscode.workspace.isTrusted === false)
        throw new Error("Selected Chat connection or trusted workspace is unavailable.");
      const result: unknown = options.assertCurrent();
      if (result !== undefined) {
        void Promise.resolve(result).catch(() => {});
        throw new Error("Selected Chat authority must be checked synchronously.");
      }
    } catch (error) { onRevoked(); throw error; }
  };
  check();
  const response = await fetch(`${binding.endpoint}/rpc`, {
    method: "POST", redirect: "error", signal: options.connection,
    headers: { authorization: `Bearer ${binding.bearer}`, "x-pkm-native-actor": binding.actorId, "content-type": "application/json" },
    body: JSON.stringify({ method: "status" }),
  });
  const status = (await response.json() as { value?: Record<string, any> }).value;
  check();
  if (!response.ok || !status || status.root !== binding.root || status.workspaceId !== binding.workspaceId
    || status.actorId !== binding.actorId || status.sourceFingerprint !== binding.sourceFingerprint
    || status.managed !== true || status.processes !== true || status.processApprovalUi !== true
    || status.memory || status.recipes || status.todoBoards?.length)
    throw new Error("Selected Chat host does not match the live owner and process approval capability.");
  return { binding, check };
}

/** Explicit embedding capability; neither the binding nor Storage alone proves selection. */
export async function registerSelectedOwnerChatUi(context: vscode.ExtensionContext, options: SelectedOwnerChatUiOptions): Promise<vscode.Disposable> {
  let revoke = () => {};
  const { binding, check } = await validateSelectedOwnerChatUi(options, () => revoke());
  if (activeRegistration) throw new Error("A selected Chat UI is already registered.");
  const provider = new NativeChatUiProvider(context, binding, () => { check(); return binding; }, true, options.resetPermissions);
  activeRegistration = true;
  let view: vscode.Disposable | undefined, command: vscode.Disposable | undefined;
  let disposed = false;
  const dispose = () => {
    if (disposed) return;
    disposed = true;
    activeRegistration = false;
    options.connection.removeEventListener("abort", dispose);
    void setAvailable(false).catch(() => {});
    try { provider.dispose(); } finally { try { command?.dispose(); } finally { view?.dispose(); } }
  };
  revoke = dispose;
  try {
    view = vscode.window.registerWebviewViewProvider(SELECTED_CHAT_VIEW, provider, {
      webviewOptions: { retainContextWhenHidden: true },
    });
    command = vscode.commands.registerCommand(FOCUS_SELECTED_CHAT_COMMAND,
      async () => {
        check();
        await vscode.commands.executeCommand("workbench.view.extension.personalKnowledgeNextChat");
        check();
        return vscode.commands.executeCommand(`${SELECTED_CHAT_VIEW}.focus`);
      });
    options.connection.addEventListener("abort", dispose, { once: true });
    check();
    await setAvailable(true);
    check();
  } catch (error) { dispose(); throw error; }
  const registration = { dispose };
  context.subscriptions.push(registration);
  return registration;
}

/** Builds only a view adapter. The caller must own and drain its selected Chat session. */
export async function createSelectedOwnerChatViewBackend(context: vscode.ExtensionContext,
  options: SelectedOwnerChatUiOptions & { drain(): Promise<void> }): Promise<OwnedChatViewBackend> {
  let dispose = () => {};
  const { binding, check } = await validateSelectedOwnerChatUi(options, () => dispose());
  if (activeRegistration) throw new Error("A selected Chat UI is already registered.");
  let disposed = false;
  const checkLive = () => {
    if (disposed) throw new Error("Selected Chat view is closed.");
    check();
  };
  const provider = new NativeChatUiProvider(context, binding, () => { checkLive(); return binding; }, true, options.resetPermissions);
  activeRegistration = true;
  dispose = () => {
    if (disposed) return;
    disposed = true;
    activeRegistration = false;
    options.connection.removeEventListener("abort", dispose);
    provider.dispose();
  };
  options.connection.addEventListener("abort", dispose, { once: true });
  try { checkLive(); } catch (error) { dispose(); throw error; }
  return {
    get isBusy() { return provider.isBusy; },
    attachWebviewView(view, retainHtml) { checkLive(); provider.attachWebviewView(view, retainHtml); },
    openPkmChat(locator) { checkLive(); return provider.openPkmChat(locator); },
    async drainManagedWriter() { await options.drain(); },
    dispose,
  };
}
