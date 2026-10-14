/** Read-only product vocabulary; these projections never authorize or transition execution. */
export const PKM_OBJECT_KINDS = ["Action", "Recipe", "Run", "Project", "Collaboration"] as const;
export type PkmObjectKind = typeof PKM_OBJECT_KINDS[number];
export const PKM_USER_STATES = ["Planned", "Ready", "Running", "Waiting", "Needs review", "Blocked", "Completed", "Failed", "Cancelled", "Reconciling"] as const;
export type PkmUserState = typeof PKM_USER_STATES[number];
export type ExecutionSource = "recipe-runtime" | "agent-session" | "action-validation" | "action-runtime" | "chat-worker" | "project" | "collaboration";
export interface ExecutionProjection {
  objectKind: PkmObjectKind;
  state: PkmUserState;
  terminal: boolean;
  nextOwner: "user" | "executor" | "reviewer" | "dependency" | "none";
  reason: string;
  resume: string;
}
export const PKM_ENTRY_POINTS = {
  actionWorkbench: "Action", actionValidation: "Action", recipeLibrary: "Recipe",
  recipeExecution: "Run", agentSession: "Run", chatRequest: "Run", chatWorker: "Run",
  project: "Project", projectThread: "Project", ganttTask: "Project", collaboration: "Collaboration",
} as const satisfies Record<string, PkmObjectKind>;

const STATES: Record<ExecutionSource, Record<string, PkmUserState>> = {
  "recipe-runtime": {
    draft: "Planned", pending: "Planned", planned: "Planned", locked: "Planned", available: "Ready", validating: "Running",
    ready: "Ready", admitted: "Ready", running: "Running", executing: "Running", attempting: "Running",
    pausing: "Waiting", paused: "Waiting", checkpointed: "Waiting", "waiting-retry": "Waiting",
    "awaiting-evidence": "Waiting", "awaiting-outcome": "Waiting", cancelling: "Running",
    reconciling: "Reconciling", blocked: "Blocked", succeeded: "Completed", completed: "Completed",
    failed: "Failed", cancelled: "Cancelled", skipped: "Completed", outcome_unknown: "Reconciling", "closed-indeterminate": "Needs review", indeterminate: "Needs review",
  },
  "agent-session": { planned: "Planned", running: "Running", waiting: "Waiting", completed: "Completed", stopped: "Cancelled", failed: "Failed", paused: "Waiting" },
  "action-validation": { queued: "Ready", running: "Running", completed: "Completed", succeeded: "Completed", failed: "Failed", cancelled: "Cancelled" },
  "action-runtime": { queued: "Ready", pending: "Planned", ready: "Ready", running: "Running", waiting: "Waiting", "needs-review": "Needs review", blocked: "Blocked", reconciling: "Reconciling", outcome_unknown: "Reconciling", completed: "Completed", succeeded: "Completed", failed: "Failed", cancelled: "Cancelled" },
  "chat-worker": { idle: "Ready", pending: "Planned", running: "Running", sleeping: "Waiting", paused: "Waiting", "awaiting-input": "Waiting", "waiting-input": "Waiting", "awaiting-result": "Waiting", "new-result": "Needs review", complete: "Completed", completed: "Completed", failed: "Failed", stopped: "Cancelled", cancelled: "Cancelled", interrupted: "Reconciling" },
  project: { "not-started": "Planned", "in-progress": "Running", blocked: "Blocked", completed: "Completed", archived: "Completed" },
  collaboration: { assigned: "Ready", working: "Running", review: "Needs review", synthesis: "Running", completed: "Completed", blocked: "Blocked", "timed-out": "Needs review", "awaiting-review": "Needs review", "awaiting-decision": "Needs review", "awaiting-responders": "Waiting", "awaiting-work": "Ready", "contract-incomplete": "Blocked", "ready-to-complete": "Needs review", converged: "Completed", escalated: "Needs review" },
};
const NEXT: Record<PkmUserState, Pick<ExecutionProjection, "nextOwner" | "reason" | "resume">> = {
  Planned: { nextOwner: "user", reason: "Execution has not been requested.", resume: "Review the plan and start when ready." },
  Ready: { nextOwner: "executor", reason: "Execution is ready or queued.", resume: "Wait for dispatch or use the existing start control." },
  Running: { nextOwner: "executor", reason: "Execution owns the next step.", resume: "Observe progress or use the existing cancel control." },
  Waiting: { nextOwner: "dependency", reason: "Execution is waiting for input or a dependency.", resume: "Resolve the dependency and use the existing resume control." },
  "Needs review": { nextOwner: "reviewer", reason: "A decision or result requires review.", resume: "Review the result or pending decision before continuing." },
  Blocked: { nextOwner: "user", reason: "A prerequisite prevents progress.", resume: "Resolve the blocker and retry using existing controls." },
  Reconciling: { nextOwner: "user", reason: "Execution or effects need verification after interruption.", resume: "Inspect the last reliable checkpoint; do not blindly retry effects." },
  Completed: { nextOwner: "none", reason: "Execution completed.", resume: "Inspect the result." },
  Failed: { nextOwner: "none", reason: "Execution failed.", resume: "Inspect the error before a new attempt." },
  Cancelled: { nextOwner: "none", reason: "Execution was cancelled.", resume: "Inspect any retained evidence before a new attempt." },
};
export function projectExecution(source: ExecutionSource, rawState: string, context: {
  waiting?: boolean; approvalRequired?: boolean; interrupted?: boolean; unknownEffect?: boolean;
  executionPhase?: string;
  nextOwner?: ExecutionProjection["nextOwner"];
} = {}): ExecutionProjection {
  const mapped = STATES[source][rawState];
  let state = mapped || "Needs review";
  const terminal = ["Completed", "Failed", "Cancelled"].includes(state);
  if (context.unknownEffect || context.interrupted || context.executionPhase === "reconciling") state = "Reconciling";
  else if (!terminal && context.approvalRequired) state = "Needs review";
  else if (!terminal && context.waiting) state = "Waiting";
  else if (!terminal && source === "action-runtime" && ["created", "dispatched"].includes(context.executionPhase || "")) state = "Ready";
  const result: ExecutionProjection = {
    objectKind: source === "project" ? "Project" : source === "collaboration" ? "Collaboration"
      : source === "action-validation" ? "Action" : "Run",
    state, terminal: ["Completed", "Failed", "Cancelled"].includes(state), ...NEXT[state],
  };
  if (!mapped) { result.nextOwner = "user"; result.reason = "The underlying state is not mapped; review is required."; }
  if (!result.terminal && state !== "Reconciling") {
    if (source === "recipe-runtime" && rawState === "locked") {
      result.nextOwner = "dependency"; result.reason = "Recipe prerequisites have not been satisfied.";
      result.resume = "Complete prerequisite nodes before this node can start.";
    } else if (state === "Waiting" && ["paused", "checkpointed"].includes(rawState)) {
      result.nextOwner = "user"; result.reason = "Execution is paused at an existing checkpoint.";
      result.resume = "Review the checkpoint and use the existing resume control.";
    } else if (source === "recipe-runtime" && rawState === "waiting-retry") {
      result.nextOwner = "executor"; result.reason = "The existing retry policy is waiting before another attempt.";
      result.resume = "Wait for the scheduled retry or inspect the previous attempt.";
    }
  }
  if (!result.terminal && context.nextOwner && context.nextOwner !== "none") result.nextOwner = context.nextOwner;
  if (!result.terminal && source === "chat-worker" && ["paused", "awaiting-input", "waiting-input"].includes(rawState)) result.nextOwner = "user";
  if (!result.terminal && state !== "Reconciling" && context.approvalRequired) {
    result.nextOwner = "user"; result.reason = "Approval is required under the existing permission mode.";
    result.resume = "Approve or deny using the existing approval control.";
  }
  return result;
}
