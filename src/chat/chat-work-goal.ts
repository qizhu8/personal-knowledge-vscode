import { createHash, randomUUID } from "crypto";
import type { ApiConversation, ChatMessage } from "./api-chat-store";
import { activeTaskContextCheckpoint } from "./task-context-checkpoint";

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
}

export const workStop = /^\s*(?:(?:please\s+)?(?:stop|pause)(?:\s+(?:(?:the|this|current)\s+)?(?:debugging|investigating|diagnosing|work|investigation|task))?(?:\s+(?:now|for now))?|(?:请|先)?(?:停止|暂停)(?:当前|这次|本次)?(?:调试|排查|调查|debug|任务)?)(?:[.!。！,，;；\n]|$)/i;
export const delegatedWork = /(?:\b(?:please\s+)?(?:debug|investigate|diagnose|fix|implement|build|repair)\s+(?:this|the|my|our|a|an)\b|(?:帮我|请你|请|开始|继续|去).{0,24}(?:debug|调试|排查|调查|修复|修好|实现|开发|解决)|(?:debug|调试|排查).{0,16}(?:吧|一下))/i;
export const rootWorkCriterion = "The original user objective and all subsequent requirements are satisfied.";
const resumeWork = /^\s*(?:continue|resume|继续|恢复)(?:\b|一下|吧|工作|任务|调查|排查|调试|推进|$)/i;
const explanatory = /^\s*(?:(?:what|why|how|explain|describe)\b|为什么|为何|解释|说明|介绍)/i;

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
    && (goal.nextAction === undefined || typeof goal.nextAction === "string" && goal.nextAction.length <= 2000);
}

export function prepareWorkGoal(chat: ApiConversation, inputId: string, text: string, executionDigest: string): void {
  if (workStop.test(text)) {
    if (chat.workGoal && chat.workGoal.status !== "resolved") chat.workGoal.status = "paused";
    return;
  }
  const previous = chat.includeHistory ? chat.workGoal : undefined;
  const unfinished = previous && previous.status !== "resolved";
  const answer = unfinished && ["needs_input", "blocked"].includes(previous.status) && !explanatory.test(text);
  const delegation = delegatedWork.test(text) && !explanatory.test(text)
    && !/^\s*(?:please\s+)?(?:explain|describe)\b/i.test(text)
    && !/^\s*(?:帮我|请你|请)?(?:解释|说明|介绍)/.test(text);
  const explicit = delegation || resumeWork.test(text);
  if (!explicit && !(unfinished && previous.status === "active" && !explanatory.test(text)) && !answer) return;
  if (unfinished) {
    if (previous.executionDigest !== executionDigest) throw new Error("The unfinished goal belongs to another execution context. Resume it in its original context; it was not retargeted.");
    if (["paused", "interrupted"].includes(previous.status) && !explicit) return;
    chat.workGoal = { ...previous, attemptInputId: inputId, status: "active",
      acceptance: previous.acceptance.map(item => ({ ...item, verified: false, evidenceCallIds: [] })),
      reason: undefined, nextAction: undefined };
  } else if (delegation) {
    chat.workGoal = { id: randomUUID(), inputId, attemptInputId: inputId, objective: text, executionDigest, status: "active",
      acceptance: [{ criterion: rootWorkCriterion, verified: false, evidenceCallIds: [] }] };
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
If only part is done, record continue with the next action and keep working. For a genuine blocker, name the exact missing input/permission/external result and leave unverified criteria open.
Cancellation/interruption disarms work: never replay uncertain effects. A resumed attempt must inspect recorded effects before repeating any operation. Existing permission, context, queue, worker and budget guards still apply.`;
}

export function reportWork(chat: ApiConversation, reply: ChatMessage, args: Record<string, unknown>): string {
  const goal = chat.workGoal;
  if (!goal || goal.attemptInputId !== reply.inputId || goal.status === "paused" || goal.status === "interrupted") throw new Error("No active work objective belongs to this attempt.");
  if (!["continue", "resolved", "blocked", "needs_input"].includes(String(args.status))
    || typeof args.reason !== "string" || !args.reason.trim() || args.reason.length > 2000
    || !Array.isArray(args.sourceInputIds) || JSON.stringify(args.sourceInputIds) !== JSON.stringify(workGoalInputs(chat))) {
    throw new Error("Report an outcome, a concrete reason and all ordered sourceInputIds from session_info.workGoal.");
  }
  const acceptance = args.acceptance;
  const candidate: ChatWorkGoal = { ...goal, status: args.status === "continue" ? "active" : args.status as ChatWorkGoal["status"],
    reason: args.reason, acceptance: acceptance as ChatWorkGoal["acceptance"], nextAction: args.nextAction as string | undefined };
  if (!validWorkGoal({ ...candidate, status: "active" }) || !candidate.acceptance.length
    || goal.acceptance.some(previous => !candidate.acceptance.some(item => item.criterion === previous.criterion))) {
    throw new Error("Provide 1–32 unique acceptance criteria; preserve existing criteria and leave unmet ones unverified.");
  }
  if (args.status === "continue" && !candidate.nextAction?.trim()) throw new Error("Continuing work requires the next concrete authorized action.");
  for (const item of candidate.acceptance) {
    if (!item.verified) continue;
    if (!item.evidenceCallIds.length || new Set(item.evidenceCallIds).size !== item.evidenceCallIds.length
      || item.evidenceCallIds.some(id => !(reply.toolCalls || []).some(call => call.id === id && call.status === "complete"
        && !["report_work", "finish_debug", "session_info", "record_harness"].includes(call.name) && typeof call.result === "string"))) {
      throw new Error("Verified acceptance requires unique successful execution/validation call IDs from this attempt, not reports or another attempt.");
    }
  }
  if (args.status === "resolved" && candidate.acceptance.some(item => !item.verified)) throw new Error("The user objective remains open: every acceptance criterion must be verified before resolution.");
  chat.workGoal = candidate;
  return JSON.stringify({ recorded: true, goal: candidate, agentClaimNotIndependentCertification: true });
}

export function workEvidenceKey(reply: ChatMessage): string {
  return createHash("sha256").update(JSON.stringify([...new Set((reply.toolCalls || [])
    .filter(call => call.status === "complete" && !["report_work", "finish_debug", "session_info", "record_harness"].includes(call.name))
    .map(call => JSON.stringify([call.name, call.arguments, call.result])))].sort())).digest("hex");
}
