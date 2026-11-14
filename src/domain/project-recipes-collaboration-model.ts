export type CollaborationActorRole = "Lead" | "Worker" | "Reviewer";

export type CollaborationPhase = "assignment" | "work" | "handoff" | "review" | "synthesis" | "completion";

export type CollaborationStatus = "assigned" | "working" | "review" | "synthesis" | "completed" | "blocked" | "timed-out";

export type CollaborationAction =
  | "assign" | "start" | "handoff" | "approve" | "reject"
  | "synthesize" | "complete" | "block" | "timeout" | "resume";

export type CollaborationConvergenceState = "contract-incomplete" | "awaiting-work" | "awaiting-responders" | "awaiting-review" | "awaiting-decision" | "ready-to-complete" | "converged" | "blocked" | "escalated";

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
