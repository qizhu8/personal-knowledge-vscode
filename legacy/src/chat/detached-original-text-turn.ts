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
const sha = (value: string) => createHash("sha256").update(value).digest("hex");
const uuid = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/;
const unavailable = () => Error("The pre-authorized Original Chat turn is unavailable.");
const validText = (text: string) => typeof text === "string" && !!text.trim() && text.length <= 2000;

/** Private owner record from a native confirmation. Neither a browser credential nor model credentials. */
export interface DetachedOriginalTextApproval {
  grant: BrowserChatGrant;
  namespace: string;
  chatId: string;
  sessionId: string;
  rootDevice: number;
  rootInode: number;
  execution: ChatExecutionContext;
  model: Provider;
  approvedTextHash: string;
  revision: string;
  expiresAt: number;
}

function prepare(chat: ApiConversation, namespace: string, model: Provider, text: string): ApiChatMessage[] {
  const toolFree = chat.toolSelection ? ["builtin", "vscode"].every(source => chat.toolSelection!.disabledSources.includes(source))
    : chat.builtinTools?.length === 0 && chat.vscodeTools?.length === 0;
  if (!chat.sessionId || chat.workspaceNamespace !== namespace || chat.permissionMode !== "read-only" ||
      chat.includeHistory !== false || chat.activityCreditLimit !== -1 || chat.activityBudgetBypass ||
      chat.workflowMode && chat.workflowMode !== "chat" || !toolFree || chat.mcpServers?.some(server => server.enabled) ||
      chat.context.length || Object.values(chat.agentContext || {}).some(items => items.length) ||
      chat.images?.length || chat.queuedInputs?.length || chat.workerState || chat.workerActivity ||
      chat.agentProfileId || chat.workGoal || chat.debugRequest || currentHarnessTask(chat) || chat.taskContextCheckpoints?.length ||
      chat.plans?.length || chat.modelProvider !== model.provider || chat.modelProfileId !== model.profile.id ||
      chat.contextWindow !== undefined && chat.contextWindow !== model.contextWindow ||
      chat.maxOutputTokens !== undefined && chat.maxOutputTokens !== model.maxOutputTokens)
    throw unavailable();
  const inputs = chat.messages.filter(message => message.taskId === chat.sessionId);
  if (inputs.some(message => message.images?.length || message.workerEventIds?.length || message.portalSource ||
      message.portalReview || message.role === "user" && message.status !== "complete")) throw unavailable();
  const messages: ApiChatMessage[] = [{ role: "system", content: toolFreeChatInstruction + nativeChatIdentityPrompt(chat, namespace) },
    ...inputs.filter(message => message.role === "user").map(message => ({
      role: "user" as const, content: nativeTaskInputPrompt(message.id, message.content),
    })), { role: "user", content: text }];
  assertModelAvailable(model.profile);
  validateBudget(model.profile, model.contextWindow, model.maxOutputTokens, messages);
  return messages;
}

export async function approveDetachedOriginalTextTurn(options: {
  grant: BrowserChatGrant; namespace: string; chatId: string; text: string;
  execution: ChatExecutionContext; model: Provider; assertNativeOwner(): void;
  confirm(detail: { title: string; chatId: string; provider: string; model: string; endpoint: string; text: string }): Promise<boolean>;
}): Promise<DetachedOriginalTextApproval | undefined> {
  const { grant, namespace, chatId, text } = options;
  const execution = structuredClone(options.execution), model = structuredClone(options.model);
  if (!validText(text) || !uuid.test(chatId) || !grant.chatHostId || !uuid.test(grant.chatHostId) ||
      !["openai-compatible", "azure-openai"].includes(model.provider) || model.profile.status !== "active" ||
      !execution.trusted || execution.permissionMode !== "read-only" || execution.knowledgeRoot !== grant.workspaceRoot ||
      sha(execution.workspaceUris.join("|")).slice(0, 16) !== namespace ||
      !execution.workspacePaths.every((path, index) => execution.workspaceUris[index].startsWith("file:") && realpathSync(path) === path))
    throw unavailable();
  const endpoint = new URL(model.endpoint);
  if (endpoint.username || endpoint.password || endpoint.search || endpoint.hash ||
      endpoint.protocol !== "https:" && !(endpoint.protocol === "http:" && ["127.0.0.1", "[::1]", "localhost"].includes(endpoint.hostname))) throw unavailable();
  options.assertNativeOwner();
  const store = new ApiChatStore(join(grant.workspaceRoot, ".pkm", "state"), namespace);
  const root = lstatSync(grant.workspaceRoot);
  const chat = store.resolveChat(chatPkmUrl(namespace, chatId));
  store.assertRunnable(chat, undefined, execution);
  prepare(chat, namespace, model, text);
  const revision = store.browserTurnRevision(chat, execution.digest);
  if (!await options.confirm({ title: chat.title, chatId, provider: model.provider, model: model.profile.model, endpoint: model.endpoint, text })) return;
  options.assertNativeOwner();
  const currentRoot = lstatSync(grant.workspaceRoot);
  if (currentRoot.dev !== root.dev || currentRoot.ino !== root.ino || !currentRoot.isDirectory() ||
      store.browserTurnRevision(chat, execution.digest) !== revision) throw unavailable();
  return { grant: { ...grant }, namespace, chatId, sessionId: chat.sessionId!, execution, model, revision,
    approvedTextHash: sha(text), expiresAt: Date.now() + 15 * 60_000, rootDevice: root.dev, rootInode: root.ino };
}

/** Only the trusted service can supply this immutable approval and resolve its pinned credential. */
export function bindDetachedOriginalTextTurn(privateApproval: DetachedOriginalTextApproval, owner: {
  assertCurrent(grant: BrowserChatGrant): void;
  readProviderKey(model: Provider, signal: AbortSignal): Promise<string>;
  withWriter<T>(work: () => Promise<T>): Promise<T>;
}) {
  const approval = structuredClone(privateApproval);
  const { grant, model, namespace, chatId, sessionId, execution } = approval;
  const store = new ApiChatStore(join(grant.workspaceRoot, ".pkm", "state"), namespace);
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
    if (store.browserTurnRevision(chat, execution.digest) !== approval.revision) throw unavailable();
    return chat;
  }
  return bindBrowserChatTurns(grant, {
    assertCurrent: current,
    target: id => ({ title: target(id).title, stamp: approval.revision }),
    confirm: async (_title, _id, text) => validText(text) && sha(text) === approval.approvedTextHash,
    send: (id, text, admission) => owner.withWriter(async () => {
      if (!validText(text) || sha(text) !== approval.approvedTextHash) throw unavailable();
      const chat = target(id);
      const messages = prepare(chat, namespace, model, text);
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
        inputOrigin: "agent", recordedAt, executionContext: execution }, reply);
      chat.updatedAt = recordedAt;
      store.admitBrowserTurn(chat, approval.revision, execution.digest, current);
      const live = () => { current(); store.assertRunnable(chat, admission.id, execution); };
      admission.onPersisted(() => { try { live(); return !admission.signal.aborted; } catch { return false; } });
      const controller = new AbortController();
      const abort = () => controller.abort();
      admission.signal.addEventListener("abort", abort, { once: true });
      if (admission.signal.aborted) abort();
      const watch = setInterval(() => { try { live(); } catch { abort(); } }, 250);
      try {
        await dispatchNativeChatModel({ provider: model.provider }, {
          ...model, model: model.profile.model, apiKey, signal: controller.signal, messages, tools: [],
          outputTokenParameter: model.profile.outputTokenParameter, includeUsage: model.profile.includeUsage,
          beforeRound: live,
          fetch: (input, init) => { live(); return fetch(input, { ...init, redirect: "error" }); },
          onUsage: usage => { reply.usage = usage; },
        }, chunk => { reply.content += chunk; });
        live();
        progress.status = reply.status = "complete";
      } catch {
        progress.status = reply.status = controller.signal.aborted ? "cancelled" : "failed";
        reply.error = controller.signal.aborted ? "Response stopped." : "The model request did not complete.";
      } finally {
        clearInterval(watch);
        admission.signal.removeEventListener("abort", abort);
      }
      const ended = Date.now();
      progress.finishedAt = ended;
      progress.steps[0] = { ...progress.steps[0], finishedAt: ended, status: progress.status };
      reply.elapsedMs = ended - startedAt;
      chat.lastResultId = reply.id;
      chat.updatedAt = new Date(ended).toISOString();
      assertOriginalRoot();
      store.settleOwnedTextTurn(chat, admission.id);
      return reply.status === "complete" ? "completed" : reply.status === "cancelled" ? "cancelled" : "unknown";
    }),
  });
}
