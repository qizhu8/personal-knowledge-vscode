import { createHash } from "node:crypto";
import {
  managerCompletionContractSchema, managerPlanSchema,
  type CompletionContract, type ManagerPlan, type ManagerPlanIssue, type ManagerPlanValidation,
} from "./manager-plan-contracts.js";
import { assertIndependentWorkerScopes, relativeToolPath, workerLimits, workerScope } from "./manager-plan-original.js";

function canonical(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonical((value as Record<string, unknown>)[key])}`).join(",")}}`;
}
export function managerPlanDefinitionHash(value: unknown): string {
  return createHash("sha256").update(canonical(value)).digest("hex");
}
export function freezeManagerDefinition<T>(value: T): T {
  if (value && typeof value === "object") {
    Object.values(value).forEach(freezeManagerDefinition);
    Object.freeze(value);
  }
  return value;
}
export function managerTaskAttemptId(planId: string, taskId: string, attempt: number): string {
  if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(planId) || !/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(taskId)
    || !Number.isSafeInteger(attempt) || attempt < 1 || attempt > 100) throw new Error("Invalid Manager task attempt identity.");
  return `manager_attempt_${managerPlanDefinitionHash([planId, taskId, attempt])}`;
}
function boundaryError(input: unknown): ManagerPlanIssue[] {
  try {
    const serialized = JSON.stringify(input);
    if (!serialized || serialized.length > 2_000_000) throw new Error();
    return [];
  } catch {
    return [{ code: "boundary", path: "", message: "Manager definitions must be JSON-serializable and at most 2,000,000 characters." }];
  }
}
export function managerCompletionQuestions(input: unknown): string[] {
  const record = input && typeof input === "object" ? input as Record<string, unknown> : {};
  const questions: string[] = [];
  for (const field of ["objective", "scope", "acceptance", "outputs", "invariants", "stopConditions"]) {
    const value = record[field];
    if (value === undefined || value === null || typeof value === "string" && !value.trim()
      || Array.isArray(value) && (!value.length || value.some(item => typeof item === "string" && !item.trim()))) {
      questions.push(`Clarify the full-scope completion contract: ${field}.`);
    }
  }
  if (Array.isArray(record.acceptance)) {
    record.acceptance.forEach((item, index) => {
      if (!item || typeof item !== "object" || typeof item.criterion !== "string" || !item.criterion.trim()
        || typeof item.verification !== "string" || !item.verification.trim()) {
        questions.push(`Clarify acceptance[${index}]: concrete criterion and verification are required.`);
      }
    });
    if (record.acceptance.length && !record.acceptance.some(item => item?.e2e === true)) {
      questions.push("Clarify at least one end-to-end criterion proving the original whole objective, not merely successful subtasks.");
    }
  }
  return questions;
}
export function validateManagerCompletionContract(input: unknown):
  | { status: "ready"; contract: CompletionContract }
  | Exclude<ManagerPlanValidation, { status: "ready" }> {
  if (input !== undefined) {
    const errors = boundaryError(input);
    if (errors.length) return { status: "invalid", errors };
  }
  const questions = managerCompletionQuestions(input);
  if (questions.length) return { status: "needsClarification", questions };
  const parsed = managerCompletionContractSchema.safeParse(input);
  if (!parsed.success) return { status: "invalid", errors: parsed.error.issues.map(issue => ({
    code: "schema", path: issue.path.join("."), message: issue.message,
  })) };
  if (new Set(parsed.data.acceptance.map(item => item.id)).size !== parsed.data.acceptance.length) {
    return { status: "invalid", errors: [{ code: "duplicate-criterion", path: "acceptance", message: "Acceptance identities must be unique." }] };
  }
  return { status: "ready", contract: freezeManagerDefinition(parsed.data) };
}
export function validateManagerPlan(input: unknown): ManagerPlanValidation {
  if (input !== undefined) {
    const errors = boundaryError(input);
    if (errors.length) return { status: "invalid", errors };
  }
  const contract = validateManagerCompletionContract(input && typeof input === "object" ? (input as Record<string, unknown>).contract : undefined);
  if (contract.status !== "ready") return contract;
  const parsed = managerPlanSchema.safeParse(input);
  if (!parsed.success) return { status: "invalid", errors: parsed.error.issues.map(issue => ({
    code: "schema", path: issue.path.join("."), message: issue.message,
  })) };
  const plan = parsed.data;
  const errors: ManagerPlanIssue[] = [];
  const fail = (code: string, path: string, message: string) => errors.push({ code, path, message });
  try { workerLimits(plan.budget.maxConcurrentWorkers, plan.budget.maxWorkers); }
  catch { fail("quota", "budget", "Concurrent capacity must not exceed the explicit worker budget."); }
  if (plan.tasks.length > plan.budget.maxTasks) fail("quota", "tasks", "Task definitions exceed maxTasks.");
  const workers = plan.tasks.filter(task => task.phase === "worker");
  if (!workers.length || workers.length > plan.budget.maxWorkers) fail("quota", "tasks", "Define workers within maxWorkers.");
  if (new Set(plan.tasks.map(task => task.taskId)).size !== plan.tasks.length) fail("duplicate-task", "tasks", "Task IDs must be unique.");
  const tasks = new Map(plan.tasks.map(task => [task.taskId, task]));
  const criteria = new Set(plan.contract.acceptance.map(item => item.id));
  const ancestors = new Map<string, Set<string>>();
  const visiting = new Set<string>();
  const visit = (id: string): Set<string> => {
    if (ancestors.has(id)) return ancestors.get(id)!;
    if (visiting.has(id)) { fail("cycle", `tasks.${id}.dependsOn`, "Dependency graph contains a cycle."); return new Set(); }
    visiting.add(id);
    const found = new Set<string>();
    for (const parent of tasks.get(id)?.dependsOn || []) {
      if (!tasks.has(parent)) { fail("dependency", `tasks.${id}.dependsOn`, `Unknown dependency ${parent}.`); continue; }
      found.add(parent);
      visit(parent).forEach(item => found.add(item));
    }
    visiting.delete(id);
    ancestors.set(id, found);
    return found;
  };
  for (const task of plan.tasks) {
    visit(task.taskId);
    try { workerScope(task); }
    catch { fail("scope", `tasks.${task.taskId}`, "Scopes and resources must meet the native Manager bounded declaration rules."); }
    for (const field of ["dependsOn", "acceptanceIds", "readScope", "writeScope", "resources"] as const) {
      if (new Set(task[field]).size !== task[field].length) fail("duplicate", `tasks.${task.taskId}.${field}`, "Entries must be unique.");
    }
    for (const criterion of task.acceptanceIds) if (!criteria.has(criterion)) {
      fail("coverage", `tasks.${task.taskId}.acceptanceIds`, `Unknown criterion ${criterion}.`);
    }
    for (const field of ["readScope", "writeScope"] as const) for (const path of task[field]) {
      try {
        if (/[*?[\]{}]/.test(path) || relativeToolPath(path) !== path) throw new Error();
      } catch { fail("scope", `tasks.${task.taskId}.${field}`, "Declare concrete canonical workspace-relative paths, without globs or excluded paths."); }
    }
    if (task.phase === "repair" ? task.trigger !== "verification-failed" : task.trigger !== "always") {
      fail("phase", `tasks.${task.taskId}.trigger`, "Only repair stages are conditional on verification failure.");
    }
    if (task.phase === "verifier" && (task.writeScope.length || task.resources.length)) {
      fail("phase", `tasks.${task.taskId}`, "Verifier is read-only; remediation belongs to a separate repair stage.");
    }
  }
  const ordered = (left: string, right: string) => ancestors.get(left)?.has(right) || ancestors.get(right)?.has(left);
  const independentWorkers = workers.filter(task => !workers.some(other => other.taskId !== task.taskId && ancestors.get(task.taskId)?.has(other.taskId)));
  if (plan.assessment.independentTaskCount !== independentWorkers.length
    || (plan.assessment.kind === "serial" ? independentWorkers.length !== 1 : independentWorkers.length < 2)) {
    fail("independence", "assessment", "Assessment must report actual independent root worker count; do not split a continuous trace.");
  }
  for (let index = 0; index < plan.tasks.length; index++) for (const other of plan.tasks.slice(0, index)) {
    const task = plan.tasks[index];
    if (ordered(task.taskId, other.taskId)) continue;
    try { assertIndependentWorkerScopes([task, other]); }
    catch { fail("overlap", `tasks.${task.taskId}`, `Unordered write scopes/exclusive resources conflict with ${other.taskId}.`); }
    const contains = (parent: string, child: string) => parent === child || child.startsWith(`${parent}/`);
    const readConflict = (writes: string[], reads: string[]) => writes.some(write => reads.some(read => contains(write, read) || contains(read, write)));
    if (readConflict(task.writeScope, other.readScope) || readConflict(other.writeScope, task.readScope)) {
      fail("read-write-overlap", `tasks.${task.taskId}`, `Unordered input/write scopes conflict with ${other.taskId}.`);
    }
    if (task.phase === "worker" && other.phase === "worker" && task.independence.traceId === other.independence.traceId) {
      fail("continuous-trace", `tasks.${task.taskId}`, `The same dependency trace cannot be split into parallel workers (${other.taskId}).`);
    }
  }
  const integrators = plan.tasks.filter(task => task.phase === "integrator");
  const verifiers = plan.tasks.filter(task => task.phase === "verifier");
  const repairs = plan.tasks.filter(task => task.phase === "repair");
  if (!integrators.length || !verifiers.length || !repairs.length) fail("phase", "tasks", "Require integrator, end-to-end verifier and bounded conditional repair stages.");
  for (const worker of workers) {
    if (worker.dependsOn.some(id => tasks.get(id)?.phase !== "worker")) fail("phase", `tasks.${worker.taskId}`, "Workers depend only on prerequisite workers.");
    if (!integrators.some(task => ancestors.get(task.taskId)?.has(worker.taskId))) fail("phase", `tasks.${worker.taskId}`, "Every worker needs an integration handoff.");
  }
  for (const task of integrators) if (!workers.some(other => ancestors.get(task.taskId)?.has(other.taskId))
    || task.dependsOn.some(id => !["worker", "integrator"].includes(tasks.get(id)?.phase || ""))) {
    fail("phase", `tasks.${task.taskId}`, "Integration must precede verification and repair.");
  }
  for (const task of verifiers) {
    if (!integrators.every(other => ancestors.get(task.taskId)?.has(other.taskId))
      || !workers.every(other => ancestors.get(task.taskId)?.has(other.taskId))
      || task.dependsOn.some(id => !["integrator", "verifier"].includes(tasks.get(id)?.phase || ""))) {
      fail("phase", `tasks.${task.taskId}`, "Final verification must follow all implementation/integration, never repair definitions.");
    }
  }
  for (const task of repairs) if (!verifiers.some(other => ancestors.get(task.taskId)?.has(other.taskId))
    || task.dependsOn.some(id => !["verifier", "repair"].includes(tasks.get(id)?.phase || ""))) {
    fail("phase", `tasks.${task.taskId}`, "Conditional repair must follow a failed verifier; rerun that verifier against the new pinned result.");
  }
  for (const criterion of criteria) {
    if (!workers.some(task => task.acceptanceIds.includes(criterion))
      || !integrators.some(task => task.acceptanceIds.includes(criterion))
      || !verifiers.some(task => task.acceptanceIds.includes(criterion))
      || !repairs.some(task => task.acceptanceIds.includes(criterion))) {
      fail("coverage", "tasks", `Criterion ${criterion} requires worker, integration, verification and repair coverage.`);
    }
  }
  if (errors.length) return { status: "invalid", errors };
  const taskDefinitionHashes = Object.fromEntries(plan.tasks.map(task => [task.taskId, managerPlanDefinitionHash(task)]));
  return freezeManagerDefinition({ status: "ready", plan, definitionHash: managerPlanDefinitionHash(plan), taskDefinitionHashes });
}
export function assertManagerContractPreserved(previous: CompletionContract, next: CompletionContract): void {
  if (next.goalId !== previous.goalId || next.objective !== previous.objective || next.revision <= previous.revision
    || ["scope", "nonGoals", "outputs", "invariants", "stopConditions"].some(field =>
      previous[field as "scope"].some(value => !next[field as "scope"].includes(value)))
    || previous.acceptance.some(criterion => !next.acceptance.some(item => canonical(item) === canonical(criterion)))) {
    throw new Error("Requirements revisions must preserve the original full goal, critical acceptance, outputs, invariants and stop conditions; superseding authorization belongs to the host.");
  }
}
export function assertManagerPlanDefinitionsFrozen(previous: ManagerPlan, next: ManagerPlan): void {
  if (next.planId !== previous.planId || next.revision <= previous.revision) throw new Error("Plan revisions require stable identity and increasing version.");
  for (const task of previous.tasks) if (!next.tasks.some(item => item.taskId === task.taskId
    && managerPlanDefinitionHash(item) === managerPlanDefinitionHash(task))) {
    throw new Error(`Frozen task ${task.taskId} cannot be replaced or edited. Add new task identities and invalidate old evidence through the host.`);
  }
}
