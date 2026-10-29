import * as fs from "fs";
import { validPersonaSnapshot, type PersonaSnapshot } from "./persona-profiles";
import { classifyTaskProgress, type TaskProgressRecord } from "./task-progress";
import { validWorkGoal, type ChatWorkGoal } from "./chat-work-goal";
import * as path from "path";
import { createHash, randomUUID } from "crypto";
import { hostname } from "os";
import { agentSessionGroup } from "../agent-sessions/agent-session-lifecycle";
import { decodeChatImage } from "./api-chat-client";
import { ChatLibrary } from "./chat-library";
import { runChatLibraryWork, type ChatLibraryWork } from "./chat-library-worker";
import { validChatRetrievalReceipt, validChatRetrievalActivity } from "./chat-retrieval";
import { withCrossProcessLockSync } from "../runtime/cross-process-lock";
import { chatPkmUrl, parsePkmLocator } from "../knowledge/knowledge-locator";
import { ChatExecutionContext, validExecutionContext } from "./execution-context";
import { accountMcpIdentity } from "../mcp/mcp-account-binding";
import { WorkerTreeStore, ChatWorkerState, WorkerPhase, WorkerActivity, validWorkerActivity, workerIsDescendant } from "./worker-tree";
import { memoryPolicy, validMemoryPolicy, type ChatMemoryGrant } from "./chat-memory-policy";
import { validChatInvocationBudget } from "./chat-budget-ledger";
import { memoryTurnAccounting } from "../memory/memory-accounting";
import { ChatHistoryStorage, StoredChat } from "./chat-history-storage";
import { ExecutionProjection, projectExecution } from "../runtime/pkm-projection";
import { recordBaselineEvent, BaselineEventKind } from "../runtime/pkm-baseline";
import { recordedActionReferences } from "../runtime/native-harness-actions";
import { agentSnapshotRecovery, AgentSnapshotContents, AgentSnapshotSummary } from "../agent-sessions/agent-snapshots";
import { assertHarnessRecipeBinding, currentHarnessTaskState, HarnessBinding } from "./chat-harness-records";
import { copilotCreditSummary } from "./api-chat-models";
import { validTaskContextCheckpoint, type TaskContextCheckpoint } from "./task-context-checkpoint";
import { validPortalTaskLink, type PortalTaskLink } from "./portal-task-attempts";
import { validPortalCommandRecords } from "./portal-command-activity";
import { validPortalTransferRecords } from "./portal-transfer-activity";

export interface ChatContext { id: string; label: string; content: string; }
export interface QueuedChatInput { id: string; text: string; mode: "steer" | "task"; editToken?: string; attemptId?: string; executionContext?: ChatExecutionContext; portalReview?: PortalReview; }
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
  retryReason?: string;
  ownerPid?: number;
  ownerHost?: string;
  startedAt: number;
  finishedAt?: number;
  status: "running" | "complete" | "cancelled" | "failed";
  model: string;
  tools?: string[];
  droppedSteps?: number;
  completedDroppedSteps?: number;
  steps: Array<{ label: string; at: number; status?: "running" | "waiting" | "complete" | "cancelled" | "failed";
    kind?: "model" | "tool"; round?: number; toolCallId?: string; finishedAt?: number;
    category?: "llm" | "cmd" | "info"; operation?: "inference" | "token-count" | "model-access" | "retrieval" | "preparation" | "command" | "display" }>;
}
type ApiChatProgressStep = ApiChatProgress["steps"][number];

/**
 * Settles earlier steps before `next` is appended. Tool steps finish only on their own
 * Completed/Failed event, so approvals or other stages during a running tool cannot mark it complete.
 */
export function settleProgressSteps(steps: ApiChatProgressStep[], next: Pick<ApiChatProgressStep, "label" | "toolCallId" | "operation">, now = Date.now()): void {
  const previous = steps[steps.length - 1];
  if (previous && ["running", "waiting"].includes(previous.status || "") && !(previous.kind === "tool" && previous.toolCallId)
    && !(previous.operation === "inference" && next.operation === "token-count")) { previous.status = "complete"; previous.finishedAt = now; }
  const outcome = next.toolCallId && /^(Completed|Failed) tool:/.exec(next.label)?.[1];
  if (outcome) for (const step of steps) if (step.toolCallId === next.toolCallId && ["running", "waiting"].includes(step.status || "")) {
    step.status = outcome === "Failed" ? "failed" : "complete"; step.finishedAt = now;
  }
}

export interface ChatPlanningPossibility {
  id: string;
  parentId?: string;
  label: string;
  summary?: string;
  status: "candidate" | "selected" | "rejected" | "blocked" | "validated";
  recipeStageId?: string;
  reason?: string;
  evidenceRefs?: string[];
}
export interface ChatPlanningReceipt {
  schema: "pkm.chat.planning/v1";
  at: number;
  recipeRunId?: string;
  recipeStageId?: string;
  possibilities: ChatPlanningPossibility[];
}
/** Memory Engine context-preparation receipt for one reply; the post-reply commit receipt lives in the engine under `turn`. */
export interface ChatMemoryRecord {
  schema: "pkm.chat.memory/v1";
  turn: string;
  model?: string;
  durationMs?: number;
  blocks?: Array<{ kind: string; piece: string; characters: number }>;
  prepare?: Record<string, unknown>;
  error?: string;
}
export interface ChatMessage {
  profileContext?: PersonaSnapshot;
  profileRequirementRecall?: import("./user-profile-fragments").ProfileRequirementRecall;
  id: string;
  recordedAt?: string;
  executionContext?: ChatExecutionContext;
  taskId?: string;
  retrieval?: import("./chat-retrieval").ChatRetrievalReceipt;
  retrievalActivity?: import("./chat-retrieval").ChatRetrievalActivity;
  memory?: ChatMemoryRecord;
  planning?: ChatPlanningReceipt;
  harnessReports?: import("./chat-harness-records").HarnessReport[];
  budgetReceipts?: import("./chat-harness-records").HarnessBudgetReceipt[];
  invocationBudgets?: import("./chat-budget-ledger").ChatInvocationBudget[];
  publicOutputSegments?: Array<{ round:number; start:number; end:number; hasToolCalls?:boolean }>;
  reasoningSummaries?: Array<{ round: number; text: string }>;
  inputId?: string;
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
  portalSource?: import("../chatroom/portal-runtime").PortalSource;
  portalTask?: PortalTaskLink;
  portalReview?: PortalReview;
  delegationId?: string;
  delegations?: ChatDelegation[];
  submissionId?: string;
  inputKind?: "steer" | "task";
  inputOrigin?: "local-user" | "agent";
  workerEventIds?: string[];
  unattributedFileChanges?: boolean;
  elapsedMs?: number;
  usage?: import("./api-chat-models").ChatTokenUsage;
  auxiliaryModelUsage?: Array<{ usage?: import("./api-chat-models").ChatTokenUsage }>;
  retrievalLearning?: import("./chat-retrieval-learning").RetrievalLearningReceipt;
  usageMetadata?: { frames: number; validFrames: number; invalidFrames: number };
  estimatedCost?: number;
  currency?: string;
  contextWindow?: number;
  maxOutputTokens?: number;
  outputBudgetWarning?: string;
  changes?: import("./api-chat-tools").ApiChatEditChange[];
  toolCalls?: Array<{ id: string; name: string; arguments: string; status: "running" | "complete" | "failed"; result?: string;
    harnessBinding?: import("./chat-harness-records").HarnessBinding; startedAt?: number; finishedAt?: number }>;
}
export interface ApiConversation {
  agentProfileId?: string;
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
  debugRequest?: { inputId: string; status: "investigating" | "completed" | "blocked" | "needs_input"; goal: string; reason?: string; evidenceCallIds?: string[] };
  workGoal?: ChatWorkGoal;
  taskContextCheckpoints?: TaskContextCheckpoint[];
  memoryTasks?: Array<{ id: string; title: string; createdAt: string }>;
  context: ChatContext[];
  images?: import("./api-chat-client").ChatImage[];
  includeHistory: boolean;
  memoryPolicy?: import("./chat-memory-policy").ChatMemoryPolicy;
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
  portalCommands?: import("./portal-command-activity").PortalCommandRecord[];
  portalTransfers?: import("./portal-transfer-activity").PortalTransferRecord[];
}

export function chatHistoryPage(chat: ApiConversation, beforeId?: string) {
  const end = beforeId === undefined ? chat.messages.length : chat.messages.findIndex(message => message.id === beforeId);
  if (end < 0) throw new Error("The Chat history cursor is stale. Refresh the conversation before loading older messages.");
  let start = end;
  let bytes = 0;
  while (start > 0 && end - start < 20) {
    const next = Buffer.byteLength(JSON.stringify(chat.messages[start - 1]), "utf8");
    if (start < end && bytes + next > 512 * 1024) break;
    bytes += next; start--;
  }
  return { messages: chat.messages.slice(start, end), start, total: chat.messages.length };
}

export type ApiChatStatus = "running" | "idle" | "completed" | "new-result" | "awaiting-input" | "awaiting-result" | "paused" | "failed" | "stopped";

export function apiChatContextSummary(message: ChatMessage) {
  const budgets = message.budgetReceipts || [];
  const candidates = message.retrieval?.candidates || [];
  const selected = candidates.filter(candidate => candidate.selected);
  const kinds = new Map<string, number>();
  for (const candidate of selected) {
    const kind = candidate.kind.replace(/\b[a-f0-9]{64}\b/gi, "[hash]").slice(0, 64);
    kinds.set(kind, (kinds.get(kind) || 0) + 1);
  }
  return {
    roundCount: budgets.length,
    rounds: budgets.slice(-5).map(budget => ({
      round: budget.round, status: budget.status,
      estimatedInputTokens: budget.consumed.estimatedInputTokens,
      transportInputTokens: budget.transport?.inputTokens,
      countingMethod: budget.transport?.countingMethod || budget.countingMethod,
      transportAutomaticKnowledge: budget.transport?.automaticKnowledge ? {
        inputBudget: budget.transport.automaticKnowledge.inputBudget,
        inputTokens: budget.transport.automaticKnowledge.inputTokens,
        countingMethod: budget.transport.automaticKnowledge.countingMethod,
      } : undefined,
      selectedReferenceCount: budget.selectedReferenceIds.length,
      omittedReferenceCount: budget.contextPlan?.omittedIds.length || 0,
      unresolvedReferenceCount: budget.contextPlan?.unresolved.length || 0,
      stopReason: budget.contextPlan?.stopReason,
      automaticKnowledge: budget.contextPlan?.automaticKnowledge ? {
        inputBudget: budget.contextPlan.automaticKnowledge.inputBudget,
        estimatedBefore: budget.contextPlan.automaticKnowledge.estimatedBefore,
        estimatedAfter: budget.contextPlan.automaticKnowledge.estimatedAfter,
        countingMethod: budget.contextPlan.automaticKnowledge.countingMethod,
      } : undefined,
    })),
    omittedRounds: Math.max(0, budgets.length - 5),
    retrieval: { candidateCount: candidates.length, selectedCount: message.retrieval?.selectedCount || 0,
      selectedKinds: Object.fromEntries([...kinds].slice(0, 8)), omittedKinds: Math.max(0, kinds.size - 8),
      warningPresent: !!message.retrieval?.warning,
      onlineLearning:message.retrieval?.invocation?.onlineLearning,
    },
    learning:message.retrievalLearning ? {
      status:message.retrievalLearning.status, provenance:message.retrievalLearning.provenance,
      judgedSources:message.retrievalLearning.judgedSources, relevantSources:message.retrievalLearning.relevantSources,
      error:message.retrievalLearning.error, acknowledgment:message.retrievalLearning.acknowledgment,
    } : undefined,
    evidence: "Full source identities, hashes and manifests are retained locally in the Chat retrieval inspector; not included in this summary.",
  };
}

export function apiChatCreditUsage(message: ChatMessage | ChatMessage[]) {
  return copilotCreditSummary((Array.isArray(message) ? message : [message]).flatMap(item => {
    const receipts = item.budgetReceipts;
    const calls = receipts?.length
      ? receipts.filter(receipt => receipt.status === "sent" || receipt.ledger?.inferenceTiming || receipt.ledger?.providerUsage)
        .map(receipt => receipt.ledger?.providerUsage)
      : [item.usage];
    return [...calls, ...item.auxiliaryModelUsage?.map(call => call.usage) || []];
  }));
}

export function apiChatDiagnostics(chat: ApiConversation) {
  const tokenUsage = (usage: ChatMessage["usage"]) => usage && [usage.inputTokens, usage.outputTokens].every(value => Number.isSafeInteger(value) && value >= 0) ? {
    inputTokens: usage.inputTokens, outputTokens: usage.outputTokens,
    ...(Number.isSafeInteger(usage.cachedInputTokens) && usage.cachedInputTokens! >= 0 && usage.cachedInputTokens! <= usage.inputTokens ? { cachedInputTokens: usage.cachedInputTokens } : {}),
    ...(Number.isSafeInteger(usage.reasoningTokens) && usage.reasoningTokens! >= 0 && usage.reasoningTokens! <= usage.outputTokens ? { reasoningTokens: usage.reasoningTokens } : {}),
  } : undefined;
  const usageMetadata = (metadata: ChatMessage["usageMetadata"]) => metadata && [metadata.frames, metadata.validFrames, metadata.invalidFrames].every(value => Number.isSafeInteger(value) && value >= 0 && value <= 128) && metadata.validFrames + metadata.invalidFrames === metadata.frames
    ? { frames: metadata.frames, validFrames: metadata.validFrames, invalidFrames: metadata.invalidFrames } : undefined;
  const errorKind = (error = "") => /metadata/i.test(error) ? "provider-metadata" : /image/i.test(error) ? "image-response" : /empty response/i.test(error) ? "empty-response" : /tool calling/i.test(error) ? "tool-capability" : /timed out/i.test(error) ? "timeout" : /cancel|interrupted/i.test(error) ? "interrupted" : /budget|limit/i.test(error) ? "local-limit" : error ? "other" : undefined;
  const progress = (run: ApiChatProgress | undefined) => run && ({
    attemptId: run.attemptId, attempt: run.attempt, retryOf: run.retryOf,
    startedAt: run.startedAt, finishedAt: run.finishedAt, status: run.status, model: run.model,
    tools: run.tools?.slice(0, 80),
    droppedSteps: run.droppedSteps, completedDroppedSteps: run.completedDroppedSteps,
    stepCount: run.steps.length, omittedSteps: Math.max(0, run.steps.length - 12),
    steps: run.steps.slice(-12).map(step => ({ at: step.at, finishedAt: step.finishedAt, status: step.status, category:step.category, operation:step.operation,
      label: /^(Running|Completed|Failed) tool:/.test(step.label) ? step.label.split(":")[0] : /^Waiting/.test(step.label) ? "Waiting" : ["Preparing context", "Checking VS Code model access", "Requesting VS Code model", "Connecting to model API", "Generating response", "Receiving image"].includes(step.label) ? step.label : "Other activity" })),
  });
  return {
    schema: "pkm.chat.diagnostics/v1", sessionId: chat.sessionId, chatId: chat.id,
    provider: chat.modelProvider, modelId: chat.vscodeModelId || chat.modelProfileId,
    paused: chat.paused === true, permissionMode: chat.permissionMode || "protective",
    configuredBuiltinTools: (chat.builtinTools || []).slice(0, 32),
    configuredVscodeTools: (chat.vscodeTools || []).slice(0, 512),
    mcp: (chat.mcpServers || []).slice(0, 4).map(server => ({ enabled: server.enabled, allowedTools: server.tools.slice(0, 16) })),
    omittedAttempts: Math.max(0, chat.messages.filter(message => message.role === "assistant").length - 5),
    attempts: chat.messages.filter(message => message.role === "assistant").slice(-5).map(message => ({
      id: message.id, status: message.status, errorKind: errorKind(message.error), model: message.model,
      contextWindow: message.contextWindow, maxOutputTokens: message.maxOutputTokens, elapsedMs: message.elapsedMs,
      outputBudgetWarning: message.outputBudgetWarning,
      outputCharacters: message.content.length, imageCount: message.images?.length || 0,
      reportedTokenUsage: tokenUsage(message.usage), usageMetadata: usageMetadata(message.usageMetadata),
      reportedCredits: apiChatCreditUsage(message),
      context: apiChatContextSummary(message),
      tools: (message.toolCalls || []).slice(0, 128).map(tool => ({ name: tool.name, status: tool.status })),
      progress: progress(message.progress),
    })),
    latestProgress: progress(chat.progress),
    turnProgress: apiChatTurnProgress(chat),
  };
}

/** Read-only HAR-04 classification of the latest assistant turn; evidence is reduced to counts so paths and arguments never leave. */
export function apiChatTurnProgress(chat: ApiConversation, now = Date.now()) {
  const message = [...chat.messages].reverse().find(item => item.role === "assistant");
  if (!message) return undefined;
  const records: TaskProgressRecord[] = [];
  const startedAt = message.progress?.startedAt ?? (message.recordedAt ? Date.parse(message.recordedAt) : undefined);
  for (const call of message.toolCalls || []) {
    const at = call.finishedAt ?? call.startedAt ?? startedAt;
    if (!Number.isFinite(at)) continue;
    records.push({ at: at!, kind: "tool-call", call: { id: call.id, name: call.name, arguments: call.arguments, status: call.status, result: call.result } });
  }
  for (const change of message.changes || []) {
    const at = Date.parse(change.appliedAt);
    if (Number.isFinite(at)) records.push({ at, kind: "file", path: change.path });
  }
  const live = message.status === "streaming" ? chat.progress : undefined;
  const last = live?.steps[live.steps.length - 1];
  if (last?.status === "waiting" && Number.isFinite(last.at)) records.push({ at: last.at, kind: "wait", id: "current", reason: /approv|permission|authoriz/i.test(last.label) ? "approval" : "user", status: "pending" });
  const finishedAt = message.progress?.finishedAt;
  if (message.status === "complete" && Number.isFinite(finishedAt)) records.push({ at: finishedAt!, kind: "complete", detail: "Assistant turn completed" });
  try {
    const result = classifyTaskProgress(records, { now: message.status === "streaming" ? now : undefined, startedAt: Number.isFinite(startedAt) ? startedAt : undefined });
    const evidence: Record<string, number> = {};
    for (const item of result.evidence) evidence[item.kind] = (evidence[item.kind] || 0) + 1;
    return { scope: "latest-turn" as const, messageId: message.id, status: result.status, reasons: result.reasons, evidence };
  } catch (error) {
    return { scope: "latest-turn" as const, messageId: message.id, status: "unknown" as const, reasons: [`Progress classification unavailable: ${error instanceof Error ? error.message : String(error)}`], evidence: {} };
  }
}

export function apiChatSessionDiagnostics(record: Record<string, unknown>, sessionId: string, stateDirectory?: string) {
  const stored = record.nativeChat as StoredChat | undefined;
  if (stored?.messageHistory && !stateDirectory) throw new Error("Segmented Session diagnostics require the owning state directory.");
  const chat = stored ? new ChatHistoryStorage(stateDirectory || "").unpack(stored) : undefined;
  if (!/^agent_session_[a-f0-9]{32}$/.test(sessionId) || record.schema !== "pkm.agent.session/v1" || record.sessionId !== sessionId || agentSessionOrigin(record).origin !== "pkm-native" || record.hostKind !== "pkm" || chat?.version !== 1 || chat.sessionId !== sessionId || !Array.isArray(chat.messages)) throw new Error("A matching PKM-native Session record is required.");
  return { ...apiChatDiagnostics(chat), recordStatus: record.status, updatedAt: record.updatedAt };
}

export function apiChatHarnessSnapshot(chat: ApiConversation, fullResults = false) {
  const phase = (run?: ApiChatProgress) => {
    const current = run?.steps[run.steps.length - 1];
    const label = current?.label || "";
    const kind = !run || run.status !== "running" ? run?.status || "idle"
      : current?.status === "waiting" ? "waiting"
      : /retriev|context/i.test(label) ? "retrieval"
      : /tool/i.test(label) ? "tool"
      : /model|output|response|generat|connecting/i.test(label) ? "model"
      : "planning";
    return { kind, label: label || (run?.status === "running" ? "Preparing request" : run?.status || "Idle"), status: current?.status || run?.status || "idle" };
  };
  let input: ChatMessage | undefined;
  const attempts = chat.messages.flatMap(message => {
    if (message.role === "user") input = message;
    if (message.role !== "assistant") return [];
    const retrievalSteps = [
      ...(message.retrieval ? [{ kind: "selection", receipt: message.retrieval }] : []),
      ...(message.retrievalActivity?.attempts || []).map(attempt => ({ kind: `${attempt.kind}-recall`, at: attempt.at, durationMs: attempt.durationMs, receipt: attempt.receipt })),
      ...(message.retrievalActivity?.rounds || []).map(round => ({ kind: "sent-round", round: round.index, at: round.at, inputTokens: round.inputTokens, inputBudget: round.inputBudget, receipt: round.receipt })),
    ];
    return [{
      messageId: message.id, status: message.status, model: message.model || "",
      taskId: message.taskId, inputId: message.inputId || input?.id,
      attemptId: message.progress?.attemptId || message.id,
      attempt: message.progress?.attempt, retryOf: message.progress?.retryOf, retryReason:message.progress?.retryReason,
      harnessReports:message.harnessReports,
      budgetReceipts:message.budgetReceipts,
      invocationBudgets:message.invocationBudgets,
      response: message.content,
      publicOutputs:message.publicOutputSegments?.map(segment => ({
        ...segment, text:message.content.slice(segment.start, segment.end),
      })),
      reasoningSummaries: message.reasoningSummaries,
      profileContext: message.profileContext,
      profileRequirementRecall: message.profileRequirementRecall,
      associatedProblem: input?.content || "",
      problemSource: input?.workerEventIds?.length ? "worker-event" : input?.inputKind || "user-input",
      planning: message.planning ? {
        schema: message.planning.schema,
        at: message.planning.at,
        recipeRunId: message.planning.recipeRunId,
        recipeStageId: message.planning.recipeStageId,
        possibilities: message.planning.possibilities.map(possibility => ({
          id: possibility.id,
          parentId: possibility.parentId,
          label: possibility.label,
          summary: possibility.summary,
          status: possibility.status,
          recipeStageId: possibility.recipeStageId,
          reason: possibility.reason,
          evidenceRefs: possibility.evidenceRefs,
        })),
      } : undefined,
      progress: message.progress ? {
        status: message.progress.status, startedAt: message.progress.startedAt, finishedAt: message.progress.finishedAt,
        phase: phase(message.progress),
        droppedSteps: message.progress.droppedSteps || 0,
        transitions: message.progress.steps.map(step => ({ label: step.label, at: step.at, status: step.status || "recorded" })),
      } : undefined,
      retrieval: retrievalSteps.map(step => ({
        ...step,
        receipt: {
          schema: step.receipt.schema, query: step.receipt.query, selectedCount: step.receipt.selectedCount,
          model: step.receipt.model, phase: step.receipt.phase, warning: step.receipt.warning,
          candidates: step.receipt.candidates.map(candidate => ({ ...candidate })),
        },
      })),
      memory: message.memory ? {
        turn: message.memory.turn, model: message.memory.model, durationMs: message.memory.durationMs, error: message.memory.error,
        blocks: (message.memory.blocks || []).map(block => ({ ...block })),
        ...(message.memory.prepare?.schema === "pkm.memory.turn-receipt/v1" ? {
          accounting: memoryTurnAccounting(message.memory.prepare),
          calls: message.memory.prepare.calls,
        } : {}),
      } : undefined,
      toolCalls: (message.toolCalls || []).map(call => ({
        id: call.id, name: call.name, status: call.status,
        harnessBinding:call.harnessBinding, startedAt:call.startedAt, finishedAt:call.finishedAt,
        arguments: call.arguments,
        resultPreview: fullResults ? call.result || "" : (call.result || "").slice(0, 2_000),
        resultCharacters: (call.result || "").length,
        resultTruncated: !fullResults && (call.result || "").length > 2_000,
        actionRunIds: recordedActionReferences(call.result),
        associatedProblem: (input?.content || "").slice(0, 2_000),
        purposeEvidence: "associated-input",
      })),
      validation: {
        responseStatus: message.status,
        error: (message.error || "").slice(0, 2_000),
        outputBudgetWarning: (message.outputBudgetWarning || "").slice(0, 1_000),
        reportedUsage: message.usage,
        reportedCredits: apiChatCreditUsage(message),
      },
    }];
  });
  const latestUser = [...chat.messages].reverse().find(message => message.role === "user" && !message.workerEventIds?.length)
    || [...chat.messages].reverse().find(message => message.role === "user");
  const current = phase(chat.progress);
  const taskWorkingState = currentHarnessTaskState(chat);
  return {
    schema: "pkm.agent.harness/v1" as const,
    chatId: chat.id, sessionId: chat.sessionId, state: apiChatStatus(chat),
    currentPhase: current,
    currentProblem: latestUser?.content || "",
    currentProblemSource: latestUser?.workerEventIds?.length ? "worker-event" : latestUser?.inputKind || "user-input",
    ...(taskWorkingState ? { taskWorkingState } : {}),
    ...(chat.workGoal ? { workGoal: chat.workGoal } : {}),
    waiting: current.kind === "waiting" ? { kind: /answer|approval|input/i.test(current.label) ? "user" : "dependency", detail: current.label } : undefined,
    queuedInputs: (chat.queuedInputs || []).map(input => ({ id: input.id, mode: input.mode, text: input.text, ...(input.editToken ? { editToken: input.editToken } : {}) })),
    attempts,
  };
}

export function apiChatSessionHarnessSnapshot(record: Record<string, unknown>, sessionId: string, stateDirectory?: string, fullResults = false) {
  const stored = record.nativeChat as StoredChat | undefined;
  if (stored?.messageHistory && !stateDirectory) throw new Error("Segmented Session harness snapshots require the owning state directory.");
  const chat = stored ? new ChatHistoryStorage(stateDirectory || "").unpack(stored) : undefined;
  if (!/^agent_session_[a-f0-9]{32}$/.test(sessionId) || record.schema !== "pkm.agent.session/v1" || record.sessionId !== sessionId || agentSessionOrigin(record).origin !== "pkm-native" || record.hostKind !== "pkm" || chat?.version !== 1 || chat.sessionId !== sessionId || !Array.isArray(chat.messages)) throw new Error("A matching PKM-native Session record is required.");
  return apiChatHarnessSnapshot(chat, fullResults);
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

export function apiChatProjection(chat: ApiConversation, approvalRequired = false): ExecutionProjection {
  return projectExecution("chat-worker", chat.workerActivity?.state || apiChatStatus(chat), {
    approvalRequired, interrupted: chat.workerActivity?.state === "interrupted"
      || chat.progress?.status !== "running" && chat.messages[chat.messages.length - 1]?.status === "interrupted",
    waiting: chat.workerState?.sleeping || undefined,
    ...(apiChatStatus(chat) === "awaiting-input" ? { nextOwner: "user" as const } : {}),
  });
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
  private readonly history: ChatHistoryStorage;
  private readonly queueSnapshots = new WeakMap<ApiConversation, { fingerprint: string; inputs: QueuedChatInput[] }>();

  private rememberQueue(chat: ApiConversation): void {
    const { revision, updatedAt, queuedInputs, ...state } = chat;
    this.queueSnapshots.set(chat, { fingerprint: JSON.stringify(state), inputs: JSON.parse(JSON.stringify(queuedInputs || [])) });
  }

  private reconcileQueue(chat: ApiConversation, current: ApiConversation): void {
    const snapshot = this.queueSnapshots.get(chat);
    const local = chat.queuedInputs || [];
    const removed = new Set((snapshot?.inputs || []).filter(input => !local.some(item => item.id === input.id)).map(input => input.id));
    for (const input of current.queuedInputs || []) if (removed.has(input.id)) {
      const previous = snapshot?.inputs.find(item => item.id === input.id);
      if (input.editToken || previous?.text !== input.text) throw new Error("Queued input was edited before consumption. It remains queued; finish editing before continuing.");
    }
    if ((current.revision || 0) === (chat.revision || 0)) return;
    const { revision, updatedAt, queuedInputs, ...state } = current;
    if (!snapshot || JSON.stringify(state) !== snapshot.fingerprint || current.progress?.status !== "running"
      || !chat.progress?.attemptId || current.progress.attemptId !== chat.progress.attemptId
      || current.progress.ownerPid !== process.pid || current.progress.ownerHost !== hostname()) return;
    const merged = (queuedInputs || []).filter(input => !removed.has(input.id));
    for (const input of local.filter(input => !snapshot.inputs.some(item => item.id === input.id))) {
      if (!merged.some(item => item.id === input.id)) merged.push(input);
    }
    if (merged.length > 20) throw new Error("The Chat already has 20 queued inputs.");
    chat.queuedInputs = merged;
    chat.revision = current.revision;
    this.queueSnapshots.set(chat, { fingerprint: JSON.stringify(state), inputs: JSON.parse(JSON.stringify(queuedInputs || [])) });
  }

  constructor(private readonly stateDirectory: string, readonly namespace: string, private readonly baselineEnabled: () => boolean = () => false,
    private readonly baselineDirectory = stateDirectory) {
    if (!/^[a-f0-9]{16}$/.test(namespace)) throw new Error("Invalid workspace namespace.");
    this.directory = path.join(stateDirectory, "api-chats", namespace);
    this.library = new ChatLibrary(path.join(stateDirectory, "api-chats"));
    this.workerTrees = new WorkerTreeStore(path.join(stateDirectory, "api-chat-worker-trees"));
    this.history = new ChatHistoryStorage(stateDirectory);
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

  memorySourceIds(chat: ApiConversation): string[] {
    if (!chat.includeHistory) return [];
    const policy = memoryPolicy(chat);
    const sources = new Set(policy.grants.flatMap(grant => grant.chatIds));
    if (policy.includeWorkers) for (const slot of this.memoryWorkerSlots(chat)) sources.add(slot.chatId);
    sources.delete(chat.id);
    for (const id of policy.excludedChatIds) sources.delete(id);
    return [...sources];
  }

  private memoryWorkerSlots(chat: ApiConversation) {
    const ids = new Set([chat.workerActivity?.treeId, chat.workerState?.treeId].filter((id): id is string => !!id));
    return [...ids].flatMap(treeId => {
      const slots = this.workerTrees.members(treeId);
      if (this.workerTrees.rootChatId(treeId) !== chat.id && !slots.some(slot => slot.chatId === chat.id)) throw new Error("The Chat does not own its recorded worker lineage.");
      const spawned = slots.filter(slot => slot.temporary !== false);
      return spawned.filter(slot => workerIsDescendant(spawned, chat.id, slot.chatId, true)).map(slot => ({ ...slot, treeId }));
    });
  }

  loadMemorySource(owner: ApiConversation, id: string): ApiConversation | undefined {
    if (this.library.read().placements[id]?.trashedAt) return undefined;
    let source:ApiConversation | undefined;
    try { source = this.load(id, false); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
    const policy = memoryPolicy(owner);
    const explicit = policy.grants.some(grant => grant.chatIds.includes(id));
    const slot = policy.includeWorkers ? this.memoryWorkerSlots(owner).find(slot => slot.chatId === id) : undefined;
    if (!source && slot && this.hasWorkerResult(slot.receiptId)) source = this.workerResult(slot.receiptId).chat;
    if (source && id !== owner.id && !explicit) {
      const activity = source.workerActivity, state = source.workerState;
      if (!slot || source.id !== id || !(activity?.temporary && activity.receiptId === slot.receiptId
        && activity.treeId === slot.treeId && activity.managerChatId === slot.parentChatId)
        && !(state?.receiptId === slot.receiptId && state.treeId === slot.treeId && state.parentChatId === slot.parentChatId)) {
        throw new Error("The memory source does not match its spawned-worker receipt and lineage.");
      }
    }
    return source;
  }

  memoryScopeChoices(): Array<ChatMemoryGrant & { label:string }> {
    const choices = new Map<string, ChatMemoryGrant & { label:string }>();
    const add = (kind:ChatMemoryGrant["kind"], id:string, label:string, chatId:string) => {
      const key = `${kind}:${id}`;
      const entry = choices.get(key) || { kind, id, label, chatIds:[] };
      entry.chatIds.push(chatId); choices.set(key, entry);
    };
    for (const item of this.list()) {
      add("chat", item.id, item.title, item.id);
      add("workspace", item.workspaceNamespace, `Workspace ${item.workspaceNamespace}`, item.id);
      const groupId = agentSessionGroup({ sessionId:"", hostKind:"pkm", hostSessionId:item.id }).groupId;
      add("group", groupId, `Runtime Group: ${item.title}`, item.id);
      const chat = this.load(item.id, false);
      if (!chat.sessionId) continue;
      const file = path.join(this.stateDirectory, "agent-sessions", `${chat.sessionId}.json`);
      if (!fs.existsSync(file)) continue;
      const session = JSON.parse(fs.readFileSync(file, "utf8"));
      if (session.schema !== "pkm.agent.session/v1" || session.sessionId !== chat.sessionId
        || session.hostKind !== "pkm" || session.hostSessionId !== chat.id) throw new Error("Memory scope Session ownership is invalid.");
      if (typeof session.projectId === "string" && session.projectId) add("project", session.projectId, `Project ${session.projectId}`, item.id);
    }
    return [...choices.values()];
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

  /**
   * Recovers an Agent Snapshot into a new PKM Chat with its own Task. PKM Snapshots restore the conversation
   * and clone Recipe runs; Snapshots from retired external agents restore task, todos and checkpoints only.
   */
  recoverAgentSnapshot(snapshot: Pick<AgentSnapshotSummary, "snapshotId" | "magicCode" | "sourceSessionId" | "name" | "task">, contents: AgentSnapshotContents): ApiConversation {
    const source = contents.session as any;
    const native = source.origin === "pkm-native" && source.nativeChat && typeof source.nativeChat === "object" ? source.nativeChat : undefined;
    const title = String(snapshot.name || snapshot.task || source.task || "Recovered Snapshot").replace(/[\u0000-\u001f\u007f]/g, " ").trim().slice(0, 100) || "Recovered Snapshot";
    const chat = this.create();
    const created: string[] = [];
    let sessionPath = "";
    try {
      chat.title = `${title} (recovered)`.slice(0, 120); chat.customTitle = true;
      if (native) {
        for (const field of ["modelProvider", "vscodeModelId", "vscodeModelLabel", "modelProfileId", "contextWindow", "maxOutputTokens", "includeHistory"] as const) {
          if (native[field] !== undefined) (chat as any)[field] = native[field];
        }
        chat.messages = (Array.isArray(native.messages) ? native.messages : []).filter((message: any) => message && typeof message.id === "string" && ["user", "assistant"].includes(message.role)).map((original: any) => {
          const { delegations: _delegations, workerEventIds: _events, delegationId: _delegation, ...message } = JSON.parse(JSON.stringify(original));
          if (message.status === "streaming") message.status = "interrupted";
          if (Array.isArray(message.toolCalls)) message.toolCalls = message.toolCalls.map((call: any) => call.status === "running" ? { ...call, status: "failed", result: call.result || "Interrupted before the Snapshot was recovered." } : call);
          return message as ChatMessage;
        });
      }
      this.save(chat);
      this.startTask(chat, title);
      const sessionId = chat.sessionId!;
      sessionPath = path.join(this.stateDirectory, "agent-sessions", `${sessionId}.json`);
      const recovery = agentSnapshotRecovery(contents, snapshot, sessionId);
      recovery.recipeRuns.forEach(run => {
        const file = path.join(this.stateDirectory, "recipe-runs", `${run.runId}.json`);
        fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
        fs.writeFileSync(file, JSON.stringify(run), { encoding: "utf8", mode: 0o600, flag: "wx" });
        created.push(file);
      });
      this.write(sessionPath, { ...JSON.parse(fs.readFileSync(sessionPath, "utf8")), ...recovery.session });
      const todos = recovery.session.todos as Array<{ title?: string; status?: string }>;
      const open = todos.filter(todo => !["succeeded", "skipped", "failed"].includes(String(todo.status)));
      const checkpoint = (recovery.session.checkpoints as any[]).slice(-1)[0];
      const summary = String(checkpoint?.state?.summary || "").trim();
      for (const message of chat.messages) if (message.taskId) message.taskId = sessionId;
      chat.messages.push({ id: randomUUID(), role: "assistant", status: "complete", taskId: sessionId, recordedAt: new Date().toISOString(),
        content: [`Recovered Agent Snapshot \`${snapshot.magicCode}\` into this new PKM Chat Task.`,
          native ? `Restored ${chat.messages.length} earlier message(s) and ${recovery.recipeRuns.length} Recipe run(s).` : "The Snapshot came from an external agent, so only its task, todos and checkpoints were restored (it has no conversation or Recipes).",
          summary ? `Latest checkpoint: ${summary.slice(0, 2000)}` : "",
          open.length ? `Unfinished todos:\n${open.slice(0, 20).map(todo => `- ${todo.title || "Untitled"}`).join("\n")}` : "",
          "Send a message to continue from here."].filter(Boolean).join("\n\n") });
      chat.updatedAt = new Date().toISOString();
      this.save(chat);
    } catch (error) {
      // Recovery is all-or-nothing: remove everything this attempt wrote so a retry leaves no orphaned Chat or Task.
      for (const file of created) fs.rmSync(file, { force: true });
      if (sessionPath) fs.rmSync(sessionPath, { force: true });
      try { this.library.trash(chat.id); this.deleteChat(chat.id); } catch { /* The original error is more useful than a cleanup failure. */ }
      throw error;
    }
    return chat;
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

  bindRecordedRecipe(chat: ApiConversation, binding: HarnessBinding): void {
    const runId = binding.recipeRunId;
    if (!runId) return;
    if (!/^agent_session_[a-f0-9]{32}$/.test(chat.sessionId || "")) throw new Error("A managed Task is required for Recipe binding.");
    withCrossProcessLockSync(path.join(this.stateDirectory, "api-chats", "chats.lock"), "Chat history", () => {
      this.assertAvailable(chat);
      const filename = path.join(this.stateDirectory, "agent-sessions", `${chat.sessionId}.json`);
      const session = JSON.parse(fs.readFileSync(filename, "utf8"));
      if (session.schema !== "pkm.agent.session/v1" || session.sessionId !== chat.sessionId
        || session.origin !== "pkm-native" || session.runtimeOwner !== "pkm" || session.hostSessionId !== chat.id) throw new Error("The native Task's Recipe authority is unavailable.");
      const read = (id: string): Record<string, unknown> => {
        if (!/^recipe_run_[A-Za-z0-9_-]+$/.test(id)) throw new Error("Invalid Recipe Run identity.");
        return JSON.parse(fs.readFileSync(path.join(this.stateDirectory, "recipe-runs", `${id}.json`), "utf8"));
      };
      const owned: string[] = session.recipeRunIds || [];
      let id = runId;
      const seen = new Set<string>();
      while (!owned.includes(id)) {
        if (seen.has(id)) throw new Error("Cyclic Recipe ownership.");
        seen.add(id);
        const run = read(id);
        const parent = run.parent as { runId?: string; nodeId?: string } | undefined;
        if (!parent?.runId) break;
        id = parent.runId;
      }
      if (!owned.includes(id)) {
        const run = read(id);
        const receipts = run.receipts as Record<string, { response?: string | { run_id?: string } }> | undefined;
        const createdHere = chat.messages.filter(message => message.taskId === chat.sessionId && message.role === "assistant")
          .some(message => (message.toolCalls || []).some(call => {
            if (call.status !== "complete" || !call.result) return false;
            let args: Record<string, unknown>, result: Record<string, unknown>;
            try {
              args = JSON.parse(call.arguments);
              const envelope = JSON.parse(call.result);
              if (!envelope || typeof envelope !== "object") return false;
              const text = Array.isArray(envelope.content) ? envelope.content.find((part: { type?: string } | null) => part?.type === "text")?.text : undefined;
              result = envelope.structuredContent || (text ? JSON.parse(text) : envelope);
            } catch (error) { if (error instanceof SyntaxError) return false; throw error; }
            const command = args?.command_id;
            const receipt = typeof command === "string" ? receipts?.[command]?.response : undefined;
            const recorded = typeof receipt === "string" ? JSON.parse(receipt) : receipt;
            return typeof command === "string" && result?.ok === true && result.run_id === id && result.replayed !== true
              && id === `recipe_run_${createHash("sha256").update(command).digest("hex").slice(0, 24)}`
              && recorded?.run_id === id;
          }));
        if (!createdHere) throw new Error("Recipe Run is not owned by this Task and has no original creation receipt in this Task.");
      }
      const roots = [...new Set([...owned, id])];
      assertHarnessRecipeBinding(binding, { ...session, recipeRunIds: roots }, read);
      if (!owned.includes(id)) this.write(filename, { ...session, recipeRunIds: roots });
    });
  }

  private saveUnlocked(chat: ApiConversation, initializeSession: boolean, taskTitle?: string): void {
    if (this.library.read().placements[chat.id]?.trashedAt) throw new Error("Restore this Chat from Trash before changing it.");
    this.validateImages(chat);
    const file = this.file(chat.id);
    if (!fs.existsSync(file) && chat.revision !== undefined) throw new Error("This Chat was deleted in another window. Choose another Chat.");
    const previousChat = fs.existsSync(file) ? this.load(chat.id, false) : undefined;
    if (chat.agentProfileId !== undefined && (typeof chat.agentProfileId !== "string" || !/^[a-f0-9-]{36}$/.test(chat.agentProfileId))) throw new Error("Invalid Agent Profile assignment.");
    const previousProfiles = new Map(previousChat?.messages.filter(message => message.profileContext).map(message => [message.id, message.profileContext]));
    for (const message of chat.messages) {
      if (message.profileContext !== undefined && !validPersonaSnapshot(message.profileContext)) throw new Error("Invalid Profile snapshot.");
      const previousProfile = previousProfiles.get(message.id);
      if (previousProfile && JSON.stringify(previousProfile) !== JSON.stringify(message.profileContext)) {
        throw new Error("Historical attempt Profile snapshots are immutable.");
      }
    }
    if (previousChat) this.reconcileQueue(chat, previousChat);
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
    const snapshot = this.history.pack({ ...chat, revision }, { status: apiChatStatus(chat), workerManager: chat.messages.some(message => !!message.delegations?.length) });
    this.write(file, snapshot); chat.revision = revision;
    this.measureTransition(previousChat, chat);
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
      nativeChat: snapshot,
      liveness: { heartbeatAt: new Date().toISOString(), leaseSeconds: 300, owner: { hostSessionId: chat.id } },
    });
  }

  private measureTransition(previous: ApiConversation | undefined, chat: ApiConversation): void {
    const record = (kind: BaselineEventKind, durationMs?: number) => recordBaselineEvent(this.baselineDirectory, this.baselineEnabled(), {
      kind, source: "chat-worker", evidence: "observed", ...(durationMs !== undefined ? { durationMs } : {}),
    });
    if (!previous) record("chat-created");
    const current = chat.progress, old = previous?.progress;
    if (current?.status === "running" && (old?.status !== "running" || old.startedAt !== current.startedAt)) {
      record("start-request"); record("start-success");
    }
    if (current && current.status !== "running" && old?.status === "running") {
      const duration = current.finishedAt === undefined ? undefined : Math.max(0, current.finishedAt - current.startedAt);
      if (current.status === "cancelled") record("cancel", duration);
      else if (current.status === "complete") record("completed", duration);
      else if (current.status === "failed") record("failed", duration);
    }
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
    const observed = chat.progress;
    if (observed?.status !== "running" || observed.ownerHost !== hostname() || !observed.ownerPid || observed.ownerPid === process.pid) return false;
    return withCrossProcessLockSync(path.join(this.stateDirectory, "api-chats", "chats.lock"), "Chat history", () => {
      const current = this.load(chat.id, false);
      const owner = current.progress;
      if (current.revision !== chat.revision || owner?.status !== "running" || owner.ownerHost !== hostname() || !owner.ownerPid || owner.ownerPid === process.pid || this.library.read().placements[chat.id]?.trashedAt) return false;
      try { process.kill(owner.ownerPid, 0); return false; }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== "ESRCH") return false; }
      const recovered = this.load(chat.id, true);
      this.saveUnlocked(recovered, false);
      recordBaselineEvent(this.baselineDirectory, this.baselineEnabled(), { kind: "restart-observed", source: "chat-worker", evidence: "observed" });
      Object.assign(chat, recovered);
      return true;
    });
  }

  private readonly loadedFiles = new WeakMap<ApiConversation, { file: string; stamp: string }>();

  reloadIfChanged(chat: ApiConversation): ApiConversation {
    const previous = this.loadedFiles.get(chat);
    const file = this.file(chat.id);
    if (previous?.file === file && previous.stamp === ApiChatStore.fileStamp(file)) return chat;
    const latest = this.load(chat.id, false);
    const validated = this.loadedFiles.get(latest);
    // The controller keeps its in-memory object when the revision is unchanged.
    if (validated && latest.revision === chat.revision) this.loadedFiles.set(chat, validated);
    return latest;
  }

  load(id: string, recoverInterrupted = true): ApiConversation {
    const file = this.file(id);
    const before = !recoverInterrupted ? ApiChatStore.fileStamp(file) : undefined;
    const chat = this.history.unpack(JSON.parse(fs.readFileSync(file, "utf8")) as StoredChat);
    const contextsValid = (items: ChatContext[]) => Array.isArray(items) && items.every(item => item && typeof item.id === "string" && typeof item.label === "string" && typeof item.content === "string");
    const progressValid = (run: ApiChatProgress) => run && Number.isFinite(run.startedAt) && (run.finishedAt === undefined || Number.isFinite(run.finishedAt)) && ["running", "complete", "cancelled", "failed"].includes(run.status) && typeof run.model === "string"
      && (run.executionContext === undefined || validExecutionContext(run.executionContext))
      && (run.ownerPid === undefined || Number.isSafeInteger(run.ownerPid) && run.ownerPid > 0 && run.ownerPid <= 2147483647) && (run.ownerHost === undefined || typeof run.ownerHost === "string" && run.ownerHost.length <= 256)
      && (run.attemptId === undefined || typeof run.attemptId === "string" && run.attemptId.length <= 80) && (run.retryOf === undefined || typeof run.retryOf === "string" && run.retryOf.length <= 80)
      && (run.attempt === undefined || Number.isSafeInteger(run.attempt) && run.attempt > 0) && (run.tools === undefined || Array.isArray(run.tools) && run.tools.every(name => typeof name === "string" && name.length <= 200))
      && (run.droppedSteps === undefined || Number.isSafeInteger(run.droppedSteps) && run.droppedSteps >= 0)
      && (run.completedDroppedSteps === undefined || Number.isSafeInteger(run.completedDroppedSteps) && run.completedDroppedSteps >= 0 && run.completedDroppedSteps <= (run.droppedSteps || 0))
      && Array.isArray(run.steps) && run.steps.length <= 512 && run.steps.every(step => step && typeof step.label === "string" && Number.isFinite(step.at)
        && (step.status === undefined || ["running", "waiting", "complete", "cancelled", "failed"].includes(step.status))
        && (step.kind === undefined || ["model", "tool"].includes(step.kind))
        && (step.finishedAt === undefined || Number.isFinite(step.finishedAt) && step.finishedAt >= step.at)
        && (step.category === undefined || ["llm", "cmd", "info"].includes(step.category))
        && (step.operation === undefined || ["inference", "token-count", "model-access", "retrieval", "preparation", "command", "display"].includes(step.operation))
        && (step.round === undefined || Number.isSafeInteger(step.round) && step.round >= 0)
        && (step.toolCallId === undefined || typeof step.toolCallId === "string" && step.toolCallId.length > 0 && step.toolCallId.length <= 200));
    const changesValid = (items: NonNullable<ChatMessage["changes"]>) => Array.isArray(items) && items.length <= 4096 && items.every(item => item && typeof item.path === "string" && item.path.length <= 4096 && Number.isSafeInteger(item.workspace) && item.workspace >= 0 && typeof item.appliedAt === "string" && Number.isFinite(Date.parse(item.appliedAt)) && /^[a-f0-9]{64}$/.test(item.beforeHash) && /^[a-f0-9]{64}$/.test(item.afterHash) && item.saved === false && ["exact", "unknown"].includes(item.attribution) && (item.attribution !== "exact" || Number.isSafeInteger(item.added) && item.added! >= 0 && Number.isSafeInteger(item.removed) && item.removed! >= 0));
    if (!chat || chat.version !== 1 || chat.id !== id || chat.sessionId !== undefined && !/^agent_session_[a-f0-9]{32}$/.test(chat.sessionId) || typeof chat.title !== "string" || typeof chat.updatedAt !== "string" || !Number.isFinite(Date.parse(chat.updatedAt)) || typeof chat.createdAt !== "string" || !Number.isFinite(Date.parse(chat.createdAt)) || typeof chat.includeHistory !== "boolean" || !Array.isArray(chat.messages) || !contextsValid(chat.context)
      || chat.memoryPolicy !== undefined && !validMemoryPolicy(chat.memoryPolicy)
      || chat.taskContextCheckpoints !== undefined && (!Array.isArray(chat.taskContextCheckpoints) || chat.taskContextCheckpoints.length > 128
        || chat.taskContextCheckpoints.some(item => !validTaskContextCheckpoint(item, chat.id)))
      || chat.agentProfileId !== undefined && (typeof chat.agentProfileId !== "string" || !/^[a-f0-9-]{36}$/.test(chat.agentProfileId))
      || chat.messages.some(message => !message || typeof message.id !== "string" || typeof message.content !== "string" || !["user", "assistant"].includes(message.role) || !["complete", "streaming", "cancelled", "failed", "interrupted"].includes(message.status)
        || message.recordedAt !== undefined && (typeof message.recordedAt !== "string" || !Number.isFinite(Date.parse(message.recordedAt)))
        || message.executionContext !== undefined && !validExecutionContext(message.executionContext)
        || message.profileContext !== undefined && !validPersonaSnapshot(message.profileContext)
        || message.portalSource !== undefined && !validPortalSource(message.portalSource)
        || message.portalTask !== undefined && (message.role !== "assistant" || !validPortalTaskLink(message.portalTask))
        || message.portalReview !== undefined && !validPortalReview(message.portalReview)
        || message.inputOrigin !== undefined && !["local-user", "agent"].includes(message.inputOrigin)
        || message.taskId !== undefined && (typeof message.taskId !== "string" || message.taskId.length > 128)
        || message.retrieval !== undefined && !validChatRetrievalReceipt(message.retrieval, chat.id)
        || message.retrievalActivity !== undefined && !validChatRetrievalActivity(message.retrievalActivity, chat.id)
        || message.invocationBudgets !== undefined && (!Array.isArray(message.invocationBudgets)
          || message.invocationBudgets.some(item => !validChatInvocationBudget(item))
          || new Set(message.invocationBudgets.map(item => item.id)).size !== message.invocationBudgets.length)
        || message.memory !== undefined && (typeof message.memory !== "object" || message.memory === null || message.memory.schema !== "pkm.chat.memory/v1" || typeof message.memory.turn !== "string")
        || message.progress !== undefined && !progressValid(message.progress)
        || message.reasoningSummaries !== undefined && (!Array.isArray(message.reasoningSummaries)
          || message.reasoningSummaries.length > 1000
          || message.reasoningSummaries.some(item => !item || !Number.isSafeInteger(item.round) || item.round < 0 || typeof item.text !== "string")
          || message.reasoningSummaries.reduce((size, item) => size + item.text.length, 0) > 16000)
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
      || chat.queuedInputs !== undefined && (!Array.isArray(chat.queuedInputs) || chat.queuedInputs.length > 20 || chat.queuedInputs.some(input => !input || typeof input.id !== "string" || !/^[a-f0-9-]{36}$/.test(input.id) || typeof input.text !== "string" || !input.text.trim() || input.text.length > 16_000 || !["steer", "task"].includes(input.mode) || input.editToken !== undefined && (typeof input.editToken !== "string" || !/^[a-f0-9-]{36}$/.test(input.editToken)) || input.attemptId !== undefined && (typeof input.attemptId !== "string" || input.attemptId.length > 80) || input.executionContext !== undefined && !validExecutionContext(input.executionContext) || input.portalReview !== undefined && !validPortalReview(input.portalReview)) || new Set(chat.queuedInputs.map(input => input.id)).size !== chat.queuedInputs.length)
      || chat.workGoal !== undefined && !validWorkGoal(chat.workGoal)
      || chat.debugRequest !== undefined && (!chat.debugRequest || typeof chat.debugRequest.inputId !== "string"
        || !["investigating", "completed", "blocked", "needs_input"].includes(chat.debugRequest.status)
        || typeof chat.debugRequest.goal !== "string" || chat.debugRequest.goal.length > 16_000
        || chat.debugRequest.reason !== undefined && (typeof chat.debugRequest.reason !== "string" || chat.debugRequest.reason.length > 2000)
        || chat.debugRequest.evidenceCallIds !== undefined && (!Array.isArray(chat.debugRequest.evidenceCallIds)
          || chat.debugRequest.evidenceCallIds.length > 32 || chat.debugRequest.evidenceCallIds.some(id => typeof id !== "string" || id.length > 200)))
      || chat.memoryTasks !== undefined && (!Array.isArray(chat.memoryTasks) || chat.memoryTasks.length > 4096 || chat.memoryTasks.some(task => !task || typeof task.id !== "string" || task.id.length > 128 || typeof task.title !== "string" || task.title.length > 512 || typeof task.createdAt !== "string" || !Number.isFinite(Date.parse(task.createdAt))))
      || chat.paused !== undefined && typeof chat.paused !== "boolean"
      || chat.portalCommands !== undefined && !validPortalCommandRecords(chat.portalCommands)
      || chat.portalTransfers !== undefined && !validPortalTransferRecords(chat.portalTransfers)
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
    if (recoverInterrupted && chat.workGoal?.status === "active") {
      chat.workGoal.status = "interrupted";
      chat.workGoal.reason = "The previous host stopped before the objective was settled. Explicitly resume and reconcile recorded effects before continuing.";
    }
    for (const message of chat.messages) if (recoverInterrupted && message.status === "streaming") {
      message.status = "interrupted";
      message.error = "The previous request was interrupted. Partial output was preserved.";
      const ledger = message.budgetReceipts?.[message.budgetReceipts.length - 1]?.ledger;
      if (ledger) ledger.outcome = { status: "interrupted", detail: message.error };
      for (const invocation of message.invocationBudgets || []) if (invocation.status === "running") {
        invocation.status = "interrupted";
        invocation.detail = "Host interrupted. Only the last observed timing is retained; completion, downtime usage and termination are unknown.";
      }
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
    if (before && before === ApiChatStore.fileStamp(file)) this.loadedFiles.set(chat, { file, stamp: before });
    return chat;
  }

  private validDelegationUrl(record: ChatDelegation): boolean {
    try {
      const locator = parsePkmLocator(record.chatUrl);
      return locator.kind === "chat" && locator.chatId === record.chatId && record.chatUrl === chatPkmUrl(locator.namespace, locator.chatId);
    } catch { return false; }
  }

  private validateImages(chat: ApiConversation): void {
    for (const images of [chat.images, ...chat.messages.map(message => message.images)]) {
      if (images === undefined) continue;
      if (!Array.isArray(images) || images.length > 2) throw new Error("At most two images per message or draft are supported.");
      const bytes = images.reduce((total, image) => total + decodeChatImage(image).length, 0);
      if (bytes > 2 * 1024 * 1024) throw new Error("Images in one message or draft exceed 2 MB.");
    }
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
          archivedAt: new Date().toISOString(), chat: this.history.pack(current, { status: apiChatStatus(current), workerManager: current.messages.some(message => !!message.delegations?.length) }) };
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
      const record = JSON.parse(fs.readFileSync(file, "utf8"));
      if (record.schema !== "pkm.chat.worker-result/v1" || record.receiptId !== receiptId || ![1, 2].includes(record.chat?.version)) throw new Error("Invalid worker result archive.");
      return { ...record, chat: this.history.unpack(record.chat) };
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
      if (input.portalReview !== undefined && !validPortalReview(input.portalReview)) throw new Error("Invalid Portal status event.");
      if (input.editToken !== undefined) throw new Error("New queued messages cannot claim an editor.");
      this.assertExecutionContext(input.executionContext);
      if (current.paused && !input.portalReview) throw new Error("This Chat is paused. Resume it before sending another request.");
      if (input.mode === "steer" && (current.progress?.status !== "running" || current.progress.executionContext?.digest !== input.executionContext.digest)) throw new Error("Steering belongs to a different execution context. Submit a separate task instead.");
      const prior = current.queuedInputs?.find(item => item.id === input.id) || current.messages.find(message => message.submissionId === input.id);
      if (prior) {
        const text = "text" in prior ? prior.text : prior.content;
        if (text !== input.text || prior.executionContext?.digest !== input.executionContext.digest) throw new Error("Submission identity was already used with different text or execution context.");
        return current;
      }

      const priorReview = input.portalReview ? current.queuedInputs?.findIndex(item => item.portalReview?.pairId === input.portalReview!.pairId && item.portalReview.requestId === input.portalReview!.requestId) ?? -1 : -1;
      if (priorReview < 0 && (current.queuedInputs?.length || 0) >= 20) throw new Error("The Chat already has 20 queued inputs.");
      const queued = { ...input, ...(input.mode === "steer" ? { attemptId: current.progress?.attemptId } : {}) };
      if (priorReview >= 0) current.queuedInputs![priorReview] = queued;
      else (current.queuedInputs ||= []).push(queued);
      current.updatedAt = new Date().toISOString();
      this.saveUnlocked(current, false);
      return current;
    });
  }

  editQueuedInput(chat: ApiConversation, id: string, operation: "begin" | "save" | "cancel", token: string, text?: string): ApiConversation {
    if (!/^[a-f0-9-]{36}$/.test(token)) throw new Error("Invalid queued editor identity.");
    return withCrossProcessLockSync(path.join(this.stateDirectory, "api-chats", "chats.lock"), "Chat queued editor", () => {
      const current = this.load(chat.id, false);
      this.assertAvailable(current);
      const input = current.queuedInputs?.find(input => input.id === id);
      if (!input || input.portalReview) throw new Error("This queued message is no longer editable.");
      if (input.editToken && input.editToken !== token) throw new Error("This queued message is being edited in another window.");
      if (operation === "begin") input.editToken = token;
      else {
        if (input.editToken !== token) throw new Error("The queued editor changed. Reopen the message before saving.");
        if (operation === "save") {
          if (typeof text !== "string" || !text.trim() || text.length > 16_000) throw new Error("Enter a queued message up to 16,000 characters.");
          input.text = text;
        }
        delete input.editToken;
      }
      current.updatedAt = new Date().toISOString();
      this.saveUnlocked(current, false);
      chat.queuedInputs = current.queuedInputs;
      chat.revision = current.revision;
      this.rememberQueue(chat);
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
    if (!executionContext && chat.workspaceNamespace && chat.workspaceNamespace !== this.namespace && ["read_file", "find_files", "search_text", "list_directory", "replace_text", "save_file", "run_process"].some(name => chat.toolSelection ? !chat.toolSelection.disabledSources.includes("builtin") && !chat.toolSelection.disabledTools.includes(`builtin:${name}`) : chat.builtinTools === undefined || chat.builtinTools.includes(name))) throw new Error("This Chat's file/process tools belong to another workspace. Open the original workspace or disable those tools.");
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
    const seen = new Set<string>();
    for (const directory of this.directories()) for (const name of fs.readdirSync(directory)) {
      if (!/^[a-f0-9-]{36}\.json$/.test(name)) continue;
      const file = path.join(directory, name);
      seen.add(file);
      try {
        const entry = this.listingEntry(file, directory, name);
        const placement = placements[entry.id] || { groupId: "ungroup" };
        const stopped = entry.sessionId ? this.sessionStopped(entry.sessionId, entry.id) : false;
        if (includeTrash || !placement.trashedAt) chats.push({ id: entry.id, workspaceNamespace: entry.workspaceNamespace, title: entry.title, updatedAt: entry.updatedAt,
          status: stopped ? "stopped" : entry.status, ...placement, ...(entry.workerManager ? { workerManager: true } : {}),
          ...(entry.workerTreeId ? { workerTreeId: entry.workerTreeId, ...(entry.workerParentChatId ? { workerParentChatId: entry.workerParentChatId } : {}) } : {}) });
      } catch {}
    }
    for (const file of this.listingCache.keys()) if (!seen.has(file)) this.listingCache.delete(file);
    return chats.sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
  }

  // Listing used to parse every full Chat file (all messages) and session file on each call; renaming or copying a Chat
  // URL called it 3-4 times, which on Windows/NTFS with many Chats took seconds. Entries are reused while a file's
  // size and mtime are unchanged.
  private readonly listingCache = new Map<string, { stamp: string; entry: { id: string; workspaceNamespace: string; title: string; updatedAt: string; status: ApiChatStatus; sessionId?: string; workerManager: boolean; workerTreeId?: string; workerParentChatId?: string } }>();
  private readonly sessionStatusCache = new Map<string, { stamp: string; stopped: (chatId: string) => boolean }>();
  private static fileStamp(file: string): string | undefined {
    try { const stat = fs.statSync(file); return `${stat.size}:${stat.mtimeMs}:${stat.ctimeMs}:${stat.ino}`; } catch { return undefined; }
  }
  private listingEntry(file: string, directory: string, name: string) {
    const stamp = ApiChatStore.fileStamp(file);
    const cached = this.listingCache.get(file);
    if (stamp && cached?.stamp === stamp) return cached.entry;
    const stored = JSON.parse(fs.readFileSync(file, "utf8")) as StoredChat;
    const summary = this.history.summary(stored);
    const chat = summary ? stored : this.load(name.slice(0, -5), false);
    if (chat.id !== name.slice(0, -5) || typeof chat.title !== "string" || typeof chat.updatedAt !== "string"
      || !Number.isFinite(Date.parse(chat.updatedAt))) throw new Error("Unsupported Chat listing metadata.");
    const entry = { id: chat.id, workspaceNamespace: chat.workspaceNamespace || path.basename(directory), title: chat.title, updatedAt: chat.updatedAt,
      status: summary?.status || apiChatStatus({ ...chat, version: 1 }), ...(chat.sessionId ? { sessionId: chat.sessionId } : {}),
      workerManager: !!(summary?.workerManager ?? chat.messages.some(message => message.delegations?.length)),
      ...(chat.workerState ? { workerTreeId: chat.workerState.treeId, ...(chat.workerState.parentChatId ? { workerParentChatId: chat.workerState.parentChatId } : {}) } : {}) };
    // A legacy file may have been rewritten by load(); stamp after reading so the next call re-validates once.
    const after = ApiChatStore.fileStamp(file);
    if (after) this.listingCache.set(file, { stamp: after, entry });
    return entry;
  }
  private sessionStopped(sessionId: string, chatId: string): boolean {
    const file = path.join(this.stateDirectory, "agent-sessions", `${sessionId}.json`);
    const stamp = ApiChatStore.fileStamp(file);
    if (!stamp) { this.sessionStatusCache.delete(file); return false; }
    const cached = this.sessionStatusCache.get(file);
    if (cached?.stamp === stamp) return cached.stopped(chatId);
    let session: any;
    try { session = JSON.parse(fs.readFileSync(file, "utf8")); } catch { return false; }
    const host = session?.status === "stopped" && session.hostKind === "pkm" ? session.hostSessionId : undefined;
    const stopped = (id: string) => host === id;
    this.sessionStatusCache.set(file, { stamp, stopped });
    return stopped(chatId);
  }

  taskPlan(chat: ApiConversation): { items: Array<{ todoId: string; title: string; status: string }>; unavailable?: string } {
    if (!chat.sessionId) return { items: [] };
    if (!/^agent_session_[a-f0-9]{32}$/.test(chat.sessionId)) throw new Error("Invalid native Session identity.");
    const file = path.join(this.stateDirectory, "agent-sessions", `${chat.sessionId}.json`);
    if (!fs.existsSync(file)) return { items: [], unavailable: "The current Task Session is unavailable." };
    const session = JSON.parse(fs.readFileSync(file, "utf8"));
    if (session.schema !== "pkm.agent.session/v1" || session.sessionId !== chat.sessionId
      || agentSessionOrigin(session).origin !== "pkm-native" || session.hostSessionId !== chat.id || !Array.isArray(session.todos)) {
      throw new Error("The current Task plan does not belong to this PKM Chat.");
    }
    return { items: session.todos.map((item: unknown) => {
      if (!item || typeof item !== "object" || !("todoId" in item) || typeof item.todoId !== "string"
        || !("title" in item) || typeof item.title !== "string" || !("status" in item) || typeof item.status !== "string") {
        throw new Error("The current Task has an invalid todo record.");
      }
      return { todoId: item.todoId, title: item.title, status: item.status };
    }) };
  }

  async libraryMutation(operation: Exclude<ChatLibraryWork, "namespace" | "trash-list">, id: string): Promise<void> {
    await runChatLibraryWork(this.stateDirectory, this.namespace, operation, id);
  }

  async trashList(): Promise<Array<{ id: string; title: string }>> {
    const result = await runChatLibraryWork(this.stateDirectory, this.namespace, "trash-list", "");
    if (!result.chats) throw new Error("Chat library worker did not return the Trash listing.");
    return result.chats;
  }

  async memoryNamespace(id: string): Promise<string> {
    const result = await runChatLibraryWork(this.stateDirectory, this.namespace, "namespace", id);
    if (!result.namespace) throw new Error("Chat library worker did not return the owning namespace.");
    return result.namespace;
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
      if (chat.progress?.status === "running" || chat.messages.some(message => message.status === "streaming")) throw new Error("Stop the running Chat before permanently deleting it.");
      const group = agentSessionGroup({ sessionId: "", hostKind: "pkm", hostSessionId: id });
      const groupPath = path.join(this.stateDirectory, "agent-groups", `${group.groupId}.json`);
      const previous = fs.existsSync(groupPath) ? JSON.parse(fs.readFileSync(groupPath, "utf8")) : {};
      this.write(groupPath, { ...previous, schema: "pkm.agent.group/v1", groupId: group.groupId, hostKind: "pkm", hostSessionId: id,
        title: chat.title, deletedAt: new Date().toISOString() });
      fs.unlinkSync(this.file(id)); this.library.forget(id);
      const retainedTask = (chat.memoryTasks || []).some(task => /^agent_session_[a-f0-9]{32}$/.test(task.id) &&
        ["agent-sessions", "agent-sessions-trash"].some(directory => fs.existsSync(path.join(this.stateDirectory, directory, `${task.id}.json`))));
      const retainedWorker = chat.workerActivity?.receiptId && this.hasWorkerResult(chat.workerActivity.receiptId);
      if (!retainedTask && !retainedWorker) this.history.remove(id);
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
import { validPortalSource, validPortalReview, PortalReview } from "../chatroom/portal-runtime";