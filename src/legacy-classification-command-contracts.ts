import { z } from "zod";
import { legacyClassificationPreview } from "./legacy-asset-provider.js";

export const LEGACY_CLASSIFICATION_COMMAND_ID = "knowledge.classification.original-compatible.command" as const;
export const LEGACY_CLASSIFICATION_COMMAND_CONTRACT = "pkm.legacy-classification.original-compatible/v1" as const;
const digest = z.string().regex(/^[a-f0-9]{64}$/);
const uuid = z.string().uuid();
export const legacyClassificationSourceResult = z.strictObject({
  journalId: uuid, applied: z.array(digest).max(1000),
  skipped: z.array(z.strictObject({ id: digest, reason: z.enum([
    "review-only", "privacy-changed-since-preview", "changed-since-preview",
    "unsafe-or-unavailable", "already-restored-or-not-written", "changed-since-apply",
  ]) })).max(1000),
});
export const legacyClassificationCommandRequest = z.discriminatedUnion("action", [
  z.strictObject({ contract: z.literal(LEGACY_CLASSIFICATION_COMMAND_CONTRACT), action: z.literal("preview") }),
  z.strictObject({ contract: z.literal(LEGACY_CLASSIFICATION_COMMAND_CONTRACT), action: z.literal("apply"),
    operationId: uuid, previewId: digest, layoutSha256: digest, proposalIds: z.array(digest).min(1).max(1000) }),
  z.strictObject({ contract: z.literal(LEGACY_CLASSIFICATION_COMMAND_CONTRACT), action: z.literal("rollback"),
    operationId: uuid, journalId: uuid, layoutSha256: digest }),
]);
export const legacyClassificationCommandResult = z.discriminatedUnion("action", [
  z.strictObject({ action: z.literal("preview"), sourceResult: legacyClassificationPreview }),
  z.strictObject({ action: z.literal("apply"), operationId: uuid, sourceResult: legacyClassificationSourceResult }),
  z.strictObject({ action: z.literal("rollback"), operationId: uuid, sourceResult: legacyClassificationSourceResult }),
]);
export const legacyClassificationCommandDefinitions = [{
  id: LEGACY_CLASSIFICATION_COMMAND_ID, readOnly: false,
  description: "Source-qualified original classification results in an explicitly owned disposable Unix fixture; native authority, CAS and durable recovery remain mandatory.",
  input: legacyClassificationCommandRequest, output: legacyClassificationCommandResult,
}] as const;
