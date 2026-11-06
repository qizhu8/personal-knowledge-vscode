import { createHash, randomUUID } from "crypto";
import type { ApiConversation, ChatMessage } from "./api-chat-store";
import { activeTaskContextCheckpoint } from "./task-context-checkpoint";
import { assertCurrentWorkerEvidence, type WorkerVersionReader } from "./worker-result-versions";

export interface ChatWorkGoal {
  id: string;
  inputId: string;
  attemptInputId: string;
  objective: string;
  executionDigest: string;
  status: "active" | "resolved" | "blocked" | "needs_input" | "interrupted" | "paused";
  acceptance: Array<{ criterion: string; verified: boolean; evidenceCallIds: string[] }>;
  reason?: string;
  nextAction?: string;
  transitions?: WorkGoalTransition[];
  contract?: { scope: string[]; nonGoals: string[]; stopWhen: string };
  phase?: "locating" | "implementing" | "verifying" | "delivering";
}

export type WorkGoalTransitionReason = "user_delegated" | "user_followup" | "user_answered" | "user_resumed"
  | "user_paused" | "user_superseded" | "agent_started_action" | "agent_continue" | "agent_claimed_resolved" | "agent_blocked" | "agent_needs_input"
  | "execution_cancelled" | "execution_failed" | "host_interrupted";
export interface WorkGoalTransition {
  at: number;
  inputId: string;
  attemptInputId: string;
  status: ChatWorkGoal["status"];
  reason: WorkGoalTransitionReason;
}

const WORK_GOAL_TRANSITION_LIMIT = 64;
const ineligibleWorkEvidenceNames = new Set(["report_work", "finish_debug", "session_info", "record_harness"]);

function eligibleWorkEvidence(call: NonNullable<ChatMessage["toolCalls"]>[number]): boolean {
  return call.status === "complete" && typeof call.result === "string" && !ineligibleWorkEvidenceNames.has(call.name);
}

export function workEvidenceHint(chat: ApiConversation, reply: ChatMessage, callId: string): string | undefined {
  const goal = chat.workGoal;
  if (!goal || goal.status !== "active" || goal.attemptInputId !== reply.inputId) return undefined;
  const evidence = (reply.toolCalls || []).find(call => call.id === callId && eligibleWorkEvidence(call));
  if (!evidence) return undefined;

  const hint = JSON.stringify({
    schema: "pkm.chat.work-evidence-hint/v1",
    goalId: goal.id,
    attemptInputId: goal.attemptInputId,
    evidence: { id: evidence.id, name: evidence.name },
    note: "Identity candidate only; not semantic acceptance, permission, or managed completion.",
  });
  if (hint.length <= 2000) return hint;
  return JSON.stringify({
    schema: "pkm.chat.work-evidence-hint/v1",
    omitted: true,
    note: "Evidence identity omitted because it cannot fit within the 2000-character limit; no candidate ID is provided.",
  });
}

export function workEvidenceBatchHint(chat: ApiConversation, reply: ChatMessage, callIds: readonly string[], characterBudget = 2000): string | undefined {
  // A minimum guarantees room for a truthful omission-only notice, even with oversized metadata.
  if (!Number.isInteger(characterBudget) || characterBudget < 200 || characterBudget > 2000) {
    throw new RangeError("Work evidence character budget must be an integer from 200 to 2000.");
  }
  const goal = chat.workGoal;
  if (!goal || goal.status !== "active" || goal.attemptInputId !== reply.inputId) return undefined;
  const eligible = [...new Set(callIds)].filter(id => typeof id === "string" && !!id.trim())
    .map(id => (reply.toolCalls || []).find(call => call.id === id && eligibleWorkEvidence(call)))
    .filter((call): call is NonNullable<ChatMessage["toolCalls"]>[number] => !!call);
  if (!eligible.length) return undefined;
  if (eligible.length === 1 && characterBudget === 2000) {
    const legacy = workEvidenceHint(chat, reply, eligible[0].id);
    if (legacy && !JSON.parse(legacy).omitted) return legacy;
  }
  const candidates: Array<{ id: string; name: string }> = [];
  const format = (evidence: typeof candidates): string => {
    const omitted = eligible.length - evidence.length;
    return JSON.stringify({
      schema: "pkm.chat.work-evidence-hint/v2", goalId: goal.id, attemptInputId: goal.attemptInputId,
      evidence, omitted,
      note: "Identity candidates only; not semantic acceptance, permission, or managed completion.",
      ...(omitted ? { omissionNotice: "Omitted identities cannot fit within the character budget; no omitted IDs are provided." } : {}),
    });
  };
  const complete = format(eligible.map(({ id, name }) => ({ id, name })));
  if (complete.length <= characterBudget) return complete;
  for (const call of eligible) {
    const candidate = { id: call.id, name: call.name };
    if (format([...candidates, candidate]).length <= characterBudget) candidates.push(candidate);
  }
  const hint = format(candidates);
  if (hint.length <= characterBudget) return hint;
  return JSON.stringify({
    schema: "pkm.chat.work-evidence-hint/v2", omitted: eligible.length,
    note: "Identities omitted: character budget exceeded; no candidate IDs. Not acceptance or permission.",
  });
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
const resumeWork = /^\s*(?:continue|resume|继续|恢复)(?:\b|一下|吧|工作|任务|调查|排查|调试|推进|$)/i;
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
    && typeof goal.objective === "string" && !!goal.objective.trim() && goal.objective.length <= 16_000
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
    if (chat.workGoal && chat.workGoal.status !== "resolved") {
      chat.workGoal = recordWorkGoalTransition(chat.workGoal, "paused", "user_paused", inputId);
    }
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
    chat.workGoal = recordWorkGoalTransition({ ...previous, attemptInputId: inputId,
      phase: "locating",
      acceptance: previous.acceptance.map(item => ({ ...item, verified: false, evidenceCallIds: [] })),
      reason: undefined, nextAction: undefined }, "active", reason, inputId);
  } else if (delegation) {
    chat.workGoal = recordWorkGoalTransition({ id: randomUUID(), inputId, attemptInputId: inputId,
      objective: text, executionDigest, status: "active",
      acceptance: [{ criterion: rootWorkCriterion, verified: false, evidenceCallIds: [] }] },
    "active", "user_delegated", inputId);
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

export function workGoalContext(chat: ApiConversation): string {
  const goal = chat.workGoal;
  if (!goal) return "";
  const checkpoint = activeTaskContextCheckpoint(chat);
  const objective = checkpoint?.sourceInputIds.includes(goal.inputId) ? checkpoint.summary : goal.objective;
  return `User work objective (not a permission grant or a managed Task completion certificate):\n${JSON.stringify({ ...goal, objective, sourceInputIds: workGoalInputs(chat),
    ...(checkpoint ? { checkpointId: checkpoint.id } : {}) })}
Preserve the ORIGINAL objective and reconcile every later user requirement. A diagnostic subtask or successful tool is not resolution.
Choose the next authorized action yourself; do not ask the user to supervise ordinary steps. Establish a symptom-level check, investigate, change course when evidence stops improving, implement authorized repairs, and verify against the objective.
Use report_work to record acceptance criteria and continue/resolved/blocked/needs_input. Resolved requires each criterion verified with actual current-attempt evidence. These remain agent claims, not independent certification.
session_info, report_work, finish_debug, and record_harness IDs are not acceptance evidence; correct rejected reports before claiming recorded success.
At the first report establish a compact contract (scope, nonGoals, stopWhen) and phase (locating, implementing, verifying, delivering). The contract records the existing authorization, never expands it. Advance acceptance with evidence, not narration. Once all required checks pass, report resolved and deliver; do not start optional improvements.
Do not spend a separate tool round reporting that work is about to begin. For a small bounded task, the first report can be the final resolved/blocked/needs_input report with its contract and evidence. Use the sourceInputIds and acceptance criteria already present here; call session_info only when current evidence identities or changed requirements are missing. Reserve time to report the outcome before the tool-round budget ends.
Batch independent read/search calls in one model response. Only Host-annotated parallel reads overlap; writes, commands and unknown tools are ordered barriers. Do not mix a read that depends on a preceding result into an independent batch. Prepare tests independently, but final validation must use a ready, version-pinned implementation handoff. Do not poll independent workers.
Copy EVERY existing acceptance criterion verbatim from the current work objective (or session_info.workGoal.acceptance when a refresh is needed), including the original-objective criterion; append new criteria rather than replacing the list. Explicitly report each criterion's verified state and current-attempt evidenceCallIds. Leave unmet criteria unverified; never infer that specific subcriteria automatically verify the original objective.
If only part is done, record continue with the next action and keep working. For a genuine blocker, name the exact missing input/permission/external result and leave unverified criteria open.
Cancellation/interruption disarms work: never replay uncertain effects. A resumed attempt must inspect recorded effects before repeating any operation. Existing permission, context, queue, worker and budget guards still apply.`;
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
  if (missingCriteria.length) {
    throw new Error(`Reports must preserve existing acceptance criteria verbatim. Missing criteria: ${JSON.stringify(missingCriteria)}. Read session_info.workGoal.acceptance and resubmit the complete list with explicit verified and evidenceCallIds for each item; leave unmet criteria unverified. No work state was changed.`);
  }
  const candidate: ChatWorkGoal = { ...goal, status: args.status === "continue" ? "active" : args.status as ChatWorkGoal["status"],
    reason: args.reason, acceptance: acceptance as ChatWorkGoal["acceptance"], nextAction: args.nextAction as string | undefined,
    ...(args.contract === undefined ? {} : { contract: args.contract as ChatWorkGoal["contract"] }),
    ...(args.phase === undefined ? {} : { phase: args.phase as ChatWorkGoal["phase"] }) };
  if (Array.isArray(acceptance)) {
    acceptance.forEach((item, index) => {
      if (item && Array.isArray(item.evidenceCallIds) && item.evidenceCallIds.length > 32) {
        throw new Error(`acceptance[${index}].evidenceCallIds contains ${item.evidenceCallIds.length} IDs; maximum 32. No work state was changed.`);
      }
    });
  }
  if (!validWorkGoal({ ...candidate, status: "active" }) || !candidate.acceptance.length) {
    throw new Error("Provide 1–32 unique acceptance criteria; preserve existing criteria and leave unmet ones unverified.");
  }
  if (args.status === "continue" && !candidate.nextAction?.trim()) throw new Error("Continuing work requires the next concrete authorized action.");
  for (const item of candidate.acceptance) {
    if (!item.verified) continue;
    if (!item.evidenceCallIds.length || new Set(item.evidenceCallIds).size !== item.evidenceCallIds.length
      || item.evidenceCallIds.some(id => !(reply.toolCalls || []).some(call => call.id === id && eligibleWorkEvidence(call)))) {
      throw invalidEvidenceError(reply);
    }
    assertCurrentWorkerEvidence((reply.toolCalls || []).filter(call => item.evidenceCallIds.includes(call.id)), chat.id, readWorker);
  }
  if (args.status === "resolved" && candidate.acceptance.some(item => !item.verified)) throw new Error("The user objective remains open: every acceptance criterion must be verified before resolution.");
  if (candidate.phase === "delivering" && args.status === "continue") throw new Error("Delivery requires resolved acceptance or a concrete blocked/needs_input handoff, not continued execution.");
  if (args.status === "resolved") candidate.phase = "delivering";
  const reason: WorkGoalTransitionReason = args.status === "continue" ? "agent_continue"
    : args.status === "resolved" ? "agent_claimed_resolved"
      : args.status === "blocked" ? "agent_blocked" : "agent_needs_input";
  chat.workGoal = recordWorkGoalTransition(candidate, candidate.status, reason);
  return JSON.stringify({ recorded: true, goal: candidate, agentClaimNotIndependentCertification: true });
}

export function workEvidenceKey(reply: ChatMessage): string {
  return createHash("sha256").update(JSON.stringify([...new Set((reply.toolCalls || [])
    .filter(call => call.status === "complete" && !["report_work", "finish_debug", "session_info", "record_harness"].includes(call.name))
    .map(call => JSON.stringify([call.name, call.arguments, call.result])))].sort())).digest("hex");
}
