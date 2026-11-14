import { z } from "zod";
import { managerCompletionContractSchema, managerPlanBudgetSchema } from "../../src/domain/manager-plan-contracts.ts";
import {
  managerProgressOverviewRequestSchema, managerProgressEventsRequestSchema,
  managerProgressFeedbackRequestSchema,
} from "../../src/domain/manager-progress.ts";

const id = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/);
const documentId = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_-]{0,79}$/);
const number = z.number().int().safe().nonnegative();
const positive = number.positive();
const operationId = z.string().uuid();
const sha = z.string().regex(/^[a-f0-9]{64}$/);

// These are a deliberately smaller surface than the server's catalog.
export const operations = {
  knowledgeList: { operation: "knowledge.document.list", readOnly: true, input: z.strictObject({
    offset: number.max(1_000_000).optional(), limit: positive.max(100).optional(),
    workspaceRevision: sha.optional(), includeDeleted: z.boolean().optional(), area: z.enum(["notes", "skills", "papers"]).optional(),
  }) },
  knowledgeGet: { operation: "knowledge.document.get", readOnly: true, input: z.strictObject({ id: documentId }) },
  knowledgeEdit: { operation: "knowledge.document.update", readOnly: false, input: z.strictObject({
    operationId, id: documentId, expectedRevision: positive, expectedSha256: sha,
    title: z.string().trim().min(1).max(500), content: z.string().max(100_000),
  }) },
  chatList: { operation: "chat.session.list", readOnly: true, input: z.strictObject({
    limit: positive.max(100).optional(), cursor: z.string().min(1).max(1024).optional(), includeArchived: z.boolean().optional(),
  }) },
  chatCreate: { operation: "chat.session.create", readOnly: false, input: z.strictObject({
    id, operationId, expectedRevision: z.literal(0), title: z.string().trim().min(1).max(120),
  }) },
  chatGet: { operation: "chat.session.get", readOnly: true, input: z.strictObject({ id }) },
  chatMessages: { operation: "chat.session.messages", readOnly: true, input: z.strictObject({
    id, limit: positive.max(100).optional(), cursor: z.string().min(1).max(1024).optional(),
    afterSequence: number.optional(),
  }).refine(v => !(v.cursor && v.afterSequence !== undefined)) },
  chatStart: { operation: "chat.turn.start", readOnly: false, input: z.strictObject({
    id, sessionId: id, operationId, expectedRevision: z.literal(0),
    messages: z.array(z.strictObject({ role: z.enum(["user", "assistant", "system"]), content: z.string().max(131072) })).min(1).max(128),
    maxSteps: positive.max(8).optional(), maxOutputTokens: positive.max(8192).optional(),
    maxInputTokens: positive.max(262144).optional(), maxTotalOutputTokens: positive.max(32768).optional(),
    deadlineMs: positive.max(300000).optional(),
  }) },
  chatTurn: { operation: "chat.turn.get", readOnly: true, input: z.strictObject({ id }) },
  chatEvents: { operation: "chat.turn.events", readOnly: true, input: z.strictObject({ id, after: number, limit: positive.max(100).optional() }) },
  chatCancel: { operation: "chat.turn.cancel", readOnly: false, input: z.strictObject({ id, operationId, expectedRevision: positive }) },
  managerStart: { operation: "manager.runtime.start", readOnly: false, input: z.strictObject({
    operationId, runId: id, projectId: id,
    contract: managerCompletionContractSchema, budget: managerPlanBudgetSchema,
  }) },
  managerGet: { operation: "manager.runtime.get", readOnly: true, input: z.strictObject({ runId: id }) },
  managerOverview: { operation: "manager.progress.get", readOnly: true, input: managerProgressOverviewRequestSchema },
  managerEvents: { operation: "manager.progress.events", readOnly: true, input: managerProgressEventsRequestSchema },
  managerFeedback: { operation: "manager.progress.feedback", readOnly: false, input: managerProgressFeedbackRequestSchema },
  managerCancel: { operation: "manager.runtime.cancel", readOnly: false, input: z.strictObject({
    operationId, runId: id, expectedVersion: positive,
  }) },
} as const;
export type OperationKey = keyof typeof operations;
export type OperationInput<K extends OperationKey> = z.input<(typeof operations)[K]["input"]>;
