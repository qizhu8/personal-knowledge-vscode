import { randomUUID } from "crypto";
import type { ApiChatTool } from "./api-chat-client";
import type { ApiConversation, ChatMessage, ChatPlanningReceipt } from "./api-chat-store";
import { activeTaskContextCheckpoint, currentTaskReport, taskContextInputs, taskContextInputDigest } from "./task-context-checkpoint";
import { validationArtifactPaths, type ValidationArtifactPath, type ValidationArtifactVersion } from "./validation-artifacts";
import { assertCurrentWorkerEvidence } from "./worker-result-versions";

export interface HarnessBinding { recipeRunId?: string; recipeStageId?: string; stepId?: string; parentStepId?: string; stepAttemptId?: string; }
export interface HarnessBudgetReceipt {
  schema: "pkm.chat.budget/v1";
  at: number;
  round: number;
  modelId: string;
  countingMethod: "utf8-byte-estimate";
  requested: { contextWindow: number; outputTokens: number; modelTimeoutMs: number; activeReviewMs?: number; toolRoundReview: number };
  effective: { inputBudget: number; outputTokens: number };
  consumed: { estimatedInputTokens: number; activeMs: number };
  selectedReferenceIds: string[];
  contextPlan?: import("./chat-context").ContextPlanReceipt;
  transport?: import("./api-chat-client").ChatTransportReceipt;
  status: "prepared" | "sent";
  ledger?: import("./chat-budget-ledger").ChatBudgetLedger;
}
export interface HarnessReport {
  schema: "pkm.chat.harness-report/v1";
  id: string;
  at: number;
  attemptId: string;
  taskId?: string;
  source: "agent-report";
  kind: "task" | "planning" | "step" | "validation";
  binding: HarnessBinding;
  goal?: string;
  constraints?: string[];
  acceptance?: string[];
  completed?: string[];
  openQuestions?: string[];
  sourceInputIds?: string[];
  sourceInputDigest?: string;
  artifactVersions?: ValidationArtifactVersion[];
  artifactEvidenceOffset?: number;
  summary?: string;
  status?: "start" | "complete" | "failed" | "ignored";
  reason?: string;
  evidenceCallIds?: string[];
  supersedes?: string;
  planning?: ChatPlanningReceipt;
}

export function assertHarnessRecipeBinding(binding: HarnessBinding, session: Record<string, unknown>,
  readRun: (id: string) => Record<string, unknown>): void {
  if (!binding.recipeRunId) return;
  const owned = new Set(Array.isArray(session.recipeRunIds) ? session.recipeRunIds.filter((id): id is string => typeof id === "string") : []);
  const seen = new Set<string>();
  let id: string | undefined = binding.recipeRunId;
  let current = true;
  while (id) {
    if (!/^recipe_run_[A-Za-z0-9_-]+$/.test(id) || seen.has(id)) throw new Error("Invalid or cyclic Recipe ownership.");
    seen.add(id);
    const run = readRun(id);
    if (run.schema !== "pkm.recipe.run/v1" || run.runId !== id) throw new Error("Recipe Run identity mismatch.");
    if (current) {
      const definition = run.definition as { spec?: { nodes?: Array<{ nodeId?: string }> } } | undefined;
      if (!definition?.spec?.nodes?.some(node => node.nodeId === binding.recipeStageId)) throw new Error("The Recipe Stage is not part of the pinned Run definition.");
      current = false;
    }
    if (owned.has(id)) return;
    const parent = run.parent as { runId?: string; nodeId?: string } | undefined;
    if (!parent?.runId || !/^recipe_run_[A-Za-z0-9_-]+$/.test(parent.runId)) break;
    const parentRun = readRun(parent.runId);
    const nodes = parentRun.nodes as Record<string, { childRunId?: string }> | undefined;
    if (!parent.nodeId || nodes?.[parent.nodeId]?.childRunId !== id) throw new Error("Nested Recipe ownership is not recorded by its parent.");
    id = parent.runId;
  }
  throw new Error("This Recipe Run is not owned by the current Session.");
}

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
  const binding: HarnessBinding = {
    recipeRunId:optional(args.recipeRunId, "recipeRunId", 200),
    recipeStageId:optional(args.recipeStageId, "recipeStageId", 200),
    stepId:optional(args.stepId, "stepId", 200),
    parentStepId:optional(args.parentStepId, "parentStepId", 200),
  };
  if (binding.recipeRunId && !/^recipe_run_[A-Za-z0-9_-]+$/.test(binding.recipeRunId)) throw new Error("Invalid Recipe Run identity.");
  if (!!binding.recipeRunId !== !!binding.recipeStageId) throw new Error("Recipe Run and Stage must be reported together.");
  const reports = chat.messages.flatMap(message => message.taskId === reply.taskId ? message.harnessReports || [] : []);
  const report: HarnessReport = {
    schema:"pkm.chat.harness-report/v1", id:randomUUID(), at:Date.now(), attemptId:reply.progress.attemptId,
    taskId:reply.taskId, source:"agent-report", kind, binding,
    goal:optional(args.goal, "goal"), constraints:strings(args.constraints, "constraints"),
    acceptance:strings(args.acceptance, "acceptance"), completed:strings(args.completed, "completed"),
    openQuestions:strings(args.openQuestions, "openQuestions"), sourceInputIds:strings(args.sourceInputIds, "sourceInputIds"),
    summary:optional(args.summary, "summary"), reason:optional(args.reason, "reason"),
    evidenceCallIds:strings(args.evidenceCallIds, "evidenceCallIds"), supersedes:optional(args.supersedes, "supersedes", 200),
  };
  if (report.supersedes && !reports.some(previous => previous.id === report.supersedes && previous.kind === kind)) throw new Error("supersedes must reference an earlier report of the same kind in this task.");
  for (const id of report.sourceInputIds || []) if (!chat.messages.some(message =>
    message.id === id && message.role === "user" && message.taskId === reply.taskId && !message.workerEventIds?.length && !message.portalReview)) {
    throw new Error(`Source input ${id} is not a user input in this task.`);
  }
  if (new Set(report.evidenceCallIds).size !== (report.evidenceCallIds?.length || 0)) throw new Error("Evidence call identities must not be duplicated.");
  const evidence = (report.evidenceCallIds || []).map(id => {
    const matches = chat.messages.filter(message => message.role === "assistant" && message.taskId === reply.taskId)
      .flatMap(message => (message.toolCalls || []).filter(call => call.id === id));
    if (matches.length > 1) throw new Error(`Evidence call ${id} is ambiguous across recorded responses; use an unambiguous call identity.`);
    if (matches.length !== 1 || matches[0].status === "running" || typeof matches[0].result !== "string") {
      throw new Error(`Evidence call ${id} is not a terminal recorded call with an available result in this task.`);
    }
    return matches[0];
  });
  if (kind === "task") {
    if (!report.goal || !report.sourceInputIds?.length) throw new Error("Task reports require a goal and sourceInputIds; they do not complete the managed Task.");
    const latest = currentHarnessTask(chat);
    if (latest && report.supersedes !== latest.id) throw new Error(`Task updates must supersede the latest task report ${latest.id}; read session_info before reconciling a stale summary.`);
    const latestInput = [...chat.messages].reverse().find(message =>
      message.taskId === reply.taskId && message.role === "user" && !message.workerEventIds?.length && !message.portalReview);
    if (latestInput && !report.sourceInputIds.includes(latestInput.id)) throw new Error(`Task reports must reference the latest user input ${latestInput.id}; reconcile newer requirements before updating the working state.`);
  } else if (kind === "planning") {
    if (!Array.isArray(args.possibilities) || args.possibilities.length > 128) throw new Error("Planning requires at most 128 explicitly reported possibilities; an empty list means direct execution.");
    const possibilities = args.possibilities.map(value => {
      if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid planning possibility.");
      const item = value as Record<string, unknown>;
      if (Object.keys(item).some(key => !["id", "parentId", "label", "summary", "status", "recipeStageId", "reason", "evidenceRefs"].includes(key))) throw new Error("Unknown planning possibility field.");
      if (!["candidate", "selected", "rejected", "blocked", "validated"].includes(String(item.status))) throw new Error("Invalid possibility status.");
      return {
        id:text(item.id, "possibility.id", 200), parentId:optional(item.parentId, "parentId", 200),
        label:text(item.label, "label", 500), summary:optional(item.summary, "summary"),
        status:item.status as ChatPlanningReceipt["possibilities"][number]["status"],
        recipeStageId:optional(item.recipeStageId, "recipeStageId", 200),
        reason:optional(item.reason, "reason"), evidenceRefs:strings(item.evidenceRefs, "evidenceRefs"),
      };
    });
    const byId = new Map(possibilities.map(item => [item.id, item]));
    if (byId.size !== possibilities.length) throw new Error("Planning possibility IDs must be unique.");
    for (const item of possibilities) {
      const visited = new Set([item.id]);
      let parentId = item.parentId;
      while (parentId) {
        if (!byId.has(parentId) || visited.has(parentId)) throw new Error("Planning parents must exist and must not form a cycle.");
        visited.add(parentId); parentId = byId.get(parentId)!.parentId;
      }
    }
    report.planning = { schema:"pkm.chat.planning/v1", at:report.at, recipeRunId:binding.recipeRunId, recipeStageId:binding.recipeStageId, possibilities };
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
        if (binding.recipeRunId && (binding.recipeRunId !== preceding.binding.recipeRunId || binding.recipeStageId !== preceding.binding.recipeStageId)) {
          throw new Error("A validation outcome cannot change its recorded Recipe binding.");
        }
        binding.recipeRunId = preceding.binding.recipeRunId;
        binding.recipeStageId = preceding.binding.recipeStageId;
        if (report.sourceInputIds && JSON.stringify(report.sourceInputIds) !== JSON.stringify(preceding.sourceInputIds)) {
          throw new Error("Validation source inputs changed; finish the previous check and start a new validation.");
        }
        report.sourceInputIds = preceding.sourceInputIds && [...preceding.sourceInputIds];
        report.sourceInputDigest = preceding.sourceInputDigest;
        report.artifactVersions = preceding.artifactVersions;
        report.artifactEvidenceOffset = preceding.artifactEvidenceOffset;
        if (report.status === "complete" && report.artifactVersions && evidence.some(call =>
          !Number.isSafeInteger(report.artifactEvidenceOffset) || report.artifactEvidenceOffset! < 0
          || (reply.toolCalls || []).indexOf(call) < report.artifactEvidenceOffset!
          || !reply.toolCalls?.includes(call) || call.name === "record_harness"
          || !Number.isFinite(call.startedAt) || call.startedAt! < preceding.at
          || !Number.isFinite(call.finishedAt) || call.finishedAt! < call.startedAt!)) {
          throw new Error("File-version validation requires evidence executed in this attempt after its recorded start; run the check again.");
        }
        if (report.status === "complete" && (!latestInput || !report.sourceInputIds?.includes(latestInput.id)
          || report.sourceInputDigest !== taskContextInputDigest(inputs))) {
          throw new Error("Validation source inputs changed; record the old check as failed or ignored and start a new validation.");
        }
      }
    }
    if (kind === "step") {
      if (preceding) {
        if (report.status !== "start" && binding.recipeRunId && (binding.recipeRunId !== preceding.binding.recipeRunId || binding.recipeStageId !== preceding.binding.recipeStageId)) throw new Error("A Step outcome cannot change its recorded Recipe binding.");
        if (!binding.recipeRunId) {
          binding.recipeRunId = preceding.binding.recipeRunId;
          binding.recipeStageId = preceding.binding.recipeStageId;
        }
      }
      if (preceding && args.parentStepId !== undefined && binding.parentStepId !== preceding.binding.parentStepId) throw new Error("Step ownership cannot change within an attempt.");
      binding.parentStepId ??= preceding?.binding.parentStepId;
      if (binding.parentStepId) {
        const parent = [...reply.harnessReports || []].reverse().find(previous => previous.kind === "step" && previous.binding.stepId === binding.parentStepId);
        if (binding.parentStepId === binding.stepId || !parent || report.status === "start" && parent.status !== "start") throw new Error("A nested Step requires its recorded parent, running when the child starts.");
      }
      if (report.status === "complete") {
        const children = new Map((reply.harnessReports || []).filter(previous => previous.kind === "step")
          .map(previous => [previous.binding.stepId, previous]));
        if ([...children.values()].some(child => {
          if (child.status !== "start") return false;
          let parentId = child.binding.parentStepId;
          const seen = new Set<string>();
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
    if (kind === "validation" && report.status === "complete" && evidence.some(call => call.status === "failed") && !report.reason) {
      throw new Error("Completing validation with failed tool evidence requires an explicit reason explaining the expected failure or superseding successful evidence. Tool status alone does not prove acceptance.");
    }
  }
  return report;
}

export function createHarnessReportTool(chat: ApiConversation, reply: ChatMessage, commit: (report: HarnessReport) => void,
  captureArtifacts?: (paths: ValidationArtifactPath[], signal: AbortSignal) => Promise<ValidationArtifactVersion[]>,
  verifyEvidence?: (calls: NonNullable<ChatMessage["toolCalls"]>) => void): ApiChatTool {
  const string = { type:"string", maxLength:4000 };
  const array = { type:"array", maxItems:64, items:string };
  return {
    name:"record_harness",
    description:"Record explicit public task state, planning summaries, Step lifecycle or validation evidence for this attempt. Not hidden reasoning. Does not execute an Action, alter Recipe authority or complete a managed Task. Use sourceInputIds from session_info for task reports, including the latest user input; updates must supersede the latest task report ID. Reconcile newer user requirements instead of replaying old summaries. Validation start captures current user-input content and the latest source identity (or explicit sourceInputIds including it); outcomes inherit that source and Recipe binding. If inputs change, finish the old check as failed/ignored and start a new validation. Use unambiguous terminal evidenceCallIds with available results for validation. A complete validation citing failed calls requires a reason explaining the expected failure or superseding successful evidence; tool completion alone never proves acceptance. Report Recipe Run/Stage together when known. Nest Steps with a stable parentStepId; start the parent first and finish children before completing it. Plans are optional: direct execution is allowed. Report ignored with its reason; report a new start for each attempt. Preserve prior failed evidence.",
    parameters:{ type:"object", additionalProperties:false, required:["kind"], properties:{
      kind:{ type:"string", enum:["task", "planning", "step", "validation"] },
      recipeRunId:string, recipeStageId:string, stepId:string, parentStepId:string, goal:string,
      constraints:array, acceptance:array, completed:array, openQuestions:array, sourceInputIds:array,
      summary:string, status:{ type:"string", enum:["start","complete","failed","ignored"] },
      artifactPaths:{ type:"array", minItems:1, maxItems:16, description:"Validation start only: workspace-relative files to bind to Host-computed SHA-256 versions. Outcomes inherit them. Default workspace index is 0; no model-supplied hashes.",
        items:{ type:"object", additionalProperties:false, required:["path"], properties:{ path:{ type:"string", maxLength:1024 }, workspace:{ type:"integer", minimum:0 } } } },
      reason:string, evidenceCallIds:array, supersedes:string,
      possibilities:{ type:"array", maxItems:128, items:{ type:"object", additionalProperties:false, required:["id","label","status"], properties:{
        id:string, parentId:string, label:string, summary:string,
        status:{ type:"string", enum:["candidate","selected","rejected","blocked","validated"] },
        recipeStageId:string, reason:string, evidenceRefs:array
      } } }
    } },
    async execute(args, signal) {
      if (signal.aborted) throw new Error("Request cancelled.");
      let report = validateHarnessReport(chat, reply, args);
      const files = args.artifactPaths !== undefined ? validationArtifactPaths(args.artifactPaths)
        : report.kind === "validation" && report.status === "complete" ? report.artifactVersions : undefined;
      if (files) {
        if (!captureArtifacts) throw new Error("This Host cannot capture validation artifact versions.");
        const versions = await captureArtifacts(files.map(({ path, workspace }) => ({ path, workspace })), signal);
        const current = validateHarnessReport(chat, reply, args);
        if (current.sourceInputDigest !== report.sourceInputDigest) throw new Error("Validation source inputs changed while capturing artifacts; start a new check.");
        if (report.status === "complete" && (versions.length !== report.artifactVersions?.length || versions.some((version, index) => {
          const previous = report.artifactVersions![index];
          return version.root !== previous.root || version.resolvedPath !== previous.resolvedPath || version.sha256 !== previous.sha256 || version.host !== previous.host;
        }))) throw new Error("Validation artifacts changed since start; record failed/ignored and start a new check for the current files.");
        report = { ...current, artifactVersions:versions, ...(current.status === "start"
          ? { at:Date.now(), artifactEvidenceOffset:reply.toolCalls?.length || 0 } : {}) };
      }
      if (signal.aborted) throw new Error("Request cancelled.");
      if (report.kind === "validation" && report.status === "complete") {
        const evidence = chat.messages.filter(message => message.role === "assistant" && message.taskId === reply.taskId)
          .flatMap(message => message.toolCalls || []).filter(call => report.evidenceCallIds?.includes(call.id));
        if (verifyEvidence) verifyEvidence(evidence);
        else assertCurrentWorkerEvidence(evidence, chat.id);
      }
      commit(report);
      return JSON.stringify({ ok:true, reportId:report.id, source:report.source, binding:report.binding,
        ...(report.artifactVersions ? { artifactVersions:report.artifactVersions } : {}),
        effect:"Recorded observation only; original creation receipts may attach Recipe ownership. Managed Task/Recipe execution and completion authority unchanged." });
    },
  };
}

export function currentHarnessTask(chat: ApiConversation): HarnessReport | undefined {
  return currentTaskReport(chat);
}

export function currentHarnessTaskState(chat: ApiConversation) {
  if (!chat.sessionId) return undefined;
  const checkpoint = activeTaskContextCheckpoint(chat);
  const latest = currentHarnessTask(chat);
  const report = latest && (!checkpoint || latest.id !== checkpoint.previousTaskReportId) ? latest : undefined;
  const inputs = chat.messages.filter(message => message.taskId === chat.sessionId && message.role === "user" && !message.workerEventIds?.length && !message.portalReview
    && !checkpoint?.sourceInputIds.includes(message.id));
  const covered = inputs.reduce((last, input, index) => report?.sourceInputIds?.includes(input.id) ? index : last, -1);
  return {
    schema:"pkm.chat.task-working-state/v1" as const, taskId:chat.sessionId,
    authority:"original-user-inputs-and-managed-task-recipe" as const,
    report, pendingInputIds:inputs.slice(covered + 1).map(input => input.id),
    ...(latest && !report ? { supersedesReportId:latest.id } : {}),
    note:"A report is an agent interpretation, not authorization or completion. Pending inputs are newer than its cited sources; reconcile the original instructions before relying on the report.",
  };
}

export function activeHarnessBinding(reply: ChatMessage): HarnessBinding | undefined {
  const steps = new Map((reply.harnessReports || []).filter(report => report.kind === "step")
    .map(report => [report.binding.stepId, report]));
  const running = [...reply.harnessReports || []].reverse().find(report =>
    report.kind === "step" && report.status === "start" && steps.get(report.binding.stepId)?.id === report.id);
  return running ? { ...running.binding } : undefined;
}
