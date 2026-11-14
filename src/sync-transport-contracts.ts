import { z } from "zod";
import { syncPlanManifestSchema } from "./sync-plan-contracts.js";

export const syncTransportShaSchema = z.string().regex(/^[a-f0-9]{40}$/);
const digest = z.string().regex(/^[a-f0-9]{64}$/);
export const syncTransportPolicySchema = z.strictObject({
  policyId: z.string().uuid(),
  owner: z.string().regex(/^[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,38})$/),
  repository: z.string().regex(/^[a-zA-Z0-9_.-]{1,100}$/).refine(value => value !== "." && value !== ".."),
  branch: z.string().min(1).max(200).refine(value =>
    !/[\x00-\x20\x7f~^:?*[\]\\]/.test(value) && !value.includes("..") && !value.includes("@{")
    && value.split("/").every(part => part && !part.startsWith(".") && !part.endsWith(".") && !part.endsWith(".lock"))),
  secretRef: z.string().uuid(),
  expectedLogin: z.string().min(1).max(100),
  visibility: z.enum(["public", "private"]),
  allowPrivate: z.boolean(),
  profileConsentScope: digest.optional(),
  extensionVersion: z.string().regex(/^\d+\.\d+\.\d+$/),
  approvalId: z.string().uuid(),
});
export type SyncTransportPolicy = z.infer<typeof syncTransportPolicySchema>;

export const syncTransportPinSchema = z.strictObject({
  schema: z.literal("pkm.sync-transport-pin/v1"),
  policyId: z.string().uuid(), commit: syncTransportShaSchema, tree: syncTransportShaSchema,
  manifestBlob: syncTransportShaSchema.nullable(), initialSkillsMount: z.literal(true).optional(),
  manifest: syncPlanManifestSchema, manifestHash: digest,
}).refine(value => (value.manifestBlob === null) === (value.initialSkillsMount === true),
  "Only an initial unmanifested Skills mount may omit the manifest blob.");
export type SyncTransportPin = z.infer<typeof syncTransportPinSchema>;
export const syncTransportPublicationSchema = z.strictObject({
  schema: z.literal("pkm.sync-transport-publication/v1"),
  operationId: z.string().uuid(), policyId: z.string().uuid(), actorId: z.string().min(1).max(200),
  sessionId: z.string().uuid(), revision: z.number().int().safe().positive(),
  sessionHash: digest, sourcePins: z.strictObject({ base: digest, local: digest, remote: digest }),
  expectedCommit: syncTransportShaSchema, expectedTree: syncTransportShaSchema,
  manifest: syncPlanManifestSchema, manifestHash: digest, stagedReceiptId: z.string().uuid(),
  message: z.string().regex(/^PKM sync \d{4}-\d{2}-\d{2}T[\d:.]+Z$/).max(100),
  planHash: digest,
});
export type SyncTransportPublication = z.infer<typeof syncTransportPublicationSchema>;
export const syncTransportStatusSchema = z.strictObject({
  schema: z.literal("pkm.sync-transport-status/v1"),
  operationId: z.string().uuid(), policyId: z.string().uuid(), planHash: digest,
  state: z.enum(["prepared", "blobs-created", "tree-pending", "tree-created", "commit-pending", "commit-created", "ref-pending", "published", "stale", "needs-review"]),
  expectedCommit: syncTransportShaSchema, tree: syncTransportShaSchema.optional(), commit: syncTransportShaSchema.optional(),
});
export type SyncTransportStatus = z.infer<typeof syncTransportStatusSchema>;

// Schema inventory only. These are deliberately not registered in core/HTTP/CLI.
export const syncTransportDefinitions = [
  { id: "sync.transport.status", readOnly: true, input: z.strictObject({ operationId: z.string().uuid() }), output: syncTransportStatusSchema },
  { id: "sync.transport.publish", readOnly: false, input: z.strictObject({ operationId: z.string().uuid(), policyId: z.string().uuid(), approvalId: z.string().uuid() }), output: syncTransportStatusSchema },
] as const;
