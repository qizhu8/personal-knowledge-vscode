import {
  managerPlanBudgetSchema, managerPlannerResponseSchema,
  type ManagerPlanner, type ManagerPlanningRequest, type ManagerPlanValidation,
} from "./domain/manager-plan-contracts.js";
import {
  assertManagerContractPreserved, assertManagerPlanDefinitionsFrozen, freezeManagerDefinition,
  managerPlanDefinitionHash, validateManagerCompletionContract, validateManagerPlan,
} from "./domain/manager-plan-validation.js";
import { rootWorkCriterion, workerLimits } from "./domain/manager-plan-original.js";

export * from "./domain/manager-plan-contracts.js";
export * from "./domain/manager-plan-validation.js";

export const managerPlanningInstructions = `Use the existing native Chat Manager as the sole planning authority.
Clarify the original goal, complete scope, measurable acceptance, outputs, invariants and stop conditions before dispatch.
${rootWorkCriterion}
Proactively assess large migrations, features, research and data cleanup for genuinely independent tasks.
Choose k from the explicit supplied worker/task/concurrency/attempt budget, not a hard-coded target of 20.
Do small tasks and a single dependency trace directly; do not invent splits to consume capacity.
Declare unique stable task identities, concrete disjoint write scopes, exclusive resources, read inputs and real prerequisites.
Plan the complete DAG before dispatch. Include implementation workers, Manager integration, read-only whole-goal E2E verification,
and bounded repair triggered only by failed verification. Rerun the same verifier with current version-pinned evidence after repair.
Cover every acceptance criterion through every stage. Reports/tool successes are not semantic completion certificates.
Missing critical acceptance means needsClarification: never lower the original goal, omit scope or fabricate model output.
Preserve frozen task definitions across revisions. Output the supplied structured plan schema or an explicit
{status:"needsClarification",questions:[...]} result when any critical semantic requirement remains unknown.`;

export async function createManagerPlan(request: ManagerPlanningRequest, planner: ManagerPlanner): Promise<ManagerPlanValidation> {
  const contract = validateManagerCompletionContract(request.contract);
  if (contract.status !== "ready") return contract;
  const budget = managerPlanBudgetSchema.safeParse(request.budget);
  if (!budget.success) return { status: "invalid", errors: budget.error.issues.map(issue => ({
    code: "quota", path: `budget.${issue.path.join(".")}`, message: issue.message,
  })) };
  try { workerLimits(budget.data.maxConcurrentWorkers, budget.data.maxWorkers); }
  catch { return { status: "invalid", errors: [{ code: "quota", path: "budget", message: "Concurrent capacity exceeds the worker budget." }] }; }
  if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(request.planId)
    || !Number.isSafeInteger(request.revision) || request.revision < 1
    || request.context !== undefined && (typeof request.context !== "string" || request.context.length > 64_000)) {
    return { status: "invalid", errors: [{ code: "schema", path: "request", message: "Supply bounded context, stable plan identity and a positive revision." }] };
  }
  if (typeof planner !== "function") throw new Error("A native Manager planner model callback must be injected; no deterministic model substitute is provided.");
  const input = freezeManagerDefinition(structuredClone({ ...request, contract: contract.contract, budget: budget.data }));
  const proposed = await planner({ request: input, instructions: managerPlanningInstructions, outputSchema: managerPlannerResponseSchema });
  if (proposed && typeof proposed === "object" && "status" in proposed && proposed.status === "needsClarification") {
    const parsed = managerPlannerResponseSchema.safeParse(proposed);
    if (parsed.success && "status" in parsed.data) return freezeManagerDefinition(parsed.data);
    return { status: "invalid", errors: [{ code: "schema", path: "questions", message: "Native planner clarification requires 1–32 bounded concrete questions and no plan fields." }] };
  }
  const result = validateManagerPlan(proposed);
  if (result.status !== "ready") return result;
  if (result.plan.planId !== input.planId || result.plan.revision !== input.revision
    || managerPlanDefinitionHash(result.plan.contract) !== managerPlanDefinitionHash(contract.contract)
    || managerPlanDefinitionHash(result.plan.budget) !== managerPlanDefinitionHash(budget.data)) {
    return { status: "invalid", errors: [{ code: "authority", path: "", message: "The planner cannot change host plan identity, completion contract or explicit budget." }] };
  }
  if (input.previousPlan) {
    try {
      assertManagerPlanDefinitionsFrozen(input.previousPlan, result.plan);
      if (managerPlanDefinitionHash(input.previousPlan.contract) !== managerPlanDefinitionHash(result.plan.contract)) {
        assertManagerContractPreserved(input.previousPlan.contract, result.plan.contract);
      }
    } catch (error) {
      return { status: "invalid", errors: [{ code: "frozen-definition", path: "", message: String(error instanceof Error ? error.message : error) }] };
    }
  }
  return result;
}
