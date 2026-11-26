import { createHash, randomUUID } from "node:crypto";
import { hostname } from "node:os";
import { join } from "node:path";
import { lstatSync, realpathSync } from "node:fs";
import { chatPkmUrl } from "../knowledge/knowledge-locator";
import { ApiChatStore, type ApiConversation, type ApiChatProgress, type ChatMessage } from "./api-chat-store";
import { assertModelAvailable, validateBudget, type ChatModelProfile } from "./api-chat-models";
import { dispatchNativeChatModel } from "./native-chat-model-dispatch";
import { bindBrowserChatTurns } from "./browser-chat-turns";
import { nativeChatIdentityPrompt, nativeTaskInputPrompt, toolFreeChatInstruction } from "./native-chat-prompt";
import type { BrowserChatGrant } from "./browser-chat-transcript";
import type { ChatExecutionContext } from "./execution-context";
import type { ApiChatMessage } from "./api-chat-client";
import { currentHarnessTask } from "./chat-harness-records";

type Provider = Readonly<{
  provider: "openai-compatible" | "azure-openai";
  endpoint: string;
  apiVersion: string;
  profile: ChatModelProfile;
  contextWindow: number;
  maxOutputTokens: number;
  timeoutMs: number;
}>;
type NativeConversationSettings = Readonly<{ activityCreditLimit: -1; toolPolicy: "none" }>;
export const detachedActivityCreditError = "Detached access requires an Unlimited activity credit limit. To opt in, choose Unlimited in the Chat library's Credit limit menu for this Chat.";
const sha = (value: string) => createHash("sha256").update(value).digest("hex");
const uuid = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/;
const unavailable = () => Error("The pre-authorized Original Chat turn is unavailable.");
const validText = (text: string) => typeof text === "string" && !!text.trim() && text.length <= 2000;

/** Private owner record from a native confirmation. Neither a browser credential nor model credentials. */
interface DetachedOriginalApprovalBase {
  approvalId: string;
  grant: BrowserChatGrant;
  namespace: string;
  chatId: string;
  sessionId: string;
  rootDevice: number;
  rootInode: number;
  execution: ChatExecutionContext;
  model: Provider;
  revision: string;
  chatRevision: number;
  shareReply: true;
  expiresAt: number;
}
export interface DetachedOriginalTextApproval extends DetachedOriginalApprovalBase {
  approvedTextHash: string;
}
export interface DetachedOriginalConversationApproval extends DetachedOriginalApprovalBase {
  scope: "conversation";
  nativeSettings?: NativeConversationSettings;
  issuedAt: number;
  maxTurns: number;
  initialMessageCount: number;
}
export type DetachedOriginalApproval = DetachedOriginalTextApproval | DetachedOriginalConversationApproval;
export const detachedConversationLimits = Object.freeze({ lifetimeMs: 24 * 60 * 60_000, maxTurns: 8 });

function freezeTree<T>(value: T): T {
  if (value && typeof value === "object") {
    for (const child of Object.values(value)) freezeTree(child);
    Object.freeze(value);
  }
  return value;
}

function prepare(chat: ApiConversation, namespace: string, model: Provider, text: string,
  continuationAt = chat.messages.length, nativeSettings?: NativeConversationSettings): ApiChatMessage[] {
  const toolFree = chat.toolSelection ? ["builtin", "vscode"].every(source => chat.toolSelection!.disabledSources.includes(source))
    : chat.builtinTools?.length === 0 && chat.vscodeTools?.length === 0;
  if (!chat.sessionId) throw Error("Start a Task in this Original Chat before authorizing a detached conversation.");
  if (chat.workspaceNamespace !== namespace || chat.permissionMode !== "read-only" ||
      chat.includeHistory !== false || chat.workflowMode && chat.workflowMode !== "chat")
    throw Error("Open a read-only Chat in its original workspace and turn off history recall before authorizing detached access.");
  if ((chat.activityCreditLimit ?? nativeSettings?.activityCreditLimit) !== -1) throw Error(detachedActivityCreditError);
  if (chat.activityBudgetBypass) throw Error("Re-enable the Chat's activity limits before configuring detached access.");
  if (!nativeSettings && !toolFree) throw Error("Exact-message approval requires native tools to be disabled.");
  if (chat.mcpServers?.some(server => server.enabled))
    throw Error("Disable the Chat's configured MCP servers before authorizing detached access.");
  if (chat.context.length || Object.values(chat.agentContext || {}).some(items => items.length) ||
      chat.images?.length || chat.queuedInputs?.length || chat.workerState || chat.workerActivity ||
      chat.agentProfileId || chat.workGoal || chat.debugRequest || currentHarnessTask(chat) || chat.taskContextCheckpoints?.length ||
      chat.plans?.length)
    throw Error("Choose an idle Chat without attachments, extra context, Profiles, work goals, or plans for detached access.");
  if ((chat.modelProvider ?? (nativeSettings && model.provider)) !== model.provider ||
      (chat.modelProfileId ?? (nativeSettings && model.profile.id)) !== model.profile.id ||
      chat.contextWindow !== undefined && chat.contextWindow !== model.contextWindow ||
      chat.maxOutputTokens !== undefined && chat.maxOutputTokens !== model.maxOutputTokens)
    throw Error("The saved Chat model settings do not match the native selection. Reopen the Chat before configuring detached access.");
  const inputs = chat.messages.filter(message => message.taskId === chat.sessionId);
  if (inputs.some(message => message.images?.length || message.workerEventIds?.length || message.portalSource ||
      message.portalReview || message.role === "user" && message.status !== "complete"))
    throw Error("Choose an existing Task without attached, delegated, or unfinished inputs for detached access.");
  const messages: ApiChatMessage[] = [{ role: "system", content: toolFreeChatInstruction + nativeChatIdentityPrompt(chat, namespace) },
    ...chat.messages.slice(0, continuationAt).filter(message => message.taskId === chat.sessionId && message.role === "user").map(message => ({
      role: "user" as const, content: nativeTaskInputPrompt(message.id, message.content),
    })), ...chat.messages.slice(continuationAt).filter(message => message.role === "user" || message.status === "complete")
      .map(({ role, content }) => ({ role, content })), { role: "user", content: text }];
  assertModelAvailable(model.profile);
  validateBudget(model.profile, model.contextWindow, model.maxOutputTokens, messages);
  return messages;
}

type ApprovalOptions = {
  grant: BrowserChatGrant; namespace: string; chatId: string;
  execution: ChatExecutionContext; model: Provider; assertNativeOwner(): void;
};
type ApprovalDetail = { title: string; chatId: string; provider: string; model: string; endpoint: string };
export async function approveDetachedOriginalTextTurn(options: ApprovalOptions & {
  text: string;
  confirm(detail: { title: string; chatId: string; provider: string; model: string; endpoint: string; text: string }): Promise<boolean>;
}): Promise<DetachedOriginalTextApproval | undefined> {
  if (!validText(options.text)) throw unavailable();
  const pinned = await approveOriginal(options, options.text, detail => options.confirm({ ...detail, text: options.text }));
  if (!pinned) return;
  return freezeTree({ ...pinned.base, expiresAt: pinned.issuedAt + 15 * 60_000, approvedTextHash: sha(options.text) });
}

export async function approveDetachedOriginalConversation(options: ApprovalOptions & {
  nativeSettings?: NativeConversationSettings;
  confirm(detail: ApprovalDetail): Promise<boolean>;
}): Promise<DetachedOriginalConversationApproval | undefined> {
  const nativeSettings = captureNativeConversationSettings(options.nativeSettings);
  const pinned = await approveOriginal(options, " ", options.confirm, nativeSettings);
  if (!pinned) return;
  return freezeTree({ ...pinned.base, scope: "conversation", issuedAt: pinned.issuedAt,
    maxTurns: detachedConversationLimits.maxTurns, initialMessageCount: pinned.messageCount,
    ...(nativeSettings ? { nativeSettings } : {}) });
}

function captureNativeConversationSettings(settings?: NativeConversationSettings): NativeConversationSettings | undefined {
  if (settings === undefined) return;
  if (settings?.activityCreditLimit !== -1 || settings.toolPolicy !== "none") throw unavailable();
  return { activityCreditLimit: -1, toolPolicy: "none" };
}

export function assertApprovedConversationCurrent(approval: DetachedOriginalConversationApproval): void {
  const { grant, namespace, chatId, execution } = approval;
  const root = lstatSync(grant.workspaceRoot);
  if (!root.isDirectory() || root.dev !== approval.rootDevice || root.ino !== approval.rootInode ||
      realpathSync(grant.workspaceRoot) !== grant.workspaceRoot || approval.expiresAt <= Date.now()) throw unavailable();
  const store = new ApiChatStore(join(grant.workspaceRoot, ".pkm", "state"), namespace);
  const chat = store.resolveChat(chatPkmUrl(namespace, chatId));
  store.assertRunnable(chat, undefined, execution);
  if (store.browserTurnRevision(chat, execution.digest) !== approval.revision) throw unavailable();
}

async function approveOriginal(options: ApprovalOptions, text: string, confirm: (detail: ApprovalDetail) => Promise<boolean>,
  nativeSettings?: NativeConversationSettings) {
  const { namespace, chatId } = options, grant = { ...options.grant };
  const execution = structuredClone(options.execution), model = structuredClone(options.model);
  if (!uuid.test(chatId) || !grant.chatHostId || !uuid.test(grant.chatHostId) ||
      !["openai-compatible", "azure-openai"].includes(model.provider) || model.profile.status !== "active" ||
      !execution.trusted || execution.permissionMode !== "read-only" || execution.knowledgeRoot !== grant.workspaceRoot ||
      sha(execution.workspaceUris.join("|")).slice(0, 16) !== namespace ||
      !execution.workspacePaths.every((path, index) => execution.workspaceUris[index].startsWith("file:") && realpathSync(path) === path))
    throw Error("Detached access needs a trusted, read-only Original Chat with an active HTTP model in its original workspace.");
  let endpoint: URL;
  try { endpoint = new URL(model.endpoint); }
  catch { throw Error("Configure the selected model's HTTPS endpoint in PKM settings before enabling detached access."); }
  if (endpoint.username || endpoint.password || endpoint.search || endpoint.hash ||
      endpoint.protocol !== "https:" && !(endpoint.protocol === "http:" && ["127.0.0.1", "[::1]", "localhost"].includes(endpoint.hostname)))
    throw Error("Use an HTTPS model endpoint without credentials, query, or fragment (HTTP is allowed only on loopback).");
  options.assertNativeOwner();
  const store = new ApiChatStore(join(grant.workspaceRoot, ".pkm", "state"), namespace);
  const root = lstatSync(grant.workspaceRoot);
  const chat = store.resolveChat(chatPkmUrl(namespace, chatId));
  store.assertRunnable(chat, undefined, execution);
  prepare(chat, namespace, model, text, undefined, nativeSettings);
  const revision = store.browserTurnRevision(chat, execution.digest);
  if (!await confirm({ title: chat.title, chatId, provider: model.provider, model: model.profile.model, endpoint: model.endpoint })) return;
  options.assertNativeOwner();
  const currentRoot = lstatSync(grant.workspaceRoot);
  if (currentRoot.dev !== root.dev || currentRoot.ino !== root.ino || !currentRoot.isDirectory() ||
      store.browserTurnRevision(chat, execution.digest) !== revision) throw unavailable();
  const issuedAt = Date.now();
  const base: DetachedOriginalApprovalBase = { approvalId: randomUUID(), grant, namespace, chatId,
    sessionId: chat.sessionId!, execution, model, revision, chatRevision: chat.revision!, shareReply: true,
    expiresAt: issuedAt + detachedConversationLimits.lifetimeMs, rootDevice: root.dev, rootInode: root.ino };
  return { base, issuedAt, messageCount: chat.messages.length };
}

/** Only the trusted service can supply this immutable approval and resolve its pinned credential. */
export function bindDetachedOriginalTextTurn(privateApproval: DetachedOriginalApproval, owner: {
  assertCurrent(grant: BrowserChatGrant): void;
  readProviderKey(model: Provider, signal: AbortSignal): Promise<string>;
  withWriter<T>(work: () => Promise<T>): Promise<T>;
}) {
  const approval = structuredClone(privateApproval);
  const conversation = "scope" in approval ? approval : undefined;
  const nativeSettings = captureNativeConversationSettings(conversation?.nativeSettings);
  const exact = "approvedTextHash" in approval ? approval.approvedTextHash : undefined;
  if (!uuid.test(approval.approvalId) || !Number.isSafeInteger(approval.chatRevision) ||
      !Number.isSafeInteger(approval.expiresAt) || approval.shareReply !== true ||
      (conversation ? conversation.scope !== "conversation" || exact !== undefined ||
        !Number.isSafeInteger(conversation.issuedAt) || conversation.issuedAt > Date.now() ||
        approval.expiresAt <= conversation.issuedAt || approval.expiresAt - conversation.issuedAt > detachedConversationLimits.lifetimeMs ||
        !Number.isSafeInteger(conversation.initialMessageCount) || conversation.initialMessageCount < 0 ||
        !Number.isSafeInteger(conversation.maxTurns) || conversation.maxTurns < 1 || conversation.maxTurns > detachedConversationLimits.maxTurns
        : !exact || !/^[a-f0-9]{64}$/.test(exact))) throw unavailable();
  const { grant, model, namespace, chatId, sessionId, execution } = approval;
  const store = new ApiChatStore(join(grant.workspaceRoot, ".pkm", "state"), namespace);
  let expected = approval.revision, settledTurns = 0;
  const permits = (text: string) => validText(text) && (conversation !== undefined || sha(text) === exact);
  function assertOriginalRoot() {
    const root = lstatSync(grant.workspaceRoot);
    if (!root.isDirectory() || root.dev !== approval.rootDevice || root.ino !== approval.rootInode ||
        realpathSync(grant.workspaceRoot) !== grant.workspaceRoot) throw unavailable();
  }
  function current() {
    owner.assertCurrent(grant);
    assertOriginalRoot();
    if (approval.expiresAt <= Date.now()) throw unavailable();
  }
  function target(id: string) {
    current();
    if (id !== chatId) throw unavailable();
    const chat = store.resolveChat(chatPkmUrl(namespace, chatId));
    if (chat.sessionId !== sessionId) throw unavailable();
    store.assertRunnable(chat, undefined, execution);
    if (store.browserTurnRevision(chat, execution.digest) !== expected ||
        settledTurns >= (conversation?.maxTurns ?? 1)) throw unavailable();
    return chat;
  }
  const turns = bindBrowserChatTurns(grant, {
    assertCurrent: current,
    target: id => ({ title: target(id).title, stamp: expected }),
    confirm: async (_title, _id, text) => permits(text),
    send: (id, text, admission) => owner.withWriter(async () => {
      if (!permits(text)) throw unavailable();
      const chat = target(id);
      const admissionStamp = expected;
      const messages = prepare(chat, namespace, model, text, conversation?.initialMessageCount, nativeSettings);
      const apiKey = await owner.readProviderKey(structuredClone(model), admission.signal);
      if (typeof apiKey !== "string" || (!apiKey && new URL(model.endpoint).protocol === "https:")) throw unavailable();
      admission.assertUnchanged();
      const startedAt = Date.now(), inputId = randomUUID();
      const progress: ApiChatProgress = { attemptId: admission.id, executionContext: execution,
        attempt: Math.max(chat.messages.filter(message => message.role === "assistant").length, chat.progress?.attempt ?? 0) + 1,
        ownerPid: process.pid, ownerHost: hostname(), startedAt, status: "running", model: model.profile.model, tools: [],
        steps: [{ label: "Generating response", kind: "model", operation: "inference", status: "running", at: startedAt }] };
      const recordedAt = new Date(startedAt).toISOString();
      const reply: ChatMessage = { id: randomUUID(), inputId, taskId: sessionId, executionContext: execution, recordedAt,
        role: "assistant", content: "", status: "streaming", progress, model: model.profile.model };
      chat.progress = progress;
      if (!chat.messages.length && !chat.customTitle) chat.title = text.trim().slice(0, 65);
      chat.messages.push({ id: inputId, role: "user", content: text, status: "complete", taskId: sessionId,
        inputOrigin: "agent", recordedAt, executionContext: execution, submissionId: approval.approvalId }, reply);
      chat.updatedAt = recordedAt;
      const runningStamp = store.admitBrowserTurn(chat, admissionStamp, execution.digest, current);
      const live = () => {
        current();
        store.assertRunnable(chat, admission.id, execution);
        if (store.browserTurnRevision(chat, execution.digest) !== runningStamp) throw unavailable();
      };
      admission.onPersisted(() => { try { live(); return !admission.signal.aborted; } catch { return false; } });
      const controller = new AbortController();
      const abort = () => controller.abort();
      admission.signal.addEventListener("abort", abort, { once: true });
      if (admission.signal.aborted) abort();
      const watch = setInterval(() => { try { live(); } catch { abort(); } }, 100);
      try {
        await dispatchNativeChatModel({ provider: model.provider }, {
          ...model, model: model.profile.model, apiKey, signal: controller.signal, messages, tools: [],
          outputTokenParameter: model.profile.outputTokenParameter, includeUsage: model.profile.includeUsage,
          beforeRound: live,
          fetch: (input, init) => { live(); return fetch(input, { ...init, redirect: "error" }); },
          onUsage: usage => { reply.usage = usage; },
        }, chunk => { reply.content += chunk; });
        try { live(); } catch (error) { abort(); throw error; }
        progress.status = reply.status = "complete";
      } catch {
        progress.status = reply.status = controller.signal.aborted ? "cancelled" : "failed";
        reply.error = controller.signal.aborted ? "Response stopped." : "The model request did not complete.";
      } finally {
        clearInterval(watch);
        admission.signal.removeEventListener("abort", abort);
      }
      const ended = Date.now();
      if (apiKey) reply.content = reply.content.split(apiKey).join("[redacted]");
      progress.finishedAt = ended;
      progress.steps[0] = { ...progress.steps[0], finishedAt: ended, status: progress.status };
      reply.elapsedMs = ended - startedAt;
      chat.lastResultId = reply.id;
      chat.updatedAt = new Date(ended).toISOString();
      assertOriginalRoot();
      const settled = store.settleOwnedTextTurn(chat, admission.id, runningStamp);
      if (conversation) expected = settled;
      settledTurns++;
      return reply.status === "complete" ? "completed" : reply.status === "cancelled" ? "cancelled" : "unknown";
    }),
  });
  return { ...turns, readSettledReply(id: string) {
    current();
    if (id !== chatId) throw unavailable();
    const snapshot = store.readBrowserTranscript(chatId);
    const chat = store.resolveChat(chatPkmUrl(namespace, chatId));
    store.assertAvailable(chat);
    const input = chat.messages[chat.messages.length - 2], reply = chat.messages[chat.messages.length - 1], progress = chat.progress;
    if (chat.sessionId !== sessionId || (conversation
        ? !settledTurns || store.browserTurnRevision(chat, execution.digest) !== expected
        : chat.revision !== approval.chatRevision + 2) ||
        input?.role !== "user" || input.submissionId !== approval.approvalId || input.taskId !== sessionId ||
        !permits(input.content) || reply?.inputId !== input.id || reply.role !== "assistant" ||
        reply.taskId !== sessionId || !progress?.attemptId || reply.progress?.attemptId !== progress.attemptId ||
        progress.executionContext?.digest !== execution.digest || !["complete", "cancelled", "failed"].includes(progress.status) ||
        reply.status !== progress.status || JSON.stringify(snapshot.messages) !== JSON.stringify(chat.messages)) throw unavailable();
    current();
    const shared = conversation ? chat.messages.slice(conversation.initialMessageCount) : [input, reply];
    if (conversation && shared.length !== settledTurns * 2) throw unavailable();
    const messages = shared.map(({ id, role, content, status, recordedAt }) => ({ id, role, content, status, recordedAt }));
    // Keep within the existing authenticated one-page reply contract.
    while (messages.length > 2 && Buffer.byteLength(JSON.stringify(messages)) > 512 * 1024) messages.splice(0, 2);
    return { chatId, start: 0, total: messages.length, nextCursor: null, messages };
  } };
}
