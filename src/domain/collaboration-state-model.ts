export type CollaborationActorRole = "Lead" | "Worker" | "Reviewer";
export type CollaborationResponsibility = "ownership" | "awareness";
export type CollaborationPhase = "assignment" | "work" | "handoff" | "review" | "synthesis" | "completion";
export type CollaborationStatus = "assigned" | "working" | "review" | "synthesis" | "completed" | "blocked" | "timed-out";
export type CollaborationAction =
  | "assign" | "start" | "handoff" | "approve" | "reject"
  | "synthesize" | "complete" | "block" | "timeout" | "resume";
export type CollaborationConvergenceState = "contract-incomplete" | "awaiting-work" | "awaiting-responders" | "awaiting-review" | "awaiting-decision" | "ready-to-complete" | "converged" | "blocked" | "escalated";
export type CommunicationReceiptKind = "clarify-question" | "assign-work" | "review-request" | "review-decision" | "blocked-escalation" | "handoff" | "progress-update" | "decision-synthesis" | "completion";

export interface CommunicationReceiptTemplate {
  label: string;
  phase: CollaborationPhase;
  actions: Array<CollaborationAction | "none">;
  replyPolicy: "none" | "required" | "optional";
  requiresEvidence: boolean;
  requiresDecision: boolean;
  completionClaim: boolean;
}

export const COMMUNICATION_RECEIPT_TEMPLATES: Record<CommunicationReceiptKind, CommunicationReceiptTemplate> = {
  "clarify-question": { label: "Clarify Question", phase: "work", actions: ["none"], replyPolicy: "required", requiresEvidence: false, requiresDecision: false, completionClaim: false },
  "assign-work": { label: "Assign Work", phase: "assignment", actions: ["assign"], replyPolicy: "required", requiresEvidence: false, requiresDecision: false, completionClaim: false },
  "review-request": { label: "Review Request", phase: "handoff", actions: ["handoff"], replyPolicy: "required", requiresEvidence: true, requiresDecision: false, completionClaim: false },
  "review-decision": { label: "Review Decision", phase: "review", actions: ["approve", "reject"], replyPolicy: "required", requiresEvidence: true, requiresDecision: true, completionClaim: false },
  "blocked-escalation": { label: "Blocked / Escalation", phase: "work", actions: ["block", "timeout"], replyPolicy: "required", requiresEvidence: true, requiresDecision: true, completionClaim: false },
  handoff: { label: "Handoff", phase: "handoff", actions: ["handoff"], replyPolicy: "required", requiresEvidence: true, requiresDecision: false, completionClaim: false },
  "progress-update": { label: "Progress Update", phase: "work", actions: ["none"], replyPolicy: "none", requiresEvidence: true, requiresDecision: false, completionClaim: false },
  "decision-synthesis": { label: "Decision / Synthesis", phase: "synthesis", actions: ["synthesize"], replyPolicy: "required", requiresEvidence: true, requiresDecision: true, completionClaim: false },
  completion: { label: "Completion", phase: "completion", actions: ["complete"], replyPolicy: "none", requiresEvidence: true, requiresDecision: true, completionClaim: true },
};

export interface CollaborationWarning {
  code: string;
  message: string;
  at: string;
}

export interface CollaborationOwnerPartition {
  owner: string;
  scope: string;
}

export interface CollaborationContract {
  objective?: string;
  context?: string;
  expectedOutput?: string;
  artifactType?: string;
  acceptanceCriteria: string[];
  decisionRequired: boolean;
  evidenceLinks: string[];
  evidenceSummary?: string;
  decisionResult?: string;
  resultArtifact?: string;
  blockedWaitingOn: string[];
  completionClaim: boolean;
  primaryOwner?: string;
  ownerPartitions: CollaborationOwnerPartition[];
  resolvedResponders: string[];
  reviewerApprovals: string[];
  expectedReviewers: string[];
}

export interface CollaborationLinks {
  projectId: string;
  threadId: string;
  ganttTaskId?: string;
  agentSessionId?: string;
  recipeRunId?: string;
}

export interface CollaborationMessageMetadata extends CollaborationLinks, CollaborationContract {
  collaborationId: string;
  receiptKind?: CommunicationReceiptKind;
  taskVersion: number;
  actorRole: CollaborationActorRole;
  responsibility: CollaborationResponsibility;
  phase: CollaborationPhase;
  action?: CollaborationAction;
  expectedResponders: string[];
  deadlineAt?: string;
  acknowledgement?: boolean;
  evidenceMatchesContract?: boolean;
  warnings: CollaborationWarning[];
  convergenceState: CollaborationConvergenceState;
  stale?: boolean;
  staleReason?: string;
}

export interface CollaborationHistoryEntry {
  version: number;
  action: CollaborationAction;
  actor: string;
  actorRole: CollaborationActorRole;
  at: string;
  note?: string;
  warnings?: CollaborationWarning[];
  convergenceState?: CollaborationConvergenceState;
}

export interface CollaborationTaskRecord extends CollaborationLinks, CollaborationContract {
  collaborationId: string;
  title: string;
  version: number;
  status: CollaborationStatus;
  phase: CollaborationPhase;
  lead: string;
  owners: string[];
  reviewers: string[];
  expectedResponders: string[];
  deadlineAt?: string;
  warnings: CollaborationWarning[];
  convergenceState: CollaborationConvergenceState;
  history: CollaborationHistoryEntry[];
}

export interface CollaborationTransition {
  collaborationId: string;
  expectedVersion: number;
  action: CollaborationAction;
  actor: string;
  actorRole: CollaborationActorRole;
  at: string;
  note?: string;
  expectedResponders?: string[];
  deadlineAt?: string;
  expectedGanttTaskVersion?: number;
  evidenceLinks?: string[];
  evidenceSummary?: string;
  decisionResult?: string;
  resultArtifact?: string;
  blockedWaitingOn?: string[];
  completionClaim?: boolean;
  resolvedResponders?: string[];
  evidenceMatchesContract?: boolean;
}

export class CollaborationError extends Error {
  constructor(public readonly code: string, message: string) {
    super(message);
  }
}

const ROLE_ACTIONS: Record<CollaborationActorRole, CollaborationAction[]> = {
  Lead: ["assign", "synthesize", "complete", "block", "timeout", "resume"],
  Worker: ["start", "handoff", "block", "resume"],
  Reviewer: ["approve", "reject", "block"],
};

const TRANSITIONS: Record<CollaborationStatus, Partial<Record<CollaborationAction, CollaborationStatus>>> = {
  assigned: { start: "working", block: "blocked", timeout: "timed-out" },
  working: { handoff: "review", block: "blocked", timeout: "timed-out" },
  review: { approve: "synthesis", reject: "working", block: "blocked", timeout: "timed-out" },
  synthesis: { synthesize: "synthesis", complete: "completed", block: "blocked", timeout: "timed-out" },
  completed: {},
  blocked: { resume: "working" },
  "timed-out": { resume: "working" },
};

const STATUS_PHASE: Record<CollaborationStatus, CollaborationPhase> = {
  assigned: "assignment",
  working: "work",
  review: "review",
  synthesis: "synthesis",
  completed: "completion",
  blocked: "work",
  "timed-out": "work",
};

function requiredText(value: unknown, code: string, label: string): string {
  const normalized = String(value || "").trim();
  if (!normalized) throw new CollaborationError(code, `${label} is required.`);
  return normalized;
}

function names(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return [...new Set(value.map(item => String(item || "").trim()).filter(Boolean))].slice(0, 64);
}

function texts(value: unknown, limit = 64): string[] {
  if (!Array.isArray(value)) return [];
  return [...new Set(value.map(item => String(item || "").trim()).filter(Boolean))].slice(0, limit);
}

function ownerPartitions(value: unknown): CollaborationOwnerPartition[] {
  if (!Array.isArray(value)) return [];
  const result: CollaborationOwnerPartition[] = [];
  for (const item of value) {
    if (!item || typeof item !== "object") continue;
    const source = item as Record<string, unknown>;
    const owner = String(source.owner || "").trim();
    const scope = String(source.scope || "").trim();
    if (owner && scope && !result.some(entry => entry.owner === owner)) result.push({ owner, scope });
  }
  return result.slice(0, 64);
}

function warning(code: string, message: string, at: string): CollaborationWarning {
  return { code, message, at: timestamp(at, "collaboration-timestamp-invalid")! };
}

function missingContractFields(contract: CollaborationContract): string[] {
  const missing: string[] = [];
  if (!contract.objective) missing.push("objective");
  if (!contract.context) missing.push("context");
  if (!contract.expectedOutput) missing.push("expected output");
  if (!contract.artifactType) missing.push("artifact type");
  if (!contract.acceptanceCriteria.length) missing.push("acceptance criteria");
  if (!contract.primaryOwner && !contract.ownerPartitions.length) missing.push("primary owner");
  return missing;
}

export function assertCollaborationMessageCanConverge(message: CollaborationMessageMetadata): void {
  if (message.action !== "synthesize" && message.action !== "complete") return;
  const missing = missingContractFields(message);
  if (missing.length) throw new CollaborationError("collaboration-contract-incomplete", `Cannot ${message.action}; missing ${missing.join(", ")}.`);
  if (!message.resultArtifact) throw new CollaborationError("collaboration-output-required", `Cannot ${message.action}; the expected output/artifact is missing.`);
  if (!message.evidenceSummary && !message.evidenceLinks.length) {
    throw new CollaborationError("collaboration-acceptance-evidence-required", `Cannot ${message.action}; acceptance evidence is missing.`);
  }
  if (message.decisionRequired && !message.decisionResult) {
    throw new CollaborationError("collaboration-decision-required", `Cannot ${message.action}; a decision/result is required.`);
  }
  const unresolved = message.expectedResponders.filter(name => !message.resolvedResponders.includes(name));
  if (unresolved.length) throw new CollaborationError("collaboration-responders-unresolved", `Cannot ${message.action}; unresolved required responders: ${unresolved.join(", ")}.`);
  if (message.evidenceMatchesContract === false) {
    throw new CollaborationError("collaboration-evidence-mismatch", "Submitted evidence was explicitly marked as not matching the contract; no semantic inference was performed.");
  }
  const unapproved = message.expectedReviewers.filter(name => !message.reviewerApprovals.includes(name));
  if (unapproved.length) throw new CollaborationError("collaboration-review-approval-required", `Cannot ${message.action}; reviewer approval is missing from: ${unapproved.join(", ")}.`);
  if (message.action === "complete" && !message.completionClaim) {
    throw new CollaborationError("collaboration-completion-claim-required", "Cannot complete; an explicit completion claim is required.");
  }
}

export function communicationReceiptTemplate(value: unknown): CommunicationReceiptTemplate | undefined {
  const kind = String(value || "") as CommunicationReceiptKind;
  return COMMUNICATION_RECEIPT_TEMPLATES[kind];
}

export function validateCommunicationReceipt(message: CollaborationMessageMetadata): void {
  if (!message.receiptKind) return;
  const template = communicationReceiptTemplate(message.receiptKind);
  if (!template) throw new CollaborationError("collaboration-receipt-kind-invalid", "Choose a supported structured communication receipt.");
  if (message.phase !== template.phase) throw new CollaborationError("collaboration-receipt-phase-mismatch", `${template.label} requires ${template.phase} phase.`);
  if (!template.actions.includes(message.action || "none")) {
    throw new CollaborationError("collaboration-receipt-action-mismatch", `${template.label} does not permit ${message.action || "no action"}.`);
  }
  const missing = missingContractFields(message);
  if (missing.length || !message.expectedReviewers.length) {
    throw new CollaborationError("collaboration-receipt-incomplete", `${template.label} requires objective, context/version, expected output, artifact type, acceptance criteria, owner, and reviewer.`);
  }
  if (template.requiresEvidence && !message.evidenceSummary && !message.evidenceLinks.length) {
    throw new CollaborationError("collaboration-receipt-evidence-required", `${template.label} requires evidence.`);
  }
  if (template.requiresDecision && !message.decisionResult) {
    throw new CollaborationError("collaboration-receipt-decision-required", `${template.label} requires a decision/result.`);
  }
  if (template.completionClaim && !message.completionClaim) {
    throw new CollaborationError("collaboration-receipt-completion-claim-required", "Completion requires an explicit completion claim.");
  }
}

export function collaborationConvergenceState(task: Pick<CollaborationTaskRecord,
  "status" | "objective" | "context" | "expectedOutput" | "artifactType" | "acceptanceCriteria" | "decisionRequired"
  | "decisionResult" | "resultArtifact" | "evidenceLinks" | "evidenceSummary" | "expectedResponders" | "resolvedResponders"
  | "reviewers" | "reviewerApprovals" | "blockedWaitingOn" | "completionClaim" | "primaryOwner" | "ownerPartitions"
  | "expectedReviewers">): CollaborationConvergenceState {
  if (task.status === "completed") return "converged";
  if (task.status === "timed-out") return "escalated";
  if (task.status === "blocked" || task.blockedWaitingOn.length) return "blocked";
  if (missingContractFields(task).length) return "contract-incomplete";
  if (task.expectedResponders.some(name => !task.resolvedResponders.includes(name))) return "awaiting-responders";
  if (task.reviewers.some(name => !task.reviewerApprovals.includes(name))) return "awaiting-review";
  if (task.decisionRequired && !task.decisionResult) return "awaiting-decision";
  if (task.resultArtifact && (task.evidenceSummary || task.evidenceLinks.length) && task.completionClaim) return "ready-to-complete";
  return "awaiting-work";
}

function normalizeContract(source: Record<string, unknown>): CollaborationContract {
  const objective = String(source.objective || "").trim();
  const context = String(source.context || "").trim();
  const expectedOutput = String(source.expectedOutput || "").trim();
  const artifactType = String(source.artifactType || "").trim();
  const evidenceSummary = String(source.evidenceSummary || "").trim();
  const decisionResult = String(source.decisionResult || "").trim();
  const resultArtifact = String(source.resultArtifact || "").trim();
  const primaryOwner = String(source.primaryOwner || "").trim();
  return {
    ...(objective ? { objective } : {}),
    ...(context ? { context } : {}),
    ...(expectedOutput ? { expectedOutput } : {}),
    ...(artifactType ? { artifactType } : {}),
    acceptanceCriteria: texts(source.acceptanceCriteria),
    decisionRequired: source.decisionRequired === true,
    evidenceLinks: texts(source.evidenceLinks),
    ...(evidenceSummary ? { evidenceSummary } : {}),
    ...(decisionResult ? { decisionResult } : {}),
    ...(resultArtifact ? { resultArtifact } : {}),
    blockedWaitingOn: names(source.blockedWaitingOn),
    completionClaim: source.completionClaim === true,
    ...(primaryOwner ? { primaryOwner } : {}),
    ownerPartitions: ownerPartitions(source.ownerPartitions),
    resolvedResponders: names(source.resolvedResponders),
    reviewerApprovals: names(source.reviewerApprovals),
    expectedReviewers: names(source.expectedReviewers),
  };
}

function timestamp(value: unknown, code: string): string | undefined {
  if (value == null || value === "") return undefined;
  const normalized = String(value);
  if (!Number.isFinite(Date.parse(normalized))) throw new CollaborationError(code, "Collaboration timestamp is invalid.");
  return new Date(normalized).toISOString();
}

export function normalizeCollaborationMessage(
  value: unknown,
  ownership: { projectId?: string; threadId?: string } = {},
): CollaborationMessageMetadata | undefined {
  if (value == null) return undefined;
  if (!value || typeof value !== "object") throw new CollaborationError("collaboration-invalid", "Collaboration metadata must be an object.");
  const source = value as Record<string, unknown>;
  const actorRole = source.actorRole as CollaborationActorRole;
  const responsibility = source.responsibility as CollaborationResponsibility;
  const phase = source.phase as CollaborationPhase;
  const action = source.action as CollaborationAction | undefined;
  if (!Object.keys(ROLE_ACTIONS).includes(actorRole)) throw new CollaborationError("collaboration-role-invalid", "Choose Lead, Worker, or Reviewer.");
  if (!["ownership", "awareness"].includes(responsibility)) throw new CollaborationError("collaboration-responsibility-invalid", "Choose ownership or awareness.");
  if (!["assignment", "work", "handoff", "review", "synthesis", "completion"].includes(phase)) {
    throw new CollaborationError("collaboration-phase-invalid", "Collaboration phase is invalid.");
  }
  if (action && !ROLE_ACTIONS[actorRole].includes(action)) {
    throw new CollaborationError("collaboration-role-action-invalid", `${actorRole} cannot perform ${action}.`);
  }
  const taskVersion = Number(source.taskVersion);
  if (!Number.isSafeInteger(taskVersion) || taskVersion < 1) throw new CollaborationError("collaboration-version-invalid", "Task version must be a positive integer.");
  const projectId = requiredText(source.projectId || ownership.projectId, "collaboration-project-required", "Project link");
  const threadId = requiredText(source.threadId || ownership.threadId, "collaboration-thread-required", "Thread link");
  if (ownership.projectId && projectId !== ownership.projectId) throw new CollaborationError("collaboration-project-mismatch", "Collaboration Project does not own this Room.");
  if (ownership.threadId && threadId !== ownership.threadId) throw new CollaborationError("collaboration-thread-mismatch", "Collaboration Thread does not own this Room.");
  const contract = normalizeContract(source);
  const warnings = Array.isArray(source.warnings) ? source.warnings.flatMap(item => {
    if (!item || typeof item !== "object") return [];
    const candidate = item as Record<string, unknown>;
    const code = String(candidate.code || "").trim();
    const message = String(candidate.message || "").trim();
    const at = timestamp(candidate.at, "collaboration-warning-timestamp-invalid");
    return code && message && at ? [{ code, message, at }] : [];
  }).slice(0, 64) : [];
  const convergenceState: CollaborationConvergenceState = contract.blockedWaitingOn.length ? "blocked"
    : missingContractFields(contract).length ? "contract-incomplete"
    : names(source.expectedResponders).some(name => !contract.resolvedResponders.includes(name)) ? "awaiting-responders"
    : contract.decisionRequired && !contract.decisionResult ? "awaiting-decision"
    : action === "complete" && contract.completionClaim ? "converged"
    : contract.resultArtifact && (contract.evidenceSummary || contract.evidenceLinks.length) ? "ready-to-complete"
    : "awaiting-work";
  const receiptKind = String(source.receiptKind || "").trim() as CommunicationReceiptKind;
  if (receiptKind && !communicationReceiptTemplate(receiptKind)) {
    throw new CollaborationError("collaboration-receipt-kind-invalid", "Choose a supported structured communication receipt.");
  }
  const normalized: CollaborationMessageMetadata = {
    collaborationId: requiredText(source.collaborationId, "collaboration-id-required", "Collaboration ID"),
    ...(receiptKind ? { receiptKind } : {}),
    taskVersion,
    actorRole,
    responsibility,
    phase,
    action,
    expectedResponders: names(source.expectedResponders),
    projectId,
    threadId,
    ganttTaskId: String(source.ganttTaskId || "").trim() || undefined,
    deadlineAt: timestamp(source.deadlineAt, "collaboration-deadline-invalid"),
    agentSessionId: String(source.agentSessionId || "").trim() || undefined,
    recipeRunId: String(source.recipeRunId || "").trim() || undefined,
    ...contract,
    acknowledgement: source.acknowledgement === true,
    evidenceMatchesContract: typeof source.evidenceMatchesContract === "boolean" ? source.evidenceMatchesContract : undefined,
    warnings,
    convergenceState,
  };
  validateCommunicationReceipt(normalized);
  return normalized;
}

export function createCollaborationTask(input: {
  collaborationId: string; title: string; projectId: string; threadId: string; ganttTaskId?: string;
  lead: string; owners: string[]; reviewers: string[]; expectedResponders?: string[]; deadlineAt?: string;
  agentSessionId?: string; recipeRunId?: string; at: string;
  objective?: string; context?: string; expectedOutput?: string; artifactType?: string; acceptanceCriteria?: string[];
  decisionRequired?: boolean; primaryOwner?: string; ownerPartitions?: CollaborationOwnerPartition[];
}): CollaborationTaskRecord {
  const lead = requiredText(input.lead, "collaboration-lead-required", "Lead");
  const owners = names(input.owners);
  const reviewers = names(input.reviewers);
  if (!owners.length) throw new CollaborationError("collaboration-owner-required", "At least one Worker owner is required.");
  if (!reviewers.length) throw new CollaborationError("collaboration-reviewer-required", "At least one Reviewer is required.");
  const contract = normalizeContract({ ...input, primaryOwner: input.primaryOwner || (owners.length === 1 ? owners[0] : "") });
  if (owners.length > 1) {
    const partitionOwners = new Set(contract.ownerPartitions.map(entry => entry.owner));
    if (contract.ownerPartitions.length !== owners.length || owners.some(owner => !partitionOwners.has(owner))) {
      throw new CollaborationError("collaboration-owner-ambiguous", "Choose one primary Worker owner or explicitly partition every owner's scope.");
    }
  }
  if (contract.primaryOwner && !owners.includes(contract.primaryOwner)) {
    throw new CollaborationError("collaboration-primary-owner-invalid", "Primary owner must be an assigned Worker owner.");
  }
  const missing = missingContractFields(contract);
  if (missing.length) throw new CollaborationError("collaboration-contract-incomplete", `Structured collaboration requires: ${missing.join(", ")}.`);
  const at = timestamp(input.at, "collaboration-timestamp-invalid")!;
  const task: CollaborationTaskRecord = {
    collaborationId: requiredText(input.collaborationId, "collaboration-id-required", "Collaboration ID"),
    title: requiredText(input.title, "collaboration-title-required", "Collaboration title"),
    projectId: requiredText(input.projectId, "collaboration-project-required", "Project link"),
    threadId: requiredText(input.threadId, "collaboration-thread-required", "Thread link"),
    ...(String(input.ganttTaskId || "").trim() ? { ganttTaskId: String(input.ganttTaskId).trim() } : {}),
    ...(String(input.agentSessionId || "").trim() ? { agentSessionId: String(input.agentSessionId).trim() } : {}),
    ...(String(input.recipeRunId || "").trim() ? { recipeRunId: String(input.recipeRunId).trim() } : {}),
    version: 1, status: "assigned", phase: "assignment", lead, owners, reviewers,
    ...contract,
    expectedResponders: names(input.expectedResponders?.length ? input.expectedResponders : owners),
    ...(timestamp(input.deadlineAt, "collaboration-deadline-invalid") ? { deadlineAt: timestamp(input.deadlineAt, "collaboration-deadline-invalid") } : {}),
    warnings: [],
    convergenceState: "awaiting-work",
    history: [{ version: 1, action: "assign", actor: lead, actorRole: "Lead", at, convergenceState: "awaiting-work" }],
  };
  task.convergenceState = collaborationConvergenceState(task);
  task.history[0].convergenceState = task.convergenceState;
  return task;
}

export function normalizeCollaborationTaskRecord(value: CollaborationTaskRecord): CollaborationTaskRecord {
  const source = value as unknown as Record<string, unknown>;
  const contract = normalizeContract({
    ...source,
    primaryOwner: source.primaryOwner || (Array.isArray(source.owners) && source.owners.length === 1 ? source.owners[0] : ""),
  });
  const task = {
    ...value,
    ...contract,
    expectedResponders: names(source.expectedResponders),
    warnings: Array.isArray(source.warnings) ? source.warnings as CollaborationWarning[] : [],
    history: Array.isArray(source.history) ? source.history : [],
  } as CollaborationTaskRecord;
  task.convergenceState = collaborationConvergenceState(task);
  return task;
}

export function transitionCollaborationTask(
  task: CollaborationTaskRecord,
  transition: CollaborationTransition,
): CollaborationTaskRecord {
  if (transition.expectedVersion !== task.version) {
    throw new CollaborationError("collaboration-version-conflict", `Collaboration changed from version ${transition.expectedVersion} to ${task.version}. Refresh and retry.`);
  }
  if (transition.collaborationId !== task.collaborationId) throw new CollaborationError("collaboration-id-mismatch", "Collaboration identity does not match.");
  if (!ROLE_ACTIONS[transition.actorRole]?.includes(transition.action)) {
    throw new CollaborationError("collaboration-role-action-invalid", `${transition.actorRole} cannot perform ${transition.action}.`);
  }
  const actor = requiredText(transition.actor, "collaboration-actor-required", "Actor");
  if (transition.actorRole === "Lead" && actor !== task.lead) throw new CollaborationError("collaboration-not-lead", "Only the assigned Lead can perform this transition.");
  if (transition.actorRole === "Worker" && !task.owners.includes(actor)) throw new CollaborationError("collaboration-not-owner", "Only an assigned Worker owner can perform this transition.");
  if (transition.actorRole === "Reviewer" && !task.reviewers.includes(actor)) throw new CollaborationError("collaboration-not-reviewer", "Only an assigned Reviewer can perform this transition.");
  let nextStatus = TRANSITIONS[task.status][transition.action];
  if (!nextStatus) throw new CollaborationError("collaboration-transition-invalid", `Cannot ${transition.action} while collaboration is ${task.status}.`);
  if (transition.action === "timeout") {
    const deadline = task.deadlineAt ? Date.parse(task.deadlineAt) : NaN;
    const now = Date.parse(transition.at);
    if (!Number.isFinite(deadline) || !Number.isFinite(now) || now < deadline) {
      throw new CollaborationError("collaboration-timeout-not-due", "Collaboration cannot time out before its deadline.");
    }
  }
  const resolvedResponders = [...new Set([...task.resolvedResponders, ...names(transition.resolvedResponders)])];
  const reviewerApprovals = transition.action === "reject" ? []
    : [...new Set([...task.reviewerApprovals, ...(transition.action === "approve" ? [actor] : [])])];
  if (transition.action === "approve" && task.reviewers.some(reviewer => !reviewerApprovals.includes(reviewer))) nextStatus = "review";
  const evidenceLinks = texts(transition.evidenceLinks?.length ? transition.evidenceLinks : task.evidenceLinks);
  const evidenceSummary = String(transition.evidenceSummary || task.evidenceSummary || "").trim() || undefined;
  const decisionResult = String(transition.decisionResult || task.decisionResult || "").trim() || undefined;
  const resultArtifact = String(transition.resultArtifact || task.resultArtifact || "").trim() || undefined;
  const blockedWaitingOn = transition.action === "resume" ? names(transition.blockedWaitingOn)
    : names(transition.blockedWaitingOn?.length ? transition.blockedWaitingOn : task.blockedWaitingOn);
  const completionClaim = transition.completionClaim === true || task.completionClaim;
  const transitionWarnings: CollaborationWarning[] = [];
  if (transition.action === "timeout") {
    const unresolved = task.expectedResponders.filter(name => !resolvedResponders.includes(name));
    if (!unresolved.length) {
      throw new CollaborationError("collaboration-timeout-no-unresolved-responder", "Cannot escalate timeout because every required responder is resolved.");
    }
    transitionWarnings.push(warning(
      "collaboration-responder-timeout",
      `Required responder deadline passed; unresolved: ${unresolved.join(", ")}.`,
      transition.at,
    ));
  }
  if (transition.evidenceMatchesContract === false) {
    transitionWarnings.push(warning("collaboration-evidence-mismatch", "Submitted evidence was explicitly marked as not matching the contract; no semantic inference was performed.", transition.at));
  }
  const completionLike = transition.action === "synthesize" || transition.action === "complete";
  if (completionLike) {
    const missing = missingContractFields(task);
    if (missing.length) throw new CollaborationError("collaboration-contract-incomplete", `Cannot ${transition.action}; missing ${missing.join(", ")}.`);
    if (!resultArtifact) throw new CollaborationError("collaboration-output-required", `Cannot ${transition.action}; the expected output/artifact is missing.`);
    if (!evidenceSummary && !evidenceLinks.length) throw new CollaborationError("collaboration-acceptance-evidence-required", `Cannot ${transition.action}; acceptance evidence is missing.`);
    if (task.decisionRequired && !decisionResult) throw new CollaborationError("collaboration-decision-required", `Cannot ${transition.action}; a decision/result is required.`);
    const unresolved = task.expectedResponders.filter(name => !resolvedResponders.includes(name));
    if (unresolved.length) throw new CollaborationError("collaboration-responders-unresolved", `Cannot ${transition.action}; unresolved required responders: ${unresolved.join(", ")}.`);
    const unapproved = task.reviewers.filter(name => !reviewerApprovals.includes(name));
    if (unapproved.length) throw new CollaborationError("collaboration-review-approval-required", `Cannot ${transition.action}; reviewer approval is missing from: ${unapproved.join(", ")}.`);
    if (transitionWarnings.length) throw new CollaborationError("collaboration-evidence-mismatch", transitionWarnings[0].message);
  }
  if (transition.action === "complete" && !completionClaim) {
    throw new CollaborationError("collaboration-completion-claim-required", "Cannot complete; an explicit completion claim is required.");
  }
  const version = task.version + 1;
  const expectedResponders = names(transition.expectedResponders);
  const deadlineAt = timestamp(transition.deadlineAt, "collaboration-deadline-invalid") || task.deadlineAt;
  const note = String(transition.note || "").trim();
  const updated: CollaborationTaskRecord = {
    ...task,
    version,
    status: nextStatus,
    phase: transition.action === "handoff" ? "handoff" : STATUS_PHASE[nextStatus],
    expectedResponders: expectedResponders.length ? expectedResponders
      : nextStatus === "review" ? task.reviewers
      : nextStatus === "synthesis" ? [task.lead]
      : nextStatus === "working" ? task.owners
      : [],
    evidenceLinks,
    ...(evidenceSummary ? { evidenceSummary } : {}),
    ...(decisionResult ? { decisionResult } : {}),
    ...(resultArtifact ? { resultArtifact } : {}),
    blockedWaitingOn, completionClaim,
    resolvedResponders, reviewerApprovals,
    warnings: [...task.warnings, ...transitionWarnings],
    ...(deadlineAt ? { deadlineAt } : {}),
    history: [...task.history, {
      version, action: transition.action, actor, actorRole: transition.actorRole,
      at: timestamp(transition.at, "collaboration-timestamp-invalid")!, ...(note ? { note } : {}),
      ...(transitionWarnings.length ? { warnings: transitionWarnings } : {}),
    }],
  };
  updated.convergenceState = collaborationConvergenceState(updated);
  updated.history[updated.history.length - 1].convergenceState = updated.convergenceState;
  return updated;
}

export function collaborationGanttProjection(status: CollaborationStatus): { status: "not-started" | "in-progress" | "blocked" | "completed"; progress: number } {
  if (status === "assigned") return { status: "not-started", progress: 0 };
  if (status === "working") return { status: "in-progress", progress: 35 };
  if (status === "review") return { status: "in-progress", progress: 65 };
  if (status === "synthesis") return { status: "in-progress", progress: 85 };
  if (status === "completed") return { status: "completed", progress: 100 };
  return { status: "blocked", progress: status === "timed-out" ? 0 : 35 };
}
