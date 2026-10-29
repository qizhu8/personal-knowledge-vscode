import * as fs from "fs";
import * as path from "path";
import { randomUUID } from "crypto";
import { ProjectModelError, ProjectRecord, ProjectSourceLink } from "./project-model";
import { ExecutionProjection, ExecutionSource, projectExecution } from "../runtime/pkm-projection";

export interface ProjectOverviewInput {
  goal?: string;
  successCriteria?: string[];
  status?: ProjectRecord["status"];
  currentMilestone?: string;
  owner?: string;
  deadline?: string;
  autonomyPolicyReference?: string;
}

export const PROJECT_TEMPLATES: Record<string, ProjectOverviewInput> = {
  research: { goal: "Produce a source-backed research synthesis", successCriteria: ["Trace key claims to evidence", "Record inclusion and exclusion reasons"], currentMilestone: "Scope and collect", status: "planned" },
  delivery: { goal: "Deliver a reviewed outcome", successCriteria: ["Verify acceptance criteria", "Retain review evidence"], currentMilestone: "Define outcome", status: "planned" },
};

const fields = ["goal", "successCriteria", "status", "currentMilestone", "owner", "deadline", "autonomyPolicyReference"] as const;
export function updateProjectOverview(project: ProjectRecord, input: ProjectOverviewInput, reason: string, at = new Date().toISOString()): ProjectRecord {
  if (project.deletedAt || project.archivedAt) throw new ProjectModelError("project-inactive", "Restore this Project before editing.");
  const next = { ...project };
  const changes: { field: string; before: unknown; after: unknown }[] = [];
  for (const field of fields) {
    if (input[field] === undefined) continue;
    let value: unknown = input[field];
    if (field === "successCriteria") {
      if (!Array.isArray(value) || value.length > 100 || value.some(item => typeof item !== "string" || item.length > 4000)) throw new ProjectModelError("project-summary-invalid", "Success criteria must be a bounded list of text.");
      value = (value as string[]).map(item => item.trim()).filter(Boolean);
    } else {
      if (typeof value !== "string" || value.length > 8000) throw new ProjectModelError("project-summary-invalid", "Project summary fields must be bounded text.");
      value = value.trim();
    }
    if (field === "status" && !["planned", "active", "completed"].includes(String(value))) throw new ProjectModelError("project-status-invalid", "Invalid Project status.");
    if (field === "deadline" && value && (!/^\d{4}-\d{2}-\d{2}$/.test(String(value)) || !Number.isFinite(Date.parse(String(value)))
      || new Date(String(value)).toISOString().slice(0, 10) !== value)) throw new ProjectModelError("project-deadline-invalid", "Deadline must be a valid ISO calendar date.");
    if (JSON.stringify(project[field] ?? (field === "successCriteria" ? [] : "")) === JSON.stringify(value)) continue;
    changes.push({ field, before: project[field] ?? (field === "successCriteria" ? [] : ""), after: value });
    (next as unknown as Record<string, unknown>)[field] = value;
  }
  if (!changes.length) return project;
  const changedContract = changes.some(change => ["goal", "successCriteria"].includes(change.field));
  if (changedContract && !reason.trim()) throw new ProjectModelError("project-decision-reason-required", "Goal or success criteria changes require an explicit reason.");
  if (reason.length > 8000) throw new ProjectModelError("project-decision-invalid", "Decision reason is too long.");
  const decisionId = `decision_${randomUUID()}`;
  next.version++;
  if (changedContract) next.decisions = [...(project.decisions || []), { decisionId, at, reason: reason.trim(), changes }];
  return projectEvent(next, changedContract ? "decision" : "overview-updated", changedContract ? reason.trim() : "Project overview updated", decisionId, at);
}

export function projectEvent(project: ProjectRecord, kind: string, summary: string, sourceId?: string, at = new Date().toISOString()): ProjectRecord {
  return { ...project, timeline: [...(project.timeline || []), { eventId: `event_${randomUUID()}`, at, kind, summary, ...(sourceId ? { sourceId } : {}) }] };
}

export function linkProjectSource(project: ProjectRecord, kind: ProjectSourceLink["kind"], id: string, at = new Date().toISOString()): ProjectRecord {
  const patterns = { "action-run": /^action_run_[0-9a-f]{32}$/, "recipe-run": /^[A-Za-z][A-Za-z0-9_-]{1,127}$/, "agent-session": /^agent_session_[A-Za-z0-9_-]+$/, chat: /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/ };
  if (!patterns[kind]?.test(id)) throw new ProjectModelError("project-source-invalid", "Invalid Project source identity.");
  if (project.deletedAt || project.archivedAt) throw new ProjectModelError("project-inactive", "Restore this Project before linking work.");
  if ((project.links || []).some(link => link.kind === kind && link.id === id)) return project;
  return projectEvent({ ...project, version: project.version + 1, links: [...(project.links || []), { kind, id, linkedAt: at }] }, "source-linked", `Linked ${kind}`, id, at);
}

export interface CockpitItem {
  id: string;
  kind: string;
  title: string;
  projection: ExecutionProjection;
  owner: string;
  reason: string;
  sourceId: string;
  checkpoint?: RecordValue;
}
export interface CockpitArtifact {
  id: string;
  kind: string;
  sourceId: string;
  evidence: unknown;
}
export interface ProjectCockpit {
  items: CockpitItem[];
  now: Record<"running" | "waiting" | "review" | "blocked", CockpitItem[]>;
  reviewInbox: CockpitItem[];
  artifacts: CockpitArtifact[];
  decisions: unknown[];
  timeline: unknown[];
  diagnostics: string[];
  hasActiveRuns: boolean;
}

type RecordValue = Record<string, any>;
function readRecord(file: string): RecordValue {
  const stat = fs.lstatSync(file);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 4 * 1024 * 1024) throw new Error("Not a bounded regular record");
  const value = JSON.parse(fs.readFileSync(file, "utf8"));
  if (!value || Array.isArray(value) || typeof value !== "object") throw new Error("Invalid record");
  return value;
}
function records(directory: string, diagnostics: string[], nested = false): RecordValue[] {
  if (!fs.existsSync(directory)) return [];
  const result: RecordValue[] = [];
  let entries: fs.Dirent[];
  try {
    if (fs.lstatSync(directory).isSymbolicLink()) { diagnostics.push("Refused symlink execution directory"); return []; }
    entries = fs.readdirSync(directory, { withFileTypes: true });
  }
  catch { diagnostics.push("Execution directory could not be read; inspect runtime before lifecycle changes."); return []; }
  for (const entry of entries.slice(0, 5000)) {
    if (nested ? !entry.isDirectory() || !/^action_run_[0-9a-f]{32}$/.test(entry.name) : !entry.isFile() || !entry.name.endsWith(".json")) continue;
    const file = nested ? path.join(directory, entry.name, "run.json") : path.join(directory, entry.name);
    try {
      const value = readRecord(file);
      if (nested && value.run_id !== entry.name) throw new Error("Run identity mismatch");
      if (!nested) {
        const session = path.basename(directory) === "agent-sessions";
        const id = session ? value.sessionId : value.runId;
        if (typeof id !== "string" || !/^[A-Za-z][A-Za-z0-9_-]{1,127}$/.test(id) || entry.name !== `${id}.json`
          || value.schema !== (session ? "pkm.agent.session/v1" : "pkm.recipe.run/v1")) throw new Error("Execution identity mismatch");
      }
      result.push(value);
    } catch { diagnostics.push(`Unreadable execution record: ${entry.name}`); }
  }
  if (entries.length > 5000) diagnostics.push("Execution projection truncated at 5000 records; inspect runtime before lifecycle changes.");
  return result;
}

interface CockpitSources { actions: RecordValue[]; sessions: RecordValue[]; recipes: RecordValue[]; diagnostics: string[] }
function cockpitSources(store: string): CockpitSources {
  const state = path.join(store, ".pkm", "state");
  const diagnostics: string[] = [];
  return { actions: records(path.join(state, "actions", "runs"), diagnostics, true), sessions: records(path.join(state, "agent-sessions"), diagnostics),
    recipes: records(path.join(state, "recipe-runs"), diagnostics), diagnostics };
}

export function projectCockpits(store: string, projects: ProjectRecord[], collaboration: RecordValue[] = []): Record<string, ProjectCockpit> {
  const sources = cockpitSources(store);
  return Object.fromEntries(projects.map(project => [project.projectId, projectCockpit(store, project, collaboration, sources)]));
}

/** Rebuild from authoritative records on every read; never save executor state in Projects. */
export function projectCockpit(store: string, project: ProjectRecord, collaboration: RecordValue[] = [], sources = cockpitSources(store)): ProjectCockpit {
  const result: ProjectCockpit = { items: [], now: { running: [], waiting: [], review: [], blocked: [] }, reviewInbox: [], artifacts: [], decisions: [...(project.decisions || [])], timeline: [...(project.timeline || [])], diagnostics: [], hasActiveRuns: false };
  result.diagnostics.push(...sources.diagnostics);
  const links = project.links || [];
  const associated = (value: RecordValue, kind: string, id: string) => value.projectId === project.projectId || value.project_id === project.projectId || links.some(link => link.kind === kind && link.id === id);
  const add = (value: RecordValue, source: ExecutionSource, kind: string, id: string, title: string) => {
    const execution = value.execution || {};
    const projection = projectExecution(source, String(source === "action-runtime" ? value.state || "unknown" : value.status || value.state || "unknown"), {
      waiting: execution.phase === "waiting" || value.waiting === true,
      executionPhase: execution.phase, unknownEffect: value.state === "outcome_unknown",
      approvalRequired: value.approvalRequired === true,
    });
    const item: CockpitItem = { id, kind, title, projection, owner: String(value.owner || execution.owner || projection.nextOwner), reason: String(execution.reasonCode || value.reason || projection.reason), sourceId: id };
    result.items.push(item);
    if (kind !== "collaboration" && !projection.terminal) result.hasActiveRuns = true;
    const checkpoints = [...(Array.isArray(value.checkpoints) ? value.checkpoints : []), ...(value.checkpoint ? [value.checkpoint] : []),
      ...(execution.checkpoint ? [execution.checkpoint] : [])];
    const seenCheckpoints = new Set<string>();
    for (const checkpoint of checkpoints) {
      if (!checkpoint || typeof checkpoint !== "object") continue;
      const checkpointId = String(checkpoint.checkpoint_id || checkpoint.checkpointId || "");
      if (!checkpointId || seenCheckpoints.has(checkpointId)) continue;
      seenCheckpoints.add(checkpointId);
      if (projection.state !== "Cancelled" && (checkpoint.state === "waiting" || checkpoint.state === "expired")) {
        result.hasActiveRuns = true;
        const human = !checkpoint.trigger?.kind || checkpoint.trigger.kind === "human";
        const review = human && ["approval", "artifact-review", "decision", "exception"].includes(checkpoint.kind) || checkpoint.state === "expired";
        const cpProjection = projectExecution("action-runtime", review ? "needs-review" : "waiting", { nextOwner: human ? "user" : "executor" });
        result.items.push({ id: `${id}:${checkpointId}`, kind: "checkpoint", title: String(checkpoint.proposal?.title || checkpoint.kind || "Checkpoint"), projection: cpProjection, owner: String(checkpoint.owner || "user"), reason: String(checkpoint.proposal?.description || (typeof checkpoint.proposal === "string" ? checkpoint.proposal : "Inspect exact proposal in the original Run")), sourceId: id,
          checkpoint: Object.fromEntries(["checkpoint_id", "kind", "state", "presentation", "proposal", "proposal_digest", "evidence", "deadline", "timeout_behavior", "answer", "options", "answer_schema", "trigger"].filter(key => checkpoint[key] !== undefined).map(key => [key, checkpoint[key]])) });
      }
      if (checkpoint.evidence) result.artifacts.push({ id: `${id}:${checkpointId}:evidence`, kind: "evidence", sourceId: id, evidence: checkpoint.evidence });
      if (checkpoint.state === "resolved") result.decisions.push({ sourceId: id, checkpointId, kind: checkpoint.kind, answer: checkpoint.answer, reason: checkpoint.reason || "", at: checkpoint.resolved_at });
    }
    for (const [index, approval] of (Array.isArray(value.approvals) ? value.approvals : []).entries()) {
      if (projection.state === "Cancelled" || !approval || !["waiting", "pending", "expired"].includes(approval.state || approval.status)) continue;
      result.hasActiveRuns = true;
      result.items.push({ id: `${id}:approval:${approval.approval_id || approval.id || index}`, kind: "approval", title: String(approval.title || "Approval required"), sourceId: id,
        projection: projectExecution("action-runtime", "needs-review", { nextOwner: "user" }), owner: String(approval.owner || "user"), reason: String(approval.reason || approval.detail || "Review in original execution surface") });
    }
    for (const [index, artifact] of (Array.isArray(value.artifacts) ? value.artifacts : []).entries()) {
      result.artifacts.push({ id: String(artifact?.artifact_id || artifact?.artifactId || `${id}:artifact:${index}`), kind: String(artifact?.kind || "artifact"), sourceId: id, evidence: artifact });
    }
    if (value.evidence) result.artifacts.push({ id: `${id}:evidence`, kind: "evidence", sourceId: id, evidence: value.evidence });
    if (value.output !== undefined || value.outputs !== undefined) result.artifacts.push({ id: `${id}:output`, kind: "output", sourceId: id, evidence: value.output ?? value.outputs });
    if (value.resultArtifact) result.artifacts.push({ id: `${id}:result`, kind: value.artifactType || "artifact", sourceId: id, evidence: { reference: value.resultArtifact, evidenceLinks: value.evidenceLinks, evidenceSummary: value.evidenceSummary } });
    if (value.decisionResult) result.decisions.push({ sourceId: id, result: value.decisionResult, reason: value.evidenceSummary || "", evidenceLinks: value.evidenceLinks });
    for (const receipt of Array.isArray(execution.receipts) ? execution.receipts : []) result.timeline.push({ ...receipt, kind: "execution-receipt", sourceId: id });
    for (const event of Array.isArray(value.events) ? value.events : []) result.timeline.push({ ...event, sourceId: id });
    for (const event of Array.isArray(value.history) ? value.history : []) result.timeline.push({ ...event, kind: "collaboration-transition", sourceId: id });
    return projection;
  };
  const actions = sources.actions;
  for (const run of actions) if (associated(run, "action-run", run.run_id)) add(run, "action-runtime", "action-run", run.run_id, String(run.action_id || "Action Run"));
  const sessions = sources.sessions;
  const projectCollaborations = collaboration.filter(value => value.projectId === project.projectId);
  const linkedRecipeIds = new Set<string>(projectCollaborations.map(value => value.recipeRunId).filter(Boolean));
  const linkedSessionIds = new Set<string>(projectCollaborations.map(value => value.agentSessionId).filter(Boolean));
  for (const session of sessions) if (associated(session, "agent-session", session.sessionId) || linkedSessionIds.has(session.sessionId)) {
    add({ ...session, waiting: session.nativeChat?.progress?.steps?.at(-1)?.status === "waiting" }, "agent-session", "agent-session", session.sessionId, String(session.task || "Agent Session"));
    for (const id of session.recipeRunIds || []) linkedRecipeIds.add(id);
    for (const checkpoint of Array.isArray(session.checkpoints) ? session.checkpoints : []) {
      result.timeline.push({ kind: "agent-checkpoint", sourceId: session.sessionId, at: checkpoint.at || checkpoint.createdAt, sequence: checkpoint.sequence, summary: checkpoint.reason || checkpoint.summary || "Durable Agent Session checkpoint" });
    }
  }
  for (const run of sources.recipes) if (associated(run, "recipe-run", run.runId) || linkedRecipeIds.has(run.runId)) {
    add(run, "recipe-runtime", "recipe-run", run.runId, String(run.recipeName || run.recipeId || "Recipe Run"));
    for (const [nodeId, node] of Object.entries(run.nodes || {}) as [string, RecordValue][]) {
      const humanGate = run.definition?.spec?.nodes?.some((definition: RecordValue) => definition.nodeId === nodeId && definition.kind === "pkm.gate.human/v1");
      if (["running", "blocked", "outcome_unknown", "indeterminate"].includes(node.state) || node.progress?.waitingOn) add({ ...node, waiting: !!node.progress?.waitingOn || humanGate && node.state === "running" }, "recipe-runtime", "recipe-node", `${run.runId}:${nodeId}`, nodeId);
    }
  }
  for (const task of projectCollaborations) add({ ...task, status: task.convergenceState || task.status }, "collaboration", "collaboration", task.collaborationId, task.title);
  for (const link of links.filter(link => link.kind !== "chat")) {
    if (!result.items.some(item => item.id === link.id)) {
      result.hasActiveRuns = true;
      result.diagnostics.push(`Linked execution is missing: ${link.id}; lifecycle changes are guarded.`);
      result.items.push({ id: link.id, sourceId: link.id, title: "Missing linked execution", kind: link.kind, owner: "user", reason: "Inspect retained evidence; state cannot be verified.", projection: projectExecution("action-runtime", "unknown") });
    }
  }
  result.items = [...new Map(result.items.map(item => [item.id, item])).values()];
  result.now.running = result.items.filter(item => ["Running", "Ready"].includes(item.projection.state));
  result.now.waiting = result.items.filter(item => item.projection.state === "Waiting");
  result.now.review = result.items.filter(item => ["Needs review", "Reconciling"].includes(item.projection.state));
  result.now.blocked = result.items.filter(item => item.projection.state === "Blocked");
  result.reviewInbox = result.now.review.filter(item => item.projection.state !== "Needs review" || ["checkpoint", "approval"].includes(item.kind)
    || !result.now.review.some(other => ["checkpoint", "approval"].includes(other.kind) && other.sourceId === item.id));
  result.artifacts = [...new Map(result.artifacts.map(item => [item.id, item])).values()];
  if (result.diagnostics.length) result.hasActiveRuns = true;
  return result;
}

export function projectLifecycle(project: ProjectRecord, action: "archive" | "restore" | "delete", hasActiveRuns: boolean, confirmed: boolean, at = new Date().toISOString()): ProjectRecord {
  if (project.systemKind) throw new ProjectModelError("system-project-protected", "The Default Project cannot be archived or deleted.");
  if (action !== "restore" && hasActiveRuns) throw new ProjectModelError("project-active-runs", "Active, waiting, unverified or review Runs must be resolved before archiving or deleting.");
  if (action === "delete" && (!confirmed || !project.archivedAt)) throw new ProjectModelError("project-delete-confirmation-required", "Archive first, then explicitly confirm removal from the active map. Evidence is retained.");
  const next = { ...project, version: project.version + 1 };
  if (action === "archive") next.archivedAt = at;
  if (action === "delete") next.deletedAt = at;
  if (action === "restore") { delete next.archivedAt; delete next.deletedAt; }
  return projectEvent(next, `project-${action}`, action === "delete" ? "Removed from active map; all evidence retained" : `Project ${action}`, undefined, at);
}
