import { z } from "zod";
import { validWorkGoal } from "./managed-chat-task-original.js";
import { originalManagedTaskActionStartedInput } from "./original-mcp-api-chat-task-execution-contracts.js";
import { originalManagedTaskAdoptionBegin, originalManagedTaskAdoptionStoredProof,
  originalManagedTaskAdoptionSummary } from "./managed-chat-task-adoption-contracts.js";

const uuid = z.string().uuid(), digest = z.string().regex(/^[a-f0-9]{64}$/);
export const managedTaskId = z.string().regex(/^agent_session_[a-f0-9]{32}$/);
export const managedTaskOperationIds = Object.freeze([
  "chat.task.start", "chat.task.attempt.start", "chat.task.attempt.bind", "chat.task.attempt.finish",
  "chat.task.cancel", "chat.task.get", "chat.task.report_work", "chat.task.record_harness",
  "chat.task.action_started",
  "chat.task.adopt",
] as const);
export type ManagedTaskOperation = typeof managedTaskOperationIds[number];
const text = (max: number) => z.string().min(1).max(max);
const mutation = { operationId: uuid };
const begin = z.strictObject({
  ...mutation, taskId: managedTaskId, attemptId: uuid, inputId: uuid, replyId: uuid, requestId: digest,
  chatId: uuid, expectedChatRevision: z.number().int().positive(), prompt: text(16000),
});
const report = z.strictObject({
  ...mutation, status: z.enum(["continue", "resolved", "blocked", "needs_input"]), reason: text(2000),
  sourceInputIds: z.array(uuid).min(1).max(64),
  acceptance: z.array(z.strictObject({ criterion: text(1000), verified: z.boolean(),
    evidenceCallIds: z.array(text(200)).max(32) })).min(1).max(32),
  nextAction: text(2000).optional(), phase: z.enum(["locating", "implementing", "verifying", "delivering"]).optional(),
  contract: z.strictObject({ scope: z.array(text(600)).min(1).max(16), nonGoals: z.array(text(600)).max(16),
    stopWhen: text(1000) }).optional(),
});
const strings = z.array(text(4000)).max(64);
const harness = z.strictObject({
  ...mutation, kind: z.enum(["task", "planning", "step", "validation"]),
  stepId: text(200).optional(), parentStepId: text(200).optional(),
  goal: text(4000).optional(), constraints: strings.optional(), acceptance: strings.optional(),
  completed: strings.optional(), openQuestions: strings.optional(), sourceInputIds: z.array(uuid).max(64).optional(),
  summary: text(4000).optional(), status: z.enum(["start", "complete", "failed", "ignored"]).optional(),
  reason: text(4000).optional(), evidenceCallIds: z.array(text(200)).max(64).optional(), supersedes: text(200).optional(),
  possibilities: z.array(z.strictObject({
    id: text(200), label: text(500), parentId: text(200).optional(), summary: text(4000).optional(),
    status: z.enum(["candidate", "selected", "rejected", "blocked", "validated"]), reason: text(4000).optional(),
    evidenceRefs: strings.optional(),
  })).max(128).optional(),
});
export const managedTaskSnapshot = z.strictObject({
  schema: z.literal("pkm.chat.managed-task/v1"), taskId: managedTaskId, chatId: uuid, title: text(120),
  revision: z.number().int().positive(), chatRevision: z.number().int().positive(),
  status: z.enum(["active", "paused", "cancelled", "interrupted"]),
  goal: z.unknown().refine(validWorkGoal, "Original work-goal state is required."),
  attempt: z.strictObject({ id: uuid, inputId: uuid, replyId: uuid, requestId: digest,
    status: z.enum(["prepared", "bound", "complete", "cancel-requested", "cancelled", "failed", "unknown"]),
    planSha256: digest.nullable() }),
  sourceInputIds: z.array(uuid).max(64), harnessReports: z.array(z.json()).max(256),
  sourceInputs: z.array(z.strictObject({ id: uuid, content: text(16000), sha256: digest })).max(64),
  latestTaskReport: z.json().nullable(), harnessScope: z.literal("current-attempt"),
  taskCompletion: z.literal("not-claimed"), replay: z.literal("never"),
  authority: z.enum(["current-native", "historical-only"]),
  adoption: originalManagedTaskAdoptionSummary.optional(),
});
export type ManagedTaskSnapshot = z.infer<typeof managedTaskSnapshot>;
export const managedTaskDefinitions = [
  { id: "chat.task.adopt", readOnly: false, nativeOnly: true, input: originalManagedTaskAdoptionBegin,
    output: managedTaskSnapshot.extend({ adoptionProof: originalManagedTaskAdoptionStoredProof }),
    description: "Privately admitted atomic adoption of exact ordinary original Task/Goal/input identities with fresh native adoption/send consent; historical acceptance and permissions are never current authority." },
  { id: "chat.task.action_started", readOnly: false, nativeOnly: true,
    input: originalManagedTaskActionStartedInput, output: managedTaskSnapshot,
    description: "Reopen acceptance only for the current authorized durable business-tool intent, before its canonical execution; never a model-invocable control." },
  { id: "chat.task.start", readOnly: false, nativeOnly: true, input: begin, output: managedTaskSnapshot,
    description: "Native-scoped atomic fresh Task/Goal/input/attempt creation on an existing actor-owned Chat. Never starts a provider or restores archive authority." },
  { id: "chat.task.attempt.start", readOnly: false, nativeOnly: true, input: begin, output: managedTaskSnapshot,
    description: "Fresh native consent and current Chat revision create one next attempt; completed responses never complete the Task." },
  { id: "chat.task.attempt.bind", readOnly: false, nativeOnly: true,
    input: z.strictObject({ ...mutation, planSha256: digest }), output: managedTaskSnapshot,
    description: "Pin one native execution-plan intent to the current Task attempt; no caller completion receipt is accepted." },
  { id: "chat.task.attempt.finish", readOnly: false, nativeOnly: true, input: z.strictObject(mutation), output: managedTaskSnapshot,
    description: "Reconcile the actual durable native execution into the same Core transcript. Response completion does not resolve acceptance or complete the Task." },
  { id: "chat.task.cancel", readOnly: false, nativeOnly: true, input: z.strictObject(mutation), output: managedTaskSnapshot,
    description: "Disarm the current Task attempt and pause its goal. Provider cancellation remains a separate owning execution operation, not a claimed rollback." },
  { id: "chat.task.get", readOnly: true, nativeOnly: true, input: z.strictObject({}), output: managedTaskSnapshot,
    description: "Read original inputs, current goal and public Harness reports in the current native Task scope. Reports are not acceptance certificates." },
  { id: "chat.task.report_work", readOnly: false, nativeOnly: true, input: report, output: managedTaskSnapshot,
    description: "Apply SHA-pinned original report_work rules using actual same-attempt Core tool receipts; reports never grant permissions or complete a Task." },
  { id: "chat.task.record_harness", readOnly: false, nativeOnly: true, input: harness, output: managedTaskSnapshot,
    description: "Record original public Task/Step/validation/planning semantics with real terminal Core evidence. No archive, file-version, worker or Recipe authority is inferred." },
] as const;
export type ManagedTaskBegin = z.infer<typeof begin>;
