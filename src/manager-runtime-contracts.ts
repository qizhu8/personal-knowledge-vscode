import { z } from "zod";
import { managerCompletionContractSchema, managerPlanBudgetSchema } from "./manager-plan.js";

const id = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/);
const positive = z.number().int().safe().positive();
export const managerRuntimeBudget = managerPlanBudgetSchema;
export const managerRuntimeStart = z.strictObject({
  operationId: z.string().uuid(), runId: id, projectId: id,
  contract: managerCompletionContractSchema, budget: managerRuntimeBudget,
});
export const managerRuntimeFeedback = z.strictObject({
  operationId: z.string().uuid(), runId: id, expectedVersion: positive,
  taskId: id.optional(), message: z.string().trim().min(1).max(8192),
  urgent: z.boolean().default(false), goal: z.json().optional(), budget: managerRuntimeBudget.optional(),
});
export const managerRuntimeCancel = z.strictObject({
  operationId: z.string().uuid(), runId: id, expectedVersion: positive,
});
export const managerRuntimeGet = z.strictObject({ runId: id });
export const managerRuntimeEvents = z.strictObject({
  runId: id, afterSeq: z.number().int().safe().nonnegative().default(0),
  limit: positive.max(100).default(50),
});
export const managerRuntimeDefinitions = [
  { id: "manager.runtime.start", readOnly: false, input: managerRuntimeStart, output: z.json(),
    description: "Start a bounded native Manager run; native host authorization is required." },
  { id: "manager.runtime.get", readOnly: true, input: managerRuntimeGet, output: z.json(),
    description: "Read a trusted-owner Manager run." },
  { id: "manager.runtime.events", readOnly: true, input: managerRuntimeEvents, output: z.json(),
    description: "Read ordered durable events after an exclusive run-scoped cursor." },
  { id: "manager.runtime.feedback", readOnly: false, input: managerRuntimeFeedback, output: z.json(),
    description: "Queue feedback with version CAS. Urgent correction fences the affected work." },
  { id: "manager.runtime.cancel", readOnly: false, input: managerRuntimeCancel, output: z.json(),
    description: "Fence the run and request best-effort native cancellation." },
] as const;
export function createManagerRuntimeDefinitions(nativeHostAvailable = false) {
  return nativeHostAvailable ? managerRuntimeDefinitions : managerRuntimeDefinitions.filter(item => item.id !== "manager.runtime.start");
}
export type ManagerRuntimeStart = z.infer<typeof managerRuntimeStart>;
export type ManagerRuntimeFeedback = z.input<typeof managerRuntimeFeedback>;
export type ManagerRuntimeCancel = z.infer<typeof managerRuntimeCancel>;
