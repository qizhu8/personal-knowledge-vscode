import * as fs from "fs";
import * as path from "path";
import { randomUUID } from "crypto";
import { hostname } from "os";
import { agentSessionGroup } from "../agent-sessions/agent-session-lifecycle";
import { decodeChatImage } from "./api-chat-client";
import { ChatLibrary } from "./chat-library";
import { validChatRetrievalReceipt, validChatRetrievalActivity } from "./chat-retrieval";
import { withCrossProcessLockSync } from "../runtime/cross-process-lock";
import { chatPkmUrl, parsePkmLocator } from "../knowledge/knowledge-locator";
import { ChatExecutionContext, validExecutionContext } from "./execution-context";
import { accountMcpIdentity } from "../mcp/mcp-account-binding";
import { WorkerTreeStore, ChatWorkerState, WorkerPhase, WorkerActivity, validWorkerActivity } from "./worker-tree";

export interface ChatContext { id: string; label: string; content: string; }
export interface QueuedChatInput { id: string; text: string; mode: "steer" | "task"; attemptId?: string; executionContext?: ChatExecutionContext; }
export interface ChatDelegation {
  id: string;
  chatId: string;
  chatUrl: string;
  status: "running" | "complete" | "failed" | "cancelled";
  answer?: string;
  error?: string;
  truncated?: boolean;
  treeId?: string;
  phase?: WorkerPhase;
  title?: string;
  question?: string;
  dispatchedAt?: number;
  batchId?: string;
  activityId?: string;
  attemptId?: string;
  temporary?: boolean;
  archived?: boolean;
}
export interface ApiChatProgress {
  attemptId?: string;
  executionContext?: ChatExecutionContext;
  attempt?: number;
  retryOf?: string;
  ownerPid?: number;
  ownerHost?: string;
  startedAt: number;
  finishedAt?: number;
  status: "running" | "complete" | "cancelled" | "failed";
  model: string;
  tools?: string[];
  droppedSteps?: number;
  completedDroppedSteps?: number;
  steps: Array<{ label: string; at: number; status?: "running" | "waiting" | "complete" | "cancelled" | "failed" }>;
}
export interface ChatMessage {
  id: string;
  executionContext?: ChatExecutionContext;
  taskId?: string;
  retrieval?: import("./chat-retrieval").ChatRetrievalReceipt;
  retrievalActivity?: import("./chat-retrieval").ChatRetrievalActivity;
  role: "user" | "assistant";
  content: string;
  images?: import("./api-chat-client").ChatImage[];
  status: "complete" | "streaming" | "cancelled" | "failed" | "interrupted";
  error?: string;
  progress?: ApiChatProgress;
  model?: string;
  contextLabels?: string[];
  fromSessionId?: string;
  fromChatId?: string;
  delegationId?: string;
  delegations?: ChatDelegation[];
  submissionId?: string;
  inputKind?: "steer" | "task";
  workerEventIds?: string[];
  unattributedFileChanges?: boolean;
  elapsedMs?: number;
  usage?: { inputTokens: number; outputTokens: number; cachedInputTokens?: number };
  usageMetadata?: { frames: number; validFrames: number; invalidFrames: number };
  estimatedCost?: number;
  currency?: string;
  contextWindow?: number;
  maxOutputTokens?: number;
  outputBudgetWarning?: string;
  changes?: import("./api-chat-tools").ApiChatEditChange[];
  toolCalls?: Array<{ id: string; name: string; arguments: string; status: "running" | "complete" | "failed"; result?: string }>;
}
export interface ApiConversation {
  version: 1;
  revision?: number;
  workspaceNamespace?: string;
  id: string;
  sessionId?: string;
  title: string;
  customTitle?: boolean;
  paused?: boolean;
  permissionMode?: "protective" | "ask" | "read-only" | "allow-all";
  permissionGrants?: string[];
  permissionContextId?: string;
  lastResultId?: string;
  readResultId?: string;
  createdAt: string;
  updatedAt: string;
  messages: ChatMessage[];
  queuedInputs?: QueuedChatInput[];
  memoryTasks?: Array<{ id: string; title: string; createdAt: string }>;
  context: ChatContext[];
  images?: import("./api-chat-client").ChatImage[];
  includeHistory: boolean;
  modelProvider?: "vscode" | "openai-compatible" | "azure-openai";
  vscodeModelId?: string;
  vscodeModelLabel?: string;
  modelProfileId?: string;
  contextWindow?: number;
  maxOutputTokens?: number;
  progress?: ApiChatProgress;
  agentContext?: { memory: ChatContext[]; pkmSkills: ChatContext[]; externalSkills: ChatContext[] };
  builtinTools?: string[];
  vscodeTools?: string[];
  toolSelection?: import("./tool-selection").ChatToolSelection;
  mcpServers?: import("./api-chat-mcp").ApiChatMcpServer[];
  workerState?: ChatWorkerState;
  workerActivity?: WorkerActivity;
}

export type ApiChatStatus = "running" | "idle" | "completed" | "new-result" | "awaiting-input" | "awaiting-result" | "paused" | "failed" | "stopped";

export function apiChatDiagnostics(chat: ApiConversation) {
  const tokenUsage = (usage: ChatMessage["usage"]) => usage && [usage.inputTokens, usage.outputTokens].every(value => Number.isSafeInteger(value) && value >= 0) ? {
    inputTokens: usage.inputTokens, outputTokens: usage.outputTokens,
    ...(Number.isSafeInteger(usage.cachedInputTokens) && usage.cachedInputTokens! >= 0 && usage.cachedInputTokens! <= usage.inputTokens ? { cachedInputTokens: usage.cachedInputTokens } : {}),
  } : undefined;
  const usageMetadata = (metadata: ChatMessage["usageMetadata"]) => metadata && [metadata.frames, metadata.validFrames, metadata.invalidFrames].every(value => Number.isSafeInteger(value) && value >= 0 && value <= 128) && metadata.validFrames + metadata.invalidFrames === metadata.frames
    ? { frames: metadata.frames, validFrames: metadata.validFrames, invalidFrames: metadata.invalidFrames } : undefined;
  const errorKind = (error = "") => /metadata/i.test(error) ? "provider-metadata" : /image/i.test(error) ? "image-response" : /empty response/i.test(error) ? "empty-response" : /tool calling/i.test(error) ? "tool-capability" : /timed out/i.test(error) ? "timeout" : /cancel|interrupted/i.test(error) ? "interrupted" : /budget|limit/i.test(error) ? "local-limit" : error ? "other" : undefined;
  const progress = (run: ApiChatProgress | undefined) => run && ({
    attemptId: run.attemptId, attempt: run.attempt, retryOf: run.retryOf,
    startedAt: run.startedAt, finishedAt: run.finishedAt, status: run.status, model: run.model,
    tools: run.tools?.slice(0, 80),
    droppedSteps: run.droppedSteps, completedDroppedSteps: run.completedDroppedSteps,
    steps: run.steps.slice(0, 512).map(step => ({ at: step.at, status: step.status,
      label: /^(Running|Completed|Failed) tool:/.test(step.label) ? step.label.split(":")[0] : /^Waiting/.test(step.label) ? "Waiting" : ["Preparing context", "Checking VS Code model access", "Requesting VS Code model", "Connecting to model API", "Generating response", "Receiving image"].includes(step.label) ? step.label : "Other activity" })),
  });
  return {
    schema: "pkm.chat.diagnostics/v1", sessionId: chat.sessionId, chatId: chat.id,
    provider: chat.modelProvider, modelId: chat.vscodeModelId || chat.modelProfileId,
    paused: chat.paused === true, permissionMode: chat.permissionMode || "protective",
    configuredBuiltinTools: (chat.builtinTools || []).slice(0, 32),
    configuredVscodeTools: (chat.vscodeTools || []).slice(0, 512),
    mcp: (chat.mcpServers || []).slice(0, 4).map(server => ({ enabled: server.enabled, allowedTools: server.tools.slice(0, 16) })),
    attempts: chat.messages.filter(message => message.role === "assistant").slice(-20).map(message => ({
      id: message.id, status: message.status, errorKind: errorKind(message.error), model: message.model,
      contextWindow: message.contextWindow, maxOutputTokens: message.maxOutputTokens, elapsedMs: message.elapsedMs,
      outputBudgetWarning: message.outputBudgetWarning,
      outputCharacters: message.content.length, imageCount: message.images?.length || 0,
      reportedTokenUsage: tokenUsage(message.usage), usageMetadata: usageMetadata(message.usageMetadata),
      tools: (message.toolCalls || []).slice(0, 128).map(tool => ({ name: tool.name, status: tool.status })),
      progress: progress(message.progress),
    })),
    latestProgress: progress(chat.progress),
  };
}

export function apiChatSessionDiagnostics(record: Record<string, unknown>, sessionId: string) {
  const chat = record.nativeChat as ApiConversation | undefined;
  if (!/^agent_session_[a-f0-9]{32}$/.test(sessionId) || record.schema !== "pkm.agent.session/v1" || record.sessionId !== sessionId || agentSessionOrigin(record).origin !== "pkm-native" || record.hostKind !== "pkm" || chat?.version !== 1 || chat.sessionId !== sessionId || !Array.isArray(chat.messages)) throw new Error("A matching PKM-native Session record is required.");
  return { ...apiChatDiagnostics(chat), recordStatus: record.status, updatedAt: record.updatedAt };
}

export function apiChatStatus(chat: ApiConversation, running = chat.progress?.status === "running", awaitingInput = chat.progress?.steps[chat.progress.steps.length - 1]?.status === "waiting"): ApiChatStatus {
  if (chat.paused) return "paused";
  if (running) return awaitingInput ? "awaiting-input" : "running";
  const latest = chat.messages[chat.messages.length - 1];
  if (chat.progress?.status === "failed" || latest?.role === "assistant" && ["failed", "interrupted"].includes(latest.status)) return "failed";
  if (chat.progress?.status === "cancelled" || latest?.role === "assistant" && latest.status === "cancelled") return "stopped";
  if (chat.workerState?.stopped) return "stopped";
  if (chat.messages.some(message => message.delegations?.some(record => record.status === "running"))) return "awaiting-result";
  if (chat.lastResultId && chat.lastResultId !== chat.readResultId) return "new-result";
  if (chat.progress?.status === "complete" || latest?.role === "assistant" && latest.status === "complete") return "completed";
  return "idle";
}

export function agentSessionOrigin(record: Record<string, unknown>): {
  origin: "pkm-native" | "external" | "unknown"; runtimeOwner: "pkm" | "external" | "unknown";
} {
  if (record.origin === "pkm-native" && record.runtimeOwner === "pkm") return { origin: "pkm-native", runtimeOwner: "pkm" };
  if (record.origin === "external" || ["copilot", "claude", "claude-code"].includes(String(record.hostKind || ""))) {
    return { origin: "external", runtimeOwner: "external" };
  }
  return { origin: "unknown", runtimeOwner: "unknown" };
}

export class ApiChatStore {
  private readonly directory: string;
  readonly library: ChatLibrary;
  readonly workerTrees: WorkerTreeStore;
  private readonly queueSnapshots = new WeakMap<ApiConversation, { fingerprint: string; inputs: QueuedChatInput[] }>();

  private rememberQueue(chat: ApiConversation): void {
    const { revision, updatedAt, queuedInputs, ...state } = chat;
    this.queueSnapshots.set(chat, { fingerprint: JSON.stringify(state), inputs: JSON.parse(JSON.stringify(queuedInputs || [])) });
  }

  private reconcileQueue(chat: ApiConversation, current: ApiConversation): void {
    if ((current.revision || 0) === (chat.revision || 0)) return;
    const snapshot = this.queueSnapshots.get(chat);
    const { revision, updatedAt, queuedInputs, ...state } = current;
    if (!snapshot || JSON.stringify(state) !== snapshot.fingerprint || current.progress?.status !== "running"
      || !chat.progress?.attemptId || current.progress.attemptId !== chat.progress.attemptId
      || current.progress.ownerPid !== process.pid || current.progress.ownerHost !== hostname()) return;
    const local = chat.queuedInputs || [];
    const removed = new Set(snapshot.inputs.filter(input => !local.some(item => item.id === input.id)).map(input => input.id));
    const merged = (queuedInputs || []).filter(input => !removed.has(input.id));
    for (const input of local.filter(input => !snapshot.inputs.some(item => item.id === input.id))) {
      if (!merged.some(item => item.id === input.id)) merged.push(input);
    }
    if (merged.length > 20) throw new Error("The Chat already has 20 queued inputs.");
    chat.queuedInputs = merged;
    chat.revision = current.revision;
    this.queueSnapshots.set(chat, { fingerprint: JSON.stringify(state), inputs: JSON.parse(JSON.stringify(queuedInputs || [])) });
  }

  constructor(private readonly stateDirectory: string, readonly namespace: string) {
    if (!/^[a-f0-9]{16}$/.test(namespace)) throw new Error("Invalid workspace namespace.");
    this.directory = path.join(stateDirectory, "api-chats", namespace);
    this.library = new ChatLibrary(path.join(stateDirectory, "api-chats"));
    this.workerTrees = new WorkerTreeStore(path.join(stateDirectory, "api-chat-worker-trees"));
  }

  create(): ApiConversation {
    const now = new Date().toISOString();
    const chat: ApiConversation = {
      version: 1, id: randomUUID(), workspaceNamespace: this.namespace,
      title: "New chat", createdAt: now, updatedAt: now, messages: [], context: [], includeHistory: true,
      permissionMode: "protective",
    };
    this.save(chat);
    return chat;
  }

  createWorker(manager: ApiConversation, id: string, title: string, workerState: ChatWorkerState): ApiConversation {
    const now = new Date().toISOString();
    const chat: ApiConversation = {
      version: 1, id, workspaceNamespace: this.namespace, title, customTitle: true,
      createdAt: now, updatedAt: now, messages: [], context: [], images: [], includeHistory: true,
      permissionMode: manager.permissionMode, modelProvider: manager.modelProvider,
      vscodeModelId: manager.vscodeModelId, vscodeModelLabel: manager.vscodeModelLabel, modelProfileId: manager.modelProfileId,
      contextWindow: manager.contextWindow, maxOutputTokens: manager.maxOutputTokens,
      builtinTools: manager.builtinTools && [...manager.builtinTools],
      vscodeTools: manager.vscodeTools && [...manager.vscodeTools],
      toolSelection: manager.toolSelection && JSON.parse(JSON.stringify(manager.toolSelection)),
      mcpServers: manager.mcpServers && JSON.parse(JSON.stringify(manager.mcpServers)),
      workerState,
    };
    this.save(chat);
    return chat;
  }

  resolveChat(identity: string): ApiConversation {
    const parsed = /^[a-f0-9-]{36}$/.test(identity) ? undefined : parsePkmLocator(identity);
    if (parsed && parsed.kind !== "chat") throw new Error("Choose a PKM Chat URL.");
    let chat: ApiConversation;
    try { chat = this.load(parsed?.kind === "chat" ? parsed.chatId : identity, false); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") throw new Error("Choose an existing non-Trash Chat in this account's Knowledge Root.");
      throw error;
    }
    if (parsed?.kind === "chat" && chat.workspaceNamespace !== parsed.namespace) throw new Error("The Chat URL does not match its stored identity.");
    if (this.library.read().placements[chat.id]?.trashedAt) throw new Error("Choose an existing non-Trash Chat in this account's Knowledge Root.");
    return chat;
  }

  startTask(chat: ApiConversation, title: string): void {
    if (chat.sessionId) throw new Error("Complete the current Task before starting another Task.");
    if (chat.progress?.status === "running" || chat.messages.some(message => message.status === "streaming")) throw new Error("Wait for the current request before starting a Task.");
    title = title.trim();
    if (!title || title.length > 120 || /[\u0000-\u001f\u007f]/.test(title)) throw new Error("Enter a Task name of 1-120 characters without control characters.");
    chat.sessionId = "agent_session_" + randomUUID().replace(/-/g, "");
    const previousMemoryTasks = chat.memoryTasks;
    chat.memoryTasks = [...(chat.memoryTasks || []), { id: chat.sessionId, title, createdAt: new Date().toISOString() }];
    try { this.save(chat, true, title); } catch (error) { delete chat.sessionId; chat.memoryTasks = previousMemoryTasks; throw error; }
  }

  completeTask(chat: ApiConversation): void {
    withCrossProcessLockSync(path.join(this.stateDirectory, "api-chats", "chats.lock"), "Chat history", () => this.completeTaskUnlocked(chat));
  }

  private completeTaskUnlocked(chat: ApiConversation): void {
    if (!chat.sessionId) return;
    const current = this.load(chat.id, false);
    if ((current.revision || 0) !== (chat.revision || 0)) throw new Error("This Chat changed in another window. Reopen it before completing the Task.");
    if (this.library.read().placements[chat.id]?.trashedAt) throw new Error("Restore this Chat from Trash before completing its Task.");
    if (chat.progress?.status === "running" || chat.messages.some(message => message.status === "streaming")) throw new Error("Wait for the current request before completing a Task.");
    const file = path.join(this.stateDirectory, "agent-sessions", `${chat.sessionId}.json`);
    if (!/^agent_session_[a-f0-9]{32}$/.test(chat.sessionId)) throw new Error("Invalid native Session identity.");
    if (fs.existsSync(file)) {
      const session = JSON.parse(fs.readFileSync(file, "utf8"));
      if (agentSessionOrigin(session).origin !== "pkm-native") throw new Error("This Session is not owned by the PKM native runtime.");
      if (!["stopped", "completed"].includes(session.status)) {
        if ((session.todos || []).some((todo: { status: string }) => !["succeeded", "skipped"].includes(todo.status)) || session.recipeRunIds?.length) throw new Error("Resolve unfinished Todos and attached Recipes in Agent Sessions before completing this Task.");
        this.write(file, { ...session, status: "completed", completedAt: new Date().toISOString(), updatedAt: new Date().toISOString() });
      }
    }
    delete chat.sessionId;
    this.saveUnlocked(chat, false);
  }

  save(chat: ApiConversation, initializeSession = false, taskTitle?: string): void {
    withCrossProcessLockSync(path.join(this.stateDirectory, "api-chats", "chats.lock"), "Chat history", () => this.saveUnlocked(chat, initializeSession, taskTitle));
  }

  private saveUnlocked(chat: ApiConversation, initializeSession: boolean, taskTitle?: string): void {
    if (this.library.read().placements[chat.id]?.trashedAt) throw new Error("Restore this Chat from Trash before changing it.");
    this.validateImages(chat);
    if (Buffer.byteLength(JSON.stringify(chat), "utf8") > 5_000_000) throw new Error("Chat history exceeds 5 MB. Start a new chat; nothing was overwritten.");
    const file = this.file(chat.id);
    if (!fs.existsSync(file) && chat.revision !== undefined) throw new Error("This Chat was deleted in another window. Choose another Chat.");
    if (fs.existsSync(file)) this.reconcileQueue(chat, this.load(chat.id, false));
    const storedRevision = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, "utf8")).revision || 0 : 0;
    if ((chat.revision || 0) !== storedRevision) throw new Error("This Chat changed in another window. Reopen it before making changes.");
    if (chat.sessionId !== undefined && !/^agent_session_[a-f0-9]{32}$/.test(chat.sessionId)) throw new Error("Invalid native Session identity.");
    const group = agentSessionGroup({ sessionId: chat.sessionId || "", hostSessionId: chat.id, hostKind: "pkm" });
    const groupPath = path.join(this.stateDirectory, "agent-groups", `${group.groupId}.json`);
    const previousGroup = fs.existsSync(groupPath) ? JSON.parse(fs.readFileSync(groupPath, "utf8")) : {};
    const sessionPath = path.join(this.stateDirectory, "agent-sessions", `${chat.sessionId}.json`);
    const trashPath = path.join(this.stateDirectory, "agent-sessions-trash", `${chat.sessionId}.json`);
    const previous = fs.existsSync(sessionPath) ? JSON.parse(fs.readFileSync(sessionPath, "utf8")) : {};
    if (fs.existsSync(sessionPath) && agentSessionOrigin(previous).origin !== "pkm-native") throw new Error("This Session is not owned by the PKM native runtime.");
    const revision = storedRevision + 1;
    this.write(file, { ...chat, revision }); chat.revision = revision;
    this.rememberQueue(chat);
    this.write(groupPath, { ...previousGroup, schema: "pkm.agent.group/v1", groupId: group.groupId,
      hostKind: "pkm", hostSessionId: chat.id, title: chat.title, deletedAt: undefined, createdAt: previousGroup.createdAt || chat.createdAt, updatedAt: chat.updatedAt });
    if (!chat.sessionId) return;
    if (fs.existsSync(trashPath)) return;
    if (!initializeSession && !fs.existsSync(sessionPath)) return;
    const active = chat.progress?.status === "running" || chat.messages.some(message => message.status === "streaming");
    this.write(sessionPath, {
      ...previous, schema: "pkm.agent.session/v1", sessionId: chat.sessionId,
      origin: "pkm-native", runtimeOwner: "pkm", ...group,
      status: ["stopped", "completed"].includes(previous.status) ? previous.status : active && !chat.paused ? "running" : "paused", task: previous.task || taskTitle || chat.title, projectId: previous.projectId || "",
      agent: { name: "PKM API Chat", product: "PKM" },
      todos: previous.todos || [], recipeRunIds: previous.recipeRunIds || [],
      checkpoints: previous.checkpoints || [], createdAt: previous.createdAt || new Date().toISOString(), updatedAt: chat.updatedAt,
      nativeChat: chat,
      liveness: { heartbeatAt: new Date().toISOString(), leaseSeconds: 300, owner: { hostSessionId: chat.id } },
    });
  }

  assertAvailable(chat: ApiConversation): void {
    if (this.library.read().placements[chat.id]?.trashedAt) throw new Error("This Chat is in Trash. Restore it before using it.");
    if (!chat.sessionId) return;
    if (!/^agent_session_[a-f0-9]{32}$/.test(chat.sessionId)) throw new Error("Invalid native Session identity.");
    if (fs.existsSync(path.join(this.stateDirectory, "agent-sessions-trash", `${chat.sessionId}.json`))) {
      throw new Error("This Session is in Trash. Restore it in Agent Sessions or start a new chat.");
    }
    const file = path.join(this.stateDirectory, "agent-sessions", `${chat.sessionId}.json`);
    if (!fs.existsSync(file)) throw new Error("This Session was removed. Start a new chat.");
    const session = JSON.parse(fs.readFileSync(file, "utf8"));
    if (session.status === "stopped") throw new Error("This Session was stopped. Start a new chat.");
  }

  recoverAbandoned(chat: ApiConversation): boolean {
    return withCrossProcessLockSync(path.join(this.stateDirectory, "api-chats", "chats.lock"), "Chat history", () => {
      const current = this.load(chat.id, false);
      const owner = current.progress;
      if (current.revision !== chat.revision || owner?.status !== "running" || owner.ownerHost !== hostname() || !owner.ownerPid || owner.ownerPid === process.pid || this.library.read().placements[chat.id]?.trashedAt) return false;
      try { process.kill(owner.ownerPid, 0); return false; }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== "ESRCH") return false; }
      const recovered = this.load(chat.id, true);
      this.saveUnlocked(recovered, false);
      Object.assign(chat, recovered);
      return true;
    });
  }

  load(id: string, recoverInterrupted = true): ApiConversation {
    const file = this.file(id);
    if (fs.statSync(file).size > 5_000_000) throw new Error("Chat history exceeds the local size limit.");
    const chat = JSON.parse(fs.readFileSync(file, "utf8")) as ApiConversation;
    const contextsValid = (items: ChatContext[]) => Array.isArray(items) && items.every(item => item && typeof item.id === "string" && typeof item.label === "string" && typeof item.content === "string");
    const progressValid = (run: ApiChatProgress) => run && Number.isFinite(run.startedAt) && (run.finishedAt === undefined || Number.isFinite(run.finishedAt)) && ["running", "complete", "cancelled", "failed"].includes(run.status) && typeof run.model === "string"
      && (run.executionContext === undefined || validExecutionContext(run.executionContext))
      && (run.ownerPid === undefined || Number.isSafeInteger(run.ownerPid) && run.ownerPid > 0 && run.ownerPid <= 2147483647) && (run.ownerHost === undefined || typeof run.ownerHost === "string" && run.ownerHost.length <= 256)
      && (run.attemptId === undefined || typeof run.attemptId === "string" && run.attemptId.length <= 80) && (run.retryOf === undefined || typeof run.retryOf === "string" && run.retryOf.length <= 80)
      && (run.attempt === undefined || Number.isSafeInteger(run.attempt) && run.attempt > 0) && (run.tools === undefined || Array.isArray(run.tools) && run.tools.every(name => typeof name === "string" && name.length <= 200))
      && (run.droppedSteps === undefined || Number.isSafeInteger(run.droppedSteps) && run.droppedSteps >= 0)
      && (run.completedDroppedSteps === undefined || Number.isSafeInteger(run.completedDroppedSteps) && run.completedDroppedSteps >= 0 && run.completedDroppedSteps <= (run.droppedSteps || 0))
      && Array.isArray(run.steps) && run.steps.length <= 512 && run.steps.every(step => step && typeof step.label === "string" && Number.isFinite(step.at) && (step.status === undefined || ["running", "waiting", "complete", "cancelled", "failed"].includes(step.status)));
    const changesValid = (items: NonNullable<ChatMessage["changes"]>) => Array.isArray(items) && items.length <= 4096 && items.every(item => item && typeof item.path === "string" && item.path.length <= 4096 && Number.isSafeInteger(item.workspace) && item.workspace >= 0 && typeof item.appliedAt === "string" && Number.isFinite(Date.parse(item.appliedAt)) && /^[a-f0-9]{64}$/.test(item.beforeHash) && /^[a-f0-9]{64}$/.test(item.afterHash) && item.saved === false && ["exact", "unknown"].includes(item.attribution) && (item.attribution !== "exact" || Number.isSafeInteger(item.added) && item.added! >= 0 && Number.isSafeInteger(item.removed) && item.removed! >= 0));
    if (!chat || chat.version !== 1 || chat.id !== id || chat.sessionId !== undefined && !/^agent_session_[a-f0-9]{32}$/.test(chat.sessionId) || typeof chat.title !== "string" || typeof chat.updatedAt !== "string" || !Number.isFinite(Date.parse(chat.updatedAt)) || typeof chat.createdAt !== "string" || !Number.isFinite(Date.parse(chat.createdAt)) || typeof chat.includeHistory !== "boolean" || !Array.isArray(chat.messages) || !contextsValid(chat.context)
      || chat.messages.some(message => !message || typeof message.id !== "string" || typeof message.content !== "string" || !["user", "assistant"].includes(message.role) || !["complete", "streaming", "cancelled", "failed", "interrupted"].includes(message.status)
        || message.executionContext !== undefined && !validExecutionContext(message.executionContext)
        || message.taskId !== undefined && (typeof message.taskId !== "string" || message.taskId.length > 128)
        || message.retrieval !== undefined && !validChatRetrievalReceipt(message.retrieval, chat.id)
        || message.retrievalActivity !== undefined && !validChatRetrievalActivity(message.retrievalActivity, chat.id)
        || message.progress !== undefined && !progressValid(message.progress)
        || message.changes !== undefined && !changesValid(message.changes)
        || message.fromSessionId !== undefined && (typeof message.fromSessionId !== "string" || !/^agent_session_[a-f0-9]{32}$/.test(message.fromSessionId))
        || message.fromChatId !== undefined && (typeof message.fromChatId !== "string" || !/^[a-f0-9-]{36}$/.test(message.fromChatId))
        || message.delegationId !== undefined && (typeof message.delegationId !== "string" || !/^[a-f0-9-]{36}$/.test(message.delegationId))
        || message.submissionId !== undefined && (typeof message.submissionId !== "string" || !/^[a-f0-9-]{36}$/.test(message.submissionId))
        || message.inputKind !== undefined && !["steer", "task"].includes(message.inputKind)
        || message.workerEventIds !== undefined && (!Array.isArray(message.workerEventIds) || message.workerEventIds.length > 3 || message.workerEventIds.some(id => !/^[a-f0-9-]{36}$/.test(id)))
        || message.delegations !== undefined && (!Array.isArray(message.delegations) || message.delegations.length > 1000 || message.delegations.some(record => !record || typeof record.id !== "string" || !/^[a-f0-9-]{36}$/.test(record.id) || typeof record.chatId !== "string" || !/^[a-f0-9-]{36}$/.test(record.chatId) || !this.validDelegationUrl(record) || !["running", "complete", "failed", "cancelled"].includes(record.status) || record.answer !== undefined && (typeof record.answer !== "string" || record.answer.length > 12_000) || record.error !== undefined && (typeof record.error !== "string" || record.error.length > 1000) || record.truncated !== undefined && typeof record.truncated !== "boolean"
          || record.treeId !== undefined && !/^[a-f0-9-]{36}$/.test(record.treeId) || record.phase !== undefined && !["running", "awaiting-input", "sleeping", "complete", "failed", "cancelled"].includes(record.phase)
          || record.title !== undefined && (typeof record.title !== "string" || record.title.length > 120)
          || record.question !== undefined && (typeof record.question !== "string" || record.question.length > 4000)
          || record.dispatchedAt !== undefined && (!Number.isSafeInteger(record.dispatchedAt) || record.dispatchedAt < 0)
          || record.batchId !== undefined && !/^[a-f0-9-]{36}$/.test(record.batchId)
          || record.activityId !== undefined && !/^[a-f0-9-]{36}$/.test(record.activityId)
          || record.attemptId !== undefined && !/^[a-f0-9-]{36}$/.test(record.attemptId)
          || record.temporary !== undefined && typeof record.temporary !== "boolean"
          || record.archived !== undefined && typeof record.archived !== "boolean"))
        || message.outputBudgetWarning !== undefined && (typeof message.outputBudgetWarning !== "string" || message.outputBudgetWarning.length > 1024)
        || message.unattributedFileChanges !== undefined && typeof message.unattributedFileChanges !== "boolean"
        || message.toolCalls && (!Array.isArray(message.toolCalls) || message.toolCalls.some(tool => !tool || typeof tool.id !== "string" || typeof tool.name !== "string" || typeof tool.arguments !== "string" || !["running", "complete", "failed"].includes(tool.status) || tool.result !== undefined && typeof tool.result !== "string")))
      || chat.agentContext && Object.values(chat.agentContext).some(items => !contextsValid(items))
      || chat.modelProvider !== undefined && !["vscode", "openai-compatible", "azure-openai"].includes(chat.modelProvider)
      || chat.revision !== undefined && (!Number.isSafeInteger(chat.revision) || chat.revision < 0)
      || chat.workspaceNamespace !== undefined && chat.workspaceNamespace !== path.basename(path.dirname(file))
      || chat.customTitle !== undefined && typeof chat.customTitle !== "boolean"
      || chat.queuedInputs !== undefined && (!Array.isArray(chat.queuedInputs) || chat.queuedInputs.length > 20 || chat.queuedInputs.some(input => !input || typeof input.id !== "string" || !/^[a-f0-9-]{36}$/.test(input.id) || typeof input.text !== "string" || !input.text.trim() || input.text.length > 16_000 || !["steer", "task"].includes(input.mode) || input.attemptId !== undefined && (typeof input.attemptId !== "string" || input.attemptId.length > 80) || input.executionContext !== undefined && !validExecutionContext(input.executionContext)) || new Set(chat.queuedInputs.map(input => input.id)).size !== chat.queuedInputs.length)
      || chat.memoryTasks !== undefined && (!Array.isArray(chat.memoryTasks) || chat.memoryTasks.length > 4096 || chat.memoryTasks.some(task => !task || typeof task.id !== "string" || task.id.length > 128 || typeof task.title !== "string" || task.title.length > 512 || typeof task.createdAt !== "string" || !Number.isFinite(Date.parse(task.createdAt))))
      || chat.paused !== undefined && typeof chat.paused !== "boolean"
      || chat.workerActivity !== undefined && !validWorkerActivity(chat.workerActivity)
      || chat.workerState !== undefined && (!chat.workerState || !/^[a-f0-9-]{36}$/.test(chat.workerState.treeId)
        || !validExecutionContext(chat.workerState.executionContext) || typeof chat.workerState.sleeping !== "boolean" || typeof chat.workerState.stopped !== "boolean"
        || chat.workerState.parentChatId !== undefined && !/^[a-f0-9-]{36}$/.test(chat.workerState.parentChatId)
        || chat.workerState.receiptId !== undefined && !/^[a-f0-9-]{36}$/.test(chat.workerState.receiptId)
        || !Array.isArray(chat.workerState.events) || chat.workerState.events.length > 1000 || chat.workerState.events.some(event => !event || !/^[a-f0-9-]{36}$/.test(event.id) || !/^[a-f0-9-]{36}$/.test(event.receiptId) || !["running", "awaiting-input", "sleeping", "complete", "failed", "cancelled"].includes(event.phase)
          || event.senderChatId !== undefined && !/^[a-f0-9-]{36}$/.test(event.senderChatId) || event.message !== undefined && (typeof event.message !== "string" || !event.message.trim() || event.message.length > 4000)
          || event.activityId !== undefined && !/^[a-f0-9-]{36}$/.test(event.activityId) || event.attemptId !== undefined && !/^[a-f0-9-]{36}$/.test(event.attemptId)
          || event.episodeId !== undefined && !/^[a-f0-9-]{36}$/.test(event.episodeId)
          || event.reason !== undefined && !["clarification", "suggestion", "permission", "runtime-limit", "suspected-loop"].includes(event.reason)
          || event.detail !== undefined && (typeof event.detail !== "string" || event.detail.length > 2000)
          || event.at !== undefined && !Number.isFinite(event.at)))
      || chat.permissionMode !== undefined && !["protective", "ask", "read-only", "allow-all"].includes(chat.permissionMode)
      || chat.permissionContextId !== undefined && (typeof chat.permissionContextId !== "string" || !/^[a-f0-9]{64}$/.test(chat.permissionContextId))
      || chat.permissionGrants !== undefined && (!Array.isArray(chat.permissionGrants) || chat.permissionGrants.length > 512 || chat.permissionGrants.some(scope => scope !== "non-destructive" && !/^tool:[a-f0-9]{64}$/.test(scope)))
      || chat.lastResultId !== undefined && (typeof chat.lastResultId !== "string" || chat.lastResultId.length > 80)
      || chat.readResultId !== undefined && (typeof chat.readResultId !== "string" || chat.readResultId.length > 80)
      || chat.vscodeModelId !== undefined && typeof chat.vscodeModelId !== "string"
      || chat.vscodeModelLabel !== undefined && typeof chat.vscodeModelLabel !== "string"
      || chat.builtinTools && (!Array.isArray(chat.builtinTools) || chat.builtinTools.some(name => typeof name !== "string"))
      || chat.vscodeTools !== undefined && (!Array.isArray(chat.vscodeTools) || chat.vscodeTools.length > 512 || chat.vscodeTools.some(name => typeof name !== "string" || name.length > 200 || /[\u0000-\u001f\u007f]/.test(name)))
      || chat.toolSelection !== undefined && (!chat.toolSelection || [chat.toolSelection.disabledTools, chat.toolSelection.disabledSources].some(ids => !Array.isArray(ids) || ids.length > 4096 || ids.some(id => typeof id !== "string" || id.length > 1024 || /[\u0000-\u001f\u007f]/.test(id))))
      || chat.mcpServers && (!Array.isArray(chat.mcpServers) || chat.mcpServers.some(server => !server || typeof server.id !== "string" || typeof server.label !== "string" || typeof server.url !== "string" || typeof server.enabled !== "boolean" || !Array.isArray(server.tools) || server.tools.some(name => typeof name !== "string")))
      || chat.progress && !progressValid(chat.progress)) throw new Error("Unsupported chat history format.");
    chat.workspaceNamespace ||= path.basename(path.dirname(file));
    this.rememberQueue(chat);
    for (const message of chat.messages) if (recoverInterrupted && message.status === "streaming") {
      message.status = "interrupted";
      message.error = "The previous request was interrupted. Partial output was preserved.";
      for (const tool of message.toolCalls || []) if (tool.status === "running") { tool.status = "failed"; tool.result = "The request was interrupted. Execution may already have occurred."; }
    }
    if (recoverInterrupted && chat.progress?.status === "running") {
      chat.progress.status = "failed"; chat.progress.finishedAt = Date.parse(chat.updatedAt);
      if (chat.workerActivity) { chat.workerActivity.state = "interrupted"; delete chat.workerActivity.decision; }
    }
    for (const run of [chat.progress, ...chat.messages.map(message => message.progress)]) if (recoverInterrupted && run) {
      if (run.status === "running") { run.status = "failed"; run.finishedAt = Date.parse(chat.updatedAt); }
      for (const step of run.steps) if (["running", "waiting"].includes(step.status || "")) step.status = run.status === "complete" ? "complete" : run.status === "cancelled" ? "cancelled" : "failed";
    }
    this.validateImages(chat);
    return chat;
  }

  private validDelegationUrl(record: ChatDelegation): boolean {
    try {
      const locator = parsePkmLocator(record.chatUrl);
      return locator.kind === "chat" && locator.chatId === record.chatId && record.chatUrl === chatPkmUrl(locator.namespace, locator.chatId);
    } catch { return false; }
  }

  private validateImages(chat: ApiConversation): void {
    let bytes = 0;
    for (const images of [chat.images, ...chat.messages.map(message => message.images)]) {
      if (images === undefined) continue;
      if (!Array.isArray(images) || images.length > 2) throw new Error("At most two images per message or draft are supported.");
      for (const image of images) bytes += decodeChatImage(image).length;
    }
    if (bytes > 2 * 1024 * 1024) throw new Error("Stored images exceed 2 MB. Start a new chat.");
  }

    archiveWorker(chat: ApiConversation, record: ChatDelegation): void {
      withCrossProcessLockSync(path.join(this.stateDirectory, "api-chats", "chats.lock"), "Worker archive", () => {
        if (!fs.existsSync(this.file(chat.id))) {
          const archive = this.workerResult(record.id);
          if (archive.chat.id !== chat.id || archive.chat.workerActivity?.managerChatId !== chat.workerActivity?.managerChatId) throw new Error("Worker archive belongs to another activity.");
          this.library.forget(chat.id);
          return;
        }
        const current = this.load(chat.id, false);
        if (current.revision !== chat.revision || current.progress?.status === "running" || current.workerState?.sleeping
          || current.workerState?.events.length || current.queuedInputs?.length || current.messages.some(message => message.status === "streaming")
          || current.sessionId || current.workerActivity?.receiptId !== record.id || !current.workerActivity.temporary) throw new Error("Only a resolved, idle temporary worker without an explicit Task can be archived.");
        const directory = path.join(this.stateDirectory, "api-chat-worker-results");
        const file = path.join(directory, `${record.id}.json`);
        const snapshot = { schema: "pkm.chat.worker-result/v1", receiptId: record.id, managerChatId: current.workerActivity.managerChatId,
          archivedAt: new Date().toISOString(), chat: current };
        if (!fs.existsSync(file)) this.write(file, snapshot);
        else {
          const prior = JSON.parse(fs.readFileSync(file, "utf8"));
          if (prior.receiptId !== record.id || prior.chat?.revision !== current.revision) throw new Error("Worker archive conflicts with its saved evidence.");
        }
        const group = agentSessionGroup({ hostKind: "pkm", hostSessionId: current.id });
        const groupPath = path.join(this.stateDirectory, "agent-groups", `${group.groupId}.json`);
        if (fs.existsSync(groupPath)) fs.unlinkSync(groupPath);
        this.library.forget(current.id);
        fs.unlinkSync(this.file(current.id));
      });
    }

    hasWorkerResult(receiptId: string): boolean {
      if (!/^[a-f0-9-]{36}$/.test(receiptId)) throw new Error("Invalid worker receipt identity.");
      return fs.existsSync(path.join(this.stateDirectory, "api-chat-worker-results", `${receiptId}.json`));
    }

    workerResult(receiptId: string): { chat: ApiConversation; archivedAt: string } {
      if (!/^[a-f0-9-]{36}$/.test(receiptId)) throw new Error("Invalid worker receipt identity.");
      const file = path.join(this.stateDirectory, "api-chat-worker-results", `${receiptId}.json`);
      if (fs.statSync(file).size > 6_000_000) throw new Error("Worker archive exceeds its storage boundary.");
      const record = JSON.parse(fs.readFileSync(file, "utf8"));
      if (record.schema !== "pkm.chat.worker-result/v1" || record.receiptId !== receiptId || record.chat?.version !== 1) throw new Error("Invalid worker result archive.");
      return record;
    }

    requestWorkerStop(chatId: string, managerChatId: string, activityId: string, reason: string, attemptId: string): void {
      withCrossProcessLockSync(path.join(this.stateDirectory, "api-chats", "chats.lock"), "Worker stop", () => {
        const chat = this.load(chatId, false);
        if (chat.workerActivity?.id !== activityId || chat.workerActivity.managerChatId !== managerChatId || chat.workerActivity.attemptId !== attemptId
          || chat.workerActivity.state !== "running" && chat.workerActivity.state !== "waiting-input") throw new Error("The activity is stale or is not controlled by this manager.");
        this.write(path.join(this.stateDirectory, "api-chat-worker-controls", `${activityId}.json`), { activityId, attemptId, stopRequested: { reason: reason.slice(0, 500), at: Date.now() } });
      });
    }

    requestWorkerResponse(chatId: string, managerChatId: string, activityId: string, attemptId: string, episodeId: string, answer: string, decision: "continue" | "summarize"): void {
      withCrossProcessLockSync(path.join(this.stateDirectory, "api-chats", "chats.lock"), "Worker response", () => {
        const chat = this.load(chatId, false);
        const activity = chat.workerActivity;
        if (!activity || activity.id !== activityId || activity.managerChatId !== managerChatId || activity.attemptId !== attemptId
          || activity.decision?.episodeId !== episodeId || activity.decision.reason === "permission"
          || !answer.trim() || answer.length > 4000) throw new Error("The response is stale or cannot authorize this activity.");
        const prior = this.workerControl(activity);
        if (prior?.stopRequested) throw new Error("The activity already has a stop request.");
        this.write(path.join(this.stateDirectory, "api-chat-worker-controls", `${activityId}.json`), { activityId, attemptId, response: { episodeId, answer, decision } });
      });
    }

    workerControl(activity: WorkerActivity): { stopRequested?: { reason: string; at: number }; response?: { episodeId: string; answer: string; decision: "continue" | "summarize" } } | undefined {
      if (!validWorkerActivity(activity)) throw new Error("Invalid worker control activity.");
      const file = path.join(this.stateDirectory, "api-chat-worker-controls", `${activity.id}.json`);
      if (!fs.existsSync(file)) return undefined;
      if (fs.statSync(file).size > 20000) throw new Error("Worker control exceeds its storage boundary.");
      const control = JSON.parse(fs.readFileSync(file, "utf8"));
      if (control.activityId !== activity.id || control.attemptId !== activity.attemptId) return undefined;
      if (control.stopRequested && (typeof control.stopRequested.reason !== "string" || control.stopRequested.reason.length > 500 || !Number.isFinite(control.stopRequested.at))
        || control.response && (typeof control.response.answer !== "string" || control.response.answer.length > 4000 || !/^[a-f0-9-]{36}$/.test(control.response.episodeId) || !["continue", "summarize"].includes(control.response.decision))) throw new Error("Invalid persisted worker control.");
      return control;
    }
  private assertExecutionContext(executionContext: ChatExecutionContext): void {
    const identity = accountMcpIdentity();
    if (!validExecutionContext(executionContext) || executionContext.accountId !== identity.accountId || executionContext.targetId !== identity.targetId
      || fs.realpathSync(path.join(executionContext.knowledgeRoot, ".pkm", "state")) !== fs.realpathSync(this.stateDirectory)) {
      throw new Error("The request execution context does not belong to this account's Knowledge Root.");
    }
  }

  enqueueInput(chat: ApiConversation, input: QueuedChatInput): ApiConversation {
    return withCrossProcessLockSync(path.join(this.stateDirectory, "api-chats", "chats.lock"), "Chat history", () => {
      const current = this.load(chat.id, false);
      this.assertAvailable(current);
      if (!input.executionContext || !/^[a-f0-9-]{36}$/.test(input.id) || !input.text.trim() || input.text.length > 16_000 || !["steer", "task"].includes(input.mode)) throw new Error("Choose a valid input with sending-window context.");
      this.assertExecutionContext(input.executionContext);
      if (current.paused) throw new Error("This Chat is paused. Resume it before sending another request.");
      if (input.mode === "steer" && (current.progress?.status !== "running" || current.progress.executionContext?.digest !== input.executionContext.digest)) throw new Error("Steering belongs to a different execution context. Submit a separate task instead.");
      const prior = current.queuedInputs?.find(item => item.id === input.id) || current.messages.find(message => message.submissionId === input.id);
      if (prior) {
        const text = "text" in prior ? prior.text : prior.content;
        if (text !== input.text || prior.executionContext?.digest !== input.executionContext.digest) throw new Error("Submission identity was already used with different text or execution context.");
        return current;
      }
      if ((current.queuedInputs?.length || 0) >= 20) throw new Error("The Chat already has 20 queued inputs.");
      (current.queuedInputs ||= []).push({ ...input, ...(input.mode === "steer" ? { attemptId: current.progress?.attemptId } : {}) });
      current.updatedAt = new Date().toISOString();
      this.saveUnlocked(current, false);
      return current;
    });
  }

  assertRunnable(chat: ApiConversation, ownedAttemptId?: string, executionContext?: ChatExecutionContext): void {
    this.assertAvailable(chat);
    if (executionContext) this.assertExecutionContext(executionContext);
    const current = this.load(chat.id, false);
    if (ownedAttemptId && current.progress?.attemptId === ownedAttemptId) this.reconcileQueue(chat, current);
    if ((current.revision || 0) !== (chat.revision || 0)) throw new Error("This Chat changed in another window. Reopen it before sending a request.");
    if ((current.progress?.status === "running" || current.messages.some((message: ChatMessage) => message.status === "streaming")) && (!ownedAttemptId || current.progress?.attemptId !== ownedAttemptId)) throw new Error("This Chat is already running. Wait for its owning window to finish.");
    if (!executionContext && chat.workspaceNamespace && chat.workspaceNamespace !== this.namespace && ["read_file", "find_files", "search_text", "replace_text", "save_file", "run_process"].some(name => chat.toolSelection ? !chat.toolSelection.disabledSources.includes("builtin") && !chat.toolSelection.disabledTools.includes(`builtin:${name}`) : chat.builtinTools === undefined || chat.builtinTools.includes(name))) throw new Error("This Chat's file/process tools belong to another workspace. Open the original workspace or disable those tools.");
    if (chat.paused) throw new Error("This Chat is paused. Resume it before sending another request.");
    if (!chat.sessionId) return;
    const session = JSON.parse(fs.readFileSync(path.join(this.stateDirectory, "agent-sessions", `${chat.sessionId}.json`), "utf8"));
    if (agentSessionOrigin(session).origin !== "pkm-native") throw new Error("This Session is not owned by the PKM native runtime.");
    if (session.status === "completed") throw new Error("This Task is completed. Complete its Chat binding before sending another request.");
    if (chat.paused || session.nativeChat?.paused === true) throw new Error("This Session is paused. Resume it before sending another request.");
  }

  list(includeTrash = false): Array<{ id: string; workspaceNamespace: string; title: string; updatedAt: string; status: ApiChatStatus; groupId: string; trashedAt?: string; workerParentChatId?: string; workerTreeId?: string; workerManager?: boolean }> {
    const placements = this.library.read().placements;
    const chats: ReturnType<ApiChatStore["list"]> = [];
    for (const directory of this.directories()) for (const name of fs.readdirSync(directory)) {
      if (!/^[a-f0-9-]{36}\.json$/.test(name)) continue;
      try {
        const chat = this.load(name.slice(0, -5), false);
        const placement = placements[chat.id] || { groupId: "ungroup" };
        const sessionFile = chat.sessionId && path.join(this.stateDirectory, "agent-sessions", `${chat.sessionId}.json`);
        const session = sessionFile && fs.existsSync(sessionFile) ? JSON.parse(fs.readFileSync(sessionFile, "utf8")) : undefined;
        const stopped = session?.status === "stopped" && session.hostKind === "pkm" && session.hostSessionId === chat.id;
        if (includeTrash || !placement.trashedAt) chats.push({ id: chat.id, workspaceNamespace: chat.workspaceNamespace!, title: chat.title, updatedAt: chat.updatedAt, status: stopped ? "stopped" : apiChatStatus(chat), ...placement,
          ...(chat.messages.some(message => message.delegations?.length) ? { workerManager: true } : {}),
          ...(chat.workerState ? { workerTreeId: chat.workerState.treeId, ...(chat.workerState.parentChatId ? { workerParentChatId: chat.workerState.parentChatId } : {}) } : {}) });
      } catch {}
    }
    return chats.sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
  }

  trashChat(id: string): void {
    withCrossProcessLockSync(path.join(this.stateDirectory, "api-chats", "chats.lock"), "Chat history", () => {
      const chat = this.load(id, false);
      if (chat.progress?.status === "running" || chat.messages.some(message => message.status === "streaming")) throw new Error("Stop the running Chat before moving it to Trash.");
      this.library.trash(id);
    });
  }

  deleteChat(id: string): void {
    withCrossProcessLockSync(path.join(this.stateDirectory, "api-chats", "chats.lock"), "Chat history", () => {
      if (!this.library.read().placements[id]?.trashedAt) throw new Error("Move this Chat to Trash before permanently deleting it.");
      const chat = this.load(id, false);
      const group = agentSessionGroup({ sessionId: "", hostKind: "pkm", hostSessionId: id });
      const groupPath = path.join(this.stateDirectory, "agent-groups", `${group.groupId}.json`);
      const previous = fs.existsSync(groupPath) ? JSON.parse(fs.readFileSync(groupPath, "utf8")) : {};
      this.write(groupPath, { ...previous, schema: "pkm.agent.group/v1", groupId: group.groupId, hostKind: "pkm", hostSessionId: id,
        title: chat.title, deletedAt: new Date().toISOString() });
      fs.unlinkSync(this.file(id)); this.library.forget(id);
    });
  }

  restoreChat(id: string): void {
    withCrossProcessLockSync(path.join(this.stateDirectory, "api-chats", "chats.lock"), "Chat history", () => {
      this.load(id, false); this.library.restore(id);
    });
  }

  private directories(): string[] {
    const root = path.join(this.stateDirectory, "api-chats");
    if (!fs.existsSync(root)) return [];
    return fs.readdirSync(root).filter(name => /^[a-f0-9]{16}$/.test(name) && fs.lstatSync(path.join(root, name)).isDirectory()).map(name => path.join(root, name));
  }

  private file(id: string): string {
    if (!/^[a-f0-9-]{36}$/.test(id)) throw new Error("Invalid chat identity.");
    const matches = this.directories().map(directory => path.join(directory, `${id}.json`)).filter(file => fs.existsSync(file));
    if (matches.length > 1) throw new Error("Duplicate Chat identity across workspace stores.");
    if (matches.length) return matches[0];
    return path.join(this.directory, `${id}.json`);
  }

  private write(file: string, value: unknown): void {
    fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
    const temporary = `${file}.${randomUUID()}.tmp`;
    try {
      fs.writeFileSync(temporary, JSON.stringify(value), { encoding: "utf8", mode: 0o600, flag: "wx" });
      fs.renameSync(temporary, file);
    } finally { if (fs.existsSync(temporary)) fs.unlinkSync(temporary); }
  }
}

export function apiChatGroupSnapshots(stateDirectory: string) {
  const store = new ApiChatStore(stateDirectory, "0000000000000000");
  const groups = new Map(store.library.read().groups.map(group => [group.id, group.name]));
  return store.list(true).map(chat => ({
    groupId: agentSessionGroup({ sessionId: "", hostKind: "pkm", hostSessionId: chat.id }).groupId,
    hostKind: "pkm", hostSessionId: chat.id, title: chat.title, deletedAt: chat.trashedAt,
    libraryGroupId: groups.has(chat.groupId) ? chat.groupId : "ungroup",
    libraryGroupTitle: groups.get(chat.groupId) || "Ungroup",
    workerParentChatId: chat.workerParentChatId,
    workerTreeId: chat.workerTreeId,
  }));
}