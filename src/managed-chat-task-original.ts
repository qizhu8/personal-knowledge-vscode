import { createHash, randomUUID } from "node:crypto";

// Pure rules selected from original VSIX SHA-256 1804071cb3b9fc86edc5933d5001db6ea1a8d7a9adf30d6d2b3166fcd6048f27.
// Fresh-Task dependency adapters below explicitly refuse checkpoints, worker evidence and file-version capture.
// Current continuation recognition additionally supports Chinese references to the previous task within one clause.
export interface ChatWorkGoal {
  id: string; inputId: string; attemptInputId: string; objective: string; executionDigest: string;
  status: "active" | "resolved" | "blocked" | "needs_input" | "interrupted" | "paused";
  acceptance: Array<{ criterion: string; verified: boolean; evidenceCallIds: string[] }>;
  reason?: string; nextAction?: string; transitions?: WorkGoalTransition[];
  contract?: { scope: string[]; nonGoals: string[]; stopWhen: string };
  phase?: "locating" | "implementing" | "verifying" | "delivering";
}
export type WorkGoalTransitionReason = "user_delegated" | "user_followup" | "user_answered" | "user_resumed"
  | "user_paused" | "user_superseded" | "agent_started_action" | "agent_continue" | "agent_claimed_resolved"
  | "agent_blocked" | "agent_needs_input" | "execution_cancelled" | "execution_failed" | "host_interrupted";
export interface WorkGoalTransition {
  at: number; inputId: string; attemptInputId: string; status: ChatWorkGoal["status"]; reason: WorkGoalTransitionReason;
}
export interface HarnessBinding { recipeRunId?: string; recipeStageId?: string; stepId?: string; parentStepId?: string; stepAttemptId?: string }
type Planning = { schema: "pkm.chat.planning/v1"; at: number; recipeRunId?: string; recipeStageId?: string;
  possibilities: Array<{ id: string; parentId?: string; label: string; summary?: string;
    status: "candidate" | "selected" | "rejected" | "blocked" | "validated"; recipeStageId?: string; reason?: string; evidenceRefs?: string[] }> };
export interface HarnessReport {
  schema: "pkm.chat.harness-report/v1"; id: string; at: number; attemptId: string; taskId?: string;
  source: "agent-report"; kind: "task" | "planning" | "step" | "validation"; binding: HarnessBinding;
  goal?: string; constraints?: string[]; acceptance?: string[]; completed?: string[]; openQuestions?: string[];
  sourceInputIds?: string[]; sourceInputDigest?: string; artifactVersions?: never[]; artifactEvidenceOffset?: number;
  summary?: string; status?: "start" | "complete" | "failed" | "ignored"; reason?: string; evidenceCallIds?: string[];
  supersedes?: string; planning?: Planning;
}
export interface TaskToolEvidence {
  id: string; name: string; arguments: string; status: "running" | "complete" | "failed"; result?: string;
  startedAt?: number; finishedAt?: number;
}
export interface ChatMessage {
  id: string; taskId?: string; inputId?: string; role: "user" | "assistant"; content: string; status: string;
  workerEventIds?: string[]; portalReview?: unknown; portalSource?: unknown;
  toolCalls?: TaskToolEvidence[]; harnessReports?: HarnessReport[];
  progress?: { attemptId: string; status: string };
}
export interface ApiConversation {
  id: string; sessionId?: string; includeHistory: boolean; messages: ChatMessage[];
  workGoal?: ChatWorkGoal; workGoalHistory?: ChatWorkGoal[]; taskContextCheckpoints?: unknown;
}
type WorkerVersionReader = never;
function activeTaskContextCheckpoint(chat: ApiConversation): { sourceInputIds: string[] } | undefined {
  if (chat.taskContextCheckpoints !== undefined) throw new Error("Canonical Task checkpoints require their independent native review.");
  return undefined;
}
function assertCurrentWorkerEvidence(calls: TaskToolEvidence[], _chatId: string, _read?: WorkerVersionReader): void {
  if (calls.some(call => /^(?:spawn_workers|assign_workers|worker_|respond_worker|resolve_worker|stop_worker)/.test(call.name)))
    throw new Error("Canonical managed Task worker evidence requires its independently composed version authority.");
}
function validationArtifactPaths(_value: unknown): never {
  throw new Error("Canonical Task file-version capture is not composed; no caller hashes are accepted.");
}
const WORK_GOAL_TRANSITION_LIMIT = 64;
const ineligibleWorkEvidenceNames = new Set(["report_work", "finish_debug", "session_info", "record_harness"]);
function eligibleWorkEvidence(call: TaskToolEvidence): boolean {
  return call.status === "complete" && typeof call.result === "string" && !ineligibleWorkEvidenceNames.has(call.name);
}
function invalidEvidenceError(reply: ChatMessage): Error {
  const eligible = (reply.toolCalls || []).filter(eligibleWorkEvidence);
  const candidates = eligible.slice(0, 8).map(({ id, name }) => ({ id, name }));
  const omitted = eligible.length - candidates.length;
  return new Error(`Verified acceptance requires unique successful execution/validation call IDs from this attempt, not reports or another attempt. Eligible current-reply candidates (id,name; maximum 8): ${JSON.stringify(candidates)}. Omitted eligible current-reply candidate count: ${omitted}.${eligible.length ? "" : " No eligible current-reply candidates are available."} No work state changed.`);
}
export const workStop = /^\s*(?:(?:please\s+)?(?:stop|pause)(?:\s+(?:(?:(?:the\s+)?current|the|this)\s+)?(?:debugging|investigating|diagnosing|work|investigation|task))?(?:\s+(?:now|for now))?|(?:请|先)?(?:停止|暂停)(?:当前|这次|本次)?(?:调试|排查|调查|debug|任务)?)(?:[.!。！,，;；\n]|$)/i;
export const delegatedWork = /(?:\b(?:please\s+)?(?:debug|investigate|diagnose|fix|implement|build|repair)\s+(?:this|the|my|our|a|an)\b|(?:帮我|请你|请|开始|继续|去).{0,24}(?:debug|调试|排查|调查|修复|修好|实现|开发|解决)|(?:debug|调试|排查).{0,16}(?:吧|一下))/i;
export const rootWorkCriterion = "The original user objective and all subsequent requirements are satisfied.";
const resumeWork = /^\s*(?:continue|resume|继续|恢复)(?:\b|一下|吧|工作|任务|调查|排查|调试|推进|(?:刚才|上次|之前)[^,，。.!！?？;；\r\n]{0,24}(?:任务|工作|目标)|$)/i;
const explanatory = /^\s*(?:(?:what|why|how|explain|describe)\b|为什么|为何|解释|说明|介绍)/i;
export const newWorkGoal = /^\s*(?:开始新任务|start a new task)\s*[:：]/i;
export function recordWorkGoalTransition(goal: ChatWorkGoal, status: ChatWorkGoal["status"], reason: WorkGoalTransitionReason,
  inputId = goal.attemptInputId, at = Date.now()): ChatWorkGoal {
  const last = goal.transitions?.[goal.transitions.length - 1];
  if (last && last.status === status && last.reason === reason && last.inputId === inputId
    && last.attemptInputId === goal.attemptInputId) return { ...goal, status };
  const transition: WorkGoalTransition = { at, inputId, attemptInputId: goal.attemptInputId, status, reason };
  return { ...goal, status, transitions: [...(goal.transitions || []), transition].slice(-WORK_GOAL_TRANSITION_LIMIT) };
}
export function validWorkGoal(value: unknown): value is ChatWorkGoal {
  if (!value || typeof value !== "object") return false;
  const goal = value as ChatWorkGoal;
  return [goal.id, goal.inputId, goal.attemptInputId].every(id => typeof id === "string" && /^[a-f0-9-]{36}$/.test(id))
    && typeof goal.objective === "string" && !!goal.objective.trim() && goal.objective.length <= 16000
    && typeof goal.executionDigest === "string" && /^[a-f0-9]{64}$/.test(goal.executionDigest)
    && ["active", "resolved", "blocked", "needs_input", "interrupted", "paused"].includes(goal.status)
    && Array.isArray(goal.acceptance) && goal.acceptance.length <= 32
    && goal.acceptance.some(item => item?.criterion === rootWorkCriterion)
    && goal.acceptance.every(item => item && typeof item.criterion === "string" && !!item.criterion.trim() && item.criterion.length <= 1000
      && typeof item.verified === "boolean" && Array.isArray(item.evidenceCallIds) && item.evidenceCallIds.length <= 32
      && item.evidenceCallIds.every(id => typeof id === "string" && !!id && id.length <= 200))
    && new Set(goal.acceptance.map(item => item.criterion)).size === goal.acceptance.length
    && (goal.status !== "resolved" || goal.acceptance.every(item => item.verified && item.evidenceCallIds.length > 0))
    && (goal.reason === undefined || typeof goal.reason === "string" && goal.reason.length <= 2000)
    && (goal.nextAction === undefined || typeof goal.nextAction === "string" && goal.nextAction.length <= 2000)
    && (goal.phase === undefined || ["locating", "implementing", "verifying", "delivering"].includes(goal.phase))
    && (goal.contract === undefined || validWorkContract(goal.contract))
    && (goal.transitions === undefined || Array.isArray(goal.transitions) && goal.transitions.length <= WORK_GOAL_TRANSITION_LIMIT
      && goal.transitions.every(item => item && Number.isSafeInteger(item.at) && item.at >= 0
        && typeof item.inputId === "string" && /^[a-f0-9-]{36}$/.test(item.inputId)
        && typeof item.attemptInputId === "string" && /^[a-f0-9-]{36}$/.test(item.attemptInputId)
        && ["active", "resolved", "blocked", "needs_input", "interrupted", "paused"].includes(item.status)
        && ["user_delegated", "user_followup", "user_answered", "user_resumed", "user_paused", "user_superseded", "agent_started_action", "agent_continue",
          "agent_claimed_resolved", "agent_blocked", "agent_needs_input", "execution_cancelled", "execution_failed",
          "host_interrupted"].includes(item.reason)));
}
function validWorkContract(value: unknown): value is NonNullable<ChatWorkGoal["contract"]> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const contract = value as NonNullable<ChatWorkGoal["contract"]>;
  const list = (items: unknown): items is string[] => Array.isArray(items) && items.length <= 16
    && items.every(item => typeof item === "string" && !!item.trim() && item.length <= 600);
  return list(contract.scope) && contract.scope.length > 0 && list(contract.nonGoals)
    && typeof contract.stopWhen === "string" && !!contract.stopWhen.trim() && contract.stopWhen.length <= 1000;
}
export function prepareWorkGoal(chat: ApiConversation, inputId: string, text: string, executionDigest: string): void {
  const startsNewGoal = newWorkGoal.test(text);
  if (startsNewGoal && chat.workGoal?.inputId !== inputId) {
    if (!text.replace(newWorkGoal, "").trim()) throw new Error("A new task requires an objective after 'Start a new task:' or '开始新任务：'.");
    if (chat.workGoal) {
      const previous = chat.workGoal.status === "active"
        ? recordWorkGoalTransition(structuredClone(chat.workGoal), "paused", "user_superseded", inputId)
        : structuredClone(chat.workGoal);
      (chat.workGoalHistory ||= []).push(previous);
    }
    chat.workGoal = recordWorkGoalTransition({ id: randomUUID(), inputId, attemptInputId: inputId,
      objective: text, executionDigest, status: "active",
      acceptance: [{ criterion: rootWorkCriterion, verified: false, evidenceCallIds: [] }] },
    "active", "user_delegated", inputId);
    return;
  }
  if (workStop.test(text)) {
    if (chat.workGoal && chat.workGoal.status !== "resolved") chat.workGoal = recordWorkGoalTransition(chat.workGoal, "paused", "user_paused", inputId);
    return;
  }
  const previous = (chat.includeHistory || startsNewGoal && chat.workGoal?.inputId === inputId) ? chat.workGoal : undefined;
  const unfinished = previous && previous.status !== "resolved";
  const answer = unfinished && ["needs_input", "blocked"].includes(previous.status) && !explanatory.test(text);
  const delegation = delegatedWork.test(text) && !explanatory.test(text)
    && !/^\s*(?:please\s+)?(?:explain|describe)\b/i.test(text)
    && !/^\s*(?:帮我|请你|请)?(?:解释|说明|介绍)/.test(text);
  const explicit = startsNewGoal || delegation || resumeWork.test(text);
  if (!explicit && !(unfinished && previous.status === "active" && !explanatory.test(text)) && !answer) return;
  if (unfinished) {
    if (previous.executionDigest !== executionDigest) throw new Error("The unfinished goal belongs to another execution context. Resume it in its original context; it was not retargeted.");
    if (["paused", "interrupted"].includes(previous.status) && !explicit) return;
    const reason: WorkGoalTransitionReason = ["paused", "interrupted"].includes(previous.status) ? "user_resumed"
      : ["needs_input", "blocked"].includes(previous.status) ? "user_answered" : "user_followup";
    chat.workGoal = recordWorkGoalTransition({ ...previous, attemptInputId: inputId, phase: "locating",
      acceptance: previous.acceptance.map(item => ({ ...item, verified: false, evidenceCallIds: [] })),
      reason: undefined, nextAction: undefined }, "active", reason, inputId);
  } else if (delegation) {
    chat.workGoal = recordWorkGoalTransition({ id: randomUUID(), inputId, attemptInputId: inputId,
      objective: text, executionDigest, status: "active",
      acceptance: [{ criterion: rootWorkCriterion, verified: false, evidenceCallIds: [] }] }, "active", "user_delegated", inputId);
  }
}
export function workGoalInputs(chat: ApiConversation): string[] {
  const goal = chat.workGoal;
  if (!goal) return [];
  const start = chat.messages.findIndex(message => message.id === goal.inputId);
  if (start < 0) throw new Error("The goal's original user input is unavailable. Restore its history before resuming.");
  const checkpoint = activeTaskContextCheckpoint(chat);
  const covered = new Set(checkpoint?.sourceInputIds || []);
  const sources = chat.messages.slice(start).filter(message => message.role === "user" && !message.workerEventIds?.length && !message.portalReview).map(message => message.id);
  const ids = checkpoint && covered.has(goal.inputId)
    ? [checkpoint.sourceInputIds[checkpoint.sourceInputIds.length - 1], ...sources.filter(id => !covered.has(id))] : sources;
  if (ids.length > 64) throw new Error("The goal has more than 64 user updates. Review and explicitly consolidate its requirements before continuing.");
  return ids;
}
export function reportWork(chat: ApiConversation, reply: ChatMessage, args: Record<string, unknown>, readWorker?: WorkerVersionReader): string {
  const goal = chat.workGoal;
  if (!goal || goal.attemptInputId !== reply.inputId || goal.status === "paused" || goal.status === "interrupted") throw new Error("No active work objective belongs to this attempt.");
  if (!["continue", "resolved", "blocked", "needs_input"].includes(String(args.status))
    || typeof args.reason !== "string" || !args.reason.trim() || args.reason.length > 2000
    || !Array.isArray(args.sourceInputIds) || JSON.stringify(args.sourceInputIds) !== JSON.stringify(workGoalInputs(chat))) {
    throw new Error("Report an outcome, a concrete reason and all ordered sourceInputIds from session_info.workGoal.");
  }
  const acceptance = args.acceptance;
  const missingCriteria = goal.acceptance.filter(previous => !Array.isArray(acceptance)
    || !acceptance.some(item => item && typeof item === "object" && item.criterion === previous.criterion))
    .map(item => item.criterion);
  if (missingCriteria.length) throw new Error(`Reports must preserve existing acceptance criteria verbatim. Missing criteria: ${JSON.stringify(missingCriteria)}. Read session_info.workGoal.acceptance and resubmit the complete list with explicit verified and evidenceCallIds for each item; leave unmet criteria unverified. No work state was changed.`);
  const candidate: ChatWorkGoal = { ...goal, status: args.status === "continue" ? "active" : args.status as ChatWorkGoal["status"],
    reason: args.reason, acceptance: acceptance as ChatWorkGoal["acceptance"], nextAction: args.nextAction as string | undefined,
    ...(args.contract === undefined ? {} : { contract: args.contract as ChatWorkGoal["contract"] }),
    ...(args.phase === undefined ? {} : { phase: args.phase as ChatWorkGoal["phase"] }) };
  if (Array.isArray(acceptance)) acceptance.forEach((item, index) => {
    if (item && Array.isArray(item.evidenceCallIds) && item.evidenceCallIds.length > 32)
      throw new Error(`acceptance[${index}].evidenceCallIds contains ${item.evidenceCallIds.length} IDs; maximum 32. No work state was changed.`);
  });
  if (!validWorkGoal({ ...candidate, status: "active" }) || !candidate.acceptance.length)
    throw new Error("Provide 1–32 unique acceptance criteria; preserve existing criteria and leave unmet ones unverified.");
  if (args.status === "continue" && !candidate.nextAction?.trim()) throw new Error("Continuing work requires the next concrete authorized action.");
  for (const item of candidate.acceptance) {
    if (!item.verified) continue;
    if (!item.evidenceCallIds.length || new Set(item.evidenceCallIds).size !== item.evidenceCallIds.length
      || item.evidenceCallIds.some(id => !(reply.toolCalls || []).some(call => call.id === id && eligibleWorkEvidence(call)))) throw invalidEvidenceError(reply);
    assertCurrentWorkerEvidence((reply.toolCalls || []).filter(call => item.evidenceCallIds.includes(call.id)), chat.id, readWorker);
  }
  if (args.status === "resolved" && candidate.acceptance.some(item => !item.verified)) throw new Error("The user objective remains open: every acceptance criterion must be verified before resolution.");
  if (candidate.phase === "delivering" && args.status === "continue") throw new Error("Delivery requires resolved acceptance or a concrete blocked/needs_input handoff, not continued execution.");
  if (args.status === "resolved") candidate.phase = "delivering";
  const reason: WorkGoalTransitionReason = args.status === "continue" ? "agent_continue"
    : args.status === "resolved" ? "agent_claimed_resolved" : args.status === "blocked" ? "agent_blocked" : "agent_needs_input";
  chat.workGoal = recordWorkGoalTransition(candidate, candidate.status, reason);
  return JSON.stringify({ recorded: true, goal: candidate, agentClaimNotIndependentCertification: true });
}
export function currentTaskReport(chat: ApiConversation): HarnessReport | undefined {
  if (!chat.sessionId) return undefined;
  return [...chat.messages].reverse().flatMap(message => message.taskId === chat.sessionId ? [...message.harnessReports || []].reverse() : [])
    .find(report => report.kind === "task" && report.taskId === chat.sessionId && report.schema === "pkm.chat.harness-report/v1" && report.source === "agent-report");
}
export function taskContextInputs(chat: ApiConversation): ChatMessage[] {
  return chat.messages.filter(message => !!chat.sessionId && message.taskId === chat.sessionId && message.role === "user" && !message.workerEventIds?.length && !message.portalReview);
}
export function taskContextInputDigest(inputs: ChatMessage[]): string {
  return createHash("sha256").update(JSON.stringify(inputs.map(message => [message.id, message.taskId, message.content, message.portalSource || null]))).digest("hex");
}
export function currentHarnessTask(chat: ApiConversation): HarnessReport | undefined { return currentTaskReport(chat); }
const text = (value: unknown, name: string, max = 4000): string => {
  if (typeof value !== "string" || !value.trim() || value.length > max) throw new Error(`${name} must be nonempty text up to ${max} characters.`);
  return value;
};
const optional = (value: unknown, name: string, max?: number) => value === undefined ? undefined : text(value, name, max);
const strings = (value: unknown, name: string): string[] | undefined => {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.length > 64) throw new Error(`${name} must be an array with at most 64 entries.`);
  return value.map(item => text(item, name));
};
export function validateHarnessReport(chat: ApiConversation, reply: ChatMessage, args: Record<string, unknown>): HarnessReport {
  if (!chat.sessionId || reply.taskId !== chat.sessionId) throw new Error("Harness reports require the current managed Task identity.");
  if (!reply.progress?.attemptId || reply.progress.status !== "running") throw new Error("Harness reporting requires the current running attempt.");
  if ((reply.harnessReports?.length || 0) >= 256) throw new Error("This attempt has reached its 256 explicit Harness report limit.");
  const kinds = ["task", "planning", "step", "validation"] as const;
  if (!kinds.includes(args.kind as typeof kinds[number])) throw new Error("Choose task, planning, step or validation.");
  const kind = args.kind as typeof kinds[number];
  const allowed = ["kind", "recipeRunId", "recipeStageId", "stepId", "parentStepId", "goal", "constraints", "acceptance", "completed", "openQuestions", "sourceInputIds", "summary", "status", "reason", "evidenceCallIds", "supersedes", "possibilities", "artifactPaths"];
  if (Object.keys(args).some(key => !allowed.includes(key))) throw new Error("Unknown Harness report field.");
  if (args.artifactPaths !== undefined) {
    if (kind !== "validation" || args.status !== "start") throw new Error("Only validation start may declare artifactPaths; outcomes inherit the recorded files.");
    validationArtifactPaths(args.artifactPaths);
  }
  const binding: HarnessBinding = { recipeRunId: optional(args.recipeRunId, "recipeRunId", 200),
    recipeStageId: optional(args.recipeStageId, "recipeStageId", 200), stepId: optional(args.stepId, "stepId", 200), parentStepId: optional(args.parentStepId, "parentStepId", 200) };
  if (binding.recipeRunId && !/^recipe_run_[A-Za-z0-9_-]+$/.test(binding.recipeRunId)) throw new Error("Invalid Recipe Run identity.");
  if (!!binding.recipeRunId !== !!binding.recipeStageId) throw new Error("Recipe Run and Stage must be reported together.");
  const reports = chat.messages.flatMap(message => message.taskId === reply.taskId ? message.harnessReports || [] : []);
  const report: HarnessReport = { schema: "pkm.chat.harness-report/v1", id: randomUUID(), at: Date.now(), attemptId: reply.progress.attemptId,
    taskId: reply.taskId, source: "agent-report", kind, binding, goal: optional(args.goal, "goal"), constraints: strings(args.constraints, "constraints"),
    acceptance: strings(args.acceptance, "acceptance"), completed: strings(args.completed, "completed"), openQuestions: strings(args.openQuestions, "openQuestions"),
    sourceInputIds: strings(args.sourceInputIds, "sourceInputIds"), summary: optional(args.summary, "summary"), reason: optional(args.reason, "reason"),
    evidenceCallIds: strings(args.evidenceCallIds, "evidenceCallIds"), supersedes: optional(args.supersedes, "supersedes", 200) };
  if (report.supersedes && !reports.some(previous => previous.id === report.supersedes && previous.kind === kind)) throw new Error("supersedes must reference an earlier report of the same kind in this task.");
  for (const id of report.sourceInputIds || []) if (!chat.messages.some(message => message.id === id && message.role === "user" && message.taskId === reply.taskId && !message.workerEventIds?.length && !message.portalReview))
    throw new Error(`Source input ${id} is not a user input in this task.`);
  if (new Set(report.evidenceCallIds).size !== (report.evidenceCallIds?.length || 0)) throw new Error("Evidence call identities must not be duplicated.");
  const evidence = (report.evidenceCallIds || []).map(id => {
    const matches = chat.messages.filter(message => message.role === "assistant" && message.taskId === reply.taskId)
      .flatMap(message => (message.toolCalls || []).filter(call => call.id === id));
    if (matches.length > 1) throw new Error(`Evidence call ${id} is ambiguous across recorded responses; use an unambiguous call identity.`);
    if (matches.length !== 1 || matches[0].status === "running" || typeof matches[0].result !== "string") throw new Error(`Evidence call ${id} is not a terminal recorded call with an available result in this task.`);
    return matches[0];
  });
  if (kind === "task") {
    if (!report.goal || !report.sourceInputIds?.length) throw new Error("Task reports require a goal and sourceInputIds; they do not complete the managed Task.");
    const latest = currentHarnessTask(chat);
    if (latest && report.supersedes !== latest.id) throw new Error(`Task updates must supersede the latest task report ${latest.id}; read session_info before reconciling a stale summary.`);
    const latestInput = [...chat.messages].reverse().find(message => message.taskId === reply.taskId && message.role === "user" && !message.workerEventIds?.length && !message.portalReview);
    if (latestInput && !report.sourceInputIds.includes(latestInput.id)) throw new Error(`Task reports must reference the latest user input ${latestInput.id}; reconcile newer requirements before updating the working state.`);
  } else if (kind === "planning") {
    if (!Array.isArray(args.possibilities) || args.possibilities.length > 128) throw new Error("Planning requires at most 128 explicitly reported possibilities; an empty list means direct execution.");
    const possibilities = args.possibilities.map(value => {
      if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid planning possibility.");
      const item = value as Record<string, unknown>;
      if (Object.keys(item).some(key => !["id", "parentId", "label", "summary", "status", "recipeStageId", "reason", "evidenceRefs"].includes(key))) throw new Error("Unknown planning possibility field.");
      if (!["candidate", "selected", "rejected", "blocked", "validated"].includes(String(item.status))) throw new Error("Invalid possibility status.");
      return { id: text(item.id, "possibility.id", 200), parentId: optional(item.parentId, "parentId", 200), label: text(item.label, "label", 500),
        summary: optional(item.summary, "summary"), status: item.status as Planning["possibilities"][number]["status"],
        recipeStageId: optional(item.recipeStageId, "recipeStageId", 200), reason: optional(item.reason, "reason"), evidenceRefs: strings(item.evidenceRefs, "evidenceRefs") };
    });
    const byId = new Map(possibilities.map(item => [item.id, item]));
    if (byId.size !== possibilities.length) throw new Error("Planning possibility IDs must be unique.");
    for (const item of possibilities) {
      const visited = new Set([item.id]); let parentId = item.parentId;
      while (parentId) {
        if (!byId.has(parentId) || visited.has(parentId)) throw new Error("Planning parents must exist and must not form a cycle.");
        visited.add(parentId); parentId = byId.get(parentId)!.parentId;
      }
    }
    report.planning = { schema: "pkm.chat.planning/v1", at: report.at, recipeRunId: binding.recipeRunId, recipeStageId: binding.recipeStageId, possibilities };
  } else {
    if (!["start", "complete", "failed", "ignored"].includes(String(args.status))) throw new Error("Step/validation requires start, complete, failed or ignored.");
    report.status = args.status as HarnessReport["status"];
    if (!binding.stepId) throw new Error("Step and validation reports require a stable stepId.");
    if (!report.summary) throw new Error("Step and validation reports require a summary.");
    const preceding = [...reply.harnessReports || []].reverse().find(previous => previous.kind === kind && previous.binding.stepId === binding.stepId
      && (kind !== "validation" || previous.attemptId === report.attemptId && previous.taskId === report.taskId));
    if (kind === "validation") {
      const inputs = taskContextInputs(chat), latestInput = inputs[inputs.length - 1];
      if (report.status === "start") {
        if (!latestInput) throw new Error("Validation requires an original user source input in this task.");
        report.sourceInputIds ??= [latestInput.id];
        if (!report.sourceInputIds.includes(latestInput.id)) throw new Error("Validation must reference the latest user source input.");
        report.sourceInputDigest = taskContextInputDigest(inputs);
      } else if (preceding) {
        if (binding.recipeRunId && (binding.recipeRunId !== preceding.binding.recipeRunId || binding.recipeStageId !== preceding.binding.recipeStageId)) throw new Error("A validation outcome cannot change its recorded Recipe binding.");
        binding.recipeRunId = preceding.binding.recipeRunId; binding.recipeStageId = preceding.binding.recipeStageId;
        if (report.sourceInputIds && JSON.stringify(report.sourceInputIds) !== JSON.stringify(preceding.sourceInputIds)) throw new Error("Validation source inputs changed; finish the previous check and start a new validation.");
        report.sourceInputIds = preceding.sourceInputIds && [...preceding.sourceInputIds]; report.sourceInputDigest = preceding.sourceInputDigest;
        report.artifactVersions = preceding.artifactVersions; report.artifactEvidenceOffset = preceding.artifactEvidenceOffset;
        if (report.status === "complete" && report.artifactVersions && evidence.some(call => !Number.isSafeInteger(report.artifactEvidenceOffset) || report.artifactEvidenceOffset! < 0
          || (reply.toolCalls || []).indexOf(call) < report.artifactEvidenceOffset! || !reply.toolCalls?.includes(call) || call.name === "record_harness"
          || !Number.isFinite(call.startedAt) || call.startedAt! < preceding.at || !Number.isFinite(call.finishedAt) || call.finishedAt! < call.startedAt!))
          throw new Error("File-version validation requires evidence executed in this attempt after its recorded start; run the check again.");
        if (report.status === "complete" && (!latestInput || !report.sourceInputIds?.includes(latestInput.id) || report.sourceInputDigest !== taskContextInputDigest(inputs)))
          throw new Error("Validation source inputs changed; record the old check as failed or ignored and start a new validation.");
      }
    }
    if (kind === "step") {
      if (preceding) {
        if (report.status !== "start" && binding.recipeRunId && (binding.recipeRunId !== preceding.binding.recipeRunId || binding.recipeStageId !== preceding.binding.recipeStageId)) throw new Error("A Step outcome cannot change its recorded Recipe binding.");
        if (!binding.recipeRunId) { binding.recipeRunId = preceding.binding.recipeRunId; binding.recipeStageId = preceding.binding.recipeStageId; }
      }
      if (preceding && args.parentStepId !== undefined && binding.parentStepId !== preceding.binding.parentStepId) throw new Error("Step ownership cannot change within an attempt.");
      binding.parentStepId ??= preceding?.binding.parentStepId;
      if (binding.parentStepId) {
        const parent = [...reply.harnessReports || []].reverse().find(previous => previous.kind === "step" && previous.binding.stepId === binding.parentStepId);
        if (binding.parentStepId === binding.stepId || !parent || report.status === "start" && parent.status !== "start") throw new Error("A nested Step requires its recorded parent, running when the child starts.");
      }
      if (report.status === "complete") {
        const children = new Map((reply.harnessReports || []).filter(previous => previous.kind === "step").map(previous => [previous.binding.stepId, previous]));
        if ([...children.values()].some(child => {
          if (child.status !== "start") return false;
          let parentId = child.binding.parentStepId; const seen = new Set<string>();
          while (parentId && !seen.has(parentId)) {
            if (parentId === binding.stepId) return true;
            seen.add(parentId); parentId = children.get(parentId)?.binding.parentStepId;
          }
          return false;
        })) throw new Error("Complete the running child Steps before completing their parent.");
      }
      binding.stepAttemptId = report.status === "start" || !preceding ? report.id : preceding.binding.stepAttemptId || preceding.id;
    }
    if (report.status === "start" && preceding?.status === "start") throw new Error("This Step is already started; record its outcome before a new attempt.");
    if (["complete", "failed"].includes(report.status!) && preceding?.status !== "start") throw new Error("A terminal Step/validation outcome requires its recorded start in this attempt.");
    if (report.status === "ignored" && !report.reason) throw new Error("Ignored execution requires an explicit reason.");
    if (kind === "validation" && ["complete", "failed"].includes(report.status!) && !report.evidenceCallIds?.length) throw new Error("Validation outcomes require recorded evidenceCallIds.");
    if (kind === "validation" && report.status === "complete" && evidence.some(call => call.status === "failed") && !report.reason)
      throw new Error("Completing validation with failed tool evidence requires an explicit reason explaining the expected failure or superseding successful evidence. Tool status alone does not prove acceptance.");
  }
  return report;
}
