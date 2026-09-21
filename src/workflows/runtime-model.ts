export const RUN_STATES = [
  "draft", "validating", "ready", "running", "pausing", "paused", "cancelling",
  "reconciling", "blocked", "succeeded", "failed", "cancelled", "closed-indeterminate"
] as const;
export const NODE_STATES = [
  "pending", "attempting", "waiting-retry", "checkpointed", "paused", "reconciling",
  "blocked", "succeeded", "failed", "cancelled"
] as const;
export const ATTEMPT_STATES = [
  "planned", "admitted", "executing", "awaiting-evidence", "awaiting-outcome",
  "checkpointed", "reconciling", "succeeded", "failed", "cancelled", "indeterminate"
] as const;

export type RunState = typeof RUN_STATES[number];
export type NodeState = typeof NODE_STATES[number];
export type AttemptState = typeof ATTEMPT_STATES[number];
export type EffectState = "none" | "settled" | "uncertain";

export interface RunRecord {
  runId: string;
  state: RunState;
  version: number;
  deadline: number;
}

export interface NodeRecord {
  nodeId: string;
  state: NodeState;
  version: number;
  currentAttemptId?: string;
  authoritativeAttemptId?: string;
  deadline: number;
}

export interface AttemptRecord {
  attemptId: string;
  number: number;
  state: AttemptState;
  version: number;
  previousAttemptId?: string;
  resumedFromAttemptId?: string;
  checkpointManifestId?: string;
  checkpointUsageCursor?: string;
  reasonReceiptId?: string;
  leaseFence: number;
  leaseActive: boolean;
  resourcesReleased: boolean;
  effectState: EffectState;
  executionDeadline: number;
  evidenceDeadline: number;
  completionCommittedAt?: number;
  outcomeManifestId?: string;
  residualRiskScope?: string;
}

export interface VersionTuple {
  run: number;
  node: number;
  attempt?: number;
}

export interface CommandEnvelope {
  commandId: string;
  fingerprint: string;
  expected: VersionTuple;
}

export interface CommandReceipt {
  commandId: string;
  fingerprint: string;
  kind: string;
  runVersion: number;
  nodeVersion: number;
  attemptVersion?: number;
}

export interface StagedCheckpoint {
  manifestId: string;
  sourceAttemptId: string;
  sourceVersions: VersionTuple;
  leaseFence: number;
  state: "staged" | "abandoned";
}

export interface RuntimeModel {
  run: RunRecord;
  node: NodeRecord;
  attempts: AttemptRecord[];
  receipts: CommandReceipt[];
  stagedCheckpoints: StagedCheckpoint[];
}

export interface CommandResult {
  model: RuntimeModel;
  receipt: CommandReceipt;
  replayed: boolean;
}

export class WorkflowRuntimeError extends Error {
  constructor(public readonly code: string, message: string) {
    super(message);
  }
}

const RUN_TERMINAL = new Set<RunState>(["succeeded", "failed", "cancelled", "closed-indeterminate"]);
const NODE_TERMINAL = new Set<NodeState>(["succeeded", "failed", "cancelled"]);
const ATTEMPT_TERMINAL = new Set<AttemptState>(["checkpointed", "succeeded", "failed", "cancelled", "indeterminate"]);

const RUN_TRANSITIONS: Record<RunState, readonly RunState[]> = {
  draft: ["validating"], validating: ["ready", "blocked", "failed"], ready: ["running", "cancelling", "blocked"],
  running: ["pausing", "cancelling", "reconciling", "blocked", "succeeded", "failed"],
  pausing: ["paused", "reconciling", "blocked"], paused: ["running", "cancelling", "blocked"],
  cancelling: ["reconciling", "blocked", "cancelled"], reconciling: ["running", "blocked", "failed", "cancelled"],
  blocked: ["running", "cancelling", "reconciling", "failed", "cancelled"],
  succeeded: [], failed: [], cancelled: [], "closed-indeterminate": []
};
const NODE_TRANSITIONS: Record<NodeState, readonly NodeState[]> = {
  pending: ["attempting", "paused", "blocked", "cancelled"],
  attempting: ["waiting-retry", "checkpointed", "paused", "reconciling", "blocked", "succeeded", "failed", "cancelled"],
  "waiting-retry": ["attempting", "paused", "blocked", "cancelled"],
  checkpointed: ["attempting", "paused", "blocked", "cancelled"], paused: ["attempting", "blocked", "cancelled"],
  reconciling: ["waiting-retry", "blocked", "succeeded", "failed", "cancelled"],
  blocked: ["attempting", "waiting-retry", "reconciling", "failed", "cancelled"],
  succeeded: [], failed: [], cancelled: []
};
const ATTEMPT_TRANSITIONS: Record<AttemptState, readonly AttemptState[]> = {
  planned: ["admitted", "cancelled"], admitted: ["executing", "cancelled", "reconciling"],
  executing: ["awaiting-evidence", "awaiting-outcome", "checkpointed", "reconciling", "failed", "cancelled"],
  "awaiting-evidence": ["awaiting-outcome", "reconciling", "failed", "cancelled"],
  "awaiting-outcome": ["reconciling", "succeeded", "failed", "cancelled"],
  reconciling: ["succeeded", "failed", "cancelled", "indeterminate"],
  checkpointed: [], succeeded: [], failed: [], cancelled: [], indeterminate: []
};

export function createRuntimeModel(runId: string, nodeId: string, runDeadline: number, nodeDeadline: number): RuntimeModel {
  validateDeadlines(nodeDeadline, runDeadline);
  return {
    run: { runId, state: "draft", version: 1, deadline: runDeadline },
    node: { nodeId, state: "pending", version: 1, deadline: nodeDeadline },
    attempts: [], receipts: [], stagedCheckpoints: []
  };
}

export function transitionRun(model: RuntimeModel, envelope: CommandEnvelope, state: RunState): CommandResult {
  return command(model, envelope, "run-transition", false, current => {
    assertTransition(RUN_TRANSITIONS, current.run.state, state, RUN_TERMINAL);
    if (ordinaryRunTerminal(state) && hasUncertainEffect(current)) fail("effect-unresolved", "An unresolved effect blocks an ordinary terminal Run state.");
    return { ...current, run: { ...current.run, state, version: current.run.version + 1 } };
  });
}

export function transitionNode(model: RuntimeModel, envelope: CommandEnvelope, state: NodeState): CommandResult {
  return command(model, envelope, "node-transition", false, current => {
    assertTransition(NODE_TRANSITIONS, current.node.state, state, NODE_TERMINAL);
    if (NODE_TERMINAL.has(state) && hasUncertainEffect(current)) fail("effect-unresolved", "An unresolved effect blocks a terminal Node state.");
    return { ...current, node: { ...current.node, state, version: current.node.version + 1 } };
  });
}

export function transitionAttempt(model: RuntimeModel, envelope: CommandEnvelope, state: AttemptState, leaseFence?: number): CommandResult {
  return command(model, envelope, "attempt-transition", true, current => {
    const attempt = currentAttempt(current);
    assertFence(attempt, leaseFence);
    assertTransition(ATTEMPT_TRANSITIONS, attempt.state, state, ATTEMPT_TERMINAL);
    if (state === "executing") assertActiveLease(attempt);
    if (ordinaryAttemptTerminal(state) && attempt.effectState === "uncertain") fail("effect-unresolved", "An uncertain effect requires reconciliation.");
    return replaceAttempt(current, { ...attempt, state, version: attempt.version + 1 });
  });
}

export function createAttempt(
  model: RuntimeModel,
  envelope: CommandEnvelope,
  input: {
    attemptId: string;
    executionDeadline: number;
    evidenceDeadline: number;
    leaseFence: number;
    mode: "initial" | "retry" | "resume";
    reasonReceiptId?: string;
    checkpointManifestId?: string;
  }
): CommandResult {
  return command(model, envelope, "attempt-create", false, current => {
    validateDeadlines(input.executionDeadline, input.evidenceDeadline);
    if (input.evidenceDeadline > current.node.deadline || input.evidenceDeadline > current.run.deadline) fail("aggregate-deadline", "Attempt deadlines must fit within Node and Run deadlines.");
    if (current.attempts.some(attempt => attempt.attemptId === input.attemptId)) fail("attempt-id-conflict", "Attempt identity already exists.");
    const previous = latestAttempt(current);
    if (current.node.currentAttemptId) fail("attempt-current", "A Node may have at most one current Attempt.");
    if (input.mode === "initial" && previous) fail("attempt-mode", "Only the first Attempt may be initial.");
    if (input.mode !== "initial" && !previous) fail("attempt-mode", "Retry and resume require a prior Attempt.");
    if (previous && (!ATTEMPT_TERMINAL.has(previous.state) || previous.leaseActive || !previous.resourcesReleased || previous.effectState === "uncertain")) {
      fail("attempt-unsettled", "The prior Attempt is not settled for replacement.");
    }
    if (input.mode === "retry" && !input.reasonReceiptId) fail("retry-reason-required", "Retry requires an exact decision receipt.");
    if (input.mode === "resume" && (!input.checkpointManifestId || previous?.state !== "checkpointed")) fail("resume-checkpoint-required", "Resume requires a checkpointed prior Attempt and manifest.");
    const attempt: AttemptRecord = {
      attemptId: input.attemptId, number: current.attempts.length + 1, state: "planned", version: 1,
      previousAttemptId: previous?.attemptId,
      resumedFromAttemptId: input.mode === "resume" ? previous?.attemptId : undefined,
      checkpointManifestId: input.mode === "resume" ? input.checkpointManifestId : undefined,
      reasonReceiptId: input.mode === "retry" ? input.reasonReceiptId : undefined,
      leaseFence: input.leaseFence, leaseActive: false, resourcesReleased: true, effectState: "none",
      executionDeadline: input.executionDeadline, evidenceDeadline: input.evidenceDeadline
    };
    return {
      ...current,
      node: { ...current.node, state: "attempting", currentAttemptId: attempt.attemptId, version: current.node.version + 1 },
      attempts: [...current.attempts, attempt]
    };
  });
}

export function setAttemptAuthority(
  model: RuntimeModel,
  envelope: CommandEnvelope,
  leaseFence: number,
  leaseActive: boolean,
  resourcesReleased: boolean,
  effectState: EffectState
): CommandResult {
  return command(model, envelope, "attempt-authority", true, current => {
    const attempt = currentAttempt(current);
    assertFence(attempt, leaseFence);
    return replaceAttempt(current, { ...attempt, leaseActive, resourcesReleased, effectState, version: attempt.version + 1 });
  });
}

export function stageCheckpoint(model: RuntimeModel, staged: StagedCheckpoint): RuntimeModel {
  if (model.stagedCheckpoints.some(candidate => candidate.manifestId === staged.manifestId)) fail("manifest-id-conflict", "Checkpoint manifest identity already exists.");
  return { ...model, stagedCheckpoints: [...model.stagedCheckpoints, staged] };
}

export function checkpointAttempt(
  model: RuntimeModel,
  envelope: CommandEnvelope,
  manifestId: string,
  usageCursor: string,
  leaseFence: number
): CommandResult {
  return command(model, envelope, "checkpoint", true, current => commitCheckpoint(current, manifestId, usageCursor, leaseFence));
}

export function recoverStagedCheckpoint(
  model: RuntimeModel,
  envelope: CommandEnvelope,
  manifestId: string,
  outcome: "complete" | "abandon" | "reconcile",
  usageCursor?: string
): CommandResult {
  return command(model, envelope, `checkpoint-recovery-${outcome}`, true, current => {
    const staged = current.stagedCheckpoints.find(candidate => candidate.manifestId === manifestId);
    if (!staged || staged.state !== "staged") fail("staged-checkpoint-missing", "A staged checkpoint is required.");
    const attempt = currentAttempt(current);
    if (staged.sourceAttemptId !== attempt.attemptId) fail("staged-checkpoint-source", "Staged checkpoint source does not match the current Attempt.");
    if (outcome === "complete") {
      if (!usageCursor) fail("usage-cursor-required", "Checkpoint completion requires a usage cursor.");
      assertExpected(staged.sourceVersions, current, true);
      return commitCheckpoint(current, manifestId, usageCursor, staged.leaseFence);
    }
    if (outcome === "abandon") {
      if (!attempt.leaseActive || staged.leaseFence !== attempt.leaseFence) fail("abandon-authority", "Abandonment requires proof of the same active lease.");
      return { ...current, stagedCheckpoints: current.stagedCheckpoints.map(candidate => candidate.manifestId === manifestId ? { ...candidate, state: "abandoned" } : candidate) };
    }
    const fenced = { ...attempt, state: "reconciling" as const, leaseActive: false, leaseFence: attempt.leaseFence + 1, effectState: "uncertain" as const, version: attempt.version + 1 };
    return { ...replaceAttempt(current, fenced), node: { ...current.node, state: "reconciling", version: current.node.version + 1 } };
  });
}

export function acceptOutcome(
  model: RuntimeModel,
  envelope: CommandEnvelope,
  manifestId: string,
  state: "succeeded" | "failed" | "cancelled",
  leaseFence: number,
  now: number
): CommandResult {
  return command(model, envelope, "outcome-accept", true, current => {
    if (current.node.authoritativeAttemptId) fail("outcome-already-authoritative", "A Node may accept exactly one authoritative Attempt outcome.");
    const attempt = currentAttempt(current);
    assertFence(attempt, leaseFence);
    if (attempt.effectState === "uncertain") fail("effect-unresolved", "An uncertain effect cannot produce an ordinary outcome.");
    if (!canFinishEvidence(attempt, now)) fail("evidence-deadline", "The evidence/outcome deadline has expired.");
    assertTransition(ATTEMPT_TRANSITIONS, attempt.state, state, ATTEMPT_TERMINAL);
    const accepted = { ...attempt, state, outcomeManifestId: manifestId, leaseActive: false, resourcesReleased: true, version: attempt.version + 1 };
    return {
      ...replaceAttempt(current, accepted),
      node: { ...current.node, state, currentAttemptId: undefined, authoritativeAttemptId: attempt.attemptId, version: current.node.version + 1 }
    };
  });
}

export function closeIndeterminate(model: RuntimeModel, envelope: CommandEnvelope, trusted: boolean, residualRiskScope: string): CommandResult {
  return command(model, envelope, "close-indeterminate", true, current => {
    if (!trusted || !residualRiskScope.trim()) fail("trusted-close-required", "Trusted authority and residual-risk scope are required.");
    const attempt = currentAttempt(current);
    if (attempt.state !== "reconciling" || attempt.effectState !== "uncertain") fail("indeterminate-not-applicable", "Only an uncertain reconciling Attempt may close indeterminate.");
    const closed = {
      ...attempt, state: "indeterminate" as const, leaseActive: false, resourcesReleased: true,
      residualRiskScope: residualRiskScope.trim(), version: attempt.version + 1
    };
    return {
      ...replaceAttempt(current, closed),
      run: { ...current.run, state: "closed-indeterminate", version: current.run.version + 1 },
      node: { ...current.node, state: "reconciling", currentAttemptId: undefined, version: current.node.version + 1 }
    };
  });
}

export function recordCompletion(model: RuntimeModel, envelope: CommandEnvelope, leaseFence: number, now: number): CommandResult {
  return command(model, envelope, "completion-record", true, current => {
    const attempt = currentAttempt(current);
    assertFence(attempt, leaseFence);
    assertActiveLease(attempt);
    if (now > attempt.executionDeadline) fail("execution-deadline", "New completion is fenced after the execution deadline.");
    if (attempt.state !== "executing") fail("completion-state", "Completion may only be recorded while executing.");
    return replaceAttempt(current, { ...attempt, state: "awaiting-evidence", completionCommittedAt: now, version: attempt.version + 1 });
  });
}

export function validateDeadlines(executionDeadline: number, evidenceDeadline: number): void {
  if (!Number.isFinite(executionDeadline) || !Number.isFinite(evidenceDeadline)) fail("deadline-invalid", "Deadlines must be finite absolute instants.");
  if (evidenceDeadline < executionDeadline) fail("deadline-order", "Evidence deadline must not precede execution deadline.");
}

export function executionAuthority(attempt: AttemptRecord, now: number): "execute" | "checkpoint-or-cancel" {
  return now <= attempt.executionDeadline ? "execute" : "checkpoint-or-cancel";
}

export function canFinishEvidence(attempt: AttemptRecord, now: number): boolean {
  return attempt.completionCommittedAt !== undefined && attempt.completionCommittedAt <= attempt.executionDeadline && now <= attempt.evidenceDeadline;
}

function command(model: RuntimeModel, envelope: CommandEnvelope, kind: string, needsAttempt: boolean, mutate: (model: RuntimeModel) => RuntimeModel): CommandResult {
  const prior = model.receipts.find(receipt => receipt.commandId === envelope.commandId);
  if (prior) {
    if (prior.fingerprint !== envelope.fingerprint) fail("command-conflict", "Command ID was reused with a different canonical request fingerprint.");
    return { model, receipt: prior, replayed: true };
  }
  assertExpected(envelope.expected, model, needsAttempt);
  const changed = mutate(model);
  const attempt = changed.node.currentAttemptId ? currentAttempt(changed) : undefined;
  const receipt: CommandReceipt = {
    commandId: envelope.commandId, fingerprint: envelope.fingerprint, kind,
    runVersion: changed.run.version, nodeVersion: changed.node.version, attemptVersion: attempt?.version
  };
  return { model: { ...changed, receipts: [...changed.receipts, receipt] }, receipt, replayed: false };
}

function commitCheckpoint(model: RuntimeModel, manifestId: string, usageCursor: string, leaseFence: number): RuntimeModel {
  if (!usageCursor.trim()) fail("usage-cursor-required", "Checkpoint requires a usage cursor.");
  const attempt = currentAttempt(model);
  assertFence(attempt, leaseFence);
  assertActiveLease(attempt);
  if (attempt.state !== "executing") fail("checkpoint-state", "Only an executing Attempt may checkpoint.");
  const checkpointed = {
    ...attempt, state: "checkpointed" as const, checkpointManifestId: manifestId, checkpointUsageCursor: usageCursor,
    leaseActive: false, resourcesReleased: true, leaseFence: attempt.leaseFence + 1, version: attempt.version + 1
  };
  return {
    ...replaceAttempt(model, checkpointed),
    node: { ...model.node, state: "checkpointed", currentAttemptId: undefined, version: model.node.version + 1 }
  };
}

function assertExpected(expected: VersionTuple, model: RuntimeModel, needsAttempt: boolean): void {
  if (expected.run !== model.run.version || expected.node !== model.node.version) fail("version-conflict", "Expected Run/Node versions do not match.");
  if (needsAttempt) {
    const attempt = currentAttempt(model);
    if (expected.attempt !== attempt.version) fail("version-conflict", "Expected Attempt version does not match.");
  }
}

function assertFence(attempt: AttemptRecord, leaseFence: number | undefined): void {
  if (leaseFence === undefined || leaseFence !== attempt.leaseFence) fail("lease-fenced", "Lease fence is absent or stale.");
}

function assertActiveLease(attempt: AttemptRecord): void {
  if (!attempt.leaseActive) fail("lease-inactive", "An active lease is required for execution authority.");
}

function assertTransition<T extends string>(table: Record<T, readonly T[]>, from: T, to: T, terminal: ReadonlySet<T>): void {
  if (terminal.has(from)) fail("terminal-immutable", `Terminal state ${from} is immutable.`);
  if (!table[from].includes(to)) fail("transition-illegal", `Transition ${from} -> ${to} is illegal.`);
}

function currentAttempt(model: RuntimeModel): AttemptRecord {
  const attempt = model.attempts.find(candidate => candidate.attemptId === model.node.currentAttemptId);
  if (!attempt) fail("attempt-current-missing", "The Node has no current Attempt.");
  return attempt;
}

function latestAttempt(model: RuntimeModel): AttemptRecord | undefined {
  return model.attempts[model.attempts.length - 1];
}

function replaceAttempt(model: RuntimeModel, replacement: AttemptRecord): RuntimeModel {
  return { ...model, attempts: model.attempts.map(attempt => attempt.attemptId === replacement.attemptId ? replacement : attempt) };
}

function hasUncertainEffect(model: RuntimeModel): boolean {
  return model.attempts.some(attempt => attempt.effectState === "uncertain");
}

function ordinaryRunTerminal(state: RunState): boolean {
  return state === "succeeded" || state === "failed" || state === "cancelled";
}

function ordinaryAttemptTerminal(state: AttemptState): boolean {
  return state === "succeeded" || state === "failed" || state === "cancelled";
}

function fail(code: string, message: string): never {
  throw new WorkflowRuntimeError(code, message);
}