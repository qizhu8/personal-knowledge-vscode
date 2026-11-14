import { z } from "zod";
import { syncPlanInputSchema } from "./sync-plan-contracts.js";
import { syncApplyPlanSchema, syncApplyReceiptSchema } from "./sync-apply-contracts.js";
import { retrievalRuntimeDefinitions, retrievalRuntimeModel } from "./retrieval-runtime-contracts.js";
import { subscriptionMaterializeInput, subscriptionMaterializeResultSchema } from "./subscription-materialize-contracts.js";

const uuid = z.string().uuid();
const digest = z.string().regex(/^[a-f0-9]{64}$/);
const indexId = z.string().min(1).max(256);
const checkpoint = z.strictObject({
  indexId, sourceDigest: digest, contentDigest: digest, model: retrievalRuntimeModel,
  state: z.enum(["staged", "qualified", "active"]),
  sourceCount: z.number().int().nonnegative(), chunkCount: z.number().int().nonnegative(),
});
const syncInput = z.strictObject({ sessionId: uuid, input: syncPlanInputSchema });
export const dataRuntimeDefinitions = [
  { id: "sync.apply.preview", readOnly: true, description: "Serialize actual local staged Sync effects from persisted owner decisions; does not contact a remote.",
    input: syncInput, output: syncApplyPlanSchema },
  { id: "sync.apply", readOnly: false, description: "Apply a pinned persisted Sync plan locally with a shared durable intent, exact before/after recovery and global retry receipt.",
    input: syncInput.extend({ operationId: uuid, expectedPlanHash: digest }), output: syncApplyReceiptSchema },
  ...retrievalRuntimeDefinitions,
  { id: "retrieval.runtime.availability", readOnly: true, description: "Report explicit native embedding/index availability; no fallback engine.",
    input: z.strictObject({}), output: z.union([z.strictObject({ available: z.literal(false) }),
      z.strictObject({ available: z.literal(true), indexId, model: retrievalRuntimeModel })]) },
  { id: "retrieval.runtime.stage", readOnly: false, nativeOnly: true, description: "Stage embeddings using the explicitly injected native model and authoritative shared-DB sources.",
    input: z.strictObject({ operationId: uuid }), output: checkpoint },
  { id: "retrieval.runtime.qualify", readOnly: false, nativeOnly: true, description: "Qualify staged native embeddings against current shared-DB membership and source pins.",
    input: z.strictObject({ operationId: uuid, indexId }), output: checkpoint },
  { id: "retrieval.runtime.activate", readOnly: false, nativeOnly: true, description: "CAS activate a qualified embedding checkpoint using exact source and current-index pins.",
    input: z.strictObject({ operationId: uuid, indexId, expectedActiveIndexId: indexId.nullable() }), output: checkpoint },
  { id: "subscription.materialize.apply", readOnly: false, nativeOnly: true,
    description: "Materialize an explicit pinned subscription only with injected native actor, ACL and source policy; caller policy is never accepted.",
    input: z.strictObject({ operationId: uuid, input: subscriptionMaterializeInput, expectedWorkspaceRevision: digest }),
    output: subscriptionMaterializeResultSchema },
] as const;
