import { z } from "zod";

const id = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/);
const text = z.string().trim().min(1).max(4000);
const strings = z.array(text).max(256);
const ids = z.array(id).max(1024);
export const managerCompletionContractSchema = z.strictObject({
  schema: z.literal("pkm.manager.completion/v1"),
  goalId: id,
  revision: z.number().int().positive(),
  objective: text,
  scope: strings.min(1),
  nonGoals: strings,
  acceptance: z.array(z.strictObject({
    id, criterion: text, verification: text, e2e: z.boolean(),
  })).min(1).max(256),
  outputs: strings.min(1),
  invariants: strings.min(1),
  stopConditions: strings.min(1),
});
export const managerPlanBudgetSchema = z.strictObject({
  maxWorkers: z.number().int().min(1).max(1000),
  maxConcurrentWorkers: z.number().int().min(1).max(1000),
  maxTasks: z.number().int().min(1).max(1024),
  maxAttemptsPerTask: z.number().int().min(1).max(100),
});
export const managerPlanTaskSchema = z.strictObject({
  taskId: id,
  title: text,
  objective: text,
  phase: z.enum(["worker", "integrator", "verifier", "repair"]),
  dependsOn: ids,
  readScope: strings,
  writeScope: strings.max(16),
  resources: strings.max(16),
  acceptanceIds: ids.min(1),
  verification: text,
  independence: z.strictObject({ traceId: id, rationale: text }),
  trigger: z.enum(["always", "verification-failed"]),
});
export const managerPlanSchema = z.strictObject({
  schema: z.literal("pkm.manager.plan/v1"),
  planId: id,
  revision: z.number().int().positive(),
  contract: managerCompletionContractSchema,
  budget: managerPlanBudgetSchema,
  assessment: z.strictObject({
    kind: z.enum(["parallel", "serial"]),
    rationale: text,
    independentTaskCount: z.number().int().min(1).max(1000),
  }),
  tasks: z.array(managerPlanTaskSchema).min(1).max(1024),
});
export const managerPlannerResponseSchema = z.union([
  managerPlanSchema,
  z.strictObject({ status: z.literal("needsClarification"), questions: z.array(text).min(1).max(32) }),
]);
export type CompletionContract = z.infer<typeof managerCompletionContractSchema>;
export type ManagerPlanBudget = z.infer<typeof managerPlanBudgetSchema>;
export type ManagerPlanTask = z.infer<typeof managerPlanTaskSchema>;
export type ManagerPlan = z.infer<typeof managerPlanSchema>;
export interface ManagerPlanIssue { code: string; path: string; message: string }
export type ManagerPlanValidation =
  | { status: "ready"; plan: Readonly<ManagerPlan>; definitionHash: string; taskDefinitionHashes: Record<string, string> }
  | { status: "needsClarification"; questions: string[] }
  | { status: "invalid"; errors: ManagerPlanIssue[] };
export interface ManagerPlanningRequest {
  planId: string;
  revision: number;
  contract: unknown;
  budget: ManagerPlanBudget;
  context?: string;
  previousPlan?: ManagerPlan;
}
export type ManagerPlanner = (input: {
  request: Readonly<ManagerPlanningRequest>;
  instructions: string;
  outputSchema: typeof managerPlannerResponseSchema;
}) => Promise<unknown>;
