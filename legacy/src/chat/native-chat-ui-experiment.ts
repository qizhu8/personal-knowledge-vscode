import * as vscode from "vscode";
import * as fs from "fs";
import * as path from "path";
import { createHash, randomUUID } from "crypto";
import { registerNativeTodoUiExperiment } from "./native-todo-ui-experiment";
import { renderApiChat, renderApiChatFailure } from "./api-chat-shell";
import { decodeChatImage, type ChatImage } from "./api-chat-client";
import { chatHistoryPage, type ApiConversation } from "./api-chat-store";
import { createNativeHarnessServer } from "../runtime/native-harness-server";
import { nativeChatHarnessSnapshot } from "./native-chat-harness-ui";
import { recipeBrowserEditorDocument } from "../ui/recipe-browser";
import type { RecipeRecord } from "../workflows/project-model";
import { reviewSqlPythonRecipe } from "../ui/next-python-recipe";
import { getStorePath } from "../knowledge/filestore";

type Json = Record<string, any>;
export interface NativeChatUiBinding {
  nonce: string; root: string; workspaceId: string; actorId: string; sourceFingerprint: string;
  endpoint: string; bearer: string; fixture?: string; todoBoards?: string[];
}
interface Grant extends NativeChatUiBinding {
  schema: "pkm.private-native-chat-ui/v1"; kind: "synthetic-only"; nonce: string; fixture: string;
  root: string; rootDevice: string; rootInode: string; workspaceId: string; actorId: string; sourceFingerprint: string;
  endpoint: string; bearer: string;
}
function privateFile(file: string): Buffer {
  const before = fs.lstatSync(file);
  if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1 || before.size > 65_536
    || process.platform !== "win32" && ((before.mode & 0o077) !== 0 || before.uid !== process.getuid?.()))
    throw new Error("Native Chat UI requires an owned private single-link grant file.");
  const fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
  try {
    const opened = fs.fstatSync(fd), bytes = fs.readFileSync(fd), after = fs.fstatSync(fd);
    if (opened.dev !== before.dev || opened.ino !== before.ino || after.ctimeMs !== before.ctimeMs
      || after.mtimeMs !== before.mtimeMs || after.size !== before.size || bytes.length !== before.size)
      throw new Error("Native Chat UI grant changed while reading.");
    return bytes;
  } finally { fs.closeSync(fd); }
}
function readGrant(context: vscode.ExtensionContext, configuredRoot: string): Grant {
  if (process.platform !== "linux") throw new Error("This private native Chat UI journey is Linux-only; other platforms are not qualified.");
  const expected = path.join(context.globalStorageUri.fsPath, "next-chat-ui-experiment.json");
  if (process.env.PKM_PRIVATE_NATIVE_CHAT_UI_GRANT !== expected || fs.realpathSync(expected) !== expected)
    throw new Error("Native Chat UI grant must belong to this exact private profile.");
  const grant = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(privateFile(expected))) as Grant;
  if (grant.schema !== "pkm.private-native-chat-ui/v1" || grant.kind !== "synthetic-only"
    || !/^[a-f0-9-]{36}$/.test(grant.nonce) || !/^[a-f0-9]{64}$/.test(grant.sourceFingerprint)
    || !/^[A-Za-z0-9_-]{43}$/.test(grant.bearer) || !/^[a-f0-9-]{36}$/.test(grant.workspaceId) || !/^[a-f0-9-]{36}$/.test(grant.actorId)
    || path.resolve(configuredRoot) !== grant.root || fs.realpathSync(grant.root) !== grant.root
    || fs.realpathSync(grant.fixture) !== grant.fixture || path.dirname(grant.root) !== grant.fixture
    || fs.realpathSync(context.globalStorageUri.fsPath).startsWith(grant.root + path.sep))
    throw new Error("Native Chat UI is restricted to its exact synthetic fixture, original root and profile.");
  if (privateFile(path.join(grant.fixture, "native-ui-fixture-token")).toString() !== grant.nonce)
    throw new Error("Native Chat UI synthetic fixture approval is missing.");
  if (grant.todoBoards !== undefined && (!Array.isArray(grant.todoBoards) || grant.todoBoards.length > 1024
    || new Set(grant.todoBoards).size !== grant.todoBoards.length || grant.todoBoards.some(slug =>
      typeof slug !== "string" || !slug || slug.length > 1024 || /[\\:\u0000-\u001f]/.test(slug)
      || slug.split("/").some(part => !part || part.startsWith(".")))))
    throw new Error("Native Todo UI requires an exact safe original Board allowlist.");
  const stat = fs.lstatSync(grant.root, { bigint: true });
  if (!stat.isDirectory() || String(stat.dev) !== grant.rootDevice || String(stat.ino) !== grant.rootInode)
    throw new Error("Native Chat UI original root identity changed.");
  const endpoint = new URL(grant.endpoint);
  if (endpoint.protocol !== "http:" || endpoint.hostname !== "127.0.0.1" || !endpoint.port
    || endpoint.pathname !== "/" || endpoint.username || endpoint.password || endpoint.search || endpoint.hash)
    throw new Error("Native Chat UI requires an explicit private loopback host.");
  return grant;
}

/** Reuses the existing VS Code Chat renderer, but never initializes a legacy writer on an adopted root. */
export async function activateNativeChatUiExperimental(
  context: vscode.ExtensionContext, configuredRoot: () => string,
): Promise<boolean> {
  if (!process.env.PKM_PRIVATE_NATIVE_CHAT_UI_GRANT) {
    try { fs.lstatSync(path.join(context.globalStorageUri.fsPath, "next-chat-ui-experiment.json")); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
      throw error;
    }
    throw new Error("This private native Chat profile requires its explicit fixture grant; legacy initialization is blocked.");
  }
  const grant = readGrant(context, configuredRoot());
  const provider = new NativeChatUiProvider(context, grant, () => readGrant(context, configuredRoot()));
  context.subscriptions.push(provider,
    vscode.window.registerWebviewViewProvider("personalKnowledge.apiChat", provider, { webviewOptions: { retainContextWhenHidden: true } }),
    vscode.commands.registerCommand("personalKnowledge.openApiChat", () => vscode.commands.executeCommand("personalKnowledge.apiChat.focus")));
  context.subscriptions.push(vscode.commands.registerCommand("personalKnowledge.openNativeHarness",
    (sessionId: string) => provider.openHarness(sessionId)));
  if (grant.todoBoards?.length) {
    await provider.refreshTodoBoards();
    context.subscriptions.push(registerNativeTodoUiExperiment(context, {
    workspaceId: grant.workspaceId, boards: () => provider.todoBoards(),
    rpc: input => provider.todoRpc(input), openChat: url => provider.openTodoChat(url), root: grant.root,
    refreshBoards: () => provider.refreshTodoBoards(),
    createBoard: input => provider.todoRpc({ method: "todo-create", input }),
    lifecycle: input => provider.todoRpc({ method: "todo-lifecycle", input }),
    trash: () => provider.todoRpc({ method: "todo-trash" }),
  }));
  }
  return true;
}

export class NativeChatUiProvider implements vscode.WebviewViewProvider, vscode.Disposable {
  private libraryEnabled?: boolean;
  private memoryEnabled = false;
  private recipesEnabled = false;
  private processesEnabled = false;
  private processApprovalUi = false;
  private readonly stopPrompts = new Set<string>();
  private publicRecipeRequest?: Json;
  private lazyPublicRecipeRequest?: Json;
  private activeTodoBoards?: string[];
  private view?: vscode.WebviewView;
  private selected?: string;
  private selectedNamespace?: string;
  private revision = 0;
  private queueRevision = 0;
  private queueSession?: string | null;
  private pendingSend = false;
  private cancellingSend = false;
  private queueAttempt?: string;
  private queueEnabled = false;
  private queued = false;
  private fingerprint = "";
  private busy = false;
  private stopped = false;
  private refreshing = false;
  private publishVersion = 0;
  private navigation?: { requestId?: string; chatId: string };
  private readonly images = new Map<string, ChatImage[]>();
  private readonly harnesses = new Map<string, ReturnType<typeof createNativeHarnessServer>>();
  private readonly harnessPanels = new Map<string, vscode.WebviewPanel>();
  private readonly abort = new AbortController();
  private timer?: ReturnType<typeof setInterval>;
  constructor(private readonly context: vscode.ExtensionContext, private readonly grant: NativeChatUiBinding,
    private readonly currentGrant: () => NativeChatUiBinding, private readonly selectedOwner = false,
    private readonly resetPermissions?: () => Promise<void>) {}
  get isBusy(): boolean { return this.busy || this.pendingSend || this.cancellingSend; }
  todoBoards(): readonly string[] {
    if (JSON.stringify(this.currentGrant().todoBoards ?? []) !== JSON.stringify(this.grant.todoBoards ?? []))
      throw new Error("Original Todo allowlist changed; no request was sent.");
    return this.activeTodoBoards ?? [...(this.grant.todoBoards ?? [])];
  }
  async refreshTodoBoards(): Promise<readonly string[]> {
    this.todoBoards();
    const result = await this.rpc({ method: "todo-boards" });
    if (!Array.isArray(result) || !result.every(value => typeof value === "string" && value.length <= 1024))
      throw new Error("Native Board directory is invalid.");
    this.activeTodoBoards = result;
    return this.todoBoards();
  }
  async todoRpc(input: Json): Promise<any> {
    const lifecycle = input.method === "todo-lifecycle" && typeof input.input?.boardSlug === "string"
      && (input.input.kind === "restore" || this.todoBoards().includes(input.input.boardSlug));
    const linked = input.method === "todo-link" && this.todoBoards().includes(input.boardSlug);
    if (!["todo-create", "todo-trash"].includes(input.method) && !lifecycle && !linked
      && (input.method !== "todo" || !this.todoBoards().includes(input.input?.boardSlug)))
      return Promise.reject(new Error("Todo request is outside this exact synthetic profile grant."));
    if (!(this.grant.todoBoards?.length)) throw new Error("This private profile has no Todo user authority.");
    const result = await this.rpc(input);
    if (input.method === "todo-create" || input.method === "todo-lifecycle") await this.refreshTodoBoards();
    return result;
  }
  async openTodoChat(url: string): Promise<void> {
    if (this.navigation) throw new Error("Wait for the Chat selection to finish.");
    const previous = { id: this.selected, namespace: this.selectedNamespace };
    const chats = await this.rpc({ method: "list" }) as Json[];
    const chat = chats.find(item => url === `pkm://chats/${item.namespace}/${item.id}`);
    if (!chat) throw new Error("Associated Chat no longer belongs to the original admitted directory.");
    await vscode.commands.executeCommand("personalKnowledge.apiChat.focus");
    if (!this.view || this.navigation || this.selected !== previous.id || this.selectedNamespace !== previous.namespace)
      throw new Error("Chat selection changed or the Chat view is unavailable.");
    const navigation = { chatId: chat.id };
    this.navigation = navigation;
    try { await this.publish(undefined, true); }
    catch (error) {
      if (this.navigation === navigation) this.navigation = undefined;
      throw error;
    }
  }
  async openPkmChat(locator: string): Promise<void> {
    if (this.navigation) throw new Error("Wait for the Chat selection to finish.");
    const previous = { id: this.selected, namespace: this.selectedNamespace };
    const chats = await this.rpc({ method: "list" }) as Json[];
    const matches = chats.filter(item => !item.trashedAt && (locator === item.id
      || locator === `pkm://chats/${item.namespace}/${item.id}`));
    if (matches.length !== 1) throw new Error("Choose an existing Chat in the current owner.");
    if (this.navigation || this.selected !== previous.id || this.selectedNamespace !== previous.namespace)
      throw new Error("Chat selection changed; nothing was opened.");
    const navigation = { chatId: matches[0].id };
    this.navigation = navigation;
    try {
      await vscode.commands.executeCommand("personalKnowledge.apiChat.focus");
      if (this.navigation !== navigation && (this.selected !== matches[0].id || this.selectedNamespace !== matches[0].namespace))
        throw new Error("Chat selection changed; nothing was opened.");
      if (this.navigation === navigation && this.view) await this.publish(undefined, true);
    } catch (error) {
      if (this.navigation === navigation) this.navigation = undefined;
      throw error;
    }
  }
  private async rpc(input: Json): Promise<any> {
    const check = () => {
      const current = this.currentGrant();
      for (const key of ["nonce","root","workspaceId","actorId","sourceFingerprint","endpoint","bearer"] as const)
        if (current[key] !== this.grant[key]) throw new Error("Native Chat UI host identity changed; no request was sent.");
      return current;
    };
    const grant = check();
    const response = await fetch(`${grant.endpoint}/rpc`, { method: "POST", redirect: "error",
      signal: AbortSignal.any([this.abort.signal, AbortSignal.timeout(65_000)]),
      headers: { authorization: `Bearer ${grant.bearer}`, "x-pkm-native-actor": grant.actorId, "content-type": "application/json" }, body: JSON.stringify(input) });
    const result = await response.json() as Json;
    check();
    if (!response.ok || result.error) throw new Error(result.error || "Native Chat backend is unavailable.");
    return result.value;
  }
  resolveWebviewView(view: vscode.WebviewView): void {
    this.attachWebviewView(view, false);
  }
  attachWebviewView(view: vscode.WebviewView, retainHtml: boolean): void {
    this.view = view;
    if (!retainHtml) {
      try { renderApiChat(view, this.context); } catch (error) { renderApiChatFailure(view, error); }
    }
    const listener = view.webview.onDidReceiveMessage(message => {
      void this.handle(message).catch(error => this.failure(error, message));
    });
    view.onDidDispose(() => { listener.dispose(); if (this.view === view) this.view = undefined; });
    this.timer ??= setInterval(() => {
      if (!this.view?.visible || this.busy && !this.processApprovalUi || this.refreshing || this.stopped) return;
      this.refreshing = true;
      void this.publish().catch(error => this.failure(error)).finally(() => { this.refreshing = false; });
    }, 750);
    this.timer.unref();
    if (retainHtml) setTimeout(() => {
      if (this.view === view && !this.stopped)
        void this.handle({ type: "ready" }).catch(error => this.failure(error, { type: "ready" }));
    }, 0);
  }
  private async publish(navigationRequestId?: string, force = false): Promise<void> {
    if (this.stopped || !this.view) return;
    const version = ++this.publishVersion;
    const navigation = this.navigation;
    if (this.libraryEnabled === undefined) {
      const status = await this.rpc({ method: "status" });
      if (status.root !== this.grant.root || status.workspaceId !== this.grant.workspaceId
        || status.actorId !== this.grant.actorId || status.sourceFingerprint !== this.grant.sourceFingerprint)
        throw new Error("Native Chat Library host does not match this private profile.");
      this.libraryEnabled = status.library === true;
      this.memoryEnabled = status.memory === true;
      this.recipesEnabled = status.recipes === true;
      this.processesEnabled = status.processes === true;
      this.processApprovalUi = status.processApprovalUi === true;
    }
    const library = this.libraryEnabled ? await this.rpc({ method: "library" }) : { revision: 0, state: { groups: [] } };
    const all = await this.rpc({ method: "list" }) as Json[];
    const requested = navigation?.chatId ?? this.selected;
    const selected = all.find(chat => chat.id === requested && !chat.trashedAt)
      ?? (navigation ? undefined : all.find(chat => !chat.trashedAt) ?? all[0]);
    if (!selected) throw new Error("No API Chat was admitted by this native host.");
    navigationRequestId = navigation && navigation.chatId === selected.id ? navigation.requestId : undefined;
    const memory = this.memoryEnabled ? await this.rpc({ method: "memory-state", namespace: selected.namespace, chatId: selected.id }) : undefined;
    const recipes = this.recipesEnabled ? await this.rpc({ method: "recipe-state", namespace: selected.namespace, chatId: selected.id }) : undefined;
    const processApprovals: Json[] = this.processApprovalUi
      ? await this.rpc({ method: "process-approvals", namespace: selected.namespace, chatId: selected.id }) : [];
    const stamp = createHash("sha256").update(JSON.stringify({ all, library, memory, recipes, selected: selected.id, busy: this.busy,
      processApprovals,
      publicRecipeRequest: this.publicRecipeRequest, lazyPublicRecipeRequest: this.lazyPublicRecipeRequest,
      images: this.images.get(selected.id), navigationRequestId })).digest("hex");
    if (!force && stamp === this.fingerprint) return;
    const history = await this.rpc({ method: "history", namespace: selected.namespace, chatId: selected.id });
    if (version !== this.publishVersion || this.navigation !== navigation) return;
    this.selected = selected.id; this.selectedNamespace = selected.namespace;
    for (const approval of processApprovals.filter(item => item.kind === "stop"))
      void this.confirmProcessStop(selected.namespace, selected.id, approval);
    this.revision = history.revision;
    this.queueRevision = history.queueControl?.revision ?? 0;
    this.queueSession = history.taskControl?.activeSessionId;
    this.queueAttempt = history.nativeTurns?.find((turn: Json) => ["queued", "model", "tool", "approval"].includes(turn.status))?.id;
    this.queueEnabled = !!history.queueControl;
    this.queued = history.queueControl?.items.some((item: Json) => item.status === "queued") === true;
    const recoverable = history.pending.find((operation: Json) => operation.status === "result");
    if (recoverable && !this.busy) {
      const { namespace, chatId, operationId, expectedRevision, text, images } = recoverable.request;
      await this.rpc({ method: "continue", namespace, chatId, operationId, expectedRevision, text, images });
      this.fingerprint = ""; await this.publish(navigationRequestId, true); return;
    }
    const unknown = history.pending.some((operation: Json) => operation.status === "prepared")
      || history.nativeWorkers?.some((worker: Json) => (worker.uncertain || worker.status === "unknown") && !worker.userReview) === true;
    const managed = Array.isArray(history.nativeTurns);
    const active = history.pending.some((operation: Json) => operation.status === "running");
    const chat: ApiConversation = { ...history.metadata, version: 1, id: selected.id, workspaceNamespace: selected.namespace,
      title: selected.title, createdAt: selected.createdAt, updatedAt: selected.updatedAt, messages: history.messages,
      context: [], includeHistory: true, permissionMode: "read-only", images: this.images.get(selected.id) ?? [],
      queuedInputs: history.queueControl?.items.filter((item: Json) => item.status === "queued") ?? [],
      portalCommands: [], portalTransfers: [],
      ...(history.taskControl ? { workerState: undefined } : {}),
      ...(managed && history.messages.at(-1)?.progress ? { progress: history.messages.at(-1).progress } : {}),
    };
    const page = chatHistoryPage(chat);
    const profile = { id: "native-private-loopback", model: this.selectedOwner ? "selected-owner-provider" : "synthetic-local-provider",
      label: this.selectedOwner ? "Selected owner managed provider" : "Experimental private local provider",
      contextWindow: 8_000_000, maxOutputTokens: managed ? 4096 : 1024, status: "active", imageInput: !managed };
    const posted = await this.view.webview.postMessage({ type: "state", navigationRequestId,
      chat: { ...chat, messages: page.messages }, chats: all,
      library: { groups: library.state.groups, chats: all, deletionCleanups: [] },
      history: { start: page.start, total: page.total }, busy: this.busy || active, remoteBusy: active, toolGroups: [],
      processControlSupported: this.processesEnabled && process.platform === "linux",
      decisions: [], approvals: processApprovals.filter(item => item.kind === "permission").map(item => ({ ...item,
        scope: item.once ? "Only this batch" : "This tool" })), workerOverview: { rootChatId: chat.id, nodes: [
        ...(history.nativeWorkers?.length || history.archivedWorkers?.length ? [{ chatId: chat.id, title: chat.title,
          manager: true, status: active ? "running" : "completed" }] : []),
        ...(history.archivedWorkers ?? []).map((worker: Json) => ({ ...worker, manager: false,
          archived: true, temporary: true, canResume: false })),
        ...(history.nativeWorkers ?? []).map((worker: Json) => ({ chatId: worker.id, parentChatId: chat.id,
          receiptId: worker.id, title: worker.title, manager: false, archived: true, temporary: true,
          canResume: false, status: worker.uncertain ? "failed" : worker.status })),
      ] },
      nativeMemory: memory,
      nativeRecipes: recipes ? { ...recipes, publicRequest:
        this.publicRecipeRequest?.args?.chatId === this.selected ? this.publicRecipeRequest : undefined,
        lazyPublicRequest: this.lazyPublicRecipeRequest?.chatId === this.selected ? this.lazyPublicRecipeRequest?.request : undefined } : undefined,
      nativeWorkflow: { archivedQueue: history.archivedQueue ?? [], needsReview: history.queueControl?.needsReview,
        activeAttemptId: this.queueAttempt, taskSessionId: this.queueSession, queueRevision: this.queueRevision,
        taskSessions: this.selectedOwner ? history.metadata.memoryTasks ?? [] : [],
        unknown, reviewAvailable: history.userReviewAvailable === true,
        reviewedUnknown: !!history.sourceUserReview || history.nativeTurns?.some((turn: Json) => !!turn.userReview) === true },
      settings: { provider: "native-experimental", endpoint: "private-native-host", model: profile.model,
        profiles: [profile], selectedProfile: profile, contextWindow: profile.contextWindow, maxOutputTokens: profile.maxOutputTokens,
        needsModelConnection: unknown, activityCreditLimitDefault: -1, activityCreditLimit: -1, maxToolRounds: 1,
        nativeExperiment: true, nativeImageTransport: !managed, nativeTaskControls: !!history.taskControl, nativeManaged: managed,
        nativeQueueControls: !!history.queueControl, nativePermissionReset: !!this.resetPermissions },
    });
    if (posted && this.navigation === navigation) this.navigation = undefined;
    if (unknown) await this.view.webview.postMessage({ type: "error",
      message: "An earlier provider outcome is unknown. Original history is readable, but automatic resend is blocked pending reconciliation." });
    this.fingerprint = stamp;
    for (const server of this.harnesses.values()) void server.then(server => server.changed(), () => {});
    for (const panel of this.harnessPanels.values()) void panel.webview.postMessage({ type: "nativeHarnessChanged" });
  }
  async openHarness(sessionId?: string, workerId?: string): Promise<void> {
    if (!this.selected || !this.selectedNamespace || this.stopped) throw new Error("Choose an admitted Task first.");
    const trusted = () => vscode.workspace.isTrusted !== false;
    if (!trusted()) throw new Error("Trust this private workspace before inspecting Task evidence.");
    const identity = { namespace: this.selectedNamespace, chatId: this.selected };
    if (!sessionId) {
      const history = await this.rpc({ method: "history", ...identity });
      if (this.stopped || this.selected !== identity.chatId || this.selectedNamespace !== identity.namespace
        || !trusted()) throw new Error("The selected Chat changed; no Task inspection was opened.");
      sessionId = history.metadata.sessionId;
    }
    if (typeof sessionId !== "string" || !/^agent_session_[a-f0-9]{32}$/.test(sessionId))
      throw new Error("This Chat has no original managed Task.");
    const exactSession = sessionId, key = `${identity.namespace}:${identity.chatId}:${exactSession}:${workerId ?? ""}`;
    const read = async (fullResults = false) => nativeChatHarnessSnapshot(
      await this.rpc({ method: "harness", ...identity, sessionId: exactSession }), exactSession, fullResults, workerId);
    await read();
    if (this.stopped || this.selected !== identity.chatId || this.selectedNamespace !== identity.namespace
      || !trusted()) throw new Error("The selected Chat changed; no Task inspection was opened.");
    let pending = this.harnesses.get(key);
    let created = false;
    if (!pending) {
      created = true;
      pending = createNativeHarnessServer({ extensionPath: this.context.extensionPath, sessionId: exactSession,
        access: () => {
          if (this.stopped || vscode.workspace.isTrusted === false
            || this.currentGrant().nonce !== this.grant.nonce) throw new Error("This exact private Task inspection is closed.");
        },
        request: async (method, params) => {
          if (method === "snapshot") return read();
          if (method !== "result") throw new Error("This native Task host has not qualified Memory/Profile inspection.");
          const snapshot = await read(true);
          const call = snapshot.harness.attempts.find((attempt: Json) => attempt.messageId === params.messageId)
            ?.toolCalls.find((call: Json) => call.id === params.callId);
          if (!call) throw new Error("The exact recorded Task tool result is unavailable.");
          return call.resultPreview;
        },
      });
      this.harnesses.set(key, pending);
    }
    let server: Awaited<typeof pending>;
    try { server = await pending; } catch (error) { this.harnesses.delete(key); throw error; }
    if (this.stopped || this.selected !== identity.chatId || this.selectedNamespace !== identity.namespace || !trusted()) {
      if (created && this.harnesses.get(key) === pending) { this.harnesses.delete(key); await server.dispose(); }
      throw new Error("The selected Chat changed; no Task inspection was opened.");
    }
    const local = new URL(server.url);
    const existing = this.harnessPanels.get(key);
    if (existing) { existing.reveal(); return; }
    if (this.harnessPanels.size >= 8) throw new Error("Close a private Task inspection before opening another.");
    const resources = vscode.Uri.file(path.join(this.context.extensionPath, "dist/webview"));
    const panel = vscode.window.createWebviewPanel("personalKnowledge.nativeTaskHarness", "Task Harness",
      vscode.ViewColumn.Active, { enableScripts: true, retainContextWhenHidden: true, localResourceRoots: [resources] });
    this.harnessPanels.set(key, panel);
    const listener = panel.webview.onDidReceiveMessage(message => {
      if (message?.type !== "nativeHarnessRequest" || !/^[a-f0-9-]{36}$/.test(message.id)) return;
      void (async () => {
        if (this.stopped || vscode.workspace.isTrusted === false) throw new Error("Private Task inspection is closed.");
        if (message.method === "snapshot") return read();
        if (message.method === "result") {
          const snapshot = await read(true);
          const call = snapshot.harness.attempts.find((attempt: Json) => attempt.messageId === message.params?.messageId)
            ?.toolCalls.find((call: Json) => call.id === message.params?.callId);
          if (!call) throw new Error("The exact recorded Task tool result is unavailable.");
          return call.resultPreview;
        }
        if (message.method === "browser") {
          await read();
          const external = new URL((await vscode.env.asExternalUri(vscode.Uri.parse(`${local.origin}/`))).toString());
          server.allowOrigin(external.origin); external.hash = local.hash;
          if (!await vscode.env.openExternal(vscode.Uri.parse(external.toString()))) throw new Error("Cannot open this read-only Task in a browser.");
          return { opened: true };
        }
        throw new Error("Unsupported native read-only Task inspection.");
      })().then(value => panel.webview.postMessage({ type: "nativeHarnessResponse", id: message.id, value }),
        error => panel.webview.postMessage({ type: "nativeHarnessResponse", id: message.id,
          error: error instanceof Error ? error.message : "Native Task inspection refused." }));
    });
    panel.onDidDispose(() => { listener.dispose(); this.harnessPanels.delete(key); });
    const nonce = randomUUID().replace(/-/g, "");
    const uri = (name: string) => panel.webview.asWebviewUri(vscode.Uri.joinPath(resources, name)).toString().replace(/&/g, "&amp;").replace(/"/g, "&quot;");
    panel.webview.html = `<!doctype html><html><head><meta charset="utf-8">
      <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${panel.webview.cspSource} 'unsafe-inline'; font-src ${panel.webview.cspSource}; script-src 'nonce-${nonce}';">
      <link rel="stylesheet" href="${uri("agent-harness.css")}"><link rel="stylesheet" href="${uri("codicon.css")}">
      </head><body><main id="harness" aria-label="Read-only Task Harness"></main>
      <script nonce="${nonce}" src="${uri("agent-harness.js")}"></script>
      <script nonce="${nonce}" src="${uri("native-chat-harness-bridge.js")}"></script></body></html>`;
  }
  private failure(error: unknown, message: Json = {}): void {
    if (this.stopped) return;
    if (message.type === "select" && this.navigation?.requestId === message.requestId) this.navigation = undefined;
    void this.view?.webview.postMessage({ type: message.type === "ready" ? "initializationError" : "error",
      chatId: message.chatId, submissionId: message.submissionId, requestId: message.requestId,
      message: error instanceof Error ? error.message : "Native Chat UI refused." });
  }
  private async confirmProcessStop(namespace: string, chatId: string, approval: Json): Promise<void> {
    if (this.stopPrompts.has(approval.id)) return;
    this.stopPrompts.add(approval.id);
    try {
      const answer = await vscode.window.showWarningMessage(approval.title, { modal: true, detail: approval.detail }, "Stop process");
      if (this.stopped || this.selected !== chatId || this.selectedNamespace !== namespace || vscode.workspace.isTrusted === false) return;
      await this.rpc({ method: "process-approval-decide", namespace, chatId, id: approval.id,
        choice: answer === "Stop process" ? "approve" : "deny" });
      this.fingerprint = "";
    } catch (error) { this.failure(error); }
    finally { this.stopPrompts.delete(approval.id); }
  }
  private async changeLibrary(message: Json): Promise<void> {
    if (!this.libraryEnabled) throw new Error("This native host has no fresh Chat Library authority.");
    if (this.busy) throw new Error("Wait for the current native Chat operation before changing its Library.");
    this.busy = true;
    try {
      const library = await this.rpc({ method: "library" });
      let input: Json | undefined;
      if (message.type === "groupCreate" || message.type === "groupRename") {
        const group = library.state.groups.find((group: Json) => group.id === message.id);
        if (message.type === "groupRename" && !group) throw new Error("Choose an existing Chat group.");
        const name = await vscode.window.showInputBox({ title: message.type === "groupCreate" ? "New Chat group" : "Rename Chat group",
          ...(group ? { value: group.name } : {}), ignoreFocusOut: true });
        if (name !== undefined) input = message.type === "groupCreate" ? { kind: "create", name }
          : { kind: "rename", groupId: group.id, name };
      } else if (message.type === "groupDelete") {
        if (await vscode.window.showWarningMessage("Delete Chat group? Chats will move to Ungroup.", { modal: true }, "Delete group") === "Delete group")
          input = { kind: "delete-group", groupId: message.id };
      } else if (message.type === "moveChat") {
        let choice: { groupId?: string; newName?: string } | undefined;
        if (typeof message.value === "string") choice = { groupId: message.value };
        else {
          const picker = vscode.window.createQuickPick<vscode.QuickPickItem & { groupId?: string; newName?: string }>();
          picker.title = "Move Chat to group"; picker.placeholder = "Select a group or type a new group name"; picker.ignoreFocusOut = true;
          const update = () => {
            const name = picker.value.trim();
            const groups = [{ label: "Ungroup", groupId: "ungroup" },
              ...library.state.groups.map((group: Json) => ({ label: group.name, groupId: group.id }))];
            picker.items = name && !["ungroup", "trash"].includes(name.toLowerCase())
              && !groups.some(group => group.label.toLowerCase() === name.toLowerCase())
              ? [{ label: name, description: "Create new group", newName: name }, ...groups] : groups;
          };
          try {
            update();
            choice = await new Promise(resolve => {
              picker.onDidChangeValue(update);
              picker.onDidAccept(() => resolve(picker.selectedItems[0]));
              picker.onDidHide(() => resolve(undefined));
              picker.show();
            });
          } finally { picker.dispose(); }
        }
        if (choice) input = choice.newName ? { kind: "move-named", chatId: message.id, name: choice.newName }
          : { kind: "move", chatId: message.id, groupId: choice.groupId };
      } else if (message.type === "trashChat") {
        if (await vscode.window.showWarningMessage("Move Chat to Trash? Task Session evidence is preserved.", { modal: true }, "Move to Trash") === "Move to Trash")
          input = { kind: "trash", chatId: message.id };
      } else input = { kind: "restore", chatId: message.id };
      if (input) await this.rpc({ method: "library-mutate", input: {
        ...input, operationId: randomUUID(), expectedRevision: library.revision,
      } });
    } finally { this.busy = false; this.fingerprint = ""; }
    await this.publish(undefined, true);
  }
  private readonly recipePanels = new Set<vscode.WebviewPanel>();
  private async openRecipeLibrary(recipeId: string, copy: boolean): Promise<void> {
    if (!this.recipesEnabled || !this.selected || !this.selectedNamespace) throw new Error("Choose an admitted Recipe Chat first.");
    const identity = { namespace: this.selectedNamespace, chatId: this.selected };
    const initial = await this.rpc({ method: "recipe-editor", input: { ...identity, recipeId, copy } });
    let recipe = initial.recipe as RecipeRecord, expectedDigest = String(initial.digest), saving = false;
    const panel = vscode.window.createWebviewPanel("pkm.nativeRecipeLibrary",
      `Recipe Library · ${recipe.name}`, vscode.ViewColumn.One, { enableScripts: true, retainContextWhenHidden: true,
        localResourceRoots: [] });
    this.recipePanels.add(panel);
    panel.webview.html = recipeBrowserEditorDocument(recipe, [], { nativeTransport: true });
    const listener = panel.webview.onDidReceiveMessage(async (message: Json) => {
      if (message.type !== "nativeRecipeEditor" || typeof message.requestId !== "string"
        || !/^[a-f0-9-]{36}$/.test(message.requestId)) return;
      try {
        if (typeof message.options?.body !== "string" || message.options.body.length > 1048576)
          throw new Error("Invalid Recipe editor request.");
        const body = JSON.parse(message.options.body);
        let value: Json;
        if (message.path === "/api/validate" && message.options.method === "POST") {
          value = await this.rpc({ method: "recipe-validate", ...identity, definition: body.definition });
        } else if (message.path === "/api/recipe" && message.options.method === "PUT") {
          if (saving) throw new Error("Another save is unresolved. Reopen to reconcile; never retry automatically.");
          if (body.recipeId !== recipe.recipeId || body.revision !== recipe.revision)
            throw new Error("Editor Recipe identity/revision changed; reopen before saving.");
          saving = true;
          try {
            const fields = Object.fromEntries(["name", "category", "description", "definition", "metadata",
              "methodology", "editorLayout", "nodeBindings"].filter(key => body[key] !== undefined).map(key => [key, body[key]]));
            const operationId = randomUUID();
            const answer = await vscode.window.showWarningMessage("Save this exact native Recipe library definition?",
              { modal: true, detail: JSON.stringify({ root: this.grant.root, actorId: this.grant.actorId,
                recipeId: recipe.recipeId, knowledgeId: (recipe as unknown as Json).knowledgeId,
                expectedRevision: recipe.revision, operationId, fields }, null, 2)
                + "\nWrites the native library and atomic receipt only. Original ProjectStore remains unchanged."
                + "\nSaving instructions/Knowledge references grants no execution authority. Conflicts are never retried." },
              "Save exact Recipe definition");
            if (answer !== "Save exact Recipe definition") throw new Error("Recipe save cancelled; draft not persisted.");
            const result = await this.rpc({ method: "recipe-library-save", input: { ...identity, operationId,
              expectedDigest, recipeId: recipe.recipeId, expectedRevision: recipe.revision, fields } });
            recipe = result.recipe; expectedDigest = result.digest; value = { recipe };
            panel.title = `Recipe Library · ${recipe.name}`;
            await this.publish(undefined, true);
          } finally { saving = false; }
        } else throw new Error("Recipe editor endpoint is not allowed.");
        await panel.webview.postMessage({ type: "nativeRecipeEditorResult", requestId: message.requestId, value });
      } catch (error) {
        await panel.webview.postMessage({ type: "nativeRecipeEditorResult", requestId: message.requestId,
          error: `${error instanceof Error ? error.message : String(error)} No automatic retry; reopen to reconcile an unknown save.` });
      }
    });
    panel.onDidDispose(() => { listener.dispose(); this.recipePanels.delete(panel); });
  }
  private async handle(message: Json): Promise<void> {
    if (!message || typeof message !== "object" || this.stopped) return;
    if (this.navigation && !["select", "hostHealth", "ready", "libraryRefresh", "chatVisibility", "read", "chatListRender"].includes(message.type))
      throw new Error("Wait for the Chat selection to finish before sending another request.");
    if (message.type === "approval") {
      if (!this.processApprovalUi || !this.selected || !this.selectedNamespace || vscode.workspace.isTrusted === false
        || typeof message.id !== "string" || !["approve", "approve-once", "deny", "allow-all"].includes(message.value))
        throw new Error("Choose a pending approval in this exact trusted Chat.");
      await this.rpc({ method: "process-approval-decide", namespace: this.selectedNamespace,
        chatId: this.selected, id: message.id, choice: message.value });
      this.fingerprint = ""; await this.publish(undefined, true); return;
    }
    if (message.type === "processControl") {
      const trusted = () => vscode.workspace.isTrusted !== false;
      if (!this.processesEnabled || !trusted() || !this.selected || !this.selectedNamespace
        || message.chatId !== this.selected || typeof message.handle !== "string"
        || !/^process_[a-f0-9]{64}$/.test(message.handle)
        || !["status", "pause", "resume", "stop"].includes(message.operation))
        throw new Error("Choose a process in this exact trusted local Chat.");
      const identity = { namespace: this.selectedNamespace, chatId: this.selected };
      let record = await this.rpc({ method: "process-control", ...identity, handle: message.handle, operation: "status" });
      if (message.operation === "stop") {
        if (!["launching", "running", "paused"].includes(record.state)) throw new Error("This process is not running.");
        if (!this.processApprovalUi) {
          const answer = await vscode.window.showWarningMessage("Stop this background process group?",
            { modal: true, detail: `Process handle: ${record.handle}\nProgram: ${record.spec.program}\nDetached descendants may continue. This cannot undo effects already produced.` }, "Stop process");
          if (answer !== "Stop process") {
            await this.view?.webview.postMessage({ type: "processControlResult", chatId: identity.chatId, operation: "status", record });
            return;
          }
        }
      }
      if (this.selected !== identity.chatId || this.selectedNamespace !== identity.namespace || !trusted())
        throw new Error("Chat or workspace authority changed; no process control was sent.");
      if (message.operation !== "status") record = await this.rpc({ method: "process-control", ...identity,
        handle: message.handle, operation: message.operation });
      await this.view?.webview.postMessage({ type: "processControlResult", chatId: identity.chatId, operation: message.operation, record });
      return;
    }
    if (message.type === "hostHealth") {
      const status = await this.rpc({ method: "status" });
      if (status.root !== this.grant.root || status.workspaceId !== this.grant.workspaceId
        || status.actorId !== this.grant.actorId || status.sourceFingerprint !== this.grant.sourceFingerprint) throw new Error("Native Chat host no longer matches its grant.");
      await this.view?.webview.postMessage({ type: "hostHealth", id: message.id }); return;
    }
    if (message.type === "ready" || message.type === "libraryRefresh") { await this.publish(undefined, true); return; }
    if (["groupCreate", "groupRename", "groupDelete", "moveChat", "trashChat", "restoreChat"].includes(message.type)) {
      await this.changeLibrary(message); return;
    }
    if (message.type === "chatVisibility" || message.type === "read" || message.type === "chatListRender") return;
    if (message.type === "select") {
      this.navigation = { requestId: message.requestId, chatId: String(message.id) };
      await this.publish(message.requestId, true); return;
    }
    if (!this.selected || !this.selectedNamespace) throw new Error("Choose an admitted Chat first.");
    if (message.chatId !== undefined && message.chatId !== this.selected) throw new Error("The selected Chat changed; nothing was sent.");
    if (message.type === "nativeRecipeEdit" || message.type === "nativeRecipeNew") {
      await this.openRecipeLibrary(String(message.recipeId), message.type === "nativeRecipeNew"); return;
    }
    if (message.type === "reviewUnknown") { await this.reviewUnknown(); return; }
    if (message.type === "nativeRecipeLazyAuthorize") {
      if (!this.recipesEnabled) throw new Error("No explicitly installed trusted Recipe executor.");
      const identity = { namespace: this.selectedNamespace, chatId: this.selected };
      const snapshot = await this.rpc({ method: "recipe-state", ...identity });
      if (!snapshot.publicLazyEnabled) throw new Error("No controlled legacy lazy host is composed.");
      const text = await vscode.window.showInputBox({ title: "Exact mutating legacy Recipe request",
        prompt: "JSON {operation,args}; get is a mutation. No automatic/default dispatch or inherited executable permission.",
        value: '{"operation":"mcp.tool.recipe_run_get","args":{"run_id":""}}',
        validateInput: value => {
          try {
            const request = JSON.parse(value);
            return value.length <= 65536 && ["mcp.tool.recipe_run_start", "mcp.tool.recipe_run_get",
              "mcp.tool.recipe_run_next", "mcp.tool.recipe_run_progress", "mcp.tool.recipe_run_report",
              "mcp.tool.recipe_run_submit_input"].includes(request.operation)
              && request.args && typeof request.args === "object" && !Array.isArray(request.args)
              ? undefined : "Enter a bounded exact legacy lifecycle request.";
          } catch { return "Enter a JSON request."; }
        } });
      if (text === undefined) return;
      const preview = await this.rpc({ method: "recipe-public-lazy-preview", ...identity, input: JSON.parse(text) });
      const button = "Authorize exact lazy Recipe request";
      const answer = await vscode.window.showWarningMessage("Authorize this exact mutating legacy Recipe request?",
        { modal: true, detail: JSON.stringify({ root: this.grant.root, actorId: this.grant.actorId, ...preview }, null, 2)
          + "\nONE identical public request, three minutes; source/run/adapter state is rechecked."
          + "\nStart/get do NOT claim a new step. Next claims at most one. Get synchronizes state and is NOT read-only."
          + "\nCancellation uses progress.cancellationRequested and only signals a directly owned child."
          + "\nHuman input binds the exact run/node/challenge and response; an agent report cannot approve a human gate."
          + "\nRestart preserves waiting human gates; other in-flight effects remain UNKNOWN, never replayed."
          + "\nOnly the composed adapter/source permissions apply. No autonomous, subflow, dynamic-loop or arbitrary executable qualification." }, button);
      if (answer !== button) return;
      const request = await this.rpc({ method: "recipe-public-lazy-approve", ...identity,
        input: { operation: preview.operation, args: preview.args, previewDigest: preview.previewDigest } });
      this.lazyPublicRecipeRequest = { chatId: this.selected, request };
      await this.publish(undefined, true); return;
    }
    if (message.type === "nativeRecipeHistoryGet") {
      if (!this.recipesEnabled) throw new Error("No explicitly scoped Recipe history host is available.");
      const identity = { namespace: this.selectedNamespace, chatId: this.selected };
      const snapshot = await this.rpc({ method: "recipe-state", ...identity });
      const run = snapshot.originalRuns.find((item: Json) => item.runId === message.runId);
      if (!run || run.sha256 !== message.expectedSha256) throw new Error("Original Recipe history changed; refresh before reading.");
      const history = await this.rpc({ method: "recipe-history-get",
        input: { ...identity, runId: run.runId, expectedSha256: run.sha256 } });
      const document = await vscode.workspace.openTextDocument({ language: "json", content: JSON.stringify(history, null, 2) });
      await vscode.window.showTextDocument(document, { preview: true });
      return;
    }
    if (message.type === "nativeRecipeRefresh" || message.type === "nativeRecipeCreate" || message.type === "nativeRecipeCancel"
      || message.type === "nativeRecipePublicAuthorize") {
      if (!this.recipesEnabled) throw new Error("No explicitly installed trusted Recipe executor is available.");
      const identity = { namespace: this.selectedNamespace, chatId: this.selected };
      const snapshot = await this.rpc({ method: "recipe-state", ...identity });
      if (message.type === "nativeRecipeRefresh") { await this.publish(undefined, true); return; }
      if (message.expectedDigest !== snapshot.digest) throw new Error("Recipe source changed; refresh before deciding.");
      if (message.type === "nativeRecipeCreate" || message.type === "nativeRecipePublicAuthorize") {
        const publicRequest = message.type === "nativeRecipePublicAuthorize";
        if (publicRequest && !snapshot.publicApiEnabled) throw new Error("No composed public Recipe integration.");
        const recipe = snapshot.recipes.find((item: Json) => item.recipeId === message.recipeId && item.available);
        if (!recipe) throw new Error("This Recipe has no qualified trusted native adapter.");
        const text = await vscode.window.showInputBox({ title: "Inputs for a distinct new native Recipe run",
          prompt: "JSON object only. Old runs and arbitrary executables are never resumed or inherited.", value: "{}",
          validateInput: value => {
            try {
              const parsed = JSON.parse(value);
              return value.length <= 65_536 && parsed && typeof parsed === "object" && !Array.isArray(parsed)
                ? undefined : "Enter a bounded JSON object.";
            } catch { return "Enter a JSON object."; }
          } });
        if (text === undefined) return;
        const inputs = JSON.parse(text), operationId = randomUUID();
        const input = { ...identity, recipeId: recipe.recipeId, inputs, operationId, expectedDigest: snapshot.digest };
        if (recipe.definition?.spec?.nodes?.some((node: Json) => node.kind === "pkm.step.script/v1" && node.config?.runtime === "python")) {
          if (!vscode.workspace.isTrusted
            || vscode.workspace.getConfiguration("personalKnowledge").get<boolean>("experimental.localEnvironmentUpgrade", false) !== true)
            throw new Error("Explicitly enable and trust the private Python environment experiment before reviewing a SQL Recipe.");
          const binding = { root: this.grant.root, workspaceId: this.grant.workspaceId, actorId: this.grant.actorId,
            sourceFingerprint: this.grant.sourceFingerprint, ...identity };
          const preview = await this.rpc({ method: "recipe-python-preview", ...identity,
            input: { operation: "recipe.runtime.start", args: input } });
          if (!this.grant.fixture) throw new Error("Python Recipe review is not available in this selected Chat host.");
          const reviewed = await reviewSqlPythonRecipe({
            profileStorage: this.context.globalStorageUri.fsPath, binding, cwd: path.join(this.grant.fixture, "workspace"), preview,
            check: () => {
              const grant = this.currentGrant();
              for (const key of ["nonce", "root", "workspaceId", "actorId", "sourceFingerprint", "endpoint", "bearer"] as const)
                if (grant[key] !== this.grant[key]) throw new Error("Private SQL Python Recipe host changed during review.");
              if (this.selected !== identity.chatId || this.selectedNamespace !== identity.namespace)
                throw new Error("SQL Python Recipe Chat changed during review.");
            },
            approve: approval => this.rpc({ method: "recipe-python-approve", ...identity, input: approval }),
          });
          if (!reviewed) return;
        }
        const confirmation = publicRequest ? "Authorize this exact MCP/HTTP native Recipe request?"
          : "Run this exact Recipe with the installed trusted adapter?";
        const button = publicRequest ? "Authorize exact public Recipe request" : "Run exact native Recipe";
        const answer = await vscode.window.showWarningMessage(confirmation,
          { modal: true, detail: JSON.stringify({ root: this.grant.root, actorId: this.grant.actorId,
            runId: `recipe_native_${operationId.replace(/-/g, "")}`, recipe, inputs }, null, 2)
            + "\nFresh authority for this distinct run only. Source instructions are data, not executable permissions."
            + "\n15-minute maximum private host grant; restart interrupts instead of resuming."
            + "\nNo old command/script, approval or in-flight effect is inherited. Unknown effects are never automatically replayed."
            + (publicRequest ? "\nThis permits ONE identical public request for three minutes. A bearer token alone grants no execution authority." : "")
            + "\nComplete original control/adapter parity is NOT qualified." }, button);
        if (answer !== button) return;
        if (publicRequest) this.publicRecipeRequest = await this.rpc({
          method: "recipe-public-approve", input: { operation: "recipe.runtime.start", args: input } });
        else await this.rpc({ method: "recipe-create", input });
      } else {
        const run = snapshot.runs.find((item: Json) => item.runId === message.runId);
        if (!run || run.version !== message.expectedVersion) throw new Error("Recipe run changed; refresh before cancelling.");
        const answer = await vscode.window.showWarningMessage("Cancel this exact native Recipe run?",
          { modal: true, detail: JSON.stringify({ root: this.grant.root, actorId: this.grant.actorId, run }, null, 2)
            + "\nFences future results only. Running side effects remain UNKNOWN; cancellation does not prove rollback." },
          "Cancel exact Recipe run");
        if (answer !== "Cancel exact Recipe run") return;
        await this.rpc({ method: "recipe-cancel", input: { ...identity, runId: run.runId,
          expectedVersion: run.version, expectedDigest: snapshot.digest, operationId: randomUUID() } });
      }
      await this.publish(undefined, true); return;
    }
    if (message.type === "nativeMemoryAdopt" || message.type === "nativeMemoryDecision") {
      if (!this.memoryEnabled) throw new Error("No fresh native Memory authority is available.");
      const identity = { namespace: this.selectedNamespace, chatId: this.selected };
      const snapshot = await this.rpc({ method: "memory-state", ...identity });
      if (message.type === "nativeMemoryAdopt") {
        const answer = await vscode.window.showWarningMessage("Adopt this exact original Memory scope for this private Chat host?",
          { modal: true, detail: JSON.stringify(snapshot.adoption, null, 2)
            + "\nEnables scoped recall and sourced pending proposals. Every confirm/revise/revoke requires separate exact-record approval. Existing exact native Memory journals may be reconciled, but model/tool intents are never replayed."
            + "\nFresh 15-minute profile-local session only. NOT original-owner proof. No executable, Portal or legacy approval is inherited. Restart requires another approval." },
          "Adopt exact Memory scope");
        if (answer !== "Adopt exact Memory scope") return;
        await this.rpc({ method: "memory-action", input: { ...identity, kind: "adopt",
          operationId: randomUUID(), expectedDigest: snapshot.digest } });
      } else {
        const decision = snapshot.decisions.find((item: Json) => item.id === message.id);
        if (!decision) throw new Error("Memory decision changed; inspect the current request.");
        const answer = await vscode.window.showWarningMessage("Approve this exact Memory lifecycle change?",
          { modal: true, detail: JSON.stringify(decision.request, null, 2)
            + "\nOnly this exact record/version/change is authorized. Revision returns to pending; confirmation is separate. Revocation excludes future recall, not prior prompts/backups." },
          "Approve exact Memory change");
        await this.rpc({ method: "memory-action", input: { ...identity,
          kind: answer === "Approve exact Memory change" ? "approve" : "deny", decisionId: decision.id,
          operationId: randomUUID(), expectedDigest: decision.digest } });
      }
      await this.publish(undefined, true); return;
    }
    if (message.type === "resetPermissions") {
      if (!this.selectedOwner || !this.resetPermissions || message.chatId !== this.selected)
        throw new Error("Select the intended Chat before resetting approvals.");
      this.currentGrant();
      await this.resetPermissions();
      return;
    }
    if (["runQueued", "removeQueuedInput", "beginQueuedEdit", "saveQueuedEdit", "cancelQueuedEdit", "adoptOriginalQueued"].includes(message.type)) {
      await this.changeQueue(message); return;
    }
    if (["startTask", "completeTask", "pause", "cancel", "resume"].includes(message.type)) {
      await this.changeTask(message.type); return;
    }
    if (message.type === "openHarness") { await this.openHarness(); return; }
    if (message.type === "openTaskSession") {
      if (!this.selectedOwner || message.chatId !== this.selected || typeof message.sessionId !== "string"
        || !/^agent_session_[a-f0-9]{32}$/.test(message.sessionId))
        throw new Error("Choose a Task Session from this selected Chat.");
      await this.openHarness(message.sessionId); return;
    }
    if (message.type === "workerArchive") { await this.openHarness(undefined, String(message.id)); return; }
    if (message.type === "historyPage") {
      const selected = this.selected;
      const history = await this.rpc({ method: "history", namespace: this.selectedNamespace, chatId: selected });
      if (this.selected !== selected) return;
      const chat = { messages: history.messages } as ApiConversation;
      const page = chatHistoryPage(chat, message.id);
      await this.view?.webview.postMessage({ type: "historyPage", chatId: selected, beforeId: message.id,
        messages: page.messages, start: page.start }); return;
    }
    if (message.type === "image" || message.type === "pasteImages") {
      const fixture = this.grant.fixture;
      if (!fixture) throw new Error("Attachments are not available in this selected Chat host.");
      if (this.busy) throw new Error("Wait for the current native operation before changing attachments.");
      const selected = this.selected;
      let next: ChatImage[] = [];
      if (message.type === "pasteImages") next = message.images;
      else {
        const files = await vscode.window.showOpenDialog({ canSelectMany: true, filters: { Images: ["png","jpg","jpeg"] } });
        if (!files) return;
        if (files.length > 2) throw new Error("Attach at most two bounded images.");
        next = files.map(file => {
          const canonical = fs.realpathSync(file.fsPath), stat = fs.lstatSync(canonical);
          if (!canonical.startsWith(fixture + path.sep) || !stat.isFile() || stat.size > 512 * 1024)
            throw new Error("Private Chat attachments must be bounded files inside this synthetic fixture.");
          const fd = fs.openSync(canonical, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
          let bytes: Buffer;
          try {
            const opened = fs.fstatSync(fd);
            if (opened.dev !== stat.dev || opened.ino !== stat.ino || opened.nlink !== 1 || opened.size !== stat.size)
              throw new Error("Private Chat image identity changed before reading.");
            const buffer = Buffer.alloc(512 * 1024 + 1);
            const length = fs.readSync(fd, buffer, 0, buffer.length, 0), after = fs.fstatSync(fd);
            if (length !== stat.size || after.size !== stat.size || after.ctimeMs !== stat.ctimeMs || after.mtimeMs !== stat.mtimeMs)
              throw new Error("Private Chat image changed while reading.");
            bytes = buffer.subarray(0, length);
          } finally { fs.closeSync(fd); }
          return { label: path.basename(file.fsPath), mimeType: /\.png$/i.test(file.fsPath) ? "image/png" : "image/jpeg",
            dataBase64: bytes.toString("base64") };
        });
      }
      if (this.selected !== selected) throw new Error("The selected Chat changed while choosing images; nothing was attached.");
      if (!Array.isArray(next) || !next.length || next.length + (this.images.get(this.selected)?.length ?? 0) > 2)
        throw new Error("Attach at most two bounded images.");
      next.forEach(image => {
        if (typeof image?.dataBase64 !== "string" || image.dataBase64.length > 699_052)
          throw new Error("Private Chat images must not exceed 512 KiB.");
        decodeChatImage(image);
      });
      this.images.set(this.selected, [...this.images.get(this.selected) ?? [], ...next]);
      await this.publish(undefined, true); return;
    }
    if (message.type === "removeImage") {
      if (this.busy) throw new Error("Wait for the current native operation before changing attachments.");
      this.images.set(this.selected, (this.images.get(this.selected) ?? []).filter((_,index) => index !== Number(message.value)));
      await this.publish(undefined, true); return;
    }
    if (message.type === "saveImage") {
      const fixture = this.grant.fixture;
      if (!fixture && !this.selectedOwner) throw new Error("Image export is not available in this Chat host.");
      const selected = this.selected, namespace = this.selectedNamespace, index = Number(message.value);
      if (!selected || !namespace || !Number.isSafeInteger(index) || index < 0) return;
      const history = await this.rpc({ method: "history", namespace, chatId: selected });
      if (this.stopped || this.selected !== selected || this.selectedNamespace !== namespace)
        throw new Error("The selected Chat changed; no image was saved.");
      const image = history.messages.find((item: Json) => item.id === message.id)?.images?.[index];
      if (!image) return;
      const bytes = decodeChatImage(image);
      const destination = await vscode.window.showSaveDialog(fixture
        ? { defaultUri: vscode.Uri.file(path.join(fixture, path.basename(image.label))) }
        : { saveLabel: "Save image", filters: { Image: image.mimeType === "image/png" ? ["png"] : ["jpg", "jpeg"] } });
      if (destination) {
        if (this.stopped || this.selected !== selected || this.selectedNamespace !== namespace)
          throw new Error("The selected Chat changed; no image was saved.");
        if (!fixture) {
          const current = await this.rpc({ method: "history", namespace, chatId: selected });
          const latest = current.messages.find((item: Json) => item.id === message.id)?.images?.[index];
          if (this.stopped || this.selected !== selected || this.selectedNamespace !== namespace
            || !latest || latest.label !== image.label || latest.mimeType !== image.mimeType
            || !decodeChatImage(latest).equals(bytes))
            throw new Error("The selected Chat image changed; no image was saved.");
          this.currentGrant();
          const roots = [fs.realpathSync(getStorePath()), fs.realpathSync(this.grant.root)];
          const protectedPath = (file: string) => roots.some(root => file === root || file.startsWith(root + path.sep));
          const confirmReplace = async (label: string) => {
            const choice = await vscode.window.showWarningMessage("Replace the selected image file?",
              { modal: true, detail: label }, "Replace");
            if (choice !== "Replace") return false;
            if (this.stopped || this.selected !== selected || this.selectedNamespace !== namespace)
              throw new Error("The selected Chat changed; no image was saved.");
            const confirmed = await this.rpc({ method: "history", namespace, chatId: selected });
            const confirmedImage = confirmed.messages.find((item: Json) => item.id === message.id)?.images?.[index];
            if (this.stopped || this.selected !== selected || this.selectedNamespace !== namespace
              || !confirmedImage || confirmedImage.label !== image.label || confirmedImage.mimeType !== image.mimeType
              || !decodeChatImage(confirmedImage).equals(bytes))
              throw new Error("The selected Chat image changed; no image was saved.");
            this.currentGrant();
            return true;
          };
          if (destination.scheme !== "file") {
            if (path.isAbsolute(destination.fsPath) && protectedPath(path.resolve(destination.fsPath)))
              throw new Error("Choose a file outside the original and private Chat roots.");
            let exists = false;
            try { await vscode.workspace.fs.stat(destination); exists = true; }
            catch (error) {
              if ((error as { code?: string }).code !== "FileNotFound") throw error;
            }
            if (exists && !await confirmReplace(destination.toString())) return;
            if (this.stopped || this.selected !== selected || this.selectedNamespace !== namespace)
              throw new Error("The selected Chat changed; no image was saved.");
            this.currentGrant();
            await vscode.workspace.fs.writeFile(destination, bytes);
            return;
          }
          if (!path.isAbsolute(destination.fsPath)) throw new Error("Choose an absolute image destination.");
          const directory = fs.realpathSync(path.dirname(destination.fsPath));
          const chosen = path.join(directory, path.basename(destination.fsPath));
          const chosenStat = fs.lstatSync(chosen, { throwIfNoEntry: false });
          const file = chosenStat?.isSymbolicLink() ? fs.realpathSync(chosen) : chosen;
          if (protectedPath(file))
            throw new Error("Choose a file outside the original and private Chat roots.");
          const previous = fs.lstatSync(file, { throwIfNoEntry: false });
          if (previous && (!previous.isFile() || previous.isSymbolicLink() || previous.nlink !== 1))
            throw new Error("The selected image destination must be a regular, single-link file.");
          if (previous && !await confirmReplace(file)) return;
          const flags = fs.constants.O_WRONLY | fs.constants.O_NOFOLLOW
            | (previous ? 0 : fs.constants.O_CREAT | fs.constants.O_EXCL);
          const handle = await fs.promises.open(file, flags, 0o600);
          try {
            const opened = await handle.stat();
            if (!opened.isFile() || opened.nlink !== 1 || previous
              && (opened.dev !== previous.dev || opened.ino !== previous.ino || opened.size !== previous.size
                || opened.mtimeMs !== previous.mtimeMs || opened.ctimeMs !== previous.ctimeMs))
              throw new Error("The image destination changed; no image was saved.");
            if (this.stopped || this.selected !== selected || this.selectedNamespace !== namespace)
              throw new Error("The selected Chat changed; no image was saved.");
            this.currentGrant();
            await handle.writeFile(bytes);
            await handle.truncate(bytes.length);
          } finally { await handle.close(); }
          return;
        }
        const file = path.join(fs.realpathSync(path.dirname(destination.fsPath)), path.basename(destination.fsPath));
        if (!file.startsWith(fixture + path.sep) || file === this.grant.root || file.startsWith(this.grant.root + path.sep))
          throw new Error("Private image export must stay inside the fixture and outside the adopted source root.");
        await fs.promises.writeFile(file, bytes, { flag: "wx", mode: 0o600 });
      }
      return;
    }
    if (message.type === "send") {
      if (this.busy) throw new Error("Wait for this native operation; legacy queue/steer execution is not admitted.");
      if (!/^[a-f0-9-]{36}$/.test(message.submissionId) || typeof message.text !== "string" || !message.text.trim())
        throw new Error("A real bounded submission identity and text are required.");
      const selected = this.selected;
      if (this.queueEnabled && (this.queueAttempt || this.queued || message.mode === "steer")
        && (message.nativeTaskSessionId !== this.queueSession || message.nativeQueueRevision !== this.queueRevision
          || message.mode === "steer" && (!message.nativeAttemptId || message.nativeAttemptId !== this.queueAttempt)))
        throw new Error("The displayed native Task, queue or steering attempt changed. Review the current state and submit explicitly; nothing was retargeted.");
      const queue = this.queueEnabled && (this.queueAttempt || this.queued || message.mode === "steer")
        ? { method: "queue", input: { namespace: this.selectedNamespace, chatId: selected, kind: "enqueue",
          operationId: message.submissionId, submissionId: message.submissionId, expectedRevision: this.queueRevision,
          text: message.text, mode: message.mode ?? "task", taskSessionId: this.queueSession,
          ...(message.mode === "steer" ? { attemptId: this.queueAttempt } : {}) } } : undefined;
      if (queue && this.images.get(selected)?.length) throw new Error("Running-time queued input is text-only; retain images for an idle request.");
      this.busy = true;
      this.pendingSend = true;
      let failure: unknown;
      try {
        const input = { method: "continue", namespace: this.selectedNamespace, chatId: selected,
          operationId: message.submissionId, expectedRevision: this.revision, text: message.text,
          images: this.images.get(selected) ?? [] };
        await this.publish(undefined, true);
        await this.rpc(queue ?? input);
        this.images.delete(selected);
        await this.view?.webview.postMessage({ type: "sendAccepted", chatId: selected, submissionId: message.submissionId });
      } catch (error) { failure = error; }
      finally {
        this.pendingSend = false;
        this.busy = false;
        try { await this.publish(undefined, true); } catch (error) { failure ??= error; }
      }
      if (failure) throw failure;
      return;
    }
    throw new Error(`Native Chat experiment has not admitted this legacy workflow: ${String(message.type).slice(0,80)}.`);
  }
  private async changeTask(type: string): Promise<void> {
    const concurrentCancel = this.busy && this.pendingSend && type === "cancel";
    if (this.busy && !concurrentCancel || concurrentCancel && this.cancellingSend)
      throw new Error("Wait for the current native UI operation before controlling this Task.");
    const identity = { namespace: this.selectedNamespace!, chatId: this.selected! };
    if (concurrentCancel) this.cancellingSend = true;
    else this.busy = true;
    try {
      const history = await this.rpc({ method: "history", ...identity });
      if (!history.taskControl) throw new Error("This host has no fresh native Task control authority.");
      const kind = type === "startTask" ? "create" : type === "completeTask" ? "complete" : type;
      let title: string | undefined;
      if (kind === "create") {
        if (this.images.get(identity.chatId)?.length) throw new Error("Remove pending images before creating a text-only native Task.");
        title = await vscode.window.showInputBox({ title: "Start Task", prompt: "Task title", ignoreFocusOut: true,
          validateInput: value => !value.trim() || value.trim().length > 120 || /[\u0000-\u001f\u007f]/.test(value)
            ? "Enter a Task title of 1–120 characters without control characters." : undefined });
        if (title === undefined) return;
      } else if (kind === "complete" && await vscode.window.showWarningMessage(
        "Complete current Task? Conversation and tool receipts are preserved.", { modal: true }, "Complete Task") !== "Complete Task") return;
      if (this.selected !== identity.chatId || this.selectedNamespace !== identity.namespace)
        throw new Error("The selected Chat changed while controlling its Task; nothing was submitted.");
      await this.rpc({ method: "task-control", input: { ...identity, kind, ...(title !== undefined ? { title } : {}),
        operationId: randomUUID(), expectedRevision: history.taskControl.revision } });
    } finally {
      if (concurrentCancel) this.cancellingSend = false;
      else this.busy = false;
      this.fingerprint = ""; await this.publish(undefined, true);
    }
  }
  private async changeQueue(message: Json): Promise<void> {
    if (this.busy || !this.queueEnabled) throw new Error("Fresh native user queue authority is unavailable or busy.");
    const identity = { namespace: this.selectedNamespace!, chatId: this.selected! }, expectedRevision = this.queueRevision;
    this.busy = true;
    try {
      let action: Json;
      if (message.type === "adoptOriginalQueued") {
        const history = await this.rpc({ method: "history", ...identity });
        const item = history.archivedQueue?.find((item: Json) => item.id === message.id && !item.imported);
        if (!item) throw new Error("Choose an unimported original queued input.");
        if (await vscode.window.showWarningMessage("Queue this archived text as a fresh user input?", { modal: true,
          detail: `${item.text}\n\nOld execution context, approvals, Portal and executable grants will NOT be reused. This is a new intent under the current Task and fresh host permissions.` },
          "Queue fresh input") !== "Queue fresh input") return;
        action = { kind: "adopt", sourceId: item.id, submissionId: randomUUID(), taskSessionId: this.queueSession };
      } else if (message.type === "runQueued") action = { kind: "run" };
      else if (message.type === "removeQueuedInput") action = { kind: "remove", id: message.id };
      else action = { kind: "edit", id: message.id, token: message.editToken,
        action: message.type === "beginQueuedEdit" ? "begin" : message.type === "saveQueuedEdit" ? "save" : "cancel",
        ...(message.type === "saveQueuedEdit" ? { text: message.text } : {}) };
      if (identity.chatId !== this.selected || identity.namespace !== this.selectedNamespace)
        throw new Error("The selected Chat changed; no queued action was submitted.");
      await this.rpc({ method: "queue", input: { ...identity, ...action, operationId: randomUUID(), expectedRevision } });
    } catch (error) {
      if (["beginQueuedEdit", "saveQueuedEdit", "cancelQueuedEdit"].includes(message.type))
        await this.view?.webview.postMessage({ type: "queuedEditRejected", chatId: identity.chatId, id: message.id, operation: message.type });
      throw error;
    } finally { this.busy = false; this.fingerprint = ""; await this.publish(undefined, true); }
  }
  private async reviewUnknown(): Promise<void> {
    if (this.busy) throw new Error("Finish the current UI operation before reviewing outcomes.");
    const identity = { namespace: this.selectedNamespace!, chatId: this.selected! };
    this.busy = true;
    try {
      const snapshot = await this.rpc({ method: "outcome-review", ...identity });
      if (!snapshot.available || snapshot.active) throw new Error("Stop active native execution first; separate user-required review authority is mandatory.");
      const effects = snapshot.turns.map((turn: Json) => `${turn.id}: ${turn.status}; ${turn.pendingTool?.call?.name ?? "model outcome"}`
        + (turn.pendingTool ? `\n${JSON.stringify(turn.pendingTool.call.arguments).slice(0, 1500)}` : "")).join("\n");
      const detail = `${effects}\n${snapshot.sourceUncertain ? `Original archived execution:\n${JSON.stringify(snapshot.sourceEffects).slice(0, 6000)}` : ""}`
        + "\nThe outcome stays UNKNOWN. This does not verify success, undo an effect, stop an old external process, approve an executable, or replay an intent. Queued work will require an explicit Run after review.";
      if (await vscode.window.showWarningMessage("Abandon these uncertain intents without replay?", { modal: true, detail },
        "Keep unknown; never replay") !== "Keep unknown; never replay") return;
      const reason = await vscode.window.showInputBox({ title: "Unknown outcome review", ignoreFocusOut: true,
        prompt: "Record why you are abandoning the intent, not claiming successful execution.",
        validateInput: value => value.trim().length < 1 || value.trim().length > 1000 ? "Enter a review reason of 1–1,000 characters." : undefined });
      if (reason === undefined) return;
      if (identity.chatId !== this.selected || identity.namespace !== this.selectedNamespace) throw new Error("The reviewed Chat changed; nothing was decided.");
      await this.rpc({ method: "outcome-decide", input: { ...identity, operationId: randomUUID(),
        expectedDigest: snapshot.digest, decision: "abandon-without-replay", reason } });
      await this.view?.webview.postMessage({ type: "nativeOutcomeReviewed", chatId: identity.chatId });
    } finally { this.busy = false; this.fingerprint = ""; await this.publish(undefined, true); }
  }
  dispose(): void {
    this.stopped = true; clearInterval(this.timer); this.abort.abort();
    for (const server of this.harnesses.values()) void server.then(server => server.dispose(), () => {});
    this.harnesses.clear();
    for (const panel of this.harnessPanels.values()) panel.dispose();
    this.harnessPanels.clear();
    for (const panel of this.recipePanels) panel.dispose();
    this.recipePanels.clear();
  }
}
