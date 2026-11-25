import { z } from "zod";

const digest = z.string().regex(/^[a-f0-9]{64}$/);
const slug = z.string().min(1).max(1024).refine(value =>
  value.split("/").every(part => !!part && !part.startsWith(".") && !/[\\:\u0000-\u001f]/u.test(part)));
const file = z.strictObject({
  key: slug, sha256: digest,
  sourcePath: z.string().min(1).max(2048).optional(),
  notePath: z.string().min(1).max(2048).optional(), noteSha256: digest.optional(),
  stagedPath: z.string().min(1).max(4096).optional(),
  title: z.string().min(1).max(4096).optional(),
});
const sourceDetails = z.discriminatedUnion("domain", [
  z.strictObject({ domain: z.literal("todo"), boards: z.number().int().min(1).max(1024) }),
  z.strictObject({ domain: z.literal("memory"), sourceDatabaseSha256: digest, sourceScopeSha256: digest,
    importPlanSha256: digest, importReceiptSha256: digest, engineIdentity: z.string().min(1).max(512),
    documentIdentity: z.literal("source-derived/v1"),
    records: z.number().int().min(0).max(4096), revisions: z.number().int().min(0).max(100_000) }),
]);
export const originalMcpDomainIntentSchema = z.strictObject({
  schema: z.literal("pkm.original-mcp-domain-intent/v1"),
  domain: z.enum(["todo", "memory"]), root: z.string(), workspaceId: z.string().uuid(),
  custodyPlanSha256: digest, profileSha256: digest, nativeHostReceiptSha256: digest,
  sourceSha256: digest, actorId: z.literal("mcp:external"),
  sourceDetails,
  decisionId: z.string().min(1).max(256), expiresAtMs: z.number().int().positive(),
  files: z.array(file).max(4096), intentSha256: digest,
});
export type OriginalMcpDomainIntent = z.infer<typeof originalMcpDomainIntentSchema>;
export const originalMcpSourceApprovalSchema = originalMcpDomainIntentSchema.pick({
  actorId: true, decisionId: true, expiresAtMs: true,
});
export type OriginalMcpSourceApproval = z.infer<typeof originalMcpSourceApprovalSchema>;
export const originalMcpDomainApprovalRequestSchema = originalMcpDomainIntentSchema.omit({
  decisionId: true, expiresAtMs: true, intentSha256: true,
}).extend({
  schema: z.literal("pkm.original-mcp-domain-approval-request/v1"),
  phase: z.enum(["hydrate-and-activate", "activate"]),
});
type DomainRequest = z.infer<typeof originalMcpDomainApprovalRequestSchema>;
export type OriginalMcpDomainApprovalRequest = Omit<DomainRequest, "files" | "sourceDetails"> & {
  files: ReadonlyArray<Readonly<DomainRequest["files"][number]>>;
  sourceDetails: Readonly<DomainRequest["sourceDetails"]>;
};
export interface OriginalMcpDomainPolicy {
  /** Production source decisions require the signed native source producer, not embedding fixtures. */
  authorize(request: Readonly<OriginalMcpDomainApprovalRequest>): Promise<OriginalMcpSourceApproval | null>;
  checkpoint?(point: "intent-durable" | "files-durable"): void;
}

export const originalApiChatSourceLimitsSchema = z.strictObject({
  maxChats: z.number().int().min(1).max(16_384),
  maxMessagesPerChat: z.number().int().min(1).max(1_000_000),
  maxMessages: z.number().int().min(1).max(4_000_000),
});
export const originalApiChatSourcePlanSchema = z.strictObject({
  schema: z.literal("pkm.original-api-chat-source/v1"), root: z.string(), workspaceId: z.string().uuid(),
  custodyPlanSha256: digest, profileSha256: digest, indexPath: z.string(), indexSha256: digest,
  chats: z.number().int().nonnegative(), messages: z.number().int().nonnegative(),
  controls: z.number().int().nonnegative(), limits: originalApiChatSourceLimitsSchema, planSha256: digest,
});
export type OriginalApiChatSourcePlan = z.infer<typeof originalApiChatSourcePlanSchema>;
export const originalApiChatSourceApprovalRequestSchema = originalApiChatSourcePlanSchema.extend({
  phase: z.enum(["admit", "activate"]), nativeHostReceiptSha256: digest,
});
export type OriginalApiChatSourceApprovalRequest = z.infer<typeof originalApiChatSourceApprovalRequestSchema>;
export interface OriginalApiChatSourcePolicy {
  authorize(request: Readonly<OriginalApiChatSourceApprovalRequest>): Promise<OriginalMcpSourceApproval | null>;
}
