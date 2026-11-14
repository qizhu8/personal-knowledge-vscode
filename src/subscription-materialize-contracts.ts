import { z } from "zod";
import { documentPath, knowledgeArea, resourcePath } from "./document-path.js";

export const subscriptionMaterializeLimits = Object.freeze({
  snapshotBytes: 32 * 1024 * 1024, documents: 4096, markdownBytes: 1_048_576,
  assets: 2048, assetBytes: 16 * 1024 * 1024,
  totalBytes: 32 * 1024 * 1024, depth: 32,
});
const digest = z.string().regex(/^[a-f0-9]{64}$/);
const identity = z.string().min(1).max(256).refine(v => !/[\u0000-\u001f]/.test(v));
export const subscriptionMaterializeSource = z.strictObject({
  subscriptionId: identity, nodeId: identity, shareId: identity, capabilityId: identity,
  brokerName: identity, publisherUser: identity, publisherHost: identity,
  revision: z.number().int().safe().nonnegative(), collectionHash: z.string().regex(/^sha256:[a-f0-9]{64}$/),
});
export const subscriptionMaterializeInput = z.strictObject({
  source: subscriptionMaterializeSource,
  snapshot: z.string(),
  area: knowledgeArea,
  paths: z.array(documentPath).min(1),
}).superRefine((input, context) => {
  if (input.area !== "notes" && Buffer.byteLength(input.snapshot) > subscriptionMaterializeLimits.snapshotBytes) {
    context.addIssue({ code: "custom", path: ["snapshot"], message: "Snapshot byte limit exceeded." });
  }
  if (input.area !== "notes" && input.paths.length > subscriptionMaterializeLimits.documents) {
    context.addIssue({ code: "custom", path: ["paths"], message: "Document count limit exceeded." });
  }
});
const mapping = z.strictObject({
  sourcePath: documentPath, destinationPath: documentPath,
  identity: z.string().nullable(), aliases: z.array(z.string()), sourceAlias: z.string(), destinationAlias: z.string(),
  sha256: digest,
});
const asset = z.strictObject({ sourcePath: resourcePath, destinationPath: resourcePath, sha256: digest, size: z.number().int().nonnegative() });
const previewShape = z.strictObject({
  source: subscriptionMaterializeSource, area: knowledgeArea, forkRoot: resourcePath,
  snapshotSha256: digest, workspaceRevision: digest,
  mappings: z.array(mapping).min(1),
  assets: z.array(asset).max(subscriptionMaterializeLimits.assets),
  totalBytes: z.number().int().nonnegative(),
  destinationAbsent: z.literal(true),
});
const validatePreviewLimits = (value: z.infer<typeof previewShape>, context: z.RefinementCtx) => {
  if (value.area !== "notes" && value.mappings.length > subscriptionMaterializeLimits.documents) {
    context.addIssue({ code: "custom", path: ["mappings"], message: "Document count limit exceeded." });
  }
  if (value.area !== "notes" && value.totalBytes > subscriptionMaterializeLimits.totalBytes) {
    context.addIssue({ code: "custom", path: ["totalBytes"], message: "Materialization byte limit exceeded." });
  }
};
const preview = previewShape.superRefine(validatePreviewLimits);
export const subscriptionMaterializeResultSchema = previewShape
  .extend({ operationId: z.string().uuid(), actorId: identity }).superRefine(validatePreviewLimits);
export const subscriptionMaterializeDefinitions = [
  {
    id: "subscription.materialize.preview", readOnly: true,
    description: "Preview an explicitly supplied pinned plaintext snapshot only. Trusted source capability policy is injected by the host; no remote access. Original fork copies Markdown unchanged and maps paths under the publisher-scoped folk root.",
    input: subscriptionMaterializeInput, output: preview,
  },
  {
    id: "subscription.materialize.plan", readOnly: false,
    description: "Prepare a serialized compound-journal intent; this operation itself performs no writes. Host must lock, reauthorize, revalidate source, workspace and destination pins, durably persist intent and atomically commit receipt/identity indexes. Recovery accepts only exact ordered before/after states; unknown states require reconciliation.",
    input: subscriptionMaterializeInput.extend({ operationId: z.string().uuid(), expectedWorkspaceRevision: digest }),
    output: subscriptionMaterializeResultSchema,
  },
] as const;
export type SubscriptionMaterializeInput = z.infer<typeof subscriptionMaterializeInput>;
export type SubscriptionMaterializePreview = z.infer<typeof preview>;
export type SubscriptionMaterializeResult = z.infer<typeof subscriptionMaterializeResultSchema>;
